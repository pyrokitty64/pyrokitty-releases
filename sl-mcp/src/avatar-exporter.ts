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
import type { Bot } from '../../electron-ui/node-metaverse/lib/index.js';
import { AssetType } from '../../electron-ui/node-metaverse/lib/enums/AssetType.js';
import { SculptType } from '../../electron-ui/node-metaverse/lib/enums/SculptType.js';
import { LLMesh } from '../../electron-ui/node-metaverse/lib/classes/public/LLMesh.js';
import { TextureEntry } from '../../electron-ui/node-metaverse/lib/classes/TextureEntry.js';

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
  /** Pre-composed bone-relative transform (SL space, column-major 4x4).
   *  For root prims: TRS from object's pos/rot/scale (attachment-bone-relative).
   *  For linkset children: rootTRS * childTRS (composed to bone-relative). */
  objMatrix?: number[];
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
  /** Full SL-space world transform for each joint (chain of full local matrices) */
  worldTransformsSL: Map<string, number[]>;
  /** Translation-only SL-space world transform (matching what node hierarchy gives, WITH shape) */
  transWorldSL: Map<string, number[]>;
}

export interface ExportOptions {
  avatarId?: string;
  outputPath?: string;
  includeTextures?: boolean;
}

const LOD_PREFERENCE = ['high_lod', 'medium_lod', 'low_lod', 'lowest_lod'];
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Attachment point number → name in avatar_lad_attachments.json */
const AP_NAMES: Record<number, string> = {
  1:'Chest', 2:'Skull', 3:'Left Shoulder', 4:'Right Shoulder', 5:'Left Hand',
  6:'Right Hand', 7:'Left Foot', 8:'Right Foot', 9:'Spine', 10:'Pelvis',
  11:'Mouth', 12:'Chin', 13:'Left Ear', 14:'Right Ear', 15:'Left Eyeball',
  16:'Right Eyeball', 17:'Nose', 18:'R Upper Arm', 19:'R Forearm',
  20:'L Upper Arm', 21:'L Forearm', 22:'Right Hip', 23:'R Upper Leg',
  24:'R Lower Leg', 25:'Left Hip', 26:'L Upper Leg', 27:'L Lower Leg',
  28:'Stomach', 29:'Left Pec', 30:'Right Pec',
  // 31-38 are HUDs — skipped in export
  39:'Neck', 40:'Avatar Center',
  // Bento attachment points
  41:'Left Ring Finger', 42:'Right Ring Finger',
  43:'Tail Base', 44:'Tail Tip',
  45:'Left Wing', 46:'Right Wing',
  47:'Jaw', 48:'Alt Left Ear', 49:'Alt Right Ear',
  50:'Alt Left Eye', 51:'Alt Right Eye', 52:'Tongue',
  53:'Groin', 54:'Left Hind Foot', 55:'Right Hind Foot',
};

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

  const avatarName = `${avatar.getFirstName()}_${avatar.getLastName()}`;
  const outputPath = opts.outputPath || `${EXPORTS_DIR}/avatar_${avatarName}.glb`;

  const lines: string[] = [];
  lines.push(`Exporting avatar: ${avatar.getName()} (${avatarId})`);

  // --- Wait for sim to stream attachment objects ---
  // The sim sends attachment data progressively after login. Poll until the
  // child count stabilizes (no change for STABLE_CHECKS consecutive polls).
  const POLL_MS = 500;
  const STABLE_CHECKS = 3;  // 1.5s of no change
  const MAX_WAIT_MS = 15000;
  let avatarLocalID: number | undefined;
  try {
    avatarLocalID = bot.currentRegion.objects.getObjectByUUID(avatarId).ID;
  } catch {
    const store = bot.currentRegion.objects as any;
    const allObjs = store.objects as Map<number, any> | undefined;
    if (allObjs) {
      for (const [lid, obj] of allObjs) {
        if (obj.FullID?.toString() === avatarId) { avatarLocalID = lid; break; }
      }
    }
  }
  if (avatarLocalID !== undefined) {
    let lastCount = bot.currentRegion.objects.getObjectsByParent(avatarLocalID).length;
    let stableRuns = lastCount > 0 ? 1 : 0;
    const deadline = Date.now() + MAX_WAIT_MS;
    while (stableRuns < STABLE_CHECKS && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const count = bot.currentRegion.objects.getObjectsByParent(avatarLocalID!).length;
      if (count === lastCount && count > 0) {
        stableRuns++;
      } else {
        stableRuns = count > 0 ? 1 : 0;
        lastCount = count;
      }
    }
    if (lastCount === 0) {
      lines.push(`No attachment objects received after ${(MAX_WAIT_MS / 1000).toFixed(0)}s`);
    } else {
      lines.push(`${lastCount} attachment roots (stable after ${STABLE_CHECKS} checks)`);
    }
  }

  // --- Phase A: Gather worn mesh data ---
  const bakedUuids = botManager.getBakedTextures(avatarId);
  const wornMeshes = await gatherWornMeshes(bot, avatar, avatarId, lines, bakedUuids, avatarLocalID);
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
  // --- Gather structural animation positions ---
  // Animations with a single position key, no rotation keys, and duration ≤ 0
  // are purely structural (e.g. fox muzzle shaping). Bake their positions into
  // the skeleton rest pose. Higher priority wins per bone.
  const animPositions = new Map<string, { pos: [number, number, number]; priority: number }>();
  const playingAnims = botManager.getPlayingAnimations(avatarId);
  if (playingAnims && playingAnims.length > 0) {
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cacheDir = join(process.env.APPDATA || '', 'pyrokitty-ui', 'asset-cache', 'animations');
    let bakedCount = 0;
    for (const animUuid of playingAnims) {
      const animPath = join(cacheDir, `${animUuid}.json`);
      if (!existsSync(animPath)) continue;
      try {
        const anim = JSON.parse(readFileSync(animPath, 'utf8'));
        const duration: number = anim.duration ?? 1;
        const priority: number = anim.priority ?? 0;
        if (duration > 0) continue; // time-varying animation, skip
        for (const joint of (anim.joints || [])) {
          const jname: string = mc.resolveJointName(joint.name || '');
          const posKeys: any[] = joint.positionKeys || [];
          const rotKeys: any[] = joint.rotationKeys || [];
          // Structural: exactly 1 position key, and either no rotation keys
          // or a single identity rotation (0,0,0)
          if (posKeys.length !== 1) continue;
          if (rotKeys.length > 1) continue;
          if (rotKeys.length === 1) {
            const rv = rotKeys[0].value;
            if (rv && (Math.abs(rv[0]) > 0.001 || Math.abs(rv[1]) > 0.001 || Math.abs(rv[2]) > 0.001)) continue;
          }
          const existing = animPositions.get(jname);
          if (existing && existing.priority >= priority) continue; // higher priority already set
          const v = posKeys[0].value;
          if (v && v.length >= 3) {
            animPositions.set(jname, { pos: [v[0], v[1], v[2]], priority });
            bakedCount++;
          }
        }
      } catch { /* skip unparseable */ }
    }
    if (bakedCount > 0) {
      lines.push(`Baked ${animPositions.size} structural animation positions from ${playingAnims.length} animations`);
    }
  }

  const skeleton = buildSharedSkeleton(wornMeshes, lines, shapeDeltas, animPositions);
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

async function gatherWornMeshes(bot: Bot, avatar: any, avatarId: string, lines: string[], bakedUuids?: string[] | null, avatarLocalID?: number): Promise<WornMesh[]> {
  const wornMeshes: WornMesh[] = [];
  const seenLocalIds = new Set<number>(); // dedup by object local ID, not mesh UUID

  // Use pre-resolved local ID, or fall back to getAttachments()
  if (avatarLocalID === undefined) {
    lines.push(`  WARN: avatar game object not in object store — using getAttachments() fallback`);
  }

  // Collect root prims (attachment roots) — either from object store or avatar API
  interface RootInfo { obj: any; ap: number; }
  const rootPrims: RootInfo[] = [];

  if (avatarLocalID !== undefined) {
    const children = bot.currentRegion.objects.getObjectsByParent(avatarLocalID);
    for (const child of children) {
      const ap = child.attachmentPoint ?? 0;
      const isAttach = child.IsAttachment ?? false;
      if (ap === 0 && !isAttach) continue; // not an attachment
      rootPrims.push({ obj: child, ap });
    }
    lines.push(`Found ${rootPrims.length} attachment roots via object store`);
  } else {
    // Fallback to avatar.getAttachments()
    const attachments = avatar.getAttachments();
    for (const [_itemId, obj] of attachments) {
      rootPrims.push({ obj, ap: obj.attachmentPoint ?? 0 });
    }
    lines.push(`Found ${rootPrims.length} attachment roots via getAttachments() fallback`);
  }

  for (const { obj: rootObj, ap } of rootPrims) {
    // Skip HUD attachments (points 31-38)
    if (ap >= 31 && ap <= 38) continue;

    // Root prim's TRS (bone-relative for attachments)
    const rootPos = rootObj.Position;
    const rootRot = rootObj.Rotation;
    const rootScl = rootObj.Scale;
    const rootMatrix = (rootPos && rootRot && rootScl)
      ? mc.composeTRS(
          [rootScl.x, rootScl.y, rootScl.z],
          [rootRot.x, rootRot.y, rootRot.z, rootRot.w],
          [rootPos.x, rootPos.y, rootPos.z],
        )
      : undefined;

    // Build list: root + linkset children, each with bone-relative matrix
    interface CheckEntry { obj: any; boneMatrix?: number[]; }
    const objectsToCheck: CheckEntry[] = [{ obj: rootObj, boneMatrix: rootMatrix }];

    // Get linkset children — their Position is root-prim-relative
    try {
      const children = bot.currentRegion.objects.getObjectsByParent(rootObj.ID);
      if (children) {
        for (const child of children) {
          const cPos = child.Position;
          const cRot = child.Rotation;
          const cScl = child.Scale;
          let boneMatrix: number[] | undefined;
          if (rootMatrix && cPos && cRot && cScl) {
            const childLocal = mc.composeTRS(
              [cScl.x, cScl.y, cScl.z],
              [cRot.x, cRot.y, cRot.z, cRot.w],
              [cPos.x, cPos.y, cPos.z],
            );
            boneMatrix = mc.mat4Mul(rootMatrix, childLocal);
          }
          objectsToCheck.push({ obj: child, boneMatrix });
        }
      }
    } catch { /* no children */ }

    for (const { obj: checkObj, boneMatrix } of objectsToCheck) {
      const md = checkObj.extraParams?.meshData;
      if (!md || md.type !== SculptType.Mesh) continue;

      const meshUuid = md.meshData?.toString();
      if (!meshUuid || meshUuid === ZERO_UUID) continue;

      // Dedup by local ID — allows same mesh asset on multiple objects (e.g. left/right earring)
      const localId: number = checkObj.ID ?? 0;
      if (seenLocalIds.has(localId)) continue;
      seenLocalIds.add(localId);

      try {
        const meshBuf = await bot.clientCommands.asset.downloadAsset(AssetType.Mesh, meshUuid);
        if (!meshBuf || meshBuf.length === 0) {
          lines.push(`  SKIP: empty mesh ${meshUuid}`);
          continue;
        }
        const llMesh = await LLMesh.from(meshBuf);

        // Extract texture info from TextureEntry
        const faceTextures = extractFaceTextures(checkObj, bakedUuids);

        const name = (checkObj as any).name || `mesh_${meshUuid.slice(0, 8)}`;
        const skinData = llMesh.skin;
        const rigged = !!(skinData && skinData.jointNames && skinData.jointNames.length > 0);
        wornMeshes.push({
          meshUuid,
          llMesh,
          name,
          attachmentPoint: ap,
          textureEntry: null,
          faceTextures,
          isRigged: rigged,
          objMatrix: boneMatrix,
        });
        const ftSummary = faceTextures.slice(0, 4).map((ft, i) =>
          `f${i}=${ft.textureId === ZERO_UUID ? '0' : ft.textureId.slice(0, 8)}`
        ).join(' ');
        lines.push(`  OK: ${name} (${meshUuid.slice(0, 8)}...) ap=${ap} ${rigged ? 'rigged' : 'unrigged'} — ${countVerts(llMesh)} verts [${ftSummary}]`);
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
        const c = face.rgba;
        faces.push({
          textureId: texId,
          color: [
            c ? c.getRed() : 1,
            c ? c.getGreen() : 1,
            c ? c.getBlue() : 1,
            c ? c.getAlpha() : 1,
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
  lines: string[],
  shapeDeltas: Record<string, { scale: [number, number, number]; offset: [number, number, number] }> | null,
  animPositions?: Map<string, { pos: [number, number, number]; priority: number }>,
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
  const allRiggedMeshes = [...wornMeshes]
    .filter(wm => wm.llMesh.skin?.jointNames?.length)
    .sort((a, b) => a.meshUuid.localeCompare(b.meshUuid));

  // Explicit overrides from altInverseBindMatrix
  for (const wm of allRiggedMeshes) {
    const skin = wm.llMesh.skin!;
    if (!skin.altInverseBindMatrix?.length) continue;
    const resolvedNames = skin.jointNames.map((n: string) => mc.resolveJointName(n));
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
  lines.push(`  Joint overrides: ${jointOverrides.size} from altIBM`);

  // --- Collect raw IBMs for CV bone fixup ---
  // CV bones may have rotation/scale in their raw IBM that differs from XML defaults.
  // We need the raw IBM to derive the actual bind-pose transform so the fixup matrix
  // exactly cancels the IBM. Only use IBMs from meshes with identity BSM (non-identity
  // BSM taints the raw IBM: inverse(rawIBM) = BSM * jointWorld, not jointWorld).
  const rawIBMByName = new Map<string, number[]>();
  for (const wm of allRiggedMeshes) {
    const skin = wm.llMesh.skin!;
    if (!skin.inverseBindMatrix?.length) continue;
    // Check BSM is identity
    const bsmAll = skin.bindShapeMatrix?.all();
    const bsmIsIdentity = !bsmAll || bsmAll.every(
      (v: number, i: number) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6
    );
    if (!bsmIsIdentity) continue;
    const resolvedNames = skin.jointNames.map((n: string) => mc.resolveJointName(n));
    for (let i = 0; i < resolvedNames.length && i < skin.inverseBindMatrix.length; i++) {
      const jname = resolvedNames[i];
      if (!rawIBMByName.has(jname)) {
        rawIBMByName.set(jname, skin.inverseBindMatrix[i].all());
      }
    }
  }

  // Helper: world position of a bone via translation-only parent chain (SL space).
  // Standard bones have identity rotation & unit scale so world = sum of positions.
  const worldPosCache = new Map<string, [number, number, number]>();
  const getWorldPos = (name: string): [number, number, number] => {
    const cached = worldPosCache.get(name);
    if (cached) return cached;
    const sj = skeletonXml.get(name);
    if (!sj) return [0, 0, 0];
    const pos = jointOverrides.get(name) || sj.pos;
    if (!sj.parent) {
      worldPosCache.set(name, pos);
      return pos;
    }
    const pw = getWorldPos(sj.parent);
    const wp: [number, number, number] = [pw[0] + pos[0], pw[1] + pos[1], pw[2] + pos[2]];
    worldPosCache.set(name, wp);
    return wp;
  };

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

    // Compute joint's local TRS matrix.
    // Structural animation positions are the authoritative source for face bones
    // on furry/non-human avatars. When present, they replace altIBM overrides AND
    // shape deltas for that bone (the animation encodes the full intended offset
    // from XML default; overrides and shape would double-count).
    const hasAnimPos = animPositions && animPositions.has(name);
    let pos: [number, number, number];
    if (hasAnimPos) {
      // Animation: XML default + animation offset only (no override, no shape)
      const ap = animPositions!.get(name)!;
      pos = [sj.pos[0] + ap.pos[0], sj.pos[1] + ap.pos[1], sj.pos[2] + ap.pos[2]];
    } else {
      // Normal: override (or XML default) + shape delta
      pos = jointOverrides.get(name) || [...sj.pos] as [number, number, number];
      if (shapeDeltas && shapeDeltas[name]) {
        const delta = shapeDeltas[name];
        pos = [pos[0] + delta.offset[0], pos[1] + delta.offset[1], pos[2] + delta.offset[2]];
      }
    }
    let jMat = mc.composeMatrix(
      sj.scale,
      [sj.rot[0] * mc.DEG_TO_RAD, sj.rot[1] * mc.DEG_TO_RAD, sj.rot[2] * mc.DEG_TO_RAD],
      pos,
    );

    // CV bone fixup: collision volume bones may have rotation/scale in their raw IBM
    // that differs from XML defaults (content creator's actual bind pose). Derive the
    // local transform from inverse(rawIBM) so the fixup exactly cancels the IBM.
    // CVs are always leaf nodes so this doesn't affect any other bone.
    if (sj.isCollisionVolume && !jointOverrides.has(name) && rawIBMByName.has(name)) {
      const rawIBM = rawIBMByName.get(name)!;
      const worldXf = mc.mat4Inverse(rawIBM);
      if (worldXf) {
        const parentName = sj.parent;
        const pw = parentName ? getWorldPos(parentName) : [0, 0, 0] as [number, number, number];
        const invParent = mc.mat4FromTranslation(-pw[0], -pw[1], -pw[2]);
        jMat = mc.mat4Mul(invParent, worldXf);
      }
    }

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
  for (const jname of orderedJoints) getWorld(jname);

  // --- Compute translation-only world transforms (matches what GLB node chain gives) ---
  // This includes shape deltas (used for node positions and unrigged attachment correction).
  const transWorldSL = new Map<string, number[]>();
  const getTransWorld = (name: string): number[] => {
    const cached = transWorldSL.get(name);
    if (cached) return cached;
    const sj = skeletonXml.get(name);
    const local = localMatrices.get(name);
    if (!local) { const id = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]; transWorldSL.set(name, id); return id; }
    // Translation from the full local matrix (same position used in blenderFixJoint)
    const localTrans = mc.mat4FromTranslation(local[12], local[13], local[14]);
    if (!sj?.parent || !transWorldSL.has(sj.parent) && !localMatrices.has(sj.parent)) {
      transWorldSL.set(name, localTrans);
      return localTrans;
    }
    const pw = getTransWorld(sj.parent);
    const w = mc.mat4Mul(pw, localTrans);
    transWorldSL.set(name, w);
    return w;
  };
  for (const jname of orderedJoints) getTransWorld(jname);

  return {
    jointList: orderedJoints,
    nodes,
    jointNodeIdx,
    fixupMatrices,
    armatureIdx,
    worldTransformsSL: worldTransforms,
    transWorldSL,
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
  // Map texture UUID → glTF texture index (not material — materials are per-face now)
  const texIdxMap = new Map<string, number>();

  for (const [uuid, texData] of textures) {
    const imageIdx = images.length;
    images.push({ mimeType: texData.mimeType, _buffer: texData.buffer, _bvIdx: -1 });
    glTextures.push({ sampler: 0, source: imageIdx });
    texIdxMap.set(uuid, glTextures.length - 1);
  }

  // Per-face material cache: keyed by "texUuid|r|g|b|a" to dedup identical combos
  const matCache = new Map<string, number>();
  const getOrCreateMaterial = (
    texUuid: string | null,
    color: [number, number, number, number],
  ): number => {
    const key = `${texUuid ?? 'none'}|${color.map(c => c.toFixed(3)).join('|')}`;
    const cached = matCache.get(key);
    if (cached !== undefined) return cached;

    const hasTexture = texUuid && texIdxMap.has(texUuid);
    const hasAlpha = color[3] < 0.999;
    const pbr: any = { metallicFactor: 0, roughnessFactor: 0.9 };
    if (hasTexture) pbr.baseColorTexture = { index: texIdxMap.get(texUuid!)! };
    // Apply face color/alpha as baseColorFactor (multiplied with texture in glTF)
    const isWhite = color[0] > 0.999 && color[1] > 0.999 && color[2] > 0.999 && !hasAlpha;
    if (!isWhite) pbr.baseColorFactor = [color[0], color[1], color[2], color[3]];
    const mat: any = { pbrMetallicRoughness: pbr };
    if (hasAlpha) {
      mat.alphaMode = 'BLEND';
    } else if (hasTexture) {
      mat.alphaMode = 'MASK';
      mat.alphaCutoff = 0.5;
    } else {
      mat.alphaMode = 'OPAQUE';
    }
    const idx = materials.length;
    materials.push(mat);
    matCache.set(key, idx);
    return idx;
  };
  const fallbackMatIdx = getOrCreateMaterial(null, [1, 1, 1, 1]);

  // --- Shared skin joint indices ---
  const skinJointIndices: number[] = [];
  for (const jname of skeleton.jointList) {
    skinJointIndices.push(skeleton.jointNodeIdx.get(jname) ?? skeleton.armatureIdx);
  }

  // Fallback IBMs for joints not referenced by a mesh.
  // Computed from the shared skeleton's world transforms (overrides, no shape).
  const fallbackIBMs = new Map<string, number[]>();
  for (const jname of skeleton.jointList) {
    const tw = skeleton.transWorldSL.get(jname);
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
          // Sort by weight magnitude descending so we keep the 4 most influential joints
          const entries = Object.entries(w).sort((a, b) => (b[1] as number) - (a[1] as number));
          // Normalize only the top 4 weights
          let top4Total = 0;
          for (let s = 0; s < Math.min(4, entries.length); s++) top4Total += entries[s][1] as number;
          for (let slot = 0; slot < 4; slot++) {
            if (slot < entries.length) {
              const [ji, raw] = entries[slot];
              const sharedIdx = jointRemapTable[parseInt(ji, 10)] ?? 0;
              jointsBuf.writeUInt8(Math.min(sharedIdx, 255), v * 4 + slot);
              weightsBuf.writeFloatLE(top4Total > 0 ? (raw as number) / top4Total : 0, v * 16 + slot * 4);
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

      // Material — per-face texture + color/alpha from TextureEntry
      const faceTexture = wm.faceTextures[subIdx];
      let materialIdx = fallbackMatIdx;
      if (faceTexture) {
        const texUuid = (faceTexture.textureId !== ZERO_UUID && texIdxMap.has(faceTexture.textureId))
          ? faceTexture.textureId : null;
        materialIdx = getOrCreateMaterial(texUuid, faceTexture.color);
      }
      primitives.push({ attributes, indices: accessors.length - 1, material: materialIdx, mode: 4 });
    }

    if (primitives.length === 0) continue;

    const meshIdx = meshDefs.length;
    meshDefs.push({ name: wm.name, primitives });

    // Per-joint IBM selection matching the viewer pipeline:
    // - Joints the mesh references: use fixup @ rawIBM (includes BSM effect for CVs,
    //   content creator's actual bind pose for standard bones)
    // - Joints NOT in this mesh: use fallbackIBM (skeleton-derived, matches node positions)
    //
    // This is the viewer's approach: each mesh gets its own rawIBMs, and the shared
    // skeleton's override-modified rest transforms produce the correct deformation.
    let skinIdx: number | undefined;
    if (isRigged && skin) {
      const resolvedNames = skin.jointNames.map((n: string) => mc.resolveJointName(n));
      const meshIBMs: number[][] = [];
      for (const jname of skeleton.jointList) {
        const jIdx = resolvedNames.indexOf(jname);
        if (jIdx >= 0 && jIdx < skin.inverseBindMatrix.length) {
          // This mesh references this joint — use its rawIBM
          const fixup = skeleton.fixupMatrices.get(jname) || [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
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
      // Unrigged attachment — parent to attachment point bone with object transform.
      // Bone nodes are translation-only (blenderFixJoint), so we must compensate
      // for the missing rotation/scale by pre-multiplying the bone's accumulated
      // fixup into the mesh's local transform.
      const apName = AP_NAMES[wm.attachmentPoint];
      const attachPoints = mc.getAttachmentPoints();
      const parentBone = apName ? attachPoints.get(apName) : null;
      const parentNodeIdx = parentBone && skeleton.jointNodeIdx.has(parentBone)
        ? skeleton.jointNodeIdx.get(parentBone)! : skeleton.armatureIdx;

      if (wm.objMatrix) {
        // Compute correction: bone nodes are translation-only, but the mesh
        // should be positioned relative to the bone's FULL transform.
        // correction = inv(transWorldSL(bone)) * fullWorldSL(bone)
        // meshGltf = slToGltf(correction * objMatrixSL)
        let correctedSL = wm.objMatrix;
        if (parentBone) {
          const fullWorld = skeleton.worldTransformsSL.get(parentBone);
          const transWorld = skeleton.transWorldSL.get(parentBone);
          if (fullWorld && transWorld) {
            const invTrans = mc.mat4Inverse(transWorld);
            if (invTrans) {
              const correction = mc.mat4Mul(invTrans, fullWorld);
              correctedSL = mc.mat4Mul(correction, wm.objMatrix);
            }
          }
        }
        meshNode.matrix = mc.slToGltfMatrix(correctedSL);
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
