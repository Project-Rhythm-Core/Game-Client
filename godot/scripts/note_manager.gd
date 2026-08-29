extends Node2D

const NOTE_SCENE := preload("res://objects/note/note.tscn")
const COLUMN_WIDTH := 80.0

const HIT_MARGIN_PERFECT := 0.050
const HIT_MARGIN_GOOD := 0.150
const HIT_MARGIN_MISS := 0.300

@export var conductor: Conductor
@export var judgment_line: Node2D

var _notes: Array[Note] = []
var _notes_by_column: Array = []
var _key_count: int = 4

func _ready() -> void:
	var parser := OsuParser.new()
	var chart := parser.parse_map()
	
	if chart.has("error"):
		print("Error al parsear el chart: ", chart["error"])
		return
		
	var key_count: int = chart["key_count"]
	var stage_start: float = (get_viewport_rect().size.x - (key_count * COLUMN_WIDTH)) / 2.0
	
	_notes_by_column.resize(_key_count)
	for i in range(_key_count):
		_notes_by_column[i] = []
		
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
		_notes_by_column[column].append(note)
	
	conductor.play()
	print("Notas cargadas: ", _notes.size())

# Called every frame. 'delta' is the elapsed time since the previous frame.
func _process(_delta: float) -> void:
	if _notes.is_empty():
		return
	
	var curr_beat := conductor.get_current_beat()
	for note in _notes:
		note.update_beat(curr_beat)
		
	_miss_old_notes(curr_beat)
	_handle_input(curr_beat)

func _get_note_delta(note: Note, curr_beat: float) -> float:
	return (curr_beat - note.beat) * conductor.get_beat_duration()

func _miss_old_notes(curr_beat: float) -> void:
	for column in range(_key_count):
		var queue: Array = _notes_by_column[column]
		while not queue.is_empty():
			var note: Note = queue[0]
			var delta := _get_note_delta(note, curr_beat)
			
			if delta > HIT_MARGIN_GOOD:
				print("Miss! (%.1f ms)" % (delta * 1000))
				note.miss()
				queue.remove_at(0)
				_notes.erase(note)
			else:
				break
func _handle_input(curr_beat: float) -> void:
	for column in range(_key_count):
		var action_name := "key_%d" % column
		if not Input.is_action_just_pressed(action_name):
			continue
		
		var queue: Array = _notes_by_column[column]
		if queue.is_empty():
			continue
		
		var note: Note = queue[0]
		var delta := _get_note_delta(note, curr_beat)
		
		if delta < -HIT_MARGIN_MISS:
			continue
		
		if abs(delta) <= HIT_MARGIN_PERFECT:
			print("Perfect! (%.1f ms)" % (delta * 1000))
			note.hit()
			queue.remove_at(0)
			_notes.erase(note)
		elif abs(delta) <= HIT_MARGIN_GOOD:
			print("Good (%.1f ms)" % (delta * 1000))
			note.hit()
			queue.remove_at(0)
			_notes.erase(note)
		elif abs(delta) <= HIT_MARGIN_MISS:
			print("Miss (%.1f ms)" % (delta * 1000))
			note.miss()
			queue.remove_at(0)
			_notes.erase(note)
