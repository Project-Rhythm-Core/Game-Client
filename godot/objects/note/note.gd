class_name Note
extends Node2D

@export var conductor: Conductor
@export var x_offset: float = 0.0
@export var beat: float = 0.0

var _speed: float = 400.0
var _movement_paused: bool = false
var _song_time_delta: float = 0.0

func update_beat(curr_beat: float) -> void:
	_song_time_delta = (curr_beat - beat) * conductor.get_beat_duration()
	_update_position()

func _process(_delta: float) -> void:
	if _movement_paused:
		return
	_update_position()

func _update_position() -> void:
	position.y = _speed * _song_time_delta
	position.x = x_offset

func hit() -> void:
	_movement_paused = true
	queue_free()

func miss() -> void:
	_movement_paused = true
	queue_free()
