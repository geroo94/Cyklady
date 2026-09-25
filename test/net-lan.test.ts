import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { describe, test } from 'node:test';

import {
  ActionRejectedError,
  GameClient,
  JSON_CODEC,
  MSGPACK_CODEC,
  connectWebSocket,
  createLanServer,
  createSinglePlayerServer,
  projectState,
  type ActionRejected,
  type GameServer,
} from '../src/net/index.ts';
import { pendingActors } from '../src/engine/index.ts';
import type { GameState, PlayerId } from '../src/model/index.ts';
import { P1, P2, P3, createSampleMatch } from '../src/examples/sampleGame.ts';

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

async function lanServer(): Promise<{ server: GameServer; url: string }> {
  // Bez ogłoszeń UDP: testy nie wysyłają pakietów do prawdziwej sieci lokalnej.
  const server = createLanServer({ host: '127.0.0.1', port: 0, discovery: false });
  server.createRoom({
    roomId: 'lan',
    seats: [
      { playerId: P1, color: 'BLUE', kind: 'HUMAN' },
      { playerId: P2, color: 'RED', kind: 'HUMAN' },
      { playerId: P3, color: 'GREEN', kind: 'HUMAN' },
    ],
    createGame: (names) => createSampleMatch(names),
  });
  const info = await server.start();
  return { server, url: info.url ?? assert.fail('serwer LAN bez adresu') };
}

const stateOf = (server: GameServer): GameState => server.inspectRoom('lan')?.state ?? assert.fail('brak stanu');

/** Surowe połączenie TCP po uzgodnieniu WebSocket, do testów łamania protokołu. */
async function rawWebSocket(url: string): Promise<{ socket: Socket; read: (bytes: number, timeoutMs?: number) => Promise<Buffer> }> {
  const { hostname, port } = new URL(url);
  const socket = createConnection({ host: hostname, port: Number(port) });
  let buffer = Buffer.alloc(0);
  const waiters: (() => void)[] = [];
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    waiters.splice(0).forEach((wake) => wake());
  });
  const read = async (bytes: number, timeoutMs = 2_000): Promise<Buffer> => {
    const deadline = Date.now() + timeoutMs;
    while (buffer.length < bytes) {
      const left = deadline - Date.now();
      if (left <= 0) assert.fail(`serwer nie odpowiedział ${bytes} bajtami w ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const result = buffer.subarray(0, bytes);
    buffer = buffer.subarray(bytes);
    return result;
  };
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(
    [
      `GET / HTTP/1.1`,
      `Host: ${hostname}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );
  // Odpowiedź uzgodnienia kończy się pustą linią.
  let head = '';
  while (!head.includes('\r\n\r\n')) head += (await read(1)).toString('latin1');
  assert.match(head, /^HTTP\/1\.1 101/);
  return { socket, read };
}

/** Ramka klienta. Domyślnie maskowana i kompletna, a flagi pozwalają ją celowo zepsuć. */
function clientFrame(opcode: number, payload: Buffer, options: { masked?: boolean; rsv?: boolean; declaredLength?: number } = {}): Buffer {
  const masked = options.masked ?? true;
  const length = options.declaredLength ?? payload.length;
  const header = length < 126 ? Buffer.from([0, length]) : length < 0x10000 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (length >= 126 && length < 0x10000) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else if (length >= 0x10000) {
    header[1] = 127;
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | (options.rsv ? 0x40 : 0) | opcode;
  if (!masked) return Buffer.concat([header, payload]);
  header[1] = (header[1] as number) | 0x80;
  const mask = randomBytes(4);
  const body = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] as number)));
  return Buffer.concat([header, mask, body]);
}

// ===========================================================================
describe('LAN przez WebSocket', () => {
  test('gospodarz przez Loopback i goście przez WebSocket (JSON i MessagePack) grają w jednym pokoju', async () => {
    const { server, url } = await lanServer();
    const host = new GameClient(server.connectLocal());
    const guestJson = new GameClient(await connectWebSocket(url, JSON_CODEC));
    const guestPacked = new GameClient(await connectWebSocket(url, MSGPACK_CODEC));
    const clients: readonly (readonly [GameClient, PlayerId])[] = [
      [host, P1],
      [guestJson, P2],
      [guestPacked, P3],
    ];
    const inSync = (): boolean => clients.every(([client]) => client.revision === stateOf(server).revision);
    try {
      await host.joinRoom('lan', 'Gospodarz');
      await guestJson.joinRoom('lan', 'Gość JSON');
      await guestPacked.joinRoom('lan', 'Gość MsgPack');
      await waitFor(inSync, 'pełny stan u wszystkich klientów');
      for (const [client, viewer] of clients) assert.deepEqual(client.state, projectState(stateOf(server), viewer));

      // Gracz, na którego czeka licytacja, idzie przez sieć do Apolla.
      const actor = pendingActors(stateOf(server))[0];
      const actorClient = clients.find(([, id]) => id === actor)?.[0] ?? assert.fail();
      await actorClient.submitBid({ kind: 'APOLLO' });
      await waitFor(inSync, 'łatka u wszystkich klientów');
      for (const [client, viewer] of clients) assert.deepEqual(client.state, projectState(stateOf(server), viewer));

      // Komenda poza kolejką jest odrzucana także przez sieć.
      const waitingFor = pendingActors(stateOf(server))[0];
      const outOfTurn = clients.find(([, id]) => id !== waitingFor)?.[0] ?? assert.fail();
      const error = await outOfTurn.submitBid({ kind: 'APOLLO' }).then(
        () => assert.fail('komenda poza kolejką powinna zostać odrzucona'),
        (reason: unknown) => reason,
      );
      assert.ok(error instanceof ActionRejectedError && error.code === 'NOT_YOUR_TURN');
    } finally {
      for (const [client] of clients) client.close();
      await server.stop();
    }
  });

  test('zwykłe żądanie HTTP dostaje 426, a uszkodzony JSON przez WebSocket kończy się MALFORMED', async () => {
    const { server, url } = await lanServer();
    try {
      const response = await fetch(url.replace('ws://', 'http://'));
      assert.equal(response.status, 426);
      await response.text();

      const socket = new WebSocket(url, ['cyklady.v1.json']);
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
      const reply = new Promise<ActionRejected>((resolve) =>
        socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as ActionRejected), { once: true }),
      );
      socket.send('{to nie jest JSON');
      const rejection = await reply;
      assert.deepEqual([rejection.type, rejection.code], ['ACTION_REJECTED', 'MALFORMED']);
      socket.close();
    } finally {
      await server.stop();
    }
  });

  test('naruszenia protokołu WebSocket zamykają połączenie z właściwym kodem', async () => {
    const { server, url } = await lanServer();
    try {
      const cases: [string, Buffer, number][] = [
        ['ramka klienta bez maski', clientFrame(0x1, Buffer.from('{}'), { masked: false }), 1002],
        ['ustawione bity RSV (brak rozszerzeń)', clientFrame(0x1, Buffer.from('{}'), { rsv: true }), 1002],
        ['wiadomość większa niż limit', clientFrame(0x1, Buffer.alloc(0), { declaredLength: 100_000 }), 1009],
        ['tekst niebędący UTF-8', clientFrame(0x1, Buffer.from([0xff, 0xfe])), 1007],
      ];
      for (const [what, frame, expectedCode] of cases) {
        const { socket, read } = await rawWebSocket(url);
        socket.write(frame);
        const closeFrame = await read(4);
        assert.equal(closeFrame[0], 0x88, `${what}: oczekiwano ramki zamknięcia`);
        assert.equal(closeFrame.readUInt16BE(2), expectedCode, what);
        socket.destroy();
      }
    } finally {
      await server.stop();
    }
  });

  test('serwer odpowiada na ping i potwierdza zamknięcie zainicjowane przez klienta', async () => {
    const { server, url } = await lanServer();
    try {
      const { socket, read } = await rawWebSocket(url);
      socket.write(clientFrame(0x9, Buffer.from('ping!')));
      const pong = await read(7);
      assert.deepEqual([pong[0], pong[1], pong.subarray(2).toString()], [0x8a, 5, 'ping!']);

      const code = Buffer.alloc(2);
      code.writeUInt16BE(1000);
      socket.write(clientFrame(0x8, code));
      const echo = await read(4);
      assert.deepEqual([echo[0], echo.readUInt16BE(2)], [0x88, 1000]);
      socket.destroy();
    } finally {
      await server.stop();
    }
  });

  test('tryb Single Player nie otwiera żadnego gniazda', async () => {
    const server = createSinglePlayerServer();
    assert.deepEqual(await server.start(), { mode: 'SINGLE_PLAYER', url: null, discoveryPort: null });
    await server.stop();
  });
});
