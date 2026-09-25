/**
 * @file Transport LAN: WebSocket (RFC 6455).
 *
 * Serwer: minimalna implementacja protokołu na `node:http`, bez zależności.
 * Obsługuje uzgodnienie połączenia (upgrade) z wyborem podprotokołu
 * (kodeka), ramki tekstowe i binarne, fragmentację, ping/pong i zamknięcie.
 * Co `heartbeatIntervalMs` wysyła każdemu klientowi ping. Klient, od którego
 * przez `heartbeatTimeoutMs` nie przyszła żadna ramka (nawet pong), zostaje
 * rozłączony, więc zerwane Wi-Fi albo uśpiony laptop wykrywamy w sekundach,
 * a nie po minutach, jak przy samym TCP keep-alive.
 * Chroni się przed błędnymi i złośliwymi klientami: ramki klienta muszą
 * być maskowane, bity RSV muszą być zerowe (nie negocjujemy rozszerzeń),
 * obowiązuje limit rozmiaru wiadomości, a tekst musi być poprawnym UTF-8.
 *
 * Klient: standardowe API `WebSocket`, dostępne w przeglądarkach i w Node,
 * więc ta sama klasa klienta działa w aplikacji przeglądarkowej i desktopowej.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

import { CODECS, JSON_CODEC, type CodecName, type MessageCodec } from './codec.ts';
import type { ClientMessage } from './protocol.ts';
import { withCodec, type ClientChannel, type CloseInfo, type RawChannel } from './transport.ts';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Podprotokół WebSocket wyznacza kodek wiadomości. */
export const SUBPROTOCOLS: Readonly<Record<CodecName, string>> = {
  json: 'cyklady.v1.json',
  msgpack: 'cyklady.v1.msgpack',
};

/** Kody zamknięcia RFC 6455 używane przez serwer. */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  INVALID_DATA: 1007,
  TOO_BIG: 1009,
} as const;

const Opcode = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa } as const;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const EMPTY = Buffer.alloc(0);

/** Koduje ramkę serwera (serwer NIE maskuje ramek). */
function encodeFrame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length < 0x10000 ? 4 : 10;
  const frame = Buffer.alloc(headerLength + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) frame[1] = length;
  else if (length < 0x10000) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(length, 6);
  }
  frame.set(payload, headerLength);
  return frame;
}

// ===========================================================================
// Połączenie po stronie serwera
// ===========================================================================

class WebSocketConnection implements RawChannel {
  readonly remote: string;
  readonly #socket: Socket;
  readonly #maxPayload: number;
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentOpcode: number | null = null;
  #fragmentSize = 0;
  #closed = false;
  /** Chwila ostatnio odebranych danych (dowolna ramka, także pong). */
  #lastActivity = Date.now();
  readonly #dataListeners: ((data: string | Uint8Array) => void)[] = [];
  readonly #closeListeners: ((info: CloseInfo) => void)[] = [];

  constructor(socket: Socket, maxPayload: number, remote: string) {
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.remote = remote;
    socket.on('close', () => this.#finish({ code: 1006, reason: 'połączenie zerwane' }));
    socket.on('error', () => socket.destroy());
  }

  onData(listener: (data: string | Uint8Array) => void): void {
    this.#dataListeners.push(listener);
  }

  onClose(listener: (info: CloseInfo) => void): void {
    this.#closeListeners.push(listener);
  }

  send(data: string | Uint8Array): void {
    if (this.#closed) return;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.#socket.write(encodeFrame(typeof data === 'string' ? Opcode.TEXT : Opcode.BINARY, payload));
  }

  close(code: number = CloseCode.NORMAL, reason = ''): void {
    if (this.#closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.#socket.write(encodeFrame(Opcode.CLOSE, payload));
    this.#socket.end();
    this.#finish({ code, reason });
  }

  /** Wysyła ping (klient WebSocket odpowiada na niego automatycznie). */
  ping(): void {
    if (!this.#closed) this.#socket.write(encodeFrame(Opcode.PING, EMPTY));
  }

  /** Ile ms minęło od ostatnich danych od klienta. */
  idleFor(now: number): number {
    return now - this.#lastActivity;
  }

  /** Zrywa połączenie bez uzgadniania zamknięcia: druga strona i tak nie odpowiada. */
  terminate(reason: string): void {
    this.#socket.destroy();
    this.#finish({ code: 1006, reason });
  }

  /** Przyjmuje kolejną porcję bajtów z gniazda i przetwarza wszystkie kompletne ramki. */
  receive(chunk: Buffer): void {
    this.#lastActivity = Date.now();
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (!this.#closed && this.#readFrame()) {
      // każda iteracja zdejmuje z bufora jedną kompletną ramkę
    }
  }

  /** Zwraca `true`, gdy zdjęto ramkę z bufora, i `false`, gdy trzeba poczekać na więcej danych. */
  #readFrame(): boolean {
    const buffer = this.#buffer;
    if (buffer.length < 2) return false;
    const first = buffer[0] as number;
    const second = buffer[1] as number;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let offset = 2;

    if ((first & 0x70) !== 0) return this.#fail(CloseCode.PROTOCOL_ERROR, 'rozszerzenia nie są obsługiwane');
    if ((second & 0x80) === 0) return this.#fail(CloseCode.PROTOCOL_ERROR, 'ramki klienta muszą być maskowane');
    if (length === 126) {
      if (buffer.length < 4) return false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return false;
      if (buffer.readUInt32BE(2) !== 0) return this.#fail(CloseCode.TOO_BIG, 'wiadomość jest za duża');
      length = buffer.readUInt32BE(6);
      offset = 10;
    }
    const isControl = opcode >= 0x8;
    if (isControl && (!fin || length > 125)) return this.#fail(CloseCode.PROTOCOL_ERROR, 'błędna ramka sterująca');
    if (length > this.#maxPayload) return this.#fail(CloseCode.TOO_BIG, 'wiadomość jest za duża');
    if (buffer.length < offset + 4 + length) return false;

    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
    this.#buffer = buffer.subarray(offset + 4 + length);
    this.#handleFrame(fin, opcode, payload);
    return true;
  }

  #handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case Opcode.PING:
        this.#socket.write(encodeFrame(Opcode.PONG, payload));
        return;
      case Opcode.PONG:
        return;
      case Opcode.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : CloseCode.NORMAL;
        this.close(code === 1005 || code === 1006 ? CloseCode.NORMAL : code);
        return;
      }
      case Opcode.TEXT:
      case Opcode.BINARY:
        if (this.#fragmentOpcode !== null) {
          this.#fail(CloseCode.PROTOCOL_ERROR, 'nowa wiadomość przed końcem poprzedniej');
          return;
        }
        if (fin) this.#deliver(opcode, payload);
        else {
          this.#fragmentOpcode = opcode;
          this.#fragments = [payload];
          this.#fragmentSize = payload.length;
        }
        return;
      case Opcode.CONTINUATION: {
        if (this.#fragmentOpcode === null) {
          this.#fail(CloseCode.PROTOCOL_ERROR, 'kontynuacja bez początku wiadomości');
          return;
        }
        this.#fragmentSize += payload.length;
        if (this.#fragmentSize > this.#maxPayload) {
          this.#fail(CloseCode.TOO_BIG, 'wiadomość jest za duża');
          return;
        }
        this.#fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.#fragments);
          const kind = this.#fragmentOpcode;
          this.#fragmentOpcode = null;
          this.#fragments = [];
          this.#fragmentSize = 0;
          this.#deliver(kind, whole);
        }
        return;
      }
      default:
        this.#fail(CloseCode.PROTOCOL_ERROR, `nieznany kod ramki ${opcode}`);
    }
  }

  #deliver(opcode: number, payload: Buffer): void {
    let data: string | Uint8Array;
    if (opcode === Opcode.TEXT) {
      try {
        data = utf8.decode(payload);
      } catch {
        this.#fail(CloseCode.INVALID_DATA, 'tekst nie jest poprawnym UTF-8');
        return;
      }
    } else {
      data = new Uint8Array(payload);
    }
    for (const listener of this.#dataListeners) listener(data);
  }

  #fail(code: number, reason: string): false {
    this.close(code, reason);
    return false;
  }

  /** Zamknięcie następuje raz: kolejne wywołania (np. zdarzenie `close` gniazda) są pomijane. */
  #finish(info: CloseInfo): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener(info);
  }
}

// ===========================================================================
// Nasłuch (serwer LAN)
// ===========================================================================

export interface WebSocketListenerOptions {
  /** Największa wiadomość od klienta w bajtach (domyślnie 64 KiB: intencje są małe). */
  readonly maxPayload?: number;
  /** Co ile ms wysyłać ping do klientów (domyślnie 10 s, 0 wyłącza). */
  readonly heartbeatIntervalMs?: number;
  /** Po ilu ms bez żadnych danych od klienta uznać połączenie za zerwane (domyślnie 25 s). */
  readonly heartbeatTimeoutMs?: number;
}

export type AcceptHandler = (channel: RawChannel, codec: MessageCodec) => void;

export class WebSocketListener {
  readonly #server: Server;
  readonly #connections = new Set<WebSocketConnection>();
  readonly #sockets = new Set<Socket>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(onAccept: AcceptHandler, options: WebSocketListenerOptions = {}) {
    const maxPayload = options.maxPayload ?? 64 * 1024;
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    if (heartbeatIntervalMs > 0) {
      const timeoutMs = options.heartbeatTimeoutMs ?? 25_000;
      this.#heartbeat = setInterval(() => this.#checkHeartbeats(timeoutMs), heartbeatIntervalMs);
      this.#heartbeat.unref();
    }
    this.#server = createServer((_request, response) => {
      response.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket' });
      response.end('Serwer gry Cyklady: połącz się przez WebSocket.\n');
    });
    this.#server.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    this.#server.on('upgrade', (request, socket: Socket, head: Buffer) => {
      const key = request.headers['sec-websocket-key'];
      const isUpgrade = String(request.headers.upgrade ?? '').toLowerCase() === 'websocket';
      if (!isUpgrade || typeof key !== 'string' || request.headers['sec-websocket-version'] !== '13') {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      const offered = String(request.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const chosen = (Object.keys(SUBPROTOCOLS) as CodecName[]).find((name) => offered.includes(SUBPROTOCOLS[name]));
      if (offered.length > 0 && chosen === undefined) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      const accept = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
      const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
      if (chosen !== undefined) lines.push(`Sec-WebSocket-Protocol: ${SUBPROTOCOLS[chosen]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);

      const connection = new WebSocketConnection(socket, maxPayload, `${request.socket.remoteAddress}:${request.socket.remotePort}`);
      this.#connections.add(connection);
      connection.onClose(() => this.#connections.delete(connection));
      onAccept(connection, chosen === undefined ? JSON_CODEC : CODECS[chosen]);
      if (head.length > 0) connection.receive(head);
      socket.on('data', (chunk: Buffer) => connection.receive(chunk));
    });
  }

  /** Nasłuch na interfejsie `host` (np. `0.0.0.0` dla całej sieci lokalnej). Port 0 = wybierz wolny. */
  listen(port: number, host: string): Promise<{ readonly host: string; readonly port: number }> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        const address = this.#server.address();
        if (address === null || typeof address === 'string') return reject(new Error('Nieznany adres serwera'));
        resolve({ host: address.address, port: address.port });
      });
    });
  }

  /** Ping dla żywych połączeń, zerwanie tych, które zamilkły. */
  #checkHeartbeats(timeoutMs: number): void {
    const now = Date.now();
    for (const connection of this.#connections) {
      if (connection.idleFor(now) > timeoutMs) connection.terminate('brak odpowiedzi na ping');
      else connection.ping();
    }
  }

  /** Zamyka wszystkie połączenia (kod 1001) i przestaje nasłuchiwać. */
  close(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const connection of this.#connections) connection.close(CloseCode.GOING_AWAY, 'serwer kończy pracę');
    for (const socket of this.#sockets) socket.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

// ===========================================================================
// Klient
// ===========================================================================

/**
 * Łączy się z serwerem LAN przez standardowe API WebSocket (przeglądarka albo Node).
 * Po `timeoutMs` bez nawiązania połączenia zwraca błąd.
 */
export function connectWebSocket(url: string, codec: MessageCodec = JSON_CODEC, timeoutMs = 10_000): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [SUBPROTOCOLS[codec.name]]);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Serwer ${url} nie odpowiada (limit ${timeoutMs} ms)`));
    }, timeoutMs);
    socket.binaryType = 'arraybuffer';
    const dataListeners: ((data: string | Uint8Array) => void)[] = [];
    const closeListeners: ((info: CloseInfo) => void)[] = [];
    const raw: RawChannel = {
      remote: url,
      send: (data) => socket.send(data),
      close: (code = CloseCode.NORMAL, reason = '') => socket.close(code, reason),
      onData: (listener) => void dataListeners.push(listener),
      onClose: (listener) => void closeListeners.push(listener),
    };
    socket.addEventListener('message', (event: MessageEvent) => {
      const data: string | Uint8Array = typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer);
      for (const listener of dataListeners) listener(data);
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      for (const listener of closeListeners) listener({ code: event.code, reason: event.reason });
    });
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(withCodec<ClientMessage>(raw, codec));
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error(`Nie udało się połączyć z ${url}`));
      },
      { once: true },
    );
  });
}
