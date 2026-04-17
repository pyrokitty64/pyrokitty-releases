/**
 * Manages animation batching for avatars and animesh objects.
 * Deduplicates animation sets, waits for all fetches to complete,
 * then sends a single batch to Godot.
 *
 * All tracking is keyed by object/avatar UUID strings (not numeric localIds).
 */

import type { Bot } from '../../../node-metaverse/lib';
import { Message } from '../../../node-metaverse/lib/enums/Message';
/** Fields we actually read from animation circuit messages (may be missing on truncated packets). */
type AnimationPacket = { Sender?: { ID?: { toString(): string } }; AnimationList?: { AnimID: { toString(): string }; AnimSequenceID: number }[] };
import type { AnimationFetchQueue } from '../assets/animation-fetch-queue';
import type { SendFn } from './godot-bridge-types';
import { pkDebug } from '../pk-debug';

export class GodotAnimationManager {
  private animRootPending = new Map<string, Set<string>>(); // UUID → set of anim UUIDs needed
  private animRootLastSet = new Map<string, string>(); // UUID → sorted anim ID string (for dedup)
  private animeshAnimState = new Map<string, { animId: string; sequenceId: number }[]>(); // UUID → latest animation list
  private animeshObjects = new Set<string>(); // UUIDs of known animesh objects
  private avatarAnimState = new Map<string, { animId: string; sequenceId: number }[]>(); // avatar UUID → latest animation list
  private animationFetchQueue: AnimationFetchQueue | null = null;
  private connected = false;
  private sentToGodot = new Set<string>(); // anim UUIDs whose keyframe data has been sent
  private batchCheckInFlight = new Set<string>(); // roots currently being checked (race guard)

  constructor(
    private bot: Bot,
    private send: SendFn,
    private trackedAvatars: Set<string>,
  ) {}

  /** Seed from MetaverseConnection's early ObjectAnimation buffer */
  seedObjectAnimationBuffer(buffer: Map<string, { animId: string; sequenceId: number }[]>): void {
    for (const [uuid, anims] of buffer) {
      this.animeshAnimState.set(uuid, anims);
    }
    console.log(`[GodotBridge] Seeded ${buffer.size} ObjectAnimation entries from login buffer`);
  }

  /** Seed from MetaverseConnection's AvatarAnimation buffer (survives bridge restarts) */
  seedAvatarAnimationBuffer(buffer: Map<string, { animId: string; sequenceId: number }[]>): void {
    for (const [avatarId, anims] of buffer) {
      this.avatarAnimState.set(avatarId, anims);
    }
    console.log(`[GodotBridge] Seeded ${buffer.size} AvatarAnimation entries from login buffer`);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) {
      this.sentToGodot.clear(); // Godot cache is fresh on reconnect
    }
  }

  initFetchQueue(queue: AnimationFetchQueue): void {
    this.animationFetchQueue = queue;
  }

  /** Register a UUID as an animesh object */
  registerAnimeshObject(uuid: string): void {
    this.animeshObjects.add(uuid);
  }

  /** Check if a UUID is a known animesh object */
  isAnimeshObject(uuid: string): boolean {
    return this.animeshObjects.has(uuid);
  }

  /** Get buffered object animation state */
  getBufferedObjectAnims(uuid: string): { animId: string; sequenceId: number }[] | undefined {
    return this.animeshAnimState.get(uuid);
  }

  /** Get buffered avatar animation state */
  getBufferedAvatarAnims(id: string): { animId: string; sequenceId: number }[] | undefined {
    return this.avatarAnimState.get(id);
  }

  /** Subscribe to ObjectAnimation circuit messages (persistent across region changes). */
  subscribeToObjectAnimation(): { unsubscribe: () => void } {
    return this.bot.subscribeToCircuitMessages([
      Message.ObjectAnimation,
    ], (packet) => {
      try {
        const msg = packet.message as unknown as AnimationPacket;
        const senderUuid = msg.Sender?.ID?.toString();
        if (!senderUuid || !msg.AnimationList) return;
        const animations = msg.AnimationList.map(a => ({
          animId: a.AnimID.toString(),
          sequenceId: a.AnimSequenceID,
        }));

        pkDebug('animation', `[Animesh] ObjectAnimation received for ${senderUuid.slice(0, 8)}: ${animations.length} anims [${animations.map(a => a.animId.slice(0, 8)).join(', ')}]`);

        this.animeshAnimState.set(senderUuid, animations);

        const isKnown = this.animeshObjects.has(senderUuid);
        if (isKnown && this.connected) {
          pkDebug('animation', `[Animesh] ObjectAnimation for uuid=${senderUuid.slice(0, 8)}: ${animations.length} anims`);
          this.updateAnimSet(senderUuid, animations.map(a => a.animId));
        } else {
          pkDebug('animation', `[Animesh] Buffering ObjectAnimation for ${senderUuid.slice(0, 8)} (known=${isKnown}, connected=${this.connected})`);
        }
      } catch (err) {
        console.error(`[Animesh] ObjectAnimation handler error:`, (err as Error).message);
      }
    });
  }

  /** Subscribe to AvatarAnimation circuit messages (persistent across region changes). */
  subscribeToAvatarAnimation(): { unsubscribe: () => void } {
    return this.bot.subscribeToCircuitMessages([
      Message.AvatarAnimation,
    ], (packet) => {
      try {
        const msg = packet.message as unknown as AnimationPacket;
        const avatarId = msg.Sender?.ID?.toString();
        if (!avatarId || !msg.AnimationList) return;
        const animations = msg.AnimationList.map(a => ({
          animId: a.AnimID.toString(),
          sequenceId: a.AnimSequenceID,
        }));

        this.avatarAnimState.set(avatarId, animations);

        const isTracked = this.trackedAvatars.has(avatarId);
        if (isTracked && this.connected) {
          this.updateAnimSet(avatarId, animations.map(a => a.animId));
        }
      } catch (err) {
        console.error(`[AnimDebug] AvatarAnimation handler error:`, (err as Error).message);
      }
    });
  }

  /**
   * Update the animation set for a root (avatar or animesh object) identified by UUID.
   * Dedup: skip if identical to previous set.
   * Batch: request all fetches, then only notify Godot when ALL are cached.
   */
  async updateAnimSet(uuid: string, animIds: string[]): Promise<void> {
    const sorted = [...animIds].sort();
    const key = sorted.join(',');
    if (this.animRootLastSet.get(uuid) === key) return;
    this.animRootLastSet.set(uuid, key);

    const needed = new Set(sorted.filter(id => id.length > 0));
    this.animRootPending.set(uuid, needed);

    if (this.animationFetchQueue) {
      for (const animId of needed) {
        await this.animationFetchQueue.request(animId, 0);
      }
    }

    await this.checkAnimBatchReadyForRoot(uuid);
  }

  /** Called when a single animation finishes fetching — check all roots that need it */
  async checkAnimBatchReady(animUuid: string): Promise<void> {
    for (const [uuid, needed] of this.animRootPending) {
      if (needed.has(animUuid)) {
        await this.checkAnimBatchReadyForRoot(uuid);
      }
    }
  }

  /** Check if all animations for a specific root are cached. If so, send batch to Godot. */
  private async checkAnimBatchReadyForRoot(uuid: string): Promise<void> {
    if (this.batchCheckInFlight.has(uuid)) return; // another call already processing this root
    const needed = this.animRootPending.get(uuid);
    if (!needed || !this.connected) {
      return;
    }
    this.batchCheckInFlight.add(uuid);
    try {

    // Empty animation set — send empty batch so Godot clears the old animations
    if (needed.size === 0 || !this.animationFetchQueue) {
      this.animRootPending.delete(uuid);
      pkDebug('animation', `[Animesh] Sending empty batch for uuid=${uuid.slice(0, 8)} (animations cleared)`);
      this.send({
        type: 'animations_batch',
        uuid,
        animations: {},
      });
      return;
    }

    const allData: Record<string, any> = {};
    let stillFetching = false;
    for (const animId of needed) {
      const cached = await this.animationFetchQueue.getCached(animId);
      if (cached) {
        // Only send full keyframe data if Godot hasn't seen this animation yet
        if (this.sentToGodot.has(animId)) {
          allData[animId] = { id: animId }; // stub — Godot already has keyframe data
        } else {
          allData[animId] = cached;
        }
      } else if (this.animationFetchQueue.hasFailed(animId)) {
        continue;
      } else {
        stillFetching = true;
      }
    }

    // Send whatever is cached now — don't let pending fetches keep old animations playing.
    // When remaining fetches complete, checkAnimBatchReady will send an updated batch.
    if (stillFetching && Object.keys(allData).length === 0) {
      return; // Nothing cached yet at all — wait for at least one
    }
    if (!stillFetching) {
      this.animRootPending.delete(uuid);
    }

    // Check if this is the self avatar
    let isSelf = false;
    try { isSelf = (uuid === this.bot.agent?.agentID?.toString()); } catch { /* empty */ }
    pkDebug('animation', `[Animesh] Batch ready for uuid=${uuid.slice(0, 8)}: ${Object.keys(allData).map(id => id.slice(0, 8)).join(', ')}`);
    if (isSelf) {
      const animSummary = Object.entries(allData).map(([id, d]: [string, any]) =>
        `${id.slice(0, 8)}(${d.joints?.length ?? 0}j,${Number(d.duration).toFixed(1)}s,pri=${d.priority ?? '?'})`
      ).join(', ');
      pkDebug('animation', `[SelfAvatar] Animation batch: ${Object.keys(allData).length} animations — ${animSummary}`);
    }
    this.send({
      type: 'animations_batch',
      uuid,
      animations: allData,
    });
    // Mark all animations in this batch as sent so we don't resend keyframe data
    for (const animId of Object.keys(allData)) {
      this.sentToGodot.add(animId);
    }

    } finally {
      this.batchCheckInFlight.delete(uuid);
    }
  }

  /** Clean up state for a deleted object by UUID */
  cleanupUuid(uuid: string): void {
    this.animRootPending.delete(uuid);
    this.animRootLastSet.delete(uuid);
    this.animeshObjects.delete(uuid);
  }

  /** Clean up state for a departed avatar */
  cleanupAvatar(id: string): void {
    this.avatarAnimState.delete(id);
    this.animRootPending.delete(id);
    this.animRootLastSet.delete(id);
  }

  /** Light reset for region change — clear state but keep queues alive */
  clearForRegionChange(): void {
    this.animRootPending.clear();
    this.animRootLastSet.clear();
    this.animeshAnimState.clear();
    this.animeshObjects.clear();
    this.avatarAnimState.clear();
    this.batchCheckInFlight.clear();
    this.animationFetchQueue?.clearPending();
  }

  cleanup(): void {
    this.animRootPending.clear();
    this.animRootLastSet.clear();
    this.animeshAnimState.clear();
    this.animeshObjects.clear();
    this.avatarAnimState.clear();
    this.batchCheckInFlight.clear();
    if (this.animationFetchQueue) {
      this.animationFetchQueue.destroy();
      this.animationFetchQueue = null;
    }
  }
}
