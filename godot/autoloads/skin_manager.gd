extends Node

const DEFAULT_SKIN_PATH: String = "res://assets/skins/default"
const ALLOWED_LAYOUTS_PATH: String = "res://assets/config/allowed_layouts.json"

var allowed_layouts: Dictionary = {}
var default_skin: Dictionary = {}

func _ready() -> void:
	allowed_layouts = _load_json(ALLOWED_LAYOUTS_PATH)
	default_skin = _load_skin()
	
func _load_skin() -> Dictionary:
	var loaded_skin: Dictionary = {}
	var skin_metadata := _load_json(DEFAULT_SKIN_PATH.path_join("skin.json"))
	loaded_skin.assign(skin_metadata)
	return loaded_skin

func _load_layout(key_count: int, style: String = "") -> Dictionary:
	print(allowed_layouts)
	return {}

func _load_json(path) -> Dictionary:	
	if not FileAccess.file_exists(path):
		return {}
	
	var file := FileAccess.open(path, FileAccess.READ)
	var content := file.get_as_text()
	file.close()
	
	return JSON.parse_string(content) as Dictionary
