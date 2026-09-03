extends Node

const DEFAULT_SKIN_PATH: String = "res://assets/skins/default"
const ALLOWED_LAYOUTS_PATH: String = "res://assets/config/allowed_layouts.json"
const ASSET_EXTENSIONS := ["png", "jpg", "jpeg"]

var allowed_layouts: Dictionary = {}
var default_skin: Dictionary = {}
var _texture_cache: Dictionary = {}

func _ready() -> void:
	allowed_layouts = _load_json(ALLOWED_LAYOUTS_PATH)
	default_skin = _load_skin()
	default_skin["layout"] = {}
	
func _load_skin() -> Dictionary:
	var loaded_skin: Dictionary = {}
	var skin_metadata := _load_json(DEFAULT_SKIN_PATH.path_join("skin.json"))
	loaded_skin["metadata"] = skin_metadata
	return loaded_skin

func load_layout(key_count: int) -> void:
	var key_count_str := str(key_count)
	
	if not allowed_layouts.has(key_count_str):
		push_error("SkinManager: key_count %d not in allowed_layouts." % key_count)
		return
		
	if default_skin["layout"].has(str(key_count)):
		return
		
	var path = DEFAULT_SKIN_PATH.path_join("layouts/%dk.json" % key_count)
	var skin_layout = _load_json(path)
	default_skin["layout"][str(key_count)] = skin_layout

func get_style(key_count: int, variant: String = "") -> Dictionary:
	load_layout(key_count)
	
	var layout_data: Dictionary = default_skin["layout"].get(str(key_count), {})
	var style_map: Dictionary = layout_data.get("styles", {})
	
	var resolved_style: Dictionary
	if variant != "" and style_map.has(variant):
		resolved_style = style_map[variant]
	elif not style_map.is_empty():
		resolved_style = style_map.values()[0]
	else:
		push_error("SkinManager: no style available for this key count=%d" % key_count)
		return {}
	
	if not _is_style_valid(resolved_style):
		push_error("SkinManager: style not supported for this key count=%d" % key_count)
		return {}
	
	return resolved_style

func _is_style_valid(style: Dictionary) -> bool:
	var required_keys := ["column_width", "tap_image", "ln_image", "ln_head_image"]
	for key in required_keys:
		if not style.has(key):
			return false
	
	var n: int = style["column_width"].size()
	for key in ["tap_image", "ln_image", "ln_head_image"]:
		if style[key].size() != n:
			return false
	
	var expected_line_width: int = max(n - 1, 0)
	if style.get("column_line_width", []).size() != expected_line_width:
		return false
	
	return true

func get_texture(relative_path: String) -> Texture2D:
	if _texture_cache.has(relative_path):
		return _texture_cache[relative_path]
	
	var full_path := _resolve_asset_path(relative_path)
	if full_path == "":
		push_warning("SkinManager: Texture not found for '%s" % relative_path)
		return null
	
	var texture := load(full_path) as Texture2D
	_texture_cache[relative_path] = texture
	return texture

func _resolve_asset_path(relative_path: String) -> String:
	var base_path := DEFAULT_SKIN_PATH.path_join("assets").path_join(relative_path)
	for ext in ASSET_EXTENSIONS:
		var full_path: String = base_path + "." + ext
		if FileAccess.file_exists(full_path):
			return full_path
	return ""

func _load_json(path) -> Dictionary:	
	if not FileAccess.file_exists(path):
		return {}
	
	var file := FileAccess.open(path, FileAccess.READ)
	var content := file.get_as_text()
	file.close()
	
	return JSON.parse_string(content) as Dictionary
