'use strict';
/* Hexhaven — core engine: constants, hex geometry, board generation, rules. */

const RES = ['wood','brick','sheep','wheat','ore'];
const RESI = {wood:'🪵',brick:'🧱',sheep:'🐑',wheat:'🌾',ore:'🪨',gold:'⭐'};
const RESN = {wood:'Lumber',brick:'Brick',sheep:'Wool',wheat:'Grain',ore:'Ore'};
const TER = {
  forest:  {res:'wood',  c:'#1D8A4E', e:'🌲'},
  hill:    {res:'brick', c:'#C65A2E', e:'🧱'},
  pasture: {res:'sheep', c:'#A3CF4F', e:'🐑'},
  field:   {res:'wheat', c:'#F2C12E', e:'🌾'},
  mountain:{res:'ore',   c:'#94A3B8', e:'⛰️'},
  desert:  {res:null,    c:'#E7D8A7', e:'🏜️'},
  gold:    {res:'gold',  c:'#F5C518', e:'⭐'},
  sea:     {res:null,    c:'#1BA2D8', e:''}
};
const PCOLORS = [
  {n:'Red',    c:'#E03C31'},
  {n:'Blue',   c:'#2563EB'},
  {n:'Orange', c:'#F08C21'},
  {n:'Green',  c:'#16A34A'},
  {n:'Purple', c:'#8B5CF6'},
  {n:'Brown',  c:'#8D6E63'}
];
const COST = {
  road:      {wood:1, brick:1},
  ship:      {wood:1, sheep:1},
  settlement:{wood:1, brick:1, sheep:1, wheat:1},
  city:      {wheat:2, ore:3},
  dev:       {sheep:1, wheat:1, ore:1}
};
const COSTN = {road:'Road', ship:'Ship', settlement:'Settlement', city:'City', dev:'Development card'};
const DEVN = {knight:'Knight', vp:'Victory Point', rb:'Road Building', yop:'Year of Plenty', mono:'Monopoly'};
const DEVI = {knight:'⚔️', vp:'🏆', rb:'🛤️', yop:'🎁', mono:'📯'};
const DEVD = {
  knight:'Move the robber and steal 1 card from a player beside it.',
  vp:'1 hidden victory point. Counts automatically.',
  rb:'Place 2 roads (or ships) for free.',
  yop:'Take any 2 resources from the bank.',
  mono:'Name a resource; every other player gives you all of theirs.'
};
const PIECE_LIMIT = {road:15, ship:15, settlement:5, city:4};
const MAPS = {
  classic:{label:'The Classic Isle', sub:'The original 19-hex island. 2–4 players.', maxP:4, vp:10, ships:false},
  big:    {label:'The Greater Isle', sub:'Extended board for 5–6 players.',          maxP:6, vp:10, ships:false},
  sea:    {label:'Isles & Tides',    sub:'Seafarers: ships, gold fields, island discovery. 2–4 players.', maxP:4, vp:12, ships:true}
};

function shuffle(a){
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}

/* ---------- geometry ----------
   Pointy-top hexes, axial coords. Vertex identity = rounded pixel position,
   so shared corners collapse to one key deterministically on every client. */
const HEXS = 54; // hex radius in board units
const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];

function hexCenter(q,r){ return {x: HEXS*Math.sqrt(3)*(q + r/2), y: HEXS*1.5*r}; }
function vk(x,y){ return Math.round(x*2)+','+Math.round(y*2); }
function ek(a,b){ return a<b ? a+'|'+b : b+'|'+a; }

function buildGeom(hexes){
  const verts = {}, edges = {}, hexVerts = {}, hexCenterOf = {}, hexById = {};
  let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  for(const h of hexes){
    hexById[h.id] = h;
    const c = hexCenter(h.q, h.r);
    hexCenterOf[h.id] = c;
    const corners = [];
    for(let k=0;k<6;k++){
      const ang = (60*k - 30) * Math.PI/180;
      const x = c.x + HEXS*Math.cos(ang), y = c.y + HEXS*Math.sin(ang);
      corners.push({x,y,key:vk(x,y)});
      if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y;
    }
    hexVerts[h.id] = corners.map(p=>p.key);
    for(let k=0;k<6;k++){
      const p = corners[k];
      let v = verts[p.key];
      if(!v) v = verts[p.key] = {x:p.x, y:p.y, hexes:[], edges:[]};
      if(!v.hexes.includes(h.id)) v.hexes.push(h.id);
      const p2 = corners[(k+1)%6];
      const key = ek(p.key, p2.key);
      let e = edges[key];
      if(!e) e = edges[key] = {a:p.key, b:p2.key, hexes:[]};
      if(!e.hexes.includes(h.id)) e.hexes.push(h.id);
    }
  }
  for(const key in edges){
    const e = edges[key];
    for(const v of [e.a, e.b]){
      if(!verts[v].edges.includes(key)) verts[v].edges.push(key);
    }
  }
  for(const key in verts){
    const v = verts[key];
    v.adj = v.edges.map(e => { const E=edges[e]; return E.a===key ? E.b : E.a; });
  }
  return {verts, edges, hexVerts, hexCenterOf, hexById,
          bounds:{minx:minx-44, miny:miny-44, w:maxx-minx+88, h:maxy-miny+88}};
}

/* ---------- board generation ---------- */

function hexagonCoords(radius){
  const out = [];
  for(let q=-radius;q<=radius;q++)
    for(let r=-radius;r<=radius;r++)
      if(Math.abs(q+r)<=radius) out.push([q,r]);
  return out;
}

function isLand(t){ return t!=='sea'; }
function producesHere(t){ return isLand(t) && t!=='desert'; }

/* Assign number tokens so 6s and 8s never touch. */
function assignNumbers(cells, pool){
  const idx = new Map(cells.map((c,i)=>[c.q+','+c.r, i]));
  for(let attempt=0; attempt<600; attempt++){
    const nums = shuffle(pool.slice());
    let ok = true;
    outer:
    for(let i=0;i<cells.length;i++){
      if(nums[i]!==6 && nums[i]!==8) continue;
      for(const [dq,dr] of DIRS){
        const j = idx.get((cells[i].q+dq)+','+(cells[i].r+dr));
        if(j!==undefined && (nums[j]===6 || nums[j]===8)){ ok=false; break outer; }
      }
    }
    if(ok || attempt===599){
      cells.forEach((c,i)=> c.n = nums[i]);
      return;
    }
  }
}

/* Pick ports on coastal edges, spread around the shore, no shared corners. */
function placePorts(hexes, geom, types, mainOnly){
  const landIds = new Set(hexes.filter(h=>isLand(h.t) && (!mainOnly || h.island===0)).map(h=>h.id));
  const seaIds  = new Set(hexes.filter(h=>h.t==='sea').map(h=>h.id));
  const coastal = [];
  for(const key in geom.edges){
    const e = geom.edges[key];
    const touchesLand = e.hexes.some(h=>landIds.has(h));
    const touchesOpen = e.hexes.some(h=>seaIds.has(h)) || e.hexes.length===1;
    if(touchesLand && touchesOpen) coastal.push(key);
  }
  // order around the shore by angle from land centroid
  let cx=0, cy=0, n=0;
  for(const h of hexes) if(landIds.has(h.id)){ const c=geom.hexCenterOf[h.id]; cx+=c.x; cy+=c.y; n++; }
  cx/=n; cy/=n;
  coastal.sort((a,b)=>{
    const ea=geom.edges[a], eb=geom.edges[b];
    const ma={x:(geom.verts[ea.a].x+geom.verts[ea.b].x)/2, y:(geom.verts[ea.a].y+geom.verts[ea.b].y)/2};
    const mb={x:(geom.verts[eb.a].x+geom.verts[eb.b].x)/2, y:(geom.verts[eb.a].y+geom.verts[eb.b].y)/2};
    return Math.atan2(ma.y-cy, ma.x-cx) - Math.atan2(mb.y-cy, mb.x-cx);
  });
  const want = types.length;
  const ports = [];
  const usedVerts = new Set();
  const step = coastal.length / want;
  let ti = 0;
  for(let i=0; i<want; i++){
    for(let off=0; off<coastal.length; off++){
      const key = coastal[(Math.round(i*step)+off) % coastal.length];
      const e = geom.edges[key];
      if(usedVerts.has(e.a) || usedVerts.has(e.b)) continue;
      ports.push({a:e.a, b:e.b, t:types[ti++]});
      usedVerts.add(e.a); usedVerts.add(e.b);
      break;
    }
  }
  return ports;
}

function finishBoard(cells, portTypes, mainOnly){
  const hexes = cells.map((c,i)=>({id:'h'+i, q:c.q, r:c.r, t:c.t, n:c.n||0, island:c.island||0}));
  const geom = buildGeom(hexes);
  const ports = placePorts(hexes, geom, shuffle(portTypes), mainOnly);
  const desert = hexes.find(h=>h.t==='desert');
  return {hexes, ports, robberStart: desert ? desert.id : hexes.find(h=>isLand(h.t)).id};
}

function genClassic(){
  const coords = hexagonCoords(2);
  const pool = shuffle(['forest','forest','forest','forest','field','field','field','field',
    'pasture','pasture','pasture','pasture','hill','hill','hill','mountain','mountain','mountain','desert']);
  const cells = coords.map(([q,r],i)=>({q,r,t:pool[i],island:0}));
  const numbered = cells.filter(c=>producesHere(c.t));
  assignNumbers(numbered, [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12]);
  return finishBoard(cells, ['any','any','any','any','wood','brick','sheep','wheat','ore'], false);
}

function genBig(){
  // 5-6 player shape: rows of 3,4,5,6,5,4,3 (odd-r offset) = 30 hexes
  const rows = [3,4,5,6,5,4,3];
  const cells = [];
  rows.forEach((len,row)=>{
    const c0 = Math.floor((6-len)/2);
    for(let c=c0;c<c0+len;c++){
      cells.push({q: c - ((row - (row&1))/2), r: row, island:0});
    }
  });
  const pool = shuffle(['forest','forest','forest','forest','forest','forest',
    'field','field','field','field','field','field',
    'pasture','pasture','pasture','pasture','pasture','pasture',
    'hill','hill','hill','hill','hill','mountain','mountain','mountain','mountain','mountain',
    'desert','desert']);
  cells.forEach((c,i)=> c.t = pool[i]);
  const numbered = cells.filter(c=>producesHere(c.t));
  assignNumbers(numbered, [2,2,3,3,3,4,4,4,5,5,5,6,6,6,8,8,8,9,9,9,10,10,10,11,11,11,12,12]);
  return finishBoard(cells, ['any','any','any','any','any','wood','brick','sheep','sheep','wheat','ore'], false);
}

function genSea(){
  // Hand-set scenario: one main island, a channel of open sea, three small
  // isles to discover (two of them hiding gold fields). odd-r offset template.
  const T = [
    'wwwwwwww',
    'wlllwwii',
    'wllllwww',
    'wllllwig',
    'wllllwww',
    'wlllwwgi',
    'wwwwwwww'
  ];
  const cells = [];
  T.forEach((rowStr,row)=>{
    for(let c=0;c<rowStr.length;c++){
      cells.push({q: c - ((row - (row&1))/2), r: row, mark: rowStr[c]});
    }
  });
  const main = cells.filter(c=>c.mark==='l');
  const isle = cells.filter(c=>c.mark==='i' || c.mark==='g');
  const seaC = cells.filter(c=>c.mark==='w');
  const mainPool = shuffle(['forest','forest','forest','forest','field','field','field','field',
    'pasture','pasture','pasture','hill','hill','hill','mountain','mountain','mountain','desert']);
  main.forEach((c,i)=>{ c.t = mainPool[i]; c.island = 0; });
  const islePool = shuffle(['forest','hill','pasture','field','mountain']);
  let gi = 0;
  isle.forEach(c=>{ c.t = c.mark==='g' ? 'gold' : islePool[gi++ % islePool.length]; });
  seaC.forEach(c=>{ c.t='sea'; c.island=-1; });
  // island ids for the isles via flood fill (main stays 0)
  let nextIsland = 1;
  const landMap = new Map(cells.filter(c=>isLand(c.t)).map(c=>[c.q+','+c.r, c]));
  for(const c of isle){
    if(c.island !== undefined) continue;
    const stack=[c]; c.island = nextIsland;
    while(stack.length){
      const cur = stack.pop();
      for(const [dq,dr] of DIRS){
        const nb = landMap.get((cur.q+dq)+','+(cur.r+dr));
        if(nb && nb.island===undefined){ nb.island = nextIsland; stack.push(nb); }
      }
    }
    nextIsland++;
  }
  const numbered = cells.filter(c=>producesHere(c.t));
  assignNumbers(numbered, [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12,3,4,5,9,10].slice(0, numbered.length));
  return finishBoard(cells, ['any','any','any','wood','brick','sheep','wheat'], true);
}

function makeDeck(map){
  const d = [];
  const add=(t,n)=>{for(let i=0;i<n;i++)d.push(t);};
  if(map==='big'){ add('knight',20); add('vp',5); add('rb',3); add('yop',3); add('mono',3); }
  else { add('knight',14); add('vp',5); add('rb',2); add('yop',2); add('mono',2); }
  return shuffle(d);
}

/* ---------- rules helpers (pure; st = game state, geom from buildGeom) ---------- */

function resTotal(bag){ let n=0; for(const r of RES) n += bag[r]||0; return n; }
function canAfford(bag, cost){ return Object.keys(cost).every(r => (bag[r]||0) >= cost[r]); }
function payCost(bag, cost){ for(const r in cost) bag[r] -= cost[r]; }

function pieceCount(st, p, kind){
  if(kind==='road' || kind==='ship'){
    const src = kind==='road' ? st.roads : st.ships;
    let n=0; for(const k in src) if(src[k]===p) n++; return n;
  }
  let n=0; for(const k in st.builds){ const b=st.builds[k]; if(b.p===p && b.c===(kind==='city'?'c':'s')) n++; }
  return n;
}

function vertTouchesLand(geom, v){
  return geom.verts[v].hexes.some(h => isLand(geom.hexById[h].t));
}
function distanceOk(st, geom, v){
  if(st.builds[v]) return false;
  return geom.verts[v].adj.every(a => !st.builds[a]);
}
function edgeOwner(st, key){
  if(st.roads[key]!==undefined) return {p:st.roads[key], t:'road'};
  if(st.ships[key]!==undefined) return {p:st.ships[key], t:'ship'};
  return null;
}
function vertHasPlayerEdge(st, geom, v, p){
  return geom.verts[v].edges.some(e => { const o=edgeOwner(st,e); return o && o.p===p; });
}

function legalSetupVerts(st, geom){
  const mainOnly = st.options.map==='sea';
  const out = [];
  for(const v in geom.verts){
    if(!distanceOk(st, geom, v)) continue;
    const lands = geom.verts[v].hexes.filter(h=>isLand(geom.hexById[h].t));
    if(!lands.length) continue;
    if(mainOnly && !lands.some(h=>geom.hexById[h].island===0)) continue;
    out.push(v);
  }
  return out;
}
function legalSettleVerts(st, geom, p){
  const out = [];
  for(const v in geom.verts){
    if(!distanceOk(st, geom, v)) continue;
    if(!vertTouchesLand(geom, v)) continue;
    if(!vertHasPlayerEdge(st, geom, v, p)) continue;
    out.push(v);
  }
  return out;
}
function legalCityVerts(st, p){
  const out = [];
  for(const v in st.builds){ const b=st.builds[v]; if(b.p===p && b.c==='s') out.push(v); }
  return out;
}
function edgeEligible(geom, key, type){
  const e = geom.edges[key];
  if(type==='road') return e.hexes.some(h => isLand(geom.hexById[h].t));
  // ships: any edge bordering sea, or on the open rim
  return e.hexes.some(h => geom.hexById[h].t==='sea') || e.hexes.length===1;
}
function edgeConnected(st, geom, key, p, type){
  const e = geom.edges[key];
  for(const v of [e.a, e.b]){
    const b = st.builds[v];
    if(b){ if(b.p===p) return true; continue; } // enemy building blocks this endpoint
    for(const other of geom.verts[v].edges){
      if(other===key) continue;
      const o = edgeOwner(st, other);
      if(o && o.p===p && o.t===type) return true; // same network type continues
    }
  }
  return false;
}
function legalEdges(st, geom, p, type){
  const out = [];
  for(const key in geom.edges){
    if(edgeOwner(st,key)) continue;
    if(!edgeEligible(geom, key, type)) continue;
    if(!edgeConnected(st, geom, key, p, type)) continue;
    out.push(key);
  }
  return out;
}
function legalSetupEdges(st, geom, lastV){
  const out = [];
  const allowShips = MAPS[st.options.map].ships;
  for(const key of geom.verts[lastV].edges){
    if(edgeOwner(st,key)) continue;
    if(edgeEligible(geom, key, 'road')) out.push({key, t:'road'});
    else if(allowShips && edgeEligible(geom, key, 'ship')) out.push({key, t:'ship'});
  }
  return out;
}

function portRates(st, p){
  const rates = {}; RES.forEach(r=>rates[r]=4);
  for(const port of st.board.ports){
    const mine = [port.a, port.b].some(v => st.builds[v] && st.builds[v].p===p);
    if(!mine) continue;
    if(port.t==='any'){ RES.forEach(r=>{ if(rates[r]>3) rates[r]=3; }); }
    else rates[port.t] = 2;
  }
  return rates;
}

function produce(st, geom, roll){
  const gains = st.players.map(()=>({}));
  const gold  = st.players.map(()=>0);
  for(const h of st.board.hexes){
    if(h.n!==roll || h.id===st.robber) continue;
    const res = TER[h.t].res;
    if(!res) continue;
    for(const v of geom.hexVerts[h.id]){
      const b = st.builds[v];
      if(!b) continue;
      const amt = b.c==='c' ? 2 : 1;
      if(res==='gold') gold[b.p] += amt;
      else gains[b.p][res] = (gains[b.p][res]||0) + amt;
    }
  }
  return {gains, gold};
}

function longestRoute(st, geom, p){
  const mine = {};
  for(const k in st.roads) if(st.roads[k]===p) mine[k]='road';
  for(const k in st.ships) if(st.ships[k]===p) mine[k]='ship';
  const keys = Object.keys(mine);
  if(!keys.length) return 0;
  const byVert = {};
  for(const k of keys){
    const e = geom.edges[k];
    (byVert[e.a] = byVert[e.a]||[]).push(k);
    (byVert[e.b] = byVert[e.b]||[]).push(k);
  }
  const enemyAt = v => st.builds[v] && st.builds[v].p!==p;
  const ownAt   = v => st.builds[v] && st.builds[v].p===p;
  let best = 0;
  function dfs(v, fromType, used, len){
    if(len>best) best=len;
    if(fromType!==null && enemyAt(v)) return;       // route cannot pass an enemy building
    for(const k of (byVert[v]||[])){
      if(used.has(k)) continue;
      const t = mine[k];
      if(fromType!==null && t!==fromType && !ownAt(v)) continue; // road↔ship only at own building
      used.add(k);
      const e = geom.edges[k];
      dfs(e.a===v ? e.b : e.a, t, used, len+1);
      used.delete(k);
    }
  }
  for(const v in byVert) dfs(v, null, new Set(), 0);
  return best;
}

function updateLongestRoad(st, geom){
  const lens = st.players.map((_,i)=>longestRoute(st, geom, i));
  const cur = st.longestRoad;
  if(cur.p!==null && lens[cur.p]>=5){
    let mp = cur.p, max = lens[cur.p];
    lens.forEach((l,i)=>{ if(l>max){ max=l; mp=i; } }); // strict beat required
    st.longestRoad = {p:mp, len:lens[mp]};
  } else {
    let max = 0; lens.forEach(l=>{ if(l>max) max=l; });
    if(max>=5){
      const cands = [];
      lens.forEach((l,i)=>{ if(l===max) cands.push(i); });
      st.longestRoad = cands.length===1 ? {p:cands[0], len:max} : {p:null, len:0};
    } else st.longestRoad = {p:null, len:0};
  }
}

function updateLargestArmy(st){
  const cur = st.largestArmy;
  st.players.forEach((pl,i)=>{
    if(i===cur.p){ st.largestArmy.n = pl.knights; return; }
    const need = cur.p===null ? 3 : st.largestArmy.n+1;
    if(pl.knights>=3 && pl.knights>=need) st.largestArmy = {p:i, n:pl.knights};
  });
}

function calcVP(st, i, withHidden){
  let v = 0;
  for(const k in st.builds){ const b=st.builds[k]; if(b.p===i) v += b.c==='c' ? 2 : 1; }
  if(st.longestRoad.p===i) v += 2;
  if(st.largestArmy.p===i) v += 2;
  v += (st.players[i].islands||[]).length;
  if(withHidden) v += st.players[i].dev.filter(d=>d.t==='vp').length;
  return v;
}

function robberVictims(st, geom){
  const out = new Set();
  for(const v of geom.hexVerts[st.robber] || []){
    const b = st.builds[v];
    if(b && b.p!==st.turn && resTotal(st.players[b.p].res)>0) out.add(b.p);
  }
  return [...out];
}

/* setup order: 0..n-1 then n-1..0 */
function setupSeq(n){
  const s = [];
  for(let i=0;i<n;i++) s.push(i);
  for(let i=n-1;i>=0;i--) s.push(i);
  return s;
}

function newPlayer(uid, name, colorIdx){
  const res = {}; RES.forEach(r=>res[r]=0);
  return {uid, name, color: colorIdx, res, dev: [], knights: 0, islands: []};
}

function newGameState(opts, host){
  return {
    v: 1,
    code: opts.code,
    name: opts.name,
    created: Date.now(),
    status: 'lobby',
    options: {map: opts.map, vp: opts.vp, maxP: opts.maxP, timer: opts.timer||0},
    hostUid: host.uid,
    players: [newPlayer(host.uid, host.name, 0)],
    board: null,
    turn: 0, turnCount: 0,
    phase: 'roll', dice: null,
    robber: null,
    roads: {}, ships: {}, builds: {},
    deck: [], discard: [], goldPending: [],
    trade: null, freeRoads: 0, playedDev: false, after: 'main',
    setup: null,
    longestRoad: {p:null, len:0},
    largestArmy: {p:null, n:0},
    winner: null, next: null,
    log: [], chat: []
  };
}

function beginGame(st){
  shuffle(st.players);
  st.players.forEach((p,i)=>p.color=i);
  const gen = st.options.map==='big' ? genBig : st.options.map==='sea' ? genSea : genClassic;
  const b = gen();
  st.board = {hexes: b.hexes, ports: b.ports};
  st.robber = b.robberStart;
  st.deck = makeDeck(st.options.map);
  st.status = 'setup';
  st.setup = {count: 0, needRoad: false, lastV: null};
  st.turn = 0;
  st.turnStart = Date.now();
  st.log.push({t:'🏁', m:'The game begins! Place your first settlement.'});
}
