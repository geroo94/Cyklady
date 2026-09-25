import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BiddingError,
  applyBid,
  biddingMoveLimit,
  closeBidding,
  computeSettlement,
  currentBidder,
  describeRejection,
  isBiddingStable,
  legalBids,
  maxAffordableBid,
  offeringCost,
  runBidding,
  settleBidding,
  type BidCommand,
  type BidEvent,
  type BidRejection,
} from '../src/engine/index.ts';
import {
  DEFAULT_RULESET,
  PlayerId,
  RANDOMIZED_GODS,
  automaticNextPhase,
  createActionsPhase,
  createBiddingPhase,
  getPlayer,
  nextInt,
  seedRng,
  shuffle,
  transition,
  type BiddableGod,
  type GameState,
  type NewPlayer,
  type RulesetConfig,
} from '../src/model/index.ts';
import { P1, P2, P3, SAMPLE_OPTIONS, createSampleGame } from '../src/examples/sampleGame.ts';
import { assertValid, deepFreeze, updatePlayer, violationCodes } from './helpers.ts';

// ===========================================================================
// Scenariusze i skróty
// ===========================================================================

const P4 = PlayerId('p4');
const P5 = PlayerId('p5');
const ALL_PLAYERS: readonly NewPlayer[] = [
  ...SAMPLE_OPTIONS.players,
  { id: P4, name: 'Minos', color: 'YELLOW' },
  { id: P5, name: 'Ikar', color: 'BLACK' },
];

interface Wallet {
  readonly gold: number;
  readonly priests?: number;
}

interface Scenario {
  /** Tor bogów od góry. */
  readonly gods: readonly BiddableGod[];
  readonly playerCount?: 3 | 4 | 5;
  /** Kolejność licytacji (domyślnie kolejność przy stole). */
  readonly order?: readonly PlayerId[];
  /** Portfele (domyślnie 10 JZ i 0 kapłanów). */
  readonly wallets?: Readonly<Partial<Record<PlayerId, Wallet>>>;
  readonly rules?: RulesetConfig;
}

/** Poprawny stan w fazie BIDDING z kontrolowanym torem, kolejnością i portfelami. */
function biddingScenario(scenario: Scenario): GameState {
  const players = ALL_PLAYERS.slice(0, scenario.playerCount ?? 3);
  let s = createSampleGame({ players, ...(scenario.rules ? { rules: scenario.rules } : {}) });
  for (const player of players) {
    const wallet = scenario.wallets?.[player.id] ?? { gold: 10 };
    s = updatePlayer(s, player.id, (p) => ({ ...p, gold: wallet.gold, priests: wallet.priests ?? 0 }));
  }
  s = {
    ...s,
    cycle: 1,
    turnOrder: { current: scenario.order ?? players.map((p) => p.id), next: [] },
    gods: { slots: scenario.gods.map((god) => ({ god, offering: null })), apolloSupplicants: [], unavailable: [] },
  };
  return assertValid({ ...s, phase: createBiddingPhase(s) });
}

const offer = (playerId: PlayerId, god: BiddableGod, amount: number): BidCommand => ({
  type: 'OFFER',
  playerId,
  god,
  amount,
});
const apollo = (playerId: PlayerId): BidCommand => ({ type: 'APOLLO', playerId });

/** Stosuje komendy, wymagając sukcesu i poprawnego stanu po każdej z nich. */
function play(state: GameState, ...commands: BidCommand[]): GameState {
  return commands.reduce((s, command) => {
    const outcome = applyBid(s, command);
    if (!outcome.ok) assert.fail(`${JSON.stringify(command)}: ${describeRejection(outcome.error)}`);
    return assertValid(outcome.state);
  }, state);
}

/** Wymaga odrzucenia komendy i zwraca jego powód. */
function rejection(state: GameState, command: BidCommand): BidRejection {
  const outcome = applyBid(state, command);
  if (outcome.ok) assert.fail(`komenda powinna zostać odrzucona: ${JSON.stringify(command)}`);
  return outcome.error;
}

const trackView = (s: GameState) => s.gods.slots.map((slot) => [slot.god, slot.offering?.playerId ?? null, slot.offering?.amount ?? 0]);

// ===========================================================================
describe('Koszt ofiary i kapłani', () => {
  test('kapłani obniżają koszt, ale nigdy poniżej 1 JZ', () => {
    assert.equal(offeringCost(5, 0), 5);
    assert.equal(offeringCost(5, 2), 3);
    assert.equal(offeringCost(2, 5), 1);
    assert.equal(offeringCost(1, 0), 1);
    assert.equal(maxAffordableBid(3, 2), 5);
    assert.equal(maxAffordableBid(1, 0), 1);
    assert.equal(maxAffordableBid(0, 4), 0, 'bez złota nie da się zapłacić nawet 1 JZ');
  });

  test('dzięki kapłanom można zaoferować więcej, niż ma się złota', () => {
    const s = biddingScenario({
      gods: ['ARES', 'ZEUS'],
      wallets: { [P1]: { gold: 3, priests: 2 }, [P2]: { gold: 1, priests: 5 } },
    });
    const first = applyBid(s, offer(P1, 'ARES', 5));
    assert.ok(first.ok);
    assert.deepEqual(first.events[0], { type: 'OFFERING_PLACED', playerId: P1, god: 'ARES', amount: 5, cost: 3 });
    const second = applyBid(first.state, offer(P2, 'ZEUS', 6));
    assert.ok(second.ok);
    assert.deepEqual(second.events[0], { type: 'OFFERING_PLACED', playerId: P2, god: 'ZEUS', amount: 6, cost: 1 });
  });

  test('nie można zaoferować więcej, niż się zapłaci', () => {
    const s = biddingScenario({ gods: ['ARES', 'ZEUS'], wallets: { [P1]: { gold: 3, priests: 2 } } });
    assert.deepEqual(rejection(s, offer(P1, 'ARES', 6)), { code: 'CANNOT_AFFORD', cost: 4, available: 3, maximum: 5 });
  });

  test('gracz bez złota może wybrać tylko Apolla, nawet mając kapłanów', () => {
    const s = biddingScenario({ gods: ['ARES', 'ZEUS'], wallets: { [P1]: { gold: 0, priests: 3 } } });
    const error = rejection(s, offer(P1, 'ARES', 1));
    assert.deepEqual(error, { code: 'CANNOT_AFFORD', cost: 1, available: 0, maximum: 0 });
    assert.match(describeRejection(error), /tylko Apollo/);
    assert.deepEqual(legalBids(s)?.gods, []);
    assert.equal(legalBids(s)?.apollo, true);
    play(s, apollo(P1));
  });
});

// ===========================================================================
describe('Walidacja ruchu', () => {
  test('licytuje tylko gracz, którego jest kolej', () => {
    const s = biddingScenario({ gods: ['ARES', 'ZEUS'] });
    assert.deepEqual(rejection(s, offer(P2, 'ARES', 1)), { code: 'NOT_YOUR_TURN', expected: P1 });
    assert.deepEqual(rejection(s, apollo(P3)), { code: 'NOT_YOUR_TURN', expected: P1 });
  });

  test('kwota musi być dodatnią liczbą całkowitą', () => {
    const s = biddingScenario({ gods: ['ARES', 'ZEUS'] });
    for (const amount of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(rejection(s, offer(P1, 'ARES', amount)).code, 'INVALID_AMOUNT', `kwota ${amount}`);
    }
  });

  test('przebicie musi być wyższe od aktualnej oferty (remis nie wystarcza)', () => {
    const s = play(biddingScenario({ gods: ['ARES', 'ZEUS'] }), offer(P1, 'ARES', 2));
    assert.deepEqual(rejection(s, offer(P2, 'ARES', 2)), { code: 'BID_TOO_LOW', amount: 2, minimum: 3 });
    play(s, offer(P2, 'ARES', 3));
  });

  test('nie można licytować boga spoza toru: nieprzywołanego Hadesa ani odłożonego boga', () => {
    const s = biddingScenario({ gods: ['ARES', 'ZEUS'] });
    assert.deepEqual(rejection(s, offer(P1, 'HADES', 1)), { code: 'GOD_NOT_AVAILABLE', god: 'HADES' });
    assert.deepEqual(rejection(s, offer(P1, 'POSEIDON', 1)), { code: 'GOD_NOT_AVAILABLE', god: 'POSEIDON' });
    const viaNetwork = { type: 'OFFER', playerId: P1, god: 'APOLLO', amount: 1 } as unknown as BidCommand;
    assert.deepEqual(rejection(s, viaNetwork), { code: 'GOD_NOT_AVAILABLE', god: 'APOLLO' });
  });

  test('przywołany Hades jest licytowany jak każdy inny bóg', () => {
    let s = biddingScenario({ gods: ['ARES', 'HADES', 'ZEUS'] });
    s = play(s, offer(P1, 'HADES', 2), offer(P2, 'HADES', 3), offer(P1, 'ARES', 1), apollo(P3));
    assert.deepEqual(trackView(s), [
      ['ARES', P1, 1],
      ['HADES', P2, 3],
      ['ZEUS', null, 0],
    ]);
  });

  test('komenda poza fazą BIDDING i po zakończeniu licytacji jest odrzucana', () => {
    assert.deepEqual(rejection(createSampleGame(), apollo(P1)), { code: 'NOT_BIDDING_PHASE', phase: 'INIT' });
    const done = play(biddingScenario({ gods: ['ARES', 'ZEUS'] }), apollo(P1), apollo(P2), apollo(P3));
    assert.deepEqual(rejection(done, apollo(P1)), { code: 'BIDDING_COMPLETE' });
  });

  test('silnik jest czysty: nie modyfikuje stanu wejściowego i podbija rewizję', () => {
    const s = deepFreeze(biddingScenario({ gods: ['ARES', 'ZEUS'] }));
    rejection(s, offer(P2, 'ARES', 1));
    const outcome = applyBid(s, offer(P1, 'ARES', 1));
    assert.ok(outcome.ok);
    assert.equal(outcome.state.revision, s.revision + 1);
    assert.deepEqual(trackView(s), [
      ['ARES', null, 0],
      ['ZEUS', null, 0],
    ]);
  });

  test('legalBids podaje przedziały kwot i gracza, który zostanie wyparty', () => {
    const s = play(
      biddingScenario({ gods: ['ARES', 'ZEUS'], wallets: { [P2]: { gold: 3, priests: 1 } } }),
      offer(P1, 'ARES', 2),
    );
    assert.deepEqual(legalBids(s), {
      playerId: P2,
      displaced: false,
      forbiddenGod: null,
      apollo: true,
      gods: [
        { god: 'ARES', minimum: 3, maximum: 4, holder: P1 },
        { god: 'ZEUS', minimum: 1, maximum: 4, holder: null },
      ],
    });
  });
});

// ===========================================================================
describe('Przelicytowanie', () => {
  test('wyparty gracz rusza się natychmiast, przed kolejką, i nie wraca na tego samego boga', () => {
    let s = play(biddingScenario({ gods: ['ARES', 'ZEUS'] }), offer(P1, 'ARES', 1));
    const outbid = applyBid(s, offer(P2, 'ARES', 2));
    assert.ok(outbid.ok);
    assert.deepEqual(outbid.events, [
      { type: 'OFFERING_PLACED', playerId: P2, god: 'ARES', amount: 2, cost: 2 },
      { type: 'PLAYER_DISPLACED', playerId: P1, by: P2, god: 'ARES', amount: 1 },
    ]);
    s = assertValid(outbid.state);

    assert.deepEqual(currentBidder(s), { playerId: P1, displaced: true, forbiddenGod: 'ARES' });
    assert.deepEqual(rejection(s, apollo(P3)), { code: 'NOT_YOUR_TURN', expected: P1 });
    assert.deepEqual(rejection(s, offer(P1, 'ARES', 3)), { code: 'FORBIDDEN_GOD', god: 'ARES' });
    assert.deepEqual(legalBids(s)?.gods.map((option) => option.god), ['ZEUS']);

    s = play(s, offer(P1, 'ZEUS', 1));
    assert.deepEqual(currentBidder(s), { playerId: P3, displaced: false, forbiddenGod: null });
  });

  test('łańcuch przelicytowań trwa, aż tor się ustabilizuje, nawet po opróżnieniu kolejki', () => {
    let s = biddingScenario({ gods: ['ARES', 'ZEUS'] });
    const events: BidEvent[] = [];
    const step = (command: BidCommand): void => {
      const outcome = applyBid(s, command);
      if (!outcome.ok) assert.fail(describeRejection(outcome.error));
      s = assertValid(outcome.state);
      events.push(...outcome.events);
    };

    step(offer(P1, 'ARES', 1));
    step(offer(P2, 'ARES', 2)); // P1 wyparty z Aresa
    step(offer(P1, 'ZEUS', 1));
    step(offer(P3, 'ZEUS', 2)); // P1 wyparty z Zeusa; kolejka jest już pusta
    assert.deepEqual(currentBidder(s), { playerId: P1, displaced: true, forbiddenGod: 'ZEUS' });
    step(offer(P1, 'ARES', 3)); // powrót na Aresa jest dozwolony: zakaz dotyczy tylko ostatniego wyparcia
    step(offer(P2, 'ZEUS', 3));
    step(offer(P3, 'ARES', 4));
    assert.equal(isBiddingStable(s), false);
    step(apollo(P1));
    assert.equal(isBiddingStable(s), true);

    const displacements = events
      .filter((event) => event.type === 'PLAYER_DISPLACED')
      .map((event) => [event.playerId, event.by, event.god]);
    assert.deepEqual(displacements, [
      [P1, P2, 'ARES'],
      [P1, P3, 'ZEUS'],
      [P2, P1, 'ARES'],
      [P3, P2, 'ZEUS'],
      [P1, P3, 'ARES'],
    ]);
    assert.deepEqual(events.at(-1), { type: 'BIDDING_STABLE' });
    assert.deepEqual(trackView(s), [
      ['ARES', P3, 4],
      ['ZEUS', P2, 3],
    ]);
    assert.deepEqual(s.gods.apolloSupplicants, [P1]);
  });

  test('wojna przebić kończy się, gdy zabraknie złota, i mieści się w limicie ruchów', () => {
    const start = biddingScenario({
      gods: ['ARES', 'ZEUS'],
      wallets: { [P1]: { gold: 5 }, [P2]: { gold: 5 }, [P3]: { gold: 5 } },
    });
    // Strategia zachłanna: przebij zajętego boga minimalną kwotą, inaczej weź wolnego, a w ostateczności Apolla.
    const run = runBidding(start, (_state, legal) => {
      const option = legal.gods.find((o) => o.holder !== null) ?? legal.gods[0];
      return option ? offer(legal.playerId, option.god, option.minimum) : apollo(legal.playerId);
    });
    assert.equal(run.moves, 10);
    assert.ok(run.moves <= biddingMoveLimit(start));
    assert.deepEqual(trackView(run.state), [
      ['ARES', P2, 5],
      ['ZEUS', P1, 4],
    ]);
    assert.deepEqual(run.state.gods.apolloSupplicants, [P3]);
  });

  test('wariant z dwoma znacznikami: bez przebijania samego siebie, a suma ofiar mieści się w portfelu', () => {
    let s = biddingScenario({
      rules: { ...DEFAULT_RULESET, offeringMarkersPerPlayer: 2 },
      gods: ['ARES', 'ZEUS', 'ATHENA'],
      order: [P1, P2, P1, P2, P3, P3],
      wallets: { [P1]: { gold: 3 } },
    });
    s = play(s, offer(P1, 'ARES', 3), offer(P2, 'ZEUS', 1));
    assert.deepEqual(rejection(s, offer(P1, 'ARES', 4)), { code: 'OWN_OFFERING', god: 'ARES' });
    assert.deepEqual(rejection(s, offer(P1, 'ATHENA', 1)), { code: 'CANNOT_AFFORD', cost: 1, available: 0, maximum: 0 });
    assert.deepEqual(legalBids(s)?.gods, []);

    s = play(s, apollo(P1), apollo(P2), offer(P3, 'ATHENA', 1), apollo(P3));
    const closed = closeBidding(s);
    if (!closed.ok) assert.fail(describeRejection(closed.error));
    assert.deepEqual(
      closed.settlement.actionOrder.map((turn) => `${turn.god}:${turn.playerId}`),
      ['ARES:p1', 'ZEUS:p2', 'ATHENA:p3', 'APOLLO:p1', 'APOLLO:p2', 'APOLLO:p3'],
    );
    assertValid(closed.state);
  });
});

// ===========================================================================
describe('Apollo', () => {
  test('wielu graczy u Apolla: pozycje według przybycia, znacznik dobrobytu tylko dla pierwszego', () => {
    let s = biddingScenario({ gods: ['ARES', 'ZEUS'] });
    const joined: BidEvent[] = [];
    for (const playerId of [P1, P2, P3]) {
      const outcome = applyBid(s, apollo(playerId));
      assert.ok(outcome.ok);
      joined.push(outcome.events[0] as BidEvent);
      s = assertValid(outcome.state);
    }
    assert.deepEqual(joined, [
      { type: 'APOLLO_JOINED', playerId: P1, position: 1, receivesProsperityMarker: true },
      { type: 'APOLLO_JOINED', playerId: P2, position: 2, receivesProsperityMarker: false },
      { type: 'APOLLO_JOINED', playerId: P3, position: 3, receivesProsperityMarker: false },
    ]);

    const closed = closeBidding(s);
    if (!closed.ok) assert.fail(describeRejection(closed.error));
    assert.deepEqual(closed.settlement.payments, [], 'Apollo kosztuje 0 JZ');
    assert.deepEqual(
      closed.settlement.apollo.map((a) => [a.playerId, a.position, a.receivesProsperityMarker]),
      [
        [P1, 1, true],
        [P2, 2, false],
        [P3, 3, false],
      ],
    );
    assert.deepEqual(
      closed.settlement.actionOrder.map((turn) => turn.playerId),
      [P1, P2, P3],
    );
  });

  test('wyparty gracz może uciec do Apolla: kończy to łańcuch, a o premii decyduje przybycie', () => {
    let s = play(biddingScenario({ gods: ['ARES', 'ZEUS'] }), offer(P1, 'ARES', 1), offer(P2, 'ARES', 2));
    const escape = applyBid(s, apollo(P1));
    assert.ok(escape.ok);
    assert.deepEqual(escape.events, [
      { type: 'APOLLO_JOINED', playerId: P1, position: 1, receivesProsperityMarker: true },
    ]);
    s = play(escape.state, apollo(P3));
    assert.deepEqual(computeSettlement(s).apollo.map((a) => [a.playerId, a.receivesProsperityMarker]), [
      [P1, true],
      [P3, false],
    ]);
  });
});

// ===========================================================================
describe('Rozliczenie i zamknięcie licytacji', () => {
  test('opłaty uwzględniają kapłanów, a kolejność akcji wynika z toru, nie z kolejności ofert', () => {
    const s = play(
      biddingScenario({
        gods: ['ZEUS', 'ARES'],
        wallets: { [P1]: { gold: 5, priests: 1 }, [P2]: { gold: 2, priests: 5 }, [P3]: { gold: 4 } },
      }),
      offer(P1, 'ARES', 4),
      offer(P2, 'ZEUS', 2),
      apollo(P3),
    );
    const settled = settleBidding(s);
    if (!settled.ok) assert.fail(describeRejection(settled.error));
    assert.deepEqual(settled.settlement.payments, [
      { playerId: P2, god: 'ZEUS', amount: 2, discount: 1, cost: 1 },
      { playerId: P1, god: 'ARES', amount: 4, discount: 1, cost: 3 },
    ]);
    assert.deepEqual(settled.settlement.actionOrder, [
      { god: 'ZEUS', playerId: P2 },
      { god: 'ARES', playerId: P1 },
      { god: 'APOLLO', playerId: P3 },
    ]);
    assert.deepEqual(
      [P1, P2, P3].map((id) => getPlayer(settled.state, id).gold),
      [2, 1, 4],
    );
    assertValid(settled.state);
  });

  test('bogowie bez ofiary są pomijani w kolejności akcji', () => {
    const s = play(biddingScenario({ gods: ['ARES', 'ZEUS', 'ATHENA'] }), apollo(P1), offer(P2, 'ATHENA', 1), apollo(P3));
    assert.deepEqual(computeSettlement(s).actionOrder, [
      { god: 'ATHENA', playerId: P2 },
      { god: 'APOLLO', playerId: P1 },
      { god: 'APOLLO', playerId: P3 },
    ]);
  });

  test('nie można rozliczyć trwającej licytacji ani pobrać opłat dwa razy', () => {
    let s = play(biddingScenario({ gods: ['ARES', 'ZEUS'] }), offer(P1, 'ARES', 3));
    const early = settleBidding(s);
    assert.ok(!early.ok);
    assert.deepEqual(early.error, { code: 'BIDDING_NOT_STABLE', waitingFor: P2 });

    s = play(s, offer(P2, 'ZEUS', 1), apollo(P3));
    const first = settleBidding(s);
    if (!first.ok) assert.fail(describeRejection(first.error));
    const second = settleBidding(first.state);
    assert.ok(!second.ok);
    assert.deepEqual(second.error, { code: 'ALREADY_SETTLED' });

    const closed = closeBidding(first.state);
    if (!closed.ok) assert.fail(describeRejection(closed.error));
    assert.equal(getPlayer(closed.state, P1).gold, 7, '10 - 3 JZ, pobrane dokładnie raz');
  });

  test('automat nie wypuści do ACTIONS bez rozliczenia ani ze zmienioną kolejnością tur', () => {
    const s = play(biddingScenario({ gods: ['ARES', 'ZEUS'] }), offer(P1, 'ARES', 1), offer(P2, 'ZEUS', 1), apollo(P3));
    assert.equal(automaticNextPhase(s), null);
    assert.throws(() => transition(s, createActionsPhase(s)), /nie została rozliczona/);

    const settled = settleBidding(s);
    if (!settled.ok) assert.fail(describeRejection(settled.error));
    assert.equal(automaticNextPhase(settled.state), 'ACTIONS');
    const actions = createActionsPhase(settled.state);
    const tampered = { ...actions, turns: [...actions.turns].reverse() };
    assert.throws(() => transition(settled.state, tampered), /odpowiadać rozliczeniu/);
  });

  test('closeBidding przechodzi do ACTIONS z kolejnością tur z rozliczenia', () => {
    const s = play(biddingScenario({ gods: ['ARES', 'ZEUS'] }), offer(P1, 'ZEUS', 2), offer(P2, 'ARES', 1), apollo(P3));
    const closed = closeBidding(s);
    if (!closed.ok) assert.fail(describeRejection(closed.error));
    assert.equal(closed.state.phase.phase, 'ACTIONS');
    assert.ok(closed.state.phase.phase === 'ACTIONS');
    assert.deepEqual(closed.state.phase.turns, closed.settlement.actionOrder);
    assertValid(closed.state);
  });

  test('computeSettlement to podgląd, który nie zmienia stanu', () => {
    const s = deepFreeze(play(biddingScenario({ gods: ['ARES', 'ZEUS'], wallets: { [P1]: { gold: 5, priests: 2 } } }), offer(P1, 'ARES', 4)));
    assert.deepEqual(computeSettlement(s).payments, [{ playerId: P1, god: 'ARES', amount: 4, discount: 2, cost: 2 }]);
    assert.equal(getPlayer(s, P1).gold, 5);
  });
});

// ===========================================================================
describe('Pętla licytacji (runBidding)', () => {
  test('limit ruchów: kolejka + bogowie × najwyższa możliwa ofiara', () => {
    const s = biddingScenario({
      gods: ['ARES', 'ZEUS'],
      wallets: { [P1]: { gold: 4, priests: 2 }, [P2]: { gold: 1 }, [P3]: { gold: 0, priests: 9 } },
    });
    assert.equal(biddingMoveLimit(s), 3 + 2 * 6);
  });

  test('nielegalny ruch strategii przerywa pętlę błędem BiddingError', () => {
    const s = biddingScenario({ gods: ['ARES', 'ZEUS'] });
    assert.throws(
      () => runBidding(s, (_state, legal) => offer(legal.playerId, 'ARES', 0)),
      (error: unknown) => error instanceof BiddingError && error.rejection.code === 'INVALID_AMOUNT',
    );
  });

  test('losowe legalne decyzje zawsze stabilizują tor w granicy ruchów (300 licytacji)', () => {
    let displacements = 0;
    for (let seed = 0; seed < 300; seed++) {
      let rng = seedRng(`licytacja-${seed}`);
      const draw = (max: number): number => {
        const [value, next] = nextInt(rng, max);
        rng = next;
        return value;
      };

      const playerCount = (3 + draw(3)) as 3 | 4 | 5;
      const godCount = DEFAULT_RULESET.godsRevealedByPlayerCount[playerCount] ?? assert.fail();
      let gods: BiddableGod[];
      [gods, rng] = shuffle(RANDOMIZED_GODS, rng);
      gods = gods.slice(0, godCount);
      if (draw(2) === 1) gods.splice(draw(gods.length + 1), 0, 'HADES');
      const wallets = Object.fromEntries(
        ALL_PLAYERS.slice(0, playerCount).map((p) => [p.id, { gold: draw(9), priests: draw(4) }]),
      ) as Partial<Record<PlayerId, Wallet>>;

      const start = biddingScenario({ gods, playerCount, wallets });
      const run = runBidding(start, (state, legal) => {
        // legalBids i applyBid muszą się zgadzać także z drugiej strony przedziału.
        for (const option of legal.gods) {
          assert.equal(applyBid(state, offer(legal.playerId, option.god, option.maximum + 1)).ok, false);
          if (option.minimum > 1) {
            assert.equal(applyBid(state, offer(legal.playerId, option.god, option.minimum - 1)).ok, false);
          }
        }
        const contested = legal.gods.filter((option) => option.holder !== null);
        const pool = contested.length > 0 && draw(2) === 0 ? contested : legal.gods;
        const option = pool[draw(pool.length + 1)];
        return option
          ? offer(legal.playerId, option.god, Math.min(option.maximum, option.minimum + draw(3)))
          : apollo(legal.playerId);
      });

      assert.ok(run.moves <= biddingMoveLimit(start), `ziarno ${seed}: przekroczony limit ruchów`);
      assert.equal(isBiddingStable(run.state), true);
      assertValid(run.state);
      displacements += run.events.filter((event) => event.type === 'PLAYER_DISPLACED').length;

      const closed = closeBidding(run.state);
      if (!closed.ok) assert.fail(describeRejection(closed.error));
      assertValid(closed.state);
      assert.equal(closed.settlement.actionOrder.length, playerCount, 'każdy gracz ma dokładnie jedną turę');
      for (const payment of closed.settlement.payments) {
        assert.equal(payment.cost, offeringCost(payment.amount, wallets[payment.playerId]?.priests ?? 0));
      }
    }
    assert.ok(displacements >= 300, `próba powinna obfitować w przelicytowania (było ${displacements})`);
  });
});

// ===========================================================================
describe('Komunikaty i niezmienniki', () => {
  test('każdy kod odrzucenia ma czytelny komunikat', () => {
    const errors: BidRejection[] = [
      { code: 'NOT_BIDDING_PHASE', phase: 'INCOME' },
      { code: 'BIDDING_COMPLETE' },
      { code: 'NOT_YOUR_TURN', expected: P2 },
      { code: 'UNKNOWN_PLAYER', playerId: P5 },
      { code: 'GOD_NOT_AVAILABLE', god: 'HADES' },
      { code: 'FORBIDDEN_GOD', god: 'ARES' },
      { code: 'INVALID_AMOUNT', amount: 0 },
      { code: 'OWN_OFFERING', god: 'ZEUS' },
      { code: 'BID_TOO_LOW', amount: 2, minimum: 3 },
      { code: 'CANNOT_AFFORD', cost: 4, available: 3, maximum: 5 },
      { code: 'BIDDING_NOT_STABLE', waitingFor: P1 },
      { code: 'ALREADY_SETTLED' },
    ];
    for (const error of errors) assert.ok(describeRejection(error).length > 10, error.code);
    assert.equal(describeRejection({ code: 'NOT_YOUR_TURN', expected: P2 }), 'Teraz ruch gracza p2.');
  });

  test('niezmiennik wykrywa znacznik ofiary jednocześnie w kolejce i na torze', () => {
    const s = biddingScenario({ gods: ['ARES', 'ZEUS'] });
    const broken: GameState = {
      ...s,
      gods: { ...s.gods, slots: [{ god: 'ARES', offering: { playerId: P1, amount: 1 } }, ...s.gods.slots.slice(1)] },
    };
    assert.ok(violationCodes(broken).includes('OFFERING_MARKERS'));
  });
});
