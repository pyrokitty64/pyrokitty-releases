/**
 * VoiceManager - manages the C# voice sidecar child process.
 *
 * Spawns VoiceSidecar.exe, sends JSON commands over stdin,
 * receives JSON events from stdout.
 *
 * Coordinates voice caps from either:
 * - node-metaverse (bot.currentRegion.caps) during metaverse phase
 * - Firestorm viewer (PKVoiceEventAPI) during viewer phase
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { pkDebug } from '../pk-debug';
import { EventEmitter } from 'events';
import { ViewerConnection } from '../network/viewer-connection';

export interface VoiceEvent {
  event: string;
  [key: string]: unknown;
}

export interface VoiceCaps {
  ProvisionVoiceAccountRequest?: string;
  VoiceSignalingRequest?: string;
  ParcelVoiceInfoRequest?: string;
}

function getSidecarPath(): string {
  const bin = process.platform === 'win32' ? 'VoiceSidecar.exe' : 'VoiceSidecar';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'voice', bin);
  } else {
    const appRoot = app.getAppPath();
    // dotnet build defaults to Debug; dotnet publish uses Release
    const releasePath = path.join(appRoot, 'voice', 'bin', 'Release', 'net8.0', bin);
    const debugPath = path.join(appRoot, 'voice', 'bin', 'Debug', 'net8.0', bin);
    try {
      fs.accessSync(releasePath);
      return releasePath;
    } catch {
      return debugPath;
    }
  }
}

export class VoiceManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private connected = false;
  private lineBuffer = '';
  private positionInterval: NodeJS.Timeout | null = null;
  private viewerPositionUnsubscribed = false;
  private readonly tag: string;

  constructor(public readonly instanceId: string) {
    super();
    this.tag = `[Voice:${instanceId}]`;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get isRunning(): boolean {
    return this.process != null;
  }

  /**
   * Start the sidecar process.
   */
  start(): void {
    if (this.process) return;

    const sidecarPath = getSidecarPath();
    console.log(`${this.tag} Starting sidecar: ${sidecarPath}`);

    try {
      this.process = spawn(sidecarPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleStdoutData(data.toString());
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        // Sidecar logs go to stderr
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            console.log(`[VoiceSidecar:${this.instanceId}] ${line.trimEnd()}`);
          }
        }
      });

      this.process.on('error', (error) => {
        console.error(`${this.tag} Sidecar error:`, error);
        this.emit('voiceError', error.message);
      });

      this.process.on('exit', (code, signal) => {
        console.log(`${this.tag} Sidecar exited: code=${code}, signal=${signal}`);
        this.process = null;
        this.connected = false;
        this.emit('stopped');
      });
    } catch (error) {
      console.error(`${this.tag} Failed to start sidecar:`, error);
      this.process = null;
    }
  }

  /**
   * Stop the sidecar process.
   */
  stop(): void {
    this.stopPositionUpdates();
    if (this.process) {
      this.sendCommand({ cmd: 'disconnect' });
      setTimeout(() => {
        if (this.process) {
          this.process.kill();
          this.process = null;
        }
      }, 2000);
    }
    this.connected = false;
  }

  /**
   * Connect voice using caps from node-metaverse bot.
   */
  async connectWithBot(bot: any): Promise<void> {
    if (!this.process) this.start();

    const region = bot.currentRegion;
    if (!region?.caps) {
      console.warn(`${this.tag} No caps available from bot`);
      return;
    }

    const caps: VoiceCaps = {};
    try {
      caps.ProvisionVoiceAccountRequest = await region.caps.getCapability('ProvisionVoiceAccountRequest');
    } catch { /* cap not available */ }
    try {
      caps.VoiceSignalingRequest = await region.caps.getCapability('VoiceSignalingRequest');
    } catch { /* cap not available */ }
    try {
      caps.ParcelVoiceInfoRequest = await region.caps.getCapability('ParcelVoiceInfoRequest');
    } catch { /* cap not available */ }

    if (!caps.ProvisionVoiceAccountRequest) {
      console.warn(`${this.tag} ProvisionVoiceAccountRequest cap not available`);
      return;
    }

    const agentId = bot.agent?.agentID?.toString?.() || '';
    const sessionId = bot.agent?.sessionID?.toString?.() || '';
    const regionName = region.regionName || '';

    // Get bot position — try agents map first (more reliable), then localPosition
    const pos = this.getBotPosition(bot, agentId);

    // If position isn't available yet, wait for it (parcel map + position needed for correct parcel ID)
    if (!pos || (pos.x === 0 && pos.y === 0)) {
      pkDebug('voice', `${this.tag} Position not available yet, waiting...`);
      const resolvedPos = await this.waitForBotPosition(bot, agentId, 10, 500);
      if (resolvedPos) {
        await this.doConnectWithBot(bot, caps, agentId, sessionId, regionName, resolvedPos);
      } else {
        console.warn(`${this.tag} Position never became available, connecting with parcelLocalId=-1`);
        await this.doConnectWithBot(bot, caps, agentId, sessionId, regionName, null);
      }
    } else {
      await this.doConnectWithBot(bot, caps, agentId, sessionId, regionName, pos);
    }
  }

  private getBotPosition(bot: any, agentId: string): { x: number; y: number; z: number } | null {
    try {
      const self = bot.currentRegion?.agents?.get(agentId);
      if (self?.position && (self.position.x !== 0 || self.position.y !== 0)) {
        return self.position;
      }
    } catch {
      // bot.currentRegion getter throws after logout
    }
    return null;
  }

  private waitForBotPosition(bot: any, agentId: string, maxRetries: number, intervalMs: number): Promise<{ x: number; y: number; z: number } | null> {
    return new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        const pos = this.getBotPosition(bot, agentId);
        if (pos) {
          pkDebug('voice', `${this.tag} Position available after ${attempts} attempts: (${pos.x?.toFixed(0)},${pos.y?.toFixed(0)})`);
          resolve(pos);
        } else if (attempts >= maxRetries) {
          console.warn(`${this.tag} Position still unavailable after ${attempts} attempts`);
          resolve(null);
        } else {
          setTimeout(check, intervalMs);
        }
      };
      setTimeout(check, intervalMs);
    });
  }

  private async doConnectWithBot(
    bot: any,
    caps: VoiceCaps,
    agentId: string,
    sessionId: string,
    regionName: string,
    pos: { x: number; y: number; z: number } | null,
  ): Promise<void> {
    const region = bot.currentRegion;

    // Get parcel local ID from position, checking UseEstateVoiceChan flag
    let parcelLocalId = -1;
    try {
      if (pos && region?.parcelMap) {
        const px = Math.floor(pos.x / 4);
        const py = Math.floor(pos.y / 4);
        if (py >= 0 && py < 64 && px >= 0 && px < 64) {
          const pid = region.parcelMap[py]?.[px];
          if (pid !== undefined && pid > 0) {
            const parcel = region.parcels?.[pid];
            const flags = parcel?.ParcelFlags ?? 0;
            const allowVoice = !!(flags & (1 << 29));       // AllowVoiceChat
            const useEstate = !!(flags & (1 << 30));        // UseEstateVoiceChan
            pkDebug('voice', `${this.tag} Parcel "${parcel?.Name}" localID=${pid}, allowVoice=${allowVoice}, useEstate=${useEstate}`);
            if (!allowVoice) {
              console.warn(`${this.tag} Voice disabled on this parcel`);
            }
            parcelLocalId = useEstate ? -1 : pid;
          }
        }
      }
      pkDebug('voice', `${this.tag} Parcel local ID: ${parcelLocalId} (pos=${pos?.x?.toFixed(0) ?? 'N/A'},${pos?.y?.toFixed(0) ?? 'N/A'})`);
    } catch (e) {
      console.warn(`${this.tag} Failed to get parcel local ID:`, e);
    }

    // Convert to global coordinates (region grid position * 256 + local offset)
    // LibreMetaverse uses Client.Self.GlobalPosition; we compute the same from region coords
    const regionOffsetX = (region?.xCoordinate ?? 0) * 256;
    const regionOffsetY = (region?.yCoordinate ?? 0) * 256;
    const globalPos = pos ? [
      regionOffsetX + (pos.x || 0),
      regionOffsetY + (pos.y || 0),
      pos.z || 0,
    ] : undefined;

    pkDebug('voice', `${this.tag} Region offset: (${regionOffsetX},${regionOffsetY}), global pos: ${globalPos ? `(${globalPos[0].toFixed(0)},${globalPos[1].toFixed(0)},${globalPos[2].toFixed(0)})` : 'N/A'}`);

    this.sendCommand({
      cmd: 'connect',
      caps,
      agentId,
      sessionId,
      regionName,
      parcelLocalId,
      position: globalPos,
    });

    // Start position updates from bot
    this.startBotPositionUpdates(bot, regionOffsetX, regionOffsetY);
  }

  /**
   * Switch to voice caps from viewer (PKVoiceEventAPI).
   */
  async connectWithViewer(viewerConnection: ViewerConnection): Promise<void> {
    if (!this.process) this.start();

    // Stop bot position updates
    this.stopPositionUpdates();

    try {
      // Get caps from viewer
      const capsResponse = await viewerConnection.request('VoiceAPI', { op: 'getCaps' });

      if (!capsResponse?.caps?.ProvisionVoiceAccountRequest) {
        console.warn(`${this.tag} Viewer does not have voice caps`);
        return;
      }

      this.sendCommand({
        cmd: 'connect',
        caps: capsResponse.caps,
        agentId: capsResponse.agentId,
        sessionId: capsResponse.sessionId,
        regionName: capsResponse.regionName,
        parcelLocalId: capsResponse.parcelLocalId ?? -1,
        position: capsResponse.position,
        rotation: capsResponse.rotation,
      });

      // Subscribe to position updates from viewer
      this.viewerPositionUnsubscribed = false;
      await viewerConnection.request('VoiceAPI', {
        op: 'subscribePosition',
        reply: viewerConnection.replyPumpName,
        interval: 0.1,
      });

      // Listen for position updates from viewer
      viewerConnection.on('message', this.handleViewerMessage);

    } catch (error) {
      console.error(`${this.tag} Failed to connect with viewer:`, error);
    }
  }

  /**
   * Disconnect voice (e.g., when session ends).
   */
  disconnect(): void {
    this.stopPositionUpdates();
    if (this.process) {
      this.sendCommand({ cmd: 'disconnect' });
    }
    this.connected = false;
  }

  /**
   * Remove viewer message listener (call when viewer disconnects).
   */
  detachFromViewer(viewerConnection: ViewerConnection): void {
    viewerConnection.off('message', this.handleViewerMessage);
    this.viewerPositionUnsubscribed = true;
  }

  // ── Audio controls ─────────────────────────────────────

  setMicMute(muted: boolean): void {
    this.sendCommand({ cmd: 'setMicMute', muted });
  }

  setVolume(volume: number): void {
    this.sendCommand({ cmd: 'setVolume', volume: Math.max(0, Math.min(1, volume)) });
  }

  playFile(filePath: string, loop = false): void {
    this.sendCommand({ cmd: 'playFile', path: filePath, loop });
  }

  stopFile(): void {
    this.sendCommand({ cmd: 'stopFile' });
  }

  listAudioDevices(): void {
    this.sendCommand({ cmd: 'listAudioDevices' });
  }

  setInputDevice(deviceName: string): void {
    this.sendCommand({ cmd: 'setInputDevice', deviceName });
  }

  setOutputDevice(deviceName: string): void {
    this.sendCommand({ cmd: 'setOutputDevice', deviceName });
  }

  // ── Internal ───────────────────────────────────────────

  private sendCommand(cmd: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      console.warn(`${this.tag} Cannot send command — sidecar not running`);
      return;
    }
    const line = JSON.stringify(cmd) + '\n';
    this.process.stdin.write(line);
  }

  private handleStdoutData(data: string): void {
    this.lineBuffer += data;
    const lines = this.lineBuffer.split('\n');
    // Keep incomplete last line in buffer
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as VoiceEvent;
        this.handleEvent(event);
      } catch {
        console.warn(`${this.tag} Failed to parse event: ${line}`);
      }
    }
  }

  private handleEvent(event: VoiceEvent): void {
    pkDebug('voice', `${this.tag} Event: ${event.event} ${JSON.stringify(event)}`);

    switch (event.event) {
      case 'ready':
        console.log(`${this.tag} Sidecar ready`);
        this.emit('ready');
        break;
      case 'connected':
        this.connected = true;
        this.emit('connected', event.channel);
        break;
      case 'disconnected':
        this.connected = false;
        this.emit('disconnected', event.reason);
        break;
      case 'participantJoined':
        this.emit('participantJoined', event.agentId);
        break;
      case 'participantLeft':
        this.emit('participantLeft', event.agentId);
        break;
      case 'participantSpeaking':
        this.emit('participantSpeaking', event.agentId, event.power);
        break;
      case 'micLevel':
        this.emit('micLevel', event.level);
        break;
      case 'audioDevices':
        this.emit('audioDevices', event.inputs, event.outputs);
        break;
      case 'error':
        console.error(`${this.tag} Sidecar error: ${event.message}`);
        this.emit('voiceError', event.message);
        break;
      default:
        this.emit('event', event);
    }
  }

  private _posLogCount = 0;
  private startBotPositionUpdates(bot: any, regionOffsetX = 0, regionOffsetY = 0): void {
    this.stopPositionUpdates();
    this._posLogCount = 0;

    this.positionInterval = setInterval(() => {
      try {
        if (!this.process || !bot?.currentRegion) return;

        const agentId = bot.agentID?.()?.toString?.();
        if (!agentId) return;

        const self = bot.currentRegion.agents?.get(agentId);
        if (!self) return;

        const pos = self.position;
        const rot = self.rotation;
        const regionName = bot.currentRegion?.regionName || '';

        if (this._posLogCount < 3) {
          const gx = regionOffsetX + (pos?.x || 0);
          const gy = regionOffsetY + (pos?.y || 0);
          pkDebug('voice', `${this.tag} Position: local=(${pos?.x?.toFixed(1)},${pos?.y?.toFixed(1)},${pos?.z?.toFixed(1)}), global=(${gx.toFixed(0)},${gy.toFixed(0)}), region=${regionName}`);
          this._posLogCount++;
        }

        if (pos && (pos.x !== 0 || pos.y !== 0)) {
          // Get parcel local ID from position, respecting UseEstateVoiceChan flag
          let parcelLocalId = -1;
          try {
            const region = bot.currentRegion;
            if (region?.parcelMap) {
              const px = Math.floor(pos.x / 4);
              const py = Math.floor(pos.y / 4);
              if (py >= 0 && py < 64 && px >= 0 && px < 64) {
                const pid = region.parcelMap[py]?.[px];
                if (pid !== undefined && pid > 0) {
                  const parcel = region.parcels?.[pid];
                  const flags = parcel?.ParcelFlags ?? 0;
                  const useEstate = !!(flags & (1 << 30));
                  parcelLocalId = useEstate ? -1 : pid;
                }
              }
            }
          } catch { /* ignore */ }

          // Send global coordinates (region origin + local offset) to match LibreMetaverse behavior
          this.sendCommand({
            cmd: 'updatePosition',
            position: [
              regionOffsetX + (pos.x || 0),
              regionOffsetY + (pos.y || 0),
              pos.z || 0,
            ],
            rotation: [rot?.x || 0, rot?.y || 0, rot?.z || 0, rot?.w || 1],
            regionName,
            parcelLocalId,
          });
        }
      } catch {
        // Bot may have been kicked — currentRegion getter throws. Stop polling.
        this.stopPositionUpdates();
      }
    }, 100);
  }

  private stopPositionUpdates(): void {
    if (this.positionInterval) {
      clearInterval(this.positionInterval);
      this.positionInterval = null;
    }
  }

  private handleViewerMessage = (pump: string, data: Record<string, unknown>): void => {
    if (this.viewerPositionUnsubscribed) return;
    if ((data as any)?.type !== 'positionUpdate') return;

    this.sendCommand({
      cmd: 'updatePosition',
      position: data.position,
      rotation: data.rotation,
      regionName: data.regionName,
      parcelLocalId: data.parcelLocalId,
    });
  };
}
