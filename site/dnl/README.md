# Dragons & Ladders: online rooms

Play with friends over the internet using a 5-character room code, like Mytheder's private rooms.
The game page is `public/games/dragons-and-ladders/`; this folder is the server side.

## How it fits together

```
browser (index.html) ──WebSocket──►  site/worker.js ──► routes.mjs ──► one Durable Object per room (do.mjs)
                                                                          └─ all rules and decisions: logic.js
                                                                             └─ the rules: public/games/dragons-and-ladders/engine.js
                                                                                (the SAME file the browser loads)
```

- **Server rolls the dice.** Clients only say "roll"; the room rolls, applies the board, and tells everyone what happened. Nobody can fake a roll, which is what a leaderboard will need later.
- **Rooms are private.** The 5-character code is the only way in (same alphabet as Mytheder: no I, L, O, U; typing O, I or L is accepted as 0, 1, 1). Up to 4 seats; the host can add bots.
- **Saved after every move.** A restart or deploy loses nothing. A player who drops takes the seat back automatically with the id + secret the server gave them (kept in that browser only).
- **Timers.** A connected player who does nothing is rolled for after 45 s, a disconnected one after 8 s. Bots roll ~1 s after the previous move finishes. A room nobody touches is deleted after 2 hours (30 min if nobody ever joined).
- **Leaving mid-game** turns the seat into a bot so the others are not stuck. When no human is left the room closes.

## Files

| File | What it is |
|---|---|
| `public/games/dragons-and-ladders/engine.js` | Jump table (dragons and ladders), roll outcome, turn order. Shared by browser and server. Change the board here, once. |
| `logic.js` | Room state machine as plain functions (join, lobby, start, roll, timers, leave, rematch). No Cloudflare code, fully unit-tested. |
| `do.mjs` | The Durable Object: WebSockets in and out, saving, alarms. Thin glue only. |
| `routes.mjs` | `POST /api/dnl/room`, `GET /api/dnl/room/CODE`, `GET /api/dnl/room/CODE/ws` (origin-checked). |
| `dev-server.mjs` | Local stand-in for Cloudflare so the whole thing runs on your PC. |
| `tests/` | Unit tests, protocol tests (real WebSockets) and browser tests. |

Wiring in the site: `site/worker.js` imports `routes.mjs` and re-exports `DnlRoom`; `wrangler.jsonc` binds it as `DNL_ROOMS` and has a `migrations` entry (`new_sqlite_classes`, the only kind the free plan allows).

## Try it on your PC

```powershell
Set-Location -LiteralPath 'D:\Cowork\kuro-labs'
node .\site\dnl\dev-server.mjs
```

Open http://localhost:8787/games/dragons-and-ladders/ in two browser windows: choose "Online, with a code" in one, create a room, and join with the code in the other. (`--fast` makes the server's timers short; `--port 9000` changes the port.) Cloudflare is not involved, so everything is in memory and disappears when you stop it.

## Tests

```powershell
node .\site\dnl\tests\engine.test.js
node .\site\dnl\tests\logic.test.js
node .\site\dnl\tests\worker-wiring.test.mjs
node .\site\dnl\tests\protocol.test.mjs     # starts the dev server by itself
python .\site\dnl\tests\e2e.py              # needs Python with playwright; two real browsers play a game
```

## After a deploy: check once on the real thing

The tests run against a close imitation of Cloudflare, not Cloudflare itself. After pushing, do this once with two devices (phone on mobile data plus your PC is ideal):

1. Create a room on one, join from the other with the code and with the invite link.
2. Add a bot, start, play a few turns, including one with a ladder or dragon.
3. Turn the phone's wifi off for 10 seconds and back on: it should reconnect to the same seat.
4. Finish a game and use "Play again".

If something is off, the Cloudflare dashboard (Workers & Pages, kuro-labs, Logs) shows errors from the Worker and the Durable Object.

## Limits to know about (Cloudflare free plan, checked 2026-09-26)

Durable Objects: 100,000 requests per day and 13,000 GB-s of duration per day; incoming WebSocket messages count at 20 to 1, and outgoing messages are free. Storage: rows written 100,000 per day (a room is saved after each move, so a 30-turn game is about 40 writes). Comfortable for a hobby site: hundreds of games per day.

Not built (on purpose, for now): chat, spectators, public room lists, room creation rate limits, name filtering. Player names are typed by guests and shown only to the others in that room. Accounts (see `KUROLABS_ACCOUNTS_DESIGN`) and a shared name filter come later.
