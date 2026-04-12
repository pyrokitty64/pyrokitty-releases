/**
 * avatar-shape.ts — Compute skeleton bone deltas from SL VisualParam bytes.
 * Copied from electron-ui/src/main/avatar/avatar-shape.ts with ESM path fixes.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type Vec3 = [number, number, number];

interface BoneEntry { name: string; scale: Vec3; offset: Vec3; }
interface VolumeMorphEntry { name: string; scale?: Vec3; pos?: Vec3; }
interface DrivenParam {
  id: number; valueMin: number; valueMax: number;
  bones?: BoneEntry[]; volumeMorphs?: VolumeMorphEntry[];
  sex?: 'male' | 'female';
  min1?: number; max1?: number; max2?: number; min2?: number;
}
interface SkeletonParam {
  byteIndex: number; id: number; valueMin: number; valueMax: number;
  sex?: 'male' | 'female'; bones?: BoneEntry[];
  volumeMorphs?: VolumeMorphEntry[]; drivenParams?: DrivenParam[];
}

export interface BoneDelta { scale: Vec3; offset: Vec3; }
export interface VolumeDelta { scale: Vec3; offset: Vec3; }
export interface ShapeResult {
  bones: Record<string, BoneDelta>;
  volumeMorphs: Record<string, VolumeDelta>;
  hoverHeight: number;
}

let skeletonParams: SkeletonParam[] | null = null;

function ensureLoaded(): void {
  if (skeletonParams) return;
  const candidates = [
    join(__dirname, '..', '..', 'shared', 'avatar_lad_skeleton.json'),
    join(__dirname, '..', '..', '..', 'shared', 'avatar_lad_skeleton.json'),
  ];
  for (const p of candidates) {
    try {
      skeletonParams = JSON.parse(readFileSync(p, 'utf8'));
      return;
    } catch { /* try next */ }
  }
  throw new Error('avatar_lad_skeleton.json not found');
}

function getDrivenWeight(inputWeight: number, driver: SkeletonParam, driven: DrivenParam): number {
  const min1 = driven.min1 ?? driver.valueMin;
  const max1 = driven.max1 ?? driver.valueMax;
  const max2 = driven.max2 ?? driver.valueMax;
  const min2 = driven.min2 ?? driver.valueMax;
  const drivenMin = driven.valueMin, drivenMax = driven.valueMax;
  if (min1 === max1 && max1 === max2 && max2 === min2) return inputWeight <= min1 ? drivenMax : drivenMin;
  if (inputWeight <= min1) return drivenMin;
  if (inputWeight < max1) return drivenMin + ((inputWeight - min1) / (max1 - min1)) * (drivenMax - drivenMin);
  if (inputWeight <= max2) return drivenMax;
  if (inputWeight < min2) return drivenMax + ((inputWeight - max2) / (min2 - max2)) * (drivenMin - drivenMax);
  return drivenMin;
}

function determineAvatarSex(bytes: number[]): 'male' | 'female' {
  const byte = bytes[31];
  return (byte !== undefined && byte / 255.0 > 0.5) ? 'male' : 'female';
}

export function computeShapeDeltas(visualParamBytes: number[]): ShapeResult {
  ensureLoaded();
  const params = skeletonParams!;
  const avatarSex = determineAvatarSex(visualParamBytes);

  const accScale: Record<string, Vec3> = {};
  const accOffset: Record<string, Vec3> = {};
  const vmScale: Record<string, Vec3> = {};
  const vmOffset: Record<string, Vec3> = {};

  function accBones(bones: BoneEntry[] | undefined, weight: number): void {
    if (!bones) return;
    for (const b of bones) {
      if (!accScale[b.name]) { accScale[b.name] = [0, 0, 0]; accOffset[b.name] = [0, 0, 0]; }
      accScale[b.name][0] += weight * b.scale[0];
      accScale[b.name][1] += weight * b.scale[1];
      accScale[b.name][2] += weight * b.scale[2];
      accOffset[b.name][0] += weight * b.offset[0];
      accOffset[b.name][1] += weight * b.offset[1];
      accOffset[b.name][2] += weight * b.offset[2];
    }
  }
  function accVM(morphs: VolumeMorphEntry[] | undefined, weight: number): void {
    if (!morphs) return;
    for (const vm of morphs) {
      if (!vmScale[vm.name]) { vmScale[vm.name] = [0, 0, 0]; vmOffset[vm.name] = [0, 0, 0]; }
      if (vm.scale) { vmScale[vm.name][0] += weight * vm.scale[0]; vmScale[vm.name][1] += weight * vm.scale[1]; vmScale[vm.name][2] += weight * vm.scale[2]; }
      if (vm.pos) { vmOffset[vm.name][0] += weight * vm.pos[0]; vmOffset[vm.name][1] += weight * vm.pos[1]; vmOffset[vm.name][2] += weight * vm.pos[2]; }
    }
  }

  for (const param of params) {
    const byte = visualParamBytes[param.byteIndex];
    if (byte === undefined) continue;
    const rawWeight = (byte / 255.0) * (param.valueMax - param.valueMin) + param.valueMin;
    const weight = (param.sex && param.sex !== avatarSex) ? 0 : rawWeight;
    accBones(param.bones, weight);
    accVM(param.volumeMorphs, weight);
    if (param.drivenParams) {
      for (const driven of param.drivenParams) {
        let dw = getDrivenWeight(weight, param, driven);
        if (driven.sex && driven.sex !== avatarSex) dw = 0;
        accBones(driven.bones, dw);
        accVM(driven.volumeMorphs, dw);
      }
    }
  }

  const bones: Record<string, BoneDelta> = {};
  for (const name of Object.keys({ ...accScale, ...accOffset })) {
    const s = accScale[name] || [0, 0, 0];
    const o = accOffset[name] || [0, 0, 0];
    bones[name] = { scale: [1 + s[0], 1 + s[1], 1 + s[2]], offset: [o[0], o[1], o[2]] };
  }
  const volumeMorphs: Record<string, VolumeDelta> = {};
  for (const name of Object.keys({ ...vmScale, ...vmOffset })) {
    volumeMorphs[name] = { scale: vmScale[name] || [0, 0, 0], offset: vmOffset[name] || [0, 0, 0] };
  }

  const HOVER_BYTE = 252, HOVER_MIN = -2.0, HOVER_MAX = 2.0;
  let hoverHeight = 0;
  if (visualParamBytes.length > HOVER_BYTE) {
    hoverHeight = (visualParamBytes[HOVER_BYTE] / 255.0) * (HOVER_MAX - HOVER_MIN) + HOVER_MIN;
  }

  return { bones, volumeMorphs, hoverHeight };
}
