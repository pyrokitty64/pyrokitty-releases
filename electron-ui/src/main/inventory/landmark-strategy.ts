/**
 * Landmark inventory strategy.
 *
 * Downloads a landmark asset, resolves the region name and grid coordinates,
 * fetches a parcel snapshot (or map tile crop as fallback), and renders a
 * Monopoly-style inventory card PNG with embedded metadata.
 *
 * The resulting PNG is the landmark's file representation on disk.
 */

import sharp from 'sharp';
import { renderInventoryCard, type CardMetadata } from './inventory-card';
import type { Bot } from '../../../node-metaverse/lib/Bot';
import { AssetType } from '../../../node-metaverse/lib/enums/AssetType';
import { UUID as NMUUID } from '../../../node-metaverse/lib/classes/UUID';

// ── Landmark parsing ────────────────────────────────────────────────────────

export interface ParsedLandmark {
  regionId: string;
  localX: number;
  localY: number;
  localZ: number;
}

export function parseLandmarkAsset(data: Buffer): ParsedLandmark | null {
  const text = data.toString('utf-8');
  const regionMatch = text.match(/region_id\s+([\da-f-]+)/);
  const posMatch = text.match(/local_pos\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)/);
  if (!regionMatch) return null;
  return {
    regionId: regionMatch[1],
    localX: posMatch ? parseFloat(posMatch[1]) : 128,
    localY: posMatch ? parseFloat(posMatch[2]) : 128,
    localZ: posMatch ? parseFloat(posMatch[3]) : 0,
  };
}

// ── Constants ──────────────────────────────────────────────────────────────

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const SL_MAP_BASE = 'https://map.secondlife.com/map';
const BONNIEBOTS_BASE = 'https://www.bonniebots.com/static-api/regions';
const PICTURE_SERVICE = 'https://picture-service.secondlife.com';

// ── Region resolution ──────────────────────────────────────────────────────

const regionCache = new Map<string, { gridX: number; gridY: number }>();

async function resolveGridCoords(bot: Bot, regionId: string): Promise<{ gridX: number; gridY: number }> {
  const cached = regionCache.get(regionId);
  if (cached) return cached;

  const handle = await bot.clientCommands.region.getRegionHandle(new NMUUID(regionId));
  const gridX = Math.floor((handle.high >>> 0) / 256);
  const gridY = Math.floor((handle.low >>> 0) / 256);

  const entry = { gridX, gridY };
  regionCache.set(regionId, entry);
  return entry;
}

// ── Content image fetching ──────────────────────────────────────────────────

/** Fetch an image from picture-service by texture UUID. */
async function fetchFromPictureService(uuid: string): Promise<Buffer | null> {
  if (!uuid || uuid === ZERO_UUID) return null;
  const resp = await fetch(`${PICTURE_SERVICE}/${uuid}/320x240.jpg`);
  if (!resp.ok) return null;
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Fetch the best available content image for a landmark.
 * 1. RemoteParcelRequest → exact parcel snapshot via picture-service
 * 2. bonniebots region_map_image via picture-service
 * 3. SL map tile crop (last resort)
 */
async function fetchContentImage(
  bot: Bot,
  landmark: ParsedLandmark,
  gridX: number,
  gridY: number,
  snapshotId?: string,
): Promise<Buffer | null> {
  // 1. Exact parcel snapshot (from RemoteParcelRequest, passed in)
  try {
    const img = await fetchFromPictureService(snapshotId ?? '');
    if (img) return img;
  } catch { /* fall through */ }

  // 2. Region map image via bonniebots index.json → picture-service
  try {
    const resp = await fetch(`${BONNIEBOTS_BASE}/${gridX}/${gridY}/index.json`);
    if (resp.ok) {
      const info = await resp.json();
      if (info?.region_map_image && info.region_map_image !== ZERO_UUID) {
        const img = await fetchFromPictureService(info.region_map_image);
        if (img) return img;
      }
    }
  } catch { /* fall through */ }

  // 3. SL map tile crop (last resort)
  try {
    const tileUrl = `${SL_MAP_BASE}-1-${gridX}-${gridY}-objects.jpg`;
    const response = await fetch(tileUrl);
    if (!response.ok) return null;

    const tileBuf = Buffer.from(await response.arrayBuffer());
    const tileSize = 256;
    const cropSize = 96;
    const half = cropSize / 2;

    const cx = Math.min(Math.max(Math.floor(landmark.localX), half), tileSize - half);
    const cy = Math.min(Math.max(Math.floor(tileSize - landmark.localY), half), tileSize - half);

    return await sharp(tileBuf)
      .extract({ left: cx - half, top: cy - half, width: cropSize, height: cropSize })
      .resize(456, 336, { fit: 'cover' })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface LandmarkCardResult {
  png: Buffer;
  metadata: CardMetadata;
  regionName?: string;
  gridX: number;
  gridY: number;
}

/**
 * Build a Monopoly-style landmark card from an inventory item.
 *
 * @param bot - The logged-in Bot instance
 * @param itemName - Inventory item display name
 * @param itemId - Inventory item UUID
 * @param assetId - Landmark asset UUID
 * @param permissions - Item permissions
 */
export async function buildLandmarkCard(
  bot: Bot,
  itemName: string,
  itemId: string,
  assetId: string,
  permissions?: { copy?: boolean; modify?: boolean; transfer?: boolean },
  thumbnail?: Buffer | null,
): Promise<LandmarkCardResult> {
  // 1. Download and parse the landmark asset
  const assetData = await bot.clientCommands.asset.downloadAsset(
    AssetType.Landmark,
    new NMUUID(assetId),
  );
  const parsed = parseLandmarkAsset(assetData);
  if (!parsed) throw new Error(`Failed to parse landmark asset ${assetId}`);

  // 2. Resolve grid coordinates + exact parcel info via RemoteParcelRequest
  const grid = await resolveGridCoords(bot, parsed.regionId);

  let regionName: string | undefined;
  let snapshotId: string | undefined;
  try {
    const parcelInfo = await bot.clientCommands.parcel.getRemoteParcelInfo({
      regionId: parsed.regionId,
      x: parsed.localX,
      y: parsed.localY,
      z: parsed.localZ,
    });
    regionName = parcelInfo.RegionName || undefined;
    snapshotId = parcelInfo.SnapshotID?.toString();
  } catch { /* fall through to fallbacks */ }

  // 3. Fetch content image — thumbnail takes priority, then parcel snapshot, then fallbacks
  const contentImage = thumbnail || await fetchContentImage(bot, parsed, grid.gridX, grid.gridY, snapshotId);

  // 4. Build the detail line: "RegionName (x, y, z)"
  const regionLabel = regionName || `Region (${grid.gridX}, ${grid.gridY})`;
  const detail = `${regionLabel} (${Math.round(parsed.localX)}, ${Math.round(parsed.localY)}, ${Math.round(parsed.localZ)})`;

  // 5. Render the card
  const metadata: CardMetadata = {
    itemId,
    assetId,
    assetType: 'landmark',
    name: itemName,
    detail,
    permissions,
  };

  const png = await renderInventoryCard({ metadata, contentImage });

  return { png, metadata, regionName, gridX: grid.gridX, gridY: grid.gridY };
}
