## Ekran „Gry w sieci lokalnej”: lista gier z ogłoszeń UDP (LanListener),
## tworzenie gry LAN, dołączanie do wybranej gry i łączenie przez IP.
##
## Kontroler nie prowadzi połączeń sam: woła NetworkManager. O przejściu do
## poczekalni i partii decyduje scena główna na podstawie sygnałów
## NetworkManager (server_started, connection_succeeded) i GameStateManager (view_changed).
extends VBoxContainer

## Skrypt NetworkManagera jako typ: stałe i funkcje statyczne wołamy na typie, a nie na autoloadzie.
const Network := preload("res://scripts/autoload/NetworkManager.gd")

## Port gry dla „Stwórz Grę LAN”.
@export var game_port := Network.DEFAULT_PORT

@onready var _listener: LanListener = $LanListener
@onready var _list: ItemList = %ServerList
@onready var _name_edit: LineEdit = %NameEdit
@onready var _server_name_edit: LineEdit = %ServerNameEdit
@onready var _address_edit: LineEdit = %AddressEdit
@onready var _status: Label = %StatusLabel

## Klucze serwerów („ip:port”) w kolejności pozycji na liście i ich ostatnie ogłoszenia.
var _keys := PackedStringArray()
var _infos: Dictionary = {}


func _ready() -> void:
	# Odbiornik ogłoszeń → lista gier.
	_listener.server_found.connect(_on_servers_changed)
	_listener.server_updated.connect(_on_servers_changed)
	_listener.server_lost.connect(_on_servers_changed)
	_list.item_selected.connect(func(_index: int) -> void: _update_join_button())
	_list.item_activated.connect(func(_index: int) -> void: _on_join_pressed())  # dwuklik = dołącz
	# Przyciski → NetworkManager.
	%JoinButton.pressed.connect(_on_join_pressed)
	%CreateButton.pressed.connect(_on_create_pressed)
	%DirectButton.pressed.connect(_on_direct_pressed)
	_address_edit.text_submitted.connect(func(_text: String) -> void: _on_direct_pressed())
	%SingleButton.pressed.connect(_on_single_pressed)
	NetworkManager.connection_failed.connect(func(code: String, message: String) -> void: _set_status("%s (%s)" % [message, code]))
	# Nasłuch tylko wtedy, gdy ekran jest widoczny (w partii port UDP jest wolny).
	visibility_changed.connect(_on_visibility_changed)
	_refresh()
	_report_listener()


# =============================================================================
# Lista gier
# =============================================================================

func _on_servers_changed(_info: Dictionary) -> void:
	if is_inside_tree():
		_refresh()


## Odbudowuje listę z zachowaniem zaznaczenia. Gier trwających i pełnych nie da się wybrać.
func _refresh() -> void:
	var selected := _selected_key()
	_list.clear()
	_keys.clear()
	_infos.clear()
	for info: Dictionary in _listener.servers():
		var index := _list.add_item(describe_server(info))
		_list.set_item_tooltip(index, "%s:%d" % [info["address"], info["port"]])
		var joinable: bool = not info["in_game"] and info["current_players"] < info["max_players"]
		_list.set_item_disabled(index, not joinable)
		_keys.append(info["key"])
		_infos[info["key"]] = info
		if info["key"] == selected and joinable:
			_list.select(index)
	%SearchLabel.visible = _keys.is_empty()
	_update_join_button()


## Opis pozycji na liście, np. „Archipelag · 2/5 graczy · Hades · 192.168.1.20:8910”.
static func describe_server(info: Dictionary) -> String:
	var modules := PackedStringArray()
	if info["has_hades"]:
		modules.append("Hades")
	if info["has_monuments"]:
		modules.append("Monumenty")
	var parts := PackedStringArray([
		String(info["server_name"]),
		"%d/%d graczy" % [info["current_players"], info["max_players"]],
		", ".join(modules) if not modules.is_empty() else "podstawka",
	])
	if info["in_game"]:
		parts.append("partia trwa")
	parts.append("%s:%d" % [info["address"], info["port"]])
	return " · ".join(parts)


func _selected_key() -> String:
	var items := _list.get_selected_items()
	return _keys[items[0]] if items.size() > 0 and items[0] < _keys.size() else ""


func _update_join_button() -> void:
	%JoinButton.disabled = _selected_key() == ""


# =============================================================================
# Akcje
# =============================================================================

func _on_join_pressed() -> void:
	var key := _selected_key()
	if key == "":
		return
	var info: Dictionary = _infos[key]
	_connect_to(String(info["address"]), int(info["port"]), "Łączenie z grą „%s”…" % info["server_name"])


func _on_direct_pressed() -> void:
	var address := Network.parse_address(_address_edit.text)
	if address.is_empty():
		_set_status("Niepoprawny adres. Przykład: 192.168.1.20 albo 192.168.1.20:%d" % Network.DEFAULT_PORT)
		return
	_connect_to(address["host"], address["port"], "Łączenie z %s:%d…" % [address["host"], address["port"]])


func _on_create_pressed() -> void:
	var options := {
		"server_name": _server_name_edit.text,
		"hades": (%HadesCheck as CheckBox).button_pressed,
		"monuments": (%MonumentsCheck as CheckBox).button_pressed,
	}
	var error := NetworkManager.host_game(_player_name(), game_port, options)
	if error != OK:
		_set_status("Nie można utworzyć gry na porcie %d: %s." % [game_port, error_string(error)])


func _on_single_pressed() -> void:
	var error := NetworkManager.start_single_player(_player_name(), 2)
	if error != OK:
		_set_status("Nie można uruchomić gry solo: %s." % error_string(error))


func _connect_to(host: String, port: int, message: String) -> void:
	var error := NetworkManager.join_game(host, port, _player_name())
	if error != OK:
		_set_status("Nie można połączyć się z %s:%d: %s." % [host, port, error_string(error)])
		return
	_set_status(message)


# =============================================================================
# Pomocnicze
# =============================================================================

func _on_visibility_changed() -> void:
	if is_visible_in_tree():
		_listener.start()
		_report_listener()
	else:
		_listener.stop()


func _report_listener() -> void:
	if _listener.is_listening():
		_set_status("Szukam gier w sieci lokalnej (UDP %d)…" % _listener.bound_port)
	else:
		_set_status("Nasłuch gier LAN jest niedostępny (zajęte porty UDP). Użyj „Połącz przez IP”.")


func _player_name() -> String:
	var player_name := _name_edit.text.strip_edges()
	return player_name if player_name != "" else "Gracz"


func _set_status(text: String) -> void:
	_status.text = text
