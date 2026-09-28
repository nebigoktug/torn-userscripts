// ==UserScript==
// @name         Torn FF/BS Badges
// @namespace    https://github.com/tornffbs
// @version      2.2.1
// @description  Shows FairFight + estimated Battle Stat badges next to player names on Torn. On faction pages it also adds a live hospital countdown and travel info (destination + landing time), and can rewrite the member-list Status column with live timers. Includes an in-page settings panel (⚙). Works on Torn PDA and desktop Tampermonkey.
// @author       Nebigoktug
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
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
    const LS_KEY         = 'ffbs_api_key';    // where the key is stored locally
    const LS_SETTINGS    = 'ffbs_settings';   // where the ⚙ panel settings live
    const SCAN_INTERVAL  = 1500;              // page re-scan (PDA SPA), ms
    const BATCH_SIZE     = 200;               // FFScouter targets per request (max 205)
    const RATELIMIT_MS   = 8000;              // backoff after a 429
    const TEMP_BACKOFF_MS = 10000;            // backoff after a network/5xx/bad-JSON error
    const BADGE_ATTR     = 'data-ffbs';       // marks a decorated wrapper

    const FACTION_FETCH_INTERVAL   = 60000;   // refresh faction status, ms
    const TIMER_TICK_INTERVAL      = 1000;    // redraw countdowns, ms
    const OWN_STATS_RETRY_INTERVAL = 15000;   // retry own battle stats if it failed, ms
    const STATS_TTL_MS             = 600000;  // FFScouter stats cache lifetime, ms (10 min)

    // -------- User-configurable settings (defaults). Overridden by ⚙ panel. -----
    const SETTINGS_DEFAULTS = {
        // Feature toggles
        SHOW_NAME_TIMER_BADGE: true,   // hospital/travel pill on the avatar corner
        ENHANCE_STATUS_CELL:   true,   // rewrite the faction "Status" column
        SKIP_CHAT:             true,   // don't badge names inside the chat box
        HIDE_WHEN_NO_DATA:     true,   // draw nothing (not "?") when FF & BS unknown
        // FF colour thresholds
        FF_GREEN:  1.5,
        FF_YELLOW: 2.25,
        FF_ORANGE: 3.0,
        // BS colour thresholds (multiples of your own total)
        BS_YELLOW: 1.10,
        BS_ORANGE: 1.25,
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
    let currentFactionId = undefined; // faction id we last fetched status for

    const userStatus       = new Map(); // pid -> { state, until, description, ts }
    const pendingUserFetch = new Set();  // pids with an in-flight user fetch
    const USER_STATUS_TTL_MS = 120000;   // re-fetch a user's status after 2 min
    const userFetchQueue   = [];         // pids waiting for a user-status fetch
    const USER_FETCH_GAP_MS = 1500;      // min gap between user fetches (<= 40/min)
    let userQueueTimer     = null;

    let scanTimer = null, factionTimer = null, tickTimer = null, ownStatsTimer = null;

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
            console.log('[FFBS] Torn API rate-limited; backing off 15s.');
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
     * STYLES
     * ===================================================================== */
    function injectStyles() {
        if (document.getElementById('ffbs-styles')) return;
        const style = document.createElement('style');
        style.id = 'ffbs-styles';
        style.textContent = `
        .ffbs-wrap { position: relative !important; display: inline-block; }
        .ffbs-badge {
            position: absolute; z-index: 9999;
            font-size: 9px; line-height: 1; font-weight: 800;
            font-family: Arial, Helvetica, sans-serif;
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
        .ffbs-green  { border-color: #2ecc40; background-color: rgba(46,204,64,0.5); }
        .ffbs-yellow { border-color: #ffdc00; background-color: rgba(255,220,0,0.5); }
        .ffbs-orange { border-color: #ff851b; background-color: rgba(255,133,27,0.5); }
        .ffbs-red    { border-color: #ff4136; background-color: rgba(255,65,54,0.5); }
        .ffbs-grey   { border-color: #aaaaaa; background-color: rgba(170,170,170,0.5); }
        .ffbs-timer {
            top: -7px; left: -7px; border-radius: 7px; border: 1.5px solid;
            padding: 1px 4px; font-size: 8px; white-space: nowrap;
        }
        .ffbs-timer-hosp   { border-color: #ff4136; background-color: rgba(255,65,54,0.6); }
        .ffbs-timer-travel { border-color: #39a0ff; background-color: rgba(57,160,255,0.6); }
        #ffbs-setup {
            position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.85);
            display: flex; align-items: center; justify-content: center;
            font-family: Arial, Helvetica, sans-serif;
        }
        #ffbs-setup .ffbs-card {
            position: relative; background: #1f2227; color: #eee; width: 320px; max-width: 90vw;
            padding: 22px; border-radius: 10px; border: 1px solid #3a3f47;
            box-shadow: 0 8px 30px rgba(0,0,0,0.6);
        }
        #ffbs-setup h2 { margin: 0 0 6px; font-size: 17px; }
        #ffbs-setup p  { margin: 0 0 14px; font-size: 12px; color: #aaa; }
        #ffbs-setup a  { color: #4aa3ff; text-decoration: underline; }
        #ffbs-setup input {
            width: 100%; box-sizing: border-box; padding: 9px; font-size: 13px;
            background: #15171b; color: #eee; border: 1px solid #3a3f47; border-radius: 6px;
            margin-bottom: 10px;
        }
        #ffbs-setup button {
            width: 100%; padding: 9px; font-size: 13px; font-weight: 700;
            background: #2ecc40; color: #0a0a0a; border: none; border-radius: 6px; cursor: pointer;
        }
        #ffbs-setup button:disabled { opacity: 0.6; cursor: default; }
        #ffbs-setup .ffbs-msg  { margin-top: 10px; font-size: 12px; min-height: 16px; }
        #ffbs-setup .ffbs-err  { color: #ff6b61; }
        #ffbs-setup .ffbs-info { color: #ffdc00; }
        #ffbs-setup .ffbs-close {
            position: absolute; top: 8px; right: 10px; width: 26px; height: 26px; padding: 0;
            background: transparent; color: #aaa; font-size: 20px; line-height: 26px;
            text-align: center; cursor: pointer; border: none;
        }
        #ffbs-setup .ffbs-close:hover { color: #fff; }
        #ffbs-reopen {
            position: fixed; right: 12px; bottom: 70px; z-index: 2147483646;
            padding: 7px 11px; font-size: 12px; font-weight: 700;
            background: #2ecc40; color: #0a0a0a; border: none; border-radius: 18px; cursor: pointer;
            box-shadow: 0 3px 12px rgba(0,0,0,0.5); font-family: Arial, Helvetica, sans-serif;
        }

        /* ---- Settings gear button ---- */
        #ffbs-gear {
            position: fixed; right: 12px; bottom: 110px; z-index: 2147483646;
            width: 38px; height: 38px; padding: 0; font-size: 18px; line-height: 38px;
            text-align: center; background: #1f2227; color: #2ecc40;
            border: 1px solid #3a3f47; border-radius: 50%; cursor: pointer;
            box-shadow: 0 3px 12px rgba(0,0,0,0.5); font-family: Arial, Helvetica, sans-serif;
        }
        #ffbs-gear:hover { color: #fff; border-color: #2ecc40; }

        /* ---- Settings panel (reuses setup overlay look) ---- */
        #ffbs-config { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.85);
            display: flex; align-items: center; justify-content: center; font-family: Arial, Helvetica, sans-serif; }
        #ffbs-config .ffbs-card {
            position: relative; background: #1f2227; color: #eee; width: 340px; max-width: 92vw;
            max-height: 88vh; overflow-y: auto;
            padding: 20px; border-radius: 10px; border: 1px solid #3a3f47; box-shadow: 0 8px 30px rgba(0,0,0,0.6);
        }
        #ffbs-config h2 { margin: 0 0 4px; font-size: 17px; }
        #ffbs-config .ffbs-sub { margin: 0 0 14px; font-size: 12px; color: #aaa; }
        #ffbs-config .ffbs-section { font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
            color: #2ecc40; font-weight: 700; margin: 14px 0 6px; border-bottom: 1px solid #3a3f47; padding-bottom: 4px; }
        #ffbs-config .ffbs-row { display: flex; align-items: center; justify-content: space-between;
            gap: 10px; padding: 6px 0; font-size: 13px; }
        #ffbs-config .ffbs-row label { flex: 1; cursor: pointer; }
        #ffbs-config .ffbs-row .hint { display: block; font-size: 10px; color: #888; margin-top: 2px; }
        #ffbs-config input[type="number"] {
            width: 70px; box-sizing: border-box; padding: 6px; font-size: 13px; text-align: right;
            background: #15171b; color: #eee; border: 1px solid #3a3f47; border-radius: 6px;
        }
        #ffbs-config input[type="checkbox"] { width: 18px; height: 18px; accent-color: #2ecc40; cursor: pointer; }
        #ffbs-config .ffbs-actions { display: flex; gap: 8px; margin-top: 18px; }
        #ffbs-config .ffbs-actions button { flex: 1; padding: 9px; font-size: 13px; font-weight: 700;
            border: none; border-radius: 6px; cursor: pointer; }
        #ffbs-config .btn-save  { background: #2ecc40; color: #0a0a0a; }
        #ffbs-config .btn-reset { background: #3a3f47; color: #eee; }
        #ffbs-config .btn-key   { background: #15171b; color: #4aa3ff; border: 1px solid #3a3f47 !important; }
        #ffbs-config .ffbs-close {
            position: absolute; top: 8px; right: 10px; width: 26px; height: 26px; padding: 0;
            background: transparent; color: #aaa; font-size: 20px; line-height: 26px;
            text-align: center; cursor: pointer; border: none;
        }
        #ffbs-config .ffbs-close:hover { color: #fff; }
        #ffbs-config .ffbs-saved { text-align: center; font-size: 12px; color: #ffdc00; min-height: 16px; margin-top: 8px; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    /* =======================================================================
     * OWN BATTLE STATS
     * ===================================================================== */
    async function loadOwnBattleStats() {
        if (Date.now() < tornPausedUntil) return false;
        try {
            const resp = await httpGet(`https://api.torn.com/v2/user/battlestats?key=${encodeURIComponent(API_KEY)}`);
            const cat = classify(resp.status, resp.text);
            if (cat === 'auth') { clearKeyAndReopenSetup(); return false; }
            if (handleTornBackoff(cat)) return false;
            if (cat !== 'ok') {
                console.log('[FFBS] Own battle stats fetch failed; will retry. BS stays grey.');
                return false;
            }
            const data = JSON.parse(resp.text);
            if (data.error) {
                if (data.error.code === 16) {
                    ownStatsGaveUp = true;
                    console.log('[FFBS] Key has no battle-stats access (error 16). BS stays grey.');
                } else {
                    console.log(`[FFBS] Battle stats API error ${data.error.code}; will retry.`);
                }
                return false;
            }
            const bs = data.battlestats || data;
            const total = Number(bs.total) ||
                (Number(bs.strength) + Number(bs.defense) + Number(bs.speed) + Number(bs.dexterity));
            if (total && !isNaN(total) && total > 0) {
                myBattleStat = total;
                console.log(`[FFBS] Own battle stats loaded: ${compact(total)}.`);
                recolorBS();
                return true;
            }
            return false;
        } catch (e) {
            console.log('[FFBS] Own battle stats fetch threw; will retry.', e);
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
    async function fetchFactionStatuses() {
        if (!API_KEY || factionFetching || Date.now() < tornPausedUntil) return;
        factionFetching = true;
        try {
            const fid = getViewedFactionId();
            if (fid !== currentFactionId) {
                factionStatus.clear();
                currentFactionId = fid;
                tickTimers();
            }
            const path = fid ? `faction/${fid}` : 'faction/';
            const resp = await httpGet(`https://api.torn.com/${path}?selections=basic&key=${encodeURIComponent(API_KEY)}`);
            const cat = classify(resp.status, resp.text);
            if (cat === 'auth') { clearKeyAndReopenSetup(); return; }
            if (handleTornBackoff(cat)) return;
            if (cat !== 'ok') return;
            let data;
            try { data = JSON.parse(resp.text); } catch (e) { return; }
            if (data.error) return;
            const members = data.members || {};
            const seen = new Set();
            Object.keys(members).forEach((pid) => {
                const st = members[pid] && members[pid].status;
                if (!st) return;
                seen.add(pid);
                factionStatus.set(pid, {
                    state: st.state || null,
                    until: Number(st.until) || 0,
                    description: st.description || ''
                });
            });
            Array.from(factionStatus.keys()).forEach((pid) => { if (!seen.has(pid)) factionStatus.delete(pid); });
            console.log(`[FFBS] Faction status: ${seen.size} member(s) (faction ${currentFactionId || 'own'}).`);
            tickTimers();
        } catch (e) {
            console.log('[FFBS] Faction status fetch failed.', e);
        } finally {
            factionFetching = false;
        }
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
            const resp = await httpGet(`https://api.torn.com/user/${pid}?selections=profile&key=${encodeURIComponent(API_KEY)}`);
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
            const st = data.status || {};
            userStatus.set(pid, {
                state: st.state || null,
                until: Number(st.until) || 0,
                description: st.description || '',
                ts: Date.now()
            });
            document.querySelectorAll(`.ffbs-wrap[${BADGE_ATTR}="${pid}"]`).forEach((wrap) => {
                applyTimerBadge(wrap, pid);
            });
        } catch (e) {
            userStatus.set(pid, { state: null, until: 0, description: '', ts: Date.now() });
            console.log(`[FFBS] User status fetch failed for ${pid}.`, e);
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
                catch (e) { pausedUntil = Date.now() + TEMP_BACKOFF_MS; console.log('[FFBS] Stats fetch network error; backing off.'); break; }
                const cat = classify(resp.status, resp.text);
                if (cat === 'auth')      { console.log('[FFBS] Invalid key. Reopening setup.'); clearKeyAndReopenSetup(); break; }
                if (cat === 'ratelimit') { pausedUntil = Date.now() + RATELIMIT_MS; console.log('[FFBS] Rate limited; backing off.'); break; }
                if (cat === 'temp')      { pausedUntil = Date.now() + TEMP_BACKOFF_MS; console.log('[FFBS] FFScouter temp error; backing off.'); break; }
                let data;
                try { data = JSON.parse(resp.text); }
                catch (e) { pausedUntil = Date.now() + TEMP_BACKOFF_MS; console.log('[FFBS] Bad FFScouter JSON; backing off.'); break; }
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
                applyAllResolved();
            }
        } finally {
            fetching = false;
        }
    }

    /* =======================================================================
     * BADGE RENDERING
     * ===================================================================== */
    function ensureWrapper(link) {
        if (link.parentElement && link.parentElement.classList.contains('ffbs-wrap')) return link.parentElement;
        if (link.classList.contains('ffbs-wrap')) return link;
        try {
            const span = document.createElement('span');
            span.className = 'ffbs-wrap';
            link.parentNode.insertBefore(span, link);
            span.appendChild(link);
            return span;
        } catch (e) {
            link.classList.add('ffbs-wrap');
            return link;
        }
    }
    function applyBadges(wrap, pid) {
        const data = statsCache.get(pid);
        if (!data) return;
        const ffKnown = data.ff != null && !isNaN(data.ff);
        const bsKnown = data.bsRaw != null && !isNaN(data.bsRaw);
        if (S.HIDE_WHEN_NO_DATA && !ffKnown && !bsKnown) {
            wrap.querySelectorAll('.ffbs-badge:not(.ffbs-timer)').forEach((b) => b.remove());
            wrap.setAttribute(BADGE_ATTR, pid);
            applyTimerBadge(wrap, pid);
            return;
        }
        wrap.querySelectorAll('.ffbs-badge:not(.ffbs-timer)').forEach((b) => b.remove());
        const ff = document.createElement('span');
        ff.className = `ffbs-badge ffbs-ff ${ffTier(data.ff)}`;
        ff.textContent = formatFF(data.ff);
        ff.title = `FairFight: ${formatFF(data.ff)}`;
        wrap.appendChild(ff);
        const bs = document.createElement('span');
        bs.className = `ffbs-badge ffbs-bs ${bsTier(data.bsRaw)}`;
        bs.textContent = formatBS(data.bsHuman, data.bsRaw);
        bs.title = `Estimated battle stats: ${formatBS(data.bsHuman, data.bsRaw)}`;
        if (bsKnown) bs.setAttribute('data-bsraw', String(data.bsRaw));
        wrap.appendChild(bs);
        wrap.setAttribute(BADGE_ATTR, pid);
        applyTimerBadge(wrap, pid);
    }
    function recolorBS() {
        document.querySelectorAll('.ffbs-bs[data-bsraw]').forEach((b) => {
            const raw = Number(b.getAttribute('data-bsraw'));
            b.classList.remove('ffbs-green', 'ffbs-yellow', 'ffbs-orange', 'ffbs-red', 'ffbs-grey');
            b.classList.add(bsTier(raw));
        });
    }
    function applyTimerBadge(wrap, pid) {
        if (!S.SHOW_NAME_TIMER_BADGE) {
            const existing = wrap.querySelector('.ffbs-timer');
            if (existing) existing.remove();
            return;
        }
        const status = resolveStatus(pid, wrap);
        let badge = wrap.querySelector('.ffbs-timer');
        const remove = () => { if (badge) badge.remove(); };
        const ensure = (cls) => {
            if (!badge) { badge = document.createElement('span'); wrap.appendChild(badge); }
            badge.className = `ffbs-badge ffbs-timer ${cls}`;
            return badge;
        };
        if (!status || !status.state) { remove(); return; }
        const remaining = status.until ? status.until - Math.floor(Date.now() / 1000) : 0;
        if (TIMER_STATES.includes(status.state)) {
            if (remaining <= 0) { remove(); return; }
            ensure('ffbs-timer-hosp');
            badge.textContent = formatDuration(remaining);
            badge.title = `${status.state}: out in ${badge.textContent}`;
            return;
        }
        if (status.state === 'Traveling' || status.state === 'Abroad') {
            const t = parseTravel(status);
            ensure('ffbs-timer-travel');
            if (t.direction === 'abroad' || remaining <= 0) {
                badge.textContent = t.abbr;
                badge.title = status.description || `Abroad: ${t.country || t.abbr}`;
            } else {
                badge.textContent = `${t.abbr} ${formatDuration(remaining)}`;
                badge.title = `${status.description} — lands in ${formatDuration(remaining)}`;
            }
            return;
        }
        remove();
    }
    function applyAllResolved() {
        const skipSel = S.SKIP_CHAT ? SKIP_CONTAINERS.join(',') : null;
        document.querySelectorAll('a[href*="XID="]').forEach((link) => {
            const m = link.href.match(/XID=(\d+)/);
            if (!m || !statsCache.has(m[1])) return;
            if (skipSel && link.closest(skipSel)) return;
            const wrap = ensureWrapper(link);
            if (!wrap || wrap.getAttribute(BADGE_ATTR) === m[1]) return;
            applyBadges(wrap, m[1]);
        });
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
    function enhanceStatusCells() {
        if (!S.ENHANCE_STATUS_CELL) return;
        document.querySelectorAll('.table-cell.status span.ellipsis').forEach((span) => {
            const row = span.closest('.table-row');
            if (!row) return;
            const a = row.querySelector('a[href*="XID="]');
            if (!a) return;
            const m = a.href.match(/XID=(\d+)/);
            if (!m) return;
            const text = buildStatusText(factionStatus.get(m[1]));
            if (text == null) {
                if (span.hasAttribute('data-ffbs-orig')) {
                    span.textContent = span.getAttribute('data-ffbs-orig');
                    span.removeAttribute('data-ffbs-orig');
                }
                return;
            }
            if (span.getAttribute('data-ffbs-orig') == null) span.setAttribute('data-ffbs-orig', span.textContent);
            if (span.textContent !== text) span.textContent = text;
        });
    }

    /* =======================================================================
     * SCAN + TICK
     * ===================================================================== */
    function scanPage() {
        if (!API_KEY) return;
        if (getViewedFactionId() !== currentFactionId) fetchFactionStatuses();
        const skipSel = S.SKIP_CHAT ? SKIP_CONTAINERS.join(',') : null;
        document.querySelectorAll('a[href*="XID="]').forEach((link) => {
            const m = link.href.match(/XID=(\d+)/);
            if (!m) return;
            const pid = m[1];
            if (skipSel && link.closest(skipSel)) return;
            const wrap = ensureWrapper(link);
            const cached = statsCache.get(pid);
            const fresh  = cached && (Date.now() - (cached.ts || 0) < STATS_TTL_MS);
            if (wrap && wrap.getAttribute(BADGE_ATTR) === pid && fresh) return;
            if (!wrap) return;
            if (fresh) {
                applyBadges(wrap, pid);
            } else {
                if (cached) applyBadges(wrap, pid);
                pending.add(pid);
            }
        });
        if (pending.size > 0) scheduleFetch();
    }
    function tickTimers() {
        if (S.SHOW_NAME_TIMER_BADGE) {
            document.querySelectorAll(`.ffbs-wrap[${BADGE_ATTR}]`).forEach((wrap) => {
                const pid = wrap.getAttribute(BADGE_ATTR);
                if (pid) applyTimerBadge(wrap, pid);
            });
        }
        enhanceStatusCells();
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
            try { localStorage.setItem(LS_KEY, key); } catch (e) {}
            API_KEY = key;
            setMsg('Key verified. Starting…', 'ffbs-info');
            console.log('[FFBS] API key verified and saved.');
            setTimeout(() => { overlay.remove(); startMain(); }, 500);
        }
        btn.addEventListener('click', doSave);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    }
    function clearKeyAndReopenSetup() {
        try { localStorage.removeItem(LS_KEY); } catch (e) {}
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
    function showGearButton() {
        if (document.getElementById('ffbs-gear')) return;
        const b = document.createElement('button');
        b.id = 'ffbs-gear';
        b.textContent = '⚙';
        b.title = 'FF/BS Badges settings';
        b.addEventListener('click', showConfigPanel);
        (document.body || document.documentElement).appendChild(b);
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

        overlay.innerHTML = `
            <div class="ffbs-card">
                <button class="ffbs-close" id="cfg-close" title="Close">&times;</button>
                <h2>FF/BS Badges — Settings</h2>
                <p class="ffbs-sub">Changes apply immediately. Stored locally on this device.</p>

                <div class="ffbs-section">Display</div>
                ${toggleRow('SHOW_NAME_TIMER_BADGE', 'Hospital / travel pill', 'Countdown badge on the avatar corner')}
                ${toggleRow('ENHANCE_STATUS_CELL', 'Rewrite faction Status column', 'Live timers in the member list')}
                ${toggleRow('SKIP_CHAT', 'Skip chat box', "Don't badge names inside chat")}
                ${toggleRow('HIDE_WHEN_NO_DATA', 'Hide empty badges', 'Draw nothing when FF & BS unknown')}

                <div class="ffbs-section">FairFight colour thresholds</div>
                ${numRow('FF_GREEN', 'Green below', 'FF under this = green', '0.05')}
                ${numRow('FF_YELLOW', 'Yellow below', 'FF under this = yellow', '0.05')}
                ${numRow('FF_ORANGE', 'Orange below', 'FF under this = orange, above = red', '0.05')}

                <div class="ffbs-section">Battle-stat colour thresholds</div>
                <p class="ffbs-sub" style="margin:0 0 4px;">Multiples of your own total BS.</p>
                ${numRow('BS_YELLOW', 'Yellow up to', 'e.g. 1.10 = +10% over you', '0.05')}
                ${numRow('BS_ORANGE', 'Orange up to', 'e.g. 1.25 = +25% over you', '0.05')}

                <div class="ffbs-actions">
                    <button class="btn-save"  id="cfg-save">Save</button>
                    <button class="btn-reset" id="cfg-reset">Reset</button>
                </div>
                <div class="ffbs-actions" style="margin-top:8px;">
                    <button class="btn-key" id="cfg-key">Change API key</button>
                </div>
                <div class="ffbs-saved" id="cfg-saved"></div>
            </div>`;
        (document.body || document.documentElement).appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelector('#cfg-close').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        const savedMsg = overlay.querySelector('#cfg-saved');

        // Read every field from the DOM into S.
        const collect = () => {
            const boolKeys = ['SHOW_NAME_TIMER_BADGE', 'ENHANCE_STATUS_CELL', 'SKIP_CHAT', 'HIDE_WHEN_NO_DATA'];
            const numKeys  = ['FF_GREEN', 'FF_YELLOW', 'FF_ORANGE', 'BS_YELLOW', 'BS_ORANGE'];
            boolKeys.forEach((k) => { const el = overlay.querySelector(`#cfg-${k}`); if (el) S[k] = el.checked; });
            numKeys.forEach((k) => {
                const el = overlay.querySelector(`#cfg-${k}`);
                if (el) { const v = parseFloat(el.value); if (!isNaN(v) && v >= 0) S[k] = v; }
            });
        };

        const applyLive = () => {
            // Re-tint existing badges and rebuild timers/status without a page reload.
            document.querySelectorAll(`.ffbs-wrap[${BADGE_ATTR}]`).forEach((wrap) => {
                const pid = wrap.getAttribute(BADGE_ATTR);
                if (pid) applyBadges(wrap, pid);
            });
            // If status column toggle turned off, restore original Torn text.
            if (!S.ENHANCE_STATUS_CELL) {
                document.querySelectorAll('.table-cell.status span.ellipsis[data-ffbs-orig]').forEach((span) => {
                    span.textContent = span.getAttribute('data-ffbs-orig');
                    span.removeAttribute('data-ffbs-orig');
                });
            }
            tickTimers();
        };

        overlay.querySelector('#cfg-save').addEventListener('click', () => {
            collect();
            saveSettings();
            applyLive();
            savedMsg.textContent = 'Saved ✓';
            setTimeout(() => { savedMsg.textContent = ''; }, 1500);
        });

        overlay.querySelector('#cfg-reset').addEventListener('click', () => {
            resetSettings();
            close();
            showConfigPanel(); // re-render with defaults
            applyLive();
        });

        overlay.querySelector('#cfg-key').addEventListener('click', () => {
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
        if (scanTimer) clearInterval(scanTimer);
        scanTimer = setInterval(scanPage, SCAN_INTERVAL);
        console.log(`[FFBS] Running. Re-scan every ${SCAN_INTERVAL / 1000}s.`);
    }

    function init() {
        loadSettings();
        injectStyles();
        let stored = null;
        try { stored = localStorage.getItem(LS_KEY); } catch (e) {}
        if (stored && stored.trim()) {
            API_KEY = stored.trim();
            console.log('[FFBS] Stored key found. Starting.');
            startMain();
        } else {
            console.log('[FFBS] No stored key. Showing setup card.');
            showSetupCard();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
