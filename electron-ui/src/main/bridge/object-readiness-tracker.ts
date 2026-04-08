/**
 * ObjectReadinessTracker — gates object messages until ALL assets are on disk.
 *
 * Tracks mesh + texture + material readiness per object. When everything is
 * resolved (mesh downloaded, all face textures cached, all PBR material assets
 * fetched), emits a single `object_render` message containing everything
 * Godot needs.
 *
 * Objects are keyed by UUID (not localId) for multi-region safety.
 */

import {
  TRANSPARENT_TEXTURES, SOLID_COLOR_TEXTURES, WATER_EXCLUSION_TEXTURES,
} from './godot-bridge-types';
import type { SendFn } from './godot-bridge-types';
import { pkDebug } from '../pk-debug';

/** Unfetchable texture IDs that must never enter needsTextures — they are never downloaded.
 *  Must stay in sync with the skip checks in MaterialResolver.requestTexture(). */
const UNFETCHABLE_TEXTURES = new Set([
  ...TRANSPARENT_TEXTURES,
  ...SOLID_COLOR_TEXTURES,
  ...WATER_EXCLUSION_TEXTURES,
]);

interface PendingObject {
  uuid: string;
  parentUuid: string;                  // '' for root prims
  needsMesh: string | null;           // meshId or sculptMeshId, null for procedural prims
  meshReady: boolean;
  needsTextures: Set<string>;         // textureIds this object requires
  texturesReady: Set<string>;         // textureIds that have been resolved
  needsMaterials: Set<string>;        // PBR material asset UUIDs this object requires
  materialsReady: Set<string>;        // material UUIDs that have been resolved
  renderMsg: any;                     // the full object_render message payload
  createdAt: number;
}

export class ObjectReadinessTracker {
  private pending = new Map<string, PendingObject>();        // object UUID → state
  private meshToObjects = new Map<string, Set<string>>();    // meshId → object UUIDs waiting
  private textureToObjects = new Map<string, Set<string>>(); // textureId → object UUIDs waiting
  private materialToObjects = new Map<string, Set<string>>(); // materialId → object UUIDs waiting
  /** Globally resolved assets — used to pre-fill readiness for objects tracked
   *  AFTER their assets resolved (sync cache hits fire onResolved before track()). */
  private resolvedMeshes = new Set<string>();
  private resolvedTextures = new Set<string>();
  private resolvedMaterials = new Set<string>();
  /** Parent ordering: children wait until parent has been emitted. */
  private emitted = new Set<string>();                        // UUIDs already sent to Godot
  /** Objects that are attachments (worn on an avatar) — propagated to children for material keys. */
  private attachments = new Set<string>();
  private childrenWaitingForParent = new Map<string, Set<string>>(); // parentUuid → child UUIDs
  private send: SendFn;
  /** Called before emit to enrich the message with asset paths (meshPath, texturePaths). */
  enrichFn?: (msg: any) => void;

  constructor(send: SendFn) {
    this.send = send;
  }

  /** Register an object for readiness tracking. */
  track(uuid: string, meshId: string | null, textureIds: Set<string>, materialIds: Set<string>, renderMsg: any, parentUuid: string = ''): void {
    // Remove any prior entry (object re-creation)
    this.remove(uuid);

    // Filter out empty/zero/unfetchable texture IDs that will never be fetched
    const ZERO = '00000000-0000-0000-0000-000000000000';
    const filteredTextures = new Set<string>();
    for (const tid of textureIds) {
      if (!tid || tid === ZERO) continue;
      if (UNFETCHABLE_TEXTURES.has(tid)) continue;
      filteredTextures.add(tid);
    }
    const filteredMaterials = new Set<string>();
    for (const mid of materialIds) {
      if (mid && mid !== ZERO) filteredMaterials.add(mid);
    }

    const entry: PendingObject = {
      uuid,
      parentUuid,
      needsMesh: meshId,
      meshReady: meshId === null || this.resolvedMeshes.has(meshId), // pre-fill from global resolved set
      needsTextures: filteredTextures,
      texturesReady: new Set(),
      needsMaterials: filteredMaterials,
      materialsReady: new Set(),
      renderMsg,
      createdAt: Date.now(),
    };
    // Pre-fill textures that already resolved (sync cache hits fire before track)
    for (const tid of filteredTextures) {
      if (this.resolvedTextures.has(tid)) {
        entry.texturesReady.add(tid);
      }
    }
    // NOTE: Do NOT pre-fill materials from resolvedMaterials here.
    // Unlike textures (whose face data is already in renderMsg), PBR material
    // faces are DEFERRED — their face data is only patched in by
    // handleMaterialReady → onResolved → updatePendingFaces. Pre-filling the
    // material gate would cause checkAndEmit to ship the object before
    // requestMaterials() can fire a synchronous cache-hit callback to patch
    // the pending face data. Materials are marked ready via the explicit
    // onMaterialReady/onMaterialFailed callbacks instead.
    this.pending.set(uuid, entry);

    // Reverse index: mesh → objects (only if not already resolved)
    if (meshId && !entry.meshReady) {
      let set = this.meshToObjects.get(meshId);
      if (!set) {
        set = new Set();
        this.meshToObjects.set(meshId, set);
      }
      set.add(uuid);
    }

    // Reverse index: texture → objects (only for unresolved textures)
    for (const tid of textureIds) {
      if (!entry.texturesReady.has(tid)) {
        let set = this.textureToObjects.get(tid);
        if (!set) {
          set = new Set();
          this.textureToObjects.set(tid, set);
        }
        set.add(uuid);
      }
    }

    // Reverse index: material → objects (only for unresolved materials)
    for (const mid of filteredMaterials) {
      if (!entry.materialsReady.has(mid)) {
        let set = this.materialToObjects.get(mid);
        if (!set) {
          set = new Set();
          this.materialToObjects.set(mid, set);
        }
        set.add(uuid);
      }
    }

    // Check if already complete (all assets pre-resolved from cache)
    this.checkAndEmit(uuid);
  }

  /** Mark mesh as resolved for all waiting objects. */
  onMeshReady(meshUuid: string): void {
    this.resolvedMeshes.add(meshUuid);
    const objectUuids = this.meshToObjects.get(meshUuid);
    if (!objectUuids) return;
    for (const uuid of objectUuids) {
      const entry = this.pending.get(uuid);
      if (entry) {
        entry.meshReady = true;
        this.checkAndEmit(uuid);
      }
    }
    this.meshToObjects.delete(meshUuid);
  }

  /** Mark mesh as failed — send object_render with placeholder. */
  onMeshFailed(meshUuid: string): void {
    this.resolvedMeshes.add(meshUuid);
    const objectUuids = this.meshToObjects.get(meshUuid);
    if (!objectUuids) return;
    for (const uuid of objectUuids) {
      const entry = this.pending.get(uuid);
      if (entry) {
        entry.meshReady = true;
        // Clear the meshId so Godot uses shape or placeholder
        entry.renderMsg.meshId = undefined;
        entry.renderMsg.meshPath = undefined;
        this.checkAndEmit(uuid);
      }
    }
    this.meshToObjects.delete(meshUuid);
  }

  /** Mark texture as resolved for all waiting objects. */
  onTextureReady(textureUuid: string): void {
    this.resolvedTextures.add(textureUuid);
    const objectUuids = this.textureToObjects.get(textureUuid);
    if (!objectUuids) return;
    for (const uuid of objectUuids) {
      const entry = this.pending.get(uuid);
      if (entry && entry.needsTextures.has(textureUuid)) {
        entry.texturesReady.add(textureUuid);
        this.checkAndEmit(uuid);
      }
    }
    this.textureToObjects.delete(textureUuid);
  }

  /** Mark texture as failed — proceed without it. */
  onTextureFailed(textureUuid: string): void {
    this.resolvedTextures.add(textureUuid);
    const objectUuids = this.textureToObjects.get(textureUuid);
    if (!objectUuids) return;
    for (const uuid of objectUuids) {
      const entry = this.pending.get(uuid);
      if (entry && entry.needsTextures.has(textureUuid)) {
        // Count as resolved so the object isn't blocked forever
        entry.texturesReady.add(textureUuid);
        this.checkAndEmit(uuid);
      }
    }
    this.textureToObjects.delete(textureUuid);
  }

  /** Mark PBR material asset as resolved for all waiting objects. */
  onMaterialReady(materialUuid: string): void {
    const objectUuids = this.materialToObjects.get(materialUuid);
    this.resolvedMaterials.add(materialUuid);
    if (!objectUuids) return;
    for (const uuid of objectUuids) {
      const entry = this.pending.get(uuid);
      if (entry && entry.needsMaterials.has(materialUuid)) {
        entry.materialsReady.add(materialUuid);
        this.checkAndEmit(uuid);
      }
    }
    this.materialToObjects.delete(materialUuid);
  }

  /** Mark PBR material asset as failed — proceed without PBR for those faces. */
  onMaterialFailed(materialUuid: string): void {
    this.resolvedMaterials.add(materialUuid);
    const objectUuids = this.materialToObjects.get(materialUuid);
    if (!objectUuids) return;
    for (const uuid of objectUuids) {
      const entry = this.pending.get(uuid);
      if (entry && entry.needsMaterials.has(materialUuid)) {
        entry.materialsReady.add(materialUuid);
        this.checkAndEmit(uuid);
      }
    }
    this.materialToObjects.delete(materialUuid);
  }

  /**
   * Patch a pending object_render's face data before it ships.
   * Called when async material resolution (PBR or legacy) completes while
   * the object is still waiting for its mesh/textures. Returns true if patched.
   */
  updatePendingFaces(uuid: string, faceData: any): boolean {
    const entry = this.pending.get(uuid);
    if (!entry) return false;

    if (!entry.renderMsg.faces) {
      entry.renderMsg.faces = [faceData];
    } else {
      const idx = entry.renderMsg.faces.findIndex((f: any) => f.index === faceData.index);
      if (idx >= 0) {
        entry.renderMsg.faces[idx] = faceData;
      } else {
        entry.renderMsg.faces.push(faceData);
      }
    }
    return true;
  }

  /** Add additional texture dependencies (e.g. PBR textures resolved after initial track). */
  addTextures(uuid: string, textureIds: Set<string>): void {
    const ZERO = '00000000-0000-0000-0000-000000000000';
    const entry = this.pending.get(uuid);
    if (!entry) return;
    for (const tid of textureIds) {
      if (!tid || tid === ZERO) continue;
      if (UNFETCHABLE_TEXTURES.has(tid)) continue;
      if (this.resolvedTextures.has(tid)) {
        entry.texturesReady.add(tid);
      }
      entry.needsTextures.add(tid);
      if (!entry.texturesReady.has(tid)) {
        let set = this.textureToObjects.get(tid);
        if (!set) {
          set = new Set();
          this.textureToObjects.set(tid, set);
        }
        set.add(uuid);
      }
    }
    this.checkAndEmit(uuid);
  }

  /** Remove object from tracking (killed before completion). */
  remove(uuid: string): void {
    const entry = this.pending.get(uuid);
    if (!entry) return;

    // Clean up mesh reverse index
    if (entry.needsMesh) {
      const set = this.meshToObjects.get(entry.needsMesh);
      if (set) {
        set.delete(uuid);
        if (set.size === 0) this.meshToObjects.delete(entry.needsMesh);
      }
    }

    // Clean up texture reverse indices
    for (const tid of entry.needsTextures) {
      const set = this.textureToObjects.get(tid);
      if (set) {
        set.delete(uuid);
        if (set.size === 0) this.textureToObjects.delete(tid);
      }
    }

    // Clean up material reverse indices
    for (const mid of entry.needsMaterials) {
      const set = this.materialToObjects.get(mid);
      if (set) {
        set.delete(uuid);
        if (set.size === 0) this.materialToObjects.delete(mid);
      }
    }

    this.pending.delete(uuid);
  }

  /** Clear all pending state (region change). */
  clearAll(): void {
    this.pending.clear();
    this.meshToObjects.clear();
    this.textureToObjects.clear();
    this.materialToObjects.clear();
    this.resolvedMeshes.clear();
    this.resolvedTextures.clear();
    this.resolvedMaterials.clear();
    this.emitted.clear();
    this.attachments.clear();
    this.childrenWaitingForParent.clear();
  }

  /** Check if an object UUID is an attachment (or child of one). */
  isAttachment(uuid: string): boolean {
    return this.attachments.has(uuid);
  }

  /** Log objects that have been pending a long time (assets not yet arrived). */
  sweepTimeouts(maxAgeMs: number = 30000): void {
    const now = Date.now();
    let staleCount = 0;
    let sampleUuid = '';
    let sampleWaiting = '';

    // Collect all unique missing texture IDs across stale objects
    const allMissingTex = new Map<string, number>(); // textureId → count of objects blocked
    let waitingForParent = 0;
    let waitingForMaterial = 0;

    for (const [uuid, entry] of this.pending) {
      if (now - entry.createdAt > maxAgeMs) {
        staleCount++;
        if (!sampleUuid) {
          sampleUuid = uuid.substring(0, 8);
          const waitMesh = !entry.meshReady ? `mesh=${entry.needsMesh?.substring(0, 8)}` : '';
          const missingTex = [...entry.needsTextures].filter(t => !entry.texturesReady.has(t));
          const waitTex = missingTex.length > 0 ? `tex=${missingTex.length}missing(${missingTex.map(t => t.substring(0, 8)).join(',')})` : '';
          const missingMat = [...entry.needsMaterials].filter(m => !entry.materialsReady.has(m));
          const waitMat = missingMat.length > 0 ? `mat=${missingMat.length}missing(${missingMat.map(m => m.substring(0, 8)).join(',')})` : '';
          // Check if blocked on parent
          const waitParent = entry.parentUuid && !this.emitted.has(entry.parentUuid) ? `parent=${entry.parentUuid.substring(0, 8)}` : '';
          sampleWaiting = [waitMesh, waitTex, waitMat, waitParent].filter(Boolean).join(' ');
        }
        // Track missing textures
        const missing = [...entry.needsTextures].filter(t => !entry.texturesReady.has(t));
        for (const tid of missing) {
          allMissingTex.set(tid, (allMissingTex.get(tid) || 0) + 1);
        }
        if (entry.parentUuid && !this.emitted.has(entry.parentUuid)) {
          waitingForParent++;
        }
        if (entry.materialsReady.size < entry.needsMaterials.size) {
          waitingForMaterial++;
        }
      }
    }

    if (staleCount > 0) {
      // Show top 3 blocking textures
      const topBlockers = [...allMissingTex.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const blockerStr = topBlockers.map(([tid, n]) => `${tid.substring(0, 8)}(${n}objs)`).join(' ');
      pkDebug('readiness', `[ReadinessTracker] ${staleCount} objects still waiting (>${(maxAgeMs / 1000).toFixed(0)}s) sample=${sampleUuid} ${sampleWaiting} | top_blocked_tex: ${blockerStr} | waiting_for_parent: ${waitingForParent} waiting_for_mat: ${waitingForMaterial}`);
    }
  }

  /** Mark a UUID as emitted without tracking it (e.g. avatars sent via avatar_create). */
  markEmitted(uuid: string): void {
    this.emitted.add(uuid);
    // Flush children waiting for this parent
    const waitingChildren = this.childrenWaitingForParent.get(uuid);
    if (waitingChildren) {
      this.childrenWaitingForParent.delete(uuid);
      for (const childUuid of waitingChildren) {
        this.checkAndEmit(childUuid);
      }
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Emit when mesh AND all textures AND all materials are resolved AND parent already emitted. */
  private checkAndEmit(uuid: string): void {
    const entry = this.pending.get(uuid);
    if (!entry) return;
    if (!entry.meshReady) return;
    if (entry.texturesReady.size < entry.needsTextures.size) return;
    if (entry.materialsReady.size < entry.needsMaterials.size) return;

    // Parent ordering: child must wait until parent has been emitted
    if (entry.parentUuid && !this.emitted.has(entry.parentUuid)) {
      // Register as waiting for parent
      let children = this.childrenWaitingForParent.get(entry.parentUuid);
      if (!children) {
        children = new Set();
        this.childrenWaitingForParent.set(entry.parentUuid, children);
      }
      children.add(uuid);
      return;
    }

    this.emit(uuid);
  }

  /** Send the object_render message and clean up. */
  private emit(uuid: string): void {
    const entry = this.pending.get(uuid);
    if (!entry) return;

    // Propagate attachment status from parent to child
    const msg = entry.renderMsg;
    if (msg.isAttachment || (msg.parentUuid && this.attachments.has(msg.parentUuid))) {
      msg.isAttachment = true;
      this.attachments.add(uuid);
    }

    // Enrich message with asset paths before sending
    if (this.enrichFn) this.enrichFn(msg);
    this.send(msg);
    this.emitted.add(uuid);
    this.remove(uuid);

    // Flush children that were waiting for this parent to be emitted
    const waitingChildren = this.childrenWaitingForParent.get(uuid);
    if (waitingChildren) {
      this.childrenWaitingForParent.delete(uuid);
      for (const childUuid of waitingChildren) {
        this.checkAndEmit(childUuid);
      }
    }
  }
}
