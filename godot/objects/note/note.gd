class_name Note
extends Node2D

@export var conductor: Conductor
@export var x_offset: float = 0.0
@export var beat: float = 0.0
@export var judgment_line: CanvasItem
@export var column_width: float = 90.0

@export var end_beat: float = -1.0

@onready var sprite: Sprite2D = $Sprite2D
@onready var body_sprite: Sprite2D = $BodySprite

var _speed: float = 1300.0
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
	_scale_sprite_to_column_width()

func _scale_sprite_to_column_width() -> void:
	if sprite.texture == null:
		return
	var texture_width := sprite.texture.get_width()
	if texture_width > 0:
		var scale_factor: float = column_width / texture_width
		sprite.scale = Vector2(scale_factor, scale_factor)
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
	if body_sprite.texture == null:
		return
		
	var length: float = head_y - tail_y
	var texture_width := body_sprite.texture.get_width()
	var texture_height := body_sprite.texture.get_height()
	
	if texture_width<= 0 or texture_height <= 0:
		return
	
	var scale_x: float = column_width / texture_width
	var scale_y: float = max(length, 0.0) / texture_height
	
	body_sprite.scale = Vector2(scale_x, scale_y)
	body_sprite.position = Vector2(-(texture_width * scale_x) / 2.0, tail_y - head_y)
	
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
