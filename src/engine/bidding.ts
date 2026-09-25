/**
 * @file Silnik licytacji bogów (faza BIDDING).
 *
 * ZASADY
 *  1. Gracze kładą znaczniki ofiary w kolejności z toru kolejności. Każdy
 *     wybiera boga z toru (Ares, Posejdon, Zeus, Atena, a po przywołaniu
 *     także Hades) albo idzie do Apolla.
 *  2. Ofiara to kwota nominalna, czyli dodatnia liczba całkowita wyższa od
 *     aktualnej oferty na tym bogu. Koszt ofiary wynosi
 *     `max(1, kwota - kapłani)` i gracz musi móc go zapłacić. Apollo kosztuje 0 JZ.
 *  3. Przebity gracz zabiera znacznik i NATYCHMIAST, przed resztą kolejki,
 *     kładzie go na INNEGO boga (nie na tego, z którego właśnie wypadł) albo
 *     idzie do Apolla. Sam może przy tym przebić kolejnego gracza, więc
 *     łańcuch trwa, aż ktoś położy znacznik na wolnym bogu albo u Apolla.
 *  4. Apollo nie ma licytacji i może go wybrać dowolna liczba graczy. Liczy
 *     się kolejność przybycia (pozycje 1, 2, 3...), a znacznik dobrobytu na
 *     wyspę dostaje tylko gracz z pozycji 1.
 *  5. Gdy tor się ustabilizuje, silnik pobiera opłaty (z kapłanami) i ustala
 *     kolejność akcji: bogowie z toru od góry, potem Apollo.
 *
 * ARCHITEKTURA
 *  - Czyste funkcje: stan wejściowy nigdy nie jest modyfikowany.
 *  - Błędy walidacji to wartości (`{ ok: false, error }`) z kodem
 *    i danymi, a nie wyjątki. UI pokazuje je przez `describeRejection`,
 *    a serwer odsyła je klientowi. Wyjątki oznaczają wyłącznie błąd
 *    programisty albo uszkodzony stan.
 *  - „Pętla przelicytowań” to kontekst `BiddingPhase.displaced`: dopóki
 *    ktoś jest wyparty, to on wykonuje następny ruch. `runBidding`
 *    prowadzi tę pętlę do końca, pytając strategię graczy o decyzje.
 *
 * GWARANCJA ZAKOŃCZENIA
 *  Każde przebicie podnosi ofertę na którymś bogu o co najmniej 1 JZ, a
 *  żadna oferta nie przekroczy `maxBid = max(złoto + kapłani)`. Przebić jest
 *  więc najwyżej `bogowie × maxBid`, a każde daje dokładnie jeden ruch
 *  wypartego gracza. Apollo jest zawsze dozwolony, więc wyparty gracz zawsze
 *  ma legalny ruch i pętla nie może się zakleszczyć (zob. `biddingMoveLimit`).
 */

import {
  actionOrderFromTrack,
  createActionsPhase,
  getPlayer,
  transition,
  type BiddableGod,
  type BiddingPhase,
  type BiddingSettlement,
  type DisplacedBidder,
  type GameState,
  type GodSlot,
  type GodTrack,
  type Phase,
  type PhaseHooks,
  type PlayerId,
  type PlayerState,
} from '../model/index.ts';

// ===========================================================================
// Komendy, zdarzenia, odrzucenia
// ===========================================================================

/** Decyzja gracza w licytacji. */
export type BidCommand =
  /** Ofiara dla boga z toru. `amount` to kwota nominalna (przed zniżką od kapłanów). */
  | { readonly type: 'OFFER'; readonly playerId: PlayerId; readonly god: BiddableGod; readonly amount: number }
  /** Wybór Apolla (bez licytacji, 0 JZ). */
  | { readonly type: 'APOLLO'; readonly playerId: PlayerId };

/** Co się wydarzyło po zastosowaniu komendy (dla UI, animacji i logu partii). */
export type BidEvent =
  | {
      readonly type: 'OFFERING_PLACED';
      readonly playerId: PlayerId;
      readonly god: BiddableGod;
      readonly amount: number;
      /** Koszt, który zostanie pobrany przy rozliczeniu, jeśli oferta się utrzyma. */
      readonly cost: number;
    }
  | {
      readonly type: 'PLAYER_DISPLACED';
      readonly playerId: PlayerId;
      readonly by: PlayerId;
      readonly god: BiddableGod;
      /** Kwota oferty, która została przebita. */
      readonly amount: number;
    }
  | {
      readonly type: 'APOLLO_JOINED';
      readonly playerId: PlayerId;
      readonly position: number;
      readonly receivesProsperityMarker: boolean;
    }
  | { readonly type: 'BIDDING_STABLE' };

/** Powód odrzucenia komendy albo operacji silnika. */
export type BidRejection =
  | { readonly code: 'NOT_BIDDING_PHASE'; readonly phase: Phase }
  | { readonly code: 'BIDDING_COMPLETE' }
  | { readonly code: 'NOT_YOUR_TURN'; readonly expected: PlayerId }
  | { readonly code: 'UNKNOWN_PLAYER'; readonly playerId: PlayerId }
  | { readonly code: 'GOD_NOT_AVAILABLE'; readonly god: string }
  | { readonly code: 'FORBIDDEN_GOD'; readonly god: BiddableGod }
  | { readonly code: 'INVALID_AMOUNT'; readonly amount: number }
  | { readonly code: 'OWN_OFFERING'; readonly god: BiddableGod }
  | { readonly code: 'BID_TOO_LOW'; readonly amount: number; readonly minimum: number }
  | { readonly code: 'CANNOT_AFFORD'; readonly cost: number; readonly available: number; readonly maximum: number }
  | { readonly code: 'BIDDING_NOT_STABLE'; readonly waitingFor: PlayerId }
  | { readonly code: 'ALREADY_SETTLED' };

export type BidOutcome =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly BidEvent[] }
  | { readonly ok: false; readonly error: BidRejection };

export type SettleOutcome =
  | { readonly ok: true; readonly state: GameState; readonly settlement: BiddingSettlement }
  | { readonly ok: false; readonly error: BidRejection };

const reject = (error: BidRejection): { readonly ok: false; readonly error: BidRejection } => ({ ok: false, error });

/** Wyjątek dla sterownika `runBidding`, gdy strategia zwróci nielegalny ruch. */
export class BiddingError extends Error {
  readonly rejection: BidRejection;

  constructor(rejection: BidRejection) {
    super(describeRejection(rejection));
    this.name = 'BiddingError';
    this.rejection = rejection;
  }
}

// ===========================================================================
// Koszty
// ===========================================================================

/**
 * Koszt ofiary: kwota nominalna minus liczba kapłanów, ale co najmniej 1 JZ.
 * Przebijanie porównuje zawsze kwoty NOMINALNE, a zniżka dotyczy tylko płatności.
 */
export function offeringCost(amount: number, priests: number): number {
  return Math.max(1, amount - priests);
}

/**
 * Najwyższa kwota nominalna, na którą stać gracza, albo 0, gdy nie stać
 * go na żadnego boga (wtedy zostaje mu tylko Apollo).
 * Z `max(1, kwota - kapłani) <= dostępne` wynika `kwota <= dostępne + kapłani`,
 * o ile gracz ma choć 1 JZ.
 */
export function maxAffordableBid(available: number, priests: number): number {
  return available >= 1 ? available + priests : 0;
}

/** Najniższa dozwolona kwota na danym bogu. */
function minimumBid(slot: GodSlot): number {
  return (slot.offering?.amount ?? 0) + 1;
}

/**
 * JZ, które gracz ma już „zaklepane” na torze. Przy jednym znaczniku ofiary
 * zawsze wynosi 0, bo licytujący gracz nie ma wtedy znacznika na torze.
 * Ma znaczenie w wariancie z kilkoma znacznikami: suma ofiar nie może
 * przekroczyć zawartości portfela.
 */
function committedCost(gods: GodTrack, player: PlayerState): number {
  return gods.slots.reduce(
    (sum, slot) => (slot.offering?.playerId === player.id ? sum + offeringCost(slot.offering.amount, player.priests) : sum),
    0,
  );
}

// ===========================================================================
// Kto licytuje i jakie ma możliwości
// ===========================================================================

export interface CurrentBidder {
  readonly playerId: PlayerId;
  /** `true`, gdy to ruch gracza wypartego (ma pierwszeństwo przed kolejką). */
  readonly displaced: boolean;
  /** Bóg zakazany w tym ruchu, czyli ten, z którego gracza właśnie wyparto. */
  readonly forbiddenGod: BiddableGod | null;
}

/** Gracz, który teraz musi położyć znacznik, albo `null`, gdy tor jest stabilny lub trwa inna faza. */
export function currentBidder(state: GameState): CurrentBidder | null {
  const phase = state.phase;
  if (phase.phase !== 'BIDDING') return null;
  if (phase.displaced !== null) {
    return { playerId: phase.displaced.playerId, displaced: true, forbiddenGod: phase.displaced.forbiddenGod };
  }
  const next = phase.queue[0];
  return next === undefined ? null : { playerId: next, displaced: false, forbiddenGod: null };
}

/** Czy wszystkie znaczniki leżą na torze i nikt nie czeka na ruch. */
export function isBiddingStable(state: GameState): boolean {
  return state.phase.phase === 'BIDDING' && currentBidder(state) === null;
}

/** Bóg, na którego gracz może teraz złożyć ofiarę. */
export interface GodBidOption {
  readonly god: BiddableGod;
  readonly minimum: number;
  readonly maximum: number;
  /** Gracz, który zostanie wyparty (`null`, gdy bóg jest wolny). */
  readonly holder: PlayerId | null;
}

/** Legalne ruchy bieżącego gracza (podpowiedzi w UI, boty, testy). */
export interface LegalBids extends CurrentBidder {
  /** Bogowie z niepustym przedziałem kwot `[minimum, maximum]`. */
  readonly gods: readonly GodBidOption[];
  /** Apollo jest zawsze dozwolony, więc gracz nigdy nie zostaje bez ruchu. */
  readonly apollo: true;
}

export function legalBids(state: GameState): LegalBids | null {
  const bidder = currentBidder(state);
  if (bidder === null) return null;
  const player = getPlayer(state, bidder.playerId);
  const maximum = maxAffordableBid(player.gold - committedCost(state.gods, player), player.priests);
  const gods = state.gods.slots.flatMap((slot): GodBidOption[] => {
    if (slot.god === bidder.forbiddenGod || slot.offering?.playerId === player.id) return [];
    const minimum = minimumBid(slot);
    return minimum <= maximum ? [{ god: slot.god, minimum, maximum, holder: slot.offering?.playerId ?? null }] : [];
  });
  return { ...bidder, gods, apollo: true };
}

// ===========================================================================
// Pojedynczy ruch licytacji
// ===========================================================================

/**
 * Stosuje jedną decyzję gracza. Kolejność walidacji jest stała, więc ta sama
 * błędna komenda zawsze daje ten sam kod błędu:
 * faza, koniec licytacji, kolejka, gracz, a dla ofiary kolejno: bóg na torze,
 * zakaz powrotu, poprawność kwoty, własna oferta, przebicie, portfel.
 */
export function applyBid(state: GameState, command: BidCommand): BidOutcome {
  const phase = state.phase;
  if (phase.phase !== 'BIDDING') return reject({ code: 'NOT_BIDDING_PHASE', phase: phase.phase });
  const bidder = currentBidder(state);
  if (bidder === null) return reject({ code: 'BIDDING_COMPLETE' });
  if (command.playerId !== bidder.playerId) return reject({ code: 'NOT_YOUR_TURN', expected: bidder.playerId });
  const player = state.players[command.playerId];
  if (!player) return reject({ code: 'UNKNOWN_PLAYER', playerId: command.playerId });

  // Znacznik schodzi z kolejki albo z „ręki” wypartego gracza.
  const queue = bidder.displaced ? phase.queue : phase.queue.slice(1);

  if (command.type === 'APOLLO') {
    const apolloSupplicants = [...state.gods.apolloSupplicants, player.id];
    const position = apolloSupplicants.length;
    return commit(state, phase, { ...state.gods, apolloSupplicants }, queue, null, [
      { type: 'APOLLO_JOINED', playerId: player.id, position, receivesProsperityMarker: position === 1 },
    ]);
  }

  const slotIndex = state.gods.slots.findIndex((slot) => slot.god === command.god);
  const slot = state.gods.slots[slotIndex];
  if (!slot) return reject({ code: 'GOD_NOT_AVAILABLE', god: command.god });
  if (command.god === bidder.forbiddenGod) return reject({ code: 'FORBIDDEN_GOD', god: command.god });
  if (!Number.isInteger(command.amount) || command.amount < 1) {
    return reject({ code: 'INVALID_AMOUNT', amount: command.amount });
  }
  if (slot.offering?.playerId === player.id) return reject({ code: 'OWN_OFFERING', god: command.god });
  const minimum = minimumBid(slot);
  if (command.amount < minimum) return reject({ code: 'BID_TOO_LOW', amount: command.amount, minimum });
  const available = player.gold - committedCost(state.gods, player);
  const cost = offeringCost(command.amount, player.priests);
  if (cost > available) {
    return reject({ code: 'CANNOT_AFFORD', cost, available, maximum: maxAffordableBid(available, player.priests) });
  }

  const slots = state.gods.slots.map((s, i) =>
    i === slotIndex ? { ...s, offering: { playerId: player.id, amount: command.amount } } : s,
  );
  const events: BidEvent[] = [{ type: 'OFFERING_PLACED', playerId: player.id, god: command.god, amount: command.amount, cost }];
  let displaced: DisplacedBidder | null = null;
  if (slot.offering !== null) {
    displaced = { playerId: slot.offering.playerId, forbiddenGod: command.god };
    events.push({
      type: 'PLAYER_DISPLACED',
      playerId: slot.offering.playerId,
      by: player.id,
      god: command.god,
      amount: slot.offering.amount,
    });
  }
  return commit(state, phase, { ...state.gods, slots }, queue, displaced, events);
}

function commit(
  state: GameState,
  phase: BiddingPhase,
  gods: GodTrack,
  queue: readonly PlayerId[],
  displaced: DisplacedBidder | null,
  events: BidEvent[],
): BidOutcome {
  if (displaced === null && queue.length === 0) events.push({ type: 'BIDDING_STABLE' });
  return {
    ok: true,
    state: { ...state, revision: state.revision + 1, gods, phase: { ...phase, queue, displaced } },
    events,
  };
}

// ===========================================================================
// Pętla licytacji
// ===========================================================================

/**
 * Górne ograniczenie liczby ruchów do ustabilizowania toru:
 * znaczniki w kolejce + ewentualny wyparty gracz + bogowie × maxBid
 * (dowód w nagłówku pliku).
 */
export function biddingMoveLimit(state: GameState): number {
  const phase = state.phase;
  if (phase.phase !== 'BIDDING') return 0;
  const maxBid = Math.max(
    0,
    ...state.seating.map((id) => {
      const player = getPlayer(state, id);
      return maxAffordableBid(player.gold, player.priests);
    }),
  );
  return phase.queue.length + (phase.displaced ? 1 : 0) + state.gods.slots.length * maxBid;
}

/** Strategia gracza: z bieżącego stanu i legalnych ruchów wybiera komendę. */
export type BidDecider = (state: GameState, legal: LegalBids) => BidCommand;

export interface BiddingRun {
  readonly state: GameState;
  readonly events: readonly BidEvent[];
  readonly moves: number;
}

/**
 * Prowadzi licytację do ustabilizowania toru, pytając `decide` o każdy ruch,
 * także ruchy wypartych graczy w łańcuchu przelicytowań. Służy botom,
 * symulacjom, testom i odtwarzaniu partii. Nielegalny ruch strategii rzuca
 * `BiddingError`, a przekroczenie `biddingMoveLimit` oznacza błąd silnika.
 */
export function runBidding(state: GameState, decide: BidDecider): BiddingRun {
  const limit = biddingMoveLimit(state);
  const events: BidEvent[] = [];
  let current = state;
  for (let moves = 0; ; moves++) {
    const legal = legalBids(current);
    if (legal === null) return { state: current, events, moves };
    if (moves >= limit) throw new Error(`Licytacja nie ustabilizowała się w ${limit} ruchach (błąd silnika)`);
    const outcome = applyBid(current, decide(current, legal));
    if (!outcome.ok) throw new BiddingError(outcome.error);
    current = outcome.state;
    events.push(...outcome.events);
  }
}

// ===========================================================================
// Rozliczenie i zamknięcie licytacji
// ===========================================================================

/**
 * Wylicza rozliczenie bez zmiany stanu. Działa w dowolnym momencie licytacji
 * (UI może pokazać podgląd „ile zapłacisz”), ale wiążące jest dopiero po
 * ustabilizowaniu toru.
 */
export function computeSettlement(state: GameState): BiddingSettlement {
  const payments = state.gods.slots.flatMap((slot) => {
    if (slot.offering === null) return [];
    const player = getPlayer(state, slot.offering.playerId);
    const cost = offeringCost(slot.offering.amount, player.priests);
    return [{ playerId: player.id, god: slot.god, amount: slot.offering.amount, discount: slot.offering.amount - cost, cost }];
  });
  const apollo = state.gods.apolloSupplicants.map((playerId, index) => ({
    playerId,
    position: index + 1,
    receivesProsperityMarker: index === 0,
  }));
  return { payments, apollo, actionOrder: actionOrderFromTrack(state.gods) };
}

/**
 * Zamyka licytację na ustabilizowanym torze: pobiera opłaty i zapisuje
 * rozliczenie w kontekście fazy. Operacja jest jednorazowa, więc powtórne
 * wywołanie zwraca `ALREADY_SETTLED` i nie pobiera opłat drugi raz.
 */
export function settleBidding(state: GameState): SettleOutcome {
  const phase = state.phase;
  if (phase.phase !== 'BIDDING') return reject({ code: 'NOT_BIDDING_PHASE', phase: phase.phase });
  if (phase.settlement !== null) return reject({ code: 'ALREADY_SETTLED' });
  const bidder = currentBidder(state);
  if (bidder !== null) return reject({ code: 'BIDDING_NOT_STABLE', waitingFor: bidder.playerId });

  const settlement = computeSettlement(state);
  let players = state.players;
  for (const payment of settlement.payments) {
    const player = players[payment.playerId] ?? getPlayer(state, payment.playerId);
    if (player.gold < payment.cost) {
      // Nieosiągalne przy ofertach zwalidowanych przez `applyBid`: oznacza uszkodzony stan.
      throw new Error(`Gracz ${player.id} nie ma ${payment.cost} JZ na ofiarę dla ${payment.god}`);
    }
    players = { ...players, [player.id]: { ...player, gold: player.gold - payment.cost } };
  }
  return {
    ok: true,
    settlement,
    state: { ...state, revision: state.revision + 1, players, phase: { ...phase, settlement } },
  };
}

/**
 * Kończy fazę licytacji: rozlicza ją (jeśli jeszcze nie jest rozliczona)
 * i przechodzi do fazy ACTIONS z kolejnością akcji z rozliczenia.
 */
export function closeBidding(state: GameState, hooks?: PhaseHooks): SettleOutcome {
  const phase = state.phase;
  let settled: SettleOutcome;
  if (phase.phase === 'BIDDING' && phase.settlement !== null) {
    settled = { ok: true, state, settlement: phase.settlement };
  } else {
    settled = settleBidding(state);
  }
  if (!settled.ok) return settled;
  return { ...settled, state: transition(settled.state, createActionsPhase(settled.state), hooks) };
}

// ===========================================================================
// Komunikaty
// ===========================================================================

/** Czytelny komunikat dla gracza (kod błędu zostaje do logiki i tłumaczeń). */
export function describeRejection(error: BidRejection): string {
  switch (error.code) {
    case 'NOT_BIDDING_PHASE':
      return `Licytacja trwa tylko w fazie BIDDING (teraz: ${error.phase}).`;
    case 'BIDDING_COMPLETE':
      return 'Licytacja jest zakończona: wszystkie znaczniki leżą na torze.';
    case 'NOT_YOUR_TURN':
      return `Teraz ruch gracza ${error.expected}.`;
    case 'UNKNOWN_PLAYER':
      return `Nieznany gracz ${error.playerId}.`;
    case 'GOD_NOT_AVAILABLE':
      return `Bóg ${error.god} nie jest dostępny w tym cyklu.`;
    case 'FORBIDDEN_GOD':
      return `Właśnie wyparto cię z boga ${error.god}. Wybierz innego boga albo Apolla.`;
    case 'INVALID_AMOUNT':
      return `Ofiara musi być dodatnią liczbą całkowitą (podano: ${error.amount}).`;
    case 'OWN_OFFERING':
      return `Na bogu ${error.god} leży już twoja ofiara.`;
    case 'BID_TOO_LOW':
      return `Ofiara ${error.amount} JZ jest za niska. Minimum to ${error.minimum} JZ.`;
    case 'CANNOT_AFFORD':
      return error.maximum === 0
        ? `Ta ofiara kosztuje ${error.cost} JZ, a masz ${error.available} JZ. Zostaje ci tylko Apollo.`
        : `Ta ofiara kosztuje ${error.cost} JZ, a masz ${error.available} JZ. Najwyższa możliwa ofiara to ${error.maximum} JZ.`;
    case 'BIDDING_NOT_STABLE':
      return `Licytacja jeszcze trwa: ruch gracza ${error.waitingFor}.`;
    case 'ALREADY_SETTLED':
      return 'Licytacja została już rozliczona.';
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}
