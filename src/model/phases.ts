/**
 * @file Fazy gry: stany maszyny stanów i ich konteksty.
 *
 * `GameState.phase` to unia rozróżniana po polu `phase`. Każdy stan niesie
 * WŁASNY kontekst, np. kolejkę licytacji albo trwającą bitwę. Dzięki temu nie
 * da się odczytać kontekstu bitwy poza bitwą ani zapomnieć go wyczyścić:
 * kontekst znika razem ze stanem.
 *
 * Przejścia, strażników i haki opisuje `stateMachine.ts`.
 */

import type { BattleState } from './battle.ts';
import type { BiddableGod, BuildingType, God, RecruitKind, ValueOf } from './domain.ts';
import type { CardId, MonumentCardId, PlayerId } from './ids.ts';
import type { IncomeBreakdown } from './player.ts';

export const Phase = {
  /** Przygotowanie partii: rozstawienie sił startowych. */
  INIT: 'INIT',
  /** Odświeżenie toru Mitologicznych Stworów i Herosów. */
  CREATURES_REFRESH: 'CREATURES_REFRESH',
  /** Odkrycie bogów na torze licytacji (i ewentualne przybycie Hadesa). */
  GODS_SETUP: 'GODS_SETUP',
  /** Dochód: znaczniki dobrobytu na wyspach i pola handlowe. */
  INCOME: 'INCOME',
  /** Licytacja bogów. */
  BIDDING: 'BIDDING',
  /** Tury bogów w kolejności toru, Apollo na końcu. */
  ACTIONS: 'ACTIONS',
  /** Podstan fazy ACTIONS: rozstrzyganie bitwy. */
  BATTLE_RESOLUTION: 'BATTLE_RESOLUTION',
  /** Koniec cyklu: sprawdzenie zwycięstwa i sprzątanie. */
  END_OF_CYCLE: 'END_OF_CYCLE',
  /**
   * Stan końcowy. Nie ma go na liście faz ze specyfikacji, ale automat
   * potrzebuje stanu terminalnego, do którego END_OF_CYCLE przechodzi po
   * spełnieniu warunku zwycięstwa.
   */
  GAME_OVER: 'GAME_OVER',
} as const;
export type Phase = ValueOf<typeof Phase>;

// ---------------------------------------------------------------------------
// Konteksty poszczególnych faz
// ---------------------------------------------------------------------------

export type SetupStep = 'PLACE_STARTING_FORCES' | 'READY';

export interface InitPhase {
  readonly phase: 'INIT';
  readonly step: SetupStep;
  /** Gracze, którzy jeszcze rozstawiają siły startowe, w kolejności rozstawiania. */
  readonly placementQueue: readonly PlayerId[];
}

export interface CreaturesRefreshPhase {
  readonly phase: 'CREATURES_REFRESH';
  /** Karta zrzucona z pola za 2 JZ (do animacji w UI i logu). */
  readonly discarded: CardId | null;
  /** Karty dobrane na tor. */
  readonly drawn: readonly CardId[];
}

export interface GodsSetupPhase {
  readonly phase: 'GODS_SETUP';
  /** Odkryci bogowie w kolejności toru (kopiowani do `GodTrack.slots`). */
  readonly revealed: readonly BiddableGod[];
  /** Czy w tym cyklu Hades został przywołany przez Kolumnę Hadesa. */
  readonly hadesSummoned: boolean;
}

export interface IncomePhase {
  readonly phase: 'INCOME';
  /** Raport dochodu dla każdego gracza. */
  readonly report: Readonly<Record<PlayerId, IncomeBreakdown>>;
}

/** Gracz przebity w licytacji. */
export interface DisplacedBidder {
  readonly playerId: PlayerId;
  /** Bóg, z którego gracz został wyparty. Nie może od razu wrócić na to pole. */
  readonly forbiddenGod: BiddableGod;
}

export interface BiddingPhase {
  readonly phase: 'BIDDING';
  /**
   * Znaczniki ofiary, które jeszcze nie zostały położone, w kolejności
   * z toru kolejności. Przy wariancie z dwoma znacznikami gracz występuje dwukrotnie.
   */
  readonly queue: readonly PlayerId[];
  /** Przebity gracz ma pierwszeństwo przed kolejką i musi od razu złożyć nową ofiarę. */
  readonly displaced: DisplacedBidder | null;
  /**
   * Rozliczenie licytacji: opłaty i kolejność akcji. `null`, dopóki tor się
   * nie ustabilizuje i silnik nie pobierze opłat. Bez rozliczenia strażnik
   * nie wypuści automatu do fazy ACTIONS.
   */
  readonly settlement: BiddingSettlement | null;
}

/** Jedna tura boga w fazie ACTIONS. */
export interface GodTurn {
  readonly god: God;
  readonly playerId: PlayerId;
}

/** Opłata za wylicytowanego boga, pobierana przy rozliczeniu licytacji. */
export interface OfferingPayment {
  readonly playerId: PlayerId;
  readonly god: BiddableGod;
  /** Kwota nominalna z toru bogów. */
  readonly amount: number;
  /** Zniżka od kapłanów, która faktycznie została wykorzystana (`amount - cost`). */
  readonly discount: number;
  /** Zapłacone JZ: `max(1, amount - kapłani)`. */
  readonly cost: number;
}

/** Miejsce gracza u Apolla. */
export interface ApolloPlacement {
  readonly playerId: PlayerId;
  /** Pozycja w kolejności przybycia: 1, 2, 3... */
  readonly position: number;
  /** Znacznik dobrobytu na wyspę dostaje wyłącznie gracz z pozycji 1. */
  readonly receivesProsperityMarker: boolean;
}

/** Wynik zamknięcia licytacji. */
export interface BiddingSettlement {
  readonly payments: readonly OfferingPayment[];
  readonly apollo: readonly ApolloPlacement[];
  /** Kolejność akcji: bogowie z toru od góry (tylko z ofiarą), potem Apollo w kolejności przybycia. */
  readonly actionOrder: readonly GodTurn[];
}

/**
 * Postęp tury aktywnego gracza. Liczniki pozwalają silnikowi naliczać
 * rosnące ceny kolejnych zakupów i pilnować limitów w obrębie tury.
 */
export interface TurnProgress {
  /** Czy gracz odebrał darmowy dar boga (np. oddział od Aresa). */
  readonly giftClaimed: boolean;
  readonly recruited: Readonly<Partial<Record<RecruitKind, number>>>;
  readonly buildingsBuilt: readonly BuildingType[];
  readonly cardsBought: readonly CardId[];
  readonly monumentsBuilt: readonly MonumentCardId[];
  /** Liczba wykonanych ruchów (oddziałów lub flot). */
  readonly movements: number;
  /** Gracz zakończył turę. To warunek przejścia do następnego boga lub END_OF_CYCLE. */
  readonly finished: boolean;
}

export interface ActionsPhase {
  readonly phase: 'ACTIONS';
  /** Tury bogów: najpierw tor od góry, potem gracze Apolla w kolejności przybycia. */
  readonly turns: readonly GodTurn[];
  /** Indeks aktywnej tury w `turns`. */
  readonly turnIndex: number;
  readonly progress: TurnProgress;
}

/**
 * Bitwa to podstan fazy ACTIONS, więc automat działa jak automat ze stosem.
 * Wejście w bitwę „zamraża” kontekst ACTIONS w polu `resume`, a wyjście go
 * przywraca. Tura gracza jest kontynuowana dokładnie od miejsca, w którym
 * wybuchła bitwa, z zachowanymi licznikami zakupów i ruchów.
 */
export interface BattleResolutionPhase {
  readonly phase: 'BATTLE_RESOLUTION';
  readonly battle: BattleState;
  readonly resume: ActionsPhase;
}

/** Wynik sprawdzenia zwycięstwa na końcu cyklu. */
export interface VictoryCheck {
  /** Gracze z wymaganą liczbą Metropolii. */
  readonly contenders: readonly PlayerId[];
  /**
   * Zwycięzcy po dogrywce (najwięcej JZ). Pusta lista oznacza, że gra toczy
   * się dalej. Więcej niż jeden gracz oznacza remis również w złocie.
   */
  readonly winners: readonly PlayerId[];
}

export interface EndOfCyclePhase {
  readonly phase: 'END_OF_CYCLE';
  readonly victory: VictoryCheck;
}

export interface GameOverPhase {
  readonly phase: 'GAME_OVER';
  readonly winners: readonly PlayerId[];
  readonly finalCycle: number;
}

/** Stan maszyny: dokładnie jedna faza z własnym kontekstem. */
export type PhaseState =
  | InitPhase
  | CreaturesRefreshPhase
  | GodsSetupPhase
  | IncomePhase
  | BiddingPhase
  | ActionsPhase
  | BattleResolutionPhase
  | EndOfCyclePhase
  | GameOverPhase;

/** Kontekst konkretnej fazy, np. `PhaseOf<'ACTIONS'>` to `ActionsPhase`. */
export type PhaseOf<P extends Phase> = Extract<PhaseState, { readonly phase: P }>;

/** Pusty postęp tury (początek tury boga). */
export function createTurnProgress(): TurnProgress {
  return {
    giftClaimed: false,
    recruited: {},
    buildingsBuilt: [],
    cardsBought: [],
    monumentsBuilt: [],
    movements: 0,
    finished: false,
  };
}
