/**
 * @file Pomocniki testów: niemutowalne aktualizacje stanu, minimalne haki
 * silnika zasad dla faz automatycznych i przewijanie partii do wybranej fazy.
 *
 * Haki poniżej są TESTOWĄ namiastką silnika zasad. Pokazują, jak silnik
 * wpina się w maszynę stanów, ale nie są implementacją reguł.
 */

import assert from 'node:assert/strict';
import {
  checkVictory,
  createActionsPhase,
  createTurnProgress,
  createBiddingPhase,
  expectPhase,
  finishGodTurn,
  startNextGodTurn,
  transition,
  validateGameState,
  type BattleState,
  type BuildingType,
  type CardId,
  type GameState,
  type GodTurn,
  type HeroId,
  type IslandId,
  type IslandNode,
  type MonumentCardId,
  type PlayerId,
  type PlayerState,
  type SeaId,
  type SeaNode,
  type TurnProgress,
} from '../src/model/index.ts';
import { CYCLE_HOOKS, describeRejection, runBidding, settleBidding } from '../src/engine/index.ts';
import {
  DELOS,
  NAXOS,
  P1,
  P2,
  P3,
  PAROS,
  SEA_CENTER,
  SEA_EAST,
  SEA_SOUTH,
  createSampleGame,
} from '../src/examples/sampleGame.ts';

/** Sprawdza wszystkie niezmienniki i zwraca stan (wygodne w łańcuchach kroków). */
export function assertValid(state: GameState): GameState {
  assert.deepEqual(validateGameState(state), []);
  return state;
}

/** Zamraża obiekt rekurencyjnie, więc każda próba mutacji rzuci wyjątek (test czystości funkcji). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Kody naruszeń niezmienników (do testów negatywnych). */
export function violationCodes(state: GameState): string[] {
  return validateGameState(state).map((violation) => violation.code);
}

// ---------------------------------------------------------------------------
// Niemutowalne aktualizacje
// ---------------------------------------------------------------------------

export function updatePlayer(state: GameState, id: PlayerId, fn: (p: PlayerState) => PlayerState): GameState {
  const player = state.players[id];
  assert.ok(player, `brak gracza ${id}`);
  return { ...state, players: { ...state.players, [id]: fn(player) } };
}

export function updateIsland(state: GameState, id: IslandId, fn: (i: IslandNode) => IslandNode): GameState {
  const island = state.board.islands[id];
  assert.ok(island, `brak wyspy ${id}`);
  return { ...state, board: { ...state.board, islands: { ...state.board.islands, [id]: fn(island) } } };
}

export function updateSea(state: GameState, id: SeaId, fn: (s: SeaNode) => SeaNode): GameState {
  const sea = state.board.seas[id];
  assert.ok(sea, `brak pola ${id}`);
  return { ...state, board: { ...state.board, seas: { ...state.board.seas, [id]: fn(sea) } } };
}

export function updateBattle(state: GameState, fn: (b: BattleState) => BattleState): GameState {
  const phase = expectPhase(state, 'BATTLE_RESOLUTION');
  return { ...state, phase: { ...phase, battle: fn(phase.battle) } };
}

export function updateProgress(state: GameState, fn: (p: TurnProgress) => TurnProgress): GameState {
  const phase = expectPhase(state, 'ACTIONS');
  return { ...state, phase: { ...phase, progress: fn(phase.progress) } };
}

/** Wystawia oddziały z zapasu gracza na wyspę i czyni go jej właścicielem. */
export function placeGarrison(state: GameState, playerId: PlayerId, islandId: IslandId, troops: number): GameState {
  const withReserve = updatePlayer(state, playerId, (p) => ({
    ...p,
    reserve: { ...p.reserve, troops: p.reserve.troops - troops },
  }));
  return updateIsland(withReserve, islandId, (island) => ({
    ...island,
    ownerId: playerId,
    garrison: { playerId, troops, undeadTroops: 0, heroes: [] },
  }));
}

/** Wystawia floty z zapasu gracza na pole morskie. */
export function placeFleet(state: GameState, playerId: PlayerId, seaId: SeaId, fleets: number): GameState {
  const withReserve = updatePlayer(state, playerId, (p) => ({
    ...p,
    reserve: { ...p.reserve, fleets: p.reserve.fleets - fleets },
  }));
  return updateSea(withReserve, seaId, (sea) => ({ ...sea, fleet: { playerId, fleets, undeadFleets: 0 } }));
}

/**
 * Ustawia floty na polu morskim (`null` czyści pole) z poprawnym rozliczeniem
 * zapasów: poprzedni właściciel odzyskuje figurki, nowy je wydaje.
 */
export function setFleet(state: GameState, seaId: SeaId, playerId: PlayerId | null, fleets = 0): GameState {
  const previous = state.board.seas[seaId]?.fleet ?? null;
  assert.equal(previous?.undeadFleets ?? 0, 0, 'setFleet nie obsługuje nieumarłych');
  let s = state;
  if (previous) {
    s = updatePlayer(s, previous.playerId, (p) => ({ ...p, reserve: { ...p.reserve, fleets: p.reserve.fleets + previous.fleets } }));
  }
  if (playerId && fleets > 0) {
    s = updatePlayer(s, playerId, (p) => ({ ...p, reserve: { ...p.reserve, fleets: p.reserve.fleets - fleets } }));
  }
  return updateSea(s, seaId, (sea) => ({
    ...sea,
    fleet: playerId && fleets > 0 ? { playerId, fleets, undeadFleets: 0 } : null,
  }));
}

/**
 * Ustawia właściciela i garnizon wyspy z poprawnym rozliczeniem zapasów.
 * `troops = 0` oznacza wyspę bez wojsk (także należącą do gracza).
 */
export function setIsland(state: GameState, islandId: IslandId, owner: PlayerId | null, troops = 0): GameState {
  const previous = state.board.islands[islandId]?.garrison ?? null;
  assert.equal((previous?.undeadTroops ?? 0) + (previous?.heroes.length ?? 0), 0, 'setIsland obsługuje tylko oddziały');
  let s = state;
  if (previous) {
    s = updatePlayer(s, previous.playerId, (p) => ({ ...p, reserve: { ...p.reserve, troops: p.reserve.troops + previous.troops } }));
  }
  if (owner && troops > 0) {
    s = updatePlayer(s, owner, (p) => ({ ...p, reserve: { ...p.reserve, troops: p.reserve.troops - troops } }));
  }
  return updateIsland(s, islandId, (island) => ({
    ...island,
    ownerId: owner,
    garrison: owner && troops > 0 ? { playerId: owner, troops, undeadTroops: 0, heroes: [] } : null,
  }));
}

// ---------------------------------------------------------------------------
// Scenariusz przykładowej partii
// ---------------------------------------------------------------------------

export const STARTING_ISLAND: Readonly<Record<PlayerId, IslandId>> = { [P1]: NAXOS, [P2]: PAROS, [P3]: DELOS };

/** Partia w INIT z rozstawionymi siłami startowymi (gotowa do pierwszego cyklu). */
export function readyGame(): GameState {
  let s = createSampleGame();
  s = placeGarrison(s, P1, NAXOS, 2);
  s = placeFleet(s, P1, SEA_CENTER, 1);
  s = placeGarrison(s, P2, PAROS, 2);
  s = placeFleet(s, P2, SEA_EAST, 1);
  s = placeGarrison(s, P3, DELOS, 2);
  s = placeFleet(s, P3, SEA_SOUTH, 1);
  const init = expectPhase(s, 'INIT');
  return { ...s, phase: { ...init, step: 'READY', placementQueue: [] } };
}

// ---------------------------------------------------------------------------
// Modyfikatory scenariuszy (kości, budynki, herosi, nieumarli, Monumenty)
// ---------------------------------------------------------------------------

/** Jedna ścianka kości daje przewidywalne rzuty. */
export function withDice(state: GameState, dieFaces: readonly number[]): GameState {
  return { ...state, rules: { ...state.rules, combat: { ...state.rules.combat, dieFaces } } };
}

export function withBuildings(state: GameState, islandId: IslandId, buildings: readonly BuildingType[]): GameState {
  return updateIsland(state, islandId, (island) => ({
    ...island,
    buildingSlots: island.buildingSlots.map((slot, i) => ({ ...slot, building: buildings[i] ?? null })),
  }));
}

/** Heros z talii staje na wyspie (w garnizonie właściciela). */
export function addHero(state: GameState, islandId: IslandId, heroId: HeroId, cardId: CardId): GameState {
  const withEntity: GameState = {
    ...state,
    creatureMarket: { ...state.creatureMarket, deck: state.creatureMarket.deck.filter((id) => id !== cardId) },
    heroes: { ...state.heroes, [heroId]: { id: heroId, cardId, exhausted: false } },
  };
  return updateIsland(withEntity, islandId, (i) => ({
    ...i,
    garrison: i.garrison && { ...i.garrison, heroes: [...i.garrison.heroes, heroId] },
  }));
}

/** Nieumarłe oddziały z puli Hadesa dołączają do garnizonu. */
export function addUndead(state: GameState, islandId: IslandId, count: number): GameState {
  const hades = state.hades ?? assert.fail('dodatek Hades wyłączony');
  const withSupply: GameState = {
    ...state,
    hades: { ...hades, undeadSupply: { ...hades.undeadSupply, troops: hades.undeadSupply.troops - count } },
  };
  return updateIsland(withSupply, islandId, (i) => ({
    ...i,
    garrison: i.garrison && { ...i.garrison, undeadTroops: i.garrison.undeadTroops + count },
  }));
}

/** Monument z puli staje na wyspie. */
export function buildMonument(state: GameState, islandId: IslandId, cardId: MonumentCardId): GameState {
  const pool = state.monuments ?? assert.fail('dodatek Monumenty wyłączony');
  const card = state.catalog.monumentCards[cardId] ?? assert.fail(`brak karty ${cardId}`);
  const withPool: GameState = {
    ...state,
    monuments: {
      ...pool,
      deck: pool.deck.filter((id) => id !== cardId),
      figureSupply: { ...pool.figureSupply, [card.kind]: (pool.figureSupply[card.kind] ?? 1) - 1 },
    },
  };
  return updateIsland(withPool, islandId, (i) => ({
    ...i,
    monumentSlot: { available: true, monument: { cardId, kind: card.kind, builtBy: i.ownerId ?? P2, builtInCycle: 1 } },
  }));
}

// ---------------------------------------------------------------------------
// Scenariusze fazy ACTIONS (ruch, bitwa)
// ---------------------------------------------------------------------------

export const POSEIDON_TURN: readonly GodTurn[] = [
  { god: 'POSEIDON', playerId: P1 },
  { god: 'ARES', playerId: P2 },
  { god: 'APOLLO', playerId: P3 },
];

export const ARES_TURN: readonly GodTurn[] = [
  { god: 'ARES', playerId: P1 },
  { god: 'POSEIDON', playerId: P2 },
  { god: 'APOLLO', playerId: P3 },
];

/**
 * Faza ACTIONS z podaną kolejnością tur (trwa pierwsza) na planszy z `readyGame`,
 * zmienionej przez `setup`. Tor bogów jest zgodny z turami.
 */
export function actionsScenario(turns: readonly GodTurn[], setup: (s: GameState) => GameState = (s) => s): GameState {
  const s = setup(readyGame());
  return assertValid({
    ...s,
    cycle: 1,
    gods: {
      slots: turns.flatMap((t) => (t.god === 'APOLLO' ? [] : [{ god: t.god, offering: { playerId: t.playerId, amount: 1 } }])),
      apolloSupplicants: turns.filter((t) => t.god === 'APOLLO').map((t) => t.playerId),
      unavailable: [],
    },
    phase: { phase: 'ACTIONS', turns, turnIndex: 0, progress: createTurnProgress() },
  });
}

/** CREATURES_REFRESH -> GODS_SETUP -> INCOME -> BIDDING. */
export function advanceToBidding(state: GameState): GameState {
  let s = transition(state, { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, CYCLE_HOOKS);
  s = transition(s, { phase: 'GODS_SETUP', revealed: [], hadesSummoned: false }, CYCLE_HOOKS);
  s = transition(s, { phase: 'INCOME', report: {} }, CYCLE_HOOKS);
  return transition(s, createBiddingPhase(s), CYCLE_HOOKS);
}

/**
 * Licytacja bez przebijania, przeprowadzona prawdziwym silnikiem: kolejni
 * gracze z kolejki biorą kolejnych bogów z toru za 1 JZ, a gdy bogów
 * zabraknie, pozostali idą do Apolla. Na końcu licytacja zostaje rozliczona.
 */
export function placeOfferingsInOrder(state: GameState): GameState {
  let godIndex = 0;
  const run = runBidding(state, (s, legal) => {
    const slot = s.gods.slots[godIndex++];
    return slot
      ? { type: 'OFFER', playerId: legal.playerId, god: slot.god, amount: 1 }
      : { type: 'APOLLO', playerId: legal.playerId };
  });
  const settled = settleBidding(run.state);
  assert.ok(settled.ok, settled.ok ? '' : describeRejection(settled.error));
  return settled.state;
}

/** Od partii gotowej do cyklu aż do pierwszej tury w fazie ACTIONS. */
export function advanceToActions(state: GameState): GameState {
  const bidding = placeOfferingsInOrder(advanceToBidding(state));
  return transition(bidding, createActionsPhase(bidding));
}

/** Kończy wszystkie tury bogów w fazie ACTIONS. */
export function playAllTurns(state: GameState): GameState {
  let s = finishGodTurn(state);
  for (;;) {
    const phase = expectPhase(s, 'ACTIONS');
    if (phase.turnIndex >= phase.turns.length - 1) return s;
    s = finishGodTurn(startNextGodTurn(s));
  }
}

/** Pełny pierwszy cykl zakończony w fazie END_OF_CYCLE. */
export function playFirstCycle(): GameState {
  const s = playAllTurns(advanceToActions(readyGame()));
  return transition(s, { phase: 'END_OF_CYCLE', victory: checkVictory(s) });
}
