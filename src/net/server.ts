/**
 * @file Serwer gry: jeden interfejs dla trybu Single Player i LAN.
 *
 *   SINGLE_PLAYER: [UI] ─ GameClient ─ Loopback ─┐
 *                                                 ├─ GameServer ─ Room ─ silnik zasad
 *   LAN:           [UI] ─ GameClient ─ Loopback ─┤   (gospodarz gra w tym samym procesie)
 *        [UI w sieci] ─ GameClient ─ WebSocket ───┘
 *
 * Serwer zajmuje się sesjami, walidacją wiadomości i przekazaniem ich do
 * pokoju. Całą logikę gry wykonuje silnik po stronie serwera. W trybie LAN
 * dochodzi tylko nasłuch WebSocket: protokół, pokoje i silnik są identyczne.
 */

import type { GameState } from '../model/index.ts';
import { JSON_CODEC, type MessageCodec } from './codec.ts';
import { DISCOVERY_PORT, DiscoveryBeacon, activeModules, defaultHostName } from './discovery.ts';
import { PROTOCOL_VERSION, type ClientMessage, type RoomStatus } from './protocol.ts';
import { Room, type RoomConfig, type RoomSummary, type Session } from './room.ts';
import { createLoopbackPair, withCodec, type ClientChannel, type ServerChannel } from './transport.ts';
import { DEFAULT_TURN_TIMEOUTS } from './turnClock.ts';
import { parseClientMessage } from './validate.ts';
import { WebSocketListener } from './websocket.ts';

export type ServerMode = 'SINGLE_PLAYER' | 'LAN';

export interface ServerInfo {
  readonly mode: ServerMode;
  /** Adres dla graczy w sieci lokalnej (`null` w trybie Single Player). */
  readonly url: string | null;
  /** Port UDP ogłoszeń LAN (`null`, gdy ogłoszenia są wyłączone). */
  readonly discoveryPort: number | null;
}

export interface IGameServer {
  readonly mode: ServerMode;
  /** Zakłada pokój z miejscami dla ludzi i AI. */
  createRoom(config: RoomConfig): void;
  /** Połączenie w tym samym procesie: gracz Single Player, hotseat albo gospodarz LAN. */
  connectLocal(codec?: MessageCodec): ClientChannel;
  /** Przyjmuje połączenie z dowolnego transportu (np. własnego, innego niż Loopback i WebSocket). */
  accept(channel: ServerChannel): void;
  /** Streszczenia pokoi (lista w menu, ogłoszenia LAN). */
  listRooms(): RoomSummary[];
  /** W trybie LAN otwiera gniazdo sieciowe, a w trybie Single Player nic nie otwiera. */
  start(): Promise<ServerInfo>;
  stop(): Promise<void>;
}

export interface GameServerOptions {
  readonly mode: ServerMode;
  readonly lan?: {
    /** Interfejs nasłuchu (domyślnie `0.0.0.0`, czyli cała sieć lokalna). */
    readonly host?: string;
    /** Port (domyślnie 7777, 0 = wybierz wolny). */
    readonly port?: number;
    readonly maxPayload?: number;
    /** Co ile ms serwer wysyła ping do klientów WebSocket (domyślnie 10 s, 0 wyłącza). */
    readonly heartbeatIntervalMs?: number;
    /** Po ilu ms ciszy połączenie uznaje się za zerwane (domyślnie 25 s): zaczyna się okno powrotu gracza. */
    readonly heartbeatTimeoutMs?: number;
    /** Ogłoszenia UDP w sieci lokalnej (domyślnie włączone na porcie 45454, `false` wyłącza). */
    readonly discovery?:
      | false
      | {
          readonly port?: number;
          readonly intervalMs?: number;
          /** Adresy docelowe (domyślnie adresy rozgłoszeniowe interfejsów). */
          readonly targets?: readonly string[];
          /** Nazwa hosta w ogłoszeniu (domyślnie nazwa gracza-hosta albo komputera). */
          readonly hostName?: string;
        };
  };
  /** Dziennik błędów wewnętrznych (domyślnie `console.error`). */
  readonly log?: (message: string, error: unknown) => void;
}

export class GameServer implements IGameServer {
  readonly mode: ServerMode;
  readonly #options: GameServerOptions;
  readonly #rooms = new Map<string, Room>();
  readonly #sessions = new Set<Session>();
  #listener: WebSocketListener | null = null;
  #beacon: DiscoveryBeacon | null = null;
  #nextSessionId = 1;

  constructor(options: GameServerOptions) {
    this.mode = options.mode;
    this.#options = options;
  }

  createRoom(config: RoomConfig): void {
    if (this.#rooms.has(config.roomId)) throw new Error(`Pokój ${config.roomId} już istnieje`);
    // W LAN gracz może zniknąć albo przestać grać, więc tury mają domyślnie limit czasu.
    const defaults: Partial<RoomConfig> = {
      ...(this.#options.log ? { log: this.#options.log } : {}),
      ...(this.mode === 'LAN' ? { turnTimeouts: DEFAULT_TURN_TIMEOUTS } : {}),
    };
    // Każda zmiana w lobby (dołączenie, bot, start) od razu trafia do ogłoszeń LAN.
    this.#rooms.set(config.roomId, new Room({ ...defaults, ...config }, () => this.#beacon?.announceNow()));
  }

  connectLocal(codec: MessageCodec = JSON_CODEC): ClientChannel {
    const { client, server } = createLoopbackPair(codec);
    this.accept(server);
    return client;
  }

  listRooms(): RoomSummary[] {
    return [...this.#rooms.values()].map((room) => room.summary());
  }

  async start(): Promise<ServerInfo> {
    if (this.mode === 'SINGLE_PLAYER') return { mode: this.mode, url: null, discoveryPort: null };
    if (this.#listener) throw new Error('Serwer LAN już działa');
    const lan = this.#options.lan ?? {};
    this.#listener = new WebSocketListener((raw, codec) => this.accept(withCodec(raw, codec)), {
      ...(lan.maxPayload === undefined ? {} : { maxPayload: lan.maxPayload }),
      ...(lan.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: lan.heartbeatIntervalMs }),
      ...(lan.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: lan.heartbeatTimeoutMs }),
    });
    const address = await this.#listener.listen(lan.port ?? 7777, lan.host ?? '0.0.0.0');
    const host = address.host.includes(':') ? `[${address.host}]` : address.host;

    let discoveryPort: number | null = null;
    if (lan.discovery !== false) {
      const discovery = lan.discovery ?? {};
      discoveryPort = discovery.port ?? DISCOVERY_PORT;
      this.#beacon = new DiscoveryBeacon({
        port: discoveryPort,
        serverPort: address.port,
        ...(discovery.intervalMs === undefined ? {} : { intervalMs: discovery.intervalMs }),
        ...(discovery.targets === undefined ? {} : { targets: discovery.targets }),
        rooms: () =>
          this.listRooms().map((room) => ({
            hostName: defaultHostName(discovery.hostName ?? room.hostName),
            roomId: room.roomId,
            roomName: room.roomName,
            status: room.status,
            playerCount: room.playerCount,
            maxPlayers: room.maxPlayers,
            modulesActive: activeModules(room.expansions),
          })),
      });
      try {
        await this.#beacon.start();
      } catch (error) {
        await this.stop();
        throw error;
      }
    }
    return { mode: this.mode, url: `ws://${host}:${address.port}`, discoveryPort };
  }

  async stop(): Promise<void> {
    // Najpierw pokoje: zamykane połączenia nie uruchomią już okien powrotu ani limitów tur.
    for (const room of this.#rooms.values()) room.close();
    await this.#beacon?.stop();
    this.#beacon = null;
    for (const session of this.#sessions) session.channel.close(1001, 'serwer kończy pracę');
    this.#sessions.clear();
    await this.#listener?.close();
    this.#listener = null;
  }

  /** Stan pokoju do inspekcji lokalnej (testy, panel gospodarza). Nie trafia do sieci. */
  inspectRoom(roomId: string): { readonly status: RoomStatus; readonly state: GameState | null } | null {
    const room = this.#rooms.get(roomId);
    return room ? { status: room.status, state: room.state } : null;
  }

  // =========================================================================
  // Sesje i wiadomości
  // =========================================================================

  accept(channel: ServerChannel): void {
    const session: Session = { id: this.#nextSessionId++, channel, room: null, playerId: null, lastSync: null };
    this.#sessions.add(session);
    channel.onMessage((raw) => this.#onMessage(session, raw));
    channel.onDecodeError((error) => this.#reject(session, null, 'MALFORMED', `Nie udało się odczytać wiadomości: ${error.message}`));
    channel.onClose(() => {
      this.#sessions.delete(session);
      session.room?.disconnect(session);
    });
  }

  #onMessage(session: Session, raw: unknown): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return this.#reject(session, parsed.requestId, 'MALFORMED', `Niepoprawna wiadomość: ${parsed.error}`);
    try {
      this.#dispatch(session, parsed.message);
    } catch (error) {
      // Stan pokoju się nie zmienił, bo silnik jest czysty i nowy stan zapisujemy dopiero po sukcesie.
      (this.#options.log ?? console.error)(`Błąd wewnętrzny przy ${parsed.message.type}`, error);
      this.#reject(session, parsed.message.requestId, 'INTERNAL_ERROR', 'Błąd wewnętrzny serwera. Stan gry nie został zmieniony.');
    }
  }

  #dispatch(session: Session, message: ClientMessage): void {
    if (message.type === 'JOIN_ROOM') {
      if (session.room) return this.#reject(session, message.requestId, 'ALREADY_JOINED', 'To połączenie jest już w pokoju.');
      const room = this.#rooms.get(message.roomId);
      if (!room) return this.#reject(session, message.requestId, 'UNKNOWN_ROOM', `Nie ma pokoju ${message.roomId}.`);
      return room.join(session, message);
    }
    const room = session.room;
    if (!room) return this.#reject(session, message.requestId, 'NOT_IN_ROOM', 'Najpierw dołącz do pokoju.');
    if (message.type === 'REQUEST_SYNC') return room.requestSync(session, message);
    if (message.type === 'LOBBY_ACTION') return room.handleLobby(session, message);
    room.handleIntent(session, message);
  }

  #reject(session: Session, requestId: string | null, code: string, message: string): void {
    session.channel.send({ v: PROTOCOL_VERSION, type: 'ACTION_REJECTED', requestId, code, message, details: null });
  }
}

/** Serwer w procesie gry: Single Player z AI albo hotseat (kilka lokalnych klientów). */
export function createSinglePlayerServer(options: Omit<GameServerOptions, 'mode' | 'lan'> = {}): GameServer {
  return new GameServer({ ...options, mode: 'SINGLE_PLAYER' });
}

/** Serwer LAN: gospodarz gra lokalnie, a pozostali gracze łączą się przez WebSocket. */
export function createLanServer(lan: NonNullable<GameServerOptions['lan']> = {}, options: Omit<GameServerOptions, 'mode' | 'lan'> = {}): GameServer {
  return new GameServer({ ...options, mode: 'LAN', lan });
}
