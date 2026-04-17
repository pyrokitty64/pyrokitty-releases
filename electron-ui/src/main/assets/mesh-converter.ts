/**
 * mesh-converter.ts — Converts LLMesh to GLB (binary glTF 2.0).
 * Hand-rolled GLB encoder, no npm dependencies.
 * Supports rigged meshes: emits JOINTS_0/WEIGHTS_0 + skin + skeleton nodes.
 *
 * Skeleton/skin approach matches Hippolyzer's gltftools.py:
 * - Skeleton hierarchy from avatar_skeleton.xml with scale+rotation+translation
 * - Blender compatibility: joint nodes store translation only; scale+rotation
 *   goes into a fixup matrix that gets baked into the inverse bind matrices
 * - alt_inverse_bind_matrix used for joint position overrides (translation only)
 * - Bind shape matrix baked into vertex positions and normals
 * - Coordinate conversion: SL (X,Y,Z) → glTF (X,Z,-Y) via similarity transform
 * - UV flip: [u, -v] (Hippolyzer convention)
 */

import * as fs from 'fs';
import * as path from 'path';
// Lazy-import electron app — unavailable in worker_threads context
let _app: typeof import('electron').app | null = null;
function getApp(): typeof import('electron').app {
  if (!_app) _app = require('electron').app as typeof import('electron').app;
  return _app!;
}
import type { LLMesh } from '../../../node-metaverse/lib/classes/public/LLMesh';
import type { LLSubMesh } from '../../../node-metaverse/lib/classes/public/interfaces/LLSubMesh';
import type { LLSkin } from '../../../node-metaverse/lib/classes/public/interfaces/LLSkin';

const LOD_PREFERENCE = ['high_lod', 'medium_lod', 'low_lod', 'lowest_lod'];

// --- Avatar skeleton hierarchy (from shared/avatar_skeleton.json) ---

export interface SkeletonJoint {
  name: string;
  parent: string | null;
  pos: [number, number, number];    // local position in SL coords
  rot: [number, number, number];    // local rotation in SL coords (Euler degrees)
  scale: [number, number, number];  // local scale in SL coords
  children: string[];
  isCollisionVolume: boolean;
  aliases?: string[];               // bone aliases from avatar_skeleton.xml
}

let skeletonCache: Map<string, SkeletonJoint> | null = null;
// Attachment point name → parent joint name (from avatar_lad_attachments.json)
let attachmentPointCache: Map<string, string> | null = null;
// Joint alias map: alternative name → canonical name (from XML aliases + attachment points + case fallback)
let jointAliasCache: Map<string, string> | null = null;

async function findSharedFile(filename: string): Promise<string> {
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'shared', filename)] : []),
    path.join(__dirname, '..', '..', '..', 'shared', filename),
    path.join(__dirname, '..', '..', '..', '..', 'shared', filename),
  ];
  for (const p of candidates) {
    try { return await fs.promises.readFile(p, 'utf8'); } catch { /* try next */ }
  }
  return '';
}

export function getSkeletonHierarchy(): Map<string, SkeletonJoint> {
  if (skeletonCache) return skeletonCache;
  skeletonCache = new Map();
  return skeletonCache;
}

export async function initSkeletonData(): Promise<void> {
  if (skeletonCache && skeletonCache.size > 0) return;

  const json = await findSharedFile('avatar_skeleton.json');
  if (!json) {
    console.warn('[mesh-converter] avatar_skeleton.json not found, skeleton hierarchy unavailable');
    skeletonCache = new Map();
  } else {
    skeletonCache = parseSkeletonJson(json);
    console.log(`[mesh-converter] Loaded skeleton hierarchy: ${skeletonCache.size} joints`);
  }

  const apJson = await findSharedFile('avatar_lad_attachments.json');
  if (!apJson) {
    console.warn('[mesh-converter] avatar_lad_attachments.json not found, attachment points unavailable');
    attachmentPointCache = new Map();
  } else {
    const obj = JSON.parse(apJson) as Record<string, string>;
    attachmentPointCache = new Map(Object.entries(obj));
    console.log(`[mesh-converter] Loaded attachment points: ${attachmentPointCache.size} points`);
  }

  getJointAliasMap();
}

/**
 * Build joint alias map matching Firestorm's LLAvatarAppearance::getJointAliases().
 * Maps: bone aliases (from XML) + attachment point names (from LAD) + case-insensitive
 * fallback for skeleton bones/CVs → canonical bone name.
 */
export function getJointAliasMap(): Map<string, string> {
  if (jointAliasCache) return jointAliasCache;
  jointAliasCache = new Map();

  // 1. Bone aliases from avatar_skeleton.json
  const skeleton = getSkeletonHierarchy();
  for (const joint of skeleton.values()) {
    if (joint.aliases) {
      for (const alias of joint.aliases) {
        jointAliasCache.set(alias, joint.name);
      }
    }
  }

  // 2. Attachment point underscore variants (from avatar_lad_attachments.json)
  // Firestorm only adds underscore variants of multi-word attachment names
  // (llavatarappearance.cpp:1781-1786). Single-word names like "Pelvis" and
  // "Mouth" are NOT aliases — they remain as orphan joints with their own IBMs.
  const attachPoints = getAttachmentPoints();
  for (const [apName, jointName] of attachPoints) {
    const underscored = apName.replace(/ /g, '_');
    if (underscored !== apName) jointAliasCache.set(underscored, jointName);
  }

  // 3. Case-insensitive fallback for skeleton bones/CVs
  // Skip names whose lowercase form matches an attachment point name (e.g.
  // "pelvis" from "PELVIS") — those should remain orphan joints, not alias
  // to the CV bone.
  const attachLower = new Set<string>();
  for (const apName of attachPoints.keys()) {
    attachLower.add(apName.toLowerCase());
  }
  const lowerToCanonical = new Map<string, string>();
  for (const name of skeleton.keys()) {
    const lower = name.toLowerCase();
    if (!lowerToCanonical.has(lower)) lowerToCanonical.set(lower, name);
  }
  // Only add case aliases for names not already in the alias map
  for (const [lower, canonical] of lowerToCanonical) {
    if (lower !== canonical && !jointAliasCache.has(lower) && !attachLower.has(lower)) {
      jointAliasCache.set(lower, canonical);
    }
  }

  console.log(`[mesh-converter] Built joint alias map: ${jointAliasCache.size} aliases`);
  return jointAliasCache;
}

/** Resolve a joint name through the alias map. Returns canonical name or original if unknown. */
export function resolveJointName(name: string): string {
  const skeleton = getSkeletonHierarchy();
  if (skeleton.has(name)) return name;  // exact match — no alias needed
  const aliases = getJointAliasMap();
  // Try exact alias first, then case-insensitive
  if (aliases.has(name)) return aliases.get(name)!;
  const lower = name.toLowerCase();
  if (aliases.has(lower)) return aliases.get(lower)!;
  return name;  // unknown — keep original
}

/** Get attachment point name → parent joint name mapping from avatar_lad_attachments.json */
export function getAttachmentPoints(): Map<string, string> {
  if (attachmentPointCache) return attachmentPointCache;
  attachmentPointCache = new Map();
  return attachmentPointCache;
}

export function parseSkeletonJson(jsonStr: string): Map<string, SkeletonJoint> {
  const joints = new Map<string, SkeletonJoint>();
  const entries = JSON.parse(jsonStr) as Array<{
    name: string; parent: string; pos: number[]; rot: number[];
    scale: number[]; cv: boolean; aliases?: string[];
  }>;

  for (const e of entries) {
    joints.set(e.name, {
      name: e.name,
      parent: e.parent || null,
      pos: [e.pos[0], e.pos[1], e.pos[2]],
      rot: [e.rot[0], e.rot[1], e.rot[2]],
      scale: [e.scale[0], e.scale[1], e.scale[2]],
      children: [],
      isCollisionVolume: e.cv,
      aliases: e.aliases,
    });
  }

  // Build children arrays from parent references
  for (const joint of joints.values()) {
    if (joint.parent && joints.has(joint.parent)) {
      joints.get(joint.parent)!.children.push(joint.name);
    }
  }
  return joints;
}

// =====================================================================
// Matrix math — all stored as column-major flat arrays (glTF convention)
// In column-major: index = col*4 + row
// M[row][col] = flat[col*4 + row]
// =====================================================================

export const DEG_TO_RAD = Math.PI / 180;

/** Multiply two column-major 4×4 matrices: result = A * B. */
export function mat4Mul(a: number[], b: number[]): number[] {
  const r = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      r[col * 4 + row] = sum;
    }
  }
  return r;
}

/** Invert a column-major 4×4 matrix (general, not just rigid-body). */
export function mat4Inverse(m: number[]): number[] | null {
  // Column-major: m[col*4+row]
  const m00 = m[0], m10 = m[1], m20 = m[2], m30 = m[3];
  const m01 = m[4], m11 = m[5], m21 = m[6], m31 = m[7];
  const m02 = m[8], m12 = m[9], m22 = m[10], m32 = m[11];
  const m03 = m[12], m13 = m[13], m23 = m[14], m33 = m[15];

  const b00 = m00 * m11 - m01 * m10, b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10, b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11, b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30, b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30, b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31, b11 = m22 * m33 - m23 * m32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    (m11 * b11 - m12 * b10 + m13 * b09) * id, (-m10 * b11 + m12 * b08 - m13 * b07) * id,
    (m10 * b10 - m11 * b08 + m13 * b06) * id, (-m10 * b09 + m11 * b07 - m12 * b06) * id,
    (-m01 * b11 + m02 * b10 - m03 * b09) * id, (m00 * b11 - m02 * b08 + m03 * b07) * id,
    (-m00 * b10 + m01 * b08 - m03 * b06) * id, (m00 * b09 - m01 * b07 + m02 * b06) * id,
    (m31 * b05 - m32 * b04 + m33 * b03) * id, (-m30 * b05 + m32 * b02 - m33 * b01) * id,
    (m30 * b04 - m31 * b02 + m33 * b00) * id, (-m30 * b03 + m31 * b01 - m32 * b00) * id,
    (-m21 * b05 + m22 * b04 - m23 * b03) * id, (m20 * b05 - m22 * b02 + m23 * b01) * id,
    (-m20 * b04 + m21 * b02 - m23 * b00) * id, (m20 * b03 - m21 * b01 + m22 * b00) * id,
  ];
}

export function mat4FromTranslation(tx: number, ty: number, tz: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
}

/**
 * Compose a TRS matrix from scale, Euler angles (radians, sxyz convention), and translation.
 * Result is column-major. Matches Python transformations.compose_matrix(scale, angles, translate).
 * M = T * R * S, where R = Rz(az) * Ry(ay) * Rx(ax).
 */
export function composeMatrix(
  scale: [number, number, number],
  eulerRad: [number, number, number],
  translate: [number, number, number],
): number[] {
  const [ax, ay, az] = eulerRad;
  const [sx, sy, sz] = scale;
  const [tx, ty, tz] = translate;

  const ca = Math.cos(ax), sa = Math.sin(ax);
  const cb = Math.cos(ay), sb = Math.sin(ay);
  const cc = Math.cos(az), sc = Math.sin(az);

  // R = Rz * Ry * Rx (3x3 rotation)
  const r00 = cc * cb;
  const r10 = sc * cb;
  const r20 = -sb;
  const r01 = cc * sb * sa - sc * ca;
  const r11 = sc * sb * sa + cc * ca;
  const r21 = cb * sa;
  const r02 = cc * sb * ca + sc * sa;
  const r12 = sc * sb * ca - cc * sa;
  const r22 = cb * ca;

  // TRS in column-major: col0 = S*R col0, col1 = S*R col1, col2 = S*R col2, col3 = T
  return [
    r00 * sx, r10 * sx, r20 * sx, 0,
    r01 * sy, r11 * sy, r21 * sy, 0,
    r02 * sz, r12 * sz, r22 * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * Apply coordinate change: SL → glTF via similarity transform C * M * C^(-1).
 * C maps (x,y,z) → (x,z,-y), i.e. a -90° rotation about X.
 * Works on column-major matrices.
 */
export function slToGltfMatrix(m: number[]): number[] {
  // Step 1: Right-multiply by C^(-1): swap columns 1↔2 with negation on new col 2
  const afterCol = [
    m[0], m[1], m[2], m[3],       // col 0 unchanged
    m[8], m[9], m[10], m[11],     // col 1 ← old col 2
    -m[4], -m[5], -m[6], -m[7],  // col 2 ← -old col 1
    m[12], m[13], m[14], m[15],   // col 3 unchanged
  ];
  // Step 2: Left-multiply by C: swap rows 1↔2 with negation on new row 2
  const result = new Array(16);
  for (let col = 0; col < 4; col++) {
    const b = col * 4;
    result[b + 0] = afterCol[b + 0];   // row 0 unchanged
    result[b + 1] = afterCol[b + 2];   // row 1 ← old row 2
    result[b + 2] = -afterCol[b + 1];  // row 2 ← -old row 1
    result[b + 3] = afterCol[b + 3];   // row 3 unchanged
  }
  return result;
}

/** Convert an SL vector to glTF: (x,y,z) → (x,z,-y) */
export function slToGltfVec3(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

export function vec3Dist(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function normalizeVec3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-10) return [x, y, z];
  return [x / len, y / len, z / len];
}

/**
 * Split a joint matrix into translation-only (for glTF node) and scale+rotation fixup.
 * Matches Hippolyzer's _fix_blender_joint().
 *
 * Blender doesn't handle bone scale/rotation correctly with glTF IBMs, so we move
 * scale+rotation out of the node and bake it into the inverse bind matrices.
 */
export function blenderFixJoint(mat: number[]): { translationOnly: number[]; fixup: number[] } {
  const tx = mat[12], ty = mat[13], tz = mat[14];
  const translationOnly = mat4FromTranslation(tx, ty, tz);
  const invT = mat4FromTranslation(-tx, -ty, -tz);
  const fixup = mat4Mul(invT, mat);
  return { translationOnly, fixup };
}

/**
 * Apply BSM to vertex position (column-vector convention: v' = BSM * v).
 * BSM is column-major from node-metaverse (.all()).
 */
export function applyBSM(
  px: number, py: number, pz: number, bsm: number[]
): [number, number, number] {
  return [
    bsm[0] * px + bsm[4] * py + bsm[8] * pz + bsm[12],
    bsm[1] * px + bsm[5] * py + bsm[9] * pz + bsm[13],
    bsm[2] * px + bsm[6] * py + bsm[10] * pz + bsm[14],
  ];
}

/**
 * Transform a normal by the inverse-transpose of the upper 3x3 of BSM.
 * For correct normal transformation under non-uniform scale.
 * invT3x3 is row-major 3x3 (9 floats) from computeInvTranspose3x3.
 */
export function applyBSMNormal(
  nx: number, ny: number, nz: number, invT3x3: number[]
): [number, number, number] {
  const ox = invT3x3[0] * nx + invT3x3[1] * ny + invT3x3[2] * nz;
  const oy = invT3x3[3] * nx + invT3x3[4] * ny + invT3x3[5] * nz;
  const oz = invT3x3[6] * nx + invT3x3[7] * ny + invT3x3[8] * nz;
  return normalizeVec3(ox, oy, oz);
}

/**
 * Compute the inverse-transpose of the upper 3x3 of a column-major 4x4 matrix.
 * Returns row-major 3x3 (9 floats) for applyBSMNormal.
 */
export function computeInvTranspose3x3(m: number[]): number[] {
  // Extract upper 3x3 from column-major (row, col)
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];

  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const id = 1 / det;

  // inverse-transpose = cofactor matrix / det
  return [
    (e * i - f * h) * id, (d * i - f * g) * (-id), (d * h - e * g) * id,
    (b * i - c * h) * (-id), (a * i - c * g) * id, (a * h - b * g) * (-id),
    (b * f - c * e) * id, (a * f - c * d) * (-id), (a * e - b * d) * id,
  ];
}

/**
 * Compute joint's local TRS matrix in SL space (column-major).
 * Matches Hippolyzer's JointNode.matrix property:
 *   compose_matrix(scale=scale, angles=rotation/RAD_TO_DEG, translate=translation)
 */
export function jointMatrix(joint: SkeletonJoint): number[] {
  return composeMatrix(
    joint.scale,
    [joint.rot[0] * DEG_TO_RAD, joint.rot[1] * DEG_TO_RAD, joint.rot[2] * DEG_TO_RAD],
    joint.pos,
  );
}

// --- Blender-compat joint context ---

export interface JointContext {
  nodeIdx: number;
  /** Original joint matrix in SL space (column-major) */
  origMatrix: number[];
  /** Fixup matrix (scale+rotation) to bake into IBMs (SL space, column-major) */
  fixupMatrix: number[];
}

// --- Cache / meta functions ---

let _cacheDir: string | null = null;
const _meshCacheSet = new Set<string>();
/** Inject cache directory (for worker threads where app.getPath is unavailable). */
export function setCacheDir(dir: string): void { _cacheDir = dir; }
function getCacheDir(): string {
  return _cacheDir ?? path.join(getApp().getPath('userData'), 'asset-cache', 'meshes');
}

export function meshCachePath(meshUuid: string): string {
  return path.join(getCacheDir(), `${meshUuid}.glb`);
}

export function isMeshCached(meshUuid: string): boolean {
  return _meshCacheSet.has(meshUuid);
}

function metaPath(meshUuid: string): string {
  return path.join(getCacheDir(), `${meshUuid}.meta`);
}

/** Read persisted rigged/jointNames info for a cached mesh.
 *  Falls back to scanning the GLB JSON chunk for "skins" if no .meta file exists. */
export async function readMeshMeta(meshUuid: string): Promise<{ isRigged: boolean; jointNames?: string[]; jointOverrides?: string[] } | undefined> {
  // Fast path: .meta sidecar exists
  try {
    const raw = await fs.promises.readFile(metaPath(meshUuid), 'utf8');
    const data = JSON.parse(raw);
    _meshCacheSet.add(meshUuid);
    return { isRigged: !!data.isRigged, jointNames: data.jointNames, jointOverrides: data.jointOverrides };
  } catch { /* no meta file — fall through to GLB scan */ }

  // Fallback: scan GLB JSON chunk for "skins" (handles meshes cached before meta was added)
  try {
    const glbPath = meshCachePath(meshUuid);
    const fh = await fs.promises.open(glbPath, 'r');
    try {
      // GLB header: 12 bytes (magic + version + length)
      // Chunk 0 header: 4 bytes length + 4 bytes type
      const header = Buffer.alloc(20);
      await fh.read(header, 0, 20, 0);
      const jsonLen = header.readUInt32LE(12);
      // Read just enough of the JSON chunk to detect "skins"
      const readLen = Math.min(jsonLen, 8192);
      const jsonBuf = Buffer.alloc(readLen);
      await fh.read(jsonBuf, 0, readLen, 20);
      const jsonStr = jsonBuf.toString('utf8');
      const isRigged = jsonStr.includes('"skins"');
      // Persist for next time
      if (isRigged) {
        try { await fs.promises.writeFile(metaPath(meshUuid), JSON.stringify({ isRigged })); } catch { /* ignore */ }
      }
      _meshCacheSet.add(meshUuid);
      return { isRigged };
    } finally {
      await fh.close();
    }
  } catch { return undefined; }
}

export interface MeshConvertResult {
  cachePath: string;
  isRigged: boolean;
  jointNames?: string[];
  jointOverrides?: string[];
}

/** Compute which joints have alt IBM overrides (custom skeleton positions). */
function getJointOverrides(skin: LLSkin | undefined): string[] | undefined {
  if (!skin || !skin.altInverseBindMatrix || skin.altInverseBindMatrix.length === 0) return undefined;
  const skeleton = getSkeletonHierarchy();
  const overrides: string[] = [];
  for (let i = 0; i < skin.jointNames.length; i++) {
    if (i >= skin.altInverseBindMatrix.length) break;
    if (skeleton.has(skin.jointNames[i])) {
      overrides.push(skin.jointNames[i]);
    }
  }
  return overrides.length > 0 ? overrides : undefined;
}

function buildMeshMeta(mesh: LLMesh): { isRigged: boolean; jointNames?: string[]; jointOverrides?: string[] } {
  const isRigged = !!(mesh.skin && mesh.skin.jointNames.length > 0);
  return {
    isRigged,
    jointNames: mesh.skin?.jointNames,
    jointOverrides: getJointOverrides(mesh.skin),
  };
}

export async function ensureMeshCached(meshUuid: string, mesh: LLMesh): Promise<MeshConvertResult> {
  const cachePath = meshCachePath(meshUuid);
  const meta = buildMeshMeta(mesh);

  const exists = await fs.promises.access(cachePath).then(() => true, () => false);
  if (exists) {
    _meshCacheSet.add(meshUuid);
    // Persist meta if missing
    const metaExists = await fs.promises.access(metaPath(meshUuid)).then(() => true, () => false);
    if (!metaExists && meta.isRigged) {
      try { await fs.promises.writeFile(metaPath(meshUuid), JSON.stringify(meta)); } catch { /* ignore */ }
    }
    return { cachePath, ...meta };
  }

  const glb = llMeshToGlb(mesh);
  if (!glb) throw new Error(`Failed to convert mesh ${meshUuid} to GLB`);

  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.promises.writeFile(cachePath, glb);
  _meshCacheSet.add(meshUuid);

  if (meta.isRigged) {
    try { await fs.promises.writeFile(metaPath(meshUuid), JSON.stringify(meta)); } catch { /* ignore */ }
  }
  return { cachePath, ...meta };
}

// =====================================================================
// Main GLB conversion — matches Hippolyzer's gltftools.py approach
// =====================================================================

export function llMeshToGlb(mesh: LLMesh): Buffer | null {
  // Pick best available LOD
  let submeshes: LLSubMesh[] | undefined;
  for (const lod of LOD_PREFERENCE) {
    const level = mesh.lodLevels[lod];
    if (level && level.length > 0) {
      submeshes = level;
      break;
    }
  }
  if (!submeshes || submeshes.length === 0) return null;

  const skin = mesh.skin;
  const isRigged = !!(skin && skin.jointNames.length > 0 &&
    submeshes.some(s => s.weights && s.weights.length > 0));

  // --- BSM extraction (column-major from node-metaverse) ---
  const bsmColMaj: number[] | null = (isRigged && skin?.bindShapeMatrix)
    ? skin.bindShapeMatrix.all() : null;
  const bsmIsIdentity = !bsmColMaj || bsmColMaj.every(
    (v: number, i: number) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6
  );

  // Precompute BSM inverse-transpose for normals
  let bsmInvT3x3: number[] | null = null;
  if (bsmColMaj && !bsmIsIdentity) {
    bsmInvT3x3 = computeInvTranspose3x3(bsmColMaj);
  }

  // === Build geometry ===
  const bufferParts: Buffer[] = [];
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  const primitives: any[] = [];
  let byteOffset = 0;

  for (const sub of submeshes) {
    if (sub.noGeometry || !sub.position || sub.position.length === 0 ||
      !sub.triangleList || sub.triangleList.length === 0) continue;

    const vertCount = sub.position.length;
    const idxCount = sub.triangleList.length;
    const hasNormals = sub.normal && sub.normal.length === vertCount;
    const hasUVs = sub.texCoord0 && sub.texCoord0.length === vertCount;
    const attributes: Record<string, number> = {};

    // --- Positions: bake BSM (SL space) then coord swap to glTF ---
    const posBuf = Buffer.alloc(vertCount * 12);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertCount; i++) {
      const p = sub.position[i];
      let sx = p.x, sy = p.y, sz = p.z;
      if (bsmColMaj && !bsmIsIdentity) {
        [sx, sy, sz] = applyBSM(p.x, p.y, p.z, bsmColMaj);
      }
      const [gx, gy, gz] = slToGltfVec3(sx, sy, sz);
      posBuf.writeFloatLE(gx, i * 12);
      posBuf.writeFloatLE(gy, i * 12 + 4);
      posBuf.writeFloatLE(gz, i * 12 + 8);
      if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
      if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
      if (gz < minZ) minZ = gz; if (gz > maxZ) maxZ = gz;
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: posBuf.length });
    accessors.push({
      bufferView: bufferViews.length - 1, componentType: 5126,
      count: vertCount, type: 'VEC3',
      min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
    });
    attributes['POSITION'] = accessors.length - 1;
    bufferParts.push(posBuf);
    byteOffset += posBuf.length;

    // --- Normals: BSM inverse-transpose then coord swap ---
    if (hasNormals) {
      const nrmBuf = Buffer.alloc(vertCount * 12);
      for (let i = 0; i < vertCount; i++) {
        const n = sub.normal![i];
        let nx = n.x, ny = n.y, nz = n.z;
        if (bsmInvT3x3) {
          [nx, ny, nz] = applyBSMNormal(n.x, n.y, n.z, bsmInvT3x3);
        }
        const [gx, gy, gz] = slToGltfVec3(nx, ny, nz);
        nrmBuf.writeFloatLE(gx, i * 12);
        nrmBuf.writeFloatLE(gy, i * 12 + 4);
        nrmBuf.writeFloatLE(gz, i * 12 + 8);
      }
      bufferViews.push({ buffer: 0, byteOffset, byteLength: nrmBuf.length });
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: vertCount, type: 'VEC3' });
      attributes['NORMAL'] = accessors.length - 1;
      bufferParts.push(nrmBuf);
      byteOffset += nrmBuf.length;
    }

    // --- UVs: [u, 1-v] — convert SL (V=0 bottom) to glTF/Godot (V=0 top) ---
    if (hasUVs) {
      const uvBuf = Buffer.alloc(vertCount * 8);
      for (let i = 0; i < vertCount; i++) {
        const uv = sub.texCoord0![i];
        uvBuf.writeFloatLE(uv.x, i * 8);
        uvBuf.writeFloatLE(1.0 - uv.y, i * 8 + 4);
      }
      bufferViews.push({ buffer: 0, byteOffset, byteLength: uvBuf.length });
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: vertCount, type: 'VEC2' });
      attributes['TEXCOORD_0'] = accessors.length - 1;
      bufferParts.push(uvBuf);
      byteOffset += uvBuf.length;
    }

    // --- Joints & Weights (inline with geometry, Hippolyzer ordering) ---
    if (isRigged && sub.weights && sub.weights.length === vertCount) {
      const jointsBuf = Buffer.alloc(vertCount * 4);
      const weightsBuf = Buffer.alloc(vertCount * 16);
      for (let v = 0; v < vertCount; v++) {
        const w = sub.weights![v];
        const entries = Object.entries(w);
        // Re-normalize weights (Hippolyzer does this for quantization error correction)
        let totalRaw = 0;
        for (const [, raw] of entries) totalRaw += raw as number;
        for (let slot = 0; slot < 4; slot++) {
          if (slot < entries.length) {
            const [ji, raw] = entries[slot];
            jointsBuf.writeUInt8(Math.min(parseInt(ji, 10), 255), v * 4 + slot);
            weightsBuf.writeFloatLE(totalRaw > 0 ? (raw as number) / totalRaw : 0, v * 16 + slot * 4);
          } else {
            jointsBuf.writeUInt8(0, v * 4 + slot);
            weightsBuf.writeFloatLE(0, v * 16 + slot * 4);
          }
        }
      }
      bufferViews.push({ buffer: 0, byteOffset, byteLength: jointsBuf.length });
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5121, count: vertCount, type: 'VEC4' });
      attributes['JOINTS_0'] = accessors.length - 1;
      bufferParts.push(jointsBuf);
      byteOffset += jointsBuf.length;

      bufferViews.push({ buffer: 0, byteOffset, byteLength: weightsBuf.length });
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: vertCount, type: 'VEC4' });
      attributes['WEIGHTS_0'] = accessors.length - 1;
      bufferParts.push(weightsBuf);
      byteOffset += weightsBuf.length;
    }

    // --- Indices ---
    const useUint32 = vertCount > 65535;
    const idxByteSize = useUint32 ? 4 : 2;
    const idxBuf = Buffer.alloc(idxCount * idxByteSize);
    for (let i = 0; i < idxCount; i++) {
      if (useUint32) idxBuf.writeUInt32LE(sub.triangleList[i], i * 4);
      else idxBuf.writeUInt16LE(sub.triangleList[i], i * 2);
    }
    const idxPadding = (4 - (idxBuf.length % 4)) % 4;
    const idxAligned = idxPadding > 0 ? Buffer.concat([idxBuf, Buffer.alloc(idxPadding)]) : idxBuf;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: idxBuf.length });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: useUint32 ? 5125 : 5123,
      count: idxCount, type: 'SCALAR',
    });

    primitives.push({ attributes, indices: accessors.length - 1, mode: 4 });
    bufferParts.push(idxAligned);
    byteOffset += idxAligned.length;
  }

  if (primitives.length === 0) return null;

  // === Build skeleton & skin (Hippolyzer approach) ===
  // node 0 = mesh, node 1 = Armature (if rigged)
  const nodes: any[] = [{ mesh: 0 }];
  const sceneNodes = [0];
  let skinObj: any = undefined;

  if (isRigged) {
    const skeleton = getSkeletonHierarchy();
    const attachPoints = getAttachmentPoints();

    // Resolve joint aliases
    const rawJointNames = skin!.jointNames;
    const resolvedSet = new Set<string>();
    const resolvedJointNames = rawJointNames.map((name) => {
      const resolved = resolveJointName(name);
      if (resolved !== name && (rawJointNames.includes(resolved) || resolvedSet.has(resolved))) {
        resolvedSet.add(name);
        return name;
      }
      resolvedSet.add(resolved);
      return resolved;
    });

    // Armature node (scene root for skeleton)
    const armatureIdx = 1;
    nodes.push({ name: 'Armature', children: [] as number[] });
    sceneNodes.push(armatureIdx);

    // --- alt_inverse_bind_matrix overrides ---
    const jointOverrides = new Map<string, number[]>();
    if (skin!.altInverseBindMatrix && skin!.altInverseBindMatrix.length > 0) {
      for (let i = 0; i < resolvedJointNames.length; i++) {
        if (i < skin!.altInverseBindMatrix.length) {
          jointOverrides.set(resolvedJointNames[i], skin!.altInverseBindMatrix[i].all());
        }
      }
    }

    // --- Collect required joints (skin joints + ancestors to root) ---
    const requiredJoints = new Set<string>();
    for (const jname of resolvedJointNames) {
      let current: string | null = jname;
      while (current) {
        requiredJoints.add(current);
        const sj = skeleton.get(current);
        current = sj?.parent ?? null;
      }
      // If this is an attachment point, also include its parent bone chain
      if (!skeleton.has(jname) && attachPoints.has(jname)) {
        let cur: string | null = attachPoints.get(jname)!;
        while (cur) {
          requiredJoints.add(cur);
          const sj = skeleton.get(cur);
          cur = sj?.parent ?? null;
        }
      }
    }

    // --- Build raw IBM lookup for CV fixup ---
    // CV bones may have different scale/rotation than XML defaults.  The raw IBMs
    // encode the content creator's actual bind-pose transforms.  For CVs without
    // alt IBM overrides we derive the local transform from the raw IBM so the
    // blenderFixJoint fixup exactly cancels the IBM's rotation/scale.
    const rawIBMByName = new Map<string, number[]>();
    for (let i = 0; i < resolvedJointNames.length; i++) {
      if (i < skin!.inverseBindMatrix.length) {
        rawIBMByName.set(resolvedJointNames[i], skin!.inverseBindMatrix[i].all());
      }
    }

    // Helper: world position of a bone via translation-only parent chain (SL space).
    // Standard bones have identity rotation & unit scale so world = sum of positions.
    const worldPosCache = new Map<string, [number, number, number]>();
    const getWorldPos = (name: string): [number, number, number] => {
      const cached = worldPosCache.get(name);
      if (cached) return cached;
      const sj = skeleton.get(name);
      if (!sj) return [0, 0, 0];
      if (!sj.parent) {
        worldPosCache.set(name, sj.pos);
        return sj.pos;
      }
      const pw = getWorldPos(sj.parent);
      const wp: [number, number, number] = [pw[0] + sj.pos[0], pw[1] + sj.pos[1], pw[2] + sj.pos[2]];
      worldPosCache.set(name, wp);
      return wp;
    };

    // --- Build joint nodes with Blender compat ---
    const jointContexts = new Map<string, JointContext>();
    const jointNodeIdxMap = new Map<string, number>();
    const orderedJoints: string[] = [];

    const visitJoint = (name: string): void => {
      if (!requiredJoints.has(name) || jointNodeIdxMap.has(name)) return;

      const skelJoint = skeleton.get(name);
      if (!skelJoint) return;

      // Visit parent first (topological order)
      if (skelJoint.parent && requiredJoints.has(skelJoint.parent)) {
        visitJoint(skelJoint.parent);
      }

      // Compute joint's local TRS matrix in SL space
      let jMat = jointMatrix(skelJoint);

      // For CV bones: the raw IBM may encode different scale/rotation than the XML
      // defaults (content creator's actual bind pose).  Derive the local transform
      // from inverse(rawIBM) so the fixup exactly cancels the IBM's rotation/scale.
      // CVs are always leaf nodes so this doesn't affect any other bone.
      // Only do this when BSM is identity — non-identity BSM taints the raw IBM
      // (inverse(rawIBM) = BSM * jointWorld, not jointWorld), producing 100x-scaled
      // node transforms that Blender renders as giant meshes.
      if (skelJoint.isCollisionVolume && !jointOverrides.has(name) && rawIBMByName.has(name) && bsmIsIdentity) {
        const rawIBM = rawIBMByName.get(name)!;
        const worldXf = mat4Inverse(rawIBM);
        if (worldXf) {
          // Parent world = sum of translations (standard bones have no rot/scale)
          const parentName = skelJoint.parent;
          const pw = parentName ? getWorldPos(parentName) : [0, 0, 0] as [number, number, number];
          const invParent = mat4FromTranslation(-pw[0], -pw[1], -pw[2]);
          jMat = mat4Mul(invParent, worldXf);
        }
      }

      // Apply alt_inverse_bind_matrix translation override (Hippolyzer approach)
      const override = jointOverrides.get(name);
      if (override) {
        // Extract translation from the override matrix (column-major: indices 12,13,14)
        const overrideTrans: [number, number, number] = [override[12], override[13], override[14]];
        // Only apply if difference > 0.1mm (Hippolyzer threshold: 0.0001)
        if (vec3Dist(overrideTrans, skelJoint.pos) > 0.0001) {
          // Recompose with the override translation but keep original scale+rotation
          jMat = composeMatrix(
            skelJoint.scale,
            [skelJoint.rot[0] * DEG_TO_RAD, skelJoint.rot[1] * DEG_TO_RAD, skelJoint.rot[2] * DEG_TO_RAD],
            overrideTrans,
          );
        }
      }

      // Blender compatibility: split into translation-only node + fixup
      const { translationOnly, fixup } = blenderFixJoint(jMat);

      // Convert translation-only matrix from SL → glTF coords
      const gltfNodeMatrix = slToGltfMatrix(translationOnly);

      const nodeIdx = nodes.length;
      nodes.push({ name, matrix: gltfNodeMatrix, children: [] as number[] });
      jointNodeIdxMap.set(name, nodeIdx);
      orderedJoints.push(name);
      jointContexts.set(name, { nodeIdx, origMatrix: jMat, fixupMatrix: fixup });

      // Visit children
      for (const childName of skelJoint.children) {
        if (requiredJoints.has(childName)) visitJoint(childName);
      }
    }

    // Build skeleton starting from mPelvis, then sweep remaining
    visitJoint('mPelvis');
    for (const jname of requiredJoints) visitJoint(jname);

    // Handle orphaned joints (not in skeleton XML — attachment points or unknowns).
    // Attachment point names (e.g. "Pelvis", "Mouth") are valid independent joints
    // in SL — they are NOT merged with their parent bone. Firestorm's joint map
    // keeps them as separate entries: joint_map["Pelvis"] = "Pelvis".
    // We derive their local transform from inverse(IBM) so skinning math works out.
    for (const jname of resolvedJointNames) {
      if (jointNodeIdxMap.has(jname)) continue;
      // Find parent: attachment point → its skeleton joint, else Armature
      const attachParent = attachPoints.get(jname);
      const parentNodeIdx = (attachParent && jointNodeIdxMap.has(attachParent))
        ? jointNodeIdxMap.get(attachParent)! : armatureIdx;

      // Derive local transform from the raw IBM for this joint.
      // The IBM encodes where the content creator placed this joint in world space:
      //   jointWorld = inverse(IBM)
      //   localTransform = inverse(parentWorld) * jointWorld
      const jointIdx = resolvedJointNames.indexOf(jname);
      const rawIBM = (jointIdx >= 0 && jointIdx < skin!.inverseBindMatrix.length)
        ? skin!.inverseBindMatrix[jointIdx].all() : null;
      let jMat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      if (rawIBM) {
        const worldXf = mat4Inverse(rawIBM);
        if (worldXf) {
          // Get parent world position in SL space
          const parentBone = attachParent || null;
          const pw = parentBone ? getWorldPos(parentBone) : [0, 0, 0] as [number, number, number];
          const invParent = mat4FromTranslation(-pw[0], -pw[1], -pw[2]);
          jMat = mat4Mul(invParent, worldXf);
        }
      }

      // Blender compat: split into translation-only node + fixup (same as skeleton joints)
      const { translationOnly, fixup } = blenderFixJoint(jMat);
      const gltfNodeMatrix = slToGltfMatrix(translationOnly);

      const nodeIdx = nodes.length;
      nodes.push({ name: jname, matrix: gltfNodeMatrix, children: [] as number[] });
      jointNodeIdxMap.set(jname, nodeIdx);
      orderedJoints.push(jname);
      jointContexts.set(jname, {
        nodeIdx,
        origMatrix: jMat,
        fixupMatrix: fixup,
      });

      // Wire orphan to parent
      (nodes[parentNodeIdx].children as number[]).push(nodeIdx);
    }

    // Wire parent-child relationships for skeleton joints
    for (const jname of orderedJoints) {
      const skelJoint = skeleton.get(jname);
      if (!skelJoint) continue; // orphans already wired above
      const parentName = skelJoint.parent;
      const nodeIdx = jointNodeIdxMap.get(jname)!;

      if (!parentName || !jointNodeIdxMap.has(parentName)) {
        // Root joint → child of Armature
        (nodes[armatureIdx].children as number[]).push(nodeIdx);
      } else {
        const parentIdx = jointNodeIdxMap.get(parentName)!;
        (nodes[parentIdx].children as number[]).push(nodeIdx);
      }
    }

    // --- Build IBMs: fixup @ raw_IBM, then coordinate convert ---
    const skinJointIndices: number[] = [];
    const glbIBMs: number[][] = [];

    for (let i = 0; i < resolvedJointNames.length; i++) {
      const jname = resolvedJointNames[i];
      const ctx = jointContexts.get(jname);
      const rawIBM = skin!.inverseBindMatrix[i].all(); // column-major (LLSD order)

      let ibm: number[];
      if (ctx) {
        // fixup @ IBM (both in SL column-major space)
        ibm = mat4Mul(ctx.fixupMatrix, rawIBM);
      } else {
        ibm = rawIBM;
      }

      // Convert from SL to glTF coordinate system
      glbIBMs.push(slToGltfMatrix(ibm));

      const nodeIdx = jointNodeIdxMap.get(jname);
      skinJointIndices.push(nodeIdx ?? armatureIdx);
    }

    // Write IBMs to buffer
    const ibmBuf = Buffer.alloc(resolvedJointNames.length * 64);
    for (let i = 0; i < resolvedJointNames.length; i++) {
      for (let j = 0; j < 16; j++) {
        ibmBuf.writeFloatLE(glbIBMs[i][j], (i * 16 + j) * 4);
      }
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: ibmBuf.length });
    const ibmAccessorIdx = accessors.length;
    accessors.push({
      bufferView: bufferViews.length - 1, componentType: 5126,
      count: resolvedJointNames.length, type: 'MAT4',
    });
    bufferParts.push(ibmBuf);
    byteOffset += ibmBuf.length;

    // Mesh node: skin assigned (Hippolyzer: mesh_node.matrix = None)
    nodes[0].skin = 0;

    // Tag mesh node with joints that have alt IBM overrides (for Godot pipeline).
    // In SL, every joint with an alt_inverse_bind_matrix gets an override —
    // the mesh's position is authoritative regardless of distance from XML default.
    // The Godot side filters out near-default overrides (aboveJointPosThreshold).
    const overriddenJointNames: string[] = [];
    if (skin!.altInverseBindMatrix && skin!.altInverseBindMatrix.length > 0) {
      for (let i = 0; i < resolvedJointNames.length; i++) {
        if (i >= skin!.altInverseBindMatrix.length) break;
        const jname = resolvedJointNames[i];
        const skelJoint = skeleton.get(jname);
        if (!skelJoint) continue;
        overriddenJointNames.push(jname);
      }
    }
    if (overriddenJointNames.length > 0) {
      nodes[0].extras = { jointOverrides: overriddenJointNames };
    }

    // Skin object
    skinObj = {
      name: 'Armature',
      inverseBindMatrices: ibmAccessorIdx,
      joints: skinJointIndices,
      skeleton: armatureIdx,
    };
  }

  // Build glTF JSON
  const gltf: any = {
    asset: { version: '2.0', generator: 'PyroKitty' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes: nodes.map(n => {
      const out: any = {};
      if (n.name) out.name = n.name;
      if (n.mesh !== undefined) out.mesh = n.mesh;
      if (n.skin !== undefined) out.skin = n.skin;
      if (n.matrix) out.matrix = n.matrix;
      if (n.extras) out.extras = n.extras;
      if (n.children && n.children.length > 0) out.children = n.children;
      return out;
    }),
    meshes: [{ primitives }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };

  if (skinObj) {
    gltf.skins = [skinObj];
  }

  // Encode JSON chunk (pad to 4 bytes with spaces)
  const jsonStr = JSON.stringify(gltf);
  const jsonPad = (4 - (jsonStr.length % 4)) % 4;
  const jsonBuf = Buffer.from(jsonStr + ' '.repeat(jsonPad), 'utf8');

  // Binary chunk
  const binBuf = Buffer.concat(bufferParts);
  const binPad = (4 - (binBuf.length % 4)) % 4;
  const binAligned = binPad > 0 ? Buffer.concat([binBuf, Buffer.alloc(binPad)]) : binBuf;

  // Assemble GLB: header(12) + JSON chunk(8+data) + BIN chunk(8+data)
  const totalLength = 12 + 8 + jsonBuf.length + 8 + binAligned.length;
  const glb = Buffer.alloc(totalLength);
  let off = 0;

  // GLB header
  glb.writeUInt32LE(0x46546C67, off); off += 4; // magic "glTF"
  glb.writeUInt32LE(2, off); off += 4;           // version
  glb.writeUInt32LE(totalLength, off); off += 4;

  // JSON chunk
  glb.writeUInt32LE(jsonBuf.length, off); off += 4;
  glb.writeUInt32LE(0x4E4F534A, off); off += 4;   // "JSON"
  jsonBuf.copy(glb, off); off += jsonBuf.length;

  // BIN chunk
  glb.writeUInt32LE(binAligned.length, off); off += 4;
  glb.writeUInt32LE(0x004E4942, off); off += 4;   // "BIN\0"
  binAligned.copy(glb, off);

  return glb;
}
