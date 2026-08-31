extends Control

@onready var item_list: ItemList = $ItemList

var _chart_paths: Array[String] = []

func _ready() -> void:
	_scan_songs()
	item_list.item_activated.connect(_on_item_activated)

func _get_songs_root() -> String:
	if OS.has_feature("editor"):
		return "/home/manolo/github/Project-Rhythm-Core/Game-Client/dev_data/Songs/"
	return OS.get_executable_path().get_base_dir().path_join("Songs")

func _scan_songs() -> void:
	var songs_root := _get_songs_root()
	print("Looking in: ", songs_root)
	print("Folder exists?", DirAccess.dir_exists_absolute(songs_root))
	_scan_directory_recursive(songs_root)

func _scan_directory_recursive(path: String) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return
	
	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		var full_path := path.path_join(file_name)
		if dir.current_is_dir() and not file_name.begins_with("."):
			_scan_directory_recursive(full_path)
		elif file_name.ends_with(".osu"):
			_chart_paths.append(full_path)
			item_list.add_item(file_name)
		file_name = dir.get_next()
	dir.list_dir_end()

func _on_item_activated(index: int) -> void:
	var chart_path := _chart_paths[index]
	
	var parser := OsuParser.new()
	var chart = parser.parse_map(chart_path)
	
	if chart.has("errors"):
		print("Error: ", chart["error"])
		return
	
	var key_count: int = chart["key_count"]
	GameSession.select_chart(chart_path, key_count)
	get_tree().change_scene_to_file("res://scenes/game/game.tscn")
