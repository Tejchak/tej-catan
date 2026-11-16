'use strict';
/* Hexhaven — standalone multiplayer transport (GitHub Pages build).
   Implements the tiny document-store subset that ui.js uses
   (doc.set / doc.onSnapshot / doc.delete + a recent-games query) over
   PeerJS WebRTC. The table's creator ("host") is the authority: their
   browser holds the state; everyone else proposes new states to them.
   Loaded after core.js and before ui.js; defines window.claude.use. */

(function(){
  const PREFIX = 'hxhvn7-';          // namespaces our peer ids on the public broker
  const hosted  = {};                // code -> {peer, state, conns:Set, subs:Set}
  const clients = {};                // code -> {peer, conn, subs:Set, retry, closed, everGot}
  const lobbySubs = new Set();

  /* ---- recent-tables index (this browser only; stands in for the lobby) ---- */
  function recentList(){
    try{ return JSON.parse(localStorage.getItem('hx_recent')||'[]'); }catch(e){ return []; }
  }
  function touchRecent(st){
    try{
      let list = recentList().filter(g=>g.code!==st.code);
      list.unshift({code:st.code, name:st.name, status:st.status, created:st.created,
        options:{map:st.options.map, maxP:st.options.maxP},
        players:st.players.map(p=>({name:p.name}))});
      localStorage.setItem('hx_recent', JSON.stringify(list.slice(0,20)));
    }catch(e){}
    notifyLobby();
  }
  function dropRecent(code){
    try{ localStorage.setItem('hx_recent', JSON.stringify(recentList().filter(g=>g.code!==code))); }catch(e){}
    notifyLobby();
  }
  function snap(code, data){
    return {id:code, exists:!!data, data:()=>data||undefined,
            metadata:{fromCache:false, hasPendingWrites:false}};
  }
  function notifyLobby(){
    const docs = recentList().map(g=>snap(g.code,g));
    const qs = {docs, size:docs.length, empty:!docs.length, docChanges:()=>[],
                metadata:{fromCache:false, hasPendingWrites:false}};
    lobbySubs.forEach(cb=>{ try{ cb(qs); }catch(e){} });
  }

  /* ---- host-side persistence so a refreshed host resumes the table ---- */
  function persist(code, state){ try{ localStorage.setItem('hx_game_'+code, JSON.stringify(state)); }catch(e){} }
  function stored(code){ try{ const s=localStorage.getItem('hx_game_'+code); return s?JSON.parse(s):null; }catch(e){ return null; } }
  function unpersist(code){ try{ localStorage.removeItem('hx_game_'+code); }catch(e){} }

  /* ---- hosting ---- */
  function hostApply(h, state){
    h.state = state; persist(state.code, state); touchRecent(state);
    const msg = {t:'state', s:state};
    h.conns.forEach(c=>{ try{ c.send(msg); }catch(e){} });
    h.subs.forEach(cb=>{ try{ cb(snap(state.code, state)); }catch(e){} });
  }
  function startHost(code, initialState){
    const h = hosted[code] = {peer:null, state:initialState, conns:new Set(), subs:new Set()};
    const peer = h.peer = new Peer(PREFIX+code, {debug:0});
    peer.on('connection', conn=>{
      conn.on('open', ()=>{ h.conns.add(conn); if(h.state) conn.send({t:'state', s:h.state}); });
      conn.on('data', m=>{
        if(!m || m.t!=='propose' || !m.s || m.s.code!==code) return;
        if(!h.state || (m.s.v||0) > (h.state.v||0)) hostApply(h, m.s);
        else { try{ conn.send({t:'state', s:h.state}); }catch(e){} } // resync stale client
      });
      conn.on('close', ()=>h.conns.delete(conn));
    });
    peer.on('disconnected', ()=>{ try{ peer.reconnect(); }catch(e){} });
    peer.on('error', err=>{
      if(err && err.type==='unavailable-id'){
        // another tab or device of ours is already hosting: fall back to client
        const subs = h.subs; delete hosted[code];
        try{ peer.destroy(); }catch(e){}
        const c = clients[code] || startClient(code);
        subs.forEach(cb=>c.subs.add(cb));
      }
    });
    if(initialState) hostApply(h, initialState);
    return h;
  }

  /* ---- joining ---- */
  function startClient(code){
    const c = clients[code] = {peer:null, conn:null, subs:new Set(), retry:null, closed:false, everGot:false};
    const peer = c.peer = new Peer({debug:0});
    function connect(){
      if(c.closed) return;
      const conn = peer.connect(PREFIX+code, {reliable:true});
      c.conn = conn;
      conn.on('data', m=>{
        if(!m) return;
        if(m.t==='state' && m.s){
          c.everGot = true; touchRecent(m.s);
          c.subs.forEach(cb=>{ try{ cb(snap(code, m.s)); }catch(e){} });
        }
        if(m.t==='deleted'){
          dropRecent(code);
          c.subs.forEach(cb=>{ try{ cb(snap(code, null)); }catch(e){} });
        }
      });
      conn.on('close', ()=>{ if(!c.closed) c.retry = setTimeout(connect, 3000); });
    }
    peer.on('open', connect);
    peer.on('error', err=>{
      if(err && err.type==='peer-unavailable'){
        if(!c.everGot){
          // no host online right now: unknown code, or the host's tab is closed
          c.subs.forEach(cb=>{ try{ cb(snap(code, null)); }catch(e){} });
        }
        if(!c.closed) c.retry = setTimeout(connect, 3000);
      }
    });
    peer.on('disconnected', ()=>{ try{ peer.reconnect(); }catch(e){} });
    return c;
  }
  function stopClient(code){
    const c = clients[code];
    if(!c) return;
    c.closed = true;
    clearTimeout(c.retry);
    try{ c.peer.destroy(); }catch(e){}
    delete clients[code];
  }

  /* ---- the document-store subset ui.js talks to ---- */
  function docRef(path){
    const m = /^games\/([A-Z0-9]{4,6})$/.exec(path);
    if(!m) throw new TypeError('unsupported path: '+path);
    const code = m[1];
    return {
      id: code, path,
      async set(state){
        if(hosted[code]){ hostApply(hosted[code], state); return; }
        const c = clients[code];
        if(c && c.conn && c.conn.open){ c.conn.send({t:'propose', s:state}); return; }
        if(c){ return; }               // joining mid-handshake: host will resync us
        startHost(code, state);        // brand-new table: we become its host
      },
      async delete(){
        const h = hosted[code];
        if(!h) return;
        h.conns.forEach(cn=>{ try{ cn.send({t:'deleted'}); }catch(e){} });
        h.subs.forEach(cb=>{ try{ cb(snap(code, null)); }catch(e){} });
        try{ h.peer.destroy(); }catch(e){}
        delete hosted[code];
        unpersist(code); dropRecent(code);
      },
      onSnapshot(cb){
        if(hosted[code]){
          hosted[code].subs.add(cb);
          if(hosted[code].state) cb(snap(code, hosted[code].state));
          return ()=>{ hosted[code] && hosted[code].subs.delete(cb); };
        }
        const saved = stored(code);
        if(saved){
          // we hosted this table before: resume hosting with the saved state
          // (falls back to client automatically if another of our tabs holds it)
          const h = startHost(code, saved);
          h.subs.add(cb);
          if(h.state) cb(snap(code, h.state));
          return ()=>{
            if(hosted[code]) hosted[code].subs.delete(cb);
            else if(clients[code]) clients[code].subs.delete(cb);
          };
        }
        const c = clients[code] || startClient(code);
        c.subs.add(cb);
        return ()=>{ const cc=clients[code]; if(cc){ cc.subs.delete(cb); if(!cc.subs.size) stopClient(code); } };
      }
    };
  }
  const lobbyQuery = {
    orderBy(){ return lobbyQuery; },
    limit(){ return lobbyQuery; },
    where(){ return lobbyQuery; },
    onSnapshot(cb){ lobbySubs.add(cb); notifyLobby(); return ()=>lobbySubs.delete(cb); },
    async get(){ const docs=recentList().map(g=>snap(g.code,g)); return {docs, size:docs.length, empty:!docs.length, docChanges:()=>[], metadata:{fromCache:false,hasPendingWrites:false}}; }
  };
  const dbShim = {
    doc: docRef,
    collection(path){ if(path!=='games') throw new TypeError('unsupported collection: '+path); return lobbyQuery; }
  };

  window.HX = { isHost: code => !!hosted[code] };
  if(!window.claude){
    window.claude = { use: async name => name==='db' ? dbShim : null };
  }
})();
