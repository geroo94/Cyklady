## Board: plansza „Archipelag”. Pola, wybór pola i podświetlanie prawidłowych ruchów.
##
## DRZEWO SCENY (scenes/board/Board.tscn)
##   Board (Node2D, ten skrypt)
##   ├── Seas (Node2D)                  pola morskie: TerritoryNode z type = SEA
##   │   └── arch_center, arch_n, …     (każde z dzieckiem Shape: CollisionPolygon2D)
##   └── Islands (Node2D, z_index = 1)  wyspy nad morzami: TerritoryNode z type = ISLAND
##       └── andros, mykonos, …
## Plansza działa w dowolnym viewporcie (w Main.tscn: SubViewport w SubViewportContainer).
## Włącza w nim picking obiektów fizyki z sortowaniem i tylko jednym, najwyższym
## trafieniem. Dzięki temu kursor nad wyspą trafia tylko wyspę, choć wyspa leży
## na polu morskim.
##
## STAN
##   Plansza rysuje projekcję stanu od serwera (GameStateManager.view): właścicieli,
##   jednostki, budynki i monumenty. Z tej samej projekcji liczy prawidłowe ruchy
##   funkcjami MoveRules, tymi samymi, którymi serwer sprawdza ruch w apply_move.
##
## KLIKNIĘCIA
##   1. Pole z twoimi jednostkami: highlight_valid_moves(pole, ruch) podświetla cele,
##      a reszta planszy przygasa. Wyspa oznacza ruch oddziałów (tura Aresa), morze
##      ruch floty (tura Posejdona).
##   2. Podświetlony cel: sygnał move_requested, a w trybie budowy build_requested.
##   3. Ponowne kliknięcie wybranego pola, prawy przycisk albo Esc anulują wybór.
##   4. Tryb wskazywania (pick_targets) dla paneli UI: miejsce rekrutacji, cel mocy
##      stwora, wyspa dla Metropolii. Kliknięty cel wraca sygnałem target_picked,
##      a Esc i prawy przycisk kończą tryb sygnałem pick_cancelled.
## Plansza wysyła tylko sygnały. Rozkaz do serwera wysyła UI (NetworkManager),
## a serwer i tak sprawdza go jeszcze raz.
class_name Board
extends Node2D

## Każde kliknięcie pola (także takie, które niczego nie wybiera).
signal territory_clicked(territory_id: String)
## Nowy wybór: pole startowe (puste w trybie budowy), rodzaj akcji i cele. Puste wartości oznaczają koniec wyboru.
signal selection_changed(territory_id: String, action_type: String, targets: Dictionary)
## Gracz wskazał cel ruchu.
signal move_requested(from_id: String, to_id: String, action_type: String)
## Gracz wskazał wyspę do budowy.
signal build_requested(island_id: String)
## Podpowiedź dla gracza: opis pola pod kursorem, cele ruchu albo powód, dla którego ruchu nie ma.
signal hint_changed(text: String)
## Tryb wskazywania: gracz kliknął jeden z podanych celów (tryb już się zakończył).
signal target_picked(territory_id: String)
## Tryb wskazywania anulowany (Esc albo prawy przycisk).
signal pick_cancelled

const GameState := preload("res://scripts/autoload/GameStateManager.gd")
## Rodzaj celu w trybie budowy (MoveRules zwraca dla ruchu cele "MOVE" i "ATTACK").
const TARGET_BUILD := "BUILD"
## Rodzaj celu w trybie wskazywania (zielony). Cel ataku mocy stwora może mieć "ATTACK" (czerwony).
const TARGET_PICK := "PICK"
## Akcja wyboru w trybie wskazywania (pick_targets).
const PICK := "PICK"
const GOD_NAMES := {"POSEIDON": "Posejdona", "ARES": "Aresa", "ZEUS": "Zeusa", "ATHENA": "Ateny", "APOLLO": "Apolla"}
const BUILDING_NAMES := {"PORT": "Port", "FORTRESS": "Forteca", "TEMPLE": "Świątynia", "UNIVERSITY": "Uniwersytet", "METROPOLIS": "Metropolia"}
const CLICK_HINTS := {
	MoveRules.TARGET_MOVE: "Kliknij: ruch.",
	MoveRules.TARGET_ATTACK: "Kliknij: atak (bitwa).",
	TARGET_BUILD: "Kliknij: budowa.",
	TARGET_PICK: "Kliknij: wybierz to pole.",
}

## Plansza sama śledzi GameStateManager.view. Wyłącz, gdy widok podajesz przez apply_view (np. w testach).
@export var follow_game_state := true
## Skala i położenie planszy dopasowane do rozmiaru viewportu.
@export var fit_to_viewport := true
@export var fit_margin := 12.0

## Projekcja stanu, którą plansza rysuje.
var view: Dictionary = {}
## Pole startowe wyboru (puste w trybie budowy i bez wyboru).
var selected_id := ""
## Akcja wyboru: MoveRules.MOVE_TROOPS, MOVE_FLEET, BUILD albo pusty napis.
var selected_action := ""
## Podświetlone cele: { id pola: "MOVE" | "ATTACK" | "BUILD" }.
var targets: Dictionary = {}

var _territories: Dictionary = {}


func _ready() -> void:
	for node in territories():
		_territories[node.territory_id] = node
		node.hovered.connect(_on_territory_hovered)
		node.clicked.connect(_on_territory_clicked)
	# Wyspa leży na polu morskim: zdarzenie myszy dostaje tylko najwyższe pole (wyspy mają wyższy z_index).
	var viewport := get_viewport()
	viewport.physics_object_picking = true
	viewport.physics_object_picking_sort = true
	viewport.physics_object_picking_first_only = true
	if fit_to_viewport:
		viewport.size_changed.connect(fit)
		fit()
	if follow_game_state:
		var game_state := get_node_or_null("/root/GameStateManager") as GameState
		if game_state != null:
			game_state.view_changed.connect(apply_view)
			apply_view(game_state.view)


## Esc albo prawy przycisk myszy anuluje wybór.
func _unhandled_input(event: InputEvent) -> void:
	if selected_action == "":
		return
	var button := event as InputEventMouseButton
	if event.is_action_pressed("ui_cancel") or (button != null and button.pressed and button.button_index == MOUSE_BUTTON_RIGHT):
		var picking := selected_action == PICK
		clear_selection()
		hint_changed.emit("Wybór anulowany.")
		get_viewport().set_input_as_handled()
		if picking:
			pick_cancelled.emit()


# =============================================================================
# Stan planszy
# =============================================================================

## Nowa projekcja od serwera: stan każdego pola i przeliczenie wyboru.
func apply_view(new_view: Dictionary) -> void:
	view = new_view
	for territory_id: String in _territories:
		var node: TerritoryNode = _territories[territory_id]
		var data := territory_state(territory_id)
		node.apply_state(data, player_color(String(data.get("owner", ""))))
	if selected_action == PICK:
		_apply_marks()  # cele wskazywania podaje panel UI, a nie reguły ruchu
	elif selected_action != "":
		# Wybór sprzed zmiany stanu: cele od nowa. Jeśli ruch nie jest już możliwy, wybór znika.
		_select(selected_id, selected_action, false)


## Wszystkie pola planszy (TerritoryNode na dowolnej głębokości drzewa).
func territories() -> Array[TerritoryNode]:
	var result: Array[TerritoryNode] = []
	var queue: Array[Node] = [self]
	while not queue.is_empty():
		var node: Node = queue.pop_front()
		for child in node.get_children():
			if child is TerritoryNode:
				result.append(child)
			queue.append(child)
	return result


func territory(territory_id: String) -> TerritoryNode:
	return _territories.get(territory_id) as TerritoryNode


## Słownik pola z projekcji (pusty, gdy partia nie trwa).
func territory_state(territory_id: String) -> Dictionary:
	for kind in ["islands", "seas"]:
		var nodes: Dictionary = view.get(kind, {})
		if nodes.has(territory_id):
			return nodes[territory_id]
	return {}


## Kolor gracza z projekcji (przezroczysty dla pola wolnego).
func player_color(player_id: String) -> Color:
	var players: Dictionary = view.get("players", {})
	var player: Dictionary = players.get(player_id, {})
	return TerritoryNode.PLAYER_COLORS.get(String(player.get("color", "")), Color(0, 0, 0, 0))


# =============================================================================
# Wybór i podświetlenie
# =============================================================================

## Podświetla wyłącznie pola, na które gracz może teraz wykonać ruch z `selected_territory_id`:
##   MoveRules.MOVE_TROOPS  tura Aresa: wyspy połączone łańcuchem twoich flot (także nieumarłych),
##   MoveRules.MOVE_FLEET   tura Posejdona: pola w zasięgu floty, bez przepływania przez obce floty,
##   MoveRules.BUILD        wyspy z wolnym miejscem na budynek boga, którego tura trwa
##                          (`selected_territory_id` może być pusty).
## Zwraca cele { id pola: "MOVE" | "ATTACK" | "BUILD" }. To te same pola, które przyjmie serwer.
## Gdy ruchu nie ma, nic nie jest podświetlone, a sygnał hint_changed podaje powód.
func highlight_valid_moves(selected_territory_id: String, action_type: String) -> Dictionary:
	return _select(selected_territory_id, action_type, true)


## Ruch, który oznacza kliknięcie pola: z wyspy ruszają oddziały, z morza floty.
static func action_for(territory_id: String) -> String:
	return MoveRules.MOVE_TROOPS if ArchipelagoMap.is_island(territory_id) else MoveRules.MOVE_FLEET


## Tryb wskazywania pola dla paneli UI: podświetla tylko `candidates`
## { id pola: TARGET_PICK | MoveRules.TARGET_ATTACK | … }, a reszta planszy przygasa.
## Podpowiedź `prompt` mówi graczowi, co wskazać. Kliknięty cel wraca sygnałem
## target_picked. Pusta lista celów niczego nie podświetla.
func pick_targets(candidates: Dictionary, prompt: String) -> void:
	if candidates.is_empty():
		clear_selection()
		hint_changed.emit(prompt)
		return
	selected_id = ""
	selected_action = PICK
	targets = candidates.duplicate()
	_apply_marks()
	selection_changed.emit("", PICK, targets.duplicate())
	hint_changed.emit(prompt)


## Koniec wyboru: pola wracają do zwykłego wyglądu.
func clear_selection() -> void:
	var had_selection := selected_action != ""
	selected_id = ""
	selected_action = ""
	targets = {}
	_apply_marks()
	if had_selection:
		selection_changed.emit("", "", {})


## Punkt pola w układzie viewportu (punkt etykiety: wewnątrz pola i poza wyspami).
## Przydaje się do dymków nad polem i do testów, które klikają w pole.
func viewport_point_of(territory_id: String) -> Vector2:
	var node: TerritoryNode = _territories[territory_id]
	return node.get_global_transform_with_canvas() * node.label_anchor


## Opis pola do podpowiedzi: właściciel, jednostki, budynki, monument i skutek kliknięcia.
func describe(territory_id: String) -> String:
	var data := territory_state(territory_id)
	var island := ArchipelagoMap.is_island(territory_id)
	var holder := String(data.get("owner", ""))
	var parts := PackedStringArray(["gracz %s" % _player_name(holder) if holder != "" else "pole wolne"])
	var regular := int(data.get("troops" if island else "fleets", 0))
	var undead := int(data.get("undead_troops" if island else "undead_fleets", 0))
	if regular > 0:
		parts.append("%s: %d" % ["oddziały" if island else "floty", regular])
	if undead > 0:
		parts.append("nieumarli: %d" % undead)
	for building in data.get("buildings", []):
		parts.append(String(BUILDING_NAMES.get(building, building)))
	if String(data.get("monument", "")) != "":
		parts.append("monument %s" % String(data["monument"]).capitalize())
	var text := "%s: %s." % [ArchipelagoMap.display_name(territory_id), ", ".join(parts)]
	if targets.has(territory_id):
		text += " " + String(CLICK_HINTS[targets[territory_id]])
	return text


## Skala i położenie planszy tak, żeby cała mieściła się w viewporcie z marginesem.
func fit() -> void:
	var bounds := content_bounds()
	var area := get_viewport_rect().size
	if bounds.size.x <= 0.0 or bounds.size.y <= 0.0 or area.x <= 0.0 or area.y <= 0.0:
		return
	var room := (area - Vector2.ONE * fit_margin * 2.0).max(Vector2.ONE)
	var factor := minf(room.x / bounds.size.x, room.y / bounds.size.y)
	scale = Vector2(factor, factor)
	position = area / 2.0 - bounds.get_center() * factor


## Prostokąt wszystkich pól w układzie planszy (bez jej skali i położenia).
func content_bounds() -> Rect2:
	var bounds := Rect2()
	var empty := true
	for node: TerritoryNode in _territories.values():
		var shape := node.shape_node()
		if shape == null:
			continue
		var to_board := shape.get_relative_transform_to_parent(self)
		for point in shape.polygon:
			var corner := to_board * point
			bounds = Rect2(corner, Vector2.ZERO) if empty else bounds.expand(corner)
			empty = false
	return bounds


func _select(from_id: String, action_type: String, explain: bool) -> Dictionary:
	var player_id := String(view.get("you", ""))
	var reason := _selection_error(player_id, from_id, action_type)
	var found := {}
	if reason == "":
		if action_type == MoveRules.BUILD:
			for island_id in MoveRules.build_targets(view, player_id):
				found[island_id] = TARGET_BUILD
		else:
			found = MoveRules.move_targets(view, player_id, from_id, action_type)
		if found.is_empty():
			reason = _no_targets_text(action_type)
	if found.is_empty():
		clear_selection()
		if explain:
			hint_changed.emit(reason)
		return {}
	# Nowy stan z tymi samymi celami (np. rozłączył się inny gracz) nie jest nowym wyborem:
	# bez sygnału UI nie nadpisuje np. liczby jednostek ustawionej przez gracza.
	var new_id := "" if action_type == MoveRules.BUILD else from_id
	var changed := new_id != selected_id or action_type != selected_action or found != targets
	selected_id = new_id
	selected_action = action_type
	targets = found
	_apply_marks()
	if changed:
		selection_changed.emit(selected_id, selected_action, targets.duplicate())
	if explain:
		hint_changed.emit(_targets_text())
	return targets.duplicate()


func _apply_marks() -> void:
	for territory_id: String in _territories:
		var node: TerritoryNode = _territories[territory_id]
		if selected_action == "":
			node.mark = TerritoryNode.Mark.NONE
		elif territory_id == selected_id:
			node.mark = TerritoryNode.Mark.SELECTED
		elif targets.has(territory_id):
			node.mark = _target_mark(String(targets[territory_id]))
		else:
			node.mark = TerritoryNode.Mark.DIMMED


static func _target_mark(kind: String) -> TerritoryNode.Mark:
	match kind:
		MoveRules.TARGET_ATTACK:
			return TerritoryNode.Mark.ATTACK_TARGET
		TARGET_BUILD:
			return TerritoryNode.Mark.BUILD_TARGET
	return TerritoryNode.Mark.MOVE_TARGET


## Powód, dla którego gracz nie może teraz wykonać tej akcji z tego pola (pusty, gdy może).
func _selection_error(player_id: String, from_id: String, action_type: String) -> String:
	if view.is_empty():
		return "Plansza czeka na stan partii."
	var code := MoveRules.action_error(view, player_id, action_type)
	if code == "" and action_type != MoveRules.BUILD:
		code = MoveRules.origin_error(view, player_id, from_id, action_type)
	match code:
		"":
			return ""
		"NOT_ACTIONS":
			return "Teraz trwa licytacja. Ruchy i budowy są w turach bogów."
		"NOT_YOUR_TURN":
			return "Teraz tura gracza %s." % _player_name(GameState.actor_of(view))
		"WRONG_GOD":
			return _wrong_god_text(action_type)
		"CANNOT_AFFORD":
			var cost := MoveRules.BUILD_COST if action_type == MoveRules.BUILD else MoveRules.MOVE_COST
			return "%s kosztuje %d JZ, a masz %d JZ." % ["Budynek" if action_type == MoveRules.BUILD else "Ruch", cost, MoveRules.gold_of(view, player_id)]
		"WRONG_TERRITORY":
			return "Oddziały ruszają z wyspy, a floty z pola morskiego."
		"NOT_OWNER":
			return "%s nie należy do ciebie." % ArchipelagoMap.display_name(from_id)
		"NO_UNITS":
			return "%s: nie masz tu jednostek, którymi można ruszyć." % ArchipelagoMap.display_name(from_id)
	return code


func _wrong_god_text(action_type: String) -> String:
	var god := GameState.god_of(view)
	var now := "Teraz tura %s." % GOD_NAMES.get(god, god)
	match action_type:
		MoveRules.MOVE_TROOPS:
			return "Oddziały porusza tylko tura Aresa. %s" % now
		MoveRules.MOVE_FLEET:
			return "Floty porusza tylko tura Posejdona. %s" % now
	return "W turze Apolla nie ma budowy."


func _no_targets_text(action_type: String) -> String:
	match action_type:
		MoveRules.MOVE_TROOPS:
			return "Brak celów: oddziały potrzebują łańcucha twoich flot do innej wyspy."
		MoveRules.MOVE_FLEET:
			return "Brak celów w zasięgu floty (%d pola, obce floty zagradzają drogę)." % MoveRules.FLEET_RANGE
	return "Brak wysp z wolnym miejscem na budynek."


func _targets_text() -> String:
	if selected_action == MoveRules.BUILD:
		var building := String(MoveRules.GOD_BUILDING.get(GameState.god_of(view), ""))
		return "Wybierz wyspę na budynek %s (%d JZ). Esc: anuluj." % [BUILDING_NAMES.get(building, building), MoveRules.BUILD_COST]
	var what := "Oddziały z wyspy %s" if selected_action == MoveRules.MOVE_TROOPS else "Flota z pola %s"
	return "%s: zielone pola to ruch, czerwone bitwa (%d JZ). Esc: anuluj." % [what % ArchipelagoMap.display_name(selected_id), MoveRules.MOVE_COST]


func _player_name(player_id: String) -> String:
	var players: Dictionary = view.get("players", {})
	var player: Dictionary = players.get(player_id, {})
	return String(player.get("name", player_id))


func _on_territory_hovered(node: TerritoryNode) -> void:
	hint_changed.emit(describe(node.territory_id))


func _on_territory_clicked(node: TerritoryNode) -> void:
	var clicked_id := node.territory_id
	territory_clicked.emit(clicked_id)
	if selected_action == PICK:
		if targets.has(clicked_id):
			clear_selection()
			target_picked.emit(clicked_id)
		else:
			hint_changed.emit("%s nie jest celem. Wskaż podświetlone pole albo naciśnij Esc." % ArchipelagoMap.display_name(clicked_id))
		return
	if targets.has(clicked_id):
		var from_id := selected_id
		var action := selected_action
		clear_selection()
		# Potwierdzenie dla gracza. Odmowę serwera (np. gdy stan zmienił się w międzyczasie) pokaże dziennik partii.
		if action == MoveRules.BUILD:
			hint_changed.emit("Rozkaz: budowa na wyspie %s." % ArchipelagoMap.display_name(clicked_id))
			build_requested.emit(clicked_id)
		else:
			hint_changed.emit("Rozkaz: %s → %s." % [ArchipelagoMap.display_name(from_id), ArchipelagoMap.display_name(clicked_id)])
			move_requested.emit(from_id, clicked_id, action)
		return
	if clicked_id == selected_id:
		clear_selection()
		hint_changed.emit("Wybór anulowany.")
		return
	highlight_valid_moves(clicked_id, action_for(clicked_id))
