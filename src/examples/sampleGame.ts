/**
 * @file Przykładowa mini-partia: mała mapa, kilka kart, trzech graczy.
 *
 * To dane DEMONSTRACYJNE, a nie dane z pudełka. Nazwy, koszty i siły są
 * przykładowe. Plik pokazuje, jak zasilić model, i służy jako fixture testów.
 *
 * Sąsiedztwo (* = pole handlowe z rogiem obfitości):
 *   Naxos : Morze Pn., Morze Środk.*
 *   Paros : Morze Środk.*, Morze Wsch.
 *   Delos : Morze Pn., Morze Pd.*
 *   Milos : Morze Wsch.
 *   Morza : Pn. – Środk.*, Środk.* – Wsch., Pn. – Pd.*
 */

import {
  CardId,
  CreatureFigureId,
  CreatureKey,
  EffectKey,
  GameId,
  HeroKey,
  IslandId,
  MagicItemId,
  MagicItemKey,
  MonumentCardId,
  MonumentKind,
  PlayerId,
  SeaId,
  createGame,
  type GameCatalog,
  type GameState,
  type MapDef,
  type MythCardDef,
  type NewGameOptions,
  type RngState,
} from '../model/index.ts';
import { COMBAT_EFFECTS } from '../engine/effects.ts';
import { placeStartingForces, type StartingForces } from '../engine/orchestrator.ts';

export const P1 = PlayerId('p1');
export const P2 = PlayerId('p2');
export const P3 = PlayerId('p3');

export const NAXOS = IslandId('naxos');
export const PAROS = IslandId('paros');
export const DELOS = IslandId('delos');
export const MILOS = IslandId('milos');

export const SEA_NORTH = SeaId('sea-north');
export const SEA_CENTER = SeaId('sea-center');
export const SEA_EAST = SeaId('sea-east');
export const SEA_SOUTH = SeaId('sea-south');

export const SAMPLE_MAP: MapDef = {
  islands: [
    { id: NAXOS, name: 'Naxos', buildingSlots: 4, prosperity: 2, monumentSite: true },
    { id: PAROS, name: 'Paros', buildingSlots: 3, prosperity: 1, monumentSite: false },
    { id: DELOS, name: 'Delos', buildingSlots: 2, prosperity: 0, monumentSite: true },
    { id: MILOS, name: 'Milos', buildingSlots: 3, prosperity: 1, monumentSite: false },
  ],
  seas: [
    { id: SEA_NORTH, tradeProsperity: 0 },
    { id: SEA_CENTER, tradeProsperity: 1 },
    { id: SEA_EAST, tradeProsperity: 0 },
    { id: SEA_SOUTH, tradeProsperity: 1 },
  ],
  islandSeaEdges: [
    [NAXOS, SEA_NORTH],
    [NAXOS, SEA_CENTER],
    [PAROS, SEA_CENTER],
    [PAROS, SEA_EAST],
    [DELOS, SEA_NORTH],
    [DELOS, SEA_SOUTH],
    [MILOS, SEA_EAST],
  ],
  seaSeaEdges: [
    [SEA_NORTH, SEA_CENTER],
    [SEA_CENTER, SEA_EAST],
    [SEA_NORTH, SEA_SOUTH],
  ],
};

const creature = (id: string, key: string, name: string, figure: 'ISLAND' | 'SEA' | null): MythCardDef => ({
  id: CardId(id),
  type: 'CREATURE',
  key: CreatureKey(key),
  name,
  effect: EffectKey(`creature.${key.toLowerCase()}`),
  figure,
});

const hero = (id: string, key: string, name: string, strength: number, ability?: EffectKey): MythCardDef => ({
  id: CardId(id),
  type: 'HERO',
  key: HeroKey(key),
  name,
  strength,
  ability: ability ?? EffectKey(`hero.${key.toLowerCase()}`),
});

const MYTH_CARDS: readonly MythCardDef[] = [
  creature('c-kraken', 'KRAKEN', 'Kraken', 'SEA'),
  creature('c-minotaur', 'MINOTAUR', 'Minotaur', 'ISLAND'),
  creature('c-pegasus-1', 'PEGASUS', 'Pegaz', null),
  creature('c-pegasus-2', 'PEGASUS', 'Pegaz', null),
  creature('c-harpy', 'HARPY', 'Harpia', null),
  creature('c-giant', 'GIANT', 'Gigant', null),
  hero('h-achilles', 'ACHILLES', 'Achilles', 2),
  hero('h-heracles', 'HERACLES', 'Herakles', 2),
  hero('h-ulysses', 'ULYSSES', 'Ulisses', 1, COMBAT_EFFECTS.IGNORE_FORTIFICATIONS),
];

export const SAMPLE_CATALOG: GameCatalog = {
  mythCards: Object.fromEntries(MYTH_CARDS.map((card) => [card.id, card])),
  magicItems: {
    [MagicItemId('mi-helm')]: {
      id: MagicItemId('mi-helm'),
      key: MagicItemKey('HELM_OF_DARKNESS'),
      name: 'Hełm Ciemności',
      effect: EffectKey('item.helm_of_darkness'),
      uses: 1,
    },
    [MagicItemId('mi-fleece')]: {
      id: MagicItemId('mi-fleece'),
      key: MagicItemKey('GOLDEN_FLEECE'),
      name: 'Złote Runo',
      effect: EffectKey('item.golden_fleece'),
      uses: null,
    },
  },
  monumentCards: {
    [MonumentCardId('m-colossus')]: {
      id: MonumentCardId('m-colossus'),
      kind: MonumentKind('COLOSSUS'),
      name: 'Kolos',
      requiredBuildings: ['PORT', 'TEMPLE'],
      effect: EffectKey('monument.colossus'),
    },
    [MonumentCardId('m-oracle')]: {
      id: MonumentCardId('m-oracle'),
      kind: MonumentKind('ORACLE'),
      name: 'Wyrocznia',
      requiredBuildings: ['TEMPLE', 'UNIVERSITY'],
      effect: EffectKey('monument.oracle'),
    },
    [MonumentCardId('m-citadel')]: {
      id: MonumentCardId('m-citadel'),
      kind: MonumentKind('ARES_CITADEL'),
      name: 'Wielka Cytadela Aresa',
      requiredBuildings: ['FORTRESS', 'FORTRESS'],
      effect: COMBAT_EFFECTS.BLOCK_ATTACKS,
    },
    [MonumentCardId('m-war-port')]: {
      id: MonumentCardId('m-war-port'),
      kind: MonumentKind('WAR_PORT'),
      name: 'Port Wojenny',
      requiredBuildings: ['PORT', 'FORTRESS'],
      effect: COMBAT_EFFECTS.FLEETS_DEFEND_LAND,
    },
  },
};

export const SAMPLE_OPTIONS: NewGameOptions = {
  gameId: GameId('sample-game'),
  seed: 'cyklady-demo',
  players: [
    { id: P1, name: 'Ariadna', color: 'BLUE' },
    { id: P2, name: 'Tezeusz', color: 'RED' },
    { id: P3, name: 'Dedal', color: 'GREEN' },
  ],
  map: SAMPLE_MAP,
  catalog: SAMPLE_CATALOG,
  creatureFigures: [
    { id: CreatureFigureId('fig-kraken'), key: CreatureKey('KRAKEN') },
    { id: CreatureFigureId('fig-minotaur'), key: CreatureKey('MINOTAUR') },
  ],
};

/** Nowa przykładowa partia w fazie INIT. */
export function createSampleGame(overrides: Partial<NewGameOptions> = {}): GameState {
  return createGame({ ...SAMPLE_OPTIONS, ...overrides });
}

/** Rozstawienie startowe dla mapy przykładowej (gracze p1, p2, p3). */
export const SAMPLE_STARTING_FORCES: readonly StartingForces[] = [
  { playerId: P1, island: NAXOS, troops: 2, sea: SEA_CENTER, fleets: 1 },
  { playerId: P2, island: PAROS, troops: 2, sea: SEA_EAST, fleets: 1 },
  { playerId: P3, island: DELOS, troops: 2, sea: SEA_SOUTH, fleets: 1 },
];

/**
 * Gotowa do gry partia przykładowa: gracze z podanymi nazwami (miejsca p1–p3)
 * i rozstawione siły startowe. Faza INIT z krokiem READY. W pokoju sieciowym
 * przekaż `rng` z `GameSetup`, żeby także talie na starcie tasował bezpieczny generator.
 */
export function createSampleMatch(names: readonly string[], random: { readonly seed?: string; readonly rng?: RngState } = {}): GameState {
  const players = SAMPLE_OPTIONS.players.map((player, i) => ({ ...player, name: names[i] ?? player.name }));
  const game = createSampleGame({ players, seed: random.seed ?? SAMPLE_OPTIONS.seed ?? 'cyklady-demo', ...(random.rng ? { rng: random.rng } : {}) });
  return placeStartingForces(game, SAMPLE_STARTING_FORCES);
}
