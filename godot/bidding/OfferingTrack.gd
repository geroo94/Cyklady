## OfferingTrack: tor ofiar jednego boga, czyli pola 1–10 i „10+” ze znacznikiem najwyższej ofiary.
##
## Tor tylko rysuje i zgłasza kliknięcia pól. Co pokazać (znacznik ofiary,
## podgląd wyboru gracza, blokadę po przebiciu) ustawia BiddingBoardUI, a potem
## woła queue_redraw(). Skrypt ma @tool, więc tor widać też w edytorze.
@tool
class_name OfferingTrack
extends Control

## Gracz kliknął pole toru. `amount` to kwota pola („10+”: najmniejsza kwota powyżej 10, która przebija ofiarę).
signal amount_picked(track: OfferingTrack, amount: int)

## Pola 1–10 i jedno pole „10+” na wyższe ofiary.
const CELLS := 11
const INVALID_COLOR := Color("ff5a4a")

## Bóg, do którego należy tor (klucz z listy bogów w stanie gry).
@export var god_id := "ARES"
## Kolor boga: ramka wybranego toru i napis na przycisku boga.
@export var accent := Color("d8553f"):
	set(value):
		accent = value
		queue_redraw()
@export var cell_size := 24.0:
	set(value):
		cell_size = value
		update_minimum_size()
		queue_redraw()
@export var cell_gap := 2.0:
	set(value):
		cell_gap = value
		update_minimum_size()
		queue_redraw()
@export var font_size := 12

## Bóg jest na torze w tym cyklu (inaczej tor jest przygaszony).
var available := true
## Po przebiciu gracz nie może od razu wrócić do tego boga (tor przekreślony).
var forbidden := false
## Tor wybrany w panelu licytacji (ramka w kolorze boga).
var selected := false
## Najniższa kwota, która przebija obecną ofiarę. Niższe pola są przygaszone.
var min_amount := 1
## Najwyższa ofiara na torze (0: brak) i kolor gracza, który ją złożył.
var holder_amount := 0
var holder_color := Color(0, 0, 0, 0)
## Znacznik jest właśnie w locie (animacja przebicia), więc tor go nie rysuje.
var holder_hidden := false
## Podgląd kwoty wybranej przez gracza (0: brak): pierścień w jego kolorze, czerwony przy błędzie.
var preview_amount := 0
var preview_color := Color.WHITE
var preview_valid := true


func _get_minimum_size() -> Vector2:
	return Vector2(CELLS * cell_size + (CELLS - 1) * cell_gap, cell_size)


## Pole toru dla kwoty. Kwoty 11 i wyższe leżą na polu „10+”.
static func cell_of(amount: int) -> int:
	return clampi(amount, 1, CELLS) - 1


func cell_rect(index: int) -> Rect2:
	var top := (size.y - cell_size) / 2.0
	return Rect2(Vector2(index * (cell_size + cell_gap), top), Vector2(cell_size, cell_size))


## Środek pola kwoty w układzie toru (tu stoi znacznik i stąd startuje animacja przebicia).
func amount_center(amount: int) -> Vector2:
	return cell_rect(cell_of(amount)).get_center()


## Kwota pola: 1–10, a „10+” to najmniejsza kwota powyżej 10, która przebija obecną ofiarę.
func amount_of_cell(index: int) -> int:
	return index + 1 if index < CELLS - 1 else maxi(CELLS, min_amount)


## Pole pod punktem toru albo -1.
func cell_at(point: Vector2) -> int:
	for index in CELLS:
		if cell_rect(index).grow(cell_gap / 2.0).has_point(point):
			return index
	return -1


func _gui_input(event: InputEvent) -> void:
	var button := event as InputEventMouseButton
	if button != null and button.pressed and button.button_index == MOUSE_BUTTON_LEFT:
		var index := cell_at(button.position)
		if index >= 0:
			amount_picked.emit(self, amount_of_cell(index))
			accept_event()


func _get_tooltip(at_position: Vector2) -> String:
	var index := cell_at(at_position)
	if index < 0:
		return ""
	if index == CELLS - 1:
		return "Ofiara powyżej 10 JZ (dokładną kwotę ustaw suwakiem)."
	return "Ofiara %d JZ" % (index + 1)


func _draw() -> void:
	var font := get_theme_default_font()
	var active := available and not forbidden
	for index in CELLS:
		var rect := cell_rect(index)
		var reachable := active and (index + 1 >= min_amount or index == CELLS - 1)
		draw_rect(rect, Color(1, 1, 1, 0.12 if reachable else 0.03))
		draw_rect(rect, Color(1, 1, 1, 0.3 if reachable else 0.1), false, 1.0)
		var text := str(index + 1) if index < CELLS - 1 else "10+"
		var baseline := rect.get_center().y + font_size * 0.35
		draw_string(font, Vector2(rect.position.x, baseline), text, HORIZONTAL_ALIGNMENT_CENTER, rect.size.x, font_size, Color(1, 1, 1, 0.8 if reachable else 0.25))
	# Ramka i przekreślenie obejmują same pola (kontrolka może być szersza niż tor).
	var cells := Rect2(cell_rect(0).position, cell_rect(CELLS - 1).end - cell_rect(0).position)
	if selected:
		draw_rect(cells.grow(1.5), accent, false, 2.0)
	if holder_amount > 0 and not holder_hidden:
		var center := amount_center(holder_amount)
		draw_circle(center, cell_size * 0.36, holder_color)
		draw_arc(center, cell_size * 0.36, 0.0, TAU, 24, Color(0, 0, 0, 0.85), 2.0)
		if holder_amount >= CELLS:
			draw_string(font, Vector2(center.x - cell_size / 2.0, center.y + font_size * 0.35), str(holder_amount), HORIZONTAL_ALIGNMENT_CENTER, cell_size, font_size, Color.WHITE)
	if preview_amount > 0:
		draw_arc(amount_center(preview_amount), cell_size * 0.46, 0.0, TAU, 24, preview_color if preview_valid else INVALID_COLOR, 2.5)
	if forbidden:
		draw_line(Vector2(cells.position.x, cells.end.y), Vector2(cells.end.x, cells.position.y), Color(INVALID_COLOR, 0.85), 2.0)
