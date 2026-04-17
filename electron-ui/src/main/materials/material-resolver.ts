/**
 * MaterialResolver — viewer-agnostic material resolution with async fetching.
 *
 * Encapsulates all logic for resolving SL object faces into ResolvedMaterials:
 * - Legacy material fetch/cache
 * - PBR material asset tracking
 * - BoM bake substitution
 * - Texture fetch coordination
 * - Race condition prevention (PBR faces skip legacy re-emit)
 *
 * Emits resolved materials via callback. Viewers wire this callback to
 * convert ResolvedMaterial → their native format.
 */

import type { Bot } from '../../../node-metaverse/lib';
import { Material } from '../../../node-metaverse/lib/classes/public/Material';
import type { MaterialOverrideData, TextureTransform } from '../assets/material-fetch-queue';
import type { MaterialFetchQueue } from '../assets/material-fetch-queue';
import type { TextureFetchQueue } from '../assets/texture-fetch-queue';
import {
  ZERO_UUID, BAKE_MAGIC_UUIDS, TRANSPARENT_TEXTURES,
  SOLID_COLOR_TEXTURES, WATER_EXCLUSION_TEXTURES,
} from '../bridge/godot-bridge-types';
import type { ResolvedMaterial, MaterialResolvedCallback, BakeTextureProvider } from './resolved-material';
import { resolveLegacyFace, resolvePbrFace } from './resolve-face';
import type { FaceInput, LegacyCachedMaterial, PbrMaterialInput } from './resolve-face';

// ── Types ────────────────────────────────────────────────────────────

interface PbrFaceEntry {
  objectUuid: string;
  faceIndex: number;
  face: FaceInput;
}

interface LegacyFaceRef {
  objectUuid: string;
  faceIndex: number;
}

// ── MaterialResolver ────────────────────────────────────────────────

export class MaterialResolver {
  // PBR material asset → faces waiting for it
  private materialToFaces = new Map<string, PbrFaceEntry[]>();

  // Legacy material cache and fetch state
  private legacyMaterialCache = new Map<string, LegacyCachedMaterial>();
  private legacyMaterialPending = new Set<string>();
  private legacyMaterialFetching = false;
  private legacyMaterialToFaces = new Map<string, LegacyFaceRef[]>();

  // Stats
  private pbrFaceCount = 0;

  // Injected dependencies (late-bound)
  private materialFetchQueue: MaterialFetchQueue | null = null;
  private textureFetchQueue: TextureFetchQueue | null = null;
  private bakeProvider: BakeTextureProvider | null = null;

  constructor(
    private bot: Bot,
    private trackedObjects: Set<string>,
    private onResolved: MaterialResolvedCallback,
  ) {}

  initQueues(materialFetchQueue: MaterialFetchQueue, textureFetchQueue: TextureFetchQueue): void {
    this.materialFetchQueue = materialFetchQueue;
    this.textureFetchQueue = textureFetchQueue;
  }

  setBakeProvider(provider: BakeTextureProvider): void {
    this.bakeProvider = provider;
  }

  // ── Face extraction ──────────────────────────────────────────────

  /** Extract a FaceInput from a raw TextureEntryFace-like object */
  private extractFace(rawFace: any): FaceInput {
    const rgba = rawFace.rgba;
    let color = rgba
      ? [rgba.getRed(), rgba.getGreen(), rgba.getBlue(), rgba.getAlpha()]
      : [1, 1, 1, 1];

    const legacyTexId = rawFace.textureID?.toString() || '';

    // Built-in transparent textures — force alpha to 0
    if (TRANSPARENT_TEXTURES.has(legacyTexId)) {
      color = [color[0], color[1], color[2], 0];
    }

    return {
      textureID: legacyTexId,
      color,
      materialFlags: rawFace.material ?? 0,
      glow: rawFace.glow ?? 0,
      repeatU: rawFace.repeatU ?? 1,
      repeatV: rawFace.repeatV ?? 1,
      offsetU: rawFace.offsetU ?? 0,
      offsetV: rawFace.offsetV ?? 0,
      rotation: rawFace.rotation ?? 0,
      ...(rawFace.mappingType ? { mappingType: rawFace.mappingType } : {}),
    };
  }

  /** Convert a gltfMaterialOverride entry to PbrMaterialInput */
  private overrideToPbrInput(override: any): PbrMaterialInput {
    const input: PbrMaterialInput = {};
    if (override.textures && Array.isArray(override.textures)) {
      const t0 = override.textures[0]?.toString();
      const t1 = override.textures[1]?.toString();
      const t2 = override.textures[2]?.toString();
      const t3 = override.textures[3]?.toString();
      if (t0 && t0 !== ZERO_UUID) input.baseColorTextureId = t0;
      if (t1 && t1 !== ZERO_UUID) input.normalTextureId = t1;
      if (t2 && t2 !== ZERO_UUID) input.ormTextureId = t2;
      if (t3 && t3 !== ZERO_UUID) input.emissiveTextureId = t3;
    }
    if (override.baseColor) input.baseColor = override.baseColor;
    if (override.metallicFactor !== undefined) input.metallicFactor = override.metallicFactor;
    if (override.roughnessFactor !== undefined) input.roughnessFactor = override.roughnessFactor;
    if (override.emissiveFactor) input.emissiveFactor = override.emissiveFactor;
    if (override.alphaMode !== undefined) input.alphaMode = override.alphaMode;
    if (override.alphaCutoff !== undefined) input.alphaCutoff = override.alphaCutoff;
    if (override.doubleSided !== undefined) input.doubleSided = override.doubleSided;
    if (override.textureTransforms && Array.isArray(override.textureTransforms) && override.textureTransforms[0]) {
      input.baseColorTransform = override.textureTransforms[0];
    }
    return input;
  }

  /** Convert MaterialOverrideData (from material asset) to PbrMaterialInput */
  private materialDataToPbrInput(data: MaterialOverrideData): PbrMaterialInput {
    return {
      baseColorTextureId: data.baseColorTextureId,
      normalTextureId: data.normalTextureId,
      ormTextureId: data.ormTextureId,
      emissiveTextureId: data.emissiveTextureId,
      baseColor: data.baseColor,
      metallicFactor: data.metallicFactor,
      roughnessFactor: data.roughnessFactor,
      emissiveFactor: data.emissiveFactor,
      alphaMode: data.alphaMode,
      alphaCutoff: data.alphaCutoff,
      doubleSided: data.doubleSided,
      baseColorTransform: data.textureTransforms?.[0] ?? null,
    };
  }

  // ── Bake substitution ────────────────────────────────────────────

  /**
   * Attempt to substitute a bake magic UUID with the actual baked texture.
   * Returns the resolved texture ID and bake metadata.
   */
  private substituteBake(textureId: string, objectUuid: string): {
    textureId: string;
    isBake: boolean;
    bakeAvatarUuid?: string;
    bakeChannel?: number;
  } {
    if (!BAKE_MAGIC_UUIDS.has(textureId) || !this.bakeProvider) {
      return { textureId, isBake: false };
    }

    try {
      const obj = this.bot.currentRegion?.objects?.getObjectByUUID(objectUuid as any);
      if (!obj?.ParentID) return { textureId, isBake: false };

      const parentObj = this.bot.currentRegion?.objects?.getObjectByLocalID(obj.ParentID);
      const parentUuid = parentObj?.FullID?.toString() || '';
      if (!parentUuid) return { textureId, isBake: false };

      const avatarId = this.bakeProvider.findOwnerAvatar(parentUuid);
      if (!avatarId) return { textureId, isBake: false };

      const bakes = this.bakeProvider.getBakedTextures(avatarId);
      const channel = BAKE_MAGIC_UUIDS.get(textureId);
      if (bakes && channel !== undefined) {
        const bakedUuid = bakes[channel];
        if (bakedUuid && bakedUuid !== ZERO_UUID) {
          return { textureId: bakedUuid, isBake: true, bakeAvatarUuid: avatarId, bakeChannel: channel };
        }
      }
    } catch { /* object may not exist */ }

    return { textureId, isBake: false };
  }

  // ── Texture fetch coordination ───────────────────────────────────

  /** Request a texture download, handling bake vs normal textures */
  private requestTexture(textureId: string, objectUuid: string, isBake: boolean, bakeAvatarUuid?: string, bakeChannel?: number): void {
    if (!this.textureFetchQueue) return;
    if (!textureId) return;
    if (WATER_EXCLUSION_TEXTURES.has(textureId)) return;
    if (BAKE_MAGIC_UUIDS.has(textureId)) return;
    if (TRANSPARENT_TEXTURES.has(textureId)) return;
    if (SOLID_COLOR_TEXTURES.has(textureId)) return;

    if (isBake && bakeAvatarUuid && bakeChannel != null) {
      this.textureFetchQueue.requestBake(textureId, objectUuid, bakeAvatarUuid, bakeChannel);
    } else {
      this.textureFetchQueue.request(textureId, objectUuid);
    }
  }

  /** Request texture downloads for all textures in a resolved material */
  private requestTexturesForMaterial(material: ResolvedMaterial, objectUuid: string, isBake: boolean, bakeAvatarUuid?: string, bakeChannel?: number): void {
    this.requestTexture(material.baseColorTexture, objectUuid, isBake, bakeAvatarUuid, bakeChannel);
    if (material.normalTexture) this.requestTexture(material.normalTexture, objectUuid, false);
    if (material.ormTexture) this.requestTexture(material.ormTexture, objectUuid, false);
    if (material.emissiveTexture) this.requestTexture(material.emissiveTexture, objectUuid, false);
  }

  // ── Main API ─────────────────────────────────────────────────────

  /**
   * Resolve all faces of an object. Emits immediately for faces with
   * available data, queues async fetches for missing materials.
   *
   * Returns the resolved face data for the initial snapshot (used by
   * object_complete messages). Faces covered by PBR material assets
   * are NOT included — they emit later via handleMaterialReady.
   *
   * @param emit — when true, calls onResolved for each face (used for
   *               live updates). When false (default), only returns data
   *               (used for initial object_complete).
   */
  resolveObject(obj: any, emit = false): {
    faces: { index: number; resolved: ResolvedMaterial; isBake: boolean; bakeAvatarUuid?: string; bakeChannel?: number }[];
    textureIds: string[];
    materialIds: string[];
  } | undefined {
    try {
      const te = obj.TextureEntry;
      if (!te || !te.defaultTexture) return undefined;

      const objectUuid = obj.FullID?.toString() || '';

      // Determine which face indices have PBR material assets
      const rmd = obj.extraParams?.renderMaterialData;
      const materialFaceIndices = new Map<number, string>(); // faceIndex → materialUuid
      if (rmd && rmd.params && rmd.params.length > 0) {
        for (const param of rmd.params) {
          const matUuid = param.textureUUID?.toString();
          if (matUuid && matUuid !== ZERO_UUID) {
            materialFaceIndices.set(param.textureIndex, matUuid);
          }
        }
      }
      // Parse inline gltf overrides
      const overrides = te.gltfMaterialOverrides;
      const inlineOverrides = new Map<number, PbrMaterialInput>();
      let defaultDS = false;
      if (overrides && overrides.size > 0) {
        for (const [idx, override] of overrides) {
          inlineOverrides.set(idx, this.overrideToPbrInput(override));
          if (override.doubleSided !== undefined && defaultDS === false) {
            defaultDS = override.doubleSided;
          }
        }
      }

      const resultFaces: { index: number; resolved: ResolvedMaterial; isBake: boolean; bakeAvatarUuid?: string; bakeChannel?: number }[] = [];
      const textureIdSet = new Set<string>();
      const materialIdSet = new Set<string>();

      for (let i = 0; i < 8; i++) {
        const rawFace = te.faces[i] ?? te.defaultTexture;
        const face = this.extractFace(rawFace);
        if (!face.textureID || face.textureID === ZERO_UUID) continue;

        const materialUuid = materialFaceIndices.get(i);
        const inlineOverride = inlineOverrides.get(i) ?? null;

        if (materialUuid) {
          // ── PBR face with material asset ──
          // Register for async material fetch; do NOT emit now (race condition fix).
          // Skip legacy material registration entirely for this face.
          let list = this.materialToFaces.get(materialUuid);
          if (!list) {
            list = [];
            this.materialToFaces.set(materialUuid, list);
          }
          list.push({ objectUuid, faceIndex: i, face });
          materialIdSet.add(materialUuid);

          // Only request during live updates (emit=true). For initial objects,
          // the sender calls requestMaterials() after track() to ensure the
          // readiness tracker can patch pending faces when the callback fires.
          if (emit && this.materialFetchQueue) {
            this.materialFetchQueue.request(materialUuid);
          }
        } else if (inlineOverride) {
          // ── PBR face with inline override only (no material asset) ──
          // Apply doubleSided default if not explicitly set
          if (inlineOverride.doubleSided === undefined) {
            inlineOverride.doubleSided = defaultDS;
          }

          const bakeResult = this.substituteBake(face.textureID, objectUuid);
          const faceForResolve = bakeResult.isBake
            ? { ...face, textureID: bakeResult.textureId }
            : face;

          const resolved = resolvePbrFace(inlineOverride, null, faceForResolve);
          if (emit) this.onResolved(objectUuid, i, resolved);
          this.pbrFaceCount++;

          resultFaces.push({
            index: i, resolved,
            isBake: bakeResult.isBake, bakeAvatarUuid: bakeResult.bakeAvatarUuid, bakeChannel: bakeResult.bakeChannel,
          });
          this.collectTextureIds(resolved, textureIdSet);
          this.requestTexturesForMaterial(resolved, objectUuid, bakeResult.isBake, bakeResult.bakeAvatarUuid, bakeResult.bakeChannel);
        } else {
          // ── Legacy face ──
          const matId = rawFace.materialID?.toString();
          const cached = (matId && matId !== ZERO_UUID) ? this.legacyMaterialCache.get(matId) : undefined;

          const bakeResult = this.substituteBake(face.textureID, objectUuid);
          const faceForResolve = bakeResult.isBake
            ? { ...face, textureID: bakeResult.textureId }
            : face;

          const resolved = resolveLegacyFace(faceForResolve, cached);
          if (emit) this.onResolved(objectUuid, i, resolved);

          resultFaces.push({
            index: i, resolved,
            isBake: bakeResult.isBake, bakeAvatarUuid: bakeResult.bakeAvatarUuid, bakeChannel: bakeResult.bakeChannel,
          });
          this.collectTextureIds(resolved, textureIdSet);
          this.requestTexturesForMaterial(resolved, objectUuid, bakeResult.isBake, bakeResult.bakeAvatarUuid, bakeResult.bakeChannel);

          // Queue legacy material fetch if needed (NOT for PBR faces — race condition fix)
          if (matId && matId !== ZERO_UUID && !this.legacyMaterialCache.has(matId)) {
            let faceList = this.legacyMaterialToFaces.get(matId);
            if (!faceList) {
              faceList = [];
              this.legacyMaterialToFaces.set(matId, faceList);
            }
            faceList.push({ objectUuid, faceIndex: i });
            this.legacyMaterialPending.add(matId);
          }
        }
      }

      // Kick off legacy material fetch if any pending
      if (this.legacyMaterialPending.size > 0 && !this.legacyMaterialFetching) {
        this.flushLegacyMaterialFetch();
      }

      if (resultFaces.length === 0 && materialFaceIndices.size === 0) return undefined;
      return { faces: resultFaces, textureIds: Array.from(textureIdSet), materialIds: Array.from(materialIdSet) };
    } catch (err) {
      const objUuid = obj.FullID?.toString() || 'unknown';
      console.error(`[MaterialResolver] resolveObject failed for ${objUuid.slice(0, 8)}:`, err);
      return undefined;
    }
  }

  /** Collect fetchable texture IDs from a resolved material into a set.
   *  Skips the same unfetchable UUIDs that requestTexture() skips. */
  private collectTextureIds(material: ResolvedMaterial, out: Set<string>): void {
    for (const tid of [material.baseColorTexture, material.normalTexture, material.ormTexture, material.emissiveTexture]) {
      if (!tid) continue;
      if (TRANSPARENT_TEXTURES.has(tid)) continue;
      if (SOLID_COLOR_TEXTURES.has(tid)) continue;
      if (WATER_EXCLUSION_TEXTURES.has(tid)) continue;
      if (BAKE_MAGIC_UUIDS.has(tid)) continue;
      out.add(tid);
    }
  }

  // ── PBR material fetch ───────────────────────────────────────────

  /** Request material assets from the fetch queue. Called by the sender AFTER
   *  the readiness tracker has registered the object, so synchronous cache-hit
   *  callbacks can patch pending face data via updatePendingFaces(). */
  requestMaterials(materialIds: string[]): void {
    if (!this.materialFetchQueue) return;
    for (const matId of materialIds) {
      this.materialFetchQueue.request(matId);
    }
  }

  /**
   * Handle a PBR material asset being fetched and parsed.
   * Re-resolves all faces waiting on this material and emits updates.
   */
  handleMaterialReady(materialUuid: string, data: MaterialOverrideData): void {
    const entries = this.materialToFaces.get(materialUuid);
    if (!entries || entries.length === 0) return;

    const pbrInput = this.materialDataToPbrInput(data);

    for (const { objectUuid, faceIndex, face } of entries) {
      const tracked = this.trackedObjects.has(objectUuid);
      if (!tracked) continue;

      // Read inline GLTF overrides from the live object — they arrive via
      // GenericStreamingMessage AFTER the ObjectUpdate that triggered resolveObject,
      // so they aren't available at track time.
      let inlineOverride: PbrMaterialInput | null = null;
      try {
        const obj = this.bot.currentRegion?.objects?.getObjectByUUID(objectUuid as any);
        const overrideMap = obj?.TextureEntry?.gltfMaterialOverrides;
        if (overrideMap?.size) {
          const raw = overrideMap.get(faceIndex);
          if (raw) inlineOverride = this.overrideToPbrInput(raw);
        }
      } catch { /* object may have been removed */ }

      // Bake substitution: if legacy face has a bake magic UUID, use bake
      const legacyTexId = face.textureID;
      const bakeResult = BAKE_MAGIC_UUIDS.has(legacyTexId)
        ? this.substituteBake(legacyTexId, objectUuid)
        : { textureId: legacyTexId, isBake: false as const };

      const faceForResolve = bakeResult.isBake
        ? { ...face, textureID: bakeResult.textureId }
        : face;

      const resolved = resolvePbrFace(pbrInput, inlineOverride, faceForResolve);
      this.onResolved(objectUuid, faceIndex, resolved);
      this.pbrFaceCount++;
      this.requestTexturesForMaterial(
        resolved, objectUuid,
        bakeResult.isBake, bakeResult.bakeAvatarUuid, bakeResult.bakeChannel,
      );
    }

    this.materialToFaces.delete(materialUuid);
  }

  /** Clean up tracking state for a material that failed to fetch.
   *  The faces that depended on this material will render with legacy appearance. */
  handleMaterialFailed(materialUuid: string): void {
    this.materialToFaces.delete(materialUuid);
  }

  // ── Live texture updates ─────────────────────────────────────────

  /** Handle a live texture/UV change on a tracked object */
  handleObjectTextureUpdate(obj: any): void {
    const objectUuid = obj.FullID?.toString() || '';
    if (!this.trackedObjects.has(objectUuid)) return;

    // Re-resolve all faces with emit=true so updates go through the callback
    this.resolveObject(obj, true);
  }

  // ── Bake texture updates ─────────────────────────────────────────

  /**
   * Handle bake textures arriving/changing for an avatar.
   * Re-resolves all tracked bake objects for that avatar.
   */
  handleBakeTextureUpdate(avatarId: string, objectUuids: Iterable<string>): void {
    for (const objectUuid of objectUuids) {
      if (!this.trackedObjects.has(objectUuid)) continue;
      try {
        const obj = this.bot.currentRegion?.objects?.getObjectByUUID(objectUuid as any);
        if (!obj || obj.deleted) continue;
        this.resolveObject(obj, true);
      } catch { /* object may not exist anymore */ }
    }
  }

  // ── Legacy material fetch ────────────────────────────────────────

  /** Batch-fetch legacy materials via RenderMaterials cap */
  private async flushLegacyMaterialFetch(): Promise<void> {
    if (this.legacyMaterialFetching || this.legacyMaterialPending.size === 0) return;
    this.legacyMaterialFetching = true;
    try {
      const uuids: Record<string, Material | null> = {};
      for (const uuid of this.legacyMaterialPending) {
        uuids[uuid] = null;
      }
      this.legacyMaterialPending.clear();

      await this.bot.clientCommands.asset.getMaterials(uuids);

      for (const [uuid, mat] of Object.entries(uuids)) {
        if (mat) {
          const entry: LegacyCachedMaterial = {
            alphaMode: mat.diffuseAlphaMode ?? 1,
            alphaCutoff: mat.alphaMaskCutoff != null ? mat.alphaMaskCutoff / 255 : 0.5,
          };
          const normMap = mat.normMap?.toString();
          if (normMap && normMap !== ZERO_UUID) {
            entry.normMap = normMap;
            // Request normal map texture
            if (this.textureFetchQueue) {
              this.textureFetchQueue.request(normMap, '');
            }
          }
          if (mat.specExp != null && mat.specExp > 0) {
            entry.specExp = mat.specExp;
          }
          if (mat.envIntensity != null && mat.envIntensity > 0) {
            entry.envIntensity = mat.envIntensity;
          }
          this.legacyMaterialCache.set(uuid, entry);
        }

        // Re-resolve affected faces
        const faceRefs = this.legacyMaterialToFaces.get(uuid);
        if (faceRefs) {
          this.legacyMaterialToFaces.delete(uuid);
          const byObject = new Map<string, number[]>();
          for (const { objectUuid, faceIndex } of faceRefs) {
            if (!this.trackedObjects.has(objectUuid)) continue;
            let list = byObject.get(objectUuid);
            if (!list) { list = []; byObject.set(objectUuid, list); }
            list.push(faceIndex);
          }
          for (const [objectUuid, faceIndices] of byObject) {
            let obj: any;
            try {
              obj = this.bot.currentRegion?.objects?.getObjectByUUID(objectUuid as any);
            } catch { continue; }
            if (!obj) continue;

            // Re-extract and re-resolve just the affected faces
            const te = obj.TextureEntry;
            if (!te) continue;
            for (const idx of faceIndices) {
              const rawFace = te.faces?.[idx] ?? te.defaultTexture;
              if (!rawFace) continue;
              const face = this.extractFace(rawFace);
              if (!face.textureID || face.textureID === ZERO_UUID) continue;

              const matId = rawFace.materialID?.toString();
              const cached = (matId && matId !== ZERO_UUID) ? this.legacyMaterialCache.get(matId) : undefined;

              const bakeResult = this.substituteBake(face.textureID, objectUuid);
              const faceForResolve = bakeResult.isBake
                ? { ...face, textureID: bakeResult.textureId }
                : face;

              const resolved = resolveLegacyFace(faceForResolve, cached);
              this.onResolved(objectUuid, idx, resolved);
              this.requestTexturesForMaterial(
                resolved, objectUuid,
                bakeResult.isBake, bakeResult.bakeAvatarUuid, bakeResult.bakeChannel,
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn('[MaterialResolver] Legacy material fetch failed:', err);
    } finally {
      this.legacyMaterialFetching = false;
      if (this.legacyMaterialPending.size > 0) {
        this.flushLegacyMaterialFetch();
      }
    }
  }

  // ── Stats ────────────────────────────────────────────────────────

  get totalPbrFaceCount(): number {
    return this.pbrFaceCount;
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  cleanup(): void {
    this.materialToFaces.clear();
    this.legacyMaterialPending.clear();
    this.legacyMaterialToFaces.clear();
    if (this.materialFetchQueue) {
      this.materialFetchQueue.destroy();
      this.materialFetchQueue = null;
    }
  }
}
