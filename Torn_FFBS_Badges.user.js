// ==UserScript==
// @name         Torn FF/BS Badges
// @namespace    https://github.com/tornffbs
// @version      2.5.0
// @description  Shows FairFight + estimated Battle Stat badges next to player names on Torn. On faction pages it also adds a live hospital countdown and travel info, can rewrite the member-list Status column with live timers, and can sort/filter the member list. Includes an in-page settings panel (⚙). Works on Torn PDA and desktop Tampermonkey.
// @author       Nebigoktug
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      ffscouter.com
// @connect      api.torn.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_FFBS_Badges.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_FFBS_Badges.user.js
// ==/UserScript==

(function () {
    'use strict';

    // Hard host guard. Torn PDA may inject userscripts on any site whose URL
    // merely contains "torn", ignoring @match — bail out unless this is the
    // real game site (also skips api.torn.com and other subdomains).
    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;

    /* =======================================================================
     * CONFIG DEFAULTS  — user-overridable ones live in SETTINGS (⚙ panel)
     * ===================================================================== */
    const VERSION        = '2.5.0';           // keep in sync with @version
    const REPO_URL       = 'https://github.com/nebigoktug/torn-userscripts';
    const LS_KEY         = 'ffbs_api_key';    // where the key is stored locally
    const LS_SETTINGS    = 'ffbs_settings';   // where the ⚙ panel settings live
    const LS_STATS       = 'ffbs_stats_cache';// persistent FFScouter cache
    const LS_OWN_BS      = 'ffbs_own_bs';     // cached own battle-stat total
    const LS_CACHE_OWNER = 'ffbs_cache_owner';// hash of the key the caches belong to
    const FALLBACK_SCAN_INTERVAL = 10000;     // safety re-scan; MutationObserver does the real work
    const SCAN_DEBOUNCE_MS = 250;             // coalesce bursts of DOM mutations
    const BATCH_SIZE     = 200;               // FFScouter targets per request (max 205)
    const RATELIMIT_MS   = 8000;              // backoff after a 429
    const TEMP_BACKOFF_MS = 10000;            // backoff after a network/5xx/bad-JSON error
    const BADGE_ATTR     = 'data-ffbs';       // marks a decorated player link

    const FACTION_FETCH_INTERVAL   = 60000;   // refresh faction status, ms
    const TIMER_TICK_INTERVAL      = 1000;    // redraw countdowns, ms
    const OWN_STATS_RETRY_INTERVAL = 15000;   // retry own battle stats if it failed, ms
    const OWN_STATS_TTL_MS         = 86400000; // re-fetch own battle stats once a day
    const STATS_CACHE_MAX          = 20000;   // max players kept in the persistent cache
    const STATS_SAVE_DEBOUNCE_MS   = 2000;

    // -------- User-configurable settings (defaults). Overridden by ⚙ panel. -----
    const SETTINGS_DEFAULTS = {
        // Feature toggles
        SHOW_NAME_TIMER_BADGE: true,   // hospital/travel pill on the avatar corner
        ENHANCE_STATUS_CELL:   true,   // rewrite the faction "Status" column
        SKIP_CHAT:             true,   // don't badge names inside the chat box
        HIDE_WHEN_NO_DATA:     true,   // draw nothing (not "?") when FF & BS unknown
        SORT_TOOLBAR:          true,   // sort/filter bar above faction member lists
        HIDE_OWN_FACTION:      true,   // no FF/BS badges on your own faction members
        DEBUG:                 false,  // verbose console logging
        // Appearance
        BADGE_STYLE: 'classic',        // classic | solid | bright
        BADGE_SIZE:  's',              // s | m | l
        THEME:       'auto',           // auto (follow Torn) | dark | light
        // Cache
        CACHE_HOURS: 72,               // how long FFScouter data is reused before refetch
        // Hospital: highlight when this many seconds (or fewer) remain
        HOSP_ALERT_SEC: 60,
        // FF colour thresholds
        FF_GREEN:  1.5,
        FF_YELLOW: 2.25,
        FF_ORANGE: 3.0,
        // BS colour thresholds (multiples of your own total)
        BS_YELLOW: 1.10,
        BS_ORANGE: 1.25,
        // Faction list sort/filter state (set from the toolbar)
        LIST_SORT: 'default',          // default | ff | bs | hosp
        LIST_ONLY_OKAY: false,
    };

    // Active settings object — populated in loadSettings() before anything runs.
    let S = Object.assign({}, SETTINGS_DEFAULTS);

    function loadSettings() {
        try {
            const raw = localStorage.getItem(LS_SETTINGS);
            if (raw) {
                const parsed = JSON.parse(raw);
                // Only copy keys we recognise; ignore junk / old fields.
                Object.keys(SETTINGS_DEFAULTS).forEach((k) => {
                    if (parsed[k] !== undefined) S[k] = parsed[k];
                });
            }
        } catch (e) { /* fall back to defaults */ }
    }
    function saveSettings() {
        try { localStorage.setItem(LS_SETTINGS, JSON.stringify(S)); } catch (e) {}
    }
    function resetSettings() {
        S = Object.assign({}, SETTINGS_DEFAULTS);
        saveSettings();
    }
    function statsTtlMs() {
        const h = Number(S.CACHE_HOURS);
        return (isNaN(h) || h <= 0 ? SETTINGS_DEFAULTS.CACHE_HOURS : h) * 3600000;
    }

    function log(...args) {
        if (S.DEBUG) console.log('[FFBS]', ...args);
    }

    /* =======================================================================
     * KEY STORAGE
     * Desktop managers: GM storage (not readable by other scripts on the page).
     * Torn PDA: localStorage (PDA's GM storage support varies).
     * ===================================================================== */
    const useGM = typeof PDA_httpGet !== 'function' &&
                  typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    function keyGet() {
        if (useGM) {
            try {
                const v = GM_getValue(LS_KEY, null);
                if (typeof v === 'string' && v.trim()) return v.trim();
                // One-time migration from older versions that used localStorage.
                const old = localStorage.getItem(LS_KEY);
                if (old && old.trim()) {
                    GM_setValue(LS_KEY, old.trim());
                    localStorage.removeItem(LS_KEY);
                    return old.trim();
                }
                return null;
            } catch (e) { /* fall through to localStorage */ }
        }
        try { const v = localStorage.getItem(LS_KEY); return v && v.trim() ? v.trim() : null; } catch (e) { return null; }
    }
    // Short non-reversible fingerprint, so caches can be tied to a key
    // without storing the key itself next to them.
    function hashKey(key) {
        let h = 5381;
        for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }
    function keySet(key) {
        if (useGM) { try { GM_setValue(LS_KEY, key); return; } catch (e) {} }
        try { localStorage.setItem(LS_KEY, key); } catch (e) {}
    }
    function keyDel() {
        if (useGM) { try { (typeof GM_deleteValue === 'function') ? GM_deleteValue(LS_KEY) : GM_setValue(LS_KEY, null); } catch (e) {} }
        try { localStorage.removeItem(LS_KEY); } catch (e) {}
    }

    // States that get a countdown badge on the avatar (travel/abroad handled separately)
    const TIMER_STATES = ['Hospital'];

    // Containers whose player links should NOT get badges (chat clutters names)
    const SKIP_CONTAINERS = ['#chatRoot', '[class*="chat-box"]', '[id*="ChatBox"]'];

    // Country name (as it appears in a status description) -> short tag
    const COUNTRY_ABBR = {
        'Mexico': 'Mex', 'Cayman Islands': 'Cay', 'Canada': 'Can', 'Hawaii': 'Haw',
        'United Kingdom': 'UK', 'Argentina': 'Arg', 'Switzerland': 'Swi', 'Japan': 'Jpn',
        'China': 'Chn', 'United Arab Emirates': 'UAE', 'South Africa': 'SA'
    };
    const HOME_ABBR = 'TC'; // shown when returning to Torn

    /* =======================================================================
     * STATE
     * ===================================================================== */
    let API_KEY        = null;   // active key
    let myBattleStat   = null;   // own total BS (for BS colouring)
    let ownStatsGaveUp = false;  // true once error 16 (no access) seen
    const statsCache = new Map(); // pid -> { ff, bsHuman, bsRaw, ts }
    const pending    = new Set(); // pids queued for FFScouter lookup
    let fetching     = false;
    let pausedUntil  = 0;         // FFScouter ratelimit backoff until this ts
    let tornPausedUntil = 0;      // Torn API ratelimit backoff until this ts
    const TORN_BACKOFF_MS      = 15000; // back off 15s after a Torn 429
    const TORN_TEMP_BACKOFF_MS = 8000;  // back off 8s after a Torn 5xx/temp error

    const factionStatus = new Map(); // pid -> { state, until, description }
    let factionFetching  = false;
    let currentFactionKey = undefined; // which faction set we last fetched ("123,own")
    let ownFactionMembers = new Set();  // pids of your own faction (for HIDE_OWN_FACTION)

    const userStatus       = new Map(); // pid -> { state, until, description, ts }
    const pendingUserFetch = new Set();  // pids with an in-flight user fetch
    const USER_STATUS_TTL_MS = 120000;   // re-fetch a user's status after 2 min
    const userFetchQueue   = [];         // pids waiting for a user-status fetch
    const USER_FETCH_GAP_MS = 1500;      // min gap between user fetches (<= 40/min)
    let userQueueTimer     = null;

    let scanTimer = null, factionTimer = null, tickTimer = null, ownStatsTimer = null;
    let observer = null, scanDebounce = null;

    /* =======================================================================
     * PERSISTENT STATS CACHE  (localStorage, compact: pid -> [ff, bsRaw, bsHuman, ts])
     * ===================================================================== */
    let statsSaveTimer = null;
    function loadStatsCache() {
        try {
            const raw = localStorage.getItem(LS_STATS);
            if (!raw) return;
            const obj = JSON.parse(raw);
            const cutoff = Date.now() - statsTtlMs();
            Object.keys(obj).forEach((pid) => {
                const e = obj[pid];
                if (!Array.isArray(e) || !(e[3] > cutoff)) return;
                statsCache.set(pid, { ff: e[0], bsRaw: e[1], bsHuman: e[2], ts: e[3] });
            });
            log(`Loaded ${statsCache.size} cached player(s).`);
        } catch (e) { /* corrupt cache — start fresh */ }
    }
    function saveStatsCacheSoon() {
        if (statsSaveTimer) return;
        statsSaveTimer = setTimeout(() => {
            statsSaveTimer = null;
            try {
                const cutoff = Date.now() - statsTtlMs();
                let entries = Array.from(statsCache.entries()).filter(([, v]) => v.ts > cutoff);
                if (entries.length > STATS_CACHE_MAX) {
                    entries.sort((a, b) => b[1].ts - a[1].ts);
                    entries = entries.slice(0, STATS_CACHE_MAX);
                }
                const obj = {};
                entries.forEach(([pid, v]) => { obj[pid] = [v.ff, v.bsRaw, v.bsHuman, v.ts]; });
                localStorage.setItem(LS_STATS, JSON.stringify(obj));
            } catch (e) { log('Could not save stats cache.', e); }
        }, STATS_SAVE_DEBOUNCE_MS);
    }

    /* =======================================================================
     * HTTP LAYER  (Torn PDA + desktop Tampermonkey)
     * ===================================================================== */
    function httpGet(url) {
        return new Promise((resolve, reject) => {
            // Torn PDA
            if (typeof PDA_httpGet === 'function') {
                try {
                    PDA_httpGet(url).then(
                        (r) => resolve({
                            status: typeof r.status === 'number' ? r.status : 200,
                            text: r.responseText != null ? r.responseText : (r.response || '')
                        }),
                        (err) => reject(err)
                    );
                } catch (e) { reject(e); }
                return;
            }
            // Tampermonkey / Violentmonkey (classic GM_ API)
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET', url: url, timeout: 20000,
                    onload:  (r) => resolve({ status: r.status, text: r.responseText }),
                    onerror: (err) => reject(err),
                    ontimeout: () => reject('timeout')
                });
                return;
            }
            // Greasemonkey 4+ / newer managers (Promise-based GM.xmlHttpRequest)
            if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
                GM.xmlHttpRequest({
                    method: 'GET', url: url, timeout: 20000,
                    onload:  (r) => resolve({ status: r.status, text: r.responseText }),
                    onerror: (err) => reject(err),
                    ontimeout: () => reject('timeout')
                });
                return;
            }
            // Last resort: plain fetch (works only if the server allows CORS)
            if (typeof fetch === 'function') {
                fetch(url)
                    .then((r) => r.text().then((t) => resolve({ status: r.status, text: t })))
                    .catch(reject);
                return;
            }
            reject('No HTTP transport available');
        });
    }

    // Classify an HTTP outcome: ok | auth | ratelimit | temp. When unsure -> temp.
    function classify(status, body) {
        if (status === 200) return 'ok';
        if (status === 401 || status === 403) return 'auth';
        if (status === 429) return 'ratelimit';
        if (status >= 500) return 'temp';
        const l = (body || '').toLowerCase();
        if (l.includes('incorrect key') || l.includes('invalid key') ||
            l.includes('invalid api key') || l.includes('unauthorized') ||
            l.includes('sign up at ffscouter')) return 'auth';
        if (l.includes('rate limit') || l.includes('too many requests')) return 'ratelimit';
        return 'temp';
    }

    function handleTornBackoff(cat) {
        if (cat === 'ratelimit') {
            tornPausedUntil = Date.now() + TORN_BACKOFF_MS;
            log('Torn API rate-limited; backing off 15s.');
            return true;
        }
        if (cat === 'temp') {
            tornPausedUntil = Date.now() + TORN_TEMP_BACKOFF_MS;
            return true;
        }
        return false;
    }

    /* =======================================================================
     * FORMATTING & COLOUR TIERS
     * ===================================================================== */
    function compact(n) {
        const abs = Math.abs(n);
        for (const u of [{ v: 1e9, s: 'b' }, { v: 1e6, s: 'm' }, { v: 1e3, s: 'k' }]) {
            if (abs >= u.v) {
                const val = n / u.v;
                return (val >= 100 ? val.toFixed(0) : val.toFixed(1)).replace(/\.0$/, '') + u.s;
            }
        }
        return String(Math.round(n));
    }
    function formatFF(ff) {
        if (ff == null || isNaN(ff)) return '?';
        return Number(ff).toFixed(1).replace(/\.0$/, '');
    }
    function formatBS(bsHuman, bsRaw) {
        if (bsHuman) return String(bsHuman).replace(/\.0(?=[a-zA-Z])/g, '').replace(/\.0$/, '');
        if (bsRaw == null || isNaN(bsRaw)) return '?';
        return compact(bsRaw);
    }
    function formatDuration(total) {
        const t = Math.max(0, Math.floor(total));
        const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
        const pad = (x) => String(x).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }
    function ffTier(ff) {
        if (ff == null || isNaN(ff)) return 'ffbs-grey';
        if (ff < S.FF_GREEN)  return 'ffbs-green';
        if (ff < S.FF_YELLOW) return 'ffbs-yellow';
        if (ff < S.FF_ORANGE) return 'ffbs-orange';
        return 'ffbs-red';
    }
    function bsTier(bsRaw) {
        if (bsRaw == null || isNaN(bsRaw)) return 'ffbs-grey';
        if (myBattleStat == null)         return 'ffbs-grey';
        if (bsRaw <= myBattleStat)              return 'ffbs-green';
        if (bsRaw <= myBattleStat * S.BS_YELLOW)  return 'ffbs-yellow';
        if (bsRaw <= myBattleStat * S.BS_ORANGE)  return 'ffbs-orange';
        return 'ffbs-red';
    }
    function abbrOf(country) {
        if (!country) return '??';
        return COUNTRY_ABBR[country] || country.slice(0, 2).toUpperCase() || '??';
    }
    function parseTravel(status) {
        const d = (status.description || '').trim();
        let m;
        if ((m = d.match(/Traveling from (.+?) to (.+)$/i))) {
            const from = m[1].trim(), to = m[2].trim();
            if (/^torn$/i.test(to)) return { abbr: HOME_ABBR, direction: 'return', country: from };
            return { abbr: abbrOf(to), direction: 'out', country: to };
        }
        if ((m = d.match(/Abroad in (.+)$/i))) {
            const c = m[1].trim(); return { abbr: abbrOf(c), direction: 'abroad', country: c };
        }
        if ((m = d.match(/Returning to Torn from (.+)$/i)))
            return { abbr: HOME_ABBR, direction: 'return', country: m[1].trim() };
        if ((m = d.match(/Traveling to (.+)$/i))) {
            const c = m[1].trim(); return { abbr: abbrOf(c), direction: 'out', country: c };
        }
        if ((m = d.match(/^In (.+)$/i))) {
            const c = m[1].trim(); return { abbr: abbrOf(c), direction: 'abroad', country: c };
        }
        const low = d.toLowerCase();
        for (const name of Object.keys(COUNTRY_ABBR)) {
            if (low.includes(name.toLowerCase())) {
                if (/to torn/i.test(d)) return { abbr: HOME_ABBR, direction: 'return', country: name };
                return { abbr: COUNTRY_ABBR[name], direction: status.state === 'Abroad' ? 'abroad' : 'out', country: name };
            }
        }
        return { abbr: '??', direction: status.state === 'Abroad' ? 'abroad' : 'out', country: '' };
    }

    /* =======================================================================
     * BADGE STYLE / SIZE / THEME  (user-selectable; applied as attributes on
     * <html>, so switching is instant and needs no badge re-render)
     * ===================================================================== */
    const BADGE_STYLES = {
        classic: { label: 'Classic', css: 'background-color: var(--ffbs-f); color: #fff; border-color: var(--ffbs-c);' +
            'text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;' },
        solid:   { label: 'Solid dark', css: 'background-color: rgba(18,20,24,0.92); color: var(--ffbs-c);' +
            'border-color: var(--ffbs-c); text-shadow: none;' },
        bright:  { label: 'Bright', css: 'background-color: var(--ffbs-c); color: #111; border-color: rgba(0,0,0,0.45);' +
            'text-shadow: none;' },
    };
    const BADGE_SIZES = {
        s: { label: 'Small',  fs: 9,    ff: 16, bsW: 18, bsH: 17, off: -7 },
        m: { label: 'Medium', fs: 10.5, ff: 19, bsW: 21, bsH: 20, off: -8 },
        l: { label: 'Large',  fs: 12,   ff: 22, bsW: 24, bsH: 23, off: -9 },
    };
    const THEMES = { auto: 'Auto (follow Torn)', dark: 'Dark', light: 'Light' };

    // Rules for every style/size, once for the page (<html data-ffbs-style>)
    // and once for the settings preview (higher specificity via #ffbs-config).
    function badgeStyleCss() {
        const scopes = (attr, key) => [`html[data-ffbs-${attr}="${key}"]`, `#ffbs-config [data-ffbs-p${attr}="${key}"]`];
        let css = '';
        Object.keys(BADGE_STYLES).forEach((k) => {
            scopes('style', k).forEach((sc) => {
                css += `${sc} .ffbs-ff, ${sc} .ffbs-bs { ${BADGE_STYLES[k].css} }\n`;
            });
        });
        Object.keys(BADGE_SIZES).forEach((k) => {
            const z = BADGE_SIZES[k];
            scopes('size', k).forEach((sc) => {
                css += `${sc} .ffbs-ff { font-size: ${z.fs}px; min-width: ${z.ff}px; height: ${z.ff}px; top: ${z.off}px; right: ${z.off}px; }\n`;
                css += `${sc} .ffbs-bs { font-size: ${z.fs}px; min-width: ${z.bsW}px; height: ${z.bsH}px; bottom: ${z.off}px; right: ${z.off}px; }\n`;
            });
        });
        return css;
    }
    function applyDisplayPrefs() {
        const root = document.documentElement;
        root.setAttribute('data-ffbs-style', BADGE_STYLES[S.BADGE_STYLE] ? S.BADGE_STYLE : 'classic');
        root.setAttribute('data-ffbs-size', BADGE_SIZES[S.BADGE_SIZE] ? S.BADGE_SIZE : 's');
        if (S.THEME === 'dark' || S.THEME === 'light') root.setAttribute('data-ffbs-theme', S.THEME);
        else root.removeAttribute('data-ffbs-theme');
    }

    let toastTimer = null;
    function toast(msg, isErr) {
        let el = document.getElementById('ffbs-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ffbs-toast';
            (document.body || document.documentElement).appendChild(el);
        }
        el.textContent = msg;
        el.classList.toggle('err', !!isErr);
        // Force a reflow so re-showing restarts the transition.
        void el.offsetWidth;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
    }

    /* =======================================================================
     * STYLES
     * ===================================================================== */
    function injectStyles() {
        if (document.getElementById('ffbs-styles')) return;
        const style = document.createElement('style');
        style.id = 'ffbs-styles';
        style.textContent = `
        /* ---- theme tokens: dark by default, light when Torn is in light
           mode (body without .dark-mode), or forced via the THEME setting ---- */
        :root {
            --ffbs-bg: #1f2227; --ffbs-bg2: #15171b; --ffbs-fg: #eee; --ffbs-muted: #9aa0a6;
            --ffbs-border: #3a3f47; --ffbs-hover: #2c3037; --ffbs-accent: #2ecc40;
            --ffbs-accent-fg: #0a0a0a; --ffbs-link: #4aa3ff; --ffbs-shadow: rgba(0,0,0,0.6);
        }
        body:not(.dark-mode), html[data-ffbs-theme="light"] body {
            --ffbs-bg: #ffffff; --ffbs-bg2: #f1f3f5; --ffbs-fg: #1d2125; --ffbs-muted: #5f6670;
            --ffbs-border: #d0d5db; --ffbs-hover: #e7eaee; --ffbs-accent: #22a636;
            --ffbs-accent-fg: #ffffff; --ffbs-link: #1a73e8; --ffbs-shadow: rgba(0,0,0,0.25);
        }
        html[data-ffbs-theme="dark"] body {
            --ffbs-bg: #1f2227; --ffbs-bg2: #15171b; --ffbs-fg: #eee; --ffbs-muted: #9aa0a6;
            --ffbs-border: #3a3f47; --ffbs-hover: #2c3037; --ffbs-accent: #2ecc40;
            --ffbs-accent-fg: #0a0a0a; --ffbs-link: #4aa3ff; --ffbs-shadow: rgba(0,0,0,0.6);
        }

        /* ---- badges ---- */
        a[data-ffbs], a[data-ffbs-loading] { position: relative !important; }
        .ffbs-badge {
            position: absolute; z-index: 9999;
            font-size: 9px; line-height: 1; font-weight: 800;
            font-family: Arial, Helvetica, sans-serif; font-variant-numeric: tabular-nums;
            padding: 2px 3px; min-width: 14px; text-align: center; color: #fff;
            text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
            pointer-events: none; box-sizing: border-box; user-select: none;
        }
        .ffbs-ff {
            top: -7px; right: -7px; border-radius: 50%; border: 1.5px solid;
            min-width: 16px; height: 16px; display: flex; align-items: center;
            justify-content: center; padding: 0 2px;
        }
        .ffbs-bs {
            bottom: -7px; right: -7px; border: 1.5px solid; min-width: 18px; height: 17px;
            display: flex; align-items: center; justify-content: center; padding: 0 2px 2px 2px;
            clip-path: polygon(0% 0%, 100% 0%, 100% 62%, 50% 100%, 0% 62%);
        }
        /* tier colours as variables; the badge style decides how they're used */
        .ffbs-green  { --ffbs-c: #2ecc40; --ffbs-f: rgba(46,204,64,0.5); }
        .ffbs-yellow { --ffbs-c: #ffdc00; --ffbs-f: rgba(255,220,0,0.5); }
        .ffbs-orange { --ffbs-c: #ff851b; --ffbs-f: rgba(255,133,27,0.5); }
        .ffbs-red    { --ffbs-c: #ff4136; --ffbs-f: rgba(255,65,54,0.5); }
        .ffbs-grey   { --ffbs-c: #aaaaaa; --ffbs-f: rgba(170,170,170,0.5); }
        ${badgeStyleCss()}
        .ffbs-badge.ffbs-loading { opacity: 0.55; animation: ffbs-pulse 1.4s ease-in-out infinite; }

        .ffbs-timer {
            top: -7px; left: -7px; border-radius: 7px; border: 1.5px solid;
            padding: 1px 4px; font-size: 8px; white-space: nowrap;
        }
        .ffbs-timer-hosp   { border-color: #ff4136; background-color: rgba(255,65,54,0.6); }
        .ffbs-timer-travel { border-color: #39a0ff; background-color: rgba(57,160,255,0.6); }

        /* hospital almost over -> pulse */
        @keyframes ffbs-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .ffbs-timer.ffbs-soon { border-color: #2ecc40; background-color: rgba(46,204,64,0.7);
            animation: ffbs-pulse 1s ease-in-out infinite; }
        span[data-ffbs-soon] { color: #2ecc40 !important; font-weight: 700;
            animation: ffbs-pulse 1s ease-in-out infinite; }

        /* ---- faction list sort/filter ---- */
        [data-ffbs-sorted] { display: flex !important; flex-direction: column !important; }
        [data-ffbs-hidden] { display: none !important; }

        /* war page status: hide Torn's text visually, show our timer */
        [data-ffbs-war] { font-size: 0 !important; }
        [data-ffbs-war] > .ffbs-war-status { font-size: 12px; white-space: nowrap; }
        .ffbs-war-status[data-ffbs-soon] { color: #2ecc40 !important; font-weight: 700;
            animation: ffbs-pulse 1s ease-in-out infinite; }

        .ffbs-toolbar {
            position: sticky; top: 0; z-index: 50;
            display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
            padding: 5px 6px; margin: 4px 0; font: 11px Arial, Helvetica, sans-serif;
            background: var(--ffbs-bg); border: 1px solid var(--ffbs-border); border-radius: 6px;
            color: var(--ffbs-fg); box-shadow: 0 2px 6px var(--ffbs-shadow);
        }
        .ffbs-toolbar .ffbs-seg { display: inline-flex; border: 1px solid var(--ffbs-border); border-radius: 5px; overflow: hidden; }
        .ffbs-toolbar .ffbs-seg button {
            padding: 4px 9px; font-size: 11px; font-weight: 700; cursor: pointer;
            background: var(--ffbs-bg2); color: var(--ffbs-fg); border: 0;
            border-left: 1px solid var(--ffbs-border); transition: background .15s, color .15s;
        }
        .ffbs-toolbar .ffbs-seg button:first-child { border-left: 0; }
        .ffbs-toolbar .ffbs-seg button.active { background: var(--ffbs-accent); color: var(--ffbs-accent-fg); }
        .ffbs-toolbar .ffbs-count { color: var(--ffbs-muted); font-weight: 700; font-variant-numeric: tabular-nums; }
        .ffbs-toolbar label { margin-left: auto; display: flex; align-items: center; gap: 4px; cursor: pointer; }
        .ffbs-toolbar input { accent-color: var(--ffbs-accent); margin: 0; }

        /* ---- overlays (setup card + settings panel) ---- */
        @keyframes ffbs-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ffbs-pop  { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
        #ffbs-setup, #ffbs-config {
            position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.7);
            display: flex; align-items: center; justify-content: center;
            font-family: Arial, Helvetica, sans-serif; animation: ffbs-fade .15s ease-out;
        }
        #ffbs-setup .ffbs-card, #ffbs-config .ffbs-card {
            position: relative; background: var(--ffbs-bg); color: var(--ffbs-fg);
            border-radius: 12px; border: 1px solid var(--ffbs-border);
            box-shadow: 0 10px 34px var(--ffbs-shadow); animation: ffbs-pop .18s ease-out;
            box-sizing: border-box;
        }
        #ffbs-setup .ffbs-card { width: 320px; max-width: 90vw; padding: 22px; }
        #ffbs-setup h2 { margin: 0 0 6px; font-size: 17px; }
        #ffbs-setup p  { margin: 0 0 14px; font-size: 12px; color: var(--ffbs-muted); }
        #ffbs-setup a, #ffbs-config a { color: var(--ffbs-link); text-decoration: underline; }
        #ffbs-setup input {
            width: 100%; box-sizing: border-box; padding: 9px; font-size: 13px;
            background: var(--ffbs-bg2); color: var(--ffbs-fg); border: 1px solid var(--ffbs-border);
            border-radius: 6px; margin-bottom: 10px;
        }
        #ffbs-setup button {
            width: 100%; padding: 9px; font-size: 13px; font-weight: 700;
            background: var(--ffbs-accent); color: var(--ffbs-accent-fg); border: none; border-radius: 6px; cursor: pointer;
        }
        #ffbs-setup button:disabled { opacity: 0.6; cursor: default; }
        #ffbs-setup .ffbs-msg  { margin-top: 10px; font-size: 12px; min-height: 16px; }
        #ffbs-setup .ffbs-err  { color: #ff6b61; }
        #ffbs-setup .ffbs-info { color: #d4a800; }
        #ffbs-setup .ffbs-close, #ffbs-config .ffbs-close {
            position: absolute; top: 8px; right: 10px; width: 28px; height: 28px; padding: 0;
            background: transparent; color: var(--ffbs-muted); font-size: 20px; line-height: 28px;
            text-align: center; cursor: pointer; border: none; border-radius: 6px;
        }
        #ffbs-setup .ffbs-close:hover, #ffbs-config .ffbs-close:hover { background: var(--ffbs-hover); color: var(--ffbs-fg); }
        #ffbs-reopen {
            position: fixed; right: 12px; bottom: 70px; z-index: 2147483646;
            padding: 7px 11px; font-size: 12px; font-weight: 700;
            background: var(--ffbs-accent); color: var(--ffbs-accent-fg); border: none; border-radius: 18px; cursor: pointer;
            box-shadow: 0 3px 12px var(--ffbs-shadow); font-family: Arial, Helvetica, sans-serif;
        }

        /* ---- settings gear ---- */
        #ffbs-gear {
            position: fixed; right: 12px; bottom: 110px; z-index: 2147483646;
            width: 38px; height: 38px; padding: 0; font-size: 18px; line-height: 38px;
            text-align: center; background: var(--ffbs-bg); color: var(--ffbs-accent);
            border: 1px solid var(--ffbs-border); border-radius: 50%; cursor: pointer;
            box-shadow: 0 3px 12px var(--ffbs-shadow); font-family: Arial, Helvetica, sans-serif;
        }
        #ffbs-gear:hover { border-color: var(--ffbs-accent); }
        /* ⚙ inside Torn's footer button row: keeps Torn's button class, own colour */
        [data-ffbs-gear] { background: linear-gradient(to bottom, #2ecc40, #1a7a26) !important; }
        [data-ffbs-gear]:hover { background: linear-gradient(to bottom, #3ee052, #2ecc40) !important; }

        /* ---- settings panel ---- */
        #ffbs-config .ffbs-card {
            width: 360px; max-width: 94vw; max-height: 88vh; display: flex; flex-direction: column; padding: 0;
        }
        #ffbs-config .ffbs-head { padding: 16px 44px 10px 18px; border-bottom: 1px solid var(--ffbs-border); }
        #ffbs-config h2 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
        #ffbs-config h2 .ffbs-ver { font-size: 10px; font-weight: 700; color: var(--ffbs-muted);
            border: 1px solid var(--ffbs-border); border-radius: 10px; padding: 2px 6px; }
        #ffbs-config .ffbs-body { overflow-y: auto; padding: 6px 14px 4px; }
        #ffbs-config details { border-bottom: 1px solid var(--ffbs-border); }
        #ffbs-config details:last-child { border-bottom: 0; }
        #ffbs-config summary {
            list-style: none; cursor: pointer; padding: 11px 4px; font-size: 11px; font-weight: 700;
            text-transform: uppercase; letter-spacing: .6px; color: var(--ffbs-accent);
            display: flex; justify-content: space-between; align-items: center; user-select: none;
        }
        #ffbs-config summary::-webkit-details-marker { display: none; }
        #ffbs-config summary::after { content: '▸'; color: var(--ffbs-muted); transition: transform .15s; }
        #ffbs-config details[open] > summary::after { transform: rotate(90deg); }
        #ffbs-config details > .ffbs-sec { padding: 0 4px 10px; }
        #ffbs-config .ffbs-row { display: flex; align-items: center; justify-content: space-between;
            gap: 10px; padding: 7px 0; font-size: 13px; }
        #ffbs-config .ffbs-row label { flex: 1; cursor: pointer; }
        #ffbs-config .ffbs-row .hint { display: block; font-size: 10px; color: var(--ffbs-muted); margin-top: 2px; }
        #ffbs-config .ffbs-note { font-size: 11px; color: var(--ffbs-muted); margin: 2px 0 4px; }
        #ffbs-config input[type="number"], #ffbs-config select {
            box-sizing: border-box; padding: 6px; font-size: 13px;
            background: var(--ffbs-bg2); color: var(--ffbs-fg); border: 1px solid var(--ffbs-border); border-radius: 6px;
        }
        #ffbs-config input[type="number"] { width: 72px; text-align: right; }
        #ffbs-config select { min-width: 104px; }
        #ffbs-config input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--ffbs-accent); cursor: pointer; }

        #ffbs-config .ffbs-preview {
            display: flex; flex-wrap: wrap; gap: 16px 18px; align-items: center; justify-content: center;
            padding: 14px 8px 12px; margin: 4px 0 6px; border-radius: 8px;
            background: var(--ffbs-bg2); border: 1px dashed var(--ffbs-border);
        }
        #ffbs-config .ffbs-pv { position: relative; display: inline-block; padding: 6px 10px 6px 6px;
            font-size: 12px; color: var(--ffbs-muted); }
        #ffbs-config .ffbs-pv .ffbs-badge { position: absolute; }

        #ffbs-config .ffbs-cacheinfo { font-size: 12px; color: var(--ffbs-muted); margin: 2px 0 8px; line-height: 1.5; }
        #ffbs-config .ffbs-btn {
            width: 100%; padding: 8px; font-size: 12px; font-weight: 700; cursor: pointer; border-radius: 6px;
            background: var(--ffbs-bg2); color: var(--ffbs-fg); border: 1px solid var(--ffbs-border);
        }
        #ffbs-config .ffbs-btn:hover { background: var(--ffbs-hover); }
        #ffbs-config .ffbs-btn.danger { color: #e5534b; }
        #ffbs-config .ffbs-btn.armed { background: #e5534b; color: #fff; border-color: #e5534b; }

        #ffbs-config .ffbs-foot { padding: 12px 14px 14px; border-top: 1px solid var(--ffbs-border); }
        #ffbs-config .ffbs-actions { display: flex; gap: 8px; }
        #ffbs-config .ffbs-actions button { flex: 1; padding: 10px; font-size: 13px; font-weight: 700;
            border: none; border-radius: 7px; cursor: pointer; }
        #ffbs-config .btn-save  { background: var(--ffbs-accent); color: var(--ffbs-accent-fg); }
        #ffbs-config .btn-reset { background: var(--ffbs-hover); color: var(--ffbs-fg); }
        #ffbs-config .ffbs-links { display: flex; justify-content: space-between; margin-top: 10px; font-size: 11px; }
        #ffbs-config .ffbs-links button { background: none; border: 0; padding: 0; cursor: pointer;
            color: var(--ffbs-link); font-size: 11px; text-decoration: underline; }
        #ffbs-config .ffbs-err { color: #e5534b; font-size: 12px; text-align: center; min-height: 0; margin-top: 8px; }

        /* ---- toast ---- */
        #ffbs-toast {
            position: fixed; left: 50%; bottom: 90px; z-index: 2147483647; transform: translate(-50%, 10px);
            padding: 9px 16px; border-radius: 20px; font: 700 13px Arial, Helvetica, sans-serif;
            background: var(--ffbs-bg); color: var(--ffbs-fg); border: 1px solid var(--ffbs-accent);
            box-shadow: 0 6px 20px var(--ffbs-shadow); opacity: 0; pointer-events: none;
            transition: opacity .2s, transform .2s; white-space: nowrap;
        }
        #ffbs-toast.show { opacity: 1; transform: translate(-50%, 0); }
        #ffbs-toast.err { border-color: #e5534b; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    /* =======================================================================
     * OWN BATTLE STATS
     * ===================================================================== */
    async function loadOwnBattleStats() {
        // Reuse today's value if we have one.
        try {
            const c = JSON.parse(localStorage.getItem(LS_OWN_BS) || 'null');
            if (c && c.total > 0 && Date.now() - c.ts < OWN_STATS_TTL_MS) {
                myBattleStat = c.total;
                recolorBS();
                return true;
            }
        } catch (e) {}
        if (Date.now() < tornPausedUntil) return false;
        try {
            const resp = await httpGet(`https://api.torn.com/v2/user/battlestats?key=${encodeURIComponent(API_KEY)}`);
            const cat = classify(resp.status, resp.text);
            if (cat === 'auth') { clearKeyAndReopenSetup(); return false; }
            if (handleTornBackoff(cat)) return false;
            if (cat !== 'ok') {
                log('Own battle stats fetch failed; will retry. BS stays grey.');
                return false;
            }
            const data = JSON.parse(resp.text);
            if (data.error) {
                if (data.error.code === 16) {
                    ownStatsGaveUp = true;
                    log('Key has no battle-stats access (error 16). BS stays grey.');
                } else {
                    log(`Battle stats API error ${data.error.code}; will retry.`);
                }
                return false;
            }
            const bs = data.battlestats || data;
            const val = (x) => Number(x && typeof x === 'object' ? x.value : x);
            const total = Number(bs.total) ||
                (val(bs.strength) + val(bs.defense) + val(bs.speed) + val(bs.dexterity));
            if (total && !isNaN(total) && total > 0) {
                myBattleStat = total;
                try { localStorage.setItem(LS_OWN_BS, JSON.stringify({ total: total, ts: Date.now() })); } catch (e) {}
                log(`Own battle stats loaded: ${compact(total)}.`);
                recolorBS();
                return true;
            }
            return false;
        } catch (e) {
            log('Own battle stats fetch threw; will retry.', e);
            return false;
        }
    }

    /* =======================================================================
     * FACTION STATUS
     * ===================================================================== */
    function getViewedFactionId() {
        try {
            // Only faction pages carry a faction ID; other pages (companies,
            // items…) also use "ID=" and must not trigger faction/{id} calls.
            if (!/factions\.php/i.test(location.pathname)) return null;
            const hay = location.search + ' ' + location.hash + ' ' + location.href;
            const m = hay.match(/[?&#/]ID=(\d+)/i);
            if (m) return m[1];
        } catch (e) {}
        return null;
    }
    // Enemy faction on a war page (factions.php#/war/...), read from the
    // enemy faction's profile link. Null anywhere else.
    function getEnemyFactionId() {
        if (!/factions\.php/i.test(location.pathname) || !/\/war\//i.test(location.hash)) return null;
        const a = document.querySelector('.faction-war .enemy-faction a[href*="step=profile"][href*="ID="], ' +
                                         '.enemy-faction a[href*="step=profile"][href*="ID="]');
        const m = a && (a.getAttribute('href') || '').match(/[?&]ID=(\d+)/i);
        return m ? m[1] : null;
    }
    // Factions whose member statuses we keep: the viewed / enemy faction(s)
    // plus your own (null), which also feeds HIDE_OWN_FACTION.
    function factionTargets() {
        const ids = [];
        const viewed = getViewedFactionId();
        if (viewed) ids.push(viewed);
        const enemy = getEnemyFactionId();
        if (enemy && !ids.includes(enemy)) ids.push(enemy);
        ids.push(null);
        return ids;
    }
    function factionKey() {
        return factionTargets().map((f) => f || 'own').join(',');
    }
    // Fetch one faction's members. Returns an array, or null on any failure.
    async function fetchFactionMembers(fid) {
        const path = fid ? `faction/${fid}/members` : 'faction/members';
        const resp = await httpGet(`https://api.torn.com/v2/${path}?key=${encodeURIComponent(API_KEY)}`);
        const cat = classify(resp.status, resp.text);
        if (cat === 'auth') { clearKeyAndReopenSetup(); return null; }
        if (handleTornBackoff(cat) || cat !== 'ok') return null;
        let data;
        try { data = JSON.parse(resp.text); } catch (e) { return null; }
        if (data.error) {
            log(`Faction ${fid || 'own'} members: API error ${data.error.code}.`);
            return null;
        }
        // v2 returns an array of members; tolerate the v1 id-keyed object too.
        return Array.isArray(data.members) ? data.members
            : Object.keys(data.members || {}).map((id) => Object.assign({ id: id }, data.members[id]));
    }
    async function fetchFactionStatuses() {
        if (!API_KEY || factionFetching || Date.now() < tornPausedUntil) return;
        factionFetching = true;
        try {
            const targets = factionTargets();
            const key = targets.map((f) => f || 'own').join(',');
            if (key !== currentFactionKey) {
                factionStatus.clear();
                currentFactionKey = key;
                tickTimers();
            }
            const seen = new Set();
            let allOk = true;
            for (const fid of targets) {
                if (!API_KEY || Date.now() < tornPausedUntil) { allOk = false; break; }
                const members = await fetchFactionMembers(fid);
                if (!members) { allOk = false; continue; }
                const ids = [];
                members.forEach((m) => {
                    if (!m || m.id == null) return;
                    const pid = String(m.id);
                    ids.push(pid);
                    const st = m.status;
                    if (!st) return;
                    seen.add(pid);
                    factionStatus.set(pid, {
                        state: st.state || null,
                        until: Number(st.until) || 0,
                        description: st.description || ''
                    });
                });
                if (fid === null) updateOwnFaction(ids);
                log(`Faction status: ${ids.length} member(s) (faction ${fid || 'own'}).`);
            }
            // Only prune after a complete refresh, so one failed call doesn't
            // wipe timers that are still valid.
            if (allOk) Array.from(factionStatus.keys()).forEach((pid) => { if (!seen.has(pid)) factionStatus.delete(pid); });
            tickTimers();
        } catch (e) {
            log('Faction status fetch failed.', e);
        } finally {
            factionFetching = false;
        }
    }
    function updateOwnFaction(ids) {
        const next = new Set(ids);
        const changed = new Set();
        next.forEach((pid) => { if (!ownFactionMembers.has(pid)) changed.add(pid); });
        ownFactionMembers.forEach((pid) => { if (!next.has(pid)) changed.add(pid); });
        ownFactionMembers = next;
        if (changed.size) applyAllResolved(changed); // show/hide their FF/BS badges
    }

    /* =======================================================================
     * SINGLE-USER STATUS
     * ===================================================================== */
    // Queue user-status fetches and send them one at a time, so a page full of
    // names can't burst through Torn's 100 req/min limit (shared with PDA).
    function queueUserStatus(pid) {
        if (pendingUserFetch.has(pid)) return;
        pendingUserFetch.add(pid);
        userFetchQueue.push(pid);
        pumpUserQueue();
    }
    function pumpUserQueue() {
        if (userQueueTimer || userFetchQueue.length === 0) return;
        const wait = Math.max(USER_FETCH_GAP_MS, tornPausedUntil - Date.now());
        userQueueTimer = setTimeout(async () => {
            userQueueTimer = null;
            const pid = userFetchQueue.shift();
            if (pid != null) {
                if (API_KEY) await fetchUserStatus(pid);
                else pendingUserFetch.delete(pid);
            }
            pumpUserQueue();
        }, wait);
    }
    function isOnScreen(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        return r.bottom >= -200 && r.top <= vh + 200;
    }
    async function fetchUserStatus(pid) {
        try {
            const resp = await httpGet(`https://api.torn.com/v2/user/${pid}/basic?key=${encodeURIComponent(API_KEY)}`);
            const cat = classify(resp.status, resp.text);
            if (cat === 'auth') { clearKeyAndReopenSetup(); return; }
            if (handleTornBackoff(cat)) {
                userStatus.set(pid, { state: null, until: 0, description: '', ts: Date.now() });
                return;
            }
            if (cat !== 'ok') {
                userStatus.set(pid, { state: null, until: 0, description: '', ts: Date.now() });
                return;
            }
            let data;
            try { data = JSON.parse(resp.text); } catch (e) {
                userStatus.set(pid, { state: null, until: 0, description: '', ts: Date.now() });
                return;
            }
            if (data.error) {
                userStatus.set(pid, { state: null, until: 0, description: '', ts: Date.now() });
                return;
            }
            const st = (data.profile && data.profile.status) || data.status || {};
            userStatus.set(pid, {
                state: st.state || null,
                until: Number(st.until) || 0,
                description: st.description || '',
                ts: Date.now()
            });
            document.querySelectorAll(`a[${BADGE_ATTR}="${pid}"]`).forEach((link) => {
                applyTimerBadge(link, pid);
            });
        } catch (e) {
            userStatus.set(pid, { state: null, until: 0, description: '', ts: Date.now() });
            log(`User status fetch failed for ${pid}.`, e);
        } finally {
            pendingUserFetch.delete(pid);
        }
    }
    function resolveStatus(pid, wrap) {
        const fs = factionStatus.get(pid);
        if (fs) return fs;
        const us = userStatus.get(pid);
        if (us && (Date.now() - us.ts < USER_STATUS_TTL_MS)) return us;
        if (isOnScreen(wrap)) queueUserStatus(pid);
        return us || null;
    }

    /* =======================================================================
     * FFSCOUTER STATS FETCH
     * ===================================================================== */
    function scheduleFetch() {
        if (fetching || Date.now() < pausedUntil) return;
        fetchPending();
    }
    async function fetchPending() {
        if (fetching || !API_KEY || pending.size === 0 || Date.now() < pausedUntil) return;
        fetching = true;
        try {
            const ids = Array.from(pending);
            for (let i = 0; i < ids.length; i += BATCH_SIZE) {
                if (Date.now() < pausedUntil) break;
                const batch = ids.slice(i, i + BATCH_SIZE);
                const url = `https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(API_KEY)}&targets=${batch.join(',')}`;
                let resp;
                try { resp = await httpGet(url); }
                catch (e) { pausedUntil = Date.now() + TEMP_BACKOFF_MS; log('Stats fetch network error; backing off.'); break; }
                const cat = classify(resp.status, resp.text);
                if (cat === 'auth')      { log('Invalid key. Reopening setup.'); clearKeyAndReopenSetup(); break; }
                if (cat === 'ratelimit') { pausedUntil = Date.now() + RATELIMIT_MS; log('Rate limited; backing off.'); break; }
                if (cat === 'temp')      { pausedUntil = Date.now() + TEMP_BACKOFF_MS; log('FFScouter temp error; backing off.'); break; }
                let data;
                try { data = JSON.parse(resp.text); }
                catch (e) { pausedUntil = Date.now() + TEMP_BACKOFF_MS; log('Bad FFScouter JSON; backing off.'); break; }
                if (data && data.error) {
                    if (String(data.error).toLowerCase().includes('key')) { clearKeyAndReopenSetup(); }
                    else { pausedUntil = Date.now() + TEMP_BACKOFF_MS; }
                    break;
                }
                const arr = Array.isArray(data) ? data : (data.results || data.data || []);
                const now = Date.now();
                arr.forEach((row) => {
                    if (row == null || row.player_id == null) return;
                    const pid = String(row.player_id);
                    statsCache.set(pid, {
                        ff:      row.fair_fight != null ? Number(row.fair_fight) : null,
                        bsHuman: row.bs_estimate_human != null ? row.bs_estimate_human : null,
                        bsRaw:   row.bs_estimate != null ? Number(row.bs_estimate) : null,
                        ts:      now
                    });
                });
                // IDs FFScouter didn't return: keep any old data (or store an
                // empty entry) with a fresh ts, so scanPage won't re-queue them
                // until the cache TTL expires.
                batch.forEach((pid) => {
                    const c = statsCache.get(pid);
                    if (!c || c.ts !== now) {
                        statsCache.set(pid, Object.assign({ ff: null, bsHuman: null, bsRaw: null }, c, { ts: now }));
                    }
                    pending.delete(pid);
                });
                applyAllResolved(new Set(batch));
                saveStatsCacheSoon();
            }
        } finally {
            fetching = false;
        }
    }

    /* =======================================================================
     * BADGE RENDERING
     * Badges are appended *inside* the player link, which is marked with
     * data-ffbs (CSS makes it position:relative). The link itself is never
     * moved or re-parented, so React's DOM bookkeeping stays intact; if React
     * replaces the link, the MutationObserver sees the new one and re-badges it.
     * ===================================================================== */
    // Faint "…" in the FF slot while a player's first lookup is in flight.
    // applyBadges() replaces it (or removes it when there's no data).
    function showLoading(link) {
        if (link.hasAttribute('data-ffbs-loading') && link.querySelector('.ffbs-loading')) return;
        const b = document.createElement('span');
        b.className = 'ffbs-badge ffbs-ff ffbs-grey ffbs-loading';
        b.textContent = '…';
        link.setAttribute('data-ffbs-loading', '');
        link.appendChild(b);
    }
    function isHiddenOwn(pid) {
        return !!S.HIDE_OWN_FACTION && ownFactionMembers.has(pid);
    }
    function applyBadges(link, pid) {
        if (isHiddenOwn(pid)) {
            // Teammate: no FF/BS, but keep the hospital/travel pill.
            link.querySelectorAll('.ffbs-badge:not(.ffbs-timer)').forEach((b) => b.remove());
            link.removeAttribute('data-ffbs-loading');
            link.setAttribute(BADGE_ATTR, pid);
            applyTimerBadge(link, pid);
            return;
        }
        const data = statsCache.get(pid);
        if (!data) return;
        const ffKnown = data.ff != null && !isNaN(data.ff);
        const bsKnown = data.bsRaw != null && !isNaN(data.bsRaw);
        link.querySelectorAll('.ffbs-badge:not(.ffbs-timer)').forEach((b) => b.remove());
        link.removeAttribute('data-ffbs-loading');
        link.setAttribute(BADGE_ATTR, pid);
        if (S.HIDE_WHEN_NO_DATA && !ffKnown && !bsKnown) {
            applyTimerBadge(link, pid);
            return;
        }
        const ff = document.createElement('span');
        ff.className = `ffbs-badge ffbs-ff ${ffTier(data.ff)}`;
        ff.textContent = formatFF(data.ff);
        ff.title = `FairFight: ${formatFF(data.ff)}`;
        link.appendChild(ff);
        const bs = document.createElement('span');
        bs.className = `ffbs-badge ffbs-bs ${bsTier(data.bsRaw)}`;
        bs.textContent = formatBS(data.bsHuman, data.bsRaw);
        bs.title = `Estimated battle stats: ${formatBS(data.bsHuman, data.bsRaw)}`;
        if (bsKnown) bs.setAttribute('data-bsraw', String(data.bsRaw));
        link.appendChild(bs);
        applyTimerBadge(link, pid);
    }
    function recolorBS() {
        document.querySelectorAll('.ffbs-bs[data-bsraw]').forEach((b) => {
            const raw = Number(b.getAttribute('data-bsraw'));
            b.classList.remove('ffbs-green', 'ffbs-yellow', 'ffbs-orange', 'ffbs-red', 'ffbs-grey');
            b.classList.add(bsTier(raw));
        });
    }
    function hospSoon(remaining) {
        return remaining > 0 && remaining <= Number(S.HOSP_ALERT_SEC || 0);
    }
    function applyTimerBadge(link, pid) {
        let badge = link.querySelector('.ffbs-timer');
        if (!S.SHOW_NAME_TIMER_BADGE) {
            if (badge) badge.remove();
            return;
        }
        const status = resolveStatus(pid, link);
        const remove = () => { if (badge) badge.remove(); };
        const ensure = (cls) => {
            if (!badge) { badge = document.createElement('span'); link.appendChild(badge); }
            const want = `ffbs-badge ffbs-timer ${cls}`;
            if (badge.className !== want) badge.className = want;
            return badge;
        };
        const setText = (t) => { if (badge.textContent !== t) badge.textContent = t; };
        if (!status || !status.state) { remove(); return; }
        const remaining = status.until ? status.until - Math.floor(Date.now() / 1000) : 0;
        if (TIMER_STATES.includes(status.state)) {
            if (remaining <= 0) { remove(); return; }
            ensure('ffbs-timer-hosp' + (hospSoon(remaining) ? ' ffbs-soon' : ''));
            setText(formatDuration(remaining));
            badge.title = `${status.state}: out in ${badge.textContent}`;
            return;
        }
        if (status.state === 'Traveling' || status.state === 'Abroad') {
            const t = parseTravel(status);
            ensure('ffbs-timer-travel');
            if (t.direction === 'abroad' || remaining <= 0) {
                setText(t.abbr);
                badge.title = status.description || `Abroad: ${t.country || t.abbr}`;
            } else {
                setText(`${t.abbr} ${formatDuration(remaining)}`);
                badge.title = `${status.description} — lands in ${formatDuration(remaining)}`;
            }
            return;
        }
        remove();
    }
    function playerLinks() {
        const skipSel = S.SKIP_CHAT ? SKIP_CONTAINERS.join(',') : null;
        const out = [];
        document.querySelectorAll('a[href*="XID="]').forEach((link) => {
            const m = link.href.match(/XID=(\d+)/);
            if (!m) return;
            if (skipSel && link.closest(skipSel)) return;
            out.push({ link: link, pid: m[1] });
        });
        return out;
    }
    // Badge every link we have data for. Pids in `refreshed` were just fetched,
    // so their already-badged links are redrawn with the new values too.
    function applyAllResolved(refreshed) {
        playerLinks().forEach(({ link, pid }) => {
            if (!statsCache.has(pid) && !isHiddenOwn(pid)) return;
            if (link.getAttribute(BADGE_ATTR) === pid && !(refreshed && refreshed.has(pid))) return;
            applyBadges(link, pid);
        });
        applyListSort();
    }

    /* =======================================================================
     * STATUS COLUMN REWRITE
     * ===================================================================== */
    function buildStatusText(status) {
        if (!status || !status.state) return null;
        const remaining = status.until ? status.until - Math.floor(Date.now() / 1000) : 0;
        if (status.state === 'Hospital') return remaining <= 0 ? null : formatDuration(remaining);
        if (status.state === 'Traveling') {
            const t = parseTravel(status);
            return remaining > 0 ? `→ ${t.abbr} ${formatDuration(remaining)}` : `→ ${t.abbr}`;
        }
        if (status.state === 'Abroad') return parseTravel(status).abbr;
        return null;
    }
    function rowPid(row) {
        const a = row.querySelector('a[href*="XID="]');
        const m = a && a.href.match(/XID=(\d+)/);
        return m ? m[1] : null;
    }
    function enhanceStatusCells() {
        if (!S.ENHANCE_STATUS_CELL) return;
        document.querySelectorAll('.table-cell.status span.ellipsis').forEach((span) => {
            const row = span.closest('.table-row');
            if (!row) return;
            const pid = rowPid(row);
            if (!pid) return;
            const status = factionStatus.get(pid);
            const text = buildStatusText(status);
            if (text == null) {
                if (span.hasAttribute('data-ffbs-orig')) {
                    span.textContent = span.getAttribute('data-ffbs-orig');
                    span.removeAttribute('data-ffbs-orig');
                }
                span.removeAttribute('data-ffbs-soon');
                return;
            }
            if (span.getAttribute('data-ffbs-orig') == null) span.setAttribute('data-ffbs-orig', span.textContent);
            if (span.textContent !== text) span.textContent = text;
            const soon = status.state === 'Hospital' &&
                hospSoon(status.until - Math.floor(Date.now() / 1000));
            if (soon) span.setAttribute('data-ffbs-soon', '1');
            else span.removeAttribute('data-ffbs-soon');
        });
        enhanceWarStatusCells();
    }
    // War page rows (.faction-war .members-list > li) have a plain `.status`
    // element. Torn's own text is left untouched (hidden via CSS font-size:0
    // while ours is shown), so React can keep updating it safely.
    function enhanceWarStatusCells() {
        document.querySelectorAll('.faction-war .members-list > li .status').forEach((el) => {
            const row = el.closest('li');
            const pid = row && rowPid(row);
            if (!pid) return;
            const status = factionStatus.get(pid);
            const text = buildStatusText(status);
            let t = el.querySelector('.ffbs-war-status');
            if (text == null) {
                if (t) t.remove();
                el.removeAttribute('data-ffbs-war');
                return;
            }
            if (!t) { t = document.createElement('span'); t.className = 'ffbs-war-status'; el.appendChild(t); }
            if (t.textContent !== text) t.textContent = text;
            if (!el.hasAttribute('data-ffbs-war')) el.setAttribute('data-ffbs-war', '');
            const soon = status.state === 'Hospital' &&
                hospSoon(status.until - Math.floor(Date.now() / 1000));
            if (soon) t.setAttribute('data-ffbs-soon', '1');
            else t.removeAttribute('data-ffbs-soon');
        });
    }
    function restoreWarStatusCells() {
        document.querySelectorAll('.ffbs-war-status').forEach((t) => t.remove());
        document.querySelectorAll('[data-ffbs-war]').forEach((el) => el.removeAttribute('data-ffbs-war'));
    }

    /* =======================================================================
     * FACTION LIST SORT / FILTER
     * Rows are never moved: the list container becomes a flex column and each
     * row gets a CSS `order`; filtered rows get a data attribute that hides
     * them. Turning the feature off just removes those styles/attributes.
     * ===================================================================== */
    const SORT_MODES = [
        { key: 'default', label: 'Default' },
        { key: 'ff',      label: 'FF ↓' },
        { key: 'bs',      label: 'BS ↑' },
        { key: 'hosp',    label: 'Hosp ↑' },
    ];
    function hospRank(st) {
        if (!st || !st.state) return 3e9;
        if (st.state === 'Okay') return 0;
        if (st.state === 'Hospital') {
            const r = (st.until || 0) - Math.floor(Date.now() / 1000);
            return r > 0 ? 1 + r : 0;
        }
        if (st.state === 'Traveling' || st.state === 'Abroad') return 1e9;
        return 2e9; // Jail, Federal, Fallen…
    }
    function memberListGroups() {
        const groups = new Map(); // container -> rows[]
        // Faction page rows, plus both member lists on a war page.
        document.querySelectorAll('.table-row, .faction-war .members-list > li').forEach((row) => {
            const isWar = row.parentElement && row.parentElement.classList.contains('members-list');
            if (!row.querySelector(isWar ? '.status' : '.table-cell.status') || !rowPid(row)) return;
            const c = row.parentElement;
            if (!c) return;
            if (!groups.has(c)) groups.set(c, []);
            groups.get(c).push(row);
        });
        return groups;
    }
    function resetListSort() {
        document.querySelectorAll('.ffbs-toolbar').forEach((b) => b.remove());
        document.querySelectorAll('[data-ffbs-sorted]').forEach((c) => c.removeAttribute('data-ffbs-sorted'));
        document.querySelectorAll('[data-ffbs-hidden]').forEach((r) => r.removeAttribute('data-ffbs-hidden'));
        document.querySelectorAll('.table-row[data-ffbs-order]').forEach((r) => {
            r.style.order = '';
            r.removeAttribute('data-ffbs-order');
        });
    }
    function ensureToolbar(container) {
        const prev = container.previousElementSibling;
        if (prev && prev.classList.contains('ffbs-toolbar')) return prev;
        const bar = document.createElement('div');
        bar.className = 'ffbs-toolbar';
        bar.innerHTML = '<span class="ffbs-seg">' +
            SORT_MODES.map((m) => `<button type="button" data-sort="${m.key}">${m.label}</button>`).join('') +
            '</span><span class="ffbs-count"></span>' +
            '<label><input type="checkbox" data-okay /> Okay only</label>';
        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-sort]');
            if (!btn) return;
            S.LIST_SORT = btn.getAttribute('data-sort');
            saveSettings();
            applyListSort();
        });
        bar.querySelector('input[data-okay]').addEventListener('change', (e) => {
            S.LIST_ONLY_OKAY = e.target.checked;
            saveSettings();
            applyListSort();
        });
        try { container.parentNode.insertBefore(bar, container); } catch (e) { return null; }
        return bar;
    }
    function applyListSort() {
        if (!S.SORT_TOOLBAR || !/factions\.php/i.test(location.pathname)) {
            if (document.querySelector('.ffbs-toolbar, [data-ffbs-sorted], [data-ffbs-hidden]')) resetListSort();
            return;
        }
        memberListGroups().forEach((rows, container) => {
            const bar = ensureToolbar(container);
            if (bar) {
                bar.querySelectorAll('button[data-sort]').forEach((b) =>
                    b.classList.toggle('active', b.getAttribute('data-sort') === S.LIST_SORT));
                const cb = bar.querySelector('input[data-okay]');
                if (cb.checked !== !!S.LIST_ONLY_OKAY) cb.checked = !!S.LIST_ONLY_OKAY;
            }

            const items = rows.map((row, i) => {
                const pid = rowPid(row);
                return { row: row, i: i, st: factionStatus.get(pid), stats: statsCache.get(pid) };
            });

            let okay = 0;
            items.forEach((it) => {
                if (it.st && it.st.state === 'Okay') okay++;
                const hide = S.LIST_ONLY_OKAY && it.st && it.st.state && it.st.state !== 'Okay';
                if (hide) { if (!it.row.hasAttribute('data-ffbs-hidden')) it.row.setAttribute('data-ffbs-hidden', '1'); }
                else if (it.row.hasAttribute('data-ffbs-hidden')) it.row.removeAttribute('data-ffbs-hidden');
            });
            const count = bar && bar.querySelector('.ffbs-count');
            if (count) {
                const t = `Okay ${okay}/${items.length}`;
                if (count.textContent !== t) count.textContent = t;
            }

            if (S.LIST_SORT === 'default') {
                container.removeAttribute('data-ffbs-sorted');
                items.forEach((it) => {
                    if (it.row.hasAttribute('data-ffbs-order')) { it.row.style.order = ''; it.row.removeAttribute('data-ffbs-order'); }
                });
                return;
            }

            const num = (v) => (v == null || isNaN(v) ? null : Number(v));
            const cmp = {
                // Highest FF first; unknown last.
                ff: (a, b) => {
                    const x = num(a.stats && a.stats.ff), y = num(b.stats && b.stats.ff);
                    if (x == null || y == null) return (x == null) - (y == null);
                    return y - x;
                },
                // Weakest estimated BS first; unknown last.
                bs: (a, b) => {
                    const x = num(a.stats && a.stats.bsRaw), y = num(b.stats && b.stats.bsRaw);
                    if (x == null || y == null) return (x == null) - (y == null);
                    return x - y;
                },
                // Okay first, then shortest hospital time, then travel, then the rest.
                hosp: (a, b) => hospRank(a.st) - hospRank(b.st),
            }[S.LIST_SORT];
            if (!cmp) return;

            container.setAttribute('data-ffbs-sorted', '1');
            items.slice().sort((a, b) => cmp(a, b) || a.i - b.i).forEach((it, idx) => {
                const o = String(idx);
                if (it.row.getAttribute('data-ffbs-order') !== o) {
                    it.row.style.order = o;
                    it.row.setAttribute('data-ffbs-order', o);
                }
            });
        });
    }

    /* =======================================================================
     * SCAN + TICK
     * ===================================================================== */
    function scanPage() {
        if (!API_KEY) return;
        if (factionKey() !== currentFactionKey) fetchFactionStatuses();
        const ttl = statsTtlMs();
        playerLinks().forEach(({ link, pid }) => {
            if (isHiddenOwn(pid)) {
                if (link.getAttribute(BADGE_ATTR) !== pid) applyBadges(link, pid);
                return; // no FFScouter lookup needed for teammates
            }
            const cached = statsCache.get(pid);
            const fresh  = cached && (Date.now() - (cached.ts || 0) < ttl);
            if (cached && link.getAttribute(BADGE_ATTR) !== pid) applyBadges(link, pid);
            if (!cached) showLoading(link);
            if (!fresh) pending.add(pid);
        });
        if (pending.size > 0) scheduleFetch();
        applyListSort();
        showGearButton();
    }
    function scheduleScan() {
        if (scanDebounce) return;
        scanDebounce = setTimeout(() => { scanDebounce = null; scanPage(); }, SCAN_DEBOUNCE_MS);
    }
    // Our own UI nodes; mutations that only add these are ignored so badge
    // updates can't trigger a rescan loop.
    const OWN_NODES = '.ffbs-badge, .ffbs-toolbar, #ffbs-setup, #ffbs-config, #ffbs-gear, [data-ffbs-gear], #ffbs-reopen, #ffbs-styles';
    function startObserver() {
        if (observer || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver((mutations) => {
            for (const mu of mutations) {
                for (const n of mu.addedNodes) {
                    if (n.nodeType === 1 && !n.matches(OWN_NODES)) { scheduleScan(); return; }
                }
            }
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
    function stopObserver() {
        if (observer) { observer.disconnect(); observer = null; }
        if (scanDebounce) { clearTimeout(scanDebounce); scanDebounce = null; }
    }
    function tickTimers() {
        if (S.SHOW_NAME_TIMER_BADGE) {
            document.querySelectorAll(`a[${BADGE_ATTR}]`).forEach((link) => {
                const pid = link.getAttribute(BADGE_ATTR);
                if (pid) applyTimerBadge(link, pid);
            });
        }
        enhanceStatusCells();
        if (S.SORT_TOOLBAR) applyListSort(); // keeps the Okay counter / hosp order live
    }

    /* =======================================================================
     * SETUP CARD
     * ===================================================================== */
    function showReopenButton() {
        if (document.getElementById('ffbs-reopen')) return;
        const b = document.createElement('button');
        b.id = 'ffbs-reopen';
        b.textContent = '🔑 FF/BS key';
        b.title = 'Enter your FF/BS Badges API key';
        b.addEventListener('click', () => { b.remove(); showSetupCard(); });
        (document.body || document.documentElement).appendChild(b);
    }
    function showSetupCard() {
        if (document.getElementById('ffbs-setup')) return;
        const reopen = document.getElementById('ffbs-reopen');
        if (reopen) reopen.remove();
        const overlay = document.createElement('div');
        overlay.id = 'ffbs-setup';
        overlay.innerHTML = `
            <div class="ffbs-card">
                <button class="ffbs-close" id="ffbs-close-btn" title="Close">&times;</button>
                <h2>FF/BS Badges — Setup</h2>
                <p>Enter the API key you signed up to
                   <a href="https://ffscouter.com" target="_blank" rel="noopener">FFScouter</a> with
                   (free). It only works with a registered key. Create one at
                   <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">Torn → Settings → API Keys</a>.
                   Stored locally on this device only.</p>
                <input type="text" id="ffbs-key-input" placeholder="Your FFScouter-registered API key"
                       autocomplete="off" spellcheck="false" />
                <button id="ffbs-save-btn">Save &amp; Verify</button>
                <div class="ffbs-msg" id="ffbs-setup-msg"></div>
            </div>`;
        (document.body || document.documentElement).appendChild(overlay);
        const input = overlay.querySelector('#ffbs-key-input');
        const btn   = overlay.querySelector('#ffbs-save-btn');
        const msg   = overlay.querySelector('#ffbs-setup-msg');
        const setMsg = (t, cls) => { msg.textContent = t; msg.className = 'ffbs-msg' + (cls ? ' ' + cls : ''); };
        overlay.querySelector('#ffbs-close-btn').addEventListener('click', () => {
            overlay.remove();
            showReopenButton();
        });
        async function doSave() {
            const key = input.value.trim();
            if (!key) { setMsg('Please enter a key.', 'ffbs-err'); return; }
            btn.disabled = true;
            setMsg('Verifying key…', 'ffbs-info');
            let resp;
            try {
                resp = await httpGet(`https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(key)}&targets=1`);
            } catch (e) {
                btn.disabled = false;
                setMsg('Network error during verification. Please try again.', 'ffbs-err');
                return;
            }
            const cat = classify(resp.status, resp.text);
            if (cat === 'auth')      { btn.disabled = false; setMsg('Key rejected — make sure you signed up at ffscouter.com with this key.', 'ffbs-err'); return; }
            if (cat === 'ratelimit') { btn.disabled = false; setMsg('Rate limited. Wait a few seconds and try again.', 'ffbs-err'); return; }
            if (cat === 'temp')      { btn.disabled = false; setMsg('Service unavailable. Please try again shortly.', 'ffbs-err'); return; }
            try {
                const data = JSON.parse(resp.text);
                if (data && data.error && String(data.error).toLowerCase().includes('key')) {
                    btn.disabled = false;
                    setMsg('Key rejected — make sure you signed up at ffscouter.com with this key.', 'ffbs-err');
                    return;
                }
            } catch (e) { /* non-JSON 200 — accept cautiously */ }
            keySet(key);
            // FF is relative to the key owner's stats: a different key means the
            // cached FF values and own BS belong to someone else — drop them.
            const owner = hashKey(key);
            try {
                if (localStorage.getItem(LS_CACHE_OWNER) !== owner) {
                    localStorage.removeItem(LS_STATS);
                    localStorage.removeItem(LS_OWN_BS);
                    localStorage.setItem(LS_CACHE_OWNER, owner);
                    statsCache.clear();
                }
            } catch (e) {}
            API_KEY = key;
            setMsg('Key verified. Starting…', 'ffbs-info');
            log('API key verified and saved.');
            setTimeout(() => { overlay.remove(); toast('API key saved ✓'); startMain(); }, 500);
        }
        btn.addEventListener('click', doSave);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    }
    function clearKeyAndReopenSetup() {
        keyDel();
        stopObserver();
        API_KEY = null;
        myBattleStat = null;
        ownStatsGaveUp = false;
        factionStatus.clear();
        userFetchQueue.length = 0;
        pendingUserFetch.clear();
        [scanTimer, factionTimer, tickTimer, ownStatsTimer].forEach((t) => t && clearInterval(t));
        scanTimer = factionTimer = tickTimer = ownStatsTimer = null;
        showSetupCard();
    }

    /* =======================================================================
     * SETTINGS PANEL (⚙)
     * ===================================================================== */
    // Torn's footer panel buttons (same anchor the Bounty Hunter script uses).
    function findFooterRefBtn() {
        return document.getElementById('notes_panel_button') ||
               document.getElementById('people_panel_button');
    }
    const GEAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<path fill="#f0f0f0" d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61' +
        'l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.48.48 0 0 0 13.92 2h-3.84' +
        'a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.72 8.47' +
        'a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61' +
        'l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84' +
        'c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32' +
        'a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';
    // Put the ⚙ button among Torn's footer panel buttons (next to Bounty
    // Hunter's icon) when they exist; otherwise fall back to the floating
    // button. Called on every scan, so it re-mounts after Torn's SPA
    // re-renders the footer.
    function showGearButton() {
        const ref = findFooterRefBtn();
        const inBar = document.querySelector('[data-ffbs-gear]');
        const floating = document.getElementById('ffbs-gear');
        if (ref && ref.parentNode) {
            if (inBar && inBar.parentNode === ref.parentNode) { if (floating) floating.remove(); return; }
            if (inBar) inBar.remove();
            const svg = ref.querySelector('svg');
            const svgCls = (svg && svg.className && svg.className.baseVal) || '';
            const b = document.createElement('button');
            b.type = 'button';
            b.className = ref.className;
            b.title = 'FF/BS Badges settings';
            b.setAttribute('data-ffbs-gear', '');
            b.innerHTML = GEAR_SVG.replace('%CLS%', svgCls ? ` class="${svgCls}"` : '');
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showConfigPanel();
            });
            try {
                ref.parentNode.insertBefore(b, ref);
                if (floating) floating.remove();
                return;
            } catch (e) { b.remove(); }
        } else if (inBar) {
            inBar.remove();
        }
        if (floating) return;
        const f = document.createElement('button');
        f.id = 'ffbs-gear';
        f.textContent = '⚙';
        f.title = 'FF/BS Badges settings';
        f.addEventListener('click', showConfigPanel);
        (document.body || document.documentElement).appendChild(f);
    }
    function cacheSummary() {
        let kb = 0;
        try { kb = Math.round(((localStorage.getItem(LS_STATS) || '').length * 2) / 1024); } catch (e) {}
        const own = myBattleStat ? compact(myBattleStat) : 'unknown';
        return `${statsCache.size} player(s) cached · ~${kb} KB<br>Your battle stats: ${own}`;
    }
    function clearStatsCache() {
        statsCache.clear();
        pending.clear();
        try { localStorage.removeItem(LS_STATS); localStorage.removeItem(LS_OWN_BS); } catch (e) {}
        document.querySelectorAll(`a[${BADGE_ATTR}]`).forEach((link) => {
            link.querySelectorAll('.ffbs-badge:not(.ffbs-timer)').forEach((b) => b.remove());
            link.removeAttribute(BADGE_ATTR);
        });
        myBattleStat = null;
        loadOwnBattleStats();
        scanPage(); // refetch what's on screen
    }

    function showConfigPanel() {
        if (document.getElementById('ffbs-config')) return;
        const overlay = document.createElement('div');
        overlay.id = 'ffbs-config';

        const toggleRow = (key, label, hint) => `
            <div class="ffbs-row">
                <label for="cfg-${key}">${label}<span class="hint">${hint}</span></label>
                <input type="checkbox" id="cfg-${key}" ${S[key] ? 'checked' : ''} />
            </div>`;
        const numRow = (key, label, hint, step) => `
            <div class="ffbs-row">
                <label for="cfg-${key}">${label}<span class="hint">${hint}</span></label>
                <input type="number" id="cfg-${key}" value="${S[key]}" step="${step}" min="0" />
            </div>`;
        const selRow = (key, label, hint, options) => `
            <div class="ffbs-row">
                <label for="cfg-${key}">${label}<span class="hint">${hint}</span></label>
                <select id="cfg-${key}">${Object.keys(options).map((v) =>
                    `<option value="${v}" ${S[key] === v ? 'selected' : ''}>${options[v]}</option>`).join('')}</select>
            </div>`;
        const opts = (obj) => Object.keys(obj).reduce((o, k) => { o[k] = obj[k].label || obj[k]; return o; }, {});
        const section = (title, body, open) => `
            <details ${open ? 'open' : ''}><summary>${title}</summary><div class="ffbs-sec">${body}</div></details>`;

        overlay.innerHTML = `
            <div class="ffbs-card" role="dialog" aria-label="FF/BS Badges settings">
                <button class="ffbs-close" id="cfg-close" title="Close">&times;</button>
                <div class="ffbs-head"><h2>FF/BS Badges <span class="ffbs-ver">v${VERSION}</span></h2></div>
                <div class="ffbs-body">
                ${section('Appearance', `
                    <div class="ffbs-preview" id="cfg-preview"></div>
                    ${selRow('BADGE_STYLE', 'Badge style', 'How FF / BS badges are drawn', opts(BADGE_STYLES))}
                    ${selRow('BADGE_SIZE', 'Badge size', 'Bigger is easier to read on a phone', opts(BADGE_SIZES))}
                    ${selRow('THEME', 'Panel theme', 'Settings, toolbar and setup card', THEMES)}
                `, true)}
                ${section('Features', `
                    ${toggleRow('SHOW_NAME_TIMER_BADGE', 'Hospital / travel pill', 'Countdown badge on the avatar corner')}
                    ${toggleRow('ENHANCE_STATUS_CELL', 'Live status column', 'Timers in faction & war member lists')}
                    ${toggleRow('SORT_TOOLBAR', 'Member list sort bar', 'Sort by FF / BS / hospital, filter Okay')}
                    ${toggleRow('HIDE_OWN_FACTION', 'Hide badges on my faction', 'No FF/BS on teammates (timers stay)')}
                    ${toggleRow('SKIP_CHAT', 'Skip chat box', "Don't badge names inside chat")}
                    ${toggleRow('HIDE_WHEN_NO_DATA', 'Hide empty badges', 'Draw nothing when FF & BS unknown')}
                    ${numRow('HOSP_ALERT_SEC', 'Hospital alert (sec)', 'Pulse when this little time is left (0 = off)', '10')}
                `)}
                ${section('Colour thresholds', `
                    <p class="ffbs-note">FairFight</p>
                    ${numRow('FF_GREEN', 'Green below', 'FF under this = green', '0.05')}
                    ${numRow('FF_YELLOW', 'Yellow below', 'FF under this = yellow', '0.05')}
                    ${numRow('FF_ORANGE', 'Orange below', 'FF under this = orange, above = red', '0.05')}
                    <p class="ffbs-note">Battle stats — multiples of your own total</p>
                    ${numRow('BS_YELLOW', 'Yellow up to', 'e.g. 1.10 = +10% over you', '0.05')}
                    ${numRow('BS_ORANGE', 'Orange up to', 'e.g. 1.25 = +25% over you', '0.05')}
                `)}
                ${section('Cache & data', `
                    ${numRow('CACHE_HOURS', 'Keep FF/BS data (hours)', 'Reused without refetching (72 = 3 days)', '1')}
                    <div class="ffbs-cacheinfo" id="cfg-cacheinfo">${cacheSummary()}</div>
                    <button type="button" class="ffbs-btn danger" id="cfg-clear">Clear cache</button>
                `)}
                ${section('Advanced', `
                    ${toggleRow('DEBUG', 'Debug logging', 'Verbose messages in the browser console')}
                `)}
                </div>
                <div class="ffbs-foot">
                    <div class="ffbs-actions">
                        <button class="btn-save"  id="cfg-save">Save</button>
                        <button class="btn-reset" id="cfg-reset">Reset</button>
                    </div>
                    <div class="ffbs-err" id="cfg-err"></div>
                    <div class="ffbs-links">
                        <button type="button" id="cfg-key">Change API key</button>
                        <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
                    </div>
                </div>
            </div>`;
        (document.body || document.documentElement).appendChild(overlay);

        const $ = (id) => overlay.querySelector('#' + id);
        const close = () => overlay.remove();
        $('cfg-close').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        const errMsg = $('cfg-err');

        // ---- live preview: sample badges using the *unsaved* form values ----
        const num = (id, dflt) => { const v = parseFloat(($(id) || {}).value); return isNaN(v) ? dflt : v; };
        const renderPreview = () => {
            const g = num('cfg-FF_GREEN', S.FF_GREEN), y = num('cfg-FF_YELLOW', S.FF_YELLOW), o = num('cfg-FF_ORANGE', S.FF_ORANGE);
            const ffT = (ff) => ff < g ? 'ffbs-green' : ff < y ? 'ffbs-yellow' : ff < o ? 'ffbs-orange' : 'ffbs-red';
            const samples = [
                { ff: 1.2, bs: 'ffbs-green',  bsTxt: '850k' },
                { ff: 2.1, bs: 'ffbs-yellow', bsTxt: '1.1m' },
                { ff: 2.7, bs: 'ffbs-orange', bsTxt: '1.3m' },
                { ff: 3.4, bs: 'ffbs-red',    bsTxt: '4.2m' },
            ];
            const pv = $('cfg-preview');
            pv.setAttribute('data-ffbs-pstyle', $('cfg-BADGE_STYLE').value);
            pv.setAttribute('data-ffbs-psize', $('cfg-BADGE_SIZE').value);
            pv.innerHTML = samples.map((s) => `<span class="ffbs-pv">Player
                <span class="ffbs-badge ffbs-ff ${ffT(s.ff)}">${formatFF(s.ff)}</span>
                <span class="ffbs-badge ffbs-bs ${s.bs}">${s.bsTxt}</span></span>`).join('');
        };
        renderPreview();
        overlay.querySelectorAll('select, input[type="number"]').forEach((el) => {
            el.addEventListener('input', renderPreview);
            el.addEventListener('change', renderPreview);
        });

        // ---- clear cache: tap twice to confirm (no confirm() dialogs on PDA) ----
        const clearBtn = $('cfg-clear');
        let armTimer = null;
        clearBtn.addEventListener('click', () => {
            if (!clearBtn.classList.contains('armed')) {
                clearBtn.classList.add('armed');
                clearBtn.textContent = 'Tap again to clear';
                armTimer = setTimeout(() => { clearBtn.classList.remove('armed'); clearBtn.textContent = 'Clear cache'; }, 3000);
                return;
            }
            clearTimeout(armTimer);
            clearStatsCache();
            clearBtn.classList.remove('armed');
            clearBtn.textContent = 'Clear cache';
            $('cfg-cacheinfo').innerHTML = cacheSummary();
            toast('Cache cleared');
        });

        // Read every field from the DOM into a copy of S. Returns the new
        // settings, or an error string if the thresholds are out of order.
        const collect = () => {
            const next = Object.assign({}, S);
            const boolKeys = ['SHOW_NAME_TIMER_BADGE', 'ENHANCE_STATUS_CELL', 'SKIP_CHAT', 'HIDE_WHEN_NO_DATA', 'SORT_TOOLBAR', 'HIDE_OWN_FACTION', 'DEBUG'];
            const numKeys  = ['FF_GREEN', 'FF_YELLOW', 'FF_ORANGE', 'BS_YELLOW', 'BS_ORANGE', 'CACHE_HOURS', 'HOSP_ALERT_SEC'];
            const selKeys  = ['BADGE_STYLE', 'BADGE_SIZE', 'THEME'];
            boolKeys.forEach((k) => { const el = $(`cfg-${k}`); if (el) next[k] = el.checked; });
            numKeys.forEach((k) => {
                const el = $(`cfg-${k}`);
                if (el) { const v = parseFloat(el.value); if (!isNaN(v) && v >= 0) next[k] = v; }
            });
            selKeys.forEach((k) => { const el = $(`cfg-${k}`); if (el) next[k] = el.value; });
            if (!(next.FF_GREEN < next.FF_YELLOW && next.FF_YELLOW < next.FF_ORANGE))
                return 'FF thresholds must increase: green < yellow < orange.';
            if (!(next.BS_YELLOW <= next.BS_ORANGE))
                return 'BS thresholds: yellow must not exceed orange.';
            if (!(next.CACHE_HOURS > 0)) return 'Cache hours must be above 0.';
            return next;
        };

        const applyLive = () => {
            applyDisplayPrefs();
            // Re-tint existing badges and rebuild timers/status without a page reload.
            document.querySelectorAll(`a[${BADGE_ATTR}]`).forEach((link) => {
                const pid = link.getAttribute(BADGE_ATTR);
                if (pid) applyBadges(link, pid);
            });
            applyListSort();
            // If status column toggle turned off, restore original Torn text.
            if (!S.ENHANCE_STATUS_CELL) {
                document.querySelectorAll('.table-cell.status span.ellipsis[data-ffbs-orig]').forEach((span) => {
                    span.textContent = span.getAttribute('data-ffbs-orig');
                    span.removeAttribute('data-ffbs-orig');
                });
                restoreWarStatusCells();
            }
            tickTimers();
            scanPage(); // e.g. teammates un-hidden -> queue their lookups now
        };

        $('cfg-save').addEventListener('click', () => {
            const next = collect();
            if (typeof next === 'string') {
                errMsg.textContent = next;
                toast(next, true);
                return;
            }
            errMsg.textContent = '';
            S = next;
            saveSettings();
            applyLive();
            toast('Settings saved ✓');
            close();
        });

        $('cfg-reset').addEventListener('click', () => {
            resetSettings();
            close();
            applyLive();
            showConfigPanel(); // re-render with defaults
            toast('Settings reset to defaults');
        });

        $('cfg-key').addEventListener('click', () => {
            close();
            showSetupCard();
        });
    }

    /* =======================================================================
     * MAIN
     * ===================================================================== */
    async function startMain() {
        showGearButton();
        const ok = await loadOwnBattleStats();
        if (!ok && !ownStatsGaveUp) {
            if (ownStatsTimer) clearInterval(ownStatsTimer);
            ownStatsTimer = setInterval(async () => {
                if (myBattleStat != null || ownStatsGaveUp) { clearInterval(ownStatsTimer); ownStatsTimer = null; return; }
                await loadOwnBattleStats();
            }, OWN_STATS_RETRY_INTERVAL);
        }
        await fetchFactionStatuses();
        if (factionTimer) clearInterval(factionTimer);
        factionTimer = setInterval(fetchFactionStatuses, FACTION_FETCH_INTERVAL);
        if (tickTimer) clearInterval(tickTimer);
        tickTimer = setInterval(tickTimers, TIMER_TICK_INTERVAL);
        scanPage();
        startObserver();
        if (scanTimer) clearInterval(scanTimer);
        scanTimer = setInterval(scanPage, FALLBACK_SCAN_INTERVAL);
        log('Running (MutationObserver + fallback scan every ' + (FALLBACK_SCAN_INTERVAL / 1000) + 's).');
    }

    function init() {
        loadSettings();
        applyDisplayPrefs();
        injectStyles();
        loadStatsCache();
        const stored = keyGet();
        if (stored) {
            API_KEY = stored;
            // Caches written before 2.3.0 have no owner tag: adopt them.
            try { if (!localStorage.getItem(LS_CACHE_OWNER)) localStorage.setItem(LS_CACHE_OWNER, hashKey(stored)); } catch (e) {}
            log('Stored key found. Starting.');
            startMain();
        } else {
            log('No stored key. Showing setup card.');
            showSetupCard();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
