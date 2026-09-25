/**
 * @file Gracze sterowani przez komputer (tryb Single Player).
 *
 * AI działa po stronie serwera, ale gra uczciwie: dostaje tę samą projekcję
 * stanu co człowiek (bez ukrytych informacji) i wysyła te same intencje co
 * klient. Serwer waliduje je tak samo jak intencje ludzi.
 */

import type { PlayerId } from '../model/index.ts';
import type { ActionIntent, BidChoice } from './protocol.ts';
import type { PublicGameState } from './projection.ts';

/** Intencja AI: wiadomość klienta bez koperty (`v`, `requestId`). */
export type AiIntent =
  | { readonly type: 'SUBMIT_BID'; readonly bid: BidChoice }
  | { readonly type: 'EXECUTE_ACTION'; readonly action: ActionIntent }
  | { readonly type: 'END_TURN' }
  | { readonly type: 'REROLL_DICE' };

export interface AiPolicy {
  readonly name: string;
  /** Decyzja gracza `me` albo `null`, gdy nic nie ma do zrobienia. */
  decide(view: PublicGameState, me: PlayerId): AiIntent | null;
}

/**
 * Bezpieczny ruch zastępczy, legalny zawsze, gdy gra czeka na tego gracza:
 * Apollo w licytacji, koniec tury, walka dalej w bitwie, rzut w kroku ROLL.
 */
export function fallbackIntent(view: PublicGameState): AiIntent | null {
  const phase = view.phase;
  switch (phase.phase) {
    case 'BIDDING':
      return { type: 'SUBMIT_BID', bid: { kind: 'APOLLO' } };
    case 'ACTIONS':
      return { type: 'END_TURN' };
    case 'BATTLE_RESOLUTION':
      return phase.battle.step === 'ROLL' ? { type: 'REROLL_DICE' } : { type: 'EXECUTE_ACTION', action: { type: 'HOLD' } };
    default:
      return null;
  }
}

/**
 * Prosta AI: w licytacji bierze pierwszego wolnego boga za 1 JZ (jeśli ma
 * złoto), a w przeciwnym razie idzie do Apolla. W swojej turze od razu ją
 * kończy, a w bitwie walczy do końca.
 */
export const SIMPLE_AI: AiPolicy = {
  name: 'prosta',
  decide(view, me) {
    const phase = view.phase;
    if (phase.phase === 'BIDDING') {
      const myTurn = phase.displaced ? phase.displaced.playerId === me : phase.queue[0] === me;
      if (!myTurn) return null;
      const forbidden = phase.displaced?.playerId === me ? phase.displaced.forbiddenGod : null;
      const gold = view.players[me]?.gold ?? 0;
      const free = view.gods.slots.find((slot) => slot.offering === null && slot.god !== forbidden);
      return free && gold >= 1
        ? { type: 'SUBMIT_BID', bid: { kind: 'GOD', god: free.god, amount: 1 } }
        : { type: 'SUBMIT_BID', bid: { kind: 'APOLLO' } };
    }
    if (phase.phase === 'ACTIONS') {
      return phase.turns[phase.turnIndex]?.playerId === me && !phase.progress.finished ? { type: 'END_TURN' } : null;
    }
    if (phase.phase === 'BATTLE_RESOLUTION') {
      const { battle } = phase;
      const participant = battle.attacker.playerId === me || battle.defender.playerId === me;
      if (!participant) return null;
      if (battle.step === 'ROLL') return { type: 'REROLL_DICE' };
      const deciding =
        (battle.step === 'DEFENDER_RETREAT_DECISION' && battle.defender.playerId === me) ||
        (battle.step === 'ATTACKER_RETREAT_DECISION' && battle.attacker.playerId === me);
      return deciding ? { type: 'EXECUTE_ACTION', action: { type: 'HOLD' } } : null;
    }
    return null;
  },
};
