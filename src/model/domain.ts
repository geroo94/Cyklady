/**
 * @file Słowniki domenowe, czyli odpowiedniki enumów.
 *
 * Zamiast `enum` używamy obiektów `as const` i unii literałów, bo:
 *  - w JSON (zapis gry, protokół sieciowy) wartości są czytelnymi stringami,
 *    np. `'ARES'`, a nie liczbą `0`,
 *  - kod pozostaje „erasable”, więc Node uruchamia go bez kompilacji,
 *  - unie literałów współpracują z wyczerpującym `switch` (kontrola `never`).
 */

/** Pomocniczy typ: unia wartości obiektu. */
export type ValueOf<T> = T[keyof T];

// ---------------------------------------------------------------------------
// Gracze
// ---------------------------------------------------------------------------

/** Kolory graczy (5 zestawów figurek). */
export const PlayerColor = {
  RED: 'RED',
  BLUE: 'BLUE',
  GREEN: 'GREEN',
  YELLOW: 'YELLOW',
  BLACK: 'BLACK',
} as const;
export type PlayerColor = ValueOf<typeof PlayerColor>;

// ---------------------------------------------------------------------------
// Bogowie
// ---------------------------------------------------------------------------

/** Wszyscy bogowie obsługiwani przez model (podstawka + Hades). */
export const God = {
  ARES: 'ARES',
  POSEIDON: 'POSEIDON',
  ZEUS: 'ZEUS',
  ATHENA: 'ATHENA',
  APOLLO: 'APOLLO',
  HADES: 'HADES',
} as const;
export type God = ValueOf<typeof God>;

/**
 * Bogowie, o których względy się licytuje.
 * Apollo nie ma licytacji: może go wybrać wielu graczy naraz, a liczy się
 * kolejność ich przybycia (zob. `GodTrack.apolloSupplicants`).
 */
export type BiddableGod = Exclude<God, 'APOLLO'>;

/**
 * Bogowie losowani na tor w fazie GODS_SETUP.
 * Hades nie trafia do tej puli. Pojawia się tylko po przywołaniu przez
 * Kolumnę Hadesa (zob. `HadesThreatTrack`).
 */
export const RANDOMIZED_GODS: readonly BiddableGod[] = ['ARES', 'POSEIDON', 'ZEUS', 'ATHENA'];

// ---------------------------------------------------------------------------
// Budynki
// ---------------------------------------------------------------------------

/** Typy budynków, które mogą stać w slotach budynków na wyspie. */
export const BuildingType = {
  PORT: 'PORT',
  FORTRESS: 'FORTRESS',
  TEMPLE: 'TEMPLE',
  UNIVERSITY: 'UNIVERSITY',
  THEATER: 'THEATER',
  /** Budynek Hadesa: zbiera JZ za zniszczone jednostki (dodatek Hades). */
  NECROPOLIS: 'NECROPOLIS',
} as const;
export type BuildingType = ValueOf<typeof BuildingType>;

/**
 * Budynek, który można wznieść w turze danego boga.
 * Teatr nie jest przypisany do żadnego boga z podstawki. Źródło teatru
 * (dodatek, efekt karty albo Monumentu) określa silnik zasad.
 */
export const GOD_BUILDING: Readonly<Partial<Record<God, BuildingType>>> = {
  ARES: 'FORTRESS',
  POSEIDON: 'PORT',
  ZEUS: 'TEMPLE',
  ATHENA: 'UNIVERSITY',
  HADES: 'NECROPOLIS',
};

// ---------------------------------------------------------------------------
// Rekrutacja
// ---------------------------------------------------------------------------

/**
 * Wszystko, co gracz może „pozyskać” w swojej turze.
 * Liczniki w `TurnProgress.recruited` pozwalają silnikowi naliczać rosnące
 * ceny kolejnych zakupów w tej samej turze.
 */
export const RecruitKind = {
  TROOP: 'TROOP',
  FLEET: 'FLEET',
  PRIEST: 'PRIEST',
  PHILOSOPHER: 'PHILOSOPHER',
  PRIESTESS: 'PRIESTESS',
  UNDEAD_TROOP: 'UNDEAD_TROOP',
  UNDEAD_FLEET: 'UNDEAD_FLEET',
} as const;
export type RecruitKind = ValueOf<typeof RecruitKind>;
