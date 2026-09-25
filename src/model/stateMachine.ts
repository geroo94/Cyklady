/**
 * @file Maszyna stanów faz gry.
 *
 *   INIT ─► CREATURES_REFRESH ─► GODS_SETUP ─► INCOME ─► BIDDING ─► ACTIONS ◄─► BATTLE_RESOLUTION
 *                 ▲                                                    │
 *                 └──────────────────── END_OF_CYCLE ◄─────────────────┘
 *                                           │
 *                                           └─► GAME_OVER
 *
 * Trzy warstwy:
 *  1. TABELA PRZEJŚĆ (`PHASE_TRANSITIONS`) określa, które krawędzie istnieją.
 *  2. STRAŻNICY (`EDGE_RULES`) określają, kiedy wolno z krawędzi skorzystać,
 *     np. licytacji nie da się zamknąć, dopóki ktoś nie złożył ofiary.
 *  3. HAKI (`PhaseHooks`) to efekty wyjścia z fazy i wejścia do niej,
 *     wstrzykiwane przez silnik zasad. Model zna strukturę cyklu, ale nie
 *     reguły kart, więc np. przetasowanie talii na wejściu do fazy dostarcza
 *     silnik jako hak.
 *
 * Model wykonuje sam tylko efekty strukturalne, czyli granicę cyklu: numer
 * cyklu, zatwierdzenie toru kolejności i wyczyszczenie toru bogów.
 */

import { sidePresence, type BattleState } from './battle.ts';
import type { GameState } from './gameState.ts';
import type { PlayerId } from './ids.ts';
import type { GodTrack } from './trackers.ts';
import {
  createTurnProgress,
  type ActionsPhase,
  type BiddingPhase,
  type GodTurn,
  type Phase,
  type PhaseOf,
  type PhaseState,
} from './phases.ts';

// ===========================================================================
// 1. Tabela przejść
// ===========================================================================

export const PHASE_TRANSITIONS = {
  INIT: ['CREATURES_REFRESH'],
  CREATURES_REFRESH: ['GODS_SETUP'],
  GODS_SETUP: ['INCOME'],
  INCOME: ['BIDDING'],
  BIDDING: ['ACTIONS'],
  ACTIONS: ['BATTLE_RESOLUTION', 'END_OF_CYCLE'],
  BATTLE_RESOLUTION: ['ACTIONS'],
  END_OF_CYCLE: ['CREATURES_REFRESH', 'GAME_OVER'],
  GAME_OVER: [],
} as const satisfies Readonly<Record<Phase, readonly Phase[]>>;

/** Klucz istniejącej krawędzi, np. `'BIDDING->ACTIONS'`. Nieistniejące krawędzie to błąd kompilacji. */
export type TransitionKey = {
  [F in Phase]: `${F}->${(typeof PHASE_TRANSITIONS)[F][number]}`;
}[Phase];

type EdgeFrom<K extends TransitionKey> = K extends `${infer F extends Phase}->${string}` ? F : never;
type EdgeTo<K extends TransitionKey> = K extends `${string}->${infer T extends Phase}` ? T : never;

export function canTransition(from: Phase, to: Phase): boolean {
  return (PHASE_TRANSITIONS[from] as readonly Phase[]).includes(to);
}

export class IllegalTransitionError extends Error {
  readonly from: Phase;
  readonly to: Phase;
  readonly reason: string;

  constructor(from: Phase, to: Phase, reason: string) {
    super(`Niedozwolone przejście ${from} -> ${to}: ${reason}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
    this.reason = reason;
  }
}

export class PhaseMismatchError extends Error {
  constructor(expected: Phase, actual: Phase) {
    super(`Oczekiwano fazy ${expected}, a trwa faza ${actual}`);
    this.name = 'PhaseMismatchError';
  }
}

/** Zwraca kontekst fazy, jeśli właśnie trwa. W przeciwnym razie rzuca `PhaseMismatchError`. */
export function expectPhase<P extends Phase>(state: GameState, phase: P): PhaseOf<P> {
  if (state.phase.phase !== phase) throw new PhaseMismatchError(phase, state.phase.phase);
  return state.phase as PhaseOf<P>;
}

// ===========================================================================
// 2. Strażnicy
// ===========================================================================

/**
 * Reguły krawędzi. Każda część zwraca `null`, gdy wszystko jest w porządku,
 * albo czytelny powód blokady (trafia do `IllegalTransitionError` i do UI).
 *
 * - `ready`: czy wolno JUŻ opuścić fazę tą krawędzią. Zależy tylko od
 *   bieżącego stanu, więc sprawdza go też `automaticNextPhase`.
 * - `consistent`: czy przekazany kontekst fazy docelowej pasuje do stanu,
 *   np. czy po bitwie wracamy do tej samej tury.
 *
 * Obie funkcje dostają konteksty zawężone do typów faz danej krawędzi.
 */
interface EdgeRule<K extends TransitionKey> {
  readonly ready?: (state: GameState, from: PhaseOf<EdgeFrom<K>>) => string | null;
  readonly consistent?: (state: GameState, from: PhaseOf<EdgeFrom<K>>, to: PhaseOf<EdgeTo<K>>) => string | null;
}

/** Postać reguły po „wymazaniu” typów krawędzi (do wywołań z pętli). */
interface AnyEdgeRule {
  readonly ready?: (state: GameState, from: PhaseState) => string | null;
  readonly consistent?: (state: GameState, from: PhaseState, to: PhaseState) => string | null;
}

const EDGE_RULES: { readonly [K in TransitionKey]?: EdgeRule<K> } = {
  'INIT->CREATURES_REFRESH': {
    ready: (_state, from) => (from.step === 'READY' ? null : 'rozstawienie sił startowych nie zostało zakończone'),
  },

  'BIDDING->ACTIONS': {
    ready: (_state, from) => {
      if (from.displaced !== null) return `przebity gracz ${from.displaced.playerId} musi złożyć nową ofiarę`;
      if (from.queue.length > 0) return `ofiary nie złożyli jeszcze: ${from.queue.join(', ')}`;
      if (from.settlement === null) return 'licytacja nie została rozliczona (opłaty i kolejność akcji)';
      return null;
    },
    consistent: (_state, from, to) =>
      sameTurns(to.turns, from.settlement?.actionOrder ?? [])
        ? null
        : 'kolejność tur w fazie ACTIONS musi odpowiadać rozliczeniu licytacji',
  },

  'ACTIONS->BATTLE_RESOLUTION': {
    ready: (_state, from) => (from.progress.finished ? 'bitwa może wybuchnąć tylko w trakcie trwającej tury' : null),
    consistent: (state, from, to) => {
      if (to.resume.turnIndex !== from.turnIndex) return 'kontekst powrotu musi wskazywać bieżącą turę';
      const where = to.battle.location;
      const occupied =
        where.kind === 'LAND'
          ? state.board.islands[where.islandId]?.garrison != null
          : state.board.seas[where.seaId]?.fleet != null;
      return occupied ? 'przed bitwą jednostki z pola bitwy trzeba przenieść do kontekstu bitwy' : null;
    },
  },

  'ACTIONS->END_OF_CYCLE': {
    ready: (_state, from) => {
      if (from.turnIndex < from.turns.length - 1) return 'nie wszyscy bogowie zostali rozegrani';
      if (!from.progress.finished) return 'ostatnia tura nie została zakończona';
      return null;
    },
  },

  'BATTLE_RESOLUTION->ACTIONS': {
    ready: (_state, from) => {
      const { battle } = from;
      if (battle.outcome === null) return 'bitwa nie została rozstrzygnięta';
      if (battle.step !== 'FINISHED') return 'po rozstrzygnięciu trzeba wykonać krok sprzątania (CLEANUP)';
      const left = [battle.attacker, battle.defender].some((side) => sidePresence(side) > 0);
      return left ? 'ocalałe jednostki trzeba odstawić na planszę (albo do zapasu) przed zamknięciem bitwy' : null;
    },
    consistent: (_state, from, to) =>
      to.turnIndex === from.resume.turnIndex ? null : 'po bitwie trzeba wrócić do przerwanej tury',
  },

  'END_OF_CYCLE->GAME_OVER': {
    ready: (_state, from) => (from.victory.winners.length > 0 ? null : 'nikt nie spełnił warunku zwycięstwa'),
    consistent: (_state, from, to) =>
      sameMultiset(to.winners, from.victory.winners) ? null : 'lista zwycięzców nie zgadza się z wynikiem sprawdzenia',
  },

  'END_OF_CYCLE->CREATURES_REFRESH': {
    ready: (state, from) => {
      if (from.victory.winners.length > 0) return 'jest zwycięzca, więc gra musi się zakończyć';
      if (!sameMultiset(state.turnOrder.next, state.turnOrder.current)) {
        return 'tor kolejności na następny cykl jest niekompletny';
      }
      return null;
    },
  },
};

function edgeRule(from: Phase, to: Phase): AnyEdgeRule | undefined {
  // Klucz jednoznacznie wyznacza typy kontekstów, więc wymazanie typów jest bezpieczne.
  return EDGE_RULES[`${from}->${to}` as TransitionKey] as AnyEdgeRule | undefined;
}

/** Zwraca powód blokady przejścia albo `null`, gdy przejście jest dozwolone. */
export function checkTransition(state: GameState, next: PhaseState): string | null {
  const from = state.phase.phase;
  if (!canTransition(from, next.phase)) return 'brak takiej krawędzi w maszynie stanów';
  const rule = edgeRule(from, next.phase);
  return rule?.ready?.(state, state.phase) ?? rule?.consistent?.(state, state.phase, next) ?? null;
}

// ===========================================================================
// 3. Haki i wykonanie przejścia
// ===========================================================================

export type PhaseHook = (state: GameState) => GameState;

/** Efekty wejścia do fazy i wyjścia z niej, dostarczane przez silnik zasad. */
export interface PhaseHooks {
  /** Wywoływany na starym stanie, przed zmianą fazy. */
  readonly onExit?: Partial<Record<Phase, PhaseHook>>;
  /**
   * Wywoływany na nowym stanie, gdy `state.phase` wskazuje już nową fazę.
   * Może uzupełnić kontekst fazy wynikami znanymi dopiero po wejściu,
   * np. dobranymi kartami, odkrytymi bogami albo raportem dochodu.
   */
  readonly onEnter?: Partial<Record<Phase, PhaseHook>>;
}

/**
 * Wykonuje przejście do fazy `next`. Kolejność kroków:
 * walidacja (krawędź i strażnik), `onExit`, efekty strukturalne, `onEnter`.
 * Funkcja jest czysta: zwraca nowy stan albo rzuca `IllegalTransitionError`.
 */
export function transition(state: GameState, next: PhaseState, hooks: PhaseHooks = {}): GameState {
  const from = state.phase.phase;
  const blocked = checkTransition(state, next);
  if (blocked !== null) throw new IllegalTransitionError(from, next.phase, blocked);

  const exited = hooks.onExit?.[from]?.(state) ?? state;
  const entered = applyStructuralEffects(exited, next);
  return hooks.onEnter?.[next.phase]?.(entered) ?? entered;
}

/** Efekty należące do struktury cyklu, niezależne od reguł kart. */
function applyStructuralEffects(state: GameState, next: PhaseState): GameState {
  const base: GameState = { ...state, phase: next, revision: state.revision + 1 };
  if (next.phase !== 'CREATURES_REFRESH') return base;

  // Wejście do CREATURES_REFRESH rozpoczyna nowy cykl.
  if (state.phase.phase === 'INIT') return { ...base, cycle: 1 };
  return {
    ...base,
    cycle: state.cycle + 1,
    turnOrder: { current: state.turnOrder.next, next: [] },
    gods: { slots: [], apolloSupplicants: [], unavailable: [] },
  };
}

/**
 * Pierwsza faza, do której można teraz przejść bez decyzji gracza (sprawdza
 * tylko `ready`, bo kontekst fazy docelowej buduje dopiero silnik zasad).
 * Zwraca `null`, gdy automat czeka na akcję gracza, także wtedy, gdy
 * w ACTIONS trzeba rozpocząć turę następnego boga (`startNextGodTurn`).
 * Bitwa jest pomijana, bo wywołuje ją ruch jednostek, a nie upływ czasu.
 * Orkiestrator (serwer) woła tę funkcję w pętli i przewija fazy automatyczne.
 */
export function automaticNextPhase(state: GameState): Phase | null {
  const from = state.phase.phase;
  for (const to of PHASE_TRANSITIONS[from] as readonly Phase[]) {
    if (to === 'BATTLE_RESOLUTION') continue;
    if ((edgeRule(from, to)?.ready?.(state, state.phase) ?? null) === null) return to;
  }
  return null;
}

// ===========================================================================
// Przejścia pomocnicze: licytacja, tury bogów, bitwa
// ===========================================================================

/** Kontekst licytacji: znaczniki kładzie się w kolejności z toru kolejności. */
export function createBiddingPhase(state: GameState): BiddingPhase {
  return { phase: 'BIDDING', queue: [...state.turnOrder.current], displaced: null, settlement: null };
}

/**
 * Kolejność akcji wynikająca z toru bogów: bogowie od góry toru (pomijając
 * tych bez ofiary), potem gracze Apolla w kolejności przybycia.
 */
export function actionOrderFromTrack(gods: GodTrack): GodTurn[] {
  const turns: GodTurn[] = gods.slots.flatMap((slot) =>
    slot.offering ? [{ god: slot.god, playerId: slot.offering.playerId }] : [],
  );
  for (const playerId of gods.apolloSupplicants) turns.push({ god: 'APOLLO', playerId });
  return turns;
}

/** Kontekst fazy ACTIONS zbudowany z wyniku licytacji (zob. `actionOrderFromTrack`). */
export function createActionsPhase(state: GameState): ActionsPhase {
  const turns = actionOrderFromTrack(state.gods);
  if (turns.length === 0) throw new Error('Faza ACTIONS wymaga co najmniej jednej tury boga');
  return { phase: 'ACTIONS', turns, turnIndex: 0, progress: createTurnProgress() };
}

/** Aktywna tura boga albo `null` poza fazą ACTIONS i BATTLE_RESOLUTION. */
export function currentGodTurn(state: GameState): GodTurn | null {
  const phase = state.phase;
  const actions = phase.phase === 'ACTIONS' ? phase : phase.phase === 'BATTLE_RESOLUTION' ? phase.resume : null;
  return actions?.turns[actions.turnIndex] ?? null;
}

/**
 * Kończy turę aktywnego gracza i dopisuje go na koniec toru kolejności
 * następnego cyklu (kolejność kończenia tur wyznacza kolejność licytacji).
 */
export function finishGodTurn(state: GameState): GameState {
  const phase = expectPhase(state, 'ACTIONS');
  if (phase.progress.finished) throw new Error('Tura została już zakończona');
  const turn = phase.turns[phase.turnIndex];
  if (!turn) throw new Error(`Brak tury o indeksie ${phase.turnIndex}`);
  return {
    ...state,
    revision: state.revision + 1,
    turnOrder: { ...state.turnOrder, next: [...state.turnOrder.next, turn.playerId] },
    phase: { ...phase, progress: { ...phase.progress, finished: true } },
  };
}

/** Rozpoczyna turę następnego boga w ramach fazy ACTIONS (bez zmiany fazy). */
export function startNextGodTurn(state: GameState): GameState {
  const phase = expectPhase(state, 'ACTIONS');
  if (!phase.progress.finished) throw new Error('Najpierw trzeba zakończyć bieżącą turę');
  if (phase.turnIndex >= phase.turns.length - 1) {
    throw new Error('To była ostatnia tura cyklu, więc następna jest faza END_OF_CYCLE');
  }
  return {
    ...state,
    revision: state.revision + 1,
    phase: { ...phase, turnIndex: phase.turnIndex + 1, progress: createTurnProgress() },
  };
}

/**
 * Wejście w bitwę (push na stos): bieżący kontekst ACTIONS zostaje zamrożony
 * w `resume`. Wcześniej wywołujący przenosi jednostki obu stron z węzłów
 * do `battle`, czego pilnuje strażnik krawędzi.
 */
export function beginBattle(state: GameState, battle: BattleState, hooks?: PhaseHooks): GameState {
  const actions = expectPhase(state, 'ACTIONS');
  return transition(state, { phase: 'BATTLE_RESOLUTION', battle, resume: actions }, hooks);
}

/**
 * Wyjście z rozstrzygniętej bitwy (pop ze stosu): powrót do przerwanej tury.
 * Wcześniej ocalałe jednostki muszą wrócić na planszę, a polegli do zapasu.
 * Strażnik nie pozwoli zamknąć bitwy, w której zostały jeszcze figurki.
 */
export function endBattle(state: GameState, hooks?: PhaseHooks): GameState {
  const battle = expectPhase(state, 'BATTLE_RESOLUTION');
  return transition(state, battle.resume, hooks);
}

// ===========================================================================
// Narzędzia
// ===========================================================================

function sameTurns(a: readonly GodTurn[], b: readonly GodTurn[]): boolean {
  return a.length === b.length && a.every((turn, i) => turn.god === b[i]?.god && turn.playerId === b[i]?.playerId);
}

function sameMultiset(a: readonly PlayerId[], b: readonly PlayerId[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<PlayerId, number>();
  for (const id of a) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of b) {
    const left = (counts.get(id) ?? 0) - 1;
    if (left < 0) return false;
    counts.set(id, left);
  }
  return true;
}
