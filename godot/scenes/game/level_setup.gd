extends Node2D

@export var conductor: Conductor
@export var note_manager: NoteManager
@export var audio_player: AudioStreamPlayer

var chart: Dictionary
var notes_by_column: Array = []
var key_count: int = 0
var variant: String = ""
var bindings: Array

# Game Setup
func _ready() -> void:
	_load_level()
	if chart.has("error") or chart.is_empty():
		return
	
	_setup_audio()
	
	key_count = chart["key_count"]
	variant = GlobalSettings.get_preferred_variant(key_count)
	
	SkinManager.load_layout(key_count, variant)
	
	note_manager.setup(
		chart,
		key_count,
		GlobalSettings.get_key_bindings(
			key_count,
			variant
			),
		conductor
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
