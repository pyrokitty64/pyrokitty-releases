/**
 * GodotBridge — Spawns a Godot 4 sidecar and streams object/avatar data
 * from node-metaverse over WebSocket.
 *
 * Orchestrates sub-modules:
 *  - GodotInputHandler — movement, object interaction
 *  - GodotAnimationManager — animation batching for avatars/animesh
 *  - MaterialResolver — viewer-agnostic material resolution
 *  - GodotFaceUpdateBatcher — face update batching for Godot
 *  - GodotObjectSender — object serialization, snapshots, sweeps
 *  - GodotAvatarManager — avatar lifecycle and attachment routing
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

const GODOT_WS_PORT_BASE = 9200;
let nextPort = GODOT_WS_PORT_BASE;

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

// In dev mode __dirname is dist/main/, godot-viewer is at ../../.. (project root)
function getGodotViewerRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'godot-viewer')
    : path.join(__dirname, '..', '..', '..', 'godot-viewer');
}

function getGodotDir(): string {
  const versionFile = path.join(getGodotViewerRoot(), 'godot-version.txt');
  return fs.readFileSync(versionFile, 'utf8').trim();
}

function getGodotPath(): string {
  const dir = getGodotDir();
  if (process.platform === 'linux') {
    // Linux zip: dir is Godot_v4.7-dev2_mono_linux_x86_64, exe is Godot_v4.7-dev2_mono_linux.x86_64
    const exe = dir.replace(/_x86_64$/, '.x86_64');
    return path.join(getGodotViewerRoot(), dir, exe);
  }
  return path.join(getGodotViewerRoot(), dir, `${dir}.exe`);
}

function getProjectPath(): string {
  return getGodotViewerRoot();
}

function getCacheDirBase(): string {
  return path.join(app.getPath('userData'), 'asset-cache');
}

export class GodotBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private port: number;
  private bot: Bot;
  private subscriptions: { unsubscribe: () => void }[] = [];
  private connected = false;
  private vrMode: boolean;

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

  // Godot message log
  private msgLogStream: fs.WriteStream | null = null;

  // Stats
  private killSweepTimer: ReturnType<typeof setInterval> | null = null;
  private electronStatsCounter = 0;

  constructor(bot: Bot, sceneManager: SceneManager, options: { vrMode?: boolean; objectAnimationBuffer?: Map<string, { animId: string; sequenceId: number }[]>; avatarAnimationBuffer?: Map<string, { animId: string; sequenceId: number }[]>; avatarAppearanceBuffer?: Map<string, string[]>; visualParamBuffer?: Map<string, number[]> } = {}) {
    super();
    this.bot = bot;
    this.sceneManager = sceneManager;
    this.port = 0;
    this.vrMode = options.vrMode ?? false;

    const send = (msg: object) => this.send(msg);

    // Initialize sub-modules
    this.inputHandler = new GodotInputHandler(bot, send);
    this.animationManager = new GodotAnimationManager(bot, send, this.trackedAvatars);
    this.faceUpdateBatcher = new GodotFaceUpdateBatcher(send);
    this.materialResolver = new MaterialResolver(bot, this.trackedObjects,
      (objectUuid, faceIndex, material) => {
        const godotFace = resolvedToGodotFace(faceIndex, material);
        // If object_render hasn't shipped yet, patch face and register PBR texture dependencies
        const patched = this.readinessTracker?.updatePendingFaces(objectUuid, godotFace);
        if (patched) {
          // Add PBR textures as new dependencies so the tracker waits for them
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
        // Already sent — deliver via face update batcher
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

    // Seed from MetaverseConnection's early ObjectAnimation buffer
    if (options.objectAnimationBuffer) {
      this.animationManager.seedObjectAnimationBuffer(options.objectAnimationBuffer);
    }

    // Seed from MetaverseConnection's AvatarAnimation buffer (survives bridge restarts)
    if (options.avatarAnimationBuffer) {
      this.animationManager.seedAvatarAnimationBuffer(options.avatarAnimationBuffer);
    }

    // Seed from MetaverseConnection's early AvatarAppearance buffer
    if (options.avatarAppearanceBuffer && options.avatarAppearanceBuffer.size > 0) {
      this.avatarManager.seedBakedTextures(options.avatarAppearanceBuffer);
    }

    // Seed buffered VisualParam bytes → compute and buffer avatar shapes
    if (options.visualParamBuffer && options.visualParamBuffer.size > 0) {
      this.avatarManager.seedVisualParams(options.visualParamBuffer);
    }
  }

  async start(): Promise<void> {
    this.port = await findFreePort(nextPort);
    nextPort = this.port + 1;

    const godotPath = getGodotPath();
    const projectPath = getProjectPath();

    // Ensure cache directories exist
    const cacheBase = getCacheDirBase();
    fs.mkdirSync(path.join(cacheBase, 'meshes'), { recursive: true });
    fs.mkdirSync(path.join(cacheBase, 'textures'), { recursive: true });
    fs.mkdirSync(path.join(cacheBase, 'terrain'), { recursive: true });

    await initTextureCache();

    // VR config
    const overridePath = path.join(projectPath, 'override.cfg');
    const overrideVrPath = path.join(projectPath, 'override.vr.cfg');
    if (this.vrMode) {
      fs.copyFileSync(overrideVrPath, overridePath);
      console.log('[GodotBridge] Copied override.vr.cfg → override.cfg (VR mode)');
    } else {
      try { fs.unlinkSync(overridePath); } catch { /* not present, fine */ }
    }

    // Subscribe to circuit-specific messages (animation, appearance, sit)
    this.subscribeToCircuit();

    console.log(`[GodotBridge] Spawning Godot on port ${this.port} — ${godotPath}`);

    const userArgs = [`--ws-port=${this.port}`, `--app-version=${app.getVersion()}`];
    if (this.vrMode) userArgs.push('--vr');

    // Pass saved window bounds as engine args (before --) so the window
    // appears at the correct size/position immediately, avoiding a visible
    // resize flash. Godot processes --resolution and --position before
    // creating the window, unlike user args which are only available in _ready().
    const engineArgs: string[] = [];
    const savedBounds = getSavedBounds('godot');
    if (savedBounds) {
      engineArgs.push('--resolution', `${savedBounds.width}x${savedBounds.height}`);
      engineArgs.push('--position', `${savedBounds.x},${savedBounds.y}`);
    }

    this.process = spawn(godotPath, [
      '--path', projectPath,
      ...engineArgs,
      '--', ...userArgs,
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data) => {
      const text = data.toString().trim();
      console.log(`[Godot] ${text}`);
      if (text.includes('SHADER ERROR')) {
        console.error(`[GodotBridge] Shader compilation failed — killing Godot`);
        this.process?.kill();
      }
    });

    let sawCrashSignal = false;
    const spawnTime = Date.now();

    this.process.stderr?.on('data', (data) => {
      const text = data.toString().trim();
      console.error(`[Godot] ${text}`);
      if (text.includes('signal 11') || text.includes('CrashHandlerException')) {
        sawCrashSignal = true;
      }
    });

    this.process.on('exit', (code, signal) => {
      console.log(`[GodotBridge] Godot exited with code=${code} signal=${signal}`);
      // Read crash breadcrumb if Godot died unexpectedly
      if (code !== 0 && code !== null) {
        try {
          const appData = process.env.APPDATA || '';
          const breadcrumb = require('fs').readFileSync(
            require('path').join(appData, 'Godot', 'app_userdata', 'PyroKitty 3D', 'crash_breadcrumb.txt'), 'utf8');
          console.error(`[GodotBridge] Crash breadcrumb: ${breadcrumb.trim()}`);
        } catch { /* breadcrumb file may not exist */ }
      }

      // Detect startup crash (crashed within 10s, saw signal 11 in stderr)
      const uptimeMs = Date.now() - spawnTime;
      if (sawCrashSignal && uptimeMs < 10_000) {
        console.error(`[GodotBridge] Startup crash detected (uptime ${uptimeMs}ms) — likely a GPU driver issue`);
        this.emit('crash', '3D viewer crashed on startup. This usually means your video drivers need updating — check for updates from your GPU manufacturer (AMD, NVIDIA, or Intel).');
      }

      this.cleanup();
      this.emit('exit');
    });

    this.process.on('error', (err) => {
      console.error(`[GodotBridge] Godot spawn error:`, err);
      this.emit('exit');
    });

    await this.connectWebSocket();
  }

  private async connectWebSocket(): Promise<void> {
    const maxAttempts = 15;
    const delayMs = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.process || this.process.exitCode !== null) {
        throw new Error('Godot process exited before WebSocket connected');
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Connection timeout'));
          }, 3000);

          ws.on('open', () => {
            clearTimeout(timeout);
            this.ws = ws;
            this.setConnected(true);
            console.log(`[GodotBridge] WebSocket connected (attempt ${attempt})`);

            // Open godot-messages log
            const msgLogPath = path.join(app.getPath('userData'), 'godot-messages.log');
            this.msgLogStream = fs.createWriteStream(msgLogPath, { flags: 'w' });
            this.msgLogStream.write(`=== Godot messages log started ${new Date().toISOString()} ===\n`);

            ws.on('message', (data) => {
              try {
                const msg = JSON.parse(data.toString());
                this.handleGodotMessage(msg);
              } catch { /* ignore bad messages */ }
            });

            ws.on('close', () => {
              console.log('[GodotBridge] WebSocket closed');
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
          throw new Error(`Failed to connect to Godot after ${maxAttempts} attempts`);
        }
        console.log(`[GodotBridge] Connect attempt ${attempt}/${maxAttempts} failed, retrying...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    // Tell Godot which avatar is "self"
    const selfId = this.bot.agent?.agentID?.toString?.() || '';
    if (selfId) {
      this.send({ type: 'self_id', id: selfId });
    }

    // Send draw distance so Godot's visibility range matches the server value
    this.send({ type: 'settings', draw_distance: this.bot.agent.cameraFar });

    // Preload skeleton/attachment data (async file reads, populates sync caches)
    await initSkeletonData();

    // Init fetch queues — onReady stores paths in lookup maps (no longer sends to Godot)
    const meshCacheDir = path.join(app.getPath('userData'), 'asset-cache', 'meshes');
    /** meshId → { path, isRigged, jointNames, jointOverrides } */
    const meshMeta = new Map<string, { path: string; isRigged?: boolean; jointNames?: string[]; jointOverrides?: string[] }>();
    /** textureId → { path, opaque } */
    const texturePaths = new Map<string, { path: string; opaque: boolean }>();
    // Wire face update batcher to enrich faces with texture paths + materialKey
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
      // Step 1: Resolve PBR faces — patches pending objects + adds PBR texture deps
      this.materialResolver.handleMaterialReady(materialUuid, data);
      // Step 2: Mark material gate resolved — checkAndEmit runs here (after PBR textures are registered)
      this.readinessTracker?.onMaterialReady(materialUuid);
    });

    this.animationFetchQueue = new AnimationFetchQueue(this.bot, (animUuid, data) => {
      this.animationManager.checkAnimBatchReady(animUuid);
    });

    // Create readiness tracker and wire to fetch queue callbacks
    this.readinessTracker = new ObjectReadinessTracker((msg) => this.send(msg));
    const readinessTracker = this.readinessTracker;
    // Enrich object_render messages with disk paths before sending to Godot
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
          // Compute material cache key + resolvedAlphaMode now that all texture info is available
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

    // Wire avatar creation to readiness tracker so attachments wait for their avatar
    this.avatarManager.onAvatarEmitted = (uuid) => readinessTracker.markEmitted(uuid);

    // Wire fetch queues to sub-modules
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
        // Resolve parent local ID → UUID (ParentID is a number, sendObject expects a UUID string)
        const parentLocalId = obj.ParentID || 0;
        let parentUuid = '';
        if (parentLocalId > 0) {
          try {
            const parentObj = obj.region?.objects?.getObjectByLocalID(parentLocalId);
            parentUuid = parentObj?.FullID?.toString() || '';
          } catch { /* parent may not be in store */ }
          if (!parentUuid) return; // parent not in store — skip resend
        }
        // Untrack so sendObject doesn't skip it, then re-send
        this.trackedObjects.delete(objUuid);
        this.objectSender.sendObject(obj, parentUuid);
        this.objectSender.sendChildren(obj);
      },
    });

    this.objectSender.initQueues(this.meshFetchQueue, this.sculptFetchQueue, this.textureFetchQueue, this.updateCoalescer);

    // Subscribe to events + register with SceneManager
    this.subscribeToEvents();

    // Send initial state from all regions (terrain, objects, avatars)
    this.sceneManager.sendInitialState(this.viewerAdapter);

    // Main region environment (polled on timer, not event-driven)
    this.environmentMgr.sendTerrain().catch(err => {
      console.error('[GodotBridge] Error sending terrain:', err);
    });

    // Replay sitting state if we were seated before Godot restarted
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
      console.log(`[GodotBridge] Replayed sitting state on reconnect: seatLocalId=${sitState.seatLocalId}`);
    }
  }

  private handleGodotMessage(msg: any): void {
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
        console.log(`[GodotBridge] Buy requested for ${msg.uuid?.slice(0, 8)} (not yet implemented)`);
        break;
      case 'object_edit':
        console.log(`[GodotBridge] Edit requested for ${msg.uuid?.slice(0, 8)} (not yet implemented)`);
        break;
      case 'object_inspect':
        console.log(`[GodotBridge] Inspect requested for ${msg.uuid?.slice(0, 8)} (not yet implemented)`);
        break;
      case 'stand_up':
        this.inputHandler.handleStandUp();
        break;
      case 'sit_or_stand':
        this.inputHandler.handleSitOrStand();
        break;
      case 'window_bounds':
        saveExternalBounds('godot', {
          x: msg.x, y: msg.y,
          width: msg.width, height: msg.height,
        });
        break;
      case 'inventory_drop':
        this.handleInventoryDrop(msg.metadata);
        break;
      case 'quit':
        console.log('[GodotBridge] Godot requested immediate quit');
        this.stop();
        break;
    }
  }

  private handleInventoryDrop(metadata: any): void {
    if (!metadata?.assetType) return;
    console.log(`[GodotBridge] Inventory drop: ${metadata.assetType} "${metadata.name}"`);

    switch (metadata.assetType) {
      case 'landmark': {
        // Parse region + coords from detail line: "RegionName (x, y, z)"
        const detail = metadata.detail as string | undefined;
        if (!detail) break;
        const match = detail.match(/^(.+?)\s*\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (!match) break;
        const [, regionName, x, y, z] = match;
        console.log(`[GodotBridge] Teleporting to ${regionName} (${x}, ${y}, ${z})`);
        const pos = new Vector3([parseInt(x), parseInt(y), parseInt(z)]);
        const lookAt = new Vector3([0, 1, 0]);
        this.bot.clientCommands.teleport.teleportTo(regionName, pos, lookAt).catch((err: any) => {
          console.error(`[GodotBridge] Teleport failed:`, err?.message || err);
        });
        break;
      }
      default:
        console.log(`[GodotBridge] Unhandled inventory drop type: ${metadata.assetType}`);
        break;
    }
  }

  private setConnected(connected: boolean): void {
    this.connected = connected;
    this.animationManager.setConnected(connected);
    this.avatarManager.setConnected(connected);
  }

  /** Low-level WebSocket send — only called by flushSendBuffer */
  private sendRaw(msg: object): void {
    if (this.ws && this.connected) {
      const json = JSON.stringify(msg);
      this.msgLogStream?.write(json + '\n');
      this.ws.send(json);
    }
  }

  /** Queue a message to Godot. All messages go through the buffer to preserve ordering. */
  private send(msg: object): void {
    this.sendBuffer.push(msg);
    if (!this.sendTimer) {
      this.sendTimer = setTimeout(() => this.flushSendBuffer(), 50);
    }
  }

  private flushSendBuffer(): void {
    this.sendTimer = null;
    if (this.sendBuffer.length === 0) return;

    // Coalesce: for last-write-wins message types, keep only the latest per UUID.
    // Walk the buffer backwards so we see the newest entry first; mark older dupes
    // for removal. This avoids sending redundant updates that Godot would queue up.
    const seenObjUpdate = new Set<string>();  // uuid for object_update_batch entries
    const seenAvatarUpdate = new Set<string>(); // id for avatar_update_batch entries
    const seenAnimBatch = new Set<string>();  // uuid for animations_batch
    const seenFaces = new Set<string>();       // uuid for object_update_faces
    const keep = new Array<boolean>(this.sendBuffer.length).fill(true);

    for (let i = this.sendBuffer.length - 1; i >= 0; i--) {
      const msg = this.sendBuffer[i] as any;
      const type = msg.type;

      if (type === 'object_update_batch' || type === 'object_update_physics') {
        // Each message has an `objects` array — filter out UUIDs already seen in a later message
        const objects: any[] = msg.objects;
        if (objects) {
          const filtered = objects.filter((o: any) => {
            const uuid = o.uuid;
            if (seenObjUpdate.has(uuid)) return false;
            seenObjUpdate.add(uuid);
            return true;
          });
          if (filtered.length === 0) {
            keep[i] = false; // entire message redundant
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

    // Build coalesced buffer, preserving order (oldest first)
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

    // Re-queue anything beyond the batch size
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
        // Avatar ObjectUpdate arrived — recover deferred avatars that had localId=0
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
          // Parent not in object store yet — skip child. When the parent's ObjectUpdate
          // arrives, getObjectsByParent() will find this child and send it with correct parentUuid.
          const childUuid = obj.FullID?.toString() || '';
          pkDebug('object', `[GodotBridge] Child ${childUuid.slice(0, 8)} skipped — parent localId=${parentLocalId} not yet in store`);
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

    onObjectUpdated: () => {
      // Handled by updateCoalescer (Godot-specific batching)
    },

    onObjectUpdatedTerse: () => {
      // Handled by updateCoalescer (Godot-specific batching)
    },

    onObjectResolved: () => {
      // Already handled via ClientEvents subscription in ObjectStoreLite
    },

    onObjectSelected: () => {
      // Not currently used by Godot
    },

    onAvatarEntered: (avatar) => {
      try {
        const id = avatar.getKey().toString();
        if (!id || this.trackedAvatars.has(id)) return;
        this.avatarManager.sendAvatarCreate(avatar, id);
      } catch { /* avatar may not be fully initialized yet */ }
    },

    onEnvironment: () => {
      // Environment is polled on a timer, not event-driven for Godot
    },

    onParcelOverlay: () => {
      // Not currently visualized in Godot
    },

    onRegionChange: () => {
      console.log(`[GodotBridge] Cross-region teleport detected, clearing scene`);
      this.handleRegionChange();
    },

    onInitialState: (allRegions: Region[]) => {
      // Send terrain for all regions that have it
      for (const region of allRegions) {
        if (region.terrainComplete) {
          const offset = this.sceneManager.getRegionOffset(region);
          this.environmentMgr?.sendRegionTerrain(region, offset.x, offset.y);
        }
      }

      // Send objects + avatars from all regions
      this.objectSender.sendInitialSnapshot(
        (avatar, id) => this.avatarManager.sendAvatarCreate(avatar, id),
        allRegions,
      );
    },
  };

  private subscribeToEvents(): void {
    const events = this.bot.clientEvents;

    // Register with SceneManager for multi-region events
    this.sceneManager.addAdapter(this.viewerAdapter);

    // Godot-specific: update coalescer (16ms batching for terse/full updates)
    const updateSubs = this.updateCoalescer!.subscribe(events);
    this.subscriptions.push(...updateSubs);

    // Godot-specific: standing detection
    // (Sit detection is handled by AvatarSitResponse in subscribeToCircuit())
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
      console.log('[GodotBridge] Self avatar stood up (ParentID → 0)');
    });
    this.subscriptions.push(selfStandSub);

    // Nearby chat → Godot (name bubbles + typing indicators)
    const chatSub = events.onNearbyChat.subscribe((event) => {
      try {
        const fromId = event.from?.toString() || '';
        if (!fromId) return;

        // Object chat doesn't need avatar tracking
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
          // Normal/whisper/shout chat from an agent
          this.send({ type: 'avatar_chat', avatarId: fromId, message: event.message });
        }
      } catch { /* ignore malformed chat events */ }
    });
    this.subscriptions.push(chatSub);

    // Script dialogs (llDialog / llTextBox) → Godot
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
        console.log(`[GodotBridge] ScriptDialog from "${event.ObjectName}" ch=${event.ChatChannel} buttons=${event.Buttons.length} textbox=${isTextBox}`);
      } catch { /* ignore malformed dialog events */ }
    });
    this.subscriptions.push(dialogSub);

    // Teleport offers (lure) → Godot
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
        console.log(`[GodotBridge] Teleport offer from "${event.fromName}"`);
      } catch { /* ignore malformed lure events */ }
    });
    this.subscriptions.push(lureSub);

    // Kill sweep + deferred promotion: every 2s
    let memLogCounter = 0;
    this.killSweepTimer = setInterval(() => {
      void this.objectSender.sweepTrackedObjects();
      this.avatarManager.sweepAvatarDepartures();
      this.readinessTracker?.sweepTimeouts();

      // Send electron stats to Godot every 2s (every tick)
      this.sendElectronStats();

      // Log memory stats every 30s
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
    console.log(`[GodotBridge] Memory: rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB ext=${mb(mem.external)}MB | objects=${objStoreSize} tracked=${this.trackedObjects.size} | tex: q=${tq?.queueDepth ?? '?'} active=${tq?.activeCount ?? '?'} done=${tq?.notifiedCount ?? '?'} fail=${tq?.failedCount ?? '?'} gpu=${tq?.gpuCompressCount ?? '?'} cpu=${tq?.cpuCompressCount ?? '?'} decode: w=${tq?.decodePool?.workerCount ?? '?'} q=${tq?.decodePool?.queueDepth ?? '?'} active=${tq?.decodePool?.activeCount ?? '?'} gpuq: q=${tq?.gpuQueueDepth ?? '?'} active=${tq?.gpuQueueActive ?? '?'} | pbr: ${this.materialResolver.totalPbrFaceCount} faces | deferred: ${this.objectSender.deferredCount} pending: ${this.objectSender.readinessPendingCount}`);
  }

  /** Send electron-side fetch queue stats to Godot for the stats bar */
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

  /**
   * Subscribe to circuit-specific messages (ObjectAnimation, AvatarAnimation,
   * AvatarAppearance, AvatarSitResponse). Must be called again after region
   * change since the old circuit is destroyed.
   */
  /**
   * Subscribe to circuit messages using Bot's persistent subscription API.
   * These auto-rewire to the new circuit on region change — no manual
   * re-subscription needed.  Called once at startup.
   */
  private subscribeToCircuit(): void {
    // Animation messages (ObjectAnimation + AvatarAnimation)
    this.subscriptions.push(this.animationManager.subscribeToObjectAnimation());
    this.subscriptions.push(this.animationManager.subscribeToAvatarAnimation());

    // Avatar appearance (BoM bake updates)
    this.subscriptions.push(this.avatarManager.subscribeToAvatarAppearance());

    // AvatarSitResponse
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
          console.warn(`[GodotBridge] AvatarSitResponse: seat ${seatUuid.slice(0, 8)} not in object store`);
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
        console.log(`[GodotBridge] AvatarSitResponse: seated on ${seatUuid.slice(0, 8)} localId=${seatLocalId} offset=(${sitPos.x.toFixed(2)},${sitPos.y.toFixed(2)},${sitPos.z.toFixed(2)})`);
      } catch (e) {
        console.error('[GodotBridge] AvatarSitResponse handler error:', e);
      }
    });
    this.subscriptions.push(sitResponseSub);

    console.log('[GodotBridge] Subscribed to circuit messages (persistent)');
  }

  /**
   * Handle cross-region teleport: clear Godot scene, reset bridge tracking,
   * then re-snapshot once the new region's objects start arriving.
   */
  private handleRegionChange(): void {
    // Flush any pending messages from the old region, then tell Godot to wipe
    this.flushSendBuffer();
    this.sendRaw({ type: 'region_change' });

    // Clear the send buffer (any new messages from old region callbacks)
    this.sendBuffer = [];
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }

    // Reset bridge-side tracking
    this.trackedObjects.clear();
    this.trackedAvatars.clear();

    // Reset sub-module state (without destroying fetch queues — they're reused)
    this.objectSender.clearForRegionChange();
    this.avatarManager.cleanup();
    this.animationManager.clearForRegionChange();

    // Clear pending downloads (old caps URLs will 403)
    this.textureFetchQueue?.clearPending();

    // Clear environment cache (parcel env is per-region)
    this.environmentMgr?.clearParcelCache();

    // Circuit subscriptions are persistent (auto-rewired by Bot.subscribeToCircuitMessages),
    // so no re-subscription needed here.

    // Wait for the new region's event queue to start before sending the initial
    // snapshot — by then objects have started arriving and the circuit is ready.
    const eqSub = this.bot.clientEvents.onEventQueueStateChange.subscribe((evt) => {
      if (!evt.active) return;
      eqSub.unsubscribe();

      if (!this.connected) return;

      // Re-send terrain + environment + objects from all regions
      this.environmentMgr?.sendTerrain().catch(err => {
        console.error('[GodotBridge] Error sending terrain after region change:', err);
      });

      try {
        console.log('[GodotBridge] New region ready, sending initial snapshot');
        this.sceneManager.sendInitialState(this.viewerAdapter);
      } catch (e) {
        console.error('[GodotBridge] Failed to send snapshot after region change:', e);
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

    // Clean up sub-modules (these destroy their owned fetch queues internally)
    this.objectSender.cleanup();
    this.avatarManager.cleanup();
    this.animationManager.cleanup();
    this.materialResolver.cleanup();
    this.faceUpdateBatcher.cleanup();
    this.readinessTracker = null;
    this.sculptFetchQueue = null;
    this.materialFetchQueue = null;
    this.animationFetchQueue = null;

    // Clean up managers
    this.updateCoalescer?.cleanup();
    this.updateCoalescer = null;
    this.environmentMgr?.cleanup();
    this.environmentMgr = null;

    // Destroy texture fetch queue (owned by bridge for stats access)
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
