/**
 * @file Identyfikatory encji gry.
 *
 * W runtime każdy identyfikator jest zwykłym stringiem: łatwo go serializować
 * do JSON, przesłać przez sieć i zapisać w bazie. W systemie typów ID są
 * „markowane” (branded types), więc kompilator nie pozwoli np. użyć ID pola
 * morskiego tam, gdzie oczekiwane jest ID wyspy, ani indeksować rekordu graczy
 * dowolnym stringiem.
 *
 * Konwencja: typ i funkcja-konstruktor mają tę samą nazwę, np.
 * `const p: PlayerId = PlayerId('p1')`. Konstruktor to jedyne miejsce,
 * w którym „surowy” string staje się identyfikatorem.
 */

declare const brand: unique symbol;

/** Typ markowany: wartość typu `T` z niewidocznym w runtime znacznikiem `B`. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// ---------------------------------------------------------------------------
// Identyfikatory INSTANCJI (konkretne obiekty w konkretnej partii)
// ---------------------------------------------------------------------------

/** Identyfikator partii. */
export type GameId = Brand<string, 'GameId'>;
export const GameId = (raw: string): GameId => raw as GameId;

/** Identyfikator gracza. */
export type PlayerId = Brand<string, 'PlayerId'>;
export const PlayerId = (raw: string): PlayerId => raw as PlayerId;

/** Identyfikator wyspy, czyli lądowego węzła grafu planszy. */
export type IslandId = Brand<string, 'IslandId'>;
export const IslandId = (raw: string): IslandId => raw as IslandId;

/** Identyfikator pola morskiego, czyli morskiego węzła grafu planszy. */
export type SeaId = Brand<string, 'SeaId'>;
export const SeaId = (raw: string): SeaId => raw as SeaId;

/** Dowolny węzeł planszy (wyspa albo pole morskie). */
export type NodeId = IslandId | SeaId;

/**
 * Fizyczna karta z talii Mitologicznych Stworów i Herosów.
 * Dwie kopie tej samej karty mają różne `CardId`, ale ten sam klucz treści.
 */
export type CardId = Brand<string, 'CardId'>;
export const CardId = (raw: string): CardId => raw as CardId;

/** Heros w grze (figurka), powiązany z kartą, z której go kupiono. */
export type HeroId = Brand<string, 'HeroId'>;
export const HeroId = (raw: string): HeroId => raw as HeroId;

/** Figurka stwora na planszy (np. Kraken na morzu, Minotaur na wyspie). */
export type CreatureFigureId = Brand<string, 'CreatureFigureId'>;
export const CreatureFigureId = (raw: string): CreatureFigureId => raw as CreatureFigureId;

/** Egzemplarz magicznego przedmiotu. */
export type MagicItemId = Brand<string, 'MagicItemId'>;
export const MagicItemId = (raw: string): MagicItemId => raw as MagicItemId;

/** Karta Monumentu (dodatek Monumenty). */
export type MonumentCardId = Brand<string, 'MonumentCardId'>;
export const MonumentCardId = (raw: string): MonumentCardId => raw as MonumentCardId;

/** Identyfikator bitwy (log, powtórki, animacje w UI). */
export type BattleId = Brand<string, 'BattleId'>;
export const BattleId = (raw: string): BattleId => raw as BattleId;

// ---------------------------------------------------------------------------
// Klucze TREŚCI (definicje z katalogu, wspólne dla wielu egzemplarzy)
// ---------------------------------------------------------------------------

/** Rodzaj stwora, np. `KRAKEN`. Wiele kart może mieć ten sam klucz. */
export type CreatureKey = Brand<string, 'CreatureKey'>;
export const CreatureKey = (raw: string): CreatureKey => raw as CreatureKey;

/** Rodzaj herosa. */
export type HeroKey = Brand<string, 'HeroKey'>;
export const HeroKey = (raw: string): HeroKey => raw as HeroKey;

/** Rodzaj magicznego przedmiotu. */
export type MagicItemKey = Brand<string, 'MagicItemKey'>;
export const MagicItemKey = (raw: string): MagicItemKey => raw as MagicItemKey;

/** Rodzaj Monumentu, czyli typ figurki Monumentu. */
export type MonumentKind = Brand<string, 'MonumentKind'>;
export const MonumentKind = (raw: string): MonumentKind => raw as MonumentKind;

/**
 * Klucz efektu w rejestrze silnika zasad.
 * Model danych nie zawiera logiki kart. Karta wskazuje tylko, KTÓRY efekt
 * wykonać, a implementację trzyma silnik zasad (wzorzec Strategy/Registry).
 */
export type EffectKey = Brand<string, 'EffectKey'>;
export const EffectKey = (raw: string): EffectKey => raw as EffectKey;
