extends RefCounted

## Toast-style notification panel — compact bottom-right card with action buttons.
##
## Used for teleport offers, friend requests, group invites, and other
## actionable notifications that shouldn't block the view.

signal action_pressed(notification_id: String, action_name: String)
signal dismissed(notification_id: String)

var notification_id: String
var panel: PanelContainer

var _timer: float = 0.0
var _timeout: float = 60.0

const MAX_WIDTH: float = 320.0


func _init(p_id: String, title: String, message: String,
		actions: Array, p_timeout: float = 60.0) -> void:
	notification_id = p_id
	_timeout = p_timeout
	_build_ui(title, message, actions)


func process(delta: float) -> void:
	_timer += delta
	if _timer >= _timeout:
		dismissed.emit(notification_id)


func _build_ui(title: String, message: String, actions: Array) -> void:
	panel = PanelContainer.new()
	panel.mouse_filter = Control.MOUSE_FILTER_STOP
	panel.custom_minimum_size = Vector2(260, 0)

	var bg := StyleBoxFlat.new()
	bg.bg_color = Color(0.10, 0.10, 0.14, 0.95)
	bg.corner_radius_top_left = 6
	bg.corner_radius_top_right = 6
	bg.corner_radius_bottom_left = 6
	bg.corner_radius_bottom_right = 6
	bg.content_margin_left = 10
	bg.content_margin_right = 10
	bg.content_margin_top = 8
	bg.content_margin_bottom = 8
	bg.border_width_left = 2
	bg.border_color = Color(0.35, 0.55, 0.80, 0.8)
	panel.add_theme_stylebox_override("panel", bg)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 4)
	panel.add_child(vbox)

	# Title (bold-ish, white)
	var title_label := Label.new()
	title_label.text = title
	title_label.add_theme_color_override("font_color", Color(0.9, 0.9, 0.95))
	title_label.add_theme_font_size_override("font_size", 13)
	vbox.add_child(title_label)

	# Message (smaller, wrapping)
	if not message.is_empty():
		var msg_label := Label.new()
		msg_label.text = message
		msg_label.add_theme_color_override("font_color", Color(0.7, 0.7, 0.75))
		msg_label.add_theme_font_size_override("font_size", 12)
		msg_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		msg_label.custom_minimum_size = Vector2(240, 0)
		vbox.add_child(msg_label)

	# Action buttons row
	if not actions.is_empty():
		var hbox := HBoxContainer.new()
		hbox.add_theme_constant_override("separation", 4)
		hbox.alignment = BoxContainer.ALIGNMENT_END
		vbox.add_child(hbox)

		for action: Dictionary in actions:
			var btn := Button.new()
			btn.text = str(action.get("label", ""))
			btn.custom_minimum_size = Vector2(60, 26)
			btn.add_theme_font_size_override("font_size", 12)
			var color: Color = action.get("color", Color(0.20, 0.28, 0.40))
			var hover: Color = action.get("hover", color.lightened(0.3))
			_style_button(btn, color, hover)
			var action_name: String = str(action.get("name", ""))
			btn.pressed.connect(func(): action_pressed.emit(notification_id, action_name))
			hbox.add_child(btn)


func _style_button(btn: Button, normal_color: Color, hover_color: Color) -> void:
	var ns := StyleBoxFlat.new()
	ns.bg_color = normal_color
	ns.set_corner_radius_all(4)
	var hs := ns.duplicate() as StyleBoxFlat
	hs.bg_color = hover_color
	var ps := ns.duplicate() as StyleBoxFlat
	ps.bg_color = normal_color.darkened(0.2)
	btn.add_theme_stylebox_override("normal", ns)
	btn.add_theme_stylebox_override("hover", hs)
	btn.add_theme_stylebox_override("pressed", ps)
	btn.add_theme_color_override("font_color", Color(0.9, 0.9, 0.95))
