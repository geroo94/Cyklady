## CreatureRules: reguły toru Mitologicznych Stworów wspólne dla serwera i interfejsu.
##
## Te same funkcje sprawdzają zakup i akcję Zeusa na serwerze
## (GameStateManager.apply_buy_creature, apply_swap_creature) i mogą pokazać
## graczowi cenę oraz powód odmowy przed wysłaniem RPC. Działają na pełnym stanie
## albo na projekcji gracza: potrzebują toru, planszy, tury i złota tego gracza.
##
## Zasady (instrukcja podstawki):
##  - tor ma trzy karty: pole 0 za 2 JZ (najstarsza), 1 za 3 JZ, 2 za 4 JZ (najnowsza);
##  - stwora kupuje się w turze dowolnego boga (także Apolla), a jego moc działa od razu;
##  - każda Świątynia gracza obniża cenę o 1 JZ (Metropolia liczy się jak Świątynia),
##    ale zapłacić trzeba co najmniej 1 JZ. Zniżka działa raz na cykl, czyli przy jednym
##    zakupie w turze (gracz ma jeden znacznik ofiary, więc jedną turę w cyklu);
##  - Zeus: za 1 JZ karta z toru idzie na stos, a jej miejsce zajmuje wierzch talii.
##
## Cele efektów (`params` zakupu):
##   GIANT     { "island", "building" }  niszczy budynek (Metropolia nie jest budynkiem)
##   HARPY     { "island" }              zabiera z wyspy jeden oddział
##   PEGASUS   { "from", "to", "count" } przenosi oddziały z własnej wyspy na dowolną, bez floty (count: int)
##   KRAKEN    { "sea", "path"? }        niszczy floty na polu i na trasie (+1 JZ za pole)
##   MINOTAUR  { "island" }              broni własnej wyspy jak 2 oddziały
class_name CreatureRules
extends RefCounted

## Ceny pól toru (indeks = pole).
const SLOT_PRICES := [2, 3, 4]
## Koszt wymiany karty przez Zeusa.
const SWAP_COST := 1
## Stwory, których moc serwer umie wykonać.
const SUPPORTED := ["GIANT", "HARPY", "PEGASUS", "KRAKEN", "MINOTAUR"]


## Cena karty z pola `slot` dla gracza: pole minus Świątynie (jeśli zniżka jeszcze przysługuje),
## co najmniej 1 JZ. -1 dla nieistniejącego pola.
static func price(state: Dictionary, player_id: String, slot: int) -> int:
	if slot < 0 or slot >= SLOT_PRICES.size():
		return -1
	var discount := temples_of(state, player_id) if discount_available(state, player_id) else 0
	return maxi(1, int(SLOT_PRICES[slot]) - discount)


## Cały koszt zakupu: cena karty plus ruch Krakena (1 JZ za każde pole trasy).
static func total_cost(state: Dictionary, player_id: String, slot: int, params: Dictionary) -> int:
	var cost := price(state, player_id, slot)
	var key := card_at(state, slot)
	if key == "KRAKEN" and params.get("path", []) is Array:
		cost += params.get("path", []).size()
	return cost


## Powód odmowy zakupu albo pusty napis.
static func buy_error(state: Dictionary, player_id: String, slot: int, params: Dictionary) -> String:
	var turn := _turn_error(state, player_id)
	if turn != "":
		return turn
	if slot < 0 or slot >= SLOT_PRICES.size():
		return "INVALID_SLOT"
	var key := card_at(state, slot)
	if key == "":
		return "NO_CARD"
	if key not in SUPPORTED:
		return "NOT_SUPPORTED"
	var target := effect_error(state, player_id, key, params)
	if target != "":
		return target
	if MoveRules.gold_of(state, player_id) < total_cost(state, player_id, slot, params):
		return "CANNOT_AFFORD"
	return ""


## Powód odmowy wymiany karty przez Zeusa albo pusty napis.
static func swap_error(state: Dictionary, player_id: String, slot: int) -> String:
	var turn := _turn_error(state, player_id)
	if turn != "":
		return turn
	if state["turns"][state["turn_index"]]["god"] != "ZEUS":
		return "WRONG_GOD"
	if slot < 0 or slot >= SLOT_PRICES.size():
		return "INVALID_SLOT"
	if card_at(state, slot) == "":
		return "NO_CARD"
	if MoveRules.gold_of(state, player_id) < SWAP_COST:
		return "CANNOT_AFFORD"
	return ""


## Powód, dla którego moc stwora `key` nie może działać na podany cel, albo pusty napis.
static func effect_error(state: Dictionary, player_id: String, key: String, params: Dictionary) -> String:
	match key:
		"GIANT":
			var island := _text(params, "island")
			var building := _text(params, "building")
			if island == "" or building == "":
				return "INVALID_PARAMS"
			if not state["islands"].has(island):
				return "WRONG_TERRITORY"
			if building not in state["islands"][island]["buildings"]:
				return "NO_BUILDING"
		"HARPY":
			var island := _text(params, "island")
			if island == "":
				return "INVALID_PARAMS"
			if not state["islands"].has(island):
				return "WRONG_TERRITORY"
			if int(state["islands"][island]["troops"]) < 1:
				return "NO_UNITS"
		"PEGASUS":
			var from := _text(params, "from")
			var to := _text(params, "to")
			if from == "" or to == "" or typeof(params.get("count")) != TYPE_INT:
				return "INVALID_PARAMS"
			if not state["islands"].has(from) or not state["islands"].has(to):
				return "WRONG_TERRITORY"
			if state["islands"][from]["owner"] != player_id:
				return "NOT_OWNER"
			if from == to:
				return "INVALID_MOVE"
			var count := int(params["count"])
			if count < 1 or count > MoveRules.movable_units(state, from):
				return "NOT_ENOUGH_UNITS"
			if MoveRules.last_island_protected(state, player_id, to):
				return "LAST_ISLAND_PROTECTED"
		"KRAKEN":
			var sea := _text(params, "sea")
			var path: Variant = params.get("path", [])
			if sea == "" or not path is Array:
				return "INVALID_PARAMS"
			if not state["seas"].has(sea):
				return "WRONG_TERRITORY"
			var previous := sea
			for step: Variant in path:
				if typeof(step) != TYPE_STRING or not state["seas"].has(step) or step not in ArchipelagoMap.MAP["seas"][previous]:
					return "INVALID_PATH"
				previous = step
		"MINOTAUR":
			var island := _text(params, "island")
			if island == "":
				return "INVALID_PARAMS"
			if not state["islands"].has(island):
				return "WRONG_TERRITORY"
			if state["islands"][island]["owner"] != player_id:
				return "NOT_OWNER"
	return ""


## Świątynie gracza na jego wyspach. Metropolia liczy się jak Świątynia.
static func temples_of(state: Dictionary, player_id: String) -> int:
	var count := 0
	for island_id in state["islands"]:
		var island: Dictionary = state["islands"][island_id]
		if island["owner"] == player_id:
			count += island["buildings"].count("TEMPLE") + (1 if island.get("metropolis", false) else 0)
	return count


## Czy zniżka ze Świątyń jeszcze przysługuje graczowi: w jego bieżącej turze nie kupił
## jeszcze stwora ze zniżką. Gracz, którego tura dopiero nadejdzie, ma ją w całości.
static func discount_available(state: Dictionary, player_id: String) -> bool:
	if RecruitRules.turn_key(state) == "" or state["turns"][state["turn_index"]]["player"] != player_id:
		return true
	var progress: Dictionary = state.get("turn_progress", {})
	return progress.get("turn", "") != RecruitRules.turn_key(state) or not progress.get("discount_used", false)


## Klucz karty na polu toru (pusty napis: pole puste albo nie istnieje).
static func card_at(state: Dictionary, slot: int) -> String:
	var slots: Array = state.get("creatures", {}).get("slots", [])
	return String(slots[slot]) if slot >= 0 and slot < slots.size() else ""


static func _turn_error(state: Dictionary, player_id: String) -> String:
	if state.get("phase", "") != "ACTIONS":
		return "NOT_ACTIONS"
	if state["turns"][state["turn_index"]]["player"] != player_id:
		return "NOT_YOUR_TURN"
	return ""


## Tekstowy parametr celu albo pusty napis, gdy go brak lub ma zły typ (dane z sieci).
static func _text(params: Dictionary, key: String) -> String:
	var value: Variant = params.get(key, "")
	return value if value is String else ""
