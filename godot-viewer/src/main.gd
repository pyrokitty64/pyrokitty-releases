extends Node3D

## Entry point: starts a TCP server, accepts a WebSocket connection,
## polls for JSON messages and dispatches them to SceneManager.

const FrameBudget = preload("res://src/frame_budget.gd")
const PanelManagerScript = preload("res://src/panel_manager.gd")

var tcp_server: TCPServer
var ws_peer: WebSocketPeer
var tcp_peer: StreamPeerTCP  # underlying TCP connection
var ws_port: int = 9200

@onready var scene_manager: Node3D = $SceneManager
@onready var _stats_bar: CanvasLayer = $StatsBar
@onready var _stats_label: RichTextLabel = $StatsBar/Label
var _stats_update_timer: float = 0.0
var _electron_stats: Dictionary = {}  # latest electron_stats from bridge

# Low-priority message backlog — object_create / mesh_ready / texture_ready etc.
# Avatar and identity messages bypass this queue and are always dispatched immediately.
var _low_priority_queue: Array[String] = []
var _vr_mode: bool = false
var _active_camera: Camera3D
var _window_bounds_timer: float = 0.0
var _last_window_pos: Vector2i = Vector2i(-99999, -99999)
var _last_window_size: Vector2i = Vector2i(-99999, -99999)

# Crash breadcrumb — written before each message is processed so we know
# what killed us if the process dies mid-message.
var _breadcrumb_path: String = ""
var _breadcrumb_file: FileAccess
var _msg_count: int = 0
var _frame_count: int = 0
var _ws_welcomed: bool = false
var _panel_manager: RefCounted = null

func write_breadcrumb(text: String) -> void:
	if _breadcrumb_file:
		_breadcrumb_file.seek(0)
		_breadcrumb_file.store_string("frame=%d %s\n" % [_frame_count, text])
		_breadcrumb_file.flush()

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		# Tell Electron to kill us (instant TerminateProcess) and also quit locally —
		# whichever wins, the process is dead.
		if ws_peer and ws_peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
			ws_peer.send_text('{"type":"quit"}')
			ws_peer.poll()  # flush the send buffer
		get_tree().quit()

func _exit_tree() -> void:
	if ws_peer:
		ws_peer.close()
		ws_peer = null
	tcp_peer = null
	if tcp_server:
		tcp_server.stop()
		tcp_server = null


func _ready() -> void:
	# We handle WM_CLOSE_REQUEST in _notification to send quit to Electron first
	get_tree().auto_accept_quit = false
	scene_manager.send_fn = send_message

	# Crash breadcrumb file — survives process death, tells us the last message processed
	_breadcrumb_path = OS.get_user_data_dir() + "/crash_breadcrumb.txt"
	_breadcrumb_file = FileAccess.open(_breadcrumb_path, FileAccess.WRITE)
	if _breadcrumb_file:
		_breadcrumb_file.store_string("Godot started at %s\n" % Time.get_datetime_string_from_system())
		_breadcrumb_file.flush()
		DebugLog.log("main", "Crash breadcrumb: %s" % _breadcrumb_path)

	# Log GPU info (VRAM total detection deferred — see TODO_VRAM_DETECTION.md)
	var _rd := RenderingServer.get_rendering_device()
	if _rd:
		print("[GPU] %s" % _rd.get_device_name())

	# Parse command-line args
	var args := OS.get_cmdline_user_args()
	var vr_requested := false
	var app_version := ""
	for i in range(args.size()):
		if args[i].begins_with("--ws-port="):
			ws_port = int(args[i].split("=")[1])
		elif args[i] == "--ws-port" and i + 1 < args.size():
			ws_port = int(args[i + 1])
		elif args[i].begins_with("--app-version="):
			app_version = args[i].split("=")[1]
		elif args[i] == "--vr":
			vr_requested = true

	if app_version != "":
		get_window().title = "3D View - PyroKitty %s" % app_version
	# Window size/position is now handled by Godot's built-in --resolution and
	# --position engine args (passed before -- by godot-bridge.ts), so the window
	# appears at the correct size/position before the scene loads.

	# Main._ready() runs after all children's _ready(), so camera_controller
	# and xr_rig are already initialised by the time we reach here.
	var camera_ctrl := get_node_or_null("Camera3D") as Camera3D
	var xr_rig := get_node_or_null("XROrigin3D")
	if not vr_requested:
		# openxr/enabled=true in project.godot auto-initialises OpenXR at startup.
		# Shut it down immediately when not in VR mode to suppress the
		# "No viewport marked with use_xr" spam.
		var xr_iface := XRServer.find_interface("OpenXR")
		if xr_iface and xr_iface.is_initialized():
			xr_iface.uninitialize()

	if vr_requested and camera_ctrl and xr_rig:
		var xr_interface := XRServer.find_interface("OpenXR")
		if xr_interface and xr_interface.initialize():
			# Wire up session-state signals so we can see if the pose is
			# rapidly cycling valid/invalid — the symptom of the Godot 4.6
			# OpenXR 1.1 / Meta runtime incompatibility (issue #114987).
			if xr_interface.has_signal("session_begun"):
				xr_interface.session_begun.connect(func(): DebugLog.log("xr", "session_begun"))
			if xr_interface.has_signal("session_stopping"):
				xr_interface.session_stopping.connect(func(): DebugLog.log("xr", "session_stopping"))
			if xr_interface.has_signal("session_focused"):
				xr_interface.session_focused.connect(func(): DebugLog.log("xr", "session_focused"))
			if xr_interface.has_signal("session_visible"):
				xr_interface.session_visible.connect(func(): DebugLog.log("xr", "session_visible"))
			_vr_mode = true
			# Disable vsync so OpenXR controls frame pacing via xrEndFrame().
			# With vsync on, Godot blocks waiting for the monitor flip (60Hz)
			# before submitting to OpenXR, which causes constant black frames
			# on a 90Hz headset.
			DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
			get_viewport().use_xr = true
			# MSAA's compute resolve pass requires TEXTURE_USAGE_STORAGE_BIT which
			# the XR swapchain images don't have — disable it for the XR viewport
			# to silence the rendering_device.cpp errors. Desktop keeps MSAA via
			# project.godot settings (only this viewport is affected).
			get_viewport().msaa_3d = Viewport.MSAA_DISABLED
			# TAA accumulates samples across frames — directly addresses temporal
			# sparkle on thin geometry (leaves, branches). Tradeoff: slight ghosting
			# on fast head movement. If ghosting is worse than sparkle, remove this
			# and restore FXAA below.
			# get_viewport().use_taa = true
			
			# FXAA is a screen-space fragment pass (no compute, no STORAGE_BIT)
			# so it works fine with the XR swapchain.
			# get_viewport().screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA

			# Supersample at 1.25x to reduce temporal sparkle on thin geometry
			# (leaf edges, branches). The compositor downsamples, averaging out
			# subpixel geometry that would otherwise flicker frame-to-frame.
			# Cost: ~55% more fill work. Tune down to 1.1 if GPU becomes a bottleneck.
			xr_interface.set_render_target_size_multiplier(1.5)

			# Use 72Hz — the lowest Quest 3 rate — for the largest frame budget (13.9ms).
			# Upgrade once rendering is consistently within the tighter 90Hz window.
			if xr_interface.has_method("set_display_refresh_rate"):
				xr_interface.set_display_refresh_rate(FrameBudget.VR_REFRESH_HZ)
			camera_ctrl.set_vr_mode(true)
			xr_rig.call("activate", camera_ctrl)
			# Match XR camera far plane to the object visibility range so they
			# can't diverge — depth precision is wasted beyond where objects exist.
			var xr_cam := xr_rig.get_node_or_null("XRCamera3D") as Camera3D
			if xr_cam:
				xr_cam.far = FrameBudget.VR_CAMERA_FAR
				xr_cam.current = true  # Ensure get_viewport().get_camera_3d() returns the XR camera
				_active_camera = xr_cam
			# Tighten the finalization budget to fit the 90Hz frame window
			if scene_manager and scene_manager.has_method("set_vr_mode"):
				scene_manager.set_vr_mode(true)
			# Hide self avatar in VR — you're inside it in first-person
			if scene_manager and scene_manager.has_method("set_first_person_mode"):
				scene_manager.set_first_person_mode(true)
			DebugLog.log("main", "OpenXR initialised -- VR mode active")
		else:
			DebugLog.warn("main", "OpenXR not available, falling back to desktop mode")

	if not _vr_mode and camera_ctrl:
		_active_camera = camera_ctrl
		# TAA: temporal anti-aliasing smooths jagged edges, specular shimmer,
		# and thin-geometry sparkle (leaves, wires, fences) across frames.
		get_viewport().use_taa = true
		get_viewport().screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA
		# GPU frame time measurement is toggled with the stats bar (Ctrl+Shift+1)
		RenderingServer.viewport_set_measure_render_time(get_viewport().get_viewport_rid(), _stats_bar.visible)

	# Panel manager — handles script dialogs, textboxes, etc.
	if _active_camera:
		_panel_manager = PanelManagerScript.new(scene_manager, _active_camera, send_message)

	tcp_server = TCPServer.new()
	var err := tcp_server.listen(ws_port, "127.0.0.1")
	if err != OK:
		DebugLog.error("main", "Failed to listen on port %d: %s" % [ws_port, error_string(err)])
		return

	DebugLog.log("main", "Listening on ws://127.0.0.1:%d" % ws_port)


func _process(_delta: float) -> void:
	_frame_count += 1
	write_breadcrumb("_process START msgs=%d queued=%d" % [_msg_count, _low_priority_queue.size()])

	# Panel manager (script dialogs etc.) — tick timers & position updates
	if _panel_manager:
		_panel_manager.process(_delta)

	# Consolidated stats: update label + console log every 1s
	_stats_update_timer += _delta
	if _stats_update_timer >= 1.0:
		_stats_update_timer = 0.0
		_update_stats_bar()

	# Report window bounds changes (debounced, every 0.5s max)
	_window_bounds_timer += _delta
	if _window_bounds_timer >= 0.5:
		_window_bounds_timer = 0.0
		var cur_pos := DisplayServer.window_get_position()
		var cur_size := DisplayServer.window_get_size()
		if cur_pos != _last_window_pos or cur_size != _last_window_size:
			_last_window_pos = cur_pos
			_last_window_size = cur_size
			if ws_peer and ws_peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
				send_message({
					"type": "window_bounds",
					"x": cur_pos.x, "y": cur_pos.y,
					"width": cur_size.x, "height": cur_size.y,
				})

	# Accept new TCP connection and upgrade to WebSocket
	if ws_peer == null and tcp_server and tcp_server.is_connection_available():
		tcp_peer = tcp_server.take_connection()
		ws_peer = WebSocketPeer.new()
		# Must be large enough to hold all data between poll() calls.
		# During initial snapshot (500+ objects + textures + events) the sender
		# can burst several MB before Godot's next _process frame.
		ws_peer.inbound_buffer_size = 16 * 1024 * 1024  # 16MB
		ws_peer.max_queued_packets = 65536
		var err := ws_peer.accept_stream(tcp_peer)
		if err != OK:
			DebugLog.error("main", "WebSocket accept failed: %s" % error_string(err))
			ws_peer = null
			tcp_peer = null
			return
		DebugLog.log("main", "WebSocket client connected")

	if ws_peer == null:
		return

	ws_peer.poll()

	var state := ws_peer.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		# Single unified budget covering both the packet drain and queue processing.
		# Previously only processing was budgeted; the drain loop allocated a string
		# per packet with no time limit, costing several ms during loading bursts.
		var _msg_budget: float = FrameBudget.DESKTOP_MSG_BUDGET_MS
		var _msg_start := Time.get_ticks_usec() / 1000.0

		# Drain backlog from previous frames FIRST to preserve message ordering.
		# New incoming messages are appended to the same queue so they always
		# execute after older messages.
		while ws_peer.get_available_packet_count() > 0:
			var text := ws_peer.get_packet().get_string_from_utf8()
			if _is_high_priority(text):
				_handle_message(text)
				continue
			_low_priority_queue.append(text)

		# Process queued messages in order (old backlog + newly arrived)
		while _low_priority_queue.size() > 0:
			if (Time.get_ticks_usec() / 1000.0) - _msg_start >= _msg_budget:
				break
			_handle_message(_low_priority_queue.pop_front())
	elif state == WebSocketPeer.STATE_CLOSING:
		pass  # Wait for close to complete
	elif state == WebSocketPeer.STATE_CLOSED:
		DebugLog.log("main", "WebSocket closed (code=%d)" % ws_peer.get_close_code())
		ws_peer = null
		tcp_peer = null

	write_breadcrumb("msgs_done total=%d queued=%d → scene_process" % [_msg_count, _low_priority_queue.size()])


func _update_stats_bar() -> void:
	var ap = scene_manager.asset_pipeline
	var fps := Engine.get_frames_per_second()
	var obj_count: int = scene_manager.objects.size()
	var avatar_count: int = scene_manager.avatars.size()
	var tex_cached: int = scene_manager.texture_cache.size()
	var tex_loading: int = (ap._texture_in_flight as Dictionary).size()
	var tex_waiting: int = (ap._tex_waiting as Dictionary).size()
	var tex_failed: int = scene_manager.texture_load_failed.size()
	var mesh_cached: int = scene_manager.mesh_cache.size()
	var mesh_loading: int = (ap._mesh_tasks as Dictionary).size()
	var mesh_pending: int = (ap._waiting_for_mesh as Dictionary).size()
	var mesh_failed: int = scene_manager.mesh_load_failed.size()
	var mat_count: int = scene_manager.material_cache.size()
	var msg_q := _low_priority_queue.size()
	var lights_active: int = scene_manager.light_mgr._light_count
	var lights_total: int = scene_manager.light_mgr._object_light_data.size()

	# VRAM usage
	var tex_mem: int = 0
	var buf_mem: int = 0
	var rd := RenderingServer.get_rendering_device()
	if rd:
		tex_mem = rd.get_memory_usage(RenderingDevice.MEMORY_TEXTURES)
		buf_mem = rd.get_memory_usage(RenderingDevice.MEMORY_BUFFERS)

	# Electron-side fetch queue stats
	var es := _electron_stats
	var es_tex: Dictionary = es.get("tex", {})
	var es_mesh: Dictionary = es.get("mesh", {})
	var es_sculpt: Dictionary = es.get("sculpt", {})
	var e_tex_q: int = int(es_tex.get("queue", 0))
	var e_tex_dl: int = int(es_tex.get("active", 0))
	var e_tex_dec: int = int(es_tex.get("decodeQueue", 0)) + int(es_tex.get("decodeActive", 0))
	var e_tex_gpu: int = int(es_tex.get("gpuQueue", 0)) + int(es_tex.get("gpuActive", 0))
	var e_tex_done: int = int(es_tex.get("done", 0))
	var e_tex_fail: int = int(es_tex.get("failed", 0))
	var e_mesh_q: int = int(es_mesh.get("queue", 0))
	var e_mesh_dl: int = int(es_mesh.get("active", 0))
	var e_mesh_done: int = int(es_mesh.get("done", 0))
	var e_mesh_fail: int = int(es_mesh.get("failed", 0))
	var e_sculpt_q: int = int(es_sculpt.get("queue", 0)) + int(es_sculpt.get("active", 0))
	var e_deferred: int = int(es.get("deferred", 0))

	# Per-subsystem timing (ms/frame averages, reset each stats update)
	var timing: Dictionary = scene_manager.get_process_timing()
	var t_terrain: float = timing.get("terrain", 0.0)
	var t_interp_av: float = timing.get("interpAv", 0.0)
	var t_interp_obj: float = timing.get("interpObj", 0.0)
	var t_anim: float = timing.get("anim", 0.0)
	var t_flexi: float = timing.get("flexi", 0.0)
	var t_bubbles: float = timing.get("bubbles", 0.0)
	var t_finalize: float = timing.get("finalize", 0.0)
	var t_total: float = t_terrain + t_interp_av + t_interp_obj + t_anim + t_flexi + t_bubbles + t_finalize
	var anim_roots: int = int(timing.get("animRoots", 0))
	var interp_targets: int = int(timing.get("interpTargets", 0))

	# BBCode color helpers
	const C_GREEN := "color=#88ee88"   # done / cached
	const C_YELLOW := "color=#eedd66"  # loading / in-flight
	const C_RED := "color=#ee6666"     # failed
	const C_BLUE := "color=#66aaee"    # deferred / waiting
	const C_WHITE := "color=#dddddd"   # labels
	const C_CYAN := "color=#66dddd"    # counts

	# GPU/render timing (read regardless of stats bar visibility for console log)
	var vp_rid := get_viewport().get_viewport_rid()
	var gpu_ms: float = RenderingServer.viewport_get_measured_render_time_gpu(vp_rid)
	var render_cpu_ms: float = RenderingServer.viewport_get_measured_render_time_cpu(vp_rid)

	# Update on-screen label (BBCode)
	if _stats_bar.visible:
		var bb := ""
		# FPS + scene
		bb += "[%s]FPS:[/color] [%s]%.0f[/color]  " % [C_WHITE, C_CYAN, fps]
		bb += "[%s]Obj:[/color] [%s]%d[/color]  " % [C_WHITE, C_CYAN, obj_count]
		bb += "[%s]Av:[/color] [%s]%d[/color]  " % [C_WHITE, C_CYAN, avatar_count]
		bb += "[%s]Lights:[/color] [%s]%d/%d[/color]  " % [C_WHITE, C_CYAN, lights_active, lights_total]
		bb += "[%s]VRAM:[/color] [%s]%.0fMB[/color]" % [C_WHITE, C_CYAN, (tex_mem + buf_mem) / 1048576.0]
		if scene_manager._occ_enabled:
			bb += "  [%s]Occ:[/color] [%s]%d vis %d hid %d avHid[/color]" % [C_WHITE, C_CYAN, scene_manager._occ_visible_ids.size(), scene_manager._occ_hidden_uuids.size(), scene_manager._occ_hidden_avatars.size()]
		bb += "  |  "
		# Textures — Godot side
		bb += "[%s]Tex:[/color] " % C_WHITE
		bb += "[%s]%d done[/color]  " % [C_GREEN, tex_cached]
		if tex_loading > 0:
			bb += "[%s]%d decoding[/color]  " % [C_YELLOW, tex_loading]
		if tex_waiting > 0:
			bb += "[%s]%d placeholder[/color]  " % [C_BLUE, tex_waiting]
		if tex_failed > 0:
			bb += "[%s]%d FAILED[/color]  " % [C_RED, tex_failed]
		# Textures — Electron side
		var e_tex_busy: int = e_tex_dl + e_tex_q + e_tex_dec + e_tex_gpu
		if e_tex_busy > 0 or e_tex_done > 0 or e_tex_fail > 0:
			bb += "[%s]DL:[/color] " % C_WHITE
			if e_tex_dl > 0:
				bb += "[%s]%d active[/color] " % [C_YELLOW, e_tex_dl]
			if e_tex_q > 0:
				bb += "[%s]%d queued[/color] " % [C_YELLOW, e_tex_q]
			if e_tex_dec > 0:
				bb += "[%s]%d dec[/color] " % [C_YELLOW, e_tex_dec]
			if e_tex_gpu > 0:
				bb += "[%s]%d gpu[/color] " % [C_YELLOW, e_tex_gpu]
			bb += "[%s]%d sent[/color] " % [C_GREEN, e_tex_done]
			if e_tex_fail > 0:
				bb += "[%s]%d fail[/color] " % [C_RED, e_tex_fail]
		bb += " |  "
		# Meshes — Godot side
		bb += "[%s]Mesh:[/color] " % C_WHITE
		bb += "[%s]%d done[/color]  " % [C_GREEN, mesh_cached]
		if mesh_loading > 0:
			bb += "[%s]%d decoding[/color]  " % [C_YELLOW, mesh_loading]
		if mesh_pending > 0:
			bb += "[%s]%d pending[/color]  " % [C_BLUE, mesh_pending]
		if mesh_failed > 0:
			bb += "[%s]%d FAILED[/color]  " % [C_RED, mesh_failed]
		# Meshes — Electron side
		var e_mesh_busy: int = e_mesh_dl + e_mesh_q + e_sculpt_q
		if e_mesh_busy > 0 or e_mesh_done > 0 or e_mesh_fail > 0:
			bb += "[%s]DL:[/color] " % C_WHITE
			if e_mesh_dl > 0:
				bb += "[%s]%d active[/color] " % [C_YELLOW, e_mesh_dl]
			if e_mesh_q > 0:
				bb += "[%s]%d queued[/color] " % [C_YELLOW, e_mesh_q]
			if e_sculpt_q > 0:
				bb += "[%s]%d sculpt[/color] " % [C_YELLOW, e_sculpt_q]
			bb += "[%s]%d sent[/color] " % [C_GREEN, e_mesh_done]
			if e_mesh_fail > 0:
				bb += "[%s]%d fail[/color] " % [C_RED, e_mesh_fail]
		bb += " |  "
		# Deferred + MsgQ
		if e_deferred > 0:
			bb += "[%s]Def:[/color] [%s]%d[/color]  " % [C_WHITE, C_BLUE, e_deferred]
		if msg_q > 0:
			bb += "[%s]MsgQ:[/color] [%s]%d[/color]" % [C_WHITE, C_YELLOW, msg_q]
		bb += "\n"
		# Per-subsystem timing
		bb += "[%s]GPU:[/color] [%s]%.1fms[/color]  " % [C_WHITE, C_CYAN, gpu_ms]
		bb += "[%s]RenderCPU:[/color] [%s]%.1fms[/color]  " % [C_WHITE, C_CYAN, render_cpu_ms]
		bb += "[%s]CPU:[/color] " % C_WHITE
		bb += "[%s]%.1fms[/color]  " % [C_CYAN, t_total]
		bb += "[%s]terrain=[/color][%s]%.2f[/color] " % [C_WHITE, C_CYAN, t_terrain]
		bb += "[%s]interp=[/color][%s]%.2f[/color](%da+%do) " % [C_WHITE, C_CYAN, t_interp_av + t_interp_obj, avatar_count, interp_targets]
		bb += "[%s]anim=[/color][%s]%.2f[/color](%d) " % [C_WHITE, C_CYAN, t_anim, anim_roots]
		if t_flexi > 0.01:
			bb += "[%s]flexi=[/color][%s]%.2f[/color] " % [C_WHITE, C_CYAN, t_flexi]
		bb += "[%s]bubbles=[/color][%s]%.2f[/color] " % [C_WHITE, C_CYAN, t_bubbles]
		bb += "[%s]finalize=[/color][%s]%.2f[/color]" % [C_WHITE, C_CYAN, t_finalize]
		_stats_label.text = bb

	# Console log (plain text, once per second)
	var tex_fail_str := ("  %d FAILED" % tex_failed) if tex_failed > 0 else ""
	var mesh_fail_str := ("  %d FAILED" % mesh_failed) if mesh_failed > 0 else ""
	var e_tex_fail_str := ("  %d FAIL" % e_tex_fail) if e_tex_fail > 0 else ""
	var e_mesh_fail_str := ("  %d FAIL" % e_mesh_fail) if e_mesh_fail > 0 else ""
	var occ_str := ""
	if scene_manager._occ_enabled:
		occ_str = " | Occ: %d vis %d hid %d avHid" % [scene_manager._occ_visible_ids.size(), scene_manager._occ_hidden_uuids.size(), scene_manager._occ_hidden_avatars.size()]
	print("[Stats] FPS: %.0f | GPU: %.1fms RenderCPU: %.1fms | Obj: %d Av: %d Lights: %d/%d Mat: %d | VRAM: tex=%.1fMB buf=%.1fMB%s | Tex: %d cached %d decoding %d placeholder%s [eDL:%d q:%d dec:%d gpu:%d done:%d%s] | Mesh: %d cached %d decoding %d pending%s [eDL:%d q:%d sculpt:%d done:%d%s] | Def: %d MsgQ: %d | CPU: %.1fms [terrain=%.2f interp=%.2f(%da+%do) anim=%.2f(%d) flexi=%.2f bubbles=%.2f final=%.2f]" % [
		fps, gpu_ms, render_cpu_ms, obj_count, avatar_count, lights_active, lights_total, mat_count,
		tex_mem / 1048576.0, buf_mem / 1048576.0, occ_str,
		tex_cached, tex_loading, tex_waiting, tex_fail_str,
		e_tex_dl, e_tex_q, e_tex_dec, e_tex_gpu, e_tex_done, e_tex_fail_str,
		mesh_cached, mesh_loading, mesh_pending, mesh_fail_str,
		e_mesh_dl, e_mesh_q, e_sculpt_q, e_mesh_done, e_mesh_fail_str,
		e_deferred, msg_q,
		t_total, t_terrain, t_interp_av + t_interp_obj, avatar_count, interp_targets,
		t_anim, anim_roots, t_flexi, t_bubbles, t_finalize])

## Classify a raw JSON string as high-priority without full parsing.
## Peeks at the first 40 bytes — enough to see any "type":"avatar_*" or "self_id".
## High-priority messages are dispatched immediately, bypassing the time-budgeted queue.
func _is_high_priority(text: String) -> bool:
	var prefix := text.left(40)
	return '"avatar_' in prefix or '"self_id"' in prefix or '"object_update_p' in prefix or '"sitting_state"' in prefix or '"electron_stats"' in prefix or '"pay_' in prefix or '"script_dialog"' in prefix or '"object_chat"' in prefix or '"teleport_' in prefix


func _handle_message(text: String) -> void:
	var json := JSON.new()
	var err := json.parse(text)
	if err != OK:
		DebugLog.warn("main", "Invalid JSON: %s" % text.left(200))
		return

	var msg: Dictionary = json.data
	var msg_type: String = msg.get("type", "")

	# Crash breadcrumb — write before processing so we know what killed us
	_msg_count += 1
	var uuid_str: String = str(msg.get("uuid", msg.get("id", ""))).left(8)
	var mesh_id_str: String = str(msg.get("meshId", "")).left(8)
	write_breadcrumb("msg#%d type=%s uuid=%s meshId=%s queued=%d" % [
		_msg_count, msg_type, uuid_str, mesh_id_str, _low_priority_queue.size()])

	match msg_type:
		"world_origin":
			scene_manager.set_world_origin(msg.get("originX", 0.0), msg.get("originY", 0.0))
		"region_change":
			scene_manager.handle_region_change()
		"self_id":
			scene_manager.set_self_avatar_id(msg.get("id", ""))
		"object_render":
			scene_manager.handle_object_render(msg)
		"object_update_batch", "object_update_physics":
			scene_manager.handle_object_update_batch(msg)
		"object_kill":
			scene_manager.handle_object_kill(msg)
		"avatar_create":
			scene_manager.handle_avatar_create(msg)
		"avatar_update":
			scene_manager.handle_avatar_update(msg)
		"avatar_update_batch":
			scene_manager.handle_avatar_update_batch(msg)
		"avatar_kill":
			scene_manager.handle_avatar_kill(msg)
		# mesh_ready / texture_ready removed — Electron sends paths in object_render
		"object_update_faces":
			scene_manager.handle_update_faces(msg)
		"object_update_faces_batch":
			scene_manager.handle_update_faces_batch(msg)
		"terrain_ready":
			scene_manager.handle_terrain_ready(msg)
		"environment_data":
			scene_manager.handle_environment_data(msg)
		"planar_debug":
			scene_manager.set_planar_debug_mode(msg.get("mode", 0))
		"object_properties":
			scene_manager.handle_object_properties(msg)
		"animations_batch":
			scene_manager.handle_animations_batch(msg)
		"sitting_state":
			var camera_ctrl := get_node_or_null("Camera3D")
			if camera_ctrl and camera_ctrl.has_method("set_sitting"):
				camera_ctrl.set_sitting(msg.get("sitting", false))
		"avatar_shape":
			scene_manager.handle_avatar_shape(msg)
		"avatar_chat":
			scene_manager.handle_avatar_chat(msg)
		"avatar_typing":
			scene_manager.handle_avatar_typing(msg)
		"object_chat":
			scene_manager.handle_object_chat(msg)
		"settings":
			scene_manager.handle_settings(msg)
		"electron_stats":
			_electron_stats = msg
		"pay_options", "pay_result":
			var camera_ctrl := get_node_or_null("Camera3D")
			if camera_ctrl and camera_ctrl.has_method("handle_pay_message"):
				camera_ctrl.handle_pay_message(msg)
		"script_dialog":
			if _panel_manager:
				_panel_manager.handle_script_dialog(msg)
		"teleport_offer":
			if _panel_manager:
				_panel_manager.handle_teleport_offer(msg)
		_:
			DebugLog.warn("main", "Unknown message type: %s" % msg_type)


func _unhandled_key_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		if event.keycode == KEY_1 and event.ctrl_pressed and event.shift_pressed:
			_stats_bar.visible = not _stats_bar.visible
			RenderingServer.viewport_set_measure_render_time(get_viewport().get_viewport_rid(), _stats_bar.visible)
			scene_manager.toggle_debug_skeleton()
			scene_manager.toggle_pick_debug()
		elif event.keycode == KEY_F11:
			scene_manager.toggle_occlusion_culling()

func send_message(msg: Dictionary) -> void:
	if ws_peer and ws_peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		ws_peer.send_text(JSON.stringify(msg))
	elif msg.get("type") == "input_move":
		var state := "null" if not ws_peer else str(ws_peer.get_ready_state())
		DebugLog.log("main", "DROP input_move -- ws not open (state=%s)" % state)
