// ==UserScript==
// @name         Torn Stock Dip Finder
// @namespace    https://github.com/nebigoktug
// @version      1.0.1
// @description  Swing-trading helper for Torn's stock market: shows which stock has dipped furthest below its recent average (a buy candidate), and for your open trades the target sell price and the "sell by" day. Rule backtested on ~5 years of daily prices. Display only: you buy and sell yourself.
// @author       Nebigoktug
// @license      MIT
// @supportURL   https://github.com/nebigoktug/torn-userscripts/issues
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      tornsy.com
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Stock_Dip_Finder.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Stock_Dip_Finder.user.js
// ==/UserScript==

/*
 * Torn Stock Dip Finder
 *
 * Torn's stock prices tend to drift back after a dip: a stock that fell over
 * the last week is slightly more likely to recover the next week. The rule:
 *
 *   Buy the stock furthest below its 7-day average (at least 1% below).
 *   Sell at +2%, or after 14 days, whichever comes first. One trade at a time.
 *
 * Backtested on Tornsy daily closes for all 35 stocks, 0.1% sell fee
 * included: +17% to +57% a year in each of the last four years, against
 * +3% to +6% (and one -12% year) for simply holding a stock. Every nearby
 * setting (5-10 day average, 0.5-1.5% dip, 1.5-3% target) was also positive
 * in every year. Past results are no guarantee.
 *
 * Data: Torn API (torn/stocks for live prices, user/stocks for your trades;
 * Limited key) and daily price history from tornsy.com (public, no key sent),
 * fetched once a day. It only reads and shows. It never buys or sells.
 */

(function () {
    'use strict';

    // Torn PDA may inject on any URL containing "torn"; only run on the game.
    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;
    // Torn PDA can inject the script again on in-page navigation; run once.
    if (window.__tsdRunning) return;
    window.__tsdRunning = true;

    const VERSION  = '1.0.1';
    const REPO_URL = 'https://github.com/nebigoktug/torn-userscripts';
    const LS_KEY   = 'tsd_api_key';
    const LS_PREFS = 'tsd_prefs';
    const LS_HIST  = 'tsd_history';
    const OTHER_KEYS = ['ffbs_api_key', 'tfs_api_key', 'tpc_api_key']; // offered on first setup
    const FEE = 0.001;                 // Torn takes 0.1% of every sale
    const DATA_TTL_MS   = 60 * 1000;   // reuse Torn API data for a minute
    const RATE_PAUSE_MS = 60 * 1000;
    const HIST_DAYS = 16;              // daily closes kept per stock
    const LONG_TERM_DAYS = 60;         // older purchases count as long-term holdings, not dip trades

    const DEFAULT_PREFS = { avgDays: 7, dipPct: 1, targetPct: 2, maxDays: 14, ignore: [] };

    // ------------------------------------------------------------ storage
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    const loadJson = (k, dflt) => { try { return JSON.parse(lsGet(k) || 'null') || dflt; } catch (e) { return dflt; } };
    let prefs = Object.assign({}, DEFAULT_PREFS, loadJson(LS_PREFS, {}));
    const savePrefs = () => lsSet(LS_PREFS, JSON.stringify(prefs));

    // ------------------------------------------------------------ helpers
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const money = (n) => {
        if (n == null || isNaN(n)) return '—';
        const a = Math.abs(n), s = n < 0 ? '-' : '';
        if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'b';
        if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'm';
        if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
        return s + '$' + Math.round(a);
    };
    const price = (n) => '$' + Number(n).toFixed(2);
    const pct = (x, digits = 1) => (x > 0 ? '+' : '') + (x * 100).toFixed(digits) + '%';
    const below = (dev) => (Math.abs(dev) * 100).toFixed(2) + '%';
    const DAY = 86400;
    const now = () => Math.floor(Date.now() / 1000);
    const utcDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
    const onStocksPage = () => /\/page\.php$/i.test(location.pathname) && /[?&]sid=stocks\b/i.test(location.search);

    // ------------------------------------------------------------ Torn API
    class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
    let pausedUntil = 0;
    async function api(path, key) {
        if (Date.now() < pausedUntil) throw new ApiError(5, 'Torn API limit reached, wait a minute.');
        const sep = path.includes('?') ? '&' : '?';
        let resp;
        try {
            resp = await fetch(`https://api.torn.com/v2/${path}${sep}key=${encodeURIComponent(key)}&comment=StockDipFinder`);
        } catch (e) { throw new ApiError(-1, 'Network error — check your connection and try again.'); }
        let data;
        try { data = await resp.json(); } catch (e) { throw new ApiError(-1, `Unexpected response (HTTP ${resp.status}).`); }
        if (data && data.error) {
            const c = data.error.code;
            if (c === 5) pausedUntil = Date.now() + RATE_PAUSE_MS;
            const msg = {
                2: 'Incorrect API key.',
                5: 'Too many requests — wait a minute and try again.',
                13: 'Key is disabled because the owner has been inactive.',
                16: 'Key access level is too low.',
                18: 'API key is paused.',
            }[c] || `Torn API error ${c}: ${data.error.error}`;
            throw new ApiError(c, msg);
        }
        return data;
    }

    // ------------------------------------------------------------ price history (tornsy.com)
    // Daily closes only change once a day, so they are fetched once per UTC
    // day and kept locally. Today's unfinished day is left out.
    // Torn's page only lets scripts fetch() a few sites, so tornsy.com goes
    // through Torn PDA's or the script manager's own request function.
    function httpGet(url) {
        return new Promise((resolve, reject) => {
            if (typeof PDA_httpGet === 'function') {
                try {
                    PDA_httpGet(url).then((r) => resolve(r.responseText != null ? r.responseText : (r.response || '')), reject);
                } catch (e) { reject(e); }
                return;
            }
            const gm = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
                : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest : null;
            if (gm) {
                gm({ method: 'GET', url, timeout: 20000,
                    onload: (r) => resolve(r.responseText), onerror: reject, ontimeout: () => reject(new Error('timeout')) });
                return;
            }
            fetch(url).then((r) => r.text()).then(resolve, reject);
        });
    }
    async function tornsyCloses(sym) {
        const d = JSON.parse(await httpGet(`https://tornsy.com/api/${encodeURIComponent(sym)}?interval=d1&limit=${HIST_DAYS + 1}`));
        if (!d || !Array.isArray(d.data)) throw new Error((d && d.error) || 'bad data');
        const today = Math.floor(now() / DAY) * DAY;
        return d.data.filter((row) => Number(row[0]) < today).map((row) => Number(row[4])).slice(-HIST_DAYS);
    }
    let histLoading = null;
    async function loadHistory(symbols) {
        const today = utcDay(now());
        const h = loadJson(LS_HIST, null);
        const missing = h && h.day === today ? symbols.filter((s) => !(h.closes[s] && h.closes[s].length)) : symbols;
        if (h && h.day === today && !missing.length) return h;
        if (histLoading) return histLoading;
        histLoading = (async () => {
            const out = { day: today, closes: h && h.day === today ? h.closes : {} };
            let failed = 0, lastErr = null;
            // A few at a time: 35 small requests, once a day.
            for (let i = 0; i < missing.length; i += 5) {
                await Promise.all(missing.slice(i, i + 5).map(async (s) => {
                    try { out.closes[s] = await tornsyCloses(s); } catch (e) { failed++; lastErr = e; }
                }));
            }
            if (failed === missing.length && missing.length) {
                if (h) return h; // keep yesterday's rather than nothing
                const why = lastErr && (lastErr.message || lastErr.error || String(lastErr));
                throw new Error('Could not load price history from tornsy.com' + (why ? ` (${why})` : '') + '.');
            }
            lsSet(LS_HIST, JSON.stringify(out));
            return out;
        })();
        try { return await histLoading; } finally { histLoading = null; }
    }

    // ------------------------------------------------------------ data
    let cache = null; // { ts, stocks, mine, mineErr, hist }
    async function loadData(key, force) {
        if (!force && cache && Date.now() - cache.ts < DATA_TTL_MS) return cache;
        const t = await api('torn/stocks', key);
        const stocks = (t.stocks || []).map((s) => ({
            id: s.id, sym: s.acronym, name: s.name, price: Number(s.market && s.market.price),
            bonus: s.bonus || {},
        })).filter((s) => s.sym && s.price > 0);
        let mine = null, mineErr = null;
        try {
            const u = await api('user/stocks', key);
            mine = u.stocks || [];
        } catch (e) {
            if (e.code === 2) throw e;
            mineErr = e.code === 16 ? 'Your trades need a key with Limited access (user → stocks).' : e.message;
        }
        const hist = await loadHistory(stocks.map((s) => s.sym));
        cache = { ts: Date.now(), stocks, mine, mineErr, hist };
        return cache;
    }

    // Candidates: every stock's price against its N-day average, lowest first.
    function candidates(data) {
        const n = Math.max(2, Math.round(prefs.avgDays));
        return data.stocks.map((s) => {
            const closes = (data.hist.closes[s.sym] || []).slice(-n);
            if (closes.length < n) return null;
            const avg = closes.reduce((a, b) => a + b, 0) / n;
            const dev = s.price / avg - 1;
            return { ...s, avg, dev, buy: dev <= -prefs.dipPct / 100 };
        }).filter(Boolean).sort((a, b) => a.dev - b.dev);
    }

    // Open dip trades: recent purchases (long-term holdings and ignored stocks left out).
    function trades(data) {
        if (!data.mine) return [];
        const bySym = new Map(data.stocks.map((s) => [s.id, s]));
        const out = [];
        data.mine.forEach((m) => {
            const s = bySym.get(m.id);
            if (!s || prefs.ignore.includes(s.sym)) return;
            (m.transactions || []).forEach((tx) => {
                const age = (now() - Number(tx.timestamp)) / DAY;
                if (age > LONG_TERM_DAYS) return;
                const bought = Number(tx.price), shares = Number(tx.shares);
                const target = bought * (1 + prefs.targetPct / 100);
                const sellBy = Number(tx.timestamp) + prefs.maxDays * DAY;
                const net = shares * s.price * (1 - FEE) - shares * bought;
                const hit = s.price >= target, late = now() >= sellBy;
                out.push({ s, bought, shares, target, sellBy, age, net, change: s.price / bought - 1, hit, late,
                    blocks: m.bonus && m.bonus.increment > 0 });
            });
        });
        return out.sort((a, b) => (b.hit || b.late) - (a.hit || a.late) || a.sellBy - b.sellBy);
    }
    const tradeVerdict = (t) => t.hit ? { cls: 'ok', icon: '🎯', text: 'Target reached — sell' }
        : t.late ? { cls: 'warn', icon: '⏰', text: `${prefs.maxDays} days are up — sell` }
            : { cls: 'info', icon: '⏳', text: `Hold: needs ${price(t.target)} (${pct(t.target / t.s.price - 1)}), sell by ${utcDay(t.sellBy)}` };

    // ------------------------------------------------------------ styles
    function injectStyles() {
        if (document.getElementById('tsd-styles')) return;
        const st = document.createElement('style');
        st.id = 'tsd-styles';
        st.textContent = `
        :root {
            --tsd-bg: #1f2227; --tsd-bg2: #15171b; --tsd-fg: #f1f3f5; --tsd-muted: #c3c8cf;
            --tsd-border: #3a3f47; --tsd-accent: #e08a1e; --tsd-accent-fg: #fff;
            --tsd-ok: #2ecc40; --tsd-warn: #ffb020; --tsd-bad: #ff6b61; --tsd-info: #8fa3b8;
            --tsd-link: #4aa3ff; --tsd-shadow: rgba(0,0,0,0.6);
        }
        body:not(.dark-mode) {
            --tsd-bg: #fff; --tsd-bg2: #f1f3f5; --tsd-fg: #15181b; --tsd-muted: #454c55;
            --tsd-border: #d0d5db; --tsd-accent: #b86a0c; --tsd-ok: #1f9a30; --tsd-warn: #b36b00;
            --tsd-bad: #d93025; --tsd-info: #5b6b7c; --tsd-link: #1a73e8; --tsd-shadow: rgba(0,0,0,0.25);
        }
        #tsd-banner {
            display: block; margin: 0 0 10px; padding: 8px 12px; border-radius: 10px; cursor: pointer;
            font: 13px/1.4 Arial, Helvetica, sans-serif; white-space: normal; overflow-wrap: anywhere;
            background: var(--tsd-bg); border: 2px solid var(--tsd-border);
        }
        #tsd-banner.float { position: fixed; left: 50%; top: 70px; transform: translateX(-50%); z-index: 2147483645;
            width: 420px; max-width: calc(100vw - 16px); box-sizing: border-box; box-shadow: 0 6px 20px var(--tsd-shadow); }
        #tsd-banner.ok { border-color: var(--tsd-ok); }
        #tsd-banner.warn { border-color: var(--tsd-warn); }
        /* Torn's dark-mode CSS greys spans; pin our colours. */
        #tsd-banner, #tsd-banner * { color: var(--tsd-fg) !important; }
        #tsd-banner .tsd-bfoot { margin-top: 3px; font-size: 11px; color: var(--tsd-muted) !important; }
        #tsd-overlay {
            position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.7);
            display: flex; align-items: center; justify-content: center; font-family: Arial, Helvetica, sans-serif;
        }
        #tsd-overlay .tsd-card {
            position: relative; width: 440px; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column;
            background: var(--tsd-bg); color: var(--tsd-fg); border: 1px solid var(--tsd-border);
            border-radius: 12px; box-shadow: 0 10px 34px var(--tsd-shadow); box-sizing: border-box;
            font-size: 14px; line-height: 1.35;
        }
        #tsd-overlay .tsd-card, #tsd-overlay .tsd-card label, #tsd-overlay .tsd-card p,
        #tsd-overlay .tsd-card b, #tsd-overlay .tsd-card td, #tsd-overlay .tsd-card th { color: var(--tsd-fg) !important; }
        #tsd-overlay .tsd-head { padding: 14px 44px 10px 16px; border-bottom: 1px solid var(--tsd-border); }
        #tsd-overlay h2 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
        #tsd-overlay .tsd-ver { font-size: 10px; font-weight: 700; color: var(--tsd-muted) !important;
            border: 1px solid var(--tsd-border); border-radius: 10px; padding: 2px 6px; }
        #tsd-overlay .tsd-close { position: absolute; top: 8px; right: 10px; width: 28px; height: 28px; padding: 0;
            border: 0; background: transparent; color: var(--tsd-muted); font-size: 20px; line-height: 28px; cursor: pointer; }
        #tsd-overlay .tsd-body { overflow-y: auto; padding: 12px 16px; }
        #tsd-overlay .tsd-foot { padding: 10px 16px 12px; border-top: 1px solid var(--tsd-border);
            display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
        #tsd-overlay a, #tsd-overlay .tsd-linkbtn { color: var(--tsd-link) !important; }
        #tsd-overlay .tsd-linkbtn { background: none; border: 0; padding: 0; cursor: pointer; font-size: 11px; text-decoration: underline; }
        #tsd-overlay input[type="text"], #tsd-overlay input[type="number"] {
            box-sizing: border-box; padding: 6px 7px; font-size: 13px; border-radius: 6px;
            background: var(--tsd-bg2); color: var(--tsd-fg); border: 1px solid var(--tsd-border);
        }
        #tsd-overlay .tsd-btn { padding: 7px 12px; font-size: 13px; font-weight: 700; cursor: pointer; border-radius: 7px;
            background: var(--tsd-accent); color: var(--tsd-accent-fg) !important; border: 0; }
        #tsd-overlay .tsd-btn:disabled { opacity: .6; }
        #tsd-overlay h3 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--tsd-muted) !important; }
        #tsd-overlay h3:first-child { margin-top: 0; }
        #tsd-overlay .tsd-pick { padding: 10px 12px; border-radius: 8px; background: var(--tsd-bg2); border: 2px solid var(--tsd-border); }
        #tsd-overlay .tsd-pick.ok { border-color: var(--tsd-ok); }
        #tsd-overlay .tsd-pick big { font-size: 16px; font-weight: 700; }
        #tsd-overlay .tsd-trade { padding: 8px 0; border-bottom: 1px solid var(--tsd-border); font-size: 13px; }
        #tsd-overlay .tsd-trade:last-child { border-bottom: 0; }
        #tsd-overlay .tsd-trade .v { font-weight: 700; margin-top: 2px; }
        #tsd-overlay .tsd-trade.ok .v { color: var(--tsd-ok) !important; }
        #tsd-overlay .tsd-trade.warn .v { color: var(--tsd-warn) !important; }
        #tsd-overlay .tsd-trade.info .v { color: var(--tsd-muted) !important; }
        #tsd-overlay .tsd-trade .tsd-ign { float: right; font-size: 11px; }
        #tsd-overlay table.tsd-list { width: 100%; border-collapse: collapse; font-size: 12px; }
        #tsd-overlay table.tsd-list th { text-align: left; font-size: 10px; text-transform: uppercase; color: var(--tsd-muted) !important; padding: 3px 4px; }
        #tsd-overlay table.tsd-list td { padding: 4px; border-top: 1px solid var(--tsd-border); }
        #tsd-overlay table.tsd-list td.n { text-align: right; white-space: nowrap; }
        #tsd-overlay table.tsd-list tr.buy td { background: rgba(46,204,64,.12); }
        #tsd-overlay .neg { color: var(--tsd-bad) !important; }
        #tsd-overlay .pos { color: var(--tsd-ok) !important; }
        #tsd-overlay .tsd-set { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
        #tsd-overlay .tsd-set label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; font-weight: 700;
            color: var(--tsd-muted) !important; text-transform: uppercase; letter-spacing: .3px; }
        #tsd-overlay .tsd-set input { width: 100%; }
        #tsd-overlay details { margin-top: 12px; }
        #tsd-overlay summary { cursor: pointer; font-size: 12px; color: var(--tsd-muted); }
        #tsd-overlay .tsd-msg { padding: 10px; border-radius: 8px; background: var(--tsd-bg2); color: var(--tsd-muted) !important; text-align: center; }
        #tsd-overlay .tsd-msg.err { color: var(--tsd-bad) !important; }
        #tsd-overlay .tsd-note { font-size: 11px; color: var(--tsd-muted) !important; margin-top: 10px; line-height: 1.5; }
        #tsd-overlay .tsd-tos table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 12px; }
        #tsd-overlay .tsd-tos th, #tsd-overlay .tsd-tos td { text-align: left; vertical-align: top; padding: 4px; border-bottom: 1px solid var(--tsd-border); }
        #tsd-overlay .tsd-tos th { width: 34%; }
        #tsd-overlay .tsd-tos td { color: var(--tsd-muted) !important; }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    // ------------------------------------------------------------ panel
    const TOS_ROWS = [
        ['Data storage', 'Only locally: your key, settings and a small price history stay in this browser.'],
        ['Data sharing', 'Nobody. Your key goes only to api.torn.com. Price history comes from tornsy.com (public, no key or player data sent).'],
        ['Purpose of use', 'Personal gain: stock-trading suggestions.'],
        ['Key storage & sharing', 'Stored locally on this device. Not shared.'],
        ['Key access level', 'Limited (user → stocks, for your open trades). Prices alone work with a Public key.'],
    ];

    let overlay = null;
    const body = () => overlay && overlay.querySelector('.tsd-body');
    function closePanel() { if (overlay) { overlay.remove(); overlay = null; } }
    function openPanel() {
        if (overlay) return;
        injectStyles();
        overlay = document.createElement('div');
        overlay.id = 'tsd-overlay';
        overlay.innerHTML = `
            <div class="tsd-card" role="dialog" aria-label="Stock dip finder">
                <button class="tsd-close" title="Close">&times;</button>
                <div class="tsd-head"><h2>📉 Stock Dip Finder <span class="tsd-ver">v${VERSION}</span></h2></div>
                <div class="tsd-body"></div>
                <div class="tsd-foot">
                    <span><a href="https://www.torn.com/page.php?sid=stocks">Stock Market</a> · <button class="tsd-linkbtn" data-act="key">Change API key</button></span>
                    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
                </div>
            </div>`;
        (document.body || document.documentElement).appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
        overlay.querySelector('.tsd-close').addEventListener('click', closePanel);
        overlay.querySelector('[data-act="key"]').addEventListener('click', () => renderKeySetup());
        if (lsGet(LS_KEY)) renderMain(); else renderKeySetup();
    }

    function renderKeySetup(errText) {
        const b = body();
        if (!b) return;
        const reuse = OTHER_KEYS.map(lsGet).find((k) => /^[A-Za-z0-9]{16}$/.test(k || '')) || '';
        b.innerHTML = `
            <p style="margin:0 0 10px;font-size:12px;">Enter a Torn API key with <b>Limited</b> access so your open trades can be read.
                Create one at <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">Settings → API Keys</a>.
                ${reuse ? 'The key from your other scripts is filled in.' : ''}</p>
            <div style="display:flex;gap:8px;">
                <input type="text" id="tsd-key" placeholder="API key" autocomplete="off" spellcheck="false" style="flex:1;min-width:0;" value="${esc(reuse)}">
                <button class="tsd-btn" id="tsd-save">Save</button>
            </div>
            <div class="tsd-msg err" id="tsd-keyerr" style="margin-top:8px" ${errText ? '' : 'hidden'}>${esc(errText || '')}</div>
            <div class="tsd-tos"><table>${TOS_ROWS.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>`;
        const input = b.querySelector('#tsd-key');
        const save = async () => {
            const key = input.value.trim();
            const err = b.querySelector('#tsd-keyerr');
            if (!/^[A-Za-z0-9]{16}$/.test(key)) { err.hidden = false; err.textContent = 'A Torn API key is 16 letters/numbers.'; return; }
            const btn = b.querySelector('#tsd-save');
            btn.disabled = true; btn.textContent = 'Checking…';
            try {
                await loadData(key, true);
                lsSet(LS_KEY, key);
                renderMain();
                updateBanner();
            } catch (e) {
                err.hidden = false; err.textContent = e.message;
                btn.disabled = false; btn.textContent = 'Save';
            }
        };
        b.querySelector('#tsd-save').addEventListener('click', save);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    }

    function renderMain() {
        const b = body();
        if (!b) return;
        b.innerHTML = `<div id="tsd-out"><div class="tsd-msg">Loading…</div></div>
            <details id="tsd-settings"><summary>Rule settings</summary>
                <div class="tsd-set" style="margin-top:8px">
                    <label>Average of last (days)<input type="number" id="tsd-avg" min="3" max="15" step="1" value="${prefs.avgDays}"></label>
                    <label>Buy when below by (%)<input type="number" id="tsd-dip" min="0" max="10" step="0.1" value="${prefs.dipPct}"></label>
                    <label>Sell at profit (%)<input type="number" id="tsd-tp" min="0.5" max="20" step="0.1" value="${prefs.targetPct}"></label>
                    <label>Sell anyway after (days)<input type="number" id="tsd-max" min="1" max="60" step="1" value="${prefs.maxDays}"></label>
                </div>
                <div class="tsd-note">Backtested defaults: 7 days, 1%, 2%, 14 days.
                    <button class="tsd-linkbtn" id="tsd-reset">Reset</button></div>
            </details>`;
        const clamp = (v, lo, hi, d) => { const n = Number(v); return isNaN(n) ? d : Math.min(hi, Math.max(lo, n)); };
        const onChange = () => {
            prefs = Object.assign({}, prefs, {
                avgDays: Math.round(clamp(b.querySelector('#tsd-avg').value, 3, 15, 7)),
                dipPct: clamp(b.querySelector('#tsd-dip').value, 0, 10, 1),
                targetPct: clamp(b.querySelector('#tsd-tp').value, 0.5, 20, 2),
                maxDays: Math.round(clamp(b.querySelector('#tsd-max').value, 1, 60, 14)),
            });
            savePrefs();
            refresh(false);
        };
        ['#tsd-avg', '#tsd-dip', '#tsd-tp', '#tsd-max'].forEach((s) => b.querySelector(s).addEventListener('change', onChange));
        b.querySelector('#tsd-reset').addEventListener('click', () => {
            prefs = Object.assign({}, DEFAULT_PREFS, { ignore: prefs.ignore });
            savePrefs();
            renderMain();
            b.querySelector('#tsd-settings').open = true;
        });
        refresh(false);
    }

    async function refresh(force) {
        const out = overlay && overlay.querySelector('#tsd-out');
        const key = lsGet(LS_KEY);
        if (!out || !key) return;
        try {
            const data = await loadData(key, force);
            const list = candidates(data);
            const open = trades(data);
            const best = list[0];
            const holding = open.length > 0;
            const tradeHtml = open.map((t) => {
                const v = tradeVerdict(t);
                return `<div class="tsd-trade ${v.cls}">
                    <button class="tsd-linkbtn tsd-ign" data-ignore="${esc(t.s.sym)}" title="Treat as a long-term holding">not a dip trade</button>
                    <b>${esc(t.s.sym)}</b> · ${t.shares.toLocaleString()} shares at ${price(t.bought)} · now ${price(t.s.price)}
                    (<span class="${t.change >= 0 ? 'pos' : 'neg'}">${pct(t.change, 2)}</span>, ${money(t.net)} after fee)
                    <div class="v">${v.icon} ${esc(v.text)}</div>
                    ${t.blocks ? '<div class="tsd-note" style="margin-top:2px">This stock pays you a benefit: selling below the block size stops it.</div>' : ''}
                </div>`;
            }).join('');
            const ignored = prefs.ignore.length ? `<div class="tsd-note">Not tracked: ${prefs.ignore.map(esc).join(', ')}
                · <button class="tsd-linkbtn" id="tsd-unignore">track again</button></div>` : '';
            out.innerHTML = `
                <h3>Your open trades</h3>
                ${data.mineErr ? `<div class="tsd-msg err">${esc(data.mineErr)}</div>`
                    : open.length ? tradeHtml : '<div class="tsd-msg">No dip trades open (purchases in the last ' + LONG_TERM_DAYS + ' days).</div>'}
                ${ignored}
                <h3>Best buy now</h3>
                ${best && best.buy ? `<div class="tsd-pick ok"><big>${esc(best.sym)}</big> ${esc(best.name)}<br>
                    ${price(best.price)} is <b class="neg">${below(best.dev)}</b> below its ${prefs.avgDays}-day average (${price(best.avg)}).<br>
                    Sell at ${price(best.price * (1 + prefs.targetPct / 100))} (+${prefs.targetPct}%) or on ${utcDay(now() + prefs.maxDays * DAY)}.
                    ${holding ? '<div class="tsd-note" style="margin-top:4px">You already have a trade open. The rule holds one at a time.</div>' : ''}</div>`
                : `<div class="tsd-pick">No stock is ${prefs.dipPct}% below its ${prefs.avgDays}-day average right now${best ? ` (closest: ${esc(best.sym)} ${pct(best.dev, 2)})` : ''}.
                    Check again later; waiting in cash is part of the rule.</div>`}
                <h3>All stocks vs. ${prefs.avgDays}-day average</h3>
                <table class="tsd-list"><tr><th>Stock</th><th class="n">Price</th><th class="n">Avg</th><th class="n">vs avg</th></tr>
                ${list.map((c) => `<tr class="${c.buy ? 'buy' : ''}"><td><b>${esc(c.sym)}</b></td><td class="n">${price(c.price)}</td>
                    <td class="n">${price(c.avg)}</td><td class="n ${c.dev < 0 ? 'neg' : 'pos'}">${pct(c.dev, 2)}</td></tr>`).join('')}
                </table>
                <div class="tsd-note">Rule: buy the stock furthest below its ${prefs.avgDays}-day average (at least ${prefs.dipPct}%),
                    sell at +${prefs.targetPct}% or after ${prefs.maxDays} days. Backtest 2022–2026 (0.1% fee included): +17% to +57% a year,
                    vs +3% to +6% for holding. No guarantee. You can't trade while travelling or in hospital.
                    Prices: Torn API, ${Math.round((Date.now() - data.ts) / 1000)}s old · averages: tornsy.com daily closes.
                    <button class="tsd-linkbtn" id="tsd-refresh">Refresh</button></div>`;
            out.querySelectorAll('[data-ignore]').forEach((btn) => btn.addEventListener('click', () => {
                prefs.ignore = Array.from(new Set(prefs.ignore.concat(btn.getAttribute('data-ignore'))));
                savePrefs(); refresh(false); updateBanner();
            }));
            const un = out.querySelector('#tsd-unignore');
            if (un) un.addEventListener('click', () => { prefs.ignore = []; savePrefs(); refresh(false); updateBanner(); });
            out.querySelector('#tsd-refresh').addEventListener('click', () => refresh(true));
            updateBanner();
        } catch (e) {
            if (e.code === 2) { lsDel(LS_KEY); renderKeySetup(e.message); return; }
            out.innerHTML = `<div class="tsd-msg err">${esc(e.message)}</div>`;
        }
    }

    // ------------------------------------------------------------ stock market banner
    // On the Stock Market page: one line on what to do, tap for details.
    async function updateBanner() {
        let el = document.getElementById('tsd-banner');
        if (!onStocksPage()) { if (el) el.remove(); return; }
        injectStyles();
        if (!el) {
            el = document.createElement('div');
            el.id = 'tsd-banner';
            el.addEventListener('click', openPanel);
            const title = document.querySelector('.content-title');
            if (title && title.parentNode) title.parentNode.insertBefore(el, title.nextSibling);
            else { el.classList.add('float'); (document.body || document.documentElement).appendChild(el); }
        }
        const float = el.classList.contains('float') ? 'float ' : '';
        const key = lsGet(LS_KEY);
        if (!key) { el.className = float; el.innerHTML = '📉 Stock Dip Finder: tap to set up'; return; }
        try {
            const data = await loadData(key, false);
            const open = trades(data);
            const sell = open.filter((t) => t.hit || t.late);
            const best = candidates(data)[0];
            let head, cls = '';
            if (sell.length) {
                head = sell.map((t) => `${tradeVerdict(t).icon} Sell ${t.s.sym} (${pct(t.change, 2)})`).join(' · ');
                cls = 'ok';
            } else if (open.length) {
                head = `⏳ Holding ${Array.from(new Set(open.map((t) => t.s.sym))).join(', ')}: no sell signal yet`;
            } else if (best && best.buy) {
                head = `📉 Buy candidate: ${best.sym} ${below(best.dev)} below its ${prefs.avgDays}-day average`;
                cls = 'warn';
            } else {
                head = `📉 No dip worth buying right now${best ? ` (closest: ${best.sym} ${pct(best.dev, 2)})` : ''}`;
            }
            el.className = float + cls;
            el.innerHTML = `<b>${esc(head)}</b><div class="tsd-bfoot">Stock Dip Finder · tap for details</div>`;
        } catch (e) {
            el.className = float;
            el.innerHTML = `📉 Stock Dip Finder: ${esc(e.message)}`;
        }
    }

    // ------------------------------------------------------------ entry button
    const CHART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M3 6l6 6 4-4 8 8"/>' +
        '<path fill="#fff" d="M21 11v6h-6z"/></svg>';
    /* =======================================================================
     * SHARED FOOTER BUTTON  (nth-hub v1 — keep this block identical in every
     * script). All of these scripts share one button in Torn's footer row.
     * With one script installed it opens that script straight away; with
     * more it opens a small menu. The page DOM is the only shared state, so
     * it also works when the script manager sandboxes each script.
     * ===================================================================== */
    const HUB_GRID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
        '<g fill="#fff"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/>' +
        '<rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></g></svg>';
    const HUB_MANY_BG = 'linear-gradient(to bottom, #6b6b6b, #3a3a3a)';
    function hubStyles() {
        if (document.getElementById('nth-hub-styles')) return;
        const st = document.createElement('style');
        st.id = 'nth-hub-styles';
        st.textContent = `
            #nth-hub-float {
                position: fixed; right: 12px; bottom: 110px; z-index: 2147483646; width: 38px; height: 38px;
                border-radius: 50%; border: 1px solid rgba(255,255,255,.25); padding: 0; cursor: pointer;
                display: flex; align-items: center; justify-content: center; box-shadow: 0 3px 12px rgba(0,0,0,.35);
            }
            #nth-hub-float svg { width: 22px; height: 22px; }
            #nth-hub-menu {
                position: fixed; z-index: 2147483646; display: none; flex-direction: column; gap: 2px;
                min-width: 190px; padding: 4px; background: #1f1f1f; border: 1px solid #444; border-radius: 8px;
                box-shadow: 0 6px 20px rgba(0,0,0,.45); font: 13px Arial, Helvetica, sans-serif;
            }
            #nth-hub-menu.nth-open { display: flex; }
            #nth-hub-menu button {
                display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 8px; margin: 0;
                background: transparent; border: 0; border-radius: 6px; color: #eee; font: inherit;
                text-align: left; cursor: pointer;
            }
            #nth-hub-menu button:hover, #nth-hub-menu button:active { background: #333; }
            #nth-hub-menu i {
                display: flex; align-items: center; justify-content: center; flex: none;
                width: 28px; height: 28px; border-radius: 6px;
            }
            #nth-hub-menu i svg { width: 18px; height: 18px; }
        `;
        (document.head || document.documentElement).appendChild(st);
    }
    function hubMenu() {
        let menu = document.getElementById('nth-hub-menu');
        if (menu) return menu;
        menu = document.createElement('div');
        menu.id = 'nth-hub-menu';
        (document.body || document.documentElement).appendChild(menu);
        document.addEventListener('click', (e) => {
            const m = document.getElementById('nth-hub-menu');
            if (m && m.classList.contains('nth-open') && !m.contains(e.target)) m.classList.remove('nth-open');
        });
        return menu;
    }
    function hubToggle(hub) {
        const menu = hubMenu();
        const items = menu.querySelectorAll('[data-hub-item]');
        if (items.length === 1) { items[0].click(); return; }
        if (menu.classList.contains('nth-open')) { menu.classList.remove('nth-open'); return; }
        const r = hub.getBoundingClientRect();
        menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        menu.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
        menu.classList.add('nth-open');
    }
    // One item looks like that script's own button; two or more show a grid.
    function hubPaint(hub, ref) {
        const items = hubMenu().querySelectorAll('[data-hub-item]');
        const one = items.length === 1 ? items[0] : null;
        const state = one ? 'one:' + one.getAttribute('data-hub-item') : 'many:' + items.length;
        if (hub.getAttribute('data-hub-state') === state) return;
        hub.setAttribute('data-hub-state', state);
        hub.title = one ? one.textContent : 'Scripts';
        hub.innerHTML = one ? one.querySelector('i').innerHTML : HUB_GRID_SVG;
        const svg = hub.querySelector('svg');
        const refSvg = ref && ref.querySelector('svg');
        const cls = (refSvg && refSvg.className && refSvg.className.baseVal) || '';
        if (svg && cls && hub.id !== 'nth-hub-float') svg.setAttribute('class', cls);
        hub.style.setProperty('background', one ? one.getAttribute('data-hub-bg') : HUB_MANY_BG, 'important');
    }
    // item: { id, label, svg (markup), bg (CSS background), onOpen }
    function hubMount(item) {
        if (!document.body) return;
        hubStyles();
        const menu = hubMenu();
        if (!menu.querySelector(`[data-hub-item="${item.id}"]`)) {
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('data-hub-item', item.id);
            b.setAttribute('data-hub-bg', item.bg);
            b.innerHTML = `<i>${item.svg.replace('%CLS%', '')}</i><span></span>`;
            b.querySelector('i').style.background = item.bg;
            b.querySelector('span').textContent = item.label;
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                menu.classList.remove('nth-open');
                item.onOpen();
            });
            menu.appendChild(b);
        }
        const ref = document.getElementById('notes_panel_button') || document.getElementById('people_panel_button');
        let hub = document.querySelector('[data-nth-hub]');
        const inBar = !!(ref && ref.parentNode);
        if (hub && (inBar ? hub.parentNode === ref.parentNode : hub.id === 'nth-hub-float')) { hubPaint(hub, ref); return; }
        if (hub) hub.remove();
        hub = document.createElement('button');
        hub.type = 'button';
        hub.setAttribute('data-nth-hub', '');
        hub.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); hubToggle(hub); });
        let placed = false;
        if (inBar) {
            hub.className = ref.className;
            try { ref.parentNode.insertBefore(hub, ref); placed = true; } catch (e) { /* fall back to floating */ }
        }
        if (!placed) {
            hub.id = 'nth-hub-float';
            document.body.appendChild(hub);
        }
        hubPaint(hub, ref);
    }
    function mountButton() {
        hubMount({ id: 'tsd', label: 'Stock dip finder', svg: CHART_SVG,
            bg: 'linear-gradient(to bottom, #f0a030, #b0600c)', onOpen: openPanel });
    }

    function start() {
        if (!document.body) return setTimeout(start, 300);
        injectStyles();
        mountButton();
        updateBanner();
        let pending = false;
        // Idle in background tabs (Torn PDA keeps them running); catch up on return.
        new MutationObserver(() => {
            if (pending || document.hidden) return;
            pending = true;
            setTimeout(() => {
                pending = false;
                mountButton();   // cheap no-op while the button is in place
                const el = document.getElementById('tsd-banner');
                if (onStocksPage() ? !el : el) updateBanner();
            }, 300);
        }).observe(document.body, { childList: true, subtree: true });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) mountButton(); });
    }

    start();
})();
