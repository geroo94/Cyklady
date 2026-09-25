## NetworkManager: warstwa sieciowa Cyklad na wysokopoziomowym API Godota (ENetMultiplayerPeer).
##
## TRYBY
##   HOST           serwer ENet na porcie DEFAULT_PORT dla całej sieci lokalnej; gospodarz gra lokalnie.
##   SINGLE_PLAYER  ten sam serwer, ale nasłuchuje tylko na 127.0.0.1, a wolne miejsca zajmuje AI.
##   CLIENT         połączenie z hostem; klient wysyła wyłącznie intencje.
##
## SERWER DECYDUJE (server-authoritative)
##   Klient wywołuje na serwerze (peer 1) rpc_submit_bid, rpc_move_units, rpc_build
##   albo rpc_end_turn. Serwer ustala gracza z ID nadawcy
##   (multiplayer.get_remote_sender_id()), a nie z treści wiadomości, więc nikt
##   nie zagra za kogoś innego. Reguły sprawdza GameStateManager. Wynik wraca jako
##   rpc_sync_game_state (każdy gracz dostaje własną projekcję stanu) albo jako
##   rpc_action_rejected (tylko do nadawcy). Host wykonuje swoje akcje lokalnie tym
##   samym kodem, bez sieci.
##
## ROZŁĄCZENIA
##   Przed startem wyjście z gry zwalnia miejsce. W trakcie partii stan gracza zostaje
##   na serwerze nietknięty, a miejsce czeka `reconnect_window_sec` na powrót
##   z żetonem (session_token). Potem przejmuje je AI, więc partia się nie zawiesza.
##
## OGŁOSZENIA LAN
##   Host w trybie HOST uruchamia LanBeacon: co 1,5 s nazwa gry, port, liczba graczy
##   i dodatki trafiają pakietem UDP broadcast do sieci lokalnej. Każda zmiana w lobby
##   (dołączenie, AI, start partii) wysyła ogłoszenie od razu. Gra solo się nie ogłasza.
extends Node

const GameState := preload("res://autoload/GameStateManager.gd")

## Serwer wystartował (host LAN albo gra solo).
signal server_started(port: int)
## Klient: serwer przyjął gracza (także po powrocie z żetonem).
signal connection_succeeded(player_id: String)
## Klient: nie udało się połączyć albo serwer odmówił przyjęcia (np. RECONNECT_EXPIRED).
signal connection_failed(code: String, message: String)
## Serwer: nowe połączenie ENet (jeszcze bez miejsca przy stole).
signal peer_connected(peer_id: int)
## Serwer: połączenie zniknęło (gracz wyszedł albo zerwało się połączenie).
signal peer_disconnected(peer_id: int)
## Klient: host zakończył grę albo połączenie z nim zostało zerwane.
signal server_disconnected
## Wszyscy: skład lobby [{ "id", "name", "is_ai" }] i ustawienia { "server_name", "hades", "monuments" }.
signal lobby_changed(players: Array, settings: Dictionary)
## Wszyscy: serwer odrzucił akcję lokalnego gracza.
signal action_rejected(code: String, message: String)

const DEFAULT_PORT := 8910
## Gra solo korzysta z osobnych portów, żeby nie kolidowała z serwerem LAN.
const SINGLE_PLAYER_PORTS: Array[int] = [8911, 8912, 8913, 8914, 8915]
const MAX_PLAYERS := 5
const MIN_PLAYERS := 3
const NAME_MAX_LENGTH := 24

enum Mode { OFFLINE, HOST, SINGLE_PLAYER, CLIENT }

## Ile sekund miejsce rozłączonego gracza czeka na jego powrót. Potem gra za niego AI.
@export var reconnect_window_sec := 60.0
## Po ilu ms bez potwierdzeń ENet uznaje drugą stronę za rozłączoną (np. zerwane Wi-Fi).
@export var peer_timeout_ms := 10000
## Ile sekund nowe połączenie ma na rejestrację (rpc_register), zanim serwer je zamknie.
@export var register_timeout_sec := 10.0
## Czy host LAN ogłasza grę w sieci lokalnej (LanBeacon).
@export var discovery_enabled := true
## Adresy ogłoszeń. Domyślnie ogólny broadcast; testy podają 127.0.0.1.
@export var discovery_targets: PackedStringArray = PackedStringArray(["255.255.255.255"])
## Czy ogłaszać też na x.y.z.255 lokalnych podsieci (patrz LanBeacon).
@export var discovery_subnet_broadcasts := true
## Porty ogłoszeń (muszą się zgadzać z portami LanListener u graczy).
@export var discovery_ports: Array[int] = LanBeacon.DISCOVERY_PORTS
## Porty gry solo (tylko 127.0.0.1): serwer zajmuje pierwszy wolny.
@export var single_player_ports: Array[int] = SINGLE_PLAYER_PORTS
## Odstęp między ogłoszeniami. Zmiany w lobby i tak wychodzą od razu.
@export var discovery_interval_sec := 1.5

var mode: Mode = Mode.OFFLINE
## Miejsce lokalnego gracza przy stole (p1…p5).
var local_player_id := ""
## Klient: żeton miejsca od serwera. Pozwala wrócić do trwającej partii przez reconnect().
var session_token := ""
## Host: nazwa gry widoczna na liście gier LAN.
var server_name := ""
## Host: dodatki wybrane w lobby (ogłaszane w LAN i zapisywane w stanie partii).
var expansions := {"hades": false, "monuments": false}

var _player_name := ""
var _server_address := ""
var _server_port := 0
## Serwer: miejsca przy stole, player_id → { name, token, peer_id, is_ai, connected, serial }.
var _seats: Dictionary = {}
## Serwer: zarejestrowane połączenia, peer_id → player_id.
var _peer_to_player: Dictionary = {}
## Serwer: żetony miejsc, które po upływie okna powrotu przejęło AI.
var _expired_tokens: Dictionary = {}
var _crypto := Crypto.new()
var _beacon: LanBeacon

## Stan gry to rodzeństwo w drzewie: autoload /root/GameStateManager (albo węzeł obok w testach).
@onready var game_state: GameState = get_parent().get_node_or_null("GameStateManager") as GameState


func _ready() -> void:
	assert(game_state != null, "GameStateManager musi być autoloadem dodanym PRZED NetworkManager.")
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.connected_to_server.connect(_on_connected_to_server)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)
	game_state.state_committed.connect(_broadcast_state)
	game_state.battle_resolved.connect(_broadcast_battle)
	game_state.offering_displaced.connect(_broadcast_bid_displaced)


# =============================================================================
# Uruchamianie i zamykanie gry
# =============================================================================

## Host gry LAN: serwer ENet na wszystkich interfejsach. Gospodarz od razu zajmuje miejsce p1,
## a gra zaczyna się ogłaszać w sieci lokalnej. `options`: { "server_name", "hades", "monuments" }.
func host_game(player_name: String, port: int = DEFAULT_PORT, options: Dictionary = {}) -> Error:
	var error := _start_server(Mode.HOST, player_name, port, "*")
	if error != OK:
		return error
	var requested := String(options.get("server_name", "")).strip_edges()
	server_name = (requested if requested != "" else "Gra: %s" % _clean_name(player_name)).left(LanBeacon.MAX_NAME_LENGTH)
	expansions = {"hades": bool(options.get("hades", false)), "monuments": bool(options.get("monuments", false))}
	if discovery_enabled:
		_start_beacon()
	_broadcast_lobby()
	return OK


## Host: dodatki włączone w lobby (przed startem partii).
func set_expansions(hades: bool, monuments: bool) -> Dictionary:
	if not _is_host() or game_state.is_game_running():
		return GameState._fail("NOT_ALLOWED", "Dodatki zmienia host przed startem partii.")
	expansions = {"hades": hades, "monuments": monuments}
	_broadcast_lobby()
	return GameState._ok()


## Gra solo: ten sam serwer na 127.0.0.1 (niewidoczny w sieci), wolne miejsca zajmuje AI.
func start_single_player(player_name: String, ai_players: int = 2) -> Error:
	var error := ERR_CANT_CREATE
	for port in single_player_ports:
		error = _start_server(Mode.SINGLE_PLAYER, player_name, port, "127.0.0.1")
		if error == OK:
			break
	if error != OK:
		return error
	for i in ai_players:
		add_ai_player()
	var started := start_game()
	return OK if started["ok"] else ERR_INVALID_PARAMETER


## Klient: połączenie z hostem. `token` z poprzedniej sesji pozwala wrócić na swoje miejsce.
func join_game(address: String, port: int, player_name: String, token: String = "") -> Error:
	if token == "":
		leave_game()
	else:
		# Powrót do tej samej partii: ostatnia projekcja zostaje na ekranie do nadejścia pełnej migawki.
		_close_peer()
	var peer := ENetMultiplayerPeer.new()
	var error := peer.create_client(address, port)
	if error != OK:
		return error
	multiplayer.multiplayer_peer = peer
	mode = Mode.CLIENT
	_player_name = player_name
	_server_address = address
	_server_port = port
	session_token = token
	return OK


## Klient: powrót do tego samego hosta i na to samo miejsce (np. po zerwaniu połączenia).
func reconnect() -> Error:
	if _server_address == "" or session_token == "":
		return ERR_UNCONFIGURED
	return join_game(_server_address, _server_port, _player_name, session_token)


## Wyjście z gry (klient) albo zamknięcie serwera (host). Czyści miejsca i stan partii.
func leave_game() -> void:
	# Najpierw miejsca: rozłączenia wywołane zamknięciem nie uruchomią już okien powrotu.
	_seats.clear()
	_peer_to_player.clear()
	_expired_tokens.clear()
	_stop_beacon()
	_close_peer()
	local_player_id = ""
	session_token = ""
	server_name = ""
	expansions = {"hades": false, "monuments": false}
	_player_name = ""
	_server_address = ""
	_server_port = 0
	game_state.reset()


## Host: gracz AI na wolnym miejscu w lobby. Zwraca jego ID albo pusty napis.
func add_ai_player() -> String:
	if not _is_host() or game_state.is_game_running() or _seats.size() >= MAX_PLAYERS:
		return ""
	var bots := _seats.values().filter(func(seat: Dictionary) -> bool: return seat["is_ai"])
	var player_id := _add_seat("AI %d" % (bots.size() + 1), 0, true)
	_broadcast_lobby()
	return player_id


## Host: start partii z graczami z lobby (wcześniej można dodać AI na wolne miejsca).
func start_game() -> Dictionary:
	if not _is_host():
		return GameState._fail("NOT_HOST", "Partię rozpoczyna host.")
	if game_state.is_game_running():
		return GameState._fail("GAME_ALREADY_STARTED", "Partia już trwa.")
	if _seats.size() < MIN_PLAYERS:
		return GameState._fail("NOT_ENOUGH_PLAYERS", "Do startu potrzeba co najmniej %d graczy (jest %d). Dodaj AI." % [MIN_PLAYERS, _seats.size()])
	var players: Array = []
	for player_id in _sorted_seat_ids():
		var seat: Dictionary = _seats[player_id]
		players.append({"id": player_id, "name": seat["name"], "is_ai": seat["is_ai"]})
	# Nowy stan zatwierdza GameStateManager, a _broadcast_state rozsyła go graczom.
	var result := game_state.start_new_game(players, expansions)
	_announce()  # ogłoszenie: partia trwa
	return result


# =============================================================================
# Intencje lokalnego gracza (API dla UI)
# =============================================================================

## Ofiara dla boga albo Apollo (`GameStateManager.APOLLO`, kwota bez znaczenia).
func submit_bid(god_id: String, amount: int) -> void:
	if _is_host():
		_report(game_state.apply_bid(local_player_id, god_id, amount))
	elif _is_connected_client():
		rpc_submit_bid.rpc_id(1, god_id, amount)


## Ruch wojsk (wyspa → wyspa) albo flot (morze → morze).
func move_units(from_id: String, to_id: String, count: int) -> void:
	if _is_host():
		_report(game_state.apply_move(local_player_id, from_id, to_id, count))
	elif _is_connected_client():
		rpc_move_units.rpc_id(1, from_id, to_id, count)


## Budynek boga, którego tura trwa, na własnej wyspie.
func build(island_id: String) -> void:
	if _is_host():
		_report(game_state.apply_build(local_player_id, island_id))
	elif _is_connected_client():
		rpc_build.rpc_id(1, island_id)


## Koniec tury boga.
func end_turn() -> void:
	if _is_host():
		_report(game_state.apply_end_turn(local_player_id))
	elif _is_connected_client():
		rpc_end_turn.rpc_id(1)


# =============================================================================
# RPC: klient → serwer (intencje, walidowane wyłącznie na serwerze)
# =============================================================================

## Rejestracja po połączeniu: nowe miejsce w lobby albo powrót na miejsce z żetonem.
@rpc("any_peer", "call_remote", "reliable")
func rpc_register(player_name: String, token: String) -> void:
	if not _is_host():
		return
	var peer_id := multiplayer.get_remote_sender_id()
	if _peer_to_player.has(peer_id):
		return
	var seat_id := _seat_with_token(token)
	if seat_id != "":
		_rebind_seat(seat_id, peer_id)
	elif token != "" and _expired_tokens.has(token):
		_refuse(peer_id, "RECONNECT_EXPIRED", "Minął czas na powrót do partii. Miejsce przejął komputer.")
	elif mode == Mode.SINGLE_PLAYER:
		_refuse(peer_id, "SINGLE_PLAYER", "To jest gra solo.")
	elif game_state.is_game_running():
		_refuse(peer_id, "GAME_IN_PROGRESS", "Partia już trwa. Wrócić można tylko z żetonem miejsca.")
	elif _seats.size() >= MAX_PLAYERS:
		_refuse(peer_id, "ROOM_FULL", "Wszystkie miejsca są zajęte.")
	else:
		var player_id := _add_seat(player_name, peer_id, false)
		rpc_registered.rpc_id(peer_id, player_id, _seats[player_id]["token"])
		_broadcast_lobby()


@rpc("any_peer", "call_remote", "reliable")
func rpc_submit_bid(god_id: String, amount: int) -> void:
	_handle_intent(func(player_id: String) -> Dictionary: return game_state.apply_bid(player_id, god_id, amount))


@rpc("any_peer", "call_remote", "reliable")
func rpc_move_units(from_id: String, to_id: String, count: int) -> void:
	_handle_intent(func(player_id: String) -> Dictionary: return game_state.apply_move(player_id, from_id, to_id, count))


@rpc("any_peer", "call_remote", "reliable")
func rpc_build(island_id: String) -> void:
	_handle_intent(func(player_id: String) -> Dictionary: return game_state.apply_build(player_id, island_id))


@rpc("any_peer", "call_remote", "reliable")
func rpc_end_turn() -> void:
	_handle_intent(func(player_id: String) -> Dictionary: return game_state.apply_end_turn(player_id))


## Wspólna obsługa intencji na serwerze: gracz wynika z połączenia, a nie z treści wiadomości.
func _handle_intent(action: Callable) -> void:
	if not _is_host():
		return
	var peer_id := multiplayer.get_remote_sender_id()
	var player_id := String(_peer_to_player.get(peer_id, ""))
	if player_id == "":
		rpc_action_rejected.rpc_id(peer_id, "NOT_REGISTERED", "Najpierw dołącz do gry.")
		return
	var result: Dictionary = action.call(player_id)
	if not result["ok"]:
		rpc_action_rejected.rpc_id(peer_id, result["code"], result["message"])


# =============================================================================
# RPC: serwer → klient (tylko autorytet, czyli serwer, może je wywołać)
# =============================================================================

## Serwer przyjął gracza: jego miejsce i żeton powrotu.
@rpc("authority", "call_remote", "reliable")
func rpc_registered(player_id: String, token: String) -> void:
	local_player_id = player_id
	session_token = token
	connection_succeeded.emit(player_id)


## Serwer odmówił przyjęcia (partia trwa, brak miejsc, żeton wygasł…).
@rpc("authority", "call_remote", "reliable")
func rpc_registration_refused(code: String, message: String) -> void:
	connection_failed.emit(code, message)


@rpc("authority", "call_remote", "reliable")
func rpc_lobby_state(players: Array, settings: Dictionary) -> void:
	lobby_changed.emit(players, settings)


## Pełna projekcja stanu gry dla tego gracza (po każdej zmianie i po powrocie).
@rpc("authority", "call_remote", "reliable")
func rpc_sync_game_state(state_data: Dictionary) -> void:
	game_state.apply_view(state_data)


## Raport bitwy: rzuty, jednostki, modyfikatory (Fortece, Porty), straty i wynik.
@rpc("authority", "call_remote", "reliable")
func rpc_notify_battle(battle_data: Dictionary) -> void:
	game_state.report_battle(battle_data)


## Przebita ofiara: kogo przebito, u którego boga, kto i za ile. Przychodzi przed nowym stanem gry.
@rpc("authority", "call_remote", "reliable")
func rpc_notify_bid_displaced(event: Dictionary) -> void:
	game_state.report_bid_displaced(event)


@rpc("authority", "call_remote", "reliable")
func rpc_action_rejected(code: String, message: String) -> void:
	action_rejected.emit(code, message)


# =============================================================================
# Serwer: rozsyłanie
# =============================================================================

## Po każdej zmianie stanu każdy gracz dostaje własną projekcję: host lokalnie, klienci przez RPC.
func _broadcast_state() -> void:
	if not _is_host():
		return
	for player_id in _seats:
		var seat: Dictionary = _seats[player_id]
		var peer_id := int(seat["peer_id"])
		if seat["is_ai"] or peer_id == 0:
			continue
		var projection := game_state.project_for(player_id)
		if peer_id == multiplayer.get_unique_id():
			game_state.apply_view(projection)
		else:
			rpc_sync_game_state.rpc_id(peer_id, projection)


## Raport bitwy trafia do wszystkich graczy w tej samej chwili, przed nowym stanem gry.
func _broadcast_battle(report: Dictionary) -> void:
	if not _is_host():
		return
	for peer_id in _peer_to_player:
		if peer_id != multiplayer.get_unique_id():
			rpc_notify_battle.rpc_id(peer_id, report)
	game_state.report_battle(report)


## Przebicie ofiary: wszyscy gracze od razu, przed nowym stanem gry (przebity widzi, u którego boga stracił miejsce).
func _broadcast_bid_displaced(event: Dictionary) -> void:
	if not _is_host():
		return
	for peer_id in _peer_to_player:
		if peer_id != multiplayer.get_unique_id():
			rpc_notify_bid_displaced.rpc_id(peer_id, event)
	game_state.report_bid_displaced(event)


func _broadcast_lobby() -> void:
	var roster: Array = []
	for player_id in _sorted_seat_ids():
		var seat: Dictionary = _seats[player_id]
		roster.append({"id": player_id, "name": seat["name"], "is_ai": seat["is_ai"]})
	var settings := {"server_name": server_name, "hades": expansions["hades"], "monuments": expansions["monuments"]}
	for peer_id in _peer_to_player:
		if peer_id != multiplayer.get_unique_id():
			rpc_lobby_state.rpc_id(peer_id, roster, settings)
	lobby_changed.emit(roster, settings)
	_announce()  # nowa liczba graczy od razu w ogłoszeniu LAN


# =============================================================================
# Ogłoszenia LAN (host)
# =============================================================================

func _start_beacon() -> void:
	_stop_beacon()
	_beacon = LanBeacon.new()
	_beacon.name = "LanBeacon"
	_beacon.targets = discovery_targets
	_beacon.subnet_broadcasts = discovery_subnet_broadcasts
	_beacon.discovery_ports = discovery_ports
	_beacon.interval_sec = discovery_interval_sec
	add_child(_beacon)
	if _beacon.start(_beacon_info) != OK:
		push_warning("Nie udało się uruchomić ogłoszeń LAN. Gracze mogą połączyć się przez IP.")


func _stop_beacon() -> void:
	if _beacon != null:
		_beacon.stop()
		_beacon.queue_free()
		_beacon = null


## Opis gry do ogłoszenia, liczony przy każdym ogłoszeniu.
func _beacon_info() -> Dictionary:
	return {
		"server_name": server_name,
		"port": _server_port,
		"current_players": _seats.size(),
		"max_players": MAX_PLAYERS,
		"has_hades": expansions["hades"],
		"has_monuments": expansions["monuments"],
		"in_game": game_state.is_game_running(),
	}


func _announce() -> void:
	if _beacon != null:
		_beacon.announce_now()


# =============================================================================
# Połączenia
# =============================================================================

func _on_peer_connected(peer_id: int) -> void:
	if not _is_host():
		return
	if mode == Mode.SINGLE_PLAYER:
		multiplayer.multiplayer_peer.disconnect_peer(peer_id)  # gra solo: bez gości z zewnątrz
		return
	_configure_timeout(peer_id)
	peer_connected.emit(peer_id)
	# Połączenie ma chwilę na rejestrację. Potem je zamykamy, żeby nie blokowało miejsc w ENet.
	get_tree().create_timer(register_timeout_sec).timeout.connect(_drop_if_unregistered.bind(peer_id))


## Zabezpieczenie stanu gry przy rozłączeniu: w trakcie partii nic w stanie gracza
## się nie zmienia poza flagą połączenia, a miejsce czeka na powrót z żetonem.
func _on_peer_disconnected(peer_id: int) -> void:
	if not _is_host():
		return
	peer_disconnected.emit(peer_id)
	var player_id := String(_peer_to_player.get(peer_id, ""))
	_peer_to_player.erase(peer_id)
	if player_id == "" or not _seats.has(player_id):
		return
	var seat: Dictionary = _seats[player_id]
	seat["peer_id"] = 0
	if not game_state.is_game_running():
		_seats.erase(player_id)  # lobby: miejsce wolne dla kolejnego gracza
		_broadcast_lobby()
		return
	seat["connected"] = false
	seat["serial"] = int(seat["serial"]) + 1
	var deadline := Time.get_unix_time_from_system() + reconnect_window_sec
	get_tree().create_timer(reconnect_window_sec).timeout.connect(_on_reconnect_window_closed.bind(player_id, int(seat["serial"])))
	game_state.set_player_connected(player_id, false, deadline)


## Okno powrotu minęło: miejsce przejmuje AI (od razu gra, jeśli to jego tura), a żeton wygasa.
func _on_reconnect_window_closed(player_id: String, serial: int) -> void:
	var seat: Dictionary = _seats.get(player_id, {})
	if seat.is_empty() or seat["connected"] or int(seat["serial"]) != serial or not game_state.is_game_running():
		return
	_expired_tokens[seat["token"]] = true
	seat["token"] = ""
	seat["is_ai"] = true
	seat["connected"] = true
	game_state.set_player_ai(player_id)


func _on_connected_to_server() -> void:
	_configure_timeout(1)
	rpc_register.rpc_id(1, _player_name, session_token)


func _on_connection_failed() -> void:
	var address := "%s:%d" % [_server_address, _server_port]
	_close_peer()
	connection_failed.emit("CONNECTION_FAILED", "Nie udało się połączyć z %s." % address)


## Klient traci hosta. Ostatnia projekcja zostaje na ekranie, a żeton i adres pozwalają wrócić (reconnect).
func _on_server_disconnected() -> void:
	_close_peer()
	server_disconnected.emit()


## Powrót z żetonem: nowe połączenie przejmuje miejsce, stare (np. półotwarte) zostaje zamknięte.
func _rebind_seat(player_id: String, peer_id: int) -> void:
	var seat: Dictionary = _seats[player_id]
	var old_peer := int(seat["peer_id"])
	if old_peer != 0 and old_peer != peer_id:
		_peer_to_player.erase(old_peer)
		multiplayer.multiplayer_peer.disconnect_peer(old_peer)
	seat["peer_id"] = peer_id
	seat["connected"] = true
	seat["serial"] = int(seat["serial"]) + 1  # unieważnia odliczanie okna powrotu
	_peer_to_player[peer_id] = player_id
	rpc_registered.rpc_id(peer_id, player_id, seat["token"])
	if game_state.is_game_running():
		# Zatwierdzenie stanu rozsyła projekcje wszystkim, więc wracający dostaje pełną migawkę.
		game_state.set_player_connected(player_id, true)
	else:
		_broadcast_lobby()


## Odmowa rejestracji. Rozłączenie następuje po chwili, bo ENet kasuje niewysłane pakiety.
func _refuse(peer_id: int, code: String, message: String) -> void:
	rpc_registration_refused.rpc_id(peer_id, code, message)
	get_tree().create_timer(0.5).timeout.connect(_drop_if_unregistered.bind(peer_id))


func _drop_if_unregistered(peer_id: int) -> void:
	if _is_host() and not _peer_to_player.has(peer_id) and multiplayer.get_peers().has(peer_id):
		multiplayer.multiplayer_peer.disconnect_peer(peer_id)


## Szybsze wykrywanie zerwanych połączeń niż domyślne 30 s w ENet.
func _configure_timeout(peer_id: int) -> void:
	var enet := multiplayer.multiplayer_peer as ENetMultiplayerPeer
	if enet == null:
		return
	var packet_peer := enet.get_peer(peer_id)
	if packet_peer != null:
		packet_peer.set_timeout(0, floori(peer_timeout_ms / 2.0), peer_timeout_ms)


# =============================================================================
# Pomocnicze
# =============================================================================

func _start_server(new_mode: Mode, player_name: String, port: int, bind_ip: String) -> Error:
	leave_game()
	if not _udp_port_free(port, bind_ip):
		return ERR_ALREADY_IN_USE
	var peer := ENetMultiplayerPeer.new()
	peer.set_bind_ip(bind_ip)
	var error := peer.create_server(port, MAX_PLAYERS + 2)  # zapas na połączenia wracających graczy
	if error != OK:
		return error
	# Klienci nie widzą się nawzajem i nie mogą przez serwer wywoływać RPC u innych klientów.
	var scene_multiplayer := multiplayer as SceneMultiplayer
	if scene_multiplayer != null:
		scene_multiplayer.server_relay = false
	multiplayer.multiplayer_peer = peer
	mode = new_mode
	_server_port = port
	local_player_id = _add_seat(player_name, multiplayer.get_unique_id(), false)
	server_started.emit(port)
	_broadcast_lobby()
	return OK


## Czy port UDP jest wolny. ENet przy zajętym porcie wypisuje błąd silnika, a gra solo
## po prostu próbuje kolejnego portu, więc sprawdzamy go wcześniej, po cichu.
static func _udp_port_free(port: int, bind_ip: String) -> bool:
	var probe := PacketPeerUDP.new()
	var free := probe.bind(port, bind_ip) == OK
	probe.close()
	return free


## Adres wpisany przez gracza: "192.168.1.20", "192.168.1.20:8910", "gra.local:8910",
## "[fe80::1]:8910" albo "fe80::1". Zwraca { "host", "port" } albo pusty słownik.
static func parse_address(text: String, default_port: int = DEFAULT_PORT) -> Dictionary:
	var input := text.strip_edges()
	var host := input
	var port_text := ""
	if input.begins_with("["):
		var closing := input.find("]")
		if closing < 0:
			return {}
		host = input.substr(1, closing - 1)
		var rest := input.substr(closing + 1)
		if rest != "":
			if not rest.begins_with(":"):
				return {}
			port_text = rest.substr(1)
		if not (host.is_valid_ip_address() and host.contains(":")):
			return {}
	elif input.count(":") == 1:
		host = input.get_slice(":", 0)
		port_text = input.get_slice(":", 1)
		if port_text == "":
			return {}
	elif input.count(":") > 1:
		if not input.is_valid_ip_address():  # IPv6 bez nawiasów i bez portu
			return {}
	var hostname := RegEx.create_from_string("^[A-Za-z0-9.-]{1,253}$")
	if not host.contains(":") and hostname.search(host) == null:
		return {}
	var port := default_port
	if port_text != "":
		if not port_text.is_valid_int() or port_text.length() > 5:
			return {}
		port = port_text.to_int()
	if port < 1 or port > 65535:
		return {}
	return {"host": host, "port": port}


## Nowe miejsce przy stole: pierwsze wolne p1…p5 i losowy żeton powrotu (tylko dla ludzi).
func _add_seat(player_name: String, peer_id: int, is_ai: bool) -> String:
	var player_id := ""
	for i in range(1, MAX_PLAYERS + 1):
		if not _seats.has("p%d" % i):
			player_id = "p%d" % i
			break
	_seats[player_id] = {
		"name": _clean_name(player_name),
		"token": "" if is_ai else _crypto.generate_random_bytes(16).hex_encode(),
		"peer_id": peer_id,
		"is_ai": is_ai,
		"connected": true,
		"serial": 0,
	}
	if peer_id != 0:
		_peer_to_player[peer_id] = player_id
	return player_id


func _seat_with_token(token: String) -> String:
	if token == "":
		return ""
	for player_id in _seats:
		if _seats[player_id]["token"] == token:
			return player_id
	return ""


func _sorted_seat_ids() -> Array:
	var ids := _seats.keys()
	ids.sort()
	return ids


func _clean_name(player_name: String) -> String:
	var cleaned := player_name.strip_edges().left(NAME_MAX_LENGTH)
	return cleaned if cleaned != "" else "Gracz"


func _close_peer() -> void:
	var peer := multiplayer.multiplayer_peer
	if peer != null and not (peer is OfflineMultiplayerPeer):
		peer.close()
	multiplayer.multiplayer_peer = OfflineMultiplayerPeer.new()
	mode = Mode.OFFLINE


func _is_host() -> bool:
	return mode == Mode.HOST or mode == Mode.SINGLE_PLAYER


func _is_connected_client() -> bool:
	if mode == Mode.CLIENT and local_player_id != "":
		return true
	action_rejected.emit("NOT_CONNECTED", "Brak połączenia z serwerem.")
	return false


func _report(result: Dictionary) -> void:
	if not result["ok"]:
		action_rejected.emit(result["code"], result["message"])
