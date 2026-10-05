/**
 * PEER-TO-PEER NETWORKING (PeerJS / WebRTC)
 *
 * GitHub Pages can only serve files, so there is no game server. Instead the
 * host's browser runs the engine (engine.js) and every other player connects
 * straight to the host's browser. The free public PeerJS service is used only
 * to introduce browsers to each other; game traffic flows directly between them.
 *
 *   room code ABCDE  ->  host registers peer id "suitderby-v1-ABCDE"
 *   player joins     ->  connects to that id, sends { t:'hello', token, name }
 *   player acts      ->  { t:'req', id, ev, data }  host replies { t:'res', id, res }
 *   any change       ->  host sends { t:'state', s } to everyone
 *
 * The UI talks to this module only through Net.request(), Net.on() and the
 * host/join/leave functions, so it never needs to know who is hosting.
 */
window.Net = (() => {
  const PREFIX = 'suitderby-v1-';
  const listeners = {};
  const on = (ev, fn) => ((listeners[ev] = listeners[ev] || []).push(fn));
  const fire = (ev, data) => (listeners[ev] || []).forEach(fn => fn(data));

  // Each browser keeps a secret token that identifies its player to hosts.
  let token = null;
  try { token = localStorage.getItem('sd_token'); } catch {}
  if (!token) { token = SD.randomToken(); try { localStorage.setItem('sd_token', token); } catch {} }

  let mode = null;      // 'host' | 'client' | null
  let peer = null;
  let room = null;      // host only: the engine
  let ledger = null;    // host only
  let myPid = null;
  let code = null;
  let name = '';
  const conns = new Map(); // host only: playerId -> DataConnection

  // client only
  let hostConn = null;
  let reqSeq = 0;
  const pending = new Map();
  let leaving = false;
  let retryTimer = null;

  /** Optional override for local testing: ?peerserver=localhost:9000 */
  function peerOptions() {
    const ps = new URLSearchParams(location.search).get('peerserver');
    if (!ps) return { debug: 1 };
    const [host, port] = ps.split(':');
    return { host, port: Number(port), path: '/', secure: false, debug: 1, config: { iceServers: [] } };
  }

  function openPeer(id) {
    return new Promise((resolve, reject) => {
      const p = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
      const fail = err => { p.destroy(); reject(err); };
      p.once('open', () => { p.off('error', fail); resolve(p); });
      p.once('error', fail);
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function friendlyError(err) {
    const t = err && err.type;
    if (t === 'browser-incompatible') return 'This browser does not support the connections the game needs. Try Chrome, Edge, Firefox or Safari.';
    if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Could not reach the matchmaking service. Check your internet connection. Some work or school networks block it.';
    return (err && err.message) || 'Connection failed.';
  }

  /* ================================================================ */
  /* HOST                                                             */
  /* ================================================================ */
  async function host(displayName, { restoring = null } = {}) {
    name = SD.cleanName(displayName);
    ledger = new SD.Ledger(localStorage, 'sd_ledger_v1', SD.CONFIG);
    const me = ledger.getOrCreate(token, name);
    myPid = me.id;

    // Claim a peer id for the room code. A reloading host reclaims its old
    // code, which the matchmaking service may hold for a few seconds.
    for (let attempt = 0; ; attempt++) {
      code = restoring ? restoring.code : SD.randomCode();
      try { peer = await openPeer(PREFIX + code); break; }
      catch (err) {
        if (err.type === 'unavailable-id' && !restoring && attempt < 5) continue;
        if (restoring && attempt < 15) { await sleep(2000); continue; } // reclaiming our code after a reload
        throw new Error(friendlyError(err));
      }
    }

    mode = 'host';
    const deps = {
      ledger,
      cfg: SD.CONFIG,
      send: deliver,
      onChange: persistHost
    };
    room = restoring ? SD.Room.restore(restoring, deps) : new SD.Room({ ...deps, code });
    room.addMember(myPid);

    peer.on('connection', acceptConnection);
    peer.on('disconnected', () => { if (mode === 'host' && !peer.destroyed) peer.reconnect(); });
    peer.on('error', err => console.warn('peer error', err.type));
    window.addEventListener('beforeunload', warnBeforeClose);
    window.addEventListener('pagehide', () => { if (mode === 'host') { persistHost(); ledger.flush(); } });
    return { ok: true, code };
  }

  function deliver(pid, state) {
    // The host's own screen gets a copy, exactly like remote players do. Handing
    // over the live object would let the engine change it after the screen saw it.
    if (pid === myPid) { const copy = JSON.parse(JSON.stringify(state)); setTimeout(() => fire('state', copy), 0); return; }
    const c = conns.get(pid);
    if (c && c.open) { try { c.send({ t: 'state', s: state }); } catch {} }
  }

  function persistHost() {
    if (!room || room.closed) return;
    try { sessionStorage.setItem('sd_hosting', JSON.stringify({ name, room: room.serialize() })); } catch {}
  }

  function warnBeforeClose(e) {
    if (mode === 'host' && room && room.members.size > 1) { e.preventDefault(); e.returnValue = ''; }
  }

  function acceptConnection(conn) {
    let pid = null;
    let windowStart = Date.now();
    let events = 0;

    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'hello') {
        const n = SD.cleanName(msg.name);
        if (typeof msg.token !== 'string' || msg.token.length < 16 || msg.token.length > 128 || !n) {
          conn.send({ t: 'reject', error: 'Enter a display name.' }); return;
        }
        if (msg.token === token) { conn.send({ t: 'reject', error: 'You are already hosting this room in another tab.' }); return; }
        const player = ledger.getOrCreate(msg.token, n);
        const res = room.addMember(player.id);
        if (!res.ok) { conn.send({ t: 'reject', error: res.error }); setTimeout(() => conn.close(), 300); return; }
        const old = conns.get(player.id);
        if (old && old !== conn) { try { old.close(); } catch {} }
        pid = player.id;
        conns.set(pid, conn);
        conn.send({ t: 'welcome', pid, code });
        room.broadcast();
        return;
      }

      if (msg.t === 'req' && pid) {
        const now = Date.now();
        if (now - windowStart > 1000) { windowStart = now; events = 0; }
        const res = ++events > SD.CONFIG.EVENTS_PER_SECOND
          ? { ok: false, error: 'Too many actions. Slow down.' }
          : room.handle(pid, String(msg.ev), msg.data);
        try { conn.send({ t: 'res', id: msg.id, res }); } catch {}
        if (msg.ev === 'leaveRoom') { conns.delete(pid); pid = null; setTimeout(() => conn.close(), 300); }
      }
    });

    conn.on('close', () => {
      if (pid && conns.get(pid) === conn) { conns.delete(pid); room.setConnected(pid, false); }
    });
  }

  /* ================================================================ */
  /* PLAYER (client)                                                  */
  /* ================================================================ */
  async function join(roomCode, displayName) {
    name = SD.cleanName(displayName);
    code = String(roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) throw new Error('Enter the room code your friend gave you.');
    leaving = false;
    if (!peer || peer.destroyed) {
      try { peer = await openPeer(); } catch (err) { throw new Error(friendlyError(err)); }
      peer.on('disconnected', () => { if (mode === 'client' && !peer.destroyed) peer.reconnect(); });
    }
    await connectToHost();
    mode = 'client';
    try { sessionStorage.setItem('sd_joined', JSON.stringify({ code, name })); } catch {}
    return { ok: true, code };
  }

  function connectToHost() {
    return new Promise((resolve, reject) => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      let settled = false;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onPeerError);
        if (err) { try { conn.close(); } catch {} reject(err); } else resolve(val);
      };
      const onPeerError = err => {
        if (err.type === 'peer-unavailable') done(new Error(`No room with code ${code}. Check the code, and make sure the host still has the game open.`));
        else done(new Error(friendlyError(err)));
      };
      const timer = setTimeout(() => done(new Error('The host did not answer. Check the code and try again.')), 15000);
      peer.on('error', onPeerError);

      conn.on('open', () => conn.send({ t: 'hello', token, name }));
      conn.on('data', msg => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'welcome') { myPid = msg.pid; hostConn = conn; fire('connected'); done(null, msg); }
        else if (msg.t === 'reject') done(new Error(msg.error));
        else if (msg.t === 'state') fire('state', msg.s);
        else if (msg.t === 'res' && pending.has(msg.id)) { pending.get(msg.id)(msg.res); pending.delete(msg.id); }
        else if (msg.t === 'closed') { leaving = true; clearSession(); fire('closed', 'The host closed the room.'); }
      });
      conn.on('close', () => {
        if (!settled) return done(new Error('The host closed the connection.'));
        if (hostConn !== conn || leaving) return;
        hostConn = null;
        for (const [, resolveReq] of pending) resolveReq({ ok: false, error: 'Lost connection to the host.' });
        pending.clear();
        fire('connlost');
        scheduleRetry(0);
      });
    });
  }

  /** Keep trying to get back to the host (it may be reloading). */
  function scheduleRetry(attempt) {
    clearTimeout(retryTimer);
    if (leaving) return;
    if (attempt > 60) { clearSession(); fire('closed', 'Lost the host. The room has ended.'); return; }
    retryTimer = setTimeout(async () => {
      try {
        if (peer.disconnected && !peer.destroyed) peer.reconnect();
        await connectToHost();
      } catch {
        scheduleRetry(attempt + 1);
      }
    }, 3000);
  }

  /* ================================================================ */
  /* SHARED                                                           */
  /* ================================================================ */

  /** Send an intent. The host handles its own intents directly. */
  function request(ev, data) {
    if (mode === 'host') return Promise.resolve(room.handle(myPid, ev, data));
    if (mode === 'client' && hostConn && hostConn.open) {
      return new Promise(resolve => {
        const id = ++reqSeq;
        pending.set(id, resolve);
        hostConn.send({ t: 'req', id, ev, data });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: 'The host did not respond.' }); } }, 10000);
      });
    }
    return Promise.resolve({ ok: false, error: 'Not connected to the host right now.' });
  }

  function clearSession() {
    try { sessionStorage.removeItem('sd_hosting'); sessionStorage.removeItem('sd_joined'); } catch {}
  }

  async function leave() {
    leaving = true;
    clearTimeout(retryTimer);
    if (mode === 'host' && room) {
      room.close(); // refunds anything still riding
      for (const c of conns.values()) { try { c.send({ t: 'closed' }); } catch {} }
      await sleep(300);
      window.removeEventListener('beforeunload', warnBeforeClose);
    } else if (mode === 'client') {
      await request('leaveRoom');
    }
    clearSession();
    conns.clear();
    room = null; hostConn = null; mode = null;
    if (peer) { peer.destroy(); peer = null; }
    fire('left');
  }

  /** On page load: put a reloading host or player back where they were. */
  async function resume() {
    let saved = null;
    try {
      const h = sessionStorage.getItem('sd_hosting');
      if (h) { saved = JSON.parse(h); return { role: 'host', name: saved.name, promise: host(saved.name, { restoring: saved.room }) }; }
      const j = sessionStorage.getItem('sd_joined');
      if (j) { saved = JSON.parse(j); return { role: 'client', name: saved.name, code: saved.code, promise: join(saved.code, saved.name) }; }
    } catch {}
    return null;
  }

  return {
    on, host, join, leave, request, resume, clearSession,
    get isHost() { return mode === 'host'; },
    get playerId() { return myPid; },
    get code() { return code; }
  };
})();
