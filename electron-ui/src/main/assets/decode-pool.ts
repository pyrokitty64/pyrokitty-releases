/**
 * decode-pool.ts — Auto-scaling worker thread pool for JPEG2000 decode via WASM OpenJPEG.
 *
 * Starts with MIN_WORKERS, scales up when queue depth exceeds SCALE_UP_THRESHOLD
 * per worker, and terminates idle extras after IDLE_TIMEOUT_MS to reclaim WASM heap
 * memory (Emscripten's linear memory grows but never shrinks).
 */
import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import { pkDebug } from '../pk-debug';

const MIN_WORKERS = 2;
// ~1 max worker per 2GB of system memory, clamped to [4, 12].
const MAX_WORKERS = Math.min(12, Math.max(4, Math.floor(os.totalmem() / (2 * 1024 * 1024 * 1024))));
// Spawn a new worker when queue depth exceeds this many items per active worker.
const SCALE_UP_THRESHOLD = 4;
// Terminate idle extra workers (beyond MIN_WORKERS) after this many ms.
const IDLE_TIMEOUT_MS = 30_000;

interface PendingJob {
  id: number;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  mode: 'raw' | 'bctex';
}

export interface RawDecodeResult {
  rgbaPixels: Buffer;
  width: number;
  height: number;
}

export interface BctexDecodeResult {
  bctexBuf: Buffer;
  hasAlpha: boolean;
  mipCount: number;
  width: number;
  height: number;
}

interface WorkerEntry {
  worker: Worker;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class DecodePool {
  private entries: WorkerEntry[] = [];
  private idle: WorkerEntry[] = [];
  private queue: { j2cBuffer: Buffer; mode: 'raw' | 'bctex'; resolve: (result: any) => void; reject: (err: Error) => void }[] = [];
  private pending = new Map<number, PendingJob>();
  private nextId = 0;
  private destroyed = false;

  constructor() {
    for (let i = 0; i < MIN_WORKERS; i++) {
      this.spawnWorker();
    }
  }

  private spawnWorker(): WorkerEntry | null {
    if (this.destroyed || this.entries.length >= MAX_WORKERS) return null;
    const workerPath = path.join(__dirname, 'texture-decode-worker.js');
    const w = new Worker(workerPath, { workerData: { workerId: this.entries.length } });
    const entry: WorkerEntry = { worker: w, idleTimer: null };

    w.on('message', (msg: { id: number; rgbaPixels?: Buffer; bctexBuf?: Buffer; hasAlpha?: boolean; mipCount?: number; width?: number; height?: number; error?: string }) => {
      const job = this.pending.get(msg.id);
      if (!job) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        job.reject(new Error(msg.error));
      } else if (job.mode === 'bctex') {
        job.resolve({ bctexBuf: msg.bctexBuf!, hasAlpha: msg.hasAlpha!, mipCount: msg.mipCount!, width: msg.width!, height: msg.height! } as BctexDecodeResult);
      } else {
        job.resolve({ rgbaPixels: msg.rgbaPixels!, width: msg.width!, height: msg.height! } as RawDecodeResult);
      }
      this.idle.push(entry);
      this.startIdleTimer(entry);
      this.drain();
    });
    w.on('error', (err) => {
      console.error('[DecodePool] Worker error:', err);
    });
    w.on('exit', (code) => {
      if (code !== 0 && !this.destroyed) {
        console.error(`[DecodePool] Worker exited with code ${code} — WASM abort? Replacing.`);
        this.removeEntry(entry);
        this.spawnWorker();
      }
    });
    this.entries.push(entry);
    this.idle.push(entry);
    return entry;
  }

  private removeEntry(entry: WorkerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    const idleIdx = this.idle.indexOf(entry);
    if (idleIdx >= 0) this.idle.splice(idleIdx, 1);
  }

  /** Start an idle timer for extra workers (beyond MIN_WORKERS). */
  private startIdleTimer(entry: WorkerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (this.entries.length <= MIN_WORKERS) return;
    entry.idleTimer = setTimeout(() => {
      // Only terminate if still idle and we're above minimum
      if (this.entries.length > MIN_WORKERS && this.idle.includes(entry)) {
        this.removeEntry(entry);
        entry.worker.terminate();
      }
    }, IDLE_TIMEOUT_MS);
  }

  get queueDepth(): number { return this.queue.length; }
  get activeCount(): number { return this.pending.size; }
  get workerCount(): number { return this.entries.length; }

  /** Decode J2C to raw RGBA pixels + dimensions (for GPU compression pipeline). */
  decodeRaw(j2cBuffer: Buffer): Promise<RawDecodeResult> {
    if (this.destroyed) return Promise.reject(new Error('Pool destroyed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ j2cBuffer, mode: 'raw', resolve, reject });
      this.drain();
    });
  }

  /** Decode J2C and compress to BC1/BC3 on CPU (fallback when GPU unavailable). */
  decodeBctex(j2cBuffer: Buffer): Promise<BctexDecodeResult> {
    if (this.destroyed) return Promise.reject(new Error('Pool destroyed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ j2cBuffer, mode: 'bctex', resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    // Scale up if queue is deep and we haven't hit the cap
    while (this.idle.length === 0
      && this.queue.length > this.entries.length * SCALE_UP_THRESHOLD
      && this.entries.length < MAX_WORKERS
      && !this.destroyed) {
      const entry = this.spawnWorker();
      if (!entry) break;
      pkDebug('texture', `[DecodePool] Scaled up to ${this.entries.length} workers (queue=${this.queue.length})`);
    }

    while (this.idle.length > 0 && this.queue.length > 0 && !this.destroyed) {
      const entry = this.idle.pop()!;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      const job = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, { id, resolve: job.resolve, reject: job.reject, mode: job.mode });
      entry.worker.postMessage({ id, j2cBuffer: job.j2cBuffer, mode: job.mode });
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.queue = [];
    for (const entry of this.entries) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }
    for (const job of this.pending.values()) {
      job.reject(new Error('Pool destroyed'));
    }
    this.pending.clear();
    await Promise.all(this.entries.map(e => e.worker.terminate()));
    this.entries = [];
    this.idle = [];
  }
}
