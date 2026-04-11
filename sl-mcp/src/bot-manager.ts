/**
 * Bot lifecycle manager — adapted from metaverse-connection.ts but simplified.
 * No Electron IPC, no display name cache, no chat sessions — just bot + data access.
 *
 * ## node-metaverse UUID gotcha
 *
 * Many node-metaverse APIs return Maps keyed by UUID *objects*, not strings.
 * For example, `getDisplayNames()` returns `Map<UUID, {...}>` even though the
 * type declaration says `Map<string, {...}>`. Calling `.get(stringId)` on such
 * a map will always return undefined because object identity !== string equality.
 *
 * **Always convert UUID keys to strings before doing lookups:**
 *   ```ts
 *   const lookup = new Map<string, V>();
 *   for (const [key, val] of uuidKeyedMap) {
 *     lookup.set(key.toString(), val);
 *   }
 *   ```
 *
 * Similarly, when we store IDs internally (friends, avatars, groups), we always
 * call `.toString()` on UUID objects so our Maps use plain string keys.
 */

import { Bot, BotOptionFlags, LoginParameters, Vector3 } from '../../electron-ui/node-metaverse/dist/lib/index.js';
import { ChatType } from '../../electron-ui/node-metaverse/dist/lib/enums/ChatType.js';
import { ChatSourceType } from '../../electron-ui/node-metaverse/dist/lib/enums/ChatSourceType.js';
import { TeleportEventType } from '../../electron-ui/node-metaverse/dist/lib/enums/TeleportEventType.js';
import { InstantMessageEventFlags } from '../../electron-ui/node-metaverse/dist/lib/enums/InstantMessageEventFlags.js';
import { RightsFlags } from '../../electron-ui/node-metaverse/dist/lib/enums/RightsFlags.js';
import { UUID } from '../../electron-ui/node-metaverse/dist/lib/classes/UUID.js';
import { Quaternion } from '../../electron-ui/node-metaverse/dist/lib/classes/Quaternion.js';
import { DeRezDestination } from '../../electron-ui/node-metaverse/dist/lib/enums/DeRezDestination.js';
import { AssetType } from '../../electron-ui/node-metaverse/dist/lib/enums/AssetType.js';
import { ControlFlags } from '../../electron-ui/node-metaverse/dist/lib/enums/ControlFlags.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type BotState = 'disconnected' | 'logging_in' | 'connected';

export interface Friend {
  id: string;
  name: string;
  online: boolean;
}

export interface Group {
  id: string;
  name: string;
}

export interface NearbyAvatar {
  id: string;
  /** Legacy username (e.g. "Aranur Kamachi") */
  name: string;
  /** Custom display name (e.g. "Aard") — resolved via GetDisplayNames cap */
  displayName?: string;
  position: { x: number; y: number; z: number };
}

export interface IncomingIM {
  fromName: string;
  fromId: string;
  message: string;
  timestamp: number;
}

export interface NearbyChatMessage {
  fromName: string;
  fromId: string;
  message: string;
  chatType: string;
  timestamp: number;
}

export class BotManager {
  private bot: Bot | null = null;
  private _state: BotState = 'disconnected';
  private friends = new Map<string, Friend>();
  private groups = new Map<string, Group>();
  private nearbyAvatars = new Map<string, NearbyAvatar>();
  private recentIMs: IncomingIM[] = [];
  private recentChat: NearbyChatMessage[] = [];
  private maxRecentIMs = 50;
  private maxRecentChat = 100;
  private cameraInterval: ReturnType<typeof setInterval> | null = null;
  private loginPromise: Promise<string> | null = null;
  private _kickedMessage: string | null = null;

  get state(): BotState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === 'connected' && this.bot !== null;
  }

  getBot(): Bot | null {
    return this.bot;
  }

  // ============ Auto-login ============

  /**
   * Load default credentials from accounts.json.
   * Uses the first account (BonnieBelle81) as the default bot.
   */
  private async loadDefaultCredentials(): Promise<{ firstName: string; lastName: string; password: string }> {
    const accountsPath = join(__dirname, '..', '..', 'electron-ui', 'data', 'accounts.json');
    const data = JSON.parse(await readFile(accountsPath, 'utf-8'));
    const account = data[0]; // BonnieBelle81
    return {
      firstName: account.firstName,
      lastName: account.lastName,
      password: account.password,
    };
  }

  /**
   * Ensure the bot is connected, auto-logging in with default credentials if needed.
   * Safe for concurrent calls — subsequent callers wait on the same login promise.
   */
  async ensureConnected(): Promise<void> {
    if (this.isConnected) return;
    // Clear kicked state — the caller is explicitly asking to reconnect
    if (this._kickedMessage) {
      this._kickedMessage = null;
    }
    if (this.loginPromise) {
      await this.loginPromise;
      return;
    }
    const creds = await this.loadDefaultCredentials();
    this.loginPromise = this.login(creds);
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  // ============ Camera ============

  /**
   * Update the bot's camera to its current avatar position (slightly above, looking forward).
   * The sim uses camera position to determine which objects to stream — without this,
   * objects near the avatar won't be sent to the bot.
   */
  /**
   * Wait until the bot's avatar appears in the agent list with a valid position.
   */
  private waitForAgentPosition(timeout = 10000): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        let region;
        try { region = this.bot?.currentRegion; } catch { resolve(); return; }
        const self = region?.agents?.get(this.bot!.agentID().toString());
        if (self && (self.position.x !== 0 || self.position.y !== 0)) {
          resolve();
          return;
        }
        if (Date.now() - start > timeout) {
          resolve(); // give up silently, camera stays at region center
          return;
        }
        setTimeout(check, 250);
      };
      check();
    });
  }

  private updateCamera(): void {
    if (!this.bot) return;
    let region;
    try { region = this.bot.currentRegion; } catch { return; }
    const self = region?.agents?.get(this.bot.agentID().toString());
    if (!self) return;

    const pos = self.position;
    const camPos = new Vector3([pos.x, pos.y, pos.z + 2.0]);
    const lookAt = new Vector3([1, 0, 0]); // forward
    this.bot.clientCommands.agent.setCamera(camPos, lookAt);
  }

  // ============ Session ============

  async login(params: {
    firstName: string;
    lastName: string;
    password: string;
    loginUrl?: string;
    startLocation?: string;
  }): Promise<string> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot login: state is ${this._state}`);
    }

    this._kickedMessage = null;
    this._state = 'logging_in';

    try {
      const loginParams = new LoginParameters();
      loginParams.firstName = params.firstName;
      loginParams.lastName = params.lastName;
      loginParams.password = params.password;
      loginParams.url = params.loginUrl || 'https://login.agni.lindenlab.com/cgi-bin/login.cgi';
      loginParams.start = params.startLocation || 'last';

      this.bot = new Bot(loginParams, BotOptionFlags.None);
      await this.bot.login();
      // Set draw distance and camera BEFORE connectToSim so the sim streams nearby objects.
      // The default cameraCenter is hardcoded to (199,203,24) which is wrong — use region center
      // as initial guess, then update to actual avatar position after connecting.
      this.bot.agent.cameraFar = 1024;
      this.bot.agent.cameraCenter = new Vector3([128, 128, 30]);
      this.setupEventSubscriptions();
      this.populateFriendsFromLogin();
      await this.bot.connectToSim();
      // Request 360-degree interest list so sim sends all objects within draw distance
      // (default mode only sends objects the camera is facing)
      await this.bot.setInterestList('360').catch(() => { });
      // Request 1.5 Mbps bandwidth (matching Firestorm default) so the sim streams objects faster
      await this.bot.clientCommands.network.setBandwidth(1_500_000).catch(() => { });

      // Wait for agent position then move camera so sim streams nearby objects
      await this.waitForAgentPosition(10000);
      this.updateCamera();
      // Keep camera synced to avatar position (sim uses camera for interest list)
      this.cameraInterval = setInterval(() => this.updateCamera(), 5000);

      this._state = 'connected';
      const region = this.bot.currentRegion?.regionName || 'unknown';
      return `Logged in as ${params.firstName} ${params.lastName} in ${region}`;
    } catch (err: any) {
      this._state = 'disconnected';
      this.bot = null;
      throw err;
    }
  }

  async logout(): Promise<void> {
    if (this.cameraInterval) {
      clearInterval(this.cameraInterval);
      this.cameraInterval = null;
    }
    if (this.bot) {
      try { await this.bot.close(); } catch { }
      this.bot = null;
    }
    this.friends.clear();
    this.groups.clear();
    this.nearbyAvatars.clear();
    this.recentIMs = [];
    this.recentChat = [];
    this._state = 'disconnected';
  }

  getStatus(): Record<string, unknown> {
    if (!this.bot || this._state !== 'connected') {
      return { state: this._state };
    }
    let region;
    try { region = this.bot.currentRegion; } catch { return { state: 'disconnected' }; }
    let agentPosition: { x: number; y: number; z: number } | undefined;
    // region.agents is a Map<string, Avatar> keyed by agent UUID string
    const selfAvatar = region?.agents?.get(this.bot.agentID().toString());
    if (selfAvatar) {
      const pos = selfAvatar.position;
      agentPosition = { x: pos.x, y: pos.y, z: pos.z };
    }
    return {
      state: this._state,
      avatarName: `${this.bot.agent.firstName} ${this.bot.agent.lastName}`,
      avatarId: this.bot.agentID().toString(),
      region: region?.regionName,
      position: agentPosition,
    };
  }

  // ============ Chat ============

  async say(message: string, type: 'whisper' | 'normal' | 'shout' = 'normal', channel = 0): Promise<void> {
    await this.ensureConnected();
    const chatTypeMap: Record<string, ChatType> = {
      whisper: ChatType.Whisper,
      normal: ChatType.Normal,
      shout: ChatType.Shout,
    };
    await this.bot!.clientCommands.comms.nearbyChat(message, chatTypeMap[type], channel);
  }

  async sendIM(avatarId: string, message: string): Promise<void> {
    await this.ensureConnected();
    await this.bot!.clientCommands.comms.sendInstantMessage(avatarId, message);
  }

  async sendGroupMessage(groupId: string, message: string): Promise<void> {
    await this.ensureConnected();
    await this.bot!.clientCommands.comms.sendGroupMessage(groupId, message);
  }

  // ============ Navigation ============

  async teleport(regionName: string, x = 128, y = 128, z = 30): Promise<string> {
    await this.ensureConnected();
    const agentId = this.bot!.agentID().toString();
    console.log(`[Teleport] Agent ${agentId} requesting teleport to "${regionName}" (${x}, ${y}, ${z})`);
    const position = new Vector3([x, y, z]);
    const lookAt = new Vector3([0, 1, 0]);
    try {
      await this.bot!.clientCommands.teleport.teleportTo(regionName, position, lookAt);
      this.updateCamera();
      console.log(`[Teleport] Agent ${agentId} teleport to "${regionName}" succeeded`);
      return `Teleported to ${regionName} (${x}, ${y}, ${z})`;
    } catch (err: any) {
      console.error(`[Teleport] Agent ${agentId} teleport to "${regionName}" FAILED:`, err.message || err);
      throw err;
    }
  }

  /**
   * Get nearby avatars with display names resolved via the GetDisplayNames capability.
   *
   * Note on UUID Map keys: getDisplayNames() returns a Map keyed by UUID objects,
   * not strings. We must convert keys with .toString() before looking up our
   * string-based avatar IDs. See class-level doc for full explanation.
   */
  async getNearbyAvatars(): Promise<NearbyAvatar[]> {
    await this.ensureConnected();
    const avatars = Array.from(this.nearbyAvatars.values());

    const uuidsToResolve = avatars.map(a => new UUID(a.id));
    if (uuidsToResolve.length > 0) {
      try {
        const displayNames = await this.bot!.clientCommands.grid.getDisplayNames(uuidsToResolve);

        // IMPORTANT: displayNames Map is keyed by UUID objects, not strings.
        // Map.get(stringId) will never match a UUID object key, so we must
        // rebuild as a string-keyed map first.
        const dnLookup = new Map<string, string>();
        for (const [key, val] of displayNames) {
          dnLookup.set(key.toString(), val.displayName);
        }

        for (const avatar of avatars) {
          avatar.displayName = dnLookup.get(avatar.id);
        }
      } catch {
        // GetDisplayNames cap may be unavailable (e.g. OpenSim) — continue with legacy names
      }
    }
    return avatars;
  }

  /**
   * Walk the bot to a target position using avatar control flags.
   *
   * How it works:
   * 1. Calculate yaw angle from current position to target
   * 2. Set the agent's bodyRotation quaternion to face the target
   *    (bodyRotation is private but we access it via (agent as any) since
   *    TypeScript private is compile-time only)
   * 3. Set AGENT_CONTROL_AT_POS flag (walk forward)
   * 4. The agent's built-in 1-second agentUpdateTimer sends these to the server
   * 5. We poll position every 250ms and update rotation to track the target
   * 6. When within stopDistance, clear the walk flag and resolve
   *
   * SL coordinate system: X = East, Y = North, Z = Up.
   * Identity rotation faces +X. Yaw is rotation around Z axis.
   * Quaternion for yaw: (0, 0, sin(yaw/2), cos(yaw/2))
   */
  async walkTo(
    targetX: number, targetY: number, targetZ: number,
    stopDistance = 3.0, timeout = 30000
  ): Promise<string> {
    await this.ensureConnected();

    const agent = this.bot!.agent;
    const region = this.bot!.currentRegion;

    const getMyPos = (): { x: number; y: number; z: number } | null => {
      const self = region?.agents?.get(this.bot!.agentID().toString());
      return self ? { x: self.position.x, y: self.position.y, z: self.position.z } : null;
    };

    const startPos = getMyPos();
    if (!startPos) throw new Error('Cannot determine current position');

    const setFacing = (fromX: number, fromY: number, toX: number, toY: number) => {
      const dx = toX - fromX;
      const dy = toY - fromY;
      // atan2(dy, dx) gives angle from +X axis, which matches SL's identity forward
      const yaw = Math.atan2(dy, dx);
      const bodyRot = (agent as any).bodyRotation as Quaternion;
      bodyRot.x = 0;
      bodyRot.y = 0;
      bodyRot.z = Math.sin(yaw / 2);
      bodyRot.w = Math.cos(yaw / 2);
    };

    const cleanup = () => {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_AT_POS);
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_FLY);
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
      agent.sendAgentUpdate();
    };

    // Face the target and start walking forward
    setFacing(startPos.x, startPos.y, targetX, targetY);
    agent.setControlFlag(ControlFlags.AGENT_CONTROL_AT_POS);
    agent.sendAgentUpdate();

    return new Promise((resolve) => {
      const startTime = Date.now();
      let flying = false;
      let bestDist = Infinity;
      let noProgressCount = 0;
      let prevDist = Infinity;
      let overshootCount = 0;

      const poll = setInterval(() => {
        const pos = getMyPos();
        if (!pos) return;

        const dx = targetX - pos.x;
        const dy = targetY - pos.y;
        const dz = targetZ - pos.z;
        const dist2d = Math.sqrt(dx * dx + dy * dy);
        const dist3d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const dist = flying ? dist3d : dist2d;

        // Arrived?
        if (dist <= stopDistance) {
          clearInterval(poll);
          cleanup();
          resolve(`Arrived at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}), ${dist.toFixed(1)}m from target`);
          return;
        }

        // Deceleration zone: stop walking when close, let momentum coast us in
        if (dist < stopDistance + 2) {
          agent.clearControlFlag(ControlFlags.AGENT_CONTROL_AT_POS);
          agent.sendAgentUpdate();
        } else {
          agent.setControlFlag(ControlFlags.AGENT_CONTROL_AT_POS);
        }

        // Overshoot detection: distance increasing means we passed the target
        if (dist > prevDist + 0.2) {
          overshootCount++;
          if (overshootCount >= 2) {
            // We overshot — stop and report current position
            clearInterval(poll);
            cleanup();
            resolve(`Arrived at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}), ${dist.toFixed(1)}m from target`);
            return;
          }
        } else {
          overshootCount = 0;
        }
        prevDist = dist;

        // Timeout?
        if (Date.now() - startTime > timeout) {
          clearInterval(poll);
          cleanup();
          resolve(`Timed out after ${(timeout / 1000).toFixed(0)}s, ${dist.toFixed(1)}m from target at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
          return;
        }

        // Re-face target each tick to course-correct
        setFacing(pos.x, pos.y, targetX, targetY);
        // Update camera to follow avatar so sim streams objects along path
        this.updateCamera();
        agent.sendAgentUpdate();

        // Stuck detection
        if (dist < bestDist - 0.3) {
          bestDist = dist;
          noProgressCount = 0;
        } else {
          noProgressCount++;
        }

        // 4 seconds without getting closer → stuck
        if (noProgressCount > 16) {
          if (!flying && Math.abs(dz) > 1.5) {
            flying = true;
            noProgressCount = 0;
            bestDist = dist3d;
            agent.setControlFlag(ControlFlags.AGENT_CONTROL_FLY);
            if (dz > 0) {
              agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
            } else {
              agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
            }
            agent.sendAgentUpdate();
          } else {
            clearInterval(poll);
            cleanup();
            resolve(`Got stuck at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}), ${dist.toFixed(1)}m from target`);
            return;
          }
        }

        // While flying, manage altitude
        if (flying) {
          if (Math.abs(dz) < 1.0) {
            agent.clearControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
            agent.clearControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
          } else if (dz > 0) {
            agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
            agent.clearControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
          } else {
            agent.setControlFlag(ControlFlags.AGENT_CONTROL_UP_NEG);
            agent.clearControlFlag(ControlFlags.AGENT_CONTROL_UP_POS);
          }
        }
      }, 250);
    });
  }

  /** Enable or disable flight mode. */
  async setFlying(enabled: boolean): Promise<void> {
    await this.ensureConnected();
    const agent = this.bot!.agent;
    if (enabled) {
      agent.setControlFlag(ControlFlags.AGENT_CONTROL_FLY);
    } else {
      agent.clearControlFlag(ControlFlags.AGENT_CONTROL_FLY);
    }
    agent.sendAgentUpdate();
  }

  /** Sit the bot on an object by its local ID. */
  async sitOnObject(localId: number): Promise<void> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true);
    await this.bot!.clientCommands.movement.sitOnObject(obj.FullID, new Vector3([0, 0, 0]));
  }

  /** Stand up from sitting. */
  async standUp(): Promise<void> {
    await this.ensureConnected();
    this.bot!.clientCommands.movement.stand();
  }

  /** Sit on ground. */
  async sitOnGround(): Promise<void> {
    await this.ensureConnected();
    this.bot!.clientCommands.movement.sitOnGround();
  }

  getRegionInfo(): Record<string, unknown> | null {
    if (!this.bot) return null;
    let region;
    try { region = this.bot.currentRegion; } catch { return null; }
    if (!region) return null;
    let agentPosition: { x: number; y: number; z: number } | undefined;
    const selfAvatar = region.agents?.get(this.bot.agentID().toString());
    if (selfAvatar) {
      const pos = selfAvatar.position;
      agentPosition = { x: pos.x, y: pos.y, z: pos.z };
    }
    return {
      name: region.regionName,
      x: region.xCoordinate,
      y: region.yCoordinate,
      agentPosition,
    };
  }

  // ============ Social ============

  getFriends(): Friend[] {
    return Array.from(this.friends.values());
  }

  getGroups(): Group[] {
    return Array.from(this.groups.values());
  }

  /**
   * Get an avatar's state: sitting/standing and what they're sitting on.
   * Accesses the private _gameObject.ParentID to check sit state.
   */
  async getAvatarState(avatarId: string): Promise<{
    sitting: boolean;
    sittingOnLocalId?: number;
    sittingOnName?: string;
    position: { x: number; y: number; z: number };
  } | null> {
    await this.ensureConnected();
    const region = this.bot!.currentRegion;
    const avatar = region?.agents?.get(avatarId);
    if (!avatar) return null;

    const pos = avatar.position;
    const go = (avatar as any)._gameObject;
    const parentId = go?.ParentID as number | undefined;
    const sitting = parentId != null && parentId > 0;

    let sittingOnName: string | undefined;
    if (sitting) {
      try {
        // getObjectByLocalID with resolve=true fetches object properties (name) from sim
        const obj = await this.bot!.clientCommands.region.getObjectByLocalID(parentId, true, 3000);
        sittingOnName = (obj as any)?.name || undefined;
      } catch {
        // Object not available from sim
      }
    }

    return {
      sitting,
      ...(sitting ? { sittingOnLocalId: parentId, sittingOnName } : {}),
      position: { x: pos.x, y: pos.y, z: pos.z },
    };
  }

  /**
   * Resolve avatar name → UUID. Accepts "First Last" or "first.last" format.
   */
  async avatarName2Key(name: string): Promise<string> {
    await this.ensureConnected();
    const uuid = await this.bot!.clientCommands.grid.avatarName2Key(name);
    return uuid.toString();
  }

  /**
   * Resolve UUID → avatar name.
   * avatarKey2Name can return a single result or an array — handle both.
   */
  async avatarKey2Name(uuid: string): Promise<string> {
    await this.ensureConnected();
    const uuidObj = new UUID(uuid);
    const result = await this.bot!.clientCommands.grid.avatarKey2Name(uuidObj);
    const info = Array.isArray(result) ? result[0] : result;
    return info?.getName() || 'Unknown';
  }

  async getBalance(): Promise<number> {
    await this.ensureConnected();
    return await this.bot!.clientCommands.grid.getBalance();
  }

  getRecentIMs(): IncomingIM[] {
    return [...this.recentIMs];
  }

  getRecentChat(): NearbyChatMessage[] {
    return [...this.recentChat];
  }

  // ============ Objects ============

  /**
   * Rez new prims near the bot. They appear ~2m above the avatar.
   * Returns local IDs (for subsequent manipulation) and UUIDs.
   *
   * GameObject properties: .ID = local ID (number), .FullID = UUID object,
   * .Position = Vector3. The .name property holds the object name after resolve.
   */
  async rezPrims(count = 1): Promise<Array<{ localId: number; uuid: string; position: { x: number; y: number; z: number } }>> {
    await this.ensureConnected();
    const objects = await this.bot!.clientCommands.region.rezPrims(count);
    return objects.map(o => ({
      localId: o.ID,
      uuid: o.FullID.toString(),
      position: o.Position ? { x: o.Position.x, y: o.Position.y, z: o.Position.z } : { x: 0, y: 0, z: 0 },
    }));
  }

  async setObjectName(localId: number, name: string): Promise<void> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true);
    await obj.setName(name);
  }

  async setObjectDescription(localId: number, description: string): Promise<void> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true);
    await obj.setDescription(description);
  }

  /** Move object. Uses setGeometry with position only (preserves rotation/scale). */
  async setObjectPosition(localId: number, x: number, y: number, z: number): Promise<void> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true);
    await obj.setGeometry(new Vector3([x, y, z]));
  }

  /** Resize object. Uses setGeometry with scale only (preserves position/rotation). */
  async setObjectScale(localId: number, x: number, y: number, z: number): Promise<void> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true);
    await obj.setGeometry(undefined, undefined, new Vector3([x, y, z]));
  }

  /**
   * Find objects by name pattern (supports glob via micromatch internally).
   * Polls every 2s until results are found or timeout expires.
   * Useful after login/teleport when the region is still streaming objects.
   *
   * @param pattern  Glob pattern for object names (e.g. "*Minesweeper*")
   * @param timeout  Max time in ms to keep retrying (default 10000). Pass 0 for a single attempt.
   */
  async findObjectsByName(
    pattern: string,
    timeout = 10000,
  ): Promise<Array<{ localId: number; uuid: string; name: string; position: { x: number; y: number; z: number } }>> {
    await this.ensureConnected();
    const start = Date.now();
    let objects = await this.bot!.clientCommands.region.findObjectsByName(pattern);
    while (objects.length === 0 && Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 2000));
      objects = await this.bot!.clientCommands.region.findObjectsByName(pattern);
    }
    return objects.map(o => ({
      localId: o.ID,
      uuid: o.FullID.toString(),
      name: (o as any).name || '(unknown)',
      position: o.Position ? { x: o.Position.x, y: o.Position.y, z: o.Position.z } : { x: 0, y: 0, z: 0 },
      scale: o.Scale ? { x: o.Scale.x, y: o.Scale.y, z: o.Scale.z } : undefined,
    }));
  }

  /**
   * Find an object by its UUID. Returns localId, uuid, name, and position.
   * Uses getObjectByUUID from node-metaverse with resolve=true to fetch properties.
   */
  async getObjectByUUID(
    uuid: string,
    timeout = 10000,
  ): Promise<Record<string, any>> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByUUID(new UUID(uuid), true, timeout);
    const ld = obj.extraParams?.lightData;
    const lid = obj.extraParams?.lightImageData;
    const md = obj.extraParams?.meshData;
    const sd = obj.extraParams?.sculptData;
    const emd = obj.extraParams?.extendedMeshData;
    return {
      localId: obj.ID,
      uuid: obj.FullID.toString(),
      name: (obj as any).name || '(unknown)',
      position: obj.Position ? { x: obj.Position.x, y: obj.Position.y, z: obj.Position.z } : { x: 0, y: 0, z: 0 },
      scale: obj.Scale ? { x: obj.Scale.x, y: obj.Scale.y, z: obj.Scale.z } : undefined,
      ...(md ? { mesh: { uuid: md.meshData?.toString(), type: md.type } } : {}),
      ...(sd ? { sculpt: { texture: sd.texture?.toString(), type: sd.type } } : {}),
      ...(emd ? { extendedMesh: { flags: emd.flags } } : {}),
      ...(ld ? { light: {
        color: [ld.Color.getRed(), ld.Color.getGreen(), ld.Color.getBlue()],
        intensity: ld.Intensity,
        radius: ld.Radius,
        falloff: ld.Falloff,
        cutoff: ld.Cutoff,
      }} : {}),
      ...(lid ? { lightImage: {
        texture: lid.texture?.toString(),
        params: { x: lid.params.x, y: lid.params.y, z: lid.params.z },
      }} : {}),
    };
  }

  /**
   * Get child prims of a linkset. Resolves the root object which populates
   * obj.children via populateChildren in the object store.
   * Returns each child's localId, name, and position (relative to root).
   */
  async getObjectChildren(localId: number): Promise<Array<{
    localId: number; uuid: string; name: string;
    position: { x: number; y: number; z: number };
  }>> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true, 5000);
    if (!obj.children || obj.children.length === 0) {
      return [];
    }
    return obj.children.map(c => ({
      localId: c.ID,
      uuid: c.FullID.toString(),
      name: (c as any).name || '(unknown)',
      position: c.Position
        ? { x: c.Position.x, y: c.Position.y, z: c.Position.z }
        : { x: 0, y: 0, z: 0 },
    }));
  }

  /**
   * Get texture information for each face of a prim.
   * Returns the texture UUID, offset, repeat, and rotation per face.
   * Also includes the defaultTexture if present.
   */
  async getObjectTextures(localId: number): Promise<{
    defaultTexture?: { textureId: string; rgba: { r: number; g: number; b: number; a: number }; offsetU: number; offsetV: number; repeatU: number; repeatV: number; rotation: number; glow: number; materialId?: string };
    faces: Array<{ face: number; textureId: string; rgba: { r: number; g: number; b: number; a: number }; offsetU: number; offsetV: number; repeatU: number; repeatV: number; rotation: number; glow: number; materialId?: string }>;
  }> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true);
    const te = obj.TextureEntry;
    if (!te) {
      return { faces: [] };
    }

    const mappingNames: Record<number, string> = { 0: 'default', 2: 'planar', 4: 'spherical' };
    const faceData = (face: any) => {
      const color = face.rgba;
      const matId = face.materialID?.toString();
      return {
        textureId: face.textureID?.toString() || '',
        rgba: color ? { r: color.red ?? 1, g: color.green ?? 1, b: color.blue ?? 1, a: color.alpha ?? 1 } : { r: 1, g: 1, b: 1, a: 1 },
        offsetU: face.offsetU ?? 0,
        offsetV: face.offsetV ?? 0,
        repeatU: face.repeatU ?? 1,
        repeatV: face.repeatV ?? 1,
        rotation: face.rotation ?? 0,
        glow: face.glow ?? 0,
        mapping: mappingNames[face.mappingType as number] ?? 'default',
        ...(matId && matId !== '00000000-0000-0000-0000-000000000000' ? { materialId: matId } : {}),
      };
    };

    // PBR material asset UUIDs per face (from renderMaterialData extra param)
    const rmd = obj.extraParams?.renderMaterialData;
    const pbrMaterialMap = new Map<number, string>();
    if (rmd?.params?.length) {
      for (const param of rmd.params) {
        const matUuid = param.textureUUID?.toString();
        if (matUuid && matUuid !== '00000000-0000-0000-0000-000000000000') {
          pbrMaterialMap.set(param.textureIndex, matUuid);
        }
      }
    }

    // Inline GLTF material overrides per face
    const gltfOverrides = te.gltfMaterialOverrides;
    const inlineOverrideMap = new Map<number, Record<string, unknown>>();
    if (gltfOverrides?.size) {
      for (const [idx, override] of gltfOverrides) {
        const entry: Record<string, unknown> = {};
        if (override.textures?.length) {
          const texNames = ['baseColor', 'normal', 'orm', 'emissive'];
          for (let t = 0; t < override.textures.length; t++) {
            const tid = override.textures[t]?.toString();
            if (tid && tid !== '00000000-0000-0000-0000-000000000000') {
              entry[`${texNames[t] ?? `tex${t}`}Texture`] = tid;
            }
          }
        }
        if (override.baseColor) entry.baseColor = override.baseColor;
        if (override.metallicFactor !== undefined) entry.metallicFactor = override.metallicFactor;
        if (override.roughnessFactor !== undefined) entry.roughnessFactor = override.roughnessFactor;
        if (override.emissiveFactor) entry.emissiveFactor = override.emissiveFactor;
        if (override.alphaMode !== undefined) entry.alphaMode = override.alphaMode;
        if (override.alphaCutoff !== undefined) entry.alphaCutoff = override.alphaCutoff;
        if (override.doubleSided !== undefined) entry.doubleSided = override.doubleSided;
        if (Object.keys(entry).length > 0) inlineOverrideMap.set(idx, entry);
      }
    }

    // Build face list: start with explicit te.faces, then fill gaps from default
    // for any face index referenced by renderMaterialData or gltfOverrides
    const allFaceIndices = new Set<number>();
    for (let i = 0; i < te.faces.length; i++) allFaceIndices.add(i);
    for (const idx of pbrMaterialMap.keys()) allFaceIndices.add(idx);
    for (const idx of inlineOverrideMap.keys()) allFaceIndices.add(idx);

    const faceList = Array.from(allFaceIndices).sort((a, b) => a - b).map(i => ({
      face: i,
      ...faceData(te.faces[i] ?? te.defaultTexture),
      ...(pbrMaterialMap.has(i) ? { pbrMaterialId: pbrMaterialMap.get(i) } : {}),
      ...(inlineOverrideMap.has(i) ? { gltfOverride: inlineOverrideMap.get(i) } : {}),
    }));

    return {
      defaultTexture: te.defaultTexture ? faceData(te.defaultTexture) : undefined,
      faces: faceList,
    };
  }

  /** Download a raw asset and return its content as text + hex preview */
  async downloadRawAsset(uuid: string, assetType: number): Promise<{ ok: boolean; size?: number; text?: string; hexHead?: string; error?: string }> {
    await this.ensureConnected();
    try {
      const buf = await this.bot!.clientCommands.asset.downloadAsset(assetType, uuid);
      const text = buf.toString('utf-8');
      const hexHead = buf.subarray(0, Math.min(64, buf.length)).toString('hex');
      return { ok: true, size: buf.length, text: text.length > 4000 ? text.slice(0, 4000) + '...' : text, hexHead };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /** Try to download an asset by UUID and type. Returns size or error. For materials, also parses and returns PBR data. */
  async testAssetDownload(uuid: string, type: 'texture' | 'material'): Promise<{ ok: boolean; size?: number; error?: string; parsed?: any }> {
    await this.ensureConnected();
    const assetType = type === 'material' ? AssetType.Material : AssetType.Texture;
    try {
      const buf = await this.bot!.clientCommands.asset.downloadAsset(assetType, uuid);
      const result: any = { ok: true, size: buf?.length ?? 0 };
      if (type === 'material' && buf && buf.length >= 20) {
        try {
          const { LLGLTFMaterial } = await import('../../electron-ui/node-metaverse/dist/lib/classes/LLGLTFMaterial.js');
          const { LLGLTFMaterialOverride } = await import('../../electron-ui/node-metaverse/dist/lib/classes/LLGLTFMaterialOverride.js');
          const gltfMat = new LLGLTFMaterial(buf);
          result.rawGltf = gltfMat.data;
          if (gltfMat.data) {
            const override = LLGLTFMaterialOverride.fromFullMaterialJSON(JSON.stringify(gltfMat.data));
            result.parsed = {
              textures: override.textures,
              baseColor: override.baseColor,
              metallicFactor: override.metallicFactor,
              roughnessFactor: override.roughnessFactor,
              emissiveFactor: override.emissiveFactor,
              alphaMode: override.alphaMode,
              alphaCutoff: override.alphaCutoff,
              doubleSided: override.doubleSided,
            };
          }
        } catch (parseErr: any) {
          result.parseError = parseErr?.message || String(parseErr);
        }
      }
      return result;
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /** Attach an inventory item to HUD, dump all its data, save GLB if mesh, then detach. */
  async testAttachAndDump(itemId: string): Promise<string> {
    await this.ensureConnected();
    const lines: string[] = [];
    try {
      const { UUID } = await import('../../electron-ui/node-metaverse/dist/lib/classes/UUID.js');
      const { AttachmentPoint } = await import('../../electron-ui/node-metaverse/dist/lib/enums/AttachmentPoint.js');
      const { AssetType } = await import('../../electron-ui/node-metaverse/dist/lib/enums/AssetType.js');
      const { SculptType } = await import('../../electron-ui/node-metaverse/dist/lib/enums/SculptType.js');

      // Fetch the inventory item
      const item = await this.bot!.agent.inventory.fetchInventoryItem(new UUID(itemId));
      if (!item) return 'Item not found';
      const originalFlags = item.flags;
      lines.push(`Item: ${item.name} (type=${item.type})`);
      lines.push(`Original flags: 0x${originalFlags.toString(16)} (attach point: ${originalFlags & 0xff})`);

      // Attach to HUD
      lines.push('Attaching to HUD Center 2...');
      const rootObj = await item.attachToAvatar(AttachmentPoint.HUDCenter2, 15000);
      lines.push(`Attached! LocalID=${rootObj.ID}, FullID=${rootObj.FullID}`);

      // Wait for children
      await new Promise(r => setTimeout(r, 2000));

      // Populate children
      this.bot!.currentRegion.objects.populateChildren(rootObj);
      const children = rootObj.children || [];
      lines.push(`Children: ${children.length}`);

      // Dump root prim data
      const dumpPrim = (obj: any, label: string) => {
        lines.push(`\n--- ${label} ---`);
        lines.push(`  Name: ${obj.name}`);
        lines.push(`  Scale: ${obj.Scale ? `(${obj.Scale.x.toFixed(3)}, ${obj.Scale.y.toFixed(3)}, ${obj.Scale.z.toFixed(3)})` : 'null'}`);
        lines.push(`  Position: ${obj.Position ? `(${obj.Position.x.toFixed(3)}, ${obj.Position.y.toFixed(3)}, ${obj.Position.z.toFixed(3)})` : 'null'}`);

        // Mesh?
        const md = obj.extraParams?.meshData;
        if (md && md.type === SculptType.Mesh) {
          lines.push(`  MESH: uuid=${md.meshData?.toString()}`);
        }
        // Sculpt?
        const sd = obj.extraParams?.sculptData;
        if (sd) {
          lines.push(`  SCULPT: texture=${sd.texture?.toString()} type=${sd.type}`);
        }
        // Prim shape?
        if (!md && !sd) {
          lines.push(`  PRIM: pathCurve=${obj.PathCurve} profileCurve=${obj.ProfileCurve}`);
        }

        // Textures
        const te = obj.TextureEntry;
        if (te) {
          const defaultTex = te.defaultTexture?.textureID?.toString();
          lines.push(`  DefaultTexture: ${defaultTex || 'none'}`);
          if (te.faces) {
            for (let i = 0; i < te.faces.length; i++) {
              const f = te.faces[i];
              if (f && f.textureID) {
                lines.push(`  Face[${i}]: ${f.textureID.toString()}`);
              }
            }
          }
        } else {
          lines.push(`  TextureEntry: null`);
        }
      };

      dumpPrim(rootObj, 'Root');
      for (let i = 0; i < children.length; i++) {
        dumpPrim(children[i], `Child ${i}`);
      }

      // If root is mesh, download and save GLB
      const md = rootObj.extraParams?.meshData;
      if (md && md.type === SculptType.Mesh) {
        const meshUuid = md.meshData?.toString();
        if (meshUuid) {
          try {
            const { LLMesh } = await import('../../electron-ui/node-metaverse/dist/lib/classes/public/LLMesh.js');
            const { llMeshToGlb, initSkeletonData } = await import('../../electron-ui/dist/main/index.js').catch(() => ({ llMeshToGlb: null, initSkeletonData: null }));

            const meshBuf = await this.bot!.clientCommands.asset.downloadAsset(AssetType.Mesh, meshUuid);
            lines.push(`\nMesh downloaded: ${meshBuf.length} bytes`);

            const llMesh = await LLMesh.from(meshBuf);
            lines.push(`LODs: ${Object.keys(llMesh.lodLevels).join(', ')}`);
            for (const [lod, submeshes] of Object.entries(llMesh.lodLevels)) {
              if (Array.isArray(submeshes)) {
                lines.push(`  ${lod}: ${submeshes.length} submeshes`);
                for (let si = 0; si < submeshes.length; si++) {
                  const s = submeshes[si];
                  lines.push(`    [${si}] verts=${s.position?.length || 0} tris=${(s.triangleList?.length || 0)/3} weights=${s.weights?.length || 0}`);
                }
              }
            }

            // Save raw mesh data for inspection
            const fs = await import('fs');
            fs.writeFileSync('test_dress_mesh.bin', meshBuf);
            lines.push('Saved raw mesh to test_dress_mesh.bin');

          } catch (err: any) {
            lines.push(`Mesh download/parse error: ${err.message}`);
          }
        }
      }

      // Detach
      await item.detachFromAvatar();
      lines.push('\nDetached.');

    } catch (err: any) {
      lines.push(`ERROR: ${err.message}`);
    }
    return lines.join('\n');
  }

  /** Test downloading an object asset from inventory by item ID. */
  async testInventoryObjectDownload(itemId: string): Promise<string> {
    await this.ensureConnected();
    try {
      const { UUID } = await import('../../electron-ui/node-metaverse/dist/lib/classes/UUID.js');
      const buf = await this.bot!.clientCommands.asset.downloadInventoryAsset(
        new UUID(itemId),
        this.bot!.agent.agentID,
        AssetType.Object,
        true,
      );
      const xml = buf.toString('utf8');
      return `Downloaded ${buf.length} bytes:\n${xml.slice(0, 2000)}${xml.length > 2000 ? '...(truncated)' : ''}`;
    } catch (err: any) {
      return `Download failed: ${err?.message || String(err)}`;
    }
  }

  /**
   * Read all child prims of a linkset and return every face's texture offset.
   * Designed for reading game boards (like Minesweeper) where each face on each
   * prim represents a cell, and the UV offset selects which sprite is displayed.
   *
   * Returns an array of { name, localId, faces: [{face, offsetU, offsetV}] }
   * where faces includes ALL faces (explicit + default-inherited).
   */
  async readBoardState(rootLocalId: number): Promise<{
    root: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } };
    cells: Array<{
      name: string;
      localId: number;
      position: { x: number; y: number; z: number };
      faces: Array<{ face: number; offsetU: number; offsetV: number }>;
    }>;
  }> {
    await this.ensureConnected();
    const root = await this.bot!.clientCommands.region.getObjectByLocalID(rootLocalId, true);
    const rootPos = root.Position || { x: 0, y: 0, z: 0 };
    const rootRot = root.Rotation || { x: 0, y: 0, z: 0, w: 1 };
    if (!root.children || root.children.length === 0) {
      return { root: { position: rootPos, rotation: rootRot }, cells: [] };
    }

    const results: Array<{
      name: string;
      localId: number;
      position: { x: number; y: number; z: number };
      faces: Array<{ face: number; offsetU: number; offsetV: number }>;
    }> = [];

    for (const child of root.children) {
      const name = (child as any).name || '(unknown)';
      // Skip non-cell prims (border, reset button, etc)
      if (!name.match(/^\d+-\d+$/)) continue;

      const te = child.TextureEntry;
      if (!te) continue;

      const defaultU = te.defaultTexture?.offsetU ?? 0;
      const defaultV = te.defaultTexture?.offsetV ?? 0;

      // Build complete face list: explicit faces + fill remaining with default
      const faces: Array<{ face: number; offsetU: number; offsetV: number }> = [];
      const explicitCount = te.faces?.length ?? 0;

      for (let i = 0; i < Math.max(explicitCount, 8); i++) {
        const f = te.faces?.[i];
        if (f) {
          faces.push({
            face: i,
            offsetU: f.offsetU ?? defaultU,
            offsetV: f.offsetV ?? defaultV,
          });
        } else if (i < 8) {
          // Fill with default for faces not explicitly listed
          faces.push({ face: i, offsetU: defaultU, offsetV: defaultV });
        }
      }

      const childPos = child.Position || { x: 0, y: 0, z: 0 };
      results.push({ name, localId: child.ID, position: childPos, faces });
    }

    // Sort by name for consistent ordering (1-1, 1-2, 2-1, 2-2, ...)
    results.sort((a, b) => {
      const [aRow, aCol] = a.name.split('-').map(Number);
      const [bRow, bCol] = b.name.split('-').map(Number);
      return aRow - bRow || aCol - bCol;
    });

    return { root: { position: rootPos, rotation: rootRot }, cells: results };
  }

  /**
   * Fetch task inventory (contents) of an in-world object.
   * Must call fetchObjectInventory first to populate obj.inventory.
   */
  async getObjectInventory(localId: number): Promise<Array<{ name: string; type: string; itemId: string; description: string }>> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true);
    await this.bot!.clientCommands.region.fetchObjectInventory(obj);
    return obj.inventory.map(item => ({
      name: item.name,
      type: AssetType[item.type] || `unknown(${item.type})`,
      itemId: item.itemID.toString(),
      description: item.description,
    }));
  }

  async touchObject(localId: number): Promise<void> {
    await this.ensureConnected();
    await this.bot!.clientCommands.region.touchObject(localId);
  }

  /** Delete (derez to trash) an object. Must be owned by the bot. */
  async deleteObject(localId: number): Promise<void> {
    await this.ensureConnected();
    const obj = await this.bot!.clientCommands.region.getObjectByLocalID(localId, true);
    await obj.deRezObject(DeRezDestination.TrashFolder, UUID.zero(), UUID.zero());
  }

  // ============ Internal ============

  private requireConnected(): void {
    if (!this.bot || this._state !== 'connected') {
      throw new Error('Bot is not logged in. Call sl_login first.');
    }
  }

  /**
   * Subscribe to bot events for tracking nearby avatars, friends, groups, and IMs.
   * Called once after login, before connectToSim.
   */
  private setupEventSubscriptions(): void {
    if (!this.bot) return;

    // Track nearby avatars — store with string IDs for easy lookup
    this.bot.clientEvents.onAvatarEnteredRegion.subscribe((avatar) => {
      // avatar.getKey() returns a UUID object — always .toString() for our Maps
      const avatarId = avatar.getKey().toString();
      if (avatarId === this.bot?.agentID().toString()) return;
      const pos = avatar.position;
      this.nearbyAvatars.set(avatarId, {
        id: avatarId,
        name: avatar.getName(),
        position: { x: pos.x, y: pos.y, z: pos.z },
      });

      avatar.onMoved.subscribe(() => {
        const existing = this.nearbyAvatars.get(avatarId);
        if (existing) {
          const p = avatar.position;
          existing.position = { x: p.x, y: p.y, z: p.z };
        }
      });

      avatar.onLeftRegion.subscribe(() => {
        this.nearbyAvatars.delete(avatarId);
      });
    });

    // Log all teleport lifecycle events
    this.bot.clientEvents.onTeleportEvent.subscribe((event) => {
      const agentId = this.bot?.agentID()?.toString() ?? 'unknown';
      switch (event.eventType) {
        case TeleportEventType.TeleportStarted:
          console.log(`[Teleport] Agent ${agentId} TeleportStart (cross-region)`);
          break;
        case TeleportEventType.TeleportProgress:
          console.log(`[Teleport] Agent ${agentId} TeleportProgress: ${event.message}`);
          break;
        case TeleportEventType.TeleportCompleted:
          if (event.simIP === 'local') {
            console.log(`[Teleport] Agent ${agentId} TeleportLocal (same-region) completed`);
          } else {
            console.log(`[Teleport] Agent ${agentId} TeleportFinish: simIP=${event.simIP}:${event.simPort} regionHandle=${event.regionHandle?.toString()}`);
          }
          break;
        case TeleportEventType.TeleportFailed:
          console.error(`[Teleport] Agent ${agentId} TeleportFailed: ${event.message}`);
          break;
      }
    });

    // Track friend online status
    this.bot.clientEvents.onFriendOnline.subscribe((event) => {
      const friendId = event.friend.getKey().toString();
      const friend = this.friends.get(friendId);
      if (friend) friend.online = event.online;
    });

    // Track groups — arrives via AgentGroupDataUpdate event after login
    this.bot.clientEvents.onAgentGroupDataUpdate.subscribe((event) => {
      this.groups.clear();
      for (const g of event.groups) {
        // groupID is a UUID object — .toString() for our string-keyed Map
        this.groups.set(g.groupID.toString(), {
          id: g.groupID.toString(),
          name: g.groupName,
        });
      }
    });

    // Collect nearby chat (ring buffer of last N messages)
    this.bot.clientEvents.onNearbyChat.subscribe((event) => {
      // Skip our own messages
      if (event.from.toString() === this.bot?.agentID().toString()) return;
      // Only collect agent chat (not objects/system)
      if (event.sourceType !== ChatSourceType.Agent) return;
      // Skip typing indicators
      if (event.chatType === ChatType.StartTyping || event.chatType === ChatType.StopTyping) return;
      const chatTypeNames: Record<number, string> = {
        [ChatType.Whisper]: 'whisper',
        [ChatType.Normal]: 'normal',
        [ChatType.Shout]: 'shout',
      };
      this.recentChat.push({
        fromName: event.fromName,
        fromId: event.from.toString(),
        message: event.message,
        chatType: chatTypeNames[event.chatType] || 'unknown',
        timestamp: Date.now(),
      });
      if (this.recentChat.length > this.maxRecentChat) {
        this.recentChat.shift();
      }
    });

    // Handle disconnect (e.g. kicked by another client logging in)
    this.bot.clientEvents.onDisconnected.subscribe((event) => {
      console.error(`[BotManager] Disconnected: ${event.message} (requested=${event.requested})`);
      if (this.cameraInterval) {
        clearInterval(this.cameraInterval);
        this.cameraInterval = null;
      }
      if (!event.requested) {
        this._kickedMessage = event.message || 'Connection lost';
      }
      this.bot = null;
      this.friends.clear();
      this.groups.clear();
      this.nearbyAvatars.clear();
      this._state = 'disconnected';
    });

    // Collect incoming IMs (ring buffer of last N messages)
    this.bot.clientEvents.onInstantMessage.subscribe((event) => {
      // Skip typing indicators
      if (event.flags & InstantMessageEventFlags.startTyping ||
        event.flags & InstantMessageEventFlags.finishTyping) return;
      this.recentIMs.push({
        fromName: event.fromName,
        fromId: event.from.toString(),
        message: event.message,
        timestamp: Date.now(),
      });
      if (this.recentIMs.length > this.maxRecentIMs) {
        this.recentIMs.shift();
      }
    });
  }

  /**
   * Populate friends from the login response buddy list.
   * Names are resolved asynchronously in the background.
   */
  private populateFriendsFromLogin(): void {
    if (!this.bot) return;
    for (const buddy of this.bot.agent.buddyList) {
      // buddyID is a UUID object
      const friendId = buddy.buddyID.toString();
      this.friends.set(friendId, {
        id: friendId,
        name: '', // resolved async below
        online: false,
      });
      // Resolve legacy name in background
      this.bot.clientCommands.grid.avatarKey2Name(new UUID(friendId))
        .then((result) => {
          const info = Array.isArray(result) ? result[0] : result;
          const friend = this.friends.get(friendId);
          if (friend && info) friend.name = info.getName();
        })
        .catch(() => { });
    }
  }
}
