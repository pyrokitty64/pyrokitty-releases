import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { ViewerInstance, ViewerStatus, ConnectionState } from '../../shared/types';
import { accountManager } from './account-manager';
import { gridManager } from './grid-manager';
import { connectionManager, ViewerConnection } from './viewer-connection';
import { metaverseConnectionManager, MetaverseConnection } from './metaverse-connection';
import { voiceRegistry } from '../voice/voice-registry';
import { GodotBridge } from '../bridge/godot-bridge';
import { UnrealBridge } from '../bridge/unreal-bridge';

function getViewerPath(): string {
  if (app.isPackaged) {
    // Production: viewer is in resources/viewer/
    return path.join(process.resourcesPath, 'viewer', 'firestorm-bin.exe');
  } else {
    // Development: viewer is in the build output directory
    const appRoot = app.getAppPath();
    return path.join(appRoot, '..', 'firestorm', 'build-vc170-64', 'newview', 'Release', 'firestorm-bin.exe');
  }
}

const BASE_WS_PORT = 9001;

export class ViewerManager extends EventEmitter {
  private instances: Map<string, ViewerInstance> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private nextWsPort = BASE_WS_PORT;
  // Track which instances should re-login when viewer exits
  private shouldRelogin: Set<string> = new Set();
  // Store password in memory for re-login (needed if not saved to disk)
  private sessionPasswords: Map<string, string> = new Map();
  // Godot bridge instances
  private godotBridges: Map<string, GodotBridge> = new Map();
  private unrealBridges: Map<string, UnrealBridge> = new Map();

  getInstances(): ViewerInstance[] {
    return Array.from(this.instances.values());
  }

  getInstance(id: string): ViewerInstance | undefined {
    return this.instances.get(id);
  }

  getInstanceForAccount(accountId: string): ViewerInstance | undefined {
    return Array.from(this.instances.values()).find(i => i.accountId === accountId);
  }

  private getNextWsPort(): number {
    // Find an unused port
    const usedPorts = new Set(Array.from(this.instances.values()).map(i => i.wsPort));
    while (usedPorts.has(this.nextWsPort)) {
      this.nextWsPort++;
    }
    return this.nextWsPort++;
  }

  /**
   * Launch a session - logs in via node-metaverse first, then optionally hands off to viewer
   */
  async launchViewer(accountId: string, password?: string, options?: { startLocation?: string }): Promise<ViewerInstance> {
    // Check if already running
    const existing = this.getInstanceForAccount(accountId);
    if (existing) {
      throw new Error('Viewer already running for this account');
    }

    // Get account details
    const account = accountManager.getAccount(accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    // Use provided password or saved password
    const loginPassword = password || account.password;
    if (!loginPassword) {
      throw new Error('Password required');
    }

    // Get grid details
    const grid = gridManager.getGrid(account.gridId);
    if (!grid) {
      throw new Error('Grid not found');
    }

    const wsPort = this.getNextWsPort();
    const instanceId = `viewer_${Date.now()}`;

    // Create instance record
    const instance: ViewerInstance = {
      id: instanceId,
      accountId,
      gridId: account.gridId,
      pid: 0,
      wsPort,
      startTime: Date.now(),
      status: 'starting',
      connectionState: 'disconnected',
    };

    this.instances.set(instanceId, instance);
    this.shouldRelogin.add(instanceId);
    this.sessionPasswords.set(instanceId, loginPassword);

    try {
      // Step 1: Create MetaverseConnection and login via node-metaverse
      console.log(`[ViewerManager] Creating metaverse connection for ${account.firstName} ${account.lastName}`);
      const metaverse = metaverseConnectionManager.create(instanceId);

      // Forward state changes to instance
      metaverse.on('state-change', (state: ConnectionState) => {
        this.updateConnectionState(instanceId, state);
      });

      this.updateConnectionState(instanceId, 'logging_in');

      await metaverse.login({
        firstName: account.firstName,
        lastName: account.lastName,
        password: loginPassword,
        gridLoginUri: grid.loginUri,
        startLocation: options?.startLocation,
        mfaHash: account.mfaHash,
      });

      console.log(`[ViewerManager] Login successful, connected to metaverse`);
      this.updateStatus(instanceId, 'running');

      // Set region name now that we're connected
      const regionName = metaverse.getRegionName();
      if (regionName) {
        this.updateRegionName(instanceId, regionName);
      }

      // Save mfaHash if server returned one
      const mfaHash = metaverse.getLastMfaHash();
      if (mfaHash) {
        accountManager.updateAccount(account.id, { mfaHash });
      }

      // Start voice sidecar with bot caps
      try {
        const vm = voiceRegistry.create(instanceId);
        vm.start();
        await vm.connectWithBot(metaverse.getBot());
      } catch (err) {
        console.warn(`[ViewerManager] Voice connect failed (non-fatal):`, err);
      }

      return instance;

    } catch (error) {
      // If MFA is pending, keep the instance alive for token submission
      const mc = metaverseConnectionManager.get(instanceId);
      if (mc?.connectionState === 'mfa_pending') {
        console.log(`[ViewerManager] MFA required for ${account.firstName} ${account.lastName}`);
        return instance;
      }
      console.error(`[ViewerManager] Launch failed:`, error);
      await this.cleanup(instanceId);
      throw error;
    }
  }

  /**
   * Launch the viewer for an existing metaverse session.
   * Firestorm will log in with CLI params, which automatically disconnects node-metaverse.
   * When viewer exits, we re-login to node-metaverse.
   */
  async launchFirestormForInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error('Instance not found');
    }

    if (instance.connectionState !== 'metaverse_connected') {
      throw new Error(`Cannot launch viewer: instance is ${instance.connectionState}, expected metaverse_connected`);
    }

    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      throw new Error('Metaverse connection not found');
    }

    const account = accountManager.getAccount(instance.accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    const grid = gridManager.getGrid(instance.gridId);
    if (!grid) {
      throw new Error('Grid not found');
    }

    // Get password from session (set during initial login) or account
    const loginPassword = this.sessionPasswords.get(instanceId) || account.password;
    if (!loginPassword) {
      throw new Error('Password required for viewer launch');
    }

    // Stop Godot viewer if running (can't run both simultaneously)
    const godotBridge = this.godotBridges.get(instanceId);
    if (godotBridge?.isActive) {
      console.log(`[ViewerManager] Stopping Godot viewer before launching Firestorm`);
      godotBridge.stop();
      this.godotBridges.delete(instanceId);
      instance.godotBridgeActive = false;
      this.emit('status-update', instance);
    }

    // Stop Unreal viewer if running (can't run both simultaneously)
    const unrealBridge = this.unrealBridges.get(instanceId);
    if (unrealBridge?.isActive) {
      console.log(`[ViewerManager] Stopping Unreal viewer before launching Firestorm`);
      unrealBridge.stop();
      this.unrealBridges.delete(instanceId);
      instance.unrealBridgeActive = false;
      this.emit('status-update', instance);
    }

    console.log(`[ViewerManager] Launching viewer for ${account.firstName} ${account.lastName}`);

    // Launch viewer with standard CLI login - this will auto-disconnect node-metaverse
    await this.launchFirestormWithLogin(
      instanceId,
      instance,
      account.firstName,
      account.lastName,
      loginPassword,
      grid.nick,
      instance.wsPort
    );
  }

  /**
   * Launch the Godot 3D viewer sidecar for an existing metaverse session.
   * Node-metaverse stays connected and streams object data to Godot.
   */
  async launchGodotViewerForInstance(instanceId: string, vrMode = false): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error('Instance not found');
    }

    if (instance.connectionState !== 'metaverse_connected') {
      // If Firestorm is running, stop it and wait for node-metaverse re-login
      const viewerProcess = this.processes.get(instanceId);
      if (viewerProcess) {
        console.log(`[ViewerManager] Stopping Firestorm before launching Godot`);
        await this.stopViewerAndWaitForReconnect(instanceId);
      } else {
        throw new Error(`Cannot launch Godot: instance is ${instance.connectionState}, expected metaverse_connected`);
      }
    }

    // Check if already running
    const existing = this.godotBridges.get(instanceId);
    if (existing?.isActive) {
      // Stop the existing one
      existing.stop();
      this.godotBridges.delete(instanceId);
      instance.godotBridgeActive = false;
      this.emit('status-update', instance);
      return;
    }

    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      throw new Error('Metaverse connection not found');
    }

    const bot = metaverse.getBot();
    if (!bot) {
      throw new Error('Bot not available');
    }

    const sceneManager = metaverse.getSceneManager();
    if (!sceneManager) {
      throw new Error('SceneManager not available');
    }

    console.log(`[ViewerManager] Launching Godot viewer for ${instanceId}`);

    const bridge = new GodotBridge(bot, sceneManager, {
      vrMode,
      objectAnimationBuffer: metaverse.getObjectAnimationBuffer(),
      avatarAnimationBuffer: metaverse.getAvatarAnimationBuffer(),
      avatarAppearanceBuffer: metaverse.getAvatarAppearanceBuffer(),
      visualParamBuffer: metaverse.getVisualParamBuffer(),
    });
    this.godotBridges.set(instanceId, bridge);

    bridge.on('crash', (message: string) => {
      const inst = this.instances.get(instanceId);
      if (inst) {
        inst.statusMessage = message;
        this.emit('status-update', inst);
      }
    });

    bridge.on('exit', () => {
      console.log(`[ViewerManager] Godot bridge exited for ${instanceId}`);
      this.godotBridges.delete(instanceId);
      const inst = this.instances.get(instanceId);
      if (inst) {
        inst.godotBridgeActive = false;
        this.emit('status-update', inst);
      }
    });

    await bridge.start();

    instance.godotBridgeActive = true;
    this.emit('status-update', instance);
  }

  /**
   * Launch the Unreal Engine 5 viewer sidecar for an existing metaverse session.
   * Mirrors the Godot launch flow but spawns UE5 instead.
   */
  async launchUnrealViewerForInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error('Instance not found');
    }

    if (instance.connectionState !== 'metaverse_connected') {
      const viewerProcess = this.processes.get(instanceId);
      if (viewerProcess) {
        console.log(`[ViewerManager] Stopping Firestorm before launching Unreal`);
        await this.stopViewerAndWaitForReconnect(instanceId);
      } else {
        throw new Error(`Cannot launch Unreal: instance is ${instance.connectionState}, expected metaverse_connected`);
      }
    }

    // Check if already running — toggle off
    const existing = this.unrealBridges.get(instanceId);
    if (existing?.isActive) {
      existing.stop();
      this.unrealBridges.delete(instanceId);
      instance.unrealBridgeActive = false;
      this.emit('status-update', instance);
      return;
    }

    // Stop Godot if running (can't run both simultaneously)
    const godotBridge = this.godotBridges.get(instanceId);
    if (godotBridge?.isActive) {
      console.log(`[ViewerManager] Stopping Godot viewer before launching Unreal`);
      godotBridge.stop();
      this.godotBridges.delete(instanceId);
      instance.godotBridgeActive = false;
    }

    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      throw new Error('Metaverse connection not found');
    }

    const bot = metaverse.getBot();
    if (!bot) {
      throw new Error('Bot not available');
    }

    const sceneManager = metaverse.getSceneManager();
    if (!sceneManager) {
      throw new Error('SceneManager not available');
    }

    console.log(`[ViewerManager] Launching Unreal viewer for ${instanceId}`);

    const bridge = new UnrealBridge(bot, sceneManager, {
      objectAnimationBuffer: metaverse.getObjectAnimationBuffer(),
      avatarAnimationBuffer: metaverse.getAvatarAnimationBuffer(),
      avatarAppearanceBuffer: metaverse.getAvatarAppearanceBuffer(),
      visualParamBuffer: metaverse.getVisualParamBuffer(),
    });
    this.unrealBridges.set(instanceId, bridge);

    bridge.on('crash', (message: string) => {
      const inst = this.instances.get(instanceId);
      if (inst) {
        inst.statusMessage = message;
        this.emit('status-update', inst);
      }
    });

    bridge.on('exit', () => {
      console.log(`[ViewerManager] Unreal bridge exited for ${instanceId}`);
      this.unrealBridges.delete(instanceId);
      const inst = this.instances.get(instanceId);
      if (inst) {
        inst.unrealBridgeActive = false;
        this.emit('status-update', inst);
      }
    });

    await bridge.start();

    instance.unrealBridgeActive = true;
    this.emit('status-update', instance);
  }

  /**
   * Launch the viewer process with CLI login parameters.
   * Firestorm logs in normally, which auto-disconnects node-metaverse.
   * WebSocket is used only for chat relay.
   */
  private async launchFirestormWithLogin(
    instanceId: string,
    instance: ViewerInstance,
    firstName: string,
    lastName: string,
    password: string,
    gridNick: string,
    wsPort: number
  ): Promise<void> {

    const viewerPath = getViewerPath();
    const args: string[] = [
      '--login', firstName, lastName, password,
      '--grid', gridNick,
      '--set', 'PKWebSocketPort', wsPort.toString(),
    ];

    console.log(`[ViewerManager] Launching viewer`);
    console.log(`[ViewerManager] Command: ${viewerPath} ${args.map(a => a === password ? '***' : a).join(' ')}`);

    const childProcess = spawn(viewerPath, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    instance.pid = childProcess.pid || 0;
    this.processes.set(instanceId, childProcess);

    // Update state - viewer is now handling login
    this.updateConnectionState(instanceId, 'handoff_in_progress');

    // Handle process events
    childProcess.on('spawn', () => {
      console.log(`[ViewerManager] Viewer process spawned`);
    });

    childProcess.stdout?.on('data', (data) => {
      console.log(`[Viewer ${instanceId}] ${data}`);
    });

    childProcess.stderr?.on('data', (data) => {
      console.error(`[Viewer ${instanceId}] ${data}`);
    });

    childProcess.on('error', (error) => {
      console.error(`[Viewer ${instanceId}] Error:`, error);
      this.updateStatus(instanceId, 'crashed');
    });

    childProcess.on('exit', (code, signal) => {
      console.log(`[Viewer ${instanceId}] Exited with code ${code}, signal ${signal}`);
      this.handleViewerExit(instanceId);
    });

    // Schedule WebSocket connection for chat relay (viewer needs time to start)
    this.scheduleWebSocketConnect(instanceId, wsPort);
  }

  /**
   * Handle viewer process exit - re-login to node-metaverse
   */
  private async handleViewerExit(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);

    // Detach voice from viewer before disconnecting WebSocket
    const viewerConn = connectionManager.getConnection(instanceId);
    if (viewerConn) {
      voiceRegistry.get(instanceId)?.detachFromViewer(viewerConn);
    }

    // Disconnect WebSocket
    connectionManager.disconnect(instanceId);
    this.processes.delete(instanceId);

    // Check if we should re-login
    if (!instance || !this.shouldRelogin.has(instanceId)) {
      this.cleanupInstance(instanceId);
      return;
    }

    // Get account and password for re-login
    const account = accountManager.getAccount(instance.accountId);
    const grid = gridManager.getGrid(instance.gridId);
    const password = this.sessionPasswords.get(instanceId) || account?.password;

    if (!account || !grid || !password) {
      console.log(`[ViewerManager] Cannot re-login: missing account/grid/password`);
      this.cleanupInstance(instanceId);
      return;
    }

    console.log(`[ViewerManager] Viewer exited, re-logging in to node-metaverse...`);

    try {
      // Remove old metaverse connection if it exists
      await metaverseConnectionManager.remove(instanceId);

      // Create new connection and re-login
      const metaverse = metaverseConnectionManager.create(instanceId);

      // Forward state changes to instance
      metaverse.on('state-change', (state: ConnectionState) => {
        this.updateConnectionState(instanceId, state);
      });

      this.updateConnectionState(instanceId, 'logging_in');
      this.updateStatus(instanceId, 'starting');

      await metaverse.login({
        firstName: account.firstName,
        lastName: account.lastName,
        password,
        gridLoginUri: grid.loginUri,
        mfaHash: account.mfaHash,
      });

      console.log(`[ViewerManager] Re-login successful, connected to metaverse`);
      this.updateStatus(instanceId, 'running');

      // Save mfaHash if server returned one
      const mfaHash = metaverse.getLastMfaHash();
      if (mfaHash) {
        accountManager.updateAccount(account.id, { mfaHash });
      }

      // Update region name
      const regionName = metaverse.getRegionName();
      if (regionName) {
        this.updateRegionName(instanceId, regionName);
      }

      // Reconnect voice with bot caps
      try {
        let vm = voiceRegistry.get(instanceId);
        if (!vm) {
          vm = voiceRegistry.create(instanceId);
          vm.start();
        }
        await vm.connectWithBot(metaverse.getBot());
      } catch (err) {
        console.warn(`[ViewerManager] Voice reconnect failed (non-fatal):`, err);
      }

    } catch (error) {
      // If MFA is pending, keep instance alive for token submission
      const mc = metaverseConnectionManager.get(instanceId);
      if (mc?.connectionState === 'mfa_pending') {
        console.log(`[ViewerManager] MFA required on re-login for ${account.firstName} ${account.lastName}`);
        return;
      }
      console.error(`[ViewerManager] Re-login failed:`, error);
      this.cleanupInstance(instanceId);
      await metaverseConnectionManager.remove(instanceId);
    }
  }

  /**
   * Stop the viewer process gracefully and wait for node-metaverse to re-login.
   * Unlike stopViewer(), this keeps shouldRelogin set so handleViewerExit() triggers re-login.
   */
  private async stopViewerAndWaitForReconnect(instanceId: string): Promise<void> {
    const connection = connectionManager.getConnection(instanceId);
    if (connection?.isConnected) {
      connection.requestQuit();
    }

    const childProcess = this.processes.get(instanceId);
    if (childProcess) {
      // Force kill after 10s if graceful quit doesn't work
      const forceKillTimer = setTimeout(() => {
        if (this.processes.has(instanceId)) {
          console.log(`[ViewerManager] Force-killing viewer ${instanceId} for Godot switch`);
          childProcess.kill('SIGKILL');
        }
      }, 10000);

      // Wait for exit
      await new Promise<void>((resolve) => {
        childProcess.once('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }

    // Now wait for handleViewerExit() to re-login to node-metaverse
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener('status-update', onUpdate);
        reject(new Error('Timed out waiting for metaverse reconnect after stopping viewer'));
      }, 30000);

      const onUpdate = (inst: ViewerInstance) => {
        if (inst.id !== instanceId) return;
        if (inst.connectionState === 'metaverse_connected') {
          clearTimeout(timeout);
          this.removeListener('status-update', onUpdate);
          resolve();
        } else if (inst.connectionState === 'disconnected' && !this.instances.has(instanceId)) {
          clearTimeout(timeout);
          this.removeListener('status-update', onUpdate);
          reject(new Error('Instance disconnected while waiting for reconnect'));
        }
      };

      // Check if already reconnected (race condition)
      const current = this.instances.get(instanceId);
      if (current?.connectionState === 'metaverse_connected') {
        clearTimeout(timeout);
        resolve();
        return;
      }

      this.on('status-update', onUpdate);
    });
  }

  private cleanupInstance(instanceId: string): void {
    this.updateStatus(instanceId, 'disconnected');
    this.updateConnectionState(instanceId, 'disconnected');
    this.instances.delete(instanceId);
    this.shouldRelogin.delete(instanceId);
    this.sessionPasswords.delete(instanceId);
  }

  /**
   * Legacy launch method - directly launches viewer without metaverse pre-login
   * Kept for backward compatibility
   */
  async launchViewerDirect(accountId: string, password?: string): Promise<ViewerInstance> {
    // Check if already running
    const existing = this.getInstanceForAccount(accountId);
    if (existing) {
      throw new Error('Viewer already running for this account');
    }

    // Get account details
    const account = accountManager.getAccount(accountId);
    if (!account) {
      throw new Error('Account not found');
    }

    // Use provided password or saved password
    const loginPassword = password || account.password;
    if (!loginPassword) {
      throw new Error('Password required');
    }

    // Get grid details
    const grid = gridManager.getGrid(account.gridId);
    if (!grid) {
      throw new Error('Grid not found');
    }

    const wsPort = this.getNextWsPort();
    const instanceId = `viewer_${Date.now()}`;

    // Build command line arguments
    const args: string[] = [
      '--login', account.firstName, account.lastName, loginPassword,
      '--grid', grid.nick,
      '--wsport', wsPort.toString(),
    ];

    const viewerPath = getViewerPath();
    console.log(`Launching viewer for ${account.firstName} ${account.lastName} on ${grid.name}`);
    console.log(`Command: ${viewerPath} ${args.map(a => a === loginPassword ? '***' : a).join(' ')}`);

    // Spawn the viewer process
    const process = spawn(viewerPath, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const instance: ViewerInstance = {
      id: instanceId,
      accountId,
      gridId: account.gridId,
      pid: process.pid || 0,
      wsPort,
      startTime: Date.now(),
      status: 'starting',
      connectionState: 'disconnected',
    };

    this.instances.set(instanceId, instance);
    this.processes.set(instanceId, process);

    // Handle process events
    process.on('spawn', () => {
      this.updateStatus(instanceId, 'running');
      // Try to connect via WebSocket after viewer has time to start
      this.scheduleWebSocketConnect(instanceId, wsPort);
    });

    process.stdout?.on('data', (data) => {
      console.log(`[Viewer ${instanceId}] ${data}`);
    });

    process.stderr?.on('data', (data) => {
      console.error(`[Viewer ${instanceId}] ${data}`);
    });

    process.on('error', (error) => {
      console.error(`[Viewer ${instanceId}] Error:`, error);
      this.updateStatus(instanceId, 'crashed');
    });

    process.on('exit', (code, signal) => {
      console.log(`[Viewer ${instanceId}] Exited with code ${code}, signal ${signal}`);
      this.updateStatus(instanceId, 'disconnected');
      this.cleanup(instanceId);
    });

    return instance;
  }

  async stopViewer(instanceId: string): Promise<boolean> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return false;
    }

    console.log(`[ViewerManager] Stopping viewer ${instanceId}`);

    // Prevent re-login on exit (user explicitly stopped)
    this.shouldRelogin.delete(instanceId);

    // Show disconnecting state in UI
    this.updateConnectionState(instanceId, 'disconnecting');

    // Tell the viewer to quit gracefully via WebSocket
    const connection = connectionManager.getConnection(instanceId);
    if (connection?.isConnected) {
      console.log(`[ViewerManager] Sending requestQuit to viewer ${instanceId}`);
      connection.requestQuit();
    }

    const childProcess = this.processes.get(instanceId);
    if (childProcess) {
      // Wait for viewer to exit gracefully (it sends logout to SL then quits)
      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          if (this.processes.has(instanceId)) {
            console.log(`[ViewerManager] Force-killing viewer ${instanceId}`);
            childProcess.kill('SIGKILL');
          }
          resolve();
        }, 10000);

        childProcess.once('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    } else {
      await this.cleanup(instanceId);
    }

    return true;
  }

  /**
   * Submit an MFA token for a pending instance. Completes login.
   */
  async submitMfaToken(instanceId: string, token: string, remember: boolean = false): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error('Instance not found');
    }

    const metaverse = metaverseConnectionManager.get(instanceId);
    if (!metaverse) {
      throw new Error('Metaverse connection not found');
    }

    await metaverse.submitMfaToken(token);

    console.log(`[ViewerManager] MFA login successful`);
    this.updateStatus(instanceId, 'running');

    // Save mfaHash for future logins (only if user opted in)
    if (remember) {
      const account = accountManager.getAccount(instance.accountId);
      const mfaHash = metaverse.getLastMfaHash();
      if (account && mfaHash) {
        accountManager.updateAccount(account.id, { mfaHash });
      }
    }

    // Set region name
    const regionName = metaverse.getRegionName();
    if (regionName) {
      this.updateRegionName(instanceId, regionName);
    }

  }

  private updateStatus(instanceId: string, status: ViewerStatus): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.status = status;
      this.emit('status-update', instance);
    }
  }

  private updateConnectionState(instanceId: string, state: ConnectionState): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      const prevState = instance.connectionState;
      instance.connectionState = state;
      this.emit('status-update', instance);

      // If we went from connected to disconnected unexpectedly (e.g. kicked by
      // another client logging in), fully clean up the instance so the user
      // can log in again.
      if (prevState === 'metaverse_connected' && state === 'disconnected') {
        console.log(`[ViewerManager] Unexpected disconnect for ${instanceId} — cleaning up`);
        this.cleanup(instanceId).catch((err) => {
          console.error(`[ViewerManager] Cleanup after disconnect failed:`, err);
        });
      }
    }
  }

  private updateRegionName(instanceId: string, regionName: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.regionName = regionName;
      this.emit('status-update', instance);
    }
  }

  private async cleanup(instanceId: string): Promise<void> {
    // Stop Godot bridge if running
    const bridge = this.godotBridges.get(instanceId);
    if (bridge) {
      bridge.stop();
      this.godotBridges.delete(instanceId);
    }

    // Stop Unreal bridge if running
    const unrealBridge = this.unrealBridges.get(instanceId);
    if (unrealBridge) {
      unrealBridge.stop();
      this.unrealBridges.delete(instanceId);
    }

    // Disconnect voice
    voiceRegistry.remove(instanceId);

    connectionManager.disconnect(instanceId);
    await metaverseConnectionManager.remove(instanceId);
    this.processes.delete(instanceId);
    this.cleanupInstance(instanceId);
  }

  private scheduleWebSocketConnect(instanceId: string, port: number, attempt = 1): void {
    const maxAttempts = 10;
    const delayMs = 3000; // 3 seconds between attempts

    setTimeout(() => {
      const instance = this.instances.get(instanceId);
      if (!instance || instance.status === 'disconnected' || instance.status === 'crashed') {
        return; // Viewer is gone, don't try to connect
      }

      console.log(`[ViewerManager] WebSocket connect attempt ${attempt}/${maxAttempts} for ${instanceId}`);

      const connection = connectionManager.connect(instanceId, port);

      connection.once('connected', () => {
        this.updateStatus(instanceId, 'connected');
        this.updateConnectionState(instanceId, 'viewer_connected');
        // Auto-subscribe to chat events
        connection.subscribeToChat('all');
        // Hide native chat UI since Electron handles it
        connection.setChatVisible(false);
        // Switch voice to viewer caps
        voiceRegistry.get(instanceId)?.connectWithViewer(connection).catch(err => {
          console.warn(`[ViewerManager] Voice switch to viewer failed (non-fatal):`, err);
        });
      });

      connection.once('error', () => {
        if (attempt < maxAttempts) {
          // Retry
          this.scheduleWebSocketConnect(instanceId, port, attempt + 1);
        } else {
          console.warn(`[ViewerManager] Failed to connect to viewer ${instanceId} after ${maxAttempts} attempts`);
        }
      });

      connection.connect();
    }, delayMs);
  }

  getConnection(instanceId: string): ViewerConnection | undefined {
    return connectionManager.getConnection(instanceId);
  }

  async stopAll(): Promise<void> {
    // Stop all Godot bridges
    for (const [, bridge] of this.godotBridges) {
      bridge.stop();
    }
    this.godotBridges.clear();

    // Stop all Unreal bridges
    for (const [, bridge] of this.unrealBridges) {
      bridge.stop();
    }
    this.unrealBridges.clear();

    // Stop all voice sidecars
    voiceRegistry.stopAll();

    // Tell all viewers to quit gracefully before disconnecting
    for (const [instanceId] of this.instances) {
      await this.stopViewer(instanceId);
    }
    connectionManager.disconnectAll();
    await metaverseConnectionManager.removeAll();
    this.shouldRelogin.clear();
    this.sessionPasswords.clear();
  }

  /**
   * Get the MetaverseConnection for an instance
   */
  getMetaverseConnection(instanceId: string): MetaverseConnection | undefined {
    return metaverseConnectionManager.get(instanceId);
  }
}

export const viewerManager = new ViewerManager();
