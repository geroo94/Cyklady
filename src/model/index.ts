/**
 * @file Publiczne API modelu stanu gry Cyklady (+ Hades, + Monumenty).
 *
 * Mapa modułów:
 *  - ids.ts          identyfikatory (typy markowane)
 *  - domain.ts       słowniki: kolory, bogowie, budynki
 *  - rules.ts        konfiguracja zasad (liczby z instrukcji)
 *  - catalog.ts      statyczne definicje kart i przedmiotów
 *  - player.ts       stan gracza i wyliczany widok gracza
 *  - board.ts        plansza jako graf (wyspy, pola morskie)
 *  - trackers.ts     tory i talie (kolejność, bogowie, stwory, Hades, Monumenty)
 *  - pieces.ts       encje z tożsamością (herosi, figurki stworów)
 *  - battle.ts       kontekst bitwy
 *  - phases.ts       fazy i ich konteksty
 *  - stateMachine.ts przejścia, strażnicy, haki
 *  - gameState.ts    korzeń stanu i fabryka partii
 *  - selectors.ts    dane wyliczane
 *  - invariants.ts   walidacja niezmienników
 *  - rng.ts          deterministyczna losowość
 */

export * from './ids.ts';
export * from './domain.ts';
export * from './rules.ts';
export * from './catalog.ts';
export * from './player.ts';
export * from './board.ts';
export * from './trackers.ts';
export * from './pieces.ts';
export * from './battle.ts';
export * from './phases.ts';
export * from './stateMachine.ts';
export * from './gameState.ts';
export * from './selectors.ts';
export * from './invariants.ts';
export * from './rng.ts';
