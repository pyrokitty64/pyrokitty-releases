/**
 * SceneManager — viewer-agnostic layer that subscribes to node-metaverse
 * ClientEvents once and forwards scene data to registered ViewerAdapters.
 *
 * Handles:
 *  - Multi-region awareness (main + child regions)
 *  - Initial state snapshot (all regions' objects, avatars, terrain)
 *  - Live event forwarding (new/updated/killed objects, avatars, terrain, environment)
 *  - Region change (teleport) notification
 *
 * Each viewer (Godot, Firestorm, etc.) implements ViewerAdapter and registers
 * with the SceneManager to receive scene data.
 */

import type { Subscription } from 'rxjs';
import type { Bot } from '../../../node-metaverse/lib';
import type { Region } from '../../../node-metaverse/lib/classes/Region';
import type { NewObjectEvent } from '../../../node-metaverse/lib/events/NewObjectEvent';
import type { ObjectUpdatedEvent } from '../../../node-metaverse/lib/events/ObjectUpdatedEvent';
import type { ObjectResolvedEvent } from '../../../node-metaverse/lib/events/ObjectResolvedEvent';
import type { SelectedObjectEvent } from '../../../node-metaverse/lib/events/SelectedObjectEvent';
import type { TerrainCompleteEvent } from '../../../node-metaverse/lib/events/TerrainCompleteEvent';
import type { ParcelOverlayCompleteEvent } from '../../../node-metaverse/lib/events/ParcelOverlayCompleteEvent';
import type { RegionEnvironmentEvent } from '../../../node-metaverse/lib/events/RegionEnvironmentEvent';
import type { Avatar } from '../../../node-metaverse/lib/classes/public/Avatar';
import { TeleportEventType } from '../../../node-metaverse/lib/enums/TeleportEventType';
/** Legacy vegetation PCodes — not supported, skip entirely */
const VEGETATION_PCODES = new Set([95, 111, 255]); // Grass, NewTree, Tree
function isVegetation(obj: any): boolean {
  return VEGETATION_PCODES.has(obj.PCode);
}

export interface ViewerAdapter {
  /** Terrain data ready for a region. */
  onTerrain(region: Region): void;

  /** New object arrived. */
  onNewObject(event: NewObjectEvent): void;

  /** Object updated (full). */
  onObjectUpdated(event: ObjectUpdatedEvent): void;

  /** Object updated (terse/positional). */
  onObjectUpdatedTerse(event: ObjectUpdatedEvent): void;

  /** Object properties resolved (name, description, etc.). */
  onObjectResolved(event: ObjectResolvedEvent): void;

  /** Object selected. */
  onObjectSelected(event: SelectedObjectEvent): void;

  /** Avatar entered a region. */
  onAvatarEntered(avatar: Avatar): void;

  /** Region environment data available. */
  onEnvironment(event: RegionEnvironmentEvent): void;

  /** Parcel overlay complete for a region. */
  onParcelOverlay(event: ParcelOverlayCompleteEvent): void;

  /** World origin updated (login or teleport). All positions should be offset relative to this. */
  onWorldOrigin(originX: number, originY: number): void;

  /** Agent is changing regions (teleport). Clear scene state. */
  onRegionChange(): void;

  /**
   * Full initial state for all known regions. Called when a viewer connects
   * (or reconnects). The adapter should send all current state to the viewer.
   * allRegions includes main + any connected children.
   */
  onInitialState(allRegions: Region[]): void;
}

export class SceneManager {
  private bot: Bot;
  private adapters: ViewerAdapter[] = [];
  private subscriptions: Subscription[] = [];

  /** World origin in meters — set from main region's grid position at login/teleport.
   *  All viewer positions are relative to this origin for float32 precision. */
  worldOriginX = 0;
  worldOriginY = 0;

  constructor(bot: Bot) {
    this.bot = bot;
    this.updateWorldOrigin();
    this.subscribe();
  }

  /** Update world origin from the current main region. */
  updateWorldOrigin(): void {
    try {
      const main = this.bot.currentRegion;
      if (main) {
        this.worldOriginX = (main.xCoordinate ?? 0) * 256;
        this.worldOriginY = (main.yCoordinate ?? 0) * 256;
      }
    } catch { /* bot may not be connected yet */ }
  }

  /** Get a region's offset from world origin in meters. */
  getRegionOffset(region: Region): { x: number; y: number } {
    return {
      x: (region.xCoordinate ?? 0) * 256 - this.worldOriginX,
      y: (region.yCoordinate ?? 0) * 256 - this.worldOriginY,
    };
  }

  /** Register a viewer adapter to receive scene events. */
  addAdapter(adapter: ViewerAdapter): void {
    this.adapters.push(adapter);
  }

  /** Remove a viewer adapter. */
  removeAdapter(adapter: ViewerAdapter): void {
    const idx = this.adapters.indexOf(adapter);
    if (idx >= 0) this.adapters.splice(idx, 1);
  }

  /** Get all currently known regions (main + children). */
  getAllRegions(): Region[] {
    const regions: Region[] = [];
    try {
      const main = this.bot.currentRegion;
      if (main) regions.push(main);
    } catch { /* bot may not be connected */ }

    const children = this.bot.childAgentManager?.getChildRegions() ?? [];
    regions.push(...children);
    return regions;
  }

  /**
   * Send initial state to a specific adapter. Call this when a viewer
   * connects or reconnects.
   */
  sendInitialState(adapter: ViewerAdapter): void {
    // Send world origin so viewer knows how to offset positions
    adapter.onWorldOrigin(this.worldOriginX, this.worldOriginY);

    const allRegions = this.getAllRegions();

    // Send terrain for all regions that have it
    for (const region of allRegions) {
      if (region.terrainComplete) {
        adapter.onTerrain(region);
      }
    }

    // Send full object/avatar snapshot via onInitialState
    adapter.onInitialState(allRegions);
  }

  /** Notify all adapters of a region change (teleport). */
  notifyRegionChange(): void {
    this.updateWorldOrigin();
    for (const a of this.adapters) {
      a.onRegionChange();
    }
  }

  /** Shut down all subscriptions. */
  shutdown(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.adapters = [];
  }

  private subscribe(): void {
    const events = this.bot.clientEvents;

    // Terrain
    this.subscriptions.push(
      events.onTerrainComplete.subscribe((evt: TerrainCompleteEvent) => {
        // Find the Region that owns this terrain (for the adapter interface)
        const region = this.findRegionByCacheId(evt.cacheID?.toString());
        if (region) {
          for (const a of this.adapters) a.onTerrain(region);
        }
      })
    );

    // Objects
    this.subscriptions.push(
      events.onNewObjectEvent.subscribe((evt: NewObjectEvent) => {
        if (isVegetation(evt.object)) return;
        for (const a of this.adapters) a.onNewObject(evt);
      })
    );

    this.subscriptions.push(
      events.onObjectUpdatedEvent.subscribe((evt: ObjectUpdatedEvent) => {
        if (isVegetation(evt.object)) return;
        for (const a of this.adapters) a.onObjectUpdated(evt);
      })
    );

    this.subscriptions.push(
      events.onObjectUpdatedTerseEvent.subscribe((evt: ObjectUpdatedEvent) => {
        if (isVegetation(evt.object)) return;
        for (const a of this.adapters) a.onObjectUpdatedTerse(evt);
      })
    );

    this.subscriptions.push(
      events.onObjectResolvedEvent.subscribe((evt: ObjectResolvedEvent) => {
        for (const a of this.adapters) a.onObjectResolved(evt);
      })
    );

    this.subscriptions.push(
      events.onSelectedObjectEvent.subscribe((evt: SelectedObjectEvent) => {
        for (const a of this.adapters) a.onObjectSelected(evt);
      })
    );

    // Avatars
    this.subscriptions.push(
      events.onAvatarEnteredRegion.subscribe((avatar: Avatar) => {
        for (const a of this.adapters) a.onAvatarEntered(avatar);
      })
    );

    // Environment
    this.subscriptions.push(
      events.onRegionEnvironment.subscribe((evt: RegionEnvironmentEvent) => {
        for (const a of this.adapters) a.onEnvironment(evt);
      })
    );

    // Parcel overlay
    this.subscriptions.push(
      events.onParcelOverlayComplete.subscribe((evt: ParcelOverlayCompleteEvent) => {
        for (const a of this.adapters) a.onParcelOverlay(evt);
      })
    );

    // Teleport
    this.subscriptions.push(
      events.onTeleportEvent.subscribe((e) => {
        if (e.eventType === TeleportEventType.TeleportCompleted && e.simIP !== 'local') {
          this.notifyRegionChange();
        }
      })
    );
  }

  private findRegionByCacheId(cacheId: string | undefined): Region | null {
    if (!cacheId) return null;
    for (const region of this.getAllRegions()) {
      if (region.cacheID?.toString() === cacheId) return region;
    }
    return null;
  }
}
