import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CYCLE_HOOKS,
  buildNecropolis,
  describeHadesRejection,
  describeMoveRejection,
  hadesInPlay,
  moveTroops,
  nextUndeadCost,
  recruitUndead,
  runBattle,
  type HadesOutcome,
  type HadesRejection,
  type RecruitUndeadCommand,
} from '../src/engine/index.ts';
import {
  DEFAULT_RULESET,
  IslandId,
  checkVictory,
  expectPhase,
  getIsland,
  getPlayer,
  getSea,
  transition,
  type GameCatalog,
  type GameState,
  type GodTurn,
  type HadesLevel,
  type HadesRules,
} from '../src/model/index.ts';
import {
  DELOS,
  MILOS,
  NAXOS,
  P1,
  P2,
  P3,
  PAROS,
  SAMPLE_CATALOG,
  SEA_CENTER,
  SEA_EAST,
  SEA_NORTH,
  SEA_SOUTH,
  createSampleGame,
} from '../src/examples/sampleGame.ts';
import {
  ARES_TURN,
  actionsScenario,
  addUndead,
  assertValid,
  playAllTurns,
  readyGame,
  setFleet,
  setIsland,
  updatePlayer,
  withBuildings,
  withDice,
} from './helpers.ts';

// ===========================================================================
// Scenariusze
// ===========================================================================

const HADES_TURN: readonly GodTurn[] = [
  { god: 'HADES', playerId: P1 },
  { god: 'ARES', playerId: P2 },
  { god: 'APOLLO', playerId: P3 },
];

function withHadesRules(state: GameState, rules: Partial<HadesRules>): GameState {
  return { ...state, rules: { ...state.rules, hades: { ...state.rules.hades, ...rules } } };
}

function withThreat(state: GameState, level: HadesLevel): GameState {
  const hades = state.hades ?? assert.fail('dodatek Hades wyłączony');
  return { ...state, hades: { ...hades, threat: { ...hades.threat, level } } };
}

function withNecropolisGold(state: GameState, gold: Readonly<Record<IslandId, number>>): GameState {
  const hades = state.hades ?? assert.fail('dodatek Hades wyłączony');
  return { ...state, hades: { ...hades, necropolisGold: gold } };
}

/** Stan tuż przed GODS_SETUP pierwszego cyklu (po odświeżeniu toru stworów). */
function beforeGodsSetup(setup: (s: GameState) => GameState = (s) => s): GameState {
  const refreshed = transition(readyGame(), { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, CYCLE_HOOKS);
  return assertValid(setup(refreshed));
}

const godsSetup = (state: GameState): GameState =>
  assertValid(transition(state, { phase: 'GODS_SETUP', revealed: [], hadesSummoned: false }, CYCLE_HOOKS));

function ok(outcome: HadesOutcome): GameState {
  if (!outcome.ok) assert.fail(describeHadesRejection(outcome.error));
  return assertValid(outcome.state);
}

function rejected(outcome: HadesOutcome): HadesRejection {
  if (outcome.ok) assert.fail('akcja powinna zostać odrzucona');
  return outcome.error;
}

const undead = (kind: RecruitUndeadCommand['kind'], to: RecruitUndeadCommand['to']): RecruitUndeadCommand => ({
  playerId: P1,
  kind,
  to,
});

const rich = (s: GameState): GameState => updatePlayer(s, P1, (p) => ({ ...p, gold: 20 }));

// ===========================================================================
describe('Kolumna Hadesa', () => {
  test('na początku cyklu rzut dwiema kośćmi przesuwa kolumnę o sumę oczek', () => {
    const s = godsSetup(beforeGodsSetup((g) => withHadesRules(g, { threatDieFaces: [2] })));
    assert.deepEqual(s.hades?.lastThreatRoll, [2, 2]);
    assert.deepEqual(s.hades?.threat, { level: 4, summonPending: false });
    assert.equal(hadesInPlay(s), false);
    assert.equal(s.gods.slots.length, 2);
  });

  test('domyślnie rzuca się dwiema kośćmi bitewnymi, a kolumna nie wychodzi poza 0-9', () => {
    assert.equal(DEFAULT_RULESET.hades.threatDiceCount, 2);
    assert.deepEqual(DEFAULT_RULESET.hades.threatDieFaces, [0, 1, 1, 2, 2, 3]);
    const start = beforeGodsSetup();
    for (let seed = 0; seed < 50; seed++) {
      const rolled = godsSetup({ ...start, rng: { algorithm: 'mulberry32', state: seed } });
      const roll = rolled.hades?.lastThreatRoll ?? assert.fail('brak rzutu');
      assert.equal(roll.length, 2);
      assert.ok(roll.every((value) => DEFAULT_RULESET.hades.threatDieFaces.includes(value)));
      assert.equal(rolled.hades?.threat.level, roll[0]! + roll[1]!, 'z poziomu 0 suma nie przekracza 6');
    }
  });

  test('gdy kolumna osiągnie 9, Hades zastępuje boga stojącego nad Apollem na ten cykl', () => {
    const s = godsSetup(beforeGodsSetup((g) => withThreat(withHadesRules(g, { threatDieFaces: [1] }), 7)));
    const phase = expectPhase(s, 'GODS_SETUP');
    assert.equal(phase.hadesSummoned, true);
    assert.equal(s.gods.slots.at(-1)?.god, 'HADES', 'Hades stoi tuż nad Apollem');
    assert.equal(s.gods.slots.length, 2, 'Hades zastępuje boga, nie dochodzi jako dodatkowy');
    assert.deepEqual(phase.revealed, s.gods.slots.map((slot) => slot.god));
    assert.equal(s.gods.unavailable.length, 3, 'zastąpiony bóg zostaje odłożony');
    assert.deepEqual(s.hades?.threat, { level: 0, summonPending: false }, 'po przywołaniu kolumna wraca na 0');
  });

  test('przekroczenie 9 też przywołuje Hadesa, bo kolumna zatrzymuje się na 9', () => {
    const s = godsSetup(beforeGodsSetup((g) => withThreat(withHadesRules(g, { threatDieFaces: [3] }), 8)));
    assert.equal(hadesInPlay(s), true);
  });

  test('bez dodatku Hades nie ma rzutu ani Hadesa na torze', () => {
    const catalog: GameCatalog = {
      ...SAMPLE_CATALOG,
      mythCards: Object.fromEntries(Object.entries(SAMPLE_CATALOG.mythCards).filter(([, card]) => card.type !== 'HERO')),
    };
    const base = createSampleGame({ catalog, rules: { ...DEFAULT_RULESET, expansions: { hades: false, monuments: true } } });
    const ready: GameState = { ...base, phase: { phase: 'INIT', step: 'READY', placementQueue: [] } };
    const refreshed = transition(ready, { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, CYCLE_HOOKS);
    const s = godsSetup(refreshed);
    assert.equal(s.hades, null);
    assert.equal(hadesInPlay(s), false);
  });
});

// ===========================================================================
describe('Tura Hadesa: nieumarli', () => {
  test('rekrutacja nieumarłych oddziałów na własnej wyspie i flot przy własnej wyspie', () => {
    let s = actionsScenario(HADES_TURN, rich);
    s = ok(recruitUndead(s, undead('TROOP', NAXOS)));
    assert.equal(getIsland(s.board, NAXOS).garrison?.undeadTroops, 1);
    assert.deepEqual([s.hades?.undeadSupply.troops, getPlayer(s, P1).gold], [7, 20], 'pierwszy nieumarły jest darmowy');

    assert.equal(nextUndeadCost(s, 'TROOP'), 1, 'kolejny kosztuje więcej');
    s = ok(recruitUndead(s, undead('TROOP', NAXOS)));
    assert.equal(getPlayer(s, P1).gold, 19);

    s = ok(recruitUndead(s, undead('FLEET', SEA_NORTH)));
    assert.deepEqual(getSea(s.board, SEA_NORTH).fleet, { playerId: P1, fleets: 0, undeadFleets: 1 });
    s = ok(recruitUndead(s, undead('FLEET', SEA_CENTER)));
    assert.deepEqual(getSea(s.board, SEA_CENTER).fleet, { playerId: P1, fleets: 1, undeadFleets: 1 }, 'dołącza do własnej floty');
    assert.equal(getPlayer(s, P1).gold, 18, 'floty mają osobny licznik kosztów');
  });

  test('błędne miejsce rekrutacji jest odrzucane z powodem', () => {
    const s = actionsScenario(HADES_TURN, rich);
    const problem = (state: GameState, command: RecruitUndeadCommand) => {
      const error = rejected(recruitUndead(state, command));
      return error.code === 'INVALID_PLACEMENT' ? error.problem : error.code;
    };
    assert.equal(problem(s, undead('TROOP', PAROS)), 'NOT_OWN_ISLAND');
    assert.equal(problem(s, undead('TROOP', SEA_NORTH)), 'WRONG_NODE_TYPE');
    assert.equal(problem(s, undead('TROOP', IslandId('atlantyda'))), 'UNKNOWN_NODE');
    assert.equal(problem(s, undead('FLEET', SEA_EAST)), 'ENEMY_FLEET');
    // Morze Pd. przylega tylko do Delos (wyspy P3).
    assert.equal(problem(assertValid(setFleet(s, SEA_SOUTH, null)), undead('FLEET', SEA_SOUTH)), 'NOT_NEXT_TO_OWN_ISLAND');
  });

  test('limit rekrutacji w turze, pusta pula, brak złota i zła tura', () => {
    let s = actionsScenario(HADES_TURN, rich);
    for (let i = 0; i < 4; i++) s = ok(recruitUndead(s, undead('TROOP', NAXOS)));
    assert.deepEqual(rejected(recruitUndead(s, undead('TROOP', NAXOS))), { code: 'RECRUIT_LIMIT', kind: 'TROOP', limit: 4 });

    // Pusta pula musi zgadzać się z zasadą zachowania, więc w zasadach też jest 0 figurek.
    const empty = actionsScenario(HADES_TURN, (g) => {
      const hades = g.hades ?? assert.fail();
      const noUndead = withHadesRules(g, { undeadTroops: 0 });
      return rich({ ...noUndead, hades: { ...hades, undeadSupply: { troops: 0, fleets: 8 } } });
    });
    assert.deepEqual(rejected(recruitUndead(empty, undead('TROOP', NAXOS))), { code: 'NO_UNDEAD_LEFT', kind: 'TROOP' });

    const broke = actionsScenario(HADES_TURN, (g) => updatePlayer(g, P1, (p) => ({ ...p, gold: 0 })));
    const afterFree = ok(recruitUndead(broke, undead('TROOP', NAXOS)));
    assert.deepEqual(rejected(recruitUndead(afterFree, undead('TROOP', NAXOS))), { code: 'CANNOT_AFFORD', cost: 1, gold: 0 });

    assert.deepEqual(rejected(recruitUndead(actionsScenario(ARES_TURN), undead('TROOP', NAXOS))), {
      code: 'WRONG_GOD',
      required: 'HADES',
      actual: 'ARES',
    });
  });

  test('na koniec cyklu z Hadesem wszyscy nieumarli znikają z planszy', () => {
    let s = actionsScenario(HADES_TURN, rich);
    s = ok(recruitUndead(s, undead('TROOP', NAXOS)));
    s = ok(recruitUndead(s, undead('FLEET', SEA_NORTH)));
    s = playAllTurns(s);
    s = assertValid(transition(s, { phase: 'END_OF_CYCLE', victory: checkVictory(s) }, CYCLE_HOOKS));

    assert.deepEqual(getIsland(s.board, NAXOS).garrison, { playerId: P1, troops: 2, undeadTroops: 0, heroes: [] });
    assert.equal(getSea(s.board, SEA_NORTH).fleet, null, 'pole z samymi nieumarłymi pustoszeje');
    assert.deepEqual(s.hades?.undeadSupply, { troops: 8, fleets: 8 }, 'wszyscy wracają do puli');
  });

  test('w cyklu bez Hadesa nieumarli nie znikają', () => {
    let s = actionsScenario(ARES_TURN, (g) => addUndead(g, NAXOS, 1));
    s = playAllTurns(s);
    s = assertValid(transition(s, { phase: 'END_OF_CYCLE', victory: checkVictory(s) }, CYCLE_HOOKS));
    assert.equal(getIsland(s.board, NAXOS).garrison?.undeadTroops, 1);
  });
});

// ===========================================================================
describe('Nekropolia', () => {
  test('budowa w turze Hadesa: na własnej wyspie, najwyżej jedna na wyspę', () => {
    const s = actionsScenario(HADES_TURN);
    const built = ok(buildNecropolis(s, { playerId: P1, islandId: NAXOS }));
    assert.equal(getIsland(built.board, NAXOS).buildingSlots[0]?.building, 'NECROPOLIS');
    assert.equal(getPlayer(built, P1).gold, 3, 'Nekropolia kosztuje 2 JZ');
    assert.equal(built.hades?.necropolisGold[NAXOS], 0);
    assert.deepEqual(expectPhase(built, 'ACTIONS').progress.buildingsBuilt, ['NECROPOLIS']);

    assert.deepEqual(rejected(buildNecropolis(built, { playerId: P1, islandId: NAXOS })), { code: 'NECROPOLIS_EXISTS', island: NAXOS });
    assert.deepEqual(rejected(buildNecropolis(s, { playerId: P1, islandId: PAROS })), { code: 'NOT_OWN_ISLAND', island: PAROS });
    const full = withBuildings(s, NAXOS, ['PORT', 'FORTRESS', 'TEMPLE', 'UNIVERSITY']);
    assert.deepEqual(rejected(buildNecropolis(full, { playerId: P1, islandId: NAXOS })), { code: 'NO_FREE_SLOT', island: NAXOS });
    const poor = updatePlayer(s, P1, (p) => ({ ...p, gold: 1 }));
    assert.deepEqual(rejected(buildNecropolis(poor, { playerId: P1, islandId: NAXOS })), { code: 'CANNOT_AFFORD', cost: 2, gold: 1 });
  });

  test('zbiera 1 JZ za każdą zniszczoną zwykłą jednostkę, a nieumarli się nie liczą', () => {
    // Nekropolia P3 na Delos. P1 atakuje Paros: 1 oddział + 1 nieumarły przeciw 2 oddziałom, same remisy.
    const s = actionsScenario(ARES_TURN, (g) => {
      const board = setIsland(setIsland(setIsland(g, MILOS, P2), NAXOS, P1, 1), PAROS, P2, 2);
      const withNecropolis = withBuildings(withNecropolisGold(board, { [DELOS]: 0 }), DELOS, ['NECROPOLIS']);
      return addUndead(withNecropolis, NAXOS, 1);
    });
    const moved = moveTroops(withDice(s, [0]), { playerId: P1, from: NAXOS, to: PAROS, troops: 1, undeadTroops: 1 });
    if (!moved.ok) assert.fail(describeMoveRejection(moved.error));
    const { state, events } = runBattle(moved.state, () => null, CYCLE_HOOKS);

    const casualties = events.flatMap((e) =>
      e.type === 'ROUND_RESOLVED' ? [e.round.attacker.casualty, e.round.defender.casualty] : [],
    );
    assert.equal(casualties.filter((c) => c?.kind === 'UNIT').length, 3, 'zginęły 3 zwykłe oddziały');
    assert.ok(casualties.some((c) => c?.kind === 'UNDEAD'), 'zginął też nieumarły');
    assert.equal(state.hades?.necropolisGold[DELOS], 3);
    assertValid(state);
  });

  test('w fazie dochodu właściciel zabiera zebrane JZ, dokładnie raz', () => {
    const s = withBuildings(withNecropolisGold(godsSetup(beforeGodsSetup()), { [NAXOS]: 3 }), NAXOS, ['NECROPOLIS']);
    const goldBefore = getPlayer(s, P1).gold;

    const income = assertValid(transition(s, { phase: 'INCOME', report: {} }, CYCLE_HOOKS));
    assert.deepEqual(expectPhase(income, 'INCOME').report[P1], { islands: 2, tradeRoutes: 1, necropolis: 3, total: 6 });
    assert.equal(getPlayer(income, P1).gold, goldBefore + 6);
    assert.equal(income.hades?.necropolisGold[NAXOS], 0, 'pula opróżniona po wypłacie');
  });

  test('pula należy do budynku: po zdobyciu wyspy JZ zabiera nowy właściciel', () => {
    let s = withBuildings(withNecropolisGold(godsSetup(beforeGodsSetup()), { [NAXOS]: 2 }), NAXOS, ['NECROPOLIS']);
    s = setIsland(s, NAXOS, P2, 1);
    const income = assertValid(transition(s, { phase: 'INCOME', report: {} }, CYCLE_HOOKS));
    assert.equal(expectPhase(income, 'INCOME').report[P2]?.necropolis, 2);
    assert.equal(expectPhase(income, 'INCOME').report[P1]?.necropolis, 0);
  });
});

describe('Komunikaty dodatku Hades', () => {
  test('każdy kod odrzucenia ma czytelny komunikat', () => {
    const errors: HadesRejection[] = [
      { code: 'HADES_DISABLED' },
      { code: 'WRONG_GOD', required: 'HADES', actual: 'ARES' },
      { code: 'RECRUIT_LIMIT', kind: 'FLEET', limit: 4 },
      { code: 'NO_UNDEAD_LEFT', kind: 'TROOP' },
      { code: 'CANNOT_AFFORD', cost: 2, gold: 1 },
      { code: 'INVALID_PLACEMENT', to: NAXOS, problem: 'ENEMY_FLEET' },
      { code: 'UNKNOWN_ISLAND', island: NAXOS },
      { code: 'NOT_OWN_ISLAND', island: NAXOS },
      { code: 'NECROPOLIS_EXISTS', island: NAXOS },
      { code: 'NO_FREE_SLOT', island: NAXOS },
    ];
    for (const error of errors) assert.ok(describeHadesRejection(error).length > 10, error.code);
  });
});
