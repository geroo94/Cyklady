/**
 * @file Stan gracza.
 *
 * Model rozróżnia dwa poziomy:
 *
 * 1. `PlayerState` to dane PRZECHOWYWANE, czyli to, co należy wyłącznie do
 *    gracza i leży „przed nim na stole”: złoto, żetony, zapas figurek,
 *    przedmioty.
 *
 * 2. `PlayerView` to dane WYLICZANE (projekcja, zob. `selectors.ts`): wszystko
 *    o graczu, co fizycznie leży gdzie indziej. Jednostki i herosi stoją na
 *    planszy, znacznik ofiary leży na torze bogów, a znacznik kolejności na
 *    torze kolejności.
 *
 * Zasada jednego źródła prawdy: ta sama informacja nie jest zapisana w dwóch
 * miejscach. Dlatego nie da się zbudować stanu, w którym gracz „ma” herosa
 * stojącego jednocześnie na dwóch wyspach albo licytuje boga, na którego
 * polu leży cudzy znacznik.
 */

import type { BiddableGod, PlayerColor } from './domain.ts';
import type { HeroId, IslandId, MagicItemId, PlayerId } from './ids.ts';

/** Posiadany egzemplarz magicznego przedmiotu. */
export interface OwnedMagicItem {
  readonly itemId: MagicItemId;
  /** Pozostałe użycia. `null` oznacza przedmiot trwały. */
  readonly usesLeft: number | null;
}

/**
 * Zapas gracza, czyli jego figurki poza planszą.
 * Zasada zachowania: zapas + plansza + bitwa = `rules.troopsPerPlayer`
 * (analogicznie dla flot). Sprawdza to `validateGameState`.
 */
export interface PlayerReserve {
  readonly troops: number;
  readonly fleets: number;
  /** Herosi kupieni, ale jeszcze niewystawieni na wyspę (strefa). */
  readonly heroes: readonly HeroId[];
}

/** Dane przechowywane gracza. */
export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string;
  readonly color: PlayerColor;

  /**
   * Złoto (JZ). W wersji fizycznej leży za zasłonką. W wersji sieciowej
   * widoczność dla innych graczy ustala projekcja stanu po stronie serwera.
   */
  readonly gold: number;
  /**
   * Filozofowie (dar Ateny). Po zebraniu `rules.philosophersPerMetropolis`
   * od razu zamieniają się w Metropolię, więc w stanie stabilnym jest ich mniej.
   */
  readonly philosophers: number;
  /** Kapłani (dar Zeusa). Każdy obniża koszt ofiary w licytacji. */
  readonly priests: number;
  /** Kapłanki (dodatek). Ich efekt definiuje silnik zasad. */
  readonly priestesses: number;

  /** Magiczne przedmioty w ręce gracza (strefa). */
  readonly magicItems: readonly OwnedMagicItem[];
  /** Figurki i herosi poza planszą (strefa). */
  readonly reserve: PlayerReserve;
}

// ---------------------------------------------------------------------------
// Projekcja (dane wyliczane, NIE przechowywane)
// ---------------------------------------------------------------------------

/** Liczebność jednej kategorii jednostek. */
export interface UnitCount {
  readonly onBoard: number;
  /** Jednostki biorące udział w trwającej bitwie. */
  readonly inBattle: number;
  readonly inReserve: number;
}

/** Wszystkie jednostki gracza (oddziały, floty, nieumarli). */
export interface PlayerUnitsSummary {
  readonly troops: UnitCount;
  readonly fleets: UnitCount;
  /**
   * Nieumarli są neutralną pulą dodatku Hades. Gracz tylko nimi dowodzi,
   * więc nie mają zapasu w jego kolorze (`inReserve` = 0).
   */
  readonly undeadTroops: UnitCount;
  readonly undeadFleets: UnitCount;
}

/** Miejsce znacznika ofiary gracza na torze bogów. */
export type PlayerOffering =
  | { readonly kind: 'GOD'; readonly god: BiddableGod; readonly amount: number }
  | { readonly kind: 'APOLLO'; readonly arrivalIndex: number };

/** Rozbicie dochodu gracza w fazie INCOME. */
export interface IncomeBreakdown {
  /** Znaczniki dobrobytu na wyspach: nadrukowane + dodatkowe. */
  readonly islands: number;
  /** Pola handlowe na morzu kontrolowane flotą. */
  readonly tradeRoutes: number;
  /** JZ zebrane na Nekropoliach na wyspach gracza (dodatek Hades). */
  readonly necropolis: number;
  readonly total: number;
}

/** Pełny widok gracza dla UI i silnika zasad. */
export interface PlayerView {
  readonly state: PlayerState;
  readonly units: PlayerUnitsSummary;
  /** Wszyscy herosi gracza: w zapasie, na planszy i w bitwie. */
  readonly heroes: readonly HeroId[];
  /** Pozycja w licytacji: gdzie leżą znaczniki ofiary (pusta lista = brak ofiary). */
  readonly offerings: readonly PlayerOffering[];
  /** Pozycje na torze kolejności w bieżącym cyklu (0 = licytuje pierwszy). */
  readonly turnOrderPositions: readonly number[];
  readonly islands: readonly IslandId[];
  readonly metropolises: number;
  readonly expectedIncome: IncomeBreakdown;
}
