// Wypełnienie pola planszy (TerritoryNode → wewnętrzny węzeł Fill).
//
// base_color       kolor terenu albo barwa właściciela pola,
// highlight_color  kolor oznaczenia: wybrane pole, cel ruchu, cel ataku, budowa,
// highlight_strength  siła oznaczenia (0 = brak),
// pulse_speed      pulsowanie oznaczenia (0 = stałe; cele ruchu pulsują),
// hover            1 = kursor nad polem (rozjaśnienie).
// Wynik mnożymy przez wejściowy COLOR, więc modulate węzła (przygaszenie pól
// spoza wyboru) nadal działa.
shader_type canvas_item;

uniform vec4 base_color : source_color = vec4(0.84, 0.76, 0.56, 1.0);
uniform vec4 highlight_color : source_color = vec4(1.0);
uniform float highlight_strength : hint_range(0.0, 1.0) = 0.0;
uniform float pulse_speed = 0.0;
uniform float hover : hint_range(0.0, 1.0) = 0.0;

void fragment() {
	float pulse = pulse_speed > 0.0 ? 0.6 + 0.4 * sin(TIME * pulse_speed) : 1.0;
	vec3 color = mix(base_color.rgb, highlight_color.rgb, highlight_strength * pulse);
	color += vec3(0.14) * hover;
	COLOR = vec4(color, base_color.a) * COLOR;
}
