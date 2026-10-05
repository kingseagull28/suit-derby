/**
 * Rules test for engine.js, run with:  node tests/engine.test.js
 * Plays full races with three simulated players and tries to cheat.
 * (Not needed to run the game. GitHub Pages ignores it.)
 */
const assert = require('assert');
const SD = require('../engine.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return; await sleep(5); }
  throw new Error('Timed out: ' + label);
}

// ---- Odds math ----
let p = SD.winProbabilities([13, 13, 13, 13], 8);
p.forEach(x => assert(Math.abs(x - 0.25) < 1e-9));
const counts = [8, 11, 12, 9];
p = SD.winProbabilities(counts, 8);
const wins = [0, 0, 0, 0]; const deck = [];
counts.forEach((n, i) => { for (let k = 0; k < n; k++) deck.push(i); });
for (let t = 0; t < 40000; t++) { const pos = [0, 0, 0, 0]; for (const s of SD.secureShuffle(deck)) if (++pos[s] >= 8) { wins[s]++; break; } }
p.forEach((x, i) => assert(Math.abs(x - wins[i] / 40000) < 0.015, 'exact vs simulated'));
for (let i = 0; i < 1000; i++) assert(SD.burnCards(12, 8).counts.every(n => n >= 8));
console.log('odds ok:', SD.buildOdds(counts, SD.CONFIG).map(o => o.multiplier + 'x').join(' '));

// ---- Full game ----
(async () => {
  const mem = {}; const storage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
  const cfg = { ...SD.CONFIG, ODDS_REVEAL_MS: 50, CLOSED_COUNTDOWN_SECONDS: 0.05, MIN_DRAW_INTERVAL_MS: 0, AUTO_DRAW_INTERVAL_MS: 10 };
  const ledger = new SD.Ledger(storage, 'ledger', cfg);
  const inbox = {};
  let room = new SD.Room({ code: 'TEST1', ledger, cfg, send: (pid, s) => { inbox[pid] = s; } });
  const host = ledger.getOrCreate(SD.randomToken(), 'Host').id;
  const amy = ledger.getOrCreate(SD.randomToken(), 'Amy').id;
  const bo = ledger.getOrCreate(SD.randomToken(), 'Bo').id;
  [host, amy, bo].forEach(id => room.addMember(id));
  const act = (pid, ev, d) => room.handle(pid, ev, d);

  assert(!act(amy, 'startRace').ok, 'only host starts');
  for (let round = 1; round <= 3; round++) {
    const bal = { [host]: ledger.getById(host).balance, [amy]: ledger.getById(amy).balance, [bo]: ledger.getById(bo).balance };
    assert(act(host, 'startRace').ok);
    await waitFor(() => room.phase === 'prediction', 'prediction');
    for (const id of [host, amy, bo]) {
      const raw = JSON.stringify(inbox[id]);
      assert(!raw.includes('burned') && !raw.includes('"remaining"') && !raw.includes('"deck"'), 'no secrets sent');
    }
    assert(!act(amy, 'placeBets', { H: 5 }).ok, 'no bets during prediction');
    act(host, 'predict', 'H'); act(amy, 'predict', 'D'); act(bo, 'predict', 'C');
    assert.strictEqual(room.phase, 'betting');
    for (const w of [{ H: -1 }, { H: 1.5 }, { H: '5' }, { Z: 1 }, { H: 999999 }, { H: bal[amy] + 1 }, null, [1]])
      assert(!act(amy, 'placeBets', w).ok, 'rejected ' + JSON.stringify(w));
    assert(act(amy, 'placeBets', { H: 10, D: 5 }).ok);
    assert(act(amy, 'placeBets', { H: 10, D: 5, C: 15 }).ok);
    assert.strictEqual(ledger.getById(amy).balance, bal[amy] - 30, 'edit replaces escrow');
    assert(act(host, 'placeBets', { S: 20 }).ok);
    assert(act(bo, 'placeBets', {}).ok);
    assert.strictEqual(room.phase, 'closed');
    assert(!act(amy, 'placeBets', { H: 1 }).ok && !act(amy, 'predict', 'S').ok, 'locked after close');

    // Host reload mid-countdown: serialize, rebuild, keep going.
    if (round === 2) {
      const saved = JSON.parse(JSON.stringify(room.serialize()));
      clearTimeout(room.phaseTimer);
      room = SD.Room.restore(saved, { ledger, cfg, send: (pid, s) => { inbox[pid] = s; } });
      room.addMember(amy); room.addMember(bo);
    }
    await waitFor(() => room.phase === 'race', 'race');
    assert(!act(bo, 'draw').ok, 'only host draws');
    if (round === 3) act(host, 'autoDraw', true);
    else while (room.phase === 'race') act(host, 'draw');
    await waitFor(() => room.phase === 'results', 'results');
    assert(!act(host, 'draw').ok);

    const r = room.race;
    const tally = { H: 0, D: 0, C: 0, S: 0 }; r.draws.forEach(c => tally[c.suit]++);
    assert.deepStrictEqual(SD.SUITS.map(s => tally[s]), r.positions, 'suit-only movement');
    assert.strictEqual(Math.max(...r.positions), 8);
    assert.strictEqual(r.positions.filter(x => x === 8).length, 1);
    for (const id of [host, amy, bo]) assert.deepStrictEqual(inbox[id].race.draws, r.draws, 'everyone sees same race');

    const mult = r.odds[SD.SUITS.indexOf(r.winner)].multiplier;
    const check = (id, w, pred) => {
      const res = inbox[id].you.result;
      const total = Object.values(w).reduce((a, b) => a + b, 0);
      const pay = Math.floor((w[r.winner] || 0) * mult);
      let expected = bal[id] - total + pay; if (expected < 1) expected += cfg.BROKE_REFILL;
      assert.strictEqual(res.payout, pay); assert.strictEqual(res.predictionCorrect, pred === r.winner);
      assert.strictEqual(ledger.getById(id).balance, expected);
    };
    check(host, { S: 20 }, 'H'); check(amy, { H: 10, D: 5, C: 15 }, 'D'); check(bo, {}, 'C');
    room.settle(); // a second settle must do nothing
    check(amy, { H: 10, D: 5, C: 15 }, 'D');
    console.log(`round ${round}: ${r.winner} won at ${mult}x after ${r.draws.length} cards`);
  }

  // Closing mid-race refunds stakes.
  assert(act(host, 'startRace').ok);
  await waitFor(() => room.phase === 'prediction', 'p');
  act(host, 'advance');
  const before = ledger.getById(amy).balance;
  act(amy, 'placeBets', { H: 3 });
  room.close();
  assert.strictEqual(ledger.getById(amy).balance, before, 'refund on close');
  console.log('engine tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
