## Scena główna: ekran gier LAN (LanLobby), poczekalnia i panel partii z planszą.
##
## Pokazuje, jak interfejs łączy się z autoloadami:
##   przyciski i plansza → NetworkManager (intencje: ofiara, ruch, budowa, koniec tury),
##   sygnały             → odświeżenie widoku (view_changed, battle_reported, lobby_changed…).
## Plansza (scenes/board/Board.tscn w SubViewport) sama rysuje GameStateManager.view
## i podświetla prawidłowe ruchy. Panel licytacji (scenes/ui/BiddingBoard.tscn)
## sam pokazuje tory ofiar i przebicia. Tutaj zamieniamy ich sygnały na rozkazy.
## Ekrany przełączają się wyłącznie na sygnały: serwer wystartował albo klient
## został przyjęty → poczekalnia, przyszedł stan partii → panel gry.
## UI nigdy samo nie zmienia stanu gry. Rysuje wyłącznie projekcję od serwera,
## a o legalności ruchu decyduje serwer.
extends Control

## Skrypt stanu gry jako typ: jego funkcje statyczne (np. actor_of) wołamy na typie, a nie na autoloadzie.
const GameState := preload("res://scripts/autoload/GameStateManager.gd")
const OUTCOMES := {"ATTACKER_WON": "wygrywa atakujący", "DEFENDER_WON": "wygrywa obrońca", "MUTUAL_DESTRUCTION": "obie strony zniszczone"}
const MODIFIERS := {"FORTRESS": "Forteca", "PORT": "Port", "METROPOLIS": "Metropolia"}
const RECRUITS := {"TROOP": "oddział", "FLEET": "flota", "PRIEST": "kapłan", "PHILOSOPHER": "filozof"}

@onready var _browser: Control = %Browser
@onready var _waiting: Control = %WaitingRoom
@onready var _waiting_label: Label = %WaitingLabel
@onready var _game: Control = %Game
@onready var _status: Label = %StatusLabel
@onready var _from_edit: LineEdit = %FromEdit
@onready var _to_edit: LineEdit = %ToEdit
@onready var _count: SpinBox = %CountSpin
@onready var _log_label: RichTextLabel = %Log
@onready var _board: Board = %Board
@onready var _hint: Label = %HintLabel
@onready var _bidding: BiddingBoardUI = %BiddingBoard
@onready var _move_row: Control = %MoveRow

## Ostatnie wypisane zdarzenie z dziennika partii (numer `seq`) i partia, do której należy.
var _last_event := 0
var _game_id := ""


func _ready() -> void:
	# Poczekalnia i panel partii: przyciski wysyłają wyłącznie intencje. Czy ruch jest legalny, rozstrzyga serwer.
	%AddAiButton.pressed.connect(NetworkManager.add_ai_player)
	%StartButton.pressed.connect(_on_start_pressed)
	%WaitingLeaveButton.pressed.connect(_on_leave_pressed)
	# Licytacja: panel sprawdza ofiarę (BidRules) i dopiero poprawną wysyła do serwera.
	_bidding.offer_confirmed.connect(NetworkManager.submit_bid)
	%MoveButton.pressed.connect(func() -> void: NetworkManager.move_units(_from_edit.text.strip_edges(), _to_edit.text.strip_edges(), int(_count.value)))
	# Tryb budowy na planszy: podświetlone wyspy z wolnym miejscem, kliknięcie wyspy to rozkaz budowy.
	%BuildButton.pressed.connect(func() -> void: _board.highlight_valid_moves("", MoveRules.BUILD))
	%EndTurnButton.pressed.connect(NetworkManager.end_turn)
	%LeaveButton.pressed.connect(_on_leave_pressed)

	# Plansza: wybór pola, cel ruchu, wyspa do budowy i podpowiedzi.
	_board.selection_changed.connect(_on_board_selection)
	_board.move_requested.connect(_on_board_move)
	_board.build_requested.connect(func(island_id: String) -> void: NetworkManager.build(island_id))
	_board.hint_changed.connect(func(text: String) -> void: _hint.text = text)

	# Sygnały sieci (ekran gier LAN sam obsługuje swoje przyciski i komunikaty).
	NetworkManager.server_started.connect(_on_server_started)
	NetworkManager.connection_succeeded.connect(_on_connection_succeeded)
	NetworkManager.connection_failed.connect(_on_connection_failed)
	NetworkManager.server_disconnected.connect(_on_server_disconnected)
	NetworkManager.lobby_changed.connect(_on_lobby_changed)
	NetworkManager.action_rejected.connect(_on_action_rejected)

	# Sygnały stanu gry.
	GameStateManager.view_changed.connect(_on_view_changed)
	GameStateManager.battle_reported.connect(_on_battle_reported)
	_show_screen(_browser)


# =============================================================================
# Poczekalnia
# =============================================================================

func _on_server_started(port: int) -> void:
	_log("Serwer działa na porcie %d." % port)
	_show_screen(_waiting)


func _on_connection_succeeded(player_id: String) -> void:
	_log("Połączono. Twoje miejsce: %s." % player_id)
	if GameStateManager.view.is_empty():
		_show_screen(_waiting)


func _on_start_pressed() -> void:
	var result := NetworkManager.start_game()
	if not result["ok"]:
		_log("[color=orange]%s[/color]" % result["message"])


func _on_leave_pressed() -> void:
	NetworkManager.leave_game()
	_show_screen(_browser)


func _on_lobby_changed(players: Array, settings: Dictionary) -> void:
	var names := PackedStringArray()
	for player in players:
		names.append("%s%s" % [player["name"], " (AI)" if player["is_ai"] else ""])
	var modules := PackedStringArray()
	if settings.get("hades", false):
		modules.append("Hades")
	if settings.get("monuments", false):
		modules.append("Monumenty")
	_waiting_label.text = "Poczekalnia gry „%s” (%s). Przy stole %d/%d: %s." % [
		settings.get("server_name", ""), ", ".join(modules) if not modules.is_empty() else "podstawka",
		players.size(), NetworkManager.MAX_PLAYERS, ", ".join(names),
	]
	var is_host := NetworkManager.mode == NetworkManager.Mode.HOST
	%AddAiButton.visible = is_host
	%StartButton.visible = is_host


func _on_connection_failed(code: String, message: String) -> void:
	_log("[color=red]%s (%s)[/color]" % [message, code])
	_show_screen(_browser)


## Host zniknął. Jeśli to chwilowa awaria sieci, żeton miejsca pozwala wrócić do partii.
func _on_server_disconnected() -> void:
	_log("[color=red]Utracono połączenie z hostem. Próba powrotu za 2 s…[/color]")
	await get_tree().create_timer(2.0).timeout
	if NetworkManager.reconnect() != OK:
		_show_screen(_browser)


# =============================================================================
# Partia
# =============================================================================

func _on_action_rejected(code: String, message: String) -> void:
	_log("[color=orange]Odmowa (%s): %s[/color]" % [code, message])
	_bidding.on_action_rejected(code, message)


## Wybrane pole startowe trafia do pola „skąd”, a licznik pokazuje, ile jednostek można zabrać (domyślnie wszystkie).
func _on_board_selection(territory_id: String, action_type: String, _targets: Dictionary) -> void:
	if territory_id == "" or action_type == MoveRules.BUILD:
		return
	_from_edit.text = territory_id
	_count.value = MoveRules.movable_units(GameStateManager.view, territory_id)


func _on_board_move(from_id: String, to_id: String, _action_type: String) -> void:
	_to_edit.text = to_id
	var movable := MoveRules.movable_units(GameStateManager.view, from_id)
	NetworkManager.move_units(from_id, to_id, clampi(int(_count.value), 1, maxi(1, movable)))


func _on_view_changed(view: Dictionary) -> void:
	if view.is_empty():
		return
	_show_screen(_game)
	if view["game_id"] != _game_id:
		_game_id = view["game_id"]
		_last_event = 0
	var me: Dictionary = view["players"][view["you"]]
	var actor := GameState.actor_of(view)
	var actor_name: String = view["players"][actor]["name"] if actor != "" else "–"
	_status.text = "Cykl %d · %s · Ty: %s (%d JZ) · Ruch: %s%s" % [
		view["cycle"], _phase_name(view), me["name"], me["gold"], actor_name, " (TWÓJ)" if GameStateManager.is_my_turn() else "",
	]
	# Licytacja: tory ofiar. Tury bogów: ruch, budowa i koniec tury.
	var actions: bool = view["phase"] == "ACTIONS"
	_bidding.visible = view["phase"] == "BIDDING"
	_move_row.visible = actions
	%BuildButton.visible = actions
	%EndTurnButton.visible = actions
	# Nowe zdarzenia z dziennika partii (ofiary, przebicia, ruchy, rozłączenia…).
	for event in view["log"]:
		if int(event["seq"]) > _last_event:
			_last_event = int(event["seq"])
			_log(_describe(view, event))


func _on_battle_reported(report: Dictionary) -> void:
	var view := GameStateManager.view
	_log("[b]Bitwa o %s: atakuje %s, broni %s[/b]" % [report["location"], _player_name_in(view, report["attacker"]), _player_name_in(view, report["defender"])])
	for battle_round in report["rounds"]:
		_log("  Runda %d: atak [%s] | obrona [%s]" % [battle_round["round"], _score(battle_round["attacker"]), _score(battle_round["defender"])])
	_log("  Wynik: %s" % OUTCOMES.get(report["outcome"], report["outcome"]))


# =============================================================================
# Pomocnicze
# =============================================================================

func _describe(view: Dictionary, event: Dictionary) -> String:
	var who := _player_name_in(view, event.get("player", ""))
	match event["type"]:
		"CYCLE":
			return "[b]Cykl %d. Bogowie na torze: %s[/b]" % [event["cycle"], ", ".join(PackedStringArray(event["gods"]))]
		"INCOME":
			return "%s: dochód %d JZ" % [who, event["gold"]]
		"OFFER":
			return "%s: %d JZ dla %s" % [who, event["amount"], event["god"]]
		"OUTBID":
			var text := "%s przebija ofiarę gracza %s na %s (%d JZ)" % [_player_name_in(view, event["by"]), who, event["god"], event["amount"]]
			return "[b]%s. Wybierz innego boga albo Apolla![/b]" % text if event["player"] == view["you"] else text
		"APOLLO":
			return "%s idzie do Apolla (miejsce %d)" % [who, event["position"]]
		"BIDDING_CLOSED":
			return "Licytacja zamknięta. Zaczynają się tury bogów."
		"MOVE":
			return "%s: ruch %s → %s (%d)%s" % [who, event["from"], event["to"], event["count"], " na Pegazie" if event.get("via", "") == "PEGASUS" else ""]
		"BUILD":
			return "%s buduje %s na %s" % [who, event["building"], event["island"]]
		"RECRUIT":
			var place := " na %s" % event["target"] if event["target"] != "" else ""
			return "%s: nowy %s%s (%d JZ)" % [who, RECRUITS.get(event["kind"], event["kind"]), place, event["cost"]]
		"METROPOLIS":
			if event["island"] == "":
				return "%s: nowa Metropolia zastępuje starą (brak wyspy bez Metropolii)" % who
			return "[b]%s zakłada Metropolię na %s[/b]" % [who, event["island"]]
		"CREATURE":
			return "%s przyzywa stwora: %s (%d JZ)" % [who, event["creature"], event["cost"]]
		"SWAP_CREATURE":
			return "%s (Zeus) odrzuca kartę %s, na tor wchodzi %s" % [who, event["discarded"], event["drawn"] if event["drawn"] != "" else "–"]
		"GIANT":
			return "Gigant niszczy %s na %s" % [event["building"], event["island"]]
		"HARPY":
			return "Harpia porywa oddział z %s" % event["island"]
		"KRAKEN":
			return "Kraken wynurza się na %s (zniszczone pola z flotami: %d)" % [event["sea"], event["destroyed"].size()]
		"MINOTAUR":
			return "Minotaur strzeże wyspy %s" % event["island"]
		"MINOTAUR_GONE":
			return "Minotaur opuszcza wyspę %s" % event["island"]
		"GAME_OVER":
			return "[b]Koniec gry! Wygrywa: %s[/b]" % _winner_names(view)
		"BATTLE":
			return "Bitwa o %s: %s" % [event["location"], OUTCOMES.get(event["outcome"], event["outcome"])]
		"END_TURN":
			return "%s kończy turę" % who
		"CONNECTION":
			return "%s %s" % [who, "wraca do gry" if event["connected"] else "traci połączenie (miejsce czeka na powrót)"]
		"AI_TAKEOVER":
			return "Miejsce gracza %s przejmuje komputer" % who
	return str(event)


func _score(side: Dictionary) -> String:
	var parts := PackedStringArray(["kość %d" % side["roll"], "jednostki %d" % side["units"]])
	for modifier in side["modifiers"]:
		parts.append("%s (%s) +%d" % [MODIFIERS.get(modifier["source"], modifier["source"]), modifier["island"], modifier["value"]])
	return "%s = %d%s" % [", ".join(parts), side["total"], ", strata" if side["loss"] else ""]


func _phase_name(view: Dictionary) -> String:
	match view["phase"]:
		"BIDDING":
			return "licytacja"
		"ACTIONS":
			return "tura boga %s" % GameState.god_of(view)
		"GAME_OVER":
			return "koniec gry, wygrywa: %s" % _winner_names(view)
	return String(view["phase"])


func _winner_names(view: Dictionary) -> String:
	var names := PackedStringArray()
	for winner in view.get("winners", []):
		names.append(_player_name_in(view, winner))
	return ", ".join(names)


func _player_name_in(view: Dictionary, player_id: String) -> String:
	return String(view.get("players", {}).get(player_id, {}).get("name", player_id))


func _show_screen(screen: Control) -> void:
	for candidate: Control in [_browser, _waiting, _game]:
		candidate.visible = candidate == screen


func _log(text: String) -> void:
	_log_label.append_text(text + "\n")
