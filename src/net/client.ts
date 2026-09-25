/**
 * @file Klient gry: replika stanu i żądania jako obietnice.
 *
 * Klient NIE zawiera logiki gry. Wysyła intencje, a stan przyjmuje od
 * serwera: pełny (FULL) albo łatkę (PATCH) względem swojej rewizji. Gdy
 * łatka nie pasuje do lokalnej rewizji (np. zgubiona wiadomość po
 * ponownym połączeniu), sam prosi o pełną synchronizację.
 *
 * Każde żądanie zwraca obietnicę:
 *  - rozstrzygniętą, gdy przyjdzie GAME_STATE_SYNC z `cause.requestId` tego żądania
 *    (albo ROOM_STATE z `inReplyTo` dla JOIN_ROOM),
 *  - odrzuconą błędem `ActionRejectedError`, gdy serwer odrzuci komendę,
 *  - odrzuconą po przekroczeniu czasu albo zamknięciu połączenia.
 *
 * Po zerwaniu połączenia `reconnect(nowyKanał)` wraca na to samo miejsce
 * z żetonem i dostaje pełną migawkę stanu. Subskrypcje zdarzeń zostają,
 * więc interfejs nie musi się podłączać od nowa (zob. też `autoReconnect`).
 */

import type { PlayerColor, PlayerId } from '../model/index.ts';
import { applyPatch } from './diff.ts';
import type { PublicGameState } from './projection.ts';
import {
  PROTOCOL_VERSION,
  type ActionIntent,
  type ActionRejected,
  type BattleEventMessage,
  type BidChoice,
  type BiddingEventMessage,
  type ClientMessage,
  type GameOver,
  type GameStateSync,
  type LobbyIntent,
  type RoomState,
  type ServerMessage,
  type TurnUpdate,
} from './protocol.ts';
import type { ClientChannel, CloseInfo } from './transport.ts';

export class ActionRejectedError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(rejection: ActionRejected) {
    super(rejection.message);
    this.name = 'ActionRejectedError';
    this.code = rejection.code;
    this.details = rejection.details;
    this.requestId = rejection.requestId;
  }
}

export interface GameClientEvents {
  room: (message: RoomState) => void;
  state: (state: PublicGameState, sync: GameStateSync) => void;
  rejected: (message: ActionRejected) => void;
  battle: (message: BattleEventMessage) => void;
  bidding: (message: BiddingEventMessage) => void;
  /** Nowa decyzja, na którą czeka gra (np. „zostałeś przebity, wybierz innego boga”). */
  turn: (message: TurnUpdate) => void;
  gameOver: (message: GameOver) => void;
  disconnected: (info: CloseInfo) => void;
}

type EventName = keyof GameClientEvents;

interface Pending {
  /** Czym serwer potwierdza żądanie: ROOM_STATE (`inReplyTo`) albo GAME_STATE_SYNC (`cause`). */
  readonly kind: 'ROOM' | 'SYNC';
  readonly resolve: (value: never) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'v' | 'requestId'> : never;

export interface GameClientOptions {
  /** Czas oczekiwania na odpowiedź serwera (domyślnie 10 s). */
  readonly timeoutMs?: number;
}

export class GameClient {
  #channel: ClientChannel;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners: { [K in EventName]: Set<GameClientEvents[K]> } = {
    room: new Set(),
    state: new Set(),
    rejected: new Set(),
    battle: new Set(),
    bidding: new Set(),
    turn: new Set(),
    gameOver: new Set(),
    disconnected: new Set(),
  };
  #state: PublicGameState | null = null;
  #revision = -1;
  #room: RoomState | null = null;
  #turn: TurnUpdate | null = null;
  #playerName: string | null = null;
  #nextRequest = 1;
  #closed = false;

  constructor(channel: ClientChannel, options: GameClientOptions = {}) {
    this.#channel = channel;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#attach(channel);
  }

  /** Lokalna replika stanu (projekcja serwera dla tego gracza). */
  get state(): PublicGameState | null {
    return this.#state;
  }

  get revision(): number {
    return this.#revision;
  }

  get room(): RoomState | null {
    return this.#room;
  }

  get playerId(): PlayerId | null {
    return this.#room?.you ?? null;
  }

  /** Ostatni zegar tury od serwera: na kogo czeka gra, dlaczego i do kiedy. */
  get turn(): TurnUpdate | null {
    return this.#turn;
  }

  /** Czy gra czeka teraz na ruch tego gracza. */
  get isMyTurn(): boolean {
    const me = this.playerId;
    return me !== null && (this.#turn?.actors.includes(me) ?? false);
  }

  /** Subskrypcja zdarzenia. Zwraca funkcję, która ją anuluje. */
  on<K extends EventName>(event: K, listener: GameClientEvents[K]): () => void {
    this.#listeners[event].add(listener);
    return () => this.#listeners[event].delete(listener);
  }

  joinRoom(roomId: string, playerName: string, seatToken?: string): Promise<RoomState> {
    this.#playerName = playerName;
    return this.#request<RoomState>('ROOM', {
      type: 'JOIN_ROOM',
      roomId,
      playerName,
      ...(seatToken === undefined ? {} : { seatToken }),
    });
  }

  // ---- Lobby (odpowiedź: ROOM_STATE) --------------------------------------

  lobby(action: LobbyIntent): Promise<RoomState> {
    return this.#request<RoomState>('ROOM', { type: 'LOBBY_ACTION', action });
  }

  setColor(color: PlayerColor): Promise<RoomState> {
    return this.lobby({ type: 'SET_COLOR', color });
  }

  /** Miasto startowe (`null`: przydział automatyczny przy starcie). */
  setCity(city: string | null): Promise<RoomState> {
    return this.lobby({ type: 'SET_CITY', city });
  }

  setReady(ready: boolean): Promise<RoomState> {
    return this.lobby({ type: 'SET_READY', ready });
  }

  /** Host: aktywne dodatki. */
  setExpansions(expansions: { readonly hades: boolean; readonly monuments: boolean }): Promise<RoomState> {
    return this.lobby({ type: 'SET_EXPANSIONS', hades: expansions.hades, monuments: expansions.monuments });
  }

  /** Host: bot AI na wolnym slocie. */
  addBot(slot: number): Promise<RoomState> {
    return this.lobby({ type: 'ADD_BOT', slot });
  }

  removeBot(slot: number): Promise<RoomState> {
    return this.lobby({ type: 'REMOVE_BOT', slot });
  }

  /** Host: start partii. Po odpowiedzi przychodzi pełny stan gry. */
  startGame(): Promise<RoomState> {
    return this.lobby({ type: 'START_GAME' });
  }

  // ---- Gra (odpowiedź: GAME_STATE_SYNC) -------------------------------------

  submitBid(bid: BidChoice): Promise<GameStateSync> {
    return this.#request('SYNC', { type: 'SUBMIT_BID', bid });
  }

  executeAction(action: ActionIntent): Promise<GameStateSync> {
    return this.#request('SYNC', { type: 'EXECUTE_ACTION', action });
  }

  endTurn(): Promise<GameStateSync> {
    return this.#request('SYNC', { type: 'END_TURN' });
  }

  /** Prośba o rzut kośćmi w bitwie. Rzut wykonuje serwer. */
  rerollDice(): Promise<GameStateSync> {
    return this.#request('SYNC', { type: 'REROLL_DICE' });
  }

  requestSync(): Promise<GameStateSync> {
    return this.#request('SYNC', { type: 'REQUEST_SYNC' });
  }

  /**
   * Powrót do partii po zerwaniu połączenia: nowy kanał i JOIN_ROOM z żetonem
   * miejsca. Serwer odpowiada ROOM_STATE, pełną migawką stanu (FULL)
   * i bieżącym zegarem tury. Po upływie okna powrotu: `RECONNECT_EXPIRED`.
   */
  reconnect(channel: ClientChannel): Promise<RoomState> {
    const room = this.#room;
    if (!room?.seatToken) return Promise.reject(new Error('Brak żetonu miejsca: nie ma partii, do której można wrócić'));
    this.#attach(channel);
    return this.joinRoom(room.roomId, this.#playerName ?? 'Gracz', room.seatToken);
  }

  close(): void {
    this.#channel.close(1000, 'klient kończy pracę');
  }

  /** Podpina kanał. Wiadomości ze starego kanału (po `reconnect`) są pomijane. */
  #attach(channel: ClientChannel): void {
    const previous = this.#channel;
    this.#channel = channel;
    this.#closed = false;
    channel.onMessage((message) => {
      if (this.#channel === channel) this.#onMessage(message);
    });
    channel.onClose((info) => {
      if (this.#channel === channel) this.#onClose(info);
    });
    if (previous !== channel) previous.close(1000, 'klient połączył się ponownie');
  }

  // =========================================================================

  #request<T>(kind: Pending['kind'], body: WithoutEnvelope<ClientMessage>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Połączenie jest zamknięte'));
    const requestId = `c${this.#nextRequest++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Brak odpowiedzi serwera na ${body.type} w ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);
      this.#pending.set(requestId, { kind, resolve: resolve as (value: never) => void, reject, timer });
      this.#channel.send({ v: PROTOCOL_VERSION, requestId, ...body } as ClientMessage);
    });
  }

  #settle(requestId: string | null, outcome: { ok: true; value: unknown } | { ok: false; error: Error }): void {
    if (requestId === null) return;
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    if (outcome.ok) (pending.resolve as (value: unknown) => void)(outcome.value);
    else pending.reject(outcome.error);
  }

  #onMessage(raw: unknown): void {
    if (raw === null || typeof raw !== 'object' || (raw as { v?: unknown }).v !== PROTOCOL_VERSION) return;
    const message = raw as ServerMessage;
    switch (message.type) {
      case 'ROOM_STATE':
        this.#room = message;
        this.#emit('room', message);
        this.#settle(message.inReplyTo, { ok: true, value: message });
        return;
      case 'GAME_STATE_SYNC':
        this.#applySync(message);
        return;
      case 'ACTION_REJECTED':
        this.#emit('rejected', message);
        this.#settle(message.requestId, { ok: false, error: new ActionRejectedError(message) });
        return;
      case 'BATTLE_EVENT':
        this.#emit('battle', message);
        return;
      case 'BIDDING_EVENT':
        this.#emit('bidding', message);
        return;
      case 'TURN_UPDATE':
        this.#turn = message;
        this.#emit('turn', message);
        return;
      case 'GAME_OVER':
        this.#emit('gameOver', message);
        return;
    }
  }

  #applySync(sync: GameStateSync): void {
    if (sync.mode === 'FULL') {
      this.#state = sync.state;
      this.#revision = sync.revision;
    } else if (this.#state !== null && sync.baseRevision === this.#revision) {
      this.#state = applyPatch(this.#state, sync.ops);
      this.#revision = sync.revision;
    } else {
      // Łatka nie pasuje do lokalnej repliki: prosimy o pełny stan (sama komenda została przyjęta).
      this.requestSync().catch(() => undefined);
    }
    if (this.#state !== null) this.#emit('state', this.#state, sync);
    if (sync.cause && sync.cause.playerId === this.playerId) this.#settle(sync.cause.requestId, { ok: true, value: sync });
  }

  #onClose(info: CloseInfo): void {
    this.#closed = true;
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Połączenie zamknięte (${info.code}) przed odpowiedzią na ${requestId}`));
    }
    this.#pending.clear();
    this.#emit('disconnected', info);
  }

  #emit<K extends EventName>(event: K, ...args: Parameters<GameClientEvents[K]>): void {
    for (const listener of this.#listeners[event]) (listener as (...values: unknown[]) => void)(...args);
  }
}
