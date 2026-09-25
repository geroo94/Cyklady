/**
 * @file Walidacja wiadomości klienta, czyli niezaufanych danych z sieci.
 *
 * Wszystko, co przychodzi od klienta, traktujemy jak dane obce: sprawdzamy
 * typy, zakresy liczb, długości napisów i list, zanim cokolwiek dotrze do
 * silnika. Dodatkowe, nieznane pola są pomijane i nie trafiają dalej, bo
 * walidator buduje nowy obiekt. Poprawność ZASAD (czy most istnieje, czy
 * stać gracza) sprawdza już silnik.
 */

import { HeroId, IslandId, PlayerColor, SeaId, type BiddableGod, type NodeId } from '../model/index.ts';
import type { FleetStep } from '../engine/index.ts';
import { PROTOCOL_VERSION, type ActionIntent, type BidChoice, type ClientMessage, type LobbyIntent } from './protocol.ts';

export type ParseResult = { readonly ok: true; readonly message: ClientMessage } | { readonly ok: false; readonly error: string; readonly requestId: string | null };

const MAX_ID = 64;
const MAX_NAME = 32;
const MAX_TOKEN = 128;
const MAX_AMOUNT = 1_000;
const MAX_UNITS = 100;
const MAX_ROUTE = 8;
const MAX_HEROES = 16;
const BIDDABLE: readonly BiddableGod[] = ['ARES', 'POSEIDON', 'ZEUS', 'ATHENA', 'HADES'];
const COLORS: readonly PlayerColor[] = Object.values(PlayerColor);
const MAX_SLOT = 15;

class Invalid extends Error {}

type Obj = Readonly<Record<string, unknown>>;

function object(value: unknown, what: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Invalid(`${what}: oczekiwano obiektu`);
  return value as Obj;
}

function text(value: unknown, what: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new Invalid(`${what}: oczekiwano napisu o długości ${min}–${max}`);
  }
  return value;
}

function integer(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Invalid(`${what}: oczekiwano liczby całkowitej ${min}–${max}`);
  }
  return value;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Invalid(`${what}: oczekiwano wartości logicznej`);
  return value;
}

function optional<T>(value: unknown, parse: (v: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Invalid(`${what}: dozwolone wartości to ${allowed.join(', ')}`);
  }
  return value as T;
}

function list<T>(value: unknown, what: string, max: number, parse: (item: unknown, i: number) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Invalid(`${what}: oczekiwano listy o długości do ${max}`);
  return value.map(parse);
}

const nodeId = (value: unknown, what: string): NodeId => text(value, what, MAX_ID) as NodeId;

function parseBid(value: unknown): BidChoice {
  const bid = object(value, 'bid');
  const kind = oneOf(bid['kind'], ['GOD', 'APOLLO'] as const, 'bid.kind');
  if (kind === 'APOLLO') return { kind };
  return { kind, god: oneOf(bid['god'], BIDDABLE, 'bid.god'), amount: integer(bid['amount'], 'bid.amount', 1, MAX_AMOUNT) };
}

function parseStep(value: unknown, i: number): FleetStep {
  const step = object(value, `route[${i}]`);
  const pickUp = optional(step['pickUp'], (v) => integer(v, `route[${i}].pickUp`, 0, MAX_UNITS));
  const dropOff = optional(step['dropOff'], (v) => integer(v, `route[${i}].dropOff`, 0, MAX_UNITS));
  return {
    to: SeaId(text(step['to'], `route[${i}].to`, MAX_ID)),
    ...(pickUp === undefined ? {} : { pickUp }),
    ...(dropOff === undefined ? {} : { dropOff }),
  };
}

function parseAction(value: unknown): ActionIntent {
  const action = object(value, 'action');
  const type = oneOf(
    action['type'],
    ['MOVE_FLEET', 'MOVE_TROOPS', 'RECRUIT_UNDEAD', 'BUILD_NECROPOLIS', 'BUY_CREATURE', 'RETREAT', 'HOLD'] as const,
    'action.type',
  );
  switch (type) {
    case 'MOVE_FLEET':
      return {
        type,
        from: SeaId(text(action['from'], 'action.from', MAX_ID)),
        count: integer(action['count'], 'action.count', 1, MAX_UNITS),
        route: list(action['route'], 'action.route', MAX_ROUTE, parseStep),
      };
    case 'MOVE_TROOPS': {
      const undeadTroops = optional(action['undeadTroops'], (v) => integer(v, 'action.undeadTroops', 0, MAX_UNITS));
      const heroes = optional(action['heroes'], (v) =>
        list(v, 'action.heroes', MAX_HEROES, (h, i) => HeroId(text(h, `action.heroes[${i}]`, MAX_ID))),
      );
      return {
        type,
        from: IslandId(text(action['from'], 'action.from', MAX_ID)),
        to: IslandId(text(action['to'], 'action.to', MAX_ID)),
        troops: integer(action['troops'], 'action.troops', 0, MAX_UNITS),
        ...(undeadTroops === undefined ? {} : { undeadTroops }),
        ...(heroes === undefined ? {} : { heroes }),
      };
    }
    case 'RECRUIT_UNDEAD':
      return { type, kind: oneOf(action['kind'], ['TROOP', 'FLEET'] as const, 'action.kind'), to: nodeId(action['to'], 'action.to') };
    case 'BUILD_NECROPOLIS':
      return { type, islandId: IslandId(text(action['islandId'], 'action.islandId', MAX_ID)) };
    case 'BUY_CREATURE':
      return { type, slot: integer(action['slot'], 'action.slot', 0, 2) as 0 | 1 | 2 };
    case 'RETREAT':
      return { type, to: nodeId(action['to'], 'action.to') };
    case 'HOLD':
      return { type };
  }
}

function parseLobbyAction(value: unknown): LobbyIntent {
  const action = object(value, 'action');
  const type = oneOf(
    action['type'],
    ['SET_COLOR', 'SET_CITY', 'SET_READY', 'SET_EXPANSIONS', 'ADD_BOT', 'REMOVE_BOT', 'START_GAME'] as const,
    'action.type',
  );
  switch (type) {
    case 'SET_COLOR':
      return { type, color: oneOf(action['color'], COLORS, 'action.color') };
    case 'SET_CITY':
      return { type, city: action['city'] === null ? null : text(action['city'], 'action.city', MAX_ID) };
    case 'SET_READY':
      return { type, ready: flag(action['ready'], 'action.ready') };
    case 'SET_EXPANSIONS':
      return { type, hades: flag(action['hades'], 'action.hades'), monuments: flag(action['monuments'], 'action.monuments') };
    case 'ADD_BOT':
    case 'REMOVE_BOT':
      return { type, slot: integer(action['slot'], 'action.slot', 0, MAX_SLOT) };
    case 'START_GAME':
      return { type };
  }
}

/**
 * Sprawdza i normalizuje wiadomość klienta. Przy błędzie zwraca opis
 * i (jeśli dało się go odczytać) `requestId`, żeby klient mógł powiązać
 * odrzucenie ze swoją prośbą.
 */
export function parseClientMessage(raw: unknown): ParseResult {
  let requestId: string | null = null;
  try {
    const message = object(raw, 'wiadomość');
    if (typeof message['requestId'] === 'string' && message['requestId'].length <= MAX_ID) requestId = message['requestId'];
    if (message['v'] !== PROTOCOL_VERSION) throw new Invalid(`nieobsługiwana wersja protokołu: ${String(message['v'])}`);
    const id = text(message['requestId'], 'requestId', MAX_ID);
    const v = PROTOCOL_VERSION;
    const type = oneOf(
      message['type'],
      ['JOIN_ROOM', 'LOBBY_ACTION', 'SUBMIT_BID', 'EXECUTE_ACTION', 'END_TURN', 'REROLL_DICE', 'REQUEST_SYNC'] as const,
      'type',
    );
    switch (type) {
      case 'JOIN_ROOM': {
        const seatToken = optional(message['seatToken'], (t) => text(t, 'seatToken', MAX_TOKEN));
        return {
          ok: true,
          message: {
            v,
            type,
            requestId: id,
            roomId: text(message['roomId'], 'roomId', MAX_ID),
            playerName: text(message['playerName'], 'playerName', MAX_NAME).trim() || 'Gracz',
            ...(seatToken === undefined ? {} : { seatToken }),
          },
        };
      }
      case 'LOBBY_ACTION':
        return { ok: true, message: { v, type, requestId: id, action: parseLobbyAction(message['action']) } };
      case 'SUBMIT_BID':
        return { ok: true, message: { v, type, requestId: id, bid: parseBid(message['bid']) } };
      case 'EXECUTE_ACTION':
        return { ok: true, message: { v, type, requestId: id, action: parseAction(message['action']) } };
      case 'END_TURN':
      case 'REROLL_DICE':
      case 'REQUEST_SYNC':
        return { ok: true, message: { v, type, requestId: id } };
    }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message, requestId };
    throw error;
  }
}
