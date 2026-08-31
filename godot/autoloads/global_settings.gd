extends Node

const SETTINGS_PATH := "user://settings.json"
const DEFAULT_SETTINGS_PATH := "res://assets/default_settings.json"

var settings: Dictionary = {}

# Called when the node enters the scene tree for the first time.
func _ready() -> void:
	settings = _load_json(DEFAULT_SETTINGS_PATH)
	_load_user_overrides()
	
func _load_json(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		return {}
	var file := FileAccess.open(path, FileAccess.READ)
	var content := file.get_as_text()
	file.close()
	var parsed = JSON.parse_string(content)
	return parsed if parsed is Dictionary else {}

func _load_user_overrides() -> void:
	if not FileAccess.file_exists(SETTINGS_PATH):
		return
	var user_settings := _load_json(SETTINGS_PATH)
	if not user_settings.is_empty():
		settings = user_settings

func save_settings() -> void:
	var file := FileAccess.open(SETTINGS_PATH, FileAccess.WRITE)
	file.store_string(JSON.stringify(settings, "\t"))
	file.close()

func get_key_bindings(key_count: int, variant: String = "") -> Array:
	var key_count_str := str(key_count)
	var raw = settings.get("input", {}).get("key_bindings", {}).get(key_count_str, [])

	var result: Array = []
	if raw is Array:
		result = raw
	elif raw is Dictionary:
		if variant != "" and raw.has(variant):
			result = raw[variant]
		elif not raw.is_empty():
			result = raw.values()[0]
			
	return result.map(func(k): return int(k))

func get_variants_for(key_count: int) -> Array:
	var key_count_str := str(key_count)
	var raw = settings.get("input", {}).get("key_bindings", {}).get(key_count_str, [])
	if raw is Dictionary:
		return raw.keys()
	return []

func get_preferred_variant(key_count: int) -> String:
	var key_count_str := str(key_count)
	return settings.get("input", {}).get("preferred_variant", {}).get(key_count_str, "")

func set_preferred_variant(key_count: int, variant: String) -> void:
	var key_count_str := str(key_count)
	if not settings.has("input"):
		settings["input"] = {}
	if not settings["input"].has("preferred_variant"):
		settings["input"]["preferred_variant"] = {}
	settings["input"]["preferred_variant"][key_count_str] = variant
	save_settings()
