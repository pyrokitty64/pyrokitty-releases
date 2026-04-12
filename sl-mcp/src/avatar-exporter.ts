/**
 * avatar-exporter.ts — Export a complete SL avatar as a single GLB file.
 *
 * Gathers all worn mesh attachments, downloads meshes + textures, builds a
 * shared skeleton with shape deformations baked in, and writes a composite
 * GLB with embedded textures.  Uh...can't stop won't stop?
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { BotManager } from './bot-manager.js';
import type { Bot } from '../../electron-ui/node-metaverse/dist/lib/index.js';
import { AssetType } from '../../electron-ui/node-metaverse/dist/lib/enums/AssetType.js';
import { SculptType } from '../../electron-ui/node-metaverse/dist/lib/enums/SculptType.js';
import { LLMesh } from '../../electron-ui/node-metaverse/dist/lib/classes/public/LLMesh.js';
import { TextureEntry } from '../../electron-ui/node-metaverse/dist/lib/classes/TextureEntry.js';

// Pure math/skeleton functions — self-contained ESM module, no CJS/ESM cycle issues
import * as mc from './mesh-math.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WornMesh {
  meshUuid: string;
  llMesh: LLMesh;
  name: string;
  attachmentPoint: number;
  textureEntry: TextureEntry | null;
  faceTextures: Array<{ textureId: string; color: [number, number, number, number] }>;
  /** Object position/rotation/scale for unrigged attachments */
  objPosition?: [number, number, number];
  objRotation?: [number, number, number, number]; // quaternion xyzw
  objScale?: [number, number, number];
  isRigged: boolean;
}

interface TextureData {
  buffer: Buffer;
  mimeType: string;
}

interface SkeletonBuild {
  jointList: string[];
  nodes: any[];
  jointNodeIdx: Map<string, number>;
  /** Joint name → fixup matrix (scale+rotation stripped from node, baked into IBMs) */
  fixupMatrices: Map<string, number[]>;
  armatureIdx: number;
}

export interface ExportOptions {
  avatarId?: string;
  outputPath?: string;
  includeTextures?: boolean;
}

const LOD_PREFERENCE = ['high_lod', 'medium_lod', 'low_lod', 'lowest_lod'];
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function exportAvatar(botManager: BotManager, opts: ExportOptions): Promise<string> {
  const bot = botManager.getBot();
  if (!bot) throw new Error('Bot not connected');

  // Initialize skeleton data (loads avatar_skeleton.json + avatar_lad_attachments.json)
  await mc.initSkeletonData();

  const avatarId = opts.avatarId || bot.agentID().toString();
  const region = bot.currentRegion;
  const avatar = region?.agents?.get(avatarId);
  if (!avatar) throw new Error(`Avatar ${avatarId} not found in current region`);

  const avatarName = `${avatar.firstName}_${avatar.lastName}`;
  const outputPath = opts.outputPath || `${EXPORTS_DIR}/avatar_${avatarName}.glb`;

  const lines: string[] = [];
  lines.push(`Exporting avatar: ${avatar.firstName} ${avatar.lastName} (${avatarId})`);

  // --- Phase A: Gather worn mesh data ---
  const bakedUuids = botManager.getBakedTextures(avatarId);
  const wornMeshes = await gatherWornMeshes(bot, avatar, lines, bakedUuids);
  lines.push(`Found ${wornMeshes.length} worn meshes`);

  if (wornMeshes.length === 0) {
    return lines.join('\n') + '\nNo mesh attachments found — nothing to export.';
  }

  // --- Phase B: Download textures (mesh textures + baked textures) ---
  const textures = new Map<string, TextureData>();
  if (opts.includeTextures !== false) {
    await downloadTextures(bot, wornMeshes, textures, lines, bakedUuids, avatarId);
    lines.push(`Downloaded ${textures.size} unique textures`);
  }

  // --- Phase C: Build shared skeleton ---
  const visualParamBytes = botManager.getVisualParams(avatarId);
  let shapeDeltas: Record<string, { scale: [number, number, number]; offset: [number, number, number] }> | null = null;
  if (visualParamBytes) {
    try {
      const { computeShapeDeltas } = await import('./avatar-shape.js');
      const result = computeShapeDeltas(visualParamBytes);
      shapeDeltas = result.bones;
      lines.push(`Shape: ${Object.keys(result.bones).length} bone deltas, hover=${result.hoverHeight.toFixed(3)}`);
    } catch (err: any) {
      lines.push(`Shape computation failed: ${err.message?.slice(0, 80)}`);
    }
  }
  const skeleton = buildSharedSkeleton(wornMeshes, shapeDeltas);
  lines.push(`Shared skeleton: ${skeleton.jointList.length} joints`);

  // --- Phase D: Compose GLB ---
  const glb = composeAvatarGlb(skeleton, wornMeshes, textures);
  lines.push(`GLB size: ${(glb.length / 1024).toFixed(1)} KB`);

  // Write to disk
  await mkdir(dirname(outputPath), { recursive: true }).catch(() => {});
  await writeFile(outputPath, glb);
  lines.push(`Written to: ${outputPath}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase A: Gather worn meshes
// ---------------------------------------------------------------------------

async function gatherWornMeshes(bot: Bot, avatar: any, lines: string[], bakedUuids?: string[] | null): Promise<WornMesh[]> {
  const attachments = avatar.getAttachments();
  const wornMeshes: WornMesh[] = [];
  const seenMeshUuids = new Set<string>();

  for (const [_itemId, obj] of attachments) {
    // Skip HUD attachments (points 31-38)
    const ap = obj.attachmentPoint ?? 0;
    if (ap >= 31 && ap <= 38) continue;

    // Collect meshes from this object and its children
    const objectsToCheck = [obj];

    // Get linkset children
    try {
      const children = bot.currentRegion.objects.getObjectsByParent(obj.ID);
      if (children) objectsToCheck.push(...children);
    } catch { /* no children */ }

    for (const checkObj of objectsToCheck) {
      const md = checkObj.extraParams?.meshData;
      if (!md || md.type !== SculptType.Mesh) continue;

      const meshUuid = md.meshData?.toString();
      if (!meshUuid || meshUuid === ZERO_UUID || seenMeshUuids.has(meshUuid)) continue;
      seenMeshUuids.add(meshUuid);

      try {
        const meshBuf = await bot.clientCommands.asset.downloadAsset(AssetType.Mesh, meshUuid);
        if (!meshBuf || meshBuf.length === 0) {
          lines.push(`  SKIP: empty mesh ${meshUuid}`);
          continue;
        }
        const llMesh = await LLMesh.from(meshBuf);

        // Extract texture info from TextureEntry
        const faceTextures = extractFaceTextures(checkObj, bakedUuids);

        // Debug: check BSM and raw vertex bounds
        const skin = llMesh.skin;
        const bsmAll = skin?.bindShapeMatrix?.all();
        const bsmIdent = !bsmAll || bsmAll.every((v: number, i: number) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6);
        const sub0 = (llMesh.lodLevels.high_lod || llMesh.lodLevels.medium_lod || llMesh.lodLevels.low_lod)?.[0];
        let rawBounds = '';
        if (sub0?.position?.length) {
          let mnY = Infinity, mxY = -Infinity;
          for (const p of sub0.position) { if (p.z < mnY) mnY = p.z; if (p.z > mxY) mxY = p.z; }
          rawBounds = ` rawZ=[${mnY.toFixed(2)}..${mxY.toFixed(2)}]`;
        }
        if (!bsmIdent && bsmAll) {
          lines.push(`    BSM: scale=[${bsmAll[0].toFixed(3)},${bsmAll[5].toFixed(3)},${bsmAll[10].toFixed(3)}] trans=[${bsmAll[12].toFixed(3)},${bsmAll[13].toFixed(3)},${bsmAll[14].toFixed(3)}]${rawBounds}`);
        }

        const name = (checkObj as any).name || `mesh_${meshUuid.slice(0, 8)}`;
        const skinData = llMesh.skin;
        const rigged = !!(skinData && skinData.jointNames && skinData.jointNames.length > 0);
        // Capture object transform for unrigged attachments
        const pos = checkObj.Position;
        const rot = checkObj.Rotation;
        const scl = checkObj.Scale;
        wornMeshes.push({
          meshUuid,
          llMesh,
          name,
          attachmentPoint: ap,
          textureEntry: null,
          faceTextures,
          isRigged: rigged,
          objPosition: pos ? [pos.x, pos.y, pos.z] : undefined,
          objRotation: rot ? [rot.x, rot.y, rot.z, rot.w] : undefined,
          objScale: scl ? [scl.x, scl.y, scl.z] : undefined,
        });
        // Log face texture assignments
        const ftSummary = faceTextures.slice(0, 4).map((ft, i) =>
          `f${i}=${ft.textureId === ZERO_UUID ? '0' : ft.textureId.slice(0, 8)}`
        ).join(' ');
        lines.push(`  OK: ${name} (${meshUuid.slice(0, 8)}...) — ${countVerts(llMesh)} verts [${ftSummary}]`);
      } catch (err: any) {
        lines.push(`  FAIL: ${meshUuid.slice(0, 8)}... — ${err.message}`);
      }
    }
  }

  return wornMeshes;
}

// Magic bake UUIDs → bake channel index (matching godot-bridge-types.ts)
const BAKE_MAGIC_UUIDS = new Map<string, number>([
  ['5a9f4a74-30f2-821c-b88d-70499d3e7183', 0],  // HEAD
  ['ae2de45c-d252-50b8-5c6e-19f39ce79317', 1],  // UPPER
  ['24daea5f-0539-cfcf-047f-fbc40b2786ba', 2],  // LOWER
  ['52cc6bb6-2ee5-e632-d3ad-50197b1dcb8a', 3],  // EYES
  ['43529ce8-7faa-ad92-165a-bc4078371687', 4],  // SKIRT
  ['09aac1fb-6bce-0bee-7d44-caac6dbb6c63', 5],  // HAIR
  ['ff62763f-d60a-9855-890b-0c96f8f8cd98', 6],  // LEFTARM
  ['8e915e25-31d1-cc95-ae08-d58a47488251', 7],  // LEFTLEG
  ['9742065b-19b5-297c-858a-29711d539043', 8],  // AUX1
  ['03642e83-2bd1-4eb9-34b4-4c47ed586d2d', 9],  // AUX2
  ['edd51b77-fc10-ce7a-4b3d-011dfc349e4f', 10], // AUX3
]);

function extractFaceTextures(
  obj: any,
  bakedUuids?: string[] | null,
): Array<{ textureId: string; color: [number, number, number, number] }> {
  const faces: Array<{ textureId: string; color: [number, number, number, number] }> = [];
  try {
    const te = obj.TextureEntry;
    if (!te) return faces;
    const parsed = te instanceof TextureEntry ? te : TextureEntry.from(te);

    // Extract up to 8 faces (typical max for SL mesh)
    for (let f = 0; f < 8; f++) {
      const face = parsed.faces[f] || parsed.defaultTexture;
      if (face) {
        let texId = face.textureID?.toString() || ZERO_UUID;
        // Substitute magic bake UUIDs with actual baked texture UUIDs
        const bakeChannel = BAKE_MAGIC_UUIDS.get(texId);
        if (bakeChannel !== undefined && bakedUuids && bakedUuids[bakeChannel]) {
          texId = bakedUuids[bakeChannel];
        }
        faces.push({
          textureId: texId,
          color: [
            (face.rgbaColor?.[0] ?? 255) / 255,
            (face.rgbaColor?.[1] ?? 255) / 255,
            (face.rgbaColor?.[2] ?? 255) / 255,
            (face.rgbaColor?.[3] ?? 255) / 255,
          ],
        });
      } else {
        faces.push({ textureId: ZERO_UUID, color: [1, 1, 1, 1] });
      }
    }
  } catch { /* TextureEntry parsing can fail */ }
  return faces;
}

function countVerts(mesh: LLMesh): number {
  for (const lod of LOD_PREFERENCE) {
    const level = mesh.lodLevels[lod];
    if (level && level.length > 0) {
      return level.reduce((sum, s) => sum + (s.position?.length || 0), 0);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// J2K decode
// ---------------------------------------------------------------------------

const OPJ_DECOMPRESS = 'C:/DeeDrive/dev/grumpy/openjpeg/opj_decompress.exe';
const EXPORTS_DIR = dirname(fileURLToPath(import.meta.url)) + '/../exports';

async function decodeJ2K(j2kBuf: Buffer): Promise<Buffer> {
  // Use native opj_decompress — handles 5-component bake textures correctly
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readFile: rf, writeFile: wf, unlink } = await import('node:fs/promises');
  const exec = promisify(execFile);

  const id = Math.random().toString(36).slice(2);
  const j2kPath = join(tmpdir(), `sl_bake_${id}.j2c`);
  const pngPath = join(tmpdir(), `sl_bake_${id}.png`);

  try {
    await wf(j2kPath, j2kBuf);
    await exec(OPJ_DECOMPRESS, ['-i', j2kPath, '-o', pngPath], { timeout: 15000 });
    const pngBuf = await rf(pngPath);
    return pngBuf;
  } finally {
    await unlink(j2kPath).catch(() => {});
    await unlink(pngPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Phase B: Download textures
// ---------------------------------------------------------------------------

async function downloadTextures(
  bot: Bot,
  wornMeshes: WornMesh[],
  textures: Map<string, TextureData>,
  lines: string[],
  bakedUuids?: string[] | null,
  avatarId?: string,
): Promise<void> {
  // Collect unique texture UUIDs from mesh faces
  const textureUuids = new Set<string>();
  for (const wm of wornMeshes) {
    for (const ft of wm.faceTextures) {
      if (ft.textureId && ft.textureId !== ZERO_UUID) {
        textureUuids.add(ft.textureId);
      }
    }
  }

  // Add baked texture UUIDs (from AvatarAppearance)
  const BAKE_NAMES = ['HEAD', 'UPPER', 'LOWER', 'EYES', 'SKIRT', 'HAIR',
                      'LEFTARM', 'LEFTLEG', 'AUX1', 'AUX2', 'AUX3'];
  if (bakedUuids) {
    for (let i = 0; i < bakedUuids.length; i++) {
      const uuid = bakedUuids[i];
      if (uuid && uuid !== ZERO_UUID && uuid.length === 36) {
        textureUuids.add(uuid);
        lines.push(`  Baked ${BAKE_NAMES[i] || i}: ${uuid.slice(0, 8)}...`);
      }
    }
  }

  lines.push(`Downloading ${textureUuids.size} unique textures...`);

  // Baked texture UUIDs — need appearance service download, not CDN
  const BAKE_CHANNEL_URL_NAMES = [
    'head', 'upper', 'lower', 'eyes', 'skirt', 'hair',
    'leftarm', 'leftleg', 'aux1', 'aux2', 'aux3',
  ];
  const bakedSet = new Set<string>();
  const bakedChannelMap = new Map<string, { avatarUuid: string; channel: number }>();
  if (bakedUuids) {
    for (let ch = 0; ch < bakedUuids.length; ch++) {
      const uuid = bakedUuids[ch];
      if (uuid && uuid !== ZERO_UUID && uuid.length === 36) {
        bakedSet.add(uuid);
        bakedChannelMap.set(uuid, { avatarUuid: avatarId || bot.agentID().toString(), channel: ch });
      }
    }
  }

  // Download textures
  const downloadOne = async (uuid: string) => {
    // For baked textures: appearance service URL (matching electron viewer's primary path)
    const bakeInfo = bakedChannelMap.get(uuid);
    if (bakeInfo) {
      const channelName = BAKE_CHANNEL_URL_NAMES[bakeInfo.channel] || `ch${bakeInfo.channel}`;
      try {
        const serviceUrl = (bot.agent as any)?.agentAppearanceService;
        if (serviceUrl) {
          const url = `${serviceUrl}texture/${bakeInfo.avatarUuid}/${channelName}/${uuid}`;
          const resp = await fetch(url, { headers: { 'Accept': 'image/x-j2c' } });
          if (resp.ok) {
            const j2kBuf = Buffer.from(await resp.arrayBuffer());
            if (j2kBuf.length > 100) {
              // Save raw J2K + log component count for debugging
              await writeFile(`${EXPORTS_DIR}/bake_${channelName}.j2c`, j2kBuf);
              const pngBuf = await decodeJ2K(j2kBuf);
              textures.set(uuid, { buffer: pngBuf, mimeType: 'image/png' });
              await writeFile(`${EXPORTS_DIR}/bake_${channelName}.png`, pngBuf);
              lines.push(`  Bake→PNG ${uuid.slice(0, 8)}... ${channelName} (j2k=${(j2kBuf.length/1024).toFixed(0)}KB png=${(pngBuf.length / 1024).toFixed(0)}KB)`);
              return;
            }
          }
        }
      } catch (err: any) {
        lines.push(`  Bake fail ${uuid.slice(0, 8)}... ${channelName}: ${err.message?.slice(0, 50)}`);
      }
    }

    // For regular textures: download J2K from asset CDN, decode to PNG (preserves alpha)
    if (!bakedSet.has(uuid)) {
      try {
        const cdnUrl = `http://asset-cdn.glb.agni.lindenlab.com/?texture_id=${uuid}`;
        const cdnResp = await fetch(cdnUrl);
        if (cdnResp.ok) {
          const j2kBuf = Buffer.from(await cdnResp.arrayBuffer());
          if (j2kBuf.length > 100) {
            const pngBuf = await decodeJ2K(j2kBuf);
            textures.set(uuid, { buffer: pngBuf, mimeType: 'image/png' });
            return;
          }
        }
      } catch { /* J2K CDN failed */ }
    }

    // Try GetTexture capability (authenticated, works for baked textures)
    try {
      const capUrl = await bot.currentRegion.caps.getCapability('GetTexture');
      if (capUrl) {
        const texUrl = `${capUrl}/?texture_id=${uuid}`;
        const capResp = await fetch(texUrl);
        if (capResp.ok) {
          const j2kBuf = Buffer.from(await capResp.arrayBuffer());
          if (j2kBuf.length > 100) {
            const pngBuf = await decodeJ2K(j2kBuf);
            textures.set(uuid, { buffer: pngBuf, mimeType: 'image/png' });
            lines.push(`  J2K→PNG ${uuid.slice(0, 8)}... (${(pngBuf.length / 1024).toFixed(0)} KB via cap)`);
            return;
          }
        }
      }
    } catch { /* cap download failed */ }

    // Last resort: download via sim ViewerAsset cap
    try {
      const j2kBuf = await bot.clientCommands.asset.downloadAsset(AssetType.Texture, uuid);
      if (j2kBuf && j2kBuf.length > 100) {
        const pngBuf = await decodeJ2K(j2kBuf);
        textures.set(uuid, { buffer: pngBuf, mimeType: 'image/png' });
        lines.push(`  J2K→PNG ${uuid.slice(0, 8)}... (${(pngBuf.length / 1024).toFixed(0)} KB via sim)`);
        return;
      }
    } catch { /* sim download also failed */ }

    lines.push(`  SKIP texture ${uuid.slice(0, 8)}... (unavailable)`);
  };

  // Download up to 10 at a time
  const BATCH = 10;
  const uuidArr = [...textureUuids];
  for (let i = 0; i < uuidArr.length; i += BATCH) {
    await Promise.all(uuidArr.slice(i, i + BATCH).map(downloadOne));
  }
}

// ---------------------------------------------------------------------------
// Phase C: Build shared skeleton
// ---------------------------------------------------------------------------

function buildSharedSkeleton(
  wornMeshes: WornMesh[],
  shapeDeltas: Record<string, { scale: [number, number, number]; offset: [number, number, number] }> | null,
): SkeletonBuild {
  const skeletonXml = mc.getSkeletonHierarchy();
  const attachPoints = mc.getAttachmentPoints();

  // --- Collect all required joints from all meshes ---
  const requiredJoints = new Set<string>();
  for (const wm of wornMeshes) {
    const skin = wm.llMesh.skin;
    if (!skin?.jointNames?.length) continue;
    for (const rawName of skin.jointNames) {
      let current: string | null = mc.resolveJointName(rawName);
      while (current) {
        requiredJoints.add(current);
        const sj = skeletonXml.get(current);
        current = sj?.parent ?? null;
      }
    }
  }
  requiredJoints.add('mPelvis');

  // --- Merge joint overrides from meshes (lowest UUID wins, matching SL) ---
  const jointOverrides = new Map<string, [number, number, number]>();
  const sortedMeshes = [...wornMeshes]
    .filter(wm => wm.llMesh.skin?.altInverseBindMatrix?.length)
    .sort((a, b) => a.meshUuid.localeCompare(b.meshUuid));
  for (const wm of sortedMeshes) {
    const skin = wm.llMesh.skin!;
    const resolvedNames = skin.jointNames.map((n: string) => mc.resolveJointName(n));
    if (skin.altInverseBindMatrix) {
      for (let i = 0; i < resolvedNames.length && i < skin.altInverseBindMatrix.length; i++) {
        const jname = resolvedNames[i];
        if (jointOverrides.has(jname)) continue;
        const sj = skeletonXml.get(jname);
        if (!sj) continue;
        const alt = skin.altInverseBindMatrix[i].all();
        const overridePos: [number, number, number] = [alt[12], alt[13], alt[14]];
        if (mc.vec3Dist(overridePos, sj.pos) > 0.0001) {
          jointOverrides.set(jname, overridePos);
        }
      }
    }
  }

  // --- Build glTF nodes with FULL local matrix (no blenderFixJoint) ---
  const nodes: any[] = [];
  const armatureIdx = 0;
  nodes.push({ name: 'Armature', children: [] as number[] });

  const jointNodeIdx = new Map<string, number>();
  const orderedJoints: string[] = [];
  const localMatrices = new Map<string, number[]>();
  const fixupMatrices = new Map<string, number[]>();

  const visitJoint = (name: string): void => {
    if (!requiredJoints.has(name) || jointNodeIdx.has(name)) return;
    const sj = skeletonXml.get(name);
    if (!sj) return;
    if (sj.parent && requiredJoints.has(sj.parent)) visitJoint(sj.parent);

    // Compute full local TRS matrix (with joint override + shape delta)
    let pos: [number, number, number] = jointOverrides.get(name) || [...sj.pos] as [number, number, number];
    // Apply shape offset delta to position
    if (shapeDeltas && shapeDeltas[name]) {
      const delta = shapeDeltas[name];
      pos = [pos[0] + delta.offset[0], pos[1] + delta.offset[1], pos[2] + delta.offset[2]];
    }
    const jMat = mc.composeMatrix(
      sj.scale,
      [sj.rot[0] * mc.DEG_TO_RAD, sj.rot[1] * mc.DEG_TO_RAD, sj.rot[2] * mc.DEG_TO_RAD],
      pos,
    );
    localMatrices.set(name, jMat);

    // Blender compat: translation-only node + fixup baked into IBMs
    // This matches mesh-converter.ts exactly.
    const { translationOnly, fixup } = mc.blenderFixJoint(jMat);
    fixupMatrices.set(name, fixup);
    const gltfMatrix = mc.slToGltfMatrix(translationOnly);
    const nodeIdx = nodes.length;
    nodes.push({ name, matrix: gltfMatrix, children: [] as number[] });
    jointNodeIdx.set(name, nodeIdx);
    orderedJoints.push(name);

    for (const child of sj.children) {
      if (requiredJoints.has(child)) visitJoint(child);
    }
  };

  visitJoint('mPelvis');
  for (const jname of requiredJoints) visitJoint(jname);

  // Wire parent-child relationships
  for (const jname of orderedJoints) {
    const sj = skeletonXml.get(jname);
    if (!sj) continue;
    const nodeIdx = jointNodeIdx.get(jname)!;
    if (!sj.parent || !jointNodeIdx.has(sj.parent)) {
      (nodes[armatureIdx].children as number[]).push(nodeIdx);
    } else {
      (nodes[jointNodeIdx.get(sj.parent)!].children as number[]).push(nodeIdx);
    }
  }

  // --- Compute world transforms (SL space) by chaining local matrices ---
  const worldTransforms = new Map<string, number[]>();
  const getWorld = (name: string): number[] => {
    const cached = worldTransforms.get(name);
    if (cached) return cached;
    const sj = skeletonXml.get(name);
    const local = localMatrices.get(name);
    if (!local) { const id = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]; worldTransforms.set(name, id); return id; }
    if (!sj?.parent || !worldTransforms.has(sj.parent) && !localMatrices.has(sj.parent)) {
      worldTransforms.set(name, local);
      return local;
    }
    const pw = getWorld(sj.parent);
    const w = mc.mat4Mul(pw, local);
    worldTransforms.set(name, w);
    return w;
  };
  // Compute in topological order
  for (const jname of orderedJoints) getWorld(jname);

  return {
    jointList: orderedJoints,
    nodes,
    jointNodeIdx,
    fixupMatrices,
    armatureIdx,
  };
}

// ---------------------------------------------------------------------------
// Phase D: Compose GLB
// ---------------------------------------------------------------------------

function composeAvatarGlb(
  skeleton: SkeletonBuild,
  wornMeshes: WornMesh[],
  textures: Map<string, TextureData>,
): Buffer {
  const bufferParts: Buffer[] = [];
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  let byteOffset = 0;

  // Clone nodes from skeleton (we'll add mesh nodes)
  const nodes = skeleton.nodes.map((n: any) => ({ ...n, children: [...(n.children || [])] }));
  const sceneNodes = [skeleton.armatureIdx];

  // --- Materials & textures ---
  const images: any[] = [];
  const glTextures: any[] = [];
  const materials: any[] = [];
  const samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  const textureIdxMap = new Map<string, number>();

  for (const [uuid, texData] of textures) {
    const imageIdx = images.length;
    images.push({ mimeType: texData.mimeType, _buffer: texData.buffer, _bvIdx: -1 });
    glTextures.push({ sampler: 0, source: imageIdx });
    const matIdx = materials.length;
    // PNG textures (from J2K) may have alpha → use MASK. JPEG can't → OPAQUE.
    const alphaMode = texData.mimeType === 'image/png' ? 'MASK' : 'OPAQUE';
    const mat: any = { pbrMetallicRoughness: { baseColorTexture: { index: glTextures.length - 1 }, metallicFactor: 0, roughnessFactor: 0.9 }, alphaMode };
    if (alphaMode === 'MASK') mat.alphaCutoff = 0.5;
    materials.push(mat);
    textureIdxMap.set(uuid, matIdx);
  }
  const fallbackMatIdx = materials.length;
  materials.push({ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, alphaMode: 'OPAQUE' });

  // --- Per-mesh skins: each mesh gets its own IBMs from its rawIBMs ---
  // Different meshes have different BSMs, so their rawIBMs differ for the same joint.
  // The rawIBM from each mesh is designed to work with that mesh's BSM-baked vertices.
  // Skeleton nodes have full TRS (no blenderFixJoint), so rawIBMs work directly.
  const skinJointIndices: number[] = [];
  for (const jname of skeleton.jointList) {
    skinJointIndices.push(skeleton.jointNodeIdx.get(jname) ?? skeleton.armatureIdx);
  }

  // Fallback IBMs: for joints not referenced by a mesh, compute from skeleton.
  // Chain translation-only world transforms (matching blenderFixJoint node approach)
  // then IBM = fixup @ inverse(translationWorld)
  const skeletonData = mc.getSkeletonHierarchy();
  const transWorldCache = new Map<string, number[]>();
  const getTransWorld = (name: string): number[] => {
    const c = transWorldCache.get(name);
    if (c) return c;
    const sj = skeletonData.get(name);
    if (!sj) { const id = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]; transWorldCache.set(name, id); return id; }
    // Translation from the node (blenderFixJoint strips to translation-only)
    const fixup = skeleton.fixupMatrices.get(name);
    // Recover translation: fullMat = translationOnly * fixup → translation = fullMat col3
    // Actually just get it from the node matrix directly (already translation-only in glTF)
    // Easier: reconstruct from skeleton joint data
    const overridePos = sj.pos; // we don't have overrides here, use XML default
    const localTrans = mc.mat4FromTranslation(overridePos[0], overridePos[1], overridePos[2]);
    if (!sj.parent || !transWorldCache.has(sj.parent) && !skeletonData.has(sj.parent)) {
      transWorldCache.set(name, localTrans); return localTrans;
    }
    const pw = getTransWorld(sj.parent);
    const w = mc.mat4Mul(pw, localTrans);
    transWorldCache.set(name, w);
    return w;
  };
  for (const jname of skeleton.jointList) getTransWorld(jname);
  const fallbackIBMs = new Map<string, number[]>();
  for (const jname of skeleton.jointList) {
    const tw = transWorldCache.get(jname);
    const invTw = tw ? mc.mat4Inverse(tw) : null;
    const fixup = skeleton.fixupMatrices.get(jname) || [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    const ibm = invTw ? mc.mat4Mul(fixup, invTw) : [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    fallbackIBMs.set(jname, mc.slToGltfMatrix(ibm));
  }

  // --- Process each mesh ---
  const meshDefs: any[] = [];
  const skinDefs: any[] = [];

  for (const wm of wornMeshes) {
    const skin = wm.llMesh.skin;
    const isRigged = !!(skin && skin.jointNames.length > 0);

    let submeshes: any[] | undefined;
    for (const lod of LOD_PREFERENCE) {
      const level = wm.llMesh.lodLevels[lod];
      if (level && level.length > 0) { submeshes = level; break; }
    }
    if (!submeshes || submeshes.length === 0) continue;

    // BSM: bake into vertices (matching mesh-converter.ts)
    const bsmColMaj: number[] | null = (isRigged && skin?.bindShapeMatrix)
      ? skin.bindShapeMatrix.all() : null;
    const bsmIsIdentity = !bsmColMaj || bsmColMaj.every(
      (v: number, i: number) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6
    );
    let bsmInvT3x3: number[] | null = null;
    if (bsmColMaj && !bsmIsIdentity) {
      bsmInvT3x3 = mc.computeInvTranspose3x3(bsmColMaj);
    }

    // Joint remap: mesh-local joint index → shared skeleton index
    let jointRemapTable: number[] = [];
    if (isRigged) {
      const resolvedNames = skin!.jointNames.map((n: string) => mc.resolveJointName(n));
      const sharedIndexMap = new Map<string, number>();
      for (let i = 0; i < skeleton.jointList.length; i++) sharedIndexMap.set(skeleton.jointList[i], i);
      jointRemapTable = resolvedNames.map((name: string) => sharedIndexMap.get(name) ?? 0);
    }

    const primitives: any[] = [];

    for (let subIdx = 0; subIdx < submeshes.length; subIdx++) {
      const sub = submeshes[subIdx];
      if (sub.noGeometry || !sub.position || sub.position.length === 0 ||
        !sub.triangleList || sub.triangleList.length === 0) continue;

      const vertCount = sub.position.length;
      const idxCount = sub.triangleList.length;
      const hasNormals = sub.normal && sub.normal.length === vertCount;
      const hasUVs = sub.texCoord0 && sub.texCoord0.length === vertCount;
      const attributes: Record<string, number> = {};

      // --- Positions: bake BSM then coord swap ---
      const posBuf = Buffer.alloc(vertCount * 12);
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < vertCount; i++) {
        const p = sub.position[i];
        let sx = p.x, sy = p.y, sz = p.z;
        if (bsmColMaj && !bsmIsIdentity) {
          [sx, sy, sz] = mc.applyBSM(p.x, p.y, p.z, bsmColMaj);
        }
        const [gx, gy, gz] = mc.slToGltfVec3(sx, sy, sz);
        posBuf.writeFloatLE(gx, i * 12);
        posBuf.writeFloatLE(gy, i * 12 + 4);
        posBuf.writeFloatLE(gz, i * 12 + 8);
        if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
        if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
        if (gz < minZ) minZ = gz; if (gz > maxZ) maxZ = gz;
      }
      bufferViews.push({ buffer: 0, byteOffset, byteLength: posBuf.length });
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: vertCount, type: 'VEC3', min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
      attributes['POSITION'] = accessors.length - 1;
      bufferParts.push(posBuf); byteOffset += posBuf.length;

      // --- Normals ---
      if (hasNormals) {
        const nrmBuf = Buffer.alloc(vertCount * 12);
        for (let i = 0; i < vertCount; i++) {
          const n = sub.normal![i];
          let nx = n.x, ny = n.y, nz = n.z;
          if (bsmInvT3x3) [nx, ny, nz] = mc.applyBSMNormal(n.x, n.y, n.z, bsmInvT3x3);
          const [gx, gy, gz] = mc.slToGltfVec3(nx, ny, nz);
          nrmBuf.writeFloatLE(gx, i * 12); nrmBuf.writeFloatLE(gy, i * 12 + 4); nrmBuf.writeFloatLE(gz, i * 12 + 8);
        }
        bufferViews.push({ buffer: 0, byteOffset, byteLength: nrmBuf.length });
        accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: vertCount, type: 'VEC3' });
        attributes['NORMAL'] = accessors.length - 1;
        bufferParts.push(nrmBuf); byteOffset += nrmBuf.length;
      }

      // --- UVs ---
      if (hasUVs) {
        const uvBuf = Buffer.alloc(vertCount * 8);
        for (let i = 0; i < vertCount; i++) {
          const uv = sub.texCoord0![i];
          uvBuf.writeFloatLE(uv.x, i * 8); uvBuf.writeFloatLE(1.0 - uv.y, i * 8 + 4);
        }
        bufferViews.push({ buffer: 0, byteOffset, byteLength: uvBuf.length });
        accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: vertCount, type: 'VEC2' });
        attributes['TEXCOORD_0'] = accessors.length - 1;
        bufferParts.push(uvBuf); byteOffset += uvBuf.length;
      }

      // --- Joints & Weights ---
      if (isRigged && sub.weights && sub.weights.length === vertCount) {
        const jointsBuf = Buffer.alloc(vertCount * 4);
        const weightsBuf = Buffer.alloc(vertCount * 16);
        for (let v = 0; v < vertCount; v++) {
          const w = sub.weights![v];
          const entries = Object.entries(w);
          let totalRaw = 0;
          for (const [, raw] of entries) totalRaw += raw as number;
          for (let slot = 0; slot < 4; slot++) {
            if (slot < entries.length) {
              const [ji, raw] = entries[slot];
              const sharedIdx = jointRemapTable[parseInt(ji, 10)] ?? 0;
              jointsBuf.writeUInt8(Math.min(sharedIdx, 255), v * 4 + slot);
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
        bufferParts.push(jointsBuf); byteOffset += jointsBuf.length;
        bufferViews.push({ buffer: 0, byteOffset, byteLength: weightsBuf.length });
        accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: vertCount, type: 'VEC4' });
        attributes['WEIGHTS_0'] = accessors.length - 1;
        bufferParts.push(weightsBuf); byteOffset += weightsBuf.length;
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
      accessors.push({ bufferView: bufferViews.length - 1, componentType: useUint32 ? 5125 : 5123, count: idxCount, type: 'SCALAR' });
      bufferParts.push(idxAligned); byteOffset += idxAligned.length;

      // Material
      const faceTexture = wm.faceTextures[subIdx];
      let materialIdx = fallbackMatIdx;
      if (faceTexture && faceTexture.textureId !== ZERO_UUID && textureIdxMap.has(faceTexture.textureId)) {
        materialIdx = textureIdxMap.get(faceTexture.textureId)!;
      }
      primitives.push({ attributes, indices: accessors.length - 1, material: materialIdx, mode: 4 });
    }

    if (primitives.length === 0) continue;

    const meshIdx = meshDefs.length;
    meshDefs.push({ name: wm.name, primitives });

    // Build per-mesh skin with this mesh's own rawIBMs
    let skinIdx: number | undefined;
    if (isRigged && skin) {
      const resolvedNames = skin.jointNames.map((n: string) => mc.resolveJointName(n));
      const meshIBMs: number[][] = [];
      for (const jname of skeleton.jointList) {
        const fixup = skeleton.fixupMatrices.get(jname) || [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
        const jIdx = resolvedNames.indexOf(jname);
        if (jIdx >= 0 && jIdx < skin.inverseBindMatrix.length) {
          // fixup @ rawIBM — matches mesh-converter.ts exactly
          const rawIBM = skin.inverseBindMatrix[jIdx].all();
          meshIBMs.push(mc.slToGltfMatrix(mc.mat4Mul(fixup, rawIBM)));
        } else {
          // Joint not in this mesh — use skeleton-derived fallback
          meshIBMs.push(fallbackIBMs.get(jname) || [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
        }
      }
      const ibmBuf = Buffer.alloc(skeleton.jointList.length * 64);
      for (let i = 0; i < skeleton.jointList.length; i++) {
        for (let j = 0; j < 16; j++) ibmBuf.writeFloatLE(meshIBMs[i][j], (i * 16 + j) * 4);
      }

      bufferViews.push({ buffer: 0, byteOffset, byteLength: ibmBuf.length });
      const ibmAccIdx = accessors.length;
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: skeleton.jointList.length, type: 'MAT4' });
      bufferParts.push(ibmBuf); byteOffset += ibmBuf.length;

      skinIdx = skinDefs.length;
      skinDefs.push({ name: wm.name, inverseBindMatrices: ibmAccIdx, joints: skinJointIndices, skeleton: skeleton.armatureIdx });
    }

    const meshNodeIdx = nodes.length;
    const meshNode: any = { name: wm.name, mesh: meshIdx };
    if (skinIdx !== undefined) {
      meshNode.skin = skinIdx;
      nodes.push(meshNode);
      sceneNodes.push(meshNodeIdx);
    } else {
      // Unrigged attachment — parent to attachment point bone with object transform
      const AP_NAMES: Record<number, string> = {
        1:'Chest', 2:'Skull', 3:'Left Shoulder', 4:'Right Shoulder', 5:'Left Hand',
        6:'Right Hand', 7:'Left Foot', 8:'Right Foot', 9:'Spine', 10:'Pelvis',
        11:'Mouth', 12:'Chin', 13:'Left Ear', 14:'Right Ear', 15:'Left Eyeball',
        16:'Right Eyeball', 17:'Nose', 18:'R Upper Arm', 19:'R Forearm',
        20:'L Upper Arm', 21:'L Forearm', 22:'Right Hip', 23:'R Upper Leg',
        24:'R Lower Leg', 25:'Left Hip', 26:'L Upper Leg', 27:'L Lower Leg',
        28:'Stomach', 29:'Left Pec', 30:'Right Pec', 39:'Neck', 40:'Root',
      };
      const apName = AP_NAMES[wm.attachmentPoint];
      const attachPoints = mc.getAttachmentPoints();
      const parentBone = apName ? attachPoints.get(apName) : null;
      const parentNodeIdx = parentBone && skeleton.jointNodeIdx.has(parentBone)
        ? skeleton.jointNodeIdx.get(parentBone)! : skeleton.armatureIdx;

      // Build transform from object position/rotation/scale (SL coords → glTF)
      if (wm.objPosition || wm.objRotation || wm.objScale) {
        const p = wm.objPosition || [0, 0, 0];
        const q = wm.objRotation || [0, 0, 0, 1];
        const s = wm.objScale || [1, 1, 1];
        const slMat = mc.composeTRS(
          s as [number, number, number],
          q as [number, number, number, number],
          p as [number, number, number],
        );
        meshNode.matrix = mc.slToGltfMatrix(slMat);
      }
      nodes.push(meshNode);
      // Parent to bone node instead of scene root
      (nodes[parentNodeIdx].children as number[]).push(meshNodeIdx);
    }
  }

  // --- Embed texture images ---
  for (const img of images) {
    const texBuf: Buffer = img._buffer;
    const texPadding = (4 - (texBuf.length % 4)) % 4;
    const texAligned = texPadding > 0 ? Buffer.concat([texBuf, Buffer.alloc(texPadding)]) : texBuf;
    img._bvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: texBuf.length });
    bufferParts.push(texAligned);
    byteOffset += texAligned.length;
  }

  // --- Assemble glTF ---
  const gltf: any = {
    asset: { version: '2.0', generator: 'PyroKitty Avatar Exporter' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes: nodes.map((n: any) => {
      const out: any = {};
      if (n.name) out.name = n.name;
      if (n.mesh !== undefined) out.mesh = n.mesh;
      if (n.skin !== undefined) out.skin = n.skin;
      if (n.matrix) out.matrix = n.matrix;
      if (n.children && n.children.length > 0) out.children = n.children;
      return out;
    }),
    meshes: meshDefs,
    skins: skinDefs,
    accessors,
    bufferViews: bufferViews.map((bv: any) => ({ buffer: bv.buffer, byteOffset: bv.byteOffset, byteLength: bv.byteLength })),
    buffers: [{ byteLength: byteOffset }],
  };

  if (materials.length > 0) gltf.materials = materials;
  if (glTextures.length > 0) {
    gltf.textures = glTextures;
    gltf.samplers = samplers;
    gltf.images = images.map((img: any) => ({ bufferView: img._bvIdx, mimeType: img.mimeType }));
  }

  // --- Encode GLB ---
  const jsonStr = JSON.stringify(gltf);
  const jsonPad = (4 - (jsonStr.length % 4)) % 4;
  const jsonBuf = Buffer.from(jsonStr + ' '.repeat(jsonPad), 'utf8');
  const binBuf = Buffer.concat(bufferParts);
  const binPad = (4 - (binBuf.length % 4)) % 4;
  const binAligned = binPad > 0 ? Buffer.concat([binBuf, Buffer.alloc(binPad)]) : binBuf;
  const totalLength = 12 + 8 + jsonBuf.length + 8 + binAligned.length;
  const glb = Buffer.alloc(totalLength);
  let off = 0;
  glb.writeUInt32LE(0x46546C67, off); off += 4;
  glb.writeUInt32LE(2, off); off += 4;
  glb.writeUInt32LE(totalLength, off); off += 4;
  glb.writeUInt32LE(jsonBuf.length, off); off += 4;
  glb.writeUInt32LE(0x4E4F534A, off); off += 4;
  jsonBuf.copy(glb, off); off += jsonBuf.length;
  glb.writeUInt32LE(binAligned.length, off); off += 4;
  glb.writeUInt32LE(0x004E4942, off); off += 4;
  binAligned.copy(glb, off);
  return glb;
}
