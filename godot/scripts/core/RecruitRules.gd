## RecruitRules: reguły rekrutacji wspólne dla serwera i interfejsu.
##
## Te same funkcje sprawdzają rekrutację na serwerze (GameStateManager.apply_recruit)
## i wyznaczają pola, na których UI może podświetlić miejsce dla nowej jednostki.
## Działają na pełnym stanie albo na projekcji gracza, bo potrzebują tylko planszy,
## tury i złota tego gracza.
##
## Zasady (instrukcja podstawki):
##  - bóg tury daje pierwszą sztukę za darmo, a kolejne kosztują według
##    GameData.GODS[bóg]["recruit_costs"]. Długość listy to limit sztuk jednego
##    rodzaju w turze (Ares i Posejdon: 1 + 3, Zeus i Atena: 1 + 1);
##  - oddział staje na własnej wyspie, a flota na polu morskim przy własnej wyspie,
##    na którym nie ma obcych jednostek ani Krakena;
##  - gracz ma na planszy najwyżej MAX_TROOPS oddziałów i MAX_FLEETS flot.
class_name RecruitRules
extends RefCounted

const Data := preload("res://scripts/autoload/GameData.gd")

const MAX_TROOPS := 8
const MAX_FLEETS := 8
## Rodzaje, które serwer Godot umie już wystawić (nieumarli Hadesa jeszcze nie).
const SUPPORTED := ["TROOP", "FLEET", "PRIEST", "PHILOSOPHER"]


## Powód odmowy rekrutacji albo pusty napis. `target_id`: wyspa dla oddziału,
## pole morskie dla floty, dla kapłana i filozofa bez znaczenia.
static func recruit_error(state: Dictionary, player_id: String, kind: String, target_id: String) -> String:
	if state.get("phase", "") != "ACTIONS":
		return "NOT_ACTIONS"
	var turn: Dictionary = state["turns"][state["turn_index"]]
	if turn["player"] != player_id:
		return "NOT_YOUR_TURN"
	if kind not in Data.god_def(String(turn["god"])).get("recruits", []):
		return "WRONG_GOD"
	if kind not in SUPPORTED:
		return "NOT_SUPPORTED"
	var cost := next_cost(state, kind)
	if cost < 0:
		return "RECRUIT_LIMIT"
	var target := _target_error(state, player_id, kind, target_id)
	if target != "":
		return target
	if kind == "TROOP" and units_of(state, player_id, kind) >= MAX_TROOPS:
		return "NO_UNITS_LEFT"
	if kind == "FLEET" and units_of(state, player_id, kind) >= MAX_FLEETS:
		return "NO_UNITS_LEFT"
	if int(state["players"][player_id]["gold"]) < cost:
		return "CANNOT_AFFORD"
	return ""


## Koszt następnej sztuki `kind` w bieżącej turze albo -1, gdy bóg jej nie daje lub limit jest wyczerpany.
static func next_cost(state: Dictionary, kind: String) -> int:
	if state.get("phase", "") != "ACTIONS":
		return -1
	var god := String(state["turns"][state["turn_index"]]["god"])
	var costs: Array = Data.god_def(god).get("recruit_costs", [])
	var bought := recruited(state, kind)
	return int(costs[bought]) if bought < costs.size() else -1


## Pola, na których gracz może teraz postawić nową jednostkę (dla kapłana i filozofa: brak pól).
static func recruit_targets(state: Dictionary, player_id: String, kind: String) -> Array:
	var candidates: Array = []
	if kind == "TROOP":
		candidates = state["islands"].keys()
	elif kind == "FLEET":
		candidates = state["seas"].keys()
	return candidates.filter(func(territory_id: String) -> bool: return recruit_error(state, player_id, kind, territory_id) == "")


## Oddziały albo floty gracza na planszy (bez nieumarłych).
static func units_of(state: Dictionary, player_id: String, kind: String) -> int:
	var nodes: Dictionary = state["islands"] if kind == "TROOP" else state["seas"]
	var unit_key := "troops" if kind == "TROOP" else "fleets"
	var count := 0
	for node_id in nodes:
		if nodes[node_id]["owner"] == player_id:
			count += int(nodes[node_id][unit_key])
	return count


## Ile sztuk `kind` gracz pozyskał już w bieżącej turze boga.
static func recruited(state: Dictionary, kind: String) -> int:
	var progress: Dictionary = state.get("turn_progress", {})
	if progress.get("turn", "") != turn_key(state):
		return 0
	return int(progress.get("recruited", {}).get(kind, 0))


## Identyfikator bieżącej tury boga. Liczniki zakupów z innej tury się nie liczą.
static func turn_key(state: Dictionary) -> String:
	if state.get("phase", "") != "ACTIONS":
		return ""
	var turn: Dictionary = state["turns"][state["turn_index"]]
	return "%d:%d:%s:%s" % [int(state["cycle"]), int(state["turn_index"]), turn["player"], turn["god"]]


static func _target_error(state: Dictionary, player_id: String, kind: String, target_id: String) -> String:
	match kind:
		"TROOP":
			if not state["islands"].has(target_id):
				return "WRONG_TERRITORY"
			if state["islands"][target_id]["owner"] != player_id:
				return "NOT_OWNER"
		"FLEET":
			if not state["seas"].has(target_id):
				return "WRONG_TERRITORY"
			if not ArchipelagoMap.islands_at(target_id).any(func(island_id: String) -> bool: return state["islands"][island_id]["owner"] == player_id):
				return "NOT_ADJACENT"
			var holder := String(state["seas"][target_id]["owner"])
			if holder != "" and holder != player_id and MoveRules.units_on(state, target_id) > 0:
				return "SEA_OCCUPIED"
			if String(state.get("kraken", "")) == target_id:
				return "KRAKEN_BLOCKS"
	return ""
