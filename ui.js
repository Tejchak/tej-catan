'use strict';
/* Hexhaven — UI layer: capability wiring, live state sync, rendering, actions.
   Loads after core.js (shares globals). Called from hexhaven.html. */

let db=null, user=null, uid=null, myName='';
let S=null;                 // current game state (latest snapshot)
let gameCode=null, unsubGame=null, unsubLobby=null, lobbyGames=[];
let geomFor=null, geomCached=null;
let writeQ = Promise.resolve();
let readOnly = false, dbMissing = false;
let loadTimer=null, loadSlow=false;

const UI = {
  mode:null,            // null|'road'|'ship'|'settlement'|'city'
  tab:'log',
  discardSel:{},
  goldSel:{},
  trade:{give:{},want:{}},
  bankGive:null, bankGet:null,
  pick:null,            // 'yop'|'mono'
  pickIdx:-1,
  yopSel:{},
  showHelp:false,
  toast:null, toastT:null
};

const $ = id => document.getElementById(id);
const esc = s => String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(msg){
  UI.toast = msg;
  clearTimeout(UI.toastT);
  UI.toastT = setTimeout(()=>{ UI.toast=null; renderToast(); }, 3500);
  renderToast();
}
function renderToast(){
  const el = $('toast');
  el.hidden = !UI.toast;
  el.textContent = UI.toast || '';
}

function geom(){
  if(!S || !S.board) return null;
  if(geomFor !== S.board.hexes){ geomCached = buildGeom(S.board.hexes); geomFor = S.board.hexes; }
  return geomCached;
}
function mi(){ return S ? S.players.findIndex(p=>p.uid===uid) : -1; }
function me(){ const i=mi(); return i>=0 ? S.players[i] : null; }
function myTurn(){ return S && S.status!=='lobby' && S.status!=='over' && mi()===S.turn; }
function P(i){ return S.players[i]; }
function pcol(i){ return PCOLORS[P(i).color].c; }

/* ---------- persistence ---------- */

function save(mut){
  if(!db || !S) return;
  const next = structuredClone(S);
  if(mut(next)===false) return;
  next.v = (S.v||0)+1;
  if(next.log.length>120) next.log = next.log.slice(-120);
  if(next.chat.length>80) next.chat = next.chat.slice(-80);
  S = next; render();   // optimistic
  writeQ = writeQ.then(()=> db.doc('games/'+next.code).set(next)).catch(err=>{
    if(err && err.code==='invalid_argument'){ readOnly = true; render(); toast('You have view-only access — ask the host to share this artifact with you as Contributor or Editor to play.'); }
    else toast('Could not save that move — check your connection and try again.');
  });
}
function log(st, icon, msg){ st.log.push({t:icon, m:msg}); }

/* ---------- lifecycle ---------- */

async function init(){
  try{ myName = localStorage.getItem('hx_name') || ''; }catch(e){}
  db = await claude.use('db');
  user = await claude.use('user');
  uid = user ? await user.id() : null;
  if(!uid){
    try{
      uid = localStorage.getItem('hx_uid');
      if(!uid){ uid = 'g_'+Math.random().toString(36).slice(2,10); localStorage.setItem('hx_uid', uid); }
    }catch(e){ uid = 'g_'+Math.random().toString(36).slice(2,10); }
  }
  if(!myName && user){ try{ myName = (await user.me()).name || ''; }catch(e){} }
  if(!db){ dbMissing = true; render(); return; }
  if(user){
    const w = await user.can('data.write');
    if(w===false) readOnly = true;
  }
  window.addEventListener('hashchange', route);
  route();
}

function route(){
  const code = (location.hash||'').replace('#','').toUpperCase();
  if(code && /^[A-Z0-9]{4,6}$/.test(code)) openGame(code);
  else showHome();
}

function showHome(){
  if(unsubGame){ unsubGame(); unsubGame=null; }
  gameCode=null; S=null;
  if(!unsubLobby && db){
    unsubLobby = db.collection('games').orderBy('created','desc').limit(25).onSnapshot(
      snap => { lobbyGames = snap.docs.filter(d=>d.exists).map(d=>d.data()); render(); },
      ()  => { toast('Lobby unavailable right now.'); }
    );
  }
  render();
}

function openGame(code){
  if(unsubLobby){ unsubLobby(); unsubLobby=null; }
  if(gameCode===code) return;
  if(unsubGame){ unsubGame(); unsubGame=null; }
  gameCode = code; S = null; loadSlow=false;
  clearTimeout(loadTimer);
  loadTimer = setTimeout(()=>{ if(!S){ loadSlow=true; render(); } }, 10000);
  render();
  unsubGame = db.doc('games/'+code).onSnapshot(snap=>{
    if(!snap.exists){
      if(!snap.metadata.fromCache){ toast('No game found with code '+code+'.'); location.hash=''; }
      return;
    }
    const data = snap.data();
    if(S && data.v!==undefined && S.v!==undefined && data.v < S.v) return; // stale echo
    S = data;
    if(!snap.metadata.fromCache){ loadSlow=false; clearTimeout(loadTimer); }
    render();
  }, ()=>{ toast('Lost connection to the game.'); });
}

/* ---------- lobby actions ---------- */

function genCode(){
  const A='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c=''; for(let i=0;i<4;i++) c+=A[Math.floor(Math.random()*A.length)];
  return c;
}

function createGame(){
  const nameEl=$('cg-name'), map=document.querySelector('input[name="cg-map"]:checked').value;
  const vp = parseInt($('cg-vp').value,10);
  const nick = $('nick').value.trim();
  if(!nick){ toast('Pick a nickname first.'); $('nick').focus(); return; }
  setNick(nick);
  const code = genCode();
  const opts = {code, name: nameEl.value.trim() || (nick+"'s table"), map, vp, maxP: MAPS[map].maxP};
  const st = newGameState(opts, {uid, name: nick});
  db.doc('games/'+code).set(st).then(()=>{ location.hash = code; })
    .catch(err=>{
      if(err && err.code==='invalid_argument'){ readOnly=true; render(); toast('You have view-only access — ask the artifact owner for Contributor/Editor access.'); }
      else toast('Could not create the game.');
    });
}
function setNick(n){ myName=n; try{ localStorage.setItem('hx_name', n); }catch(e){} }

function joinGame(){
  const nick = ($('nick2') ? $('nick2').value.trim() : myName);
  if(!nick){ toast('Pick a nickname first.'); return; }
  setNick(nick);
  save(st=>{
    if(st.status!=='lobby'){ toast('That game already started.'); return false; }
    if(st.players.some(p=>p.uid===uid)) return false;
    if(st.players.length>=st.options.maxP){ toast('Game is full.'); return false; }
    st.players.push(newPlayer(uid, nick, st.players.length));
    log(st,'👋', nick+' joined the table.');
  });
}
function leaveGame(){
  save(st=>{
    if(st.status!=='lobby') return false;
    const i = st.players.findIndex(p=>p.uid===uid);
    if(i<0) return false;
    const nm = st.players[i].name;
    st.players.splice(i,1);
    st.players.forEach((p,j)=>p.color=j);
    if(st.players.length && st.hostUid===uid) st.hostUid = st.players[0].uid;
    log(st,'🚪', nm+' left.');
  });
}
function deleteGame(){
  if(!S || S.hostUid!==uid) return;
  db.doc('games/'+S.code).delete().then(()=>{ location.hash=''; }).catch(()=>toast('Could not delete.'));
}
function hostStart(){
  save(st=>{
    if(st.hostUid!==uid || st.status!=='lobby') return false;
    if(st.players.length<2){ toast('Need at least 2 players.'); return false; }
    beginGame(st);
  });
}
function rematch(){
  const code = genCode();
  const old = S;
  const opts = {code, name: old.name, map: old.options.map, vp: old.options.vp, maxP: old.options.maxP};
  const st = newGameState(opts, {uid, name: me()? me().name : myName});
  db.doc('games/'+code).set(st).then(()=>{
    save(o=>{ o.next = code; });
    location.hash = code;
  }).catch(()=>toast('Could not create rematch.'));
}

/* ---------- game actions ---------- */

function afterVPcheck(st){
  const i = st.turn;
  if(st.status==='play' && calcVP(st, i, true) >= st.options.vp){
    st.status='over'; st.winner=i;
    log(st,'🏆', st.players[i].name+' wins with '+calcVP(st,i,true)+' victory points!');
  }
}

function clickVert(v){
  const g = geom();
  if(!myTurn()) return;
  if(S.status==='setup'){
    if(S.setup.needRoad) return;
    if(!legalSetupVerts(S,g).includes(v)){ toast('Not a legal spot — on land, 2 corners from any building.'); return; }
    save(st=>{
      st.builds[v] = {p:st.turn, c:'s'};
      st.setup.needRoad = true; st.setup.lastV = v;
      const n = st.players.length;
      if(st.setup.count >= n){ // second settlement: collect starting resources
        for(const h of g.verts[v].hexes){
          const res = TER[g.hexById[h].t].res;
          if(res && res!=='gold') st.players[st.turn].res[res]++;
        }
      }
      log(st,'🏠', st.players[st.turn].name+' placed a settlement.');
    });
    return;
  }
  if(S.phase!=='main') return;
  if(UI.mode==='settlement'){
    if(!legalSettleVerts(S,g,mi()).includes(v)){ toast('Needs your road or ship beside it, 2 corners from any building.'); return; }
    save(st=>{
      const pl = st.players[st.turn];
      if(!canAfford(pl.res, COST.settlement)) return false;
      if(pieceCount(st, st.turn, 'settlement')>=PIECE_LIMIT.settlement){ toast('All 5 settlements are placed — upgrade one to a city.'); return false; }
      payCost(pl.res, COST.settlement);
      st.builds[v] = {p:st.turn, c:'s'};
      for(const h of g.verts[v].hexes){
        const hx = g.hexById[h];
        if(isLand(hx.t) && hx.island>0 && !pl.islands.includes(hx.island)){
          pl.islands.push(hx.island);
          log(st,'🏝️', pl.name+' settled a new island! +1 VP');
        }
      }
      log(st,'🏠', pl.name+' built a settlement.');
      updateLongestRoad(st, g);
      afterVPcheck(st);
    });
    UI.mode=null; render();
  } else if(UI.mode==='city'){
    if(!legalCityVerts(S,mi()).includes(v)){ toast('Pick one of your own settlements.'); return; }
    save(st=>{
      const pl = st.players[st.turn];
      if(!canAfford(pl.res, COST.city)) return false;
      if(pieceCount(st, st.turn, 'city')>=PIECE_LIMIT.city){ toast('All 4 cities built.'); return false; }
      payCost(pl.res, COST.city);
      st.builds[v] = {p:st.turn, c:'c'};
      log(st,'🏛️', pl.name+' raised a city.');
      afterVPcheck(st);
    });
    UI.mode=null; render();
  }
}

function clickEdge(key){
  const g = geom();
  if(!myTurn()) return;
  if(S.status==='setup'){
    if(!S.setup.needRoad) return;
    const opts = legalSetupEdges(S, g, S.setup.lastV);
    const hit = opts.find(o=>o.key===key);
    if(!hit){ toast('Place it touching the settlement you just built.'); return; }
    save(st=>{
      (hit.t==='road' ? st.roads : st.ships)[key] = st.turn;
      st.setup.count++; st.setup.needRoad=false; st.setup.lastV=null;
      const n = st.players.length, seq = setupSeq(n);
      if(st.setup.count >= 2*n){
        st.status='play'; st.setup=null; st.turn=0; st.turnCount=1; st.phase='roll';
        log(st,'🎲', 'Setup complete — '+st.players[0].name+' rolls first.');
      } else {
        st.turn = seq[st.setup.count];
      }
    });
    return;
  }
  if(S.phase!=='main') return;
  if(UI.mode!=='road' && UI.mode!=='ship') return;
  const type = UI.mode;
  if(!legalEdges(S,g,mi(),type).includes(key)){ toast('Must connect to your network'+(type==='ship'?' along the coast or sea.':'.')); return; }
  save(st=>{
    const pl = st.players[st.turn];
    if(pieceCount(st, st.turn, type)>=PIECE_LIMIT[type]){ toast('No '+type+' pieces left.'); return false; }
    if(st.freeRoads>0){ st.freeRoads--; }
    else {
      if(!canAfford(pl.res, COST[type])) return false;
      payCost(pl.res, COST[type]);
    }
    (type==='road' ? st.roads : st.ships)[key] = st.turn;
    log(st, type==='road'?'🛤️':'⛵', pl.name+' built a '+type+(st.freeRoads>0?' (free — '+st.freeRoads+' left)':'')+'.');
    updateLongestRoad(st, g);
    afterVPcheck(st);
  });
  if(S.freeRoads===0) UI.mode=null;
  render();
}

function clickHex(hid){
  const g = geom();
  if(!myTurn() || S.phase!=='robber') return;
  const hx = g.hexById[hid];
  if(!isLand(hx.t)){ toast('The robber stays on land.'); return; }
  if(hid===S.robber){ toast('Move it to a different hex.'); return; }
  save(st=>{
    st.robber = hid;
    log(st,'🦹', st.players[st.turn].name+' moved the robber.');
    const victims = robberVictims(st, g);
    if(victims.length===0){ st.phase = st.after; }
    else if(victims.length===1){ stealFromIn(st, victims[0]); st.phase = st.after; }
    else st.phase='steal';
  });
  UI.mode=null;
}

function stealFromIn(st, victim){
  const v = st.players[victim];
  const bag=[]; RES.forEach(r=>{ for(let i=0;i<v.res[r];i++) bag.push(r); });
  if(bag.length){
    const r = bag[Math.floor(Math.random()*bag.length)];
    v.res[r]--; st.players[st.turn].res[r]++;
    log(st,'🃏', st.players[st.turn].name+' stole a card from '+v.name+'.');
  }
}
function stealFrom(victim){
  if(!myTurn() || S.phase!=='steal') return;
  save(st=>{ stealFromIn(st, victim); st.phase = st.after; });
}

function rollDice(){
  if(!myTurn() || S.phase!=='roll') return;
  save(st=>{
    const d1 = 1+Math.floor(Math.random()*6), d2 = 1+Math.floor(Math.random()*6);
    st.dice=[d1,d2];
    const sum=d1+d2;
    log(st,'🎲', st.players[st.turn].name+' rolled '+sum+' ('+d1+'+'+d2+').');
    if(sum===7){
      st.discard = st.players.map(p=>{ const t=resTotal(p.res); return t>7 ? Math.floor(t/2) : 0; });
      st.after='main';
      st.phase = st.discard.some(n=>n>0) ? 'discard' : 'robber';
    } else {
      const {gains, gold} = produce(st, geom(), sum);
      st.players.forEach((p,i)=>{
        const got=[];
        for(const r in gains[i]){ p.res[r]+=gains[i][r]; got.push(gains[i][r]+RESI[r]); }
        if(got.length) log(st,'📦', p.name+' got '+got.join(' ')+'.');
      });
      st.goldPending = gold;
      st.phase = gold.some(n=>n>0) ? 'gold' : 'main';
      if(st.phase==='gold') log(st,'⭐','Gold fields glitter — choose your resources.');
    }
  });
}

function submitDiscard(){
  const i = mi(); if(i<0 || S.phase!=='discard') return;
  const need = S.discard[i]||0;
  const total = RES.reduce((a,r)=>a+(UI.discardSel[r]||0),0);
  if(total!==need){ toast('Select exactly '+need+' cards.'); return; }
  const sel = {...UI.discardSel};
  UI.discardSel={};
  save(st=>{
    const pl = st.players[i];
    for(const r of RES){ const n=sel[r]||0; if(n>pl.res[r]) return false; pl.res[r]-=n; }
    st.discard[i]=0;
    log(st,'🗑️', pl.name+' discarded '+need+' cards.');
    if(!st.discard.some(n=>n>0)) st.phase='robber';
  });
}

function submitGold(){
  const i=mi(); if(i<0 || S.phase!=='gold') return;
  const need = S.goldPending[i]||0;
  const total = RES.reduce((a,r)=>a+(UI.goldSel[r]||0),0);
  if(total!==need){ toast('Pick exactly '+need+'.'); return; }
  const sel={...UI.goldSel}; UI.goldSel={};
  save(st=>{
    const pl=st.players[i];
    for(const r of RES) pl.res[r]+= sel[r]||0;
    st.goldPending[i]=0;
    log(st,'⭐', pl.name+' claimed gold: '+RES.filter(r=>sel[r]).map(r=>sel[r]+RESI[r]).join(' '));
    if(!st.goldPending.some(n=>n>0)) st.phase='main';
  });
}

function buyDev(){
  if(!myTurn() || S.phase!=='main') return;
  save(st=>{
    const pl=st.players[st.turn];
    if(!st.deck.length){ toast('The development deck is empty.'); return false; }
    if(!canAfford(pl.res, COST.dev)){ toast('Needs 🐑 + 🌾 + 🪨.'); return false; }
    payCost(pl.res, COST.dev);
    const t = st.deck.pop();
    pl.dev.push({t, bt: st.turnCount, used:false});
    log(st,'🂠', pl.name+' bought a development card.');
    afterVPcheck(st);
  });
}

function playDev(idx){
  if(!myTurn()) return;
  const pl = me(); const card = pl.dev[idx];
  if(!card || card.used || card.t==='vp') return;
  if(card.bt===S.turnCount){ toast('You can\'t play a card the turn you bought it.'); return; }
  if(S.playedDev){ toast('Only one development card per turn.'); return; }
  if(card.t==='knight'){
    if(S.phase!=='main' && S.phase!=='roll'){ toast('Play the knight before or after rolling, not mid-event.'); return; }
    save(st=>{
      const c = st.players[st.turn].dev[idx];
      c.used=true; st.players[st.turn].knights++; st.playedDev=true;
      st.after = st.phase==='roll' ? 'roll' : 'main';
      st.phase='robber';
      log(st,'⚔️', st.players[st.turn].name+' played a Knight!');
      updateLargestArmy(st);
      afterVPcheck(st);
    });
  } else {
    if(S.phase!=='main'){ toast('Play that after rolling.'); return; }
    if(card.t==='rb'){
      save(st=>{
        st.players[st.turn].dev[idx].used=true; st.playedDev=true;
        st.freeRoads = 2;
        log(st,'🛤️', st.players[st.turn].name+' played Road Building — 2 free roads/ships.');
      });
      UI.mode='road'; render();
    } else if(card.t==='yop'){
      UI.pick='yop'; UI.yopSel={}; UI.pickIdx=idx; render();
    } else if(card.t==='mono'){
      UI.pick='mono'; UI.pickIdx=idx; render();
    }
  }
}

function submitYop(){
  const total = RES.reduce((a,r)=>a+(UI.yopSel[r]||0),0);
  if(total!==2){ toast('Pick exactly 2.'); return; }
  const sel={...UI.yopSel}; const idx=UI.pickIdx;
  UI.pick=null; UI.yopSel={};
  save(st=>{
    st.players[st.turn].dev[idx].used=true; st.playedDev=true;
    for(const r of RES) st.players[st.turn].res[r]+= sel[r]||0;
    log(st,'🎁', st.players[st.turn].name+' took '+RES.filter(r=>sel[r]).map(r=>sel[r]+RESI[r]).join(' ')+' from the bank.');
  });
}
function submitMono(r){
  const idx=UI.pickIdx; UI.pick=null;
  save(st=>{
    st.players[st.turn].dev[idx].used=true; st.playedDev=true;
    let got=0;
    st.players.forEach((p,i)=>{ if(i!==st.turn){ got+=p.res[r]; p.res[r]=0; } });
    st.players[st.turn].res[r]+=got;
    log(st,'📯', st.players[st.turn].name+' monopolized '+RESN[r]+' — collected '+got+' '+RESI[r]+'.');
  });
}

function bankTrade(){
  if(!myTurn() || S.phase!=='main') return;
  const give=UI.bankGive, get=UI.bankGet;
  if(!give || !get || give===get){ toast('Pick what to give and what to receive.'); return; }
  save(st=>{
    const pl=st.players[st.turn];
    const rate = portRates(st, st.turn)[give];
    if(pl.res[give]<rate){ toast('You need '+rate+' '+RESI[give]+' for that trade.'); return false; }
    pl.res[give]-=rate; pl.res[get]++;
    log(st,'⚖️', pl.name+' traded '+rate+RESI[give]+' → 1'+RESI[get]+' with the bank.');
  });
  UI.bankGive=null; UI.bankGet=null; render();
}

function offerTrade(){
  if(!myTurn() || S.phase!=='main') return;
  const give = {...UI.trade.give}, want = {...UI.trade.want};
  const gN=RES.reduce((a,r)=>a+(give[r]||0),0), wN=RES.reduce((a,r)=>a+(want[r]||0),0);
  if(!gN && !wN){ toast('Set what you offer and what you want.'); return; }
  save(st=>{
    const pl=st.players[st.turn];
    for(const r of RES) if((give[r]||0) > pl.res[r]){ toast('You don\'t have that many '+RESI[r]+'.'); return false; }
    st.trade = {from: st.turn, give, want, acc: st.players.map(()=>null)};
    log(st,'🤝', pl.name+' proposed a trade.');
  });
}
function respondTrade(yes){
  const i=mi(); if(i<0 || !S.trade || i===S.trade.from) return;
  save(st=>{
    if(!st.trade) return false;
    if(yes){
      const pl=st.players[i];
      for(const r of RES) if((st.trade.want[r]||0) > pl.res[r]){ toast('You can\'t cover that offer.'); return false; }
    }
    st.trade.acc[i]=yes;
  });
}
function execTrade(withIdx){
  if(!myTurn() || !S.trade) return;
  save(st=>{
    const t=st.trade; if(!t || t.acc[withIdx]!==true) return false;
    const a=st.players[t.from], b=st.players[withIdx];
    for(const r of RES){ if((t.give[r]||0)>a.res[r] || (t.want[r]||0)>b.res[r]){ toast('Cards changed — trade no longer possible.'); return false; } }
    for(const r of RES){
      a.res[r] += (t.want[r]||0)-(t.give[r]||0);
      b.res[r] += (t.give[r]||0)-(t.want[r]||0);
    }
    log(st,'🤝', a.name+' traded with '+b.name+'.');
    st.trade=null;
  });
  UI.trade={give:{},want:{}};
}
function cancelTrade(){
  save(st=>{ if(st.trade && st.trade.from===mi()){ st.trade=null; log(st,'↩️','Trade withdrawn.'); } else return false; });
  UI.trade={give:{},want:{}};
}

function endTurn(){
  if(!myTurn() || S.phase!=='main') return;
  save(st=>{
    st.trade=null; st.freeRoads=0; st.playedDev=false;
    st.turn = (st.turn+1) % st.players.length;
    st.turnCount++;
    st.phase='roll'; st.dice=null;
    log(st,'➡️', st.players[st.turn].name+'\'s turn.');
  });
  UI.mode=null;
}

function sendChat(){
  const inp=$('chatin'); const msg=inp.value.trim();
  if(!msg || !S) return;
  const nm = me() ? me().name : (myName||'Spectator');
  inp.value='';
  UI.tab='chat';
  save(st=>{ st.chat.push({n:nm, m:msg.slice(0,200)}); });
}

/* ---------- rendering ---------- */

function render(){
  renderToast();
  const home=$('home'), game=$('game');
  if(!gameCode){ home.hidden=false; game.hidden=true; renderHome(); }
  else { home.hidden=true; game.hidden=false; renderGame(); }
  renderOverlay();
}

function renderHome(){
  const el=$('home');
  if(dbMissing){
    el.innerHTML = `<div class="hero"><h1>⬡ Hexhaven</h1>
      <p class="tag">Settle, trade, build — with friends.</p>
      <div class="card pad"><p>The multiplayer connection could not start. Reload the page to try again.</p></div></div>`;
    return;
  }
  const open = lobbyGames.filter(g=>g.status==='lobby');
  const running = lobbyGames.filter(g=>g.status!=='lobby');
  el.innerHTML = `
  <div class="hero">
    <h1>⬡ Hexhaven</h1>
    <p class="tag">Settle, trade, build — the classic hex island game, with every expansion free.</p>
  </div>
  <div class="home-grid">
    <div class="card pad">
      <h2>Found a new game</h2>
      <label class="fld">Your nickname
        <input id="nick" maxlength="20" value="${esc(myName)}" placeholder="e.g. Tej">
      </label>
      <label class="fld">Table name
        <input id="cg-name" maxlength="30" placeholder="Friday night game">
      </label>
      <div class="fld">Map
        ${Object.keys(MAPS).map((m,i)=>`
          <label class="radio"><input type="radio" name="cg-map" value="${m}" ${i===0?'checked':''}>
            <span><b>${MAPS[m].label}</b><br><small>${MAPS[m].sub}</small></span></label>`).join('')}
      </div>
      <label class="fld">Victory points to win
        <select id="cg-vp">${[8,10,12,14].map(v=>`<option ${v===10?'selected':''}>${v}</option>`).join('')}</select>
      </label>
      <button class="btn primary" data-a="create">Create game</button>
      ${readOnly?'<p class="warn">You currently have view-only access to this artifact — the owner must share it with you as Contributor or Editor before you can play.</p>':''}
    </div>
    <div class="card pad">
      <h2>Your recent tables</h2>
      ${open.length? open.map(g=>`
        <button class="gamerow" data-a="open" data-code="${esc(g.code)}">
          <b>${esc(g.name)}</b>
          <span>${MAPS[g.options.map].label} · ${g.players.length}/${g.options.maxP} players · code ${esc(g.code)}</span>
        </button>`).join('') : '<p class="dim">Tables you create or join appear here. Have a code? Enter it below.</p>'}
      <h2 style="margin-top:18px">In progress</h2>
      ${running.length? running.map(g=>`
        <button class="gamerow" data-a="open" data-code="${esc(g.code)}">
          <b>${esc(g.name)}</b>
          <span>${g.status==='over'?'Finished':'Playing'} · ${g.players.map(p=>esc(p.name)).join(', ')}</span>
        </button>`).join(''): '<p class="dim">Nothing underway.</p>'}
      <div class="fld" style="margin-top:14px"><label>Join by code
        <span class="joinrow"><input id="join-code" maxlength="6" placeholder="ABCD" style="text-transform:uppercase">
        <button class="btn" data-a="joincode">Go</button></span></label>
      </div>
    </div>
  </div>
  <p class="foot">An original game in the spirit of the classic settlement board game · <a href="#" data-a="help">how to play</a></p>`;
}

/* ----- game screen ----- */

function phaseText(){
  const t = P(S.turn).name;
  const my = myTurn();
  switch(S.status){
    case 'lobby': return 'Waiting in the lobby';
    case 'over': return '🏆 '+P(S.winner).name+' has won!';
    case 'setup':
      return (my?'Your turn: ':t+' is ')+(S.setup.needRoad?'placing a starting '+(MAPS[S.options.map].ships?'road or ship':'road'):'placing a settlement')+(my?'':'…');
  }
  switch(S.phase){
    case 'roll': return my? 'Your turn — roll the dice!' : t+' is rolling…';
    case 'discard': return '7! Waiting for discards: '+S.players.filter((p,i)=>S.discard[i]>0).map(p=>p.name).join(', ');
    case 'robber': return my? 'Move the robber — click a land hex.' : t+' is moving the robber…';
    case 'steal': return my? 'Choose who to rob.' : t+' is choosing a victim…';
    case 'gold': return '⭐ Gold! Waiting for: '+S.players.filter((p,i)=>S.goldPending[i]>0).map(p=>p.name).join(', ');
    case 'main': return my? 'Your turn — build, trade, or end.' : t+'\'s turn.';
  }
  return '';
}

function renderGame(){
  if(!S){
    $('topbar').innerHTML = `<div class="tb-left"><a class="logo" href="#" data-a="homelink">⬡ Hexhaven</a></div>
      <div class="tb-mid">${loadSlow?'Still trying to reach the table…':'Finding the table…'}</div><div class="tb-right"></div>`;
    $('boardwrap').innerHTML = '<div class="loading">'+(loadSlow?'The table can\'t be reached yet — check your connection.':'Loading game '+esc(gameCode)+'…')+'</div>';
    ['players','actions','context','hand','tabs','feed'].forEach(id=>{ $(id).innerHTML=''; });
    return;
  }
  renderTopbar();
  if(S.status==='lobby') renderLobbyGame();
  else renderBoard();
  renderPlayers();
  renderActions();
  renderContext();
  renderHand();
  renderFeed();
}

function renderTopbar(){
  const dice = S.dice ? `<span class="dice">${die(S.dice[0])}${die(S.dice[1])}<b>${S.dice[0]+S.dice[1]}</b></span>` : '';
  $('topbar').innerHTML = `
    <div class="tb-left">
      <a class="logo" href="#" data-a="homelink">⬡ Hexhaven</a>
      <span class="gname">${esc(S.name)}</span>
      <button class="chip" data-a="copylink" title="Copy invite link">code ${esc(S.code)} ⧉</button>
    </div>
    <div class="tb-mid">${dice}<span class="phase">${esc(phaseText())}</span></div>
    <div class="tb-right">
      <button class="chip" data-a="help">Rules</button>
    </div>`;
}
function die(n){
  const f=['⚀','⚁','⚂','⚃','⚄','⚅'];
  return `<span class="d6">${f[n-1]}</span>`;
}

function renderLobbyGame(){
  const amIn = mi()>=0;
  const isHost = S.hostUid===uid;
  $('boardwrap').innerHTML = `
  <div class="lobbybox card pad">
    <h2>${esc(S.name)}</h2>
    <p class="dim">${MAPS[S.options.map].label} · first to ${S.options.vp} VP · ${S.players.length}/${S.options.maxP} seats taken</p>
    <div class="seats">
      ${S.players.map(p=>`<div class="seat"><span class="pdot" style="background:${PCOLORS[p.color].c}"></span>${esc(p.name)}${p.uid===S.hostUid?' <small>(host)</small>':''}</div>`).join('')}
      ${Array.from({length:Math.max(0,S.options.maxP-S.players.length)}).map(()=>'<div class="seat empty">empty seat</div>').join('')}
    </div>
    ${!amIn && S.players.length<S.options.maxP ? `
      <div class="joinblock">
        <input id="nick2" maxlength="20" value="${esc(myName)}" placeholder="Your nickname">
        <button class="btn primary" data-a="join">Take a seat</button>
      </div>`:''}
    ${amIn && !isHost ? '<p class="dim">Waiting for the host to start…</p><button class="btn" data-a="leave">Leave seat</button>':''}
    ${isHost ? `<div class="hostrow">
        <button class="btn primary" data-a="start" ${S.players.length<2?'disabled':''}>Start game</button>
        <button class="btn danger" data-a="delgame">Delete table</button>
      </div>
      <p class="dim">Share the invite link (top bar) — friends open it, take a seat, then start.</p>`:''}
    ${readOnly?'<p class="warn">View-only access: you can watch, but to play the owner must share the artifact with you as Contributor or Editor.</p>':''}
  </div>`;
}

/* --- board SVG --- */
function renderBoard(){
  const g = geom();
  const b = g.bounds;
  const my = mi();
  let legalV=[], legalE=[], hexMode=false;
  if(myTurn()){
    if(S.status==='setup'){
      if(!S.setup.needRoad) legalV = legalSetupVerts(S,g);
      else legalE = legalSetupEdges(S,g,S.setup.lastV).map(o=>o.key);
    } else if(S.phase==='robber'){ hexMode=true; }
    else if(S.phase==='main'){
      if(UI.mode==='settlement') legalV = legalSettleVerts(S,g,my);
      else if(UI.mode==='city') legalV = legalCityVerts(S,my);
      else if(UI.mode==='road') legalE = legalEdges(S,g,my,'road');
      else if(UI.mode==='ship') legalE = legalEdges(S,g,my,'ship');
    }
  }
  const hexesSvg = S.board.hexes.map(h=>{
    const c = g.hexCenterOf[h.id];
    const pts = g.hexVerts[h.id].map(k=>{const v=g.verts[k];return v.x+','+v.y;}).join(' ');
    const t = TER[h.t];
    const isSea = h.t==='sea';
    const tok = tokenSvg(h, c);
    const rob = h.id===S.robber ? robberSvg(c) : '';
    const glow = hexMode && isLand(h.t) && h.id!==S.robber;
    return `<g ${glow?`class="hexbtn" data-a="hex" data-id="${h.id}"`:''}>
      <polygon points="${pts}" fill="${t.c}" stroke="${isSea?'#17546b':'#1d3b2a33'}" stroke-width="${isSea?1:2.5}" ${glow?'class="glowhex"':''}/>
      ${isSea?'':`<text x="${c.x}" y="${c.y-16}" class="hexemoji">${t.e}</text>`}
      ${tok}${rob}
    </g>`;
  }).join('');

  const portsSvg = S.board.ports.map(p=>{
    const va=g.verts[p.a], vb=g.verts[p.b];
    const mx=(va.x+vb.x)/2, my2=(va.y+vb.y)/2;
    const e = g.edges[ek(p.a,p.b)];
    let lx=0,ly=0,ln=0;
    for(const h of e.hexes){ if(isLand(g.hexById[h].t)){ const c=g.hexCenterOf[h]; lx+=c.x; ly+=c.y; ln++; } }
    let dx=mx-(ln?lx/ln:mx), dy=my2-(ln?ly/ln:my2);
    const d=Math.hypot(dx,dy)||1; dx/=d; dy/=d;
    const px=mx+dx*30, py=my2+dy*30;
    const lbl = p.t==='any' ? '3:1' : '2:1 '+RESI[p.t];
    return `<g class="port">
      <line x1="${va.x}" y1="${va.y}" x2="${px}" y2="${py}"/><line x1="${vb.x}" y1="${vb.y}" x2="${px}" y2="${py}"/>
      <circle cx="${px}" cy="${py}" r="15"/>
      <text x="${px}" y="${py+4}">${lbl}</text></g>`;
  }).join('');

  const roadsSvg = Object.keys(S.roads).map(k=>{
    const e=g.edges[k];
    return edgePiece(g.verts[e.a],g.verts[e.b],pcol(S.roads[k]),false);
  }).join('') + Object.keys(S.ships).map(k=>{
    const e=g.edges[k];
    return edgePiece(g.verts[e.a],g.verts[e.b],pcol(S.ships[k]),true);
  }).join('');

  const buildsSvg = Object.keys(S.builds).map(k=>{
    const v=g.verts[k], bld=S.builds[k];
    return bld.c==='s'
      ? `<path d="M ${v.x-9} ${v.y+8} L ${v.x-9} ${v.y-2} L ${v.x} ${v.y-11} L ${v.x+9} ${v.y-2} L ${v.x+9} ${v.y+8} Z" class="bld" fill="${pcol(bld.p)}"/>`
      : `<path d="M ${v.x-13} ${v.y+9} L ${v.x-13} ${v.y-3} L ${v.x-5} ${v.y-3} L ${v.x-5} ${v.y-12} L ${v.x+3} ${v.y-12} L ${v.x+3} ${v.y-3} L ${v.x+13} ${v.y-3} L ${v.x+13} ${v.y+9} Z" class="bld" fill="${pcol(bld.p)}"/>`;
  }).join('');

  const legalESvg = legalE.map(k=>{
    const e=g.edges[k], va=g.verts[e.a], vb=g.verts[e.b];
    return `<line x1="${va.x}" y1="${va.y}" x2="${vb.x}" y2="${vb.y}" class="legaledge" data-a="edge" data-id="${k}"/>`;
  }).join('');
  const legalVSvg = legalV.map(k=>{
    const v=g.verts[k];
    return `<circle cx="${v.x}" cy="${v.y}" r="11" class="legalvert" data-a="vert" data-id="${k}"/>`;
  }).join('');

  $('boardwrap').innerHTML = `
  <svg id="board" viewBox="${b.minx} ${b.miny} ${b.w} ${b.h}" role="img" aria-label="Game board">
    <rect x="${b.minx}" y="${b.miny}" width="${b.w}" height="${b.h}" fill="#0E3444" rx="12"/>
    ${hexesSvg}${portsSvg}${roadsSvg}${buildsSvg}${legalESvg}${legalVSvg}
  </svg>`;
}
function tokenSvg(h,c){
  if(!h.n) return '';
  const hot = h.n===6||h.n===8;
  const pips = 6-Math.abs(7-h.n);
  let dots='';
  for(let i=0;i<pips;i++) dots += `<circle cx="${c.x-(pips-1)*3+i*6}" cy="${c.y+26}" r="1.8" fill="${hot?'#b3362b':'#4a3b24'}"/>`;
  return `<circle cx="${c.x}" cy="${c.y+14}" r="15" fill="#f7eed9" stroke="#c9b68c"/>
    <text x="${c.x}" y="${c.y+19}" class="tok ${hot?'hot':''}">${h.n}</text>${dots}`;
}
function robberSvg(c){
  return `<g><ellipse cx="${c.x}" cy="${c.y-6}" rx="10" ry="13" fill="#2c2c34"/><circle cx="${c.x}" cy="${c.y-22}" r="7" fill="#2c2c34"/><ellipse cx="${c.x}" cy="${c.y+8}" rx="13" ry="5" fill="#2c2c34"/></g>`;
}
function edgePiece(va,vb,color,ship){
  const mx=(va.x+vb.x)/2, my2=(va.y+vb.y)/2;
  const ax=va.x+(vb.x-va.x)*0.16, ay=va.y+(vb.y-va.y)*0.16;
  const bx=vb.x+(va.x-vb.x)*0.16, by=vb.y+(va.y-vb.y)*0.16;
  const base=`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="8" stroke-linecap="round"/>`;
  if(!ship) return base;
  return base+`<path d="M ${mx-7} ${my2-2} L ${mx+8} ${my2-2} L ${mx+4} ${my2+4} L ${mx-4} ${my2+4} Z" fill="#f3ead2" stroke="${color}"/><path d="M ${mx} ${my2-3} L ${mx} ${my2-14} L ${mx+8} ${my2-4} Z" fill="#f3ead2" stroke="${color}" stroke-width="1"/>`;
}

function renderPlayers(){
  $('players').innerHTML = `<div class="card">
    ${S.players.map((p,i)=>{
      const isTurn = S.status!=='lobby' && S.status!=='over' && i===S.turn;
      const vp = S.board ? calcVP(S,i,false) : 0;
      const hidden = p.dev.filter(d=>d.t==='vp').length;
      const you = p.uid===uid;
      return `<div class="prow ${isTurn?'turn':''}">
        <span class="pdot" style="background:${PCOLORS[p.color].c}"></span>
        <span class="pname">${esc(p.name)}${you?' <small>(you)</small>':''}</span>
        <span class="pstats">
          <span title="Victory points">⭐${vp}${you&&hidden?`<small>+${hidden}</small>`:''}</span>
          <span title="Resource cards">🂠${resTotal(p.res)}</span>
          <span title="Development cards">🎴${p.dev.filter(d=>!d.used).length}</span>
          <span title="Knights played">⚔️${p.knights}</span>
          ${S.longestRoad.p===i?'<span class="badge" title="Longest road">🛤️'+S.longestRoad.len+'</span>':''}
          ${S.largestArmy.p===i?'<span class="badge" title="Largest army">🛡️</span>':''}
          ${S.status==='play'&&S.phase==='discard'&&S.discard[i]>0?'<span class="badge warnb">discarding…</span>':''}
          ${S.status==='play'&&S.phase==='gold'&&S.goldPending[i]>0?'<span class="badge">⭐ picking…</span>':''}
        </span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderActions(){
  const el=$('actions');
  if(S.status!=='play' || mi()<0 || !myTurn()){ el.innerHTML=''; return; }
  const pl=me();
  const rates=portRates(S,mi());
  if(S.phase==='roll'){
    const kn = pl.dev.findIndex(d=>d.t==='knight' && !d.used && d.bt!==S.turnCount);
    el.innerHTML = `<div class="card pad actbar">
      <button class="btn primary big" data-a="roll">🎲 Roll dice</button>
      ${kn>=0 && !S.playedDev?`<button class="btn" data-a="playdev" data-i="${kn}">⚔️ Knight first</button>`:''}
    </div>`;
    return;
  }
  if(S.phase!=='main'){ el.innerHTML=''; return; }
  const canB = k => canAfford(pl.res, COST[k]);
  const shipsOn = MAPS[S.options.map].ships;
  el.innerHTML = `<div class="card pad actbar">
    <div class="buildrow">
      <button class="btn ${UI.mode==='road'?'active':''}" data-a="mode" data-m="road" ${S.freeRoads>0||canB('road')?'':'disabled'} title="1🪵 1🧱">🛤️ Road</button>
      ${shipsOn?`<button class="btn ${UI.mode==='ship'?'active':''}" data-a="mode" data-m="ship" ${S.freeRoads>0||canB('ship')?'':'disabled'} title="1🪵 1🐑">⛵ Ship</button>`:''}
      <button class="btn ${UI.mode==='settlement'?'active':''}" data-a="mode" data-m="settlement" ${canB('settlement')?'':'disabled'} title="1🪵 1🧱 1🐑 1🌾">🏠 Settlement</button>
      <button class="btn ${UI.mode==='city'?'active':''}" data-a="mode" data-m="city" ${canB('city')?'':'disabled'} title="2🌾 3🪨">🏛️ City</button>
      <button class="btn" data-a="buydev" ${canB('dev')&&S.deck.length?'':'disabled'} title="1🐑 1🌾 1🪨 — ${S.deck.length} left">🎴 Dev card</button>
    </div>
    ${UI.mode?'<p class="dim">Click a highlighted spot on the board — Esc to cancel.</p>':''}
    ${S.freeRoads>0?`<p class="dim">Road Building: ${S.freeRoads} free piece${S.freeRoads>1?'s':''} — click the board.</p>`:''}
    <div class="traderow">
      <details ${UI.bankGive||UI.bankGet?'open':''}><summary>⚖️ Bank trade</summary>
        <div class="bankpick">Give ${RES.map(r=>`<button class="chipbtn ${UI.bankGive===r?'sel':''}" data-a="bankgive" data-r="${r}" ${pl.res[r]>=rates[r]?'':'disabled'}>${rates[r]}${RESI[r]}</button>`).join('')}</div>
        <div class="bankpick">Get ${RES.map(r=>`<button class="chipbtn ${UI.bankGet===r?'sel':''}" data-a="bankget" data-r="${r}">1${RESI[r]}</button>`).join('')}</div>
        <button class="btn" data-a="banktrade" ${UI.bankGive&&UI.bankGet?'':'disabled'}>Trade</button>
      </details>
      <details ${Object.keys(UI.trade.give).some(r=>UI.trade.give[r])||Object.keys(UI.trade.want).some(r=>UI.trade.want[r])?'open':''}><summary>🤝 Offer players a trade</summary>
        ${tradeBuilder()}
      </details>
    </div>
    <button class="btn primary" data-a="endturn">End turn ➡️</button>
  </div>`;
}

function tradeBuilder(){
  const row = (which,label) => `<div class="bankpick">${label} ${RES.map(r=>{
    const n=UI.trade[which][r]||0;
    return `<span class="qty"><button class="chipbtn" data-a="tq" data-w="${which}" data-r="${r}" data-d="-1" ${n?'':'disabled'}>−</button>${n}${RESI[r]}<button class="chipbtn" data-a="tq" data-w="${which}" data-r="${r}" data-d="1">+</button></span>`;
  }).join('')}</div>`;
  return row('give','I give')+row('want','I want')+`<button class="btn" data-a="offertrade">Propose to table</button>`;
}

function renderContext(){
  const el=$('context');
  const i=mi();
  let html='';
  if(S.status==='play'){
    if(S.phase==='discard' && i>=0 && S.discard[i]>0){
      const need=S.discard[i], pl=me();
      const total=RES.reduce((a,r)=>a+(UI.discardSel[r]||0),0);
      html = `<div class="card pad urgent"><h3>Discard ${need} cards</h3>
        <div class="bankpick">${RES.map(r=>{
          const n=UI.discardSel[r]||0;
          return `<span class="qty"><button class="chipbtn" data-a="dq" data-r="${r}" data-d="-1" ${n?'':'disabled'}>−</button>${n}/${pl.res[r]}${RESI[r]}<button class="chipbtn" data-a="dq" data-r="${r}" data-d="1" ${n<pl.res[r]?'':'disabled'}>+</button></span>`;
        }).join('')}</div>
        <button class="btn primary" data-a="discard" ${total===need?'':'disabled'}>Discard ${total}/${need}</button></div>`;
    }
    if(S.phase==='steal' && myTurn()){
      const g=geom();
      html += `<div class="card pad urgent"><h3>Steal from…</h3>
        ${robberVictims(S,g).map(v=>`<button class="btn" data-a="steal" data-i="${v}"><span class="pdot" style="background:${pcol(v)}"></span> ${esc(P(v).name)} (${resTotal(P(v).res)} cards)</button>`).join('')}</div>`;
    }
    if(S.phase==='gold' && i>=0 && S.goldPending[i]>0){
      const need=S.goldPending[i];
      const total=RES.reduce((a,r)=>a+(UI.goldSel[r]||0),0);
      html += `<div class="card pad urgent"><h3>⭐ Choose ${need} resource${need>1?'s':''}</h3>
        <div class="bankpick">${RES.map(r=>{
          const n=UI.goldSel[r]||0;
          return `<span class="qty"><button class="chipbtn" data-a="gq" data-r="${r}" data-d="-1" ${n?'':'disabled'}>−</button>${n}${RESI[r]}<button class="chipbtn" data-a="gq" data-r="${r}" data-d="1" ${total<need?'':'disabled'}>+</button></span>`;
        }).join('')}</div>
        <button class="btn primary" data-a="gold" ${total===need?'':'disabled'}>Take ${total}/${need}</button></div>`;
    }
    if(UI.pick==='yop'){
      const total=RES.reduce((a,r)=>a+(UI.yopSel[r]||0),0);
      html += `<div class="card pad urgent"><h3>🎁 Year of Plenty — pick 2</h3>
        <div class="bankpick">${RES.map(r=>{
          const n=UI.yopSel[r]||0;
          return `<span class="qty"><button class="chipbtn" data-a="yq" data-r="${r}" data-d="-1" ${n?'':'disabled'}>−</button>${n}${RESI[r]}<button class="chipbtn" data-a="yq" data-r="${r}" data-d="1" ${total<2?'':'disabled'}>+</button></span>`;
        }).join('')}</div>
        <button class="btn primary" data-a="yop" ${total===2?'':'disabled'}>Take them</button>
        <button class="btn" data-a="cancelpick">Cancel</button></div>`;
    }
    if(UI.pick==='mono'){
      html += `<div class="card pad urgent"><h3>📯 Monopoly — name a resource</h3>
        <div class="bankpick">${RES.map(r=>`<button class="chipbtn" data-a="mono" data-r="${r}">${RESI[r]} ${RESN[r]}</button>`).join('')}</div>
        <button class="btn" data-a="cancelpick">Cancel</button></div>`;
    }
    if(S.trade){
      const t=S.trade;
      const fmt = bag => RES.filter(r=>bag[r]).map(r=>bag[r]+RESI[r]).join(' ') || 'nothing';
      if(i===t.from){
        const accs = t.acc.map((a,j)=>({a,j})).filter(x=>x.a===true);
        html += `<div class="card pad"><h3>🤝 Your offer</h3>
          <p>${fmt(t.give)} → ${fmt(t.want)}</p>
          ${accs.length? accs.map(x=>`<button class="btn primary" data-a="exectrade" data-i="${x.j}">Trade with ${esc(P(x.j).name)}</button>`).join('') : '<p class="dim">Waiting for answers…</p>'}
          <button class="btn" data-a="canceltrade">Withdraw</button></div>`;
      } else if(i>=0){
        const mine = t.acc[i];
        html += `<div class="card pad urgent"><h3>🤝 ${esc(P(t.from).name)} offers</h3>
          <p>You give ${fmt(t.want)} — you get ${fmt(t.give)}</p>
          ${mine===null?`<button class="btn primary" data-a="acctrade">Accept</button><button class="btn" data-a="dectrade">Decline</button>`
            : mine===true?'<p class="dim">You accepted — waiting for them to choose.</p>':'<p class="dim">You declined.</p>'}</div>`;
      }
    }
  }
  if(S.status==='over'){
    html += `<div class="card pad"><h3>🏆 ${esc(P(S.winner).name)} wins!</h3>
      ${S.players.map((p,j)=>`<div class="prow"><span class="pdot" style="background:${pcol(j)}"></span>${esc(p.name)} — ${calcVP(S,j,true)} VP</div>`).join('')}
      ${S.next?`<button class="btn primary" data-a="gorematch">Join the rematch →</button>`
        : (S.hostUid===uid?`<button class="btn primary" data-a="rematch">Play again</button>`:'<p class="dim">Waiting for the host to open a rematch…</p>')}
      ${S.hostUid===uid?'<button class="btn danger" data-a="delgame">Delete table</button>':''}</div>`;
  }
  el.innerHTML=html;
}

function renderHand(){
  const el=$('hand'); const pl=me();
  if(!pl || S.status==='lobby'){ el.innerHTML=''; return; }
  const cards = RES.filter(r=>pl.res[r]>0).map(r=>`<span class="rescard" title="${RESN[r]}">${RESI[r]}<b>×${pl.res[r]}</b></span>`).join('');
  const devs = pl.dev.map((d,idx)=>{
    if(d.used) return '';
    const playable = myTurn() && d.t!=='vp' && d.bt!==S.turnCount && !S.playedDev && (S.phase==='main'||(S.phase==='roll'&&d.t==='knight'));
    return `<div class="devcard"><span>${DEVI[d.t]} <b>${DEVN[d.t]}</b><small>${DEVD[d.t]}</small></span>
      ${d.t==='vp'?'<span class="dim">hidden ⭐</span>':playable?`<button class="btn small" data-a="playdev" data-i="${idx}">Play</button>`:`<span class="dim">${d.bt===S.turnCount?'new':''}</span>`}</div>`;
  }).join('');
  el.innerHTML = `<div class="card pad"><h3>Your hand</h3>
    <div class="handrow">${cards||'<span class="dim">No resources yet.</span>'}</div>
    ${devs?`<div class="devlist">${devs}</div>`:''}</div>`;
}

function renderFeed(){
  const tabs=$('tabs'), feed=$('feed');
  tabs.innerHTML = `<div class="tabrow">
    <button class="tab ${UI.tab==='log'?'sel':''}" data-a="tab" data-t="log">📜 Log</button>
    <button class="tab ${UI.tab==='chat'?'sel':''}" data-a="tab" data-t="chat">💬 Chat ${S.chat.length?`(${S.chat.length})`:''}</button>
  </div>`;
  if(UI.tab==='log'){
    feed.innerHTML = S.log.slice(-40).map(l=>`<div class="logline"><span>${l.t}</span>${esc(l.m)}</div>`).join('')
      || '<div class="dim" style="padding:8px">Nothing yet.</div>';
  } else {
    feed.innerHTML = S.chat.slice(-40).map(c=>`<div class="logline chatline"><b>${esc(c.n)}:</b> ${esc(c.m)}</div>`).join('')
      || '<div class="dim" style="padding:8px">Say hi…</div>';
  }
  feed.scrollTop = feed.scrollHeight;
}

function renderOverlay(){
  const ov=$('overlay');
  if(!UI.showHelp){ ov.hidden=true; return; }
  ov.hidden=false;
  ov.innerHTML = `<div class="sheet card pad">
    <button class="btn close" data-a="closehelp" aria-label="Close">✕</button>
    <h2>How to play</h2>
    <p><b>Goal:</b> first to the table's victory-point target wins. Settlements ⭐1, cities ⭐2, Longest Road (5+) ⭐2, Largest Army (3+ knights) ⭐2, hidden VP cards ⭐1 each — and on Isles & Tides, +1 for each new island you settle.</p>
    <h3>Your turn</h3>
    <p>Roll the dice — every hex with that number pays its neighbors (🏠 1 card, 🏛️ 2). On a <b>7</b>: everyone holding more than 7 cards discards half, then you move the robber and steal a card. Then build, trade with the bank (4:1, cheaper at your ports) or with players, play at most one development card, and end your turn.</p>
    <h3>Building costs</h3>
    <p>🛤️ Road 1🪵 1🧱 · ⛵ Ship 1🪵 1🐑 · 🏠 Settlement 1🪵 1🧱 1🐑 1🌾 (needs your road or ship beside it, and 2 corners from any building) · 🏛️ City 2🌾 3🪨 · 🎴 Dev card 1🐑 1🌾 1🪨</p>
    <h3>Expansions — all free</h3>
    <p><b>The Greater Isle</b> seats 5–6 players on a bigger board with a larger card deck. <b>Isles & Tides</b> adds ⛵ ships that sail the coast and open sea (roads and ships only join up at your settlements), ⭐ gold fields that pay any resource you choose, and +1 VP for your first settlement on each newly reached island (the start island doesn't count). Kept simple on purpose: no pirate ship, ships stay where you place them, and the bank never runs out.</p>
    <h3>Playing with friends</h3>
    <p>Copy the invite link from the top bar and send it — friends open it in any browser and take a seat, no account needed. The game lives in the table creator's browser tab: keep that tab open while you play (if the host refreshes, the game resumes; if the host's tab is closed, others wait until it returns).</p>
  </div>`;
}

/* ---------- events ---------- */

function bump(obj, r, d){
  const n = (obj[r]||0)+d;
  if(n<0) return;
  obj[r]=n;
}

document.addEventListener('click', e=>{
  if(e.target.id==='chatsend'){ sendChat(); return; }
  const t = e.target.closest('[data-a]');
  if(!t) return;
  const a = t.getAttribute('data-a');
  const r = t.getAttribute('data-r');
  const i = t.getAttribute('data-i');
  switch(a){
    case 'homelink': e.preventDefault(); location.hash=''; break;
    case 'help': e.preventDefault(); UI.showHelp=true; renderOverlay(); break;
    case 'closehelp': UI.showHelp=false; renderOverlay(); break;
    case 'create': createGame(); break;
    case 'open': location.hash = t.getAttribute('data-code'); break;
    case 'joincode': { const c=$('join-code').value.trim().toUpperCase(); if(c) location.hash=c; break; }
    case 'join': joinGame(); break;
    case 'leave': leaveGame(); break;
    case 'start': hostStart(); break;
    case 'delgame': if(confirm('Delete this table for everyone?')) deleteGame(); break;
    case 'copylink': {
      const url = location.href.split('#')[0]+'#'+S.code;
      navigator.clipboard?.writeText(url).then(()=>toast('Invite link copied!')).catch(()=>toast(url));
      break;
    }
    case 'roll': rollDice(); break;
    case 'mode': { const m=t.getAttribute('data-m'); UI.mode = UI.mode===m?null:m; render(); break; }
    case 'vert': clickVert(t.getAttribute('data-id')); break;
    case 'edge': clickEdge(t.getAttribute('data-id')); break;
    case 'hex': clickHex(t.getAttribute('data-id')); break;
    case 'steal': stealFrom(parseInt(i,10)); break;
    case 'buydev': buyDev(); break;
    case 'playdev': playDev(parseInt(i,10)); break;
    case 'dq': bump(UI.discardSel, r, parseInt(t.getAttribute('data-d'),10)); renderContext(); break;
    case 'gq': bump(UI.goldSel, r, parseInt(t.getAttribute('data-d'),10)); renderContext(); break;
    case 'yq': bump(UI.yopSel, r, parseInt(t.getAttribute('data-d'),10)); renderContext(); break;
    case 'discard': submitDiscard(); break;
    case 'gold': submitGold(); break;
    case 'yop': submitYop(); break;
    case 'mono': submitMono(r); break;
    case 'cancelpick': UI.pick=null; render(); break;
    case 'bankgive': UI.bankGive = UI.bankGive===r?null:r; renderActions(); break;
    case 'bankget': UI.bankGet = UI.bankGet===r?null:r; renderActions(); break;
    case 'banktrade': bankTrade(); break;
    case 'tq': bump(UI.trade[t.getAttribute('data-w')], r, parseInt(t.getAttribute('data-d'),10)); renderActions(); break;
    case 'offertrade': offerTrade(); break;
    case 'acctrade': respondTrade(true); break;
    case 'dectrade': respondTrade(false); break;
    case 'exectrade': execTrade(parseInt(i,10)); break;
    case 'canceltrade': cancelTrade(); break;
    case 'endturn': endTurn(); break;
    case 'tab': UI.tab=t.getAttribute('data-t'); renderFeed(); break;
    case 'rematch': rematch(); break;
    case 'gorematch': location.hash=S.next; break;
  }
});
document.addEventListener('keydown', e=>{
  if(e.key==='Enter' && e.target.id==='chatin') sendChat();
  if(e.key==='Enter' && e.target.id==='join-code'){ const c=$('join-code').value.trim().toUpperCase(); if(c) location.hash=c; }
  if(e.key==='Escape' && (UI.mode||UI.showHelp)){ UI.mode=null; UI.showHelp=false; render(); }
});

/* ---------- boot ---------- */
const boot = ()=>{ init(); };
window.claude?.hot?.ready ? window.claude.hot.ready(()=>boot()) : boot();
