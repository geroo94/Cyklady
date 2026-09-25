## TerritoryNode: jedno pole planszy Cyklad, czyli wyspa albo pole morskie.
##
## KONFIGURACJA W EDYTORZE
##   TerritoryNode (Area2D, ten skrypt)
##   └── Shape (CollisionPolygon2D)   kształt pola i zarazem obszar kliknięcia
## W Inspektorze ustawia się:
##   territory_id          identyfikator pola z ArchipelagoMap (np. "naxos", "arch_n"),
##   type                  ISLAND albo SEA,
##   display_name          nazwa na etykiecie i w podpowiedziach,
##   adjacent_territories  sąsiedzi pola (ta sama lista co w ArchipelagoMap.neighbors),
##   label_anchor          punkt etykiety wewnątrz pola; na morzu poza wyspami.
## Grupa „Stan pola (podgląd)” pozwala obejrzeć w edytorze pole z jednostkami,
## budynkami i monumentem. W grze nadpisuje ją stan od serwera (apply_state).
##
## WYGLĄD (skrypt buduje go sam, także w edytorze dzięki @tool)
##   Fill     Polygon2D z wielokątem Shape i shaderem territory.gdshader: kolor
##            terenu albo właściciela, podświetlenie oznaczenia, pulsowanie celów,
##   Outline  Line2D wokół pola, grubszy i jaśniejszy pod kursorem,
##   Label    nazwa wyspy, jednostki (†: nieumarli z Hadesa), budynki, monument.
## Węzły wyglądu są wewnętrzne (INTERNAL_MODE): nie trafiają do pliku sceny ani
## do drzewa sceny w edytorze. Jedynym źródłem kształtu pola jest Shape, a
## przesunięcie jego wierzchołka w edytorze od razu zmienia wygląd.
##
## WEJŚCIE
##   mouse_entered / mouse_exited  → sygnały hovered / unhovered i obrys pod kursorem,
##   input_event (lewy przycisk myszy albo dotknięcie ekranu) → sygnał clicked.
## Pole samo niczego nie rozstrzyga. Znaczenie kliknięcia ustala plansza (Board),
## a legalność ruchu sprawdzają MoveRules i serwer.
@tool
class_name TerritoryNode
extends Area2D

## Kursor wszedł na pole (plansza ustawia picking tak, że dostaje to tylko najwyższe pole).
signal hovered(territory: TerritoryNode)
## Kursor opuścił pole.
signal unhovered(territory: TerritoryNode)
## Kliknięcie lewym przyciskiem myszy albo dotknięcie ekranu.
signal clicked(territory: TerritoryNode)

enum Type { ISLAND, SEA }
## Oznaczenie od planszy: pole startowe, cel (ruch, atak, budowa) albo pole przygaszone, bo nie jest celem.
enum Mark { NONE, SELECTED, MOVE_TARGET, ATTACK_TARGET, BUILD_TARGET, DIMMED }

const SHADER := preload("res://board/territory.gdshader")
const LAND_COLOR := Color("d6c28e")
const SEA_COLOR := Color("2e6c9c")
## Kolory graczy (pole "color" gracza w stanie partii).
const PLAYER_COLORS := {
	"BLUE": Color("3d7bdc"),
	"RED": Color("d9453a"),
	"GREEN": Color("3aa35a"),
	"YELLOW": Color("e8c53a"),
	"BLACK": Color("3b3b3b"),
}
const MARK_COLORS := {
	Mark.SELECTED: Color("ffffff"),
	Mark.MOVE_TARGET: Color("6cf08a"),
	Mark.ATTACK_TARGET: Color("ff4d3d"),
	Mark.BUILD_TARGET: Color("ffd447"),
}
const HOVER_COLOR := Color("fff4a8")
const DIMMED_MODULATE := Color(0.55, 0.55, 0.6)
## Skróty budynków na etykiecie. Pełne nazwy podaje podpowiedź planszy.
const BUILDING_SHORT := {"PORT": "P", "FORTRESS": "F", "TEMPLE": "Ś", "UNIVERSITY": "U", "METROPOLIS": "M"}
## Etykiety rysują się nad wypełnieniem wszystkich pól (także nad wyspami, które leżą na morzu).
const LABEL_Z := 3

@export var territory_id := "":
	set(value):
		territory_id = value
		_refresh()
@export var type := Type.ISLAND:
	set(value):
		type = value
		_refresh()
@export var display_name := "":
	set(value):
		display_name = value
		_refresh()
@export var adjacent_territories: Array[String] = []
@export var label_anchor := Vector2.ZERO:
	set(value):
		label_anchor = value
		_refresh()

@export_group("Stan pola (podgląd)")
@export var owner_player_id := "":
	set(value):
		owner_player_id = value
		_refresh()
## Kolor właściciela. Przezroczysty oznacza pole bez koloru gracza.
@export var owner_color := Color(0, 0, 0, 0):
	set(value):
		owner_color = value
		_refresh()
@export var buildings: Array[String] = []:
	set(value):
		buildings = value
		_refresh()
## Wyspa: { "troops", "undead_troops" }, morze: { "fleets", "undead_fleets" }.
@export var units: Dictionary = {}:
	set(value):
		units = value
		_refresh()
## Figurka monumentu (dodatek Monumenty), pusty napis: brak.
@export var monument := "":
	set(value):
		monument = value
		_refresh()

## Oznaczenie ustawiane przez planszę.
var mark := Mark.NONE:
	set(value):
		mark = value
		_refresh()
var is_hovered := false

var _fill: Polygon2D
var _outline: Line2D
var _label: Label


func _ready() -> void:
	_fill = Polygon2D.new()
	_fill.name = "Fill"
	var fill_material := ShaderMaterial.new()
	fill_material.shader = SHADER
	_fill.material = fill_material
	add_child(_fill, false, INTERNAL_MODE_FRONT)

	_outline = Line2D.new()
	_outline.name = "Outline"
	_outline.closed = true
	_outline.joint_mode = Line2D.LINE_JOINT_ROUND
	add_child(_outline, false, INTERNAL_MODE_BACK)

	_label = Label.new()
	_label.name = "Label"
	_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_label.z_index = LABEL_Z
	_label.add_theme_font_size_override("font_size", 17)
	_label.add_theme_color_override("font_color", Color.WHITE)
	_label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.9))
	_label.add_theme_constant_override("outline_size", 6)
	add_child(_label, false, INTERNAL_MODE_BACK)

	input_pickable = true
	if not Engine.is_editor_hint():
		mouse_entered.connect(_on_mouse_entered)
		mouse_exited.connect(_on_mouse_exited)
		input_event.connect(_on_input_event)
	# W edytorze pole śledzi zmiany kształtu Shape. W grze kształt się nie zmienia.
	set_process(Engine.is_editor_hint())
	_refresh()


func _process(_delta: float) -> void:
	var shape := shape_node()
	if shape != null and (shape.polygon != _fill.polygon or shape.transform != _fill.transform):
		_refresh()


## Stan pola z projekcji serwera (słownik wyspy albo morza ze stanu partii) i kolor właściciela.
func apply_state(data: Dictionary, color: Color = Color(0, 0, 0, 0)) -> void:
	owner_player_id = String(data.get("owner", ""))
	owner_color = color
	if type == Type.ISLAND:
		units = {"troops": int(data.get("troops", 0)), "undead_troops": int(data.get("undead_troops", 0))}
		buildings.assign(data.get("buildings", []))
		monument = String(data.get("monument", ""))
	else:
		units = {"fleets": int(data.get("fleets", 0)), "undead_fleets": int(data.get("undead_fleets", 0))}
	_refresh()


## Kształt pola: dziecko „Shape” (albo pierwszy CollisionPolygon2D).
func shape_node() -> CollisionPolygon2D:
	var shape := get_node_or_null("Shape") as CollisionPolygon2D
	if shape != null:
		return shape
	for child in get_children():
		if child is CollisionPolygon2D:
			return child
	return null


## Kolor wypełnienia bez oznaczeń: teren albo teren w barwie właściciela.
func base_color() -> Color:
	var terrain := LAND_COLOR if type == Type.ISLAND else SEA_COLOR
	if owner_player_id == "" or owner_color.a == 0.0:
		return terrain
	return terrain.lerp(owner_color, 0.65 if type == Type.ISLAND else 0.45)


## Tekst etykiety: nazwa wyspy, jednostki (†: nieumarli), skróty budynków i monument.
## Pole morskie pokazuje tylko floty. Jego nazwę podaje podpowiedź planszy.
func label_text() -> String:
	var lines := PackedStringArray()
	if type == Type.ISLAND:
		lines.append(display_name if display_name != "" else territory_id)
	var regular := int(units.get("troops" if type == Type.ISLAND else "fleets", 0))
	var undead := int(units.get("undead_troops" if type == Type.ISLAND else "undead_fleets", 0))
	if regular > 0 or undead > 0:
		var line := "%s %d" % ["oddz." if type == Type.ISLAND else "floty", regular]
		if undead > 0:
			line += " · †%d" % undead
		lines.append(line)
	var extras := PackedStringArray()
	for building in buildings:
		extras.append(String(BUILDING_SHORT.get(building, building.left(1))))
	if monument != "":
		extras.append("mon. %s" % monument.capitalize())
	if not extras.is_empty():
		lines.append(" ".join(extras))
	return "\n".join(lines)


func _get_configuration_warnings() -> PackedStringArray:
	var warnings := PackedStringArray()
	if territory_id == "":
		warnings.append("Ustaw territory_id (identyfikator pola z ArchipelagoMap).")
	var shape := shape_node()
	if shape == null:
		warnings.append("Dodaj dziecko CollisionPolygon2D o nazwie „Shape”: to kształt pola i obszar kliknięcia.")
	elif not Geometry2D.is_point_in_polygon(shape.transform.affine_inverse() * label_anchor, shape.polygon):
		warnings.append("label_anchor leży poza kształtem pola.")
	return warnings


func _refresh() -> void:
	if _fill == null:
		return  # węzły wyglądu powstają w _ready
	var shape := shape_node()
	var points := shape.polygon if shape != null else PackedVector2Array()
	var shape_transform := shape.transform if shape != null else Transform2D.IDENTITY
	_fill.polygon = points
	_fill.transform = shape_transform
	_outline.points = points
	_outline.transform = shape_transform

	var highlighted := MARK_COLORS.has(mark)
	var fill_material := _fill.material as ShaderMaterial
	fill_material.set_shader_parameter("base_color", base_color())
	fill_material.set_shader_parameter("highlight_color", MARK_COLORS.get(mark, Color.WHITE))
	fill_material.set_shader_parameter("highlight_strength", 0.55 if highlighted else 0.0)
	fill_material.set_shader_parameter("pulse_speed", 5.0 if highlighted and mark != Mark.SELECTED else 0.0)
	fill_material.set_shader_parameter("hover", 1.0 if is_hovered else 0.0)
	if is_hovered:
		_outline.default_color = HOVER_COLOR
	elif highlighted:
		_outline.default_color = MARK_COLORS[mark]
	else:
		_outline.default_color = Color(0, 0, 0, 0.45)
	_outline.width = 5.0 if is_hovered or mark == Mark.SELECTED else (3.5 if highlighted else 2.0)
	modulate = DIMMED_MODULATE if mark == Mark.DIMMED else Color.WHITE

	_label.text = label_text()
	_label.reset_size()
	_label.position = label_anchor - _label.size / 2.0
	if Engine.is_editor_hint():
		update_configuration_warnings()


func _on_mouse_entered() -> void:
	is_hovered = true
	_refresh()
	hovered.emit(self)


func _on_mouse_exited() -> void:
	is_hovered = false
	_refresh()
	unhovered.emit(self)


## Kliknięcie to wciśnięcie lewego przycisku myszy albo dotknięcie ekranu. Przy
## domyślnym ustawieniu projektu dotyk przychodzi też jako kliknięcie myszą
## (emulate_mouse_from_touch). Wtedy pomijamy zdarzenie dotyku, żeby jedno
## dotknięcie nie liczyło się podwójnie.
func _on_input_event(_viewport: Node, event: InputEvent, _shape_idx: int) -> void:
	var button := event as InputEventMouseButton
	var touch := event as InputEventScreenTouch
	var mouse_click := button != null and button.pressed and button.button_index == MOUSE_BUTTON_LEFT
	var tap := touch != null and touch.pressed and not _touch_emulates_mouse()
	if mouse_click or tap:
		clicked.emit(self)


static func _touch_emulates_mouse() -> bool:
	return bool(ProjectSettings.get_setting("input_devices/pointing/emulate_mouse_from_touch", true))
