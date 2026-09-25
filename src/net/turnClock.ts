/**
 * @file Zegar tury: na kogo czeka gra, z jakiego powodu i ile ma na to czasu.
 *
 * `describeTurn` wylicza z samego stanu gry bieżącą turę, czyli jedną
 * decyzję, na którą czeka serwer:
 *
 *   BIDDING            BID albo OUTBID (przebity gracz musi od razu wybrać innego boga)
 *   ACTIONS            GOD_TURN (cała tura boga, także gdy gracz wykona w niej kilka akcji)
 *   BATTLE_RESOLUTION  BATTLE_ROLL (rzut może zlecić każda strona) albo RETREAT_DECISION
 *
 * `turnId` zmienia się z każdą nową decyzją. Pokój porównuje go przed
 * i po komendzie: nowy `turnId` oznacza nowy licznik czasu i wiadomość
 * TURN_UPDATE, a ten sam oznacza, że gracz wciąż wykonuje swoją turę.
 *
 * Gdy czas minie, pokój wykonuje ruch pasywny (`passiveIntent`): Apollo
 * w licytacji, koniec tury boga, rzut kośćmi albo „walczę dalej” w bitwie.
 */

import { pendingActors, pendingDecision } from '../engine/index.ts';
import type { GameState, PlayerId } from '../model/index.ts';
import type { AiIntent } from './ai.ts';
import type { PassiveMove, TurnDetails } from './protocol.ts';

/** Limity czasu w ms. */
export interface TurnTimeouts {
  /** Na ofiarę w licytacji, także po przebiciu. */
  readonly bidding: number;
  /** Na całą turę boga. Licznik stoi, gdy w trakcie tury trwa bitwa. */
  readonly godTurn: number;
  /** Na rzut kośćmi i na decyzję o odwrocie. */
  readonly battle: number;
}

export const DEFAULT_TURN_TIMEOUTS: TurnTimeouts = { bidding: 60_000, godTurn: 180_000, battle: 30_000 };

/** Tyle czasu miejsce rozłączonego gracza czeka na jego powrót. */
export const DEFAULT_RECONNECT_GRACE_MS = 60_000;

export interface TurnInfo {
  readonly turnId: string;
  readonly actors: readonly PlayerId[];
  readonly details: TurnDetails;
  /** Który limit z `TurnTimeouts` obowiązuje. */
  readonly limit: keyof TurnTimeouts;
}

/** Bieżąca tura albo `null`, gdy gra na nikogo nie czeka (np. po końcu partii). */
export function describeTurn(state: GameState): TurnInfo | null {
  const actors = pendingActors(state);
  if (actors.length === 0) return null;
  const phase = state.phase;
  switch (phase.phase) {
    case 'BIDDING': {
      const displaced = phase.displaced;
      const holder = displaced ? state.gods.slots.find((slot) => slot.god === displaced.forbiddenGod)?.offering : null;
      const details: TurnDetails =
        displaced && holder
          ? { reason: 'OUTBID', by: holder.playerId, god: displaced.forbiddenGod, amount: holder.amount }
          : { reason: 'BID' };
      // Każda ofiara podbija rewizję stanu, więc każdy ruch w licytacji to nowa tura z pełnym czasem.
      return { turnId: `BIDDING:${state.cycle}:${state.revision}`, actors, details, limit: 'bidding' };
    }
    case 'ACTIONS': {
      const turn = phase.turns[phase.turnIndex];
      if (!turn) return null;
      return { turnId: `GOD_TURN:${state.cycle}:${phase.turnIndex}`, actors, details: { reason: 'GOD_TURN', god: turn.god }, limit: 'godTurn' };
    }
    case 'BATTLE_RESOLUTION': {
      const { battle } = phase;
      const decision = pendingDecision(state);
      const details: TurnDetails = decision
        ? { reason: 'RETREAT_DECISION', battleId: battle.id, role: decision.role, options: decision.options }
        : { reason: 'BATTLE_ROLL', battleId: battle.id, round: battle.rounds.length + 1 };
      return { turnId: `BATTLE:${battle.id}:${battle.rounds.length}:${battle.step}`, actors, details, limit: 'battle' };
    }
    default:
      return null;
  }
}

/** Ruch pasywny ogłaszany w TURN_UPDATE. */
export function passiveMoveFor(details: TurnDetails): PassiveMove {
  switch (details.reason) {
    case 'BID':
    case 'OUTBID':
      return 'APOLLO';
    case 'GOD_TURN':
      return 'END_TURN';
    case 'BATTLE_ROLL':
      return 'ROLL';
    case 'RETREAT_DECISION':
      return 'HOLD';
  }
}

/** Intencja, którą serwer wysyła w imieniu gracza, gdy jego czas minie. */
export function passiveIntent(details: TurnDetails): AiIntent {
  switch (passiveMoveFor(details)) {
    case 'APOLLO':
      return { type: 'SUBMIT_BID', bid: { kind: 'APOLLO' } };
    case 'END_TURN':
      return { type: 'END_TURN' };
    case 'ROLL':
      return { type: 'REROLL_DICE' };
    case 'HOLD':
      return { type: 'EXECUTE_ACTION', action: { type: 'HOLD' } };
  }
}
