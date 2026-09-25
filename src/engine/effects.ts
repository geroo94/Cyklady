/**
 * @file Efekty kart, herosów i Monumentów obsługiwane przez silnik zasad.
 *
 * Katalog wskazuje efekt kluczem `EffectKey`, a ten moduł zawiera klucze,
 * które silnik rozumie, oraz funkcje wyszukujące je w stanie gry. Nowy efekt
 * to nowy klucz tutaj i jego obsługa w module, którego dotyczy (np. `combat.ts`).
 */

import {
  EffectKey,
  getIsland,
  type GameState,
  type HeroCardDef,
  type HeroId,
  type IslandId,
  type IslandNode,
  type MonumentCardId,
} from '../model/index.ts';

/** Efekty wpływające na bitwę. */
export const COMBAT_EFFECTS = {
  /** Heros (Ulisses): jako atakujący ignoruje premie Fortec i Metropolii obrońcy. */
  IGNORE_FORTIFICATIONS: EffectKey('combat.ignoreFortifications'),
  /**
   * Monument (Wielka Cytadela Aresa): wyspy z co najmniej jednym oddziałem
   * (zwykłym albo nieumarłym) nie można zaatakować z żadnego kierunku.
   */
  BLOCK_ATTACKS: EffectKey('combat.blockAttacks'),
  /** Monument (Port Wojenny): floty obrońcy na polach wokół wyspy walczą jak oddziały przy obronie lądu. */
  FLEETS_DEFEND_LAND: EffectKey('combat.fleetsDefendLand'),
} as const;

/** Karta herosa w grze. Rzuca wyjątek, gdy heros lub jego karta nie istnieją. */
export function heroCard(state: GameState, heroId: HeroId): HeroCardDef {
  const hero = state.heroes[heroId];
  const card = hero ? state.catalog.mythCards[hero.cardId] : undefined;
  if (!card || card.type !== 'HERO') throw new Error(`Nieznany heros ${heroId}`);
  return card;
}

export function heroHasAbility(state: GameState, heroId: HeroId, effect: EffectKey): boolean {
  return heroCard(state, heroId).ability === effect;
}

/** Efekt Monumentu stojącego na wyspie albo `null`. */
export function monumentEffect(state: GameState, island: IslandNode): EffectKey | null {
  const built = island.monumentSlot.monument;
  return built ? (state.catalog.monumentCards[built.cardId]?.effect ?? null) : null;
}

/**
 * Monument blokujący atak na wyspę (Wielka Cytadela Aresa z co najmniej
 * jednym oddziałem w garnizonie) albo `null`, gdy atak jest dozwolony.
 * Dotyczy każdego źródła ataku: desantu z morza i efektów kart.
 */
export function attackBlocker(state: GameState, islandId: IslandId): { readonly monument: MonumentCardId } | null {
  const island = getIsland(state.board, islandId);
  const built = island.monumentSlot.monument;
  const troops = (island.garrison?.troops ?? 0) + (island.garrison?.undeadTroops ?? 0);
  if (!built || troops < 1 || monumentEffect(state, island) !== COMBAT_EFFECTS.BLOCK_ATTACKS) return null;
  return { monument: built.cardId };
}
