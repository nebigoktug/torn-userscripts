// ==UserScript==
// @name         Torn RR Martingale & Tracker
// @namespace    https://greasyfork.org/users/nebigoktug
// @version      2.0.0
// @description  Russian Roulette: fills the bet box with your next Martingale step (you still press Start), shows the win % on shoot/x2/x3 and what the series risks, and tracks profit, streaks and series with charts. Optional log-only API key. No clicks.
// @author       NebiGoktug
// @license      MIT
// @homepageURL  https://github.com/nebigoktug/torn-userscripts
// @supportURL   https://github.com/nebigoktug/torn-userscripts/issues
// @match        https://www.torn.com/page.php?sid=russianRoulette*
// @match        https://www.torn.com/loader.php?sid=russianRoulette*
// @run-at       document-idle
// @grant        none
// @connect      api.torn.com
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_RR_Martingale.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_RR_Martingale.user.js
// ==/UserScript==

/*
 * Torn RR Martingale & Tracker
 *
 * Fills the Russian Roulette bet box with the next bet of a Martingale series (or of
 * your own bet list). You still press Start / Join and every confirm yourself: the
 * script never clicks anything in the game.
 *
 * Results are read from the page while you watch a game. With an optional log-only
 * API key, games you left before the end are read from your RR log (log 8395 win /
 * 8396 loss). Calls: one when the page opens or comes back into view (at most one per
 * 15 s), and while a game you left is unresolved, one per 30 s for up to 10 minutes.
 *
 * Everything is stored in this browser (localStorage). Set localStorage.trrm_debug = '1'
 * to log what the script sees to the console.
 */

(function () {
  'use strict';

  // PDA can re-inject on in-page navigation; run once per window.
  if (window.__trrmRunning) return;
  window.__trrmRunning = true;

  // ---------- config ----------
  const VERSION = '2.0.0';
  const KEY = { settings: 'trrm_settings', games: 'trrm_games', state: 'trrm_state', api: 'trrm_apikey', schema: 'trrm_schema' };
  const SCHEMA = 2;
  const GAMES_MAX = 5000;   // older games are folded into state.archived totals
  const IGNORED_MAX = 100;
  const RESETS_MAX = 300;
  const DAY = 864e5;
  const HOSPITAL_MIN = 20;  // a lost game sends you to hospital for about this long
  // list: custom bets per step (overrides base/mult/maxSteps when not empty)
  // target: daily profit target (display only) · flash: flash + vibrate on a result
  const DEFAULTS = { base: 0, mult: 2.1, maxSteps: 10, list: [], dailyLimit: 0, target: 0,
    fast: true, underFinger: true, compact: true, flash: false };
  // seriesFromT: games before this time (ms) belong to an earlier series (last manual reset)
  // resets: every manual reset time, so streaks and series history break there too
  // unlockDay: TCT day on which the daily loss limit was unlocked
  // open: { t, bet } for a game seen running whose result hasn't been seen yet
  // logCursor: timestamp (s) of the newest RR log entry imported; 0 = rebuild from the log
  // ignoredIds / ignoredFp: games removed with "Undo last result" (log id, or time+bet
  //   for a game the log hasn't been linked to yet), never imported again
  // archived: { n, w, net, wag } totals of games dropped beyond GAMES_MAX
  const STATE_DEFAULTS = { seriesFromT: 0, resets: [], unlockDay: '', open: null, logCursor: 0,
    ignoredIds: [], ignoredFp: [], archived: null, lastSyncAt: 0 };

  const DEBUG = (() => { try { return localStorage.getItem('trrm_debug') === '1'; } catch (_) { return false; } })();
  const debug = (...a) => { if (DEBUG) console.debug('[TRRM]', ...a); };

  // Torn's class names carry a build hash (barrel___u0URT); match the stable prefix.
  const SEL = {
    app: '[class*="appWrapper___"]',
    title: '[class*="appHeaderWrapper___"] h4[class*="title___"], h4[class*="title___"]',
    create: '[class*="createWrap___"]',
    joinRow: '[class*="joinWrap___"] [class*="row___"]',
    joinBet: '[class*="betBlock___"][aria-label^="Bet amount:"]',
    barrel: '[class*="barrel___"]',
    barrelDone: '[class*="barrel___"][class*="finished___"]',
    // Only the RR message area: other Torn parts (chat button) also use message___ classes.
    message: '[class*="messageWrap___"] [class*="message___"]',
    pot: 'span[class*="count___"]',
    shotBtn: '[class*="buttonsWrap___"] button[class*="commitButton___"]',
    moneyInput: 'input.input-money, input[aria-label="Money value"]',
    betArea: '[class*="createWrap___"], [class*="betBlock___"]',
    ours: '#trrm-bar, #trrm-line, #trrm-pop, #trrm-scrim',
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => root.querySelectorAll(sel);
  const appRoot = () => $(SEL.app) || document;

  // ---------- storage ----------
  let storageError = false;
  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      storageError = false;
      return true;
    } catch (e) {
      // Full or blocked storage: say so in the bar instead of losing results silently.
      storageError = true;
      debug('save failed', key, e);
      return false;
    }
  }

  // Whatever is stored is checked field by field; a broken value falls back to the default.
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  function cleanSettings(raw) {
    const s = Object.assign({}, DEFAULTS, isObj(raw) ? raw : {});
    s.base = Math.max(0, num(s.base, 0));
    s.mult = num(s.mult, 0) >= 1 && s.mult <= 10 ? s.mult : DEFAULTS.mult;
    s.maxSteps = Math.min(30, Math.max(1, Math.round(num(s.maxSteps, DEFAULTS.maxSteps))));
    s.list = Array.isArray(s.list) ? s.list.map(Number).filter(v => v > 0).slice(0, 30) : [];
    s.dailyLimit = Math.max(0, num(s.dailyLimit, 0));
    s.target = Math.max(0, num(s.target, 0));
    for (const k of ['fast', 'underFinger', 'compact', 'flash']) if (typeof s[k] !== 'boolean') s[k] = DEFAULTS[k];
    return s;
  }
  // games: [{ t: ms, bet: $, win: bool, id?: Torn log id, live?: ms the game was first seen
  //          running, seen?: true once the page result and the log entry are linked }], oldest first
  function cleanGames(raw) {
    return (Array.isArray(raw) ? raw : [])
      .filter(g => isObj(g) && Number.isFinite(g.t) && Number.isFinite(g.bet) && g.bet > 0 && typeof g.win === 'boolean');
  }
  function cleanState(raw) {
    const s = Object.assign({}, STATE_DEFAULTS, isObj(raw) ? raw : {});
    s.seriesFromT = num(s.seriesFromT, 0);
    s.resets = Array.isArray(s.resets) ? s.resets.filter(Number.isFinite) : [];
    s.ignoredIds = Array.isArray(s.ignoredIds) ? s.ignoredIds.map(String) : [];
    s.ignoredFp = Array.isArray(s.ignoredFp) ? s.ignoredFp.filter(f => isObj(f) && Number.isFinite(f.t) && f.bet > 0) : [];
    s.logCursor = Math.floor(num(s.logCursor, 0));
    s.lastSyncAt = num(s.lastSyncAt, 0);
    if (!(isObj(s.open) && Number.isFinite(s.open.t) && s.open.bet > 0)) s.open = null;
    if (typeof s.unlockDay !== 'string') s.unlockDay = '';
    if (!(isObj(s.archived) && Number.isFinite(s.archived.n))) s.archived = null;
    return s;
  }

  // Stored data from older versions.
  function migrate() {
    const v = num(load(KEY.schema, 1), 1);
    if (v >= SCHEMA) return;
    const st = isObj(load(KEY.state, {})) ? load(KEY.state, {}) : {};
    let gs = Array.isArray(load(KEY.games, [])) ? load(KEY.games, []) : [];
    // Pre-release 1.2.0 read the activity log panel and could count games twice. Drop
    // those imports; with a key the log rebuild puts the real games back.
    if ('logFromT' in st) {
      gs = gs.filter(g => g && !g.k);
      delete st.logFromT;
    }
    // 1.1.x stored the series start as an index into games.
    if ('seriesFrom' in st) {
      const i = st.seriesFrom;
      st.seriesFromT = gs[i] ? gs[i].t : (i > 0 ? Date.now() : 0);
      delete st.seriesFrom;
    }
    if (st.seriesFromT > 0 && !Array.isArray(st.resets)) st.resets = [st.seriesFromT];
    save(KEY.games, gs);
    save(KEY.state, st);
    save(KEY.schema, SCHEMA);
    debug('migrated storage', v, '->', SCHEMA);
  }
  migrate();

  let settings, games, state;
  // Other tabs on the RR page write the same storage; re-read before every change
  // so one tab never overwrites games another tab recorded.
  function reloadStored() {
    settings = cleanSettings(load(KEY.settings, {}));
    games = cleanGames(load(KEY.games, []));
    state = cleanState(load(KEY.state, {}));
  }
  reloadStored();

  function saveGames() {
    // Never keep the same log entry twice, whatever path added it.
    const ids = new Set();
    games = games.filter(g => !g.id || (!ids.has(g.id) && ids.add(g.id)));
    games.sort((a, b) => a.t - b.t);
    if (games.length > GAMES_MAX) {
      const a = state.archived || { n: 0, w: 0, net: 0, wag: 0 };
      for (const g of games.slice(0, games.length - GAMES_MAX)) {
        a.n++; a.w += g.win ? 1 : 0; a.net += profitOf(g); a.wag += g.bet;
      }
      state.archived = a;
      games = games.slice(-GAMES_MAX);
      save(KEY.state, state);
    }
    save(KEY.games, games);
  }

  // ---------- helpers ----------
  // TCT is UTC.
  const tctDay = ms => new Date(ms).toISOString().slice(0, 10);
  const today = () => tctDay(Date.now());
  const dayStart = (ms = Date.now()) => Math.floor(ms / DAY) * DAY;
  const hhmm = ms => new Date(ms).toISOString().slice(11, 16);
  function fmt(n) {
    const a = Math.abs(n);
    const s = a >= 1e9 ? (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'b'
      : a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'm'
      : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k'
      : String(Math.round(a));
    return (n < 0 ? '-$' : '$') + s.replace(/\.0+([kmb])$/, '$1').replace(/(\.\d*[1-9])0+([kmb])$/, '$1$2');
  }
  const fmtFull = n => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
  const signed = n => (n > 0 ? '+' : '') + fmt(n);
  const tone = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  // "1.5m", "250k", "1,500,000", "$2b"; a comma before 1-2 digits and a suffix is a
  // decimal comma ("1,5m"), anything else unclear is rejected rather than misread.
  function parseMoney(text) {
    let s = String(text || '').trim().toLowerCase().replace(/[$\s]/g, '');
    if (/^\d+,\d{1,2}[kmb]$/.test(s)) s = s.replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?[kmb]?$/.test(s)) s = s.replace(/,/g, '');
    const m = s.match(/^(\d+(?:\.\d+)?)([kmb]?)$/);
    if (!m) return NaN;
    return Math.round(parseFloat(m[1]) * { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]]);
  }
  // Bets separated by spaces, ";" or commas; a comma inside a number (1,500,000 or 1,5m) stays.
  const parseList = text => (String(text).match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?[kmb]?|\d+,\d{1,2}[kmb]|[^\s,;]+/gi) || []).map(parseMoney);
  const profitOf = g => (g.win ? g.bet : -g.bet);

  function lossStreak() {
    let n = 0;
    for (let i = games.length - 1; i >= 0 && games[i].t >= state.seriesFromT; i--) {
      if (games[i].win) break;
      n++;
    }
    return n;
  }
  function cash() {
    const el = document.getElementById('user-money');
    const v = el ? parseInt(el.getAttribute('data-money'), 10) : NaN;
    return Number.isFinite(v) ? v : null;
  }

  // ---------- plan math ----------
  const useList = () => settings.list.length > 0;
  const maxSteps = () => (useList() ? settings.list.length : settings.maxSteps);
  const startBet = () => (useList() ? settings.list[0] : settings.base);
  function stepAmount(step) {
    if (useList()) return settings.list[Math.min(step, settings.list.length - 1)];
    return Math.round(settings.base * Math.pow(settings.mult, step));
  }
  // Sum of the bets from step `from` to the last step.
  function costFrom(from) {
    let s = 0;
    for (let i = from; i < maxSteps(); i++) s += stepAmount(i);
    return s;
  }
  // How many of the remaining steps (from `from`) the given cash pays for, in a row.
  function stepsCovered(from, money) {
    let n = 0, s = 0;
    for (let i = from; i < maxSteps(); i++) { s += stepAmount(i); if (s > money) break; n++; }
    return n;
  }
  const oneIn = k => `1 in ${Math.pow(2, k) >= 1e6 ? Math.round(Math.pow(2, k) / 1e6) + 'm' : Math.pow(2, k).toLocaleString('en-US')}`;
  // Total lost so far in the current series (consecutive losses)
  function seriesLost(streak) {
    let s = 0;
    for (let i = games.length - streak; i < games.length; i++) s += games[i].bet;
    return s;
  }

  // ---------- stats ----------
  // Games from `from` (ms) on; games are sorted, so walk back from the newest.
  function gamesSince(from) {
    let i = games.length;
    while (i > 0 && games[i - 1].t >= from) i--;
    return games.slice(i);
  }
  const resetTimes = () => state.resets.slice().sort((a, b) => a - b);
  // w/l, net, wagered, max drawdown, longest losing run (broken by resets),
  // biggest bet and z = net / sqrt(sum bet²): how far from a fair coin's expected 0.
  function summarize(list) {
    const resets = resetTimes();
    let w = 0, net = 0, wag = 0, sq = 0, peak = 0, dd = 0, run = 0, maxRun = 0, big = 0, ri = 0;
    for (const g of list) {
      while (ri < resets.length && resets[ri] <= g.t) { run = 0; ri++; }
      if (g.win) { w++; run = 0; } else maxRun = Math.max(maxRun, ++run);
      net += profitOf(g); wag += g.bet; sq += g.bet * g.bet; big = Math.max(big, g.bet);
      peak = Math.max(peak, net); dd = Math.max(dd, peak - net);
    }
    return { n: list.length, w, l: list.length - w, net, wag, dd, maxRun, big, z: sq ? net / Math.sqrt(sq) : 0 };
  }
  const PERIODS = {
    today: { label: 'Today', from: () => dayStart() },
    d7: { label: '7 days', from: () => dayStart() - 6 * DAY },
    d30: { label: '30 days', from: () => dayStart() - 29 * DAY },
    all: { label: 'All time', from: () => 0 },
  };
  function periodStats(p) {
    const s = summarize(gamesSince(PERIODS[p].from()));
    const a = state.archived;
    if (p === 'all' && a) { s.n += a.n; s.w += a.w; s.l += a.n - a.w; s.net += a.net; s.wag += a.wag; }
    return s;
  }
  function luckText(z, n) {
    if (n < 20) return 'too few games to tell';
    const a = Math.abs(z);
    const word = a < 1 ? 'about average' : a < 2 ? (z > 0 ? 'a bit lucky' : 'a bit unlucky') : (z > 0 ? 'very lucky' : 'very unlucky');
    return `${word} (${z >= 0 ? '+' : ''}${z.toFixed(1)}σ)`;
  }
  // Martingale series rebuilt from the games: a series ends with a win, with every step
  // lost, or at a manual reset (stopped).
  function seriesHistory() {
    const resets = resetTimes();
    const done = [];
    let cur = null, ri = 0;
    for (const g of games) {
      while (ri < resets.length && resets[ri] <= g.t) {
        if (cur) { cur.end = 'stopped'; done.push(cur); cur = null; }
        ri++;
      }
      if (!cur) cur = { t: g.t, steps: 0, net: 0 };
      cur.steps++; cur.net += profitOf(g); cur.endT = g.t;
      if (g.win) { cur.end = 'won'; done.push(cur); cur = null; } else if (cur.steps >= maxSteps()) { cur.end = 'lost'; done.push(cur); cur = null; }
    }
    return done;
  }

  // ---------- Martingale decision ----------
  // Returns { amount, streak, block?, reset?, unlock? } where block is a reason not to fill.
  function nextBet() {
    if (!(startBet() > 0)) return { amount: 0, block: 'Set your start bet in ⚙ first.' };
    if (openGameUnseen()) return { amount: 0, block: 'open' };
    const streak = lossStreak();
    const net = summarize(gamesSince(dayStart())).net;
    if (settings.dailyLimit > 0 && net <= -settings.dailyLimit && state.unlockDay !== today()) {
      return { amount: 0, streak, unlock: true, block: `Daily loss limit reached (${fmt(net)}).` };
    }
    if (streak >= maxSteps()) {
      return { amount: 0, streak, reset: true, block: `Series lost: ${streak} losses in a row, ${fmt(-seriesLost(streak))}.` };
    }
    const amount = stepAmount(streak);
    const c = cash();
    if (c != null && amount > c) {
      return { amount, streak, reset: true, block: `Not enough cash for step ${streak + 1} (${fmt(amount)}, you have ${fmt(c)}).` };
    }
    return { amount, streak };
  }
  function lockedToday() {
    return settings.dailyLimit > 0 && summarize(gamesSince(dayStart())).net <= -settings.dailyLimit && state.unlockDay !== today();
  }

  // ---------- DOM: bet box ----------
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  let lastAutoValue = null; // what we last wrote into the bet box

  function betInput() {
    return document.querySelector('[class*="createWrap___"] input[aria-label="Money value"]')
      || document.querySelector('[class*="betBlock___"] input.input-money')
      || document.querySelector('[class*="createWrap___"] input.input-money');
  }
  function inputAmount(inp) {
    const v = parseInt(String(inp.value || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(v) ? v : 0;
  }
  function fillBet(inp, amount) {
    nativeSetter.call(inp, amount == null ? '' : String(amount));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    lastAutoValue = amount;
  }

  // ---------- look ----------
  const ICON = {
    gear: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.5 7.5 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 1.7 1L11 21h4l.4-2.9a7.5 7.5 0 0 0 1.7-1l2.5 1 2-3.5zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
    close: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg>',
  };
  // Colours are tokens on .trrm, light by default and dark with Torn's dark mode. The
  // overlays on Torn's own buttons sit outside .trrm and use fixed colours.
  const STYLES = `
    .trrm { --bg: #ffffff; --card: #f1f4f7; --fg: #1d2329; --dim: #5b6873; --line: #d5dbe0; --chip: #e3e8ed;
      --pos: #2e7d32; --neg: #c62828; --warn: #a15c00; --acc: #1e6fd9; --r: 8px; --tap: 44px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-variant-numeric: tabular-nums;
      color: var(--fg) !important; text-align: left; }
    body.dark-mode .trrm { --bg: #1b2229; --card: #232d37; --fg: #e6edf3; --dim: #9fb0c0; --line: #3a4753; --chip: #2e3a46;
      --pos: #66bb6a; --neg: #ef6b6b; --warn: #ffb74d; --acc: #4aa3ff; }
    .trrm *, .trrm *::before, .trrm *::after { box-sizing: border-box; }
    .trrm [hidden] { display: none !important; }
    .trrm .pos { color: var(--pos) !important; } .trrm .neg { color: var(--neg) !important; }
    .trrm .dim { color: var(--dim) !important; } .trrm .warnc { color: var(--warn) !important; }
    .trrm b { color: inherit; }
    .trrm button, .trrm .btn { display: inline-flex; align-items: center; justify-content: center; min-height: var(--tap);
      padding: 0 14px; margin: 0; border: 0; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 600;
      background: var(--chip) !important; color: var(--fg) !important; text-transform: none; letter-spacing: 0; }
    .trrm button.pri { background: var(--acc) !important; color: #fff !important; }
    .trrm button.danger { background: var(--neg) !important; color: #fff !important; }
    .trrm button.armed { outline: 2px solid var(--neg); outline-offset: 2px; }
    .trrm button.icon { min-width: var(--tap); padding: 0; background: transparent !important; color: var(--dim) !important; }
    .trrm svg.i { width: 22px; height: 22px; fill: currentColor; }

    #trrm-bar { margin: 6px 0; padding: 2px 2px 8px 10px; border-radius: var(--r); background: var(--bg) !important;
      border: 1px solid var(--line); border-left: 4px solid var(--pos); }
    #trrm-bar.warn { border-left-color: var(--neg); } #trrm-bar.manual { border-left-color: var(--warn); }
    #trrm-bar .hd { display: flex; align-items: center; gap: 8px; min-height: var(--tap); }
    #trrm-bar .big { font-size: 19px; font-weight: 700; white-space: nowrap; }
    #trrm-bar .step { color: var(--dim); font-weight: 600; white-space: nowrap; }
    #trrm-bar .seg { display: flex; gap: 2px; flex: 1; max-width: 150px; }
    #trrm-bar .seg i { flex: 1; height: 5px; border-radius: 2px; background: var(--line); }
    #trrm-bar .seg i.on { background: var(--acc); } #trrm-bar .seg i.on.late { background: var(--neg); }
    #trrm-bar .msg { flex: 1; padding: 6px 0; }
    #trrm-bar .trrm-gear { margin-left: auto; flex: none; }
    #trrm-bar .sub { display: flex; flex-wrap: wrap; gap: 2px 12px; padding-right: 8px; color: var(--dim); font-size: 12px; }
    #trrm-bar .sub b { font-weight: 700; }
    #trrm-bar .acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    #trrm-bar .err { margin-top: 4px; color: var(--neg) !important; font-weight: 600; }

    #trrm-line { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0 8px; min-height: 30px; margin: 2px 0 4px;
      padding: 3px 12px; border-radius: 15px; cursor: pointer; font-size: 12px; font-weight: 600;
      background: var(--card) !important; border: 1px solid var(--line); }
    #trrm-line.goal { border-color: var(--pos); box-shadow: inset 0 0 0 1px var(--pos); }
    #trrm-line.flash-win { box-shadow: 0 0 0 3px var(--pos); } #trrm-line.flash-loss { box-shadow: 0 0 0 3px var(--neg); }

    #trrm-scrim { position: fixed; inset: 0; z-index: 99998; background: rgba(0,0,0,.45); }
    #trrm-pop { position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 99999; max-width: 440px; max-height: 86vh;
      margin: 0 auto; display: flex; flex-direction: column; overflow: hidden; border-radius: 12px;
      background: var(--bg) !important; border: 1px solid var(--line); box-shadow: 0 8px 28px rgba(0,0,0,.45); }
    #trrm-pop header { display: flex; align-items: center; padding: 2px 2px 0 14px; }
    #trrm-pop h4 { flex: 1; margin: 0; font-size: 15px; font-weight: 700; color: var(--fg) !important; }
    #trrm-pop nav { display: flex; padding: 0 6px; border-bottom: 1px solid var(--line); }
    #trrm-pop nav button { flex: 1; border-radius: 0; background: transparent !important; color: var(--dim) !important; }
    #trrm-pop nav button[aria-selected="true"] { color: var(--fg) !important; box-shadow: inset 0 -3px var(--acc); }
    #trrm-pop .body { flex: 1; overflow: auto; padding: 10px 14px 14px; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    #trrm-pop footer { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
    #trrm-pop footer button { flex: 1; }
    #trrm-pop h5 { margin: 16px 0 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--dim) !important; }
    #trrm-pop .card { padding: 10px; border-radius: var(--r); background: var(--card) !important; }
    #trrm-pop .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    #trrm-pop .kpi { flex-direction: column; align-items: flex-start; min-height: 58px; padding: 6px 8px; font-weight: 400;
      background: var(--card) !important; border: 2px solid transparent; }
    #trrm-pop .kpi[aria-pressed="true"] { border-color: var(--acc); }
    #trrm-pop .kpi small { display: block; font-size: 11px; color: var(--dim); }
    #trrm-pop .kpi b { display: block; font-size: 14px; font-weight: 700; white-space: nowrap; }
    @media (max-width: 360px) { #trrm-pop .kpis { grid-template-columns: repeat(2, 1fr); } }
    #trrm-pop .chart { margin-top: 10px; }
    #trrm-pop svg.trrm-chart { display: block; width: 100%; height: auto; }
    .trrm-chart .zero { stroke: var(--dim); stroke-dasharray: 3 3; opacity: .6; }
    .trrm-chart .ln { fill: none; stroke: var(--neg); stroke-width: 2; stroke-linejoin: round; } .trrm-chart .ln.pos { stroke: var(--pos); }
    .trrm-chart .up { fill: var(--pos); } .trrm-chart .dn { fill: var(--neg); }
    .trrm-chart .a-up { fill: var(--pos); opacity: .15; } .trrm-chart .a-dn { fill: var(--neg); opacity: .15; }
    .trrm-chart .base { stroke: var(--line); }
    .trrm-chart text { font-size: 10px; fill: var(--dim); font-family: inherit; }
    #trrm-pop .axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--dim); }
    #trrm-pop .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; margin-top: 8px; }
    #trrm-pop .grid > div { display: flex; justify-content: space-between; gap: 6px; padding: 5px 0; border-bottom: 1px solid var(--line); }
    #trrm-pop .grid span { color: var(--dim); } #trrm-pop .grid b { font-weight: 700; text-align: right; }
    @media (max-width: 360px) { #trrm-pop .grid { grid-template-columns: 1fr; } }
    #trrm-pop table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
    #trrm-pop td, #trrm-pop th { padding: 4px; text-align: right; border-bottom: 1px solid var(--line); }
    #trrm-pop th { color: var(--dim) !important; font-weight: 600; font-size: 11px; }
    #trrm-pop td.l, #trrm-pop th.l { text-align: left; }
    #trrm-pop tr.day td { padding-top: 10px; text-align: left; font-size: 11px; font-weight: 700; color: var(--dim) !important; border: 0; }
    #trrm-pop tr.cur td { color: var(--acc) !important; font-weight: 700; }
    #trrm-pop tr.nocash td { opacity: .5; }
    #trrm-pop .chip { display: inline-block; min-width: 20px; padding: 0 5px; border-radius: 4px; text-align: center;
      font-size: 11px; font-weight: 700; color: #fff !important; }
    #trrm-pop .chip.w { background: var(--pos); } #trrm-pop .chip.l { background: var(--neg); }
    #trrm-pop label { display: block; margin: 10px 0 4px; font-size: 12px; color: var(--dim) !important; }
    #trrm-pop input:not([type="checkbox"]), #trrm-pop textarea { display: block; width: 100%; min-height: 42px; padding: 8px 10px;
      border-radius: 6px; border: 1px solid var(--line); background: var(--card) !important; color: var(--fg) !important; font-size: 16px; }
    #trrm-pop textarea { min-height: 96px; font: 11px/1.35 ui-monospace, Menlo, monospace; }
    #trrm-pop label.chk { display: flex; align-items: center; gap: 10px; min-height: 42px; margin: 0; font-size: 13px; color: var(--fg) !important; }
    #trrm-pop label.chk input { width: 20px; height: 20px; margin: 0; flex: none; }
    #trrm-pop .prev { min-height: 16px; font-size: 12px; color: var(--pos) !important; }
    #trrm-pop .err { flex-basis: 100%; color: var(--neg) !important; font-weight: 600; }
    #trrm-pop .err:empty { display: none; }
    #trrm-pop .note { margin-top: 8px; font-size: 12px; color: var(--dim) !important; }
    #trrm-pop .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    #trrm-pop .row > * { flex: 1; }
    #trrm-pop details { margin-top: 6px; }
    #trrm-pop summary { display: flex; align-items: center; min-height: 42px; cursor: pointer; font-weight: 600; color: var(--fg) !important; }
    #trrm-pop .empty { padding: 28px 10px; text-align: center; color: var(--dim) !important; }
    #trrm-pop a { color: var(--acc) !important; }
    #trrm-pop label.btn { display: flex; margin: 0; font-size: 13px; color: var(--fg) !important; }
    #trrm-key { -webkit-text-security: disc; }

    [class*="buttonsWrap___"] button[data-trrm-p]::after { content: attr(data-trrm-p); display: block; font-size: 11px;
      font-weight: 600; line-height: 1.1; opacity: .85; }
    [class*="buttonsWrap___"] button[data-trrm-q="best"] { box-shadow: inset 0 -3px 0 #4caf50 !important; }
    [class*="buttonsWrap___"] button[data-trrm-q="zero"] { box-shadow: inset 0 -3px 0 #e53935 !important; }
    [class*="joinWrap___"] [class*="row___"][data-trrm-match] { box-shadow: inset 4px 0 0 #4caf50; background: rgba(76,175,80,.14) !important; }
  `;
  function injectStyles() {
    if (document.getElementById('trrm-styles')) return;
    const s = document.createElement('style');
    s.id = 'trrm-styles';
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  // Dangerous actions take two taps on the same button (no browser dialogs on PDA).
  const ARM = {
    unlock: ['Unlock today', 'Tap again to unlock'],
    clear: ['Clear history', 'Tap again to delete all'],
    'undo-last': ['Undo last result', 'Tap again to remove it'],
  };
  let armed = '';
  let armTimer = null;
  const armBtn = (name, id, cls = '') => `<button type="button" ${id ? `id="${id}" ` : ''}data-act="${name}" data-arm="${name}"`
    + ` class="${cls}${armed === name ? ' armed' : ''}">${ARM[name][+(armed === name)]}</button>`;
  const actBtn = (act, label, cls = '') => `<button type="button" data-act="${act}" class="${cls}">${label}</button>`;
  function refreshArmed() {
    $$('[data-arm]').forEach(b => {
      const n = b.dataset.arm;
      b.textContent = ARM[n][+(armed === n)];
      b.classList.toggle('armed', armed === n);
    });
  }
  function armOrRun(name, fn) {
    clearTimeout(armTimer);
    if (armed === name) { armed = ''; fn(); refreshArmed(); return; }
    armed = name;
    armTimer = setTimeout(() => { armed = ''; tick(); refreshArmed(); }, 3000);
    tick();
    refreshArmed();
  }

  // ---------- UI: bar above the create box ----------
  let barHtml = '';
  function ensureBar() {
    const wrap = $(SEL.create);
    let bar = document.getElementById('trrm-bar');
    if (!wrap) { if (bar) bar.remove(); return null; }
    if (!bar || !bar.isConnected || bar.nextElementSibling !== wrap) {
      if (bar) bar.remove();
      bar = document.createElement('div');
      bar.id = 'trrm-bar';
      barHtml = '';
      bar.addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        e.preventDefault(); e.stopPropagation();
        if (act === 'settings') openSettings();
        else if (act === 'ignore') forgetOpen();
        else if (act === 'reset') resetSeries();
        else if (act === 'undo-reset') undoReset();
        else if (act === 'unlock') armOrRun('unlock', unlockToday);
      });
      wrap.parentNode.insertBefore(bar, wrap);
      // Back from a game: put the bar (and Start right under it) at the same spot every time.
      if (justFinished) { justFinished = false; try { bar.scrollIntoView({ block: 'start' }); } catch (_) {} }
    }
    return bar;
  }

  function renderBar(nb) {
    const bar = ensureBar();
    if (!bar) return;
    const inp = betInput();
    let cls = '', head = '', sub = '', acts = '';
    if (Date.now() < undoUntil) {
      head = `<span class="msg">Series reset · next bet <b>${fmt(startBet())}</b></span>`;
      acts = actBtn('undo-reset', 'Undo');
    } else if (nb.block === 'open') {
      const o = state.open;
      cls = 'warn';
      head = `<span class="msg">The ${fmt(o.bet)} game from ${hhmm(o.t)} TCT `
        + (missedWhileVisible ? 'ended, but its result couldn\'t be read from the page (Torn may have changed it). '
          : 'ended while you were away. ')
        + (!apiKey() ? 'Add a log key in ⚙ to read its result.'
          : syncError ? `Couldn't read your log: ${esc(syncError)}.` : 'Reading the result from your log…') + '</span>';
      acts = actBtn('ignore', 'Ignore it');
    } else if (nb.block) {
      cls = 'warn';
      head = `<span class="msg">${nb.block}</span>`;
      acts = (nb.reset ? actBtn('reset', 'Reset series') : '') + (nb.unlock ? armBtn('unlock', '', 'danger') : '');
    } else {
      const s = nb.streak, N = maxSteps();
      const lostSoFar = seriesLost(s);
      const typed = inp ? inputAmount(inp) : 0;
      const manual = inp && userEdited && typed > 0 && typed !== nb.amount;
      const bet = manual ? typed : nb.amount;
      if (manual) cls = 'manual';
      const left = N - s;
      const c = cash();
      const covered = c == null ? null : stepsCovered(s, c);
      const segs = N > 1 ? `<span class="seg" aria-hidden="true">${Array.from({ length: N }, (_, i) =>
        `<i class="${i <= s ? 'on' : ''}${i >= N - 2 ? ' late' : ''}"></i>`).join('')}</span>` : '';
      head = `<span class="big" title="${fmtFull(bet)}">${fmt(bet)}</span> <span class="step">step ${s + 1}/${N}</span>${segs}`;
      sub = (manual ? `<span class="warnc">your bet (plan ${fmt(nb.amount)})</span>` : '')
        + `<span>win <b class="pos">${signed(bet - lostSoFar)}</b></span>`
        + `<span>lose <b class="neg">${fmt(-(lostSoFar + bet))}</b></span>`
        + `<span>all ${left} lost (${oneIn(left)}) ${fmt(-(lostSoFar + costFrom(s)))}</span>`
        + (covered == null ? '' : `<span class="${covered < left ? 'warnc' : ''}">cash ${covered}/${left}</span>`);
      if (!inp) {
        cls = 'warn';
        sub += `<span class="neg">Can't find the bet box (Torn may have changed the page): type ${fmt(bet)} yourself.</span>`;
      }
    }
    const gear = `<button type="button" class="icon trrm-gear" data-act="settings" aria-label="Settings" title="Settings">${ICON.gear}</button>`;
    const html = `<div class="hd">${head}${gear}</div>`
      + (sub ? `<div class="sub">${sub}</div>` : '')
      + (acts ? `<div class="acts">${acts}</div>` : '')
      + (storageError ? `<div class="err">Can't save to this browser's storage (full or blocked): results aren't being kept.</div>` : '');
    const className = 'trrm' + (cls ? ' ' + cls : '');
    if (bar.className !== className) bar.className = className;
    if (barHtml !== html) { bar.innerHTML = html; barHtml = html; }
  }

  // Reset with a 5 s undo instead of a confirmation.
  let undoUntil = 0;
  let undoSeriesFromT = 0;
  function resetSeries() {
    reloadStored();
    undoSeriesFromT = state.seriesFromT;
    state.seriesFromT = Date.now();
    state.resets = state.resets.concat(state.seriesFromT).slice(-RESETS_MAX);
    save(KEY.state, state);
    undoUntil = Date.now() + 5000;
    setTimeout(schedule, 5100);
    closePop();
    tick();
  }
  function undoReset() {
    reloadStored();
    const t = state.seriesFromT;
    state.resets = state.resets.filter(r => r !== t);
    state.seriesFromT = undoSeriesFromT;
    save(KEY.state, state);
    undoUntil = 0;
    tick();
  }
  function unlockToday() {
    reloadStored();
    state.unlockDay = today();
    save(KEY.state, state);
    closePop();
    tick();
  }

  // Torn pre-fills the box (e.g. "10" or the last bet), so the value alone can't tell
  // whether the user chose it. userEdited is set only by the user's own typing or the
  // $ (max) button, and cleared when the box is re-rendered or a game is recorded.
  let userEdited = false;
  let lastInput = null;

  function autofill(nb) {
    const inp = betInput();
    if (!inp) { lastAutoValue = null; lastInput = null; return; }
    if (inp !== lastInput) { lastInput = inp; userEdited = false; }
    const cur = inputAmount(inp);
    if (userEdited && cur === 0) userEdited = false; // emptied box: back to the plan
    if (nb.block) {
      // Clear only what we wrote ourselves; never touch the user's own amount.
      if (!userEdited && lastAutoValue != null && cur === lastAutoValue) { fillBet(inp, null); lastAutoValue = null; }
      return;
    }
    if (userEdited) return;
    if (cur === nb.amount) { lastAutoValue = nb.amount; return; }
    fillBet(inp, nb.amount);
  }

  // ---------- UI: today line under the title ----------
  let lineHtml = '';
  function ensureLine() {
    const title = $(SEL.title);
    let line = document.getElementById('trrm-line');
    if (!title || !title.parentNode) return null;
    if (!line || !line.isConnected) {
      line = document.createElement('div');
      line.id = 'trrm-line';
      line.className = 'trrm';
      line.setAttribute('role', 'button');
      line.setAttribute('aria-label', 'Russian Roulette stats');
      lineHtml = '';
      line.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openStats(); });
      title.parentNode.insertBefore(line, title.nextSibling);
    }
    return line;
  }

  function renderLine() {
    const line = ensureLine();
    if (!line) return;
    const s = summarize(gamesSince(dayStart()));
    const streak = lossStreak();
    const goal = settings.target > 0 && s.net >= settings.target;
    // During a game the bar is gone; this line is the only thing on screen.
    const inGame = state.open && $(SEL.barrel);
    const html = `<span>Today <span class="${tone(s.net)}">${signed(s.net)}</span></span>`
      + `<span class="dim">${s.w}W-${s.l}L</span>`
      + (streak ? `<span class="neg">${streak}L streak</span>` : '')
      + (inGame ? `<span>step ${streak + 1} · ${fmt(state.open.bet)} at stake</span>` : '')
      + (goal ? '<span class="pos">target reached</span>' : '');
    if (lineHtml !== html) { line.innerHTML = html; lineHtml = html; }
    line.classList.toggle('goal', goal);
  }

  function flashResult(win) {
    if (!settings.flash) return;
    try { navigator.vibrate && navigator.vibrate(win ? 60 : [90, 60, 90]); } catch (_) {}
    const line = document.getElementById('trrm-line');
    if (!line) return;
    line.classList.add(win ? 'flash-win' : 'flash-loss');
    setTimeout(() => line.classList.remove('flash-win', 'flash-loss'), 700);
  }

  // ---------- UI: panel (Stats / Plan / Settings) ----------
  const TABS = { stats: 'Stats', plan: 'Plan', settings: 'Settings' };
  let period = 'today';

  function closePop() {
    document.getElementById('trrm-pop')?.remove();
    document.getElementById('trrm-scrim')?.remove();
  }
  const openStats = () => openPanel('stats');
  const openSettings = () => openPanel('settings');

  function openPanel(tab) {
    closePop();
    const scrim = document.createElement('div');
    scrim.id = 'trrm-scrim';
    scrim.addEventListener('click', closePop);
    const pop = document.createElement('div');
    pop.id = 'trrm-pop';
    pop.className = 'trrm';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'trrm-h');
    pop.innerHTML = `<header><h4 id="trrm-h">Russian Roulette</h4>`
      + `<button type="button" class="icon x" data-act="close" aria-label="Close" title="Close">${ICON.close}</button></header>`
      + `<nav role="tablist">${Object.entries(TABS).map(([k, v]) => `<button type="button" role="tab" data-goto="${k}">${v}</button>`).join('')}</nav>`
      + `<div class="body"><section data-tab="stats" role="tabpanel">${statsHtml()}</section>`
      + `<section data-tab="plan" role="tabpanel">${planHtml()}</section>`
      + `<section data-tab="settings" role="tabpanel">${settingsHtml()}</section></div>`
      + `<footer data-tab="stats">${games.length ? armBtn('undo-last', 'trrm-undo-last') : ''}</footer>`
      + `<footer data-tab="plan">${actBtn('reset', 'Reset series')}${lockedToday() ? armBtn('unlock', 'trrm-unlock', 'danger') : ''}</footer>`
      + `<footer data-tab="settings"><div class="err" id="trrm-err"></div><button type="button" class="pri" id="trrm-save" data-act="save">Save</button></footer>`;
    pop.addEventListener('click', e => onPanelClick(pop, e));
    pop.addEventListener('input', () => preview(pop));
    pop.querySelector('#trrm-file').addEventListener('change', e => importFile(pop, e.target));
    document.body.appendChild(scrim);
    document.body.appendChild(pop);
    showTab(pop, tab);
    preview(pop);
    return pop;
  }

  function showTab(pop, tab) {
    pop.querySelectorAll('[data-tab]').forEach(el => { el.hidden = el.dataset.tab !== tab; });
    pop.querySelectorAll('nav [data-goto]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.goto === tab)));
    const footer = pop.querySelector(`footer[data-tab="${tab}"]`);
    if (footer && !footer.children.length) footer.hidden = true;
    pop.querySelector('.body').scrollTop = 0;
  }

  function onPanelClick(pop, e) {
    const el = e.target.closest('[data-act], [data-goto], [data-period]');
    if (!el || !pop.contains(el)) return;
    if (el.dataset.goto) { showTab(pop, el.dataset.goto); return; }
    if (el.dataset.period) {
      period = el.dataset.period;
      pop.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === period)));
      pop.querySelector('#trrm-period').innerHTML = periodHtml(period);
      return;
    }
    switch (el.dataset.act) {
      case 'close': closePop(); break;
      case 'save': saveSettings(pop); break;
      case 'reset': resetSeries(); break;
      case 'unlock': armOrRun('unlock', unlockToday); break;
      case 'undo-last': armOrRun('undo-last', undoLast); break;
      case 'clear': armOrRun('clear', clearHistory); break;
      case 'export-json': download(`rr-martingale-${today()}.json`, backupJson(), 'application/json'); break;
      case 'export-csv': download(`rr-games-${today()}.csv`, gamesCsv(), 'text/csv'); break;
      case 'show-text': pop.querySelector('#trrm-text').value = backupJson(); break;
      case 'restore-text': restore(pop, pop.querySelector('#trrm-text').value); break;
    }
  }

  // --- Stats tab ---
  function statsHtml() {
    if (!games.length && !state.archived) {
      return `<div class="empty">No games yet.<br>Results show up here after each game you watch to the end${apiKey() ? '' : ', or from your RR log if you add a key in Settings'}.</div>`;
    }
    const kpis = Object.keys(PERIODS).map(p => {
      const s = periodStats(p);
      return `<button type="button" class="kpi" data-period="${p}" aria-pressed="${p === period}">`
        + `<small>${PERIODS[p].label}</small><b class="${tone(s.net)}" title="${fmtFull(s.net)}">${signed(s.net)}</b><small>${plural(s.n, 'game')}</small></button>`;
    }).join('');
    return `<div class="kpis">${kpis}</div><div id="trrm-period">${periodHtml(period)}</div>`
      + `<h5>Recent games · TCT</h5>${recentHtml()}`
      + `<div class="note">${apiKey() ? 'Synced with your RR log.' : 'Only games you watch to the end are counted; add a log key in Settings to catch the rest.'} Stored in this browser only.</div>`;
  }

  function periodHtml(p) {
    const list = gamesSince(PERIODS[p].from());
    const s = periodStats(p);
    if (!s.n) return `<div class="empty">No games ${p === 'today' ? 'today' : 'in this period'}.</div>`;
    const cell = (label, value, cls = '') => `<div><span>${label}</span><b class="${cls}">${value}</b></div>`;
    const archived = p === 'all' && state.archived ? `<div class="note">Includes ${state.archived.n.toLocaleString('en-US')} older games kept as totals only.</div>` : '';
    return chartHtml(p, list)
      + `<div class="grid">`
      + cell('Games', `${s.w}W · ${s.l}L`)
      + cell('Win rate', `${(s.w / s.n * 100).toFixed(1)}%`)
      + cell('Wagered', fmt(s.wag))
      + cell('Net', `${signed(s.net)}${s.wag ? ` (${(s.net / s.wag * 100).toFixed(1)}%)` : ''}`, tone(s.net))
      + cell('Max drawdown', s.dd ? fmt(-s.dd) : '$0', s.dd ? 'neg' : '')
      + cell('Longest losing run', s.maxRun)
      + cell('Biggest bet', fmt(s.big))
      + cell('Hospital time', `≈ ${hours(s.l * HOSPITAL_MIN)}`)
      + `</div>`
      + `<div class="note">Luck: ${luckText(s.z, list.length)}. Every game is a fair 50/50, so profit or loss here is variance, not skill.</div>`
      + archived + seriesHtml(PERIODS[p].from());
  }
  const hours = min => (min < 60 ? `${min} min` : `${(min / 60).toFixed(min < 600 ? 1 : 0)} h`);

  // Cumulative profit (line) and profit per day or per game (bars) as an inline SVG.
  function chartHtml(p, list) {
    let vals, from, per = 1;
    if (p === 'today') vals = list.map(profitOf);
    else {
      from = p === 'all' ? dayStart(games[0] ? games[0].t : Date.now()) : PERIODS[p].from();
      const days = Math.max(1, Math.round((dayStart() - from) / DAY) + 1);
      per = Math.ceil(days / 120); // long histories: a bar per few days
      vals = new Array(Math.ceil(days / per)).fill(0);
      for (const g of list) {
        const i = Math.floor((g.t - from) / DAY / per);
        if (i >= 0 && i < vals.length) vals[i] += profitOf(g);
      }
    }
    if (!vals.length) return '';
    const pts = [0];
    for (const v of vals) pts.push(pts[pts.length - 1] + v);
    const W = 320, H = 86, BH = 26, GAP = 8;
    const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1;
    const x = i => (i / (pts.length - 1)) * W;
    const y = v => 8 + ((hi - v) / span) * (H - 16);
    const y0 = y(0).toFixed(1);
    const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${line}L${W},${y0}L0,${y0}Z`;
    const end = pts[pts.length - 1];
    const maxAbs = Math.max(...vals.map(Math.abs)) || 1;
    const bw = W / vals.length, mid = H + GAP + BH / 2;
    const bars = vals.map((v, i) => {
      if (!v) return '';
      const h = Math.max(1, (Math.abs(v) / maxAbs) * (BH / 2 - 1));
      return `<rect class="${v > 0 ? 'up' : 'dn'}" x="${(i * bw + bw * 0.15).toFixed(1)}" width="${Math.max(1, bw * 0.7).toFixed(1)}"`
        + ` y="${(v > 0 ? mid - h : mid).toFixed(1)}" height="${h.toFixed(1)}"/>`;
    }).join('');
    const endY = Math.min(H - 4, Math.max(10, y(end) - 5));
    const label = `${PERIODS[p].label}: ${signed(end)}, low ${fmt(lo)}, high ${fmt(hi)}`;
    return `<div class="chart"><svg class="trrm-chart" viewBox="0 0 ${W} ${H + GAP + BH}" role="img" aria-label="${label}">`
      + `<defs><clipPath id="trrm-cu"><rect x="0" y="0" width="${W}" height="${y0}"/></clipPath>`
      + `<clipPath id="trrm-cd"><rect x="0" y="${y0}" width="${W}" height="${H}"/></clipPath></defs>`
      + `<path class="a-up" d="${area}" clip-path="url(#trrm-cu)"/><path class="a-dn" d="${area}" clip-path="url(#trrm-cd)"/>`
      + `<line class="zero" x1="0" x2="${W}" y1="${y0}" y2="${y0}"/>`
      + `<path class="ln ${end >= 0 ? 'pos' : 'neg'}" d="${line}"/>`
      + `<circle cx="${W}" cy="${y(end).toFixed(1)}" r="3" class="${end >= 0 ? 'up' : 'dn'}"/>`
      + (hi > 0 ? `<text x="2" y="10">${fmt(hi)}</text>` : '')
      + (lo < 0 ? `<text x="2" y="${H - 2}">${fmt(lo)}</text>` : '')
      + `<text x="${W - 8}" y="${endY.toFixed(1)}" text-anchor="end">${signed(end)}</text>`
      + `<line class="base" x1="0" x2="${W}" y1="${mid}" y2="${mid}"/>${bars}</svg>`
      + `<div class="axis"><span>${p === 'today' ? 'first game' : tctDay(from).slice(5)}</span>`
      + `<span>${p === 'today' ? `bars: each game` : per > 1 ? `bars: ${per} days each` : 'bars: each day'}</span>`
      + `<span>${p === 'today' ? 'now' : 'today'}</span></div></div>`;
  }

  function seriesHtml(from) {
    const done = seriesHistory().filter(x => x.endT >= from);
    if (!done.length) return '';
    const won = done.filter(x => x.end === 'won'), lost = done.filter(x => x.end === 'lost');
    const stopped = done.length - won.length - lost.length;
    const avg = l => (l.length ? l.reduce((a, x) => a + x.net, 0) / l.length : 0);
    const finished = won.length + lost.length;
    const N = maxSteps();
    const rows = [];
    for (let k = 1; k <= N; k++) {
      const n = won.filter(x => x.steps === k).length;
      const exp = finished * Math.pow(0.5, k);
      if (n || k <= 4 || exp >= 0.5) rows.push(`<tr><td class="l">won at step ${k}</td><td>${n}</td><td>${exp.toFixed(1)}</td></tr>`);
    }
    rows.push(`<tr><td class="l">lost all ${N}</td><td>${lost.length}</td><td>${(finished * Math.pow(0.5, N)).toFixed(1)}</td></tr>`);
    return `<details><summary>Series: ${won.length} won · ${lost.length} lost all${stopped ? ` · ${stopped} stopped` : ''}</summary>`
      + `<div class="grid">`
      + `<div><span>Avg won series</span><b class="pos">${signed(avg(won))}</b></div>`
      + `<div><span>Avg lost series</span><b class="${lost.length ? 'neg' : ''}">${lost.length ? fmt(avg(lost)) : '–'}</b></div></div>`
      + `<table><tr><th class="l">ended</th><th>yours</th><th>expected</th></tr>${rows.join('')}</table>`
      + `<div class="note">Expected = what a fair coin gives on average for ${finished} finished series with the current plan.</div></details>`;
  }

  function recentHtml() {
    const rows = [];
    let lastDay = '';
    for (const g of games.slice(-20).reverse()) {
      const d = tctDay(g.t);
      if (d !== lastDay) { rows.push(`<tr class="day"><td colspan="3">${d === today() ? 'Today' : d}</td></tr>`); lastDay = d; }
      rows.push(`<tr><td class="l">${hhmm(g.t)}</td><td class="l"><span class="chip ${g.win ? 'w' : 'l'}">${g.win ? 'W' : 'L'}</span> ${fmt(g.bet)}</td>`
        + `<td class="${tone(profitOf(g))}">${signed(profitOf(g))}</td></tr>`);
    }
    return rows.length ? `<table>${rows.join('')}</table>` : '<div class="note">Only older games, kept as totals.</div>';
  }

  // Remove the newest recorded game (a miscount). It is remembered, so the next sync
  // doesn't bring it back from the log.
  function undoLast() {
    reloadStored();
    const g = games.pop();
    if (g && g.id) state.ignoredIds = state.ignoredIds.concat(g.id).slice(-IGNORED_MAX);
    else if (g) state.ignoredFp = state.ignoredFp.concat({ t: g.t, live: g.live, bet: g.bet, win: g.win }).slice(-IGNORED_MAX);
    save(KEY.games, games);
    save(KEY.state, state);
    userEdited = false;
    tick();
    openStats();
  }

  // --- Plan tab ---
  function planHtml() {
    if (!(startBet() > 0)) return '<div class="empty">Set your start bet in Settings to see the plan.</div>';
    const N = maxSteps();
    const streak = Math.min(lossStreak(), N);
    const c = cash();
    const reach = c == null ? N : streak + stepsCovered(streak, c);
    const rows = [];
    let total = 0;
    for (let i = 0; i < N; i++) {
      const bet = stepAmount(i);
      total += bet;
      const cls = (i === streak ? 'cur' : '') + (i >= reach ? ' nocash' : '');
      rows.push(`<tr class="${cls}"><td class="l">${i + 1}</td><td>${fmt(bet)}</td><td>${fmt(total)}</td>`
        + `<td class="pos">${signed(2 * bet - total)}</td><td>${oneIn(i)}</td></tr>`);
    }
    const full = costFrom(0);
    const p50 = (1 - Math.pow(1 - Math.pow(0.5, N), 50)) * 100;
    const fromOne = c == null ? null : stepsCovered(0, c);
    const now = streak >= N ? `<b class="neg">Series lost</b>: reset to start again.`
      : `Now at <b>step ${streak + 1} of ${N}</b>${streak ? `, ${fmt(-seriesLost(streak))} lost so far` : ''}.`;
    return `<div class="card">${now}</div>`
      + `<table><tr><th class="l">step</th><th>bet</th><th>total in</th><th>if won</th><th>reached</th></tr>${rows.join('')}</table>`
      + (c != null && reach < N ? `<div class="note">Faded rows: your cash (${fmt(c)}) doesn't cover them.</div>` : '')
      + `<h5>Risk</h5><div class="grid">`
      + `<div><span>Lose all ${N} steps</span><b class="neg">${fmt(-full)}</b></div>`
      + `<div><span>Chance per series</span><b>${oneIn(N)}</b></div>`
      + `<div><span>In 50 series</span><b>${p50.toFixed(1)}%</b></div>`
      + `<div><span>Hospital, all lost</span><b>${hours(N * HOSPITAL_MIN)}</b></div>`
      + (fromOne == null ? '' : `<div><span>Cash covers</span><b class="${fromOne < N ? 'warnc' : ''}">${fromOne} of ${N} steps</b></div>`
        + `<div><span>All cash gone</span><b>${fromOne ? oneIn(fromOne) : 'now'}</b></div>`)
      + `</div><div class="note">Each game is a fair 50/50 with no house cut, so on average Martingale wins nothing: many small wins, now and then one big loss. A series costs about one ${HOSPITAL_MIN} min hospital stay on average.</div>`;
  }

  // --- Settings tab ---
  // "1.5m" when that reads back as exactly the same amount, the plain number otherwise.
  const shortExact = v => (parseMoney(fmt(v)) === v ? fmt(v).slice(1) : String(v));
  function settingsHtml() {
    const money = (id, label, v) => `<label for="${id}">${label}</label><input id="${id}" value="${v > 0 ? shortExact(v) : ''}"
        inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-lpignore="true"><div class="prev" data-for="${id}"></div>`;
    const chk = (id, on, label) => `<label class="chk"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;
    const key = apiKey();
    const status = !key ? 'No key: only games you watch to the end are counted.'
      : syncError ? `<b class="neg">${esc(syncError)}</b>`
      : state.lastSyncAt ? `Last synced ${tctDay(state.lastSyncAt) === today() ? '' : tctDay(state.lastSyncAt) + ' '}${hhmm(state.lastSyncAt)} TCT.` : 'Not synced yet.';
    return `<h5>Bet plan</h5>
      ${money('trrm-base', 'Start bet (e.g. 100k, 1.5m)', settings.base)}
      <div class="row"><div><label for="trrm-mult">Multiplier after a loss</label><input id="trrm-mult" value="${settings.mult}" inputmode="decimal" autocomplete="off"></div>
      <div><label for="trrm-steps">Max steps</label><input id="trrm-steps" value="${settings.maxSteps}" inputmode="numeric" autocomplete="off"></div></div>
      <label for="trrm-list">Custom bets per step (optional, replaces the three above)</label><input id="trrm-list"
        value="${useList() ? settings.list.map(shortExact).join(' ') : ''}" placeholder="100k 210k 450k 1m"
        inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-lpignore="true"><div class="prev" data-for="trrm-list"></div>
      <h5>Limits</h5>
      ${money('trrm-limit', 'Daily loss limit (empty = off)', settings.dailyLimit)}
      ${money('trrm-target', 'Daily profit target (empty = off; the top line turns green)', settings.target)}
      <div class="note">Days are Torn days (TCT = UTC): both start fresh at 00:00 TCT, even in the middle of a series.</div>
      <h5>Display</h5>
      ${chk('trrm-fast', settings.fast, 'No animations (barrel, skull, fades)')}
      ${chk('trrm-finger', settings.underFinger, 'Confirm button under your finger after Start/Join')}
      ${chk('trrm-compact', settings.compact, 'Compact layout (hide the big title)')}
      ${chk('trrm-flash', settings.flash, 'Flash and vibrate on a result')}
      <h5>RR log (optional)</h5>
      <label for="trrm-key">API key with log access</label><input id="trrm-key" value="${esc(key)}" autocomplete="off"
        autocapitalize="off" spellcheck="false" data-lpignore="true" inputmode="text">
      <div class="note">${status}</div>
      <div class="note">Reads only your Russian Roulette win/loss log, so games you left before the end still count.
        <a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=RR%20Martingale&user=log" target="_blank" rel="noopener">Create a log-only key</a>.
        Stored in this browser only and sent only to api.torn.com.</div>
      <h5>Backup</h5>
      <div class="row">${actBtn('export-json', 'Download backup')}${actBtn('export-csv', 'Download CSV')}</div>
      <div class="row"><label class="btn">Restore from file<input type="file" id="trrm-file" accept=".json,application/json" hidden></label></div>
      <details><summary>Backup as text (if downloads don't work in your app)</summary>
        <textarea id="trrm-text" spellcheck="false" autocomplete="off" placeholder="Tap 'Show backup', copy it; or paste a backup and tap 'Restore'."></textarea>
        <div class="row">${actBtn('show-text', 'Show backup')}${actBtn('restore-text', 'Restore')}</div>
      </details>
      <div class="note" id="trrm-bk"></div>
      <div class="row">${armBtn('clear', 'trrm-clear', 'danger')}</div>
      <div class="note">v${VERSION} · fills the bet box only; you press Start/Join yourself.</div>`;
  }

  // Live preview of what an amount field will be read as.
  function preview(pop) {
    pop.querySelectorAll('.prev').forEach(el => {
      const text = String(pop.querySelector('#' + el.dataset.for).value).trim();
      if (!text) { el.textContent = ''; return; }
      if (el.dataset.for === 'trrm-list') {
        const l = parseList(text);
        el.textContent = l.some(v => !(v > 0)) ? '?' : `= ${l.map(v => fmt(v)).join(', ')} · ${l.length} steps, ${fmt(l.reduce((a, b) => a + b, 0))} in total`;
      } else {
        const v = parseMoney(text);
        el.textContent = v > 0 ? `= ${fmtFull(v)}` : '?';
      }
    });
  }

  function saveSettings(pop) {
    const val = id => String(pop.querySelector(id).value).trim();
    const err = msg => { pop.querySelector('#trrm-err').textContent = msg; };
    const list = val('#trrm-list') ? parseList(val('#trrm-list')) : [];
    const base = parseMoney(val('#trrm-base'));
    const mult = parseFloat(val('#trrm-mult').replace(',', '.'));
    const steps = parseInt(val('#trrm-steps'), 10);
    const opt = id => (val(id) ? parseMoney(val(id)) : 0);
    const limit = opt('#trrm-limit'), target = opt('#trrm-target');
    if (list.some(v => !(v > 0)) || list.length > 30) return err('Custom bets: up to 30 amounts like 100k 210k 450k.');
    if (!list.length && !(base > 0)) return err('Start bet must be an amount like 100k or 1.5m.');
    if (!list.length && !(mult >= 1 && mult <= 10)) return err('Multiplier must be between 1 and 10.');
    if (!list.length && !(steps >= 1 && steps <= 30)) return err('Max steps must be between 1 and 30.');
    if (!(limit >= 0)) return err('Daily loss limit must be an amount like 5m, or empty.');
    if (!(target >= 0)) return err('Profit target must be an amount like 5m, or empty.');
    const key = val('#trrm-key');
    if (key !== apiKey()) {
      try { key ? localStorage.setItem(KEY.api, key) : localStorage.removeItem(KEY.api); } catch (_) {}
      syncError = '';
      reloadStored();
      state.logCursor = 0; // new key: rebuild from its log
      save(KEY.state, state);
      syncLog(true);
    }
    settings = cleanSettings({ base: base > 0 ? base : settings.base, mult: mult >= 1 ? mult : settings.mult,
      maxSteps: steps >= 1 ? steps : settings.maxSteps, list, dailyLimit: limit, target,
      fast: pop.querySelector('#trrm-fast').checked,
      underFinger: pop.querySelector('#trrm-finger').checked,
      compact: pop.querySelector('#trrm-compact').checked,
      flash: pop.querySelector('#trrm-flash').checked });
    save(KEY.settings, settings);
    closePop();
    tick();
  }

  function clearHistory() {
    reloadStored();
    games = [];
    Object.assign(state, { seriesFromT: 0, resets: [], open: null, archived: null, ignoredFp: [],
      logCursor: Math.floor(Date.now() / 1000) }); // don't import the cleared games again
    save(KEY.games, games);
    save(KEY.state, state);
    closePop();
    tick();
  }

  // --- backup (local files only, nothing is sent anywhere) ---
  function backupJson() {
    return JSON.stringify({ app: 'trrm', version: VERSION, schema: SCHEMA, exported: new Date().toISOString(), settings,
      state: { seriesFromT: state.seriesFromT, resets: state.resets, ignoredIds: state.ignoredIds, archived: state.archived },
      games });
  }
  function gamesCsv() {
    return 'time_tct,bet,result,profit,log_id\n'
      + games.map(g => [new Date(g.t).toISOString(), g.bet, g.win ? 'W' : 'L', profitOf(g), g.id || ''].join(',')).join('\n') + '\n';
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click(); // our own link to a local file, not a game control
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function importFile(pop, input) {
    const f = input.files && input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => restore(pop, String(r.result));
    r.readAsText(f);
    input.value = '';
  }
  // Settings are replaced; games are merged (same log id, or same time, bet and result = same game).
  function restore(pop, text) {
    const note = pop.querySelector('#trrm-bk');
    let data;
    try { data = JSON.parse(text); } catch (_) { note.textContent = 'That is not a backup from this script.'; return; }
    const incoming = cleanGames(Array.isArray(data) ? data : data && data.games);
    if (!incoming.length && !(data && data.settings)) { note.textContent = 'No games or settings found in it.'; return; }
    reloadStored();
    const ids = new Set(games.filter(g => g.id).map(g => g.id));
    const fps = new Set(games.map(g => `${g.t}|${g.bet}|${g.win}`));
    const add = incoming.filter(g => !(g.id && ids.has(g.id)) && !fps.has(`${g.t}|${g.bet}|${g.win}`));
    games = games.concat(add);
    if (data && isObj(data.settings)) { settings = cleanSettings(data.settings); save(KEY.settings, settings); }
    if (data && isObj(data.state)) {
      const s = cleanState(data.state);
      state.resets = [...new Set(state.resets.concat(s.resets))].sort((a, b) => a - b).slice(-RESETS_MAX);
      state.seriesFromT = Math.max(state.seriesFromT, s.seriesFromT);
      state.ignoredIds = [...new Set(state.ignoredIds.concat(s.ignoredIds))].slice(-IGNORED_MAX);
      if (!state.archived && s.archived) state.archived = s.archived;
    }
    saveGames();
    save(KEY.state, state);
    tick();
    openSettings();
    const n = document.querySelector('#trrm-pop #trrm-bk');
    if (n) n.textContent = `Restored: ${plural(add.length, 'new game')}${data && data.settings ? ' and your settings' : ''}.`;
  }

  // ---------- game result detection ----------
  // A result is only counted after we have seen that game live on this page,
  // so reloading a finished game never counts it twice.
  let sawLive = false;
  let recorded = false;
  let liveT = 0; // when this game was first seen running (shared with other tabs via state.open)
  let justFinished = false; // scroll the bar into place when the create box comes back
  let hiddenSinceLive = false; // the page was hidden while a game ran
  let missedWhileVisible = false; // a game ended on screen but no result was readable

  // class*="red___" alone would match colored___ / centered___ too.
  function resultMessage() {
    for (const m of $$(SEL.message)) {
      const c = String(m.className || '');
      if (/(^|\s)green___/.test(c)) return { win: true };
      if (/(^|\s)red___/.test(c)) return { win: false };
      const t = m.textContent || '';
      if (t.includes('You take your winnings')) return { win: true };
      if (t.includes('You fall down')) return { win: false };
    }
    return null;
  }

  function potAmount() {
    const potEl = $(SEL.pot, appRoot());
    const pot = potEl ? parseInt(String(potEl.textContent).replace(/[^\d]/g, ''), 10) : NaN;
    return pot > 0 ? pot : 0;
  }

  // A game seen running is stored as open until its result is seen. If you leave
  // before the end, no bet is filled until the result is read from the log
  // (a missed loss would otherwise restart the series at step 1).
  function openGameUnseen() {
    return !!(state.open && !$(SEL.barrel) && !resultMessage());
  }

  // A page result and a log entry are the same game when outcome and bet match and the
  // log time falls between the moment the game was first seen running and the moment
  // its result was seen (a game can run many minutes: each turn has a 3 min timer).
  // SKEW allows for the phone clock being off from Torn's.
  const SKEW_MS = 60000;
  const LOOSE_MS = 10 * 60000; // second pass for a phone clock that is further off
  function sameGame(page, log) {
    if (page.win !== log.win || page.bet !== log.bet) return false;
    const from = (page.live || page.t) - SKEW_MS;
    return log.t >= from && log.t <= page.t + SKEW_MS;
  }

  function record(win, bet, live) {
    reloadStored();
    // Another tab on the RR page already recorded this game.
    if (games.some(o => o.live === live)) { state.open = null; save(KEY.state, state); return; }
    const g = { t: Date.now(), bet, win, live };
    // Already imported from the log (synced while the result was on screen).
    const fromLog = games.filter(o => o.id && !o.seen && sameGame(g, o)).sort((a, b) => a.t - b.t)[0];
    if (fromLog) { fromLog.seen = true; fromLog.live = live; } else games.push(g);
    state.open = null;
    saveGames();
    save(KEY.state, state);
    debug('recorded', g, fromLog ? 'linked to log ' + fromLog.id : 'new');
    // New game: whatever is in the box now gets replaced with the next step.
    userEdited = false;
    justFinished = true;
    missedWhileVisible = false;
    flashResult(win);
  }

  function forgetOpen() {
    reloadStored();
    state.open = null;
    save(KEY.state, state);
    missedWhileVisible = false;
    tick();
  }

  function checkGame() {
    const barrel = $(SEL.barrel);
    const finished = !!$(SEL.barrelDone);
    const result = resultMessage();
    if (!barrel && !result) {
      // Watched the game to its end, yet no result was ever readable: Torn changed the page.
      if (sawLive && !recorded && !hiddenSinceLive && state.open) missedWhileVisible = true;
      sawLive = false; recorded = false; hiddenSinceLive = false;
      return;
    }
    const pot = potAmount();
    if (barrel && !finished && !result) {
      if (!sawLive) { liveT = Date.now(); hiddenSinceLive = false; debug('live game', pot); }
      sawLive = true; recorded = false;
      const bet = Math.round(pot / 2);
      if (bet && state.open && state.open.bet === bet) {
        // Same game seen before a reload, or by another tab: keep its start time.
        liveT = Math.min(liveT, state.open.t);
      } else if (bet) {
        reloadStored();
        state.open = { t: liveT, bet };
        save(KEY.state, state);
      }
      return;
    }
    // Back on the page after the open game ended: the result is still shown, use it.
    if (!sawLive && result && state.open && !recorded) {
      recorded = true;
      record(result.win, state.open.bet, state.open.t);
      return;
    }
    if (!sawLive || recorded || !result) return;
    if (!pot) return; // wait for the pot to render
    recorded = true;
    record(result.win, Math.round(pot / 2), liveT);
  }

  // ---------- RR log via the API (optional key) ----------
  // Only with a key the user gave. The log ids make every game unique, so nothing is
  // ever counted twice.
  const LOG_WIN = 8395, LOG_LOSS = 8396;
  const SYNC_MIN_MS = 15000;
  const OPEN_RETRY_MS = 30000;
  const OPEN_RETRY_MAX = 20;
  const FETCH_TIMEOUT_MS = 15000;
  const REBUILD_DAYS = 30;
  const REBUILD_PAGES = 10;
  // Torn API error codes: what to tell the user and how long to wait before trying again.
  const API_ERRORS = {
    2: ['the API key is wrong', 0],
    5: ['too many API requests, trying again in a minute', 60e3],
    8: ['Torn blocked API requests from this IP for now', 600e3],
    9: ['the Torn API is disabled for now', 300e3],
    10: ['the key owner is in federal jail', 3600e3],
    13: ['the key is disabled while its owner is inactive', 3600e3],
    14: ['the key reached its daily read limit', 3600e3],
    16: ['key has no log access', 3600e3],
    17: ['Torn API backend error, trying again soon', 60e3],
    18: ['the key is paused', 3600e3],
  };
  let syncing = false;
  let syncAgain = false; // a forced sync (e.g. a new key) arrived while one was running
  let lastSync = 0;
  let syncBlockedUntil = 0;
  let syncError = '';
  let openRetries = { t: 0, n: 0 };
  let retryTimer = null;

  function apiKey() {
    try { return (localStorage.getItem(KEY.api) || '').trim(); } catch (_) { return ''; }
  }

  // One page of RR win/loss entries (the API returns at most 100, newest first).
  async function fetchLog(key, from, to) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let data;
    try {
      const res = await fetch(`https://api.torn.com/user/?selections=log&log=${LOG_WIN},${LOG_LOSS}`
        + `&from=${from}${to ? `&to=${to}` : ''}&key=${encodeURIComponent(key)}&comment=RRMartingale`,
      ctrl ? { signal: ctrl.signal } : undefined);
      if (res.ok === false) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } finally { clearTimeout(timer); }
    if (data && data.error) {
      const known = API_ERRORS[data.error.code];
      const e = new Error(known ? known[0] : String(data.error.error || 'Torn API error'));
      e.api = data.error.code;
      e.wait = known ? known[1] : 60e3;
      throw e;
    }
    return Object.entries((data && data.log) || {})
      .map(([id, l]) => ({ id, log: l.log, ts: l.timestamp, pot: l.data && l.data.pot }))
      .filter(l => (l.log === LOG_WIN || l.log === LOG_LOSS) && l.pot > 0);
  }
  const toGame = l => ({ id: String(l.id), t: l.ts * 1000, bet: Math.round(l.pot / 2), win: l.log === LOG_WIN });

  async function syncLog(force) {
    const key = apiKey();
    if (!key) return;
    if (syncing) { if (force) syncAgain = true; return; }
    if (!force && (Date.now() - lastSync < SYNC_MIN_MS || Date.now() < syncBlockedUntil)) return;
    if (!force && navigator.onLine === false) return;
    syncing = true;
    lastSync = Date.now();
    try {
      reloadStored();
      const rebuild = !state.logCursor;
      const since = rebuild ? Math.floor(Date.now() / 1000) - REBUILD_DAYS * 86400 : state.logCursor;
      // Page backwards until we reach `since`; a normal sync is a single call.
      const logs = [];
      let to = 0;
      let complete = false;
      for (let page = 0; page < REBUILD_PAGES; page++) {
        const batch = await fetchLog(key, since, to);
        logs.push(...batch);
        if (batch.length < 100) { complete = true; break; }
        to = Math.min(...batch.map(l => l.ts)) - 1;
      }
      reloadStored();
      const ignored = new Set(state.ignoredIds);
      const found = logs.map(toGame)
        .filter(g => !ignored.has(g.id) && !state.ignoredFp.some(f => sameGame(f, g)))
        .sort((a, b) => a.t - b.t);
      const known = new Set(games.filter(g => g.id).map(g => g.id));
      const fresh = found.filter(g => !known.has(g.id));
      const added = []; // log games with no page result: games you weren't watching
      const link = (page, g) => { page.id = g.id; page.t = g.t; page.seen = true; };
      if (rebuild) {
        // The log is the truth for the window it covered: replace whatever was recorded
        // there, keeping only page results newer than the log (game just ended). If the
        // window was too big to fetch, only the part that was fetched is replaced.
        const fromMs = complete || !found.length ? since * 1000 : found[0].t;
        const newest = found.length ? found[found.length - 1].t : 0;
        games = games.filter(g => g.t < fromMs)
          .concat(found, games.filter(g => !g.id && g.t >= fromMs && g.t > newest + SKEW_MS));
        added.push(...fresh);
      } else {
        const left = [];
        for (const g of fresh) {
          // Same game already recorded on the page: give it the log id and server time.
          const page = games.filter(o => !o.id && sameGame(o, g)).sort((a, b) => a.t - b.t)[0];
          if (page) link(page, g); else left.push(g);
        }
        for (const g of left) {
          // Phone clock off by more than a minute: pair in order with a page game of the
          // same bet and result close by.
          const page = games.filter(o => !o.id && o.win === g.win && o.bet === g.bet && Math.abs(o.t - g.t) <= LOOSE_MS)
            .sort((a, b) => a.t - b.t)[0];
          if (page) link(page, g); else { games.push(g); added.push(g); }
        }
      }
      for (const g of found) state.logCursor = Math.max(state.logCursor, Math.floor(g.t / 1000));
      // Only a log game no page result explains, for this game's bet and from after it
      // started, resolves the open game (the previous game's entry comes back too: `from`
      // is inclusive).
      if (state.open && added.some(g => g.bet === state.open.bet && g.t >= state.open.t - (rebuild ? SKEW_MS : LOOSE_MS))) {
        state.open = null;
        missedWhileVisible = false;
      }
      if (!state.logCursor) state.logCursor = since;
      state.lastSyncAt = Date.now();
      syncError = '';
      syncBlockedUntil = 0;
      saveGames();
      save(KEY.state, state);
      debug('synced', { rebuild, found: found.length, fresh: fresh.length, added: added.length });
    } catch (e) {
      syncError = e.api ? e.message : e.name === 'AbortError' ? 'Torn API timed out' : 'Torn API unreachable';
      syncBlockedUntil = Date.now() + (e.api ? e.wait : 30e3);
      debug('sync failed', e);
      // A key Torn rejects is removed, so it isn't retried on every visit.
      if (e.api === 2) { try { localStorage.removeItem(KEY.api); } catch (_) {} }
    } finally {
      syncing = false;
      schedule();
      if (syncAgain) { syncAgain = false; syncLog(true); }
    }
  }

  // While a game you left is unresolved, look at the log again now and then: Torn may
  // write the entry a little after the game ends.
  function retryOpen() {
    if (!state.open || !apiKey() || syncing || document.hidden || !openGameUnseen()) return;
    if (openRetries.t !== state.open.t) openRetries = { t: state.open.t, n: 0 };
    if (openRetries.n >= OPEN_RETRY_MAX || Date.now() - lastSync < OPEN_RETRY_MS || Date.now() < syncBlockedUntil) {
      if (openRetries.n < OPEN_RETRY_MAX && !retryTimer) {
        const wait = Math.max(OPEN_RETRY_MS - (Date.now() - lastSync), syncBlockedUntil - Date.now(), 1000) + 100;
        retryTimer = setTimeout(() => { retryTimer = null; schedule(); }, wait);
      }
      return;
    }
    openRetries.n++;
    syncLog(false);
  }

  // ---------- look & feel (display only) ----------
  // No animations: Torn's barrel spin (1.8 s), skull spin (2.5 s), fades and blood flash
  // are cut to 1 ms. Not 0 / none: Torn's code may wait for animationend/transitionend,
  // which never fire then. The barrel is only a picture; the result comes from Torn's server.
  const FAST_CSS = `
    [class*="appWrapper___"] *, [class*="appWrapper___"] *::before, [class*="appWrapper___"] *::after {
      animation-duration: 1ms !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
      transition-duration: 1ms !important; transition-delay: 0s !important; }`;
  const COMPACT_CSS = `
    [class*="appHeaderWrapper___"] h4[class*="title___"] { display: none !important; }
    [class*="appHeaderWrapper___"] hr[class*="delimiter___"] { display: none !important; }
    [class*="appHeaderWrapper___"] [class*="bottomSection___"]:empty { display: none !important; }
    [class*="appHeaderWrapper___"] [class*="topSection___"] { align-items: center; flex-wrap: wrap; gap: 4px; }`;
  function applyLook() {
    const want = (settings.fast ? FAST_CSS : '') + (settings.compact ? COMPACT_CSS : '');
    let el = document.getElementById('trrm-look');
    if (!want) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('style'); el.id = 'trrm-look'; document.head.appendChild(el); }
    if (el.textContent !== want) el.textContent = want;
  }

  // Under finger: after the user taps Start (or a Join button), Torn opens a confirm
  // step. Move that confirm button to where the finger already is, so the second tap
  // lands on it. The user still makes both taps; nothing is clicked for them.
  let fingerAt = null; // { x, y, until }
  let movedAt = 0;
  const MOVED_STYLE = ['position', 'zIndex', 'left', 'top', 'transform', 'transformOrigin'];
  // React doesn't reset inline styles it didn't set, so a moved button would stay
  // floating if Torn reuses it for another confirm. Put it back once it's tapped,
  // the game starts, or the tap window is over.
  function restoreMoved() {
    $$('button[data-trrm-moved]').forEach(m => {
      delete m.dataset.trrmMoved;
      MOVED_STYLE.forEach(k => { m.style[k] = ''; });
    });
  }
  function moveConfirmUnderFinger() {
    if (movedAt && (Date.now() - movedAt > 4000 || $(SEL.barrel))) {
      movedAt = 0;
      restoreMoved();
    }
    if (!settings.underFinger || !fingerAt) return;
    if (Date.now() > fingerAt.until) { fingerAt = null; return; }
    const buttons = [...$$('button[data-type="confirm"]')]
      .filter(b => b.offsetParent !== null || b.getClientRects().length);
    const btn = buttons.find(b => /^(yes|join|start|confirm)$/i.test((b.textContent || '').trim())) || buttons[0];
    if (!btn || btn.dataset.trrmMoved) return;
    const r = btn.getBoundingClientRect();
    btn.dataset.trrmMoved = '1';
    Object.assign(btn.style, {
      position: 'fixed', zIndex: '999999',
      left: `${Math.round(fingerAt.x - (r.width || 60) / 2)}px`,
      top: `${Math.round(fingerAt.y - (r.height || 30) / 2)}px`,
      transform: 'scale(1.4)', transformOrigin: 'center center'
    });
    fingerAt = null;
    movedAt = Date.now();
    setTimeout(schedule, 4100);
  }

  // ---------- shot odds and join list (display only) ----------
  // One bullet, 6 chambers, no re-spin. Chance for the player to move to win the game,
  // both playing their best afterwards, for shoot / x2 / x3 by chambers left.
  const SHOT_ODDS = { 6: [1 / 2, 1 / 3, 1 / 3], 5: [2 / 5, 2 / 5, 1 / 5], 4: [1 / 2, 1 / 4, 1 / 4], 3: [1 / 3, 1 / 3, 0], 2: [1 / 2, 0], 1: [0] };
  function chambersLeft() {
    for (const m of $$(SEL.message)) {
      const r = (m.textContent || '').match(/1 in (\d)/);
      if (r) return +r[1];
    }
    const barrel = $(SEL.barrel);
    return barrel ? 6 - barrel.querySelectorAll('[class*="miss___"]').length : 0;
  }
  function markShotOdds() {
    const btns = $$(SEL.shotBtn);
    if (!btns.length) return;
    const odds = SHOT_ODDS[chambersLeft()];
    const best = odds ? Math.max(...odds) : 0;
    btns.forEach(b => {
      const p = odds ? odds[(+b.dataset.id || 1) - 1] : undefined;
      const text = p == null ? null : Math.round(p * 100) + '%';
      const q = p == null ? null : p === 0 ? 'zero' : p === best ? 'best' : '';
      if (text == null) { delete b.dataset.trrmP; delete b.dataset.trrmQ; return; }
      if (b.dataset.trrmP !== text) b.dataset.trrmP = text;
      if (b.dataset.trrmQ !== q) b.dataset.trrmQ = q;
    });
  }
  // Mark open games whose bet is exactly your next Martingale bet.
  function markJoinRows(nb) {
    const rows = $$(SEL.joinRow);
    if (!rows.length) return;
    rows.forEach(r => {
      const label = r.querySelector(SEL.joinBet)?.getAttribute('aria-label') || '';
      const amount = parseInt(label.replace(/[^\d]/g, ''), 10);
      const match = !nb.block && amount === nb.amount;
      if (match && !r.dataset.trrmMatch) r.dataset.trrmMatch = '1';
      if (!match && r.dataset.trrmMatch) delete r.dataset.trrmMatch;
    });
  }

  // ---------- main loop ----------
  function tick() {
    if (document.hidden) return;
    try {
      injectStyles();
      applyLook();
      moveConfirmUnderFinger();
      checkGame();
      const nb = nextBet(); // once per tick: it scans today's games
      autofill(nb);
      renderBar(nb);
      renderLine();
      markShotOdds();
      markJoinRows(nb);
      retryOpen();
    } catch (e) {
      console.error('[TRRM]', e);
    }
  }

  let pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(() => { pending = null; tick(); }, 200);
  }

  function start() {
    if (!document.body) return setTimeout(start, 200);
    new MutationObserver(records => {
      if (document.hidden) return;
      // Ignore our own UI changes to avoid a refresh loop.
      const external = records.some(r => {
        const n = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        return !(n && n.closest && n.closest(SEL.ours));
      });
      if (external) schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (sawLive) hiddenSinceLive = true; return; }
      syncLog(false);
      schedule();
    });
    // The user's own typing (trusted events only; our fills are untrusted) or a tap on
    // Torn's $ (max) button marks the bet as chosen by the user.
    document.addEventListener('input', e => {
      if (e.target && e.target.matches && e.target.matches(SEL.moneyInput)) {
        if (e.isTrusted) userEdited = true;
        schedule();
      }
    }, true);
    // Torn focuses the bet box when the create panel renders, which opens the phone
    // keyboard over the table. Since the box is filled for you, drop focus unless the
    // user just tapped the bet area themselves.
    let lastBetTap = 0;
    document.addEventListener('pointerdown', e => {
      if (e.target && e.target.closest && e.target.closest(SEL.betArea)) lastBetTap = Date.now();
    }, true);
    document.addEventListener('focusin', e => {
      const t = e.target;
      if (t && t.matches && t.matches(SEL.moneyInput) && Date.now() - lastBetTap > 800) t.blur();
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
    // Another tab recorded a game or changed settings.
    window.addEventListener('storage', e => {
      if ([KEY.games, KEY.state, KEY.settings].includes(e.key)) { reloadStored(); schedule(); }
    });
    document.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      // Remember where the user tapped Start/Join; the confirm button gets moved there.
      const submit = t.closest('button[class*="submit___"]');
      if (submit && !submit.matches('[data-type="confirm"]') && e.clientX + e.clientY > 0) {
        // Torn may reuse the confirm button; put any earlier moved one back first.
        restoreMoved();
        fingerAt = { x: e.clientX, y: e.clientY, until: Date.now() + 4000 };
        setTimeout(schedule, 50);
      }
      // Let Torn handle the tap on a moved confirm first, then put the button back.
      if (t.closest('button[data-trrm-moved]')) setTimeout(() => { movedAt = 0; restoreMoved(); }, 0);
      // Torn's $ (max) button chooses the bet.
      if (t.closest('#moneyInput, .input-money-symbol')) {
        userEdited = true;
        setTimeout(schedule, 50);
      }
    }, true);
    syncLog(true); // first: it marks a sync as running, so tick() doesn't start a second one
    tick();
  }
  start();
})();
