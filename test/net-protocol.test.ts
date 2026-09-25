import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SIMPLE_AI, applyIntent, fallbackIntent, JSON_CODEC, MSGPACK_CODEC, applyPatch, diffJson, jsonEqual, parseClientMessage, projectState, type AiIntent, type IntentMessage, type ServerMessage } from '../src/net/index.ts';
import { advanceAutomaticPhases, pendingActors } from '../src/engine/index.ts';
import { BattleId, HeroId, nextInt, seedRng, type GameState } from '../src/model/index.ts';
import { P1, P2, P3, PAROS, createSampleMatch } from '../src/examples/sampleGame.ts';
import { deepFreeze } from './helpers.ts';

// ===========================================================================
// Pomocniki
// ===========================================================================

const toMessage = (intent: AiIntent): IntentMessage => ({ v: 1, requestId: 't', ...intent }) as IntentMessage;

/** Kolejne stany prawdziwej partii rozgrywanej przez prostą AI za wszystkich graczy. */
function playedStates(steps: number): GameState[] {
  let state = advanceAutomaticPhases(createSampleMatch(['A', 'B', 'C'])).state;
  const states = [state];
  for (let i = 0; i < steps; i++) {
    const actor = pendingActors(state)[0];
    if (actor === undefined) break;
    const view = projectState(state, actor);
    const intent = SIMPLE_AI.decide(view, actor) ?? fallbackIntent(view);
    if (!intent) break;
    const result = applyIntent(state, actor, toMessage(intent));
    if (!result.ok) break;
    state = advanceAutomaticPhases(result.state).state;
    states.push(state);
  }
  return states;
}

function randomJson(seed: number): unknown {
  let rng = seedRng(`json-${seed}`);
  const draw = (max: number): number => {
    const [value, next] = nextInt(rng, max);
    rng = next;
    return value;
  };
  const keys = ['a', 'b', 'c', 'x/y', 'z~w', '0', 'gold', '__proto__'];
  const value = (depth: number): unknown => {
    const kind = draw(depth > 3 ? 4 : 7);
    switch (kind) {
      case 0:
        return null;
      case 1:
        return draw(2) === 1;
      case 2:
        return draw(1000) - 500;
      case 3:
        return ['', 'ą', 'Naxos', 'x'.repeat(40)][draw(4)];
      case 4:
        return Array.from({ length: draw(4) }, () => value(depth + 1));
      default: {
        const object: Record<string, unknown> = {};
        for (let i = draw(4); i > 0; i--) Object.defineProperty(object, keys[draw(keys.length)]!, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        return object;
      }
    }
  };
  return value(0);
}

// ===========================================================================
describe('Kodeki JSON i MessagePack', () => {
  const state = advanceAutomaticPhases(createSampleMatch(['Ariadna', 'Tezeusz', 'Dedal'])).state;
  const view = projectState(state, P1);
  const messages: ServerMessage[] = [
    {
      v: 1,
      type: 'ROOM_STATE',
      roomId: 'lan',
      status: 'IN_GAME',
      settings: {
        roomName: 'LAN',
        startMode: 'HOST',
        minPlayers: 3,
        maxPlayers: 5,
        expansions: { hades: true, monuments: false },
        availableExpansions: { hades: true, monuments: true },
        cities: ['naxos', 'paros'],
        colors: ['RED', 'BLUE'],
      },
      host: P1,
      seats: [
        { slot: 0, playerId: P1, kind: 'HUMAN', name: 'Ariadna', color: 'BLUE', city: 'naxos', ready: true, connected: true, reconnectDeadline: null },
        { slot: 1, playerId: P2, kind: 'HUMAN', name: 'Tezeusz', color: 'RED', city: 'paros', ready: true, connected: false, reconnectDeadline: 1_767_225_660_000 },
      ],
      you: P1,
      seatToken: 'token',
      inReplyTo: 'c1',
    },
    { v: 1, type: 'GAME_STATE_SYNC', mode: 'FULL', revision: state.revision, cause: null, state: view },
    { v: 1, type: 'GAME_STATE_SYNC', mode: 'PATCH', revision: 9, baseRevision: 8, cause: { playerId: P2, requestId: 'c7', intent: 'END_TURN' }, ops: [{ op: 'replace', path: '/cycle', value: 2 }] },
    { v: 1, type: 'ACTION_REJECTED', requestId: 'c2', code: 'CANNOT_AFFORD', message: 'Ta ofiara kosztuje 4 JZ.', details: { cost: 4, available: 3 } },
    {
      v: 1,
      type: 'BATTLE_EVENT',
      battleId: BattleId('b1'),
      attacker: P1,
      defender: P2,
      location: { kind: 'LAND', islandId: PAROS },
      events: [
        {
          type: 'ROUND_RESOLVED',
          round: {
            round: 1,
            attacker: {
              score: { roll: 2, units: 2, heroes: 2, supportFleets: 0, fortifications: 0, fortificationsIgnored: false, bonus: 0, total: 6, modifiers: [{ source: 'HERO', heroId: HeroId('herakles'), value: 2 }] },
              casualty: null,
            },
            defender: {
              score: { roll: 1, units: 2, heroes: 0, supportFleets: 0, fortifications: 1, fortificationsIgnored: false, bonus: 0, total: 4, modifiers: [{ source: 'FORTRESS', islandId: PAROS, value: 1 }] },
              casualty: { kind: 'UNIT' },
            },
          },
        },
        { type: 'BATTLE_DECIDED', outcome: { kind: 'ATTACKER_WON' } },
      ],
    },
    {
      v: 1,
      type: 'BIDDING_EVENT',
      cause: { playerId: P2, requestId: 'c4', intent: 'SUBMIT_BID' },
      events: [
        { type: 'OFFERING_PLACED', playerId: P2, god: 'ARES', amount: 3, cost: 2 },
        { type: 'PLAYER_DISPLACED', playerId: P1, by: P2, god: 'ARES', amount: 2 },
      ],
    },
    {
      v: 1,
      type: 'TURN_UPDATE',
      turnId: 'BIDDING:1:14',
      actors: [P1],
      details: { reason: 'OUTBID', by: P2, god: 'ARES', amount: 3 },
      deadline: 1_767_225_660_000,
      remainingMs: 60_000,
      passiveMove: 'APOLLO',
    },
    { v: 1, type: 'GAME_OVER', winners: [P1], finalCycle: 4 },
  ];

  test('każda wiadomość i pełny stan gry przechodzą przez oba kodeki bez strat', () => {
    for (const codec of [JSON_CODEC, MSGPACK_CODEC]) {
      for (const message of messages) assert.deepEqual(codec.decode(codec.encode(message)), message, `${codec.name}: ${message.type}`);
      assert.deepEqual(codec.decode(codec.encode(state)), state, `${codec.name}: pełny GameState`);
    }
  });

  test('MessagePack jest zwięźlejszy od JSON dla stanu gry', () => {
    const json = new TextEncoder().encode(JSON_CODEC.encode(view) as string).length;
    const packed = (MSGPACK_CODEC.encode(view) as Uint8Array).length;
    assert.ok(packed < json, `MessagePack ${packed} B, JSON ${json} B`);
  });

  test('MessagePack: granice liczb, napisów i kolekcji', () => {
    const numbers = [0, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, -1, -32, -33, -128, -129, -32768, -32769, -(2 ** 31), -(2 ** 31) - 1, 1.5, -0.25, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
    const strings = ['', 'a'.repeat(31), 'a'.repeat(32), 'a'.repeat(255), 'a'.repeat(256), 'ż'.repeat(40_000), 'Kraken 🐙'];
    const collections = [Array.from({ length: 15 }, (_, i) => i), Array.from({ length: 16 }, (_, i) => i), Array.from({ length: 70_000 }, () => 1), Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))];
    for (const value of [...numbers, ...strings, ...collections, { nested: { deeper: [null, true, false] } }]) {
      assert.deepEqual(MSGPACK_CODEC.decode(MSGPACK_CODEC.encode(value)), value);
    }
  });

  test('MessagePack odrzuca uszkodzone i złośliwe dane', () => {
    const bad: [string, Uint8Array][] = [
      ['urwane dane', Uint8Array.of(0xa5, 0x61)],
      ['nadmiarowe bajty', Uint8Array.of(0xc0, 0xc0)],
      ['niepoprawny UTF-8', Uint8Array.of(0xa1, 0xff)],
      ['długość tablicy większa niż dane', Uint8Array.of(0xdd, 0xff, 0xff, 0xff, 0xff)],
      ['klucz mapy nie jest napisem', Uint8Array.of(0x81, 0x01, 0xc0)],
      ['typ bin nie jest obsługiwany', Uint8Array.of(0xc4, 0x00)],
      ['zbyt głębokie zagnieżdżenie', new Uint8Array(200).fill(0x91)],
    ];
    for (const [what, data] of bad) assert.throws(() => MSGPACK_CODEC.decode(data), Error, what);
    assert.throws(() => MSGPACK_CODEC.decode('tekst'), /binarnych/);
    assert.throws(() => MSGPACK_CODEC.encode(Number.NaN), /skończona/);
  });

  test('klucz __proto__ staje się zwykłą własnością i nie zmienia prototypu', () => {
    const payload = Uint8Array.of(0x81, 0xa9, ...new TextEncoder().encode('__proto__'), 0x81, 0xa6, ...new TextEncoder().encode('hacked'), 0xc3);
    const decoded = MSGPACK_CODEC.decode(payload) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
    assert.ok(Object.hasOwn(decoded, '__proto__'));
    assert.equal(({} as Record<string, unknown>)['hacked'], undefined);
  });
});

// ===========================================================================
describe('Synchronizacja różnicowa (JSON Patch)', () => {
  test('łatki odtwarzają kolejne widoki prawdziwej partii, a są dużo mniejsze od pełnego stanu', () => {
    const states = playedStates(40);
    assert.ok(states.length > 20, 'partia powinna trwać wiele kroków');
    let patchBytes = 0;
    let fullBytes = 0;
    for (let i = 1; i < states.length; i++) {
      for (const viewer of [P1, P2, P3, null]) {
        const before = projectState(states[i - 1]!, viewer);
        const after = projectState(states[i]!, viewer);
        const ops = diffJson(before, after);
        assert.deepEqual(applyPatch(before, ops), after, `krok ${i}, widz ${viewer}`);
        patchBytes += JSON.stringify(ops).length;
        fullBytes += JSON.stringify(after).length;
      }
    }
    assert.ok(patchBytes * 10 < fullBytes, `łatki ${patchBytes} B przy pełnych stanach ${fullBytes} B`);
  });

  test('losowe dokumenty: apply(diff(a, b)) = b, a wejście pozostaje nietknięte', () => {
    for (let seed = 0; seed < 300; seed++) {
      const before = deepFreeze(randomJson(seed));
      const after = randomJson(seed + 10_000);
      const patched = applyPatch(before, diffJson(before, after));
      assert.ok(jsonEqual(patched, after), `ziarno ${seed}`);
    }
    assert.deepEqual(diffJson({ a: 1 }, { a: 1 }), [], 'brak zmian to pusta łatka');
  });

  test('ścieżki JSON Pointer poprawnie kodują „/” i „~”', () => {
    const ops = diffJson({ 'x/y': 1, 'z~w': 2 }, { 'x/y': 3, 'z~w': 4 });
    assert.deepEqual(ops.map((op) => op.path), ['/x~1y', '/z~0w']);
    assert.deepEqual(applyPatch({ 'x/y': 1, 'z~w': 2 }, ops), { 'x/y': 3, 'z~w': 4 });
  });

  test('łatka z nieistniejącą ścieżką jest odrzucana', () => {
    assert.throws(() => applyPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]), /Brak klucza/);
    assert.throws(() => applyPatch([1, 2], [{ op: 'replace', path: '/5', value: 2 }]), /poza tablicą/);
    assert.throws(() => applyPatch({ a: 1 }, [{ op: 'remove', path: '' }]), /korzenia/);
  });
});

// ===========================================================================
describe('Walidacja wiadomości klienta', () => {
  test('poprawne wiadomości są normalizowane, a nieznane pola (np. podrobiony playerId) znikają', () => {
    const parsed = parseClientMessage({
      v: 1,
      type: 'SUBMIT_BID',
      requestId: 'c1',
      playerId: 'p2',
      bid: { kind: 'GOD', god: 'ARES', amount: 3, extra: true },
    });
    assert.deepEqual(parsed, { ok: true, message: { v: 1, type: 'SUBMIT_BID', requestId: 'c1', bid: { kind: 'GOD', god: 'ARES', amount: 3 } } });

    const move = parseClientMessage({
      v: 1,
      type: 'EXECUTE_ACTION',
      requestId: 'c2',
      action: { type: 'MOVE_FLEET', from: 'sea-center', count: 1, route: [{ to: 'sea-north', pickUp: 2 }] },
    });
    assert.ok(move.ok && move.message.type === 'EXECUTE_ACTION' && move.message.action.type === 'MOVE_FLEET');
  });

  test('błędne wiadomości są odrzucane z powodem, a requestId jest odzyskiwany', () => {
    const cases: [unknown, RegExp][] = [
      ['nie obiekt', /obiektu/],
      [{ v: 2, type: 'END_TURN', requestId: 'c1' }, /wersja/],
      [{ v: 1, type: 'CHEAT', requestId: 'c1' }, /type/],
      [{ v: 1, type: 'END_TURN' }, /requestId/],
      [{ v: 1, type: 'JOIN_ROOM', requestId: 'c1', roomId: 'r', playerName: 'x'.repeat(33) }, /playerName/],
      [{ v: 1, type: 'SUBMIT_BID', requestId: 'c1', bid: { kind: 'GOD', god: 'APOLLO', amount: 1 } }, /bid\.god/],
      [{ v: 1, type: 'SUBMIT_BID', requestId: 'c1', bid: { kind: 'GOD', god: 'ARES', amount: 1.5 } }, /bid\.amount/],
      [{ v: 1, type: 'SUBMIT_BID', requestId: 'c1', bid: { kind: 'GOD', god: 'ARES', amount: 1001 } }, /bid\.amount/],
      [{ v: 1, type: 'EXECUTE_ACTION', requestId: 'c1', action: { type: 'MOVE_FLEET', from: 's', count: 1, route: Array(9).fill({ to: 's' }) } }, /route/],
      [{ v: 1, type: 'EXECUTE_ACTION', requestId: 'c1', action: { type: 'TELEPORT' } }, /action\.type/],
    ];
    for (const [raw, reason] of cases) {
      const parsed = parseClientMessage(raw);
      assert.ok(!parsed.ok, `powinno być odrzucone: ${JSON.stringify(raw)}`);
      assert.match(parsed.error, reason);
    }
    const withId = parseClientMessage({ v: 1, type: 'SUBMIT_BID', requestId: 'c9', bid: null });
    assert.ok(!withId.ok && withId.requestId === 'c9');
  });
});

// ===========================================================================
describe('Projekcja stanu', () => {
  const state = advanceAutomaticPhases(createSampleMatch(['A', 'B', 'C'])).state;

  test('ukrywa generator losowy, kolejność talii, cudze złoto i cudze karty Monumentów', () => {
    const view = projectState(state, P1);
    assert.equal('rng' in view, false, 'bez stanu generatora nie da się przewidzieć rzutów');
    assert.equal('deck' in view.creatureMarket, false);
    assert.equal(view.creatureMarket.deckSize, state.creatureMarket.deck.length);
    assert.equal(view.players[P1]?.gold, state.players[P1]?.gold);
    assert.deepEqual([view.players[P2]?.gold, view.players[P3]?.gold], [null, null]);
    assert.deepEqual(view.monuments?.yourCards, state.monuments?.dealt[P1]);
    assert.deepEqual(view.monuments?.cardCounts, { [P1]: 1, [P2]: 1, [P3]: 1 });
    // Katalog (jawna lista wszystkich kart) zawiera każdy identyfikator, więc szukamy poza nim.
    const rivalCard = String(state.monuments?.dealt[P2]?.[0]);
    assert.equal(JSON.stringify({ ...view, catalog: null }).includes(rivalCard), false, 'nie widać, którą kartę ma rywal');
  });

  test('obserwator nie widzi niczyjego złota ani kart, a jawne złoto można włączyć w zasadach pokoju', () => {
    const spectator = projectState(state, null);
    assert.ok(Object.values(spectator.players).every((player) => player.gold === null));
    assert.deepEqual(spectator.monuments?.yourCards, []);
    const open = projectState(state, P1, { hiddenGold: false });
    assert.equal(open.players[P2]?.gold, state.players[P2]?.gold);
  });
});
