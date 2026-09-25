/**
 * @file Orkiestrator partii: przewija fazy automatyczne i wie, na kogo gra czeka.
 *
 * Silnik składa się z czystych komend (licytacja, ruch, bitwa, akcje
 * dodatków). Orkiestrator łączy je w przebieg partii:
 *  - `advanceAutomaticPhases` przechodzi przez fazy, które nie wymagają
 *    decyzji gracza (odświeżenie toru, bogowie, dochód, rozliczenie
 *    licytacji, kolejne tury bogów, koniec cyklu, sprzątanie po bitwie),
 *  - `pendingActors` mówi, od kogo gra oczekuje teraz komendy,
 *  - `endTurn` kończy turę boga (komenda gracza END_TURN).
 *
 * Serwer woła `advanceAutomaticPhases` po każdej zaakceptowanej komendzie.
 */

import {
  checkVictory,
  createBiddingPhase,
  expectPhase,
  finishGodTurn,
  getIsland,
  getSea,
  startNextGodTurn,
  transition,
  type BattleId,
  type BattleLocation,
  type GameState,
  type IslandId,
  type PhaseHooks,
  type PlayerId,
  type SeaId,
} from '../model/index.ts';
import { closeBidding, currentBidder, isBiddingStable } from './bidding.ts';
import { pendingDecision, stepBattle, type BattleEvent } from './combat.ts';
import { CYCLE_HOOKS } from './cycle.ts';
import { applyStateBasedEffects } from './expansions/registry.ts';
import { checkGodTurn, type TurnRejection } from './turns.ts';

// ===========================================================================
// Siły startowe
// ===========================================================================

/** Rozstawienie startowe jednego gracza: oddziały na wyspie i floty na morzu. */
export interface StartingForces {
  readonly playerId: PlayerId;
  readonly island: IslandId;
  readonly troops: number;
  readonly sea: SeaId;
  readonly fleets: number;
}

/**
 * Rozstawia siły startowe z zapasów graczy i kończy przygotowanie partii
 * (`InitPhase.step = READY`). Wyspa startowa staje się własnością gracza.
 */
export function placeStartingForces(state: GameState, forces: readonly StartingForces[]): GameState {
  const init = expectPhase(state, 'INIT');
  let s = state;
  for (const force of forces) {
    const player = s.players[force.playerId];
    if (!player) throw new Error(`Nieznany gracz ${force.playerId}`);
    if (player.reserve.troops < force.troops || player.reserve.fleets < force.fleets) {
      throw new Error(`Gracz ${force.playerId} nie ma dość figurek na rozstawienie startowe`);
    }
    const island = getIsland(s.board, force.island);
    const sea = getSea(s.board, force.sea);
    if (island.ownerId !== null || sea.fleet !== null) throw new Error(`Pole startowe gracza ${force.playerId} jest zajęte`);
    s = {
      ...s,
      players: {
        ...s.players,
        [player.id]: {
          ...player,
          reserve: { ...player.reserve, troops: player.reserve.troops - force.troops, fleets: player.reserve.fleets - force.fleets },
        },
      },
      board: {
        islands: {
          ...s.board.islands,
          [island.id]: { ...island, ownerId: player.id, garrison: { playerId: player.id, troops: force.troops, undeadTroops: 0, heroes: [] } },
        },
        seas: { ...s.board.seas, [sea.id]: { ...sea, fleet: { playerId: player.id, fleets: force.fleets, undeadFleets: 0 } } },
      },
    };
  }
  return { ...s, revision: s.revision + 1, phase: { ...init, step: 'READY', placementQueue: [] } };
}

// ===========================================================================
// Przewijanie faz automatycznych
// ===========================================================================

export interface AdvanceOptions {
  readonly hooks?: PhaseHooks;
  /** Rzucaj kośćmi bitewnymi automatycznie, zamiast czekać na REROLL_DICE. */
  readonly autoRollBattles?: boolean;
  /** Bezpiecznik na wypadek błędu w silniku. */
  readonly maxSteps?: number;
}

/** Zdarzenia jednej bitwy z kroków wykonanych automatycznie, razem ze stronami i miejscem bitwy. */
export interface BattleEventBatch {
  readonly battleId: BattleId;
  readonly attacker: PlayerId;
  readonly defender: PlayerId;
  readonly location: BattleLocation;
  readonly events: readonly BattleEvent[];
}

export interface AdvanceResult {
  readonly state: GameState;
  /** Zdarzenia bitew rozegranych automatycznie (rzuty, sprzątanie). */
  readonly battles: readonly BattleEventBatch[];
}

/** Przechodzi przez fazy automatyczne, aż gra zacznie czekać na gracza albo się skończy. */
export function advanceAutomaticPhases(state: GameState, options: AdvanceOptions = {}): AdvanceResult {
  const hooks = options.hooks ?? CYCLE_HOOKS;
  const maxSteps = options.maxSteps ?? 1_000;
  const battles: BattleEventBatch[] = [];
  let current = applyStateBasedEffects(state);

  for (let steps = 0; steps < maxSteps; steps++) {
    const next = automaticStep(current, hooks, options.autoRollBattles ?? false, battles);
    if (next === null) return { state: current, battles };
    current = next;
  }
  throw new Error(`Fazy automatyczne nie ustabilizowały się w ${maxSteps} krokach (błąd silnika)`);
}

function automaticStep(state: GameState, hooks: PhaseHooks, autoRoll: boolean, battles: BattleEventBatch[]): GameState | null {
  const phase = state.phase;
  switch (phase.phase) {
    case 'INIT':
      return phase.step === 'READY' ? transition(state, { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, hooks) : null;
    case 'CREATURES_REFRESH':
      return transition(state, { phase: 'GODS_SETUP', revealed: [], hadesSummoned: false }, hooks);
    case 'GODS_SETUP':
      return transition(state, { phase: 'INCOME', report: {} }, hooks);
    case 'INCOME':
      return transition(state, createBiddingPhase(state), hooks);
    case 'BIDDING': {
      if (!isBiddingStable(state)) return null;
      const closed = closeBidding(state, hooks);
      if (!closed.ok) throw new Error(`Nie udało się zamknąć licytacji: ${closed.error.code}`);
      return closed.state;
    }
    case 'ACTIONS':
      if (!phase.progress.finished) return null;
      if (phase.turnIndex < phase.turns.length - 1) return startNextGodTurn(state);
      return transition(state, { phase: 'END_OF_CYCLE', victory: checkVictory(state) }, hooks);
    case 'BATTLE_RESOLUTION': {
      const step = phase.battle.step;
      if (step !== 'CLEANUP' && !(step === 'ROLL' && autoRoll)) return null;
      const result = stepBattle(state, step === 'CLEANUP' ? { type: 'CLEANUP' } : { type: 'ROLL' }, hooks);
      if (!result.ok) throw new Error(`Automatyczny krok bitwy odrzucony: ${result.error.code}`);
      const { battle } = phase;
      battles.push({
        battleId: battle.id,
        attacker: battle.attacker.playerId,
        defender: battle.defender.playerId,
        location: battle.location,
        events: result.events,
      });
      return result.state;
    }
    case 'END_OF_CYCLE':
      return phase.victory.winners.length > 0
        ? transition(state, { phase: 'GAME_OVER', winners: phase.victory.winners, finalCycle: state.cycle }, hooks)
        : transition(state, { phase: 'CREATURES_REFRESH', discarded: null, drawn: [] }, hooks);
    case 'GAME_OVER':
      return null;
  }
}

// ===========================================================================
// Na kogo czeka gra
// ===========================================================================

/**
 * Gracze, od których gra oczekuje teraz komendy. W kroku ROLL bitwy rzut
 * może zlecić każda ze stron, więc lista ma wtedy dwóch graczy.
 */
export function pendingActors(state: GameState): PlayerId[] {
  const phase = state.phase;
  switch (phase.phase) {
    case 'BIDDING': {
      const bidder = currentBidder(state);
      return bidder ? [bidder.playerId] : [];
    }
    case 'ACTIONS': {
      const turn = phase.turns[phase.turnIndex];
      return turn && !phase.progress.finished ? [turn.playerId] : [];
    }
    case 'BATTLE_RESOLUTION': {
      const decision = pendingDecision(state);
      if (decision) return [decision.playerId];
      return phase.battle.step === 'ROLL' ? [phase.battle.attacker.playerId, phase.battle.defender.playerId] : [];
    }
    default:
      return [];
  }
}

// ===========================================================================
// Koniec tury
// ===========================================================================

export type EndTurnOutcome =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly error: TurnRejection };

/** Gracz kończy turę swojego boga (dowolnego). */
export function endTurn(state: GameState, playerId: PlayerId): EndTurnOutcome {
  const phase = state.phase;
  const god = phase.phase === 'ACTIONS' ? phase.turns[phase.turnIndex]?.god : undefined;
  if (phase.phase !== 'ACTIONS' || god === undefined) {
    return { ok: false, error: { code: 'NOT_ACTIONS_PHASE', phase: phase.phase } };
  }
  const blocked = checkGodTurn(state, playerId, god);
  if (blocked) return { ok: false, error: blocked };
  return { ok: true, state: finishGodTurn(state) };
}
