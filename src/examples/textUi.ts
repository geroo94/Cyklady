/**
 * @file Wspólny tekstowy interfejs przykładów LAN: zegar tury, raport
 * starcia, przebieg licytacji i polecenia w trakcie partii.
 */

import type { BattleEventMessage, BiddingEventMessage, GameClient, PassiveMove, RoomState, TurnUpdate } from '../net/index.ts';
import type { BiddableGod, PlayerId, ScoreBreakdown, ScoreModifier } from '../model/index.ts';

type Names = (playerId: PlayerId) => string;

/** Nazwy graczy z ROOM_STATE (identyfikator, gdy nazwy brak). */
export function playerNames(room: RoomState | null): Names {
  return (playerId) => room?.seats.find((seat) => seat.playerId === playerId)?.name ?? playerId;
}

const PASSIVE: Readonly<Record<PassiveMove, string>> = {
  APOLLO: 'Apollo',
  END_TURN: 'koniec tury',
  ROLL: 'rzut kośćmi',
  HOLD: 'walka dalej',
};

/** Na kogo czeka gra, co trzeba zrobić i ile zostało czasu. */
export function describeTurn(turn: TurnUpdate, me: PlayerId | null, name: Names): string {
  const who = me !== null && turn.actors.includes(me) ? 'Twój ruch' : `Czekamy na: ${turn.actors.map(name).join(' / ')}`;
  const details = turn.details;
  const what =
    details.reason === 'BID'
      ? 'ofiara dla boga albo Apollo'
      : details.reason === 'OUTBID'
        ? `ofiara przebita przez gracza ${name(details.by)} na ${details.god} (${details.amount} JZ), wybierz innego boga albo Apolla`
        : details.reason === 'GOD_TURN'
          ? `tura boga ${details.god}`
          : details.reason === 'BATTLE_ROLL'
            ? `rzut kośćmi (runda ${details.round})`
            : `odwrót (${details.options.join(', ')}) albo walka dalej`;
  const time = turn.remainingMs === null ? '' : ` [${Math.ceil(turn.remainingMs / 1000)} s, potem: ${PASSIVE[turn.passiveMove]}]`;
  return `${who}: ${what}${time}`;
}

function modifierLabel(modifier: ScoreModifier): string {
  switch (modifier.source) {
    case 'FORTRESS':
      return `Forteca (${modifier.islandId})`;
    case 'PORT':
      return `Port (${modifier.islandId})`;
    case 'METROPOLIS':
      return `Metropolia (${modifier.islandId})`;
    case 'HERO':
      return `heros ${modifier.heroId}`;
    case 'WAR_PORT':
      return `Port Wojenny (${modifier.seaId})`;
    case 'FORTIFICATIONS_IGNORED':
      return `${modifier.heroId} znosi fortyfikacje`;
    case 'CARD_BONUS':
      return 'karty';
  }
}

function describeScore(score: ScoreBreakdown): string {
  const parts = [`kość ${score.roll}`, `jednostki ${score.units}`, ...score.modifiers.map((m) => `${modifierLabel(m)} ${m.value >= 0 ? '+' : ''}${m.value}`)];
  return `${parts.join(', ')} = ${score.total}`;
}

/** Raport bitwy: po jednej linii na zdarzenie. */
export function describeBattle(message: BattleEventMessage, name: Names): string[] {
  return message.events.map((event) => {
    switch (event.type) {
      case 'BATTLE_STARTED':
        return `Bitwa o ${event.where}: atakuje ${name(event.attacker)}, broni ${name(event.defender)}`;
      case 'ROUND_RESOLVED':
        return `Runda ${event.round.round}: ${name(message.attacker)} [${describeScore(event.round.attacker.score)}] : ${name(message.defender)} [${describeScore(event.round.defender.score)}]`;
      case 'RETREAT_DECLINED':
        return `${name(event.playerId)} walczy dalej`;
      case 'RETREATED':
        return `${name(event.playerId)} wycofuje się na ${event.to}`;
      case 'BATTLE_DECIDED':
        return `Rozstrzygnięcie: ${event.outcome.kind}`;
      case 'BATTLE_ENDED':
        return `Koniec bitwy: ${event.outcome.kind}`;
    }
  });
}

/** Przebieg licytacji. Ruchy wykonane przez serwer po upływie czasu są oznaczone. */
export function describeBidding(message: BiddingEventMessage, name: Names): string[] {
  const timeout = message.cause.intent.startsWith('TIMEOUT:') ? ' (czas minął, ruch serwera)' : '';
  return message.events.map((event) => {
    switch (event.type) {
      case 'OFFERING_PLACED':
        return `${name(event.playerId)}: ${event.amount} JZ dla ${event.god}${timeout}`;
      case 'PLAYER_DISPLACED':
        return `${name(event.by)} przebija ofiarę gracza ${name(event.playerId)} na ${event.god}`;
      case 'APOLLO_JOINED':
        return `${name(event.playerId)} idzie do Apolla (miejsce ${event.position})${timeout}`;
      case 'BIDDING_STABLE':
        return 'Wszystkie ofiary złożone';
    }
  });
}

/** Polecenia w trakcie partii: `ofiara ARES 3`, `apollo`, `koniec`, `rzut`, `walcz`. */
export function gameCommands(client: GameClient, argument: string | undefined, amount: string | undefined): Record<string, () => Promise<unknown>> {
  return {
    ofiara: () => client.submitBid({ kind: 'GOD', god: (argument ?? '').toUpperCase() as BiddableGod, amount: Number(amount) }),
    apollo: () => client.submitBid({ kind: 'APOLLO' }),
    koniec: () => client.endTurn(),
    rzut: () => client.rerollDice(),
    walcz: () => client.executeAction({ type: 'HOLD' }),
  };
}

/** Tor bogów w licytacji: kto i ile zaoferował (Apollo jest zawsze wolny). */
export function describeGods(client: GameClient, name: Names): string {
  const slots = client.state?.gods.slots ?? [];
  const gods = slots.map((slot) => `${slot.god} ${slot.offering ? `(${name(slot.offering.playerId)}: ${slot.offering.amount} JZ)` : '(wolny)'}`);
  return `Bogowie: ${[...gods, 'APOLLO'].join(', ')}`;
}

/** Wypisuje na konsoli zegar tury, licytację i raporty bitew klienta. */
export function printGameFeed(client: GameClient): void {
  const name = (playerId: PlayerId): string => playerNames(client.room)(playerId);
  client.on('turn', (turn) => {
    console.log(describeTurn(turn, client.playerId, name));
    const bidding = turn.details.reason === 'BID' || turn.details.reason === 'OUTBID';
    if (bidding && client.isMyTurn) console.log(describeGods(client, name));
  });
  client.on('bidding', (message) => describeBidding(message, name).forEach((line) => console.log(line)));
  client.on('battle', (message) => describeBattle(message, name).forEach((line) => console.log(line)));
  client.on('gameOver', (message) => console.log(`Koniec gry. Wygrywa: ${message.winners.map(name).join(', ')}`));
}
