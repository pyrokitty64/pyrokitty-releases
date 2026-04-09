# PyroKitty — Plan

## Overview

PyroKitty is a multi-process Second Life viewer. Electron (TypeScript, node-metaverse) handles all SL protocol work — login, UDP, caps, object tracking, asset fetch, avatar shapes, inventory. Godot (GDScript) is a pure 3D renderer receiving scene commands over WebSocket. A C# voice sidecar handles WebRTC spatial voice. An optional SL-MCP server gives AI agents independent bot control.

See `docs/pyrokitty-architecture.md` for full architecture and subsystem documentation.

```
┌──────────────────────────────┐
│  Electron (React/TypeScript) │
│  Protocol, assets, avatars,  │
│  chat, inventory, login UI   │
├──────────────────────────────┤
│  node-metaverse (TypeScript) │
│  SL protocol, UDP, caps,     │
│  object tracking, asset CDN, │
│  GPU BC1/BC3 compression     │
├──────────┬───────────────────┘
│    WebSocket IPC             │
├──────────┴───────────────────┐
│  Godot 4.7-dev2 sidecar     │
│  Scene rendering, animation, │
│  picking, input forwarding   │
└──────────────────────────────┘
```

---

## Milestones — Complete

### M1 — Boxes in Space
- WebSocket bridge, coordinate conversion, BoxMesh instances at SL positions
- Avatar tracking, orbit camera, WASD movement, self-avatar follow
- **Victory:** Walk around a region as colored cubes

### M1.5 — Mesh Objects
- MeshFetchQueue with concurrent download, dedup, disk caching
- LLMesh → GLB converter (hand-rolled binary glTF 2.0 encoder)
- **Victory:** Modern SL mesh content renders with correct geometry

### M2 — Textures
- TextureFetchQueue, J2C → WebP/bctex decode, per-face materials
- Placeholder materials while textures download, UV repeat/offset
- **Victory:** Recognizable textured world

### M2.5 — Avatar Movement
- Rotation, jump, crouch, fly toggle, run/sprint, strafing
- SL quaternion w-positive fix
- **Victory:** Full avatar movement controls

### M3 — Terrain + Water + Sky
- Terrain heightmap (256x256 ArrayMesh), OceanFFT with QuadTree3D LOD + custom SSR
- ProceduralSky from EEP, underwater fog shader
- **Victory:** Standing on ground with animated water and sky

### M3.5 — Linksets (Child Prims)
- Recursive child sending, flat hierarchy (no Godot scene tree parenting)
- Late-arriving children, recursive cleanup, pending children buffer
- World position = `parent_pos + parent_rot * child_offset` (avoids scale inheritance/shearing)
- **Victory:** Linksets (buildings, furniture, vehicles) render fully

### M3.6 — Performance & Memory
- GPU BC1/BC3 compression via WebGPU compute shaders (`.bctex` output)
- WASM OpenJPEG J2K decode (8 workers)
- RenderingServer RID instances replace MeshInstance3D nodes
- Adaptive frame budgets, 16 texture threads, 16 mesh tasks
- Two-phase object creation via ObjectReadinessTracker
- Distance gating, async file I/O, material cache dedup
- **Victory:** Thousands of objects at 30+ fps desktop, 72 fps VR

### M4 — Better Geometry
- Procedural prim mesh generator (port of LLVolume path/profile sweep)
- All shape params: hollow, cuts, twist, taper, shear, skew, revolutions
- Sculpt map support, planar UV mapping shader, standard UV with rotation
- **Victory:** Full prim geometry; only spherical UV mapping remains

### M4.5 — PBR Materials
- Three-layer priority: renderMaterialData > gltfMaterialOverrides > legacy TextureEntry
- Normal maps, ORM textures, emissive, KHR_texture_transform
- Viewer-agnostic MaterialResolver (no isPBR branching on Godot side)
- **Victory:** PBR content renders correctly

### M4.6 — Lights
- Point and spot lights via RenderingServer RIDs
- Projection textures, distance culling (max 64 active), parent tracking
- **Victory:** Lit environments with projection textures

### M5 — Navigation
- Fly, run, strafing, avatar/physics interpolation with blend correction
- Teleport support (via minimap and world map)
- Landmarks (inventory parsing, map pins, searchable panel, click-to-teleport)
- **Victory:** Can navigate a region freely

### M6 — Avatars
- Shared Skeleton3D per avatar (159 bones from `avatar_skeleton.xml`), skin index remapping
- Bakes on Mesh, per-channel animation priority, shape deformation from VisualParam bytes
- Volume morph deltas, dynamic parent scale, display names + chat bubbles
- Worn animesh with own skeleton (matching Firestorm's LLControlAvatar)
- head_rot built-in motion, position persistence
- **Victory:** Avatars with correct body, textures, proportions, animations

### M7 — Interaction
- GPU ID-buffer picking (24-bit IDs, SubViewport at 1/4 res, skinned mesh support)
- Physics raycast for face/UV/normal detail, action bar UI
- Touch events, sit/stand, pay dialog, object inspector, VR laser pointer
- **Victory:** Touch, sit, pay, inspect objects

### M8 — Visual Polish (partial)
- [x] Flexi prims (Verlet integration, port of Firestorm's doFlexibleUpdate)
- [x] Animesh rigged mesh support (non-avatar rigged objects with own skeletons)
- [x] Alpha sorting (ALPHA_HASH + TAA + FXAA — no per-triangle sort needed)
- [x] GPU occlusion culling (ID-buffer scan, stochastic transparent handling, avatar occlusion, distance culling, F11 toggle)
- [x] Single `object_render` pipeline (replaces two-phase create/complete — Electron gates on mesh + all textures, sends everything at once)
- [ ] Terrain textures (4-texture blend based on height ranges)
- [ ] Neighbor region terrain
- [ ] Spherical UV mapping (mappingType=4)
- [ ] Texture animation (TextureAnim UV scrolling)
- [ ] Particles
- [ ] EEP day cycle animation
- [ ] Shadow + lighting improvements
- [ ] Draw distance / LOD tuning (must be solved together)
- [ ] Distance-based texture fetch priority
- [ ] Texture LOD / mipmap size selection
- [ ] Underwater camera view

### M9 — VR (partial)
- [x] OpenXR integration, head-tracked camera, VR frame budgets
- [x] Supersample + anti-aliasing, laser pointer object picking
- [ ] Motion controller input (movement, interaction)
- [ ] VR-appropriate UI panels
- **Known issue:** Godot 4.6.x+ OpenXR regression on Quest 3 via PC Link. Use 4.4-stable for VR.

---

## What's Next

### M10 — Inventory ("Can Actually Live Here")

The single biggest gap. People can't daily-drive a viewer where they can't put on clothes, attach a HUD, or rez from inventory. Three parallel tracks plus a thumbnail renderer.

See `TODO_INVENTORY.md` for the full plan, architecture, and estimates.

**Track A — Inventory Backbone** (2-3 weeks): Expand asset type support, add mutation ops (wear/attach/detach/rez), event streaming.

**Track B — Strategy Layer + Filesystem Mirror** (3-4 weeks): Pluggable per-asset-type handlers, lazy materialization, every inventory item becomes a file on disk.

**Track C — Action Bridge** (2 weeks): Drag-and-drop into Godot/Electron, wear/attach/detach commands.

**Thumbnail Renderer** (1-2 weeks within Track B): SubViewport PNG previews with embedded metadata for items that don't have native file representations.

**First step:** Landmark vertical slice to validate the architecture in ~1 week.

**Total: 7-10 weeks.**

### M11 — "Looks Like SL"

Once the viewer is usable, make it look right. None of these are conceptually hard; they're feature work with clear scope.

- Terrain textures (4-texture height blend)
- Neighbor region terrain
- Particles (LLPartSysData — biggest item in this milestone)
- Texture animation (TextureAnim UV scrolling)
- EEP day cycle animation
- Shadow improvements

**Estimate: 6-8 weeks.**

### M12 — Polish to Public Beta

Draw distance / LOD tuning (must be solved as a pair), distance-based texture fetch priority, underwater camera view, world-animesh (not just worn), spherical UV mapping, terrain LOD, remaining 3D map TODOs (see `TODO_3D_MAP.md`).

**Estimate: 4-6 weeks.**

### M13 — VR Motion Controllers and UI

Distinct user audience from desktop. Motion controller input, VR-appropriate UI panels. Resolve the Godot 4.6.x+ OpenXR regression or formalize the 4.4-stable VR build path.

**Estimate: 4 weeks.**

---

## Showstoppers (Bucket 1)

Things that mean a person literally cannot use PyroKitty for a day of normal SL activity.

- **Inventory** — M10, the focus of the next major push.
- **Region crossing** — not implemented in node-metaverse. Walking across a sim boundary doesn't work. Protocol layer, not renderer.
- **Teleport reliability** — returning to previously-visited sims can have stale/missing objects. Likely a `region_change` handler that doesn't fully evict prior region state.

## First-Session Friction (Bucket 2)

Things that don't break the viewer but make returning SL users say "what is wrong with this thing" within five minutes.

- **Terrain textures** — currently green-brown procedural. Every SL region has 4 textures blended by elevation.
- **Neighbor region terrain** — standing at a sim edge looking into the void.
- **Particles** — half of SL is particles. No particles means content looks broken.
- **Texture animation** — TextureAnim UV scrolling. Conveyor belts, scrolling signs, animated water.

## Gradual Frustration (Bucket 3)

Things people will keep using the viewer despite, while complaining.

- EEP day cycle animation
- Draw distance / LOD tuning
- Distance-based texture fetch priority
- Shadow improvements
- Animesh in the world (not just worn)
- Underwater camera view

## Polish (Bucket 4)

- 3D map TODOs (see `TODO_3D_MAP.md`)
- VR motion controllers and UI panels
- Spherical UV mapping
- Terrain LOD for distant terrain

---

## Known Issues

- **Teleport reliability** — teleports are wonky; returning to starting sim can have stale objects
- **No region crossing** — not implemented in node-metaverse
- **Godot 4.7-dev2 SubViewport view matrix bug** — ID-buffer picking can't use shader depth, uses physics distance instead
- **Desktop hover highlight** — infrastructure exists in object_picker.gd, not wired to mousemove

## Avatar TODOs

- [ ] Hover height (`AppearanceHover`)
- [ ] Morph targets (face detail deformation via vertex blend shapes)
- [ ] Real look-at targets (ViewerEffect messages for head tracking)
- [ ] Built-in motions: `eye`, `breathe_rot`, `hand_motion`, `pelvis_fix`

---

## Rendering Architecture

All objects and avatars use lightweight `RSInstance` wrappers around RenderingServer RIDs — no MeshInstance3D nodes in the scene tree. Flat linkset hierarchy (SL prim scale is independent per child).

### Object Pipeline (Single Message)

Electron gates on mesh + ALL textures on disk, then sends a single `object_render` message with everything Godot needs. Godot is a dumb renderer: no distance gating, no back-channel, no deferred queues.

Legacy two-phase handlers (`object_create`/`object_complete`/`mesh_ready`/`texture_ready`) still exist in Godot but are unused by the current path.

### Texture Pipeline

```
SL CDN → J2K decode (WASM OpenJPEG, 8 workers)
       → GPU BC compress (WebGPU BC1/BC3 compute shaders) → .bctex
       → Godot loads on 16 dedicated threads, finalizes within frame budget
```

### Material System

MaterialResolver (viewer-agnostic) resolves three-layer priority and always emits alphaMode 0/1/2. Custom shaders for UV rotation and planar mapping. ALPHA_HASH + TAA + FXAA for transparent mesh sorting.

### Physics Object Interpolation

Velocity + acceleration extrapolated at 45 Hz. Blend correction over 0.25s on new server update. Phase-out to zero over 2s if no updates. Sequence numbers prevent stale overwrites.

### GPU Occlusion Culling

ID-buffer scan once per second via compute shader. Objects not visible for 5 consecutive scans are hidden. Stochastic discard for transparent objects (50% pixel hash). Avatar occlusion aggregated per root. Distance culling always active. F11 toggle.

---

## IPC Protocol (WebSocket + JSON)

Godot runs a TCP server (default port 9200). Electron connects as the sole WebSocket client.

### Electron → Godot

| Category | Messages |
|----------|----------|
| **Object lifecycle** | `object_render`, `object_update_batch`, `object_update_physics`, `object_update_faces`, `object_kill` |
| **Legacy (unused)** | `object_create`, `object_complete`, `mesh_ready`, `texture_ready` |
| **Avatar** | `avatar_create`, `avatar_update_batch`, `avatar_kill`, `avatar_shape`, `avatar_chat`, `avatar_typing` |
| **Animation** | `animations_batch` (stubs for previously-sent animations) |
| **Environment** | `terrain_ready`, `environment_data` |
| **Session** | `self_id`, `world_origin`, `region_change`, `settings`, `electron_stats` |
| **Interaction** | `object_properties`, `pay_options`, `pay_result`, `sitting_state` |

### Godot → Electron

| Category | Messages |
|----------|----------|
| **Input** | `input_move`, `camera_update` |
| **Interaction** | `object_touch`, `object_touch_start/move/end`, `object_sit`, `object_pay`, `pay_confirm`, `stand_up`, `sit_or_stand` |
| **Object ops** | `request_object_properties`, `set_object_name`, `set_object_description` |
| **Asset retry** | `texture_request`, `mesh_request` |
| **Lifecycle** | `ready`, `quit`, `pipeline_stats`, `window_bounds` |

### Coordinate System

| Axis | Second Life | Godot |
|------|------------|-------|
| Right | +X (East) | +X |
| Up | +Z | +Y |
| Forward | +Y (North) | -Z |

`position [x, y, z] → [x, z, -y]`, `quaternion [x, y, z, w] → [x, z, -y, w]`

---

## Subsystem Reference

Detailed docs live in `docs/architecture/`. Key entries:

| Document | Topic |
|----------|-------|
| [pyrokitty-architecture.md](docs/pyrokitty-architecture.md) | Full system architecture |
| [avatar-rendering.md](docs/architecture/avatar-rendering.md) | Skeleton, animation, shape, BoM |
| [texture-pipeline.md](docs/architecture/texture-pipeline.md) | J2K decode, GPU compression |
| [voice-system.md](docs/architecture/voice-system.md) | WebRTC voice sidecar |
| [flexi-prims.md](docs/architecture/flexi-prims.md) | Verlet physics simulation |
| [object-lifecycle.md](docs/architecture/object-lifecycle.md) | Object render pipeline |

## Other TODOs

| Document | Topic |
|----------|-------|
| [TODO_INVENTORY.md](TODO_INVENTORY.md) | Inventory system plan (M10) |
| [TODO_3D_MAP.md](TODO_3D_MAP.md) | 3D world map features |

---

## Resolved Design Decisions

- **Embedded or separate window?** Separate. Godot runs as its own process.
- **Which Godot version?** `Godot_v4.7-dev2_mono_win64` (revert to 4.4 if VR needed). Version in `godot-version.txt`.
- **Scene tree or RenderingServer?** RenderingServer RIDs via `RSInstance`. MeshInstance3D nodes caused overhead at scale.
- **Linkset parenting?** Flat hierarchy. SL prims have independent scale; Godot's tree inherits scale causing shearing.
- **Camera ownership?** Godot owns camera locally, sends yaw to Electron for body rotation.
- **Movement model?** Godot sends key state + camera yaw. Electron sets ControlFlags + bodyRotation.
- **Texture format?** GPU-compressed `.bctex` primary, WebP fallback.
- **JPEG2000 decoder?** WASM OpenJPEG (`pyrokitty64/openjpeg` fork with SIMD). Native `opj_decompress.exe` path was removed.
- **Winding order?** SL→Godot transform is det=+1 (rotation), winding preserved.
- **Water rendering?** OceanFFT + custom SSR ray-march. Godot built-in SSR doesn't work on transparent surfaces.
- **Object picking?** Hybrid GPU ID-buffer + physics raycast. Neither alone covers both skinned and static meshes.
- **Name bubbles?** 2D CanvasLayer overlay. TAA motion vectors break 3D billboard text.
- **Flexi prims?** Verlet integration (port of Firestorm). SpringBoneSimulator3D abandoned. Bones along Y axis.
- **Alpha sorting?** ALPHA_HASH + TAA + FXAA. Per-object sort can't replicate Firestorm's per-triangle sort.
- **Object pipeline?** Single `object_render` message. Electron gates on all assets, Godot is a dumb renderer.

---

*Last updated: April 2026.*
