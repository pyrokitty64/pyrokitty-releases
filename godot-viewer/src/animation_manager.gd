extends RefCounted

## Animation evaluation on a dedicated thread with consumer-driven pacing.
##
## The main thread pushes commands (animation changes, shape changes, avatar lifecycle)
## and consumes output slots at LOD-driven rates. The animation thread evaluates
## skeletons, producing pose rotations, positions, and global overrides that the
## main thread applies to Skeleton3D nodes.
##
## Key invariant: the animation thread NEVER accesses scene tree nodes (Skeleton3D).
## All node interaction happens on the main thread.

var sm  # scene_manager reference

# ─── Constants ────────────────────────────────────────

const HEAD_ROT_ANIM_UUID: String = "_builtin_head_rot"
const HEAD_ROT_PRIORITY: int = 1
const HEAD_ROT_TORSO_LAG: float = 0.35
const HEAD_ROT_NECK_LAG: float = 0.5
const HEAD_ROT_MAX_ANGLE: float = 1.2566
const _ANIM_BLEND_SPEED: float = 10.0

# Command type constants (avoid stringly-typed matching)
const CMD_AVATAR_CREATED: String = "AVATAR_CREATED"
const CMD_AVATAR_KILLED: String = "AVATAR_KILLED"
const CMD_ANIM_CHANGED: String = "ANIM_CHANGED"
const CMD_SHAPE_CHANGED: String = "SHAPE_CHANGED"
const CMD_BONE_META_UPDATE: String = "BONE_META_UPDATE"
const CMD_REGION_CHANGE: String = "REGION_CHANGE"
const CMD_CV_DATA: String = "CV_DATA"
const CMD_SHUTDOWN: String = "SHUTDOWN"

# ─── Occlusion Pause ─────────────────────────────────
var _paused_roots: Dictionary = {}  # root_id -> true (skip consumption while hidden)

func set_avatar_paused(root_id: String, paused: bool) -> void:
	if paused:
		_paused_roots[root_id] = true
	else:
		_paused_roots.erase(root_id)

# ─── Debug ────────────────────────────────────────────

var _debug_skeleton_visible: bool = false

# ─── Thread Infrastructure ────────────────────────────

var _thread: Thread = null
var _shutting_down: bool = false

# Command queue: main thread pushes, anim thread drains
var _cmd_lock: Mutex = Mutex.new()
var _cmd_queue: Array = []

# Per-root output slots (structure lock + individual per-slot locks)
var _slots_lock: Mutex = Mutex.new()
var _slots: Dictionary = {}  # root_id -> { lock, ready, pose_rotations, pose_positions, global_overrides }

# Thread-owned state — ONLY accessed from the animation thread after command push
var _t_bone_meta: Dictionary = {}      # root_id -> { count, names, parents, rest_origins, is_cv, name_to_idx }
var _t_shape_state: Dictionary = {}    # root_id -> { shape_scales, cv_volume_morphs }
var _t_eval_state: Dictionary = {}     # root_id -> { joints, prev_sl_local_rot, last_eval_usec, persistent_pos }
var _t_cv_rest_rotations: Dictionary = {} # bone_name -> Quaternion (SL space, immutable after init)
var _t_cv_default_scales: Dictionary = {} # cv_name -> Vector3 (SL space, immutable after init)
var _t_active_bones: Dictionary = {}   # root_id -> PackedInt32Array (sorted, parent-before-child)

# LOD consumption gating (main thread only)
var _lod_frame_counter: Dictionary = {} # root_id -> int (frames since last consumption)
# Track which bones were set last frame per root (for smart reset instead of resetting all 159)
var _prev_set_bones: Dictionary = {}   # root_id -> PackedInt32Array
# Cache last-consumed global_overrides per root so interpolation can reuse them
# on LOD-gated frames (bone poses unchanged, only root position changed).
var _last_global_overrides: Dictionary = {} # root_id -> Dictionary[int, Transform3D]

# Main-thread cached CV data (for _get_cv_default_scale and initialization)
var _cv_default_scales: Dictionary = {}
var _ap_logged: Dictionary = {}  # child_id -> true — one-shot AP debug log per attachment
# Cache key for last applied animation set per root — skip rebuild if unchanged
var _last_anim_set_key: Dictionary = {}  # root_id -> String (sorted anim IDs)
var _sl_cv_rest_rotations: Dictionary = {}
var _cv_data_sent: bool = false


func _init(scene_manager) -> void:
	sm = scene_manager
	_thread = Thread.new()
	_thread.start(_anim_thread_loop)


func shutdown() -> void:
	if _thread == null:
		return
	_push_cmd({"type": CMD_SHUTDOWN})
	_thread.wait_to_finish()
	_thread = null


# ─── Animation Batch Handling ────────────────────────

## Handle animations_batch — bridge has collected ALL animation data for a root.
## Contains the full set of animations with their parsed keyframe data.
func handle_animations_batch(msg: Dictionary) -> void:
	var obj_uuid: String = str(msg.get("uuid", ""))
	var animations: Dictionary = msg.get("animations", {})
	if sm.object_mgr._is_self_avatar(obj_uuid):
		DebugLog.debug("selfavatar", "animations_batch: uuid=%s, %d animations, is_animesh_root=%s, has_shared_skel=%s" % [
			obj_uuid.substr(0, 8), animations.size(),
			str(sm.animesh_roots.has(obj_uuid)),
			str(sm.animesh_shared_skeleton.has(obj_uuid))])
	if obj_uuid.is_empty():
		return

	# Empty batch = all animations stopped
	if animations.is_empty():
		var anim_root: String = sm.animesh_root_for.get(obj_uuid, obj_uuid)
		sm.animesh_pending_anims.erase(anim_root)
		sm.animesh_eval.erase(anim_root)
		if sm.animesh_eval.is_empty():
			sm.animesh_eval_active = false
		# Push empty joints to thread (clears eval state)
		_push_cmd({"type": CMD_ANIM_CHANGED, "root_id": anim_root, "joints": {}})
		# Discard any pending slot
		_discard_slot(anim_root)
		# Reset skeleton directly on main thread
		var shared_skel: Skeleton3D = sm.animesh_shared_skeleton.get(anim_root)
		if shared_skel != null:
			for bi in range(shared_skel.get_bone_count()):
				shared_skel.set_bone_pose_rotation(bi, Quaternion.IDENTITY)
				shared_skel.set_bone_pose_position(bi, Vector3.ZERO)
		if sm.object_mgr._is_self_avatar(obj_uuid):
			DebugLog.debug("selfavatar", "Animations cleared for uuid=%s" % obj_uuid.substr(0, 8))
		return

	# Cache all animation data and build pending anim list
	var anim_ids: Array = []
	for anim_id: String in animations:
		var data: Dictionary = animations[anim_id]
		if data.is_empty():
			continue
		if not sm.animesh_anim_data.has(anim_id):
			sm.animesh_anim_data[anim_id] = data
		anim_ids.append(anim_id)

	# Route animations to the correct root (worn animesh → avatar root)
	var anim_root: String = sm.animesh_root_for.get(obj_uuid, obj_uuid)
	if anim_root != obj_uuid:
		sm.animesh_worn_anims[anim_root] = sm.animesh_worn_anims.get(anim_root, []) as Array
		for aid: String in anim_ids:
			if not (sm.animesh_worn_anims[anim_root] as Array).has(aid):
				(sm.animesh_worn_anims[anim_root] as Array).append(aid)
	else:
		sm.animesh_pending_anims[obj_uuid] = anim_ids

	if sm.object_mgr._is_self_avatar(obj_uuid) or sm.object_mgr._is_self_avatar(anim_root):
		DebugLog.debug("selfavatar", "Animations batch received: uuid=%s root=%s, %d animations [%s]" % [obj_uuid.substr(0, 8), anim_root.substr(0, 8), anim_ids.size(), ", ".join(anim_ids.map(func(a: String) -> String: return a.substr(0, 8)))])

	# Trigger rebuild if shared skeleton exists for the root
	if sm.animesh_shared_skeleton.has(anim_root):
		_apply_pending_animations(anim_root)
	elif sm.object_mgr._is_self_avatar(anim_root):
		DebugLog.debug("selfavatar", "Batch for root=%s: %d anims cached, but NO shared skeleton yet" % [anim_root.substr(0, 8), anim_ids.size()])


## Apply any pending animations to a specific animesh root.
## Merges all pending animations by per-joint priority and stores merged keyframe data.
## Pushes ANIM_CHANGED command to the animation thread.
func _apply_pending_animations(obj_uuid: String) -> void:
	var root_id: String = sm.animesh_root_for.get(obj_uuid, obj_uuid)
	if root_id.is_empty():
		return
	# Combine root's own animations with worn animesh animations
	var pending_anims: Array = sm.animesh_pending_anims.get(root_id, []).duplicate()
	var worn: Array = sm.animesh_worn_anims.get(root_id, [])
	for aid: String in worn:
		if not pending_anims.has(aid):
			pending_anims.append(aid)
	if pending_anims.is_empty():
		return

	# Need shared skeleton to exist
	if not sm.animesh_shared_skeleton.has(root_id):
		return

	# Ensure CV data is sent to thread
	_ensure_cv_data_pushed()

	# Collect all available animations with their raw data
	var available: Array = []
	var available_ids: Array = []
	var missing: int = 0
	for anim_id: String in pending_anims:
		if sm.animesh_anim_data.has(anim_id):
			available.append(sm.animesh_anim_data[anim_id] as Dictionary)
			available_ids.append(anim_id)
		else:
			missing += 1

	# Skip rebuild if the exact same animation set was already applied
	available_ids.sort()
	var set_key: String = ",".join(available_ids)
	if _last_anim_set_key.get(root_id, "") == set_key and missing == 0:
		return
	_last_anim_set_key[root_id] = set_key

	if available.is_empty():
		if sm.object_mgr._is_self_avatar(root_id):
			DebugLog.debug("selfavatar", "_apply_pending root=%s: %d pending, 0 available, %d missing" % [root_id.substr(0, 8), pending_anims.size(), missing])
		return
	if sm.object_mgr._is_self_avatar(root_id):
		DebugLog.debug("selfavatar", "_apply_pending root=%s: %d available, %d missing, %d total joints" % [root_id.substr(0, 8), available.size(), missing, available.reduce(func(acc: int, d: Dictionary): return acc + (d.get("joints", []) as Array).size(), 0)])

	# Build per-joint per-CHANNEL priority maps.
	var joint_best_rot: Dictionary = {}
	var joint_best_pos: Dictionary = {}
	for ai in range(available.size()):
		var data: Dictionary = available[ai]
		var base_priority: int = int(data.get("priority", 0))
		var joints: Array = data.get("joints", [])
		for joint_data: Dictionary in joints:
			var jname: String = str(joint_data.get("name", ""))
			if jname.is_empty():
				continue
			var jpri: int = int(joint_data.get("priority", base_priority))
			if (joint_data.get("rotationKeys", []) as Array).size() > 0:
				if not joint_best_rot.has(jname) or jpri >= joint_best_rot[jname]["priority"]:
					joint_best_rot[jname] = {"priority": jpri, "data_idx": ai, "joint_data": joint_data}
			if (joint_data.get("positionKeys", []) as Array).size() > 0:
				if not joint_best_pos.has(jname) or jpri >= joint_best_pos[jname]["priority"]:
					joint_best_pos[jname] = {"priority": jpri, "data_idx": ai, "joint_data": joint_data}

	# ─── Synthetic head_rot (Firestorm built-in, computed per-frame) ───
	var _hr_idx: int = available.size()
	var _hr_placeholder_key: Array = [{"time": 0.0, "value": [0.0, 0.0, 0.0]}]
	available.append({
		"uuid": HEAD_ROT_ANIM_UUID,
		"priority": HEAD_ROT_PRIORITY,
		"duration": 0.0,
		"loop": true,
		"loopInPoint": 0.0,
		"loopOutPoint": 0.0,
		"easeInTime": 0.0,
		"easeOutTime": 0.0,
		"joints": [
			{"name": "mHead", "priority": HEAD_ROT_PRIORITY, "rotationKeys": _hr_placeholder_key, "positionKeys": []},
			{"name": "mNeck", "priority": HEAD_ROT_PRIORITY, "rotationKeys": _hr_placeholder_key, "positionKeys": []},
			{"name": "mTorso", "priority": HEAD_ROT_PRIORITY, "rotationKeys": _hr_placeholder_key, "positionKeys": []},
		],
	})
	for _hr_jd: Dictionary in (available[_hr_idx] as Dictionary).get("joints", []):
		var _hr_jname: String = str(_hr_jd.get("name", ""))
		var _hr_jpri: int = HEAD_ROT_PRIORITY
		if (_hr_jd.get("rotationKeys", []) as Array).size() > 0:
			if not joint_best_rot.has(_hr_jname) or _hr_jpri >= joint_best_rot[_hr_jname]["priority"]:
				joint_best_rot[_hr_jname] = {"priority": _hr_jpri, "data_idx": _hr_idx, "joint_data": _hr_jd}

	# Build merged joint keyframe map
	var prev_eval: Dictionary = sm.animesh_eval.get(root_id, {}) as Dictionary
	var prev_joints: Dictionary = prev_eval.get("joints", {}) as Dictionary
	var now_usec: int = Time.get_ticks_usec()

	var all_joint_names: Dictionary = {}
	for jname in joint_best_rot:
		all_joint_names[jname] = true
	for jname in joint_best_pos:
		all_joint_names[jname] = true

	var merged_joints: Dictionary = {}
	for jname: String in all_joint_names:
		var rot_entry: Dictionary = joint_best_rot.get(jname, {}) as Dictionary
		var pos_entry: Dictionary = joint_best_pos.get(jname, {}) as Dictionary

		var rot_keys: Array = []
		var pos_keys: Array = []
		var src_anim: Dictionary = {}
		var anim_uuid: String = ""
		if not rot_entry.is_empty():
			rot_keys = (rot_entry["joint_data"] as Dictionary).get("rotationKeys", [])
			src_anim = available[int(rot_entry["data_idx"])]
			anim_uuid = str(src_anim.get("uuid", ""))
		if not pos_entry.is_empty():
			pos_keys = (pos_entry["joint_data"] as Dictionary).get("positionKeys", [])
			if src_anim.is_empty():
				src_anim = available[int(pos_entry["data_idx"])]
				anim_uuid = str(src_anim.get("uuid", ""))

		# Preserve start_time_usec if same animation still wins this joint
		var start_time: int = now_usec
		if prev_joints.has(jname):
			var prev_jdata: Dictionary = prev_joints[jname]
			if prev_jdata.get("anim_uuid", "") == anim_uuid:
				start_time = int(prev_jdata.get("start_time_usec", now_usec))

		merged_joints[jname] = {
			"rot_keys": rot_keys,
			"pos_keys": pos_keys,
			"duration": float(src_anim.get("duration", 1.0)),
			"loop": src_anim.get("loop", false),
			"loop_in": float(src_anim.get("loopInPoint", 0.0)),
			"loop_out": float(src_anim.get("loopOutPoint", src_anim.get("duration", 1.0))),
			"ease_in_time": float(src_anim.get("easeInTime", 0.0)),
			"ease_out_time": float(src_anim.get("easeOutTime", 0.0)),
			"anim_uuid": anim_uuid,
			"start_time_usec": start_time,
		}

	# Store for main-thread continuity tracking
	sm.animesh_eval[root_id] = {
		"joints": merged_joints,
	}
	sm.animesh_eval_active = true

	# Push to animation thread (no duplicate needed — merged_joints is freshly created
	# each call, main thread replaces sm.animesh_eval[root_id] wholesale, thread holds its own ref)
	_push_cmd({"type": CMD_ANIM_CHANGED, "root_id": root_id, "joints": merged_joints})

	if sm.object_mgr._is_self_avatar(root_id):
		DebugLog.debug("selfavatar", "Animations applied: %d joints merged from %d animations" % [merged_joints.size(), available.size()])


# ─── Command Queue ────────────────────────────────────

func _push_cmd(cmd: Dictionary) -> void:
	_cmd_lock.lock()
	_cmd_queue.append(cmd)
	_cmd_lock.unlock()


func _discard_slot(root_id: String) -> void:
	_slots_lock.lock()
	var slot: Dictionary = _slots.get(root_id, {})
	_slots_lock.unlock()
	if not slot.is_empty():
		(slot["lock"] as Mutex).lock()
		slot["ready"] = false
		(slot["lock"] as Mutex).unlock()


func push_avatar_created(root_id: String, skeleton: Skeleton3D) -> void:
	_ensure_cv_data_pushed()
	var meta: Dictionary = _build_bone_meta(skeleton)
	_push_cmd({"type": CMD_AVATAR_CREATED, "root_id": root_id, "bone_meta": meta})
	# Create output slot
	_slots_lock.lock()
	_slots[root_id] = {
		"lock": Mutex.new(),
		"ready": false,
		"pose_rotations": {},
		"pose_positions": {},
		"global_overrides": {},
	}
	_slots_lock.unlock()
	_lod_frame_counter[root_id] = 0  # Consume first frame immediately


func push_avatar_killed(root_id: String) -> void:
	_push_cmd({"type": CMD_AVATAR_KILLED, "root_id": root_id})
	_slots_lock.lock()
	_slots.erase(root_id)
	_slots_lock.unlock()
	_lod_frame_counter.erase(root_id)
	_prev_set_bones.erase(root_id)
	_last_global_overrides.erase(root_id)


func push_shape_changed(root_id: String, skeleton: Skeleton3D, shape_scales: Dictionary, cv_volume_morphs: Dictionary) -> void:
	# Re-snapshot rest origins (shape change resets bone rests)
	var rest_origins: Array = []
	for bi in range(skeleton.get_bone_count()):
		rest_origins.append(skeleton.get_bone_rest(bi).origin)
	_push_cmd({
		"type": CMD_SHAPE_CHANGED,
		"root_id": root_id,
		"rest_origins": rest_origins,
		"shape_scales": shape_scales.duplicate(true),
		"cv_volume_morphs": cv_volume_morphs.duplicate(true),
	})


func push_joint_override_update(root_id: String, skeleton: Skeleton3D) -> void:
	# Full re-snapshot of bone metadata (bone count may have changed from dynamic bone addition)
	var meta: Dictionary = _build_bone_meta(skeleton)
	_push_cmd({"type": CMD_BONE_META_UPDATE, "root_id": root_id, "bone_meta": meta})


func push_region_change() -> void:
	_push_cmd({"type": CMD_REGION_CHANGE})
	_slots_lock.lock()
	_slots.clear()
	_slots_lock.unlock()
	_lod_frame_counter.clear()
	_prev_set_bones.clear()
	_last_global_overrides.clear()


func _ensure_cv_data_pushed() -> void:
	if _cv_data_sent or sm.skeleton_builder == null:
		return
	_cv_data_sent = true
	var cv_rots: Dictionary = sm.skeleton_builder.get_sl_rest_rotations()
	var cv_defaults: Dictionary = {}
	for bd: Dictionary in sm.skeleton_builder.get_bone_data():
		if bd.get("is_cv", false):
			cv_defaults[bd["name"]] = bd["scale"] as Vector3
	_push_cmd({
		"type": CMD_CV_DATA,
		"cv_rest_rotations": cv_rots.duplicate(true),
		"cv_default_scales": cv_defaults.duplicate(true),
	})
	# Also cache on main thread
	_sl_cv_rest_rotations = cv_rots
	_cv_default_scales = cv_defaults


func _build_bone_meta(skeleton: Skeleton3D) -> Dictionary:
	var count: int = skeleton.get_bone_count()
	var names: Array = []
	var parents := PackedInt32Array()
	var rest_origins: Array = []
	var is_cv: Array = []
	var name_to_idx: Dictionary = {}

	names.resize(count)
	parents.resize(count)
	rest_origins.resize(count)
	is_cv.resize(count)

	for bi in range(count):
		var bname: String = skeleton.get_bone_name(bi)
		names[bi] = bname
		parents[bi] = skeleton.get_bone_parent(bi)
		rest_origins[bi] = skeleton.get_bone_rest(bi).origin
		is_cv[bi] = bname == bname.to_upper() and not bname.begins_with("m")
		name_to_idx[bname] = bi

	return {
		"count": count,
		"names": names,
		"parents": parents,
		"rest_origins": rest_origins,
		"is_cv": is_cv,
		"name_to_idx": name_to_idx,
	}


# ─── Animation Thread ─────────────────────────────────

func _anim_thread_loop() -> void:
	while not _shutting_down:
		# 1. Drain command queue
		_cmd_lock.lock()
		var cmds: Array = _cmd_queue.duplicate()
		_cmd_queue.clear()
		_cmd_lock.unlock()

		for cmd: Dictionary in cmds:
			_thread_process_cmd(cmd)
			if _shutting_down:
				return

		# 2. Evaluate roots with empty slots
		var did_work: bool = false
		# Snapshot all slots once to avoid repeated locking
		_slots_lock.lock()
		var slots_snapshot: Dictionary = _slots.duplicate()
		_slots_lock.unlock()

		for root_id: String in slots_snapshot:
			if not _t_eval_state.has(root_id):
				continue
			var eval_st: Dictionary = _t_eval_state[root_id]
			if (eval_st.get("joints", {}) as Dictionary).is_empty():
				continue

			var slot: Dictionary = slots_snapshot[root_id]

			(slot["lock"] as Mutex).lock()
			var is_ready: bool = slot["ready"]
			(slot["lock"] as Mutex).unlock()

			if is_ready:
				continue  # Main thread hasn't consumed yet

			_thread_evaluate_root(root_id)
			did_work = true

		# 3. Sleep if no work (avoid busy-spinning)
		if not did_work:
			OS.delay_msec(1)


func _thread_process_cmd(cmd: Dictionary) -> void:
	var cmd_type: String = cmd.get("type", "")
	match cmd_type:
		"AVATAR_CREATED":
			var root_id: String = cmd["root_id"]
			_t_bone_meta[root_id] = cmd["bone_meta"]
			if not _t_eval_state.has(root_id):
				_t_eval_state[root_id] = {
					"joints": {},
					"prev_sl_local_rot": {},
					"last_eval_usec": Time.get_ticks_usec(),
					"persistent_pos": {},
				}
		"AVATAR_KILLED":
			var root_id: String = cmd["root_id"]
			_t_bone_meta.erase(root_id)
			_t_shape_state.erase(root_id)
			_t_eval_state.erase(root_id)
			_t_active_bones.erase(root_id)
		"ANIM_CHANGED":
			var root_id: String = cmd["root_id"]
			var joints: Dictionary = cmd["joints"]
			if not _t_eval_state.has(root_id):
				_t_eval_state[root_id] = {
					"joints": {},
					"prev_sl_local_rot": {},
					"last_eval_usec": Time.get_ticks_usec(),
					"persistent_pos": {},
				}
			_t_eval_state[root_id]["joints"] = joints
			if joints.is_empty():
				_t_eval_state[root_id]["prev_sl_local_rot"] = {}
				_t_eval_state[root_id]["persistent_pos"] = {}
				_t_active_bones.erase(root_id)
			else:
				_rebuild_active_bones(root_id)
		"SHAPE_CHANGED":
			var root_id: String = cmd["root_id"]
			_t_shape_state[root_id] = {
				"shape_scales": cmd["shape_scales"],
				"cv_volume_morphs": cmd["cv_volume_morphs"],
			}
			if _t_bone_meta.has(root_id):
				_t_bone_meta[root_id]["rest_origins"] = cmd["rest_origins"]
			_rebuild_active_bones(root_id)
		"BONE_META_UPDATE":
			var root_id: String = cmd["root_id"]
			_t_bone_meta[root_id] = cmd["bone_meta"]
			_rebuild_active_bones(root_id)
		"REGION_CHANGE":
			_t_bone_meta.clear()
			_t_shape_state.clear()
			_t_eval_state.clear()
			_t_active_bones.clear()
		"CV_DATA":
			_t_cv_rest_rotations = cmd["cv_rest_rotations"]
			_t_cv_default_scales = cmd["cv_default_scales"]
		"SHUTDOWN":
			_shutting_down = true


# ─── Active Bone Set ──────────────────────────────────

## Rebuild the set of bones that need evaluation for a root.
## Includes: animated joints, CV bones with rest rotations, bones with shape
## scales or volume morphs, and all their ancestors up to root.
## Sorted ascending (parent-before-child) for correct chain computation.
func _rebuild_active_bones(root_id: String) -> void:
	var meta: Dictionary = _t_bone_meta.get(root_id, {})
	if meta.is_empty():
		_t_active_bones.erase(root_id)
		return

	var count: int = meta["count"]
	var names: Array = meta["names"]
	var parents: PackedInt32Array = meta["parents"]
	var name_to_idx: Dictionary = meta["name_to_idx"]

	# Collect directly active bone indices
	var active_set: Dictionary = {}  # bi -> true

	# 1. Animated joints
	var eval_st: Dictionary = _t_eval_state.get(root_id, {})
	var joints: Dictionary = eval_st.get("joints", {})
	for jname: String in joints:
		if name_to_idx.has(jname):
			active_set[int(name_to_idx[jname])] = true

	# 2. CV bones with rest rotations (participate in SL rotation chain)
	for bi in range(count):
		if _t_cv_rest_rotations.has(names[bi]):
			active_set[bi] = true

	# 3. Bones with non-identity shape scales
	var shape: Dictionary = _t_shape_state.get(root_id, {})
	var shape_scales: Dictionary = shape.get("shape_scales", {})
	for bname: String in shape_scales:
		if name_to_idx.has(bname):
			active_set[int(name_to_idx[bname])] = true

	# 4. CV bones with volume morph deltas
	var vol_morphs: Dictionary = shape.get("cv_volume_morphs", {})
	for cvname: String in vol_morphs:
		if name_to_idx.has(cvname):
			active_set[int(name_to_idx[cvname])] = true

	# 5. Walk parent chains to root for all active bones
	var with_ancestors: Dictionary = {}
	for bi: int in active_set:
		var cur: int = bi
		while cur >= 0 and not with_ancestors.has(cur):
			with_ancestors[cur] = true
			cur = parents[cur]

	# 6. Sort ascending (parent-before-child)
	var result := PackedInt32Array()
	var keys: Array = with_ancestors.keys()
	keys.sort()
	result.resize(keys.size())
	for i in range(keys.size()):
		result[i] = keys[i]

	_t_active_bones[root_id] = result


# ─── Thread Evaluation ────────────────────────────────

func _thread_evaluate_root(root_id: String) -> void:
	var meta: Dictionary = _t_bone_meta.get(root_id, {})
	if meta.is_empty():
		return
	var shape: Dictionary = _t_shape_state.get(root_id, {})
	var eval_st: Dictionary = _t_eval_state[root_id]
	var joints: Dictionary = eval_st["joints"]

	if joints.is_empty():
		return

	var now_usec: int = Time.get_ticks_usec()
	var dt: float = float(now_usec - int(eval_st.get("last_eval_usec", now_usec))) / 1_000_000.0
	dt = minf(dt, 0.1)  # Cap to prevent huge jumps
	eval_st["last_eval_usec"] = now_usec

	# Evaluate SL local rotations and positions from keyframes
	var sl_local_rot: Dictionary = {}
	var sl_local_pos: Dictionary = {}
	for jname: String in joints:
		var jdata: Dictionary = joints[jname]
		var jdur: float = float(jdata["duration"])
		var joint_elapsed: float = float(now_usec - int(jdata["start_time_usec"])) / 1_000_000.0

		var t: float
		if jdur <= 0.0:
			t = 0.0
		elif jdata["loop"]:
			var loop_in: float = float(jdata.get("loop_in", 0.0))
			var loop_out: float = float(jdata.get("loop_out", jdur))
			var loop_len: float = loop_out - loop_in
			if loop_len <= 0.0:
				t = loop_in
			elif float(jdata.get("ease_in_time", 0.0)) > loop_len:
				t = minf(joint_elapsed, loop_out)
			elif joint_elapsed <= loop_out:
				t = minf(joint_elapsed, loop_out)
			else:
				t = loop_in + fmod(joint_elapsed - loop_out, loop_len)
		else:
			t = minf(joint_elapsed, jdur)

		var rot_keys: Array = jdata["rot_keys"]
		if rot_keys.size() > 0:
			sl_local_rot[jname] = _interp_sl_rotation(rot_keys, t)
		var pos_keys: Array = jdata["pos_keys"]
		if pos_keys.size() > 0:
			sl_local_pos[jname] = _interp_sl_position(pos_keys, t)

	# Per-frame head_rot computation
	var _hr_active: bool = false
	for _hr_jn: String in ["mHead", "mNeck", "mTorso"]:
		if joints.has(_hr_jn) and str((joints[_hr_jn] as Dictionary).get("anim_uuid", "")) == HEAD_ROT_ANIM_UUID:
			_hr_active = true
			break
	if _hr_active:
		var shape_scales: Dictionary = shape.get("shape_scales", {})
		var hr_rotations: Dictionary = _thread_compute_head_rot(sl_local_rot, sl_local_pos, meta, shape_scales)
		for _hr_jn2: String in hr_rotations:
			if joints.has(_hr_jn2) and str((joints[_hr_jn2] as Dictionary).get("anim_uuid", "")) == HEAD_ROT_ANIM_UUID:
				sl_local_rot[_hr_jn2] = hr_rotations[_hr_jn2]

	# Crossfade blending
	var prev_rot: Dictionary = eval_st.get("prev_sl_local_rot", {})
	var base_blend: float = 1.0 - exp(-_ANIM_BLEND_SPEED * maxf(dt, 0.001))
	for jname3: String in sl_local_rot:
		var blend: float = base_blend
		if joints.has(jname3):
			var jdata3: Dictionary = joints[jname3]
			var ease_in: float = float(jdata3.get("ease_in_time", 0.0))
			if ease_in > 0.0:
				var je3: float = float(now_usec - int(jdata3["start_time_usec"])) / 1_000_000.0
				if je3 < ease_in:
					var f: float = clampf(je3 / ease_in, 0.0, 1.0)
					var ease_weight: float = f * f * (3.0 - 2.0 * f)
					blend = minf(blend, ease_weight)
		if prev_rot.has(jname3):
			var prev_q: Quaternion = prev_rot[jname3]
			var new_q: Quaternion = sl_local_rot[jname3]
			if prev_q.dot(new_q) < 0.0:
				new_q = -new_q
			sl_local_rot[jname3] = prev_q.slerp(new_q, blend)
		elif blend < 1.0:
			sl_local_rot[jname3] = Quaternion.IDENTITY.slerp(sl_local_rot[jname3], blend)
	eval_st["prev_sl_local_rot"] = sl_local_rot.duplicate()

	# Evaluate skeleton animation (pure math, no Skeleton3D)
	var active_bones: PackedInt32Array = _t_active_bones.get(root_id, PackedInt32Array())
	if active_bones.is_empty():
		return  # No active bones to evaluate
	var pose_rotations: Dictionary = {}
	_thread_eval_skeleton(meta, sl_local_rot, sl_local_pos, pose_rotations, eval_st, active_bones)

	# Get persistent positions for global override computation
	var persistent_pos: Dictionary = eval_st.get("persistent_pos", {})

	# Compute global pose overrides for ALL bones (not just active).
	# Godot's internal bone chain doesn't account for CV rest rotations or
	# shape deformation, so we must override every bone explicitly.
	var all_bones := PackedInt32Array()
	var bone_count: int = int(meta["count"])
	all_bones.resize(bone_count)
	for i in range(bone_count):
		all_bones[i] = i
	var global_overrides: Dictionary = {}
	_thread_global_overrides(meta, shape, pose_rotations, persistent_pos, global_overrides, all_bones)

	# Write to slot
	_slots_lock.lock()
	var slot: Dictionary = _slots.get(root_id, {})
	_slots_lock.unlock()
	if slot.is_empty():
		return

	(slot["lock"] as Mutex).lock()
	slot["pose_rotations"] = pose_rotations
	slot["pose_positions"] = persistent_pos.duplicate()
	slot["global_overrides"] = global_overrides
	slot["ready"] = true
	(slot["lock"] as Mutex).unlock()


## Evaluate skeleton animation: compute per-bone pose rotations from SL local rotations.
## Pure math — no Skeleton3D access. Only iterates the active bone set (animated joints,
## CV bones, shape-affected bones, and all their ancestors). Typically ~60-80 bones
## instead of all 159, saving ~50% of dictionary lookups and quaternion math.
func _thread_eval_skeleton(meta: Dictionary, sl_local_rot: Dictionary, sl_local_pos: Dictionary, out_rot: Dictionary, eval_st: Dictionary, active_bones: PackedInt32Array) -> void:
	var names: Array = meta["names"]
	var parents: PackedInt32Array = meta["parents"]
	var rest_origins: Array = meta["rest_origins"]

	var sl_world: Dictionary = {}
	var godot_world: Dictionary = {}
	var persistent_pos: Dictionary = eval_st.get("persistent_pos", {})

	for ai in range(active_bones.size()):
		var bi: int = active_bones[ai]
		var bname: String = names[bi]
		var parent_bi: int = parents[bi]

		# SL local rotation: animation > CV rest > identity
		var q_sl_local: Quaternion
		if sl_local_rot.has(bname):
			q_sl_local = sl_local_rot[bname]
		elif _t_cv_rest_rotations.has(bname):
			q_sl_local = _t_cv_rest_rotations[bname]
		else:
			q_sl_local = Quaternion.IDENTITY

		var q_sl_parent_world: Quaternion = sl_world.get(parent_bi, Quaternion.IDENTITY)
		var q_sl_world: Quaternion = q_sl_parent_world * q_sl_local
		sl_world[bi] = q_sl_world

		var q_godot_world := Quaternion(
			q_sl_world.x, q_sl_world.z, -q_sl_world.y, q_sl_world.w).normalized()
		godot_world[bi] = q_godot_world

		var parent_godot_world: Quaternion = godot_world.get(parent_bi, Quaternion.IDENTITY)
		var pose_rot: Quaternion = (parent_godot_world.inverse() * q_godot_world).normalized()
		out_rot[bi] = pose_rot

		if sl_local_pos.has(bname):
			var sl_pos: Vector3 = sl_local_pos[bname]
			var absolute_godot := Vector3(sl_pos.x, sl_pos.z, -sl_pos.y)
			var rest_origin: Vector3 = rest_origins[bi]
			persistent_pos[bi] = absolute_godot - rest_origin

	eval_st["persistent_pos"] = persistent_pos


## Compute global pose overrides for skinning. Pure math — no Skeleton3D access.
## Applies parent scale (xform.cpp:76) and bone's own scale (xform.cpp:93).
## Iterates only the active bone set for the full chain computation. Non-active
## bones are skipped entirely — Godot's default rest chain handles them.
## The active set includes all ancestors, so the parent chain is always complete.
func _thread_global_overrides(meta: Dictionary, shape: Dictionary, pose_rot: Dictionary, pose_pos: Dictionary, out_overrides: Dictionary, active_bones: PackedInt32Array) -> void:
	var names: Array = meta["names"]
	var parents: PackedInt32Array = meta["parents"]
	var rest_origins: Array = meta["rest_origins"]
	var is_cv_arr: Array = meta["is_cv"]
	var shape_scales: Dictionary = shape.get("shape_scales", {})
	var vol_morphs: Dictionary = shape.get("cv_volume_morphs", {})

	var pos_globals: Dictionary = {}  # bi -> Transform3D (sparse, only active bones)

	for ai in range(active_bones.size()):
		var bi: int = active_bones[ai]
		var bname: String = names[bi]
		var parent_bi: int = parents[bi]

		var rest_xf := Transform3D()
		rest_xf.origin = rest_origins[bi]

		if parent_bi >= 0:
			var parent_name: String = names[parent_bi]
			if shape_scales.has(parent_name):
				rest_xf = _apply_parent_scale(rest_xf, shape_scales[parent_name])

		var pr: Quaternion = pose_rot.get(bi, Quaternion.IDENTITY)
		var pp: Vector3 = pose_pos.get(bi, Vector3.ZERO)
		var local_xf: Transform3D = rest_xf * Transform3D(Basis(pr), pp)

		if parent_bi >= 0 and pos_globals.has(parent_bi):
			pos_globals[bi] = pos_globals[parent_bi] * local_xf
		else:
			pos_globals[bi] = local_xf

		var final_xf: Transform3D = pos_globals[bi]
		var is_cv: bool = is_cv_arr[bi]

		if not is_cv:
			if shape_scales.has(bname):
				var bs: Vector3 = shape_scales[bname]
				var godot_scale := Vector3(bs.x, bs.z, bs.y)
				final_xf = Transform3D(
					pos_globals[bi].basis * Basis.from_scale(godot_scale),
					pos_globals[bi].origin
				)
		else:
			var cv_default: Vector3 = _t_cv_default_scales.get(bname, Vector3.ONE)
			var deformation: Vector3 = Vector3.ONE
			if parent_bi >= 0:
				var parent_name: String = names[parent_bi]
				if shape_scales.has(parent_name):
					deformation = shape_scales[parent_name]
			if vol_morphs.has(bname):
				var vm: Dictionary = vol_morphs[bname]
				var vm_s: Array = vm.get("scale", [0, 0, 0])
				if cv_default.x > 0.0001:
					deformation.x += vm_s[0] / cv_default.x
				if cv_default.y > 0.0001:
					deformation.y += vm_s[1] / cv_default.y
				if cv_default.z > 0.0001:
					deformation.z += vm_s[2] / cv_default.z
			if deformation != Vector3.ONE:
				var godot_scale := Vector3(deformation.x, deformation.z, deformation.y)
				final_xf = Transform3D(
					pos_globals[bi].basis * Basis.from_scale(godot_scale),
					pos_globals[bi].origin
				)

		out_overrides[bi] = final_xf


## Compute head_rot joint rotations. Pure math — uses bone_meta instead of Skeleton3D.
func _thread_compute_head_rot(sl_local_rot: Dictionary, sl_local_pos: Dictionary, meta: Dictionary, shape_scales: Dictionary, target_sl: Variant = null) -> Dictionary:
	var name_to_idx: Dictionary = meta["name_to_idx"]
	var rest_origins: Array = meta["rest_origins"]

	var chain: Array = ["mPelvis", "mTorso", "mChest", "mNeck", "mHead"]
	var world_rot: Dictionary = {}
	var world_pos: Dictionary = {}

	for ci in range(chain.size()):
		var cname: String = chain[ci]
		var local_rot: Quaternion = sl_local_rot.get(cname, Quaternion.IDENTITY)
		if ci == 0:
			world_rot[cname] = local_rot
			if sl_local_pos.has(cname):
				var p: Vector3 = sl_local_pos[cname]
				world_pos[cname] = Vector3(p.x, p.y, p.z)
			else:
				world_pos[cname] = Vector3.ZERO
		else:
			var pname: String = chain[ci - 1]
			world_rot[cname] = world_rot[pname] * local_rot
			var bone_offset := Vector3.ZERO
			if sl_local_pos.has(cname):
				bone_offset = sl_local_pos[cname]
			elif name_to_idx.has(cname):
				var bi: int = name_to_idx[cname]
				if bi < rest_origins.size():
					var godot_rest: Vector3 = rest_origins[bi]
					bone_offset = Vector3(godot_rest.x, -godot_rest.z, godot_rest.y)
			var parent_scale: Vector3 = shape_scales.get(pname, Vector3.ONE)
			bone_offset *= parent_scale
			world_pos[cname] = world_pos[pname] + world_rot[pname] * bone_offset

	var head_pos: Vector3 = world_pos.get("mHead", Vector3.ZERO)

	var look_dir: Vector3
	if target_sl != null:
		look_dir = (target_sl as Vector3).normalized()
	else:
		var target_pos := Vector3(2.5, 0.0, 0.0)
		look_dir = (target_pos - head_pos)
		if look_dir.length_squared() < 0.01:
			look_dir = Vector3(1.0, 0.0, 0.0)
		else:
			look_dir = look_dir.normalized()

	var root_up := Vector3(0.0, 0.0, 1.0)
	var left: Vector3 = root_up.cross(look_dir)
	if left.length_squared() < 0.15:
		var root_fwd2 := Vector3(1.0, 0.0, 0.0)
		look_dir = look_dir.lerp(root_fwd2, 0.4).normalized()
		left = root_up.cross(look_dir)
	left = left.normalized()
	var adjusted_up: Vector3 = look_dir.cross(left)
	var head_rot_local: Quaternion = Basis(look_dir, left, adjusted_up).transposed().get_rotation_quaternion()

	var angle: float = head_rot_local.get_angle()
	if angle > HEAD_ROT_MAX_ANGLE:
		head_rot_local = Quaternion.IDENTITY.slerp(head_rot_local, HEAD_ROT_MAX_ANGLE / angle)

	var torso_rot: Quaternion = Quaternion.IDENTITY.slerp(head_rot_local, HEAD_ROT_TORSO_LAG)
	var remaining: Quaternion = head_rot_local
	var neck_rot: Quaternion = Quaternion.IDENTITY.slerp(remaining, HEAD_ROT_NECK_LAG)
	var head_rot: Quaternion = Quaternion.IDENTITY.slerp(remaining, 1.0 - HEAD_ROT_NECK_LAG)

	return {"mTorso": torso_rot, "mNeck": neck_rot, "mHead": head_rot}


# ─── Main Thread Per-Frame Consumption ────────────────

## Read output slots from the animation thread and apply to Skeleton3D nodes.
## Called every frame from scene_manager._process().
## LOD gating controls consumption rate based on camera distance.
func consume_anim_slots(delta: float) -> void:
	var camera: Camera3D = sm.get_viewport().get_camera_3d()
	var camera_pos: Vector3 = camera.global_position if camera else Vector3.ZERO

	# Snapshot all slots once to avoid repeated locking
	_slots_lock.lock()
	var slots_snapshot: Dictionary = _slots.duplicate()
	_slots_lock.unlock()

	for root_id: String in slots_snapshot:
		# Skip avatars hidden by occlusion culling (thread stops naturally when slot stays ready)
		if _paused_roots.has(root_id):
			continue
		# LOD gating
		if not _should_consume_lod(root_id, camera_pos):
			continue

		var slot: Dictionary = slots_snapshot[root_id]

		(slot["lock"] as Mutex).lock()
		if not slot["ready"]:
			(slot["lock"] as Mutex).unlock()
			continue

		var pose_rotations: Dictionary = slot["pose_rotations"]
		var pose_positions: Dictionary = slot["pose_positions"]
		var global_overrides: Dictionary = slot["global_overrides"]
		slot["ready"] = false
		(slot["lock"] as Mutex).unlock()

		# Apply to Skeleton3D
		var shared_skel: Skeleton3D = sm.animesh_shared_skeleton.get(root_id)
		if shared_skel == null or not is_instance_valid(shared_skel):
			continue

		var skel_bone_count: int = shared_skel.get_bone_count()

		# Reset only previously-set bones to identity (instead of all 159).
		# Bones that were set last frame but aren't in this frame's output
		# need to return to rest pose.
		var prev_set: PackedInt32Array = _prev_set_bones.get(root_id, PackedInt32Array())
		for pi in range(prev_set.size()):
			var bi: int = prev_set[pi]
			if bi < skel_bone_count:
				shared_skel.set_bone_pose_rotation(bi, Quaternion.IDENTITY)

		# Apply pose rotations from thread and track which bones we set
		var new_set := PackedInt32Array()
		new_set.resize(pose_rotations.size())
		var si: int = 0
		for bi: int in pose_rotations:
			if bi < skel_bone_count:
				shared_skel.set_bone_pose_rotation(bi, pose_rotations[bi])
			new_set[si] = bi
			si += 1
		_prev_set_bones[root_id] = new_set

		# Apply pose positions (persistent, not reset)
		for bi: int in pose_positions:
			if bi < skel_bone_count:
				shared_skel.set_bone_pose_position(bi, pose_positions[bi])

		# Apply global pose overrides (only active bones — Godot handles the rest)
		for bi: int in global_overrides:
			if bi < skel_bone_count:
				shared_skel.set_bone_global_pose_override(bi, global_overrides[bi], 1.0, true)

		# Cache overrides for interpolation calls on LOD-gated frames
		_last_global_overrides[root_id] = global_overrides

		# Update bone attachments — reuses global_overrides to avoid re-walking bone chains
		_update_bone_attachments(root_id, shared_skel, global_overrides)

		# Debug markers
		if _debug_skeleton_visible:
			_update_debug_bone_markers(shared_skel)


## LOD-based consumption gating. Returns true if this root should be consumed this frame.
func _should_consume_lod(root_id: String, camera_pos: Vector3) -> bool:
	# Self avatar always consumes
	if root_id == sm.self_avatar_id:
		return true

	# Get avatar/animesh position for distance computation
	var root_pos: Vector3
	var root_node: Node3D = sm.animesh_roots.get(root_id)
	if root_node != null and is_instance_valid(root_node):
		root_pos = root_node.global_position
	elif sm.avatars.has(root_id):
		root_pos = sm.avatars[root_id].pos
	else:
		return true  # Unknown position, consume to be safe

	var dist_sq: float = camera_pos.distance_squared_to(root_pos)
	var FrameBudget = sm.FrameBudget

	var consume_interval: int
	if dist_sq < FrameBudget.ANIM_LOD_NEAR_SQ:
		consume_interval = FrameBudget.ANIM_LOD_CONSUME[0]
	elif dist_sq < FrameBudget.ANIM_LOD_MID_SQ:
		consume_interval = FrameBudget.ANIM_LOD_CONSUME[1]
	elif dist_sq < FrameBudget.ANIM_LOD_FAR_SQ:
		consume_interval = FrameBudget.ANIM_LOD_CONSUME[2]
	else:
		consume_interval = FrameBudget.ANIM_LOD_CONSUME[3]

	var counter: int = _lod_frame_counter.get(root_id, consume_interval)
	counter += 1
	if counter >= consume_interval:
		_lod_frame_counter[root_id] = 0
		return true
	else:
		_lod_frame_counter[root_id] = counter
		return false


# ─── Global Pose Overrides (kept for non-threaded callers) ────────────────


# ─── Bone Attachments ────────────────────────────────

## Update non-rigged avatar attachments to follow their attachment bone each frame.
## Reuses global_overrides from the animation thread (bone world transforms already
## computed) instead of re-walking parent chains via Skeleton3D API.
func _update_bone_attachments(root_id: String, shared_skel: Skeleton3D, global_overrides: Dictionary) -> void:
	if not sm.object_children.has(root_id):
		return
	var root_node: Node3D = sm.animesh_roots.get(root_id)
	if root_node == null or not is_instance_valid(root_node):
		return
	var shape_scales: Dictionary = sm.bone_shape_scales.get(root_id, {})
	var skel_offset: Vector3 = shared_skel.position
	var _rn_pos: Vector3 = root_node.global_position
	var _rn_rot: Quaternion = root_node.global_transform.basis.orthonormalized().get_rotation_quaternion()

	for child_id: String in sm.object_children[root_id]:
		if not sm.attach_bone.has(child_id):
			continue
		var bone_name: String = sm.attach_bone[child_id]

		# Use cached bone index if available, otherwise look up and cache
		var bi: int = sm.attach_bone_idx.get(child_id, -1)
		if bi < 0:
			bi = shared_skel.find_bone(bone_name)
			if bi < 0:
				continue
			sm.attach_bone_idx[child_id] = bi

		# Worn animesh with rigged mesh: skip RSI repositioning (mesh follows
		# skeleton via skinning) but keep syncing the animesh node to track
		# the avatar's bone — important for shape-deformed/quadruped avatars.
		if sm.animesh_mesh_instances.has(child_id):
			if sm.animesh_roots.has(child_id) and global_overrides.has(bi):
				var _gxf: Transform3D = global_overrides[bi]
				var _bwp: Vector3 = _rn_pos + _rn_rot * (skel_offset + _gxf.origin)
				var _bwr: Quaternion = _rn_rot * _gxf.basis.orthonormalized().get_rotation_quaternion()
				var _ap: int = sm.attach_point_id.get(child_id, 0)
				var _bs: Vector3 = shape_scales.get(bone_name, Vector3.ONE)
				var _axf: Array = _get_ap_world_transform(_ap, _bwp, _bwr, _bs)
				var _op: Vector3 = sm.child_offset_pos.get(child_id, Vector3.ZERO)
				var _or: Quaternion = sm.child_offset_rot.get(child_id, Quaternion.IDENTITY)
				var _rsi = sm.objects.get(child_id)
				if _rsi:
					_rsi.pos = _axf[0] + _axf[2] * _op
					_rsi.rot = _axf[2] * _or
					_rsi.push_transform()
					sm.object_mgr._sync_animesh_transform(child_id, _rsi)
			continue

		var child_rsi = sm.objects.get(child_id)
		if child_rsi == null:
			continue

		# Reuse the bone's skeleton-local world transform from global_overrides
		# (already computed by the animation thread — no chain walk needed).
		# .origin = bone position; .basis has bone shape scale baked in,
		# orthonormalized() strips it to get pure rotation.
		if not global_overrides.has(bi):
			continue
		var bone_global_xf: Transform3D = global_overrides[bi]
		var bone_pos: Vector3 = bone_global_xf.origin
		var bone_rot: Quaternion = bone_global_xf.basis.orthonormalized().get_rotation_quaternion()

		var bone_world_pos: Vector3 = _rn_pos + _rn_rot * (skel_offset + bone_pos)
		var bone_world_rot: Quaternion = _rn_rot * bone_rot
		var ap_id: int = sm.attach_point_id.get(child_id, 0)
		var bone_scale: Vector3 = shape_scales.get(bone_name, Vector3.ONE)
		var ap_xf: Array = _get_ap_world_transform(ap_id, bone_world_pos, bone_world_rot, bone_scale)
		var offset_pos: Vector3 = sm.child_offset_pos.get(child_id, Vector3.ZERO)
		var offset_rot: Quaternion = sm.child_offset_rot.get(child_id, Quaternion.IDENTITY)
		child_rsi.pos = ap_xf[0] + ap_xf[2] * offset_pos
		child_rsi.rot = ap_xf[2] * offset_rot
		child_rsi.push_transform()
		if not _ap_logged.has(child_id):
			_ap_logged[child_id] = true
			DebugLog.debug("attach", "obj=%s ap=%d bone=%s bone_wpos=%s bone_wrot=%s ap_wpos=%s ap_wrot=%s offset_pos=%s offset_rot=%s final_pos=%s" % [
				child_id.substr(0, 8), ap_id, bone_name,
				str(bone_world_pos), str(bone_world_rot),
				str(ap_xf[0]), str(ap_xf[2]),
				str(offset_pos), str(offset_rot), str(child_rsi.pos)])
		sm.object_mgr._sync_animesh_transform(child_id, child_rsi)
		if sm.light_mgr.object_lights.has(child_id):
			sm.light_mgr.update_light_transform(child_id, child_rsi)
		if sm.object_children.has(child_id):
			sm.interp_mgr._update_children_world_pos(child_id, child_rsi.pos, child_rsi.rot)


## Compute the world transform of an attachment point given the bone's world transform.
## SL's operator*(a,b) == Godot's b*a (reversed Hamilton product), so
## SL's "localRot * parentWorldRot" == Godot's "parentWorldRot * localRot".
## Returns [ap_world_pos, bone_world_rot, ap_world_rot].
func _get_ap_world_transform(ap_id: int, bone_world_pos: Vector3, bone_world_rot: Quaternion, bone_shape_scale: Vector3 = Vector3.ONE) -> Array:
	if ap_id <= 0 or not sm.object_mgr.ATTACH_POINT_OFFSETS.has(ap_id):
		return [bone_world_pos, bone_world_rot, bone_world_rot]
	var ap_data: Dictionary = sm.object_mgr.ATTACH_POINT_OFFSETS[ap_id]
	var sl_pos: Vector3 = ap_data["pos"]
	var sl_euler: Vector3 = ap_data["rot"]
	var scaled_sl_pos := Vector3(sl_pos.x * bone_shape_scale.x, sl_pos.y * bone_shape_scale.y, sl_pos.z * bone_shape_scale.z)
	var ap_pos_godot := Vector3(scaled_sl_pos.x, scaled_sl_pos.z, -scaled_sl_pos.y)
	var ap_rot_godot: Quaternion = _sl_euler_to_godot_quat(sl_euler.x, sl_euler.y, sl_euler.z)
	var ap_world_pos: Vector3 = bone_world_pos + bone_world_rot * ap_pos_godot
	var ap_world_rot: Quaternion = bone_world_rot * ap_rot_godot
	return [ap_world_pos, bone_world_rot, ap_world_rot]


## Apply parent shape scale to a bone's rest position (SL xform.cpp:76).
static func _apply_parent_scale(rest_xf: Transform3D, parent_scale: Vector3) -> Transform3D:
	var o: Vector3 = rest_xf.origin
	rest_xf.origin = Vector3(o.x * parent_scale.x, o.y * parent_scale.z, o.z * parent_scale.y)
	return rest_xf


## Build a parent-to-root bone index chain (reversed to root-first order).
static func _bone_chain_to_root(skeleton: Skeleton3D, bi: int) -> Array[int]:
	var chain: Array[int] = []
	var cur: int = bi
	while cur >= 0:
		chain.append(cur)
		cur = skeleton.get_bone_parent(cur)
	chain.reverse()
	return chain


## Get the XML default scale for a collision volume bone (lazy-cached).
func _get_cv_default_scale(cv_name: String) -> Vector3:
	if _cv_default_scales.is_empty():
		for bd: Dictionary in sm.skeleton_builder.get_bone_data():
			if bd.get("is_cv", false):
				_cv_default_scales[bd["name"]] = bd["scale"] as Vector3
	return _cv_default_scales.get(cv_name, Vector3.ONE)


## Convert SL Euler angles (roll, pitch, yaw in degrees) to a Godot quaternion.
## Formula matches SL's LLQuaternion::setQuat(roll, pitch, yaw) from llquaternion.cpp.
static func _sl_euler_to_godot_quat(roll_deg: float, pitch_deg: float, yaw_deg: float) -> Quaternion:
	if roll_deg == 0.0 and pitch_deg == 0.0 and yaw_deg == 0.0:
		return Quaternion.IDENTITY
	var r: float = deg_to_rad(roll_deg) * 0.5
	var p: float = deg_to_rad(pitch_deg) * 0.5
	var y: float = deg_to_rad(yaw_deg) * 0.5
	var sr := sin(r); var cr := cos(r)
	var sp := sin(p); var cp := cos(p)
	var sy := sin(y); var cy := cos(y)
	var sl_x: float = sr * cp * cy + cr * sp * sy
	var sl_y: float = cr * sp * cy - sr * cp * sy
	var sl_z: float = cr * cp * sy + sr * sp * cy
	var sl_w: float = cr * cp * cy - sr * sp * sy
	return Quaternion(sl_x, sl_z, -sl_y, sl_w).normalized()


# ─── Joint Overrides ─────────────────────────────────

## Get a bone's accumulated global rest position by walking the parent chain.
func _get_bone_global_rest_pos(skel: Skeleton3D, bi: int) -> Vector3:
	return _get_bone_global_rest_xf(skel, bi).origin


## Get a bone's accumulated global rest transform by walking the parent chain.
func _get_bone_global_rest_xf(skel: Skeleton3D, bi: int) -> Transform3D:
	var global_xf := Transform3D.IDENTITY
	var chain: Array[int] = _bone_chain_to_root(skel, bi)
	for idx: int in chain:
		global_xf = global_xf * skel.get_bone_rest(idx)
	return global_xf


## Apply joint position overrides from a GLB skeleton to the shared skeleton.
func _apply_joint_overrides(glb_skel: Skeleton3D, shared_skel: Skeleton3D, override_joints: Array, mesh_id: String) -> void:
	# Find the avatar root for priority tracking
	var avatar_root_id: String = ""
	for av_uuid: String in sm.animesh_shared_skeleton:
		if sm.animesh_shared_skeleton[av_uuid] == shared_skel:
			avatar_root_id = av_uuid
			break

	var xml_bones: Array = sm.skeleton_builder.get_bone_data()
	var xml_parent: Dictionary = {}
	var xml_pos: Dictionary = {}
	for bd: Dictionary in xml_bones:
		xml_parent[bd["name"]] = bd.get("parent_name", "")
		xml_pos[bd["name"]] = bd["pos"] as Vector3

	if not sm.bone_override_owner.has(avatar_root_id):
		sm.bone_override_owner[avatar_root_id] = {}
	var owners: Dictionary = sm.bone_override_owner[avatar_root_id]

	var override_count: int = 0
	var skipped_default: int = 0
	var skipped_priority: int = 0
	for jname in override_joints:
		var glb_bi: int = glb_skel.find_bone(jname as String)
		var shared_bi: int = shared_skel.find_bone(jname as String)
		if glb_bi < 0 or shared_bi < 0:
			continue
		var glb_rest: Transform3D = glb_skel.get_bone_rest(glb_bi)

		var godot_pos: Vector3 = glb_rest.origin
		var sl_pos := Vector3(godot_pos.x, -godot_pos.z, godot_pos.y)

		var default_pos: Vector3 = xml_pos.get(jname as String, sl_pos)
		if (sl_pos - default_pos).length() < 0.0001:
			skipped_default += 1
			continue

		var bone_key: String = jname as String
		if owners.has(bone_key) and mesh_id >= owners[bone_key]:
			skipped_priority += 1
			continue
		owners[bone_key] = mesh_id

		var final_godot := Vector3(sl_pos.x, sl_pos.z, -sl_pos.y)
		var new_rest := Transform3D()
		new_rest.origin = final_godot
		shared_skel.set_bone_rest(shared_bi, new_rest)
		override_count += 1

	if override_count > 0 or skipped_default > 0 or skipped_priority > 0:
		DebugLog.debug("jointoverride", "mesh=%s applied=%d/%d (skipped: %d default, %d priority)" % [mesh_id.substr(0, 8), override_count, override_joints.size(), skipped_default, skipped_priority])

	if override_count > 0 and not avatar_root_id.is_empty():
		if sm.avatars.has(avatar_root_id):
			sm.avatar_mgr._recompute_body_offset(avatar_root_id, shared_skel)
		else:
			# Animesh — recalculate pelvis offset after joint overrides may have
			# changed mPelvis rest position.
			var _pbi: int = shared_skel.find_bone("mPelvis")
			if _pbi >= 0:
				var _pr: Vector3 = shared_skel.get_bone_rest(_pbi).origin
				shared_skel.position = -_pr
				sm.animesh_pelvis_offset[avatar_root_id] = -_pr


## Convert a Basis to its rotation quaternion safely.
func _safe_basis_rotation(b: Basis) -> Quaternion:
	var on := b.orthonormalized()
	if absf(on.determinant()) < 0.5:
		return Quaternion.IDENTITY
	return on.get_rotation_quaternion()


# ─── Keyframe Interpolation ──────────────────────────

## Interpolate SL rotation keyframes at time t. Returns SL-space quaternion.
func _interp_sl_rotation(keys: Array, t: float) -> Quaternion:
	if keys.is_empty():
		return Quaternion.IDENTITY

	var k0: Dictionary = keys[0]
	if keys.size() == 1 or t <= float(k0.get("time", 0.0)):
		var v: Array = k0.get("value", [0, 0, 0])
		return _sl_quat_from_xyz(float(v[0]), float(v[1]), float(v[2]))

	var k1: Dictionary = keys[keys.size() - 1]
	if t >= float(k1.get("time", 0.0)):
		var v: Array = k1.get("value", [0, 0, 0])
		return _sl_quat_from_xyz(float(v[0]), float(v[1]), float(v[2]))

	var lo: int = 0
	var hi: int = keys.size() - 1
	while hi - lo > 1:
		var mid: int = (lo + hi) / 2
		if float(keys[mid].get("time", 0.0)) <= t:
			lo = mid
		else:
			hi = mid

	var t0: float = float(keys[lo].get("time", 0.0))
	var t1: float = float(keys[hi].get("time", 0.0))
	var frac: float = (t - t0) / maxf(t1 - t0, 0.0001)

	var v0: Array = keys[lo].get("value", [0, 0, 0])
	var v1: Array = keys[hi].get("value", [0, 0, 0])
	var q0: Quaternion = _sl_quat_from_xyz(float(v0[0]), float(v0[1]), float(v0[2]))
	var q1: Quaternion = _sl_quat_from_xyz(float(v1[0]), float(v1[1]), float(v1[2]))

	return q0.slerp(q1, frac)


## Interpolate SL position keyframes at time t. Returns SL-space Vector3 (meters).
func _interp_sl_position(keys: Array, t: float) -> Vector3:
	if keys.is_empty():
		return Vector3.ZERO

	var k0: Dictionary = keys[0]
	if keys.size() == 1 or t <= float(k0.get("time", 0.0)):
		var v: Array = k0.get("value", [0, 0, 0])
		return Vector3(float(v[0]), float(v[1]), float(v[2]))

	var k1: Dictionary = keys[keys.size() - 1]
	if t >= float(k1.get("time", 0.0)):
		var v: Array = k1.get("value", [0, 0, 0])
		return Vector3(float(v[0]), float(v[1]), float(v[2]))

	var lo: int = 0
	var hi: int = keys.size() - 1
	while hi - lo > 1:
		var mid: int = (lo + hi) / 2
		if float(keys[mid].get("time", 0.0)) <= t:
			lo = mid
		else:
			hi = mid

	var t0: float = float(keys[lo].get("time", 0.0))
	var t1: float = float(keys[hi].get("time", 0.0))
	var frac: float = (t - t0) / maxf(t1 - t0, 0.0001)

	var v0: Array = keys[lo].get("value", [0, 0, 0])
	var v1: Array = keys[hi].get("value", [0, 0, 0])
	var p0 := Vector3(float(v0[0]), float(v0[1]), float(v0[2]))
	var p1 := Vector3(float(v1[0]), float(v1[1]), float(v1[2]))

	return p0.lerp(p1, frac)


## Reconstruct SL quaternion from xyz components (w = sqrt(1 - x² - y² - z²), always >= 0)
func _sl_quat_from_xyz(x: float, y: float, z: float) -> Quaternion:
	var w_sq: float = 1.0 - x * x - y * y - z * z
	var w: float = sqrt(max(w_sq, 0.0))
	return Quaternion(x, y, z, w)


# ─── Debug Skeleton ──────────────────────────────────

func _debug_visualize_skeleton(skel: Skeleton3D) -> void:
	var sphere_mesh := SphereMesh.new()
	sphere_mesh.radius = 0.03
	sphere_mesh.height = 0.06

	var mat_standard := StandardMaterial3D.new()
	mat_standard.albedo_color = Color(1.0, 0.2, 0.2)
	mat_standard.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED

	var mat_cv := StandardMaterial3D.new()
	mat_cv.albedo_color = Color(0.2, 1.0, 0.2)
	mat_cv.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED

	var count: int = 0
	for bi in range(skel.get_bone_count()):
		var bname: String = skel.get_bone_name(bi)
		var mi := MeshInstance3D.new()
		mi.name = "dbg_bone_%s" % bname
		mi.mesh = sphere_mesh
		var is_cv: bool = bname == bname.to_upper() and not bname.begins_with("m")
		mi.material_override = mat_cv if is_cv else mat_standard
		mi.top_level = true
		skel.add_child(mi)
		count += 1

	DebugLog.log("debugskel", "Placed %d bone markers on skeleton (%d bones)" % [count, skel.get_bone_count()])


func toggle_debug_skeleton() -> void:
	_debug_skeleton_visible = not _debug_skeleton_visible
	DebugLog.log("debugskel", "Skeleton markers %s" % ("ON" if _debug_skeleton_visible else "OFF"))
	if _debug_skeleton_visible:
		for root_id in sm.animesh_shared_skeleton:
			var skel: Skeleton3D = sm.animesh_shared_skeleton[root_id]
			var already_has_markers: bool = false
			for child in skel.get_children():
				if child.name.begins_with("dbg_bone_"):
					already_has_markers = true
					break
			if not already_has_markers:
				_debug_visualize_skeleton(skel)
	else:
		for root_id in sm.animesh_shared_skeleton:
			var skel: Skeleton3D = sm.animesh_shared_skeleton[root_id]
			var to_remove: Array[Node] = []
			for child in skel.get_children():
				if child.name.begins_with("dbg_bone_"):
					to_remove.append(child)
			for child in to_remove:
				child.queue_free()


func _update_debug_bone_markers(skel: Skeleton3D) -> void:
	var skel_global: Transform3D = skel.global_transform
	for child in skel.get_children():
		if not child.name.begins_with("dbg_bone_"):
			continue
		var bname: String = child.name.substr(9)
		var bi: int = skel.find_bone(bname)
		if bi < 0:
			continue
		var chain: Array[int] = _bone_chain_to_root(skel, bi)
		var dbg_root_id: String = ""
		for rid: String in sm.animesh_shared_skeleton:
			if sm.animesh_shared_skeleton[rid] == skel:
				dbg_root_id = rid
				break
		var dbg_shape_scales: Dictionary = sm.bone_shape_scales.get(dbg_root_id, {})
		var bone_xf := Transform3D.IDENTITY
		for idx: int in chain:
			var rest_xf: Transform3D = skel.get_bone_rest(idx)
			var pose_rot: Quaternion = skel.get_bone_pose_rotation(idx)
			var pose_pos: Vector3 = skel.get_bone_pose_position(idx)
			var parent_idx: int = skel.get_bone_parent(idx)
			if parent_idx >= 0:
				var parent_name: String = skel.get_bone_name(parent_idx)
				if dbg_shape_scales.has(parent_name):
					rest_xf = _apply_parent_scale(rest_xf, dbg_shape_scales[parent_name])
			bone_xf = bone_xf * rest_xf * Transform3D(Basis(pose_rot), pose_pos)
		child.global_position = (skel_global * bone_xf).origin
