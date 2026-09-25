## LanBeacon: ogłasza grę LAN w sieci lokalnej pakietami UDP broadcast (PacketPeerUDP).
##
## Co `interval_sec` (domyślnie 1,5 s) wysyła na 255.255.255.255 mały pakiet JSON:
##   { "game": "cyklady", "v": 1, "server_name": "Archipelag", "port": 8910,
##     "current_players": 2, "max_players": 5, "has_hades": true,
##     "has_monuments": false, "in_game": false }
##
## Adresu serwera nie ma w pakiecie. Odbiorca bierze go z nagłówka UDP (adres
## nadawcy), więc host nie musi znać własnego IP w sieci.
##
## Dwa szczegóły praktyczne:
##  - Pakiet idzie na cały zakres DISCOVERY_PORTS. PacketPeerUDP nie pozwala dwóm
##    programom słuchać na jednym porcie, więc druga instancja gry na tym samym
##    komputerze słucha na kolejnym porcie z zakresu i też widzi ogłoszenia.
##  - Poza 255.255.255.255 pakiet idzie też na adresy x.y.z.255 lokalnych
##    interfejsów (założenie: typowa sieć domowa /24). Ogólny broadcast na macOS
##    i Windows wychodzi zwykle tylko domyślnym interfejsem, np. z pominięciem
##    Wi-Fi, gdy aktywne jest też połączenie kablowe albo VPN.
class_name LanBeacon
extends Node

const GAME_ID := "cyklady"
const PROTOCOL_VERSION := 1
## Port ogłoszeń i porty zapasowe dla kolejnych instancji gry na jednym komputerze.
const DISCOVERY_PORTS: Array[int] = [45454, 45455, 45456, 45457]
## Ogłoszenie mieści się w jednym małym datagramie.
const MAX_PACKET_BYTES := 1024
const MAX_NAME_LENGTH := 64

## Odstęp między ogłoszeniami w sekundach.
@export var interval_sec := 1.5
## Porty, na które idzie każde ogłoszenie.
@export var discovery_ports: Array[int] = DISCOVERY_PORTS
## Adresy docelowe. Domyślnie ogólny broadcast; testy podają np. 127.0.0.1.
@export var targets: PackedStringArray = PackedStringArray(["255.255.255.255"])
## Czy wysyłać też na x.y.z.255 prywatnych adresów IPv4 tego komputera.
@export var subnet_broadcasts := true

## Źródło opisu gry wołane przy każdym ogłoszeniu (zawsze aktualna liczba graczy).
## Zwraca słownik z polami: server_name, port, current_players, max_players,
## has_hades, has_monuments, in_game.
var info_provider: Callable

var _udp: PacketPeerUDP
var _timer: Timer


## Rozpoczyna ogłaszanie. Pierwsze ogłoszenie wychodzi od razu.
func start(provider: Callable) -> Error:
	stop()
	info_provider = provider
	var udp := PacketPeerUDP.new()
	udp.set_broadcast_enabled(true)
	var error := udp.bind(0)  # losowy port nadawcy
	if error != OK:
		return error
	_udp = udp
	_timer = Timer.new()
	_timer.wait_time = interval_sec
	_timer.timeout.connect(announce_now)
	add_child(_timer)
	_timer.start()
	announce_now()
	return OK


func stop() -> void:
	if _timer != null:
		_timer.queue_free()
		_timer = null
	if _udp != null:
		_udp.close()
		_udp = null


func is_running() -> bool:
	return _udp != null


## Wysyła ogłoszenie od razu (np. po dołączeniu gracza), bez czekania na kolejny takt.
func announce_now() -> void:
	if _udp == null or not info_provider.is_valid():
		return
	var packet := encode(info_provider.call())
	if packet.is_empty():
		return
	for address in _destinations():
		for port in discovery_ports:
			_udp.set_dest_address(address, port)
			# Błąd wysyłki (np. chwilowy brak sieci) pomijamy: kolejne ogłoszenie za chwilę.
			_udp.put_packet(packet)


## Pakiet ogłoszenia z opisu gry (pusty, gdy nie mieści się w limicie rozmiaru).
static func encode(info: Dictionary) -> PackedByteArray:
	var payload := {
		"game": GAME_ID,
		"v": PROTOCOL_VERSION,
		"server_name": String(info.get("server_name", "Cyklady")).left(MAX_NAME_LENGTH),
		"port": int(info.get("port", 0)),
		"current_players": int(info.get("current_players", 0)),
		"max_players": int(info.get("max_players", 0)),
		"has_hades": bool(info.get("has_hades", false)),
		"has_monuments": bool(info.get("has_monuments", false)),
		"in_game": bool(info.get("in_game", false)),
	}
	var packet := JSON.stringify(payload).to_utf8_buffer()
	return packet if packet.size() <= MAX_PACKET_BYTES else PackedByteArray()


func _destinations() -> PackedStringArray:
	var result := PackedStringArray(targets)
	if not subnet_broadcasts:
		return result
	for address in IP.get_local_addresses():
		if not _is_private_ipv4(address):
			continue
		var parts := address.split(".")
		var broadcast := "%s.%s.%s.255" % [parts[0], parts[1], parts[2]]
		if not result.has(broadcast):
			result.append(broadcast)
	return result


## Adres z puli prywatnej IPv4 (10/8, 172.16/12, 192.168/16): tylko tam ma sens broadcast podsieci.
static func _is_private_ipv4(address: String) -> bool:
	if not address.is_valid_ip_address() or address.contains(":"):
		return false
	var parts := address.split(".")
	var a := parts[0].to_int()
	var b := parts[1].to_int()
	return a == 10 or (a == 172 and b >= 16 and b <= 31) or (a == 192 and b == 168)


func _exit_tree() -> void:
	stop()
