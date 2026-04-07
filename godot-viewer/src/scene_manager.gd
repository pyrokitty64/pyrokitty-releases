extends Node3D

## Manages in-world objects and avatars as lightweight RenderingServer RIDs.
## Coordinate conversion: SL (X=East, Y=North, Z=Up) -> Godot (X=Right, Y=Up, Z=-Forward)
##   Position: (sl.x, sl.z, -sl.y)
##   Quaternion: (sl.x, sl.z, -sl.y, sl.w)

const FrameBudget = preload("res://src/frame_budget.gd")
const PrimMeshGeneratorScript = preload("res://src/prim_mesh_generator.gd")
const ObjectManagerScript = preload("res://src/object_manager.gd")
const AnimationManagerScript = preload("res://src/animation_manager.gd")
const AvatarManagerScript = preload("res://src/avatar_manager.gd")
const InterpolationManagerScript = preload("res://src/interpolation_manager.gd")
const LightManagerScript = preload("res://src/light_manager.gd")
const AssetPipelineScript = preload("res://src/asset_pipeline.gd")
const TerrainEnvironmentScript = preload("res://src/terrain_environment.gd")
const ObjectPickerScript = preload("res://src/object_picker.gd")
const SkeletonBuilderScript = preload("res://src/skeleton_builder.gd")
const NameBubbleManagerScript = preload("res://src/name_bubble_manager.gd")
const NameBubble3DManagerScript = preload("res://src/name_bubble_3d_manager.gd")
const FlexiPrimManagerScript = preload("res://src/FlexiPrimManager.cs")
const TouchManagerScript = preload("res://src/touch_manager.gd")
const DebugInvisibleShader = preload("res://src/debug_invisible_highlight.gdshader")

signal self_avatar_moved(pos: Vector3)
signal object_properties_received(uuid: String, name: String, description: String)

## Lightweight RefCounted wrapper around a RenderingServer instance RID.
## Replaces MeshInstance3D nodes to eliminate scene tree overhead.
class RSInstance extends RefCounted:
	var rid: RID
	var pos: Vector3 = Vector3.ZERO
	var rot: Quaternion = Quaternion.IDENTITY
	var scl: Vector3 = Vector3.ONE
	var scl_divisor: Vector3 = Vector3.ONE  # Rigged mesh AABB size correction
	var scl_center: Vector3 = Vector3.ZERO  # Rigged mesh AABB center offset
	var mesh: Mesh = null
	var _surface_mats: Array = []   # Strong refs so GC doesn't free materials while RS uses them
	var _mat_override: Material = null
	var on_transform_pushed: Callable

	func _init(scenario: RID, vis_far: float = 128.0, vis_fade: float = 32.0) -> void:
		rid = RenderingServer.instance_create()
		RenderingServer.instance_set_scenario(rid, scenario)
		RenderingServer.instance_geometry_set_cast_shadows_setting(rid, RenderingServer.SHADOW_CASTING_SETTING_ON)
		RenderingServer.instance_geometry_set_visibility_range(rid, 0.0, vis_far, 0.0, vis_fade, RenderingServer.VISIBILITY_RANGE_FADE_SELF)

	func set_vis_range(vis_far: float, vis_fade: float) -> void:
		RenderingServer.instance_geometry_set_visibility_range(rid, 0.0, vis_far, 0.0, vis_fade, RenderingServer.VISIBILITY_RANGE_FADE_SELF)

	func set_mesh(m: Mesh) -> void:
		mesh = m
		RenderingServer.instance_set_base(rid, m.get_rid())

	func push_transform() -> void:
		var effective_scl: Vector3 = scl / scl_divisor
		# Center mesh on prim position: subtract scaled AABB center so the mesh
		# midpoint aligns with the prim origin (SL convention for unrigged meshes)
		var adjusted_pos: Vector3 = pos - Basis(rot) * (effective_scl * scl_center)
		var xform := Transform3D(Basis(rot) * Basis.from_scale(effective_scl), adjusted_pos)
		RenderingServer.instance_set_transform(rid, xform)
		if on_transform_pushed.is_valid():
			on_transform_pushed.call(xform)

	func set_material_override(mat: Material) -> void:
		_mat_override = mat
		if mat == null:
			RenderingServer.instance_geometry_set_material_override(rid, RID())
		else:
			RenderingServer.instance_geometry_set_material_override(rid, mat.get_rid())

	func set_surface_material(idx: int, mat: Material) -> void:
		if idx >= _surface_mats.size():
			_surface_mats.resize(idx + 1)
		_surface_mats[idx] = mat
		if mat == null:
			RenderingServer.instance_set_surface_override_material(rid, idx, RID())
		else:
			RenderingServer.instance_set_surface_override_material(rid, idx, mat.get_rid())

	func destroy() -> void:
		RenderingServer.free_rid(rid)


# ─── Shared State ────────────────────────────────────
# All tracking dictionaries live here. Sub-managers access via their `sm` reference.

var objects: Dictionary = {}   # uuid (String) -> RSInstance
var avatars: Dictionary = {}   # avatarId (String) -> RSInstance
var self_avatar_id: String = ""
var debug_mode: bool = false   # toggled by CTRL+SHIFT+1 — enables visual debug overlays
var _debug_invisible_mat: ShaderMaterial  # lazily created red overlay for invisible faces
var self_avatar_target_rot: Quaternion = Quaternion.IDENTITY  # target yaw, damped in interpolation

# World origin — set at login, updated on teleport. All positions relative to this.
var world_origin_x: float = 0.0
var world_origin_y: float = 0.0

# Per-region offsets from world origin, keyed by cacheID
var region_offsets: Dictionary = {}   # cacheID (String) -> Vector2(offsetX, offsetY)

# Per-object region offset (stored at creation, reused on updates)
var object_region_offset: Dictionary = {}   # uuid (String) -> Vector3(offsetX, 0, offsetY)

# Interpolation targets
var avatar_targets: Dictionary = {}   # avatarId -> { pos, rot, vel, age }
var object_targets: Dictionary = {}   # uuid (String) -> { pos, rot, vel, accel, angVel, age }
# avatar_local_ids removed — animesh_roots/animesh_shared_skeleton now keyed by avatar UUID directly

# Linkset tracking (flat hierarchy — no Godot node parenting to avoid scale inheritance)
var pending_children: Dictionary = {}   # parent uuid (String) -> Array[child uuid (String)]
var object_parent: Dictionary = {}      # child uuid (String) -> parent uuid (String)
var object_children: Dictionary = {}    # parent uuid (String) -> Array[child uuid (String)]
var child_offset_pos: Dictionary = {}   # uuid (String) -> Vector3
var child_offset_rot: Dictionary = {}   # uuid (String) -> Quaternion
var pending_seated_avatars: Dictionary = {}  # seat uuid (String) -> Array[{id, pos, rot}]

# Shared mesh resources
var object_mesh: BoxMesh
var avatar_mesh: BoxMesh
var object_material: StandardMaterial3D
var avatar_material: StandardMaterial3D

# Mesh pipeline
var mesh_cache: Dictionary = {}        # meshId (String) -> Mesh resource
var mesh_load_failed: Dictionary = {}  # meshId (String) -> bool

# Texture pipeline
var texture_cache: Dictionary = {}        # textureId (String) -> ImageTexture
var material_cache: Dictionary = {}       # "uuid_colorhex_fb_ds_uv" (String) -> StandardMaterial3D
var object_meta: Dictionary = {}          # uuid (String) -> { name, description }
var object_faces: Dictionary = {}         # uuid (String) -> Array[face_info dicts]
var object_is_attachment: Dictionary = {} # uuid (String) -> bool (from Electron isAttachment)
var texture_load_failed: Dictionary = {}  # textureId (String) -> bool

# Animesh (rigged mesh with skeleton animation)
var animesh_roots: Dictionary = {}         # root uuid (String) -> Node3D (scene tree parent)
var animesh_shared_skeleton: Dictionary = {} # root uuid (String) -> Skeleton3D (ONE per avatar, from XML)
# animesh_mesh_skeletons removed — all meshes now bind to the shared skeleton
var animesh_root_for: Dictionary = {}      # uuid (String) -> root uuid (String) (maps object to its animesh root)
var rigged_mesh_paths: Dictionary = {}     # meshId (String) -> GLB path (for generate_scene)
var mesh_joint_overrides: Dictionary = {} # meshId (String) -> Array[String] (joints with custom positions)
var animesh_pelvis_offset: Dictionary = {} # animesh root uuid -> Vector3 (negated pelvis rest, for root-prim animesh)
var bone_override_owner: Dictionary = {}  # root uuid (String) -> Dictionary { boneName -> meshId } (lowest UUID wins)
var bone_shape_scales: Dictionary = {}   # root uuid (String) -> Dictionary { boneName -> Vector3 (SL space scale) }
var cv_volume_morphs: Dictionary = {}    # root uuid (String) -> Dictionary { cvName -> { scale: Vec3, offset: Vec3 } }
var animesh_anim_data: Dictionary = {}    # animId (String) -> raw Dictionary (with per-joint priorities)
var animesh_pending_anims: Dictionary = {} # root uuid (String) -> Array[animId String] (pending animation IDs)
var animesh_worn_anims: Dictionary = {}   # root uuid (String) -> Array[animId String] (from worn animesh attachments)
var animesh_mesh_instances: Dictionary = {} # uuid (String) -> MeshInstance3D (for texture application)

# Attachment point bone tracking — non-rigged attachments follow their bone each frame
# Flexi (flexible) prim tracking — flexi prims bypass RSInstance and use Skeleton3D+SpringBone
var flexi_params: Dictionary = {}             # uuid (String) -> Dictionary (SL flexi params from object_create)

var attach_bone: Dictionary = {}            # uuid (String) -> bone name (String) for objects attached to avatar bones
var attach_bone_idx: Dictionary = {}        # uuid (String) -> bone index (int), cached from find_bone at registration
var attach_point_id: Dictionary = {}        # uuid (String) -> attachmentPointId (int)
var bone_global_overrides: Dictionary = {}  # root uuid (String) -> {bone_name -> Vector3} (global rest positions from meshes)

# Skeleton builder — parses avatar_skeleton.xml once, creates shared skeletons
var skeleton_builder: RefCounted

# Manual animation evaluation (replaces AnimationPlayer for correct SL→Godot rotation order)
# SL: world = local * parent.  Godot: world = parent * local.  Must conjugate per bone.
var animesh_eval: Dictionary = {}          # root uuid (String) -> {time, duration, loop, joints: {name -> {rot_keys, pos_keys}}}
var animesh_eval_active: bool = false      # true when any animesh has active animation data
var object_mesh_id: Dictionary = {}        # uuid (String) -> meshId (String) — persists after mesh loads

# Prim geometry generator
var prim_generator: RefCounted

# Cached scenario RID for RSInstance creation
var _scenario: RID
var _target_frame_ms: float = FrameBudget.DESKTOP_FRAME_MS
var _vr_mode: bool = false
var _vis_far: float = 128.0   # SL draw distance; VR overrides computed at call sites via _vr_mode
var _vis_fade: float = 32.0
var send_fn: Callable  # set by main.gd; routes messages back to TS over WebSocket
var _evict_timer: float = 0.0
const EVICT_INTERVAL: float = 60.0

# ─── Distance Culling (always active) ──────────────────
var _dist_hidden_avatars: Dictionary = {}  # root_uuid -> true (beyond draw distance)

# ─── Occlusion Culling ─────────────────────────────────
var _occ_enabled: bool = false
const OCC_HIDE_AFTER_SCANS: int = 5   # consecutive scan misses before hiding (= seconds at 1 scan/s)
var _occ_missing_scans: Dictionary = {}  # uuid -> int (consecutive miss count)
var _occ_hidden_uuids: Dictionary = {}   # uuid -> true (hidden by occlusion culling)
var _occ_visible_ids: Dictionary = {}    # numeric_id -> true (from last scan)
# Avatar-level occlusion — hides skeleton, meshes, and pauses animation
var _occ_av_missing_scans: Dictionary = {} # root_uuid -> int (consecutive miss count)
var _occ_hidden_avatars: Dictionary = {}   # root_uuid -> true
var _occ_avatar_hidden_objs: Dictionary = {} # root_uuid -> Array[String] (object uuids we hid)


# Loading fade-in overlay (opaque black → transparent)
var _fade_overlay: ColorRect = null
var _fade_alpha: float = 1.0
const _LOADING_FADE_IN_SPEED: float = 0.5  # alpha units/sec after loading ends (~2s fade)

# ─── Sub-managers ────────────────────────────────────

var object_mgr: RefCounted         # ObjectManager
var animation_mgr: RefCounted      # AnimationManager
var avatar_mgr: RefCounted         # AvatarManager
var interp_mgr: RefCounted         # InterpolationManager
var light_mgr: RefCounted          # LightManager
var asset_pipeline: RefCounted     # AssetPipeline
var terrain_env: RefCounted        # TerrainEnvironment
var object_picker: RefCounted      # ObjectPicker
var touch_mgr: RefCounted          # TouchManager
var name_bubble_mgr: RefCounted    # NameBubbleManager (2D screen-space)
var name_bubble_3d_mgr: RefCounted # NameBubble3DManager (3D world-space)
var _bubble_2d_active: bool = true   # desktop default; VR flips these
var _bubble_3d_active: bool = false
var flexi_mgr                      # FlexiPrimManager (C# — no static type)


## Erase all animesh-related dictionary entries for a given root uuid.
## Call after queue_free()ing the root node.
func erase_animesh_state(root_uuid: String) -> void:
	animesh_roots.erase(root_uuid)
	animesh_shared_skeleton.erase(root_uuid)
	animesh_eval.erase(root_uuid)
	animesh_pending_anims.erase(root_uuid)
	animesh_worn_anims.erase(root_uuid)
	bone_global_overrides.erase(root_uuid)
	bone_shape_scales.erase(root_uuid)
	cv_volume_morphs.erase(root_uuid)
	if animesh_eval.is_empty():
		animesh_eval_active = false
	# Notify animation thread to clean up state for this root
	animation_mgr.push_avatar_killed(root_uuid)


func _exit_tree() -> void:
	animation_mgr.shutdown()
	if flexi_mgr: flexi_mgr.Shutdown()
	asset_pipeline.shutdown()
	# Skip all cleanup — process is about to die anyway.
	# RenderingServer RIDs, threads, and memory are freed by the OS on exit.


func _ready() -> void:
	_scenario = get_world_3d().scenario

	# Create shared meshes
	object_mesh = BoxMesh.new()
	object_mesh.size = Vector3(0.5, 0.5, 0.5)

	avatar_mesh = BoxMesh.new()
	avatar_mesh.size = Vector3(0.3, 1.4, 0.3)  # Small placeholder so rigged attachments are visible

	# Gray material for objects
	object_material = StandardMaterial3D.new()
	object_material.albedo_color = Color(0.6, 0.6, 0.6)

	# Blue material for avatars
	avatar_material = StandardMaterial3D.new()
	avatar_material.albedo_color = Color(0.3, 0.5, 0.9)

	# Prim geometry generator
	prim_generator = PrimMeshGeneratorScript.new()

	# Skeleton builder — parse avatar_skeleton.json once
	skeleton_builder = SkeletonBuilderScript.new()
	skeleton_builder.load_from_json("res://data/avatar_skeleton.json")

	# Initialize sub-managers
	object_mgr = ObjectManagerScript.new(self)
	animation_mgr = AnimationManagerScript.new(self)
	avatar_mgr = AvatarManagerScript.new(self)
	interp_mgr = InterpolationManagerScript.new(self)
	light_mgr = LightManagerScript.new(self)
	asset_pipeline = AssetPipelineScript.new(self)
	terrain_env = TerrainEnvironmentScript.new(self)
	object_picker = ObjectPickerScript.new(self)
	touch_mgr = TouchManagerScript.new(func(msg: Dictionary): if send_fn.is_valid(): send_fn.call(msg))
	name_bubble_mgr = NameBubbleManagerScript.new(self)
	name_bubble_3d_mgr = NameBubble3DManagerScript.new(self)
	var _flexi_script: Script = FlexiPrimManagerScript
	if _flexi_script.can_instantiate():
		flexi_mgr = _flexi_script.new()
		flexi_mgr.Init(self)
	else:
		push_warning("FlexiPrimManager C# not compiled — flexi prims disabled")

	asset_pipeline.start_threads()

	# Start occlusion scan coroutine (runs every 1s when enabled)
	_occlusion_scan_loop()

	# Start with opaque black overlay — fade out as assets load
	var fade_layer := CanvasLayer.new()
	fade_layer.layer = 100  # on top of everything
	_fade_overlay = ColorRect.new()
	_fade_overlay.color = Color(0.0, 0.0, 0.0, 1.0)
	_fade_overlay.set_anchors_preset(Control.PRESET_FULL_RECT)
	fade_layer.add_child(_fade_overlay)
	add_child(fade_layer)

## Per-subsystem timing accumulators (milliseconds, averaged over 1s windows).
## Reset each time stats are collected via get_process_timing().
var _timing_samples: int = 0
var _timing_terrain_ms: float = 0.0
var _timing_interp_av_ms: float = 0.0
var _timing_interp_obj_ms: float = 0.0
var _timing_anim_ms: float = 0.0
var _timing_flexi_ms: float = 0.0
var _timing_bubbles_ms: float = 0.0
var _timing_finalize_ms: float = 0.0

func get_process_timing() -> Dictionary:
	var n := maxf(_timing_samples, 1)
	var result := {
		"terrain": _timing_terrain_ms / n,
		"interpAv": _timing_interp_av_ms / n,
		"interpObj": _timing_interp_obj_ms / n,
		"anim": _timing_anim_ms / n,
		"flexi": _timing_flexi_ms / n,
		"bubbles": _timing_bubbles_ms / n,
		"finalize": _timing_finalize_ms / n,
		"animRoots": animation_mgr._slots.size(),
		"interpTargets": object_targets.size(),
	}
	_timing_samples = 0
	_timing_terrain_ms = 0.0
	_timing_interp_av_ms = 0.0
	_timing_interp_obj_ms = 0.0
	_timing_anim_ms = 0.0
	_timing_flexi_ms = 0.0
	_timing_bubbles_ms = 0.0
	_timing_finalize_ms = 0.0
	return result

func _process(delta: float) -> void:
	_timing_samples += 1
	var _t0: float

	# Mirror main camera to pick viewport (renders continuously for ID buffer picking)
	object_picker.update_pick_camera()

	_distance_cull_avatars()
	_occlusion_frustum_check()

	# Terrain/water/sky processing
	_t0 = Time.get_ticks_usec()
	terrain_env.process(delta)
	_timing_terrain_ms += (Time.get_ticks_usec() - _t0) / 1000.0

	# Interpolate avatar positions/rotations toward their targets
	_t0 = Time.get_ticks_usec()
	interp_mgr.interpolate_avatars(delta)
	_timing_interp_av_ms += (Time.get_ticks_usec() - _t0) / 1000.0

	# Interpolate moving objects (physical objects with velocity)
	_t0 = Time.get_ticks_usec()
	interp_mgr.interpolate_objects(delta)
	_timing_interp_obj_ms += (Time.get_ticks_usec() - _t0) / 1000.0

	# Flexi prim Verlet simulation (world-space physics → bone rotations)
	_t0 = Time.get_ticks_usec()
	if flexi_mgr: flexi_mgr.ConsumeSlots()
	_timing_flexi_ms += (Time.get_ticks_usec() - _t0) / 1000.0

	# Consume animation thread output slots and apply to Skeleton3D
	_t0 = Time.get_ticks_usec()
	animation_mgr.consume_anim_slots(delta)
	_timing_anim_ms += (Time.get_ticks_usec() - _t0) / 1000.0

	# Periodic light distance culling sweep
	light_mgr._light_cull_timer += delta
	if light_mgr._light_cull_timer >= light_mgr.LIGHT_CULL_INTERVAL:
		light_mgr._light_cull_timer = 0.0
		light_mgr.sweep_light_culling()

	# Periodic eviction of unreferenced GPU assets
	_evict_timer += delta
	if _evict_timer >= EVICT_INTERVAL:
		_evict_timer = 0.0
		asset_pipeline.evict_unused_assets()

	# Update name bubbles (position at head bone, fade chat)
	_t0 = Time.get_ticks_usec()
	var _bubble_cam := get_viewport().get_camera_3d()
	if _bubble_2d_active:
		name_bubble_mgr.process(delta, _bubble_cam)
	if _bubble_3d_active:
		name_bubble_3d_mgr.process(delta, _bubble_cam)
	_timing_bubbles_ms += (Time.get_ticks_usec() - _t0) / 1000.0

	# Submit queued mesh work to WorkerThreadPool + finalize textures/meshes
	_t0 = Time.get_ticks_usec()
	asset_pipeline.finalize_frame(delta, _vr_mode, _target_frame_ms)
	_timing_finalize_ms += (Time.get_ticks_usec() - _t0) / 1000.0

	# Loading fade-in overlay
	if _fade_overlay != null:
		_update_loading_fade(delta)

func _update_loading_fade(delta: float) -> void:
	# Smooth linear fade from black over the full 30s loading period and beyond.
	# Rate: 1/30 ≈ 0.033 alpha/sec during loading, then same rate after.
	_fade_alpha = maxf(0.0, _fade_alpha - delta / 10.0)
	if _fade_alpha <= 0.0:
		_fade_overlay.get_parent().queue_free()
		_fade_overlay = null
		return
	_fade_overlay.color = Color(0.0, 0.0, 0.0, _fade_alpha)


# ─── Public API (delegates to sub-managers) ──────────

# Region change — clear entire scene for cross-region teleport
func handle_region_change() -> void:
	DebugLog.log("scene", "Region change -- clearing all objects, avatars, and lights")

	# Clear distance + occlusion state before destroying objects
	_dist_hidden_avatars.clear()
	_occ_hidden_uuids.clear()
	_occ_missing_scans.clear()
	_occ_visible_ids.clear()
	for root_uuid: String in _occ_hidden_avatars.keys():
		animation_mgr.set_avatar_paused(root_uuid, false)
	_occ_hidden_avatars.clear()
	_occ_av_missing_scans.clear()
	_occ_avatar_hidden_objs.clear()

	# Destroy all pick resources (physics bodies + ID buffer instances) before clearing objects
	object_picker.destroy_all_pick_resources()

	# Destroy all object RSInstances
	for uuid: String in objects:
		objects[uuid].destroy()
	objects.clear()

	# Destroy all avatar RSInstances
	for avatar_id: String in avatars:
		avatars[avatar_id].destroy()
	avatars.clear()

	# Destroy all lights
	for uuid: String in light_mgr.object_lights:
		light_mgr.object_lights[uuid].destroy()
	light_mgr.object_lights.clear()
	light_mgr._object_light_data.clear()
	light_mgr._pending_proj_textures.clear()
	light_mgr._light_count = 0

	# Destroy all animesh scene tree nodes (skeletons + mesh instances)
	for uuid: String in animesh_roots:
		var node: Node3D = animesh_roots[uuid]
		if node and is_instance_valid(node):
			node.queue_free()
	animesh_roots.clear()
	animesh_shared_skeleton.clear()
	animesh_mesh_instances.clear()
	animesh_root_for.clear()
	animesh_eval.clear()
	animesh_eval_active = false
	animesh_pending_anims.clear()
	animesh_worn_anims.clear()
	bone_global_overrides.clear()
	bone_shape_scales.clear()
	cv_volume_morphs.clear()

	# Clear all tracking dictionaries
	avatar_targets.clear()
	object_targets.clear()
	pending_children.clear()
	object_parent.clear()
	object_children.clear()
	child_offset_pos.clear()
	child_offset_rot.clear()
	pending_seated_avatars.clear()
	object_faces.clear()
	object_meta.clear()
	object_mesh_id.clear()
	object_region_offset.clear()
	region_offsets.clear()
	attach_bone.clear()
	attach_point_id.clear()


	# Notify animation thread to clear all state
	animation_mgr.push_region_change()

	# Clear asset pipeline waiter queues
	asset_pipeline._waiting_for_mesh.clear()
	asset_pipeline._tex_waiting.clear()

	# Evict unreferenced assets now that all objects are cleared
	asset_pipeline.evict_unused_assets()
	_evict_timer = 0.0

	# Clear terrain (new region will send new heightmap + environment)
	terrain_env.clear()

	DebugLog.log("scene", "Scene cleared, ready for new region data")


# Objects
func handle_object_render(msg: Dictionary) -> void:
	object_mgr.handle_object_render(msg)

func handle_object_update_batch(msg: Dictionary) -> void:
	object_mgr.handle_object_update_batch(msg)

func handle_update_faces(msg: Dictionary) -> void:
	object_mgr.handle_update_faces(msg)

func handle_update_faces_batch(msg: Dictionary) -> void:
	object_mgr.handle_update_faces_batch(msg)

func handle_object_kill(msg: Dictionary) -> void:
	object_mgr.handle_object_kill(msg)
	var uuid: String = msg.get("uuid", "")
	if not uuid.is_empty():
		name_bubble_mgr.on_object_killed(uuid)

func handle_object_properties(msg: Dictionary) -> void:
	object_picker.handle_object_properties(msg)

# Avatars
func handle_avatar_create(msg: Dictionary) -> void:
	avatar_mgr.handle_avatar_create(msg)

func handle_avatar_update(msg: Dictionary) -> void:
	avatar_mgr.handle_avatar_update(msg)

func handle_avatar_update_batch(msg: Dictionary) -> void:
	avatar_mgr.handle_avatar_update_batch(msg)

func handle_avatar_kill(msg: Dictionary) -> void:
	avatar_mgr.handle_avatar_kill(msg)

func handle_avatar_chat(msg: Dictionary) -> void:
	var avatar_id: String = msg.get("avatarId", "")
	var message: String = msg.get("message", "")
	if not avatar_id.is_empty() and not message.is_empty():
		name_bubble_mgr.on_avatar_chat(avatar_id, message)
		name_bubble_3d_mgr.on_avatar_chat(avatar_id, message)

func handle_avatar_typing(msg: Dictionary) -> void:
	var avatar_id: String = msg.get("avatarId", "")
	name_bubble_mgr.on_avatar_typing(avatar_id, msg.get("typing", false))
	name_bubble_3d_mgr.on_avatar_typing(avatar_id, msg.get("typing", false))

func handle_object_chat(msg: Dictionary) -> void:
	var object_id: String = msg.get("objectId", "")
	var message: String = msg.get("message", "")
	var object_name: String = msg.get("objectName", "")
	if not object_id.is_empty() and not message.is_empty():
		name_bubble_mgr.on_object_chat(object_id, message, object_name)

# Self avatar
func set_world_origin(origin_x: float, origin_y: float) -> void:
	world_origin_x = origin_x
	world_origin_y = origin_y
	region_offsets.clear()
	DebugLog.log("scene", "World origin set to (%.0f, %.0f)" % [origin_x, origin_y])

## Store region offset from a terrain_ready or region_info message.
func register_region_offset(cache_id: String, offset_x: float, offset_y: float) -> void:
	region_offsets[cache_id] = Vector2(offset_x, offset_y)

## Get the scene-space offset for a region. Returns Vector2.ZERO for the main region.
func get_region_offset(cache_id: String) -> Vector2:
	return region_offsets.get(cache_id, Vector2.ZERO)

func set_self_avatar_id(id: String) -> void:
	avatar_mgr.set_self_avatar_id(id)

func set_self_avatar_yaw(godot_yaw: float) -> void:
	avatar_mgr.set_self_avatar_yaw(godot_yaw)

func get_self_avatar_click_data() -> Dictionary:
	return avatar_mgr.get_self_avatar_click_data()

func handle_settings(msg: Dictionary) -> void:
	var draw_dist: float = msg.get("draw_distance", 128.0)
	if draw_dist > 0.0:
		_vis_far = draw_dist
		_vis_fade = draw_dist * 0.25
		for rsi in objects.values():
			rsi.set_vis_range(_vis_far, _vis_fade)
		for rsi in avatars.values():
			rsi.set_vis_range(_vis_far, _vis_fade)
		DebugLog.log("scene", "Draw distance set to %.0f m (fade %.0f m)" % [_vis_far, _vis_fade])

func set_vr_mode(enabled: bool) -> void:
	avatar_mgr.set_vr_mode(enabled)
	set_bubble_vr_mode(enabled)

func set_first_person_mode(enabled: bool) -> void:
	avatar_mgr.set_first_person_mode(enabled)

# Animesh
func handle_animations_batch(msg: Dictionary) -> void:
	animation_mgr.handle_animations_batch(msg)

func handle_avatar_shape(msg: Dictionary) -> void:
	avatar_mgr.handle_avatar_shape(msg)

# Terrain / Environment
func handle_terrain_ready(msg: Dictionary) -> void:
	# Register region offset from the terrain message
	var cache_id: String = str(msg.get("cacheID", ""))
	var offset_x: float = float(msg.get("offsetX", 0.0))
	var offset_y: float = float(msg.get("offsetY", 0.0))
	if not cache_id.is_empty():
		register_region_offset(cache_id, offset_x, offset_y)
	terrain_env.handle_terrain_ready(msg)

func handle_environment_data(msg: Dictionary) -> void:
	terrain_env.handle_environment_data(msg)

# Picking / Debug
func pick_object(ray_origin: Vector3, ray_dir: Vector3) -> Dictionary:
	return object_picker.pick_object(ray_origin, ray_dir)

func pick_object_detailed(ray_origin: Vector3, ray_dir: Vector3) -> Dictionary:
	return object_picker.pick_object_detailed(ray_origin, ray_dir)

func get_object_rid(uuid: String) -> RID:
	return object_picker.get_object_rid(uuid)

func get_object_face_info(uuid: String) -> Array:
	return object_picker.get_object_face_info(uuid)

func get_object_debug_info(uuid: String) -> Dictionary:
	return object_picker.get_object_debug_info(uuid)

func set_planar_debug_mode(mode: int) -> void:
	object_picker.set_planar_debug_mode(mode)

func toggle_debug_skeleton() -> void:
	debug_mode = not debug_mode
	animation_mgr.toggle_debug_skeleton()
	_toggle_debug_invisible()

func _toggle_debug_invisible() -> void:
	if debug_mode:
		if _debug_invisible_mat == null:
			_debug_invisible_mat = ShaderMaterial.new()
			_debug_invisible_mat.shader = DebugInvisibleShader
		for key: String in material_cache:
			var mat: Material = material_cache[key]
			if _is_invisible_material(mat):
				mat.next_pass = _debug_invisible_mat
	else:
		for key: String in material_cache:
			var mat: Material = material_cache[key]
			if mat.next_pass == _debug_invisible_mat:
				mat.next_pass = null

func _is_invisible_material(mat: Material) -> bool:
	if mat is StandardMaterial3D:
		var smat := mat as StandardMaterial3D
		if smat.transparency == BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR and smat.alpha_scissor_threshold >= 0.99:
			return true
		if smat.albedo_color.a < 0.1:
			return true
	elif mat is ShaderMaterial:
		var smat := mat as ShaderMaterial
		var color = smat.get_shader_parameter("albedo_color")
		if color is Color and color.a < 0.1:
			return true
		var threshold = smat.get_shader_parameter("alpha_scissor_threshold")
		if threshold is float and threshold >= 0.99:
			return true
	return false

## Called by asset_pipeline when a new material is created while debug mode is on.
func apply_debug_highlight_if_needed(mat: Material) -> void:
	if debug_mode and _is_invisible_material(mat):
		if _debug_invisible_mat == null:
			_debug_invisible_mat = ShaderMaterial.new()
			_debug_invisible_mat.shader = DebugInvisibleShader
		mat.next_pass = _debug_invisible_mat

func toggle_pick_debug() -> void:
	object_picker.toggle_pick_debug()
	
## Switch name bubbles to VR mode (3D world-space) or desktop mode (2D overlay).
## Called by set_vr_mode() during init.
func set_bubble_vr_mode(vr: bool) -> void:
	_bubble_2d_active = not vr
	_bubble_3d_active = vr
	if name_bubble_mgr and name_bubble_mgr._canvas_layer:
		name_bubble_mgr._canvas_layer.visible = _bubble_2d_active
	if name_bubble_3d_mgr:
		name_bubble_3d_mgr.set_all_visible(_bubble_3d_active)
	DebugLog.log("scene", "Name bubbles: %s" % ("3D world-space" if vr else "2D screen-space"))

# Stats
func get_pipeline_stats() -> Dictionary:
	return asset_pipeline.get_pipeline_stats()


# ─── Occlusion Culling ─────────────────────────────────

func toggle_occlusion_culling() -> void:
	_occ_enabled = not _occ_enabled
	if not _occ_enabled:
		for uuid: String in _occ_hidden_uuids:
			var rsi = objects.get(uuid)
			if rsi != null:
				RenderingServer.instance_set_visible(rsi.rid, true)
		_occ_hidden_uuids.clear()
		_occ_missing_scans.clear()
		_occ_visible_ids.clear()
		for root_uuid: String in _occ_hidden_avatars.keys():
			_unhide_avatar(root_uuid)
		_occ_av_missing_scans.clear()
	DebugLog.log("scene", "Occlusion culling %s" % ("ON" if _occ_enabled else "OFF"))


func _occlusion_scan_loop() -> void:
	while true:
		await get_tree().create_timer(1.0).timeout
		if not _occ_enabled:
			continue
		_occ_visible_ids = await object_picker.scan_visible_ids()
		_apply_occlusion_culling()


## Hide animesh roots beyond draw distance. Skeleton + MeshInstance3D children have no
## visibility_range (only the RSInstance placeholder does). Always active, every frame.
func _distance_cull_avatars() -> void:
	var cam: Camera3D = get_viewport().get_camera_3d()
	if cam == null:
		return
	var cam_pos: Vector3 = cam.global_position
	var far_sq: float = _vis_far * _vis_far
	for root: String in animesh_roots:
		if root == self_avatar_id:
			continue
		var rn = animesh_roots[root]
		if not is_instance_valid(rn):
			continue
		if cam_pos.distance_squared_to(rn.global_position) > far_sq:
			if not _dist_hidden_avatars.has(root):
				rn.visible = false
				animation_mgr.set_avatar_paused(root, true)
				_dist_hidden_avatars[root] = true
		else:
			if _dist_hidden_avatars.has(root):
				_dist_hidden_avatars.erase(root)
				if not _occ_hidden_avatars.has(root):
					rn.visible = true
					animation_mgr.set_avatar_paused(root, false)


## Un-hide occluded objects/avatars that left the frustum (camera turned).
## Prevents pop-in when looking back — Godot frustum-culls them natively anyway.
func _occlusion_frustum_check() -> void:
	if not _occ_enabled:
		return
	if _occ_hidden_uuids.is_empty() and _occ_hidden_avatars.is_empty():
		return
	var cam: Camera3D = object_picker._pick_camera
	if cam == null:
		return
	# Objects
	var to_unhide: Array = []
	for uuid: String in _occ_hidden_uuids:
		var rsi = objects.get(uuid)
		if rsi == null:
			to_unhide.append(uuid)
		elif not cam.is_position_in_frustum(rsi.pos):
			to_unhide.append(uuid)
	for uuid: String in to_unhide:
		var rsi = objects.get(uuid)
		if rsi != null:
			RenderingServer.instance_set_visible(rsi.rid, true)
		_occ_hidden_uuids.erase(uuid)
		_occ_missing_scans.erase(uuid)
	# Avatars
	var to_unhide_av: Array = []
	for root_uuid: String in _occ_hidden_avatars:
		var av_rsi = avatars.get(root_uuid)
		if av_rsi != null:
			if not cam.is_position_in_frustum(av_rsi.pos):
				to_unhide_av.append(root_uuid)
		else:
			var rn: Node3D = animesh_roots.get(root_uuid)
			if rn != null and is_instance_valid(rn):
				if not cam.is_position_in_frustum(rn.global_position):
					to_unhide_av.append(root_uuid)
			else:
				to_unhide_av.append(root_uuid)
	for root_uuid: String in to_unhide_av:
		_unhide_avatar(root_uuid)
		_occ_av_missing_scans.erase(root_uuid)


func _apply_occlusion_culling() -> void:
	var pick_cam: Camera3D = object_picker._pick_camera
	if pick_cam == null:
		return

	# ── Objects ──
	for uuid: String in objects:
		var numeric_id: int = object_picker._uuid_to_id.get(uuid, 0)
		if numeric_id == 0:
			continue  # no pick instance allocated
		var rsi = objects[uuid]
		# Objects outside the frustum — leave visible (Godot culls them natively)
		if not pick_cam.is_position_in_frustum(rsi.pos):
			if _occ_hidden_uuids.has(uuid):
				RenderingServer.instance_set_visible(rsi.rid, true)
				_occ_hidden_uuids.erase(uuid)
			_occ_missing_scans.erase(uuid)
			continue
		if _occ_visible_ids.has(numeric_id):
			# Visible in scan — reset miss count, un-hide if needed
			_occ_missing_scans.erase(uuid)
			if _occ_hidden_uuids.has(uuid):
				RenderingServer.instance_set_visible(rsi.rid, true)
				_occ_hidden_uuids.erase(uuid)
		else:
			# Not visible — count consecutive misses
			var misses: int = _occ_missing_scans.get(uuid, 0) + 1
			_occ_missing_scans[uuid] = misses
			if misses >= OCC_HIDE_AFTER_SCANS and not _occ_hidden_uuids.has(uuid):
				RenderingServer.instance_set_visible(rsi.rid, false)
				_occ_hidden_uuids[uuid] = true

	# ── Avatars ── aggregate visibility: if ANY mesh part is visible, avatar is visible
	var av_visible: Dictionary = {}
	for uuid: String in animesh_root_for:
		var root: String = animesh_root_for[uuid]
		if av_visible.has(root):
			continue  # already known visible
		var nid: int = object_picker._uuid_to_id.get(uuid, 0)
		if nid != 0 and _occ_visible_ids.has(nid):
			av_visible[root] = true

	for root: String in animesh_roots:
		if root == self_avatar_id:
			continue  # never hide self
		if _dist_hidden_avatars.has(root):
			continue  # already distance-culled
		# Frustum check — use avatar RSInstance position, or animesh root node for non-player animesh
		var av_pos: Vector3
		var av_rsi = avatars.get(root)
		if av_rsi != null:
			av_pos = av_rsi.pos
		else:
			var rn: Node3D = animesh_roots[root]
			if rn != null and is_instance_valid(rn):
				av_pos = rn.global_position
			else:
				continue
		if not pick_cam.is_position_in_frustum(av_pos):
			if _occ_hidden_avatars.has(root):
				_unhide_avatar(root)
			_occ_av_missing_scans.erase(root)
			continue
		if av_visible.has(root):
			_occ_av_missing_scans.erase(root)
			if _occ_hidden_avatars.has(root):
				_unhide_avatar(root)
		else:
			var misses: int = _occ_av_missing_scans.get(root, 0) + 1
			_occ_av_missing_scans[root] = misses
			if misses >= OCC_HIDE_AFTER_SCANS and not _occ_hidden_avatars.has(root):
				_hide_avatar(root)


func _hide_avatar(root_uuid: String) -> void:
	# Hide the animesh root Node3D (skeleton + all MeshInstance3D children + worn animesh subnodes)
	var root_node: Node3D = animesh_roots.get(root_uuid)
	if root_node != null and is_instance_valid(root_node):
		root_node.visible = false
	# Hide non-rigged attachment RSInstances belonging to this avatar.
	# Skip objects whose RSInstance was already hidden by the mesh pipeline (rigged meshes
	# have a MeshInstance3D in animesh_mesh_instances — their RSI is already invisible).
	var hidden_objs: Array = []
	for uuid: String in animesh_root_for:
		if animesh_root_for[uuid] == root_uuid:
			if animesh_mesh_instances.has(uuid):
				continue  # rigged mesh — RSI already hidden by mesh pipeline
			var rsi = objects.get(uuid)
			if rsi != null:
				RenderingServer.instance_set_visible(rsi.rid, false)
				hidden_objs.append(uuid)
	_occ_avatar_hidden_objs[root_uuid] = hidden_objs
	animation_mgr.set_avatar_paused(root_uuid, true)
	_occ_hidden_avatars[root_uuid] = true
	DebugLog.log("occ", "Hide avatar %s (%d attachment RSIs)" % [root_uuid.substr(0, 8), hidden_objs.size()])


func _unhide_avatar(root_uuid: String) -> void:
	# Only actually show if not also distance-culled
	if not _dist_hidden_avatars.has(root_uuid):
		var root_node: Node3D = animesh_roots.get(root_uuid)
		if root_node != null and is_instance_valid(root_node):
			root_node.visible = true
		animation_mgr.set_avatar_paused(root_uuid, false)
	# Re-show the attachment RSInstances we hid (not ones hidden by object-level occlusion)
	var hidden_objs: Array = _occ_avatar_hidden_objs.get(root_uuid, [])
	for uuid: String in hidden_objs:
		if not _occ_hidden_uuids.has(uuid):
			var rsi = objects.get(uuid)
			if rsi != null:
				RenderingServer.instance_set_visible(rsi.rid, true)
	_occ_avatar_hidden_objs.erase(root_uuid)
	_occ_hidden_avatars.erase(root_uuid)
	DebugLog.log("occ", "Unhide avatar %s (%d attachments restored)" % [root_uuid.substr(0, 8), hidden_objs.size()])
