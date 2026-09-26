## GameOverPanelUI: komunikat o końcu gry (okno nad planszą w fazie GAME_OVER).
##
## SCENA (scenes/ui/GameOverPanel.tscn)
##   GameOverPanel (Control na cały ekran, ten skrypt)
##   ├── Dim (ColorRect)      przyciemnienie planszy
##   └── Center → Panel → Box %TitleLabel, %MessageLabel, %LeaveButton („Wyjdź z gry”)
##
## Treść pochodzi z `result` w projekcji: zwycięzcy, kandydaci z 2 Metropoliami i ich złoto
## (na koniec gry jawne, bo rozstrzyga remis). Trzy przypadki: jedyny gracz z 2 Metropoliami,
## kilku takich graczy i przewaga złota, remis w złocie.
class_name GameOverPanelUI
extends Control

## Gracz chce wyjść z zakończonej partii (Main wraca do listy gier).
signal leave_requested

const GameState := preload("res://scripts/autoload/GameStateManager.gd")

## Panel sam śledzi GameStateManager.view. Wyłącz, gdy stan podajesz przez apply_view (np. w testach).
@export var follow_game_state := true

## Projekcja stanu, którą panel rysuje.
var view: Dictionary = {}

@onready var _title: Label = %TitleLabel
@onready var _message: Label = %MessageLabel


func _ready() -> void:
	(%LeaveButton as Button).pressed.connect(func() -> void: leave_requested.emit())
	if follow_game_state:
		var game_state := get_node_or_null("/root/GameStateManager") as GameState
		if game_state != null:
			game_state.view_changed.connect(apply_view)
			apply_view(game_state.view)
			return
	_refresh()


func apply_view(new_view: Dictionary) -> void:
	view = new_view
	_refresh()


func _refresh() -> void:
	if not is_node_ready():
		return
	visible = view.get("phase", "") == "GAME_OVER"
	if not visible:
		return
	var result: Dictionary = view.get("result", {})
	var winners: Array = result.get("winners", view.get("winners", []))
	_title.text = "Zwycięstwo!" if view.get("you", "") in winners else "Koniec gry"
	_message.text = describe(view)


## Komunikat o wyniku partii z projekcji w fazie GAME_OVER.
static func describe(state: Dictionary) -> String:
	var result: Dictionary = state.get("result", {})
	var winners: Array = result.get("winners", state.get("winners", []))
	var contenders: Array = result.get("contenders", winners)
	var gold: Dictionary = result.get("gold", {})
	var needed := MoveRules.METROPOLISES_TO_WIN
	if winners.size() > 1:
		var names := PackedStringArray(winners.map(func(player_id: String) -> String: return _name_in(state, player_id)))
		return "Remis: %s mają po %d Metropolie i po %d JZ." % [_join(names), needed, int(gold.get(winners[0], 0))]
	if winners.is_empty():
		return "Partia zakończona."
	var winner := _name_in(state, String(winners[0]))
	if contenders.size() == 1:
		return "Wygrywa %s: %d Metropolie na koniec cyklu %d." % [winner, needed, int(state.get("cycle", 0))]
	var ranking := contenders.duplicate()
	ranking.sort_custom(func(a: String, b: String) -> bool: return int(gold.get(a, 0)) > int(gold.get(b, 0)))
	var fortunes := PackedStringArray(ranking.map(func(player_id: String) -> String: return "%s %d JZ" % [_name_in(state, player_id), int(gold.get(player_id, 0))]))
	return "Wygrywa %s: %d Metropolie i najwięcej złota (%s)." % [winner, needed, ", ".join(fortunes)]


static func _name_in(state: Dictionary, player_id: String) -> String:
	return String(state.get("players", {}).get(player_id, {}).get("name", player_id))


## „A i B”, „A, B i C”.
static func _join(names: PackedStringArray) -> String:
	if names.size() < 2:
		return "".join(names)
	return "%s i %s" % [", ".join(names.slice(0, names.size() - 1)), names[names.size() - 1]]
