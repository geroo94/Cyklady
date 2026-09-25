/**
 * @file Interfejs modułu dodatku: zdarzenia cyklu gry, na które dodatek reaguje.
 *
 * Dodatek to obiekt z nazwą, warunkiem włączenia i zestawem opcjonalnych
 * funkcji obsługi zdarzeń. Każda funkcja jest czysta: dostaje stan i zwraca
 * nowy stan. Rejestr (`registry.ts`) wywołuje funkcje włączonych dodatków
 * w stałej kolejności, a `cycle.ts` wpina je w haki maszyny stanów.
 *
 *   zdarzenie          kiedy                                    przykład
 *   ─────────────────  ───────────────────────────────────────  ──────────────────────────────
 *   gameStart          wyjście z INIT (początek gry)            rozdanie kart Monumentów
 *   godsRevealed       GODS_SETUP, po odkryciu bogów            rzut na Kolumnę Hadesa
 *   incomeCollected    INCOME, po wypłacie dochodu              opróżnienie Nekropolii
 *   cycleEnd           wejście do END_OF_CYCLE                  znikanie nieumarłych
 *   unitsDestroyed     zniszczenie zwykłych jednostek           zbieranie JZ na Nekropoliach
 *   stateBased         po każdej komendzie i zmianie fazy       automatyczne stawianie Monumentów
 */

import type { GameState, NodeId, PlayerId } from '../../model/index.ts';

/** Zniszczenie zwykłych (nie nieumarłych) jednostek na planszy. */
export interface UnitsDestroyedEvent {
  readonly playerId: PlayerId;
  readonly kind: 'TROOP' | 'FLEET';
  readonly count: number;
  readonly where: NodeId;
}

export type CycleEventHandler = (state: GameState) => GameState;

export interface ExpansionEvents {
  readonly gameStart?: CycleEventHandler;
  readonly godsRevealed?: CycleEventHandler;
  readonly incomeCollected?: CycleEventHandler;
  readonly cycleEnd?: CycleEventHandler;
  readonly unitsDestroyed?: (state: GameState, event: UnitsDestroyedEvent) => GameState;
  /**
   * Efekty stanowe, czyli reguły „gdy spełniony jest warunek, stanie się X”,
   * sprawdzane po każdej komendzie. Muszą być idempotentne: drugie wywołanie
   * na tym samym stanie niczego nie zmienia.
   */
  readonly stateBased?: CycleEventHandler;
}

export type CycleEventName = Exclude<keyof ExpansionEvents, 'unitsDestroyed'>;

export interface ExpansionModule {
  readonly name: string;
  readonly isEnabled: (state: GameState) => boolean;
  readonly events: ExpansionEvents;
}
