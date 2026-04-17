/**
 * sculpt-converter.ts — Converts SL sculpt map textures to GLB meshes.
 * Decodes J2K sculpt texture → RGB pixel grid → mesh geometry → binary glTF.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

import { SculptType } from '../../../node-metaverse/lib';
import type { DecodePool } from './decode-pool';

type Vec3 = { x: number; y: number; z: number };

const cachedSculpts = new Set<string>();

function getCacheDir(): string {
  return path.join(app.getPath('userData'), 'asset-cache', 'meshes');
}

export function sculptCachePath(textureUuid: string, sculptType: number): string {
  return path.join(getCacheDir(), `sculpt_${textureUuid}_${sculptType}.glb`);
}

export function isSculptCached(textureUuid: string, sculptType: number): boolean {
  return cachedSculpts.has(`${textureUuid}_${sculptType}`);
}

/** Sculpt mesh ID used as meshId in Godot messages */
export function sculptMeshId(textureUuid: string, sculptType: number): string {
  return `sculpt_${textureUuid}_${sculptType}`;
}

// ─── Sculpt map decode ───────────────────────────────────────────────

/** Decode sculpt texture pixels into a vertex grid at native resolution.
 *  Each pixel's RGB maps to an XYZ vertex position in [-0.5, 0.5]. */
export function decodeSculptMap(
  pixels: Buffer, width: number, height: number, channels: number
): Vec3[][] {
  const grid: Vec3[][] = [];
  for (let row = 0; row < height; row++) {
    const gridRow: Vec3[] = [];
    for (let col = 0; col < width; col++) {
      const idx = (row * width + col) * channels;
      const x = (pixels[idx] / 255) - 0.5;
      const y = (pixels[idx + 1] / 255) - 0.5;
      const z = (pixels[idx + 2] / 255) - 0.5;
      gridRow.push({ x, y, z });
    }
    grid.push(gridRow);
  }
  return grid;
}

// ─── Mesh generation ─────────────────────────────────────────────────

export function buildSculptMesh(
  grid: Vec3[][], flags: number
): { positions: number[]; normals: number[]; uvs: number[]; indices: number[] } {
  const baseType = flags & 0x07;
  const invert = (flags & SculptType.Invert) !== 0;
  const mirror = (flags & SculptType.Mirror) !== 0;

  const rows = grid.length;
  const cols = grid[0].length;

  if (mirror) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        grid[r][c].x = -grid[r][c].x;
      }
    }
  }

  const wrapU = baseType === SculptType.Sphere || baseType === SculptType.Torus || baseType === SculptType.Cylinder;
  const wrapV = baseType === SculptType.Torus;

  if (wrapU) {
    for (let r = 0; r < rows; r++) {
      const avg = {
        x: (grid[r][0].x + grid[r][cols - 1].x) / 2,
        y: (grid[r][0].y + grid[r][cols - 1].y) / 2,
        z: (grid[r][0].z + grid[r][cols - 1].z) / 2,
      };
      grid[r][0] = avg;
      grid[r][cols - 1] = avg;
    }
  }
  if (wrapV) {
    for (let c = 0; c < cols; c++) {
      const avg = {
        x: (grid[0][c].x + grid[rows - 1][c].x) / 2,
        y: (grid[0][c].y + grid[rows - 1][c].y) / 2,
        z: (grid[0][c].z + grid[rows - 1][c].z) / 2,
      };
      grid[0][c] = avg;
      grid[rows - 1][c] = avg;
    }
  }

  if (baseType === SculptType.Sphere) {
    const topAvg = { x: 0, y: 0, z: 0 };
    for (let c = 0; c < cols; c++) {
      topAvg.x += grid[0][c].x; topAvg.y += grid[0][c].y; topAvg.z += grid[0][c].z;
    }
    topAvg.x /= cols; topAvg.y /= cols; topAvg.z /= cols;
    for (let c = 0; c < cols; c++) grid[0][c] = topAvg;

    const botAvg = { x: 0, y: 0, z: 0 };
    for (let c = 0; c < cols; c++) {
      botAvg.x += grid[rows - 1][c].x; botAvg.y += grid[rows - 1][c].y; botAvg.z += grid[rows - 1][c].z;
    }
    botAvg.x /= cols; botAvg.y /= cols; botAvg.z /= cols;
    for (let c = 0; c < cols; c++) grid[rows - 1][c] = botAvg;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r][c];
      // SL (x,y,z) -> Godot (x,z,-y)
      positions.push(v.x, v.z, -v.y);
      uvs.push(c / (cols - 1), r / (rows - 1));
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const tl = r * cols + c;
      const tr = r * cols + c + 1;
      const bl = (r + 1) * cols + c;
      const br = (r + 1) * cols + c + 1;

      if (invert) {
        indices.push(tl, tr, bl);
        indices.push(tr, br, bl);
      } else {
        indices.push(tl, bl, tr);
        indices.push(tr, bl, br);
      }
    }
  }

  // Compute averaged vertex normals
  const normalsAccum = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i], ib = indices[i + 1], ic = indices[i + 2];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    normalsAccum[ia * 3] += nx; normalsAccum[ia * 3 + 1] += ny; normalsAccum[ia * 3 + 2] += nz;
    normalsAccum[ib * 3] += nx; normalsAccum[ib * 3 + 1] += ny; normalsAccum[ib * 3 + 2] += nz;
    normalsAccum[ic * 3] += nx; normalsAccum[ic * 3 + 1] += ny; normalsAccum[ic * 3 + 2] += nz;
  }
  const normals: number[] = [];
  for (let i = 0; i < normalsAccum.length; i += 3) {
    const len = Math.sqrt(normalsAccum[i] ** 2 + normalsAccum[i + 1] ** 2 + normalsAccum[i + 2] ** 2) || 1;
    normals.push(normalsAccum[i] / len, normalsAccum[i + 1] / len, normalsAccum[i + 2] / len);
  }

  return { positions, normals, uvs, indices };
}

// ─── GLB encoder ─────────────────────────────────────────────────────

export function sculptMeshToGlb(mesh: { positions: number[]; normals: number[]; uvs: number[]; indices: number[] }): Buffer {
  const vertCount = mesh.positions.length / 3;
  const idxCount = mesh.indices.length;

  const bufferParts: Buffer[] = [];
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  const attributes: Record<string, number> = {};
  let byteOffset = 0;

  // Positions
  const posBuf = Buffer.alloc(vertCount * 12);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertCount; i++) {
    const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
    posBuf.writeFloatLE(x, i * 12); posBuf.writeFloatLE(y, i * 12 + 4); posBuf.writeFloatLE(z, i * 12 + 8);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  bufferViews.push({ buffer: 0, byteOffset, byteLength: posBuf.length });
  accessors.push({ bufferView: 0, componentType: 5126, count: vertCount, type: 'VEC3', min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
  attributes['POSITION'] = 0;
  bufferParts.push(posBuf); byteOffset += posBuf.length;

  // Normals
  const nrmBuf = Buffer.alloc(vertCount * 12);
  for (let i = 0; i < vertCount; i++) {
    nrmBuf.writeFloatLE(mesh.normals[i * 3], i * 12);
    nrmBuf.writeFloatLE(mesh.normals[i * 3 + 1], i * 12 + 4);
    nrmBuf.writeFloatLE(mesh.normals[i * 3 + 2], i * 12 + 8);
  }
  bufferViews.push({ buffer: 0, byteOffset, byteLength: nrmBuf.length });
  accessors.push({ bufferView: 1, componentType: 5126, count: vertCount, type: 'VEC3' });
  attributes['NORMAL'] = 1;
  bufferParts.push(nrmBuf); byteOffset += nrmBuf.length;

  // UVs
  const uvBuf = Buffer.alloc(vertCount * 8);
  for (let i = 0; i < vertCount; i++) {
    uvBuf.writeFloatLE(mesh.uvs[i * 2], i * 8);
    uvBuf.writeFloatLE(mesh.uvs[i * 2 + 1], i * 8 + 4);
  }
  bufferViews.push({ buffer: 0, byteOffset, byteLength: uvBuf.length });
  accessors.push({ bufferView: 2, componentType: 5126, count: vertCount, type: 'VEC2' });
  attributes['TEXCOORD_0'] = 2;
  bufferParts.push(uvBuf); byteOffset += uvBuf.length;

  // Indices
  const useUint32 = vertCount > 65535;
  const idxByteSize = useUint32 ? 4 : 2;
  const idxBuf = Buffer.alloc(idxCount * idxByteSize);
  for (let i = 0; i < idxCount; i++) {
    if (useUint32) idxBuf.writeUInt32LE(mesh.indices[i], i * 4);
    else idxBuf.writeUInt16LE(mesh.indices[i], i * 2);
  }
  const idxPadding = (4 - (idxBuf.length % 4)) % 4;
  const idxAligned = idxPadding > 0 ? Buffer.concat([idxBuf, Buffer.alloc(idxPadding)]) : idxBuf;
  bufferViews.push({ buffer: 0, byteOffset, byteLength: idxBuf.length });
  accessors.push({ bufferView: 3, componentType: useUint32 ? 5125 : 5123, count: idxCount, type: 'SCALAR' });
  bufferParts.push(idxAligned); byteOffset += idxAligned.length;

  const gltf = {
    asset: { version: '2.0', generator: 'PyroKitty-SculptConvert' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: 3 }] }],
    accessors, bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonPad = (4 - (jsonStr.length % 4)) % 4;
  const jsonBuf = Buffer.from(jsonStr + ' '.repeat(jsonPad), 'utf8');
  const binBuf = Buffer.concat(bufferParts);

  const totalLength = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const glb = Buffer.alloc(totalLength);
  let off = 0;
  glb.writeUInt32LE(0x46546C67, off); off += 4; // magic "glTF"
  glb.writeUInt32LE(2, off); off += 4;           // version
  glb.writeUInt32LE(totalLength, off); off += 4;
  glb.writeUInt32LE(jsonBuf.length, off); off += 4;
  glb.writeUInt32LE(0x4E4F534A, off); off += 4;   // "JSON"
  jsonBuf.copy(glb, off); off += jsonBuf.length;
  glb.writeUInt32LE(binBuf.length, off); off += 4;
  glb.writeUInt32LE(0x004E4942, off); off += 4;   // "BIN\0"
  binBuf.copy(glb, off);
  return glb;
}

// ─── Full pipeline ───────────────────────────────────────────────────

export async function ensureSculptCached(
  textureUuid: string, sculptType: number, j2cBuffer: Buffer,
  decodePool: DecodePool,
): Promise<string> {
  const cacheKey = `${textureUuid}_${sculptType}`;
  const cachePath = sculptCachePath(textureUuid, sculptType);
  if (cachedSculpts.has(cacheKey)) return cachePath;

  try {
    await fs.promises.access(cachePath);
    cachedSculpts.add(cacheKey);
    return cachePath;
  } catch {}

  const raw = await decodePool.decodeRaw(j2cBuffer);
  const pixels: Buffer = raw.rgbaPixels;
  const width = raw.width;
  const height = raw.height;
  const channels = 4; // decodeRaw always returns RGBA

  const grid = decodeSculptMap(pixels, width, height, channels);
  const mesh = buildSculptMesh(grid, sculptType);
  const glb = sculptMeshToGlb(mesh);

  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.promises.writeFile(cachePath, glb);
  cachedSculpts.add(cacheKey);
  return cachePath;
}
