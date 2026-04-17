/**
 * texture-fetch-queue.ts — Concurrent texture download queue with dedup and caching.
 * Downloads J2C from SL CDN, decodes via worker thread pool,
 * compresses to BC1/BC3 .bctex (GPU when available, CPU fallback), writes to disk cache.
 */

import { AssetType } from '../../../node-metaverse/lib';
import type { Bot } from '../../../node-metaverse/lib';
import { DecodePool } from './decode-pool';
import { GpuCompressQueue } from './gpu-compress-queue';
import { gpuCompressionAvailable } from './gpu-compress-window';
import { TRANSPARENT_TEXTURES, SOLID_COLOR_TEXTURES, WATER_EXCLUSION_TEXTURES, BAKE_MAGIC_UUIDS } from '../bridge/godot-bridge-types';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { pkDebug } from '../pk-debug';

const MAX_CONCURRENT_DOWNLOADS = 32;


// Zero UUID — skip these
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// Bake channel names used in appearance service URLs (index = channel)
const BAKE_CHANNEL_URL_NAMES = [
  'head', 'upper', 'lower', 'eyes', 'skirt', 'hair',
  'leftarm', 'leftleg', 'aux1', 'aux2', 'aux3',
];

export type TextureReadyCallback = (textureUuid: string, cachePath: string, opaque: boolean) => void;

function getCacheDir(): string {
  return path.join(app.getPath('userData'), 'asset-cache', 'textures');
}

/** Valid cache extensions. */
type CacheExt = '.bc1.bctex' | '.bc3.bctex';

/** Recognized cache extensions in priority order (first match wins). */
const EXT_PRIORITY: readonly CacheExt[] = ['.bc1.bctex', '.bc3.bctex'];

/** Extract the full compound extension from a filename. */
function getCacheExt(filename: string): CacheExt | null {
  for (const ext of EXT_PRIORITY) {
    if (filename.endsWith(ext)) return ext;
  }
  return null;
}

const cachedTextures = new Map<string, CacheExt>();

export async function initTextureCache(): Promise<void> {
  const dir = getCacheDir();
  await fs.promises.mkdir(dir, { recursive: true });
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const ext = getCacheExt(entry);
    if (!ext) continue;
    const uuid = entry.slice(0, entry.length - ext.length);
    const existing = cachedTextures.get(uuid);
    if (!existing || EXT_PRIORITY.indexOf(ext) < EXT_PRIORITY.indexOf(existing)) {
      cachedTextures.set(uuid, ext);
    }
  }
}

function recordCached(uuid: string, ext: CacheExt): void {
  const existing = cachedTextures.get(uuid);
  if (!existing || EXT_PRIORITY.indexOf(ext) < EXT_PRIORITY.indexOf(existing)) {
    cachedTextures.set(uuid, ext);
  }
}

/** Whether a cached texture extension indicates an opaque texture. */
function isExtOpaque(ext: CacheExt): boolean {
  return ext === '.bc1.bctex';
}

/** Base cache path — gpu-compress-queue replaces .bctex with .bc1.bctex/.bc3.bctex */
export function textureCachePath(textureUuid: string): string {
  return path.join(getCacheDir(), `${textureUuid}.bctex`);
}

export function isTextureCached(textureUuid: string): boolean {
  return cachedTextures.has(textureUuid);
}

/** Return the actual cached path for a texture. */
function resolvedCachePath(textureUuid: string): string {
  const ext = cachedTextures.get(textureUuid)!;
  return path.join(getCacheDir(), `${textureUuid}${ext}`);
}

export class TextureFetchQueue {
  private bot: Bot;
  private onReady: TextureReadyCallback;
  private pending = new Map<string, Set<string>>(); // textureUuid → objectUuids waiting
  private active = 0;
  private queue: string[] = [];
  private failed = new Set<string>();
  private notified = new Set<string>(); // UUIDs already sent to Godot
  private destroyed = false;
  readonly decodePool: DecodePool;
  private gpuQueue: GpuCompressQueue;
  private _gpuCompressCount = 0;
  private _cpuCompressCount = 0;
  // Bake texture metadata: textureUuid → { avatarUuid, channel }
  private bakeInfo = new Map<string, { avatarUuid: string; channel: number }>();

  /** Called when a texture is resolved (downloaded or cache hit). */
  onResolved?: (textureUuid: string) => void;
  /** Called when a texture download fails. */
  onFailed?: (textureUuid: string) => void;

  constructor(bot: Bot, onReady: TextureReadyCallback) {
    this.bot = bot;
    this.onReady = onReady;
    this.decodePool = new DecodePool();
    this.gpuQueue = new GpuCompressQueue();
  }

  get queueDepth(): number { return this.queue.length; }
  get activeCount(): number { return this.active; }
  get failedCount(): number { return this.failed.size; }
  get notifiedCount(): number { return this.notified.size; }
  get gpuCompressCount(): number { return this._gpuCompressCount; }
  get cpuCompressCount(): number { return this._cpuCompressCount; }
  get gpuQueueDepth(): number { return this.gpuQueue.queueDepth; }
  get gpuQueueActive(): number { return this.gpuQueue.activeCount; }

  request(textureUuid: string, objectUuid: string): void {
    if (this.destroyed || this.failed.has(textureUuid)) return;
    if (!textureUuid || textureUuid === ZERO_UUID) return;
    // Never download built-in textures — guards all callers (projection lights, normal maps, etc.)
    if (TRANSPARENT_TEXTURES.has(textureUuid) || SOLID_COLOR_TEXTURES.has(textureUuid) ||
        WATER_EXCLUSION_TEXTURES.has(textureUuid) || BAKE_MAGIC_UUIDS.has(textureUuid)) return;

    // Already cached and Godot notified — nothing to do
    if (this.notified.has(textureUuid)) return;

    // On disk but Godot doesn't know yet — notify once
    if (isTextureCached(textureUuid)) {
      this.notified.add(textureUuid);
      const ext = cachedTextures.get(textureUuid)!;
      this.onReady(textureUuid, resolvedCachePath(textureUuid), isExtOpaque(ext));
      this.onResolved?.(textureUuid);
      return;
    }

    // Already queued or in-flight — just track the objectUuid
    if (this.pending.has(textureUuid)) {
      this.pending.get(textureUuid)!.add(objectUuid);
      return;
    }

    this.pending.set(textureUuid, new Set([objectUuid]));
    this.queue.push(textureUuid);
    this.drain();
  }

  /** Request a baked texture — uses appearance service URL instead of ViewerAsset */
  requestBake(textureUuid: string, objectUuid: string, avatarUuid: string, channel: number): void {
    if (this.destroyed || this.failed.has(textureUuid)) return;
    if (!textureUuid || textureUuid === ZERO_UUID) return;
    if (this.notified.has(textureUuid)) return;

    if (isTextureCached(textureUuid)) {
      this.notified.add(textureUuid);
      const ext = cachedTextures.get(textureUuid)!;
      this.onReady(textureUuid, resolvedCachePath(textureUuid), isExtOpaque(ext));
      this.onResolved?.(textureUuid);
      return;
    }

    // Store bake metadata for the download path
    if (!this.bakeInfo.has(textureUuid)) {
      this.bakeInfo.set(textureUuid, { avatarUuid, channel });
    }

    if (this.pending.has(textureUuid)) {
      this.pending.get(textureUuid)!.add(objectUuid);
      return;
    }

    this.pending.set(textureUuid, new Set([objectUuid]));
    this.queue.push(textureUuid);
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT_DOWNLOADS && this.queue.length > 0 && !this.destroyed) {
      const textureUuid = this.queue.shift()!;
      this.active++;
      this.fetchAndDecode(textureUuid).finally(() => {
        this.active--;
        this.pending.delete(textureUuid);
        this.drain();
      });
    }
  }

  private async fetchAndDecode(textureUuid: string): Promise<void> {
    try {
      let j2cBuf: Buffer;

      // Check if this is a baked texture — use appearance service URL
      const bake = this.bakeInfo.get(textureUuid);
      if (bake) {
        try {
          j2cBuf = await this.downloadBakeTexture(textureUuid, bake.avatarUuid, bake.channel);
          pkDebug('texture', `[BoM] Downloaded bake ${textureUuid.slice(0,8)}: ${j2cBuf.length} bytes`);
        } catch (bakeErr: any) {
          // Appearance service may 404 for some bake channels (e.g. other
          // avatars' universal bakes).  Fall back to regular asset fetch.
          console.warn(`[BoM] Bake fetch failed for ${textureUuid.slice(0,8)} (${bakeErr.message}), trying asset server`);
          j2cBuf = await this.bot.clientCommands.asset.downloadAsset(
            AssetType.Texture, textureUuid
          );
        }
        this.bakeInfo.delete(textureUuid);
      } else {
        // Regular texture: download via ViewerAsset
        j2cBuf = await this.bot.clientCommands.asset.downloadAsset(
          AssetType.Texture, textureUuid
        );
      }

      if (!j2cBuf || j2cBuf.length < 12) {
        console.warn(`[TextureFetchQueue] Skipping ${textureUuid}: empty or too small (${j2cBuf?.length ?? 0} bytes)`);
        this.failed.add(textureUuid);
        return;
      }

      // Try GPU compression path first
      if (gpuCompressionAvailable()) {
        try {
          const t0 = performance.now();
          const raw = await this.decodePool.decodeRaw(j2cBuf);
          const decodeMs = performance.now() - t0;
          const basePath = textureCachePath(textureUuid); // .bctex — gpu-compress replaces ext
          const result = await this.gpuQueue.compress(raw.rgbaPixels, raw.width, raw.height, basePath);
          const totalMs = performance.now() - t0;
          const ext = getCacheExt(path.basename(result.cachePath)) || '.bc3.bctex';
          recordCached(textureUuid, ext);
          this._gpuCompressCount++;
          pkDebug('texperf', `GPU ${raw.width}x${raw.height} ${isExtOpaque(ext) ? 'BC1' : 'BC3'} decode=${decodeMs.toFixed(1)}ms compress=${result.timeMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms ${textureUuid.slice(0,8)}`);

          if (!this.destroyed) {
            this.notified.add(textureUuid);
            this.onReady(textureUuid, result.cachePath, isExtOpaque(ext));
            this.onResolved?.(textureUuid);
          }
          return;
        } catch (gpuErr: any) {
          // GPU compression failed — fall through to CPU BC compression
          console.warn(`[TextureFetchQueue] GPU compress failed for ${textureUuid}, falling back to CPU: ${gpuErr.message}`);
        }
      }

      // Fallback: CPU BC compression (same .bctex output as GPU path)
      const t0cpu = performance.now();
      const { bctexBuf, hasAlpha, mipCount, width: cpuW, height: cpuH } = await this.decodePool.decodeBctex(j2cBuf);
      const cpuMs = performance.now() - t0cpu;
      const ext = hasAlpha ? '.bc3.bctex' : '.bc1.bctex';
      const cachePath = path.join(getCacheDir(), `${textureUuid}${ext}`);
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(cachePath, bctexBuf);
      const cpuTotalMs = performance.now() - t0cpu;
      recordCached(textureUuid, ext);
      this._cpuCompressCount++;
      pkDebug('texperf', `CPU ${cpuW}x${cpuH} ${hasAlpha ? 'BC3' : 'BC1'} decode+compress=${cpuMs.toFixed(1)}ms total=${cpuTotalMs.toFixed(1)}ms ${textureUuid.slice(0,8)}`);

      if (!this.destroyed) {
        this.notified.add(textureUuid);
        this.onReady(textureUuid, cachePath, !hasAlpha);
        this.onResolved?.(textureUuid);
      }
    } catch (err: any) {
      const msg = err?.message || err?.code || String(err);
      console.error(`[TextureFetchQueue] Failed ${textureUuid}: ${msg}`);
      this.failed.add(textureUuid);
      this.onFailed?.(textureUuid);
    }
  }

  /** Download a baked texture from the appearance service */
  private async downloadBakeTexture(textureUuid: string, avatarUuid: string, channel: number): Promise<Buffer> {
    const serviceUrl = this.bot.agent?.agentAppearanceService;
    if (!serviceUrl) {
      throw new Error('No agentAppearanceService URL available');
    }

    const channelName = BAKE_CHANNEL_URL_NAMES[channel];
    if (!channelName) {
      throw new Error(`Invalid bake channel index: ${channel}`);
    }

    // URL format: {appearance_service_url}texture/{avatarUUID}/{channelName}/{textureUUID}
    const url = `${serviceUrl}texture/${avatarUuid}/${channelName}/${textureUuid}`;
    pkDebug('texture', `[BoM] Fetching bake: ${url}`);

    const { net } = require('electron');
    return new Promise<Buffer>((resolve, reject) => {
      const request = net.request({ url, method: 'GET' });
      request.setHeader('Accept', 'image/x-j2c');

      const chunks: Buffer[] = [];
      request.on('response', (response: any) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Bake fetch ${response.statusCode} for ${url}`));
          return;
        }
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', (err: Error) => reject(err));
      });
      request.on('error', (err: Error) => reject(err));
      request.end();
    });
  }

  /** Drop pending queue and failed set for region change. In-flight downloads may still 403 — harmless. */
  /** Re-notify Godot for an evicted texture — re-sends texture_ready from disk cache. */
  renotify(textureUuid: string): void {
    if (this.destroyed) return;
    if (!isTextureCached(textureUuid)) return;
    // Remove from notified so request() will re-send
    this.notified.delete(textureUuid);
    this.failed.delete(textureUuid);
    this.request(textureUuid, '');
  }

  clearPending(): void {
    this.queue = [];
    this.pending.clear();
    this.failed.clear();
  }

  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    this.pending.clear();
    this.gpuQueue.destroy();
    this.decodePool.destroy().catch(() => {});
  }
}
