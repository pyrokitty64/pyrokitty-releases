/**
 * Manages avatar lifecycle — creation, attachment routing, departure sweeps,
 * and Bakes on Mesh (BoM) texture substitution.
 *
 * All avatar and object identity uses UUID strings (not numeric localIds).
 */

import type { Bot } from '../../../node-metaverse/dist/lib';
import { Message } from '../../../node-metaverse/dist/lib/enums/Message';
import { TextureEntry } from '../../../node-metaverse/dist/lib/classes/TextureEntry';
import type { AvatarAppearanceMessage } from '../../../node-metaverse/dist/lib/classes/messages/AvatarAppearance';
import type { Subscription } from 'rxjs';
import type { GodotObjectSender } from './godot-object-sender';
import type { GodotAnimationManager } from './godot-animation-manager';
import type { MaterialResolver } from '../materials/material-resolver';
import type { SendFn } from './godot-bridge-types';
import { isHudAttachment, BAKE_CHANNEL_NAMES, BAKE_CHANNEL_TO_TE_FACE, ZERO_UUID, slPos, slQuat } from './godot-bridge-types';
import { computeShapeDeltas } from '../avatar/avatar-shape';
import { pkDebug } from '../pk-debug';

export class GodotAvatarManager {
  private avatarAttachSubs = new Map<string, Subscription>();
  private objectSender!: GodotObjectSender;
  private connected = false;
  /** Called after avatar_create is sent — used to mark avatar as emitted in readiness tracker. */
  onAvatarEmitted?: (avatarUuid: string) => void;

  // BoM state: avatarUuid → array of 11 baked texture UUIDs (index = channel)
  private avatarBakedTextures = new Map<string, string[]>();
  // avatarUuid → set of attachment UUIDs that have magic bake UUIDs
  private avatarBakeObjects = new Map<string, Set<string>>();
  // Avatar shape: avatarUuid → pre-computed bone deltas (buffered until connected)
  private avatarShapes = new Map<string, Record<string, { scale: [number, number, number]; offset: [number, number, number] }>>();
  private avatarVolumeMorphs = new Map<string, Record<string, { scale: [number, number, number]; offset: [number, number, number] }>>();
  private avatarHoverHeights = new Map<string, number>(); // avatarUuid → hover height Z (meters)

  // Avatars that got avatar_create but had localId=0 (no ObjectUpdate yet).
  // Recovered when onNewObject fires for PCode 47 with a matching UUID.
  deferredAvatars = new Set<string>();

  private materialResolver: MaterialResolver | null = null;

  constructor(
    private bot: Bot,
    private send: SendFn,
    private trackedObjects: Set<string>,
    private trackedAvatars: Set<string>,
    private animationManager: GodotAnimationManager,
  ) {}

  /** Late-bind object sender to break circular dependency */
  setObjectSender(sender: GodotObjectSender): void {
    this.objectSender = sender;
  }

  /** Set references needed for BoM re-emit */
  initBom(materialResolver: MaterialResolver): void {
    this.materialResolver = materialResolver;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    // Flush buffered avatar shapes on (re)connect
    if (connected && this.avatarShapes.size > 0) {
      for (const [avatarId, bones] of this.avatarShapes) {
        const volumeMorphs = this.avatarVolumeMorphs.get(avatarId) || {};
        const hoverHeight = this.avatarHoverHeights.get(avatarId) || 0;
        this.send({ type: 'avatar_shape', avatarId, bones, volumeMorphs, hoverHeight });
      }
      pkDebug('avatar', `[AvatarShape] Flushed ${this.avatarShapes.size} buffered shapes on connect`);
    }
  }

  // ─── BoM: AvatarAppearance Subscription ───────────────────────

  /** Subscribe to AvatarAppearance circuit messages (persistent across region changes). */
  subscribeToAvatarAppearance(): { unsubscribe: () => void } {
    console.log(`[BoM] Subscribing to AvatarAppearance (Message.AvatarAppearance=${Message.AvatarAppearance})`);
    return this.bot.subscribeToCircuitMessages([
      Message.AvatarAppearance,
    ], (packet: any) => {
      try {
        const msg = packet.message as AvatarAppearanceMessage;
        const avatarId = msg.Sender.ID.toString();

        // Parse baked texture UUIDs from the avatar's TextureEntry
        // Baked faces are at specific ETextureIndex positions (8,9,10,11,20,21,40-44), NOT 0-10
        const te = TextureEntry.from(msg.ObjectData.TextureEntry);
        const bakes: string[] = [];
        for (let ch = 0; ch < 11; ch++) {
          const teFace = BAKE_CHANNEL_TO_TE_FACE[ch];
          if (te.explicitTextureFaces.has(teFace)) {
            // Face was explicitly set in the TextureEntry bitfield — real bake
            bakes.push(te.faces[teFace]?.textureID?.toString() || '');
          } else if (ch < 6) {
            // Basic channels (HEAD..HAIR): always present in AvatarAppearance.
            // If not explicitly set, the bake matches the TE default texture.
            bakes.push(te.defaultTexture?.textureID?.toString() || '');
          } else {
            // Universal channels (LEFTARM..AUX3): not explicitly set means
            // no bake exists for this channel.  Inheriting the default would
            // produce another channel's UUID → 404 from appearance service.
            bakes.push('');
          }
        }

        const prevBakes = this.avatarBakedTextures.get(avatarId);
        this.avatarBakedTextures.set(avatarId, bakes);

        // Log bake channels that have real textures
        const filled = bakes
          .map((uuid, i) => (uuid && uuid !== ZERO_UUID) ? `${BAKE_CHANNEL_NAMES[i]}=${uuid.slice(0, 8)}` : null)
          .filter(Boolean);
        const explicit = Array.from(te.explicitTextureFaces).sort((a, b) => a - b);
        pkDebug('avatar', `[BoM] AvatarAppearance for ${avatarId.slice(0, 8)}: ${filled.length}/11 bake channels — ${filled.join(', ')}  (explicitFaces: ${explicit.join(',')})`);

        // Check if bakes changed (or this is the first appearance)
        const changed = !prevBakes || bakes.some((b, i) => b !== prevBakes[i]);
        if (changed && this.connected) {
          this.reemitBakeUpdates(avatarId, bakes);
        }

        // Extract VisualParam bytes and compute skeleton shape deltas.
        // Always compute and store (appearance arrives before Godot connects);
        // send to Godot immediately if connected, otherwise avatar_create will
        // pick it up from _avatar_shapes on the Godot side.
        if (msg.VisualParam && msg.VisualParam.length > 0) {
          try {
            const bytes = msg.VisualParam.map((vp: { ParamValue: number }) => vp.ParamValue);
            const { bones, volumeMorphs, hoverHeight } = computeShapeDeltas(bytes);
            const boneCount = Object.keys(bones).length;
            if (boneCount > 0) {
              this.avatarShapes.set(avatarId, bones);
              this.avatarVolumeMorphs.set(avatarId, volumeMorphs);
              this.avatarHoverHeights.set(avatarId, hoverHeight);
              this.send({ type: 'avatar_shape', avatarId, bones, volumeMorphs, hoverHeight });
              // Debug: log key bone deltas for leg and body bones
              pkDebug('avatar', `[AvatarShape] ${avatarId.slice(0, 8)}: ${boneCount} bones, ${Object.keys(volumeMorphs).length} volume morphs`);
            }
          } catch (shapeErr) {
            console.warn('[AvatarShape] Error computing shape:', (shapeErr as Error).message);
          }
        }
      } catch (err) {
        console.warn('[BoM] Error parsing AvatarAppearance:', (err as Error).message);
      }
    });
  }

  // ─── BoM: Bake Lookup & Tracking ──────────────────────────────

  /** Seed baked textures from MetaverseConnection's early AvatarAppearance buffer */
  seedBakedTextures(buffer: Map<string, string[]>): void {
    for (const [avatarId, bakes] of buffer) {
      this.avatarBakedTextures.set(avatarId, bakes);
    }
    console.log(`[BoM] Seeded ${buffer.size} avatar bake entries from login buffer`);
  }

  /** Seed VisualParam bytes from MetaverseConnection's early AvatarAppearance buffer.
   *  Computes skeleton shape deltas and buffers them for when Godot connects. */
  seedVisualParams(buffer: Map<string, number[]>): void {
    for (const [avatarId, bytes] of buffer) {
      try {
        const { bones, volumeMorphs, hoverHeight } = computeShapeDeltas(bytes);
        if (Object.keys(bones).length > 0) {
          this.avatarShapes.set(avatarId, bones);
          if (Object.keys(volumeMorphs).length > 0) {
            this.avatarVolumeMorphs.set(avatarId, volumeMorphs);
          }
        }
        this.avatarHoverHeights.set(avatarId, hoverHeight);
      } catch (err) {
        console.warn(`[AvatarShape] Error computing shape for ${avatarId.slice(0, 8)}:`, (err as Error).message);
      }
    }
    console.log(`[AvatarShape] Seeded ${this.avatarShapes.size} avatar shapes from login buffer`);
  }

  /** Get baked texture UUIDs for an avatar (11 entries, index = channel) */
  getBakedTextures(avatarId: string): string[] | undefined {
    return this.avatarBakedTextures.get(avatarId);
  }

  /**
   * Find which avatar UUID owns an object, by walking up the parent chain using UUIDs.
   * Returns undefined if the object is not an avatar attachment.
   */
  findOwnerAvatar(parentUuid: string, depth = 0): string | undefined {
    if (depth > 4 || !parentUuid || parentUuid === ZERO_UUID) return undefined;
    // Check if the parent itself is a tracked avatar
    if (this.trackedAvatars.has(parentUuid)) return parentUuid;
    try {
      const parent = this.bot.currentRegion.objects.getObjectByUUID(parentUuid as any);
      if (parent?.ParentID) {
        // Walk up: get the parent's parent object by localId, then recurse with its UUID
        const grandparent = this.bot.currentRegion.objects.getObjectByLocalID(parent.ParentID);
        if (grandparent) {
          const grandparentUuid = grandparent.FullID?.toString();
          if (grandparentUuid) return this.findOwnerAvatar(grandparentUuid, depth + 1);
        }
      }
    } catch { /* empty */ }
    return undefined;
  }

  /** Track an object UUID as having bake UUIDs for a given avatar */
  trackBakeObject(avatarId: string, objectUuid: string): void {
    let set = this.avatarBakeObjects.get(avatarId);
    if (!set) {
      set = new Set();
      this.avatarBakeObjects.set(avatarId, set);
    }
    set.add(objectUuid);
  }

  /** Remove an object UUID from bake tracking (called on object kill) */
  removeBakeObject(objectUuid: string): void {
    for (const set of this.avatarBakeObjects.values()) {
      set.delete(objectUuid);
    }
  }

  /**
   * Re-emit face updates for all tracked bake objects of an avatar.
   * Called when AvatarAppearance arrives or changes.
   */
  private reemitBakeUpdates(avatarId: string, _bakes: string[]): void {
    const objectSet = this.avatarBakeObjects.get(avatarId);
    if (!objectSet || objectSet.size === 0) {
      // No tracked bake objects yet — attachments may not have arrived.
      // They'll get substituted when sendObject runs.
      return;
    }

    if (!this.materialResolver) return;

    // Delegate to MaterialResolver — it handles bake substitution,
    // face re-resolution, texture fetches, and callback emission.
    this.materialResolver.handleBakeTextureUpdate(avatarId, objectSet);
    pkDebug('avatar', `[BoM] Re-emitted face updates for ${objectSet.size} objects of avatar ${avatarId.slice(0, 8)}`);
  }

  // ─── Avatar Lifecycle ─────────────────────────────────────────

  /** Send avatar_create with UUID for attachment routing + skeleton creation */
  sendAvatarCreate(avatar: any, id: string): void {
    const pos = avatar.position;
    const rot = avatar.getRotation();
    let localId = 0;
    try {
      const gameObj = (avatar as any)._gameObject;
      if (gameObj) localId = gameObj.ID;
    } catch { /* gameObject may not be set yet */ }

    // Resolve parent UUID for seated avatars
    const parentLocalId = (avatar as any)._gameObject?.ParentID || 0;
    let parentUuid = '';
    if (parentLocalId > 0) {
      try {
        const parentObj = this.bot.currentRegion.objects.getObjectByLocalID(parentLocalId);
        if (parentObj) {
          parentUuid = parentObj.FullID?.toString() || '';
        }
      } catch { /* parent may not be in store */ }
    }

    const isSelf = id === this.bot.agent?.agentID?.toString();
    if (isSelf) {
      console.log(`[SelfAvatar] === Creating self avatar uuid=${id.slice(0, 8)} localId=${localId} name=${avatar.getName()} ===`);
    }

    this.send({
      type: 'avatar_create',
      id,
      name: avatar.getName(),
      position: slPos(pos),
      rotation: slQuat(rot),
      parentUuid,
    });
    this.trackedAvatars.add(id);
    if (this.onAvatarEmitted) this.onAvatarEmitted(id);
    if (localId === 0) {
      // Avatar known from agent list but no ObjectUpdate yet (distant avatar).
      // Mark as tracked to prevent redundant re-creates, but add to deferred set
      // so onNewObject can recover it when the ObjectUpdate arrives with a real localId.
      this.deferredAvatars.add(id);
      pkDebug('avatar', `[Avatar] ${id.slice(0, 8)} has localId=0, deferring attachments until ObjectUpdate arrives`);
    } else {
      this.deferredAvatars.delete(id);
    }

    // Track self-avatar UUID for attachment tagging
    if (isSelf) {
      this.objectSender.selfAvatarUuid = id;
    }

    // Attachments arrive via onNewObject → sendObject → readiness tracker.
    // Parent ordering gate holds them until markEmitted(avatarUuid) fires above.
    // No need to enumerate getAttachments() — normal object pipeline handles it.
    const avLocalId = localId || 0;

    // Subscribe to late-arriving attachments
    if (avLocalId > 0) {
      this.avatarAttachSubs.get(id)?.unsubscribe();
      const attachSub = avatar.onAttachmentAdded.subscribe((obj: any) => {
        if (!this.connected) return;
        const objUuid = obj.FullID?.toString() || '';
        if (isHudAttachment(obj)) return;
        if (objUuid && this.trackedObjects.has(objUuid)) return;
        this.objectSender.sendObject(obj, id);
        this.objectSender.sendChildren(obj);
      });
      this.avatarAttachSubs.set(id, attachSub);

    }

    // Replay buffered avatar animations
    const buffered = this.animationManager.getBufferedAvatarAnims(id);
    if (buffered && buffered.length > 0 && localId > 0) {
      this.animationManager.updateAnimSet(id, buffered.map(a => a.animId));
    }
  }

  /** Sweep for avatars that left the region */
  sweepAvatarDepartures(): void {
    try {
      const agents = this.bot.currentRegion.agents;
      for (const id of this.trackedAvatars) {
        if (!agents.has(id)) {
          this.send({ type: 'avatar_kill', id });
          this.trackedAvatars.delete(id);
          this.animationManager.cleanupAvatar(id);
          this.avatarAttachSubs.get(id)?.unsubscribe();
          this.avatarAttachSubs.delete(id);
          // Clean up BoM + shape state
          this.avatarBakedTextures.delete(id);
          this.avatarBakeObjects.delete(id);
          this.avatarShapes.delete(id);
          this.avatarVolumeMorphs.delete(id);
        }
      }
    } catch { /* bot may be disconnected */ }
  }

  cleanup(): void {
    for (const sub of this.avatarAttachSubs.values()) {
      sub.unsubscribe();
    }
    this.avatarAttachSubs.clear();
    this.avatarBakedTextures.clear();
    this.avatarBakeObjects.clear();
    this.deferredAvatars.clear();
    // NOTE: avatarShapes intentionally NOT cleared — AvatarAppearance messages
    // are only sent on initial appearance or changes. If we clear here, shapes
    // won't be available when the Godot viewer reconnects, causing avatars to
    // render without shape deformation until a new AvatarAppearance arrives.
  }
}
