## ActionPanelUI: panel akcji gracza w turze boga, czyli rekrutacja i budowa.
##
## SCENA (scenes/ui/ActionPanel.tscn)
##   ActionPanel (PanelContainer, ten skrypt)
##   └── Content (VBoxContainer)
##       ├── %TitleLabel     czyja tura i którego boga
##       ├── %RecruitRow     %RecruitButton (jednostka boga i koszt następnej sztuki) + %RecruitInfo
##       │                   (zakupy, które zostały w turze, i figurki na planszy albo powód blokady)
##       ├── %BuildRow       %BuildButton (budynek boga i koszt) + %BuildInfo (wolne miejsca albo powód)
##       └── %NoticeLabel    odmowa serwera
##
## Panel liczy stan przycisków regułami wspólnymi z serwerem (RecruitRules, MoveRules) na
## projekcji gracza, więc przycisk jest aktywny dokładnie wtedy, gdy serwer przyjmie akcję.
## Sam nie wysyła rozkazów: sygnały recruit_requested i build_requested zamienia na nie Main
## (pole dla oddziału i floty gracz wskazuje na planszy, kapłan i filozof idą od razu).
class_name ActionPanelUI
extends PanelContainer

## Gracz chce pozyskać jednostkę `kind` (TROOP, FLEET, PRIEST albo PHILOSOPHER).
signal recruit_requested(kind: String)
## Gracz chce budować: Main włącza na planszy tryb budowy.
signal build_requested

const GameState := preload("res://scripts/autoload/GameStateManager.gd")
const Data := preload("res://scripts/autoload/GameData.gd")
const GOD_GENITIVE := {"POSEIDON": "Posejdona", "ARES": "Aresa", "ZEUS": "Zeusa", "ATHENA": "Ateny", "APOLLO": "Apolla", "HADES": "Hadesa"}
const UNIT_NAMES := {"TROOP": "Oddział", "FLEET": "Flota", "PRIEST": "Kapłan", "PHILOSOPHER": "Filozof"}
const BUILDING_ACCUSATIVE := {"PORT": "Port", "FORTRESS": "Fortecę", "TEMPLE": "Świątynię", "UNIVERSITY": "Uniwersytet"}

## Panel sam śledzi GameStateManager.view. Wyłącz, gdy stan podajesz przez apply_view (np. w testach).
@export var follow_game_state := true

## Projekcja stanu, którą panel rysuje.
var view: Dictionary = {}
## Jednostka, którą daje bóg bieżącej tury (pusty napis: bóg nie daje rekrutacji).
var recruit_kind := ""

## Ostatnia odmowa serwera i rewizja stanu, przy której przyszła (nowy stan ją kasuje).
var _notice := ""
var _notice_revision := -1

@onready var _title: Label = %TitleLabel
@onready var _recruit_row: Control = %RecruitRow
@onready var _recruit_button: Button = %RecruitButton
@onready var _recruit_info: Label = %RecruitInfo
@onready var _build_row: Control = %BuildRow
@onready var _build_button: Button = %BuildButton
@onready var _build_info: Label = %BuildInfo
@onready var _notice_label: Label = %NoticeLabel


func _ready() -> void:
	_recruit_button.pressed.connect(request_recruit)
	_build_button.pressed.connect(request_build)
	if follow_game_state:
		var game_state := get_node_or_null("/root/GameStateManager") as GameState
		if game_state != null:
			game_state.view_changed.connect(apply_view)
			apply_view(game_state.view)
			return
	_refresh()


## Nowa projekcja od serwera.
func apply_view(new_view: Dictionary) -> void:
	if int(new_view.get("revision", -1)) != _notice_revision:
		_notice = ""
	view = new_view
	_refresh()


## Odmowa serwera: panel pokazuje jej powód do nadejścia nowego stanu.
func on_action_rejected(_code: String, message: String) -> void:
	_notice = message
	_notice_revision = int(view.get("revision", -1))
	_refresh()


func request_recruit() -> void:
	if recruit_kind != "" and not _recruit_button.disabled:
		recruit_requested.emit(recruit_kind)


func request_build() -> void:
	if not _build_button.disabled:
		build_requested.emit()


func _refresh() -> void:
	if not is_node_ready():
		return
	_notice_label.text = _notice
	_notice_label.visible = _notice != ""
	if view.get("phase", "") != "ACTIONS":
		recruit_kind = ""
		_title.text = ""
		_recruit_row.visible = false
		_build_row.visible = false
		return
	var me := String(view.get("you", ""))
	var god := GameState.god_of(view)
	var actor := GameState.actor_of(view)
	var mine := actor == me
	_refresh_recruit(me, god, mine)
	_refresh_build(me, god, mine)
	var god_name := String(GOD_GENITIVE.get(god, god))
	if not mine:
		_title.text = "Tura %s: gra %s" % [god_name, _player_name(actor)]
	elif _recruit_row.visible or _build_row.visible:
		_title.text = "Tura %s: rekrutacja i budowa" % god_name
	else:
		_title.text = "Tura %s: bez rekrutacji i budowy" % god_name


func _refresh_recruit(me: String, god: String, mine: bool) -> void:
	var kinds: Array = Data.god_def(god).get("recruits", []).filter(func(kind: String) -> bool: return kind in RecruitRules.SUPPORTED)
	recruit_kind = String(kinds[0]) if not kinds.is_empty() else ""
	_recruit_row.visible = recruit_kind != ""
	if recruit_kind == "":
		return
	var unit := String(UNIT_NAMES.get(recruit_kind, recruit_kind))
	var cost := RecruitRules.next_cost(view, recruit_kind)
	if cost < 0:
		_recruit_button.text = "%s · limit tury" % unit
	elif cost == 0:
		_recruit_button.text = "%s · 0 JZ (darmowy)" % unit
	else:
		_recruit_button.text = "%s · %d JZ" % [unit, cost]
	var reason := _recruit_block(me, mine, cost)
	_recruit_button.disabled = reason != ""
	# Pierwsza sztuka jest darmowa, więc „dokupić” można tyle, ile jest płatnych pozycji na liście kosztów.
	var extra_total: int = Data.god_def(god)["recruit_costs"].size() - 1
	var extra_left := extra_total - maxi(RecruitRules.recruited(view, recruit_kind) - 1, 0)
	var head := "dokupisz jeszcze %d z %d" % [extra_left, extra_total]
	if cost < 0:
		head = "limit tury wyczerpany"
	elif mine and reason != "":
		head = reason
	_recruit_info.text = "%s · %s" % [head, _recruit_tail(me)]


## Powód, dla którego gracz nie może teraz pozyskać jednostki, albo pusty napis.
func _recruit_block(me: String, mine: bool, cost: int) -> String:
	if not mine:
		return "czekasz na swoją turę"
	if cost < 0:
		return "limit tury wyczerpany"
	var on_board := recruit_kind in ["TROOP", "FLEET"]
	var limit := RecruitRules.MAX_TROOPS if recruit_kind == "TROOP" else RecruitRules.MAX_FLEETS
	if on_board and RecruitRules.units_of(view, me, recruit_kind) >= limit:
		return "masz już wszystkie %d figurek" % limit
	if MoveRules.gold_of(view, me) < cost:
		return "nie stać cię: %d JZ, masz %d JZ" % [cost, MoveRules.gold_of(view, me)]
	if on_board and RecruitRules.recruit_targets(view, me, recruit_kind).is_empty():
		return "brak miejsca na nową jednostkę"
	if not on_board and RecruitRules.recruit_error(view, me, recruit_kind, "") != "":
		return "serwer tego nie przyjmie"
	return ""


## Stan zasobu, który rośnie przy rekrutacji: figurki na planszy albo karty gracza.
func _recruit_tail(me: String) -> String:
	var player: Dictionary = view["players"][me]
	match recruit_kind:
		"TROOP":
			return "oddziały na planszy %d/%d" % [RecruitRules.units_of(view, me, "TROOP"), RecruitRules.MAX_TROOPS]
		"FLEET":
			return "floty na planszy %d/%d" % [RecruitRules.units_of(view, me, "FLEET"), RecruitRules.MAX_FLEETS]
		"PRIEST":
			return "kapłani: %d" % int(player.get("priests", 0))
		"PHILOSOPHER":
			return "filozofowie: %d z %d do Metropolii" % [int(player.get("philosophers", 0)), GameState.PHILOSOPHERS_PER_METROPOLIS]
	return ""


func _refresh_build(me: String, god: String, mine: bool) -> void:
	var building := String(MoveRules.GOD_BUILDING.get(god, ""))
	_build_row.visible = building != ""
	if building == "":
		return
	_build_button.text = "Buduj %s · %d JZ" % [BUILDING_ACCUSATIVE.get(building, building), MoveRules.BUILD_COST]
	var islands := MoveRules.build_targets(view, me)
	_build_button.disabled = islands.is_empty()
	if not mine:
		_build_info.text = ""
	elif MoveRules.gold_of(view, me) < MoveRules.BUILD_COST:
		_build_info.text = "nie stać cię: %d JZ, masz %d JZ" % [MoveRules.BUILD_COST, MoveRules.gold_of(view, me)]
	elif islands.is_empty():
		_build_info.text = "brak wolnych miejsc na twoich wyspach"
	else:
		_build_info.text = "wolne miejsca na %d %s" % [islands.size(), "wyspie" if islands.size() == 1 else "wyspach"]


func _player_name(player_id: String) -> String:
	return String(view.get("players", {}).get(player_id, {}).get("name", player_id))
