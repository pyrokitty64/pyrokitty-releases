import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { setupIpcHandlers } from './ipc-handlers';
import { gridManager } from './network/grid-manager';
import { accountManager } from './network/account-manager';
import { viewerManager } from './network/viewer-manager';
import { chatLogManager } from './ui/chat-log-manager';
import { IPC_CHANNELS } from '../shared/types';
import { setMapWindow, getMapWindow } from './ui/map-window';
import { set3DMapWindow, get3DMapWindow } from './ui/map3d-window';
import { voiceRegistry } from './voice/voice-registry';
import { InventoryFolder } from '../../node-metaverse/dist/lib/classes/InventoryFolder';
import { initGpuCompressWindow, destroyGpuCompressWindow } from './assets/gpu-compress-window';
import { getSavedBounds, trackWindow } from './ui/window-state-manager';
import { ensureDotnet } from './dotnet-check';

// Linux-specific Chromium tweaks (must run before app.whenReady())
if (process.platform === 'linux') {
  // Disable GPU acceleration — Electron's Chromium GPU process contends with Godot's
  // Vulkan usage on the same (often integrated) GPU, triggering libglib assertions.
  // Electron is UI-only (no 3D), so software rendering is fine.
  app.disableHardwareAcceleration();

  // Suppress Chromium's ERROR-level stderr spam (GLib-GObject g_object_ref/unref
  // assertion failures from GTK/GIO internals). We have our own file logger.
  app.commandLine.appendSwitch('log-level', '3');
}

// Ensure consistent userData path in dev mode (npx electron defaults to "Electron")
app.setName('pyrokitty-ui');
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'pyrokitty-ui'));
}

function getIconPath(filename: string): string {
  const iconsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(__dirname, '..', '..', '..', 'icons');
  return path.join(iconsDir, filename);
}

// Set node-metaverse inventory cache to writable location (not inside app.asar)
InventoryFolder.cacheBasePath = path.join(app.getPath('userData'), 'asset-cache', 'inventory');

// ── Global file logger ─────────────────────────────────────
// Tee console.log/warn/error to a log file in userData
{
  const launchStamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const logPath = path.join(app.getPath('userData'), `pyrokitty-${launchStamp}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  logStream.write(`=== PyroKitty started ${new Date().toISOString()} ===\n`);

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const write = (prefix: string, args: unknown[]) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ');
    logStream.write(`${prefix}${msg}\n`);
  };

  console.log = (...args: unknown[]) => { origLog(...args); write('', args); };
  console.warn = (...args: unknown[]) => { origWarn(...args); write('[WARN] ', args); };
  console.error = (...args: unknown[]) => { origError(...args); write('[ERROR] ', args); };
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let cleanupDone = false;

/** Parse --login First Last password [--grid nick] from process.argv */
function parseCliLogin(argv: string[]): { firstName: string; lastName: string; password: string; grid?: string } | null {
  const idx = argv.indexOf('--login');
  if (idx < 0 || idx + 3 >= argv.length) return null;
  const firstName = argv[idx + 1];
  const lastName = argv[idx + 2];
  const password = argv[idx + 3];
  // Don't treat flags as credentials
  if (firstName.startsWith('-') || lastName.startsWith('-') || password.startsWith('-')) return null;
  const gridIdx = argv.indexOf('--grid');
  const grid = (gridIdx >= 0 && gridIdx + 1 < argv.length) ? argv[gridIdx + 1] : undefined;
  return { firstName, lastName, password, grid };
}

function createMapWindow(): void {
  const existing = getMapWindow();
  if (existing) {
    existing.focus();
    return;
  }

  const saved = getSavedBounds('map');
  const win = new BrowserWindow({
    width: saved?.width ?? 900,
    height: saved?.height ?? 700,
    ...(saved?.x != null && saved?.y != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 400,
    minHeight: 300,
    title: `World Map - PyroKitty ${app.getVersion()}`,
    icon: getIconPath('map-icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    backgroundColor: '#1a1a2e',
  });
  trackWindow(win, 'map');
  const mapTitle = `World Map — PyroKitty ${app.getVersion()}`;
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(mapTitle);
  });

  const htmlPath = path.join(__dirname, '../map-renderer/map.html');
  win.loadFile(htmlPath);

  win.on('closed', () => {
    setMapWindow(null);
  });

  setMapWindow(win);
}

function create3DMapWindow(): void {
  const existing = get3DMapWindow();
  if (existing) {
    existing.focus();
    return;
  }

  const saved = getSavedBounds('map3d');
  const win = new BrowserWindow({
    width: saved?.width ?? 1100,
    height: saved?.height ?? 800,
    ...(saved?.x != null && saved?.y != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 600,
    minHeight: 400,
    title: `3D World Map — PyroKitty ${app.getVersion()}`,
    icon: getIconPath('map-icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    backgroundColor: '#060612',
  });
  trackWindow(win, 'map3d');
  const mapTitle = `3D World Map — PyroKitty ${app.getVersion()}`;
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(mapTitle);
  });

  const htmlPath = path.join(__dirname, '../3d-map/index.html');
  win.loadFile(htmlPath);

  win.on('closed', () => {
    set3DMapWindow(null);
  });

  set3DMapWindow(win);
}

async function performCleanup(): Promise<void> {
  if (cleanupDone) return;
  cleanupDone = true;
  console.log('[App] Logging out from SL and cleaning up...');
  chatLogManager.flushAll();
  destroyGpuCompressWindow();
  await viewerManager.stopAll();
  console.log('[App] Cleanup complete');
}

async function createWindow(): Promise<void> {
  const iconPath = getIconPath('pyrokitty2.ico');

  const saved = getSavedBounds('main');
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 920,
    height: saved?.height ?? 700,
    ...(saved?.x != null && saved?.y != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 600,
    minHeight: 500,
    title: `PyroKitty ${app.getVersion()}`,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    backgroundColor: '#1a1a2e',
  });
  trackWindow(mainWindow, 'main');
  if (saved?.isMaximized) mainWindow.maximize();
  const versionTitle = `PyroKitty ${app.getVersion()}`;
  mainWindow.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow!.setTitle(versionTitle);
  });

  // Initialize GPU compression (hidden BrowserWindow for WebGPU)
  initGpuCompressWindow().catch((err) => {
    console.warn('[App] GPU compression init failed (will use CPU fallback):', err.message);
  });

  // Initialize managers
  await gridManager.initialize();
  accountManager.initialize();

  // Setup IPC handlers
  setupIpcHandlers(mainWindow);

  // Map window IPC
  ipcMain.handle(IPC_CHANNELS.MAP_OPEN, async () => {
    createMapWindow();
  });

  ipcMain.handle(IPC_CHANNELS.MAP_3D_OPEN, async () => {
    create3DMapWindow();
  });

  // Forward selected account from main renderer to map window + voice routing
  ipcMain.on(IPC_CHANNELS.MAP_SELECTED_ACCOUNT, (_event, instanceId: string | null) => {
    voiceRegistry.setSelectedInstance(instanceId);
    const mw = getMapWindow();
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send(IPC_CHANNELS.MAP_SELECTED_ACCOUNT, instanceId);
    }
  });

  // Load the renderer
  // __dirname is dist/main/, renderer is at dist/renderer/
  const htmlPath = path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(htmlPath);

  // Right-click context menu with Copy/Select All
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];
    if (params.selectionText) {
      menuItems.push({ label: 'Copy', role: 'copy' });
    }
    menuItems.push({ label: 'Select All', role: 'selectAll' });
    if (params.isEditable) {
      menuItems.push({ label: 'Cut', role: 'cut' });
      menuItems.push({ label: 'Paste', role: 'paste' });
    }
    if (menuItems.length > 0) {
      Menu.buildFromTemplate(menuItems).popup({ window: mainWindow! });
    }
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // CLI login: --login First Last password [--grid gridnick]
  // Also supports AUTO_LOGIN env var for saved accounts
  const cliLogin = parseCliLogin(process.argv);
  const autoLogin = cliLogin ? null : process.env.AUTO_LOGIN;

  if (cliLogin || autoLogin) {
    setTimeout(async () => {
      try {
        let accountId: string;
        let password: string;

        if (cliLogin) {
          // CLI credentials — find or create a temporary account entry
          const grids = gridManager.getAllGrids();
          const grid = cliLogin.grid
            ? grids.find(g => g.nick.toLowerCase() === cliLogin.grid!.toLowerCase() || g.id === cliLogin.grid)
            : grids[0];
          if (!grid) {
            console.error(`[AutoLogin] Grid not found: ${cliLogin.grid}`);
            return;
          }
          // Look for existing saved account
          const account = accountManager.getAllAccounts().find(
            a => a.firstName.toLowerCase() === cliLogin.firstName.toLowerCase()
              && a.lastName.toLowerCase() === cliLogin.lastName.toLowerCase()
              && a.gridId === grid.id
          );
          if (!account) {
            // Create a transient account (in-memory only, not saved to disk)
            accountId = `cli_${Date.now()}`;
            accountManager.addTransientAccount({
              id: accountId,
              gridId: grid.id,
              firstName: cliLogin.firstName,
              lastName: cliLogin.lastName,
            });
            console.log(`[AutoLogin] Created transient account for ${cliLogin.firstName} ${cliLogin.lastName} on ${grid.name}`);
          } else {
            accountId = account.id;
          }
          password = cliLogin.password;
          console.log(`[AutoLogin] CLI login: ${cliLogin.firstName} ${cliLogin.lastName} on ${grid.name}`);
        } else {
          // ENV-based auto-login with saved accounts
          const accounts = accountManager.getAllAccounts();
          const account = autoLogin === '1'
            ? accounts[0]
            : accounts.find(a => a.id === autoLogin || a.firstName.toLowerCase() === autoLogin!.toLowerCase());
          if (!account) {
            console.warn(`[AutoLogin] Account not found: ${autoLogin}`);
            return;
          }
          accountId = account.id;
          password = account.password || '';
          console.log(`[AutoLogin] Launching ${account.firstName} ${account.lastName}...`);
        }

        await viewerManager.launchViewer(accountId, password);
        console.log('[AutoLogin] Login complete');
        // Auto-launch Godot viewer after a brief delay
        const instances = viewerManager.getInstances();
        if (instances.length > 0) {
          const inst = instances[0];
          setTimeout(async () => {
            try {
              console.log('[AutoLogin] Launching Godot viewer...');
              await viewerManager.launchGodotViewerForInstance(inst.id);
              console.log('[AutoLogin] Godot viewer launched');
            } catch (e: any) {
              console.error('[AutoLogin] Godot launch failed:', e.message);
            }
          }, 5000);
        }
      } catch (e: any) {
        console.error('[AutoLogin] Failed:', e.message);
      }
    }, 2000);
  }

  // On Linux, close quits (tray support is unreliable across DEs)
  // On Windows/macOS, hide to tray instead
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      if (process.platform === 'linux') {
        isQuitting = true;
        performCleanup().then(() => app.quit());
      } else {
        event.preventDefault();
        mainWindow?.hide();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Tray is Windows-only — Electron's StatusNotifierItem on Linux is unstable
  // and causes libglib crashes. On Linux, close = quit (see close handler above).
  if (process.platform !== 'linux') {
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip('PyroKitty');

    const showIcon = nativeImage.createFromPath(
      getIconPath('pyrokitty2_16.png')
    );

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `PyroKitty ${app.getVersion()}`,
        icon: showIcon,
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: 'World Map',
        icon: nativeImage.createFromPath(getIconPath('map-icon_16.png')),
        click: () => {
          createMapWindow();
        },
      },
      {
        label: '3D World Map',
        icon: nativeImage.createFromPath(getIconPath('map-icon_16.png')),
        click: () => {
          create3DMapWindow();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: async () => {
          isQuitting = true;
          await performCleanup();
          app.quit();
        },
      },
    ]);

    const showTrayMenu = () => {
      // Win32 requires SetForegroundWindow before TrackPopupMenu or the OS
      // taskbar menu appears on top. Electron's setContextMenu handles this
      // internally but is unreliable (Electron #40937). Instead, we grab
      // foreground focus via a tiny off-screen window before calling
      // popUpContextMenu ourselves.
      const trayFocusWin = new BrowserWindow({
        width: 1, height: 1, x: -100, y: -100,
        show: false, frame: false, skipTaskbar: true,
        transparent: true,
      });
      trayFocusWin.show();
      trayFocusWin.focus();
      tray?.popUpContextMenu(contextMenu);
      trayFocusWin.hide();
      trayFocusWin.close();
    };

    tray.on('click', showTrayMenu);
    tray.on('right-click', showTrayMenu);

    tray.on('double-click', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
  }
}

app.whenReady().then(async () => {
  console.log(`[PyroKitty] v${app.getVersion()} (${app.isPackaged ? 'packaged' : 'dev'})`);
  await ensureDotnet();
  createWindow();
});

app.on('before-quit', (event) => {
  isQuitting = true;

  if (!cleanupDone) {
    // Prevent quit until cleanup finishes
    event.preventDefault();
    performCleanup().then(() => app.quit());
    return;
  }

  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
