/**
 * @file Mapa „Archipelag” dla 3–5 graczy i gotowa konfiguracja pokoju z lobby.
 *
 * Pięć miast startowych leży na brzegu archipelagu, każde przy własnym
 * morzu przybrzeżnym. Morza przybrzeżne tworzą pierścień wokół Morza
 * Centralnego, a trzy neutralne wyspy (Delos, Syros, Paros) czekają na
 * kolonizację. W lobby gracz wybiera jedno z miast (unikalne).
 *
 * Sąsiedztwo (* = pole handlowe):
 *   miasta:   Andros: Pn. | Mykonos: Pn-Wsch. | Naxos: Pd-Wsch.* | Milos: Pd-Zach. | Kea: Pn-Zach.*
 *   neutralne: Delos: Centralne* | Syros: Pn., Pn-Zach.* | Paros: Pn-Wsch., Pd-Wsch.*
 *   morza:    pierścień Pn. – Pn-Wsch. – Pd-Wsch. – Pd-Zach. – Pn-Zach. – Pn.,
 *             a Morze Centralne sąsiaduje z każdym morzem przybrzeżnym
 *
 * To dane DEMONSTRACYJNE (liczby i nazwy przykładowe).
 */

import {
  DEFAULT_RULESET,
  GameId,
  IslandId,
  PlayerColor,
  PlayerId,
  SeaId,
  createGame,
  type GameCatalog,
  type GameState,
  type MapDef,
} from '../model/index.ts';
import { placeStartingForces, type StartingForces } from '../engine/orchestrator.ts';
import type { GameSetup, RoomConfig } from '../net/room.ts';
import { SAMPLE_OPTIONS } from './sampleGame.ts';

const island = IslandId;
const sea = SeaId;

/** Miasta startowe: wyspa i morze przybrzeżne z pierwszą flotą. */
export const ARCHIPELAGO_CITIES = [
  { city: 'andros', sea: 'arch-n' },
  { city: 'mykonos', sea: 'arch-ne' },
  { city: 'naxos', sea: 'arch-se' },
  { city: 'milos', sea: 'arch-sw' },
  { city: 'kea', sea: 'arch-nw' },
] as const;

export const ARCHIPELAGO_MAP: MapDef = {
  islands: [
    { id: island('andros'), name: 'Andros', buildingSlots: 3, prosperity: 1, monumentSite: false },
    { id: island('mykonos'), name: 'Mykonos', buildingSlots: 3, prosperity: 1, monumentSite: false },
    { id: island('naxos'), name: 'Naxos', buildingSlots: 4, prosperity: 1, monumentSite: true },
    { id: island('milos'), name: 'Milos', buildingSlots: 3, prosperity: 1, monumentSite: true },
    { id: island('kea'), name: 'Kea', buildingSlots: 3, prosperity: 1, monumentSite: false },
    { id: island('delos'), name: 'Delos', buildingSlots: 2, prosperity: 2, monumentSite: true },
    { id: island('syros'), name: 'Syros', buildingSlots: 3, prosperity: 1, monumentSite: true },
    { id: island('paros'), name: 'Paros', buildingSlots: 2, prosperity: 1, monumentSite: false },
  ],
  seas: [
    { id: sea('arch-center'), tradeProsperity: 1 },
    { id: sea('arch-n'), tradeProsperity: 0 },
    { id: sea('arch-ne'), tradeProsperity: 0 },
    { id: sea('arch-se'), tradeProsperity: 1 },
    { id: sea('arch-sw'), tradeProsperity: 0 },
    { id: sea('arch-nw'), tradeProsperity: 1 },
  ],
  islandSeaEdges: [
    [island('andros'), sea('arch-n')],
    [island('mykonos'), sea('arch-ne')],
    [island('naxos'), sea('arch-se')],
    [island('milos'), sea('arch-sw')],
    [island('kea'), sea('arch-nw')],
    [island('delos'), sea('arch-center')],
    [island('syros'), sea('arch-n')],
    [island('syros'), sea('arch-nw')],
    [island('paros'), sea('arch-ne')],
    [island('paros'), sea('arch-se')],
  ],
  seaSeaEdges: [
    [sea('arch-n'), sea('arch-ne')],
    [sea('arch-ne'), sea('arch-se')],
    [sea('arch-se'), sea('arch-sw')],
    [sea('arch-sw'), sea('arch-nw')],
    [sea('arch-nw'), sea('arch-n')],
    [sea('arch-center'), sea('arch-n')],
    [sea('arch-center'), sea('arch-ne')],
    [sea('arch-center'), sea('arch-se')],
    [sea('arch-center'), sea('arch-sw')],
    [sea('arch-center'), sea('arch-nw')],
  ],
};

/** Katalog z treściami tylko włączonych dodatków (herosi: Hades, karty Monumentów: Monumenty). */
export function catalogFor(expansions: GameSetup['expansions']): GameCatalog {
  const base = SAMPLE_OPTIONS.catalog;
  return {
    ...base,
    mythCards: expansions.hades
      ? base.mythCards
      : Object.fromEntries(Object.entries(base.mythCards).filter(([, card]) => card.type !== 'HERO')),
    monumentCards: expansions.monuments ? base.monumentCards : {},
  };
}

/** Partia na Archipelagu z wyniku lobby: gracze, kolory, miasta startowe i dodatki. */
export function createArchipelagoMatch(setup: GameSetup): GameState {
  const game = createGame({
    gameId: GameId(`archipelag-${setup.gameId}`),
    rng: setup.rng,
    rules: { ...DEFAULT_RULESET, expansions: setup.expansions },
    players: setup.players.map((player) => ({ id: player.playerId, name: player.name, color: player.color })),
    map: ARCHIPELAGO_MAP,
    catalog: catalogFor(setup.expansions),
    ...(SAMPLE_OPTIONS.creatureFigures === undefined ? {} : { creatureFigures: SAMPLE_OPTIONS.creatureFigures }),
  });
  const forces: StartingForces[] = setup.players.map((player, i) => {
    const start = ARCHIPELAGO_CITIES.find((entry) => entry.city === player.city) ?? ARCHIPELAGO_CITIES[i];
    if (!start) throw new Error(`Brak miasta startowego dla gracza ${player.playerId}`);
    return { playerId: player.playerId, island: island(start.city), troops: 2, sea: sea(start.sea), fleets: 1 };
  });
  return placeStartingForces(game, forces);
}

const SLOT_COLORS: readonly PlayerColor[] = ['BLUE', 'RED', 'GREEN', 'YELLOW', 'BLACK'];

/**
 * Pokój z lobby na Archipelagu: 5 slotów, start od 3 graczy na polecenie
 * hosta, wybór miasta, oba dodatki domyślnie włączone. Hostem może być tylko
 * gracz w procesie serwera (gospodarz LAN).
 */
export function archipelagoLobby(roomId: string, roomName: string, overrides: Partial<RoomConfig> = {}): RoomConfig {
  return {
    roomId,
    roomName,
    seats: SLOT_COLORS.map((color, i) => ({ playerId: PlayerId(`p${i + 1}`), color, kind: 'HUMAN' as const })),
    startMode: 'HOST',
    minPlayers: 3,
    cities: ARCHIPELAGO_CITIES.map((entry) => entry.city),
    expansions: { hades: true, monuments: true },
    hostPolicy: 'LOCAL_ONLY',
    createGame: (_names, setup) => createArchipelagoMatch(setup),
    ...overrides,
  };
}
