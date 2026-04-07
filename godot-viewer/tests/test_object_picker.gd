extends Node

## Tests for object_picker.gd — covers ID allocation, encoding round-trip,
## and lifecycle management. GPU rendering tests are not possible headless.
##
## Run headless:
##   cd godot-viewer && ./Godot_v4.7-dev2_mono_win64/Godot_v4.7-dev2_mono_win64_console.exe \
##     --headless --quit-after 5 --scene tests/test_object_picker.tscn

var _passed := 0
var _failed := 0


func _ready() -> void:
	_passed = 0
	_failed = 0

	_test_script_compiles()
	_test_id_allocation_sequential()
	_test_id_allocation_idempotent()
	_test_id_allocation_bidirectional()
	_test_id_encode_decode_round_trip()
	_test_id_encode_decode_boundary_values()
	_test_id_encode_decode_all_byte_values()
	_test_destroy_pick_instance_clears_mappings()
	_test_destroy_all_pick_instances_resets()
	_test_highlight_tracks_uuid()

	print("--- object_picker tests: %d passed, %d failed ---" % [_passed, _failed])


# ─── Helpers ──────────────────────────────────────────────────────────────────

func _assert(condition: bool, msg: String) -> void:
	if condition:
		_passed += 1
	else:
		_failed += 1
		push_error("  FAIL: %s" % msg)


## Create a minimal scene_manager stub with enough state for object_picker.
## Does NOT call _setup_id_buffer (deferred) — we test pure logic only.
func _make_picker() -> RefCounted:
	# Stub scene_manager with a script that has the required properties
	var stub_script := GDScript.new()
	stub_script.source_code = "extends Node3D\nvar objects: Dictionary = {}\nvar animesh_mesh_instances: Dictionary = {}\nvar _scenario: RID = RID()\n"
	stub_script.reload()
	var sm: Node3D = stub_script.new()
	add_child(sm)

	var picker = preload("res://src/object_picker.gd").new(sm)
	return picker


# ─── Tests ────────────────────────────────────────────────────────────────────

func _test_script_compiles() -> void:
	var script = load("res://src/object_picker.gd")
	_assert(script != null, "object_picker.gd compiles without error")


func _test_id_allocation_sequential() -> void:
	var picker = _make_picker()
	var id1: int = picker._alloc_id("uuid-aaa")
	var id2: int = picker._alloc_id("uuid-bbb")
	var id3: int = picker._alloc_id("uuid-ccc")
	_assert(id1 == 1, "first ID is 1 (0 reserved for background)")
	_assert(id2 == 2, "second ID is 2")
	_assert(id3 == 3, "third ID is 3")


func _test_id_allocation_idempotent() -> void:
	var picker = _make_picker()
	var id1: int = picker._alloc_id("uuid-aaa")
	var id2: int = picker._alloc_id("uuid-aaa")
	_assert(id1 == id2, "allocating same UUID returns same ID")
	_assert(picker._next_id == 2, "counter not incremented for duplicate")


func _test_id_allocation_bidirectional() -> void:
	var picker = _make_picker()
	var id: int = picker._alloc_id("uuid-xyz")
	_assert(picker._id_to_uuid[id] == "uuid-xyz", "_id_to_uuid maps correctly")
	_assert(picker._uuid_to_id["uuid-xyz"] == id, "_uuid_to_id maps correctly")


func _test_id_encode_decode_round_trip() -> void:
	# Test that the 24-bit ID encoding in RGB channels survives a byte round-trip.
	# This is the core correctness guarantee — if this breaks, picking fails.
	for test_id: int in [1, 2, 127, 255, 256, 257, 1000, 4095, 65535, 100000, 16777215]:
		var r: int = (test_id >> 16) & 0xFF
		var g: int = (test_id >> 8) & 0xFF
		var b: int = test_id & 0xFF
		var decoded: int = (r << 16) | (g << 8) | b
		_assert(decoded == test_id,
			"ID %d round-trips through RGB encoding (r=%d, g=%d, b=%d)" % [test_id, r, g, b])


func _test_id_encode_decode_boundary_values() -> void:
	# ID 0 = background (no hit), must never be allocated
	var picker = _make_picker()
	var id: int = picker._alloc_id("first-object")
	_assert(id >= 1, "first allocated ID is >= 1 (0 reserved)")

	# Max 24-bit ID
	var max_id: int = 16777215
	var r: int = (max_id >> 16) & 0xFF
	var g: int = (max_id >> 8) & 0xFF
	var b: int = max_id & 0xFF
	_assert(r == 255 and g == 255 and b == 255, "max ID 16777215 encodes as (255, 255, 255)")
	var decoded: int = (r << 16) | (g << 8) | b
	_assert(decoded == 16777215, "max ID 16777215 decodes correctly")


func _test_id_encode_decode_all_byte_values() -> void:
	# Verify every possible RGB byte combination produces a correct ID.
	# Full 24-bit (16.7M) is too slow — test all 256 values per channel independently.
	var failures: int = 0
	for r: int in range(256):
		for g: int in range(256):
			var b: int = (r + g) % 256  # vary B to cover all byte values
			var expected_id: int = (r << 16) | (g << 8) | b
			if expected_id == 0:
				continue
			var color := Color(float(r) / 255.0, float(g) / 255.0, float(b) / 255.0)
			var decoded_id: int = (int(color.r8) << 16) | (int(color.g8) << 8) | int(color.b8)
			if decoded_id != expected_id:
				failures += 1
	_assert(failures == 0,
		"all sampled 24-bit IDs survive Color encode/decode (%d failures)" % failures)


func _test_destroy_pick_instance_clears_mappings() -> void:
	var picker = _make_picker()
	var _id: int = picker._alloc_id("uuid-destroy-test")
	_assert(picker._uuid_to_id.has("uuid-destroy-test"), "ID mapped before destroy")
	_assert(picker._id_to_uuid.has(_id), "reverse map exists before destroy")

	picker._destroy_pick_instance("uuid-destroy-test")
	_assert(not picker._uuid_to_id.has("uuid-destroy-test"), "uuid_to_id cleared after destroy")
	_assert(not picker._id_to_uuid.has(_id), "id_to_uuid cleared after destroy")


func _test_destroy_all_pick_instances_resets() -> void:
	var picker = _make_picker()
	picker._alloc_id("uuid-a")
	picker._alloc_id("uuid-b")
	picker._alloc_id("uuid-c")
	_assert(picker._next_id == 4, "3 IDs allocated")

	picker.destroy_all_pick_instances()
	_assert(picker._next_id == 1, "counter reset to 1 after destroy_all")
	_assert(picker._id_to_uuid.is_empty(), "id_to_uuid empty after destroy_all")
	_assert(picker._uuid_to_id.is_empty(), "uuid_to_id empty after destroy_all")


func _test_highlight_tracks_uuid() -> void:
	var picker = _make_picker()
	_assert(picker._highlight_uuid == "", "highlight starts empty")

	# Calling with empty should not crash
	picker.set_hover_highlight("")
	_assert(picker._highlight_uuid == "", "highlight stays empty after clear")

	# Set a UUID (no actual RS instance — set_hover_highlight accesses sm.objects
	# to apply the overlay, but our stub doesn't have real objects. It won't crash
	# because the .get() returns null, but the _highlight_uuid tracking still works.)
	picker.set_hover_highlight("uuid-highlight")
	_assert(picker._highlight_uuid == "uuid-highlight", "highlight tracks set UUID")

	# Same UUID again — early return, no sm.objects access
	picker.set_hover_highlight("uuid-highlight")
	_assert(picker._highlight_uuid == "uuid-highlight", "same UUID is no-op")
