/**
 * glb-encoder.ts — Shared GLB (binary glTF 2.0) encoder.
 * Hand-rolled, no npm dependencies. Used by sculpt-converter and prim-converter.
 */

export interface MeshSurface {
  positions: number[];  // xyz triples
  normals: number[];    // xyz triples
  uvs: number[];        // uv pairs
  indices: number[];    // triangle indices
}

/**
 * Encode a single mesh surface as a GLB buffer.
 */
export function meshToGlb(mesh: MeshSurface): Buffer {
  return multiSurfaceToGlb([mesh]);
}

/**
 * Encode multiple surfaces (faces) as a single GLB with multiple primitives.
 * Each surface becomes a separate primitive in the glTF mesh, enabling
 * per-face texture assignment in Three.js (each primitive gets its own material index).
 */
export function multiSurfaceToGlb(surfaces: MeshSurface[]): Buffer {
  const bufferParts: Buffer[] = [];
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  const primitives: any[] = [];
  let byteOffset = 0;
  let bvIndex = 0;

  for (const mesh of surfaces) {
    const vertCount = mesh.positions.length / 3;
    const idxCount = mesh.indices.length;

    if (vertCount === 0 || idxCount === 0) continue;

    const attributes: Record<string, number> = {};

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
    const posAccIdx = accessors.length;
    accessors.push({ bufferView: bvIndex, componentType: 5126, count: vertCount, type: 'VEC3', min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
    attributes['POSITION'] = posAccIdx;
    bufferParts.push(posBuf); byteOffset += posBuf.length; bvIndex++;

    // Normals
    const nrmBuf = Buffer.alloc(vertCount * 12);
    for (let i = 0; i < vertCount; i++) {
      nrmBuf.writeFloatLE(mesh.normals[i * 3], i * 12);
      nrmBuf.writeFloatLE(mesh.normals[i * 3 + 1], i * 12 + 4);
      nrmBuf.writeFloatLE(mesh.normals[i * 3 + 2], i * 12 + 8);
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: nrmBuf.length });
    const nrmAccIdx = accessors.length;
    accessors.push({ bufferView: bvIndex, componentType: 5126, count: vertCount, type: 'VEC3' });
    attributes['NORMAL'] = nrmAccIdx;
    bufferParts.push(nrmBuf); byteOffset += nrmBuf.length; bvIndex++;

    // UVs
    const uvBuf = Buffer.alloc(vertCount * 8);
    for (let i = 0; i < vertCount; i++) {
      uvBuf.writeFloatLE(mesh.uvs[i * 2], i * 8);
      uvBuf.writeFloatLE(mesh.uvs[i * 2 + 1], i * 8 + 4);
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: uvBuf.length });
    const uvAccIdx = accessors.length;
    accessors.push({ bufferView: bvIndex, componentType: 5126, count: vertCount, type: 'VEC2' });
    attributes['TEXCOORD_0'] = uvAccIdx;
    bufferParts.push(uvBuf); byteOffset += uvBuf.length; bvIndex++;

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
    const idxAccIdx = accessors.length;
    accessors.push({ bufferView: bvIndex, componentType: useUint32 ? 5125 : 5123, count: idxCount, type: 'SCALAR' });
    bufferParts.push(idxAligned); byteOffset += idxAligned.length; bvIndex++;

    primitives.push({ attributes, indices: idxAccIdx });
  }

  if (primitives.length === 0) {
    // Fallback: emit a degenerate single-triangle GLB
    return meshToGlb({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'PyroKitty' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
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
