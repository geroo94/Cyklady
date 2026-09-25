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
## Uproszczenia względem pełnych zasad: bez stworów, herosów, rekrutacji,
## kapłanów do kupienia, Metropolii i warunku zwycięstwa. Bitwa toczy się do
## rozstrzygnięcia, bez odwrotów.
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
## Tyle ostatnich zdarzeń trzyma dziennik partii w stanie (dla UI).
const LOG_SIZE := 30

## Mapa „Archipelag” (sąsiedztwo pól, miasta startowe). Wspólna dla reguł i planszy.
const MAP := ArchipelagoMap.MAP

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
			"is_ai": bool(entry.get("is_ai", false)),
			"connected": true,
			"reconnect_deadline": 0.0,
		}
		var city: Array = MAP["cities"][i]
		state["islands"][city[0]] = _island(id, STARTING_TROOPS)
		state["seas"][city[1]] = _sea(id, STARTING_FLEETS)
	_state = state
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
	var target: Dictionary = nodes[to_id]
	var holder := String(target["owner"])
	var hostile: bool = holder != "" and holder != player_id
	if land and hostile and MoveRules.islands_of(_state, holder) == 1:
		return _fail("LAST_ISLAND_PROTECTED", "Nie można zająć ostatniej wyspy gracza %s." % _name(holder))

	# Walidacja zakończona: zmiana stanu.
	player["gold"] = int(player["gold"]) - MOVE_COST
	origin[unit_key] = int(origin[unit_key]) - count
	if sea and MoveRules.units_on(_state, from_id) == 0:
		origin["owner"] = ""  # puste morze nie ma właściciela; wyspa bez wojsk zostaje przy graczu
	_log({"type": "MOVE", "player": player_id, "from": from_id, "to": to_id, "count": count})
	if hostile and MoveRules.units_on(_state, to_id) > 0:
		_resolve_battle("LAND" if land else "SEA", to_id, player_id, count)
	elif target["owner"] == player_id:
		target[unit_key] = int(target[unit_key]) + count
	else:
		target["owner"] = player_id
		target[unit_key] = count
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


## Koniec tury boga. Po ostatniej turze zaczyna się nowy cykl.
func apply_end_turn(player_id: String) -> Dictionary:
	var error := _god_turn_error(player_id)
	if not error.is_empty():
		return error
	_log({"type": "END_TURN", "player": player_id})
	_state["turn_index"] = int(_state["turn_index"]) + 1
	if _state["turn_index"] >= _state["turns"].size():
		# Kolejność licytacji w następnym cyklu to kolejność tur w tym cyklu.
		var order: Array = []
		for turn in _state["turns"]:
			order.append(turn["player"])
		_begin_cycle(order)
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


## Projekcja stanu dla gracza: złoto rywali jest tajne (-1), reszta planszy jest jawna.
func project_for(player_id: String) -> Dictionary:
	var projected := _state.duplicate(true)
	for id in projected["players"]:
		if id != player_id:
			projected["players"][id]["gold"] = -1
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

## Nowy cykl: dochód (od drugiego cyklu), odkrycie bogów i licytacja w podanej kolejności.
func _begin_cycle(order: Array) -> void:
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


## Bitwa do rozstrzygnięcia (bez odwrotów): runda po rundzie, aż jedna strona zniknie.
## Wynik rundy: rzut + jednostki + modyfikatory. Niższy wynik traci jednostkę, remis: obie strony.
## Nieumarli obrońcy (Hades) walczą razem z jednostkami gracza i giną jako pierwsi.
func _resolve_battle(kind: String, node_id: String, attacker: String, attacking: int) -> void:
	var node: Dictionary = _state["islands"][node_id] if kind == "LAND" else _state["seas"][node_id]
	var unit_key := "troops" if kind == "LAND" else "fleets"
	var undead_key := "undead_troops" if kind == "LAND" else "undead_fleets"
	var defender := String(node["owner"])
	var defending := int(node[unit_key])
	var undead := int(node.get(undead_key, 0))
	var modifiers := _defense_modifiers(kind, node_id, defender)
	var bonus := 0
	for modifier in modifiers:
		bonus += int(modifier["value"])
	var rounds: Array = []
	while attacking > 0 and defending + undead > 0:
		var a := {"roll": roll_die(), "units": attacking, "modifiers": []}
		var d := {"roll": roll_die(), "units": defending + undead, "undead": undead, "modifiers": modifiers.duplicate(true)}
		a["total"] = int(a["roll"]) + attacking
		d["total"] = int(d["roll"]) + defending + undead + bonus
		a["loss"] = a["total"] <= d["total"]
		d["loss"] = d["total"] <= a["total"]
		if a["loss"]:
			attacking -= 1
		if d["loss"]:
			if undead > 0:
				undead -= 1
			else:
				defending -= 1
		rounds.append({"round": rounds.size() + 1, "attacker": a, "defender": d})

	var outcome := "MUTUAL_DESTRUCTION"
	if attacking > 0:
		outcome = "ATTACKER_WON"
		node["owner"] = attacker
		node[unit_key] = attacking
		node[undead_key] = 0
	elif defending + undead > 0:
		outcome = "DEFENDER_WON"
		node[unit_key] = defending
		node[undead_key] = undead
	else:
		node[unit_key] = 0
		node[undead_key] = 0
		if kind == "SEA":
			node["owner"] = ""  # wyspa bez wojsk zostaje przy obrońcy, puste morze nie
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
func _defense_modifiers(kind: String, node_id: String, defender: String) -> Array:
	var result: Array = []
	if kind == "LAND":
		var fortresses := _count_buildings(node_id, "FORTRESS")
		if fortresses > 0:
			result.append({"source": "FORTRESS", "island": node_id, "value": fortresses})
		return result
	for island_id in ArchipelagoMap.islands_at(node_id):
		if _state["islands"][island_id]["owner"] != defender:
			continue
		var ports := _count_buildings(island_id, "PORT")
		if ports > 0:
			result.append({"source": "PORT", "island": island_id, "value": ports})
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
static func _island(owner_id: String, troops: int) -> Dictionary:
	return {"owner": owner_id, "troops": troops, "undead_troops": 0, "buildings": [], "monument": ""}


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


## Zatwierdzenie zmiany: nowa rewizja, rozesłanie projekcji i ewentualny ruch AI.
func _commit() -> void:
	_state["revision"] = int(_state["revision"]) + 1
	state_committed.emit()
	_schedule_ai()


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
