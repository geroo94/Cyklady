/**
 * @file Niezmienniki stanu gry.
 *
 * `validateGameState` zwraca listę naruszeń (pusta lista oznacza poprawny
 * stan). Zastosowania:
 *  - testy silnika zasad: po każdej akcji stan musi pozostać poprawny,
 *  - wczytywanie zapisów i danych z sieci: odrzucenie uszkodzonego JSON-a,
 *  - tryb deweloperski: walidacja po każdej zmianie stanu.
 *
 * Sprawdzane grupy:
 *  1. graf planszy (symetria sąsiedztwa, istnienie węzłów),
 *  2. siły na węzłach (właściciel, nieujemne liczniki),
 *  3. zasady zachowania jednostek (zapas + plansza + bitwa = pula),
 *  4. strefy: każda karta, heros, przedmiot i figurka w dokładnie jednym miejscu,
 *  5. gracze (nieujemne zasoby, filozofowie poniżej progu Metropolii),
 *  6. tory (oferty, kolejność, Kolumna Hadesa),
 *  7. spójność kontekstu fazy.
 */

import { sidePresence, type BattleSide } from './battle.ts';
import type { GameState } from './gameState.ts';
import type { CardId, CreatureFigureId, HeroId, MagicItemId, MonumentCardId, PlayerId } from './ids.ts';
import { HADES_LEVEL_MAX, HADES_LEVEL_MIN } from './trackers.ts';

export type InvariantCode =
  | 'GRAPH'
  | 'FORCE'
  | 'UNIT_CONSERVATION'
  | 'ZONE_DUPLICATE'
  | 'ZONE_MISSING'
  | 'ZONE_UNKNOWN'
  | 'PLAYER_RESOURCES'
  | 'GOD_TRACK'
  | 'OFFERING_MARKERS'
  | 'TURN_ORDER'
  | 'HADES'
  | 'MONUMENTS'
  | 'EXPANSIONS'
  | 'PHASE';

export interface InvariantViolation {
  readonly code: InvariantCode;
  readonly message: string;
}

export class InvalidGameStateError extends Error {
  readonly violations: readonly InvariantViolation[];

  constructor(violations: readonly InvariantViolation[]) {
    super(`Niepoprawny stan gry:\n${violations.map((v) => `- [${v.code}] ${v.message}`).join('\n')}`);
    this.name = 'InvalidGameStateError';
    this.violations = violations;
  }
}

/** Rzuca `InvalidGameStateError`, jeśli stan narusza którykolwiek niezmiennik. */
export function assertValidGameState(state: GameState): void {
  const violations = validateGameState(state);
  if (violations.length > 0) throw new InvalidGameStateError(violations);
}

export function validateGameState(state: GameState): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const report = (code: InvariantCode, message: string): void => {
    out.push({ code, message });
  };

  checkGraph(state, report);
  checkForces(state, report);
  checkUnitConservation(state, report);
  checkZones(state, report);
  checkPlayers(state, report);
  checkTracks(state, report);
  checkExpansions(state, report);
  checkPhase(state, report);
  return out;
}

type Report = (code: InvariantCode, message: string) => void;

// ---------------------------------------------------------------------------
// 1. Graf
// ---------------------------------------------------------------------------

function checkGraph(state: GameState, report: Report): void {
  const { islands, seas } = state.board;
  for (const island of Object.values(islands)) {
    for (const seaId of island.adjacentSeas) {
      const sea = seas[seaId];
      if (!sea) report('GRAPH', `Wyspa ${island.id} sąsiaduje z nieistniejącym polem ${seaId}`);
      else if (!sea.adjacentIslands.includes(island.id)) {
        report('GRAPH', `Sąsiedztwo niesymetryczne: ${island.id} -> ${seaId}, ale nie odwrotnie`);
      }
    }
  }
  for (const sea of Object.values(seas)) {
    for (const islandId of sea.adjacentIslands) {
      const island = islands[islandId];
      if (!island) report('GRAPH', `Pole ${sea.id} sąsiaduje z nieistniejącą wyspą ${islandId}`);
      else if (!island.adjacentSeas.includes(sea.id)) {
        report('GRAPH', `Sąsiedztwo niesymetryczne: ${sea.id} -> ${islandId}, ale nie odwrotnie`);
      }
    }
    for (const otherId of sea.adjacentSeas) {
      const other = seas[otherId];
      if (otherId === sea.id) report('GRAPH', `Pole ${sea.id} sąsiaduje samo ze sobą`);
      else if (!other) report('GRAPH', `Pole ${sea.id} sąsiaduje z nieistniejącym polem ${otherId}`);
      else if (!other.adjacentSeas.includes(sea.id)) {
        report('GRAPH', `Sąsiedztwo niesymetryczne: ${sea.id} -> ${otherId}, ale nie odwrotnie`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Siły na węzłach
// ---------------------------------------------------------------------------

function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function checkForces(state: GameState, report: Report): void {
  const knownPlayer = (id: PlayerId): boolean => Object.hasOwn(state.players, id);

  for (const island of Object.values(state.board.islands)) {
    if (island.ownerId !== null && !knownPlayer(island.ownerId)) {
      report('FORCE', `Wyspa ${island.id} należy do nieznanego gracza ${island.ownerId}`);
    }
    if (!isCount(island.prosperity.markers)) report('FORCE', `Wyspa ${island.id}: niepoprawne znaczniki dobrobytu`);
    if (island.monumentSlot.monument !== null && !island.monumentSlot.available) {
      report('MONUMENTS', `Wyspa ${island.id} nie ma miejsca na Monument, a stoi na niej Monument`);
    }

    const g = island.garrison;
    if (g === null) continue;
    if (g.playerId !== island.ownerId) {
      report('FORCE', `Wyspa ${island.id}: wojska gracza ${g.playerId}, a właściciel to ${island.ownerId}`);
    }
    if (!isCount(g.troops) || !isCount(g.undeadTroops)) report('FORCE', `Wyspa ${island.id}: niepoprawne liczniki wojsk`);
    if (g.troops + g.undeadTroops + g.heroes.length === 0) {
      report('FORCE', `Wyspa ${island.id}: pusty garnizon powinien mieć wartość null`);
    }
  }

  for (const sea of Object.values(state.board.seas)) {
    const f = sea.fleet;
    if (f === null) continue;
    if (!knownPlayer(f.playerId)) report('FORCE', `Pole ${sea.id}: flota nieznanego gracza ${f.playerId}`);
    if (!isCount(f.fleets) || !isCount(f.undeadFleets)) report('FORCE', `Pole ${sea.id}: niepoprawne liczniki flot`);
    if (f.fleets + f.undeadFleets === 0) report('FORCE', `Pole ${sea.id}: pusta flota powinna mieć wartość null`);
  }
}

// ---------------------------------------------------------------------------
// 3. Zasady zachowania jednostek
// ---------------------------------------------------------------------------

function battleSides(state: GameState): { side: BattleSide; kind: 'LAND' | 'SEA' }[] {
  if (state.phase.phase !== 'BATTLE_RESOLUTION') return [];
  const { battle } = state.phase;
  return [
    { side: battle.attacker, kind: battle.location.kind },
    { side: battle.defender, kind: battle.location.kind },
  ];
}

function checkUnitConservation(state: GameState, report: Report): void {
  const sides = battleSides(state);
  let undeadTroops = 0;
  let undeadFleets = 0;

  for (const playerId of state.seating) {
    const player = state.players[playerId];
    if (!player) continue; // zgłaszane w checkPlayers
    let troops = player.reserve.troops;
    let fleets = player.reserve.fleets;
    for (const island of Object.values(state.board.islands)) {
      if (island.garrison?.playerId === playerId) troops += island.garrison.troops;
    }
    for (const sea of Object.values(state.board.seas)) {
      if (sea.fleet?.playerId === playerId) fleets += sea.fleet.fleets;
    }
    for (const { side, kind } of sides) {
      if (side.playerId !== playerId) continue;
      if (kind === 'LAND') troops += side.units;
      else fleets += side.units;
    }
    if (troops !== state.rules.troopsPerPlayer) {
      report('UNIT_CONSERVATION', `Gracz ${playerId}: ${troops} oddziałów, oczekiwano ${state.rules.troopsPerPlayer}`);
    }
    if (fleets !== state.rules.fleetsPerPlayer) {
      report('UNIT_CONSERVATION', `Gracz ${playerId}: ${fleets} flot, oczekiwano ${state.rules.fleetsPerPlayer}`);
    }
  }

  for (const island of Object.values(state.board.islands)) undeadTroops += island.garrison?.undeadTroops ?? 0;
  for (const sea of Object.values(state.board.seas)) undeadFleets += sea.fleet?.undeadFleets ?? 0;
  for (const { side, kind } of sides) {
    if (kind === 'LAND') undeadTroops += side.undead;
    else undeadFleets += side.undead;
  }

  if (state.hades === null) {
    if (undeadTroops + undeadFleets > 0) report('UNIT_CONSERVATION', 'Nieumarli w grze bez dodatku Hades');
    return;
  }
  const expectTroops = state.rules.hades.undeadTroops;
  const expectFleets = state.rules.hades.undeadFleets;
  if (undeadTroops + state.hades.undeadSupply.troops !== expectTroops) {
    report('UNIT_CONSERVATION', `Nieumarłe oddziały: plansza + bitwa + pula ≠ ${expectTroops}`);
  }
  if (undeadFleets + state.hades.undeadSupply.fleets !== expectFleets) {
    report('UNIT_CONSERVATION', `Nieumarłe floty: plansza + bitwa + pula ≠ ${expectFleets}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Strefy
// ---------------------------------------------------------------------------

/**
 * Sprawdza, czy każdy identyfikator z `universe` leży w dokładnie jednej
 * strefie i czy w strefach nie ma identyfikatorów spoza `universe`.
 */
function checkZoneSet<T extends string>(
  label: string,
  universe: Iterable<T>,
  zones: readonly (readonly [zone: string, ids: Iterable<T>])[],
  report: Report,
): void {
  const seenIn = new Map<T, string>();
  for (const [zone, ids] of zones) {
    for (const id of ids) {
      const previous = seenIn.get(id);
      if (previous !== undefined) report('ZONE_DUPLICATE', `${label} ${id} leży jednocześnie w „${previous}” i „${zone}”`);
      else seenIn.set(id, zone);
    }
  }
  const known = new Set(universe);
  for (const [id, zone] of seenIn) {
    if (!known.has(id)) report('ZONE_UNKNOWN', `${label} ${id} w strefie „${zone}” nie istnieje w katalogu`);
  }
  for (const id of known) {
    if (!seenIn.has(id)) report('ZONE_MISSING', `${label} ${id} nie leży w żadnej strefie`);
  }
}

function checkZones(state: GameState, report: Report): void {
  const islands = Object.values(state.board.islands);
  const seas = Object.values(state.board.seas);
  const players = state.seating.flatMap((id) => {
    const player = state.players[id];
    return player ? [player] : [];
  });
  const sides = battleSides(state);

  // Karty stworów i herosów: talia, tor, stos odrzuconych, herosi w grze.
  const market = state.creatureMarket;
  checkZoneSet<CardId>(
    'Karta',
    Object.values(state.catalog.mythCards).map((card) => card.id),
    [
      ['talia', market.deck],
      ['tor stworów', market.slots.flatMap((slot) => (slot.card === null ? [] : [slot.card]))],
      ['stos odrzuconych', market.discard],
      ['herosi w grze', Object.values(state.heroes).map((hero) => hero.cardId)],
    ],
    report,
  );

  // Herosi: zapasy graczy, garnizony, bitwa.
  checkZoneSet<HeroId>(
    'Heros',
    Object.values(state.heroes).map((hero) => hero.id),
    [
      ...players.map((p) => [`zapas ${p.id}`, p.reserve.heroes] as const),
      ...islands.map((i) => [`wyspa ${i.id}`, i.garrison?.heroes ?? []] as const),
      ...sides.map(({ side }) => [`bitwa (${side.playerId})`, side.heroes] as const),
    ],
    report,
  );

  // Magiczne przedmioty: pula i gracze.
  checkZoneSet<MagicItemId>(
    'Przedmiot',
    Object.values(state.catalog.magicItems).map((item) => item.id),
    [
      ['pula przedmiotów', state.magicItemSupply],
      ...players.map((p) => [`gracz ${p.id}`, p.magicItems.map((item) => item.itemId)] as const),
    ],
    report,
  );

  // Figurki stworów: zapas i węzły planszy.
  checkZoneSet<CreatureFigureId>(
    'Figurka stwora',
    Object.values(state.creatureFigures).map((figure) => figure.id),
    [
      ['zapas figurek', state.creatureFigureSupply],
      ...islands.map((i) => [`wyspa ${i.id}`, i.creatures] as const),
      ...seas.map((s) => [`morze ${s.id}`, s.creatures] as const),
    ],
    report,
  );

  // Karty Monumentów: pula i wyspy.
  const pool = state.monuments;
  checkZoneSet<MonumentCardId>(
    'Karta Monumentu',
    Object.values(state.catalog.monumentCards).map((card) => card.id),
    [
      ['talia Monumentów', pool?.deck ?? []],
      ['oferta Monumentów', pool?.offer ?? []],
      ['odrzucone Monumenty', pool?.discard ?? []],
      ...Object.entries(pool?.dealt ?? {}).map(([playerId, cards]) => [`karty gracza ${playerId}`, cards] as const),
      ...islands.map((i) => [`wyspa ${i.id}`, i.monumentSlot.monument ? [i.monumentSlot.monument.cardId] : []] as const),
    ],
    report,
  );
}

// ---------------------------------------------------------------------------
// 5. Gracze
// ---------------------------------------------------------------------------

function checkPlayers(state: GameState, report: Report): void {
  const seated = new Set(state.seating);
  if (seated.size !== state.seating.length) report('PLAYER_RESOURCES', 'Gracz występuje przy stole więcej niż raz');
  for (const id of Object.keys(state.players)) {
    if (!seated.has(id as PlayerId)) report('PLAYER_RESOURCES', `Gracz ${id} nie siedzi przy stole (seating)`);
  }

  for (const playerId of state.seating) {
    const p = state.players[playerId];
    if (!p) {
      report('PLAYER_RESOURCES', `Brak stanu gracza ${playerId}`);
      continue;
    }
    if (p.id !== playerId) report('PLAYER_RESOURCES', `Gracz ${playerId} ma w stanie inne id: ${p.id}`);
    const resources = {
      gold: p.gold,
      philosophers: p.philosophers,
      priests: p.priests,
      priestesses: p.priestesses,
      'reserve.troops': p.reserve.troops,
      'reserve.fleets': p.reserve.fleets,
    };
    for (const [name, value] of Object.entries(resources)) {
      if (!isCount(value)) report('PLAYER_RESOURCES', `Gracz ${playerId}: ${name} = ${value}`);
    }
    if (p.philosophers >= state.rules.philosophersPerMetropolis) {
      report('PLAYER_RESOURCES', `Gracz ${playerId}: ${p.philosophers} filozofów powinno już zostać zamienionych w Metropolię`);
    }
    for (const item of p.magicItems) {
      if (item.usesLeft !== null && !isCount(item.usesLeft)) {
        report('PLAYER_RESOURCES', `Gracz ${playerId}: przedmiot ${item.itemId} ma niepoprawną liczbę użyć`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Tory
// ---------------------------------------------------------------------------

function countOccurrences(ids: readonly PlayerId[]): Map<PlayerId, number> {
  const counts = new Map<PlayerId, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function checkTracks(state: GameState, report: Report): void {
  const markers = state.rules.offeringMarkersPerPlayer;

  // Tor bogów: każdy bóg najwyżej raz, oferty tylko od znanych graczy, limit znaczników.
  const gods = [...state.gods.slots.map((slot) => slot.god), ...state.gods.unavailable];
  if (new Set(gods).size !== gods.length) report('GOD_TRACK', 'Bóg występuje na torze więcej niż raz');
  const offerers = [
    ...state.gods.slots.flatMap((slot) => (slot.offering ? [slot.offering.playerId] : [])),
    ...state.gods.apolloSupplicants,
  ];
  const placed = countOccurrences(offerers);
  for (const playerId of placed.keys()) {
    if (!Object.hasOwn(state.players, playerId)) report('GOD_TRACK', `Ofiara nieznanego gracza ${playerId}`);
  }
  for (const slot of state.gods.slots) {
    if (slot.offering && (!Number.isInteger(slot.offering.amount) || slot.offering.amount < 1)) {
      report('GOD_TRACK', `Niepoprawna kwota ofiary u boga ${slot.god}: ${slot.offering.amount}`);
    }
  }
  checkOfferingMarkers(state, placed, report);

  // Tor kolejności: `current` to dokładnie `markers` wystąpień każdego gracza, a `next` tego nie przekracza.
  const current = countOccurrences(state.turnOrder.current);
  for (const playerId of state.seating) {
    if ((current.get(playerId) ?? 0) !== markers) {
      report('TURN_ORDER', `Gracz ${playerId} ma ${current.get(playerId) ?? 0} miejsc na torze kolejności (oczekiwano ${markers})`);
    }
  }
  if (state.turnOrder.current.length !== state.seating.length * markers) {
    report('TURN_ORDER', 'Tor kolejności zawiera graczy spoza stołu');
  }
  for (const [playerId, count] of countOccurrences(state.turnOrder.next)) {
    if (count > markers) report('TURN_ORDER', `Gracz ${playerId} występuje ${count} razy w kolejności na następny cykl`);
  }

  // Kolumna Hadesa.
  if (state.hades) {
    const level = state.hades.threat.level;
    if (!Number.isInteger(level) || level < HADES_LEVEL_MIN || level > HADES_LEVEL_MAX) {
      report('HADES', `Poziom Kolumny Hadesa poza zakresem 0-9: ${level}`);
    }
    const supply = state.hades.undeadSupply;
    if (!isCount(supply.troops) || !isCount(supply.fleets)) report('HADES', 'Niepoprawna pula nieumarłych');
  }

  // Figurki Monumentów i karty rozdane graczom.
  if (state.monuments) {
    for (const [kind, count] of Object.entries(state.monuments.figureSupply)) {
      if (!isCount(count)) report('MONUMENTS', `Niepoprawna liczba figurek Monumentu ${kind}: ${count}`);
    }
    for (const playerId of Object.keys(state.monuments.dealt)) {
      if (!state.seating.includes(playerId as PlayerId)) report('MONUMENTS', `Karty Monumentów nieznanego gracza ${playerId}`);
    }
  }

  // Nekropolie: najwyżej jedna na wyspie, a pula JZ tylko przy istniejącej Nekropolii.
  const necropolisIslands = new Set<string>();
  for (const island of Object.values(state.board.islands)) {
    const count = island.buildingSlots.filter((slot) => slot.building === 'NECROPOLIS').length;
    if (count > 1) report('HADES', `Na wyspie ${island.id} stoi ${count} Nekropolii (limit 1)`);
    if (count > 0) necropolisIslands.add(island.id);
  }
  if (necropolisIslands.size > 0 && state.hades === null) report('EXPANSIONS', 'Nekropolia w grze bez dodatku Hades');
  for (const [islandId, gold] of Object.entries(state.hades?.necropolisGold ?? {})) {
    if (!necropolisIslands.has(islandId)) report('HADES', `Pula JZ Nekropolii na wyspie ${islandId}, na której nie ma Nekropolii`);
    if (!isCount(gold)) report('HADES', `Niepoprawna pula JZ Nekropolii na wyspie ${islandId}: ${gold}`);
  }
}

/**
 * Zasada zachowania znaczników ofiary. Każdy gracz ma
 * `rules.offeringMarkersPerPlayer` znaczników, a każdy z nich leży dokładnie
 * w jednym miejscu:
 *  - poza licytacją (od CREATURES_REFRESH do INCOME): u gracza, więc tor jest pusty,
 *  - w BIDDING: w kolejce, w ręce wypartego gracza albo na torze,
 *  - od ACTIONS do END_OF_CYCLE: na torze (bogowie albo Apollo).
 */
function checkOfferingMarkers(state: GameState, placed: Map<PlayerId, number>, report: Report): void {
  const markers = state.rules.offeringMarkersPerPlayer;
  const phase = state.phase;
  const expectedOnTrack = (playerId: PlayerId): number | null => {
    switch (phase.phase) {
      case 'BIDDING': {
        const inQueue = phase.queue.filter((id) => id === playerId).length;
        const inHand = phase.displaced?.playerId === playerId ? 1 : 0;
        return markers - inQueue - inHand;
      }
      case 'ACTIONS':
      case 'BATTLE_RESOLUTION':
      case 'END_OF_CYCLE':
        return markers;
      case 'CREATURES_REFRESH':
      case 'GODS_SETUP':
      case 'INCOME':
        return 0;
      case 'INIT':
      case 'GAME_OVER':
        return null;
    }
  };
  for (const playerId of state.seating) {
    const expected = expectedOnTrack(playerId);
    const actual = placed.get(playerId) ?? 0;
    if (expected !== null && actual !== expected) {
      report(
        'OFFERING_MARKERS',
        `Gracz ${playerId}: ${actual} znaczników ofiary na torze w fazie ${phase.phase}, oczekiwano ${expected}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Dodatki i faza
// ---------------------------------------------------------------------------

function checkExpansions(state: GameState, report: Report): void {
  if (state.rules.expansions.hades !== (state.hades !== null)) {
    report('EXPANSIONS', 'Flaga dodatku Hades nie zgadza się z obecnością stanu Hadesa');
  }
  if (state.rules.expansions.monuments !== (state.monuments !== null)) {
    report('EXPANSIONS', 'Flaga dodatku Monumenty nie zgadza się z obecnością puli Monumentów');
  }
}

function checkPhase(state: GameState, report: Report): void {
  const phase = state.phase;
  const actions = phase.phase === 'ACTIONS' ? phase : phase.phase === 'BATTLE_RESOLUTION' ? phase.resume : null;
  if (actions && (actions.turnIndex < 0 || actions.turnIndex >= actions.turns.length)) {
    report('PHASE', `Indeks tury ${actions.turnIndex} poza zakresem 0..${actions.turns.length - 1}`);
  }

  if (phase.phase === 'BATTLE_RESOLUTION') {
    const { battle } = phase;
    if (battle.attacker.playerId === battle.defender.playerId) report('PHASE', 'Gracz nie może walczyć sam ze sobą');
    if (battle.location.kind === 'LAND') {
      const island = state.board.islands[battle.location.islandId];
      if (!island) report('PHASE', `Bitwa na nieznanej wyspie ${battle.location.islandId}`);
      else if (island.garrison !== null && battle.step !== 'FINISHED') {
        report('PHASE', `Podczas bitwy wojska z wyspy ${island.id} powinny być przeniesione do kontekstu bitwy`);
      }
    } else {
      const sea = state.board.seas[battle.location.seaId];
      if (!sea) report('PHASE', `Bitwa na nieznanym polu ${battle.location.seaId}`);
      else if (sea.fleet !== null && battle.step !== 'FINISHED') {
        report('PHASE', `Podczas bitwy floty z pola ${sea.id} powinny być przeniesione do kontekstu bitwy`);
      }
      if (battle.attacker.heroes.length + battle.defender.heroes.length > 0) {
        report('PHASE', 'Herosi nie biorą udziału w bitwie morskiej');
      }
    }
    const decided = battle.step === 'CLEANUP' || battle.step === 'FINISHED';
    if (decided !== (battle.outcome !== null)) {
      report('PHASE', 'Wynik bitwy musi być ustawiony dokładnie w krokach CLEANUP i FINISHED');
    }
    if (!decided && (sidePresence(battle.attacker) === 0 || sidePresence(battle.defender) === 0)) {
      report('PHASE', 'Nierozstrzygnięta bitwa wymaga jednostek po obu stronach');
    }
  }

  if (phase.phase === 'BIDDING' && phase.settlement !== null) {
    if (phase.queue.length > 0 || phase.displaced !== null) {
      report('PHASE', 'Licytacja została rozliczona, choć nie wszystkie znaczniki leżą na torze');
    }
  }

  if (phase.phase === 'INIT' && state.cycle !== 0) report('PHASE', 'Faza INIT musi mieć numer cyklu 0');
  if (phase.phase !== 'INIT' && state.cycle < 1) report('PHASE', 'Po fazie INIT numer cyklu musi być ≥ 1');
}
