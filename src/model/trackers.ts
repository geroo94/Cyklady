/**
 * @file Tory i talie: kolejność, licytacja bogów, stwory i herosi,
 * Kolumna Hadesa, pula Monumentów.
 *
 * Oprócz typów plik zawiera kilka małych, czystych funkcji, które należą
 * do mechaniki samego toru (odświeżenie toru stworów, ruch na Kolumnie
 * Hadesa). Nie mają one efektów ubocznych i nie znają reszty stanu gry.
 */

import type { BiddableGod } from './domain.ts';
import type { CardId, IslandId, MonumentCardId, MonumentKind, PlayerId } from './ids.ts';
import type { HadesRules } from './rules.ts';
import { shuffle, type RngState } from './rng.ts';

// ===========================================================================
// Tor Kolejności
// ===========================================================================

export interface TurnOrderTrack {
  /** Kolejność licytacji w bieżącym cyklu (indeks 0 licytuje pierwszy). */
  readonly current: readonly PlayerId[];
  /**
   * Kolejność na NASTĘPNY cykl, budowana w fazie ACTIONS. Gracz trafia na
   * koniec listy, gdy kończy turę swojego boga. Lista zostaje zatwierdzona
   * (`current = next`) przy przejściu END_OF_CYCLE -> CREATURES_REFRESH.
   */
  readonly next: readonly PlayerId[];
}

// ===========================================================================
// Tor Licytacji Bogów
// ===========================================================================

/** Oferta, czyli znacznik ofiary gracza leżący na polu boga. */
export interface Offering {
  readonly playerId: PlayerId;
  /** Zadeklarowana kwota w JZ, przed zniżką od kapłanów. */
  readonly amount: number;
}

/** Pole licytowanego boga. Leży na nim najwyżej jedna (najwyższa) oferta. */
export interface GodSlot {
  readonly god: BiddableGod;
  readonly offering: Offering | null;
}

/**
 * Tor bogów w bieżącym cyklu. To jedyne źródło prawdy o ofertach:
 * „pozycję w licytacji” gracza wylicza z niego `getPlayerView`.
 */
export interface GodTrack {
  /** Odkryci bogowie w kolejności działania w fazie ACTIONS (indeks 0 = góra toru). */
  readonly slots: readonly GodSlot[];
  /**
   * Gracze, którzy wybrali Apolla, w kolejności przybycia. Kolejność ma
   * znaczenie, bo pierwszy dostaje premię. Apollo zawsze działa jako ostatni.
   */
  readonly apolloSupplicants: readonly PlayerId[];
  /** Bogowie odłożeni w tym cyklu (za mało graczy lub nieprzywołany Hades). */
  readonly unavailable: readonly BiddableGod[];
}

// ===========================================================================
// Tor i Talia Mitologicznych Stworów oraz Herosów
// ===========================================================================

export type CreatureSlotCost = 2 | 3 | 4;

/** Pole toru z bazowym kosztem. Faktyczną cenę (np. po zniżkach) liczy silnik. */
export interface CreatureMarketSlot<C extends CreatureSlotCost = CreatureSlotCost> {
  readonly cost: C;
  /** `null` oznacza puste pole (karta kupiona w tym cyklu albo brak kart w talii). */
  readonly card: CardId | null;
}

/**
 * Tor stworów i herosów z trzema widocznymi kartami.
 *
 * Karty „spływają” w stronę tańszych pól, a nowe wchodzą zawsze od strony
 * najdroższego pola. W efekcie nowsza karta nigdy nie jest tańsza od starszej
 * (zob. `refreshCreatureMarket`).
 */
export interface CreatureMarket {
  /** Indeks 0: 2 JZ (najstarsza), 1: 3 JZ, 2: 4 JZ (najnowsza). */
  readonly slots: readonly [CreatureMarketSlot<2>, CreatureMarketSlot<3>, CreatureMarketSlot<4>];
  /**
   * Zakryta talia, indeks 0 to wierzch. To informacja ukryta: projekcja stanu
   * dla klienta powinna zawierać tylko liczbę kart.
   */
  readonly deck: readonly CardId[];
  /** Stos odrzuconych, ostatni element to wierzch. */
  readonly discard: readonly CardId[];
}

/** Wynik odświeżenia toru (trafia do kontekstu fazy CREATURES_REFRESH). */
export interface CreatureMarketRefresh {
  readonly market: CreatureMarket;
  readonly rng: RngState;
  /** Karta zrzucona z pola za 2 JZ (albo `null`, jeśli pole było puste). */
  readonly discarded: CardId | null;
  /** Karty dobrane z talii, w kolejności dobierania. */
  readonly drawn: readonly CardId[];
  /** Czy przetasowano stos odrzuconych, bo skończyła się talia. */
  readonly reshuffled: boolean;
}

/** Tworzy pusty tor z podaną talią. */
export function createCreatureMarket(deck: readonly CardId[]): CreatureMarket {
  return {
    slots: [
      { cost: 2, card: null },
      { cost: 3, card: null },
      { cost: 4, card: null },
    ],
    deck,
    discard: [],
  };
}

/**
 * Odświeżenie toru na początku cyklu (faza CREATURES_REFRESH).
 *
 * 1. Karta z pola za 2 JZ trafia na stos odrzuconych.
 * 2. Pozostałe karty zsuwają się w stronę tańszych pól, wypełniając luki
 *    po kartach kupionych w poprzednim cyklu. Ich kolejność się nie zmienia.
 * 3. Wolne pola od strony 4 JZ uzupełnia się z wierzchu talii. Gdy talia się
 *    skończy, stos odrzuconych zostaje przetasowany i staje się nową talią.
 *    Gdy nie ma już żadnych kart, pole zostaje puste.
 *
 * Każda karta pozostaje w dokładnie jednej strefie (talia, pole, stos).
 * [zweryfikuj] ruch kart na torze w wersji wydanej przez wydawcę
 */
export function refreshCreatureMarket(market: CreatureMarket, rng: RngState): CreatureMarketRefresh {
  const [cheap, middle, expensive] = market.slots;
  const discarded = cheap.card;
  let discard: CardId[] = discarded === null ? [...market.discard] : [...market.discard, discarded];
  let deck: CardId[] = [...market.deck];
  let currentRng = rng;
  let reshuffled = false;
  const drawn: CardId[] = [];

  // Zsunięcie: ocalałe karty zajmują najtańsze pola, zachowując kolejność.
  const filled: (CardId | null)[] = [middle.card, expensive.card].filter((card) => card !== null);

  // Dobranie: wolne pola od strony 4 JZ.
  while (filled.length < market.slots.length) {
    if (deck.length === 0 && discard.length > 0) {
      [deck, currentRng] = shuffle(discard, currentRng);
      discard = [];
      reshuffled = true;
    }
    const top = deck.shift() ?? null;
    if (top !== null) drawn.push(top);
    filled.push(top);
  }

  return {
    market: {
      slots: [
        { cost: 2, card: filled[0] ?? null },
        { cost: 3, card: filled[1] ?? null },
        { cost: 4, card: filled[2] ?? null },
      ],
      deck,
      discard,
    },
    rng: currentRng,
    discarded,
    drawn,
    reshuffled,
  };
}

// ===========================================================================
// Tor Zagrożenia Hadesa (Kolumna Hadesa 0-9)
// ===========================================================================

/** Poziom na Kolumnie Hadesa. */
export type HadesLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export const HADES_LEVEL_MIN: HadesLevel = 0;
export const HADES_LEVEL_MAX: HadesLevel = 9;

/** Zamienia dowolną liczbę na poprawny poziom (zaokrąglenie w dół i przycięcie do 0-9). */
export function toHadesLevel(value: number): HadesLevel {
  const clamped = Math.min(HADES_LEVEL_MAX, Math.max(HADES_LEVEL_MIN, Math.floor(value)));
  return clamped as HadesLevel;
}

export interface HadesThreatTrack {
  readonly level: HadesLevel;
  /**
   * Ustawiane, gdy kolumna osiągnie `rules.hades.summonLevel`. Skutek jest
   * odroczony: flagę konsumuje faza GODS_SETUP najbliższego cyklu, dodając
   * Hadesa do odkrytych bogów (zob. `consumeHadesSummon`).
   */
  readonly summonPending: boolean;
}

/** Wspólna, neutralna pula figurek nieumarłych. */
export interface UndeadSupply {
  readonly troops: number;
  readonly fleets: number;
}

/** Stan dodatku Hades. */
export interface HadesState {
  readonly threat: HadesThreatTrack;
  readonly undeadSupply: UndeadSupply;
  /**
   * JZ zebrane na Nekropoliach, według wyspy (na wyspie stoi najwyżej jedna
   * Nekropolia). Pula należy do budynku, więc przy zdobyciu wyspy przechodzi
   * na nowego właściciela. Wypłata następuje w fazie INCOME.
   */
  readonly necropolisGold: Readonly<Record<IslandId, number>>;
  /** Oczka z ostatniego rzutu na Kolumnę Hadesa (UI, log), `null` przed pierwszym rzutem. */
  readonly lastThreatRoll: readonly number[] | null;
}

/**
 * Przesuwa znacznik na Kolumnie Hadesa o `steps` pól (wartość ujemna cofa).
 * Poziom jest przycinany do zakresu 0-9. Raz ustawiona flaga przywołania
 * pozostaje do fazy GODS_SETUP, nawet jeśli poziom potem spadnie.
 */
export function advanceHadesThreat(
  track: HadesThreatTrack,
  steps: number,
  rules: HadesRules,
): HadesThreatTrack {
  const level = toHadesLevel(track.level + steps);
  return {
    level,
    summonPending: track.summonPending || level >= rules.summonLevel,
  };
}

/** Konsumuje flagę przywołania (faza GODS_SETUP). Zwraca nowy tor i informację, czy Hades przybywa. */
export function consumeHadesSummon(
  track: HadesThreatTrack,
  rules: HadesRules,
): { readonly track: HadesThreatTrack; readonly summoned: boolean } {
  if (!track.summonPending) return { track, summoned: false };
  return { track: { level: rules.levelAfterSummon, summonPending: false }, summoned: true };
}

// ===========================================================================
// Pula Monumentów
// ===========================================================================

/**
 * Pula Monumentów (dodatek Monumenty): karty i figurki.
 * Zbudowany Monument znika z puli i trafia do `IslandNode.monumentSlot`
 * razem z kartą i rodzajem figurki.
 */
export interface MonumentPool {
  /** Zakryte karty, indeks 0 to wierzch. */
  readonly deck: readonly MonumentCardId[];
  /** Odkryte karty dostępne do budowy. */
  readonly offer: readonly MonumentCardId[];
  readonly discard: readonly MonumentCardId[];
  /** Karty rozdane graczom na początku gry, jeszcze niezbudowane (strefa). */
  readonly dealt: Readonly<Record<PlayerId, readonly MonumentCardId[]>>;
  /** Niepostawione figurki według rodzaju. */
  readonly figureSupply: Readonly<Record<MonumentKind, number>>;
}
