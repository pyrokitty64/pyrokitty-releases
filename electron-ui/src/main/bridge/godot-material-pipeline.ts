/**
 * GodotFaceUpdateBatcher — coalesces per-object face updates into batched
 * messages for delivery to Godot over WebSocket.
 *
 * All material resolution logic has moved to MaterialResolver.
 */

import type { SendFn } from './godot-bridge-types';
import type { ResolvedMaterial } from '../materials/resolved-material';

/** Convert a ResolvedMaterial to the legacy Godot face wire format */
export function resolvedToGodotFace(index: number, material: ResolvedMaterial): any {
  // Hollow prim inner face (SL face 2): render before outer faces for correct alpha blending
  const renderPri = (index === 2 && material.baseColorFactor[3] < 1.0) ? -1 : 0;

  const face: any = {
    index,
    textureId: material.baseColorTexture,
    color: material.baseColorFactor,
    fullBright: material.unshaded,
    doubleSided: material.doubleSided,
    alphaMode: material.alphaMode,
    alphaCutoff: material.alphaCutoff,
    repeatU: material.repeatU,
    repeatV: material.repeatV,
    offsetU: material.offsetU,
    offsetV: material.offsetV,
    rotation: material.rotation,
    ...(renderPri !== 0 ? { renderPriority: renderPri } : {}),
  };
  if (material.mappingType) face.mappingType = material.mappingType;
  if (material.normalTexture) face.normalTextureId = material.normalTexture;
  if (material.ormTexture) face.ormTextureId = material.ormTexture;
  if (material.emissiveTexture) face.emissiveTextureId = material.emissiveTexture;
  if (material.metallicFactor !== undefined) face.metallicFactor = material.metallicFactor;
  if (material.roughnessFactor !== 1) face.roughnessFactor = material.roughnessFactor;
  if (material.emissiveFactor.some(v => v !== 0)) face.emissiveFactor = material.emissiveFactor;

  return face;
}

/** Format a float to 2 decimal places (matches Godot's "%.2f" sprintf). */
function f2(n: number): string { return n.toFixed(2); }

/** Convert RGBA [0-1] array to 8-char hex (RRGGBBAA), matching Godot Color.to_html(). */
function colorHex(c: number[]): string {
  const r = Math.round((c[0] ?? 1) * 255);
  const g = Math.round((c[1] ?? 1) * 255);
  const b = Math.round((c[2] ?? 1) * 255);
  const a = Math.round((c[3] ?? 1) * 255);
  return ((r << 24) | (g << 16) | (b << 8) | a).toString(16).padStart(8, '0');
}

/**
 * Compute the material cache key for a face and set derived values.
 * Called from enrichFn after texture opacity is known. Sets:
 *   face.materialKey — cache key for Godot's material_cache
 *   face.resolvedAlphaMode — alpha mode after blend→opaque promotion
 */
export function enrichFaceMaterialKey(face: any, isAttachment: boolean = false): void {
  const color: number[] = face.color ?? [1, 1, 1, 1];

  // Fully transparent faces have no visual contribution — share one invisible material.
  if (color[3] <= 0) {
    face.materialKey = '__invisible';
    face.resolvedAlphaMode = 2;   // mask
    face.alphaCutoff = 1.0;       // cutoff=1.0 → every fragment discarded
    return;
  }

  const texId: string = face.textureId ?? '';
  const opaque: boolean = face.textureOpaque ?? false;
  const alphaMode: number = face.alphaMode ?? 0;

  // Blend→opaque promotion: skip expensive transparent render path when
  // texture is known-opaque (BC1/DXT1) and face color is fully opaque.
  const resolvedMode = (alphaMode === 1 && color[3] >= 1.0 && opaque) ? 0 : alphaMode;
  face.resolvedAlphaMode = resolvedMode;

  const ch = colorHex(color);
  const fb = face.fullBright ? '1' : '0';
  const ds = face.doubleSided ? '1' : '0';
  const uv = `${f2(face.repeatU ?? 1)}_${f2(face.repeatV ?? 1)}_${f2(face.offsetU ?? 0)}_${f2(face.offsetV ?? 0)}_${f2(face.rotation ?? 0)}`;
  const alpha = `${resolvedMode}_${f2(face.alphaCutoff ?? 0.5)}`;

  // PBR texture IDs — always included (all textures are on disk at emit time)
  const normId: string = face.normalTextureId ?? '';
  const ormId: string = face.ormTextureId ?? '';
  const emisId: string = face.emissiveTextureId ?? '';
  const metal = f2(face.metallicFactor ?? 0);
  const rough = f2(face.roughnessFactor ?? 1);
  const ef: number[] = face.emissiveFactor ?? [0, 0, 0];
  const pbr = `_${normId}_${ormId}_${emisId}_${metal}_${rough}_${f2(ef[0])}_${f2(ef[1])}_${f2(ef[2])}`;

  const map = (face.mappingType && face.mappingType !== 0) ? `m${face.mappingType}` : '';

  const renderPri: number = face.renderPriority ?? 0;
  const pri = renderPri !== 0 ? `p${renderPri}` : '';

  const ah = isAttachment ? '_ah' : '';
  face.materialKey = `${texId}_${ch}_${fb}_${ds}_${uv}_${alpha}${pbr}${map}${pri}${ah}`;
}

/** Texture path + opacity lookup, set by godot-bridge after construction. */
export type TexturePathLookup = (textureId: string) => { path: string; opaque: boolean } | undefined;

export class GodotFaceUpdateBatcher {
  private faceUpdateBuffer = new Map<string, any[]>();
  private faceUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FACE_UPDATE_FLUSH_MS = 50;
  private static readonly DEFERRED_RETRY_MS = 200;

  /** Set by godot-bridge — looks up texture disk path + opacity from the texturePaths map. */
  textureLookup?: TexturePathLookup;
  /** Set by godot-bridge — checks if an object UUID is an attachment (for material key suffix). */
  isAttachment?: (uuid: string) => boolean;

  constructor(private send: SendFn) {}

  /** Queue a face update for batched delivery to Godot. Multiple updates for the same
   *  object within the flush window are coalesced (latest per face index wins). */
  queueFaceUpdate(objectUuid: string, faces: any[]): void {
    const existing = this.faceUpdateBuffer.get(objectUuid);
    if (existing) {
      for (const face of faces) {
        const idx = existing.findIndex((f: any) => f.index === face.index);
        if (idx >= 0) {
          existing[idx] = face;
        } else {
          existing.push(face);
        }
      }
    } else {
      this.faceUpdateBuffer.set(objectUuid, [...faces]);
    }
    if (!this.faceUpdateTimer) {
      this.faceUpdateTimer = setTimeout(() => this.flushFaceUpdates(), GodotFaceUpdateBatcher.FACE_UPDATE_FLUSH_MS);
    }
  }

  /** Enrich a face with texture paths, opacity, and materialKey.
   *  Returns true if all textures are available. */
  private enrichFace(face: any, isAtt: boolean = false): boolean {
    const lookup = this.textureLookup;
    if (!lookup) return true; // no lookup = pass through (shouldn't happen)

    let allReady = true;
    if (face.textureId) {
      const tex = lookup(face.textureId);
      if (tex) {
        face.texturePath = tex.path;
        if (tex.opaque) face.textureOpaque = true;
      } else {
        allReady = false;
      }
    }
    for (const key of ['normalTextureId', 'ormTextureId', 'emissiveTextureId']) {
      if (face[key]) {
        const pathKey = key.replace('Id', 'Path');
        const tex = lookup(face[key]);
        if (tex) {
          face[pathKey] = tex.path;
        } else {
          allReady = false;
        }
      }
    }
    if (allReady) {
      enrichFaceMaterialKey(face, isAtt);
    }
    return allReady;
  }

  private flushFaceUpdates(): void {
    this.faceUpdateTimer = null;
    if (this.faceUpdateBuffer.size === 0) return;

    const ready: any[] = [];
    const deferred = new Map<string, any[]>();

    for (const [uuid, faces] of this.faceUpdateBuffer) {
      const isAtt = this.isAttachment?.(uuid) ?? false;
      let allReady = true;
      for (const face of faces) {
        if (!this.enrichFace(face, isAtt)) {
          allReady = false;
        }
      }
      if (allReady) {
        ready.push({ uuid, faces });
      } else {
        deferred.set(uuid, faces);
      }
    }
    this.faceUpdateBuffer.clear();

    // Send ready updates
    if (ready.length > 0) {
      this.send({ type: 'object_update_faces_batch', objects: ready });
    }

    // Re-queue deferred updates (textures still downloading)
    if (deferred.size > 0) {
      for (const [uuid, faces] of deferred) {
        this.faceUpdateBuffer.set(uuid, faces);
      }
      if (!this.faceUpdateTimer) {
        this.faceUpdateTimer = setTimeout(() => this.flushFaceUpdates(), GodotFaceUpdateBatcher.DEFERRED_RETRY_MS);
      }
    }
  }

  cleanup(): void {
    if (this.faceUpdateTimer) {
      clearTimeout(this.faceUpdateTimer);
      this.faceUpdateTimer = null;
    }
    this.faceUpdateBuffer.clear();
  }
}
