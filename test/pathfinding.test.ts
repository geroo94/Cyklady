import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  connectedByBridge,
  findFleetBridge,
  fleetBridgeComponents,
  fleetReach,
  hasEnemyFleet,
  hasFleetOf,
  troopReach,
} from '../src/engine/index.ts';
import {
  IslandId,
  SeaId,
  createBoard,
  nextInt,
  seedRng,
  type BoardGraph,
  type PlayerId,
} from '../src/model/index.ts';
import {
  DELOS,
  MILOS,
  NAXOS,
  P1,
  P2,
  PAROS,
  SEA_CENTER,
  SEA_EAST,
  SEA_NORTH,
  SEA_SOUTH,
} from '../src/examples/sampleGame.ts';
import { readyGame, setFleet } from './helpers.ts';

// Plansza przykładowa (NAWIGACJA.md): pola morskie tworzą ścieżkę Pd. — Pn. — Środk. — Wsch.
// readyGame: P1 ma flotę na Morzu Środk., P2 na Morzu Wsch., P3 na Morzu Pd.

describe('Zasięg flot (BFS po krawędziach morze–morze)', () => {
  test('pole z obcą flotą jest osiągalne jako bitwa, ale nie da się przez nie przepłynąć', () => {
    const { board } = readyGame();
    assert.deepEqual(fleetReach(board, P1, SEA_CENTER, 3), [
      { sea: SEA_NORTH, distance: 1, path: [SEA_CENTER, SEA_NORTH], battle: false },
      { sea: SEA_EAST, distance: 1, path: [SEA_CENTER, SEA_EAST], battle: true },
      { sea: SEA_SOUTH, distance: 2, path: [SEA_CENTER, SEA_NORTH, SEA_SOUTH], battle: true },
    ]);
  });

  test('zasięg ogranicza liczbę kroków', () => {
    const { board } = setFleet(readyGame(), SEA_EAST, null);
    assert.deepEqual(
      fleetReach(board, P1, SEA_SOUTH, 1).map((r) => r.sea),
      [SEA_NORTH],
    );
    assert.deepEqual(
      fleetReach(board, P1, SEA_SOUTH, 3).map((r) => [r.sea, r.distance]),
      [
        [SEA_NORTH, 1],
        [SEA_CENTER, 2],
        [SEA_EAST, 3],
      ],
    );
  });
});

describe('Mosty z flot (BFS z wielu źródeł i union-find)', () => {
  test('wojska przechodzą tylko po łańcuchu własnych flot', () => {
    const start = readyGame();
    assert.deepEqual(troopReach(start.board, P1, NAXOS), [{ island: PAROS, seas: [SEA_CENTER] }]);
    assert.equal(findFleetBridge(start.board, P1, NAXOS, MILOS), null, 'flota P2 na Morzu Wsch. nie jest mostem dla P1');

    const { board } = setFleet(start, SEA_EAST, P1, 1);
    assert.deepEqual(findFleetBridge(board, P1, NAXOS, MILOS), [SEA_CENTER, SEA_EAST]);
    assert.deepEqual(findFleetBridge(board, P1, NAXOS, NAXOS), []);
  });

  test('składowe spójności rozdzielają grupy flot bez wspólnej krawędzi', () => {
    let s = setFleet(readyGame(), SEA_CENTER, null);
    s = setFleet(s, SEA_NORTH, P1, 1);
    s = setFleet(s, SEA_SOUTH, P1, 1);
    s = setFleet(s, SEA_EAST, P1, 1);
    const components = fleetBridgeComponents(s.board, P1);
    assert.deepEqual(
      components.map((c) => [[...c.seas].sort(), [...c.islands].sort()]),
      [
        [[SEA_NORTH, SEA_SOUTH].sort(), [DELOS, NAXOS].sort()],
        [[SEA_EAST], [MILOS, PAROS].sort()],
      ],
    );
    assert.equal(connectedByBridge(components, NAXOS, DELOS), true);
    assert.equal(connectedByBridge(components, PAROS, MILOS), true);
    assert.equal(connectedByBridge(components, NAXOS, MILOS), false, 'Morze Środk. jest puste, więc mostu nie ma');
  });
});

// ===========================================================================
// Testy właściwości na losowych planszach: porównanie z niezależnymi implementacjami
// ===========================================================================

interface RandomBoard {
  readonly board: BoardGraph;
  readonly islands: readonly IslandId[];
  readonly seas: readonly SeaId[];
}

function randomBoard(seed: number): RandomBoard {
  let rng = seedRng(`graf-${seed}`);
  const draw = (max: number): number => {
    const [value, next] = nextInt(rng, max);
    rng = next;
    return value;
  };
  const seas = Array.from({ length: 3 + draw(8) }, (_, i) => SeaId(`m${i}`));
  const islands = Array.from({ length: 2 + draw(7) }, (_, i) => IslandId(`w${i}`));
  const seaSeaEdges: [SeaId, SeaId][] = [];
  for (let i = 0; i < seas.length; i++) {
    for (let j = i + 1; j < seas.length; j++) if (draw(100) < 35) seaSeaEdges.push([seas[i]!, seas[j]!]);
  }
  const islandSeaEdges = islands.flatMap((island) =>
    Array.from({ length: 1 + draw(3) }, () => [island, seas[draw(seas.length)]!] as const),
  );
  const board = createBoard({
    islands: islands.map((id) => ({ id, name: id, buildingSlots: 1, prosperity: 0, monumentSite: false })),
    seas: seas.map((id) => ({ id, tradeProsperity: 0 })),
    islandSeaEdges,
    seaSeaEdges,
  });
  const withFleets = Object.fromEntries(
    Object.values(board.seas).map((sea) => {
      const roll = draw(100);
      const owner: PlayerId | null = roll < 40 ? P1 : roll < 65 ? P2 : null;
      return [sea.id, { ...sea, fleet: owner ? { playerId: owner, fleets: 1 + draw(2), undeadFleets: 0 } : null }];
    }),
  ) as BoardGraph['seas'];
  return { board: { ...board, seas: withFleets }, islands, seas };
}

/** Wzorzec: najkrótszy łańcuch flot (liczba pól) z Floyda–Warshalla. `Infinity`, gdy mostu brak. */
function referenceChainLength(board: BoardGraph, player: PlayerId, a: IslandId, b: IslandId): number {
  const controlled = Object.values(board.seas).filter((sea) => hasFleetOf(sea, player)).map((sea) => sea.id);
  const index = new Map(controlled.map((id, i) => [id, i]));
  const dist = controlled.map((_, i) => controlled.map((__, j) => (i === j ? 0 : Infinity)));
  for (const id of controlled) {
    for (const next of board.seas[id]!.adjacentSeas) {
      const j = index.get(next);
      if (j !== undefined) dist[index.get(id)!]![j] = 1;
    }
  }
  for (let k = 0; k < controlled.length; k++) {
    for (let i = 0; i < controlled.length; i++) {
      for (let j = 0; j < controlled.length; j++) {
        const viaK = dist[i]![k]! + dist[k]![j]!;
        if (viaK < dist[i]![j]!) dist[i]![j] = viaK;
      }
    }
  }
  const touching = (island: IslandId) =>
    board.islands[island]!.adjacentSeas.flatMap((sea) => (index.has(sea) ? [index.get(sea)!] : []));
  let best = Infinity;
  for (const s of touching(a)) for (const t of touching(b)) best = Math.min(best, dist[s]![t]! + 1);
  return best;
}

/** Wzorzec: zasięg flot z przeglądu wszystkich tras (nie tylko najkrótszych) o długości ≤ range. */
function referenceFleetReach(board: BoardGraph, player: PlayerId, from: SeaId, range: number) {
  const best = new Map<SeaId, { distance: number; battle: boolean }>();
  const walk = (sea: SeaId, depth: number): void => {
    if (depth === range) return;
    for (const next of board.seas[sea]!.adjacentSeas) {
      const enemy = hasEnemyFleet(board.seas[next]!, player);
      if (next !== from && (best.get(next)?.distance ?? Infinity) > depth + 1) {
        best.set(next, { distance: depth + 1, battle: enemy });
      }
      if (!enemy) walk(next, depth + 1);
    }
  };
  walk(from, 0);
  return best;
}

/** Łańcuch jest poprawny i najkrótszy: własne floty, przyczółki przy obu wyspach, sąsiednie pola. */
function assertShortestChain(board: BoardGraph, a: IslandId, b: IslandId, chain: readonly SeaId[], label: string): void {
  assert.equal(chain.length, referenceChainLength(board, P1, a, b), `${label}: łańcuch nie jest najkrótszy`);
  assert.ok(chain.every((sea) => hasFleetOf(board.seas[sea]!, P1)), `${label}: łańcuch tylko z własnych flot`);
  assert.ok(board.islands[a]!.adjacentSeas.includes(chain[0]!), `${label}: pierwsze pole przy wyspie startowej`);
  assert.ok(board.islands[b]!.adjacentSeas.includes(chain.at(-1)!), `${label}: ostatnie pole przy wyspie docelowej`);
  for (let i = 1; i < chain.length; i++) {
    assert.ok(board.seas[chain[i - 1]!]!.adjacentSeas.includes(chain[i]!), `${label}: kolejne pola sąsiadują`);
  }
}

describe('Właściwości na 250 losowych planszach', () => {
  test('BFS mostów zgadza się z union-find i daje najkrótsze poprawne łańcuchy', () => {
    let connectedPairs = 0;
    for (let seed = 0; seed < 250; seed++) {
      const { board, islands } = randomBoard(seed);
      const components = fleetBridgeComponents(board, P1);
      for (const a of islands) {
        const routes = new Map(troopReach(board, P1, a).map((route) => [route.island, route.seas]));
        for (const b of islands) {
          if (a === b) continue;
          const label = `ziarno ${seed}, ${a}->${b}`;
          const connected = referenceChainLength(board, P1, a, b) !== Infinity;
          const chain = findFleetBridge(board, P1, a, b);
          assert.equal(routes.has(b), connected, `${label}: troopReach`);
          assert.equal(connectedByBridge(components, a, b), connected, `${label}: union-find`);
          assert.equal(chain !== null, connected, `${label}: findFleetBridge`);
          if (!connected || chain === null) continue;
          connectedPairs++;
          assertShortestChain(board, a, b, chain, `${label} (findFleetBridge)`);
          assertShortestChain(board, a, b, routes.get(b)!, `${label} (troopReach)`);
        }
      }
    }
    assert.ok(connectedPairs > 500, `próba powinna zawierać dużo połączonych par (było ${connectedPairs})`);
  });

  test('BFS zasięgu flot zgadza się z przeglądem wszystkich tras', () => {
    for (let seed = 0; seed < 250; seed++) {
      const { board, seas } = randomBoard(seed);
      for (const from of seas.filter((sea) => hasFleetOf(board.seas[sea]!, P1))) {
        for (const range of [1, 2, 3, 4]) {
          const actual = fleetReach(board, P1, from, range);
          const expected = referenceFleetReach(board, P1, from, range);
          assert.deepEqual(
            new Map(actual.map((r) => [r.sea, { distance: r.distance, battle: r.battle }])),
            expected,
            `ziarno ${seed}, start ${from}, zasięg ${range}`,
          );
          for (const reach of actual) {
            assert.equal(reach.path.length, reach.distance + 1);
            assert.equal(reach.path[0], from);
            reach.path.slice(1, -1).forEach((sea) => assert.ok(!hasEnemyFleet(board.seas[sea]!, P1), 'trasa omija obce floty'));
            for (let i = 1; i < reach.path.length; i++) {
              assert.ok(board.seas[reach.path[i - 1]!]!.adjacentSeas.includes(reach.path[i]!));
            }
          }
        }
      }
    }
  });
});
