/**
 * @file Pomocniki testów sieciowych: dziennik wiadomości w kolejności
 * przyjścia (wspólny dla wszystkich klientów), stały klucz generatora
 * i odczyt odrzuceń.
 */

import assert from 'node:assert/strict';

import { ActionRejectedError, type ClientChannel, type RoomConfig, type SeatKind, type ServerMessage } from '../src/net/index.ts';
import { createSecureRng, type PlayerId, type RngState } from '../src/model/index.ts';
import { P1, P2, P3 } from '../src/examples/sampleGame.ts';

/** Oczekiwanie, aż wszystkie mikrozadania pętli w pamięci (Loopback) się wykonają. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Stały klucz ChaCha20: rzuty w testach są powtarzalne, a generator jest ten sam co w grze. */
export const FIXED_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const fixedRng = (): RngState => createSecureRng(FIXED_KEY);
export const FIXED_KEY_HEX = Buffer.from(FIXED_KEY).toString('hex');

export function seats(...kinds: readonly SeatKind[]): RoomConfig['seats'] {
  const colors = ['BLUE', 'RED', 'GREEN'] as const;
  return kinds.map((kind, i) => ({ playerId: [P1, P2, P3][i] as PlayerId, color: colors[i] ?? 'BLUE', kind }));
}

/** Wiadomość serwera odebrana przez klienta `who`. */
export interface Delivery {
  readonly who: string;
  readonly message: ServerMessage;
}

/** Kanał klienta, który zapisuje każdą wiadomość serwera we wspólnym dzienniku (przed obsługą przez klienta). */
export function recorded(channel: ClientChannel, who: string, log: Delivery[]): ClientChannel {
  channel.onMessage((message) => log.push({ who, message: message as ServerMessage }));
  return channel;
}

/** Wiadomości danego typu z dziennika (opcjonalnie tylko jednego odbiorcy). */
export function ofType<T extends ServerMessage['type']>(log: readonly Delivery[], type: T, who?: string): Extract<ServerMessage, { type: T }>[] {
  return log
    .filter((delivery) => delivery.message.type === type && (who === undefined || delivery.who === who))
    .map((delivery) => delivery.message as Extract<ServerMessage, { type: T }>);
}

export async function rejected(promise: Promise<unknown>): Promise<ActionRejectedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ActionRejectedError) return error;
    throw error;
  }
  return assert.fail('komenda powinna zostać odrzucona');
}
