import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  battleScore,
  battleStepLimit,
  describeBattleRejection,
  describeMoveRejection,
  moveFleets,
  moveTroops,
  pendingDecision,
  planTroopMove,
  retreatOptions,
  rollBattleDie,
  runBattle,
  stepBattle,
  type BattleCommand,
  type BattleEvent,
  type BattleRejection,
  type BattleStepOutcome,
  type RetreatDecider,
} from '../src/engine/index.ts';
import {
  CardId,
  DEFAULT_RULESET,
  HeroId,
  MonumentCardId,
  countMetropolises,
  expectPhase,
  getIsland,
  getPlayer,
  getSea,
  nextInt,
  seedRng,
  type BattleOutcome,
  type BattleRound,
  type BuildingType,
  type GameState,
  type Metropolis,
  type PlayerId,
} from '../src/model/index.ts';
import { MILOS, NAXOS, P1, P2, P3, PAROS, SEA_CENTER, SEA_EAST, DELOS } from '../src/examples/sampleGame.ts';
import {
  ARES_TURN,
  POSEIDON_TURN,
  actionsScenario,
  addHero,
  addUndead,
  assertValid,
  buildMonument,
  setFleet,
  setIsland,
  updateBattle,
  updateIsland,
  withBuildings,
  withDice,
} from './helpers.ts';

// ===========================================================================
// Scenariusze
// ===========================================================================
// Mapa: morza Pd. — Pn. — Środk. — Wsch.; Naxos: Pn., Środk.; Paros: Środk., Wsch.; Milos: Wsch.
// Bitwa lądowa: P1 (Ares) atakuje z Naxos wyspę Paros gracza P2, po moście z floty na Morzu Środk.
// P2 ma też Milos, więc reguła ostatniej wyspy nie blokuje ataku. P2 może się wycofać
// na Milos (flota na Morzu Wsch.), a P1 na Naxos (flota na Morzu Środk.).

const ULYSSES = HeroId('ulisses');
const ACHILLES = HeroId('achilles');
const metropolis: Metropolis = { origin: 'BUILDINGS', builtInCycle: 1 };

interface LandSetup {
  readonly attackers?: number;
  readonly defenders?: number;
  readonly undead?: number;
  readonly heroes?: readonly HeroId[];
  readonly faces?: readonly number[];
  readonly setup?: (s: GameState) => GameState;
}

/** Bitwa lądowa o Paros po ruchu Aresa gracza P1. */
function landBattle(options: LandSetup = {}): GameState {
  const attackers = options.attackers ?? 2;
  const s = actionsScenario(ARES_TURN, (g) => {
    const board = setIsland(setIsland(setIsland(g, MILOS, P2), NAXOS, P1, attackers), PAROS, P2, options.defenders ?? 2);
    return options.setup ? options.setup(board) : board;
  });
  const moved = moveTroops(withDice(s, options.faces ?? [0]), {
    playerId: P1,
    from: NAXOS,
    to: PAROS,
    troops: attackers,
    undeadTroops: options.undead ?? 0,
    heroes: options.heroes ?? [],
  });
  if (!moved.ok) assert.fail(describeMoveRejection(moved.error));
  return assertValid(moved.state);
}

interface SeaSetup {
  readonly attackers?: number;
  readonly defenders?: number;
  /** Floty P1, które zostają na Morzu Środk. */
  readonly stay?: number;
  readonly faces?: readonly number[];
  readonly setup?: (s: GameState) => GameState;
}

/** Bitwa morska na Morzu Wsch. po ruchu Posejdona gracza P1 z Morza Środk. */
function seaBattle(options: SeaSetup = {}): GameState {
  const attackers = options.attackers ?? 1;
  const s = actionsScenario(POSEIDON_TURN, (g) => {
    const board = setFleet(setFleet(g, SEA_CENTER, P1, attackers + (options.stay ?? 0)), SEA_EAST, P2, options.defenders ?? 1);
    return options.setup ? options.setup(board) : board;
  });
  const moved = moveFleets(withDice(s, options.faces ?? [0]), {
    playerId: P1,
    from: SEA_CENTER,
    count: attackers,
    route: [{ to: SEA_EAST }],
  });
  if (!moved.ok) assert.fail(describeMoveRejection(moved.error));
  return assertValid(moved.state);
}

const battleOf = (s: GameState) => expectPhase(s, 'BATTLE_RESOLUTION').battle;

function step(state: GameState, command: BattleCommand): { state: GameState; events: readonly BattleEvent[] } {
  const outcome = stepBattle(state, command);
  if (!outcome.ok) assert.fail(describeBattleRejection(outcome.error));
  return { state: assertValid(outcome.state), events: outcome.events };
}

function rejected(outcome: BattleStepOutcome): BattleRejection {
  if (outcome.ok) assert.fail('krok powinien zostać odrzucony');
  return outcome.error;
}

const ROLL: BattleCommand = { type: 'ROLL' };
const CLEANUP: BattleCommand = { type: 'CLEANUP' };
const hold = (playerId: PlayerId): BattleCommand => ({ type: 'HOLD', playerId });

// ===========================================================================
describe('Wynik starcia: kość + jednostki + modyfikatory', () => {
  test('kość bitewna ma ścianki 0, 1, 1, 2, 2, 3', () => {
    assert.deepEqual(DEFAULT_RULESET.combat.dieFaces, [0, 1, 1, 2, 2, 3]);
    let rng = seedRng('kosc');
    const counts = new Map<number, number>();
    const throws = 12_000;
    for (let i = 0; i < throws; i++) {
      const [value, next] = rollBattleDie(rng, DEFAULT_RULESET.combat.dieFaces);
      rng = next;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    assert.deepEqual([...counts.keys()].sort(), [0, 1, 2, 3]);
    for (const [value, expected] of [[0, 1 / 6], [1, 2 / 6], [2, 2 / 6], [3, 1 / 6]] as const) {
      const frequency = (counts.get(value) ?? 0) / throws;
      assert.ok(Math.abs(frequency - expected) < 0.02, `ścianka ${value}: ${frequency.toFixed(3)} zamiast ${expected.toFixed(3)}`);
    }
  });

  test('obrona lądu: +1 za każdą Fortecę na wyspie, a Metropolia liczy się jak Forteca', () => {
    const s = landBattle({
      setup: (g) => updateIsland(withBuildings(g, PAROS, ['FORTRESS', 'FORTRESS', 'TEMPLE']), PAROS, (i) => ({ ...i, metropolisSlot: { metropolis } })),
    });
    assert.deepEqual(battleScore(s, battleOf(s), 'DEFENDER', 2), {
      roll: 2,
      units: 2,
      heroes: 0,
      supportFleets: 0,
      fortifications: 3,
      fortificationsIgnored: false,
      bonus: 0,
      total: 7,
      modifiers: [
        { source: 'FORTRESS', islandId: PAROS, value: 2 },
        { source: 'METROPOLIS', islandId: PAROS, countsAs: 'FORTRESS', value: 1 },
      ],
    });
    assert.equal(battleScore(s, battleOf(s), 'ATTACKER', 1).total, 3, 'atakujący nie ma premii za budynki');
  });

  test('obrona morza: +1 za każdy Port na sąsiednich wyspach obrońcy', () => {
    const s = seaBattle({
      setup: (g) => {
        // Paros (P2): Port + Metropolia = 2. Milos należy do atakującego, więc jego Port się nie liczy.
        const paros = updateIsland(withBuildings(g, PAROS, ['PORT']), PAROS, (i) => ({ ...i, metropolisSlot: { metropolis } }));
        return withBuildings(setIsland(paros, MILOS, P1), MILOS, ['PORT']);
      },
    });
    assert.equal(battleScore(s, battleOf(s), 'DEFENDER', 0).fortifications, 2);
    assert.deepEqual(battleScore(s, battleOf(s), 'DEFENDER', 0).modifiers, [
      { source: 'PORT', islandId: PAROS, value: 1 },
      { source: 'METROPOLIS', islandId: PAROS, countsAs: 'PORT', value: 1 },
    ]);
    assert.equal(battleScore(s, battleOf(s), 'ATTACKER', 0).fortifications, 0);
  });

  test('Ulisses w szeregach atakującego ignoruje Fortece i Metropolię obrońcy', () => {
    const s = landBattle({
      heroes: [ULYSSES],
      setup: (g) => {
        const fortified = updateIsland(withBuildings(g, PAROS, ['FORTRESS']), PAROS, (i) => ({ ...i, metropolisSlot: { metropolis } }));
        return addHero(fortified, NAXOS, ULYSSES, CardId('h-ulysses'));
      },
    });
    const defender = battleScore(s, battleOf(s), 'DEFENDER', 0);
    assert.deepEqual([defender.fortifications, defender.fortificationsIgnored], [0, true]);
    assert.deepEqual(defender.modifiers, [
      { source: 'FORTRESS', islandId: PAROS, value: 1 },
      { source: 'METROPOLIS', islandId: PAROS, countsAs: 'FORTRESS', value: 1 },
      { source: 'FORTIFICATIONS_IGNORED', heroId: ULYSSES, value: -2 },
    ], 'raport pokazuje, co Ulisses zniósł');
    assert.equal(battleScore(s, battleOf(s), 'ATTACKER', 0).heroes, 1, 'siła Ulissesa liczy się do jednostek');
    assert.deepEqual(battleScore(s, battleOf(s), 'ATTACKER', 0).modifiers, [{ source: 'HERO', heroId: ULYSSES, value: 1 }]);
  });

  test('nieumarli i siła herosów liczą się do liczby jednostek', () => {
    const s = landBattle({
      undead: 1,
      setup: (g) => addHero(addUndead(g, NAXOS, 1), PAROS, ACHILLES, CardId('h-achilles')),
    });
    assert.deepEqual([battleScore(s, battleOf(s), 'ATTACKER', 0).units, battleScore(s, battleOf(s), 'DEFENDER', 0).heroes], [3, 2]);
    assert.deepEqual(battleScore(s, battleOf(s), 'DEFENDER', 0).modifiers, [{ source: 'HERO', heroId: ACHILLES, value: 2 }]);
  });

  test('Port Wojenny: floty obrońcy wokół wyspy walczą jak oddziały i nie giną w bitwie', () => {
    const s = landBattle({
      setup: (g) => buildMonument(setFleet(g, SEA_EAST, P2, 3), PAROS, MonumentCardId('m-war-port')),
    });
    assert.equal(battleScore(s, battleOf(s), 'DEFENDER', 0).supportFleets, 3);
    assert.equal(battleScore(s, battleOf(s), 'DEFENDER', 0).total, 5);
    assert.deepEqual(battleScore(s, battleOf(s), 'DEFENDER', 0).modifiers, [{ source: 'WAR_PORT', seaId: SEA_EAST, value: 3 }]);

    const { state, events } = runBattle(s);
    assert.deepEqual(events.at(-1), { type: 'BATTLE_ENDED', outcome: { kind: 'DEFENDER_WON' } });
    assert.equal(getSea(state.board, SEA_EAST).fleet?.fleets, 3, 'floty wspierające zostają na morzu');
    assert.equal(getIsland(state.board, PAROS).garrison?.troops, 2);
    assertValid(state);
  });

  test('stała premia z kart ma własną pozycję w raporcie', () => {
    const s = updateBattle(landBattle(), (b) => ({ ...b, attacker: { ...b.attacker, bonus: 2 } }));
    const score = battleScore(s, battleOf(s), 'ATTACKER', 1);
    assert.deepEqual([score.bonus, score.total, score.modifiers], [2, 5, [{ source: 'CARD_BONUS', value: 2 }]]);
  });

  test('Wielka Cytadela Aresa blokuje atak na wyspę z co najmniej jednym oddziałem', () => {
    const s = actionsScenario(ARES_TURN, (g) => buildMonument(setIsland(g, MILOS, P2), PAROS, MonumentCardId('m-citadel')));
    const attack = planTroopMove(s, { playerId: P1, from: NAXOS, to: PAROS, troops: 1 });
    assert.deepEqual(attack.ok ? null : attack.error, { code: 'ATTACK_BLOCKED', island: PAROS, monument: MonumentCardId('m-citadel') });

    const empty = setIsland(s, PAROS, P2, 0);
    const capture = planTroopMove(empty, { playerId: P1, from: NAXOS, to: PAROS, troops: 1 });
    assert.ok(capture.ok && capture.plan.landing === 'CAPTURE', 'pusta wyspa z Cytadelą nie jest chroniona');
  });
});

// ===========================================================================
describe('Runda starcia', () => {
  test('strona z niższym wynikiem traci jedną jednostkę, która wraca do zapasu', () => {
    const s = landBattle({ attackers: 3, defenders: 1 });
    const reserveBefore = getPlayer(s, P2).reserve.troops;
    const { state, events } = step(s, ROLL);
    const round = (events[0] as Extract<BattleEvent, { type: 'ROUND_RESOLVED' }>).round;
    assert.deepEqual([round.attacker.score.total, round.defender.score.total], [3, 1]);
    assert.deepEqual([round.attacker.casualty, round.defender.casualty], [null, { kind: 'UNIT' }]);
    assert.deepEqual(events[1], { type: 'BATTLE_DECIDED', outcome: { kind: 'ATTACKER_WON' } });
    assert.equal(battleOf(state).step, 'CLEANUP');
    assert.equal(getPlayer(state, P2).reserve.troops, reserveBefore + 1);
  });

  test('remis: obie strony tracą po jednostce, a remis ostatnich jednostek to wzajemne zniszczenie', () => {
    let s = landBattle({ attackers: 2, defenders: 2, setup: (g) => setFleet(g, SEA_EAST, null) });
    s = step(s, ROLL).state;
    const afterFirst = battleOf(s);
    assert.deepEqual([afterFirst.attacker.units, afterFirst.defender.units], [1, 1]);
    assert.equal(afterFirst.step, 'ATTACKER_RETREAT_DECISION', 'obrońca bez floty nie ma dokąd się wycofać');

    s = step(s, hold(P1)).state;
    const { state, events } = step(s, ROLL);
    assert.deepEqual(events.at(-1), { type: 'BATTLE_DECIDED', outcome: { kind: 'MUTUAL_DESTRUCTION' } });
    const done = step(state, CLEANUP).state;
    assert.equal(done.phase.phase, 'ACTIONS');
    assert.deepEqual([getIsland(done.board, PAROS).ownerId, getIsland(done.board, PAROS).garrison], [P2, null]);
  });

  test('straty: najpierw nieumarli, potem oddziały, na końcu heros, który opuszcza grę', () => {
    const s = landBattle({
      attackers: 1,
      undead: 1,
      heroes: [ACHILLES],
      setup: (g) => withBuildings(addHero(addUndead(g, NAXOS, 1), NAXOS, ACHILLES, CardId('h-achilles')), PAROS, ['FORTRESS', 'FORTRESS', 'FORTRESS']),
    });
    const undeadBefore = s.hades?.undeadSupply.troops ?? 0;
    const troopsBefore = getPlayer(s, P1).reserve.troops;
    const { state, events } = runBattle(s);

    const rounds = events.flatMap((e) => (e.type === 'ROUND_RESOLVED' ? [e.round] : []));
    assert.deepEqual(
      rounds.map((r) => r.attacker.casualty),
      [{ kind: 'UNDEAD' }, { kind: 'UNIT' }, { kind: 'HERO', heroId: ACHILLES }],
    );
    assert.equal(state.hades?.undeadSupply.troops, undeadBefore + 1, 'nieumarły wraca do puli Hadesa');
    assert.equal(getPlayer(state, P1).reserve.troops, troopsBefore + 1, 'oddział wraca do zapasu');
    assert.equal(state.heroes[ACHILLES], undefined, 'poległy heros opuszcza grę');
    assert.ok(state.creatureMarket.discard.includes(CardId('h-achilles')), 'karta herosa trafia na stos odrzuconych');
    assertValid(state);
  });
});

// ===========================================================================
describe('Faza wycofania', () => {
  test('najpierw decyduje obrońca, potem atakujący; tylko właściwy gracz i tylko właściwa komenda', () => {
    let s = step(landBattle({ attackers: 3, defenders: 3 }), ROLL).state;
    assert.deepEqual(pendingDecision(s), { role: 'DEFENDER', playerId: P2, options: [MILOS] });
    assert.deepEqual(rejected(stepBattle(s, hold(P1))), { code: 'NOT_YOUR_DECISION', expected: P2 });
    assert.deepEqual(rejected(stepBattle(s, ROLL)), { code: 'WRONG_STEP', step: 'DEFENDER_RETREAT_DECISION', command: 'ROLL' });

    s = step(s, hold(P2)).state;
    assert.deepEqual(pendingDecision(s), { role: 'ATTACKER', playerId: P1, options: [NAXOS] });
    s = step(s, hold(P1)).state;
    assert.equal(battleOf(s).step, 'ROLL');
  });

  test('kolejność decyzji wynika z zasad (rules.combat.retreatOrder)', () => {
    const base = landBattle({ attackers: 3, defenders: 3 });
    const reversed: GameState = { ...base, rules: { ...base.rules, combat: { ...base.rules.combat, retreatOrder: ['ATTACKER', 'DEFENDER'] } } };
    let s = step(reversed, ROLL).state;
    assert.equal(pendingDecision(s)?.role, 'ATTACKER');
    s = step(s, hold(P1)).state;
    assert.equal(pendingDecision(s)?.role, 'DEFENDER');
  });

  test('odwrót z lądu: łańcuchem własnych flot na własną albo niczyją wyspę, nigdy na wyspę wroga', () => {
    const s = landBattle();
    assert.deepEqual(retreatOptions(s, battleOf(s), 'DEFENDER'), [MILOS]);
    assert.deepEqual(retreatOptions(s, battleOf(s), 'ATTACKER'), [NAXOS]);
    assert.deepEqual(retreatOptions(setIsland(s, MILOS, P3, 1), battleOf(s), 'DEFENDER'), [], 'Milos wroga odpada');
    assert.deepEqual(retreatOptions(setIsland(s, MILOS, null), battleOf(s), 'DEFENDER'), [MILOS], 'wyspa niczyja jest dozwolona');
    assert.deepEqual(retreatOptions(setFleet(s, SEA_EAST, null), battleOf(s), 'DEFENDER'), [], 'bez floty nie ma odwrotu');
  });

  test('odwrót z morza: na sąsiednie pole własne albo puste, nigdy na pole z obcą flotą', () => {
    const open = seaBattle();
    assert.deepEqual(retreatOptions(open, battleOf(open), 'ATTACKER'), [SEA_CENTER]);
    assert.deepEqual(retreatOptions(open, battleOf(open), 'DEFENDER'), [SEA_CENTER]);

    const guarded = seaBattle({ stay: 1 }); // P1 zostawia flotę na Morzu Środk.
    assert.deepEqual(retreatOptions(guarded, battleOf(guarded), 'ATTACKER'), [SEA_CENTER]);
    assert.deepEqual(retreatOptions(guarded, battleOf(guarded), 'DEFENDER'), []);
  });

  test('wycofanie kończy bitwę: wycofujący się zajmuje cel, a przeciwnik pole bitwy', () => {
    let s = step(landBattle({ attackers: 3, defenders: 3 }), ROLL).state;
    const retreat = step(s, { type: 'RETREAT', playerId: P2, to: MILOS });
    assert.deepEqual(retreat.events.at(-1), { type: 'BATTLE_DECIDED', outcome: { kind: 'DEFENDER_RETREATED', to: MILOS } });
    s = step(retreat.state, CLEANUP).state;

    assert.equal(s.phase.phase, 'ACTIONS');
    assert.equal(expectPhase(s, 'ACTIONS').progress.movements, 1, 'tura Aresa toczy się dalej');
    assert.deepEqual([getIsland(s.board, MILOS).ownerId, getIsland(s.board, MILOS).garrison?.troops], [P2, 2]);
    assert.deepEqual([getIsland(s.board, PAROS).ownerId, getIsland(s.board, PAROS).garrison?.troops], [P1, 2]);
  });

  test('atakujący wycofuje się na wyspę, z której przybył', () => {
    let s = step(step(landBattle({ attackers: 3, defenders: 3 }), ROLL).state, hold(P2)).state;
    s = step(step(s, { type: 'RETREAT', playerId: P1, to: NAXOS }).state, CLEANUP).state;
    assert.deepEqual([getIsland(s.board, NAXOS).garrison?.troops, getIsland(s.board, PAROS).garrison?.troops], [2, 2]);
    assert.equal(getIsland(s.board, PAROS).ownerId, P2);
  });

  test('nielegalny cel odwrotu jest odrzucany z listą dozwolonych celów', () => {
    const s = step(landBattle({ attackers: 3, defenders: 3 }), ROLL).state;
    assert.deepEqual(rejected(stepBattle(s, { type: 'RETREAT', playerId: P2, to: DELOS })), {
      code: 'INVALID_RETREAT',
      to: DELOS,
      options: [MILOS],
    });
  });
});

// ===========================================================================
describe('Krok sprzątania i powrót do tury', () => {
  test('zwycięski atakujący zajmuje wyspę razem z budynkami i Metropolią', () => {
    const s = landBattle({
      attackers: 4,
      defenders: 1,
      setup: (g) => updateIsland(withBuildings(g, PAROS, ['TEMPLE']), PAROS, (i) => ({ ...i, metropolisSlot: { metropolis } })),
    });
    const { state } = runBattle(s);
    const paros = getIsland(state.board, PAROS);
    assert.deepEqual([paros.ownerId, paros.garrison?.troops, paros.buildingSlots[0]?.building], [P1, 4, 'TEMPLE']);
    assert.deepEqual([countMetropolises(state, P1), countMetropolises(state, P2)], [1, 0]);
    assert.equal(state.phase.phase, 'ACTIONS');
  });

  test('bitwa morska: zwycięzca zostaje na polu, a zatopione floty wracają do zapasu', () => {
    const s = seaBattle({ attackers: 2, defenders: 1 });
    const reserveBefore = getPlayer(s, P2).reserve.fleets;
    const { state } = runBattle(s);
    assert.deepEqual([getSea(state.board, SEA_EAST).fleet?.playerId, getSea(state.board, SEA_EAST).fleet?.fleets], [P1, 2]);
    assert.equal(getPlayer(state, P2).reserve.fleets, reserveBefore + 1);
  });

  test('komendy spoza bieżącego kroku i poza bitwą są odrzucane', () => {
    const s = landBattle();
    assert.deepEqual(rejected(stepBattle(s, CLEANUP)), { code: 'WRONG_STEP', step: 'ROLL', command: 'CLEANUP' });
    assert.deepEqual(rejected(stepBattle(actionsScenario(ARES_TURN), ROLL)), { code: 'NO_BATTLE', phase: 'ACTIONS' });
    for (const error of [
      { code: 'NO_BATTLE', phase: 'ACTIONS' },
      { code: 'WRONG_STEP', step: 'ROLL', command: 'CLEANUP' },
      { code: 'NOT_YOUR_DECISION', expected: P2 },
      { code: 'INVALID_RETREAT', to: DELOS, options: [] },
    ] as const satisfies readonly BattleRejection[]) {
      assert.ok(describeBattleRejection(error).length > 10);
    }
  });
});

// ===========================================================================
describe('Pętla bitwy', () => {
  /** Prowadzi bitwę krok po kroku i sprawdza niezmienniki po KAŻDYM kroku. */
  function playOut(start: GameState, decide: RetreatDecider) {
    let s = start;
    let outcome: BattleOutcome | null = null;
    const rounds: BattleRound[] = [];
    let steps = 0;
    while (s.phase.phase === 'BATTLE_RESOLUTION') {
      const pending = pendingDecision(s);
      const to = pending ? decide(s, pending) : null;
      const command: BattleCommand = pending
        ? to === null
          ? { type: 'HOLD', playerId: pending.playerId }
          : { type: 'RETREAT', playerId: pending.playerId, to }
        : s.phase.battle.step === 'CLEANUP'
          ? CLEANUP
          : ROLL;
      const result = step(s, command);
      s = result.state;
      for (const event of result.events) {
        if (event.type === 'ROUND_RESOLVED') rounds.push(event.round);
        if (event.type === 'BATTLE_ENDED') outcome = event.outcome;
      }
      steps++;
      assert.ok(steps <= battleStepLimit(start), 'przekroczony limit kroków bitwy');
    }
    return { state: s, outcome: outcome ?? assert.fail('brak wyniku bitwy'), rounds };
  }

  test('200 losowych bitew: każda się kończy, stan jest zawsze poprawny, a plansza zgadza się z wynikiem', () => {
    const kinds = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      let rng = seedRng(`bitwa-${seed}`);
      const draw = (max: number): number => {
        const [value, next] = nextInt(rng, max);
        rng = next;
        return value;
      };
      const attackers = 1 + draw(4);
      const defenders = 1 + draw(4);
      const buildings = Array.from({ length: draw(3) }, () => (draw(2) === 0 ? 'FORTRESS' : 'PORT') as BuildingType);
      const faces = DEFAULT_RULESET.combat.dieFaces;
      const land = draw(2) === 0;
      const start = land
        ? landBattle({ attackers, defenders, faces, setup: (g) => withBuildings(g, PAROS, buildings) })
        : seaBattle({ attackers, defenders, faces, setup: (g) => withBuildings(g, PAROS, buildings) });
      const withRng: GameState = { ...start, rng };

      const decide: RetreatDecider = (_state, decision) =>
        draw(4) === 0 ? (decision.options[draw(decision.options.length)] ?? null) : null;
      const { state, outcome, rounds } = playOut(withRng, decide);
      kinds.add(`${land ? 'ląd' : 'morze'}:${outcome.kind}`);

      assert.equal(state.phase.phase, 'ACTIONS');
      assert.equal(expectPhase(state, 'ACTIONS').progress.movements, 1);
      assert.ok(rounds.length <= attackers + defenders, 'każda runda usuwa co najmniej jedną jednostkę');
      for (const { score } of rounds.flatMap((round) => [round.attacker, round.defender])) {
        const listed = score.modifiers.reduce((sum, modifier) => sum + modifier.value, 0);
        assert.equal(score.roll + score.units + listed, score.total, `ziarno ${seed}: raport sumuje się do wyniku`);
      }
      const survivors = (initial: number, role: 'attacker' | 'defender') =>
        initial - rounds.filter((r) => r[role].casualty !== null).length;

      if (land) {
        const paros = getIsland(state.board, PAROS);
        const holder = outcome.kind === 'ATTACKER_WON' || outcome.kind === 'DEFENDER_RETREATED' ? P1 : P2;
        assert.equal(paros.ownerId, holder, `ziarno ${seed}: właściciel Paros po ${outcome.kind}`);
        const expected =
          outcome.kind === 'MUTUAL_DESTRUCTION'
            ? undefined
            : holder === P1
              ? survivors(attackers, 'attacker')
              : survivors(defenders, 'defender');
        assert.equal(paros.garrison?.troops, expected, `ziarno ${seed}: garnizon Paros`);
      } else {
        const east = getSea(state.board, SEA_EAST).fleet;
        const holder = outcome.kind === 'ATTACKER_WON' || outcome.kind === 'DEFENDER_RETREATED' ? P1 : P2;
        if (outcome.kind === 'MUTUAL_DESTRUCTION') assert.equal(east, null);
        else assert.deepEqual([east?.playerId, east?.fleets], [holder, holder === P1 ? survivors(attackers, 'attacker') : survivors(defenders, 'defender')]);
      }
    }
    assert.ok(kinds.size >= 6, `próba powinna pokryć różne wyniki bitew: ${[...kinds].join(', ')}`);
  });

  test('runBattle daje ten sam wynik co ręczne prowadzenie bitwy krok po kroku', () => {
    const start = landBattle({ attackers: 3, defenders: 3, faces: DEFAULT_RULESET.combat.dieFaces });
    const automatic = runBattle(start).state;
    const manual = playOut(start, () => null).state;
    assert.deepEqual(automatic.board, manual.board);
    assert.deepEqual(automatic.rng, manual.rng);
  });
});
