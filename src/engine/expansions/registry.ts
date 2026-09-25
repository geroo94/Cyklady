/**
 * @file Rejestr dodatków i rozsyłanie zdarzeń cyklu.
 *
 * Kolejność dodatków w `EXPANSIONS` jest stała, więc wynik rozesłania
 * zdarzenia jest deterministyczny. Zdarzenie trafia tylko do dodatków
 * włączonych w danej partii (`isEnabled`).
 */

import type { GameState } from '../../model/index.ts';
import { HADES_EXPANSION } from './hades.ts';
import type { CycleEventName, ExpansionModule, UnitsDestroyedEvent } from './module.ts';
import { MONUMENTS_EXPANSION } from './monuments.ts';

export const EXPANSIONS: readonly ExpansionModule[] = [HADES_EXPANSION, MONUMENTS_EXPANSION];

/** Wywołuje obsługę zdarzenia cyklu we wszystkich włączonych dodatkach. */
export function runCycleEvent(
  state: GameState,
  event: CycleEventName,
  modules: readonly ExpansionModule[] = EXPANSIONS,
): GameState {
  return modules.reduce((current, module) => {
    const handler = module.events[event];
    return handler && module.isEnabled(current) ? handler(current) : current;
  }, state);
}

/** Rozsyła informację o zniszczonych zwykłych jednostkach (np. do Nekropolii). */
export function dispatchUnitsDestroyed(
  state: GameState,
  event: UnitsDestroyedEvent,
  modules: readonly ExpansionModule[] = EXPANSIONS,
): GameState {
  return modules.reduce((current, module) => {
    const handler = module.events.unitsDestroyed;
    return handler && module.isEnabled(current) ? handler(current, event) : current;
  }, state);
}

/**
 * Efekty stanowe wszystkich dodatków (np. automatyczne Monumenty).
 * Orkiestrator woła tę funkcję po każdej udanej komendzie gracza. Haki
 * cyklu wołają ją dodatkowo przy wejściu do ACTIONS i END_OF_CYCLE.
 */
export function applyStateBasedEffects(state: GameState): GameState {
  return runCycleEvent(state, 'stateBased');
}
