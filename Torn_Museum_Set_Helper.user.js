// ==UserScript==
// @name         Torn Museum Set Helper
// @namespace    https://github.com/nebigoktug
// @version      3.0.2
// @description  Every museum set in one panel: flowers, plushies and artifacts (coins, arrowheads, sculptures, Companion Scripts, Senet, amulet…). Counts what you own, shows complete sets and what's missing for a target, where flowers and plushies are sold abroad, what the missing items cost on the item market, and the profit of exchanging sets for points. Display only, no automation.
// @author       Nebigoktug
// @license      MIT
// @supportURL   https://github.com/nebigoktug/torn-userscripts/issues
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Museum_Set_Helper.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Museum_Set_Helper.user.js
// ==/UserScript==

/*
 * Torn Museum Set Helper (formerly Torn Flower Set Helper)
 *
 * Museum sets are exchanged for points: an exotic flower set or a plushie
 * set (10 points each) and the artifact sets, from a Meteorite Fragment
 * (15) up to the Egyptian Amulet (10,000). This reads your inventory (Torn
 * API v2, Minimal key), shows complete sets, what's missing for a target
 * number of sets, where flowers and plushies are sold abroad, and — optionally
 * — what buying the missing items on the item market would cost right now.
 *
 * It only reads data and shows it. It never buys, travels or clicks anything.
 *
 * Non-API requests (disclosed per Torn's scripting rules): when YOU tap
 * "Live counts", the script makes one request for the open tab's category
 * on your Items page (item.php, getCategoryList) — the same request Torn's
 * own Items page makes. Nothing is ever requested automatically. On the
 * Items page it also reads the Flower / Plushie / Artifact lists Torn loads
 * when you open those tabs.
 */

(function () {
    'use strict';

    // Torn PDA may inject on any URL containing "torn"; only run on the game.
    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;
    // Torn PDA can inject the script again on in-page navigation. Without this
    // guard every copy kept its own timers and observers, and the page got
    // slower the longer PDA stayed open.
    if (window.__tfsRunning) return;
    window.__tfsRunning = true;

    const VERSION  = '3.0.2';
    const REPO_URL = 'https://github.com/nebigoktug/torn-userscripts';
    const LS_KEY   = 'tfs_api_key';             // same key as the old Flower Set Helper
    const LS_PREFS = 'tfs_prefs';
    const LS_PRICES = 'tfs_prices';
    const LS_PAGEINV = 'tms_page_inv';      // counts read from your own Items page, per group
    const LS_ARTIFACTS = 'tms_artifact_ids'; // artifact name -> item ID, from the Torn API
    const ARTIFACT_IDS_TTL_MS = 7 * 24 * 3600 * 1000;
    const PRICE_TTL_MS  = 10 * 60 * 1000;   // reuse market prices for 10 min
    const FORCE_PRICE_TTL_MS = 2 * 60 * 1000; // Refresh only refetches prices older than this
    const INV_MIN_AGE_MS = 60 * 1000;       // Refresh refetches the inventory at most once a minute
    const RATE_PAUSE_MS  = 60 * 1000;       // no API calls for this long after "too many requests"
    const REQUEST_GAP_MS = 250;             // spacing between market requests
    const MUSEUM_DAY_BONUS = 1.1;           // Museum Day: 10% more points

    // Flower and plushie IDs verified against TornTools' SETS lists.
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
    const PLUSHIES = [
        { id: 186, name: 'Sheep Plushie',      country: "Torn (Bits 'n' Bobs)" },
        { id: 187, name: 'Teddy Bear Plushie', country: "Torn (Bits 'n' Bobs)" },
        { id: 215, name: 'Kitten Plushie',     country: "Torn (Bits 'n' Bobs)" },
        { id: 258, name: 'Jaguar Plushie',     country: 'Mexico' },
        { id: 261, name: 'Wolverine Plushie',  country: 'Canada' },
        { id: 266, name: 'Nessie Plushie',     country: 'United Kingdom' },
        { id: 268, name: 'Red Fox Plushie',    country: 'United Kingdom' },
        { id: 269, name: 'Monkey Plushie',     country: 'Argentina' },
        { id: 273, name: 'Chamois Plushie',    country: 'Switzerland' },
        { id: 274, name: 'Panda Plushie',      country: 'China' },
        { id: 281, name: 'Lion Plushie',       country: 'South Africa' },
        { id: 384, name: 'Camel Plushie',      country: 'UAE' },
        { id: 618, name: 'Stingray Plushie',   country: 'Cayman Islands' },
    ];
    // Artifact sets and points from the Torn wiki's Museum page. Item IDs are
    // looked up by name from the API (torn/items?cat=Artifact): each piece
    // lists the words its item name must contain.
    const ARTIFACT_SETS = [
        { key: 'meteorite', name: 'Meteorite Fragment', points: 15,    items: [{ words: ['meteorite', 'fragment'] }] },
        { key: 'fossil',    name: 'Patagonian Fossil',  points: 20,    items: [{ words: ['patagonian', 'fossil'] }] },
        { key: 'arrowheads', name: 'Arrowhead Set',     points: 25,    items: [
            { words: ['obsidian', 'point'] }, { words: ['quartz', 'point'] }, { words: ['basalt', 'point'] },
            { words: ['chert', 'point'] }, { words: ['chalcedony', 'point'] }, { words: ['quartzite', 'point'] }] },
        { key: 'coins',     name: 'Medieval Coins',     points: 100,   items: [
            { words: ['leopard', 'coin'] }, { words: ['florin', 'coin'] }, { words: ['gold', 'noble', 'coin'] }] },
        { key: 'buddha',    name: 'Vairocana Buddha',   points: 100,   items: [{ words: ['vairocana'] }] },
        { key: 'ganesha',   name: 'Ganesha Sculpture',  points: 250,   items: [{ words: ['ganesha'] }] },
        { key: 'shabti',    name: 'Shabti Sculpture',   points: 500,   items: [{ words: ['shabti'] }] },
        { key: 'scripts',   name: 'Companion Scripts',  points: 1000,  items: [
            { words: ['script', 'abdullah'] }, { words: ['script', 'ali'] }, { words: ['script', 'ubay'] }] },
        { key: 'senet',     name: 'Senet Game',         points: 2000,  items: [
            { words: ['senet', 'board'] }, { words: ['white', 'senet'], qty: 5 }, { words: ['black', 'senet'], qty: 5 }] },
        { key: 'amulet',    name: 'Egyptian Amulet',    points: 10000, items: [{ words: ['egyptian', 'amulet'] }] },
    ];
    const GROUPS = [
        { key: 'flowers',   label: '🌸 Flowers',   cat: 'Flower',   unit: 'Flower',
          sets: [{ key: 'flowers', name: 'Exotic Flower Set', points: 10, items: FLOWERS }] },
        { key: 'plushies',  label: '🧸 Plushies',  cat: 'Plushie',  unit: 'Plushie',
          sets: [{ key: 'plushies', name: 'Plushie Set', points: 10, items: PLUSHIES }] },
        { key: 'artifacts', label: '🏺 Artifacts', cat: 'Artifact', unit: 'Piece', sets: ARTIFACT_SETS },
    ];
    const groupOf = (key) => GROUPS.find((g) => g.key === key) || GROUPS[0];

    const DEFAULT_PREFS = { group: 'flowers', artifactSet: 'coins', showPrices: true, museumDay: false,
        targets: { flowers: 10, plushies: 10, artifacts: 1 } };

    // ------------------------------------------------------------ storage
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    const loadPrefs = () => {
        let p = {};
        try { p = JSON.parse(lsGet(LS_PREFS) || '{}') || {}; } catch (e) {}
        const out = Object.assign({}, DEFAULT_PREFS, p);
        out.targets = Object.assign({}, DEFAULT_PREFS.targets, p.targets);
        // Flower Set Helper kept a single `target`.
        if (p.target && !(p.targets && p.targets.flowers)) out.targets.flowers = Number(p.target) || 10;
        delete out.target;
        return out;
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
    const marketUrl = (f, cat) => `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${f.id}` +
        `&itemName=${encodeURIComponent(f.name)}&itemType=${encodeURIComponent(cat)}`;

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
            resp = await fetch(`https://api.torn.com/v2/${path}${sep}key=${encodeURIComponent(key)}&comment=MuseumSetHelper`);
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

    // Counts for one category from the v2 inventory (cached by Torn for up to
    // 1 hour per category). Every item of the category is kept, so artifact
    // IDs don't need to be known yet.
    async function fetchInventory(cat, key) {
        const data = await api(`user/inventory?cat=${encodeURIComponent(cat)}&limit=250`, key);
        const inv = data.inventory || {};
        const counts = {};
        (inv.items || []).forEach((it) => {
            if (it.faction_owned || it.id == null) return;
            counts[it.id] = (counts[it.id] || 0) + (Number(it.amount) || 0);
        });
        return { counts, timestamp: inv.timestamp || 0 };
    }

    // Artifact item IDs, matched by name from torn/items (public data), cached a week.
    const tokens = (name) => String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    function cachedArtifactIds() {
        try {
            const c = JSON.parse(lsGet(LS_ARTIFACTS) || 'null');
            return c && c.ts && Date.now() - c.ts < ARTIFACT_IDS_TTL_MS ? c.items : null;
        } catch (e) { return null; }
    }
    async function loadArtifactIds(key) {
        const cached = cachedArtifactIds();
        if (cached) return cached;
        const data = await api('torn/items?cat=Artifact', key);
        const items = (data.items || []).map((it) => ({ id: Number(it.id), name: String(it.name || '') }))
            .filter((it) => it.id > 0 && it.name);
        if (items.length) lsSet(LS_ARTIFACTS, JSON.stringify({ ts: Date.now(), items }));
        return items;
    }
    // Resolve a set's pieces to { id, name, qty } (id null if no item matched).
    function resolveSet(set, artifactItems) {
        return set.items.map((piece) => {
            if (piece.id) return Object.assign({ qty: 1 }, piece);
            const hit = (artifactItems || []).find((it) => {
                const t = tokens(it.name);
                return piece.words.every((w) => t.includes(w));
            });
            const name = hit ? hit.name : piece.words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
            return { id: hit ? hit.id : null, name, qty: piece.qty || 1 };
        });
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
        #tfs-overlay .tfs-controls #tfs-refresh { margin-left: auto; }
        #tfs-overlay .tfs-btn.tfs-btn2 { background: var(--tfs-bg2); color: var(--tfs-fg) !important;
            border: 1px solid var(--tfs-accent); }
        /* Items page: point at the Flowers tab after "Live counts" */
        @keyframes tfs-glow { 0%, 100% { box-shadow: 0 0 0 2px #e05aa0; } 50% { box-shadow: 0 0 0 5px rgba(224,90,160,.35); } }
        [data-tfs-hint] { animation: tfs-glow 1.1s ease-in-out infinite; border-radius: 6px; position: relative; z-index: 2; }
        #tfs-hintbar { position: fixed; left: 50%; top: 70px; transform: translateX(-50%); z-index: 2147483646;
            padding: 9px 14px; border-radius: 20px; font: 700 13px Arial, Helvetica, sans-serif; white-space: nowrap;
            background: var(--tfs-bg); color: var(--tfs-fg); border: 1px solid var(--tfs-accent);
            box-shadow: 0 6px 20px var(--tfs-shadow); }
        #tfs-overlay .tfs-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
        #tfs-overlay .tfs-tabs button { flex: 1; padding: 7px 4px; font-size: 13px; font-weight: 700; cursor: pointer;
            border-radius: 7px; background: var(--tfs-bg2); color: var(--tfs-fg); border: 1px solid var(--tfs-border); }
        #tfs-overlay .tfs-tabs button.active { background: var(--tfs-accent); color: var(--tfs-accent-fg); border-color: var(--tfs-accent); }
        #tfs-overlay select#tfs-set { width: 100%; box-sizing: border-box; margin-bottom: 10px; padding: 7px 8px; font-size: 13px;
            border-radius: 6px; background: var(--tfs-bg2); color: var(--tfs-fg); border: 1px solid var(--tfs-border); }
        #tfs-overlay .tfs-qty { font-size: 11px; font-weight: 700; color: var(--tfs-muted) !important; }
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
        ['Data storage', 'Only locally: your key, targets, a 10-minute price cache and the artifact item list stay in this browser.'],
        ['Data sharing', 'Nobody. Requests go only to api.torn.com.'],
        ['Purpose of use', 'Personal gain: planning museum sets.'],
        ['Key storage & sharing', 'Stored locally on this device. Not shared.'],
        ['Key access level', 'Minimal (user → inventory). Item list and market prices use public data.'],
    ];

    let overlay = null;
    function closePanel() { if (overlay) { overlay.remove(); overlay = null; } }

    function openPanel() {
        if (overlay) return;
        injectStyles();
        overlay = document.createElement('div');
        overlay.id = 'tfs-overlay';
        overlay.innerHTML = `
            <div class="tfs-card" role="dialog" aria-label="Museum Set Helper">
                <button class="tfs-close" title="Close">&times;</button>
                <div class="tfs-head"><h2>🏛️ Museum Sets <span class="tfs-ver">v${VERSION}</span></h2></div>
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
                const g = groupOf(prefs.group);
                lastInv[g.key] = await fetchInventory(g.cat, key);
                lastInvAt[g.key] = Date.now();
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
        const g = groupOf(prefs.group);
        const target = Number(prefs.targets[g.key]) || 1;
        const setPicker = g.sets.length > 1 ? `
            <select id="tfs-set">${g.sets.map((st) =>
                `<option value="${st.key}" ${st.key === prefs.artifactSet ? 'selected' : ''}>${esc(st.name)} · ${st.points.toLocaleString('en-US')} pts</option>`).join('')}
            </select>` : '';
        b.innerHTML = `
            <div class="tfs-tabs">${GROUPS.map((x) =>
                `<button type="button" data-group="${x.key}" class="${x.key === g.key ? 'active' : ''}">${x.label}</button>`).join('')}</div>
            ${setPicker}
            <div class="tfs-controls">
                <label>Target sets <input type="number" id="tfs-target" min="1" step="1" value="${target}"></label>
                <label><input type="checkbox" id="tfs-prices" ${prefs.showPrices ? 'checked' : ''}> Prices</label>
                <label title="Museum Day event: 10% more points"><input type="checkbox" id="tfs-mday" ${prefs.museumDay ? 'checked' : ''}> Museum Day</label>
                <button class="tfs-btn" id="tfs-refresh">Refresh</button>
                <button class="tfs-btn tfs-btn2" id="tfs-live" title="Read your live ${g.cat.toLowerCase()} counts now (one request, only when you tap)">Live counts</button>
            </div>
            <div id="tfs-out"><div class="tfs-msg">Loading…</div></div>`;
        const targetEl = b.querySelector('#tfs-target');
        const prices = b.querySelector('#tfs-prices');
        const mday = b.querySelector('#tfs-mday');
        const onChange = () => {
            const t = Math.max(1, parseInt(targetEl.value, 10) || 1);
            prefs = Object.assign({}, prefs, { showPrices: prices.checked, museumDay: mday.checked,
                targets: Object.assign({}, prefs.targets, { [g.key]: t }) });
            savePrefs(prefs);
            refresh(false);
        };
        targetEl.addEventListener('change', onChange);
        prices.addEventListener('change', onChange);
        mday.addEventListener('change', onChange);
        b.querySelectorAll('.tfs-tabs button').forEach((btn) => btn.addEventListener('click', () => {
            const k = btn.getAttribute('data-group');
            if (k === prefs.group) return;
            prefs = Object.assign({}, prefs, { group: k });
            savePrefs(prefs);
            renderMain();
        }));
        const picker = b.querySelector('#tfs-set');
        if (picker) picker.addEventListener('change', () => {
            prefs = Object.assign({}, prefs, { artifactSet: picker.value });
            savePrefs(prefs);
            refresh(false);
        });
        b.querySelector('#tfs-refresh').addEventListener('click', () => refresh(true));
        b.querySelector('#tfs-live').addEventListener('click', goLiveCounts);
        refresh(false);
    }

    const lastInv = {};          // group -> { counts, timestamp }; reused when only the target changes
    const lastInvAt = {};        // group -> when we last fetched it (ms)
    let refreshToken = 0;        // drops results of superseded refreshes
    let artifactsRefetched = false;

    // The set shown in the current tab.
    function currentSet(g) {
        return g.sets.length > 1 ? (g.sets.find((st) => st.key === prefs.artifactSet) || g.sets[0]) : g.sets[0];
    }

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
            const g = groupOf(prefs.group);
            if (!lastInv[g.key] || (force && Date.now() - (lastInvAt[g.key] || 0) >= INV_MIN_AGE_MS)) {
                lastInv[g.key] = await fetchInventory(g.cat, key);
                lastInvAt[g.key] = Date.now();
            }
            let artifactItems = g.key === 'artifacts' ? await loadArtifactIds(key) : null;
            const set = currentSet(g);
            // A piece with no matching item: the cached list may be stale, so
            // re-read it once per page load before reporting it as missing.
            if (artifactItems && !artifactsRefetched && resolveSet(set, artifactItems).some((f) => !f.id)) {
                artifactsRefetched = true;
                lsDel(LS_ARTIFACTS);
                artifactItems = await loadArtifactIds(key);
            }
            if (token !== refreshToken) return;
            const target = Math.max(1, Number(prefs.targets[g.key]) || 1);
            const inv = currentInventory(g.key);
            const rows = resolveSet(set, artifactItems).map((f) => {
                const have = f.id ? (inv.counts[f.id] || 0) : 0;
                return { f, have, missing: Math.max(0, target * f.qty - have) };
            });
            const sets = Math.min(...rows.map((r) => Math.floor(r.have / r.f.qty)));
            const ctx = { g, set, target };
            renderTable(out, rows, sets, ctx, null);

            if (prefs.showPrices) {
                let total = 0, partial = false;
                let fullSet = 0, fullPartial = false;
                for (const r of rows) {
                    if (token !== refreshToken) return;
                    if (!r.f.id) { r.cheapest = null; r.cost = 0; r.setCost = null; continue; }
                    const cached = priceCache()[r.f.id];
                    const wasCached = cached && Date.now() - cached.ts < priceTtl;
                    const listings = await fetchListings(r.f.id, key, priceTtl);
                    const c = costFor(listings, r.missing);
                    r.cheapest = c.cheapest;
                    r.cost = r.missing ? c.cost : 0;
                    r.partial = r.missing > 0 && c.partial;
                    total += r.cost;
                    partial = partial || r.partial;
                    // One full set's worth of this piece (Senet pawns come in fives).
                    const one = costFor(listings, r.f.qty);
                    r.setCost = listings.length ? one.cost : null;
                    fullPartial = fullPartial || one.partial;
                    if (token !== refreshToken) return;
                    renderTable(out, rows, sets, ctx, { total, partial });
                    if (!wasCached) await sleep(REQUEST_GAP_MS);
                }
                // Points side of the trade: what a set is worth at the museum.
                const pointPrice = await fetchPointPrice(key, priceTtl);
                if (token !== refreshToken) return;
                fullSet = rows.every((r) => r.setCost != null) ? rows.reduce((s, r) => s + r.setCost, 0) : null;
                renderTable(out, rows, sets, ctx, { total, partial, pointPrice, fullSet, fullPartial });
            }
        } catch (e) {
            if (token !== refreshToken) return;
            if (e.code === 2) { lsDel(LS_KEY); Object.keys(lastInv).forEach((k) => delete lastInv[k]); renderKeySetup(e.message); return; }
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

    // Points one set is worth right now (Museum Day adds 10%).
    const setPoints = (set) => Math.round(set.points * (prefs.museumDay ? MUSEUM_DAY_BONUS : 1));

    // Profit / loss of turning items into museum points.
    function pointsBlock(cost, ctx) {
        if (!cost || cost.pointPrice === undefined) {
            return '<div class="tfs-points"><div class="tfs-msg">Points price loading…</div></div>';
        }
        if (cost.pointPrice == null) {
            return '<div class="tfs-points"><div class="tfs-msg">No points-market listings found.</div></div>';
        }
        const pts = setPoints(ctx.set);
        const setValue = pts * cost.pointPrice;
        const signed = (n, approx) => `<b class="${n >= 0 ? 'tfs-pos' : 'tfs-neg'}">${approx}${n >= 0 ? '+' : '−'}${money(Math.abs(n))}</b>`;
        // Owned items count as free here: this is the return on the cash you'd spend.
        const profit = ctx.target * setValue - cost.total;
        // A "+" total means listings ran out, so the real cost is higher and profit lower.
        const approx = cost.partial ? '≤ ' : '';
        const perSet = cost.fullSet != null ? setValue - cost.fullSet : null;
        return `
            <div class="tfs-points">
                <div class="tfs-prow"><span>Point price</span><b>${money(cost.pointPrice)}</b></div>
                <div class="tfs-prow"><span>Set value (${pts.toLocaleString('en-US')} pts${prefs.museumDay ? ', Museum Day' : ''})</span><b>${money(setValue)}</b></div>
                <div class="tfs-prow"><span>Market set cost</span><b>${cost.fullSet != null ? money(cost.fullSet) + (cost.fullPartial ? '+' : '') : '—'}</b></div>
                <div class="tfs-prow"><span>Buy a full set &amp; exchange</span>${perSet != null ? signed(perSet, cost.fullPartial ? '≤ ' : '') + '<i>per set</i>' : '<b>—</b>'}</div>
                <div class="tfs-prow tfs-big"><span>Profit to ${ctx.target} set${ctx.target === 1 ? '' : 's'}<i>buying only what's missing</i></span>${signed(profit, approx)}</div>
            </div>`;
    }

    function renderTable(out, rows, sets, ctx, cost) {
        const { g, target } = ctx;
        const missingTotal = rows.reduce((s, r) => s + r.missing, 0);
        const showPrices = !!prefs.showPrices;
        const costCell = cost ? money(cost.total) + (cost.partial ? '+' : '') : (showPrices ? '…' : '—');
        const unknown = rows.filter((r) => !r.f.id);
        out.innerHTML = `
            <div class="tfs-summary">
                <div class="tfs-stat"><b>${sets}</b><span>Complete sets</span></div>
                <div class="tfs-stat"><b>${missingTotal}</b><span>${g.unit}s missing</span></div>
                <div class="tfs-stat"><b>${showPrices ? costCell : '—'}</b><span>Cost to ${target}</span></div>
            </div>
            ${showPrices ? pointsBlock(cost, ctx) : ''}
            <table class="tfs-table">
                <tr><th>${g.unit}</th><th class="num">Have</th><th class="num">Need</th>
                    ${showPrices ? '<th class="num">Cheapest</th><th class="num">Cost</th>' : ''}</tr>
                ${rows.map((r) => `
                    <tr class="${r.missing ? 'low' : 'ok'}">
                        <td>${r.f.id ? `<a href="${marketUrl(r.f, g.cat)}">${esc(r.f.name)}</a>` : esc(r.f.name)}${r.f.qty > 1 ? ` <span class="tfs-qty">×${r.f.qty}</span>` : ''}${r.f.country ? `<span class="country">${esc(r.f.country)}</span>` : ''}</td>
                        <td class="num">${r.have}</td>
                        <td class="num">${r.missing ? `<span class="tfs-miss">${r.missing}</span>` : '<span class="tfs-okmark">✓</span>'}</td>
                        ${showPrices ? `<td class="num">${r.cheapest === undefined ? '…' : money(r.cheapest)}</td>
                            <td class="num">${r.cost === undefined ? '…' : r.missing ? money(r.cost) + (r.partial ? '+' : '') : '—'}</td>` : ''}
                    </tr>`).join('')}
            </table>
            ${unknown.length ? `<div class="tfs-msg err" style="margin-top:8px">Not found in Torn's item list: ${unknown.map((r) => esc(r.f.name)).join(', ')}.</div>` : ''}
            <div class="tfs-note">
                ${(() => {
                    const inv = currentInventory(g.key);
                    return inv.source === 'page'
                        ? `Live counts from your Items, read ${ago(inv.timestamp) || 'just now'}.`
                        : `Inventory from the API, updated ${ago(inv.timestamp) || 'recently'} — Torn caches it for up to an hour.
                           Tap <b>Live counts</b> for up-to-the-second numbers.`;
                })()}
                Items in your display case aren't counted.
                ${showPrices ? 'Costs walk the cheapest item-market listings; "+" means the listings shown didn\'t cover the full amount.' : ''}
            </div>`;
    }

    // ------------------------------------------------------------ live counts from the Items page
    // When you open Items → Flowers (or Plushies / Artifacts), Torn's page
    // itself loads that tab with an item.php "getCategoryList" request whose
    // answer has the live Qty of every item in it. We only listen to that
    // response — no extra request is made — and use it whenever it's newer
    // than the (up to 1 h cached) API data.
    const catRe = (cat) => new RegExp(`^${cat}s?$`, 'i');
    const groupForCat = (name) => GROUPS.find((g) => catRe(g.cat).test(String(name || ''))) || null;

    function pageSnapshot(groupKey) {
        try {
            const all = JSON.parse(lsGet(LS_PAGEINV) || '{}') || {};
            const p = all[groupKey];
            return p && p.counts && p.ts ? p : null;
        } catch (e) { return null; }
    }
    function savePageSnapshot(groupKey, counts) {
        let all = {};
        try { all = JSON.parse(lsGet(LS_PAGEINV) || '{}') || {}; } catch (e) {}
        all[groupKey] = { counts, ts: Date.now() };
        lsSet(LS_PAGEINV, JSON.stringify(all));
    }
    // Newest of: API inventory (timestamp in s) and the Items-page snapshot (ms).
    function currentInventory(groupKey) {
        const page = pageSnapshot(groupKey);
        const api = lastInv[groupKey];
        const apiTs = api ? api.timestamp : 0;
        if (page && (!api || page.ts / 1000 > apiTs)) {
            return { counts: page.counts, timestamp: Math.floor(page.ts / 1000), source: 'page' };
        }
        return { counts: api ? api.counts : {}, timestamp: apiTs, source: 'api' };
    }

    // Parse an item.php getCategoryList answer into { itemID: qty } (null if it isn't one).
    function parseCategoryList(text) {
        let data;
        try { data = JSON.parse(text); } catch (e) { return null; }
        const list = data && Array.isArray(data.list) ? data.list : null;
        if (!list) return null;
        const counts = {};
        list.forEach((it) => {
            if (it.factionItem) return;
            // `itemID` is the item type; fall back to `ID` if that's absent.
            const id = Number(it.itemID != null ? it.itemID : it.ID);
            if (id > 0) counts[id] = (counts[id] || 0) + (Number(it.Qty) || 0);
        });
        return counts;
    }
    function captureCategoryList(text, cat) {
        const g = groupForCat(cat);
        const counts = g && parseCategoryList(text);
        if (!counts) return;
        savePageSnapshot(g.key, counts);
        const req = liveRequest();
        if (req && req.group === g.key) {
            // Came here via "Live counts": show the fresh numbers straight away.
            lsDel(LS_LIVE);
            clearHint();
            prefs = Object.assign({}, prefs, { group: g.key });
            savePrefs(prefs);
            if (overlay) closePanel();
            openPanel();
        } else if (overlay && overlay.querySelector('#tfs-out') && prefs.group === g.key) {
            refresh(false);   // live update if the panel is open on that tab
        }
    }

    // "Live counts" fallback: take the user to their Items page and point at
    // the right tab. The user taps it; we never click anything ourselves.
    const LS_LIVE = 'tms_live_request';
    const LIVE_WINDOW_MS = 5 * 60 * 1000;
    const onItemsPage = () => /\/item\.php$/i.test(location.pathname);
    function liveRequest() {
        try {
            const r = JSON.parse(lsGet(LS_LIVE) || 'null');
            return r && r.ts && Date.now() - r.ts < LIVE_WINDOW_MS ? r : null;
        } catch (e) { return null; }
    }
    // "Live counts" button. Torn's rules allow a non-API request only when it is
    // directly and manually initiated by the user, so this makes exactly ONE
    // request per tap — for the open tab's category only — (the same one Torn's
    // Items page makes for that tab, the way TornTools' quick items do it),
    // never on its own, with a cooldown against repeated taps. If that fails,
    // fall back to sending the user to the Items page to tap the tab themselves.
    const LIVE_COOLDOWN_MS = 15 * 1000;
    let lastLiveAt = 0;
    const rfcToken = () => {
        const m = document.cookie.match(/(?:^|;\s*)rfc_v=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    };
    async function fetchLiveCounts(cat) {
        const rfc = rfcToken();
        if (!rfc) return null;
        try {
            const resp = await fetch(`https://www.torn.com/item.php?rfcv=${encodeURIComponent(rfc)}`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'x-requested-with': 'XMLHttpRequest' },
                body: new URLSearchParams({ step: 'getCategoryList', itemName: cat, start: '0' }),
            });
            return parseCategoryList(await resp.text());
        } catch (e) { return null; }
    }
    async function goLiveCounts() {
        const g = groupOf(prefs.group);
        const btn = overlay && overlay.querySelector('#tfs-live');
        if (Date.now() - lastLiveAt < LIVE_COOLDOWN_MS) return;
        lastLiveAt = Date.now();
        if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
        const counts = await fetchLiveCounts(g.cat);
        if (counts) {
            savePageSnapshot(g.key, counts);
            if (overlay) refresh(false);
            // Re-enable after the cooldown.
            setTimeout(() => {
                const b = overlay && overlay.querySelector('#tfs-live');
                if (b) { b.disabled = false; b.textContent = 'Live counts'; }
            }, Math.max(0, LIVE_COOLDOWN_MS - (Date.now() - lastLiveAt)));
            if (btn && btn.isConnected) btn.textContent = 'Updated ✓';
            return;
        }
        // Fallback: let the user open the tab themselves.
        lsSet(LS_LIVE, JSON.stringify({ group: g.key, ts: Date.now() }));
        if (onItemsPage()) { closePanel(); showHint(); return; }
        location.href = 'https://www.torn.com/item.php';
    }
    let hintTimer = null;
    function showHint() {
        const req = liveRequest();
        const g = groupOf(req && req.group);
        injectStyles();
        if (!document.getElementById('tfs-hintbar')) {
            const bar = document.createElement('div');
            bar.id = 'tfs-hintbar';
            bar.textContent = `${g.label.split(' ')[0]} Tap the ${g.label.split(' ').slice(1).join(' ')} tab to update your counts`;
            (document.body || document.documentElement).appendChild(bar);
        }
        let tries = 0;
        clearInterval(hintTimer);
        hintTimer = setInterval(() => {   // the tab list may render after us
            const tab = [...document.querySelectorAll('#categoriesList > li')]
                .find((li) => catRe(g.cat).test(li.getAttribute('data-type') || ''));
            if (tab) { tab.setAttribute('data-tfs-hint', ''); clearInterval(hintTimer); }
            if (++tries > 40) clearInterval(hintTimer);
        }, 250);
        // Stop nagging after the request window.
        setTimeout(clearHint, LIVE_WINDOW_MS);
    }
    function clearHint() {
        clearInterval(hintTimer);
        const bar = document.getElementById('tfs-hintbar');
        if (bar) bar.remove();
        document.querySelectorAll('[data-tfs-hint]').forEach((el) => el.removeAttribute('data-tfs-hint'));
    }

    function hookItemsPage() {
        if (!/\/item\.php$/i.test(location.pathname)) return;
        const X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (!X || X.__tfsHooked) return;
        X.__tfsHooked = true;
        const open = X.open, send = X.send;
        X.open = function (method, url) {
            this.__tfsUrl = String(url || '');
            return open.apply(this, arguments);
        };
        X.send = function (body) {
            try {
                let params = null;
                if (typeof body === 'string') params = new URLSearchParams(body);
                else if (body && typeof body.get === 'function') params = body;   // URLSearchParams / FormData
                const cat = params && String(params.get('itemName') || '');
                if (params && /item\.php/i.test(this.__tfsUrl) && params.get('step') === 'getCategoryList' && groupForCat(cat)) {
                    this.addEventListener('load', () => captureCategoryList(this.responseText, cat));
                }
            } catch (e) { /* never break Torn's own request */ }
            return send.apply(this, arguments);
        };
    }

    // ------------------------------------------------------------ entry button
    // Same anchor as the FF/BS Badges ⚙ and Bounty Hunter: Torn's footer
    // panel buttons. Falls back to a small floating button.
    // Museum: pediment, three columns and a base.
    const MUSEUM_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<g fill="#fff"><path d="M12 2.5 3 7.2v1.6h18V7.2z"/><rect x="5" y="10" width="2.6" height="7.5" rx=".4"/>' +
        '<rect x="10.7" y="10" width="2.6" height="7.5" rx=".4"/><rect x="16.4" y="10" width="2.6" height="7.5" rx=".4"/>' +
        '<rect x="3" y="18.6" width="18" height="2.4" rx=".4"/></g></svg>';

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
            b.title = 'Museum sets';
            b.setAttribute('data-tfs-btn', '');
            b.innerHTML = MUSEUM_SVG.replace('%CLS%', cls ? ` class="${cls}"` : '');
            b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(); });
            try { ref.parentNode.insertBefore(b, ref); if (floating) floating.remove(); return; } catch (e) { b.remove(); }
        } else if (inBar) {
            inBar.remove();
        }
        if (floating) return;
        const f = document.createElement('button');
        f.id = 'tfs-float';
        f.title = 'Museum sets';
        f.textContent = '🏛️';
        f.addEventListener('click', openPanel);
        (document.body || document.documentElement).appendChild(f);
    }

    hookItemsPage();   // installed right away so no tab load is missed
    if (onItemsPage() && liveRequest()) {
        if (document.body) showHint(); else document.addEventListener('DOMContentLoaded', showHint);
    }

    function start() {
        if (!document.body) return setTimeout(start, 300);
        injectStyles();
        mountButton();
        // Torn's SPA re-renders the footer; re-mount when our button goes missing.
        let pending = false;
        // Idle in background tabs (Torn PDA keeps them running); catch up on return.
        new MutationObserver(() => {
            if (pending || document.hidden) return;
            pending = true;
            setTimeout(() => {
                pending = false;
                const ref = document.getElementById('notes_panel_button') || document.getElementById('people_panel_button');
                const ok = ref ? !!document.querySelector('[data-tfs-btn]') : !!document.getElementById('tfs-float');
                if (!ok) mountButton();
            }, 300);
        }).observe(document.body, { childList: true, subtree: true });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) mountButton(); });
    }

    start();
})();
