/**
 * @file Wykrywanie serwerów w sieci lokalnej (LAN Discovery) i łączenie ręczne.
 *
 *   Host:    DiscoveryBeacon ── UDP broadcast co 1,5 s ──► port 45454
 *   Klient:  DiscoveryListener (port 45454) ── lista pokoi ──► menu „Dołącz do gry LAN”
 *            └── wybór pokoju ──► connectWebSocket(ws://adres-nadawcy:serverPort)
 *   Awaryjnie: connectManually("192.168.1.20:7777")
 *
 * Ogłoszenie (beacon) to mały JSON w jednym datagramie. Adres serwera klient
 * bierze z nagłówka pakietu (adres nadawcy), a nie z treści, więc nie trzeba
 * znać własnego IP w sieci. Pole `instanceId` odróżnia serwery i pozwala
 * zignorować duplikaty z kilku interfejsów.
 *
 * Ogłoszenia nie są uwierzytelnione (to zaufana sieć lokalna). Nasłuch
 * waliduje każde pole, ogranicza rozmiar pakietu i liczbę zapamiętanych
 * serwerów, a nieaktualne wpisy wygasają.
 */

import { randomUUID } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { isIPv6 } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';

import { JSON_CODEC, type MessageCodec } from './codec.ts';
import { PROTOCOL_VERSION, type RoomStatus } from './protocol.ts';
import type { ClientChannel } from './transport.ts';
import { connectWebSocket } from './websocket.ts';

export const DISCOVERY_PORT = 45454;
export const DEFAULT_SERVER_PORT = 7777;
const MAGIC = 'CYKLADY-LAN';
const MAX_PACKET_BYTES = 1_024;

/** Moduły gry ogłaszane w beaconie. */
export type GameModule = 'BASE' | 'HADES' | 'MONUMENTS';

/** Treść ogłoszenia: jeden pokój jednego serwera. */
export interface BeaconPayload {
  readonly magic: typeof MAGIC;
  readonly v: typeof PROTOCOL_VERSION;
  /** Losowy identyfikator uruchomienia serwera. */
  readonly instanceId: string;
  readonly hostName: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly status: RoomStatus;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly modulesActive: readonly GameModule[];
  /** Port WebSocket serwera gry. */
  readonly serverPort: number;
}

/** Opis pokoju dostarczany przez serwer przy każdym ogłoszeniu. */
export type RoomAnnouncement = Omit<BeaconPayload, 'magic' | 'v' | 'instanceId' | 'serverPort'>;

// ===========================================================================
// Format pakietu
// ===========================================================================

export function encodeBeacon(payload: BeaconPayload): Buffer {
  const data = Buffer.from(JSON_CODEC.encode(payload) as string, 'utf8');
  if (data.length > MAX_PACKET_BYTES) throw new Error(`Ogłoszenie ma ${data.length} B (limit ${MAX_PACKET_BYTES} B)`);
  return data;
}

const MODULES: readonly GameModule[] = ['BASE', 'HADES', 'MONUMENTS'];
const STATUSES: readonly RoomStatus[] = ['WAITING', 'IN_GAME', 'FINISHED'];
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/** Odczytuje ogłoszenie albo zwraca `null` dla obcych i uszkodzonych pakietów. */
export function parseBeacon(data: Uint8Array): BeaconPayload | null {
  if (data.length > MAX_PACKET_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON_CODEC.decode(data);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const modules = p['modulesActive'];
  const valid =
    p['magic'] === MAGIC &&
    p['v'] === PROTOCOL_VERSION &&
    isText(p['instanceId'], 64) &&
    isText(p['hostName'], 64) &&
    isText(p['roomId'], 64) &&
    isText(p['roomName'], 64) &&
    STATUSES.includes(p['status'] as RoomStatus) &&
    isCount(p['playerCount'], 16) &&
    isCount(p['maxPlayers'], 16) &&
    (p['playerCount'] as number) <= (p['maxPlayers'] as number) &&
    Array.isArray(modules) &&
    modules.length <= MODULES.length &&
    modules.every((module) => MODULES.includes(module as GameModule)) &&
    isCount(p['serverPort'], 65_535) &&
    (p['serverPort'] as number) > 0;
  if (!valid) return null;
  return {
    magic: MAGIC,
    v: PROTOCOL_VERSION,
    instanceId: p['instanceId'] as string,
    hostName: p['hostName'] as string,
    roomId: p['roomId'] as string,
    roomName: p['roomName'] as string,
    status: p['status'] as RoomStatus,
    playerCount: p['playerCount'] as number,
    maxPlayers: p['maxPlayers'] as number,
    modulesActive: [...new Set(modules as GameModule[])],
    serverPort: p['serverPort'] as number,
  };
}

/** Moduły aktywne w pokoju: zawsze podstawka i włączone dodatki. */
export function activeModules(expansions: { readonly hades: boolean; readonly monuments: boolean }): GameModule[] {
  return ['BASE', ...(expansions.hades ? (['HADES'] as const) : []), ...(expansions.monuments ? (['MONUMENTS'] as const) : [])];
}

/**
 * Adresy rozgłoszeniowe: adres każdego interfejsu IPv4 z bitami hosta
 * ustawionymi na 1 (np. 192.168.1.255) oraz ogólny 255.255.255.255.
 * Adresy podsieci docierają pewniej, bo 255.255.255.255 system często
 * wysyła tylko domyślnym interfejsem.
 */
export function broadcastAddresses(): string[] {
  const addresses = new Set<string>();
  for (const info of Object.values(networkInterfaces()).flat()) {
    if (info && info.family === 'IPv4' && !info.internal) addresses.add(subnetBroadcast(info.address, info.netmask));
  }
  addresses.add('255.255.255.255');
  return [...addresses];
}

/** Adres rozgłoszeniowy podsieci, np. 192.168.1.20 z maską 255.255.255.0 → 192.168.1.255. */
export function subnetBroadcast(address: string, netmask: string): string {
  const mask = netmask.split('.').map(Number);
  return address
    .split('.')
    .map((octet, i) => (Number(octet) | (~(mask[i] ?? 0) & 0xff)) & 0xff)
    .join('.');
}

/**
 * Wiąże gniazdo z portem. Nieudane wiązanie (np. port zajęty) zamyka gniazdo
 * i odrzuca obietnicę; po udanym dalsze błędy (np. chwilowy brak sieci) są
 * pomijane, bo ogłoszenia i tak powtarzają się co takt.
 */
function bindSocket(socket: Socket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      socket.close();
      reject(error);
    };
    socket.once('error', fail);
    socket.bind(port, () => {
      socket.off('error', fail);
      socket.on('error', () => undefined);
      resolve();
    });
  });
}

// ===========================================================================
// Host: ogłoszenia
// ===========================================================================

export interface BeaconOptions {
  /** Port UDP ogłoszeń (domyślnie 45454). */
  readonly port?: number;
  /** Odstęp między ogłoszeniami (domyślnie 1500 ms, zalecane 1000–2000 ms). */
  readonly intervalMs?: number;
  /** Adresy docelowe (domyślnie `broadcastAddresses()`, w testach np. `127.0.0.1`). */
  readonly targets?: readonly string[];
  /** Port WebSocket serwera gry. */
  readonly serverPort: number;
  /** Pokoje do ogłoszenia, odczytywane przy każdym wysłaniu (aktualna liczba graczy). */
  readonly rooms: () => readonly RoomAnnouncement[];
}

export class DiscoveryBeacon {
  readonly instanceId = randomUUID();
  readonly #options: BeaconOptions;
  #socket: Socket | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BeaconOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#socket) return;
    const socket = createSocket('udp4');
    this.#socket = socket;
    try {
      await bindSocket(socket, 0);
    } catch (error) {
      this.#socket = null;
      throw error;
    }
    socket.setBroadcast(true);
    this.announceNow();
    this.#timer = setInterval(() => this.announceNow(), this.#options.intervalMs ?? 1_500);
    this.#timer.unref();
  }

  /** Wysyła ogłoszenia od razu (np. po zmianie w lobby), bez czekania na kolejny takt. */
  announceNow(): void {
    const socket = this.#socket;
    if (!socket) return;
    const targets = this.#options.targets ?? broadcastAddresses();
    const port = this.#options.port ?? DISCOVERY_PORT;
    for (const room of this.#options.rooms()) {
      const packet = encodeBeacon({ magic: MAGIC, v: PROTOCOL_VERSION, instanceId: this.instanceId, serverPort: this.#options.serverPort, ...room });
      for (const target of targets) socket.send(packet, port, target, () => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}

/** Nazwa hosta w ogłoszeniu: nazwa gracza-gospodarza albo nazwa komputera. */
export function defaultHostName(playerName: string | null): string {
  return (playerName ?? hostname()).slice(0, 64) || 'Cyklady';
}

// ===========================================================================
// Klient: lista pokoi w sieci
// ===========================================================================

export interface DiscoveredRoom {
  /** Klucz wpisu: `instanceId/roomId`. */
  readonly key: string;
  readonly hostName: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly status: RoomStatus;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly modulesActive: readonly GameModule[];
  /** Adres nadawcy ogłoszenia. */
  readonly address: string;
  readonly serverPort: number;
  /** Gotowy adres do `connectWebSocket`. */
  readonly url: string;
  readonly lastSeen: number;
}

export interface DiscoveryListenerOptions {
  readonly port?: number;
  /** Po jakim czasie bez ogłoszenia pokój znika z listy (domyślnie 5 s). */
  readonly ttlMs?: number;
  /** Najwięcej zapamiętanych pokoi (ochrona przed zalewem ogłoszeń). */
  readonly maxRooms?: number;
  /** Źródło czasu (testy). */
  readonly now?: () => number;
}

export class DiscoveryListener {
  readonly #options: DiscoveryListenerOptions;
  readonly #rooms = new Map<string, DiscoveredRoom>();
  readonly #listeners = new Set<(rooms: readonly DiscoveredRoom[]) => void>();
  #socket: Socket | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DiscoveryListenerOptions = {}) {
    this.#options = options;
  }

  /** Nasłuch na porcie ogłoszeń. `reuseAddr` pozwala kilku klientom na jednym komputerze słuchać naraz. */
  async start(): Promise<void> {
    if (this.#socket) return;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.#socket = socket;
    socket.on('message', (data: Buffer, sender: RemoteInfo) => this.#receive(data, sender));
    try {
      await bindSocket(socket, this.#options.port ?? DISCOVERY_PORT);
    } catch (error) {
      this.#socket = null;
      throw error;
    }
    const ttl = this.#options.ttlMs ?? 5_000;
    this.#timer = setInterval(() => this.#prune(), Math.max(50, Math.floor(ttl / 2)));
    this.#timer.unref();
  }

  /** Port, na którym nasłuch faktycznie działa (przydatne przy porcie 0). */
  get port(): number | null {
    return this.#socket ? this.#socket.address().port : null;
  }

  /** Aktualna lista pokoi (bez wygasłych), posortowana po nazwie hosta i pokoju. */
  rooms(): DiscoveredRoom[] {
    const deadline = this.#deadline();
    return [...this.#rooms.values()]
      .filter((room) => room.lastSeen >= deadline)
      .sort((a, b) => a.hostName.localeCompare(b.hostName, 'pl') || a.roomName.localeCompare(b.roomName, 'pl'));
  }

  /** Subskrypcja zmian listy. Zwraca funkcję, która ją anuluje. */
  onChange(listener: (rooms: readonly DiscoveredRoom[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** Pokoje widziane ostatnio przed tą chwilą są nieaktualne. */
  #deadline(): number {
    return this.#now() - (this.#options.ttlMs ?? 5_000);
  }

  #receive(data: Buffer, sender: RemoteInfo): void {
    const beacon = parseBeacon(data);
    if (!beacon) return;
    const key = `${beacon.instanceId}/${beacon.roomId}`;
    if (!this.#rooms.has(key) && this.#rooms.size >= (this.#options.maxRooms ?? 64)) return;
    const previous = this.#rooms.get(key);
    const room: DiscoveredRoom = {
      key,
      hostName: beacon.hostName,
      roomId: beacon.roomId,
      roomName: beacon.roomName,
      status: beacon.status,
      playerCount: beacon.playerCount,
      maxPlayers: beacon.maxPlayers,
      modulesActive: beacon.modulesActive,
      address: sender.address,
      serverPort: beacon.serverPort,
      url: serverUrl({ host: sender.address, port: beacon.serverPort }),
      lastSeen: this.#now(),
    };
    this.#rooms.set(key, room);
    const changed =
      !previous ||
      previous.status !== room.status ||
      previous.playerCount !== room.playerCount ||
      previous.address !== room.address ||
      previous.roomName !== room.roomName ||
      previous.modulesActive.join() !== room.modulesActive.join();
    if (changed) this.#emit();
  }

  /** Usuwa wygasłe pokoje i powiadamia o zmianie listy (wywoływane przez zegar nasłuchu). */
  #prune(): void {
    const deadline = this.#deadline();
    let removed = false;
    for (const [key, room] of this.#rooms) {
      if (room.lastSeen < deadline) {
        this.#rooms.delete(key);
        removed = true;
      }
    }
    if (removed) this.#emit();
  }

  #emit(): void {
    const rooms = this.rooms();
    for (const listener of this.#listeners) listener(rooms);
  }
}

// ===========================================================================
// Łączenie ręczne (awaryjne): adres IP i port
// ===========================================================================

export interface ServerAddress {
  readonly host: string;
  readonly port: number;
}

const HOSTNAME = /^[a-zA-Z0-9.-]{1,253}$/;
/** Adres IPv6 bez identyfikatora strefy (`fe80::1%en0` nie mieści się w adresie ws://). */
const isIpv6Host = (host: string): boolean => isIPv6(host) && !host.includes('%');

/**
 * Odczytuje adres wpisany przez gracza: `192.168.1.20`, `192.168.1.20:7777`,
 * `gra.local:9000`, `[fe80::1]:7777` albo `fe80::1`. Zwraca `null` dla
 * niepoprawnego wpisu.
 */
export function parseServerAddress(input: string, defaultPort = DEFAULT_SERVER_PORT): ServerAddress | null {
  const text = input.trim().replace(/^wss?:\/\//, '').replace(/\/$/, '');
  let host: string;
  let portText: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1] ?? '';
    portText = bracketed[2];
    if (!isIpv6Host(host)) return null;
  } else if ((text.match(/:/g) ?? []).length > 1) {
    host = text; // IPv6 bez nawiasów i bez portu
    if (!isIpv6Host(host)) return null;
  } else {
    const [name, port, ...rest] = text.split(':');
    if (rest.length > 0 || name === undefined) return null;
    host = name;
    portText = port;
    if (!HOSTNAME.test(host)) return null;
  }
  const port = portText === undefined ? defaultPort : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || (portText !== undefined && !/^\d{1,5}$/.test(portText))) return null;
  return { host, port };
}

/** Adres WebSocket serwera gry (IPv6 w nawiasach). */
export function serverUrl(address: ServerAddress): string {
  const host = address.host.includes(':') ? `[${address.host}]` : address.host;
  return `ws://${host}:${address.port}`;
}

/** Łączy z serwerem po adresie wpisanym ręcznie. Błędy mają komunikaty dla gracza. */
export async function connectManually(input: string, codec: MessageCodec = JSON_CODEC, timeoutMs = 5_000): Promise<ClientChannel> {
  const address = parseServerAddress(input);
  if (!address) throw new Error(`Niepoprawny adres serwera: „${input}”. Przykład: 192.168.1.20:${DEFAULT_SERVER_PORT}`);
  return connectWebSocket(serverUrl(address), codec, timeoutMs);
}
