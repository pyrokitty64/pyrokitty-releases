/**
 * sculpt-fetch-queue.ts — Concurrent sculpt texture download and mesh conversion queue.
 * Downloads sculpt texture as J2K, decodes to raw pixels, builds mesh, writes GLB.
 * Dedup key is textureUuid_type since same texture with different sculpt flags = different geometry.
 */

import { AssetType } from '../../../node-metaverse/lib';
import type { Bot } from '../../../node-metaverse/lib';
import { isSculptCached, sculptCachePath, ensureSculptCached, sculptMeshId } from './sculpt-converter';
import type { DecodePool } from './decode-pool';
import { pkDebug } from '../pk-debug';

const MAX_CONCURRENT = 4;

export type SculptReadyCallback = (sculptMeshId: string, cachePath: string) => void;

export class SculptFetchQueue {
  private bot: Bot;
  private onReady: SculptReadyCallback;
  private decodePool: DecodePool;
  private pending = new Map<string, Set<number | string>>(); // dedupKey → object ids waiting
  private active = 0;
  private queue: { textureUuid: string; sculptType: number; dedupKey: string }[] = [];
  private failed = new Set<string>();
  private notified = new Set<string>(); // dedupKeys already sent to Godot
  private destroyed = false;

  /** Called when a sculpt mesh is resolved (downloaded or cache hit). */
  onResolved?: (sculptMeshId: string) => void;
  /** Called when a sculpt mesh download fails. */
  onFailed?: (sculptMeshId: string) => void;

  constructor(bot: Bot, onReady: SculptReadyCallback, decodePool: DecodePool) {
    this.bot = bot;
    this.onReady = onReady;
    this.decodePool = decodePool;
  }

  get queueDepth(): number { return this.queue.length; }
  get activeCount(): number { return this.active; }
  get failedCount(): number { return this.failed.size; }
  get notifiedCount(): number { return this.notified.size; }

  request(textureUuid: string, sculptType: number, localId: number | string): void {
    if (this.destroyed) return;

    const dedupKey = sculptMeshId(textureUuid, sculptType);

    // Already failed — notify readiness tracker so it doesn't timeout
    if (this.failed.has(dedupKey)) {
      this.onFailed?.(dedupKey);
      return;
    }

    // Already cached and Godot notified — still fire onResolved for readiness tracker
    if (this.notified.has(dedupKey)) {
      this.onResolved?.(dedupKey);
      return;
    }

    // On disk but Godot doesn't know yet — notify once
    if (isSculptCached(textureUuid, sculptType)) {
      this.notified.add(dedupKey);
      this.onReady(dedupKey, sculptCachePath(textureUuid, sculptType));
      this.onResolved?.(dedupKey);
      return;
    }

    // Already queued or in-flight — just track the localId
    if (this.pending.has(dedupKey)) {
      this.pending.get(dedupKey)!.add(localId);
      return;
    }

    this.pending.set(dedupKey, new Set([localId]));
    this.queue.push({ textureUuid, sculptType, dedupKey });
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0 && !this.destroyed) {
      const item = this.queue.shift()!;
      this.active++;
      this.fetchAndConvert(item.textureUuid, item.sculptType, item.dedupKey).finally(() => {
        this.active--;
        this.pending.delete(item.dedupKey);
        this.drain();
      });
    }
  }

  private async fetchAndConvert(textureUuid: string, sculptType: number, dedupKey: string): Promise<void> {
    try {
      const j2cBuf = await this.bot.clientCommands.asset.downloadAsset(
        AssetType.Texture, textureUuid
      );
      if (!j2cBuf || j2cBuf.length < 12) {
        console.warn(`[SculptFetchQueue] Skipping ${textureUuid}: empty or too small (${j2cBuf?.length ?? 0} bytes)`);
        this.failed.add(dedupKey);
        return;
      }

      const cachePath = await ensureSculptCached(textureUuid, sculptType, j2cBuf, this.decodePool);
      if (!this.destroyed) {
        this.notified.add(dedupKey);
        pkDebug('sculpt', `[SculptFetchQueue] Ready: ${dedupKey}`);
        this.onReady(dedupKey, cachePath);
        this.onResolved?.(dedupKey);
      }
    } catch (err) {
      console.error(`[SculptFetchQueue] Failed ${dedupKey}:`, (err as Error).message || err);
      this.failed.add(dedupKey);
      this.onFailed?.(dedupKey);
    }
  }

  clearPending(): void {
    this.queue = [];
    this.pending.clear();
  }

  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    this.pending.clear();
  }
}
