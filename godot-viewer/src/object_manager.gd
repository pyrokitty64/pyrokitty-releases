extends RefCounted

## Object CRUD, linkset hierarchy, animesh instantiation, and coordinate conversion.

var sm  # scene_manager reference

# Attachment point ID → bone name (from avatar_lad.xml)
# IDs 31-38 are HUDs (filtered out on the bridge side, never sent to Godot)
const ATTACH_POINT_BONES: Dictionary = {
	1: "mChest",          # Chest
	2: "mHead",           # Skull
	3: "mCollarLeft",     # Left Shoulder
	4: "mCollarRight",    # Right Shoulder
	5: "mWristLeft",      # Left Hand
	6: "mWristRight",     # Right Hand
	7: "mFootLeft",       # Left Foot
	8: "mFootRight",      # Right Foot
	9: "mChest",          # Spine (Back)
	10: "mPelvis",        # Pelvis
	11: "mHead",          # Mouth
	12: "mHead",          # Chin
	13: "mHead",          # Left Ear
	14: "mHead",          # Right Ear
	15: "mEyeLeft",       # Left Eyeball
	16: "mEyeRight",      # Right Eyeball
	17: "mHead",          # Nose
	18: "mShoulderRight",  # R Upper Arm
	19: "mElbowRight",    # R Forearm
	20: "mShoulderLeft",  # L Upper Arm
	21: "mElbowLeft",     # L Forearm
	22: "mHipRight",      # Right Hip
	23: "mHipRight",      # R Upper Leg
	24: "mKneeRight",     # R Lower Leg
	25: "mHipLeft",       # Left Hip
	26: "mHipLeft",       # L Upper Leg
	27: "mKneeLeft",      # L Lower Leg
	28: "mPelvis",        # Stomach
	29: "mTorso",         # Left Pec
	30: "mTorso",         # Right Pec
	39: "mNeck",          # Neck
	40: "mRoot",          # Avatar Center
	41: "mHandRing1Left",  # Left Ring Finger
	42: "mHandRing1Right", # Right Ring Finger
	43: "mTail1",         # Tail Base
	44: "mTail6",         # Tail Tip
	45: "mWing4Left",     # Left Wing
	46: "mWing4Right",    # Right Wing
	47: "mFaceJaw",       # Jaw
	48: "mFaceEar1Left",  # Alt Left Ear
	49: "mFaceEar1Right", # Alt Right Ear
	50: "mFaceEyeAltLeft",  # Alt Left Eye
	51: "mFaceEyeAltRight", # Alt Right Eye
	52: "mFaceTongueTip", # Tongue
	53: "mGroin",         # Groin
	54: "mHindLimb4Left", # Left Hind Foot
	55: "mHindLimb4Right", # Right Hind Foot
}

# Attachment point local offsets relative to the bone (from avatar_lad.xml).
# Stored as SL-space position (x=fwd, y=left, z=up) and Euler degrees (roll, pitch, yaw).
# Only entries with non-zero pos or rot are included — all others are identity.
const ATTACH_POINT_OFFSETS: Dictionary = {
	1:  {"pos": Vector3(0.15, 0.0, -0.1),    "rot": Vector3(0, 90, 90)},   # Chest
	2:  {"pos": Vector3(0.0, 0.0, 0.15),     "rot": Vector3(0, 0, 90)},    # Skull
	3:  {"pos": Vector3(0.0, 0.0, 0.08),     "rot": Vector3(0, 0, 0)},     # Left Shoulder
	4:  {"pos": Vector3(0.0, 0.0, 0.08),     "rot": Vector3(0, 0, 0)},     # Right Shoulder
	5:  {"pos": Vector3(0.0, 0.08, -0.02),   "rot": Vector3(0, 0, 0)},     # Left Hand
	6:  {"pos": Vector3(0.0, -0.08, -0.02),  "rot": Vector3(0, 0, 0)},     # Right Hand
	9:  {"pos": Vector3(-0.15, 0.0, -0.1),   "rot": Vector3(0, -90, 90)},  # Spine
	10: {"pos": Vector3(0.0, 0.0, -0.15),    "rot": Vector3(0, 0, 0)},     # Pelvis
	11: {"pos": Vector3(0.12, 0.0, 0.001),   "rot": Vector3(0, 0, 0)},     # Mouth
	12: {"pos": Vector3(0.12, 0.0, -0.04),   "rot": Vector3(0, 0, 0)},     # Chin
	13: {"pos": Vector3(0.015, 0.08, 0.017), "rot": Vector3(0, 0, 0)},     # Left Ear
	14: {"pos": Vector3(0.015, -0.08, 0.017),"rot": Vector3(0, 0, 0)},     # Right Ear
	17: {"pos": Vector3(0.1, 0.0, 0.05),     "rot": Vector3(0, 0, 0)},     # Nose
	18: {"pos": Vector3(0.01, -0.13, 0.01),  "rot": Vector3(0, 0, 0)},     # R Upper Arm
	19: {"pos": Vector3(0.0, -0.12, 0.0),    "rot": Vector3(0, 0, 0)},     # R Forearm
	20: {"pos": Vector3(0.01, 0.15, -0.01),  "rot": Vector3(0, 0, 0)},     # L Upper Arm
	21: {"pos": Vector3(0.0, 0.113, 0.0),    "rot": Vector3(0, 0, 0)},     # L Forearm
	23: {"pos": Vector3(-0.017, 0.041, -0.310),  "rot": Vector3(0, 0, 0)}, # R Upper Leg
	24: {"pos": Vector3(-0.044, -0.007, -0.262), "rot": Vector3(0, 0, 0)}, # R Lower Leg
	26: {"pos": Vector3(-0.019, -0.034, -0.310), "rot": Vector3(0, 0, 0)}, # L Upper Leg
	27: {"pos": Vector3(-0.044, -0.007, -0.261), "rot": Vector3(0, 0, 0)}, # L Lower Leg
	28: {"pos": Vector3(0.092, 0.0, 0.088),  "rot": Vector3(0, 0, 0)},     # Stomach
	29: {"pos": Vector3(0.104, 0.082, 0.247),"rot": Vector3(0, 0, 0)},     # Left Pec
	30: {"pos": Vector3(0.104, -0.082, 0.247),"rot": Vector3(0, 0, 0)},    # Right Pec
	41: {"pos": Vector3(-0.006, 0.019, -0.002),"rot": Vector3(0, 0, 0)},   # Left Ring Finger
	42: {"pos": Vector3(-0.006, -0.019, -0.002),"rot": Vector3(0, 0, 0)},  # Right Ring Finger
	44: {"pos": Vector3(-0.025, 0.0, 0.0),   "rot": Vector3(0, 0, 0)},     # Tail Tip
}


func _init(scene_manager) -> void:
	sm = scene_manager


## Short UUID for log messages (first 8 chars, or "?" if empty)
func _uuid_short(obj_uuid: String) -> String:
	if obj_uuid.is_empty():
		return "?"
	return obj_uuid.substr(0, 8)


## Check if an object uuid belongs to the self avatar (is the avatar root or an attachment of it)
func _is_self_avatar(obj_uuid: String) -> bool:
	if sm.self_avatar_id.is_empty() or obj_uuid.is_empty():
		return false
	if obj_uuid == sm.self_avatar_id:
		return true
	# Check if this object's animesh root is the self avatar
	var root_id: String = sm.animesh_root_for.get(obj_uuid, "")
	return root_id == sm.self_avatar_id


# ─── Object Handlers ──────────────────────────────────
# Note: Coordinate conversion (SL→Godot) is done on the TypeScript side before sending.
# All position/rotation/scale arrays arrive pre-converted to Godot space.

func handle_object_create(msg: Dictionary) -> void:
	var obj_uuid: String = str(msg.get("uuid", ""))
	if obj_uuid.is_empty():
		return

	var parent_uuid: String = str(msg.get("parentUuid", ""))

	# Remove existing if duplicate
	if sm.objects.has(obj_uuid):
		_cleanup_object(obj_uuid)

	# Store object metadata (name/description arrive later via object_properties)
	sm.object_meta[obj_uuid] = {
		"uuid": obj_uuid,
		"name": "",
		"description": "",
		"clickAction": int(msg.get("clickAction", 0)),
		"ownerID": str(msg.get("ownerID", "")),
		"primFlags": int(msg.get("primFlags", 0)),
	}

	# Store flexi params if this is a flexible prim (ponytails, ribbons, flags, etc.)
	var flexi_data = msg.get("flexible")
	if flexi_data is Dictionary:
		sm.flexi_params[obj_uuid] = flexi_data

	# Placeholder box — only for legacy object_create (no mesh/shape data).
	# object_render messages include mesh/shape, so skip placeholder for those.
	var is_sculpt: bool = msg.get("sculpt", false)
	var has_real_mesh: bool = not str(msg.get("meshId", "")).is_empty() or msg.has("shape")
	var _vfar: float = sm.FrameBudget.VR_CAMERA_FAR if sm._vr_mode else sm._vis_far
	var _vfade: float = sm.FrameBudget.VR_VISIBILITY_FADE_MARGIN if sm._vr_mode else sm._vis_fade
	var rsi = sm.RSInstance.new(sm._scenario, _vfar, _vfade)
	if not is_sculpt and not has_real_mesh:
		rsi.set_mesh(sm.object_mesh)
		rsi.set_material_override(sm.object_material)

	# Apply transform
	var pos: Array = msg.get("position", [0, 0, 0])
	var rot: Array = msg.get("rotation", [0, 0, 0, 1])
	var scl: Array = msg.get("scale", [0.5, 0.5, 0.5])

	var godot_pos := Vector3(pos[0], pos[1], pos[2])
	var godot_rot := Quaternion(rot[0], rot[1], rot[2], rot[3])
	var godot_scale := Vector3(scl[0], scl[1], scl[2])

	rsi.scl = godot_scale  # SL prims have independent scale — no compensation

	if not parent_uuid.is_empty():
		# Child prim — store relative offset for linkset movement
		sm.object_parent[obj_uuid] = parent_uuid
		sm.child_offset_pos[obj_uuid] = godot_pos
		sm.child_offset_rot[obj_uuid] = godot_rot

		if not sm.object_children.has(parent_uuid):
			sm.object_children[parent_uuid] = []
		sm.object_children[parent_uuid].append(obj_uuid)

		if sm.objects.has(parent_uuid):
			# Parent exists — compute world position from parent + offset
			var parent_rsi = sm.objects[parent_uuid]
			rsi.pos = parent_rsi.pos + parent_rsi.rot * godot_pos
			rsi.rot = parent_rsi.rot * godot_rot
		elif sm.animesh_roots.has(parent_uuid):
			# Parent is an avatar or animesh root — use scene tree node transform.
			# Use global_position because worn animesh nodes are children of the avatar
			# node, so their .position is parent-local, not world-space.
			var root_node: Node3D = sm.animesh_roots[parent_uuid]
			var _rn_pos: Vector3 = root_node.global_position
			var _rn_rot: Quaternion = root_node.global_transform.basis.orthonormalized().get_rotation_quaternion()
			# If this attachment has a bone, use bone position for initial placement.
			# Shared skeleton has joint position overrides from mesh IBMs applied.
			var _ap: int = msg.get("attachmentPoint", 0)
			var _bn: String = ATTACH_POINT_BONES.get(_ap, "") if _ap > 0 else ""
			if not _bn.is_empty() and sm.animesh_shared_skeleton.has(parent_uuid):
				var _ss: Skeleton3D = sm.animesh_shared_skeleton[parent_uuid]
				var _bi: int = _ss.find_bone(_bn)
				if _bi >= 0:
					var _bpos: Vector3 = sm.animation_mgr._get_bone_global_rest_pos(_ss, _bi)
					var _bp: Vector3 = _rn_pos + _rn_rot * _bpos
					var _bg: Transform3D = _ss.get_bone_global_rest(_bi)
					var _br: Quaternion = _rn_rot * _bg.basis.orthonormalized().get_rotation_quaternion()
					var _bone_scale: Vector3 = sm.bone_shape_scales.get(parent_uuid, {}).get(_bn, Vector3.ONE)
					var _ap_xf: Array = sm.animation_mgr._get_ap_world_transform(_ap, _bp, _br, _bone_scale)
					rsi.pos = _ap_xf[0] + _ap_xf[2] * godot_pos
					rsi.rot = _ap_xf[2] * godot_rot
				else:
					rsi.pos = _rn_pos + _rn_rot * godot_pos
					rsi.rot = _rn_rot * godot_rot
			else:
				rsi.pos = _rn_pos + _rn_rot * godot_pos
				rsi.rot = _rn_rot * godot_rot
		else:
			# Parent hasn't arrived — use offset as-is (will be corrected when parent arrives)
			rsi.pos = godot_pos
			rsi.rot = godot_rot
			if not sm.pending_children.has(parent_uuid):
				sm.pending_children[parent_uuid] = []
			sm.pending_children[parent_uuid].append(obj_uuid)
	else:
		# Root prim — position is region-local, apply region offset for world position
		var cache_id: String = str(msg.get("cacheID", ""))
		var region_offset: Vector2 = sm.get_region_offset(cache_id)
		# SL→Godot coordinate conversion: SL X→Godot X, SL Y(north)→Godot -Z
		var offset_3d := Vector3(region_offset.x, 0.0, -region_offset.y)
		sm.object_region_offset[obj_uuid] = offset_3d
		rsi.pos = godot_pos + offset_3d
		rsi.rot = godot_rot

	rsi.push_transform()
	sm.objects[obj_uuid] = rsi

	# Track attachment point bone for non-rigged attachments that follow skeleton bones.
	# Only store if the bone actually exists in the shared skeleton (mRoot doesn't — it's
	# not a real skeleton bone, just the avatar root. Those fall through to normal positioning).
	var attach_point: int = msg.get("attachmentPoint", 0)
	if attach_point > 0 and not parent_uuid.is_empty() and sm.animesh_roots.has(parent_uuid):
		var bone_name: String = ATTACH_POINT_BONES.get(attach_point, "")
		if not bone_name.is_empty() and sm.animesh_shared_skeleton.has(parent_uuid):
			var _ss: Skeleton3D = sm.animesh_shared_skeleton[parent_uuid]
			var _bi: int = _ss.find_bone(bone_name)
			if _bi >= 0:
				sm.attach_bone[obj_uuid] = bone_name
				sm.attach_bone_idx[obj_uuid] = _bi
				sm.attach_point_id[obj_uuid] = attach_point

	# Animesh root detection — create a Node3D in the scene tree for skeleton parenting.
	# Worn animesh (child of avatar) uses the AVATAR's skeleton and root, matching SL behavior
	# where the ControlAvatar for a worn animesh shares the avatar's skeleton.
	if msg.get("animesh", false):
		if not parent_uuid.is_empty() and sm.animesh_roots.has(parent_uuid):
			# Worn animesh attachment — gets its OWN skeleton, parented under the avatar's
			# root node so it follows the avatar's transform. Its child prims' joint
			# overrides must NOT affect the avatar's skeleton (they define a separate
			# rigged mesh, e.g. animated tail/wings on a dog avatar).
			var avatar_node: Node3D = sm.animesh_roots[parent_uuid]
			var animesh_node := Node3D.new()
			animesh_node.name = "worn_animesh_%s" % _uuid_short(obj_uuid)
			avatar_node.add_child(animesh_node)
			# Position at attachment point relative to avatar root (RSI has world-space pos)
			var _inv_rot: Quaternion = avatar_node.quaternion.inverse()
			animesh_node.position = _inv_rot * (rsi.pos - avatar_node.position)
			animesh_node.quaternion = _inv_rot * rsi.rot
			animesh_node.scale = Vector3.ONE
			sm.animesh_roots[obj_uuid] = animesh_node
			sm.animesh_root_for[obj_uuid] = obj_uuid
			if not sm.animesh_shared_skeleton.has(obj_uuid):
				var shared_skel: Skeleton3D = sm.skeleton_builder.create_shared_skeleton()
				animesh_node.add_child(shared_skel)
				sm.animesh_shared_skeleton[obj_uuid] = shared_skel
				sm.animation_mgr.push_avatar_created(obj_uuid, shared_skel)
			_register_animesh_descendants(obj_uuid, obj_uuid)
			DebugLog.debug("animesh", "Worn animesh %s -> own skeleton under avatar root %s" % [_uuid_short(obj_uuid), _uuid_short(parent_uuid)])
		else:
			# Standalone animesh object (rezzed on ground) — own root + skeleton
			var animesh_node := Node3D.new()
			animesh_node.name = "animesh_%s" % _uuid_short(obj_uuid)
			sm.add_child(animesh_node)
			animesh_node.position = rsi.pos
			animesh_node.quaternion = rsi.rot
			# SL ControlAvatar uses mScaleConstraintFixup (default 1.0) — prim scale does NOT
			# affect the rendered animesh character size. The skeleton is at natural bind-pose size.
			animesh_node.scale = Vector3.ONE
			sm.animesh_roots[obj_uuid] = animesh_node
			sm.animesh_root_for[obj_uuid] = obj_uuid
			# Create shared skeleton — ALL meshes bind to this one skeleton (no per-mesh skeletons).
			# Added to scene tree as parent of MeshInstance3D nodes (Godot's expected pattern).
			if not sm.animesh_shared_skeleton.has(obj_uuid):
				var shared_skel: Skeleton3D = sm.skeleton_builder.create_shared_skeleton()
				animesh_node.add_child(shared_skel)
				sm.animesh_shared_skeleton[obj_uuid] = shared_skel
				sm.animation_mgr.push_avatar_created(obj_uuid, shared_skel)
			if _is_self_avatar(obj_uuid):
				DebugLog.debug("animesh", "Animesh root object %s created" % [_uuid_short(obj_uuid)])
			# Retroactively register existing children + grandchildren (attachment linksets)
			_register_animesh_descendants(obj_uuid, obj_uuid)

	# Track children of animesh roots (direct children AND grandchildren of linksets).
	# Skip if this object already has a root assigned (e.g. worn animesh that just
	# created its own root above — don't let child tracking overwrite it).
	if not parent_uuid.is_empty() and not sm.animesh_root_for.has(obj_uuid):
		if sm.animesh_roots.has(parent_uuid):
			sm.animesh_root_for[obj_uuid] = parent_uuid
		elif sm.animesh_root_for.has(parent_uuid):
			# Grandchild — inherit the same animesh root (attachment linkset child)
			sm.animesh_root_for[obj_uuid] = sm.animesh_root_for[parent_uuid]
		else:
			# Only log for self-avatar attachments — regular linkset children are expected noise
			if not sm.self_avatar_id.is_empty() and parent_uuid == sm.self_avatar_id:
				DebugLog.warn("animesh", "obj %s has parentUuid=%s (self avatar) but NOT an animesh root (animesh_roots has %d entries)" % [_uuid_short(obj_uuid), _uuid_short(parent_uuid), sm.animesh_roots.size()])

	# [SelfAvatar] log when an attachment is registered for the self avatar
	if _is_self_avatar(obj_uuid):
		DebugLog.debug("animesh", "Attachment created: uuid=%s parentUuid=%s" % [_uuid_short(obj_uuid), _uuid_short(parent_uuid)])

	# Create light if this object is a light source
	if msg.has("light") and msg["light"] is Dictionary:
		sm.light_mgr.create_or_update_light(obj_uuid, msg["light"], rsi)

	# If this is a root and we have pending children, fix their world positions
	if parent_uuid.is_empty() and sm.pending_children.has(obj_uuid):
		for child_uuid: String in sm.pending_children[obj_uuid]:
			if sm.objects.has(child_uuid) and sm.child_offset_pos.has(child_uuid):
				var child_rsi = sm.objects[child_uuid]
				child_rsi.pos = rsi.pos + rsi.rot * sm.child_offset_pos[child_uuid]
				child_rsi.rot = rsi.rot * sm.child_offset_rot[child_uuid]
				child_rsi.push_transform()
		sm.pending_children.erase(obj_uuid)

	# Resolve any seated avatars waiting for this object as their seat
	if sm.pending_seated_avatars.has(obj_uuid):
		for entry: Dictionary in sm.pending_seated_avatars[obj_uuid]:
			var av_id: String = entry["id"]
			if sm.avatars.has(av_id):
				var world_pos: Vector3 = rsi.pos + rsi.rot * entry["pos"]
				var world_rot: Quaternion = rsi.rot * entry["rot"]
				sm.avatars[av_id].pos = world_pos
				sm.avatars[av_id].rot = world_rot
				sm.avatars[av_id].push_transform()
				sm.avatar_targets[av_id] = { "pos": world_pos, "rot": world_rot, "vel": Vector3.ZERO }
				# Update skeleton root node too
				if sm.animesh_roots.has(av_id):
					var av_node: Node3D = sm.animesh_roots[av_id]
					av_node.position = world_pos
					av_node.quaternion = world_rot
				DebugLog.debug("avatarsit", "Resolved: avatar=%s seat=%s pos=%s" % [av_id.substr(0, 8), _uuid_short(obj_uuid), world_pos])
		sm.pending_seated_avatars.erase(obj_uuid)


func handle_object_update_batch(msg: Dictionary) -> void:
	var obj_list: Array = msg.get("objects", [])
	for obj: Dictionary in obj_list:
		var obj_uuid: String = str(obj.get("uuid", ""))
		if obj_uuid.is_empty():
			continue

		var rsi = sm.objects.get(obj_uuid)
		if rsi == null:
			continue

		# Parse motion data for interpolation
		var has_motion := false
		var vel := Vector3.ZERO
		var accel := Vector3.ZERO
		var ang_vel := Vector3.ZERO
		if obj.has("velocity"):
			var sv: Array = obj["velocity"]
			vel = Vector3(sv[0], sv[1], sv[2])
			if vel.length_squared() > 0.0001:
				has_motion = true
		if obj.has("acceleration"):
			var sa: Array = obj["acceleration"]
			accel = Vector3(sa[0], sa[1], sa[2])
			if accel.length_squared() > 0.0001:
				has_motion = true
		if obj.has("angularVelocity"):
			var sav: Array = obj["angularVelocity"]
			ang_vel = Vector3(sav[0], sav[1], sav[2])
			if ang_vel.length_squared() > 0.0001:
				has_motion = true

		if sm.object_parent.has(obj_uuid):
			# Child prim — update offsets, parent interpolation handles world pos
			if obj.has("position"):
				var cp: Array = obj["position"]
				sm.child_offset_pos[obj_uuid] = Vector3(cp[0], cp[1], cp[2])
			if obj.has("rotation"):
				var cr: Array = obj["rotation"]
				sm.child_offset_rot[obj_uuid] = Quaternion(cr[0], cr[1], cr[2], cr[3])
			if obj.has("scale"):
				var cs: Array = obj["scale"]
				rsi.scl = Vector3(cs[0], cs[1], cs[2])
			# Recompute world transform from parent
			var parent_rsi = sm.objects.get(sm.object_parent[obj_uuid])
			if parent_rsi and sm.child_offset_pos.has(obj_uuid):
				rsi.pos = parent_rsi.pos + parent_rsi.rot * sm.child_offset_pos[obj_uuid]
				rsi.rot = parent_rsi.rot * sm.child_offset_rot.get(obj_uuid, Quaternion.IDENTITY)
			rsi.push_transform()
		elif has_motion:
			# Root prim with motion — blend from current visual pos toward server pos
			var r_offset: Vector3 = sm.object_region_offset.get(obj_uuid, Vector3.ZERO)
			var server_pos: Vector3 = rsi.pos
			if obj.has("position"):
				var sp: Array = obj["position"]
				server_pos = Vector3(sp[0], sp[1], sp[2]) + r_offset
			var server_rot: Quaternion = rsi.rot
			if obj.has("rotation"):
				var sr: Array = obj["rotation"]
				server_rot = Quaternion(sr[0], sr[1], sr[2], sr[3])

			var target: Dictionary = {}
			target["pos"] = server_pos
			target["rot"] = server_rot
			target["vel"] = vel
			target["accel"] = accel
			target["angVel"] = ang_vel
			target["age"] = 0.0
			sm.object_targets[obj_uuid] = target
			# Scale always snaps
			if obj.has("scale"):
				var ms: Array = obj["scale"]
				rsi.scl = Vector3(ms[0], ms[1], ms[2])
				rsi.push_transform()
		else:
			# Root prim, no motion — snap immediately
			# BUT if the object is currently being interpolated (physics updates
			# arrived more recently via high-priority), this batch message is stale
			# from the low-priority queue. Skip position/rotation to avoid snapping backward.
			if sm.object_targets.has(obj_uuid):
				# Only allow scale changes from stale batch updates
				if obj.has("scale"):
					var ss: Array = obj["scale"]
					rsi.scl = Vector3(ss[0], ss[1], ss[2])
					rsi.push_transform()
			else:
				var r_off: Vector3 = sm.object_region_offset.get(obj_uuid, Vector3.ZERO)
				if obj.has("position"):
					var np: Array = obj["position"]
					rsi.pos = Vector3(np[0], np[1], np[2]) + r_off
				if obj.has("rotation"):
					var nr: Array = obj["rotation"]
					rsi.rot = Quaternion(nr[0], nr[1], nr[2], nr[3])
				if obj.has("scale"):
					var ns: Array = obj["scale"]
					rsi.scl = Vector3(ns[0], ns[1], ns[2])
				rsi.push_transform()

			# Propagate root movement to all children
			if sm.object_children.has(obj_uuid):
				_update_children_transforms(obj_uuid)

		# Sync animesh root Node3D transform with RSInstance
		_sync_animesh_transform(obj_uuid, rsi)

		# Sync flexi prim root transform with RSInstance
		if sm.flexi_params.has(obj_uuid):
			sm.flexi_mgr.UpdateTransform(obj_uuid, rsi.pos, rsi.rot)

		# Update light (may be added, changed, or removed)
		if obj.has("light"):
			if obj["light"] is Dictionary:
				sm.light_mgr.create_or_update_light(obj_uuid, obj["light"], rsi)
			else:
				# light: null means light was removed
				sm.light_mgr.destroy_light(obj_uuid)
				sm.light_mgr._object_light_data.erase(obj_uuid)
		elif sm.light_mgr.object_lights.has(obj_uuid):
			# Transform changed — update light position
			sm.light_mgr.update_light_transform(obj_uuid, rsi)


## Recompute world positions of all children from parent's current transform
func _update_children_transforms(parent_uuid: String) -> void:
	var parent_rsi = sm.objects.get(parent_uuid)
	if parent_rsi == null:
		return
	for child_uuid: String in sm.object_children[parent_uuid]:
		if sm.objects.has(child_uuid) and sm.child_offset_pos.has(child_uuid):
			var child_rsi = sm.objects[child_uuid]
			child_rsi.pos = parent_rsi.pos + parent_rsi.rot * sm.child_offset_pos[child_uuid]
			child_rsi.rot = parent_rsi.rot * sm.child_offset_rot[child_uuid]
			child_rsi.push_transform()
			# Sync animesh root Node3D for child animesh objects
			_sync_animesh_transform(child_uuid, child_rsi)
			# Sync flexi prim root Node3D
			if sm.flexi_params.has(child_uuid):
				sm.flexi_mgr.UpdateTransform(child_uuid, child_rsi.pos, child_rsi.rot)
			# Move child's light with it
			if sm.light_mgr.object_lights.has(child_uuid):
				sm.light_mgr.update_light_transform(child_uuid, child_rsi)


## Sync animesh root Node3D transform with its RSInstance (call after any RSInstance transform change)
## For worn animesh (child of avatar node), convert world-space RSI pos to parent-local space.
func _sync_animesh_transform(obj_uuid: String, rsi) -> void:
	if sm.animesh_roots.has(obj_uuid):
		var node: Node3D = sm.animesh_roots[obj_uuid]
		if node and is_instance_valid(node):
			var parent_node: Node3D = node.get_parent() as Node3D
			if parent_node != null and parent_node != sm:
				# Worn animesh — RSI pos is in world space, convert to parent-local
				var parent_inv_rot: Quaternion = parent_node.quaternion.inverse()
				node.position = parent_inv_rot * (rsi.pos - parent_node.position)
				node.quaternion = parent_inv_rot * rsi.rot
				# Reapply pelvis offset (constant in skeleton-local space)
				if sm.animesh_pelvis_offset.has(obj_uuid) and sm.animesh_shared_skeleton.has(obj_uuid):
					sm.animesh_shared_skeleton[obj_uuid].position = sm.animesh_pelvis_offset[obj_uuid]
			else:
				# Standalone animesh — RSI pos is world space, node is direct child of scene root
				node.position = rsi.pos
				node.quaternion = rsi.rot
			# Scale stays at Vector3.ONE — SL ControlAvatar doesn't scale by prim size


# ─── Animesh ─────────────────────────────────────────

## Recursively register all descendants of a parent as animesh children.
## Handles attachment linksets: root prim is direct child of avatar, child prims
## are grandchildren but still rig to the same avatar skeleton.
func _register_animesh_descendants(parent_uuid: String, root_uuid: String) -> void:
	if not sm.object_children.has(parent_uuid):
		return
	for child_uuid: String in sm.object_children[parent_uuid]:
		if not sm.animesh_root_for.has(child_uuid):
			sm.animesh_root_for[child_uuid] = root_uuid
			var child_mid: String = sm.object_mesh_id.get(child_uuid, "")
			if not child_mid.is_empty() and sm.mesh_cache.has(child_mid) and sm.rigged_mesh_paths.has(child_mid):
				_instantiate_animesh_mesh(child_uuid, child_mid, root_uuid)
				if sm.object_faces.has(child_uuid) and sm.objects.has(child_uuid):
					sm.asset_pipeline.apply_face_materials(sm.objects[child_uuid], child_uuid, sm.object_faces[child_uuid])
		# Recurse into grandchildren
		_register_animesh_descendants(child_uuid, root_uuid)


## Instantiate a rigged mesh under the shared skeleton for this animesh root.
## Extracts MeshInstance3D from the GLB, applies joint position overrides from the
## GLB skeleton to the shared skeleton, and binds the mesh to the shared skeleton.
## The GLB's per-mesh Skeleton3D is discarded — only the shared skeleton is used.
func _instantiate_animesh_mesh(obj_uuid: String, mesh_id: String, animesh_root_uuid: String) -> void:
	# Guard against double instantiation (can be called from cache hit + retry)
	if sm.animesh_mesh_instances.has(obj_uuid):
		return
	var glb_path: String = sm.rigged_mesh_paths.get(mesh_id, "")
	if glb_path.is_empty():
		DebugLog.warn("animesh", "No GLB path for rigged mesh %s (obj %s)" % [mesh_id, _uuid_short(obj_uuid)])
		return
	var root_node: Node3D = sm.animesh_roots.get(animesh_root_uuid)
	if root_node == null:
		DebugLog.warn("animesh", "No root node for animesh root %s (obj %s)" % [_uuid_short(animesh_root_uuid), _uuid_short(obj_uuid)])
		return
	var shared_skel: Skeleton3D = sm.animesh_shared_skeleton.get(animesh_root_uuid)
	if shared_skel == null:
		DebugLog.warn("animesh", "No shared skeleton for animesh root %s (obj %s)" % [_uuid_short(animesh_root_uuid), _uuid_short(obj_uuid)])
		return

	# Parse GLB and generate full scene tree (includes Skeleton3D + MeshInstance3D)
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	var err := doc.append_from_file(glb_path, state)
	if err != OK:
		DebugLog.warn("animesh", "Failed to parse GLB %s: %s (obj %s)" % [glb_path, error_string(err), _uuid_short(obj_uuid)])
		return
	var scene: Node = doc.generate_scene(state)
	if scene == null:
		DebugLog.warn("animesh", "generate_scene returned null for %s (obj %s)" % [glb_path, _uuid_short(obj_uuid)])
		return

	# Find Skeleton3D and MeshInstance3D in the generated scene tree
	var glb_skeleton: Skeleton3D = _find_node_of_type(scene, "Skeleton3D")
	var mesh_instance: MeshInstance3D = _find_node_of_type(scene, "MeshInstance3D")
	if glb_skeleton == null or mesh_instance == null:
		DebugLog.warn("animesh", "No Skeleton3D/MeshInstance3D in GLB for object %s" % [_uuid_short(obj_uuid)])
		scene.queue_free()
		return

	# Apply joint position overrides from GLB skeleton to shared skeleton.
	# Override list comes from mesh_ready message, stored on scene_manager.
	var override_joints: Array = sm.mesh_joint_overrides.get(mesh_id, [])
	if override_joints.size() > 0:
		DebugLog.debug("jointoverride", "Applying %d overrides for mesh %s (avatar root=%s)" % [override_joints.size(), mesh_id.substr(0, 16), _uuid_short(animesh_root_uuid)])
		sm.animation_mgr._apply_joint_overrides(glb_skeleton, shared_skel, override_joints, mesh_id)

	# Duplicate skin and remap bone indices to shared skeleton order.
	# Bones not in the shared skeleton (e.g. attachment point joints like "Pelvis",
	# "Mouth") are added dynamically with rest transforms from the GLB skeleton.
	var orig_skin: Skin = mesh_instance.skin

	if orig_skin != null:
		var new_skin: Skin = orig_skin.duplicate()
		for i in range(new_skin.get_bind_count()):
			var glb_bi: int = new_skin.get_bind_bone(i)
			if glb_bi >= 0 and glb_bi < glb_skeleton.get_bone_count():
				var bone_name: String = glb_skeleton.get_bone_name(glb_bi)
				var shared_bi: int = shared_skel.find_bone(bone_name)
				# No case-insensitive fallback — SL bone names are case-sensitive.
				# "Pelvis" (attachment point) != "PELVIS" (collision volume).
				# "Mouth" (attachment point) != "MOUTH" (collision volume, if any).
				# Mismatched names should fall through to dynamic bone addition.
				if shared_bi < 0:
					# Bone not in shared skeleton — add it dynamically.
					# This handles attachment point joints (e.g. "Pelvis", "Mouth")
					# that content creators rig vertices to. The GLB has the correct
					# rest transform (derived from IBM in mesh-converter.ts).
					shared_bi = shared_skel.add_bone(bone_name)
					var glb_rest: Transform3D = glb_skeleton.get_bone_rest(glb_bi)
					shared_skel.set_bone_rest(shared_bi, glb_rest)
					# Parent to the GLB bone's parent in the shared skeleton
					var glb_parent_bi: int = glb_skeleton.get_bone_parent(glb_bi)
					if glb_parent_bi >= 0:
						var parent_name: String = glb_skeleton.get_bone_name(glb_parent_bi)
						var shared_parent_bi: int = shared_skel.find_bone(parent_name)
						if shared_parent_bi >= 0:
							shared_skel.set_bone_parent(shared_bi, shared_parent_bi)
					DebugLog.debug("animesh", "Added missing bone '%s' (idx %d) to shared skeleton" % [bone_name, shared_bi])
				if shared_bi >= 0:
					new_skin.set_bind_bone(i, shared_bi)
		mesh_instance.skin = new_skin

	# Reparent mesh under shared skeleton
	mesh_instance.set_owner(null)
	mesh_instance.get_parent().remove_child(mesh_instance)
	shared_skel.add_child(mesh_instance)
	mesh_instance.transform = Transform3D.IDENTITY  # Reset local transform
	mesh_instance.skeleton = mesh_instance.get_path_to(shared_skel)

	# Shift the skeleton so mPelvis aligns with the object/bone position.
	# BSM bakes vertices relative to the skeleton root, but the object IS at
	# the pelvis conceptually — not at the skeleton root (which is below the
	# pelvis). Applied on every mesh instantiation (idempotent SET) because the
	# root prim may be a non-mesh placeholder with children being the actual
	# rigged meshes. Skipped for avatar bodies (they use body_offset instead).
	if not sm.avatars.has(animesh_root_uuid) and not sm.bone_shape_scales.has(animesh_root_uuid):
		var pelvis_bi: int = shared_skel.find_bone("mPelvis")
		if pelvis_bi >= 0:
			var pelvis_rest: Vector3 = shared_skel.get_bone_rest(pelvis_bi).origin
			var pelvis_offset := -pelvis_rest
			shared_skel.position = pelvis_offset
			sm.animesh_pelvis_offset[animesh_root_uuid] = pelvis_offset

	# Store reference
	sm.animesh_mesh_instances[obj_uuid] = mesh_instance

	# Create skinned pick instance — GPU skins this identically to visible mesh
	sm.object_picker.create_pick_instance_skinned(obj_uuid, mesh_instance.mesh, mesh_instance.skin, shared_skel)

	# Double-sided shadow casting reduces shadow acne near deformed joints
	mesh_instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_DOUBLE_SIDED

	# Hide the RSInstance placeholder (keep it for metadata/transform tracking)
	var rsi = sm.objects.get(obj_uuid)
	if rsi != null:
		RenderingServer.instance_set_visible(rsi.rid, false)
		RenderingServer.instance_geometry_set_cast_shadows_setting(
			rsi.rid, RenderingServer.SHADOW_CASTING_SETTING_OFF)

	# Hide the avatar placeholder (blue box) once first rigged mesh appears
	if sm.avatars.has(animesh_root_uuid):
		var av_rsi = sm.avatars[animesh_root_uuid]
		RenderingServer.instance_set_visible(av_rsi.rid, false)
		RenderingServer.instance_geometry_set_cast_shadows_setting(
			av_rsi.rid, RenderingServer.SHADOW_CASTING_SETTING_OFF)

	# Update animation thread bone metadata (joint overrides + dynamic bones may have changed it)
	sm.animation_mgr.push_joint_override_update(animesh_root_uuid, shared_skel)

	# If we already have pending animations for this root, apply them
	if sm.animesh_roots.has(animesh_root_uuid):
		sm.animation_mgr._apply_pending_animations(obj_uuid)

	if _is_self_avatar(obj_uuid):
		DebugLog.debug("animesh", "Rigged mesh instantiated: uuid=%s meshId=%s shared_bones=%d" % [_uuid_short(obj_uuid), mesh_id.substr(0, 8), shared_skel.get_bone_count()])

	# Debug: visualize skeleton once per root (check for existing markers)
	if sm.animation_mgr._debug_skeleton_visible:
		var already_has_markers: bool = false
		for child in shared_skel.get_children():
			if child.name.begins_with("dbg_bone_"):
				already_has_markers = true
				break
		if not already_has_markers:
			sm.animation_mgr._debug_visualize_skeleton(shared_skel)

	# Free the GLB scene (GLB skeleton + any remaining nodes)
	scene.queue_free()


## Find the first node of a given class in the scene tree (recursive DFS)
func _find_node_of_type(node: Node, type_name: String) -> Node:
	if node.get_class() == type_name:
		return node
	for child in node.get_children():
		var found := _find_node_of_type(child, type_name)
		if found != null:
			return found
	return null


# ─── Object Render (unified single-message path) ─────

## Handle object_render — unified message containing spatial data + mesh + faces + textures.
## Sent by the readiness tracker once ALL assets (mesh + textures) are cached on disk.
## Parent ordering guaranteed by Electron: parents always emitted before children.
func handle_object_render(msg: Dictionary) -> void:
	# Create RSInstance with position/rotation/scale/linkset/animesh setup
	handle_object_create(msg)

	var obj_uuid: String = str(msg.get("uuid", ""))
	if obj_uuid.is_empty() or not sm.objects.has(obj_uuid):
		return

	var mesh_id: String = str(msg.get("meshId", ""))
	var mesh_path: String = str(msg.get("meshPath", ""))
	var faces: Array = msg.get("faces", [])
	var shape: Dictionary = msg.get("shape", {})

	# Queue disk→GPU loads (readiness tracker guarantees files exist on disk)
	if not mesh_id.is_empty() and not mesh_path.is_empty():
		sm.asset_pipeline.queue_mesh_load(mesh_id, mesh_path, msg)
	if msg.has("faces"):
		for fi: Dictionary in msg.get("faces", []):
			var tex_id: String = str(fi.get("textureId", ""))
			var tex_path: String = str(fi.get("texturePath", ""))
			if not tex_id.is_empty() and not tex_path.is_empty():
				sm.asset_pipeline.queue_texture_load(tex_id, tex_path)
			for key: String in ["normalTextureId", "ormTextureId", "emissiveTextureId"]:
				var pbr_id: String = str(fi.get(key, ""))
				var pbr_path: String = str(fi.get(key.replace("Id", "Path"), ""))
				if not pbr_id.is_empty() and not pbr_path.is_empty():
					sm.asset_pipeline.queue_texture_load(pbr_id, pbr_path)

	# Store face data — _apply_faces and _tex_waiting callbacks read from here
	if faces.size() > 0:
		sm.object_faces[obj_uuid] = faces
	if msg.get("isAttachment", false):
		sm.object_is_attachment[obj_uuid] = true

	# Apply mesh (or register for callback when GPU-ready), then faces
	if not mesh_id.is_empty():
		sm.object_mesh_id[obj_uuid] = mesh_id
		if sm.mesh_cache.has(mesh_id):
			_apply_mesh(obj_uuid, mesh_id)
			_apply_faces(obj_uuid)
		else:
			# Mesh is loading disk→GPU — _flush_mesh_waiters will call _apply_mesh + _apply_faces
			sm.asset_pipeline.register_mesh_waiter(mesh_id, obj_uuid)
	elif not shape.is_empty():
		_apply_shape(obj_uuid, shape)
		_apply_faces(obj_uuid)
	else:
		_apply_faces(obj_uuid)


# ─── Mesh / Shape / Face Application ────────────────

## Apply a cached GPU mesh to an RSInstance. Handles rigged, animesh, and AABB correction.
func _apply_mesh(obj_uuid: String, mesh_id: String) -> void:
	var rsi = sm.objects.get(obj_uuid)
	if rsi == null:
		return

	var is_rigged: bool = sm.rigged_mesh_paths.has(mesh_id)
	var will_be_animesh: bool = sm.animesh_root_for.has(obj_uuid)

	if is_rigged and will_be_animesh and not sm.animesh_roots.has(obj_uuid):
		# Animesh child with rigged mesh: placeholder stays — real mesh goes on Skeleton3D
		pass
	elif is_rigged and not sm.animesh_roots.has(obj_uuid) and not will_be_animesh:
		# Non-animesh rigged: use cached mesh with AABB correction
		var cached_mesh: Mesh = sm.mesh_cache[mesh_id]
		rsi.set_mesh(cached_mesh)
		var aabb: AABB = cached_mesh.get_aabb()
		if aabb.size.x > 0.001 and aabb.size.y > 0.001 and aabb.size.z > 0.001:
			rsi.scl_divisor = aabb.size
			rsi.scl_center = aabb.get_center()
		rsi.push_transform()
		sm.object_picker.create_pick_resources(obj_uuid, cached_mesh, mesh_id, rsi)
	else:
		rsi.set_mesh(sm.mesh_cache[mesh_id])
		sm.object_picker.create_pick_resources(obj_uuid, sm.mesh_cache[mesh_id], mesh_id, rsi)

	sm.object_mesh_id[obj_uuid] = mesh_id

	# Animesh rigged mesh instantiation
	if sm.animesh_root_for.has(obj_uuid) and sm.rigged_mesh_paths.has(mesh_id):
		var ar_uuid: String = sm.animesh_root_for[obj_uuid]
		if not sm.animesh_mesh_instances.has(obj_uuid):
			_instantiate_animesh_mesh(obj_uuid, mesh_id, ar_uuid)


## Generate a procedural prim mesh and apply it.
func _apply_shape(obj_uuid: String, shape: Dictionary) -> void:
	var rsi = sm.objects.get(obj_uuid)
	if rsi == null:
		return
	var is_flexi: bool = sm.flexi_params.has(obj_uuid)
	var prim_mesh: ArrayMesh = sm.prim_generator.generate_flexi(shape) if is_flexi else sm.prim_generator.get_or_generate(shape)
	rsi.set_mesh(prim_mesh)
	sm.object_picker.create_pick_resources(obj_uuid, prim_mesh, "", rsi)
	if is_flexi:
		var flexi_root: Node3D = sm.flexi_mgr.CreateFlexi(
			obj_uuid, sm.flexi_params[obj_uuid], prim_mesh,
			rsi.pos, rsi.rot, rsi.scl)
		if flexi_root != null:
			RenderingServer.instance_set_visible(rsi.rid, false)


## Apply face materials from sm.object_faces. Textures not yet GPU-ready get placeholders
## and are registered in _tex_waiting for re-apply when they finish loading.
func _apply_faces(obj_uuid: String) -> void:
	var rsi = sm.objects.get(obj_uuid)
	if rsi == null:
		return
	var faces: Array = sm.object_faces.get(obj_uuid, [])
	if faces.size() > 0:
		sm.asset_pipeline.apply_face_materials(rsi, obj_uuid, faces)


# ─── Face/Material Updates ───────────────────────────

## Handle face updates (live texture changes, late PBR material resolution).
## Face data arrives enriched from Electron with texturePath, materialKey, resolvedAlphaMode.
func handle_update_faces(msg: Dictionary) -> void:
	var obj_uuid: String = str(msg.get("uuid", ""))
	var rsi = sm.objects.get(obj_uuid)
	if rsi == null or rsi.mesh == null:
		return
	var faces: Array = msg.get("faces", [])
	if faces.size() == 0:
		return

	# Queue texture loads for any new textures in the update
	for fi: Dictionary in faces:
		var tex_id: String = str(fi.get("textureId", ""))
		var tex_path: String = str(fi.get("texturePath", ""))
		if not tex_id.is_empty() and not tex_path.is_empty():
			sm.asset_pipeline.queue_texture_load(tex_id, tex_path)
		for key: String in ["normalTextureId", "ormTextureId", "emissiveTextureId"]:
			var pbr_id: String = str(fi.get(key, ""))
			var pbr_path: String = str(fi.get(key.replace("Id", "Path"), ""))
			if not pbr_id.is_empty() and not pbr_path.is_empty():
				sm.asset_pipeline.queue_texture_load(pbr_id, pbr_path)

	# Merge into existing face data
	if not sm.object_faces.has(obj_uuid):
		sm.object_faces[obj_uuid] = faces
	else:
		var existing: Array = sm.object_faces[obj_uuid]
		for new_face: Dictionary in faces:
			var idx: int = int(new_face.get("index", -1))
			var found := false
			for i: int in range(existing.size()):
				if int(existing[i].get("index", -1)) == idx:
					existing[i] = new_face
					found = true
					break
			if not found:
				existing.append(new_face)
	sm.asset_pipeline.apply_face_materials(rsi, obj_uuid, sm.object_faces[obj_uuid])


## Handle batched face updates (multiple objects in one message)
func handle_update_faces_batch(msg: Dictionary) -> void:
	var obj_list: Array = msg.get("objects", [])
	for entry: Dictionary in obj_list:
		handle_update_faces(entry)


# ─── Object Cleanup ──────────────────────────────────

func handle_object_kill(msg: Dictionary) -> void:
	var obj_uuid: String = str(msg.get("uuid", ""))
	_cleanup_object(obj_uuid)


## Clean up an object and all its children from all tracking dictionaries
func _cleanup_object(obj_uuid: String) -> void:
	if obj_uuid.is_empty():
		return

	# Recursively clean up children first
	if sm.object_children.has(obj_uuid):
		for child_uuid: String in sm.object_children[obj_uuid].duplicate():
			_cleanup_object(child_uuid)
		sm.object_children.erase(obj_uuid)

	# Remove from parent's children list
	if sm.object_parent.has(obj_uuid):
		var pid: String = sm.object_parent[obj_uuid]
		if sm.object_children.has(pid):
			sm.object_children[pid].erase(obj_uuid)
		sm.object_parent.erase(obj_uuid)

	# Free pick resources (physics body + ID buffer instance) before destroying RSInstance
	sm.object_picker.destroy_pick_resources(obj_uuid)

	# Free the RenderingServer instance
	if sm.objects.has(obj_uuid):
		sm.objects[obj_uuid].destroy()
		sm.objects.erase(obj_uuid)

	# Destroy associated light
	sm.light_mgr.destroy_light(obj_uuid)
	sm.light_mgr._object_light_data.erase(obj_uuid)
	sm.object_targets.erase(obj_uuid)

	# Clean up flexi prim
	if sm.flexi_params.has(obj_uuid):
		sm.flexi_mgr.DestroyFlexi(obj_uuid)
		sm.flexi_params.erase(obj_uuid)

	# Clean up animesh mesh instance (child of shared skeleton, freed individually)
	if sm.animesh_mesh_instances.has(obj_uuid):
		var ami_ref = sm.animesh_mesh_instances[obj_uuid]
		if ami_ref is MeshInstance3D and is_instance_valid(ami_ref):
			ami_ref.queue_free()
		sm.animesh_mesh_instances.erase(obj_uuid)
	sm.object_mesh_id.erase(obj_uuid)
	sm.attach_bone.erase(obj_uuid)
	sm.attach_bone_idx.erase(obj_uuid)
	sm.animesh_root_for.erase(obj_uuid)
	if sm.animesh_roots.has(obj_uuid):
		var animesh_ref = sm.animesh_roots[obj_uuid]
		if animesh_ref is Node3D and is_instance_valid(animesh_ref):
			animesh_ref.queue_free()
		sm.erase_animesh_state(obj_uuid)

	# Clean up asset pipeline waiter queues
	var mid: String = sm.object_mesh_id.get(obj_uuid, "")
	if not mid.is_empty() and sm.asset_pipeline._waiting_for_mesh.has(mid):
		var uuids: Array = sm.asset_pipeline._waiting_for_mesh[mid]
		uuids.erase(obj_uuid)
		if uuids.size() == 0:
			sm.asset_pipeline._waiting_for_mesh.erase(mid)
	# Remove from texture waiting lists
	for tid: String in sm.asset_pipeline._tex_waiting.keys():
		sm.asset_pipeline._tex_waiting[tid].erase(obj_uuid)
		if sm.asset_pipeline._tex_waiting[tid].size() == 0:
			sm.asset_pipeline._tex_waiting.erase(tid)
	sm.object_faces.erase(obj_uuid)
	sm.object_meta.erase(obj_uuid)
	sm.child_offset_pos.erase(obj_uuid)
	sm.child_offset_rot.erase(obj_uuid)
	sm.object_region_offset.erase(obj_uuid)
	sm.pending_children.erase(obj_uuid)
