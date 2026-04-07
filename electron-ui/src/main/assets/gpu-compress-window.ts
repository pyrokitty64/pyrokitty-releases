/**
 * gpu-compress-window.ts — Hidden BrowserWindow for WebGPU BC1/BC3 texture compression.
 * Uses Electron's Chromium WebGPU support via a hidden renderer process.
 */

import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

let gpuWindow: BrowserWindow | null = null;
let gpuAvailable = false;
let readyResolve: ((available: boolean) => void) | null = null;
let nextReqId = 0;

interface PendingRequest {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingFullRequest {
  resolve: (result: { compressedData: Buffer; mipCount: number }) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingRequest>();
const pendingFull = new Map<number, PendingFullRequest>();

/** Whether GPU compression is available (WebGPU initialized successfully). */
export function gpuCompressionAvailable(): boolean {
  return gpuAvailable && gpuWindow !== null && !gpuWindow.isDestroyed();
}

/**
 * Initialize the hidden GPU compression window.
 * Returns true if WebGPU is available and ready.
 */
export async function initGpuCompressWindow(): Promise<boolean> {
  if (process.env.FORCE_CPU_COMPRESS) {
    console.log('[GpuCompress] FORCE_CPU_COMPRESS set, skipping WebGPU init');
    return false;
  }
  if (gpuWindow) return gpuAvailable;

  const readyPromise = new Promise<boolean>((resolve) => {
    readyResolve = resolve;
  });

  gpuWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Load the GPU compress renderer page
  const htmlPath = path.join(__dirname, '../gpu-compress/index.html');
  gpuWindow.loadFile(htmlPath);

  gpuWindow.on('closed', () => {
    gpuWindow = null;
    gpuAvailable = false;
    for (const req of pending.values()) {
      clearTimeout(req.timeoutId);
      req.reject(new Error('GPU window closed'));
    }
    pending.clear();
    for (const req of pendingFull.values()) {
      clearTimeout(req.timeoutId);
      req.reject(new Error('GPU window closed'));
    }
    pendingFull.clear();
  });

  // Handle ready signal from renderer
  ipcMain.once('gpu-compress-ready', (_event, msg: { available: boolean }) => {
    gpuAvailable = msg.available;
    console.log(`[GpuCompress] WebGPU available: ${gpuAvailable}`);
    if (readyResolve) {
      readyResolve(gpuAvailable);
      readyResolve = null;
    }
  });

  // Handle compression responses (legacy single-mip)
  ipcMain.on('gpu-compress-response', (_event, msg: { id: number; data?: Uint8Array; error?: string }) => {
    const req = pending.get(msg.id);
    if (!req) return;
    pending.delete(msg.id);
    clearTimeout(req.timeoutId);

    if (msg.error) {
      req.reject(new Error(msg.error));
    } else {
      req.resolve(Buffer.from(msg.data!));
    }
  });

  // Handle full pipeline responses
  ipcMain.on('gpu-compress-full-response', (_event, msg: {
    id: number;
    compressedData?: Uint8Array;
    mipCount?: number;
    error?: string;
  }) => {
    const req = pendingFull.get(msg.id);
    if (!req) return;
    pendingFull.delete(msg.id);
    clearTimeout(req.timeoutId);

    if (msg.error) {
      req.reject(new Error(msg.error));
    } else {
      req.resolve({
        compressedData: Buffer.from(msg.compressedData!),
        mipCount: msg.mipCount!,
      });
    }
  });

  // Wait up to 10s for WebGPU init
  const timeoutPromise = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), 10000);
  });

  const result = await Promise.race([readyPromise, timeoutPromise]);
  if (!result) {
    console.warn('[GpuCompress] WebGPU init timed out or failed, falling back to CPU path');
    gpuAvailable = false;
  }

  return gpuAvailable;
}

/**
 * Compress a single RGBA buffer to BC1 or BC3.
 * Returns the raw compressed block data (no header).
 */
export function gpuCompress(
  rgba: Buffer,
  width: number,
  height: number,
  format: 0 | 1, // 0=BC1, 1=BC3
): Promise<Buffer> {
  if (!gpuCompressionAvailable()) {
    return Promise.reject(new Error('GPU compression not available'));
  }

  const id = nextReqId++;

  // Send IPC before creating the Promise to avoid capturing rgba in the closure scope.
  // This lets rgba be GC'd as soon as the caller releases it, rather than being pinned
  // by the timeout closure for 30s.
  gpuWindow!.webContents.send('gpu-compress-request', {
    id,
    rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width,
    height,
    format,
  });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('GPU compression timeout'));
      }
    }, 30000);

    pending.set(id, { resolve, reject, timeoutId });
  });
}

/**
 * Compress RGBA buffer to BC1/BC3 with full GPU pipeline
 * (mipmap gen + compress in one round trip, single GPU submit).
 * Alpha detection done CPU-side by caller.
 */
export function gpuCompressFull(
  rgba: Buffer,
  width: number,
  height: number,
  format: 0 | 1, // 0=BC1, 1=BC3
): Promise<{ compressedData: Buffer; mipCount: number }> {
  if (!gpuCompressionAvailable()) {
    return Promise.reject(new Error('GPU compression not available'));
  }

  const id = nextReqId++;

  // Send IPC before creating the Promise to avoid capturing rgba in the closure scope.
  gpuWindow!.webContents.send('gpu-compress-full-request', {
    id,
    rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width,
    height,
    format,
  });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingFull.has(id)) {
        pendingFull.delete(id);
        reject(new Error('GPU full compression timeout'));
      }
    }, 60000);

    pendingFull.set(id, { resolve, reject, timeoutId });
  });
}

/** Destroy the hidden GPU compression window. */
export function destroyGpuCompressWindow(): void {
  ipcMain.removeAllListeners('gpu-compress-response');
  ipcMain.removeAllListeners('gpu-compress-full-response');
  for (const req of pending.values()) clearTimeout(req.timeoutId);
  for (const req of pendingFull.values()) clearTimeout(req.timeoutId);
  if (gpuWindow && !gpuWindow.isDestroyed()) {
    gpuWindow.destroy();
  }
  gpuWindow = null;
  gpuAvailable = false;
  pending.clear();
  pendingFull.clear();
}
