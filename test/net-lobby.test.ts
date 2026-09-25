import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ActionRejectedError,
  GameClient,
  createLoopbackPair,
  createSinglePlayerServer,
  parseClientMessage,
  type GameServer,
  type RoomConfig,
  type RoomState,
} from '../src/net/index.ts';
import { pendingActors } from '../src/engine/index.ts';
import { IslandId, PlayerId, getIsland, validateGameState, type GameState } from '../src/model/index.ts';
import { archipelagoLobby } from '../src/examples/archipelago.ts';

// ===========================================================================
// Pomocniki
// ===========================================================================

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const [P1, P2, P3] = [PlayerId('p1'), PlayerId('p2'), PlayerId('p3')];

function lobbyServer(overrides: Partial<RoomConfig> = {}): GameServer {
  const server = createSinglePlayerServer();
  server.createRoom(archipelagoLobby('lobby', 'Lobby testowe', overrides));
  return server;
}

/** Klient „zdalny”: kanał w pamięci, ale serwer widzi go jako połączenie z sieci. */
function remoteClient(server: GameServer, address = '192.168.1.50:50000'): GameClient {
  const { client, server: serverSide } = createLoopbackPair();
  server.accept({ ...serverSide, remote: address });
  return new GameClient(client);
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

const seat = (room: RoomState | null, slot: number) => room?.seats[slot] ?? assert.fail(`brak slotu ${slot}`);
const stateOf = (server: GameServer): GameState => server.inspectRoom('lobby')?.state ?? assert.fail('partia nie wystartowała');

/** Host lokalny i gość zdalny w lobby Archipelagu. */
async function hostAndGuest(overrides: Partial<RoomConfig> = {}) {
  const server = lobbyServer(overrides);
  const host = new GameClient(server.connectLocal());
  const guest = remoteClient(server);
  await host.joinRoom('lobby', 'Gospodarz');
  await guest.joinRoom('lobby', 'Gość');
  await flush();
  return { server, host, guest };
}

// ===========================================================================
describe('Lobby: dołączanie i host', () => {
  test('gracze zajmują kolejne sloty z proponowanymi kolorami, a hostem jest gracz lokalny', async () => {
    const { server, host, guest } = await hostAndGuest();
    const room = host.room;
    assert.deepEqual([room?.status, room?.host, host.playerId, guest.playerId], ['WAITING', P1, P1, P2]);
    assert.deepEqual(
      room?.seats.map((s) => [s.kind, s.name, s.color]),
      [
        ['HUMAN', 'Gospodarz', 'BLUE'],
        ['HUMAN', 'Gość', 'RED'],
        ['EMPTY', null, null],
        ['EMPTY', null, null],
        ['EMPTY', null, null],
      ],
    );
    assert.deepEqual(
      [room?.settings.startMode, room?.settings.minPlayers, room?.settings.maxPlayers, room?.settings.cities.length],
      ['HOST', 3, 5, 5],
    );
    assert.deepEqual(server.listRooms()[0], {
      roomId: 'lobby',
      roomName: 'Lobby testowe',
      status: 'WAITING',
      hostName: 'Gospodarz',
      playerCount: 2,
      maxPlayers: 5,
      expansions: { hades: true, monuments: true },
    });
    await server.stop();
  });

  test('przy polityce LOCAL_ONLY gość z sieci nie zostaje hostem, nawet gdy dołączy pierwszy', async () => {
    const server = lobbyServer();
    const guest = remoteClient(server);
    await guest.joinRoom('lobby', 'Szybki gość');
    assert.equal(guest.room?.host, null, 'nikt z sieci nie przejmuje uprawnień hosta');
    assert.equal((await rejected(guest.addBot(2))).code, 'NOT_HOST');

    const host = new GameClient(server.connectLocal());
    await host.joinRoom('lobby', 'Gospodarz');
    await flush();
    assert.equal(guest.room?.host, host.playerId);
    await server.stop();
  });

  test('przy polityce FIRST_HUMAN host przechodzi na kolejnego gracza, gdy poprzedni wyjdzie', async () => {
    const { server, host, guest } = await hostAndGuest({ hostPolicy: 'FIRST_HUMAN' });
    const third = remoteClient(server, '192.168.1.52:50002');
    await third.joinRoom('lobby', 'Trzeci');
    assert.equal(third.room?.host, P1, 'hostem jest najwcześniej przybyły gracz');
    host.close();
    await flush();
    assert.deepEqual([guest.room?.host, third.room?.host], [P2, P2], 'uprawnienia przechodzą na kolejnego w kolejności przybycia');
    assert.equal(seat(guest.room, 0).kind, 'EMPTY', 'przed startem slot wychodzącego gracza się zwalnia');
    await server.stop();
  });

  test('konfiguracja pokoju mieści się w granicach protokołu i ogłoszeń LAN', () => {
    const server = createSinglePlayerServer();
    assert.throws(() => server.createRoom(archipelagoLobby('lobby', 'x'.repeat(65))), /od 1 do 64 znaków/);
    assert.throws(() => server.createRoom(archipelagoLobby('', 'Lobby')), /od 1 do 64 znaków/);
    const seats = Array.from({ length: 17 }, (_, i) => ({ playerId: PlayerId(`p${i + 1}`), color: 'BLUE' as const, kind: 'HUMAN' as const }));
    assert.throws(() => server.createRoom(archipelagoLobby('lobby', 'Lobby', { seats })), /najwyżej 16 slotów/);
  });

  test('zwolniony slot i kolor może zająć kolejny gracz', async () => {
    const { server, host, guest } = await hostAndGuest();
    guest.close();
    await flush();
    assert.equal(seat(host.room, 1).kind, 'EMPTY');
    const next = remoteClient(server, '192.168.1.51:50001');
    const room = await next.joinRoom('lobby', 'Następny');
    assert.deepEqual([room.you, seat(room, 1).color], [P2, 'RED']);
    await server.stop();
  });
});

// ===========================================================================
describe('Lobby: kolory, miasta i gotowość', () => {
  test('kolor: wolny można wybrać, zajętego nie, a zmiana kasuje gotowość', async () => {
    const { server, guest } = await hostAndGuest();
    assert.equal((await rejected(guest.setColor('BLUE'))).code, 'COLOR_TAKEN');
    assert.equal(seat(await guest.setReady(true), 1).ready, true);
    const room = await guest.setColor('BLACK');
    assert.deepEqual([seat(room, 1).color, seat(room, 1).ready], ['BLACK', false]);
    await server.stop();
  });

  test('miasto: unikalne, znane, a `null` oznacza przydział automatyczny', async () => {
    const { server, host, guest } = await hostAndGuest();
    await guest.setReady(true);
    const chosen = await guest.setCity('naxos');
    assert.deepEqual([seat(chosen, 1).city, seat(chosen, 1).ready], ['naxos', false], 'zmiana miasta kasuje gotowość');
    assert.equal((await rejected(host.setCity('naxos'))).code, 'CITY_TAKEN');
    assert.equal((await rejected(host.setCity('atlantyda'))).code, 'UNKNOWN_CITY');
    assert.equal(seat(await host.setCity(null), 0).city, null);
    await server.stop();
  });

  test('walidator odrzuca błędne akcje lobby jeszcze przed pokojem', () => {
    const invalid = [
      { type: 'SET_COLOR', color: 'PINK' },
      { type: 'SET_READY', ready: 'tak' },
      { type: 'ADD_BOT', slot: 99 },
      { type: 'SET_EXPANSIONS', hades: true },
      { type: 'KICK', slot: 1 },
    ];
    for (const action of invalid) {
      const parsed = parseClientMessage({ v: 1, type: 'LOBBY_ACTION', requestId: 'c1', action });
      assert.equal(parsed.ok, false, JSON.stringify(action));
    }
    const valid = parseClientMessage({ v: 1, type: 'LOBBY_ACTION', requestId: 'c1', action: { type: 'SET_CITY', city: null, x: 1 } });
    assert.deepEqual(valid, { ok: true, message: { v: 1, type: 'LOBBY_ACTION', requestId: 'c1', action: { type: 'SET_CITY', city: null } } });
  });
});

// ===========================================================================
describe('Lobby: dodatki i boty (uprawnienia hosta)', () => {
  test('dodatki zmienia tylko host, a zmiana kasuje gotowość wszystkich', async () => {
    const { server, host, guest } = await hostAndGuest();
    await guest.setReady(true);
    assert.equal((await rejected(guest.setExpansions({ hades: false, monuments: false }))).code, 'NOT_HOST');
    const room = await host.setExpansions({ hades: false, monuments: true });
    assert.deepEqual(room.settings.expansions, { hades: false, monuments: true });
    assert.equal(seat(room, 1).ready, false, 'gość musi potwierdzić nowe ustawienia');
    assert.deepEqual(server.listRooms()[0]?.expansions, { hades: false, monuments: true });
    await server.stop();
  });

  test('dodatku niedostępnego na serwerze nie da się włączyć, a lobby pokazuje, które są dostępne', async () => {
    const { server, host } = await hostAndGuest({ availableExpansions: { hades: false, monuments: true } });
    const settings = host.room?.settings;
    assert.deepEqual(
      [settings?.expansions, settings?.availableExpansions],
      [{ hades: false, monuments: true }, { hades: false, monuments: true }],
      'konfiguracja początkowa nie włącza niedostępnego dodatku',
    );
    assert.equal((await rejected(host.setExpansions({ hades: true, monuments: true }))).code, 'EXPANSION_UNAVAILABLE');
    assert.deepEqual((await host.setExpansions({ hades: false, monuments: false })).settings.expansions, { hades: false, monuments: false });
    await server.stop();
  });

  test('host dodaje boty na wolne sloty i usuwa je, a goście nie mogą', async () => {
    const { server, host, guest } = await hostAndGuest();
    await guest.setReady(true);
    const withBot = await host.addBot(2);
    assert.equal(seat(withBot, 1).ready, false, 'nowy skład przy stole wymaga ponownego potwierdzenia');
    assert.deepEqual(
      [seat(withBot, 2).kind, seat(withBot, 2).name, seat(withBot, 2).color, seat(withBot, 2).ready],
      ['AI', 'Komputer 1', 'GREEN', true],
    );
    assert.equal((await rejected(host.addBot(2))).code, 'SLOT_OCCUPIED');
    assert.equal((await rejected(host.addBot(9))).code, 'INVALID_SLOT');
    assert.equal((await rejected(guest.addBot(3))).code, 'NOT_HOST');
    assert.equal((await rejected(host.removeBot(1))).code, 'NOT_A_BOT', 'człowieka nie da się usunąć jak bota');
    assert.equal(seat(await host.removeBot(2), 2).kind, 'EMPTY');
    await host.addBot(3);
    await host.addBot(4);
    await host.removeBot(3);
    const bots = (await host.addBot(2)).seats.filter((s) => s.kind === 'AI').map((s) => s.name);
    assert.deepEqual(bots, ['Komputer 1', 'Komputer 2'], 'nazwy botów się nie powtarzają');
    await server.stop();
  });

  test('w trybie WHEN_FULL bot na ostatnim wolnym slocie od razu rozpoczyna partię', async () => {
    const server = lobbyServer({ startMode: 'WHEN_FULL', seats: archipelagoLobby('x', 'x').seats.slice(0, 3) });
    const host = new GameClient(server.connectLocal());
    await host.joinRoom('lobby', 'Gospodarz');
    await host.addBot(1);
    assert.equal(host.room?.status, 'WAITING');
    await host.addBot(2);
    await flush();
    assert.equal(host.room?.status, 'IN_GAME');
    assert.ok(host.state, 'po starcie przychodzi pełny stan gry');
    await server.stop();
  });
});

// ===========================================================================
describe('Lobby: start partii', () => {
  test('start: tylko host, co najmniej 3 graczy, wszyscy goście gotowi', async () => {
    const { server, host, guest } = await hostAndGuest();
    assert.equal((await rejected(guest.startGame())).code, 'NOT_HOST');
    const tooFew = await rejected(host.startGame());
    assert.equal(tooFew.code, 'NOT_ENOUGH_PLAYERS');
    assert.match(tooFew.message, /Dodaj boty/);

    await host.addBot(2);
    const notReady = await rejected(host.startGame());
    assert.equal(notReady.code, 'NOT_ALL_READY');
    assert.match(notReady.message, /Gość/);

    await guest.setReady(true);
    const started = await host.startGame();
    await flush();
    assert.equal(started.status, 'IN_GAME');
    assert.equal(guest.room?.status, 'IN_GAME');
    assert.ok(host.state && guest.state, 'obaj gracze dostali pełny stan gry');
    await server.stop();
  });

  test('partia powstaje z ustawień lobby: kolory, miasta (wybrane i przydzielone) oraz dodatki', async () => {
    const { server, host, guest } = await hostAndGuest();
    await guest.setColor('BLACK');
    await guest.setCity('naxos');
    await host.addBot(2);
    await host.setExpansions({ hades: false, monuments: true });
    await guest.setReady(true);
    await host.startGame();
    await flush();

    const state = stateOf(server);
    assert.deepEqual(validateGameState(state), []);
    assert.deepEqual(state.seating, [P1, P2, P3]);
    assert.deepEqual(state.seating.map((id) => state.players[id]?.color), ['BLUE', 'BLACK', 'GREEN']);
    // Gość wybrał Naxos, a host i bot dostali pierwsze wolne miasta w kolejności listy.
    const owner = (city: string) => getIsland(state.board, IslandId(city)).ownerId;
    assert.deepEqual([owner('naxos'), owner('andros'), owner('mykonos')], [P2, P1, P3]);
    assert.equal(state.hades, null, 'Hades wyłączony w lobby');
    assert.ok(Object.values(state.catalog.mythCards).every((card) => card.type !== 'HERO'), 'bez Hadesa nie ma herosów');
    assert.notEqual(state.monuments, null, 'Monumenty włączone');
    assert.ok(!pendingActors(state).includes(P3), 'bot gra sam: gra nigdy nie czeka na AI');
    await server.stop();
  });

  test('po starcie lobby jest zamknięte: zmiany ustawień i nowi gracze bez żetonu są odrzucani', async () => {
    const { server, host, guest } = await hostAndGuest();
    await host.addBot(2);
    await guest.setReady(true);
    await host.startGame();
    await flush();

    assert.equal((await rejected(guest.setReady(false))).code, 'GAME_ALREADY_STARTED');
    assert.equal((await rejected(host.addBot(3))).code, 'GAME_ALREADY_STARTED');
    const late = remoteClient(server, '192.168.1.60:50002');
    assert.equal((await rejected(late.joinRoom('lobby', 'Spóźniony'))).code, 'ROOM_FULL');
    await server.stop();
  });
});
