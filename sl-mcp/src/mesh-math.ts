/**
 * mesh-math.ts — Pure math and skeleton functions for GLB construction.
 * Extracted from electron-ui/src/main/assets/mesh-converter.ts to avoid
 * CJS/ESM cycle when importing from the sl-mcp (ESM) project.
 *
 * These functions are stable math utilities — they match mesh-converter.ts exactly.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkeletonJoint {
  name: string;
  parent: string | null;
  pos: [number, number, number];
  rot: [number, number, number];
  scale: [number, number, number];
  children: string[];
  isCollisionVolume: boolean;
  aliases?: string[];
}

export interface JointContext {
  nodeIdx: number;
  origMatrix: number[];
  fixupMatrix: number[];
}

// ---------------------------------------------------------------------------
// Skeleton loading
// ---------------------------------------------------------------------------

let skeletonCache: Map<string, SkeletonJoint> | null = null;
let attachmentPointCache: Map<string, string> | null = null;
let jointAliasCache: Map<string, string> | null = null;

async function findSharedFile(filename: string): Promise<string> {
  // From sl-mcp/src/, shared/ is at ../../shared/
  const candidates = [
    join(__dirname, '..', '..', 'shared', filename),
    join(__dirname, '..', '..', '..', 'shared', filename),
  ];
  for (const p of candidates) {
    try { return await readFile(p, 'utf8'); } catch { /* try next */ }
  }
  return '';
}

export function getSkeletonHierarchy(): Map<string, SkeletonJoint> {
  if (skeletonCache) return skeletonCache;
  skeletonCache = new Map();
  return skeletonCache;
}

export function getAttachmentPoints(): Map<string, string> {
  if (attachmentPointCache) return attachmentPointCache;
  attachmentPointCache = new Map();
  return attachmentPointCache;
}

export async function initSkeletonData(): Promise<void> {
  if (skeletonCache && skeletonCache.size > 0) return;

  const json = await findSharedFile('avatar_skeleton.json');
  if (!json) {
    console.warn('[mesh-math] avatar_skeleton.json not found');
    skeletonCache = new Map();
  } else {
    skeletonCache = parseSkeletonJson(json);
    console.log(`[mesh-math] Loaded skeleton: ${skeletonCache.size} joints`);
  }

  const apJson = await findSharedFile('avatar_lad_attachments.json');
  if (!apJson) {
    attachmentPointCache = new Map();
  } else {
    const obj = JSON.parse(apJson) as Record<string, string>;
    attachmentPointCache = new Map(Object.entries(obj));
    console.log(`[mesh-math] Loaded attachment points: ${attachmentPointCache.size}`);
  }

  getJointAliasMap();
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
  for (const joint of joints.values()) {
    if (joint.parent && joints.has(joint.parent)) {
      joints.get(joint.parent)!.children.push(joint.name);
    }
  }
  return joints;
}

// ---------------------------------------------------------------------------
// Joint alias resolution
// ---------------------------------------------------------------------------

export function getJointAliasMap(): Map<string, string> {
  if (jointAliasCache) return jointAliasCache;
  jointAliasCache = new Map();

  const skeleton = getSkeletonHierarchy();
  for (const joint of skeleton.values()) {
    if (joint.aliases) {
      for (const alias of joint.aliases) {
        jointAliasCache.set(alias, joint.name);
      }
    }
  }

  const attachPoints = getAttachmentPoints();
  for (const [apName, jointName] of attachPoints) {
    const underscored = apName.replace(/ /g, '_');
    if (underscored !== apName) jointAliasCache.set(underscored, jointName);
  }

  const attachLower = new Set<string>();
  for (const apName of attachPoints.keys()) {
    attachLower.add(apName.toLowerCase());
  }
  const lowerToCanonical = new Map<string, string>();
  for (const name of skeleton.keys()) {
    const lower = name.toLowerCase();
    if (!lowerToCanonical.has(lower)) lowerToCanonical.set(lower, name);
  }
  for (const [lower, canonical] of lowerToCanonical) {
    if (lower !== canonical && !jointAliasCache.has(lower) && !attachLower.has(lower)) {
      jointAliasCache.set(lower, canonical);
    }
  }
  return jointAliasCache;
}

export function resolveJointName(name: string): string {
  const skeleton = getSkeletonHierarchy();
  if (skeleton.has(name)) return name;
  const aliases = getJointAliasMap();
  if (aliases.has(name)) return aliases.get(name)!;
  const lower = name.toLowerCase();
  if (aliases.has(lower)) return aliases.get(lower)!;
  return name;
}

// ---------------------------------------------------------------------------
// Matrix math — column-major 4x4
// ---------------------------------------------------------------------------

export const DEG_TO_RAD = Math.PI / 180;

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

export function mat4Inverse(m: number[]): number[] | null {
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
  const r00 = cc * cb, r10 = sc * cb, r20 = -sb;
  const r01 = cc * sb * sa - sc * ca, r11 = sc * sb * sa + cc * ca, r21 = cb * sa;
  const r02 = cc * sb * ca + sc * sa, r12 = sc * sb * ca - cc * sa, r22 = cb * ca;
  return [
    r00 * sx, r10 * sx, r20 * sx, 0,
    r01 * sy, r11 * sy, r21 * sy, 0,
    r02 * sz, r12 * sz, r22 * sz, 0,
    tx, ty, tz, 1,
  ];
}

export function slToGltfMatrix(m: number[]): number[] {
  const afterCol = [
    m[0], m[1], m[2], m[3],
    m[8], m[9], m[10], m[11],
    -m[4], -m[5], -m[6], -m[7],
    m[12], m[13], m[14], m[15],
  ];
  const result = new Array(16);
  for (let col = 0; col < 4; col++) {
    const b = col * 4;
    result[b + 0] = afterCol[b + 0];
    result[b + 1] = afterCol[b + 2];
    result[b + 2] = -afterCol[b + 1];
    result[b + 3] = afterCol[b + 3];
  }
  return result;
}

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

export function blenderFixJoint(mat: number[]): { translationOnly: number[]; fixup: number[] } {
  const tx = mat[12], ty = mat[13], tz = mat[14];
  const translationOnly = mat4FromTranslation(tx, ty, tz);
  const invT = mat4FromTranslation(-tx, -ty, -tz);
  const fixup = mat4Mul(invT, mat);
  return { translationOnly, fixup };
}

export function applyBSM(
  px: number, py: number, pz: number, bsm: number[]
): [number, number, number] {
  return [
    bsm[0] * px + bsm[4] * py + bsm[8] * pz + bsm[12],
    bsm[1] * px + bsm[5] * py + bsm[9] * pz + bsm[13],
    bsm[2] * px + bsm[6] * py + bsm[10] * pz + bsm[14],
  ];
}

export function applyBSMNormal(
  nx: number, ny: number, nz: number, invT3x3: number[]
): [number, number, number] {
  const ox = invT3x3[0] * nx + invT3x3[1] * ny + invT3x3[2] * nz;
  const oy = invT3x3[3] * nx + invT3x3[4] * ny + invT3x3[5] * nz;
  const oz = invT3x3[6] * nx + invT3x3[7] * ny + invT3x3[8] * nz;
  return normalizeVec3(ox, oy, oz);
}

export function computeInvTranspose3x3(m: number[]): number[] {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const id = 1 / det;
  return [
    (e * i - f * h) * id, (d * i - f * g) * (-id), (d * h - e * g) * id,
    (b * i - c * h) * (-id), (a * i - c * g) * id, (a * h - b * g) * (-id),
    (b * f - c * e) * id, (a * f - c * d) * (-id), (a * e - b * d) * id,
  ];
}

export function jointMatrix(joint: SkeletonJoint): number[] {
  return composeMatrix(
    joint.scale,
    [joint.rot[0] * DEG_TO_RAD, joint.rot[1] * DEG_TO_RAD, joint.rot[2] * DEG_TO_RAD],
    joint.pos,
  );
}

/** Compose a TRS matrix from scale, quaternion (xyzw), and translation. Column-major. */
export function composeTRS(
  scale: [number, number, number],
  quat: [number, number, number, number], // x, y, z, w
  translate: [number, number, number],
): number[] {
  const [qx, qy, qz, qw] = quat;
  const [sx, sy, sz] = scale;
  const [tx, ty, tz] = translate;

  // Rotation matrix from quaternion
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;

  return [
    (1 - 2*(yy+zz)) * sx, (2*(xy+wz)) * sx,     (2*(xz-wy)) * sx,     0,
    (2*(xy-wz)) * sy,     (1 - 2*(xx+zz)) * sy,  (2*(yz+wx)) * sy,     0,
    (2*(xz+wy)) * sz,     (2*(yz-wx)) * sz,       (1 - 2*(xx+yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
