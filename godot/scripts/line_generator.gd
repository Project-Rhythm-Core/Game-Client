class_name LineGenerator
extends RefCounted

static func create_vertical_line(x: float, height: float, width: float, color: Color) -> ColorRect:
	var line := ColorRect.new()
	line.color = color
	line.size = Vector2(width, height)
	line.position = Vector2(x - width / 2.0, 0)
	line.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return line

static func create_horizontal_line(x_start: float, y: float, width: float, thickness: float, color: Color) -> ColorRect:
	var line := ColorRect.new()
	line.color = color
	line.size = Vector2(width, thickness)
	line.position = Vector2(x_start, y - thickness / 2.0)
	line.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return line
