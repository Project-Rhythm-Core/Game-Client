extends Node2D
class_name NoteManager

const NOTE_SCENE := preload("res://objects/note/note.tscn")
const COLUMN_WIDTH := 80.0

const HIT_MARGIN_PERFECT := 0.050
const HIT_MARGIN_GOOD := 0.150
const HIT_MARGIN_MISS := 0.300

@export var judgment_line: Node2D

var _conductor: Conductor
var _bindings: Array = []
var _key_count: int = 0

var _notes: Array[Note] = []
var _notes_by_column: Array = []
var _ready_to_process: bool = false


func setup(chart: Dictionary, key_count: int, bindings: Array, conductor: Conductor) -> void:
	_conductor = conductor
	_bindings = bindings
	_key_count = key_count

	var stage_start: float = (get_viewport_rect().size.x - (_key_count * COLUMN_WIDTH)) / 2.0

	_notes_by_column.resize(_key_count)
	for i in range(_key_count):
		_notes_by_column[i] = []

	var notes_data: Array = chart["notes"]

	for note_data in notes_data:
		var time_ms: float = note_data["time"]
		var column: int = note_data["column"]
		var beat := (time_ms / 1000.0) / _conductor.get_beat_duration()

		var note := NOTE_SCENE.instantiate() as Note
		if note == null:
			push_error("NoteManager: no se pudo instanciar Note.")
			return

		note.conductor = _conductor
		note.beat = beat
		note.x_offset = stage_start + (column * COLUMN_WIDTH)
		note.judgment_line = judgment_line
		note.update_beat(-100)

		add_child(note)
		_notes.append(note)
		_notes_by_column[column].append(note)

	print("Notas cargadas: ", _notes.size())
	_ready_to_process = true


func _process(_delta: float) -> void:
	if not _ready_to_process or _notes.is_empty():
		return

	var curr_beat := _conductor.get_current_beat()
	for note in _notes:
		note.update_beat(curr_beat)

	_miss_old_notes(curr_beat)


func _input(event: InputEvent) -> void:
	if not _ready_to_process:
		return
	if event is InputEventKey and event.pressed and not event.echo:
		_handle_key_input(event.physical_keycode)


func _get_note_delta(note: Note, curr_beat: float) -> float:
	return (curr_beat - note.beat) * _conductor.get_beat_duration()


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


func _handle_key_input(physical_keycode: int) -> void:
	var column := _bindings.find(physical_keycode)
	if column == -1:
		return

	var curr_beat := _conductor.get_current_beat()
	var queue: Array = _notes_by_column[column]
	if queue.is_empty():
		return

	var note: Note = queue[0]
	var delta := _get_note_delta(note, curr_beat)

	if delta < -HIT_MARGIN_MISS:
		return

	if abs(delta) <= HIT_MARGIN_PERFECT:
		print("Perfect! (%.1f ms)" % (delta * 1000))
		note.hit()
	elif abs(delta) <= HIT_MARGIN_GOOD:
		print("Good! (%.1f ms)" % (delta * 1000))
		note.hit()
	elif abs(delta) <= HIT_MARGIN_MISS:
		print("Miss (%.1f ms)" % (delta * 1000))
		note.miss()
	else:
		return

	queue.remove_at(0)
	_notes.erase(note)
