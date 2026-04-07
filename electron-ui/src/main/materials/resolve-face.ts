/**
 * Pure functions for resolving SL face data into a uniform ResolvedMaterial.
 * No async, no state, no viewer-specific logic — fully unit-testable.
 */

import type { ResolvedMaterial } from './resolved-material';

// ── Input types ──────────────────────────────────────────────────────

/** Pre-extracted face data from TextureEntryFace */
export interface FaceInput {
  textureID: string;       // face.textureID.toString()
  color: number[];         // [r, g, b, a] from face.rgba
  materialFlags: number;   // raw material bitmask (fullbright = 0x20)
  glow: number;            // face.glow (0-1)
  repeatU: number;
  repeatV: number;
  offsetU: number;
  offsetV: number;
  rotation: number;
  mappingType?: number;    // 0=default, 2=planar
}

/** Cached legacy material properties (already fetched from SL) */
export interface LegacyCachedMaterial {
  alphaMode: number;       // diffuseAlphaMode (0=opaque, 1=blend, 2=mask)
  alphaCutoff: number;     // already scaled to 0-1 range
  normMap?: string;
  specExp?: number;        // raw SpecExp (0-255)
  envIntensity?: number;   // raw EnvIntensity (0-255)
}

/** PBR material data — used for both material assets and inline overrides */
export interface PbrMaterialInput {
  baseColorTextureId?: string;
  normalTextureId?: string;
  ormTextureId?: string;
  emissiveTextureId?: string;
  baseColor?: number[];       // [r, g, b, a]
  metallicFactor?: number;
  roughnessFactor?: number;
  emissiveFactor?: number[];  // [r, g, b]
  alphaMode?: number;         // 0=opaque, 1=blend, 2=mask
  alphaCutoff?: number;
  doubleSided?: boolean;
  /** Base color texture transform (extracted from textureTransforms[0]) */
  baseColorTransform?: {
    offset?: number[];  // [u, v]
    scale?: number[];   // [u, v]
    rotation?: number;
  } | null;
}

// ── Constants ────────────────────────────────────────────────────────

const FULLBRIGHT_MASK = 0x20;

// ── Pure resolution functions ────────────────────────────────────────

/**
 * Resolve a legacy (non-PBR) face into a ResolvedMaterial.
 *
 * Maps SL legacy material properties to PBR-shaped output:
 * - face.textureID → baseColorTexture
 * - face.color → baseColorFactor
 * - face.material & 0x20 → unshaded
 * - face.glow → emissiveFactor
 * - legacyCached.normMap → normalTexture
 * - legacyCached.specExp → roughnessFactor (1 - specExp/255)
 * - legacyCached.envIntensity → metallicFactor (envIntensity/255)
 * - legacyCached.alphaMode → alphaMode (0/1/2; absent → 1 blend)
 * - legacyCached.alphaCutoff → alphaCutoff
 */
export function resolveLegacyFace(
  face: FaceInput,
  legacyCached?: LegacyCachedMaterial | null,
): ResolvedMaterial {
  const fullBright = (face.materialFlags & FULLBRIGHT_MASK) !== 0;
  const glow = face.glow || 0;

  let alphaMode = 1; // default blend — matches SL behavior for faces without a material
  let alphaCutoff = 0.5;
  let normalTexture: string | undefined;
  let metallicFactor = 0;
  let roughnessFactor = 1;

  if (legacyCached) {
    alphaMode = legacyCached.alphaMode;
    alphaCutoff = legacyCached.alphaCutoff;

    normalTexture = legacyCached.normMap;

    if (legacyCached.specExp != null && legacyCached.specExp > 0) {
      roughnessFactor = 1.0 - legacyCached.specExp / 255;
    }
    if (legacyCached.envIntensity != null && legacyCached.envIntensity > 0) {
      metallicFactor = legacyCached.envIntensity / 255;
    }
  }

  const result: ResolvedMaterial = {
    baseColorTexture: face.textureID,
    baseColorFactor: face.color,
    emissiveFactor: glow > 0 ? [glow, glow, glow] : [0, 0, 0],
    metallicFactor,
    roughnessFactor,
    alphaMode,
    alphaCutoff,
    doubleSided: false,
    unshaded: fullBright,
    repeatU: face.repeatU,
    repeatV: face.repeatV,
    offsetU: face.offsetU,
    offsetV: face.offsetV,
    rotation: face.rotation,
  };

  if (normalTexture) result.normalTexture = normalTexture;
  if (face.mappingType) result.mappingType = face.mappingType;

  return result;
}

/**
 * Resolve a PBR face into a ResolvedMaterial.
 *
 * Merges: material asset data ← inline override ← legacy face fallbacks.
 * - Inline override values win over material asset values where set.
 * - UV: PBR baseColorTransform → legacy face → defaults.
 * - fullBright and glow come from legacy face (SL applies these to PBR faces too).
 * - emissiveFactor: PBR value wins; legacy glow as fallback.
 * - baseColorTexture: PBR value wins; legacy textureID as fallback.
 * - baseColorFactor: PBR baseColor wins; legacy color as fallback.
 */
export function resolvePbrFace(
  materialData: PbrMaterialInput,
  inlineOverride?: PbrMaterialInput | null,
  legacyFace?: FaceInput | null,
): ResolvedMaterial {
  // Start with material asset values
  let baseColorTextureId = materialData.baseColorTextureId;
  let normalTextureId = materialData.normalTextureId;
  let ormTextureId = materialData.ormTextureId;
  let emissiveTextureId = materialData.emissiveTextureId;
  let metallicFactor = materialData.metallicFactor;
  let roughnessFactor = materialData.roughnessFactor;
  let emissiveFactor = materialData.emissiveFactor;
  let baseColor = materialData.baseColor;
  let alphaMode = materialData.alphaMode;
  let alphaCutoff = materialData.alphaCutoff;
  let doubleSided = materialData.doubleSided;
  let baseColorTransform = materialData.baseColorTransform ?? null;

  // Apply inline overrides on top
  if (inlineOverride) {
    if (inlineOverride.baseColorTextureId) baseColorTextureId = inlineOverride.baseColorTextureId;
    if (inlineOverride.normalTextureId) normalTextureId = inlineOverride.normalTextureId;
    if (inlineOverride.ormTextureId) ormTextureId = inlineOverride.ormTextureId;
    if (inlineOverride.emissiveTextureId) emissiveTextureId = inlineOverride.emissiveTextureId;
    if (inlineOverride.baseColor) baseColor = inlineOverride.baseColor;
    if (inlineOverride.metallicFactor !== undefined) metallicFactor = inlineOverride.metallicFactor;
    if (inlineOverride.roughnessFactor !== undefined) roughnessFactor = inlineOverride.roughnessFactor;
    if (inlineOverride.emissiveFactor) emissiveFactor = inlineOverride.emissiveFactor;
    if (inlineOverride.alphaMode !== undefined) alphaMode = inlineOverride.alphaMode;
    if (inlineOverride.alphaCutoff !== undefined) alphaCutoff = inlineOverride.alphaCutoff;
    if (inlineOverride.doubleSided !== undefined) doubleSided = inlineOverride.doubleSided;
    if (inlineOverride.baseColorTransform) baseColorTransform = inlineOverride.baseColorTransform;
  }

  // UV priority: PBR transform → legacy face → defaults
  const repeatU = baseColorTransform?.scale?.[0] ?? legacyFace?.repeatU ?? 1;
  const repeatV = baseColorTransform?.scale?.[1] ?? legacyFace?.repeatV ?? 1;
  const offsetU = baseColorTransform?.offset?.[0] ?? legacyFace?.offsetU ?? 0;
  const offsetV = baseColorTransform?.offset?.[1] ?? legacyFace?.offsetV ?? 0;
  const rotation = baseColorTransform?.rotation ?? legacyFace?.rotation ?? 0;

  // Legacy face properties that still apply to PBR
  const legacyColor = legacyFace?.color ?? [1, 1, 1, 1];
  const fullBright = legacyFace ? (legacyFace.materialFlags & FULLBRIGHT_MASK) !== 0 : false;
  const glow = legacyFace?.glow ?? 0;

  // Emissive: PBR emissiveFactor wins, then legacy glow
  const finalEmissive = emissiveFactor
    ?? (glow > 0 ? [glow, glow, glow] : [0, 0, 0]);

  // Base color texture: PBR wins, legacy as fallback
  const resolvedTexture = baseColorTextureId ?? legacyFace?.textureID ?? '';

  const result: ResolvedMaterial = {
    baseColorTexture: resolvedTexture,
    baseColorFactor: baseColor ?? legacyColor,
    emissiveFactor: finalEmissive,
    metallicFactor: metallicFactor ?? 1,
    roughnessFactor: roughnessFactor ?? 1,
    alphaMode: alphaMode ?? 0,
    alphaCutoff: alphaCutoff ?? 0.5,
    doubleSided: doubleSided ?? false,
    unshaded: fullBright,
    repeatU,
    repeatV,
    offsetU,
    offsetV,
    rotation,
  };

  if (normalTextureId) result.normalTexture = normalTextureId;
  if (ormTextureId) result.ormTexture = ormTextureId;
  if (emissiveTextureId) result.emissiveTexture = emissiveTextureId;
  if (legacyFace?.mappingType) result.mappingType = legacyFace.mappingType;

  return result;
}
