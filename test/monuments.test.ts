import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  COMBAT_EFFECTS,
  CYCLE_HOOKS,
  applyGiant,
  applyStateBasedEffects,
  buildAchievedMonuments,
  dealMonuments,
  describeGiantRejection,
  describeMoveRejection,
  giantTargets,
  missingBuildings,
  monumentEffect,
  moveTroops,
  runBattle,
  type GiantOutcome,
  type GiantRejection,
} from '../src/engine/index.ts';
import {
  IslandId,
  MonumentCardId,
  MonumentKind,
  getIsland,
  transition,
  type GameState,
  type Metropolis,
  type MonumentCardDef,
  type PlayerId,
} from '../src/model/index.ts';
import { DELOS, MILOS, NAXOS, P1, P2, P3, PAROS, SAMPLE_CATALOG } from '../src/examples/sampleGame.ts';
import {
  ARES_TURN,
  actionsScenario,
  assertValid,
  buildMonument,
  readyGame,
  setIsland,
  updateIsland,
  violationCodes,
  withBuildings,
  withDice,
} from './helpers.ts';

const WAR_PORT = MonumentCardId('m-war-port');
const ORACLE = MonumentCardId('m-oracle');
const metropolis: Metropolis = { origin: 'BUILDINGS', builtInCycle: 1 };

const card = (id: MonumentCardId): MonumentCardDef => SAMPLE_CATALOG.monumentCards[id] ?? assert.fail(`brak karty ${id}`);

/** Przekazuje graczowi kartę Monumentu z talii (zamiast losowego rozdania). */
function dealTo(state: GameState, playerId: PlayerId, cardId: MonumentCardId): GameState {
  const pool = state.monuments ?? assert.fail('dodatek Monumenty wyłączony');
  return {
    ...state,
    monuments: {
      ...pool,
      deck: pool.deck.filter((id) => id !== cardId),
      dealt: { ...pool.dealt, [playerId]: [...(pool.dealt[playerId] ?? []), cardId] },
    },
  };
}

function giantError(outcome: GiantOutcome): GiantRejection {
  if (outcome.ok) assert.fail('Gigant powinien zostać powstrzymany');
  return outcome.error;
}

// ===========================================================================
describe('Rozdanie kart Monumentów', () => {
  test('na początku gry każdy gracz dostaje jedną losową kartę', () => {
    const s = assertValid(transition(readyGame(), { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, CYCLE_HOOKS));
    const dealt = s.monuments?.dealt ?? assert.fail();
    assert.deepEqual(Object.keys(dealt).sort(), [P1, P2, P3].sort());
    const cards = Object.values(dealt).flat();
    assert.equal(cards.length, 3);
    assert.equal(new Set(cards).size, 3, 'każdy dostaje inną kartę');
    assert.equal(s.monuments?.deck.length, 1);
    assert.equal(dealMonuments(s), s, 'ponowne rozdanie niczego nie zmienia');
  });

  test('karta rozdana graczowi nie może jednocześnie leżeć w talii', () => {
    const s = readyGame();
    const pool = s.monuments ?? assert.fail();
    const broken: GameState = { ...s, monuments: { ...pool, dealt: { [P1]: [pool.deck[0] ?? assert.fail()] } } };
    assert.ok(violationCodes(broken).includes('ZONE_DUPLICATE'));
  });
});

// ===========================================================================
describe('Automatyczne stawianie Monumentów', () => {
  test('dwa wymagane budynki automatycznie stawiają Monument i włączają jego moc', () => {
    let s = dealTo(withBuildings(readyGame(), NAXOS, ['PORT']), P1, WAR_PORT);
    assert.deepEqual(card(WAR_PORT).requiredBuildings, ['PORT', 'FORTRESS']);
    assert.deepEqual(missingBuildings(s, P1, card(WAR_PORT)), ['FORTRESS']);
    assert.equal(applyStateBasedEffects(s), s, 'bez kompletu budynków nic się nie dzieje');

    s = withBuildings(s, NAXOS, ['PORT', 'FORTRESS']);
    const { state, built } = buildAchievedMonuments(s);
    assert.deepEqual(built, [{ playerId: P1, cardId: WAR_PORT, islandId: NAXOS }]);
    assert.deepEqual(getIsland(state.board, NAXOS).monumentSlot.monument, {
      cardId: WAR_PORT,
      kind: MonumentKind('WAR_PORT'),
      builtBy: P1,
      builtInCycle: 0,
    });
    assert.deepEqual(state.monuments?.dealt[P1], [], 'karta opuszcza rękę gracza');
    assert.equal(state.monuments?.figureSupply[MonumentKind('WAR_PORT')], 0, 'figurka opuszcza zapas');
    assert.equal(monumentEffect(state, getIsland(state.board, NAXOS)), COMBAT_EFFECTS.FLEETS_DEFEND_LAND, 'moc działa od razu');
    assertValid(state);
    assert.equal(applyStateBasedEffects(state), state, 'reguła jest idempotentna');
  });

  test('budynki mogą stać na różnych wyspach, a Metropolia liczy się jak komplet', () => {
    // Port na Naxos, Forteca na Milos. Milos nie ma miejsca na Monument, więc figurka staje na Naxos.
    let s = setIsland(readyGame(), MILOS, P1, 1);
    s = dealTo(withBuildings(withBuildings(s, NAXOS, ['PORT']), MILOS, ['FORTRESS']), P1, WAR_PORT);
    assert.equal(buildAchievedMonuments(s).built[0]?.islandId, NAXOS);

    const metropolisOnly = dealTo(updateIsland(readyGame(), NAXOS, (i) => ({ ...i, metropolisSlot: { metropolis } })), P1, WAR_PORT);
    assert.equal(buildAchievedMonuments(metropolisOnly).built.length, 1);
  });

  test('bez wolnego miejsca na Monument karta czeka na zdobycie takiej wyspy', () => {
    // Miejsce na Naxos zajmuje już Wyrocznia, więc Port Wojenny stanie dopiero na zdobytym Delos.
    let s = buildMonument(readyGame(), NAXOS, ORACLE);
    s = dealTo(withBuildings(s, NAXOS, ['PORT', 'FORTRESS']), P1, WAR_PORT);
    assert.equal(buildAchievedMonuments(s).built.length, 0);
    s = setIsland(s, DELOS, P1, 1);
    assert.deepEqual(buildAchievedMonuments(s).built, [{ playerId: P1, cardId: WAR_PORT, islandId: DELOS }]);
  });

  test('Monument staje zaraz po bitwie, w której gracz zdobył brakujący budynek', () => {
    // P1 ma Port na Naxos. Forteca stoi na Paros gracza P2, który ma też Milos.
    const s = actionsScenario(ARES_TURN, (g) => {
      const board = setIsland(setIsland(setIsland(g, MILOS, P2), NAXOS, P1, 3), PAROS, P2, 1);
      return dealTo(withBuildings(withBuildings(board, NAXOS, ['PORT']), PAROS, ['FORTRESS']), P1, WAR_PORT);
    });
    const moved = moveTroops(withDice(s, [0]), { playerId: P1, from: NAXOS, to: PAROS, troops: 3 });
    if (!moved.ok) assert.fail(describeMoveRejection(moved.error));

    // Bez haków cyklu efekt stanowy poczeka na następną komendę...
    const withoutHooks = runBattle(moved.state).state;
    assert.equal(getIsland(withoutHooks.board, NAXOS).monumentSlot.monument, null);
    // ...a z hakami Monument staje przy powrocie do tury Aresa.
    const { state } = runBattle(moved.state, () => null, CYCLE_HOOKS);
    assert.equal(getIsland(state.board, PAROS).ownerId, P1);
    assert.equal(getIsland(state.board, NAXOS).monumentSlot.monument?.cardId, WAR_PORT);
    assertValid(state);
  });
});

// ===========================================================================
describe('Gigant', () => {
  test('Gigant niszczy budynek, ale nie Monument, który zostaje nawet bez wymaganych budynków', () => {
    const s = applyStateBasedEffects(dealTo(withBuildings(readyGame(), NAXOS, ['PORT', 'FORTRESS']), P1, WAR_PORT));
    assert.equal(getIsland(s.board, NAXOS).monumentSlot.monument?.cardId, WAR_PORT);
    assert.deepEqual(giantTargets(s, NAXOS), [0, 1], 'celem mogą być tylko budynki w slotach');
    assert.deepEqual(giantError(applyGiant(s, NAXOS, { kind: 'MONUMENT' })), { code: 'MONUMENT_IMMUNE', island: NAXOS });

    const hit = applyGiant(s, NAXOS, { kind: 'BUILDING', slot: 1 });
    assert.ok(hit.ok && hit.destroyed === 'FORTRESS');
    assert.equal(getIsland(hit.state.board, NAXOS).monumentSlot.monument?.cardId, WAR_PORT, 'Monument zostaje');
    assertValid(hit.state);

    assert.deepEqual(giantError(applyGiant(s, NAXOS, { kind: 'BUILDING', slot: 3 })), { code: 'NO_BUILDING', island: NAXOS, slot: 3 });
    assert.equal(giantError(applyGiant(s, IslandId('atlantyda'), { kind: 'BUILDING', slot: 0 })).code, 'UNKNOWN_ISLAND');
  });

  test('zniszczona Nekropolia traci zebrane JZ', () => {
    const base = readyGame();
    const hades = base.hades ?? assert.fail();
    const s = withBuildings({ ...base, hades: { ...hades, necropolisGold: { [NAXOS]: 4 } } }, NAXOS, ['NECROPOLIS']);
    const hit = applyGiant(assertValid(s), NAXOS, { kind: 'BUILDING', slot: 0 });
    assert.ok(hit.ok && hit.destroyed === 'NECROPOLIS');
    assert.equal(hit.state.hades?.necropolisGold[NAXOS], undefined);
    assertValid(hit.state);
  });

  test('każdy kod odrzucenia ma czytelny komunikat', () => {
    for (const error of [
      { code: 'UNKNOWN_ISLAND', island: NAXOS },
      { code: 'MONUMENT_IMMUNE', island: NAXOS },
      { code: 'NO_BUILDING', island: NAXOS, slot: 2 },
    ] as const satisfies readonly GiantRejection[]) {
      assert.ok(describeGiantRejection(error).length > 10);
    }
  });
});
