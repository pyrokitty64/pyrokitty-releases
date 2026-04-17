/**
 * animation-fetch-queue.ts — Downloads SL animation assets, parses them,
 * and converts to JSON for Godot to build Animation resources.
 * Parsed animations are cached to disk as JSON for instant replay on subsequent sessions.
 */

import { AssetType } from '../../../node-metaverse/lib';
import type { Bot } from '../../../node-metaverse/lib';
import { LLAnimation } from '../../../node-metaverse/lib/classes/LLAnimation';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getSkeletonHierarchy, getAttachmentPoints } from './mesh-converter';
import { pkDebug } from '../pk-debug';

const MAX_CONCURRENT = 4;

function getCacheDir(): string {
  return path.join(app.getPath('userData'), 'asset-cache', 'animations');
}

function animCachePath(animUuid: string): string {
  return path.join(getCacheDir(), `${animUuid}.json`);
}

/** Parsed animation data ready for Godot */
export interface AnimationData {
  uuid: string;
  duration: number;
  loop: boolean;
  loopInPoint: number;
  loopOutPoint: number;
  easeInTime: number;
  easeOutTime: number;
  priority: number;
  joints: AnimationJointData[];
}

export interface AnimationJointData {
  name: string;
  priority: number;
  rotationKeys: AnimationKeyframe[];
  positionKeys: AnimationKeyframe[];
}

export interface AnimationKeyframe {
  time: number;
  value: [number, number, number]; // rotation: quat xyz (w reconstructed), position: xyz meters
}

export type AnimationReadyCallback = (animUuid: string, data: AnimationData) => void;

export class AnimationFetchQueue {
  private bot: Bot;
  private onReady: AnimationReadyCallback;
  private pending = new Map<string, Set<number>>(); // animUuid → requesting localIds
  private active = 0;
  private queue: string[] = [];
  private failed = new Set<string>();
  private cache = new Map<string, AnimationData>(); // animUuid → parsed data
  private destroyed = false;

  constructor(bot: Bot, onReady: AnimationReadyCallback) {
    this.bot = bot;
    this.onReady = onReady;
  }

  get queueDepth(): number { return this.queue.length; }
  get activeCount(): number { return this.active; }
  get failedCount(): number { return this.failed.size; }
  get cachedCount(): number { return this.cache.size; }

  /** Check if animation data is available (memory or disk cache) without triggering a fetch */
  async getCached(animUuid: string): Promise<AnimationData | null> {
    const mem = this.cache.get(animUuid);
    if (mem) return mem;
    try {
      const diskPath = animCachePath(animUuid);
      await fs.promises.access(diskPath);
      const data: AnimationData = JSON.parse(await fs.promises.readFile(diskPath, 'utf8'));
      this.cache.set(animUuid, data);
      return data;
    } catch { /* corrupt or missing */ }
    return null;
  }

  /** Check if an animation has failed to fetch */
  hasFailed(animUuid: string): boolean {
    return this.failed.has(animUuid);
  }

  async request(animUuid: string, localId: number): Promise<void> {
    if (this.destroyed || this.failed.has(animUuid)) {
      if (this.failed.has(animUuid)) console.warn(`[AnimFetchQueue] Skipping previously failed ${animUuid.slice(0, 8)} for localId ${localId}`);
      return;
    }

    // Already in memory — notify immediately
    const cached = this.cache.get(animUuid);
    if (cached) {
      this.onReady(animUuid, cached);
      return;
    }

    // On disk — load into memory and notify
    try {
      const diskPath = animCachePath(animUuid);
      await fs.promises.access(diskPath);
      const data: AnimationData = JSON.parse(await fs.promises.readFile(diskPath, 'utf8'));
      this.cache.set(animUuid, data);
      this.onReady(animUuid, data);
      return;
    } catch { /* corrupt file or missing — fall through to download */ }

    // Already queued or in-flight
    if (this.pending.has(animUuid)) {
      this.pending.get(animUuid)!.add(localId);
      return;
    }
    this.pending.set(animUuid, new Set([localId]));
    this.queue.push(animUuid);
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0 && !this.destroyed) {
      const animUuid = this.queue.shift()!;
      this.active++;
      this.fetchAndParse(animUuid).finally(() => {
        this.active--;
        this.pending.delete(animUuid);
        this.drain();
      });
    }
  }

  private async fetchAndParse(animUuid: string): Promise<void> {
    try {
      const buf = await this.bot.clientCommands.asset.downloadAsset(
        AssetType.Animation, animUuid
      );
      const anim = new LLAnimation(buf);
      const data = convertAnimation(animUuid, anim);
      if (!this.destroyed) {
        this.cache.set(animUuid, data);
        // Persist to disk
        try {
          const dir = getCacheDir();
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(animCachePath(animUuid), JSON.stringify(data, null, 2));
        } catch { /* non-fatal */ }
        this.onReady(animUuid, data);
      }
    } catch (err) {
      console.error(`[AnimFetchQueue] Failed ${animUuid}:`, (err as Error).message || err);
      this.failed.add(animUuid);
    }
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
  }
}

/**
 * Convert parsed LLAnimation to our JSON format.
 *
 * SL rotation keyframes: x,y,z are quaternion components in [-1,1],
 * w = sqrt(1 - x² - y² - z²). Stored as UInt16 compressed.
 *
 * SL position keyframes: x,y,z in [-0.5, 0.5] range (node-metaverse
 * decompresses to [-1, 1] but the actual SL range is [-5, 5] for
 * LL_MAX_PELVIS_OFFSET — only mPelvis typically has position keys).
 */
function convertAnimation(uuid: string, anim: LLAnimation): AnimationData {
  const joints: AnimationJointData[] = [];
  const skeleton = getSkeletonHierarchy();

  // SL resolves joint names via getJoint() which finds:
  // 1. Standard bones (avatar_skeleton.xml)
  // 2. Collision volumes (avatar_skeleton.xml)
  // 3. Attachment points (avatar_lad.xml) — e.g., "Left Ear", "Nose", "Tail Base"
  // Names not found in any of these are scrubbed (initJointNums maps to mPelvis).
  const attachPoints = getAttachmentPoints();
  const scrubbed: string[] = [];

  for (const joint of anim.joints) {
    if (!skeleton.has(joint.name) && !attachPoints.has(joint.name)) {
      scrubbed.push(joint.name);
      continue; // Skip joints not resolvable by SL
    }

    const rotationKeys: AnimationKeyframe[] = [];
    for (const kf of joint.rotationKeyframes) {
      rotationKeys.push({
        time: kf.time,
        value: [kf.transform.x, kf.transform.y, kf.transform.z],
      });
    }

    const positionKeys: AnimationKeyframe[] = [];
    for (const kf of joint.positionKeyframes) {
      // node-metaverse decompresses to [-1, 1] but SL actually uses [-5, 5]
      // Scale by 5 to get meters
      positionKeys.push({
        time: kf.time,
        value: [kf.transform.x * 5, kf.transform.y * 5, kf.transform.z * 5],
      });
    }

    joints.push({
      name: joint.name,
      priority: joint.priority,
      rotationKeys,
      positionKeys,
    });
  }

  if (scrubbed.length > 0) {
    pkDebug('animation', `[AnimFetch] ${uuid.slice(0, 8)}: scrubbed ${scrubbed.length} joints: ${scrubbed.join(', ')}`);
  }

  return {
    uuid,
    duration: anim.length,
    loop: anim.loop !== 0,
    loopInPoint: anim.inPoint,
    loopOutPoint: anim.outPoint,
    easeInTime: anim.easeInTime,
    easeOutTime: anim.easeOutTime,
    priority: anim.priority,
    joints,
  };
}
