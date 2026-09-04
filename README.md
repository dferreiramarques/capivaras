# Capivaras 🐹

**Capivaras** is a real-time multiplayer bluffing/betting card game set in the Pantanal, played entirely in the browser (Portuguese only). Each round, players secretly bet on which capybara card they want — grab a card nobody else picked and it's yours; two players collide on the same card and it scatters away from both.

Play it live, no installs: it's a single Node.js server with a fully self-contained web client (no build step, no framework).

## Gameplay at a glance

- **Betting game**, not a turn-based game: every round, as many cards as there are players are dealt face-up. Everyone secretly commits to one card; bets are revealed simultaneously.
- Pick a card **alone** → you win it. Pick a card **with someone else** → nobody wins it.
- Two collectible mechanics layer on top of the base capybara count: a **bird token** (steal-able, worth bonus points) and **four lily colors** (collect all four for a bonus).
- Full rules, aimed at players (in Portuguese): [REGRAS.md](REGRAS.md).

## Features

- **Lobby system** — 5 public multiplayer tables (2–6 players each) plus a **solo mode** against 2 bots, playable instantly with no waiting.
- **Real-time sync** over WebSockets — betting, reveals, and scoring are pushed live to every seat.
- **Reconnect support** — dropped players get a grace period to rejoin the same seat via a session token; if they don't return in time, an auto-bet keeps the table from stalling.
- **PWA-ready** — web app manifest, iOS splash screens (generated on the fly as raw PNGs, no image assets needed), and "add to home screen" support.
- **In-app rules panel and rules video** — players never have to leave the game to remember how scoring works.
- Small ambient audio layer and a couple of procedurally-generated sound effects (Web Audio API, no audio files needed beyond the ambient loop).

## Tech stack

- **Backend:** plain Node.js (`http` + [`ws`](https://www.npmjs.com/package/ws)) — no framework, no database. All game state lives in memory.
- **Frontend:** a single HTML/CSS/JS string served by the Node process (`CLIENT_HTML` in [server.js](server.js)) — no bundler, no build step.
- **Assets:** card art and audio live under [public/](public); everything else (manifest, PWA splash PNGs, service worker) is generated in code.

## Project structure

```
server.js          Everything: HTTP + WebSocket server, game logic, bot AI,
                    and the entire client (HTML/CSS/JS) as an embedded string.
public/
  cards/            Capybara card artwork (PNG).
  ambient.mp3       Background ambient loop.
  bird.png          App icon / bird token art.
```

## Running locally

Requires Node.js 18+.

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` by default (override with the `PORT` environment variable).

## Rules & scoring

See [REGRAS.md](REGRAS.md) for the full player-facing rules guide, in Portuguese, matching the in-app rules panel.

## License

CC BY-NC-ND 4.0 — see the [license terms](https://creativecommons.org/licenses/by-nc-nd/4.0/). This is a creative work (game design, art, name), not open-source software: no commercial use, no derivatives, attribution required.

A game by David Marques.
