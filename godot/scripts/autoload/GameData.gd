## GameData: baza treści gry, czyli bogowie, Mitologiczne Stwory z herosami i Monumenty.
##
## Baza opisuje, czym JEST bóg, karta albo Monument. Nie mówi, GDZIE się
## znajduje: tor, talię, wyspę i zapas gracza trzyma stan gry
## (GameStateManager). Treść nie zmienia się w trakcie partii.
##
## Wpisy nie zawierają logiki. Karta niesie tylko klucz efektu (`effect`,
## u herosa `ability`), a działanie wykonuje silnik zasad. Klucze ("ZEUS",
## "KRAKEN", "COLOSSUS"…) i klucze efektów są te same co w wersji TypeScript
## (src/model/domain.ts, src/examples/sampleGame.ts), więc przechodzą przez RPC
## i zapis partii bez tłumaczenia.
##
## Treść to na razie katalog przykładowy, ten sam co w wersji TypeScript. Pełny
## katalog z pudełka to osobne zadanie (TASKS.md, rozdział 2). Wartości
## oznaczone [zweryfikuj] trzeba potwierdzić w instrukcji.
##
## Użycie: GameData.god_def("ZEUS"), GameData.myth_deck(view["expansions"]).
## Funkcje są statyczne, więc działają też bez autoloadów (np. w narzędziach
## uruchamianych przez --script): preload("res://scripts/autoload/GameData.gd").
extends Node

## Pochodzenie treści: podstawka albo dodatek.
const EXPANSIONS := ["BASE", "HADES", "MONUMENTS"]
## Przełącznik dodatku w stanie gry (`expansions`: { "hades", "monuments" }).
const EXPANSION_FLAGS := {"HADES": "hades", "MONUMENTS": "monuments"}

## Budynki stawiane w slotach wysp (jak BuildingType w TS) i ich nazwy w komunikatach.
const BUILDING_NAMES := {
	"PORT": "Port",
	"FORTRESS": "Forteca",
	"TEMPLE": "Świątynia",
	"UNIVERSITY": "Uniwersytet",
	"THEATER": "Teatr",
	"NECROPOLIS": "Nekropolia",
}
## Co gracz może pozyskać w turze boga (jak RecruitKind w TS).
const RECRUIT_KINDS := ["TROOP", "FLEET", "PRIEST", "PHILOSOPHER", "PRIESTESS", "UNDEAD_TROOP", "UNDEAD_FLEET"]
## Gdzie stwór stawia figurkę. Pusty napis: karta działa jednorazowo, bez figurki.
const FIGURE_PLACEMENTS := ["", "ISLAND", "SEA"]


# =============================================================================
# Bogowie
# =============================================================================

## Bogowie losowani na tor stoją w tej samej kolejności co GameStateManager.GODS
## (test to sprawdza). Pola:
##   name           nazwa wyświetlana (docelowo klucz tłumaczenia)
##   expansion      "BASE" albo dodatek, z którego pochodzi bóg
##   biddable       licytuje się o jego względy (Apollo przyjmuje wielu graczy za darmo)
##   randomized     losowany na tor w każdym cyklu (Hades wkracza tylko z Kolumny Hadesa)
##   building       budynek stawiany w turze boga, pusty napis: brak budowy
##   recruits       co gracz pozyskuje w turze boga
##   recruit_costs  koszt kolejnej sztuki jednego rodzaju w jednej turze (indeks: która
##                  z kolei). Długość listy to limit na turę, jak `undeadCosts` w TS.
##   gold_bonus     JZ, które gracz dostaje w turze boga
const GODS := {
	"POSEIDON": {
		"name": "Posejdon",
		"expansion": "BASE",
		"biddable": true,
		"randomized": true,
		"building": "PORT",
		"recruits": ["FLEET"],
		"recruit_costs": [0, 1, 2, 3],  # [zweryfikuj]
		"gold_bonus": 0,
	},
	"ARES": {
		"name": "Ares",
		"expansion": "BASE",
		"biddable": true,
		"randomized": true,
		"building": "FORTRESS",
		"recruits": ["TROOP"],
		"recruit_costs": [0, 1, 2, 3],  # [zweryfikuj]
		"gold_bonus": 0,
	},
	"ZEUS": {
		"name": "Zeus",
		"expansion": "BASE",
		"biddable": true,
		"randomized": true,
		"building": "TEMPLE",
		"recruits": ["PRIEST"],
		"recruit_costs": [0, 4],  # [zweryfikuj]
		"gold_bonus": 0,
	},
	"ATHENA": {
		"name": "Atena",
		"expansion": "BASE",
		"biddable": true,
		"randomized": true,
		"building": "UNIVERSITY",
		"recruits": ["PHILOSOPHER"],
		"recruit_costs": [0, 4],  # [zweryfikuj]
		"gold_bonus": 0,
	},
	"APOLLO": {
		"name": "Apollo",
		"expansion": "BASE",
		"biddable": false,
		"randomized": false,
		"building": "",
		"recruits": [],
		"recruit_costs": [],
		# Tak płaci dziś GameStateManager. [zweryfikuj] premia dla pierwszego gracza i znacznik dobrobytu
		"gold_bonus": 1,
	},
	"HADES": {
		"name": "Hades",
		"expansion": "HADES",
		"biddable": true,
		"randomized": false,
		"building": "NECROPOLIS",
		"recruits": ["UNDEAD_TROOP", "UNDEAD_FLEET"],
		"recruit_costs": [0, 1, 2, 3],  # osobno dla każdego rodzaju, jak `undeadCosts` w TS [zweryfikuj]
		"gold_bonus": 0,
	},
}


# =============================================================================
# Mitologiczne Stwory i herosi
# =============================================================================

## Stwory z talii i toru stworów. Cena zależy od pola toru (2, 3 albo 4 JZ),
## więc karta jej nie zawiera. Pola:
##   copies  liczba kart w talii
##   figure  gdzie stwór stawia figurkę: "ISLAND", "SEA" albo "" (bez figurki)
##   effect  klucz efektu w silniku zasad
const CREATURES := {
	"KRAKEN": {"name": "Kraken", "expansion": "BASE", "copies": 1, "figure": "SEA", "effect": "creature.kraken"},
	"MINOTAUR": {"name": "Minotaur", "expansion": "BASE", "copies": 1, "figure": "ISLAND", "effect": "creature.minotaur"},
	"PEGASUS": {"name": "Pegaz", "expansion": "BASE", "copies": 2, "figure": "", "effect": "creature.pegasus"},
	"HARPY": {"name": "Harpia", "expansion": "BASE", "copies": 1, "figure": "", "effect": "creature.harpy"},
	"GIANT": {"name": "Gigant", "expansion": "BASE", "copies": 1, "figure": "", "effect": "creature.giant"},
}

## Herosi (dodatek Hades) leżą w tej samej talii i na tym samym torze co stwory. Pola:
##   strength  siła w bitwie lądowej, czyli ilu oddziałom odpowiada heros
##   ability   klucz zdolności w silniku zasad
const HEROES := {
	"ACHILLES": {"name": "Achilles", "expansion": "HADES", "copies": 1, "strength": 2, "ability": "hero.achilles"},
	"HERACLES": {"name": "Herakles", "expansion": "HADES", "copies": 1, "strength": 2, "ability": "hero.heracles"},
	"ULYSSES": {"name": "Ulisses", "expansion": "HADES", "copies": 1, "strength": 1, "ability": "combat.ignoreFortifications"},
}


# =============================================================================
# Monumenty
# =============================================================================

## Karty Monumentów (dodatek Monumenty). Monument staje sam, gdy gracz ma wymagane
## budynki na dowolnych swoich wyspach. Pola:
##   required_buildings  powtórzony typ oznacza kilka sztuk
##   effect              pasywna moc Monumentu w silniku zasad
const MONUMENTS := {
	"COLOSSUS": {"name": "Kolos", "expansion": "MONUMENTS", "required_buildings": ["PORT", "TEMPLE"], "effect": "monument.colossus"},
	"ORACLE": {"name": "Wyrocznia", "expansion": "MONUMENTS", "required_buildings": ["TEMPLE", "UNIVERSITY"], "effect": "monument.oracle"},
	"ARES_CITADEL": {"name": "Wielka Cytadela Aresa", "expansion": "MONUMENTS", "required_buildings": ["FORTRESS", "FORTRESS"], "effect": "combat.blockAttacks"},
	"WAR_PORT": {"name": "Port Wojenny", "expansion": "MONUMENTS", "required_buildings": ["PORT", "FORTRESS"], "effect": "combat.fleetsDefendLand"},
}


func _ready() -> void:
	if OS.is_debug_build():
		for problem in validate():
			push_error("GameData: %s" % problem)


# =============================================================================
# Odczyt
# =============================================================================

## Czy treść z dodatku `expansion` jest w grze przy przełącznikach `expansions`
## ({ "hades", "monuments" }, jak w stanie gry). Podstawka jest zawsze.
static func is_enabled(expansion: String, expansions: Dictionary) -> bool:
	if expansion == "BASE":
		return true
	return bool(expansions.get(EXPANSION_FLAGS.get(expansion, ""), false))


## Definicja boga (kopia, więc wolno ją zmieniać) albo pusty słownik dla nieznanego boga.
static func god_def(god_id: String) -> Dictionary:
	return _entry(GODS, god_id)


## Definicja stwora (kopia) albo pusty słownik.
static func creature_def(key: String) -> Dictionary:
	return _entry(CREATURES, key)


## Definicja herosa (kopia) albo pusty słownik.
static func hero_def(key: String) -> Dictionary:
	return _entry(HEROES, key)


## Karta z talii stworów: kopia definicji stwora albo herosa z polem "type"
## ("CREATURE" albo "HERO"). Dla nieznanego klucza pusty słownik.
static func myth_card_def(key: String) -> Dictionary:
	if CREATURES.has(key):
		return creature_def(key).merged({"type": "CREATURE"})
	if HEROES.has(key):
		return hero_def(key).merged({"type": "HERO"})
	return {}


## Definicja karty Monumentu (kopia) albo pusty słownik.
static func monument_def(kind: String) -> Dictionary:
	return _entry(MONUMENTS, kind)


## Nazwa budynku do komunikatów, np. „Brakuje: Port, Świątynia”.
static func building_name(building: String) -> String:
	return String(BUILDING_NAMES.get(building, building))


## Bogowie w partii z danymi dodatkami, w kolejności z GODS.
static func gods_for(expansions: Dictionary) -> PackedStringArray:
	var result := PackedStringArray()
	for god_id: String in GODS:
		if is_enabled(String(GODS[god_id]["expansion"]), expansions):
			result.append(god_id)
	return result


## Bogowie losowani na tor licytacji w każdym cyklu (bez Apolla i Hadesa).
static func randomized_gods() -> PackedStringArray:
	var result := PackedStringArray()
	for god_id: String in GODS:
		if GODS[god_id]["randomized"]:
			result.append(god_id)
	return result


## Talia stworów (z herosami, gdy gramy z Hadesem): klucz powtórzony tyle razy,
## ile jest kopii karty. Kolejność jak w bazie, a tasuje serwer swoim generatorem.
static func myth_deck(expansions: Dictionary) -> PackedStringArray:
	var deck := PackedStringArray()
	for table: Dictionary in [CREATURES, HEROES]:
		for key: String in table:
			var card: Dictionary = table[key]
			if is_enabled(String(card["expansion"]), expansions):
				for _copy in int(card["copies"]):
					deck.append(key)
	return deck


## Talia kart Monumentów (pusta w partii bez dodatku Monumenty).
static func monument_deck(expansions: Dictionary) -> PackedStringArray:
	var deck := PackedStringArray()
	for kind: String in MONUMENTS:
		if is_enabled(String(MONUMENTS[kind]["expansion"]), expansions):
			deck.append(kind)
	return deck


# =============================================================================
# Kontrola danych
# =============================================================================

## Błędy w bazie: brakujące pola, nieznane dodatki, budynki i rodzaje jednostek.
## Pusta lista oznacza spójne dane. W wersji debug `_ready()` zgłasza każdy błąd,
## a testy sprawdzają, że lista jest pusta.
static func validate() -> PackedStringArray:
	var problems := PackedStringArray()
	for god_id: String in GODS:
		problems.append_array(_god_problems(god_id, GODS[god_id]))
	for key: String in CREATURES:
		problems.append_array(_creature_problems(key, CREATURES[key]))
	for key: String in HEROES:
		problems.append_array(_hero_problems(key, HEROES[key]))
	for kind: String in MONUMENTS:
		problems.append_array(_monument_problems(kind, MONUMENTS[kind]))
	return problems


static func _god_problems(god_id: String, god: Dictionary) -> PackedStringArray:
	var problems := _missing_fields(god_id, god, ["name", "expansion", "biddable", "randomized", "building", "recruits", "recruit_costs", "gold_bonus"])
	if not problems.is_empty():
		return problems
	problems.append_array(_expansion_problems(god_id, god))
	var building := String(god["building"])
	if building != "" and not BUILDING_NAMES.has(building):
		problems.append("%s: nieznany budynek %s" % [god_id, building])
	for kind: String in god["recruits"]:
		if kind not in RECRUIT_KINDS:
			problems.append("%s: nieznany rodzaj rekrutacji %s" % [god_id, kind])
	if god["recruits"].is_empty() != god["recruit_costs"].is_empty():
		problems.append("%s: rekrutacja i jej koszty muszą być podane razem" % god_id)
	for cost: int in god["recruit_costs"]:
		if cost < 0:
			problems.append("%s: ujemny koszt rekrutacji" % god_id)
	if god["randomized"] and not god["biddable"]:
		problems.append("%s: bóg losowany na tor musi być licytowany" % god_id)
	return problems


static func _creature_problems(key: String, card: Dictionary) -> PackedStringArray:
	var problems := _missing_fields(key, card, ["name", "expansion", "copies", "figure", "effect"])
	if not problems.is_empty():
		return problems
	problems.append_array(_expansion_problems(key, card))
	problems.append_array(_card_problems(key, card, "effect"))
	if card["figure"] not in FIGURE_PLACEMENTS:
		problems.append("%s: nieznane miejsce figurki %s" % [key, card["figure"]])
	return problems


static func _hero_problems(key: String, card: Dictionary) -> PackedStringArray:
	var problems := _missing_fields(key, card, ["name", "expansion", "copies", "strength", "ability"])
	if not problems.is_empty():
		return problems
	problems.append_array(_expansion_problems(key, card))
	problems.append_array(_card_problems(key, card, "ability"))
	if int(card["strength"]) < 1:
		problems.append("%s: siła herosa musi wynosić co najmniej 1" % key)
	if CREATURES.has(key):
		problems.append("%s: ten sam klucz ma stwór i heros" % key)
	return problems


static func _monument_problems(kind: String, card: Dictionary) -> PackedStringArray:
	var problems := _missing_fields(kind, card, ["name", "expansion", "required_buildings", "effect"])
	if not problems.is_empty():
		return problems
	problems.append_array(_expansion_problems(kind, card))
	if card["required_buildings"].is_empty():
		problems.append("%s: Monument bez wymaganych budynków" % kind)
	for building: String in card["required_buildings"]:
		if not BUILDING_NAMES.has(building):
			problems.append("%s: nieznany budynek %s" % [kind, building])
	if String(card["effect"]) == "":
		problems.append("%s: brak klucza efektu" % kind)
	return problems


## Wspólne dla kart z talii stworów: liczba kopii i klucz efektu (`effect` albo `ability`).
static func _card_problems(key: String, card: Dictionary, effect_field: String) -> PackedStringArray:
	var problems := PackedStringArray()
	if int(card["copies"]) < 1:
		problems.append("%s: karta musi mieć co najmniej 1 kopię" % key)
	if String(card[effect_field]) == "":
		problems.append("%s: brak klucza efektu" % key)
	return problems


static func _expansion_problems(key: String, entry: Dictionary) -> PackedStringArray:
	var problems := PackedStringArray()
	if entry["expansion"] not in EXPANSIONS:
		problems.append("%s: nieznany dodatek %s" % [key, entry["expansion"]])
	return problems


static func _missing_fields(key: String, entry: Dictionary, fields: Array) -> PackedStringArray:
	var problems := PackedStringArray()
	for field: String in fields:
		if not entry.has(field):
			problems.append("%s: brak pola „%s”" % [key, field])
	return problems


static func _entry(table: Dictionary, key: String) -> Dictionary:
	var entry: Dictionary = table.get(key, {})
	return entry.duplicate(true)
