import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BattleId,
  CardId,
  DEFAULT_RULESET,
  HeroId,
  IllegalTransitionError,
  InvalidGameStateError,
  SeaId,
  adjacentNodes,
  advanceHadesThreat,
  assertValidGameState,
  automaticNextPhase,
  beginBattle,
  checkVictory,
  consumeHadesSummon,
  createActionsPhase,
  createBiddingPhase,
  createBoard,
  createCreatureMarket,
  createTurnProgress,
  currentGodTurn,
  endBattle,
  expectPhase,
  finishGodTurn,
  getIsland,
  getPlayer,
  getPlayerView,
  getSea,
  refreshCreatureMarket,
  seedRng,
  toHadesLevel,
  transition,
  type BattleState,
  type Casualty,
  type GameState,
  type HadesThreatTrack,
  type RoundSide,
  type PlayerId,
} from '../src/model/index.ts';
import { CYCLE_HOOKS } from '../src/engine/index.ts';
import {
  DELOS,
  MILOS,
  NAXOS,
  P1,
  P2,
  PAROS,
  SAMPLE_MAP,
  SAMPLE_OPTIONS,
  SEA_CENTER,
  SEA_EAST,
  SEA_NORTH,
  SEA_SOUTH,
  createSampleGame,
} from '../src/examples/sampleGame.ts';
import {
  STARTING_ISLAND,
  advanceToActions,
  advanceToBidding,
  assertValid,
  placeOfferingsInOrder,
  playAllTurns,
  playFirstCycle,
  readyGame,
  updateBattle,
  updateIsland,
  updatePlayer,
  updateProgress,
  updateSea,
  violationCodes,
} from './helpers.ts';

const sorted = <T>(items: readonly T[]): T[] => [...items].sort();

// ===========================================================================
describe('Fabryka partii i graf planszy', () => {
  test('nowa partia spełnia wszystkie niezmienniki', () => {
    const s = assertValid(createSampleGame());
    assert.equal(s.phase.phase, 'INIT');
    assert.equal(s.cycle, 0);
    assert.deepEqual(sorted(s.turnOrder.current), sorted(s.seating));
    assert.equal(s.creatureMarket.deck.length, 9);
    assert.deepEqual(s.hades?.threat, { level: 0, summonPending: false });
    assert.equal(s.monuments?.deck.length, 4);
  });

  test('sąsiedztwo jest symetryczne, choć każdą krawędź zapisano raz', () => {
    const { board } = createSampleGame();
    assert.deepEqual(sorted(getIsland(board, NAXOS).adjacentSeas), sorted([SEA_NORTH, SEA_CENTER]));
    assert.ok(getSea(board, SEA_NORTH).adjacentIslands.includes(DELOS));
    assert.ok(getSea(board, SEA_SOUTH).adjacentSeas.includes(SEA_NORTH));
    assert.deepEqual(sorted(adjacentNodes(board, SEA_EAST)), sorted([PAROS, MILOS, SEA_CENTER]));
    assert.equal(getSea(board, SEA_CENTER).tradeRoute?.prosperity, 1);
    assert.equal(getSea(board, SEA_NORTH).tradeRoute, null);
  });

  test('createBoard odrzuca krawędź do nieistniejącego węzła', () => {
    assert.throws(
      () => createBoard({ ...SAMPLE_MAP, islandSeaEdges: [[NAXOS, SeaId('atlantyk')]] }),
      /nieistniejący węzeł/,
    );
  });

  test('fabryka odrzuca nieobsługiwaną liczbę graczy i herosów bez dodatku Hades', () => {
    assert.throws(() => createSampleGame({ players: SAMPLE_OPTIONS.players.slice(0, 1) }), /Brak konfiguracji/);
    assert.throws(
      () => createSampleGame({ rules: { ...DEFAULT_RULESET, expansions: { hades: false, monuments: true } } }),
      /Hades jest wyłączony/,
    );
  });

  test('to samo ziarno daje identyczną partię, inne ziarno inną', () => {
    assert.deepEqual(createSampleGame(), createSampleGame());
    assert.notDeepEqual(createSampleGame({ seed: 'inne' }).creatureMarket.deck, createSampleGame().creatureMarket.deck);
  });

  test('stan w trakcie bitwy przechodzi przez JSON bez strat', () => {
    const s = startBattle(advanceToActions(readyGame()));
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  });
});

// ===========================================================================
describe('Maszyna stanów', () => {
  test('nieistniejąca krawędź jest odrzucana', () => {
    const s = createSampleGame();
    assert.throws(
      () => transition(s, createBiddingPhase(s)),
      (e: unknown) => e instanceof IllegalTransitionError && e.from === 'INIT' && e.to === 'BIDDING',
    );
  });

  test('strażnik blokuje wyjście z INIT przed rozstawieniem sił', () => {
    assert.throws(
      () => transition(createSampleGame(), { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }),
      /rozstawienie sił startowych/,
    );
  });

  test('pełny cykl: INIT -> ... -> CREATURES_REFRESH drugiego cyklu', () => {
    let s = assertValid(readyGame());

    s = assertValid(transition(s, { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, CYCLE_HOOKS));
    assert.equal(s.cycle, 1);
    assert.equal(s.creatureMarket.slots.filter((slot) => slot.card !== null).length, 3);

    s = assertValid(transition(s, { phase: 'GODS_SETUP', revealed: [], hadesSummoned: false }, CYCLE_HOOKS));
    assert.equal(s.gods.slots.length, 2, '3 graczy: 2 bogów + Apollo');
    assert.equal(s.gods.unavailable.length, 2);

    const goldBefore = getPlayer(s, P1).gold;
    s = assertValid(transition(s, { phase: 'INCOME', report: {} }, CYCLE_HOOKS));
    assert.equal(getPlayer(s, P1).gold, goldBefore + 3, 'Naxos (2) + pole handlowe Morza Środk. (1)');

    s = assertValid(transition(s, createBiddingPhase(s)));
    const prematureActions = {
      phase: 'ACTIONS',
      turns: [{ god: 'APOLLO', playerId: P1 }],
      turnIndex: 0,
      progress: createTurnProgress(),
    } as const;
    assert.throws(() => transition(s, prematureActions), /ofiary nie złożyli/);
    s = assertValid(placeOfferingsInOrder(s));

    s = assertValid(transition(s, createActionsPhase(s)));
    const actions = expectPhase(s, 'ACTIONS');
    assert.equal(actions.turns.length, 3);
    assert.equal(actions.turns[2]?.god, 'APOLLO', 'Apollo działa jako ostatni');
    assert.throws(
      () => transition(s, { phase: 'END_OF_CYCLE', victory: checkVictory(s) }),
      /nie wszyscy bogowie/,
    );

    const actionOrder = actions.turns.map((turn) => turn.playerId);
    s = assertValid(playAllTurns(s));
    s = assertValid(transition(s, { phase: 'END_OF_CYCLE', victory: checkVictory(s) }));
    assert.throws(() => transition(s, { phase: 'GAME_OVER', winners: [], finalCycle: 1 }), /nikt nie spełnił/);

    s = assertValid(transition(s, { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, CYCLE_HOOKS));
    assert.equal(s.cycle, 2);
    assert.deepEqual(s.turnOrder.current, actionOrder, 'kolejność kończenia tur = kolejność licytacji');
    assert.deepEqual(s.turnOrder.next, []);
    assert.deepEqual(s.gods.slots, []);
    const refresh = expectPhase(s, 'CREATURES_REFRESH');
    assert.notEqual(refresh.discarded, null, 'karta z pola za 2 JZ spadła na stos odrzuconych');
  });

  test('automaticNextPhase przewija fazy automatyczne i czeka na graczy', () => {
    assert.equal(automaticNextPhase(createSampleGame()), null, 'INIT czeka na rozstawienie');
    assert.equal(automaticNextPhase(readyGame()), 'CREATURES_REFRESH');

    const bidding = advanceToBidding(readyGame());
    assert.equal(automaticNextPhase(bidding), null, 'licytacja czeka na ofiary');
    assert.equal(automaticNextPhase(placeOfferingsInOrder(bidding)), 'ACTIONS');

    const actions = advanceToActions(readyGame());
    assert.equal(automaticNextPhase(actions), null, 'trwa tura gracza');
    assert.equal(automaticNextPhase(finishGodTurn(actions)), null, 'czeka na turę następnego boga');
    assert.equal(automaticNextPhase(playAllTurns(actions)), 'END_OF_CYCLE');
    assert.equal(automaticNextPhase(playFirstCycle()), 'CREATURES_REFRESH');
  });
});

// ===========================================================================
/** Atakujący (gracz aktywnej tury) wysyła 1 oddział na wyspę sąsiada. */
function startBattle(state: GameState): GameState {
  const attacker = currentGodTurn(state)?.playerId;
  assert.ok(attacker);
  const defender = state.seating.find((id) => id !== attacker) as PlayerId;
  const from = STARTING_ISLAND[attacker] ?? assert.fail('brak wyspy atakującego');
  const target = STARTING_ISLAND[defender] ?? assert.fail('brak wyspy obrońcy');
  const defenders = getIsland(state.board, target).garrison ?? assert.fail('brak obrońców');

  // Obie strony schodzą z planszy do kontekstu bitwy.
  let s = updateIsland(state, from, (i) => ({ ...i, garrison: i.garrison && { ...i.garrison, troops: 1 } }));
  s = updateIsland(s, target, (i) => ({ ...i, garrison: null }));
  const battle: BattleState = {
    id: BattleId('bitwa-1'),
    location: { kind: 'LAND', islandId: target },
    attacker: { playerId: attacker, units: 1, undead: 0, heroes: [], bonus: 0, origin: from },
    defender: { playerId: defender, units: defenders.troops, undead: 0, heroes: [], bonus: 0, origin: null },
    step: 'ROLL',
    rounds: [],
    outcome: null,
  };
  return beginBattle(s, battle);
}

describe('Bitwa jako podstan fazy ACTIONS', () => {
  test('push/pop zachowuje postęp tury, a każda figurka jest policzona', () => {
    let s = updateProgress(advanceToActions(readyGame()), (p) => ({ ...p, movements: 1 }));
    const attacker = currentGodTurn(s)?.playerId as PlayerId;

    s = assertValid(startBattle(s));
    assert.equal(s.phase.phase, 'BATTLE_RESOLUTION');
    const battle = expectPhase(s, 'BATTLE_RESOLUTION').battle;
    const target = battle.location.kind === 'LAND' ? battle.location.islandId : assert.fail();
    const defender = battle.defender.playerId;
    assert.throws(() => endBattle(s), /nie została rozstrzygnięta/);

    // Dwie rundy: obrońca traci oba oddziały (polegli wracają do zapasu).
    const side = (roll: number, units: number, casualty: Casualty | null): RoundSide => ({
      score: { roll, units, heroes: 0, supportFleets: 0, fortifications: 0, fortificationsIgnored: false, bonus: 0, total: roll + units, modifiers: [] },
      casualty,
    });
    s = updateBattle(s, (b) => ({
      ...b,
      rounds: [
        { round: 1, attacker: side(3, 1, null), defender: side(0, 2, { kind: 'UNIT' }) },
        { round: 2, attacker: side(2, 1, null), defender: side(0, 1, { kind: 'UNIT' }) },
      ],
      defender: { ...b.defender, units: 0 },
      step: 'FINISHED',
      outcome: { kind: 'ATTACKER_WON' },
    }));
    s = assertValid(updatePlayer(s, defender, (p) => ({ ...p, reserve: { ...p.reserve, troops: p.reserve.troops + 2 } })));
    assert.throws(() => endBattle(s), /odstawić na planszę/);

    // Zwycięzca zajmuje wyspę.
    s = updateBattle(s, (b) => ({ ...b, attacker: { ...b.attacker, units: 0 } }));
    s = updateIsland(s, target, (i) => ({
      ...i,
      ownerId: attacker,
      garrison: { playerId: attacker, troops: 1, undeadTroops: 0, heroes: [] },
    }));
    s = assertValid(endBattle(s));

    const actions = expectPhase(s, 'ACTIONS');
    assert.equal(actions.turnIndex, 0);
    assert.equal(actions.progress.movements, 1, 'tura toczy się dalej od miejsca przerwania');
    assert.equal(getIsland(s.board, target).ownerId, attacker);
  });

  test('nie można wejść w bitwę, gdy obrońcy wciąż stoją na polu bitwy', () => {
    const s = advanceToActions(readyGame());
    const battle: BattleState = {
      id: BattleId('bitwa-x'),
      location: { kind: 'LAND', islandId: PAROS },
      attacker: { playerId: P1, units: 1, undead: 0, heroes: [], bonus: 0, origin: NAXOS },
      defender: { playerId: P2, units: 2, undead: 0, heroes: [], bonus: 0, origin: null },
      step: 'ROLL',
      rounds: [],
      outcome: null,
    };
    assert.throws(() => beginBattle(s, battle), /przenieść do kontekstu bitwy/);
  });

  test('nie można wejść w bitwę po zakończeniu tury', () => {
    assert.throws(() => startBattle(finishGodTurn(advanceToActions(readyGame()))), /trwającej tury/);
  });
});

// ===========================================================================
describe('Zwycięstwo', () => {
  const metropolis = { metropolis: { origin: 'BUILDINGS' as const, builtInCycle: 1 } };

  test('dwie Metropolie na końcu cyklu kończą grę', () => {
    let s = playFirstCycle();
    s = updateIsland(s, NAXOS, (i) => ({ ...i, metropolisSlot: metropolis }));
    s = updateIsland(s, MILOS, (i) => ({ ...i, ownerId: P1, metropolisSlot: metropolis }));
    const victory = checkVictory(s);
    assert.deepEqual(victory.winners, [P1]);
    s = assertValid({ ...s, phase: { phase: 'END_OF_CYCLE', victory } });
    assert.equal(automaticNextPhase(s), 'GAME_OVER');

    assert.throws(() => transition(s, { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }), /jest zwycięzca/);
    assert.throws(() => transition(s, { phase: 'GAME_OVER', winners: [P2], finalCycle: s.cycle }), /nie zgadza się/);
    const over = assertValid(transition(s, { phase: 'GAME_OVER', winners: [P1], finalCycle: s.cycle }));
    assert.equal(automaticNextPhase(over), null, 'GAME_OVER jest stanem końcowym');
  });

  test('remis w Metropoliach rozstrzyga złoto, a remis w złocie daje kilku zwycięzców', () => {
    let s = createSampleGame();
    for (const [island, owner] of [[NAXOS, P1], [MILOS, P1], [PAROS, P2], [DELOS, P2]] as const) {
      s = updateIsland(s, island, (i) => ({ ...i, ownerId: owner, metropolisSlot: metropolis }));
    }
    assert.deepEqual(checkVictory(s).winners, [P1, P2]);
    s = updatePlayer(s, P2, (p) => ({ ...p, gold: p.gold + 1 }));
    assert.deepEqual(checkVictory(s), { contenders: [P1, P2], winners: [P2] });
  });
});

// ===========================================================================
describe('Tor Mitologicznych Stworów i Herosów', () => {
  test('karty zsuwają się, luki się wypełniają, a przy pustej talii tasuje się stos', () => {
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(CardId) as [CardId, CardId, CardId, CardId, CardId];
    let market = createCreatureMarket([a, b, c, d, e]);
    let rng = seedRng('tor');
    const refresh = () => {
      const r = refreshCreatureMarket(market, rng);
      market = r.market;
      rng = r.rng;
      return r;
    };
    const visible = () => market.slots.map((slot) => slot.card);

    assert.deepEqual(refresh().drawn, [a, b, c]);
    assert.deepEqual(visible(), [a, b, c]);

    assert.equal(refresh().discarded, a);
    assert.deepEqual(visible(), [b, c, d], 'karty przesunęły się w stronę tańszych pól');

    // Gracz kupuje kartę z pola za 3 JZ, a po użyciu trafia ona na stos.
    market = { ...market, slots: [market.slots[0], { cost: 3, card: null }, market.slots[2]], discard: [...market.discard, c] };
    const r = refresh();
    assert.equal(r.discarded, b);
    assert.deepEqual(visible().slice(0, 2), [d, e], 'luka zsunięta, nowa karta od strony 4 JZ');
    assert.equal(r.reshuffled, true, 'talia się skończyła, więc przetasowano stos odrzuconych');

    const everywhere = [...market.deck, ...market.discard, ...visible().filter((card) => card !== null)];
    assert.deepEqual(sorted(everywhere), sorted([a, b, c, d, e]), 'każda karta w dokładnie jednej strefie');
  });
});

// ===========================================================================
describe('Kolumna Hadesa', () => {
  const rules = DEFAULT_RULESET.hades;

  test('poziom jest przycinany do 0-9, a przywołanie jest odroczone do GODS_SETUP', () => {
    let track: HadesThreatTrack = { level: 0, summonPending: false };
    track = advanceHadesThreat(track, 4, rules);
    assert.deepEqual(track, { level: 4, summonPending: false });
    track = advanceHadesThreat(track, 7, rules);
    assert.deepEqual(track, { level: 9, summonPending: true });
    track = advanceHadesThreat(track, -3, rules);
    assert.deepEqual(track, { level: 6, summonPending: true }, 'flaga przywołania nie znika');

    const summon = consumeHadesSummon(track, rules);
    assert.equal(summon.summoned, true);
    assert.deepEqual(summon.track, { level: 0, summonPending: false });
    assert.equal(consumeHadesSummon(summon.track, rules).summoned, false);

    assert.equal(toHadesLevel(-5), 0);
    assert.equal(toHadesLevel(42), 9);
    assert.equal(toHadesLevel(3.7), 3);
  });

  test('przywołany Hades pojawia się na torze bogów w następnym cyklu', () => {
    let s = playFirstCycle();
    const hades = s.hades ?? assert.fail('dodatek Hades powinien być włączony');
    s = { ...s, hades: { ...hades, threat: advanceHadesThreat(hades.threat, 9, rules) } };

    s = transition(s, { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, CYCLE_HOOKS);
    s = assertValid(transition(s, { phase: 'GODS_SETUP', revealed: [], hadesSummoned: false }, CYCLE_HOOKS));
    assert.equal(expectPhase(s, 'GODS_SETUP').hadesSummoned, true);
    assert.ok(s.gods.slots.some((slot) => slot.god === 'HADES'));
    assert.deepEqual(s.hades?.threat, { level: 0, summonPending: false });
  });
});

// ===========================================================================
describe('Widok gracza (dane wyliczane)', () => {
  test('jednostki, wyspy, dochód i pozycja w licytacji wynikają ze stanu', () => {
    const s = advanceToActions(readyGame());
    const view = getPlayerView(s, P1);
    assert.deepEqual(view.units.troops, { onBoard: 2, inBattle: 0, inReserve: 6 });
    assert.deepEqual(view.units.fleets, { onBoard: 1, inBattle: 0, inReserve: 7 });
    assert.deepEqual(view.islands, [NAXOS]);
    assert.deepEqual(view.expectedIncome, { islands: 2, tradeRoutes: 1, necropolis: 0, total: 3 });
    assert.equal(view.metropolises, 0);
    assert.equal(view.offerings.length, 1, 'jeden znacznik ofiary');
    assert.equal(view.turnOrderPositions.length, 1);

    const offering = view.offerings[0];
    if (offering?.kind === 'GOD') {
      assert.equal(s.gods.slots.find((slot) => slot.god === offering.god)?.offering?.playerId, P1);
    } else {
      assert.ok(s.gods.apolloSupplicants.includes(P1));
    }
  });

  test('heros jest w dokładnie jednej strefie: zapas albo wyspa', () => {
    let s = readyGame();
    const heroCard = s.creatureMarket.deck.find((id) => s.catalog.mythCards[id]?.type === 'HERO') ?? assert.fail();
    const heroId = HeroId('heros-1');

    // Zakup: karta opuszcza talię, heros trafia do zapasu gracza.
    s = {
      ...s,
      creatureMarket: { ...s.creatureMarket, deck: s.creatureMarket.deck.filter((id) => id !== heroCard) },
      heroes: { [heroId]: { id: heroId, cardId: heroCard, exhausted: false } },
    };
    s = assertValid(updatePlayer(s, P1, (p) => ({ ...p, reserve: { ...p.reserve, heroes: [heroId] } })));
    assert.deepEqual(getPlayerView(s, P1).heroes, [heroId]);

    // Wystawienie na Naxos.
    s = updatePlayer(s, P1, (p) => ({ ...p, reserve: { ...p.reserve, heroes: [] } }));
    s = assertValid(updateIsland(s, NAXOS, (i) => ({ ...i, garrison: i.garrison && { ...i.garrison, heroes: [heroId] } })));
    assert.deepEqual(getPlayerView(s, P1).heroes, [heroId]);

    // Błąd: heros jednocześnie w zapasie i na wyspie.
    const broken = updatePlayer(s, P1, (p) => ({ ...p, reserve: { ...p.reserve, heroes: [heroId] } }));
    assert.ok(violationCodes(broken).includes('ZONE_DUPLICATE'));
  });
});

// ===========================================================================
describe('Niezmienniki wykrywają uszkodzony stan', () => {
  test('podwojona karta, zgubiona figurka, zły właściciel, asymetryczny graf, nadmiar filozofów', () => {
    const s = readyGame();
    const firstCard = s.creatureMarket.deck[0] ?? assert.fail();

    const duplicated: GameState = {
      ...s,
      creatureMarket: { ...s.creatureMarket, discard: [firstCard] },
    };
    assert.ok(violationCodes(duplicated).includes('ZONE_DUPLICATE'));

    const extraTroop = updatePlayer(s, P1, (p) => ({ ...p, reserve: { ...p.reserve, troops: p.reserve.troops + 1 } }));
    assert.ok(violationCodes(extraTroop).includes('UNIT_CONSERVATION'));

    const wrongOwner = updateIsland(s, NAXOS, (i) => ({ ...i, ownerId: P2 }));
    assert.ok(violationCodes(wrongOwner).includes('FORCE'));

    const asymmetric = updateSea(s, SEA_NORTH, (sea) => ({
      ...sea,
      adjacentIslands: sea.adjacentIslands.filter((id) => id !== NAXOS),
    }));
    assert.ok(violationCodes(asymmetric).includes('GRAPH'));

    const philosophers = updatePlayer(s, P1, (p) => ({ ...p, philosophers: 4 }));
    assert.ok(violationCodes(philosophers).includes('PLAYER_RESOURCES'));

    assert.throws(() => assertValidGameState(extraTroop), InvalidGameStateError);
  });
});
