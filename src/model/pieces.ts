/**
 * @file Encje z tożsamością: herosi i figurki stworów.
 *
 * Tabele encji (`GameState.heroes`, `GameState.creatureFigures`) trzymają
 * wyłącznie dane o SAMEJ encji. Położenie wynika z tego, w której strefie
 * leży jej ID:
 *  - heros: `PlayerState.reserve.heroes`, `LandForce.heroes` na wyspie
 *    albo strona bitwy,
 *  - figurka stwora: `GameState.creatureFigureSupply`, `IslandNode.creatures`
 *    albo `SeaNode.creatures`.
 * `validateGameState` pilnuje, żeby każde ID leżało w dokładnie jednej strefie.
 */

import type { CardId, CreatureFigureId, CreatureKey, HeroId, PlayerId } from './ids.ts';

/** Heros w grze (dodatek Hades). Istnieje od zakupu karty do śmierci herosa. */
export interface HeroState {
  readonly id: HeroId;
  /** Karta, z której kupiono herosa (siła, zdolność: zob. katalog). */
  readonly cardId: CardId;
  /** Czy zdolność herosa została użyta w tym cyklu. Resetowane w END_OF_CYCLE. */
  readonly exhausted: boolean;
}

/** Fizyczna figurka stwora. Istnieje przez całą partię. */
export interface CreatureFigureState {
  readonly id: CreatureFigureId;
  readonly key: CreatureKey;
  /** Gracz sterujący figurką (`null`, gdy figurka jest w zapasie). */
  readonly controllerId: PlayerId | null;
  /** Cykl wystawienia, przydatny dla efektów „do końca cyklu” (`null` w zapasie). */
  readonly placedInCycle: number | null;
}
