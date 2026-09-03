class_name Note
extends Node2D

@export var conductor: Conductor
@export var x_offset: float = 0.0
@export var beat: float = 0.0
@export var judgment_line: Node2D

@export var end_beat: float = -1.0

@onready var sprite: Sprite2D = $Sprite2D
@onready var body_sprite: Sprite2D = $BodySprite

var _speed: float = 1000.0
var _movement_paused: bool = false
var _song_time_delta: float = 0.0

var is_hold: bool = false
var _head_judged: bool = false
var _is_being_held: bool = false
var _released_early: bool = false

func _ready() -> void:
	is_hold = end_beat >= 0.0
	body_sprite.visible = is_hold

func update_beat(curr_beat: float) -> void:
	_song_time_delta = (curr_beat - beat) * conductor.get_beat_duration()
	_update_position()

func set_note_texture(texture: Texture2D) -> void:
	sprite.texture = texture

func set_hold_body_texture(texture: Texture2D) -> void:
	body_sprite.texture = texture
	
func _process(_delta: float) -> void:
	if _movement_paused and not (is_hold and _head_judged):
		return
	_update_position()

func _update_position() -> void:
	var head_y: float
	
	if is_hold and _head_judged:
		head_y = judgment_line.position.y
	else:
		head_y = judgment_line.position.y + (_speed * _song_time_delta)
		position.y = head_y
		
	position.x = x_offset
	
	if is_hold:
		var tail_delta: float = ((_current_beat()) - end_beat) * conductor.get_beat_duration()
		var tail_y = judgment_line.position.y + (_speed * tail_delta)
		_update_body(head_y, tail_y)

func _current_beat() -> float:
	return beat + (_song_time_delta / conductor.get_beat_duration())

func _update_body(head_y: float, tail_y: float) -> void:
	var length: float = head_y - tail_y
	body_sprite.position = Vector2(x_offset - body_sprite.texture.get_width() / 2.0 if body_sprite.texture else 0.0, tail_y)
	
	if body_sprite.texture and body_sprite.texture.get_height() > 0:
		body_sprite.scale.y = max(length, 0.0) / body_sprite.texture.get_height()
	body_sprite.scale.x = 1.0
	
func hit() -> void:
	if is_hold:
		_head_judged = true
		_is_being_held = true
		sprite.modulate = Color.YELLOW
	else:
		_movement_paused = true
		queue_free()

func release_early() -> void:
	_is_being_held = false
	_released_early = true
	sprite.modulate = Color.DARK_RED

func finish_hold() -> void:
	_movement_paused = true
	queue_free()

func miss() -> void:
	_movement_paused = true
	queue_free()

func was_released_early() -> bool:
	return _released_early
