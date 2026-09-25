/**
 * @file Dodatek Hades: Kolumna Hadesa, nieumarli i Nekropolie.
 *
 * Zdarzenia cyklu (zob. `module.ts`):
 *  - godsRevealed: na początku cyklu rzut dwiema kośćmi przesuwa Kolumnę
 *    Hadesa o sumę oczek. Gdy kolumna osiągnie 9, Hades wkracza na ten cykl
 *    i zastępuje boga stojącego na torze tuż nad Apollem.
 *  - unitsDestroyed: każda Nekropolia na planszy odkłada 1 JZ za każdą
 *    zniszczoną zwykłą jednostkę (nieumarli i herosi się nie liczą).
 *  - incomeCollected: pule Nekropolii zostały wypłacone w dochodzie
 *    (`expectedIncome`), więc tutaj są zerowane.
 *  - cycleEnd: na koniec cyklu, w którym Hades był na torze, wszyscy
 *    nieumarli znikają z planszy i wracają do puli.
 *
 * Akcje w turze Hadesa: `recruitUndead` (nieumarłe oddziały i floty)
 * i `buildNecropolis`.
 */

import {
  advanceHadesThreat,
  consumeHadesSummon,
  getIsland,
  getPlayer,
  getSea,
  isIslandId,
  isSeaId,
  rollDie,
  type BiddableGod,
  type GameState,
  type IslandId,
  type NodeId,
  type PlayerId,
} from '../../model/index.ts';
import { mergeLandForces, mergeNavalForces, replaceIsland, replaceSea } from '../boardOps.ts';
import { charge, checkGodTurn, describeTurnRejection, updateTurnProgress, type TurnRejection } from '../turns.ts';
import type { ExpansionModule, UnitsDestroyedEvent } from './module.ts';

// ===========================================================================
// Kolumna Hadesa (zdarzenie godsRevealed)
// ===========================================================================

/** Czy Hades jest na torze bogów w bieżącym cyklu. */
export function hadesInPlay(state: GameState): boolean {
  return state.gods.slots.some((slot) => slot.god === 'HADES');
}

/**
 * Rzut kośćmi na Kolumnę Hadesa i ewentualne przywołanie Hadesa.
 * Kolumna jest przycinana do 9. Po przywołaniu spada do `levelAfterSummon`.
 */
export function advanceHadesColumn(state: GameState): GameState {
  const hades = state.hades;
  if (hades === null) return state;
  const rules = state.rules.hades;
  let rng = state.rng;
  const roll: number[] = [];
  for (let i = 0; i < rules.threatDiceCount; i++) {
    const [value, next] = rollDie(rng, rules.threatDieFaces);
    roll.push(value);
    rng = next;
  }
  const advanced = advanceHadesThreat(hades.threat, roll.reduce((sum, value) => sum + value, 0), rules);
  const { track, summoned } = consumeHadesSummon(advanced, rules);
  const rolled: GameState = { ...state, rng, hades: { ...hades, threat: track, lastThreatRoll: roll } };
  return summoned ? summonHades(rolled) : rolled;
}

/** Hades zastępuje boga stojącego na torze tuż nad Apollem (ostatnie pole toru). */
function summonHades(state: GameState): GameState {
  if (hadesInPlay(state)) return state;
  const slots = state.gods.slots;
  const replaced = slots.at(-1) ?? null;
  const withHades = [...slots.slice(0, replaced ? -1 : slots.length), { god: 'HADES' as const, offering: null }];
  const unavailable: BiddableGod[] = replaced ? [...state.gods.unavailable, replaced.god] : [...state.gods.unavailable];
  const summoned: GameState = { ...state, gods: { ...state.gods, slots: withHades, unavailable } };
  const phase = summoned.phase;
  if (phase.phase !== 'GODS_SETUP') return summoned;
  return { ...summoned, phase: { ...phase, revealed: withHades.map((slot) => slot.god), hadesSummoned: true } };
}

// ===========================================================================
// Akcje w turze Hadesa
// ===========================================================================

export type UndeadKind = 'TROOP' | 'FLEET';

export interface RecruitUndeadCommand {
  readonly playerId: PlayerId;
  readonly kind: UndeadKind;
  /** Własna wyspa (oddział) albo pole morskie przy własnej wyspie (flota). */
  readonly to: NodeId;
}

export interface BuildNecropolisCommand {
  readonly playerId: PlayerId;
  readonly islandId: IslandId;
}

export type PlacementProblem = 'UNKNOWN_NODE' | 'WRONG_NODE_TYPE' | 'NOT_OWN_ISLAND' | 'NOT_NEXT_TO_OWN_ISLAND' | 'ENEMY_FLEET';

export type HadesRejection =
  | TurnRejection
  | { readonly code: 'HADES_DISABLED' }
  | { readonly code: 'RECRUIT_LIMIT'; readonly kind: UndeadKind; readonly limit: number }
  | { readonly code: 'NO_UNDEAD_LEFT'; readonly kind: UndeadKind }
  | { readonly code: 'CANNOT_AFFORD'; readonly cost: number; readonly gold: number }
  | { readonly code: 'INVALID_PLACEMENT'; readonly to: NodeId; readonly problem: PlacementProblem }
  | { readonly code: 'UNKNOWN_ISLAND'; readonly island: IslandId }
  | { readonly code: 'NOT_OWN_ISLAND'; readonly island: IslandId }
  | { readonly code: 'NECROPOLIS_EXISTS'; readonly island: IslandId }
  | { readonly code: 'NO_FREE_SLOT'; readonly island: IslandId };

export type HadesOutcome = { readonly ok: true; readonly state: GameState } | { readonly ok: false; readonly error: HadesRejection };

const fail = (error: HadesRejection): HadesOutcome => ({ ok: false, error });
const recruitKey = (kind: UndeadKind) => (kind === 'TROOP' ? 'UNDEAD_TROOP' : 'UNDEAD_FLEET');

/** Koszt następnego nieumarłego danego rodzaju w bieżącej turze albo `null`, gdy wyczerpano limit. */
export function nextUndeadCost(state: GameState, kind: UndeadKind): number | null {
  const phase = state.phase;
  const recruited = phase.phase === 'ACTIONS' ? (phase.progress.recruited[recruitKey(kind)] ?? 0) : 0;
  return state.rules.hades.undeadCosts[recruited] ?? null;
}

/** Sprawdza, gdzie gracz może postawić nowego nieumarłego. */
function placementProblem(state: GameState, playerId: PlayerId, kind: UndeadKind, to: NodeId): PlacementProblem | null {
  const { board } = state;
  if (kind === 'TROOP') {
    if (!isIslandId(board, to)) return isSeaId(board, to) ? 'WRONG_NODE_TYPE' : 'UNKNOWN_NODE';
    return getIsland(board, to).ownerId === playerId ? null : 'NOT_OWN_ISLAND';
  }
  if (!isSeaId(board, to)) return isIslandId(board, to) ? 'WRONG_NODE_TYPE' : 'UNKNOWN_NODE';
  const sea = getSea(board, to);
  if (sea.fleet !== null && sea.fleet.playerId !== playerId) return 'ENEMY_FLEET';
  const nextToOwn = sea.adjacentIslands.some((islandId) => getIsland(board, islandId).ownerId === playerId);
  return nextToOwn ? null : 'NOT_NEXT_TO_OWN_ISLAND';
}

/** Rekrutacja jednego nieumarłego oddziału lub floty w turze Hadesa. */
export function recruitUndead(state: GameState, command: RecruitUndeadCommand): HadesOutcome {
  const hades = state.hades;
  if (hades === null) return fail({ code: 'HADES_DISABLED' });
  const turn = checkGodTurn(state, command.playerId, 'HADES');
  if (turn) return fail(turn);

  const { kind, playerId, to } = command;
  const cost = nextUndeadCost(state, kind);
  if (cost === null) return fail({ code: 'RECRUIT_LIMIT', kind, limit: state.rules.hades.undeadCosts.length });
  const supply = kind === 'TROOP' ? hades.undeadSupply.troops : hades.undeadSupply.fleets;
  if (supply < 1) return fail({ code: 'NO_UNDEAD_LEFT', kind });
  const gold = getPlayer(state, playerId).gold;
  if (gold < cost) return fail({ code: 'CANNOT_AFFORD', cost, gold });
  const problem = placementProblem(state, playerId, kind, to);
  if (problem) return fail({ code: 'INVALID_PLACEMENT', to, problem });

  let board = state.board;
  if (kind === 'TROOP' && isIslandId(board, to)) {
    const island = getIsland(board, to);
    board = replaceIsland(board, {
      ...island,
      garrison: mergeLandForces(island.garrison, { playerId, troops: 0, undeadTroops: 1, heroes: [] }),
    });
  } else if (kind === 'FLEET' && isSeaId(board, to)) {
    const sea = getSea(board, to);
    board = replaceSea(board, { ...sea, fleet: mergeNavalForces(sea.fleet, { playerId, fleets: 0, undeadFleets: 1 }) });
  }
  const undeadSupply =
    kind === 'TROOP'
      ? { ...hades.undeadSupply, troops: hades.undeadSupply.troops - 1 }
      : { ...hades.undeadSupply, fleets: hades.undeadSupply.fleets - 1 };
  const placed = charge({ ...state, board, hades: { ...hades, undeadSupply } }, playerId, cost);
  const counted = updateTurnProgress(placed, (progress) => ({
    ...progress,
    recruited: { ...progress.recruited, [recruitKey(kind)]: (progress.recruited[recruitKey(kind)] ?? 0) + 1 },
  }));
  return { ok: true, state: { ...counted, revision: state.revision + 1 } };
}

/** Budowa Nekropolii (najwyżej jednej na wyspie) na własnej wyspie w turze Hadesa. */
export function buildNecropolis(state: GameState, command: BuildNecropolisCommand): HadesOutcome {
  const hades = state.hades;
  if (hades === null) return fail({ code: 'HADES_DISABLED' });
  const turn = checkGodTurn(state, command.playerId, 'HADES');
  if (turn) return fail(turn);
  const island = state.board.islands[command.islandId];
  if (!island) return fail({ code: 'UNKNOWN_ISLAND', island: command.islandId });
  if (island.ownerId !== command.playerId) return fail({ code: 'NOT_OWN_ISLAND', island: island.id });
  if (island.buildingSlots.some((slot) => slot.building === 'NECROPOLIS')) {
    return fail({ code: 'NECROPOLIS_EXISTS', island: island.id });
  }
  const freeSlot = island.buildingSlots.findIndex((slot) => slot.building === null);
  if (freeSlot < 0) return fail({ code: 'NO_FREE_SLOT', island: island.id });
  const cost = state.rules.hades.necropolisCost;
  const gold = getPlayer(state, command.playerId).gold;
  if (gold < cost) return fail({ code: 'CANNOT_AFFORD', cost, gold });

  const built = replaceIsland(state.board, {
    ...island,
    buildingSlots: island.buildingSlots.map((slot, i) => (i === freeSlot ? { ...slot, building: 'NECROPOLIS' } : slot)),
  });
  const paid = charge(
    { ...state, board: built, hades: { ...hades, necropolisGold: { ...hades.necropolisGold, [island.id]: 0 } } },
    command.playerId,
    cost,
  );
  const counted = updateTurnProgress(paid, (progress) => ({
    ...progress,
    buildingsBuilt: [...progress.buildingsBuilt, 'NECROPOLIS'],
  }));
  return { ok: true, state: { ...counted, revision: state.revision + 1 } };
}

// ===========================================================================
// Nekropolie (zdarzenia unitsDestroyed i incomeCollected)
// ===========================================================================

/** Wyspy, na których stoi Nekropolia. */
export function necropolisIslands(state: GameState): IslandId[] {
  return Object.values(state.board.islands)
    .filter((island) => island.buildingSlots.some((slot) => slot.building === 'NECROPOLIS'))
    .map((island) => island.id);
}

/** Każda Nekropolia odkłada `necropolisGoldPerUnit` JZ za każdą zniszczoną zwykłą jednostkę. */
export function collectForNecropolises(state: GameState, event: UnitsDestroyedEvent): GameState {
  const hades = state.hades;
  const islands = necropolisIslands(state);
  if (hades === null || islands.length === 0 || event.count <= 0) return state;
  const gain = event.count * state.rules.hades.necropolisGoldPerUnit;
  const necropolisGold = { ...hades.necropolisGold };
  for (const islandId of islands) necropolisGold[islandId] = (necropolisGold[islandId] ?? 0) + gain;
  return { ...state, hades: { ...hades, necropolisGold } };
}

/**
 * Po wypłacie dochodu zeruje pule Nekropolii na wyspach, które mają
 * właściciela. Ich JZ zostały już wypłacone jako część `expectedIncome`,
 * więc hak musi działać PO dochodzie podstawowym (zapewnia to `cycle.ts`).
 */
export function emptyPaidNecropolises(state: GameState): GameState {
  const hades = state.hades;
  if (hades === null) return state;
  const necropolisGold = Object.fromEntries(
    Object.entries(hades.necropolisGold).map(([islandId, gold]) => [
      islandId,
      state.board.islands[islandId as IslandId]?.ownerId ? 0 : gold,
    ]),
  ) as Record<IslandId, number>;
  return { ...state, hades: { ...hades, necropolisGold } };
}

// ===========================================================================
// Koniec cyklu z Hadesem (zdarzenie cycleEnd)
// ===========================================================================

/** Po cyklu z Hadesem na torze wszyscy nieumarli znikają z planszy i wracają do puli. */
export function removeUndead(state: GameState): GameState {
  const hades = state.hades;
  if (hades === null || !hadesInPlay(state)) return state;
  let troops = 0;
  let fleets = 0;
  let board = state.board;
  for (const island of Object.values(board.islands)) {
    const garrison = island.garrison;
    if (!garrison || garrison.undeadTroops === 0) continue;
    troops += garrison.undeadTroops;
    const rest = { ...garrison, undeadTroops: 0 };
    board = replaceIsland(board, { ...island, garrison: rest.troops + rest.heroes.length > 0 ? rest : null });
  }
  for (const sea of Object.values(board.seas)) {
    const fleet = sea.fleet;
    if (!fleet || fleet.undeadFleets === 0) continue;
    fleets += fleet.undeadFleets;
    board = replaceSea(board, { ...sea, fleet: fleet.fleets > 0 ? { ...fleet, undeadFleets: 0 } : null });
  }
  if (troops + fleets === 0) return state;
  const undeadSupply = { troops: hades.undeadSupply.troops + troops, fleets: hades.undeadSupply.fleets + fleets };
  return { ...state, board, hades: { ...hades, undeadSupply } };
}

// ===========================================================================
// Moduł dodatku
// ===========================================================================

export const HADES_EXPANSION: ExpansionModule = {
  name: 'Hades',
  isEnabled: (state) => state.hades !== null,
  events: {
    godsRevealed: advanceHadesColumn,
    unitsDestroyed: collectForNecropolises,
    incomeCollected: emptyPaidNecropolises,
    cycleEnd: removeUndead,
  },
};

export function describeHadesRejection(error: HadesRejection): string {
  const kindName = (kind: UndeadKind) => (kind === 'TROOP' ? 'nieumarłych oddziałów' : 'nieumarłych flot');
  switch (error.code) {
    case 'NOT_ACTIONS_PHASE':
    case 'NOT_YOUR_TURN':
    case 'WRONG_GOD':
    case 'TURN_FINISHED':
    case 'UNKNOWN_PLAYER':
      return describeTurnRejection(error);
    case 'HADES_DISABLED':
      return 'Dodatek Hades jest wyłączony w tej partii.';
    case 'RECRUIT_LIMIT':
      return `W jednej turze można przywołać najwyżej ${error.limit} ${kindName(error.kind)}.`;
    case 'NO_UNDEAD_LEFT':
      return `W puli Hadesa nie ma już ${kindName(error.kind)}.`;
    case 'CANNOT_AFFORD':
      return `To kosztuje ${error.cost} JZ, a masz ${error.gold} JZ.`;
    case 'INVALID_PLACEMENT': {
      const reasons: Record<PlacementProblem, string> = {
        UNKNOWN_NODE: 'takiego miejsca nie ma na planszy',
        WRONG_NODE_TYPE: 'oddział stawia się na wyspie, a flotę na morzu',
        NOT_OWN_ISLAND: 'to nie jest twoja wyspa',
        NOT_NEXT_TO_OWN_ISLAND: 'pole nie sąsiaduje z żadną twoją wyspą',
        ENEMY_FLEET: 'na polu stoi obca flota',
      };
      return `Nie można postawić nieumarłego na ${error.to}: ${reasons[error.problem]}.`;
    }
    case 'UNKNOWN_ISLAND':
      return `Nieznana wyspa ${error.island}.`;
    case 'NOT_OWN_ISLAND':
      return `Wyspa ${error.island} nie należy do ciebie.`;
    case 'NECROPOLIS_EXISTS':
      return `Na wyspie ${error.island} stoi już Nekropolia.`;
    case 'NO_FREE_SLOT':
      return `Na wyspie ${error.island} nie ma wolnego miejsca na budynek.`;
  }
}
