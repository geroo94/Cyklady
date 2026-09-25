## BiddingBoardUI: kontroler interfejsu licytacji (tory ofiar bogów i Apollo).
##
## SCENA (scenes/ui/BiddingBoard.tscn)
##   BiddingBoard (PanelContainer, ten skrypt)
##   ├── Content (VBoxContainer)
##   │   ├── %Banner (PanelContainer) → %BannerLabel   tryb i komunikat, np. „Musisz wybrać innego Boga!”
##   │   ├── %Tracks (VBoxContainer)                   wiersz na boga: GodButton (Button) + Track (OfferingTrack)
##   │   ├── ApolloRow                                 %ApolloButton + %ApolloQueue (miejsca 1, 2, 3…)
##   │   ├── AmountRow                                 %AmountSlider (HSlider) + %AmountLabel
##   │   ├── %CostLabel                                koszt po zniżce kapłanów albo powód odmowy
##   │   └── ConfirmRow                                %OfferButton + %DisplacedTray (znacznik przebitego gracza)
##   ├── %Overlay (Control, bez myszy)                 znaczniki w locie (animacja przebicia)
##   └── %DisplacedSound (AudioStreamPlayer)           dźwięk przebicia
## Wiersz boga to dowolny węzeł w %Tracks z dziećmi „GodButton” i „Track”.
## Bóg wiersza to `god_id` toru, a kolor napisu przycisku to `accent` toru.
## Kolejność i wygląd wierszy ustawia się w edytorze.
##
## TRYBY
##   INACTIVE           licytacja nie trwa (Main ukrywa wtedy panel),
##   WAITING            licytuje ktoś inny: wszystko wyłączone, baner mówi kto,
##   CHOOSING           twoja kolej: bóg (przycisk albo pole toru), kwota (suwak),
##                      potem „Złóż ofiarę” albo darmowy Apollo,
##   MUST_CHOOSE_OTHER  przebito twoją ofiarę: tryb włącza się od razu po
##                      powiadomieniu z serwera, a bóg przebicia jest zablokowany,
##   SUBMITTED          ofiara wysłana, czekamy na serwer (bez podwójnego wysłania).
##
## PRZEPŁYW
##   Wybór → validate_offer() (BidRules na projekcji: te same reguły co serwer,
##   z kapłanami i minimum 1 JZ) → sygnał offer_confirmed(god, amount) → Main →
##   NetworkManager.submit_bid → RPC. Niepoprawnej ofiary panel nie wysyła:
##   przycisk jest wyłączony, a %CostLabel mówi dlaczego. Serwer i tak sprawdza
##   ofiarę jeszcze raz, a jego odmowę Main przekazuje do on_action_rejected().
##   Sygnał serwera bid_displaced(player_id) przychodzi przed nowym stanem.
##   Znacznik przebitego gracza zjeżdża wtedy z toru do tacki, gra dźwięk, a
##   przebity od razu widzi tryb „Musisz wybrać innego Boga”.
class_name BiddingBoardUI
extends PanelContainer

## Gracz zatwierdził poprawną ofiarę (Apollo: god_id = "APOLLO", amount = 0). Main wysyła ją do serwera.
signal offer_confirmed(god_id: String, amount: int)
## Pokazano przebicie gracza `player_id`: ruszyła animacja znacznika i dźwięk.
signal displacement_shown(player_id: String)

enum Mode { INACTIVE, WAITING, CHOOSING, MUST_CHOOSE_OTHER, SUBMITTED }

const GameState := preload("res://scripts/autoload/GameStateManager.gd")
## Nazwy bogów i formy potrzebne w komunikatach („tor Aresa”, „na Atenę”), oraz to, co daje ich tura.
const GODS := {
	"POSEIDON": {"name": "Posejdon", "genitive": "Posejdona", "accusative": "Posejdona", "gives": "ruch flot i Port"},
	"ARES": {"name": "Ares", "genitive": "Aresa", "accusative": "Aresa", "gives": "ruch oddziałów i Forteca"},
	"ZEUS": {"name": "Zeus", "genitive": "Zeusa", "accusative": "Zeusa", "gives": "Świątynia"},
	"ATHENA": {"name": "Atena", "genitive": "Ateny", "accusative": "Atenę", "gives": "Uniwersytet"},
	"HADES": {"name": "Hades", "genitive": "Hadesa", "accusative": "Hadesa", "gives": "nieumarli (dodatek Hades)"},
}
const BANNER_COLORS := {
	Mode.INACTIVE: Color("3a3f44"),
	Mode.WAITING: Color("3a3f44"),
	Mode.CHOOSING: Color("2d6a3e"),
	Mode.MUST_CHOOSE_OTHER: Color("9c2f25"),
	Mode.SUBMITTED: Color("35506b"),
}
const NOTICE_COLOR := Color("ffb36b")

## Panel sam śledzi GameStateManager (view_changed, bid_displaced). Wyłącz, gdy stan podajesz przez apply_view.
@export var follow_game_state := true
## Dźwięk przebicia. Bez pliku panel gra wbudowany dźwięk z dwóch opadających tonów.
@export var displaced_sound: AudioStream
## Czas lotu znacznika przebitego gracza z toru do tacki.
@export var animation_sec := 0.6

## Projekcja stanu od serwera, którą panel rysuje.
var view: Dictionary = {}
## Wybór gracza (bóg i kwota ofiary).
var selected_god := ""
var selected_amount := 1

var _rows: Dictionary = {}
## Ofiara wysłana, czekamy na nowy stan albo odmowę.
var _submitted := false
## Powiadomienie o przebiciu przyszło przed nowym stanem: kto i u którego boga go przebito.
var _pending_player := ""
var _pending_forbidden := ""
var _last_displacement: Dictionary = {}
## Bóg, z którego toru znacznik właśnie odlatuje (tor go nie rysuje).
var _hidden_holder_god := ""
## Znaczniki w locie: gracz → Marker.
var _flying: Dictionary = {}
## Ostatni komunikat dla gracza (odmowa serwera albo nieudana próba wysłania).
var _notice := ""
var _banner_style := StyleBoxFlat.new()
var _banner_pulse: Tween

@onready var _banner: PanelContainer = %Banner
@onready var _banner_label: Label = %BannerLabel
@onready var _apollo_button: Button = %ApolloButton
@onready var _apollo_queue: HBoxContainer = %ApolloQueue
@onready var _slider: HSlider = %AmountSlider
@onready var _amount_label: Label = %AmountLabel
@onready var _cost_label: Label = %CostLabel
@onready var _offer_button: Button = %OfferButton
@onready var _tray: HBoxContainer = %DisplacedTray
@onready var _overlay: Control = %Overlay
@onready var _sound: AudioStreamPlayer = %DisplacedSound


## Znacznik ofiary gracza (kółko w jego kolorze): w kolejce Apolla, w tacce i w locie.
class Marker extends Control:
	var fill := Color.WHITE
	var caption := ""

	func _init(marker_color: Color, marker_caption: String = "") -> void:
		fill = marker_color
		caption = marker_caption
		custom_minimum_size = Vector2(22, 22)
		size = custom_minimum_size
		pivot_offset = size / 2.0
		mouse_filter = Control.MOUSE_FILTER_IGNORE

	func _draw() -> void:
		var center := size / 2.0
		draw_circle(center, 9.0, fill)
		draw_arc(center, 9.0, 0.0, TAU, 24, Color(0, 0, 0, 0.85), 2.0)
		if caption != "":
			draw_string(get_theme_default_font(), Vector2(0, center.y + 4.0), caption, HORIZONTAL_ALIGNMENT_CENTER, size.x, 11, Color.WHITE)


func _ready() -> void:
	for row in %Tracks.get_children():
		var track := row.get_node_or_null("Track") as OfferingTrack
		var button := row.get_node_or_null("GodButton") as Button
		if track == null or button == null:
			continue
		_rows[track.god_id] = {"row": row, "track": track, "button": button}
		button.text = String(GODS.get(track.god_id, {}).get("name", track.god_id))
		button.add_theme_color_override("font_color", track.accent)
		button.pressed.connect(select_god.bind(track.god_id))
		track.amount_picked.connect(_on_amount_picked)
	_apollo_button.pressed.connect(choose_apollo)
	_offer_button.pressed.connect(submit_offer)
	_slider.value_changed.connect(_on_slider_changed)
	_banner.add_theme_stylebox_override("panel", _banner_style)
	_banner_style.set_content_margin_all(6.0)
	_banner_style.set_corner_radius_all(4)
	_sound.stream = displaced_sound if displaced_sound != null else make_chime()
	if follow_game_state:
		var game_state := get_node_or_null("/root/GameStateManager") as GameState
		if game_state != null:
			game_state.view_changed.connect(apply_view)
			game_state.bid_displaced.connect(func(player_id: String) -> void: show_displacement(player_id, game_state.last_bid_displacement))
			apply_view(game_state.view)
			return
	_refresh()


# =============================================================================
# Stan od serwera
# =============================================================================

## Nowa projekcja od serwera. Nowa rewizja kończy oczekiwanie na serwer i stan „przed nowym stanem”.
func apply_view(new_view: Dictionary) -> void:
	if int(new_view.get("revision", -1)) != int(view.get("revision", -2)):
		_submitted = false
		_pending_player = ""
		_pending_forbidden = ""
		_hidden_holder_god = ""
	view = new_view
	_ensure_selection()
	_refresh()


## Przebicie ofiary gracza `player_id`. Znacznik zjeżdża z toru do tacki, gra dźwięk, a przebity
## od razu dostaje tryb „Musisz wybrać innego Boga”. `event` to szczegóły z serwera
## ({ god, previous_amount, by, amount }). Bez niego bóg i kwota pochodzą z bieżącej projekcji,
## która przed nowym stanem pokazuje jeszcze znacznik przebitego gracza.
func show_displacement(player_id: String, event: Dictionary = {}) -> void:
	var god_id := String(event.get("god", ""))
	var amount := int(event.get("previous_amount", 0))
	if god_id == "":
		for slot: Dictionary in view.get("gods", []):
			if slot["holder"] == player_id:
				god_id = String(slot["god"])
				amount = int(slot["amount"])
	var for_me := player_id == my_id()
	_pending_player = player_id
	_last_displacement = event.duplicate()
	_last_displacement["god"] = god_id
	if for_me:
		_pending_forbidden = god_id
		_submitted = false
		_notice = ""
		selected_god = ""  # domyślny wybór ustali nowy stan: dopiero w nim jest twoja kolej
	if _rows.has(god_id) and amount > 0:
		_animate_marker(player_id, god_id, amount)
	_play_displaced_sound(for_me)
	_refresh()
	displacement_shown.emit(player_id)


## Odmowa serwera (np. stan zmienił się w międzyczasie): panel wraca do wyboru i pokazuje powód.
func on_action_rejected(_code: String, message: String) -> void:
	_submitted = false
	_notice = message
	_refresh()


# =============================================================================
# Stan interfejsu
# =============================================================================

func my_id() -> String:
	return String(view.get("you", ""))


func current_mode() -> Mode:
	if view.get("phase", "") != "BIDDING":
		return Mode.INACTIVE
	if _submitted:
		return Mode.SUBMITTED
	if _pending_forbidden != "":
		return Mode.MUST_CHOOSE_OTHER
	var me := my_id()
	if BidRules.bidder_of(view) != me:
		return Mode.WAITING
	if view["bidding"]["displaced"] == me:
		return Mode.MUST_CHOOSE_OTHER
	return Mode.CHOOSING


## Bóg, do którego przebity gracz nie może od razu wrócić (pusty, gdy nie ma blokady).
func forbidden_god() -> String:
	if _pending_forbidden != "":
		return _pending_forbidden
	var bidding: Dictionary = view.get("bidding", {})
	if bidding.get("displaced", "") == my_id():
		return String(bidding.get("forbidden", ""))
	return ""


## Walidacja przed wysłaniem RPC: czy ofiarę można złożyć i czy gracza na nią stać.
## To BidRules na projekcji, czyli te same reguły, którymi sprawdza serwer (kapłani, minimum 1 JZ).
## Zwraca { ok, code, message }. Kody są takie same jak w odpowiedzi serwera.
func validate_offer(god_id: String, amount: int) -> Dictionary:
	var code := ""
	if god_id == "":
		code = "NO_GOD"
	elif _submitted:
		code = "SUBMITTED"
	elif view.is_empty():
		code = "NOT_BIDDING"
	elif god_id == _pending_forbidden:
		code = "FORBIDDEN_GOD"
	else:
		code = BidRules.bid_error(view, my_id(), god_id, amount)
	return {"ok": code == "", "code": code, "message": _message_for(code, god_id, amount)}


# =============================================================================
# Akcje gracza
# =============================================================================

func select_god(god_id: String) -> void:
	selected_god = god_id
	selected_amount = maxi(1, BidRules.min_bid(view, god_id))
	_notice = ""
	_refresh()


func set_amount(amount: int) -> void:
	selected_amount = clampi(amount, 1, BidRules.MAX_BID)
	_notice = ""
	_refresh()


## Wysyła wybraną ofiarę, ale tylko po udanej walidacji. Przy błędzie nic nie wysyła i pokazuje powód.
func submit_offer() -> Dictionary:
	return _confirm(selected_god, selected_amount)


## Apollo: darmowy i dla wielu graczy (miejsca 1, 2, 3…).
func choose_apollo() -> Dictionary:
	return _confirm(BidRules.APOLLO, 0)


func _confirm(god_id: String, amount: int) -> Dictionary:
	var check := validate_offer(god_id, amount)
	if check["ok"]:
		_notice = ""
		_submitted = true  # przed sygnałem: u hosta nowy stan przychodzi jeszcze w trakcie emit()
		offer_confirmed.emit(god_id, amount)
	else:
		_notice = String(check["message"])
	_refresh()
	return check


func _on_amount_picked(track: OfferingTrack, amount: int) -> void:
	selected_god = track.god_id
	set_amount(amount)


func _on_slider_changed(value: float) -> void:
	set_amount(roundi(value))


## Wybór domyślny w swojej turze: pierwszy dostępny bóg, na którego stać gracza (inaczej pierwszy dostępny).
func _ensure_selection() -> void:
	var mode := current_mode()
	if mode != Mode.CHOOSING and mode != Mode.MUST_CHOOSE_OTHER:
		return
	if _selectable(selected_god):
		return
	selected_god = ""
	for god_id: String in _rows:
		if _selectable(god_id) and BidRules.bid_error(view, my_id(), god_id, BidRules.min_bid(view, god_id)) == "":
			selected_god = god_id
			break
	if selected_god == "":
		for god_id: String in _rows:
			if _selectable(god_id):
				selected_god = god_id
				break
	selected_amount = maxi(1, BidRules.min_bid(view, selected_god)) if selected_god != "" else 1


func _selectable(god_id: String) -> bool:
	var slot := BidRules.god_slot(view, god_id)
	return not slot.is_empty() and god_id != forbidden_god() and slot["holder"] != my_id()


# =============================================================================
# Rysowanie
# =============================================================================

func _refresh() -> void:
	var mode := current_mode()
	var acting := mode == Mode.CHOOSING or mode == Mode.MUST_CHOOSE_OTHER
	var me := my_id()
	var forbidden := forbidden_god()
	var check := validate_offer(selected_god, selected_amount)
	for god_id: String in _rows:
		var row: Dictionary = _rows[god_id]
		var track: OfferingTrack = row["track"]
		var button: Button = row["button"]
		var slot := BidRules.god_slot(view, god_id)
		var holder := String(slot.get("holder", ""))
		(row["row"] as Control).visible = god_id != "HADES" or view.is_empty() or not slot.is_empty() or bool(view.get("expansions", {}).get("hades", false))
		track.available = not slot.is_empty() or view.is_empty()
		track.forbidden = god_id == forbidden
		track.selected = acting and god_id == selected_god
		track.min_amount = int(slot.get("amount", 0)) + 1
		track.holder_amount = int(slot["amount"]) if holder != "" else 0
		track.holder_color = player_color(holder)
		track.holder_hidden = god_id == _hidden_holder_god
		track.preview_amount = selected_amount if track.selected else 0
		track.preview_color = player_color(me)
		track.preview_valid = bool(check["ok"])
		track.queue_redraw()
		button.disabled = not (acting and not slot.is_empty() and god_id != forbidden)
		button.tooltip_text = _god_tooltip(god_id, slot)
	_apollo_button.disabled = not acting
	_fill_apollo_queue()

	var affordable := BidRules.max_affordable_bid(view, me) if view.get("players", {}).has(me) else 0
	# Zmiana zakresu przycina starą wartość i wysłałaby value_changed, nadpisując wybór gracza.
	_slider.set_block_signals(true)
	_slider.max_value = clampi(maxi(10, maxi(affordable, selected_amount)), 1, BidRules.MAX_BID)
	_slider.value = selected_amount
	_slider.set_block_signals(false)
	_slider.editable = acting and selected_god != ""
	_amount_label.text = "%d JZ" % selected_amount
	_offer_button.disabled = not (acting and bool(check["ok"]))
	_offer_button.text = "Złóż ofiarę: %s, %d JZ" % [_god_name(selected_god), selected_amount] if acting and selected_god != "" else "Złóż ofiarę"
	if _notice != "":
		_cost_label.text = _notice
		_cost_label.add_theme_color_override("font_color", NOTICE_COLOR)
	else:
		_cost_label.text = _cost_text(check) if acting else ""
		_cost_label.remove_theme_color_override("font_color")
	_fill_tray()
	_show_banner(mode)


func _show_banner(mode: Mode) -> void:
	_banner_style.bg_color = BANNER_COLORS[mode]
	_banner_label.text = _banner_text(mode)
	var alert := mode == Mode.MUST_CHOOSE_OTHER
	if alert and _banner_pulse == null:
		_banner_pulse = create_tween().set_loops()
		_banner_pulse.tween_property(_banner, "modulate", Color(1.35, 1.1, 1.1), 0.45)
		_banner_pulse.tween_property(_banner, "modulate", Color.WHITE, 0.45)
	elif not alert and _banner_pulse != null:
		_banner_pulse.kill()
		_banner_pulse = null
		_banner.modulate = Color.WHITE


func _banner_text(mode: Mode) -> String:
	match mode:
		Mode.WAITING:
			var text := "Licytuje %s." % _player_name(BidRules.bidder_of(view))
			var queue := PackedStringArray()
			for player_id in view["bidding"]["queue"]:
				if player_id != BidRules.bidder_of(view):
					queue.append("Ty" if player_id == my_id() else _player_name(String(player_id)))
			return text + (" Dalej: %s." % ", ".join(queue) if not queue.is_empty() else "")
		Mode.CHOOSING:
			return "Twoja kolej! Wybierz boga i kwotę albo idź do Apolla (za darmo, +1 JZ)."
		Mode.MUST_CHOOSE_OTHER:
			var god_id := forbidden_god()
			var slot := BidRules.god_slot(view, god_id)
			var by := String(_last_displacement.get("by", "")) if _pending_player != "" else String(slot.get("holder", ""))
			var amount := int(_last_displacement.get("amount", 0)) if _pending_player != "" else int(slot.get("amount", 0))
			var detail := " (%s dał %d JZ)" % [_player_name(by), amount] if by != "" and amount > 0 else ""
			return "Przelicytowano cię na torze %s%s. Musisz wybrać innego Boga albo Apolla!" % [_god_form(god_id, "genitive"), detail]
		Mode.SUBMITTED:
			return "Ofiara wysłana. Czekam na serwer…"
	return "Licytacja zamknięta."


func _cost_text(check: Dictionary) -> String:
	if not check["ok"]:
		return String(check["message"])
	var player: Dictionary = view["players"][my_id()]
	var gold := int(player["gold"])
	var priests := int(player["priests"])
	var cost := BidRules.offering_cost(selected_amount, priests)
	var discount := ""
	if priests > 0 and cost == 1 and selected_amount - priests < 1:
		discount = " (minimum 1 JZ, kapłani: %d)" % priests
	elif priests > 0:
		discount = " (kapłani: −%d JZ)" % (selected_amount - cost)
	return "Ofiara %d JZ: zapłacisz %d JZ%s. Masz %d JZ." % [selected_amount, cost, discount, gold]


func _message_for(code: String, god_id: String, amount: int) -> String:
	match code:
		"":
			return ""
		"NO_GOD":
			return "Wybierz boga: kliknij pole na jego torze albo przycisk z imieniem."
		"SUBMITTED":
			return "Ofiara wysłana, czekam na serwer."
		"NOT_BIDDING":
			return "Licytacja jest zamknięta."
		"NOT_YOUR_TURN":
			return "Teraz licytuje %s." % _player_name(BidRules.bidder_of(view))
		"UNKNOWN_GOD":
			return "%s nie ma w tym cyklu na torze." % _god_name(god_id)
		"FORBIDDEN_GOD":
			return "Po przebiciu nie możesz od razu wrócić do %s." % _god_form(god_id, "genitive")
		"OWN_OFFERING":
			return "Ta ofiara już należy do ciebie."
		"INVALID_AMOUNT":
			return "Ofiara musi wynosić od 1 do %d JZ." % BidRules.MAX_BID
		"BID_TOO_LOW":
			return "Na %s trzeba dać co najmniej %d JZ." % [_god_form(god_id, "accusative"), BidRules.min_bid(view, god_id)]
		"CANNOT_AFFORD":
			var player: Dictionary = view["players"][my_id()]
			return "Nie stać cię: ofiara %d JZ kosztuje %d JZ (kapłani: %d), a masz %d JZ." % [amount, BidRules.offering_cost(amount, int(player["priests"])), int(player["priests"]), int(player["gold"])]
	return code


func _god_tooltip(god_id: String, slot: Dictionary) -> String:
	var text := "%s: %s." % [_god_name(god_id), String(GODS.get(god_id, {}).get("gives", ""))]
	if slot.is_empty():
		return text + " Nie ma go w tym cyklu na torze."
	if String(slot["holder"]) == "":
		return text + " Brak ofiar."
	return text + " Najwyższa ofiara: %d JZ (%s)." % [int(slot["amount"]), _player_name(String(slot["holder"]))]


func _fill_apollo_queue() -> void:
	_clear(_apollo_queue)
	var apollo: Array = view.get("apollo", [])
	for index in apollo.size():
		var marker := Marker.new(player_color(String(apollo[index])), str(index + 1))
		marker.tooltip_text = "%d. %s (+1 JZ)" % [index + 1, _player_name(String(apollo[index]))]
		_apollo_queue.add_child(marker)
	var hint := Label.new()
	hint.text = "za darmo, +1 JZ" if apollo.is_empty() else ""
	hint.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	_apollo_queue.add_child(hint)


## Tacka: znacznik przebitego gracza czeka, aż gracz wybierze innego boga.
func _fill_tray() -> void:
	_clear(_tray)
	var bidding: Dictionary = view.get("bidding", {})
	var displaced := _pending_player if _pending_player != "" else String(bidding.get("displaced", ""))
	if displaced == "" or _flying.has(displaced):
		return
	_tray.add_child(Marker.new(player_color(displaced)))
	var label := Label.new()
	label.text = "Twój znacznik czeka na nowego boga" if displaced == my_id() else "%s wybiera innego boga" % _player_name(displaced)
	_tray.add_child(label)


# =============================================================================
# Animacja i dźwięk przebicia
# =============================================================================

func _animate_marker(player_id: String, god_id: String, amount: int) -> void:
	var track: OfferingTrack = _rows[god_id]["track"]
	var marker := Marker.new(player_color(player_id))
	_overlay.add_child(marker)
	marker.global_position = track.get_global_transform() * track.amount_center(amount) - marker.size / 2.0
	var target := _tray.get_global_rect().position + Vector2(0, _tray.size.y / 2.0) - Vector2(0, marker.size.y / 2.0)
	_hidden_holder_god = god_id
	if _flying.has(player_id):
		(_flying[player_id] as Marker).queue_free()
	_flying[player_id] = marker
	var tween := create_tween()
	tween.tween_property(marker, "scale", Vector2(1.5, 1.5), animation_sec * 0.2)
	tween.tween_property(marker, "global_position", target, animation_sec * 0.8).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_IN_OUT)
	tween.parallel().tween_property(marker, "scale", Vector2.ONE, animation_sec * 0.8)
	tween.tween_callback(_on_marker_landed.bind(player_id, marker))
	var flash := create_tween()
	flash.tween_property(track, "modulate", Color(1.0, 0.45, 0.4), 0.08)
	flash.tween_property(track, "modulate", Color.WHITE, 0.45)


func _on_marker_landed(player_id: String, marker: Marker) -> void:
	if _flying.get(player_id) == marker:
		_flying.erase(player_id)
	marker.queue_free()
	_refresh()


## Dźwięk przebicia: głośniej, gdy przebito ciebie, ciszej i wyżej, gdy kogoś innego.
func _play_displaced_sound(for_me: bool) -> void:
	_sound.volume_db = 0.0 if for_me else -9.0
	_sound.pitch_scale = 1.0 if for_me else 1.25
	_sound.play()


## Wbudowany dźwięk przebicia: dwa opadające tony z wygasaniem (bez plików audio w projekcie).
static func make_chime() -> AudioStreamWAV:
	var rate := 22050
	var tones := [[880.0, 0.12], [587.33, 0.24]]
	var data := PackedByteArray()
	for tone: Array in tones:
		var frequency: float = tone[0]
		var seconds: float = tone[1]
		var samples := int(rate * seconds)
		var offset := data.size()
		data.resize(offset + samples * 2)
		for i in samples:
			var t := float(i) / rate
			var value := sin(TAU * frequency * t) * exp(-5.0 * t / seconds) * 0.45
			data.encode_s16(offset + i * 2, int(value * 32767.0))
	var wav := AudioStreamWAV.new()
	wav.format = AudioStreamWAV.FORMAT_16_BITS
	wav.mix_rate = rate
	wav.data = data
	return wav


# =============================================================================
# Pomocnicze
# =============================================================================

## Usuwa dzieci od razu: kilka odświeżeń w jednej klatce nie zostawia starych znaczników obok nowych.
static func _clear(container: Node) -> void:
	for child in container.get_children():
		container.remove_child(child)
		child.queue_free()


func player_color(player_id: String) -> Color:
	var players: Dictionary = view.get("players", {})
	var player: Dictionary = players.get(player_id, {})
	return TerritoryNode.PLAYER_COLORS.get(String(player.get("color", "")), Color(0.6, 0.6, 0.6))


func _player_name(player_id: String) -> String:
	var players: Dictionary = view.get("players", {})
	var player: Dictionary = players.get(player_id, {})
	return String(player.get("name", player_id))


func _god_name(god_id: String) -> String:
	return "Apollo" if god_id == BidRules.APOLLO else String(GODS.get(god_id, {}).get("name", god_id))


func _god_form(god_id: String, form: String) -> String:
	return String(GODS.get(god_id, {}).get(form, god_id))
