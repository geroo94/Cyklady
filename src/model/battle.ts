/**
 * @file Bitwa, czyli kontekst podstanu BATTLE_RESOLUTION.
 *
 * Na czas bitwy jednostki OBU stron schodzą z węzła i są przechowywane
 * w `BattleState`. Dzięki temu każda figurka jest w dokładnie jednym miejscu,
 * a zasada zachowania jednostek obejmuje zapas + planszę + bitwę. Polegli
 * wracają do zapasu od razu, a ocalałych odstawia na planszę krok
 * sprzątania (CLEANUP).
 *
 * Model zapisuje przebieg bitwy (rundy, rozbicie wyników, straty), a wyniki
 * liczy silnik bitwy (`src/engine/combat.ts`).
 */

import type { BattleId, HeroId, IslandId, NodeId, PlayerId, SeaId } from './ids.ts';

/** Miejsce bitwy. Rodzaj bitwy wynika z rodzaju węzła. */
export type BattleLocation =
  | { readonly kind: 'LAND'; readonly islandId: IslandId }
  | { readonly kind: 'SEA'; readonly seaId: SeaId };

/** Rola strony w bitwie. */
export type BattleRole = 'ATTACKER' | 'DEFENDER';

/** Jedna strona bitwy. */
export interface BattleSide {
  readonly playerId: PlayerId;
  /** Oddziały (bitwa lądowa) albo floty (bitwa morska) w kolorze gracza. */
  readonly units: number;
  /** Nieumarłe oddziały albo floty pod dowództwem gracza. */
  readonly undead: number;
  /** Herosi (tylko bitwa lądowa, strefa). */
  readonly heroes: readonly HeroId[];
  /** Dodatkowa stała premia z efektów kart (premie z budynków liczy silnik w każdej rundzie). */
  readonly bonus: number;
  /** Skąd strona przybyła: domyślny kierunek odwrotu atakującego, `null` dla obrońcy. */
  readonly origin: NodeId | null;
}

/**
 * Jeden składnik wyniku z konkretnego źródła: pozycja raportu starcia.
 * Suma `roll + units + Σ modifiers.value` zawsze równa się `total`.
 */
export type ScoreModifier =
  /** Fortece na bronionej wyspie: +1 za każdą. */
  | { readonly source: 'FORTRESS'; readonly islandId: IslandId; readonly value: number }
  /** Porty na wyspie obrońcy przy polu bitwy morskiej: +1 za każdy. */
  | { readonly source: 'PORT'; readonly islandId: IslandId; readonly value: number }
  /** Metropolia liczona jak Forteca (obrona lądu) albo jak Port (obrona morza). */
  | { readonly source: 'METROPOLIS'; readonly islandId: IslandId; readonly countsAs: 'FORTRESS' | 'PORT'; readonly value: number }
  /** Heros w bitwie lądowej: jego siła. */
  | { readonly source: 'HERO'; readonly heroId: HeroId; readonly value: number }
  /** Floty obrońcy z pola wokół wyspy z Portem Wojennym (Monument), liczone jak oddziały. */
  | { readonly source: 'WAR_PORT'; readonly seaId: SeaId; readonly value: number }
  /** Heros atakującego (Ulisses) ignoruje fortyfikacje: wartość ujemna znosi premie Fortec i Metropolii. */
  | { readonly source: 'FORTIFICATIONS_IGNORED'; readonly heroId: HeroId; readonly value: number }
  /** Stała premia strony z efektów kart (`BattleSide.bonus`). */
  | { readonly source: 'CARD_BONUS'; readonly value: number };

/** Składniki wyniku strony w jednej rundzie. */
export interface ScoreBreakdown {
  /** Wynik rzutu kością bitewną. */
  readonly roll: number;
  /** Oddziały albo floty oraz nieumarli. */
  readonly units: number;
  /** Suma siły herosów. */
  readonly heroes: number;
  /** Floty obrońcy wokół wyspy liczone jako oddziały (Monument: Port Wojenny). */
  readonly supportFleets: number;
  /** Fortece i Metropolia (obrona lądu) albo porty (obrona morza). */
  readonly fortifications: number;
  /** Czy premie fortyfikacji obrońcy zostały zignorowane (heros: Ulisses). */
  readonly fortificationsIgnored: boolean;
  /** Stała premia strony (`BattleSide.bonus`). */
  readonly bonus: number;
  readonly total: number;
  /** Raport: premie rozpisane na źródła (Fortece, Porty, herosi, Port Wojenny…). */
  readonly modifiers: readonly ScoreModifier[];
}

/** Kto poległ w rundzie. */
export type Casualty =
  | { readonly kind: 'UNDEAD' }
  | { readonly kind: 'UNIT' }
  | { readonly kind: 'HERO'; readonly heroId: HeroId };

export interface RoundSide {
  readonly score: ScoreBreakdown;
  /** `null`, gdy strona nie poniosła straty. */
  readonly casualty: Casualty | null;
}

/** Zapis jednej rundy starcia. */
export interface BattleRound {
  /** Numer rundy, liczony od 1. */
  readonly round: number;
  readonly attacker: RoundSide;
  readonly defender: RoundSide;
}

/** Na co czeka bitwa. */
export type BattleStep =
  /** Rzut kośćmi i rozstrzygnięcie rundy (automatycznie, po stronie serwera). */
  | 'ROLL'
  /** Obrońca decyduje: walczyć dalej czy się wycofać. */
  | 'DEFENDER_RETREAT_DECISION'
  /** Atakujący decyduje: walczyć dalej czy się wycofać. */
  | 'ATTACKER_RETREAT_DECISION'
  /** Wynik jest znany, więc trzeba odstawić ocalałych na planszę. */
  | 'CLEANUP'
  /** Bitwa zakończona, można wrócić do fazy ACTIONS. */
  | 'FINISHED';

/** Wynik bitwy. */
export type BattleOutcome =
  | { readonly kind: 'ATTACKER_WON' }
  | { readonly kind: 'DEFENDER_WON' }
  | { readonly kind: 'ATTACKER_RETREATED'; readonly to: NodeId }
  | { readonly kind: 'DEFENDER_RETREATED'; readonly to: NodeId }
  /** Obie strony straciły ostatnie jednostki w tej samej rundzie. */
  | { readonly kind: 'MUTUAL_DESTRUCTION' };

export interface BattleState {
  readonly id: BattleId;
  readonly location: BattleLocation;
  readonly attacker: BattleSide;
  readonly defender: BattleSide;
  readonly step: BattleStep;
  readonly rounds: readonly BattleRound[];
  /** Ustawiany razem z przejściem do kroku CLEANUP, obecny też w FINISHED. */
  readonly outcome: BattleOutcome | null;
}

/** Czy strona ma jeszcze jakąkolwiek jednostkę na polu bitwy. */
export function sidePresence(side: BattleSide): number {
  return side.units + side.undead + side.heroes.length;
}
