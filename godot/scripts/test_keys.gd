extends Node

func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed:
		print("Logic Keycode: ", event.keycode)
		print("Physical keycode: ", event.physical_keycode)
