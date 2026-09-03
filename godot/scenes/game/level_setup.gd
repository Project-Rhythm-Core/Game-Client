extends Node2D

@export var conductor: Conductor
@export var note_manager: NoteManager
@export var audio_player: AudioStreamPlayer
@export var judgment_line: CanvasItem

var chart: Dictionary
var notes_by_column: Array = []
var key_count: int = 0
var style: String = ""
var bindings: Array

# Game Setup
func _ready() -> void:
	_load_level()
	if chart.has("error") or chart.is_empty():
		return
	
	_setup_audio()
	
	key_count = chart["key_count"]
	style = GlobalSettings.get_preferred_variant(key_count)
	bindings = GlobalSettings.get_key_bindings(key_count, style)
	
	print("LEVEL_SETUP - bindings: ", bindings)
	
	var style_data: Dictionary = SkinManager.get_style(key_count, style)
	var hit_position: float = (SkinManager
	.default_skin["layout"][str(key_count)]
	.get("hit_position", 900.0)
	)
	
	var reference_height := 1080.0
	var scale_factor := get_viewport_rect().size.y / reference_height
	
	judgment_line.position.y = hit_position * scale_factor
	
	var judgment_color := Color.WHITE
	var judgment_thickness := 4.0
	var stage_width := get_viewport_rect().size.x
	
	var generated_line = LineGenerator.create_horizontal_line(0, hit_position * scale_factor, stage_width, judgment_thickness, judgment_color)
	add_child(generated_line)
	judgment_line = generated_line
	
	note_manager.setup(
		chart,
		key_count,
		bindings,
		conductor,
		style_data
		)
	
	await get_tree().create_timer(2.0).timeout
	conductor.play()

func _load_level() -> void:
	var parser := OsuParser.new()
	chart = parser.parse_map(GameSession.current_chart_path)

func _setup_audio() -> void:
	var audio_path := (
		GameSession
		.current_chart_path
		.get_base_dir()
		.path_join(chart["audio_filename"])
	)
	
	var audio_stream: AudioStream
	var extension := audio_path.get_extension().to_lower()
	
	match extension:
		"mp3":
			var file := FileAccess.open(audio_path, FileAccess.READ)
			var mp3_stream := AudioStreamMP3.new()
			mp3_stream.data = file.get_buffer(file.get_length())
			audio_stream = mp3_stream
		"ogg":
			audio_stream = AudioStreamOggVorbis.load_from_file(audio_path)

	audio_player.stream = audio_stream
