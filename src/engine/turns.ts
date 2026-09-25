/**
 * @file Wspólna walidacja tury boga w fazie ACTIONS i pobieranie opłat.
 *
 * Każda akcja boga (ruch Aresa i Posejdona, rekrutacja i Nekropolia Hadesa)
 * zaczyna od tego samego sprawdzenia: trwa faza ACTIONS, to tura tego gracza
 * i właściwego boga, a tura nie jest jeszcze zakończona.
 */

import {
  expectPhase,
  getPlayer,
  type GameState,
  type God,
  type Phase,
  type PlayerId,
  type TurnProgress,
} from '../model/index.ts';

export type TurnRejection =
  | { readonly code: 'NOT_ACTIONS_PHASE'; readonly phase: Phase }
  | { readonly code: 'NOT_YOUR_TURN'; readonly expected: PlayerId | null }
  | { readonly code: 'WRONG_GOD'; readonly required: God; readonly actual: God }
  | { readonly code: 'TURN_FINISHED' }
  | { readonly code: 'UNKNOWN_PLAYER'; readonly playerId: PlayerId };

/** `null`, gdy gracz może teraz wykonać akcję boga `god`, w przeciwnym razie powód odmowy. */
export function checkGodTurn(state: GameState, playerId: PlayerId, god: God): TurnRejection | null {
  const phase = state.phase;
  if (phase.phase !== 'ACTIONS') return { code: 'NOT_ACTIONS_PHASE', phase: phase.phase };
  const turn = phase.turns[phase.turnIndex];
  if (!turn || turn.playerId !== playerId) return { code: 'NOT_YOUR_TURN', expected: turn?.playerId ?? null };
  if (turn.god !== god) return { code: 'WRONG_GOD', required: god, actual: turn.god };
  if (phase.progress.finished) return { code: 'TURN_FINISHED' };
  if (!Object.hasOwn(state.players, playerId)) return { code: 'UNKNOWN_PLAYER', playerId };
  return null;
}

/** Pobiera JZ od gracza (bez walidacji: wywołujący sprawdza wcześniej, czy gracza stać). */
export function charge(state: GameState, playerId: PlayerId, cost: number): GameState {
  const player = getPlayer(state, playerId);
  return { ...state, players: { ...state.players, [playerId]: { ...player, gold: player.gold - cost } } };
}

/** Zmienia postęp bieżącej tury (liczniki zakupów, ruchów, budowy). */
export function updateTurnProgress(state: GameState, update: (progress: TurnProgress) => TurnProgress): GameState {
  const phase = expectPhase(state, 'ACTIONS');
  return { ...state, phase: { ...phase, progress: update(phase.progress) } };
}

export function describeTurnRejection(error: TurnRejection): string {
  switch (error.code) {
    case 'NOT_ACTIONS_PHASE':
      return `Akcje bogów są możliwe tylko w fazie ACTIONS (teraz: ${error.phase}).`;
    case 'NOT_YOUR_TURN':
      return error.expected === null ? 'Teraz nie trwa żadna tura boga.' : `Teraz tura gracza ${error.expected}.`;
    case 'WRONG_GOD':
      return `Ta akcja wymaga tury boga ${error.required}, a trwa tura boga ${error.actual}.`;
    case 'TURN_FINISHED':
      return 'Tura została już zakończona.';
    case 'UNKNOWN_PLAYER':
      return `Nieznany gracz ${error.playerId}.`;
  }
}
