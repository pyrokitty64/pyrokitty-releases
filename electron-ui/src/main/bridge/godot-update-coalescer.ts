/**
 * GodotUpdateCoalescer — Coalesces terse and full object/avatar updates into
 * batched messages, separating physics (velocity) from static updates.
 *
 * Objects are keyed by UUID (not localId) for multi-region safety.
 */

import type { Subscription } from 'rxjs';
import { slPos, slQuat, slScale, slVec3 } from './godot-bridge-types';
import { pkDebug } from '../pk-debug';

export interface UpdateCoalescerDeps {
  /** Check if an object UUID is being tracked */
  isTracked(uuid: string): boolean;
  /** Check if an avatar UUID is being tracked */
  isAvatarTracked(id: string): boolean;
  /** Get light info for an object, or null */
  getLightInfo(obj: any): any;
  /** Send a message to Godot */
  send(msg: object): void;
  /** Re-send an object to Godot (destroy + re-create) when its fundamental type changes */
  resendObject(obj: any): void;
  /** Try to send an untracked object to Godot (late ObjectUpdate recovery) */
  trySendObject(obj: any): void;
}

export class GodotUpdateCoalescer {
  private deps: UpdateCoalescerDeps;
  private updateBuffer: Map<string, any> = new Map();       // object UUID → pending update
  private updateSeq: Map<string, number> = new Map();       // object UUID → last sequence number
  private recentTerse = new Set<string>();                   // object UUIDs with recent terse updates
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private avatarUpdateBuffer: Map<string, any> = new Map();
  private avatarUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private objectsWithLights = new Set<string>();             // object UUIDs that have lights
  private objectAnimeshState = new Map<string, boolean>();   // object UUID → animesh flag
  private _debugFlushSeq = 0;
  private terseGuardSkips = 0;

  constructor(deps: UpdateCoalescerDeps) {
    this.deps = deps;
  }

  /** Track an object's animesh state (called from sendObject) */
  trackAnimesh(uuid: string, isAnimesh: boolean): void {
    this.objectAnimeshState.set(uuid, isAnimesh);
  }

  /** Track that an object has a light (called from sendObject) */
  trackLight(uuid: string): void {
    this.objectsWithLights.add(uuid);
  }

  /** Check if an object has a tracked light */
  hasLight(uuid: string): boolean {
    return this.objectsWithLights.has(uuid);
  }

  /** Get or set sequence number for stale-update detection */
  getSeq(uuid: string): number {
    return this.updateSeq.get(uuid) ?? -1;
  }
  setSeq(uuid: string, seq: number): void {
    this.updateSeq.set(uuid, seq);
  }

  /** Subscribe to terse and full object update events. Returns subscriptions to track. */
  subscribe(events: any): Subscription[] {
    const subs: Subscription[] = [];

    // Terse updates (position/rotation) — coalesced into batches
    const terseSub = events.onObjectUpdatedTerseEvent.subscribe((event: any) => {
      const obj = event.object;

      // Avatar terse updates — event-driven instead of polling
      if (obj.PCode === 47) {
        const avatarId = obj.FullID?.toString();
        if (avatarId && this.deps.isAvatarTracked(avatarId)) {
          const pos = obj.Position;
          const rot = obj.Rotation;
          const vel = obj.Velocity;
          // Resolve parent local ID to UUID (seat object when sitting)
          const parentLocalId = obj.ParentID || 0;
          let parentUuid = '';
          if (parentLocalId > 0) {
            const parentObj = obj.region?.objects?.getObjectByLocalID(parentLocalId);
            parentUuid = parentObj?.FullID?.toString() || '';
          }
          this.avatarUpdateBuffer.set(avatarId, {
            id: avatarId,
            ...(pos ? { position: slPos(pos) } : {}),
            ...(rot ? { rotation: slQuat(rot) } : {}),
            ...(vel ? { velocity: slPos(vel) } : {}),
            ...(parentUuid ? { parentUuid } : {}),
          });
          if (!this.avatarUpdateTimer) {
            this.avatarUpdateTimer = setTimeout(() => {
              this.flushAvatarUpdateBuffer();
              this.avatarUpdateTimer = null;
            }, 16);
          }
        }
        return;
      }

      // Object terse updates
      const uid = obj.FullID?.toString() ?? '';
      if (!uid || !this.deps.isTracked(uid)) return;

      const seq = event.sequenceNumber;
      const prevSeq = this.updateSeq.get(uid) ?? -1;
      const pos = obj.Position;

      // Log ALL updates for debug target
      if (uid === 'bbafd512-4ab8-9878-0e68-eba086760821') {
        pkDebug('objupdate', `[ObjUpdate] TERSE uuid=${uid.slice(0, 8)} seq=${seq} prevSeq=${prevSeq} pos=[${pos?.x.toFixed(2)},${pos?.y.toFixed(2)},${pos?.z.toFixed(2)}] vel=[${obj.Velocity?.x.toFixed(2)},${obj.Velocity?.y.toFixed(2)},${obj.Velocity?.z.toFixed(2)}]`);
      }

      // Drop stale updates — only accept newer sequence numbers
      if (seq < prevSeq) return;
      this.updateSeq.set(uid, seq);

      const rot = obj.Rotation;
      const scl = obj.Scale;
      const vel = obj.Velocity;
      const accel = obj.Acceleration;
      const angVel = obj.AngularVelocity;

      this.updateBuffer.set(uid, {
        uuid: uid,
        ...(pos ? { position: slPos(pos) } : {}),
        ...(rot ? { rotation: slQuat(rot) } : {}),
        ...(scl ? { scale: slScale(scl) } : {}),
        ...(vel ? { velocity: slPos(vel) } : {}),
        ...(accel ? { acceleration: slPos(accel) } : {}),
        ...(angVel ? { angularVelocity: slPos(angVel) } : {}),
      });
      this.recentTerse.add(uid);

      // Flush every 16ms (~1 frame) for responsive corrections
      if (!this.updateTimer) {
        this.updateTimer = setTimeout(() => {
          this.flushUpdateBuffer();
          this.updateTimer = null;
        }, 16);
      }
    });
    subs.push(terseSub);

    // Full object updates (may include scale/light changes)
    const fullUpdateSub = events.onObjectUpdatedEvent.subscribe((event: any) => {
      const obj = event.object;
      const uid = obj.FullID?.toString() ?? '';
      if (!uid) return;
      if (!this.deps.isTracked(uid)) {
        // Object exists in sim but wasn't sent to Godot yet — try now
        // (handles attachments that lacked Position on first attempt)
        if (obj.PCode !== 47) this.deps.trySendObject(obj);
        return;
      }

      const seq = event.sequenceNumber;
      const prevSeq = this.updateSeq.get(uid) ?? -1;
      const pos = obj.Position;

      // Log ALL updates for debug target
      if (uid === 'bbafd512-4ab8-9878-0e68-eba086760821') {
        const terseGuard = this.updateBuffer.get(uid)?.velocity || this.recentTerse.has(uid);
        pkDebug('objupdate', `[ObjUpdate] FULL uuid=${uid.slice(0, 8)} seq=${seq} prevSeq=${prevSeq} pos=[${pos?.x.toFixed(2)},${pos?.y.toFixed(2)},${pos?.z.toFixed(2)}] vel=[${obj.Velocity?.x.toFixed(2)},${obj.Velocity?.y.toFixed(2)},${obj.Velocity?.z.toFixed(2)}] terseGuard=${terseGuard}`);
      }

      // Drop stale updates — only accept newer sequence numbers
      if (seq < prevSeq) return;
      this.updateSeq.set(uid, seq);

      // Detect animesh state change — re-create the object if it changed
      const isAnimesh = !!(obj.extraParams?.extendedMeshData?.flags & 0x1);
      const wasAnimesh = this.objectAnimeshState.get(uid) ?? false;
      if (isAnimesh !== wasAnimesh) {
        pkDebug('animation', `[Animesh] State changed for uuid=${uid}: ${wasAnimesh} → ${isAnimesh}`);
        this.objectAnimeshState.set(uid, isAnimesh);
        this.updateBuffer.delete(uid);
        this.deps.resendObject(obj);
        return;
      }

      const rot = obj.Rotation;
      const scl = obj.Scale;
      const vel = obj.Velocity;
      const accel = obj.Acceleration;
      const angVel = obj.AngularVelocity;
      const lightInfo = this.deps.getLightInfo(obj);

      // Detect light removal: object had a light before but doesn't now
      let lightField: Record<string, any> = {};
      if (lightInfo) {
        lightField = { light: lightInfo };
        this.objectsWithLights.add(uid);
      } else if (this.objectsWithLights.has(uid)) {
        // Light was removed — send null so Godot destroys it
        lightField = { light: null };
        this.objectsWithLights.delete(uid);
      }

      // If a terse update recently set motion data, don't overwrite position/velocity —
      // full/compressed updates can carry staler position than the latest terse update.
      const existing = this.updateBuffer.get(uid);
      const terseHasMotion = existing?.velocity || this.recentTerse.has(uid);
      if (terseHasMotion && pos) {
        this.terseGuardSkips = (this.terseGuardSkips || 0) + 1;
      }
      this.updateBuffer.set(uid, {
        ...(existing || {}),
        uuid: uid,
        ...(!terseHasMotion && pos ? { position: slPos(pos) } : {}),
        ...(!terseHasMotion && rot ? { rotation: slQuat(rot) } : {}),
        ...(scl ? { scale: slScale(scl) } : {}),
        ...(!terseHasMotion && vel ? { velocity: slPos(vel) } : {}),
        ...(!terseHasMotion && accel ? { acceleration: slPos(accel) } : {}),
        ...(!terseHasMotion && angVel ? { angularVelocity: slPos(angVel) } : {}),
        ...lightField,
      });

      if (!this.updateTimer) {
        this.updateTimer = setTimeout(() => {
          this.flushUpdateBuffer();
          this.updateTimer = null;
        }, 16);
      }
    });
    subs.push(fullUpdateSub);

    return subs;
  }

  private flushUpdateBuffer(): void {
    if (this.updateBuffer.size === 0) return;

    const statics: any[] = [];
    const physics: any[] = [];

    for (const obj of this.updateBuffer.values()) {
      const hasMotion =
        obj.velocity || obj.acceleration || obj.angularVelocity;
      obj._fseq = ++this._debugFlushSeq;
      (hasMotion ? physics : statics).push(obj);
    }
    this.updateBuffer.clear();
    this.recentTerse.clear();
    if (this.terseGuardSkips > 0) {
      pkDebug('objupdate', `[ObjUpdate] terse guard skipped position for ${this.terseGuardSkips} objects`);
      this.terseGuardSkips = 0;
    }

    if (physics.length > 0) {
      this.deps.send({ type: 'object_update_physics', objects: physics });
    }
    if (statics.length > 0) {
      this.deps.send({ type: 'object_update_batch', objects: statics });
    }
  }

  private flushAvatarUpdateBuffer(): void {
    if (this.avatarUpdateBuffer.size === 0) return;

    const avatars = Array.from(this.avatarUpdateBuffer.values());
    this.avatarUpdateBuffer.clear();

    this.deps.send({
      type: 'avatar_update_batch',
      avatars,
    });
  }

  cleanup(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.avatarUpdateTimer) {
      clearTimeout(this.avatarUpdateTimer);
      this.avatarUpdateTimer = null;
    }
    this.updateBuffer.clear();
    this.updateSeq.clear();
    this.recentTerse.clear();
    this.objectsWithLights.clear();
    this.avatarUpdateBuffer.clear();
  }
}
