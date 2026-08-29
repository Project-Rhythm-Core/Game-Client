extends Node

@onready var conductor: Conductor = $Conductor
@onready var label: Label = $Label
# Called when the node enters the scene tree for the first time.
func _ready() -> void:
	var rust_node := OsuParser.new()
	var map := rust_node.parse_map()
	print(map)
	conductor.play()

# Called every frame. 'delta' is the elapsed time since the previous frame.
func _process(delta: float) -> void:
	label.text = "Beat: %.2f" % conductor.get_current_beat()
