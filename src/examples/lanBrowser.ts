/**
 * @file Przykład: menu „Dołącz do gry LAN” w wersji tekstowej.
 *
 * Uruchomienie:   npm run browse:lan                        (lista pokoi z ogłoszeń UDP)
 *                 npm run browse:lan -- 192.168.1.20:7777   (łączenie ręczne po adresie)
 *
 * Z listy wybiera się pokój numerem. W lobby: `kolor <KOLOR>`, `miasto <nazwa>`,
 * `gotowy` / `niegotowy`. W partii: `ofiara ARES 3`, `apollo`, `koniec`,
 * `rzut`, `walcz`. Po zerwaniu połączenia klient sam wraca na swoje miejsce.
 */

import { createInterface } from 'node:readline';

import {
  ActionRejectedError,
  DISCOVERY_PORT,
  DiscoveryListener,
  GameClient,
  autoReconnect,
  connectManually,
  connectWebSocket,
  type ClientChannel,
  type DiscoveredRoom,
} from '../net/index.ts';
import { PlayerColor } from '../model/index.ts';
import { gameCommands, printGameFeed } from './textUi.ts';

const input = createInterface({ input: process.stdin });
const name = process.env['PLAYER'] ?? 'Gracz LAN';
let client: GameClient | null = null;

/** Komunikat dla gracza zamiast śladu stosu. */
const explain = (error: unknown): string =>
  error instanceof ActionRejectedError ? `Odmowa: ${error.message}` : error instanceof Error ? error.message : String(error);

function quit(error: unknown): never {
  console.log(explain(error));
  process.exit(1);
}

/** Dołącza do pokoju. `connect` otwiera nowe połączenie z tym samym serwerem (powrót po zerwaniu). */
async function join(connect: () => Promise<ClientChannel>, roomId: string): Promise<void> {
  const current = new GameClient(await connect());
  client = current;
  current.on('room', (room) => {
    const seats = room.seats.map((seat) =>
      seat.kind === 'EMPTY'
        ? `[${seat.slot}] wolne`
        : `[${seat.slot}] ${seat.name}${seat.playerId === room.host ? ' (host)' : seat.ready ? ' ✓' : ''}${seat.connected ? '' : ' (rozłączony)'}`,
    );
    console.log(`${room.settings.roomName} (${room.status}): ${seats.join(', ')}`);
  });
  current.on('state', (state, sync) => {
    if (sync.mode === 'FULL') console.log(`Partia: cykl ${state.cycle}, faza ${state.phase.phase}`);
  });
  printGameFeed(current);
  autoReconnect(current, connect, {
    onAttempt: (attempt) => console.log(`Połączenie zerwane. Próba powrotu nr ${attempt}…`),
    onReconnected: () => console.log('Powrót do partii udany: pełny stan odebrany.'),
    onGiveUp: (error) => quit(`Nie udało się wrócić do partii (${explain(error)}).`),
  });
  const room = await current.joinRoom(roomId, name);
  console.log(`Dołączono jako ${room.you}. Kolory: ${Object.values(PlayerColor).join(', ')}. Miasta: ${room.settings.cities.join(', ')}.`);
}

const manual = process.argv[2];
if (manual) {
  // Łączenie awaryjne: bez ogłoszeń, po adresie wpisanym przez gracza.
  await join(() => connectManually(manual), process.env['ROOM'] ?? 'archipelag').catch(quit);
} else {
  const discovery = new DiscoveryListener();
  await discovery.start().catch((error: unknown) => {
    console.log(`Nie można nasłuchiwać ogłoszeń LAN (${explain(error)}).`);
    quit('Połącz się ręcznie: npm run browse:lan -- ADRES_IP:7777');
  });
  console.log(`Szukam gier w sieci lokalnej (UDP ${DISCOVERY_PORT})…`);
  let rooms: readonly DiscoveredRoom[] = [];
  discovery.onChange((current) => {
    rooms = current;
    if (current.length === 0) return console.log('\nBrak gier w sieci lokalnej. Czekam na ogłoszenia…');
    console.log('\nGry w sieci lokalnej:');
    current.forEach((room, i) =>
      console.log(`  ${i + 1}. ${room.roomName} u ${room.hostName} (${room.playerCount}/${room.maxPlayers}, ${room.modulesActive.join('+')}, ${room.status}) ${room.address}:${room.serverPort}`),
    );
    console.log('Wpisz numer pokoju, aby dołączyć.');
  });
  // Wybór działa, dopóki gracz nie wskaże istniejącego pokoju.
  const choose = (line: string): void => {
    const room = rooms[Number(line.trim()) - 1];
    if (!room) return console.log('Nie ma takiego pokoju.');
    input.off('line', choose);
    void discovery.stop();
    join(() => connectWebSocket(room.url), room.roomId).catch(quit);
  };
  input.on('line', choose);
}

input.on('line', (line) => {
  const current = client;
  if (!current) return;
  const [command, argument, amount] = line.trim().split(/\s+/);
  const actions: Record<string, () => Promise<unknown>> = {
    ...gameCommands(current, argument, amount),
    kolor: () => current.setColor((argument ?? '').toUpperCase() as PlayerColor),
    miasto: () => current.setCity(argument ?? null),
    gotowy: () => current.setReady(true),
    niegotowy: () => current.setReady(false),
  };
  const action = command ? actions[command] : undefined;
  action?.().catch((error: unknown) => console.log(explain(error)));
});
