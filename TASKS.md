# Cyklady: plan prac

Checklista prac nad wersją cyfrową (podstawka + Hades + Monumenty). Powstała
z [ARCHITEKTURA.md](ARCHITEKTURA.md) („Następne kroki”, „Założenia do
weryfikacji”), [SIEC.md](SIEC.md) (rozdział 12), [NAWIGACJA.md](NAWIGACJA.md)
i [godot/README.md](godot/README.md) (rozdział 10 „Uproszczenia”).

- `[x]`: zrobione i pokryte testami, `[ ]`: do zrobienia.
- **TS** to silnik referencyjny w `src/` (`npm run check`), **Godot** to gra
  w `godot/` (`godot --headless --path godot res://tests/RunTests.tscn`).
- Nowa reguła powstaje najpierw w TS (czyste funkcje, testy), potem trafia do
  Godota jako metoda `apply_*` w `GameStateManager` z parą RPC w `NetworkManager`.
- `[zweryfikuj]` oznacza wartość roboczą, którą trzeba potwierdzić w instrukcji.

## 0. Repozytorium i struktura katalogów

- [x] **Repozytorium na GitHubie**: `.gitignore` (node_modules, `.godot/`, pliki systemowe), `origin` → github.com/geroo94/Cyklady
- [x] **Szkielet katalogów Godot**: `assets/` (textures, audio, fonts), `scenes/` (main_menu, lobby, board, ui), `scripts/` (autoload, core, ai), `resources/` (cards, monuments)
- [ ] **Przeniesienie istniejących plików do nowej struktury**. Dziś kod leży w starym układzie, opisanym w godot/README.md:

  | Dziś | Docelowo |
  |---|---|
  | `autoload/` (GameStateManager, NetworkManager) | `scripts/autoload/` |
  | `rules/` (BidRules, MoveRules, ArchipelagoMap) | `scripts/core/` |
  | `lan/` (LanBeacon, LanListener) | `scripts/core/` albo nowy `scripts/net/` |
  | `board/` | `scenes/board/` |
  | `bidding/` | `scenes/ui/` |
  | `scenes/LanLobby.tscn`, `lan_lobby.gd` | `scenes/lobby/` |
  | `scenes/Main.tscn`, `main.gd` | `scenes/main_menu/` (po wydzieleniu menu, zob. rozdział 5) |
  | AI z GameStateManager (`_ai_bid`, `_ai_act`) | `scripts/ai/` |

  - Przenosić w doku FileSystem edytora Godota, bo edytor poprawia wtedy ścieżki w scenach.
  - Ręcznie trzeba poprawić ścieżki `res://` wpisane w 8 skryptach (lista: `grep -rn "res://" --include='*.gd' godot`), sekcje `[application]` i `[autoload]` w `project.godot` oraz ścieżki w ARCHITEKTURA.md i godot/README.md.
  - Klasy z `class_name` (BidRules, MoveRules, TerritoryNode…) działają po nazwie, więc ich przeniesienie nie psuje odwołań.
  - Warunek odbioru: wszystkie testy Godot przechodzą.

## 1. Logika stanu gry i licytacja

Zrobione:

- [x] **Model stanu (TS)**: gracze, graf planszy, tory i talie, niezmienniki, maszyna stanów faz ze strażnikami (`src/model/`)
- [x] **Silnik licytacji (TS)**: ofiary, przebicie z zakazem powrotu, Apollo, zniżka kapłanów, rozliczenie (`src/engine/bidding.ts`)
- [x] **Ruch i bitwa (TS)**: floty (zasięg 3), wojska po moście z flot, reguła ostatniej wyspy, bitwa z odwrotami i raportem modyfikatorów
- [x] **Dodatki jako moduły cyklu (TS)**: Hades (Kolumna Hadesa, nieumarli, Nekropolie) i Monumenty (rozdanie kart, automatyczne stawianie)
- [x] **Stan gry w Godot**: `GameStateManager` z licytacją, ruchem, budową, bitwą bez odwrotów, dochodem i końcem cyklu
- [x] **Reguły wspólne serwera i UI (Godot)**: `BidRules`, `MoveRules`, `ArchipelagoMap`

Do zrobienia:

- [x] **Szkielet bazy danych gry**: `godot/scripts/autoload/GameData.gd` (autoload) z bogami, stworami i herosami oraz Monumentami, walidatorem i testem spójności z regułami serwera
- [ ] **Dary bogów i rekrutacja (TS, potem Godot)**: floty (Posejdon), oddziały (Ares), kapłani (Zeus), filozofowie (Atena). Rosnące koszty w turze i limit na turę `[zweryfikuj]`
- [ ] **Tura Apolla**: dochód, znacznik dobrobytu, premia dla pierwszego gracza u Apolla `[zweryfikuj]`
- [ ] **Zakup stworów i efekty kart**: tor 2/3/4 JZ, zniżka ze Świątyń, efekty według klucza `effect`. W TS jest dziś tylko Gigant, a `BUY_CREATURE` zwraca `UNSUPPORTED_ACTION`
- [ ] **Herosi (Hades)**: zakup z toru stworów, siła w bitwie lądowej, zdolności (Ulisses już działa w bitwie TS)
- [ ] **Metropolie i koniec gry w Godot**: Metropolia z 4 filozofów albo z kompletu budynków, zwycięstwo po 2 Metropoliach
- [ ] **Odwroty w bitwie (Godot)**: decyzje obrońcy i atakującego po każdej rundzie. Dziś bitwa w Godot toczy się do rozstrzygnięcia
- [ ] **Hades w Godot**: rzut na Kolumnę Hadesa, Hades na torze licytacji, rekrutacja nieumarłych, Nekropolie, powrót nieumarłych do puli na koniec cyklu
- [ ] **Monumenty w Godot**: rozdanie kart, automatyczne stawianie figurki, efekty w bitwie (Wielka Cytadela Aresa, Port Wojenny)
- [ ] **Wariant 2-osobowy**: liczba bogów w cyklu i 2 znaczniki ofiary na gracza
- [ ] **Weryfikacja założeń z instrukcją**: wszystkie `[zweryfikuj]` z ARCHITEKTURA.md i NAWIGACJA.md (złoto startowe, bogowie wg liczby graczy, tor stworów, parametry Hadesa, zasady Monumentów, Teatr, koszt ruchu) oraz wartości w `GameData.gd`

## 2. Dane gry

- [ ] **Pełny katalog z pudełka**: wszystkie stwory (kopie, figurki), herosi, Monumenty i magiczne przedmioty. Dziś TS i Godot mają tylko katalog przykładowy
  - Do rozważenia: jedno źródło danych (np. JSON w `godot/resources/cards/`) czytane przez TS i Godota, zamiast dwóch ręcznie zgodnych kopii.
- [ ] **GameData w regułach Godot**: `GameStateManager` i `MoveRules` biorą bogów i budynki z `GameData` zamiast z własnych stałych
- [ ] **Mapy dla 2–5 graczy**: dziś są tylko „Archipelag” i mapa przykładowa, a wybór mapy w lobby nie istnieje
- [ ] **Zasoby `.tres`**: karty w `resources/cards/`, Monumenty w `resources/monuments/` (ilustracja, ikona, opis), gdy będą grafiki

## 3. Sieć LAN (ENet / UDP)

Zrobione:

- [x] **Serwer autorytatywny na ENet (Godot)**: RPC z tożsamością z połączenia, projekcja stanu na gracza, klienci bez przekazywania RPC między sobą
- [x] **Wykrywanie gier przez UDP broadcast**: `LanBeacon` i `LanListener`, porty 45454–45457, walidacja pakietów, wygasanie po 4 s
- [x] **„Połącz przez IP”** i odczyt adresu (`parse_address`)
- [x] **Rozłączenia**: `peer_timeout_ms` 10 s, okno powrotu 60 s z pełną migawką, przejęcie miejsca przez AI
- [x] **Single Player** na loopbacku (porty 8911–8915), bez ogłoszeń LAN
- [x] **Protokół referencyjny (TS)**: lobby, JSON Patch, ChaCha20, zegar tury, WebSocket (SIEC.md)

Do zrobienia:

- [ ] **RPC dla nowych akcji**: para RPC i walidacja na serwerze dla każdej nowej metody `apply_*` (rekrutacja, stwory, tura Hadesa, odwrót)
- [ ] **Zegar tury w Godot**: limity czasu decyzji i ruch pasywny, tak jak `src/net/turnClock.ts`
- [ ] **Lobby w Godot**: wybór koloru i miasta, gotowość graczy (jak `Room.handleLobby` w TS). Dziś kolory przydziela kolejność przy stole
- [ ] **Test w prawdziwej sieci**: 2–3 komputery, zapora (host: UDP 8910, gracze: UDP 45454–45457), Wi-Fi z izolacją klientów
- [ ] **Limit liczby wiadomości na sekundę** na połączenie
- [ ] **Sprawdzalne rzuty**: skrót klucza na starcie partii, klucz po jej końcu
- [ ] **Zapis partii i powtórki**: klucz i dziennik intencji
- [ ] **Tryb obserwatora**: połączenie bez miejsca przy stole
- [ ] **Ogłoszenia w sieciach IPv6** (multicast)

## 4. AI

- [x] **Prosta AI (Godot)**: pierwszy wolny bóg za 1 JZ albo Apollo, potem koniec tury
- [ ] **Moduł AI w `scripts/ai/`**: wydzielony z `GameStateManager`, grający na tej samej projekcji i przez te same `apply_*` co człowiek
- [ ] **AI z prawdziwą strategią**: licytacja według potrzeb (floty, wojska, Metropolia), ruchy, zakup stworów, poziomy trudności

## 5. Interfejs użytkownika

Zrobione:

- [x] **Ekran „Gry w sieci lokalnej”** (`LanLobby.tscn`): lista gier, dołączenie, nowa gra LAN, „Połącz przez IP”, gra solo
- [x] **Plansza „Archipelag”**: pola `TerritoryNode` z shaderem, wybór, podświetlanie ruchów zgodne z serwerem
- [x] **Panel licytacji**: tory ofiar, kolejka Apolla, koszt z kapłanami, przebicie z animacją i dźwiękiem

Do zrobienia:

- [ ] **Menu główne** (`scenes/main_menu/`): gra solo, gra LAN, ustawienia, wyjście. Dziś `Main.tscn` łączy menu, poczekalnię i grę
- [ ] **Poczekalnia** (`scenes/lobby/`): gracze, kolory, miasta, dodatki, gotowość, start
- [ ] **Panel gracza** (`scenes/ui/`): złoto, kapłani, filozofowie, dochód, karta Monumentu
- [ ] **Tura boga**: przyciski rekrutacji i budowy właściwe dla boga (dane z `GameData`)
- [ ] **Tor stworów**: karty na polach 2/3/4 JZ, zakup i wybór celu efektu
- [ ] **Okno bitwy**: raport rundy, rzut, decyzja o odwrocie
- [ ] **Ekran końca gry**
- [ ] **Grafika, dźwięk i czcionki** (`assets/`): czcionka z symbolami ⚔ ☠ ⚓ ★, których nie ma wbudowana czcionka Godota (dziś etykiety planszy używają liter i `†`)
- [ ] **Tłumaczenia**: nazwy z `GameData` jako klucze tłumaczeń
- [ ] **Zapamiętanie gracza**: imię, ostatni host i żeton powrotu w `ConfigFile` w `user://`

## 6. Jakość i wydanie

- [x] **Testy**: TS (`npm run check`) i Godot bez okna (`tests/RunTests.tscn`)
- [ ] **CI na GitHub Actions**: `npm run check` i testy Godot bez okna przy każdym pushu
- [ ] **Eksport** na macOS, Windows i Linux (`export_presets.cfg`) oraz instrukcja zapory dla ENet i UDP
- [ ] **Prawa do treści**: repozytorium jest publiczne, więc przed dodaniem grafik lub tekstów z pudełka trzeba sprawdzić, co wolno opublikować
