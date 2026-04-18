extends RefCounted

## Texture loading (thread pool), mesh loading (WorkerThreadPool), material
## creation/caching, and application of textures/meshes to pending objects.

const FrameBudget = preload("res://src/frame_budget.gd")
const PlanarMapShader = preload("res://src/planar_map.gdshader")
const PlanarMapAlphaShader = preload("res://src/planar_map_alpha.gdshader")
const StandardUVShader = preload("res://src/standard_uv.gdshader")
const StandardUVAlphaShader = preload("res://src/standard_uv_alpha.gdshader")

var sm  # scene_manager reference

class AsyncResult extends RefCounted:
	var data       # Worker writes Image (texture) here
	var gltf_state: GLTFState    # Worker writes parsed GLTF state here (mesh pipeline)
	var error: bool = false

# Async texture loading (own Thread pool — bypasses WorkerThreadPool low-priority cap)
var TEXTURE_THREAD_COUNT: int = FrameBudget.TEXTURE_THREAD_COUNT
var _texture_threads: Array[Thread] = []      # running Thread objects
var _texture_queue: Array = []                # shared queue: { textureId, path } (main thread pushes, workers pop)
var _texture_queue_lock: Mutex = Mutex.new()
var _texture_results: Array = []              # completed: { textureId, image } (workers push, main thread pops)
var _texture_results_lock: Mutex = Mutex.new()
var _texture_in_flight: Dictionary = {}       # textureId (String) -> true (dedup)
# Per-step timing accumulators (all threads write, stats reads + resets)
var _timing_lock: Mutex = Mutex.new()
var _timing_load_ms: float = 0.0
var _timing_mipmap_ms: float = 0.0
var _timing_compress_ms: float = 0.0
var _timing_count: int = 0
var _shutting_down: bool = false
var _tex_finalized_count: int = 0   # total textures uploaded to GPU
var _mesh_finalized_count: int = 0  # total meshes assigned to objects

# Budget tracking (accumulated between stats reports, then reset)
var _budget_samples: int = 0
var _budget_total_ms: float = 0.0
var _budget_used_ms: float = 0.0
var _budget_elapsed_ms: float = 0.0
# Per-operation main-thread timing (accumulated between stats reports)
var _fin_tex_create_ms: float = 0.0    # ImageTexture.create_from_image
var _fin_tex_apply_ms: float = 0.0     # _apply_texture_to_waiting
var _fin_tex_count: int = 0
var _fin_mesh_extract_ms: float = 0.0  # ImporterMesh.get_mesh
var _fin_mesh_apply_ms: float = 0.0    # _flush_mesh_waiters
var _fin_mesh_count: int = 0

# Async mesh loading (WorkerThreadPool)
var _mesh_tasks: Dictionary = {}         # task_id (int) -> { meshId: String, result: AsyncResult, path: String }
var _mesh_in_flight: Dictionary = {}     # meshId (String) -> true (dedup)
var _mesh_queue: Array = []              # queued { meshId, path } waiting to be submitted
var MESH_MAX_IN_FLIGHT: int = FrameBudget.MESH_MAX_IN_FLIGHT

# Texture alpha tracking: textureId -> true if fully opaque (DXT1/BC1, no alpha channel).
# Used to promote blend→opaque for legacy faces without a material (perf optimization).
# _texture_opaque removed — blend→opaque promotion now done by Electron (textureOpaque flag)
var _material_lookups: int = 0   # total calls to _get_or_create_material (lifetime)

# Initial loading mode: skip time budget and process all pending textures/meshes.
# Auto-exits when queues drain. Avoids trickle-loading on first region entry.
var _initial_loading: bool = true
var _initial_load_start_ms: float = 0.0

# Placeholder material cache: "colorhex_fb_ds" -> StandardMaterial3D
var _placeholder_cache: Dictionary = {}

# Double-sided shader cache
var _double_sided_shader_cache: Dictionary = {}  # Shader -> Shader (cull_back -> cull_disabled variant)

# Mesh waiter: objects waiting for a mesh to finish disk→GPU loading.
# meshId (String) -> Array[String] (object UUIDs). Flushed by _flush_mesh_waiters.
var _waiting_for_mesh: Dictionary = {}
# Texture waiter: objects needing face re-apply when a texture finishes disk→GPU loading.
# textureId (String) -> Array[String] (object UUIDs).
var _tex_waiting: Dictionary = {}



func _init(scene_manager) -> void:
	sm = scene_manager


func start_threads() -> void:
	_start_texture_threads()


func shutdown() -> void:
	_shutting_down = true


# ─── Mesh Pipeline ───────────────────────────────────

## Queue a mesh load from a disk path (object_render path).
## If already cached or in-flight, does nothing.
func queue_mesh_load(mesh_id: String, glb_path: String, msg: Dictionary = {}) -> void:
	if mesh_id.is_empty() or glb_path.is_empty():
		return
	# Track rigged mesh info from the render message
	if msg.get("isRigged", false):
		sm.rigged_mesh_paths[mesh_id] = glb_path
		var overrides: Array = msg.get("jointOverrides", [])
		if overrides.size() > 0:
			sm.mesh_joint_overrides[mesh_id] = overrides
	if _shutting_down or sm.mesh_cache.has(mesh_id) or _mesh_in_flight.has(mesh_id) or sm.mesh_load_failed.has(mesh_id):
		return
	_mesh_in_flight[mesh_id] = true
	_mesh_queue.append({ "meshId": mesh_id, "path": glb_path })


## Queue a texture load from a disk path (object_render path).
## If already cached or in-flight, does nothing.
func queue_texture_load(texture_id: String, tex_path: String) -> void:
	if texture_id.is_empty() or tex_path.is_empty():
		return
	if _shutting_down or sm.texture_cache.has(texture_id) or _texture_in_flight.has(texture_id) or sm.texture_load_failed.has(texture_id):
		return
	_texture_in_flight[texture_id] = true
	_texture_queue_lock.lock()
	_texture_queue.append({ "textureId": texture_id, "path": tex_path })
	_texture_queue_lock.unlock()


## Register an object as waiting for a mesh to become GPU-ready.
func register_mesh_waiter(mesh_id: String, obj_uuid: String) -> void:
	if not _waiting_for_mesh.has(mesh_id):
		_waiting_for_mesh[mesh_id] = []
	_waiting_for_mesh[mesh_id].append(obj_uuid)


## Apply mesh + faces to all objects that were waiting for this mesh.
func _flush_mesh_waiters(mesh_id: String) -> void:
	if not _waiting_for_mesh.has(mesh_id):
		return
	var uuids: Array = _waiting_for_mesh[mesh_id]
	_waiting_for_mesh.erase(mesh_id)
	for obj_uuid: String in uuids:
		sm.object_mgr._apply_mesh(obj_uuid, mesh_id)
		sm.object_mgr._apply_faces(obj_uuid)


## Submit queued meshes to WorkerThreadPool (throttled)
func _submit_mesh_tasks() -> void:
	while _mesh_queue.size() > 0 and _mesh_tasks.size() < MESH_MAX_IN_FLIGHT:
		var entry: Dictionary = _mesh_queue.pop_front()
		var mesh_id: String = entry["meshId"]
		var glb_path: String = entry["path"]

		var result := AsyncResult.new()
		var task_id: int = WorkerThreadPool.add_task(func() -> void:
			if _shutting_down:
				result.error = true
				return
			var doc := GLTFDocument.new()
			var state := GLTFState.new()
			var err := doc.append_from_file(glb_path, state)
			if err != OK or _shutting_down:
				result.error = true
				return
			# Store parsed state; mesh extraction runs on main thread (creates RS resources)
			result.gltf_state = state
		)
		_mesh_tasks[task_id] = { "meshId": mesh_id, "result": result, "path": glb_path }


# ─── Texture Pipeline ────────────────────────────────

## Start dedicated texture worker threads (called once from start_threads)
func _start_texture_threads() -> void:
	for i in range(TEXTURE_THREAD_COUNT):
		var t := Thread.new()
		t.start(_texture_worker_loop)
		_texture_threads.append(t)
	DebugLog.log("pipeline", "Ready: %d CPU threads, %d texture threads" % [OS.get_processor_count(), TEXTURE_THREAD_COUNT])


## Worker loop: runs on each dedicated texture thread
func _texture_worker_loop() -> void:
	while not _shutting_down:
		# Backpressure: if results queue is deep, let main thread catch up
		_texture_results_lock.lock()
		var results_depth := _texture_results.size()
		_texture_results_lock.unlock()
		if results_depth > 24:
			OS.delay_msec(50)
			continue

		# Pop next job from queue
		_texture_queue_lock.lock()
		var job: Dictionary = {}
		if _texture_queue.size() > 0:
			job = _texture_queue.pop_front()
		_texture_queue_lock.unlock()

		if job.is_empty():
			# No work — sleep briefly and retry
			OS.delay_msec(5)
			continue

		var texture_id: String = job["textureId"]
		var tex_path: String = job["path"]

		# Primary path: .bctex files are GPU-compressed (BC1/BC3 + mipmaps) by
		# Electron's WebGPU pipeline. Just load the raw blocks — no CPU work needed.
		if tex_path.ends_with(".bctex"):
			var t0 := Time.get_ticks_usec()
			var img := _load_bctex(tex_path)
			var t1 := Time.get_ticks_usec()

			_timing_lock.lock()
			_timing_load_ms += (t1 - t0) / 1000.0
			# No mipmap or compress time — already done on GPU
			_timing_count += 1
			_timing_lock.unlock()

			_texture_results_lock.lock()
			_texture_results.append({ "textureId": texture_id, "image": img })
			_texture_results_lock.unlock()
			continue

		# Fallback path: .webp files from the WebP decode path (GPU compression
		# unavailable or failed). Must generate mipmaps + S3TC compress on CPU here.
		# This is ~10-40ms per texture vs ~2ms for .bctex above.
		var t0 := Time.get_ticks_usec()
		var img := Image.new()
		var err := img.load(tex_path)
		var t1 := Time.get_ticks_usec()
		if err != OK or _shutting_down:
			_texture_results_lock.lock()
			_texture_results.append({ "textureId": texture_id, "image": null })
			_texture_results_lock.unlock()
			continue

		img.generate_mipmaps()
		var t2 := Time.get_ticks_usec()
		if _shutting_down:
			_texture_results_lock.lock()
			_texture_results.append({ "textureId": texture_id, "image": null })
			_texture_results_lock.unlock()
			continue

		img.compress(Image.COMPRESS_S3TC)
		var t3 := Time.get_ticks_usec()

		_timing_lock.lock()
		_timing_load_ms += (t1 - t0) / 1000.0
		_timing_mipmap_ms += (t2 - t1) / 1000.0
		_timing_compress_ms += (t3 - t2) / 1000.0
		_timing_count += 1
		_timing_lock.unlock()

		_texture_results_lock.lock()
		_texture_results.append({ "textureId": texture_id, "image": img })
		_texture_results_lock.unlock()


## Load a pre-compressed .bctex file (BC1/BC3 with mipmaps).
## Header: 32 bytes (magic, version, width, height, format, mipCount, flags, dataSize)
## Body: concatenated mip levels, largest first
func _load_bctex(bctex_path: String) -> Image:
	var f := FileAccess.open(bctex_path, FileAccess.READ)
	if f == null:
		DebugLog.warn("bctex", "_load_bctex: can't open %s" % bctex_path)
		return null

	# Read 32-byte header
	var magic := f.get_32()
	var version := f.get_32()
	if magic != 0x42435458 or version != 1:
		DebugLog.warn("bctex", "_load_bctex: invalid header in %s" % bctex_path)
		f.close()
		return null

	var width := int(f.get_32())
	var height := int(f.get_32())
	var fmt := int(f.get_32())     # 0=BC1, 1=BC3
	var mip_count := int(f.get_32())
	var _flags := f.get_32()        # bit 0 = has_alpha (informational)
	var data_size := int(f.get_32())

	# Read compressed data blob
	var data := f.get_buffer(data_size)
	f.close()

	if data.size() != data_size:
		DebugLog.warn("bctex", "_load_bctex: short read %d/%d in %s" % [data.size(), data_size, bctex_path])
		return null

	# Map format: BC1 -> FORMAT_DXT1, BC3 -> FORMAT_DXT5
	var godot_format: Image.Format
	if fmt == 0:
		godot_format = Image.FORMAT_DXT1
	else:
		godot_format = Image.FORMAT_DXT5

	var has_mipmaps := mip_count > 1
	if DebugLog.enabled("bctex"):
		var _fmt_name := "DXT1(BC1)" if fmt == 0 else "DXT5(BC3)"
		DebugLog.debug("bctex", "%s: %dx%d fmt=%s mips=%d data=%d flags=%d" % [bctex_path.get_file(), width, height, _fmt_name, mip_count, data_size, _flags])
	return Image.create_from_data(width, height, has_mipmaps, godot_format, data)


## Re-apply face materials for all objects waiting on a newly-cached texture.
func _apply_texture_to_waiting(texture_id: String) -> void:
	# Apply projection texture to any lights waiting for it
	sm.light_mgr.apply_pending_proj_texture(texture_id)

	if not _tex_waiting.has(texture_id):
		return

	var obj_uuids: Array = _tex_waiting[texture_id]
	_tex_waiting.erase(texture_id)
	for obj_uuid: String in obj_uuids:
		var rsi = sm.objects.get(obj_uuid)
		if rsi != null and sm.object_faces.has(obj_uuid):
			apply_face_materials(rsi, obj_uuid, sm.object_faces[obj_uuid])


# ─── Finalization (_process budget) ──────────────────

## Called from scene_manager._process to finalize completed textures and meshes
## within the frame time budget.
func finalize_frame(delta: float, vr_mode: bool, target_frame_ms: float) -> void:
	# Grab completed texture results from worker threads
	var tex_batch: Array = []
	_texture_results_lock.lock()
	if _texture_results.size() > 0:
		tex_batch = _texture_results.duplicate()
		_texture_results.clear()
	_texture_results_lock.unlock()

	# Submit queued mesh work to WorkerThreadPool (before early return so work starts)
	if _mesh_queue.size() > 0:
		_submit_mesh_tasks()

	var has_textures := tex_batch.size() > 0
	var has_meshes := not _mesh_tasks.is_empty()

	# Exit initial loading after 30s — keep the large finalization budget and
	# brightness fade-in for the full duration so the transition feels smooth.
	var _initial_elapsed_ms := (Time.get_ticks_usec() / 1000.0) - _initial_load_start_ms if _initial_load_start_ms > 0.0 else 0.0
	if _initial_loading and _initial_elapsed_ms > 30000.0:
		_initial_loading = false
		if _initial_load_start_ms > 0.0:
			var total_ms := (Time.get_ticks_usec() / 1000.0) - _initial_load_start_ms
			DebugLog.log("pipeline", "Initial load complete in %.0fms (tex: %d, mesh: %d)" % [
				total_ms, _tex_finalized_count, _mesh_finalized_count])

	if not has_textures and not has_meshes:
		return

	# Initial loading mode: large budget (~50ms/frame) so Godot still renders
	# at ~15-20fps while the world loads in quickly. Scene_manager drives fog reveal.
	var is_initial: bool = _initial_loading
	if is_initial and _initial_load_start_ms == 0.0:
		_initial_load_start_ms = Time.get_ticks_usec() / 1000.0

	# Adaptive budget: use whatever time remains before the frame deadline.
	var frame_start_ms := (Time.get_ticks_usec() / 1000.0) - (delta * 1000.0)
	var now_ms := Time.get_ticks_usec() / 1000.0
	var elapsed_ms := now_ms - frame_start_ms
	var remaining_ms := target_frame_ms - elapsed_ms
	var budget_ms: float
	if is_initial:
		budget_ms = 50.0  # ~15-20fps during initial load
	else:
		# When over budget be aggressive — frame is slow anyway.
		budget_ms = maxf(remaining_ms, FrameBudget.OVERBUDGET_FINALIZE_MS if remaining_ms < FrameBudget.MIN_FINALIZE_MS else FrameBudget.MIN_FINALIZE_MS)
	# Split: 60% textures, 40% meshes (textures are cheaper per-item)
	var tex_budget_ms := budget_ms * 0.6 if has_meshes else budget_ms
	var mesh_budget_ms := budget_ms * 0.4 if has_textures else budget_ms

	var start_ms := now_ms

	# Finalize completed textures (time-budgeted)
	if has_textures:
		var processed := 0
		for entry: Dictionary in tex_batch:
			if (Time.get_ticks_usec() / 1000.0) - start_ms >= tex_budget_ms:
				# Put unprocessed results back for next frame
				_texture_results_lock.lock()
				for j in range(processed, tex_batch.size()):
					_texture_results.append(tex_batch[j])
				_texture_results_lock.unlock()
				break
			var texture_id: String = entry["textureId"]
			var img: Image = entry["image"]
			_texture_in_flight.erase(texture_id)
			if img == null:
				sm.texture_load_failed[texture_id] = true
			else:
				var _t0 := Time.get_ticks_usec()
				sm.texture_cache[texture_id] = ImageTexture.create_from_image(img)
				var _t1 := Time.get_ticks_usec()
				_apply_texture_to_waiting(texture_id)
				var _t2 := Time.get_ticks_usec()
				_fin_tex_create_ms += (_t1 - _t0) / 1000.0
				_fin_tex_apply_ms += (_t2 - _t1) / 1000.0
				_fin_tex_count += 1
				_tex_finalized_count += 1
			processed += 1

	# Finalize completed mesh tasks (time-budgeted, uses remaining budget)
	if has_meshes:
		var mesh_start_ms := Time.get_ticks_usec() / 1000.0
		var done_ids: Array = []
		for task_id: int in _mesh_tasks:
			if (Time.get_ticks_usec() / 1000.0) - mesh_start_ms >= mesh_budget_ms:
				break
			if not WorkerThreadPool.is_task_completed(task_id):
				continue
			WorkerThreadPool.wait_for_task_completion(task_id)
			done_ids.append(task_id)
			var info: Dictionary = _mesh_tasks[task_id]
			var mesh_id: String = info["meshId"]
			var result: AsyncResult = info["result"]
			_mesh_in_flight.erase(mesh_id)
			if result.error or result.gltf_state == null:
				sm.mesh_load_failed[mesh_id] = true
				DebugLog.warn("pipeline", "Mesh FAILED (parse error): %s path=%s" % [mesh_id.left(8), info.get("path", "?")])
			else:
				# Extract mesh via ImporterMesh — no Node tree, no queue_free
				var gltf_meshes: Array = result.gltf_state.get_meshes()
				if gltf_meshes.is_empty():
					sm.mesh_load_failed[mesh_id] = true
					DebugLog.warn("pipeline", "Mesh FAILED (no meshes in GLB): %s path=%s" % [mesh_id.left(8), info.get("path", "?")])
				else:
					var importer_mesh: ImporterMesh = gltf_meshes[0].mesh
					if importer_mesh == null:
						sm.mesh_load_failed[mesh_id] = true
						DebugLog.warn("pipeline", "Mesh FAILED (null ImporterMesh): %s" % mesh_id.left(8))
					else:
						var _t0 := Time.get_ticks_usec()
						var m: Mesh = importer_mesh.get_mesh()
						var _t1 := Time.get_ticks_usec()
						if m == null:
							sm.mesh_load_failed[mesh_id] = true
						else:
							sm.mesh_cache[mesh_id] = m
							_flush_mesh_waiters(mesh_id)
							var _t2 := Time.get_ticks_usec()
							_fin_mesh_extract_ms += (_t1 - _t0) / 1000.0
							_fin_mesh_apply_ms += (_t2 - _t1) / 1000.0
							_fin_mesh_count += 1
							_mesh_finalized_count += 1
		for task_id: int in done_ids:
			_mesh_tasks.erase(task_id)

	# Track budget stats
	_budget_samples += 1
	_budget_elapsed_ms += elapsed_ms
	_budget_total_ms += budget_ms
	_budget_used_ms += (Time.get_ticks_usec() / 1000.0) - start_ms


# ─── Face Materials ──────────────────────────────────

## Apply per-face materials to an RSInstance.
## Faces with cached textures get real materials; uncached ones get placeholders and register in _tex_waiting.
func apply_face_materials(rsi, obj_uuid: String, faces: Array) -> void:
	rsi.set_material_override(null)
	var is_attachment: bool = sm.object_is_attachment.get(obj_uuid, false)
	var surface_count: int = rsi.mesh.get_surface_count() if rsi.mesh else 0
	# For animesh/flexi objects, the real mesh is on a MeshInstance3D, not the RSI (placeholder box).
	# Use the real mesh's surface count so we don't skip faces beyond the placeholder's 1 surface.
	var ami: MeshInstance3D = sm.animesh_mesh_instances.get(obj_uuid)
	if ami and ami.mesh:
		surface_count = maxi(surface_count, ami.mesh.get_surface_count())
	var fmi: MeshInstance3D = sm.flexi_mgr.GetMeshInstance(obj_uuid) if sm.flexi_params.has(obj_uuid) else null
	if fmi and fmi.mesh:
		surface_count = maxi(surface_count, fmi.mesh.get_surface_count())

	for fi: Dictionary in faces:
		var face_idx: int = int(fi.get("index", 0))
		var texture_id: String = str(fi.get("textureId", ""))
		var color: Array = fi.get("color", [1, 1, 1, 1])
		var full_bright: bool = fi.get("fullBright", false)
		var double_sided: bool = fi.get("doubleSided", false)
		var alpha_mode: int = int(fi.get("alphaMode", 0))
		var alpha_cutoff: float = float(fi.get("alphaCutoff", 0.5))
		var mapping_type: int = int(fi.get("mappingType", 0))
		var uv_info: Dictionary = {
			"repeatU": fi.get("repeatU", 1.0),
			"repeatV": fi.get("repeatV", 1.0),
			"offsetU": fi.get("offsetU", 0.0),
			"offsetV": fi.get("offsetV", 0.0),
			"texRotation": fi.get("rotation", 0.0)
		}

		# PBR fields — everything is PBR-shaped, always extract
		var pbr: Dictionary = {}
		if fi.has("normalTextureId"):
			pbr["normalTextureId"] = str(fi["normalTextureId"])
		if fi.has("ormTextureId"):
			pbr["ormTextureId"] = str(fi["ormTextureId"])
		if fi.has("emissiveTextureId"):
			pbr["emissiveTextureId"] = str(fi["emissiveTextureId"])
		if fi.has("emissiveFactor"):
			pbr["emissiveFactor"] = fi["emissiveFactor"]
		if fi.has("metallicFactor"):
			pbr["metallicFactor"] = float(fi["metallicFactor"])
		if fi.has("roughnessFactor"):
			pbr["roughnessFactor"] = float(fi["roughnessFactor"])

		if texture_id.is_empty():
			continue

		# Skip faces beyond the mesh's actual surface count
		if face_idx >= surface_count:
			continue

		# Collect all texture IDs this face needs (albedo + PBR textures)
		var all_tex_ids: Array = [texture_id]
		var normal_id: String = pbr.get("normalTextureId", "")
		var orm_id: String = pbr.get("ormTextureId", "")
		var emissive_id: String = pbr.get("emissiveTextureId", "")
		if not normal_id.is_empty():
			all_tex_ids.append(normal_id)
		if not orm_id.is_empty():
			all_tex_ids.append(orm_id)
		if not emissive_id.is_empty():
			all_tex_ids.append(emissive_id)

		# Check if albedo is cached (minimum requirement to apply any material)
		var albedo_cached: bool = sm.texture_cache.has(texture_id)

		# Electron-computed decisions
		var render_pri: int = int(fi.get("renderPriority", 0))
		var resolved_alpha: int = int(fi.get("resolvedAlphaMode", alpha_mode))
		var mat_key: String = str(fi.get("materialKey", ""))
		var mat: Material
		if albedo_cached:
			mat = _get_or_create_material(
				mat_key, texture_id, color, full_bright, double_sided, uv_info, resolved_alpha, alpha_cutoff, pbr, mapping_type, render_pri, is_attachment)
		else:
			mat = _make_placeholder_material(color, full_bright, double_sided)

		# if DebugLog.enabled("alpha"):
		# 	var rsi_sc: int = rsi.mesh.get_surface_count() if rsi.mesh else -1
		# 	var ami_sc: int = ami.mesh.get_surface_count() if (ami and ami.mesh) else -1
		# 	var rsi_will_set: bool = rsi.mesh != null and face_idx < rsi.mesh.get_surface_count()
		# 	var ami_will_set: bool = ami != null and ami.mesh != null and face_idx < ami.mesh.get_surface_count()
		# 	var mat_type: String = ""
		# 	if mat is StandardMaterial3D:
		# 		mat_type = "StdMat transp=%d albedo_a=%.3f" % [(mat as StandardMaterial3D).transparency, (mat as StandardMaterial3D).albedo_color.a]
		# 	elif mat is ShaderMaterial:
		# 		mat_type = "ShaderMat"
		# 	else:
		# 		mat_type = str(mat.get_class())
		# 	DebugLog.debug("alpha", "obj=%s face=%d tex=%s color=[%.2f,%.2f,%.2f,%.2f] resolved_alpha=%d attach=%s cached=%s key=%s rsi_sc=%d ami_sc=%d rsi_set=%s ami_set=%s mat=%s" % [
		# 		obj_uuid.substr(0, 8), face_idx, texture_id.substr(0, 8), color[0], color[1], color[2], color[3],
		# 		resolved_alpha, str(is_attachment), str(albedo_cached), mat_key.substr(0, 24),
		# 		rsi_sc, ami_sc, str(rsi_will_set), str(ami_will_set), mat_type])

		if rsi.mesh and face_idx < rsi.mesh.get_surface_count():
			rsi.set_surface_material(face_idx, mat)
		# Also apply to animesh MeshInstance3D if this object has one
		if ami and ami.mesh and face_idx < ami.mesh.get_surface_count():
			ami.set_surface_override_material(face_idx, mat)
		# Also apply to flexi prim MeshInstance3D if this object has one
		if fmi and fmi.mesh and face_idx < fmi.mesh.get_surface_count():
			fmi.set_surface_override_material(face_idx, mat)

		# Register under uncached texture IDs for re-apply when they load
		for tid: String in all_tex_ids:
			if not sm.texture_cache.has(tid) and not sm.texture_load_failed.has(tid):
				if not _tex_waiting.has(tid):
					_tex_waiting[tid] = []
				# Avoid duplicate entries
				if obj_uuid not in _tex_waiting[tid]:
					_tex_waiting[tid].append(obj_uuid)

	# Track transparency for occlusion culling. Transparent pick instances use a
	# depth_draw_never shader so they're occluded by solid geometry but can't occlude others.
	var has_transparency: bool = false
	for fi: Dictionary in faces:
		if int(fi.get("resolvedAlphaMode", int(fi.get("alphaMode", 0)))) > 0:
			has_transparency = true
			break
		var fc: Array = fi.get("color", [1, 1, 1, 1])
		if fc.size() >= 4 and float(fc[3]) < 0.99:
			has_transparency = true
			break
	if has_transparency:
		sm.object_picker._transparent_uuids[obj_uuid] = true
	else:
		sm.object_picker._transparent_uuids.erase(obj_uuid)


func _get_double_sided_shader(shader: Shader) -> Shader:
	if _double_sided_shader_cache.has(shader):
		return _double_sided_shader_cache[shader]
	var ds := Shader.new()
	ds.code = shader.code.replace("cull_back", "cull_disabled")
	_double_sided_shader_cache[shader] = ds
	return ds


func _get_or_create_material(key: String, texture_id: String, color: Array, full_bright: bool, double_sided: bool, uv_info: Dictionary = {}, alpha_mode: int = 0, alpha_cutoff: float = 0.5, pbr: Dictionary = {}, mapping_type: int = 0, render_priority: int = 0, is_attachment: bool = false) -> Material:
	_material_lookups += 1

	# Key fully computed by Electron (includes _ah suffix for attachments)
	var full_key: String = key

	if sm.material_cache.has(full_key):
		# if DebugLog.enabled("alpha") and color[3] < 1.0:
		# 	var cached_mat: Material = sm.material_cache[full_key]
		# 	var cached_info: String = ""
		# 	if cached_mat is StandardMaterial3D:
		# 		var cm := cached_mat as StandardMaterial3D
		# 		cached_info = "transp=%d albedo_a=%.3f" % [cm.transparency, cm.albedo_color.a]
		# 	DebugLog.debug("alpha", "CACHE HIT full_key=%s color[3]=%.3f -> %s" % [full_key.substr(0, 30), color[3], cached_info])
		return sm.material_cache[full_key]

	# alpha_mode is already the resolved mode (blend→opaque promotion done by Electron)
	var resolved_mode := alpha_mode

	# PBR params
	var normal_id: String = pbr.get("normalTextureId", "")
	var orm_id: String = pbr.get("ormTextureId", "")
	var emissive_id: String = pbr.get("emissiveTextureId", "")
	var metallic_factor: float = float(pbr.get("metallicFactor", 0.0))
	var roughness_factor: float = float(pbr.get("roughnessFactor", 1.0))
	var emissive_factor: Array = pbr.get("emissiveFactor", [0, 0, 0])

	# PBR texture cache keys (only include IDs of textures that are GPU-ready)
	var norm_key: String = normal_id if (not normal_id.is_empty() and sm.texture_cache.has(normal_id)) else ""
	var orm_key: String = orm_id if (not orm_id.is_empty() and sm.texture_cache.has(orm_id)) else ""
	var emis_key: String = emissive_id if (not emissive_id.is_empty() and sm.texture_cache.has(emissive_id)) else ""
	# Don't cache materials when referenced PBR textures aren't GPU-ready yet.
	# _tex_waiting will re-apply when they load, creating the final material.
	var _cacheable: bool = (norm_key == normal_id or normal_id.is_empty()) and (orm_key == orm_id or orm_id.is_empty()) and (emis_key == emissive_id or emissive_id.is_empty())

	# UV params
	var ru_val = uv_info.get("repeatU", 1.0)
	var ru: float = ru_val if ru_val != null else 1.0
	var rv_val = uv_info.get("repeatV", 1.0)
	var rv: float = rv_val if rv_val != null else 1.0
	var ou_val = uv_info.get("offsetU", 0.0)
	var ou: float = ou_val if ou_val != null else 0.0
	var ov_val = uv_info.get("offsetV", 0.0)
	var ov: float = ov_val if ov_val != null else 0.0
	var tr_val = uv_info.get("texRotation", 0.0)
	var tr: float = tr_val if tr_val != null else 0.0

	# Planar mapping uses a custom ShaderMaterial that implements SL's planarProjection()
	if mapping_type == 2:
		var mat := ShaderMaterial.new()
		# Color alpha (transparency slider) always wins — blend if color[3] < 1.0
		# Material alpha mode controls TEXTURE alpha interpretation, not color alpha
		var use_alpha: bool = color[3] < 1.0 or resolved_mode == 1
		var shader: Shader = PlanarMapAlphaShader if use_alpha else PlanarMapShader
		if double_sided:
			shader = _get_double_sided_shader(shader)
		mat.shader = shader
		mat.set_shader_parameter("albedo_tex", sm.texture_cache[texture_id])
		mat.set_shader_parameter("albedo_color", Color(color[0], color[1], color[2], color[3]))
		mat.set_shader_parameter("repeat_u", ru)
		mat.set_shader_parameter("repeat_v", rv)
		mat.set_shader_parameter("offset_u", ou)
		mat.set_shader_parameter("offset_v", ov)
		mat.set_shader_parameter("tex_rotation", tr)
		mat.set_shader_parameter("full_bright", full_bright)
		# Alpha scissor (opaque variant only — alpha variant uses smooth blending)
		if not use_alpha and resolved_mode == 2:
			mat.set_shader_parameter("alpha_scissor_threshold", alpha_cutoff)
		if render_priority != 0:
			mat.render_priority = render_priority
		if _cacheable:
			sm.material_cache[full_key] = mat
		sm.apply_debug_highlight_if_needed(mat)
		return mat

	# Texture rotation requires a custom shader (StandardMaterial3D has no rotation property)
	if abs(tr) > 0.001:
		var smat := ShaderMaterial.new()
		# Color alpha (transparency slider) always wins — blend if color[3] < 1.0
		var use_alpha: bool = color[3] < 1.0 or resolved_mode == 1
		var shader: Shader = StandardUVAlphaShader if use_alpha else StandardUVShader
		if double_sided:
			shader = _get_double_sided_shader(shader)
		smat.shader = shader
		smat.set_shader_parameter("albedo_tex", sm.texture_cache[texture_id])
		smat.set_shader_parameter("albedo_color", Color(color[0], color[1], color[2], color[3]))
		smat.set_shader_parameter("repeat_u", ru)
		smat.set_shader_parameter("repeat_v", rv)
		smat.set_shader_parameter("offset_u", ou)
		smat.set_shader_parameter("offset_v", ov)
		smat.set_shader_parameter("tex_rotation", tr)
		smat.set_shader_parameter("full_bright", full_bright)
		# Alpha scissor (opaque variant only — alpha variant uses smooth blending)
		if not use_alpha and resolved_mode == 2:
			smat.set_shader_parameter("alpha_scissor_threshold", alpha_cutoff)
		if render_priority != 0:
			smat.render_priority = render_priority
		if _cacheable:
			sm.material_cache[full_key] = smat
		sm.apply_debug_highlight_if_needed(smat)
		return smat

	var mat := StandardMaterial3D.new()
	mat.albedo_texture = sm.texture_cache[texture_id]
	mat.albedo_color = Color(color[0], color[1], color[2], color[3])

	# UV repeat and offset — SL's xform() centers at 0.5 before scaling:
	#   sl: uv = (uv - 0.5) * repeat + offset + 0.5
	# Mesh UVs have V flipped (Godot convention), so V offset sign is negated.
	mat.uv1_scale = Vector3(ru, rv, 1.0)
	mat.uv1_offset = Vector3(ou + 0.5 * (1.0 - ru), -ov + 0.5 * (1.0 - rv), 0.0)

	# Cull mode: double-sided disables backface culling
	if double_sided:
		mat.cull_mode = BaseMaterial3D.CULL_DISABLED

	# Alpha handling: 0=opaque, 1=blend, 2=mask (resolver always provides resolved value).
	# Attachments use ALPHA_HASH for correct depth sorting (Godot lacks per-triangle sort).
	# World objects use ALPHA for smooth glass/water blending.
	# TAA + FXAA smooth the hash dithering. Known limitation: near-opaque textures
	# (alpha ~0.95) show slight hash artifacts — dithered-texture preprocessing will fix this.
	if resolved_mode == 2:
		# GLTF MASK — alpha scissor with cutoff (also used for __invisible: cutoff=1.0)
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
		mat.alpha_scissor_threshold = alpha_cutoff
		DebugLog.debug("alpha", "SCISSOR key=%s cutoff=%.3f color_a=%.3f tex=%s" % [key.substr(0, 20), alpha_cutoff, color[3], texture_id.substr(0, 8)])
	elif color[3] < 1.0:
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	elif resolved_mode == 1:
		# Attachments use ALPHA_HASH for correct depth sorting (Godot lacks per-triangle sort).
		# World objects use ALPHA for smooth glass/water blending.
		if is_attachment:
			mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_HASH
		else:
			mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	# else: mode 0 (opaque) — no transparency pipeline overhead

	# Fullbright = unshaded
	if full_bright:
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED

	# --- Normal map (PBR and legacy materials) ---
	if not norm_key.is_empty():
		mat.normal_enabled = true
		mat.normal_texture = sm.texture_cache[normal_id]

	# --- Metallic / roughness (always applied — resolver provides defaults) ---
	mat.metallic = metallic_factor
	mat.roughness = roughness_factor

	# ORM texture (R=ambient occlusion, G=roughness, B=metallic) — glTF standard
	if not orm_key.is_empty():
		var orm_tex: Texture2D = sm.texture_cache[orm_id]
		mat.metallic_texture = orm_tex
		mat.metallic_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_BLUE
		mat.roughness_texture = orm_tex
		mat.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GREEN
		mat.ao_enabled = true
		mat.ao_texture = orm_tex
		mat.ao_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED

	# Emissive
	var ef: Array = emissive_factor
	var has_emission_factor: bool = float(ef[0]) > 0 or float(ef[1]) > 0 or float(ef[2]) > 0
	if has_emission_factor:
		mat.emission_enabled = true
		mat.emission = Color(ef[0], ef[1], ef[2])
		mat.emission_energy_multiplier = 1.0
	if not emis_key.is_empty():
		mat.emission_enabled = true
		mat.emission_texture = sm.texture_cache[emissive_id]

	if render_priority != 0:
		mat.render_priority = render_priority
	if _cacheable:
		sm.material_cache[full_key] = mat
	sm.apply_debug_highlight_if_needed(mat)
	return mat


func _make_placeholder_material(color: Array, full_bright: bool, double_sided: bool) -> StandardMaterial3D:
	# Cached solid-color placeholder shown while texture downloads
	var color_hex := Color(color[0], color[1], color[2], color[3]).to_html()
	var fb_str := "1" if full_bright else "0"
	var ds_str := "1" if double_sided else "0"
	var key := "%s_%s_%s" % [color_hex, fb_str, ds_str]

	if _placeholder_cache.has(key):
		return _placeholder_cache[key]

	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(color[0], color[1], color[2], color[3])

	if double_sided:
		mat.cull_mode = BaseMaterial3D.CULL_DISABLED

	if color[3] < 1.0:
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA

	if full_bright:
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED

	_placeholder_cache[key] = mat
	return mat


# ─── Eviction ────────────────────────────────────────

## Evict textures and meshes not referenced by any live object.
## Safe to call after region change or periodically during a session.
func evict_unused_assets() -> void:
	# Build set of texture IDs in use by live objects
	var tex_in_use: Dictionary = {}
	for faces: Array in sm.object_faces.values():
		for fi: Dictionary in faces:
			for key: String in ["textureId", "normalTextureId", "ormTextureId", "emissiveTextureId"]:
				var tid: String = str(fi.get(key, ""))
				if not tid.is_empty():
					tex_in_use[tid] = true

	# Evict unreferenced textures (skip in-flight)
	var evicted_tex: Array = []
	for tid: String in sm.texture_cache.keys():
		if not tex_in_use.has(tid) and not _texture_in_flight.has(tid):
			sm.texture_cache.erase(tid)
			evicted_tex.append(tid)

	# Evict materials whose albedo texture was evicted (key starts with textureId)
	if evicted_tex.size() > 0:
		var evicted_set: Dictionary = {}
		for tid: String in evicted_tex:
			evicted_set[tid] = true
		for key: String in sm.material_cache.keys().duplicate():
			if evicted_set.has(key.left(36)):
				sm.material_cache.erase(key)

	# Build set of mesh IDs in use by live objects
	var mesh_in_use: Dictionary = {}
	for mid: String in sm.object_mesh_id.values():
		mesh_in_use[mid] = true

	# Evict unreferenced meshes (skip in-flight)
	var evicted_mesh_count: int = 0
	for mid: String in sm.mesh_cache.keys():
		if not mesh_in_use.has(mid) and not _mesh_in_flight.has(mid):
			sm.mesh_cache.erase(mid)
			evicted_mesh_count += 1

	if evicted_tex.size() > 0 or evicted_mesh_count > 0:
		DebugLog.log("pipeline", "Evicted %d textures (%d materials), %d meshes" % [
			evicted_tex.size(), sm.material_cache.size(), evicted_mesh_count])


# ─── Stats ───────────────────────────────────────────

## Return stats dictionary for the Godot-side asset pipeline
func get_pipeline_stats() -> Dictionary:
	# Texture stats from our own thread pool
	_texture_queue_lock.lock()
	var tex_q := _texture_queue.size()
	_texture_queue_lock.unlock()
	_texture_results_lock.lock()
	var tex_ready := _texture_results.size()
	_texture_results_lock.unlock()

	# Mesh stats from WorkerThreadPool
	var mesh_ready := 0
	for task_id: int in _mesh_tasks:
		if WorkerThreadPool.is_task_completed(task_id):
			mesh_ready += 1

	# Compute budget averages and reset
	var n := maxf(_budget_samples, 1)
	var avg_elapsed := _budget_elapsed_ms / n
	var avg_budget := _budget_total_ms / n
	var avg_used := _budget_used_ms / n
	_budget_samples = 0
	_budget_elapsed_ms = 0.0
	_budget_total_ms = 0.0
	_budget_used_ms = 0.0

	# Per-step timing averages and reset
	_timing_lock.lock()
	var tc := maxi(_timing_count, 1)
	var avg_load := _timing_load_ms / tc
	var avg_mipmap := _timing_mipmap_ms / tc
	var avg_compress := _timing_compress_ms / tc
	var timing_n := _timing_count
	_timing_load_ms = 0.0
	_timing_mipmap_ms = 0.0
	_timing_compress_ms = 0.0
	_timing_count = 0
	_timing_lock.unlock()

	# Main-thread finalization timing averages and reset
	var ftc := maxi(_fin_tex_count, 1)
	var avg_tex_create := _fin_tex_create_ms / ftc
	var avg_tex_apply := _fin_tex_apply_ms / ftc
	var fin_tex_n := _fin_tex_count
	_fin_tex_create_ms = 0.0
	_fin_tex_apply_ms = 0.0
	_fin_tex_count = 0
	var fmc := maxi(_fin_mesh_count, 1)
	var avg_mesh_extract := _fin_mesh_extract_ms / fmc
	var avg_mesh_apply := _fin_mesh_apply_ms / fmc
	var fin_mesh_n := _fin_mesh_count
	_fin_mesh_extract_ms = 0.0
	_fin_mesh_apply_ms = 0.0
	_fin_mesh_count = 0

	return {
		"texWorkers": TEXTURE_THREAD_COUNT,
		"texReady": tex_ready,
		"texQueue": tex_q,
		"texTiming": "%.0f/%.0f/%.0fms load/mip/s3tc (n=%d)" % [avg_load, avg_mipmap, avg_compress, timing_n],
		"texDone": _tex_finalized_count,
		"texCached": sm.texture_cache.size(),
		"texFailed": sm.texture_load_failed.size(),
		"texPending": _tex_waiting.size(),
		"texFinalize": "%.2f/%.2fms create/apply (n=%d)" % [avg_tex_create, avg_tex_apply, fin_tex_n],
		"meshWorkers": _mesh_tasks.size(),
		"meshReady": mesh_ready,
		"meshQueue": _mesh_queue.size(),
		"meshDone": _mesh_finalized_count,
		"meshCached": sm.mesh_cache.size(),
		"meshFailed": sm.mesh_load_failed.size(),
		"meshPending": _waiting_for_mesh.size(),
		"meshFinalize": "%.2f/%.2fms extract/apply (n=%d)" % [avg_mesh_extract, avg_mesh_apply, fin_mesh_n],
		"budgetElapsed": avg_elapsed,
		"budgetAvail": avg_budget,
		"budgetUsed": avg_used,
		"objects": sm.objects.size(),
		"primShapes": sm.prim_generator.get_cache_size(),
		"avatars": sm.avatars.size(),
		"materials": sm.material_cache.size(),
		"materialLookups": _material_lookups,
		"materialReuse": _material_lookups - sm.material_cache.size(),
		"lightsActive": sm.light_mgr._light_count,
		"lightsTotal": sm.light_mgr._object_light_data.size(),
	}
