/**
 * @file Dodatek Monumenty: rozdanie kart i automatyczne stawianie Monumentów.
 *
 * Zdarzenia cyklu (zob. `module.ts`):
 *  - gameStart: każdy gracz dostaje jedną losową kartę Monumentu (talia jest
 *    tasowana przy tworzeniu partii).
 *  - stateBased: gdy gracz posiada budynki wymagane przez swoją kartę,
 *    figurka Monumentu staje automatycznie na jego wyspie z miejscem na
 *    Monument. Od tej chwili działa pasywna moc karty (np. Port Wojenny
 *    w silniku bitwy). Reguła jest idempotentna, więc można ją wywoływać po
 *    każdej komendzie.
 *
 * Założenia [zweryfikuj]:
 *  - Wymagane budynki mogą stać na różnych wyspach gracza, a Metropolia
 *    liczy się jak komplet budynków (tak jak w `countBuildings`).
 *  - Monument staje na wyspie z wolnym miejscem na Monument. Pierwszeństwo
 *    ma wyspa z największą liczbą wymaganych budynków, a przy remisie
 *    decyduje kolejność na planszy. Bez takiej wyspy karta czeka.
 *  - Postawiony Monument zostaje, nawet gdy wymagane budynki znikną.
 */

import {
  countBuildings,
  islandsOwnedBy,
  type BuildingType,
  type GameState,
  type IslandId,
  type IslandNode,
  type MonumentCardDef,
  type MonumentCardId,
  type PlayerId,
} from '../../model/index.ts';
import { replaceIsland } from '../boardOps.ts';
import type { ExpansionModule } from './module.ts';

// ===========================================================================
// Rozdanie kart (zdarzenie gameStart)
// ===========================================================================

/** Każdy gracz (w kolejności przy stole) dostaje kartę z wierzchu potasowanej talii. */
export function dealMonuments(state: GameState): GameState {
  const pool = state.monuments;
  if (pool === null || Object.keys(pool.dealt).length > 0) return state;
  const deck = [...pool.deck];
  const dealt: Record<PlayerId, MonumentCardId[]> = {};
  for (const playerId of state.seating) {
    const card = deck.shift();
    dealt[playerId] = card === undefined ? [] : [card];
  }
  return { ...state, monuments: { ...pool, deck, dealt } };
}

// ===========================================================================
// Wymagania
// ===========================================================================

function countTypes(types: readonly BuildingType[]): Map<BuildingType, number> {
  const counts = new Map<BuildingType, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return counts;
}

/** Budynki, których graczowi jeszcze brakuje do postawienia Monumentu (pusta lista = gotowe). */
export function missingBuildings(state: GameState, playerId: PlayerId, card: MonumentCardDef): BuildingType[] {
  const owned = countBuildings(state, playerId);
  return [...countTypes(card.requiredBuildings)].flatMap(([type, needed]) =>
    Array.from({ length: Math.max(0, needed - owned[type]) }, () => type),
  );
}

/** Ile różnych wymaganych typów budynków stoi na tej wyspie (Metropolia liczy się jak komplet). */
function localMatch(state: GameState, island: IslandNode, card: MonumentCardDef): number {
  const present = new Set(island.buildingSlots.flatMap((slot) => (slot.building ? [slot.building] : [])));
  if (island.metropolisSlot.metropolis !== null) state.rules.metropolisBuildingSet.forEach((type) => present.add(type));
  return new Set(card.requiredBuildings.filter((type) => present.has(type))).size;
}

/** Wyspa, na której stanie Monument, albo `null`, gdy gracz nie ma wolnego miejsca na Monument. */
export function monumentSiteFor(state: GameState, playerId: PlayerId, card: MonumentCardDef): IslandNode | null {
  let best: IslandNode | null = null;
  for (const island of islandsOwnedBy(state, playerId)) {
    if (!island.monumentSlot.available || island.monumentSlot.monument !== null) continue;
    if (best === null || localMatch(state, island, card) > localMatch(state, best, card)) best = island;
  }
  return best;
}

// ===========================================================================
// Automatyczne stawianie (zdarzenie stateBased)
// ===========================================================================

export interface MonumentBuilt {
  readonly playerId: PlayerId;
  readonly cardId: MonumentCardId;
  readonly islandId: IslandId;
}

/**
 * Stawia wszystkie Monumenty, których warunki są spełnione: gracz ma wymagane
 * budynki, figurka jest w zapasie, a gracz ma wyspę z wolnym miejscem.
 */
export function buildAchievedMonuments(state: GameState): { readonly state: GameState; readonly built: readonly MonumentBuilt[] } {
  if (state.monuments === null) return { state, built: [] };
  let current = state;
  const built: MonumentBuilt[] = [];
  for (const playerId of state.seating) {
    for (const cardId of state.monuments.dealt[playerId] ?? []) {
      const card = state.catalog.monumentCards[cardId];
      const pool = current.monuments;
      if (!card || pool === null) continue;
      if ((pool.figureSupply[card.kind] ?? 0) < 1 || missingBuildings(current, playerId, card).length > 0) continue;
      const island = monumentSiteFor(current, playerId, card);
      if (island === null) continue;

      current = {
        ...current,
        board: replaceIsland(current.board, {
          ...island,
          monumentSlot: {
            ...island.monumentSlot,
            monument: { cardId, kind: card.kind, builtBy: playerId, builtInCycle: current.cycle },
          },
        }),
        monuments: {
          ...pool,
          dealt: { ...pool.dealt, [playerId]: (pool.dealt[playerId] ?? []).filter((id) => id !== cardId) },
          figureSupply: { ...pool.figureSupply, [card.kind]: (pool.figureSupply[card.kind] ?? 0) - 1 },
        },
      };
      built.push({ playerId, cardId, islandId: island.id });
    }
  }
  return { state: built.length > 0 ? { ...current, revision: state.revision + 1 } : state, built };
}

// ===========================================================================
// Moduł dodatku
// ===========================================================================

export const MONUMENTS_EXPANSION: ExpansionModule = {
  name: 'Monumenty',
  isEnabled: (state) => state.monuments !== null,
  events: {
    gameStart: dealMonuments,
    stateBased: (state) => buildAchievedMonuments(state).state,
  },
};
