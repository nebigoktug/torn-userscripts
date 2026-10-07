// ==UserScript==
// @name         Torn RR Martingale & Tracker
// @namespace    https://greasyfork.org/users/nebigoktug
// @version      1.0.0
// @description  Russian Roulette: fills the bet box with the next Martingale amount (you still press Start), tracks today's W/L and profit, shows the loss streak and what the series risks. Optional daily loss limit. No requests, no clicks.
// @author       NebiGoktug
// @license      MIT
// @match        https://www.torn.com/page.php?sid=russianRoulette*
// @match        https://www.torn.com/loader.php?sid=russianRoulette*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // PDA can re-inject on in-page navigation; run once per window.
  if (window.__trrmRunning) return;
  window.__trrmRunning = true;

  const VERSION = '1.0.0';
  const SETTINGS_KEY = 'trrm_settings';
  const GAMES_KEY = 'trrm_games';
  const STATE_KEY = 'trrm_state';
  const GAMES_MAX = 1000;
  const DEFAULTS = { base: 0, mult: 2.1, maxSteps: 10, dailyLimit: 0 };

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
  // games: [{ t: ms, bet: $, win: bool }], oldest first
  let games = load(GAMES_KEY, []);
  // seriesFrom: index in games where the current Martingale series starts (after a manual reset)
  // unlockDay: TCT day on which the daily loss limit was unlocked
  let state = Object.assign({ seriesFrom: 0, unlockDay: '' }, load(STATE_KEY, {}));

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
    for (let i = games.length - 1; i >= state.seriesFrom && i >= 0; i--) {
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
    if (nb.block) {
      cls = 'warn';
      html = `<b>Martingale</b> · ${nb.block}`;
    } else {
      const lostSoFar = seriesLost(nb.streak);
      const ifLost = lostSoFar + nb.amount;
      const typed = inp ? inputAmount(inp) : 0;
      const manual = inp && typed > 0 && typed !== nb.amount;
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

  function autofill() {
    const inp = betInput();
    if (!inp) { lastAutoValue = null; return; }
    const nb = nextBet();
    const cur = inputAmount(inp);
    if (nb.block) {
      // Clear only what we wrote ourselves; never touch the user's own amount.
      if (lastAutoValue != null && cur === lastAutoValue) { fillBet(inp, ''); lastAutoValue = null; }
      return;
    }
    // Fill when the box is empty or still holds our previous amount (the user has not edited it).
    if (cur === nb.amount) { lastAutoValue = nb.amount; return; }
    if (cur === 0 || (lastAutoValue != null && cur === lastAutoValue)) fillBet(inp, nb.amount);
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
      <label>Start bet (e.g. 100k, 1.5m)</label><input id="trrm-base" value="${settings.base > 0 ? fmt(settings.base).replace('$', '') : ''}" inputmode="decimal">
      <label>Multiplier after a loss</label><input id="trrm-mult" value="${settings.mult}" inputmode="decimal">
      <label>Max steps in a series</label><input id="trrm-steps" value="${settings.maxSteps}" inputmode="numeric">
      <label>Daily loss limit (empty = off)</label><input id="trrm-limit" value="${settings.dailyLimit > 0 ? fmt(settings.dailyLimit).replace('$', '') : ''}" inputmode="decimal">
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
      settings = { base, mult, maxSteps: steps, dailyLimit: limit };
      save(SETTINGS_KEY, settings);
      closePop();
      tick();
    });
    pop.querySelector('#trrm-reset').addEventListener('click', () => {
      state.seriesFrom = games.length;
      save(STATE_KEY, state);
      closePop();
      tick();
    });
    pop.querySelector('#trrm-unlock')?.addEventListener('click', () => {
      if (!confirm('You hit your daily loss limit. Unlock betting for the rest of today?')) return;
      state.unlockDay = today();
      save(STATE_KEY, state);
      closePop();
      tick();
    });
    pop.querySelector('#trrm-clear').addEventListener('click', () => {
      if (!confirm('Delete all recorded games? This cannot be undone.')) return;
      games = [];
      state.seriesFrom = 0;
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

  function checkGame() {
    const barrel = document.querySelector('[class*="barrel___"]');
    const finished = !!document.querySelector('[class*="barrel___"][class*="finished___"]');
    const result = resultMessage();
    if (!barrel && !result) { sawLive = false; recorded = false; return; }
    if (barrel && !finished && !result) { sawLive = true; recorded = false; return; }
    if (!sawLive || recorded || !result) return;
    const potEl = document.querySelector('span[class*="count___"]');
    const pot = potEl ? parseInt(String(potEl.textContent).replace(/[^\d]/g, ''), 10) : NaN;
    if (!(pot > 0)) return; // wait for the pot to render
    recorded = true;
    games.push({ t: Date.now(), bet: Math.round(pot / 2), win: result.win });
    if (games.length > GAMES_MAX) {
      const drop = games.length - GAMES_MAX;
      games = games.slice(drop);
      state.seriesFrom = Math.max(0, state.seriesFrom - drop);
      save(STATE_KEY, state);
    }
    save(GAMES_KEY, games);
    // lastAutoValue stays: the box still holds our old amount, so autofill replaces it with the next step.
  }

  // ---------- main loop ----------
  function tick() {
    if (document.hidden) return;
    try {
      injectStyles();
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
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    // Keep the bet box in sync if the user types in it.
    document.addEventListener('input', e => {
      if (e.target && e.target.matches && e.target.matches('input.input-money, input[aria-label="Money value"]')) schedule();
    }, true);
    tick();
  }
  start();
})();
