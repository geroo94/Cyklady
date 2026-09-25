/**
 * @file Zdarzenia cyklu gry: zasady podstawowe faz automatycznych i wpięcie dodatków.
 *
 * Maszyna stanów (model) wywołuje haki `onEnter` i `onExit`.
 * `createCycleHooks` składa je według jednej zasady: najpierw podstawka,
 * potem dodatki w kolejności z rejestru.
 *
 *   moment                        podstawka                       dodatki (zdarzenie)
 *   ────────────────────────────  ──────────────────────────────  ─────────────────────────────────
 *   wyjście z INIT                –                               gameStart: rozdanie Monumentów
 *   wejście do CREATURES_REFRESH  odświeżenie toru stworów        –
 *   wejście do GODS_SETUP         losowanie bogów na tor          godsRevealed: Kolumna Hadesa
 *   wejście do INCOME             dochód (także z Nekropolii)     incomeCollected: zerowanie Nekropolii
 *   wejście do ACTIONS            –                               stateBased (też po powrocie z bitwy)
 *   wejście do END_OF_CYCLE       –                               stateBased, cycleEnd: znikanie nieumarłych
 *
 * Wywołujący przekazuje te haki do `transition`, `closeBidding`
 * i `stepBattle` / `runBattle`.
 */

import {
  RANDOMIZED_GODS,
  expectedIncome,
  getPlayer,
  refreshCreatureMarket,
  shuffle,
  type GameState,
  type IncomeBreakdown,
  type PhaseHooks,
  type PlayerId,
} from '../model/index.ts';
import type { ExpansionModule } from './expansions/module.ts';
import { EXPANSIONS, runCycleEvent } from './expansions/registry.ts';

/** CREATURES_REFRESH: przesunięcie toru stworów i dobranie kart. */
export function refreshCreatures(state: GameState): GameState {
  const refresh = refreshCreatureMarket(state.creatureMarket, state.rng);
  return {
    ...state,
    creatureMarket: refresh.market,
    rng: refresh.rng,
    phase: { phase: 'CREATURES_REFRESH', discarded: refresh.discarded, drawn: refresh.drawn },
  };
}

/** GODS_SETUP: losowa kolejność bogów, a przy mniejszej liczbie graczy część bogów zostaje odłożona. */
export function revealGods(state: GameState): GameState {
  const count = state.rules.godsRevealedByPlayerCount[state.seating.length];
  if (count === undefined) throw new Error(`Brak liczby bogów dla ${state.seating.length} graczy`);
  const [order, rng] = shuffle(RANDOMIZED_GODS, state.rng);
  const revealed = order.slice(0, count);
  return {
    ...state,
    rng,
    gods: { slots: revealed.map((god) => ({ god, offering: null })), apolloSupplicants: [], unavailable: order.slice(count) },
    phase: { phase: 'GODS_SETUP', revealed, hadesSummoned: false },
  };
}

/** INCOME: każdy gracz dostaje `expectedIncome` (dobrobyt, pola handlowe, Nekropolie). */
export function collectIncome(state: GameState): GameState {
  const report: Record<PlayerId, IncomeBreakdown> = {};
  let players = state.players;
  for (const playerId of state.seating) {
    const income = expectedIncome(state, playerId);
    const player = players[playerId] ?? getPlayer(state, playerId);
    report[playerId] = income;
    players = { ...players, [playerId]: { ...player, gold: player.gold + income.total } };
  }
  return { ...state, players, phase: { phase: 'INCOME', report } };
}

/** Haki cyklu: zasady podstawowe + zdarzenia podanych dodatków. */
export function createCycleHooks(modules: readonly ExpansionModule[] = EXPANSIONS): PhaseHooks {
  const run = (state: GameState, ...events: Parameters<typeof runCycleEvent>[1][]): GameState =>
    events.reduce((current, event) => runCycleEvent(current, event, modules), state);
  return {
    onExit: {
      INIT: (state) => run(state, 'gameStart'),
    },
    onEnter: {
      CREATURES_REFRESH: refreshCreatures,
      GODS_SETUP: (state) => run(revealGods(state), 'godsRevealed'),
      INCOME: (state) => run(collectIncome(state), 'incomeCollected'),
      ACTIONS: (state) => run(state, 'stateBased'),
      END_OF_CYCLE: (state) => run(state, 'stateBased', 'cycleEnd'),
    },
  };
}

/** Domyślne haki cyklu z wszystkimi dodatkami z rejestru (włączanymi według zasad partii). */
export const CYCLE_HOOKS: PhaseHooks = createCycleHooks();
