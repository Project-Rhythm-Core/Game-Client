extends Node

const SETTINGS_PATH := "user://settings.json"

var settings: Dictionary = _default_settings()

# Called when the node enters the scene tree for the first time.
func _ready() -> void:
	_load_settings()
	
func _load_settings() -> void:
	if not FileAccess.file_exists(SETTINGS_PATH):
		return
	
	var file := FileAccess.open(SETTINGS_PATH, FileAccess.READ)
	var content := file.get_as_text()
	file.close()
	
	var parsed = JSON.parse_string(content)
	if parsed is Dictionary:
		settings = parsed

func save_settings() -> void:
	var file := FileAccess.open(SETTINGS_PATH, FileAccess.WRITE)
	file.store_string(JSON.stringify(settings, "\t"))
	file.close()

func get_key_bindings(key_count: int) -> Array:
	var key_count_str := str(key_count)
	if settings["input"]["key_bindings"].has(key_count_str):
		return settings["input"]["key_bindings"][key_count_str]
	return []

func _default_settings() -> Dictionary:
	return {
		"input": {
			"key_bindings": {
				"1": ["SPACE"],
				"2": ["F", "J"],
				"3": ["F", "SPACE", "J"],
				"4": ["D", "F", "J", "K"],
				"5": ["D", "F", "SPACE", "J", "K"],
				"6": ["S", "D", "F", "J", "K", "L"],
				"7": ["S", "D", "F", "SPACE", "J", "K", "L"],
				"8": ["A", "S", "D", "F", "J", "K", "L", ";"],
				"9": ["A", "S", "D", "F", "SPACE", "J", "K", "L", ";"],
				"10": ["Q", "W", "E", "R", "C", "N", "U", "I", "O", "P"],
				
			},
			"shortcuts": {
				"pause": "Escape"
			},
		},
		"display": {
			"fullscreen": false,
		}
	}
