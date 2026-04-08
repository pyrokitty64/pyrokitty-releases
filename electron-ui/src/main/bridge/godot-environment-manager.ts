/**
 * GodotEnvironmentManager — Terrain heights, parcel environment, day cycle,
 * and sun/ambient color computation. Formatting + sending only — does NOT
 * subscribe to node-metaverse events. The caller (GodotBridge or any viewer
 * bridge) is responsible for subscribing to ClientEvents and calling into
 * these methods.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { Bot } from '../../../node-metaverse/dist/lib';
import { RegionEnvironment } from '../../../node-metaverse/dist/lib/classes/public/RegionEnvironment';
import { LLSD } from '../../../node-metaverse/dist/lib/classes/llsd/LLSD';
import type { Region } from '../../../node-metaverse/dist/lib/classes/Region';
import type { TerrainCompleteEvent } from '../../../node-metaverse/dist/lib/events/TerrainCompleteEvent';
import { pkDebug } from '../pk-debug';

function getCacheDirBase(): string {
  return path.join(app.getPath('userData'), 'asset-cache');
}

export class GodotEnvironmentManager {
  private bot: Bot;
  private send: (msg: object) => void;
  private envTimer: ReturnType<typeof setInterval> | null = null;
  private _parcelEnvCache: { parcelId: number; env: RegionEnvironment | null; fetchedAt: number } | null = null;
  private _parcelEnvFetching = false;
  private static readonly PARCEL_ENV_TTL_MS = 30_000;

  constructor(bot: Bot, send: (msg: object) => void) {
    this.bot = bot;
    this.send = send;
  }

  /** Write terrain from a TerrainCompleteEvent and send terrain_ready to Godot. */
  sendTerrainEvent(evt: TerrainCompleteEvent): void {
    this.writeTerrain(evt.cacheID.toString(), evt.gridX, evt.gridY, evt.waterHeight, evt.terrain);
  }

  /** Write terrain from a Region and send terrain_ready to Godot. */
  sendRegionTerrain(region: Region, offsetX = 0, offsetY = 0): void {
    this.writeTerrain(
      region.cacheID?.toString() ?? 'unknown',
      region.xCoordinate,
      region.yCoordinate,
      region.waterHeight,
      region.terrain,
      offsetX,
      offsetY,
    );
  }

  private writeTerrain(cacheId: string, gridX: number, gridY: number, waterHeight: number, terrain: number[][], offsetX = 0, offsetY = 0): void {
    // Write terrain as raw Float32 binary to cache file (256KB)
    const buf = Buffer.alloc(256 * 256 * 4);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const h = terrain[y]?.[x] ?? 0;
        buf.writeFloatLE(h < 0 ? 0 : h, (y * 256 + x) * 4);
      }
    }

    const terrainDir = path.join(getCacheDirBase(), 'terrain');
    const safeName = cacheId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cachePath = path.join(terrainDir, `${safeName}.bin`);
    fs.writeFileSync(cachePath, buf);

    // Also write grid-indexed copy for 3D map lookup
    const gridPath = path.join(terrainDir, `grid-${gridX}-${gridY}.bin`);
    fs.writeFileSync(gridPath, buf);
    const fwdPath = cachePath.replace(/\\/g, '/');

    pkDebug('terrain', `[GodotBridge] Terrain cached for region ${gridX},${gridY} (waterHeight=${waterHeight})`);
    this.send({
      type: 'terrain_ready',
      path: fwdPath,
      waterHeight: waterHeight ?? 20,
      cacheID: cacheId,
      gridX,
      gridY,
      offsetX,
      offsetY,
    });
  }

  /** Send terrain for the current main region (initial load / region change).
   *  Waits for terrain to arrive, then sends directly. */
  async sendTerrain(): Promise<void> {
    const region = this.bot.currentRegion;

    try {
      await region.waitForTerrain();
    } catch {
      console.warn('[GodotBridge] Terrain wait timed out, sending what we have');
    }

    this.sendRegionTerrain(region);

    // Clear parcel env cache on region change (parcel IDs are per-region)
    this._parcelEnvCache = null;
    // Send environment data and start periodic day cycle updates
    this.sendEnvironment();
    // Update sun position every 5s to track the day cycle
    if (!this.envTimer) {
      this.envTimer = setInterval(() => this.sendEnvironment(), 5000);
    }
  }

  /** Rotate x_axis (1,0,0) by quaternion to get sun direction.
   *  SL's operator*(v, q) in llquaternion.cpp:571 computes q * v * q^-1 (standard rotation). */
  private static sunRotToDir(q: { x: number; y: number; z: number; w: number }): number[] {
    return [
      1 - 2 * (q.y * q.y + q.z * q.z),
      2 * (q.x * q.y + q.z * q.w),
      2 * (q.x * q.z - q.y * q.w),
    ];
  }

  /** Extract sun color as [r, g, b] clamped to [0,1] */
  private static extractColor(c: any): number[] | null {
    if (!c) return null;
    const r = (c as any).x ?? 0;
    const g = (c as any).y ?? 0;
    const b = (c as any).z ?? 0;
    return [Math.min(r, 1), Math.min(g, 1), Math.min(b, 1)];
  }

  /** Lerp between two [r,g,b] arrays */
  private static lerpColor(a: number[], b: number[], t: number): number[] {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /** Get the agent's avatar position, or null if unavailable. */
  private getAgentPosition(): { x: number; y: number; z: number } | null {
    try {
      const selfId = this.bot.agent?.agentID?.toString();
      if (!selfId) return null;
      const avatar = this.bot.currentRegion?.agents.get(selfId);
      return avatar?.position ?? null;
    } catch { return null; }
  }

  /** Resolve the real parcel LocalID at the agent's position. */
  private async getAgentParcelId(): Promise<number> {
    try {
      const pos = this.getAgentPosition();
      if (!pos) return -1;
      return await this.bot.currentRegion.getParcelLocalId(pos.x, pos.y);
    } catch { return -1; }
  }

  /** Fetch parcel environment override if needed (cached by parcel ID). */
  private async fetchParcelEnvironment(parcelId: number): Promise<RegionEnvironment | null> {
    if (parcelId <= 0) return null;
    // Return cached if same parcel and not expired
    if (this._parcelEnvCache && this._parcelEnvCache.parcelId === parcelId
        && (Date.now() - this._parcelEnvCache.fetchedAt) < GodotEnvironmentManager.PARCEL_ENV_TTL_MS) {
      return this._parcelEnvCache.env;
    }
    // Avoid concurrent fetches
    if (this._parcelEnvFetching) return this._parcelEnvCache?.env ?? null;
    this._parcelEnvFetching = true;
    try {
      const region = this.bot.currentRegion;
      const xml = await region.caps.capsGetString(['ExtEnvironment', { parcelid: String(parcelId) }]);
      const parsed = LLSD.parseXML(xml);
      const parcelEnv = new RegionEnvironment(parsed);
      // If is_default, the parcel uses the region environment — no override
      if (parcelEnv.isDefault) {
        this._parcelEnvCache = { parcelId, env: null, fetchedAt: Date.now() };
        pkDebug('env', `[Env] Parcel ${parcelId} uses region default environment`);
      } else {
        this._parcelEnvCache = { parcelId, env: parcelEnv, fetchedAt: Date.now() };
        pkDebug('env', `[Env] Parcel ${parcelId} has environment override (dayLength=${parcelEnv.dayLength})`);
      }
      return this._parcelEnvCache.env;
    } catch (err) {
      console.warn(`[Env] Failed to fetch parcel ${parcelId} environment:`, err);
      this._parcelEnvCache = { parcelId, env: null, fetchedAt: Date.now() };
      return null;
    } finally {
      this._parcelEnvFetching = false;
    }
  }

  sendEnvironment(): void {
    // Kick off async parcel ID resolve + env fetch, then compute and send
    this.getAgentParcelId().then((parcelId) => {
      return this.fetchParcelEnvironment(parcelId);
    }).then((parcelEnv) => {
      this._sendEnvironmentData(parcelEnv);
    }).catch(() => {
      this._sendEnvironmentData(null);
    });
  }

  private _sendEnvironmentData(parcelEnv: RegionEnvironment | null): void {
    try {
      // Use parcel environment if available, otherwise fall back to region
      const regionEnv = this.bot.currentRegion.environment;
      const env = parcelEnv ?? regionEnv;
      const dayCycle = env?.dayCycle;

      // Defaults
      let sunDir = [0.5, 0.7, -0.5];
      let sunColor = [1.0, 0.95, 0.8];
      let ambientColor = [0.3, 0.35, 0.4];

      // Water defaults (will be overridden by EEP water track 0)
      let waterFogColor: number[] | null = null;
      let waterFogDensity: number | null = null;
      let fresnelOffset: number | null = null;
      let fresnelScale: number | null = null;
      let wave1Direction: number[] | null = null;
      let wave2Direction: number[] | null = null;

      if (dayCycle && dayCycle.tracks && dayCycle.frames && env!.dayLength) {
        const dayLength = env!.dayLength;   // seconds
        const dayOffset = env!.dayOffset ?? 0; // seconds
        const nowSec = Date.now() / 1000;
        const position = ((nowSec + dayOffset) % dayLength) / dayLength;

        // Sky track is track 1 (track 0 = water)
        const skyTrack = dayCycle.tracks[1];
        if (skyTrack && skyTrack.length > 0) {
          type SkyKeyframe = { pos: number; sunRot: any; sunColor: any; ambient: any };
          const keyframes: SkyKeyframe[] = [];
          for (const kf of skyTrack) {
            const frame = dayCycle.frames.get(kf.keyName);
            if (frame?.sunRotation) {
              keyframes.push({
                pos: kf.keyKeyframe,
                sunRot: frame.sunRotation,
                sunColor: GodotEnvironmentManager.extractColor(frame.sunlightColor),
                ambient: GodotEnvironmentManager.extractColor((frame as any).legacyHaze?.ambient),
              });
            }
          }
          keyframes.sort((a, b) => a.pos - b.pos);

          if (keyframes.length === 1) {
            sunDir = GodotEnvironmentManager.sunRotToDir(keyframes[0].sunRot);
            if (keyframes[0].sunColor) sunColor = keyframes[0].sunColor;
            if (keyframes[0].ambient) ambientColor = keyframes[0].ambient;
          } else if (keyframes.length >= 2) {
            let before = keyframes[keyframes.length - 1];
            let after = keyframes[0];
            for (let i = 0; i < keyframes.length; i++) {
              if (keyframes[i].pos > position) {
                after = keyframes[i];
                before = keyframes[(i - 1 + keyframes.length) % keyframes.length];
                break;
              }
              if (i === keyframes.length - 1) {
                before = keyframes[keyframes.length - 1];
                after = keyframes[0];
              }
            }

            let span = after.pos - before.pos;
            if (span <= 0) span += 1.0;
            let local = position - before.pos;
            if (local < 0) local += 1.0;
            const t = span > 0 ? local / span : 0;

            const blended = before.sunRot.shortMix(after.sunRot, t);
            sunDir = GodotEnvironmentManager.sunRotToDir(blended);

            const sc1 = before.sunColor ?? sunColor;
            const sc2 = after.sunColor ?? sunColor;
            sunColor = GodotEnvironmentManager.lerpColor(sc1, sc2, t);

            const ac1 = before.ambient ?? ambientColor;
            const ac2 = after.ambient ?? ambientColor;
            ambientColor = GodotEnvironmentManager.lerpColor(ac1, ac2, t);
          }
        }
        // Water track is track 0
        const waterTrack = dayCycle.tracks[0];
        if (waterTrack && waterTrack.length > 0) {
          // Water settings rarely animate — use nearest keyframe or interpolate
          let waterFrame: any = null;
          if (waterTrack.length === 1) {
            waterFrame = dayCycle.frames.get(waterTrack[0].keyName);
          } else {
            // Find surrounding keyframes and lerp (same logic as sky)
            const wkfs = waterTrack.map((kf: any) => ({
              pos: kf.keyKeyframe,
              frame: dayCycle.frames?.get(kf.keyName),
            })).filter((k: any) => k.frame).sort((a: any, b: any) => a.pos - b.pos);

            if (wkfs.length === 1) {
              waterFrame = wkfs[0].frame;
            } else if (wkfs.length >= 2) {
              // Just use the nearest keyframe for water — interpolating fog colors
              // is overkill for the typical single-keyframe water track
              let nearest = wkfs[0];
              let minDist = Math.abs(position - nearest.pos);
              for (const wk of wkfs) {
                const d = Math.min(Math.abs(position - wk.pos), Math.abs(position - wk.pos + 1), Math.abs(position - wk.pos - 1));
                if (d < minDist) { nearest = wk; minDist = d; }
              }
              waterFrame = nearest.frame;
            }
          }
          if (waterFrame) {
            if (waterFrame.waterFogColor) {
              const c = waterFrame.waterFogColor;
              waterFogColor = [c.x ?? 0, c.y ?? 0, c.z ?? 0];
            }
            if (waterFrame.waterFogDensity != null) waterFogDensity = waterFrame.waterFogDensity;
            if (waterFrame.fresnelOffset != null) fresnelOffset = waterFrame.fresnelOffset;
            if (waterFrame.fresnelScale != null) fresnelScale = waterFrame.fresnelScale;
            if (waterFrame.wave1Direction) {
              const w = waterFrame.wave1Direction;
              wave1Direction = [w.x ?? 0, w.y ?? 0];
            }
            if (waterFrame.wave2Direction) {
              const w = waterFrame.wave2Direction;
              wave2Direction = [w.x ?? 0, w.y ?? 0];
            }
          }
        }
      } else if (dayCycle) {
        let sunRot = dayCycle.sunRotation;
        let slColor = dayCycle.sunlightColor;
        if (!sunRot && dayCycle.frames) {
          for (const [, frame] of dayCycle.frames) {
            if (frame.sunRotation) {
              sunRot = frame.sunRotation;
              if (!slColor && frame.sunlightColor) slColor = frame.sunlightColor;
              break;
            }
          }
        }
        if (sunRot) sunDir = GodotEnvironmentManager.sunRotToDir(sunRot);
        const sc = GodotEnvironmentManager.extractColor(slColor);
        if (sc) sunColor = sc;

        const haze = (dayCycle as any).legacyHaze;
        const ac = GodotEnvironmentManager.extractColor(haze?.ambient);
        if (ac) ambientColor = ac;

        // Water settings may live directly on a single-frame dayCycle
        if (dayCycle.waterFogColor) {
          const c = dayCycle.waterFogColor;
          waterFogColor = [(c as any).x ?? 0, (c as any).y ?? 0, (c as any).z ?? 0];
        }
        if (dayCycle.waterFogDensity != null) waterFogDensity = dayCycle.waterFogDensity;
        if (dayCycle.fresnelOffset != null) fresnelOffset = dayCycle.fresnelOffset;
        if (dayCycle.fresnelScale != null) fresnelScale = dayCycle.fresnelScale;
        if (dayCycle.wave1Direction) {
          const w = dayCycle.wave1Direction;
          wave1Direction = [(w as any).x ?? 0, (w as any).y ?? 0];
        }
        if (dayCycle.wave2Direction) {
          const w = dayCycle.wave2Direction;
          wave2Direction = [(w as any).x ?? 0, (w as any).y ?? 0];
        }
      }

      const msg: Record<string, any> = {
        type: 'environment_data',
        sunDirection: sunDir,
        sunColor,
        ambientColor,
      };
      if (waterFogColor) msg.waterFogColor = waterFogColor;
      if (waterFogDensity != null) msg.waterFogDensity = waterFogDensity;
      if (fresnelOffset != null) msg.fresnelOffset = fresnelOffset;
      if (fresnelScale != null) msg.fresnelScale = fresnelScale;
      if (wave1Direction) msg.wave1Direction = wave1Direction;
      if (wave2Direction) msg.wave2Direction = wave2Direction;
      this.send(msg);
    } catch (err) {
      console.error('[GodotBridge] Error sending environment:', err);
    }
  }

  /** Clear parcel env cache for region change (without stopping the timer) */
  clearParcelCache(): void {
    this._parcelEnvCache = null;
    this._parcelEnvFetching = false;
  }

  cleanup(): void {
    if (this.envTimer) {
      clearInterval(this.envTimer);
      this.envTimer = null;
    }
    this._parcelEnvCache = null;
    this._parcelEnvFetching = false;
  }
}
