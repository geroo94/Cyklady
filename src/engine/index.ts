/**
 * @file Silnik zasad: logika gry działająca na modelu z `src/model`.
 *
 *  - cycle.ts         zasady faz automatycznych i haki cyklu (CYCLE_HOOKS)
 *  - orchestrator.ts  przebieg partii: fazy automatyczne, na kogo czeka gra, koniec tury
 *  - bidding.ts       licytacja bogów (faza BIDDING)
 *  - pathfinding.ts   algorytmy grafowe: zasięg flot, mosty z flot (BFS, union-find)
 *  - movement.ts      walidacja i wykonanie ruchów flot (Posejdon) i wojsk (Ares)
 *  - combat.ts        silnik bitwy krok po kroku (rzut, odwrót, sprzątanie)
 *  - creatures.ts     efekty stworów (Gigant)
 *  - expansions/      dodatki jako moduły zdarzeń cyklu: Hades, Monumenty
 *  - effects.ts       klucze efektów herosów i Monumentów obsługiwane przez silnik
 *  - turns.ts         wspólna walidacja tury boga
 *  - boardOps.ts      niemutowalne operacje na planszy
 */

export * from './cycle.ts';
export * from './orchestrator.ts';
export * from './bidding.ts';
export * from './pathfinding.ts';
export * from './movement.ts';
export * from './combat.ts';
export * from './creatures.ts';
export * from './effects.ts';
export * from './turns.ts';
export * from './boardOps.ts';
export * from './expansions/module.ts';
export * from './expansions/registry.ts';
export * from './expansions/hades.ts';
export * from './expansions/monuments.ts';
