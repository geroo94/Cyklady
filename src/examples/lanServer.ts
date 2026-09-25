/**
 * @file Przykład: gospodarz gry LAN z lobby i ogłoszeniami w sieci lokalnej.
 *
 * Uruchomienie:   npm run serve:lan            (WebSocket 7777, ogłoszenia UDP 45454)
 *                 PORT=9000 npm run serve:lan
 *
 * Gospodarz jest hostem lobby (gra w tym samym procesie przez Local Loopback).
 * Pozostali gracze widzą pokój w menu „Dołącz do gry LAN” (`npm run browse:lan`)
 * albo łączą się ręcznie po adresie IP i porcie.
 *
 * Polecenia gospodarza (standardowe wejście):
 *   bot <slot>        dodaj bota na wolnym slocie
 *   usun <slot>       usuń bota
 *   hades on|off      Hades włączony/wyłączony
 *   monumenty on|off  Monumenty włączone/wyłączone
 *   start             rozpocznij partię (wszyscy goście muszą być gotowi)
 * W trakcie partii: `ofiara ARES 3`, `apollo`, `koniec`, `rzut`, `walcz`.
 * Tury mają limit czasu, a rozłączony gracz ma 60 s na powrót.
 */

import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';

import { ActionRejectedError, GameClient, createLanServer } from '../net/index.ts';
import { archipelagoLobby } from './archipelago.ts';
import { gameCommands, printGameFeed } from './textUi.ts';

const server = createLanServer({ port: Number(process.env['PORT'] ?? 7777) });
server.createRoom(archipelagoLobby('archipelag', 'Archipelag'));

const info = await server.start().catch((error: unknown) => {
  console.log(`Nie można uruchomić serwera LAN: ${error instanceof Error ? error.message : error}`);
  console.log('Port zajęty? Wybierz inny: PORT=9000 npm run serve:lan');
  process.exit(1);
});
const port = new URL(info.url ?? 'ws://localhost').port;
// 0.0.0.0 oznacza „wszystkie interfejsy”: gracze łączą się pod adresem IP tego komputera w sieci lokalnej.
const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((address) => address !== undefined && address.family === 'IPv4' && !address.internal)
  .map((address) => `${address?.address}:${port}`);
console.log(`Serwer LAN: port ${port}, ogłoszenia UDP na porcie ${info.discoveryPort}.`);
console.log(`Łączenie ręczne: ${addresses.length > 0 ? addresses.join(', ') : `localhost:${port}`}`);

const host = new GameClient(server.connectLocal());
host.on('room', (room) => {
  const status = (seat: (typeof room.seats)[number]): string =>
    seat.reconnectDeadline !== null
      ? `rozłączony, czeka ${Math.max(0, Math.round((seat.reconnectDeadline - Date.now()) / 1000))} s`
      : seat.playerId === room.host
        ? 'host'
        : seat.kind === 'AI'
          ? 'bot'
          : seat.ready
            ? 'gotowy'
            : 'czeka';
  const seats = room.seats.map((seat) =>
    seat.kind === 'EMPTY' ? `[${seat.slot}] wolne` : `[${seat.slot}] ${seat.name} (${status(seat)}, ${seat.color}, ${seat.city ?? 'miasto losowe'})`,
  );
  const { hades, monuments } = room.settings.expansions;
  console.log(`\n${room.status} | Hades: ${hades ? 'tak' : 'nie'}, Monumenty: ${monuments ? 'tak' : 'nie'}\n  ${seats.join('\n  ')}`);
});
host.on('state', (state, sync) => {
  if (sync.mode === 'FULL') console.log(`Partia: cykl ${state.cycle}, faza ${state.phase.phase}`);
});
printGameFeed(host);
await host.joinRoom('archipelag', 'Gospodarz');

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const [command, argument, amount] = line.trim().split(/\s+/);
  const on = argument === 'on';
  const current = host.room?.settings.expansions ?? { hades: true, monuments: true };
  const actions: Record<string, () => Promise<unknown>> = {
    ...gameCommands(host, argument, amount),
    bot: () => host.addBot(Number(argument)),
    usun: () => host.removeBot(Number(argument)),
    hades: () => host.setExpansions({ ...current, hades: on }),
    monumenty: () => host.setExpansions({ ...current, monuments: on }),
    start: () => host.startGame(),
  };
  const action = command ? actions[command] : undefined;
  if (!action) {
    return console.log('Polecenia: bot <slot>, usun <slot>, hades on|off, monumenty on|off, start, ofiara <BÓG> <JZ>, apollo, koniec, rzut, walcz');
  }
  action().catch((error: unknown) => console.log(error instanceof ActionRejectedError ? `Odmowa: ${error.message}` : error));
});

process.on('SIGINT', () => {
  input.close();
  void server.stop().then(() => process.exit(0));
});
