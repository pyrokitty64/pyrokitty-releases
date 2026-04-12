# Flexi Prim System

Flexi (flexible) prims are SL objects whose shape deforms under simulated physics — ponytails, flags, ribbons, skirts, etc. The server sends static shape parameters; the client simulates the flex animation locally.

## Architecture

```
TypeScript (godot-object-sender.ts)          Godot (flexi_prim_manager.gd)
 ┌─────────────────────────┐                  ┌──────────────────────────┐
 │ getFlexiInfo() extracts │  object_render   │ create_flexi()           │
 │ FlexibleData from       │ ──────────────>  │  ├─ Node3D root (pos+rot)│
 │ ExtraParams, sends:     │  { flexible:     │  ├─ Skeleton3D (9 bones) │
 │  tension, drag, gravity │    {tension,..}} │  ├─ rigged MeshInstance3D│
 │  wind, force, softness  │                  │  └─ Verlet sections[]    │
 └─────────────────────────┘                  └──────────────────────────┘
                                                         │
                                              scene_manager._process()
                                                         │
                                                         ▼
                                              flexi_mgr.simulate(delta)
                                               ├─ Verlet integration (world space)
                                               └─ _update_bones() → bone rotations
```

## Physics: Verlet Integration

The simulation is a direct port of Firestorm's `LLVolumeImplFlexible::doFlexibleUpdate()` (`indra/newview/llflexibleobject.cpp`). It runs in **world space** with these forces per section per frame:

1. **Gravity** — `position.y -= gravity * section_length * delta` (world -Y)
2. **User force** — arbitrary vector from the object's FlexibleData
3. **Tension** — restoring force toward parent section's direction: `t_factor = tension * 0.1 * (1 - 0.85^(dt*30))`
4. **Inertia** — `position += velocity * momentum` where `momentum = 1 / 10^((drag*2+1)*dt)`
5. **Angle clamp** — max bend per joint: `atan(section_length * 2)`
6. **Distance constraint** — each section is clamped to exactly `section_length` from its parent

Velocity is classic Verlet: `v = current_position - last_position`, capped at unit length.

### Section Layout

- **Section 0** (anchor): locked to the base of the prim each frame. Position = `root_pos - direction * flex_length/2`.
- **Sections 1..8**: simulated. Each has position, velocity, and direction (all world-space Vector3).

## Skeleton & Mesh Setup

### Coordinate Space

The prim mesh generator outputs vertices in Godot space via `_sl_to_godot(v) = (v.x, v.z, -v.y)`. This maps the SL Z axis (height = flex direction) to **Godot Y**. The mesh path therefore runs along Y in `[-0.5, +0.5]`.

### Bone Chain

9 bones total, all along Y:
- **Bone 0** (`flexi_anchor`): rest at `(0, -flex_length/2, 0)`. Fixed — not simulated.
- **Bones 1-8** (`flexi_bone_0` through `flexi_bone_7`): each a child of the previous, rest offset `(0, flex_length/8, 0)`.

### Scale Baking

The root node carries **position + rotation only** (no scale). Prim scale is baked into:
- Mesh vertices: `v *= prim_scale` (component-wise, both in Godot space)
- Bone rest positions: anchor at `-prim_scale.y/2`, segments of `prim_scale.y/8`

This avoids the GPU skinning distortion that occurs when a Skeleton3D has a non-uniformly-scaled parent.

### Bone Weights

Vertices are weighted along unscaled Y: `t = (vertex.y + 0.5) * 8`, then linearly blended between the two nearest bones (4 weights per vertex, only 2 non-zero).

### Bone Rotation Conversion

Each frame, world-space section directions are converted to per-bone pose rotations:

1. Start with `accumulated_basis = root.global_transform.basis.orthonormalized()`
2. For each bone i (1..8):
   - `local_dir = accumulated_basis.inverse() * section[i].direction`
   - `pose_rot = shortest_arc(UP, local_dir)`
   - `set_bone_pose_rotation(i, pose_rot)`
   - `accumulated_basis *= Basis(pose_rot)`

This produces incremental bend angles at each joint — the bone hierarchy naturally accumulates them.

## SL Parameter Mapping

| SL Parameter | Range | Effect |
|-------------|-------|--------|
| tension | 0-10 | Restoring stiffness (higher = more rigid) |
| drag | 0-10 | Air friction / damping (higher = less swing) |
| gravity | signed float | Downward pull (positive = down in SL) |
| wind | 0-10 | Wind sensitivity (currently unused — needs region wind data) |
| softness | 0-3 | In SL controls section count (2^softness). We always use 8 bones. |
| force | Vector3 | Constant user-defined force in world space |

## Key Files

| File | Role |
|------|------|
| `godot-viewer/src/flexi_prim_manager.gd` | Verlet simulation, skeleton/mesh setup, bone updates |
| `godot-viewer/src/prim_mesh_generator.gd` | `generate_flexi()` — 14-point tessellated mesh |
| `godot-viewer/src/scene_manager.gd` | Calls `flexi_mgr.simulate(delta)` in `_process()` |
| `godot-viewer/src/object_manager.gd` | Creates/destroys flexi prims, relays transform updates |
| `electron-ui/src/main/bridge/godot-object-sender.ts` | `getFlexiInfo()` — extracts FlexibleData from ExtraParams |
| `firestorm/indra/newview/llflexibleobject.cpp` | Reference implementation (Firestorm's Verlet sim) |

## Design History

Earlier attempts used Godot's `SpringBoneSimulator3D` node, which failed for two reasons:
1. **Wrong bone axis** — bones were placed along mesh Z (depth) instead of Y (path/flex direction). The `_sl_to_godot` coordinate conversion was not accounted for.
2. **Coordinate mismatch** — SpringBoneSimulator3D operates in bone-local space, making world-space forces (gravity, wind) difficult to map correctly. Parameter tuning was guesswork.

The Verlet approach solves both: simulation runs in world space with Firestorm's exact equations, and bones are correctly oriented along Y.
