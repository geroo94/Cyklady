/**
 * @file Kanały komunikacji i Local Loopback.
 *
 * Dwie warstwy:
 *  - `RawChannel` przenosi zakodowane ramki (tekst albo bajty). Implementują
 *    go pętla w pamięci (`createLoopbackPair`) i WebSocket (`websocket.ts`).
 *  - `MessageChannel` nakłada na kanał surowy kodek (JSON / MessagePack)
 *    i wystawia wiadomości. Serwer i klient znają tylko ten poziom, więc
 *    tryb Single Player i LAN korzystają z tego samego kodu.
 *
 * Loopback też koduje i dekoduje wiadomości: granica serializacji jest ta
 * sama co w sieci, więc błąd „działa lokalnie, a w LAN nie” nie ma skąd się wziąć.
 */

import { JSON_CODEC, type CodecName, type MessageCodec } from './codec.ts';
import type { ClientMessage, ServerMessage } from './protocol.ts';

export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

export interface RawChannel {
  /** Opis drugiej strony (adres sieciowy albo `loopback`). */
  readonly remote: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onData(listener: (data: string | Uint8Array) => void): void;
  onClose(listener: (info: CloseInfo) => void): void;
}

export interface MessageChannel<Out> {
  readonly remote: string;
  readonly codec: CodecName;
  send(message: Out): void;
  close(code?: number, reason?: string): void;
  /** Wiadomość zdekodowana, ale NIEZWALIDOWANA (to robi odbiorca). */
  onMessage(listener: (message: unknown) => void): void;
  /** Ramka, której nie dało się zdekodować (np. uszkodzony JSON). */
  onDecodeError(listener: (error: Error) => void): void;
  onClose(listener: (info: CloseInfo) => void): void;
}

/** Kanał po stronie serwera: wysyła wiadomości serwera. */
export type ServerChannel = MessageChannel<ServerMessage>;
/** Kanał po stronie klienta: wysyła wiadomości klienta. */
export type ClientChannel = MessageChannel<ClientMessage>;

/** Nakłada kodek na kanał surowy. */
export function withCodec<Out>(raw: RawChannel, codec: MessageCodec): MessageChannel<Out> {
  const messageListeners: ((message: unknown) => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  raw.onData((data) => {
    let message: unknown;
    try {
      message = codec.decode(data);
    } catch (error) {
      for (const listener of errorListeners) listener(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const listener of messageListeners) listener(message);
  });
  return {
    remote: raw.remote,
    codec: codec.name,
    send: (message) => raw.send(codec.encode(message)),
    close: (code, reason) => raw.close(code, reason),
    onMessage: (listener) => void messageListeners.push(listener),
    onDecodeError: (listener) => void errorListeners.push(listener),
    onClose: (listener) => raw.onClose(listener),
  };
}

// ===========================================================================
// Local Loopback
// ===========================================================================

class LoopbackEnd implements RawChannel {
  readonly remote = 'loopback';
  peer: LoopbackEnd | null = null;
  #open = true;
  readonly #dataListeners: ((data: string | Uint8Array) => void)[] = [];
  readonly #closeListeners: ((info: CloseInfo) => void)[] = [];

  send(data: string | Uint8Array): void {
    const peer = this.peer;
    if (!this.#open || !peer) return;
    // Kopia bajtów i dostarczenie w mikrozadaniu: zachowanie jak w sieci (brak współdzielonej pamięci, asynchroniczność).
    const payload = typeof data === 'string' ? data : data.slice();
    queueMicrotask(() => peer.deliver(payload));
  }

  deliver(data: string | Uint8Array): void {
    if (!this.#open) return;
    for (const listener of this.#dataListeners) listener(data);
  }

  close(code = 1000, reason = ''): void {
    if (!this.#open) return;
    this.finish({ code, reason });
    this.peer?.finish({ code, reason });
  }

  finish(info: CloseInfo): void {
    if (!this.#open) return;
    this.#open = false;
    queueMicrotask(() => {
      for (const listener of this.#closeListeners) listener(info);
    });
  }

  onData(listener: (data: string | Uint8Array) => void): void {
    this.#dataListeners.push(listener);
  }

  onClose(listener: (info: CloseInfo) => void): void {
    this.#closeListeners.push(listener);
  }
}

/** Para połączonych kanałów w jednym procesie (tryb Single Player, hotseat, gospodarz LAN). */
export function createLoopbackPair(codec: MessageCodec = JSON_CODEC): { client: ClientChannel; server: ServerChannel } {
  const clientEnd = new LoopbackEnd();
  const serverEnd = new LoopbackEnd();
  clientEnd.peer = serverEnd;
  serverEnd.peer = clientEnd;
  return { client: withCodec<ClientMessage>(clientEnd, codec), server: withCodec<ServerMessage>(serverEnd, codec) };
}
