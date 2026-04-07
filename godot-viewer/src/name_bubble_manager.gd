extends RefCounted

## Avatar name bubbles — 2D screen-space overlay projected from head bone.
## Renders as native UI on a CanvasLayer, completely bypassing TAA.
##
## Why 2D instead of 3D (Label3D / Sprite3D)?
## TAA motion vectors don't account for billboard rotation, so any 3D billboard
## text gets smeared during camera movement. Every alpha_cut mode also fights
## with TAA differently (DISCARD flickers, OPAQUE_PREPASS fades, DISABLED blurs).
## Multiple 3D nodes (text + background) z-fight because both are depth-test-disabled.
## 2D CanvasLayer renders after all 3D post-processing — zero TAA interaction,
## pixel-perfect text, no z-fighting. See docs/architecture/name-bubbles.md.

var sm  # scene_manager reference
var _canvas_layer: CanvasLayer
var _container: Control

var _avatar_names: Dictionary = {}       # avatarId -> String
var _panels: Dictionary = {}             # avatarId -> PanelContainer
var _text_labels: Dictionary = {}        # avatarId -> Label
var _chat_state: Dictionary = {}         # avatarId -> { text: String, time_left: float }
var _typing_state: Dictionary = {}       # avatarId -> bool
var _head_bone_idx: Dictionary = {}      # avatarId -> int

# Object chat bubbles (chat-only, no persistent name label)
var _obj_panels: Dictionary = {}         # objectId -> PanelContainer
var _obj_text_labels: Dictionary = {}    # objectId -> Label
var _obj_chat_state: Dictionary = {}     # objectId -> { text: String, time_left: float, name: String }

const CHAT_DISPLAY_TIME: float = 12.0
const BUBBLE_OFFSET_Y: float = 0.28
const MAX_CHAT_LINES: int = 3
const FONT_SIZE: int = 14
const REF_DISTANCE: float = 5.0  # distance where scale = 1.0

var _typing_anim_timer: float = 0.0
const TYPING_ANIM_INTERVAL: float = 0.5
var _typing_dot_count: int = 1


func _init(scene_manager) -> void:
	sm = scene_manager
	_canvas_layer = CanvasLayer.new()
	_canvas_layer.layer = 100
	_container = Control.new()
	_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_container.set_anchors_preset(Control.PRESET_FULL_RECT)
	_canvas_layer.add_child(_container)
	sm.add_child.call_deferred(_canvas_layer)


func on_avatar_created(avatar_id: String, display_name: String) -> void:
	_avatar_names[avatar_id] = _clean_name(display_name)
	_create_panel(avatar_id)


func on_avatar_killed(avatar_id: String) -> void:
	_avatar_names.erase(avatar_id)
	_chat_state.erase(avatar_id)
	_typing_state.erase(avatar_id)
	_head_bone_idx.erase(avatar_id)
	_text_labels.erase(avatar_id)
	if _panels.has(avatar_id):
		var panel: PanelContainer = _panels[avatar_id]
		if is_instance_valid(panel):
			panel.queue_free()
		_panels.erase(avatar_id)


func on_avatar_chat(avatar_id: String, message: String) -> void:
	_typing_state[avatar_id] = false
	var display_msg: String = message
	if message.begins_with("/me ") or message == "/me":
		var name_str: String = _avatar_names.get(avatar_id, "")
		display_msg = name_str + message.substr(3)
	_chat_state[avatar_id] = { "text": display_msg, "time_left": CHAT_DISPLAY_TIME }
	_rebuild_text(avatar_id)


func on_avatar_typing(avatar_id: String, is_typing: bool) -> void:
	_typing_state[avatar_id] = is_typing
	_rebuild_text(avatar_id)


func on_avatar_name_updated(avatar_id: String, display_name: String) -> void:
	_avatar_names[avatar_id] = _clean_name(display_name)
	_rebuild_text(avatar_id)


func on_object_chat(object_id: String, message: String, object_name: String) -> void:
	var display_msg: String = message
	if message.begins_with("/me ") or message == "/me":
		display_msg = object_name + message.substr(3)
	_obj_chat_state[object_id] = { "text": display_msg, "time_left": CHAT_DISPLAY_TIME, "name": object_name }
	_ensure_obj_panel(object_id)
	_rebuild_obj_text(object_id)


func on_object_killed(object_id: String) -> void:
	_obj_chat_state.erase(object_id)
	_obj_text_labels.erase(object_id)
	if _obj_panels.has(object_id):
		var panel: PanelContainer = _obj_panels[object_id]
		if is_instance_valid(panel):
			panel.queue_free()
		_obj_panels.erase(object_id)


func process(delta: float, camera: Camera3D) -> void:
	if camera == null:
		return

	# Typing dot animation
	_typing_anim_timer += delta
	var typing_changed := false
	if _typing_anim_timer >= TYPING_ANIM_INTERVAL:
		_typing_anim_timer -= TYPING_ANIM_INTERVAL
		_typing_dot_count = (_typing_dot_count % 3) + 1
		typing_changed = true

	# Fade chat timers
	var to_clear: Array[String] = []
	for avatar_id: String in _chat_state:
		var state: Dictionary = _chat_state[avatar_id]
		state["time_left"] -= delta
		if state["time_left"] <= 0.0:
			to_clear.append(avatar_id)

	for avatar_id: String in to_clear:
		_chat_state.erase(avatar_id)
		_rebuild_text(avatar_id)

	if typing_changed:
		for avatar_id: String in _typing_state:
			if _typing_state[avatar_id]:
				_rebuild_text(avatar_id)

	# Project head positions to screen and position panels
	for avatar_id: String in _panels:
		var panel: PanelContainer = _panels[avatar_id]
		if not is_instance_valid(panel):
			continue

		var skel: Skeleton3D = sm.animesh_shared_skeleton.get(avatar_id)
		if skel == null or not is_instance_valid(skel):
			panel.visible = false
			continue

		if not _head_bone_idx.has(avatar_id):
			var idx: int = skel.find_bone("mHead")
			if idx < 0:
				panel.visible = false
				continue
			_head_bone_idx[avatar_id] = idx

		var head_idx: int = _head_bone_idx[avatar_id]
		var head_local: Vector3 = skel.get_bone_global_pose(head_idx).origin + skel.position
		var avatar_node: Node3D = sm.animesh_roots.get(avatar_id)
		if avatar_node == null or not is_instance_valid(avatar_node):
			panel.visible = false
			continue

		var head_world: Vector3 = avatar_node.global_transform * (head_local + Vector3(0, BUBBLE_OFFSET_Y, 0))

		var distance: float = camera.global_position.distance_to(head_world)
		if distance > sm._vis_far:
			panel.visible = false
			continue

		# Behind camera check
		if camera.is_position_behind(head_world):
			panel.visible = false
			continue

		var screen_pos: Vector2 = camera.unproject_position(head_world)

		# Non-linear scale: stays larger at moderate distances
		var s: float = clampf(sqrt(REF_DISTANCE / maxf(distance, 0.5)), 0.3, 1.5)
		panel.scale = Vector2(s, s)

		# Center panel horizontally on the projected point, anchor bottom to it
		panel.position = Vector2(screen_pos.x - panel.size.x * s * 0.5, screen_pos.y - panel.size.y * s)

		# Fade when chat is about to expire
		if _chat_state.has(avatar_id):
			var time_left: float = _chat_state[avatar_id]["time_left"]
			if time_left < 3.0:
				panel.modulate.a = clampf(time_left / 3.0, 0.0, 1.0)
			else:
				panel.modulate.a = 1.0
		else:
			panel.modulate.a = 1.0

		panel.visible = true

	# --- Object chat bubbles ---
	var obj_to_clear: Array[String] = []
	for object_id: String in _obj_chat_state:
		var state: Dictionary = _obj_chat_state[object_id]
		state["time_left"] -= delta
		if state["time_left"] <= 0.0:
			obj_to_clear.append(object_id)

	for object_id: String in obj_to_clear:
		_obj_chat_state.erase(object_id)
		# Remove panel entirely — objects only show bubbles while chatting
		on_object_killed(object_id)

	for object_id: String in _obj_panels:
		var panel: PanelContainer = _obj_panels[object_id]
		if not is_instance_valid(panel):
			continue

		var rsi = sm.objects.get(object_id)
		if rsi == null:
			panel.visible = false
			continue

		# Position bubble above the object (use half scale Y as height estimate)
		var obj_world: Vector3 = rsi.pos + Vector3(0, rsi.scl.y * 0.5 + 0.3, 0)
		var distance: float = camera.global_position.distance_to(obj_world)

		if distance > sm._vis_far or camera.is_position_behind(obj_world):
			panel.visible = false
			continue

		var screen_pos: Vector2 = camera.unproject_position(obj_world)
		var s: float = clampf(sqrt(REF_DISTANCE / maxf(distance, 0.5)), 0.3, 1.5)
		panel.scale = Vector2(s, s)
		panel.position = Vector2(screen_pos.x - panel.size.x * s * 0.5, screen_pos.y - panel.size.y * s)

		if _obj_chat_state.has(object_id):
			var time_left: float = _obj_chat_state[object_id]["time_left"]
			if time_left < 3.0:
				panel.modulate.a = clampf(time_left / 3.0, 0.0, 1.0)
			else:
				panel.modulate.a = 1.0

		panel.visible = true


func _create_panel(avatar_id: String) -> void:
	if _panels.has(avatar_id):
		var old: PanelContainer = _panels[avatar_id]
		if is_instance_valid(old):
			old.queue_free()

	var panel := PanelContainer.new()
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.0, 0.0, 0.0, 0.55)
	style.set_corner_radius_all(8)
	style.content_margin_left = 10
	style.content_margin_right = 10
	style.content_margin_top = 4
	style.content_margin_bottom = 4
	panel.add_theme_stylebox_override("panel", style)

	var text_label := Label.new()
	text_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	text_label.add_theme_color_override("font_color", Color(1.0, 1.0, 1.0, 0.95))
	text_label.add_theme_font_size_override("font_size", FONT_SIZE)
	text_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	text_label.text = _avatar_names.get(avatar_id, "")
	panel.add_child(text_label)

	panel.visible = false
	_container.add_child(panel)

	_panels[avatar_id] = panel
	_text_labels[avatar_id] = text_label


func _rebuild_text(avatar_id: String) -> void:
	var text_label: Label = _text_labels.get(avatar_id)
	if text_label == null or not is_instance_valid(text_label):
		return

	var parts: PackedStringArray = []
	parts.append(_avatar_names.get(avatar_id, ""))

	if _chat_state.has(avatar_id):
		var msg: String = _chat_state[avatar_id]["text"]
		if msg.length() > 200:
			msg = msg.left(200) + "..."
		msg = _word_wrap(msg, 60)
		var lines: PackedStringArray = msg.split("\n")
		if lines.size() > MAX_CHAT_LINES:
			for i in range(lines.size() - MAX_CHAT_LINES, lines.size()):
				parts.append(lines[i])
		else:
			parts.append(msg)

	if _typing_state.get(avatar_id, false):
		parts.append(".".repeat(_typing_dot_count))

	text_label.text = "\n".join(parts)


func _word_wrap(text: String, width: int) -> String:
	if text.length() <= width:
		return text
	var result := ""
	var line := ""
	for word: String in text.split(" "):
		if line.is_empty():
			line = word
		elif (line.length() + 1 + word.length()) > width:
			result += line + "\n"
			line = word
		else:
			line += " " + word
	if not line.is_empty():
		result += line
	return result


func _clean_name(display_name: String) -> String:
	if display_name.ends_with(" Resident"):
		return display_name.left(display_name.length() - 9)
	return display_name


func _ensure_obj_panel(object_id: String) -> void:
	if _obj_panels.has(object_id):
		return

	var panel := PanelContainer.new()
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.0, 0.0, 0.0, 0.55)
	style.set_corner_radius_all(8)
	style.content_margin_left = 10
	style.content_margin_right = 10
	style.content_margin_top = 4
	style.content_margin_bottom = 4
	panel.add_theme_stylebox_override("panel", style)

	var text_label := Label.new()
	text_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	text_label.add_theme_color_override("font_color", Color(1.0, 1.0, 1.0, 0.95))
	text_label.add_theme_font_size_override("font_size", FONT_SIZE)
	text_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(text_label)

	panel.visible = false
	_container.add_child(panel)

	_obj_panels[object_id] = panel
	_obj_text_labels[object_id] = text_label


func _rebuild_obj_text(object_id: String) -> void:
	var text_label: Label = _obj_text_labels.get(object_id)
	if text_label == null or not is_instance_valid(text_label):
		return

	if not _obj_chat_state.has(object_id):
		text_label.text = ""
		return

	var state: Dictionary = _obj_chat_state[object_id]
	var parts: PackedStringArray = []
	parts.append(state["name"])

	var msg: String = state["text"]
	if msg.length() > 200:
		msg = msg.left(200) + "..."
	msg = _word_wrap(msg, 60)
	var lines: PackedStringArray = msg.split("\n")
	if lines.size() > MAX_CHAT_LINES:
		for i in range(lines.size() - MAX_CHAT_LINES, lines.size()):
			parts.append(lines[i])
	else:
		parts.append(msg)

	text_label.text = "\n".join(parts)
