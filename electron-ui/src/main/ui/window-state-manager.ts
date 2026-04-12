import * as fs from 'fs';
import * as path from 'path';
import { app, screen, BrowserWindow } from 'electron';

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export type WindowKey = 'main' | 'map' | 'map3d' | 'godot' | 'unreal';

type WindowStateFile = Partial<Record<WindowKey, WindowBounds>>;

const SAVE_DEBOUNCE_MS = 500;

function getStateFilePath(): string {
  return path.join(app.getPath('userData'), 'data', 'window-state.json');
}

function loadState(): WindowStateFile {
  try {
    const filePath = getStateFilePath();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (error) {
    console.warn('[WindowState] Failed to load:', error);
  }
  return {};
}

function saveState(state: WindowStateFile): void {
  try {
    const filePath = getStateFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn('[WindowState] Failed to save:', error);
  }
}

/**
 * Check if at least a portion of the window overlaps any connected display.
 * Requires at least 100px visible in both axes so you can grab the title bar.
 */
function isVisibleOnAnyDisplay(bounds: WindowBounds): boolean {
  const minVisible = 100;
  const displays = screen.getAllDisplays();
  return displays.some(d => {
    const db = d.bounds;
    const overlapX = Math.min(bounds.x + bounds.width, db.x + db.width) - Math.max(bounds.x, db.x);
    const overlapY = Math.min(bounds.y + bounds.height, db.y + db.height) - Math.max(bounds.y, db.y);
    return overlapX >= minVisible && overlapY >= minVisible;
  });
}

/**
 * Get saved bounds for a window key, validated against current displays.
 * Returns undefined if no saved state or saved position is offscreen.
 */
export function getSavedBounds(key: WindowKey): WindowBounds | undefined {
  const state = loadState();
  const bounds = state[key];
  if (!bounds) return undefined;

  if (!isVisibleOnAnyDisplay(bounds)) {
    console.log(`[WindowState] Saved ${key} bounds offscreen, using defaults`);
    return undefined;
  }
  return bounds;
}

/**
 * Track a window's position/size and auto-save on changes.
 * Call this right after creating a BrowserWindow.
 */
/**
 * Save bounds for a non-BrowserWindow (e.g. Godot sidecar).
 */
export function saveExternalBounds(key: WindowKey, bounds: WindowBounds): void {
  const state = loadState();
  state[key] = bounds;
  saveState(state);
}

export function trackWindow(win: BrowserWindow, key: WindowKey): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const state = loadState();
      if (win.isMaximized()) {
        // Keep the last known normal bounds but flag maximized
        state[key] = { ...(state[key] || win.getNormalBounds()), isMaximized: true };
      } else {
        const b = win.getBounds();
        state[key] = { x: b.x, y: b.y, width: b.width, height: b.height };
      }
      saveState(state);
    }, SAVE_DEBOUNCE_MS);
  };

  win.on('moved', scheduleSave);
  win.on('resized', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
}
