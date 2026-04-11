import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app, shell } from 'electron';
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from 'chokidar';
import { Bot, AssetType, FolderType, InventoryType, LLLindenText } from '../../../node-metaverse/dist/lib';
import { InventoryFolder } from '../../../node-metaverse/dist/lib/classes/InventoryFolder';
import { InventoryItem } from '../../../node-metaverse/dist/lib/classes/InventoryItem';
import { j2cToPng, pngToJ2c } from '../assets/j2k-converter';
import { SyncStatus } from '../../shared/types';
import { ViewerInventoryAdapter, ViewerInventoryFolder } from './viewer-inventory-adapter';
import { pkDebug } from '../pk-debug';

const SYNC_FOLDER_NAME = '#Inventory Sync';
const MANIFEST_FILE = 'sync-manifest.json';
const CONCURRENT_DOWNLOADS = 5;
const DELAY_BETWEEN_MS = 100;
const MAX_DEPTH = 10;

// folder can be InventoryFolder (node-metaverse) or ViewerInventoryFolder (viewer adapter)
// Both duck-type: name, folders[], items[], populate(), createFolder(), uploadAsset()
interface FolderNode {
  folder: InventoryFolder | ViewerInventoryFolder;
  relativePath: string;  // "" for root, "sub" for child, "a/b" for nested
  localDir: string;      // absolute local path for this folder
}

interface ManifestItem {
  localFile: string;
  assetId: string;
  itemId: string;
  md5: string;
  lastSynced: number;
  direction: 'download' | 'upload';
  assetType?: 'texture' | 'notecard' | 'script'; // undefined means texture for backward compat
  relativePath?: string; // "" or undefined for root folder items
}

interface Manifest {
  version: number;
  lastSync: number;
  uploadCost: number;
  items: Record<string, ManifestItem>; // keyed by manifestKey (path/itemName)
}

/** Build a manifest key from relative path and item name */
function manifestKey(relativePath: string, itemName: string): string {
  return relativePath ? `${relativePath}/${itemName}` : itemName;
}

function sanitizeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim();
}

function md5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Recursively enumerate local subdirectories with their relative paths */
function getLocalSubdirs(baseDir: string, relativePath: string = '', depth: number = 0): Array<{ relativePath: string; localDir: string }> {
  if (depth >= MAX_DEPTH) return [];
  const results: Array<{ relativePath: string; localDir: string }> = [];
  const absDir = relativePath ? path.join(baseDir, relativePath) : baseDir;

  if (!fs.existsSync(absDir)) return results;

  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childAbs = path.join(absDir, entry.name);
    results.push({ relativePath: childRelative, localDir: childAbs });
    results.push(...getLocalSubdirs(baseDir, childRelative, depth + 1));
  }
  return results;
}

export class InventorySyncManager {
  private bot: Bot | null;
  private adapter: ViewerInventoryAdapter | null;
  private accountId: string;
  private localDir: string;
  private manifest: Manifest;
  private progress: SyncStatus = { phase: 'idle', current: 0, total: 0, uploadCost: -1 };
  private onProgress?: (progress: SyncStatus) => void;
  private watcher: ChokidarWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private pendingWatch = false;

  constructor(backend: Bot | ViewerInventoryAdapter, accountId: string, onProgress?: (progress: SyncStatus) => void) {
    if (backend instanceof ViewerInventoryAdapter) {
      this.bot = null;
      this.adapter = backend;
    } else {
      this.bot = backend;
      this.adapter = null;
    }
    this.accountId = accountId;
    this.localDir = path.join(app.getPath('userData'), 'data', 'inventory-sync', accountId);
    this.onProgress = onProgress;
    this.manifest = this.loadManifest();
  }

  getProgress(): SyncStatus {
    return { ...this.progress };
  }

  getLocalDir(): string {
    return this.localDir;
  }

  /** Check if the backend (bot or viewer adapter) is still usable */
  isBackendValid(): boolean {
    if (this.adapter) return true;
    if (this.bot) {
      // throws if this.bot is undefined
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      try { this.bot.clientCommands; return true; } catch { return false; }
    }
    return false;
  }

  /** Start watching the local sync folder for changes */
  startWatching(): void {
    if (this.watcher) return;

    if (!fs.existsSync(this.localDir)) {
      fs.mkdirSync(this.localDir, { recursive: true });
    }

    try {
      this.watcher = chokidarWatch(this.localDir, {
        ignoreInitial: true,
        ignored: (filePath: string) => path.basename(filePath) === MANIFEST_FILE,
      });
      this.watcher.on('all', (_event, filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (!['.png', '.txt', '.lsl'].includes(ext)) return;
        this.scheduleSync();
      });
      console.log(`[InventorySync] Watching ${this.localDir} for changes`);
    } catch (err) {
      console.error('[InventorySync] Failed to start file watcher:', err);
    }
  }

  /** Stop watching the local sync folder */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = null;
      console.log('[InventorySync] Stopped watching for changes');
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Debounce file changes — wait 1.5s after last change, then sync */
  private scheduleSync(): void {
    if (this.syncing) {
      this.pendingWatch = true;
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      console.log('[InventorySync] File change detected, syncing...');
      this.sync().catch(err => console.error('[InventorySync] Watch-triggered sync error:', err));
    }, 1500);
  }

  /** Run a full sync: download from SL, then upload to SL (if free) */
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    const j2kAvailable = true; // WASM decoder/encoder always available

    try {
      this.setProgress({ phase: 'preparing', current: 0, total: 0 });

      // Ensure local directory exists
      if (!fs.existsSync(this.localDir)) {
        fs.mkdirSync(this.localDir, { recursive: true });
      }

      // Get or create the sync folder in SL
      const syncFolder = await this.getOrCreateSyncFolder();

      // Build the full folder tree (populates all folders)
      const folderTree = await this.buildFolderTree(syncFolder);
      console.log(`[InventorySync] Found ${folderTree.length} folders in SL tree`);

      // Create local directories for all folder nodes
      for (const node of folderTree) {
        if (!fs.existsSync(node.localDir)) {
          fs.mkdirSync(node.localDir, { recursive: true });
        }
      }

      // Get upload cost
      const uploadCost = await this.getUploadCostValue();
      this.manifest.uploadCost = uploadCost;

      // Deduplicate names in SL (per folder)
      await this.deduplicateSlNames(folderTree, j2kAvailable);

      // Phase 1: SL → Local
      await this.downloadSync(folderTree, j2kAvailable);

      // Phase 2: Local → SL
      // Notecards are always free; textures only if upload cost is L$0
      const canUploadTextures = uploadCost === 0 && j2kAvailable;
      if (uploadCost > 0) {
        console.log(`[InventorySync] Upload cost is L$${uploadCost}, skipping texture uploads (notecards still sync)`);
      }
      await this.uploadSync(folderTree, canUploadTextures);

      // Clean up deleted items and empty directories
      await this.cleanupDeleted(folderTree);

      this.manifest.lastSync = Date.now();
      this.saveManifest();
      this.setProgress({ phase: 'done', current: 0, total: 0 });
    } catch (error: any) {
      console.error('[InventorySync] Sync failed:', error);
      this.setProgress({ phase: 'error', current: 0, total: 0, error: error.message });
    } finally {
      this.syncing = false;
      // If a file change came in while syncing, schedule another
      if (this.pendingWatch) {
        this.pendingWatch = false;
        this.scheduleSync();
      }
    }
  }

  /** BFS walk the SL folder tree starting from sync root */
  private async buildFolderTree(syncFolder: InventoryFolder | ViewerInventoryFolder): Promise<FolderNode[]> {
    const tree: FolderNode[] = [];
    const queue: Array<{ folder: InventoryFolder | ViewerInventoryFolder; relativePath: string; depth: number }> = [
      { folder: syncFolder, relativePath: '', depth: 0 }
    ];

    while (queue.length > 0) {
      const { folder, relativePath, depth } = queue.shift()!;

      await folder.populate(false);

      const localDir = relativePath
        ? path.join(this.localDir, ...relativePath.split('/').map(sanitizeName))
        : this.localDir;

      tree.push({ folder, relativePath, localDir });

      if (depth < MAX_DEPTH) {
        for (const child of folder.folders) {
          const childPath = relativePath ? `${relativePath}/${child.name}` : child.name;
          queue.push({ folder: child, relativePath: childPath, depth: depth + 1 });
        }
      }
    }

    return tree;
  }

  /** Download textures, notecards, and scripts from SL that are new or changed */
  private async downloadSync(folderTree: FolderNode[], j2kAvailable: boolean): Promise<void> {
    const syncableTypes = [AssetType.Notecard, AssetType.LSLText];
    if (j2kAvailable) syncableTypes.unshift(AssetType.Texture);

    // Collect all downloadable items across all folders
    const toDownload: Array<{ item: InventoryItem | any; node: FolderNode }> = [];
    for (const node of folderTree) {
      const syncableItems = (node.folder.items as any[]).filter(i => syncableTypes.includes(i.type));
      for (const item of syncableItems) {
        const key = manifestKey(node.relativePath, item.name);
        const existing = this.manifest.items[key];
        if (!existing || existing.assetId !== item.assetID.toString()) {
          toDownload.push({ item, node });
        }
      }
    }

    if (toDownload.length === 0) {
      console.log('[InventorySync] No new items to download');
      return;
    }

    console.log(`[InventorySync] Downloading ${toDownload.length} items`);
    this.setProgress({ phase: 'downloading', current: 0, total: toDownload.length });

    // Download with concurrency limit, updating progress per item
    let completed = 0;
    for (let i = 0; i < toDownload.length; i += CONCURRENT_DOWNLOADS) {
      const batch = toDownload.slice(i, i + CONCURRENT_DOWNLOADS);
      const results = await Promise.allSettled(
        batch.map(async ({ item, node }) => {
          try {
            if (item.type === AssetType.Notecard) {
              return await this.downloadOneNotecard(item, node.relativePath, node.localDir);
            }
            if (item.type === AssetType.LSLText) {
              return await this.downloadOneScript(item, node.relativePath, node.localDir);
            }
            return await this.downloadOne(item, node.relativePath, node.localDir);
          } finally {
            completed++;
            this.setProgress({ phase: 'downloading', current: completed, total: toDownload.length });
          }
        })
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('[InventorySync] Download failed:', result.reason);
        }
      }

      if (i + CONCURRENT_DOWNLOADS < toDownload.length) {
        await delay(DELAY_BETWEEN_MS);
      }
    }

    this.saveManifest();
  }

  /** Download a single texture from SL */
  private async downloadOne(item: InventoryItem | any, relativePath: string, targetDir: string): Promise<void> {
    const assetId = item.assetID.toString();
    const name = item.name;
    const safeName = sanitizeName(name);
    const localFile = `${safeName}.png`;
    const localPath = path.join(targetDir, localFile);
    const key = manifestKey(relativePath, name);

    pkDebug('inventory', `[InventorySync] Downloading: ${key} (${assetId})`);

    const j2cBuffer = await this.downloadAssetData(item, AssetType.Texture);
    const pngBuffer = await j2cToPng(j2cBuffer);

    fs.writeFileSync(localPath, pngBuffer);

    this.manifest.items[key] = {
      localFile,
      assetId,
      itemId: item.itemID.toString(),
      md5: md5(pngBuffer),
      lastSynced: Date.now(),
      direction: 'download',
      relativePath,
    };
  }

  /** Download a single notecard from SL */
  private async downloadOneNotecard(item: InventoryItem | any, relativePath: string, targetDir: string): Promise<void> {
    const assetId = item.assetID.toString();
    const name = item.name;
    const safeName = sanitizeName(name);
    const localFile = `${safeName}.txt`;
    const localPath = path.join(targetDir, localFile);
    const key = manifestKey(relativePath, name);

    pkDebug('inventory', `[InventorySync] Downloading notecard: ${key} (${assetId})`);

    const rawBuffer = await this.downloadAssetData(item, AssetType.Notecard);

    // Viewer adapter returns raw notecard asset data (same format as node-metaverse)
    const notecard = new LLLindenText(rawBuffer);
    const textContent = notecard.body;

    fs.writeFileSync(localPath, textContent, 'utf-8');

    this.manifest.items[key] = {
      localFile,
      assetId,
      itemId: item.itemID.toString(),
      md5: md5(Buffer.from(textContent, 'utf-8')),
      lastSynced: Date.now(),
      direction: 'download',
      assetType: 'notecard',
      relativePath,
    };
  }

  /** Download a single LSL script from SL */
  private async downloadOneScript(item: InventoryItem | any, relativePath: string, targetDir: string): Promise<void> {
    const assetId = item.assetID.toString();
    const name = item.name;
    const safeName = sanitizeName(name);
    const localFile = `${safeName}.lsl`;
    const localPath = path.join(targetDir, localFile);
    const key = manifestKey(relativePath, name);

    pkDebug('inventory', `[InventorySync] Downloading script: ${key} (${assetId})`);

    const rawBuffer = await this.downloadAssetData(item, AssetType.LSLText);

    // Scripts are raw text, not wrapped in notecard format
    const textContent = rawBuffer.toString('utf-8');

    fs.writeFileSync(localPath, textContent, 'utf-8');

    this.manifest.items[key] = {
      localFile,
      assetId,
      itemId: item.itemID.toString(),
      md5: md5(Buffer.from(textContent, 'utf-8')),
      lastSynced: Date.now(),
      direction: 'download',
      assetType: 'script',
      relativePath,
    };
  }

  /** Upload local PNGs, TXTs, and LSLs that aren't in the manifest or have changed */
  private async uploadSync(folderTree: FolderNode[], includeTextures: boolean): Promise<void> {
    const allowedExtensions = ['.txt', '.lsl'];
    if (includeTextures) allowedExtensions.push('.png');

    // Create SL folders for any local subdirectories that don't have matching SL folders
    const newNodes = await this.createMissingSLFolders(folderTree);
    const allNodes = [...folderTree, ...newNodes];

    // Collect all files needing upload across all folders
    const toUpload: Array<{ file: string; node: FolderNode }> = [];
    for (const node of allNodes) {
      if (!fs.existsSync(node.localDir)) continue;

      const localFiles = fs.readdirSync(node.localDir)
        .filter(f => {
          if (f === MANIFEST_FILE) return false;
          return allowedExtensions.some(ext => f.toLowerCase().endsWith(ext));
        });

      for (const file of localFiles) {
        const localPath = path.join(node.localDir, file);
        const fileBuffer = fs.readFileSync(localPath);
        const fileMd5 = md5(fileBuffer);

        const slName = file.replace(/\.(png|txt|lsl)$/i, '');
        const key = manifestKey(node.relativePath, slName);

        const existing = this.manifest.items[key];
        if (!existing) {
          toUpload.push({ file, node });
        } else if (existing.direction === 'upload' && existing.md5 !== fileMd5) {
          toUpload.push({ file, node });
        } else if (existing.direction === 'download' && existing.md5 !== fileMd5) {
          toUpload.push({ file, node });
        }
      }
    }

    if (toUpload.length === 0) {
      console.log('[InventorySync] No new items to upload');
      return;
    }

    console.log(`[InventorySync] Uploading ${toUpload.length} items`);
    this.setProgress({ phase: 'uploading', current: 0, total: toUpload.length });

    for (let i = 0; i < toUpload.length; i++) {
      const { file, node } = toUpload[i];
      try {
        if (file.toLowerCase().endsWith('.txt')) {
          await this.uploadOneNotecard(node.folder, file, node.relativePath, node.localDir);
        } else if (file.toLowerCase().endsWith('.lsl')) {
          await this.uploadOneScript(node.folder, file, node.relativePath, node.localDir);
        } else {
          await this.uploadOne(node.folder, file, node.relativePath, node.localDir);
        }
      } catch (error) {
        console.error(`[InventorySync] Upload failed for ${file}:`, error);
      }
      this.setProgress({
        phase: 'uploading',
        current: i + 1,
        total: toUpload.length,
        currentFile: file,
      });
      if (i < toUpload.length - 1) {
        await delay(DELAY_BETWEEN_MS);
      }
    }

    this.saveManifest();
  }

  /** Create SL folders for local subdirectories that don't have matching SL folders */
  private async createMissingSLFolders(folderTree: FolderNode[]): Promise<FolderNode[]> {
    const newNodes: FolderNode[] = [];

    // Build a lookup from sanitized path → node for matching local dirs to SL folders.
    // SL relativePaths use original names; local dirs use sanitized names.
    // We must compare using sanitized versions of both.
    const sanitizedPathToNode = new Map<string, FolderNode>();
    const knownSanitizedPaths = new Set<string>();
    for (const node of folderTree) {
      const sanitized = node.relativePath
        ? node.relativePath.split('/').map(sanitizeName).join('/')
        : '';
      sanitizedPathToNode.set(sanitized, node);
      knownSanitizedPaths.add(sanitized);
    }

    // BFS walk local directories
    const localSubdirs = getLocalSubdirs(this.localDir);

    for (const { relativePath: localRelPath, localDir } of localSubdirs) {
      // Local dir names are already sanitized (or user-created) filesystem names.
      // Compare against sanitized SL paths to avoid duplicates.
      if (knownSanitizedPaths.has(localRelPath)) continue;

      // Find the parent node by sanitized path
      const parts = localRelPath.split('/');
      const folderName = parts[parts.length - 1];
      const parentSanitizedPath = parts.slice(0, -1).join('/');

      // Look for parent in existing tree + newly created nodes
      const parentNode = sanitizedPathToNode.get(parentSanitizedPath);
      if (!parentNode) {
        console.warn(`[InventorySync] Cannot find parent SL folder for local path: ${localRelPath}`);
        continue;
      }

      pkDebug('inventory', `[InventorySync] Creating SL folder: ${localRelPath}`);
      try {
        const newFolder = await (parentNode.folder as any).createFolder(folderName, FolderType.None);
        await newFolder.populate(false);

        const node: FolderNode = {
          folder: newFolder as InventoryFolder | ViewerInventoryFolder,
          relativePath: localRelPath,
          localDir,
        };
        newNodes.push(node);
        // Register new node so deeper local subdirs can find their parent
        sanitizedPathToNode.set(localRelPath, node);
        knownSanitizedPaths.add(localRelPath);
      } catch (error) {
        console.error(`[InventorySync] Failed to create SL folder ${localRelPath}:`, error);
      }
    }

    return newNodes;
  }

  /** Upload a single local PNG to SL */
  private async uploadOne(slFolder: InventoryFolder | ViewerInventoryFolder, file: string, relativePath: string, localDir: string): Promise<void> {
    const slName = file.replace(/\.png$/i, '');
    const localPath = path.join(localDir, file);
    const pngBuffer = fs.readFileSync(localPath);
    const fileMd5 = md5(pngBuffer);
    const key = manifestKey(relativePath, slName);

    // If replacing an existing item, delete the old one in SL
    const existing = this.manifest.items[key];
    if (existing) {
      try {
        const oldItem = slFolder.items.find(i => i.itemID.toString() === existing.itemId);
        if (oldItem) {
          pkDebug('inventory', `[InventorySync] Deleting old SL item: ${key}`);
          await oldItem.delete();
        }
      } catch (error) {
        console.warn(`[InventorySync] Failed to delete old item ${key}:`, error);
      }
    }

    pkDebug('inventory', `[InventorySync] Uploading: ${key}`);
    const j2cBuffer = await pngToJ2c(pngBuffer);

    const newItem = await slFolder.uploadAsset(
      AssetType.Texture,
      InventoryType.Texture,
      j2cBuffer,
      slName,
      SYNC_FOLDER_NAME
    );

    this.manifest.items[key] = {
      localFile: file,
      assetId: newItem.assetID.toString(),
      itemId: newItem.itemID.toString(),
      md5: fileMd5,
      lastSynced: Date.now(),
      direction: 'upload',
      relativePath,
    };
  }

  /** Upload a single local TXT as a notecard to SL */
  private async uploadOneNotecard(slFolder: InventoryFolder | ViewerInventoryFolder, file: string, relativePath: string, localDir: string): Promise<void> {
    const slName = file.replace(/\.txt$/i, '');
    const localPath = path.join(localDir, file);
    const textContent = fs.readFileSync(localPath, 'utf-8');
    const fileMd5 = md5(Buffer.from(textContent, 'utf-8'));
    const key = manifestKey(relativePath, slName);

    const notecard = new LLLindenText();
    notecard.body = textContent;
    const assetBuffer = notecard.toAsset();

    const existing = this.manifest.items[key];

    // If the item exists in SL and we're using the viewer adapter, update in-place
    if (existing && this.adapter) {
      pkDebug('inventory', `[InventorySync] Updating notecard in-place: ${key}`);
      const result = await this.adapter.updateAsset(existing.itemId, assetBuffer);

      this.manifest.items[key] = {
        ...existing,
        assetId: result.assetId,
        md5: fileMd5,
        lastSynced: Date.now(),
        direction: 'upload',
      };
      return;
    }

    // Otherwise delete + recreate (bot path, or new item)
    if (existing) {
      try {
        const oldItem = slFolder.items.find(i => i.itemID.toString() === existing.itemId);
        if (oldItem) {
          pkDebug('inventory', `[InventorySync] Deleting old SL notecard: ${key}`);
          await oldItem.delete();
        }
      } catch (error) {
        console.warn(`[InventorySync] Failed to delete old notecard ${key}:`, error);
      }
    }

    pkDebug('inventory', `[InventorySync] Uploading notecard: ${key}`);
    const newItem = await slFolder.uploadAsset(
      AssetType.Notecard,
      InventoryType.Notecard,
      assetBuffer,
      slName,
      SYNC_FOLDER_NAME
    );

    this.manifest.items[key] = {
      localFile: file,
      assetId: newItem.assetID.toString(),
      itemId: newItem.itemID.toString(),
      md5: fileMd5,
      lastSynced: Date.now(),
      direction: 'upload',
      assetType: 'notecard',
      relativePath,
    };
  }

  /** Upload a single local LSL script to SL */
  private async uploadOneScript(slFolder: InventoryFolder | ViewerInventoryFolder, file: string, relativePath: string, localDir: string): Promise<void> {
    const slName = file.replace(/\.lsl$/i, '');
    const localPath = path.join(localDir, file);
    const textContent = fs.readFileSync(localPath, 'utf-8');
    const fileMd5 = md5(Buffer.from(textContent, 'utf-8'));
    const key = manifestKey(relativePath, slName);

    // Scripts are raw text, not wrapped in notecard format
    const assetBuffer = Buffer.from(textContent, 'utf-8');

    const existing = this.manifest.items[key];

    // If the item exists in SL and we're using the viewer adapter, update in-place
    if (existing && this.adapter) {
      pkDebug('inventory', `[InventorySync] Updating script in-place: ${key}`);
      const result = await this.adapter.updateAsset(existing.itemId, assetBuffer);

      this.manifest.items[key] = {
        ...existing,
        assetId: result.assetId,
        md5: fileMd5,
        lastSynced: Date.now(),
        direction: 'upload',
      };
      return;
    }

    // Otherwise delete + recreate (bot path, or new item)
    if (existing) {
      try {
        const oldItem = slFolder.items.find(i => i.itemID.toString() === existing.itemId);
        if (oldItem) {
          pkDebug('inventory', `[InventorySync] Deleting old SL script: ${key}`);
          await oldItem.delete();
        }
      } catch (error) {
        console.warn(`[InventorySync] Failed to delete old script ${key}:`, error);
      }
    }

    pkDebug('inventory', `[InventorySync] Uploading script: ${key}`);
    const newItem = await slFolder.uploadAsset(
      AssetType.LSLText,
      InventoryType.LSL,
      assetBuffer,
      slName,
      SYNC_FOLDER_NAME
    );

    this.manifest.items[key] = {
      localFile: file,
      assetId: newItem.assetID.toString(),
      itemId: newItem.itemID.toString(),
      md5: fileMd5,
      lastSynced: Date.now(),
      direction: 'upload',
      assetType: 'script',
      relativePath,
    };
  }

  /** Remove local files whose SL items no longer exist, and clean up empty directories */
  private async cleanupDeleted(folderTree: FolderNode[]): Promise<void> {
    // Build a set of all existing SL item keys across all folders
    const slKeys = new Set<string>();
    for (const node of folderTree) {
      for (const item of node.folder.items) {
        slKeys.add(manifestKey(node.relativePath, item.name));
      }
    }

    // Build a set of sanitized SL folder paths for comparison with local filesystem paths
    const slSanitizedPaths = new Set(
      folderTree.map(n => n.relativePath
        ? n.relativePath.split('/').map(sanitizeName).join('/')
        : ''
      )
    );

    // Delete local files whose manifest entries (direction=download) no longer exist in SL
    for (const [key, entry] of Object.entries(this.manifest.items)) {
      if (!slKeys.has(key) && entry.direction === 'download') {
        const entryDir = entry.relativePath
          ? path.join(this.localDir, ...entry.relativePath.split('/').map(sanitizeName))
          : this.localDir;
        const localPath = path.join(entryDir, entry.localFile);
        if (fs.existsSync(localPath)) {
          pkDebug('inventory', `[InventorySync] Removing deleted item: ${key}`);
          await shell.trashItem(localPath);
        }
        delete this.manifest.items[key];
      }
    }

    // Move SL items to trash when local file was deleted
    for (const [key, entry] of Object.entries(this.manifest.items)) {
      const entryDir = entry.relativePath
        ? path.join(this.localDir, ...entry.relativePath.split('/').map(sanitizeName))
        : this.localDir;
      const localPath = path.join(entryDir, entry.localFile);

      if (fs.existsSync(localPath)) continue; // file still exists, skip

      // Find the SL item by itemId across all folders
      let slItem: any = null;
      for (const node of folderTree) {
        slItem = node.folder.items.find((i: any) => i.itemID.toString() === entry.itemId);
        if (slItem) break;
      }

      if (slItem) {
        try {
          pkDebug('inventory', `[InventorySync] Local file deleted, moving SL item to trash: ${key}`);
          await slItem.delete(); // moves to Trash, not permanent delete
        } catch (error) {
          console.warn(`[InventorySync] Failed to trash SL item ${key}:`, error);
        }
      }
      delete this.manifest.items[key];
    }

    // Walk local subdirectories bottom-up; remove empty directories without matching SL folder
    const localSubdirs = getLocalSubdirs(this.localDir);
    // Sort by depth descending (deepest first) for bottom-up removal
    localSubdirs.sort((a, b) => {
      const depthA = a.relativePath.split('/').length;
      const depthB = b.relativePath.split('/').length;
      return depthB - depthA;
    });

    for (const { relativePath: localRelPath, localDir } of localSubdirs) {
      if (slSanitizedPaths.has(localRelPath)) continue;

      // Only remove if empty
      try {
        const entries = fs.readdirSync(localDir);
        if (entries.length === 0) {
          pkDebug('inventory', `[InventorySync] Removing empty directory: ${localRelPath}`);
          fs.rmdirSync(localDir);
        }
      } catch {
        // Directory may already be gone
      }
    }
  }

  /** Rename duplicate names in SL to make them unique (per folder) */
  private async deduplicateSlNames(folderTree: FolderNode[], j2kAvailable: boolean): Promise<void> {
    const syncableTypes = [AssetType.Notecard, AssetType.LSLText];
    if (j2kAvailable) syncableTypes.unshift(AssetType.Texture);

    for (const node of folderTree) {
      const syncableItems = (node.folder.items as any[]).filter(i => syncableTypes.includes(i.type));
      const nameCount = new Map<string, any[]>();

      for (const item of syncableItems) {
        const list = nameCount.get(item.name) || [];
        list.push(item);
        nameCount.set(item.name, list);
      }

      for (const [name, items] of nameCount) {
        if (items.length <= 1) continue;

        const prefix = node.relativePath ? `${node.relativePath}/` : '';
        pkDebug('inventory', `[InventorySync] Found ${items.length} items named "${prefix}${name}", renaming duplicates`);
        // Keep the first one as-is, rename the rest
        for (let i = 1; i < items.length; i++) {
          const newName = `${name} (${i + 1})`;
          items[i].name = newName;
          await items[i].update();
          pkDebug('inventory', `[InventorySync] Renamed to "${prefix}${newName}"`);
        }
      }
    }
  }

  /** Get or create the sync folder in SL inventory */
  private async getOrCreateSyncFolder(): Promise<InventoryFolder | ViewerInventoryFolder> {
    const root = await this.getInventoryRoot();
    await root.populate(false);

    let syncFolder = root.folders.find((f: any) => f.name === SYNC_FOLDER_NAME);
    if (!syncFolder) {
      console.log(`[InventorySync] Creating "${SYNC_FOLDER_NAME}" folder in inventory`);
      syncFolder = await root.createFolder(SYNC_FOLDER_NAME, FolderType.None);
    }

    return syncFolder;
  }

  // --- Backend routing helpers ---

  private async getInventoryRoot(): Promise<InventoryFolder | ViewerInventoryFolder> {
    if (this.adapter) {
      return this.adapter.getRootFolder();
    }
    return this.bot!.clientCommands.inventory.getInventoryRoot();
  }

  private async getUploadCostValue(): Promise<number> {
    if (this.adapter) {
      return this.adapter.getUploadCost();
    }
    return this.bot!.agent.currentRegion.getUploadCost();
  }

  private async downloadAssetData(item: any, assetType: number): Promise<Buffer> {
    if (this.adapter) {
      return this.adapter.downloadAsset(item.itemID.toString(), assetType);
    }
    // For textures, use direct asset download; for notecards/scripts, use inventory download
    if (assetType === AssetType.Texture) {
      return this.bot!.clientCommands.asset.downloadAsset(AssetType.Texture, item.assetID.toString());
    }
    return this.bot!.clientCommands.asset.downloadInventoryAsset(
      item.itemID, item.permissions.owner, assetType, true
    );
  }

  // --- Manifest persistence ---

  private loadManifest(): Manifest {
    const manifestPath = path.join(this.localDir, MANIFEST_FILE);
    try {
      if (fs.existsSync(manifestPath)) {
        const data: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        // Migrate v1 → v2: v1 keys are bare item names (root folder), already correct
        if (data.version < 2) {
          console.log('[InventorySync] Migrating manifest v1 → v2');
          data.version = 2;
          // v1 items have no relativePath — they're all root items, keys are already name-only
          for (const entry of Object.values(data.items)) {
            if (!entry.relativePath) {
              entry.relativePath = '';
            }
          }
        }
        return data;
      }
    } catch (error) {
      console.error('[InventorySync] Error loading manifest:', error);
    }
    return { version: 2, lastSync: 0, uploadCost: -1, items: {} };
  }

  private saveManifest(): void {
    if (!fs.existsSync(this.localDir)) {
      fs.mkdirSync(this.localDir, { recursive: true });
    }
    const manifestPath = path.join(this.localDir, MANIFEST_FILE);
    fs.writeFileSync(manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  private setProgress(progress: Omit<SyncStatus, 'uploadCost'>): void {
    this.progress = { ...progress, uploadCost: this.manifest.uploadCost };
    this.onProgress?.(this.progress);
  }
}
