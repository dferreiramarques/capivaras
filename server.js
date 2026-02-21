'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const GRACE_MS    = 45_000;
const REVEAL_MS   = 4_500;
const BOT_MIN_MS  = 900;
const BOT_MAX_MS  = 2_600;
const AUTODEAL_MS = 10_000; // auto-bet for disconnected players after 10s

// ─── DECK DEFINITION ─────────────────────────────────────────────────────────
// lilies: Y=yellow R=red W=white B=blue
const BASE_DECK = [
  // 1 capivara (6)
  {cap:1,lilies:[],bird:false}, {cap:1,lilies:[],bird:false},
  {cap:1,lilies:['R'],bird:false}, {cap:1,lilies:['R'],bird:false},
  {cap:1,lilies:['W','B'],bird:false}, {cap:1,lilies:['W'],bird:true},
  // 2 capivaras (13)
  {cap:2,lilies:[],bird:false}, {cap:2,lilies:[],bird:false}, {cap:2,lilies:[],bird:false},
  {cap:2,lilies:[],bird:false}, {cap:2,lilies:[],bird:false}, {cap:2,lilies:[],bird:false},
  {cap:2,lilies:['Y'],bird:false}, {cap:2,lilies:['Y'],bird:false}, {cap:2,lilies:['W'],bird:false},
  {cap:2,lilies:['Y'],bird:true}, {cap:2,lilies:['R'],bird:true},
  {cap:2,lilies:[],bird:true}, {cap:2,lilies:[],bird:true},
  // 3 capivaras (11)
  {cap:3,lilies:[],bird:false}, {cap:3,lilies:[],bird:false}, {cap:3,lilies:[],bird:false},
  {cap:3,lilies:[],bird:false}, {cap:3,lilies:[],bird:false}, {cap:3,lilies:[],bird:false},
  {cap:3,lilies:['Y'],bird:false}, {cap:3,lilies:['B'],bird:false}, {cap:3,lilies:['B'],bird:false},
  {cap:3,lilies:[],bird:true}, {cap:3,lilies:[],bird:true},
  // 4 capivaras (4)
  {cap:4,lilies:[],bird:false}, {cap:4,lilies:[],bird:false},
  {cap:4,lilies:[],bird:true}, {cap:4,lilies:[],bird:true},
  // 5 capivaras (2)
  {cap:5,lilies:[],bird:false}, {cap:5,lilies:[],bird:true},
]; // 36 cards total

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

// ─── SERVER STATE ────────────────────────────────────────────────────────────
const lobbies  = {};
const wsState  = new WeakMap(); // ws → { lobbyId, seat, gameSeat, token }
const sessions = {};            // token → { lobbyId, seat, name }

function initLobbies() {
  for (let i = 1; i <= 5; i++) {
    const id = `mp${i}`;
    lobbies[id] = {
      id, name: `Mesa ${i}`, solo: false,
      maxHuman: 5,
      players:     new Array(5).fill(null),
      names:       new Array(5).fill(''),
      tokens:      new Array(5).fill(null),
      graceTimers: new Array(5).fill(null),
      autoTimers:  new Array(5).fill(null),
      seatMap:     null, // gameSeat → lobbySeat (set on game start)
      game: null,
    };
  }
  lobbies['solo'] = {
    id: 'solo', name: 'Mesa Solo (vs 2 IAs)', solo: true,
    maxHuman: 1,
    players:     [null],
    names:       [''],
    tokens:      [null],
    graceTimers: [null],
    autoTimers:  [null],
    seatMap:     null,
    game: null,
  };
}
initLobbies();

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function newGame(names, isSolo) {
  const n    = names.length;
  const deck = shuffle(BASE_DECK);
  const table = deck.splice(0, n);
  return {
    players: names.map(name => ({ name, scored: [], birdCards: 0 })),
    n,
    deck,
    discard: [],
    table,
    bets:        new Array(n).fill(null), // position (0-indexed) or null
    birdHolder:  null,
    phase:       'BETTING', // BETTING | REVEAL | GAME_OVER
    deckPass:    0,         // 0=first run, 1=second run
    lastResult:  null,
    isSolo,
    turnGen:     0,
    winnerIdx:   null,
    finalScores: null,
  };
}

function computeScores(g) {
  return g.players.map((p, i) => {
    let pts = 0;
    const lilies = new Set();
    for (const card of p.scored) {
      pts += card.cap;
      card.lilies.forEach(l => lilies.add(l));
    }
    if (i === g.birdHolder) pts += 5;
    const allLilies = ['Y','R','W','B'].every(c => lilies.has(c));
    if (allLilies) pts += 10;
    return { name: p.name, pts, scored: p.scored, lilies: [...lilies],
             birdCards: p.birdCards, hasBird: i === g.birdHolder,
             allLilies };
  });
}

function buildView(g, seat) {
  const playerInfo = computeScores(g).map((s, i) => ({
    ...s, isMe: i === seat, seat: i
  }));
  const myBirdCards = g.players[seat].birdCards;
  const birdHolderCards = g.birdHolder !== null ? g.players[g.birdHolder].birdCards : 0;
  return {
    phase:       g.phase,
    n:           g.n,
    table:       g.table,
    myBet:       g.bets[seat],
    betsPlaced:  g.bets.map(b => b !== null), // mask — who has bet, not where
    lastResult:  g.lastResult,
    players:     playerInfo,
    birdHolder:  g.birdHolder,
    deckPass:    g.deckPass,
    deckLeft:    g.deck.length,
    winnerIdx:   g.winnerIdx,
    finalScores: g.finalScores,
    mySeat:      seat,
    isSolo:      g.isSolo,
    myBirdCards,
    birdHolderCards,
    turnGen:     g.turnGen,
  };
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastGame(lobby) {
  const g = lobby.game;
  if (!g) return;
  if (lobby.solo) {
    sendTo(lobby.players[0], { type: 'GAME_STATE', state: buildView(g, 0) });
  } else if (lobby.seatMap) {
    lobby.seatMap.forEach((lobbySeat, gameSeat) => {
      const ws = lobby.players[lobbySeat];
      if (ws) sendTo(ws, { type: 'GAME_STATE', state: buildView(g, gameSeat) });
    });
  }
}

function lobbyInfo(lobby) {
  const seated = lobby.players.filter(Boolean).length;
  const playing = !!lobby.game && lobby.game.phase !== 'GAME_OVER';
  return {
    id:       lobby.id,
    name:     lobby.name,
    solo:     lobby.solo,
    seated,
    maxHuman: lobby.maxHuman,
    playing,
    full:     seated >= lobby.maxHuman,
    names:    lobby.names.filter(Boolean),
  };
}

let wss; // set later
function broadcastLobbyList() {
  const list = Object.values(lobbies).map(lobbyInfo);
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    const st = wsState.get(ws);
    if (!st || !st.lobbyId) sendTo(ws, { type: 'LOBBIES', lobbies: list });
  }
}

// ─── ROUND RESOLUTION ────────────────────────────────────────────────────────
function checkAllBetsIn(lobby) {
  const g = lobby.game;
  if (!g || g.phase !== 'BETTING') return;
  if (g.bets.every(b => b !== null)) resolveRound(lobby);
}

function resolveRound(lobby) {
  const g = lobby.game;

  // Count bets per position
  const betCount = new Array(g.n).fill(0);
  const betBySeat = new Array(g.n).fill(-1);
  g.bets.forEach((bet, seat) => { if (bet !== null) { betCount[bet]++; betBySeat[bet] = seat; } });

  const result = {
    bets:        [...g.bets],
    winners:     {},  // pos → seat
    cards:       g.table.map(c => ({ ...c, lilies: [...c.lilies] })),
    birdUpdate:  null,
    newDeckPass: false,
  };

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
  g.lastResult = result;
  g.phase = 'REVEAL';
  g.turnGen++;

  // Clear any auto-bet timers
  if (!lobby.solo) {
    lobby.autoTimers.forEach((t, i) => { if (t) { clearTimeout(t); lobby.autoTimers[i] = null; } });
  }

  broadcastGame(lobby);

  const gen = g.turnGen;
  setTimeout(() => {
    if (!lobby.game || lobby.game.turnGen !== gen || lobby.game.phase !== 'REVEAL') return;
    nextRound(lobby);
  }, REVEAL_MS);
}

function nextRound(lobby) {
  const g = lobby.game;

  // Attempt to deal new cards
  if (g.deck.length < g.n) {
    if (g.deckPass === 0) {
      g.deck.push(...shuffle(g.discard));
      g.discard = [];
      g.deckPass = 1;
      g.lastResult && (g.lastResult.newDeckPass = true);
    } else {
      endGame(lobby);
      return;
    }
  }

  if (g.deck.length < g.n) { endGame(lobby); return; }

  g.table     = g.deck.splice(0, g.n);
  g.bets      = new Array(g.n).fill(null);
  g.lastResult = null;
  g.phase     = 'BETTING';
  g.turnGen++;

  broadcastGame(lobby);

  if (g.isSolo) {
    scheduleBots(lobby);
  } else {
    scheduleAutoBeats(lobby);
  }
}

function endGame(lobby) {
  const g = lobby.game;
  g.phase      = 'GAME_OVER';
  g.finalScores = computeScores(g);
  const maxPts  = Math.max(...g.finalScores.map(s => s.pts));
  g.winnerIdx   = g.finalScores.findIndex(s => s.pts === maxPts);
  broadcastGame(lobby);
  broadcastLobbyList();
}

// ─── BOT AI ──────────────────────────────────────────────────────────────────
function scheduleBots(lobby) {
  const g = lobby.game;
  if (!g || !g.isSolo || g.phase !== 'BETTING') return;
  const gen = g.turnGen;

  [1, 2].forEach(botSeat => {
    if (g.bets[botSeat] !== null) return;
    const delay = BOT_MIN_MS + Math.random() * (BOT_MAX_MS - BOT_MIN_MS);
    setTimeout(() => {
      if (!lobby.game || lobby.game.turnGen !== gen || lobby.game.phase !== 'BETTING') return;
      if (g.bets[botSeat] !== null) return;
      g.bets[botSeat] = botChoose(g, botSeat);
      broadcastGame(lobby);
      checkAllBetsIn(lobby);
    }, botSeat === 1 ? delay : delay + 300 + Math.random() * 400);
  });
}

function botChoose(g, seat) {
  const player   = g.players[seat];
  const myLilies = new Set();
  player.scored.forEach(c => c.lilies.forEach(l => myLilies.add(l)));

  const otherBotBet = seat === 1 ? g.bets[2] : g.bets[1];

  const scores = g.table.map((card, pos) => {
    let score = card.cap * 10;
    score += card.lilies.filter(l => !myLilies.has(l)).length * 8;
    if (card.bird) {
      if (g.birdHolder === null) score += 20;
      else if (g.birdHolder !== seat && player.birdCards >= g.players[g.birdHolder].birdCards) score += 15;
      else score += 4;
    }
    // Avoid colliding with other bot if we know its choice
    if (otherBotBet === pos) score -= 30;
    score += (Math.random() - 0.5) * 12;
    return { pos, score };
  });

  scores.sort((a, b) => b.score - a.score);
  if (Math.random() < 0.75 || scores.length === 1) return scores[0].pos;
  return scores[Math.min(1, scores.length - 1)].pos;
}

// Auto-bet for disconnected players in multiplayer
function scheduleAutoBeats(lobby) {
  const g = lobby.game;
  if (!g || g.isSolo) return;
  const gen = g.turnGen;

  if (!lobby.seatMap) return;
  lobby.seatMap.forEach((lobbySeat, gameSeat) => {
    if (lobby.players[lobbySeat]) return; // still connected
    if (g.bets[gameSeat] !== null) return;
    const t = setTimeout(() => {
      if (!lobby.game || lobby.game.turnGen !== gen || lobby.game.phase !== 'BETTING') return;
      if (g.bets[gameSeat] !== null) return;
      g.bets[gameSeat] = Math.floor(Math.random() * g.n);
      broadcastGame(lobby);
      checkAllBetsIn(lobby);
    }, AUTODEAL_MS);
    lobby.autoTimers[lobbySeat] = t;
  });
}

// ─── LOBBY HELPERS ───────────────────────────────────────────────────────────
function findGameSeat(lobby, lobbySeat) {
  if (!lobby.seatMap) return lobbySeat;
  return lobby.seatMap.indexOf(lobbySeat);
}

function hardLeaveBySlot(lobby, lobbySeat) {
  const token = lobby.tokens[lobbySeat];
  if (token) delete sessions[token];
  lobby.players[lobbySeat]     = null;
  lobby.names[lobbySeat]       = '';
  lobby.tokens[lobbySeat]      = null;
  clearTimeout(lobby.graceTimers[lobbySeat]);
  clearTimeout(lobby.autoTimers[lobbySeat]);
  lobby.graceTimers[lobbySeat] = null;
  lobby.autoTimers[lobbySeat]  = null;

  // Notify remaining players
  lobby.players.forEach(p => {
    if (p) sendTo(p, { type: 'PLAYER_LEFT', seat: lobbySeat, lobby: lobbyInfo(lobby) });
  });

  // Solo: clear game
  if (lobby.solo && lobbySeat === 0) {
    lobby.game   = null;
    lobby.seatMap = null;
  }

  // Multiplayer with active game: if only 1 human left, end game
  if (!lobby.solo && lobby.game && lobby.game.phase !== 'GAME_OVER') {
    const remaining = lobby.seatMap ? lobby.seatMap.filter(li => lobby.players[li]).length : 0;
    if (remaining < 2) endGame(lobby);
  }

  broadcastLobbyList();
}

// ─── ACTION HANDLER ──────────────────────────────────────────────────────────
function handleAction(ws, msg) {
  if (msg.type === 'PING') { sendTo(ws, { type: 'PONG' }); return; }

  if (msg.type === 'LOBBIES') {
    sendTo(ws, { type: 'LOBBIES', lobbies: Object.values(lobbies).map(lobbyInfo) });
    return;
  }

  if (msg.type === 'RECONNECT') { handleReconnect(ws, msg); return; }
  if (msg.type === 'JOIN_LOBBY') { handleJoin(ws, msg); return; }

  // ── needs lobby context ──
  const st = wsState.get(ws);
  if (!st || !st.lobbyId) return;
  const lobby = lobbies[st.lobbyId];
  if (!lobby) return;
  const lobbySeat = st.seat;
  const g = lobby.game;

  switch (msg.type) {
    case 'LEAVE_LOBBY': {
      hardLeaveBySlot(lobby, lobbySeat);
      wsState.delete(ws);
      sendTo(ws, { type: 'LOBBIES', lobbies: Object.values(lobbies).map(lobbyInfo) });
      break;
    }

    case 'REQUEST_STATE': {
      if (g) sendTo(ws, { type: 'GAME_STATE', state: buildView(g, findGameSeat(lobby, lobbySeat)) });
      else sendTo(ws, { type: 'LOBBY_STATE', lobby: lobbyInfo(lobby), names: lobby.names, myLobbySeat: lobbySeat });
      break;
    }

    case 'START': {
      if (lobby.solo) return;
      if (lobbySeat !== 0) return;
      if (g && g.phase !== 'GAME_OVER') return;
      const active = lobby.players.map((p, i) => p ? i : -1).filter(i => i >= 0);
      if (active.length < 2) { sendTo(ws, { type: 'ERROR', text: 'Precisas de pelo menos 2 jogadores.' }); return; }
      lobby.seatMap = active; // seatMap[gameSeat] = lobbySeat
      const names = active.map(i => lobby.names[i]);
      lobby.game = newGame(names, false);
      // Tag each ws with gameSeat
      active.forEach((li, gi) => {
        const w = lobby.players[li];
        if (w) { const s = wsState.get(w); if (s) s.gameSeat = gi; }
      });
      broadcastGame(lobby);
      broadcastLobbyList();
      scheduleAutoBeats(lobby);
      break;
    }

    case 'BET': {
      if (!g || g.phase !== 'BETTING') {
        if (g) sendTo(ws, { type: 'GAME_STATE', state: buildView(g, findGameSeat(lobby, lobbySeat)) });
        return;
      }
      const gameSeat = findGameSeat(lobby, lobbySeat);
      if (gameSeat === -1) return;
      const pos = parseInt(msg.position);
      if (isNaN(pos) || pos < 0 || pos >= g.n) return;
      if (g.bets[gameSeat] !== null) return;
      g.bets[gameSeat] = pos;
      broadcastGame(lobby);
      checkAllBetsIn(lobby);
      break;
    }

    case 'RESTART': {
      if (!g || g.phase !== 'GAME_OVER') return;
      if (lobby.solo) {
        const humanName = lobby.names[0] || 'Jogador';
        lobby.game = newGame([humanName, 'Bot Capivaras 1', 'Bot Capivaras 2'], true);
        lobby.seatMap = null;
        const s = wsState.get(ws);
        if (s) s.gameSeat = 0;
        broadcastGame(lobby);
        scheduleBots(lobby);
      } else {
        if (lobbySeat !== 0) return;
        const active = lobby.players.map((p, i) => p ? i : -1).filter(i => i >= 0);
        if (active.length < 2) { sendTo(ws, { type: 'ERROR', text: 'Precisas de pelo menos 2 jogadores.' }); return; }
        lobby.seatMap = active;
        const names = active.map(i => lobby.names[i]);
        lobby.game = newGame(names, false);
        active.forEach((li, gi) => {
          const w = lobby.players[li];
          if (w) { const s = wsState.get(w); if (s) s.gameSeat = gi; }
        });
        broadcastGame(lobby);
        scheduleAutoBeats(lobby);
      }
      break;
    }
  }
}

function handleJoin(ws, msg) {
  const { lobbyId, playerName } = msg;
  const lobby = lobbies[lobbyId];
  if (!lobby) { sendTo(ws, { type: 'ERROR', text: 'Mesa não encontrada.' }); return; }

  if (!lobby.solo && lobby.game && lobby.game.phase !== 'GAME_OVER') {
    sendTo(ws, { type: 'ERROR', text: 'Jogo em curso. Aguarda o fim.' }); return;
  }

  const seat = lobby.players.findIndex(p => p === null);
  if (seat === -1) { sendTo(ws, { type: 'ERROR', text: 'Mesa cheia.' }); return; }

  const name  = (playerName || '').trim().slice(0, 20) || 'Jogador';
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  lobby.players[seat] = ws;
  lobby.names[seat]   = name;
  lobby.tokens[seat]  = token;
  wsState.set(ws, { lobbyId, seat, gameSeat: seat, token });
  sessions[token] = { lobbyId, seat, name };

  sendTo(ws, { type: 'JOINED', seat, token, lobbyId, solo: lobby.solo, name,
               lobby: lobbyInfo(lobby), names: lobby.names });

  lobby.players.forEach((p, i) => {
    if (p && i !== seat) sendTo(p, { type: 'PLAYER_JOINED', seat, name, lobby: lobbyInfo(lobby) });
  });

  broadcastLobbyList();

  if (lobby.solo) {
    lobby.seatMap = null;
    const s = wsState.get(ws);
    if (s) s.gameSeat = 0;
    lobby.game = newGame([name, 'Bot Capivaras 1', 'Bot Capivaras 2'], true);
    broadcastGame(lobby);
    scheduleBots(lobby);
  }
}

function handleReconnect(ws, msg) {
  const sess = sessions[msg.token];
  if (!sess) { sendTo(ws, { type: 'RECONNECT_FAIL' }); return; }

  const lobby = lobbies[sess.lobbyId];
  if (!lobby) { sendTo(ws, { type: 'RECONNECT_FAIL' }); return; }

  const { seat, name } = sess;
  clearTimeout(lobby.graceTimers[seat]);
  lobby.graceTimers[seat] = null;
  lobby.players[seat] = ws;
  lobby.names[seat]   = name;

  const gameSeat = lobby.seatMap ? lobby.seatMap.indexOf(seat) : seat;
  wsState.set(ws, { lobbyId: sess.lobbyId, seat, gameSeat, token: msg.token });

  sendTo(ws, { type: 'RECONNECTED', seat, gameSeat, name, solo: lobby.solo });
  broadcastLobbyList();

  if (lobby.game) {
    broadcastGame(lobby);
    // If multiplayer game is in betting phase, check auto-bet timer
    if (!lobby.game.isSolo && lobby.game.phase === 'BETTING') {
      clearTimeout(lobby.autoTimers[seat]);
      lobby.autoTimers[seat] = null;
    }
    if (lobby.game.isSolo && lobby.game.phase === 'BETTING') {
      scheduleBots(lobby);
    }
  } else {
    sendTo(ws, { type: 'LOBBY_STATE', lobby: lobbyInfo(lobby), names: lobby.names, myLobbySeat: seat });
  }

  lobby.players.forEach((p, i) => {
    if (p && i !== seat) sendTo(p, { type: 'OPPONENT_RECONNECTED', seat, name });
  });
}

// ─── WEBSOCKET SERVER ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CLIENT_HTML);
});

wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    try { handleAction(ws, JSON.parse(raw)); } catch {}
  });

  ws.on('close', () => {
    const st = wsState.get(ws);
    if (!st || !st.lobbyId) return;
    const lobby = lobbies[st.lobbyId];
    if (!lobby) return;
    const { seat } = st;

    lobby.players[seat] = null;

    lobby.players.forEach(p => {
      if (p) sendTo(p, { type: 'OPPONENT_DISCONNECTED_GRACE', seat, name: lobby.names[seat], graceMs: GRACE_MS });
    });

    broadcastLobbyList();

    // Auto-bet if in betting phase
    const g = lobby.game;
    if (g && g.phase === 'BETTING') {
      const gameSeat = findGameSeat(lobby, seat);
      if (gameSeat !== -1 && g.bets[gameSeat] === null) {
        const gen = g.turnGen;
        lobby.autoTimers[seat] = setTimeout(() => {
          if (!lobby.game || lobby.game.turnGen !== gen || lobby.game.phase !== 'BETTING') return;
          if (g.bets[gameSeat] !== null) return;
          g.bets[gameSeat] = Math.floor(Math.random() * g.n);
          broadcastGame(lobby);
          checkAllBetsIn(lobby);
        }, AUTODEAL_MS);
      }
    }

    lobby.graceTimers[seat] = setTimeout(() => hardLeaveBySlot(lobby, seat), GRACE_MS);
  });

  ws.on('error', () => {});
});

// Railway keep-alive heartbeat
setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.ping();
}, 20_000);

server.listen(PORT, () => console.log(`Capivaras running on port ${PORT}`));

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT HTML
// ─────────────────────────────────────────────────────────────────────────────
const CLIENT_HTML = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🦫 Capivaras</title>
<style>
  :root {
    --bg:      #0e1a0f;
    --panel:   #162318;
    --card-bg: #1e3323;
    --card-ho: #2a4a32;
    --green:   #52b788;
    --green2:  #40916c;
    --gold:    #f4a261;
    --red:     #e76f51;
    --text:    #d8f3dc;
    --muted:   #74c69d;
    --border:  #2d6a4f;
    --yellow:  #ffd166;
    --blue:    #90e0ef;
    --white:   #f8f9fa;
    --white-l: #ced4da;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; overflow-x: hidden; }

  /* ── SCREENS ── */
  .screen { display: none; min-height: 100vh; }
  .screen.active { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
  #screen-game { justify-content: flex-start; padding: 12px; }

  /* ── NAME / LOBBY SCREENS ── */
  .logo { font-size: 3.5rem; margin-bottom: 8px; }
  .subtitle { font-size: 1rem; color: var(--muted); margin-bottom: 32px; text-align: center; }
  .card-box { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 32px; max-width: 480px; width: 100%; }
  .card-box h2 { font-size: 1.2rem; margin-bottom: 20px; color: var(--green); }
  input[type=text] { width: 100%; padding: 12px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 1rem; outline: none; margin-bottom: 16px; }
  input[type=text]:focus { border-color: var(--green); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 12px 24px; border-radius: 10px; border: none; cursor: pointer; font-size: 0.95rem; font-weight: 600; transition: all .15s; }
  .btn-primary { background: var(--green2); color: #fff; width: 100%; }
  .btn-primary:hover { background: var(--green); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--muted); }
  .btn-outline:hover { border-color: var(--green); color: var(--text); }
  .btn-sm { padding: 8px 16px; font-size: 0.85rem; }

  /* ── LOBBY LIST ── */
  .lobby-grid { display: grid; gap: 12px; margin-top: 8px; width: 100%; }
  .lobby-row { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; transition: border-color .2s; }
  .lobby-row:hover { border-color: var(--green); }
  .lobby-row.full .join-btn { opacity: 0.3; pointer-events: none; }
  .lobby-row.playing { opacity: 0.7; }
  .lobby-name { font-weight: 700; font-size: 1rem; }
  .lobby-meta { font-size: 0.8rem; color: var(--muted); margin-top: 2px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 0.72rem; font-weight: 700; }
  .badge-green { background: #1b4332; color: var(--green); }
  .badge-orange { background: #4a2900; color: var(--gold); }
  .badge-gray { background: #2d3a2e; color: var(--muted); }
  .join-btn { background: var(--green2); color: #fff; border: none; padding: 8px 18px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 0.85rem; white-space: nowrap; }
  .join-btn:hover { background: var(--green); }

  /* ── WAITING ROOM ── */
  .wait-players { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin: 20px 0; }
  .wait-player { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 18px; font-size: 0.9rem; }
  .wait-player.me { border-color: var(--green); }

  /* ── GAME SCREEN ── */
  #screen-game { background: var(--bg); }
  .game-header { width: 100%; max-width: 900px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .header-title { font-size: 1.1rem; font-weight: 700; color: var(--green); }
  .bird-token { background: #2a3a1a; border: 1px solid #4a6a2a; padding: 4px 12px; border-radius: 20px; font-size: 0.82rem; color: var(--yellow); }
  .deck-info { font-size: 0.78rem; color: var(--muted); }

  /* Players bar */
  .players-bar { width: 100%; max-width: 900px; display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .player-chip { flex: 1; min-width: 120px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; }
  .player-chip.me { border-color: var(--green); }
  .player-chip.bird { border-color: var(--yellow); }
  .player-chip .pname { font-size: 0.8rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .player-chip .ppts { font-size: 1.2rem; font-weight: 800; color: var(--green); }
  .player-chip .plilies { font-size: 0.75rem; margin-top: 2px; }
  .player-chip .pbet { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }

  /* Table cards */
  .table-area { width: 100%; max-width: 900px; margin-bottom: 12px; }
  .table-label { font-size: 0.78rem; color: var(--muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  .table-cards { display: flex; gap: 10px; flex-wrap: wrap; }
  .cap-card { flex: 1; min-width: 130px; max-width: 200px; background: var(--card-bg); border: 2px solid var(--border); border-radius: 14px; padding: 14px; cursor: pointer; transition: all .15s; position: relative; user-select: none; }
  .cap-card:hover { border-color: var(--green); transform: translateY(-3px); }
  .cap-card.selected { border-color: var(--green); background: #1a3d28; box-shadow: 0 0 0 3px rgba(82,183,136,.3); }
  .cap-card.won { border-color: var(--gold); background: #2a2010; }
  .cap-card.lost { border-color: #333; opacity: 0.5; }
  .cap-card.nobody { border-color: #444; opacity: 0.6; }
  .card-pos { position: absolute; top: 8px; right: 10px; font-size: 0.7rem; color: var(--muted); font-weight: 700; }
  .card-caps { font-size: 1.6rem; margin-bottom: 6px; }
  .card-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
  .lily { display: inline-block; padding: 2px 6px; border-radius: 6px; font-size: 0.72rem; font-weight: 700; }
  .lily-Y { background: #3a2d00; color: var(--yellow); }
  .lily-R { background: #3a0d0d; color: #ff8a80; }
  .lily-W { background: #2d2d2d; color: var(--white-l); }
  .lily-B { background: #0d1f3a; color: var(--blue); }
  .lily-bird { background: #1a2d00; color: #b5e853; }
  .card-winner { position: absolute; bottom: 8px; right: 8px; font-size: 0.68rem; font-weight: 700; background: var(--gold); color: #1a1a1a; padding: 1px 6px; border-radius: 6px; }

  /* Status bar */
  .status-bar { width: 100%; max-width: 900px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .phase-badge { padding: 3px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: 700; }
  .phase-BETTING { background: #0d3320; color: var(--green); }
  .phase-REVEAL  { background: #3a2500; color: var(--gold); }
  .phase-GAME_OVER { background: #2d0d0d; color: #ff8a80; }
  .status-text { font-size: 0.88rem; color: var(--muted); flex: 1; }
  .bet-count { font-size: 0.8rem; color: var(--muted); margin-left: auto; }

  /* My scored cards */
  .my-area { width: 100%; max-width: 900px; }
  .my-area-label { font-size: 0.78rem; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  .my-scored { display: flex; gap: 6px; flex-wrap: wrap; }
  .mini-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 0.8rem; display: flex; gap: 4px; align-items: center; }

  /* ── OVERLAY (game over) ── */
  .overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.75); align-items: center; justify-content: center; z-index: 100; padding: 20px; }
  .overlay.active { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 20px; padding: 32px; max-width: 520px; width: 100%; }
  .modal h2 { font-size: 1.4rem; margin-bottom: 20px; color: var(--green); text-align: center; }
  .score-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border); gap: 8px; }
  .score-row:last-child { border: none; }
  .score-name { font-weight: 700; }
  .score-pts { font-size: 1.3rem; font-weight: 800; color: var(--green); }
  .score-detail { font-size: 0.78rem; color: var(--muted); }
  .winner-badge { background: var(--gold); color: #1a1a1a; padding: 2px 8px; border-radius: 8px; font-size: 0.75rem; font-weight: 700; }
  .modal-actions { display: flex; gap: 10px; margin-top: 24px; }

  /* ── NOTIFICATION ── */
  #notif { position: fixed; top: 20px; right: 20px; background: var(--green2); color: #fff; padding: 12px 20px; border-radius: 12px; font-size: 0.9rem; font-weight: 600; z-index: 200; transition: opacity .3s; pointer-events: none; opacity: 0; max-width: 280px; text-align: center; }
  #notif.show { opacity: 1; }

  /* ── RESP ── */
  @media (max-width: 600px) {
    .cap-card { min-width: 100px; padding: 10px; }
    .card-caps { font-size: 1.3rem; }
    .player-chip { min-width: 90px; }
    .player-chip .ppts { font-size: 1rem; }
  }
</style>
</head>
<body>

<!-- NOTIFICATION -->
<div id="notif"></div>

<!-- SCREEN: NAME -->
<div class="screen active" id="screen-name">
  <div class="logo">🦫</div>
  <div class="subtitle">O jogo das capivaras do Pantanal</div>
  <div class="card-box">
    <h2>Como te chamas?</h2>
    <input type="text" id="inp-name" placeholder="O teu nome..." maxlength="20" autocomplete="off">
    <button class="btn btn-primary" id="btn-go">Entrar no Pantanal 🌿</button>
  </div>
</div>

<!-- SCREEN: LOBBY -->
<div class="screen" id="screen-lobby">
  <div class="logo">🦫</div>
  <div class="card-box" style="max-width:560px">
    <h2>Escolhe uma mesa</h2>
    <div class="lobby-grid" id="lobby-list"></div>
    <div style="margin-top:16px">
      <button class="btn btn-outline btn-sm" id="btn-back-name">← Mudar nome</button>
    </div>
  </div>
</div>

<!-- SCREEN: WAIT (multiplayer waiting room) -->
<div class="screen" id="screen-wait">
  <div class="logo" style="font-size:2.5rem">🦫</div>
  <div class="card-box">
    <h2 id="wait-title">A aguardar jogadores...</h2>
    <div class="wait-players" id="wait-players"></div>
    <div id="wait-host-area" style="display:none">
      <button class="btn btn-primary" id="btn-start" disabled>Iniciar Jogo (mín. 2)</button>
    </div>
    <div id="wait-guest-msg" style="display:none; color:var(--muted); font-size:0.9rem; text-align:center">
      Aguarda que o anfitrião inicie o jogo...
    </div>
    <div style="margin-top:16px">
      <button class="btn btn-outline btn-sm" id="btn-leave-wait">← Sair da mesa</button>
    </div>
  </div>
</div>

<!-- SCREEN: GAME -->
<div class="screen" id="screen-game">
  <div class="game-header">
    <div class="header-title">🦫 Capivaras</div>
    <div class="bird-token" id="bird-token-display">🐦 Sem detentor</div>
    <div class="deck-info" id="deck-info">Deck: —</div>
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
    <span class="bet-count" id="bet-count"></span>
  </div>

  <div class="my-area">
    <div class="my-area-label">As tuas capivaras</div>
    <div class="my-scored" id="my-scored"></div>
  </div>
</div>

<!-- OVERLAY: GAME OVER -->
<div class="overlay" id="overlay-gameover">
  <div class="modal">
    <h2>🏆 Fim do Jogo!</h2>
    <div id="final-scores"></div>
    <div class="modal-actions">
      <button class="btn btn-primary" id="btn-restart" style="display:none">Jogar Novamente</button>
      <button class="btn btn-outline" id="btn-goto-lobby">Voltar ao Lobby</button>
    </div>
  </div>
</div>

<script>
// ─── CLIENT STATE ─────────────────────────────────────────────────────────────
let ws, myName = '', myToken = '', myLobbySeat = -1, myLobbyId = '', isSolo = false;
let state = null; // latest GAME_STATE
let myGameSeat = -1;
let isHost = false;
let waitLobby = null; // lobby info in waiting room
let reconnectAttempts = 0, reconnectTimer = null;

const LILY_LABELS = { Y:'🟡', R:'🔴', W:'⚪', B:'🔵' };
const LILY_NAMES  = { Y:'Amarelo', R:'Vermelho', W:'Branco', B:'Azul' };

// ─── UTILITY ─────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function openOverlay(id)  { document.getElementById(id).classList.add('active'); }
function closeOverlay(id) { document.getElementById(id).classList.remove('active'); }
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

let notifTimer;
function notif(text, dur = 3000) {
  const el = document.getElementById('notif');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => el.classList.remove('show'), dur);
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host);
  ws.onopen = () => {
    reconnectAttempts = 0;
    const token = sessionStorage.getItem('cap_token');
    if (token) send({ type: 'RECONNECT', token });
    else send({ type: 'LOBBIES' });
  };
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
  ws.onclose   = () => scheduleReconnect();
  ws.onerror   = () => {};
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(500 * Math.pow(1.5, reconnectAttempts), 12000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(connect, delay);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) {
    reconnectAttempts = 0; connect();
  }
});
setInterval(() => send({ type: 'PING' }), 15000);

// ─── MESSAGE ROUTER ───────────────────────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {
    case 'PONG': break;

    case 'LOBBIES':
      renderLobbyList(msg.lobbies); break;

    case 'JOINED':
      myToken      = msg.token;
      myLobbySeat  = msg.seat;
      myLobbyId    = msg.lobbyId;
      isSolo       = msg.solo;
      isHost       = msg.seat === 0;
      myGameSeat   = msg.seat;
      sessionStorage.setItem('cap_token', myToken);
      if (isSolo) {
        // game will arrive via GAME_STATE
      } else {
        waitLobby = msg.lobby;
        renderWaitRoom(msg);
        showScreen('screen-wait');
      }
      break;

    case 'LOBBY_STATE':
      myLobbySeat = msg.myLobbySeat;
      isHost      = msg.myLobbySeat === 0;
      waitLobby   = msg.lobby;
      renderWaitRoom(msg);
      break;

    case 'PLAYER_JOINED':
      waitLobby = msg.lobby;
      notif(msg.name + ' entrou na mesa!');
      if (document.getElementById('screen-wait').classList.contains('active')) {
        renderWaitRoom({ lobby: msg.lobby, names: Array.from({length:5}).fill('') });
        // re-request fresh state
        send({ type: 'REQUEST_STATE' });
      }
      break;

    case 'PLAYER_LEFT':
      waitLobby = msg.lobby;
      notif('Um jogador saiu da mesa.');
      if (document.getElementById('screen-wait').classList.contains('active')) {
        send({ type: 'REQUEST_STATE' });
      }
      break;

    case 'GAME_STATE':
      state = msg.state;
      myGameSeat = state.mySeat;
      isSolo = state.isSolo;
      closeOverlay('overlay-gameover');
      showScreen('screen-game');
      renderGame();
      if (state.phase === 'GAME_OVER') showGameOver();
      break;

    case 'RECONNECTED':
      myToken    = sessionStorage.getItem('cap_token');
      myLobbySeat = msg.seat;
      myGameSeat  = msg.gameSeat !== undefined ? msg.gameSeat : msg.seat;
      isSolo      = msg.solo;
      isHost      = msg.seat === 0;
      notif('Reconectado! ✅');
      send({ type: 'REQUEST_STATE' });
      break;

    case 'RECONNECT_FAIL':
      sessionStorage.removeItem('cap_token');
      myToken = '';
      send({ type: 'LOBBIES' });
      break;

    case 'OPPONENT_DISCONNECTED_GRACE':
      notif(msg.name + ' desligou-se. Aguardar ' + Math.round(msg.graceMs/1000) + 's...', 6000);
      break;

    case 'OPPONENT_RECONNECTED':
      notif(msg.name + ' voltou! 🎉'); break;

    case 'OPPONENT_LEFT':
      notif('Um oponente saiu definitivamente.', 5000); break;

    case 'ERROR':
      notif('⚠️ ' + msg.text, 4000); break;
  }
}

// ─── LOBBY RENDER ─────────────────────────────────────────────────────────────
function renderLobbyList(lobbies) {
  showScreen('screen-lobby');
  const el = document.getElementById('lobby-list');
  el.innerHTML = '';
  lobbies.forEach(l => {
    const full    = l.full || l.playing;
    const status  = l.playing ? 'A jogar' : (l.seated > 0 ? l.seated + '/' + l.maxHuman + ' jogadores' : 'Vazia');
    const badgeCls= l.playing ? 'badge-orange' : (l.seated > 0 ? 'badge-green' : 'badge-gray');
    const row = document.createElement('div');
    row.className = 'lobby-row' + (full ? ' full' : '') + (l.playing ? ' playing' : '');
    row.innerHTML =
      '<div><div class="lobby-name">' + (l.solo ? '🤖 ' : '👥 ') + l.name + '</div>' +
      '<div class="lobby-meta">' + (l.solo ? 'Joga solo contra 2 IAs' : 'Até 5 jogadores') + '</div></div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<span class="badge ' + badgeCls + '">' + status + '</span>' +
      '<button class="join-btn" ' + (full ? 'disabled' : '') + '>Entrar</button></div>';
    if (!full) {
      row.querySelector('.join-btn').onclick = () => {
        send({ type: 'JOIN_LOBBY', lobbyId: l.id, playerName: myName });
      };
    }
    el.appendChild(row);
  });
}

// ─── WAIT ROOM RENDER ─────────────────────────────────────────────────────────
function renderWaitRoom(msg) {
  const lobby = msg.lobby || waitLobby;
  if (!lobby) return;
  document.getElementById('wait-title').textContent = lobby.name + ' — A aguardar...';
  const pp = document.getElementById('wait-players');
  pp.innerHTML = '';
  (lobby.names || []).forEach((name, i) => {
    if (!name) return;
    const d = document.createElement('div');
    d.className = 'wait-player' + (i === myLobbySeat ? ' me' : '');
    d.textContent = name + (i === 0 ? ' 👑' : '') + (i === myLobbySeat ? ' (tu)' : '');
    pp.appendChild(d);
  });
  const seated = (lobby.names || []).filter(Boolean).length;
  if (isHost) {
    document.getElementById('wait-host-area').style.display = 'block';
    document.getElementById('wait-guest-msg').style.display = 'none';
    const btn = document.getElementById('btn-start');
    btn.disabled = seated < 2;
    btn.textContent = 'Iniciar Jogo (' + seated + ' jogador' + (seated !== 1 ? 'es' : '') + ')';
  } else {
    document.getElementById('wait-host-area').style.display = 'none';
    document.getElementById('wait-guest-msg').style.display = 'block';
  }
}

// ─── GAME RENDER ──────────────────────────────────────────────────────────────
function renderGame() {
  if (!state) return;
  renderPlayersBar();
  renderTableCards();
  renderStatus();
  renderMyScored();
  renderBirdToken();
  renderDeckInfo();
}

function renderPlayersBar() {
  const bar = document.getElementById('players-bar');
  bar.innerHTML = '';
  state.players.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (p.isMe ? ' me' : '') + (p.hasBird ? ' bird' : '');
    const lilStr = p.lilies.map(l => LILY_LABELS[l]).join('') || '—';
    const betStr = state.phase === 'BETTING'
      ? (state.betsPlaced[i] ? '✅ apostou' : '⏳ a pensar...')
      : '';
    chip.innerHTML =
      '<div class="pname">' + esc(p.name) + (p.isMe ? ' <span style="color:var(--green);font-size:.7rem">(tu)</span>' : '') + '</div>' +
      '<div class="ppts">' + p.pts + ' pts</div>' +
      '<div class="plilies">Nenúfares: ' + lilStr + (p.birdCards > 0 ? ' 🐦×' + p.birdCards : '') + '</div>' +
      (betStr ? '<div class="pbet">' + betStr + '</div>' : '');
    bar.appendChild(chip);
  });
}

function renderTableCards() {
  const area = document.getElementById('table-cards');
  area.innerHTML = '';
  if (!state.table || state.table.length === 0) return;

  state.table.forEach((card, pos) => {
    const div = document.createElement('div');
    let cls = 'cap-card';
    let winnerLabel = '';

    if (state.phase === 'REVEAL' && state.lastResult) {
      const w = state.lastResult.winners;
      if (w && w[pos] !== undefined) {
        const winnerName = state.players[w[pos]].name;
        cls += w[pos] === myGameSeat ? ' won' : ' won';
        winnerLabel = '<div class="card-winner">→ ' + esc(winnerName) + '</div>';
      } else {
        cls += ' nobody';
        winnerLabel = '<div class="card-winner" style="background:#555;color:#ccc">Ninguém</div>';
      }
    } else if (state.phase === 'BETTING') {
      if (state.myBet === pos) cls += ' selected';
    }

    const capsEmoji = '🦫'.repeat(card.cap);
    const lilyBadges = card.lilies.map(l =>
      '<span class="lily lily-' + l + '">' + LILY_LABELS[l] + ' ' + LILY_NAMES[l] + '</span>'
    ).join('');
    const birdBadge = card.bird ? '<span class="lily lily-bird">🐦 Pássaro</span>' : '';

    div.className = cls;
    div.innerHTML =
      '<div class="card-pos">#' + (pos + 1) + '</div>' +
      '<div class="card-caps">' + capsEmoji + '</div>' +
      '<div class="card-badges">' + lilyBadges + birdBadge + '</div>' +
      winnerLabel;

    if (state.phase === 'BETTING' && state.myBet === null) {
      div.style.cursor = 'pointer';
      div.onclick = () => {
        send({ type: 'BET', position: pos });
        // Optimistic UI
        state.myBet = pos;
        renderGame();
      };
    }
    area.appendChild(div);
  });
}

function renderStatus() {
  const badge = document.getElementById('phase-badge');
  const text  = document.getElementById('status-text');
  const cnt   = document.getElementById('bet-count');

  badge.className = 'phase-badge phase-' + state.phase;

  if (state.phase === 'BETTING') {
    badge.textContent = '🎯 A Apostar';
    const placed = state.betsPlaced.filter(Boolean).length;
    cnt.textContent  = placed + '/' + state.n + ' apostas';
    if (state.myBet === null) {
      text.textContent = 'Clica numa carta para apostar!';
    } else {
      text.textContent = '✅ Apostaste na posição #' + (state.myBet + 1) + ' — a aguardar os outros...';
    }
  } else if (state.phase === 'REVEAL') {
    badge.textContent = '👁️ Revelação';
    cnt.textContent = '';
    if (state.lastResult && state.lastResult.birdUpdate) {
      const bu = state.lastResult.birdUpdate;
      if (bu.type === 'first') text.textContent = '🐦 ' + bu.name + ' recebeu o token do pássaro!';
      else text.textContent = '🐦 ' + bu.name + ' destronoupção ' + bu.fromName + ' e ficou com o token!';
    } else {
      const wins = Object.keys(state.lastResult ? state.lastResult.winners || {} : {}).length;
      text.textContent = wins > 0
        ? wins + ' carta' + (wins !== 1 ? 's' : '') + ' recolhida' + (wins !== 1 ? 's' : '') + '!'
        : 'Nenhuma carta recolhida — todos empataram!';
    }
  } else if (state.phase === 'GAME_OVER') {
    badge.textContent = '🏁 Fim de Jogo';
    text.textContent  = 'A contar pontos...';
    cnt.textContent   = '';
  }
}

function renderMyScored() {
  const area = document.getElementById('my-scored');
  area.innerHTML = '';
  const me = state.players[myGameSeat];
  if (!me || me.scored.length === 0) {
    area.innerHTML = '<div style="color:var(--muted);font-size:.85rem">Ainda não recolheste nenhuma carta.</div>';
    return;
  }
  me.scored.forEach(card => {
    const d = document.createElement('div');
    d.className = 'mini-card';
    d.innerHTML = '🦫'.repeat(card.cap)
      + card.lilies.map(l => ' ' + LILY_LABELS[l]).join('')
      + (card.bird ? ' 🐦' : '');
    area.appendChild(d);
  });
}

function renderBirdToken() {
  const el = document.getElementById('bird-token-display');
  if (state.birdHolder === null) {
    el.textContent = '🐦 Sem detentor';
    el.style.borderColor = '#4a6a2a';
  } else {
    const holder = state.players[state.birdHolder];
    el.textContent = '🐦 ' + (holder ? holder.name : '?') + ' (' + (state.birdHolderCards) + '×)';
    el.style.borderColor = '#d4a017';
  }
}

function renderDeckInfo() {
  const el = document.getElementById('deck-info');
  el.textContent = state.deckPass === 0
    ? '1ª passagem — ' + state.deckLeft + ' cartas'
    : '2ª passagem — ' + state.deckLeft + ' cartas restantes';
}

function showGameOver() {
  const el = document.getElementById('final-scores');
  const sc = state.finalScores || state.players;
  el.innerHTML = '';
  sc.forEach((s, i) => {
    const isWinner = i === state.winnerIdx;
    const row = document.createElement('div');
    row.className = 'score-row';
    const details = [];
    if (s.birdCards > 0) details.push('🐦×' + s.birdCards);
    if (s.hasBird) details.push('+5 token pássaro');
    if (s.allLilies) details.push('+10 4 cores!');
    row.innerHTML =
      '<div>' +
        '<div class="score-name">' + esc(s.name) + ' ' + (isWinner ? '<span class="winner-badge">🏆 Vencedor</span>' : '') + '</div>' +
        '<div class="score-detail">' + (details.join(' · ') || 'só capivaras') + '</div>' +
      '</div>' +
      '<div class="score-pts">' + s.pts + ' pts</div>';
    el.appendChild(row);
  });

  const btnRestart = document.getElementById('btn-restart');
  // Show restart for: solo players always, multiplayer host only
  if (isSolo || isHost) {
    btnRestart.style.display = 'inline-flex';
  } else {
    btnRestart.style.display = 'none';
  }

  openOverlay('overlay-gameover');
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── UI WIRING ────────────────────────────────────────────────────────────────
document.getElementById('inp-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-go').click();
});
document.getElementById('btn-go').onclick = () => {
  const n = document.getElementById('inp-name').value.trim();
  if (!n) { notif('Precisas de um nome!'); return; }
  myName = n.slice(0, 20);
  showScreen('screen-lobby');
  if (!ws || ws.readyState > 1) connect();
  else send({ type: 'LOBBIES' });
};
document.getElementById('btn-back-name').onclick = () => showScreen('screen-name');

document.getElementById('btn-start').onclick = () => {
  document.getElementById('btn-start').disabled = true;
  send({ type: 'START' });
};

document.getElementById('btn-leave-wait').onclick = () => {
  send({ type: 'LEAVE_LOBBY' });
  sessionStorage.removeItem('cap_token');
  myToken = ''; myLobbyId = ''; myLobbySeat = -1;
  showScreen('screen-lobby');
  send({ type: 'LOBBIES' });
};

document.getElementById('btn-leave-game').onclick = () => {
  if (confirm('Sair do jogo?')) {
    send({ type: 'LEAVE_LOBBY' });
    sessionStorage.removeItem('cap_token');
    myToken = ''; myLobbyId = ''; state = null;
    showScreen('screen-lobby');
    send({ type: 'LOBBIES' });
  }
};

document.getElementById('btn-restart').onclick = () => {
  closeOverlay('overlay-gameover');
  send({ type: 'RESTART' });
};

document.getElementById('btn-goto-lobby').onclick = () => {
  closeOverlay('overlay-gameover');
  send({ type: 'LEAVE_LOBBY' });
  sessionStorage.removeItem('cap_token');
  myToken = ''; state = null;
  showScreen('screen-lobby');
  send({ type: 'LOBBIES' });
};

// Auto-connect if there's a token
if (sessionStorage.getItem('cap_token')) connect();
</script>
</body>
</html>`;
