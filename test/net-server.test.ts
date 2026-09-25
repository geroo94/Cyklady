import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ActionRejectedError,
  GameClient,
  createSinglePlayerServer,
  projectState,
  type BattleEventMessage,
  type ClientChannel,
  type GameServer,
  type GameStateSync,
  type RoomConfig,
  type SeatKind,
} from '../src/net/index.ts';
import { pendingActors } from '../src/engine/index.ts';
import { expectPhase, type GameState, type PlayerId } from '../src/model/index.ts';
import { MILOS, NAXOS, P1, P2, P3, PAROS, createSampleMatch } from '../src/examples/sampleGame.ts';
import { ARES_TURN, actionsScenario, playAllTurns, setIsland, updateIsland, withDice } from './helpers.ts';

// ===========================================================================
// Pomocniki
// ===========================================================================

/** Oczekiwanie, aż wszystkie mikrozadania pętli w pamięci (Loopback) się wykonają. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function seats(...kinds: readonly SeatKind[]): RoomConfig['seats'] {
  const colors = ['BLUE', 'RED', 'GREEN'] as const;
  return kinds.map((kind, i) => ({ playerId: [P1, P2, P3][i] as PlayerId, color: colors[i] ?? 'BLUE', kind }));
}

function soloServer(overrides: Partial<RoomConfig> = {}): GameServer {
  const server = createSinglePlayerServer();
  server.createRoom({ roomId: 'solo', seats: seats('HUMAN', 'AI', 'AI'), createGame: (names) => createSampleMatch(names), ...overrides });
  return server;
}

function serverState(server: GameServer, roomId = 'solo'): GameState {
  return server.inspectRoom(roomId)?.state ?? assert.fail('pokój bez stanu');
}

async function rejected(promise: Promise<unknown>): Promise<ActionRejectedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ActionRejectedError) return error;
    throw error;
  }
  return assert.fail('komenda powinna zostać odrzucona');
}

/** Zapisuje synchronizacje odebrane przez klienta. */
function recordSyncs(client: GameClient): GameStateSync[] {
  const syncs: GameStateSync[] = [];
  client.on('state', (_state, sync) => syncs.push(sync));
  return syncs;
}

/** Kanał, który na żądanie gubi jedną łatkę stanu (symulacja zgubionej wiadomości). */
function lossyChannel(inner: ClientChannel): { channel: ClientChannel; dropNextPatch: () => void; dropped: () => number } {
  let drop = false;
  let dropped = 0;
  const listeners: ((message: unknown) => void)[] = [];
  inner.onMessage((message) => {
    const sync = message as Partial<GameStateSync>;
    if (drop && sync.type === 'GAME_STATE_SYNC' && sync.mode === 'PATCH') {
      drop = false;
      dropped++;
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    channel: { ...inner, onMessage: (listener) => void listeners.push(listener) },
    dropNextPatch: () => {
      drop = true;
    },
    dropped: () => dropped,
  };
}

/** Scenariusz bitwy: P1 (Ares) może zaatakować Paros gracza P2, który ma też Milos. Kość: zawsze 0. */
function battleReady(): GameState {
  return withDice(actionsScenario(ARES_TURN, (g) => setIsland(g, MILOS, P2)), [0]);
}

// ===========================================================================
describe('Single Player (Local Loopback)', () => {
  test('dołączenie uruchamia partię, a AI gra, dopóki gra nie czeka na człowieka', async () => {
    const server = soloServer();
    const client = new GameClient(server.connectLocal());
    const syncs = recordSyncs(client);

    const room = await client.joinRoom('solo', 'Ariadna');
    await flush();
    assert.deepEqual([room.you, room.status, room.seats.map((seat) => seat.kind)], [P1, 'IN_GAME', ['HUMAN', 'AI', 'AI']]);
    assert.ok(room.seatToken && room.seatToken.length > 20, 'żeton miejsca trafia tylko do właściciela');

    const state = serverState(server);
    assert.deepEqual(pendingActors(state), [P1], 'gra czeka na człowieka');
    assert.equal(syncs[0]?.mode, 'FULL', 'pierwsza synchronizacja to pełny stan');
    assert.ok(syncs.slice(1).every((sync) => sync.mode === 'PATCH'), 'kolejne to łatki');
    assert.ok(syncs.slice(1).every((sync) => sync.cause?.intent.startsWith('AI:')), 'zmiany po starcie wykonało AI');
    assert.deepEqual(client.state, projectState(state, P1), 'replika klienta = projekcja serwera');
    await server.stop();
  });

  test('replika klienta nadąża za serwerem przez całą rundę: licytacja, tury, nowy cykl', async () => {
    const server = soloServer();
    const client = new GameClient(server.connectLocal());
    await client.joinRoom('solo', 'Ariadna');
    await flush();

    // Licytacja: Apollo jest zawsze legalny.
    const bid = await client.submitBid({ kind: 'APOLLO' });
    assert.equal(bid.cause?.playerId, P1);
    await flush();
    assert.deepEqual(client.state, projectState(serverState(server), P1));

    // AI kończy swoje tury, więc następna jest tura Apolla gracza P1.
    let state = serverState(server);
    assert.equal(state.phase.phase, 'ACTIONS');
    assert.deepEqual(pendingActors(state), [P1]);
    await client.endTurn();
    await flush();

    state = serverState(server);
    assert.equal(state.cycle, 2, 'po turze P1 zaczyna się nowy cykl');
    assert.equal(state.phase.phase, 'BIDDING');
    assert.deepEqual(client.state, projectState(state, P1));
    assert.equal(client.revision, state.revision);
    await server.stop();
  });

  test('serwer odrzuca komendy niezgodne z zasadami i nie zmienia wtedy stanu', async () => {
    const server = soloServer();
    const client = new GameClient(server.connectLocal());
    await client.joinRoom('solo', 'Ariadna');
    await flush();
    const before = serverState(server);

    const tooExpensive = await rejected(client.submitBid({ kind: 'GOD', god: before.gods.slots[0]!.god, amount: 50 }));
    assert.equal(tooExpensive.code, 'CANNOT_AFFORD');
    assert.match(tooExpensive.message, /kosztuje/);

    const notMyTurn = await rejected(client.endTurn());
    assert.equal(notMyTurn.code, 'NOT_ACTIONS_PHASE');

    const unsupported = await rejected(client.executeAction({ type: 'BUY_CREATURE', slot: 0 }));
    assert.equal(unsupported.code, 'UNSUPPORTED_ACTION');

    const noBattle = await rejected(client.rerollDice());
    assert.equal(noBattle.code, 'NOT_IN_BATTLE');

    assert.equal(serverState(server), before, 'odrzucone komendy nie tworzą nowego stanu');
    await server.stop();
  });

  test('uszkodzone i podrobione wiadomości: MALFORMED, a podany playerId jest ignorowany', async () => {
    const server = soloServer();
    const channel = server.connectLocal();
    const client = new GameClient(channel);
    const rejections: string[] = [];
    client.on('rejected', (message) => rejections.push(`${message.requestId}:${message.code}`));
    await client.joinRoom('solo', 'Ariadna');
    await flush();

    channel.send({ v: 1, type: 'SUBMIT_BID', requestId: 'x1' } as never);
    channel.send({ v: 1, type: 'SUBMIT_BID', requestId: 'x2', playerId: P2, bid: { kind: 'APOLLO' } } as never);
    await flush();

    assert.deepEqual(rejections, ['x1:MALFORMED'], 'brak pola bid to MALFORMED');
    // AI wybiera Apolla dopiero bez wolnych bogów, więc jedynym graczem u Apolla jest właściciel połączenia.
    assert.deepEqual(serverState(server).gods.apolloSupplicants, [P1], 'ofiara trafiła do P1 mimo podrobionego playerId');
    await server.stop();
  });
});

// ===========================================================================
describe('Hotseat: kilku graczy w jednym procesie', () => {
  test('każdy gracz ma własne połączenie i własną projekcję stanu', async () => {
    const server = createSinglePlayerServer();
    server.createRoom({ roomId: 'hotseat', seats: seats('HUMAN', 'HUMAN', 'AI'), createGame: (names) => createSampleMatch(names) });
    const ariadna = new GameClient(server.connectLocal());
    const tezeusz = new GameClient(server.connectLocal());

    const first = await ariadna.joinRoom('hotseat', 'Ariadna');
    assert.equal(first.status, 'WAITING', 'partia czeka na drugiego człowieka');
    await tezeusz.joinRoom('hotseat', 'Tezeusz');
    await flush();

    assert.equal(ariadna.room?.status, 'IN_GAME');
    const state = serverState(server, 'hotseat');
    assert.deepEqual(ariadna.state, projectState(state, P1));
    assert.deepEqual(tezeusz.state, projectState(state, P2));
    assert.equal(ariadna.state?.players[P2]?.gold, null, 'Ariadna nie widzi złota Tezeusza');
    assert.equal(tezeusz.state?.players[P2]?.gold, state.players[P2]?.gold);
    await server.stop();
  });

  test('bitwa: BATTLE_EVENT dla wszystkich, REROLL_DICE tylko dla uczestników, rzuty na serwerze', async () => {
    const server = createSinglePlayerServer();
    server.createRoom({ roomId: 'bitwa', seats: seats('HUMAN', 'HUMAN', 'HUMAN'), createGame: battleReady });
    const [p1, p2, p3] = [new GameClient(server.connectLocal()), new GameClient(server.connectLocal()), new GameClient(server.connectLocal())];
    const feed: BattleEventMessage[] = [];
    p3.on('battle', (message) => feed.push(message));
    await p1.joinRoom('bitwa', 'Ariadna');
    await p2.joinRoom('bitwa', 'Tezeusz');
    await p3.joinRoom('bitwa', 'Dedal');
    await flush();

    await p1.executeAction({ type: 'MOVE_TROOPS', from: NAXOS, to: PAROS, troops: 2 });
    await flush();
    assert.deepEqual(feed.at(-1)?.events[0], { type: 'BATTLE_STARTED', kind: 'LAND', where: PAROS, attacker: P1, defender: P2 });
    assert.equal((await rejected(p3.rerollDice())).code, 'NOT_A_PARTICIPANT');

    // Remis 2:2 (kość zawsze 0): obie strony tracą po oddziale, potem decyzje o odwrocie.
    await p2.rerollDice();
    await flush();
    assert.equal(feed.at(-1)?.events[0]?.type, 'ROUND_RESOLVED');
    await p2.executeAction({ type: 'HOLD' });
    await p1.executeAction({ type: 'HOLD' });
    await p1.rerollDice();
    await flush();

    const outcomes = feed.flatMap((message) => message.events).filter((event) => event.type === 'BATTLE_ENDED');
    assert.deepEqual(outcomes, [{ type: 'BATTLE_ENDED', outcome: { kind: 'MUTUAL_DESTRUCTION' } }], 'sprzątanie wykonał serwer');
    const state = serverState(server, 'bitwa');
    assert.equal(expectPhase(state, 'ACTIONS').progress.movements, 1, 'tura Aresa trwa dalej');
    for (const [client, viewer] of [[p1, P1], [p2, P2], [p3, P3]] as const) assert.deepEqual(client.state, projectState(state, viewer));
    await server.stop();
  });
});

// ===========================================================================
describe('Koniec gry i powrót do gry', () => {
  test('GAME_OVER trafia do wszystkich, a dalsze komendy są odrzucane', async () => {
    const metropolis = { metropolis: { origin: 'BUILDINGS' as const, builtInCycle: 1 } };
    const winning = (): GameState =>
      playAllTurns(
        actionsScenario(ARES_TURN, (g) =>
          updateIsland(updateIsland(setIsland(g, MILOS, P1, 1), NAXOS, (i) => ({ ...i, metropolisSlot: metropolis })), MILOS, (i) => ({
            ...i,
            metropolisSlot: metropolis,
          })),
        ),
      );
    const server = soloServer({ createGame: winning });
    const client = new GameClient(server.connectLocal());
    const endings: string[] = [];
    client.on('gameOver', (message) => endings.push(`${message.winners.join(',')}@${message.finalCycle}`));

    await client.joinRoom('solo', 'Ariadna');
    await flush();
    assert.deepEqual(endings, [`${P1}@1`]);
    assert.equal(client.room?.status, 'FINISHED');
    assert.equal((await rejected(client.endTurn())).code, 'GAME_FINISHED');
    await server.stop();
  });

  test('powrót z żetonem miejsca: to samo miejsce i pełny stan, a bez żetonu nie da się wejść do trwającej partii', async () => {
    const server = soloServer();
    const first = new GameClient(server.connectLocal());
    const { seatToken } = await first.joinRoom('solo', 'Ariadna');
    await flush();
    first.close();
    await flush();

    const intruder = new GameClient(server.connectLocal());
    const full = await rejected(intruder.joinRoom('solo', 'Obcy'));
    assert.equal(full.code, 'ROOM_FULL');
    assert.match(full.message, /żetonem/, 'komunikat mówi, jak wrócić do trwającej partii');
    assert.equal((await rejected(intruder.joinRoom('solo', 'Obcy', 'podrobiony-token'))).code, 'INVALID_SEAT_TOKEN');

    const back = new GameClient(server.connectLocal());
    const syncs = recordSyncs(back);
    const room = await back.joinRoom('solo', 'Ariadna', seatToken ?? undefined);
    await flush();
    assert.equal(room.you, P1);
    assert.equal(syncs[0]?.mode, 'FULL');
    assert.deepEqual(back.state, projectState(serverState(server), P1));
    await server.stop();
  });

  test('klient po zgubionej łatce sam prosi o pełny stan i wraca do zgodności z serwerem', async () => {
    const server = createSinglePlayerServer();
    server.createRoom({ roomId: 'bitwa', seats: seats('HUMAN', 'HUMAN', 'HUMAN'), createGame: battleReady });
    const p1 = new GameClient(server.connectLocal());
    const p2 = new GameClient(server.connectLocal());
    const lossy = lossyChannel(server.connectLocal());
    const observer = new GameClient(lossy.channel);
    const syncs = recordSyncs(observer);
    await p1.joinRoom('bitwa', 'Ariadna');
    await p2.joinRoom('bitwa', 'Tezeusz');
    await observer.joinRoom('bitwa', 'Dedal');
    await flush();

    lossy.dropNextPatch();
    await p1.executeAction({ type: 'MOVE_TROOPS', from: NAXOS, to: PAROS, troops: 2 }); // ta łatka ginie po drodze do P3
    await p2.rerollDice(); // następna łatka nie pasuje do rewizji P3
    await flush();

    assert.equal(lossy.dropped(), 1);
    assert.deepEqual(syncs.map((sync) => sync.mode).filter((mode) => mode === 'FULL').length, 2, 'start + ponowna synchronizacja');
    const state = serverState(server, 'bitwa');
    assert.equal(observer.revision, state.revision);
    assert.deepEqual(observer.state, projectState(state, P3));
    await server.stop();
  });
});
