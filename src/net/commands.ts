/**
 * @file Wykonanie intencji na silniku zasad, czyli serce serwera autorytatywnego.
 *
 * `applyIntent(stan, gracz, intencja)` to czysta funkcja bez sieci:
 *  - `playerId` pochodzi z miejsca przypisanego do połączenia, nigdy z wiadomości,
 *  - każda intencja trafia do odpowiedniej komendy silnika, która ją waliduje
 *    (tura, koszt, most z flot, reguła ostatniej wyspy...),
 *  - po sukcesie działają efekty stanowe (np. automatyczne Monumenty).
 * Dzięki temu całą logikę serwera można testować bez gniazd.
 */

import {
  applyBid,
  applyStateBasedEffects,
  buildNecropolis,
  describeBattleRejection,
  describeHadesRejection,
  describeMoveRejection,
  describeRejection,
  describeTurnRejection,
  endTurn,
  moveFleets,
  moveTroops,
  recruitUndead,
  stepBattle,
  type BattleCommand,
  type BidEvent,
} from '../engine/index.ts';
import type { BattleId, BattleLocation, BattleState, GameState, PlayerId } from '../model/index.ts';
import type { BattleFeedEvent, EndTurn, ExecuteAction, RerollDice, SubmitBid } from './protocol.ts';

/** Wiadomości klienta, które zmieniają stan gry. */
export type IntentMessage = SubmitBid | ExecuteAction | EndTurn | RerollDice;

/** Zdarzenia jednej bitwy razem z jej stronami i miejscem (koperta BATTLE_EVENT). */
export interface BattleFeed {
  readonly battleId: BattleId;
  readonly attacker: PlayerId;
  readonly defender: PlayerId;
  readonly location: BattleLocation;
  readonly events: readonly BattleFeedEvent[];
}

export type IntentResult =
  | {
      readonly ok: true;
      readonly state: GameState;
      readonly battle: BattleFeed | null;
      /** Zdarzenia licytacji (ofiara, przebicie, Apollo) dla BIDDING_EVENT. */
      readonly bidding: readonly BidEvent[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly details: unknown };

const reject = (code: string, message: string, details: unknown = null): IntentResult => ({ ok: false, code, message, details });

function accept(state: GameState, battle: BattleFeed | null = null, bidding: readonly BidEvent[] = []): IntentResult {
  return { ok: true, state: applyStateBasedEffects(state), battle, bidding };
}

/** Strony i miejsce bitwy: raport jest kompletny bez sięgania do stanu gry. */
export function battleContext(battle: BattleState): Omit<BattleFeed, 'events'> {
  return { battleId: battle.id, attacker: battle.attacker.playerId, defender: battle.defender.playerId, location: battle.location };
}

/** Informacja o rozpoczętej bitwie (po ruchu na pole zajęte przez przeciwnika). */
function battleStarted(state: GameState): BattleFeed | null {
  if (state.phase.phase !== 'BATTLE_RESOLUTION') return null;
  const { battle } = state.phase;
  const where = battle.location.kind === 'LAND' ? battle.location.islandId : battle.location.seaId;
  return {
    ...battleContext(battle),
    events: [
      {
        type: 'BATTLE_STARTED',
        kind: battle.location.kind,
        where,
        attacker: battle.attacker.playerId,
        defender: battle.defender.playerId,
      },
    ],
  };
}

function battleStep(state: GameState, command: BattleCommand): IntentResult {
  const battle = state.phase.phase === 'BATTLE_RESOLUTION' ? state.phase.battle : null;
  const result = stepBattle(state, command);
  if (!result.ok) return reject(result.error.code, describeBattleRejection(result.error), result.error);
  return accept(result.state, battle ? { ...battleContext(battle), events: result.events } : null);
}

/** Wykonuje intencję gracza `playerId` na stanie `state`. */
export function applyIntent(state: GameState, playerId: PlayerId, intent: IntentMessage): IntentResult {
  switch (intent.type) {
    case 'SUBMIT_BID': {
      const { bid } = intent;
      const result = applyBid(
        state,
        bid.kind === 'GOD' ? { type: 'OFFER', playerId, god: bid.god, amount: bid.amount } : { type: 'APOLLO', playerId },
      );
      return result.ok ? accept(result.state, null, result.events) : reject(result.error.code, describeRejection(result.error), result.error);
    }

    case 'END_TURN': {
      if (state.phase.phase === 'BATTLE_RESOLUTION') {
        return reject('BATTLE_IN_PROGRESS', 'Najpierw trzeba rozstrzygnąć trwającą bitwę.');
      }
      const result = endTurn(state, playerId);
      return result.ok ? accept(result.state) : reject(result.error.code, describeTurnRejection(result.error), result.error);
    }

    case 'REROLL_DICE': {
      if (state.phase.phase !== 'BATTLE_RESOLUTION') return reject('NOT_IN_BATTLE', 'Nie trwa żadna bitwa.');
      const { battle } = state.phase;
      if (battle.attacker.playerId !== playerId && battle.defender.playerId !== playerId) {
        return reject('NOT_A_PARTICIPANT', 'Kośćmi rzucają tylko uczestnicy bitwy.');
      }
      return battleStep(state, { type: 'ROLL' });
    }

    case 'EXECUTE_ACTION': {
      const { action } = intent;
      switch (action.type) {
        case 'MOVE_FLEET': {
          const result = moveFleets(state, { playerId, from: action.from, count: action.count, route: action.route });
          return result.ok ? accept(result.state, battleStarted(result.state)) : reject(result.error.code, describeMoveRejection(result.error), result.error);
        }
        case 'MOVE_TROOPS': {
          const result = moveTroops(state, {
            playerId,
            from: action.from,
            to: action.to,
            troops: action.troops,
            ...(action.undeadTroops === undefined ? {} : { undeadTroops: action.undeadTroops }),
            ...(action.heroes === undefined ? {} : { heroes: action.heroes }),
          });
          return result.ok ? accept(result.state, battleStarted(result.state)) : reject(result.error.code, describeMoveRejection(result.error), result.error);
        }
        case 'RECRUIT_UNDEAD': {
          const result = recruitUndead(state, { playerId, kind: action.kind, to: action.to });
          return result.ok ? accept(result.state) : reject(result.error.code, describeHadesRejection(result.error), result.error);
        }
        case 'BUILD_NECROPOLIS': {
          const result = buildNecropolis(state, { playerId, islandId: action.islandId });
          return result.ok ? accept(result.state) : reject(result.error.code, describeHadesRejection(result.error), result.error);
        }
        case 'RETREAT':
          return battleStep(state, { type: 'RETREAT', playerId, to: action.to });
        case 'HOLD':
          return battleStep(state, { type: 'HOLD', playerId });
        case 'BUY_CREATURE':
          return reject('UNSUPPORTED_ACTION', 'Zakup stworów nie jest jeszcze obsługiwany przez silnik zasad.');
      }
    }
  }
}
