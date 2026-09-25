import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  checkLastIsland,
  describeMoveRejection,
  moveFleets,
  moveTroops,
  planFleetMove,
  planTroopMove,
  type FleetMoveCommand,
  type FleetStep,
  type MoveOutcome,
  type MoveRejection,
  type TroopMoveCommand,
} from '../src/engine/index.ts';
import {
  HeroId,
  IslandId,
  SeaId,
  expectPhase,
  finishGodTurn,
  getIsland,
  getPlayer,
  getSea,
  type GameState,
  type Metropolis,
  type PlayerId,
} from '../src/model/index.ts';
import {
  DELOS,
  MILOS,
  NAXOS,
  P1,
  P2,
  P3,
  PAROS,
  SEA_CENTER,
  SEA_EAST,
  SEA_NORTH,
  SEA_SOUTH,
  createSampleGame,
} from '../src/examples/sampleGame.ts';
import {
  ARES_TURN,
  POSEIDON_TURN,
  actionsScenario,
  assertValid,
  deepFreeze,
  setFleet,
  setIsland,
  updateIsland,
  updatePlayer,
} from './helpers.ts';

// ===========================================================================
// Scenariusze
// ===========================================================================
// Mapa przykładowa: morza Pd. — Pn. — Środk. — Wsch. tworzą ścieżkę.
// Naxos: Pn., Środk. | Paros: Środk., Wsch. | Delos: Pn., Pd. | Milos: Wsch.
// readyGame: P1 Naxos (2 oddziały) + flota na Środk., P2 Paros (2) + flota na Wsch.,
// P3 Delos (2) + flota na Pd., Milos niczyja. Każdy gracz ma 5 JZ.

const fleets = (from: SeaId, count: number, ...route: FleetStep[]): FleetMoveCommand => ({ playerId: P1, from, count, route });
const to = (sea: SeaId, extra: Omit<FleetStep, 'to'> = {}): FleetStep => ({ to: sea, ...extra });
const troops = (from: IslandId, target: IslandId, count: number, extra: Partial<TroopMoveCommand> = {}): TroopMoveCommand => ({
  playerId: P1,
  from,
  to: target,
  troops: count,
  ...extra,
});

function succeeded<T>(outcome: MoveOutcome<T>): { state: GameState; plan: T } {
  if (!outcome.ok) assert.fail(describeMoveRejection(outcome.error));
  return { state: assertValid(outcome.state), plan: outcome.plan };
}

function rejected(outcome: { ok: boolean; error?: MoveRejection }): MoveRejection {
  assert.equal(outcome.ok, false, 'ruch powinien zostać odrzucony');
  return outcome.error as MoveRejection;
}

const fleetsAt = (s: GameState, sea: SeaId) => {
  const fleet = getSea(s.board, sea).fleet;
  return fleet ? [fleet.playerId, fleet.fleets] : null;
};

const metropolis: Metropolis = { origin: 'BUILDINGS', builtInCycle: 1 };

// ===========================================================================
describe('Ruch flot (Posejdon)', () => {
  test('grupa płynie do 3 pól i dołącza do własnej floty na polu docelowym', () => {
    let s = actionsScenario(POSEIDON_TURN, (g) => setFleet(setFleet(g, SEA_CENTER, P1, 3), SEA_SOUTH, P1, 1));
    const first = succeeded(moveFleets(s, fleets(SEA_CENTER, 2, to(SEA_NORTH), to(SEA_SOUTH))));
    s = first.state;
    assert.deepEqual(first.plan.path, [SEA_CENTER, SEA_NORTH, SEA_SOUTH]);
    assert.deepEqual([fleetsAt(s, SEA_CENTER), fleetsAt(s, SEA_NORTH), fleetsAt(s, SEA_SOUTH)], [[P1, 1], null, [P1, 3]]);
    assert.equal(getPlayer(s, P1).gold, 4, 'ruch kosztuje 1 JZ');
    assert.equal(expectPhase(s, 'ACTIONS').progress.movements, 1);

    // Pełny zasięg: 3 pola, z Pd. aż na Wsch. (po usunięciu floty P2).
    s = setFleet(s, SEA_EAST, null);
    s = succeeded(moveFleets(s, fleets(SEA_SOUTH, 3, to(SEA_NORTH), to(SEA_CENTER), to(SEA_EAST)))).state;
    assert.deepEqual([fleetsAt(s, SEA_SOUTH), fleetsAt(s, SEA_CENTER), fleetsAt(s, SEA_EAST)], [null, [P1, 1], [P1, 3]]);
  });

  test('trasa ma od 1 do 3 kroków, a każdy krok prowadzi na sąsiednie pole', () => {
    const s = actionsScenario(POSEIDON_TURN);
    assert.deepEqual(rejected(planFleetMove(s, fleets(SEA_CENTER, 1))), { code: 'ROUTE_LENGTH', length: 0, max: 3 });
    assert.deepEqual(
      rejected(planFleetMove(s, fleets(SEA_CENTER, 1, to(SEA_NORTH), to(SEA_CENTER), to(SEA_NORTH), to(SEA_CENTER)))),
      { code: 'ROUTE_LENGTH', length: 4, max: 3 },
    );
    assert.deepEqual(rejected(planFleetMove(s, fleets(SEA_CENTER, 1, to(SEA_SOUTH)))), {
      code: 'NOT_ADJACENT',
      from: SEA_CENTER,
      to: SEA_SOUTH,
    });
    assert.deepEqual(rejected(planFleetMove(s, fleets(SEA_CENTER, 1, to(SeaId('atlantyk'))))), {
      code: 'UNKNOWN_SEA',
      sea: SeaId('atlantyk'),
    });
  });

  test('po drodze grupa zabiera i zostawia własne floty', () => {
    let s = actionsScenario(POSEIDON_TURN, (g) => setFleet(setFleet(g, SEA_NORTH, P1, 2), SEA_SOUTH, null));

    const pickUp = succeeded(moveFleets(s, fleets(SEA_CENTER, 1, to(SEA_NORTH, { pickUp: 2 }), to(SEA_SOUTH))));
    s = pickUp.state;
    assert.equal(pickUp.plan.arriving, 3);
    assert.deepEqual([fleetsAt(s, SEA_CENTER), fleetsAt(s, SEA_NORTH), fleetsAt(s, SEA_SOUTH)], [null, null, [P1, 3]]);

    const dropOff = succeeded(moveFleets(s, fleets(SEA_SOUTH, 3, to(SEA_NORTH, { dropOff: 1 }), to(SEA_CENTER))));
    s = dropOff.state;
    assert.equal(dropOff.plan.arriving, 2);
    assert.deepEqual([fleetsAt(s, SEA_SOUTH), fleetsAt(s, SEA_NORTH), fleetsAt(s, SEA_CENTER)], [null, [P1, 1], [P1, 2]]);
    assert.equal(getPlayer(s, P1).gold, 3, 'dwa ruchy po 1 JZ');
  });

  test('trasa może wrócić na pole startowe, a dostępność flot liczy się dynamicznie', () => {
    const s = actionsScenario(POSEIDON_TURN, (g) => setFleet(setFleet(g, SEA_NORTH, P1, 2), SEA_CENTER, P1, 3));
    const { state, plan } = succeeded(moveFleets(s, fleets(SEA_CENTER, 1, to(SEA_NORTH, { pickUp: 2 }), to(SEA_CENTER))));
    assert.deepEqual(plan.changes, [
      { sea: SEA_CENTER, delta: -1 },
      { sea: SEA_NORTH, delta: -2 },
    ]);
    assert.deepEqual([fleetsAt(state, SEA_CENTER), fleetsAt(state, SEA_NORTH)], [[P1, 5], null]);

    // Wszystkie 3 floty wypływają ze Środk., więc przy powrocie nie ma tam czego zabrać.
    assert.deepEqual(
      rejected(planFleetMove(s, fleets(SEA_CENTER, 3, to(SEA_NORTH), to(SEA_CENTER, { pickUp: 1 }), to(SEA_EAST)))),
      { code: 'NOT_ENOUGH_FLEETS', sea: SEA_CENTER, requested: 1, available: 0 },
    );
  });

  test('błędne zabieranie i zostawianie flot jest odrzucane', () => {
    const s = actionsScenario(POSEIDON_TURN, (g) => setFleet(setFleet(g, SEA_NORTH, P1, 2), SEA_SOUTH, null));
    const plan = (...route: FleetStep[]) => rejected(planFleetMove(s, fleets(SEA_CENTER, 1, ...route)));

    assert.deepEqual(plan(to(SEA_NORTH, { pickUp: 5 }), to(SEA_SOUTH)), {
      code: 'NOT_ENOUGH_FLEETS',
      sea: SEA_NORTH,
      requested: 5,
      available: 2,
    });
    assert.deepEqual(plan(to(SEA_NORTH, { dropOff: 1 }), to(SEA_SOUTH)), { code: 'GROUP_WOULD_BE_EMPTY', sea: SEA_NORTH });
    assert.deepEqual(plan(to(SEA_NORTH, { dropOff: 2 }), to(SEA_SOUTH)), {
      code: 'NOT_ENOUGH_FLEETS',
      sea: SEA_NORTH,
      requested: 2,
      available: 1,
    });
    assert.deepEqual(plan(to(SEA_NORTH, { pickUp: 1, dropOff: 1 }), to(SEA_SOUTH)), {
      code: 'AMBIGUOUS_WAYPOINT',
      sea: SEA_NORTH,
    });
    assert.deepEqual(plan(to(SEA_NORTH, { pickUp: 1 })), { code: 'WAYPOINT_AT_DESTINATION', sea: SEA_NORTH });
    assert.deepEqual(plan(to(SEA_NORTH, { pickUp: -1 }), to(SEA_SOUTH)), {
      code: 'INVALID_NUMBER',
      field: 'pickUp',
      value: -1,
    });
    assert.deepEqual(rejected(planFleetMove(s, fleets(SEA_CENTER, 1.5, to(SEA_NORTH)))), {
      code: 'INVALID_NUMBER',
      field: 'count',
      value: 1.5,
    });
  });

  test('wejście na pole z obcą flotą kończy ruch i rozpoczyna bitwę morską', () => {
    const s = actionsScenario(POSEIDON_TURN);
    const outcome = moveFleets(s, fleets(SEA_CENTER, 1, to(SEA_EAST)));
    const { state } = succeeded(outcome);
    assert.ok(outcome.ok && outcome.battle !== null);

    const phase = expectPhase(state, 'BATTLE_RESOLUTION');
    assert.deepEqual(phase.battle.location, { kind: 'SEA', seaId: SEA_EAST });
    assert.deepEqual(
      [phase.battle.attacker.playerId, phase.battle.attacker.units, phase.battle.attacker.origin],
      [P1, 1, SEA_CENTER],
    );
    assert.deepEqual([phase.battle.defender.playerId, phase.battle.defender.units], [P2, 1]);
    assert.deepEqual([fleetsAt(state, SEA_CENTER), fleetsAt(state, SEA_EAST)], [null, null], 'obie strony w kontekście bitwy');
    assert.equal(phase.resume.progress.movements, 1, 'ruch zaliczony przed bitwą');
    assert.equal(getPlayer(state, P1).gold, 4);
  });

  test('grupa może zabrać floty po drodze, zanim wpłynie do bitwy', () => {
    const s = actionsScenario(POSEIDON_TURN, (g) => setFleet(g, SEA_NORTH, P1, 2));
    const { state } = succeeded(moveFleets(s, fleets(SEA_CENTER, 1, to(SEA_NORTH, { pickUp: 2 }), to(SEA_SOUTH))));
    const { battle } = expectPhase(state, 'BATTLE_RESOLUTION');
    assert.deepEqual([battle.attacker.units, battle.attacker.origin, battle.defender.playerId], [3, SEA_NORTH, P3]);
  });

  test('trasa nie może prowadzić dalej przez pole z obcą flotą', () => {
    const s = actionsScenario(POSEIDON_TURN, (g) => setFleet(g, SEA_NORTH, P1, 1));
    assert.deepEqual(rejected(planFleetMove(s, fleets(SEA_CENTER, 1, to(SEA_EAST), to(SEA_CENTER)))), {
      code: 'ROUTE_CONTINUES_AFTER_BATTLE',
      sea: SEA_EAST,
    });
    assert.deepEqual(rejected(planFleetMove(s, fleets(SEA_NORTH, 1, to(SEA_SOUTH), to(SEA_NORTH)))), {
      code: 'ROUTE_CONTINUES_AFTER_BATTLE',
      sea: SEA_SOUTH,
    });
  });

  test('nie można ruszyć cudzej floty ani większej liczby flot, niż stoi na polu', () => {
    const s = actionsScenario(POSEIDON_TURN);
    assert.deepEqual(rejected(planFleetMove(s, fleets(SEA_EAST, 1, to(SEA_CENTER)))), { code: 'NO_OWN_FLEET', sea: SEA_EAST });
    assert.deepEqual(rejected(planFleetMove(s, fleets(SEA_CENTER, 2, to(SEA_NORTH)))), {
      code: 'NOT_ENOUGH_FLEETS',
      sea: SEA_CENTER,
      requested: 2,
      available: 1,
    });
  });

  test('ruch flot wymaga tury Posejdona, własnej niezakończonej tury i 1 JZ', () => {
    const move = fleets(SEA_CENTER, 1, to(SEA_NORTH));
    assert.deepEqual(rejected(moveFleets(actionsScenario(ARES_TURN), move)), {
      code: 'WRONG_GOD',
      required: 'POSEIDON',
      actual: 'ARES',
    });
    assert.deepEqual(rejected(moveFleets(actionsScenario(POSEIDON_TURN), { ...move, playerId: P2 })), {
      code: 'NOT_YOUR_TURN',
      expected: P1,
    });
    const broke = actionsScenario(POSEIDON_TURN, (g) => updatePlayer(g, P1, (p) => ({ ...p, gold: 0 })));
    assert.deepEqual(rejected(moveFleets(broke, move)), { code: 'CANNOT_AFFORD', cost: 1, gold: 0 });
    assert.deepEqual(rejected(moveFleets(finishGodTurn(actionsScenario(POSEIDON_TURN)), move)), { code: 'TURN_FINISHED' });
    assert.deepEqual(rejected(moveFleets(createSampleGame(), move)), { code: 'NOT_ACTIONS_PHASE', phase: 'INIT' });

    // Sam plan nie zależy od tury, więc nadaje się do podglądu i efektów kart.
    assert.equal(planFleetMove(actionsScenario(ARES_TURN), move).ok, true);
  });

  test('ruch jest czystą funkcją: nie modyfikuje stanu wejściowego', () => {
    const s = deepFreeze(actionsScenario(POSEIDON_TURN, (g) => setFleet(g, SEA_NORTH, P1, 2)));
    succeeded(moveFleets(s, fleets(SEA_CENTER, 1, to(SEA_NORTH, { pickUp: 2 }), to(SEA_SOUTH))));
    assert.deepEqual([fleetsAt(s, SEA_CENTER), fleetsAt(s, SEA_NORTH)], [[P1, 1], [P1, 2]]);
  });
});

// ===========================================================================
describe('Ruch wojsk (Ares)', () => {
  test('desant wymaga ciągłego łańcucha własnych flot, a obce floty mostem nie są', () => {
    const s = actionsScenario(ARES_TURN);
    assert.deepEqual(rejected(planTroopMove(s, troops(NAXOS, MILOS, 1))), {
      code: 'NO_FLEET_BRIDGE',
      from: NAXOS,
      to: MILOS,
    });

    const bridged = setFleet(s, SEA_EAST, P1, 1);
    const { state, plan } = succeeded(moveTroops(bridged, troops(NAXOS, MILOS, 1)));
    assert.deepEqual(plan.bridge, [SEA_CENTER, SEA_EAST]);
    assert.equal(plan.landing, 'COLONIZE');
    assert.equal(getIsland(state.board, MILOS).ownerId, P1);
    assert.deepEqual([getIsland(state.board, NAXOS).garrison?.troops, getIsland(state.board, MILOS).garrison?.troops], [1, 1]);
    assert.equal(getPlayer(state, P1).gold, 4);
  });

  test('atak na wyspę z wojskami przeciwnika rozpoczyna bitwę lądową', () => {
    const s = actionsScenario(ARES_TURN, (g) => setIsland(g, MILOS, P2)); // P2 ma dwie wyspy
    const { state, plan } = succeeded(moveTroops(s, troops(NAXOS, PAROS, 2)));
    assert.deepEqual([plan.landing, plan.defender, plan.bridge], ['ATTACK', P2, [SEA_CENTER]]);

    const { battle } = expectPhase(state, 'BATTLE_RESOLUTION');
    assert.deepEqual(battle.location, { kind: 'LAND', islandId: PAROS });
    assert.deepEqual([battle.attacker.units, battle.attacker.origin, battle.defender.units], [2, NAXOS, 2]);
    assert.deepEqual(
      [getIsland(state.board, PAROS).ownerId, getIsland(state.board, PAROS).garrison],
      [P2, null],
      'do rozstrzygnięcia wyspa należy do obrońcy',
    );
    assert.deepEqual(
      [getIsland(state.board, NAXOS).ownerId, getIsland(state.board, NAXOS).garrison],
      [P1, null],
      'opuszczona wyspa pozostaje własnością gracza',
    );
  });

  test('pusta wyspa przeciwnika zostaje zajęta bez bitwy, a własna dostaje posiłki', () => {
    const base = actionsScenario(ARES_TURN, (g) => setFleet(setIsland(g, MILOS, P2), SEA_EAST, P1, 1));
    const capture = succeeded(moveTroops(base, troops(NAXOS, MILOS, 1)));
    assert.equal(capture.plan.landing, 'CAPTURE');
    assert.equal(capture.state.phase.phase, 'ACTIONS');
    assert.equal(getIsland(capture.state.board, MILOS).ownerId, P1);

    const own = actionsScenario(ARES_TURN, (g) => setFleet(setIsland(g, MILOS, P1, 1), SEA_EAST, P1, 1));
    const reinforce = succeeded(moveTroops(own, troops(NAXOS, MILOS, 2)));
    assert.equal(reinforce.plan.landing, 'REINFORCE');
    assert.equal(getIsland(reinforce.state.board, MILOS).garrison?.troops, 3);
  });

  test('reguła ostatniej wyspy blokuje atak, chyba że daje on zwycięstwo', () => {
    // P2 ma tylko Paros.
    const s = actionsScenario(ARES_TURN);
    assert.deepEqual(rejected(planTroopMove(s, troops(NAXOS, PAROS, 1))), {
      code: 'LAST_ISLAND_PROTECTED',
      island: PAROS,
      defender: P2,
      metropolisesAfter: 0,
      required: 2,
    });

    // Metropolia na Paros to dopiero pierwsza Metropolia atakującego.
    const withMetropolis = updateIsland(s, PAROS, (i) => ({ ...i, metropolisSlot: { metropolis } }));
    assert.equal(rejected(planTroopMove(withMetropolis, troops(NAXOS, PAROS, 1))).code, 'LAST_ISLAND_PROTECTED');

    // Druga Metropolia oznacza zwycięstwo, więc atak jest dozwolony.
    const winning = updateIsland(withMetropolis, NAXOS, (i) => ({ ...i, metropolisSlot: { metropolis } }));
    const attack = planTroopMove(winning, troops(NAXOS, PAROS, 1));
    assert.ok(attack.ok && attack.plan.landing === 'ATTACK');
    assert.equal(checkLastIsland(winning, P1, PAROS), null);
  });

  test('reguła ostatniej wyspy dotyczy także pustej wyspy i można ją wyłączyć w zasadach', () => {
    // P3 ma tylko Delos, bez wojsk. Most: flota P1 na Morzu Pn.
    const s = actionsScenario(ARES_TURN, (g) => setFleet(setIsland(g, DELOS, P3), SEA_NORTH, P1, 1));
    assert.equal(rejected(planTroopMove(s, troops(NAXOS, DELOS, 1))).code, 'LAST_ISLAND_PROTECTED');

    const houseRules: GameState = { ...s, rules: { ...s.rules, movement: { ...s.rules.movement, protectLastIsland: false } } };
    const capture = planTroopMove(houseRules, troops(NAXOS, DELOS, 1));
    assert.ok(capture.ok && capture.plan.landing === 'CAPTURE');
    assert.equal(checkLastIsland(s, P1, NAXOS), null, 'własnej wyspy reguła nie dotyczy');
    assert.equal(checkLastIsland(s, P1, MILOS), null, 'wyspy niczyjej reguła nie dotyczy');
  });

  test('walidacja grupy i wysp', () => {
    const s = actionsScenario(ARES_TURN);
    const plan = (command: TroopMoveCommand) => rejected(planTroopMove(s, command));
    assert.deepEqual(plan(troops(NAXOS, PAROS, 3)), {
      code: 'NOT_ENOUGH_TROOPS',
      island: NAXOS,
      kind: 'TROOPS',
      requested: 3,
      available: 2,
    });
    assert.deepEqual(plan(troops(NAXOS, PAROS, 0, { undeadTroops: 1 })), {
      code: 'NOT_ENOUGH_TROOPS',
      island: NAXOS,
      kind: 'UNDEAD_TROOPS',
      requested: 1,
      available: 0,
    });
    assert.deepEqual(plan(troops(NAXOS, PAROS, 0)), { code: 'EMPTY_GROUP' });
    assert.deepEqual(plan(troops(NAXOS, PAROS, -1)), { code: 'INVALID_NUMBER', field: 'troops', value: -1 });
    assert.deepEqual(plan(troops(NAXOS, NAXOS, 1)), { code: 'SAME_ISLAND', island: NAXOS });
    assert.deepEqual(plan(troops(NAXOS, IslandId('atlantyda'), 1)), { code: 'UNKNOWN_ISLAND', island: IslandId('atlantyda') });
    assert.deepEqual(plan(troops(PAROS, NAXOS, 1)), { code: 'NO_OWN_TROOPS', island: PAROS });
    assert.deepEqual(plan(troops(NAXOS, PAROS, 1, { heroes: [HeroId('widmo')] })), {
      code: 'HERO_NOT_ON_ISLAND',
      hero: HeroId('widmo'),
      island: NAXOS,
    });
  });

  test('herosi mogą towarzyszyć oddziałom i przechodzą razem z nimi', () => {
    const heroId = HeroId('heros-1');
    const s = actionsScenario(ARES_TURN, (g) => {
      const card = g.creatureMarket.deck.find((id) => g.catalog.mythCards[id]?.type === 'HERO') ?? assert.fail();
      const withHero: GameState = {
        ...g,
        creatureMarket: { ...g.creatureMarket, deck: g.creatureMarket.deck.filter((id) => id !== card) },
        heroes: { [heroId]: { id: heroId, cardId: card, exhausted: false } },
      };
      const garrisoned = updateIsland(withHero, NAXOS, (i) => ({ ...i, garrison: i.garrison && { ...i.garrison, heroes: [heroId] } }));
      return setFleet(garrisoned, SEA_EAST, P1, 1);
    });
    const { state } = succeeded(moveTroops(s, troops(NAXOS, MILOS, 1, { heroes: [heroId] })));
    assert.deepEqual(getIsland(state.board, MILOS).garrison?.heroes, [heroId]);
    assert.deepEqual(getIsland(state.board, NAXOS).garrison?.heroes, []);
    assert.deepEqual(rejected(planTroopMove(s, troops(NAXOS, MILOS, 1, { heroes: [heroId, heroId] }))).code, 'HERO_NOT_ON_ISLAND');
  });

  test('ruch wojsk wymaga tury Aresa', () => {
    assert.deepEqual(rejected(moveTroops(actionsScenario(POSEIDON_TURN), troops(NAXOS, PAROS, 1))), {
      code: 'WRONG_GOD',
      required: 'ARES',
      actual: 'POSEIDON',
    });
  });
});

// ===========================================================================
describe('Komunikaty', () => {
  test('każdy kod odrzucenia ma czytelny komunikat', () => {
    const player: PlayerId = P2;
    const errors: MoveRejection[] = [
      { code: 'NOT_ACTIONS_PHASE', phase: 'BIDDING' },
      { code: 'NOT_YOUR_TURN', expected: null },
      { code: 'NOT_YOUR_TURN', expected: player },
      { code: 'WRONG_GOD', required: 'ARES', actual: 'ZEUS' },
      { code: 'TURN_FINISHED' },
      { code: 'CANNOT_AFFORD', cost: 1, gold: 0 },
      { code: 'UNKNOWN_PLAYER', playerId: player },
      { code: 'INVALID_NUMBER', field: 'count', value: -1 },
      { code: 'UNKNOWN_SEA', sea: SEA_NORTH },
      { code: 'NO_OWN_FLEET', sea: SEA_NORTH },
      { code: 'NOT_ENOUGH_FLEETS', sea: SEA_NORTH, requested: 2, available: 1 },
      { code: 'ROUTE_LENGTH', length: 4, max: 3 },
      { code: 'NOT_ADJACENT', from: SEA_NORTH, to: SEA_EAST },
      { code: 'ROUTE_CONTINUES_AFTER_BATTLE', sea: SEA_EAST },
      { code: 'WAYPOINT_AT_DESTINATION', sea: SEA_EAST },
      { code: 'AMBIGUOUS_WAYPOINT', sea: SEA_EAST },
      { code: 'GROUP_WOULD_BE_EMPTY', sea: SEA_EAST },
      { code: 'UNKNOWN_ISLAND', island: NAXOS },
      { code: 'SAME_ISLAND', island: NAXOS },
      { code: 'NO_OWN_TROOPS', island: NAXOS },
      { code: 'EMPTY_GROUP' },
      { code: 'NOT_ENOUGH_TROOPS', island: NAXOS, kind: 'TROOPS', requested: 3, available: 2 },
      { code: 'HERO_NOT_ON_ISLAND', hero: HeroId('h'), island: NAXOS },
      { code: 'NO_FLEET_BRIDGE', from: NAXOS, to: MILOS },
      { code: 'LAST_ISLAND_PROTECTED', island: PAROS, defender: player, metropolisesAfter: 1, required: 2 },
    ];
    for (const error of errors) assert.ok(describeMoveRejection(error).length > 10, error.code);
  });
});
