/**
 * prim-converter.ts — Procedural prim geometry generator, ported from prim_mesh_generator.gd.
 * Generates GLB from SL prim shape parameters (profile + path sweep).
 * Each prim face becomes a separate GLB primitive for per-face texturing.
 */

import { multiSurfaceToGlb, type MeshSurface } from './glb-encoder';

// ─── Constants ──────────────────────────────────────────

const PROFILE_SQUARE = 1;
const PROFILE_CIRCLE = 0;
const PROFILE_ISOTRI = 2;
const PROFILE_EQUALTRI = 3;
const PROFILE_RIGHTTRI = 4;
const PROFILE_CIRCLE_HALF = 5;
const PROFILE_MASK = 0x0f;
const HOLE_MASK = 0xf0;
const HOLE_SAME = 0x00;
const HOLE_CIRCLE = 0x10;
const HOLE_SQUARE = 0x20;
const HOLE_TRIANGLE = 0x30;
const PATH_LINE = 0x10;
const PATH_CIRCLE = 0x20;

const MIN_DETAIL_FACES = 6;
const DETAIL = 4.0;
const TAU = Math.PI * 2;

const TABLE_SCALE = [1.0, 1.0, 1.0, 0.5, 0.707107, 0.53, 0.525, 0.5];

// ─── Prim shape params ──────────────────────────────────

export interface PrimShapeParams {
  pathCurve: number;
  profileCurve: number;
  pathBegin: number;
  pathEnd: number;
  pathScaleX: number;
  pathScaleY: number;
  pathShearX: number;
  pathShearY: number;
  pathTwist: number;
  pathTwistBegin: number;
  pathRadiusOffset: number;
  pathTaperX: number;
  pathTaperY: number;
  pathRevolutions: number;
  pathSkew: number;
  profileBegin: number;
  profileEnd: number;
  profileHollow: number;
}

// ─── Internal types ─────────────────────────────────────

interface Vec3 { x: number; y: number; z: number; }
interface Vec2 { x: number; y: number; }
// 3x3 basis matrix stored column-major: [c0x, c0y, c0z, c1x, c1y, c1z, c2x, c2y, c2z]
type Basis = Float64Array;

interface ProfilePoint { x: number; y: number; t: number; } // t = texcoord

interface ProfileFace {
  index: number;
  count: number;
  faceId: number;
  isCap: boolean;
  isFlat: boolean;
}

interface ProfileResult {
  points: ProfilePoint[];
  faces: ProfileFace[];
  totalOut: number;
  isOpen: boolean;
}

interface PathPoint {
  pos: Vec3;
  rot: Basis;
  scale: Vec2;
  texT: number;
}

// ─── Math helpers ───────────────────────────────────────

function basisIdentity(): Basis {
  const b = new Float64Array(9);
  b[0] = 1; b[4] = 1; b[8] = 1;
  return b;
}

function basisFromAxisAngle(ax: number, ay: number, az: number, angle: number): Basis {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const b = new Float64Array(9);
  b[0] = t * ax * ax + c;       b[1] = t * ax * ay + s * az;  b[2] = t * ax * az - s * ay;
  b[3] = t * ax * ay - s * az;  b[4] = t * ay * ay + c;       b[5] = t * ay * az + s * ax;
  b[6] = t * ax * az + s * ay;  b[7] = t * ay * az - s * ax;  b[8] = t * az * az + c;
  return b;
}

function basisMul(a: Basis, b: Basis): Basis {
  const r = new Float64Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      r[col * 3 + row] = a[row] * b[col * 3] + a[3 + row] * b[col * 3 + 1] + a[6 + row] * b[col * 3 + 2];
    }
  }
  return r;
}

function basisTransformVec3(b: Basis, v: Vec3): Vec3 {
  return {
    x: b[0] * v.x + b[3] * v.y + b[6] * v.z,
    y: b[1] * v.x + b[4] * v.y + b[7] * v.z,
    z: b[2] * v.x + b[5] * v.y + b[8] * v.z,
  };
}

// Quaternion → Basis. Quaternion is [x, y, z, w].
function basisFromQuat(qx: number, qy: number, qz: number, qw: number): Basis {
  const b = new Float64Array(9);
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  b[0] = 1 - 2 * (yy + zz); b[1] = 2 * (xy + wz);     b[2] = 2 * (xz - wy);
  b[3] = 2 * (xy - wz);     b[4] = 1 - 2 * (xx + zz);  b[5] = 2 * (yz + wx);
  b[6] = 2 * (xz + wy);     b[7] = 2 * (yz - wx);       b[8] = 1 - 2 * (xx + yy);
  return b;
}

// Multiply two quaternions: result = a * b (Godot convention: a applied after b)
function quatMul(ax: number, ay: number, az: number, aw: number,
                 bx: number, by: number, bz: number, bw: number): [number, number, number, number] {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

// Quaternion from axis-angle
function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): [number, number, number, number] {
  const ha = angle * 0.5;
  const s = Math.sin(ha);
  return [ax * s, ay * s, az * s, Math.cos(ha)];
}

function vec3Normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function slToGltf(v: Vec3): Vec3 {
  // SL (x,y,z) → glTF/Godot (x,z,-y)
  return { x: v.x, y: v.z, z: -v.y };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ─── Profile Generation ─────────────────────────────────

function generateProfile(profileType: number, holeType: number, pBegin: number, pEnd: number,
    hollow: number, pathOpen: boolean): ProfileResult {
  const result: ProfileResult = { points: [], faces: [], totalOut: 0, isOpen: false };

  switch (profileType) {
    case PROFILE_SQUARE: {
      genNgon(result, 4, -0.375, 0.0, 1.0, pBegin, pEnd, hollow);
      if (pathOpen) addCapFace(result, true);

      const boxSideOffset = Math.floor(pBegin * 4.0);
      for (let i = boxSideOffset; i < Math.floor(pEnd * 4.0 + 0.999); i++) {
        result.faces.push({
          index: i - boxSideOffset,
          count: 2,
          faceId: 5 + i,
          isCap: false,
          isFlat: true,
        });
      }

      // Scale t (texcoord) by 4
      for (const p of result.points) p.t *= 4.0;

      if (hollow > 0) {
        addHollow(result, holeType, hollow, 4, -0.375, 1.0, pBegin, pEnd);
      }
      break;
    }

    case PROFILE_ISOTRI:
    case PROFILE_EQUALTRI:
    case PROFILE_RIGHTTRI: {
      genNgon(result, 3, 0.0, 0.0, 1.0, pBegin, pEnd, hollow);
      for (const p of result.points) p.t *= 3.0;

      if (pathOpen) addCapFace(result, true);

      const triSideOffset = Math.floor(pBegin * 3.0);
      for (let i = triSideOffset; i < Math.floor(pEnd * 3.0 + 0.999); i++) {
        result.faces.push({
          index: i - triSideOffset,
          count: 2,
          faceId: 5 + i,
          isCap: false,
          isFlat: true,
        });
      }

      if (hollow > 0) {
        addHollow(result, holeType, hollow / 2.0, 3, 0.0, 1.0, pBegin, pEnd);
      }
      break;
    }

    case PROFILE_CIRCLE: {
      let circleDetail = MIN_DETAIL_FACES * DETAIL;
      if (hollow > 0 && holeType === HOLE_SQUARE) {
        circleDetail = Math.ceil(circleDetail / 4.0) * 4.0;
      }
      const sides = Math.floor(circleDetail);
      genNgon(result, sides, 0.0, 0.0, 1.0, pBegin, pEnd, hollow);

      if (pathOpen) addCapFace(result, true);

      result.faces.push({
        index: 0,
        count: (!result.isOpen || hollow > 0) ? result.points.length : result.points.length - 1,
        faceId: 5,
        isCap: false,
        isFlat: false,
      });

      if (hollow > 0) {
        addHollowCircle(result, holeType, hollow, circleDetail, 0.0, 1.0, pBegin, pEnd);
      }
      break;
    }

    case PROFILE_CIRCLE_HALF: {
      let circleDetail = MIN_DETAIL_FACES * DETAIL * 0.5;
      if (hollow > 0 && holeType === HOLE_SQUARE) {
        circleDetail = Math.ceil(circleDetail / 2.0) * 2.0;
      }
      genNgon(result, Math.floor(circleDetail), 0.5, 0.0, 0.5, pBegin, pEnd, hollow);

      if (pathOpen) addCapFace(result, true);

      result.faces.push({
        index: 0,
        count: (!result.isOpen || hollow > 0) ? result.points.length : result.points.length - 1,
        faceId: 5,
        isCap: false,
        isFlat: false,
      });

      if (hollow > 0) {
        addHollowCircle(result, holeType, hollow, circleDetail, 0.5, 0.5, pBegin, pEnd);
      }

      // Special case for sphere openness
      if ((pEnd - pBegin) < 1.0) {
        result.isOpen = true;
      } else if (hollow <= 0) {
        result.isOpen = false;
        result.points.push({ ...result.points[0] });
      }
      break;
    }
  }

  // Path end cap and profile begin/end faces
  if (pathOpen && result.faces.length > 0) {
    addCapFace(result, false);
  }

  if (result.isOpen) {
    result.faces.push({
      index: result.points.length - 1,
      count: 2,
      faceId: 3,
      isCap: false,
      isFlat: true,
    });
  }

  if (result.isOpen) {
    const fEnd: ProfileFace = {
      index: 0,
      count: 2,
      faceId: 4,
      isCap: false,
      isFlat: true,
    };
    if (hollow > 0) {
      fEnd.index = result.totalOut > 0 ? result.totalOut - 1 : result.points.length - 1;
    } else {
      fEnd.index = result.points.length - 2;
    }
    result.faces.push(fEnd);
  }

  return result;
}


function genNgon(result: ProfileResult, sides: number, offset: number, _bevel: number,
    angScale: number, pBegin: number, pEnd: number, hollow: number): void {
  let scale = 0.5;
  const totalSides = Math.round(sides / angScale);
  if (totalSides < 8) {
    scale = TABLE_SCALE[totalSides];
  }

  const tStep = 1.0 / sides;
  const angStep = TAU * tStep * angScale;

  const tFirst = Math.floor(pBegin * sides) / sides;
  let t = tFirst;
  let ang = TAU * (t * angScale + offset);

  const pt1: ProfilePoint = { x: Math.cos(ang) * scale, y: Math.sin(ang) * scale, t };
  t += tStep;
  ang += angStep;
  const pt2: ProfilePoint = { x: Math.cos(ang) * scale, y: Math.sin(ang) * scale, t };

  const tFraction = (pBegin - tFirst) * sides;

  if (tFraction < 0.9999) {
    result.points.push({
      x: pt1.x + (pt2.x - pt1.x) * tFraction,
      y: pt1.y + (pt2.y - pt1.y) * tFraction,
      t: pt1.t + (pt2.t - pt1.t) * tFraction,
    });
  }

  while (t < pEnd) {
    result.points.push({ x: Math.cos(ang) * scale, y: Math.sin(ang) * scale, t });
    t += tStep;
    ang += angStep;
  }

  // End fraction
  const pt2End: ProfilePoint = { x: Math.cos(ang) * scale, y: Math.sin(ang) * scale, t };
  const tFractionEnd = (pEnd - (t - tStep)) * sides;
  if (tFractionEnd > 0.0001) {
    const pt1End: ProfilePoint = {
      x: Math.cos(ang - angStep) * scale,
      y: Math.sin(ang - angStep) * scale,
      t: t - tStep,
    };
    result.points.push({
      x: pt1End.x + (pt2End.x - pt1End.x) * tFractionEnd,
      y: pt1End.y + (pt2End.y - pt1End.y) * tFractionEnd,
      t: pt1End.t + (pt2End.t - pt1End.t) * tFractionEnd,
    });
  }

  if ((pEnd - pBegin) * angScale < 0.99) {
    result.isOpen = true;
    if (hollow <= 0) {
      result.points.push({ x: 0, y: 0, t: 0 }); // center point for cap fan
    }
  } else {
    result.isOpen = false;
  }
}


function addCapFace(result: ProfileResult, isBegin: boolean): void {
  result.faces.push({
    index: 0,
    count: result.points.length,
    faceId: isBegin ? 0 : 1,
    isCap: true,
    isFlat: true,
  });
}


function addHollow(result: ProfileResult, holeType: number, hollow: number,
    defaultSides: number, offset: number, angScale: number,
    pBegin: number, pEnd: number): void {
  result.totalOut = result.points.length;

  let innerSides: number;
  let isFlat = true;

  switch (holeType) {
    case HOLE_CIRCLE:
      innerSides = Math.floor(MIN_DETAIL_FACES * DETAIL);
      isFlat = false;
      break;
    case HOLE_SQUARE:
      innerSides = 4;
      break;
    case HOLE_TRIANGLE:
      innerSides = 3;
      break;
    default: // HOLE_SAME
      innerSides = defaultSides;
      break;
  }

  const inner: ProfileResult = { points: [], faces: [], totalOut: 0, isOpen: false };
  genNgon(inner, innerSides, offset, -1.0, angScale, pBegin, pEnd, hollow);

  // Scale by hollow amount and reverse
  const innerPts: ProfilePoint[] = [];
  for (const pt of inner.points) {
    innerPts.push({ x: pt.x * hollow, y: pt.y * hollow, t: pt.t });
  }
  innerPts.reverse();

  // Inner side face
  result.faces.push({
    index: result.totalOut,
    count: innerPts.length,
    faceId: 2,
    isCap: false,
    isFlat: isFlat,
  });

  result.points.push(...innerPts);

  // Update cap counts
  for (const f of result.faces) {
    if (f.isCap) f.count = result.points.length;
  }
}


function addHollowCircle(result: ProfileResult, holeType: number, hollow: number,
    circleDetail: number, offset: number, angScale: number,
    pBegin: number, pEnd: number): void {
  let innerSides: number;
  switch (holeType) {
    case HOLE_SQUARE:  innerSides = 4; break;
    case HOLE_TRIANGLE: innerSides = 3; break;
    default: innerSides = Math.floor(circleDetail); break;
  }
  addHollow(result, holeType, hollow, innerSides, offset, angScale, pBegin, pEnd);
}


// ─── Path Generation ────────────────────────────────────

function generatePath(pathCurve: number, pBegin: number, pEnd: number,
    scaleX: number, scaleY: number, shearX: number, shearY: number,
    twist: number, twistBegin: number, radiusOffset: number,
    taperX: number, taperY: number, revolutions: number, skew: number,
    profileType: number): PathPoint[] {

  let effectiveCurve = pathCurve & 0xf0;
  if (effectiveCurve === 0x80) effectiveCurve = PATH_LINE; // PATH_FLEXIBLE → PATH_LINE

  if (effectiveCurve === PATH_LINE) {
    return genLinearPath(pBegin, pEnd, scaleX, scaleY, shearX, shearY, twist, twistBegin);
  } else if (effectiveCurve === PATH_CIRCLE) {
    return genCircularPath(pBegin, pEnd, scaleX, scaleY, shearX, shearY,
      twist, twistBegin, radiusOffset, taperX, taperY, revolutions, skew);
  }
  return genLinearPath(0, 1, 1, 1, 0, 0, 0, 0);
}


function genLinearPath(pBegin: number, pEnd: number, scaleX: number, scaleY: number,
    shearX: number, shearY: number, twistVal: number, twistBeginVal: number): PathPoint[] {
  const pathPts: PathPoint[] = [];

  const beginScale: Vec2 = { x: 1, y: 1 };
  const endScale: Vec2 = { x: 1, y: 1 };
  if (scaleX > 1.0) beginScale.x = 2.0 - scaleX;
  if (scaleY > 1.0) beginScale.y = 2.0 - scaleY;
  if (scaleX < 1.0) endScale.x = scaleX;
  if (scaleY < 1.0) endScale.y = scaleY;

  let np = Math.floor(Math.abs(twistBeginVal - twistVal) * 3.5 * (DETAIL - 0.5)) + 2;
  np = Math.max(np, 2);

  const step = 1.0 / (np - 1);

  for (let i = 0; i < np; i++) {
    const t = lerp(pBegin, pEnd, i * step);
    const pp: PathPoint = {
      pos: { x: lerp(0, shearX, t), y: lerp(0, shearY, t), z: t - 0.5 },
      scale: { x: lerp(beginScale.x, endScale.x, t), y: lerp(beginScale.y, endScale.y, t) },
      texT: t,
      rot: basisFromAxisAngle(0, 0, 1, lerp(Math.PI * twistBeginVal, Math.PI * twistVal, t)),
    };
    pathPts.push(pp);
  }

  return pathPts;
}


function genCircularPath(pBegin: number, pEnd: number, scaleX: number, scaleY: number,
    shearX: number, shearY: number, twistVal: number, twistBeginVal: number,
    radiusOffset: number, taperX: number, taperY: number, revolutions: number,
    skew: number): PathPoint[] {
  const pathPts: PathPoint[] = [];

  const skewMag = Math.abs(skew);
  const holeX = scaleX * (1.0 - skewMag);
  const holeY = scaleY;

  let taperXBegin = 1.0, taperXEnd = 1.0 - taperX;
  let taperYBegin = 1.0, taperYEnd = 1.0 - taperY;

  if (taperXEnd > 1.0) { taperXBegin = 2.0 - taperXEnd; taperXEnd = 1.0; }
  if (taperYEnd > 1.0) { taperYBegin = 2.0 - taperYEnd; taperYEnd = 1.0; }

  const twistMag = Math.abs(twistBeginVal - twistVal);
  let sides = Math.floor(Math.floor(MIN_DETAIL_FACES * DETAIL + twistMag * 3.5 * (DETAIL - 0.5)) * revolutions);
  sides = Math.max(sides, 1);

  let radiusStart = 0.5;
  if (sides < 8) radiusStart = TABLE_SCALE[sides];
  radiusStart *= (1.0 - holeY);

  let radiusEnd = radiusStart;
  if (radiusOffset < 0) radiusStart *= 1.0 + radiusOffset;
  else radiusEnd *= 1.0 - radiusOffset;

  const tTwistBegin = twistBeginVal;
  const tTwistEnd = twistVal;

  const step = 1.0 / sides;

  function addPathPoint(tVal: number): void {
    const ang = TAU * revolutions * tVal;
    const c = Math.cos(ang) * lerp(radiusStart, radiusEnd, tVal);
    const s = Math.sin(ang) * lerp(radiusStart, radiusEnd, tVal);

    const pp: PathPoint = {
      pos: {
        x: lerp(0, shearX, s) + lerp(-skew, skew, tVal) * 0.5,
        y: c + lerp(0, shearY, s),
        z: s,
      },
      scale: {
        x: holeX * lerp(taperXBegin, taperXEnd, tVal),
        y: holeY * lerp(taperYBegin, taperYEnd, tVal),
      },
      texT: tVal,
      rot: basisIdentity(), // will be set below
    };

    // Twist + circle rotation (Godot quaternion: circle * twist)
    const twistQ = quatFromAxisAngle(0, 0, 1, lerp(tTwistBegin, tTwistEnd, tVal) * TAU - Math.PI);
    const circleQ = quatFromAxisAngle(1, 0, 0, ang);
    const [qx, qy, qz, qw] = quatMul(circleQ[0], circleQ[1], circleQ[2], circleQ[3],
                                        twistQ[0], twistQ[1], twistQ[2], twistQ[3]);
    pp.rot = basisFromQuat(qx, qy, qz, qw);

    pathPts.push(pp);
  }

  // Begin point
  let t = pBegin;
  addPathPoint(t);

  t += step;
  t = Math.floor(t * sides) / sides; // snap

  while (t < pEnd) {
    addPathPoint(t);
    t += step;
  }

  // End point
  addPathPoint(pEnd);

  return pathPts;
}


// ─── Face Building ──────────────────────────────────────

function buildSide(verts: Vec3[], profile: ProfileResult, pathPts: PathPoint[],
    face: ProfileFace, pathLen: number, profileLen: number): MeshSurface {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const beginS = face.index;
  const numS = face.count;
  const smooth = !face.isFlat;

  let beginStex = 0;
  if (face.isFlat && beginS < profile.points.length) {
    beginStex = Math.floor(profile.points[beginS].t);
  }

  let vertIdx = 0;

  for (let t = 0; t < pathLen - 1; t++) {
    const tt = pathPts[t].texT;
    const tt1 = pathPts[t + 1].texT;

    for (let s = 0; s < numS - 1; s++) {
      const si0 = (beginS + s) % profileLen;
      const si1 = (beginS + s + 1) % profileLen;

      const maxIdx = verts.length - 1;
      const i00 = Math.min(si0 + profileLen * t, maxIdx);
      const i10 = Math.min(si1 + profileLen * t, maxIdx);
      const i01 = Math.min(si0 + profileLen * (t + 1), maxIdx);
      const i11 = Math.min(si1 + profileLen * (t + 1), maxIdx);

      let ss0 = si0 < profile.points.length ? profile.points[si0].t : 0;
      let ss1 = si1 < profile.points.length ? profile.points[si1].t : 1;
      if (face.isFlat) { ss0 -= beginStex; ss1 -= beginStex; }

      const v00 = slToGltf(verts[i00]);
      const v10 = slToGltf(verts[i10]);
      const v01 = slToGltf(verts[i01]);
      const v11 = slToGltf(verts[i11]);

      if (smooth) {
        const n00 = sweptNormal(profile, pathPts, si0, t);
        const n10 = sweptNormal(profile, pathPts, si1, t);
        const n01 = sweptNormal(profile, pathPts, si0, t + 1);
        const n11 = sweptNormal(profile, pathPts, si1, t + 1);

        // Triangle 1
        positions.push(v00.x, v00.y, v00.z); normals.push(n00.x, n00.y, n00.z); uvs.push(ss0, 1.0 - tt);
        positions.push(v01.x, v01.y, v01.z); normals.push(n01.x, n01.y, n01.z); uvs.push(ss0, 1.0 - tt1);
        positions.push(v11.x, v11.y, v11.z); normals.push(n11.x, n11.y, n11.z); uvs.push(ss1, 1.0 - tt1);
        indices.push(vertIdx, vertIdx + 1, vertIdx + 2); vertIdx += 3;

        // Triangle 2
        positions.push(v00.x, v00.y, v00.z); normals.push(n00.x, n00.y, n00.z); uvs.push(ss0, 1.0 - tt);
        positions.push(v11.x, v11.y, v11.z); normals.push(n11.x, n11.y, n11.z); uvs.push(ss1, 1.0 - tt1);
        positions.push(v10.x, v10.y, v10.z); normals.push(n10.x, n10.y, n10.z); uvs.push(ss1, 1.0 - tt);
        indices.push(vertIdx, vertIdx + 1, vertIdx + 2); vertIdx += 3;
      } else {
        // Flat: normals will be computed after
        positions.push(v00.x, v00.y, v00.z, v01.x, v01.y, v01.z, v11.x, v11.y, v11.z);
        uvs.push(ss0, 1.0 - tt, ss0, 1.0 - tt1, ss1, 1.0 - tt1);
        normals.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
        indices.push(vertIdx, vertIdx + 1, vertIdx + 2); vertIdx += 3;

        positions.push(v00.x, v00.y, v00.z, v11.x, v11.y, v11.z, v10.x, v10.y, v10.z);
        uvs.push(ss0, 1.0 - tt, ss1, 1.0 - tt1, ss1, 1.0 - tt);
        normals.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
        indices.push(vertIdx, vertIdx + 1, vertIdx + 2); vertIdx += 3;
      }
    }
  }

  if (!smooth) computeFlatNormals(positions, normals, indices);

  return { positions, normals, uvs, indices };
}


function buildCap(verts: Vec3[], profile: ProfileResult, pathPts: PathPoint[],
    face: ProfileFace, pathLen: number, profileLen: number): MeshSurface {
  const isTop = face.faceId === 0;
  const pathIdx = isTop ? (pathLen - 1) : 0;
  const offset = profileLen * pathIdx;
  const numPts = Math.min(face.count, profile.points.length);
  const maxIdx = verts.length - 1;

  if (numPts < 3) return { positions: [], normals: [], uvs: [], indices: [] };

  const isHollow = profile.totalOut > 0 && profile.totalOut < numPts;

  if (isHollow) {
    return buildHollowCap(verts, profile, offset, numPts, isTop, maxIdx);
  } else {
    const hasCenter = profile.isOpen && numPts > 2;
    if (hasCenter) {
      return buildFanCap(verts, profile, offset, numPts, isTop, maxIdx);
    } else {
      return buildCentroidCap(verts, profile, offset, numPts, isTop, maxIdx);
    }
  }
}


function buildFanCap(verts: Vec3[], profile: ProfileResult,
    offset: number, numPts: number, isTop: boolean, maxIdx: number): MeshSurface {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const centerIdx = Math.min(offset + numPts - 1, maxIdx);
  const center = slToGltf(verts[centerIdx]);
  const centerUv = { x: 0.5, y: 0.5 };
  let vertIdx = 0;

  for (let i = 0; i < numPts - 2; i++) {
    const i0 = Math.min(offset + i, maxIdx);
    const i1 = Math.min(offset + i + 1, maxIdx);

    const v0 = slToGltf(verts[i0]);
    const v1 = slToGltf(verts[i1]);

    const p0 = i < profile.points.length ? profile.points[i] : { x: 0, y: 0, t: 0 };
    const p1 = (i + 1) < profile.points.length ? profile.points[i + 1] : { x: 0, y: 0, t: 0 };

    const uv0 = capUvFromProfile(p0, isTop);
    const uv1 = capUvFromProfile(p1, isTop);

    if (isTop) {
      positions.push(center.x, center.y, center.z, v1.x, v1.y, v1.z, v0.x, v0.y, v0.z);
      uvs.push(centerUv.x, centerUv.y, uv1.x, uv1.y, uv0.x, uv0.y);
    } else {
      positions.push(center.x, center.y, center.z, v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
      uvs.push(centerUv.x, centerUv.y, uv0.x, uv0.y, uv1.x, uv1.y);
    }
    normals.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
    indices.push(vertIdx, vertIdx + 1, vertIdx + 2); vertIdx += 3;
  }

  computeFlatNormals(positions, normals, indices);
  return { positions, normals, uvs, indices };
}


function buildCentroidCap(verts: Vec3[], profile: ProfileResult,
    offset: number, numPts: number, isTop: boolean, maxIdx: number): MeshSurface {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Compute centroid
  let cx = 0, cy = 0, cz = 0;
  let cuvx = 0, cuvy = 0;
  for (let i = 0; i < numPts; i++) {
    const idx = Math.min(offset + i, maxIdx);
    cx += verts[idx].x; cy += verts[idx].y; cz += verts[idx].z;
    if (i < profile.points.length) {
      const uv = capUvFromProfile(profile.points[i], isTop);
      cuvx += uv.x; cuvy += uv.y;
    }
  }
  const centroid = slToGltf({ x: cx / numPts, y: cy / numPts, z: cz / numPts });
  const centroidUv = { x: cuvx / numPts, y: cuvy / numPts };

  let vertIdx = 0;

  for (let i = 0; i < numPts; i++) {
    const i0 = Math.min(offset + i, maxIdx);
    const i1 = Math.min(offset + ((i + 1) % numPts), maxIdx);

    const v0 = slToGltf(verts[i0]);
    const v1 = slToGltf(verts[i1]);

    const pi0 = i % profile.points.length;
    const pi1 = (i + 1) % profile.points.length;

    const uv0 = capUvFromProfile(profile.points[pi0], isTop);
    const uv1 = capUvFromProfile(profile.points[pi1], isTop);

    if (isTop) {
      positions.push(centroid.x, centroid.y, centroid.z, v1.x, v1.y, v1.z, v0.x, v0.y, v0.z);
      uvs.push(centroidUv.x, centroidUv.y, uv1.x, uv1.y, uv0.x, uv0.y);
    } else {
      positions.push(centroid.x, centroid.y, centroid.z, v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
      uvs.push(centroidUv.x, centroidUv.y, uv0.x, uv0.y, uv1.x, uv1.y);
    }
    normals.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
    indices.push(vertIdx, vertIdx + 1, vertIdx + 2); vertIdx += 3;
  }

  computeFlatNormals(positions, normals, indices);
  return { positions, normals, uvs, indices };
}


function buildHollowCap(verts: Vec3[], profile: ProfileResult,
    offset: number, numPts: number, isTop: boolean, maxIdx: number): MeshSurface {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const outerCount = profile.totalOut;
  let pt1 = 0;
  let pt2 = numPts - 1;
  let vertIdx = 0;

  while (pt2 - pt1 > 1) {
    let useA: boolean;
    if (pt1 + 1 < outerCount && pt2 - 1 >= outerCount) {
      const p1 = pt1 < profile.points.length ? profile.points[pt1] : { x: 0, y: 0, t: 0 };
      const pa = (pt1 + 1) < profile.points.length ? profile.points[pt1 + 1] : { x: 0, y: 0, t: 0 };
      const p2 = pt2 < profile.points.length ? profile.points[pt2] : { x: 0, y: 0, t: 0 };
      const pb = (pt2 - 1) < profile.points.length ? profile.points[pt2 - 1] : { x: 0, y: 0, t: 0 };

      const distA = (pa.x - p2.x) ** 2 + (pa.y - p2.y) ** 2;
      const distB = (pb.x - p1.x) ** 2 + (pb.y - p1.y) ** 2;
      useA = distA < distB;
    } else if (pt1 + 1 < outerCount) {
      useA = true;
    } else {
      useA = false;
    }

    const reverseWinding = (isTop === useA);

    if (useA) {
      const idx0 = Math.min(offset + pt1, maxIdx);
      const idx1 = Math.min(offset + pt1 + 1, maxIdx);
      const idx2 = Math.min(offset + pt2, maxIdx);

      const v0 = slToGltf(verts[idx0]);
      const v1 = slToGltf(verts[idx1]);
      const v2 = slToGltf(verts[idx2]);

      const uv0 = capUv(profile, pt1, isTop);
      const uv1 = capUv(profile, pt1 + 1, isTop);
      const uv2 = capUv(profile, pt2, isTop);

      if (reverseWinding) {
        positions.push(v0.x, v0.y, v0.z, v2.x, v2.y, v2.z, v1.x, v1.y, v1.z);
        uvs.push(uv0.x, uv0.y, uv2.x, uv2.y, uv1.x, uv1.y);
      } else {
        positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
        uvs.push(uv0.x, uv0.y, uv1.x, uv1.y, uv2.x, uv2.y);
      }
      normals.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
      indices.push(vertIdx, vertIdx + 1, vertIdx + 2); vertIdx += 3;
      pt1++;
    } else {
      const idx0 = Math.min(offset + pt1, maxIdx);
      const idx1 = Math.min(offset + pt2, maxIdx);
      const idx2 = Math.min(offset + pt2 - 1, maxIdx);

      const v0 = slToGltf(verts[idx0]);
      const v1 = slToGltf(verts[idx1]);
      const v2 = slToGltf(verts[idx2]);

      const uv0 = capUv(profile, pt1, isTop);
      const uv1 = capUv(profile, pt2, isTop);
      const uv2 = capUv(profile, pt2 - 1, isTop);

      if (reverseWinding) {
        positions.push(v0.x, v0.y, v0.z, v2.x, v2.y, v2.z, v1.x, v1.y, v1.z);
        uvs.push(uv0.x, uv0.y, uv2.x, uv2.y, uv1.x, uv1.y);
      } else {
        positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
        uvs.push(uv0.x, uv0.y, uv1.x, uv1.y, uv2.x, uv2.y);
      }
      normals.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
      indices.push(vertIdx, vertIdx + 1, vertIdx + 2); vertIdx += 3;
      pt2--;
    }
  }

  computeFlatNormals(positions, normals, indices);
  return { positions, normals, uvs, indices };
}


function capUv(profile: ProfileResult, idx: number, isTop: boolean): Vec2 {
  if (idx >= profile.points.length) return { x: 0.5, y: 0.5 };
  return capUvFromProfile(profile.points[idx], isTop);
}


function capUvFromProfile(p: ProfilePoint, isTop: boolean): Vec2 {
  if (isTop) {
    return { x: p.x + 0.5, y: 0.5 - p.y };
  } else {
    return { x: p.x + 0.5, y: p.y + 0.5 };
  }
}


function sweptNormal(profile: ProfileResult, pathPts: PathPoint[], si: number, ti: number): Vec3 {
  const p = si < profile.points.length ? profile.points[si] : { x: 0, y: 0, t: 0 };
  let pn: Vec3 = { x: p.x, y: p.y, z: 0 };
  const lenSq = pn.x * pn.x + pn.y * pn.y;
  if (lenSq < 0.0001) {
    pn = { x: 0, y: 1, z: 0 };
  } else {
    const len = Math.sqrt(lenSq);
    pn = { x: pn.x / len, y: pn.y / len, z: 0 };
  }

  const pp = pathPts[ti];
  const sx = Math.abs(pp.scale.x) > 0.0001 ? pp.scale.x : 1.0;
  const sy = Math.abs(pp.scale.y) > 0.0001 ? pp.scale.y : 1.0;
  const scaledN: Vec3 = vec3Normalize({ x: pn.x / sx, y: pn.y / sy, z: 0 });

  return slToGltf(basisTransformVec3(pp.rot, scaledN));
}


function computeFlatNormals(positions: number[], normals: number[], indices: number[]): void {
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
    const ux = positions[ib] - positions[ia], uy = positions[ib + 1] - positions[ia + 1], uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia], vy = positions[ic + 1] - positions[ia + 1], vz = positions[ic + 2] - positions[ia + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;

    normals[ia] = nx; normals[ia + 1] = ny; normals[ia + 2] = nz;
    normals[ib] = nx; normals[ib + 1] = ny; normals[ib + 2] = nz;
    normals[ic] = nx; normals[ic + 1] = ny; normals[ic + 2] = nz;
  }
}


// ─── Main Generate ──────────────────────────────────────

function generatePrimSurfaces(s: PrimShapeParams): MeshSurface[] {
  const pathCurve = s.pathCurve;
  const profileCurve = s.profileCurve;

  const profileType = profileCurve & PROFILE_MASK;
  const holeType = profileCurve & HOLE_MASK;
  const isPathLine = (pathCurve & 0xf0) === PATH_LINE || (pathCurve & 0xf0) === 0x80;
  const pathOpen = isPathLine || s.pathBegin > 0 || s.pathEnd < 1 || Math.abs(s.pathSkew) > 0.001;

  const profile = generateProfile(profileType, holeType, s.profileBegin, s.profileEnd, s.profileHollow, pathOpen);
  const pathPts = generatePath(pathCurve, s.pathBegin, s.pathEnd, s.pathScaleX, s.pathScaleY,
    s.pathShearX, s.pathShearY, s.pathTwist, s.pathTwistBegin,
    s.pathRadiusOffset, s.pathTaperX, s.pathTaperY, s.pathRevolutions, s.pathSkew, profileType);

  // Sweep profile along path
  const meshVerts: Vec3[] = [];
  const profileLen = profile.points.length;
  const pathLen = pathPts.length;

  for (let pi = 0; pi < pathLen; pi++) {
    const pp = pathPts[pi];
    for (let si = 0; si < profileLen; si++) {
      const pt = profile.points[si];
      const scaled: Vec3 = { x: pt.x * pp.scale.x, y: pt.y * pp.scale.y, z: 0 };
      const rotated = basisTransformVec3(pp.rot, scaled);
      meshVerts.push({ x: rotated.x + pp.pos.x, y: rotated.y + pp.pos.y, z: rotated.z + pp.pos.z });
    }
  }

  // Build each face as a separate surface
  const surfaces: MeshSurface[] = [];
  for (const face of profile.faces) {
    let surface: MeshSurface;
    if (face.isCap) {
      surface = buildCap(meshVerts, profile, pathPts, face, pathLen, profileLen);
    } else {
      surface = buildSide(meshVerts, profile, pathPts, face, pathLen, profileLen);
    }
    if (surface.positions.length > 0) {
      // Reverse triangle winding: the GDScript produces CW triangles
      // (tuned for Godot's reversed generate_normals). glTF/Three.js
      // needs CCW for front-facing. Swap indices[1] and indices[2].
      for (let i = 0; i < surface.indices.length; i += 3) {
        const tmp = surface.indices[i + 1];
        surface.indices[i + 1] = surface.indices[i + 2];
        surface.indices[i + 2] = tmp;
      }
      // Negate normals: smooth normals (sweptNormal) and flat normals
      // (computeFlatNormals) were both computed for CW winding.
      // After reversing to CCW, normals need to flip.
      for (let i = 0; i < surface.normals.length; i++) {
        surface.normals[i] = -surface.normals[i];
      }
      surfaces.push(surface);
    }
  }

  return surfaces;
}


// ─── Public API ─────────────────────────────────────────

/** Generate a GLB from prim shape parameters. */
export function primShapeToGlb(shape: PrimShapeParams): Buffer {
  const surfaces = generatePrimSurfaces(shape);
  return multiSurfaceToGlb(surfaces);
}

/** Get the number of faces a prim shape will produce (for texture mapping). */
export function primFaceCount(shape: PrimShapeParams): number {
  const profileType = shape.profileCurve & PROFILE_MASK;
  const holeType = shape.profileCurve & HOLE_MASK;
  const isPathLine = (shape.pathCurve & 0xf0) === PATH_LINE || (shape.pathCurve & 0xf0) === 0x80;
  const pathOpen = isPathLine || shape.pathBegin > 0 || shape.pathEnd < 1 || Math.abs(shape.pathSkew) > 0.001;
  const profile = generateProfile(profileType, holeType, shape.profileBegin, shape.profileEnd, shape.profileHollow, pathOpen);
  return profile.faces.length;
}
