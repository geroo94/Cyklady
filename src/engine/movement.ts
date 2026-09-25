/**
 * @file Walidacja i wykonanie ruchów jednostek: floty (Posejdon) i oddziały (Ares).
 *
 * Dwa poziomy API:
 *  - `planFleetMove` / `planTroopMove` sprawdzają sam ruch (trasę, liczebność,
 *    most z flot, regułę ostatniej wyspy) bez tury i kosztu. Zwracają plan
 *    ruchu, który nadaje się do podglądu w UI i do efektów kart.
 *  - `moveFleets` / `moveTroops` to pełna akcja w fazie ACTIONS: tura
 *    właściwego boga, koszt ruchu, wykonanie, licznik ruchów w turze
 *    i ewentualne wejście w podstan BATTLE_RESOLUTION.
 *
 * Tak jak w licytacji, błędy walidacji są wartościami (`{ ok: false, error }`),
 * a wyjątki oznaczają wyłącznie uszkodzony stan albo błąd programisty.
 *
 * Założenia modelu (opisane w NAWIGACJA.md):
 *  - Ruch Posejdona przenosi zwykłe floty. Nieumarłe floty zostają na
 *    miejscu, a most dla wojsk tworzy dowolna flota gracza, także nieumarła.
 *  - Trasa może wracać na odwiedzone pola. Zabieranie i zostawianie liczy
 *    się dynamicznie, według floty stojącej na polu w chwili przejścia grupy.
 *  - Premie bitewne (porty, fortece, Monumenty, herosi) wylicza w każdej
 *    rundzie silnik bitwy (`combat.ts`), więc tutaj `bonus` = 0.
 *  - Atak na wyspę chronioną Wielką Cytadelą Aresa jest odrzucany już tutaj
 *    (`ATTACK_BLOCKED`), więc bitwa w ogóle się nie zaczyna.
 */

import {
  BattleId,
  beginBattle,
  countMetropolises,
  getIsland,
  getPlayer,
  getSea,
  islandsOwnedBy,
  type BattleState,
  type GameState,
  type God,
  type HeroId,
  type IslandId,
  type LandForce,
  type MonumentCardId,
  type PlayerId,
  type SeaId,
  type SeaNode,
} from '../model/index.ts';
import { adjustFleets, mergeLandForces, replaceIsland, replaceSea } from './boardOps.ts';
import { attackBlocker } from './effects.ts';
import { charge, checkGodTurn, describeTurnRejection, updateTurnProgress, type TurnRejection } from './turns.ts';
import { findFleetBridge } from './pathfinding.ts';

// ===========================================================================
// Komendy i plany
// ===========================================================================

/** Kolejne pole trasy floty. */
export interface FleetStep {
  readonly to: SeaId;
  /** Zabierz tyle własnych flot stojących na tym polu (tylko pole pośrednie). */
  readonly pickUp?: number;
  /** Zostaw tyle flot z grupy na tym polu (tylko pole pośrednie). */
  readonly dropOff?: number;
}

export interface FleetMoveCommand {
  readonly playerId: PlayerId;
  readonly from: SeaId;
  /** Ile flot wyrusza z pola startowego (reszta zostaje). */
  readonly count: number;
  /** Trasa: od 1 do `rules.movement.fleetRange` kroków na sąsiednie pola. */
  readonly route: readonly FleetStep[];
}

/** Grupa wojsk przerzucana między wyspami. */
export interface LandGroup {
  readonly troops: number;
  readonly undeadTroops: number;
  readonly heroes: readonly HeroId[];
}

export interface TroopMoveCommand {
  readonly playerId: PlayerId;
  readonly from: IslandId;
  readonly to: IslandId;
  readonly troops: number;
  readonly undeadTroops?: number;
  readonly heroes?: readonly HeroId[];
}

/** Netto zmiana liczby własnych flot gracza na polu trasy. */
export interface FleetChange {
  readonly sea: SeaId;
  readonly delta: number;
}

export interface FleetMovePlan {
  /** Pełna trasa: `[start, ...pola trasy]`. Ostatnie pole jest docelowe. */
  readonly path: readonly SeaId[];
  readonly departing: number;
  /** Liczebność grupy na polu docelowym (po zabraniu i zostawieniu flot po drodze). */
  readonly arriving: number;
  /** Zmiany na polach trasy wynikające z wypłynięcia, zabrania i zostawienia flot (bez przybycia). */
  readonly changes: readonly FleetChange[];
  /** Właściciel obcej floty na polu docelowym, czyli bitwa morska, albo `null`. */
  readonly defender: PlayerId | null;
}

/** Skutek lądowania wojsk. */
export type LandingKind =
  /** Posiłki na własną wyspę. */
  | 'REINFORCE'
  /** Zajęcie wyspy niczyjej. */
  | 'COLONIZE'
  /** Zajęcie pustej wyspy przeciwnika (bez bitwy). */
  | 'CAPTURE'
  /** Atak na wyspę z wojskami przeciwnika, czyli bitwa lądowa. */
  | 'ATTACK';

export interface TroopMovePlan {
  /** Łańcuch pól z flotami gracza, po którym przechodzą wojska. */
  readonly bridge: readonly SeaId[];
  readonly landing: LandingKind;
  /** Właściciel wyspy docelowej przy CAPTURE i ATTACK. */
  readonly defender: PlayerId | null;
  readonly group: LandGroup;
}

// ===========================================================================
// Odrzucenia i wyniki
// ===========================================================================

export type MoveRejection =
  // Tura i koszt
  | TurnRejection
  | { readonly code: 'CANNOT_AFFORD'; readonly cost: number; readonly gold: number }
  | { readonly code: 'INVALID_NUMBER'; readonly field: string; readonly value: number }
  // Floty
  | { readonly code: 'UNKNOWN_SEA'; readonly sea: SeaId }
  | { readonly code: 'NO_OWN_FLEET'; readonly sea: SeaId }
  | { readonly code: 'NOT_ENOUGH_FLEETS'; readonly sea: SeaId; readonly requested: number; readonly available: number }
  | { readonly code: 'ROUTE_LENGTH'; readonly length: number; readonly max: number }
  | { readonly code: 'NOT_ADJACENT'; readonly from: SeaId; readonly to: SeaId }
  | { readonly code: 'ROUTE_CONTINUES_AFTER_BATTLE'; readonly sea: SeaId }
  | { readonly code: 'WAYPOINT_AT_DESTINATION'; readonly sea: SeaId }
  | { readonly code: 'AMBIGUOUS_WAYPOINT'; readonly sea: SeaId }
  | { readonly code: 'GROUP_WOULD_BE_EMPTY'; readonly sea: SeaId }
  // Wojska
  | { readonly code: 'UNKNOWN_ISLAND'; readonly island: IslandId }
  | { readonly code: 'SAME_ISLAND'; readonly island: IslandId }
  | { readonly code: 'NO_OWN_TROOPS'; readonly island: IslandId }
  | { readonly code: 'EMPTY_GROUP' }
  | {
      readonly code: 'NOT_ENOUGH_TROOPS';
      readonly island: IslandId;
      readonly kind: 'TROOPS' | 'UNDEAD_TROOPS';
      readonly requested: number;
      readonly available: number;
    }
  | { readonly code: 'HERO_NOT_ON_ISLAND'; readonly hero: HeroId; readonly island: IslandId }
  | { readonly code: 'NO_FLEET_BRIDGE'; readonly from: IslandId; readonly to: IslandId }
  | { readonly code: 'ATTACK_BLOCKED'; readonly island: IslandId; readonly monument: MonumentCardId }
  | {
      readonly code: 'LAST_ISLAND_PROTECTED';
      readonly island: IslandId;
      readonly defender: PlayerId;
      /** Metropolie atakującego po ewentualnym zdobyciu wyspy. */
      readonly metropolisesAfter: number;
      readonly required: number;
    };

export type PlanOutcome<T> = { readonly ok: true; readonly plan: T } | { readonly ok: false; readonly error: MoveRejection };

export type MoveOutcome<T> =
  | { readonly ok: true; readonly state: GameState; readonly plan: T; readonly battle: BattleId | null }
  | { readonly ok: false; readonly error: MoveRejection };

const fail = (error: MoveRejection): { readonly ok: false; readonly error: MoveRejection } => ({ ok: false, error });
const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;
const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

// ===========================================================================
// Ruch flot (Posejdon)
// ===========================================================================

/**
 * Waliduje ruch grupy flot i wylicza jego skutki (bez tury i kosztu).
 *
 * Symulacja idzie krok po kroku. Grupa wypływa z pola startowego, na każdym
 * polu pośrednim może zabrać własne floty albo zostawić część swoich, a na
 * polu docelowym staje. Wejście na pole z obcą flotą musi być ostatnim
 * krokiem, bo tam zaczyna się bitwa morska.
 */
export function planFleetMove(state: GameState, command: FleetMoveCommand): PlanOutcome<FleetMovePlan> {
  const { board } = state;
  const { playerId } = command;
  if (!Object.hasOwn(state.players, playerId)) return fail({ code: 'UNKNOWN_PLAYER', playerId });

  const origin = board.seas[command.from];
  if (!origin) return fail({ code: 'UNKNOWN_SEA', sea: command.from });
  const originFleet = origin.fleet;
  if (originFleet === null || originFleet.playerId !== playerId) return fail({ code: 'NO_OWN_FLEET', sea: origin.id });
  if (!isPositiveInteger(command.count)) return fail({ code: 'INVALID_NUMBER', field: 'count', value: command.count });
  if (command.count > originFleet.fleets) {
    return fail({ code: 'NOT_ENOUGH_FLEETS', sea: origin.id, requested: command.count, available: originFleet.fleets });
  }
  const max = state.rules.movement.fleetRange;
  if (command.route.length < 1 || command.route.length > max) {
    return fail({ code: 'ROUTE_LENGTH', length: command.route.length, max });
  }

  // Netto zmiany własnych flot na polach trasy, które decydują o dostępności przy zabieraniu.
  const delta = new Map<SeaId, number>([[origin.id, -command.count]]);
  const ownFleetsAt = (sea: SeaNode): number =>
    (sea.fleet?.playerId === playerId ? sea.fleet.fleets : 0) + (delta.get(sea.id) ?? 0);

  const path: SeaId[] = [origin.id];
  let group = command.count;
  let current = origin;
  let defender: PlayerId | null = null;

  for (const [index, step] of command.route.entries()) {
    const next = board.seas[step.to];
    if (!next) return fail({ code: 'UNKNOWN_SEA', sea: step.to });
    if (!current.adjacentSeas.includes(next.id)) return fail({ code: 'NOT_ADJACENT', from: current.id, to: next.id });
    const pickUp = step.pickUp ?? 0;
    const dropOff = step.dropOff ?? 0;
    if (!isCount(pickUp)) return fail({ code: 'INVALID_NUMBER', field: 'pickUp', value: pickUp });
    if (!isCount(dropOff)) return fail({ code: 'INVALID_NUMBER', field: 'dropOff', value: dropOff });

    const isLast = index === command.route.length - 1;
    const enemy = next.fleet !== null && next.fleet.playerId !== playerId ? next.fleet : null;
    if (enemy && !isLast) return fail({ code: 'ROUTE_CONTINUES_AFTER_BATTLE', sea: next.id });
    path.push(next.id);

    if (isLast) {
      if (pickUp > 0 || dropOff > 0) return fail({ code: 'WAYPOINT_AT_DESTINATION', sea: next.id });
      defender = enemy?.playerId ?? null;
    } else {
      if (pickUp > 0 && dropOff > 0) return fail({ code: 'AMBIGUOUS_WAYPOINT', sea: next.id });
      if (dropOff > group) return fail({ code: 'NOT_ENOUGH_FLEETS', sea: next.id, requested: dropOff, available: group });
      if (dropOff === group) return fail({ code: 'GROUP_WOULD_BE_EMPTY', sea: next.id });
      const available = ownFleetsAt(next);
      if (pickUp > available) return fail({ code: 'NOT_ENOUGH_FLEETS', sea: next.id, requested: pickUp, available });
      group += pickUp - dropOff;
      delta.set(next.id, (delta.get(next.id) ?? 0) + dropOff - pickUp);
    }
    current = next;
  }

  const changes = [...delta].filter(([, change]) => change !== 0).map(([sea, change]) => ({ sea, delta: change }));
  return { ok: true, plan: { path, departing: command.count, arriving: group, changes, defender } };
}

/** Akcja Posejdona: ruch grupy flot za `rules.movement.costPerMove` JZ. */
export function moveFleets(state: GameState, command: FleetMoveCommand): MoveOutcome<FleetMovePlan> {
  const blocked = checkMoveTurn(state, command.playerId, 'POSEIDON');
  if (blocked) return fail(blocked);
  const planned = planFleetMove(state, command);
  if (!planned.ok) return planned;
  const { plan } = planned;
  const { playerId } = command;
  const destination = plan.path[plan.path.length - 1] ?? command.from;

  let board = state.board;
  for (const change of plan.changes) board = adjustFleets(board, change.sea, playerId, change.delta);
  let s = payForMove({ ...state, board }, playerId);

  if (plan.defender === null) {
    s = { ...s, board: adjustFleets(s.board, destination, playerId, plan.arriving) };
    return { ok: true, state: s, plan, battle: null };
  }

  // Bitwa morska: obie strony schodzą z pola do kontekstu bitwy.
  const defenders = getSea(s.board, destination).fleet;
  if (defenders === null) throw new Error(`Na polu ${destination} miała stać flota obrońcy`);
  const battle: BattleState = {
    id: BattleId(`bitwa-${s.cycle}-${s.revision}`),
    location: { kind: 'SEA', seaId: destination },
    attacker: {
      playerId,
      units: plan.arriving,
      undead: 0,
      heroes: [],
      bonus: 0,
      origin: plan.path[plan.path.length - 2] ?? null,
    },
    defender: {
      playerId: defenders.playerId,
      units: defenders.fleets,
      undead: defenders.undeadFleets,
      heroes: [],
      bonus: 0,
      origin: null,
    },
    step: 'ROLL',
    rounds: [],
    outcome: null,
  };
  s = { ...s, board: replaceSea(s.board, { ...getSea(s.board, destination), fleet: null }) };
  return { ok: true, state: beginBattle(s, battle), plan, battle: battle.id };
}

// ===========================================================================
// Ruch wojsk (Ares)
// ===========================================================================

/**
 * Reguła ostatniej wyspy. Zwraca powód blokady, gdy `islandId` to jedyna
 * wyspa przeciwnika, a jej zdobycie NIE da atakującemu wymaganej liczby
 * Metropolii. Dotyczy także pustej wyspy (zajęcie bez bitwy), bo odebranie
 * jej też wyeliminowałoby gracza.
 */
export function checkLastIsland(
  state: GameState,
  attacker: PlayerId,
  islandId: IslandId,
): Extract<MoveRejection, { code: 'LAST_ISLAND_PROTECTED' }> | null {
  const island = getIsland(state.board, islandId);
  const defender = island.ownerId;
  if (!state.rules.movement.protectLastIsland || defender === null || defender === attacker) return null;
  if (islandsOwnedBy(state, defender).length > 1) return null;
  const metropolisesAfter = countMetropolises(state, attacker) + (island.metropolisSlot.metropolis !== null ? 1 : 0);
  const required = state.rules.metropolisesToWin;
  return metropolisesAfter >= required
    ? null
    : { code: 'LAST_ISLAND_PROTECTED', island: island.id, defender, metropolisesAfter, required };
}

/** Waliduje przerzut wojsk i ustala skutek lądowania (bez tury i kosztu). */
export function planTroopMove(state: GameState, command: TroopMoveCommand): PlanOutcome<TroopMovePlan> {
  const { board } = state;
  const { playerId } = command;
  if (!Object.hasOwn(state.players, playerId)) return fail({ code: 'UNKNOWN_PLAYER', playerId });
  const origin = board.islands[command.from];
  if (!origin) return fail({ code: 'UNKNOWN_ISLAND', island: command.from });
  const target = board.islands[command.to];
  if (!target) return fail({ code: 'UNKNOWN_ISLAND', island: command.to });
  if (origin.id === target.id) return fail({ code: 'SAME_ISLAND', island: origin.id });

  const garrison = origin.garrison;
  if (garrison === null || garrison.playerId !== playerId) return fail({ code: 'NO_OWN_TROOPS', island: origin.id });
  const group: LandGroup = {
    troops: command.troops,
    undeadTroops: command.undeadTroops ?? 0,
    heroes: command.heroes ?? [],
  };
  if (!isCount(group.troops)) return fail({ code: 'INVALID_NUMBER', field: 'troops', value: group.troops });
  if (!isCount(group.undeadTroops)) {
    return fail({ code: 'INVALID_NUMBER', field: 'undeadTroops', value: group.undeadTroops });
  }
  if (group.troops + group.undeadTroops + group.heroes.length === 0) return fail({ code: 'EMPTY_GROUP' });
  if (group.troops > garrison.troops) {
    return fail({
      code: 'NOT_ENOUGH_TROOPS',
      island: origin.id,
      kind: 'TROOPS',
      requested: group.troops,
      available: garrison.troops,
    });
  }
  if (group.undeadTroops > garrison.undeadTroops) {
    return fail({
      code: 'NOT_ENOUGH_TROOPS',
      island: origin.id,
      kind: 'UNDEAD_TROOPS',
      requested: group.undeadTroops,
      available: garrison.undeadTroops,
    });
  }
  const missingHero = group.heroes.find((hero, i) => !garrison.heroes.includes(hero) || group.heroes.indexOf(hero) !== i);
  if (missingHero !== undefined) return fail({ code: 'HERO_NOT_ON_ISLAND', hero: missingHero, island: origin.id });

  const bridge = findFleetBridge(board, playerId, origin.id, target.id);
  if (bridge === null) return fail({ code: 'NO_FLEET_BRIDGE', from: origin.id, to: target.id });

  if (target.ownerId === playerId) return { ok: true, plan: { bridge, landing: 'REINFORCE', defender: null, group } };
  if (target.ownerId === null) return { ok: true, plan: { bridge, landing: 'COLONIZE', defender: null, group } };
  const protection = checkLastIsland(state, playerId, target.id);
  if (protection) return fail(protection);
  const blocker = target.garrison === null ? null : attackBlocker(state, target.id);
  if (blocker) return fail({ code: 'ATTACK_BLOCKED', island: target.id, monument: blocker.monument });
  return {
    ok: true,
    plan: { bridge, landing: target.garrison === null ? 'CAPTURE' : 'ATTACK', defender: target.ownerId, group },
  };
}

/** Akcja Aresa: przerzut grupy wojsk za `rules.movement.costPerMove` JZ. */
export function moveTroops(state: GameState, command: TroopMoveCommand): MoveOutcome<TroopMovePlan> {
  const blocked = checkMoveTurn(state, command.playerId, 'ARES');
  if (blocked) return fail(blocked);
  const planned = planTroopMove(state, command);
  if (!planned.ok) return planned;
  const { plan } = planned;
  const { playerId } = command;
  const origin = getIsland(state.board, command.from);
  const target = getIsland(state.board, command.to);
  if (origin.garrison === null) throw new Error(`Na wyspie ${origin.id} miały stać wojska gracza ${playerId}`);

  const arriving: LandForce = { playerId, ...plan.group };
  let board = replaceIsland(state.board, { ...origin, garrison: subtractGroup(origin.garrison, plan.group) });
  switch (plan.landing) {
    case 'REINFORCE':
      board = replaceIsland(board, { ...target, garrison: mergeLandForces(target.garrison, arriving) });
      break;
    case 'COLONIZE':
    case 'CAPTURE':
      board = replaceIsland(board, { ...target, ownerId: playerId, garrison: arriving });
      break;
    case 'ATTACK':
      // Obie strony schodzą z wyspy do kontekstu bitwy, a wyspa do rozstrzygnięcia należy do obrońcy.
      board = replaceIsland(board, { ...target, garrison: null });
      break;
  }
  const s = payForMove({ ...state, board }, playerId);
  if (plan.landing !== 'ATTACK') return { ok: true, state: s, plan, battle: null };

  const defenders = target.garrison;
  if (defenders === null) throw new Error(`Na wyspie ${target.id} miały stać wojska obrońcy`);
  const battle: BattleState = {
    id: BattleId(`bitwa-${s.cycle}-${s.revision}`),
    location: { kind: 'LAND', islandId: target.id },
    attacker: {
      playerId,
      units: plan.group.troops,
      undead: plan.group.undeadTroops,
      heroes: plan.group.heroes,
      bonus: 0,
      origin: origin.id,
    },
    defender: {
      playerId: defenders.playerId,
      units: defenders.troops,
      undead: defenders.undeadTroops,
      heroes: defenders.heroes,
      bonus: 0,
      origin: null,
    },
    step: 'ROLL',
    rounds: [],
    outcome: null,
  };
  return { ok: true, state: beginBattle(s, battle), plan, battle: battle.id };
}

// ===========================================================================
// Wspólne: tura, koszt, aktualizacje planszy
// ===========================================================================

/** Tura właściwego boga, niezakończona, i gracz, którego stać na ruch. */
function checkMoveTurn(state: GameState, playerId: PlayerId, god: God): MoveRejection | null {
  const turn = checkGodTurn(state, playerId, god);
  if (turn) return turn;
  const cost = state.rules.movement.costPerMove;
  const gold = getPlayer(state, playerId).gold;
  return gold < cost ? { code: 'CANNOT_AFFORD', cost, gold } : null;
}

/** Pobiera koszt ruchu i podbija licznik ruchów w bieżącej turze. */
function payForMove(state: GameState, playerId: PlayerId): GameState {
  const paid = charge(state, playerId, state.rules.movement.costPerMove);
  const counted = updateTurnProgress(paid, (progress) => ({ ...progress, movements: progress.movements + 1 }));
  return { ...counted, revision: state.revision + 1 };
}

function subtractGroup(force: LandForce, group: LandGroup): LandForce | null {
  const rest: LandForce = {
    playerId: force.playerId,
    troops: force.troops - group.troops,
    undeadTroops: force.undeadTroops - group.undeadTroops,
    heroes: force.heroes.filter((hero) => !group.heroes.includes(hero)),
  };
  return rest.troops + rest.undeadTroops + rest.heroes.length > 0 ? rest : null;
}

// ===========================================================================
// Komunikaty
// ===========================================================================

export function describeMoveRejection(error: MoveRejection): string {
  switch (error.code) {
    case 'NOT_ACTIONS_PHASE':
    case 'NOT_YOUR_TURN':
    case 'WRONG_GOD':
    case 'TURN_FINISHED':
    case 'UNKNOWN_PLAYER':
      return describeTurnRejection(error);
    case 'CANNOT_AFFORD':
      return `Ruch kosztuje ${error.cost} JZ, a masz ${error.gold} JZ.`;
    case 'INVALID_NUMBER':
      return `Pole „${error.field}” musi być nieujemną liczbą całkowitą (podano: ${error.value}).`;
    case 'UNKNOWN_SEA':
      return `Nieznane pole morskie ${error.sea}.`;
    case 'NO_OWN_FLEET':
      return `Na polu ${error.sea} nie ma twojej floty.`;
    case 'NOT_ENOUGH_FLEETS':
      return `Na polu ${error.sea} dostępnych jest ${error.available} flot, a potrzeba ${error.requested}.`;
    case 'ROUTE_LENGTH':
      return `Trasa floty musi mieć od 1 do ${error.max} pól (podano ${error.length}).`;
    case 'NOT_ADJACENT':
      return `Pole ${error.to} nie sąsiaduje z polem ${error.from}.`;
    case 'ROUTE_CONTINUES_AFTER_BATTLE':
      return `Na polu ${error.sea} stoi obca flota, więc ruch musi się tam zakończyć bitwą.`;
    case 'WAYPOINT_AT_DESTINATION':
      return `Floty można zabierać i zostawiać tylko na polach pośrednich, nie na polu ${error.sea}.`;
    case 'AMBIGUOUS_WAYPOINT':
      return `Na polu ${error.sea} można zabrać floty albo je zostawić, ale nie oba naraz.`;
    case 'GROUP_WOULD_BE_EMPTY':
      return `Po zostawieniu flot na polu ${error.sea} grupa byłaby pusta. Zakończ ruch na tym polu.`;
    case 'UNKNOWN_ISLAND':
      return `Nieznana wyspa ${error.island}.`;
    case 'SAME_ISLAND':
      return `Wyspa docelowa musi być inna niż startowa (${error.island}).`;
    case 'NO_OWN_TROOPS':
      return `Na wyspie ${error.island} nie ma twoich wojsk.`;
    case 'EMPTY_GROUP':
      return 'Grupa musi zawierać co najmniej jedną jednostkę.';
    case 'NOT_ENOUGH_TROOPS':
      return `Na wyspie ${error.island} masz ${error.available} ${
        error.kind === 'TROOPS' ? 'oddziałów' : 'nieumarłych oddziałów'
      }, a potrzeba ${error.requested}.`;
    case 'HERO_NOT_ON_ISLAND':
      return `Heros ${error.hero} nie stoi na wyspie ${error.island} (albo podano go dwa razy).`;
    case 'NO_FLEET_BRIDGE':
      return `Brak łańcucha twoich flot między wyspami ${error.from} i ${error.to}.`;
    case 'ATTACK_BLOCKED':
      return `Wyspy ${error.island} nie można zaatakować: chroni ją Monument ${error.monument} i stacjonujące tam oddziały.`;
    case 'LAST_ISLAND_PROTECTED':
      return (
        `Wyspa ${error.island} to ostatnia wyspa gracza ${error.defender}. Można ją zdobyć tylko wtedy, gdy ` +
        `liczba twoich Metropolii wyniesie potem co najmniej ${error.required} (byłoby: ${error.metropolisesAfter}).`
      );
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}
