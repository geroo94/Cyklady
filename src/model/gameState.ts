/**
 * @file Korzeń stanu gry (`GameState`) i fabryka nowej partii.
 *
 * Założenia architektoniczne:
 *
 * 1. NIEMUTOWALNOŚĆ. Wszystkie pola są `readonly`. Każda akcja tworzy nową
 *    migawkę stanu (spread albo biblioteka typu Immer). To daje za darmo undo,
 *    powtórki, podróż w czasie w debuggerze i tanie porównania w UI.
 *
 * 2. CZYSTY JSON. Brak klas, `Map`, `Set` i funkcji w stanie. Stan można
 *    zapisać (`JSON.stringify`), wysłać przez sieć i odtworzyć 1:1.
 *
 * 3. JEDNO ŹRÓDŁO PRAWDY I STREFY. Każdy fizyczny element gry (karta, heros,
 *    figurka stwora, przedmiot, karta Monumentu) leży w dokładnie jednej
 *    strefie, np. talia, pole toru, zapas gracza, wyspa, bitwa. Dane pochodne
 *    (dochód, liczba Metropolii, pozycja gracza w licytacji) liczą selektory
 *    (`selectors.ts`). `validateGameState` sprawdza niezmienniki.
 *
 * 4. ZASADY W DANYCH. Liczby z instrukcji siedzą w `rules`, a logika kart
 *    w silniku zasad (klucze `EffectKey`). Model danych nie zawiera reguł gry.
 *
 * 5. DETERMINIZM. Stan generatora losowego (`rng`) jest częścią stanu.
 *    W partii sieciowej to ChaCha20 z tajnym kluczem (`createSecureRng`),
 *    którego projekcja stanu nigdy nie wysyła klientom.
 */

import type { BoardGraph, IslandNode, SeaNode } from './board.ts';
import type { GameCatalog } from './catalog.ts';
import type { PlayerColor } from './domain.ts';
import type {
  CardId,
  CreatureFigureId,
  CreatureKey,
  GameId,
  HeroId,
  IslandId,
  MagicItemId,
  MonumentCardId,
  MonumentKind,
  PlayerId,
  SeaId,
} from './ids.ts';
import type { PhaseState } from './phases.ts';
import type { CreatureFigureState, HeroState } from './pieces.ts';
import type { PlayerState } from './player.ts';
import { seedRng, shuffle, type RngState } from './rng.ts';
import { DEFAULT_RULESET, type RulesetConfig } from './rules.ts';
import {
  createCreatureMarket,
  type CreatureMarket,
  type GodTrack,
  type HadesState,
  type MonumentPool,
  type TurnOrderTrack,
} from './trackers.ts';

/** Wersja schematu stanu. Podbijana przy niekompatybilnych zmianach (migracje zapisów). */
export const SCHEMA_VERSION = 1 as const;

export interface GameState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly gameId: GameId;
  /**
   * Licznik zmian. Każda zmiana stanu go podbija. Służy do optymistycznej
   * współbieżności w sieci (odrzucanie akcji wysłanych do starej wersji stanu)
   * i do synchronizacji klientów.
   */
  readonly revision: number;
  readonly rules: RulesetConfig;
  readonly rng: RngState;

  /** Numer cyklu: 0 w INIT, 1 w pierwszym cyklu gry. */
  readonly cycle: number;
  /** Maszyna stanów: aktualna faza i jej kontekst. */
  readonly phase: PhaseState;

  // --- Gracze ---------------------------------------------------------------
  /** Stała kolejność przy stole (kolejność iteracji, UI). */
  readonly seating: readonly PlayerId[];
  readonly players: Readonly<Record<PlayerId, PlayerState>>;

  // --- Plansza --------------------------------------------------------------
  readonly board: BoardGraph;

  // --- Tory i talie ---------------------------------------------------------
  readonly turnOrder: TurnOrderTrack;
  readonly gods: GodTrack;
  readonly creatureMarket: CreatureMarket;

  // --- Treści i encje -------------------------------------------------------
  readonly catalog: GameCatalog;
  /** Herosi w grze. Położenie wynika ze strefy, w której leży ich ID. */
  readonly heroes: Readonly<Record<HeroId, HeroState>>;
  readonly creatureFigures: Readonly<Record<CreatureFigureId, CreatureFigureState>>;
  /** Figurki stworów poza planszą (strefa). */
  readonly creatureFigureSupply: readonly CreatureFigureId[];
  /** Magiczne przedmioty jeszcze nierozdane (strefa). */
  readonly magicItemSupply: readonly MagicItemId[];

  // --- Dodatki (null = dodatek wyłączony) ---------------------------------
  readonly hades: HadesState | null;
  readonly monuments: MonumentPool | null;
}

// ===========================================================================
// Definicja mapy i budowa grafu
// ===========================================================================

/** Statyczny opis wyspy na mapie. */
export interface IslandDef {
  readonly id: IslandId;
  readonly name: string;
  readonly buildingSlots: number;
  /** Nadrukowane znaczniki dobrobytu. */
  readonly prosperity: number;
  /** Czy wyspa ma miejsce na Monument. */
  readonly monumentSite: boolean;
}

/** Statyczny opis pola morskiego. */
export interface SeaDef {
  readonly id: SeaId;
  /** Rogi obfitości pola handlowego (0 oznacza zwykłe pole). */
  readonly tradeProsperity: number;
}

/**
 * Mapa. Każdą krawędź zapisuje się raz, a fabryka buduje obie strony
 * sąsiedztwa. Asymetrii nie da się więc wprowadzić przez pomyłkę w danych.
 */
export interface MapDef {
  readonly islands: readonly IslandDef[];
  readonly seas: readonly SeaDef[];
  readonly islandSeaEdges: readonly (readonly [IslandId, SeaId])[];
  readonly seaSeaEdges: readonly (readonly [SeaId, SeaId])[];
}

/** Buduje graf planszy z definicji mapy. Rzuca wyjątek przy błędnych danych. */
export function createBoard(map: MapDef): BoardGraph {
  const islandIds = new Set<IslandId>();
  for (const island of map.islands) {
    if (islandIds.has(island.id)) throw new Error(`Mapa: zduplikowana wyspa ${island.id}`);
    islandIds.add(island.id);
  }
  const seaIds = new Set<SeaId>();
  for (const sea of map.seas) {
    if (seaIds.has(sea.id)) throw new Error(`Mapa: zduplikowane pole morskie ${sea.id}`);
    seaIds.add(sea.id);
  }

  const islandSeas = new Map<IslandId, Set<SeaId>>([...islandIds].map((id) => [id, new Set<SeaId>()]));
  const seaIslands = new Map<SeaId, Set<IslandId>>([...seaIds].map((id) => [id, new Set<IslandId>()]));
  const seaSeas = new Map<SeaId, Set<SeaId>>([...seaIds].map((id) => [id, new Set<SeaId>()]));

  for (const [islandId, seaId] of map.islandSeaEdges) {
    const seas = islandSeas.get(islandId);
    const islands = seaIslands.get(seaId);
    if (!seas || !islands) throw new Error(`Mapa: krawędź ${islandId}–${seaId} wskazuje nieistniejący węzeł`);
    seas.add(seaId);
    islands.add(islandId);
  }
  for (const [a, b] of map.seaSeaEdges) {
    if (a === b) throw new Error(`Mapa: pole morskie ${a} nie może sąsiadować samo ze sobą`);
    const fromA = seaSeas.get(a);
    const fromB = seaSeas.get(b);
    if (!fromA || !fromB) throw new Error(`Mapa: krawędź ${a}–${b} wskazuje nieistniejące pole morskie`);
    fromA.add(b);
    fromB.add(a);
  }

  const islands: Record<IslandId, IslandNode> = {};
  for (const def of map.islands) {
    islands[def.id] = {
      kind: 'ISLAND',
      id: def.id,
      name: def.name,
      adjacentSeas: [...(islandSeas.get(def.id) ?? [])],
      ownerId: null,
      buildingSlots: Array.from({ length: def.buildingSlots }, (_, index) => ({ index, building: null })),
      metropolisSlot: { metropolis: null },
      monumentSlot: { available: def.monumentSite, monument: null },
      prosperity: { printed: def.prosperity, markers: 0 },
      garrison: null,
      creatures: [],
    };
  }

  const seas: Record<SeaId, SeaNode> = {};
  for (const def of map.seas) {
    seas[def.id] = {
      kind: 'SEA',
      id: def.id,
      adjacentIslands: [...(seaIslands.get(def.id) ?? [])],
      adjacentSeas: [...(seaSeas.get(def.id) ?? [])],
      tradeRoute: def.tradeProsperity > 0 ? { prosperity: def.tradeProsperity } : null,
      fleet: null,
      creatures: [],
    };
  }

  return { islands, seas };
}

// ===========================================================================
// Fabryka nowej partii
// ===========================================================================

export interface NewPlayer {
  readonly id: PlayerId;
  readonly name: string;
  readonly color: PlayerColor;
}

/** Fizyczna figurka stwora dostępna w partii. */
export interface CreatureFigureDef {
  readonly id: CreatureFigureId;
  readonly key: CreatureKey;
}

export interface NewGameOptions {
  readonly gameId: GameId;
  /** Ziarno generatora testowego (mulberry32). Domyślnie równe `gameId`. */
  readonly seed?: string;
  /**
   * Gotowy generator, np. `createSecureRng()` na serwerze. Ma pierwszeństwo
   * przed `seed`. Partia sieciowa musi używać generatora z tajnym kluczem,
   * bo `gameId` i ziarno tekstowe są jawne.
   */
  readonly rng?: RngState;
  readonly rules?: RulesetConfig;
  readonly players: readonly NewPlayer[];
  readonly map: MapDef;
  readonly catalog: GameCatalog;
  readonly creatureFigures?: readonly CreatureFigureDef[];
}

/**
 * Tworzy partię w fazie INIT: potasowane talie, losowa kolejność graczy,
 * pełne zapasy figurek. Rozstawienie sił startowych należy do silnika zasad
 * (kontekst `InitPhase.placementQueue`).
 */
export function createGame(options: NewGameOptions): GameState {
  const rules = options.rules ?? DEFAULT_RULESET;
  validatePlayers(options.players, rules);
  validateCatalogAgainstExpansions(options.catalog, rules);

  let rng = options.rng ?? seedRng(options.seed ?? options.gameId);

  // Kolejność startowa jest losowa. Przy wariancie z kilkoma znacznikami
  // ofiary na gracza każdy znacznik zajmuje osobne miejsce na torze.
  const seating = options.players.map((p) => p.id);
  const markers = seating.flatMap((id) => Array.from({ length: rules.offeringMarkersPerPlayer }, () => id));
  let initialOrder: PlayerId[];
  [initialOrder, rng] = shuffle(markers, rng);

  const players: Record<PlayerId, PlayerState> = {};
  for (const p of options.players) {
    players[p.id] = {
      id: p.id,
      name: p.name,
      color: p.color,
      gold: rules.startingGold,
      philosophers: 0,
      priests: 0,
      priestesses: 0,
      magicItems: [],
      reserve: { troops: rules.troopsPerPlayer, fleets: rules.fleetsPerPlayer, heroes: [] },
    };
  }

  let mythDeck: CardId[];
  [mythDeck, rng] = shuffle(Object.values(options.catalog.mythCards).map((c) => c.id), rng);

  const creatureFigures: Record<CreatureFigureId, CreatureFigureState> = {};
  for (const fig of options.creatureFigures ?? []) {
    creatureFigures[fig.id] = { id: fig.id, key: fig.key, controllerId: null, placedInCycle: null };
  }

  let monuments: MonumentPool | null = null;
  if (rules.expansions.monuments) {
    const cards = Object.values(options.catalog.monumentCards);
    const figureSupply: Record<MonumentKind, number> = {};
    for (const card of cards) figureSupply[card.kind] = (figureSupply[card.kind] ?? 0) + 1;
    let deck: MonumentCardId[];
    [deck, rng] = shuffle(cards.map((c) => c.id), rng);
    monuments = { deck, offer: [], discard: [], dealt: {}, figureSupply };
  }

  const hades: HadesState | null = rules.expansions.hades
    ? {
        threat: { level: 0, summonPending: false },
        undeadSupply: { troops: rules.hades.undeadTroops, fleets: rules.hades.undeadFleets },
        necropolisGold: {},
        lastThreatRoll: null,
      }
    : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    gameId: options.gameId,
    revision: 0,
    rules,
    rng,
    cycle: 0,
    phase: { phase: 'INIT', step: 'PLACE_STARTING_FORCES', placementQueue: initialOrder },
    seating,
    players,
    board: createBoard(options.map),
    turnOrder: { current: initialOrder, next: [] },
    gods: { slots: [], apolloSupplicants: [], unavailable: [] },
    creatureMarket: createCreatureMarket(mythDeck),
    catalog: options.catalog,
    heroes: {},
    creatureFigures,
    creatureFigureSupply: Object.keys(creatureFigures) as CreatureFigureId[],
    magicItemSupply: Object.values(options.catalog.magicItems).map((item) => item.id),
    hades,
    monuments,
  };
}

function validatePlayers(players: readonly NewPlayer[], rules: RulesetConfig): void {
  if (rules.godsRevealedByPlayerCount[players.length] === undefined) {
    throw new Error(`Brak konfiguracji zasad dla ${players.length} graczy (rules.godsRevealedByPlayerCount)`);
  }
  if (new Set(players.map((p) => p.id)).size !== players.length) {
    throw new Error('Identyfikatory graczy muszą być unikalne');
  }
  if (new Set(players.map((p) => p.color)).size !== players.length) {
    throw new Error('Każdy gracz musi mieć inny kolor');
  }
}

function validateCatalogAgainstExpansions(catalog: GameCatalog, rules: RulesetConfig): void {
  const hasHeroes = Object.values(catalog.mythCards).some((card) => card.type === 'HERO');
  if (hasHeroes && !rules.expansions.hades) {
    throw new Error('Katalog zawiera karty herosów, ale dodatek Hades jest wyłączony');
  }
  const hasMonuments = Object.keys(catalog.monumentCards).length > 0;
  if (hasMonuments && !rules.expansions.monuments) {
    throw new Error('Katalog zawiera karty Monumentów, ale dodatek Monumenty jest wyłączony');
  }
}
