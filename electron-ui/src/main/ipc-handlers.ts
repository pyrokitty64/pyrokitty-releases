import * as path from 'path';
import { app, ipcMain, BrowserWindow, Menu, shell } from 'electron';
import { IPC_CHANNELS, AddAccountRequest, LaunchViewerRequest, ChatMessage, SyncStatus, VoiceState, MapMarker, LandmarkInfo } from '../shared/types';
import { gridManager } from './network/grid-manager';
import { accountManager } from './network/account-manager';
import { viewerManager } from './network/viewer-manager';
import { connectionManager } from './network/viewer-connection';
import { metaverseConnectionManager } from './network/metaverse-connection';
import { Vector3, FolderType, AssetType, UUID as NMUUID } from '../../node-metaverse/dist/lib';
import { chatLogManager } from './ui/chat-log-manager';
// InventorySyncManager replaced by InventoryWalker
import { voiceRegistry } from './voice/voice-registry';
import { getMapWindow } from './ui/map-window';
import { pkDebug } from './pk-debug';
import { InventoryWalker } from './inventory/inventory-walker';

// Track inventory walkers per instance
const inventoryWalkers = new Map<string, InventoryWalker>();

function saveChatMessage(instanceId: string, message: ChatMessage): void {
  const instance = viewerManager.getInstance(instanceId);
  if (!instance) return;
  const accountId = instance.accountId;
  const sessionId = message.type === 'nearby' ? 'nearby' : (message.sessionId || message.fromId);
  if (!sessionId) return;
  chatLogManager.appendMessage(accountId, sessionId, message);
}

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
  // Grid handlers
  ipcMain.handle(IPC_CHANNELS.GET_GRIDS, async () => {
    return gridManager.getAllGrids();
  });

  // Account handlers
  ipcMain.handle(IPC_CHANNELS.GET_ACCOUNTS, async () => {
    return accountManager.getAllAccounts();
  });

  ipcMain.handle(IPC_CHANNELS.ADD_ACCOUNT, async (_, request: AddAccountRequest) => {
    return accountManager.addAccount(
      request.gridId,
      request.firstName,
      request.lastName,
      request.savePassword ? request.password : undefined
    );
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_ACCOUNT, async (_, accountId: string, updates: any) => {
    return accountManager.updateAccount(accountId, updates);
  });

  ipcMain.handle(IPC_CHANNELS.REMOVE_ACCOUNT, async (_, accountId: string) => {
    return accountManager.removeAccount(accountId);
  });

  // Viewer handlers
  ipcMain.handle(IPC_CHANNELS.LAUNCH_VIEWER, async (_, request: LaunchViewerRequest) => {
    return viewerManager.launchViewer(request.accountId, request.password, {
      startLocation: request.startLocation,
    });
  });

  ipcMain.handle(IPC_CHANNELS.STOP_VIEWER, async (_, instanceId: string) => {
    return viewerManager.stopViewer(instanceId);
  });

  ipcMain.handle(IPC_CHANNELS.LAUNCH_FIRESTORM_FOR_INSTANCE, async (_, instanceId: string) => {
    return viewerManager.launchFirestormForInstance(instanceId);
  });

  ipcMain.handle(IPC_CHANNELS.LAUNCH_GODOT_VIEWER_FOR_INSTANCE, async (_, instanceId: string, vrMode = false) => {
    return viewerManager.launchGodotViewerForInstance(instanceId, vrMode);
  });

  // MFA handlers
  ipcMain.handle(IPC_CHANNELS.MFA_SUBMIT, async (_, instanceId: string, token: string, remember: boolean) => {
    return viewerManager.submitMfaToken(instanceId, token, remember);
  });

  ipcMain.handle(IPC_CHANNELS.GET_INSTANCES, async () => {
    return viewerManager.getInstances();
  });

  // Forward viewer status updates to renderer
  viewerManager.on('status-update', (instance) => {
    mainWindow.webContents.send(IPC_CHANNELS.VIEWER_STATUS_UPDATE, instance);
  });

  // Chat handlers - route based on connection state
  async function routeChatSend(
    instanceId: string,
    label: string,
    viewerAction: (conn: any) => void,
    metaverseAction: (meta: any) => Promise<void>,
    echoFields: Partial<ChatMessage>,
    message: string,
  ) {
    const instance = viewerManager.getInstance(instanceId);
    if (instance?.connectionState === 'viewer_connected') {
      const connection = viewerManager.getConnection(instanceId);
      if (!connection?.isConnected) throw new Error('Viewer not connected');
      viewerAction(connection);
      const outMessage: ChatMessage = {
        id: `out_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        message, fromName: 'You', fromId: '', timestamp: Date.now(), isOutgoing: true,
        ...echoFields,
      } as ChatMessage;
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE, { instanceId, ...outMessage });
      saveChatMessage(instanceId, outMessage);
    } else if (instance?.connectionState === 'metaverse_connected') {
      const metaverse = metaverseConnectionManager.get(instanceId);
      if (!metaverse) throw new Error('Metaverse connection not found');
      await metaverseAction(metaverse);
    } else {
      throw new Error(`Cannot send ${label}: connection state is ${instance?.connectionState || 'unknown'}`);
    }
    return true;
  }

  ipcMain.handle(IPC_CHANNELS.SEND_NEARBY_CHAT, async (_, instanceId: string, message: string, type?: string, channel?: number) => {
    const chatType = (type as 'whisper' | 'normal' | 'shout') || 'normal';
    return routeChatSend(instanceId, 'chat',
      (conn) => conn.sendNearbyChat(message, chatType, channel || 0),
      (meta) => meta.sendNearbyChat(message, chatType, channel || 0),
      { type: 'nearby', chatType }, message,
    );
  });

  ipcMain.handle(IPC_CHANNELS.SEND_IM, async (_, instanceId: string, participantId: string, message: string) => {
    return routeChatSend(instanceId, 'IM',
      (conn) => conn.sendIM(participantId, message),
      (meta) => meta.sendIM(participantId, message),
      { type: 'im', sessionId: participantId }, message,
    );
  });

  ipcMain.handle(IPC_CHANNELS.SEND_GROUP_IM, async (_, instanceId: string, groupId: string, message: string) => {
    return routeChatSend(instanceId, 'group message',
      (conn) => conn.sendGroupIM(groupId, message),
      (meta) => meta.sendGroupMessage(groupId, message),
      { type: 'group', sessionId: groupId }, message,
    );
  });

  // Friends handlers
  ipcMain.handle(IPC_CHANNELS.GET_FRIENDS, async (_, instanceId: string) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      return [];
    }
    try {
      return metaverse.getFriends();
    } catch {
      return [];
    }
  });

  // Groups handlers
  ipcMain.handle(IPC_CHANNELS.GET_GROUPS, async (_, instanceId: string) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      return [];
    }
    try {
      return metaverse.getGroups();
    } catch {
      return [];
    }
  });

  // Nearby avatars handlers
  ipcMain.handle(IPC_CHANNELS.GET_NEARBY_AVATARS, async (_, instanceId: string) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      return [];
    }
    try {
      return metaverse.getNearbyAvatars();
    } catch {
      return [];
    }
  });

  // Region info handler
  ipcMain.handle(IPC_CHANNELS.GET_REGION_INFO, async (_, instanceId: string) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      return null;
    }
    try {
      return metaverse.getRegionInfo();
    } catch {
      // Bot may be disconnected (viewer took over)
      return null;
    }
  });

  // Teleport to local coordinates (within current region)
  ipcMain.handle(IPC_CHANNELS.TELEPORT_LOCAL, async (_, instanceId: string, x: number, y: number, z: number = 30) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) return { error: 'Not connected' };
    const bot = metaverse.getBot();
    if (!bot) return { error: 'Not connected' };
    try {
      const regionName = bot.currentRegion?.regionName;
      if (!regionName) return { error: 'No region' };
      const pos = new Vector3([x, y, z]);
      const lookAt = new Vector3([0, 1, 0]);
      await bot.clientCommands.teleport.teleportTo(regionName, pos, lookAt);
      return { ok: true };
    } catch (err: any) {
      console.error('[Teleport] Failed:', err.message);
      return { error: err.message };
    }
  });

  // Teleport to region by grid coordinates (cross-region)
  // teleportToRegionCoordinates expects global coords (grid * 256).
  // Callers pass grid coords (e.g. 1007, 1194). Detect and convert.
  ipcMain.handle(IPC_CHANNELS.TELEPORT_REGION, async (_, instanceId: string | null, gridX: number, gridY: number, x: number, y: number, z: number) => {
    let bot: any = null;
    if (instanceId) {
      const metaverse = metaverseConnectionManager.get(instanceId);
      if (metaverse) bot = metaverse.getBot();
    }
    // Fallback: pick first connected instance
    if (!bot) {
      const instances = viewerManager.getInstances();
      for (const inst of instances) {
        if (inst.connectionState !== 'metaverse_connected' && inst.connectionState !== 'viewer_connected') continue;
        const metaverse = metaverseConnectionManager.get(inst.id);
        if (!metaverse) continue;
        bot = metaverse.getBot();
        if (bot) break;
      }
    }
    if (!bot) return { error: 'Not connected — no active metaverse instance found' };
    try {
      // Detect coordinate type: values < 256 are invalid (no SL regions at grid 0,0),
      // values 256..65535 are grid coords, values >= 65536 (256*256) are already global
      let globalX: number, globalY: number;
      if (gridX < 256 || gridY < 256) {
        return { error: `Invalid region coordinates (${gridX}, ${gridY}) — too small to be grid or global coords` };
      } else if (gridX < 65536 && gridY < 65536) {
        // Grid coords — multiply to get global
        globalX = gridX * 256;
        globalY = gridY * 256;
        console.log(`[Teleport] Grid coords (${gridX},${gridY}) → global (${globalX},${globalY}), local=(${x},${y},${z})`);
      } else {
        // Already global coords
        globalX = gridX;
        globalY = gridY;
        console.log(`[Teleport] Global coords (${globalX},${globalY}), local=(${x},${y},${z})`);
      }
      const pos = new Vector3([x, y, z]);
      const lookAt = new Vector3([0, 1, 0]);
      await bot.clientCommands.teleport.teleportToRegionCoordinates(globalX, globalY, pos, lookAt);
      return { ok: true };
    } catch (err: any) {
      const msg = err.teleportEvent?.message || err.message || 'Unknown error';
      console.error(`[Teleport] Region teleport failed: input=(${gridX},${gridY}) local=(${x},${y},${z}) error=${msg}`);
      return { error: msg };
    }
  });

  // Chat sessions handlers
  ipcMain.handle(IPC_CHANNELS.GET_CHAT_SESSIONS, async (_, instanceId: string) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      return [];
    }
    try {
      return metaverse.getChatSessions();
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.START_IM_SESSION, async (_, instanceId: string, participantId: string, participantName: string) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      throw new Error('Metaverse connection not found');
    }
    return metaverse.startIMSession(participantId, participantName);
  });

  ipcMain.handle(IPC_CHANNELS.START_GROUP_CHAT, async (_, instanceId: string, groupId: string) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      throw new Error('Metaverse connection not found');
    }
    return metaverse.startGroupChatSession(groupId);
  });

  ipcMain.handle(IPC_CHANNELS.MARK_SESSION_READ, async (_, instanceId: string, sessionId: string) => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (metaverse) {
      metaverse.markSessionRead(sessionId);
    }
  });

  // Chat log persistence handlers
  ipcMain.handle(IPC_CHANNELS.LOAD_CHAT_LOG, async (_, instanceId: string, sessionId: string) => {
    const instance = viewerManager.getInstance(instanceId);
    if (!instance) return [];
    return chatLogManager.loadMessages(instance.accountId, sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.LOAD_ALL_CHAT_LOGS, async (_, instanceId: string) => {
    const instance = viewerManager.getInstance(instanceId);
    if (!instance) return [];
    return chatLogManager.loadAllSessions(instance.accountId);
  });

  ipcMain.handle(IPC_CHANNELS.LOAD_SESSION_META, async (_, instanceId: string) => {
    const instance = viewerManager.getInstance(instanceId);
    if (!instance) return [];
    return chatLogManager.loadAllSessionMeta(instance.accountId);
  });

  // Session dismiss persistence
  ipcMain.handle(IPC_CHANNELS.DISMISS_SESSION, async (_, instanceId: string, sessionId: string) => {
    const instance = viewerManager.getInstance(instanceId);
    if (!instance) return;
    chatLogManager.dismissSession(instance.accountId, sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.GET_DISMISSED_SESSIONS, async (_, instanceId: string) => {
    const instance = viewerManager.getInstance(instanceId);
    if (!instance) return [];
    return chatLogManager.loadDismissedSessions(instance.accountId);
  });

  ipcMain.handle(IPC_CHANNELS.CLEAR_CHAT_LOG, async (_, instanceId: string, sessionId: string) => {
    const instance = viewerManager.getInstance(instanceId);
    if (!instance) return;
    chatLogManager.deleteLog(instance.accountId, sessionId);
  });

  // Inventory sync handlers
  ipcMain.handle(IPC_CHANNELS.SYNC_START, async (_, instanceId: string) => {
    // Abort any existing walker and start a fresh one
    const oldWalker = inventoryWalkers.get(instanceId);
    if (oldWalker) oldWalker.abort();

    const instance = viewerManager.getInstance(instanceId);
    if (!instance) throw new Error('Cannot sync: no instance');
    const metaverse = metaverseConnectionManager.get(instanceId);
    const bot = metaverse?.getBot();
    if (!bot) throw new Error('Cannot sync: not connected');

    const account = accountManager.getAccount(instance.accountId);
    const folderName = account ? `${account.firstName} ${account.lastName}` : instance.accountId;
    const walker = new InventoryWalker(bot, folderName, (progress) => {
      mainWindow.webContents.send(IPC_CHANNELS.SYNC_PROGRESS, instanceId, {
        status: progress.phase === 'done' ? 'idle' : 'syncing',
        message: progress.phase === 'folders'
          ? `Scanning inventory... ${progress.foldersComplete}/${progress.foldersTotal} folders`
          : progress.phase === 'items'
          ? `Syncing items... ${progress.itemsComplete}/${progress.itemsTotal}`
          : 'Inventory sync complete',
      });
    });
    inventoryWalkers.set(instanceId, walker);
    walker.walk().catch(err => console.error('[InventoryWalker] Manual sync error:', err));
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_GET_STATUS, async (_, _instanceId: string) => {
    // Progress comes via SYNC_PROGRESS events from the walker callback
    return { phase: 'idle', current: 0, total: 0, uploadCost: -1 } as SyncStatus;
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_OPEN_FOLDER, async (_, instanceId: string) => {
    const instance = viewerManager.getInstance(instanceId);
    if (!instance) return;
    const account = accountManager.getAccount(instance.accountId);
    const folderName = account ? `${account.firstName} ${account.lastName}` : instance.accountId;
    const dir = path.join(app.getPath('userData'), 'data', 'inventory-sync', folderName);
    shell.openPath(dir);
  });

  // Auto-start sync when metaverse connects
  metaverseConnectionManager.on('state-change', (instanceId: string, state: string) => {
    if (state === 'metaverse_connected') {
      // Small delay to let everything settle
      setTimeout(() => {
        // Check state hasn't changed (e.g. viewer launched and kicked the bot)
        const instance = viewerManager.getInstance(instanceId);
        if (!instance || instance.connectionState !== 'metaverse_connected') {
          console.log(`[IPC] Skipping auto-sync: state is now ${instance?.connectionState ?? 'gone'}`);
          return;
        }
        // Start inventory walker (full inventory mirror to disk)
        const metaverse = metaverseConnectionManager.get(instanceId);
        const bot = metaverse?.getBot();
        if (bot && instance.accountId) {
          // Abort any previous walker for this instance
          const oldWalker = inventoryWalkers.get(instanceId);
          if (oldWalker) oldWalker.abort();

          const account = accountManager.getAccount(instance.accountId);
          const folderName = account ? `${account.firstName} ${account.lastName}` : instance.accountId;
          const walker = new InventoryWalker(bot, folderName, (progress) => {
            mainWindow.webContents.send(IPC_CHANNELS.SYNC_PROGRESS, instanceId, {
              status: progress.phase === 'done' ? 'idle' : 'syncing',
              message: progress.phase === 'folders'
                ? `Scanning inventory... ${progress.foldersComplete}/${progress.foldersTotal} folders`
                : progress.phase === 'items'
                ? `Syncing items... ${progress.itemsComplete}/${progress.itemsTotal}`
                : 'Inventory sync complete',
            });
          });
          inventoryWalkers.set(instanceId, walker);
          walker.walk().catch(err => console.error('[InventoryWalker] Error:', err));
        }
      }, 2000);
    } else if (state === 'disconnected' || state === 'logging_in' || state === 'viewer_connected') {
      // Abort inventory walker
      const oldWalker = inventoryWalkers.get(instanceId);
      if (oldWalker) oldWalker.abort();
      inventoryWalkers.delete(instanceId);
    }
  });

  // Forward WebSocket events to renderer
  connectionManager.on('viewer-connected', (instanceId: string, apis: any[]) => {
    mainWindow.webContents.send(IPC_CHANNELS.VIEWER_WS_CONNECTED, { instanceId, apis });
  });

  connectionManager.on('viewer-message', (instanceId: string, pump: string, data: any) => {
    pkDebug('ipc', `[IPC] viewer-message from ${instanceId}, pump: ${pump}, type: ${data.type}`);
    // Forward chat messages to renderer
    if (data.type === 'nearby' || data.type === 'im') {
      // Skip system messages with no sender (e.g. "is online." / "is offline." friend notifications)
      if (data.source_type === 0 && !data.from_name) {
        return;
      }

      // Skip Firestorm LSL Bridge messages
      if (data.from_name && data.from_name.startsWith('#Firestorm LSL Bridge')) {
        return;
      }

      // Cache display name from viewer for cross-reference when node-metaverse reconnects
      if (data.from_id && data.from_name) {
        const metaverse = metaverseConnectionManager.get(instanceId);
        const cache = metaverse?.getDisplayNameCache();
        if (cache && !cache.get(data.from_id)) {
          cache.set(data.from_id, {
            displayName: data.from_name,
            legacyName: data.from_name, // Viewer already resolved; best we have
            username: '',
            isDefault: false,
            fetchedAt: Date.now(),
          });
        }
      }

      // Transform snake_case from viewer to camelCase for renderer
      // For IMs, use from_id as sessionId to match node-metaverse behavior
      const sessionId = data.type === 'im' ? data.from_id : data.session_id;
      const message: ChatMessage = {
        id: `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: data.type,
        message: data.message,
        fromName: data.from_name,
        fromId: data.from_id,
        timestamp: Date.now(),
        chatType: data.chat_type === 0 ? 'whisper' : data.chat_type === 2 ? 'shout' : 'normal',
        sourceType: data.source_type === 0 ? 'system' : data.source_type === 1 ? 'agent' : 'object',
        sessionId,
        isOutgoing: false,
      };
      pkDebug('chat', `[IPC] Forwarding chat message to renderer: ${JSON.stringify(message)}`);
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE, { instanceId, ...message });
      saveChatMessage(instanceId, message);
    }
  });

  // Forward MetaverseConnection events to renderer
  metaverseConnectionManager.on('state-change', (instanceId: string, state: string) => {
    mainWindow.webContents.send(IPC_CHANNELS.CONNECTION_STATE_UPDATE, { instanceId, state });
  });

  metaverseConnectionManager.on('nearby-chat', (instanceId: string, message: ChatMessage) => {
    if (message.fromName?.startsWith('#Firestorm LSL Bridge')) return;
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE, { instanceId, ...message });
    saveChatMessage(instanceId, message);
  });

  metaverseConnectionManager.on('im', (instanceId: string, message: ChatMessage) => {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE, { instanceId, ...message });
    saveChatMessage(instanceId, message);
  });

  metaverseConnectionManager.on('group-chat', (instanceId: string, message: ChatMessage) => {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE, { instanceId, ...message });
    saveChatMessage(instanceId, message);
  });

  metaverseConnectionManager.on('friends-update', (instanceId: string, friends: any[]) => {
    mainWindow.webContents.send(IPC_CHANNELS.FRIENDS_UPDATE, { instanceId, friends });
  });

  metaverseConnectionManager.on('friend-online', (instanceId: string, friend: any, online: boolean) => {
    mainWindow.webContents.send(IPC_CHANNELS.FRIEND_ONLINE, { instanceId, friend, online });
  });

  metaverseConnectionManager.on('groups-update', (instanceId: string, groups: any[]) => {
    mainWindow.webContents.send(IPC_CHANNELS.GROUPS_UPDATE, { instanceId, groups });
  });

  metaverseConnectionManager.on('nearby-avatars-update', (instanceId: string, avatars: any[]) => {
    mainWindow.webContents.send(IPC_CHANNELS.NEARBY_AVATARS_UPDATE, { instanceId, avatars });
  });

  metaverseConnectionManager.on('region-info-update', (instanceId: string, regionInfo: any) => {
    mainWindow.webContents.send(IPC_CHANNELS.REGION_INFO_UPDATE, { instanceId, regionInfo });
    // Also push to map window so world map account marker stays in sync
    const mw = getMapWindow();
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send(IPC_CHANNELS.REGION_INFO_UPDATE, { instanceId, regionInfo });
    }
  });

  metaverseConnectionManager.on('mfa-required', (instanceId: string) => {
    mainWindow.webContents.send(IPC_CHANNELS.MFA_REQUIRED, { instanceId });
  });

  metaverseConnectionManager.on('chat-session-update', (instanceId: string, session: any) => {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_SESSION_UPDATE, { instanceId, session });
    // Persist session metadata for history reconstruction
    const instance = viewerManager.getInstance(instanceId);
    if (instance && session.name) {
      chatLogManager.saveSessionMeta(instance.accountId, session);
    }
  });

  // ── Voice controls ──────────────────────────────────
  // Per-instance voice state; volume/speaker-mute are global
  const voiceStates = new Map<string, VoiceState>();
  let globalVolume = 1.0;
  let globalSpeakerMuted = false;
  let savedVolume = 1.0; // For speaker mute/unmute toggle

  function getOrCreateVoiceState(instanceId: string): VoiceState {
    let state = voiceStates.get(instanceId);
    if (!state) {
      state = {
        instanceId,
        connected: false,
        connecting: false,
        micMuted: true, // PTT mode: mic starts muted
        speakerMuted: globalSpeakerMuted,
        volume: globalVolume,
        micLevel: 0,
        participants: [],
      };
      voiceStates.set(instanceId, state);
    }
    return state;
  }

  function broadcastVoiceState(instanceId: string): void {
    const state = voiceStates.get(instanceId);
    if (state) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_STATE_UPDATE, { ...state });
    }
  }

  // Renderer -> main voice commands
  // PTT routes to the selected instance only
  ipcMain.handle(IPC_CHANNELS.VOICE_PTT_DOWN, async () => {
    const id = voiceRegistry.getSelectedInstanceId();
    const vm = voiceRegistry.getSelected();
    if (!id || !vm) return;
    pkDebug('voice', `[Voice] PTT DOWN (${id})`);
    const state = getOrCreateVoiceState(id);
    if (state.micMuted) {
      state.micMuted = false;
      vm.setMicMute(false);
      broadcastVoiceState(id);
    }
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_PTT_UP, async () => {
    const id = voiceRegistry.getSelectedInstanceId();
    const vm = voiceRegistry.getSelected();
    if (!id || !vm) return;
    pkDebug('voice', `[Voice] PTT UP (${id})`);
    const state = getOrCreateVoiceState(id);
    if (!state.micMuted) {
      state.micMuted = true;
      vm.setMicMute(true);
      broadcastVoiceState(id);
    }
  });

  // Volume is global — applied to all sidecar processes
  ipcMain.handle(IPC_CHANNELS.VOICE_SET_VOLUME, async (_, volume: number) => {
    globalVolume = Math.max(0, Math.min(1, volume));
    globalSpeakerMuted = globalVolume === 0;
    savedVolume = globalVolume > 0 ? globalVolume : savedVolume;
    voiceRegistry.forEach((vm, id) => {
      vm.setVolume(globalVolume);
      const state = getOrCreateVoiceState(id);
      state.volume = globalVolume;
      state.speakerMuted = globalSpeakerMuted;
      broadcastVoiceState(id);
    });
  });

  ipcMain.handle(IPC_CHANNELS.VOICE_TOGGLE_SPEAKER_MUTE, async () => {
    globalSpeakerMuted = !globalSpeakerMuted;
    if (globalSpeakerMuted) {
      savedVolume = globalVolume > 0 ? globalVolume : savedVolume;
      globalVolume = 0;
    } else {
      globalVolume = savedVolume || 0.5;
    }
    voiceRegistry.forEach((vm, id) => {
      vm.setVolume(globalVolume);
      const state = getOrCreateVoiceState(id);
      state.volume = globalVolume;
      state.speakerMuted = globalSpeakerMuted;
      broadcastVoiceState(id);
    });
  });

  // VoiceRegistry events -> renderer (events arrive with instanceId as first arg)
  voiceRegistry.on('connected', (instanceId: string) => {
    const state = getOrCreateVoiceState(instanceId);
    state.connected = true;
    state.connecting = false;
    // Enforce PTT default: mic starts muted
    const vm = voiceRegistry.get(instanceId);
    if (vm) vm.setMicMute(true);
    state.micMuted = true;
    // Apply current global volume
    if (vm) vm.setVolume(globalVolume);
    state.volume = globalVolume;
    state.speakerMuted = globalSpeakerMuted;
    broadcastVoiceState(instanceId);
  });

  voiceRegistry.on('disconnected', (instanceId: string) => {
    const state = getOrCreateVoiceState(instanceId);
    state.connected = false;
    state.connecting = false;
    state.micLevel = 0;
    state.participants = [];
    broadcastVoiceState(instanceId);
    voiceStates.delete(instanceId);
  });

  voiceRegistry.on('ready', (instanceId: string) => {
    const state = getOrCreateVoiceState(instanceId);
    state.connecting = true;
    broadcastVoiceState(instanceId);
  });

  voiceRegistry.on('participantJoined', (instanceId: string, agentId: string) => {
    const state = getOrCreateVoiceState(instanceId);
    if (!state.participants.includes(agentId)) {
      state.participants.push(agentId);
      broadcastVoiceState(instanceId);
    }
  });

  voiceRegistry.on('participantLeft', (instanceId: string, agentId: string) => {
    const state = getOrCreateVoiceState(instanceId);
    state.participants = state.participants.filter(id => id !== agentId);
    broadcastVoiceState(instanceId);
  });

  // micLevel events from sidecar (forwarded through voiceRegistry)
  voiceRegistry.on('micLevel', (instanceId: string, level: number) => {
    const state = getOrCreateVoiceState(instanceId);
    state.micLevel = level;
    mainWindow.webContents.send(IPC_CHANNELS.VOICE_STATE_UPDATE, { ...state });
  });

  // Context menu: right-click on user names
  ipcMain.on(IPC_CHANNELS.SHOW_USER_CONTEXT_MENU, (_event, { userId, userName, x, y }) => {
    const menu = Menu.buildFromTemplate([
      {
        label: `View Profile: ${userName}`,
        click: () => {
          shell.openExternal(`https://world.secondlife.com/resident/${userId}`);
        },
      },
    ]);
    menu.popup({ window: mainWindow, x, y });
  });

  // Context menu: right-click on group names
  ipcMain.on(IPC_CHANNELS.SHOW_GROUP_CONTEXT_MENU, (_event, { groupId, groupName, x, y }) => {
    const menu = Menu.buildFromTemplate([
      {
        label: `View Group Profile: ${groupName}`,
        click: () => {
          shell.openExternal(`https://world.secondlife.com/group/${groupId}`);
        },
      },
    ]);
    menu.popup({ window: mainWindow, x, y });
  });

  // ── Landmarks ──────────────────────────────────────────────

  // Parse SL landmark asset text — extracts region_id and local_pos
  function parseLandmarkAsset(data: Buffer): { regionId: string; localX: number; localY: number; localZ: number } | null {
    const text = data.toString('utf-8');
    const regionMatch = text.match(/region_id\s+([\da-f-]+)/);
    const posMatch = text.match(/local_pos\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)/);
    if (!regionMatch) return null;

    return {
      regionId: regionMatch[1],
      localX: posMatch ? parseFloat(posMatch[1]) : 128,
      localY: posMatch ? parseFloat(posMatch[2]) : 128,
      localZ: posMatch ? parseFloat(posMatch[3]) : 0,
    };
  }

  // Region handle cache: regionId → { gridX, gridY }, 10-min TTL (matches Firestorm)
  const regionHandleCache = new Map<string, { gridX: number; gridY: number; ts: number }>();
  const REGION_CACHE_TTL = 10 * 60 * 1000;

  ipcMain.handle(IPC_CHANNELS.GET_LANDMARKS, async (_, instanceId: string): Promise<LandmarkInfo[]> => {
    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) return [];

    // Bot agent is only available in metaverse_connected state
    const instance = viewerManager.getInstance(instanceId);
    if (instance && instance.connectionState !== 'metaverse_connected') return [];

    const bot = metaverse.getBot();
    if (!bot) return [];

    try {
      const landmarkFolderUUID = bot.agent.inventory.findFolderForType(FolderType.Landmark);
      if (!landmarkFolderUUID || landmarkFolderUUID.isZero()) return [];

      const skeleton = bot.agent.inventory.main.skeleton;
      const landmarkFolder = skeleton.get(landmarkFolderUUID.toString());
      if (!landmarkFolder) return [];

      await landmarkFolder.populate(false);

      // Collect landmark items from folder and all subfolders
      const allFolders = [landmarkFolder, ...landmarkFolder.getChildFoldersRecursive()];
      const landmarkItems: any[] = [];
      for (const folder of allFolders) {
        if (folder !== landmarkFolder) {
          try { await folder.populate(false); } catch { continue; }
        }
        for (const item of folder.items) {
          if (item.type === AssetType.Landmark) {
            landmarkItems.push(item);
          }
        }
      }

      // Download and parse landmark assets in parallel
      const downloadResults = await Promise.allSettled(
        landmarkItems.map(async (item) => {
          const assetData = await bot.clientCommands.asset.downloadAsset(AssetType.Landmark, item.assetID);
          const p = parseLandmarkAsset(assetData);
          if (!p) throw new Error('parse failed');
          return { name: item.name as string, ...p };
        })
      );
      const parsed = downloadResults
        .filter((r): r is PromiseFulfilledResult<{ name: string; regionId: string; localX: number; localY: number; localZ: number }> => r.status === 'fulfilled')
        .map(r => r.value);

      // Resolve unique region_ids to grid coordinates (cached, parallel)
      const now = Date.now();
      const uniqueRegionIds = [...new Set(parsed.map(p => p.regionId))];
      const uncached = uniqueRegionIds.filter(id => {
        const c = regionHandleCache.get(id);
        return !c || (now - c.ts) > REGION_CACHE_TTL;
      });

      const handleResults = await Promise.allSettled(
        uncached.map(async (regionId) => {
          const handle = await bot.clientCommands.region.getRegionHandle(new NMUUID(regionId));
          const gridX = Math.floor((handle.high >>> 0) / 256);
          const gridY = Math.floor((handle.low >>> 0) / 256);
          regionHandleCache.set(regionId, { gridX, gridY, ts: Date.now() });
        })
      );
      for (let i = 0; i < uncached.length; i++) {
        if (handleResults[i].status === 'rejected') {
          console.warn(`[Landmarks] Failed to resolve region ${uncached[i]}`);
        }
      }

      // Build results
      const results: LandmarkInfo[] = [];
      for (const p of parsed) {
        const cached = regionHandleCache.get(p.regionId);
        if (cached) {
          results.push({
            name: p.name,
            gridX: cached.gridX,
            gridY: cached.gridY,
            localX: p.localX,
            localY: p.localY,
            localZ: p.localZ,
          });
        }
      }

      results.sort((a, b) => a.name.localeCompare(b.name));
      return results;
    } catch (err: any) {
      console.error('[Landmarks] Failed to fetch landmarks:', err.message);
      return [];
    }
  });

  // ── World map position updates ───────────────────────────

  function pushNearbyMarkers(
    markers: MapMarker[],
    seen: Set<string>,
    avatars: { id: string; name: string; regionName: string; gridX: number; gridY: number; x: number; y: number; z: number }[],
  ) {
    for (const av of avatars) {
      if (seen.has(av.id)) continue;
      seen.add(av.id);
      markers.push({
        type: 'nearby', name: av.name, regionName: av.regionName,
        gridX: av.gridX, gridY: av.gridY, localX: av.x, localY: av.y, localZ: av.z,
      });
    }
  }

  async function gatherMapPositions(): Promise<MapMarker[]> {
    const markers: MapMarker[] = [];
    const seenAvatarIds = new Set<string>();

    for (const instance of viewerManager.getInstances()) {
      if (instance.connectionState !== 'metaverse_connected' && instance.connectionState !== 'viewer_connected') continue;

      const account = accountManager.getAccount(instance.accountId);
      const accountName = account ? `${account.firstName} ${account.lastName}` : instance.accountId;

      // Try viewer connection first (live data from the running viewer)
      if (instance.connectionState === 'viewer_connected') {
        const viewerConn = viewerManager.getConnection(instance.id);
        if (viewerConn?.isConnected) {
          try {
            const mapData = await viewerConn.getMapData();
            if (mapData.grid_x === 0 && mapData.grid_y === 0) continue;

            markers.push({
              type: 'account', instanceId: instance.id, name: accountName, regionName: mapData.region_name,
              gridX: mapData.grid_x, gridY: mapData.grid_y,
              localX: mapData.agent_x, localY: mapData.agent_y, localZ: mapData.agent_z,
            });

            pushNearbyMarkers(markers, seenAvatarIds, (mapData.nearby || []).map((av: any) => ({
              id: av.id, name: av.name, regionName: av.region_name || mapData.region_name,
              gridX: av.grid_x, gridY: av.grid_y, x: av.local_x, y: av.local_y, z: av.local_z,
            })));
            continue;
          } catch {
            // Viewer didn't respond, fall through to metaverse cache
          }
        }
      }

      // Fall back to metaverse (bot) data
      const metaverse = metaverseConnectionManager.get(instance.id);
      if (!metaverse) continue;
      const regionInfo = metaverse.getRegionInfo();
      if (!regionInfo || (regionInfo.x === 0 && regionInfo.y === 0)) continue;

      markers.push({
        type: 'account', instanceId: instance.id, name: accountName, regionName: regionInfo.name,
        gridX: regionInfo.x, gridY: regionInfo.y,
        localX: regionInfo.agentPosition?.x ?? 128, localY: regionInfo.agentPosition?.y ?? 128, localZ: regionInfo.agentPosition?.z ?? 0,
      });

      try {
        const nearby = metaverse.getNearbyAvatars();
        pushNearbyMarkers(markers, seenAvatarIds, nearby.filter((av: any) => av.position).map((av: any) => ({
          id: av.id, name: av.name, regionName: regionInfo.name,
          gridX: regionInfo.x, gridY: regionInfo.y, x: av.position.x, y: av.position.y, z: av.position.z,
        })));
      } catch { /* bot may be disconnected */ }

      // Add avatars from child agent connections (neighboring regions)
      try {
        const childAvatars = metaverse.getChildAvatars();
        pushNearbyMarkers(markers, seenAvatarIds, childAvatars.map((av: any) => ({
          id: av.id, name: av.name, regionName: av.regionName,
          gridX: av.gridX, gridY: av.gridY, x: av.position.x, y: av.position.y, z: av.position.z,
        })));
      } catch { /* child agents may not be connected */ }
    }

    return markers;
  }

  async function broadcastMapPositions(): Promise<void> {
    const mw = getMapWindow();
    if (!mw || mw.isDestroyed()) return;
    const positions = await gatherMapPositions();
    mw.webContents.send(IPC_CHANNELS.MAP_POSITION_UPDATE, positions);
  }

  // Respond to explicit position request from map window
  ipcMain.handle(IPC_CHANNELS.MAP_GET_POSITIONS, async () => {
    return await gatherMapPositions();
  });

  // Periodically send positions to map window (every 3 seconds)
  setInterval(broadcastMapPositions, 3000);
}
