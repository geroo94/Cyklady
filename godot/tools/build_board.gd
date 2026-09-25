## Generator sceny planszy scenes/board/Board.tscn z mapy ArchipelagoMap.
##
##   godot --headless --path godot --script res://tools/build_board.gd
##
## Układ: Morze Centralne (koło) w środku, pięć sektorów morskich wokół niego,
## miasta startowe w swoich sektorach, Syros i Paros na granicy dwóch mórz,
## Delos pośrodku. Wyspy to nieregularne wielokąty (stałe ziarno z nazwy wyspy).
## Każde pole leży w swoim punkcie etykiety (label_anchor = 0), a jego kształt
## to dziecko Shape (CollisionPolygon2D) we współrzędnych pola.
## Wygenerowaną scenę można dalej poprawiać w edytorze (wierzchołki Shape,
## położenie pól). Ponowne uruchomienie generatora nadpisuje te poprawki.
extends SceneTree

const OUTPUT := "res://scenes/board/Board.tscn"
const INNER_RADIUS := 110.0
const OUTER_RADIUS := 340.0
const SECTOR_HALF_ANGLE := 36.0
## Co tyle stopni wierzchołek łuku. Granice sektorów (18° + k·72°) wypadają na
## wierzchołkach koła centralnego, więc sąsiednie pola stykają się bez szczelin.
const ARC_STEP := 4.0
const ARC_START := 18.0
## Środek sektora morskiego w stopniach (0° = wschód, -90° = północ).
const SEA_ANGLES := {"arch_n": -90.0, "arch_ne": -18.0, "arch_se": 54.0, "arch_sw": 126.0, "arch_nw": 198.0}
## Etykieta sektora morskiego: odległość od środka planszy (między kołem centralnym a miastem).
const SEA_LABEL_RADIUS := 165.0
## Etykieta Morza Centralnego: pod Delos.
const CENTER_LABEL := Vector2(0, 72)
## Wyspy: [kąt w stopniach, odległość środka wyspy od środka planszy, promień].
const ISLANDS := {
	"andros": [-90.0, 260.0, 40.0],
	"mykonos": [-18.0, 260.0, 40.0],
	"naxos": [54.0, 260.0, 44.0],
	"milos": [126.0, 260.0, 40.0],
	"kea": [198.0, 260.0, 38.0],
	"delos": [0.0, 0.0, 36.0],
	"syros": [-126.0, 292.0, 36.0],
	"paros": [18.0, 292.0, 34.0],
}


func _init() -> void:
	var board := Board.new()
	board.name = "Board"
	var seas := Node2D.new()
	seas.name = "Seas"
	board.add_child(seas)
	seas.owner = board
	var islands := Node2D.new()
	islands.name = "Islands"
	islands.z_index = 1  # wyspy rysują się nad morzami i pierwsze dostają zdarzenia myszy
	board.add_child(islands)
	islands.owner = board

	for sea_id: String in ArchipelagoMap.MAP["seas"]:
		var anchor := CENTER_LABEL
		var polygon := _circle(INNER_RADIUS)
		if SEA_ANGLES.has(sea_id):
			anchor = _polar(SEA_ANGLES[sea_id], SEA_LABEL_RADIUS)
			polygon = _sector(SEA_ANGLES[sea_id])
		_add_territory(board, seas, sea_id, TerritoryNode.Type.SEA, polygon, anchor)
	for island_id: String in ArchipelagoMap.MAP["islands"]:
		var place: Array = ISLANDS[island_id]
		var center := _polar(place[0], place[1])
		_add_territory(board, islands, island_id, TerritoryNode.Type.ISLAND, _blob(island_id, center, place[2]), center)

	var scene := PackedScene.new()
	var error := scene.pack(board)
	if error == OK:
		error = ResourceSaver.save(scene, OUTPUT)
	print("%s: %s" % [OUTPUT, error_string(error)])
	board.free()
	quit(0 if error == OK else 1)


func _add_territory(board: Node, parent: Node, id: String, type: TerritoryNode.Type, polygon: PackedVector2Array, anchor: Vector2) -> void:
	var node := TerritoryNode.new()
	node.name = id
	node.territory_id = id
	node.type = type
	node.display_name = ArchipelagoMap.display_name(id)
	node.adjacent_territories.assign(Array(ArchipelagoMap.neighbors(id)))
	node.position = anchor.round()
	var shape := CollisionPolygon2D.new()
	shape.name = "Shape"
	var local := PackedVector2Array()
	for point in polygon:
		# Najpierw zaokrąglony punkt planszy, potem przesunięcie: sąsiednie pola mają te same wierzchołki.
		local.append(point.round() - node.position)
	shape.polygon = local
	parent.add_child(node)
	node.owner = board
	node.add_child(shape)
	shape.owner = board


## Punkt w odległości `radius` od środka planszy w kierunku `degrees`.
static func _polar(degrees: float, radius: float) -> Vector2:
	return Vector2.from_angle(deg_to_rad(degrees)) * radius


## Morze Centralne: koło z wierzchołkami co ARC_STEP stopni, od ARC_START.
static func _circle(radius: float) -> PackedVector2Array:
	var points := PackedVector2Array()
	for i in int(360.0 / ARC_STEP):
		points.append(_polar(ARC_START + ARC_STEP * i, radius))
	return points


## Sektor morski: zewnętrzny łuk w jedną stronę, wewnętrzny (wspólny z kołem centralnym) z powrotem.
static func _sector(middle: float) -> PackedVector2Array:
	var steps := int(2.0 * SECTOR_HALF_ANGLE / ARC_STEP)
	var points := PackedVector2Array()
	for i in steps + 1:
		points.append(_polar(middle - SECTOR_HALF_ANGLE + ARC_STEP * i, OUTER_RADIUS))
	for i in steps + 1:
		points.append(_polar(middle + SECTOR_HALF_ANGLE - ARC_STEP * i, INNER_RADIUS))
	return points


## Nieregularna wyspa: wielokąt gwiaździsty wokół środka, więc bez samoprzecięć.
static func _blob(id: String, center: Vector2, radius: float) -> PackedVector2Array:
	var rng := RandomNumberGenerator.new()
	rng.seed = hash(id)
	var phase := rng.randf() * TAU
	var count := 18
	var points := PackedVector2Array()
	for i in count:
		var angle := TAU * i / count
		var wobble := 1.0 + 0.15 * sin(angle * 3.0 + phase) + rng.randf_range(-0.06, 0.06)
		points.append(center + Vector2.from_angle(angle) * radius * wobble)
	return points
