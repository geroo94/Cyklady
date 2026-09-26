## MetropolisDialogUI: wybór wyspy dla nowej Metropolii (okno modalne nad planszą).
##
## SCENA (scenes/ui/MetropolisDialog.tscn)
##   MetropolisDialog (Control na cały ekran, ten skrypt)
##   ├── Dim (ColorRect)      przyciemnienie: zatrzymuje kliknięcia w planszę pod oknem
##   └── Center → Panel → Box %TitleLabel, %TextLabel (skąd Metropolia), %Sites (przycisk na wyspę)
##
## Serwer czeka na wybór, gdy człowiek zakłada Metropolię i ma więcej niż jedną wyspę bez
## Metropolii (`pending_metropolis` w projekcji). Okno widzi tylko ten gracz. Wybrana wyspa
## wychodzi sygnałem site_chosen, a Main wysyła ją do serwera (NetworkManager.place_metropolis).
## Do nowego stanu przyciski są wyłączone, więc wyboru nie da się wysłać dwa razy.
class_name MetropolisDialogUI
extends Control

## Gracz wybrał wyspę dla Metropolii.
signal site_chosen(island_id: String)

const GameState := preload("res://scripts/autoload/GameStateManager.gd")
const REASONS := {
	"BUILDINGS": "Komplet czterech różnych budynków zamienia się w Metropolię. Wybierz wyspę, na której stanie.",
	"PHILOSOPHERS": "Czterech filozofów zakłada Metropolię. Wybierz wyspę, na której stanie.",
}
const BUILDING_NAMES := {"PORT": "Port", "FORTRESS": "Forteca", "TEMPLE": "Świątynia", "UNIVERSITY": "Uniwersytet", "THEATER": "Teatr", "NECROPOLIS": "Nekropolia"}

## Okno samo śledzi GameStateManager.view. Wyłącz, gdy stan podajesz przez apply_view (np. w testach).
@export var follow_game_state := true

## Projekcja stanu, którą okno rysuje.
var view: Dictionary = {}
var _sent := false

@onready var _text: Label = %TextLabel
@onready var _sites: Container = %Sites


func _ready() -> void:
	if follow_game_state:
		var game_state := get_node_or_null("/root/GameStateManager") as GameState
		if game_state != null:
			game_state.view_changed.connect(apply_view)
			apply_view(game_state.view)
			return
	_refresh()


## Nowa projekcja od serwera (kończy też oczekiwanie na odpowiedź po wyborze).
func apply_view(new_view: Dictionary) -> void:
	view = new_view
	_sent = false
	_refresh()


## Wybór wyspy (przycisk). Tylko wyspa z listy serwera i tylko raz do nowego stanu.
func choose(island_id: String) -> void:
	if _sent or island_id not in _pending().get("sites", []):
		return
	_sent = true
	for button: Button in _sites.get_children():
		button.disabled = true
	site_chosen.emit(island_id)


func _pending() -> Dictionary:
	return view.get("pending_metropolis", {})


func _refresh() -> void:
	if not is_node_ready():
		return
	var pending := _pending()
	visible = not pending.is_empty() and pending.get("player", "") == view.get("you", "")
	for child in _sites.get_children():
		_sites.remove_child(child)
		child.queue_free()
	if not visible:
		return
	_text.text = String(REASONS.get(pending.get("origin", ""), "Wybierz wyspę dla nowej Metropolii."))
	for island_id: String in pending.get("sites", []):
		var button := Button.new()
		button.text = _site_text(island_id)
		button.pressed.connect(choose.bind(island_id))
		_sites.add_child(button)


## Nazwa wyspy i jej budynki (gracz widzi, co już tam stoi).
func _site_text(island_id: String) -> String:
	var buildings: Array = view.get("islands", {}).get(island_id, {}).get("buildings", [])
	var text := ArchipelagoMap.display_name(island_id)
	if not buildings.is_empty():
		text += " (%s)" % ", ".join(PackedStringArray(buildings.map(func(building: String) -> String: return String(BUILDING_NAMES.get(building, building)))))
	return text
