/**
 * @file Generator liczb losowych jako część stanu gry.
 *
 * Stan generatora jest zapisany w `GameState.rng`, a wszystkie funkcje są
 * czyste: zwracają wynik i NOWY stan generatora. Dzięki temu:
 *  - ta sama sekwencja akcji zawsze daje ten sam wynik (powtórki, testy,
 *    odtwarzanie błędów),
 *  - serwer może odbudować partię z samego logu akcji,
 *  - klient nie może „przelosować” rzutu, bo losuje wyłącznie serwer.
 *
 * Dwa algorytmy:
 *  - `chacha20`: generator kryptograficzny (strumień ChaCha20, RFC 8439)
 *    z tajnym 256-bitowym kluczem. Serwer używa go w partiach sieciowych:
 *    klucz nigdy nie opuszcza serwera, więc nawet klient, który widział
 *    wszystkie dotychczasowe rzuty, nie przewidzi następnych ani kolejności
 *    zakrytych talii.
 *  - `mulberry32`: szybki generator z 32-bitowym stanem, do testów i narzędzi.
 *    Nie nadaje się do gry sieciowej: stan da się odtworzyć z kilkunastu
 *    zaobserwowanych rzutów.
 */

export interface Mulberry32State {
  readonly algorithm: 'mulberry32';
  /** 32-bitowy stan bez znaku. */
  readonly state: number;
}

export interface ChaCha20State {
  readonly algorithm: 'chacha20';
  /** Tajny klucz: 32 bajty zapisane szesnastkowo (64 znaki). */
  readonly key: string;
  /** Pozycja w strumieniu: numer następnego 32-bitowego słowa. */
  readonly counter: number;
}

export type RngState = Mulberry32State | ChaCha20State;

/** Tworzy generator testowy z dowolnego tekstu (np. ID partii) haszem FNV-1a. */
export function seedRng(seed: string): RngState {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return { algorithm: 'mulberry32', state: hash >>> 0 };
}

/**
 * Bezpieczny generator partii: ChaCha20 z kluczem z systemowego źródła
 * entropii (Web Crypto, dostępne w Node i w przeglądarkach). Ten sam klucz
 * daje tę samą sekwencję, co pozwala odtworzyć partię po jej zakończeniu.
 */
export function createSecureRng(key: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(32))): ChaCha20State {
  if (key.length !== 32) throw new RangeError(`Klucz ChaCha20 musi mieć 32 bajty, a ma ${key.length}`);
  return { algorithm: 'chacha20', key: Array.from(key, (byte) => byte.toString(16).padStart(2, '0')).join(''), counter: 0 };
}

/** Następna 32-bitowa liczba bez znaku. */
export function nextUint32(rng: RngState): [value: number, rng: RngState] {
  if (rng.algorithm === 'chacha20') {
    const words = chachaBlock(rng.key, Math.floor(rng.counter / 16));
    return [words[rng.counter % 16] ?? 0, { ...rng, counter: rng.counter + 1 }];
  }
  const state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [(t ^ (t >>> 14)) >>> 0, { algorithm: 'mulberry32', state }];
}

const UINT32_RANGE = 0x1_0000_0000;

/** Liczba całkowita z przedziału [0, maxExclusive). */
export function nextInt(rng: RngState, maxExclusive: number): [value: number, rng: RngState] {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
    throw new RangeError(`nextInt: oczekiwano liczby całkowitej od 1 do 2^32, otrzymano ${maxExclusive}`);
  }
  if (rng.algorithm === 'mulberry32') {
    const [value, next] = nextUint32(rng);
    return [Math.floor((value / UINT32_RANGE) * maxExclusive), next];
  }
  // Bez obciążenia: słowa z końcówki zakresu, która nie dzieli się przez
  // `maxExclusive`, są odrzucane, więc każdy wynik ma tę samą szansę.
  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  let current: RngState = rng;
  for (;;) {
    const [value, next] = nextUint32(current);
    current = next;
    if (value < limit) return [value % maxExclusive, current];
  }
}

/** Rzut kością o podanych ściankach (każda równie prawdopodobna). */
export function rollDie(rng: RngState, faces: readonly number[]): [value: number, rng: RngState] {
  if (faces.length === 0) throw new RangeError('Kość musi mieć co najmniej jedną ściankę');
  const [index, next] = nextInt(rng, faces.length);
  return [faces[index] as number, next];
}

/** Tasowanie Fishera-Yatesa. Nie modyfikuje wejścia. */
export function shuffle<T>(items: readonly T[], rng: RngState): [shuffled: T[], rng: RngState] {
  const result = [...items];
  let current = rng;
  for (let i = result.length - 1; i > 0; i--) {
    const [j, next] = nextInt(current, i + 1);
    current = next;
    const tmp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = tmp;
  }
  return [result, current];
}

// ===========================================================================
// ChaCha20 (RFC 8439): blok strumienia klucza
// ===========================================================================

type Quad = [number, number, number, number];
/** Stan bloku ChaCha20: 16 słów 32-bitowych. */
type Block = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

const rotl = (value: number, bits: number): number => ((value << bits) | (value >>> (32 - bits))) >>> 0;

function quarterRound(a: number, b: number, c: number, d: number): Quad {
  a = (a + b) >>> 0;
  d = rotl(d ^ a, 16);
  c = (c + d) >>> 0;
  b = rotl(b ^ c, 12);
  a = (a + b) >>> 0;
  d = rotl(d ^ a, 8);
  c = (c + d) >>> 0;
  b = rotl(b ^ c, 7);
  return [a, b, c, d];
}

/** Klucz jako 8 słów little-endian. */
function keyWords(hex: string): number[] {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Uszkodzony klucz generatora ChaCha20');
  return Array.from({ length: 8 }, (_, word) => {
    const byte = (i: number): number => parseInt(hex.slice((word * 4 + i) * 2, (word * 4 + i) * 2 + 2), 16);
    return (byte(0) | (byte(1) << 8) | (byte(2) << 16) | (byte(3) << 24)) >>> 0;
  });
}

/** Ostatnio policzony blok. Blok daje 16 kolejnych słów, więc zwykle wystarcza pamięć podręczna. */
let lastBlock: { readonly key: string; readonly index: number; readonly words: readonly number[] } | null = null;

/**
 * Blok numer `index` strumienia ChaCha20 (16 słów). Licznik bloku zajmuje
 * słowo 12, a jego starsze bity słowo 13 (początek nonce'a). Dla bloków
 * poniżej 2^32 to dokładnie ChaCha20 z RFC 8439 z nonce'em równym zeru.
 */
function chachaBlock(key: string, index: number): readonly number[] {
  if (lastBlock?.key === key && lastBlock.index === index) return lastBlock.words;
  const constants = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
  const input = [...constants, ...keyWords(key), index >>> 0, Math.floor(index / UINT32_RANGE) >>> 0, 0, 0] as Block;
  let [x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15] = input;
  // 20 rund ChaCha20 = 10 podwójnych rund: kolumny, potem przekątne.
  for (let round = 0; round < 10; round++) {
    [x0, x4, x8, x12] = quarterRound(x0, x4, x8, x12);
    [x1, x5, x9, x13] = quarterRound(x1, x5, x9, x13);
    [x2, x6, x10, x14] = quarterRound(x2, x6, x10, x14);
    [x3, x7, x11, x15] = quarterRound(x3, x7, x11, x15);
    [x0, x5, x10, x15] = quarterRound(x0, x5, x10, x15);
    [x1, x6, x11, x12] = quarterRound(x1, x6, x11, x12);
    [x2, x7, x8, x13] = quarterRound(x2, x7, x8, x13);
    [x3, x4, x9, x14] = quarterRound(x3, x4, x9, x14);
  }
  const mixed = [x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15];
  const words = mixed.map((word, i) => (word + (input[i] ?? 0)) >>> 0);
  lastBlock = { key, index, words };
  return words;
}
