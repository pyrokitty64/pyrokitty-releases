# PyroKitty Architecture

PyroKitty replaces the traditional monolithic Second Life viewer with a multi-process stack. Each process owns a clear slice of responsibility and communicates over local WebSockets or stdio IPC. Yes, most of this was vibe coded. No, we're not sorry.

```
                              SL Region Servers
                             ╱                ╲
                        UDP / HTTP          UDP / HTTP
                           ╱                    ╲
┌──────────────┐  WS   ┌──┴──────────────┐  WS  ┌──────────────┐
│  Firestorm   │ <───> │   Electron UI   │ <──> │ Godot Viewer │
│  (optional)  │session│ (node-metaverse │assets│  (3D render) │
│              │handoff│  + pipelines)   │scene │              │
└──────────────┘       └──┬──────────────┘input └──────────────┘
                          │ stdin/stdout
                     ┌────┴───────┐
                     │   Voice    │
                     │  Sidecar   │
                     │  (.NET 8)  │
                     └────────────┘

┌────────────┐  stdio  ┌─────────────┐  UDP/HTTP  ┌────────────────┐
│   Claude   │ <─────> │   SL-MCP    │ <────────> │  SL Servers    │
│   Code     │   MCP   │   Server    │  own Bot   │  (independent  │
│            │         │             │  session   │   session)     │
└────────────┘         └─────────────┘            └────────────────┘
```

## Processes at a Glance

| Process | Language | Role | Entry Point |
|---------|----------|------|-------------|
| **Electron UI** | TypeScript | Protocol client, asset pipelines, account/UI shell | `electron-ui/src/main/main.ts` |
| **Godot Viewer** | GDScript | 3D rendering, animation, prim meshing | `godot-viewer/src/main.gd` |
| **Voice Sidecar** | C# (.NET 8) | WebRTC spatial voice (SIPSorcery + Opus) | `electron-ui/voice/Program.cs` |
| **SL-MCP Server** | TypeScript | Standalone AI bot (own SL session, 36 tools) | `sl-mcp/src/wrapper.ts` |
| **Firestorm** | C++ | Optional alternative renderer / session donor | `firestorm/indra/newview/` |

---

## Electron UI

The Electron process is the brains of the operation. It manages accounts, drives the SL protocol, decodes assets, and streams everything to Godot for rendering.

### Directory Layout

```
electron-ui/
  src/
    main/             # Electron main process
      assets/         # Asset fetch queues & converters (texture, mesh, sculpt, animation, material)
      avatar/         # Avatar shape deformation, display names
      bridge/         # Godot bridge: WebSocket, object sender, update coalescer, avatar/animation managers
      network/        # Grid & session management
      ui/             # UI state (tray, window bounds)
      voice/          # Voice manager (spawns sidecar, relays events)
      __tests__/      # Vitest unit tests
    renderer/         # React 18 + Mantine UI
      components/     # Chat, Account, Login, MiniMap, VoiceBar, etc.
      hooks/          # useChat, useFriends, useGroups, useNearbyAvatars, etc.
      styles/         # CSS
    gpu-compress/     # WebGPU BC1/BC3/BC7 texture compression (hidden BrowserWindow)
    map-renderer/     # Leaflet-based world map
    shared/           # Shared TypeScript types
    sound-player/     # Sound playback
  node-metaverse/     # Bundled SL protocol library (heavily modified)
  voice/              # C# voice sidecar source
  data/               # Grid configs, accounts.json
  scripts/            # Build, package, test scripts
```

### Key Subsystems

**Protocol Client** (`node-metaverse/`): A TypeScript implementation of the SL/OpenSim UDP+HTTP protocol. Handles circuit messages (ObjectUpdate, AvatarAppearance, ImprovedTerseObjectUpdate), capabilities, inventory, and all server communication.

**Asset Pipelines** (`src/main/assets/`): Parallel fetch queues with disk caching. Each queue deduplicates requests, downloads from the SL CDN, converts to a Godot-friendly format, writes to disk, and notifies Godot. See [Asset Pipeline](#asset-pipeline) below.

**Godot Bridge** (`src/main/bridge/`): Manages the WebSocket connection to Godot, batches outbound messages (200 max per 50ms flush with per-UUID coalescing), and routes inbound input/interaction events back to the protocol layer. Key files:
- `godot-bridge.ts` — spawns Godot, manages connection lifecycle, send buffer coalescing (deduplicates per-UUID object/avatar/animation/face updates before serialization)
- `godot-object-sender.ts` — single `object_render` message formatting (all assets gated by readiness tracker)
- `godot-update-coalescer.ts` — batches position/rotation updates at 16ms intervals
- `godot-avatar-manager.ts` — avatar lifecycle, shape morphs, Baked-on-Mesh textures
- `godot-animation-manager.ts` — animation list changes for avatars and animesh (in-flight guard prevents duplicate batch sends)

**Voice Manager** (`src/main/voice/`): Spawns the C# voice sidecar as a child process and communicates over stdin/stdout JSON messages. See [Voice System](#voice-system).

**React UI** (`src/renderer/`): Account management, login screen, chat, minimap, friends/groups lists, voice controls. Communicates with the main process via Electron IPC.

---

## Godot Viewer

The Godot process is a pure renderer. It receives scene state over WebSocket, loads cached assets from disk, and renders the 3D world. It sends input events (movement, camera, object clicks) back to Electron.

### Directory Layout

```
godot-viewer/
  src/
    main.gd                  # WebSocket server, message router, frame budget queue
    scene_manager.gd          # Central state router, object lifecycle
    object_manager.gd         # Object creation, mesh instantiation, skin remapping
    avatar_manager.gd         # Avatar lifecycle, BoM, shape application
    animation_manager.gd      # Threaded animation evaluation, shape deformation
    skeleton_builder.gd       # Shared Skeleton3D from avatar_skeleton.xml (159 bones)
    camera_controller.gd      # Orbit camera, avatar tracking, VR
    prim_mesh_generator.gd    # Prim extrusion with UV generation
    asset_pipeline.gd         # Asset loading from disk (GLB, textures)
    light_manager.gd          # Point/spot/projection lights
    terrain_environment.gd    # Terrain heightmaps, OceanFFT water, GPU underwater fog
    interpolation_manager.gd  # Smooth object/avatar movement between updates
    name_bubble_manager.gd    # Floating name labels
    object_picker.gd          # Raycasting for object selection
    frame_budget.gd           # Per-frame time budget (VR perf)
    underwater_fog.gdshader   # GPU underwater fog (samples FFT displacement)
  shaders/
    planar_map.gdshader       # SL planar-projected UVs
    standard_uv.gdshader      # Standard mesh UVs with SL texture transforms
  tests/                      # Headless test scenes
  data/                       # avatar_skeleton.xml, avatar_lad.xml
  addons/                     # Ocean FFT water rendering
```

### Message Processing

Godot runs a TCP server (default port 9200) and accepts a single WebSocket client (Electron). Messages are JSON objects with a `type` field.

**High-priority messages** (processed immediately every frame): avatar lifecycle, self ID, object position updates with physics, sitting state, stats. These ensure the player's view stays responsive.

**Low-priority messages** (time-budgeted queue): `object_render`, `object_update_batch`, etc. Processed within a 12ms frame budget to maintain framerate.

**Per-subsystem timing**: `scene_manager.gd` tracks ms/frame for terrain, interpolation, animation, flexi, name bubbles, and finalization. Reported in the stats line as `CPU: Xms [terrain=... interp=... anim=... ...]`.

### Shared Skeleton

Every avatar and animesh root gets ONE `Skeleton3D` node built from `avatar_skeleton.xml` (159 bones). All meshes worn by that avatar bind to this shared skeleton via skin index remapping. Worn animesh objects get their own separate skeleton (matching Firestorm's `LLControlAvatar` behavior). See [avatar-rendering.md](architecture/avatar-rendering.md) for the full skeleton, animation, and shape deformation architecture.

---

## Electron-Godot Bridge Protocol

All communication uses JSON messages over a localhost WebSocket.

### Coordinate System

SL and Godot use different coordinate systems. All positions and rotations are converted at the bridge boundary:

| Axis | Second Life | Godot |
|------|------------|-------|
| Right | +X (East) | +X |
| Up | +Z | +Y |
| Forward | +Y (North) | -Z |

Conversion: `position [x, y, z] -> [x, z, -y]`, `quaternion [x, y, z, w] -> [x, z, -y, w]`

### Electron → Godot

**Object Lifecycle (Single Message):**
- `object_render` — full object with mesh + all face materials + shape, sent once all assets (mesh, textures) are cached on disk. Electron gates readiness; Godot is a dumb renderer.
- `object_update_batch` — batched position/rotation/scale changes for static objects (coalesced every 50ms)
- `object_update_physics` — batched updates for moving objects: velocity, acceleration, angular velocity (high priority)
- `object_update_faces` — single face/material update after create (PBR materials resolved asynchronously)
- `object_update_faces_batch` — batched face/material updates
- `object_kill` — remove object from scene
- `object_properties` — object name, description, flags, clickAction, ownerID

**Legacy Object Messages (removed from Godot):**
- `object_create`, `object_complete`, `mesh_ready`, `texture_ready` — replaced by single `object_render` message. Handlers removed from Godot.

**Avatar Lifecycle:**
- `avatar_create` — new avatar: id, localId, name, position, rotation (high priority)
- `avatar_update` — single avatar position + rotation update (high priority)
- `avatar_update_batch` — batched avatar position/rotation updates (high priority)
- `avatar_kill` — remove avatar (high priority)
- `avatar_shape` — skeleton deformation: bone scales, offsets, volume morphs (high priority)
- `avatar_chat` — chat bubble text for an avatar
- `avatar_typing` — typing indicator for an avatar

**Animation:**
- `animations_batch` — animation set for a skeleton root: localId, animIds[]. Full keyframe data sent once per animation; subsequent batches include stubs (`{id}`) for previously-sent animations.

**Environment:**
- `terrain_ready` — heightmap binary cached to disk, path + waterHeight
- `environment_data` — sun direction, sunlight color, ambient color from EEP

**Session:**
- `self_id` — identify the bot's own avatar UUID so camera can follow it (high priority)
- `world_origin` — sets world coordinate origin (X, Y) for region positioning
- `region_change` — region boundary change notification
- `settings` — viewer configuration (draw distance, etc.)
- `electron_stats` — pipeline statistics from Electron side (high priority)

**Interaction:**
- `pay_options` — payment dialog preset amounts from server
- `pay_result` — payment transaction result (success/failure)
- `sitting_state` — avatar sitting state (on object UUID) (high priority)
- `planar_debug` — debug visualization mode toggle (F9, modes 0-3)

### Godot → Electron

**Input:**
- `input_move` — WASD/E/C/QE state + camera yaw + fly toggle + running flag → control flags + body rotation
- `camera_update` — current camera position/rotation (for draw distance, interest list)

**Interaction:**
- `object_touch` — touch event (instant click on scripted object)
- `object_touch_start` — touch begin (drag start)
- `object_touch_move` — touch drag in progress
- `object_touch_end` — touch end (drag release)
- `object_sit` — sit on object request
- `object_pay` — open payment dialog for object
- `pay_confirm` — confirm payment transaction
- `stand_up` — stand from sitting
- `sit_or_stand` — toggle sit/stand

**Object Operations:**
- `request_object_properties` — request name + description + flags for an object (by localId)
- `set_object_name` — set object name (from inspector panel)
- `set_object_description` — set object description (from inspector panel)

**Asset Retry:**
- `texture_request` — request texture re-fetch (retry)
- `mesh_request` — request mesh re-fetch (retry)

**Lifecycle:**
- `ready` — Godot viewport initialized, ready for data
- `quit` — Godot window closed, Electron should terminate the sidecar
- `pipeline_stats` — object/texture/mesh/material counts, FPS, finalize timing (every 5s)
- `window_bounds` — report window position/size changes

---

## Asset Pipeline

Assets flow through parallel fetch queues in the Electron process. Each queue deduplicates requests, downloads from SL's CDN, converts to a Godot-friendly format, caches to disk, and notifies Godot.

```
SL CDN
  │
  ├─ TextureFetchQueue ─→ J2K decode (WASM OpenJPEG, 2-12 auto-scaling workers) ─→ GPU compress (BC1/BC3) ─→ .bctex
  ├─ MeshFetchQueue ────→ LLMesh parse ─→ GLB export (mesh-converter.ts) ──────────────────→ .glb
  ├─ SculptFetchQueue ──→ sculpt texture decode ─→ sculpt mesh generation ─────────────────→ .glb
  ├─ AnimationFetchQueue → LLAnimation binary ─→ JSON parse ─→ disk cache ─────────────────→ .json
  └─ MaterialFetchQueue ─→ PBR material definition ─→ resolve textures ─→ object_update_faces
```

**Disk cache** (`~/.pyrokitty-ui/asset-cache/`): survives between sessions. On next launch, queues check disk before downloading. Godot can re-request evicted assets via `texture_request` / `mesh_request`. All cache I/O uses `fs.promises` (async) to avoid blocking the Node.js event loop — synchronous writes previously caused multi-second input stalls under heavy asset loading. Texture and sculpt cache lookups use in-memory `Map`/`Set` populated at startup to avoid filesystem hits entirely.

**Texture pipeline detail**: J2C binary -> WASM OpenJPEG decode -> RGBA -> GPU BC compression (via hidden BrowserWindow with WebGPU) -> `.bctex` file. Falls back to WebP if GPU compression unavailable. See [texture-pipeline.md](architecture/texture-pipeline.md) and [gpu-texture-cache.md](architecture/gpu-texture-cache.md).

**Mesh pipeline detail**: LLMesh binary -> parse LoD levels, morphs, materials -> rebuild skeleton from `avatar_skeleton.xml` -> compute inverse bind matrices -> bake bone shape scales -> export as GLTF 2.0 `.glb`. See [animesh.md](architecture/animesh.md).

**Object readiness**: `ObjectReadinessTracker` gates `object_render` messages until all referenced meshes and textures are cached on disk, preventing Godot from trying to load missing files.

**Distance gating**: Root prims beyond `TEXTURE_FETCH_RANGE` (camera draw distance) are deferred in `sendObject()` — no textures, meshes, or materials are resolved. Children of deferred roots are also deferred. When the camera moves closer, `sweepDeferredTextures()` promotes roots and their children back into the pipeline. The distance check must run before `resolveObject()` since material resolution triggers texture downloads as a side effect.

---

## Avatar System

Avatar rendering spans both Electron (shape computation, animation management) and Godot (skeleton posing, mesh deformation).

**Shape deformation**: Shape slider bytes arrive via `AvatarAppearance` messages. Electron computes bone scales/offsets and volume morph deltas from `avatar_lad.xml`, then sends an `avatar_shape` message to Godot. Godot applies these as global pose overrides each frame.

**Animation**: Animations are evaluated on a background thread in Godot (`animation_manager.gd`). Per-channel priority arbitration (rotation and position independently per joint) matches SL's behavior. Built-in motions (head_rot, eye, breathe) are computed alongside asset animations. Parsed animation JSON is cached to disk (`asset-cache/animations/{uuid}.json`) so subsequent sessions skip the download. Within a session, full keyframe data is sent to Godot only once per animation — subsequent `animations_batch` messages include stubs (`{id}`) for previously-sent animations, keeping typical batch sizes around 1-10 KB even when individual animations can be 100 KB–1 MB+.

**Baked-on-Mesh (BoM)**: The server composites avatar textures (skin, clothing layers) into baked textures. Electron tracks bake completion and updates mesh face textures accordingly.

Full details in [avatar-rendering.md](architecture/avatar-rendering.md).

---

## Voice System

Spatial voice runs in a separate C# .NET 8 process (`electron-ui/voice/`).

```
Electron (voice-manager.ts)
  │ stdin/stdout JSON
  ▼
Voice Sidecar (Program.cs)
  ├─ SIPSorcery WebRTC peer connection
  ├─ SDL3 microphone/speaker
  ├─ Concentus Opus encode/decode
  └─ Vivox-compatible signaling
```

Electron tells the sidecar which voice channel to join and relays spatial position data. The sidecar handles all audio I/O and WebRTC negotiation independently.

See [voice-system.md](architecture/voice-system.md).

---

## SL-MCP Server

The MCP server (`sl-mcp/`) is a **standalone bot** — it does not interact with the Electron UI or Godot viewer. It imports `node-metaverse` directly and runs its own independent SL session. This lets AI agents (like Claude) control a Second Life bot through 36+ tools: login/logout, chat, teleport, walk, fly, rez prims, manipulate objects, read nearby state, and more.

```
Claude Code <──stdio──> wrapper.ts <──IPC──> backend.ts (bot-manager.ts)
                                                │
                                           node-metaverse (own Bot instance)
                                                │
                                           SL servers (separate session)
```

`wrapper.ts` is the MCP stdio entry point. It forks `backend.ts` as a child process and proxies tool calls via IPC. `BotManager` creates its own `Bot` from `node-metaverse` — no Electron process needed. The `reload` tool kills and respawns the backend for live development. Individual tools live in `sl-mcp/src/tools/`. The minesweeper solver is in there too, because at some point an AI decided it wanted to play games instead of work.

---

## Firestorm Integration

The modified Firestorm viewer (`firestorm/`) can run in "external login" mode (`--external-login`), where it authenticates with SL servers and then hands its session off to the Electron/Godot stack via WebSocket. This provides access to Firestorm's mature UDP protocol handling while using PyroKitty's rendering.

This is experimental and optional — the normal flow uses node-metaverse directly.

See [login-system.md](architecture/login-system.md) for the authentication flow.

---

## Shared Data

The `shared/` directory contains avatar skeleton and attachment point definitions as JSON, converted from Linden Lab's XML source files. Both Electron (mesh-converter, shape computation) and Godot (skeleton builder) reference this data.

- `avatar_skeleton.json` — 159-bone skeleton hierarchy with rest transforms
- `avatar_lad_skeleton.json` — bone shape parameters (driven by appearance sliders)
- `avatar_lad_attachments.json` — attachment point definitions (30 slots)

---

## Where to Start for Common Tasks

| I want to... | Look at |
|--------------|---------|
| Fix a rendering bug | `godot-viewer/src/object_manager.gd`, `scene_manager.gd` |
| Fix avatar appearance | `godot-viewer/src/animation_manager.gd`, `skeleton_builder.gd`, [avatar-rendering.md](architecture/avatar-rendering.md) |
| Fix texture issues | `electron-ui/src/main/assets/` (texture pipeline), [texture-pipeline.md](architecture/texture-pipeline.md) |
| Fix mesh loading | `electron-ui/src/main/assets/mesh-converter.ts`, [animesh.md](architecture/animesh.md) |
| Add a new bridge message | `electron-ui/src/main/bridge/godot-bridge.ts` + `godot-viewer/src/main.gd` |
| Change the UI | `electron-ui/src/renderer/components/` |
| Fix voice chat | `electron-ui/voice/`, [voice-system.md](architecture/voice-system.md) |
| Add an MCP tool | `sl-mcp/src/tools/` |
| Fix prim rendering | `godot-viewer/src/prim_mesh_generator.gd`, [primmesher-reference.md](architecture/primmesher-reference.md) |
| Fix flexi prims | `godot-viewer/src/flexi_prim_manager.gd`, [flexi-prims.md](architecture/flexi-prims.md) |
| Fix movement/interpolation | `godot-viewer/src/interpolation_manager.gd`, [slerp.md](architecture/slerp.md) |
| Fix camera behavior | `godot-viewer/src/camera_controller.gd` |
| Fix lighting | `godot-viewer/src/light_manager.gd`, [lights.md](architecture/lights.md) |
| Fix terrain/water | `godot-viewer/src/terrain_environment.gd` |
| Work on VR support | `godot-viewer/src/main.gd` (XR setup), [vr.md](architecture/vr.md) |
| Understand the build | `electron-ui/scripts/package.sh`, [build-system.md](architecture/build-system.md) |
| Fix login/auth issues | `electron-ui/src/main/network/`, [login-system.md](architecture/login-system.md) |
| Fix permissions/export | [permissions-system.md](architecture/permissions-system.md), [export-system.md](architecture/export-system.md) |
| Understand child agents | `electron-ui/src/main/bridge/`, [child-agents.md](architecture/child-agents.md) |

---

## Architecture Docs Index

Detailed documentation for specific subsystems lives in `docs/architecture/`:

| Document | Topic |
|----------|-------|
| [avatar-rendering.md](architecture/avatar-rendering.md) | Skeleton, animation eval, shape deformation, BoM, built-in motions |
| [animesh.md](architecture/animesh.md) | Rigged mesh pipeline from network to Godot |
| [texture-pipeline.md](architecture/texture-pipeline.md) | J2K decode, GPU compression, .bctex caching |
| [texture-system.md](architecture/texture-system.md) | Texture picker UI and build panel |
| [gpu-texture-cache.md](architecture/gpu-texture-cache.md) | DXT/BC compressed texture disk format |
| [voice-system.md](architecture/voice-system.md) | WebRTC voice sidecar architecture |
| [login-system.md](architecture/login-system.md) | Authentication flow, MFA, TOS |
| [build-system.md](architecture/build-system.md) | CMake/autobuild build orchestration |
| [shadow-system.md](architecture/shadow-system.md) | Cascaded shadow mapping |
| [prim-mesh-uv.md](architecture/prim-mesh-uv.md) | Prim UV generation and SL texture transforms |
| [primmesher-reference.md](architecture/primmesher-reference.md) | Prim extrusion algorithm |
| [flexi-prims.md](architecture/flexi-prims.md) | Flexible prim Verlet physics and skeleton rigging |
| [puppetry-system.md](architecture/puppetry-system.md) | Real-time motion capture input |
| [lights.md](architecture/lights.md) | Projection lights and Godot limitations |
| [slerp.md](architecture/slerp.md) | Object/avatar movement interpolation protocol |
| [vr.md](architecture/vr.md) | VR/XR support and debugging |
| [export-system.md](architecture/export-system.md) | Collada/backup export |
| [permissions-system.md](architecture/permissions-system.md) | Client-side permission model |
| [user-data-storage.md](architecture/user-data-storage.md) | Preferences, credentials, MFA token storage |
| [child-agents.md](architecture/child-agents.md) | Neighboring region connections |
| [capabilities.md](architecture/capabilities.md) | Simulator capability URLs |
| [performance-todo.md](architecture/performance-todo.md) | FSR upscaling and optimization notes |

---

## Detailed File Structure

### Godot Viewer

```
godot-viewer/
  project.godot          ← Godot 4.7-dev2 project config (forward_plus renderer)
  godot-version.txt      ← Engine version string (read by godot-bridge.ts)
  main.tscn              ← Main scene (Node3D + SceneManager + Camera3D + XROrigin3D + light + env)
  Godot_v4.7-dev2_mono_win64/  ← Godot engine binary
  addons/
    tessarakkt.oceanfft/   ← OceanFFT addon (FFT wave simulation, QuadTree3D LOD)
      shaders/SurfaceVisual.gdshader  ← Water shader (FFT + custom SSR + refraction)
      Ocean.tres           ← Material resource with shader parameter defaults
  tests/
    test_prim_mesh.gd/.tscn         ← Prim mesh face ordering, normals, vertex bounds
    test_shader_materials.gd/.tscn  ← Shader compilation, material creation
    test_camera_controller.gd/.tscn ← Camera input, orbit, follow
    test_main.gd/.tscn              ← WebSocket server, message dispatch
    test_xr_rig.gd/.tscn            ← VR rig positioning
    test_water_setup.gd/.tscn       ← Shader compilation, Ocean3D initialization guards
    test_object_picker.gd/.tscn     ← GPU ID-buffer + physics raycast picking
  src/
    main.gd              ← WebSocket TCP server (1MB buffer), message dispatch, VR init, frame budget
    scene_manager.gd     ← RSInstance-based object CRUD, flat linkset hierarchy, terrain/water/sky,
                           occlusion culling loop, distance culling
    object_manager.gd    ← Object creation, mesh instantiation, skin remapping, joint overrides
    animation_manager.gd ← Animation evaluation, per-channel priority, built-in motions (head_rot)
    asset_pipeline.gd    ← Texture/mesh loading threads, frame-budgeted finalization, material cache
    interpolation_manager.gd ← Avatar/object lerp+slerp, physics extrapolation, blend correction
    light_manager.gd     ← RSLight management, distance culling, projection textures
    terrain_environment.gd ← Terrain mesh building, environment/sky updates
    flexi_prim_manager.gd ← Flexi prim Verlet simulation (port of Firestorm's doFlexibleUpdate)
    name_bubble_manager.gd ← 2D CanvasLayer name bubble overlay (TAA-safe)
    name_bubble_3d_manager.gd ← 3D Label3D name bubbles (VR mode)
    object_picker.gd     ← Hybrid GPU ID-buffer + physics raycast picking, occlusion scan compute shader
    action_bar.gd        ← Context-aware interaction UI (Touch/Sit/Pay/Buy/Edit/Inspect)
    touch_manager.gd     ← Touch event routing (click, drag start/move/end)
    avatar_manager.gd    ← Avatar create/update/kill, appearance routing
    skeleton_builder.gd  ← Parses avatar_skeleton.xml, builds shared Skeleton3D (159 bones)
    prim_mesh_generator.gd ← Procedural prim geometry from SL shape params (port of LLVolume)
    camera_controller.gd ← Orbit camera with avatar follow, WASD+Q/E+F input, fly/run/sprint
    xr_rig.gd            ← XROrigin3D positioning at avatar eye height (VR mode)
    frame_budget.gd      ← Central timing constants for VR (72Hz) and desktop (30fps) budgets
    standard_uv.gdshader ← Custom shader for texture rotation + UV transform (opaque)
    standard_uv_alpha.gdshader ← Same with alpha blending
    planar_map.gdshader  ← Custom shader for SL planar UV projection (opaque)
    planar_map_alpha.gdshader ← Same with alpha blending
    underwater_fog.gdshader ← Underwater fog effect based on wave height
    occlusion_scan.glsl  ← GPU compute shader for ID-buffer occlusion culling
```

### Electron Main Process

```
electron-ui/src/main/
  index.ts               ← Electron main process entry
  ipc-handlers.ts        ← IPC channel registration

  bridge/                ← Godot ↔ Electron bridge layer
    godot-bridge.ts      ← Spawns Godot, WebSocket client, streams scene state, handles input
    godot-bridge-types.ts ← Type definitions for bridge messages
    godot-animation-manager.ts ← Animation batching, avatar anim routing
    godot-avatar-manager.ts ← Avatar lifecycle, BoM substitution, shape data buffering/sending
    godot-environment-manager.ts ← Environment data (sun, sky, water height)
    godot-input-handler.ts ← Input event routing (touch, sit, pay, stand, etc.)
    godot-material-pipeline.ts ← Material pipeline orchestration
    godot-object-sender.ts ← Object render message formatting
    godot-update-coalescer.ts ← Batches object updates (50ms coalesce window)
    object-readiness-tracker.ts ← Tracks asset readiness → object_render

  assets/                ← Asset fetch, decode, and cache
    animation-fetch-queue.ts ← Animation asset download queue
    decode-pool.ts       ← Auto-scaling worker thread pool (2-12 workers) for parallel J2K decode
    gpu-compress-queue.ts ← Queues RGBA textures for GPU compression, writes .bctex
    gpu-compress-window.ts ← Hidden BrowserWindow hosting WebGPU compute shader for BC1/BC3
    j2k-converter.ts     ← J2K decode orchestration (native vs WASM)
    material-fetch-queue.ts ← PBR material download, LLSD binary → glTF JSON
    mesh-convert-pool.ts ← Mesh conversion worker pool
    mesh-convert-worker.ts ← Mesh conversion worker thread
    mesh-converter.ts    ← LLMesh → GLB (binary glTF 2.0) with joint override extraction
    mesh-fetch-queue.ts  ← Concurrent mesh download with dedup, disk caching, notify-once
    sculpt-converter.ts  ← Sculpt map pixel data → vertex positions → GLB
    sculpt-fetch-queue.ts ← Sculpt texture fetch + conversion to GLB
    sound-fetch-queue.ts ← Sound asset download queue
    sound-player.ts      ← Sound playback management
    texture-decode-worker.ts ← Worker: WASM OpenJPEG decode → sharp
    texture-fetch-queue.ts ← Concurrent texture download with J2C decode, disk caching

  materials/             ← Viewer-agnostic material resolution
    material-resolver.ts ← Three-layer priority resolver, always emits alphaMode 0/1/2
    resolved-material.ts ← Resolved material data structure
    resolve-face.ts      ← Per-face material resolution logic

  avatar/                ← Avatar-specific logic
    avatar-shape.ts      ← Parses avatar_lad.xml, computes bone scale/offset from VisualParam bytes
    display-name-cache.ts ← Display name resolution and caching

  network/               ← SL protocol and connection management
    metaverse-connection.ts ← SL protocol connection, buffers VisualParams during login
    account-manager.ts   ← Account login/logout
    grid-manager.ts      ← Grid configuration
    scene-manager.ts     ← Object store and scene state
    viewer-connection.ts ← Firestorm external login handoff
    viewer-manager.ts    ← Viewer process lifecycle

  ui/                    ← Window management
    chat-log-manager.ts  ← Chat log persistence
    inventory-sync-manager.ts ← Inventory sync (texture/notecard/script)
    map-window.ts        ← 2D map window
    map3d-window.ts      ← 3D world map window
    viewer-inventory-adapter.ts ← Inventory data adapter
    window-state-manager.ts ← Window position/size persistence

  voice/                 ← Voice system
    voice-manager.ts     ← Voice sidecar lifecycle
    voice-registry.ts    ← Per-avatar voice state tracking
```

### Other Electron Source

```
electron-ui/src/
  renderer/              ← React 18 + Mantine UI
    components/          ← Chat, Account, Login, MiniMap, VoiceBar, etc.
    hooks/               ← useChat, useFriends, useGroups, useNearbyAvatars, etc.
    styles/              ← CSS

  gpu-compress/          ← WebGPU BC1/BC3 texture compression
    compress.ts          ← WebGPU compute shader orchestration
    bc-compress.wgsl     ← WGSL compute shader for BC1/BC3 block compression
    bctex-format.ts      ← .bctex file format: header + mip chain serialization
    index.html           ← Minimal HTML for hidden BrowserWindow WebGPU context

  3d-map/                ← Three.js 3D world map
    index.ts             ← Three.js renderer
    tile-manager.ts      ← Map tile loading and terrain heightmap management
    index.html           ← 3D map window HTML

electron-ui/voice/       ← C# .NET 8 voice sidecar (SIPSorcery + Concentus Opus)
electron-ui/node-metaverse/  ← Bundled SL protocol library (heavily modified)
electron-ui/data/        ← Grid configs, accounts.json
electron-ui/scripts/     ← Build, package, test scripts
```
