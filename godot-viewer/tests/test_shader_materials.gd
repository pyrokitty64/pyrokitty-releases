extends Node3D

## Tests for shader variant selection and material creation in asset_pipeline.gd.
## Validates: shader compilation, opaque/alpha variant picking, double-sided caching.
## Run: --headless --quit-after 5 --scene tests/test_shader_materials.tscn

const AssetPipelineScript = preload("res://src/asset_pipeline.gd")
const PlanarMapShader = preload("res://src/planar_map.gdshader")
const PlanarMapAlphaShader = preload("res://src/planar_map_alpha.gdshader")
const StandardUVShader = preload("res://src/standard_uv.gdshader")
const StandardUVAlphaShader = preload("res://src/standard_uv_alpha.gdshader")

var ap: RefCounted  # asset_pipeline instance
var _passed := 0
var _failed := 0
var _dummy_tex_id := "00000000-0000-0000-0000-000000000001"

# scene_manager stub properties — asset_pipeline.sm accesses these
var texture_cache: Dictionary = {}
var material_cache: Dictionary = {}
var texture_load_failed: Dictionary = {}
var debug_mode: bool = false


## Stub for scene_manager.apply_debug_highlight_if_needed (called by asset_pipeline)
func apply_debug_highlight_if_needed(_mat: Material) -> void:
	pass


func _ready() -> void:
	# Create asset_pipeline with self as scene_manager stub (no threads started)
	ap = AssetPipelineScript.new(self)

	# Inject a dummy texture into the cache so _get_or_create_material can find it
	var img := Image.create(4, 4, false, Image.FORMAT_RGBA8)
	img.fill(Color.WHITE)
	var tex := ImageTexture.create_from_image(img)
	texture_cache[_dummy_tex_id] = tex

	_passed = 0
	_failed = 0

	_test_shaders_compile()
	_test_planar_opaque_shader()
	_test_planar_alpha_blend_shader()
	_test_planar_alpha_mask_shader()
	_test_standard_uv_opaque_shader()
	_test_standard_uv_alpha_blend_shader()
	_test_standard_uv_alpha_mask_shader()
	_test_double_sided_planar()
	_test_double_sided_standard_uv()
	_test_double_sided_cache_reuse()
	_test_opaque_no_alpha_uniform()
	_test_standard_material_fallback()

	print("--- shader_material tests: %d passed, %d failed ---" % [_passed, _failed])


# ─── Helpers ──────────────────────────────────────

func _assert(condition: bool, msg: String) -> void:
	if condition:
		_passed += 1
	else:
		_failed += 1
		push_error("FAIL: %s" % msg)


func _assert_eq(actual, expected, msg: String) -> void:
	_assert(actual == expected, "%s: expected %s, got %s" % [msg, str(expected), str(actual)])


func _clear_caches() -> void:
	material_cache.clear()


func _make_color(r: float, g: float, b: float, a: float) -> Array:
	return [r, g, b, a]


func _make_uv(rot: float = 0.0) -> Dictionary:
	return { "repeatU": 1.0, "repeatV": 1.0, "offsetU": 0.0, "offsetV": 0.0, "texRotation": rot }


# ─── Tests ──────────────────────────────────────

func _test_shaders_compile() -> void:
	# If preload succeeded, the shader compiled. Verify they're actual Shader resources.
	_assert(PlanarMapShader is Shader, "PlanarMapShader is Shader")
	_assert(PlanarMapAlphaShader is Shader, "PlanarMapAlphaShader is Shader")
	_assert(StandardUVShader is Shader, "StandardUVShader is Shader")
	_assert(StandardUVAlphaShader is Shader, "StandardUVAlphaShader is Shader")
	# Opaque variants must NOT contain "blend_mix"
	_assert("blend_mix" not in PlanarMapShader.code, "PlanarMapShader has no blend_mix")
	_assert("blend_mix" not in StandardUVShader.code, "StandardUVShader has no blend_mix")
	# Opaque variants must NOT write ALPHA (check for "ALPHA =" assignment in fragment)
	var planar_frag := PlanarMapShader.code.get_slice("void fragment", 1)
	var standard_frag := StandardUVShader.code.get_slice("void fragment", 1)
	_assert("ALPHA =" not in planar_frag and "ALPHA=" not in planar_frag, "PlanarMapShader fragment has no ALPHA write")
	_assert("ALPHA =" not in standard_frag and "ALPHA=" not in standard_frag, "StandardUVShader fragment has no ALPHA write")
	# Alpha variants must contain blend_mix and write ALPHA
	_assert("blend_mix" in PlanarMapAlphaShader.code, "PlanarMapAlphaShader has blend_mix")
	_assert("blend_mix" in StandardUVAlphaShader.code, "StandardUVAlphaShader has blend_mix")
	_assert("ALPHA" in PlanarMapAlphaShader.code, "PlanarMapAlphaShader writes ALPHA")
	_assert("ALPHA" in StandardUVAlphaShader.code, "StandardUVAlphaShader writes ALPHA")
	# Alpha variants must NOT have alpha_scissor_threshold
	_assert("alpha_scissor_threshold" not in PlanarMapAlphaShader.code, "PlanarMapAlphaShader has no scissor")
	_assert("alpha_scissor_threshold" not in StandardUVAlphaShader.code, "StandardUVAlphaShader has no scissor")


func _test_planar_opaque_shader() -> void:
	_clear_caches()
	# alpha_mode=0 (opaque), mapping_type=2 (planar)
	var mat: Material = ap._get_or_create_material(
		"test_planar_opaque", _dummy_tex_id, _make_color(1, 1, 1, 1), false, false, _make_uv(), 0, 0.5, {}, 2)
	_assert(mat is ShaderMaterial, "planar opaque: is ShaderMaterial")
	_assert_eq((mat as ShaderMaterial).shader, PlanarMapShader, "planar opaque: uses PlanarMapShader")


func _test_planar_alpha_blend_shader() -> void:
	_clear_caches()
	# alpha_mode=1 (blend), mapping_type=2 (planar)
	var mat: Material = ap._get_or_create_material(
		"test_planar_blend", _dummy_tex_id, _make_color(1, 1, 1, 1), false, false, _make_uv(), 1, 0.5, {}, 2)
	_assert(mat is ShaderMaterial, "planar blend: is ShaderMaterial")
	_assert_eq((mat as ShaderMaterial).shader, PlanarMapAlphaShader, "planar blend: uses PlanarMapAlphaShader")


func _test_planar_alpha_mask_shader() -> void:
	_clear_caches()
	# alpha_mode=2 (mask), mapping_type=2 (planar)
	var mat: Material = ap._get_or_create_material(
		"test_planar_mask", _dummy_tex_id, _make_color(1, 1, 1, 1), false, false, _make_uv(), 2, 0.75, {}, 2)
	_assert(mat is ShaderMaterial, "planar mask: is ShaderMaterial")
	_assert_eq((mat as ShaderMaterial).shader, PlanarMapShader, "planar mask: uses PlanarMapShader (opaque variant)")
	var smat := mat as ShaderMaterial
	_assert_eq(smat.get_shader_parameter("alpha_scissor_threshold"), 0.75, "planar mask: scissor = 0.75")


func _test_standard_uv_opaque_shader() -> void:
	_clear_caches()
	# alpha_mode=0 (opaque), tex_rotation != 0, mapping_type=0
	var mat: Material = ap._get_or_create_material(
		"test_uv_opaque", _dummy_tex_id, _make_color(1, 1, 1, 1), false, false, _make_uv(0.5), 0, 0.5, {}, 0)
	_assert(mat is ShaderMaterial, "standard_uv opaque: is ShaderMaterial")
	_assert_eq((mat as ShaderMaterial).shader, StandardUVShader, "standard_uv opaque: uses StandardUVShader")


func _test_standard_uv_alpha_blend_shader() -> void:
	_clear_caches()
	# alpha_mode=1 (blend), tex_rotation != 0
	var mat: Material = ap._get_or_create_material(
		"test_uv_blend", _dummy_tex_id, _make_color(1, 1, 1, 1), false, false, _make_uv(0.5), 1, 0.5, {}, 0)
	_assert(mat is ShaderMaterial, "standard_uv blend: is ShaderMaterial")
	_assert_eq((mat as ShaderMaterial).shader, StandardUVAlphaShader, "standard_uv blend: uses StandardUVAlphaShader")


func _test_standard_uv_alpha_mask_shader() -> void:
	_clear_caches()
	# alpha_mode=2 (mask), tex_rotation != 0
	var mat: Material = ap._get_or_create_material(
		"test_uv_mask", _dummy_tex_id, _make_color(1, 1, 1, 1), false, false, _make_uv(0.5), 2, 0.6, {}, 0)
	_assert(mat is ShaderMaterial, "standard_uv mask: is ShaderMaterial")
	_assert_eq((mat as ShaderMaterial).shader, StandardUVShader, "standard_uv mask: uses StandardUVShader (opaque variant)")
	var smat := mat as ShaderMaterial
	_assert_eq(smat.get_shader_parameter("alpha_scissor_threshold"), 0.6, "standard_uv mask: scissor = 0.6")


func _test_double_sided_planar() -> void:
	_clear_caches()
	# double_sided=true, planar, opaque
	var mat: Material = ap._get_or_create_material(
		"test_ds_planar", _dummy_tex_id, _make_color(1, 1, 1, 1), false, true, _make_uv(), 0, 0.5, {}, 2)
	_assert(mat is ShaderMaterial, "planar double-sided: is ShaderMaterial")
	var shader: Shader = (mat as ShaderMaterial).shader
	_assert(shader != PlanarMapShader, "planar double-sided: shader differs from base")
	_assert("cull_disabled" in shader.code, "planar double-sided: has cull_disabled")
	_assert("cull_back" not in shader.code, "planar double-sided: no cull_back")


func _test_double_sided_standard_uv() -> void:
	_clear_caches()
	# double_sided=true, standard_uv, blend
	var mat: Material = ap._get_or_create_material(
		"test_ds_uv", _dummy_tex_id, _make_color(1, 1, 1, 1), false, true, _make_uv(0.5), 1, 0.5, {}, 0)
	_assert(mat is ShaderMaterial, "standard_uv double-sided blend: is ShaderMaterial")
	var shader: Shader = (mat as ShaderMaterial).shader
	_assert(shader != StandardUVAlphaShader, "standard_uv double-sided blend: shader differs from base")
	_assert("cull_disabled" in shader.code, "standard_uv double-sided blend: has cull_disabled")
	_assert("blend_mix" in shader.code, "standard_uv double-sided blend: still has blend_mix")


func _test_double_sided_cache_reuse() -> void:
	_clear_caches()
	ap._double_sided_shader_cache.clear()
	# First call creates the double-sided variant
	var ds1: Shader = ap._get_double_sided_shader(PlanarMapShader)
	# Second call should return the same cached Shader instance
	var ds2: Shader = ap._get_double_sided_shader(PlanarMapShader)
	_assert(ds1 == ds2, "double-sided cache: same instance returned")
	_assert(ds1 != PlanarMapShader, "double-sided cache: differs from original")


func _test_opaque_no_alpha_uniform() -> void:
	_clear_caches()
	# Opaque mode 0, planar — alpha_scissor_threshold should stay at default -1
	var mat: Material = ap._get_or_create_material(
		"test_opaque_no_alpha", _dummy_tex_id, _make_color(1, 1, 1, 1), false, false, _make_uv(), 0, 0.5, {}, 2)
	var smat := mat as ShaderMaterial
	var threshold = smat.get_shader_parameter("alpha_scissor_threshold")
	# Default is -1.0 (disabled) — should NOT have been set to anything else
	_assert(threshold == null or threshold < 0.0, "opaque mode: scissor threshold not set (got %s)" % str(threshold))


func _test_standard_material_fallback() -> void:
	_clear_caches()
	# No rotation, no planar → should use StandardMaterial3D, not ShaderMaterial
	var mat: Material = ap._get_or_create_material(
		"test_std_fallback", _dummy_tex_id, _make_color(1, 1, 1, 1), false, false, _make_uv(0.0), 0, 0.5, {}, 0)
	_assert(mat is StandardMaterial3D, "no rotation/planar: uses StandardMaterial3D")
