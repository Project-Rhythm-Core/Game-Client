extends Node

func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed:
		var logical_keycode := DisplayServer.keyboard_get_keycode_from_physical(event.physical_keycode)
		var display_name := OS.get_keycode_string(logical_keycode)
		print("Physical keycode: ", event.physical_keycode)
		##print("Logical keycode: ", logical_keycode)
		print("Display name: ", display_name)
