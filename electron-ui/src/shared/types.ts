// Map dot colors — shared between minimap and world map
export const MAP_COLORS = {
  SELF: '#4cff4c',            // green — your account(s)
  NEARBY: '#e94560',          // red — other avatars nearby
  COUNT_DOT: '#ff8a8a',       // lighter red — agent-count population dots
};

// Per-bot colors for multi-account map markers (cycled by index)
export const BOT_COLORS = [
  '#4cff4c',  // green
  '#4cc9f0',  // cyan
  '#f77f00',  // orange
  '#b388ff',  // purple
  '#ffca28',  // yellow
  '#ff6b9d',  // pink
];

// Grid configuration
export interface Grid {
  id: string;
  name: string;
  nick: string;
  loginUri: string;
  helperUri?: string;
  webProfileUrl?: string;
  slurlBase?: string;
}

// Connection states for dual-mode operation
export type ConnectionState =
  | 'disconnected'
  | 'logging_in'
  | 'mfa_pending'
  | 'metaverse_connected'
  | 'handoff_in_progress'
  | 'viewer_connected'
  | 'disconnecting';

// Chat types
export type ChatType = 'nearby' | 'im' | 'group';

export interface ChatMessage {
  id: string;
  type: ChatType;
  message: string;
  fromName: string;
  fromId: string;
  timestamp: number;
  // For nearby chat
  chatType?: 'whisper' | 'normal' | 'shout';
  sourceType?: 'agent' | 'object' | 'system';
  // For IM/group
  sessionId?: string;
  isOutgoing?: boolean;
}

export interface ChatSession {
  id: string;
  type: 'im' | 'group';
  name: string;
  participantId?: string; // For IM sessions
  groupId?: string; // For group sessions
  unreadCount: number;
  lastMessage?: string;
  lastMessageTime?: number;
}

// Persisted session metadata (no runtime state like unreadCount)
export interface SessionMeta {
  id: string;
  type: 'im' | 'group';
  name: string;
  participantId?: string;
  groupId?: string;
}

// Friend types
export interface Friend {
  id: string;
  name: string;
  online: boolean;
  canSeeOnline: boolean;
  canSeeOnMap: boolean;
  canModifyObjects: boolean;
}

// Group types
export interface Group {
  id: string;
  name: string;
  insigniaId?: string;
  contribution?: number;
  powers?: string;
}

// Nearby avatar types
export interface NearbyAvatar {
  id: string;
  name: string;
  distance?: number;
  title?: string;
  position?: { x: number; y: number; z: number };
}

// Region info for mini-map
export interface RegionInfo {
  name: string;
  x: number; // Grid X coordinate
  y: number; // Grid Y coordinate
  mapImageUrl: string;
  agentPosition?: { x: number; y: number; z: number };
}

// Account stored in accounts.json
export interface Account {
  id: string;
  gridId: string;
  firstName: string;
  lastName: string;
  password?: string; // Only saved if user opted in
  mfaHash?: string; // Saved after successful MFA login to skip future prompts
  lastRegion?: string; // Last custom start location used
  startLocationType?: 'last' | 'home' | 'custom'; // Start location preference from login form
}

// Running viewer instance
export interface ViewerInstance {
  id: string;
  accountId: string;
  gridId: string;
  pid: number;
  wsPort: number;
  startTime: number;
  status: ViewerStatus;
  connectionState: ConnectionState;
  regionName?: string; // Set when fully arrived in a region
  godotBridgeActive?: boolean; // True when Godot sidecar is running
  unrealBridgeActive?: boolean; // True when Unreal sidecar is running
  statusMessage?: string; // User-facing message (e.g. crash reason)
}

export type ViewerStatus = 'starting' | 'running' | 'connected' | 'disconnected' | 'crashed';

// Inventory sync progress
export type SyncPhase = 'idle' | 'preparing' | 'downloading' | 'uploading' | 'done' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  current: number;
  total: number;
  currentFile?: string;
  error?: string;
  uploadCost: number; // -1 = unknown, 0 = free, >0 = costs L$
}

// IPC Channel names
export const IPC_CHANNELS = {
  // Grid operations
  GET_GRIDS: 'grids:get',

  // Account operations
  GET_ACCOUNTS: 'accounts:get',
  ADD_ACCOUNT: 'accounts:add',
  UPDATE_ACCOUNT: 'accounts:update',
  REMOVE_ACCOUNT: 'accounts:remove',

  // Viewer operations
  LAUNCH_VIEWER: 'viewer:launch',
  LAUNCH_FIRESTORM_FOR_INSTANCE: 'viewer:launch-firestorm-for-instance',
  LAUNCH_GODOT_VIEWER_FOR_INSTANCE: 'viewer:launch-godot-for-instance',
  LAUNCH_UNREAL_VIEWER_FOR_INSTANCE: 'viewer:launch-unreal-for-instance',
  STOP_VIEWER: 'viewer:stop',
  GET_INSTANCES: 'viewer:instances',
  VIEWER_STATUS_UPDATE: 'viewer:status-update',

  // Chat operations (renderer -> main)
  SEND_NEARBY_CHAT: 'chat:send-nearby',
  SEND_IM: 'chat:send-im',
  SEND_GROUP_IM: 'chat:send-group-im',

  // Chat events (main -> renderer)
  CHAT_MESSAGE: 'chat:message',
  VIEWER_WS_CONNECTED: 'viewer:ws-connected',

  // Friends operations
  GET_FRIENDS: 'friends:get',
  FRIENDS_UPDATE: 'friends:update',
  FRIEND_ONLINE: 'friends:online',

  // Groups operations
  GET_GROUPS: 'groups:get',
  GROUPS_UPDATE: 'groups:update',

  // Nearby avatars
  GET_NEARBY_AVATARS: 'avatars:get-nearby',
  NEARBY_AVATARS_UPDATE: 'avatars:nearby-update',

  // Region info
  GET_REGION_INFO: 'region:get-info',
  REGION_INFO_UPDATE: 'region:info-update',

  // Connection state
  CONNECTION_STATE_UPDATE: 'connection:state-update',

  // Chat sessions
  GET_CHAT_SESSIONS: 'chat:get-sessions',
  CHAT_SESSION_UPDATE: 'chat:session-update',
  START_IM_SESSION: 'chat:start-im',
  START_GROUP_CHAT: 'chat:start-group',
  MARK_SESSION_READ: 'chat:mark-read',

  // Chat log persistence
  LOAD_CHAT_LOG: 'chat-log:load',
  LOAD_ALL_CHAT_LOGS: 'chat-log:load-all',
  LOAD_SESSION_META: 'chat-log:load-session-meta',
  DISMISS_SESSION: 'chat-log:dismiss-session',
  GET_DISMISSED_SESSIONS: 'chat-log:get-dismissed',
  CLEAR_CHAT_LOG: 'chat-log:clear',

  // Inventory sync
  SYNC_START: 'inventory-sync:start',
  SYNC_GET_STATUS: 'inventory-sync:status',
  SYNC_PROGRESS: 'inventory-sync:progress',
  SYNC_OPEN_FOLDER: 'inventory-sync:open-folder',

  // MFA
  MFA_REQUIRED: 'mfa:required',
  MFA_SUBMIT: 'mfa:submit',

  // Context menus
  SHOW_USER_CONTEXT_MENU: 'context-menu:user',
  SHOW_GROUP_CONTEXT_MENU: 'context-menu:group',

  // Navigation
  TELEPORT_LOCAL: 'nav:teleport-local',
  TELEPORT_REGION: 'nav:teleport-region',

  // Voice controls (renderer -> main)
  VOICE_PTT_DOWN: 'voice:ptt-down',
  VOICE_PTT_UP: 'voice:ptt-up',
  VOICE_SET_VOLUME: 'voice:set-volume',
  VOICE_TOGGLE_SPEAKER_MUTE: 'voice:toggle-speaker-mute',

  // Voice state (main -> renderer)
  VOICE_STATE_UPDATE: 'voice:state-update',

  // World sounds
  SOUND_SET_VOLUME: 'sound:set-master-volume',
  SOUND_GET_VOLUME: 'sound:get-master-volume',

  // World map
  MAP_OPEN: 'map:open',
  MAP_3D_OPEN: 'map3d:open',
  MAP_POSITION_UPDATE: 'map:position-update',
  MAP_GET_POSITIONS: 'map:get-positions',
  MAP_SELECTED_ACCOUNT: 'map:selected-account',

  // Landmarks
  GET_LANDMARKS: 'landmarks:get',
} as const;

// IPC Request/Response types
export interface LaunchViewerRequest {
  accountId: string;
  password?: string; // Required if account doesn't have saved password
  startLocation?: string; // 'home', 'last', or 'uri:RegionName&x&y&z'
}

export interface AddAccountRequest {
  gridId: string;
  firstName: string;
  lastName: string;
  password?: string; // Only included if savePassword is true
  savePassword: boolean;
}

// WebSocket protocol types
export interface WSMessage {
  pump: string;
  data: Record<string, unknown>;
}

export interface WSConnectedMessage {
  type: 'connected';
  reply_pump: string;
  apis: Array<{ name: string; desc: string }>;
}

export interface ChatEvent {
  type: 'nearby' | 'im';
  message: string;
  from_name: string;
  from_id: string;
  time?: string;
  // Nearby-specific
  source_type?: number;
  chat_type?: number;
  // IM-specific
  session_id?: string;
  session_type?: string;
}

export interface ViewerAPI {
  name: string;
  desc: string;
}

// Voice state broadcast to renderer
export interface VoiceState {
  instanceId?: string;
  connected: boolean;
  connecting: boolean;
  micMuted: boolean;
  speakerMuted: boolean;
  volume: number;
  micLevel: number;
  participants: string[];
}

// Map marker for world map
export interface MapMarker {
  type: 'account' | 'nearby';
  instanceId?: string; // present on 'account' markers — identifies which bot to teleport
  name: string;
  regionName: string;
  gridX: number;
  gridY: number;
  localX: number;
  localY: number;
  localZ: number;
}

// Landmark info for world map
export interface LandmarkInfo {
  name: string;
  gridX: number;
  gridY: number;
  localX: number;
  localY: number;
  localZ: number;
}

/** Strip " Resident" last name from avatar display names */
export function displayName(name: string): string {
  if (!name) return name;
  return name.endsWith(' Resident') ? name.slice(0, -9) : name;
}
