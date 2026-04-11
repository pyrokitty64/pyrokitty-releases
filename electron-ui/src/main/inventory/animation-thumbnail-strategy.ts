/**
 * animation-thumbnail-strategy.ts — Generates 3D thumbnails for SL animations
 * by posing a cached Ruth mesh at the animation's mid-frame.
 *
 * Flow: download anim asset → parse with LLAnimation → sample mid-frame →
 * load cached Ruth GLBs → send to Three.js renderer with bone pose data.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Bot } from '../../../node-metaverse/lib/Bot';
import { AssetType } from '../../../node-metaverse/lib/enums/AssetType';
import type { InventoryItem } from '../../../node-metaverse/lib/classes/InventoryItem';
import { LLAnimation } from '../../../node-metaverse/lib/classes/LLAnimation';
import { renderThumbnail, type LinksetRenderData, type PrimRenderData } from '../assets/thumbnail-window';
import { pkDebug } from '../pk-debug';

// Ruth 2.0 GLB files shipped in shared/ruth/ (from RuthTooRC3 Body w/hands)
const RUTH_GLBS = [
  'ruth-lower-body.glb',
  'ruth-feet.glb',
  'ruth-hands.glb',
  'ruth-upper-body.glb',
];

function findSharedDir(): string {
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'shared', 'ruth')] : []),
    path.join(__dirname, '..', '..', '..', 'shared', 'ruth'),
    path.join(__dirname, '..', '..', '..', '..', 'shared', 'ruth'),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      return p;
    } catch { /* empty */ }
  }
  throw new Error('shared/ruth/ directory not found — Ruth GLBs must be shipped with the repo');
}

/** Load a Ruth GLB from shared/ruth/. */
function loadRuthGlb(glbName: string): Buffer | null {
  try {
    const dir = findSharedDir();
    return fs.readFileSync(path.join(dir, glbName));
  } catch (err: any) {
    pkDebug('inventory', `[AnimThumb] Failed to load Ruth mesh ${glbName}: ${err.message}`);
    return null;
  }
}

/** Sample the animation at a given time, returning per-joint rotation (x,y,z → derive w) */
function sampleAnimation(
  anim: LLAnimation, time: number
): Record<string, { rot?: [number, number, number]; pos?: [number, number, number] }> {
  const pose: Record<string, { rot?: [number, number, number]; pos?: [number, number, number] }> = {};

  for (const joint of anim.joints) {
    const entry: { rot?: [number, number, number]; pos?: [number, number, number] } = {};

    // Sample rotation keyframes
    if (joint.rotationKeyframes.length > 0) {
      const kfs = joint.rotationKeyframes;
      if (kfs.length === 1 || time <= kfs[0].time) {
        const t = kfs[0].transform;
        entry.rot = [t.x, t.y, t.z];
      } else if (time >= kfs[kfs.length - 1].time) {
        const t = kfs[kfs.length - 1].transform;
        entry.rot = [t.x, t.y, t.z];
      } else {
        // Find surrounding keyframes and lerp
        for (let i = 0; i < kfs.length - 1; i++) {
          if (time >= kfs[i].time && time <= kfs[i + 1].time) {
            const alpha = (time - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
            const a = kfs[i].transform, b = kfs[i + 1].transform;
            entry.rot = [
              a.x + (b.x - a.x) * alpha,
              a.y + (b.y - a.y) * alpha,
              a.z + (b.z - a.z) * alpha,
            ];
            break;
          }
        }
      }
    }

    // Sample position keyframes
    if (joint.positionKeyframes.length > 0) {
      const kfs = joint.positionKeyframes;
      if (kfs.length === 1 || time <= kfs[0].time) {
        const t = kfs[0].transform;
        entry.pos = [t.x, t.y, t.z];
      } else if (time >= kfs[kfs.length - 1].time) {
        const t = kfs[kfs.length - 1].transform;
        entry.pos = [t.x, t.y, t.z];
      } else {
        for (let i = 0; i < kfs.length - 1; i++) {
          if (time >= kfs[i].time && time <= kfs[i + 1].time) {
            const alpha = (time - kfs[i].time) / (kfs[i + 1].time - kfs[i].time);
            const a = kfs[i].transform, b = kfs[i + 1].transform;
            entry.pos = [
              a.x + (b.x - a.x) * alpha,
              a.y + (b.y - a.y) * alpha,
              a.z + (b.z - a.z) * alpha,
            ];
            break;
          }
        }
      }
    }

    if (entry.rot || entry.pos) {
      pose[joint.name] = entry;
    }
  }

  return pose;
}

/**
 * Generate a 3D thumbnail for an animation by posing Ruth at the mid-frame.
 * Returns the PNG buffer on success, or null on failure.
 */
export async function generateAnimationThumbnail(
  bot: Bot,
  item: InventoryItem,
): Promise<Buffer | null> {
  const assetId = item.assetID.toString();
  if (!assetId || assetId === '00000000-0000-0000-0000-000000000000') return null;

  try {
    // Download animation asset
    const animBuf = await bot.clientCommands.asset.downloadAsset(AssetType.Animation, assetId);
    const anim = new LLAnimation(animBuf);
    pkDebug('inventory', `[AnimThumb] "${item.name}": ${anim.jointCount} joints, duration=${anim.length.toFixed(2)}s`);

    // Sample at mid-frame
    const midTime = anim.length / 2;
    const pose = sampleAnimation(anim, midTime);
    pkDebug('inventory', `[AnimThumb] "${item.name}": sampled ${Object.keys(pose).length} joints at t=${midTime.toFixed(2)}`);

    // Load all Ruth mesh parts
    const glbResults = RUTH_GLBS.map(name => loadRuthGlb(name));

    // Light purple tint for the mannequin
    const bodyColor: Record<number, [number, number, number, number]> = {};
    for (let i = 0; i < 9; i++) bodyColor[i] = [0.7, 0.6, 0.8, 1.0];

    const prims: PrimRenderData[] = [];
    for (const glb of glbResults) {
      if (glb) {
        prims.push({
          glb: new Uint8Array(glb),
          position: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          textures: {},
          colors: bodyColor,
        });
      }
    }

    if (prims.length === 0) {
      pkDebug('inventory', `[AnimThumb] No Ruth meshes available for "${item.name}"`);
      return null;
    }

    const linksetData: LinksetRenderData = {
      prims,
      bonePose: pose,
    };

    return await renderThumbnail(linksetData);
  } catch (err: any) {
    pkDebug('inventory', `[AnimThumb] Failed for "${item.name}": ${err.message}`);
    return null;
  }
}
