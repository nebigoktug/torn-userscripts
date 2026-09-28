// ==UserScript==
// @name         Torn Flower Set Helper
// @namespace    https://github.com/nebigoktug
// @version      2.1.1
// @description  Counts your flowers, shows how many museum flower sets you can make and what's missing for a target, where each flower is sold abroad, what the missing ones cost on the item market, and the profit of exchanging sets for points. Display only, no automation.
// @author       Nebigoktug
// @license      MIT
// @supportURL   https://github.com/nebigoktug/torn-userscripts/issues
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Flower_Set_Helper.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Flower_Set_Helper.user.js
// ==/UserScript==

/*
 * Torn Flower Set Helper
 *
 * A flower set is one of each of the 11 flowers; sets are exchanged for
 * points at the museum. This reads your inventory (Torn API v2, Minimal key),
 * shows complete sets, what's missing for a target number of sets, where each
 * flower is sold abroad, and — optionally — what buying the missing ones on
 * the item market would cost right now.
 *
 * It only reads data and shows it. It never buys, travels or clicks anything.
 */

(function () {
    'use strict';

    // Torn PDA may inject on any URL containing "torn"; only run on the game.
    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;

    const VERSION  = '2.1.1';
    const REPO_URL = 'https://github.com/nebigoktug/torn-userscripts';
    const LS_KEY   = 'tfs_api_key';
    const LS_PREFS = 'tfs_prefs';
    const LS_PRICES = 'tfs_prices';
    const PRICE_TTL_MS  = 10 * 60 * 1000;   // reuse market prices for 10 min
    const FORCE_PRICE_TTL_MS = 2 * 60 * 1000; // Refresh only refetches prices older than this
    const INV_MIN_AGE_MS = 60 * 1000;       // Refresh refetches the inventory at most once a minute
    const RATE_PAUSE_MS  = 60 * 1000;       // no API calls for this long after "too many requests"
    const REQUEST_GAP_MS = 250;             // spacing between market requests

    // IDs verified against TornTools' SETS.FLOWERS list.
    const FLOWERS = [
        { id: 260, name: 'Dahlia',            country: 'Mexico' },
        { id: 617, name: 'Banana Orchid',     country: 'Cayman Islands' },
        { id: 263, name: 'Crocus',            country: 'Canada' },
        { id: 264, name: 'Orchid',            country: 'Hawaii' },
        { id: 267, name: 'Heather',           country: 'United Kingdom' },
        { id: 271, name: 'Ceibo Flower',      country: 'Argentina' },
        { id: 272, name: 'Edelweiss',         country: 'Switzerland' },
        { id: 277, name: 'Cherry Blossom',    country: 'Japan' },
        { id: 276, name: 'Peony',             country: 'China' },
        { id: 385, name: 'Tribulus Omanense', country: 'UAE' },
        { id: 282, name: 'African Violet',    country: 'South Africa' },
    ];

    const DEFAULT_PREFS = { target: 10, showPrices: true };
    const POINTS_PER_SET = 10;   // "You exchanged 3x Exotic Flower Set to the museum for 30 points"

    // ------------------------------------------------------------ storage
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    const loadPrefs = () => {
        try { return Object.assign({}, DEFAULT_PREFS, JSON.parse(lsGet(LS_PREFS) || '{}')); }
        catch (e) { return Object.assign({}, DEFAULT_PREFS); }
    };
    const savePrefs = (p) => lsSet(LS_PREFS, JSON.stringify(p));
    let prefs = loadPrefs();

    // ------------------------------------------------------------ helpers
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const money = (n) => {
        if (n == null || isNaN(n)) return '—';
        const a = Math.abs(n);
        if (a >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'b';
        if (a >= 1e6) return '$' + (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'm';
        if (a >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
        return '$' + Math.round(n);
    };
    const ago = (ts) => {
        if (!ts) return '';
        const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
        return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
    };
    const marketUrl = (f) => `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${f.id}` +
        `&itemName=${encodeURIComponent(f.name)}&itemType=Flower`;

    // ------------------------------------------------------------ Torn API
    class ApiError extends Error {
        constructor(code, msg) { super(msg); this.code = code; }
    }
    // Torn's limit (100 requests/min) is per user and shared with PDA and every
    // other script. After a "too many requests" we stay quiet for a minute.
    let pausedUntil = 0;
    const RATE_MSG = "Torn API limit reached (100/min, shared with PDA and other scripts).";
    async function api(path, key) {
        if (Date.now() < pausedUntil) throw new ApiError(5, RATE_MSG);
        const sep = path.includes('?') ? '&' : '?';
        let resp;
        try {
            resp = await fetch(`https://api.torn.com/v2/${path}${sep}key=${encodeURIComponent(key)}&comment=FlowerSetHelper`);
        } catch (e) {
            throw new ApiError(-1, 'Network error — check your connection and try again.');
        }
        let data;
        try { data = await resp.json(); } catch (e) { throw new ApiError(-1, `Unexpected response (HTTP ${resp.status}).`); }
        if (data && data.error) {
            const c = data.error.code;
            if (c === 5) { pausedUntil = Date.now() + RATE_PAUSE_MS; throw new ApiError(5, RATE_MSG); }
            const msg = {
                2: 'Incorrect API key.',
                5: 'Too many requests — wait a minute and try again.',
                10: 'Key owner is in federal jail.',
                13: 'Key is disabled because the owner has been inactive.',
                16: 'Key access level is too low — use at least a Minimal key.',
                18: 'API key is paused.',
            }[c] || `Torn API error ${c}: ${data.error.error}`;
            throw new ApiError(c, msg);
        }
        return data;
    }

    // Flower counts from the v2 inventory (cached by Torn for up to 1 hour).
    async function fetchFlowers(key) {
        const data = await api('user/inventory?cat=Flower&limit=250', key);
        const inv = data.inventory || {};
        const counts = {};
        FLOWERS.forEach((f) => { counts[f.id] = 0; });
        (inv.items || []).forEach((it) => {
            if (it.faction_owned) return;
            if (counts[it.id] !== undefined) counts[it.id] += Number(it.amount) || 0;
        });
        return { counts, timestamp: inv.timestamp || 0 };
    }

    // Cheapest listings for one flower; cached for PRICE_TTL_MS.
    function priceCache() { try { return JSON.parse(lsGet(LS_PRICES) || '{}'); } catch (e) { return {}; } }
    async function fetchListings(id, key, ttl = PRICE_TTL_MS) {
        const cache = priceCache();
        const c = cache[id];
        if (c && Date.now() - c.ts < ttl) return c.listings;
        const data = await api(`market/${id}/itemmarket?limit=100`, key);
        const listings = ((data.itemmarket && data.itemmarket.listings) || [])
            .map((l) => ({ price: Number(l.price), amount: Number(l.amount) || 1 }))
            .filter((l) => l.price > 0)
            .sort((a, b) => a.price - b.price);
        cache[id] = { ts: Date.now(), listings };
        lsSet(LS_PRICES, JSON.stringify(cache));
        return listings;
    }
    // Cheapest points-market listing (price per point); cached with the item prices.
    async function fetchPointPrice(key, ttl = PRICE_TTL_MS) {
        const cache = priceCache();
        const c = cache.points;
        if (c && Date.now() - c.ts < ttl) return c.price;
        const data = await api('market/pointsmarket', key);
        const list = Array.isArray(data.pointsmarket) ? data.pointsmarket : Object.values(data.pointsmarket || {});
        const costs = list.map((l) => Number(l.cost)).filter((n) => n > 0);
        const price = costs.length ? Math.min(...costs) : null;
        cache.points = { ts: Date.now(), price };
        lsSet(LS_PRICES, JSON.stringify(cache));
        return price;
    }

    // Cost of buying `qty` from the cheapest listings. `partial` means the
    // listings we got didn't cover the whole quantity (cost is then a floor).
    function costFor(listings, qty) {
        let left = qty, cost = 0;
        for (const l of listings) {
            if (left <= 0) break;
            const take = Math.min(left, l.amount);
            cost += take * l.price;
            left -= take;
        }
        return { cost, partial: left > 0, cheapest: listings.length ? listings[0].price : null };
    }

    // ------------------------------------------------------------ styles
    function injectStyles() {
        if (document.getElementById('tfs-styles')) return;
        const st = document.createElement('style');
        st.id = 'tfs-styles';
        st.textContent = `
        :root {
            --tfs-bg: #1f2227; --tfs-bg2: #15171b; --tfs-fg: #f1f3f5; --tfs-muted: #c3c8cf;
            --tfs-border: #3a3f47; --tfs-hover: #2c3037; --tfs-accent: #e05aa0; --tfs-accent-fg: #fff;
            --tfs-good: #2ecc40; --tfs-bad: #ff6b61; --tfs-link: #4aa3ff; --tfs-shadow: rgba(0,0,0,0.6);
        }
        body:not(.dark-mode) {
            --tfs-bg: #fff; --tfs-bg2: #f1f3f5; --tfs-fg: #15181b; --tfs-muted: #454c55;
            --tfs-border: #d0d5db; --tfs-hover: #e7eaee; --tfs-accent: #c83e87; --tfs-accent-fg: #fff;
            --tfs-good: #1f9a30; --tfs-bad: #d93025; --tfs-link: #1a73e8; --tfs-shadow: rgba(0,0,0,0.25);
        }
        [data-tfs-btn] { background: linear-gradient(to bottom, #e05aa0, #9c2d68) !important; }
        [data-tfs-btn]:hover { background: linear-gradient(to bottom, #ef78b6, #e05aa0) !important; }
        #tfs-float {
            position: fixed; right: 12px; bottom: 156px; z-index: 2147483646; width: 38px; height: 38px;
            border-radius: 50%; border: 1px solid var(--tfs-border); background: var(--tfs-bg);
            font-size: 19px; line-height: 38px; text-align: center; cursor: pointer; padding: 0;
            box-shadow: 0 3px 12px var(--tfs-shadow);
        }
        @keyframes tfs-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes tfs-pop  { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
        #tfs-overlay {
            position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.7);
            display: flex; align-items: center; justify-content: center;
            font-family: Arial, Helvetica, sans-serif; animation: tfs-fade .15s ease-out;
        }
        #tfs-overlay .tfs-card {
            position: relative; width: 420px; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column;
            background: var(--tfs-bg); color: var(--tfs-fg); border: 1px solid var(--tfs-border);
            border-radius: 12px; box-shadow: 0 10px 34px var(--tfs-shadow); animation: tfs-pop .18s ease-out;
            box-sizing: border-box; font-size: 14px; line-height: 1.35;
        }
        /* Torn's own CSS greys out table cells and spans in dark mode; pin our colours. */
        #tfs-overlay .tfs-card, #tfs-overlay .tfs-card td, #tfs-overlay .tfs-card label,
        #tfs-overlay .tfs-card p, #tfs-overlay .tfs-card b { color: var(--tfs-fg) !important; }
        #tfs-overlay .tfs-head { padding: 14px 44px 10px 16px; border-bottom: 1px solid var(--tfs-border); }
        #tfs-overlay h2 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
        #tfs-overlay .tfs-ver { font-size: 10px; font-weight: 700; color: var(--tfs-muted);
            border: 1px solid var(--tfs-border); border-radius: 10px; padding: 2px 6px; }
        #tfs-overlay .tfs-close {
            position: absolute; top: 8px; right: 10px; width: 28px; height: 28px; padding: 0; border: 0;
            background: transparent; color: var(--tfs-muted); font-size: 20px; line-height: 28px;
            cursor: pointer; border-radius: 6px;
        }
        #tfs-overlay .tfs-close:hover { background: var(--tfs-hover); color: var(--tfs-fg); }
        #tfs-overlay .tfs-body { overflow-y: auto; padding: 12px 16px; }
        #tfs-overlay .tfs-foot { padding: 10px 16px 12px; border-top: 1px solid var(--tfs-border);
            display: flex; justify-content: space-between; font-size: 11px; }
        #tfs-overlay a { color: var(--tfs-link); }
        #tfs-overlay .tfs-linkbtn { background: none; border: 0; padding: 0; cursor: pointer;
            color: var(--tfs-link); font-size: 11px; text-decoration: underline; }
        #tfs-overlay input[type="text"], #tfs-overlay input[type="number"] {
            box-sizing: border-box; padding: 7px 8px; font-size: 13px; border-radius: 6px;
            background: var(--tfs-bg2); color: var(--tfs-fg); border: 1px solid var(--tfs-border);
        }
        #tfs-overlay .tfs-btn {
            padding: 8px 14px; font-size: 13px; font-weight: 700; cursor: pointer; border-radius: 7px;
            background: var(--tfs-accent); color: var(--tfs-accent-fg); border: 0;
        }
        #tfs-overlay .tfs-btn:disabled { opacity: .6; cursor: default; }
        #tfs-overlay .tfs-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
        #tfs-overlay .tfs-controls label { display: flex; align-items: center; gap: 6px; }
        #tfs-overlay .tfs-controls input[type="number"] { width: 72px; text-align: right; }
        #tfs-overlay .tfs-controls .tfs-btn { margin-left: auto; }
        #tfs-overlay input[type="checkbox"] { accent-color: var(--tfs-accent); width: 16px; height: 16px; }
        #tfs-overlay .tfs-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px; }
        #tfs-overlay .tfs-stat { background: var(--tfs-bg2); border: 1px solid var(--tfs-border); border-radius: 8px;
            padding: 7px 8px; text-align: center; }
        #tfs-overlay .tfs-stat b { display: block; font-size: 19px; font-weight: 800; font-variant-numeric: tabular-nums; }
        #tfs-overlay .tfs-stat span { font-size: 11px; font-weight: 700; color: var(--tfs-muted) !important; text-transform: uppercase; letter-spacing: .4px; }
        #tfs-overlay table.tfs-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        #tfs-overlay .tfs-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .4px;
            color: var(--tfs-muted) !important; font-weight: 700; padding: 4px 4px; border-bottom: 1px solid var(--tfs-border); }
        #tfs-overlay .tfs-table td { padding: 6px 4px; border-bottom: 1px solid var(--tfs-border); vertical-align: middle; }
        #tfs-overlay .tfs-table .num { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
        #tfs-overlay .tfs-table th.num { font-weight: 700; }
        #tfs-overlay .tfs-table a { font-weight: 700; }
        #tfs-overlay .tfs-table .country { display: block; font-size: 11px; color: var(--tfs-muted) !important; }
        #tfs-overlay .tfs-table tr.low td:first-child { box-shadow: inset 3px 0 0 var(--tfs-bad); }
        #tfs-overlay .tfs-table tr.ok  td:first-child { box-shadow: inset 3px 0 0 var(--tfs-good); }
        #tfs-overlay .tfs-miss { color: var(--tfs-bad) !important; font-weight: 800; }
        #tfs-overlay .tfs-okmark { color: var(--tfs-good) !important; font-weight: 800; }
        #tfs-overlay .tfs-note { font-size: 12px; color: var(--tfs-muted) !important; margin-top: 10px; line-height: 1.5; }
        #tfs-overlay .tfs-msg { padding: 10px; border-radius: 8px; background: var(--tfs-bg2); color: var(--tfs-muted) !important; text-align: center; }
        #tfs-overlay .tfs-msg.err { color: var(--tfs-bad) !important; }
        #tfs-overlay .tfs-points { background: var(--tfs-bg2); border: 1px solid var(--tfs-border); border-radius: 8px;
            padding: 6px 10px; margin-bottom: 10px; }
        #tfs-overlay .tfs-prow { display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
            padding: 4px 0; font-size: 13px; }
        #tfs-overlay .tfs-prow span { color: var(--tfs-muted) !important; }
        #tfs-overlay .tfs-prow b { font-variant-numeric: tabular-nums; font-weight: 800; white-space: nowrap; }
        #tfs-overlay .tfs-prow i { font-style: normal; font-size: 11px; color: var(--tfs-muted) !important; margin-left: 5px; }
        #tfs-overlay .tfs-prow span i { display: block; margin-left: 0; }
        #tfs-overlay .tfs-prow.tfs-big { border-top: 1px solid var(--tfs-border); margin-top: 4px; padding-top: 8px; }
        #tfs-overlay .tfs-prow.tfs-big b { font-size: 18px; }
        #tfs-overlay b.tfs-pos { color: var(--tfs-good) !important; }
        #tfs-overlay b.tfs-neg { color: var(--tfs-bad) !important; }
        #tfs-overlay .tfs-points .tfs-msg { background: transparent; padding: 6px; }
        #tfs-overlay .tfs-tos { margin-top: 12px; }
        #tfs-overlay .tfs-tos table { width: 100%; border-collapse: collapse; font-size: 11px; }
        #tfs-overlay .tfs-tos th, #tfs-overlay .tfs-tos td { text-align: left; vertical-align: top; padding: 4px;
            border-bottom: 1px solid var(--tfs-border); }
        #tfs-overlay .tfs-tos th { width: 34%; }
        #tfs-overlay .tfs-tos td { color: var(--tfs-muted) !important; }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    // ------------------------------------------------------------ panel
    // Torn API ToS: shown wherever the key is entered.
    const TOS_ROWS = [
        ['Data storage', 'Only locally: your key, target and a 10-minute price cache stay in this browser.'],
        ['Data sharing', 'Nobody. Requests go only to api.torn.com.'],
        ['Purpose of use', 'Personal gain: planning museum flower sets.'],
        ['Key storage & sharing', 'Stored locally on this device. Not shared.'],
        ['Key access level', 'Minimal (user → inventory). Market prices use public data.'],
    ];

    let overlay = null;
    function closePanel() { if (overlay) { overlay.remove(); overlay = null; } }

    function openPanel() {
        if (overlay) return;
        injectStyles();
        overlay = document.createElement('div');
        overlay.id = 'tfs-overlay';
        overlay.innerHTML = `
            <div class="tfs-card" role="dialog" aria-label="Flower Set Helper">
                <button class="tfs-close" title="Close">&times;</button>
                <div class="tfs-head"><h2>🌸 Flower Sets <span class="tfs-ver">v${VERSION}</span></h2></div>
                <div class="tfs-body"></div>
                <div class="tfs-foot">
                    <span><a href="https://www.torn.com/museum.php">Museum</a> · <button class="tfs-linkbtn" data-act="key">Change API key</button></span>
                    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
                </div>
            </div>`;
        (document.body || document.documentElement).appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
        overlay.querySelector('.tfs-close').addEventListener('click', closePanel);
        overlay.querySelector('[data-act="key"]').addEventListener('click', () => renderKeySetup());
        if (lsGet(LS_KEY)) renderMain(); else renderKeySetup();
    }

    function body() { return overlay && overlay.querySelector('.tfs-body'); }

    function renderKeySetup(errText) {
        const b = body();
        if (!b) return;
        b.innerHTML = `
            <p style="margin:0 0 10px;color:var(--tfs-muted);font-size:12px;">
                Enter a Torn API key with at least <b>Minimal</b> access. Create one at
                <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">Settings → API Keys</a>.</p>
            <div class="tfs-controls">
                <input type="text" id="tfs-key" placeholder="API key" autocomplete="off" spellcheck="false" style="flex:1;min-width:0;">
                <button class="tfs-btn" id="tfs-save">Save</button>
            </div>
            <div class="tfs-msg err" id="tfs-keyerr" ${errText ? '' : 'hidden'}>${esc(errText || '')}</div>
            <div class="tfs-tos"><table>${TOS_ROWS.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>`;
        const input = b.querySelector('#tfs-key');
        const save = async () => {
            const key = input.value.trim();
            const err = b.querySelector('#tfs-keyerr');
            if (!/^[A-Za-z0-9]{16}$/.test(key)) { err.hidden = false; err.textContent = 'A Torn API key is 16 letters/numbers.'; return; }
            const btn = b.querySelector('#tfs-save');
            btn.disabled = true; btn.textContent = 'Checking…';
            try {
                // Verifies key + access level; the result is reused so the
                // main view doesn't fetch the inventory a second time.
                lastInv = await fetchFlowers(key);
                lastInvAt = Date.now();
                lsSet(LS_KEY, key);
                renderMain();
            } catch (e) {
                err.hidden = false; err.textContent = e.message;
                btn.disabled = false; btn.textContent = 'Save';
            }
        };
        b.querySelector('#tfs-save').addEventListener('click', save);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
        input.focus();
    }

    function renderMain() {
        const b = body();
        if (!b) return;
        b.innerHTML = `
            <div class="tfs-controls">
                <label>Target sets <input type="number" id="tfs-target" min="1" step="1" value="${Number(prefs.target) || 1}"></label>
                <label><input type="checkbox" id="tfs-prices" ${prefs.showPrices ? 'checked' : ''}> Market prices</label>
                <button class="tfs-btn" id="tfs-refresh">Refresh</button>
            </div>
            <div id="tfs-out"><div class="tfs-msg">Loading…</div></div>`;
        const target = b.querySelector('#tfs-target');
        const prices = b.querySelector('#tfs-prices');
        const onChange = () => {
            const t = Math.max(1, parseInt(target.value, 10) || 1);
            prefs = Object.assign({}, prefs, { target: t, showPrices: prices.checked });
            savePrefs(prefs);
            refresh(false);
        };
        target.addEventListener('change', onChange);
        prices.addEventListener('change', onChange);
        b.querySelector('#tfs-refresh').addEventListener('click', () => refresh(true));
        refresh(false);
    }

    let lastInv = null;          // { counts, timestamp } — reused when only the target changes
    let lastInvAt = 0;           // when we last fetched it (ms)
    let refreshToken = 0;        // drops results of superseded refreshes

    // Banner + disabled Refresh button counting down the rate-limit pause.
    let pauseTimer = null;
    function showPause() {
        clearInterval(pauseTimer);
        const tick = () => {
            const left = Math.ceil((pausedUntil - Date.now()) / 1000);
            const btn = overlay && overlay.querySelector('#tfs-refresh');
            const out = overlay && overlay.querySelector('#tfs-out');
            let banner = overlay && overlay.querySelector('#tfs-pause');
            if (!overlay || left <= 0) {
                clearInterval(pauseTimer);
                if (banner) banner.remove();
                if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
                return;
            }
            if (!banner && out) {
                banner = document.createElement('div');
                banner.id = 'tfs-pause';
                banner.className = 'tfs-msg err';
                banner.style.marginBottom = '10px';
                out.parentNode.insertBefore(banner, out);
            }
            if (banner) banner.textContent = `${RATE_MSG} New requests in ${left}s.`;
            if (btn) { btn.disabled = true; btn.textContent = `Wait ${left}s`; }
        };
        tick();
        pauseTimer = setInterval(tick, 1000);
    }

    async function refresh(force) {
        const out = overlay && overlay.querySelector('#tfs-out');
        const key = lsGet(LS_KEY);
        if (!out || !key) return;
        const token = ++refreshToken;
        const btn = overlay.querySelector('#tfs-refresh');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
        // Refresh re-reads only what's stale: Torn caches the inventory for up
        // to an hour anyway, and prices younger than 2 minutes are kept.
        const priceTtl = force ? FORCE_PRICE_TTL_MS : PRICE_TTL_MS;
        try {
            if (!lastInv || (force && Date.now() - lastInvAt >= INV_MIN_AGE_MS)) {
                lastInv = await fetchFlowers(key);
                lastInvAt = Date.now();
            }
            if (token !== refreshToken) return;
            const target = Math.max(1, Number(prefs.target) || 1);
            const rows = FLOWERS.map((f) => {
                const have = lastInv.counts[f.id] || 0;
                return { f, have, missing: Math.max(0, target - have) };
            });
            const sets = Math.min(...rows.map((r) => r.have));
            renderTable(out, rows, sets, target, null);

            if (prefs.showPrices) {
                let total = 0, partial = false;
                for (const r of rows) {
                    if (token !== refreshToken) return;
                    const cached = priceCache()[r.f.id];
                    const wasCached = cached && Date.now() - cached.ts < priceTtl;
                    const listings = await fetchListings(r.f.id, key, priceTtl);
                    const c = costFor(listings, r.missing);
                    r.cheapest = c.cheapest;
                    r.cost = r.missing ? c.cost : 0;
                    r.partial = r.missing > 0 && c.partial;
                    total += r.cost;
                    partial = partial || r.partial;
                    if (token !== refreshToken) return;
                    renderTable(out, rows, sets, target, { total, partial });
                    if (!wasCached) await sleep(REQUEST_GAP_MS);
                }
                // Points side of the trade: what a set is worth at the museum.
                const pointPrice = await fetchPointPrice(key, priceTtl);
                if (token !== refreshToken) return;
                const fullSet = rows.every((r) => r.cheapest != null)
                    ? rows.reduce((s, r) => s + r.cheapest, 0) : null;
                renderTable(out, rows, sets, target, { total, partial, pointPrice, fullSet });
            }
        } catch (e) {
            if (token !== refreshToken) return;
            if (e.code === 2) { lsDel(LS_KEY); lastInv = null; renderKeySetup(e.message); return; }
            if (e.code === 5) {
                // Keep whatever was already drawn; just count down the pause.
                if (!out.querySelector('.tfs-table')) out.innerHTML = '';
                showPause();
                return;
            }
            out.innerHTML = `<div class="tfs-msg err">${esc(e.message)}</div>`;
        } finally {
            if (token === refreshToken && btn && btn.isConnected && Date.now() >= pausedUntil) {
                btn.disabled = false; btn.textContent = 'Refresh';
            }
        }
    }

    // Profit / loss of turning flowers into museum points.
    function pointsBlock(cost, target) {
        if (!cost || cost.pointPrice === undefined) {
            return '<div class="tfs-points"><div class="tfs-msg">Points price loading…</div></div>';
        }
        if (cost.pointPrice == null) {
            return '<div class="tfs-points"><div class="tfs-msg">No points-market listings found.</div></div>';
        }
        const setValue = POINTS_PER_SET * cost.pointPrice;
        const signed = (n, approx) => `<b class="${n >= 0 ? 'tfs-pos' : 'tfs-neg'}">${approx}${n >= 0 ? '+' : '−'}${money(Math.abs(n))}</b>`;
        // Owned flowers count as free here: this is the return on the cash you'd spend.
        const profit = target * setValue - cost.total;
        // A "+" total means listings ran out, so the real cost is higher and profit lower.
        const approx = cost.partial ? '≤ ' : '';
        const perSet = cost.fullSet != null ? setValue - cost.fullSet : null;
        return `
            <div class="tfs-points">
                <div class="tfs-prow"><span>Point price</span><b>${money(cost.pointPrice)}</b></div>
                <div class="tfs-prow"><span>Set value (${POINTS_PER_SET} pts)</span><b>${money(setValue)}</b></div>
                <div class="tfs-prow"><span>Market set cost</span><b>${cost.fullSet != null ? money(cost.fullSet) : '—'}</b></div>
                <div class="tfs-prow"><span>Buy a full set &amp; exchange</span>${perSet != null ? signed(perSet, '') + '<i>per set</i>' : '<b>—</b>'}</div>
                <div class="tfs-prow tfs-big"><span>Profit to ${target} sets<i>buying only what's missing</i></span>${signed(profit, approx)}</div>
            </div>`;
    }

    function renderTable(out, rows, sets, target, cost) {
        const missingTotal = rows.reduce((s, r) => s + r.missing, 0);
        const showPrices = !!prefs.showPrices;
        const costCell = cost ? money(cost.total) + (cost.partial ? '+' : '') : (showPrices ? '…' : '—');
        out.innerHTML = `
            <div class="tfs-summary">
                <div class="tfs-stat"><b>${sets}</b><span>Complete sets</span></div>
                <div class="tfs-stat"><b>${missingTotal}</b><span>Flowers missing</span></div>
                <div class="tfs-stat"><b>${showPrices ? costCell : '—'}</b><span>Cost to ${target}</span></div>
            </div>
            ${showPrices ? pointsBlock(cost, target) : ''}
            <table class="tfs-table">
                <tr><th>Flower</th><th class="num">Have</th><th class="num">Need</th>
                    ${showPrices ? '<th class="num">Cheapest</th><th class="num">Cost</th>' : ''}</tr>
                ${rows.map((r) => `
                    <tr class="${r.missing ? 'low' : 'ok'}">
                        <td><a href="${marketUrl(r.f)}">${esc(r.f.name)}</a><span class="country">${esc(r.f.country)}</span></td>
                        <td class="num">${r.have}</td>
                        <td class="num">${r.missing ? `<span class="tfs-miss">${r.missing}</span>` : '<span class="tfs-okmark">✓</span>'}</td>
                        ${showPrices ? `<td class="num">${r.cheapest === undefined ? '…' : money(r.cheapest)}</td>
                            <td class="num">${r.cost === undefined ? '…' : r.missing ? money(r.cost) + (r.partial ? '+' : '') : '—'}</td>` : ''}
                    </tr>`).join('')}
            </table>
            <div class="tfs-note">
                Inventory updated ${ago(lastInv && lastInv.timestamp) || 'recently'} — Torn caches it for up to an hour,
                so flowers bought just now may not show yet. Items in your display case aren't counted.
                ${showPrices ? 'Costs walk the cheapest item-market listings; "+" means the listings shown didn\'t cover the full amount.' : ''}
            </div>`;
    }

    // ------------------------------------------------------------ entry button
    // Same anchor as the FF/BS Badges ⚙ and Bounty Hunter: Torn's footer
    // panel buttons. Falls back to a small floating button.
    const FLOWER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<g fill="#fff"><circle cx="12" cy="6.2" r="3.4"/><circle cx="17.5" cy="10.2" r="3.4"/><circle cx="15.4" cy="16.6" r="3.4"/>' +
        '<circle cx="8.6" cy="16.6" r="3.4"/><circle cx="6.5" cy="10.2" r="3.4"/></g><circle cx="12" cy="11.8" r="2.6" fill="#ffd54a"/></svg>';

    function mountButton() {
        const ref = document.getElementById('notes_panel_button') || document.getElementById('people_panel_button');
        const inBar = document.querySelector('[data-tfs-btn]');
        const floating = document.getElementById('tfs-float');
        if (ref && ref.parentNode) {
            if (inBar && inBar.parentNode === ref.parentNode) { if (floating) floating.remove(); return; }
            if (inBar) inBar.remove();
            const svg = ref.querySelector('svg');
            const cls = (svg && svg.className && svg.className.baseVal) || '';
            const b = document.createElement('button');
            b.type = 'button';
            b.className = ref.className;
            b.title = 'Flower sets';
            b.setAttribute('data-tfs-btn', '');
            b.innerHTML = FLOWER_SVG.replace('%CLS%', cls ? ` class="${cls}"` : '');
            b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(); });
            try { ref.parentNode.insertBefore(b, ref); if (floating) floating.remove(); return; } catch (e) { b.remove(); }
        } else if (inBar) {
            inBar.remove();
        }
        if (floating) return;
        const f = document.createElement('button');
        f.id = 'tfs-float';
        f.title = 'Flower sets';
        f.textContent = '🌸';
        f.addEventListener('click', openPanel);
        (document.body || document.documentElement).appendChild(f);
    }

    function start() {
        if (!document.body) return setTimeout(start, 300);
        injectStyles();
        mountButton();
        // Torn's SPA re-renders the footer; re-mount when our button goes missing.
        let pending = false;
        new MutationObserver(() => {
            if (pending) return;
            pending = true;
            setTimeout(() => {
                pending = false;
                const ref = document.getElementById('notes_panel_button') || document.getElementById('people_panel_button');
                const ok = ref ? !!document.querySelector('[data-tfs-btn]') : !!document.getElementById('tfs-float');
                if (!ok) mountButton();
            }, 300);
        }).observe(document.body, { childList: true, subtree: true });
    }

    start();
})();
