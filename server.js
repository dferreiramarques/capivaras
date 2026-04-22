'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const fs   = require('fs');
const path = require('path');

const PORT    = process.env.PORT || 3000;
const PUB_DIR = path.join(__dirname, 'public');

// ═══════════════════════════════════════════════════════════════
// CATANIA — Game Logic
// Resources: cereais, vinho, peixe, calcario, azeite
// Village rule: keep majority; ONE minority raises tower value
// Min 5 cards in hand to found a village
// ═══════════════════════════════════════════════════════════════
const CAT_RES = ['cereais','vinho','peixe','calcario','azeite'];
const CAT_PT  = {cereais:'Cereais',vinho:'Vinho',peixe:'Peixe',calcario:'Calcário',azeite:'Azeite'};

const BLACK_DISCS = [12,11,11,10,10,8,8,6,6,4,4,2,2];
const RED_DISCS   = [9,7,5,3,1];
const RED_SET     = new Set(RED_DISCS);

const R = 62, W3 = Math.sqrt(3) * 62;
const CAT_LAYOUT = [
  {row:0,count:2,colStart:1},{row:1,count:4,colStart:0},
  {row:2,count:3,colStart:0},{row:3,count:2,colStart:1}
];

function catShuf(a){for(let i=a.length-1;i>0;i--){const j=0|Math.random()*(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
function h2p(col,row){return{x:W3*col+(row&1?W3/2:0),y:R*1.5*row};}

function catMkTower(){
  const all=[...BLACK_DISCS,...RED_DISCS];all.sort((a,b)=>a-b);return all;
}

function catBuildHexes(){
  const pool=[];CAT_RES.forEach(r=>pool.push(r,r));catShuf(pool);
  const hexes=[];let id=0,ri=0;
  CAT_LAYOUT.forEach(({row,count,colStart})=>{
    for(let ci=0;ci<count;ci++){
      const col=colStart+ci,isVol=(row===1&&ci===1);
      hexes.push({id:id++,row,col,ci,type:isVol?'vulcao':pool[ri++],px:h2p(col,row),tokens:[]});
    }
  });
  return hexes;
}

function catNeighbors(hexId,hexes){
  const h=hexes.find(x=>x.id===hexId);if(!h)return[];
  const thr=W3*1.2;
  return hexes.filter(x=>x.id!==hexId).filter(x=>{const dx=x.px.x-h.px.x,dy=x.px.y-h.px.y;return Math.sqrt(dx*dx+dy*dy)<thr;}).map(x=>x.id);
}

function catTrimHexes(hexes, n){
  // n = number of hexes to remove
  // Rule: only remove a hex if that resource still has ≥2 hexes after removal
  const removable=hexes.filter(h=>h.type!=='vulcao');
  catShuf(removable);
  let removed=0;
  for(const h of removable){
    if(removed>=n)break;
    const remaining=hexes.filter(x=>x.id!==h.id&&x.type===h.type);
    if(remaining.length>=1){ // keeps at least 1 of this type
      const i=hexes.indexOf(h);
      hexes.splice(i,1);
      removed++;
    }
  }
  return hexes;
}

function catNewGame(players){
  const tower=catMkTower();let hexes=catBuildHexes();
  const np=players.length;
  if(np===2)hexes=catTrimHexes(hexes,2);
  else if(np===3)hexes=catTrimHexes(hexes,1);
  const drawn=[];for(let i=0;i<5;i++)drawn.push(tower.pop());catShuf(drawn);
  const piles={};CAT_RES.forEach((r,i)=>{piles[r]={discs:[drawn[i]],totalCollected:0};});
  return{
    n:players.length,
    players:players.map((lp,idx)=>{
      const hand={},collected={};CAT_RES.forEach(r=>{hand[r]=0;collected[r]=0;});
      return{name:lp.name,isBot:!!lp.isBot,colorIdx:idx,hand,collected,villages:[],score:0,
        turn:{collects:0,foundDone:false,sicelPending:false,thisHexes:[]}};
    }),
    hexes,tower,piles,
    sicel:hexes.find(h=>h.type==='vulcao').id,
    cur:0,round:1,phase:'ACTION',trigP:null,log:[],
  };
}

function catInitTurn(g,seat){
  g.hexes.forEach(h=>{h.tokens=h.tokens.filter(pi=>pi!==seat);});
  g.players[seat].turn={collects:0,foundDone:false,sicelPending:false,thisHexes:[]};
}

function catLog(g,msg){g.log.unshift(msg);if(g.log.length>20)g.log.pop();}

function catHandle(g,seat,msg){
  if(g.phase==='GAME_OVER')return{error:'Jogo terminado'};
  const p=g.players[seat],t=p.turn;

  if(msg.type==='CAT_COLLECT'){
    if(g.cur!==seat)return{error:'Não é a tua vez'};
    if(t.sicelPending)return{error:'Move os Sículos primeiro'};
    if(t.collects>=2)return{error:'Já fizeste 2 recolhas'};
    const hex=g.hexes[msg.hexIdx];
    if(!hex||hex.type==='vulcao')return{error:'Hexágono inválido'};
    if(g.sicel===hex.id)return{error:'Os Sículos bloqueiam esse território'};
    if(hex.tokens.some(pi=>pi!==seat))return{error:'Território ocupado'};
    if(t.thisHexes.includes(hex.id))return{error:'Já recolheste neste hex'};
    if(msg.take2&&!g.tower.length)return{error:'Torre vazia'};
    if(!hex.tokens.includes(seat))hex.tokens.push(seat);
    t.thisHexes.push(hex.id);
    const r=hex.type,amt=msg.take2?2:1;
    p.hand[r]+=amt;p.collected[r]+=amt;g.piles[r].totalCollected+=amt;t.collects++;
    if(msg.take2){
      const nd=g.tower.pop(),isRed=RED_SET.has(nd);
      g.piles[r].discs.push(nd); // push on top; original disc preserved below
      catLog(g,`${p.name} recolheu 2 ${CAT_PT[r]} → disco ${nd}${isRed?' 🔴':''}`);
      if(isRed){t.sicelPending=true;return{ok:true,needSicels:true};}
    }else{catLog(g,`${p.name} recolheu 1 ${CAT_PT[r]}`);}
    return{ok:true};
  }

  if(msg.type==='CAT_SICELS'){
    if(g.cur!==seat||!t.sicelPending)return{error:'Fase incorrecta'};
    if(msg.skip){
      // No valid adjacent hex available — resolve without moving
      t.sicelPending=false;catLog(g,'🔥 Fogo do Etna sem destino — fica no lugar.');
      return{ok:true};
    }
    if(!catNeighbors(g.sicel,g.hexes).includes(msg.hexIdx))return{error:'Hex não é adjacente'};
    const destHex=g.hexes.find(h=>h.id===msg.hexIdx);
    if(destHex&&(destHex.tokens||[]).length>0)return{error:'Não podes mover os Sículos para um hex com tokens'};
    g.sicel=msg.hexIdx;t.sicelPending=false;catLog(g,'🔥 Fogo do Etna moveu-se!');
    return{ok:true};
  }

  if(msg.type==='CAT_VILLAGE'){
    if(g.cur!==seat)return{error:'Não é a tua vez'};
    if(t.collects<1)return{error:'Faz pelo menos 1 recolha'};
    if(t.foundDone)return{error:'Já fundaste uma aldeia'};
    const{keepRes,affectRes}=msg;
    const types=CAT_RES.filter(r=>p.hand[r]>0);
    const total=types.reduce((s,r)=>s+p.hand[r],0);
    // Rule: ≥5 cards total + ≥2 types. Choose founding type + minority to sacrifice for tower boost.
    if(total<5)return{error:'Precisas de pelo menos 5 cartas na mão'};
    if(types.length<2)return{error:'Precisas de 2+ tipos de recursos'};
    if(!keepRes||!(p.hand[keepRes]>0))return{error:'Tipo de fundação inválido'};
    if(!affectRes||!(p.hand[affectRes]>0))return{error:'Escolhe um tipo de minoria para descartar'};
    if(affectRes===keepRes)return{error:'A minoria tem de ser um tipo diferente'};
    const keptCount=p.hand[keepRes];
    const discardCount=p.hand[affectRes];
    // Consume only the two selected types; rest of hand preserved
    p.hand[keepRes]=0;
    p.hand[affectRes]=0;
    // Tower improvement: return top disc of minority pile to tower, exposing original value
    const affPile=g.piles[affectRes];
    if(affPile.discs.length>1){
      // Has a collected disc on top — return it to tower
      const returned=affPile.discs.pop();
      g.tower.push(returned);
      g.tower.sort((a,b)=>a-b);
    }
    // If only 1 disc (base), nothing to return — value already exposed
    p.villages.push({res:keepRes,cards:keptCount});t.foundDone=true;
    catLog(g,`🏘 ${p.name} fundou aldeia (${CAT_PT[keepRes]}×${keptCount}), afetou ${CAT_PT[affectRes]}`);
    if(p.villages.length>=3&&g.phase==='ACTION'){
      g.phase='LAST_ROUND';g.trigP=seat;
      catLog(g,`🏛 ${p.name} fundou a 3ª aldeia! Última ronda!`);
    }
    return{ok:true};
  }

  if(msg.type==='CAT_END_TURN'){
    if(g.cur!==seat)return{error:'Não é a tua vez'};
    if(t.sicelPending)return{error:'Move os Sículos antes'};
    if(t.collects<1)return{error:'Faz pelo menos 1 recolha'};
    const next=(seat+1)%g.n;
    if(g.phase==='LAST_ROUND'&&next===g.trigP){catEndGame(g);return{ok:true};}
    g.cur=next;if(next===0)g.round++;
    catInitTurn(g,next);return{ok:true};
  }
  return{error:'Ação desconhecida'};
}

function catEndGame(g){
  g.phase='GAME_OVER';
  g.players.forEach(p=>{
    // Score = sum over founded villages: cards × current disc value of that resource
    p.score=p.villages.reduce((s,v)=>{
      const pile=g.piles[v.res];
      const discVal=pile?pile.discs[pile.discs.length-1]:1;
      return s+(v.cards*discVal);
    },0);
  });
  catLog(g,'⚑ Jogo terminado!');
}

function catBot(g){
  if(g.phase==='GAME_OVER')return null;
  const seat=g.cur,p=g.players[seat];if(!p.isBot)return null;
  const t=p.turn;
  if(t.sicelPending){
    const adj=catNeighbors(g.sicel,g.hexes);
    // No tokens at all — any player's token blocks the move
    const free=adj.filter(id=>{const h=g.hexes.find(x=>x.id===id);return h&&!(h.tokens||[]).length;});
    const noHuman=adj.filter(id=>!g.hexes.find(h=>h.id===id)?.tokens.some(pi=>!g.players[pi].isBot)&&!(g.hexes.find(h=>h.id===id)?.tokens||[]).length);
    const choices=free.length?free:(noHuman.length?noHuman:adj);
    if(!choices.length){return{type:'CAT_SICELS',skip:true};}
    return{type:'CAT_SICELS',hexIdx:choices[0|Math.random()*choices.length]};
  }
  if(t.collects<1||(t.collects<2&&Math.random()<0.6)){
    const avail=g.hexes.filter(h=>h.type!=='vulcao'&&g.sicel!==h.id&&!h.tokens.some(pi=>pi!==seat)&&!t.thisHexes.includes(h.id));
    if(avail.length){
      avail.sort((a,b)=>{const da=g.piles[a.type]?.discs;const db=g.piles[b.type]?.discs;return (da?da[da.length-1]:99)-(db?db[db.length-1]:99);});
      return{type:'CAT_COLLECT',hexIdx:avail[0].id,take2:g.tower.length>2&&Math.random()<0.38};
    }
  }
  if(t.collects>=1&&!t.foundDone){
    const types=CAT_RES.filter(r=>p.hand[r]>0);
    const total=types.reduce((s,r)=>s+p.hand[r],0);
    if(types.length>=2&&total>=5&&Math.random()<0.55){
      // Pick the type with most cards to found; pick another as minority to discard
      const sorted=types.slice().sort((a,b)=>p.hand[b]-p.hand[a]);
      const keepRes=sorted[0];
      // Pick minority: prefer type whose pile top disc is lowest (biggest gain from discard)
      const others=sorted.slice(1);
      const affectRes=others.sort((a,b)=>{
        const da=g.piles[a]?.discs,db=g.piles[b]?.discs;
        return (da?da[da.length-1]:0)-(db?db[db.length-1]:0);
      })[0];
      if(affectRes) return{type:'CAT_VILLAGE',keepRes,affectRes};
    }
  }
  return{type:'CAT_END_TURN'};
}

function catView(g,seat){
  const me=g.players[seat];
  return{
    n:g.n,cur:g.cur,myIdx:seat,round:g.round,phase:g.phase,
    players:g.players.map((p,i)=>({
      name:p.name,colorIdx:p.colorIdx,isBot:p.isBot,
      handTotal:Object.values(p.hand).reduce((a,b)=>a+b,0),
      villages:p.villages,score:p.score||0,
      turn:i===seat?p.turn:null,
    })),
    myHand:me.hand,
    allHands:g.players.map(p=>p.hand),
    hexes:g.hexes.map(h=>({...h})),
    piles:Object.fromEntries(CAT_RES.map(r=>[r,{
      disc:g.piles[r].discs[g.piles[r].discs.length-1],
      discs:g.piles[r].discs,
      totalCollected:g.piles[r].totalCollected
    }])),tower:g.tower,
    sicel:g.sicel,sicelAdj:catNeighbors(g.sicel,g.hexes),
    log:g.log,
  };
}

// ═══════════════════════════════════════════════════════════════
// LOBBY
// ═══════════════════════════════════════════════════════════════
const LOBBY_DEFS = [
  {id:'cat-4p-1',name:'Mesa 4J — 1',maxP:4,solo:false},
  {id:'cat-4p-2',name:'Mesa 4J — 2',maxP:4,solo:false},
  {id:'cat-2p-1',name:'Mesa 2J — 1',maxP:2,solo:false},
  {id:'cat-2p-2',name:'Mesa 2J — 2',maxP:2,solo:false},
  {id:'cat-solo-3',name:'Solo vs 3 Bots',maxP:1,solo:true,bots:3},
  {id:'cat-solo-1',name:'Solo vs 1 Bot', maxP:1,solo:true,bots:1},
];
const LOBBIES={}, SESSIONS={}, WS_MAP=new WeakMap();
LOBBY_DEFS.forEach(d=>{
  LOBBIES[d.id]={...d,players:Array(d.maxP).fill(null),names:Array(d.maxP).fill(''),
    tokens:Array(d.maxP).fill(null),game:null,graceTimers:Array(d.maxP).fill(null),
    botTimer:null,_abandonedAt:null};
});

function cSend(ws,obj){if(ws?.readyState===1)ws.send(JSON.stringify(obj));}
function lobbyInfo(l){return{id:l.id,name:l.name,solo:l.solo,maxP:l.maxP,bots:l.bots||0,
  seated:l.players.filter(Boolean).length,playing:!!l.game&&l.game.phase!=='GAME_OVER',names:l.names.filter(Boolean)};}
function broadcastLobbies(){
  const list=Object.values(LOBBIES).map(lobbyInfo);
  for(const ws of wss.clients){if(!WS_MAP.get(ws)?.lobbyId)cSend(ws,{type:'LOBBIES',lobbies:list});}
}
function broadcastGame(lobby){
  const g=lobby.game;if(!g)return;
  lobby.players.forEach((ws,i)=>{if(ws)cSend(ws,{type:'GAME_STATE',state:catView(g,i)});});
}
function sendLobbyState(lobby,ws,seat){
  cSend(ws,{type:'LOBBY_STATE',lobby:lobbyInfo(lobby),names:lobby.names,mySeat:seat});
}
function scheduleBots(lobby){
  if(lobby.botTimer)return;
  lobby.botTimer=setTimeout(()=>{
    lobby.botTimer=null;
    const g=lobby.game;if(!g||g.phase==='GAME_OVER')return;
    const p=g.players[g.cur];if(!p?.isBot)return;
    const action=catBot(g);
    if(action){const res=catHandle(g,g.cur,action);broadcastGame(lobby);}
    if(g.phase!=='GAME_OVER')scheduleBots(lobby);
  },800+Math.random()*600);
}

setInterval(()=>{
  const now=Date.now();
  Object.values(LOBBIES).forEach(lobby=>{
    if(!lobby.game)return;
    const alive=lobby.players.some(ws=>ws?.readyState===1);
    if(!alive){
      if(!lobby._abandonedAt){lobby._abandonedAt=now;return;}
      if(now-lobby._abandonedAt>(lobby.solo?1800000:3600000)){
        if(lobby.botTimer){clearTimeout(lobby.botTimer);lobby.botTimer=null;}
        lobby.game=null;lobby._abandonedAt=null;
        lobby.players.fill(null);lobby.names.fill('');lobby.tokens.fill(null);
        Object.keys(SESSIONS).forEach(tok=>{if(SESSIONS[tok]?.lobbyId===lobby.id)delete SESSIONS[tok];});
        broadcastLobbies();
      }
    }else{lobby._abandonedAt=null;}
  });
},300000);

function dispatch(ws,msg){
  if(msg.type==='PING'){cSend(ws,{type:'PONG'});return;}
  if(msg.type==='LOBBIES'){cSend(ws,{type:'LOBBIES',lobbies:Object.values(LOBBIES).map(lobbyInfo)});return;}

  if(msg.type==='RECONNECT'){
    const sess=SESSIONS[msg.token];if(!sess){cSend(ws,{type:'RECONNECT_FAIL'});return;}
    const lobby=LOBBIES[sess.lobbyId];if(!lobby){cSend(ws,{type:'RECONNECT_FAIL'});return;}
    const{seat}=sess;clearTimeout(lobby.graceTimers[seat]);
    lobby.players[seat]=ws;WS_MAP.set(ws,{lobbyId:lobby.id,seat,token:msg.token});
    cSend(ws,{type:'RECONNECTED',seat,solo:lobby.solo});
    if(lobby.game){
      cSend(ws,{type:'GAME_STATE',state:catView(lobby.game,seat)});
      // Resume bot timer if it was paused
      if(lobby.solo&&lobby.game.phase!=='GAME_OVER')scheduleBots(lobby);
    } else sendLobbyState(lobby,ws,seat);
    broadcastLobbies();return;
  }

  if(msg.type==='JOIN_LOBBY'){
    const lobby=LOBBIES[msg.lobbyId];if(!lobby){cSend(ws,{type:'ERROR',text:'Mesa inválida'});return;}
    const seat=lobby.players.findIndex(p=>p===null);if(seat===-1){cSend(ws,{type:'ERROR',text:'Mesa cheia'});return;}
    const token=Math.random().toString(36).slice(2)+Date.now().toString(36);
    lobby.players[seat]=ws;lobby.names[seat]=msg.playerName;lobby.tokens[seat]=token;
    SESSIONS[token]={lobbyId:lobby.id,seat,name:msg.playerName};
    WS_MAP.set(ws,{lobbyId:lobby.id,seat,token});
    cSend(ws,{type:'JOINED',seat,token,lobbyId:lobby.id,solo:lobby.solo,lobby:lobbyInfo(lobby),names:lobby.names});
    lobby.players.forEach((p,i)=>{if(p&&i!==seat)cSend(p,{type:'PLAYER_JOINED',name:msg.playerName});});
    broadcastLobbies();
    if(lobby.solo){
      const botNames=['Bot Arquimedes','Bot Pitágoras','Bot Euclides'].slice(0,lobby.bots||1);
      const lps=[{name:msg.playerName,isBot:false},...botNames.map(n=>({name:n,isBot:true}))];
      lobby.game=catNewGame(lps);catInitTurn(lobby.game,0);
      broadcastGame(lobby);scheduleBots(lobby);
    }
    return;
  }

  const st=WS_MAP.get(ws);if(!st){cSend(ws,{type:'ERROR',text:'Não estás numa mesa'});return;}
  const lobby=LOBBIES[st.lobbyId];if(!lobby)return;
  const{seat}=st;

  if(msg.type==='LEAVE_LOBBY'){
    clearTimeout(lobby.graceTimers[seat]);
    if(SESSIONS[lobby.tokens[seat]])delete SESSIONS[lobby.tokens[seat]];
    const name=lobby.names[seat];
    lobby.players[seat]=null;lobby.names[seat]='';lobby.tokens[seat]=null;WS_MAP.delete(ws);
    if(lobby.game&&!lobby.solo){lobby.game=null;lobby.players.forEach(p=>{if(p)cSend(p,{type:'GAME_ABORTED',reason:`${name} saiu.`});});}
    if(lobby.game&&lobby.solo){lobby.game=null;if(lobby.botTimer){clearTimeout(lobby.botTimer);lobby.botTimer=null;}}
    lobby._abandonedAt=null;broadcastLobbies();return;
  }

  if(msg.type==='REQUEST_STATE'){
    if(lobby.game)cSend(ws,{type:'GAME_STATE',state:catView(lobby.game,seat)});
    else sendLobbyState(lobby,ws,seat);return;
  }

  if(msg.type==='START'){
    if(seat!==0&&!lobby.solo){cSend(ws,{type:'ERROR',text:'Só o anfitrião pode iniciar'});return;}
    const seated=lobby.players.map((p,i)=>p?i:-1).filter(i=>i!==-1);
    if(!lobby.solo&&seated.length<lobby.maxP){cSend(ws,{type:'ERROR',text:`Precisas de ${lobby.maxP} jogadores`});return;}
    const lps=seated.map(i=>({name:lobby.names[i],isBot:false}));
    lobby.game=catNewGame(lps);catInitTurn(lobby.game,0);
    broadcastGame(lobby);scheduleBots(lobby);return;
  }

  if(msg.type==='RESTART'){
    lobby.game=null;
    lobby.players.forEach((p,i)=>{if(p)sendLobbyState(lobby,p,i);});
    broadcastLobbies();return;
  }

  const g=lobby.game;if(!g){cSend(ws,{type:'ERROR',text:'Sem jogo em curso'});return;}
  const result=catHandle(g,seat,msg);
  if(result?.error){cSend(ws,{type:'ERROR',text:result.error});return;}
  broadcastGame(lobby);
  if(g.phase!=='GAME_OVER')scheduleBots(lobby);
}

// ═══════════════════════════════════════════════════════════════
// HTTP + WS
// ═══════════════════════════════════════════════════════════════
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};
const server=http.createServer((req,res)=>{
  let url=req.url.split('?')[0];if(url==='/')url='/index.html';
  fs.readFile(path.join(PUB_DIR,url),(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(url)]||'application/octet-stream'});res.end(data);
  });
});

const wss=new WebSocketServer({noServer:true});
wss.on('connection',ws=>{
  cSend(ws,{type:'LOBBIES',lobbies:Object.values(LOBBIES).map(lobbyInfo)});
  ws.on('message',raw=>{try{dispatch(ws,JSON.parse(raw));}catch(e){console.error(e);}});
  ws.on('close',()=>{
    const st=WS_MAP.get(ws);if(!st?.lobbyId)return;
    const lobby=LOBBIES[st.lobbyId];if(!lobby)return;
    const{seat,token}=st;
    lobby.players[seat]=null;
    if(lobby.solo){
      // Solo: short grace period (12s) — enough for browser refresh to reconnect
      // Bot timer pauses during grace period, resumes on reconnect
      if(lobby.botTimer){clearTimeout(lobby.botTimer);lobby.botTimer=null;}
      lobby.graceTimers[seat]=setTimeout(()=>{
        // No reconnect in 12s — reset lobby fully
        lobby.names[seat]='';lobby.tokens[seat]=null;
        if(SESSIONS[token])delete SESSIONS[token];
        if(lobby.game){lobby.game=null;}
        lobby._abandonedAt=null;
        broadcastLobbies();
      },12000);
      broadcastLobbies();
    } else {
      // MP: 45s grace period to reconnect
      lobby.graceTimers[seat]=setTimeout(()=>{
        lobby.names[seat]='';lobby.tokens[seat]=null;
        if(SESSIONS[token])delete SESSIONS[token];
        if(lobby.game){lobby.game=null;lobby.players.forEach(p=>{if(p)cSend(p,{type:'GAME_ABORTED',reason:'Adversário desligou.'});});}
        broadcastLobbies();
      },45000);
      broadcastLobbies();
    }
  });
  ws.on('error',()=>{});
});

server.on('upgrade',(req,socket,head)=>{
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
});

setInterval(()=>{for(const ws of wss.clients)if(ws.readyState===1)ws.ping();},25000);
server.listen(PORT,'0.0.0.0',()=>console.log(`[Catania] http://0.0.0.0:${PORT}`));
