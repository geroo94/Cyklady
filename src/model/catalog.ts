/**
 * @file Katalog, czyli STATYCZNE definicje kart i przedmiotów.
 *
 * Katalog opisuje, czym JEST dana karta lub przedmiot. Nie mówi, GDZIE się
 * znajduje. Położenie trzymają strefy w stanie gry (talia, tor, stos
 * odrzuconych, zapas gracza, wyspa...). Katalog nie zmienia się w trakcie
 * partii.
 *
 * Karty nie zawierają logiki, tylko `EffectKey`, czyli klucz do rejestru
 * efektów w silniku zasad. Dzięki temu stan gry pozostaje czystym JSON-em,
 * a nową kartę dodaje się przez wpis w katalogu i implementację efektu.
 */

import type { BuildingType } from './domain.ts';
import type {
  CardId,
  CreatureKey,
  EffectKey,
  HeroKey,
  MagicItemId,
  MagicItemKey,
  MonumentCardId,
  MonumentKind,
} from './ids.ts';

/** Gdzie stwór wystawia figurkę (Kraken na morzu, Minotaur na wyspie...). */
export type CreatureFigurePlacement = 'ISLAND' | 'SEA';

/** Karta Mitologicznego Stwora. */
export interface CreatureCardDef {
  readonly id: CardId;
  readonly type: 'CREATURE';
  /** Rodzaj stwora. Kopie tej samej karty mają wspólny klucz. */
  readonly key: CreatureKey;
  /** Nazwa wyświetlana. Docelowo klucz tłumaczenia w UI. */
  readonly name: string;
  readonly effect: EffectKey;
  /** `null`, gdy stwór działa jednorazowo i nie zostawia figurki na planszy. */
  readonly figure: CreatureFigurePlacement | null;
}

/**
 * Karta Herosa (dodatek Hades).
 * Zgodnie ze specyfikacją herosi są na tym samym torze i w tej samej talii
 * co stwory, więc kupuje się ich tak samo jak stwory.
 */
export interface HeroCardDef {
  readonly id: CardId;
  readonly type: 'HERO';
  readonly key: HeroKey;
  readonly name: string;
  /** Siła herosa w bitwie lądowej, czyli ilu oddziałom odpowiada. */
  readonly strength: number;
  readonly ability: EffectKey;
}

/** Karta z talii Mitologicznych Stworów i Herosów (unia rozróżniana po `type`). */
export type MythCardDef = CreatureCardDef | HeroCardDef;

/** Magiczny przedmiot. */
export interface MagicItemDef {
  readonly id: MagicItemId;
  readonly key: MagicItemKey;
  readonly name: string;
  readonly effect: EffectKey;
  /** Liczba użyć po zdobyciu przedmiotu. `null` oznacza przedmiot trwały. */
  readonly uses: number | null;
}

/** Karta Monumentu (dodatek Monumenty). */
export interface MonumentCardDef {
  readonly id: MonumentCardId;
  /** Typ figurki, którą stawia się na wyspie po zbudowaniu. */
  readonly kind: MonumentKind;
  readonly name: string;
  /**
   * Budynki, które gracz musi posiadać (na dowolnych swoich wyspach), żeby
   * Monument stanął automatycznie. Powtórzony typ oznacza kilka sztuk.
   */
  readonly requiredBuildings: readonly BuildingType[];
  /** Pasywna moc Monumentu (zob. `COMBAT_EFFECTS` w silniku). */
  readonly effect: EffectKey;
}

/** Pełny katalog treści używanych w partii. */
export interface GameCatalog {
  readonly mythCards: Readonly<Record<CardId, MythCardDef>>;
  readonly magicItems: Readonly<Record<MagicItemId, MagicItemDef>>;
  readonly monumentCards: Readonly<Record<MonumentCardId, MonumentCardDef>>;
}
