/**
 * @file Automatyczny powrót do partii po zerwaniu połączenia (strona klienta).
 *
 *   połączenie zerwane ─► przerwa ─► connect() ─► client.reconnect() ─► ROOM_STATE + FULL + TURN_UPDATE
 *          ▲                                │ błąd sieci
 *          └──── dłuższa przerwa ◄──────────┘ (do `giveUpAfterMs`, domyślnie 60 s jak okno na serwerze)
 *
 * Nie wraca po zamknięciu z kodem 1000 (gracz sam wyszedł) ani 4000 (to
 * miejsce przejęło nowsze połączenie), bo dwa klienty odbijałyby sobie
 * wtedy miejsce w nieskończoność. Poddaje się od razu, gdy serwer odrzuci
 * powrót (`RECONNECT_EXPIRED`, `INVALID_SEAT_TOKEN`).
 */

import { ActionRejectedError, type GameClient } from './client.ts';
import type { RoomState } from './protocol.ts';
import type { ClientChannel } from './transport.ts';

export interface AutoReconnectOptions {
  /** Pierwsza przerwa przed ponownym połączeniem (domyślnie 500 ms), potem podwajana. */
  readonly initialDelayMs?: number;
  /** Najdłuższa przerwa między próbami (domyślnie 5 s). */
  readonly maxDelayMs?: number;
  /** Po tylu ms od zerwania klient się poddaje (domyślnie 60 s). */
  readonly giveUpAfterMs?: number;
  readonly onAttempt?: (attempt: number) => void;
  readonly onReconnected?: (room: RoomState) => void;
  readonly onGiveUp?: (error: Error) => void;
}

/** Kody zamknięcia, po których klient nie wraca sam. */
const INTENTIONAL_CLOSE = new Set([1000, 4000]);
/** Odmowy, po których ponawianie nie ma sensu. */
const FINAL_REJECTIONS = new Set(['RECONNECT_EXPIRED', 'INVALID_SEAT_TOKEN']);

/**
 * Pilnuje połączenia klienta: po zerwaniu łączy się ponownie funkcją
 * `connect` (np. `() => connectWebSocket(url)`) i wraca na swoje miejsce.
 * Zwraca funkcję, która wyłącza pilnowanie.
 */
export function autoReconnect(client: GameClient, connect: () => Promise<ClientChannel>, options: AutoReconnectOptions = {}): () => void {
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const giveUpAfterMs = options.giveUpAfterMs ?? 60_000;
  let stopped = false;

  const giveUp = (error: Error): void => {
    stopped = true;
    options.onGiveUp?.(error);
  };

  async function retry(): Promise<void> {
    const started = Date.now();
    let delay = initialDelayMs;
    for (let attempt = 1; !stopped; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (stopped) return;
      options.onAttempt?.(attempt);
      try {
        const room = await client.reconnect(await connect());
        options.onReconnected?.(room);
        return;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (error instanceof ActionRejectedError && FINAL_REJECTIONS.has(error.code)) return giveUp(failure);
        if (Date.now() - started + delay > giveUpAfterMs) return giveUp(failure);
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }
  }

  const unsubscribe = client.on('disconnected', (info) => {
    if (!stopped && !INTENTIONAL_CLOSE.has(info.code)) void retry();
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}
