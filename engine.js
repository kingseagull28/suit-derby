/**
 * SUIT DERBY GAME ENGINE
 *
 * This file is the "server". It runs only in the HOST's browser. Other players
 * connect to the host peer-to-peer and send intents ("I bet 10 on Clubs");
 * the engine validates every intent and owns the deck, burned cards, odds,
 * positions, winner, balances and payouts. Players only ever receive
 * snapshots, never the deck or the burned cards.
 *
 * The same file also loads in Node so the rules can be tested without a browser.
 */
(function (root) {
  'use strict';

  /* ================================================================== */
  /* CONFIGURATION: change a number here, re-upload, done.              */
  /* ================================================================== */
  const CONFIG = {
    STARTING_CREDITS: 100,
    BROKE_REFILL: 25,          // free credits if someone hits 0 (0 to disable)

    BURN_COUNT: 12,            // cards secretly removed before odds
    TRACK_LENGTH: 8,           // spaces from start to finish
    MAX_BURN_ATTEMPTS: 500,    // re-burn until every horse can still finish

    MIN_BET: 1,
    MAX_BET_PER_HORSE: 500,
    MAX_TOTAL_BET: 0,          // 0 = limited only by balance

    // multiplier = (1 - HOUSE_EDGE) / winChance, rounded DOWN to ODDS_STEP
    HOUSE_EDGE: 0,
    ODDS_STEP: 0.1,
    MIN_MULTIPLIER: 1.1,
    MAX_MULTIPLIER: 100,

    ODDS_REVEAL_MS: 2500,
    PREDICTION_SECONDS: 25,
    BETTING_SECONDS: 45,
    CLOSED_COUNTDOWN_SECONDS: 3,
    MIN_DRAW_INTERVAL_MS: 400,
    AUTO_DRAW_INTERVAL_MS: 1300,

    MAX_PLAYERS_PER_ROOM: 12,
    ROOM_CODE_LENGTH: 5,
    NAME_MAX_LENGTH: 18,
    HISTORY_LENGTH: 25,
    EVENTS_PER_SECOND: 25
  };

  const SUITS = ['H', 'D', 'C', 'S']; // Hearts, Diamonds, Clubs, Spades
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

  /* ================================================================== */
  /* SECURE RANDOMNESS                                                  */
  /* crypto.getRandomValues is the browser's cryptographic RNG. Rejection */
  /* sampling removes modulo bias so every index is exactly equally likely. */
  /* ================================================================== */
  function randomInt(n) {
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do { root.crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }

  function randomCode(len = CONFIG.ROOM_CODE_LENGTH) {
    let s = '';
    for (let i = 0; i < len; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
    return s;
  }

  function randomToken() {
    const b = new Uint8Array(24);
    root.crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  /* ================================================================== */
  /* DECK GENERATION, SHUFFLING AND BURNING                             */
  /* ================================================================== */

  /** Standard 52-card deck: 13 ranks x 4 suits. */
  function createDeck() {
    const deck = [];
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
    return deck;
  }

  /** Fisher-Yates shuffle with the secure RNG. Returns a new array. */
  function secureShuffle(cards) {
    const a = cards.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function countBySuit(cards) {
    const c = { H: 0, D: 0, C: 0, S: 0 };
    for (const card of cards) c[card.suit]++;
    return SUITS.map(s => c[s]);
  }

  /**
   * CARD BURNING
   * Shuffle a fresh deck and remove the top `burnCount` cards. They are never
   * shown to anyone. If any suit would be left with fewer cards than the track
   * length (so that horse could never finish) the burn is redone. Redoing
   * keeps every valid burn equally likely.
   */
  function burnCards(burnCount, trackLength, maxAttempts = CONFIG.MAX_BURN_ATTEMPTS) {
    let result = null;
    for (let i = 0; i < maxAttempts; i++) {
      const shuffled = secureShuffle(createDeck());
      const remaining = shuffled.slice(burnCount);
      result = { burned: shuffled.slice(0, burnCount), remaining, counts: countBySuit(remaining) };
      if (result.counts.every(n => n >= trackLength)) return result;
    }
    return result; // only reachable with an extreme BURN_COUNT: impossible horses get scratched
  }

  /* ================================================================== */
  /* ODDS CALCULATION                                                   */
  /*                                                                    */
  /* Exact win probability per horse, drawing WITHOUT replacement from  */
  /* the remaining deck. Dynamic programming over race states:          */
  /*   state = cards of each suit drawn so far (all horses short of the */
  /*           finish). From a state with `left` cards, the next card is */
  /*   suit i with chance (suit i cards left / left). Reaching the       */
  /*   finish adds to that horse's win total. At most 8^4 = 4096 states. */
  /*                                                                    */
  /* Payout multiplier = 1 / probability (a 25% horse pays 4x), times    */
  /* (1 - HOUSE_EDGE), rounded DOWN to 0.1, clamped to MIN..MAX.         */
  /* ================================================================== */
  function winProbabilities(counts, trackLength) {
    const n = counts.length;
    const total = counts.reduce((a, b) => a + b, 0);
    const win = new Array(n).fill(0);
    let frontier = new Map([[new Array(n).fill(0).join(','), 1]]);
    while (frontier.size) {
      const next = new Map();
      for (const [key, p] of frontier) {
        const drawn = key.split(',').map(Number);
        const left = total - drawn.reduce((a, b) => a + b, 0);
        if (left <= 0) continue;
        for (let i = 0; i < n; i++) {
          const avail = counts[i] - drawn[i];
          if (avail <= 0) continue;
          const q = (p * avail) / left;
          if (drawn[i] + 1 >= trackLength) { win[i] += q; continue; }
          drawn[i]++;
          const k = drawn.join(',');
          drawn[i]--;
          next.set(k, (next.get(k) || 0) + q);
        }
      }
      frontier = next;
    }
    return win;
  }

  function toMultiplier(p, cfg) {
    if (!(p > 0)) return null;
    let m = Math.floor(((1 - cfg.HOUSE_EDGE) / p) / cfg.ODDS_STEP + 1e-9) * cfg.ODDS_STEP;
    m = Math.min(cfg.MAX_MULTIPLIER, Math.max(cfg.MIN_MULTIPLIER, m));
    return Math.round(m * 10) / 10;
  }

  function buildOdds(counts, cfg) {
    return winProbabilities(counts, cfg.TRACK_LENGTH).map(p => ({
      probability: p, multiplier: toMultiplier(p, cfg), scratched: !(p > 0)
    }));
  }

  /* ================================================================== */
  /* LEDGER: balances and history, stored in the HOST's browser.        */
  /* Players are identified by a secret token their own browser makes. */
  /* Same host + same player browser = same balance next time.         */
  /* ================================================================== */
  class Ledger {
    constructor(storage, key, cfg) {
      this.storage = storage; // anything with getItem/setItem (localStorage)
      this.key = key;
      this.cfg = cfg;
      this.byToken = new Map();
      this.byId = new Map();
      this.raceCounter = 0;
      this.timer = null;
      try {
        const data = JSON.parse(storage.getItem(key) || 'null');
        if (data) {
          this.raceCounter = data.raceCounter || 0;
          for (const p of data.players || []) { this.byToken.set(p.token, p); this.byId.set(p.id, p); }
        }
      } catch { /* start fresh */ }
    }
    save() {
      if (this.timer) return;
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 200);
    }
    flush() {
      try { this.storage.setItem(this.key, JSON.stringify({ raceCounter: this.raceCounter, players: [...this.byId.values()] })); } catch {}
    }
    getById(id) { return this.byId.get(id) || null; }
    /** Find a player by token, creating them with starting credits if new. */
    getOrCreate(token, name) {
      let p = this.byToken.get(token);
      if (!p) {
        let id;
        do { id = randomToken().slice(0, 12); } while (this.byId.has(id));
        p = { id, token, name: '', balance: this.cfg.STARTING_CREDITS, history: [] };
        this.byToken.set(token, p);
        this.byId.set(id, p);
      }
      if (name) p.name = name;
      this.save();
      return p;
    }
    nextRaceNumber() { this.raceCounter += 1; this.save(); return this.raceCounter; }
  }

  function cleanName(raw, cfg = CONFIG) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, cfg.NAME_MAX_LENGTH);
  }

  /* ================================================================== */
  /* ROOM: the game state machine                                       */
  /*                                                                    */
  /* lobby -> odds -> prediction -> betting -> closed -> race -> results */
  /*           ^------------------- play again -----------------------+  */
  /*                                                                    */
  /* MULTIPLAYER SYNC: after every change broadcast() sends each member  */
  /* the same public snapshot plus their own private data. Clients draw  */
  /* only from snapshots, so everyone sees the same race.                */
  /* ================================================================== */
  class Room {
    constructor({ code, ledger, cfg = CONFIG, send, onChange = () => {} }) {
      this.code = code;
      this.ledger = ledger;
      this.cfg = cfg;
      this.send = send;          // (playerId, snapshot) => deliver to that player
      this.onChange = onChange;  // called after every change (used to survive a host reload)
      this.members = new Map();  // playerId -> { connected }
      this.hostId = null;
      this.phase = 'lobby';
      this.deadline = null;
      this.race = null;
      this.lastResults = null;
      this.phaseTimer = null;
      this.autoTimer = null;
      this.closed = false;
    }

    /* ---------- membership ---------- */
    addMember(pid) {
      if (!this.members.has(pid)) {
        if (this.members.size >= this.cfg.MAX_PLAYERS_PER_ROOM) return { ok: false, error: 'This room is full.' };
        this.members.set(pid, { connected: true });
      }
      this.members.get(pid).connected = true;
      if (!this.hostId) this.hostId = pid;
      // Late joiners still get into this race while betting is open.
      if (this.race && ['odds', 'prediction', 'betting'].includes(this.phase)) this.race.participants.add(pid);
      this.broadcast();
      return { ok: true };
    }

    removeMember(pid) {
      if (!this.members.has(pid) || pid === this.hostId) return;
      this.members.delete(pid); // escrowed bets stay in and still settle
      this.checkAdvance();
      this.broadcast();
    }

    setConnected(pid, connected) {
      const m = this.members.get(pid);
      if (!m) return;
      m.connected = connected;
      this.checkAdvance();
      this.broadcast();
    }

    /** Host ends the room: refund any stakes still riding, stop timers. */
    close() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.phaseTimer);
      clearInterval(this.autoTimer);
      if (this.race && !this.race.settled) {
        for (const [pid, bet] of this.race.bets) {
          const p = this.ledger.getById(pid);
          if (p) p.balance += bet.total;
        }
        this.race.settled = true;
      }
      this.ledger.flush();
    }

    /** Single entry point for player intents. Returns { ok, error? }. */
    handle(pid, ev, data) {
      if (this.closed) return { ok: false, error: 'This room has closed.' };
      if (!this.members.has(pid)) return { ok: false, error: 'You are not in this room.' };
      switch (ev) {
        case 'startRace': return this.startRace(pid);
        case 'advance': return this.advance(pid);
        case 'predict': return this.predict(pid, data);
        case 'placeBets': return this.placeBets(pid, data);
        case 'draw': return this.drawCard(pid);
        case 'autoDraw': return this.setAutoDraw(pid, data);
        case 'leaveRoom': this.removeMember(pid); return { ok: true };
        default: return { ok: false, error: 'Unknown action.' };
      }
    }

    /* ---------- phases ---------- */
    setPhase(phase, seconds) {
      this.phase = phase;
      this.deadline = seconds ? Date.now() + seconds * 1000 : null;
      this.armTimer();
      this.broadcast();
    }

    /** (Re)start the timer for the current phase. Also used after a host reload. */
    armTimer() {
      clearTimeout(this.phaseTimer);
      const next = { odds: () => this.startPrediction(), prediction: () => this.startBetting(), betting: () => this.closeBetting(), closed: () => this.beginRace() }[this.phase];
      if (this.deadline && next) this.phaseTimer = setTimeout(next, Math.max(0, this.deadline - Date.now()));
    }

    /** Host starts a race. CARD BURNING and ODDS happen here. */
    startRace(pid) {
      if (pid !== this.hostId) return { ok: false, error: 'Only the host can start the race.' };
      if (!['lobby', 'results'].includes(this.phase)) return { ok: false, error: 'A race is already underway.' };
      const { burned, remaining, counts } = burnCards(this.cfg.BURN_COUNT, this.cfg.TRACK_LENGTH);
      this.race = {
        number: this.ledger.nextRaceNumber(),
        burned,                 // SECRET, never sent
        remaining,              // SECRET, the cards the race uses
        deck: null,             // SECRET, shuffled when the race begins
        odds: buildOdds(counts, this.cfg),
        positions: [0, 0, 0, 0],
        draws: [],
        winner: null,
        participants: new Set(this.members.keys()),
        predictions: new Map(),
        bets: new Map(),        // pid -> { wagers, total }
        settled: false,
        autoDraw: false,
        lastDrawAt: 0
      };
      this.lastResults = null;
      this.setPhase('odds', this.cfg.ODDS_REVEAL_MS / 1000);
      return { ok: true };
    }

    startPrediction() { if (this.phase === 'odds') this.setPhase('prediction', this.cfg.PREDICTION_SECONDS); }
    startBetting() { if (this.phase === 'prediction') this.setPhase('betting', this.cfg.BETTING_SECONDS); }

    advance(pid) {
      if (pid !== this.hostId) return { ok: false, error: 'Only the host can do that.' };
      if (this.phase === 'prediction') this.startBetting();
      else if (this.phase === 'betting') this.closeBetting();
      else return { ok: false, error: 'Nothing to skip right now.' };
      return { ok: true };
    }

    /**
     * Move on early once every player in the race is done. Players who are
     * briefly disconnected (reloading) still count, so a reload never closes
     * betting on someone. The phase timer and the host's skip button cover
     * anyone who wandered off.
     */
    checkAdvance() {
      if (!this.race) return;
      const active = [...this.race.participants].filter(id => this.members.has(id));
      if (!active.length) return;
      if (this.phase === 'prediction' && active.every(id => this.race.predictions.has(id))) this.startBetting();
      else if (this.phase === 'betting' && active.every(id => this.race.bets.has(id))) this.closeBetting();
    }

    /** BETTING CLOSED: predictions and wagers lock, then a short countdown. */
    closeBetting() { if (this.phase === 'betting') this.setPhase('closed', this.cfg.CLOSED_COUNTDOWN_SECONDS); }

    beginRace() {
      if (this.phase !== 'closed') return;
      this.race.deck = secureShuffle(this.race.remaining); // remaining deck shuffled again
      this.setPhase('race', 0);
    }

    /* ---------- predictions and wagers ---------- */
    predict(pid, suit) {
      if (!this.race || !['prediction', 'betting'].includes(this.phase)) return { ok: false, error: 'Predictions are closed.' };
      if (!this.race.participants.has(pid)) return { ok: false, error: 'You joined after this race locked. You are in the next one.' };
      if (!SUITS.includes(suit)) return { ok: false, error: 'Pick one of the four horses.' };
      if (this.race.odds[SUITS.indexOf(suit)].scratched) return { ok: false, error: 'That horse is scratched.' };
      this.race.predictions.set(pid, suit);
      this.broadcast();
      this.checkAdvance();
      return { ok: true };
    }

    /**
     * BETTING VALIDATION
     * wagers = { H, D, C, S } in whole credits. Rejects: betting outside the
     * betting phase, players not in this race, unknown horses, non-integers,
     * negatives, amounts outside MIN/MAX, scratched horses, and totals above
     * the player's balance. Stakes leave the balance immediately (escrow);
     * re-submitting replaces earlier bets instead of adding to them.
     */
    placeBets(pid, wagers) {
      const cfg = this.cfg;
      if (!this.race || this.phase !== 'betting') return { ok: false, error: 'Betting is closed.' };
      if (!this.race.participants.has(pid)) return { ok: false, error: 'You joined after this race locked. You are in the next one.' };
      if (!wagers || typeof wagers !== 'object' || Array.isArray(wagers)) return { ok: false, error: 'Invalid bets.' };
      const clean = { H: 0, D: 0, C: 0, S: 0 };
      for (const key of Object.keys(wagers)) {
        if (!SUITS.includes(key)) return { ok: false, error: 'Invalid horse.' };
        const v = wagers[key];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { ok: false, error: 'Bets must be whole, positive numbers.' };
        if (v > 0 && v < cfg.MIN_BET) return { ok: false, error: `Minimum bet is ${cfg.MIN_BET}.` };
        if (v > cfg.MAX_BET_PER_HORSE) return { ok: false, error: `Maximum bet per horse is ${cfg.MAX_BET_PER_HORSE}.` };
        if (v > 0 && this.race.odds[SUITS.indexOf(key)].scratched) return { ok: false, error: 'That horse is scratched.' };
        clean[key] = v;
      }
      const total = SUITS.reduce((s, k) => s + clean[k], 0);
      if (cfg.MAX_TOTAL_BET > 0 && total > cfg.MAX_TOTAL_BET) return { ok: false, error: `Total bets are capped at ${cfg.MAX_TOTAL_BET}.` };
      const player = this.ledger.getById(pid);
      if (!player) return { ok: false, error: 'Unknown player.' };
      const prev = this.race.bets.get(pid);
      const available = player.balance + (prev ? prev.total : 0);
      if (total > available) return { ok: false, error: `You only have ${available} credits.` };
      player.balance = available - total;
      this.race.bets.set(pid, { wagers: clean, total });
      this.ledger.save();
      this.broadcast();
      this.checkAdvance();
      return { ok: true };
    }

    /* ---------- race progression ---------- */
    /**
     * Draw ONE card. Its suit moves that horse one space; rank never matters.
     * The race ends the instant a horse reaches TRACK_LENGTH.
     */
    drawCard(pid, fromAuto = false) {
      const race = this.race;
      if (!fromAuto && pid !== this.hostId) return { ok: false, error: 'Only the host can draw cards.' };
      if (!race || this.phase !== 'race' || race.winner) return { ok: false, error: 'The race is not running.' };
      const now = Date.now();
      if (!fromAuto && now - race.lastDrawAt < this.cfg.MIN_DRAW_INTERVAL_MS) return { ok: false, error: 'Slow down.' };
      if (!race.deck.length) return { ok: false, error: 'The deck is empty.' };
      race.lastDrawAt = now;
      const card = race.deck.pop();
      const i = SUITS.indexOf(card.suit);
      race.positions[i] += 1;
      race.draws.push(card);
      if (race.positions[i] >= this.cfg.TRACK_LENGTH) {
        race.winner = card.suit;
        clearInterval(this.autoTimer);
        race.autoDraw = false;
        this.settle();
        this.setPhase('results', 0);
      } else {
        this.broadcast();
      }
      return { ok: true };
    }

    setAutoDraw(pid, on) {
      if (pid !== this.hostId) return { ok: false, error: 'Only the host can do that.' };
      if (!this.race || this.phase !== 'race') return { ok: false, error: 'The race is not running.' };
      this.race.autoDraw = !!on;
      clearInterval(this.autoTimer);
      if (this.race.autoDraw) {
        this.autoTimer = setInterval(() => {
          if (!this.race || this.phase !== 'race' || this.race.winner) return clearInterval(this.autoTimer);
          this.drawCard(this.hostId, true);
        }, this.cfg.AUTO_DRAW_INTERVAL_MS);
      }
      this.broadcast();
      return { ok: true };
    }

    /**
     * PAYOUT CALCULATION
     * Only the stake on the winner pays: payout = floor(stake x multiplier),
     * stake included. Stakes already left balances at confirmation, so the
     * payout is simply added back. `settled` makes this run once per race.
     */
    settle() {
      const race = this.race;
      if (race.settled) return;
      race.settled = true;
      const mult = race.odds[SUITS.indexOf(race.winner)].multiplier;
      const results = {};
      for (const pid of race.participants) {
        const player = this.ledger.getById(pid);
        if (!player) continue;
        const bet = race.bets.get(pid) || { wagers: { H: 0, D: 0, C: 0, S: 0 }, total: 0 };
        const prediction = race.predictions.get(pid) || null;
        const winningStake = bet.wagers[race.winner] || 0;
        const payout = Math.floor(winningStake * mult);
        const balanceBefore = player.balance + bet.total;
        player.balance += payout;
        let refill = 0;
        if (this.cfg.BROKE_REFILL > 0 && player.balance < this.cfg.MIN_BET) { refill = this.cfg.BROKE_REFILL; player.balance += refill; }
        results[pid] = {
          prediction, predictionCorrect: prediction ? prediction === race.winner : null,
          wagers: bet.wagers, totalBet: bet.total, winningStake, multiplier: mult,
          payout, net: payout - bet.total, balanceBefore, balanceAfter: player.balance, refill
        };
        if (prediction || bet.total > 0) {
          player.history.unshift({ race: race.number, winner: race.winner, prediction, totalBet: bet.total, payout, net: payout - bet.total, at: Date.now() });
          player.history.length = Math.min(player.history.length, this.cfg.HISTORY_LENGTH);
        }
      }
      this.lastResults = results;
      this.ledger.flush();
    }

    /* ---------- snapshots ---------- */
    publicState() {
      const race = this.race;
      const revealed = race && ['closed', 'race', 'results'].includes(this.phase);
      return {
        code: this.code,
        phase: this.phase,
        hostId: this.hostId,
        serverNow: Date.now(),
        deadline: this.deadline,
        config: {
          trackLength: this.cfg.TRACK_LENGTH, burnCount: this.cfg.BURN_COUNT, minBet: this.cfg.MIN_BET,
          maxBetPerHorse: this.cfg.MAX_BET_PER_HORSE, maxTotalBet: this.cfg.MAX_TOTAL_BET, maxPlayers: this.cfg.MAX_PLAYERS_PER_ROOM
        },
        players: [...this.members.entries()].map(([id, m]) => {
          const p = this.ledger.getById(id);
          const inRace = !!race && race.participants.has(id);
          return {
            id, name: p ? p.name : '?', balance: p ? p.balance : 0, connected: m.connected, isHost: id === this.hostId, inRace,
            predicted: inRace && race.predictions.has(id), betConfirmed: inRace && race.bets.has(id),
            prediction: revealed && inRace ? race.predictions.get(id) || null : null,      // hidden until betting closes
            betTotal: revealed && inRace ? (race.bets.get(id)?.total || 0) : null
          };
        }),
        race: race ? {
          number: race.number,
          odds: this.phase === 'odds' ? null : race.odds.map(o => ({ multiplier: o.multiplier, chance: Math.round(o.probability * 100), scratched: o.scratched })),
          positions: race.positions,
          draws: race.draws,
          cardsLeft: race.deck ? race.deck.length : race.remaining.length,
          winner: race.winner,
          autoDraw: race.autoDraw
        } : null
      };
    }

    stateFor(pid, pub) {
      const p = this.ledger.getById(pid);
      const race = this.race;
      const bet = race ? race.bets.get(pid) : null;
      return {
        ...pub,
        you: {
          id: pid, name: p ? p.name : '', balance: p ? p.balance : 0, isHost: pid === this.hostId,
          inRace: !!race && race.participants.has(pid),
          prediction: race ? race.predictions.get(pid) || null : null,
          bets: bet ? bet.wagers : null, betTotal: bet ? bet.total : 0,
          result: this.phase === 'results' && this.lastResults ? this.lastResults[pid] || null : null,
          history: p ? p.history.slice(0, 10) : []
        }
      };
    }

    broadcast() {
      if (this.closed) return;
      const pub = this.publicState();
      for (const pid of this.members.keys()) this.send(pid, this.stateFor(pid, pub));
      this.onChange();
    }

    /* ---------- surviving a host page reload ---------- */
    serialize() {
      const r = this.race;
      return {
        code: this.code, hostId: this.hostId, phase: this.phase, deadline: this.deadline, lastResults: this.lastResults,
        members: [...this.members.keys()],
        race: r ? { ...r, participants: [...r.participants], predictions: [...r.predictions], bets: [...r.bets], autoDraw: false } : null
      };
    }

    static restore(data, deps) {
      const room = new Room({ ...deps, code: data.code });
      room.hostId = data.hostId;
      room.phase = data.phase;
      room.deadline = data.deadline;
      room.lastResults = data.lastResults;
      for (const id of data.members) room.members.set(id, { connected: id === data.hostId });
      if (data.race) {
        const r = data.race;
        room.race = { ...r, participants: new Set(r.participants), predictions: new Map(r.predictions), bets: new Map(r.bets) };
      }
      room.armTimer();
      return room;
    }
  }

  const api = { CONFIG, SUITS, RANKS, randomInt, randomCode, randomToken, createDeck, secureShuffle, countBySuit, burnCards, winProbabilities, toMultiplier, buildOdds, Ledger, Room, cleanName };
  root.SD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
