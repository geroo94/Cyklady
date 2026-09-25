import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_TURN_TIMEOUTS,
  GameClient,
  ManualScheduler,
  createSinglePlayerServer,
  projectState,
  type BattleEventMessage,
  type GameServer,
  type RoomConfig,
} from '../src/net/index.ts';
import { CardId, HeroId, createSecureRng, expectPhase, rollDie, type GameState, type PlayerId, type RngState } from '../src/model/index.ts';
import { MILOS, NAXOS, P1, P2, P3, PAROS } from '../src/examples/sampleGame.ts';
import { ARES_TURN, actionsScenario, addHero, setIsland, withBuildings } from './helpers.ts';
import { FIXED_KEY, FIXED_KEY_HEX, fixedRng, flush, ofType, recorded, rejected, seats, type Delivery } from './netHarness.ts';

// ===========================================================================
// Scenariusz: P1 (Ares) z Heraklesem atakuje Paros. Paros ma Fortecę, a P2 broni jej z Achillesem.
// ===========================================================================

const HERACLES = HeroId('herakles');
const ACHILLES = HeroId('achilles');

function fortifiedParos(): GameState {
  return actionsScenario(ARES_TURN, (g) => {
    const board = withBuildings(setIsland(g, MILOS, P2), PAROS, ['FORTRESS']);
    return addHero(addHero(board, PAROS, ACHILLES, CardId('h-achilles')), NAXOS, HERACLES, CardId('h-heracles'));
  });
}

interface Table {
  readonly server: GameServer;
  readonly scheduler: ManualScheduler;
  readonly log: Delivery[];
  readonly clients: Record<'p1' | 'p2' | 'p3', GameClient>;
}

async function battleTable(overrides: Partial<RoomConfig> = {}): Promise<Table> {
  const scheduler = new ManualScheduler();
  const server = createSinglePlayerServer();
  server.createRoom({
    roomId: 'bitwa',
    seats: seats('HUMAN', 'HUMAN', 'HUMAN'),
    createGame: fortifiedParos,
    createRng: fixedRng,
    scheduler,
    turnTimeouts: DEFAULT_TURN_TIMEOUTS,
    ...overrides,
  });
  const log: Delivery[] = [];
  const connect = (who: string): GameClient => new GameClient(recorded(server.connectLocal(), who, log));
  const clients = { p1: connect('p1'), p2: connect('p2'), p3: connect('p3') };
  await clients.p1.joinRoom('bitwa', 'Ariadna');
  await clients.p2.joinRoom('bitwa', 'Tezeusz');
  await clients.p3.joinRoom('bitwa', 'Dedal');
  await flush();
  return { server, scheduler, log, clients };
}

const stateOf = (server: GameServer): GameState => server.inspectRoom('bitwa')?.state ?? assert.fail('brak stanu');
const attack = (client: GameClient) => client.executeAction({ type: 'MOVE_TROOPS', from: NAXOS, to: PAROS, troops: 2, heroes: [HERACLES] });

/** Kolejne rzuty kością bitewną z generatora o stałym kluczu (tak jak losuje serwer). */
function expectedRolls(count: number): number[] {
  let rng: RngState = createSecureRng(FIXED_KEY);
  return Array.from({ length: count }, () => {
    const [value, next] = rollDie(rng, [0, 1, 1, 2, 2, 3]);
    rng = next;
    return value;
  });
}

function roundReports(log: readonly Delivery[]): { who: string; message: BattleEventMessage }[] {
  return log.flatMap((delivery) =>
    delivery.message.type === 'BATTLE_EVENT' && delivery.message.events.some((event) => event.type === 'ROUND_RESOLVED')
      ? [{ who: delivery.who, message: delivery.message }]
      : [],
  );
}

// ===========================================================================
describe('Synchronizacja walki: rzuty na serwerze i raport starcia', () => {
  test('raport rundy z rzutami i modyfikatorami trafia w tej samej chwili do obu stron i do widza', async () => {
    const { server, log, clients } = await battleTable();
    await attack(clients.p1);
    const before = log.length;
    await clients.p2.rerollDice();
    await flush();

    const reports = roundReports(log.slice(before));
    assert.deepEqual(reports.map((report) => report.who), ['p1', 'p2', 'p3'], 'jeden raport dla każdego, bez wyjątku');
    const [first] = reports;
    for (const report of reports) assert.deepEqual(report.message, first?.message, `${report.who} dostał ten sam raport`);

    // Rozesłanie jest niepodzielne: trzy raporty stoją obok siebie w dzienniku, przed jakąkolwiek zmianą stanu.
    const index = log.findIndex((delivery) => delivery.message === first?.message);
    assert.deepEqual(log.slice(index, index + 3).map((delivery) => delivery.message.type), ['BATTLE_EVENT', 'BATTLE_EVENT', 'BATTLE_EVENT']);
    assert.ok(log.slice(before, index).every((delivery) => delivery.message.type !== 'GAME_STATE_SYNC'), 'raport wyprzedza stan');

    const message = first?.message ?? assert.fail('brak raportu');
    assert.deepEqual([message.attacker, message.defender, message.location], [P1, P2, { kind: 'LAND', islandId: PAROS }]);
    const round = message.events[0]?.type === 'ROUND_RESOLVED' ? message.events[0].round : assert.fail('brak rundy');
    assert.deepEqual(round.attacker.score.modifiers, [{ source: 'HERO', heroId: HERACLES, value: 2 }]);
    assert.deepEqual(round.defender.score.modifiers, [
      { source: 'HERO', heroId: ACHILLES, value: 2 },
      { source: 'FORTRESS', islandId: PAROS, value: 1 },
    ]);
    for (const side of [round.attacker, round.defender]) {
      const listed = side.score.modifiers.reduce((sum, modifier) => sum + modifier.value, 0);
      assert.equal(side.score.roll + side.score.units + listed, side.score.total, 'raport sumuje się do wyniku');
    }

    // Rzuty pochodzą z generatora pokoju (ChaCha20 z kluczem serwera): da się je odtworzyć z klucza, ale nie bez niego.
    assert.deepEqual([round.attacker.score.roll, round.defender.score.roll], expectedRolls(2));
    const rng = stateOf(server).rng;
    assert.ok(rng.algorithm === 'chacha20' && rng.key === FIXED_KEY_HEX);
    assert.ok(!JSON.stringify(log.map((delivery) => delivery.message)).includes(FIXED_KEY_HEX), 'klucz generatora nie opuszcza serwera');
    await server.stop();
  });

  test('bitwa do końca: każda decyzja ma TURN_UPDATE, a stan u wszystkich zgadza się z serwerem', async () => {
    const { server, scheduler, clients } = await battleTable();
    const byPlayer: Record<PlayerId, GameClient> = { [P1]: clients.p1, [P2]: clients.p2, [P3]: clients.p3 };
    await attack(clients.p1);
    await flush();

    for (let steps = 0; stateOf(server).phase.phase === 'BATTLE_RESOLUTION'; steps++) {
      assert.ok(steps < 30, 'bitwa powinna się skończyć');
      const turn = clients.p3.turn ?? assert.fail('widz też zna zegar tury');
      const actor = byPlayer[turn.actors[0] ?? P1] ?? assert.fail();
      if (turn.details.reason === 'BATTLE_ROLL') await actor.rerollDice();
      else if (turn.details.reason === 'RETREAT_DECISION') await actor.executeAction({ type: 'HOLD' });
      else assert.fail(`nieoczekiwana tura ${turn.details.reason}`);
      await flush();
    }

    const state = stateOf(server);
    assert.equal(expectPhase(state, 'ACTIONS').progress.movements, 1, 'tura Aresa trwa dalej');
    for (const [client, viewer] of [[clients.p1, P1], [clients.p2, P2], [clients.p3, P3]] as const) {
      assert.deepEqual(client.state, projectState(state, viewer), `replika ${viewer} zgodna z serwerem`);
    }
    assert.deepEqual(clients.p1.turn?.details, { reason: 'GOD_TURN', god: 'ARES' });
    await server.stop();
    assert.equal(scheduler.pending, 0, 'po zatrzymaniu serwera nie zostają żadne liczniki');
  });

  test('pokój bez własnego generatora losuje dla każdej partii nowy klucz ChaCha20', async () => {
    const keys: string[] = [];
    for (const roomId of ['a', 'b']) {
      const server = createSinglePlayerServer();
      server.createRoom({ roomId, seats: seats('HUMAN', 'AI', 'AI'), createGame: fortifiedParos });
      await new GameClient(server.connectLocal()).joinRoom(roomId, 'Ariadna');
      const rng = server.inspectRoom(roomId)?.state?.rng;
      keys.push(rng?.algorithm === 'chacha20' ? rng.key : assert.fail('partia bez generatora ChaCha20'));
      await server.stop();
    }
    assert.match(keys[0] ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(keys[0], keys[1]);
  });

  test('obie strony proszą o rzut naraz: serwer rzuca raz, a drugą prośbę odrzuca', async () => {
    const { server, log, clients } = await battleTable();
    await attack(clients.p1);
    await flush();
    const before = log.length;

    const results = await Promise.allSettled([clients.p1.rerollDice(), clients.p2.rerollDice()]);
    await flush();
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
    const refusal = results[1]?.status === 'rejected' ? (results[1].reason as { code?: string }) : assert.fail();
    assert.equal(refusal.code, 'WRONG_STEP', 'po rzucie bitwa czeka już na decyzję o odwrocie');
    assert.equal(roundReports(log.slice(before)).length, 3, 'jedna runda: po jednym raporcie dla każdego gracza');
    await server.stop();
  });

  test('bez prośby o rzut serwer rzuca sam po upływie limitu, a brak decyzji o odwrocie oznacza walkę dalej', async () => {
    const { server, scheduler, log, clients } = await battleTable();
    await attack(clients.p1);
    await flush();
    assert.deepEqual([clients.p2.turn?.details.reason, clients.p2.turn?.passiveMove, clients.p2.turn?.remainingMs], ['BATTLE_ROLL', 'ROLL', 30_000]);

    const before = log.length;
    scheduler.advance(30_000);
    await flush();
    const syncs = ofType(log.slice(before), 'GAME_STATE_SYNC', 'p1');
    assert.equal(syncs[0]?.cause?.intent, 'TIMEOUT:REROLL_DICE');
    assert.equal(roundReports(log.slice(before)).length, 3, 'rzut serwera trafia do wszystkich jak każdy inny');

    const decision = clients.p2.turn?.details;
    assert.deepEqual(decision?.reason === 'RETREAT_DECISION' ? [decision.role, clients.p2.turn?.passiveMove] : null, ['DEFENDER', 'HOLD']);
    const beforeDecision = log.length;
    scheduler.advance(30_000);
    await flush();
    const feed = ofType(log.slice(beforeDecision), 'BATTLE_EVENT', 'p3').flatMap((message) => message.events);
    assert.deepEqual(feed[0], { type: 'RETREAT_DECLINED', role: 'DEFENDER', playerId: P2 });
    assert.equal(ofType(log.slice(beforeDecision), 'GAME_STATE_SYNC', 'p3')[0]?.cause?.intent, 'TIMEOUT:EXECUTE_ACTION:HOLD');
    await rejected(clients.p3.rerollDice());
    await server.stop();
  });
});
