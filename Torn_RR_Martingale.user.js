// ==UserScript==
// @name         Torn RR Martingale & Tracker
// @namespace    https://greasyfork.org/users/nebigoktug
// @version      1.2.1
// @description  Russian Roulette: fills the bet box with the next Martingale amount (you still press Start), tracks today's W/L and profit, shows the loss streak and what the series risks. Optional daily loss limit, fast animations, compact layout, confirm button under your finger. Optional log-only API key: games you left early are read from your RR log, so the series stays right. No clicks.
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

  const VERSION = '1.2.1';
  const SETTINGS_KEY = 'trrm_settings';
  const GAMES_KEY = 'trrm_games';
  const STATE_KEY = 'trrm_state';
  const APIKEY_KEY = 'trrm_apikey';
  const GAMES_MAX = 1000;
  const DEFAULTS = { base: 0, mult: 2.1, maxSteps: 10, dailyLimit: 0, fast: true, underFinger: true, compact: true };

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
  // games: [{ t: ms, bet: $, win: bool, id?: Torn log id }], oldest first
  let games = load(GAMES_KEY, []);
  // seriesFromT: games before this time (ms) belong to an earlier Martingale series (manual reset)
  // unlockDay: TCT day on which the daily loss limit was unlocked
  // open: { t, bet } for a game seen running whose result hasn't been seen yet
  // logCursor: timestamp (s) of the newest RR log entry imported; 0 = rebuild from the log
  const STATE_DEFAULTS = { seriesFromT: 0, unlockDay: '', open: null, logCursor: 0 };
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
  function stepAmount(step) {
    return Math.round(settings.base * Math.pow(settings.mult, step));
  }
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
    if (!(settings.base > 0)) return { amount: 0, block: 'Set your start bet in ⚙ first.' };
    if (openGameUnseen()) return { amount: 0, block: 'open' };
    const streak = lossStreak();
    const tg = todayGames();
    const net = tg.reduce((s, g) => s + profitOf(g), 0);
    if (settings.dailyLimit > 0 && net <= -settings.dailyLimit && state.unlockDay !== today()) {
      return { amount: 0, streak, block: `Daily loss limit reached (${fmt(net)}). Unlock in ⚙ if you really want to keep going.` };
    }
    if (streak >= settings.maxSteps) {
      return { amount: 0, streak, block: `Series lost: ${streak} losses in a row, ${fmt(-seriesLost(streak))}. Tap Reset in ⚙ to start again from ${fmt(settings.base)}.` };
    }
    const amount = stepAmount(streak);
    const c = cash();
    if (c != null && amount > c) {
      return { amount, streak, block: `Not enough cash for step ${streak + 1} (${fmt(amount)}, you have ${fmt(c)}). Reset the series in ⚙ or add cash.` };
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
      #trrm-bar .trrm-ans { cursor: pointer; text-decoration: underline; color: #9fb0c0 !important; }
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
        if (e.target.closest('.trrm-gear')) { e.preventDefault(); e.stopPropagation(); openSettings(); }
        if (e.target.closest('.trrm-ans')) { e.preventDefault(); e.stopPropagation(); forgetOpen(); }
      });
      wrap.parentNode.insertBefore(bar, wrap);
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
    if (nb.block === 'open') {
      const o = state.open;
      cls = 'warn';
      html = `<b>Martingale</b> · The ${fmt(o.bet)} game from ${new Date(o.t).toISOString().slice(11, 16)} TCT ended while you were away. `
        + (!apiKey() ? 'Add a log key in ⚙ to read its result.'
          : syncError ? `Couldn't read your log: ${syncError}.` : 'Reading the result from your log…')
        + ` <span class="trrm-ans" title="Forget this game">ignore</span>`;
    } else if (nb.block) {
      cls = 'warn';
      html = `<b>Martingale</b> · ${nb.block}`;
    } else {
      const lostSoFar = seriesLost(nb.streak);
      const ifLost = lostSoFar + nb.amount;
      const typed = inp ? inputAmount(inp) : 0;
      const manual = inp && userEdited && typed > 0 && typed !== nb.amount;
      if (manual) cls = 'manual';
      html = `<b>Martingale</b> · step ${nb.streak + 1}/${settings.maxSteps} · `
        + (manual ? `your bet <b>${fmt(typed)}</b> (plan: ${fmt(nb.amount)})` : `<b>${fmt(nb.amount)}</b> filled`)
        + `<br><span class="trrm-dim">If this game is lost too, the series is down ${fmt(manual ? lostSoFar + typed : ifLost)}`
        + ` · a win now gives ${signed((manual ? typed : nb.amount) - lostSoFar)} for the series</span>`;
    }
    html = `<span class="trrm-gear" title="Settings">⚙</span>` + html;
    if (bar.className !== cls) bar.className = cls;
    if (bar.innerHTML !== html) bar.innerHTML = html;
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
    const html = `Today <span class="${net >= 0 ? 'pos' : 'neg'}">${signed(net)}</span> · ${w}W-${tg.length - w}L`
      + (streak ? ` · <span class="neg">${streak}L streak</span>` : '');
    if (line.innerHTML !== html) line.innerHTML = html;
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

  function openStats() {
    const now = Date.now();
    const recent = games.slice(-20).reverse().map(g => {
      const d = new Date(g.t);
      const hm = d.toISOString().slice(11, 16);
      return `<div class="row"><span>${tctDay(g.t) === today() ? hm : tctDay(g.t).slice(5) + ' ' + hm} TCT</span>`
        + `<span>${g.win ? '✓ Win' : '✗ Loss'}</span><span class="${g.win ? 'pos' : 'neg'}">${signed(profitOf(g))}</span></div>`;
    }).join('') || '<div class="note">No games recorded yet. Games are recorded when you watch them finish on this page.</div>';
    const n7 = netSince(now - 7 * 864e5), n30 = netSince(now - 30 * 864e5);
    const tg = todayGames();
    const tnet = tg.reduce((s, g) => s + profitOf(g), 0);
    openPop(`<h4>Russian Roulette</h4>
      <div class="row"><span>Today (TCT)</span><span class="${tnet >= 0 ? 'pos' : 'neg'}">${signed(tnet)} · ${tg.length} games</span></div>
      <div class="row"><span>Last 7 days</span><span class="${n7 >= 0 ? 'pos' : 'neg'}">${signed(n7)}</span></div>
      <div class="row"><span>Last 30 days</span><span class="${n30 >= 0 ? 'pos' : 'neg'}">${signed(n30)}</span></div>
      <div class="row"><span>Longest losing streak</span><span>${longestLossStreak()}</span></div>
      <h4 style="margin-top:10px">Last 20 games</h4>${recent}
      <div class="note">Only games you watch to the end on this page are counted. Stored in this browser only.</div>`);
  }

  function openSettings() {
    const streak = lossStreak();
    const plan = settings.base > 0
      ? Array.from({ length: Math.min(settings.maxSteps, 15) }, (_, i) => fmt(stepAmount(i))).join(' → ')
      : 'set a start bet';
    const locked = settings.dailyLimit > 0 && todayGames().reduce((s, g) => s + profitOf(g), 0) <= -settings.dailyLimit
      && state.unlockDay !== today();
    const pop = openPop(`<h4>Martingale settings</h4>
      <label>Start bet (e.g. 100k, 1.5m)</label><input id="trrm-base" value="${settings.base > 0 ? settings.base : ''}" inputmode="decimal">
      <label>Multiplier after a loss</label><input id="trrm-mult" value="${settings.mult}" inputmode="decimal">
      <label>Max steps in a series</label><input id="trrm-steps" value="${settings.maxSteps}" inputmode="numeric">
      <label>Daily loss limit (empty = off)</label><input id="trrm-limit" value="${settings.dailyLimit > 0 ? settings.dailyLimit : ''}" inputmode="decimal">
      <label>API key with log access (optional)</label><input id="trrm-key" type="password" value="${apiKey()}" autocomplete="off" spellcheck="false">
      <div class="note">Reads only your Russian Roulette win/loss log, so games you left before the end still count.
        <a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=RR%20Martingale&user=log" target="_blank" rel="noopener" style="color:#4aa3ff">Create a log-only key</a>.
        Stored in this browser only, sent only to api.torn.com, nothing is shared.${syncError ? ` <b>${syncError}</b>` : ''}</div>

      <label class="chk"><input type="checkbox" id="trrm-fast" ${settings.fast ? 'checked' : ''}> No animations (barrel, skull, fades)</label>
      <label class="chk"><input type="checkbox" id="trrm-finger" ${settings.underFinger ? 'checked' : ''}> Confirm button under your finger after Start/Join</label>
      <label class="chk"><input type="checkbox" id="trrm-compact" ${settings.compact ? 'checked' : ''}> Compact layout (hide the big title)</label>
      <div class="note">Plan: ${plan}</div>
      <div class="note">Current series: ${streak} loss${streak === 1 ? '' : 'es'} in a row.</div>
      <div class="btns">
        <button class="pri" id="trrm-save">Save</button>
        <button id="trrm-reset">Reset series</button>
        ${locked ? '<button class="danger" id="trrm-unlock">Unlock today</button>' : ''}
        <button class="danger" id="trrm-clear">Clear history</button>
      </div>
      <div class="note">Martingale does not change the odds: each game is still 50/50, and a long losing run can wipe out many small wins. The daily limit is there for that.</div>
      <div class="note">v${VERSION} · fills the bet box only; you press Start/Join yourself.</div>`);
    const val = id => pop.querySelector(id).value;
    pop.querySelector('#trrm-save').addEventListener('click', () => {
      const base = parseMoney(val('#trrm-base'));
      const mult = parseFloat(String(val('#trrm-mult')).replace(',', '.'));
      const steps = parseInt(val('#trrm-steps'), 10);
      const limitText = String(val('#trrm-limit')).trim();
      const limit = limitText ? parseMoney(limitText) : 0;
      if (!(base > 0)) return alert('Start bet must be an amount like 100k or 1.5m.');
      if (!(mult >= 1 && mult <= 10)) return alert('Multiplier must be between 1 and 10.');
      if (!(steps >= 1 && steps <= 30)) return alert('Max steps must be between 1 and 30.');
      if (!(limit >= 0)) return alert('Daily loss limit must be an amount like 5m, or empty.');
      const key = String(val('#trrm-key')).trim();
      if (key !== apiKey()) {
        try { key ? localStorage.setItem(APIKEY_KEY, key) : localStorage.removeItem(APIKEY_KEY); } catch (_) {}
        syncError = '';
        reloadStored();
        state.logCursor = 0; // new key: rebuild from its log
        save(STATE_KEY, state);
        syncLog(true);
      }
      settings = { base, mult, maxSteps: steps, dailyLimit: limit,
        fast: pop.querySelector('#trrm-fast').checked,
        underFinger: pop.querySelector('#trrm-finger').checked,
        compact: pop.querySelector('#trrm-compact').checked };
      save(SETTINGS_KEY, settings);
      closePop();
      tick();
    });
    pop.querySelector('#trrm-reset').addEventListener('click', () => {
      reloadStored();
      state.seriesFromT = Date.now();
      save(STATE_KEY, state);
      closePop();
      tick();
    });
    pop.querySelector('#trrm-unlock')?.addEventListener('click', () => {
      if (!confirm('You hit your daily loss limit. Unlock betting for the rest of today?')) return;
      reloadStored();
      state.unlockDay = today();
      save(STATE_KEY, state);
      closePop();
      tick();
    });
    pop.querySelector('#trrm-clear').addEventListener('click', () => {
      if (!confirm('Delete all recorded games? This cannot be undone.')) return;
      reloadStored();
      games = [];
      state.seriesFromT = 0;
      state.open = null;
      state.logCursor = Math.floor(Date.now() / 1000); // don't import the cleared games again
      save(GAMES_KEY, games);
      save(STATE_KEY, state);
      closePop();
      tick();
    });
  }

  // ---------- game result detection ----------
  // A result is only counted after we have seen that game live on this page,
  // so reloading a finished game never counts it twice.
  let sawLive = false;
  let recorded = false;

  function resultMessage() {
    const win = document.querySelector('[class*="message___"][class*="green___"]');
    const loss = document.querySelector('[class*="message___"][class*="red___"]');
    if (win) return { win: true };
    if (loss) return { win: false };
    for (const m of document.querySelectorAll('[class*="message___"]')) {
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

  const TWIN_MS = 120000;
  const twin = (a, b) => a.win === b.win && a.bet === b.bet && Math.abs(a.t - b.t) < TWIN_MS;

  function record(win, bet, t) {
    reloadStored();
    const g = { t, bet, win };
    // Already imported from the log (synced while the result was on screen).
    const fromLog = games.find(o => o.id && !o.seen && twin(o, g));
    if (fromLog) fromLog.seen = true;
    else games.push(g);
    state.open = null;
    saveGames();
    save(STATE_KEY, state);
    // New game: whatever is in the box now gets replaced with the next step.
    userEdited = false;
    // Give this game its log id, so the log never adds it a second time.
    setTimeout(() => syncLog(true), 4000);
  }

  function forgetOpen() {
    reloadStored();
    state.open = null;
    save(STATE_KEY, state);
    tick();
  }

  // ---------- RR log via the API (optional key) ----------
  // Only with a key the user gave. Calls: one when the page opens or comes back into
  // view, one a few seconds after each game, at most one per 15 s. The log ids make
  // every game unique, so nothing is ever counted twice.
  const LOG_WIN = 8395, LOG_LOSS = 8396;
  const SYNC_MIN_MS = 15000;
  const REBUILD_DAYS = 30;
  let syncing = false;
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
    if (!key || syncing) return;
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
      for (let page = 0; page < 20; page++) {
        const batch = await fetchLog(key, since, to);
        logs.push(...batch);
        if (batch.length < 100) break;
        to = Math.min(...batch.map(l => l.ts)) - 1;
      }
      reloadStored();
      const found = logs.map(toGame);
      if (rebuild) {
        // The log is the truth for the last 30 days: replace whatever was recorded
        // there, keeping only page results newer than the log (game just ended).
        const newest = found.reduce((m, g) => Math.max(m, g.t), 0);
        games = games.filter(g => g.t < since * 1000)
          .concat(found, games.filter(g => !g.id && g.t >= since * 1000 && g.t > newest + TWIN_MS));
      } else {
        for (const g of found) {
          if (games.some(o => o.id === g.id)) continue;
          // Same game already recorded on the page: give it the log id and server time.
          const pageTwin = games.find(o => !o.id && twin(o, g));
          if (pageTwin) { pageTwin.id = g.id; pageTwin.t = g.t; } else games.push(g);
        }
      }
      for (const g of found) {
        state.logCursor = Math.max(state.logCursor, g.t / 1000);
        if (state.open && g.t >= state.open.t - TWIN_MS) state.open = null;
      }
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
    }
  }

  function checkGame() {
    const barrel = document.querySelector('[class*="barrel___"]');
    const finished = !!document.querySelector('[class*="barrel___"][class*="finished___"]');
    const result = resultMessage();
    if (!barrel && !result) { sawLive = false; recorded = false; return; }
    const pot = potAmount();
    if (barrel && !finished && !result) {
      sawLive = true; recorded = false;
      if (pot && !(state.open && state.open.bet === Math.round(pot / 2))) {
        reloadStored();
        state.open = { t: Date.now(), bet: Math.round(pot / 2) };
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
    record(result.win, Math.round(pot / 2), Date.now());
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
