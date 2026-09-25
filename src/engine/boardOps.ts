/**
 * @file Niemutowalne operacje na planszy, wspólne dla ruchu i bitwy.
 *
 * Każda funkcja zwraca nową planszę. Naruszenie zasady „jeden gracz na
 * węźle” rzuca wyjątek, bo oznacza błąd silnika, a nie ruch gracza.
 */

import { getSea, type BoardGraph, type IslandNode, type LandForce, type NavalForce, type PlayerId, type SeaId, type SeaNode } from '../model/index.ts';

export function replaceSea(board: BoardGraph, sea: SeaNode): BoardGraph {
  return { ...board, seas: { ...board.seas, [sea.id]: sea } };
}

export function replaceIsland(board: BoardGraph, island: IslandNode): BoardGraph {
  return { ...board, islands: { ...board.islands, [island.id]: island } };
}

/** Łączy przybywające wojska z garnizonem tego samego gracza. */
export function mergeLandForces(existing: LandForce | null, arriving: LandForce): LandForce {
  if (existing === null) return arriving;
  if (existing.playerId !== arriving.playerId) {
    throw new Error(`Nie można połączyć wojsk graczy ${existing.playerId} i ${arriving.playerId}`);
  }
  return {
    playerId: existing.playerId,
    troops: existing.troops + arriving.troops,
    undeadTroops: existing.undeadTroops + arriving.undeadTroops,
    heroes: [...existing.heroes, ...arriving.heroes],
  };
}

/** Łączy przybywające floty z flotą tego samego gracza. */
export function mergeNavalForces(existing: NavalForce | null, arriving: NavalForce): NavalForce {
  if (existing === null) return arriving;
  if (existing.playerId !== arriving.playerId) {
    throw new Error(`Nie można połączyć flot graczy ${existing.playerId} i ${arriving.playerId}`);
  }
  return {
    playerId: existing.playerId,
    fleets: existing.fleets + arriving.fleets,
    undeadFleets: existing.undeadFleets + arriving.undeadFleets,
  };
}

/** Dodaje (albo odejmuje) zwykłe floty gracza na polu. Pusta flota staje się `null`. */
export function adjustFleets(board: BoardGraph, seaId: SeaId, playerId: PlayerId, delta: number): BoardGraph {
  const sea = getSea(board, seaId);
  if (sea.fleet !== null && sea.fleet.playerId !== playerId) {
    throw new Error(`Pole ${seaId} zajmuje flota gracza ${sea.fleet.playerId}`);
  }
  const fleets = (sea.fleet?.fleets ?? 0) + delta;
  const undeadFleets = sea.fleet?.undeadFleets ?? 0;
  if (fleets < 0) throw new Error(`Na polu ${seaId} zabrakło flot gracza ${playerId}`);
  const fleet: NavalForce | null = fleets + undeadFleets > 0 ? { playerId, fleets, undeadFleets } : null;
  return replaceSea(board, { ...sea, fleet });
}
