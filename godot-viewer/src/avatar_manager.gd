extends RefCounted

## Avatar CRUD, shape deformation, and self-avatar management.

var sm  # scene_manager reference

# Self avatar state
var _first_person_mode: bool = false

# Avatar shape deformation — per-avatar bone scale/offset from VisualParam
var _avatar_shapes: Dictionary = {}  # avatarId (String) -> bones Dictionary
var _avatar_volume_morphs: Dictionary = {}  # avatarId (String) -> volumeMorphs Dictionary
var _avatar_hover_heights: Dictionary = {}  # avatarId (String) -> float

func _init(scene_manager) -> void:
	sm = scene_manager

# ─── Self Avatar ─────────────────────────────────────

func set_vr_mode(enabled: bool) -> void:
	sm._vr_mode = enabled
	var FrameBudget = sm.FrameBudget
	sm._target_frame_ms = FrameBudget.DESKTOP_FRAME_MS
	var vfar: float = FrameBudget.VR_CAMERA_FAR if enabled else sm._vis_far
	var vfade: float = FrameBudget.VR_VISIBILITY_FADE_MARGIN if enabled else sm._vis_fade
	for rsi in sm.objects.values():
		rsi.set_vis_range(vfar, vfade)
	for rsi in sm.avatars.values():
		rsi.set_vis_range(vfar, vfade)


func set_first_person_mode(enabled: bool) -> void:
	_first_person_mode = enabled
	_apply_self_avatar_visibility()


func _apply_self_avatar_visibility() -> void:
	if sm.self_avatar_id.is_empty():
		return
	var rsi = sm.avatars.get(sm.self_avatar_id)
	if rsi != null:
		RenderingServer.instance_set_visible(rsi.rid, not _first_person_mode)


func set_self_avatar_id(id: String) -> void:
	sm.self_avatar_id = id
	# If we already have this avatar, emit its position and apply visibility
	if sm.avatars.has(id):
		sm.self_avatar_moved.emit(sm.avatars[id].pos)
	_apply_self_avatar_visibility()


## Set the self avatar's target yaw. The visual rotation damps toward this
## each frame in interpolate_avatars (matching Firestorm's smoothed body rotation).
func set_self_avatar_yaw(godot_yaw: float) -> void:
	if sm.self_avatar_id.is_empty():
		return
	# Store target rotation — interpolation_manager will slerp toward it.
	# PI/2 offset matches the SL heading conversion in godot-input-handler.ts.
	sm.self_avatar_target_rot = Quaternion(Vector3.UP, godot_yaw + PI / 2.0)


## Return click-detection data for the self avatar, or empty dict if unavailable
func get_self_avatar_click_data() -> Dictionary:
	if sm.self_avatar_id.is_empty():
		return {}
	var rsi = sm.avatars.get(sm.self_avatar_id)
	if rsi == null or rsi.mesh == null:
		return {}
	var xform := Transform3D(Basis(rsi.rot) * Basis.from_scale(rsi.scl), rsi.pos)
	return { "position": rsi.pos, "transform": xform, "aabb": rsi.mesh.get_aabb() }


# ─── Avatar Handlers ──────────────────────────────────

func _crumb(text: String) -> void:
	var main = sm.get_parent()
	if main and main.has_method("write_breadcrumb"):
		main.write_breadcrumb(text)

func handle_avatar_create(msg: Dictionary) -> void:
	var avatar_id: String = msg.get("id", "")
	if avatar_id.is_empty():
		return
	_crumb("avatar_create id=%s step=start" % avatar_id.substr(0, 8))

	# Remove existing if duplicate
	if sm.avatars.has(avatar_id):
		sm.avatars[avatar_id].destroy()
		sm.avatar_targets.erase(avatar_id)
		# Clean up old skeleton root if present
		if sm.animesh_roots.has(avatar_id):
			var old_node: Node3D = sm.animesh_roots[avatar_id]
			if old_node and is_instance_valid(old_node):
				old_node.queue_free()
			sm.erase_animesh_state(avatar_id)

	_crumb("avatar_create id=%s step=RSInstance" % avatar_id.substr(0, 8))
	var _vfar: float = sm.FrameBudget.VR_CAMERA_FAR if sm._vr_mode else sm._vis_far
	var _vfade: float = sm.FrameBudget.VR_VISIBILITY_FADE_MARGIN if sm._vr_mode else sm._vis_fade
	var rsi = sm.RSInstance.new(sm._scenario, _vfar, _vfade)
	# Small blue placeholder so we can see avatar position while attachments load
	rsi.set_mesh(sm.avatar_mesh)
	rsi.set_material_override(sm.avatar_material)

	var pos: Array = msg.get("position", [128, 25, -128])
	var godot_pos := Vector3(pos[0], pos[1], pos[2])
	var godot_rot := Quaternion.IDENTITY
	if msg.has("rotation"):
		var r: Array = msg["rotation"]
		godot_rot = Quaternion(r[0], r[1], r[2], r[3])

	# If avatar is sitting, transform local offset into world space
	var seat_uuid: String = str(msg.get("parentUuid", ""))
	var seat_rsi = sm.objects.get(seat_uuid) if not seat_uuid.is_empty() else null
	if not seat_uuid.is_empty():
		if seat_rsi != null:
			godot_pos = seat_rsi.pos + seat_rsi.rot * godot_pos
			godot_rot = seat_rsi.rot * godot_rot
		else:
			# Seat object hasn't arrived yet — queue for deferred resolution
			if not sm.pending_seated_avatars.has(seat_uuid):
				sm.pending_seated_avatars[seat_uuid] = []
			sm.pending_seated_avatars[seat_uuid].append({
				"id": avatar_id, "pos": godot_pos, "rot": godot_rot
			})
			DebugLog.debug("avatarsit", "Deferred: avatar=%s waiting for seat uuid=%s" % [avatar_id.substr(0, 8), seat_uuid.substr(0, 8)])

	rsi.pos = godot_pos
	rsi.rot = godot_rot

	rsi.push_transform()
	sm.avatars[avatar_id] = rsi

	# Initialize interpolation target at current position (no lerp on first frame)
	sm.avatar_targets[avatar_id] = { "pos": godot_pos, "rot": godot_rot, "vel": Vector3.ZERO }

	# Create skeleton root for this avatar (same as animesh root).
	# Avatar attachments arrive as objects with parentUuid = this avatar's UUID.
	var avatar_node := Node3D.new()
	avatar_node.name = "avatar_%s" % avatar_id.substr(0, 8)
	sm.add_child(avatar_node)
	avatar_node.position = godot_pos
	avatar_node.quaternion = godot_rot
	avatar_node.scale = Vector3.ONE
	sm.animesh_roots[avatar_id] = avatar_node
	_crumb("avatar_create id=%s step=create_skeleton" % avatar_id.substr(0, 8))
	# Create shared skeleton from avatar_skeleton.xml (ONE per avatar)
	var shared_skel: Skeleton3D = sm.skeleton_builder.create_shared_skeleton()
	avatar_node.add_child(shared_skel)
	sm.animesh_shared_skeleton[avatar_id] = shared_skel
	# Notify animation thread about new skeleton
	sm.animation_mgr.push_avatar_created(avatar_id, shared_skel)
	_crumb("avatar_create id=%s step=apply_shape" % avatar_id.substr(0, 8))
	# Apply pending shape if AvatarAppearance arrived before avatar_create
	if _avatar_shapes.has(avatar_id):
		_apply_shape_to_skeleton(shared_skel, _avatar_shapes[avatar_id], avatar_id)
		# Body size offset + hover (hover from VisualParam 11001, byte 252)
		# TODO: Firestorm skips hover when sitting (isSitting || sit_ground_constrained).
		# We need proper sit state tracking before gating this.
		var body_offset: float = _compute_body_z_offset(shared_skel, _avatar_shapes[avatar_id])
		var hover: float = _avatar_hover_heights.get(avatar_id, 0.0)
		shared_skel.position.y = -body_offset + hover
		DebugLog.debug("avatarshape", "Pending body_offset=%.4f hover=%.4f for %s" % [body_offset, hover, avatar_id.substr(0, 8)])
	# Apply pending volume morphs
	if _avatar_volume_morphs.has(avatar_id):
		sm.cv_volume_morphs[avatar_id] = _avatar_volume_morphs[avatar_id]
	# Notify animation thread about pending shape (rests + scales changed)
	if _avatar_shapes.has(avatar_id):
		sm.animation_mgr.push_shape_changed(avatar_id, shared_skel, sm.bone_shape_scales.get(avatar_id, {}), sm.cv_volume_morphs.get(avatar_id, {}))
	if avatar_id == sm.self_avatar_id:
		DebugLog.log("selfavatar", "=== Skeleton root created: uuid=%s bones=%d ===" % [avatar_id.substr(0, 8), shared_skel.get_bone_count()])

	_crumb("avatar_create id=%s step=pending_children" % avatar_id.substr(0, 8))
	# Resolve pending children that arrived before this avatar —
	# fix their world positions
	if sm.pending_children.has(avatar_id):
		for child_uuid: String in sm.pending_children[avatar_id]:
			if sm.objects.has(child_uuid) and sm.child_offset_pos.has(child_uuid):
				var child_rsi = sm.objects[child_uuid]
				child_rsi.pos = avatar_node.position + avatar_node.quaternion * sm.child_offset_pos[child_uuid]
				child_rsi.rot = avatar_node.quaternion * sm.child_offset_rot[child_uuid]
				child_rsi.push_transform()
		sm.pending_children.erase(avatar_id)

	_crumb("avatar_create id=%s step=register_descendants" % avatar_id.substr(0, 8))
	# Register ALL descendants (children, grandchildren, etc.) as animesh children.
	# Handles attachment linksets where child prims also need skeleton rigging.
	sm.object_mgr._register_animesh_descendants(avatar_id, avatar_id)

	# Create name bubble above head
	var display_name: String = msg.get("name", "")
	sm.name_bubble_mgr.on_avatar_created(avatar_id, display_name)
	sm.name_bubble_3d_mgr.on_avatar_created(avatar_id, display_name)

	_crumb("avatar_create id=%s step=DONE" % avatar_id.substr(0, 8))
	if avatar_id == sm.self_avatar_id:
		sm.self_avatar_moved.emit(rsi.pos)
		_apply_self_avatar_visibility()


func handle_avatar_update(msg: Dictionary) -> void:
	var avatar_id: String = msg.get("id", "")
	if not sm.avatars.has(avatar_id):
		return
	_apply_avatar_target(avatar_id, msg)


func handle_avatar_update_batch(msg: Dictionary) -> void:
	var avatar_list: Array = msg.get("avatars", [])
	for entry: Dictionary in avatar_list:
		var avatar_id: String = entry.get("id", "")
		if avatar_id.is_empty() or not sm.avatars.has(avatar_id):
			continue
		_apply_avatar_target(avatar_id, entry)


## Set interpolation target for an avatar from an update message
func _apply_avatar_target(avatar_id: String, data: Dictionary) -> void:
	var rsi = sm.avatars.get(avatar_id)

	if data.has("position"):
		var rp: Array = data["position"]
		var raw_pos := Vector3(rp[0], rp[1], rp[2])
		var seat_uuid: String = str(data.get("parentUuid", ""))
		var seat_rsi = sm.objects.get(seat_uuid) if not seat_uuid.is_empty() else null

		var godot_pos: Vector3
		var godot_rot: Quaternion
		if seat_rsi != null:
			godot_pos = seat_rsi.pos + seat_rsi.rot * raw_pos
			if data.has("rotation"):
				var sr: Array = data["rotation"]
				godot_rot = seat_rsi.rot * Quaternion(sr[0], sr[1], sr[2], sr[3])
			else:
				godot_rot = rsi.rot if rsi else Quaternion.IDENTITY
		else:
			godot_pos = raw_pos
			if data.has("rotation"):
				var sr: Array = data["rotation"]
				godot_rot = Quaternion(sr[0], sr[1], sr[2], sr[3])
			else:
				godot_rot = rsi.rot if rsi else Quaternion.IDENTITY

		# Snap position when sitting — the seat offset is server-authoritative
		# and damping would cause the avatar to slowly crawl to the seat.
		# Also snap rotation when seated or for non-self avatars.
		if rsi:
			if seat_rsi != null:
				rsi.pos = godot_pos
			if avatar_id != sm.self_avatar_id or seat_rsi != null:
				rsi.rot = godot_rot

		# Preserve old velocity when update doesn't include one (matching Firestorm —
		# the object's velocity persists until explicitly changed by a new update).
		# Exception: when seated, velocity is always zero (no extrapolation).
		var old_target: Dictionary = sm.avatar_targets.get(avatar_id, {})
		var target: Dictionary = {}
		target["pos"] = godot_pos
		target["rot"] = godot_rot
		if seat_rsi != null:
			target["vel"] = Vector3.ZERO
		elif data.has("velocity"):
			var sv: Array = data["velocity"]
			target["vel"] = Vector3(sv[0], sv[1], sv[2])
		else:
			target["vel"] = old_target.get("vel", Vector3.ZERO)
		target["age"] = 0.0
		target["seated"] = seat_rsi != null
		sm.avatar_targets[avatar_id] = target
	else:
		# Rotation-only update
		if data.has("rotation"):
			var target: Dictionary = sm.avatar_targets.get(avatar_id, {})
			var rr: Array = data["rotation"]
			target["rot"] = Quaternion(rr[0], rr[1], rr[2], rr[3])
			sm.avatar_targets[avatar_id] = target


func handle_avatar_kill(msg: Dictionary) -> void:
	var avatar_id: String = msg.get("id", "")
	if sm.avatars.has(avatar_id):
		sm.avatars[avatar_id].destroy()
		sm.avatars.erase(avatar_id)
		sm.avatar_targets.erase(avatar_id)
		# Clean up skeleton root
		if sm.animesh_roots.has(avatar_id):
			# Clean up mesh instance references (nodes freed when avatar_node is queue_freed)
			var to_erase: Array = []
			for mesh_uuid: String in sm.animesh_mesh_instances:
				if sm.animesh_root_for.get(mesh_uuid, "") == avatar_id:
					to_erase.append(mesh_uuid)
			for mesh_uuid: String in to_erase:
				sm.animesh_mesh_instances.erase(mesh_uuid)
			var node_ref = sm.animesh_roots[avatar_id]
			if node_ref is Node3D and is_instance_valid(node_ref):
				node_ref.queue_free()  # Also frees shared skeleton + per-mesh skeletons + meshes
			sm.erase_animesh_state(avatar_id)
		sm.bone_shape_scales.erase(avatar_id)
		sm.cv_volume_morphs.erase(avatar_id)
		_avatar_shapes.erase(avatar_id)
		_avatar_volume_morphs.erase(avatar_id)
		_avatar_hover_heights.erase(avatar_id)
		sm.name_bubble_mgr.on_avatar_killed(avatar_id)
		sm.name_bubble_3d_mgr.on_avatar_killed(avatar_id)


# ─── Avatar Shape ─────────────────────────────────────

func handle_avatar_shape(msg: Dictionary) -> void:
	var avatar_id: String = msg.get("avatarId", "")
	if avatar_id.is_empty():
		return
	var bones: Dictionary = msg.get("bones", {})
	_avatar_shapes[avatar_id] = bones

	# Buffer volume morph deltas and hover height by UUID (same pattern as _avatar_shapes)
	var volume_morphs: Dictionary = msg.get("volumeMorphs", {})
	if not volume_morphs.is_empty():
		_avatar_volume_morphs[avatar_id] = volume_morphs
	var hover_height: float = float(msg.get("hoverHeight", 0.0))
	_avatar_hover_heights[avatar_id] = hover_height

	# Store volume morphs by avatar_id (for _apply_global_pose_overrides)
	if _avatar_volume_morphs.has(avatar_id):
		sm.cv_volume_morphs[avatar_id] = _avatar_volume_morphs[avatar_id]

	# Only apply shape to real avatars — animesh ControlAvatars don't have shapes;
	# their skeleton is defined by mesh joint overrides only.
	if not sm.avatars.has(avatar_id):
		return

	var shared_skel: Skeleton3D = sm.animesh_shared_skeleton.get(avatar_id)
	if shared_skel == null:
		return

	_apply_shape_to_skeleton(shared_skel, bones, avatar_id)
	_reapply_joint_overrides(avatar_id, shared_skel, avatar_id)

	# Body size offset (Firestorm: root_pos.Z -= 0.5*bodyH - pelvisToFoot) + hover
	# TODO: Firestorm skips hover when sitting (isSitting || sit_ground_constrained).
	var body_offset: float = _compute_body_z_offset(shared_skel, bones)
	shared_skel.position.y = -body_offset + hover_height

	# Notify animation thread about shape change (new rest positions + scales)
	sm.animation_mgr.push_shape_changed(avatar_id, shared_skel, sm.bone_shape_scales.get(avatar_id, {}), sm.cv_volume_morphs.get(avatar_id, {}))

	DebugLog.debug("avatarshape", "Applied shape for avatar %s (%d bones, hover=%.4f, body_offset=%.4f)" % [avatar_id.substr(0, 8), bones.size(), hover_height, body_offset])


## Recompute body size offset after joint overrides change bone rest positions.
## Called from animation_manager._apply_joint_overrides when mesh body/head
## overrides modify hip/knee/ankle/foot positions.
func _recompute_body_offset(root_uuid: String, shared_skel: Skeleton3D) -> void:
	var bones: Dictionary = _avatar_shapes.get(root_uuid, {})
	var body_offset: float = _compute_body_z_offset(shared_skel, bones)
	# Preserve hover height if we have it (from AvatarAppearance message)
	var hover_height: float = _avatar_hover_heights.get(root_uuid, 0.0)
	shared_skel.position.y = -body_offset + hover_height
	DebugLog.debug("avatarshape", "Recomputed body_offset=%.4f (hover=%.4f) for %s after joint overrides" % [body_offset, hover_height, root_uuid.substr(0, 8)])


## Compute the vertical offset from bounding box center to pelvis.
## Matches Firestorm: root_pos.Z -= (0.5 * bodyHeight - pelvisToFoot)
## See llavatarappearance.cpp computeBodySize() for the original formula.
func _compute_body_z_offset(skel: Skeleton3D, bones: Dictionary) -> float:
	# Helper: get bone local Z in SL space from skeleton rest (Godot Y = SL Z)
	var _get_z = func(bname: String) -> float:
		var bi: int = skel.find_bone(bname)
		if bi < 0: return 0.0
		return skel.get_bone_rest(bi).origin.y

	# Helper: get bone shape scale Z
	var _scale_z = func(bname: String) -> float:
		if bones.has(bname):
			return (bones[bname].get("scale", [1, 1, 1]) as Array)[2]
		return 1.0

	var pelvis_to_foot: float = (
		_get_z.call("mHipLeft") * _scale_z.call("mPelvis") -
		_get_z.call("mKneeLeft") * _scale_z.call("mHipLeft") -
		_get_z.call("mAnkleLeft") * _scale_z.call("mKneeLeft") -
		_get_z.call("mFootLeft") * _scale_z.call("mAnkleLeft")
	)

	var body_height: float = pelvis_to_foot + (
		sqrt(2.0) * _get_z.call("mSkull") * _scale_z.call("mHead") +
		_get_z.call("mHead") * _scale_z.call("mNeck") +
		_get_z.call("mNeck") * _scale_z.call("mChest") +
		_get_z.call("mChest") * _scale_z.call("mTorso") +
		_get_z.call("mTorso") * _scale_z.call("mPelvis")
	)

	var offset: float = 0.5 * body_height - pelvis_to_foot
	return offset


## Reset skeleton bone rests to XML baseline + shape offset deltas.
## Parent scale is NOT baked into rest — it is applied dynamically each frame
## in _apply_global_pose_overrides (matching SL's xform.cpp:76 behavior).
## Bone's OWN shape scale is also applied dynamically in the skinning basis
## (matching SL's xform.cpp:93: worldMatrix.initAll(mScale, mWorldRot, mWorldPos)).
func _apply_shape_to_skeleton(skeleton: Skeleton3D, bones: Dictionary, avatar_id: String) -> void:
	var xml_bones: Array = sm.skeleton_builder.get_bone_data()
	var xml_by_name: Dictionary = {}
	for bd: Dictionary in xml_bones:
		xml_by_name[bd["name"]] = bd

	# Build bone_name → shape scale lookup and store for dynamic use
	var shape_scales: Dictionary = {}  # bone_name -> Vector3 (SL space scale)
	for bname: String in bones:
		var shape_data: Dictionary = bones[bname]
		var s: Array = shape_data.get("scale", [1, 1, 1])
		shape_scales[bname] = Vector3(s[0], s[1], s[2])

	# Store shape scales for dynamic parent-scale application in _apply_global_pose_overrides
	sm.bone_shape_scales[avatar_id] = shape_scales

	for bi in range(skeleton.get_bone_count()):
		var bname: String = skeleton.get_bone_name(bi)
		var xml_data: Dictionary = xml_by_name.get(bname, {})
		if xml_data.is_empty():
			continue

		var rest := Transform3D()
		var sp: Vector3 = xml_data["pos"]  # SL space local position

		# Apply shape offset to this bone's position (in SL space)
		if bones.has(bname):
			var shape_data: Dictionary = bones[bname]
			var o: Array = shape_data.get("offset", [0, 0, 0])
			sp += Vector3(o[0], o[1], o[2])

		# Parent scale is NOT baked here — applied dynamically in _apply_global_pose_overrides

		# SL → Godot position conversion
		rest.origin = Vector3(sp.x, sp.z, -sp.y)
		skeleton.set_bone_rest(bi, rest)


## Re-apply joint overrides from all rigged meshes on an avatar after shape change.
## Override priority: lowest mesh UUID wins (matches SL's std::map<LLUUID> ordering).
func _reapply_joint_overrides(root_uuid: String, shared_skel: Skeleton3D, avatar_id: String) -> void:
	# Clear override ownership — shape just reset all bones, start fresh
	sm.bone_override_owner.erase(root_uuid)
	for mesh_uuid: String in sm.animesh_mesh_instances:
		if sm.animesh_root_for.get(mesh_uuid, "") != root_uuid:
			continue
		var mesh_id: String = sm.object_mesh_id.get(mesh_uuid, "")
		if mesh_id.is_empty():
			continue
		var override_joints: Array = sm.mesh_joint_overrides.get(mesh_id, [])
		if override_joints.is_empty():
			continue
		# Need the GLB skeleton to get the override rest transforms.
		# The override rest was already copied to shared_skel during initial setup,
		# and shape just reset all rests to XML baseline. Re-apply from the GLB.
		DebugLog.debug("jointoverride", "reapply avatar=%s mesh_uuid=%s mesh_id=%s overrides=%s" % [avatar_id.substr(0, 8), mesh_uuid.substr(0, 8), mesh_id.substr(0, 16), str(override_joints)])
		var glb_path: String = sm.rigged_mesh_paths.get(mesh_id, "")
		if glb_path.is_empty():
			continue
		var doc := GLTFDocument.new()
		var state := GLTFState.new()
		var err := doc.append_from_file(glb_path, state)
		if err != OK:
			continue
		var scene: Node = doc.generate_scene(state)
		if scene == null:
			continue
		var glb_skel: Skeleton3D = sm.object_mgr._find_node_of_type(scene, "Skeleton3D")
		if glb_skel != null:
			sm.animation_mgr._apply_joint_overrides(glb_skel, shared_skel, override_joints, mesh_id)
		scene.queue_free()

