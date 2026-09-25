/**
 * @file Selektory, czyli dane WYLICZANE ze stanu.
 *
 * Wszystko, co da się policzyć, jest liczone, a nie przechowywane: dochód,
 * liczba Metropolii, pozycja w licytacji, liczebność jednostek. Selektory są
 * czystymi funkcjami, więc można je memoizować (np. `reselect` w UI) bez
 * ryzyka rozjechania się z danymi źródłowymi.
 */

import type { BattleSide, BattleState } from './battle.ts';
import type { BoardGraph, IslandNode, SeaNode } from './board.ts';
import { BuildingType } from './domain.ts';
import type { GameState } from './gameState.ts';
import type { HeroId, IslandId, NodeId, PlayerId, SeaId } from './ids.ts';
import type { VictoryCheck } from './phases.ts';
import type {
  IncomeBreakdown,
  PlayerOffering,
  PlayerState,
  PlayerUnitsSummary,
  PlayerView,
  UnitCount,
} from './player.ts';

// ===========================================================================
// Dostęp do encji (z kontrolą istnienia)
// ===========================================================================

export function getPlayer(state: GameState, playerId: PlayerId): PlayerState {
  const player = state.players[playerId];
  if (!player) throw new Error(`Nieznany gracz: ${playerId}`);
  return player;
}

export function getIsland(board: BoardGraph, islandId: IslandId): IslandNode {
  const island = board.islands[islandId];
  if (!island) throw new Error(`Nieznana wyspa: ${islandId}`);
  return island;
}

export function getSea(board: BoardGraph, seaId: SeaId): SeaNode {
  const sea = board.seas[seaId];
  if (!sea) throw new Error(`Nieznane pole morskie: ${seaId}`);
  return sea;
}

// ===========================================================================
// Graf
// ===========================================================================

export function isIslandId(board: BoardGraph, id: NodeId): id is IslandId {
  return Object.hasOwn(board.islands, id);
}

export function isSeaId(board: BoardGraph, id: NodeId): id is SeaId {
  return Object.hasOwn(board.seas, id);
}

/** Sąsiedzi węzła: dla wyspy pola morskie, dla morza wyspy i pola morskie. */
export function adjacentNodes(board: BoardGraph, id: NodeId): readonly NodeId[] {
  if (isIslandId(board, id)) return getIsland(board, id).adjacentSeas;
  if (isSeaId(board, id)) {
    const sea = getSea(board, id);
    return [...sea.adjacentIslands, ...sea.adjacentSeas];
  }
  throw new Error(`Nieznany węzeł: ${id}`);
}

// ===========================================================================
// Wyspy, budynki, Metropolie
// ===========================================================================

export function islandsOwnedBy(state: GameState, playerId: PlayerId): IslandNode[] {
  return Object.values(state.board.islands).filter((island) => island.ownerId === playerId);
}

export function countMetropolises(state: GameState, playerId: PlayerId): number {
  return islandsOwnedBy(state, playerId).filter((island) => island.metropolisSlot.metropolis !== null).length;
}

/**
 * Budynki gracza według typu. Metropolia liczy się jak komplet budynków
 * z `rules.metropolisBuildingSet` (np. dla premii obronnej fortec i portów).
 */
export function countBuildings(state: GameState, playerId: PlayerId): Record<BuildingType, number> {
  const counts = Object.fromEntries(Object.values(BuildingType).map((type) => [type, 0])) as Record<
    BuildingType,
    number
  >;
  for (const island of islandsOwnedBy(state, playerId)) {
    for (const slot of island.buildingSlots) {
      if (slot.building !== null) counts[slot.building] += 1;
    }
    if (island.metropolisSlot.metropolis !== null) {
      for (const type of state.rules.metropolisBuildingSet) counts[type] += 1;
    }
  }
  return counts;
}

// ===========================================================================
// Jednostki i herosi
// ===========================================================================

/** Trwająca bitwa (także gdy stan jest w podstanie BATTLE_RESOLUTION). */
export function activeBattle(state: GameState): BattleState | null {
  return state.phase.phase === 'BATTLE_RESOLUTION' ? state.phase.battle : null;
}

function battleSidesOf(state: GameState, playerId: PlayerId): { side: BattleSide; kind: 'LAND' | 'SEA' }[] {
  const battle = activeBattle(state);
  if (!battle) return [];
  return [battle.attacker, battle.defender]
    .filter((side) => side.playerId === playerId)
    .map((side) => ({ side, kind: battle.location.kind }));
}

/** Pełne podsumowanie jednostek gracza: plansza, bitwa, zapas. */
export function countUnits(state: GameState, playerId: PlayerId): PlayerUnitsSummary {
  const player = getPlayer(state, playerId);
  let troops = 0;
  let undeadTroops = 0;
  let fleets = 0;
  let undeadFleets = 0;
  for (const island of Object.values(state.board.islands)) {
    if (island.garrison?.playerId === playerId) {
      troops += island.garrison.troops;
      undeadTroops += island.garrison.undeadTroops;
    }
  }
  for (const sea of Object.values(state.board.seas)) {
    if (sea.fleet?.playerId === playerId) {
      fleets += sea.fleet.fleets;
      undeadFleets += sea.fleet.undeadFleets;
    }
  }

  let battleTroops = 0;
  let battleUndeadTroops = 0;
  let battleFleets = 0;
  let battleUndeadFleets = 0;
  for (const { side, kind } of battleSidesOf(state, playerId)) {
    if (kind === 'LAND') {
      battleTroops += side.units;
      battleUndeadTroops += side.undead;
    } else {
      battleFleets += side.units;
      battleUndeadFleets += side.undead;
    }
  }

  const count = (onBoard: number, inBattle: number, inReserve: number): UnitCount => ({ onBoard, inBattle, inReserve });
  return {
    troops: count(troops, battleTroops, player.reserve.troops),
    fleets: count(fleets, battleFleets, player.reserve.fleets),
    undeadTroops: count(undeadTroops, battleUndeadTroops, 0),
    undeadFleets: count(undeadFleets, battleUndeadFleets, 0),
  };
}

/** Wszyscy herosi gracza: zapas, wyspy, bitwa. */
export function heroesOf(state: GameState, playerId: PlayerId): HeroId[] {
  const heroes = [...getPlayer(state, playerId).reserve.heroes];
  for (const island of Object.values(state.board.islands)) {
    if (island.garrison?.playerId === playerId) heroes.push(...island.garrison.heroes);
  }
  for (const { side } of battleSidesOf(state, playerId)) heroes.push(...side.heroes);
  return heroes;
}

// ===========================================================================
// Licytacja i kolejność
// ===========================================================================

/** „Pozycja w licytacji”: gdzie leżą znaczniki ofiary gracza. */
export function offeringsOf(state: GameState, playerId: PlayerId): PlayerOffering[] {
  const offerings: PlayerOffering[] = [];
  for (const slot of state.gods.slots) {
    if (slot.offering?.playerId === playerId) {
      offerings.push({ kind: 'GOD', god: slot.god, amount: slot.offering.amount });
    }
  }
  state.gods.apolloSupplicants.forEach((id, arrivalIndex) => {
    if (id === playerId) offerings.push({ kind: 'APOLLO', arrivalIndex });
  });
  return offerings;
}

/** Pozycje gracza na torze kolejności bieżącego cyklu (0 = licytuje pierwszy). */
export function turnOrderPositionsOf(state: GameState, playerId: PlayerId): number[] {
  return state.turnOrder.current.flatMap((id, index) => (id === playerId ? [index] : []));
}

// ===========================================================================
// Dochód i zwycięstwo
// ===========================================================================

/**
 * Dochód, który gracz otrzyma w fazie INCOME: znaczniki dobrobytu na jego
 * wyspach (nadrukowane i dodatkowe), pola handlowe, na których stoi
 * jakakolwiek jego flota, oraz JZ zebrane na Nekropoliach jego wysp.
 */
export function expectedIncome(state: GameState, playerId: PlayerId): IncomeBreakdown {
  const owned = islandsOwnedBy(state, playerId);
  const islands = owned.reduce((sum, island) => sum + island.prosperity.printed + island.prosperity.markers, 0);
  const tradeRoutes = Object.values(state.board.seas).reduce(
    (sum, sea) => (sea.fleet?.playerId === playerId && sea.tradeRoute ? sum + sea.tradeRoute.prosperity : sum),
    0,
  );
  const necropolis = owned.reduce((sum, island) => sum + (state.hades?.necropolisGold[island.id] ?? 0), 0);
  return { islands, tradeRoutes, necropolis, total: islands + tradeRoutes + necropolis };
}

/**
 * Sprawdzenie zwycięstwa (faza END_OF_CYCLE). Wygrywa gracz z wymaganą
 * liczbą Metropolii. Przy kilku takich graczach decyduje złoto, a przy
 * dalszym remisie zwycięzców jest kilku.
 */
export function checkVictory(state: GameState): VictoryCheck {
  const contenders = state.seating.filter(
    (playerId) => countMetropolises(state, playerId) >= state.rules.metropolisesToWin,
  );
  if (contenders.length === 0) return { contenders, winners: [] };
  const maxGold = Math.max(...contenders.map((playerId) => getPlayer(state, playerId).gold));
  return { contenders, winners: contenders.filter((playerId) => getPlayer(state, playerId).gold === maxGold) };
}

// ===========================================================================
// Widok gracza
// ===========================================================================

/** Pełny, wyliczony widok gracza (zob. `PlayerView` w `player.ts`). */
export function getPlayerView(state: GameState, playerId: PlayerId): PlayerView {
  return {
    state: getPlayer(state, playerId),
    units: countUnits(state, playerId),
    heroes: heroesOf(state, playerId),
    offerings: offeringsOf(state, playerId),
    turnOrderPositions: turnOrderPositionsOf(state, playerId),
    islands: islandsOwnedBy(state, playerId).map((island) => island.id),
    metropolises: countMetropolises(state, playerId),
    expectedIncome: expectedIncome(state, playerId),
  };
}
