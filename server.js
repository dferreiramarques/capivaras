'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const zlib = require('zlib');

// ─── SPLASH PNG GENERATOR ────────────────────────────────────────────────────
// Generates a gradient PNG (creme→mint, same as game bg) purely in Node.
// Used for iOS PWA splash screens — no extra files needed.
function makeSplashPNG(w, h) {
  // Gradient: top #f8f2e2 (creme) → bottom #b8e8e0 (mint)
  const topR=0xf8,topG=0xf2,topB=0xe2;
  const botR=0xb8,botG=0xe8,botB=0xe0;

  // Build raw scanlines: filter_byte(0) + RGB pixels
  const scanlines = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const r = Math.round(topR + (botR - topR) * t);
    const g = Math.round(topG + (botG - topG) * t);
    const b = Math.round(topB + (botB - topB) * t);
    const row = y * (1 + w * 3);
    scanlines[row] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      scanlines[row + 1 + x * 3]     = r;
      scanlines[row + 1 + x * 3 + 1] = g;
      scanlines[row + 1 + x * 3 + 2] = b;
    }
  }

  const idat = zlib.deflateSync(scanlines, { level: 6 });

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const body = Buffer.concat([t, d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, c]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0; // 8-bit RGB

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Pre-generate splash images for common iOS screen sizes (cached in memory)
const SPLASH_SIZES = [
  [1290, 2796], // iPhone 14 Pro Max / 15 Pro Max
  [1179, 2556], // iPhone 14 Pro / 15 Pro
  [1170, 2532], // iPhone 12/13/14
  [1125, 2436], // iPhone X/XS/11 Pro
  [828,  1792], // iPhone XR/11
  [750,  1334], // iPhone 8/SE2
  [2048, 2732], // iPad Pro 12.9"
  [1668, 2388], // iPad Pro 11"
];
const splashCache = {};
function getSplash(w, h) {
  const key = w + 'x' + h;
  if (!splashCache[key]) splashCache[key] = makeSplashPNG(w, h);
  return splashCache[key];
}

const PORT        = process.env.PORT || 3000;
const GRACE_MS    = 45_000;
const REVEAL_MS   = 5_000;
const BOT_MIN_MS  = 900;
const BOT_MAX_MS  = 2_600;
const AUTODEAL_MS = 10_000;

// ─── STATIC FILE SERVER ──────────────────────────────────────────────────────
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.js': 'application/javascript',
};

function serveStatic(req, res) {
  const safe = path.normalize(req.url).replace(/^(\.\.[\/\\])+/, '');
  const file = path.join(__dirname, 'public', safe.replace(/^\//, ''));
  const ext  = path.extname(file).toLowerCase();
  const mime = MIME[ext];
  if (!mime) { res.writeHead(404); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public,max-age=86400' });
    res.end(data);
  });
}

// ─── DECK ────────────────────────────────────────────────────────────────────
// img: filename without extension, served from /public/cards/ as .webp
//      (600px, screen size; high-res PNG originals in art/cards-original/)
// imgFallback: shown if img.png is missing (use plain card of same cap count)
// Available PNGs (confirmed by artist):
//   cap1, cap1_BW, cap1_R, cap1_W_bird
//   cap2, cap2_B, cap2_bird, cap2_R_bird, cap2_W, cap2_Y, cap2_Y_bird
//   cap3, cap3_B, cap3_bird, cap3_Y
//   cap4, cap4_bird
//   cap5
// Missing: cap5_bird → falls back to cap5 image
function mkCard(cap, lilies, bird, imgOverride) {
  const l = [...lilies].sort().join('');
  const img = imgOverride || ('cap' + cap + (l ? '_' + l : '') + (bird ? '_bird' : ''));
  const fallback = 'cap' + cap; // plain version always exists
  return { cap, lilies, bird, img, fallback };
}

const BASE_DECK = [
  // 1 cap (6)
  mkCard(1,[],false),  mkCard(1,[],false),
  mkCard(1,['R'],false), mkCard(1,['R'],false),
  mkCard(1,['B','W'],false),                      // img: cap1_BW
  mkCard(1,['W'],true),                            // img: cap1_W_bird
  // 2 cap (13)
  mkCard(2,[],false), mkCard(2,[],false), mkCard(2,[],false),
  mkCard(2,[],false), mkCard(2,[],false), mkCard(2,[],false),
  mkCard(2,['Y'],false), mkCard(2,['Y'],false),
  mkCard(2,['B'],false),                           // img: cap2_B  (artist changed W→B)
  mkCard(2,['Y'],true),                            // img: cap2_Y_bird
  mkCard(2,['R'],true),                            // img: cap2_R_bird
  mkCard(2,[],true), mkCard(2,[],true),            // img: cap2_bird
  // 3 cap (11)
  mkCard(3,[],false), mkCard(3,[],false), mkCard(3,[],false),
  mkCard(3,[],false), mkCard(3,[],false), mkCard(3,[],false),
  mkCard(3,['Y'],false),                           // img: cap3_Y
  mkCard(3,['B'],false), mkCard(3,['B'],false),    // img: cap3_B
  mkCard(3,[],true), mkCard(3,[],true),            // img: cap3_bird
  // 4 cap (4)
  mkCard(4,[],false), mkCard(4,[],false),
  mkCard(4,[],true), mkCard(4,[],true),            // img: cap4_bird
  // 5 cap (2)
  mkCard(5,[],false),
  mkCard(5,[],true),                               // img: cap5_bird
]; // 36 total

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

// ─── SERVER STATE ────────────────────────────────────────────────────────────
const lobbies = {};
const wsState = new WeakMap();
const sessions = {};

function makeLobby(id, name, solo, maxHuman) {
  const n = solo ? 1 : maxHuman;
  return { id, name, solo, maxHuman,
    players: new Array(n).fill(null), names: new Array(n).fill(''),
    tokens:  new Array(n).fill(null), graceTimers: new Array(n).fill(null),
    autoTimers: new Array(n).fill(null), seatMap: null, game: null, ephemeral: false };
}

function initLobbies() {
  for (let i = 1; i <= 5; i++) lobbies['mp'+i] = makeLobby('mp'+i, 'Mesa '+i, false, 6);
  lobbies['solo'] = makeLobby('solo', 'Mesa Solo (vs 2 IAs)', true, 1);
}
initLobbies();

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function newGame(names, isSolo) {
  const n = names.length;
  const deck = shuffle(BASE_DECK);
  return {
    players: names.map(name => ({ name, scored: [], birdCards: 0 })),
    n, deck, discard: [], table: deck.splice(0, n),
    bets: new Array(n).fill(null), birdHolder: null, birdTie: 0,
    phase: 'BETTING', deckPass: 0, lastResult: null,
    isSolo, turnGen: 0, winnerIdx: null, finalScores: null,
  };
}

function computeScores(g) {
  return g.players.map((p, i) => {
    let pts = 0;
    const lilies = new Set();
    for (const c of p.scored) { pts += c.cap; c.lilies.forEach(l => lilies.add(l)); }
    if (i === g.birdHolder) pts += 5;
    const allLilies = ['Y','R','W','B'].every(c => lilies.has(c));
    if (allLilies) pts += 10;
    return { name: p.name, pts, scored: p.scored, lilies: [...lilies],
             birdCards: p.birdCards, hasBird: i === g.birdHolder, allLilies };
  });
}

function buildView(g, seat) {
  const sc = computeScores(g);
  return {
    phase: g.phase, n: g.n, table: g.table,
    myBet: g.bets[seat], betsPlaced: g.bets.map(b => b !== null),
    lastResult: g.lastResult ? {
      winners:    g.lastResult.winners,
      birdUpdate: g.lastResult.birdUpdate,
      cards:      g.lastResult.cards,
    } : null,
    players: sc.map((s, i) => ({ ...s, isMe: i === seat, seat: i })),
    birdHolder: g.birdHolder,
    birdHolderCards: g.birdHolder !== null ? g.players[g.birdHolder].birdCards : 0,
    deckPass: g.deckPass, deckLeft: g.deck.length,
    winnerIdx: g.winnerIdx, finalScores: g.finalScores,
    mySeat: seat, isSolo: g.isSolo,
    myBirdCards: g.players[seat].birdCards, turnGen: g.turnGen,
  };
}

function sendTo(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function broadcastGame(lobby) {
  const g = lobby.game; if (!g) return;
  if (lobby.solo) {
    sendTo(lobby.players[0], { type: 'GAME_STATE', state: buildView(g, 0) });
  } else if (lobby.seatMap) {
    lobby.seatMap.forEach((ls, gs) => {
      if (lobby.players[ls]) sendTo(lobby.players[ls], { type: 'GAME_STATE', state: buildView(g, gs) });
    });
  }
}

function lobbyInfo(l) {
  const seated = l.players.filter(Boolean).length;
  const playing = !!l.game && l.game.phase !== 'GAME_OVER';
  return { id: l.id, name: l.name, solo: l.solo, seated,
           maxHuman: l.maxHuman, playing, full: seated >= l.maxHuman,
           names: l.names.filter(Boolean) };
}

// Ephemeral (per-player solo) instances are private clones of the 'solo'
// template — they never show up in the public lobby list.
function publicLobbies() {
  return Object.values(lobbies).filter(l => !l.ephemeral).map(lobbyInfo);
}

let wss;
function broadcastLobbyList() {
  const list = publicLobbies();
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    const st = wsState.get(ws);
    if (!st || !st.lobbyId) sendTo(ws, { type: 'LOBBIES', lobbies: list });
  }
}

// ─── ROUND ────────────────────────────────────────────────────────────────────
function checkAllBetsIn(lobby) {
  const g = lobby.game;
  if (!g || g.phase !== 'BETTING') return;
  if (g.bets.every(b => b !== null)) resolveRound(lobby);
}

// Pure round resolution (no timers/sockets) — also injected into the client
// and reused by the tutorial, so both always follow the same rules.
function resolveBets(g) {
  const betCount  = new Array(g.n).fill(0);
  const betBySeat = new Array(g.n).fill(-1);
  g.bets.forEach((bet, seat) => { if (bet !== null) { betCount[bet]++; betBySeat[bet] = seat; } });

  const result = { bets: [...g.bets], winners: {},
    cards: g.table.map(c => ({ ...c, lilies: [...c.lilies] })), birdUpdate: null };

  // First pass: resolve card wins and accumulate bird cards
  g.table.forEach((card, pos) => {
    if (betCount[pos] === 1) {
      const seat = betBySeat[pos];
      g.players[seat].scored.push({ ...card, lilies: [...card.lilies] });
      result.winners[pos] = seat;
      if (card.bird) {
        g.players[seat].birdCards++;
      }
    }
  });

  // Second pass: bird token. It goes to whoever has MORE bird cards than the
  // bar — the holder's count (holder +1 to take it), or, while the token is
  // on the table, the level of the last tie (0 at the start). If several
  // players share the top count, it's a tie and the token doesn't move; a
  // tie with the token on the table raises the bar to that count (so it
  // goes to the first player to get one bird card more than the tie).
  const birdGained = Object.keys(result.winners).some(pos => g.table[pos].bird);
  const prev = g.birdHolder;
  const bar = prev !== null ? g.players[prev].birdCards : g.birdTie;
  const over = birdGained ? g.players.map((p, i) => i).filter(i => i !== prev && g.players[i].birdCards > bar) : [];
  if (over.length) {
    const top = Math.max(...over.map(i => g.players[i].birdCards));
    const leaders = over.filter(i => g.players[i].birdCards === top);
    const names = leaders.map(s => g.players[s].name);
    if (leaders.length === 1) {
      const seat = leaders[0];
      g.birdHolder = seat;
      result.birdUpdate = prev === null
        ? { type: 'first', seat, name: names[0] }
        : { type: 'steal', seat, from: prev, name: names[0], fromName: g.players[prev].name };
    } else if (prev === null) {
      g.birdTie = top;
      result.birdUpdate = { type: 'tie_first', seats: leaders, names };
    } else {
      result.birdUpdate = { type: 'tie_steal', seats: leaders, names };
    }
  }

  // Only cards nobody won (tied or unbet) go to the discard — won cards stay
  // with their owners and never come back in the second pass.
  g.table.forEach((c, pos) => {
    if (result.winners[pos] === undefined) g.discard.push({ ...c, lilies: [...c.lilies] });
  });
  g.lastResult = result; g.phase = 'REVEAL'; g.turnGen++;
}

function resolveRound(lobby) {
  const g = lobby.game;
  resolveBets(g);
  lobby.autoTimers.forEach((t, i) => { if (t) { clearTimeout(t); lobby.autoTimers[i] = null; } });
  broadcastGame(lobby);

  const gen = g.turnGen;
  setTimeout(() => {
    if (!lobby.game || lobby.game.turnGen !== gen || lobby.game.phase !== 'REVEAL') return;
    nextRound(lobby);
  }, REVEAL_MS);
}

function nextRound(lobby) {
  const g = lobby.game;
  if (g.deck.length < g.n) {
    if (g.deckPass === 0) { g.deck.push(...shuffle(g.discard)); g.discard = []; g.deckPass = 1; }
    else { endGame(lobby); return; }
  }
  if (g.deck.length < g.n) { endGame(lobby); return; }
  g.table = g.deck.splice(0, g.n); g.bets = new Array(g.n).fill(null);
  g.lastResult = null; g.phase = 'BETTING'; g.turnGen++;
  broadcastGame(lobby);
  if (g.isSolo) scheduleBots(lobby); else scheduleAutoBeats(lobby);
}

function endGame(lobby) {
  const g = lobby.game;
  g.phase = 'GAME_OVER'; g.finalScores = computeScores(g);
  const maxPts = Math.max(...g.finalScores.map(s => s.pts));
  g.winnerIdx = g.finalScores.findIndex(s => s.pts === maxPts);
  broadcastGame(lobby); broadcastLobbyList();
}

// ─── BOT AI ──────────────────────────────────────────────────────────────────
function scheduleBots(lobby) {
  const g = lobby.game;
  if (!g || !g.isSolo || g.phase !== 'BETTING') return;
  const gen = g.turnGen;
  [1, 2].forEach(bot => {
    if (g.bets[bot] !== null) return;
    const delay = BOT_MIN_MS + Math.random() * (BOT_MAX_MS - BOT_MIN_MS);
    setTimeout(() => {
      if (!lobby.game || lobby.game.turnGen !== gen || lobby.game.phase !== 'BETTING') return;
      if (g.bets[bot] !== null) return;
      g.bets[bot] = botChoose(g, bot);
      broadcastGame(lobby); checkAllBetsIn(lobby);
    }, bot === 1 ? delay : delay + 300 + Math.random() * 400);
  });
}

function botChoose(g, seat) {
  const player = g.players[seat];
  const myLilies = new Set(); player.scored.forEach(c => c.lilies.forEach(l => myLilies.add(l)));
  const otherBot = seat === 1 ? g.bets[2] : g.bets[1];
  const scored = g.table.map((card, pos) => {
    let s = card.cap * 10 + card.lilies.filter(l => !myLilies.has(l)).length * 8;
    if (card.bird) s += g.birdHolder === null ? 20 : (g.birdHolder !== seat && player.birdCards >= g.players[g.birdHolder].birdCards ? 15 : 4);
    if (otherBot === pos) s -= 30;
    s += (Math.random() - 0.5) * 12;
    return { pos, s };
  }).sort((a, b) => b.s - a.s);
  return Math.random() < 0.75 ? scored[0].pos : scored[Math.min(1, scored.length-1)].pos;
}

function scheduleAutoBeats(lobby) {
  const g = lobby.game;
  if (!g || g.isSolo || !lobby.seatMap) return;
  const gen = g.turnGen;
  lobby.seatMap.forEach((ls, gs) => {
    if (lobby.players[ls] || g.bets[gs] !== null) return;
    const t = setTimeout(() => {
      if (!lobby.game || lobby.game.turnGen !== gen || lobby.game.phase !== 'BETTING') return;
      if (g.bets[gs] !== null) return;
      g.bets[gs] = Math.floor(Math.random() * g.n);
      broadcastGame(lobby); checkAllBetsIn(lobby);
    }, AUTODEAL_MS);
    lobby.autoTimers[ls] = t;
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function findGameSeat(lobby, ls) { return !lobby.seatMap ? ls : lobby.seatMap.indexOf(ls); }

function hardLeaveBySlot(lobby, ls) {
  const token = lobby.tokens[ls]; if (token) delete sessions[token];
  lobby.players[ls] = null; lobby.names[ls] = ''; lobby.tokens[ls] = null;
  clearTimeout(lobby.graceTimers[ls]); clearTimeout(lobby.autoTimers[ls]);
  lobby.graceTimers[ls] = null; lobby.autoTimers[ls] = null;
  lobby.players.forEach(p => { if (p) sendTo(p, { type: 'PLAYER_LEFT', seat: ls, lobby: lobbyInfo(lobby) }); });
  if (lobby.solo && ls === 0) { lobby.game = null; lobby.seatMap = null; }
  if (!lobby.solo && lobby.game && lobby.game.phase !== 'GAME_OVER') {
    const rem = lobby.seatMap ? lobby.seatMap.filter(li => lobby.players[li]).length : 0;
    if (rem < 2) endGame(lobby);
  }
  // Private solo instance: nobody else can ever use it again, so free it now.
  if (lobby.ephemeral) delete lobbies[lobby.id];
  broadcastLobbyList();
}

// ─── ACTION HANDLER ──────────────────────────────────────────────────────────
function handleAction(ws, msg) {
  if (msg.type === 'PING')      { sendTo(ws, { type: 'PONG' }); return; }
  if (msg.type === 'LOBBIES')   { sendTo(ws, { type: 'LOBBIES', lobbies: publicLobbies() }); return; }
  if (msg.type === 'RECONNECT') { handleReconnect(ws, msg); return; }
  if (msg.type === 'JOIN_LOBBY') { handleJoin(ws, msg); return; }

  const st = wsState.get(ws); if (!st || !st.lobbyId) return;
  const lobby = lobbies[st.lobbyId]; if (!lobby) return;
  const ls = st.seat, g = lobby.game;

  if (msg.type === 'LEAVE_LOBBY') {
    hardLeaveBySlot(lobby, ls); wsState.delete(ws);
    sendTo(ws, { type: 'LOBBIES', lobbies: publicLobbies() }); return;
  }
  if (msg.type === 'REQUEST_STATE') {
    if (g) sendTo(ws, { type: 'GAME_STATE', state: buildView(g, findGameSeat(lobby, ls)) });
    else    sendTo(ws, { type: 'LOBBY_STATE', lobby: lobbyInfo(lobby), names: lobby.names, myLobbySeat: ls });
    return;
  }
  if (msg.type === 'START') {
    if (lobby.solo || ls !== 0 || (g && g.phase !== 'GAME_OVER')) return;
    const active = lobby.players.map((p, i) => p ? i : -1).filter(i => i >= 0);
    if (active.length < 2) { sendTo(ws, { type: 'ERROR', text: 'Precisas de pelo menos 2 jogadores.' }); return; }
    lobby.seatMap = active;
    lobby.game    = newGame(active.map(i => lobby.names[i]), false);
    active.forEach((li, gi) => { const w = lobby.players[li]; if (w) { const s = wsState.get(w); if (s) s.gameSeat = gi; } });
    broadcastGame(lobby); broadcastLobbyList(); scheduleAutoBeats(lobby); return;
  }
  if (msg.type === 'BET') {
    if (!g || g.phase !== 'BETTING') { if (g) sendTo(ws, { type: 'GAME_STATE', state: buildView(g, findGameSeat(lobby, ls)) }); return; }
    const gs = findGameSeat(lobby, ls); if (gs === -1) return;
    const pos = parseInt(msg.position);
    if (isNaN(pos) || pos < 0 || pos >= g.n || g.bets[gs] !== null) return;
    g.bets[gs] = pos; broadcastGame(lobby); checkAllBetsIn(lobby); return;
  }
  if (msg.type === 'RESTART') {
    if (!g || g.phase !== 'GAME_OVER') return;
    if (lobby.solo) {
      lobby.game = newGame([lobby.names[0]||'Jogador','Bot-capi 1','Bot-capi 2'], true);
      lobby.seatMap = null; const s = wsState.get(ws); if (s) s.gameSeat = 0;
      broadcastGame(lobby); scheduleBots(lobby);
    } else {
      if (ls !== 0) return;
      const active = lobby.players.map((p, i) => p ? i : -1).filter(i => i >= 0);
      if (active.length < 2) { sendTo(ws, { type: 'ERROR', text: 'Precisas de pelo menos 2 jogadores.' }); return; }
      lobby.seatMap = active;
      lobby.game    = newGame(active.map(i => lobby.names[i]), false);
      active.forEach((li, gi) => { const w = lobby.players[li]; if (w) { const s = wsState.get(w); if (s) s.gameSeat = gi; } });
      broadcastGame(lobby); scheduleAutoBeats(lobby);
    }
  }
}

function handleJoin(ws, msg) {
  let lobby = lobbies[msg.lobbyId];
  if (!lobby) { sendTo(ws, { type: 'ERROR', text: 'Mesa não encontrada.' }); return; }

  // Solo is a template, not a shared table: each player who "enters" it gets
  // their own private, ephemeral instance, cloned from the template. It never
  // shows up in the lobby list and is torn down as soon as the player leaves
  // (or fails to reconnect), so it can never block others and never gets stuck.
  if (lobby.solo && !lobby.ephemeral) {
    const instId = `solo#${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const instance = makeLobby(instId, lobby.name, true, lobby.maxHuman);
    instance.ephemeral = true;
    lobbies[instId] = instance;
    lobby = instance;
  }

  if (!lobby.solo && lobby.game && lobby.game.phase !== 'GAME_OVER') {
    sendTo(ws, { type: 'ERROR', text: 'Jogo em curso.' }); return; }
  const seat = lobby.players.findIndex(p => p === null);
  if (seat === -1) { sendTo(ws, { type: 'ERROR', text: 'Mesa cheia.' }); return; }
  const name  = (msg.playerName||'').trim().slice(0,20)||'Jogador';
  const token = Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
  lobby.players[seat]=ws; lobby.names[seat]=name; lobby.tokens[seat]=token;
  wsState.set(ws, { lobbyId: lobby.id, seat, gameSeat: seat, token });
  sessions[token] = { lobbyId: lobby.id, seat, name };
  sendTo(ws, { type:'JOINED', seat, token, lobbyId: lobby.id, solo:lobby.solo, name, lobby:lobbyInfo(lobby), names:lobby.names });
  lobby.players.forEach((p,i) => { if(p&&i!==seat) sendTo(p,{type:'PLAYER_JOINED',seat,name,lobby:lobbyInfo(lobby)}); });
  broadcastLobbyList();
  if (lobby.solo) {
    lobby.seatMap=null; const s=wsState.get(ws); if(s) s.gameSeat=0;
    lobby.game=newGame([name,'Bot-capi 1','Bot-capi 2'],true);
    broadcastGame(lobby); scheduleBots(lobby);
  }
}

function handleReconnect(ws, msg) {
  const sess=sessions[msg.token];
  if (!sess) { sendTo(ws,{type:'RECONNECT_FAIL'}); return; }
  const lobby=lobbies[sess.lobbyId];
  if (!lobby) { sendTo(ws,{type:'RECONNECT_FAIL'}); return; }
  const {seat,name}=sess;
  // Reject if seat already has a live connection (e.g. duplicate tab)
  const existing=lobby.players[seat];
  if (existing && existing!==ws && existing.readyState===1) {
    sendTo(ws,{type:'RECONNECT_FAIL'}); return;
  }
  clearTimeout(lobby.graceTimers[seat]); lobby.graceTimers[seat]=null;
  lobby.players[seat]=ws; lobby.names[seat]=name;
  const gs=lobby.seatMap?lobby.seatMap.indexOf(seat):seat;
  wsState.set(ws,{lobbyId:sess.lobbyId,seat,gameSeat:gs,token:msg.token});
  sendTo(ws,{type:'RECONNECTED',seat,gameSeat:gs,name,solo:lobby.solo});
  broadcastLobbyList();
  if (lobby.game) {
    broadcastGame(lobby);
    if (!lobby.game.isSolo&&lobby.game.phase==='BETTING'){clearTimeout(lobby.autoTimers[seat]);lobby.autoTimers[seat]=null;}
    if (lobby.game.isSolo&&lobby.game.phase==='BETTING') scheduleBots(lobby);
  } else {
    sendTo(ws,{type:'LOBBY_STATE',lobby:lobbyInfo(lobby),names:lobby.names,myLobbySeat:seat});
  }
  lobby.players.forEach((p,i)=>{if(p&&i!==seat)sendTo(p,{type:'OPPONENT_RECONNECTED',seat,name});});
}

// ─── HTTP + WS SERVER ────────────────────────────────────────────────────────
const MANIFEST = `{
  "name": "Capivaras",
  "short_name": "Capivaras",
  "description": "Um jogo de apostas secretas no Pantanal",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#f8f2e2",
  "theme_color": "#c47c28",
  "orientation": "any",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/bird.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/bird.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}`;
const SW = "self.addEventListener('fetch', e => {\n  // network-first: serve fresh if online, nothing cached\n});";

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CLIENT_HTML);
  } else if (url.startsWith('/splash/')) {
    // /splash/WxH.png  e.g. /splash/1170x2532.png
    const m = url.match(/\/splash\/(\d+)x(\d+)\.png/);
    if (m) {
      const png = getSplash(parseInt(m[1]), parseInt(m[2]));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public,max-age=86400' });
      res.end(png);
    } else { res.writeHead(404); res.end(); }
  } else if (url === '/manifest.webmanifest' || url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(MANIFEST);
  } else if (url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
    res.end(SW);
  } else {
    serveStatic(req, res);
  }
});

wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.on('message', raw => { try { handleAction(ws, JSON.parse(raw)); } catch {} });
  ws.on('close', () => {
    const st = wsState.get(ws); if (!st||!st.lobbyId) return;
    const lobby=lobbies[st.lobbyId]; if(!lobby) return;
    const {seat}=st;
    lobby.players[seat]=null;
    lobby.players.forEach(p=>{if(p)sendTo(p,{type:'OPPONENT_DISCONNECTED_GRACE',seat,name:lobby.names[seat],graceMs:GRACE_MS});});
    broadcastLobbyList();
    const g=lobby.game;
    if (g&&g.phase==='BETTING') {
      const gs=findGameSeat(lobby,seat);
      if (gs!==-1&&g.bets[gs]===null) {
        const gen=g.turnGen;
        lobby.autoTimers[seat]=setTimeout(()=>{
          if(!lobby.game||lobby.game.turnGen!==gen||lobby.game.phase!=='BETTING') return;
          if(g.bets[gs]!==null) return;
          g.bets[gs]=Math.floor(Math.random()*g.n);
          broadcastGame(lobby); checkAllBetsIn(lobby);
        }, AUTODEAL_MS);
      }
    }
    lobby.graceTimers[seat]=setTimeout(()=>hardLeaveBySlot(lobby,seat),GRACE_MS);
  });
  ws.on('error',()=>{});
});

setInterval(()=>{ for(const ws of wss.clients) if(ws.readyState===1) ws.ping(); },20_000);
server.listen(PORT, ()=>console.log('Capivaras on port '+PORT));




const CLIENT_HTML = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<title>Capivaras</title>
<meta name="application-name" content="Capivaras">
<meta name="description" content="Um jogo de apostas secretas no Pantanal">
<meta name="theme-color" content="#c47c28">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Capivaras">
<link rel="apple-touch-icon" href="/bird.png">
<link rel="apple-touch-startup-image" media="screen and (device-width:430px) and (device-height:932px) and (-webkit-device-pixel-ratio:3)" href="/splash/1290x2796.png">
<link rel="apple-touch-startup-image" media="screen and (device-width:393px) and (device-height:852px) and (-webkit-device-pixel-ratio:3)" href="/splash/1179x2556.png">
<link rel="apple-touch-startup-image" media="screen and (device-width:390px) and (device-height:844px) and (-webkit-device-pixel-ratio:3)" href="/splash/1170x2532.png">
<link rel="apple-touch-startup-image" media="screen and (device-width:375px) and (device-height:812px) and (-webkit-device-pixel-ratio:3)" href="/splash/1125x2436.png">
<link rel="apple-touch-startup-image" media="screen and (device-width:414px) and (device-height:896px) and (-webkit-device-pixel-ratio:2)" href="/splash/828x1792.png">
<link rel="apple-touch-startup-image" media="screen and (device-width:375px) and (device-height:667px) and (-webkit-device-pixel-ratio:2)" href="/splash/750x1334.png">
<link rel="apple-touch-startup-image" media="screen and (device-width:1024px) and (device-height:1366px) and (-webkit-device-pixel-ratio:2)" href="/splash/2048x2732.png">
<link rel="apple-touch-startup-image" media="screen and (device-width:834px) and (device-height:1194px) and (-webkit-device-pixel-ratio:2)" href="/splash/1668x2388.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* ─────────────────────────────────────────────────────────────────────────
   PALETTE — extracted from card watercolor art
   Background: gradient creme (#faf5e8) → mint (#c8ede6)
   Capivara fur: warm amber (#c47c28)
   Water: soft teal (#7dd4cc)
   Text: deep warm brown (#2e1a0a)
   Accents: amber, soft coral, muted teal
───────────────────────────────────────────────────────────────────────── */
:root {
  /* backgrounds */
  --bg-top:    #f8f2e2;
  --bg-bottom: #b8e8e0;
  --panel:     rgba(255,252,244,0.92);
  --panel-b:   rgba(255,250,238,0.97);
  --card-bg:   #ffffff;
  --card-sel:  #fff8e8;

  /* brand colours */
  --amber:     #c47c28;   /* capivara fur — primary action */
  --amber2:    #a66018;   /* hover */
  --teal:      #5bbfb6;   /* water */
  --teal2:     #3a9e96;   /* darker teal */
  --sage:      #6aaa6a;   /* green confirmations */

  /* text */
  --ink:       #2e1a0a;   /* deep brown */
  --ink2:      #6b4420;   /* medium brown */
  --muted:     #9a7050;   /* light brown */

  /* borders */
  --border:    #d4b896;   /* warm tan */
  --border2:   #e8d8c0;   /* lighter */

  /* lily colours — matching card art */
  --lily-Y: #e8a820;
  --lily-R: #d85030;
  --lily-W: #8898a8;
  --lily-B: #4898c8;

  /* gold for bird */
  --gold: #e8b020;

  /* bitnikgames design system — forma e tipografia (mesma escala do
     site e do Bulbous; só a paleta acima muda por jogo) */
  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 24px;
  --radius-pill: 999px;

  --shadow-color-rgb: 46, 26, 10; /* rgb de --ink */
  --shadow-card: 0 6px 20px -8px rgba(var(--shadow-color-rgb), 0.25);
  --shadow-card-hover: 0 12px 28px -10px rgba(var(--shadow-color-rgb), 0.32);

  --font-display: "Baloo 2", "Fredoka", system-ui, sans-serif;
  --font-body: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  min-height: 100vh; min-height: 100dvh;
  background: linear-gradient(160deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
  background-attachment: fixed;
  color: var(--ink);
  font-family: var(--font-body);
}

/* ── SCREENS ── */
.screen { display: none; min-height: 100vh; min-height: 100dvh; }
.screen.active { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
#screen-game { justify-content: flex-start; padding: 12px; }

/* ── LOGO ── */
.game-logo {
  font-family: var(--font-display);
  font-size: 4rem; font-weight: 400;
  color: var(--amber); letter-spacing: .01em; line-height: 1;
}
.game-logo span { color: var(--amber); }
.game-tagline { font-size: .9rem; color: var(--muted); margin-bottom: 32px; font-style: italic; font-family: var(--font-display); }
.h-rule { width: 36px; height: 2px; background: var(--amber); opacity: .5; margin: 0 auto 28px; border-radius: 2px; }

/* ── CARD BOX (panels) ── */
.card-box {
  background: var(--panel-b);
  border: 1px solid var(--border2);
  border-radius: var(--radius-lg); padding: 32px;
  max-width: 500px; width: 100%;
  box-shadow: var(--shadow-card-hover);
}
.card-box h2 {
  font-family: var(--font-display);
  font-size: 1.3rem; font-weight: 700;
  color: var(--ink); margin-bottom: 18px;
}

/* ── INPUTS & BUTTONS ── */
input[type=text] {
  width: 100%; padding: 12px 16px;
  border-radius: var(--radius-sm); border: 1.5px solid var(--border);
  background: #fffef9; color: var(--ink);
  font-size: 1rem; font-family: var(--font-body);
  outline: none; margin-bottom: 16px;
  transition: border-color .15s;
}
input[type=text]:focus { border-color: var(--amber); }
input[type=text]::placeholder { color: var(--muted); opacity: .7; }

.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; padding: 12px 24px; border-radius: var(--radius-pill); border: none;
  cursor: pointer; font-size: .95rem; font-weight: 700;
  font-family: var(--font-body); transition: all .15s; letter-spacing: .01em;
}
.btn-primary { background: var(--amber); color: #fff; width: 100%; box-shadow: 0 2px 8px rgba(196,124,40,.3); }
@media (hover: hover) { .btn-primary:hover { background: var(--amber2); } }
.btn-primary:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }
.btn-outline { background: rgba(255,255,255,.6); border: 1.5px solid var(--border); color: var(--ink2); }
@media (hover: hover) { .btn-outline:hover { border-color: var(--amber); color: var(--ink); background: rgba(255,255,255,.9); } }
.btn-sm { padding: 8px 16px; font-size: .83rem; }

/* ── LOBBY ── */
.lobby-grid { display: grid; gap: 10px; margin-top: 8px; width: 100%; }
.lobby-row {
  background: rgba(255,252,244,.8); border: 1.5px solid var(--border2);
  border-radius: var(--radius-sm); padding: 14px 18px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  transition: border-color .18s, box-shadow .18s;
}
@media (hover: hover) {
  .lobby-row:not(.full):hover {
    border-color: var(--amber);
    box-shadow: 0 2px 12px rgba(196,124,40,.12);
  }
}
.lobby-name { font-family: var(--font-display); font-weight: 700; font-size: 1rem; color: var(--ink); }
.lobby-meta { font-size: .76rem; color: var(--muted); margin-top: 2px; }
.badge { display: inline-block; padding: 2px 9px; border-radius: var(--radius-pill); font-size: .68rem; font-weight: 700; border: 1px solid transparent; }
.badge-green  { background: #e8f5e0; color: #2e7a2e; border-color: #b8dca8; }
.badge-orange { background: #fff0d8; color: #a05800; border-color: #e8c878; }
.badge-gray   { background: #f0ece4; color: var(--muted); border-color: var(--border2); }
.join-btn {
  background: var(--amber); color: #fff; border: none;
  padding: 8px 18px; border-radius: var(--radius-pill); cursor: pointer;
  font-weight: 700; font-size: .83rem; font-family: var(--font-body);
  white-space: nowrap; transition: background .15s;
  box-shadow: 0 2px 6px rgba(196,124,40,.25);
}
@media (hover: hover) { .join-btn:hover { background: var(--amber2); } }
.join-btn:disabled { opacity: .35; cursor: not-allowed; box-shadow: none; }

/* ── WAIT ── */
.wait-players { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin: 18px 0; }
.wait-player {
  background: rgba(255,252,244,.9); border: 1.5px solid var(--border2);
  border-radius: var(--radius-sm); padding: 9px 16px; font-size: .88rem; color: var(--ink2);
}
.wait-player.me { border-color: var(--amber); color: var(--ink); font-weight: 700; }

/* ── GAME HEADER ── */
.game-header {
  width: 100%; max-width: 1000px;
  display: flex; align-items: center; justify-content: space-between;
  flex-wrap: nowrap; gap: 12px;
  margin-bottom: 8px; padding: 6px 0;
  border-bottom: 1.5px solid var(--border2);
}
.header-left {
  display: flex; align-items: center; gap: 12px; min-width: 0;
}
.header-title {
  font-family: var(--font-display); font-size: 3rem; font-weight: 400;
  color: var(--amber); letter-spacing: .01em; white-space: nowrap; line-height: 1;
}
.header-title span { color: var(--amber); }
.bird-token {
  background: #fff8e0; border: 1.5px solid #e8c878;
  padding: 5px 10px; border-radius: var(--radius-pill); align-self: center;
  font-size: .7rem; color: #8a5a00; font-weight: 700;
  display: inline-flex; align-items: center; gap: 5px;
  white-space: nowrap; overflow: hidden; min-width: 0;
}
.bird-token.has-holder { border-color: var(--gold); color: #7a4800; background: #fff0c0; }
.bird-pip   { width:22px; height:22px; object-fit:cover; border-radius:50%; flex-shrink:0; }
.bird-pip.big { width:28px; height:28px; }
.deck-info  { font-size: .74rem; color: var(--muted); white-space: nowrap; }

/* ── PLAYERS BAR ── */
.players-bar { width: 100%; max-width: 1000px; display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.player-chip {
  flex: 1; min-width: 100px;
  background: var(--panel); border: 1.5px solid var(--border2);
  border-radius: var(--radius-sm); padding: 8px 10px;
  box-shadow: var(--shadow-card);
}
.player-chip.me   { border-color: var(--amber); background: #fffaee; }
.player-chip.bird { border-color: var(--gold); background: #fffae8; }
.pname   { font-size: .74rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
.ppts    { font-family: var(--font-display); font-size: 1.2rem; font-weight: 900; color: var(--amber); }
.plilies { font-size: .67rem; margin-top: 2px; color: var(--muted); }
.pbet    { font-size: .65rem; color: var(--teal2); margin-top: 2px; font-weight: 600; min-height: 1em; line-height: 1; }

/* ── TABLE ── */
.table-area  { width: 100%; max-width: 100%; margin-bottom: 10px; }
.table-label { font-size: .7rem; color: var(--muted); margin-bottom: 7px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; text-align: center; width: 100%; }
.table-cards {
  display: grid; gap: 10px; justify-content: center;
  /* largura da carta é a mais pequena entre: limite absoluto, o que cabe
     na largura do ecrã, e o que cabe na ALTURA disponível (convertido via
     aspect-ratio 300/420 da carta) — para a mesa nunca empurrar a área de
     apostas/capivaras recolhidas para fora do ecrã (abaixo do fold). */
  grid-template-columns: repeat(var(--n-cards,3), min(300px, calc((100vw - 80px) / var(--n-cards,3)), calc((100vh - 610px) * 5 / 7)));
  grid-template-columns: repeat(var(--n-cards,3), min(300px, calc((100vw - 80px) / var(--n-cards,3)), calc((100dvh - 610px) * 5 / 7)));
}

/* ── THE CARD ── */
.cap-card {
  min-width: 0;
  max-width: 300px;
  width: 100%;
  border-radius: var(--radius-md); border: 2px solid var(--border2);
  cursor: pointer; transition: all .18s;
  position: relative; overflow: hidden;
  background: var(--card-bg); user-select: none;
  box-shadow: var(--shadow-card);
}
/* hover removed — would reveal betting state */
.cap-card.selected {
  border-color: var(--amber);
  background: var(--card-sel);
  box-shadow: 0 0 0 3px rgba(196,124,40,.22), 0 8px 20px rgba(100,60,20,.15);
  transform: translateY(-5px);
}
.cap-card.won    { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(232,176,32,.25), 0 4px 12px rgba(100,60,20,.1); }
.cap-card.nobody { border-color: var(--border2); opacity: .45; box-shadow: none; }
.cap-card.reveal-card { cursor: default; }

/* Art */
.card-art-wrap { width: 100%; aspect-ratio: 300/420; position: relative; overflow: hidden; background: #f0f8f5; }
.card-art { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-art-fallback {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display); font-weight: 900; font-size: 1.8rem;
  color: var(--amber); opacity: .7;
  background: linear-gradient(160deg, #f8f2e2 0%, #c8ede6 100%);
}
.card-art-fallback.hidden { display: none; }

/* Position letter on art */
.card-pos-badge {
  position: absolute; top: 7px; left: 8px; z-index: 2;
  background: rgba(255,252,244,.85); color: var(--ink);
  font-size: .64rem; font-weight: 900;
  padding: 2px 8px; border-radius: var(--radius-pill);
  font-family: var(--font-display); border: 1px solid var(--border2);
}

/* Info strip below art */
.card-info { padding: 8px 10px 9px; background: #fffcf6; border-top: 1px solid var(--border2); }
.card-caps-count {
  font-family: var(--font-display);
  font-size: .88rem; font-weight: 700; color: var(--ink); margin-bottom: 4px;
}
.card-badges { display: flex; gap: 3px; flex-wrap: wrap; }
.lily { display: inline-block; padding: 2px 6px; border-radius: var(--radius-pill); font-size: .62rem; font-weight: 700; }
.lily-Y { background: #fff3c8; color: #8a5a00; border: 1px solid #e8c860; }
.lily-R { background: #ffe8e0; color: #8a2810; border: 1px solid #e8a090; }
.lily-W { background: #e8eef4; color: #3a5068; border: 1px solid #a8c0d0; }
.lily-B { background: #e0f0f8; color: #185888; border: 1px solid #80c0e0; }
.lily-bird { background: #fff8d8; color: #7a5000; border: 1px solid #e8c040; }

.card-result-label {
  position: absolute; top: 7px; right: 8px; z-index: 2;
  font-size: .6rem; font-weight: 700;
  padding: 2px 8px; border-radius: var(--radius-pill);
  font-family: var(--font-body);
  max-width: calc(100% - 52px); /* don't overlap the A/B/C badge */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-result-label.win    { background: var(--gold); color: #3a2000; }
.card-result-label.nobody { background: rgba(100,80,60,.15); color: var(--muted); border: 1px solid var(--border); }

/* ── STATUS BAR ── */
.status-bar {
  width: 100%; max-width: 1000px;
  background: var(--panel); border: 1.5px solid var(--border2);
  border-radius: var(--radius-sm); padding: 10px 16px; margin-bottom: 10px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  box-shadow: var(--shadow-card);
}
.phase-badge { padding: 3px 12px; border-radius: var(--radius-pill); font-size: .76rem; font-weight: 700; font-family: var(--font-display); }
.phase-BETTING   { background: #e8f5e0; color: #1e5a1e; border: 1px solid #b0d890; }
.phase-REVEAL    { background: #fff0d0; color: #7a4800; border: 1px solid #e8c060; }
.phase-GAME_OVER { background: #fde8e0; color: #8a2010; border: 1px solid #e8a090; }
.status-text { font-size: .86rem; color: var(--ink2); flex: 1; }
.bet-count   { font-size: .76rem; color: var(--muted); margin-left: auto; font-weight: 600; }

/* ── MY SCORED ── */
.my-area { width: 100%; max-width: 1000px; padding-bottom: 20px; }
.my-area-label { font-size: .68rem; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
/* Fila horizontal de largura fixa em vez de "wrap" — assim que se ganham
   várias capivaras, um grid que cresce em altura empurra o resto da
   página para fora do ecrã outra vez (o cap de altura das cartas da
   mesa não tem como prever quanto esta fila vai crescer). Uma fila que
   desliza para os lados mantém a altura sempre igual a 1 carta. */
.my-scored { display: flex; gap: 10px; flex-wrap: nowrap; align-items: flex-start; overflow-x: auto; padding-bottom: 4px; }
.mini-card {
  width: 100px; flex-shrink: 0; background: var(--card-bg);
  border: 1.5px solid var(--border2); border-radius: var(--radius-sm);
  overflow: hidden; font-size: .7rem; color: var(--ink2);
  box-shadow: var(--shadow-card);
  display: flex; flex-direction: column;
}
.mini-card-art {
  width: 100%; aspect-ratio: 3/4; object-fit: cover; display: block;
  background: linear-gradient(160deg, #f8f2e2 0%, #c8ede6 100%);
}
.mini-card-art.fallback {
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display); font-weight: 900; font-size: 1.2rem;
  color: var(--amber); opacity: .7;
}
.mini-card-label {
  padding: 4px 6px 5px; border-top: 1px solid var(--border2);
  font-size: .65rem; line-height: 1.3; color: var(--ink2);
  background: #fffcf6;
}
.mini-card-badges { display: flex; gap: 2px; flex-wrap: wrap; margin-top: 2px; }
.mini-lily { padding: 1px 4px; border-radius: var(--radius-pill); font-size: .58rem; font-weight: 700; }

/* ── GAME OVER ── */
.overlay { display: none; position: fixed; inset: 0; background: rgba(46,26,10,.55); align-items: center; justify-content: center; z-index: 100; padding: 20px; backdrop-filter: blur(3px); }
.overlay.active { display: flex; }
.modal {
  background: var(--panel-b); border: 1.5px solid var(--border2);
  border-radius: var(--radius-lg); padding: 32px;
  max-width: 520px; width: 100%; max-height: 90vh; max-height: 90dvh; overflow-y: auto;
  box-shadow: var(--shadow-card-hover);
}
.modal h2 {
  font-family: var(--font-display); font-size: 1.8rem; font-weight: 900;
  color: var(--ink); text-align: center; margin-bottom: 24px;
}
.score-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 0; border-bottom: 1px solid var(--border2); gap: 8px;
}
.score-row:last-child { border: none; }
.score-name   { font-weight: 700; color: var(--ink); }
.score-pts    { font-family: var(--font-display); font-size: 1.1rem; font-weight: 900; color: var(--amber); white-space: nowrap; }
.score-detail { font-size: .74rem; color: var(--muted); }
.winner-badge { background: var(--gold); color: #3a2000; padding: 2px 9px; border-radius: var(--radius-pill); font-size: .7rem; font-weight: 700; }
.modal-actions { display: flex; gap: 10px; margin-top: 24px; }


.bird-count { display:inline-flex; align-items:center; gap:2px; font-size:.75rem; color:#7a5000; font-weight:700; margin-left:3px; }


/* ── VIDEO PLACEHOLDER ── */
.video-wrap {
  margin-top: 24px;
  border-radius: var(--radius-md); overflow: hidden;
  border: 1.5px solid var(--border2);
  background: linear-gradient(160deg, #e8f4f0 0%, #d0ece6 100%);
  position: relative; aspect-ratio: 16/9;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--muted); cursor: pointer;
}
.video-wrap video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: calc(var(--radius-md) - 1.5px); }
.video-wrap .play-icon {
  width: 54px; height: 54px; border-radius: 50%;
  background: rgba(196,124,40,.15); border: 2px solid var(--amber);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.4rem; color: var(--amber); position: relative; z-index: 1;
  transition: background .2s;
}
@media (hover: hover) { .video-wrap:hover .play-icon { background: rgba(196,124,40,.28); } }
.video-label { font-size: .8rem; font-family: var(--font-display); font-style: italic; position: relative; z-index: 1; }
.video-missing { font-size: .75rem; color: var(--muted); margin-top: 4px; position: relative; z-index: 1; }

/* ── RULES PANEL ── */
.rules-panel {
  width: 100%; max-width: 1000px;
  margin-top: 4px; margin-bottom: 20px;
  border: 1.5px solid var(--border2); border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--panel);
  box-shadow: var(--shadow-card);
}
.rules-toggle {
  width: 100%; background: none; border: none; cursor: pointer;
  padding: 12px 18px; display: flex; align-items: center; justify-content: space-between;
  font-family: var(--font-display); font-size: .88rem; font-weight: 700;
  color: var(--ink2); text-align: left;
  transition: background .15s;
}
@media (hover: hover) { .rules-toggle:hover { background: rgba(196,124,40,.06); } }
.rules-toggle .chevron { font-size: .7rem; transition: transform .25s; color: var(--amber); }
.rules-toggle.open .chevron { transform: rotate(180deg); }
.rules-body {
  display: none; padding: 0 20px 20px;
  border-top: 1px solid var(--border2);
  animation: slideDown .2s ease;
}
.rules-body.open { display: block; }
@keyframes slideDown { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
.rules-body h3 {
  font-family: var(--font-display); font-size: 1rem; font-weight: 700;
  color: var(--amber); margin: 18px 0 6px;
}
.rules-body p { font-size: .84rem; color: var(--ink2); line-height: 1.6; margin-bottom: 6px; }
.rules-body ul { margin: 4px 0 8px 18px; }
.rules-body li { font-size: .82rem; color: var(--ink2); line-height: 1.7; }
.rules-body .rule-tag {
  display: inline-block; padding: 1px 7px; border-radius: var(--radius-pill);
  font-size: .72rem; font-weight: 700; margin-right: 3px;
  background: #fff3c8; color: #7a5000; border: 1px solid #e8c060;
}
.rules-body .rule-tag.green { background: #e8f5e0; color: #1e5a1e; border-color: #b0d890; }
.rules-body .rule-tag.blue  { background: #e0f0f8; color: #185888; border-color: #80c0e0; }

/* ── NOTIFICATION ── */
#notif {
  position: fixed; top: 20px; right: 20px;
  background: var(--amber); color: #fff;
  padding: 12px 20px; border-radius: var(--radius-pill);
  font-size: .88rem; font-weight: 700; z-index: 200;
  transition: opacity .3s; pointer-events: none; opacity: 0;
  max-width: 280px; text-align: center;
  box-shadow: 0 4px 20px rgba(196,124,40,.35);
}
#notif.show { opacity: 1; }

@media(max-width:640px){
  .game-logo      { font-size: 2.8rem; }

  .player-chip    { min-width: 80px; }
  .header-title   { font-size: 1.1rem; }
  .bird-pip.big   { width:18px; height:18px; }
  .bird-token     { font-size: .6rem; padding: 2px 5px; gap: 3px; }
  .deck-info      { display: none; }
}

/* ── AMBIENT PLAYER ── */
.ambient-btn {
  display: flex; align-items: center; gap: 5px;
  background: var(--card-bg); border: 1.5px solid var(--border2);
  border-radius: var(--radius-pill); padding: 4px 10px 4px 7px;
  font-size: .7rem; color: var(--ink2); cursor: pointer;
  white-space: nowrap; transition: background .15s;
  font-family: var(--font-body); font-weight: 600;
}
@media (hover: hover) { .ambient-btn:hover { background: #e8f5f3; } }
.ambient-btn .amb-icon { font-size: .95rem; line-height: 1; }

/* ── TUTORIAL (tour guiado) ── */
/* Spotlight: escurece tudo menos os alvos. pointer-events:none para os
   elementos destacados (cartas, botões) continuarem clicáveis por baixo. */
.tut-spot { position: fixed; inset: 0; z-index: 300; pointer-events: none; display: none; }
.tut-spot.active { display: block; }
.tut-spot svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.tut-ring {
  position: fixed; pointer-events: none;
  border: 2.5px solid var(--gold); border-radius: var(--radius-md);
  box-shadow: 0 0 0 4px rgba(232,176,32,.25);
  animation: tutPulse 1.6s ease-in-out infinite;
}
@keyframes tutPulse { 50% { box-shadow: 0 0 0 9px rgba(232,176,32,.1); } }
.tut-coach {
  position: fixed; z-index: 310; display: none;
  width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); overflow-y: auto;
  background: var(--panel-b); border: 1.5px solid var(--border);
  border-radius: var(--radius-lg); padding: 16px 18px 12px;
  box-shadow: var(--shadow-card-hover);
  transition: top .2s, left .2s;
}
.tut-coach.active { display: block; }
.tut-title { font-family: var(--font-display); font-size: 1.15rem; font-weight: 700; color: var(--ink); line-height: 1.2; margin-bottom: 6px; }
.tut-text { font-size: .86rem; color: var(--ink2); line-height: 1.55; }
.tut-text b { color: var(--ink); }
.tut-text ul { margin: 6px 0 0 18px; }
.tut-text li { margin-bottom: 4px; }
.tut-lines div { margin-top: 5px; }
.tut-queue { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.tut-qchip {
  padding: 3px 10px; border-radius: var(--radius-pill);
  font-size: .72rem; font-weight: 700; white-space: nowrap;
  background: #f0ece4; color: var(--ink2); border: 1.5px solid var(--border2);
  transition: all .2s;
}
.tut-qchip.now  { background: var(--amber); color: #fff; border-color: var(--amber); box-shadow: 0 0 0 3px rgba(196,124,40,.2); }
.tut-qchip.done { opacity: .45; }
.tut-qarrow { color: var(--muted); font-size: .72rem; }
.tut-thinking { margin-top: 8px; font-size: .8rem; font-weight: 700; color: var(--teal2); }
.tut-shortcuts { display: flex; gap: 6px; margin-top: 10px; }
.tut-shortcuts .btn { flex: 1; padding: 8px 6px; }
.tut-progress { height: 4px; background: var(--border2); border-radius: var(--radius-pill); margin: 12px 0 8px; overflow: hidden; }
.tut-progress > div { height: 100%; background: var(--amber); transition: width .25s; }
.tut-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tut-actions .btn-primary { width: auto; margin-left: auto; }
.tut-final { display: flex; gap: 8px; width: 100%; margin-top: 4px; }
.tut-final .btn { flex: 1; }
.tut-count { font-size: .7rem; color: var(--muted); font-weight: 600; }
.tut-exit {
  background: none; border: none; cursor: pointer; padding: 4px 0;
  font-family: var(--font-body); font-size: .76rem; color: var(--muted); text-decoration: underline;
}
@media (hover: hover) { .tut-exit:hover { color: var(--ink2); } }
.tut-hint {
  display: none; align-items: center; gap: 10px; flex-wrap: wrap;
  background: #fff8e0; border: 1.5px solid #e8c878; border-radius: var(--radius-md);
  padding: 12px 14px; font-size: .85rem; color: var(--ink2); box-shadow: var(--shadow-card);
}
.tut-hint.show { display: flex; }
.tut-hint-text { flex: 1; min-width: 180px; line-height: 1.45; }
.tut-hint .btn-primary { width: auto; }

/* ─────────────────────────────────────────────────────────────────────────
   LAYOUT DE JOGO EM TELEMÓVEL — partes genéricas
   Copiado da secção "Layout de jogo em telemóvel" de src/game-ui.css do
   bitnikgames-design-system (receita completa em docs/game-layout.md).
   Seletores adaptados às classes deste jogo: .modal-overlay/.modal-box →
   .overlay/.modal, .btn/.tab → os botões daqui; tokens → os deste jogo.
   Fora: .game-row, .hand-toggle e .recap-pill (não há fila com scroll
   centrada, nem mão, nem botão "Continuar" entre rondas).
───────────────────────────────────────────────────────────────────────── */
/* altura real e toque: dvh = altura visível de facto (sem a barra do
   browser móvel); overscroll-behavior evita o pull-to-refresh a meio de
   uma ronda; touch-action tira o atraso/zoom de duplo toque. */
html, body { height: 100%; }
@supports (height: 100dvh) { html, body { height: 100dvh; } }
body { -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
button { touch-action: manipulation; }

/* alvos de toque >= 44px (recomendação iOS/Android) */
@media (pointer: coarse) {
  .btn, .join-btn, .ambient-btn, .rules-toggle, .tut-exit { min-height: 44px; }
}

/* html.edge: margens de notch / barra de estado só em ecrã inteiro.
   A classe é posta por syncEdge() quando a página ocupa o ecrã todo
   (app instalada ou requestFullscreen). No browser normal é o próprio
   browser que reserva essas zonas — aplicá-las aí criava faixas vazias. */
html.edge .game-header {
  padding-top: max(4px, env(safe-area-inset-top));
  padding-left: max(10px, env(safe-area-inset-left));
  padding-right: max(10px, env(safe-area-inset-right));
}
html.edge .screen.active:not(#screen-game) { padding-top: max(24px, env(safe-area-inset-top)); }

/* modais: vertical estreito → bottom sheet (encostada em baixo, na zona do
   polegar); horizontal baixo → menos moldura e quase o ecrã todo de altura. */
@media (max-width: 640px) {
  .overlay { justify-content: flex-end; align-items: stretch; flex-direction: column; padding: 0; }
  .modal {
    max-width: 100%;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    border-left: 0; border-right: 0; border-bottom: 0;
    padding: 20px 16px calc(20px + env(safe-area-inset-bottom));
    max-height: 88vh; max-height: 88dvh;
    animation: sheetUp .25s ease;
  }
}
@media (orientation: landscape) and (max-height: 500px) {
  .overlay { padding: 6px; }
  .modal { padding: 10px 18px; max-height: calc(100vh - 12px); max-height: calc(100dvh - 12px); }
}
@keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

/* ─────────────────────────────────────────────────────────────────────────
   COMPACTO — telemóvel, vertical ou deitado (= COMPACT_MQ no JS)
   O ecrã de jogo deixa de ser uma página com scroll e passa a uma coluna
   com a altura do ecrã: a mesa fica com o que sobra. Menos moldura e menos
   texto (o JS desenha as versões curtas). Botões só do telemóvel no
   cabeçalho (.hdr-compact): escondidos fora daqui.
───────────────────────────────────────────────────────────────────────── */
.hdr-compact { display: none; }
@media (max-width: 640px), (orientation: landscape) and (max-height: 500px) {
  #screen-game.active {
    height: 100vh; height: 100dvh; min-height: 0;
    padding: 0; overflow: hidden; align-items: stretch;
  }
  /* nada espremido: só a mesa encolhe */
  #screen-game.active > * { flex-shrink: 0; max-width: none; }

  /* Cabeçalho numa linha: pássaro · baralho · ⛶ 📖 🔇 Sair */
  .game-header { margin: 0; padding: 4px 8px; gap: 6px; }
  .header-left { gap: 6px; }
  .bird-token { font-size: .66rem; padding: 3px 8px 3px 4px; gap: 4px; }
  .bird-pip.big { width: 20px; height: 20px; }
  .deck-info { display: block; font-size: .7rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .hdr-compact { display: inline-flex; }
  .hdr-compact[hidden] { display: none; }
  .game-header .btn-sm, .ambient-btn {
    min-height: 34px; min-width: 34px; padding: 0 8px; font-size: .8rem;
    justify-content: center;
  }
  .ambient-btn { gap: 0; }
  #amb-label { display: none; }

  /* Jogadores: grelha de colunas iguais, sem scroll; painel de 3 linhas curtas */
  .players-bar {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
    gap: 5px; padding: 5px 8px; margin: 0;
  }
  .player-chip {
    min-width: 0; padding: 3px 7px 4px;
    display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 6px; align-items: center;
    grid-template-areas: "name name" "pts lil" "bet bet";
  }
  .pname   { grid-area: name; font-size: .7rem; }
  .ppts    { grid-area: pts; font-size: 1rem; line-height: 1.1; }
  .ppts span { display: none; }
  .plilies { grid-area: lil; margin: 0; height: 14px; line-height: 14px; white-space: nowrap; overflow: hidden; }
  .plilies .bird-pip { width: 12px; height: 12px; vertical-align: -2px; }
  .bird-count { font-size: .64rem; }
  .pbet    { grid-area: bet; margin: 0; font-size: .62rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Mesa: o tamanho das cartas sai do espaço que a célula tem de facto
     (container queries). n cartas (= nº de jogadores) numa fila, OU em 2
     linhas de ⌈n/2⌉ (--n-half, posto pelo JS) — fica a opção que der cartas
     maiores; a ordem não conta, as letras identificam as cartas.
     Carta = arte 5:7 + faixa de info de altura fixa; 30px = faixa + bordas. */
  #screen-game .table-area {
    flex: 1 1 0; min-height: 0; margin: 0;
    container-type: size; overflow: hidden;
  }
  .table-cards {
    display: flex; flex-wrap: wrap; gap: 6px; height: 100%; padding: 6px 10px;
    justify-content: safe center; align-content: safe center;
    --cw1: min(calc((100cqw - 20px - var(--tut-gutter, 0px) - (var(--n-cards, 3) - 1) * 6px) / var(--n-cards, 3)),
               calc((100cqh - 12px - 30px) * 5 / 7));
    --cw2: min(calc((100cqw - 20px - (var(--n-half, 2) - 1) * 6px) / var(--n-half, 2)),
               calc(((100cqh - 18px) / 2 - 30px) * 5 / 7));
  }
  .table-cards .cap-card { flex: none; width: max(var(--cw1), var(--cw2)); }
  /* No tutorial, uma fila só e encostada em cima: sobra espaço por baixo para o balão */
  body:has(.tut-coach.active) .table-cards { align-content: safe flex-start; }
  body:has(.tut-coach.active) .table-cards .cap-card { width: var(--cw1); }
  .card-info {
    height: 24px; padding: 0 6px; display: flex; align-items: center; gap: 4px;
    white-space: nowrap; overflow: hidden;
  }
  .card-caps-count { margin: 0; font-size: .9rem; line-height: 1; }
  .card-badges { flex-wrap: nowrap; gap: 1px; align-items: center; font-size: .75rem; }
  .card-badges .bird-pip { width: 14px; height: 14px; }
  .card-pos-badge { top: 4px; left: 4px; padding: 1px 6px; }
  .card-result-label { top: auto; bottom: 30px; left: 4px; right: 4px; max-width: none; text-align: center; }

  /* A minha área: estado numa caixa de 2 linhas fixas + faixa de miniaturas */
  .status-bar {
    width: auto; margin: 0 8px; padding: 4px 10px; gap: 8px;
    flex-wrap: nowrap; box-shadow: none;
  }
  .phase-badge { white-space: nowrap; font-size: .7rem; padding: 2px 9px; }
  .status-text {
    min-width: 0; font-size: .78rem; line-height: 1.25; height: 2.5em;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
    align-content: center;
  }
  .bet-count { font-size: .72rem; white-space: nowrap; }
  .my-area { padding: 6px 8px; padding-bottom: max(6px, env(safe-area-inset-bottom)); }
  .my-area-label { display: none; }
  .my-scored { gap: 5px; padding-bottom: 0; min-height: 60px; align-items: center; }
  .mini-card { width: 44px; border-radius: var(--radius-sm); }
  .mini-card-art { aspect-ratio: 1; }
  .mini-card-label {
    height: 16px; padding: 0 4px; font-size: .62rem; font-weight: 700; line-height: 15px;
    white-space: nowrap; overflow: hidden;
  }

  /* Regras: o acordeão sai do fundo da página e passa a bottom sheet,
     aberta pelo 📖 do cabeçalho (toggleRules) */
  .rules-panel { display: none; }
  .rules-panel.open {
    display: flex; flex-direction: column;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 150;
    max-width: 640px; margin: 0 auto;
    max-height: 88vh; max-height: 88dvh;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0; border-bottom: 0;
    background: var(--panel-b);
    box-shadow: 0 0 0 100vmax rgba(46,26,10,.55);
    animation: sheetUp .25s ease;
  }
  .rules-panel.open .rules-toggle { flex-shrink: 0; }
  .rules-panel.open .rules-body { overflow-y: auto; padding-bottom: calc(20px + env(safe-area-inset-bottom)); }

  /* Fim do jogo e balão do tutorial: menos moldura */
  .modal h2 { font-size: 1.4rem; margin-bottom: 12px; }
  .modal-actions { margin-top: 14px; }
  .tut-coach { padding: 12px 14px 10px; }
  .tut-text { font-size: .8rem; line-height: 1.45; }
  .tut-progress { margin: 8px 0 6px; }
  /* se o balão tiver de encolher (scroll interno), os botões ficam sempre à vista */
  .tut-actions { position: sticky; bottom: 0; background: var(--panel-b); }

  #notif { top: 48px; right: 8px; }
}

/* Vertical: no tutorial as cartas ficam com no máximo ~40% da mesa, para o
   balão caber por baixo delas mesmo num ecrã de 600px. */
@media (max-width: 640px) and (orientation: portrait) {
  body:has(.tut-coach.active) .table-cards .cap-card { width: min(var(--cw1), calc((40cqh - 30px) * 5 / 7)); }
}

/* ─────────────────────────────────────────────────────────────────────────
   TELEMÓVEL NA HORIZONTAL — 2 colunas
   Com ~300–390px de altura não dá para empilhar: jogadores e mesa à
   esquerda, estado e as minhas capivaras à direita.
───────────────────────────────────────────────────────────────────────── */
@media (orientation: landscape) and (max-height: 500px) {
  #screen-game.active {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(240px, 34%);
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: "header header" "players status" "table my";
  }
  html.edge #screen-game.active { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
  .game-header { grid-area: header; padding-top: 2px; padding-bottom: 2px; }
  .players-bar { grid-area: players; }
  #screen-game .table-area { grid-area: table; }
  .status-bar  { grid-area: status; align-self: center; margin: 5px 8px 0 0; flex-wrap: wrap; row-gap: 2px; }
  .status-text { flex-basis: 100%; order: 3; }
  .bet-count   { margin-left: auto; }
  .my-area {
    grid-area: my; min-height: 0; overflow-y: auto;
    border-left: 1px solid var(--border2); margin-top: 6px;
  }
  .my-scored { flex-wrap: wrap; overflow-x: visible; align-content: flex-start; }

  /* Fim do jogo: tem de caber em ~300px — nome e detalhe na mesma linha */
  .modal h2 { font-size: 1.15rem; margin-bottom: 4px; }
  .score-row { padding: 2px 0; line-height: 1.25; }
  .score-name { font-size: .9rem; }
  .score-pts  { font-size: .95rem; }
  .score-row > div:first-child { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; }
  .modal-actions { margin-top: 8px; }
  .modal-actions .btn { min-height: 38px; padding-top: 6px; padding-bottom: 6px; }
  /* No tutorial o balão vai ao lado do modal: modal mais estreito e à esquerda */
  body:has(.tut-coach.active) .overlay { justify-content: flex-start; }
  body:has(.tut-coach.active) .modal { max-width: min(420px, 55vw); }
  /* …e a mesa encosta à esquerda com uma margem, para o balão caber ao lado das cartas */
  body:has(.tut-coach.active) .table-cards { justify-content: safe flex-start; --tut-gutter: 50px; }
  /* Balão mais largo e mais baixo: com ~300px de altura cada linha conta */
  .tut-coach { width: min(460px, calc(100vw - 24px)); padding: 10px 14px 8px; }
  .tut-title { font-size: 1rem; margin-bottom: 3px; }
  .tut-text  { font-size: .78rem; line-height: 1.4; }
  .tut-queue, .tut-shortcuts { margin-top: 6px; }
  .tut-progress { margin: 6px 0 4px; }
  .tut-actions .btn { min-height: 36px; padding-top: 4px; padding-bottom: 4px; }
}
</style>
</head>
<body>
<div id="notif"></div>

<!-- NAME -->
<div class="screen active" id="screen-name">
  <div style="width:100%;max-width:460px;display:flex;flex-direction:column;gap:16px">
    <div class="tut-hint" data-install-hint></div>
    <div class="tut-hint" data-tut-hint></div>
    <div class="card-box" style="text-align:center">
      <div class="game-logo">Capi<span>varas</span></div>
      <div class="game-tagline">Um jogo de apostas secretas</div>
      <div class="h-rule"></div>
      <h2 style="text-align:left">Como te chamas?</h2>
      <input type="text" id="inp-name" placeholder="O teu nome..." maxlength="20" autocomplete="off">
      <button class="btn btn-primary" id="btn-go">Entrar no jogo</button>
      <button class="btn btn-outline" id="btn-tut-name" style="width:100%;margin-top:10px">🎓 Tutorial</button>
    </div>
    <div class="video-wrap" id="video-wrap" onclick="playRulesVideo()">
      <video id="rules-video" preload="none" controls style="display:none"></video>
      <div class="play-icon" id="play-icon">▶</div>
      <div class="video-label">Como jogar — ver as regras</div>
      <div class="video-missing" id="video-missing">regras.mp4 não encontrado</div>
    </div>
    <p style="text-align:center;font-size:.68rem;color:#9a7050;font-family:var(--font-display);font-style:italic;padding:2px 0 0">Um jogo de David Marques &nbsp;·&nbsp; <a href="https://creativecommons.org/licenses/by-nc-nd/4.0/" target="_blank" style="color:#c47c28;text-decoration:none">CC BY-NC-ND 4.0</a></p>
  </div>
</div>
<!-- LOBBY -->
<div class="screen" id="screen-lobby">
  <div class="card-box" style="max-width:560px">
    <div style="text-align:center;margin-bottom:24px">
      <div class="game-logo" style="font-size:2.2rem">Capi<span>varas</span></div>
    </div>
    <div class="tut-hint" data-install-hint style="margin-bottom:16px"></div>
    <div class="tut-hint" data-tut-hint style="margin-bottom:16px"></div>
    <h2>Escolhe uma mesa</h2>
    <div class="lobby-grid" id="lobby-list"></div>
    <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-outline btn-sm" id="btn-back-name">← Mudar nome</button>
      <button class="btn btn-outline btn-sm" id="btn-tut-lobby">🎓 Tutorial</button>
    </div>
  </div>
</div>

<!-- WAIT -->
<div class="screen" id="screen-wait">
  <div class="card-box">
    <div style="text-align:center;margin-bottom:20px">
      <div class="game-logo" style="font-size:2rem">Capi<span>varas</span></div>
    </div>
    <h2 id="wait-title">A aguardar jogadores...</h2>
    <div class="wait-players" id="wait-players"></div>
    <div id="wait-host-area" style="display:none">
      <button class="btn btn-primary" id="btn-start" disabled>Iniciar Jogo</button>
    </div>
    <div id="wait-guest-msg" style="display:none;color:var(--muted);font-size:.88rem;text-align:center;padding:8px 0">
      Aguarda que o anfitrião inicie o jogo...
    </div>
    <div style="margin-top:16px">
      <button class="btn btn-outline btn-sm" id="btn-leave-wait">← Sair da mesa</button>
    </div>
  </div>
</div>

<!-- GAME -->
<div class="screen" id="screen-game">
  <div class="game-header">
    <div class="header-left">
      <div class="bird-token" id="bird-token-display">Pássaro — sem detentor</div>
      <div class="deck-info" id="deck-info">—</div>
    </div>
    <audio id="ambient-audio" src="/ambient.mp3" loop preload="none"></audio>
    <div style="display:flex;align-items:center;gap:6px">
      <button class="btn btn-outline btn-sm hdr-compact" id="btn-fullscreen" hidden aria-label="Ecrã inteiro">⛶</button>
      <button class="btn btn-outline btn-sm hdr-compact" id="btn-rules-game" onclick="toggleRules()" aria-label="Regras">📖</button>
      <button class="ambient-btn" id="ambient-btn" onclick="toggleAmbient()" title="Música ambiente">
        <span class="amb-icon" id="amb-icon">🔇</span>
        <span id="amb-label">Som</span>
      </button>
      <button class="btn btn-outline btn-sm" id="btn-leave-game">Sair</button>
    </div>
  </div>
  <div class="players-bar" id="players-bar"></div>
  <div class="table-area">
    <div class="table-cards" id="table-cards"></div>
  </div>
  <div class="status-bar">
    <span class="phase-badge" id="phase-badge">—</span>
    <span class="status-text" id="status-text">—</span>
    <span class="bet-count"   id="bet-count"></span>
  </div>
  <div class="my-area">
    <div class="my-area-label">As tuas capivaras</div>
    <div class="my-scored" id="my-scored"></div>
  </div>

  <!-- RULES PANEL -->
  <div class="rules-panel">
    <button class="rules-toggle" id="rules-toggle" onclick="toggleRules()">
      <span>Como jogar — Regras do Capivaras</span>
      <span class="chevron">▼</span>
    </button>
    <div class="rules-body" id="rules-body">

      <h3>O Pantanal acorda...</h3>
      <p>No coração húmido do Pantanal, uma colónia de capivaras relaxa ao sol. Chegaram os humanos — cada um quer dar festinhas nas suas favoritas. Mas as capivaras são tímidas: se dois humanos se aproximarem ao mesmo tempo, fogem imediatamente. Só o jogador que chegar <em>sozinho</em> ganha a sua capivara.</p>

      <h3>Cada ronda</h3>
      <p>A cada ronda, são colocadas na mesa tantas cartas quantos os jogadores, identificadas pelas letras A, B, C… Em segredo, cada um escolhe a carta que quer conquistar. Não há turnos: quando todos tiverem apostado, as apostas revelam-se ao mesmo tempo.</p>
      <ul>
        <li><span class="rule-tag green">Sozinho</span> Foste o único a escolher essa carta? É tua!</li>
        <li><span class="rule-tag">Empate</span> Mais de um jogador escolheu a mesma carta? Ninguém a ganha — as capivaras fugiram e a carta vai para o descarte.</li>
        <li><span class="rule-tag blue">Sem apostas</span> Ninguém escolheu uma carta? Também vai para o descarte.</li>
      </ul>

      <h3>O pássaro amarelo</h3>
      <p>Algumas cartas têm um pássaro amarelo. Quem recolher a primeira dessas cartas fica com o <strong>token do pássaro</strong> (vale +5 pontos no fim). Para roubar o token, tens de acumular <em>mais</em> cartas com pássaro do que o detentor atual (pelo menos mais uma). Em caso de empate, o token não se move. Se dois jogadores apanharem a primeira carta com pássaro na mesma ronda, o token fica na mesa até alguém ter mais cartas com pássaro do que eles.</p>

      <h3>Os nenúfares</h3>
      <p>Certas cartas têm nenúfares coloridos. Coleciona as quatro cores para ganhar <strong>+10 pontos bónus</strong> no final.</p>
      <ul>
        <li><span class="rule-tag" style="background:#fff3c8;color:#7a5000;border-color:#e8c060">Amarelo</span>
            <span class="rule-tag" style="background:#ffe8e0;color:#8a2810;border-color:#e8a090">Vermelho</span>
            <span class="rule-tag" style="background:#e8eef4;color:#3a5068;border-color:#a8c0d0">Branco</span>
            <span class="rule-tag blue">Azul</span> — quatro cores, +10 pontos</li>
      </ul>

      <h3>O baralho</h3>
      <p>O baralho de 36 cartas é jogado duas vezes. Quando acaba pela primeira vez, baralha-se o descarte (as cartas que ninguém ganhou) e continua — as cartas ganhas ficam com quem as ganhou e não voltam ao jogo. Quando acaba pela segunda vez, o jogo termina e contam-se os pontos.</p>

      <h3>Pontuação final</h3>
      <ul>
        <li>Cada <strong>capivara</strong> nas cartas recolhidas = <strong>1 ponto</strong></li>
        <li>Token do <strong>pássaro</strong> = <strong>+5 pontos</strong></li>
        <li>Quatro cores de <strong>nenúfar</strong> = <strong>+10 pontos</strong></li>
      </ul>
      <p style="margin-top:10px;font-style:italic;color:var(--muted)">Arrisca, petisca, e que as capivaras estejam do teu lado.</p>
    </div>
  </div>
</div>
<!-- GAME OVER -->
<div class="overlay" id="overlay-gameover">
  <div class="modal">
    <h2>Fim do Jogo</h2>
    <div id="final-scores"></div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="btn-restart" style="display:none">Jogar Novamente</button>
      <button class="btn btn-outline"  id="btn-goto-lobby">Voltar ao Lobby</button>
    </div>
  </div>
</div>

<!-- TUTORIAL (tour guiado) -->
<div class="tut-spot" id="tut-spot"></div>
<div class="tut-coach" id="tut-coach" role="dialog" aria-live="polite"></div>

<script>
let ws,myName='',myToken='',myLobbySeat=-1,myLobbyId='',isSolo=false;
let state=null,myGameSeat=-1,isHost=false,waitLobby=null;
let reconnectAttempts=0,reconnectTimer=null;

const LL = { Y:'Amarelo', R:'Vermelho', W:'Branco', B:'Azul' };
const LI = { Y:'lily-Y', R:'lily-R', W:'lily-W', B:'lily-B' };
const LE = { Y:'●', R:'●', W:'●', B:'●' };
const LC = { Y:'#e8a820', R:'#d85030', W:'#8898a8', B:'#4898c8' };

// Modo compacto (telemóvel, vertical ou deitado) — o MESMO critério do @media
// COMPACTO no CSS. O CSS muda o layout; o JS decide o que desenhar (textos curtos,
// bolinhas em vez de etiquetas). Ao rodar o telemóvel redesenha.
const COMPACT_MQ = window.matchMedia('(max-width: 640px), (orientation: landscape) and (max-height: 500px)');
const isCompact  = () => COMPACT_MQ.matches;
const lilyDots = lilies => lilies.map(l=>'<span style="color:'+LC[l]+'" title="Nenúfar '+LL[l]+'">●</span>').join('');

function showScreen(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); document.getElementById(id).classList.add('active'); }
function openOverlay(id){ document.getElementById(id).classList.add('active'); }
function closeOverlay(id){ document.getElementById(id).classList.remove('active'); }
// Durante o tutorial, as ações de jogo vão para o handler local (tutHandle) — só o PING segue para o servidor.
function send(msg){ if(tut.active&&msg.type!=='PING'){ tutHandle(msg); return; } if(ws&&ws.readyState===1) ws.send(JSON.stringify(msg)); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
let _nt;
function notif(t,d=3200){ const e=document.getElementById('notif'); e.textContent=t; e.classList.add('show'); clearTimeout(_nt); _nt=setTimeout(()=>e.classList.remove('show'),d); }

function cardArtHTML(card){
  const src='/cards/'+card.img+'.webp';
  return '<div class="card-art-wrap">'+
    '<img class="card-art" src="'+src+'" alt="" onerror="capImgErr(this)">'+
    '<div class="card-art-fallback hidden">'+card.cap+'</div>'+
  '</div>';
}

// ── AUDIO ENGINE ─────────────────────────────────────────────────────────────
let _actx = null;
function getCtx(){ if(!_actx) _actx = new (window.AudioContext||window.webkitAudioContext)(); if(_actx.state==='suspended') _actx.resume(); return _actx; }

// Rubber duck squeak — when YOU pick a card
function playDuck(){
  try{
    const ctx=getCtx(), now=ctx.currentTime;
    const osc=ctx.createOscillator(), g=ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type='sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(280, now+0.08);
    osc.frequency.exponentialRampToValueAtTime(350, now+0.14);
    g.gain.setValueAtTime(0.25, now);
    g.gain.exponentialRampToValueAtTime(0.001, now+0.22);
    osc.start(now); osc.stop(now+0.22);
  }catch(e){}
}

// Bird tweet — when someone wins the bird token
function playTweet(){
  try{
    const ctx=getCtx();
    [0, 0.14, 0.26].forEach((delay,i)=>{
      const now=ctx.currentTime+delay;
      const osc=ctx.createOscillator(), g=ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type='sine';
      const f0=1400+i*200;
      osc.frequency.setValueAtTime(f0, now);
      osc.frequency.exponentialRampToValueAtTime(f0*1.8, now+0.06);
      osc.frequency.exponentialRampToValueAtTime(f0*1.4, now+0.10);
      g.gain.setValueAtTime(0.18, now);
      g.gain.exponentialRampToValueAtTime(0.001, now+0.12);
      osc.start(now); osc.stop(now+0.12);
    });
  }catch(e){}
}

// Wooden knock — when an opponent bets
function playKnock(){
  try{
    const ctx=getCtx(), now=ctx.currentTime;
    const buf=ctx.createBuffer(1,ctx.sampleRate*0.12,ctx.sampleRate);
    const data=buf.getChannelData(0);
    for(let i=0;i<data.length;i++) data[i]=(Math.random()*2-1)*Math.exp(-i/(ctx.sampleRate*0.018));
    const src=ctx.createBufferSource(), g=ctx.createGain();
    const filt=ctx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=320;
    src.buffer=buf; src.connect(filt); filt.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.55, now);
    g.gain.exponentialRampToValueAtTime(0.001, now+0.12);
    src.start(now);
  }catch(e){}
}




// Track bets: knock every time the total count increments
let _prevBetCount = -1;
function checkNewBets(betsPlaced){
  const n = betsPlaced.filter(Boolean).length;
  if(_prevBetCount === -1){ _prevBetCount = n; return; }
  if(n > _prevBetCount) playKnock();
  _prevBetCount = n;
}

// Track bird holder to detect token win
let _prevBirdHolder = -99;
function checkBirdChange(holder){
  if(_prevBirdHolder===-99){ _prevBirdHolder=holder; return; }
  if(holder!==null && holder!==_prevBirdHolder) playTweet();
  _prevBirdHolder = holder;
}

// Unlock audio on first interaction
let _audioUnlocked = false;
function unlockAudio(){
  if(_audioUnlocked) return;
  _audioUnlocked = true;
  getCtx();
}
document.addEventListener('pointerdown', unlockAudio, {once:true});

// Image load helpers — called via inline onload/onerror (avoids quote-escaping issues)
function capImgOk(img){ img.nextElementSibling.classList.add('hidden'); }
function capImgErr(img){ img.style.display='none'; img.nextElementSibling.classList.remove('hidden'); }

function connect(){
  const proto=location.protocol==='https:'?'wss://':'ws://';
  ws=new WebSocket(proto+location.host);
  ws.onopen=()=>{ reconnectAttempts=0; const t=sessionStorage.getItem('cap_token'); if(t) send({type:'RECONNECT',token:t}); else send({type:'LOBBIES'}); };
  ws.onmessage=e=>{ try{ handleMsg(JSON.parse(e.data)); }catch{} };
  ws.onclose=()=>scheduleReconnect();
  ws.onerror=()=>{};
}
function scheduleReconnect(){ clearTimeout(reconnectTimer); const d=Math.min(500*Math.pow(1.5,reconnectAttempts),12000); reconnectAttempts++; reconnectTimer=setTimeout(connect,d); }
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&(!ws||ws.readyState>1)){ reconnectAttempts=0; connect(); } });
setInterval(()=>send({type:'PING'}),15000);

function handleMsg(msg){
  // Tutorial ativo: nada do servidor pode mudar de ecrã — só guardamos a lista de mesas para depois.
  if(tut.active){ if(msg.type==='LOBBIES') _cachedLobbies=msg.lobbies; return; }
  switch(msg.type){
    case 'PONG': break;
    case 'LOBBIES':
      renderLobbyList(msg.lobbies);
      if(_joinSoloOnConnect){ _joinSoloOnConnect=false; send({type:'JOIN_LOBBY',lobbyId:'solo',playerName:myName}); }
      break;
    case 'JOINED':
      myToken=msg.token; myLobbySeat=msg.seat; myLobbyId=msg.lobbyId;
      isSolo=msg.solo; isHost=msg.seat===0; myGameSeat=msg.seat;
      sessionStorage.setItem('cap_token',myToken);
      if(!isSolo){ waitLobby=msg.lobby; renderWaitRoom(msg); showScreen('screen-wait'); }
      break;
    case 'LOBBY_STATE': myLobbySeat=msg.myLobbySeat; isHost=msg.myLobbySeat===0; waitLobby=msg.lobby; renderWaitRoom(msg); break;
    case 'PLAYER_JOINED': waitLobby=msg.lobby; notif(msg.name+' entrou na mesa'); if(document.getElementById('screen-wait').classList.contains('active')) send({type:'REQUEST_STATE'}); break;
    case 'PLAYER_LEFT':   waitLobby=msg.lobby; notif('Um jogador saiu.'); if(document.getElementById('screen-wait').classList.contains('active')) send({type:'REQUEST_STATE'}); break;
    case 'GAME_STATE':
      state=msg.state; myGameSeat=state.mySeat; isSolo=state.isSolo;
      checkNewBets(state.betsPlaced);
      checkBirdChange(state.birdHolder);
      closeOverlay('overlay-gameover'); showScreen('screen-game'); renderGame(); startAmbient();
      if(state.phase==='GAME_OVER') showGameOver();
      break;
    case 'RECONNECTED':
      myToken=sessionStorage.getItem('cap_token')||''; myLobbySeat=msg.seat;
      myGameSeat=msg.gameSeat!==undefined?msg.gameSeat:msg.seat; isSolo=msg.solo; isHost=msg.seat===0;
      notif('Reconectado!'); send({type:'REQUEST_STATE'}); break;
    case 'RECONNECT_FAIL': sessionStorage.removeItem('cap_token'); myToken=''; myName=''; showScreen('screen-name'); break;
    case 'OPPONENT_DISCONNECTED_GRACE': notif(msg.name+' desligou-se. '+Math.round(msg.graceMs/1000)+'s...',6000); break;
    case 'OPPONENT_RECONNECTED': notif(msg.name+' voltou!'); break;
    case 'OPPONENT_LEFT': notif('Um oponente saiu.',5000); break;
    case 'ERROR': notif('Erro: '+msg.text,4000); break;
  }
}

// Cache latest lobby data so we can render immediately when screen-lobby opens
let _cachedLobbies = [];
function renderLobbyList(lobbies){
  _cachedLobbies = lobbies;
  // Only switch to lobby screen if user has already entered their name
  if(myName) showScreen('screen-lobby');
  const el=document.getElementById('lobby-list'); if(!el) return; el.innerHTML='';
  lobbies.forEach(l=>{
    const full=l.full||l.playing;
    const status=l.playing?'A jogar':(l.seated>0?l.seated+'/'+l.maxHuman+' jog.':'Vazia');
    const bc=l.playing?'badge-orange':(l.seated>0?'badge-green':'badge-gray');
    const row=document.createElement('div'); row.className='lobby-row'+(full?' full':'');
    row.innerHTML='<div><div class="lobby-name">'+esc(l.name)+'</div>'+
      '<div class="lobby-meta">'+(l.solo?'Solo contra 2 IAs':'2 a 6 jogadores')+'</div></div>'+
      '<div style="display:flex;gap:8px;align-items:center"><span class="badge '+bc+'">'+status+'</span>'+
      '<button class="join-btn"'+(full?' disabled':'')+'>Entrar</button></div>';
    if(!full) row.querySelector('.join-btn').onclick=()=>send({type:'JOIN_LOBBY',lobbyId:l.id,playerName:myName});
    el.appendChild(row);
  });
}

function renderWaitRoom(msg){
  const lobby=msg.lobby||waitLobby; if(!lobby) return;
  document.getElementById('wait-title').textContent=lobby.name+' — A aguardar...';
  const pp=document.getElementById('wait-players'); pp.innerHTML='';
  (lobby.names||[]).forEach((name,i)=>{
    if(!name) return;
    const d=document.createElement('div'); d.className='wait-player'+(i===myLobbySeat?' me':'');
    d.textContent=name+(i===0?' (anfitrião)':'')+(i===myLobbySeat?' — tu':''); pp.appendChild(d);
  });
  const seated=(lobby.names||[]).filter(Boolean).length;
  if(isHost){
    document.getElementById('wait-host-area').style.display='block';
    document.getElementById('wait-guest-msg').style.display='none';
    const btn=document.getElementById('btn-start');
    btn.disabled=seated<2;
    btn.textContent='Iniciar Jogo ('+seated+' jogador'+(seated!==1?'es':'')+')';
  } else {
    document.getElementById('wait-host-area').style.display='none';
    document.getElementById('wait-guest-msg').style.display='block';
  }
}

function renderGame(){
  if(!state) return;
  const compact=isCompact();

  /* players bar */
  const bar=document.getElementById('players-bar'); bar.innerHTML='';
  state.players.forEach((p,i)=>{
    const chip=document.createElement('div');
    chip.className='player-chip'+(p.isMe?' me':'')+(p.hasBird?' bird':'');

    const nameDiv=document.createElement('div'); nameDiv.className='pname';
    nameDiv.textContent=p.name;
    if(p.isMe&&!compact){ const tu=document.createElement('span'); tu.style.cssText='color:var(--amber);font-size:.58rem'; tu.textContent=' (tu)'; nameDiv.appendChild(tu); }
    chip.appendChild(nameDiv);

    const ptsDiv=document.createElement('div'); ptsDiv.className='ppts';
    ptsDiv.textContent=p.pts;
    const ptsSub=document.createElement('span'); ptsSub.style.cssText='font-size:.65rem;font-weight:400;color:var(--muted)'; ptsSub.textContent=' pts';
    ptsDiv.appendChild(ptsSub); chip.appendChild(ptsDiv);

    const lilDiv=document.createElement('div'); lilDiv.className='plilies';
    if(p.lilies.length===0){ const dash=document.createElement('span'); dash.style.opacity='.35'; dash.textContent='—'; lilDiv.appendChild(dash); }
    else p.lilies.forEach(l=>{ const s=document.createElement('span'); s.style.cssText='color:'+LC[l]+';font-size:.9em'; s.title='Nenúfar '+LL[l]; s.textContent='●'; lilDiv.appendChild(s); });
    if(p.birdCards>0){
      const bc=document.createElement('span'); bc.className='bird-count'; bc.title='Cartas com pássaro';
      const bimg=document.createElement('img'); bimg.src='/bird-64.webp'; bimg.className='bird-pip'; bimg.alt='';
      bc.appendChild(bimg); bc.appendChild(document.createTextNode(p.birdCards));
      lilDiv.appendChild(bc);
    }
    chip.appendChild(lilDiv);

    const bs=state.phase==='BETTING'?(state.betsPlaced[i]?'Apostou':'A pensar...'):(state.phase==='REVEAL'&&state.betsPlaced[i]!=null?'Apostou':'[Zzz...]');
    const bsDiv=document.createElement('div'); bsDiv.className='pbet'; bsDiv.textContent=bs; chip.appendChild(bsDiv);

    bar.appendChild(chip);
  });

  /* table cards */
  const area=document.getElementById('table-cards'); area.innerHTML='';
  area.style.setProperty('--n-cards', state.n);
  area.style.setProperty('--n-half', Math.ceil(state.n/2)); // mesa em 2 linhas (só no compacto)
  (state.table||[]).forEach((card,pos)=>{
    const div=document.createElement('div');
    let cls='cap-card', extra='';
    if(state.phase==='REVEAL'&&state.lastResult){
      cls+=' reveal-card';
      const w=state.lastResult.winners;
      if(w&&w[pos]!==undefined){
        cls+=' won';
        extra='<div class="card-result-label win">'+esc(state.players[w[pos]].name)+'</div>';
      } else { cls+=' nobody'; extra='<div class="card-result-label nobody">Ninguém</div>'; }
    } else if(state.phase==='BETTING'&&state.myBet===pos){ cls+=' selected'; }

    // Compacto: faixa de uma linha só — nº de capivaras + bolinhas + pássaro.
    const lilyB=compact?lilyDots(card.lilies):card.lilies.map(l=>'<span class="lily '+LI[l]+'">'+LL[l]+'</span>').join('');
    const birdB=card.bird?(compact?'<img src="/bird-64.webp" class="bird-pip" alt="Pássaro" title="Pássaro">':'<span class="lily lily-bird">Pássaro</span>'):'';
    const capWord=compact?'':' '+(card.cap===1?'capivara':'capivaras');

    div.className=cls;
    div.innerHTML=
      cardArtHTML(card)+
      '<div class="card-pos-badge">'+String.fromCharCode(64+pos+1)+'</div>'+
      '<div class="card-info">'+
        '<div class="card-caps-count">'+card.cap+capWord+'</div>'+
        '<div class="card-badges">'+lilyB+birdB+'</div>'+
      '</div>'+extra;

    if(state.phase==='BETTING'&&state.myBet===null){
      div.onclick=()=>{ playDuck(); send({type:'BET',position:pos}); state.myBet=pos; renderGame(); };
    }
    area.appendChild(div);
  });

  /* status */
  const badge=document.getElementById('phase-badge'), text=document.getElementById('status-text'), cnt=document.getElementById('bet-count');
  badge.className='phase-badge phase-'+state.phase;
  if(state.phase==='BETTING'){
    badge.textContent='A Apostar';
    const placed=state.betsPlaced.filter(Boolean).length;
    cnt.textContent=placed+'/'+state.n+(compact?'':' apostas');
    const myL=state.myBet===null?'':String.fromCharCode(64+state.myBet+1);
    if(compact) text.textContent=state.myBet===null?'Escolhe uma carta':'Apostaste na '+myL+' — à espera dos outros';
    else text.textContent=state.myBet===null?'Escolhe uma carta para apostar':'Apostaste na carta '+myL+' — a aguardar os outros...';
  } else if(state.phase==='REVEAL'){
    badge.textContent='Revelação'; cnt.textContent='';
    const bu=state.lastResult&&state.lastResult.birdUpdate;
    if(bu){if(bu.type==='first')text.textContent=bu.name+' recebeu o token do pássaro!';else if(bu.type==='steal')text.textContent=bu.name+' destronou '+bu.fromName+' e ficou com o token!';else if(bu.type==='tie_first')text.textContent='Empate! O token do pássaro fica na mesa.';else if(bu.type==='tie_steal')text.textContent='Empate! O token do pássaro mantém-se com o detentor atual.';}
    else { const w=Object.keys((state.lastResult&&state.lastResult.winners)||{}).length; text.textContent=w>0?w+' carta'+(w!==1?'s':'')+' recolhida'+(w!==1?'s':'')+'!':'Ninguém ganhou — todos empataram!'; }
  } else { badge.textContent='Fim do Jogo'; text.textContent='A contabilizar pontos...'; cnt.textContent=''; }

  /* my scored */
  const sc=document.getElementById('my-scored'); sc.innerHTML='';
  const me=state.players[myGameSeat];
  if(!me||me.scored.length===0){
    const empty=document.createElement('div'); empty.style.cssText='color:var(--muted);font-size:.82rem;padding:4px 0';
    empty.textContent='Ainda sem cartas recolhidas.'; sc.appendChild(empty);
  } else me.scored.forEach(mc=>{
    const wrap=document.createElement('div'); wrap.className='mini-card';
    // art
    const artImg=document.createElement('img'); artImg.className='mini-card-art';
    artImg.src='/cards/'+mc.img+'.webp'; artImg.alt='';
    artImg.onerror=function(){ this.style.display='none'; this.nextElementSibling.style.display='flex'; };
    const artFb=document.createElement('div'); artFb.className='mini-card-art fallback'; artFb.style.display='none'; artFb.textContent=mc.cap;
    wrap.appendChild(artImg); wrap.appendChild(artFb);
    // label
    const lbl=document.createElement('div'); lbl.className='mini-card-label';
    const capWord=mc.cap===1?'capivara':'capivaras';
    lbl.textContent=mc.cap+(compact?'':' '+capWord);
    if(compact){ lbl.insertAdjacentHTML('beforeend',' '+lilyDots(mc.lilies)+(mc.bird?' <img src="/bird-64.webp" class="bird-pip" alt="Pássaro" style="width:11px;height:11px;vertical-align:-1px">':'')); }
    else if(mc.lilies.length||mc.bird){
      const badges=document.createElement('div'); badges.className='mini-card-badges';
      mc.lilies.forEach(l=>{ const s=document.createElement('span'); s.className='mini-lily lily-'+l; s.textContent=LL[l]; badges.appendChild(s); });
      if(mc.bird){ const b=document.createElement('span'); b.className='mini-lily lily-bird'; b.textContent='Pássaro'; badges.appendChild(b); }
      lbl.appendChild(badges);
    }
    wrap.appendChild(lbl);
    sc.appendChild(wrap);
  });

  /* bird token */
  const bt=document.getElementById('bird-token-display');
  if(state.birdHolder===null){ bt.innerHTML='<img src="/bird-64.webp" class="bird-pip big" alt=""> '+(compact?'sem dono':'Pássaro — sem detentor'); bt.className='bird-token'; }
  else { const h=state.players[state.birdHolder]; bt.innerHTML='<img src="/bird-64.webp" class="bird-pip big" alt=""> '+(h?esc(h.name):'?')+' ('+state.birdHolderCards+'x)'; bt.className='bird-token has-holder'; }

  /* deck */
  const deck=document.getElementById('deck-info'), pass=state.deckPass===0?'1.ª':'2.ª';
  deck.textContent=compact?pass+' · '+state.deckLeft+' cartas':pass+' passagem — '+state.deckLeft+' cartas';
  deck.title=pass+' passagem — '+state.deckLeft+' cartas no baralho';
}

function showGameOver(){
  const el=document.getElementById('final-scores'); el.innerHTML='';
  (state.finalScores||state.players).forEach((s,i)=>{
    const isW=i===state.winnerIdx;
    const d=[];
    if(s.birdCards>0) d.push('Pássaro ×'+s.birdCards);
    if(s.hasBird) d.push('+5 token');
    if(s.allLilies) d.push('+10 quatro nenúfares!');
    const row=document.createElement('div'); row.className='score-row';
    row.innerHTML=
      '<div>'+
        '<div class="score-name">'+esc(s.name)+(isW?' <span class="winner-badge">Vencedor</span>':'')+'</div>'+
        '<div class="score-detail">'+(d.join(' · ')||'só capivaras')+'</div>'+
      '</div>'+
      '<div class="score-pts">'+s.pts+' pts</div>';
    el.appendChild(row);
  });
  document.getElementById('btn-restart').style.display=(isSolo||isHost)?'inline-flex':'none';
  openOverlay('overlay-gameover');
}

// ── TUTORIAL (tour guiado) ───────────────────────────────────────────────────
// Corre 100% no cliente, sem servidor nem mesas reais: o estado fictício é
// construído com as MESMAS funções do motor (computeScores/buildView/resolveBets, injetadas
// abaixo a partir do servidor) e desenhado pelo renderGame() real. Enquanto
// está ativo, send() desvia as ações para tutHandle() e handleMsg() ignora o
// servidor. Os bots jogam de forma roteirizada (tutBotChoice).
${computeScores.toString()}
${buildView.toString()}
${resolveBets.toString()}

const TUT_DONE_KEY='cap_tut_done', TUT_HINT_KEY='cap_tut_hint_off';
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

const tut={ active:false, step:0, from:'screen-name', g:null, saved:null, timers:[], tick:null, thinking:false };
let _joinSoloOnConnect=false;

// Mesma forma que mkCard() no servidor.
function tutCard(cap,lilies,bird){
  const l=[...lilies].sort().join('');
  return { cap, lilies, bird, img:'cap'+cap+(l?'_'+l:'')+(bird?'_bird':''), fallback:'cap'+cap };
}
// Ronda 1: três valores diferentes (4, 2+pássaro, 3) — os bots vão os dois à
// carta mais valiosa que tu não escolheste, por isso tu ganhas sempre a tua e
// eles chocam (mostra "sozinho" e "empate" na mesma ronda).
// Ronda 2: Bot 1 → A (pássaro), Bot 2 → C (nenúfar Branco); B fica livre.
const TUT_TABLES=[
  [tutCard(4,[],false), tutCard(2,['Y'],true), tutCard(3,['B'],false)],
  [tutCard(3,[],true),  tutCard(1,['R'],false), tutCard(2,['W'],false)],
];
// "Resto do jogo" imaginado para o ecrã final (sem pássaros, para não mexer no token).
const TUT_EXTRA=[
  [tutCard(1,['B','W'],false), tutCard(2,['Y'],false), tutCard(1,['R'],false), tutCard(3,[],false), tutCard(5,[],false)],
  [tutCard(4,[],false), tutCard(3,[],false), tutCard(2,[],false), tutCard(3,['Y'],false)],
  [tutCard(2,[],false), tutCard(3,['B'],false), tutCard(4,[],false), tutCard(1,[],false)],
];
function tutClone(c){ return { ...c, lilies:[...c.lilies] }; }

// Espelho de newGame() para a Mesa Solo (3 jogadores, 36 cartas).
function tutNewGame(name){
  return {
    players: [name,'Bot-capi 1','Bot-capi 2'].map(n=>({ name:n, scored:[], birdCards:0 })),
    n:3, deck:new Array(33).fill(null), discard:[], table:TUT_TABLES[0].map(tutClone),
    bets:[null,null,null], birdHolder:null, birdTie:0,
    phase:'BETTING', deckPass:0, lastResult:null,
    isSolo:true, turnGen:0, winnerIdx:null, finalScores:null, round:0,
  };
}

// A resolução é a do próprio motor (resolveBets, injetada acima).
function tutResolve(){ resolveBets(tut.g); tutRender(); }

// Espelho de nextRound().
function tutNextRound(){
  const g=tut.g;
  g.deck.splice(0,g.n); g.table=TUT_TABLES[1].map(tutClone); g.bets=new Array(g.n).fill(null);
  g.lastResult=null; g.phase='BETTING'; g.turnGen++; g.round=1;
  tutRender();
}

// Salta para o fim: junta o "resto do jogo" e aplica endGame().
function tutGameOver(){
  const g=tut.g; if(g.phase==='GAME_OVER') return;
  g.players.forEach((p,i)=>TUT_EXTRA[i].forEach(c=>p.scored.push(tutClone(c))));
  g.deck=[]; g.deckPass=1; g.phase='GAME_OVER'; g.finalScores=computeScores(g);
  const maxPts=Math.max(...g.finalScores.map(s=>s.pts));
  g.winnerIdx=g.finalScores.findIndex(s=>s.pts===maxPts);
  tutRender(); showGameOver();
}

// Mesmo tratamento que um GAME_STATE vindo do servidor (sons incluídos).
function tutRender(){
  state=buildView(tut.g,0);
  checkNewBets(state.betsPlaced); checkBirdChange(state.birdHolder);
  renderGame();
}

function tutBotChoice(seat){
  const g=tut.g;
  if(g.round===0){
    let best=-1;
    g.table.forEach((c,p)=>{ if(p!==g.bets[0]&&(best<0||c.cap>g.table[best].cap)) best=p; });
    return best;
  }
  return seat===1?0:2;
}

function tutLater(fn,ms){ tut.timers.push(setTimeout(fn,ms)); }
function tutBotTurn(seat){
  const g=tut.g;
  if(g.bets[seat]!==null){ tut.thinking=false; return; }
  tut.thinking=true;
  tutLater(()=>{ tut.thinking=false; g.bets[seat]=tutBotChoice(seat); tutRender(); tutRenderCoach(); }, 1500);
}

// ── Handler local das ações (substitui o servidor) ──
function tutHandle(msg){
  if(msg.type==='BET') tutBet(parseInt(msg.position));
  // "Sair" do jogo / "Voltar ao Lobby": o handler original ainda corre depois
  // deste send(), por isso saímos no próximo tick para repor o ecrã de origem.
  else if(msg.type==='LEAVE_LOBBY') setTimeout(()=>tutExit(),0);
}
function tutBet(pos){
  const g=tut.g;
  if(!g||g.phase!=='BETTING'||g.bets[0]!==null||isNaN(pos)||pos<0||pos>=g.n) return;
  g.bets[0]=pos; tutRender();
  const betStep=tutIdx(g.round===0?'aposta1':'aposta2');
  // Adiantou-se na ronda 1 → salta para a vez dos bots; na ronda 2 o passo da aposta é saltado mais tarde.
  if(g.round===0&&tut.step<=betStep) tutGo(betStep+1);
  else if(tut.step===betStep) tutNext();
  else tutRenderCoach();
}
function tutShortcut(pos){ playDuck(); send({type:'BET',position:pos}); }

// ── Textos ──
function tutLetter(pos){ return String.fromCharCode(65+pos); }
function tutWho(seat){ return seat===0?'Tu':esc(tut.g.players[seat].name); }
function tutCapWord(n){ return n+' '+(n===1?'capivara':'capivaras'); }

function tutBotText(seat){
  const g=tut.g, nm='<b>'+esc(g.players[seat].name)+'</b>';
  const pre=(g.round===1&&seat===1)?'<b>Ronda 2</b> — cartas novas na mesa, e desta vez os bots vão primeiro. ':'';
  if(tut.thinking) return pre+nm+' está a decidir. Repara no painel dele, destacado: diz “A pensar...”.';
  const placed=g.bets.filter(b=>b!==null).length;
  return pre+nm+' apostou! O painel passou a “Apostou” e o contador está em <b>'+placed+'/3 apostas</b>. '+
    'Em que carta? Segredo — só se sabe quando todos tiverem apostado.'+
    (placed===3?' Já estão as 3 apostas: vamos à revelação!':'');
}

function tutRevealText(){
  const g=tut.g, r=g.lastResult; if(!r) return '';
  const lines=r.cards.map((c,pos)=>{
    const who=[0,1,2].filter(s=>r.bets[s]===pos);
    const cn='<b>'+tutLetter(pos)+'</b> ('+tutCapWord(c.cap)+')';
    if(who.length===1) return who[0]===0?'✅ Ficaste sozinho na carta '+cn+' — <b>é tua!</b>':'✅ '+tutWho(who[0])+' ficou sozinho na carta '+cn+' e ganhou-a.';
    if(who.length>1) return '💨 Carta '+cn+': '+who.map(tutWho).join(' e ')+' escolheram-na — as capivaras fugiram, <b>ninguém</b> a ganha e vai para o descarte.';
    return '▫️ Ninguém apostou na carta '+cn+' — vai para o descarte.';
  });
  const bu=r.birdUpdate;
  if(bu){
    if(bu.type==='first') lines.push('🐦 '+(bu.seat===0?'Foste o primeiro':esc(bu.name)+' foi o primeiro')+' a apanhar uma carta com pássaro: '+(bu.seat===0?'ficas':'fica')+' com o <b>token do pássaro</b> (+5).');
    else if(bu.type==='steal') lines.push('🐦 '+tutWho(bu.seat)+' passou a ter mais cartas com pássaro e roubou o token!');
    else if(bu.type==='tie_first') lines.push('🐦 Empate nas cartas com pássaro — o token fica na mesa até alguém ter mais cartas com pássaro do que '+bu.seats.map(x=>x===0?'tu':tutWho(x)).join(' e ')+'.');
    else lines.push('🐦 Empate entre os jogadores que passaram o detentor — o token não se mexe.');
  }
  let why;
  if(g.round===0) why='🤖 Os dois bots foram atrás da carta mais valiosa que sobrava. Pensaram o mesmo… e chocaram. A carta óbvia é arriscada!';
  else if(r.bets[0]===0||r.bets[0]===2) why='🤖 Bot 1 queria o pássaro (A) e Bot 2 o nenúfar Branco (C). Escolheste a mesma carta que um deles — por isso ninguém a levou.';
  else why='🤖 Bot 1 foi ao pássaro (A) e Bot 2 ao nenúfar Branco (C). Ficaste com a carta que ninguém quis: às vezes a carta pequena é a jogada certa.';
  return '<div class="tut-lines">'+lines.map(l=>'<div>'+l+'</div>').join('')+'<div>'+why+'</div></div>';
}

function tutPointsText(){
  const me=state.players[0];
  return 'As cartas ganhas vão para <b>as tuas capivaras</b> (em baixo) e os pontos dos painéis atualizam logo: tens agora <b>'+me.pts+' pts</b>. '+
    'Cada capivara na carta vale 1 ponto.'+(me.hasBird?' Esse total já inclui os <b>+5</b> do token do pássaro.':'')+
    ' Os bots não ganharam nada nesta ronda.';
}

function tutBirdText(){
  const g=tut.g, h=g.birdHolder;
  let t;
  if(h===null) t='Ainda ninguém tem o <b>token do pássaro</b>. Fica com ele o primeiro jogador a ganhar sozinho uma carta com pássaro (se dois o conseguirem na mesma ronda, fica na mesa até um jogador ter mais cartas com pássaro do que eles).';
  else {
    const k=g.players[h].birdCards;
    t=(h===0?'<b>Tens</b>':'<b>'+esc(g.players[h].name)+'</b> tem')+' o token do pássaro, com '+k+' carta'+(k!==1?'s':'')+' com pássaro. Vale <b>+5 pontos</b>.';
    const eq=[0,1,2].filter(i=>i!==h&&g.players[i].birdCards===k);
    if(eq.length) t+=' Repara: '+(eq.length===1&&eq[0]===0?'tu também tens':eq.map(tutWho).join(' e ')+' também '+(eq.length>1?'têm':'tem'))+' '+k+' — empatar não chega, por isso o token não saiu do sítio.';
  }
  return t+' Para <b>roubar</b> o token é preciso ter <b>mais</b> cartas com pássaro do que o detentor atual.';
}

function tutFinalText(){
  const g=tut.g, me=g.finalScores[0];
  const caps=me.scored.reduce((a,c)=>a+c.cap,0);
  let t='Imaginámos o resto do jogo (juntámos algumas cartas a cada um). A tua conta: <b>'+caps+'</b> das capivaras';
  if(me.allLilies) t+=' + <b>10</b> das 4 cores de nenúfar';
  if(me.hasBird) t+=' + <b>5</b> do token do pássaro';
  t+=' = <b>'+me.pts+' pts</b>. ';
  t+=g.winnerIdx===0?'Ganhaste! 🎉':esc(g.finalScores[g.winnerIdx].name)+' ganhou.';
  return t+' Se houver empate no topo, ganha o primeiro jogador da lista com essa pontuação.';
}

// ── Passos ──
// mode: 'next' (botão Seguinte), 'bet' (espera pela aposta real), 'bot' (bot joga
// com atraso), 'final'. queue: fila de chips com a ordem da ronda.
const TUT_Q1=[0,1,2], TUT_Q2=[1,2,0];
const TUT_STEPS=[
  { id:'bemvindo', title:'Bem-vindo ao Capivaras! 🐹',
    text:'A ideia em 10 segundos: em cada ronda há na mesa <b>tantas cartas quantos jogadores</b>. Todos escolhem <b>uma carta em segredo</b> e as apostas revelam-se ao mesmo tempo.<ul><li><b>Sozinho</b> numa carta? É tua.</li><li><b>Com mais alguém?</b> As capivaras fogem e ninguém a ganha.</li></ul>Vamos jogar duas rondas de treino contra dois bots. Nada disto conta.' },
  { id:'entrar', title:'Como se entra num jogo',
    text:'No ecrã inicial escreves o teu nome e escolhes uma mesa no lobby: <b>Mesa 1 a 5</b> para jogar com amigos (2 a 6 jogadores; o anfitrião carrega em “Iniciar Jogo”) ou <b>Mesa Solo</b>, contra 2 IAs, que começa logo. Este treino imita a Mesa Solo.' },
  { id:'jogadores', title:'Os jogadores', target:['#players-bar'],
    text:'Aqui estás tu (contorno laranja) e os adversários. Cada painel mostra os <b>pontos</b>, as <b>cores de nenúfar</b> já apanhadas, as <b>cartas com pássaro</b> e se já apostou (“A pensar...” ou “Apostou”).' },
  { id:'topo', title:'Pássaro e baralho', target:['#bird-token-display','#deck-info'],
    text:'Aqui vês quem tem o <b>token do pássaro</b> (+5 pontos) e, no computador, quantas cartas restam no baralho.' },
  { id:'mesa', title:'A mesa', target:['#table-cards .cap-card'],
    text:'Cada ronda traz <b>3 cartas</b> — uma por jogador — marcadas A, B e C. O número de capivaras é o que a carta vale em pontos. Algumas têm <b>nenúfares</b> coloridos, outras um <b>pássaro</b> amarelo.' },
  { id:'estado', title:'A barra de estado', target:['.status-bar'],
    text:'Diz a fase (<b>A Apostar</b> ou <b>Revelação</b>), o que tens de fazer e quantas apostas já foram feitas.' },
  { id:'minhas', title:'As tuas capivaras', target:['.my-area'],
    text:'As cartas que ganhas ficam aqui. É desta fila que saem os teus pontos e as tuas cores de nenúfar.' },
  { id:'regras', title:'Regras sempre à mão', target:['.rules-panel','#btn-rules-game'],
    text:()=>isCompact()?'Durante o jogo, o botão 📖 abre as regras sempre que quiseres.':'Durante o jogo podes abrir este painel para rever as regras sempre que quiseres.' },
  { id:'ordem1', title:'Quem joga quando?', target:['#players-bar'], queue:{ order:TUT_Q1, fresh:true },
    text:'No Capivaras <b>não há turnos</b>: todos apostam ao mesmo tempo, em segredo, e a ronda só se resolve quando toda a gente apostou. Neste treino vamos <b>um de cada vez</b> para veres cada passo — primeiro tu, depois cada bot:' },
  { id:'aposta1', mode:'bet', title:'A tua aposta', target:['#table-cards .cap-card'], queue:{ order:TUT_Q1 },
    text:'Toca numa carta para apostar nela (ou usa os atalhos aqui em baixo). A aposta é <b>imediata</b> e não dá para voltar atrás.' },
  { id:'bot1r1', mode:'bot', seat:1, title:'Vez do Bot-capi 1', target:['#players-bar .player-chip:nth-child(2)'], queue:{ order:TUT_Q1 },
    onEnter:()=>tutBotTurn(1), text:()=>tutBotText(1) },
  { id:'bot2r1', mode:'bot', seat:2, title:'Vez do Bot-capi 2', target:['#players-bar .player-chip:nth-child(3)'], queue:{ order:TUT_Q1 },
    onEnter:()=>tutBotTurn(2), text:()=>tutBotText(2) },
  { id:'revela1', title:'Revelação!', target:['#table-cards .cap-card'],
    onEnter:()=>{ if(tut.g.phase==='BETTING') tutResolve(); }, text:()=>tutRevealText() },
  { id:'pontos1', title:'Pontos ganhos', target:['#players-bar','.my-area'], text:()=>tutPointsText() },
  { id:'ordem2', title:'E a ronda seguinte?', target:['#players-bar'], queue:{ order:TUT_Q2, fresh:true },
    text:'Depois da revelação há uma pausa de uns segundos e a ronda seguinte começa sozinha. Ninguém passa a ser “primeiro jogador” — como ninguém vê as apostas dos outros, apostar mais cedo ou mais tarde <b>não dá vantagem</b>. Para o provar, na ronda 2 os bots apostam primeiro:' },
  { id:'bot1r2', mode:'bot', seat:1, title:'Vez do Bot-capi 1', target:['#players-bar .player-chip:nth-child(2)'], queue:{ order:TUT_Q2 },
    onEnter:()=>{ if(tut.g.round===0) tutNextRound(); tutBotTurn(1); }, text:()=>tutBotText(1) },
  { id:'bot2r2', mode:'bot', seat:2, title:'Vez do Bot-capi 2', target:['#players-bar .player-chip:nth-child(3)'], queue:{ order:TUT_Q2 },
    onEnter:()=>tutBotTurn(2), text:()=>tutBotText(2) },
  { id:'aposta2', mode:'bet', title:'A tua vez (ronda 2)', target:['#table-cards .cap-card'], queue:{ order:TUT_Q2 },
    skip:()=>tut.g.bets[0]!==null,
    text:'Os dois bots já apostaram — vês “Apostou” nos painéis, mas não em que carta. É exatamente assim num jogo a sério. Qual escolhes?' },
  { id:'revela2', title:'Revelação da ronda 2', target:['#table-cards .cap-card'],
    onEnter:()=>{ if(tut.g.phase==='BETTING') tutResolve(); }, text:()=>tutRevealText() },
  { id:'passaro', title:'O token do pássaro', target:['#bird-token-display','#players-bar'], text:()=>tutBirdText() },
  { id:'nenufares', title:'Os nenúfares', target:['#players-bar','.my-area'],
    text:'Há nenúfares de quatro cores: <b>Amarelo, Vermelho, Branco e Azul</b>. Junta as quatro nas cartas que ganhas (podem estar em cartas diferentes) e ganhas <b>+10 pontos</b>. As bolinhas coloridas nos painéis mostram as cores que cada um já tem.' },
  { id:'fim', title:'Quando acaba o jogo?', target:['.game-header'], next:'Ver o fim do jogo',
    text:'O baralho tem 36 cartas e joga-se <b>duas vezes</b>: quando acaba, as cartas que ninguém ganhou são baralhadas e voltam (as que foram ganhas ficam com os donos); quando acaba pela segunda vez, o jogo termina e contam-se os pontos. Vamos saltar para o fim de um jogo imaginário.' },
  { id:'pontuacao', title:'Pontuação final', target:['#final-scores'],
    onEnter:()=>tutGameOver(), text:()=>tutFinalText() },
  { id:'dicas', mode:'final', title:'Pronto para jogar! 🎓',
    onEnter:()=>{ lsSet(TUT_DONE_KEY,'1'); updateTutHints(); },
    text:'Algumas dicas:<ul><li>Vê que cores de nenúfar te faltam — uma carta pequena pode valer +10.</li><li>A carta mais valiosa é a mais óbvia: se todos a quiserem, ninguém a leva.</li><li>Conta as cartas com pássaro de cada um antes de tentar roubar o token.</li></ul>' },
];
function tutIdx(id){ return TUT_STEPS.findIndex(s=>s.id===id); }

// ── Motor do tour ──
function tutTargets(){
  const s=TUT_STEPS[tut.step]; if(!s||!s.target) return [];
  return s.target.flatMap(sel=>[...document.querySelectorAll(sel)]).filter(el=>{
    const r=el.getBoundingClientRect(); return r.width>0&&r.height>0;
  });
}

function tutQueueHTML(q){
  const g=tut.g, cur=!q.fresh&&g.phase==='BETTING';
  const now=cur?q.order.find(s=>g.bets[s]===null):undefined;
  return '<div class="tut-queue">'+q.order.map((s,i)=>{
    const done=cur&&g.bets[s]!==null;
    return (i?'<span class="tut-qarrow">→</span>':'')+
      '<span class="tut-qchip'+(s===now?' now':'')+(done?' done':'')+'">'+(done?'✓ ':'')+tutWho(s)+'</span>';
  }).join('')+'</div>';
}

function tutRenderCoach(){
  const c=document.getElementById('tut-coach'), s=TUT_STEPS[tut.step], g=tut.g;
  let h='<div class="tut-title">'+s.title+'</div><div class="tut-text">'+(typeof s.text==='function'?s.text():s.text)+'</div>';
  if(s.queue) h+=tutQueueHTML(s.queue);
  if(s.mode==='bot'&&tut.thinking) h+='<div class="tut-thinking">⏳ a pensar…</div>';
  // Atalho no próprio balão: em ecrãs pequenos o balão pode tapar as cartas.
  if(s.mode==='bet'&&g.phase==='BETTING'&&g.bets[0]===null)
    h+='<div class="tut-shortcuts">'+g.table.map((cd,p)=>'<button class="btn btn-outline btn-sm" onclick="tutShortcut('+p+')">'+tutLetter(p)+' · '+cd.cap+' cap.</button>').join('')+'</div>';
  h+='<div class="tut-progress"><div style="width:'+Math.round((tut.step+1)/TUT_STEPS.length*100)+'%"></div></div>';
  h+='<div class="tut-actions">';
  if(s.mode==='final'){
    h+='<div class="tut-final"><button class="btn btn-primary btn-sm" onclick="tutPlayForReal()">Jogar contra a IA</button>'+
       '<button class="btn btn-outline btn-sm" onclick="tutExit(myName?&quot;screen-lobby&quot;:&quot;screen-name&quot;)">'+(myName?'Voltar ao lobby':'Voltar ao início')+'</button></div>';
  } else {
    h+='<button class="tut-exit" onclick="tutExit()">Sair do tutorial</button><span class="tut-count">'+(tut.step+1)+'/'+TUT_STEPS.length+'</span>';
    if(s.mode!=='bet') h+='<button class="btn btn-primary btn-sm" onclick="tutNext()"'+(s.mode==='bot'&&tut.thinking?' disabled':'')+'>'+(s.next||'Seguinte')+' →</button>';
  }
  c.innerHTML=h+'</div>';
  tutPlace();
}

// Spotlight + posição do balão (por baixo ou por cima do alvo; centrado se não houver).
function tutPlace(){
  if(!tut.active) return;
  const vw=window.innerWidth, vh=window.innerHeight, pad=6, m=12;
  const rects=tutTargets().map(el=>{ const r=el.getBoundingClientRect(); return { x:r.left-pad, y:r.top-pad, w:r.width+pad*2, h:r.height+pad*2 }; });
  const holes=rects.map(r=>'<rect x="'+r.x+'" y="'+r.y+'" width="'+r.w+'" height="'+r.h+'" rx="14" fill="black"/>').join('');
  document.getElementById('tut-spot').innerHTML=
    '<svg><defs><mask id="tut-mask"><rect width="100%" height="100%" fill="white"/>'+holes+'</mask></defs>'+
    '<rect width="100%" height="100%" fill="rgba(46,26,10,.55)" mask="url(#tut-mask)"/></svg>'+
    rects.map(r=>'<div class="tut-ring" style="left:'+r.x+'px;top:'+r.y+'px;width:'+r.w+'px;height:'+r.h+'px"></div>').join('');
  const c=document.getElementById('tut-coach');
  c.style.width=''; c.style.maxHeight='';
  let cw=c.offsetWidth, ch=c.offsetHeight;
  const clampX=x=>Math.max(m,Math.min(x,vw-cw-m)), clampY=y=>Math.max(m,Math.min(y,vh-ch-m));
  let top, left;
  if(!rects.length){ top=(vh-ch)/2; left=(vw-cw)/2; }
  else {
    const u=tutUnion(rects);
    // Candidatos por ordem de preferência: por baixo/por cima de todos os alvos,
    // depois de cada alvo, depois ao lado. Fica o primeiro que cabe sem tapar nenhum alvo.
    const cands=[];
    [u,...(rects.length>1?rects:[])].forEach(r=>{
      const cx=clampX(r.x+r.w/2-cw/2);
      cands.push([r.y+r.h+8,cx],[r.y-ch-8,cx]);
    });
    cands.push([clampY(u.y+u.h/2-ch/2),u.x+u.w+8],[clampY(u.y+u.h/2-ch/2),u.x-cw-8]);
    const ok=([t,l])=>t>=m&&t+ch<=vh-m&&l>=m&&l+cw<=vw-m&&
      rects.every(r=>t+ch<=r.y||t>=r.y+r.h||l+cw<=r.x||l>=r.x+r.w);
    let hit=cands.find(ok);
    if(!hit){ // mais estreito (telemóvel): ao lado dos alvos, ou por baixo/por cima de um alvo com a largura dele
      const maxW=cw, sL=u.x-m*2, sR=vw-u.x-u.w-m*2;
      const narrow=[[Math.min(maxW,Math.max(sL,sR)), ()=>[clampY(u.y+u.h/2-ch/2), sR>=sL?u.x+u.w+8:u.x-cw-8]]];
      if(rects.length>1) rects.forEach(r=>{
        // largura do alvo (dentro do ecrã), menos folga para não tocar nos alvos vizinhos
        const w=Math.min(maxW,Math.min(r.x+r.w,vw-m)-Math.max(r.x,m)-20), cx=()=>clampX(r.x+r.w/2-cw/2);
        narrow.push([w,()=>[r.y+r.h+8,cx()]],[w,()=>[r.y-ch-8,cx()]]);
      });
      for(const [w,pos] of narrow){
        if(w<240) continue;
        c.style.width=w+'px'; cw=c.offsetWidth; ch=c.offsetHeight;
        const p=pos(); if(ok(p)){ hit=p; break; }
      }
      if(!hit){ c.style.width=''; cw=c.offsetWidth; ch=c.offsetHeight; }
    }
    if(!hit){ // mais baixo, com scroll interno (os botões ficam fixos em baixo), no lado com mais espaço
      const below=vh-m-(u.y+u.h+8), above=u.y-8-m, sp=Math.floor(Math.max(below,above));
      if(sp>=180){
        c.style.maxHeight=sp+'px'; ch=c.offsetHeight;
        const p=[below>=above?u.y+u.h+8:u.y-ch-8, clampX(u.x+u.w/2-cw/2)];
        if(ok(p)) hit=p; else { c.style.maxHeight=''; ch=c.offsetHeight; }
      }
    }
    if(!hit){ // não cabe em lado nenhum sem tapar: fica onde tapa menos área dos alvos
      const cover=([t,l])=>rects.reduce((a,r)=>a+Math.max(0,Math.min(t+ch,r.y+r.h)-Math.max(t,r.y))*Math.max(0,Math.min(l+cw,r.x+r.w)-Math.max(l,r.x)),0);
      const all=[...cands,[m,u.x+u.w/2-cw/2],[vh-ch-m,u.x+u.w/2-cw/2]].map(([t,l])=>[clampY(t),clampX(l)]);
      hit=all.reduce((b,c)=>cover(c)<cover(b)?c:b);
    }
    top=hit[0]; left=hit[1];
  }
  c.style.top=Math.round(clampY(top))+'px';
  c.style.left=Math.round(clampX(left))+'px';
}
function tutUnion(rects){
  const x0=Math.min(...rects.map(r=>r.x)), y0=Math.min(...rects.map(r=>r.y));
  const x1=Math.max(...rects.map(r=>r.x+r.w)), y1=Math.max(...rects.map(r=>r.y+r.h));
  return { x:x0, y:y0, w:x1-x0, h:y1-y0 };
}

function tutClearTimers(){ tut.timers.forEach(clearTimeout); tut.timers=[]; tut.thinking=false; }

function tutGo(i){
  tutClearTimers();
  while(i<TUT_STEPS.length-1&&TUT_STEPS[i].skip&&TUT_STEPS[i].skip()) i++;
  tut.step=i;
  const s=TUT_STEPS[i];
  if(s.onEnter) s.onEnter();
  tutRenderCoach();
  tutScroll();
}
// Traz os alvos para o ecrã: se alvos + balão cabem juntos, centra esse bloco
// (deixa espaço para o balão por baixo); senão centra o primeiro alvo.
function tutScroll(){
  const els=tutTargets();
  if(!els.length){ window.scrollTo({ top:0, behavior:'smooth' }); return; }
  if(els[0].closest('.overlay')) return;
  const u=tutUnion(els.map(el=>{ const r=el.getBoundingClientRect(); return { x:r.left, y:r.top, w:r.width, h:r.height }; }));
  const ch=document.getElementById('tut-coach').offsetHeight, vh=window.innerHeight;
  if(u.h+ch+40<=vh) window.scrollTo({ top:window.scrollY+u.y-(vh-(u.h+ch+16))/2, behavior:'smooth' });
  else els[0].scrollIntoView({ block:'center', behavior:'smooth' });
}
function tutNext(){ if(tut.active&&tut.step<TUT_STEPS.length-1) tutGo(tut.step+1); }

function tutStart(){
  if(tut.active) return;
  const cur=document.querySelector('.screen.active');
  tut.from=cur?cur.id:'screen-name';
  tut.saved={ state, myGameSeat, isSolo, isHost };
  const nm=myName||document.getElementById('inp-name').value.trim().slice(0,20)||'Jogador';
  tut.g=tutNewGame(nm); tut.active=true;
  // isSolo/isHost a false esconde o "Jogar Novamente" do ecrã final (não há servidor para o reiniciar).
  myGameSeat=0; isSolo=false; isHost=false; _prevBetCount=-1; _prevBirdHolder=-99;
  closeOverlay('overlay-gameover'); showScreen('screen-game'); window.scrollTo(0,0);
  tutRender();
  document.getElementById('tut-spot').classList.add('active');
  document.getElementById('tut-coach').classList.add('active');
  window.addEventListener('resize',tutPlace); window.addEventListener('scroll',tutPlace,{passive:true});
  tut.tick=setInterval(tutPlace,250);
  tutGo(0);
}

// Limpa todo o estado local e volta ao ecrã de onde se veio (ou a dest).
function tutExit(dest){
  if(!tut.active) return;
  tut.active=false; tutClearTimers(); clearInterval(tut.tick); tut.tick=null;
  window.removeEventListener('resize',tutPlace); window.removeEventListener('scroll',tutPlace);
  ['tut-spot','tut-coach'].forEach(id=>{ const e=document.getElementById(id); e.classList.remove('active'); e.innerHTML=''; });
  closeOverlay('overlay-gameover');
  state=tut.saved.state; myGameSeat=tut.saved.myGameSeat; isSolo=tut.saved.isSolo; isHost=tut.saved.isHost;
  tut.g=null; tut.saved=null; _prevBetCount=-1; _prevBirdHolder=-99;
  ['players-bar','table-cards','my-scored','final-scores'].forEach(id=>{ document.getElementById(id).innerHTML=''; });
  const to=dest||tut.from;
  showScreen(to); window.scrollTo(0,0); updateTutHints();
  if(to==='screen-lobby'){ renderLobbyList(_cachedLobbies); send({type:'LOBBIES'}); }
}

function tutPlayForReal(){
  if(!myName){ const v=document.getElementById('inp-name').value.trim(); if(v) myName=v.slice(0,20); }
  if(!myName){ tutExit('screen-name'); document.getElementById('inp-name').focus(); notif('Escreve o teu nome para jogar na Mesa Solo!'); return; }
  tutExit('screen-lobby');
  if(ws&&ws.readyState===1) send({type:'JOIN_LOBBY',lobbyId:'solo',playerName:myName});
  else { _joinSoloOnConnect=true; connect(); }
}

// Aviso de primeira visita (até o tutorial ser concluído ou dispensado).
function updateTutHints(){
  const show=!lsGet(TUT_DONE_KEY)&&!lsGet(TUT_HINT_KEY);
  document.querySelectorAll('[data-tut-hint]').forEach(el=>{
    el.classList.toggle('show',show);
    if(show&&!el.innerHTML) el.innerHTML=
      '<div class="tut-hint-text"><b>Primeira vez por aqui?</b> Aprende a jogar em 2 minutos, com uma ronda de treino contra bots.</div>'+
      '<button class="btn btn-primary btn-sm" onclick="tutStart()">🎓 Começar tutorial</button>'+
      '<button class="tut-exit" onclick="dismissTutHint()">Agora não</button>';
  });
}
function dismissTutHint(){ lsSet(TUT_HINT_KEY,'1'); updateTutHints(); }
updateTutHints();

// ── VIDEO RULES ──────────────────────────────────────────────────────────────
function checkVideoExists(){
  fetch('/regras.mp4', {method:'HEAD'}).then(r=>{
    const wrap=document.getElementById('video-wrap');
    const missing=document.getElementById('video-missing');
    const playIcon=document.getElementById('play-icon');
    if(r.ok){
      if(missing) missing.style.display='none';
      if(playIcon) playIcon.style.display='flex';
    } else {
      if(playIcon) playIcon.style.display='none';
      if(missing) missing.style.display='block';
    }
  }).catch(()=>{
    const pi=document.getElementById('play-icon'); if(pi) pi.style.display='none';
  });
}
function playRulesVideo(){
  const video=document.getElementById('rules-video');
  const wrap=document.getElementById('video-wrap');
  const pi=document.getElementById('play-icon');
  const lbl=wrap.querySelector('.video-label');
  if(!video) return;
  video.src='/regras.mp4';
  video.style.display='block';
  if(pi) pi.style.display='none';
  if(lbl) lbl.style.display='none';
  video.play().catch(()=>{});
}
// Check video on load
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', checkVideoExists);
else checkVideoExists();

// ── RULES TOGGLE ─────────────────────────────────────────────────────────────
function toggleRules(){
  const body=document.getElementById('rules-body');
  const btn=document.getElementById('rules-toggle');
  if(!body||!btn) return;
  const open=body.classList.toggle('open');
  btn.classList.toggle('open', open);
  btn.closest('.rules-panel').classList.toggle('open', open); // no compacto: bottom sheet
}

document.getElementById('inp-name').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('btn-go').click(); });
document.getElementById('btn-go').onclick=()=>{
  const n=document.getElementById('inp-name').value.trim();
  if(!n){ notif('Precisas de um nome!'); return; }
  myName=n.slice(0,20); showScreen('screen-lobby');
  if(_cachedLobbies.length) renderLobbyList(_cachedLobbies);
  if(!ws||ws.readyState>1) connect(); else send({type:'LOBBIES'});
};
document.getElementById('btn-back-name').onclick=()=>showScreen('screen-name');
document.getElementById('btn-tut-name').onclick=tutStart;
document.getElementById('btn-tut-lobby').onclick=tutStart;
document.getElementById('btn-start').onclick=()=>{ document.getElementById('btn-start').disabled=true; send({type:'START'}); };
document.getElementById('btn-leave-wait').onclick=()=>{ send({type:'LEAVE_LOBBY'}); sessionStorage.removeItem('cap_token'); myToken=''; myLobbyId=''; myLobbySeat=-1; showScreen('screen-lobby'); send({type:'LOBBIES'}); };
document.getElementById('btn-leave-game').onclick=()=>{ if(confirm('Sair do jogo?')){ _prevBetCount=-1; _prevBirdHolder=-99; send({type:'LEAVE_LOBBY'}); sessionStorage.removeItem('cap_token'); myToken=''; state=null; showScreen('screen-lobby'); send({type:'LOBBIES'}); } };
document.getElementById('btn-restart').onclick=()=>{ closeOverlay('overlay-gameover'); send({type:'RESTART'}); };
document.getElementById('btn-goto-lobby').onclick=()=>{ closeOverlay('overlay-gameover'); _prevBetCount=-1; _prevBirdHolder=-99; send({type:'LEAVE_LOBBY'}); sessionStorage.removeItem('cap_token'); myToken=''; state=null; showScreen('screen-lobby'); send({type:'LOBBIES'}); };

// ── ECRÃ INTEIRO / APP INSTALADA ─────────────────────────────────────────────
// html.edge liga as margens de notch/barra de estado (só quando a página ocupa
// o ecrã todo). No iPhone não há requestFullscreen para páginas: só a PWA.
function isPwaInstalled(){ return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true; }
const canFullscreen=()=>!!document.documentElement.requestFullscreen&&document.fullscreenEnabled&&!isPwaInstalled();
function goFullscreen(){
  if(!canFullscreen()||document.fullscreenElement) return;
  document.documentElement.requestFullscreen({ navigationUI:'hide' }).catch(()=>{});
}
function syncEdge(){
  document.documentElement.classList.toggle('edge', isPwaInstalled()||!!document.fullscreenElement);
  const b=document.getElementById('btn-fullscreen');
  b.hidden=!canFullscreen()||!isCompact();
  b.textContent=document.fullscreenElement?'🗗':'⛶';
}
document.getElementById('btn-fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen().catch(()=>{}):goFullscreen();
// Entra sozinho no toque que abre uma mesa / o tutorial (só em ecrã tátil; tem de ser dentro do gesto).
document.addEventListener('click',e=>{
  if(matchMedia('(pointer: coarse)').matches&&
     e.target.closest('.join-btn, #btn-start, #btn-tut-name, #btn-tut-lobby, #btn-restart, [data-tut-hint] .btn-primary, .tut-final .btn-primary'))
    goFullscreen();
},true);
document.addEventListener('fullscreenchange',syncEdge);
COMPACT_MQ.addEventListener('change',()=>{ syncEdge(); if(state&&document.getElementById('screen-game').classList.contains('active')){ renderGame(); if(tut.active) tutRenderCoach(); } });
syncEdge();

// ── INSTALAR COMO APP (Android) ──────────────────────────────────────────────
// O Chrome/Edge em Android dispara beforeinstallprompt quando a página pode ser
// instalada: guardamos o evento e sugerimos a instalação no início e no lobby
// (só em ecrã tátil, até ser instalada ou dispensada). No iPhone não há este
// evento — lá instala-se pelo menu Partilhar → "Adicionar ao ecrã principal".
const INSTALL_OFF_KEY='cap_install_off';
let _installEvt=null;
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); _installEvt=e; updateInstallHints(); });
window.addEventListener('appinstalled',()=>{ _installEvt=null; updateInstallHints(); });
function updateInstallHints(){
  const show=!!_installEvt&&!isPwaInstalled()&&matchMedia('(pointer: coarse)').matches&&!lsGet(INSTALL_OFF_KEY);
  document.querySelectorAll('[data-install-hint]').forEach(el=>{
    el.classList.toggle('show',show);
    if(show&&!el.innerHTML) el.innerHTML=
      '<div class="tut-hint-text"><b>📲 Instala o Capivaras</b> e joga em ecrã inteiro, a partir do ecrã principal do telemóvel.</div>'+
      '<button class="btn btn-primary btn-sm" onclick="installApp()">Instalar</button>'+
      '<button class="tut-exit" onclick="dismissInstallHint()">Agora não</button>';
  });
}
async function installApp(){
  const e=_installEvt; if(!e) return;
  _installEvt=null; updateInstallHints(); // o evento só pode ser usado uma vez
  e.prompt(); try{ await e.userChoice; }catch(_){}
}
function dismissInstallHint(){ lsSet(INSTALL_OFF_KEY,'1'); updateInstallHints(); }

if(sessionStorage.getItem('cap_token')) connect();
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});

// ── Ambient audio ────────────────────────────────────────
let ambientPlaying=false;
const ambEl=()=>document.getElementById('ambient-audio');

function setAmbientUI(playing){
  ambientPlaying=playing;
  const icon=document.getElementById('amb-icon');
  const lbl=document.getElementById('amb-label');
  if(icon) icon.textContent=playing?'🔊':'🔇';
  if(lbl)  lbl.textContent=playing?'Som':'Som';
}

function startAmbient(){
  const a=ambEl(); if(!a||ambientPlaying) return;
  a.volume=0.35;
  a.play().then(()=>setAmbientUI(true)).catch(()=>setAmbientUI(false));
}

function toggleAmbient(){
  const a=ambEl(); if(!a) return;
  if(ambientPlaying){ a.pause(); setAmbientUI(false); }
  else { startAmbient(); }
}

// Stop when leaving game
document.getElementById('btn-leave-game').addEventListener('click',()=>{
  const a=ambEl(); if(a){a.pause();a.currentTime=0;} setAmbientUI(false);
});

</script>
</body>
</html>`;
