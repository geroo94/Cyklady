import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, test } from 'node:test';

import {
  DEFAULT_TURN_TIMEOUTS,
  GameClient,
  ManualScheduler,
  autoReconnect,
  connectWebSocket,
  createLanServer,
  createSinglePlayerServer,
  projectState,
  type GameServer,
  type RoomConfig,
  type SeatInfo,
} from '../src/net/index.ts';
import { expectPhase, type GameState, type PlayerId } from '../src/model/index.ts';
import { P1, P2, P3, createSampleMatch } from '../src/examples/sampleGame.ts';
import { fixedRng, flush, ofType, recorded, rejected, seats, type Delivery } from './netHarness.ts';

// ===========================================================================
// Pomocniki
// ===========================================================================

const NAMES: Readonly<Record<PlayerId, string>> = { [P1]: 'Ariadna', [P2]: 'Tezeusz', [P3]: 'Dedal' };

interface Table {
  readonly server: GameServer;
  readonly scheduler: ManualScheduler;
  readonly log: Delivery[];
  readonly clients: Map<PlayerId, GameClient>;
  readonly client: (playerId: PlayerId) => GameClient;
  readonly state: () => GameState;
  /** Nowe połączenie dla gracza (np. powrót po zerwaniu), zapisywane w tym samym dzienniku. */
  readonly channel: (playerId: PlayerId) => ReturnType<GameServer['connectLocal']>;
}

async function table(overrides: Partial<RoomConfig> = {}): Promise<Table> {
  const scheduler = new ManualScheduler();
  const server = createSinglePlayerServer();
  server.createRoom({
    roomId: 'stol',
    seats: seats('HUMAN', 'HUMAN', 'HUMAN'),
    createGame: (names, setup) => createSampleMatch(names, { rng: setup.rng }),
    createRng: fixedRng,
    scheduler,
    turnTimeouts: { ...DEFAULT_TURN_TIMEOUTS, bidding: 20_000 },
    ...overrides,
  });
  const log: Delivery[] = [];
  const channel = (playerId: PlayerId) => recorded(server.connectLocal(), NAMES[playerId] ?? playerId, log);
  const clients = new Map<PlayerId, GameClient>();
  for (const playerId of [P1, P2, P3]) {
    const client = new GameClient(channel(playerId));
    await client.joinRoom('stol', NAMES[playerId] ?? playerId);
    clients.set(playerId, client);
  }
  await flush();
  return {
    server,
    scheduler,
    log,
    clients,
    client: (playerId) => clients.get(playerId) ?? assert.fail(`brak klienta ${playerId}`),
    state: () => server.inspectRoom('stol')?.state ?? assert.fail('brak stanu'),
    channel,
  };
}

const seatOf = (client: GameClient, playerId: PlayerId): SeatInfo =>
  client.room?.seats.find((seat) => seat.playerId === playerId) ?? assert.fail(`brak miejsca ${playerId}`);
const bidder = (state: GameState): PlayerId => expectPhase(state, 'BIDDING').queue[0] ?? assert.fail('licytacja bez kolejki');
const other = (...excluded: PlayerId[]): PlayerId => [P1, P2, P3].find((playerId) => !excluded.includes(playerId)) ?? assert.fail();

// ===========================================================================
describe('Rozłączenie gracza w trakcie partii', () => {
  test('miejsce czeka 60 s: pozostali widzą rozłączenie i termin powrotu, a stan gry zostaje na serwerze', async () => {
    const { client, state, scheduler } = await table();
    const away = other(bidder(state()));
    const watcher = other(away);
    const before = state();
    client(away).close();
    await flush();

    const seat = seatOf(client(watcher), away);
    assert.deepEqual([seat.kind, seat.connected, seat.reconnectDeadline], ['HUMAN', false, scheduler.now() + 60_000]);
    assert.deepEqual(state().players, before.players, 'rozłączenie nie zmienia stanu gry');
  });

  test('powrót z żetonem w oknie: pełna migawka stanu, bieżący zegar tury i anulowane przejęcie miejsca', async () => {
    const { client, state, scheduler, log, channel } = await table();
    const first = bidder(state());
    const away = other(first);
    const watcher = other(away);
    client(away).close();
    await flush();

    // Pod nieobecność gracza gra toczy się dalej, więc jego replika się starzeje.
    scheduler.advance(10_000);
    await client(first).submitBid({ kind: 'APOLLO' });
    scheduler.advance(20_000);
    await flush();

    const before = log.length;
    const room = await client(away).reconnect(channel(away));
    await flush();
    assert.equal(room.you, away);
    const received = log.slice(before).filter((delivery) => delivery.who === NAMES[away]);
    assert.deepEqual(received.map((delivery) => delivery.message.type), ['ROOM_STATE', 'GAME_STATE_SYNC', 'TURN_UPDATE']);
    assert.equal(ofType(received, 'GAME_STATE_SYNC')[0]?.mode, 'FULL', 'pełna migawka, a nie łatka do starej wersji');
    assert.deepEqual(client(away).state, projectState(state(), away));
    assert.equal(client(away).turn?.turnId, client(watcher).turn?.turnId, 'ten sam zegar tury co u pozostałych');

    const seat = seatOf(client(watcher), away);
    assert.deepEqual([seat.connected, seat.reconnectDeadline], [true, null]);
    scheduler.advance(120_000);
    await flush();
    assert.equal(seatOf(client(watcher), away).kind, 'HUMAN', 'po powrocie komputer nie przejmuje miejsca');
  });

  test('tura nieobecnego gracza: po limicie serwer gra za niego ruch pasywny, a po powrocie widać to w migawce', async () => {
    const { client, state, scheduler, channel } = await table();
    const away = bidder(state());
    client(away).close();
    await flush();

    scheduler.advance(20_000); // limit licytacji: Apollo za nieobecnego
    await flush();
    assert.deepEqual(state().gods.apolloSupplicants, [away]);
    const watcher = other(away);
    assert.notDeepEqual(client(watcher).turn?.actors, [away], 'gra czeka już na kolejnego gracza');

    scheduler.advance(10_000);
    await client(away).reconnect(channel(away));
    await flush();
    assert.deepEqual(client(away).state?.gods.apolloSupplicants, [away]);
    assert.deepEqual(client(away).state, projectState(state(), away));
  });

  test('brak powrotu w oknie: miejsce przejmuje komputer i od razu wykonuje zaległy ruch, a żeton wygasa', async () => {
    const { client, state, scheduler, channel } = await table({ turnTimeouts: false });
    const away = bidder(state());
    const watcher = other(away);
    client(away).close();
    await flush();

    scheduler.advance(59_999);
    await flush();
    assert.equal(bidder(state()), away, 'bez limitu tury gra czeka na gracza przez całe okno powrotu');
    scheduler.advance(1);
    await flush();

    const seat = seatOf(client(watcher), away);
    assert.deepEqual([seat.kind, seat.name, seat.connected, seat.reconnectDeadline], ['AI', `${NAMES[away]} (AI)`, true, null]);
    assert.notEqual(expectPhase(state(), 'BIDDING').queue[0], away, 'komputer złożył ofiarę za gracza');
    const refused = await rejected(new GameClient(channel(away)).joinRoom('stol', NAMES[away] ?? '', client(away).room?.seatToken ?? undefined));
    assert.equal(refused.code, 'RECONNECT_EXPIRED');
    assert.match(refused.message, /Minął czas na powrót/);
  });

  test('drugie połączenie z tym samym żetonem przejmuje miejsce, a autoReconnect starego klienta nie walczy o nie', async () => {
    const { client, state, channel } = await table();
    const player = other(bidder(state()));
    const old = client(player);
    let attempts = 0;
    const stop = autoReconnect(old, () => Promise.resolve(channel(player)), { initialDelayMs: 1, onAttempt: () => attempts++ });
    const closes: number[] = [];
    old.on('disconnected', (info) => closes.push(info.code));

    const fresh = new GameClient(channel(player));
    await fresh.joinRoom('stol', NAMES[player] ?? '', old.room?.seatToken ?? undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual([closes, attempts], [[4000], 0]);
    assert.deepEqual(fresh.state, projectState(state(), player));
    stop();
  });
});

// ===========================================================================
// LAN: prawdziwe gniazda (bez ogłoszeń UDP)
// ===========================================================================

/** Pośrednik TCP: `dropAll` zrywa połączenia jak awaria Wi-Fi, bez zamykania WebSocket. */
async function tcpProxy(target: string): Promise<{ url: string; dropAll: () => void; close: () => Promise<void> }> {
  const { hostname, port } = new URL(target);
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  };
  const proxy = createServer((incoming) => {
    const upstream = createConnection({ host: hostname, port: Number(port) });
    track(incoming);
    track(upstream);
    incoming.pipe(upstream);
    upstream.pipe(incoming);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
  const address = proxy.address() as AddressInfo;
  const dropAll = (): void => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    url: `ws://127.0.0.1:${address.port}`,
    dropAll,
    close: () =>
      new Promise((resolve) => {
        dropAll();
        proxy.close(() => resolve());
      }),
  };
}

/** Klient, który po uzgodnieniu WebSocket i dołączeniu do pokoju milknie: nie odbiera ramek i nie odpowiada na ping. */
async function silentGuest(url: string, roomId: string): Promise<Socket> {
  const { hostname, port } = new URL(url);
  const socket = createConnection({ host: hostname, port: Number(port) });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(
    [`GET / HTTP/1.1`, `Host: ${hostname}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'),
  );
  const payload = Buffer.from(JSON.stringify({ v: 1, type: 'JOIN_ROOM', requestId: 'c1', roomId, playerName: 'Milczek' }));
  const mask = randomBytes(4);
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((byte, i) => byte ^ (mask[i % 4] as number))]));
  socket.pause(); // nic nie czyta, więc nie odpowie na ping
  return socket;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) assert.fail(`Nie doczekano się: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function lanTable(): Promise<{ server: GameServer; url: string; host: GameClient; scheduler: ManualScheduler }> {
  const scheduler = new ManualScheduler();
  const server = createLanServer({ host: '127.0.0.1', port: 0, discovery: false, heartbeatIntervalMs: 50, heartbeatTimeoutMs: 200 });
  server.createRoom({
    roomId: 'lan',
    seats: seats('HUMAN', 'HUMAN', 'AI'),
    createGame: (names, setup) => createSampleMatch(names, { rng: setup.rng }),
    createRng: fixedRng,
    scheduler,
  });
  const info = await server.start();
  const host = new GameClient(server.connectLocal());
  await host.joinRoom('lan', 'Gospodarz');
  return { server, url: info.url ?? assert.fail('brak adresu'), host, scheduler };
}

describe('LAN: wykrywanie zerwania i automatyczny powrót', () => {
  test('klient, który zamilkł (brak odpowiedzi na ping), zostaje uznany za rozłączonego w ułamku sekundy', async () => {
    const { server, url, host, scheduler } = await lanTable();
    const socket = await silentGuest(url, 'lan');
    try {
      await waitFor(() => host.room?.status === 'IN_GAME', 'start partii z milczącym gościem');
      await waitFor(() => seatOf(host, P2).connected === false, 'wykrycie zerwanego połączenia', 2_000);
      assert.equal(seatOf(host, P2).reconnectDeadline, scheduler.now() + 60_000, 'zaczyna się okno powrotu');
    } finally {
      socket.destroy();
      await server.stop();
    }
  });

  test('zwykły klient WebSocket odpowiada na ping i zostaje połączony', async () => {
    const { server, url, host } = await lanTable();
    const guest = new GameClient(await connectWebSocket(url));
    try {
      await guest.joinRoom('lan', 'Gość');
      await new Promise((resolve) => setTimeout(resolve, 400)); // kilka cykli ping/pong
      assert.equal(seatOf(host, P2).connected, true);
    } finally {
      guest.close();
      await server.stop();
    }
  });

  test('awaria sieci: autoReconnect łączy się ponownie, wraca na swoje miejsce i dostaje pełną migawkę stanu', async () => {
    const { server, url, host } = await lanTable();
    const proxy = await tcpProxy(url);
    const guest = new GameClient(await connectWebSocket(proxy.url));
    const reconnected: string[] = [];
    const stop = autoReconnect(guest, () => connectWebSocket(proxy.url), {
      initialDelayMs: 20,
      onReconnected: (room) => reconnected.push(room.you ?? '?'),
    });
    try {
      await guest.joinRoom('lan', 'Gość');
      await waitFor(() => guest.state !== null, 'start partii');

      proxy.dropAll();
      await waitFor(() => reconnected.length === 1, 'powrót do partii', 3_000);
      await waitFor(() => guest.turn !== null && seatOf(host, P2).connected, 'gość znów połączony');

      const state = server.inspectRoom('lan')?.state ?? assert.fail();
      assert.deepEqual(reconnected, [P2]);
      assert.deepEqual(guest.state, projectState(state, P2));
      assert.equal(seatOf(host, P2).kind, 'HUMAN');
    } finally {
      stop();
      guest.close();
      await proxy.close();
      await server.stop();
    }
  });
});
