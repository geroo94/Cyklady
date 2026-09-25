/**
 * @file Silnik bitwy (podstan BATTLE_RESOLUTION): podstawka, Hades i Monumenty.
 *
 * ZASADY
 *  1. Wynik strony = rzut kością bitewną (0, 1, 1, 2, 2, 3) + liczba jednostek
 *     + modyfikatory.
 *     - Jednostki: oddziały albo floty, nieumarli i siła herosów.
 *     - Obrona lądu: +1 za każdą Fortecę na wyspie (Metropolia liczy się jak
 *       Forteca). Ulisses po stronie atakującego ignoruje te premie.
 *     - Obrona morza: +1 za każdy Port na sąsiednich wyspach obrońcy
 *       (Metropolia liczy się jak Port).
 *     - Port Wojenny (Monument) na bronionej wyspie: floty obrońcy na polach
 *       wokół wyspy liczą się jak oddziały.
 *     - Wielka Cytadela Aresa (Monument): atak blokuje już walidacja ruchu
 *       (`attackBlocker`), więc taka bitwa w ogóle się nie zaczyna.
 *  2. Runda: niższy wynik traci 1 jednostkę, a przy remisie obie strony tracą po 1.
 *  3. Odwrót: po rundzie decydują strony w kolejności `rules.combat.retreatOrder`
 *     (domyślnie obrońca, potem atakujący).
 *     - Ląd: przez łańcuch własnych flot na własną albo niczyją wyspę.
 *     - Morze: na sąsiednie pole własne albo puste.
 *  4. Pętla trwa, aż jedna strona zniknie z pola bitwy albo się wycofa.
 *
 * KROKI (`BattleState.step`)
 *
 *   ROLL ─► obie strony żyją ─► DEFENDER_RETREAT_DECISION ─► ATTACKER_RETREAT_DECISION ─► ROLL
 *    │                               │ odwrót                      │ odwrót
 *    └─► ktoś zniknął ─────────────► CLEANUP ◄─────────────────────┘
 *                                      └─► FINISHED ─► powrót do ACTIONS (endBattle)
 *
 *  Krok decyzji jest pomijany, gdy strona nie ma dokąd się wycofać.
 *
 * GWARANCJA ZAKOŃCZENIA: każda runda usuwa co najmniej jedną jednostkę, więc
 * bitwa trwa najwyżej tyle rund, ile jednostek mają łącznie obie strony.
 *
 * Założenia modelu [zweryfikuj]:
 *  - Kolejność strat: najpierw nieumarli, potem zwykłe jednostki, na końcu
 *    herosi (od najsłabszego).
 *  - Floty wspierające z Portu Wojennego zwiększają wynik obrońcy, ale
 *    zostają na morzu i nie giną w bitwie lądowej.
 */

import {
  endBattle,
  expectPhase,
  getIsland,
  getPlayer,
  getSea,
  isIslandId,
  isSeaId,
  rollDie,
  sidePresence,
  type BattleOutcome,
  type BattleRole,
  type BattleRound,
  type BattleSide,
  type BattleState,
  type BattleStep,
  type BoardGraph,
  type Casualty,
  type GameState,
  type HeroId,
  type HeroState,
  type IslandNode,
  type LandForce,
  type NavalForce,
  type NodeId,
  type Phase,
  type PhaseHooks,
  type PlayerId,
  type RngState,
  type ScoreBreakdown,
  type ScoreModifier,
} from '../model/index.ts';
import { mergeLandForces, mergeNavalForces, replaceIsland, replaceSea } from './boardOps.ts';
import { COMBAT_EFFECTS, heroCard, heroHasAbility, monumentEffect } from './effects.ts';
import { dispatchUnitsDestroyed } from './expansions/registry.ts';
import { troopReach } from './pathfinding.ts';

// ===========================================================================
// Komendy, zdarzenia, odrzucenia
// ===========================================================================

export type BattleCommand =
  /** Rzut kośćmi i rozstrzygnięcie rundy (serwer). */
  | { readonly type: 'ROLL' }
  /** Decyzja gracza: walczę dalej. */
  | { readonly type: 'HOLD'; readonly playerId: PlayerId }
  /** Decyzja gracza: wycofuję się na wskazany węzeł. */
  | { readonly type: 'RETREAT'; readonly playerId: PlayerId; readonly to: NodeId }
  /** Odstawienie ocalałych na planszę i powrót do tury (serwer). */
  | { readonly type: 'CLEANUP' };

export type BattleEvent =
  | { readonly type: 'ROUND_RESOLVED'; readonly round: BattleRound }
  | { readonly type: 'RETREAT_DECLINED'; readonly role: BattleRole; readonly playerId: PlayerId }
  | { readonly type: 'RETREATED'; readonly role: BattleRole; readonly playerId: PlayerId; readonly to: NodeId }
  | { readonly type: 'BATTLE_DECIDED'; readonly outcome: BattleOutcome }
  | { readonly type: 'BATTLE_ENDED'; readonly outcome: BattleOutcome };

export type BattleRejection =
  | { readonly code: 'NO_BATTLE'; readonly phase: Phase }
  | { readonly code: 'WRONG_STEP'; readonly step: BattleStep; readonly command: BattleCommand['type'] }
  | { readonly code: 'NOT_YOUR_DECISION'; readonly expected: PlayerId }
  | { readonly code: 'INVALID_RETREAT'; readonly to: NodeId; readonly options: readonly NodeId[] };

export type BattleStepOutcome =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly BattleEvent[] }
  | { readonly ok: false; readonly error: BattleRejection };

const fail = (error: BattleRejection): BattleStepOutcome => ({ ok: false, error });
const done = (state: GameState, events: readonly BattleEvent[]): BattleStepOutcome => ({ ok: true, state, events });

export class CombatError extends Error {
  readonly rejection: BattleRejection;

  constructor(rejection: BattleRejection) {
    super(describeBattleRejection(rejection));
    this.name = 'CombatError';
    this.rejection = rejection;
  }
}

// ===========================================================================
// Główne wejście: jeden krok bitwy
// ===========================================================================

/**
 * Wykonuje jeden krok bitwy. Bieżący krok (`battle.step`) wyznacza, jaka
 * komenda jest dozwolona i która funkcja kroku ją obsłuży:
 *
 *  - ROLL: `{ type: 'ROLL' }` rzuca kośćmi i rozstrzyga rundę,
 *  - *_RETREAT_DECISION: `HOLD` albo `RETREAT` od gracza, który decyduje,
 *  - CLEANUP: `{ type: 'CLEANUP' }` odstawia ocalałych i kończy bitwę.
 */
export function stepBattle(state: GameState, command: BattleCommand, hooks?: PhaseHooks): BattleStepOutcome {
  const phase = state.phase;
  if (phase.phase !== 'BATTLE_RESOLUTION') return fail({ code: 'NO_BATTLE', phase: phase.phase });
  const { battle } = phase;
  const wrongStep = (): BattleStepOutcome => fail({ code: 'WRONG_STEP', step: battle.step, command: command.type });

  switch (battle.step) {
    case 'ROLL':
      return command.type === 'ROLL' ? rollStep(state, battle) : wrongStep();
    case 'DEFENDER_RETREAT_DECISION':
    case 'ATTACKER_RETREAT_DECISION':
      return command.type === 'HOLD' || command.type === 'RETREAT' ? retreatStep(state, battle, command) : wrongStep();
    case 'CLEANUP':
      return command.type === 'CLEANUP' ? cleanupStep(state, battle, hooks) : wrongStep();
    case 'FINISHED':
      return wrongStep();
  }
}

// ===========================================================================
// Krok rzutu
// ===========================================================================

/** Rzut kością bitewną: każda ścianka jest równie prawdopodobna. */
export function rollBattleDie(rng: RngState, faces: readonly number[]): [value: number, rng: RngState] {
  return rollDie(rng, faces);
}

function rollStep(state: GameState, battle: BattleState): BattleStepOutcome {
  const faces = state.rules.combat.dieFaces;
  const [attackerRoll, afterAttacker] = rollBattleDie(state.rng, faces);
  const [defenderRoll, rng] = rollBattleDie(afterAttacker, faces);
  const attackerScore = battleScore(state, battle, 'ATTACKER', attackerRoll);
  const defenderScore = battleScore(state, battle, 'DEFENDER', defenderRoll);

  // Niższy wynik traci jednostkę, a przy remisie tracą obie strony.
  let s: GameState = { ...state, rng };
  let attacker = battle.attacker;
  let defender = battle.defender;
  let attackerCasualty: Casualty | null = null;
  let defenderCasualty: Casualty | null = null;
  if (attackerScore.total <= defenderScore.total) {
    const hit = takeCasualty(s, battle, attacker);
    [s, attacker, attackerCasualty] = [hit.state, hit.side, hit.casualty];
  }
  if (defenderScore.total <= attackerScore.total) {
    const hit = takeCasualty(s, battle, defender);
    [s, defender, defenderCasualty] = [hit.state, hit.side, hit.casualty];
  }

  const round: BattleRound = {
    round: battle.rounds.length + 1,
    attacker: { score: attackerScore, casualty: attackerCasualty },
    defender: { score: defenderScore, casualty: defenderCasualty },
  };
  const events: BattleEvent[] = [{ type: 'ROUND_RESOLVED', round }];
  const afterRound: BattleState = { ...battle, attacker, defender, rounds: [...battle.rounds, round] };

  const outcome = outcomeAfterRound(attacker, defender);
  if (outcome !== null) {
    events.push({ type: 'BATTLE_DECIDED', outcome });
    return done(withBattle(s, { ...afterRound, step: 'CLEANUP', outcome }), events);
  }
  return done(withBattle(s, { ...afterRound, step: nextStepAfter(s, afterRound, null) }), events);
}

/** Wynik po rundzie albo `null`, gdy obie strony wciąż stoją na polu bitwy. */
function outcomeAfterRound(attacker: BattleSide, defender: BattleSide): BattleOutcome | null {
  const attackerAlive = sidePresence(attacker) > 0;
  const defenderAlive = sidePresence(defender) > 0;
  if (!attackerAlive && !defenderAlive) return { kind: 'MUTUAL_DESTRUCTION' };
  if (!defenderAlive) return { kind: 'ATTACKER_WON' };
  if (!attackerAlive) return { kind: 'DEFENDER_WON' };
  return null;
}

/**
 * Składniki wyniku strony dla danego rzutu. Liczone w każdej rundzie od nowa,
 * bo zmieniają się wraz ze stratami, np. gdy zginie Ulisses, Fortece obrońcy
 * znowu się liczą. UI może wywołać tę funkcję z `roll = 0`, żeby pokazać siły
 * przed rzutem.
 */
export function battleScore(state: GameState, battle: BattleState, role: BattleRole, roll: number): ScoreBreakdown {
  const side = role === 'ATTACKER' ? battle.attacker : battle.defender;
  const opponent = role === 'ATTACKER' ? battle.defender : battle.attacker;
  const units = side.units + side.undead;
  const modifiers: ScoreModifier[] = side.heroes.map((heroId) => ({ source: 'HERO', heroId, value: heroCard(state, heroId).strength }));
  const heroes = sumOf(modifiers);
  let supportFleets = 0;
  let fortifications = 0;
  let fortificationsIgnored = false;

  if (role === 'DEFENDER' && battle.location.kind === 'LAND') {
    const island = getIsland(state.board, battle.location.islandId);
    if (monumentEffect(state, island) === COMBAT_EFFECTS.FLEETS_DEFEND_LAND) {
      const support = island.adjacentSeas.flatMap((seaId): ScoreModifier[] => {
        const fleet = getSea(state.board, seaId).fleet;
        return fleet?.playerId === side.playerId ? [{ source: 'WAR_PORT', seaId, value: fleet.fleets + fleet.undeadFleets }] : [];
      });
      supportFleets = sumOf(support);
      modifiers.push(...support);
    }
    const walls = fortificationsOn(state, island, 'FORTRESS');
    const fortresses = sumOf(walls);
    const ulysses = fortresses > 0 ? opponent.heroes.find((heroId) => heroHasAbility(state, heroId, COMBAT_EFFECTS.IGNORE_FORTIFICATIONS)) : undefined;
    fortificationsIgnored = ulysses !== undefined;
    fortifications = fortificationsIgnored ? 0 : fortresses;
    modifiers.push(...walls);
    if (ulysses !== undefined) modifiers.push({ source: 'FORTIFICATIONS_IGNORED', heroId: ulysses, value: -fortresses });
  } else if (role === 'DEFENDER' && battle.location.kind === 'SEA') {
    const sea = getSea(state.board, battle.location.seaId);
    const ports = sea.adjacentIslands.flatMap((islandId) => {
      const island = getIsland(state.board, islandId);
      return island.ownerId === side.playerId ? fortificationsOn(state, island, 'PORT') : [];
    });
    fortifications = sumOf(ports);
    modifiers.push(...ports);
  }
  if (side.bonus !== 0) modifiers.push({ source: 'CARD_BONUS', value: side.bonus });

  const total = roll + units + heroes + supportFleets + fortifications + side.bonus;
  return { roll, units, heroes, supportFleets, fortifications, fortificationsIgnored, bonus: side.bonus, total, modifiers };
}

const sumOf = (modifiers: readonly ScoreModifier[]): number => modifiers.reduce((sum, modifier) => sum + modifier.value, 0);

/**
 * Fortece albo Porty na wyspie jako pozycje raportu. Metropolia liczy się
 * jak komplet `rules.metropolisBuildingSet`, więc daje osobną pozycję.
 */
function fortificationsOn(state: GameState, island: IslandNode, type: 'FORTRESS' | 'PORT'): ScoreModifier[] {
  const built = island.buildingSlots.filter((slot) => slot.building === type).length;
  const metropolis = island.metropolisSlot.metropolis !== null && state.rules.metropolisBuildingSet.includes(type);
  return [
    ...(built > 0 ? [{ source: type, islandId: island.id, value: built } as const] : []),
    ...(metropolis ? [{ source: 'METROPOLIS', islandId: island.id, countsAs: type, value: 1 } as const] : []),
  ];
}

/**
 * Strata jednej jednostki: najpierw nieumarli (wracają do puli Hadesa), potem
 * zwykłe jednostki (do zapasu gracza), na końcu najsłabszy heros. Poległy
 * heros opuszcza grę, a jego karta trafia na stos odrzuconych.
 */
function takeCasualty(
  state: GameState,
  battle: BattleState,
  side: BattleSide,
): { state: GameState; side: BattleSide; casualty: Casualty } {
  const land = battle.location.kind === 'LAND';
  if (side.undead > 0) {
    const hades = state.hades;
    if (!hades) throw new Error('Nieumarli w bitwie bez dodatku Hades');
    const undeadSupply = land
      ? { ...hades.undeadSupply, troops: hades.undeadSupply.troops + 1 }
      : { ...hades.undeadSupply, fleets: hades.undeadSupply.fleets + 1 };
    return { state: { ...state, hades: { ...hades, undeadSupply } }, side: { ...side, undead: side.undead - 1 }, casualty: { kind: 'UNDEAD' } };
  }
  if (side.units > 0) {
    const player = getPlayer(state, side.playerId);
    const reserve = land
      ? { ...player.reserve, troops: player.reserve.troops + 1 }
      : { ...player.reserve, fleets: player.reserve.fleets + 1 };
    const returned: GameState = { ...state, players: { ...state.players, [player.id]: { ...player, reserve } } };
    const where = battle.location.kind === 'LAND' ? battle.location.islandId : battle.location.seaId;
    return {
      // Zniszczona zwykła jednostka to zdarzenie dla dodatków (np. JZ na Nekropoliach).
      state: dispatchUnitsDestroyed(returned, { playerId: player.id, kind: land ? 'TROOP' : 'FLEET', count: 1, where }),
      side: { ...side, units: side.units - 1 },
      casualty: { kind: 'UNIT' },
    };
  }
  const heroId = weakestHero(state, side.heroes);
  const hero = heroId === null ? undefined : state.heroes[heroId];
  if (heroId === null || !hero) throw new Error(`Strona ${side.playerId} nie ma już jednostek, które mogłyby polec`);
  const heroes = Object.fromEntries(Object.entries(state.heroes).filter(([id]) => id !== heroId)) as Record<HeroId, HeroState>;
  return {
    state: {
      ...state,
      heroes,
      creatureMarket: { ...state.creatureMarket, discard: [...state.creatureMarket.discard, hero.cardId] },
    },
    side: { ...side, heroes: side.heroes.filter((id) => id !== heroId) },
    casualty: { kind: 'HERO', heroId },
  };
}

function weakestHero(state: GameState, heroes: readonly HeroId[]): HeroId | null {
  let weakest: HeroId | null = null;
  for (const heroId of heroes) {
    if (weakest === null || heroCard(state, heroId).strength < heroCard(state, weakest).strength) weakest = heroId;
  }
  return weakest;
}

// ===========================================================================
// Krok decyzji o wycofaniu
// ===========================================================================

export interface PendingRetreatDecision {
  readonly role: BattleRole;
  readonly playerId: PlayerId;
  /** Dozwolone cele odwrotu (zawsze niepuste, bo strona bez celu jest pomijana). */
  readonly options: readonly NodeId[];
}

const decisionRole = (step: BattleStep): BattleRole | null =>
  step === 'DEFENDER_RETREAT_DECISION' ? 'DEFENDER' : step === 'ATTACKER_RETREAT_DECISION' ? 'ATTACKER' : null;

/** Decyzja, na którą czeka bitwa, albo `null` w innych krokach. */
export function pendingDecision(state: GameState): PendingRetreatDecision | null {
  if (state.phase.phase !== 'BATTLE_RESOLUTION') return null;
  const { battle } = state.phase;
  const role = decisionRole(battle.step);
  if (role === null) return null;
  const side = role === 'ATTACKER' ? battle.attacker : battle.defender;
  return { role, playerId: side.playerId, options: retreatOptions(state, battle, role) };
}

/**
 * Dokąd strona może się wycofać.
 *  - Ląd: wyspy osiągalne łańcuchem własnych flot z wyspy bitwy, które należą
 *    do gracza albo są niczyje (odwrót nie może być atakiem).
 *  - Morze: sąsiednie pola morskie puste albo z własną flotą.
 */
export function retreatOptions(state: GameState, battle: BattleState, role: BattleRole): NodeId[] {
  const side = role === 'ATTACKER' ? battle.attacker : battle.defender;
  const { board } = state;
  if (battle.location.kind === 'LAND') {
    return troopReach(board, side.playerId, battle.location.islandId)
      .map((route) => route.island)
      .filter((islandId) => {
        const owner = getIsland(board, islandId).ownerId;
        return owner === side.playerId || owner === null;
      });
  }
  return getSea(board, battle.location.seaId).adjacentSeas.filter((seaId) => {
    const fleet = getSea(board, seaId).fleet;
    return fleet === null || fleet.playerId === side.playerId;
  });
}

/** Następny krok po rundzie albo po decyzji `decided`: kolejna strona z celem odwrotu albo nowa runda. */
function nextStepAfter(state: GameState, battle: BattleState, decided: BattleRole | null): BattleStep {
  const order = state.rules.combat.retreatOrder;
  const start = decided === null ? 0 : order.indexOf(decided) + 1;
  for (const role of order.slice(start)) {
    if (retreatOptions(state, battle, role).length > 0) {
      return role === 'DEFENDER' ? 'DEFENDER_RETREAT_DECISION' : 'ATTACKER_RETREAT_DECISION';
    }
  }
  return 'ROLL';
}

function retreatStep(
  state: GameState,
  battle: BattleState,
  command: Extract<BattleCommand, { type: 'HOLD' | 'RETREAT' }>,
): BattleStepOutcome {
  const role = decisionRole(battle.step);
  if (role === null) throw new Error(`Krok ${battle.step} nie jest krokiem decyzji`);
  const side = role === 'ATTACKER' ? battle.attacker : battle.defender;
  if (command.playerId !== side.playerId) return fail({ code: 'NOT_YOUR_DECISION', expected: side.playerId });

  if (command.type === 'HOLD') {
    return done(withBattle(state, { ...battle, step: nextStepAfter(state, battle, role) }), [
      { type: 'RETREAT_DECLINED', role, playerId: side.playerId },
    ]);
  }
  const options = retreatOptions(state, battle, role);
  if (!options.includes(command.to)) return fail({ code: 'INVALID_RETREAT', to: command.to, options });
  const outcome: BattleOutcome =
    role === 'ATTACKER' ? { kind: 'ATTACKER_RETREATED', to: command.to } : { kind: 'DEFENDER_RETREATED', to: command.to };
  return done(withBattle(state, { ...battle, step: 'CLEANUP', outcome }), [
    { type: 'RETREATED', role, playerId: side.playerId, to: command.to },
    { type: 'BATTLE_DECIDED', outcome },
  ]);
}

// ===========================================================================
// Krok sprzątania
// ===========================================================================

/**
 * Odstawia ocalałych na planszę według wyniku i wraca do przerwanej tury:
 *  - zwycięzca zajmuje pole bitwy (zdobyta wyspa zmienia właściciela razem
 *    z budynkami i Metropolią),
 *  - wycofujący się trafia na wskazany węzeł, a przeciwnik zostaje na polu bitwy,
 *  - przy wzajemnym zniszczeniu pole zostaje puste, a wyspa zachowuje właściciela.
 */
function cleanupStep(state: GameState, battle: BattleState, hooks?: PhaseHooks): BattleStepOutcome {
  const { outcome, attacker, defender } = battle;
  if (outcome === null) throw new Error('Krok CLEANUP wymaga rozstrzygniętej bitwy');
  let board = state.board;
  switch (outcome.kind) {
    case 'ATTACKER_WON':
      board = occupyBattlefield(board, battle, attacker);
      break;
    case 'DEFENDER_WON':
      board = occupyBattlefield(board, battle, defender);
      break;
    case 'ATTACKER_RETREATED':
      board = occupyBattlefield(placeRetreat(board, battle, attacker, outcome.to), battle, defender);
      break;
    case 'DEFENDER_RETREATED':
      board = occupyBattlefield(placeRetreat(board, battle, defender, outcome.to), battle, attacker);
      break;
    case 'MUTUAL_DESTRUCTION':
      break;
  }
  const emptied = (side: BattleSide): BattleSide => ({ ...side, units: 0, undead: 0, heroes: [] });
  const finished: BattleState = { ...battle, attacker: emptied(attacker), defender: emptied(defender), step: 'FINISHED' };
  return done(endBattle(withBattle({ ...state, board }, finished), hooks), [{ type: 'BATTLE_ENDED', outcome }]);
}

const landForceOf = (side: BattleSide): LandForce => ({
  playerId: side.playerId,
  troops: side.units,
  undeadTroops: side.undead,
  heroes: side.heroes,
});
const navalForceOf = (side: BattleSide): NavalForce => ({ playerId: side.playerId, fleets: side.units, undeadFleets: side.undead });

/** Strona zostaje na polu bitwy. Na lądzie staje się właścicielem wyspy. */
function occupyBattlefield(board: BoardGraph, battle: BattleState, side: BattleSide): BoardGraph {
  if (battle.location.kind === 'LAND') {
    const island = getIsland(board, battle.location.islandId);
    return replaceIsland(board, { ...island, ownerId: side.playerId, garrison: landForceOf(side) });
  }
  const sea = getSea(board, battle.location.seaId);
  return replaceSea(board, { ...sea, fleet: navalForceOf(side) });
}

/** Strona wycofuje się na węzeł `to`: dołącza do własnych sił albo zajmuje wyspę niczyją. */
function placeRetreat(board: BoardGraph, battle: BattleState, side: BattleSide, to: NodeId): BoardGraph {
  if (battle.location.kind === 'LAND') {
    if (!isIslandId(board, to)) throw new Error(`Cel odwrotu z lądu musi być wyspą: ${to}`);
    const island = getIsland(board, to);
    return replaceIsland(board, {
      ...island,
      ownerId: side.playerId,
      garrison: mergeLandForces(island.garrison, landForceOf(side)),
    });
  }
  if (!isSeaId(board, to)) throw new Error(`Cel odwrotu z morza musi być polem morskim: ${to}`);
  const sea = getSea(board, to);
  return replaceSea(board, { ...sea, fleet: mergeNavalForces(sea.fleet, navalForceOf(side)) });
}

function withBattle(state: GameState, battle: BattleState): GameState {
  const phase = expectPhase(state, 'BATTLE_RESOLUTION');
  return { ...state, revision: state.revision + 1, phase: { ...phase, battle } };
}

// ===========================================================================
// Pętla bitwy
// ===========================================================================

/** Strategia decyzji o odwrocie: cel odwrotu albo `null` (walczę dalej). */
export type RetreatDecider = (state: GameState, decision: PendingRetreatDecision) => NodeId | null;

export interface BattleRun {
  readonly state: GameState;
  readonly events: readonly BattleEvent[];
  readonly steps: number;
}

/**
 * Górne ograniczenie liczby kroków bitwy: każda runda to rzut i najwyżej
 * jedna decyzja każdej strony, rund jest najwyżej tyle, ile jednostek,
 * a na końcu jest jeszcze sprzątanie.
 */
export function battleStepLimit(state: GameState): number {
  if (state.phase.phase !== 'BATTLE_RESOLUTION') return 0;
  const { battle } = state.phase;
  const rounds = sidePresence(battle.attacker) + sidePresence(battle.defender);
  return rounds * (1 + state.rules.combat.retreatOrder.length) + 1;
}

/**
 * Prowadzi bitwę do końca i wraca do fazy ACTIONS. Rzuty i sprzątanie
 * wykonuje sam, a o odwrocie pyta `decide` (domyślnie: walka do końca).
 * `hooks` (zwykle `CYCLE_HOOKS`) trafiają do przejścia z powrotem do ACTIONS.
 */
export function runBattle(state: GameState, decide: RetreatDecider = () => null, hooks?: PhaseHooks): BattleRun {
  const limit = battleStepLimit(state);
  const events: BattleEvent[] = [];
  let current = state;
  for (let steps = 0; current.phase.phase === 'BATTLE_RESOLUTION'; steps++) {
    if (steps >= limit) throw new Error(`Bitwa nie zakończyła się w ${limit} krokach (błąd silnika)`);
    const { battle } = current.phase;
    let command: BattleCommand;
    const decision = pendingDecision(current);
    if (decision !== null) {
      const to = decide(current, decision);
      command = to === null ? { type: 'HOLD', playerId: decision.playerId } : { type: 'RETREAT', playerId: decision.playerId, to };
    } else {
      command = battle.step === 'CLEANUP' ? { type: 'CLEANUP' } : { type: 'ROLL' };
    }
    const outcome = stepBattle(current, command, hooks);
    if (!outcome.ok) throw new CombatError(outcome.error);
    current = outcome.state;
    events.push(...outcome.events);
    if (current.phase.phase !== 'BATTLE_RESOLUTION') return { state: current, events, steps: steps + 1 };
  }
  return { state: current, events, steps: 0 };
}

// ===========================================================================
// Komunikaty
// ===========================================================================

export function describeBattleRejection(error: BattleRejection): string {
  switch (error.code) {
    case 'NO_BATTLE':
      return `Nie trwa żadna bitwa (faza: ${error.phase}).`;
    case 'WRONG_STEP':
      return `W kroku bitwy ${error.step} nie można wykonać komendy ${error.command}.`;
    case 'NOT_YOUR_DECISION':
      return `O odwrocie decyduje teraz gracz ${error.expected}.`;
    case 'INVALID_RETREAT':
      return error.options.length === 0
        ? `Nie można wycofać się na ${error.to}: brak dozwolonych celów odwrotu.`
        : `Nie można wycofać się na ${error.to}. Dozwolone cele: ${error.options.join(', ')}.`;
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}
