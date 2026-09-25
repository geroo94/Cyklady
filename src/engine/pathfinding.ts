/**
 * @file Algorytmy grafowe na planszy: zasięg flot i mosty z flot dla wojsk.
 *
 * Plansza to graf G = (W ∪ M, E_WM ∪ E_MM), gdzie:
 *  - W to wyspy, a M to pola morskie,
 *  - E_WM to krawędzie wyspa–morze („wybrzeże”),
 *  - E_MM to krawędzie morze–morze („cieśniny”),
 *  - krawędzi wyspa–wyspa NIE MA: wyspy łączy tylko morze.
 * Szczegółowy opis znajduje się w NAWIGACJA.md.
 *
 * Ruch korzysta z dwóch podgrafów:
 *  1. Graf żeglugi (M, E_MM) dla flot: BFS z limitem kroków. Pole z obcą
 *     flotą jest osiągalne, ale nieprzechodnie, bo wejście na nie kończy ruch bitwą.
 *  2. Graf mostów gracza p dla wojsk: M_p to pola z flotą gracza p,
 *     a krawędzie to E_MM ograniczone do M_p. Wyspy A i B są połączone
 *     mostem, gdy pewne pole z N(A) ∩ M_p i pewne pole z N(B) ∩ M_p leżą
 *     w tej samej składowej spójności.
 *
 * Wszystkie funkcje są czyste i działają na samym `BoardGraph`, więc nadają
 * się do podpowiedzi w UI, botów i efektów kart. Złożoność: O(|M| + |E_MM| + |E_WM|).
 */

import { getIsland, getSea, type BoardGraph, type IslandId, type PlayerId, type SeaId, type SeaNode } from '../model/index.ts';

/** Czy na polu morskim stoi flota gracza (zwykła lub nieumarła). */
export function hasFleetOf(sea: SeaNode, playerId: PlayerId): boolean {
  return sea.fleet !== null && sea.fleet.playerId === playerId;
}

/** Czy na polu stoi flota innego gracza, czyli czy wejście na nie oznacza bitwę. */
export function hasEnemyFleet(sea: SeaNode, playerId: PlayerId): boolean {
  return sea.fleet !== null && sea.fleet.playerId !== playerId;
}

/** Odtwarza ścieżkę z mapy poprzedników BFS (od korzenia do `end`). */
function pathTo<T>(parent: ReadonlyMap<T, T | null>, end: T): T[] {
  const path: T[] = [];
  for (let node: T | null | undefined = end; node !== null && node !== undefined; node = parent.get(node)) {
    path.push(node);
  }
  return path.reverse();
}

// ===========================================================================
// Zasięg flot (Posejdon)
// ===========================================================================

/** Pole osiągalne dla grupy flot. */
export interface FleetReach {
  readonly sea: SeaId;
  /** Najmniejsza liczba kroków. */
  readonly distance: number;
  /** Najkrótsza trasa: `[start, ..., sea]`. */
  readonly path: readonly SeaId[];
  /** Na polu stoi obca flota: tu ruch się kończy i zaczyna bitwa morska. */
  readonly battle: boolean;
}

/**
 * Pola, na które grupa flot gracza dopłynie z `from` w najwyżej `range`
 * krokach (BFS po krawędziach morze–morze). Pole z obcą flotą trafia do
 * wyniku (jako bitwa), ale BFS nie rozwija się przez nie dalej. Pole
 * startowe nie należy do wyniku.
 */
export function fleetReach(board: BoardGraph, playerId: PlayerId, from: SeaId, range: number): FleetReach[] {
  getSea(board, from);
  const parent = new Map<SeaId, SeaId | null>([[from, null]]);
  const distance = new Map<SeaId, number>([[from, 0]]);
  const queue: SeaId[] = [from];
  const result: FleetReach[] = [];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    const depth = distance.get(current)!;
    const sea = getSea(board, current);
    const battle = current !== from && hasEnemyFleet(sea, playerId);
    if (current !== from) result.push({ sea: current, distance: depth, path: pathTo(parent, current), battle });
    if (battle || depth >= range) continue;
    for (const next of sea.adjacentSeas) {
      if (distance.has(next)) continue;
      distance.set(next, depth + 1);
      parent.set(next, current);
      queue.push(next);
    }
  }
  return result;
}

// ===========================================================================
// Mosty z flot (Ares)
// ===========================================================================

/** Wyspa osiągalna dla wojsk wraz z najkrótszym łańcuchem flot. */
export interface BridgeRoute {
  readonly island: IslandId;
  /**
   * Łańcuch pól morskich z flotami gracza. Pierwsze pole przylega do wyspy
   * startowej, ostatnie do docelowej, a kolejne pola sąsiadują ze sobą.
   */
  readonly seas: readonly SeaId[];
}

/**
 * BFS z wielu źródeł po grafie mostów gracza. Źródłami są wszystkie pola
 * przy wyspie startowej, na których stoi flota gracza. Wyspa zostaje
 * znaleziona przy zdjęciu z kolejki pierwszego sąsiedniego pola. BFS zdejmuje
 * pola w kolejności niemalejącej głębokości, więc to pole daje najkrótszy
 * łańcuch. Przy podanym `target` przeszukiwanie kończy się po jego znalezieniu.
 */
function bridgeSearch(board: BoardGraph, playerId: PlayerId, from: IslandId, target?: IslandId): Map<IslandId, SeaId[]> {
  const start = getIsland(board, from);
  const parent = new Map<SeaId, SeaId | null>();
  const queue: SeaId[] = [];
  for (const seaId of start.adjacentSeas) {
    if (!parent.has(seaId) && hasFleetOf(getSea(board, seaId), playerId)) {
      parent.set(seaId, null);
      queue.push(seaId);
    }
  }

  const found = new Map<IslandId, SeaId[]>();
  for (let head = 0; head < queue.length; head++) {
    const seaId = queue[head]!;
    const sea = getSea(board, seaId);
    for (const islandId of sea.adjacentIslands) {
      if (islandId === from || found.has(islandId)) continue;
      found.set(islandId, pathTo(parent, seaId));
      if (islandId === target) return found;
    }
    for (const next of sea.adjacentSeas) {
      if (!parent.has(next) && hasFleetOf(getSea(board, next), playerId)) {
        parent.set(next, seaId);
        queue.push(next);
      }
    }
  }
  return found;
}

/** Wszystkie wyspy, na które gracz może przerzucić wojska z `from`, z najkrótszymi łańcuchami flot. */
export function troopReach(board: BoardGraph, playerId: PlayerId, from: IslandId): BridgeRoute[] {
  return [...bridgeSearch(board, playerId, from)].map(([island, seas]) => ({ island, seas }));
}

/**
 * Najkrótszy łańcuch flot gracza między wyspami albo `null`, gdy go nie ma.
 * Dla `from === to` zwraca pustą listę (nie trzeba żadnego mostu).
 */
export function findFleetBridge(board: BoardGraph, playerId: PlayerId, from: IslandId, to: IslandId): SeaId[] | null {
  getIsland(board, to);
  if (from === to) return [];
  return bridgeSearch(board, playerId, from, to).get(to) ?? null;
}

// ===========================================================================
// Składowe spójności mostów (union-find)
// ===========================================================================

/** Składowa grafu mostów: połączone pola z flotami gracza i wyspy przy nich. */
export interface BridgeComponent {
  readonly seas: readonly SeaId[];
  readonly islands: readonly IslandId[];
}

/**
 * Składowe spójności grafu mostów gracza (union-find z kompresją ścieżek).
 * Liczone raz obsługują dowolnie wiele zapytań „czy A i B są połączone”,
 * np. przy podświetlaniu w UI wszystkich wysp w zasięgu desantu. Wyspa może
 * należeć do kilku składowych, jeśli przylega do rozdzielonych grup flot.
 */
export function fleetBridgeComponents(board: BoardGraph, playerId: PlayerId): BridgeComponent[] {
  const controlled = Object.values(board.seas)
    .filter((sea) => hasFleetOf(sea, playerId))
    .map((sea) => sea.id);
  const parent = new Map<SeaId, SeaId>(controlled.map((id) => [id, id]));

  const find = (id: SeaId): SeaId => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = id; node !== root; ) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };

  for (const id of controlled) {
    for (const next of getSea(board, id).adjacentSeas) {
      if (!parent.has(next)) continue;
      const a = find(id);
      const b = find(next);
      if (a !== b) parent.set(a, b);
    }
  }

  const groups = new Map<SeaId, SeaId[]>();
  for (const id of controlled) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()].map((seas) => ({
    seas,
    islands: [...new Set(seas.flatMap((id) => getSea(board, id).adjacentIslands))],
  }));
}

/** Czy dwie różne wyspy łączy most (na podstawie wyliczonych składowych). */
export function connectedByBridge(components: readonly BridgeComponent[], a: IslandId, b: IslandId): boolean {
  return components.some((component) => component.islands.includes(a) && component.islands.includes(b));
}
