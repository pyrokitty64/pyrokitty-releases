import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { WSMessage, WSConnectedMessage, ViewerAPI } from '../../shared/types';
import { pkDebug } from '../pk-debug';

export interface ViewerConnectionEvents {
  'connected': (apis: ViewerAPI[]) => void;
  'disconnected': () => void;
  'error': (error: Error) => void;
  'message': (pump: string, data: Record<string, unknown>) => void;
}

/**
 * Manages a WebSocket connection to a single viewer instance.
 */
export class ViewerConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private replyPump: string = '';
  private availableApis: ViewerAPI[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private nextReqId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    public readonly instanceId: string,
    public readonly port: number
  ) {
    super();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get apis(): ViewerAPI[] {
    return this.availableApis;
  }

  get replyPumpName(): string {
    return this.replyPump;
  }

  /**
   * Connect to the viewer's WebSocket server.
   */
  connect(): void {
    if (this.ws) {
      return;
    }

    const url = `ws://127.0.0.1:${this.port}`;
    console.log(`[ViewerConnection ${this.instanceId}] Connecting to ${url}`);

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log(`[ViewerConnection ${this.instanceId}] Connected`);
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', () => {
        console.log(`[ViewerConnection ${this.instanceId}] Disconnected`);
        this.connected = false;
        this.ws = null;
        this.emit('disconnected');
      });

      this.ws.on('error', (error: Error) => {
        console.error(`[ViewerConnection ${this.instanceId}] Error:`, error.message);
        this.emit('error', error);
      });
    } catch (error) {
      console.error(`[ViewerConnection ${this.instanceId}] Failed to connect:`, error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Disconnect from the viewer.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [_reqid, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Send a message to a pump on the viewer.
   */
  send(pump: string, data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[ViewerConnection ${this.instanceId}] Cannot send - not connected`);
      return;
    }

    const message: WSMessage = { pump, data };
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Subscribe to chat events from the viewer.
   */
  subscribeToChat(events: 'all' | 'nearby' | 'im' = 'all'): void {
    this.send('ChatAPI', {
      op: 'subscribe',
      reply: this.replyPump,
      events,
    });
  }

  /**
   * Send nearby chat message.
   */
  sendNearbyChat(message: string, type: 'whisper' | 'normal' | 'shout' = 'normal', channel = 0): void {
    this.send('ChatAPI', {
      op: 'sendNearby',
      message,
      type,
      channel,
    });
  }

  /**
   * Send an instant message.
   */
  sendIM(participantId: string, message: string): void {
    this.send('ChatAPI', {
      op: 'sendIM',
      participant_id: participantId,
      message,
    });
  }

  /**
   * Send a group IM.
   */
  sendGroupIM(groupId: string, message: string): void {
    this.send('ChatAPI', {
      op: 'sendIM',
      group_id: groupId,
      message,
    });
  }

  /**
   * Show or hide native chat UI in the viewer.
   */
  setChatVisible(visible: boolean): void {
    this.send('ChatAPI', {
      op: 'setVisible',
      visible,
    });
  }

  /**
   * Request the viewer to quit gracefully (saves settings, logs out).
   */
  requestQuit(): void {
    this.send('ChatAPI', {
      op: 'requestQuit',
    });
  }

  /**
   * Get map data (region info, agent position, nearby avatars) from the viewer.
   */
  async getMapData(): Promise<{
    region_name: string;
    grid_x: number;
    grid_y: number;
    agent_x: number;
    agent_y: number;
    agent_z: number;
    nearby: Array<{
      id: string;
      name: string;
      region_name: string;
      grid_x: number;
      grid_y: number;
      local_x: number;
      local_y: number;
      local_z: number;
    }>;
  }> {
    return this.request('ChatAPI', { op: 'getMapData' }, 5000);
  }

  /**
   * Send a request and wait for a response matched by reqid.
   */
  request(pump: string, data: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }

      const reqid = this.nextReqId++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqid);
        reject(new Error(`Request to ${pump} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(reqid, { resolve, reject, timeout });
      this.send(pump, { ...data, reply: this.replyPump, reqid });
    });
  }

  private handleMessage(rawData: string): void {
    try {
      const message = JSON.parse(rawData);

      // Handle initial connection message
      if (message.type === 'connected') {
        const connMsg = message as WSConnectedMessage;
        this.replyPump = connMsg.reply_pump;
        this.availableApis = connMsg.apis;
        this.connected = true;
        console.log(`[ViewerConnection ${this.instanceId}] Ready, reply pump: ${this.replyPump}`);
        console.log(`[ViewerConnection ${this.instanceId}] Available APIs:`, this.availableApis.map(a => a.name));
        this.emit('connected', this.availableApis);
        return;
      }

      // Handle pump messages
      if (message.pump && message.data !== undefined) {
        // Check if this is a response to a pending request
        const data = message.data as Record<string, unknown>;
        if (data.reqid != null) {
          const reqid = data.reqid as number;
          const pending = this.pendingRequests.get(reqid);
          if (pending) {
            this.pendingRequests.delete(reqid);
            clearTimeout(pending.timeout);
            if (data.error) {
              pending.reject(new Error(data.error as string));
            } else {
              pending.resolve(data);
            }
            return;
          }
        }

        pkDebug('viewer', `[ViewerConnection ${this.instanceId}] Pump message: ${message.pump} ${JSON.stringify(message.data)}`);
        this.emit('message', message.pump, message.data);
        return;
      }

      console.warn(`[ViewerConnection ${this.instanceId}] Unknown message format:`, message);
    } catch (error) {
      console.error(`[ViewerConnection ${this.instanceId}] Failed to parse message:`, error);
    }
  }
}

/**
 * Manages connections to all viewer instances.
 */
export class ViewerConnectionManager extends EventEmitter {
  private connections: Map<string, ViewerConnection> = new Map();

  /**
   * Create and manage a connection to a viewer instance.
   */
  connect(instanceId: string, port: number): ViewerConnection {
    // Check for existing connection
    let connection = this.connections.get(instanceId);
    if (connection) {
      return connection;
    }

    connection = new ViewerConnection(instanceId, port);
    this.connections.set(instanceId, connection);

    // Forward events
    connection.on('connected', (apis) => {
      this.emit('viewer-connected', instanceId, apis);
    });

    connection.on('disconnected', () => {
      this.emit('viewer-disconnected', instanceId);
    });

    connection.on('message', (pump, data) => {
      this.emit('viewer-message', instanceId, pump, data);
    });

    connection.on('error', (error) => {
      this.emit('viewer-error', instanceId, error);
    });

    return connection;
  }

  /**
   * Get an existing connection.
   */
  getConnection(instanceId: string): ViewerConnection | undefined {
    return this.connections.get(instanceId);
  }

  /**
   * Disconnect and remove a connection.
   */
  disconnect(instanceId: string): void {
    const connection = this.connections.get(instanceId);
    if (connection) {
      connection.disconnect();
      this.connections.delete(instanceId);
    }
  }

  /**
   * Disconnect all connections.
   */
  disconnectAll(): void {
    for (const [instanceId] of this.connections) {
      this.disconnect(instanceId);
    }
  }

  /**
   * Get all active connections.
   */
  getAllConnections(): ViewerConnection[] {
    return Array.from(this.connections.values());
  }
}

export const connectionManager = new ViewerConnectionManager();
