# Object Lifecycle: UDP Packet to Rendered Mesh

Complete trace of every cache, queue, and tracking structure an object passes through.

## Overview

```
SL Sim (UDP)
  |
  v
node-metaverse          Region.objects (ObjectStoreLite)
  |                       localID -> object
  v
Electron bridge         5 gates/queues
  |                       deferredTextures, pendingChildren, trackedObjects,
  |                       ObjectReadinessTracker.pending, meshFetchQueue/textureFetchQueue
  v                     Readiness tracker gates on: mesh + all textures + parent ordering
  |                     enrichFn fills disk paths (meshPath, texturePaths) at emit time
  v
WebSocket (JSON)        Single "object_render" message per object
  |
  v
Godot main.gd           1 queue
  |                       _low_priority_queue
  v
Godot scene_manager      4 queues/caches
                           _waiting_for_mesh, _mesh_queue/_mesh_tasks, _tex_waiting
                           + mesh_cache, texture_cache, material_cache (final caches)
```

---

## Stage 1: node-metaverse (UDP -> Object Store)

**File:** `node-metaverse/` (compiled dependency)

- SL sim sends `ObjectUpdate` / `ObjectUpdateCompressed` UDP packets
- node-metaverse parses into object structs, stored in `Region.objects` (ObjectStoreLite)
- Keys: `localID -> object`, also has `.FullID` (UUID), `.region` reference
- Fires events: `onNewObject`, `onObjectUpdated`, `onObjectKilled`

**Cache:** `Region.objects` — hash map of all objects the sim has told us about.

---

## Stage 2: Electron Bridge (Event -> Single Message)

### 2a. GodotObjectSender.sendObject()

**File:** `electron-ui/src/main/bridge/godot-object-sender.ts`

When `onNewObject` fires, the object hits these gates in order:

| # | Check | Structure | Action if blocked |
|---|-------|-----------|-------------------|
| 1 | Already tracked? | `trackedObjects: Set<string>` | Skip (dedup) |
| 2 | Parent not tracked? | `pendingChildren: Map<parentUuid, Array>` | Buffer until parent sent |
| 3 | Root prim too far? | `deferredTextures: Map<uuid, obj>` | Park; sweep promotes every 2s |
| 4 | Child of deferred root? | `deferredTextures.has(parentUuid)` | Park alongside parent |

**Distance gate (step 3):** `dist > TEXTURE_FETCH_RANGE` where `TEXTURE_FETCH_RANGE = bot.agent.cameraFar ?? 128`. Uses 3D Euclidean distance including altitude. **No messages sent to Godot at all** for deferred objects.

If all gates pass:

1. `materialResolver.resolveObject(obj)` resolves faces, triggers texture fetches
2. `meshFetchQueue.request(meshId)` / `sculptFetchQueue.request(...)` for mesh assets
3. `buildRenderMsg()` creates a unified `object_render` message with spatial + mesh + faces + metadata
4. `ObjectReadinessTracker.track(uuid, meshId, textureIds, renderMsg, parentUuid)` gates the message

**Single message — `object_render`:**
```json
{ "type": "object_render", "uuid": "...", "parentUuid": "...",
  "cacheID": "...", "position": [x,y,z], "rotation": [x,y,z,w], "scale": [x,y,z],
  "meshId": "...", "meshPath": "/path/to/mesh.glb",
  "isRigged": true, "jointNames": [...], "jointOverrides": [...],
  "shape": { "pathCurve": 16, ... },
  "faces": [{ "index": 0, "textureId": "...", "texturePath": "/path/to/tex.bctex",
              "color": [1,1,1,1], "alphaMode": 0, ... }],
  "light": {...}, "animesh": true, "flexible": {...},
  "attachmentPoint": 5, "clickAction": 1, "ownerID": "...", "primFlags": 0 }
```

`meshPath` and per-face `texturePath` are filled by the `enrichFn` at emit time from in-memory lookup maps (`meshMeta`, `texturePaths`), not stored in the readiness tracker.

### 2b. ObjectReadinessTracker

**File:** `electron-ui/src/main/bridge/object-readiness-tracker.ts`

| Structure | Type | Purpose |
|-----------|------|---------|
| `pending` | `Map<uuid, PendingObject>` | Objects awaiting asset readiness |
| `meshToObjects` | `Map<meshId, Set<uuid>>` | Reverse index: which objects need this mesh |
| `textureToObjects` | `Map<textureId, Set<uuid>>` | Reverse index: which objects need this texture |
| `resolvedMeshes` | `Set<string>` | Globally resolved meshes (pre-fill for cache hits) |
| `resolvedTextures` | `Set<string>` | Globally resolved textures (pre-fill for cache hits) |
| `emitted` | `Set<string>` | UUIDs already sent to Godot |
| `childrenWaitingForParent` | `Map<parentUuid, Set<uuid>>` | Children blocked on parent emit |

**Gates:** An object emits only when ALL of:
- Mesh downloaded and converted to GLB on disk (or no mesh needed)
- All face textures cached on disk
- Parent already emitted (or is a root prim)

Avatars are marked as emitted via `markEmitted()` (wired from `GodotAvatarManager.onAvatarEmitted`) so their attachments don't block.

**Late PBR textures:** When a PBR material asset resolves after initial tracking, the bridge calls `updatePendingFaces()` to patch the face data and `addTextures()` to add PBR textures as new dependencies.

### 2c. Mesh Fetch Queue

**File:** `electron-ui/src/main/assets/mesh-fetch-queue.ts`

| Structure | Type | Purpose |
|-----------|------|---------|
| `pending` | `Map<meshId, Set<objectId>>` | Objects waiting for this mesh |
| `queue` | `Array<string>` | Download queue |
| `active` | `number` | In-flight count (max 8) |
| `failed` | `Set<string>` | Permanently failed meshes |
| `notified` | `Set<string>` | Already resolved |

**Flow:** Check disk cache -> if miss, download from SL CDN -> convert in worker pool -> write `.glb` to disk -> store path in `meshMeta` map + notify readiness tracker via `onMeshReady`.

**Disk cache:** `{cacheDir}/meshes/{meshId}.glb`

### 2d. Texture Fetch Queue

**File:** `electron-ui/src/main/assets/texture-fetch-queue.ts`

| Structure | Type | Purpose |
|-----------|------|---------|
| `pending` | `Map<textureId, Set<objectUuid>>` | Objects waiting for this texture |
| `queue` | `Array<string>` | Download queue |
| `active` | `number` | In-flight count (max 32) |
| `failed` | `Set<string>` | Permanently failed textures |
| `notified` | `Set<string>` | Already resolved |

**Flow:** Check disk cache -> if miss, download J2K from SL CDN -> decode to RGBA -> GPU compress to BC1/BC3 (`.bctex`) or fallback WebP -> store path in `texturePaths` map + notify readiness tracker via `onTextureReady`.

**Disk cache:** `{cacheDir}/textures/{textureId}.bctex` or `.webp`

### 2e. Deferred Sweep

**File:** `godot-bridge.ts` — runs every 2 seconds via `setInterval`.

Calls `objectSender.sweepDeferredTextures()`:
- Pass 1: promote root prims now within `TEXTURE_FETCH_RANGE`
- Pass 2: promote children whose root was promoted (no longer in `deferredTextures`)
- Promoted objects go through the full `sendObject()` path

---

## Stage 3: WebSocket Transport

Messages flow over a local TCP WebSocket (`ws://127.0.0.1:{port}`).

Electron batches sends in a 16ms coalescer. Godot side has a 16MB inbound buffer + 65536 max queued packets.

---

## Stage 4: Godot main.gd — Message Dispatch

**File:** `godot-viewer/src/main.gd`

| Structure | Type | Purpose |
|-----------|------|---------|
| `_low_priority_queue` | `Array<String>` | Queued JSON strings for budgeted processing |

**Packet drain:** Every `_process` frame, drain all WebSocket packets:
- **High priority** (avatar_*, self_id, object_update_physics, sitting_state, electron_stats, pay_*): dispatch immediately
- **Low priority** (object_render, object_update_batch, etc.): append to `_low_priority_queue`

**Queue processing:** Drain `_low_priority_queue` within `DESKTOP_MSG_BUDGET_MS` (12ms).

---

## Stage 5: Godot Object Render

**File:** `godot-viewer/src/object_manager.gd` — `handle_object_render()`

Single entry point for object creation + mesh/face application. Steps:

### 5a. RSInstance creation (inside `handle_object_render`)

Creates an RSInstance (RenderingServer RID wrapper). No placeholder box for `object_render` messages (mesh/shape data is present). Stores in:

| Structure | File | Purpose |
|-----------|------|---------|
| `objects` | scene_manager.gd | `uuid -> RSInstance` — the live object |
| `object_meta` | scene_manager.gd | `uuid -> {name, description, clickAction, ...}` |
| `object_parent` | scene_manager.gd | `child_uuid -> parent_uuid` |
| `object_children` | scene_manager.gd | `parent_uuid -> [child_uuids]` |
| `child_offset_pos/rot` | scene_manager.gd | Relative transform for linkset children |
| `object_region_offset` | scene_manager.gd | `uuid -> Vector3` — world origin offset |
| `flexi_params` | scene_manager.gd | `uuid -> {softness, tension, ...}` (if flexible) |

### 5b. Queue disk->GPU loads

- `queue_mesh_load(meshId, meshPath)` — queues GLB parse if not already cached/in-flight
- `queue_texture_load(textureId, texturePath)` — queues texture load for each face (albedo + PBR)

### 5c. Mesh application

Three paths:

| Condition | Action |
|-----------|--------|
| Mesh in `mesh_cache` | `_apply_mesh()` immediately + `_apply_faces()` |
| Mesh loading (not cached) | `register_mesh_waiter(meshId, objUuid)` — callback applies when GPU-ready |
| Shape (procedural prim) | `_apply_shape()` generates prim mesh + `_apply_faces()` |

**`_apply_mesh(obj_uuid, mesh_id)`** handles:
- Rigged animesh children: skip RSInstance mesh (real mesh goes on Skeleton3D)
- Non-animesh rigged: apply with AABB correction (`scl_divisor`, `scl_center`)
- Standard: apply cached mesh directly
- Creates pick resources (physics body + ID buffer)
- Instantiates animesh mesh on shared skeleton if applicable

**`_apply_shape(obj_uuid, shape)`** handles:
- Procedural prim mesh generation (cached by shape hash)
- Flexi prims: higher tessellation + verlet simulation setup

### 5d. Face materials

`_apply_faces(obj_uuid)` calls `asset_pipeline.apply_face_materials()`:
- Faces with cached textures get real materials from `material_cache`
- Faces with uncached textures get placeholder materials, registered in `_tex_waiting`
- When texture finishes GPU loading, `_apply_texture_to_waiting()` re-applies

---

## Stage 6: Godot Asset Pipeline

**File:** `godot-viewer/src/asset_pipeline.gd`

### Mesh loading

| Structure | Type | Purpose |
|-----------|------|---------|
| `_mesh_queue` | `Array<{meshId, path}>` | Waiting for WorkerThreadPool slot |
| `_mesh_tasks` | `Dict<taskId, {meshId, result, path}>` | Active parse tasks (max 16) |
| `_mesh_in_flight` | `Dict<meshId, true>` | Dedup: don't re-queue same mesh |
| `mesh_cache` | `Dict<meshId, Mesh>` | **Final cache** — parsed Mesh resources |
| `mesh_load_failed` | `Dict<meshId, true>` | Permanent failure flag |
| `_waiting_for_mesh` | `Dict<meshId, Array[String]>` | Object UUIDs waiting for this mesh to become GPU-ready |

**Flow:** `queue_mesh_load()` -> `_mesh_queue` -> WorkerThreadPool (`GLTFDocument.append_from_file`) -> `_mesh_tasks` completion -> `ImporterMesh.get_mesh()` on main thread -> `mesh_cache[meshId]` -> `_flush_mesh_waiters()` calls `_apply_mesh()` + `_apply_faces()` per waiting object.

### Texture loading

| Structure | Type | Purpose |
|-----------|------|---------|
| `_texture_queue` | `Array<{textureId, path}>` | Shared queue (main pushes, workers pop) |
| `_texture_results` | `Array<{textureId, image}>` | Completed (workers push, main pops) |
| `_texture_in_flight` | `Dict<textureId, true>` | Dedup |
| `texture_cache` | `Dict<textureId, ImageTexture>` | **Final cache** — GPU-uploaded textures |
| `texture_load_failed` | `Dict<textureId, true>` | Permanent failure flag |
| `_texture_opaque` | `Dict<textureId, true>` | DXT1 = opaque (alpha optimization) |
| `_tex_waiting` | `Dict<textureId, Array[String]>` | Object UUIDs needing face re-apply when texture loads |

**Flow:** `queue_texture_load()` -> `_texture_queue` -> dedicated threads (load .bctex or .webp + compress) -> `_texture_results` -> main thread creates `ImageTexture` -> `texture_cache[textureId]` -> `_apply_texture_to_waiting()` re-applies face materials.

### Material cache

| Structure | Type | Purpose |
|-----------|------|---------|
| `material_cache` | `Dict<key, Material>` | Keyed by `"{texId}_{color}_{fb}_{ds}_{uv}_{alpha}_{pbr}"` |
| `_placeholder_cache` | `Dict<key, Material>` | Color-only placeholders while textures load |

### Finalization budget

All main-thread work (texture upload, mesh extract) runs in `finalize_frame()`:
- **Initial load (first 30s):** 50ms/frame budget
- **Normal:** adaptive — remaining frame time, min 2ms, overbudget 8ms
- **Split:** 60% textures, 40% meshes

### Eviction

`evict_unused_assets()` runs every 60s. Removes mesh_cache/texture_cache entries not referenced by any live RSInstance.

---

## Complete Queue Inventory

### Electron side (5 gates/queues)

| # | Queue | When stuck | Recovery |
|---|-------|------------|----------|
| 1 | `deferredTextures` | Root prim > 128m from bot | Sweep every 2s |
| 2 | `pendingChildren` | Parent not yet tracked | Flushed when parent sent |
| 3 | `ObjectReadinessTracker.pending` | Mesh/textures not on disk, or parent not emitted | `onMeshReady`/`onTextureReady` callbacks, parent flush |
| 4 | `meshFetchQueue.pending` | Download in progress | Drain loop (max 8 concurrent) |
| 5 | `textureFetchQueue.pending` | Download in progress | Drain loop (max 32 concurrent) |

### Godot side (4 queues before rendering)

| # | Queue | When stuck | Recovery |
|---|-------|------------|----------|
| 6 | `_low_priority_queue` (main.gd) | Frame budget exhausted | Next frame |
| 7 | `_waiting_for_mesh` | Mesh GLB not parsed to GPU yet | `_flush_mesh_waiters` on completion |
| 8 | `_mesh_queue` / `_mesh_tasks` | WorkerThreadPool busy | Max 16 concurrent |
| 9 | `_tex_waiting` | Texture not GPU-uploaded yet | `_apply_texture_to_waiting` on completion |

**Total: ~9 queues/gates between UDP packet and rendered pixel** (down from 13).

---

## Known Failure Modes

1. **Teleport from skybox (2000m) to ground:** Bot position stale at 2000m when ground objects arrive -> all deferred in `deferredTextures` (gate #1). Sweep should recover but may be slow for large object counts.

2. **Mesh arrives before `object_render`:** No issue — `queue_mesh_load` skips (already cached). `_apply_mesh()` finds it in `mesh_cache` immediately.

3. **`object_render` arrives before mesh GPU-ready:** Object registered in `_waiting_for_mesh`. When mesh finishes parsing, `_flush_mesh_waiters()` applies mesh + faces.

4. **Texture loads after face apply:** Placeholder material shown. `_tex_waiting` callback re-applies with real texture when GPU-ready.

5. **PBR material resolves after object emitted:** Face update sent via batcher — visual pop from placeholder to PBR. See Priority 1 in TODO for fix (gate on material assets).
