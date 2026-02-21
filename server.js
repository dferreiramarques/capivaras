'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
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
// img: PNG filename without extension, served from /public/cards/
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
  mkCard(5,[],true,'cap5'),                        // cap5_bird missing → reuse cap5 art
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
    autoTimers: new Array(n).fill(null), seatMap: null, game: null };
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
    bets: new Array(n).fill(null), birdHolder: null,
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

let wss;
function broadcastLobbyList() {
  const list = Object.values(lobbies).map(lobbyInfo);
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

function resolveRound(lobby) {
  const g = lobby.game;
  const betCount  = new Array(g.n).fill(0);
  const betBySeat = new Array(g.n).fill(-1);
  g.bets.forEach((bet, seat) => { if (bet !== null) { betCount[bet]++; betBySeat[bet] = seat; } });

  const result = { bets: [...g.bets], winners: {},
    cards: g.table.map(c => ({ ...c, lilies: [...c.lilies] })), birdUpdate: null };

  g.table.forEach((card, pos) => {
    if (betCount[pos] === 1) {
      const seat = betBySeat[pos];
      g.players[seat].scored.push({ ...card, lilies: [...card.lilies] });
      result.winners[pos] = seat;
      if (card.bird) {
        g.players[seat].birdCards++;
        const prev = g.birdHolder;
        if (prev === null) {
          g.birdHolder = seat;
          result.birdUpdate = { type: 'first', seat, name: g.players[seat].name };
        } else if (seat !== prev && g.players[seat].birdCards > g.players[prev].birdCards) {
          g.birdHolder = seat;
          result.birdUpdate = { type: 'steal', seat, from: prev,
            name: g.players[seat].name, fromName: g.players[prev].name };
        }
      }
    }
  });

  g.discard.push(...g.table.map(c => ({ ...c, lilies: [...c.lilies] })));
  g.lastResult = result; g.phase = 'REVEAL'; g.turnGen++;
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
  broadcastLobbyList();
}

// ─── ACTION HANDLER ──────────────────────────────────────────────────────────
function handleAction(ws, msg) {
  if (msg.type === 'PING')      { sendTo(ws, { type: 'PONG' }); return; }
  if (msg.type === 'LOBBIES')   { sendTo(ws, { type: 'LOBBIES', lobbies: Object.values(lobbies).map(lobbyInfo) }); return; }
  if (msg.type === 'RECONNECT') { handleReconnect(ws, msg); return; }
  if (msg.type === 'JOIN_LOBBY') { handleJoin(ws, msg); return; }

  const st = wsState.get(ws); if (!st || !st.lobbyId) return;
  const lobby = lobbies[st.lobbyId]; if (!lobby) return;
  const ls = st.seat, g = lobby.game;

  if (msg.type === 'LEAVE_LOBBY') {
    hardLeaveBySlot(lobby, ls); wsState.delete(ws);
    sendTo(ws, { type: 'LOBBIES', lobbies: Object.values(lobbies).map(lobbyInfo) }); return;
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
      lobby.game = newGame([lobby.names[0]||'Jogador','Bot Capivaras 1','Bot Capivaras 2'], true);
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
  const { lobbyId, playerName } = msg;
  const lobby = lobbies[lobbyId];
  if (!lobby) { sendTo(ws, { type: 'ERROR', text: 'Mesa não encontrada.' }); return; }
  if (!lobby.solo && lobby.game && lobby.game.phase !== 'GAME_OVER') {
    sendTo(ws, { type: 'ERROR', text: 'Jogo em curso.' }); return; }
  const seat = lobby.players.findIndex(p => p === null);
  if (seat === -1) { sendTo(ws, { type: 'ERROR', text: 'Mesa cheia.' }); return; }
  const name  = (playerName||'').trim().slice(0,20)||'Jogador';
  const token = Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
  lobby.players[seat]=ws; lobby.names[seat]=name; lobby.tokens[seat]=token;
  wsState.set(ws, { lobbyId, seat, gameSeat: seat, token });
  sessions[token] = { lobbyId, seat, name };
  sendTo(ws, { type:'JOINED', seat, token, lobbyId, solo:lobby.solo, name, lobby:lobbyInfo(lobby), names:lobby.names });
  lobby.players.forEach((p,i) => { if(p&&i!==seat) sendTo(p,{type:'PLAYER_JOINED',seat,name,lobby:lobbyInfo(lobby)}); });
  broadcastLobbyList();
  if (lobby.solo) {
    lobby.seatMap=null; const s=wsState.get(ws); if(s) s.gameSeat=0;
    lobby.game=newGame([name,'Bot Capivaras 1','Bot Capivaras 2'],true);
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
    { "src": "/bird.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/bird.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}`;
const SW = "self.addEventListener('fetch', e => {\n  // network-first: serve fresh if online, nothing cached\n});";

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CLIENT_HTML);
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Capivaras</title>
<meta name="application-name" content="Capivaras">
<meta name="description" content="Um jogo de apostas secretas no Pantanal">
<meta name="theme-color" content="#c47c28">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Capivaras">
<link rel="apple-touch-icon" href="/bird.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,700;0,9..144,900;1,9..144,400&family=Nunito:wght@400;600;700&display=swap" rel="stylesheet">
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
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  min-height: 100vh;
  background: linear-gradient(160deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
  background-attachment: fixed;
  color: var(--ink);
  font-family: 'Nunito', system-ui, sans-serif;
}

/* ── SCREENS ── */
.screen { display: none; min-height: 100vh; }
.screen.active { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
#screen-game { justify-content: flex-start; padding: 12px; }

/* ── LOGO ── */
.game-logo {
  font-family: 'Fraunces', serif;
  font-size: 4rem; font-weight: 900;
  color: var(--ink); letter-spacing: -.02em; line-height: 1;
}
.game-logo span { color: var(--ink); }
.game-tagline { font-size: .9rem; color: var(--muted); margin-bottom: 32px; font-style: italic; font-family: 'Fraunces', serif; }
.h-rule { width: 36px; height: 2px; background: var(--amber); opacity: .5; margin: 0 auto 28px; border-radius: 2px; }

/* ── CARD BOX (panels) ── */
.card-box {
  background: var(--panel-b);
  border: 1px solid var(--border2);
  border-radius: 20px; padding: 32px;
  max-width: 500px; width: 100%;
  box-shadow: 0 4px 32px rgba(100,60,20,.12), 0 1px 4px rgba(100,60,20,.08);
}
.card-box h2 {
  font-family: 'Fraunces', serif;
  font-size: 1.3rem; font-weight: 700;
  color: var(--ink); margin-bottom: 18px;
}

/* ── INPUTS & BUTTONS ── */
input[type=text] {
  width: 100%; padding: 12px 16px;
  border-radius: 10px; border: 1.5px solid var(--border);
  background: #fffef9; color: var(--ink);
  font-size: 1rem; font-family: 'Nunito', sans-serif;
  outline: none; margin-bottom: 16px;
  transition: border-color .15s;
}
input[type=text]:focus { border-color: var(--amber); }
input[type=text]::placeholder { color: var(--muted); opacity: .7; }

.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; padding: 12px 24px; border-radius: 10px; border: none;
  cursor: pointer; font-size: .95rem; font-weight: 700;
  font-family: 'Nunito', sans-serif; transition: all .15s; letter-spacing: .01em;
}
.btn-primary { background: var(--amber); color: #fff; width: 100%; box-shadow: 0 2px 8px rgba(196,124,40,.3); }
.btn-primary:hover { background: var(--amber2); }
.btn-primary:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }
.btn-outline { background: rgba(255,255,255,.6); border: 1.5px solid var(--border); color: var(--ink2); }
.btn-outline:hover { border-color: var(--amber); color: var(--ink); background: rgba(255,255,255,.9); }
.btn-sm { padding: 8px 16px; font-size: .83rem; }

/* ── LOBBY ── */
.lobby-grid { display: grid; gap: 10px; margin-top: 8px; width: 100%; }
.lobby-row {
  background: rgba(255,252,244,.8); border: 1.5px solid var(--border2);
  border-radius: 12px; padding: 14px 18px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  transition: border-color .18s, box-shadow .18s;
}
.lobby-row:not(.full):hover {
  border-color: var(--amber);
  box-shadow: 0 2px 12px rgba(196,124,40,.12);
}
.lobby-name { font-family: 'Fraunces', serif; font-weight: 700; font-size: 1rem; color: var(--ink); }
.lobby-meta { font-size: .76rem; color: var(--muted); margin-top: 2px; }
.badge { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: .68rem; font-weight: 700; border: 1px solid transparent; }
.badge-green  { background: #e8f5e0; color: #2e7a2e; border-color: #b8dca8; }
.badge-orange { background: #fff0d8; color: #a05800; border-color: #e8c878; }
.badge-gray   { background: #f0ece4; color: var(--muted); border-color: var(--border2); }
.join-btn {
  background: var(--amber); color: #fff; border: none;
  padding: 8px 18px; border-radius: 8px; cursor: pointer;
  font-weight: 700; font-size: .83rem; font-family: 'Nunito', sans-serif;
  white-space: nowrap; transition: background .15s;
  box-shadow: 0 2px 6px rgba(196,124,40,.25);
}
.join-btn:hover { background: var(--amber2); }
.join-btn:disabled { opacity: .35; cursor: not-allowed; box-shadow: none; }

/* ── WAIT ── */
.wait-players { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin: 18px 0; }
.wait-player {
  background: rgba(255,252,244,.9); border: 1.5px solid var(--border2);
  border-radius: 10px; padding: 9px 16px; font-size: .88rem; color: var(--ink2);
}
.wait-player.me { border-color: var(--amber); color: var(--ink); font-weight: 700; }

/* ── GAME HEADER ── */
.game-header {
  width: 100%; max-width: 1000px;
  display: flex; align-items: center; justify-content: space-between;
  flex-wrap: nowrap; gap: 6px;
  margin-bottom: 8px; padding-bottom: 8px;
  border-bottom: 1.5px solid var(--border2);
}
.header-left {
  display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;
}
.header-title {
  font-family: 'Fraunces', serif; font-size: 1.5rem; font-weight: 900;
  color: var(--ink); letter-spacing: -.01em; white-space: nowrap;
}
.header-title span { color: var(--amber); }
.bird-token {
  background: #fff8e0; border: 1.5px solid #e8c878;
  padding: 3px 8px; border-radius: 20px;
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
  border-radius: 10px; padding: 8px 10px;
  box-shadow: 0 1px 4px rgba(100,60,20,.06);
}
.player-chip.me   { border-color: var(--amber); background: #fffaee; }
.player-chip.bird { border-color: var(--gold); background: #fffae8; }
.pname   { font-size: .74rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
.ppts    { font-family: 'Fraunces', serif; font-size: 1.2rem; font-weight: 900; color: var(--amber); }
.plilies { font-size: .67rem; margin-top: 2px; color: var(--muted); }
.pbet    { font-size: .65rem; color: var(--teal2); margin-top: 2px; font-weight: 600; }

/* ── TABLE ── */
.table-area  { width: 100%; max-width: 100%; margin-bottom: 10px; }
.table-label { font-size: .7rem; color: var(--muted); margin-bottom: 7px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; text-align: center; width: 100%; }
.table-cards { display: grid; gap: 10px; grid-template-columns: repeat(var(--n-cards,3), min(300px, calc((100vw - 80px) / var(--n-cards,3)))); justify-content: center; }

/* ── THE CARD ── */
.cap-card {
  min-width: 0;
  max-width: 300px;
  width: 100%;
  border-radius: 14px; border: 2px solid var(--border2);
  cursor: pointer; transition: all .18s;
  position: relative; overflow: hidden;
  background: var(--card-bg); user-select: none;
  box-shadow: 0 2px 8px rgba(100,60,20,.1);
}
.cap-card:hover:not(.reveal-card) {
  border-color: var(--amber);
  transform: translateY(-5px);
  box-shadow: 0 10px 28px rgba(100,60,20,.18);
}
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
  font-family: 'Fraunces', serif; font-weight: 900; font-size: 1.8rem;
  color: var(--amber); opacity: .7;
  background: linear-gradient(160deg, #f8f2e2 0%, #c8ede6 100%);
}
.card-art-fallback.hidden { display: none; }

/* Position letter on art */
.card-pos-badge {
  position: absolute; top: 7px; left: 8px; z-index: 2;
  background: rgba(255,252,244,.85); color: var(--ink);
  font-size: .64rem; font-weight: 900;
  padding: 2px 8px; border-radius: 12px;
  font-family: 'Fraunces', serif; border: 1px solid var(--border2);
}

/* Info strip below art */
.card-info { padding: 8px 10px 9px; background: #fffcf6; border-top: 1px solid var(--border2); }
.card-caps-count {
  font-family: 'Fraunces', serif;
  font-size: .88rem; font-weight: 700; color: var(--ink); margin-bottom: 4px;
}
.card-badges { display: flex; gap: 3px; flex-wrap: wrap; }
.lily { display: inline-block; padding: 2px 6px; border-radius: 5px; font-size: .62rem; font-weight: 700; }
.lily-Y { background: #fff3c8; color: #8a5a00; border: 1px solid #e8c860; }
.lily-R { background: #ffe8e0; color: #8a2810; border: 1px solid #e8a090; }
.lily-W { background: #e8eef4; color: #3a5068; border: 1px solid #a8c0d0; }
.lily-B { background: #e0f0f8; color: #185888; border: 1px solid #80c0e0; }
.lily-bird { background: #fff8d8; color: #7a5000; border: 1px solid #e8c040; }

.card-result-label {
  position: absolute; top: 7px; right: 8px; z-index: 2;
  font-size: .6rem; font-weight: 700;
  padding: 2px 8px; border-radius: 12px;
  font-family: 'Nunito', sans-serif;
  max-width: calc(100% - 52px); /* don't overlap the A/B/C badge */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-result-label.win    { background: var(--gold); color: #3a2000; }
.card-result-label.nobody { background: rgba(100,80,60,.15); color: var(--muted); border: 1px solid var(--border); }

/* ── STATUS BAR ── */
.status-bar {
  width: 100%; max-width: 1000px;
  background: var(--panel); border: 1.5px solid var(--border2);
  border-radius: 10px; padding: 10px 16px; margin-bottom: 10px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  box-shadow: 0 1px 4px rgba(100,60,20,.06);
}
.phase-badge { padding: 3px 12px; border-radius: 20px; font-size: .76rem; font-weight: 700; font-family: 'Fraunces', serif; }
.phase-BETTING   { background: #e8f5e0; color: #1e5a1e; border: 1px solid #b0d890; }
.phase-REVEAL    { background: #fff0d0; color: #7a4800; border: 1px solid #e8c060; }
.phase-GAME_OVER { background: #fde8e0; color: #8a2010; border: 1px solid #e8a090; }
.status-text { font-size: .86rem; color: var(--ink2); flex: 1; }
.bet-count   { font-size: .76rem; color: var(--muted); margin-left: auto; font-weight: 600; }

/* ── MY SCORED ── */
.my-area { width: 100%; max-width: 1000px; padding-bottom: 20px; }
.my-area-label { font-size: .68rem; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
.my-scored { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; }
.mini-card {
  width: 100px; background: var(--card-bg);
  border: 1.5px solid var(--border2); border-radius: 10px;
  overflow: hidden; font-size: .7rem; color: var(--ink2);
  box-shadow: 0 1px 4px rgba(100,60,20,.1);
  display: flex; flex-direction: column;
}
.mini-card-art {
  width: 100%; aspect-ratio: 3/4; object-fit: cover; display: block;
  background: linear-gradient(160deg, #f8f2e2 0%, #c8ede6 100%);
}
.mini-card-art.fallback {
  display: flex; align-items: center; justify-content: center;
  font-family: 'Fraunces', serif; font-weight: 900; font-size: 1.2rem;
  color: var(--amber); opacity: .7;
}
.mini-card-label {
  padding: 4px 6px 5px; border-top: 1px solid var(--border2);
  font-size: .65rem; line-height: 1.3; color: var(--ink2);
  background: #fffcf6;
}
.mini-card-badges { display: flex; gap: 2px; flex-wrap: wrap; margin-top: 2px; }
.mini-lily { padding: 1px 4px; border-radius: 4px; font-size: .58rem; font-weight: 700; }

/* ── GAME OVER ── */
.overlay { display: none; position: fixed; inset: 0; background: rgba(46,26,10,.55); align-items: center; justify-content: center; z-index: 100; padding: 20px; backdrop-filter: blur(3px); }
.overlay.active { display: flex; }
.modal {
  background: var(--panel-b); border: 1.5px solid var(--border2);
  border-radius: 22px; padding: 32px;
  max-width: 520px; width: 100%; max-height: 90vh; overflow-y: auto;
  box-shadow: 0 20px 60px rgba(46,26,10,.25);
}
.modal h2 {
  font-family: 'Fraunces', serif; font-size: 1.8rem; font-weight: 900;
  color: var(--ink); text-align: center; margin-bottom: 24px;
}
.score-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 0; border-bottom: 1px solid var(--border2); gap: 8px;
}
.score-row:last-child { border: none; }
.score-name   { font-weight: 700; color: var(--ink); }
.score-pts    { font-family: 'Fraunces', serif; font-size: 1.5rem; font-weight: 900; color: var(--amber); }
.score-detail { font-size: .74rem; color: var(--muted); }
.winner-badge { background: var(--gold); color: #3a2000; padding: 2px 9px; border-radius: 8px; font-size: .7rem; font-weight: 700; }
.modal-actions { display: flex; gap: 10px; margin-top: 24px; }


.bird-count { display:inline-flex; align-items:center; gap:2px; font-size:.75rem; color:#7a5000; font-weight:700; margin-left:3px; }


/* ── VIDEO PLACEHOLDER ── */
.video-wrap {
  margin-top: 24px;
  border-radius: 14px; overflow: hidden;
  border: 1.5px solid var(--border2);
  background: linear-gradient(160deg, #e8f4f0 0%, #d0ece6 100%);
  position: relative; aspect-ratio: 16/9;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--muted); cursor: pointer;
}
.video-wrap video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: 12px; }
.video-wrap .play-icon {
  width: 54px; height: 54px; border-radius: 50%;
  background: rgba(196,124,40,.15); border: 2px solid var(--amber);
  display: flex; align-items: center; justify-content: center;
  font-size: 1.4rem; color: var(--amber); position: relative; z-index: 1;
  transition: background .2s;
}
.video-wrap:hover .play-icon { background: rgba(196,124,40,.28); }
.video-label { font-size: .8rem; font-family: 'Fraunces', serif; font-style: italic; position: relative; z-index: 1; }
.video-missing { font-size: .75rem; color: var(--muted); margin-top: 4px; position: relative; z-index: 1; }

/* ── RULES PANEL ── */
.rules-panel {
  width: 100%; max-width: 1000px;
  margin-top: 4px; margin-bottom: 20px;
  border: 1.5px solid var(--border2); border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
  box-shadow: 0 1px 4px rgba(100,60,20,.06);
}
.rules-toggle {
  width: 100%; background: none; border: none; cursor: pointer;
  padding: 12px 18px; display: flex; align-items: center; justify-content: space-between;
  font-family: 'Fraunces', serif; font-size: .88rem; font-weight: 700;
  color: var(--ink2); text-align: left;
  transition: background .15s;
}
.rules-toggle:hover { background: rgba(196,124,40,.06); }
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
  font-family: 'Fraunces', serif; font-size: 1rem; font-weight: 700;
  color: var(--amber); margin: 18px 0 6px;
}
.rules-body p { font-size: .84rem; color: var(--ink2); line-height: 1.6; margin-bottom: 6px; }
.rules-body ul { margin: 4px 0 8px 18px; }
.rules-body li { font-size: .82rem; color: var(--ink2); line-height: 1.7; }
.rules-body .rule-tag {
  display: inline-block; padding: 1px 7px; border-radius: 5px;
  font-size: .72rem; font-weight: 700; margin-right: 3px;
  background: #fff3c8; color: #7a5000; border: 1px solid #e8c060;
}
.rules-body .rule-tag.green { background: #e8f5e0; color: #1e5a1e; border-color: #b0d890; }
.rules-body .rule-tag.blue  { background: #e0f0f8; color: #185888; border-color: #80c0e0; }

/* ── NOTIFICATION ── */
#notif {
  position: fixed; top: 20px; right: 20px;
  background: var(--amber); color: #fff;
  padding: 12px 20px; border-radius: 12px;
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
</style>
</head>
<body>
<div id="notif"></div>

<!-- NAME -->
<div class="screen active" id="screen-name">
  <div style="width:100%;max-width:460px;display:flex;flex-direction:column;gap:16px">
    <div class="card-box" style="text-align:center">
      <div class="game-logo">Capi<span>varas</span></div>
      <div class="game-tagline">Um jogo de apostas secretas</div>
      <div class="h-rule"></div>
      <h2 style="text-align:left">Como te chamas?</h2>
      <input type="text" id="inp-name" placeholder="O teu nome..." maxlength="20" autocomplete="off">
      <button class="btn btn-primary" id="btn-go">Entrar no jogo</button>
    </div>
    <div class="video-wrap" id="video-wrap" onclick="playRulesVideo()">
      <video id="rules-video" preload="none" controls style="display:none"></video>
      <div class="play-icon" id="play-icon">▶</div>
      <div class="video-label">Como jogar — ver as regras</div>
      <div class="video-missing" id="video-missing">regras.mp4 não encontrado</div>
    </div>
    <p style="text-align:center;font-size:.68rem;color:#9a7050;font-family:'Fraunces',serif;font-style:italic;padding:2px 0 0">Um jogo de David Marques &nbsp;·&nbsp; <a href="https://creativecommons.org/licenses/by-nc-nd/4.0/" target="_blank" style="color:#c47c28;text-decoration:none">CC BY-NC-ND 4.0</a></p>
  </div>
</div>
<!-- LOBBY -->
<div class="screen" id="screen-lobby">
  <div class="card-box" style="max-width:560px">
    <div style="text-align:center;margin-bottom:24px">
      <div class="game-logo" style="font-size:2.2rem">Capi<span>varas</span></div>
    </div>
    <h2>Escolhe uma mesa</h2>
    <div class="lobby-grid" id="lobby-list"></div>
    <div style="margin-top:18px">
      <button class="btn btn-outline btn-sm" id="btn-back-name">← Mudar nome</button>
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
      Aguarda que o anfitriao inicie o jogo...
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
      <div class="header-title">Capivaras</div>
      <div class="bird-token" id="bird-token-display">Passaro — sem detentor</div>
    </div>
    <div class="deck-info" id="deck-info">—</div>
    <button class="btn btn-outline btn-sm" id="btn-leave-game">Sair</button>
  </div>
  <div class="players-bar" id="players-bar"></div>
  <div class="table-area">
    <div class="table-label">Cartas na mesa</div>
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

      <h3>O teu turno</h3>
      <p>A cada ronda, são colocadas na mesa tantas cartas quantos os jogadores. Em segredo, cada um coloca uma ficha virada para baixo com o número da carta que quer conquistar. Quando todos estiverem prontos, revelam ao mesmo tempo.</p>
      <ul>
        <li><span class="rule-tag green">Sozinho</span> Foste o único a escolher essa carta? É tua!</li>
        <li><span class="rule-tag">Empate</span> Mais de um jogador escolheu a mesma carta? Ninguém ganha — as capivaras fugiram.</li>
      </ul>

      <h3>O pássaro amarelo</h3>
      <p>Algumas cartas têm um pássaro amarelo. Quem recolher a primeira dessas cartas fica com o <strong>token do pássaro</strong> (vale +5 pontos no fim). Para roubar o token, tens de acumular <em>mais</em> cartas com pássaro do que o detentor atual. Em caso de empate, o token não se move.</p>

      <h3>Os nenúfares</h3>
      <p>Certas cartas têm nenúfares coloridos. Coleciona as quatro cores para ganhar <strong>+10 pontos bónus</strong> no final.</p>
      <ul>
        <li><span class="rule-tag" style="background:#fff3c8;color:#7a5000;border-color:#e8c060">Amarelo</span>
            <span class="rule-tag" style="background:#ffe8e0;color:#8a2810;border-color:#e8a090">Vermelho</span>
            <span class="rule-tag" style="background:#e8eef4;color:#3a5068;border-color:#a8c0d0">Branco</span>
            <span class="rule-tag blue">Azul</span> — quatro cores, +10 pontos</li>
      </ul>

      <h3>O baralho</h3>
      <p>O baralho de 36 cartas é jogado duas vezes. Quando acaba pela primeira vez, baralha-se o descarte e continua. Quando acaba pela segunda vez, o jogo termina e contam-se os pontos.</p>

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
<p style="width:100%;max-width:1000px;margin:0 auto;text-align:center;padding:10px 0 18px;font-size:.72rem;color:#9a7050;font-family:'Fraunces',serif;font-style:italic">Um jogo de David Marques · <a href="https://creativecommons.org/licenses/by-nc-nd/4.0/" target="_blank" style="color:#c47c28;text-decoration:none">CC BY-NC-ND 4.0</a></p>
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

<script>
let ws,myName='',myToken='',myLobbySeat=-1,myLobbyId='',isSolo=false;
let state=null,myGameSeat=-1,isHost=false,waitLobby=null;
let reconnectAttempts=0,reconnectTimer=null;

const LL = { Y:'Amarelo', R:'Vermelho', W:'Branco', B:'Azul' };
const LI = { Y:'lily-Y', R:'lily-R', W:'lily-W', B:'lily-B' };
const LE = { Y:'●', R:'●', W:'●', B:'●' };
const LC = { Y:'#e8a820', R:'#d85030', W:'#8898a8', B:'#4898c8' };

function showScreen(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); document.getElementById(id).classList.add('active'); }
function openOverlay(id){ document.getElementById(id).classList.add('active'); }
function closeOverlay(id){ document.getElementById(id).classList.remove('active'); }
function send(msg){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(msg)); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
let _nt;
function notif(t,d=3200){ const e=document.getElementById('notif'); e.textContent=t; e.classList.add('show'); clearTimeout(_nt); _nt=setTimeout(()=>e.classList.remove('show'),d); }

function cardArtHTML(card){
  const src='/cards/'+card.img+'.png';
  return '<div class="card-art-wrap">'+
    '<img class="card-art" src="'+src+'" alt="" onload="capImgOk(this)" onerror="capImgErr(this)">'+
    '<div class="card-art-fallback">'+card.cap+'</div>'+
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
  switch(msg.type){
    case 'PONG': break;
    case 'LOBBIES': renderLobbyList(msg.lobbies); break;
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
      closeOverlay('overlay-gameover'); showScreen('screen-game'); renderGame();
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
    d.textContent=name+(i===0?' (anfitriao)':'')+(i===myLobbySeat?' — tu':''); pp.appendChild(d);
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

  /* players bar */
  const bar=document.getElementById('players-bar'); bar.innerHTML='';
  state.players.forEach((p,i)=>{
    const chip=document.createElement('div');
    chip.className='player-chip'+(p.isMe?' me':'')+(p.hasBird?' bird':'');

    const nameDiv=document.createElement('div'); nameDiv.className='pname';
    nameDiv.textContent=p.name;
    if(p.isMe){ const tu=document.createElement('span'); tu.style.cssText='color:var(--amber);font-size:.58rem'; tu.textContent=' (tu)'; nameDiv.appendChild(tu); }
    chip.appendChild(nameDiv);

    const ptsDiv=document.createElement('div'); ptsDiv.className='ppts';
    ptsDiv.textContent=p.pts;
    const ptsSub=document.createElement('span'); ptsSub.style.cssText='font-size:.65rem;font-weight:400;color:var(--muted)'; ptsSub.textContent=' pts';
    ptsDiv.appendChild(ptsSub); chip.appendChild(ptsDiv);

    const lilDiv=document.createElement('div'); lilDiv.className='plilies';
    if(p.lilies.length===0){ const dash=document.createElement('span'); dash.style.opacity='.35'; dash.textContent='—'; lilDiv.appendChild(dash); }
    else p.lilies.forEach(l=>{ const s=document.createElement('span'); s.style.cssText='color:'+LC[l]+';font-size:.9em'; s.title='Nenufar '+LL[l]; s.textContent='●'; lilDiv.appendChild(s); });
    if(p.birdCards>0){
      const bc=document.createElement('span'); bc.className='bird-count'; bc.title='Cartas com passaro';
      const bimg=document.createElement('img'); bimg.src='/bird.png'; bimg.className='bird-pip'; bimg.alt='';
      bc.appendChild(bimg); bc.appendChild(document.createTextNode(p.birdCards));
      lilDiv.appendChild(bc);
    }
    chip.appendChild(lilDiv);

    const bs=state.phase==='BETTING'?(state.betsPlaced[i]?'Apostou':'A pensar...'):'';
    if(bs){ const bsDiv=document.createElement('div'); bsDiv.className='pbet'; bsDiv.textContent=bs; chip.appendChild(bsDiv); }

    bar.appendChild(chip);
  });

  /* table cards */
  const area=document.getElementById('table-cards'); area.innerHTML='';
  area.style.setProperty('--n-cards', state.n);
  (state.table||[]).forEach((card,pos)=>{
    const div=document.createElement('div');
    let cls='cap-card', extra='';
    if(state.phase==='REVEAL'&&state.lastResult){
      cls+=' reveal-card';
      const w=state.lastResult.winners;
      if(w&&w[pos]!==undefined){
        cls+=' won';
        extra='<div class="card-result-label win">'+esc(state.players[w[pos]].name)+'</div>';
      } else { cls+=' nobody'; extra='<div class="card-result-label nobody">Ninguem</div>'; }
    } else if(state.phase==='BETTING'&&state.myBet===pos){ cls+=' selected'; }

    const lilyB=card.lilies.map(l=>'<span class="lily '+LI[l]+'">'+LL[l]+'</span>').join('');
    const birdB=card.bird?'<span class="lily lily-bird">Passaro</span>':'';
    const capWord=card.cap===1?'capivara':'capivaras';

    div.className=cls;
    div.innerHTML=
      cardArtHTML(card)+
      '<div class="card-pos-badge">'+String.fromCharCode(64+pos+1)+'</div>'+
      '<div class="card-info">'+
        '<div class="card-caps-count">'+card.cap+' '+capWord+'</div>'+
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
    cnt.textContent=placed+'/'+state.n+' apostas';
    text.textContent=state.myBet===null?'Escolhe uma carta para apostar':'Apostaste na carta '+String.fromCharCode(64+state.myBet+1)+' — a aguardar os outros...';
  } else if(state.phase==='REVEAL'){
    badge.textContent='Revelacao'; cnt.textContent='';
    const bu=state.lastResult&&state.lastResult.birdUpdate;
    if(bu) text.textContent=bu.type==='first'?bu.name+' recebeu o token do passaro!':bu.name+' destronoupção '+bu.fromName+' e ficou com o token!';
    else { const w=Object.keys((state.lastResult&&state.lastResult.winners)||{}).length; text.textContent=w>0?w+' carta'+(w!==1?'s':'')+' recolhida'+(w!==1?'s':'')+'!':'Ninguem ganhou — todos empataram!'; }
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
    artImg.src='/cards/'+mc.img+'.png'; artImg.alt='';
    artImg.onerror=function(){ this.style.display='none'; this.nextElementSibling.style.display='flex'; };
    const artFb=document.createElement('div'); artFb.className='mini-card-art fallback'; artFb.style.display='none'; artFb.textContent=mc.cap;
    wrap.appendChild(artImg); wrap.appendChild(artFb);
    // label
    const lbl=document.createElement('div'); lbl.className='mini-card-label';
    const capWord=mc.cap===1?'capivara':'capivaras';
    lbl.textContent=mc.cap+' '+capWord;
    if(mc.lilies.length||mc.bird){
      const badges=document.createElement('div'); badges.className='mini-card-badges';
      mc.lilies.forEach(l=>{ const s=document.createElement('span'); s.className='mini-lily lily-'+l; s.textContent=LL[l]; badges.appendChild(s); });
      if(mc.bird){ const b=document.createElement('span'); b.className='mini-lily lily-bird'; b.textContent='Passaro'; badges.appendChild(b); }
      lbl.appendChild(badges);
    }
    wrap.appendChild(lbl);
    sc.appendChild(wrap);
  });

  /* bird token */
  const bt=document.getElementById('bird-token-display');
  if(state.birdHolder===null){ bt.innerHTML='<img src="/bird.png" class="bird-pip big" alt=""> Passaro — sem detentor'; bt.className='bird-token'; }
  else { const h=state.players[state.birdHolder]; bt.innerHTML='<img src="/bird.png" class="bird-pip big" alt=""> '+(h?esc(h.name):'?')+' ('+state.birdHolderCards+'x)'; bt.className='bird-token has-holder'; }

  /* deck */
  document.getElementById('deck-info').textContent=
    state.deckPass===0?'1.a passagem — '+state.deckLeft+' cartas':'2.a passagem — '+state.deckLeft+' cartas';
}

function showGameOver(){
  const el=document.getElementById('final-scores'); el.innerHTML='';
  (state.finalScores||state.players).forEach((s,i)=>{
    const isW=i===state.winnerIdx;
    const d=[];
    if(s.birdCards>0) d.push('Passaro x'+s.birdCards);
    if(s.hasBird) d.push('+5 token');
    if(s.allLilies) d.push('+10 quatro nenufares!');
    const row=document.createElement('div'); row.className='score-row';
    row.innerHTML=
      '<div>'+
        '<div class="score-name">'+esc(s.name)+(isW?' <span class="winner-badge">Vencedor</span>':'')+'</div>'+
        '<div class="score-detail">'+(d.join(' · ')||'so capivaras')+'</div>'+
      '</div>'+
      '<div class="score-pts">'+s.pts+' pts</div>';
    el.appendChild(row);
  });
  document.getElementById('btn-restart').style.display=(isSolo||isHost)?'inline-flex':'none';
  openOverlay('overlay-gameover');
}

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
document.getElementById('btn-start').onclick=()=>{ document.getElementById('btn-start').disabled=true; send({type:'START'}); };
document.getElementById('btn-leave-wait').onclick=()=>{ send({type:'LEAVE_LOBBY'}); sessionStorage.removeItem('cap_token'); myToken=''; myLobbyId=''; myLobbySeat=-1; showScreen('screen-lobby'); send({type:'LOBBIES'}); };
document.getElementById('btn-leave-game').onclick=()=>{ if(confirm('Sair do jogo?')){ _prevBetCount=-1; _prevBirdHolder=-99; send({type:'LEAVE_LOBBY'}); sessionStorage.removeItem('cap_token'); myToken=''; state=null; showScreen('screen-lobby'); send({type:'LOBBIES'}); } };
document.getElementById('btn-restart').onclick=()=>{ closeOverlay('overlay-gameover'); send({type:'RESTART'}); };
document.getElementById('btn-goto-lobby').onclick=()=>{ closeOverlay('overlay-gameover'); _prevBetCount=-1; _prevBirdHolder=-99; send({type:'LEAVE_LOBBY'}); sessionStorage.removeItem('cap_token'); myToken=''; state=null; showScreen('screen-lobby'); send({type:'LOBBIES'}); };

if(sessionStorage.getItem('cap_token')) connect();
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
</script>
</body>
</html>`;
