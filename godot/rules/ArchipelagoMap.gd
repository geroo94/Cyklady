## ArchipelagoMap: mapa „Archipelag” (ta sama co w wersji TypeScript).
##
## Pięć miast startowych leży na brzegu archipelagu, każde przy własnym morzu
## przybrzeżnym. Morza przybrzeżne tworzą pierścień wokół Morza Centralnego,
## a trzy wyspy neutralne (Delos, Syros, Paros) czekają na zajęcie.
## To jedno źródło sąsiedztwa dla reguł serwera (GameStateManager, MoveRules)
## i dla planszy (Board, TerritoryNode).
class_name ArchipelagoMap
extends RefCounted

const MAP := {
	"islands": {
		"andros": {"name": "Andros", "prosperity": 1, "slots": 3, "seas": ["arch_n"]},
		"mykonos": {"name": "Mykonos", "prosperity": 1, "slots": 3, "seas": ["arch_ne"]},
		"naxos": {"name": "Naxos", "prosperity": 1, "slots": 4, "seas": ["arch_se"]},
		"milos": {"name": "Milos", "prosperity": 1, "slots": 3, "seas": ["arch_sw"]},
		"kea": {"name": "Kea", "prosperity": 1, "slots": 3, "seas": ["arch_nw"]},
		"delos": {"name": "Delos", "prosperity": 2, "slots": 2, "seas": ["arch_center"]},
		"syros": {"name": "Syros", "prosperity": 1, "slots": 3, "seas": ["arch_n", "arch_nw"]},
		"paros": {"name": "Paros", "prosperity": 1, "slots": 2, "seas": ["arch_ne", "arch_se"]},
	},
	# Sąsiedztwo pól morskich: pierścień wokół Morza Centralnego.
	"seas": {
		"arch_center": ["arch_n", "arch_ne", "arch_se", "arch_sw", "arch_nw"],
		"arch_n": ["arch_center", "arch_ne", "arch_nw"],
		"arch_ne": ["arch_center", "arch_n", "arch_se"],
		"arch_se": ["arch_center", "arch_ne", "arch_sw"],
		"arch_sw": ["arch_center", "arch_se", "arch_nw"],
		"arch_nw": ["arch_center", "arch_sw", "arch_n"],
	},
	# Miasto startowe i jego morze przybrzeżne dla kolejnych miejsc przy stole.
	"cities": [["andros", "arch_n"], ["mykonos", "arch_ne"], ["naxos", "arch_se"], ["milos", "arch_sw"], ["kea", "arch_nw"]],
}

const SEA_NAMES := {
	"arch_center": "Morze Centralne",
	"arch_n": "Morze Pn.",
	"arch_ne": "Morze Pn-Wsch.",
	"arch_se": "Morze Pd-Wsch.",
	"arch_sw": "Morze Pd-Zach.",
	"arch_nw": "Morze Pn-Zach.",
}


static func is_island(territory_id: String) -> bool:
	return MAP["islands"].has(territory_id)


static func is_sea(territory_id: String) -> bool:
	return MAP["seas"].has(territory_id)


## Wyspy leżące przy polu morskim.
static func islands_at(sea_id: String) -> Array:
	var result: Array = []
	for island_id in MAP["islands"]:
		if sea_id in MAP["islands"][island_id]["seas"]:
			result.append(island_id)
	return result


## Sąsiedzi pola: wyspa sąsiaduje ze swoimi morzami, a morze z sąsiednimi morzami i wyspami przy nim.
static func neighbors(territory_id: String) -> PackedStringArray:
	if is_island(territory_id):
		return PackedStringArray(MAP["islands"][territory_id]["seas"])
	if is_sea(territory_id):
		return PackedStringArray(MAP["seas"][territory_id] + islands_at(territory_id))
	return PackedStringArray()


static func display_name(territory_id: String) -> String:
	if is_island(territory_id):
		return String(MAP["islands"][territory_id]["name"])
	return String(SEA_NAMES.get(territory_id, territory_id))
