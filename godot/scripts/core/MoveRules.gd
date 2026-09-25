## MoveRules: reguły ruchu wspólne dla serwera i planszy.
##
## Te same funkcje sprawdzają ruch na serwerze (GameStateManager.apply_move)
## i wyznaczają podświetlenie prawidłowych ruchów u klienta (Board). Działają
## na pełnym stanie albo na projekcji gracza, bo potrzebują wyłącznie
## informacji jawnych (plansza, tura, bóg) i złota tego gracza. Dzięki temu
## podświetlone pole to dokładnie to, które serwer przyjmie. Test
## „reguły planszy = walidacja serwera” sprawdza to na losowych stanach.
##
## Zasady:
##  - Ares: wojska przechodzą z wyspy na wyspę po łańcuchu pól morskich
##    z własnymi flotami. Floty nieumarłych (Hades) też należą do łańcucha.
##  - Nieumarli (Hades) należą do właściciela pola: tworzą most z flot, bronią
##    pola (giną pierwsi) i sprawiają, że wejście na pole oznacza bitwę. Rozkaz
##    ruchu przenosi tylko zwykłe oddziały i floty, nieumarli zostają na polu.
##  - Posejdon: flota płynie najwyżej FLEET_RANGE pól. Przez pole z obcą
##    flotą nie przepłynie, ale może na nie wpłynąć (bitwa).
##  - Nie można zająć ostatniej wyspy innego gracza.
##  - Ruch kosztuje MOVE_COST JZ.
class_name MoveRules
extends RefCounted

const MOVE_TROOPS := "MOVE_TROOPS"
const MOVE_FLEET := "MOVE_FLEET"
const BUILD := "BUILD"
## Bóg, którego tura pozwala na dany ruch.
const ACTION_GOD := {MOVE_TROOPS: "ARES", MOVE_FLEET: "POSEIDON"}
## Budynek stawiany w turze danego boga.
const GOD_BUILDING := {"POSEIDON": "PORT", "ARES": "FORTRESS", "ZEUS": "TEMPLE", "ATHENA": "UNIVERSITY"}
const MOVE_COST := 1
const BUILD_COST := 2
const FLEET_RANGE := 3

## Rodzaj celu: zwykły ruch (wolne, własne albo puste obce pole) albo atak (obce jednostki, czyli bitwa).
const TARGET_MOVE := "MOVE"
const TARGET_ATTACK := "ATTACK"


## Powód, dla którego gracz nie może teraz wykonać akcji tego typu, albo pusty napis.
static func action_error(state: Dictionary, player_id: String, action_type: String) -> String:
	if state.get("phase", "") != "ACTIONS":
		return "NOT_ACTIONS"
	var turn: Dictionary = state["turns"][state["turn_index"]]
	if turn["player"] != player_id:
		return "NOT_YOUR_TURN"
	var god := String(turn["god"])
	match action_type:
		MOVE_TROOPS, MOVE_FLEET:
			if god != ACTION_GOD[action_type]:
				return "WRONG_GOD"
			if gold_of(state, player_id) < MOVE_COST:
				return "CANNOT_AFFORD"
		BUILD:
			if not GOD_BUILDING.has(god):
				return "WRONG_GOD"
			if gold_of(state, player_id) < BUILD_COST:
				return "CANNOT_AFFORD"
		_:
			return "UNKNOWN_ACTION"
	return ""


## Powód, dla którego z pola `from_id` nie da się ruszyć (brak własnych jednostek właściwego rodzaju), albo pusty napis.
static func origin_error(state: Dictionary, player_id: String, from_id: String, action_type: String) -> String:
	var land := action_type == MOVE_TROOPS
	var nodes: Dictionary = state["islands"] if land else state["seas"]
	if not nodes.has(from_id):
		return "WRONG_TERRITORY"
	var origin: Dictionary = nodes[from_id]
	if origin["owner"] != player_id:
		return "NOT_OWNER"
	if movable_units(state, from_id) < 1:
		return "NO_UNITS"
	return ""


## Prawidłowe cele ruchu z pola `from_id`: { territory_id: TARGET_MOVE | TARGET_ATTACK }.
## Pusty słownik, gdy gracz nie może teraz ruszyć jednostek z tego pola.
static func move_targets(state: Dictionary, player_id: String, from_id: String, action_type: String) -> Dictionary:
	if action_type == BUILD or action_error(state, player_id, action_type) != "" or origin_error(state, player_id, from_id, action_type) != "":
		return {}
	var result := {}
	if action_type == MOVE_TROOPS:
		for island_id in bridged_islands(state, player_id, from_id):
			var holder := String(state["islands"][island_id]["owner"])
			var hostile := holder != "" and holder != player_id
			if hostile and islands_of(state, holder) == 1:
				continue  # ostatnia wyspa gracza jest chroniona
			result[island_id] = TARGET_ATTACK if hostile and units_on(state, island_id) > 0 else TARGET_MOVE
	else:
		for sea_id in fleet_reach(state, player_id, from_id):
			var holder := String(state["seas"][sea_id]["owner"])
			result[sea_id] = TARGET_ATTACK if holder != "" and holder != player_id and units_on(state, sea_id) > 0 else TARGET_MOVE
	return result


## Wyspy, na których gracz może teraz postawić budynek boga, którego tura trwa.
static func build_targets(state: Dictionary, player_id: String) -> Array:
	if action_error(state, player_id, BUILD) != "":
		return []
	var result: Array = []
	for island_id in state["islands"]:
		var island: Dictionary = state["islands"][island_id]
		if island["owner"] == player_id and island["buildings"].size() < int(ArchipelagoMap.MAP["islands"][island_id]["slots"]):
			result.append(island_id)
	return result


## Wyspy osiągalne z `from_island` po łańcuchu mórz z flotami gracza (bez wyspy startowej).
static func bridged_islands(state: Dictionary, player_id: String, from_island: String) -> Array:
	var queue: Array = []
	var seen := {}
	for sea_id in ArchipelagoMap.MAP["islands"][from_island]["seas"]:
		if state["seas"][sea_id]["owner"] == player_id:
			queue.append(sea_id)
			seen[sea_id] = true
	var result: Array = []
	while not queue.is_empty():
		var sea_id: String = queue.pop_front()
		for island_id in ArchipelagoMap.islands_at(sea_id):
			if island_id != from_island and not result.has(island_id):
				result.append(island_id)
		for next in ArchipelagoMap.MAP["seas"][sea_id]:
			if not seen.has(next) and state["seas"][next]["owner"] == player_id:
				seen[next] = true
				queue.append(next)
	return result


## Czy wyspy łączy łańcuch pól morskich z flotami gracza.
static func has_fleet_bridge(state: Dictionary, player_id: String, from_island: String, to_island: String) -> bool:
	return to_island in bridged_islands(state, player_id, from_island)


## Pola, na które flota z `from_sea` dopłynie w zasięgu, z najkrótszą odległością: { sea_id: pola }.
## Obca flota zatrzymuje ruch: można na nią wpłynąć (bitwa), ale nie da się przez nią przepłynąć.
static func fleet_reach(state: Dictionary, player_id: String, from_sea: String) -> Dictionary:
	var distance := {from_sea: 0}
	var queue: Array = [from_sea]
	while not queue.is_empty():
		var sea_id: String = queue.pop_front()
		if int(distance[sea_id]) >= FLEET_RANGE:
			continue
		for next in ArchipelagoMap.MAP["seas"][sea_id]:
			if distance.has(next):
				continue
			distance[next] = int(distance[sea_id]) + 1
			var holder := String(state["seas"][next]["owner"])
			if holder == "" or holder == player_id:
				queue.append(next)
	distance.erase(from_sea)
	return distance


## Odległość w polach albo -1, gdy flota nie dopłynie.
static func fleet_distance(state: Dictionary, player_id: String, from_sea: String, to_sea: String) -> int:
	return int(fleet_reach(state, player_id, from_sea).get(to_sea, -1))


## Jednostki na polu razem z nieumarłymi (Hades): oddziały na wyspie, floty na morzu.
static func units_on(state: Dictionary, territory_id: String) -> int:
	if state["islands"].has(territory_id):
		var island: Dictionary = state["islands"][territory_id]
		return int(island["troops"]) + int(island.get("undead_troops", 0))
	var sea: Dictionary = state["seas"][territory_id]
	return int(sea["fleets"]) + int(sea.get("undead_fleets", 0))


## Jednostki, które rozkaz ruchu może zabrać z pola: zwykłe oddziały albo floty (bez nieumarłych).
static func movable_units(state: Dictionary, territory_id: String) -> int:
	if state["islands"].has(territory_id):
		return int(state["islands"][territory_id]["troops"])
	if state["seas"].has(territory_id):
		return int(state["seas"][territory_id]["fleets"])
	return 0


static func islands_of(state: Dictionary, player_id: String) -> int:
	var count := 0
	for island_id in state["islands"]:
		if state["islands"][island_id]["owner"] == player_id:
			count += 1
	return count


static func gold_of(state: Dictionary, player_id: String) -> int:
	return int(state["players"][player_id]["gold"])
