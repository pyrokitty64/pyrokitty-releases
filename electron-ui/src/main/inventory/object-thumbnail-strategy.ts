/**
 * object-thumbnail-strategy.ts — Attaches an inventory object to HUD,
 * reads its shape/mesh/texture data from ObjectUpdate, generates GLBs,
 * renders a 3D thumbnail via the hidden Three.js window, uploads the
 * thumbnail to SL via InventoryThumbnailUpload cap, then detaches.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { Bot } from '../../../node-metaverse/lib/Bot';
import { AssetType } from '../../../node-metaverse/lib/enums/AssetType';
import { SculptType } from '../../../node-metaverse/lib/enums/SculptType';
import { AttachmentPoint } from '../../../node-metaverse/lib/enums/AttachmentPoint';
import { UUID } from '../../../node-metaverse/lib/classes/UUID';
import type { InventoryItem } from '../../../node-metaverse/lib/classes/InventoryItem';
import { primShapeToGlb, type PrimShapeParams } from '../assets/prim-converter';
import { meshCachePath, llMeshToGlb, initSkeletonData } from '../assets/mesh-converter';
import { LLMesh } from '../../../node-metaverse/lib/classes/public/LLMesh';
import { AssetCommands } from '../../../node-metaverse/lib/classes/commands/AssetCommands';
import { sculptCachePath, decodeSculptMap, buildSculptMesh, sculptMeshToGlb } from '../assets/sculpt-converter';
import { pngToJ2c, j2cToPng, j2cToRaw } from '../assets/j2k-converter';
import { renderThumbnail, type LinksetRenderData, type PrimRenderData } from '../assets/thumbnail-window';
import { pkDebug } from '../pk-debug';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

// ─── Texture download cache for thumbnails ──────────────

function thumbTexDir(): string {
  return path.join(app.getPath('userData'), 'asset-cache', 'thumb-textures');
}

async function ensureThumbTexture(uuid: string): Promise<string | null> {
  if (!uuid || uuid === ZERO_UUID) return null;

  const dir = thumbTexDir();
  const filePath = path.join(dir, `${uuid}.png`);

  try {
    await fs.promises.access(filePath);
    return filePath;
  } catch {}

  try {
    const j2cBuf = await AssetCommands.downloadTextureCDN(uuid);
    const pngBuf = await j2cToPng(j2cBuf);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, pngBuf);
    return filePath;
  } catch (err: any) {
    pkDebug('inventory', `[ObjThumb] Texture ${uuid} download failed: ${err.message}`);
    return null;
  }
}

// ─── Extract per-face texture UUIDs from a GameObject ───

function getFaceTextures(obj: any): Map<number, string> {
  const textures = new Map<number, string>();
  const te = obj.TextureEntry;
  if (!te) return textures;

  const defaultTex = te.defaultTexture?.textureID?.toString();

  // Per-face overrides
  if (te.faces) {
    for (let i = 0; i < te.faces.length; i++) {
      const face = te.faces[i];
      if (face && face.textureID) {
        const id = face.textureID.toString();
        if (id !== ZERO_UUID) textures.set(i, id);
      }
    }
  }

  // Fill remaining faces with default
  if (defaultTex && defaultTex !== ZERO_UUID) {
    for (let i = 0; i < 9; i++) {
      if (!textures.has(i)) textures.set(i, defaultTex);
    }
  }

  return textures;
}

// ─── Extract per-face RGBA colors from a GameObject ───

function getFaceColors(obj: any): Map<number, [number, number, number, number]> {
  const colors = new Map<number, [number, number, number, number]>();
  const te = obj.TextureEntry;
  if (!te) return colors;

  const defColor = te.defaultTexture?.rgba;
  const defRGBA: [number, number, number, number] | null = defColor
    ? [defColor.red, defColor.green, defColor.blue, defColor.alpha]
    : null;

  // Per-face overrides
  if (te.faces) {
    for (let i = 0; i < te.faces.length; i++) {
      const face = te.faces[i];
      if (face?.rgba) {
        colors.set(i, [face.rgba.red, face.rgba.green, face.rgba.blue, face.rgba.alpha]);
      }
    }
  }

  // Fill remaining faces with default
  if (defRGBA) {
    for (let i = 0; i < 9; i++) {
      if (!colors.has(i)) colors.set(i, defRGBA);
    }
  }

  return colors;
}

// ─── Extract shape params from a GameObject ─────────────

function getShapeParams(obj: any): PrimShapeParams {
  return {
    pathCurve: obj.PathCurve ?? 16,
    profileCurve: obj.ProfileCurve ?? 1,
    pathBegin: obj.PathBegin ?? 0,
    pathEnd: obj.PathEnd ?? 1,
    pathScaleX: obj.PathScaleX ?? 1,
    pathScaleY: obj.PathScaleY ?? 1,
    pathShearX: obj.PathShearX ?? 0,
    pathShearY: obj.PathShearY ?? 0,
    pathTwist: obj.PathTwist ?? 0,
    pathTwistBegin: obj.PathTwistBegin ?? 0,
    pathRadiusOffset: obj.PathRadiusOffset ?? 0,
    pathTaperX: obj.PathTaperX ?? 0,
    pathTaperY: obj.PathTaperY ?? 0,
    pathRevolutions: obj.PathRevolutions ?? 1,
    pathSkew: obj.PathSkew ?? 0,
    profileBegin: obj.ProfileBegin ?? 0,
    profileEnd: obj.ProfileEnd ?? 1,
    profileHollow: obj.ProfileHollow ?? 0,
  };
}

// ─── Determine geometry type and get GLB ────────────────

async function getPrimGlb(obj: any, bot: Bot): Promise<Buffer | null> {
  // Check for mesh
  const md = obj.extraParams?.meshData;
  if (md && md.type === SculptType.Mesh) {
    const meshUuid = md.meshData?.toString();
    if (!meshUuid || meshUuid === ZERO_UUID) return null;

    // Check cache first
    const cached = meshCachePath(meshUuid);
    try {
      await fs.promises.access(cached);
      return fs.promises.readFile(cached);
    } catch {}

    // Download mesh asset and convert
    try {
      const meshBuf = await bot.clientCommands.asset.downloadAsset(AssetType.Mesh, meshUuid);
      await initSkeletonData();
      const llMesh = await LLMesh.from(meshBuf);
      const glb = llMeshToGlb(llMesh);
      return glb;
    } catch (err: any) {
      pkDebug('inventory', `[ObjThumb] Failed to download/convert mesh ${meshUuid}: ${err.message}`);
      return null;
    }
  }

  // Check for sculpt
  const sd = obj.extraParams?.sculptData;
  if (sd) {
    const baseType = sd.type & 0x07;
    if (baseType >= SculptType.Sphere && baseType <= SculptType.Cylinder) {
      const textureUuid = sd.texture?.toString();
      if (!textureUuid || textureUuid === ZERO_UUID) return null;

      // Check sculpt cache
      const cached = sculptCachePath(textureUuid, sd.type);
      try {
        await fs.promises.access(cached);
        return fs.promises.readFile(cached);
      } catch {}

      // Download sculpt texture, decode, and build mesh
      try {
        const j2cBuf = await AssetCommands.downloadTextureCDN(textureUuid);
        const { pixels, width, height, channels } = await j2cToRaw(j2cBuf);
        const grid = decodeSculptMap(pixels, width, height, channels);
        const mesh = buildSculptMesh(grid, sd.type);
        const glb = sculptMeshToGlb(mesh);

        // Cache for future use
        await fs.promises.mkdir(path.dirname(cached), { recursive: true });
        await fs.promises.writeFile(cached, glb);
        pkDebug('inventory', `[ObjThumb] Sculpt ${textureUuid} decoded and cached`);
        return glb;
      } catch (err: any) {
        pkDebug('inventory', `[ObjThumb] Sculpt ${textureUuid} decode failed: ${err.message}`);
        return null;
      }
    }
  }

  // Parametric prim
  try {
    return await primShapeToGlb(getShapeParams(obj));
  } catch (err: any) {
    pkDebug('inventory', `[ObjThumb] Failed to generate prim GLB: ${err.message}`);
    return null;
  }
}

// ─── Thumbnail upload via InventoryItem.uploadThumbnail ──

async function uploadThumbnailToSL(item: InventoryItem, pngBuffer: Buffer): Promise<boolean> {
  try {
    const j2cBuffer = await pngToJ2c(pngBuffer);
    pkDebug('inventory', `[ObjThumb] Converted PNG (${pngBuffer.length}b) → J2K (${j2cBuffer.length}b)`);

    const result = await item.uploadThumbnail(j2cBuffer);
    if (!result.success) {
      pkDebug('inventory', `[ObjThumb] Upload failed: ${result.error}`);
      return false;
    }

    pkDebug('inventory', `[ObjThumb] Thumbnail uploaded, assetId=${result.assetId}`);
    return true;
  } catch (err: any) {
    pkDebug('inventory', `[ObjThumb] Upload error: ${err.message}`);
    return false;
  }
}

// ─── Main entry point ───────────────────────────────────

/**
 * Generate a 3D-rendered thumbnail for an inventory object.
 * Attaches the item to a HUD point to read its shape/mesh/texture data,
 * generates GLBs, renders via the hidden Three.js window, uploads the
 * thumbnail to SL via InventoryThumbnailUpload cap, then detaches.
 * Returns the PNG buffer on success, or null on failure.
 */
export async function generateObjectThumbnail(
  bot: Bot,
  item: InventoryItem,
): Promise<Buffer | null> {
  const itemId = item.itemID.toString();
  if (!itemId || itemId === ZERO_UUID) return null;

  // Skip if item already has a thumbnail
  const thumbId = item.thumbnailID?.toString();
  if (thumbId && thumbId !== ZERO_UUID) {
    pkDebug('inventory', `[ObjThumb] "${item.name}" already has thumbnail ${thumbId}, skipping`);
    return null;
  }

  // Check if the object is already attached (e.g. worn by the bot).
  // If so, use the in-world object directly — no need to attach/detach.
  let rootObj: any;
  let needsDetach = false;

  const objectStore = bot.currentRegion.objects;
  let alreadyAttached: any = null;
  objectStore.forEachObject((obj: any) => {
    if (obj.IsAttachment && obj.NameValue?.get('AttachItemID')?.value === itemId) {
      alreadyAttached = obj;
    }
  });

  try {
    if (alreadyAttached) {
      rootObj = alreadyAttached;
      pkDebug('inventory', `[ObjThumb] "${item.name}" already attached (localId=${rootObj.ID}), using in-world object`);
    } else {
      // Attach using the object's saved attachment point (Default = let server decide).
      pkDebug('inventory', `[ObjThumb] Attaching "${item.name}" to default point...`);
      rootObj = await item.attachToAvatar(AttachmentPoint.Default, 15000);
      needsDetach = true;
      pkDebug('inventory', `[ObjThumb] Attached "${item.name}", waiting for children...`);

      // Wait for child prims to arrive via ObjectUpdate
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Populate children from the object store (they arrive as separate ObjectUpdates with ParentID)
    if (objectStore?.populateChildren) {
      objectStore.populateChildren(rootObj);
    }
    const childCount = rootObj.children?.length ?? 0;
    const attachPoint = rootObj.attachmentPoint ?? 0;
    pkDebug('inventory', `[ObjThumb] "${item.name}": ${childCount} children, attachPoint=${attachPoint}`);

    // Render the linkset
    const png = await renderLinkset(rootObj, bot, attachPoint);

    // Detach back to inventory (only if we attached it)
    if (needsDetach) {
      try {
        await item.detachFromAvatar();
        pkDebug('inventory', `[ObjThumb] Detached "${item.name}"`);
      } catch (detachErr: any) {
        pkDebug('inventory', `[ObjThumb] Detach warning for "${item.name}": ${detachErr.message}`);
      }
    }

    if (!png) return null;

    // Upload thumbnail to SL so it persists across all viewers
    const uploaded = await uploadThumbnailToSL(item, png);
    if (uploaded) {
      pkDebug('inventory', `[ObjThumb] Thumbnail uploaded to SL for "${item.name}"`);
    }

    return png;
  } catch (err: any) {
    pkDebug('inventory', `[ObjThumb] Failed for "${item.name}": ${err.message}`);
    // Try to detach on error too (only if we attached it)
    if (needsDetach) {
      try { await item.detachFromAvatar(); } catch {}
    }
    return null;
  }
}


async function renderLinkset(rootObj: GameObject, bot: Bot, attachPoint?: number): Promise<Buffer | null> {
  // Collect all prims in the linkset: root + children
  const allPrims: { obj: any; position: number[]; rotation: number[]; scale: number[] }[] = [];

  // Root prim at origin with identity rotation. The root's actual rotation
  // is applied to the entire linksetGroup so children (in root-local space)
  // rotate with it.
  const rootScale = rootObj.Scale;
  const rootRot = rootObj.Rotation;
  allPrims.push({
    obj: rootObj,
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: rootScale ? [rootScale.x, rootScale.y, rootScale.z] : [0.5, 0.5, 0.5],
  });

  // Child prims with relative positions
  if (rootObj.children) {
    for (const child of rootObj.children) {
      const pos = child.Position;
      const rot = child.Rotation;
      const scl = child.Scale;
      allPrims.push({
        obj: child,
        position: pos ? [pos.x, pos.y, pos.z] : [0, 0, 0],
        rotation: rot ? [rot.x, rot.y, rot.z, rot.w] : [0, 0, 0, 1],
        scale: scl ? [scl.x, scl.y, scl.z] : [0.5, 0.5, 0.5],
      });
    }
  }

  // Process each prim: get GLB + textures (concurrently)
  const primDataPromises = allPrims.map(async (prim): Promise<PrimRenderData | null> => {
    const glb = await getPrimGlb(prim.obj, bot);
    if (!glb) return null;

    // Collect face textures and colors
    const faceTextures = getFaceTextures(prim.obj);
    const faceColors = getFaceColors(prim.obj);
    const textureMap: Record<number, string> = {};
    const colorMap: Record<number, [number, number, number, number]> = {};
    const objName = prim.obj.name || prim.obj.FullID?.toString()?.slice(0, 8) || '?';

    // Download textures in parallel (limit to 6 concurrent)
    const entries = Array.from(faceTextures.entries());
    pkDebug('inventory', `[ObjThumb] ${objName}: ${entries.length} face textures to fetch`);
    for (let i = 0; i < entries.length; i += 6) {
      const batch = entries.slice(i, i + 6);
      const results = await Promise.all(
        batch.map(async ([faceIdx, texUuid]) => {
          const texPath = await ensureThumbTexture(texUuid);
          if (!texPath) pkDebug('inventory', `[ObjThumb] ${objName} face ${faceIdx}: texture ${texUuid} fetch failed`);
          return { faceIdx, texPath };
        })
      );
      for (const { faceIdx, texPath } of results) {
        if (texPath) textureMap[faceIdx] = texPath;
      }
    }

    // Populate color map
    for (const [faceIdx, rgba] of faceColors) {
      colorMap[faceIdx] = rgba;
    }

    return {
      glb: new Uint8Array(glb),
      position: prim.position as [number, number, number],
      rotation: prim.rotation as [number, number, number, number],
      scale: prim.scale as [number, number, number],
      textures: textureMap,
      colors: colorMap,
    };
  });

  const primResults = await Promise.all(primDataPromises);
  const prims = primResults.filter((p): p is PrimRenderData => p !== null);

  if (prims.length === 0) return null;

  const linksetData: LinksetRenderData = {
    prims,
    attachmentPoint: attachPoint,
    rootRotation: rootRot ? [rootRot.x, rootRot.y, rootRot.z, rootRot.w] : undefined,
  };

  try {
    return await renderThumbnail(linksetData);
  } catch (err: any) {
    pkDebug('inventory', `[ObjThumb] Render failed: ${err.message}`);
    return null;
  }
}
