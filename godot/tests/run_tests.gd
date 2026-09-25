## Testy bez okna: reguły GameStateManager i prawdziwe połączenia ENet.
##
## Host i klienci działają w jednym procesie, ale każdy „komputer” ma własne
## SceneMultiplayer i własną parę GameStateManager + NetworkManager (ścieżki RPC
## liczone są od korzenia gałęzi, więc wyglądają tak samo jak autoloady).
##
## Plansza (board/) jest testowana prawdziwymi zdarzeniami myszy: zdarzenie
## trafia do okna, przez SubViewportContainer do SubViewport z pickingiem fizyki
## i dalej do TerritoryNode, tak jak kliknięcie gracza.
##
## Uruchomienie:  godot --headless --path godot res://tests/RunTests.tscn
## Kod wyjścia 0: wszystkie testy przeszły.
extends Node

const GameState := preload("res://autoload/GameStateManager.gd")
const Network := preload("res://autoload/NetworkManager.gd")


## Jeden „komputer”: gałąź drzewa z własnym MultiplayerAPI i zapisem sygnałów.
class Machine extends RefCounted:
	var root: Node
	var state: GameState
	var net: Network
	var rejections: Array = []
	var failures: Array = []
	var battles: Array = []
	var lobbies: Array = []
	var server_lost := false
	## Powiadomienia o przebiciu: kogo, oraz co pokazywała wtedy projekcja (przed nowym stanem).
	var displacements: Array = []

	func player_id() -> String:
		return net.local_player_id


## Zbiera błędy silnika i skryptów. Każdy nieoczekiwany błąd oblewa bieżący test.
class ErrorLog extends Logger:
	var _entries: Array[String] = []
	var _mutex := Mutex.new()

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		if error_type == ERROR_TYPE_WARNING:
			return
		_mutex.lock()
		_entries.append("%s %s (%s:%d, %s)" % [code, rationale, file, line, function])
		_mutex.unlock()

	func since(index: int) -> Array[String]:
		_mutex.lock()
		var fresh := _entries.slice(index)
		_mutex.unlock()
		return fresh

	func size() -> int:
		_mutex.lock()
		var count := _entries.size()
		_mutex.unlock()
		return count


var _passed := 0
var _failed := 0
var _errors := ErrorLog.new()
## Fragmenty treści błędów, których spodziewa się bieżący test.
var _allowed_errors: Array[String] = []
var _current_failed := false
var _next_port := 0
var _next_udp_port := 0
## Porty gry solo w tym procesie testów (autoload i „komputery” z testów).
var _single_player_ports: Array[int] = []
## Port ogłoszeń LAN w testach: wszystkie ogłoszenia idą tylko na 127.0.0.1.
var _discovery_port := 0
var _machines_created := 0


func _ready() -> void:
	# Każdy proces testów ma własny pas portów (wg PID), więc równoległe uruchomienia się nie zderzają.
	# Każdy port i tak jest sprawdzany przed użyciem (np. zajęty przez inny program).
	var lane := OS.get_process_id() % 40
	_next_port = 20000 + lane * 100
	_next_udp_port = 24000 + lane * 100
	_discovery_port = 28000 + lane * 4
	for i in 5:
		_single_player_ports.append(29000 + lane * 10 + i)
	OS.add_logger(_errors)
	# Bez okna korzeń ma 64×64 px. Rozmiar projektu, żeby plansza i UI miały gdzie się ułożyć.
	get_tree().root.size = Vector2i(1100, 700)
	# Bezpiecznik: nawet autoload (np. przycisk „Stwórz Grę LAN” w teście UI) ogłasza tylko na 127.0.0.1.
	NetworkManager.discovery_targets = PackedStringArray(["127.0.0.1"])
	NetworkManager.discovery_subnet_broadcasts = false
	NetworkManager.discovery_ports = [_discovery_port]
	NetworkManager.single_player_ports = _single_player_ports
	var tests := [
		["Dane gry: GameData – spójna baza, zgodna z regułami serwera, talie z dodatkami i bez", test_game_data],
		["Stan: nowa partia (złoto, miasta, floty, bogowie, kolejka)", test_new_game],
		["Licytacja: walidacja tury, boga, kwoty i złota", test_bid_validation],
		["Licytacja: przebicie, zakaz powrotu, kapłani, Apollo i kolejność tur", test_outbid_and_settlement],
		["Ruch: most z flot, zasięg floty, obce floty, bóg, koszt, ostatnia wyspa", test_move_validation],
		["Reguły ruchu: most z flot (też nieumarłych), zasięg, obce floty, ostatnia wyspa, bóg, złoto", test_move_rules],
		["Reguły planszy = walidacja serwera (losowe stany: ruchy, bitwy, budowy)", test_rules_match_server],
		["Hades: nieumarli bronią pola i giną pierwsi, morze trzymane przez nieumarłych", test_undead_battle],
		["Bitwa lądowa: Forteca w raporcie, raport zgodny ze stanem", test_land_battle_report],
		["Bitwa morska: Porty obrońcy przy polu bitwy", test_sea_battle_ports],
		["Kość bitewna z CSPRNG: rozkład 0,1,1,2,2,3", test_dice_distribution],
		["Projekcja: złoto rywali ukryte", test_projection],
		["Koniec cyklu: dochód i kolejność licytacji z tur", test_cycle_end],
		["AI: gracze komputerowi licytują sami", test_ai_bidding],
		["LAN: host i dwóch klientów, lobby, start i własne projekcje", test_lan_sync],
		["LAN: tylko serwer decyduje (ruch poza kolejką, podszywanie się pod serwer)", test_server_authority],
		["LAN: przebicie w licytacji przez sieć", test_network_outbid],
		["LAN: bitwa – ten sam raport u wszystkich, stan zgodny", test_network_battle],
		["LAN: rozłączenie w trakcie partii i powrót z pełną migawką", test_disconnect_and_reconnect],
		["LAN: okno powrotu mija – AI przejmuje miejsce i gra, żeton wygasa", test_reconnect_window_expires],
		["LAN: nowy gracz bez żetonu nie wejdzie do trwającej partii", test_late_join_refused],
		["LAN: host kończy grę – klienci dostają server_disconnected", test_server_disconnected],
		["Gra solo: serwer na 127.0.0.1, AI gra samo, gość odrzucony", test_single_player],
		["UI: gra solo z przyciskami sceny Main.tscn (prawdziwe autoloady)", test_main_scene],
		["LAN Discovery: pakiet ogłoszenia – kodowanie, odczyt, obce i uszkodzone pakiety", test_beacon_packet],
		["LAN Discovery: nadajnik → odbiornik przez UDP (found, updated, lost)", test_beacon_to_listener],
		["LAN Discovery: zajęty port – odbiornik bierze kolejny z zakresu", test_listener_port_fallback],
		["LAN Discovery: limit liczby serwerów, duplikaty i adres nadawcy", test_listener_limits],
		["LAN Discovery: host ogłasza grę, lobby i start partii zmieniają ogłoszenie", test_host_announces_game],
		["Połącz przez IP: odczyt adresu wpisanego przez gracza", test_parse_address],
		["UI Lobby: lista gier, dołączenie do wybranej, IP, trwająca partia, nowa gra", test_lan_lobby_ui],
		["Plansza: TerritoryNode – stan, etykieta, shader, najechanie, kliknięcie, zapis sceny", test_territory_node],
		["Plansza: scena zgodna z mapą (pola, typy, sąsiedzi, geometria)", test_board_scene],
		["Plansza: mysz przez SubViewport – najechanie, wybór, podświetlenie, rozkaz, anulowanie", test_board_picking],
		["UI: plansza w Main.tscn – ruch i budowa kliknięciami, serwer przyjmuje rozkazy", test_main_board],
		["Licytacja: reguły wspólne (koszt z kapłanami, minimum 1 JZ, przebicie, zakaz powrotu)", test_bid_rules],
		["Licytacja: walidacja UI = walidacja serwera (losowe stany)", test_bid_rules_match_server],
		["LAN: przebicie – bid_displaced u wszystkich przed nowym stanem, ze szczegółami", test_bid_displaced_notification],
		["UI licytacji: tory, kapłani, walidacja przed RPC, wysłanie, odmowa, Apollo, Hades", test_bidding_board_ui],
		["UI licytacji: przebicie – „Musisz wybrać innego Boga”, animacja znacznika, dźwięk", test_bidding_displacement_ui],
		["UI: licytacja w Main.tscn – kliknięcia, przebicie przez serwer, Apollo", test_main_bidding],
	]
	for entry in tests:
		await _run(entry[0], entry[1])
	OS.remove_logger(_errors)
	print("\n%d testów zaliczonych, %d niezaliczonych" % [_passed, _failed])
	get_tree().quit(0 if _failed == 0 else 1)


# =============================================================================
# Reguły (bez sieci)
# =============================================================================

## Baza treści (autoload GameData): dane spójne, bogowie i budynki zgodni z regułami
## serwera, talie zależne od dodatków, a odczyt zwraca kopie.
func test_game_data() -> void:
	check_eq(GameData.validate(), PackedStringArray(), "baza bez błędów")
	check_eq(GameData.randomized_gods(), PackedStringArray(GameState.GODS), "bogowie losowani na tor = GameStateManager.GODS")
	for god_id: String in MoveRules.GOD_BUILDING:
		check_eq(GameData.god_def(god_id)["building"], MoveRules.GOD_BUILDING[god_id], "budynek boga %s = MoveRules.GOD_BUILDING" % god_id)
	check_eq(GameData.god_def("APOLLO")["gold_bonus"], 1, "Apollo: 1 JZ, tak jak płaci GameStateManager")
	var base := {"hades": false, "monuments": false}
	var full := {"hades": true, "monuments": true}
	check_eq(GameData.gods_for(base), PackedStringArray(["POSEIDON", "ARES", "ZEUS", "ATHENA", "APOLLO"]), "bogowie podstawki")
	check("HADES" in GameData.gods_for(full), "Hades w partii z dodatkiem Hades")
	var deck := GameData.myth_deck(base)
	check_eq(deck.count("PEGASUS"), 2, "karta w talii tyle razy, ile ma kopii")
	check(not deck.has("ACHILLES"), "bez Hadesa nie ma herosów w talii")
	check(GameData.myth_deck(full).has("ACHILLES"), "z Hadesem herosi są w talii stworów")
	check_eq(GameData.myth_card_def("ULYSSES")["type"], "HERO", "karta z talii rozpoznaje herosa")
	check_eq(GameData.monument_deck(base), PackedStringArray(), "bez dodatku Monumenty nie ma kart Monumentów")
	check_eq(GameData.monument_deck(full).size(), GameData.MONUMENTS.size(), "z dodatkiem Monumenty są wszystkie karty")
	var zeus := GameData.god_def("ZEUS")
	zeus["building"] = "PALACE"
	check_eq(GameData.god_def("ZEUS")["building"], "TEMPLE", "odczyt zwraca kopię: jej zmiana nie psuje bazy")
	check(GameData.god_def("HERMES").is_empty(), "nieznany bóg: pusty słownik")
	# Walidator wychwytuje błędy we wpisach.
	var problems := GameData._god_problems("ZEUS", zeus)
	check(problems.size() == 1 and problems[0].contains("PALACE"), "walidator: nieznany budynek (%s)" % [problems])
	zeus.erase("recruits")
	problems = GameData._god_problems("ZEUS", zeus)
	check(problems.size() == 1 and problems[0].contains("recruits"), "walidator: brak pola (%s)" % [problems])


func test_new_game() -> void:
	var gsm := _logic_game()
	var state: Dictionary = gsm._state
	check_eq(state["phase"], "BIDDING", "faza")
	check_eq(state["cycle"], 1, "cykl")
	check_eq(state["gods"].size(), 2, "dwóch bogów dla trzech graczy")
	var queue: Array = state["bidding"]["queue"].duplicate()
	queue.sort()
	check_eq(queue, ["p1", "p2", "p3"], "kolejka licytacji to wszyscy gracze")
	for i in 3:
		var player_id := "p%d" % (i + 1)
		var city: Array = GameState.MAP["cities"][i]
		check_eq(state["players"][player_id]["gold"], GameState.STARTING_GOLD, "złoto startowe %s" % player_id)
		check_eq(state["islands"][city[0]], {"owner": player_id, "troops": 2, "undead_troops": 0, "buildings": [], "monument": ""}, "miasto %s" % player_id)
		check_eq(state["seas"][city[1]], {"owner": player_id, "fleets": 1, "undead_fleets": 0}, "flota %s" % player_id)


func test_bid_validation() -> void:
	var gsm := _logic_game()
	var actor := gsm.current_actor()
	var other := _other_than([actor])
	var god := _god(gsm, 0)
	check_code(gsm.apply_bid(other, god, 1), "NOT_YOUR_TURN")
	check_code(gsm.apply_bid(actor, "HERMES", 1), "UNKNOWN_GOD")
	check_code(gsm.apply_bid(actor, god, 0), "INVALID_AMOUNT")
	check_code(gsm.apply_bid(actor, god, 100), "INVALID_AMOUNT")
	check_code(gsm.apply_bid(actor, god, 6), "CANNOT_AFFORD")
	gsm._state["players"][actor]["priests"] = 2
	check_code(gsm.apply_bid(actor, god, 8), "CANNOT_AFFORD")  # koszt 8 - 2 = 6 JZ
	var revision: int = gsm._state["revision"]
	check_code(gsm.apply_bid(actor, god, 7), "")  # koszt 7 - 2 = 5 JZ: dokładnie tyle, ile gracz ma
	check_eq(gsm._state["revision"], revision + 1, "przyjęta ofiara podbija rewizję")
	check_code(gsm.apply_bid(gsm.current_actor(), god, 7), "BID_TOO_LOW")


func test_outbid_and_settlement() -> void:
	var gsm := _logic_game()
	var order: Array = gsm._state["bidding"]["queue"].duplicate()
	var a: String = order[0]
	var b: String = order[1]
	var c: String = order[2]
	var god_a := _god(gsm, 0)
	var god_b := _god(gsm, 1)
	gsm._state["players"][b]["priests"] = 2
	check_code(gsm.apply_bid(a, god_a, 1), "")
	check_code(gsm.apply_bid(b, god_a, 3), "")  # koszt po kapłanach: max(1, 3 - 2) = 1
	check_eq(gsm.current_actor(), a, "przebity gracz ma pierwszeństwo")
	check_eq(gsm._state["bidding"]["forbidden"], god_a, "bóg zakazany dla przebitego")
	check(_has_event(gsm._state, {"type": "OUTBID", "player": a, "by": b, "god": god_a}), "dziennik ma przebicie")
	check_code(gsm.apply_bid(a, god_a, 4), "FORBIDDEN_GOD")
	check_code(gsm.apply_bid(a, god_b, 1), "")
	check_eq(gsm.current_actor(), c, "po przebitym licytuje dalej kolejka")
	check_code(gsm.apply_bid(c, GameState.APOLLO, 0), "")
	check_eq(gsm._state["phase"], "ACTIONS", "licytacja zamknięta")
	check_eq(gsm._state["turns"], [{"god": god_a, "player": b}, {"god": god_b, "player": a}, {"god": "APOLLO", "player": c}], "kolejność tur")
	check_eq(_gold(gsm, b), 4, "B płaci 1 JZ dzięki kapłanom")
	check_eq(_gold(gsm, a), 4, "A płaci 1 JZ")
	check_eq(_gold(gsm, c), 6, "Apollo daje 1 JZ")


func test_move_validation() -> void:
	var gsm := _logic_game()
	_turn(gsm, "ARES", "p1")
	check_code(gsm.apply_move("p2", "andros", "syros", 1), "NOT_YOUR_TURN")
	check_code(gsm.apply_move("p1", "arch_n", "arch_nw", 1), "WRONG_GOD")
	check_code(gsm.apply_move("p1", "andros", "delos", 1), "NO_FLEET_BRIDGE")
	check_code(gsm.apply_move("p1", "andros", "syros", 3), "NOT_ENOUGH_UNITS")
	check_code(gsm.apply_move("p1", "mykonos", "syros", 1), "NOT_OWNER")
	check_code(gsm.apply_move("p1", "andros", "arch_n", 1), "INVALID_MOVE")
	gsm._state["seas"]["arch_ne"] = _sea("p1", 1)
	check_code(gsm.apply_move("p1", "andros", "mykonos", 1), "LAST_ISLAND_PROTECTED")
	gsm._state["players"]["p1"]["gold"] = 0
	check_code(gsm.apply_move("p1", "andros", "syros", 1), "CANNOT_AFFORD")
	gsm._state["players"]["p1"]["gold"] = 5
	check_code(gsm.apply_move("p1", "andros", "syros", 1), "")
	check_eq(gsm._state["islands"]["syros"], {"owner": "p1", "troops": 1, "undead_troops": 0, "buildings": [], "monument": ""}, "zajęcie wyspy neutralnej")
	check_eq(gsm._state["islands"]["andros"]["troops"], 1, "oddział opuścił Andros")
	check_eq(_gold(gsm, "p1"), 4, "ruch kosztuje 1 JZ")

	var fleets := _logic_game()
	_turn(fleets, "POSEIDON", "p1")
	check_code(fleets.apply_move("p1", "andros", "syros", 1), "WRONG_GOD")  # wojska tylko w turze Aresa
	fleets._state["seas"]["arch_center"] = _sea("p2", 1)
	fleets._state["seas"]["arch_nw"] = _sea("p3", 1)
	check_code(fleets.apply_move("p1", "arch_n", "arch_sw", 1), "OUT_OF_RANGE")  # wszystkie drogi przez obce floty
	fleets._state["seas"]["arch_nw"] = _sea("", 0)
	check_code(fleets.apply_move("p1", "arch_n", "arch_sw", 1), "")  # Pn. → Pn-Zach. → Pd-Zach.
	check_eq(fleets._state["seas"]["arch_n"], {"owner": "", "fleets": 0, "undead_fleets": 0}, "puste morze bez właściciela")
	check_eq(fleets._state["seas"]["arch_sw"]["owner"], "p1", "flota na nowym polu")


func test_move_rules() -> void:
	var state := _rules_state("ARES")
	var troops := MoveRules.MOVE_TROOPS
	check_eq(MoveRules.move_targets(state, "p1", "andros", troops), {"syros": "MOVE"}, "jedna flota: tylko wyspy przy jej morzu")
	state["seas"]["arch_center"] = _sea("p1", 0, 1)
	check_eq(_sorted_keys(MoveRules.move_targets(state, "p1", "andros", troops)), ["delos", "syros"], "flota nieumarłych przedłuża most")
	state["seas"]["arch_ne"] = _sea("p1", 1)
	check(not MoveRules.move_targets(state, "p1", "andros", troops).has("mykonos"), "ostatnia wyspa rywala nie jest celem")
	state["islands"]["paros"] = _isle("p2", 0)
	var targets := MoveRules.move_targets(state, "p1", "andros", troops)
	check_eq([targets.get("mykonos"), targets.get("paros")], ["ATTACK", "MOVE"], "wyspa rywala z wojskiem: atak, bez wojska: zajęcie")
	state["islands"]["paros"] = _isle("p2", 0, [], 1)
	check_eq(MoveRules.move_targets(state, "p1", "andros", troops).get("paros"), "ATTACK", "sami nieumarli też bronią wyspy")
	state["seas"]["arch_ne"] = _sea("p2", 1)
	check(not MoveRules.move_targets(state, "p1", "andros", troops).has("paros"), "obca flota nie jest mostem")
	state["islands"]["andros"]["troops"] = 0
	state["islands"]["andros"]["undead_troops"] = 2
	check_eq(MoveRules.origin_error(state, "p1", "andros", troops), "NO_UNITS", "rozkaz ruchu nie przenosi nieumarłych")
	check_eq(MoveRules.action_error(state, "p1", MoveRules.MOVE_FLEET), "WRONG_GOD", "floty tylko w turze Posejdona")
	check_eq(MoveRules.action_error(state, "p2", troops), "NOT_YOUR_TURN", "nie twoja tura")

	var sea := _rules_state("POSEIDON")
	var fleet := MoveRules.MOVE_FLEET
	check_eq(MoveRules.move_targets(sea, "p1", "arch_n", fleet), {"arch_center": "MOVE", "arch_nw": "MOVE", "arch_sw": "MOVE", "arch_ne": "ATTACK", "arch_se": "ATTACK"}, "floty rywali to cele ataku")
	sea["seas"]["arch_center"] = _sea("p2", 0, 1)
	check_eq(MoveRules.fleet_distance(sea, "p1", "arch_n", "arch_se"), 3, "obce floty zatrzymują ruch: droga naokoło (3 pola)")
	sea["seas"]["arch_nw"] = _sea("p3", 1)
	check_eq(MoveRules.move_targets(sea, "p1", "arch_n", fleet), {"arch_center": "ATTACK", "arch_ne": "ATTACK", "arch_nw": "ATTACK"}, "bez przepływania przez obce floty, także nieumarłych")
	check_eq(MoveRules.origin_error(sea, "p1", "arch_ne", fleet), "NOT_OWNER", "cudza flota")
	check_eq(MoveRules.origin_error(sea, "p1", "andros", fleet), "WRONG_TERRITORY", "flota rusza z morza")
	sea["players"]["p1"]["gold"] = 0
	check_eq(MoveRules.action_error(sea, "p1", fleet), "CANNOT_AFFORD", "ruch kosztuje 1 JZ")
	check_eq(MoveRules.move_targets(sea, "p1", "arch_n", fleet), {}, "bez złota brak celów")

	var build := _rules_state("ZEUS")
	check_eq(MoveRules.build_targets(build, "p1"), ["andros"], "budowa na własnej wyspie")
	build["islands"]["andros"]["buildings"] = ["TEMPLE", "TEMPLE", "TEMPLE"]
	check_eq(MoveRules.build_targets(build, "p1"), [], "brak wolnego miejsca")
	check_eq(MoveRules.build_targets(_rules_state("APOLLO"), "p1"), [], "w turze Apolla nie ma budowy")
	var bidding := _logic_game()
	check_eq(MoveRules.action_error(bidding._state, "p1", troops), "NOT_ACTIONS", "w licytacji nie ma ruchów")
	bidding.queue_free()


## Plansza liczy cele na projekcji gracza, a serwer sprawdza ruch na pełnym stanie.
## Na losowych stanach pole jest podświetlone dokładnie wtedy, gdy serwer przyjmie
## ruch. „Atak” oznacza dokładnie te ruchy, po których wybucha bitwa. Licznik kodów
## odpowiedzi pilnuje, żeby losowe stany trafiały w każdą regułę serwera.
func test_rules_match_server() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 20260925
	var players := ["p1", "p2", "p3"]
	var island_owners := ["", "", "", "p1", "p2", "p3"]  # połowa wysp wolna: częściej rywal ma ostatnią wyspę
	var sea_owners := ["", "p1", "p2", "p3"]
	var gods := ["ARES", "ARES", "POSEIDON", "POSEIDON", "ZEUS", "ATHENA", "APOLLO"]
	var gsm := _logic_game()
	var battles := [0]
	gsm.battle_resolved.connect(func(_report: Dictionary) -> void: battles[0] += 1)
	var codes := {}
	var mismatches: Array[String] = []
	for trial in 200:
		var player: String = players[rng.randi_range(0, 2)]
		var actor: String = player if rng.randf() < 0.85 else players[(players.find(player) + 1) % 3]
		_turn(gsm, gods[rng.randi_range(0, gods.size() - 1)], actor)
		for island_id: String in gsm._state["islands"]:
			var holder: String = island_owners[rng.randi_range(0, island_owners.size() - 1)]
			var buildings: Array = []
			for i in rng.randi_range(0, 3):
				buildings.append("PORT")
			if holder == "":
				gsm._state["islands"][island_id] = _isle("", 0)
			else:
				gsm._state["islands"][island_id] = _isle(holder, rng.randi_range(0, 2), buildings, rng.randi_range(0, 1))
		# W połowie losowań rywal ma dokładnie jedną wyspę, a morza wokół niej należą do gracza (ochrona ostatniej wyspy).
		var last_island := ""
		if rng.randf() < 0.5:
			var rival: String = players[(players.find(player) + 1 + rng.randi_range(0, 1)) % 3]
			for island_id: String in gsm._state["islands"]:
				if gsm._state["islands"][island_id]["owner"] == rival:
					if last_island != "":
						gsm._state["islands"][island_id] = _isle("", 0)
					else:
						last_island = island_id
		for sea_id: String in gsm._state["seas"]:
			var holder: String = sea_owners[rng.randi_range(0, 3)]
			var fleets := rng.randi_range(0, 2) if holder != "" else 0
			var undead := rng.randi_range(0, 1) if holder != "" else 0
			if holder != "" and fleets + undead == 0:
				fleets = 1  # zajęte morze zawsze ma jednostki
			gsm._state["seas"][sea_id] = _sea(holder, fleets, undead)
		if last_island != "":
			for sea_id: String in ArchipelagoMap.MAP["islands"][last_island]["seas"]:
				gsm._state["seas"][sea_id] = _sea(player, 1)
		gsm._state["players"][player]["gold"] = rng.randi_range(0, 3)
		var snapshot: Dictionary = gsm._state.duplicate(true)
		var view := gsm.project_for(player)
		for action: String in [MoveRules.MOVE_TROOPS, MoveRules.MOVE_FLEET]:
			var ids: Array = snapshot["islands" if action == MoveRules.MOVE_TROOPS else "seas"].keys()
			for from_id: String in ids:
				var expected := MoveRules.move_targets(view, player, from_id, action)
				for to_id: String in ids:
					gsm._state = snapshot.duplicate(true)
					var before: int = battles[0]
					var result := gsm.apply_move(player, from_id, to_id, 1)
					var fought: bool = battles[0] > before
					var highlighted := expected.has(to_id)
					if result["ok"] != highlighted or (highlighted and fought != (expected[to_id] == MoveRules.TARGET_ATTACK)):
						mismatches.append("%s %s→%s: plansza %s, serwer %s, bitwa %s" % [action, from_id, to_id, expected.get(to_id, "-"), result["code"] if not result["ok"] else "OK", fought])
					var code := String(result["code"]) if not result["ok"] else ("OK_ATTACK" if fought else "OK_MOVE")
					codes[code] = int(codes.get(code, 0)) + 1
		var buildable := MoveRules.build_targets(view, player)
		for island_id: String in snapshot["islands"]:
			gsm._state = snapshot.duplicate(true)
			var result := gsm.apply_build(player, island_id)
			if result["ok"] != buildable.has(island_id):
				mismatches.append("BUILD %s: plansza %s, serwer %s" % [island_id, buildable.has(island_id), result["code"] if not result["ok"] else "OK"])
			var code := "BUILD_" + (String(result["code"]) if not result["ok"] else "OK")
			codes[code] = int(codes.get(code, 0)) + 1
	check(mismatches.is_empty(), "%d rozbieżności, np. %s" % [mismatches.size(), mismatches.slice(0, 5)])
	var required := ["OK_MOVE", "OK_ATTACK", "INVALID_MOVE", "NOT_YOUR_TURN", "WRONG_GOD", "NOT_OWNER", "NOT_ENOUGH_UNITS", "CANNOT_AFFORD",
		"NO_FLEET_BRIDGE", "OUT_OF_RANGE", "LAST_ISLAND_PROTECTED", "BUILD_OK", "BUILD_NO_FREE_SLOT", "BUILD_NOT_OWNER", "BUILD_WRONG_GOD", "BUILD_CANNOT_AFFORD"]
	var missing := required.filter(func(code: String) -> bool: return int(codes.get(code, 0)) < 5)
	check(missing.is_empty(), "losowe stany trafiają w każdą regułę (brakuje %s): %s" % [missing, codes])


func test_undead_battle() -> void:
	var outcomes := {}
	for battle in 40:
		var gsm := _logic_game()
		_turn(gsm, "ARES", "p1")
		gsm._state["islands"]["andros"]["troops"] = 3
		gsm._state["seas"]["arch_ne"] = _sea("p1", 1)
		gsm._state["islands"]["mykonos"] = _isle("p2", 1, [], 2)
		gsm._state["islands"]["paros"] = _isle("p2", 0)
		var reports: Array = []
		gsm.battle_resolved.connect(func(resolved: Dictionary) -> void: reports.append(resolved))
		check_code(gsm.apply_move("p1", "andros", "mykonos", 3), "")
		var report: Dictionary = reports[0] if reports.size() > 0 else {}
		_check_report_consistency(report, 3, 3)
		# Nieumarli na początku kolejnych rund: najpierw giną oni, dopiero potem oddziały gracza.
		var lost := 0
		var undead_seen: Array = []
		var undead_expected: Array = []
		for battle_round in report.get("rounds", []):
			undead_seen.append(battle_round["defender"]["undead"])
			undead_expected.append(maxi(0, 2 - lost))
			lost += 1 if battle_round["defender"]["loss"] else 0
		check_eq(undead_seen, undead_expected, "nieumarli giną pierwsi")
		var mykonos: Dictionary = gsm._state["islands"]["mykonos"]
		var outcome := String(report.get("outcome", ""))
		outcomes[outcome] = true
		match outcome:
			"ATTACKER_WON":
				check_eq([mykonos["owner"], int(mykonos["troops"]) > 0, mykonos["undead_troops"]], ["p1", true, 0], "zwycięzca zajmuje wyspę, nieumarli obrońcy znikają")
			"DEFENDER_WON":
				check_eq([mykonos["owner"], mykonos["troops"], mykonos["undead_troops"]], ["p2", 1 - maxi(0, lost - 2), maxi(0, 2 - lost)], "obrońca traci najpierw nieumarłych")
			_:
				check_eq([mykonos["owner"], mykonos["troops"], mykonos["undead_troops"]], ["p2", 0, 0], "wzajemne zniszczenie: wyspa bez wojsk zostaje przy obrońcy")
		gsm.queue_free()
	check(outcomes.has("ATTACKER_WON") and outcomes.has("DEFENDER_WON"), "w 40 bitwach wygrywa czasem atakujący, czasem obrońca: %s" % [outcomes.keys()])

	var sea := _logic_game()
	_turn(sea, "POSEIDON", "p1")
	sea._state["seas"]["arch_n"] = _sea("p1", 1, 1)
	check_code(sea.apply_move("p1", "arch_n", "arch_nw", 1), "")
	check_eq(sea._state["seas"]["arch_n"], {"owner": "p1", "fleets": 0, "undead_fleets": 1}, "flota nieumarłych trzyma morze po odpłynięciu floty")
	check_code(sea.apply_move("p1", "arch_n", "arch_nw", 1), "NOT_ENOUGH_UNITS")
	_turn(sea, "ARES", "p1")
	check_code(sea.apply_move("p1", "andros", "syros", 1), "")  # most przez morze z samymi nieumarłymi


func test_land_battle_report() -> void:
	var gsm := _logic_game()
	_turn(gsm, "ARES", "p1")
	gsm._state["islands"]["andros"]["troops"] = 4
	gsm._state["seas"]["arch_ne"] = _sea("p1", 1)
	gsm._state["islands"]["mykonos"] = _isle("p2", 2, ["FORTRESS"])
	gsm._state["islands"]["paros"] = _isle("p2", 0)  # ostatnia wyspa nie jest chroniona
	var order: Array = []
	var reports: Array = []
	gsm.battle_resolved.connect(func(resolved: Dictionary) -> void:
		order.append("battle")
		reports.append(resolved))
	gsm.state_committed.connect(func() -> void: order.append("state"))
	check_code(gsm.apply_move("p1", "andros", "mykonos", 4), "")
	check_eq(order, ["battle", "state"], "raport bitwy przed nowym stanem")
	var report: Dictionary = reports[0] if reports.size() > 0 else {}
	check_eq([report.get("kind"), report.get("attacker"), report.get("defender")], ["LAND", "p1", "p2"], "strony bitwy")
	_check_report_consistency(report, 4, 2)
	for battle_round in report.get("rounds", []):
		check_eq(battle_round["defender"]["modifiers"], [{"source": "FORTRESS", "island": "mykonos", "value": 1}], "Forteca w każdej rundzie")
		check_eq(battle_round["attacker"]["modifiers"], [], "atakujący bez premii")
	var mykonos: Dictionary = gsm._state["islands"]["mykonos"]
	match report.get("outcome"):
		"ATTACKER_WON":
			check_eq(mykonos["owner"], "p1", "zwycięzca zajmuje wyspę")
		"DEFENDER_WON":
			check_eq(mykonos["owner"], "p2", "obrońca zostaje")
		_:
			check_eq([mykonos["owner"], mykonos["troops"]], ["p2", 0], "wzajemne zniszczenie")


func test_sea_battle_ports() -> void:
	var gsm := _logic_game()
	_turn(gsm, "POSEIDON", "p1")
	gsm._state["seas"]["arch_n"]["fleets"] = 3
	gsm._state["islands"]["mykonos"]["buildings"] = ["PORT"]
	gsm._state["islands"]["paros"] = _isle("p2", 1, ["PORT", "PORT"])
	gsm._state["islands"]["syros"] = _isle("p3", 1, ["PORT"])  # nie przy tym polu i nie obrońcy
	var reports: Array = []
	gsm.battle_resolved.connect(func(resolved: Dictionary) -> void: reports.append(resolved))
	check_code(gsm.apply_move("p1", "arch_n", "arch_ne", 3), "")
	var report: Dictionary = reports[0] if reports.size() > 0 else {}
	check_eq(report.get("kind"), "SEA", "bitwa morska")
	var first: Dictionary = report.get("rounds", [{}])[0]
	var modifiers: Array = first.get("defender", {}).get("modifiers", [])
	modifiers.sort_custom(func(x: Dictionary, y: Dictionary) -> bool: return String(x["island"]) < String(y["island"]))
	check_eq(modifiers, [{"source": "PORT", "island": "mykonos", "value": 1}, {"source": "PORT", "island": "paros", "value": 2}], "Porty obrońcy przy Morzu Pn-Wsch.")
	_check_report_consistency(report, 3, 1)


func test_dice_distribution() -> void:
	var gsm := _logic_game()
	var counts := {0: 0, 1: 0, 2: 0, 3: 0}
	var throws := 6000
	for i in throws:
		counts[gsm.roll_die()] += 1
	for face in counts:
		var expected := (1.0 if face == 0 or face == 3 else 2.0) / 6.0
		var frequency := float(counts[face]) / throws
		check(absf(frequency - expected) < 0.03, "ścianka %d: %.3f zamiast %.3f" % [face, frequency, expected])


func test_projection() -> void:
	var gsm := _logic_game()
	var view := gsm.project_for("p2")
	check_eq(view["you"], "p2", "projekcja zna odbiorcę")
	check_eq(view["players"]["p2"]["gold"], GameState.STARTING_GOLD, "własne złoto widoczne")
	check_eq([view["players"]["p1"]["gold"], view["players"]["p3"]["gold"]], [-1, -1], "złoto rywali ukryte")
	check_eq(gsm._state["players"]["p1"]["gold"], GameState.STARTING_GOLD, "projekcja nie zmienia stanu serwera")


func test_cycle_end() -> void:
	var gsm := _logic_game()
	var order: Array = gsm._state["bidding"]["queue"].duplicate()
	check_code(gsm.apply_bid(order[0], _god(gsm, 0), 1), "")
	check_code(gsm.apply_bid(order[1], _god(gsm, 1), 1), "")
	check_code(gsm.apply_bid(order[2], GameState.APOLLO, 0), "")
	var gold_before := _gold(gsm, "p1")
	var turn_order: Array = gsm._state["turns"].map(func(turn: Dictionary) -> String: return turn["player"])
	for i in 3:
		check_code(gsm.apply_end_turn(gsm.current_actor()), "")
	check_eq([gsm._state["cycle"], gsm._state["phase"]], [2, "BIDDING"], "nowy cykl")
	check_eq(gsm._state["bidding"]["queue"], turn_order, "licytacja w kolejności tur")
	check_eq(_gold(gsm, "p1"), gold_before + 1, "dochód z Andros (dobrobyt 1)")


func test_ai_bidding() -> void:
	var gsm := _logic_game([false, true, true])
	check(await _until(func() -> bool: return gsm.current_actor() == "p1" or gsm._state["phase"] != "BIDDING"), "AI gra do tury człowieka")
	var ai_moves: Array = gsm._state["log"].filter(func(event: Dictionary) -> bool: return event["type"] in ["OFFER", "APOLLO"] and event["player"] != "p1")
	var p1_first: bool = gsm._state["log"].any(func(event: Dictionary) -> bool: return event["type"] in ["OFFER", "APOLLO"] and event["player"] == "p1")
	check(ai_moves.size() > 0 or not p1_first, "AI złożyła ofiary albo człowiek licytuje pierwszy")


# =============================================================================
# Sieć (ENet na 127.0.0.1)
# =============================================================================

func test_lan_sync() -> void:
	var table := await _lan_table(["Tezeusz", "Dedal"])
	var host: Machine = table[0]
	for client in table.slice(1):
		check(client.lobbies.any(func(roster: Array) -> bool: return roster.size() == 3), "klient %s widzi trzech graczy w lobby" % client.player_id())
	check_code(host.net.start_game(), "")
	check(await _until(func() -> bool: return table.all(func(m: Machine) -> bool: return m.state.view.get("revision", -1) == host.state._state["revision"])), "wszyscy mają najnowszy stan")
	for machine in table:
		check_eq(machine.state.view, host.state.project_for(machine.player_id()), "projekcja %s zgodna z serwerem" % machine.player_id())
		var rivals: Array = machine.state.view["players"].keys().filter(func(id: String) -> bool: return id != machine.player_id())
		check(rivals.all(func(id: String) -> bool: return machine.state.view["players"][id]["gold"] == -1), "złoto rywali ukryte u %s" % machine.player_id())
	_free(table)


func test_server_authority() -> void:
	var table := await _started_table()
	var host: Machine = table[0]
	var actor := host.state.current_actor()
	# Klient, na którego ruch gra teraz NIE czeka (przy trzech graczach zawsze jest taki).
	var outsider: Machine = table.slice(1).filter(func(m: Machine) -> bool: return m.player_id() != actor)[0]
	var revision: int = host.state._state["revision"]
	outsider.net.submit_bid(_god(host.state, 0), 1)
	check(await _until(func() -> bool: return outsider.rejections.has("NOT_YOUR_TURN")), "serwer odrzuca ofiarę poza kolejką")
	print("    (oczekiwany ERROR od Godota: klient próbuje wywołać RPC zarezerwowane dla serwera)")
	_allow_error("is not allowed on node")
	var fake: Dictionary = host.state.project_for(outsider.player_id())
	fake["players"][outsider.player_id()]["gold"] = 999
	outsider.net.rpc_sync_game_state.rpc_id(1, fake)
	await _frames(10)
	check_eq(host.state._state["revision"], revision, "stan serwera bez zmian")
	check_eq(host.state._state["players"][outsider.player_id()]["gold"], GameState.STARTING_GOLD, "podrobiony stan nie działa")
	_free(table)


func test_network_outbid() -> void:
	var table := await _started_table()
	var host: Machine = table[0]
	var order: Array = host.state._state["bidding"]["queue"].duplicate()
	var first := _machine_of(table, order[0])
	var second := _machine_of(table, order[1])
	var god := _god(host.state, 0)
	first.net.submit_bid(god, 1)
	check(await _until(func() -> bool: return host.state.current_actor() == order[1]), "pierwsza ofiara przyjęta")
	second.net.submit_bid(god, 2)
	check(await _until(func() -> bool: return GameState.actor_of(first.state.view) == order[0]), "przebity dostaje stan, w którym to jego ruch")
	var bidding: Dictionary = first.state.view["bidding"]
	check_eq([bidding["displaced"], bidding["forbidden"]], [order[0], god], "przebity musi wybrać innego boga")
	check(_has_event(first.state.view, {"type": "OUTBID", "player": order[0], "by": order[1], "god": god}), "powiadomienie o przebiciu w dzienniku")
	check(first.state.is_my_turn(), "UI przebitego widzi swoją turę")
	_free(table)


func test_network_battle() -> void:
	var table := await _started_table()
	var host: Machine = table[0]
	var attacker: Machine = table[1]
	var observer: Machine = table[2]
	var a := attacker.player_id()
	var d := observer.player_id()
	var state: Dictionary = host.state._state
	var a_city: String = _city_of(state, a)
	var d_city: String = _city_of(state, d)
	# Scenariusz: tura Aresa atakującego, most z jego flot do miasta obrońcy, a obrońca ma Fortecę i drugą wyspę.
	state["phase"] = "ACTIONS"
	state["turns"] = [{"god": "ARES", "player": a}]
	state["turn_index"] = 0
	state["islands"][a_city]["troops"] = 5
	for sea_id in GameState.MAP["seas"]:
		state["seas"][sea_id] = _sea(a, 1)
	state["islands"][d_city] = _isle(d, 2, ["FORTRESS"])
	state["islands"]["delos"] = _isle(d, 1)
	host.state._commit()
	check(await _until(func() -> bool: return GameState.actor_of(attacker.state.view) == a), "atakujący dostał scenariusz")
	attacker.net.move_units(a_city, d_city, 5)
	check(await _until(func() -> bool: return table.all(func(m: Machine) -> bool: return m.battles.size() == 1)), "raport bitwy dotarł do wszystkich")
	var report: Dictionary = host.battles[0] if host.battles.size() > 0 else {}
	for machine in table:
		check_eq(machine.battles[0] if machine.battles.size() > 0 else {}, report, "ten sam raport u %s" % machine.player_id())
	check_eq([report.get("attacker"), report.get("defender"), report.get("location")], [a, d, d_city], "strony i miejsce bitwy")
	_check_report_consistency(report, 5, 2)
	check(await _until(func() -> bool: return table.all(func(m: Machine) -> bool: return m.state.view.get("revision", -1) == host.state._state["revision"])), "stan po bitwie u wszystkich")
	for machine in table:
		check_eq(machine.state.view, host.state.project_for(machine.player_id()), "stan %s zgodny z serwerem" % machine.player_id())
	_free(table)


func test_disconnect_and_reconnect() -> void:
	var table := await _started_table()
	var host: Machine = table[0]
	var stays: Machine = table[1]
	var leaver: Machine = table[2]
	var id := leaver.player_id()
	var before: Dictionary = host.state._state["players"][id].duplicate(true)
	leaver.net._close_peer()  # zerwane połączenie (żeton i adres zostają u klienta)
	check(await _until(func() -> bool: return not host.state._state["players"][id]["connected"]), "serwer widzi rozłączenie")
	var deadline: float = host.state._state["players"][id]["reconnect_deadline"]
	check(deadline > Time.get_unix_time_from_system(), "miejsce czeka do terminu")
	check(await _until(func() -> bool: return not stays.state.view["players"][id]["connected"]), "pozostali widzą rozłączenie")
	check_eq(host.state._state["players"][id]["gold"], before["gold"], "złoto rozłączonego nietknięte")
	check_eq(host.state._state["islands"][_city_of(host.state._state, id)]["owner"], id, "wyspa rozłączonego nietknięta")

	check_eq(leaver.net.reconnect(), OK, "powrót z żetonem")
	check(await _until(func() -> bool: return host.state._state["players"][id]["connected"]), "serwer przyjął powrót")
	check(await _until(func() -> bool: return leaver.state.view.get("revision", -1) == host.state._state["revision"]), "wracający dostał najnowszy stan")
	check_eq(leaver.player_id(), id, "to samo miejsce przy stole")
	check_eq(leaver.state.view, host.state.project_for(id), "pełna migawka zgodna z serwerem")
	check(await _until(func() -> bool: return stays.state.view["players"][id]["connected"]), "pozostali widzą powrót")
	_free(table)


func test_reconnect_window_expires() -> void:
	var table := await _started_table()
	var host: Machine = table[0]
	var leaver: Machine = table[2]
	var id := leaver.player_id()
	# Pozostali idą do Apolla, aż przyjdzie kolej gracza, który zaraz zniknie.
	while host.state.current_actor() != id:
		var actor := host.state.current_actor()
		_machine_of(table, actor).net.submit_bid(GameState.APOLLO, 0)
		check(await _until(func() -> bool: return host.state.current_actor() != actor), "ruch gracza %s" % actor)
	leaver.net._close_peer()
	check(await _until(func() -> bool: return host.state._state["players"][id]["is_ai"], 3.0), "po oknie powrotu miejsce przejmuje AI")
	check(await _until(func() -> bool: return host.state.current_actor() != id), "AI od razu wykonało zaległy ruch")
	check_eq(leaver.net.reconnect(), OK, "próba powrotu po czasie")
	check(await _until(func() -> bool: return leaver.failures.has("RECONNECT_EXPIRED")), "serwer odrzuca wygasły żeton")
	_free(table)


func test_late_join_refused() -> void:
	var table := await _started_table()
	var host: Machine = table[0]
	var late := _machine("Spoznialski")
	late.net.join_game("127.0.0.1", host.net._server_port, "Spóźnialski")
	check(await _until(func() -> bool: return late.failures.has("GAME_IN_PROGRESS")), "odmowa: partia trwa")
	check_eq(host.net._seats.size(), 3, "przy stole nadal trzech graczy")
	table.append(late)
	_free(table)


func test_server_disconnected() -> void:
	var table := await _started_table()
	var host: Machine = table[0]
	host.net.leave_game()
	check(await _until(func() -> bool: return table.slice(1).all(func(m: Machine) -> bool: return m.server_lost)), "klienci wiedzą, że host zniknął")
	check(table.slice(1).all(func(m: Machine) -> bool: return m.net.session_token != ""), "żeton zostaje do ewentualnego powrotu")
	_free(table)


func test_single_player() -> void:
	# Surowe gniazdo na porcie ogłoszeń: liczy każdy pakiet, także taki, którego LanListener by nie przyjął.
	var sniffer := PacketPeerUDP.new()
	check_eq(sniffer.bind(_discovery_port, "*"), OK, "nasłuch kontrolny na porcie ogłoszeń")
	var solo := _machine("Solo")
	check_eq(solo.net.start_single_player("Ariadna", 2), OK, "gra solo startuje")
	check_eq(solo.net.mode, Network.Mode.SINGLE_PLAYER, "tryb gry solo")
	check(solo.state.is_game_running(), "partia trwa od razu")
	check_eq(solo.net._seats.values().filter(func(seat: Dictionary) -> bool: return seat["is_ai"]).size(), 2, "dwa miejsca AI")
	check(await _until(func() -> bool: return solo.state.current_actor() == solo.player_id()), "AI licytuje, aż przyjdzie kolej człowieka")
	solo.net.submit_bid(GameState.APOLLO, 0)
	check(await _until(func() -> bool: return solo.state._state["apollo"].has(solo.player_id())), "ruch człowieka przyjęty lokalnie")
	check_eq(solo.state.view, solo.state.project_for(solo.player_id()), "widok gracza to jego projekcja")
	var guest := _machine("Gosc")
	guest.net.join_game("127.0.0.1", solo.net._server_port, "Gość")
	check(await _until(func() -> bool: return guest.server_lost or not guest.failures.is_empty()), "gość rozłączony")
	check_eq(guest.player_id(), "", "gość z zewnątrz nie dołączy do gry solo")
	check(not guest.failures.has("GAME_IN_PROGRESS"), "serwer gry solo rozłącza gościa od razu, bez rejestracji")
	check_eq(sniffer.get_available_packet_count(), 0, "gra solo nie wysyła żadnych ogłoszeń do sieci")
	sniffer.close()
	_free([solo, guest])


func test_main_scene() -> void:
	var main: Control = load("res://scenes/Main.tscn").instantiate()
	var browser: Control = main.get_node("%Browser")
	(browser.get_node("LanListener") as LanListener).discovery_ports = [_discovery_port]
	add_child(main)
	(browser.get_node("%NameEdit") as LineEdit).text = "Ariadna"
	(browser.get_node("%SingleButton") as Button).pressed.emit()
	check(await _until(func() -> bool: return (main.get_node("%Game") as Control).visible), "przycisk gry solo pokazuje panel partii")
	check(not (browser.get_node("LanListener") as LanListener).is_listening(), "ukryta lista gier zwalnia port UDP")
	# Gracz klika Apollo w licytacji i „Koniec tury” w swoich turach, a AI gra samo, aż zacznie się drugi cykl.
	var apollo: Button = main.get_node("%BiddingBoard").get_node("%ApolloButton")
	var end_turn: Button = main.get_node("%EndTurnButton")
	var reached := await _until(func() -> bool:
		var view := GameStateManager.view
		if GameStateManager.is_my_turn():
			(apollo if view["phase"] == "BIDDING" else end_turn).pressed.emit()
		return int(view.get("cycle", 0)) >= 2, 5.0)
	check(reached, "partia przez UI dochodzi do drugiego cyklu")
	GameStateManager.report_battle({
		"kind": "LAND", "location": "delos", "attacker": "p2", "defender": "p1", "outcome": "DEFENDER_WON", "revision": 0,
		"rounds": [{"round": 1,
			"attacker": {"roll": 1, "units": 1, "modifiers": [], "total": 2, "loss": true},
			"defender": {"roll": 2, "units": 1, "modifiers": [{"source": "FORTRESS", "island": "delos", "value": 1}], "total": 4, "loss": false}}],
	})
	var log_text := (main.get_node("%Log") as RichTextLabel).get_parsed_text()
	for phrase in ["Serwer działa na porcie", "Cykl 2", "idzie do Apolla", "Bitwa o delos", "Forteca (delos) +1", "wygrywa obrońca"]:
		check(log_text.contains(phrase), "dziennik UI zawiera „%s”" % phrase)
	check((main.get_node("%StatusLabel") as Label).text.contains("Ariadna"), "pasek stanu pokazuje gracza")
	(main.get_node("%LeaveButton") as Button).pressed.emit()
	check(browser.visible, "wyjście wraca do listy gier LAN")
	main.queue_free()


# =============================================================================
# LAN Discovery (tylko 127.0.0.1)
# =============================================================================

func test_beacon_packet() -> void:
	var info := {"server_name": "Archipelag", "port": 8910, "current_players": 2, "max_players": 5, "has_hades": true, "has_monuments": false, "in_game": false}
	var packet := LanBeacon.encode(info)
	check(packet.size() < 300, "ogłoszenie mieści się w małym datagramie")
	check_eq(LanListener.decode(packet), info, "ogłoszenie przechodzi przez kodowanie i odczyt")
	var base := {"game": "cyklady", "v": 1, "server_name": "Archipelag", "port": 8910, "current_players": 2, "max_players": 5, "has_hades": true, "has_monuments": false, "in_game": false}
	var broken := [
		{"game": "inna-gra"}, {"v": 2}, {"port": 0}, {"port": 70000}, {"port": 8910.5}, {"current_players": 6},
		{"max_players": 0}, {"server_name": ""}, {"server_name": "x".repeat(65)}, {"has_hades": "tak"}, {"in_game": 1},
	]
	for change: Dictionary in broken:
		var variant := base.duplicate()
		variant.merge(change, true)
		check(LanListener.decode(JSON.stringify(variant).to_utf8_buffer()).is_empty(), "odrzucone: %s" % JSON.stringify(change))
	var missing := base.duplicate()
	missing.erase("port")
	check(LanListener.decode(JSON.stringify(missing).to_utf8_buffer()).is_empty(), "odrzucone: brak portu")
	check(LanListener.decode("to nie json".to_utf8_buffer()).is_empty(), "odrzucone: to nie JSON")
	check(LanListener.decode("[1, 2]".to_utf8_buffer()).is_empty(), "odrzucone: tablica zamiast obiektu")
	check(LanListener.decode((JSON.stringify(base) + " ".repeat(1100)).to_utf8_buffer()).is_empty(), "odrzucone: za duży pakiet")
	var long_name := LanListener.decode(LanBeacon.encode({"server_name": "Ż".repeat(100), "port": 8910, "current_players": 1, "max_players": 5}))
	check_eq(String(long_name.get("server_name", "")).length(), LanBeacon.MAX_NAME_LENGTH, "za długa nazwa gry jest przycinana")


func test_beacon_to_listener() -> void:
	var port := _udp_port()
	var listener := _listener([port], 0.6)
	var found: Array = []
	var updated: Array = []
	var lost: Array = []
	listener.server_found.connect(func(announced: Dictionary) -> void: found.append(announced))
	listener.server_updated.connect(func(announced: Dictionary) -> void: updated.append(announced))
	listener.server_lost.connect(func(announced: Dictionary) -> void: lost.append(announced))
	var info := {"server_name": "Archipelag", "port": 8910, "current_players": 1, "max_players": 5, "has_hades": false, "has_monuments": true, "in_game": false}
	var beacon := _beacon([port])
	check_eq(beacon.start(func() -> Dictionary: return info), OK, "nadajnik startuje")
	check(await _until(func() -> bool: return found.size() == 1), "server_found po pierwszym ogłoszeniu")
	var server: Dictionary = found[0] if found.size() > 0 else {}
	check_eq([server.get("address"), server.get("port"), server.get("key"), server.get("server_name"), server.get("has_monuments")],
		["127.0.0.1", 8910, "127.0.0.1:8910", "Archipelag", true], "pola ogłoszenia i adres nadawcy")
	info["current_players"] = 2
	beacon.announce_now()
	check(await _until(func() -> bool: return updated.size() == 1), "server_updated po zmianie liczby graczy")
	check_eq(updated[0]["current_players"] if updated.size() > 0 else -1, 2, "nowa liczba graczy")
	await get_tree().create_timer(0.9).timeout  # kilka ogłoszeń co 0,2 s, dłużej niż limit ciszy
	check_eq([found.size(), updated.size(), lost.size()], [1, 1, 0], "powtarzane ogłoszenia podtrzymują serwer bez nowych sygnałów")
	beacon.stop()
	check(await _until(func() -> bool: return lost.size() == 1, 2.0), "server_lost po ciszy dłuższej niż limit")
	check(listener.servers().is_empty(), "lista pusta po utracie serwera")
	beacon.queue_free()
	listener.queue_free()


func test_listener_port_fallback() -> void:
	var first := _udp_port()
	var blocker := PacketPeerUDP.new()
	check_eq(blocker.bind(first, "*"), OK, "inny program zajmuje pierwszy port")
	var listener := _listener([first, first + 1], 4.0)
	check_eq(listener.bound_port, first + 1, "odbiornik bierze kolejny wolny port")
	var beacon := _beacon([first, first + 1])
	beacon.interval_sec = 60.0  # dociera tylko ogłoszenie wysłane od razu przy starcie
	beacon.start(func() -> Dictionary: return {"server_name": "Kea", "port": 8910, "current_players": 1, "max_players": 5})
	check(await _until(func() -> bool: return listener.servers().size() == 1, 1.0), "pierwsze ogłoszenie od razu, na port zapasowy")
	var none := _listener([first], 4.0)
	check(not none.is_listening(), "bez wolnego portu nasłuch zgłasza niedostępność")
	blocker.close()
	for node: Node in [beacon, listener, none]:
		node.queue_free()


func test_listener_limits() -> void:
	var listener := _listener([], 4.0)  # bez portów: sama logika listy
	listener.max_servers = 3
	var found: Array = []
	listener.server_found.connect(func(announced: Dictionary) -> void: found.append(announced))
	for i in 10:
		var packet := LanBeacon.encode({"server_name": "Gra %d" % i, "port": 9000 + i, "current_players": 1, "max_players": 5})
		listener.handle_packet(packet, "192.168.1.%d" % (10 + i))
		listener.handle_packet(packet, "192.168.1.%d" % (10 + i))
	check_eq(listener.servers().size(), 3, "limit zapamiętanych serwerów")
	check_eq(found.size(), 3, "powtórzony pakiet nie tworzy nowego serwera")
	check_eq(listener.servers().map(func(entry: Dictionary) -> String: return entry["key"]),
		["192.168.1.10:9000", "192.168.1.11:9001", "192.168.1.12:9002"], "klucz to adres nadawcy i port gry")
	var other := _listener([], 4.0)
	other.handle_packet(LanBeacon.encode({"server_name": "Gra", "port": 9000, "current_players": 1, "max_players": 5}), "nie-adres")
	check(other.servers().is_empty(), "pakiet z niepoprawnym adresem nadawcy jest pomijany")
	listener.queue_free()
	other.queue_free()


func test_host_announces_game() -> void:
	var listener := _listener([_discovery_port], 4.0)
	var table := await _lan_table(["Tezeusz"])
	var host: Machine = table[0]
	check(await _until(func() -> bool: return _first_server(listener).get("current_players") == 2), "ogłoszenie z dwoma graczami")
	var server := _first_server(listener)
	check_eq([server.get("server_name"), server.get("port"), server.get("max_players"), server.get("in_game")],
		["Gra: Gospodarz", host.net._server_port, 5, false], "nazwa gry, port ENet, limit graczy")
	check_code(host.net.set_expansions(true, false), "")
	check(await _until(func() -> bool: return _first_server(listener).get("has_hades") == true), "zmiana dodatków od razu w ogłoszeniu")
	host.net.add_ai_player()
	check(await _until(func() -> bool: return _first_server(listener).get("current_players") == 3), "AI zwiększa liczbę graczy w ogłoszeniu")
	check_code(host.net.start_game(), "")
	check(await _until(func() -> bool: return _first_server(listener).get("in_game") == true), "start partii w ogłoszeniu")
	check_eq(host.state._state["expansions"], {"hades": true, "monuments": false}, "dodatki trafiają do stanu partii")
	check_code(host.net.set_expansions(false, false), "NOT_ALLOWED")
	listener.lost_after_sec = 0.5
	host.net.leave_game()
	check(host.net._beacon == null, "wyjście z gry zatrzymuje nadajnik")
	check(await _until(func() -> bool: return listener.servers().is_empty(), 2.0), "po zamknięciu serwera gra znika z listy")
	_free(table)
	listener.queue_free()


func test_parse_address() -> void:
	var valid := [
		["192.168.1.20", "192.168.1.20", 8910],
		["  192.168.1.20:9000 ", "192.168.1.20", 9000],
		["gra.local:7000", "gra.local", 7000],
		["[fe80::1]:8911", "fe80::1", 8911],
		["fe80::1", "fe80::1", 8910],
	]
	for entry: Array in valid:
		check_eq(Network.parse_address(entry[0]), {"host": entry[1], "port": entry[2]}, "adres „%s”" % entry[0])
	for bad: String in ["", "1.2.3.4:0", "1.2.3.4:70000", "1.2.3.4:12x", "1.2.3.4:", "zła nazwa!", "1.2.3.4:80:90", "[zz::1]:80", "[fe80::1"]:
		check(Network.parse_address(bad).is_empty(), "odrzucony adres „%s”" % bad)


func test_lan_lobby_ui() -> void:
	# Najpierw ekran lobby (nasłuch), potem host: przy długim takcie liczy się ogłoszenie wysłane od razu.
	var lobby: Control = load("res://scenes/LanLobby.tscn").instantiate()
	(lobby.get_node("LanListener") as LanListener).discovery_ports = [_discovery_port]
	add_child(lobby)
	var host := _machine("HostUI")
	var game_port := _free_port()
	check_eq(host.net.host_game("Ariadna", game_port, {"server_name": "Archipelag", "hades": true}), OK, "host ogłasza grę")
	var list := lobby.get_node("%ServerList") as ItemList
	var join := lobby.get_node("%JoinButton") as Button
	var status := lobby.get_node("%StatusLabel") as Label
	check(await _until(func() -> bool: return list.item_count == 1), "gra pojawia się na liście")
	check_eq(list.get_item_text(0) if list.item_count > 0 else "", "Archipelag · 1/5 graczy · Hades · 127.0.0.1:%d" % game_port, "opis pozycji")
	check(join.disabled, "bez wybranej gry nie da się dołączyć")
	list.select(0)
	list.item_selected.emit(0)
	check(not join.disabled, "wybrana gra odblokowuje przycisk")
	(lobby.get_node("%NameEdit") as LineEdit).text = "Tezeusz"
	join.pressed.emit()
	check(await _until(func() -> bool: return NetworkManager.local_player_id != ""), "dołączenie do wybranej gry")
	check(await _until(func() -> bool: return list.item_count == 1 and list.get_item_text(0).contains("2/5 graczy")), "lista pokazuje nowego gracza")
	NetworkManager.leave_game()

	var address := lobby.get_node("%AddressEdit") as LineEdit
	address.text = "zły adres!"
	(lobby.get_node("%DirectButton") as Button).pressed.emit()
	check(status.text.begins_with("Niepoprawny adres"), "zły adres: komunikat dla gracza")
	address.text = "127.0.0.1:%d" % game_port
	(lobby.get_node("%DirectButton") as Button).pressed.emit()
	check(await _until(func() -> bool: return NetworkManager.local_player_id != ""), "połączenie przez IP")
	NetworkManager.leave_game()

	host.net.add_ai_player()
	host.net.add_ai_player()
	check_code(host.net.start_game(), "")
	check(await _until(func() -> bool: return list.item_count == 1 and list.is_item_disabled(0)), "trwającej partii nie da się wybrać")

	lobby.set("game_port", _free_port())
	(lobby.get_node("%ServerNameEdit") as LineEdit).text = "Moja gra"
	(lobby.get_node("%HadesCheck") as CheckBox).button_pressed = true
	(lobby.get_node("%CreateButton") as Button).pressed.emit()
	check_eq(NetworkManager.mode, Network.Mode.HOST, "przycisk tworzy grę LAN")
	check_eq([NetworkManager.server_name, NetworkManager.expansions], ["Moja gra", {"hades": true, "monuments": false}], "nazwa i dodatki z formularza")
	check(await _until(func() -> bool: return list.item_count == 2), "nowa gra też jest ogłaszana")
	NetworkManager.leave_game()
	lobby.queue_free()
	_free([host])


# =============================================================================
# Plansza (board/)
# =============================================================================

func test_territory_node() -> void:
	var node := TerritoryNode.new()
	node.territory_id = "delos"
	node.display_name = "Delos"
	var shape := CollisionPolygon2D.new()
	shape.name = "Shape"
	shape.polygon = PackedVector2Array([Vector2(-40, -30), Vector2(40, -30), Vector2(40, 30), Vector2(-40, 30)])
	node.add_child(shape)
	add_child(node)
	check_eq([node.get_child_count(), node.get_child_count(true)], [1, 4], "w drzewie sceny tylko Shape, wygląd (Fill, Outline, Label) w węzłach wewnętrznych")
	shape.owner = node
	var packed := PackedScene.new()
	check_eq(packed.pack(node), OK, "pole da się zapisać jako scenę")
	var copy := packed.instantiate()
	check_eq(copy.get_child_count(true), 1, "węzły wyglądu nie trafiają do pliku sceny")
	copy.free()
	var fill := node.get_child(0, true) as Polygon2D
	var outline := node.get_child(2, true) as Line2D
	check_eq([fill.polygon, outline.points], [shape.polygon, shape.polygon], "wypełnienie i obrys z kształtu Shape")

	var red: Color = TerritoryNode.PLAYER_COLORS["RED"]
	node.apply_state({"owner": "p2", "troops": 2, "undead_troops": 1, "buildings": ["PORT", "FORTRESS"], "monument": "COLOSSUS"}, red)
	check_eq([node.owner_player_id, node.units, ",".join(node.buildings), node.monument], ["p2", {"troops": 2, "undead_troops": 1}, "PORT,FORTRESS", "COLOSSUS"], "stan pola z projekcji")
	check_eq(node.label_text(), "Delos\noddz. 2 · †1\nP F mon. Colossus", "etykieta: nazwa, oddziały, nieumarli, budynki, monument")
	var fill_material := fill.material as ShaderMaterial
	check_eq(fill_material.get_shader_parameter("base_color"), TerritoryNode.LAND_COLOR.lerp(red, 0.65), "kolor właściciela w shaderze")
	check_eq(fill_material.get_shader_parameter("highlight_strength"), 0.0, "bez oznaczenia bez podświetlenia")
	node.mark = TerritoryNode.Mark.ATTACK_TARGET
	check_eq([fill_material.get_shader_parameter("highlight_color"), fill_material.get_shader_parameter("highlight_strength") > 0.0, fill_material.get_shader_parameter("pulse_speed") > 0.0], [TerritoryNode.MARK_COLORS[TerritoryNode.Mark.ATTACK_TARGET], true, true], "cel ataku: czerwone, pulsujące podświetlenie")
	node.mark = TerritoryNode.Mark.DIMMED
	check_eq([node.modulate, fill_material.get_shader_parameter("highlight_strength")], [TerritoryNode.DIMMED_MODULATE, 0.0], "pole spoza wyboru przygaszone")
	node.mark = TerritoryNode.Mark.NONE
	check_eq(node.modulate, Color.WHITE, "bez oznaczenia pełny kolor")

	var seen: Array = []
	node.hovered.connect(func(_territory: TerritoryNode) -> void: seen.append("hovered"))
	node.unhovered.connect(func(_territory: TerritoryNode) -> void: seen.append("unhovered"))
	node.clicked.connect(func(_territory: TerritoryNode) -> void: seen.append("clicked"))
	node.mouse_entered.emit()
	check_eq([node.is_hovered, fill_material.get_shader_parameter("hover"), outline.width, outline.default_color], [true, 1.0, 5.0, TerritoryNode.HOVER_COLOR], "najechanie: rozjaśnienie i obrys")
	node.mouse_exited.emit()
	check_eq([node.is_hovered, fill_material.get_shader_parameter("hover"), outline.width], [false, 0.0, 2.0], "zjechanie: zwykły wygląd")
	for button: MouseButton in [MOUSE_BUTTON_RIGHT, MOUSE_BUTTON_LEFT]:
		for pressed: bool in [true, false]:
			var click := InputEventMouseButton.new()
			click.button_index = button
			click.pressed = pressed
			node.input_event.emit(get_viewport(), click, 0)
	var touch := InputEventScreenTouch.new()
	touch.pressed = true
	node.input_event.emit(get_viewport(), touch, 0)  # przy emulacji myszy dotyk przychodzi też jako kliknięcie
	check_eq(seen, ["hovered", "unhovered", "clicked"], "jedno kliknięcie: tylko wciśnięcie lewego przycisku, dotyk nie liczy się drugi raz")
	node.queue_free()


func test_board_scene() -> void:
	var board: Board = load("res://board/Board.tscn").instantiate()
	board.follow_game_state = false
	board.fit_to_viewport = false
	add_child(board)
	var ids: Array = board.territories().map(func(node: TerritoryNode) -> String: return node.territory_id)
	ids.sort()
	var expected: Array = ArchipelagoMap.MAP["islands"].keys() + ArchipelagoMap.MAP["seas"].keys()
	expected.sort()
	check_eq(ids, expected, "na planszy są wszystkie pola mapy, każde raz")
	check((board.get_node("Islands") as Node2D).z_index > (board.get_node("Seas") as Node2D).z_index, "wyspy nad morzami")
	var polygons := {}
	for node in board.territories():
		polygons[node.territory_id] = node.shape_node().global_transform * node.shape_node().polygon
	for node in board.territories():
		var id := node.territory_id
		var neighbors := ArchipelagoMap.neighbors(id)
		neighbors.sort()
		var adjacent := PackedStringArray(node.adjacent_territories)
		adjacent.sort()
		check_eq(adjacent, neighbors, "sąsiedzi %s zgodni z mapą" % id)
		check_eq([node.type, node.display_name], [TerritoryNode.Type.ISLAND if ArchipelagoMap.is_island(id) else TerritoryNode.Type.SEA, ArchipelagoMap.display_name(id)], "typ i nazwa %s" % id)
		var point := node.global_transform * node.label_anchor
		check(Geometry2D.is_point_in_polygon(point, polygons[id]), "punkt pola %s leży w polu" % id)
		if ArchipelagoMap.is_sea(id):
			for island_id: String in ArchipelagoMap.MAP["islands"]:
				check(not Geometry2D.is_point_in_polygon(point, polygons[island_id]), "punkt morza %s poza wyspą %s" % [id, island_id])
	# Geometria = mapa: wyspa nachodzi na swoje morza i tylko na nie, a morza stykają się tylko z sąsiednimi.
	for island_id: String in ArchipelagoMap.MAP["islands"]:
		for sea_id: String in ArchipelagoMap.MAP["seas"]:
			var overlap := not Geometry2D.intersect_polygons(polygons[island_id], polygons[sea_id]).is_empty()
			check_eq(overlap, sea_id in ArchipelagoMap.MAP["islands"][island_id]["seas"], "%s na morzu %s" % [island_id, sea_id])
		for other_id: String in ArchipelagoMap.MAP["islands"]:
			if other_id != island_id:
				check(Geometry2D.intersect_polygons(polygons[island_id], polygons[other_id]).is_empty(), "%s nie nachodzi na %s" % [island_id, other_id])
	for sea_id: String in ArchipelagoMap.MAP["seas"]:
		var grown: PackedVector2Array = Geometry2D.offset_polygon(polygons[sea_id], 2.0)[0]
		for other_id: String in ArchipelagoMap.MAP["seas"]:
			if other_id != sea_id:
				var touching := not Geometry2D.intersect_polygons(grown, polygons[other_id]).is_empty()
				check_eq(touching, other_id in ArchipelagoMap.MAP["seas"][sea_id], "%s styka się z %s" % [sea_id, other_id])
				check(Geometry2D.intersect_polygons(Geometry2D.offset_polygon(polygons[sea_id], -1.0)[0], polygons[other_id]).is_empty(), "%s nie nachodzi na %s" % [sea_id, other_id])
	board.queue_free()


func test_board_picking() -> void:
	var container := SubViewportContainer.new()
	container.stretch = true
	container.position = Vector2(40, 30)
	container.size = Vector2(640, 520)
	var viewport := SubViewport.new()
	container.add_child(viewport)
	var board: Board = load("res://board/Board.tscn").instantiate()
	board.follow_game_state = false
	viewport.add_child(board)
	add_child(container)
	check(viewport.physics_object_picking and viewport.physics_object_picking_sort and viewport.physics_object_picking_first_only, "plansza włącza picking z jednym, najwyższym trafieniem")
	var gsm := _logic_game()
	_turn(gsm, "ARES", "p1")
	gsm._state["seas"]["arch_center"] = _sea("p1", 0, 1)  # most do Delos przez flotę nieumarłych
	var view := gsm.project_for("p1")
	board.apply_view(view)
	await _frames(2)
	check(board.scale.x > 0.5 and board.scale.x < 1.0, "plansza dopasowana do viewportu (skala %.2f)" % board.scale.x)

	var hover_log: Array = []
	for node in board.territories():
		node.hovered.connect(func(territory: TerritoryNode) -> void: hover_log.append("+" + territory.territory_id))
		node.unhovered.connect(func(territory: TerritoryNode) -> void: hover_log.append("-" + territory.territory_id))
	var hints: Array = []
	board.hint_changed.connect(func(text: String) -> void: hints.append(text))
	var moves: Array = []
	board.move_requested.connect(func(from_id: String, to_id: String, action: String) -> void: moves.append([from_id, to_id, action]))

	await _mouse_move(_board_point(container, board, "arch_n"))
	check_eq(hover_log, ["+arch_n"], "kursor nad morzem")
	hover_log.clear()
	await _mouse_move(_board_point(container, board, "andros"))
	hover_log.sort()
	check_eq(hover_log, ["+andros", "-arch_n"], "wyspa przejmuje kursor od morza, na którym leży")
	check_eq(hints.back() if not hints.is_empty() else "", "Andros: gracz Gracz 1, oddziały: 2.", "podpowiedź opisuje pole pod kursorem")

	await _mouse_click(_board_point(container, board, "andros"))
	var expected := MoveRules.move_targets(view, "p1", "andros", MoveRules.MOVE_TROOPS)
	check_eq(expected, {"syros": "MOVE", "delos": "MOVE"}, "reguły: Syros przez Morze Pn., Delos przez flotę nieumarłych")
	check_eq([board.selected_id, board.selected_action, board.targets], ["andros", MoveRules.MOVE_TROOPS, expected], "kliknięta wyspa wybrana, cele z MoveRules")
	var marks := {}
	for node in board.territories():
		marks[node.territory_id] = TerritoryNode.Mark.DIMMED
	marks["andros"] = TerritoryNode.Mark.SELECTED
	marks["syros"] = TerritoryNode.Mark.MOVE_TARGET
	marks["delos"] = TerritoryNode.Mark.MOVE_TARGET
	check_eq(_marks(board), marks, "podświetlone wyłącznie cele, reszta przygaszona")

	await _mouse_move(_board_point(container, board, "delos"))
	check(String(hints.back()).ends_with("Kliknij: ruch."), "podpowiedź nad celem mówi, co zrobi kliknięcie")
	await _mouse_click(_board_point(container, board, "delos"))
	check_eq([moves, hints.back()], [[["andros", "delos", MoveRules.MOVE_TROOPS]], "Rozkaz: Andros → Delos."], "kliknięcie celu: rozkaz ruchu i potwierdzenie")
	check(board.territories().all(func(node: TerritoryNode) -> bool: return node.mark == TerritoryNode.Mark.NONE), "po rozkazie plansza bez oznaczeń")

	await _mouse_click(_board_point(container, board, "andros"))
	await _mouse_click(_board_point(container, board, "arch_center"), MOUSE_BUTTON_RIGHT)
	check_eq(board.selected_action, "", "prawy przycisk anuluje wybór")
	await _mouse_click(_board_point(container, board, "andros"))
	await _mouse_click(_board_point(container, board, "andros"))
	check_eq(board.selected_action, "", "ponowne kliknięcie wybranego pola anuluje wybór")
	await _mouse_click(_board_point(container, board, "andros"))
	await _mouse_click(_board_point(container, board, "kea"))
	check_eq([board.selected_action, moves.size()], ["", 1], "pole spoza celów nie wydaje rozkazu (Kea: wolna wyspa bez mostu z twoich flot)")
	check_eq(hints.back(), "Kea nie należy do ciebie.", "podpowiedź po kliknięciu cudzej wyspy")

	_turn(gsm, "POSEIDON", "p1")
	view = gsm.project_for("p1")
	board.apply_view(view)
	await _mouse_move(_board_point(container, board, "andros"))
	await _mouse_click(_board_point(container, board, "andros"))
	check_eq([board.selected_action, hints.back()], ["", "Oddziały porusza tylko tura Aresa. Teraz tura Posejdona."], "wojska w turze Posejdona: brak podświetlenia i powód")
	await _mouse_move(_board_point(container, board, "arch_n"))
	await _mouse_click(_board_point(container, board, "arch_n"))
	check_eq(board.targets, MoveRules.move_targets(view, "p1", "arch_n", MoveRules.MOVE_FLEET), "flota: cele w zasięgu według MoveRules")
	check_eq(board.targets.get("arch_ne"), "ATTACK", "morze z flotą rywala to cel ataku")
	var selections: Array = []
	board.selection_changed.connect(func(territory_id: String, _action: String, _targets: Dictionary) -> void: selections.append(territory_id))
	board.apply_view(gsm.project_for("p1"))
	check_eq([board.selected_id, selections], ["arch_n", []], "nowy stan z tymi samymi celami: wybór zostaje, bez ponownego sygnału")
	board.apply_view(gsm.project_for("p2"))
	check_eq(board.selected_action, "", "nowy stan, w którym ruch jest niemożliwy, kasuje wybór")
	await _mouse_move(_board_point(container, board, "arch_ne"))
	await _mouse_click(_board_point(container, board, "arch_ne"))
	check_eq([board.selected_action, hints.back()], ["", "Teraz tura gracza Gracz 1."], "nie twoja tura")

	await _mouse_move(Vector2(5, 5))
	check(board.territories().all(func(node: TerritoryNode) -> bool: return not node.is_hovered), "kursor poza mapą: żadne pole nie jest pod kursorem")
	container.queue_free()
	gsm.queue_free()


func test_main_board() -> void:
	var main: Control = load("res://scenes/Main.tscn").instantiate()
	var browser: Control = main.get_node("%Browser")
	(browser.get_node("LanListener") as LanListener).discovery_ports = [_discovery_port]
	add_child(main)
	(browser.get_node("%NameEdit") as LineEdit).text = "Ariadna"
	(browser.get_node("%SingleButton") as Button).pressed.emit()
	check(await _until(func() -> bool: return (main.get_node("%Game") as Control).visible), "gra solo pokazuje panel z planszą")
	var board: Board = main.get_node("%Board")
	var map_view: SubViewportContainer = main.get_node("%MapView")
	var me := NetworkManager.local_player_id
	# Scenariusz na serwerze gry solo (lokalny GameStateManager): tura Aresa człowieka, jego flota na Morzu Centralnym.
	var state: Dictionary = GameStateManager._state
	var city := _city_of(state, me)
	state["phase"] = "ACTIONS"
	state["turns"] = [{"god": "ARES", "player": me}]
	state["turn_index"] = 0
	state["seas"]["arch_center"] = _sea(me, 1)
	state["islands"][city]["troops"] = 3
	GameStateManager._commit()
	check(await _until(func() -> bool: return board.view.get("revision", -1) == state["revision"]), "plansza dostała stan od serwera")
	await _frames(2)
	check(not (main.get_node("%BiddingBoard") as Control).visible and (main.get_node("%MoveRow") as Control).visible, "w turach bogów: ruch zamiast licytacji")
	check(map_view.size.x > 400.0 and map_view.size.y > 300.0, "mapa zajmuje dużą część okna (%s)" % map_view.size)

	await _mouse_move(_screen_point(map_view, board, city))
	await _mouse_click(_screen_point(map_view, board, city))
	check_eq(board.selected_id, city, "kliknięcie własnej wyspy wybiera ją")
	check_eq([(main.get_node("%FromEdit") as LineEdit).text, (main.get_node("%CountSpin") as SpinBox).value], [city, 3.0], "pole „skąd” i licznik: wszystkie oddziały z wyspy")
	check(board.targets.has("delos"), "Delos w zasięgu przez flotę na Morzu Centralnym")
	await _mouse_move(_screen_point(map_view, board, "delos"))
	await _mouse_click(_screen_point(map_view, board, "delos"))
	check(await _until(func() -> bool: return GameStateManager._state["islands"]["delos"]["owner"] == me), "serwer przyjął rozkaz z planszy")
	check_eq([GameStateManager._state["islands"]["delos"]["troops"], GameStateManager._state["islands"][city]["troops"]], [3, 0], "na Delos przeszły wszystkie trzy oddziały")
	check(await _until(func() -> bool: return board.territory("delos").owner_player_id == me), "plansza pokazuje nowego właściciela Delos")

	(main.get_node("%BuildButton") as Button).pressed.emit()
	check_eq(board.targets, {city: "BUILD", "delos": "BUILD"}, "„Buduj…”: podświetlone wyspy gracza z wolnym miejscem")
	await _mouse_click(_screen_point(map_view, board, "delos"))
	check(await _until(func() -> bool: return GameStateManager._state["islands"]["delos"]["buildings"] == ["FORTRESS"]), "kliknięta wyspa dostaje Fortecę (tura Aresa)")
	check_eq((main.get_node("%HintLabel") as Label).text, "Rozkaz: budowa na wyspie Delos.", "podpowiedź pod mapą potwierdza rozkaz")
	(main.get_node("%LeaveButton") as Button).pressed.emit()
	main.queue_free()


# =============================================================================
# Licytacja (BidRules, powiadomienie o przebiciu, BiddingBoardUI)
# =============================================================================

func test_bid_rules() -> void:
	check_eq([BidRules.offering_cost(5, 0), BidRules.offering_cost(5, 2), BidRules.offering_cost(2, 3), BidRules.offering_cost(1, 0)], [5, 3, 1, 1], "kapłan: −1 JZ, ale zawsze co najmniej 1 JZ")
	var gsm := _bidding_game([_slot("ARES"), _slot("ZEUS", "p2", 3)], ["p1", "p3"])
	var state: Dictionary = gsm._state
	state["players"]["p1"]["priests"] = 2
	check_eq([BidRules.min_bid(state, "ARES"), BidRules.min_bid(state, "ZEUS")], [1, 4], "najniższe przebicie")
	check_eq(BidRules.max_affordable_bid(state, "p1"), 7, "5 JZ i 2 kapłanów: najwyżej 7 JZ")
	state["players"]["p3"]["gold"] = 0
	check_eq(BidRules.max_affordable_bid(state, "p3"), 0, "bez złota nie stać na żadną ofiarę")
	var cases := [
		["p3", "ARES", 1, "NOT_YOUR_TURN"], ["p1", "HERMES", 1, "UNKNOWN_GOD"], ["p1", "ZEUS", 3, "BID_TOO_LOW"],
		["p1", "ZEUS", 0, "INVALID_AMOUNT"], ["p1", "ARES", 100, "INVALID_AMOUNT"], ["p1", "ZEUS", 8, "CANNOT_AFFORD"],
		["p1", "ZEUS", 7, ""], ["p1", "APOLLO", 0, ""],
	]
	for entry: Array in cases:
		check_eq(BidRules.bid_error(state, entry[0], entry[1], entry[2]), entry[3], "%s: %s za %d JZ" % [entry[0], entry[1], entry[2]])
	state["bidding"]["displaced"] = "p2"
	state["bidding"]["forbidden"] = "ZEUS"
	state["gods"][1]["holder"] = "p1"
	check_eq([BidRules.bidder_of(state), BidRules.bid_error(state, "p2", "ZEUS", 9), BidRules.bid_error(state, "p2", "ARES", 1)], ["p2", "FORBIDDEN_GOD", ""], "przebity licytuje od razu, ale nie u tego samego boga")
	state["phase"] = "ACTIONS"
	check_eq(BidRules.bid_error(state, "p2", "ARES", 1), "NOT_BIDDING", "poza licytacją")
	gsm.queue_free()


## Panel sprawdza ofiarę na projekcji gracza, a serwer na pełnym stanie. Na losowych stanach
## (bogowie, ofiary, złoto, kapłani, przebicie) oba mówią to samo, z tym samym kodem odmowy.
func test_bid_rules_match_server() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 20260926
	var players := ["p1", "p2", "p3"]
	var gsm := _logic_game()
	var codes := {}
	var mismatches: Array[String] = []
	for trial in 120:
		var gods: Array = []
		for god_id: String in ["POSEIDON", "ARES", "ZEUS", "ATHENA", "HADES"]:
			if rng.randf() < 0.6:
				var holder: String = ["", "p1", "p2", "p3"][rng.randi_range(0, 3)]
				gods.append(_slot(god_id, holder, rng.randi_range(1, 6) if holder != "" else 0))
		var queue: Array = players.filter(func(_id: String) -> bool: return rng.randf() < 0.6)
		var displaced: String = players[rng.randi_range(0, 2)] if rng.randf() < 0.3 else ""
		gsm._state["phase"] = "BIDDING" if rng.randf() < 0.9 else "ACTIONS"
		gsm._state["gods"] = gods
		gsm._state["apollo"] = []
		gsm._state["bidding"] = {"queue": queue, "displaced": displaced, "forbidden": String(gods[0]["god"]) if displaced != "" and not gods.is_empty() else ""}
		for player_id: String in players:
			gsm._state["players"][player_id]["gold"] = rng.randi_range(0, 6)
			gsm._state["players"][player_id]["priests"] = rng.randi_range(0, 3)
		var snapshot: Dictionary = gsm._state.duplicate(true)
		var player: String = players[rng.randi_range(0, 2)]
		var view := gsm.project_for(player)
		for god_id: String in ["POSEIDON", "ARES", "ZEUS", "ATHENA", "HADES", "APOLLO", "HERMES"]:
			for amount in range(0, 10):
				gsm._state = snapshot.duplicate(true)
				var client := BidRules.bid_error(view, player, god_id, amount)
				var server := gsm.apply_bid(player, god_id, amount)
				var server_code := "" if server["ok"] else String(server["code"])
				if client != server_code:
					mismatches.append("%s %s %d: UI %s, serwer %s" % [player, god_id, amount, client, server_code])
				codes[server_code] = int(codes.get(server_code, 0)) + 1
	check(mismatches.is_empty(), "%d rozbieżności, np. %s" % [mismatches.size(), mismatches.slice(0, 5)])
	var missing := ["", "NOT_BIDDING", "NOT_YOUR_TURN", "UNKNOWN_GOD", "FORBIDDEN_GOD", "OWN_OFFERING", "INVALID_AMOUNT", "BID_TOO_LOW", "CANNOT_AFFORD"].filter(func(code: String) -> bool: return int(codes.get(code, 0)) < 3)
	check(missing.is_empty(), "losowe stany trafiają w każdą regułę (brakuje %s): %s" % [missing, codes])


func test_bid_displaced_notification() -> void:
	var table := await _started_table()
	var host: Machine = table[0]
	var order: Array = host.state._state["bidding"]["queue"].duplicate()
	var first := _machine_of(table, order[0])
	var second := _machine_of(table, order[1])
	var god := _god(host.state, 0)
	first.net.submit_bid(god, 1)
	check(await _until(func() -> bool: return host.state.current_actor() == order[1]), "pierwsza ofiara przyjęta")
	var revision: int = host.state._state["revision"]
	second.net.submit_bid(god, 3)
	check(await _until(func() -> bool: return table.all(func(m: Machine) -> bool: return m.displacements.size() == 1 and m.state.view["bidding"]["displaced"] == order[0])), "powiadomienie i nowy stan dotarły do wszystkich")
	for machine in table:
		var entry: Dictionary = machine.displacements[0] if machine.displacements.size() > 0 else {}
		check_eq(entry, {"player": order[0], "displaced_in_view": "", "revision": revision}, "u %s powiadomienie przed nowym stanem (projekcja sprzed przebicia)" % machine.player_id())
		var event: Dictionary = machine.state.last_bid_displacement
		check_eq([event.get("player"), event.get("by"), event.get("god"), event.get("amount"), event.get("previous_amount"), event.get("revision")], [order[0], order[1], god, 3, 1, revision + 1], "szczegóły przebicia u %s" % machine.player_id())
	await _frames(5)
	check(table.all(func(m: Machine) -> bool: return m.displacements.size() == 1), "jedno powiadomienie na jedno przebicie")
	_free(table)


func test_bidding_board_ui() -> void:
	var gsm := _bidding_game([_slot("ARES"), _slot("ZEUS", "p2", 3)], ["p3", "p1"])
	gsm._state["players"]["p1"]["priests"] = 2
	var panel := _bidding_panel()
	var offers: Array = []
	panel.offer_confirmed.connect(func(god_id: String, amount: int) -> void: offers.append([god_id, amount]))
	var offer_button: Button = panel.get_node("%OfferButton")
	var apollo_button: Button = panel.get_node("%ApolloButton")
	var cost_label: Label = panel.get_node("%CostLabel")
	var banner: Label = panel.get_node("%BannerLabel")
	panel.apply_view(gsm.project_for("p1"))
	check_eq([panel.current_mode(), banner.text], [BiddingBoardUI.Mode.WAITING, "Licytuje Gracz 3. Dalej: Ty."], "czekanie na swoją kolej")
	check(_bid_buttons(panel).all(func(button: Button) -> bool: return button.disabled) and apollo_button.disabled and offer_button.disabled, "w cudzej kolejce wszystko wyłączone")

	check_code(gsm.apply_bid("p3", "APOLLO", 0), "")
	panel.apply_view(gsm.project_for("p1"))
	check_eq(panel.current_mode(), BiddingBoardUI.Mode.CHOOSING, "twoja kolej")
	check_eq([panel.selected_god, panel.selected_amount], ["ARES", 1], "domyślnie pierwszy bóg, na którego cię stać, za najniższą kwotę")
	check_eq(_enabled_gods(panel), ["ARES", "ZEUS"], "przyciski tylko bogów z toru w tym cyklu")
	check(not (_bid_row(panel, "HADES")["row"] as Control).visible, "bez dodatku Hades wiersz Hadesa ukryty")
	panel.set_amount(2)  # kilka odświeżeń w jednej klatce
	var apollo_markers := (panel.get_node("%ApolloQueue") as HBoxContainer).get_children().filter(func(node: Node) -> bool: return node is BiddingBoardUI.Marker)
	check_eq(apollo_markers.map(func(marker: BiddingBoardUI.Marker) -> Array: return [marker.caption, marker.fill]), [["1", TerritoryNode.PLAYER_COLORS["GREEN"]]], "kolejka Apolla: Gracz 3 na miejscu 1")
	panel.select_god("ARES")
	var zeus: OfferingTrack = _bid_row(panel, "ZEUS")["track"]
	check_eq([zeus.holder_amount, zeus.holder_color, zeus.min_amount], [3, TerritoryNode.PLAYER_COLORS["RED"], 4], "znacznik ofiary Gracza 2 na torze Zeusa")

	zeus.amount_picked.emit(zeus, 3)
	check_eq([panel.selected_god, panel.selected_amount, offer_button.disabled, cost_label.text], ["ZEUS", 3, true, "Na Zeusa trzeba dać co najmniej 4 JZ."], "kliknięte pole za niskie: bez wysyłki i z powodem")
	check_eq([zeus.selected, zeus.preview_amount, zeus.preview_valid], [true, 3, false], "podgląd kwoty na torze: czerwony przy błędzie")
	panel.set_amount(6)
	check_eq([offer_button.disabled, cost_label.text, zeus.preview_amount, zeus.preview_valid], [false, "Ofiara 6 JZ: zapłacisz 4 JZ (kapłani: −2 JZ). Masz 5 JZ.", 6, true], "kapłani obniżają koszt")
	panel.set_amount(8)
	check_eq(cost_label.text, "Nie stać cię: ofiara 8 JZ kosztuje 6 JZ (kapłani: 2), a masz 5 JZ.", "walidacja: nie stać cię")
	check_eq([panel.submit_offer()["code"], offers], ["CANNOT_AFFORD", []], "niepoprawna ofiara nie idzie do serwera")
	panel.set_amount(7)
	check(panel.submit_offer()["ok"], "7 JZ kosztuje 5 JZ: dokładnie tyle, ile gracz ma")
	check_eq([offers, panel.current_mode()], [[["ZEUS", 7]], BiddingBoardUI.Mode.SUBMITTED], "ofiara wysłana, czekamy na serwer")
	check_eq([panel.submit_offer()["code"], panel.choose_apollo()["code"], offers.size()], ["SUBMITTED", "SUBMITTED", 1], "bez podwójnego wysłania")
	panel.on_action_rejected("BID_TOO_LOW", "Na ZEUS trzeba dać co najmniej 8 JZ.")
	check_eq([panel.current_mode(), cost_label.text], [BiddingBoardUI.Mode.CHOOSING, "Na ZEUS trzeba dać co najmniej 8 JZ."], "odmowa serwera: wybór od nowa z powodem")
	check(panel.submit_offer()["ok"], "ponowna wysyłka po odmowie")
	gsm.set_player_connected("p2", false)  # nowy stan niezwiązany z ofiarą: nadal twoja kolej
	panel.apply_view(gsm.project_for("p1"))
	check_eq(panel.current_mode(), BiddingBoardUI.Mode.CHOOSING, "nowy stan kończy oczekiwanie na serwer")
	offers.clear()

	var ares: OfferingTrack = _bid_row(panel, "ARES")["track"]
	ares.amount_picked.emit(ares, 2)
	check(panel.submit_offer()["ok"], "ofiara na Aresa")
	check_code(gsm.apply_bid("p1", "ARES", 2), "")
	panel.apply_view(gsm.project_for("p1"))
	check_eq(panel.current_mode(), BiddingBoardUI.Mode.INACTIVE, "kolejka pusta: licytacja zamknięta")

	var hades := _bidding_game([_slot("ARES", "p3", 12), _slot("HADES", "p2", 2)], ["p1"])
	hades._state["expansions"]["hades"] = true
	var fresh := _bidding_panel(Vector2(560, 16))
	fresh.offer_confirmed.connect(func(god_id: String, amount: int) -> void: offers.append([god_id, amount]))
	fresh.apply_view(hades.project_for("p1"))
	check_eq(fresh.selected_god, "HADES", "domyślnie bóg, na którego cię stać (Ares za 13 JZ jest za drogi)")
	var ares_track: OfferingTrack = _bid_row(fresh, "ARES")["track"]
	check_eq([ares_track.holder_amount, ares_track.amount_of_cell(OfferingTrack.CELLS - 1)], [12, 13], "ofiara 12 JZ stoi na „10+”, a „10+” to najmniejsze przebicie: 13 JZ")
	var hades_track: OfferingTrack = _bid_row(fresh, "HADES")["track"]
	check((_bid_row(fresh, "HADES")["row"] as Control).visible and not (_bid_row(fresh, "HADES")["button"] as Button).disabled, "Hades na torze: wiersz widoczny i aktywny")
	hades_track.amount_picked.emit(hades_track, hades_track.amount_of_cell(OfferingTrack.CELLS - 1))
	check_eq([fresh.selected_god, fresh.selected_amount, fresh.validate_offer("HADES", 11)["code"]], ["HADES", 11, "CANNOT_AFFORD"], "pole „10+” to 11 JZ, a na to gracza nie stać")
	fresh.set_amount(3)
	check_eq(fresh.submit_offer()["code"], "", "ofiara na Hadesa")
	check_eq(offers, [["ARES", 2], ["HADES", 3]], "Hades jak każdy bóg")
	for node: Node in [panel, fresh, gsm, hades]:
		node.queue_free()


func test_bidding_displacement_ui() -> void:
	var gsm := _bidding_game([_slot("ARES", "p1", 2), _slot("ZEUS")], ["p2"])
	var panel := _bidding_panel()
	var observer := _bidding_panel(Vector2(560, 16))
	var offers: Array = []
	panel.offer_confirmed.connect(func(god_id: String, amount: int) -> void: offers.append([god_id, amount]))
	var shown: Array = []
	panel.displacement_shown.connect(func(player_id: String) -> void: shown.append([player_id, panel.view["revision"], panel.current_mode()]))
	# Jak NetworkManager: powiadomienie serwera trafia do obu paneli przed nowym stanem.
	gsm.offering_displaced.connect(gsm.report_bid_displaced)
	gsm.bid_displaced.connect(func(player_id: String) -> void:
		panel.show_displacement(player_id, gsm.last_bid_displacement)
		observer.show_displacement(player_id, gsm.last_bid_displacement))
	panel.apply_view(gsm.project_for("p1"))
	observer.apply_view(gsm.project_for("p3"))
	await _frames(2)
	var ares: OfferingTrack = _bid_row(panel, "ARES")["track"]
	check_eq([panel.current_mode(), ares.holder_amount, ares.holder_color], [BiddingBoardUI.Mode.WAITING, 2, TerritoryNode.PLAYER_COLORS["BLUE"]], "znacznik Gracza 1 na torze Aresa")
	var start := ares.get_global_transform() * ares.amount_center(2)
	var revision: int = gsm._state["revision"]

	check_code(gsm.apply_bid("p2", "ARES", 4), "")
	check_eq(shown, [["p1", revision, BiddingBoardUI.Mode.MUST_CHOOSE_OTHER]], "tryb „Musisz wybrać innego Boga” od razu, jeszcze przed nowym stanem")
	check((_bid_row(panel, "ARES")["button"] as Button).disabled and panel.forbidden_god() == "ARES", "bóg przebicia zablokowany")
	check_eq(panel.selected_god, "", "wybór czeka na nowy stan (dopiero w nim jest twoja kolej)")
	var flying := (panel.get_node("%Overlay") as Control).get_children()
	check_eq(flying.size(), 1, "znacznik w locie")
	if flying.size() == 1:
		var marker := flying[0] as Control
		check((marker.global_position + marker.size / 2.0).distance_to(start) < 1.0, "lot zaczyna się na polu 2 toru Aresa")
	check(ares.holder_hidden, "tor nie rysuje odlatującego znacznika")
	var sound: AudioStreamPlayer = panel.get_node("%DisplacedSound")
	var observer_sound: AudioStreamPlayer = observer.get_node("%DisplacedSound")
	check_eq([sound.playing, sound.volume_db, observer_sound.playing, observer_sound.volume_db], [true, 0.0, true, -9.0], "dźwięk: głośno dla przebitego, ciszej dla pozostałych")
	check_eq(observer.current_mode(), BiddingBoardUI.Mode.WAITING, "obserwator nadal czeka")

	panel.apply_view(gsm.project_for("p1"))
	observer.apply_view(gsm.project_for("p3"))
	var banner: Label = panel.get_node("%BannerLabel")
	check_eq([panel.current_mode(), banner.text], [BiddingBoardUI.Mode.MUST_CHOOSE_OTHER, "Przelicytowano cię na torze Aresa (Gracz 2 dał 4 JZ). Musisz wybrać innego Boga albo Apolla!"], "nowy stan potwierdza tryb")
	check_eq([ares.holder_amount, ares.holder_color, ares.forbidden, panel.selected_god], [4, TerritoryNode.PLAYER_COLORS["RED"], true, "ZEUS"], "na torze Aresa ofiara Gracza 2, wybór przechodzi na Zeusa")
	ares.amount_picked.emit(ares, 5)
	check_eq([(panel.get_node("%OfferButton") as Button).disabled, (panel.get_node("%CostLabel") as Label).text], [true, "Po przebiciu nie możesz od razu wrócić do Aresa."], "walidacja: zakaz powrotu do boga przebicia")
	check_eq(panel.submit_offer()["code"], "FORBIDDEN_GOD", "zakazana ofiara nie idzie do serwera")

	check(await _until(func() -> bool: return (panel.get_node("%Overlay") as Control).get_child_count() == 0, 2.0), "znacznik doleciał")
	var tray: HBoxContainer = panel.get_node("%DisplacedTray")
	var tray_marker := tray.get_children().filter(func(node: Node) -> bool: return node is BiddingBoardUI.Marker)
	check_eq(tray_marker.size(), 1, "znacznik czeka w tacce")
	check_eq((tray.get_child(1) as Label).text if tray.get_child_count() > 1 else "", "Twój znacznik czeka na nowego boga", "opis tacki")
	check_eq(((observer.get_node("%DisplacedTray") as HBoxContainer).get_child(1) as Label).text if (observer.get_node("%DisplacedTray") as HBoxContainer).get_child_count() > 1 else "", "Gracz 1 wybiera innego boga", "obserwator widzi, kto wybiera")
	check(panel.choose_apollo()["ok"], "Apollo zawsze wolny")
	check_eq(offers, [["APOLLO", 0]], "Apollo wysłany")
	for node: Node in [panel, observer, gsm]:
		node.queue_free()


func test_main_bidding() -> void:
	var main: Control = load("res://scenes/Main.tscn").instantiate()
	var browser: Control = main.get_node("%Browser")
	(browser.get_node("LanListener") as LanListener).discovery_ports = [_discovery_port]
	add_child(main)
	(browser.get_node("%NameEdit") as LineEdit).text = "Ariadna"
	(browser.get_node("%SingleButton") as Button).pressed.emit()
	check(await _until(func() -> bool: return (main.get_node("%Game") as Control).visible), "gra solo pokazuje panel partii")
	var panel: BiddingBoardUI = main.get_node("%BiddingBoard")
	var think := GameStateManager.ai_think_sec
	GameStateManager.ai_think_sec = 30.0  # AI nie wtrąca się w scenariusz, przebija na żądanie testu
	var me := NetworkManager.local_player_id
	var state: Dictionary = GameStateManager._state
	var seating: Array = state["seating"]
	var rival: String = seating[(seating.find(me) + 1) % 3]
	state["phase"] = "BIDDING"
	state["gods"] = [_slot("ARES"), _slot("ZEUS")]
	state["apollo"] = []
	state["bidding"] = {"queue": [me, rival, seating[(seating.find(me) + 2) % 3]], "displaced": "", "forbidden": ""}
	GameStateManager._commit()
	check(await _until(func() -> bool: return panel.view.get("revision", -1) == state["revision"] and panel.visible), "panel licytacji dostał stan")
	await _frames(2)
	check_eq(panel.current_mode(), BiddingBoardUI.Mode.CHOOSING, "twoja kolej w Main.tscn")

	var ares: OfferingTrack = _bid_row(panel, "ARES")["track"]
	await _mouse_click(ares.get_global_transform() * ares.amount_center(2))
	check_eq([panel.selected_god, panel.selected_amount], ["ARES", 2], "kliknięcie pola 2 na torze Aresa")
	await _mouse_click((panel.get_node("%OfferButton") as Button).get_global_rect().get_center())
	check_eq(BidRules.god_slot(GameStateManager._state, "ARES"), _slot("ARES", me, 2), "serwer przyjął ofiarę z panelu")

	var shown: Array = []
	panel.displacement_shown.connect(func(player_id: String) -> void: shown.append(player_id))
	check_code(GameStateManager.apply_bid(rival, "ARES", 3), "")
	check_eq([shown, panel.current_mode()], [[me], BiddingBoardUI.Mode.MUST_CHOOSE_OTHER], "powiadomienie z serwera: od razu „Musisz wybrać innego Boga”")
	check((panel.get_node("%DisplacedSound") as AudioStreamPlayer).playing, "dźwięk przebicia")
	await _frames(2)
	check_eq(panel.forbidden_god(), "ARES", "Ares zablokowany")
	NetworkManager.action_rejected.emit("BID_TOO_LOW", "Serwer: za mało.")
	check_eq((panel.get_node("%CostLabel") as Label).text, "Serwer: za mało.", "odmowa serwera trafia do panelu")
	await _mouse_click((panel.get_node("%ApolloButton") as Button).get_global_rect().get_center())
	check(GameStateManager._state["apollo"].has(me), "kliknięcie Apolla: serwer przyjął")
	check((main.get_node("%Log") as RichTextLabel).get_parsed_text().contains("przebija ofiarę gracza Ariadna na ARES"), "dziennik opisuje przebicie")
	GameStateManager.ai_think_sec = think
	(main.get_node("%LeaveButton") as Button).pressed.emit()
	main.queue_free()


# =============================================================================
# Pomocnicze
# =============================================================================

func _logic_game(ai: Array = [false, false, false]) -> GameState:
	var gsm: GameState = GameState.new()
	gsm.name = "Logika%d" % _machines_created
	_machines_created += 1
	gsm.ai_think_sec = 0.02
	add_child(gsm)
	var players: Array = []
	for i in ai.size():
		players.append({"id": "p%d" % (i + 1), "name": "Gracz %d" % (i + 1), "is_ai": ai[i]})
	gsm.start_new_game(players)
	return gsm


## Wyspa w pełnym schemacie stanu serwera (budynki, nieumarli z Hadesa).
func _isle(owner_id: String, troops: int, buildings: Array = [], undead := 0) -> Dictionary:
	var island := GameState._island(owner_id, troops)
	island["buildings"] = buildings.duplicate()
	island["undead_troops"] = undead
	return island


## Pole morskie w pełnym schemacie stanu serwera.
func _sea(owner_id: String, fleets: int, undead := 0) -> Dictionary:
	var sea := GameState._sea(owner_id, fleets)
	sea["undead_fleets"] = undead
	return sea


## Stan partii do testów reguł: tura boga `god` gracza p1, miasta i floty startowe.
func _rules_state(god: String) -> Dictionary:
	var gsm := _logic_game()
	_turn(gsm, god, "p1")
	var state: Dictionary = gsm._state.duplicate(true)
	gsm.queue_free()
	return state


func _sorted_keys(dictionary: Dictionary) -> Array:
	var keys := dictionary.keys()
	keys.sort()
	return keys


func _marks(board: Board) -> Dictionary:
	var marks := {}
	for node in board.territories():
		marks[node.territory_id] = node.mark
	return marks


## Punkt pola planszy w oknie: położenie kontenera mapy + punkt pola w jej viewporcie.
func _board_point(container: SubViewportContainer, board: Board, territory_id: String) -> Vector2:
	return container.global_position + board.viewport_point_of(territory_id)


func _screen_point(container: SubViewportContainer, board: Board, territory_id: String) -> Vector2:
	return container.get_global_rect().position + board.viewport_point_of(territory_id)


## Ruch myszy do punktu okna. Zdarzenie idzie do okna jak od systemu, a picking dzieje się w klatce fizyki.
func _mouse_move(point: Vector2) -> void:
	get_tree().root.push_input(_sync_mouse(point))
	await _physics_frames(2)


## Kliknięcie w punkcie okna (wciśnięcie i puszczenie).
func _mouse_click(point: Vector2, button: MouseButton = MOUSE_BUTTON_LEFT) -> void:
	_sync_mouse(point)
	for pressed: bool in [true, false]:
		var click := InputEventMouseButton.new()
		click.button_index = button
		click.pressed = pressed
		click.position = point
		click.global_position = point
		get_tree().root.push_input(click)
		await _physics_frames(2)


## Zdarzenie ruchu myszy w punkcie okna. Ta sama pozycja trafia też do Input: w klatkach
## bez zdarzeń picking sam sprawdza pole pod kursorem w Input.get_mouse_position(), a bez
## okna nikt tej pozycji nie aktualizuje. Bez okna Input.parse_input_event niczego nie
## dostarcza do viewportów, więc zdarzenie nie przyjdzie drugi raz.
func _sync_mouse(point: Vector2) -> InputEventMouseMotion:
	var motion := InputEventMouseMotion.new()
	motion.position = point
	motion.global_position = point
	Input.parse_input_event(motion.duplicate())
	return motion


func _physics_frames(count: int) -> void:
	for i in count:
		await get_tree().physics_frame


func _slot(god_id: String, holder := "", amount := 0) -> Dictionary:
	return {"god": god_id, "holder": holder, "amount": amount}


## Licytacja do testów: bogowie na torze i kolejka. Gracze nie są AI, więc nic nie dzieje się samo.
func _bidding_game(gods: Array, queue: Array) -> GameState:
	var gsm := _logic_game()
	gsm._state["phase"] = "BIDDING"
	gsm._state["gods"] = gods
	gsm._state["apollo"] = []
	gsm._state["bidding"] = {"queue": queue, "displaced": "", "forbidden": ""}
	return gsm


func _bidding_panel(at: Vector2 = Vector2(16, 16)) -> BiddingBoardUI:
	var panel: BiddingBoardUI = load("res://bidding/BiddingBoard.tscn").instantiate()
	panel.follow_game_state = false
	panel.animation_sec = 0.2
	panel.position = at
	add_child(panel)
	return panel


func _bid_row(panel: BiddingBoardUI, god_id: String) -> Dictionary:
	return panel._rows.get(god_id, {})


func _bid_buttons(panel: BiddingBoardUI) -> Array:
	return panel._rows.values().map(func(row: Dictionary) -> Button: return row["button"])


func _enabled_gods(panel: BiddingBoardUI) -> Array:
	return panel._rows.keys().filter(func(god_id: String) -> bool: return not (panel._rows[god_id]["button"] as Button).disabled)


func _machine(machine_name: String) -> Machine:
	var machine := Machine.new()
	machine.root = Node.new()
	machine.root.name = "%s%d" % [machine_name, _machines_created]
	_machines_created += 1
	add_child(machine.root)
	get_tree().set_multiplayer(SceneMultiplayer.new(), machine.root.get_path())
	machine.state = GameState.new()
	machine.state.name = "GameStateManager"
	machine.state.ai_think_sec = 0.02
	machine.root.add_child(machine.state)
	machine.net = Network.new()
	machine.net.name = "NetworkManager"
	machine.net.reconnect_window_sec = 1.0
	machine.net.peer_timeout_ms = 2000
	machine.net.discovery_targets = PackedStringArray(["127.0.0.1"])
	machine.net.discovery_subnet_broadcasts = false
	machine.net.discovery_ports = [_discovery_port]
	machine.net.single_player_ports = _single_player_ports
	# Długi takt: każda zmiana w lobby musi trafić do ogłoszenia od razu, a nie z kolejnego taktu.
	machine.net.discovery_interval_sec = 60.0
	machine.root.add_child(machine.net)
	machine.net.action_rejected.connect(func(code: String, _message: String) -> void: machine.rejections.append(code))
	machine.net.connection_failed.connect(func(code: String, _message: String) -> void: machine.failures.append(code))
	machine.net.lobby_changed.connect(func(players: Array, _settings: Dictionary) -> void: machine.lobbies.append(players))
	machine.net.server_disconnected.connect(func() -> void: machine.server_lost = true)
	machine.state.battle_reported.connect(func(received: Dictionary) -> void: machine.battles.append(received))
	machine.state.bid_displaced.connect(func(player_id: String) -> void:
		var bidding: Dictionary = machine.state.view.get("bidding", {})
		machine.displacements.append({"player": player_id, "displaced_in_view": bidding.get("displaced", ""), "revision": machine.state.view.get("revision", -1)}))
	return machine


## Host i klienci połączeni przez ENet na 127.0.0.1, wszyscy zarejestrowani.
func _lan_table(client_names: Array) -> Array:
	var port := _free_port()
	var host := _machine("Host")
	check_eq(host.net.host_game("Gospodarz", port), OK, "host uruchamia serwer")
	var table: Array = [host]
	for client_name in client_names:
		var client := _machine(client_name)
		check_eq(client.net.join_game("127.0.0.1", port, client_name), OK, "klient %s łączy się" % client_name)
		table.append(client)
	check(await _until(func() -> bool: return table.all(func(m: Machine) -> bool: return m.player_id() != "")), "wszyscy zarejestrowani")
	return table


## Stół z rozpoczętą partią: host (p1) i dwóch klientów (p2, p3).
func _started_table() -> Array:
	var table := await _lan_table(["Tezeusz", "Dedal"])
	var host: Machine = table[0]
	check_code(host.net.start_game(), "")
	check(await _until(func() -> bool: return table.all(func(m: Machine) -> bool: return not m.state.view.is_empty())), "partia dotarła do wszystkich")
	return table


func _free(machines: Array) -> void:
	for machine in machines:
		machine.net.leave_game()
		machine.root.queue_free()


func _machine_of(machines: Array, player_id: String) -> Machine:
	for machine in machines:
		if machine.player_id() == player_id:
			return machine
	check(false, "brak komputera gracza %s" % player_id)
	return machines[0]


func _other_than(excluded: Array) -> String:
	for player_id in ["p1", "p2", "p3"]:
		if not excluded.has(player_id):
			return player_id
	return ""


func _god(gsm: GameState, index: int) -> String:
	return String(gsm._state["gods"][index]["god"])


func _gold(gsm: GameState, player_id: String) -> int:
	return int(gsm._state["players"][player_id]["gold"])


func _turn(gsm: GameState, god: String, player_id: String) -> void:
	gsm._state["phase"] = "ACTIONS"
	gsm._state["turns"] = [{"god": god, "player": player_id}]
	gsm._state["turn_index"] = 0


func _city_of(state: Dictionary, player_id: String) -> String:
	var index: int = state["seating"].find(player_id)
	return String(GameState.MAP["cities"][index][0])


func _has_event(state: Dictionary, expected: Dictionary) -> bool:
	for event in state.get("log", []):
		if expected.keys().all(func(key: String) -> bool: return event.get(key) == expected[key]):
			return true
	return false


## Raport bitwy: w każdej rundzie wynik = rzut + jednostki + modyfikatory, a straty zgadzają się z wynikami.
func _check_report_consistency(report: Dictionary, attackers: int, defenders: int) -> void:
	var attacking := attackers
	var defending := defenders
	for battle_round in report.get("rounds", []):
		for side_name in ["attacker", "defender"]:
			var side: Dictionary = battle_round[side_name]
			var bonus := 0
			for modifier in side["modifiers"]:
				bonus += int(modifier["value"])
			check(int(side["roll"]) in GameState.BATTLE_DIE, "rzut z kości bitewnej")
			check_eq(int(side["total"]), int(side["roll"]) + int(side["units"]) + bonus, "wynik = rzut + jednostki + modyfikatory")
		check_eq([battle_round["attacker"]["units"], battle_round["defender"]["units"]], [attacking, defending], "jednostki na początku rundy")
		var a_total := int(battle_round["attacker"]["total"])
		var d_total := int(battle_round["defender"]["total"])
		check_eq([battle_round["attacker"]["loss"], battle_round["defender"]["loss"]], [a_total <= d_total, d_total <= a_total], "straty według wyników")
		attacking -= 1 if battle_round["attacker"]["loss"] else 0
		defending -= 1 if battle_round["defender"]["loss"] else 0
	var expected := "MUTUAL_DESTRUCTION"
	if attacking > 0:
		expected = "ATTACKER_WON"
	elif defending > 0:
		expected = "DEFENDER_WON"
	check_eq(report.get("outcome"), expected, "wynik bitwy zgodny z rundami")


## Odbiornik ogłoszeń na podanych portach (autostart przy dodaniu do drzewa).
func _listener(ports: Array[int], lost_after_sec: float) -> LanListener:
	var listener := LanListener.new()
	listener.discovery_ports = ports
	listener.lost_after_sec = lost_after_sec
	add_child(listener)
	return listener


## Nadajnik, który wysyła tylko na 127.0.0.1 i częściej niż domyślnie (0,2 s).
func _beacon(ports: Array[int]) -> LanBeacon:
	var beacon := LanBeacon.new()
	beacon.discovery_ports = ports
	beacon.targets = PackedStringArray(["127.0.0.1"])
	beacon.subnet_broadcasts = false
	beacon.interval_sec = 0.2
	add_child(beacon)
	return beacon


func _udp_port() -> int:
	_next_udp_port += 2
	while not Network._udp_port_free(_next_udp_port, "*") or not Network._udp_port_free(_next_udp_port + 1, "*"):
		_next_udp_port += 2
	return _next_udp_port


## Następny wolny port serwera gry z pasa tego procesu (pomija porty zajęte przez inne programy).
func _free_port() -> int:
	while not Network._udp_port_free(_next_port, "*"):
		_next_port += 1
	_next_port += 1
	return _next_port - 1


func _first_server(listener: LanListener) -> Dictionary:
	var servers := listener.servers()
	return servers[0] if servers.size() > 0 else {}


func _until(condition: Callable, timeout_sec: float = 3.0) -> bool:
	var deadline := Time.get_ticks_msec() + int(timeout_sec * 1000.0)
	while not condition.call():
		if Time.get_ticks_msec() > deadline:
			return false
		await get_tree().process_frame
	return true


func _frames(count: int) -> void:
	for i in count:
		await get_tree().process_frame


func _run(title: String, test: Callable) -> void:
	_current_failed = false
	_allowed_errors.clear()
	var errors_before := _errors.size()
	await test.call()
	await _frames(3)  # także błędy przy zwalnianiu węzłów na końcu klatki
	for entry in _errors.since(errors_before):
		if not _allowed_errors.any(func(fragment: String) -> bool: return entry.contains(fragment)):
			check(false, "nieoczekiwany błąd: %s" % entry)
	if _current_failed:
		_failed += 1
		print("✖ %s" % title)
	else:
		_passed += 1
		print("✔ %s" % title)


## Test deklaruje błąd, który ma wystąpić (np. Godot odrzuca podrobione RPC).
func _allow_error(fragment: String) -> void:
	_allowed_errors.append(fragment)


func check(condition: bool, message: String) -> void:
	if not condition:
		_current_failed = true
		print("    ✗ %s" % message)


func check_eq(actual: Variant, expected: Variant, message: String) -> void:
	if actual != expected:
		_current_failed = true
		print("    ✗ %s: jest %s, oczekiwano %s" % [message, str(actual), str(expected)])


func check_code(result: Dictionary, expected_code: String) -> void:
	var code: String = "" if result.get("ok", false) else String(result.get("code", "?"))
	check_eq(code, expected_code, "kod wyniku (%s)" % result.get("message", ""))
