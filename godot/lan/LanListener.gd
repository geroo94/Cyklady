## LanListener: nasłuch ogłoszeń gier LAN (ekran „Gry w sieci lokalnej”).
##
## Słucha na pierwszym wolnym porcie z LanBeacon.DISCOVERY_PORTS (domyślnie
## 45454), odczytuje pakiety JSON i prowadzi listę serwerów:
##   server_found(info)    nowy serwer w sieci,
##   server_updated(info)  zmiana u znanego serwera (np. liczba graczy, start partii),
##   server_lost(info)     serwer nie ogłosił się przez `lost_after_sec` (domyślnie 4 s).
##
## `info` to słownik: key ("ip:port"), address (IP nadawcy z nagłówka UDP),
## port (port gry), server_name, current_players, max_players, has_hades,
## has_monuments, in_game, last_seen (Time.get_ticks_msec()).
##
## Ogłoszenia nie są uwierzytelnione (to zaufana sieć lokalna). Nasłuch sprawdza
## więc każde pole, pomija obce i uszkodzone pakiety oraz ogranicza rozmiar
## pakietu i liczbę zapamiętanych serwerów.
class_name LanListener
extends Node

signal server_found(server_info: Dictionary)
signal server_updated(server_info: Dictionary)
signal server_lost(server_info: Dictionary)

## Porty, na których można słuchać (pierwszy wolny wygrywa).
@export var discovery_ports: Array[int] = LanBeacon.DISCOVERY_PORTS
## Po tylu sekundach bez ogłoszenia serwer znika z listy.
@export var lost_after_sec := 4.0
## Najwięcej zapamiętanych serwerów (ochrona przed zalewem ogłoszeń).
@export var max_servers := 64
## Czy zacząć nasłuch od razu po dodaniu do drzewa.
@export var autostart := true

## Port, na którym nasłuch faktycznie działa (0: nasłuch wyłączony).
var bound_port := 0

var _udp: PacketPeerUDP
var _servers: Dictionary = {}


func _ready() -> void:
	if autostart:
		start()


func _exit_tree() -> void:
	# Węzeł znika razem ze sceną: bez sygnałów do rodzica, który też jest zwalniany.
	_close()
	_servers.clear()


## Nasłuch na pierwszym wolnym porcie z zakresu. ERR_UNAVAILABLE: wszystkie zajęte.
func start() -> Error:
	stop()
	for port in discovery_ports:
		var udp := PacketPeerUDP.new()
		if udp.bind(port, "*") == OK:
			_udp = udp
			bound_port = port
			return OK
	return ERR_UNAVAILABLE


## Koniec nasłuchu. Znane serwery znikają z listy (każdy z sygnałem server_lost).
func stop() -> void:
	_close()
	var known := _servers.values()
	_servers.clear()
	for info in known:
		server_lost.emit(info)


func is_listening() -> bool:
	return _udp != null


func _close() -> void:
	if _udp != null:
		_udp.close()
		_udp = null
	bound_port = 0


## Aktualna lista serwerów, posortowana po nazwie gry, a potem po adresie.
func servers() -> Array:
	var list := _servers.values()
	list.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		var by_name := String(a["server_name"]).naturalnocasecmp_to(String(b["server_name"]))
		return by_name < 0 if by_name != 0 else String(a["key"]) < String(b["key"]))
	return list


func _process(_delta: float) -> void:
	if _udp == null:
		return
	while _udp.get_available_packet_count() > 0:
		var packet := _udp.get_packet()
		handle_packet(packet, _udp.get_packet_ip())
	_forget_silent_servers()


## Obsługa jednego pakietu od `sender_ip` (publiczna, żeby dało się ją testować bez sieci).
func handle_packet(packet: PackedByteArray, sender_ip: String) -> void:
	var info := decode(packet)
	if info.is_empty() or not sender_ip.is_valid_ip_address():
		return
	var key := "%s:%d" % [sender_ip, info["port"]]
	var previous: Dictionary = _servers.get(key, {})
	if previous.is_empty() and _servers.size() >= max_servers:
		return
	info["key"] = key
	info["address"] = sender_ip
	info["last_seen"] = Time.get_ticks_msec()
	_servers[key] = info
	if previous.is_empty():
		server_found.emit(info)
	elif _changed(previous, info):
		server_updated.emit(info)


## Odczyt pakietu: opis gry albo pusty słownik dla obcych i uszkodzonych danych.
static func decode(packet: PackedByteArray) -> Dictionary:
	# Szybkie odrzucenie: pakiet musi wyglądać jak obiekt JSON i mieścić się w limicie.
	if packet.size() < 2 or packet.size() > LanBeacon.MAX_PACKET_BYTES or packet[0] != 0x7b:
		return {}
	var json := JSON.new()
	if json.parse(packet.get_string_from_utf8()) != OK or typeof(json.data) != TYPE_DICTIONARY:
		return {}
	var data: Dictionary = json.data
	if data.get("game") != LanBeacon.GAME_ID or not _is_int_in(data.get("v"), LanBeacon.PROTOCOL_VERSION, LanBeacon.PROTOCOL_VERSION):
		return {}
	var server_name: Variant = data.get("server_name")
	if typeof(server_name) != TYPE_STRING or String(server_name).strip_edges().is_empty() or String(server_name).length() > LanBeacon.MAX_NAME_LENGTH:
		return {}
	if not _is_int_in(data.get("port"), 1, 65535) or not _is_int_in(data.get("max_players"), 1, 16):
		return {}
	if not _is_int_in(data.get("current_players"), 0, int(data["max_players"])):
		return {}
	for flag in ["has_hades", "has_monuments", "in_game"]:
		if typeof(data.get(flag)) != TYPE_BOOL:
			return {}
	return {
		"server_name": String(server_name).strip_edges(),
		"port": int(data["port"]),
		"current_players": int(data["current_players"]),
		"max_players": int(data["max_players"]),
		"has_hades": data["has_hades"],
		"has_monuments": data["has_monuments"],
		"in_game": data["in_game"],
	}


## Liczba całkowita z przedziału. JSON w Godot zwraca liczby jako float, więc sprawdzamy też część ułamkową.
static func _is_int_in(value: Variant, minimum: int, maximum: int) -> bool:
	if typeof(value) != TYPE_FLOAT and typeof(value) != TYPE_INT:
		return false
	var number := float(value)
	return number == floorf(number) and number >= minimum and number <= maximum


static func _changed(previous: Dictionary, current: Dictionary) -> bool:
	for field in ["server_name", "current_players", "max_players", "has_hades", "has_monuments", "in_game"]:
		if previous[field] != current[field]:
			return true
	return false


func _forget_silent_servers() -> void:
	var deadline := Time.get_ticks_msec() - int(lost_after_sec * 1000.0)
	for key in _servers.keys():
		if int(_servers[key]["last_seen"]) < deadline:
			var info: Dictionary = _servers[key]
			_servers.erase(key)
			server_lost.emit(info)
