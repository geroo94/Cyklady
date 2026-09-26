## CreatureTrackUI: tor Mitologicznych Stworów (trzy karty), zakup z celem mocy i akcja Zeusa.
##
## SCENA (scenes/ui/CreatureTrack.tscn)
##   CreatureTrack (PanelContainer, ten skrypt)
##   └── Content (VBoxContainer)
##       ├── Header       „Mitologiczne Stwory” + %DeckLabel (liczba kart w talii i na stosie)
##       ├── %Cards       karty Slot2, Slot1, Slot0, czyli pola za 4, 3 i 2 JZ. W każdej:
##       │                NameLabel, EffectLabel, CostLabel (cena pola), PriceLabel (cena po
##       │                zniżce ze Świątyń), BuyButton i SwapButton (tylko w turze Zeusa)
##       ├── %Prompt      zakup w toku: %PromptLabel, %BuildingOption (Gigant), %CountSpin (Pegaz),
##       │                %ConfirmButton, %CancelButton
##       └── %NoticeLabel odmowa serwera
##
## ZAKUP Z CELEM MOCY
##   „Kup” zaczyna zakup. Panel prosi planszę o wskazanie pól sygnałem pick_requested (cele
##   i podpowiedź), a Main oddaje wskazane pole przez on_target_picked. Kroki zależą od stwora:
##     Harpia    wyspa z oddziałem
##     Gigant    wyspa z budynkiem, potem budynek z listy (gdy na wyspie są różne)
##     Minotaur  twoja wyspa
##     Pegaz     twoja wyspa z oddziałami, wyspa docelowa, liczba oddziałów
##     Kraken    pole morskie, potem trasa pole po polu (+1 JZ za pole) i „Zatwierdź”
##   Cele liczy CreatureRules (te same reguły co serwer). Gotowy zakup przechodzi jeszcze
##   CreatureRules.buy_error i wychodzi sygnałem buy_confirmed(slot, params), a Main wysyła
##   go do serwera (NetworkManager.buy_creature). Do nowego stanu albo odmowy przyciski są
##   wyłączone, więc zakupu nie da się wysłać dwa razy. „Anuluj” kończy zakup (pick_cancelled).
class_name CreatureTrackUI
extends PanelContainer

## Panel prosi planszę o wskazanie jednego z pól `candidates` { id: "PICK" | "ATTACK" }.
## Pusty słownik oznacza, że plansza ma zakończyć wskazywanie.
signal pick_requested(candidates: Dictionary, prompt: String)
## Gracz anulował zakup w panelu: Main kończy wskazywanie na planszy.
signal pick_cancelled
## Zakup gotowy do wysłania: pole toru i cel mocy stwora.
signal buy_confirmed(slot: int, params: Dictionary)
## Akcja Zeusa: wymiana karty z pola `slot`.
signal swap_confirmed(slot: int)

enum Step { NONE, ISLAND, BUILDING, FROM, TO, COUNT, SEA, PATH, SUBMITTED }

const GameState := preload("res://scripts/autoload/GameStateManager.gd")
const Data := preload("res://scripts/autoload/GameData.gd")
## Krótki opis mocy na karcie.
const EFFECTS := {
	"HARPY": "zabiera oddział",
	"GIANT": "niszczy budynek",
	"PEGASUS": "przerzut bez floty",
	"KRAKEN": "niszczy floty",
	"MINOTAUR": "broni jak 2 oddziały",
}
const BUILDING_NAMES := {"PORT": "Port", "FORTRESS": "Forteca", "TEMPLE": "Świątynia", "UNIVERSITY": "Uniwersytet", "THEATER": "Teatr", "NECROPOLIS": "Nekropolia"}

## Panel sam śledzi GameStateManager.view. Wyłącz, gdy stan podajesz przez apply_view (np. w testach).
@export var follow_game_state := true

## Projekcja stanu, którą panel rysuje.
var view: Dictionary = {}
## Zakup w toku: pole toru, stwór, zebrany cel mocy i bieżący krok.
var buying_slot := -1
var buying_key := ""
var params: Dictionary = {}
var step: Step = Step.NONE

var _cards: Dictionary = {}
var _prompt_text := ""
var _notice := ""

@onready var _deck_label: Label = %DeckLabel
@onready var _prompt: Control = %Prompt
@onready var _prompt_label: Label = %PromptLabel
@onready var _building_option: OptionButton = %BuildingOption
@onready var _count_spin: SpinBox = %CountSpin
@onready var _confirm_button: Button = %ConfirmButton
@onready var _notice_label: Label = %NoticeLabel


func _ready() -> void:
	for card: Node in %Cards.get_children():
		var slot := int(String(card.name).trim_prefix("Slot"))
		_cards[slot] = card
		(card.get_node("BuyButton") as Button).pressed.connect(start_buy.bind(slot))
		(card.get_node("SwapButton") as Button).pressed.connect(request_swap.bind(slot))
	_confirm_button.pressed.connect(confirm)
	(%CancelButton as Button).pressed.connect(cancel)
	if follow_game_state:
		var game_state := get_node_or_null("/root/GameStateManager") as GameState
		if game_state != null:
			game_state.view_changed.connect(apply_view)
			apply_view(game_state.view)
			return
	_refresh()


## Nowa projekcja od serwera. Kończy oczekiwanie na odpowiedź, a zakup w toku przerywa,
## jeśli jego karta zniknęła z toru albo skończyła się tura gracza.
func apply_view(new_view: Dictionary) -> void:
	view = new_view
	_notice = ""
	var stale := CreatureRules.card_at(view, buying_slot) != buying_key or not _my_turn()
	if step == Step.SUBMITTED or (step != Step.NONE and stale):
		_reset()
	_refresh()


## Odmowa serwera: zakup wraca do początku, a panel pokazuje powód.
func on_action_rejected(_code: String, message: String) -> void:
	if step == Step.NONE:
		return
	_notice = message
	_reset()
	_refresh()


## „Kup” przy karcie: zaczyna zbieranie celu mocy stwora z pola `slot`.
func start_buy(slot: int) -> void:
	if not _can_buy(slot):
		return
	buying_slot = slot
	buying_key = CreatureRules.card_at(view, slot)
	params = {}
	_notice = ""
	match buying_key:
		"PEGASUS":
			_ask(Step.FROM)
		"KRAKEN":
			_ask(Step.SEA)
		_:
			_ask(Step.ISLAND)


## Pole wskazane na planszy (Main przekazuje je z Board.target_picked).
func on_target_picked(territory_id: String) -> void:
	match step:
		Step.ISLAND:
			params["island"] = territory_id
			if buying_key != "GIANT":
				_complete()
			elif _buildings_on(territory_id).size() == 1:
				params["building"] = _buildings_on(territory_id)[0]
				_complete()
			else:
				_ask(Step.BUILDING)
		Step.FROM:
			params["from"] = territory_id
			_ask(Step.TO)
		Step.TO:
			params["to"] = territory_id
			_ask(Step.COUNT)
		Step.SEA:
			params["sea"] = territory_id
			params["path"] = []
			_ask(Step.PATH)
		Step.PATH:
			params["path"].append(territory_id)
			_ask(Step.PATH)


## „Zatwierdź”: budynek Giganta, liczba oddziałów Pegaza albo trasa Krakena.
func confirm() -> void:
	match step:
		Step.BUILDING:
			params["building"] = String(_building_option.get_item_metadata(_building_option.selected))
		Step.COUNT:
			params["count"] = int(_count_spin.value)
		Step.PATH:
			pass
		_:
			return
	_complete()


## „Anuluj”: koniec zakupu w toku. Main kończy wskazywanie na planszy.
func cancel() -> void:
	_reset()
	_refresh()
	pick_cancelled.emit()


## Plansza anulowała wskazywanie (Esc albo prawy przycisk).
func on_pick_cancelled() -> void:
	_reset()
	_refresh()


## Inna akcja gracza (np. rekrutacja) przerywa zakup w toku. Planszą zajmuje się Main.
func cancel_targeting() -> void:
	if step != Step.NONE and step != Step.SUBMITTED:
		_reset()
		_refresh()


## „Wymień (1 JZ)”: akcja Zeusa dla karty z pola `slot`.
func request_swap(slot: int) -> void:
	if step != Step.NONE or CreatureRules.swap_error(view, _me(), slot) != "":
		return
	step = Step.SUBMITTED
	_refresh()
	swap_confirmed.emit(slot)


# =============================================================================
# Kroki zakupu
# =============================================================================

## Nowy krok zakupu: cele na planszy albo wybór w panelu (budynek, liczba oddziałów, trasa).
func _ask(new_step: Step) -> void:
	step = new_step
	var creature := _creature_name(buying_key)
	match step:
		Step.ISLAND:
			match buying_key:
				"HARPY":
					_prompt_text = "Harpia: wskaż wyspę, z której zabierze oddział."
				"GIANT":
					_prompt_text = "Gigant: wskaż wyspę z budynkiem do zniszczenia."
				_:
					_prompt_text = "%s: wskaż swoją wyspę." % creature
			_request_pick(_island_targets())
		Step.BUILDING:
			_building_option.clear()
			for building in _buildings_on(String(params["island"])):
				_building_option.add_item(String(BUILDING_NAMES.get(building, building)))
				_building_option.set_item_metadata(_building_option.item_count - 1, building)
			_building_option.select(0)
			_prompt_text = "Gigant: wybierz budynek do zniszczenia na %s." % ArchipelagoMap.display_name(String(params["island"]))
		Step.FROM:
			_prompt_text = "Pegaz: wskaż swoją wyspę, z której ruszą oddziały."
			_request_pick(_island_targets())
		Step.TO:
			_prompt_text = "Pegaz: wskaż wyspę docelową (bez łańcucha flot)."
			_request_pick(_pegasus_targets())
		Step.COUNT:
			var movable := MoveRules.movable_units(view, String(params["from"]))
			_count_spin.min_value = 1
			_count_spin.max_value = movable
			_count_spin.value = movable
			_prompt_text = "Pegaz: ile oddziałów przenieść z %s na %s?" % [ArchipelagoMap.display_name(String(params["from"])), ArchipelagoMap.display_name(String(params["to"]))]
		Step.SEA:
			_prompt_text = "Kraken: wskaż pole morskie, na którym się wynurzy."
			_request_pick(_sea_targets(ArchipelagoMap.MAP["seas"].keys()))
		Step.PATH:
			var last := String(params["path"].back()) if not params["path"].is_empty() else String(params["sea"])
			_prompt_text = "Kraken na %s. Wskaż kolejne pole (+1 JZ) albo zatwierdź. Koszt: %d JZ." % [
				ArchipelagoMap.display_name(last), CreatureRules.total_cost(view, _me(), buying_slot, params),
			]
			_request_pick(_sea_targets(ArchipelagoMap.MAP["seas"][last]))
	_refresh()


## Cel mocy zebrany: jeszcze raz reguły serwera, potem zakup do wysłania.
func _complete() -> void:
	var was_picking := step == Step.PATH
	var code := CreatureRules.buy_error(view, _me(), buying_slot, params)
	var slot := buying_slot
	var sent := params.duplicate(true)
	if code != "":
		_notice = "Tego zakupu serwer nie przyjmie (%s)." % code
		_reset()
	else:
		step = Step.SUBMITTED
	_refresh()
	if was_picking:
		pick_requested.emit({}, "")  # plansza kończy wskazywanie trasy Krakena
	if code == "":
		buy_confirmed.emit(slot, sent)


func _request_pick(candidates: Dictionary) -> void:
	pick_requested.emit(candidates, _prompt_text + " Esc: anuluj.")


## Cele na wyspach dla Harpii (wyspy z oddziałem), Giganta (z budynkiem), Minotaura i startu
## Pegaza (twoje wyspy). Wyspy rywali są czerwone.
func _island_targets() -> Dictionary:
	var me := _me()
	var result := {}
	for island_id: String in view["islands"]:
		var island: Dictionary = view["islands"][island_id]
		var allowed := false
		match buying_key:
			"HARPY":
				allowed = CreatureRules.effect_error(view, me, "HARPY", {"island": island_id}) == ""
			"GIANT":
				allowed = not island["buildings"].is_empty()
			"MINOTAUR":
				allowed = CreatureRules.effect_error(view, me, "MINOTAUR", {"island": island_id}) == ""
			"PEGASUS":
				allowed = island["owner"] == me and MoveRules.movable_units(view, island_id) > 0
		if allowed:
			result[island_id] = MoveRules.TARGET_ATTACK if island["owner"] != "" and island["owner"] != me else Board.TARGET_PICK
	return result


## Cele Pegaza: wyspy, na które serwer przyjmie przerzut (także ostatnia wyspa rywala tylko
## wtedy, gdy da ci drugą Metropolię). Pole z oddziałami rywala oznacza bitwę (czerwone).
func _pegasus_targets() -> Dictionary:
	var me := _me()
	var result := {}
	for island_id: String in view["islands"]:
		if CreatureRules.effect_error(view, me, "PEGASUS", {"from": params["from"], "to": island_id, "count": 1}) != "":
			continue
		var holder := String(view["islands"][island_id]["owner"])
		var battle := holder != "" and holder != me and MoveRules.units_on(view, island_id) > 0
		result[island_id] = MoveRules.TARGET_ATTACK if battle else Board.TARGET_PICK
	return result


## Pola morskie Krakena: pole z flotami (każdego gracza) jest czerwone, bo floty zginą.
func _sea_targets(sea_ids: Array) -> Dictionary:
	var result := {}
	for sea_id: String in sea_ids:
		result[sea_id] = MoveRules.TARGET_ATTACK if MoveRules.units_on(view, sea_id) > 0 else Board.TARGET_PICK
	return result


## Różne budynki na wyspie, w kolejności na wyspie.
func _buildings_on(island_id: String) -> Array:
	var result: Array = []
	for building in view["islands"][island_id]["buildings"]:
		if building not in result:
			result.append(building)
	return result


func _reset() -> void:
	buying_slot = -1
	buying_key = ""
	params = {}
	step = Step.NONE
	_prompt_text = ""


# =============================================================================
# Wygląd
# =============================================================================

func _refresh() -> void:
	if not is_node_ready():
		return
	var creatures: Dictionary = view.get("creatures", {})
	_deck_label.text = "talia: %d · stos: %d" % [int(creatures.get("deck_size", 0)), creatures.get("discard", []).size()]
	var me := _me()
	var zeus := _my_turn() and GameState.god_of(view) == "ZEUS"
	for slot: int in _cards:
		var card: Node = _cards[slot]
		var key := CreatureRules.card_at(view, slot)
		(card.get_node("CostLabel") as Label).text = "pole: %d JZ" % int(CreatureRules.SLOT_PRICES[slot])
		(card.get_node("NameLabel") as Label).text = _creature_name(key) if key != "" else "—"
		(card.get_node("EffectLabel") as Label).text = String(EFFECTS.get(key, ""))
		(card.get_node("PriceLabel") as Label).text = _price_text(me, slot) if key != "" else "pole puste"
		(card.get_node("BuyButton") as Button).disabled = not _can_buy(slot)
		var swap := card.get_node("SwapButton") as Button
		swap.visible = zeus
		swap.disabled = step != Step.NONE or CreatureRules.swap_error(view, me, slot) != ""
	_prompt.visible = step != Step.NONE and step != Step.SUBMITTED
	_prompt_label.text = _prompt_text
	_building_option.visible = step == Step.BUILDING
	_count_spin.visible = step == Step.COUNT
	_confirm_button.visible = step in [Step.BUILDING, Step.COUNT, Step.PATH]
	_notice_label.text = _notice
	_notice_label.visible = _notice != ""


func _price_text(me: String, slot: int) -> String:
	var price := CreatureRules.price(view, me, slot)
	var temples := CreatureRules.temples_of(view, me)
	if temples == 0:
		return "cena: %d JZ" % price
	if not CreatureRules.discount_available(view, me):
		return "cena: %d JZ (zniżka już użyta)" % price
	return "cena: %d JZ (Świątynie −%d)" % [price, temples]


## Czy „Kup” przy karcie ma sens: twoja tura, nic nie czeka na serwer, serwer zna moc stwora
## i stać cię na cenę karty (trasę Krakena dolicza się później).
func _can_buy(slot: int) -> bool:
	var key := CreatureRules.card_at(view, slot)
	if key == "" or key not in CreatureRules.SUPPORTED or step != Step.NONE or not _my_turn():
		return false
	return MoveRules.gold_of(view, _me()) >= CreatureRules.price(view, _me(), slot)


func _my_turn() -> bool:
	return view.get("phase", "") == "ACTIONS" and GameState.actor_of(view) == _me()


func _me() -> String:
	return String(view.get("you", ""))


func _creature_name(key: String) -> String:
	return String(Data.myth_card_def(key).get("name", key))
