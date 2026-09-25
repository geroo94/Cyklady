import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { describe, test } from 'node:test';

import { DEFAULT_RULESET, createSecureRng, nextInt, nextUint32, rollDie, shuffle, type RngState } from '../src/model/index.ts';
import { createSampleGame } from '../src/examples/sampleGame.ts';
import { deepFreeze } from './helpers.ts';

// ===========================================================================
// Pomocniki
// ===========================================================================

/** Kolejne 32-bitowe słowa generatora. */
function words(rng: RngState, count: number): number[] {
  const result: number[] = [];
  let current = rng;
  for (let i = 0; i < count; i++) {
    const [value, next] = nextUint32(current);
    result.push(value);
    current = next;
  }
  return result;
}

/** Strumień klucza ChaCha20 z OpenSSL (licznik bloku 0, nonce 0) jako słowa little-endian. */
function opensslWords(key: Uint8Array, count: number): number[] {
  const stream = createCipheriv('chacha20', key, Buffer.alloc(16)).update(Buffer.alloc(count * 4));
  return Array.from({ length: count }, (_, i) => stream.readUInt32LE(i * 4));
}

const keyOf = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

// ===========================================================================
describe('Bezpieczny generator ChaCha20', () => {
  test('wektory testowe RFC 8439 (A.1, klucz i nonce zerowe, bloki 0 i 1)', () => {
    const stream = words(createSecureRng(new Uint8Array(32)), 32);
    assert.deepEqual(stream.slice(0, 4), [0xade0b876, 0x903df1a0, 0xe56a5d40, 0x28bd8653]);
    assert.deepEqual(stream.slice(16, 18), [0xbee7079f, 0x7a385155]);
  });

  test('strumień zgodny z OpenSSL dla różnych kluczy, także na granicach bloków', () => {
    for (const key of [keyOf(0x00), keyOf(0xff), Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3)]) {
      assert.deepEqual(words(createSecureRng(key), 16 * 4 + 5), opensslWords(key, 16 * 4 + 5));
    }
  });

  test('ten sam klucz daje tę samą sekwencję, a nowy generator dostaje losowy 256-bitowy klucz', () => {
    assert.deepEqual(words(createSecureRng(keyOf(7)), 40), words(createSecureRng(keyOf(7)), 40));
    assert.notDeepEqual(words(createSecureRng(keyOf(7)), 8), words(createSecureRng(keyOf(8)), 8));
    const [a, b] = [createSecureRng(), createSecureRng()];
    assert.match(a.key, /^[0-9a-f]{64}$/);
    assert.notEqual(a.key, b.key, 'każda partia ma własny klucz');
    assert.throws(() => createSecureRng(new Uint8Array(16)), /32 bajty/);
  });

  test('funkcje są czyste: stan wejściowy się nie zmienia, a licznik przesuwa się o jedno słowo', () => {
    const rng = deepFreeze(createSecureRng(keyOf(1)));
    const [first, next] = nextUint32(rng);
    assert.equal(nextUint32(rng)[0], first, 'ten sam stan, ten sam wynik');
    assert.deepEqual(next, { ...rng, counter: 1 });
  });

  test('kość bitewna jest równomierna (60 000 rzutów)', () => {
    let rng: RngState = createSecureRng(keyOf(42));
    const faces = DEFAULT_RULESET.combat.dieFaces;
    const counts = [0, 0, 0, 0];
    const throws = 60_000;
    for (let i = 0; i < throws; i++) {
      const [value, next] = rollDie(rng, faces);
      rng = next;
      counts[value] = (counts[value] ?? 0) + 1;
    }
    for (const [value, expected] of [[0, 1 / 6], [1, 2 / 6], [2, 2 / 6], [3, 1 / 6]] as const) {
      const frequency = (counts[value] ?? 0) / throws;
      assert.ok(Math.abs(frequency - expected) < 0.01, `ścianka ${value}: ${frequency.toFixed(4)} zamiast ${expected.toFixed(4)}`);
    }
  });

  test('losowanie z przedziału odrzuca końcówkę zakresu, więc nie ma przechyłu modulo', () => {
    // 2^32 nie dzieli się przez 3·2^30: słowa z górnej ćwiartki są odrzucane, a pozostałe biorą udział bez zmian.
    const max = 3 * 2 ** 30;
    const accepted = words(createSecureRng(keyOf(3)), 2_000).filter((word) => word < max);
    let rng: RngState = createSecureRng(keyOf(3));
    for (let i = 0; i < 500; i++) {
      const [value, next] = nextInt(rng, max);
      rng = next;
      assert.equal(value, accepted[i], `losowanie ${i}`);
    }
    assert.ok(rng.algorithm === 'chacha20' && rng.counter > 550, 'odrzucone słowa przesuwają strumień');
    assert.throws(() => nextInt(rng, 2 ** 32 + 1), RangeError);
  });

  test('partia z generatorem ChaCha20: talie tasuje klucz, a nie jawne ziarno', () => {
    const tasowanie = (rng: RngState) => createSampleGame({ rng }).creatureMarket.deck;
    assert.deepEqual(tasowanie(createSecureRng(keyOf(5))), tasowanie(createSecureRng(keyOf(5))));
    assert.notDeepEqual(tasowanie(createSecureRng(keyOf(5))), tasowanie(createSecureRng(keyOf(6))));
    const [shuffled] = shuffle([1, 2, 3, 4, 5, 6, 7, 8], createSecureRng(keyOf(9)));
    assert.deepEqual([...shuffled].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
