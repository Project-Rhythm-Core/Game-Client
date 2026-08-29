extends Node2D

const NOTE_SCENE := preload("res://objects/note/note.tscn")
const COLUMN_WIDTH := 80.0

@export var conductor: Conductor
@export var judgment_line: Node2D
@export var chart_path: String = "/home/manolo/github/Project-Rhythm-Core/Game-Client/rust/resources/polyriddim/phonon - polyriddim (HowToPlayLN) [nsv].osu"

var _notes: Array[Note] = []

func _ready() -> void:
	var parser := OsuParser.new()
	var chart := parser.parse_map()
	
	if chart.has("error"):
		print("Error al parsear el chart: ", chart["error"])
		return
		
	var key_count: int = chart["key_count"]
	var stage_start: float = (get_viewport_rect().size.x - (key_count * COLUMN_WIDTH)) / 2.0
	
	var notes_data: Array = chart["notes"]
	
	for note_data in notes_data:
		var time_ms: float = note_data["time"]
		var column: int = note_data["column"]
		var beat := (time_ms/ 1000.0) / conductor.get_beat_duration()
		
		var note := NOTE_SCENE.instantiate() as Note
		if note == null:
			return
		note.conductor = conductor
		note.beat = beat
		note.x_offset = stage_start + (column * COLUMN_WIDTH)
		note.judgment_line = judgment_line
		note.update_beat(-100)
		
		add_child(note)
		_notes.append(note)
	
	conductor.play()
	print("Notas cargadas: ", _notes.size())

# Called every frame. 'delta' is the elapsed time since the previous frame.
func _process(_delta: float) -> void:
	if _notes.is_empty():
		return
	
	var curr_beat := conductor.get_current_beat()
	for note in _notes:
		note.update_beat(curr_beat)
