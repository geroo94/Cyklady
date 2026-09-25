/**
 * @file Warstwa sieciowa: serwer autorytatywny, klient i protokół.
 *
 *  - protocol.ts    kontrakty wiadomości (ClientToServer / ServerToClient)
 *  - validate.ts    walidacja niezaufanych wiadomości klienta
 *  - codec.ts       kodeki JSON i MessagePack
 *  - transport.ts   kanały komunikacji i Local Loopback
 *  - websocket.ts   transport LAN (RFC 6455): nasłuch serwera i klient
 *  - discovery.ts   wykrywanie serwerów LAN (UDP) i łączenie ręczne po adresie
 *  - projection.ts  projekcja stanu dla odbiorcy (ukryte informacje)
 *  - diff.ts        synchronizacja różnicowa (JSON Patch)
 *  - commands.ts    wykonanie intencji na silniku zasad
 *  - ai.ts          gracze komputerowi
 *  - room.ts        pokój: lobby (sloty, kolory, miasta, dodatki, boty, gotowość) i potok komend gry
 *  - turnClock.ts   zegar tury: na kogo czeka gra, limity czasu i ruchy pasywne
 *  - scheduler.ts   zegar i planista zadań (systemowy albo ręczny w testach)
 *  - server.ts      IGameServer i GameServer (Single Player / LAN)
 *  - client.ts      GameClient
 *  - reconnect.ts   automatyczny powrót do partii po zerwaniu połączenia
 */

export * from './protocol.ts';
export * from './validate.ts';
export * from './codec.ts';
export * from './transport.ts';
export * from './websocket.ts';
export * from './discovery.ts';
export * from './projection.ts';
export * from './diff.ts';
export * from './commands.ts';
export * from './ai.ts';
export * from './room.ts';
export * from './server.ts';
export * from './client.ts';
export * from './reconnect.ts';
export * from './scheduler.ts';
export * from './turnClock.ts';
