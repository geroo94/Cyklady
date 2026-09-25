/**
 * @file Konfiguracja zasad (ruleset).
 *
 * Wszystkie „magiczne liczby” z zasad są w jednym miejscu i wchodzą w skład
 * `GameState.rules`. Dzięki temu:
 *  - zapis partii jest samowystarczalny: powtórka działa nawet po zmianie
 *    wartości domyślnych w nowej wersji aplikacji,
 *  - warianty (np. rozgrywka 2-osobowa, zasady domowe, erraty) wymagają tylko
 *    innej konfiguracji, bez zmian w kodzie.
 *
 * UWAGA: wartości oznaczone [zweryfikuj] są robocze. Przed wydaniem trzeba je
 * potwierdzić w instrukcji posiadanej edycji (podstawka, Hades, Monumenty).
 */

import type { BattleRole } from './battle.ts';
import type { BuildingType } from './domain.ts';
import type { HadesLevel } from './trackers.ts';

/** Włączone dodatki. Wyłączony dodatek ma w stanie gry wartość `null`. */
export interface ExpansionFlags {
  readonly hades: boolean;
  readonly monuments: boolean;
}

/** Parametry dodatku Hades. */
export interface HadesRules {
  /** Poziom Kolumny Hadesa, na którym Hades zostaje przywołany. */
  readonly summonLevel: HadesLevel;
  /** Poziom, do którego kolumna spada po przywołaniu Hadesa. */
  readonly levelAfterSummon: HadesLevel;
  /** Liczba figurek nieumarłych oddziałów we wspólnej puli. [zweryfikuj] */
  readonly undeadTroops: number;
  /** Liczba figurek nieumarłych flot we wspólnej puli. [zweryfikuj] */
  readonly undeadFleets: number;
  /** Ścianki kości rzucanych na początku cyklu na Kolumnę Hadesa. [zweryfikuj] */
  readonly threatDieFaces: readonly number[];
  /** Liczba kości rzucanych na Kolumnę Hadesa (suma oczek przesuwa kolumnę). */
  readonly threatDiceCount: number;
  /**
   * Koszt kolejnych nieumarłych jednego rodzaju w turze Hadesa (indeks = który
   * z kolei). Długość listy to limit rekrutacji na turę. [zweryfikuj]
   */
  readonly undeadCosts: readonly number[];
  /** Koszt budowy Nekropolii w JZ. [zweryfikuj] */
  readonly necropolisCost: number;
  /** JZ odkładane na każdej Nekropolii za jedną zniszczoną zwykłą jednostkę. */
  readonly necropolisGoldPerUnit: number;
}

/** Parametry ruchu jednostek (Posejdon: floty, Ares: oddziały). */
export interface MovementRules {
  /** Najwięcej pól morskich, które grupa flot pokonuje w jednym ruchu. */
  readonly fleetRange: number;
  /** Koszt jednego ruchu grupy (flot albo oddziałów) w JZ. */
  readonly costPerMove: number;
  /**
   * Reguła ostatniej wyspy: nie wolno atakować ani zajmować jedynej wyspy
   * przeciwnika, chyba że po jej zdobyciu atakujący ma
   * `metropolisesToWin` Metropolii.
   */
  readonly protectLastIsland: boolean;
}

/** Parametry bitwy. */
export interface CombatRules {
  /** Ścianki kości bitewnej (każda równie prawdopodobna). */
  readonly dieFaces: readonly number[];
  /** Kolejność decyzji o odwrocie po każdej rundzie. */
  readonly retreatOrder: readonly BattleRole[];
}

export interface RulesetConfig {
  readonly expansions: ExpansionFlags;

  /** Figurki oddziałów w kolorze gracza (zapas + plansza + bitwa = stała). */
  readonly troopsPerPlayer: number;
  /** Figurki flot w kolorze gracza (zapas + plansza + bitwa = stała). */
  readonly fleetsPerPlayer: number;
  /** Złoto (JZ) na start. [zweryfikuj] */
  readonly startingGold: number;

  /**
   * Liczba znaczników ofiary na gracza. Standardowo 1. Tor kolejności
   * i oferty są listami, więc model obsłuży też wariant z 2 znacznikami.
   */
  readonly offeringMarkersPerPlayer: number;
  /**
   * Ilu bogów (bez Apolla) odkrywa się w GODS_SETUP przy danej liczbie graczy.
   * Liczba graczy jest obsługiwana tylko wtedy, gdy ma tu wpis.
   * [zweryfikuj] wariant 2-osobowy
   */
  readonly godsRevealedByPlayerCount: Readonly<Partial<Record<number, number>>>;

  /** Filozofowie potrzebni do natychmiastowego założenia Metropolii. */
  readonly philosophersPerMetropolis: number;
  /** Komplet różnych budynków, który zamienia się w Metropolię. */
  readonly metropolisBuildingSet: readonly BuildingType[];
  /** Metropolie potrzebne do zwycięstwa (sprawdzane w END_OF_CYCLE). */
  readonly metropolisesToWin: number;

  readonly movement: MovementRules;
  readonly combat: CombatRules;
  readonly hades: HadesRules;
}

/** Domyślny zestaw zasad: podstawka + oba dodatki. */
export const DEFAULT_RULESET: RulesetConfig = {
  expansions: { hades: true, monuments: true },

  troopsPerPlayer: 8,
  fleetsPerPlayer: 8,
  startingGold: 5,

  offeringMarkersPerPlayer: 1,
  godsRevealedByPlayerCount: { 3: 2, 4: 3, 5: 4 },

  philosophersPerMetropolis: 4,
  metropolisBuildingSet: ['PORT', 'FORTRESS', 'TEMPLE', 'UNIVERSITY'],
  metropolisesToWin: 2,

  movement: {
    fleetRange: 3,
    costPerMove: 1,
    protectLastIsland: true,
  },

  combat: {
    dieFaces: [0, 1, 1, 2, 2, 3],
    retreatOrder: ['DEFENDER', 'ATTACKER'],
  },

  hades: {
    summonLevel: 9,
    levelAfterSummon: 0,
    undeadTroops: 8,
    undeadFleets: 8,
    threatDieFaces: [0, 1, 1, 2, 2, 3],
    threatDiceCount: 2,
    undeadCosts: [0, 1, 2, 3],
    necropolisCost: 2,
    necropolisGoldPerUnit: 1,
  },
};
