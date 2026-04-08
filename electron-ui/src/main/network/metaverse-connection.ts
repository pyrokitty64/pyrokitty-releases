/**
 * MetaverseConnection - node-metaverse Bot wrapper
 *
 * Manages connection to Second Life via node-metaverse before handoff to the viewer.
 * Handles chat, friends, and groups during the metaverse-connected state.
 */

import { EventEmitter } from 'events';
import { Bot, BotOptionFlags, LoginParameters, UUID } from '../../../node-metaverse/dist/lib';
import { SceneManager } from './scene-manager';
import { LoginError } from '../../../node-metaverse/dist/lib/classes/LoginError';
import { ChatType } from '../../../node-metaverse/dist/lib/enums/ChatType';
import { ChatSourceType } from '../../../node-metaverse/dist/lib/enums/ChatSourceType';
import { InstantMessageEventFlags } from '../../../node-metaverse/dist/lib/enums/InstantMessageEventFlags';
import { RightsFlags } from '../../../node-metaverse/dist/lib/enums/RightsFlags';
import { Message } from '../../../node-metaverse/dist/lib/enums/Message';
import { TextureEntry } from '../../../node-metaverse/dist/lib/classes/TextureEntry';
import type { AvatarAppearanceMessage } from '../../../node-metaverse/dist/lib/classes/messages/AvatarAppearance';
import { BAKE_CHANNEL_TO_TE_FACE } from '../bridge/godot-bridge-types';
import { SoundFlags } from '../../../node-metaverse/dist/lib/enums/SoundFlags';
import type { SoundTriggerMessage } from '../../../node-metaverse/dist/lib/classes/messages/SoundTrigger';
import type { AttachedSoundMessage } from '../../../node-metaverse/dist/lib/classes/messages/AttachedSound';
import type { AttachedSoundGainChangeMessage } from '../../../node-metaverse/dist/lib/classes/messages/AttachedSoundGainChange';
import type { PreloadSoundMessage } from '../../../node-metaverse/dist/lib/classes/messages/PreloadSound';
/** Fields we actually read from animation circuit messages (may be missing on truncated packets). */
type AnimationPacket = { Sender?: { ID?: { toString(): string } }; AnimationList?: { AnimID: { toString(): string }; AnimSequenceID: number }[] };
import { SoundFetchQueue } from '../assets/sound-fetch-queue';
import * as SoundPlayer from '../assets/sound-player';
import {
  ConnectionState,
  ChatMessage,
  ChatSession,
  Friend,
  Group,
  NearbyAvatar,
  RegionInfo,
} from '../../shared/types';
import { DisplayNameCache } from '../avatar/display-name-cache';
import { pkDebug } from '../pk-debug';

export interface LoginParams {
  firstName: string;
  lastName: string;
  password: string;
  gridLoginUri: string;
  startLocation?: string;
  mfaHash?: string;
  token?: string;
}

export interface HandoffData {
  agent_id: string;
  session_id: string;
  secure_session_id: string;
  circuit_code: number;
  sim_ip: string;
  sim_port: number;
  seed_capability: string;
  region_handle: string;
  first_name: string;
  last_name: string;
  inventory_root?: string;
  inventory_lib_root?: string;
  inventory_lib_owner?: string;
  inventory_skeleton?: Array<{
    folder_id: string;
    parent_id: string;
    name: string;
    type_default: number;
    version: number;
  }>;
  inventory_skel_lib?: Array<{
    folder_id: string;
    parent_id: string;
    name: string;
    type_default: number;
    version: number;
  }>;
  agent_appearance_service?: string;
  account_type?: string;
  account_level_benefits?: Record<string, unknown>;
  premium_packages?: Record<string, { benefits: Record<string, unknown> }>;
  // Session continuation fields - viewer reuses bot's UDP port
  session_continuation?: boolean;
  sequence_number?: number;
  local_port?: number;
}

export interface MetaverseConnectionEvents {
  'state-change': (state: ConnectionState) => void;
  'nearby-chat': (message: ChatMessage) => void;
  'im': (message: ChatMessage) => void;
  'group-chat': (message: ChatMessage) => void;
  'friends-update': (friends: Friend[]) => void;
  'friend-online': (friend: Friend, online: boolean) => void;
  'groups-update': (groups: Group[]) => void;
  'nearby-avatars-update': (avatars: NearbyAvatar[]) => void;
  'region-info-update': (info: RegionInfo) => void;
  'error': (error: Error) => void;
  'login-progress': (message: string) => void;
  'mfa-required': () => void;
}

export class MetaverseConnection extends EventEmitter {
  private bot: Bot | null = null;
  private _sceneManager: SceneManager | null = null;
  private state: ConnectionState = 'disconnected';
  private friends: Map<string, Friend> = new Map();
  private groups: Map<string, Group> = new Map();
  private chatSessions: Map<string, ChatSession> = new Map();
  private nearbyAvatars: Map<string, NearbyAvatar> = new Map();
  private avatarLeftSubscriptions: Map<string, { unsubscribe: () => void }> = new Map();
  private loginResponse: Record<string, unknown> | null = null;
  private messageIdCounter = 0;
  private displayNameCache: DisplayNameCache | null = null;
  private accountId: string | null = null;
  private lastLoginParams: LoginParams | null = null;
  private lastMfaHash?: string;
  private cachedRegionInfo: RegionInfo | null = null;
  private selfMoveSubscription: { unsubscribe: () => void } | null = null;
  private regionInfoThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private regionInfoDirty = false;
  private soundFetchQueue: SoundFetchQueue | null = null;
  private soundSubscription: { unsubscribe: () => void } | null = null;
  private soundUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private pendingSounds = new Map<string, { type: 'trigger' | 'attached'; gain: number; position?: any; localId?: number; loop?: boolean }[]>();
  private attachedSoundGains = new Map<number, number>(); // localId → base gain (before distance)
  private triggerSounds = new Map<number, { baseGain: number; position: { x: number; y: number; z: number } }>(); // triggerId → position + gain
  private nextTriggerId = -1; // negative IDs to avoid collision with object localIds
  private soundDistLogCounter = 0;

  // Buffer ObjectAnimation messages from login time so GodotBridge (started later) can replay them
  private objectAnimationBuffer = new Map<string, { animId: string; sequenceId: number }[]>(); // senderUUID → anim list
  private objectAnimationSub: { unsubscribe: () => void } | null = null;

  // Buffer AvatarAnimation messages so GodotBridge restarts (e.g. VR switch) can replay them.
  // SL only sends AvatarAnimation when the anim list changes, so a stationary avatar won't
  // re-send during the brief window between bridge restarts.
  private avatarAnimationBuffer = new Map<string, { animId: string; sequenceId: number }[]>(); // avatarUUID → anim list
  private avatarAnimationSub: { unsubscribe: () => void } | null = null;

  // Buffer AvatarAppearance bake textures from login time (arrive before GodotBridge subscribes)
  private avatarAppearanceBuffer = new Map<string, string[]>(); // avatarUUID → 11 bake texture UUIDs
  private avatarVisualParamBuffer = new Map<string, number[]>(); // avatarUUID → VisualParam bytes
  private avatarHoverBuffer = new Map<string, number>(); // avatarUUID → hover height Z (from AppearanceHover block)
  private avatarAppearanceSub: { unsubscribe: () => void } | null = null;
  private static readonly MAX_SOUND_DISTANCE = 50;

  constructor(public readonly instanceId: string) {
    super();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('state-change', newState);
    }
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${++this.messageIdCounter}`;
  }

  /**
   * Login to Second Life via node-metaverse
   */
  async login(params: LoginParams): Promise<void> {
    if (this.state !== 'disconnected' && this.state !== 'mfa_pending') {
      throw new Error(`Cannot login: connection is ${this.state}`);
    }

    const isMfaRetry = this.state === 'mfa_pending' && this.bot !== null;
    this.lastLoginParams = params;
    this.setState('logging_in');
    this.emit('login-progress', isMfaRetry ? 'Verifying MFA token...' : 'Initializing...');

    try {
      if (!isMfaRetry) {
        // Fresh login — create Bot
        const loginParams = new LoginParameters();
        loginParams.firstName = params.firstName;
        loginParams.lastName = params.lastName;
        loginParams.password = params.password;
        loginParams.url = params.gridLoginUri;
        loginParams.start = params.startLocation || 'last';
        if (params.mfaHash) loginParams.mfa_hash = params.mfaHash;
        if (params.token) loginParams.token = params.token;

        this.bot = new Bot(loginParams, BotOptionFlags.None);

        // teleportHandoffMode stays false — node-metaverse handles all teleports.
        // Godot is just a renderer and Firestorm takes over the session entirely.

        // Create display name cache keyed by account
        this.accountId = `${params.firstName}.${params.lastName}`.toLowerCase();
        this.displayNameCache = new DisplayNameCache(this.accountId);
      } else {
        // MFA retry — just set token on existing bot
        if (params.token) {
          this.bot!.loginParameters.token = params.token;
        }
      }

      this.emit('login-progress', 'Logging in...');
      this.loginResponse = await this.bot!.login() as unknown as Record<string, unknown>;

      // Extract mfaHash from login response for persistence
      const loginResp = this.loginResponse as Record<string, unknown>;
      if (loginResp.mfaHash) {
        this.lastMfaHash = String(loginResp.mfaHash);
      }

      // Set up event subscriptions BEFORE connecting so we catch early events
      this.setupEventSubscriptions();

      // Populate friends list from login response BEFORE connecting
      // so friend online events have friends to update
      this.populateFriendsFromLogin();

      this.emit('login-progress', 'Connecting to simulator...');
      // Set draw distance so the server sends EnableSimulator for neighboring regions
      this.bot!.agent.cameraFar = 128;
      await this.bot!.connectToSim();

      // Groups will be populated from AgentGroupDataUpdate event
      // For now, initialize empty - groups arrive via event queue

      this.setState('metaverse_connected');
      this.emit('login-progress', `Connected to ${this.bot!.currentRegion?.regionName || 'region'}`);

      // Create SceneManager — subscribes to ClientEvents for all regions
      this._sceneManager = new SceneManager(this.bot!);

      // Subscribe to world sound messages (circuit is available after connectToSim)
      this.setupSoundSubscriptions();

      // Buffer ObjectAnimation + AvatarAnimation + AvatarAppearance messages from login time for later GodotBridge replay
      this.setupObjectAnimationBuffer();
      this.setupAvatarAnimationBuffer();
      this.setupAvatarAppearanceBuffer();

      // Resolve display names for all friends in background
      this.resolveDisplayNamesForFriends().catch((err) => {
        console.error('[MetaverseConnection] Error resolving friend display names:', err);
      });

    } catch (error) {
      if (error instanceof LoginError && error.reason === 'mfa_challenge') {
        // MFA required — keep bot alive for token retry
        console.log('[MetaverseConnection] MFA challenge received, waiting for token');
        this.setState('mfa_pending');
        this.emit('mfa-required');
        return;
      }
      this.setState('disconnected');
      if (this._sceneManager) { this._sceneManager.shutdown(); this._sceneManager = null; }
      this.bot = null;
      throw error;
    }
  }

  /**
   * Submit an MFA token after an mfa_challenge. Retries login with the token.
   */
  async submitMfaToken(token: string): Promise<void> {
    if (this.state !== 'mfa_pending' || !this.lastLoginParams) {
      throw new Error(`Cannot submit MFA token: connection is ${this.state}`);
    }
    await this.login({ ...this.lastLoginParams, token });
  }

  /**
   * Get the MFA hash returned by the server after successful MFA login.
   * Used to persist for future logins so the user isn't prompted again.
   */
  getLastMfaHash(): string | undefined {
    return this.lastMfaHash;
  }

  /**
   * Disconnect from Second Life
   */
  async logout(): Promise<void> {
    if (this.displayNameCache) {
      this.displayNameCache.flush();
    }
    if (this.bot) {
      try {
        await this.bot.close();
      } catch {
        // Ignore close errors
      }
      if (this._sceneManager) { this._sceneManager.shutdown(); this._sceneManager = null; }
      this.bot = null;
    }
    this.friends.clear();
    this.groups.clear();
    this.chatSessions.clear();
    this.nearbyAvatars.clear();
    // Clean up sound subscriptions and stop all playing sounds
    this.soundSubscription?.unsubscribe();
    this.soundSubscription = null;
    if (this.soundUpdateTimer) { clearInterval(this.soundUpdateTimer); this.soundUpdateTimer = null; }
    if (this.soundFetchQueue) { this.soundFetchQueue.destroy(); this.soundFetchQueue = null; }
    this.pendingSounds.clear();
    for (const localId of this.attachedSoundGains.keys()) SoundPlayer.stopAttached(localId);
    for (const triggerId of this.triggerSounds.keys()) SoundPlayer.stopAttached(triggerId);
    this.attachedSoundGains.clear();
    this.triggerSounds.clear();
    // Clean up ObjectAnimation + AvatarAnimation + AvatarAppearance buffers
    this.objectAnimationSub?.unsubscribe();
    this.objectAnimationSub = null;
    this.objectAnimationBuffer.clear();
    this.avatarAnimationSub?.unsubscribe();
    this.avatarAnimationSub = null;
    this.avatarAnimationBuffer.clear();
    this.avatarAppearanceSub?.unsubscribe();
    this.avatarAppearanceSub = null;
    this.avatarAppearanceBuffer.clear();
    this.avatarVisualParamBuffer.clear();
    this.avatarHoverBuffer.clear();
    // Clean up avatar subscriptions
    this.selfMoveSubscription?.unsubscribe();
    this.selfMoveSubscription = null;
    if (this.regionInfoThrottleTimer) {
      clearTimeout(this.regionInfoThrottleTimer);
      this.regionInfoThrottleTimer = null;
    }
    for (const sub of this.avatarLeftSubscriptions.values()) {
      sub.unsubscribe();
    }
    this.avatarLeftSubscriptions.clear();
    this.setState('disconnected');
  }

  /**
   * Set up event subscriptions for chat, friends, and groups
   */
  private setupEventSubscriptions(): void {
    if (!this.bot) return;

    // Nearby chat
    this.bot.clientEvents.onNearbyChat.subscribe((event) => {
      // Skip typing indicators and other non-message chat types
      if (event.chatType === ChatType.StartTyping || event.chatType === ChatType.StopTyping) {
        return;
      }

      // Server sends out-of-range chat with empty message body — skip it
      if (!event.message) {
        return;
      }

      const chatTypeMap: Record<number, 'whisper' | 'normal' | 'shout'> = {
        0: 'whisper',
        1: 'normal',
        2: 'shout',
      };

      const sourceTypeMap: Record<number, 'agent' | 'object' | 'system'> = {
        [ChatSourceType.Agent]: 'agent',
        [ChatSourceType.Object]: 'object',
        [ChatSourceType.System]: 'system',
      };

      pkDebug('chat', `[NearbyChat] type=${event.chatType} src=${event.sourceType} from="${event.fromName}" msg="${event.message?.substring(0, 80)}"`);

      // Skip our own messages - we already emit them locally in sendNearbyChat()
      // This avoids duplicates while still allowing server confirmation
      const fromId = event.from.toString();
      if (fromId === this.bot?.agentID().toString()) {
        // TODO: Could emit a 'message-confirmed' event here for UI feedback
        return;
      }

      // Use cached display name if available
      const displayName = this.displayNameCache?.getBestName(fromId);

      const message: ChatMessage = {
        id: this.generateMessageId(),
        type: 'nearby',
        message: event.message,
        fromName: displayName || event.fromName,
        fromId,
        timestamp: Date.now(),
        chatType: chatTypeMap[event.chatType] || 'normal',
        sourceType: sourceTypeMap[event.sourceType] || 'agent',
      };

      this.emit('nearby-chat', message);
    });

    // Instant messages
    this.bot.clientEvents.onInstantMessage.subscribe((event) => {
      // Skip typing indicators
      if (event.flags & InstantMessageEventFlags.startTyping ||
        event.flags & InstantMessageEventFlags.finishTyping) {
        return;
      }

      const fromId = event.from.toString();
      const sessionId = fromId; // IM sessions use participant ID as session ID
      const displayName = this.displayNameCache?.getBestName(fromId);
      const nameToUse = displayName || event.fromName;

      // Create or update chat session
      if (!this.chatSessions.has(sessionId)) {
        const session: ChatSession = {
          id: sessionId,
          type: 'im',
          name: nameToUse,
          participantId: fromId,
          unreadCount: 1,
          lastMessage: event.message,
          lastMessageTime: Date.now(),
        };
        this.chatSessions.set(sessionId, session);
        this.emit('chat-session-update', session);
      } else {
        const session = this.chatSessions.get(sessionId)!;
        session.unreadCount++;
        session.lastMessage = event.message;
        session.lastMessageTime = Date.now();
        // Update session name if we now have a display name
        if (displayName) {
          session.name = displayName;
        }
        this.emit('chat-session-update', session);
      }

      const message: ChatMessage = {
        id: this.generateMessageId(),
        type: 'im',
        message: event.message,
        fromName: nameToUse,
        fromId: fromId,
        timestamp: Date.now(),
        sessionId: sessionId,
        isOutgoing: false,
      };

      this.emit('im', message);
    });

    // Group chat
    this.bot.clientEvents.onGroupChat.subscribe((event) => {
      const groupId = event.groupID.toString();
      const group = this.groups.get(groupId);

      // Create or update chat session
      if (!this.chatSessions.has(groupId)) {
        const session: ChatSession = {
          id: groupId,
          type: 'group',
          name: group?.name || 'Group',
          groupId: groupId,
          unreadCount: 1,
          lastMessage: event.message,
          lastMessageTime: Date.now(),
        };
        this.chatSessions.set(groupId, session);
        this.emit('chat-session-update', session);
      } else {
        const session = this.chatSessions.get(groupId)!;
        session.unreadCount++;
        session.lastMessage = event.message;
        session.lastMessageTime = Date.now();
        this.emit('chat-session-update', session);
      }

      const groupFromId = event.from.toString();
      const groupDisplayName = this.displayNameCache?.getBestName(groupFromId);

      const message: ChatMessage = {
        id: this.generateMessageId(),
        type: 'group',
        message: event.message,
        fromName: groupDisplayName || event.fromName,
        fromId: groupFromId,
        timestamp: Date.now(),
        sessionId: groupId,
        isOutgoing: groupFromId === this.bot?.agentID().toString(),
      };

      this.emit('group-chat', message);
    });

    // Friend online status
    this.bot.clientEvents.onFriendOnline.subscribe((event) => {
      const friendId = event.friend.getKey().toString();
      pkDebug('friends', `[MetaverseConnection] onFriendOnline: ${friendId} online=${event.online}`);
      pkDebug('friends', `[MetaverseConnection] Friends map has ${this.friends.size} entries`);
      const friend = this.friends.get(friendId);
      if (friend) {
        pkDebug('friends', `[MetaverseConnection] Found friend ${friend.name}, setting online=${event.online}`);
        friend.online = event.online;
        this.emit('friend-online', friend, event.online);
        this.emit('friends-update', Array.from(this.friends.values()));
      } else {
        pkDebug('friends', `[MetaverseConnection] Friend ${friendId} not found in map`);
      }
    });

    // Friend rights changes
    this.bot.clientEvents.onFriendRights.subscribe((event) => {
      const friendId = event.friend.getKey().toString();
      const friend = this.friends.get(friendId);
      if (friend) {
        friend.canSeeOnline = (event.theirRights & RightsFlags.CanSeeOnline) !== 0;
        friend.canSeeOnMap = (event.theirRights & RightsFlags.CanSeeOnMap) !== 0;
        friend.canModifyObjects = (event.theirRights & RightsFlags.CanModifyObjects) !== 0;
        this.emit('friends-update', Array.from(this.friends.values()));
      }
    });

    // Friend removed
    this.bot.clientEvents.onFriendRemoved.subscribe((event) => {
      const friendId = event.friend.getKey().toString();
      this.friends.delete(friendId);
      this.emit('friends-update', Array.from(this.friends.values()));
    });

    // Group data update (received from event queue after login)
    this.bot.clientEvents.onAgentGroupDataUpdate.subscribe((event) => {
      console.log(`[MetaverseConnection] onAgentGroupDataUpdate received with ${event.groups.length} groups`);
      // Clear and rebuild groups map from event data
      this.groups.clear();
      for (const groupData of event.groups) {
        const group: Group = {
          id: groupData.groupID.toString(),
          name: groupData.groupName,
          insigniaId: groupData.groupInsigniaID.toString(),
          contribution: groupData.contribution,
          powers: groupData.groupPowers,
        };
        this.groups.set(group.id, group);
        pkDebug('groups', `[MetaverseConnection] Added group: ${group.name} (${group.id})`);
      }
      console.log(`[MetaverseConnection] Emitting groups-update with ${this.groups.size} groups`);
      this.emit('groups-update', Array.from(this.groups.values()));
    });

    // Disconnect/kicked handling (e.g. another client logged in with same account)
    this.bot.clientEvents.onDisconnected.subscribe((event) => {
      console.log(`[MetaverseConnection] Bot disconnected: ${event.message} (requested=${event.requested})`);
      // Clean up subscriptions so timers/callbacks don't access dead bot
      this.soundSubscription?.unsubscribe();
      this.soundSubscription = null;
      if (this.soundFetchQueue) { this.soundFetchQueue.destroy(); this.soundFetchQueue = null; }
      this.pendingSounds.clear();
      if (this.soundUpdateTimer) { clearInterval(this.soundUpdateTimer); this.soundUpdateTimer = null; }
      for (const localId of this.attachedSoundGains.keys()) SoundPlayer.stopAttached(localId);
      for (const triggerId of this.triggerSounds.keys()) SoundPlayer.stopAttached(triggerId);
      this.attachedSoundGains.clear();
      this.triggerSounds.clear();
      this.objectAnimationSub?.unsubscribe();
      this.objectAnimationSub = null;
      this.objectAnimationBuffer.clear();
      this.avatarAnimationSub?.unsubscribe();
      this.avatarAnimationSub = null;
      this.avatarAnimationBuffer.clear();
      this.avatarAppearanceSub?.unsubscribe();
      this.avatarAppearanceSub = null;
      this.avatarAppearanceBuffer.clear();
      this.avatarVisualParamBuffer.clear();
    this.avatarHoverBuffer.clear();
      this.selfMoveSubscription?.unsubscribe();
      this.selfMoveSubscription = null;
      if (this.regionInfoThrottleTimer) {
        clearTimeout(this.regionInfoThrottleTimer);
        this.regionInfoThrottleTimer = null;
      }
      for (const sub of this.avatarLeftSubscriptions.values()) {
        sub.unsubscribe();
      }
      this.avatarLeftSubscriptions.clear();
      this.nearbyAvatars.clear();
      if (this._sceneManager) { this._sceneManager.shutdown(); this._sceneManager = null; }
      this.bot = null;
      this.setState('disconnected');
    });

    // Avatar entered region
    this.bot.clientEvents.onAvatarEnteredRegion.subscribe((avatar) => {
      const avatarId = avatar.getKey().toString();
      // Subscribe to our own avatar's movement for region-info-update
      if (avatarId === this.bot?.agentID().toString()) {
        this.selfMoveSubscription?.unsubscribe();
        this.selfMoveSubscription = avatar.onMoved.subscribe(() => {
          this.emitRegionInfoThrottled();
        });
        // Emit initial position
        this.emitRegionInfoThrottled();
        return;
      }

      const pos = avatar.position;
      // Use cached display name if available, fall back to legacy name
      const cachedName = this.displayNameCache?.getBestName(avatarId);
      const nearbyAvatar: NearbyAvatar = {
        id: avatarId,
        name: cachedName || avatar.getName(),
        title: avatar.getTitle() || undefined,
        position: { x: pos.x, y: pos.y, z: pos.z },
      };
      this.nearbyAvatars.set(avatarId, nearbyAvatar);

      // Resolve display name in background if not cached
      if (!cachedName || this.displayNameCache?.isStale(avatarId)) {
        this.resolveDisplayNames([avatarId]).then(() => {
          const updated = this.nearbyAvatars.get(avatarId);
          const newName = this.displayNameCache?.getBestName(avatarId);
          if (updated && newName && updated.name !== newName) {
            updated.name = newName;
            this.emit('nearby-avatars-update', Array.from(this.nearbyAvatars.values()));
          }
        }).catch(() => {});
      }

      // Subscribe to avatar movement to update position
      const moveSubscription = avatar.onMoved.subscribe(() => {
        const existing = this.nearbyAvatars.get(avatarId);
        if (existing) {
          const newPos = avatar.position;
          existing.position = { x: newPos.x, y: newPos.y, z: newPos.z };
          this.emit('nearby-avatars-update', Array.from(this.nearbyAvatars.values()));
        }
      });

      // Subscribe to avatar leaving
      const leftSubscription = avatar.onLeftRegion.subscribe(() => {
        this.nearbyAvatars.delete(avatarId);
        const sub = this.avatarLeftSubscriptions.get(avatarId);
        if (sub) {
          sub.unsubscribe();
          this.avatarLeftSubscriptions.delete(avatarId);
        }
        this.emit('nearby-avatars-update', Array.from(this.nearbyAvatars.values()));
      });

      // Store both subscriptions
      this.avatarLeftSubscriptions.set(avatarId, {
        unsubscribe: () => {
          moveSubscription.unsubscribe();
          leftSubscription.unsubscribe();
        }
      });

      this.emit('nearby-avatars-update', Array.from(this.nearbyAvatars.values()));
    });
  }

  // ─── World Sound Handling ────────────────────────────

  private setupSoundSubscriptions(): void {
    if (!this.bot) return;

    // Init sound fetch queue
    this.soundFetchQueue = new SoundFetchQueue(this.bot, (soundUuid, cachePath) => {
      this.flushPendingSounds(soundUuid, cachePath);
    });

    // Init sound player (singleton, no-ops if already init)
    SoundPlayer.initSoundPlayer().catch(err => {
      console.error('[MetaverseConnection] Failed to init sound player:', err);
    });
    SoundPlayer.setOnSoundEnded((id) => this.triggerSounds.delete(id));

    try {
      const circuit = this.bot.currentRegion?.circuit;
      if (!circuit) return;

      const sub = circuit.subscribeToMessages([
        Message.SoundTrigger,
        Message.AttachedSound,
        Message.AttachedSoundGainChange,
        Message.PreloadSound,
      ], (packet: any) => {
        switch (packet.message.id) {
          case Message.SoundTrigger:
            this.handleSoundTrigger(packet.message as SoundTriggerMessage);
            break;
          case Message.AttachedSound:
            this.handleAttachedSound(packet.message as AttachedSoundMessage);
            break;
          case Message.AttachedSoundGainChange:
            this.handleAttachedSoundGainChange(packet.message as AttachedSoundGainChangeMessage);
            break;
          case Message.PreloadSound:
            this.handlePreloadSound(packet.message as PreloadSoundMessage);
            break;
        }
      });
      this.soundSubscription = sub;
      console.log('[MetaverseConnection] Subscribed to world sound messages');
    } catch {
      console.warn('[MetaverseConnection] Could not subscribe to sound messages (circuit not ready)');
    }

    // Periodically update attached sound volumes based on distance
    this.soundUpdateTimer = setInterval(() => this.updateSoundDistances(), 250);
  }

  /**
   * Subscribe to ObjectAnimation circuit messages and buffer them.
   * Called right after connectToSim() so we capture animation state for animesh
   * objects that arrive during initial object load — before GodotBridge exists.
   */
  private setupObjectAnimationBuffer(): void {
    try {
      const circuit = this.bot?.currentRegion?.circuit;
      if (!circuit) return;

      this.objectAnimationSub = circuit.subscribeToMessages([
        Message.ObjectAnimation,
      ], (packet) => {
        const msg = packet.message as unknown as AnimationPacket;
        const senderUuid = msg.Sender?.ID?.toString();
        if (!senderUuid || !msg.AnimationList) return;
        const animations = msg.AnimationList.map(a => ({
          animId: a.AnimID.toString(),
          sequenceId: a.AnimSequenceID,
        }));
        this.objectAnimationBuffer.set(senderUuid, animations);
      });
      console.log('[MetaverseConnection] Subscribed to ObjectAnimation (buffering for GodotBridge)');
    } catch {
      console.warn('[MetaverseConnection] Could not subscribe to ObjectAnimation (circuit not ready)');
    }
  }

  /** Returns the buffered ObjectAnimation state for all animesh objects seen since login. */
  getObjectAnimationBuffer(): Map<string, { animId: string; sequenceId: number }[]> {
    return this.objectAnimationBuffer;
  }

  /**
   * Subscribe to AvatarAnimation circuit messages and buffer them.
   * SL only sends AvatarAnimation when the animation list changes, so a
   * stationary avatar won't re-send during a GodotBridge restart (e.g. VR switch).
   * Buffering here ensures the new bridge can seed the animation state.
   */
  private setupAvatarAnimationBuffer(): void {
    try {
      const circuit = this.bot?.currentRegion?.circuit;
      if (!circuit) return;

      this.avatarAnimationSub = circuit.subscribeToMessages([
        Message.AvatarAnimation,
      ], (packet) => {
        const msg = packet.message as unknown as AnimationPacket;
        const avatarId = msg.Sender?.ID?.toString();
        if (!avatarId || !msg.AnimationList) return;
        const animations = msg.AnimationList.map(a => ({
          animId: a.AnimID.toString(),
          sequenceId: a.AnimSequenceID,
        }));
        this.avatarAnimationBuffer.set(avatarId, animations);
      });
      console.log('[MetaverseConnection] Subscribed to AvatarAnimation (buffering for GodotBridge)');
    } catch {
      console.warn('[MetaverseConnection] Could not subscribe to AvatarAnimation (circuit not ready)');
    }
  }

  /** Returns the buffered AvatarAnimation state for all avatars seen since login. */
  getAvatarAnimationBuffer(): Map<string, { animId: string; sequenceId: number }[]> {
    return this.avatarAnimationBuffer;
  }

  /**
   * Subscribe to AvatarAppearance circuit messages and buffer bake textures.
   * Called right after connectToSim() so we capture bake data that arrives
   * during initial load — before GodotBridge/AvatarManager exists.
   */
  private setupAvatarAppearanceBuffer(): void {
    try {
      const circuit = this.bot?.currentRegion?.circuit;
      if (!circuit) return;

      this.avatarAppearanceSub = circuit.subscribeToMessages([
        Message.AvatarAppearance,
      ], (packet: any) => {
        try {
          const msg = packet.message as AvatarAppearanceMessage;
          const avatarId = msg.Sender.ID.toString();
          const teBuf = msg.ObjectData.TextureEntry;
          const te = TextureEntry.from(teBuf);
          const bakes: string[] = [];
          for (let ch = 0; ch < 11; ch++) {
            const teFace = BAKE_CHANNEL_TO_TE_FACE[ch];
            const face = te.faces[teFace] ?? te.defaultTexture;
            bakes.push(face?.textureID?.toString() || '');
          }
          this.avatarAppearanceBuffer.set(avatarId, bakes);

          // Buffer VisualParam bytes for shape processing (GodotAvatarManager subscribes later)
          if (msg.VisualParam && msg.VisualParam.length > 0) {
            this.avatarVisualParamBuffer.set(avatarId, msg.VisualParam.map((vp: { ParamValue: number }) => vp.ParamValue));
          }

          // Buffer hover height from AppearanceHover block (currently unused — hover
          // is extracted from VisualParam byte 252 instead, but kept for future cross-check)
          if (msg.AppearanceHover && msg.AppearanceHover.length > 0) {
            this.avatarHoverBuffer.set(avatarId, msg.AppearanceHover[0].HoverHeight?.z || 0);
          }

          // Diagnostic: log parsed bake info
          const uniqueBakes = new Set(bakes.filter(b => b && b !== '00000000-0000-0000-0000-000000000000'));
          const filled = bakes.map((uuid, i) => (uuid && uuid !== '00000000-0000-0000-0000-000000000000') ? `${['HEAD','UPPER','LOWER','EYES','SKIRT','HAIR','LARM','LLEG','AUX1','AUX2','AUX3'][i]}=${uuid.slice(0, 8)}` : null).filter(Boolean);
          pkDebug('avatar', `[BoM-Buffer] AvatarAppearance ${avatarId.slice(0, 8)}: ${uniqueBakes.size} unique bakes — ${filled.join(', ')}`);
        } catch (err) {
          console.warn('[BoM-Buffer] Parse error:', (err as Error).message);
        }
      });
      console.log('[MetaverseConnection] Subscribed to AvatarAppearance (buffering bakes for GodotBridge)');
    } catch {
      console.warn('[MetaverseConnection] Could not subscribe to AvatarAppearance (circuit not ready)');
    }
  }

  /** Returns buffered AvatarAppearance bake textures. avatarUUID → 11 bake UUIDs. */
  getAvatarAppearanceBuffer(): Map<string, string[]> {
    return this.avatarAppearanceBuffer;
  }

  /** Returns buffered VisualParam bytes. avatarUUID → byte array. */
  getVisualParamBuffer(): Map<string, number[]> {
    return this.avatarVisualParamBuffer;
  }

  /** Returns buffered hover heights from AppearanceHover block. avatarUUID → hover Z meters. */
  getHoverBuffer(): Map<string, number> {
    return this.avatarHoverBuffer;
  }

  private getAvatarPosition(): { x: number; y: number; z: number } | null {
    const agentId = this.bot?.agentID?.()?.toString();
    if (!agentId) return null;
    const self = this.bot?.currentRegion?.agents?.get(agentId);
    if (self?.position && (self.position.x !== 0 || self.position.y !== 0)) {
      return self.position;
    }
    return null;
  }

  /** Get world position for an object, resolving child prim local offsets */
  private getObjectWorldPosition(obj: any): { x: number; y: number; z: number } | null {
    const pos = obj?.Position;
    if (!pos) return null;
    if (!obj.ParentID || obj.ParentID === 0) return pos;
    try {
      const parent = this.bot?.currentRegion?.objects?.getObjectByLocalID(obj.ParentID);
      const pp = parent?.Position;
      if (pp) return { x: pp.x + pos.x, y: pp.y + pos.y, z: pp.z + pos.z };
    } catch { /* fall through */ }
    return pos;
  }

  private updateSoundDistances(): void {
    if (this.attachedSoundGains.size === 0 && this.triggerSounds.size === 0) return;
    const avatarPos = this.getAvatarPosition();
    if (!avatarPos) return;

    const maxDist = MetaverseConnection.MAX_SOUND_DISTANCE;
    const doLog = (this.soundDistLogCounter++ % 16) === 0; // log every ~4s

    // Attached sounds — position comes from the object
    for (const [localId, baseGain] of this.attachedSoundGains) {
      try {
        const obj = this.bot?.currentRegion?.objects?.getObjectByLocalID(localId);
        if (!obj) {
          SoundPlayer.stopAttached(localId);
          this.attachedSoundGains.delete(localId);
          continue;
        }
        const op = this.getObjectWorldPosition(obj);
        if (!op) continue;
        const dx = op.x - avatarPos.x, dy = op.y - avatarPos.y, dz = op.z - avatarPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const effectiveGain = dist > maxDist ? 0 : baseGain / Math.max(1, dist);
        SoundPlayer.setAttachedGain(localId, effectiveGain);
        if (doLog) {
          pkDebug('sound', `[Sound] Dist localId=${localId} dist=${dist.toFixed(1)}m base=${baseGain.toFixed(2)} eff=${effectiveGain.toFixed(3)} av=(${avatarPos.x.toFixed(0)},${avatarPos.y.toFixed(0)},${avatarPos.z.toFixed(0)}) obj=(${op.x.toFixed(0)},${op.y.toFixed(0)},${op.z.toFixed(0)})`);
        }
      } catch {
        SoundPlayer.stopAttached(localId);
        this.attachedSoundGains.delete(localId);
      }
    }

    // Trigger sounds — fixed position in world
    for (const [triggerId, info] of this.triggerSounds) {
      const dx = info.position.x - avatarPos.x, dy = info.position.y - avatarPos.y, dz = info.position.z - avatarPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const effectiveGain = dist > maxDist ? 0 : info.baseGain / Math.max(1, dist);
      SoundPlayer.setAttachedGain(triggerId, effectiveGain);
    }
  }

  private handleSoundTrigger(msg: SoundTriggerMessage): void {
    const soundId = msg.SoundData.SoundID.toString();
    if (!soundId || soundId === '00000000-0000-0000-0000-000000000000') return;

    const pos = msg.SoundData.Position;
    const gain = msg.SoundData.Gain;

    const avatarPos = this.getAvatarPosition();
    if (avatarPos) {
      const dx = pos.x - avatarPos.x, dy = pos.y - avatarPos.y, dz = pos.z - avatarPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > MetaverseConnection.MAX_SOUND_DISTANCE ** 2) return;
      pkDebug('sound', `[Sound] Trigger ${soundId.slice(0, 8)} gain=${gain.toFixed(2)} dist=${Math.sqrt(distSq).toFixed(1)}m`);
    }

    if (!this.pendingSounds.has(soundId)) this.pendingSounds.set(soundId, []);
    this.pendingSounds.get(soundId)!.push({ type: 'trigger', gain, position: pos });
    this.soundFetchQueue?.request(soundId);
  }

  private handleAttachedSound(msg: AttachedSoundMessage): void {
    const soundId = msg.DataBlock.SoundID.toString();
    const objectUuid = msg.DataBlock.ObjectID.toString();
    const gain = msg.DataBlock.Gain;
    const flags = msg.DataBlock.Flags;

    let localId: number | undefined;
    let obj: any;
    try {
      obj = this.bot?.currentRegion?.objects?.getObjectByUUID(new UUID(objectUuid));
      if (obj) localId = obj.ID;
    } catch { /* not found */ }
    if (localId === undefined) return;

    if (flags & SoundFlags.Stop) {
      pkDebug('sound', `[Sound] Stop attached localId=${localId} obj=${objectUuid.slice(0, 8)}`);
      SoundPlayer.stopAttached(localId);
      this.attachedSoundGains.delete(localId);
      return;
    }

    if (!soundId || soundId === '00000000-0000-0000-0000-000000000000') return;

    const loop = !!(flags & SoundFlags.Loop);

    const avatarPos = this.getAvatarPosition();
    if (obj && avatarPos) {
      const op = this.getObjectWorldPosition(obj);
      if (op) {
        const dx = op.x - avatarPos.x, dy = op.y - avatarPos.y, dz = op.z - avatarPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > MetaverseConnection.MAX_SOUND_DISTANCE ** 2) return;
        pkDebug('sound', `[Sound] Attached ${soundId.slice(0, 8)} localId=${localId} gain=${gain.toFixed(2)} loop=${loop} dist=${Math.sqrt(distSq).toFixed(1)}m`);
      }
    }

    if (!this.pendingSounds.has(soundId)) this.pendingSounds.set(soundId, []);
    this.pendingSounds.get(soundId)!.push({ type: 'attached', gain, localId, loop });
    this.soundFetchQueue?.request(soundId);
  }

  private handleAttachedSoundGainChange(msg: AttachedSoundGainChangeMessage): void {
    const objectUuid = msg.DataBlock.ObjectID.toString();
    const gain = msg.DataBlock.Gain;

    let localId: number | undefined;
    try {
      const obj = this.bot?.currentRegion?.objects?.getObjectByUUID(new UUID(objectUuid));
      if (obj) localId = obj.ID;
    } catch { /* not found */ }
    if (localId === undefined) return;

    // Update base gain — distance timer will apply attenuation on next tick
    this.attachedSoundGains.set(localId, gain);
  }

  private handlePreloadSound(msg: PreloadSoundMessage): void {
    for (const entry of msg.DataBlock) {
      const soundId = entry.SoundID.toString();
      if (soundId && soundId !== '00000000-0000-0000-0000-000000000000') {
        this.soundFetchQueue?.request(soundId);
      }
    }
  }

  private flushPendingSounds(soundId: string, cachePath: string): void {
    const pending = this.pendingSounds.get(soundId);
    if (!pending || pending.length === 0) return;
    this.pendingSounds.delete(soundId);

    const fwdPath = cachePath.replace(/\\/g, '/');
    const avatarPos = this.getAvatarPosition();
    const maxDist = MetaverseConnection.MAX_SOUND_DISTANCE;

    for (const evt of pending) {
      if (evt.type === 'trigger') {
        let distGain = 1;
        if (avatarPos && evt.position) {
          const dx = evt.position.x - avatarPos.x, dy = evt.position.y - avatarPos.y, dz = evt.position.z - avatarPos.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          distGain = dist > maxDist ? 0 : 1 / Math.max(1, dist);
        }
        const triggerId = this.nextTriggerId--;
        this.triggerSounds.set(triggerId, { baseGain: evt.gain, position: evt.position });
        pkDebug('sound', `[Sound] Play trigger ${soundId.slice(0, 8)} gain=${evt.gain.toFixed(2)} distGain=${distGain.toFixed(2)}`);
        SoundPlayer.playAttached(triggerId, fwdPath, evt.gain * distGain, false);
        setTimeout(() => this.triggerSounds.delete(triggerId), 30_000);
      } else if (evt.type === 'attached' && evt.localId !== undefined) {
        let distGain = 1;
        if (avatarPos) {
          try {
            const obj = this.bot?.currentRegion?.objects?.getObjectByLocalID(evt.localId);
            if (obj) {
              const op = this.getObjectWorldPosition(obj);
              if (op) {
                const dx = op.x - avatarPos.x, dy = op.y - avatarPos.y, dz = op.z - avatarPos.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                distGain = dist > maxDist ? 0 : 1 / Math.max(1, dist);
              }
            }
          } catch { /* ok */ }
        }
        this.attachedSoundGains.set(evt.localId, evt.gain);
        pkDebug('sound', `[Sound] Play attached ${soundId.slice(0, 8)} localId=${evt.localId} gain=${evt.gain.toFixed(2)} distGain=${distGain.toFixed(2)} loop=${evt.loop}`);
        SoundPlayer.playAttached(evt.localId, fwdPath, evt.gain * distGain, evt.loop ?? false);
      }
    }
  }

  /**
   * Populate friends list from login response buddy list
   */
  private populateFriendsFromLogin(): void {
    if (!this.bot) return;

    console.log(`[MetaverseConnection] populateFriendsFromLogin: ${this.bot.agent.buddyList.length} buddies`);
    for (const buddy of this.bot.agent.buddyList) {
      const friendId = buddy.buddyID.toString();
      pkDebug('friends', `[MetaverseConnection] Adding friend: ${friendId}`);
      const friend: Friend = {
        id: friendId,
        name: '', // Will be resolved later via name lookup
        online: false, // Will be updated via online notification
        canSeeOnline: buddy.buddyRightsHas,
        canSeeOnMap: false,
        canModifyObjects: false,
      };
      this.friends.set(friend.id, friend);

      // Resolve name asynchronously
      this.resolveFriendName(buddy.buddyID.toString()).catch(() => {
        // Ignore name resolution errors
      });
    }

    this.emit('friends-update', Array.from(this.friends.values()));
  }

  /**
   * Resolve a friend's name from their UUID
   */
  private async resolveFriendName(friendId: string): Promise<void> {
    if (!this.bot) return;

    try {
      // Check display name cache first
      const cachedName = this.displayNameCache?.getBestName(friendId);
      if (cachedName) {
        const friend = this.friends.get(friendId);
        if (friend) {
          friend.name = cachedName;
          return; // Will emit friends-update in bulk after all resolves
        }
      }

      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const uuid = new UUID(friendId);
      const nameResult = await this.bot.clientCommands.grid.avatarKey2Name(uuid);
      const friend = this.friends.get(friendId);
      if (friend && nameResult) {
        // avatarKey2Name can return single result or array
        const nameInfo = Array.isArray(nameResult) ? nameResult[0] : nameResult;
        if (nameInfo) {
          friend.name = nameInfo.getName();
          this.emit('friends-update', Array.from(this.friends.values()));
        }
      }
    } catch {
      // Name resolution failed, keep empty name
    }
  }

  // ============ Display Name Resolution ============

  /**
   * Batch-resolve display names for a list of UUIDs.
   * Filters out already-cached (non-stale) entries before calling the server.
   */
  private async resolveDisplayNames(uuids: string[]): Promise<void> {
    if (!this.bot || !this.displayNameCache) {
      console.log(`[MetaverseConnection] resolveDisplayNames: skipped (bot=${!!this.bot}, cache=${!!this.displayNameCache})`);
      return;
    }

    // Filter to only uncached or stale UUIDs
    const toResolve = uuids.filter(uuid => !this.displayNameCache!.get(uuid) || this.displayNameCache!.isStale(uuid));
    pkDebug('avatar', `[MetaverseConnection] resolveDisplayNames: ${uuids.length} total, ${toResolve.length} to resolve`);
    if (toResolve.length === 0) return;

    try {
      const { UUID } = await import('../../../node-metaverse/dist/lib/classes/UUID');
      const uuidObjects = toResolve.map(id => new UUID(id));
      const results = await this.bot.clientCommands.grid.getDisplayNames(uuidObjects);
      pkDebug('avatar', `[MetaverseConnection] resolveDisplayNames: got ${results.size} results`);
      if (results.size > 0) {
        this.displayNameCache.bulkSet(results);
        pkDebug('avatar', `[DisplayNameCache] Resolved ${results.size} display names`);
      }
    } catch (err) {
      console.error('[MetaverseConnection] Error resolving display names:', err);
    }
  }

  /**
   * Resolve display names for all friends after login.
   * Updates friend names with display names and re-emits friends-update.
   */
  private async resolveDisplayNamesForFriends(): Promise<void> {
    const friendIds = Array.from(this.friends.keys());
    if (friendIds.length === 0) return;

    await this.resolveDisplayNames(friendIds);

    // Update friend names with resolved display names
    let updated = false;
    for (const [friendId, friend] of this.friends) {
      const displayName = this.displayNameCache?.getBestName(friendId);
      if (displayName && friend.name !== displayName) {
        friend.name = displayName;
        updated = true;
      }
    }
    if (updated) {
      this.emit('friends-update', Array.from(this.friends.values()));
    }
  }

  /**
   * Get the display name cache (for use by IPC handlers)
   */
  getDisplayNameCache(): DisplayNameCache | null {
    return this.displayNameCache;
  }

  // ============ Chat Methods ============

  /**
   * Send nearby chat message
   */
  async sendNearbyChat(message: string, type: 'whisper' | 'normal' | 'shout' = 'normal', channel = 0): Promise<void> {
    if (!this.bot || this.state !== 'metaverse_connected') {
      throw new Error('Not connected to metaverse');
    }

    const chatTypeMap: Record<string, ChatType> = {
      'whisper': ChatType.Whisper,
      'normal': ChatType.Normal,
      'shout': ChatType.Shout,
    };

    await this.bot.clientCommands.comms.nearbyChat(message, chatTypeMap[type], channel);

    // Emit our own message for UI echo
    const outMessage: ChatMessage = {
      id: this.generateMessageId(),
      type: 'nearby',
      message,
      fromName: `${this.bot.agent.firstName} ${this.bot.agent.lastName}`,
      fromId: this.bot.agentID().toString(),
      timestamp: Date.now(),
      chatType: type,
      sourceType: 'agent',
      isOutgoing: true,
    };
    this.emit('nearby-chat', outMessage);
  }

  /**
   * Send instant message to another avatar
   */
  async sendIM(toId: string, message: string): Promise<void> {
    if (!this.bot || this.state !== 'metaverse_connected') {
      throw new Error('Not connected to metaverse');
    }

    await this.bot.clientCommands.comms.sendInstantMessage(toId, message);

    // Emit our own message for UI echo
    const outMessage: ChatMessage = {
      id: this.generateMessageId(),
      type: 'im',
      message,
      fromName: `${this.bot.agent.firstName} ${this.bot.agent.lastName}`,
      fromId: this.bot.agentID().toString(),
      timestamp: Date.now(),
      sessionId: toId,
      isOutgoing: true,
    };
    this.emit('im', outMessage);
  }

  /**
   * Send group chat message
   */
  async sendGroupMessage(groupId: string, message: string): Promise<void> {
    if (!this.bot || this.state !== 'metaverse_connected') {
      throw new Error('Not connected to metaverse');
    }

    await this.bot.clientCommands.comms.sendGroupMessage(groupId, message);

    // Note: Group messages echo back via onGroupChat event, so no manual emit needed
  }

  /**
   * Start an IM session (create it in sessions map)
   */
  startIMSession(participantId: string, participantName: string): ChatSession {
    if (this.chatSessions.has(participantId)) {
      return this.chatSessions.get(participantId)!;
    }

    const session: ChatSession = {
      id: participantId,
      type: 'im',
      name: participantName,
      participantId,
      unreadCount: 0,
    };
    this.chatSessions.set(participantId, session);
    this.emit('chat-session-update', session);
    return session;
  }

  /**
   * Start a group chat session
   */
  async startGroupChatSession(groupId: string): Promise<ChatSession> {
    console.log(`[MetaverseConnection] startGroupChatSession called for group ${groupId}, state: ${this.state}`);
    if (!this.bot || this.state !== 'metaverse_connected') {
      throw new Error('Not connected to metaverse');
    }

    try {
      console.log(`[MetaverseConnection] Calling bot.clientCommands.comms.startGroupChatSession`);
      await this.bot.clientCommands.comms.startGroupChatSession(groupId, '');
      console.log(`[MetaverseConnection] Group chat session started successfully`);
    } catch (err) {
      console.error(`[MetaverseConnection] Error starting group chat session:`, err);
      throw err;
    }

    const group = this.groups.get(groupId);
    const session: ChatSession = {
      id: groupId,
      type: 'group',
      name: group?.name || 'Group',
      groupId,
      unreadCount: 0,
    };
    this.chatSessions.set(groupId, session);
    console.log(`[MetaverseConnection] Emitting chat-session-update for group: ${session.name}`);
    this.emit('chat-session-update', session);
    return session;
  }

  // ============ Data Access ============

  getFriends(): Friend[] {
    return Array.from(this.friends.values());
  }

  getGroups(): Group[] {
    return Array.from(this.groups.values());
  }

  getNearbyAvatars(): NearbyAvatar[] {
    return Array.from(this.nearbyAvatars.values());
  }

  getChildAvatars(): Array<{
    id: string;
    name: string;
    regionName: string;
    gridX: number;
    gridY: number;
    position: { x: number; y: number; z: number };
  }> {
    if (!this.bot?.childAgentManager) return [];
    try {
      return this.bot.childAgentManager.getAllChildAvatars().map((entry) => ({
        id: entry.avatar.id,
        name: `${entry.avatar.firstName} ${entry.avatar.lastName}`,
        regionName: entry.regionName,
        gridX: entry.gridX,
        gridY: entry.gridY,
        position: {
          x: entry.avatar.position.x,
          y: entry.avatar.position.y,
          z: entry.avatar.position.z,
        },
      }));
    } catch {
      return [];
    }
  }

  getRegionInfo(): RegionInfo | null {
    if (!this.bot?.currentRegion) return this.cachedRegionInfo;
    const region = this.bot.currentRegion;
    const x = region.xCoordinate;
    const y = region.yCoordinate;
    // Get our own avatar position from the region's avatar list
    let agentPosition: { x: number; y: number; z: number } | undefined;
    const selfAvatar = region.agents.get(this.bot.agentID().toString());
    if (selfAvatar) {
      const pos = selfAvatar.position;
      agentPosition = { x: pos.x, y: pos.y, z: pos.z };
    }
    const info: RegionInfo = {
      name: region.regionName,
      x,
      y,
      mapImageUrl: `https://secondlife-maps-cdn.akamaized.net/map-1-${x}-${y}-objects.jpg`,
      agentPosition,
    };
    this.cachedRegionInfo = info;
    return info;
  }

  /** Throttled emit of region-info-update — at most once per 500ms */
  private emitRegionInfoThrottled(): void {
    this.regionInfoDirty = true;
    if (this.regionInfoThrottleTimer) return; // already scheduled
    this.regionInfoThrottleTimer = setTimeout(() => {
      this.regionInfoThrottleTimer = null;
      if (this.regionInfoDirty) {
        this.regionInfoDirty = false;
        const info = this.getRegionInfo();
        if (info) this.emit('region-info-update', info);
      }
    }, 500);
  }

  getChatSessions(): ChatSession[] {
    return Array.from(this.chatSessions.values());
  }

  getChatSession(sessionId: string): ChatSession | undefined {
    return this.chatSessions.get(sessionId);
  }

  markSessionRead(sessionId: string): void {
    const session = this.chatSessions.get(sessionId);
    if (session) {
      session.unreadCount = 0;
      this.emit('chat-session-update', session);
    }
  }

  /**
   * Get the underlying bot instance (for advanced operations)
   */
  getBot(): Bot | null {
    return this.bot;
  }

  getSceneManager(): SceneManager | null {
    return this._sceneManager;
  }

  /**
   * Get the current region name (if connected and in a region)
   */
  getRegionName(): string | undefined {
    return this.bot?.currentRegion?.regionName;
  }
}

/**
 * Manages MetaverseConnection instances
 */
export class MetaverseConnectionManager extends EventEmitter {
  private connections: Map<string, MetaverseConnection> = new Map();

  create(instanceId: string): MetaverseConnection {
    if (this.connections.has(instanceId)) {
      throw new Error(`Connection ${instanceId} already exists`);
    }

    const connection = new MetaverseConnection(instanceId);
    this.connections.set(instanceId, connection);

    // Forward events
    connection.on('state-change', (state) => {
      this.emit('state-change', instanceId, state);
    });
    connection.on('nearby-chat', (message) => {
      this.emit('nearby-chat', instanceId, message);
    });
    connection.on('im', (message) => {
      this.emit('im', instanceId, message);
    });
    connection.on('group-chat', (message) => {
      this.emit('group-chat', instanceId, message);
    });
    connection.on('friends-update', (friends) => {
      this.emit('friends-update', instanceId, friends);
    });
    connection.on('friend-online', (friend, online) => {
      this.emit('friend-online', instanceId, friend, online);
    });
    connection.on('groups-update', (groups) => {
      this.emit('groups-update', instanceId, groups);
    });
    connection.on('nearby-avatars-update', (avatars) => {
      this.emit('nearby-avatars-update', instanceId, avatars);
    });
    connection.on('region-info-update', (info) => {
      this.emit('region-info-update', instanceId, info);
    });
    connection.on('chat-session-update', (session) => {
      this.emit('chat-session-update', instanceId, session);
    });
    connection.on('error', (error) => {
      this.emit('error', instanceId, error);
    });
    connection.on('mfa-required', () => {
      this.emit('mfa-required', instanceId);
    });

    return connection;
  }

  get(instanceId: string): MetaverseConnection | undefined {
    return this.connections.get(instanceId);
  }

  async remove(instanceId: string): Promise<void> {
    const connection = this.connections.get(instanceId);
    if (connection) {
      await connection.logout();
      this.connections.delete(instanceId);
    }
  }

  async removeAll(): Promise<void> {
    for (const [instanceId] of this.connections) {
      await this.remove(instanceId);
    }
  }

  getAll(): MetaverseConnection[] {
    return Array.from(this.connections.values());
  }
}

export const metaverseConnectionManager = new MetaverseConnectionManager();
