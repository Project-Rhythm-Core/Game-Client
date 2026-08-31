extends RefCounted
class_name AudioLoader

static func load_audio(chart_path: String, chart: Dictionary, player: AudioStreamPlayer) -> void:
	var chart_dir := chart_path.get_base_dir()
	var audio_filename: String = chart["audio_filename"]
	var audio_path := chart_dir.path_join(audio_filename)

	var audio_stream: AudioStream
	if audio_path.ends_with(".mp3"):
		var file := FileAccess.open(audio_path, FileAccess.READ)
		var mp3_stream := AudioStreamMP3.new()
		mp3_stream.data = file.get_buffer(file.get_length())
		audio_stream = mp3_stream
	elif audio_path.ends_with(".ogg"):
		audio_stream = AudioStreamOggVorbis.load_from_file(audio_path)

	player.stream = audio_stream
