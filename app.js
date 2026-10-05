/**
 * SUIT DERBY CLIENT
 * The browser never decides anything that matters. It sends intents to the
 * server and renders the snapshots it gets back. Every number shown here
 * (odds, positions, balances, payouts) comes from the server.
 */
(() => {
  const SUITS = ['H', 'D', 'C', 'S'];
  const NAME = { H: 'Hearts', D: 'Diamonds', C: 'Clubs', S: 'Spades' };
  const SYM = { H: '♥', D: '♦', C: '♣', S: '♠' };
  const COLOR = { H: '#e5383b', D: '#2f7bf5', C: '#23a455', S: '#2b2f3a' };
  const isRed = s => s === 'H' || s === 'D';
  const label = s => `${SYM[s]} ${NAME[s]}`;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = id => document.getElementById(id);

  /** Small DOM helper. Text is always set with textContent (safe for player names). */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'data') Object.assign(node.dataset, v);
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* Connection (peer-to-peer, see net.js)                               */
  /* ------------------------------------------------------------------ */
  const ui = {
    state: null,
    offset: 0,          // host clock - our clock, for accurate countdowns
    draft: { H: 0, D: 0, C: 0, S: 0 },
    editing: false,
    panelKey: '',
    trackLength: 0,
    lanes: {},
    raceNo: null,
    lastCountdown: null,
    announceText: ''
  };

  /** Send an intent to the host; shows the host's error message if rejected. */
  async function send(event, payload) {
    const res = (await Net.request(event, payload)) || { ok: false, error: 'No response from the host.' };
    if (!res.ok) { toast(res.error, true); Sound.error(); }
    return res;
  }

  Net.on('state', onState);
  Net.on('left', () => resetToLanding());
  Net.on('closed', msg => { resetToLanding(); $('landingError').textContent = msg; });
  Net.on('connlost', () => { $('conn').hidden = false; });
  Net.on('connected', () => { $('conn').hidden = true; });

  function resetToLanding() {
    ui.state = null; ui.panelKey = ''; ui.raceNo = null;
    $('conn').hidden = true;
    const q = new URLSearchParams(location.search); q.delete('room');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
    showLanding();
  }

  /* ------------------------------------------------------------------ */
  /* Landing screen                                                      */
  /* ------------------------------------------------------------------ */
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();
  try { $('nameInput').value = localStorage.getItem('sd_name') || ''; } catch {}

  function showLanding() {
    $('landing').hidden = false;
    $('game').hidden = true;
    hideOverlay();
    setBusy(false);
  }

  function setBusy(text) {
    for (const id of ['createBtn', 'joinBtn']) $(id).disabled = !!text;
    $('landingStatus').textContent = text || '';
  }

  function readName() {
    const name = SD.cleanName($('nameInput').value);
    if (!name) { $('landingError').textContent = 'Enter a display name first.'; $('nameInput').focus(); return null; }
    try { localStorage.setItem('sd_name', name); } catch {}
    return name;
  }

  $('createBtn').addEventListener('click', async () => {
    Sound.click();
    $('landingError').textContent = '';
    const name = readName(); if (!name) return;
    setBusy('Opening your room…');
    try { await Net.host(name); }
    catch (err) { $('landingError').textContent = err.message; setBusy(false); }
  });

  async function join() {
    Sound.click();
    $('landingError').textContent = '';
    const code = $('codeInput').value.trim().toUpperCase();
    if (!code) { $('landingError').textContent = 'Enter the room code your friend gave you.'; return; }
    const name = readName(); if (!name) return;
    setBusy('Connecting to the host…');
    try { await Net.join(code, name); }
    catch (err) { $('landingError').textContent = err.message; setBusy(false); }
  }
  $('joinBtn').addEventListener('click', join);
  $('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  $('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') ($('codeInput').value ? join() : $('createBtn').click()); });

  // Reloaded mid-game? Go straight back in.
  (async () => {
    const r = await Net.resume();
    if (!r) { showLanding(); return; }
    showLanding();
    setBusy(r.role === 'host' ? 'Reopening your room…' : 'Reconnecting to the host…');
    try { await r.promise; }
    catch (err) { Net.clearSession(); $('landingError').textContent = err.message; setBusy(false); }
  })();

  /* ------------------------------------------------------------------ */
  /* Top bar                                                             */
  /* ------------------------------------------------------------------ */
  $('muteBtn').textContent = Sound.muted ? '🔇' : '🔊';
  $('muteBtn').addEventListener('click', () => { $('muteBtn').textContent = Sound.toggle() ? '🔇' : '🔊'; });
  $('leaveBtn').addEventListener('click', () => {
    const msg = Net.isHost
      ? 'Close this room? It ends the game for everyone, and any bets still riding are refunded.'
      : 'Leave this room? Any bets you already confirmed still count.';
    if (confirm(msg)) Net.leave();
  });
  $('codeChip').addEventListener('click', copyInvite);

  function copyInvite() {
    const s = ui.state; if (!s) return;
    const link = `${location.origin}${location.pathname}?room=${s.code}`;
    const done = () => toast('Invite link copied');
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => prompt('Copy this link:', link));
    else prompt('Copy this link:', link);
  }

  /* ------------------------------------------------------------------ */
  /* State updates from the server                                       */
  /* ------------------------------------------------------------------ */
  function onState(s) {
    const prev = ui.state;
    ui.state = s;
    ui.offset = s.serverNow - Date.now();
    $('landing').hidden = true;
    $('game').hidden = false;
    const q = new URLSearchParams(location.search);
    if (s.code && q.get('room') !== s.code) { q.set('room', s.code); history.replaceState(null, '', `${location.pathname}?${q}`); }

    const raceNo = s.race ? s.race.number : null;
    if (raceNo !== ui.raceNo) {
      ui.raceNo = raceNo;
      ui.draft = { H: 0, D: 0, C: 0, S: 0 };
      ui.editing = false;
    }
    const samePhase = prev && prev.phase === s.phase && (prev.race?.number === s.race?.number);

    renderTop(s);
    renderTrack(s, samePhase ? prev : null);
    renderAnnouncer(s, samePhase ? prev : null);
    renderPanel(s, samePhase ? prev : null);
    renderPlayers(s);
    renderHistory(s);
    phaseEffects(s, prev);
  }

  function renderTop(s) {
    $('roomCode').textContent = s.code;
    $('leaveBtn').textContent = s.you.isHost ? 'Close room' : 'Leave';
    $('balance').textContent = s.you.balance;
    const inPlay = ['betting', 'closed', 'race'].includes(s.phase) ? s.you.betTotal : 0;
    $('inPlay').textContent = inPlay ? `${inPlay} in play` : '';
  }

  /* ------------------------------------------------------------------ */
  /* Track                                                               */
  /* ------------------------------------------------------------------ */
  function buildTrack(L) {
    const track = $('track');
    track.replaceChildren();
    ui.lanes = {};
    for (const s of SUITS) {
      const odds = el('div', { class: 'lane-odds', text: '-' });
      const tags = el('div', { class: 'lane-tags' });
      const horse = el('div', { class: 'horse', style: '--p:0' },
        el('span', { class: 'horse-emoji', text: '🏇' }),
        el('span', { class: 'horse-cloth', text: SYM[s] })
      );
      const spaces = el('div', { class: 'spaces', style: `grid-template-columns: repeat(${L}, 1fr)` });
      for (let i = 1; i <= L; i++) spaces.append(el('div', { class: 'space' }, el('span', { text: i })));
      const lane = el('div', { class: 'lane', data: { suit: s }, style: `--suit:${COLOR[s]}` },
        el('div', { class: 'lane-label' },
          el('div', { class: 'lane-suit', text: SYM[s], 'aria-hidden': 'true' }),
          el('div', {}, el('div', { class: 'lane-name', text: NAME[s] }), odds)
        ),
        el('div', { class: 'course', style: '--finish-w:18px' }, spaces, el('div', { class: 'start-line' }), el('div', { class: 'finish-line', title: 'Finish' }), tags, horse)
      );
      track.append(lane);
      ui.lanes[s] = { lane, odds, tags, horse };
    }
    ui.trackLength = L;
  }

  function renderTrack(s, prev) {
    const L = s.config.trackLength;
    if (ui.trackLength !== L) buildTrack(L);
    const race = s.race;
    const positions = race ? race.positions : [0, 0, 0, 0];
    const max = Math.max(...positions);
    const leaders = positions.filter(p => p === max).length;

    SUITS.forEach((suit, i) => {
      const lane = ui.lanes[suit];
      const o = race && race.odds ? race.odds[i] : null;
      // Odds
      if (!race || s.phase === 'lobby') lane.odds.textContent = '-';
      else if (!o) lane.odds.textContent = '??';
      else if (o.scratched) lane.odds.textContent = 'Scratched';
      else lane.odds.textContent = `${o.multiplier}×`;
      lane.odds.classList.toggle('scratched', !!(o && o.scratched));
      // Your pick / your bet tags
      lane.tags.replaceChildren();
      if (race && s.you.prediction === suit) lane.tags.append(el('span', { class: 'tag tag-pick', text: 'Your pick' }));
      const stake = s.you.bets ? s.you.bets[suit] : 0;
      if (race && stake) lane.tags.append(el('span', { class: 'tag tag-bet', text: `Bet ${stake}` }));
      // Horse position
      const pos = positions[i];
      lane.horse.style.setProperty('--p', String(pos / L));
      lane.horse.setAttribute('aria-label', `${NAME[suit]} at space ${pos} of ${L}`);
      if (prev && prev.race && pos > prev.race.positions[i]) {
        lane.horse.classList.remove('gallop'); void lane.horse.offsetWidth; lane.horse.classList.add('gallop');
        lane.lane.classList.add('moved');
        setTimeout(() => lane.lane.classList.remove('moved'), 500);
      }
      lane.lane.classList.toggle('leading', s.phase === 'race' && max > 0 && pos === max && leaders === 1);
      lane.lane.classList.toggle('winner', s.phase === 'results' && race && race.winner === suit);
      lane.lane.classList.toggle('loser', s.phase === 'results' && race && race.winner !== suit);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Announcer (tote board strip)                                        */
  /* ------------------------------------------------------------------ */
  function leaderOf(positions) {
    const max = Math.max(...positions);
    const idx = positions.map((p, i) => (p === max ? i : -1)).filter(i => i >= 0);
    return max > 0 && idx.length === 1 ? SUITS[idx[0]] : null;
  }

  function renderAnnouncer(s, prev) {
    let text = '';
    const race = s.race;
    switch (s.phase) {
      case 'lobby': text = 'Waiting for players…'; break;
      case 'odds': text = `Shuffling and burning ${s.config.burnCount} cards…`; break;
      case 'prediction': text = 'Who do you predict will win?'; break;
      case 'betting': text = 'Place your bets'; break;
      case 'closed': text = 'Betting closed'; break;
      case 'race': {
        const last = race.draws[race.draws.length - 1];
        if (!last) { text = "And they're off! Waiting for the first card"; break; }
        text = `${last.rank}${SYM[last.suit]} drawn. ${NAME[last.suit]} moves forward!`;
        const lead = leaderOf(race.positions);
        const prevLead = prev && prev.race ? leaderOf(prev.race.positions) : null;
        if (lead && lead !== prevLead && race.draws.length > 1) text += ` ${NAME[lead]} takes the lead!`;
        break;
      }
      case 'results': text = `${NAME[race.winner]} wins!`; break;
    }
    if (text !== ui.announceText) {
      ui.announceText = text;
      const a = $('announce');
      a.textContent = text;
      a.classList.remove('flash'); void a.offsetWidth; a.classList.add('flash');
    }
  }

  /* Countdown timer for timed phases */
  setInterval(() => {
    const s = ui.state;
    const t = $('timer');
    if (!s || !s.deadline || !['prediction', 'betting'].includes(s.phase)) { t.hidden = true; return; }
    const secs = Math.max(0, Math.ceil((s.deadline - (Date.now() + ui.offset)) / 1000));
    t.hidden = false;
    t.textContent = `${secs}s`;
    t.classList.toggle('low', secs <= 5);
  }, 200);

  /* ------------------------------------------------------------------ */
  /* Phase transition effects: countdown, "they're off", winner          */
  /* ------------------------------------------------------------------ */
  let overlayTimer = null;
  let countdownTimer = null;
  function showOverlay(text, { small = false, ms = 0 } = {}) {
    clearTimeout(overlayTimer);
    const o = $('overlay'); const t = $('overlayText');
    t.textContent = text;
    t.classList.toggle('small', small);
    t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
    o.hidden = false;
    if (ms) overlayTimer = setTimeout(hideOverlay, ms);
  }
  function hideOverlay() { $('overlay').hidden = true; clearInterval(countdownTimer); }

  function phaseEffects(s, prev) {
    const changed = !prev || prev.phase !== s.phase || prev.race?.number !== s.race?.number;
    if (!changed) {
      // New card during the race
      if (s.phase === 'race' && prev.race && s.race.draws.length > prev.race.draws.length) { Sound.card(); setTimeout(Sound.hooves, 120); }
      return;
    }
    if (s.phase === 'closed') {
      ui.lastCountdown = null;
      clearInterval(countdownTimer);
      const step = () => {
        const left = Math.ceil((s.deadline - (Date.now() + ui.offset)) / 1000);
        if (left >= 1 && left !== ui.lastCountdown) { ui.lastCountdown = left; showOverlay(String(left)); Sound.tick(); }
      };
      step();
      countdownTimer = setInterval(step, 100);
    } else if (s.phase === 'race' && prev && prev.phase === 'closed') {
      clearInterval(countdownTimer);
      showOverlay("And they're off!", { small: true, ms: 1300 });
      Sound.go();
    } else if (s.phase === 'results' && prev && prev.phase === 'race') {
      hideOverlay();
      showOverlay(`🏆 ${SYM[s.race.winner]} ${NAME[s.race.winner]}`, { small: true, ms: 2200 });
      const r = s.you.result;
      if (r && r.payout > 0) { Sound.fanfare(); confetti(); }
      else if (r && r.totalBet > 0) Sound.lose();
      else Sound.fanfare();
    } else if (s.phase === 'odds') {
      Sound.card();
      hideOverlay();
    } else {
      hideOverlay();
    }
  }

  function confetti() {
    if (reduceMotion) return;
    const box = $('confetti');
    const colors = ['#e5383b', '#2f7bf5', '#23a455', '#ffb22e', '#f3eee2'];
    for (let i = 0; i < 90; i++) {
      const c = el('i', { style: `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};animation-duration:${2 + Math.random() * 2}s;animation-delay:${Math.random() * 0.4}s` });
      box.append(c);
    }
    setTimeout(() => box.replaceChildren(), 4600);
  }

  /* ------------------------------------------------------------------ */
  /* Action panel: one view per phase                                    */
  /* ------------------------------------------------------------------ */
  function renderPanel(s, prev) {
    const you = s.you;
    const raceNo = s.race ? s.race.number : 0;
    const watching = s.race && !you.inRace && ['prediction', 'betting', 'closed', 'race'].includes(s.phase);
    let key = `${s.phase}|${raceNo}|${you.isHost}|${watching}`;
    if (s.phase === 'prediction') key += `|${you.prediction}`;
    if (s.phase === 'betting') key += `|${you.prediction}|${JSON.stringify(you.bets)}|${ui.editing}`;
    if (s.phase === 'race') key += `|${s.race.autoDraw}`;

    const panel = $('panel');
    if (key !== ui.panelKey) {
      ui.panelKey = key;
      panel.replaceChildren();
      const view = watching && s.phase !== 'race' ? viewWatching : VIEWS[s.phase];
      panel.append(...[].concat(view(s)));
    }
    // Live parts that change without rebuilding the panel
    if (s.phase === 'race') updateRaceView(s, prev);
    updateCounts(s);
  }

  function updateCounts(s) {
    const n = s.players.filter(p => p.inRace).length;
    const picked = $('pickCount');
    if (picked) picked.textContent = `${s.players.filter(p => p.inRace && p.predicted).length} of ${n} players have picked`;
    const betted = $('betCount');
    if (betted) betted.textContent = `${s.players.filter(p => p.inRace && p.betConfirmed).length} of ${n} players have confirmed bets`;
    const lobbyCount = $('lobbyCount');
    if (lobbyCount) lobbyCount.textContent = `${s.players.length} of ${s.config.maxPlayers} players in the room`;
  }

  const hostSkip = (s, text) => s.you.isHost
    ? el('button', { class: 'btn btn-quiet', text, onclick: () => { Sound.click(); send('advance'); } })
    : null;

  const VIEWS = {
    lobby(s) {
      return [
        el('h2', { text: 'Waiting for players…' }),
        el('p', { class: 'sub', text: 'Share the room code. Friends can join until betting closes.' }),
        el('div', { class: 'lobby-code' },
          el('span', { class: 'big-code', text: s.code }),
          el('button', { class: 'btn btn-ghost', text: 'Copy invite link', onclick: copyInvite })
        ),
        el('p', { id: 'lobbyCount', class: 'sub' }),
        s.you.isHost ? el('p', { class: 'host-note', text: 'You are hosting, so the game runs in this tab. Keep it open and in front while you play. Closing it pauses the game for everyone.' }) : null,
        s.you.isHost
          ? el('div', { class: 'actions' }, el('button', { class: 'btn btn-brass btn-lg', text: 'Start the race', onclick: () => { Sound.click(); send('startRace'); } }))
          : el('p', { text: 'The host starts the race when everyone is in.' })
      ];
    },

    odds(s) {
      const backs = el('div', { class: 'host-controls' });
      for (let i = 0; i < 3; i++) backs.append(el('div', { class: 'card-slot', style: `width:64px;height:90px;transform:rotate(${(i - 1) * 8}deg)` }, el('div', { class: 'pcard back flip' })));
      return [
        el('h2', { text: 'Setting the odds' }),
        el('p', { class: 'sub', text: `The dealer is secretly burning ${s.config.burnCount} cards. Nobody sees them. The cards that remain set each horse's payout.` }),
        backs
      ];
    },

    prediction(s) {
      const grid = el('div', { class: 'pick-grid' });
      SUITS.forEach((suit, i) => {
        const o = s.race.odds[i];
        grid.append(el('button', {
          class: 'pick' + (s.you.prediction === suit ? ' selected' : ''),
          data: { suit }, style: `--suit:${COLOR[suit]}`, disabled: o.scratched,
          'aria-pressed': String(s.you.prediction === suit),
          onclick: () => { Sound.click(); send('predict', suit); }
        },
          el('span', { class: 'pick-suit', text: SYM[suit] }),
          el('span', { class: 'pick-name', text: NAME[suit] }),
          el('span', { class: 'pick-odds', text: o.scratched ? 'Scratched' : `${o.multiplier}×` }),
          el('span', { class: 'pick-chance', text: o.scratched ? '' : `about ${o.chance}% to win` })
        ));
      });
      return [
        el('h2', { text: 'Who do you predict will win?' }),
        el('p', { class: 'sub', text: 'Your prediction is just for bragging rights. Betting comes next and is separate.' }),
        grid,
        el('div', { class: 'actions' }, el('span', { id: 'pickCount', class: 'sub', style: 'margin:0;align-self:center' }), hostSkip(s, 'Skip to betting'))
      ];
    },

    betting(s) {
      const you = s.you;
      const out = [el('h2', { text: 'Place your bets' })];

      // Prediction can still be changed until betting closes.
      const minis = el('div', { class: 'mini-picks' }, el('span', { text: 'Your prediction:' }));
      SUITS.forEach((suit, i) => {
        if (s.race.odds[i].scratched) return;
        minis.append(el('button', {
          class: 'mini-pick' + (you.prediction === suit ? ' selected' : ''),
          text: label(suit), 'aria-pressed': String(you.prediction === suit),
          onclick: () => { Sound.click(); send('predict', suit); }
        }));
      });
      out.push(minis);

      if (you.bets && !ui.editing) {
        // Confirmed view
        const lines = SUITS.filter(k => you.bets[k] > 0).map(k => `${label(k)}: ${you.bets[k]}`);
        out.push(el('div', { class: 'confirmed-box' },
          el('strong', { text: 'Bets confirmed. ' }),
          lines.length ? `${lines.join(', ')}. Total ${you.betTotal} credits.` : 'You are sitting this race out.'
        ));
        out.push(el('p', { class: 'sub', text: 'You can still change them until betting closes.' }));
        out.push(el('div', { class: 'actions' },
          el('button', { class: 'btn btn-ghost', text: 'Edit bets', onclick: () => { ui.editing = true; ui.draft = { ...you.bets }; renderPanel(ui.state); } }),
          hostSkip(s, 'Close betting now')
        ));
        out.push(el('p', { id: 'betCount', class: 'sub', style: 'margin-top:12px' }));
        return out;
      }

      // Bet form
      const rows = el('div', { class: 'bet-rows' });
      SUITS.forEach((suit, i) => {
        const o = s.race.odds[i];
        if (o.scratched) return;
        const input = el('input', {
          type: 'number', inputmode: 'numeric', min: '0', step: '1', value: String(ui.draft[suit] || 0),
          'aria-label': `Bet on ${NAME[suit]}`, id: `bet-${suit}`,
          oninput: e => { ui.draft[suit] = clampInt(e.target.value); updateBetForm(); },
          onblur: e => { e.target.value = String(ui.draft[suit]); }
        });
        const bump = d => () => { Sound.click(); ui.draft[suit] = Math.max(0, (ui.draft[suit] || 0) + d); updateBetForm(); };
        rows.append(el('div', { class: 'bet-row', id: `row-${suit}`, data: { suit }, style: `--suit:${COLOR[suit]}` },
          el('div', { class: 'bet-horse' },
            el('span', { class: 'bh-suit', text: SYM[suit] }),
            el('span', { class: 'bh-name', text: NAME[suit] }),
            el('span', { class: 'bh-odds', text: `${o.multiplier}×` }),
            el('span', { class: 'bh-win', id: `win-${suit}` })
          ),
          el('div', { class: 'stepper' },
            el('button', { text: '−', 'aria-label': `Less on ${NAME[suit]}`, onclick: bump(-1) }),
            input,
            el('button', { text: '+', 'aria-label': `More on ${NAME[suit]}`, onclick: bump(1) }),
            el('button', { class: 'chip', text: '+5', onclick: bump(5) }),
            el('button', { class: 'chip', text: '+10', onclick: bump(10) })
          )
        ));
      });
      out.push(rows);
      out.push(el('div', { class: 'totals' },
        el('div', { class: 'total-box' }, el('div', { class: 'tl', text: 'Current balance' }), el('div', { class: 'tv', id: 'tCurrent' })),
        el('div', { class: 'total-box', id: 'tWagerBox' }, el('div', { class: 'tl', text: 'Total wager' }), el('div', { class: 'tv', id: 'tWager' })),
        el('div', { class: 'total-box', id: 'tRemainBox' }, el('div', { class: 'tl', text: 'Remaining balance' }), el('div', { class: 'tv', id: 'tRemain' }))
      ));
      out.push(el('p', { id: 'betError', class: 'error' }));
      out.push(el('div', { class: 'actions' },
        el('button', { class: 'btn btn-brass btn-lg', id: 'confirmBtn', onclick: confirmBets }),
        el('button', { class: 'btn btn-quiet', text: 'Clear', onclick: () => { ui.draft = { H: 0, D: 0, C: 0, S: 0 }; updateBetForm(); } }),
        you.bets ? el('button', { class: 'btn btn-quiet', text: 'Cancel', onclick: () => { ui.editing = false; renderPanel(ui.state); } }) : null,
        hostSkip(s, 'Close betting now')
      ));
      out.push(el('p', { id: 'betCount', class: 'sub', style: 'margin-top:12px' }));
      requestAnimationFrame(updateBetForm);
      return out;
    },

    closed(s) {
      const you = s.you;
      const lines = you.bets ? SUITS.filter(k => you.bets[k] > 0).map(k => `${label(k)}: ${you.bets[k]}`) : [];
      return [
        el('h2', { text: 'Bets are locked' }),
        el('p', { class: 'sub', text: 'The remaining deck is being shuffled. Get ready.' }),
        el('div', { class: 'result-lines' },
          el('div', { class: 'rline' }, el('span', { text: 'Your prediction' }), el('span', { class: 'rv', text: you.prediction ? label(you.prediction) : 'None' })),
          el('div', { class: 'rline' }, el('span', { text: 'Your bets' }), el('span', { class: 'rv', text: lines.length ? lines.join(', ') : 'None' }))
        )
      ];
    },

    race(s) {
      const controls = s.you.isHost
        ? el('div', { class: 'host-controls' },
            el('button', { class: 'btn btn-brass btn-lg', id: 'drawBtn', text: 'Draw card', disabled: s.race.autoDraw, onclick: () => { send('draw'); } }),
            el('label', { class: 'switch' },
              el('input', { type: 'checkbox', checked: s.race.autoDraw, onchange: e => send('autoDraw', e.target.checked) }),
              'Auto draw'
            ))
        : el('p', { class: 'sub', text: s.race.autoDraw ? 'Cards are drawing automatically.' : 'The host draws each card.' });
      const watchNote = !s.you.inRace ? el('p', { class: 'sub', text: "You're watching this one. You'll be in the next race." }) : null;
      return [
        el('div', { class: 'race-grid' },
          el('div', { class: 'card-slot', id: 'cardSlot' }, el('div', { class: 'pcard back' })),
          el('div', {},
            el('p', { class: 'draw-msg', id: 'drawMsg', text: 'Waiting for the first card' }),
            el('p', { class: 'draw-sub', id: 'drawSub' }),
            controls,
            watchNote
          )
        ),
        el('ol', { class: 'standings', id: 'standings', 'aria-label': 'Current standings' }),
        el('div', { class: 'drawn-strip', id: 'drawnStrip', 'aria-label': 'Cards drawn this race' })
      ];
    },

    results(s) {
      const r = s.you.result;
      const w = s.race.winner;
      const wIdx = SUITS.indexOf(w);
      const mult = s.race.odds[wIdx].multiplier;
      const out = [el('div', { class: 'winner-head', text: `🏆 Winner: ${SYM[w]} ${NAME[w]}` })];

      if (!r) {
        out.push(el('p', { class: 'sub', text: "You watched this race. You'll be in the next one." }));
      } else {
        // Prediction
        if (r.prediction) {
          out.push(el('div', { class: 'result-lines' },
            el('div', { class: 'rline' }, el('span', { text: 'Your prediction' }), el('span', { class: 'rv', text: label(r.prediction) })),
            el('div', { class: 'rline' }, el('span', { text: 'Winner' }), el('span', { class: 'rv', text: label(w) }))
          ));
          out.push(el('p', { class: 'verdict ' + (r.predictionCorrect ? 'good-text' : 'bad-text'), text: r.predictionCorrect ? '✓ Correct prediction!' : '✕ Incorrect prediction' }));
        } else {
          out.push(el('p', { class: 'sub', text: 'You did not make a prediction this race.' }));
        }

        // Bets and payout, spelled out
        const lines = el('div', { class: 'result-lines' });
        const placed = SUITS.filter(k => r.wagers[k] > 0);
        if (!placed.length) lines.append(el('div', { class: 'rline' }, el('span', { text: 'Bets' }), el('span', { class: 'rv', text: 'None' })));
        for (const k of placed) {
          const won = k === w;
          lines.append(el('div', { class: 'rline ' + (won ? 'good' : 'bad') },
            el('span', {}, `${label(k)}: ${r.wagers[k]} credits`, won ? el('div', { class: 'math', text: `${r.wagers[k]} × ${mult} = ${r.payout}` }) : null),
            el('span', { class: 'rv', text: won ? `Won ${r.payout}` : `Lost ${r.wagers[k]}` })
          ));
        }
        if (placed.length) {
          lines.append(
            el('div', { class: 'rline' }, el('span', { text: 'Winning bet' }), el('span', { class: 'rv', text: `${r.winningStake} credits` })),
            el('div', { class: 'rline' }, el('span', { text: 'Total bet' }), el('span', { class: 'rv', text: `${r.totalBet} credits` })),
            el('div', { class: 'rline' }, el('span', { text: 'Payout' }), el('span', { class: 'rv', text: `${r.payout} credits` })),
            el('div', { class: 'rline ' + (r.net >= 0 ? 'good' : 'bad') }, el('span', { text: 'Net result' }), el('span', { class: 'rv', text: `${r.net >= 0 ? '+' : ''}${r.net} credits` }))
          );
        }
        lines.append(el('div', { class: 'rline total' }, el('span', { text: 'New balance' }), el('span', { class: 'rv', text: `${r.balanceAfter} credits` })));
        out.push(lines);
        if (r.refill) out.push(el('p', { class: 'sub', text: `You ran out of credits, so you got ${r.refill} free play credits to keep racing.` }));
      }

      out.push(s.you.isHost
        ? el('div', { class: 'actions' }, el('button', { class: 'btn btn-brass btn-lg', text: 'Play again', onclick: () => { Sound.click(); send('startRace'); } }))
        : el('p', { class: 'sub', text: 'Waiting for the host to start the next race.' }));
      return out;
    }
  };

  function viewWatching(s) {
    return [
      el('h2', { text: "You're in the next race" }),
      el('p', { class: 'sub', text: 'This race locked before you arrived. Watch the track, and you will be dealt in when the host starts again.' })
    ];
  }

  /* ---------- Betting form helpers ---------- */
  function clampInt(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function updateBetForm() {
    const s = ui.state;
    if (!s || s.phase !== 'betting' || !$('confirmBtn')) return;
    const available = s.you.balance + s.you.betTotal; // stakes already confirmed are refunded on re-confirm
    const total = SUITS.reduce((a, k) => a + (ui.draft[k] || 0), 0);
    const remaining = available - total;

    SUITS.forEach((k, i) => {
      const input = $(`bet-${k}`); if (!input) return;
      if (document.activeElement !== input) input.value = String(ui.draft[k] || 0);
      $(`row-${k}`).classList.toggle('has-bet', ui.draft[k] > 0);
      const m = s.race.odds[i].multiplier;
      $(`win-${k}`).textContent = ui.draft[k] > 0 ? `pays ${Math.floor(ui.draft[k] * m)} if ${NAME[k]} wins` : '';
    });
    $('tCurrent').textContent = available;
    $('tWager').textContent = total;
    $('tRemain').textContent = remaining;
    $('tRemainBox').classList.toggle('warn', remaining < 0);

    let err = '';
    if (remaining < 0) err = `That's ${-remaining} more than you have.`;
    else if (SUITS.some(k => ui.draft[k] > s.config.maxBetPerHorse)) err = `Max ${s.config.maxBetPerHorse} credits per horse.`;
    else if (SUITS.some(k => ui.draft[k] > 0 && ui.draft[k] < s.config.minBet)) err = `Minimum bet is ${s.config.minBet}.`;
    else if (s.config.maxTotalBet > 0 && total > s.config.maxTotalBet) err = `Total bets are capped at ${s.config.maxTotalBet}.`;
    $('betError').textContent = err;

    const btn = $('confirmBtn');
    btn.disabled = !!err;
    btn.textContent = total > 0 ? `Confirm bets (${total})` : 'Confirm no bets';
  }

  async function confirmBets() {
    const r = await send('placeBets', { ...ui.draft });
    if (r.ok) { ui.editing = false; Sound.confirm(); toast('Bets confirmed'); renderPanel(ui.state); }
  }

  /* ---------- Race view (updated in place on every card) ---------- */
  function cardEl(card, cls = '') {
    return el('div', { class: `pcard ${isRed(card.suit) ? 'red' : ''} ${cls}`, 'aria-label': `${card.rank} of ${NAME[card.suit]}` },
      el('div', { class: 'corner tl' }, card.rank, el('br'), SYM[card.suit]),
      el('div', { class: 'pip', text: SYM[card.suit] }),
      el('div', { class: 'corner br' }, card.rank, el('br'), SYM[card.suit])
    );
  }

  function updateRaceView(s, prev) {
    const race = s.race;
    const draws = race.draws;
    const last = draws[draws.length - 1];
    const slot = $('cardSlot');
    if (!slot) return;
    const prevCount = prev && prev.race ? prev.race.draws.length : -1;

    if (last && (draws.length !== prevCount || !slot.querySelector('.pcard:not(.back)'))) {
      slot.replaceChildren(cardEl(last, draws.length !== prevCount ? 'flip' : ''));
      $('drawMsg').textContent = `${SYM[last.suit]} ${NAME[last.suit]} moves forward!`;
      $('drawMsg').style.color = last.suit === 'S' ? '' : COLOR[last.suit];
    }
    $('drawSub').textContent = `Card ${draws.length} drawn. ${race.cardsLeft} left in the deck. Card value never matters, only the suit.`;

    // Standings
    const L = s.config.trackLength;
    const order = SUITS.map((k, i) => ({ k, p: race.positions[i] })).sort((a, b) => b.p - a.p);
    $('standings').replaceChildren(...order.map((o, idx) => el('li', { data: { suit: o.k }, style: `--suit:${COLOR[o.k]}` },
      el('span', { class: 'rank', text: idx === 0 || o.p !== order[idx - 1].p ? `${idx + 1}.` : '' }),
      el('span', { class: `st-suit s-${o.k}`, text: SYM[o.k] }),
      el('span', { class: 'bar' }, el('i', { style: `width:${(o.p / L) * 100}%` })),
      el('span', { class: 'st-pos', text: `${o.p}/${L}` })
    )));

    // Recently drawn cards
    $('drawnStrip').replaceChildren(...draws.slice(-14).map((c, i, arr) =>
      el('div', { class: `mini-card ${isRed(c.suit) ? 'red' : ''} ${i === arr.length - 1 ? 'latest' : ''}` }, c.rank, el('br'), SYM[c.suit])
    ));

    // Brief cooldown on the draw button so the animation can play
    const btn = $('drawBtn');
    if (btn && draws.length !== prevCount && !race.autoDraw) {
      btn.disabled = true;
      setTimeout(() => { if ($('drawBtn') && !ui.state.race.autoDraw) $('drawBtn').disabled = false; }, 450);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Side panels                                                         */
  /* ------------------------------------------------------------------ */
  function renderPlayers(s) {
    const list = $('players');
    const items = s.players.map(p => {
      let status = '';
      if (!p.connected) status = 'Away';
      else if (s.phase === 'lobby') status = 'Ready';
      else if (!p.inRace) status = 'Watching';
      else if (s.phase === 'odds') status = 'Waiting for odds';
      else if (s.phase === 'prediction') status = p.predicted ? 'Picked a horse' : 'Picking…';
      else if (s.phase === 'betting') status = p.betConfirmed ? 'Bets in' : 'Betting…';
      else status = `Picked ${p.prediction ? SYM[p.prediction] : 'nobody'}, bet ${p.betTotal || 0}`;
      if (p.isHost) status = `Host. ${status}`;
      return el('li', { class: `${p.connected ? '' : 'offline'} ${p.id === s.you.id ? 'me' : ''}` },
        el('span', { class: 'pname', text: p.name || 'Player' }),
        el('span', { class: 'pbal', text: p.balance }),
        el('span', { class: 'pstatus', text: status })
      );
    });
    list.replaceChildren(...items);
  }

  function renderHistory(s) {
    const h = s.you.history || [];
    const list = $('history');
    if (!h.length) { list.replaceChildren(el('li', { class: 'empty', text: 'Your finished races show up here.' })); return; }
    list.replaceChildren(...h.map(r => {
      const pred = r.prediction ? `${SYM[r.prediction]} ${r.prediction === r.winner ? '✓' : '✕'}` : 'none';
      let money;
      if (r.totalBet === 0) money = el('span', { text: 'No bet' });
      else if (r.payout > 0) money = el('span', { class: 'win', text: `Bet ${r.totalBet}, won ${r.payout}` });
      else money = el('span', { class: 'loss', text: `Lost ${r.totalBet}` });
      return el('li', {},
        el('div', {}, el('span', { class: 'hrace', text: `Race #${r.race}` }), `  Winner ${SYM[r.winner]} ${NAME[r.winner]}`),
        el('div', {}, `Prediction ${pred}.  `, money)
      );
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                               */
  /* ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(msg, isErr = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // Keyboard: space or enter draws a card for the host during the race.
  document.addEventListener('keydown', e => {
    const s = ui.state;
    if (!s || s.phase !== 'race' || !s.you.isHost || s.race.autoDraw) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); send('draw'); }
  });
})();
