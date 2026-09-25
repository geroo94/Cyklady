## GameStateManager: stan partii Cyklady i reguły wykonywane tylko na serwerze.
##
## AUTORYTET
##   Pełny stan (`_state`) istnieje wyłącznie na serwerze, czyli u hosta. Każda
##   zmiana przechodzi przez metodę `apply_*`, która najpierw sprawdza WSZYSTKIE
##   warunki (tura, bóg, złoto, właściciel pola, zasięg ruchu), a dopiero potem
##   zmienia stan. Odrzucona akcja nie zostawia więc żadnego śladu.
##   Klient nie ma dostępu do `_state`: od serwera dostaje `view`, czyli
##   projekcję stanu dla swojego gracza (bez złota rywali).
##
## PRZEPŁYW NA SERWERZE
##   NetworkManager ─► apply_bid / apply_move / apply_build / apply_end_turn ─► walidacja ─► zmiana stanu
##                                                                                              │
##   NetworkManager ◄─ sygnał state_committed (rozesłanie projekcji) ◄─────────── _commit() ◄──┘
##   Bitwy rozstrzyga serwer kośćmi z kryptograficznego źródła losowości,
##   a raport trafia do wszystkich przez sygnał battle_resolved. Przebicie
##   ofiary w licytacji też ma powiadomienie (offering_displaced → bid_displaced).
##   Oba docierają do graczy przed nowym stanem gry.
##
## Stan to Dictionary z typami JSON (String, int, bool, Array, Dictionary),
## więc przechodzi przez RPC bez przesyłania obiektów.
##
## Tury bogów: ruch, budowa, rekrutacja (RecruitRules), zakup stworów i akcja Zeusa
## (CreatureRules). Po każdej zmianie działają efekty stanowe: komplet budynków albo
## czterech filozofów zamienia się w Metropolię. Na koniec cyklu wygrywa gracz
## z 2 Metropoliami (remis: więcej złota).
##
## Uproszczenia względem pełnych zasad: bez herosów, tury Hadesa i Monumentów, Apollo
## daje zawsze 1 JZ, a bitwa toczy się do rozstrzygnięcia, bez odwrotów.
extends Node

## Wszyscy: nowa projekcja stanu dla lokalnego gracza (rysuje ją UI).
signal view_changed(view: Dictionary)
## Wszyscy: raport bitwy od serwera (rzuty, jednostki, modyfikatory, straty, wynik).
signal battle_reported(report: Dictionary)
## Serwer: stan się zmienił i trzeba rozesłać projekcje graczom.
signal state_committed
## Serwer: bitwa rozstrzygnięta, raport do rozesłania.
signal battle_resolved(report: Dictionary)
## Wszyscy: ofiarę gracza `player_id` przebito. Przychodzi przed nowym stanem gry, więc
## `view` pokazuje jeszcze znacznik przebitego gracza. Szczegóły są w `last_bid_displacement`.
signal bid_displaced(player_id: String)
## Serwer: ofiara przebita, powiadomienie do rozesłania.
signal offering_displaced(event: Dictionary)

const GODS := ["POSEIDON", "ARES", "ZEUS", "ATHENA"]
const APOLLO := BidRules.APOLLO
## Budynek, który gracz stawia w turze danego boga.
const GOD_BUILDING := MoveRules.GOD_BUILDING
## Kość bitewna Cyklad: ścianki 0, 1, 1, 2, 2, 3.
const BATTLE_DIE := [0, 1, 1, 2, 2, 3]
## Liczba bogów odkrywanych w cyklu (klucz: liczba graczy).
const GODS_REVEALED := {3: 2, 4: 3, 5: 4}
const MIN_PLAYERS := 3
const MAX_PLAYERS := 5
const STARTING_GOLD := 5
const STARTING_TROOPS := 2
const STARTING_FLEETS := 1
const MOVE_COST := MoveRules.MOVE_COST
const BUILD_COST := MoveRules.BUILD_COST
## Flota płynie najwyżej przez tyle pól morskich.
const FLEET_RANGE := MoveRules.FLEET_RANGE
const MAX_BID := BidRules.MAX_BID
const COLORS := ["BLUE", "RED", "GREEN", "YELLOW", "BLACK"]
## Komplet różnych budynków, który od razu zamienia się w Metropolię.
const METROPOLIS_BUILDINGS := ["PORT", "FORTRESS", "TEMPLE", "UNIVERSITY"]
## Tylu filozofów od razu zamienia się w Metropolię.
const PHILOSOPHERS_PER_METROPOLIS := 4
const METROPOLISES_TO_WIN := MoveRules.METROPOLISES_TO_WIN
## Tyle ostatnich zdarzeń trzyma dziennik partii w stanie (dla UI).
const LOG_SIZE := 30

## Mapa „Archipelag” (sąsiedztwo pól, miasta startowe). Wspólna dla reguł i planszy.
const MAP := ArchipelagoMap.MAP
## Baza treści (talia stworów). Preload zamiast autoloadu, więc działa też w testach i narzędziach.
const Data := preload("res://scripts/autoload/GameData.gd")

## Wszyscy: projekcja stanu dla lokalnego gracza (pusta poza partią).
var view: Dictionary = {}
## Wszyscy: ostatnie przebicie ofiary { player, by, god, amount, previous_amount, revision }.
var last_bid_displacement: Dictionary = {}
## Serwer: opóźnienie ruchu AI w sekundach, żeby gracze widzieli kolejne decyzje.
var ai_think_sec := 0.4

## Serwer: pełny, autorytatywny stan partii (pusty poza partią).
var _state: Dictionary = {}
var _crypto := Crypto.new()


# =============================================================================
# Odczyt (wszyscy)
# =============================================================================

## Czy trwa partia (licytacja albo tury bogów).
func is_game_running() -> bool:
	return _state.get("phase", "") in ["BIDDING", "ACTIONS"]


## Serwer: gracz, na którego ruch czeka gra (pusty napis, gdy nie czeka na nikogo).
func current_actor() -> String:
	return actor_of(_state)


## Na kogo czeka gra według podanego stanu albo projekcji (serwer i UI liczą tak samo).
static func actor_of(state: Dictionary) -> String:
	match state.get("phase", ""):
		"BIDDING":
			return BidRules.bidder_of(state)
		"ACTIONS":
			return String(state["turns"][state["turn_index"]]["player"])
	return ""


## Bóg, którego tura trwa (w fazie ACTIONS).
static func god_of(state: Dictionary) -> String:
	if state.get("phase", "") != "ACTIONS":
		return ""
	return String(state["turns"][state["turn_index"]]["god"])


## UI: czy gra czeka na ruch lokalnego gracza.
func is_my_turn() -> bool:
	return not view.is_empty() and actor_of(view) == view.get("you", "")


## Koszt ofiary: kwota minus kapłani, ale zawsze co najmniej 1 JZ.
static func offering_cost(amount: int, priests: int) -> int:
	return BidRules.offering_cost(amount, priests)


# =============================================================================
# Serwer: przebieg partii
# =============================================================================

## Nowa partia dla graczy [{ "id", "name", "is_ai" }] w kolejności przy stole.
## `expansions` ({ "hades", "monuments" }) trafia do stanu, żeby UI wiedziało, z czym gramy.
func start_new_game(players: Array, expansions: Dictionary = {}) -> Dictionary:
	if players.size() < MIN_PLAYERS or players.size() > MAX_PLAYERS:
		return _fail("PLAYER_COUNT", "Cyklady wymagają od %d do %d graczy." % [MIN_PLAYERS, MAX_PLAYERS])
	var state := {
		"game_id": _crypto.generate_random_bytes(8).hex_encode(),
		"expansions": {"hades": bool(expansions.get("hades", false)), "monuments": bool(expansions.get("monuments", false))},
		"revision": 0,
		"cycle": 0,
		"phase": "SETUP",
		"seating": [],
		"players": {},
		"islands": {},
		"seas": {},
		"gods": [],
		"apollo": [],
		"bidding": {"queue": [], "displaced": "", "forbidden": ""},
		"turns": [],
		"turn_index": 0,
		# Zakupy w bieżącej turze boga (liczniki rekrutacji), zob. _turn_progress.
		"turn_progress": {},
		# Zwycięzcy po końcu gry (faza GAME_OVER).
		"winners": [],
		# Tor stworów: pole 0 za 2 JZ (najstarsza karta), 1 za 3 JZ, 2 za 4 JZ. Talia jest zakryta
		# (projekcja podaje tylko jej rozmiar), a stos odrzuconych odkryty.
		"creatures": {"slots": ["", "", ""], "deck": [], "discard": []},
		# Figurki stworów: pole morskie z Krakenem i Minotaur { "island", "player" }.
		"kraken": "",
		"minotaur": {},
		"log": [],
		"log_seq": 0,
	}
	for island_id in MAP["islands"]:
		state["islands"][island_id] = _island("", 0)
	for sea_id in MAP["seas"]:
		state["seas"][sea_id] = _sea("", 0)
	for i in players.size():
		var entry: Dictionary = players[i]
		var id := String(entry["id"])
		state["seating"].append(id)
		state["players"][id] = {
			"id": id,
			"name": String(entry["name"]),
			"color": COLORS[i],
			"gold": STARTING_GOLD,
			"priests": 0,
			"philosophers": 0,
			"is_ai": bool(entry.get("is_ai", false)),
			"connected": true,
			"reconnect_deadline": 0.0,
		}
		var city: Array = MAP["cities"][i]
		state["islands"][city[0]] = _island(id, STARTING_TROOPS)
		state["seas"][city[1]] = _sea(id, STARTING_FLEETS)
	_state = state
	# Talia stworów podstawki. Herosi (Hades) trafią do niej razem z obsługą Hadesa w Godot.
	state["creatures"]["deck"] = _shuffled(Array(Data.myth_deck({})))
	_begin_cycle(_shuffled(state["seating"]))
	_commit()
	return _ok()


## Ofiara dla boga `god_id` za `amount` JZ albo wybór Apolla (`god_id == "APOLLO"`).
## Walidacja to BidRules.bid_error: tę samą funkcję wywołuje UI licytacji przed wysłaniem RPC.
func apply_bid(player_id: String, god_id: String, amount: int) -> Dictionary:
	var code := BidRules.bid_error(_state, player_id, god_id, amount)
	if code != "":
		return _fail(code, _bid_error_message(code, player_id, god_id, amount))
	var bidding: Dictionary = _state["bidding"]
	var was_displaced: bool = bidding["displaced"] == player_id
	if god_id == APOLLO:
		_state["apollo"].append(player_id)
		_log({"type": "APOLLO", "player": player_id, "position": _state["apollo"].size()})
		_finish_bid(was_displaced, "", "")
		_commit()
		return _ok()

	# Walidacja zakończona: dopiero teraz zmieniamy stan.
	var slot := _god_slot(god_id)
	var previous := String(slot["holder"])
	var previous_amount := int(slot["amount"])
	slot["holder"] = player_id
	slot["amount"] = amount
	_log({"type": "OFFER", "player": player_id, "god": god_id, "amount": amount})
	if previous != "":
		var event := {"player": previous, "by": player_id, "god": god_id, "amount": amount, "previous_amount": previous_amount}
		_log({"type": "OUTBID"}.merged(event))
		# Powiadomienie przed nowym stanem (jak raport bitwy): UI zdąży pokazać znacznik zdejmowany z toru.
		event["revision"] = int(_state["revision"]) + 1
		offering_displaced.emit(event)
	_finish_bid(was_displaced, previous, god_id)
	_commit()
	return _ok()


## Ruch wojsk (wyspa → wyspa, tura Aresa, po łańcuchu własnych flot) albo flot
## (morze → morze, tura Posejdona, do FLEET_RANGE pól). Wejście na pole
## przeciwnika wywołuje bitwę, którą serwer od razu rozstrzyga.
func apply_move(player_id: String, from_id: String, to_id: String, count: int) -> Dictionary:
	var error := _god_turn_error(player_id)
	if not error.is_empty():
		return error
	var land: bool = _state["islands"].has(from_id) and _state["islands"].has(to_id)
	var sea: bool = _state["seas"].has(from_id) and _state["seas"].has(to_id)
	if not land and not sea:
		return _fail("INVALID_MOVE", "Ruch prowadzi z wyspy na wyspę albo z morza na morze.")
	if from_id == to_id:
		return _fail("INVALID_MOVE", "Cel ruchu musi być inny niż start.")
	var god := god_of(_state)
	if land and god != "ARES":
		return _fail("WRONG_GOD", "Wojska porusza tylko tura Aresa.")
	if sea and god != "POSEIDON":
		return _fail("WRONG_GOD", "Floty porusza tylko tura Posejdona.")
	var nodes: Dictionary = _state["islands"] if land else _state["seas"]
	var unit_key := "troops" if land else "fleets"
	var origin: Dictionary = nodes[from_id]
	if origin["owner"] != player_id:
		return _fail("NOT_OWNER", "Nie masz jednostek na polu %s." % from_id)
	if count < 1 or count > int(origin[unit_key]):
		return _fail("NOT_ENOUGH_UNITS", "Na polu %s masz %d jednostek." % [from_id, int(origin[unit_key])])
	var player: Dictionary = _state["players"][player_id]
	if int(player["gold"]) < MOVE_COST:
		return _fail("CANNOT_AFFORD", "Ruch kosztuje %d JZ." % MOVE_COST)
	if land and not MoveRules.has_fleet_bridge(_state, player_id, from_id, to_id):
		return _fail("NO_FLEET_BRIDGE", "Między %s a %s nie ma łańcucha twoich flot." % [from_id, to_id])
	if sea and MoveRules.fleet_distance(_state, player_id, from_id, to_id) < 0:
		return _fail("OUT_OF_RANGE", "Flota płynie najwyżej %d pola morskie i nie mija obcych flot." % FLEET_RANGE)
	if land and MoveRules.last_island_protected(_state, player_id, to_id):
		return _fail("LAST_ISLAND_PROTECTED", "Nie można zająć ostatniej wyspy gracza %s." % _name(String(nodes[to_id]["owner"])))

	# Walidacja zakończona: zmiana stanu.
	player["gold"] = int(player["gold"]) - MOVE_COST
	_execute_move(land, player_id, from_id, to_id, count)
	_commit()
	return _ok()


## Budowa w turze boga: Posejdon stawia Port, Ares Fortecę, Zeus Świątynię, Atena Uniwersytet.
func apply_build(player_id: String, island_id: String) -> Dictionary:
	var error := _god_turn_error(player_id)
	if not error.is_empty():
		return error
	var god := god_of(_state)
	if not GOD_BUILDING.has(god):
		return _fail("WRONG_GOD", "W turze Apolla nie ma budowy.")
	if not _state["islands"].has(island_id):
		return _fail("UNKNOWN_ISLAND", "Nie ma wyspy %s." % island_id)
	var island: Dictionary = _state["islands"][island_id]
	if island["owner"] != player_id:
		return _fail("NOT_OWNER", "Wyspa %s nie należy do ciebie." % island_id)
	if island["buildings"].size() >= int(MAP["islands"][island_id]["slots"]):
		return _fail("NO_FREE_SLOT", "Na wyspie %s nie ma wolnego miejsca." % island_id)
	var player: Dictionary = _state["players"][player_id]
	if int(player["gold"]) < BUILD_COST:
		return _fail("CANNOT_AFFORD", "Budynek kosztuje %d JZ." % BUILD_COST)

	player["gold"] = int(player["gold"]) - BUILD_COST
	island["buildings"].append(GOD_BUILDING[god])
	_log({"type": "BUILD", "player": player_id, "island": island_id, "building": GOD_BUILDING[god]})
	_commit()
	return _ok()


## Rekrutacja w turze boga: oddział (Ares) na własnej wyspie, flota (Posejdon) przy własnej
## wyspie, kapłan (Zeus) albo filozof (Atena). Jedno wywołanie to jedna sztuka. Walidacja
## i koszt to RecruitRules: te same funkcje może wywołać UI przed wysłaniem RPC.
func apply_recruit(player_id: String, kind: String, target_id: String) -> Dictionary:
	var code := RecruitRules.recruit_error(_state, player_id, kind, target_id)
	if code != "":
		return _fail(code, _recruit_error_message(code, player_id, kind, target_id))

	# Walidacja zakończona: zmiana stanu.
	var cost := RecruitRules.next_cost(_state, kind)
	var player: Dictionary = _state["players"][player_id]
	player["gold"] = int(player["gold"]) - cost
	match kind:
		"TROOP":
			var island: Dictionary = _state["islands"][target_id]
			island["troops"] = int(island["troops"]) + 1
		"FLEET":
			var sea: Dictionary = _state["seas"][target_id]
			sea["owner"] = player_id
			sea["fleets"] = int(sea["fleets"]) + 1
		"PRIEST":
			player["priests"] = int(player["priests"]) + 1
		"PHILOSOPHER":
			player["philosophers"] = int(player["philosophers"]) + 1
	var recruited: Dictionary = _turn_progress()["recruited"]
	recruited[kind] = int(recruited.get(kind, 0)) + 1
	_log({"type": "RECRUIT", "player": player_id, "kind": kind, "target": target_id, "cost": cost})
	_commit()
	return _ok()


## Zakup stwora z pola toru `slot` w turze dowolnego boga. Moc działa od razu na cel z `params`
## (opis celów w CreatureRules). Walidacja i cena to CreatureRules, te same funkcje co w UI.
func apply_buy_creature(player_id: String, slot: int, params: Dictionary) -> Dictionary:
	var code := CreatureRules.buy_error(_state, player_id, slot, params)
	if code != "":
		return _fail(code, _creature_error_message(code, player_id, CreatureRules.total_cost(_state, player_id, slot, params)))

	# Walidacja zakończona: zmiana stanu.
	var cost := CreatureRules.total_cost(_state, player_id, slot, params)
	var discounted := CreatureRules.discount_available(_state, player_id) and CreatureRules.temples_of(_state, player_id) > 0
	var creatures: Dictionary = _state["creatures"]
	var key := String(creatures["slots"][slot])
	creatures["slots"][slot] = ""
	creatures["discard"].append(key)
	var player: Dictionary = _state["players"][player_id]
	player["gold"] = int(player["gold"]) - cost
	if discounted:
		_turn_progress()["discount_used"] = true
	_log({"type": "CREATURE", "player": player_id, "creature": key, "cost": cost})
	_apply_creature(key, player_id, params)
	_commit()
	return _ok()


## Akcja specjalna Zeusa: za 1 JZ karta z pola `slot` idzie na stos, a jej miejsce zajmuje wierzch talii.
func apply_swap_creature(player_id: String, slot: int) -> Dictionary:
	var code := CreatureRules.swap_error(_state, player_id, slot)
	if code != "":
		return _fail(code, _creature_error_message(code, player_id, CreatureRules.SWAP_COST))
	var creatures: Dictionary = _state["creatures"]
	var discarded := String(creatures["slots"][slot])
	creatures["discard"].append(discarded)
	creatures["slots"][slot] = _draw_creature()
	var player: Dictionary = _state["players"][player_id]
	player["gold"] = int(player["gold"]) - CreatureRules.SWAP_COST
	_log({"type": "SWAP_CREATURE", "player": player_id, "discarded": discarded, "drawn": creatures["slots"][slot]})
	_commit()
	return _ok()


## Koniec tury boga. Po ostatniej turze zaczyna się nowy cykl.
func apply_end_turn(player_id: String) -> Dictionary:
	var error := _god_turn_error(player_id)
	if not error.is_empty():
		return error
	_log({"type": "END_TURN", "player": player_id})
	_state["turn_index"] = int(_state["turn_index"]) + 1
	if _state["turn_index"] >= _state["turns"].size():
		var winners := _winners()
		if not winners.is_empty():
			_state["phase"] = "GAME_OVER"
			_state["winners"] = winners
			_log({"type": "GAME_OVER", "winners": winners.duplicate()})
		else:
			# Kolejność licytacji w następnym cyklu to kolejność tur w tym cyklu.
			var order: Array = []
			for turn in _state["turns"]:
				order.append(turn["player"])
			_begin_cycle(order)
	else:
		_on_turn_started()
	_commit()
	return _ok()


# =============================================================================
# Serwer: połączenia graczy (stan gry zostaje nietknięty)
# =============================================================================

## Gracz rozłączony (miejsce czeka do `reconnect_deadline`) albo z powrotem.
func set_player_connected(player_id: String, connected: bool, reconnect_deadline: float = 0.0) -> void:
	if not _state.get("players", {}).has(player_id):
		return
	var player: Dictionary = _state["players"][player_id]
	player["connected"] = connected
	player["reconnect_deadline"] = 0.0 if connected else reconnect_deadline
	_log({"type": "CONNECTION", "player": player_id, "connected": connected})
	_commit()


## Miejsce przejmuje AI (gracz nie wrócił na czas). Jeśli to jego tura, AI od razu gra.
func set_player_ai(player_id: String) -> void:
	if not _state.get("players", {}).has(player_id):
		return
	var player: Dictionary = _state["players"][player_id]
	player["is_ai"] = true
	player["connected"] = true
	player["reconnect_deadline"] = 0.0
	_log({"type": "AI_TAKEOVER", "player": player_id})
	_commit()


## Projekcja stanu dla gracza: złoto rywali jest tajne (-1), a z talii stworów widać tylko liczbę
## kart (kolejność zna wyłącznie serwer). Reszta planszy i tor stworów są jawne.
func project_for(player_id: String) -> Dictionary:
	var projected := _state.duplicate(true)
	for id in projected["players"]:
		if id != player_id:
			projected["players"][id]["gold"] = -1
	var creatures: Dictionary = projected.get("creatures", {})
	if creatures.has("deck"):
		creatures["deck_size"] = creatures["deck"].size()
		creatures.erase("deck")
	projected["you"] = player_id
	return projected


# =============================================================================
# Wszyscy: projekcja od serwera
# =============================================================================

## Nowa projekcja od serwera (na hoście podawana lokalnie, bez sieci).
func apply_view(new_view: Dictionary) -> void:
	view = new_view
	view_changed.emit(view)


## Raport bitwy od serwera: na hoście podawany lokalnie, u klienta z RPC.
func report_battle(report: Dictionary) -> void:
	battle_reported.emit(report)


## Powiadomienie o przebitej ofierze: na hoście lokalnie, u klienta z RPC. Przychodzi przed nowym stanem.
func report_bid_displaced(event: Dictionary) -> void:
	last_bid_displacement = event
	bid_displaced.emit(String(event.get("player", "")))


## Koniec partii albo wyjście z gry: czyści stan i projekcję.
func reset() -> void:
	_state = {}
	view = {}
	last_bid_displacement = {}
	view_changed.emit(view)


# =============================================================================
# Reguły (pomocnicze)
# =============================================================================

## Nowy cykl: tor stworów, dochód (od drugiego cyklu), odkrycie bogów i licytacja w podanej kolejności.
func _begin_cycle(order: Array) -> void:
	_refresh_creatures()
	_state["cycle"] = int(_state["cycle"]) + 1
	if _state["cycle"] > 1:
		for player_id in _state["seating"]:
			var income := _income_of(player_id)
			if income > 0:
				_state["players"][player_id]["gold"] = int(_state["players"][player_id]["gold"]) + income
				_log({"type": "INCOME", "player": player_id, "gold": income})
	var revealed := _shuffled(GODS).slice(0, GODS_REVEALED[_state["seating"].size()])
	_state["gods"] = revealed.map(func(god): return {"god": god, "holder": "", "amount": 0})
	_state["apollo"] = []
	_state["bidding"] = {"queue": order.duplicate(), "displaced": "", "forbidden": ""}
	_state["turns"] = []
	_state["turn_index"] = 0
	_state["phase"] = "BIDDING"
	_log({"type": "CYCLE", "cycle": _state["cycle"], "gods": revealed})


## Znacznik ofiary położony: przebity gracz ma pierwszeństwo, a pełny tor zamyka licytację.
func _finish_bid(was_displaced: bool, outbid: String, god_id: String) -> void:
	var bidding: Dictionary = _state["bidding"]
	if was_displaced:
		bidding["displaced"] = ""
		bidding["forbidden"] = ""
	else:
		bidding["queue"].pop_front()
	if outbid != "":
		# Przebity gracz musi od razu wybrać innego boga albo Apolla.
		bidding["displaced"] = outbid
		bidding["forbidden"] = god_id
	if bidding["displaced"] == "" and bidding["queue"].is_empty():
		_settle_bidding()


## Zamknięcie licytacji: opłaty z kapłanami, 1 JZ dla graczy Apolla i kolejność tur.
func _settle_bidding() -> void:
	var turns: Array = []
	for slot in _state["gods"]:
		if slot["holder"] == "":
			continue
		var player: Dictionary = _state["players"][slot["holder"]]
		player["gold"] = int(player["gold"]) - offering_cost(int(slot["amount"]), int(player["priests"]))
		turns.append({"god": slot["god"], "player": slot["holder"]})
	for player_id in _state["apollo"]:
		_state["players"][player_id]["gold"] = int(_state["players"][player_id]["gold"]) + 1
		turns.append({"god": APOLLO, "player": player_id})
	_state["turns"] = turns
	_state["turn_index"] = 0
	_state["phase"] = "ACTIONS"
	_log({"type": "BIDDING_CLOSED", "turns": turns.duplicate(true)})
	_on_turn_started()


## Tor stworów na początku cyklu (jak refreshCreatureMarket w TS): karta z pola za 2 JZ idzie na
## stos, pozostałe zsuwają się w stronę tańszych pól, a wolne pola od strony 4 JZ uzupełnia talia.
func _refresh_creatures() -> void:
	var creatures: Dictionary = _state["creatures"]
	var slots: Array = creatures["slots"]
	if slots[0] != "":
		creatures["discard"].append(slots[0])
	var remaining: Array = slots.slice(1).filter(func(key: String) -> bool: return key != "")
	while remaining.size() < slots.size():
		remaining.append(_draw_creature())
	creatures["slots"] = remaining


## Wierzch talii stworów. Pusta talia: stos odrzuconych zostaje przetasowany i staje się talią.
## Gdy nie ma żadnych kart, pole zostaje puste.
func _draw_creature() -> String:
	var creatures: Dictionary = _state["creatures"]
	if creatures["deck"].is_empty() and not creatures["discard"].is_empty():
		creatures["deck"] = _shuffled(creatures["discard"])
		creatures["discard"] = []
	return String(creatures["deck"].pop_front()) if not creatures["deck"].is_empty() else ""


## Moc kupionego stwora na cel sprawdzony wcześniej przez CreatureRules.effect_error.
func _apply_creature(key: String, player_id: String, params: Dictionary) -> void:
	match key:
		"GIANT":
			var island: Dictionary = _state["islands"][params["island"]]
			island["buildings"].erase(params["building"])
			_log({"type": "GIANT", "player": player_id, "island": params["island"], "building": params["building"]})
		"HARPY":
			var island: Dictionary = _state["islands"][params["island"]]
			island["troops"] = int(island["troops"]) - 1
			_log({"type": "HARPY", "player": player_id, "island": params["island"]})
		"PEGASUS":
			_execute_move(true, player_id, params["from"], params["to"], int(params["count"]), "PEGASUS")
		"KRAKEN":
			var route: Array = [params["sea"]]
			route.append_array(params.get("path", []))
			var destroyed: Array = []
			for sea_id in route:
				var sea: Dictionary = _state["seas"][sea_id]
				var lost := int(sea["fleets"]) + int(sea.get("undead_fleets", 0))
				if lost > 0:
					destroyed.append({"sea": sea_id, "player": sea["owner"], "fleets": lost})
				_state["seas"][sea_id] = _sea("", 0)
			_state["kraken"] = route.back()
			_log({"type": "KRAKEN", "player": player_id, "sea": route.back(), "destroyed": destroyed})
		"MINOTAUR":
			_state["minotaur"] = {"island": params["island"], "player": player_id}
			_log({"type": "MINOTAUR", "player": player_id, "island": params["island"]})


## Ruch po walidacji: jednostki schodzą z pola startowego, a wejście na pole z jednostkami rywala
## (także z samym Minotaurem) to bitwa. Ruch Aresa i Posejdona oraz przerzut Pegaza (`via`).
func _execute_move(land: bool, player_id: String, from_id: String, to_id: String, count: int, via: String = "") -> void:
	var nodes: Dictionary = _state["islands"] if land else _state["seas"]
	var unit_key := "troops" if land else "fleets"
	var origin: Dictionary = nodes[from_id]
	var target: Dictionary = nodes[to_id]
	var holder := String(target["owner"])
	var hostile := holder != "" and holder != player_id
	origin[unit_key] = int(origin[unit_key]) - count
	if not land and MoveRules.units_on(_state, from_id) == 0:
		origin["owner"] = ""  # puste morze nie ma właściciela; wyspa bez wojsk zostaje przy graczu
	var event := {"type": "MOVE", "player": player_id, "from": from_id, "to": to_id, "count": count}
	if via != "":
		event["via"] = via
	_log(event)
	if hostile and MoveRules.units_on(_state, to_id) > 0:
		_resolve_battle("LAND" if land else "SEA", to_id, player_id, count)
	elif target["owner"] == player_id:
		target[unit_key] = int(target[unit_key]) + count
	else:
		target["owner"] = player_id
		target[unit_key] = count


## Początek tury boga. Minotaur działa „do początku następnej tury” kupującego, więc wtedy znika.
func _on_turn_started() -> void:
	var minotaur: Dictionary = _state.get("minotaur", {})
	if not minotaur.is_empty() and minotaur["player"] == current_actor():
		_state["minotaur"] = {}
		_log({"type": "MINOTAUR_GONE", "player": minotaur["player"], "island": minotaur["island"]})


## Bitwa do rozstrzygnięcia (bez odwrotów): runda po rundzie, aż jedna strona zniknie.
## Wynik rundy: rzut + jednostki + modyfikatory. Niższy wynik traci jednostkę, remis: obie strony.
## Nieumarli obrońcy (Hades) walczą razem z jednostkami gracza i giną jako pierwsi. Minotaur
## liczy się jak MoveRules.MINOTAUR_STRENGTH oddziały obrońcy i ginie dopiero po oddziałach.
func _resolve_battle(kind: String, node_id: String, attacker: String, attacking: int) -> void:
	var node: Dictionary = _state["islands"][node_id] if kind == "LAND" else _state["seas"][node_id]
	var unit_key := "troops" if kind == "LAND" else "fleets"
	var undead_key := "undead_troops" if kind == "LAND" else "undead_fleets"
	var defender := String(node["owner"])
	var defending := int(node[unit_key])
	var undead := int(node.get(undead_key, 0))
	var guarded: bool = kind == "LAND" and _state.get("minotaur", {}).get("island", "") == node_id
	var minotaur := MoveRules.MINOTAUR_STRENGTH if guarded else 0
	var modifiers := _defense_modifiers(kind, node_id, defender)
	var bonus := 0
	for modifier in modifiers:
		bonus += int(modifier["value"])
	var rounds: Array = []
	while attacking > 0 and defending + undead + minotaur > 0:
		var a := {"roll": roll_die(), "units": attacking, "modifiers": []}
		var d := {"roll": roll_die(), "units": defending + undead + minotaur, "undead": undead, "modifiers": modifiers.duplicate(true)}
		if minotaur > 0:
			d["minotaur"] = minotaur
		a["total"] = int(a["roll"]) + attacking
		d["total"] = int(d["roll"]) + defending + undead + minotaur + bonus
		a["loss"] = a["total"] <= d["total"]
		d["loss"] = d["total"] <= a["total"]
		if a["loss"]:
			attacking -= 1
		if d["loss"]:
			if undead > 0:
				undead -= 1
			elif defending > 0:
				defending -= 1
			else:
				minotaur = 0
		rounds.append({"round": rounds.size() + 1, "attacker": a, "defender": d})

	var outcome := "MUTUAL_DESTRUCTION"
	if attacking > 0:
		outcome = "ATTACKER_WON"
		node["owner"] = attacker
		node[unit_key] = attacking
		node[undead_key] = 0
	elif defending + undead + minotaur > 0:
		outcome = "DEFENDER_WON"
		node[unit_key] = defending
		node[undead_key] = undead
	else:
		node[unit_key] = 0
		node[undead_key] = 0
		if kind == "SEA":
			node["owner"] = ""  # wyspa bez wojsk zostaje przy obrońcy, puste morze nie
	if guarded and minotaur == 0:
		_state["minotaur"] = {}  # pokonany Minotaur znika z planszy
	var report := {
		"kind": kind,
		"location": node_id,
		"attacker": attacker,
		"defender": defender,
		"rounds": rounds,
		"outcome": outcome,
		"revision": int(_state["revision"]) + 1,  # rewizja stanu po tej bitwie
	}
	_log({"type": "BATTLE", "location": node_id, "attacker": attacker, "defender": defender, "outcome": outcome})
	battle_resolved.emit(report)


## Premie obrońcy: Fortece na bronionej wyspie albo Porty jego wysp przy polu bitwy morskiej.
## Metropolia działa jak Forteca i jak Port, więc daje osobną pozycję w raporcie.
func _defense_modifiers(kind: String, node_id: String, defender: String) -> Array:
	var result: Array = []
	if kind == "LAND":
		var fortresses := _count_buildings(node_id, "FORTRESS")
		if fortresses > 0:
			result.append({"source": "FORTRESS", "island": node_id, "value": fortresses})
		if _state["islands"][node_id].get("metropolis", false):
			result.append({"source": "METROPOLIS", "island": node_id, "value": 1})
		return result
	for island_id in ArchipelagoMap.islands_at(node_id):
		if _state["islands"][island_id]["owner"] != defender:
			continue
		var ports := _count_buildings(island_id, "PORT")
		if ports > 0:
			result.append({"source": "PORT", "island": island_id, "value": ports})
		if _state["islands"][island_id].get("metropolis", false):
			result.append({"source": "METROPOLIS", "island": island_id, "value": 1})
	return result


## Tura boga gracza albo powód odmowy.
func _god_turn_error(player_id: String) -> Dictionary:
	if _state.get("phase", "") != "ACTIONS":
		return _fail("NOT_ACTIONS", "Teraz nie trwają tury bogów.")
	var actor := current_actor()
	if actor != player_id:
		return _fail("NOT_YOUR_TURN", "Teraz tura gracza %s." % _name(actor))
	return {}


## Nowa wyspa w stanie: nieumarli (Hades) i monument (Monumenty) są częścią schematu od początku.
## Metropolia ma na wyspie osobne miejsce (jak `metropolisSlot` w TS) i nie zajmuje slotu budynku.
static func _island(owner_id: String, troops: int) -> Dictionary:
	return {"owner": owner_id, "troops": troops, "undead_troops": 0, "buildings": [], "monument": "", "metropolis": false}


static func _sea(owner_id: String, fleets: int) -> Dictionary:
	return {"owner": owner_id, "fleets": fleets, "undead_fleets": 0}


func _god_slot(god_id: String) -> Dictionary:
	return BidRules.god_slot(_state, god_id)


## Komunikat odmowy ofiary (kody z BidRules.bid_error).
func _bid_error_message(code: String, player_id: String, god_id: String, amount: int) -> String:
	match code:
		"NOT_BIDDING":
			return "Teraz nie trwa licytacja."
		"NOT_YOUR_TURN":
			return "Teraz licytuje %s." % _name(current_actor())
		"UNKNOWN_GOD":
			return "Boga %s nie ma w tym cyklu na torze." % god_id
		"FORBIDDEN_GOD":
			return "Po przebiciu nie można od razu wrócić do boga %s." % god_id
		"OWN_OFFERING":
			return "Ta ofiara już należy do ciebie."
		"INVALID_AMOUNT":
			return "Ofiara musi wynosić od 1 do %d JZ." % MAX_BID
		"BID_TOO_LOW":
			return "Na %s trzeba dać co najmniej %d JZ." % [god_id, BidRules.min_bid(_state, god_id)]
		"CANNOT_AFFORD":
			var player: Dictionary = _state["players"][player_id]
			return "Ofiara kosztuje %d JZ, a masz %d JZ." % [offering_cost(amount, int(player["priests"])), int(player["gold"])]
	return code


## Komunikat odmowy rekrutacji (kody z RecruitRules.recruit_error).
func _recruit_error_message(code: String, player_id: String, kind: String, target_id: String) -> String:
	match code:
		"NOT_ACTIONS":
			return "Teraz nie trwają tury bogów."
		"NOT_YOUR_TURN":
			return "Teraz tura gracza %s." % _name(current_actor())
		"WRONG_GOD":
			return "Bóg %s nie daje tej jednostki (%s)." % [god_of(_state), kind]
		"NOT_SUPPORTED":
			return "Tej rekrutacji serwer jeszcze nie obsługuje (%s)." % kind
		"RECRUIT_LIMIT":
			return "W tej turze nie pozyskasz już więcej (%s)." % kind
		"WRONG_TERRITORY":
			return "Oddział stawia się na wyspie, a flotę na polu morskim."
		"NOT_OWNER":
			return "Wyspa %s nie należy do ciebie." % target_id
		"NOT_ADJACENT":
			return "Flota musi stanąć przy jednej z twoich wysp."
		"SEA_OCCUPIED":
			return "Na polu %s stoją obce jednostki." % target_id
		"NO_UNITS_LEFT":
			return "Masz już na planszy wszystkie figurki tego rodzaju (%d)." % (RecruitRules.MAX_TROOPS if kind == "TROOP" else RecruitRules.MAX_FLEETS)
		"CANNOT_AFFORD":
			return "Ta rekrutacja kosztuje %d JZ, a masz %d JZ." % [RecruitRules.next_cost(_state, kind), int(_state["players"][player_id]["gold"])]
	return code


## Liczniki zakupów bieżącej tury boga. Nowa tura (inny RecruitRules.turn_key) zaczyna od zera.
func _turn_progress() -> Dictionary:
	var key := RecruitRules.turn_key(_state)
	var progress: Dictionary = _state.get("turn_progress", {})
	if progress.get("turn", "") != key:
		progress = {"turn": key, "recruited": {}, "discount_used": false}
		_state["turn_progress"] = progress
	return progress


## Komunikat odmowy zakupu stwora albo wymiany karty (kody z CreatureRules). `cost`: cena, której zabrakło.
func _creature_error_message(code: String, player_id: String, cost: int) -> String:
	match code:
		"NOT_ACTIONS":
			return "Teraz nie trwają tury bogów."
		"NOT_YOUR_TURN":
			return "Teraz tura gracza %s." % _name(current_actor())
		"WRONG_GOD":
			return "Karty stworów wymienia tylko tura Zeusa."
		"INVALID_SLOT":
			return "Tor stworów ma pola 0, 1 i 2."
		"NO_CARD":
			return "Na tym polu toru nie ma karty."
		"NOT_SUPPORTED":
			return "Mocy tego stwora serwer jeszcze nie obsługuje."
		"INVALID_PARAMS":
			return "Brakuje celu mocy stwora albo cel ma zły format."
		"WRONG_TERRITORY":
			return "Cel mocy stwora to nieznane albo złe pole."
		"NO_BUILDING":
			return "Na tej wyspie nie ma takiego budynku."
		"NO_UNITS":
			return "Na tej wyspie nie ma oddziałów."
		"NOT_OWNER":
			return "To nie jest twoja wyspa."
		"INVALID_MOVE":
			return "Pegaz przenosi oddziały na inną wyspę."
		"NOT_ENOUGH_UNITS":
			return "Na wyspie nie ma tylu oddziałów."
		"LAST_ISLAND_PROTECTED":
			return "Nie można zająć ostatniej wyspy rywala."
		"INVALID_PATH":
			return "Kraken płynie przez sąsiednie pola morskie."
		"CANNOT_AFFORD":
			return "To kosztuje %d JZ, a masz %d JZ." % [cost, int(_state["players"][player_id]["gold"])]
	return code


func _income_of(player_id: String) -> int:
	var income := 0
	for island_id in _state["islands"]:
		if _state["islands"][island_id]["owner"] == player_id:
			income += int(MAP["islands"][island_id]["prosperity"])
	return income


func _count_buildings(island_id: String, building: String) -> int:
	return _state["islands"][island_id]["buildings"].count(building)


func _name(player_id: String) -> String:
	return String(_state.get("players", {}).get(player_id, {}).get("name", player_id))


## Zdarzenie w dzienniku partii (UI pokazuje z niego np. przebicia i bitwy).
## Numer `seq` rośnie bez przerw, więc klient wie, które zdarzenia już widział.
func _log(event: Dictionary) -> void:
	_state["log_seq"] = int(_state["log_seq"]) + 1
	event["seq"] = _state["log_seq"]
	event["cycle"] = _state.get("cycle", 0)
	var entries: Array = _state["log"]
	entries.append(event)
	if entries.size() > LOG_SIZE:
		entries.pop_front()


## Zatwierdzenie zmiany: efekty stanowe (Metropolie), nowa rewizja, rozesłanie projekcji i ewentualny ruch AI.
func _commit() -> void:
	_apply_state_effects()
	_state["revision"] = int(_state["revision"]) + 1
	state_committed.emit()
	_schedule_ai()


# =============================================================================
# Metropolie i koniec gry (tylko serwer)
# =============================================================================

## Efekty stanowe po każdej zmianie w trakcie partii: komplet czterech różnych budynków
## albo czterech filozofów od razu zamienia się w Metropolię (zdobycie wyspy też może
## domknąć komplet). Metropolia działa jak każdy budynek, ale nie tworzy kolejnego kompletu.
func _apply_state_effects() -> void:
	if not is_game_running():
		return
	for player_id in _state["seating"]:
		while _has_building_set(player_id):
			_found_metropolis(player_id, "BUILDINGS")
		while int(_state["players"][player_id].get("philosophers", 0)) >= PHILOSOPHERS_PER_METROPOLIS:
			_found_metropolis(player_id, "PHILOSOPHERS")


func _has_building_set(player_id: String) -> bool:
	var owned: Array = []
	for island_id in _state["islands"]:
		if _state["islands"][island_id]["owner"] == player_id:
			owned.append_array(_state["islands"][island_id]["buildings"])
	return METROPOLIS_BUILDINGS.all(func(building: String) -> bool: return building in owned)


## Nowa Metropolia: znikają cztery różne budynki (najpierw z wyspy Metropolii) albo czterej
## filozofowie. Gdy każda wyspa gracza ma już Metropolię, nowa „zastępuje” starą: składniki
## przepadają, a liczba Metropolii się nie zmienia (tak instrukcja opisuje filozofów).
func _found_metropolis(player_id: String, origin: String) -> void:
	var site := _metropolis_site(player_id)
	if origin == "PHILOSOPHERS":
		var player: Dictionary = _state["players"][player_id]
		player["philosophers"] = int(player["philosophers"]) - PHILOSOPHERS_PER_METROPOLIS
	else:
		for building in METROPOLIS_BUILDINGS:
			_remove_building(player_id, building, site)
	if site != "":
		_state["islands"][site]["metropolis"] = true
	_log({"type": "METROPOLIS", "player": player_id, "island": site, "origin": origin})


## Miejsce na Metropolię: wyspa gracza bez Metropolii z największą liczbą różnych budynków
## z kompletu, a przy remisie pierwsza w kolejności mapy. [zweryfikuj] W grze wybiera gracz.
func _metropolis_site(player_id: String) -> String:
	var best := ""
	var best_score := -1
	for island_id in MAP["islands"]:
		var island: Dictionary = _state["islands"][island_id]
		if island["owner"] != player_id or island.get("metropolis", false):
			continue
		var score := METROPOLIS_BUILDINGS.filter(func(building: String) -> bool: return building in island["buildings"]).size()
		if score > best_score:
			best = island_id
			best_score = score
	return best


## Usuwa jeden budynek gracza danego typu: z wyspy `preferred`, a gdy go tam nie ma, z pierwszej wyspy w kolejności mapy.
func _remove_building(player_id: String, building: String, preferred: String) -> void:
	var candidates: Array = [preferred] if preferred != "" else []
	candidates.append_array(MAP["islands"].keys())
	for island_id in candidates:
		var island: Dictionary = _state["islands"][island_id]
		if island["owner"] == player_id and building in island["buildings"]:
			island["buildings"].erase(building)
			return


## Zwycięzcy na koniec cyklu: gracze z METROPOLISES_TO_WIN Metropoliami, a spośród nich ci
## z największą ilością złota (przy remisie kilku). Pusta lista oznacza, że gra toczy się dalej.
func _winners() -> Array:
	var contenders: Array = _state["seating"].filter(func(player_id: String) -> bool: return MoveRules.metropolises_of(_state, player_id) >= METROPOLISES_TO_WIN)
	if contenders.is_empty():
		return []
	var richest: int = contenders.map(func(player_id: String) -> int: return int(_state["players"][player_id]["gold"])).max()
	return contenders.filter(func(player_id: String) -> bool: return int(_state["players"][player_id]["gold"]) == richest)


# =============================================================================
# Losowość (tylko serwer)
# =============================================================================

## Rzut kością bitewną. Źródłem jest kryptograficzny generator systemu (Crypto),
## więc wyniku nie da się przewidzieć po stronie klienta.
func roll_die() -> int:
	return BATTLE_DIE[_random_below(BATTLE_DIE.size())]


## Liczba z przedziału [0, n) bez przechyłu modulo: odrzucamy końcówkę zakresu 2^32.
func _random_below(n: int) -> int:
	var limit := 4294967296 - (4294967296 % n)
	while true:
		var value := _crypto.generate_random_bytes(4).decode_u32(0)
		if value < limit:
			return value % n
	return 0


## Tasowanie Fishera-Yatesa tym samym generatorem. Nie zmienia wejścia.
func _shuffled(items: Array) -> Array:
	var result := items.duplicate()
	for i in range(result.size() - 1, 0, -1):
		var j := _random_below(i + 1)
		var tmp = result[i]
		result[i] = result[j]
		result[j] = tmp
	return result


# =============================================================================
# AI (tylko serwer)
# =============================================================================

## Jeśli gra czeka na gracza AI, jego ruch zostaje zaplanowany po `ai_think_sec`.
func _schedule_ai() -> void:
	var actor := current_actor()
	if actor == "" or not _state["players"][actor]["is_ai"]:
		return
	get_tree().create_timer(ai_think_sec).timeout.connect(_ai_act.bind(actor, int(_state["revision"])))


## Ruch AI, o ile od zaplanowania nic się nie zmieniło (np. gracz nie wrócił w międzyczasie).
func _ai_act(actor: String, revision: int) -> void:
	if int(_state.get("revision", -1)) != revision or current_actor() != actor:
		return
	if _state["phase"] == "BIDDING":
		var choice := _ai_bid(actor)
		apply_bid(actor, choice[0], choice[1])
	else:
		apply_end_turn(actor)


## Prosta AI: pierwszy wolny bóg za 1 JZ (jeśli ją stać), a w przeciwnym razie Apollo.
func _ai_bid(actor: String) -> Array:
	var player: Dictionary = _state["players"][actor]
	var bidding: Dictionary = _state["bidding"]
	var forbidden := String(bidding["forbidden"]) if bidding["displaced"] == actor else ""
	for slot in _state["gods"]:
		if slot["holder"] == "" and slot["god"] != forbidden and offering_cost(1, int(player["priests"])) <= int(player["gold"]):
			return [slot["god"], 1]
	return [APOLLO, 0]


static func _ok() -> Dictionary:
	return {"ok": true, "code": "", "message": ""}


static func _fail(code: String, message: String) -> Dictionary:
	return {"ok": false, "code": code, "message": message}
