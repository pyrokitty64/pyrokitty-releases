# Animesh Pipeline

End-to-end reference for how animesh objects flow from the SL network through node-metaverse (TypeScript) to the Godot viewer (GDScript). Covers both **rezzed animesh** (standalone objects on the ground) and **worn animesh** (avatar attachments with their own skeleton).

Key files:

| Side | File | Role |
|------|------|------|
| TS | `godot-object-sender.ts` | Animesh detection, `object_render` message formatting |
| TS | `mesh-converter.ts` | LLMesh → GLB (skeleton, skin, IBMs) |
| TS | `mesh-fetch-queue.ts` | Concurrent mesh downloads + caching |
| TS | `animation-fetch-queue.ts` | LLAnimation → JSON + caching |
| TS | `godot-animation-manager.ts` | ObjectAnimation subscription, batch sends |
| TS | `godot-avatar-manager.ts` | Avatar lifecycle, attachments, BoM, shapes |
| TS | `object-readiness-tracker.ts` | Gates `object_render` until mesh + textures cached |
| TS | `godot-update-coalescer.ts` | Animesh state tracking, terse/full coalescing |
| GD | `object_manager.gd` | Object creation, mesh instantiation, skin remap |
| GD | `skeleton_builder.gd` | Shared Skeleton3D from XML (159 bones) |
| GD | `animation_manager.gd` | Threaded animation evaluation + shape overrides |
| GD | `scene_manager.gd` | State dictionaries (roots, skeletons, overrides) |
| GD | `avatar_manager.gd` | Avatar-specific lifecycle hooks |

---

## 1. Animesh Detection (TypeScript)

An object is animesh when its `ObjectUpdate` network message contains:

```
extendedMeshData.flags & 0x1 === 1
```

**Detection points:**

- `godot-object-sender.ts:sendObject()` — reads the flag, sets `isAnimesh`
- `godot-update-coalescer.ts` — tracks animesh state per UUID in `objectAnimeshState` Map. If the flag changes between updates, a full object re-creation is triggered (destroy + create)

---

## 2. Single `object_render` Message

Animesh objects follow the same single-message flow as all objects. Electron gates on mesh + all textures being cached to disk, then sends everything at once. Godot is a dumb renderer — no deferred queues or back-channel asset requests.

### `object_render`

Sent by `ObjectReadinessTracker` once mesh and all face textures are cached on disk.

```typescript
{
  type: 'object_render',
  uuid: string,
  parentUuid: string,       // avatar UUID for worn, '' for rezzed
  position: [x, z, -y],     // SL → Godot coords
  rotation: [x, z, -y, w],
  scale: [x, z, y],
  meshId: string,            // mesh asset UUID
  meshPath: string,          // absolute path to cached .glb
  isRigged: boolean,
  jointNames: string[],      // GLB skeleton bone order
  jointOverrides: string[],  // joints with alt_inverse_bind_matrix
  faces: [{ index, textureId, texturePath, color, alphaMode, ... }],
  animesh: true,             // KEY: triggers skeleton creation in Godot
  attachmentPoint?: number,  // >0 for worn attachments
}
```

Mesh path and per-face texture paths are filled by the `enrichFn` at emit time from in-memory lookup maps (`meshMeta`, `texturePaths`), not stored in the readiness tracker.

---

## 3. Mesh Conversion (TypeScript → GLB)

`mesh-converter.ts:llMeshToGlb()` converts SL's proprietary LLMesh format to a standard GLB file.

### Skeleton hierarchy

- Built from `avatar_skeleton.json` (159 bones: standard + collision volumes)
- Root joint: `mPelvis`
- Rest transforms: `composeMatrix(scale, eulerRad, translate)` per XML entry
- Coordinate conversion: SL (X,Y,Z) → glTF (X,Z,-Y) via `slToGltfMatrix()`

### Skin binding

- Joint names resolved via `resolveJointName()` (supports aliases from XML)
- GLB skins have **no bind names** — only bone indices. Godot resolves by index.
- Skin joints indexed by GLB skeleton order

### Inverse bind matrices (IBMs)

1. **Raw IBMs** from mesh `skin.inverseBindMatrix`
2. **CV fixup** — for collision volume bones without alt IBM overrides, derive local transform from `inverse(rawIBM)` (only when bind shape matrix is identity)
3. **alt_inverse_bind_matrix overrides** — position-only overrides applied if difference > 0.1mm (Hippolyzer threshold)
4. **Blender compatibility split** — each joint matrix split into translation-only (node) + scale+rotation (fixup). Fixup baked into IBM: `ibm = fixup * raw_ibm`

### Bind shape matrix (BSM)

- Applied to all vertices before skinning
- Inverse-transpose applied to normals
- Affects IBM computation for CVs (`bsmIsIdentity` check gates CV fixup)

### Metadata output

Stored in `.meta` sidecar alongside the GLB:

```json
{
  "isRigged": true,
  "jointNames": ["mPelvis", "mTorso", ...],
  "jointOverrides": ["mHead", "mNose"]
}
```

---

## 4. Mesh Fetch Pipeline (TypeScript)

`mesh-fetch-queue.ts` manages concurrent downloads:

```
ObjectUpdate (has mesh UUID)
  → MeshFetchQueue.request(meshId, objUuid)
  → bot.clientCommands.asset.downloadAsset(AssetType.Mesh, meshUuid)
  → llMeshToGlb() → cached to {userData}/asset-cache/meshes/{meshUuid}.glb
  → onReady callback → marks mesh resolved in ObjectReadinessTracker
```

- Max 8 concurrent downloads (`MAX_CONCURRENT = 8`)
- Deduplication: shared meshes fetched once, multiple requestors queued
- Metadata extracted on completion: `isRigged`, `jointNames`, `jointOverrides`

---

## 5. Godot Object Creation (`object_manager.gd`)

### `handle_object_render()`

Single entry point for object creation + mesh/face application.

**Animesh root detection** — if `msg.animesh == true`:

1. Create a `Node3D` in the scene tree
2. Create a shared `Skeleton3D` via `skeleton_builder.create_shared_skeleton()`
3. Register in state dictionaries:
   - `sm.animesh_roots[uuid] = node`
   - `sm.animesh_shared_skeleton[uuid] = skeleton`
   - `sm.animesh_root_for[uuid] = uuid` (self-reference)
4. Notify animation thread: `animation_mgr.push_avatar_created(uuid, skeleton)`
5. Queue mesh + texture disk→GPU loads, then apply mesh and faces

**Child objects** (non-animesh parts of an animesh linkset) register `sm.animesh_root_for[child_uuid] = root_uuid` so they rig to the same skeleton.

---

## 6. Animesh Mesh Instantiation (`object_manager.gd`)

`_instantiate_animesh_mesh()` binds a GLB mesh to the shared skeleton:

1. **Load GLB** — `load(glb_path)`, instantiate, extract MeshInstance3D + GLB's Skeleton3D

2. **Apply joint position overrides** via `animation_mgr._apply_joint_overrides()`:
   - Overrides come from `object_render.jointOverrides` (alt IBM positions)
   - **Priority**: lowest mesh UUID wins (matching SL's `std::map<LLUUID>` ordering)
   - **No-op filter**: skips overrides within 0.1mm of XML default position
   - Tracked per-bone in `sm.bone_override_owner[root_uuid]`

3. **Skin index remapping**:
   - Duplicate GLB skin: `orig_skin.duplicate()`
   - For each bind bone in GLB:
     - Look up bone name in shared skeleton
     - If missing: **dynamically add** bone with GLB rest transform
     - Update `skin.bind_bone[i]` to shared skeleton index
   - Bind poses (IBMs) stay unchanged — both skeletons have identical rest transforms

4. **Reparent mesh**:
   - Remove MeshInstance3D from GLB Skeleton3D
   - Add as child of shared Skeleton3D
   - `mesh_instance.transform = Transform3D.IDENTITY`
   - `mesh_instance.skeleton = path_to(shared_skel)`

5. **Cleanup** — hide placeholder, free GLB scene tree, update animation thread bone metadata

---

## 7. Skeleton Building (`skeleton_builder.gd`)

`create_shared_skeleton()` builds a Skeleton3D from `avatar_skeleton.json`:

- 159 bones in parent-first order
- **Rest transforms**: translation-only (Identity basis + position)
- CV rotation baked into GLB IBMs (not into rest)
- Coordinate conversion: SL `(x, y, z)` → Godot `(x, z, -y)`
- `get_sl_rest_rotations()` returns a Dict of CV bones with non-zero rest rotation (used as fallback during animation evaluation)

---

## 8. Animation Pipeline

### 8a. Animation Fetch (TypeScript)

`animation-fetch-queue.ts` downloads and parses SL animation assets:

```
ObjectAnimation circuit message (contains anim UUIDs + sequence IDs)
  → GodotAnimationManager.updateAnimSet(uuid, animIds)
  → AnimationFetchQueue.request(animId)
  → bot.clientCommands.asset.downloadAsset(AssetType.Animation, animId)
  → LLAnimation parsed → JSON
  → cached to {userData}/asset-cache/animations/{animId}.json
  → animations_batch sent to Godot
```

- Max 4 concurrent downloads
- Joint names resolved against `avatar_skeleton.json` + `avatar_lad_attachments.json`
- Unknown joints scrubbed (logged)
- Position values scaled: raw `[-1, 1]` → SL `[-5, 5]` meters

### 8b. `animations_batch` message

```typescript
{
  type: 'animations_batch',
  uuid: string,              // animesh root UUID
  animations: {
    [animId]: {
      duration: number,
      loop: boolean,
      priority: number,
      joints: [{
        name: string,
        priority: number,
        rotationKeys: [{ time, value: [x, y, z] }],
        positionKeys: [{ time, value: [x, y, z] }],
      }],
    }
  }
}
```

### 8c. Animation Sources

| Type | Network Message | Routing |
|------|----------------|---------|
| Avatar | `AvatarAnimation` | Via avatar UUID |
| Rezzed animesh | `ObjectAnimation` | Via object UUID |
| Worn animesh | `ObjectAnimation` | Via attachment's own UUID, merged with parent avatar's eval |

`ObjectAnimation` messages are buffered at `MetaverseConnection` level during login and replayed to `GodotBridge` on init.

### 8d. Animation Evaluation (Godot — `animation_manager.gd`)

Runs on a **dedicated thread**, never touches Skeleton3D directly.

**Command queue** — main thread pushes commands:
- `CMD_AVATAR_CREATED` — init bone metadata, create eval state + output slot
- `CMD_ANIM_CHANGED` — update joints dictionary, rebuild active bones
- `CMD_SHAPE_CHANGED` — update shape scales + volume morphs
- `CMD_BONE_META_UPDATE` — re-snapshot (after dynamic bone addition)
- `CMD_CV_DATA` — CV rest rotations + default scales (sent once)
- `CMD_REGION_CHANGE` — clear all state

**Active bone set** (`_rebuild_active_bones()`):
- Animated joints + CV bones with rest rotations + bones with shape scales + CV bones with volume morphs + all ancestors
- Sorted parent-before-child for correct world transform accumulation

**Per-frame evaluation** (`_thread_evaluate_root()` → `_thread_eval_skeleton()`):
1. Interpolate keyframes to current time
2. Per-channel priority arbitration (rotation and position tracked independently)
3. SL-space world rotation via parent chain accumulation
4. Convert to Godot space: `(x, z, -y)` coordinate swap
5. Compute pose rotation: `parent_world_inv * world`
6. Positions: `absolute_godot - rest_origin` (persistent — not reset each frame)

**Global pose overrides** (`_thread_global_overrides()`):
- Applies parent shape scale to child positions (matching `xform.cpp:76`)
- Applies bone's own shape scale into skinning basis (matching `xform.cpp:93`)
- CV bones: volume morph deltas as deformation ratio `(current / default)`
- Output: `Transform3D` per bone for `set_bone_global_pose_override()`

**Output** — per-root output slot (mutex-protected):
- `pose_rotations` — per-bone Quaternion
- `pose_positions` — per-bone Vector3
- `global_overrides` — per-bone Transform3D
- `ready` flag — consumed by main thread

### 8e. Main Thread Consumption (`consume_anim_slots()`)

Called every frame from `scene_manager._process()`:

1. **LOD gating** — self avatar: always; others: gated by distance with frame intervals
2. Reset only previously-set bones (smart reset)
3. Apply `set_bone_pose_rotation()` — local animation rotations
4. Apply `set_bone_pose_position()` — animation positions (persistent)
5. Apply `set_bone_global_pose_override()` — shape deformation (parent scale + bone scale)
6. Update non-rigged bone attachments
7. Update debug markers

---

## 9. Rezzed Animesh vs Worn Animesh

### Rezzed animesh (standalone object)

- Created as direct child of scene root
- Gets its **own skeleton** (always)
- Scale stays `Vector3.ONE` (SL doesn't scale animesh by prim scale)
- Animations arrive via `ObjectAnimation` circuit message
- No shape deformation (no VisualParams on objects)
- Joint overrides applied from mesh alt IBMs

### Worn animesh (avatar attachment)

- Created as child of avatar's Node3D
- Gets its **own skeleton** (separate from avatar's — matching Firestorm's `LLControlAvatar`)
- Child prims' joint overrides do NOT affect the avatar's skeleton
- No shape deformation (no VisualParams)

**Avatar attachment detection** (TypeScript side):
- `godot-avatar-manager.ts:sendAvatarCreate()` calls `avatar.getAttachments()` for initial attachments
- Subscribes to `avatar.onAttachmentAdded` for late arrivals
- Each attachment sent via `godot-object-sender.ts:sendObject(attachment, avatarUuid)` with avatar as `parentUuid`
- If attachment is animesh (`extendedMeshData.flags & 0x1`): registered with animation manager automatically

**Animation routing for worn animesh** (Godot side):
- `animations_batch` arrives with `uuid` = worn animesh UUID
- If `anim_root != obj_uuid`, stored in `sm.animesh_worn_anims[anim_root]`
- `_apply_pending_animations()` merges avatar's own animations + worn animesh animations
- Each worn animesh evaluated as its own root on the animation thread (separate output slot)

**Transform tracking**:
- Position is parent-local (converted from world using avatar's position + rotation)
- Uses attachment point bone position from shared skeleton if available
- Non-rigged attachments tracked per-frame via `sm.attach_bone[uuid]`

---

## 10. State Dictionaries (`scene_manager.gd`)

```gdscript
animesh_roots[root_uuid]              # Node3D scene tree parent
animesh_shared_skeleton[root_uuid]    # Skeleton3D (ONE per root, 159 bones)
animesh_root_for[obj_uuid]            # Maps any object → its animesh root UUID
animesh_pending_anims[root_uuid]      # Buffered animation IDs
animesh_worn_anims[root_uuid]         # Worn attachment animation IDs
animesh_mesh_instances[obj_uuid]      # MeshInstance3D (for texture updates)
object_mesh_id[obj_uuid]              # Mesh asset UUID
attach_bone[obj_uuid]                 # Bone name for non-rigged attachment
attach_point_id[obj_uuid]             # Attachment point ID (1-55)
bone_override_owner[root_uuid]        # Dict { bone_name: mesh_uuid } for priority
bone_shape_scales[root_uuid]          # Dict { bone_name: Vector3 } SL-space scales
cv_volume_morphs[root_uuid]           # Dict { cv_name: Vector3 } morph deltas
```

---

## 11. End-to-End Flow Diagrams

### Rezzed animesh

```
SL Server
  │
  ├─ ObjectUpdate (extendedMeshData.flags & 0x1)
  │    → godot-object-sender.ts: detects isAnimesh
  │    → queues mesh + texture fetches 
  │    → ObjectReadinessTracker.track() gates until all assets cached
  │
  ├─ MeshFetchQueue
  │    → downloads LLMesh asset
  │    → mesh-converter.ts: llMeshToGlb() (skeleton + skin + IBMs)
  │    → caches .glb + .meta to disk
  │    → marks mesh resolved in ObjectReadinessTracker
  │
  ├─ ObjectReadinessTracker
  │    → waits for mesh + all textures cached + parent emitted
  │    → sends object_render { meshId, meshPath, faces, animesh: true, ... }
  │
  └─ ObjectAnimation circuit message
       → godot-animation-manager.ts: updateAnimSet()
       → AnimationFetchQueue: downloads + parses LLAnimation
       → sends animations_batch { joints, keyframes, priorities }

Godot Viewer
  │
  ├─ handle_object_render()
  │    → creates Node3D + Skeleton3D (159 bones)
  │    → registers in animesh_roots, animesh_shared_skeleton
  │    → notifies animation thread (CMD_AVATAR_CREATED)
  │    → queues mesh + texture disk→GPU loads
  │    → _instantiate_animesh_mesh() (when mesh GPU-ready)
  │    → loads GLB, applies joint overrides
  │    → remaps skin indices → shared skeleton
  │    → reparents MeshInstance3D under shared Skeleton3D
  │
  ├─ handle_animations_batch()
  │    → merges per-joint per-channel priorities
  │    → pushes CMD_ANIM_CHANGED to animation thread
  │
  └─ Animation thread (every frame)
       → interpolates keyframes
       → evaluates skeleton (pure math, no Skeleton3D)
       → computes global pose overrides (shape scale)
       → writes output slot
       → main thread applies to Skeleton3D in consume_anim_slots()
```

### Worn animesh (avatar attachment)

```
SL Server
  │
  ├─ AvatarAppearance (parent avatar)
  │    → godot-avatar-manager.ts: sendAvatarCreate()
  │    → avatar.getAttachments() → finds animesh attachment
  │    → sendObject(attachment, avatarUuid) → object_render { animesh, parentUuid, attachmentPoint }
  │
  ├─ onAttachmentAdded (late arrivals)
  │    → same path as above
  │
  └─ ObjectAnimation (for the worn animesh specifically)
       → animations_batch → routed by worn animesh UUID

Godot Viewer
  │
  ├─ handle_object_render()
  │    → parent is avatar → creates Node3D as child of avatar node
  │    → creates SEPARATE Skeleton3D (own skeleton, not avatar's)
  │    → registers in animesh_roots with own UUID as root
  │    → animation thread gets separate eval slot
  │
  ├─ Mesh instantiation: same as rezzed animesh
  │
  └─ Animation: evaluated independently on own skeleton
       → worn animesh anims stored in animesh_worn_anims[avatar_root]
       → merged during _apply_pending_animations()
       → separate output slot on animation thread
```

---

## 12. Coordinate Systems

| Data | SL space | Godot space |
|------|----------|-------------|
| Position | (x, y, z) | (x, z, -y) |
| Quaternion | (x, y, z, w) | (x, z, -y, w) |
| Scale (shape) | (sx, sy, sz) | (sx, sz, sy) |

GLB uses glTF coordinates: SL (X,Y,Z) → glTF (X,Z,-Y) via `slToGltfMatrix()` in mesh-converter.

---

## 13. What Failed (Do Not Retry)

- **AnimationPlayer**: SL rotation composition order incompatible — use manual evaluation
- **Per-mesh Skeleton3D as siblings**: Breaks Godot skin binding — must be parent of MeshInstance3D
- **Basis.from_scale() on rest**: Cascades through entire subtree (SL only scales direct child positions)
- **Baking parent scale into rest positions**: Creates mismatch with IBMs (eyes pop). Use dynamic parent scale in `_thread_global_overrides` instead.

---

## Firestorm Source References

| Topic | File | Location |
|-------|------|----------|
| ControlAvatar (worn animesh) | `llcontrolavatar.cpp` | Separate avatar with own skeleton |
| World matrix with scale | `xform.cpp` | line 93: `initAll(mScale, mWorldRotation, mWorldPosition)` |
| Parent scale on children | `xform.cpp` | line 76: `mWorldPosition.scaleVec(mParent->getScale())` |
| Skinning matrix palette | `llskinningutil.cpp` | line 182: `matMul(invBind, world, mat)` |
| Override application | `llvoavatar.cpp` | `addAttachmentOverridesForObject` ~line 7744 |
| Override threshold | `lljoint.cpp` | `aboveJointPosThreshold` line 398 (0.1mm) |
