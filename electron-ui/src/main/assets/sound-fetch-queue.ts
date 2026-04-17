/**
 * sound-fetch-queue.ts — Downloads SL sound assets (OGG Vorbis) and caches
 * them to disk for Godot to load as AudioStreamOggVorbis.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AssetType } from '../../../node-metaverse/lib';
import type { Bot } from '../../../node-metaverse/lib';

const MAX_CONCURRENT = 4;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export type SoundReadyCallback = (soundUuid: string, cachePath: string) => void;

export class SoundFetchQueue {
  private bot: Bot;
  private onReady: SoundReadyCallback;
  private pending = new Set<string>();
  private active = 0;
  private queue: string[] = [];
  private failed = new Set<string>();
  private cache = new Map<string, string>(); // soundUuid → disk path
  private destroyed = false;
  private cacheDir: string;
  private dirReady: Promise<void>;

  constructor(bot: Bot, onReady: SoundReadyCallback) {
    this.bot = bot;
    this.onReady = onReady;
    this.cacheDir = path.join(app.getPath('userData'), 'asset-cache', 'sounds');
    this.dirReady = fs.promises.mkdir(this.cacheDir, { recursive: true }).then(() => {});
  }

  get queueDepth(): number { return this.queue.length; }
  get activeCount(): number { return this.active; }
  get failedCount(): number { return this.failed.size; }
  get cachedCount(): number { return this.cache.size; }

  request(soundUuid: string): void {
    if (this.destroyed || this.failed.has(soundUuid) || soundUuid === ZERO_UUID) return;

    // Already in memory cache
    const cached = this.cache.get(soundUuid);
    if (cached) {
      this.onReady(soundUuid, cached);
      return;
    }

    // Already queued or in-flight
    if (this.pending.has(soundUuid)) return;

    this.pending.add(soundUuid);
    this.queue.push(soundUuid);
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0 && !this.destroyed) {
      const soundUuid = this.queue.shift()!;
      this.active++;
      this.fetchAndCache(soundUuid).finally(() => {
        this.active--;
        this.pending.delete(soundUuid);
        this.drain();
      });
    }
  }

  private async fetchAndCache(soundUuid: string): Promise<void> {
    try {
      await this.dirReady;

      // Check disk cache
      const diskPath = path.join(this.cacheDir, `${soundUuid}.ogg`);
      try {
        await fs.promises.access(diskPath);
        this.cache.set(soundUuid, diskPath);
        this.onReady(soundUuid, diskPath);
        return;
      } catch { /* not on disk, download */ }

      const buf = await this.bot.clientCommands.asset.downloadAsset(
        AssetType.Sound, soundUuid
      );
      if (this.destroyed) return;
      await fs.promises.writeFile(diskPath, buf);
      this.cache.set(soundUuid, diskPath);
      this.onReady(soundUuid, diskPath);
    } catch (err) {
      console.error(`[SoundFetchQueue] Failed ${soundUuid}:`, (err as Error).message || err);
      this.failed.add(soundUuid);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    this.pending.clear();
  }
}
