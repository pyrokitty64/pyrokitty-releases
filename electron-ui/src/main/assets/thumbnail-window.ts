/**
 * thumbnail-window.ts — Hidden BrowserWindow for 3D thumbnail rendering.
 * Uses Three.js WebGL in a hidden Electron renderer to render GLBs to PNG.
 * Follows the gpu-compress-window.ts IPC pattern.
 */

import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

let thumbWindow: BrowserWindow | null = null;
let thumbAvailable = false;
let readyResolve: ((available: boolean) => void) | null = null;
let nextReqId = 0;

interface PendingRequest {
  resolve: (png: Buffer) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingRequest>();

export interface PrimRenderData {
  glb: Uint8Array;
  position: [number, number, number];
  rotation: [number, number, number, number]; // quaternion xyzw
  scale: [number, number, number];
  textures: Record<number, string>; // faceIndex → absolute file path (jpg/png)
  colors: Record<number, [number, number, number, number]>; // faceIndex → RGBA (0-1)
}

export interface LinksetRenderData {
  prims: PrimRenderData[];
  attachmentPoint?: number;
  rootRotation?: [number, number, number, number]; // SL quaternion xyzw — applied to entire linkset
  /** Per-bone pose for animation thumbnails. Key = joint name, value = {rot, pos} in SL space. */
  bonePose?: Record<string, { rot?: [number, number, number]; pos?: [number, number, number] }>;
}

export function thumbnailWindowAvailable(): boolean {
  return thumbAvailable && thumbWindow !== null && !thumbWindow.isDestroyed();
}

export async function initThumbnailWindow(): Promise<boolean> {
  if (thumbWindow) return thumbAvailable;

  const readyPromise = new Promise<boolean>((resolve) => {
    readyResolve = resolve;
  });

  thumbWindow = new BrowserWindow({
    show: false, // show: true for debugging
    width: 512,
    height: 512,
    title: 'Thumbnail Renderer',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const htmlPath = path.join(__dirname, '../thumbnail-renderer/index.html');
  thumbWindow.loadFile(htmlPath);

  thumbWindow.on('closed', () => {
    thumbWindow = null;
    thumbAvailable = false;
    for (const req of pending.values()) {
      clearTimeout(req.timeoutId);
      req.reject(new Error('Thumbnail window closed'));
    }
    pending.clear();
  });

  ipcMain.once('thumbnail-ready', (_event, msg: { available: boolean }) => {
    thumbAvailable = msg.available;
    console.log(`[Thumbnail] Renderer available: ${thumbAvailable}`);
    if (readyResolve) {
      readyResolve(thumbAvailable);
      readyResolve = null;
    }
  });

  ipcMain.on('thumbnail-log', (_event, msg: string) => {
    console.log(`[ThumbRenderer] ${msg}`);
  });

  ipcMain.on('thumbnail-response', (_event, msg: { id: number; png?: Uint8Array; error?: string }) => {
    const req = pending.get(msg.id);
    if (!req) return;
    pending.delete(msg.id);
    clearTimeout(req.timeoutId);

    if (msg.error) {
      req.reject(new Error(msg.error));
    } else {
      req.resolve(Buffer.from(msg.png!));
    }
  });

  // Timeout the ready signal after 10s
  const timeout = setTimeout(() => {
    if (readyResolve) {
      readyResolve(false);
      readyResolve = null;
    }
  }, 10000);

  const available = await readyPromise;
  clearTimeout(timeout);
  return available;
}

export function destroyThumbnailWindow(): void {
  if (thumbWindow && !thumbWindow.isDestroyed()) {
    thumbWindow.close();
  }
  thumbWindow = null;
  thumbAvailable = false;
}

/**
 * Render a linkset to a PNG thumbnail.
 * Sends the linkset data to the hidden renderer process, which returns a PNG buffer.
 */
export async function renderThumbnail(linkset: LinksetRenderData): Promise<Buffer> {
  if (!thumbWindow || thumbWindow.isDestroyed() || !thumbAvailable) {
    throw new Error('Thumbnail renderer not available');
  }

  const id = nextReqId++;
  return new Promise<Buffer>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Thumbnail render timeout (id=${id})`));
    }, 15000);

    pending.set(id, { resolve, reject, timeoutId });

    thumbWindow!.webContents.send('thumbnail-request', {
      id,
      attachmentPoint: linkset.attachmentPoint,
      rootRotation: linkset.rootRotation,
      bonePose: linkset.bonePose,
      prims: linkset.prims.map(p => ({
        glb: Array.from(p.glb), // Uint8Array → number[] for IPC serialization
        position: p.position,
        rotation: p.rotation,
        scale: p.scale,
        textures: p.textures,
        colors: p.colors,
      })),
    });
  });
}
