import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_TURN_TIMEOUTS,
  GameClient,
  ManualScheduler,
  createLanServer,
  createSinglePlayerServer,
  type GameServer,
  type RoomConfig,
} from '../src/net/index.ts';
import { expectPhase, type BiddableGod, type GameState, type PlayerId } from '../src/model/index.ts';
import { MILOS, NAXOS, P1, P2, P3, PAROS, createSampleMatch } from '../src/examples/sampleGame.ts';
import { ARES_TURN, actionsScenario, setIsland, withDice } from './helpers.ts';
import { fixedRng, flush, ofType, recorded, rejected, seats, type Delivery } from './netHarness.ts';

// ===========================================================================
// Pomocniki
// ===========================================================================

const NAMES: Readonly<Record<PlayerId, string>> = { [P1]: 'Ariadna', [P2]: 'Tezeusz', [P3]: 'Dedal' };

interface Table {
  readonly server: GameServer;
  readonly scheduler: ManualScheduler;
  readonly log: Delivery[];
  readonly client: (playerId: PlayerId) => GameClient;
  readonly state: () => GameState;
}

/** Stół (domyślnie trzech ludzi). Partia startuje, gdy zajęte są wszystkie miejsca (tryb WHEN_FULL). */
async function table(overrides: Partial<RoomConfig> = {}): Promise<Table> {
  const scheduler = new ManualScheduler();
  const server = createSinglePlayerServer();
  server.createRoom({
    roomId: 'stol',
    seats: seats('HUMAN', 'HUMAN', 'HUMAN'),
    createGame: (names, setup) => createSampleMatch(names, { rng: setup.rng }),
    createRng: fixedRng,
    scheduler,
    turnTimeouts: DEFAULT_TURN_TIMEOUTS,
    ...overrides,
  });
  const log: Delivery[] = [];
  const clients = new Map<PlayerId, GameClient>();
  const humans = (overrides.seats ?? seats('HUMAN', 'HUMAN', 'HUMAN')).filter((seat) => seat.kind === 'HUMAN').map((seat) => seat.playerId);
  for (const playerId of humans) {
    const client = new GameClient(recorded(server.connectLocal(), NAMES[playerId] ?? playerId, log));
    await client.joinRoom('stol', NAMES[playerId] ?? playerId);
    clients.set(playerId, client);
  }
  await flush();
  const state = (): GameState => server.inspectRoom('stol')?.state ?? assert.fail('brak stanu');
  return { server, scheduler, log, client: (playerId) => clients.get(playerId) ?? assert.fail(`brak klienta ${playerId}`), state };
}

/** Kolejność licytacji i bogowie odkryci w tym cyklu. */
function bidding(state: GameState): { readonly order: readonly PlayerId[]; readonly gods: readonly BiddableGod[] } {
  return { order: expectPhase(state, 'BIDDING').queue, gods: state.gods.slots.map((slot) => slot.god) };
}

const at = <T>(list: readonly T[], index: number): T => list[index] ?? assert.fail(`brak elementu ${index}`);

// ===========================================================================
describe('Licytacja w czasie rzeczywistym', () => {
  test('przebity gracz od razu dostaje zdarzenie przebicia i zegar tury z obowiązkiem wyboru innego boga', async () => {
    const { log, client, state, scheduler } = await table();
    const { order, gods } = bidding(state());
    const [a, b] = [at(order, 0), at(order, 1)];
    const god = at(gods, 0);
    assert.deepEqual(client(a).turn?.details, { reason: 'BID' });

    await client(a).submitBid({ kind: 'GOD', god, amount: 1 });
    const before = log.length;
    await client(b).submitBid({ kind: 'GOD', god, amount: 2 });
    await flush();

    // Wszystko, co dostał A w wyniku ruchu B: zdarzenie, stan i zegar tury (w tej kolejności).
    const toA = log.slice(before).filter((delivery) => delivery.who === NAMES[a]);
    assert.deepEqual(toA.map((delivery) => delivery.message.type), ['BIDDING_EVENT', 'GAME_STATE_SYNC', 'TURN_UPDATE']);
    const event = ofType(toA, 'BIDDING_EVENT')[0] ?? assert.fail();
    assert.deepEqual(event.cause.playerId, b);
    assert.deepEqual(event.events, [
      { type: 'OFFERING_PLACED', playerId: b, god, amount: 2, cost: 2 },
      { type: 'PLAYER_DISPLACED', playerId: a, by: b, god, amount: 1 },
    ]);
    const turn = client(a).turn ?? assert.fail();
    assert.deepEqual(
      [turn.actors, turn.details, turn.passiveMove, turn.remainingMs, turn.deadline],
      [[a], { reason: 'OUTBID', by: b, god, amount: 2 }, 'APOLLO', 60_000, scheduler.now() + 60_000],
    );
    assert.deepEqual([client(a).isMyTurn, client(b).isMyTurn], [true, false]);
    assert.deepEqual(client(b).turn, turn, 'wszyscy widzą ten sam zegar tury');

    assert.equal((await rejected(client(a).submitBid({ kind: 'GOD', god, amount: 3 }))).code, 'FORBIDDEN_GOD');
    await client(a).submitBid({ kind: 'GOD', god: at(gods, 1), amount: 1 });
    await flush();
    assert.deepEqual(client(a).turn?.actors, [at(order, 2)], 'licytacja idzie dalej');
  });

  test('czas na ofiarę minął: serwer przenosi przebitego gracza do Apolla, a następny dostaje pełny limit', async () => {
    const { log, client, state, scheduler } = await table();
    const { order, gods } = bidding(state());
    const [a, b, c] = [at(order, 0), at(order, 1), at(order, 2)];
    await client(a).submitBid({ kind: 'GOD', god: at(gods, 0), amount: 1 });
    await client(b).submitBid({ kind: 'GOD', god: at(gods, 0), amount: 2 });
    await flush();

    scheduler.advance(59_999);
    await flush();
    assert.deepEqual(client(a).turn?.details.reason, 'OUTBID', 'przed terminem nic się nie dzieje');
    const before = log.length;
    scheduler.advance(1);
    await flush();

    const event = ofType(log.slice(before), 'BIDDING_EVENT', NAMES[c])[0] ?? assert.fail('brak zdarzenia licytacji');
    assert.deepEqual(event.cause, { playerId: a, requestId: null, intent: 'TIMEOUT:SUBMIT_BID' });
    assert.deepEqual(event.events, [{ type: 'APOLLO_JOINED', playerId: a, position: 1, receivesProsperityMarker: true }]);
    assert.deepEqual(state().gods.apolloSupplicants, [a]);
    const next = client(c).turn ?? assert.fail();
    assert.deepEqual([next.actors, next.details, next.remainingMs], [[c], { reason: 'BID' }, 60_000]);
  });

  test('ruch przed terminem kasuje licznik: po upływie starego terminu nic się nie dzieje', async () => {
    const { log, client, state, scheduler } = await table();
    const { order, gods } = bidding(state());
    scheduler.advance(30_000);
    await client(at(order, 0)).submitBid({ kind: 'GOD', god: at(gods, 0), amount: 1 });
    const before = log.length;
    scheduler.advance(35_000); // 65 s od początku tury pierwszego gracza, 35 s tury drugiego
    await flush();
    assert.equal(log.length, before, 'żadnego ruchu pasywnego ani nowej wiadomości');
    assert.equal(state().gods.slots[0]?.offering?.playerId, at(order, 0));
    assert.equal(client(at(order, 1)).turn?.remainingMs, 60_000, 'odliczanie drugiego gracza wysłane przy rozpoczęciu jego tury');
  });

  test('tura boga: po limicie serwer kończy turę za gracza i zaczyna następną', async () => {
    const { log, client, state, scheduler } = await table();
    const { order, gods } = bidding(state());
    await client(at(order, 0)).submitBid({ kind: 'GOD', god: at(gods, 0), amount: 1 });
    await client(at(order, 1)).submitBid({ kind: 'GOD', god: at(gods, 1), amount: 1 });
    await client(at(order, 2)).submitBid({ kind: 'APOLLO' });
    await flush();

    const actions = expectPhase(state(), 'ACTIONS');
    const first = at(actions.turns, 0);
    const turn = client(first.playerId).turn ?? assert.fail();
    assert.deepEqual([turn.actors, turn.details, turn.passiveMove, turn.remainingMs], [[first.playerId], { reason: 'GOD_TURN', god: first.god }, 'END_TURN', 180_000]);

    const before = log.length;
    scheduler.advance(180_000);
    await flush();
    assert.equal(ofType(log.slice(before), 'GAME_STATE_SYNC', NAMES[first.playerId])[0]?.cause?.intent, 'TIMEOUT:END_TURN');
    assert.equal(expectPhase(state(), 'ACTIONS').turnIndex, 1);
    assert.deepEqual(client(first.playerId).turn?.details, { reason: 'GOD_TURN', god: at(actions.turns, 1).god });
  });

  test('kolejne akcje w turze boga nie wydłużają jej: licznik biegnie od początku tury', async () => {
    const peaceful = (): GameState => actionsScenario(ARES_TURN, (g) => setIsland(g, PAROS, null));
    const { client, log, scheduler } = await table({ createGame: peaceful });
    const p1 = client(P1);
    const deadline = p1.turn?.deadline;
    scheduler.advance(100_000);
    const before = log.length;
    await p1.executeAction({ type: 'MOVE_TROOPS', from: NAXOS, to: PAROS, troops: 1 });
    await flush();
    assert.equal(ofType(log.slice(before), 'TURN_UPDATE').length, 0, 'ta sama tura: bez nowego zegara');
    assert.equal(p1.turn?.deadline, deadline);
    scheduler.advance(80_000);
    await flush();
    assert.equal(ofType(log.slice(before), 'GAME_STATE_SYNC', NAMES[P1]).at(-1)?.cause?.intent, 'TIMEOUT:END_TURN');
  });

  test('bitwa w trakcie tury boga zatrzymuje jej licznik, a po bitwie odlicza dalej od tego samego miejsca', async () => {
    const battleReady = (): GameState => withDice(actionsScenario(ARES_TURN, (g) => setIsland(g, MILOS, P2)), [0]);
    const { client, state, scheduler } = await table({ createGame: battleReady });
    const [p1, p2] = [client(P1), client(P2)];
    assert.deepEqual([p1.turn?.details, p1.turn?.remainingMs], [{ reason: 'GOD_TURN', god: 'ARES' }, 180_000]);

    scheduler.advance(100_000);
    await p1.executeAction({ type: 'MOVE_TROOPS', from: NAXOS, to: PAROS, troops: 2 });
    await flush();
    assert.equal(p1.turn?.details.reason, 'BATTLE_ROLL');
    scheduler.advance(20_000); // czas bitwy nie liczy się do tury boga
    await p2.rerollDice(); // remis 2:2 (kość zawsze 0)
    await p2.executeAction({ type: 'HOLD' });
    await p1.executeAction({ type: 'HOLD' });
    await p1.rerollDice(); // remis 1:1: wzajemne zniszczenie
    await flush();

    assert.equal(state().phase.phase, 'ACTIONS');
    assert.deepEqual([p1.turn?.details, p1.turn?.remainingMs], [{ reason: 'GOD_TURN', god: 'ARES' }, 80_000]);
  });
});

// ===========================================================================
describe('Zegar tury jako bezpiecznik', () => {
  test('gdy bot utknie, po limicie serwer wykonuje za niego ruch pasywny i gra idzie dalej', async () => {
    // maxAiSteps: 0 wyłącza ruchy AI po komendzie człowieka, więc bot „wisi”, dopóki nie wkroczy zegar.
    const { client, state, scheduler, log } = await table({ seats: seats('HUMAN', 'AI', 'AI'), maxAiSteps: 0 });
    const human = client(P1);
    for (let guard = 0; bidding(state()).order[0] === P1; guard++) {
      assert.ok(guard < 3);
      await human.submitBid({ kind: 'APOLLO' });
      await flush();
    }
    const stuck = at(bidding(state()).order, 0);
    assert.notEqual(stuck, P1);
    assert.deepEqual([human.turn?.actors, human.turn?.remainingMs], [[stuck], 60_000], 'na bota też jest limit');
    const before = log.length;
    scheduler.advance(60_000);
    await flush();
    const event = ofType(log.slice(before), 'BIDDING_EVENT')[0] ?? assert.fail('brak ruchu za bota');
    assert.deepEqual(event.cause, { playerId: stuck, requestId: null, intent: 'TIMEOUT:SUBMIT_BID' });
  });
});

// ===========================================================================
describe('Tryby bez limitu i domyślne limity w LAN', () => {
  test('pokój bez limitów (Single Player): zegar tury mówi, na kogo czeka gra, ale nie ma terminu', async () => {
    const { client, state, scheduler, log } = await table({ turnTimeouts: false });
    const bidder = at(bidding(state()).order, 0);
    assert.deepEqual([client(bidder).turn?.actors, client(bidder).turn?.deadline, client(bidder).turn?.remainingMs], [[bidder], null, null]);
    const before = log.length;
    scheduler.advance(24 * 3_600_000);
    await flush();
    assert.equal(log.length, before);
  });

  test('serwer LAN włącza domyślne limity, jeśli pokój nie ustawił własnych', async () => {
    const server = createLanServer({ host: '127.0.0.1', port: 0, discovery: false });
    server.createRoom({ roomId: 'lan', seats: seats('HUMAN', 'AI', 'AI'), createGame: (names, setup) => createSampleMatch(names, { rng: setup.rng }) });
    const host = new GameClient(server.connectLocal());
    await host.joinRoom('lan', 'Gospodarz');
    await flush();
    const turn = host.turn ?? assert.fail('brak zegara tury');
    assert.equal(turn.remainingMs, DEFAULT_TURN_TIMEOUTS[turn.details.reason === 'GOD_TURN' ? 'godTurn' : 'bidding']);
    await server.stop();
  });
});
