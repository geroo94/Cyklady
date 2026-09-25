/**
 * @file Zegar i planista zadań serwera: limity czasu tur i okno na powrót gracza.
 *
 * Pokój nie woła bezpośrednio `setTimeout` ani `Date.now`, tylko korzysta
 * z interfejsu `Scheduler`. Na serwerze to zegar systemowy, a w testach
 * `ManualScheduler`, w którym czas płynie wyłącznie na polecenie testu.
 * Dzięki temu scenariusz „gracz nie wraca przez 60 s” trwa milisekundy
 * i zawsze przebiega tak samo.
 */

export interface Scheduler {
  /** Bieżący czas w ms od epoki (jak `Date.now()`). */
  now(): number;
  /** Wywołuje `callback` po `delayMs`. Zwraca funkcję, która anuluje zadanie. */
  schedule(delayMs: number, callback: () => void): () => void;
}

/** Zegar systemowy. Zaplanowane zadania nie podtrzymują procesu przy życiu (`unref`). */
export const SYSTEM_SCHEDULER: Scheduler = {
  now: () => Date.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

interface ScheduledTask {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

/** Zegar testowy: czas stoi, dopóki test nie wywoła `advance`. */
export class ManualScheduler implements Scheduler {
  #now: number;
  #nextId = 0;
  readonly #tasks = new Map<number, ScheduledTask>();

  constructor(start = Date.UTC(2026, 0, 1)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const id = this.#nextId++;
    this.#tasks.set(id, { id, at: this.#now + Math.max(0, delayMs), callback });
    return () => void this.#tasks.delete(id);
  }

  /** Liczba zadań czekających na wykonanie. */
  get pending(): number {
    return this.#tasks.size;
  }

  /**
   * Przesuwa czas o `ms` i wykonuje po kolei zadania z minionym terminem,
   * także te zaplanowane w trakcie (np. nowy limit tury po ruchu pasywnym).
   */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let next: ScheduledTask | null = null;
      for (const task of this.#tasks.values()) {
        if (task.at <= target && (next === null || task.at < next.at)) next = task;
      }
      if (next === null) break;
      this.#tasks.delete(next.id);
      this.#now = next.at;
      next.callback();
    }
    this.#now = target;
  }
}
