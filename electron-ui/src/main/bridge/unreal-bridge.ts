/**
 * UnrealBridge — Spawns an Unreal Engine 5 sidecar and streams object/avatar data
 * from node-metaverse over WebSocket.
 *
 * Forked from GodotBridge — same sub-modules, same WebSocket protocol, same message format.
 * Differences:
 *  - Spawns UE5 project in -game mode instead of Godot
 *  - No VR config (UE5 VR would be a separate concern)
 *  - Log prefixes: [UnrealBridge] / [Unreal]
 *  - Window bounds saved as 'unreal' instead of 'godot'
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { app } from 'electron';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Bot } from '../../../node-metaverse/dist/lib';
import { Vector3 } from '../../../node-metaverse/dist/lib/classes/Vector3';
import type { Region } from '../../../node-metaverse/dist/lib/classes/Region';
import { Message } from '../../../node-metaverse/dist/lib/enums/Message';
import { ChatType } from '../../../node-metaverse/dist/lib/enums/ChatType';
import { ChatSourceType } from '../../../node-metaverse/dist/lib/enums/ChatSourceType';
import type { ScriptDialogEvent } from '../../../node-metaverse/dist/lib/events/ScriptDialogEvent';
import type { LureEvent } from '../../../node-metaverse/dist/lib/events/LureEvent';
import type { SceneManager, ViewerAdapter } from '../network/scene-manager';
import { MeshFetchQueue } from '../assets/mesh-fetch-queue';
import { initSkeletonData } from '../assets/mesh-converter';
import { TextureFetchQueue, initTextureCache } from '../assets/texture-fetch-queue';
import { SculptFetchQueue } from '../assets/sculpt-fetch-queue';
import { MaterialFetchQueue } from '../assets/material-fetch-queue';
import { AnimationFetchQueue } from '../assets/animation-fetch-queue';
import { getSavedBounds, saveExternalBounds } from '../ui/window-state-manager';
import { GodotEnvironmentManager } from './godot-environment-manager';
import { GodotUpdateCoalescer } from './godot-update-coalescer';
import { GodotInputHandler } from './godot-input-handler';
import { GodotAnimationManager } from './godot-animation-manager';
import { GodotFaceUpdateBatcher, resolvedToGodotFace, enrichFaceMaterialKey } from './godot-material-pipeline';
import { MaterialResolver } from '../materials/material-resolver';
import { GodotObjectSender } from './godot-object-sender';
import { GodotAvatarManager } from './godot-avatar-manager';
import { ObjectReadinessTracker } from './object-readiness-tracker';
import { isHudAttachment, slPos, slQuat } from './godot-bridge-types';
import { pkDebug } from '../pk-debug';

const UNREAL_WS_PORT_BASE = 9300;
let nextPort = UNREAL_WS_PORT_BASE;

function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number, attempts: number) => {
      if (attempts <= 0) {
        reject(new Error(`No free port found starting from ${startPort}`));
        return;
      }
      const srv = net.createServer();
      srv.once('error', () => tryPort(port + 1, attempts - 1));
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(port));
      });
    };
    tryPort(startPort, 20);
  });
}

function getUnrealProjectRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'unreal-viewer')
    : path.join(__dirname, '..', '..', '..', 'unreal-viewer');
}

function getUnrealEditorPath(): string {
  // UE5.7 at standard Epic install location
  return path.join('C:', 'Program Files', 'Epic Games', 'UE_5.7', 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe');
}

function getUnrealProjectFile(): string {
  return path.join(getUnrealProjectRoot(), 'UnrealViewer.uproject');
}

function getCacheDirBase(): string {
  return path.join(app.getPath('userData'), 'asset-cache');
}

export class UnrealBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private port: number;
  private bot: Bot;
  private subscriptions: { unsubscribe: () => void }[] = [];
  private connected = false;

  // Shared state (passed to sub-modules) — keyed by UUID for multi-region safety
  private trackedObjects = new Set<string>();
  private trackedAvatars = new Set<string>();

  // Sub-modules
  private inputHandler: GodotInputHandler;
  private animationManager: GodotAnimationManager;
  private materialResolver: MaterialResolver;
  private faceUpdateBatcher: GodotFaceUpdateBatcher;
  private objectSender: GodotObjectSender;
  private avatarManager: GodotAvatarManager;

  // Managers (already extracted)
  private sceneManager: SceneManager;
  private environmentMgr: GodotEnvironmentManager | null = null;
  private updateCoalescer: GodotUpdateCoalescer | null = null;

  // Fetch queues (owned by bridge, initialized in connectWebSocket)
  private textureFetchQueue: TextureFetchQueue | null = null;
  private meshFetchQueue: MeshFetchQueue | null = null;
  private sculptFetchQueue: SculptFetchQueue | null = null;
  private materialFetchQueue: MaterialFetchQueue | null = null;
  private animationFetchQueue: AnimationFetchQueue | null = null;
  private readinessTracker: ObjectReadinessTracker | null = null;

  // Asset ready batching
  private sendBuffer: object[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | null = null;

  // Message log
  private msgLogStream: fs.WriteStream | null = null;

  // Stats
  private killSweepTimer: ReturnType<typeof setInterval> | null = null;
  private electronStatsCounter = 0;

  constructor(bot: Bot, sceneManager: SceneManager, options: { objectAnimationBuffer?: Map<string, { animId: string; sequenceId: number }[]>; avatarAnimationBuffer?: Map<string, { animId: string; sequenceId: number }[]>; avatarAppearanceBuffer?: Map<string, string[]>; visualParamBuffer?: Map<string, number[]> } = {}) {
    super();
    this.bot = bot;
    this.sceneManager = sceneManager;
    this.port = 0;

    const send = (msg: object) => this.send(msg);

    // Initialize sub-modules (same as GodotBridge)
    this.inputHandler = new GodotInputHandler(bot, send);
    this.animationManager = new GodotAnimationManager(bot, send, this.trackedAvatars);
    this.faceUpdateBatcher = new GodotFaceUpdateBatcher(send);
    this.materialResolver = new MaterialResolver(bot, this.trackedObjects,
      (objectUuid, faceIndex, material) => {
        const godotFace = resolvedToGodotFace(faceIndex, material);
        const patched = this.readinessTracker?.updatePendingFaces(objectUuid, godotFace);
        if (patched) {
          const newTexIds = new Set<string>();
          if (material.baseColorTexture) newTexIds.add(material.baseColorTexture);
          if (material.normalTexture) newTexIds.add(material.normalTexture);
          if (material.ormTexture) newTexIds.add(material.ormTexture);
          if (material.emissiveTexture) newTexIds.add(material.emissiveTexture);
          if (newTexIds.size > 0) {
            this.readinessTracker!.addTextures(objectUuid, newTexIds);
          }
          return;
        }
        this.faceUpdateBatcher.queueFaceUpdate(objectUuid, [godotFace]);
      },
    );
    this.objectSender = new GodotObjectSender(
      bot, send, this.trackedObjects, this.trackedAvatars,
      this.materialResolver, this.animationManager,
    );
    this.avatarManager = new GodotAvatarManager(
      bot, send, this.trackedObjects, this.trackedAvatars,
      this.animationManager,
    );
    this.avatarManager.setObjectSender(this.objectSender);
    this.objectSender.setAvatarManager(this.avatarManager);
    this.materialResolver.setBakeProvider(this.avatarManager);

    if (options.objectAnimationBuffer) {
      this.animationManager.seedObjectAnimationBuffer(options.objectAnimationBuffer);
    }
    if (options.avatarAnimationBuffer) {
      this.animationManager.seedAvatarAnimationBuffer(options.avatarAnimationBuffer);
    }
    if (options.avatarAppearanceBuffer && options.avatarAppearanceBuffer.size > 0) {
      this.avatarManager.seedBakedTextures(options.avatarAppearanceBuffer);
    }
    if (options.visualParamBuffer && options.visualParamBuffer.size > 0) {
      this.avatarManager.seedVisualParams(options.visualParamBuffer);
    }
  }

  async start(): Promise<void> {
    this.port = await findFreePort(nextPort);
    nextPort = this.port + 1;

    const editorPath = getUnrealEditorPath();
    const projectFile = getUnrealProjectFile();

    // Ensure cache directories exist
    const cacheBase = getCacheDirBase();
    fs.mkdirSync(path.join(cacheBase, 'meshes'), { recursive: true });
    fs.mkdirSync(path.join(cacheBase, 'textures'), { recursive: true });
    fs.mkdirSync(path.join(cacheBase, 'terrain'), { recursive: true });

    await initTextureCache();

    // Subscribe to circuit-specific messages (animation, appearance, sit)
    this.subscribeToCircuit();

    console.log(`[UnrealBridge] Spawning UE5 on port ${this.port} — ${editorPath}`);

    // Launch UE5 in -game mode with WebSocket port
    this.process = spawn(editorPath, [
      projectFile,
      '-game',
      '-log',
      `-ws-port=${this.port}`,
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.log(`[Unreal] ${text}`);
    });

    const spawnTime = Date.now();

    this.process.stderr?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.error(`[Unreal] ${text}`);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`[UnrealBridge] UE5 exited with code=${code} signal=${signal}`);

      const uptimeMs = Date.now() - spawnTime;
      if (code !== 0 && code !== null && uptimeMs < 15_000) {
        console.error(`[UnrealBridge] Startup crash detected (uptime ${uptimeMs}ms)`);
        this.emit('crash', 'Unreal viewer crashed on startup. Check that the UE5 project is built and the project file exists.');
      }

      this.cleanup();
      this.emit('exit');
    });

    this.process.on('error', (err) => {
      console.error(`[UnrealBridge] UE5 spawn error:`, err);
      this.emit('exit');
    });

    await this.connectWebSocket();
  }

  private async connectWebSocket(): Promise<void> {
    const maxAttempts = 30; // UE5 takes longer to start than Godot
    const delayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.process || this.process.exitCode !== null) {
        throw new Error('UE5 process exited before WebSocket connected');
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Connection timeout'));
          }, 5000);

          ws.on('open', () => {
            clearTimeout(timeout);
            this.ws = ws;
            this.setConnected(true);
            console.log(`[UnrealBridge] WebSocket connected (attempt ${attempt})`);

            // Open message log
            const msgLogPath = path.join(app.getPath('userData'), 'unreal-messages.log');
            this.msgLogStream = fs.createWriteStream(msgLogPath, { flags: 'w' });
            this.msgLogStream.write(`=== Unreal messages log started ${new Date().toISOString()} ===\n`);

            ws.on('message', (data) => {
              try {
                const msg = JSON.parse(data.toString());
                this.handleViewerMessage(msg);
              } catch { /* ignore bad messages */ }
            });

            ws.on('close', () => {
              console.log('[UnrealBridge] WebSocket closed');
              this.setConnected(false);
            });

            resolve();
          });

          ws.on('error', (err) => {
            clearTimeout(timeout);
            ws.close();
            reject(err);
          });
        });
        break;
      } catch {
        if (attempt === maxAttempts) {
          throw new Error(`Failed to connect to UE5 after ${maxAttempts} attempts`);
        }
        console.log(`[UnrealBridge] Connect attempt ${attempt}/${maxAttempts} failed, retrying...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    // Tell viewer which avatar is "self"
    const selfId = this.bot.agent?.agentID?.toString?.() || '';
    if (selfId) {
      this.send({ type: 'self_id', id: selfId });
    }

    // Send draw distance
    this.send({ type: 'settings', draw_distance: this.bot.agent.cameraFar });

    // Preload skeleton/attachment data
    await initSkeletonData();

    // Init fetch queues
    const meshCacheDir = path.join(app.getPath('userData'), 'asset-cache', 'meshes');
    const meshMeta = new Map<string, { path: string; isRigged?: boolean; jointNames?: string[]; jointOverrides?: string[] }>();
    const texturePaths = new Map<string, { path: string; opaque: boolean }>();
    this.faceUpdateBatcher.textureLookup = (textureId) => texturePaths.get(textureId);
    this.faceUpdateBatcher.isAttachment = (uuid) => this.readinessTracker?.isAttachment(uuid) ?? false;

    this.meshFetchQueue = new MeshFetchQueue(this.bot, (meshUuid, cachePath, isRigged, jointNames, jointOverrides) => {
      const fwdPath = cachePath.replace(/\\/g, '/');
      meshMeta.set(meshUuid, { path: fwdPath, isRigged, jointNames, jointOverrides });
      if (jointOverrides && jointOverrides.length > 0) {
        pkDebug('mesh', `[MeshReady] meshId=${meshUuid.slice(0, 8)} jointOverrides=${jointOverrides.length}`);
      }
    }, meshCacheDir);

    this.textureFetchQueue = new TextureFetchQueue(this.bot, (textureUuid, cachePath, opaque) => {
      const fwdPath = cachePath.replace(/\\/g, '/');
      texturePaths.set(textureUuid, { path: fwdPath, opaque });
    });

    this.sculptFetchQueue = new SculptFetchQueue(this.bot, (meshId, cachePath) => {
      const fwdPath = cachePath.replace(/\\/g, '/');
      meshMeta.set(meshId, { path: fwdPath });
    }, this.textureFetchQueue.decodePool);

    this.materialFetchQueue = new MaterialFetchQueue(this.bot, (materialUuid, data) => {
      this.materialResolver.handleMaterialReady(materialUuid, data);
      this.readinessTracker?.onMaterialReady(materialUuid);
    });

    this.animationFetchQueue = new AnimationFetchQueue(this.bot, (animUuid, data) => {
      this.animationManager.checkAnimBatchReady(animUuid);
    });

    // Create readiness tracker
    this.readinessTracker = new ObjectReadinessTracker((msg) => this.send(msg));
    const readinessTracker = this.readinessTracker;
    readinessTracker.enrichFn = (msg: any) => {
      if (msg.meshId) {
        const meta = meshMeta.get(msg.meshId);
        if (meta) {
          msg.meshPath = meta.path;
          if (meta.isRigged) msg.isRigged = true;
          if (meta.jointNames) msg.jointNames = meta.jointNames;
          if (meta.jointOverrides && meta.jointOverrides.length > 0) msg.jointOverrides = meta.jointOverrides;
        }
      }
      if (msg.faces) {
        for (const face of msg.faces) {
          if (face.textureId) {
            const tex = texturePaths.get(face.textureId);
            face.texturePath = tex?.path ?? '';
            if (tex?.opaque) face.textureOpaque = true;
          }
          if (face.normalTextureId) face.normalTexturePath = texturePaths.get(face.normalTextureId)?.path ?? '';
          if (face.ormTextureId) face.ormTexturePath = texturePaths.get(face.ormTextureId)?.path ?? '';
          if (face.emissiveTextureId) face.emissiveTexturePath = texturePaths.get(face.emissiveTextureId)?.path ?? '';
          enrichFaceMaterialKey(face, !!msg.isAttachment);
        }
      }
    };
    this.meshFetchQueue.onResolved = (uuid) => readinessTracker.onMeshReady(uuid);
    this.meshFetchQueue.onFailed = (uuid) => readinessTracker.onMeshFailed(uuid);
    this.textureFetchQueue.onResolved = (uuid) => readinessTracker.onTextureReady(uuid);
    this.textureFetchQueue.onFailed = (uuid) => readinessTracker.onTextureFailed(uuid);
    this.sculptFetchQueue.onResolved = (uuid) => readinessTracker.onMeshReady(uuid);
    this.sculptFetchQueue.onFailed = (uuid) => readinessTracker.onMeshFailed(uuid);
    this.materialFetchQueue.onFailed = (uuid) => {
      this.materialResolver.handleMaterialFailed(uuid);
      readinessTracker.onMaterialFailed(uuid);
    };
    this.objectSender.setReadinessTracker(readinessTracker);

    this.avatarManager.onAvatarEmitted = (uuid) => readinessTracker.markEmitted(uuid);

    this.materialResolver.initQueues(this.materialFetchQueue, this.textureFetchQueue);
    this.animationManager.initFetchQueue(this.animationFetchQueue);
    this.avatarManager.initBom(this.materialResolver);

    this.environmentMgr = new GodotEnvironmentManager(this.bot, (msg) => this.send(msg));

    this.updateCoalescer = new GodotUpdateCoalescer({
      isTracked: (id) => this.trackedObjects.has(id),
      isAvatarTracked: (id) => this.trackedAvatars.has(id),
      getLightInfo: (obj) => this.objectSender.getLightInfo(obj),
      send: (msg) => this.send(msg),
      trySendObject: (obj) => {
        const parentLocalId = obj.ParentID || 0;
        if (parentLocalId > 0) {
          try {
            const parentObj = obj.region?.objects?.getObjectByLocalID(parentLocalId);
            const parentUuid = parentObj?.FullID?.toString() || '';
            this.objectSender.sendObject(obj, parentUuid);
          } catch { /* parent may not be in store */ }
        }

      },
      resendObject: (obj) => {
        const objUuid = obj.FullID?.toString() || '';
        const parentLocalId = obj.ParentID || 0;
        let parentUuid = '';
        if (parentLocalId > 0) {
          try {
            const parentObj = obj.region?.objects?.getObjectByLocalID(parentLocalId);
            parentUuid = parentObj?.FullID?.toString() || '';
          } catch { /* parent may not be in store */ }
          if (!parentUuid) return;
        }
        this.trackedObjects.delete(objUuid);
        this.objectSender.sendObject(obj, parentUuid);
        this.objectSender.sendChildren(obj);
      },
    });

    this.objectSender.initQueues(this.meshFetchQueue, this.sculptFetchQueue, this.textureFetchQueue, this.updateCoalescer);

    this.subscribeToEvents();

    this.sceneManager.sendInitialState(this.viewerAdapter);

    this.environmentMgr.sendTerrain().catch(err => {
      console.error('[UnrealBridge] Error sending terrain:', err);
    });

    // Replay sitting state
    const sitState = this.inputHandler.getSitState();
    if (sitState.seatLocalId > 0 && sitState.position && sitState.rotation) {
      this.send({ type: 'sitting_state', sitting: true });
      const selfId = this.bot.agent?.agentID?.toString();
      if (selfId) {
        let seatUuid = '';
        try {
          const seatObj = this.bot.currentRegion?.objects?.getObjectByLocalID(sitState.seatLocalId);
          seatUuid = seatObj?.FullID?.toString() || '';
        } catch { /* seat may not be in object store */ }
        if (seatUuid) {
          this.send({
            type: 'avatar_update',
            id: selfId,
            position: sitState.position,
            rotation: sitState.rotation,
            parentUuid: seatUuid,
          });
        }
      }
      console.log(`[UnrealBridge] Replayed sitting state on reconnect: seatLocalId=${sitState.seatLocalId}`);
    }
  }

  private handleViewerMessage(msg: any): void {
    switch (msg.type) {
      case 'ready':
        break;
      case 'input_move':
        this.inputHandler.handleInputMove(msg);
        break;
      case 'camera_update':
        this.inputHandler.handleCameraUpdate(msg);
        break;
      case 'pipeline_stats':
        break;
      case 'request_object_properties':
        this.inputHandler.handleRequestObjectProperties(msg.uuid);
        break;
      case 'set_object_name':
        this.inputHandler.handleSetObjectName(msg.uuid, msg.name);
        break;
      case 'set_object_description':
        this.inputHandler.handleSetObjectDescription(msg.uuid, msg.description);
        break;
      case 'object_touch':
        this.inputHandler.handleObjectTouch(msg);
        break;
      case 'object_touch_start':
        this.inputHandler.handleObjectTouchStart(msg);
        break;
      case 'object_touch_move':
        this.inputHandler.handleObjectTouchMove(msg);
        break;
      case 'object_touch_end':
        this.inputHandler.handleObjectTouchEnd(msg);
        break;
      case 'object_sit':
        this.inputHandler.handleObjectSit(msg);
        break;
      case 'object_pay':
        this.inputHandler.handleObjectPay(msg);
        break;
      case 'pay_confirm':
        this.inputHandler.handlePayConfirm(msg);
        break;
      case 'script_dialog_reply':
        this.inputHandler.handleScriptDialogReply(msg);
        break;
      case 'script_textbox_reply':
        this.inputHandler.handleScriptTextboxReply(msg);
        break;
      case 'notification_action':
        this.inputHandler.handleNotificationAction(msg);
        break;
      case 'object_buy':
        console.log(`[UnrealBridge] Buy requested for ${msg.uuid?.slice(0, 8)} (not yet implemented)`);
        break;
      case 'object_edit':
        console.log(`[UnrealBridge] Edit requested for ${msg.uuid?.slice(0, 8)} (not yet implemented)`);
        break;
      case 'object_inspect':
        console.log(`[UnrealBridge] Inspect requested for ${msg.uuid?.slice(0, 8)} (not yet implemented)`);
        break;
      case 'stand_up':
        this.inputHandler.handleStandUp();
        break;
      case 'sit_or_stand':
        this.inputHandler.handleSitOrStand();
        break;
      case 'window_bounds':
        saveExternalBounds('unreal', {
          x: msg.x, y: msg.y,
          width: msg.width, height: msg.height,
        });
        break;
      case 'inventory_drop':
        this.handleInventoryDrop(msg.metadata);
        break;
      case 'quit':
        console.log('[UnrealBridge] Viewer requested immediate quit');
        this.stop();
        break;
    }
  }

  private handleInventoryDrop(metadata: any): void {
    if (!metadata?.assetType) return;
    console.log(`[UnrealBridge] Inventory drop: ${metadata.assetType} "${metadata.name}"`);

    switch (metadata.assetType) {
      case 'landmark': {
        const detail = metadata.detail as string | undefined;
        if (!detail) break;
        const match = detail.match(/^(.+?)\s*\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (!match) break;
        const [, regionName, x, y, z] = match;
        console.log(`[UnrealBridge] Teleporting to ${regionName} (${x}, ${y}, ${z})`);
        const pos = new Vector3([parseInt(x), parseInt(y), parseInt(z)]);
        const lookAt = new Vector3([0, 1, 0]);
        this.bot.clientCommands.teleport.teleportTo(regionName, pos, lookAt).catch((err: any) => {
          console.error(`[UnrealBridge] Teleport failed:`, err?.message || err);
        });
        break;
      }
      default:
        console.log(`[UnrealBridge] Unhandled inventory drop type: ${metadata.assetType}`);
        break;
    }
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    this.animationManager.setConnected(connected);
    this.avatarManager.setConnected(connected);
  }

  /** Low-level WebSocket send */
  private sendRaw(msg: object): void {
    if (this.ws && this.connected) {
      const json = JSON.stringify(msg);
      this.msgLogStream?.write(json + '\n');
      this.ws.send(json);
    }
  }

  /** Queue a message. All messages go through the buffer to preserve ordering. */
  private send(msg: object): void {
    this.sendBuffer.push(msg);
    if (!this.sendTimer) {
      this.sendTimer = setTimeout(() => this.flushSendBuffer(), 50);
    }
  }

  private flushSendBuffer(): void {
    this.sendTimer = null;
    if (this.sendBuffer.length === 0) return;

    const seenObjUpdate = new Set<string>();
    const seenAvatarUpdate = new Set<string>();
    const seenAnimBatch = new Set<string>();
    const seenFaces = new Set<string>();
    const keep = new Array<boolean>(this.sendBuffer.length).fill(true);

    for (let i = this.sendBuffer.length - 1; i >= 0; i--) {
      const msg = this.sendBuffer[i] as any;
      const type = msg.type;

      if (type === 'object_update_batch' || type === 'object_update_physics') {
        const objects: any[] = msg.objects;
        if (objects) {
          const filtered = objects.filter((o: any) => {
            const uuid = o.uuid;
            if (seenObjUpdate.has(uuid)) return false;
            seenObjUpdate.add(uuid);
            return true;
          });
          if (filtered.length === 0) {
            keep[i] = false;
          } else {
            msg.objects = filtered;
          }
        }
      } else if (type === 'avatar_update_batch') {
        const avatars: any[] = msg.avatars;
        if (avatars) {
          const filtered = avatars.filter((a: any) => {
            const id = a.id;
            if (seenAvatarUpdate.has(id)) return false;
            seenAvatarUpdate.add(id);
            return true;
          });
          if (filtered.length === 0) {
            keep[i] = false;
          } else {
            msg.avatars = filtered;
          }
        }
      } else if (type === 'animations_batch') {
        const uuid = msg.uuid;
        if (uuid) {
          if (seenAnimBatch.has(uuid)) {
            keep[i] = false;
          } else {
            seenAnimBatch.add(uuid);
          }
        }
      } else if (type === 'object_update_faces' || type === 'object_update_faces_batch') {
        if (type === 'object_update_faces') {
          const uuid = msg.uuid;
          if (uuid) {
            if (seenFaces.has(uuid)) {
              keep[i] = false;
            } else {
              seenFaces.add(uuid);
            }
          }
        } else {
          const objects: any[] = msg.objects;
          if (objects) {
            const filtered = objects.filter((o: any) => {
              const uuid = o.uuid;
              if (seenFaces.has(uuid)) return false;
              seenFaces.add(uuid);
              return true;
            });
            if (filtered.length === 0) {
              keep[i] = false;
            } else {
              msg.objects = filtered;
            }
          }
        }
      }
    }

    const coalesced: object[] = [];
    for (let i = 0; i < this.sendBuffer.length; i++) {
      if (keep[i]) coalesced.push(this.sendBuffer[i]);
    }
    this.sendBuffer = [];

    const BATCH_SIZE = 200;
    const batch = coalesced.splice(0, BATCH_SIZE);
    for (const msg of batch) {
      this.sendRaw(msg);
    }

    if (coalesced.length > 0) {
      this.sendBuffer = coalesced.concat(this.sendBuffer);
      this.sendTimer = setTimeout(() => this.flushSendBuffer(), 50);
    }
  }

  /** ViewerAdapter implementation — called by SceneManager for all regions. */
  private viewerAdapter: ViewerAdapter = {
    onWorldOrigin: (originX: number, originY: number) => {
      this.send({ type: 'world_origin', originX, originY });
    },

    onTerrain: (region: Region) => {
      const offset = this.sceneManager.getRegionOffset(region);
      this.environmentMgr?.sendRegionTerrain(region, offset.x, offset.y);
    },

    onNewObject: (event) => {
      const obj = event.object;
      if (obj.PCode === 47) {
        const avatarUuid = obj.FullID?.toString() || '';
        if (avatarUuid && this.avatarManager.deferredAvatars.has(avatarUuid)) {
          try {
            const region = obj.region;
            const avatar = region?.agents?.get(avatarUuid);
            if (avatar) {
              pkDebug('avatar', `[Avatar] ${avatarUuid.slice(0, 8)} ObjectUpdate arrived (localId=${obj.ID}), recovering deferred avatar`);
              this.avatarManager.sendAvatarCreate(avatar, avatarUuid);
            }
          } catch { /* avatar may not be accessible */ }
        }
        return;
      }
      if (isHudAttachment(obj)) return;

      const parentLocalId = obj.ParentID || 0;
      let parentUuid = '';
      if (parentLocalId > 0) {
        try {
          const parentObj = obj.region?.objects?.getObjectByLocalID(parentLocalId);
          parentUuid = parentObj?.FullID?.toString() || '';
        } catch { /* parent may not be in store */ }
        if (!parentUuid) {
          const childUuid = obj.FullID?.toString() || '';
          pkDebug('object', `[UnrealBridge] Child ${childUuid.slice(0, 8)} skipped — parent localId=${parentLocalId} not yet in store`);
          return;
        }
      }
      this.objectSender.sendObject(obj, parentUuid);

      if (parentLocalId === 0) {
        try {
          const region = obj.region;
          if (region) {
            const objUuid = obj.FullID?.toString() || '';
            const children = region.objects.getObjectsByParent(obj.ID);
            for (const child of children) {
              if (child.PCode === 47) continue;
              if (isHudAttachment(child)) continue;
              const childUuid = child.FullID?.toString() || '';
              if (childUuid && !this.trackedObjects.has(childUuid)) {
                this.objectSender.sendObject(child, objUuid);
              }
            }
          }
        } catch { /* ignore */ }
      }
    },

    onObjectUpdated: () => {},
    onObjectUpdatedTerse: () => {},
    onObjectResolved: () => {},
    onObjectSelected: () => {},

    onAvatarEntered: (avatar) => {
      try {
        const id = avatar.getKey().toString();
        if (!id || this.trackedAvatars.has(id)) return;
        this.avatarManager.sendAvatarCreate(avatar, id);
      } catch { /* avatar may not be fully initialized yet */ }
    },

    onEnvironment: () => {},
    onParcelOverlay: () => {},

    onRegionChange: () => {
      console.log(`[UnrealBridge] Cross-region teleport detected, clearing scene`);
      this.handleRegionChange();
    },

    onInitialState: (allRegions: Region[]) => {
      for (const region of allRegions) {
        if (region.terrainComplete) {
          const offset = this.sceneManager.getRegionOffset(region);
          this.environmentMgr?.sendRegionTerrain(region, offset.x, offset.y);
        }
      }

      this.objectSender.sendInitialSnapshot(
        (avatar, id) => this.avatarManager.sendAvatarCreate(avatar, id),
        allRegions,
      );
    },
  };

  private subscribeToEvents(): void {
    const events = this.bot.clientEvents;

    this.sceneManager.addAdapter(this.viewerAdapter);

    const updateSubs = this.updateCoalescer!.subscribe(events);
    this.subscriptions.push(...updateSubs);

    const selfStandSub = events.onObjectUpdatedEvent.subscribe((event: any) => {
      const obj = event.object;
      if (obj.PCode !== 47) return;
      const avatarId = obj.FullID?.toString();
      if (!avatarId) return;
      const selfId = this.bot.agent?.agentID?.toString();
      if (!selfId || avatarId !== selfId) return;
      if ((obj.ParentID || 0) !== 0 || !this.inputHandler.isSitting) return;

      this.inputHandler.setSittingState(false, 0);
      this.send({ type: 'sitting_state', sitting: false });
      console.log('[UnrealBridge] Self avatar stood up (ParentID -> 0)');
    });
    this.subscriptions.push(selfStandSub);

    const chatSub = events.onNearbyChat.subscribe((event) => {
      try {
        const fromId = event.from?.toString() || '';
        if (!fromId) return;

        if (event.sourceType === ChatSourceType.Object && event.message) {
          this.send({ type: 'object_chat', objectId: fromId, message: event.message, objectName: event.fromName });
          return;
        }

        if (!this.trackedAvatars.has(fromId)) return;

        if (event.chatType === ChatType.StartTyping) {
          this.send({ type: 'avatar_typing', avatarId: fromId, typing: true });
        } else if (event.chatType === ChatType.StopTyping) {
          this.send({ type: 'avatar_typing', avatarId: fromId, typing: false });
        } else if (event.sourceType === ChatSourceType.Agent && event.message) {
          this.send({ type: 'avatar_chat', avatarId: fromId, message: event.message });
        }
      } catch { /* ignore malformed chat events */ }
    });
    this.subscriptions.push(chatSub);

    let dialogSeq = 0;
    const dialogSub = events.onScriptDialog.subscribe((event: ScriptDialogEvent) => {
      try {
        const dialogId = `dlg_${Date.now()}_${dialogSeq++}`;
        const isTextBox = event.Buttons.length === 1 && event.Buttons[0] === '!!llTextBox!!';

        this.inputHandler.storeScriptDialog(dialogId, event);

        this.send({
          type: 'script_dialog',
          dialogId,
          objectId: event.ObjectID.toString(),
          objectName: event.ObjectName,
          ownerName: `${event.FirstName} ${event.LastName}`,
          message: event.Message,
          buttons: isTextBox ? [] : event.Buttons,
          channel: event.ChatChannel,
          isTextBox,
        });
        console.log(`[UnrealBridge] ScriptDialog from "${event.ObjectName}" ch=${event.ChatChannel} buttons=${event.Buttons.length} textbox=${isTextBox}`);
      } catch { /* ignore malformed dialog events */ }
    });
    this.subscriptions.push(dialogSub);

    let lureSeq = 0;
    const lureSub = events.onLure.subscribe((event: LureEvent) => {
      try {
        const offerId = `lure_${Date.now()}_${lureSeq++}`;

        this.inputHandler.storeTeleportOffer(offerId, event);

        this.send({
          type: 'teleport_offer',
          offerId,
          fromName: event.fromName,
          message: event.lureMessage || '',
        });
        console.log(`[UnrealBridge] Teleport offer from "${event.fromName}"`);
      } catch { /* ignore malformed lure events */ }
    });
    this.subscriptions.push(lureSub);

    let memLogCounter = 0;
    this.killSweepTimer = setInterval(() => {
      void this.objectSender.sweepTrackedObjects();
      this.avatarManager.sweepAvatarDepartures();
      this.readinessTracker?.sweepTimeouts();

      this.sendElectronStats();

      if (++memLogCounter % 15 === 0) {
        this.logMemoryStats();
      }
    }, 2000);
  }

  private logMemoryStats(): void {
    const mem = process.memoryUsage();
    const mb = (b: number) => (b / 1024 / 1024).toFixed(0);
    let objStoreSize: string | number = '?';
    try { objStoreSize = this.bot.currentRegion?.objects?.getNumberOfObjects?.() ?? '?'; } catch { /* bot disconnected */ }
    const tq = this.textureFetchQueue;
    console.log(`[UnrealBridge] Memory: rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB ext=${mb(mem.external)}MB | objects=${objStoreSize} tracked=${this.trackedObjects.size} | tex: q=${tq?.queueDepth ?? '?'} active=${tq?.activeCount ?? '?'} done=${tq?.notifiedCount ?? '?'} fail=${tq?.failedCount ?? '?'} gpu=${tq?.gpuCompressCount ?? '?'} cpu=${tq?.cpuCompressCount ?? '?'} decode: w=${tq?.decodePool?.workerCount ?? '?'} q=${tq?.decodePool?.queueDepth ?? '?'} active=${tq?.decodePool?.activeCount ?? '?'} gpuq: q=${tq?.gpuQueueDepth ?? '?'} active=${tq?.gpuQueueActive ?? '?'} | pbr: ${this.materialResolver.totalPbrFaceCount} faces | deferred: ${this.objectSender.deferredCount} pending: ${this.objectSender.readinessPendingCount}`);
  }

  private sendElectronStats(): void {
    const tq = this.textureFetchQueue;
    const mq = this.meshFetchQueue;
    const sq = this.sculptFetchQueue;
    const matq = this.materialFetchQueue;
    const aq = this.animationFetchQueue;
    this.send({
      type: 'electron_stats',
      tex: {
        queue: tq?.queueDepth ?? 0,
        active: tq?.activeCount ?? 0,
        done: tq?.notifiedCount ?? 0,
        failed: tq?.failedCount ?? 0,
        decodeWorkers: tq?.decodePool?.workerCount ?? 0,
        decodeQueue: tq?.decodePool?.queueDepth ?? 0,
        decodeActive: tq?.decodePool?.activeCount ?? 0,
        gpuQueue: tq?.gpuQueueDepth ?? 0,
        gpuActive: tq?.gpuQueueActive ?? 0,
      },
      mesh: {
        queue: mq?.queueDepth ?? 0,
        active: mq?.activeCount ?? 0,
        done: mq?.notifiedCount ?? 0,
        failed: mq?.failedCount ?? 0,
      },
      sculpt: {
        queue: sq?.queueDepth ?? 0,
        active: sq?.activeCount ?? 0,
        done: sq?.notifiedCount ?? 0,
        failed: sq?.failedCount ?? 0,
      },
      material: {
        queue: matq?.queueDepth ?? 0,
        active: matq?.activeCount ?? 0,
        failed: matq?.failedCount ?? 0,
      },
      anim: {
        queue: aq?.queueDepth ?? 0,
        active: aq?.activeCount ?? 0,
        failed: aq?.failedCount ?? 0,
      },
      deferred: this.objectSender.deferredCount,
      readinessPending: this.objectSender.readinessPendingCount,
      tracked: this.trackedObjects.size,
    });
  }

  private subscribeToCircuit(): void {
    this.subscriptions.push(this.animationManager.subscribeToObjectAnimation());
    this.subscriptions.push(this.animationManager.subscribeToAvatarAnimation());
    this.subscriptions.push(this.avatarManager.subscribeToAvatarAppearance());

    const sitResponseSub = this.bot.subscribeToCircuitMessages([Message.AvatarSitResponse], (packet: any) => {
      try {
        const msg = packet.message;
        const seatUuid: string = msg.SitObject.ID.toString();
        const sitPos = msg.SitTransform.SitPosition;
        const sitRot = msg.SitTransform.SitRotation;

        const region = this.bot.currentRegion;
        if (!region) return;

        let seatLocalId = 0;
        try {
          seatLocalId = region.objects.getObjectByUUID(seatUuid as any).ID;
        } catch {
          console.warn(`[UnrealBridge] AvatarSitResponse: seat ${seatUuid.slice(0, 8)} not in object store`);
          return;
        }

        this.inputHandler.setSittingState(
          true, seatLocalId,
          slPos(sitPos) as any,
          slQuat(sitRot) as any,
        );
        this.send({ type: 'sitting_state', sitting: true });

        const selfId = this.bot.agent?.agentID?.toString();
        if (selfId) {
          this.send({
            type: 'avatar_update',
            id: selfId,
            position: slPos(sitPos),
            rotation: slQuat(sitRot),
            parentUuid: seatUuid,
          });
        }
        console.log(`[UnrealBridge] AvatarSitResponse: seated on ${seatUuid.slice(0, 8)} localId=${seatLocalId} offset=(${sitPos.x.toFixed(2)},${sitPos.y.toFixed(2)},${sitPos.z.toFixed(2)})`);
      } catch (e) {
        console.error('[UnrealBridge] AvatarSitResponse handler error:', e);
      }
    });
    this.subscriptions.push(sitResponseSub);

    console.log('[UnrealBridge] Subscribed to circuit messages (persistent)');
  }

  private handleRegionChange(): void {
    this.flushSendBuffer();
    this.sendRaw({ type: 'region_change' });

    this.sendBuffer = [];
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }

    this.trackedObjects.clear();
    this.trackedAvatars.clear();

    this.objectSender.clearForRegionChange();
    this.avatarManager.cleanup();
    this.animationManager.clearForRegionChange();

    this.textureFetchQueue?.clearPending();
    this.environmentMgr?.clearParcelCache();

    const eqSub = this.bot.clientEvents.onEventQueueStateChange.subscribe((evt) => {
      if (!evt.active) return;
      eqSub.unsubscribe();

      if (!this.connected) return;

      this.environmentMgr?.sendTerrain().catch(err => {
        console.error('[UnrealBridge] Error sending terrain after region change:', err);
      });

      try {
        console.log('[UnrealBridge] New region ready, sending initial snapshot');
        this.sceneManager.sendInitialState(this.viewerAdapter);
      } catch (e) {
        console.error('[UnrealBridge] Failed to send snapshot after region change:', e);
      }
    });
    this.subscriptions.push(eqSub);
  }

  stop(): void {
    this.cleanup();

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  private cleanup(): void {
    this.sceneManager.removeAdapter(this.viewerAdapter);

    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    if (this.killSweepTimer) {
      clearInterval(this.killSweepTimer);
      this.killSweepTimer = null;
    }

    this.objectSender.cleanup();
    this.avatarManager.cleanup();
    this.animationManager.cleanup();
    this.materialResolver.cleanup();
    this.faceUpdateBatcher.cleanup();
    this.readinessTracker = null;
    this.sculptFetchQueue = null;
    this.materialFetchQueue = null;
    this.animationFetchQueue = null;

    this.updateCoalescer?.cleanup();
    this.updateCoalescer = null;
    this.environmentMgr?.cleanup();
    this.environmentMgr = null;

    if (this.textureFetchQueue) {
      this.textureFetchQueue.destroy();
      this.textureFetchQueue = null;
    }

    if (this.msgLogStream) {
      this.msgLogStream.end();
      this.msgLogStream = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setConnected(false);
    this.trackedObjects.clear();
    this.trackedAvatars.clear();
    this.sendBuffer = [];
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
  }

  get isActive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }
}
