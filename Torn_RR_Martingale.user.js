// ==UserScript==
// @name         Torn RR Martingale & Tracker
// @namespace    https://greasyfork.org/users/nebigoktug
// @version      1.3.0
// @description  Russian Roulette: fills the bet box with the next Martingale (or custom) bet, you still press Start. Shows win % on shoot/x2/x3, what the series risks and what your cash covers, marks open games matching your bet, tracks W/L and profit with a 30-day chart. Daily loss limit, profit target, no animations, compact layout, confirm under finger. Optional log-only API key catches games you left early. No clicks.
// @author       NebiGoktug
// @license      MIT
// @match        https://www.torn.com/page.php?sid=russianRoulette*
// @match        https://www.torn.com/loader.php?sid=russianRoulette*
// @run-at       document-idle
// @grant        none
// @connect      api.torn.com
// ==/UserScript==

(function () {
  'use strict';

  // PDA can re-inject on in-page navigation; run once per window.
  if (window.__trrmRunning) return;
  window.__trrmRunning = true;

  const VERSION = '1.3.0';
  const SETTINGS_KEY = 'trrm_settings';
  const GAMES_KEY = 'trrm_games';
  const STATE_KEY = 'trrm_state';
  const APIKEY_KEY = 'trrm_apikey';
  const GAMES_MAX = 5000;
  // list: custom bets per step (overrides base/mult/maxSteps when not empty)
  // target: daily profit target (display only) · flash: flash + vibrate on a result
  const DEFAULTS = { base: 0, mult: 2.1, maxSteps: 10, list: [], dailyLimit: 0, target: 0,
    fast: true, underFinger: true, compact: true, flash: false };
  const HOSPITAL_MIN = 20; // a lost game sends you to hospital for about this long

  // ---------- storage ----------
  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }
  let settings = Object.assign({}, DEFAULTS, load(SETTINGS_KEY, {}));
  // games: [{ t: ms, bet: $, win: bool, id?: Torn log id, live?: ms the game was first seen running,
  //          seen?: true once the page result and the log entry are linked }], oldest first
  let games = load(GAMES_KEY, []);
  // seriesFromT: games before this time (ms) belong to an earlier Martingale series (manual reset)
  // unlockDay: TCT day on which the daily loss limit was unlocked
  // open: { t, bet } for a game seen running whose result hasn't been seen yet
  // logCursor: timestamp (s) of the newest RR log entry imported; 0 = rebuild from the log
  // ignoredIds: log ids removed with "Undo last result", never imported again
  const STATE_DEFAULTS = { seriesFromT: 0, unlockDay: '', open: null, logCursor: 0, ignoredIds: [] };
  let state = Object.assign({}, STATE_DEFAULTS, load(STATE_KEY, {}));
  // Pre-release 1.2.0 read the activity log panel and could count games twice. Drop
  // those imports; with a key the log rebuild below puts the real games back.
  if ('logFromT' in state) {
    games = games.filter(g => !g.k);
    delete state.logFromT;
    save(GAMES_KEY, games);
    save(STATE_KEY, state);
  }
  // 1.1.x stored the series start as an index into games.
  if ('seriesFrom' in state) {
    const i = state.seriesFrom;
    state.seriesFromT = games[i] ? games[i].t : (i > 0 ? Date.now() : 0);
    delete state.seriesFrom;
    save(STATE_KEY, state);
  }

  // Other tabs on the RR page write the same storage; re-read before every change
  // so one tab never overwrites games another tab recorded.
  function reloadStored() {
    games = load(GAMES_KEY, []);
    state = Object.assign({}, STATE_DEFAULTS, load(STATE_KEY, {}));
    settings = Object.assign({}, DEFAULTS, load(SETTINGS_KEY, {}));
  }
  function saveGames() {
    // Never keep the same log entry twice, whatever path added it.
    const ids = new Set();
    games = games.filter(g => !g.id || (!ids.has(g.id) && ids.add(g.id)));
    games.sort((a, b) => a.t - b.t);
    if (games.length > GAMES_MAX) games = games.slice(games.length - GAMES_MAX);
    save(GAMES_KEY, games);
  }

  // ---------- helpers ----------
  function tctDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function today() { return tctDay(Date.now()); }
  function fmt(n) {
    const a = Math.abs(n);
    const s = a >= 1e9 ? (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'b'
      : a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'm'
      : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k'
      : String(Math.round(a));
    return (n < 0 ? '-$' : '$') + s.replace(/\.0+([kmb])$/, '$1').replace(/(\.\d*[1-9])0+([kmb])$/, '$1$2');
  }
  function signed(n) { return (n > 0 ? '+' : '') + fmt(n); }
  function parseMoney(text) {
    const m = String(text || '').trim().toLowerCase().replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([kmb]?)$/);
    if (!m) return NaN;
    const mul = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]];
    return Math.round(parseFloat(m[1]) * mul);
  }
  function profitOf(g) { return g.win ? g.bet : -g.bet; }

  function lossStreak() {
    let n = 0;
    for (let i = games.length - 1; i >= 0 && games[i].t >= state.seriesFromT; i--) {
      if (games[i].win) break;
      n++;
    }
    return n;
  }
  function useList() { return Array.isArray(settings.list) && settings.list.length > 0; }
  function maxSteps() { return useList() ? settings.list.length : settings.maxSteps; }
  function startBet() { return useList() ? settings.list[0] : settings.base; }
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
  function todayGames() {
    const d = today();
    return games.filter(g => tctDay(g.t) === d);
  }
  function netSince(ms) {
    return games.filter(g => g.t >= ms).reduce((s, g) => s + profitOf(g), 0);
  }
  function longestLossStreak() {
    let best = 0, cur = 0;
    for (const g of games) { cur = g.win ? 0 : cur + 1; best = Math.max(best, cur); }
    return best;
  }
  function cash() {
    const el = document.getElementById('user-money');
    const v = el ? parseInt(el.getAttribute('data-money'), 10) : NaN;
    return Number.isFinite(v) ? v : null;
  }

  // ---------- Martingale decision ----------
  // Returns { amount, block, note } where block is a reason not to fill.
  function nextBet() {
    if (!(startBet() > 0)) return { amount: 0, block: 'Set your start bet in ⚙ first.' };
    if (openGameUnseen()) return { amount: 0, block: 'open' };
    const streak = lossStreak();
    const tg = todayGames();
    const net = tg.reduce((s, g) => s + profitOf(g), 0);
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
    nativeSetter.call(inp, String(amount));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    lastAutoValue = amount;
  }

  // ---------- UI ----------
  function injectStyles() {
    if (document.getElementById('trrm-styles')) return;
    const s = document.createElement('style');
    s.id = 'trrm-styles';
    s.textContent = `
      #trrm-bar { margin: 6px 0; padding: 6px 8px; border-radius: 6px; font: 12px/1.4 Arial, sans-serif;
        background: #1f2a36 !important; color: #e6edf3 !important; border-left: 4px solid #4caf50; }
      #trrm-bar.warn { border-left-color: #e53935; }
      #trrm-bar.manual { border-left-color: #f9a825; }
      #trrm-bar b { color: #fff !important; }
      #trrm-bar .trrm-dim { color: #9fb0c0 !important; }
      #trrm-bar .trrm-gear, #trrm-line .trrm-gear { cursor: pointer; float: right; padding: 0 2px 0 8px; user-select: none; }
      #trrm-line { display: inline-block; margin: 2px 0 4px; padding: 2px 8px; border-radius: 10px; cursor: pointer;
        font: bold 12px/1.5 Arial, sans-serif; background: #263238 !important; color: #e6edf3 !important; }
      #trrm-line .pos { color: #66bb6a !important; } #trrm-line .neg { color: #ef5350 !important; }
      #trrm-pop { position: fixed; left: 8px; right: 8px; top: 70px; z-index: 99999; max-width: 420px; margin: 0 auto;
        padding: 10px 12px; border-radius: 8px; font: 12px/1.45 Arial, sans-serif; background: #1b2229 !important;
        color: #e6edf3 !important; box-shadow: 0 4px 16px rgba(0,0,0,.5); max-height: 75vh; overflow: auto; }
      #trrm-pop h4 { margin: 0 0 6px; font-size: 13px; color: #fff !important; }
      #trrm-pop .row { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
      #trrm-pop .pos { color: #66bb6a !important; } #trrm-pop .neg { color: #ef5350 !important; }
      #trrm-pop label { display: block; margin: 6px 0 2px; color: #9fb0c0 !important; }
      #trrm-pop input { width: 100%; box-sizing: border-box; padding: 5px 6px; border-radius: 4px; border: 1px solid #455a64;
        background: #0f1418 !important; color: #fff !important; font-size: 13px; }
      #trrm-pop .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      #trrm-pop button { padding: 5px 10px; border-radius: 4px; border: 0; cursor: pointer; font-size: 12px;
        background: #37474f !important; color: #fff !important; }
      #trrm-pop button.pri { background: #2e7d32 !important; } #trrm-pop button.danger { background: #b71c1c !important; }
      #trrm-pop .note { color: #9fb0c0 !important; font-size: 11px; margin-top: 6px; }
      #trrm-pop .x { float: right; cursor: pointer; font-size: 16px; line-height: 1; }
      #trrm-pop label.chk { display: flex; align-items: center; gap: 6px; color: #e6edf3 !important; }
      #trrm-pop label.chk input { width: auto; }
      #trrm-bar .trrm-big { font-size: 16px; font-weight: bold; color: #fff !important; }
      #trrm-bar .trrm-warnc { color: #ffb74d !important; }
      #trrm-bar .trrm-gear { font-size: 18px; padding: 8px 10px; margin: -8px -8px 0 0; line-height: 1; }
      .trrm-btn { display: inline-block; min-height: 34px; line-height: 34px; padding: 0 12px; margin: 6px 6px 0 0;
        border-radius: 5px; cursor: pointer; font-weight: bold; background: #37474f !important; color: #fff !important; }
      .trrm-btn.danger { background: #b71c1c !important; }
      #trrm-pop { max-height: 80vh; }
      #trrm-pop button { min-height: 40px; padding: 0 14px; font-size: 13px; }
      #trrm-pop .x { font-size: 24px; padding: 6px 10px; margin: -6px -8px 0 0; }
      #trrm-pop .btns { position: sticky; bottom: -10px; padding: 8px 0; background: #1b2229 !important; }
      #trrm-pop .prev { color: #81c784 !important; font-size: 11px; }
      #trrm-pop .err { color: #ef5350 !important; font-size: 12px; min-height: 14px; }
      #trrm-pop details { margin-top: 8px; } #trrm-pop summary { cursor: pointer; padding: 8px 0; color: #9fb0c0 !important; }
      #trrm-pop table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 4px; }
      #trrm-pop td, #trrm-pop th { padding: 1px 4px; text-align: right; } #trrm-pop th { color: #9fb0c0 !important; font-weight: normal; }
      #trrm-key { -webkit-text-security: disc; }
      #trrm-line.goal { background: #1b5e20 !important; }
      #trrm-line.flash-win { box-shadow: 0 0 0 3px #66bb6a; } #trrm-line.flash-loss { box-shadow: 0 0 0 3px #ef5350; }
      [class*="buttonsWrap___"] button[data-trrm-p]::after { content: attr(data-trrm-p); display: block; font-size: 10px; line-height: 1.1; }
      [class*="buttonsWrap___"] button[data-trrm-q="best"] { box-shadow: inset 0 -3px 0 #4caf50 !important; }
      [class*="buttonsWrap___"] button[data-trrm-q="zero"] { box-shadow: inset 0 -3px 0 #e53935 !important; }
      [class*="joinWrap___"] [class*="row___"][data-trrm-match] { box-shadow: inset 4px 0 0 #4caf50; background: rgba(76,175,80,.12) !important; }
    `;
    document.head.appendChild(s);
  }

  function ensureBar() {
    const wrap = document.querySelector('[class*="createWrap___"]');
    let bar = document.getElementById('trrm-bar');
    if (!wrap) { if (bar) bar.remove(); return null; }
    if (!bar || !bar.isConnected || bar.nextElementSibling !== wrap) {
      if (bar) bar.remove();
      bar = document.createElement('div');
      bar.id = 'trrm-bar';
      bar.addEventListener('click', e => {
        const act = e.target.closest('.trrm-gear') ? 'settings' : e.target.closest('[data-act]')?.dataset.act;
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

  function renderBar() {
    const bar = ensureBar();
    if (!bar) return;
    const nb = nextBet();
    const inp = betInput();
    let cls = '';
    let html;
    if (Date.now() < undoUntil) {
      html = `Series reset · next bet ${fmt(startBet())} <span class="trrm-btn" data-act="undo-reset">Undo</span>`;
    } else if (nb.block === 'open') {
      const o = state.open;
      cls = 'warn';
      html = `The ${fmt(o.bet)} game from ${new Date(o.t).toISOString().slice(11, 16)} TCT ended while you were away. `
        + (!apiKey() ? 'Add a log key in ⚙ to read its result.'
          : syncError ? `Couldn't read your log: ${syncError}.` : 'Reading the result from your log…')
        + ` <span class="trrm-btn" data-act="ignore">Ignore it</span>`;
    } else if (nb.block) {
      cls = 'warn';
      html = nb.block
        + (nb.reset ? ` <span class="trrm-btn" data-act="reset">Reset series</span>` : '')
        + (nb.unlock ? ` <span class="trrm-btn danger" data-act="unlock">${armed === 'unlock' ? 'Tap again to unlock' : 'Unlock today'}</span>` : '');
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
      html = `<span class="trrm-big">${fmt(bet)}</span> step ${s + 1}/${N}`
        + (manual ? ` · <span class="trrm-warnc">your bet (plan ${fmt(nb.amount)})</span>` : '')
        + `<br><span class="trrm-dim">win ${signed(bet - lostSoFar)} · lose ${fmt(-(lostSoFar + bet))}`
        + ` · all ${left} lost (${oneIn(left)}) ${fmt(-(lostSoFar + costFrom(s)))}</span>`
        + (covered == null ? '' : ` <span class="${covered < left ? 'trrm-warnc' : 'trrm-dim'}">· cash ${covered}/${left}</span>`);
    }
    html = `<span class="trrm-gear" title="Settings">⚙</span>` + html;
    if (bar.className !== cls) bar.className = cls;
    if (bar.innerHTML !== html) bar.innerHTML = html;
  }

  // Dangerous actions take two taps on the same button (no browser dialogs on PDA).
  let armed = '';
  let armTimer = null;
  function armOrRun(name, fn) {
    if (armed === name) { armed = ''; clearTimeout(armTimer); fn(); return; }
    armed = name;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { armed = ''; tick(); refreshPopButtons(); }, 3000);
    tick();
    refreshPopButtons();
  }

  // Reset with a 5 s undo instead of a confirmation.
  let undoUntil = 0;
  let undoSeriesFromT = 0;
  function resetSeries() {
    reloadStored();
    undoSeriesFromT = state.seriesFromT;
    state.seriesFromT = Date.now();
    save(STATE_KEY, state);
    undoUntil = Date.now() + 5000;
    setTimeout(schedule, 5100);
    closePop();
    tick();
  }
  function undoReset() {
    reloadStored();
    state.seriesFromT = undoSeriesFromT;
    save(STATE_KEY, state);
    undoUntil = 0;
    tick();
  }
  function unlockToday() {
    reloadStored();
    state.unlockDay = today();
    save(STATE_KEY, state);
    closePop();
    tick();
  }

  // Torn pre-fills the box (e.g. "10" or the last bet), so the value alone can't tell
  // whether the user chose it. userEdited is set only by the user's own typing or the
  // $ (max) button, and cleared when the box is re-rendered or a game is recorded.
  let userEdited = false;
  let lastInput = null;

  function autofill() {
    const inp = betInput();
    if (!inp) { lastAutoValue = null; lastInput = null; return; }
    if (inp !== lastInput) { lastInput = inp; userEdited = false; }
    const nb = nextBet();
    const cur = inputAmount(inp);
    if (userEdited && cur === 0) userEdited = false; // emptied box: back to the plan
    if (nb.block) {
      // Clear only what we wrote ourselves; never touch the user's own amount.
      if (!userEdited && lastAutoValue != null && cur === lastAutoValue) { fillBet(inp, ''); lastAutoValue = null; }
      return;
    }
    if (userEdited) return;
    if (cur === nb.amount) { lastAutoValue = nb.amount; return; }
    fillBet(inp, nb.amount);
  }

  function ensureLine() {
    const title = document.querySelector('h4[class*="title___"]');
    let line = document.getElementById('trrm-line');
    if (!title || !title.parentNode) return null;
    if (!line || !line.isConnected) {
      line = document.createElement('div');
      line.id = 'trrm-line';
      line.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openStats(); });
      title.parentNode.insertBefore(line, title.nextSibling);
    }
    return line;
  }

  function renderLine() {
    const line = ensureLine();
    if (!line) return;
    const tg = todayGames();
    const net = tg.reduce((s, g) => s + profitOf(g), 0);
    const w = tg.filter(g => g.win).length;
    const streak = lossStreak();
    const goal = settings.target > 0 && net >= settings.target;
    // During a game the bar is gone; this line is the only thing on screen.
    const inGame = state.open && document.querySelector('[class*="barrel___"]');
    const html = (goal ? '🎯 ' : '') + `Today <span class="${net >= 0 ? 'pos' : 'neg'}">${signed(net)}</span> · ${w}W-${tg.length - w}L`
      + (streak ? ` · <span class="neg">${streak}L streak</span>` : '')
      + (inGame ? ` · step ${streak + 1} · ${fmt(state.open.bet)} at stake` : '');
    if (line.innerHTML !== html) line.innerHTML = html;
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

  function closePop() { document.getElementById('trrm-pop')?.remove(); }
  function openPop(html) {
    closePop();
    const pop = document.createElement('div');
    pop.id = 'trrm-pop';
    pop.innerHTML = `<span class="x" title="Close">×</span>` + html;
    pop.querySelector('.x').addEventListener('click', closePop);
    document.body.appendChild(pop);
    return pop;
  }

  // Cumulative profit per TCT day over the last `days` days, as a small inline SVG.
  function sparkline(days) {
    const end = Date.parse(today());
    const pts = [];
    let sum = 0;
    for (let d = days - 1; d >= 0; d--) {
      const day = tctDay(end - d * 864e5);
      sum += games.filter(g => tctDay(g.t) === day).reduce((s, g) => s + profitOf(g), 0);
      pts.push(sum);
    }
    const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), span = hi - lo || 1;
    const W = 300, H = 46, x = i => (i / (pts.length - 1)) * W, y = v => H - 2 - ((v - lo) / span) * (H - 4);
    const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;margin:4px 0">`
      + `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#455a64" stroke-dasharray="3 3"/>`
      + `<path d="${path}" fill="none" stroke="${sum >= 0 ? '#66bb6a' : '#ef5350'}" stroke-width="2"/></svg>`;
  }

  function openStats() {
    const now = Date.now();
    const recent = games.slice(-20).reverse().map(g => {
      const d = new Date(g.t);
      const hm = d.toISOString().slice(11, 16);
      return `<div class="row"><span>${tctDay(g.t) === today() ? hm : tctDay(g.t).slice(5) + ' ' + hm} TCT</span>`
        + `<span>${g.win ? '✓ Win' : '✗ Loss'}</span><span class="${g.win ? 'pos' : 'neg'}">${signed(profitOf(g))}</span></div>`;
    }).join('') || '<div class="note">No games recorded yet.</div>';
    const n7 = netSince(now - 7 * 864e5), n30 = netSince(now - 30 * 864e5);
    const tg = todayGames();
    const tnet = tg.reduce((s, g) => s + profitOf(g), 0);
    const pop = openPop(`<h4>Russian Roulette</h4>
      <div class="row"><span>Today (TCT)</span><span class="${tnet >= 0 ? 'pos' : 'neg'}">${signed(tnet)} · ${tg.length} games</span></div>
      <div class="row"><span>Last 7 days</span><span class="${n7 >= 0 ? 'pos' : 'neg'}">${signed(n7)}</span></div>
      <div class="row"><span>Last 30 days</span><span class="${n30 >= 0 ? 'pos' : 'neg'}">${signed(n30)}</span></div>
      ${sparkline(30)}
      <div class="row"><span>Longest losing streak</span><span>${longestLossStreak()}</span></div>
      <h4 style="margin-top:10px">Last 20 games</h4>${recent}
      <div class="btns">${games.length ? `<button id="trrm-undo-last">${armed === 'undo-last' ? 'Tap again to remove it' : 'Undo last result'}</button>` : ''}</div>
      <div class="note">${apiKey() ? 'Synced with your RR log.' : 'Only games you watch to the end are counted; add a log key in ⚙ to catch the rest.'} Stored in this browser only.</div>`);
    pop.querySelector('#trrm-undo-last')?.addEventListener('click', () => armOrRun('undo-last', undoLast));
  }

  // Remove the newest recorded game (a miscount). A log entry removed this way is
  // remembered, so the next sync doesn't bring it back.
  function undoLast() {
    reloadStored();
    const g = games.pop();
    if (g && g.id) state.ignoredIds = state.ignoredIds.concat(g.id).slice(-100);
    save(GAMES_KEY, games);
    save(STATE_KEY, state);
    userEdited = false;
    tick();
    openStats();
  }

  // Re-label armed buttons inside an open popup.
  function refreshPopButtons() {
    const u = document.getElementById('trrm-undo-last');
    if (u) u.textContent = armed === 'undo-last' ? 'Tap again to remove it' : 'Undo last result';
    const c = document.getElementById('trrm-clear');
    if (c) c.textContent = armed === 'clear' ? 'Tap again to delete all' : 'Clear history';
    const l = document.getElementById('trrm-unlock');
    if (l) l.textContent = armed === 'unlock' ? 'Tap again to unlock' : 'Unlock today';
  }

  // Step-by-step plan: bet, total at risk up to that step, chance of getting there.
  function planTable() {
    const rows = [];
    let total = 0;
    for (let i = 0; i < maxSteps(); i++) {
      total += stepAmount(i);
      rows.push(`<tr><td>${i + 1}</td><td>${fmt(stepAmount(i))}</td><td>${fmt(total)}</td><td>${oneIn(i)}</td></tr>`);
    }
    return `<table><tr><th>step</th><th>bet</th><th>total in</th><th>reached</th></tr>${rows.join('')}</table>`;
  }

  function openSettings() {
    const streak = lossStreak();
    const N = maxSteps();
    const locked = settings.dailyLimit > 0 && todayGames().reduce((s, g) => s + profitOf(g), 0) <= -settings.dailyLimit
      && state.unlockDay !== today();
    const money = (id, label, v) => `<label>${label}</label><input id="${id}" value="${v > 0 ? v : ''}"
        inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-lpignore="true"><div class="prev" data-for="${id}"></div>`;
    const full = costFrom(0);
    const p50 = (1 - Math.pow(1 - Math.pow(0.5, N), 50)) * 100;
    const pop = openPop(`<h4>Martingale settings</h4>
      ${money('trrm-base', 'Start bet (e.g. 100k, 1.5m)', settings.base)}
      <label>Multiplier after a loss</label><input id="trrm-mult" value="${settings.mult}" inputmode="decimal" autocomplete="off">
      <label>Max steps in a series</label><input id="trrm-steps" value="${settings.maxSteps}" inputmode="numeric" autocomplete="off">
      <label>Custom bets per step (optional, replaces the three above)</label><input id="trrm-list"
        value="${useList() ? settings.list.map(v => fmt(v).replace('$', '')).join(', ') : ''}" placeholder="100k, 210k, 450k, 1m"
        inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-lpignore="true"><div class="prev" data-for="trrm-list"></div>
      ${money('trrm-limit', 'Daily loss limit (empty = off)', settings.dailyLimit)}
      ${money('trrm-target', 'Daily profit target (empty = off, the top line turns green)', settings.target)}
      <label class="chk"><input type="checkbox" id="trrm-fast" ${settings.fast ? 'checked' : ''}> No animations (barrel, skull, fades)</label>
      <label class="chk"><input type="checkbox" id="trrm-finger" ${settings.underFinger ? 'checked' : ''}> Confirm button under your finger after Start/Join</label>
      <label class="chk"><input type="checkbox" id="trrm-compact" ${settings.compact ? 'checked' : ''}> Compact layout (hide the big title)</label>
      <label class="chk"><input type="checkbox" id="trrm-flash" ${settings.flash ? 'checked' : ''}> Flash and vibrate on a result</label>
      <div class="err" id="trrm-err"></div>
      <div class="btns">
        <button class="pri" id="trrm-save">Save</button>
        <button id="trrm-reset">Reset series</button>
        ${locked ? `<button class="danger" id="trrm-unlock">${armed === 'unlock' ? 'Tap again to unlock' : 'Unlock today'}</button>` : ''}
      </div>
      <div class="note">Current series: ${streak} loss${streak === 1 ? '' : 'es'} in a row.</div>
      ${startBet() > 0 ? planTable() : ''}
      ${startBet() > 0 ? `<div class="note">Losing all ${N} steps: ${fmt(-full)}, ${oneIn(N)} per series, ${p50.toFixed(1)}% chance in 50 series.
        Each game is a fair 50/50 with no house cut, so on average Martingale wins nothing: many small wins, now and then one big loss.
        A series costs about one ${HOSPITAL_MIN} min hospital stay on average; losing all steps is ${N * HOSPITAL_MIN} min.</div>` : ''}
      <details><summary>Advanced: API key, clear history</summary>
        <label>API key with log access (optional)</label><input id="trrm-key" value="${apiKey()}" autocomplete="off"
          autocapitalize="off" spellcheck="false" data-lpignore="true" inputmode="text">
        <div class="note">Reads only your Russian Roulette win/loss log, so games you left before the end still count.
          <a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=RR%20Martingale&user=log" target="_blank" rel="noopener" style="color:#4aa3ff">Create a log-only key</a>.
          Stored in this browser only, sent only to api.torn.com, nothing is shared.${syncError ? ` <b>${syncError}</b>` : ''}</div>
        <div class="btns"><button class="danger" id="trrm-clear">${armed === 'clear' ? 'Tap again to delete all' : 'Clear history'}</button></div>
      </details>
      <div class="note">v${VERSION} · fills the bet box only; you press Start/Join yourself.</div>`);
    const val = id => pop.querySelector(id).value;
    const err = msg => { pop.querySelector('#trrm-err').textContent = msg; };
    const parseList = text => String(text).split(/[,;\s]+/).filter(Boolean).map(parseMoney);
    // Live preview of what an amount field will be read as.
    const preview = () => pop.querySelectorAll('.prev').forEach(el => {
      const text = String(val('#' + el.dataset.for)).trim();
      if (!text) { el.textContent = ''; return; }
      if (el.dataset.for === 'trrm-list') {
        const l = parseList(text);
        el.textContent = l.some(v => !(v > 0)) ? '?' : `= ${l.length} steps, ${fmt(l.reduce((a, b) => a + b, 0))} in total`;
      } else {
        const v = parseMoney(text);
        el.textContent = v > 0 ? `= $${v.toLocaleString('en-US')}` : '?';
      }
    });
    pop.addEventListener('input', preview);
    preview();
    pop.querySelector('#trrm-save').addEventListener('click', () => {
      const listText = String(val('#trrm-list')).trim();
      const list = listText ? parseList(listText) : [];
      const base = parseMoney(val('#trrm-base'));
      const mult = parseFloat(String(val('#trrm-mult')).replace(',', '.'));
      const steps = parseInt(val('#trrm-steps'), 10);
      const opt = id => { const t = String(val(id)).trim(); return t ? parseMoney(t) : 0; };
      const limit = opt('#trrm-limit'), target = opt('#trrm-target');
      if (list.some(v => !(v > 0)) || list.length > 30) return err('Custom bets: up to 30 amounts like 100k, 210k, 450k.');
      if (!list.length && !(base > 0)) return err('Start bet must be an amount like 100k or 1.5m.');
      if (!list.length && !(mult >= 1 && mult <= 10)) return err('Multiplier must be between 1 and 10.');
      if (!list.length && !(steps >= 1 && steps <= 30)) return err('Max steps must be between 1 and 30.');
      if (!(limit >= 0)) return err('Daily loss limit must be an amount like 5m, or empty.');
      if (!(target >= 0)) return err('Profit target must be an amount like 5m, or empty.');
      const key = String(val('#trrm-key')).trim();
      if (key !== apiKey()) {
        try { key ? localStorage.setItem(APIKEY_KEY, key) : localStorage.removeItem(APIKEY_KEY); } catch (_) {}
        syncError = '';
        reloadStored();
        state.logCursor = 0; // new key: rebuild from its log
        save(STATE_KEY, state);
        syncLog(true);
      }
      settings = { base: base > 0 ? base : settings.base, mult: mult >= 1 ? mult : settings.mult,
        maxSteps: steps >= 1 ? steps : settings.maxSteps, list, dailyLimit: limit, target,
        fast: pop.querySelector('#trrm-fast').checked,
        underFinger: pop.querySelector('#trrm-finger').checked,
        compact: pop.querySelector('#trrm-compact').checked,
        flash: pop.querySelector('#trrm-flash').checked };
      save(SETTINGS_KEY, settings);
      closePop();
      tick();
    });
    pop.querySelector('#trrm-reset').addEventListener('click', resetSeries);
    pop.querySelector('#trrm-unlock')?.addEventListener('click', () => armOrRun('unlock', unlockToday));
    pop.querySelector('#trrm-clear').addEventListener('click', () => armOrRun('clear', () => {
      reloadStored();
      games = [];
      state.seriesFromT = 0;
      state.open = null;
      state.logCursor = Math.floor(Date.now() / 1000); // don't import the cleared games again
      save(GAMES_KEY, games);
      save(STATE_KEY, state);
      closePop();
      tick();
    }));
  }

  // ---------- game result detection ----------
  // A result is only counted after we have seen that game live on this page,
  // so reloading a finished game never counts it twice.
  let sawLive = false;
  let recorded = false;
  let liveT = 0; // when this game was first seen running (shared with other tabs via state.open)
  let justFinished = false; // scroll the bar into place when the create box comes back

  // Only the RR message area: other Torn parts (chat button) also use message___ classes,
  // and class*="red___" alone would match colored___ / centered___ too.
  function resultMessage() {
    for (const m of document.querySelectorAll('[class*="messageWrap___"] [class*="message___"]')) {
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
    const potEl = document.querySelector('span[class*="count___"]');
    const pot = potEl ? parseInt(String(potEl.textContent).replace(/[^\d]/g, ''), 10) : NaN;
    return pot > 0 ? pot : 0;
  }

  // A game seen running is stored as open until its result is seen. If you leave
  // before the end, no bet is filled until the result is read from the log
  // (a missed loss would otherwise restart the series at step 1).
  function openGameUnseen() {
    return !!(state.open && !document.querySelector('[class*="barrel___"]') && !resultMessage());
  }

  // A page result and a log entry are the same game when outcome and bet match and the
  // log time falls between the moment the game was first seen running and the moment
  // its result was seen (a game can run many minutes: each turn has a 3 min timer).
  // SKEW allows for the phone clock being off from Torn's.
  const SKEW_MS = 60000;
  function sameGame(page, log) {
    if (page.win !== log.win || page.bet !== log.bet) return false;
    const from = (page.live || page.t) - SKEW_MS;
    return log.t >= from && log.t <= page.t + SKEW_MS;
  }

  function record(win, bet, live) {
    reloadStored();
    // Another tab on the RR page already recorded this game.
    if (games.some(o => o.live === live)) { state.open = null; save(STATE_KEY, state); return; }
    const g = { t: Date.now(), bet, win, live };
    // Already imported from the log (synced while the result was on screen).
    const fromLog = games.filter(o => o.id && !o.seen && sameGame(g, o)).sort((a, b) => a.t - b.t)[0];
    if (fromLog) { fromLog.seen = true; fromLog.live = live; } else games.push(g);
    state.open = null;
    saveGames();
    save(STATE_KEY, state);
    // New game: whatever is in the box now gets replaced with the next step.
    userEdited = false;
    justFinished = true;
    flashResult(win);
  }

  function forgetOpen() {
    reloadStored();
    state.open = null;
    save(STATE_KEY, state);
    tick();
  }

  // ---------- RR log via the API (optional key) ----------
  // Only with a key the user gave. Calls: one when the page opens and one when it comes
  // back into view, at most one per 15 s; nothing per game. The log ids make every game
  // unique, so nothing is ever counted twice.
  const LOG_WIN = 8395, LOG_LOSS = 8396;
  const SYNC_MIN_MS = 15000;
  const REBUILD_DAYS = 30;
  let syncing = false;
  let syncAgain = false; // a forced sync (e.g. a new key) arrived while one was running
  let lastSync = 0;
  let syncError = '';

  function apiKey() {
    try { return (localStorage.getItem(APIKEY_KEY) || '').trim(); } catch (_) { return ''; }
  }

  // One page of RR win/loss entries (the API returns at most 100, newest first).
  async function fetchLog(key, from, to) {
    const res = await fetch(`https://api.torn.com/user/?selections=log&log=${LOG_WIN},${LOG_LOSS}`
      + `&from=${from}${to ? `&to=${to}` : ''}&key=${encodeURIComponent(key)}&comment=RRMartingale`);
    const data = await res.json();
    if (data.error) {
      const e = new Error(data.error.code === 16 ? 'key has no log access' : data.error.error);
      e.api = data.error.code;
      throw e;
    }
    return Object.entries(data.log || {})
      .map(([id, l]) => ({ id, log: l.log, ts: l.timestamp, pot: l.data && l.data.pot }))
      .filter(l => (l.log === LOG_WIN || l.log === LOG_LOSS) && l.pot > 0);
  }
  const toGame = l => ({ id: l.id, t: l.ts * 1000, bet: Math.round(l.pot / 2), win: l.log === LOG_WIN });

  async function syncLog(force) {
    const key = apiKey();
    if (!key) return;
    if (syncing) { if (force) syncAgain = true; return; }
    if (!force && Date.now() - lastSync < SYNC_MIN_MS) return;
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
      for (let page = 0; page < 20; page++) {
        const batch = await fetchLog(key, since, to);
        logs.push(...batch);
        if (batch.length < 100) { complete = true; break; }
        to = Math.min(...batch.map(l => l.ts)) - 1;
      }
      reloadStored();
      const ignored = new Set(state.ignoredIds);
      const found = logs.map(toGame).filter(g => !ignored.has(g.id)).sort((a, b) => a.t - b.t);
      const known = new Set(games.filter(g => g.id).map(g => g.id));
      const fresh = found.filter(g => !known.has(g.id));
      if (rebuild) {
        // The log is the truth for the window it covered: replace whatever was recorded
        // there, keeping only page results newer than the log (game just ended). If the
        // window was too big to fetch, only the part that was fetched is replaced.
        const fromMs = complete || !found.length ? since * 1000 : found[0].t;
        const newest = found.length ? found[found.length - 1].t : 0;
        games = games.filter(g => g.t < fromMs)
          .concat(found, games.filter(g => !g.id && g.t >= fromMs && g.t > newest + SKEW_MS));
      } else {
        for (const g of fresh) {
          // Same game already recorded on the page: give it the log id and server time.
          const page = games.filter(o => !o.id && sameGame(o, g)).sort((a, b) => a.t - b.t)[0];
          if (page) { page.id = g.id; page.t = g.t; page.seen = true; } else games.push(g);
        }
      }
      for (const g of found) state.logCursor = Math.max(state.logCursor, g.t / 1000);
      // Only a new entry for this game's bet, from after it started, resolves the open game
      // (the previous game's entry comes back too: `from` is inclusive).
      if (state.open && fresh.some(g => g.bet === state.open.bet && g.t >= state.open.t - SKEW_MS)) state.open = null;
      if (!state.logCursor) state.logCursor = since;
      syncError = '';
      saveGames();
      save(STATE_KEY, state);
    } catch (e) {
      syncError = e.api ? e.message : 'Torn API unreachable';
      // A key Torn rejects is removed, so it isn't retried on every visit.
      if (e.api === 2) { try { localStorage.removeItem(APIKEY_KEY); } catch (_) {} }
    } finally {
      syncing = false;
      schedule();
      if (syncAgain) { syncAgain = false; syncLog(true); }
    }
  }

  function checkGame() {
    const barrel = document.querySelector('[class*="barrel___"]');
    const finished = !!document.querySelector('[class*="barrel___"][class*="finished___"]');
    const result = resultMessage();
    if (!barrel && !result) { sawLive = false; recorded = false; return; }
    const pot = potAmount();
    if (barrel && !finished && !result) {
      if (!sawLive) liveT = Date.now();
      sawLive = true; recorded = false;
      const bet = Math.round(pot / 2);
      if (bet && state.open && state.open.bet === bet) {
        // Same game seen before a reload, or by another tab: keep its start time.
        liveT = Math.min(liveT, state.open.t);
      } else if (bet) {
        reloadStored();
        state.open = { t: liveT, bet };
        save(STATE_KEY, state);
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
    document.querySelectorAll('button[data-trrm-moved]').forEach(m => {
      delete m.dataset.trrmMoved;
      MOVED_STYLE.forEach(k => { m.style[k] = ''; });
    });
  }
  function moveConfirmUnderFinger() {
    if (movedAt && (Date.now() - movedAt > 4000 || document.querySelector('[class*="barrel___"]'))) {
      movedAt = 0;
      restoreMoved();
    }
    if (!settings.underFinger || !fingerAt) return;
    if (Date.now() > fingerAt.until) { fingerAt = null; return; }
    const buttons = [...document.querySelectorAll('button[data-type="confirm"]')]
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
    for (const m of document.querySelectorAll('[class*="messageWrap___"] [class*="message___"]')) {
      const r = (m.textContent || '').match(/1 in (\d)/);
      if (r) return +r[1];
    }
    const barrel = document.querySelector('[class*="barrel___"]');
    return barrel ? 6 - barrel.querySelectorAll('[class*="miss___"]').length : 0;
  }
  function markShotOdds() {
    const btns = document.querySelectorAll('[class*="buttonsWrap___"] button[class*="commitButton___"]');
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
  function markJoinRows() {
    const rows = document.querySelectorAll('[class*="joinWrap___"] [class*="row___"]');
    if (!rows.length) return;
    const nb = nextBet();
    rows.forEach(r => {
      const label = r.querySelector('[class*="betBlock___"][aria-label^="Bet amount:"]')?.getAttribute('aria-label') || '';
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
      autofill();
      renderBar();
      renderLine();
      markShotOdds();
      markJoinRows();
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
        return !(n && n.closest && n.closest('#trrm-bar, #trrm-line, #trrm-pop'));
      });
      if (external) schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncLog(false); schedule(); } });
    // The user's own typing (trusted events only; our fills are untrusted) or a tap on
    // Torn's $ (max) button marks the bet as chosen by the user.
    document.addEventListener('input', e => {
      if (e.target && e.target.matches && e.target.matches('input.input-money, input[aria-label="Money value"]')) {
        if (e.isTrusted) userEdited = true;
        schedule();
      }
    }, true);
    // Torn focuses the bet box when the create panel renders, which opens the phone
    // keyboard over the table. Since the box is filled for you, drop focus unless the
    // user just tapped the bet area themselves.
    let lastBetTap = 0;
    document.addEventListener('pointerdown', e => {
      if (e.target && e.target.closest && e.target.closest('[class*="createWrap___"], [class*="betBlock___"]')) lastBetTap = Date.now();
    }, true);
    document.addEventListener('focusin', e => {
      const t = e.target;
      if (t && t.matches && t.matches('input.input-money, input[aria-label="Money value"]') && Date.now() - lastBetTap > 800) t.blur();
    }, true);
    // Another tab recorded a game or changed settings.
    window.addEventListener('storage', e => {
      if ([GAMES_KEY, STATE_KEY, SETTINGS_KEY].includes(e.key)) { reloadStored(); schedule(); }
    });
    // Remember where the user tapped Start/Join; the confirm button gets moved there.
    document.addEventListener('click', e => {
      const b = e.target && e.target.closest && e.target.closest('button[class*="submit___"]');
      if (b && !b.matches('[data-type="confirm"]') && e.clientX + e.clientY > 0) {
        // Torn may reuse the confirm button; put any earlier moved one back first.
        restoreMoved();
        fingerAt = { x: e.clientX, y: e.clientY, until: Date.now() + 4000 };
        setTimeout(schedule, 50);
      }
    }, true);
    document.addEventListener('click', e => {
      if (e.target && e.target.closest && e.target.closest('button[data-trrm-moved]')) {
        // Let Torn handle the tap first, then put the button back.
        setTimeout(() => { movedAt = 0; restoreMoved(); }, 0);
      }
    }, true);
    document.addEventListener('click', e => {
      if (e.target && e.target.closest && e.target.closest('#moneyInput, .input-money-symbol')) {
        userEdited = true;
        setTimeout(schedule, 50);
      }
    }, true);
    tick();
    syncLog(true);
  }
  start();
})();
