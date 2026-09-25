/**
 * @file Plansza jako graf.
 *
 * Węzły są dwóch rodzajów: wyspy (`IslandNode`) i pola morskie (`SeaNode`).
 * Krawędzie to listy sąsiedztwa zapisane w obu węzłach. Symetrię sąsiedztwa
 * gwarantuje fabryka planszy (`createBoard` w `gameState.ts`), która buduje
 * obie strony krawędzi z jednej definicji mapy. Weryfikuje ją też
 * `validateGameState`.
 *
 * Topologia Cyklad:
 *  - wyspa sąsiaduje tylko z polami morskimi (wyspy nigdy nie stykają się
 *    bezpośrednio, a oddziały przechodzą między nimi po „moście” z flot),
 *  - pole morskie sąsiaduje z wyspami i innymi polami morskimi.
 *
 * Jednostki na węzłach:
 *  - W stanie spoczynku na wyspie stoją wojska tylko jednego gracza, a na polu
 *    morskim floty tylko jednego gracza. Wejście obcych jednostek oznacza
 *    natychmiastową bitwę. Na jej czas jednostki OBU stron przechodzą do
 *    kontekstu fazy BATTLE_RESOLUTION, a po bitwie zwycięzca wraca na węzeł.
 *    Dlatego `garrison` i `fleet` to pojedynczy obiekt albo `null`, a nie lista.
 *  - Oddziały i floty są wymienne, więc przechowujemy liczniki. Herosi,
 *    figurki stworów i Monumenty mają tożsamość, więc przechowujemy ich ID.
 */

import type { BuildingType } from './domain.ts';
import type {
  CreatureFigureId,
  HeroId,
  IslandId,
  MonumentCardId,
  MonumentKind,
  PlayerId,
  SeaId,
} from './ids.ts';

// ---------------------------------------------------------------------------
// Siły zbrojne na węzłach
// ---------------------------------------------------------------------------

/** Wojska jednego gracza na wyspie. */
export interface LandForce {
  readonly playerId: PlayerId;
  /** Oddziały w kolorze gracza. */
  readonly troops: number;
  /** Nieumarłe oddziały pod dowództwem gracza (dodatek Hades). */
  readonly undeadTroops: number;
  /** Herosi gracza stojący na wyspie (strefa). */
  readonly heroes: readonly HeroId[];
}

/** Floty jednego gracza na polu morskim. */
export interface NavalForce {
  readonly playerId: PlayerId;
  readonly fleets: number;
  /** Nieumarłe floty pod dowództwem gracza (dodatek Hades). */
  readonly undeadFleets: number;
}

// ---------------------------------------------------------------------------
// Wyspa
// ---------------------------------------------------------------------------

/** Pojedyncze miejsce na budynek. Liczba miejsc zależy od wyspy. */
export interface BuildingSlot {
  readonly index: number;
  readonly building: BuildingType | null;
}

/** Skąd wzięła się Metropolia (historia, statystyki, efekty dodatków). */
export type MetropolisOrigin = 'BUILDINGS' | 'PHILOSOPHERS' | 'EFFECT';

/**
 * Metropolia. W regułach liczy się jak komplet budynków
 * z `rules.metropolisBuildingSet` (zob. `countBuildings` w `selectors.ts`).
 */
export interface Metropolis {
  readonly origin: MetropolisOrigin;
  readonly builtInCycle: number;
}

/** Slot na Metropolię. Na jednej wyspie może stać co najwyżej jedna. */
export interface MetropolisSlot {
  readonly metropolis: Metropolis | null;
}

/** Monument zbudowany na wyspie (dodatek Monumenty). */
export interface BuiltMonument {
  readonly cardId: MonumentCardId;
  readonly kind: MonumentKind;
  /** Budowniczy. Korzyści czerpie aktualny właściciel wyspy. */
  readonly builtBy: PlayerId;
  readonly builtInCycle: number;
}

/** Slot na Monument. */
export interface MonumentSlot {
  /** Czy na tej wyspie wolno postawić Monument (dane mapy). */
  readonly available: boolean;
  readonly monument: BuiltMonument | null;
}

/** Znaczniki dobrobytu (rogi obfitości). Każdy daje 1 JZ w fazie INCOME. */
export interface Prosperity {
  /** Nadrukowane na wyspie (stała mapy). */
  readonly printed: number;
  /** Dodatkowe żetony położone w trakcie gry (np. dar Apolla). */
  readonly markers: number;
}

export interface IslandNode {
  readonly kind: 'ISLAND';
  readonly id: IslandId;
  readonly name: string;
  /** Sąsiednie pola morskie (stała mapy). */
  readonly adjacentSeas: readonly SeaId[];

  /**
   * Właściciel wyspy. Trzymany jawnie, bo wyspa może pozostać własnością
   * gracza także bez stacjonujących wojsk. Jeśli `garrison` istnieje,
   * jej `playerId` musi być równy `ownerId`.
   */
  readonly ownerId: PlayerId | null;

  readonly buildingSlots: readonly BuildingSlot[];
  readonly metropolisSlot: MetropolisSlot;
  readonly monumentSlot: MonumentSlot;
  readonly prosperity: Prosperity;

  /** Wojska i herosi na wyspie (w stanie spoczynku najwyżej jeden gracz). */
  readonly garrison: LandForce | null;
  /** Figurki stworów na wyspie (strefa), np. Minotaur, Meduza. */
  readonly creatures: readonly CreatureFigureId[];
}

// ---------------------------------------------------------------------------
// Pole morskie
// ---------------------------------------------------------------------------

/** Pole handlowe, które daje dochód graczowi mającemu tu flotę. */
export interface TradeRoute {
  /** Liczba rogów obfitości, czyli JZ na cykl. */
  readonly prosperity: number;
}

export interface SeaNode {
  readonly kind: 'SEA';
  readonly id: SeaId;
  readonly adjacentIslands: readonly IslandId[];
  readonly adjacentSeas: readonly SeaId[];

  /** `null`, gdy pole nie jest polem handlowym (stała mapy). */
  readonly tradeRoute: TradeRoute | null;

  /** Floty na polu (w stanie spoczynku najwyżej jeden gracz). */
  readonly fleet: NavalForce | null;
  /** Figurki stworów na polu (strefa), np. Kraken. */
  readonly creatures: readonly CreatureFigureId[];
}

// ---------------------------------------------------------------------------
// Graf
// ---------------------------------------------------------------------------

/** Dowolny węzeł (unia rozróżniana po `kind`). */
export type BoardNode = IslandNode | SeaNode;

/**
 * Plansza. Wyspy i pola morskie leżą w osobnych tabelach, więc typ ID
 * jednoznacznie wskazuje tabelę, a kompilator pilnuje, by jej nie pomylić.
 */
export interface BoardGraph {
  readonly islands: Readonly<Record<IslandId, IslandNode>>;
  readonly seas: Readonly<Record<SeaId, SeaNode>>;
}
