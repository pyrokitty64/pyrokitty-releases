/**
 * Inventory walker — mirrors the entire SL inventory to disk.
 *
 * On login, walks every folder with 5 concurrent populate() calls,
 * mirrors the folder structure as directories, and writes each item
 * as a file (raw asset or Monopoly card depending on type).
 *
 * Uses node-metaverse's built-in folder cache (version-gated JSON per
 * folder) so subsequent logins only re-fetch folders that changed.
 */

import { mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { writeFile, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { app } from 'electron';
import type { Bot } from '../../../node-metaverse/lib/Bot';
import { AssetType } from '../../../node-metaverse/lib/enums/AssetType';
import { FolderType } from '../../../node-metaverse/lib/enums/FolderType';
import type { InventoryFolder } from '../../../node-metaverse/lib/classes/InventoryFolder';
import type { InventoryItem } from '../../../node-metaverse/lib/classes/InventoryItem';
import { renderInventoryCard, readCardMetadata, type CardMetadata } from './inventory-card';
import { buildLandmarkCard } from './landmark-strategy';
import { generateObjectThumbnail } from './object-thumbnail-strategy';
import { generateAnimationThumbnail } from './animation-thumbnail-strategy';
import { thumbnailWindowAvailable } from '../assets/thumbnail-window';
import { j2cToPng } from '../assets/j2k-converter';
import { pkDebug } from '../pk-debug';

// ── Configuration ───────────────────────────────────────────────────────────

const MAX_CONCURRENT = 5;

/** Folders to skip — these don't belong in the filesystem mirror. */
const SKIP_FOLDER_TYPES = new Set([
  FolderType.Trash,
  FolderType.LostAndFound,
  FolderType.Inbox,
  FolderType.Outbox,
  FolderType.MarketplaceListings,
  FolderType.MarkplaceStock,
]);

/** Priority order for folder types — lower number = populated first. */
const FOLDER_PRIORITY: Partial<Record<FolderType, number>> = {
  [FolderType.CurrentOutfit]: 0,
  [FolderType.Landmark]: 1,
  [FolderType.Favorites]: 2,
  [FolderType.MyOutfits]: 3,
  [FolderType.Clothing]: 4,
  [FolderType.Object]: 5,
  [FolderType.BodyPart]: 6,
};
const DEFAULT_PRIORITY = 10;

// ── Filename helpers ────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || '_';
}

/** File extension for a given asset type. */
function extensionForType(type: AssetType): string {
  switch (type) {
    case AssetType.Texture:    return '.png';
    case AssetType.Sound:      return '.ogg';
    case AssetType.Notecard:   return '.txt';
    case AssetType.LSLText:    return '.lsl';
    case AssetType.Script:     return '.lsl';
    case AssetType.Animation:  return '.bvh';
    default:                   return '.png'; // card types
  }
}

/** Whether this asset type could be a raw file (vs a Monopoly card).
 *  Also needs a valid asset UUID and modify permission for scripts/notecards. */
function isRawFileType(type: AssetType): boolean {
  switch (type) {
    case AssetType.Texture:
    case AssetType.Sound:
    case AssetType.Notecard:
    case AssetType.LSLText:
    case AssetType.Script:
      return true;
    default:
      return false;
  }
}

/** Check if an item could potentially be downloaded as a raw file.
 *  Only filters out null asset UUIDs — actual permission failures are
 *  caught at download time and fall back to a card. */
function canDownloadRaw(item: InventoryItem): boolean {
  const nullUuid = !item.assetID || item.assetID.toString() === '00000000-0000-0000-0000-000000000000';

  // Scripts and notecards can be downloaded by itemID even with null asset UUID
  // (server resolves source from the inventory item, not the asset database)
  if (item.type === AssetType.LSLText || item.type === AssetType.Script || item.type === AssetType.Notecard) {
    return true;
  }

  // For other types, null asset UUID means no downloadable asset
  if (nullUuid) {
    pkDebug('inventory', `Null asset UUID for ${item.name} (type=${item.type}), using card`);
    return false;
  }
  return true;
}

/** Human-readable asset type string for card metadata. */
function assetTypeString(type: AssetType): string {
  switch (type) {
    case AssetType.Texture:     return 'texture';
    case AssetType.Sound:       return 'sound';
    case AssetType.Landmark:    return 'landmark';
    case AssetType.Clothing:    return 'clothing';
    case AssetType.Bodypart:    return 'bodypart';
    case AssetType.Object:      return 'object';
    case AssetType.Notecard:    return 'notecard';
    case AssetType.LSLText:     return 'script';
    case AssetType.Script:      return 'script';
    case AssetType.Animation:   return 'animation';
    case AssetType.Gesture:     return 'gesture';
    case AssetType.CallingCard: return 'callingcard';
    case AssetType.Mesh:        return 'object';
    case AssetType.Settings:    return 'unknown';
    default:                    return 'unknown';
  }
}

// ── Permission helpers ──────────────────────────────────────────────────────

const PERM_COPY     = 0x00008000;
const PERM_MODIFY   = 0x00004000;
const PERM_TRANSFER = 0x00002000;

function extractPermissions(item: InventoryItem): { copy: boolean; modify: boolean; transfer: boolean } {
  const mask = item.permissions?.ownerMask ?? 0;
  return {
    copy: (mask & PERM_COPY) !== 0,
    modify: (mask & PERM_MODIFY) !== 0,
    transfer: (mask & PERM_TRANSFER) !== 0,
  };
}

// ── Manifest ────────────────────────────────────────────────────────────────

/** Bump this when anything about the sync output changes — card templates,
 *  file format decisions, download logic, etc.  When the manifest's version
 *  doesn't match, the entire inventory is wiped and re-synced. */
const WALKER_VERSION = 1;

interface ManifestEntry {
  itemId: string;
  assetId: string;
  assetType: number;
  fileName: string;
  /** Item name at time of sync — re-sync if changed */
  name: string;
  /** Item description at time of sync */
  description: string;
  /** Owner permission mask at time of sync — re-sync if changed */
  ownerMask: number;
  /** Timestamp of last sync */
  syncedAt: number;
}

interface Manifest {
  walkerVersion: number;
  entries: Record<string, ManifestEntry>; // keyed by itemId
}

async function loadManifest(manifestPath: string): Promise<Manifest> {
  try {
    const data = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(data);
    // If walker version doesn't match, return empty manifest (forces full re-sync)
    if (manifest.walkerVersion !== WALKER_VERSION) {
      pkDebug('inventory', `Walker version changed (${manifest.walkerVersion} → ${WALKER_VERSION}), wiping and re-syncing`);
      return { walkerVersion: WALKER_VERSION, entries: {} };
    }
    return manifest;
  } catch {
    return { walkerVersion: WALKER_VERSION, entries: {} };
  }
}

async function saveManifest(manifestPath: string, manifest: Manifest): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

// ── Walker ──────────────────────────────────────────────────────────────────

export interface WalkerProgress {
  phase: 'folders' | 'items' | 'done';
  foldersTotal: number;
  foldersComplete: number;
  itemsTotal: number;
  itemsComplete: number;
}

export class InventoryWalker {
  private bot: Bot;
  private baseDir: string;
  private manifest!: Manifest;
  private manifestPath: string;
  private aborted = false;
  private onProgress?: (progress: WalkerProgress) => void;
  /** When set, only process folders whose name matches (case-insensitive). For testing. */
  folderFilter?: string;
  /** When true, enable 3D thumbnail generation via HUD attach for objects. Only for manual sync. */
  enable3dThumbnails = false;

  constructor(bot: Bot, accountId: string, onProgress?: (progress: WalkerProgress) => void) {
    this.bot = bot;
    this.baseDir = join(app.getPath('userData'), 'data', 'inventory-sync', accountId);
    this.manifestPath = join(this.baseDir, '.inventory-manifest.json');
    this.onProgress = onProgress;
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** Stop the walker gracefully. */
  abort() {
    this.aborted = true;
  }

  /** Run the full inventory walk. */
  async walk(): Promise<void> {
    this.manifest = await loadManifest(this.manifestPath);

    // Wipe old files if walker version changed (empty manifest = version mismatch or first run)
    if (Object.keys(this.manifest.entries).length === 0 && existsSync(this.baseDir)) {
      const contents = readdirSync(this.baseDir);
      if (contents.some(f => f !== '.inventory-manifest.json')) {
        pkDebug('inventory', `Wiping ${this.baseDir} for clean re-sync`);
        rmSync(this.baseDir, { recursive: true, force: true });
        mkdirSync(this.baseDir, { recursive: true });
      }
    }

    // 1. Collect all folders from the skeleton
    const skeleton = this.bot.agent.inventory.main.skeleton;
    const rootId = this.bot.agent.inventory.main.root?.toString();

    const allFolders: { folder: InventoryFolder; path: string; priority: number }[] = [];

    // Build folder tree with filesystem paths
    const folderPaths = new Map<string, string>(); // folderId → disk path
    if (rootId) {
      folderPaths.set(rootId, this.baseDir);
    }

    // Walk skeleton to build paths (skeleton is flat — need to reconstruct tree)
    // Multiple passes since children may appear before parents
    const pending = new Map<string, InventoryFolder>();
    for (const folder of skeleton.values()) {
      if (!folder) continue;
      pending.set(folder.folderID.toString(), folder);
    }

    let resolved = true;
    while (resolved && pending.size > 0) {
      resolved = false;
      for (const [id, folder] of pending) {
        const parentId = folder.parentID.toString();

        // Root folder maps to baseDir
        if (id === rootId) {
          folderPaths.set(id, this.baseDir);
          pending.delete(id);
          resolved = true;
          continue;
        }

        const parentPath = folderPaths.get(parentId);
        if (parentPath !== undefined) {
          if (SKIP_FOLDER_TYPES.has(folder.typeDefault)) {
            pending.delete(id);
            resolved = true;
            continue;
          }

          const dirName = sanitizeName(folder.name);
          const dirPath = join(parentPath, dirName);
          folderPaths.set(id, dirPath);
          pending.delete(id);
          resolved = true;

          // If folderFilter is set, only include the matching folder and its descendants
          if (this.folderFilter) {
            const isMatch = folder.name.toLowerCase() === this.folderFilter.toLowerCase();
            const parentIncluded = allFolders.some(f => f.folder.folderID.toString() === parentId);
            if (!isMatch && !parentIncluded) {
              continue;
            }
          }

          const priority = FOLDER_PRIORITY[folder.typeDefault as FolderType] ?? DEFAULT_PRIORITY;
          allFolders.push({ folder, path: dirPath, priority });
        }
      }
    }

    // Sort by priority
    allFolders.sort((a, b) => a.priority - b.priority);

    // 2. Create all directories
    for (const { path: dirPath } of allFolders) {
      mkdirSync(dirPath, { recursive: true });
    }

    pkDebug('inventory', `${allFolders.length} folders to populate (${pending.size} unresolved)`);

    // 3. Populate folders with concurrency limit
    let foldersComplete = 0;
    const foldersTotal = allFolders.length;
    let itemsTotal = 0;
    let itemsComplete = 0;

    this.emitProgress({ phase: 'folders', foldersTotal, foldersComplete, itemsTotal, itemsComplete });

    // Collect all items to process
    const itemQueue: { item: InventoryItem; dirPath: string }[] = [];

    const populateFolder = async (entry: { folder: InventoryFolder; path: string }) => {
      if (this.aborted) return;
      try {
        await entry.folder.populate(true); // use cache if available
        for (const item of entry.folder.items) {
          // Skip links and system types
          if (item.type === AssetType.Link || item.type === AssetType.LinkFolder) continue;
          if (item.type === AssetType.Category) continue;
          itemQueue.push({ item, dirPath: entry.path });
        }
      } catch (err: any) {
        pkDebug('inventory', `Failed to populate ${entry.folder.name}: ${err.message}`);
      }
      foldersComplete++;
      this.emitProgress({ phase: 'folders', foldersTotal, foldersComplete, itemsTotal, itemsComplete });
    };

    // Run with concurrency limit
    await this.runConcurrent(allFolders, populateFolder, MAX_CONCURRENT);

    if (this.aborted) return;

    // 4. Process items
    itemsTotal = itemQueue.length;
    pkDebug('inventory', `${itemsTotal} items to process`);
    this.emitProgress({ phase: 'items', foldersTotal, foldersComplete, itemsTotal, itemsComplete });

    const processItem = async (entry: { item: InventoryItem; dirPath: string }) => {
      if (this.aborted) return;
      try {
        await this.syncItem(entry.item, entry.dirPath);
      } catch (err: any) {
        pkDebug('inventory', `Failed to sync ${entry.item.name}: ${err.message}`);
      }
      itemsComplete++;
      this.emitProgress({ phase: 'items', foldersTotal, foldersComplete, itemsTotal, itemsComplete });
    };

    // When 3D thumbnails are enabled, process items one at a time to avoid
    // multiple objects attached to HUD simultaneously
    await this.runConcurrent(itemQueue, processItem, this.enable3dThumbnails ? 1 : MAX_CONCURRENT);

    // 5. Save manifest
    await saveManifest(this.manifestPath, this.manifest);

    this.emitProgress({ phase: 'done', foldersTotal, foldersComplete, itemsTotal, itemsComplete });
    pkDebug('inventory', `Done. ${foldersComplete} folders, ${itemsComplete} items.`);
  }

  /** Process a single inventory item — write to disk if needed. */
  private async syncItem(item: InventoryItem, dirPath: string): Promise<void> {
    const itemId = item.itemID.toString();
    const assetId = item.assetID.toString();
    const ownerMask = item.permissions?.ownerMask ?? 0;

    // Check manifest — skip if nothing has changed
    const existing = this.manifest.entries[itemId];
    if (existing) {
      const assetSame = existing.assetId === assetId;
      const nameSame = existing.name === item.name;
      const descSame = existing.description === (item.description || '');
      const permsSame = existing.ownerMask === ownerMask;
      const isRaw = isRawFileType(item.type) && canDownloadRaw(item);
      const fileExists = existsSync(join(dirPath, existing.fileName));

      if (assetSame && nameSame && descSame && permsSame && fileExists) {
        // Re-process objects (when 3D thumbnails enabled) or animations (always)
        // that lack a thumbnail
        const noThumbId = !item.thumbnailID?.toString() || item.thumbnailID?.toString() === '00000000-0000-0000-0000-000000000000';
        const needsThumb = noThumbId && (
          (this.enable3dThumbnails && item.type === AssetType.Object)
          || item.type === AssetType.Animation
        );
        if (!needsThumb) return; // nothing changed, skip
      }

      // Something changed — delete the old file if the name changed (new filename)
      if (!nameSame && fileExists) {
        try { await unlink(join(dirPath, existing.fileName)); } catch { /* ok */ }
      }
    }

    // Determine file name — every file gets a short item UUID suffix for traceability
    const useRaw = isRawFileType(item.type) && canDownloadRaw(item);
    const ext = useRaw ? extensionForType(item.type) : '.png';
    const safeName = sanitizeName(item.name);
    const shortId = itemId.slice(0, 6);
    const fileName = `${safeName}.${shortId}${ext}`;
    const filePath = join(dirPath, fileName);

    if (useRaw) {
      try {
        await this.syncRawAsset(item, filePath);
      } catch (err: any) {
        // Download failed (e.g. no-mod script we don't own) — fall back to card
        pkDebug('inventory', `Raw download failed for ${item.name} (type=${item.type}, asset=${item.assetID}): ${err.message}, falling back to card`);
        const cardPath = join(dirPath, `${safeName}.${shortId}.png`);
        const thumbnail = await this.fetchThumbnail(item);
        await this.syncCardAsset(item, cardPath, thumbnail);
        this.manifest.entries[itemId] = {
          itemId, assetId, assetType: item.type,
          fileName: `${safeName}.${shortId}.png`,
          name: item.name, description: item.description || '',
          ownerMask, syncedAt: Date.now(),
        };
        return;
      }
    } else {
      // Thumbnail takes priority for all card types
      let thumbnail = await this.fetchThumbnail(item);
      // For objects without a CDN thumbnail, try 3D rendering
      pkDebug('inventory', `[Walker] Item "${item.name}": type=${item.type}, assetId=${assetId}`);
      if (item.type === AssetType.Object && this.enable3dThumbnails) {
        pkDebug('inventory', `[Walker] Object "${item.name}": itemId=${itemId}, cdnThumb=${!!thumbnail}, thumbWindow=${thumbnailWindowAvailable()}`);
        if (!thumbnail && thumbnailWindowAvailable()) {
          try {
            thumbnail = await generateObjectThumbnail(this.bot, item);
            if (thumbnail) pkDebug('inventory', `[Walker] 3D thumbnail generated for ${item.name} (${thumbnail.length} bytes)`);
            else pkDebug('inventory', `[Walker] 3D thumbnail returned null for ${item.name}`);
          } catch (err: any) {
            pkDebug('inventory', `[Walker] 3D thumbnail failed for ${item.name}: ${err.message}`);
          }
        }
      }
      if (item.type === AssetType.Animation) {
        if (!thumbnail && thumbnailWindowAvailable()) {
          try {
            thumbnail = await generateAnimationThumbnail(this.bot, item);
            if (thumbnail) pkDebug('inventory', `[Walker] Animation thumbnail generated for ${item.name} (${thumbnail.length} bytes)`);
            else pkDebug('inventory', `[Walker] Animation thumbnail returned null for ${item.name}`);
          } catch (err: any) {
            pkDebug('inventory', `[Walker] Animation thumbnail failed for ${item.name}: ${err.message}`);
          }
        }
      }
      if (item.type === AssetType.Landmark) {
        await this.syncLandmark(item, filePath, thumbnail);
      } else {
        await this.syncCardAsset(item, filePath, thumbnail);
      }
    }

    // Update manifest
    this.manifest.entries[itemId] = {
      itemId,
      assetId,
      assetType: item.type,
      fileName,
      name: item.name,
      description: item.description || '',
      ownerMask,
      syncedAt: Date.now(),
    };
  }

  /** Sync a raw file type (texture, notecard, script, sound). */
  private async syncRawAsset(item: InventoryItem, filePath: string): Promise<void> {
    switch (item.type) {
      case AssetType.Texture: {
        const j2cBuf = await this.bot.clientCommands.asset.downloadAsset(AssetType.Texture, item.assetID);
        const pngBuf = await j2cToPng(j2cBuf);
        await writeFile(filePath, pngBuf);
        break;
      }
      case AssetType.Notecard: {
        const buf = await this.bot.clientCommands.asset.downloadInventoryAsset(
          item.itemID, this.bot.agent.agentID, AssetType.Notecard, true,
        );
        const text = this.extractNotecardText(buf);
        await writeFile(filePath, text, 'utf-8');
        break;
      }
      case AssetType.LSLText:
      case AssetType.Script: {
        const buf = await this.bot.clientCommands.asset.downloadInventoryAsset(
          item.itemID, this.bot.agent.agentID, AssetType.LSLText, true,
        );
        await writeFile(filePath, buf.toString('utf-8'));
        break;
      }
      case AssetType.Sound: {
        const buf = await this.bot.clientCommands.asset.downloadAsset(AssetType.Sound, item.assetID);
        await writeFile(filePath, buf);
        break;
      }
    }
  }

  /** Sync a landmark as a Monopoly card with map/parcel image. */
  private async syncLandmark(item: InventoryItem, filePath: string, thumbnail: Buffer | null): Promise<void> {
    const perms = extractPermissions(item);
    const result = await buildLandmarkCard(
      this.bot,
      item.name,
      item.itemID.toString(),
      item.assetID.toString(),
      perms,
      thumbnail,
    );
    await writeFile(filePath, result.png);
  }

  /** Sync a non-file type as a Monopoly card. */
  private async syncCardAsset(item: InventoryItem, filePath: string, thumbnail: Buffer | null): Promise<void> {
    const perms = extractPermissions(item);
    const typeStr = assetTypeString(item.type);

    const metadata: CardMetadata = {
      itemId: item.itemID.toString(),
      assetId: item.assetID.toString(),
      assetType: typeStr,
      name: item.name,
      permissions: perms,
      detail: item.description || undefined,
    };

    if (item.type === AssetType.Clothing || item.type === AssetType.Bodypart) {
      metadata.detail = metadata.detail || getWearableTypeName(item.flags);
    }

    const png = await renderInventoryCard({ metadata, contentImage: thumbnail });
    await writeFile(filePath, png);
  }

  /** Fetch thumbnail image via picture-service CDN if the item has a thumbnailID. */
  private async fetchThumbnail(item: InventoryItem): Promise<Buffer | null> {
    const thumbId = item.thumbnailID?.toString();
    if (!thumbId || thumbId === '00000000-0000-0000-0000-000000000000') return null;
    try {
      const url = `https://picture-service.secondlife.com/${thumbId}/320x240.jpg`;
      const resp = await fetch(url);
      if (resp.ok) return Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      pkDebug('inventory', `Failed to fetch thumbnail ${thumbId} for ${item.name}: ${e}`);
    }
    return null;
  }

  /** Extract plain text from a notecard asset buffer. */
  private extractNotecardText(buf: Buffer): string {
    const text = buf.toString('utf-8');
    // SL notecard format: header lines, then the text body between markers
    const bodyMatch = text.match(/\}[\r\n]+(.*)$/s);
    if (bodyMatch) return bodyMatch[1].trimEnd();
    // Fallback: return everything
    return text;
  }



  /** Run async tasks with a concurrency limit. */
  private async runConcurrent<T>(
    items: T[],
    fn: (item: T) => Promise<void>,
    concurrency: number,
  ): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length && !this.aborted) {
        const i = index++;
        await fn(items[i]);
      }
    });
    await Promise.all(workers);
  }

  private emitProgress(progress: WalkerProgress) {
    this.onProgress?.(progress);
  }
}

// ── Wearable type names from flags ──────────────────────────────────────────

function getWearableTypeName(flags: number): string {
  // Lower byte of flags is wearable type
  const wearableType = flags & 0xFF;
  const names: Record<number, string> = {
    0: 'Shape',
    1: 'Skin',
    2: 'Hair',
    3: 'Eyes',
    4: 'Shirt',
    5: 'Pants',
    6: 'Shoes',
    7: 'Socks',
    8: 'Jacket',
    9: 'Gloves',
    10: 'Undershirt',
    11: 'Underpants',
    12: 'Skirt',
    13: 'Alpha',
    14: 'Tattoo',
    15: 'Physics',
  };
  return names[wearableType] || 'Wearable';
}
