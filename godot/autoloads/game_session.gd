extends Node

signal chart_selected(chart_path: String, key_count: int)

var current_chart_path: String = ""
var current_key_count: int = 0

func select_chart(chart_path: String, key_count: int) -> void:
	current_chart_path = chart_path
	current_key_count = key_count
	chart_selected.emit(chart_path, key_count)
