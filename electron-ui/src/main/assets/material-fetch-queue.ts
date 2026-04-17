/**
 * material-fetch-queue.ts — Concurrent material asset download queue with dedup and caching.
 * Downloads material assets from SL, parses LLSD wrapper + glTF JSON,
 * extracts PBR texture UUIDs and factors via LLGLTFMaterialOverride.
 */

import { AssetType } from '../../../node-metaverse/lib';
import type { Bot } from '../../../node-metaverse/lib';
import { LLGLTFMaterial } from '../../../node-metaverse/lib/classes/LLGLTFMaterial';
import { LLGLTFMaterialOverride } from '../../../node-metaverse/lib/classes/LLGLTFMaterialOverride';

const MAX_CONCURRENT = 8;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface TextureTransform {
  offset?: number[];  // [u, v]
  scale?: number[];   // [u, v] — equivalent to SL repeat
  rotation?: number;  // radians
}

export interface MaterialOverrideData {
  baseColorTextureId?: string;
  normalTextureId?: string;
  ormTextureId?: string;
  emissiveTextureId?: string;
  baseColor?: number[];
  metallicFactor?: number;
  roughnessFactor?: number;
  emissiveFactor?: number[];
  alphaMode?: number;
  alphaCutoff?: number;
  doubleSided?: boolean;
  // Per-texture transforms from KHR_texture_transform (index 0=baseColor, 1=normal)
  textureTransforms?: (TextureTransform | null)[];
}

export type MaterialReadyCallback = (materialUuid: string, data: MaterialOverrideData) => void;

export class MaterialFetchQueue {
  private bot: Bot;
  private onReady: MaterialReadyCallback;
  private cache = new Map<string, MaterialOverrideData>(); // materialUuid → parsed override
  private pending = new Set<string>(); // UUIDs currently queued or in-flight
  private active = 0;
  private queue: string[] = [];
  private failed = new Set<string>();
  private destroyed = false;
  /** Called when a material fetch permanently fails (unblocks readiness tracker). */
  onFailed?: (materialUuid: string) => void;

  constructor(bot: Bot, onReady: MaterialReadyCallback) {
    this.bot = bot;
    this.onReady = onReady;
  }

  get queueDepth(): number { return this.queue.length; }
  get activeCount(): number { return this.active; }
  get failedCount(): number { return this.failed.size; }
  get cachedCount(): number { return this.cache.size; }

  request(materialUuid: string): void {
    if (this.destroyed || this.failed.has(materialUuid)) return;
    if (!materialUuid || materialUuid === ZERO_UUID) return;

    // Already cached — fire callback immediately
    if (this.cache.has(materialUuid)) {
      this.onReady(materialUuid, this.cache.get(materialUuid)!);
      return;
    }

    // Already queued or in-flight
    if (this.pending.has(materialUuid)) return;

    this.pending.add(materialUuid);
    this.queue.push(materialUuid);
    this.drain();
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0 && !this.destroyed) {
      const uuid = this.queue.shift()!;
      this.active++;
      this.fetchAndParse(uuid).finally(() => {
        this.active--;
        this.pending.delete(uuid);
        this.drain();
      });
    }
  }

  private async fetchAndParse(materialUuid: string): Promise<void> {
    try {
      const buf = await this.bot.clientCommands.asset.downloadAsset(
        AssetType.Material, materialUuid
      );
      if (!buf || buf.length < 20) {
        console.warn(`[MaterialFetchQueue] Skipping ${materialUuid}: too small (${buf?.length ?? 0} bytes)`);
        this.failed.add(materialUuid);
        this.onFailed?.(materialUuid);
        return;
      }

      // Parse the LLSD wrapper → glTF JSON
      const gltfMat = new LLGLTFMaterial(buf);
      if (!gltfMat.data) {
        console.warn(`[MaterialFetchQueue] No data in material ${materialUuid}`);
        this.failed.add(materialUuid);
        this.onFailed?.(materialUuid);
        return;
      }

      // Parse glTF JSON into override using the existing parser
      const override = LLGLTFMaterialOverride.fromFullMaterialJSON(JSON.stringify(gltfMat.data));

      // Extract relevant fields into a plain object
      const data: MaterialOverrideData = {};

      if (override.textures && Array.isArray(override.textures)) {
        const t0 = override.textures[0]?.toString();
        const t1 = override.textures[1]?.toString();
        const t2 = override.textures[2]?.toString();
        const t3 = override.textures[3]?.toString();
        if (t0 && t0 !== ZERO_UUID) data.baseColorTextureId = t0;
        if (t1 && t1 !== ZERO_UUID) data.normalTextureId = t1;
        if (t2 && t2 !== ZERO_UUID) data.ormTextureId = t2;
        if (t3 && t3 !== ZERO_UUID) data.emissiveTextureId = t3;
      }
      if (override.baseColor) data.baseColor = override.baseColor;
      if (override.metallicFactor !== undefined) data.metallicFactor = override.metallicFactor;
      if (override.roughnessFactor !== undefined) data.roughnessFactor = override.roughnessFactor;
      if (override.emissiveFactor) data.emissiveFactor = override.emissiveFactor;
      if (override.alphaMode !== undefined) data.alphaMode = override.alphaMode;
      if (override.alphaCutoff !== undefined) data.alphaCutoff = override.alphaCutoff;
      if (override.doubleSided !== undefined) data.doubleSided = override.doubleSided;

      // Extract per-texture transforms (KHR_texture_transform)
      if (override.textureTransforms && Array.isArray(override.textureTransforms)) {
        const transforms: (TextureTransform | null)[] = [];
        let hasAny = false;
        for (let i = 0; i < override.textureTransforms.length; i++) {
          const tt = override.textureTransforms[i];
          if (tt) {
            transforms.push({
              offset: tt.offset,
              scale: tt.scale,
              rotation: tt.rotation,
            });
            hasAny = true;
          } else {
            transforms.push(null);
          }
        }
        if (hasAny) data.textureTransforms = transforms;
      }

      // Cache and notify
      this.cache.set(materialUuid, data);

      if (!this.destroyed) {
        this.onReady(materialUuid, data);
      }
    } catch (err: any) {
      const msg = err?.message || err?.code || String(err);
      console.error(`[MaterialFetchQueue] Failed ${materialUuid}: ${msg}`);
      this.failed.add(materialUuid);
      this.onFailed?.(materialUuid);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    this.pending.clear();
  }
}
