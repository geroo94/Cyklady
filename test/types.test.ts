/**
 * @file Testy na poziomie typów. Wykonuje je `npm run typecheck`: każde
 * `@ts-expect-error` MUSI zgłosić błąd, inaczej kompilacja się nie powiedzie.
 */

import { test } from 'node:test';

import {
  IslandId,
  PlayerId,
  SeaId,
  type GameState,
  type IslandNode,
  type PhaseOf,
  type TransitionKey,
} from '../src/model/index.ts';

test('kontrole typów wykonuje kompilator (npm run typecheck)', () => {
  const naxos = IslandId('naxos');
  const sea = SeaId('morze');

  // @ts-expect-error: ID pola morskiego nie jest ID wyspy
  const wrongId: IslandId = sea;

  const edge: TransitionKey = 'BATTLE_RESOLUTION->ACTIONS';
  // @ts-expect-error: krawędź INIT->BIDDING nie istnieje w maszynie stanów
  const missingEdge: TransitionKey = 'INIT->BIDDING';

  const readIsland = (state: GameState): IslandNode | undefined =>
    // @ts-expect-error: rekordu wysp nie da się indeksować ID gracza
    state.board.islands[PlayerId('p1')];

  const turnIndex = (phase: PhaseOf<'ACTIONS'>): number => phase.turnIndex;
  // @ts-expect-error: kontekst ACTIONS nie ma pola `battle`
  const noBattle = (phase: PhaseOf<'ACTIONS'>) => phase.battle;

  void [naxos, wrongId, edge, missingEdge, readIsland, turnIndex, noBattle];
});
