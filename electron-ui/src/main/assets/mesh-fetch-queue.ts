/**
 * mesh-fetch-queue.ts — Concurrent mesh download queue with dedup and caching.
 * Max 4 concurrent downloads; shared meshes fetched once.
 */

import { AssetType } from '../../../node-metaverse/lib';
import type { Bot } from '../../../node-metaverse/lib';
import { isMeshCached, meshCachePath, readMeshMeta } from './mesh-converter';
import { MeshConvertPool } from './mesh-convert-pool';

const MAX_CONCURRENT = 8;

export type MeshReadyCallback = (meshUuid: string, cachePath: string, isRigged?: boolean, jointNames?: string[], jointOverrides?: string[]) => void;

export class MeshFetchQueue {
  private bot: Bot;
  private onReady: MeshReadyCallback;
  private convertPool: MeshConvertPool;
  private pending = new Map<string, Set<number | string>>(); // meshUuid → object ids waiting
  private active = 0;
  private queue: string[] = [];
  private failed = new Set<string>();
  private notified = new Set<string>(); // UUIDs already sent to Godot
  private destroyed = false;

  /** Called when a mesh is resolved (downloaded or cache hit). */
  onResolved?: (meshUuid: string) => void;
  /** Called when a mesh download fails. */
  onFailed?: (meshUuid: string) => void;

  constructor(bot: Bot, onReady: MeshReadyCallback, cacheDir: string) {
    this.bot = bot;
    this.onReady = onReady;
    this.convertPool = new MeshConvertPool(cacheDir);
  }

  get queueDepth(): number { return this.queue.length; }
  get activeCount(): number { return this.active; }
  get failedCount(): number { return this.failed.size; }
  get notifiedCount(): number { return this.notified.size; }

  request(meshUuid: string, localId: number | string): void {
    if (this.destroyed) return;

    // Already failed — notify readiness tracker so it doesn't timeout
    if (this.failed.has(meshUuid)) {
      this.onFailed?.(meshUuid);
      return;
    }

    // Already cached and Godot notified — still fire onResolved for readiness tracker
    if (this.notified.has(meshUuid)) {
      this.onResolved?.(meshUuid);
      return;
    }

    // On disk but Godot doesn't know yet — notify once (with rigged info from meta)
    if (isMeshCached(meshUuid)) {
      this.notified.add(meshUuid);
      readMeshMeta(meshUuid).then((meta) => {
        if (this.destroyed) return;
        this.onReady(meshUuid, meshCachePath(meshUuid), meta?.isRigged, meta?.jointNames, meta?.jointOverrides);
        this.onResolved?.(meshUuid);
      });
      return;
    }

    // Already queued or in-flight — just track the localId
    if (this.pending.has(meshUuid)) {
      this.pending.get(meshUuid)!.add(localId);
      return;
    }

    this.pending.set(meshUuid, new Set([localId]));
    this.queue.push(meshUuid);
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0 && !this.destroyed) {
      const meshUuid = this.queue.shift()!;
      this.active++;
      this.fetchAndConvert(meshUuid).finally(() => {
        this.active--;
        this.pending.delete(meshUuid);
        this.drain();
      });
    }
  }

  private async fetchAndConvert(meshUuid: string): Promise<void> {
    try {
      const buf = await this.bot.clientCommands.asset.downloadAsset(
        AssetType.Mesh, meshUuid
      );
      const result = await this.convertPool.convert(meshUuid, buf);
      if (!this.destroyed) {
        this.notified.add(meshUuid);
        this.onReady(meshUuid, result.cachePath, result.isRigged, result.jointNames, result.jointOverrides);
        this.onResolved?.(meshUuid);
      }
    } catch (err) {
      console.error(`[MeshFetchQueue] Failed ${meshUuid}:`, (err as Error).message || err);
      this.failed.add(meshUuid);
      this.onFailed?.(meshUuid);
    }
  }

  /** Re-notify Godot for an evicted mesh — re-sends mesh_ready from disk cache. */
  renotify(meshUuid: string): void {
    if (this.destroyed || !isMeshCached(meshUuid)) return;
    this.notified.delete(meshUuid);
    this.failed.delete(meshUuid);
    this.request(meshUuid, 0);
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
    this.convertPool.destroy();
  }
}
