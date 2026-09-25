/**
 * @file Kontrakty danych protokołu sieciowego (wersja 1).
 *
 * Zasady:
 *  - SERWER DECYDUJE. Klient wysyła tylko intencje (np. „chcę złożyć ofiarę
 *    Aresowi za 3 JZ”). Nigdy nie wysyła wyników, rzutów kośćmi ani swojego
 *    `playerId`. Tożsamość gracza wynika z miejsca przy stole przypisanego
 *    do połączenia.
 *  - Każda wiadomość to obiekt z polami `v` (wersja protokołu) i `type`.
 *    Wiadomości klienta mają też `requestId`, którym serwer odpowiada
 *    (odrzucenie albo potwierdzenie w `GAME_STATE_SYNC.cause`).
 *  - Kształt jest niezależny od kodowania: te same obiekty płyną jako JSON
 *    (ramki tekstowe) albo MessagePack (ramki binarne), zob. `codec.ts`.
 */

import type {
  BattleId,
  BattleLocation,
  BattleRole,
  BiddableGod,
  God,
  HeroId,
  IslandId,
  NodeId,
  PlayerColor,
  PlayerId,
  SeaId,
} from '../model/index.ts';
import type { BattleEvent, BidEvent, FleetStep, UndeadKind } from '../engine/index.ts';
import type { PatchOp } from './diff.ts';
import type { PublicGameState } from './projection.ts';

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ===========================================================================
// Klient → Serwer
// ===========================================================================

/** Wybór w licytacji (intencja BID_GOD). */
export type BidChoice =
  | { readonly kind: 'GOD'; readonly god: BiddableGod; readonly amount: number }
  | { readonly kind: 'APOLLO' };

/** Intencje akcji w turze boga i w bitwie (wiadomość EXECUTE_ACTION). */
export type ActionIntent =
  | { readonly type: 'MOVE_FLEET'; readonly from: SeaId; readonly count: number; readonly route: readonly FleetStep[] }
  | {
      readonly type: 'MOVE_TROOPS';
      readonly from: IslandId;
      readonly to: IslandId;
      readonly troops: number;
      readonly undeadTroops?: number;
      readonly heroes?: readonly HeroId[];
    }
  | { readonly type: 'RECRUIT_UNDEAD'; readonly kind: UndeadKind; readonly to: NodeId }
  | { readonly type: 'BUILD_NECROPOLIS'; readonly islandId: IslandId }
  | { readonly type: 'BUY_CREATURE'; readonly slot: 0 | 1 | 2 }
  | { readonly type: 'RETREAT'; readonly to: NodeId }
  | { readonly type: 'HOLD' };

export type ActionType = ActionIntent['type'];

/** Intencje w lobby, przed startem partii (wiadomość LOBBY_ACTION). */
export type LobbyIntent =
  /** Wybór koloru figurek (każdy kolor najwyżej raz). */
  | { readonly type: 'SET_COLOR'; readonly color: PlayerColor }
  /** Wybór miasta startowego (`null`: przydział automatyczny przy starcie). */
  | { readonly type: 'SET_CITY'; readonly city: string | null }
  /** Gotowość gracza. */
  | { readonly type: 'SET_READY'; readonly ready: boolean }
  /** Host: aktywne dodatki. */
  | { readonly type: 'SET_EXPANSIONS'; readonly hades: boolean; readonly monuments: boolean }
  /** Host: bot AI na wolnym slocie. */
  | { readonly type: 'ADD_BOT'; readonly slot: number }
  /** Host: usunięcie bota ze slotu. */
  | { readonly type: 'REMOVE_BOT'; readonly slot: number }
  /** Host: start partii. */
  | { readonly type: 'START_GAME' };

export type LobbyActionType = LobbyIntent['type'];

interface ClientBase<T extends string> {
  readonly v: ProtocolVersion;
  readonly type: T;
  /** Nadawany przez klienta, unikalny w obrębie jego połączenia. */
  readonly requestId: string;
}

export interface JoinRoom extends ClientBase<'JOIN_ROOM'> {
  readonly roomId: string;
  readonly playerName: string;
  /** Żeton miejsca z wcześniejszego ROOM_STATE, pozwala wrócić po zerwaniu połączenia. */
  readonly seatToken?: string;
}

export interface SubmitBid extends ClientBase<'SUBMIT_BID'> {
  readonly bid: BidChoice;
}

export interface ExecuteAction extends ClientBase<'EXECUTE_ACTION'> {
  readonly action: ActionIntent;
}

/** Koniec tury boga. */
export type EndTurn = ClientBase<'END_TURN'>;

/**
 * Prośba o rzut kośćmi w bitwie (kolejna runda starcia). Rzut wykonuje
 * serwer swoim generatorem, a klient nigdy nie podaje wyniku.
 */
export type RerollDice = ClientBase<'REROLL_DICE'>;

/** Prośba o pełny stan (np. po wykryciu luki w numerach rewizji). */
export type RequestSync = ClientBase<'REQUEST_SYNC'>;

/** Zmiana w lobby. Serwer odpowiada ROOM_STATE z `inReplyTo` albo ACTION_REJECTED. */
export interface LobbyAction extends ClientBase<'LOBBY_ACTION'> {
  readonly action: LobbyIntent;
}

export type ClientMessage = JoinRoom | LobbyAction | SubmitBid | ExecuteAction | EndTurn | RerollDice | RequestSync;
export type ClientMessageType = ClientMessage['type'];

// ===========================================================================
// Serwer → Klient
// ===========================================================================

/** Rodzaj slotu w konfiguracji pokoju: otwarty dla człowieka albo od początku z botem. */
export type SeatKind = 'HUMAN' | 'AI';
/** Kto aktualnie zajmuje slot. */
export type SeatOccupant = SeatKind | 'EMPTY';
export type RoomStatus = 'WAITING' | 'IN_GAME' | 'FINISHED';
/** `WHEN_FULL`: start, gdy wszystkie sloty są zajęte (szybka gra). `HOST`: start na polecenie hosta. */
export type StartMode = 'WHEN_FULL' | 'HOST';

export interface SeatInfo {
  readonly slot: number;
  readonly playerId: PlayerId;
  readonly kind: SeatOccupant;
  /** `null` dla wolnego slotu. */
  readonly name: string | null;
  readonly color: PlayerColor | null;
  readonly city: string | null;
  readonly ready: boolean;
  readonly connected: boolean;
  /**
   * Rozłączony gracz w trakcie partii: do tej chwili (ms od epoki, zegar
   * serwera) może wrócić z żetonem miejsca. Potem miejsce przejmuje komputer.
   */
  readonly reconnectDeadline: number | null;
}

/** Ustawienia lobby widoczne dla wszystkich. */
export interface LobbySettings {
  readonly roomName: string;
  readonly startMode: StartMode;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly expansions: { readonly hades: boolean; readonly monuments: boolean };
  /** Dodatki, które host może włączyć na tym serwerze (pozostałe przełączniki są nieaktywne). */
  readonly availableExpansions: { readonly hades: boolean; readonly monuments: boolean };
  /** Miasta startowe do wyboru (pusta lista: mapa ustala pozycje sama). */
  readonly cities: readonly string[];
  readonly colors: readonly PlayerColor[];
}

interface ServerBase<T extends string> {
  readonly v: ProtocolVersion;
  readonly type: T;
}

export interface RoomState extends ServerBase<'ROOM_STATE'> {
  readonly roomId: string;
  readonly status: RoomStatus;
  readonly settings: LobbySettings;
  /** Gracz z uprawnieniami hosta (dodatki, boty, start partii). */
  readonly host: PlayerId | null;
  readonly seats: readonly SeatInfo[];
  /** Miejsce odbiorcy (`null` dla połączeń bez miejsca). */
  readonly you: PlayerId | null;
  /** Żeton do ponownego dołączenia, wysyłany wyłącznie właścicielowi miejsca. */
  readonly seatToken: string | null;
  /** `requestId` wiadomości (JOIN_ROOM, LOBBY_ACTION), na którą to odpowiedź. */
  readonly inReplyTo: string | null;
}

/** Co spowodowało zmianę stanu. Klient rozpoznaje po tym potwierdzenie własnej komendy. */
export interface SyncCause {
  readonly playerId: PlayerId | null;
  readonly requestId: string | null;
  readonly intent: string;
}

interface SyncBase extends ServerBase<'GAME_STATE_SYNC'> {
  /** Rewizja stanu po zastosowaniu tej wiadomości. */
  readonly revision: number;
  readonly cause: SyncCause | null;
}

/** Pełny stan (projekcja dla odbiorcy). */
export interface FullSync extends SyncBase {
  readonly mode: 'FULL';
  readonly state: PublicGameState;
}

/** Zmiany względem stanu o rewizji `baseRevision` (podzbiór JSON Patch, RFC 6902). */
export interface PatchSync extends SyncBase {
  readonly mode: 'PATCH';
  readonly baseRevision: number;
  readonly ops: readonly PatchOp[];
}

export type GameStateSync = FullSync | PatchSync;

export interface ActionRejected extends ServerBase<'ACTION_REJECTED'> {
  readonly requestId: string | null;
  /** Kod z silnika zasad albo warstwy sieciowej (np. `NO_FLEET_BRIDGE`, `MALFORMED`). */
  readonly code: string;
  /** Komunikat dla gracza (po polsku). */
  readonly message: string;
  readonly details: unknown;
}

/** Zdarzenie bitwy dla widowni: początek i przebieg (rundy, odwroty, wynik). */
export type BattleFeedEvent =
  | {
      readonly type: 'BATTLE_STARTED';
      readonly kind: 'LAND' | 'SEA';
      readonly where: NodeId;
      readonly attacker: PlayerId;
      readonly defender: PlayerId;
    }
  | BattleEvent;

/**
 * Przebieg bitwy, wysyłany w tej samej chwili obu stronom i widowni.
 * `ROUND_RESOLVED` niesie raport rundy: rzuty obu stron, jednostki
 * i modyfikatory rozpisane na źródła (Fortece, Porty, herosi…) oraz straty.
 */
export interface BattleEventMessage extends ServerBase<'BATTLE_EVENT'> {
  readonly battleId: BattleId;
  readonly attacker: PlayerId;
  readonly defender: PlayerId;
  readonly location: BattleLocation;
  readonly events: readonly BattleFeedEvent[];
}

/** Przebieg licytacji dla wszystkich: ofiary, przebicia i wybór Apolla. */
export interface BiddingEventMessage extends ServerBase<'BIDDING_EVENT'> {
  /** Kto licytował: gracz, jego `requestId` albo `TIMEOUT:…`, gdy po upływie czasu zagrał serwer. */
  readonly cause: SyncCause;
  readonly events: readonly BidEvent[];
}

/** Na co czeka gra. */
export type TurnDetails =
  /** Kolej na ofiarę w licytacji. */
  | { readonly reason: 'BID' }
  /** Gracz został przebity: musi od razu wybrać innego boga (nie `god`) albo Apolla. */
  | { readonly reason: 'OUTBID'; readonly by: PlayerId; readonly god: BiddableGod; readonly amount: number }
  /** Tura boga w fazie akcji. */
  | { readonly reason: 'GOD_TURN'; readonly god: God }
  /** Rzut kośćmi w bitwie: zlecić go może każda ze stron. */
  | { readonly reason: 'BATTLE_ROLL'; readonly battleId: BattleId; readonly round: number }
  /** Decyzja o odwrocie po rundzie. */
  | { readonly reason: 'RETREAT_DECISION'; readonly battleId: BattleId; readonly role: BattleRole; readonly options: readonly NodeId[] };

/** Ruch, który serwer wykona sam, gdy czas minie. */
export type PassiveMove = 'APOLLO' | 'END_TURN' | 'ROLL' | 'HOLD';

/**
 * Zegar tury: na kogo i na co czeka gra oraz do kiedy. Serwer wysyła go
 * wszystkim przy każdej nowej decyzji (np. zaraz po przebiciu w licytacji)
 * i każdemu, kto wraca do partii.
 */
export interface TurnUpdate extends ServerBase<'TURN_UPDATE'> {
  /** Zmienia się z każdą nową decyzją, na którą czeka gra. */
  readonly turnId: string;
  readonly actors: readonly PlayerId[];
  readonly details: TurnDetails;
  /** Termin (ms od epoki, zegar serwera), po którym serwer wykona `passiveMove`. `null`: bez limitu. */
  readonly deadline: number | null;
  /** Czas pozostały w chwili wysłania: klient odlicza go własnym zegarem. */
  readonly remainingMs: number | null;
  readonly passiveMove: PassiveMove;
}

export interface GameOver extends ServerBase<'GAME_OVER'> {
  readonly winners: readonly PlayerId[];
  readonly finalCycle: number;
}

export type ServerMessage = RoomState | GameStateSync | ActionRejected | BattleEventMessage | BiddingEventMessage | TurnUpdate | GameOver;
export type ServerMessageType = ServerMessage['type'];

/** Kody odrzuceń nadawane przez samą warstwę sieciową (reszta pochodzi z silnika). */
export type NetRejectionCode =
  | 'MALFORMED'
  | 'NOT_HOST'
  | 'GAME_ALREADY_STARTED'
  | 'COLOR_TAKEN'
  | 'UNKNOWN_CITY'
  | 'CITY_TAKEN'
  | 'INVALID_SLOT'
  | 'SLOT_OCCUPIED'
  | 'NOT_A_BOT'
  | 'NOT_ALL_READY'
  | 'NOT_ENOUGH_PLAYERS'
  | 'EXPANSION_UNAVAILABLE'
  | 'UNKNOWN_ROOM'
  | 'ROOM_FULL'
  | 'ALREADY_JOINED'
  | 'INVALID_SEAT_TOKEN'
  | 'RECONNECT_EXPIRED'
  | 'NOT_IN_ROOM'
  | 'GAME_NOT_STARTED'
  | 'GAME_FINISHED'
  | 'UNSUPPORTED_ACTION'
  | 'NOT_IN_BATTLE'
  | 'NOT_A_PARTICIPANT';
