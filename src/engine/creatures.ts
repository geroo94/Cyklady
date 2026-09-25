/**
 * @file Efekty Mitologicznych Stworów.
 *
 * Na razie Gigant: niszczy jeden budynek na wybranej wyspie. Zgodnie
 * z dodatkiem Monumenty Monumentów zniszczyć nie może. Efekt jest czystą
 * funkcją bez sprawdzania tury. Wywołuje go silnik zakupu stworów po
 * opłaceniu karty.
 *
 * Założenia [zweryfikuj]:
 *  - Gigant niszczy tylko budynki w slotach. Metropolia nie jest celem.
 *  - Zniszczenie Nekropolii przepada razem z zebranymi na niej JZ.
 */

import { type BuildingType, type GameState, type IslandId } from '../model/index.ts';
import { replaceIsland } from './boardOps.ts';

export type GiantTarget = { readonly kind: 'BUILDING'; readonly slot: number } | { readonly kind: 'MONUMENT' };

export type GiantRejection =
  | { readonly code: 'UNKNOWN_ISLAND'; readonly island: IslandId }
  | { readonly code: 'MONUMENT_IMMUNE'; readonly island: IslandId }
  | { readonly code: 'NO_BUILDING'; readonly island: IslandId; readonly slot: number };

export type GiantOutcome =
  | { readonly ok: true; readonly state: GameState; readonly destroyed: BuildingType }
  | { readonly ok: false; readonly error: GiantRejection };

/** Sloty z budynkami, które Gigant może zniszczyć (Monument nigdy nie jest celem). */
export function giantTargets(state: GameState, islandId: IslandId): number[] {
  const island = state.board.islands[islandId];
  return island ? island.buildingSlots.flatMap((slot) => (slot.building === null ? [] : [slot.index])) : [];
}

/** Efekt Giganta: niszczy wskazany budynek. Monumenty są na niego odporne. */
export function applyGiant(state: GameState, islandId: IslandId, target: GiantTarget): GiantOutcome {
  const island = state.board.islands[islandId];
  if (!island) return { ok: false, error: { code: 'UNKNOWN_ISLAND', island: islandId } };
  if (target.kind === 'MONUMENT') return { ok: false, error: { code: 'MONUMENT_IMMUNE', island: islandId } };
  const destroyed = island.buildingSlots.find((slot) => slot.index === target.slot)?.building ?? null;
  if (destroyed === null) return { ok: false, error: { code: 'NO_BUILDING', island: islandId, slot: target.slot } };

  const board = replaceIsland(state.board, {
    ...island,
    buildingSlots: island.buildingSlots.map((slot) => (slot.index === target.slot ? { ...slot, building: null } : slot)),
  });
  let hades = state.hades;
  if (destroyed === 'NECROPOLIS' && hades !== null) {
    const necropolisGold = Object.fromEntries(Object.entries(hades.necropolisGold).filter(([id]) => id !== islandId));
    hades = { ...hades, necropolisGold: necropolisGold as typeof hades.necropolisGold };
  }
  return { ok: true, state: { ...state, board, hades, revision: state.revision + 1 }, destroyed };
}

export function describeGiantRejection(error: GiantRejection): string {
  switch (error.code) {
    case 'UNKNOWN_ISLAND':
      return `Nieznana wyspa ${error.island}.`;
    case 'MONUMENT_IMMUNE':
      return `Gigant nie może zniszczyć Monumentu na wyspie ${error.island}.`;
    case 'NO_BUILDING':
      return `Na wyspie ${error.island} w miejscu ${error.slot} nie ma budynku.`;
  }
}
