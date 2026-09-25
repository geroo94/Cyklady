import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { describe, test } from 'node:test';

import {
  DiscoveryBeacon,
  DiscoveryListener,
  GameClient,
  JSON_CODEC,
  activeModules,
  broadcastAddresses,
  connectManually,
  connectWebSocket,
  createLanServer,
  encodeBeacon,
  parseBeacon,
  parseServerAddress,
  serverUrl,
  subnetBroadcast,
  type BeaconPayload,
  type DiscoveryListenerOptions,
  type RoomAnnouncement,
} from '../src/net/index.ts';
import { archipelagoLobby } from '../src/examples/archipelago.ts';

// ===========================================================================
// Pomocniki
// ===========================================================================

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) assert.fail(`Nie doczekano się: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const BEACON: BeaconPayload = {
  magic: 'CYKLADY-LAN',
  v: 1,
  instanceId: 'serwer-1',
  hostName: 'Gospodarz',
  roomId: 'archipelag',
  roomName: 'Archipelag',
  status: 'WAITING',
  playerCount: 1,
  maxPlayers: 5,
  modulesActive: ['BASE', 'HADES', 'MONUMENTS'],
  serverPort: 7777,
};

const announcement = (overrides: Partial<RoomAnnouncement> = {}): RoomAnnouncement => ({
  hostName: 'Gospodarz',
  roomId: 'archipelag',
  roomName: 'Archipelag',
  status: 'WAITING',
  playerCount: 1,
  maxPlayers: 5,
  modulesActive: activeModules({ hades: true, monuments: false }),
  ...overrides,
});

/** Nasłuch na wolnym porcie (0 = przydział przez system). */
async function startListener(options: Omit<DiscoveryListenerOptions, 'port'> = {}): Promise<{ listener: DiscoveryListener; port: number }> {
  const listener = new DiscoveryListener({ port: 0, ...options });
  await listener.start();
  return { listener, port: listener.port ?? assert.fail('nasłuch bez portu') };
}

// ===========================================================================
describe('Format ogłoszenia (beacon)', () => {
  test('ogłoszenie przechodzi przez kodowanie i odczyt, a moduły wynikają z dodatków', () => {
    assert.deepEqual(parseBeacon(encodeBeacon(BEACON)), BEACON);
    assert.ok(encodeBeacon(BEACON).length < 400, 'ogłoszenie mieści się w jednym małym datagramie');
    assert.deepEqual(activeModules({ hades: true, monuments: true }), ['BASE', 'HADES', 'MONUMENTS']);
    assert.deepEqual(activeModules({ hades: false, monuments: false }), ['BASE']);
  });

  test('obce i uszkodzone pakiety są ignorowane', () => {
    const variants: Record<string, unknown>[] = [
      { ...BEACON, magic: 'INNA-GRA' },
      { ...BEACON, v: 2 },
      { ...BEACON, playerCount: 6 },
      { ...BEACON, modulesActive: ['BASE', 'TITANS'] },
      { ...BEACON, serverPort: 0 },
      { ...BEACON, serverPort: 70_000 },
      { ...BEACON, hostName: '' },
      { ...BEACON, roomName: 'x'.repeat(65) },
      { ...BEACON, status: 'PAUSED' },
    ];
    for (const variant of variants) assert.equal(parseBeacon(Buffer.from(JSON.stringify(variant))), null, JSON.stringify(variant));
    assert.equal(parseBeacon(Buffer.from('to nie JSON')), null);
    assert.equal(parseBeacon(Buffer.from('null')), null);
    assert.equal(parseBeacon(Buffer.from(JSON.stringify(BEACON) + ' '.repeat(1_100))), null, 'za duży pakiet, choć poprawny');
    const noisy = '\u0001'.repeat(64);
    assert.throws(() => encodeBeacon({ ...BEACON, hostName: noisy, roomId: noisy, roomName: noisy }), /limit 1024 B/);
  });

  test('adres rozgłoszeniowy podsieci wynika z adresu i maski interfejsu', () => {
    assert.equal(subnetBroadcast('192.168.1.20', '255.255.255.0'), '192.168.1.255');
    assert.equal(subnetBroadcast('10.1.2.3', '255.255.0.0'), '10.1.255.255');
    assert.equal(subnetBroadcast('172.16.5.4', '255.255.255.252'), '172.16.5.7');
    assert.ok(broadcastAddresses().includes('255.255.255.255'));
  });
});

// ===========================================================================
describe('Ogłoszenia UDP: nadawca i nasłuch na 127.0.0.1', () => {
  test('nasłuch widzi pokój z adresem nadawcy i metadanymi, a zmiany docierają od razu', async () => {
    const { listener, port } = await startListener();
    let playerCount = 1;
    const beacon = new DiscoveryBeacon({
      port,
      targets: ['127.0.0.1'],
      serverPort: 7777,
      intervalMs: 60_000,
      rooms: () => [announcement({ playerCount })],
    });
    try {
      await beacon.start();
      await waitFor(() => listener.rooms().length === 1, 'pierwsze ogłoszenie');
      const room = listener.rooms()[0] ?? assert.fail();
      assert.deepEqual(
        [room.hostName, room.roomName, room.playerCount, room.maxPlayers, room.modulesActive, room.address, room.url],
        ['Gospodarz', 'Archipelag', 1, 5, ['BASE', 'HADES'], '127.0.0.1', 'ws://127.0.0.1:7777'],
      );

      const seen: number[] = [];
      listener.onChange((rooms) => seen.push(rooms[0]?.playerCount ?? -1));
      playerCount = 2;
      beacon.announceNow();
      await waitFor(() => listener.rooms()[0]?.playerCount === 2, 'nowa liczba graczy');
      assert.deepEqual(seen, [2], 'jedna zmiana, jedno powiadomienie');
    } finally {
      await beacon.stop();
      await listener.stop();
    }
  });

  test('kolejne ogłoszenia podtrzymują pokój, a po ich ustaniu pokój znika z listy', async () => {
    const { listener, port } = await startListener({ ttlMs: 300 });
    const beacon = new DiscoveryBeacon({ port, targets: ['127.0.0.1'], serverPort: 7777, intervalMs: 50, rooms: () => [announcement()] });
    const updates: number[] = [];
    listener.onChange((rooms) => updates.push(rooms.length));
    try {
      await beacon.start();
      await waitFor(() => listener.rooms().length === 1, 'ogłoszenie');
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.deepEqual([listener.rooms().length, updates], [1, [1]], 'pokój żyje dłużej niż TTL, a powtórzenia nie są zmianą');
      await beacon.stop();
      // Interfejs może w tym czasie odpytywać listę: powiadomienie o zniknięciu pokoju i tak musi przyjść.
      await waitFor(() => listener.rooms().length === 0 && updates.at(-1) === 0, 'wygaśnięcie pokoju z powiadomieniem');
    } finally {
      await beacon.stop();
      await listener.stop();
    }
  });

  test('wygasły pokój znika z listy od razu, a kolejne ogłoszenie go przywraca', async () => {
    let clock = 1_000;
    const { listener, port } = await startListener({ ttlMs: 60_000, now: () => clock });
    const sender = createSocket('udp4');
    const send = (): void => sender.send(encodeBeacon(BEACON), port, '127.0.0.1');
    try {
      send();
      await waitFor(() => listener.rooms().length === 1, 'ogłoszenie');
      clock += 60_001;
      assert.deepEqual(listener.rooms(), [], 'lista nie czeka na zegar sprzątający');
      send();
      await waitFor(() => listener.rooms().length === 1, 'ponowne ogłoszenie');
    } finally {
      sender.close();
      await listener.stop();
    }
  });

  test('zajęty port: start nasłuchu zgłasza błąd, a po zwolnieniu portu można spróbować ponownie', async () => {
    const blocker = createSocket('udp4').unref();
    await new Promise<void>((resolve) => blocker.bind(0, () => resolve()));
    const port = blocker.address().port;
    const listener = new DiscoveryListener({ port });
    const sender = createSocket('udp4');
    try {
      await assert.rejects(listener.start(), { code: 'EADDRINUSE' });
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await listener.start();
      sender.send(encodeBeacon(BEACON), port, '127.0.0.1');
      await waitFor(() => listener.rooms().length === 1, 'ogłoszenie po ponownym starcie');
    } finally {
      sender.close();
      await listener.stop();
    }
  });

  test('powtórzone ogłoszenia to jeden wpis, a liczba zapamiętanych pokoi jest ograniczona', async () => {
    const { listener, port } = await startListener({ maxRooms: 3 });
    const sender = createSocket('udp4');
    const notifications: number[] = [];
    listener.onChange((rooms) => notifications.push(rooms.length));
    try {
      for (let i = 0; i < 10; i++) {
        const packet = encodeBeacon({ ...BEACON, instanceId: `serwer-${i}` });
        sender.send(packet, port, '127.0.0.1');
        sender.send(packet, port, '127.0.0.1');
      }
      await waitFor(() => listener.rooms().length === 3, 'trzy pokoje');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual([listener.rooms().length, notifications], [3, [1, 2, 3]], 'duplikaty bez nowych wpisów i powiadomień, zalew bez zapełniania pamięci');
    } finally {
      sender.close();
      await listener.stop();
    }
  });
});

// ===========================================================================
describe('Łączenie ręczne po adresie IP i porcie', () => {
  test('adres wpisany przez gracza: IPv4, nazwa hosta, IPv6, domyślny port', () => {
    const valid: [string, string, number][] = [
      ['192.168.1.20', '192.168.1.20', 7777],
      ['  192.168.1.20:9000 ', '192.168.1.20', 9000],
      ['ws://gra.local:9000/', 'gra.local', 9000],
      ['[fe80::1]:7778', 'fe80::1', 7778],
      ['fe80::1', 'fe80::1', 7777],
    ];
    for (const [input, host, port] of valid) assert.deepEqual(parseServerAddress(input), { host, port }, input);
    for (const input of ['', '1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:12x', 'zła nazwa!', '1.2.3.4:80:90', '[zz::1]:80', '[fe80::1%en0]:80']) {
      assert.equal(parseServerAddress(input), null, input);
    }
    assert.equal(serverUrl({ host: 'fe80::1', port: 7777 }), 'ws://[fe80::1]:7777');
  });

  test('connectManually łączy się z serwerem LAN i pozwala dołączyć do lobby', async () => {
    const server = createLanServer({ host: '127.0.0.1', port: 0, discovery: false });
    server.createRoom(archipelagoLobby('archipelag', 'Archipelag'));
    const info = await server.start();
    const port = new URL(info.url ?? assert.fail()).port;
    const client = new GameClient(await connectManually(`127.0.0.1:${port}`));
    try {
      const room = await client.joinRoom('archipelag', 'Gość ręczny');
      assert.deepEqual([room.status, room.you], ['WAITING', 'p1']);
    } finally {
      client.close();
      await server.stop();
    }
  });

  test('błędny adres i nieosiągalny serwer kończą się czytelnym błędem', async () => {
    await assert.rejects(connectManually('to nie jest adres'), /Niepoprawny adres serwera/);
    await assert.rejects(connectManually('127.0.0.1:1', JSON_CODEC, 2_000), /Nie udało się połączyć|nie odpowiada/);
  });
});

// ===========================================================================
describe('LAN od ogłoszenia do startu gry', () => {
  test('gość znajduje pokój w sieci, dołącza przez WebSocket, a ogłoszenie śledzi lobby aż do startu', async () => {
    const { listener, port } = await startListener();
    const server = createLanServer({
      host: '127.0.0.1',
      port: 0,
      // Długi takt: każda zmiana w lobby musi dotrzeć natychmiastowym ogłoszeniem.
      discovery: { port, targets: ['127.0.0.1'], intervalMs: 60_000 },
    });
    server.createRoom(archipelagoLobby('archipelag', 'Archipelag'));
    const info = await server.start();
    const host = new GameClient(server.connectLocal());
    const clients: GameClient[] = [host];
    const firstRoom = () => listener.rooms()[0];
    try {
      assert.equal(info.discoveryPort, port);
      await host.joinRoom('archipelag', 'Gospodarz');
      await waitFor(() => firstRoom()?.playerCount === 1, 'ogłoszenie pokoju hosta');
      const found = firstRoom() ?? assert.fail();
      assert.deepEqual(
        [found.roomName, found.hostName, found.maxPlayers, found.modulesActive, found.status, found.url],
        ['Archipelag', 'Gospodarz', 5, ['BASE', 'HADES', 'MONUMENTS'], 'WAITING', info.url],
      );

      const guest = new GameClient(await connectWebSocket(found.url));
      clients.push(guest);
      await guest.joinRoom(found.roomId, 'Gość z sieci');
      await waitFor(() => firstRoom()?.playerCount === 2, 'ogłoszenie z nowym graczem');

      await host.setExpansions({ hades: true, monuments: false });
      await waitFor(() => firstRoom()?.modulesActive.join('+') === 'BASE+HADES', 'ogłoszenie ze zmienionymi dodatkami');

      await host.addBot(2);
      await guest.setReady(true);
      await host.startGame();
      await waitFor(() => firstRoom()?.status === 'IN_GAME', 'ogłoszenie trwającej partii');
      await waitFor(() => guest.state !== null, 'stan gry u gościa');
      assert.equal(server.inspectRoom('archipelag')?.state?.monuments, null, 'partia bez Monumentów, jak ustawił host');
    } finally {
      for (const client of clients) client.close();
      await server.stop();
      await listener.stop();
    }
  });
});
