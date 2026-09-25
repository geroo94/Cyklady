/**
 * @file Projekcja stanu dla odbiorcy: informacje ukryte nie opuszczają serwera.
 *
 * Serwer trzyma pełny `GameState`, a każdy klient dostaje własny widok:
 *  - bez stanu generatora losowego (inaczej dałoby się przewidzieć rzuty),
 *  - z liczbą kart w taliach zamiast ich kolejności (tor stworów, Monumenty),
 *  - z kartami Monumentów tylko odbiorcy (pozostali gracze: sama liczba kart),
 *  - opcjonalnie bez złota przeciwników (w wersji fizycznej leży za zasłonką).
 */

import type { CreatureMarket, GameState, MonumentCardId, MonumentPool, PlayerId, PlayerState } from '../model/index.ts';

export interface PublicCreatureMarket {
  readonly slots: CreatureMarket['slots'];
  readonly deckSize: number;
  readonly discard: CreatureMarket['discard'];
}

export interface PublicMonumentPool {
  readonly deckSize: number;
  readonly offer: MonumentPool['offer'];
  readonly discard: MonumentPool['discard'];
  readonly figureSupply: MonumentPool['figureSupply'];
  /** Karty odbiorcy (pusta lista dla obserwatora). */
  readonly yourCards: readonly MonumentCardId[];
  /** Liczba nierozegranych kart każdego gracza. */
  readonly cardCounts: Readonly<Record<PlayerId, number>>;
}

export interface PublicPlayerState extends Omit<PlayerState, 'gold'> {
  /** `null`, gdy złoto jest ukryte przed odbiorcą. */
  readonly gold: number | null;
}

export type PublicGameState = Omit<GameState, 'rng' | 'creatureMarket' | 'monuments' | 'players'> & {
  /** Dla kogo przygotowano widok (`null` = obserwator). */
  readonly viewer: PlayerId | null;
  readonly players: Readonly<Record<PlayerId, PublicPlayerState>>;
  readonly creatureMarket: PublicCreatureMarket;
  readonly monuments: PublicMonumentPool | null;
};

export interface ProjectionOptions {
  /** Ukrywaj złoto przeciwników (domyślnie tak). */
  readonly hiddenGold: boolean;
}

export const DEFAULT_PROJECTION: ProjectionOptions = { hiddenGold: true };

export function projectState(state: GameState, viewer: PlayerId | null, options: ProjectionOptions = DEFAULT_PROJECTION): PublicGameState {
  const { rng: _rng, creatureMarket, monuments, players, ...rest } = state;

  const publicPlayers: Record<PlayerId, PublicPlayerState> = {};
  for (const playerId of state.seating) {
    const player = players[playerId];
    if (!player) continue;
    const hidden = options.hiddenGold && viewer !== playerId;
    publicPlayers[playerId] = { ...player, gold: hidden ? null : player.gold };
  }

  let publicMonuments: PublicMonumentPool | null = null;
  if (monuments) {
    const cardCounts: Record<PlayerId, number> = {};
    for (const playerId of state.seating) cardCounts[playerId] = monuments.dealt[playerId]?.length ?? 0;
    publicMonuments = {
      deckSize: monuments.deck.length,
      offer: monuments.offer,
      discard: monuments.discard,
      figureSupply: monuments.figureSupply,
      yourCards: viewer === null ? [] : (monuments.dealt[viewer] ?? []),
      cardCounts,
    };
  }

  return {
    ...rest,
    viewer,
    players: publicPlayers,
    creatureMarket: { slots: creatureMarket.slots, deckSize: creatureMarket.deck.length, discard: creatureMarket.discard },
    monuments: publicMonuments,
  };
}
