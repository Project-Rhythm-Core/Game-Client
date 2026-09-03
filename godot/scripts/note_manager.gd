extends Node2D
class_name NoteManager

const NOTE_SCENE := preload("res://objects/note/note.tscn")

const HIT_MARGIN_PERFECT := 0.050
const HIT_MARGIN_GOOD := 0.150
const HIT_MARGIN_MISS := 0.300
const TAIL_MARGIN_MULTIPLIER := 1.5

@export var judgment_line: CanvasItem

var _conductor: Conductor
var _bindings: Array = []
var _key_count: int = 0

var _notes: Array[Note] = []
var _notes_by_column: Array = []
var _active_holds: Array = []
var _ready_to_process: bool = false


func setup(chart: Dictionary, key_count: int, bindings: Array, conductor: Conductor, style_data: Dictionary) -> void:
	_conductor = conductor
	_bindings = bindings
	_key_count = key_count
	
	var column_widths: Array = style_data.get("column_width", [])
	if column_widths.size() != key_count:
		column_widths = []
		for i in range(key_count):
			column_widths.append(80.0)
	
	var total_width: float = 0.0
	for w in column_widths:
		total_width += w

	var stage_start: float = (get_viewport_rect().size.x - total_width) / 2.0
	
	var column_positions: Array = []
	var accumulated: float = stage_start
	for i in range(key_count):
		column_positions.append(accumulated)
		accumulated += column_widths[i]
	
	var tap_images: Array = style_data.get("tap_image", [])
	var hold_head_images: Array = style_data.get("ln_head_image", [])
	var hold_body_images: Array = style_data.get("ln_image", [])

	_notes_by_column.resize(_key_count)
	_active_holds.resize(_key_count)
	for i in range(_key_count):
		_notes_by_column[i] = []
		_active_holds[i] = null
		
	var line_widths: Array = style_data.get("column_line_width", [])
	var stage_height := get_viewport_rect().size.y
	
	for i in range(line_widths.size()):
		var thickness: float = line_widths[i]
		if thickness <= 0:
			continue
		var line_x: float = column_positions[i] + column_widths[i]
		var line := LineGenerator.create_vertical_line(line_x, stage_height, thickness, Color.WHITE)
		add_child(line)

	var notes_data: Array = chart["notes"]

	for note_data in notes_data:
		var time_ms: float = note_data["time"]
		var column: int = note_data["column"]
		var beat := (time_ms / 1000.0) / _conductor.get_beat_duration()
		var end_time_ms: float = note_data.get("end_time", -1.0)
		var is_hold: bool = end_time_ms >= 0.0

		var note := NOTE_SCENE.instantiate() as Note
		if note == null:
			push_error("NoteManager: no se pudo instanciar Note.")
			return
		
		note.conductor = _conductor
		note.beat = beat
		note.x_offset = column_positions[column]
		note.judgment_line = judgment_line
		note.column_width = column_widths[column]
		
		if is_hold:
			var end_beat := (end_time_ms / 1000.0) / _conductor.get_beat_duration()
			note.end_beat = end_beat
		
		add_child(note)
		
		var relative_path: String = ""
		if is_hold and column < hold_head_images.size():
			relative_path = hold_head_images[column]
		elif column < tap_images.size():
			relative_path = tap_images[column]
		
		if relative_path != "":
			var texture: Texture2D = SkinManager.get_texture(relative_path)
			if texture != null:
				note.set_note_texture(texture)
		
		if is_hold and column < hold_body_images.size():
			var body_texture: Texture2D = SkinManager.get_texture(hold_body_images[column])
			if body_texture != null:
				note.set_hold_body_texture(body_texture)
		
		note.update_beat(-100)

		_notes.append(note)
		_notes_by_column[column].append(note)

	print("Loaded notes: ", _notes.size())
	_ready_to_process = true


func _process(_delta: float) -> void:
	if not _ready_to_process or _notes.is_empty():
		return

	var curr_beat := _conductor.get_current_beat()
	for note in _notes:
		note.update_beat(curr_beat)

	_miss_old_notes(curr_beat)
	_check_active_holds(curr_beat)

func _input(event: InputEvent) -> void:
	if not _ready_to_process:
		return
	if event is InputEventKey and not event.echo:
		if event.pressed:
			_handle_key_input(event.physical_keycode)
		else:
			_handle_key_release(event.physical_keycode)


func _get_note_delta(note: Note, curr_beat: float) -> float:
	return (curr_beat - note.beat) * _conductor.get_beat_duration()


func _miss_old_notes(curr_beat: float) -> void:
	for column in range(_key_count):
		var queue: Array = _notes_by_column[column]
		while not queue.is_empty():
			var note: Note = queue[0]
			
			if note.is_hold and _active_holds[column] == note:
				break
				
			var delta := _get_note_delta(note, curr_beat)
			if delta > HIT_MARGIN_GOOD:
				#print("Miss! (%.1f ms)" % (delta * 1000))
				note.miss()
				queue.remove_at(0)
				_notes.erase(note)
			else:
				break

func _check_active_holds(curr_beat: float) -> void:
	for column in range(_key_count):
		var note: Note = _active_holds[column]
		if note == null:
			continue
		
		var tail_delta := _get_tail_delta(note, curr_beat)
		var tail_margin_miss := HIT_MARGIN_MISS * TAIL_MARGIN_MULTIPLIER
		
		if tail_delta > tail_margin_miss:
			print("Miss! (late release)")
			_finish_active_hold(column, note)

func _handle_key_input(physical_keycode: int) -> void:
	var column := _bindings.find(physical_keycode)
	if column == -1:
		return

	if _active_holds[column] != null:
		return

	var curr_beat := _conductor.get_current_beat()
	var queue: Array = _notes_by_column[column]
	if queue.is_empty():
		return

	var note: Note = queue[0]
	var delta := _get_note_delta(note, curr_beat)

	if delta < -HIT_MARGIN_MISS:
		return

	var judgment := _resolve_judgment(delta, HIT_MARGIN_PERFECT, HIT_MARGIN_GOOD, HIT_MARGIN_MISS)
	if judgment == "":
		return

	print("%s! (cabeza, %.1f ms)" % [judgment, delta * 1000])

	note.hit()
	queue.remove_at(0)

	if note.is_hold:
		_active_holds[column] = note
	else:
		_notes.erase(note)

func _handle_key_release(physical_keycode: int) -> void:
	var column := _bindings.find(physical_keycode)
	if column == -1:
		return
	
	var note: Note = _active_holds[column]
	if note == null:
		return
	
	var curr_beat := _conductor.get_current_beat()
	var tail_delta := _get_tail_delta(note, curr_beat)

	if tail_delta < 0.0:
		# Released before the tail even reached the judgment line: like osu!stable,
		# the LN keeps scrolling instead of despawning. It gets judged as a miss
		# once its tail passes the late-hit window in _check_active_holds.
		note.release_early()
		return

	_finish_active_hold(column, note)

func _finish_active_hold(column: int, note: Note) -> void:
	var curr_beat := _conductor.get_current_beat()
	var tail_delta := _get_tail_delta(note, curr_beat)
	
	var tail_perfect := HIT_MARGIN_PERFECT * TAIL_MARGIN_MULTIPLIER
	var tail_good := HIT_MARGIN_GOOD * TAIL_MARGIN_MULTIPLIER
	var tail_miss := HIT_MARGIN_MISS * TAIL_MARGIN_MULTIPLIER
	
	var judgment := _resolve_judgment(tail_delta, tail_perfect, tail_good, tail_miss)
	
	if note.was_released_early() and judgment == "Perfect":
		judgment = "Good"
	
	if judgment == "":
		judgment = "Miss"
	
	print("%s! (cola, %.1f ms)" % [judgment, tail_delta * 1000])
	
	note.finish_hold()
	_active_holds[column] = null
	_notes.erase(note)

func _resolve_judgment(delta: float, perfect: float, good: float, miss: float) -> String:
	var abs_delta := absf(delta)
	if abs_delta <= perfect:
		return "Perfect"
	elif abs_delta <= good:
		return "Good"
	elif abs_delta <= miss:
		return "Miss"
	return ""

func _get_tail_delta(note: Note, curr_beat: float) -> float:
	return (curr_beat - note.end_beat) * _conductor.get_beat_duration()
