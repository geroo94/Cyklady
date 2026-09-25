/**
 * @file Pokój gry: lobby (sloty, kolory, miasta, dodatki, boty, gotowość)
 * oraz potok komend i rozsyłanie stanu w trakcie partii.
 *
 * Cykl życia pokoju:  WAITING (lobby) ──start──► IN_GAME ──zwycięstwo──► FINISHED
 *
 * Start partii:
 *  - `WHEN_FULL` (szybka gra, np. Single Player z AI): gdy wszystkie sloty są zajęte,
 *  - `HOST`: na polecenie hosta (START_GAME), gdy wszyscy goście są gotowi
 *    i graczy jest co najmniej `minPlayers`.
 *
 * Potok dla każdej intencji w grze (synchronicznie, w jednym obrocie pętli
 * zdarzeń, więc bez wyścigów między graczami):
 *
 *   intencja ─► applyIntent (silnik waliduje) ─┬─► odrzucenie: ACTION_REJECTED do nadawcy
 *                                              └─► nowy stan ─► fazy automatyczne ─► rozesłanie
 *                                                                  ▲                     │
 *                                                                  └── ruch AI ◄─────────┘ (dopóki gra czeka na AI)
 *                                                                                        │
 *                                            zegar tury (TURN_UPDATE, limit czasu) ◄─────┘
 *
 * W trakcie partii pokój pilnuje też czasu:
 *  - ZEGAR TURY: każda decyzja, na którą czeka gra, dostaje limit. Po jego
 *    upływie serwer sam wykonuje ruch pasywny (Apollo, koniec tury, rzut,
 *    walka dalej), więc nieobecny gracz nie blokuje stołu.
 *  - OKNO POWROTU: rozłączony gracz zachowuje miejsce przez `reconnectGraceMs`
 *    (domyślnie 60 s). Wraca z żetonem miejsca i dostaje pełną migawkę stanu.
 *    Po tym czasie miejsce przejmuje komputer, a żeton traci ważność.
 *  - LOSOWOŚĆ: partia dostaje generator ChaCha20 z tajnym kluczem pokoju
 *    (`createSecureRng`), więc rzutów i zakrytych talii nie da się przewidzieć.
 */

import { randomUUID } from 'node:crypto';

import { advanceAutomaticPhases, pendingActors, type BidEvent } from '../engine/index.ts';
import { PlayerColor, createSecureRng, type ExpansionFlags, type GameState, type PlayerId, type RngState } from '../model/index.ts';
import { SIMPLE_AI, fallbackIntent, type AiIntent, type AiPolicy } from './ai.ts';
import { applyIntent, type BattleFeed, type IntentMessage, type IntentResult } from './commands.ts';
import { diffJson } from './diff.ts';
import { DEFAULT_PROJECTION, projectState, type ProjectionOptions, type PublicGameState } from './projection.ts';
import {
  PROTOCOL_VERSION,
  type GameStateSync,
  type JoinRoom,
  type LobbyAction,
  type LobbySettings,
  type RequestSync,
  type RoomState,
  type RoomStatus,
  type SeatInfo,
  type SeatKind,
  type ServerMessage,
  type StartMode,
  type SyncCause,
  type TurnUpdate,
} from './protocol.ts';
import { SYSTEM_SCHEDULER, type Scheduler } from './scheduler.ts';
import type { ServerChannel } from './transport.ts';
import { DEFAULT_RECONNECT_GRACE_MS, describeTurn, passiveIntent, passiveMoveFor, type TurnInfo, type TurnTimeouts } from './turnClock.ts';

// ===========================================================================
// Konfiguracja
// ===========================================================================

export interface SeatConfig {
  readonly playerId: PlayerId;
  /** Kolor proponowany dla slotu (gracz może go zmienić w lobby). */
  readonly color: PlayerColor;
  /** `HUMAN`: slot otwarty (człowiek albo bot dodany przez hosta), `AI`: slot z botem od początku. */
  readonly kind: SeatKind;
  /** Nazwa bota. */
  readonly name?: string;
}

/** Wynik lobby przekazywany do utworzenia partii. */
export interface GameSetup {
  /** Publiczny identyfikator partii, niezwiązany z losowością. */
  readonly gameId: string;
  /**
   * Generator partii z tajnym kluczem. Fabryka powinna przekazać go do
   * `createGame({ rng })`, żeby także talie na starcie były tasowane
   * bezpiecznie. Losowania w trakcie gry i tak należą do tego generatora.
   */
  readonly rng: RngState;
  readonly expansions: ExpansionFlags;
  /** Zajęte sloty w kolejności przy stole. */
  readonly players: readonly {
    readonly playerId: PlayerId;
    readonly name: string;
    readonly color: PlayerColor;
    readonly city: string | null;
    readonly kind: SeatKind;
  }[];
}

/** Kto może zostać hostem. `LOCAL_ONLY`: tylko gracz w procesie serwera (gospodarz LAN). */
export type HostPolicy = 'FIRST_HUMAN' | 'LOCAL_ONLY';

export interface RoomConfig {
  readonly roomId: string;
  /** Nazwa pokoju w lobby i w ogłoszeniach LAN (domyślnie `roomId`). */
  readonly roomName?: string;
  /** Sloty w kolejności przy stole. Ich liczba to największa liczba graczy. */
  readonly seats: readonly SeatConfig[];
  /** Tworzy partię. `names` to nazwy graczy w kolejności zajętych slotów, a `setup` to pełny wynik lobby. */
  readonly createGame: (names: readonly string[], setup: GameSetup) => GameState;
  readonly startMode?: StartMode;
  /** Najmniej graczy do startu (domyślnie wszystkie sloty). */
  readonly minPlayers?: number;
  /** Miasta startowe do wyboru w lobby. */
  readonly cities?: readonly string[];
  /** Dodatki włączone na początku (domyślnie wszystkie dostępne). */
  readonly expansions?: ExpansionFlags;
  /** Dodatki, które host może włączyć (domyślnie oba). */
  readonly availableExpansions?: ExpansionFlags;
  readonly hostPolicy?: HostPolicy;
  readonly projection?: ProjectionOptions;
  /** Rzuty kośćmi bitewnymi bez czekania na REROLL_DICE (np. szybka gra z AI). */
  readonly autoRollBattles?: boolean;
  readonly ai?: AiPolicy;
  /** Bezpiecznik: najwięcej ruchów AI po jednej komendzie człowieka. */
  readonly maxAiSteps?: number;
  /**
   * Limity czasu na ruch. Po upływie serwer wykonuje ruch pasywny.
   * `false` (domyślnie w pokoju; serwer LAN włącza `DEFAULT_TURN_TIMEOUTS`): bez limitów.
   */
  readonly turnTimeouts?: TurnTimeouts | false;
  /** Ile ms miejsce rozłączonego gracza czeka na jego powrót (domyślnie 60 s). `null`: bez limitu. */
  readonly reconnectGraceMs?: number | null;
  /** Zegar i planista zadań (w testach `ManualScheduler`). */
  readonly scheduler?: Scheduler;
  /** Generator losowości partii (domyślnie `createSecureRng`: ChaCha20 z kluczem z CSPRNG systemu). */
  readonly createRng?: () => RngState;
  /** Dziennik błędów wewnętrznych (np. odrzuconego ruchu pasywnego). */
  readonly log?: (message: string, error: unknown) => void;
}

/** Jedno połączenie klienta. */
export interface Session {
  readonly id: number;
  readonly channel: ServerChannel;
  room: Room | null;
  playerId: PlayerId | null;
  /** Ostatnio wysłany widok: baza dla następnej łatki. */
  lastSync: { readonly revision: number; readonly view: PublicGameState } | null;
}

/** Streszczenie pokoju (lista pokoi, ogłoszenia LAN). */
export interface RoomSummary {
  readonly roomId: string;
  readonly roomName: string;
  readonly status: RoomStatus;
  readonly hostName: string | null;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly expansions: ExpansionFlags;
}

// ===========================================================================
// Stan slotów
// ===========================================================================

interface HumanOccupant {
  readonly kind: 'HUMAN';
  readonly name: string;
  readonly token: string;
  readonly joinedAt: number;
  session: Session | null;
  ready: boolean;
  /** Rozłączony w trakcie partii: do tej chwili może wrócić z żetonem. */
  reconnectDeadline: number | null;
  /** Anuluje przejęcie miejsca przez komputer (powrót gracza). */
  cancelGrace: (() => void) | null;
}

interface BotOccupant {
  readonly kind: 'AI';
  readonly name: string;
}

interface Slot {
  readonly index: number;
  readonly config: SeatConfig;
  occupant: HumanOccupant | BotOccupant | null;
  color: PlayerColor | null;
  city: string | null;
}

/** Powyżej tego rozmiaru łatka jest opłacalna tylko wtedy, gdy jest wyraźnie mniejsza od pełnego stanu. */
const PATCH_BYTES_WORTH_CHECKING = 4_096;
const ALL_COLORS: readonly PlayerColor[] = Object.values(PlayerColor);
const ALL_EXPANSIONS: ExpansionFlags = { hades: true, monuments: true };
/** Granice protokołu: identyfikatory w wiadomościach i ogłoszeniach LAN do 64 znaków, sloty 0–15. */
const MAX_ROOM_TEXT = 64;
const MAX_SEATS = 16;

/** Zdarzenia do rozesłania razem ze zmianą stanu. */
interface Feed {
  readonly battles: readonly BattleFeed[];
  readonly bidding: readonly BidEvent[];
}

const NO_FEED: Feed = { battles: [], bidding: [] };
const feedOf = (result: Extract<IntentResult, { ok: true }>): Feed => ({
  battles: result.battle ? [result.battle] : [],
  bidding: result.bidding,
});

/** Bieżąca tura i jej licznik czasu. */
interface TurnClock {
  readonly info: TurnInfo;
  /** Termin ruchu pasywnego (`null`: pokój bez limitów czasu). */
  readonly deadline: number | null;
  readonly cancel: (() => void) | null;
}

export class Room {
  readonly id: string;
  readonly #config: RoomConfig;
  readonly #slots: Slot[];
  readonly #projection: ProjectionOptions;
  readonly #onChange: () => void;
  #status: RoomStatus = 'WAITING';
  #state: GameState | null = null;
  #expansions: ExpansionFlags;
  #joinCounter = 0;
  readonly #scheduler: Scheduler;
  #turn: TurnClock | null = null;
  /** Czas, który został z tury boga przerwanej bitwą (licznik rusza dalej po bitwie). */
  #pausedGodTurn: { readonly turnId: string; readonly remainingMs: number } | null = null;
  /** Żetony miejsc przejętych przez komputer po upływie okna powrotu. */
  readonly #expiredTokens = new Set<string>();
  /** Pokój zamknięty razem z serwerem: liczniki nie ruszają. */
  #closed = false;

  /** `onChange` sygnalizuje zmianę streszczenia pokoju (np. dla ogłoszeń LAN). */
  constructor(config: RoomConfig, onChange: () => void = () => undefined) {
    if (!config.seats.some((seat) => seat.kind === 'HUMAN')) {
      throw new Error('Pokój potrzebuje co najmniej jednego slotu dla człowieka');
    }
    const roomName = config.roomName ?? config.roomId;
    if (config.roomId.length === 0 || config.roomId.length > MAX_ROOM_TEXT || roomName.length === 0 || roomName.length > MAX_ROOM_TEXT) {
      throw new Error(`Identyfikator i nazwa pokoju muszą mieć od 1 do ${MAX_ROOM_TEXT} znaków`);
    }
    if (config.seats.length > MAX_SEATS) throw new Error(`Pokój może mieć najwyżej ${MAX_SEATS} slotów`);
    if (new Set(config.seats.map((seat) => seat.playerId)).size !== config.seats.length) {
      throw new Error('Identyfikatory graczy w pokoju muszą być unikalne');
    }
    const min = config.minPlayers ?? config.seats.length;
    if (min < 1 || min > config.seats.length) throw new Error('minPlayers musi mieścić się w liczbie slotów');
    this.id = config.roomId;
    this.#config = config;
    this.#projection = config.projection ?? DEFAULT_PROJECTION;
    this.#scheduler = config.scheduler ?? SYSTEM_SCHEDULER;
    this.#onChange = onChange;
    const available = config.availableExpansions ?? ALL_EXPANSIONS;
    const initial = config.expansions ?? available;
    // Niedostępny dodatek nie może być włączony, także w konfiguracji początkowej.
    this.#expansions = { hades: initial.hades && available.hades, monuments: initial.monuments && available.monuments };
    this.#slots = config.seats.map((seat, index) => ({ index, config: seat, occupant: null, color: null, city: null }));
    for (const slot of this.#slots) {
      if (slot.config.kind === 'AI') this.#seatBot(slot, slot.config.name);
    }
  }

  get status(): RoomStatus {
    return this.#status;
  }

  /** Pełny stan serwera: tylko do inspekcji lokalnej (testy, panel gospodarza), nigdy do sieci. */
  get state(): GameState | null {
    return this.#state;
  }

  summary(): RoomSummary {
    const host = this.#hostSlot();
    return {
      roomId: this.id,
      roomName: this.#config.roomName ?? this.id,
      status: this.#status,
      hostName: host?.occupant?.name ?? null,
      playerCount: this.#slots.filter((slot) => slot.occupant !== null).length,
      maxPlayers: this.#slots.length,
      expansions: this.#expansions,
    };
  }

  // =========================================================================
  // Dołączanie i rozłączanie
  // =========================================================================

  join(session: Session, message: JoinRoom): void {
    let slot: Slot | undefined;
    if (message.seatToken !== undefined) {
      if (this.#expiredTokens.has(message.seatToken)) {
        return this.#reject(session, message.requestId, 'RECONNECT_EXPIRED', 'Minął czas na powrót do partii. Miejsce przejął komputer.');
      }
      slot = this.#slots.find((candidate) => candidate.occupant?.kind === 'HUMAN' && candidate.occupant.token === message.seatToken);
      const human = slot?.occupant;
      if (!slot || human?.kind !== 'HUMAN') return this.#reject(session, message.requestId, 'INVALID_SEAT_TOKEN', 'Nieznany żeton miejsca.');
      human.cancelGrace?.();
      human.cancelGrace = null;
      human.reconnectDeadline = null;
      const previous = human.session;
      if (previous && previous !== session) {
        previous.room = null;
        previous.playerId = null;
        previous.lastSync = null;
        previous.channel.close(4000, 'miejsce przejęte przez nowe połączenie');
      }
      human.session = session;
    } else {
      if (this.#status !== 'WAITING') {
        return this.#reject(session, message.requestId, 'ROOM_FULL', 'Partia już trwa: wrócić można tylko z żetonem miejsca.');
      }
      slot = this.#slots.find((candidate) => candidate.config.kind === 'HUMAN' && candidate.occupant === null);
      if (!slot) return this.#reject(session, message.requestId, 'ROOM_FULL', 'Wszystkie miejsca są zajęte.');
      slot.occupant = {
        kind: 'HUMAN',
        name: message.playerName,
        token: randomUUID(),
        joinedAt: this.#joinCounter++,
        session,
        ready: false,
        reconnectDeadline: null,
        cancelGrace: null,
      };
      slot.color = this.#freeColor(slot.config.color);
    }

    session.room = this;
    session.playerId = slot.config.playerId;
    session.lastSync = null;

    const starting = this.#status === 'WAITING' && this.#startMode() === 'WHEN_FULL' && this.#slots.every((s) => s.occupant !== null);
    if (starting) this.#beginGame();
    this.#send(session, this.#roomState(session, message.requestId));
    this.#broadcastRoomState(session);
    this.#onChange();
    if (starting) this.#settle({ playerId: null, requestId: null, intent: 'GAME_START' }, NO_FEED);
    else if (this.#state) {
      // Powrót do trwającej partii: pełna migawka stanu i bieżący zegar tury.
      this.#sendSync(session, { playerId: session.playerId, requestId: message.requestId, intent: 'JOIN_ROOM' }, true);
      const turn = this.#turnUpdate();
      if (turn) this.#send(session, turn);
    }
  }

  /**
   * Połączenie zniknęło. Przed startem slot zostaje zwolniony (host przechodzi
   * na kolejnego gracza), a w trakcie partii miejsce czeka na powrót z żetonem
   * przez `reconnectGraceMs`. Stan gry cały czas żyje na serwerze, a tury
   * nieobecnego gracza rozstrzyga w tym czasie zegar tury.
   */
  disconnect(session: Session): void {
    const slot = this.#slots.find((candidate) => candidate.occupant?.kind === 'HUMAN' && candidate.occupant.session === session);
    if (!slot || slot.occupant?.kind !== 'HUMAN') return;
    if (this.#status === 'WAITING') {
      slot.occupant = null;
      slot.color = null;
      slot.city = null;
    } else {
      slot.occupant.session = null;
      if (this.#status === 'IN_GAME') this.#startGrace(slot, slot.occupant);
    }
    session.room = null;
    session.playerId = null;
    this.#broadcastRoomState(null);
    this.#onChange();
  }

  // =========================================================================
  // Lobby
  // =========================================================================

  handleLobby(session: Session, message: LobbyAction): void {
    const { requestId, action } = message;
    const slot = this.#slotOf(session);
    if (!slot || slot.occupant?.kind !== 'HUMAN') return this.#reject(session, requestId, 'NOT_IN_ROOM', 'Najpierw dołącz do pokoju.');
    if (this.#status !== 'WAITING') return this.#reject(session, requestId, 'GAME_ALREADY_STARTED', 'Partia już się zaczęła.');
    const me = slot.occupant;
    const isHost = this.#hostSlot() === slot;
    const hostOnly = (): boolean => {
      if (isHost) return true;
      this.#reject(session, requestId, 'NOT_HOST', 'To może zrobić tylko host pokoju.');
      return false;
    };

    switch (action.type) {
      case 'SET_COLOR': {
        const taken = this.#slots.some((other) => other !== slot && other.occupant !== null && other.color === action.color);
        if (taken) return this.#reject(session, requestId, 'COLOR_TAKEN', `Kolor ${action.color} jest już zajęty.`);
        slot.color = action.color;
        me.ready = false;
        break;
      }
      case 'SET_CITY': {
        if (action.city !== null) {
          if (!this.#cities().includes(action.city)) return this.#reject(session, requestId, 'UNKNOWN_CITY', `Nie ma miasta startowego ${action.city}.`);
          const taken = this.#slots.some((other) => other !== slot && other.occupant !== null && other.city === action.city);
          if (taken) return this.#reject(session, requestId, 'CITY_TAKEN', `Miasto ${action.city} wybrał już inny gracz.`);
        }
        slot.city = action.city;
        me.ready = false;
        break;
      }
      case 'SET_READY':
        me.ready = action.ready;
        break;
      case 'SET_EXPANSIONS': {
        if (!hostOnly()) return;
        const available = this.#config.availableExpansions ?? ALL_EXPANSIONS;
        if ((action.hades && !available.hades) || (action.monuments && !available.monuments)) {
          return this.#reject(session, requestId, 'EXPANSION_UNAVAILABLE', 'Ten dodatek nie jest dostępny na tym serwerze.');
        }
        this.#expansions = { hades: action.hades, monuments: action.monuments };
        this.#clearReady();
        break;
      }
      case 'ADD_BOT': {
        if (!hostOnly()) return;
        const target = this.#slots[action.slot];
        if (!target) return this.#reject(session, requestId, 'INVALID_SLOT', `Nie ma slotu ${action.slot}.`);
        if (target.occupant !== null) return this.#reject(session, requestId, 'SLOT_OCCUPIED', `Slot ${action.slot} jest zajęty.`);
        this.#seatBot(target);
        this.#clearReady();
        break;
      }
      case 'REMOVE_BOT': {
        if (!hostOnly()) return;
        const target = this.#slots[action.slot];
        if (!target) return this.#reject(session, requestId, 'INVALID_SLOT', `Nie ma slotu ${action.slot}.`);
        if (target.occupant?.kind !== 'AI') return this.#reject(session, requestId, 'NOT_A_BOT', `W slocie ${action.slot} nie ma bota.`);
        target.occupant = null;
        target.color = null;
        target.city = null;
        this.#clearReady();
        break;
      }
      case 'START_GAME': {
        if (!hostOnly()) return;
        const players = this.#slots.filter((candidate) => candidate.occupant !== null).length;
        const min = this.#config.minPlayers ?? this.#slots.length;
        if (players < min) {
          return this.#reject(session, requestId, 'NOT_ENOUGH_PLAYERS', `Do startu potrzeba co najmniej ${min} graczy (jest ${players}). Dodaj boty.`);
        }
        const waiting = this.#slots.filter(
          (candidate) => candidate !== slot && candidate.occupant?.kind === 'HUMAN' && !candidate.occupant.ready,
        );
        if (waiting.length > 0) {
          const names = waiting.map((candidate) => candidate.occupant?.name).join(', ');
          return this.#reject(session, requestId, 'NOT_ALL_READY', `Nie wszyscy są gotowi: ${names}.`);
        }
        this.#beginGame();
        this.#send(session, this.#roomState(session, requestId));
        this.#broadcastRoomState(session);
        this.#onChange();
        this.#settle({ playerId: slot.config.playerId, requestId, intent: 'START_GAME' }, NO_FEED);
        return;
      }
    }

    // Tryb WHEN_FULL: bot na ostatnim wolnym slocie może rozpocząć partię.
    const starting = this.#startMode() === 'WHEN_FULL' && this.#slots.every((candidate) => candidate.occupant !== null);
    if (starting) this.#beginGame();
    this.#send(session, this.#roomState(session, requestId));
    this.#broadcastRoomState(session);
    this.#onChange();
    if (starting) this.#settle({ playerId: slot.config.playerId, requestId, intent: 'GAME_START' }, NO_FEED);
  }

  /** Tworzy partię z wyniku lobby: kolory, miasta (wolne przydzielane automatycznie) i dodatki. */
  #beginGame(): void {
    const occupied = this.#slots.filter((slot) => slot.occupant !== null);
    const free = this.#cities().filter((city) => !occupied.some((slot) => slot.city === city));
    for (const slot of occupied) {
      if (slot.city === null && free.length > 0) slot.city = free.shift() ?? null;
      if (slot.color === null) slot.color = this.#freeColor(slot.config.color);
    }
    const rng = (this.#config.createRng ?? createSecureRng)();
    const setup: GameSetup = {
      gameId: randomUUID(),
      rng,
      expansions: this.#expansions,
      players: occupied.map((slot) => ({
        playerId: slot.config.playerId,
        name: slot.occupant?.name ?? '',
        color: slot.color ?? slot.config.color,
        city: slot.city,
        kind: slot.occupant?.kind === 'AI' ? 'AI' : 'HUMAN',
      })),
    };
    const created = this.#config.createGame(
      setup.players.map((player) => player.name),
      setup,
    );
    // Losowanie w trakcie partii zawsze należy do generatora pokoju, także gdy
    // fabryka partii (np. testowa) potasowała talie własnym, jawnym ziarnem.
    const usesRoomRng = created.rng.algorithm === 'chacha20' && rng.algorithm === 'chacha20' && created.rng.key === rng.key;
    this.#state = usesRoomRng ? created : { ...created, rng };
    this.#status = 'IN_GAME';
  }

  // =========================================================================
  // Komendy w grze
  // =========================================================================

  handleIntent(session: Session, message: IntentMessage): void {
    const playerId = session.playerId;
    if (playerId === null) return this.#reject(session, message.requestId, 'NOT_IN_ROOM', 'Najpierw dołącz do pokoju.');
    if (this.#status === 'FINISHED') return this.#reject(session, message.requestId, 'GAME_FINISHED', 'Partia jest zakończona.');
    if (this.#state === null) return this.#reject(session, message.requestId, 'GAME_NOT_STARTED', 'Partia jeszcze się nie zaczęła.');

    const result = applyIntent(this.#state, playerId, message);
    if (!result.ok) return this.#reject(session, message.requestId, result.code, result.message, result.details);
    this.#state = result.state;
    this.#settle({ playerId, requestId: message.requestId, intent: intentName(message) }, feedOf(result));
  }

  requestSync(session: Session, message: RequestSync): void {
    if (this.#state === null) return this.#reject(session, message.requestId, 'GAME_NOT_STARTED', 'Partia jeszcze się nie zaczęła.');
    this.#sendSync(session, { playerId: session.playerId, requestId: message.requestId, intent: 'REQUEST_SYNC' }, true);
  }

  /**
   * Doprowadza grę do punktu, w którym czeka na człowieka: fazy automatyczne,
   * rozesłanie stanu i ruchy AI (każdy z własnym rozesłaniem). Na końcu
   * nastawia zegar tury.
   */
  #settle(cause: SyncCause, feed: Feed): void {
    const ai = this.#config.ai ?? SIMPLE_AI;
    const maxAiSteps = this.#config.maxAiSteps ?? 500;
    let currentCause = cause;
    let currentFeed = feed;

    for (let aiSteps = 0; this.#state !== null; aiSteps++) {
      const advanced = advanceAutomaticPhases(this.#state, { autoRollBattles: this.#config.autoRollBattles ?? false });
      this.#state = advanced.state;
      this.#publish(currentCause, { battles: [...currentFeed.battles, ...advanced.battles], bidding: currentFeed.bidding });
      if (this.#status === 'FINISHED' || aiSteps >= maxAiSteps) break;

      const actor = pendingActors(this.#state).find((playerId) => this.#isAi(playerId));
      if (actor === undefined) break;
      const view = projectState(this.#state, actor, this.#projection);
      const decision = ai.decide(view, actor) ?? fallbackIntent(view);
      if (decision === null) break;
      let result = applyIntent(this.#state, actor, toMessage(decision));
      if (!result.ok) {
        const fallback = fallbackIntent(view);
        if (fallback) result = applyIntent(this.#state, actor, toMessage(fallback));
      }
      if (!result.ok) break;
      this.#state = result.state;
      currentCause = { playerId: actor, requestId: null, intent: `AI:${decision.type}` };
      currentFeed = feedOf(result);
    }
    this.#updateTurnClock();
  }

  // =========================================================================
  // Zegar tury
  // =========================================================================

  /** Nowa decyzja, na którą czeka gra: nowy licznik czasu i TURN_UPDATE dla wszystkich. */
  #updateTurnClock(): void {
    const info = this.#state !== null && this.#status === 'IN_GAME' && !this.#closed ? describeTurn(this.#state) : null;
    if (info !== null && info.turnId === this.#turn?.info.turnId) return; // ta sama tura: licznik biegnie dalej

    const previous = this.#turn;
    previous?.cancel?.();
    this.#turn = null;
    // Tura boga przerwana bitwą zapamiętuje pozostały czas i odzyskuje go po bitwie.
    const toBattle = info?.limit === 'battle';
    if (previous?.info.limit === 'godTurn' && previous.deadline !== null && toBattle) {
      this.#pausedGodTurn = { turnId: previous.info.turnId, remainingMs: Math.max(0, previous.deadline - this.#scheduler.now()) };
    }
    if (info === null) return;

    const resumed = this.#pausedGodTurn?.turnId === info.turnId ? this.#pausedGodTurn.remainingMs : null;
    if (info.limit === 'godTurn') this.#pausedGodTurn = null;
    // Limit obejmuje każdą turę, także bota: gdyby AI utknęło, gra i tak pójdzie dalej.
    const limits = this.#config.turnTimeouts ?? false;
    let deadline: number | null = null;
    let cancel: (() => void) | null = null;
    if (limits !== false) {
      const duration = resumed ?? limits[info.limit];
      deadline = this.#scheduler.now() + duration;
      cancel = this.#scheduler.schedule(duration, () => this.#onTurnTimeout(info.turnId));
    }
    this.#turn = { info, deadline, cancel };
    const update = this.#turnUpdate();
    if (update) this.#broadcast(update);
  }

  /** Czas minął: serwer wykonuje za gracza ruch pasywny ogłoszony w TURN_UPDATE. */
  #onTurnTimeout(turnId: string): void {
    const turn = this.#turn;
    const state = this.#state;
    if (state === null || this.#status !== 'IN_GAME' || this.#closed || turn?.info.turnId !== turnId) return;
    // W kroku rzutu czekają obie strony bitwy, ale rzut za jedną z nich wystarczy.
    const actor = turn.info.actors[0];
    if (actor === undefined) return;
    this.#turn = { ...turn, cancel: null };
    const intent = toMessage(passiveIntent(turn.info.details));
    const result = applyIntent(state, actor, intent);
    if (!result.ok) {
      (this.#config.log ?? console.error)(`Ruch pasywny ${intentName(intent)} odrzucony (${result.code})`, result.details);
      return;
    }
    this.#state = result.state;
    this.#settle({ playerId: actor, requestId: null, intent: `TIMEOUT:${intentName(intent)}` }, feedOf(result));
  }

  #turnUpdate(): TurnUpdate | null {
    const turn = this.#turn;
    if (!turn) return null;
    return {
      v: PROTOCOL_VERSION,
      type: 'TURN_UPDATE',
      turnId: turn.info.turnId,
      actors: turn.info.actors,
      details: turn.info.details,
      deadline: turn.deadline,
      remainingMs: turn.deadline === null ? null : Math.max(0, turn.deadline - this.#scheduler.now()),
      passiveMove: passiveMoveFor(turn.info.details),
    };
  }

  // =========================================================================
  // Okno powrotu
  // =========================================================================

  #startGrace(slot: Slot, human: HumanOccupant): void {
    const grace = this.#config.reconnectGraceMs === undefined ? DEFAULT_RECONNECT_GRACE_MS : this.#config.reconnectGraceMs;
    if (grace === null || this.#closed) return;
    human.reconnectDeadline = this.#scheduler.now() + grace;
    human.cancelGrace = this.#scheduler.schedule(grace, () => this.#abandon(slot));
  }

  /** Gracz nie wrócił na czas: miejsce przejmuje komputer, a żeton traci ważność. */
  #abandon(slot: Slot): void {
    const human = slot.occupant;
    if (human?.kind !== 'HUMAN' || human.session !== null || this.#status !== 'IN_GAME' || this.#closed) return;
    this.#expiredTokens.add(human.token);
    slot.occupant = { kind: 'AI', name: `${human.name} (AI)` };
    this.#broadcastRoomState(null);
    this.#onChange();
    // Jeśli gra czekała na tego gracza, ruch wykonuje już komputer.
    if (this.#state && pendingActors(this.#state).includes(slot.config.playerId)) {
      this.#settle({ playerId: slot.config.playerId, requestId: null, intent: 'AI_TAKEOVER' }, NO_FEED);
    }
  }

  /** Serwer kończy pracę: liczniki pokoju stają, a nowe nie ruszają. */
  close(): void {
    this.#closed = true;
    this.#turn?.cancel?.();
    this.#turn = null;
    for (const slot of this.#slots) {
      if (slot.occupant?.kind !== 'HUMAN') continue;
      slot.occupant.cancelGrace?.();
      slot.occupant.cancelGrace = null;
    }
  }

  // =========================================================================
  // Rozsyłanie
  // =========================================================================

  /**
   * Rozsyła zmianę: najpierw zdarzenia (licytacja, bitwy), potem stan. Każda
   * wiadomość trafia do wszystkich w jednej pętli, więc obie strony bitwy
   * dostają raport rundy w tej samej chwili, zanim ktokolwiek wyśle kolejną komendę.
   */
  #publish(cause: SyncCause, feed: Feed): void {
    if (feed.bidding.length > 0) this.#broadcast({ v: PROTOCOL_VERSION, type: 'BIDDING_EVENT', cause, events: feed.bidding });
    for (const battle of feed.battles) {
      if (battle.events.length === 0) continue;
      this.#broadcast({ v: PROTOCOL_VERSION, type: 'BATTLE_EVENT', ...battle });
    }
    for (const session of this.#sessions()) this.#sendSync(session, cause);

    const phase = this.#state?.phase;
    if (phase?.phase === 'GAME_OVER' && this.#status !== 'FINISHED') {
      this.#status = 'FINISHED';
      this.#broadcast({ v: PROTOCOL_VERSION, type: 'GAME_OVER', winners: phase.winners, finalCycle: phase.finalCycle });
      this.#broadcastRoomState(null);
      this.#onChange();
    }
  }

  /** Wysyła odbiorcy jego projekcję: łatkę względem poprzedniego widoku albo pełny stan. */
  #sendSync(session: Session, cause: SyncCause | null, forceFull = false): void {
    const state = this.#state;
    if (state === null) return;
    const view = projectState(state, session.playerId, this.#projection);
    const last = session.lastSync;
    let message: GameStateSync = { v: PROTOCOL_VERSION, type: 'GAME_STATE_SYNC', mode: 'FULL', revision: state.revision, cause, state: view };
    if (!forceFull && last !== null) {
      const ops = diffJson(last.view, view);
      const patchBytes = JSON.stringify(ops).length;
      const worthIt = patchBytes < PATCH_BYTES_WORTH_CHECKING || patchBytes < JSON.stringify(view).length / 2;
      if (worthIt) {
        message = { v: PROTOCOL_VERSION, type: 'GAME_STATE_SYNC', mode: 'PATCH', revision: state.revision, baseRevision: last.revision, cause, ops };
      }
    }
    session.lastSync = { revision: state.revision, view };
    this.#send(session, message);
  }

  #roomState(session: Session | null, inReplyTo: string | null): RoomState {
    const mySlot = session ? this.#slotOf(session) : undefined;
    const seats: SeatInfo[] = this.#slots.map((slot) => {
      const occupant = slot.occupant;
      return {
        slot: slot.index,
        playerId: slot.config.playerId,
        kind: occupant === null ? 'EMPTY' : occupant.kind,
        name: occupant?.name ?? null,
        color: occupant === null ? null : slot.color,
        city: occupant === null ? null : slot.city,
        ready: occupant?.kind === 'AI' || (occupant?.kind === 'HUMAN' && occupant.ready),
        connected: occupant?.kind === 'AI' || (occupant?.kind === 'HUMAN' && occupant.session !== null),
        reconnectDeadline: occupant?.kind === 'HUMAN' ? occupant.reconnectDeadline : null,
      };
    });
    const token = mySlot?.occupant?.kind === 'HUMAN' ? mySlot.occupant.token : null;
    return {
      v: PROTOCOL_VERSION,
      type: 'ROOM_STATE',
      roomId: this.id,
      status: this.#status,
      settings: this.#settings(),
      host: this.#hostSlot()?.config.playerId ?? null,
      seats,
      you: mySlot?.config.playerId ?? null,
      seatToken: token,
      inReplyTo,
    };
  }

  #settings(): LobbySettings {
    return {
      roomName: this.#config.roomName ?? this.id,
      startMode: this.#startMode(),
      minPlayers: this.#config.minPlayers ?? this.#slots.length,
      maxPlayers: this.#slots.length,
      expansions: this.#expansions,
      availableExpansions: this.#config.availableExpansions ?? ALL_EXPANSIONS,
      cities: this.#cities(),
      colors: ALL_COLORS,
    };
  }

  #broadcastRoomState(except: Session | null): void {
    for (const session of this.#sessions()) if (session !== except) this.#send(session, this.#roomState(session, null));
  }

  #broadcast(message: ServerMessage): void {
    for (const session of this.#sessions()) this.#send(session, message);
  }

  #reject(session: Session, requestId: string | null, code: string, message: string, details: unknown = null): void {
    this.#send(session, { v: PROTOCOL_VERSION, type: 'ACTION_REJECTED', requestId, code, message, details });
  }

  #send(session: Session, message: ServerMessage): void {
    session.channel.send(message);
  }

  // =========================================================================
  // Pomocnicze
  // =========================================================================

  #sessions(): Session[] {
    return this.#slots.flatMap((slot) => (slot.occupant?.kind === 'HUMAN' && slot.occupant.session ? [slot.occupant.session] : []));
  }

  #slotOf(session: Session): Slot | undefined {
    return this.#slots.find((slot) => slot.occupant?.kind === 'HUMAN' && slot.occupant.session === session);
  }

  /** Host: najwcześniej przybyły człowiek (przy `LOCAL_ONLY` tylko połączenie w procesie serwera). */
  #hostSlot(): Slot | undefined {
    const localOnly = (this.#config.hostPolicy ?? 'FIRST_HUMAN') === 'LOCAL_ONLY';
    let host: Slot | undefined;
    for (const slot of this.#slots) {
      const occupant = slot.occupant;
      if (occupant?.kind !== 'HUMAN' || occupant.session === null) continue;
      if (localOnly && occupant.session.channel.remote !== 'loopback') continue;
      const current = host?.occupant;
      if (current?.kind !== 'HUMAN' || occupant.joinedAt < current.joinedAt) host = slot;
    }
    return host;
  }

  /** Bot na slocie. Domyślna nazwa to „Komputer N” z najmniejszym wolnym N. */
  #seatBot(slot: Slot, name?: string): void {
    let number = 1;
    while (this.#slots.some((other) => other.occupant?.name === `Komputer ${number}`)) number++;
    slot.occupant = { kind: 'AI', name: name ?? `Komputer ${number}` };
    slot.color = this.#freeColor(slot.config.color);
  }

  /** Kolor preferowany, jeśli jest wolny, a w przeciwnym razie pierwszy wolny. */
  #freeColor(preferred: PlayerColor): PlayerColor {
    const used = new Set(this.#slots.filter((slot) => slot.occupant !== null).map((slot) => slot.color));
    if (!used.has(preferred)) return preferred;
    return ALL_COLORS.find((color) => !used.has(color)) ?? preferred;
  }

  #clearReady(): void {
    for (const slot of this.#slots) if (slot.occupant?.kind === 'HUMAN') slot.occupant.ready = false;
  }

  #cities(): readonly string[] {
    return this.#config.cities ?? [];
  }

  #startMode(): StartMode {
    return this.#config.startMode ?? 'WHEN_FULL';
  }

  #isAi(playerId: PlayerId): boolean {
    return this.#slots.some((slot) => slot.config.playerId === playerId && slot.occupant?.kind === 'AI');
  }
}

function intentName(message: IntentMessage): string {
  return message.type === 'EXECUTE_ACTION' ? `EXECUTE_ACTION:${message.action.type}` : message.type;
}

function toMessage(intent: AiIntent): IntentMessage {
  const base = { v: PROTOCOL_VERSION, requestId: 'ai' } as const;
  switch (intent.type) {
    case 'SUBMIT_BID':
      return { ...base, type: 'SUBMIT_BID', bid: intent.bid };
    case 'EXECUTE_ACTION':
      return { ...base, type: 'EXECUTE_ACTION', action: intent.action };
    case 'END_TURN':
      return { ...base, type: 'END_TURN' };
    case 'REROLL_DICE':
      return { ...base, type: 'REROLL_DICE' };
  }
}
