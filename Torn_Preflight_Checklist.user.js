// ==UserScript==
// @name         Torn Pre-flight Checklist
// @namespace    https://github.com/nebigoktug
// @version      1.5.1
// @description  Before you fly: will your energy or nerve cap while you're away, will a drug / booster cooldown run out mid-flight, is your cash right for the trip, and is there a ranked war, chain or Organized Crime you'd miss. Checks against the real round-trip time for the destination and flight type you pick on the Travel Agency. Display only, no automation.
// @author       Nebigoktug
// @license      MIT
// @supportURL   https://github.com/nebigoktug/torn-userscripts/issues
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Preflight_Checklist.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Preflight_Checklist.user.js
// ==/UserScript==

/*
 * Torn Pre-flight Checklist
 *
 * Your sidebar already shows bars and cooldowns; this answers the question it
 * can't: "is anything going to go to waste, or go wrong, while I'm away?"
 * Everything is compared with the round trip for the destination and flight
 * type you pick (flight times from the Torn wiki, June 2026 figures).
 *
 * Data: one Torn API call (user: bars, cooldowns, organizedcrime, travel;
 * Minimal key) plus faction/wars for ranked wars, and your cash as shown in
 * Torn's own sidebar. It only reads and shows. It never books, buys or clicks.
 */

(function () {
    'use strict';

    // Torn PDA may inject on any URL containing "torn"; only run on the game.
    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;
    // Torn PDA can inject the script again on in-page navigation. Without this
    // guard every copy kept its own timers and observers, and the page got
    // slower the longer PDA stayed open.
    if (window.__tpcRunning) return;
    window.__tpcRunning = true;

    const VERSION  = '1.5.1';
    const REPO_URL = 'https://github.com/nebigoktug/torn-userscripts';
    const LS_KEY   = 'tpc_api_key';
    const LS_PREFS = 'tpc_prefs';
    const LS_BANNER_POS = 'tpc_banner_pos';
    const DATA_TTL_MS   = 60 * 1000;        // reuse API data for a minute
    const RATE_PAUSE_MS = 60 * 1000;

    // One-way flight times in minutes, from the Torn wiki's Travel page
    // (after the 23 June 2026 travel update). Standard ticket price in $.
    // The "Mailing Yourself Abroad" book cuts another 25%.
    const DESTINATIONS = [
        { name: 'Mexico',         Standard: 24,  Airstrip: 17,  Private: 12,  Business: 7,  cost: 6500 },
        { name: 'Cayman Islands', Standard: 33,  Airstrip: 23,  Private: 17,  Business: 10, cost: 10000 },
        { name: 'Canada',         Standard: 39,  Airstrip: 27,  Private: 19,  Business: 12, cost: 9000 },
        { name: 'Hawaii',         Standard: 127, Airstrip: 89,  Private: 63,  Business: 38, cost: 11000 },
        { name: 'United Kingdom', Standard: 151, Airstrip: 106, Private: 75,  Business: 45, cost: 18000 },
        { name: 'Argentina',      Standard: 158, Airstrip: 111, Private: 79,  Business: 47, cost: 21000 },
        { name: 'Switzerland',    Standard: 166, Airstrip: 116, Private: 83,  Business: 50, cost: 27000 },
        { name: 'Japan',          Standard: 213, Airstrip: 149, Private: 107, Business: 64, cost: 32000 },
        { name: 'China',          Standard: 229, Airstrip: 160, Private: 114, Business: 69, cost: 35000 },
        { name: 'UAE',            Standard: 257, Airstrip: 180, Private: 128, Business: 77, cost: 32000 },
        { name: 'South Africa',   Standard: 282, Airstrip: 197, Private: 141, Business: 85, cost: 40000 },
    ];
    const METHODS = { Standard: 'Standard', Airstrip: 'Airstrip', Private: 'Private (WLT)', Business: 'Business class' };
    const BOOK_FACTOR = 0.75;
    const CHAIN_MIN = 10;        // chains below this aren't worth a warning
    const OC_MARGIN = 1.5;       // warn when the OC is ready within 1.5x the round trip

    // How a destination shows up on the Travel Agency: country, city, or the
    // map pin image name (e.g. "pinpoints_switzerland").
    const DEST_PATTERNS = {
        'Mexico':         /mexico|ciudad ju[aá]rez/i,
        'Cayman Islands': /cayman|george ?town/i,
        'Canada':         /canada|toronto/i,
        'Hawaii':         /hawaii|honolulu/i,
        'United Kingdom': /united[\s_-]*kingdom|london|pinpoints_uk\b|\bUK\b/i,
        'Argentina':      /argentina|buenos aires/i,
        'Switzerland':    /switzerland|z[uü]rich/i,
        'Japan':          /japan|tokyo/i,
        'China':          /china|beijing/i,
        'UAE':            /\bUAE\b|united arab emirates|dubai/i,
        'South Africa':   /south[\s_-]*africa|johannesburg/i,
    };
    const METHOD_PATTERNS = { Standard: /\bstandard\b/i, Airstrip: /\bairstrip\b/i, Private: /\bprivate\b|\bWLT\b/i, Business: /\bbusiness\b/i };

    const DEFAULT_PREFS = { dest: '', method: '', book: false, stayMin: 5, budget: 0 };

    // ------------------------------------------------------------ storage
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    let prefs = (() => {
        try { return Object.assign({}, DEFAULT_PREFS, JSON.parse(lsGet(LS_PREFS) || '{}')); }
        catch (e) { return Object.assign({}, DEFAULT_PREFS); }
    })();
    const savePrefs = () => lsSet(LS_PREFS, JSON.stringify(prefs));

    // ------------------------------------------------------------ helpers
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const money = (n) => {
        if (n == null || isNaN(n)) return '—';
        const a = Math.abs(n);
        if (a >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'b';
        if (a >= 1e6) return '$' + (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'm';
        if (a >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
        return '$' + Math.round(n);
    };
    const dur = (sec) => {
        const m = Math.max(0, Math.round(sec / 60));
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60), r = m % 60;
        return r ? `${h}h ${r}m` : `${h}h`;
    };
    const now = () => Math.floor(Date.now() / 1000);
    const destOf = (name) => DESTINATIONS.find((d) => d.name === name) || null;

    // Round trip in seconds for the chosen trip: out, stay, back.
    function tripSeconds(p) {
        const d = destOf(p.dest);
        if (!d) return null;
        const oneWay = d[p.method] * (p.book ? BOOK_FACTOR : 1) * 60;
        return { oneWay, total: 2 * oneWay + Math.max(0, Number(p.stayMin) || 0) * 60 };
    }

    // Cash in hand as shown in Torn's own sidebar (the page you're viewing).
    function sidebarCash() {
        const el = document.getElementById('user-money');
        if (!el) return null;
        const raw = el.getAttribute('data-money') || el.textContent || '';
        const n = Number(String(raw).replace(/[^0-9]/g, ''));
        return raw && !isNaN(n) ? n : null;
    }

    // ------------------------------------------------------------ Torn API
    class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
    let pausedUntil = 0;
    async function api(path, key) {
        if (Date.now() < pausedUntil) throw new ApiError(5, 'Torn API limit reached, wait a minute.');
        const sep = path.includes('?') ? '&' : '?';
        let resp;
        try {
            resp = await fetch(`https://api.torn.com/v2/${path}${sep}key=${encodeURIComponent(key)}&comment=PreflightChecklist`);
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
                16: 'Key access level is too low — use at least a Minimal key.',
                18: 'API key is paused.',
            }[c] || `Torn API error ${c}: ${data.error.error}`;
            throw new ApiError(c, msg);
        }
        return data;
    }

    let cache = null; // { ts, user, wars }
    async function loadData(key, force) {
        if (!force && cache && Date.now() - cache.ts < DATA_TTL_MS) return cache;
        const user = await api('user?selections=bars,cooldowns,organizedcrime,travel', key);
        let wars = null;
        try { wars = await api('faction/wars', key); } catch (e) { if (e.code === 2) throw e; } // not in a faction etc.
        cache = { ts: Date.now(), user, wars };
        // First run: default the trip to the last one you flew.
        const t = user.travel || {};
        if (!prefs.dest && t.destination && destOf(t.destination)) prefs.dest = t.destination;
        if (!prefs.method && t.method && METHODS[t.method]) prefs.method = t.method;
        if (!prefs.dest) prefs.dest = 'Mexico';
        if (!prefs.method) prefs.method = 'Standard';
        savePrefs();
        return cache;
    }

    // Seconds until you land, if you're in the air right now (0 otherwise).
    function inFlight(data) {
        const t = data && data.user && data.user.travel;
        return t && Number(t.time_left) > 0 ? Number(t.time_left) : 0;
    }

    // Landed somewhere other than Torn. Abroad the shop page has the same
    // address as the Travel Agency, but there's no flight to check from there.
    function abroad(data) {
        const t = data && data.user && data.user.travel;
        return !!(t && t.destination && t.destination !== 'Torn' && !(Number(t.time_left) > 0));
    }

    // ------------------------------------------------------------ checks
    // Each check: { level: 'ok' | 'warn' | 'bad' | 'info', title, text, short }
    // `short` is the one-liner shown in the Travel Agency banner (warn/bad only).
    function barCheck(label, bar, away, spendHint) {
        if (!bar) return null;
        const cur = Number(bar.current) || 0, max = Number(bar.maximum) || 0;
        if (cur > max) {
            return { level: 'ok', title: label, text: `Stacked above max (${cur}/${max}): no regen to lose while you're away.` };
        }
        if (cur >= max) {
            return { level: 'bad', title: label, short: `${label} already full`,
                text: `Already full: every minute of the ${dur(away)} trip is wasted regen. ${spendHint}` };
        }
        const full = Number(bar.full_time) || 0;
        if (full < away) {
            const wasted = away - full;
            const per = (Number(bar.increment) || 0) / Math.max(1, Number(bar.interval) || 1);
            const lost = Math.floor(wasted * per);
            return { level: 'warn', title: label, short: `${label} caps in ${dur(full)} (~${lost} wasted)`,
                text: `Full in ${dur(full)}, you're back in ${dur(away)}: about ${lost} ${label.toLowerCase()} of regen wasted. ${spendHint}` };
        }
        return { level: 'ok', title: label, text: `Won't cap: full in ${dur(full)}, you're back in ${dur(away)}.` };
    }
    function cooldownCheck(label, left, away, what) {
        if (left == null) return null;
        if (left <= 0) {
            return { level: 'warn', title: `${label} cooldown`, short: `${label} cooldown empty`, text: `Empty: nothing is ticking while you fly. Take ${what} before you go (or carry one; drugs can be used abroad from your travel inventory).` };
        }
        if (left < away) {
            return { level: 'warn', title: `${label} cooldown`, short: `${label} cooldown ends ${dur(away - left)} before you're back`, text: `Runs out in ${dur(left)}, ${dur(away - left)} before you're back.` };
        }
        return { level: 'ok', title: `${label} cooldown`, text: `Covers the trip (${dur(left)} left).` };
    }
    function buildChecks(data, trip) {
        const u = data.user || {};
        const bars = u.bars || {}, cd = u.cooldowns || {};
        const away = trip.total, t = now();
        const out = { bars: [], cooldowns: [], cash: [], faction: [] };
        const push = (list, c) => { if (c) list.push(c); };

        // --- energy & nerve
        push(out.bars, barCheck('Energy', bars.energy, away, 'Use it first (gym, hits) — or attack abroad.'));
        push(out.bars, barCheck('Nerve', bars.nerve, away, 'Do some crimes first.'));

        // --- cooldowns
        push(out.cooldowns, cooldownCheck('Drug', cd.drug, away, 'a drug'));
        push(out.cooldowns, cooldownCheck('Booster', cd.booster, away, 'a booster'));

        // --- cash
        const cash = sidebarCash();
        const d = destOf(prefs.dest);
        const ticket = prefs.method === 'Standard' && d ? d.cost : 0;
        const budget = Math.max(0, Number(prefs.budget) || 0);
        const need = budget + ticket;
        if (cash == null) {
            out.cash.push({ level: 'info', title: 'Cash', text: "Couldn't read your cash from the sidebar." });
        } else if (cash < need) {
            out.cash.push({ level: 'bad', title: 'Cash', short: `Cash short: withdraw ${money(need - cash)}`, text: `${money(cash)} on hand, but the trip needs ${money(need)}` +
                `${ticket ? ` (ticket ${money(ticket)}${budget ? ` + ${money(budget)} shopping` : ''})` : ''}. Withdraw ${money(need - cash)}.` });
        } else if (budget > 0 && cash > need * 1.5 + 100000) {
            out.cash.push({ level: 'warn', title: 'Cash', short: `Bank the extra ${money(cash - need)} before you go`, text: `${money(cash)} on hand, you plan to spend ${money(need)}. ` +
                `Bank the extra ${money(cash - need)} — cash in hand can be mugged abroad.` });
        } else if (budget === 0 && cash > ticket + 1000000) {
            out.cash.push({ level: 'info', title: 'Cash', text: `${money(cash)} on hand. Set a shopping budget below to check it against your plans.` });
        } else {
            out.cash.push({ level: 'ok', title: 'Cash', text: `${money(cash)} on hand covers ${ticket ? `the ${money(ticket)} ticket` : 'the trip'}` +
                `${budget ? ` and ${money(budget)} of shopping` : ''}.` });
        }
        out.cash.push({ level: 'info', title: 'Loadout', text: "Weapons and armor don't fly (since 23 June 2026): you'll attack abroad with what's in your travel inventory." });
        const today = new Date();
        if (today.getUTCMonth() === 8 && today.getUTCDate() === 27) {
            out.cash.push({ level: 'ok', title: 'Tourism Day', text: 'Carrying capacity is doubled today.' });
        }

        // --- faction: ranked war, chain, OC
        const rw = data.wars && data.wars.wars && data.wars.wars.ranked;
        if (rw && !rw.winner && !(rw.end && rw.end <= t)) {
            const enemy = (rw.factions || []).map((f) => f.name).filter(Boolean).join(' vs ');
            if (rw.start <= t) {
                out.faction.push({ level: 'bad', title: 'Ranked war', short: 'Ranked war in progress', text: `In progress (${esc(enemy)}). You can't hit war targets from abroad.` });
            } else if (rw.start - t < away) {
                out.faction.push({ level: 'warn', title: 'Ranked war', short: `Ranked war starts in ${dur(rw.start - t)}`, text: `Starts in ${dur(rw.start - t)}, before you're back (${dur(away)}).` });
            } else {
                out.faction.push({ level: 'ok', title: 'Ranked war', text: `Starts in ${dur(rw.start - t)}, after you're back.` });
            }
        }
        const ch = bars.chain;
        if (ch && Number(ch.current) >= CHAIN_MIN && Number(ch.timeout) > 0) {
            out.faction.push({ level: 'warn', title: 'Chain', short: `Faction is chaining (${ch.current} hits)`, text: `Your faction is chaining (${ch.current} hits, ${dur(ch.timeout)} to the next hit). You can't help from abroad.` });
        }
        const oc = u.organizedCrime;
        if (oc && oc.status && (oc.status === 'Planning' || oc.status === 'Recruiting')) {
            const ready = Number(oc.ready_at) || 0;
            if (ready && ready > t && ready - t < away) {
                out.faction.push({ level: 'bad', title: 'Organized Crime', short: `OC ready in ${dur(ready - t)}, before you're back`, text: `${esc(oc.name)} is ready in ${dur(ready - t)}, before you're back (${dur(away)}).` });
            } else if (ready && ready > t && ready - t < away * OC_MARGIN) {
                out.faction.push({ level: 'warn', title: 'Organized Crime', short: `OC ready only ${dur(ready - t - away)} after you're back`,
                    text: `${esc(oc.name)} is ready in ${dur(ready - t)}: only ${dur(ready - t - away)} after you're back. Cutting it close if the trip runs long.` });
            } else if (ready && ready > t) {
                out.faction.push({ level: 'ok', title: 'Organized Crime', text: `${esc(oc.name)} is ready in ${dur(ready - t)}, after you're back.` });
            } else {
                out.faction.push({ level: 'info', title: 'Organized Crime', text: `${esc(oc.name)} (${esc(oc.status)}).` });
            }
        } else if (!oc || oc.code === 27) {
            out.faction.push({ level: 'info', title: 'Organized Crime', text: "You're not in an Organized Crime." });
        }
        if (!out.faction.length) out.faction.push({ level: 'ok', title: 'Faction', text: 'No ranked war, chain or OC in the way.' });
        return out;
    }

    // ------------------------------------------------------------ styles
    function injectStyles() {
        if (document.getElementById('tpc-styles')) return;
        const st = document.createElement('style');
        st.id = 'tpc-styles';
        st.textContent = `
        :root {
            --tpc-bg: #1f2227; --tpc-bg2: #15171b; --tpc-fg: #f1f3f5; --tpc-muted: #c3c8cf;
            --tpc-border: #3a3f47; --tpc-accent: #3b8fe0; --tpc-accent-fg: #fff;
            --tpc-ok: #2ecc40; --tpc-warn: #ffb020; --tpc-bad: #ff6b61; --tpc-info: #8fa3b8;
            --tpc-link: #4aa3ff; --tpc-shadow: rgba(0,0,0,0.6);
        }
        body:not(.dark-mode) {
            --tpc-bg: #fff; --tpc-bg2: #f1f3f5; --tpc-fg: #15181b; --tpc-muted: #454c55;
            --tpc-border: #d0d5db; --tpc-accent: #1a6fc0; --tpc-ok: #1f9a30; --tpc-warn: #b36b00;
            --tpc-bad: #d93025; --tpc-info: #5b6b7c; --tpc-link: #1a73e8; --tpc-shadow: rgba(0,0,0,0.25);
        }
        #tpc-banner {
            position: fixed; left: 50%; top: 70px; transform: translateX(-50%); z-index: 2147483645;
            width: 420px; max-width: calc(100vw - 16px); box-sizing: border-box; padding: 8px 12px; border-radius: 10px;
            cursor: pointer; text-align: left; white-space: normal; overflow-wrap: anywhere;
            font: 13px/1.35 Arial, Helvetica, sans-serif;
            background: var(--tpc-bg); color: var(--tpc-fg); border: 2px solid var(--tpc-warn);
            box-shadow: 0 6px 20px var(--tpc-shadow);
        }
        /* In the page, under Torn's title: doesn't cover the bars. */
        #tpc-banner.tpc-inline { position: static; transform: none; display: block; width: auto; max-width: 100%;
            margin: 0 0 10px; box-shadow: none; }
        #tpc-banner.bad { border-color: var(--tpc-bad); }
        #tpc-banner.ok  { border-color: var(--tpc-ok); }
        /* Torn's dark-mode CSS greys spans; pin our colours. */
        #tpc-banner, #tpc-banner * { color: var(--tpc-fg) !important; }
        #tpc-banner .tpc-bhead { font-weight: 700; }
        #tpc-banner .tpc-blist { list-style: none; margin: 5px 0 0; padding: 0; }
        #tpc-banner .tpc-blist li { display: flex; gap: 6px; padding: 2px 0; }
        #tpc-banner .tpc-blist i { flex: 0 0 12px; font-style: normal; font-weight: 900; text-align: center; }
        #tpc-banner .tpc-blist li.warn i { color: var(--tpc-warn) !important; }
        #tpc-banner .tpc-blist li.bad  i { color: var(--tpc-bad) !important; }
        #tpc-banner .tpc-bfoot { margin-top: 4px; font-size: 11px; color: var(--tpc-muted) !important; }
        #tpc-overlay {
            position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.7);
            display: flex; align-items: center; justify-content: center; font-family: Arial, Helvetica, sans-serif;
        }
        #tpc-overlay .tpc-card {
            position: relative; width: 420px; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column;
            background: var(--tpc-bg); color: var(--tpc-fg); border: 1px solid var(--tpc-border);
            border-radius: 12px; box-shadow: 0 10px 34px var(--tpc-shadow); box-sizing: border-box;
            font-size: 14px; line-height: 1.35;
        }
        /* Torn's dark-mode CSS greys out cells and spans; pin our colours. */
        #tpc-overlay .tpc-card, #tpc-overlay .tpc-card label, #tpc-overlay .tpc-card p,
        #tpc-overlay .tpc-card b, #tpc-overlay .tpc-card td { color: var(--tpc-fg) !important; }
        #tpc-overlay .tpc-head { padding: 14px 44px 10px 16px; border-bottom: 1px solid var(--tpc-border); }
        #tpc-overlay h2 { margin: 0; font-size: 16px; display: flex; align-items: center; gap: 8px; }
        #tpc-overlay .tpc-ver { font-size: 10px; font-weight: 700; color: var(--tpc-muted) !important;
            border: 1px solid var(--tpc-border); border-radius: 10px; padding: 2px 6px; }
        #tpc-overlay .tpc-close { position: absolute; top: 8px; right: 10px; width: 28px; height: 28px; padding: 0;
            border: 0; background: transparent; color: var(--tpc-muted); font-size: 20px; line-height: 28px; cursor: pointer; }
        #tpc-overlay .tpc-body { overflow-y: auto; padding: 12px 16px; }
        #tpc-overlay .tpc-foot { padding: 10px 16px 12px; border-top: 1px solid var(--tpc-border);
            display: flex; justify-content: space-between; font-size: 11px; }
        #tpc-overlay a, #tpc-overlay .tpc-linkbtn { color: var(--tpc-link); }
        #tpc-overlay .tpc-linkbtn { background: none; border: 0; padding: 0; cursor: pointer; font-size: 11px; text-decoration: underline; }
        #tpc-overlay select, #tpc-overlay input[type="text"], #tpc-overlay input[type="number"] {
            box-sizing: border-box; padding: 6px 7px; font-size: 13px; border-radius: 6px;
            background: var(--tpc-bg2); color: var(--tpc-fg); border: 1px solid var(--tpc-border);
        }
        #tpc-overlay .tpc-trip { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; margin-bottom: 8px; }
        #tpc-overlay .tpc-trip > * { min-width: 0; }
        #tpc-overlay .tpc-trip select, #tpc-overlay .tpc-trip input[type="number"] { width: 100%; }
        #tpc-overlay .tpc-trip label { display: flex; flex-direction: column; gap: 3px; font-size: 11px;
            font-weight: 700; color: var(--tpc-muted) !important; text-transform: uppercase; letter-spacing: .3px; }
        #tpc-overlay .tpc-trip label.inline { flex-direction: row; align-items: center; gap: 6px; text-transform: none; font-size: 13px; }
        #tpc-overlay .tpc-sum { display: flex; justify-content: space-between; align-items: center; gap: 8px;
            padding: 8px 10px; border-radius: 8px; background: var(--tpc-bg2); border: 1px solid var(--tpc-border);
            margin-bottom: 10px; font-size: 13px; }
        #tpc-overlay .tpc-sum b { font-size: 15px; }
        #tpc-overlay .tpc-btn { padding: 7px 12px; font-size: 13px; font-weight: 700; cursor: pointer; border-radius: 7px;
            background: var(--tpc-accent); color: var(--tpc-accent-fg) !important; border: 0; }
        #tpc-overlay .tpc-btn:disabled { opacity: .6; }
        #tpc-overlay h3 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--tpc-muted) !important; }
        #tpc-overlay .tpc-item { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--tpc-border); font-size: 13px; }
        #tpc-overlay .tpc-item:last-child { border-bottom: 0; }
        #tpc-overlay .tpc-ic { flex: 0 0 18px; font-weight: 900; text-align: center; }
        #tpc-overlay .tpc-item.ok   .tpc-ic { color: var(--tpc-ok) !important; }
        #tpc-overlay .tpc-item.warn .tpc-ic { color: var(--tpc-warn) !important; }
        #tpc-overlay .tpc-item.bad  .tpc-ic { color: var(--tpc-bad) !important; }
        #tpc-overlay .tpc-item.info .tpc-ic { color: var(--tpc-info) !important; }
        #tpc-overlay .tpc-item b { margin-right: 4px; }
        #tpc-overlay .tpc-item span { color: var(--tpc-muted) !important; }
        #tpc-overlay .tpc-msg { padding: 10px; border-radius: 8px; background: var(--tpc-bg2); color: var(--tpc-muted) !important; text-align: center; }
        #tpc-overlay .tpc-msg.err { color: var(--tpc-bad) !important; }
        #tpc-overlay .tpc-note { font-size: 11px; color: var(--tpc-muted) !important; margin-top: 10px; line-height: 1.5; }
        #tpc-overlay .tpc-tos table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 12px; }
        #tpc-overlay .tpc-tos th, #tpc-overlay .tpc-tos td { text-align: left; vertical-align: top; padding: 4px; border-bottom: 1px solid var(--tpc-border); }
        #tpc-overlay .tpc-tos th { width: 34%; }
        #tpc-overlay .tpc-tos td { color: var(--tpc-muted) !important; }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    // ------------------------------------------------------------ panel
    const TOS_ROWS = [
        ['Data storage', 'Only locally: your key and trip settings stay in this browser.'],
        ['Data sharing', 'Nobody. Requests go only to api.torn.com.'],
        ['Purpose of use', 'Personal gain: checking your status before a flight.'],
        ['Key storage & sharing', 'Stored locally on this device. Not shared.'],
        ['Key access level', 'Minimal (user → bars, cooldowns, organizedcrime, travel). Ranked wars use public data.'],
    ];
    const ICON = { ok: '✓', warn: '!', bad: '✗', info: 'i' };
    const SECTIONS = [['bars', 'Energy & nerve'], ['cooldowns', 'Cooldowns'], ['cash', 'Cash & trip'], ['faction', 'Faction & OC']];

    let overlay = null;
    const body = () => overlay && overlay.querySelector('.tpc-body');
    function closePanel() { if (overlay) { overlay.remove(); overlay = null; } }
    function openPanel() {
        if (overlay) return;
        injectStyles();
        overlay = document.createElement('div');
        overlay.id = 'tpc-overlay';
        overlay.innerHTML = `
            <div class="tpc-card" role="dialog" aria-label="Pre-flight checklist">
                <button class="tpc-close" title="Close">&times;</button>
                <div class="tpc-head"><h2>✈️ Pre-flight <span class="tpc-ver">v${VERSION}</span></h2></div>
                <div class="tpc-body"></div>
                <div class="tpc-foot">
                    <span><a href="https://www.torn.com/page.php?sid=travel">Travel Agency</a> · <button class="tpc-linkbtn" data-act="key">Change API key</button>${bannerSavedPos(LS_BANNER_POS) ? `<span data-act="resetpos"> · <button class="tpc-linkbtn">Reset banner</button></span>` : ''}</span>
                    <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
                </div>
            </div>`;
        (document.body || document.documentElement).appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
        overlay.querySelector('.tpc-close').addEventListener('click', closePanel);
        overlay.querySelector('[data-act="key"]').addEventListener('click', () => renderKeySetup());
        const resetPos = overlay.querySelector('[data-act="resetpos"]');
        if (resetPos) resetPos.addEventListener('click', () => {
            // Rebuild it rather than just unpinning: Torn may have re-rendered
            // the spot it was first placed in while it was floating.
            bannerResetPos(LS_BANNER_POS, null);
            const old = document.getElementById('tpc-banner');
            if (old) old.remove();
            bannerHidden = false;
            updateBanner();
            resetPos.remove();
        });
        if (lsGet(LS_KEY)) renderMain(); else renderKeySetup();
    }

    function renderKeySetup(errText) {
        const b = body();
        if (!b) return;
        b.innerHTML = `
            <p style="margin:0 0 10px;font-size:12px;">Enter a Torn API key with at least <b>Minimal</b> access. Create one at
                <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener">Settings → API Keys</a>.</p>
            <div style="display:flex;gap:8px;">
                <input type="text" id="tpc-key" placeholder="API key" autocomplete="off" spellcheck="false" style="flex:1;min-width:0;">
                <button class="tpc-btn" id="tpc-save">Save</button>
            </div>
            <div class="tpc-msg err" id="tpc-keyerr" style="margin-top:8px" ${errText ? '' : 'hidden'}>${esc(errText || '')}</div>
            <div class="tpc-tos"><table>${TOS_ROWS.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>`;
        const input = b.querySelector('#tpc-key');
        const save = async () => {
            const key = input.value.trim();
            const err = b.querySelector('#tpc-keyerr');
            if (!/^[A-Za-z0-9]{16}$/.test(key)) { err.hidden = false; err.textContent = 'A Torn API key is 16 letters/numbers.'; return; }
            const btn = b.querySelector('#tpc-save');
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
        b.querySelector('#tpc-save').addEventListener('click', save);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    }

    function renderMain() {
        const b = body();
        if (!b) return;
        const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
        b.innerHTML = `
            <div class="tpc-trip">
                <label>Destination<select id="tpc-dest">${opt(DESTINATIONS.map((d) => [d.name, d.name]), prefs.dest || 'Mexico')}</select></label>
                <label>Flight<select id="tpc-method">${opt(Object.entries(METHODS), prefs.method || 'Standard')}</select></label>
                <label>Stay abroad (min)<input type="number" id="tpc-stay" min="0" step="1" value="${Number(prefs.stayMin) || 0}"></label>
                <label>Shopping budget ($)<input type="number" id="tpc-budget" min="0" step="100000" value="${Number(prefs.budget) || 0}"></label>
                <label class="inline"><input type="checkbox" id="tpc-book" ${prefs.book ? 'checked' : ''}> Mailing Yourself Abroad (−25%)</label>
                <button class="tpc-btn" id="tpc-refresh">Refresh</button>
            </div>
            <div id="tpc-out"><div class="tpc-msg">Loading…</div></div>`;
        const onChange = () => {
            prefs = Object.assign({}, prefs, {
                dest: b.querySelector('#tpc-dest').value,
                method: b.querySelector('#tpc-method').value,
                stayMin: Math.max(0, parseInt(b.querySelector('#tpc-stay').value, 10) || 0),
                budget: Math.max(0, Number(b.querySelector('#tpc-budget').value) || 0),
                book: b.querySelector('#tpc-book').checked,
            });
            savePrefs();
            refresh(false);
        };
        ['#tpc-dest', '#tpc-method', '#tpc-stay', '#tpc-budget', '#tpc-book'].forEach((s) => b.querySelector(s).addEventListener('change', onChange));
        b.querySelector('#tpc-refresh').addEventListener('click', () => refresh(true));
        refresh(false);
    }

    function tally(checks) {
        const all = [].concat(...Object.values(checks));
        return { bad: all.filter((c) => c.level === 'bad').length, warn: all.filter((c) => c.level === 'warn').length };
    }

    async function refresh(force) {
        const out = overlay && overlay.querySelector('#tpc-out');
        const key = lsGet(LS_KEY);
        if (!out || !key) return;
        const btn = overlay.querySelector('#tpc-refresh');
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
        try {
            const data = await loadData(key, force);
            // loadData may have filled in the trip defaults on first run.
            const dSel = overlay.querySelector('#tpc-dest'), mSel = overlay.querySelector('#tpc-method');
            if (dSel && dSel.value !== prefs.dest) dSel.value = prefs.dest;
            if (mSel && mSel.value !== prefs.method) mSel.value = prefs.method;
            const trip = tripSeconds(prefs);
            const checks = buildChecks(data, trip);
            const { bad, warn } = tally(checks);
            const d = destOf(prefs.dest);
            const flying = inFlight(data);
            out.innerHTML = `
                ${flying ? `<div class="tpc-msg" style="margin-bottom:10px">You're in the air (${esc(data.user.travel.destination || '')}, lands in ${dur(flying)}).
                    This checklist is for your next flight from Torn.</div>` : ''}
                <div class="tpc-sum">
                    <span>${esc(d.name)}: ${dur(trip.oneWay)} each way · <b>back in ${dur(trip.total)}</b></span>
                    <b style="color:var(--tpc-${bad ? 'bad' : warn ? 'warn' : 'ok'}) !important">${bad ? `${bad} ✗` : ''} ${warn ? `${warn} !` : ''}${!bad && !warn ? 'All clear' : ''}</b>
                </div>
                ${SECTIONS.map(([k, title]) => checks[k].length ? `<h3>${title}</h3>` + checks[k].map((c) => `
                    <div class="tpc-item ${c.level}"><span class="tpc-ic">${ICON[c.level]}</span>
                        <div><b>${c.title}</b><span>${c.text}</span></div></div>`).join('') : '').join('')}
                <div class="tpc-note">On the Travel Agency, the country and flight type you tap there are picked up here.
                    Flight times are the Torn wiki's base times (±3% variance on every flight).
                    Data from the Torn API, ${Math.round((Date.now() - data.ts) / 1000)}s old.</div>`;
            updateBanner();
        } catch (e) {
            if (e.code === 2) { lsDel(LS_KEY); renderKeySetup(e.message); return; }
            out.innerHTML = `<div class="tpc-msg err">${esc(e.message)}</div>`;
        } finally {
            if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Refresh'; }
        }
    }

    // ------------------------------------------------------------ trip from your clicks
    // On the Travel Agency, when you tap a country (or a flight type) the
    // checklist follows it. We only read what you tapped; the click itself
    // goes through to Torn untouched.
    function matchOne(patterns, hay) {
        const hits = Object.keys(patterns).filter((k) => patterns[k].test(hay));
        return hits.length === 1 ? hits[0] : null;
    }
    function tripFromClick(target) {
        let dest = null, method = null;
        for (let el = target, i = 0; el && el !== document.body && i < 8 && !(dest && method); el = el.parentElement, i++) {
            const bits = [el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('title'),
                el.getAttribute && el.getAttribute('alt'), el.style && el.style.backgroundImage,
                el.querySelector && (el.querySelector('img') || {}).src];
            const text = (el.textContent || '').trim();
            if (text.length <= 120) bits.push(text);
            const hay = bits.filter(Boolean).join(' | ');
            if (!hay) continue;
            // An element naming several countries is a whole list: stop, it's not a pick.
            const destHits = Object.keys(DEST_PATTERNS).filter((k) => DEST_PATTERNS[k].test(hay));
            if (destHits.length > 1) break;
            if (!dest && destHits.length === 1) dest = destHits[0];
            if (!method) method = matchOne(METHOD_PATTERNS, hay);
        }
        return { dest, method };
    }
    function onTravelClick(e) {
        if (!onTravelPage() || (overlay && overlay.contains(e.target))) return;
        const banner = document.getElementById('tpc-banner');
        if (banner && banner.contains(e.target)) return;
        const { dest, method } = tripFromClick(e.target);
        const next = {};
        if (dest && dest !== prefs.dest) next.dest = dest;
        if (method && method !== prefs.method) next.method = method;
        if (!Object.keys(next).length) return;
        prefs = Object.assign({}, prefs, next);
        savePrefs();
        pickedOnPage = true;
        updateBanner();
    }
    let pickedOnPage = false;
    let bannerHidden = false;    // removed because you're flying or abroad; don't re-add it

    // ------------------------------------------------------------ movable banner
    // Tap opens the details. Press and hold (~0.35 s), then drag, to move the
    // banner; a quick swipe over it still scrolls the page. The spot is saved
    // per script; "Reset banner" in the panel puts it back in the page.
    const BANNER_POS_PROPS = ['position', 'left', 'top', 'width', 'zIndex', 'margin', 'transform', 'boxShadow'];
    function bannerPlace(el, pos) {
        if (!pos) { BANNER_POS_PROPS.forEach((k) => { el.style[k] = ''; }); return; }
        const w = Math.min(420, window.innerWidth - 16);
        const h = Math.min(el.offsetHeight || 60, window.innerHeight - 16);
        Object.assign(el.style, {
            position: 'fixed', width: w + 'px', zIndex: '2147483645', margin: '0', transform: 'none',
            left: Math.min(Math.max(8, pos.x), window.innerWidth - w - 8) + 'px',
            top: Math.min(Math.max(8, pos.y), window.innerHeight - h - 8) + 'px',
            boxShadow: '0 6px 20px rgba(0,0,0,.5)',
        });
    }
    function bannerSavedPos(lsKey) { try { return JSON.parse(localStorage.getItem(lsKey) || 'null'); } catch (e) { return null; } }
    function bannerResetPos(lsKey, el) {
        try { localStorage.removeItem(lsKey); } catch (e) {}
        if (el) bannerPlace(el, null);
    }
    function bannerMovable(el, lsKey, onTap) {
        bannerPlace(el, bannerSavedPos(lsKey));
        Object.assign(el.style, { userSelect: 'none', webkitUserSelect: 'none', webkitTouchCallout: 'none' });
        let drag = null, holdTimer = null, t0 = null, suppressClick = false;
        const start = (x, y) => {
            const r = el.getBoundingClientRect();
            drag = { dx: x - r.left, dy: y - r.top, moved: false };
            bannerPlace(el, { x: r.left, y: r.top });
            el.style.opacity = '.85';
            try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
        };
        const move = (x, y) => { drag.moved = true; bannerPlace(el, { x: x - drag.dx, y: y - drag.dy }); };
        const end = () => {
            if (!drag) return;
            el.style.opacity = '';
            if (drag.moved) {
                const r = el.getBoundingClientRect();
                try { localStorage.setItem(lsKey, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (e) {}
            } else {
                bannerPlace(el, bannerSavedPos(lsKey)); // held without moving: leave it where it was
            }
            drag = null;
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 400);
        };
        el.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            clearTimeout(holdTimer);
            holdTimer = setTimeout(() => start(t0.x, t0.y), 350);
        }, { passive: true });
        el.addEventListener('touchmove', (e) => {
            const t = e.touches[0];
            if (drag) { e.preventDefault(); move(t.clientX, t.clientY); return; }
            if (t0 && Math.hypot(t.clientX - t0.x, t.clientY - t0.y) > 8) clearTimeout(holdTimer); // it's a scroll
        }, { passive: false });
        const touchEnd = () => { clearTimeout(holdTimer); t0 = null; end(); };
        el.addEventListener('touchend', touchEnd);
        el.addEventListener('touchcancel', touchEnd);
        // Mouse: just drag.
        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const sx = e.clientX, sy = e.clientY;
            const mm = (ev) => {
                if (!drag && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) start(sx, sy);
                if (drag) { ev.preventDefault(); move(ev.clientX, ev.clientY); }
            };
            const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); end(); };
            document.addEventListener('mousemove', mm);
            document.addEventListener('mouseup', mu);
        });
        el.addEventListener('contextmenu', (e) => e.preventDefault());
        el.addEventListener('click', (e) => {
            if (suppressClick) { e.stopPropagation(); return; }
            onTap();
        });
        window.addEventListener('resize', () => {
            const pos = bannerSavedPos(lsKey);
            if (el.isConnected && pos) bannerPlace(el, pos);
        });
    }

    // ------------------------------------------------------------ travel page banner
    // On the Travel Agency, a summary at the top listing any problems; tap it for details.
    const onTravelPage = () => /\/page\.php$/i.test(location.pathname) && /[?&]sid=travel\b/i.test(location.search);
    async function updateBanner() {
        let el = document.getElementById('tpc-banner');
        const key = lsGet(LS_KEY);
        if (!onTravelPage()) { if (el) el.remove(); return; }
        injectStyles();
        if (!el) {
            el = document.createElement('div');
            el.id = 'tpc-banner';
            bannerMovable(el, LS_BANNER_POS, openPanel);
            // Right under Torn's page title if there is one, else floating.
            const title = document.querySelector('.content-title');
            if (title && title.parentNode) {
                el.classList.add('tpc-inline');
                title.parentNode.insertBefore(el, title.nextSibling);
            } else {
                (document.body || document.documentElement).appendChild(el);
            }
        }
        const inline = el.classList.contains('tpc-inline');
        const cls = (c) => { el.className = (inline ? 'tpc-inline ' : '') + c; };
        if (!key) { cls(''); el.innerHTML = '<div class="tpc-bhead">✈️ Pre-flight checklist: tap to set up</div>'; return; }
        try {
            const data = await loadData(key, false);
            // In the air: nothing to check before this flight any more.
            if (inFlight(data) || abroad(data)) { el.remove(); bannerHidden = true; return; }
            const trip = tripSeconds(prefs);
            const checks = buildChecks(data, trip);
            const { bad, warn } = tally(checks);
            // Problems first, then warnings, each as a one-liner: no tap needed to see them.
            const all = [].concat(...Object.values(checks));
            const issues = all.filter((c) => c.level === 'bad').concat(all.filter((c) => c.level === 'warn'));
            cls(bad ? 'bad' : warn ? '' : 'ok');
            el.innerHTML = `
                <div class="tpc-bhead">✈️ ${esc(prefs.dest)} (${esc(METHODS[prefs.method] || prefs.method)}) · back in ${dur(trip.total)}${issues.length ? '' : ' · all clear ✓'}</div>
                ${issues.length ? `<ul class="tpc-blist">${issues.map((c) =>
                    `<li class="${c.level}"><i>${ICON[c.level]}</i><span>${esc(c.short || c.title)}</span></li>`).join('')}</ul>` : ''}
                <div class="tpc-bfoot">${pickedOnPage ? '' : 'Tap a country below to check that trip · '}Tap here for details</div>`;
        } catch (e) {
            cls('bad');
            el.innerHTML = `<div class="tpc-bhead">✈️ Pre-flight: ${esc(e.message)}</div>`;
        }
    }

    // ------------------------------------------------------------ entry button
    // Same anchor as our other scripts: Torn's footer panel buttons.
    const PLANE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<path fill="#fff" d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z"/></svg>';
    /* =======================================================================
     * SHARED SCRIPT BUTTON  (nth-hub v2 — keep this block identical in every
     * script). All of these scripts share one entry point. When Torn's chat
     * Settings button (⚙) is there, they are listed in a "Scripts" section at
     * the top of Torn's chat Settings panel and our footer button is hidden,
     * so the footer gets no extra button. Without Torn's ⚙ (Torn changed it,
     * or Chat Panel hides it) the shared footer button comes back: with one
     * script installed it opens that script straight away; with more it opens
     * a small menu. The page DOM is the only shared state, so it also works
     * when the script manager sandboxes each script, and v1 copies still
     * installed are listed and tucked away too.
     * ===================================================================== */
    const HUB_GRID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
        '<g fill="#fff"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/>' +
        '<rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></g></svg>';
    const HUB_MANY_BG = 'linear-gradient(to bottom, #6b6b6b, #3a3a3a)';
    const HUB_HINT_KEY = 'nth_hub_hint_seen';
    function hubStyles() {
        if (document.getElementById('nth-hub2-styles')) return;
        const st = document.createElement('style');
        st.id = 'nth-hub2-styles';
        st.textContent = `
            html.nth-hub-tucked [data-nth-hub] { display: none !important; }
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
            #nth-hub-menu i, #nth-hub-settings i {
                display: flex; align-items: center; justify-content: center; flex: none;
                width: 28px; height: 28px; border-radius: 6px;
            }
            #nth-hub-menu i svg, #nth-hub-settings i svg { width: 18px; height: 18px; }
            #nth-hub-settings i { width: 22px; height: 22px; border-radius: 5px; }
            #nth-hub-settings i svg { width: 15px; height: 15px; }
            #nth-hub-settings > div:last-child { display: flex !important; flex-direction: column; align-items: flex-start; gap: 6px; }
            #nth-hub-settings [data-hub-row] { cursor: pointer; margin: 0 !important; }
            #nth-hub-settings.nth-plain { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px; }
            #nth-hub-settings.nth-plain > span { font: bold 13px Arial, Helvetica, sans-serif; color: #ccc; }
            #nth-hub-settings.nth-plain button {
                display: flex; align-items: center; gap: 10px; padding: 6px 8px; background: #2a2a2a;
                border: 1px solid #444; border-radius: 6px; color: #eee; font: 13px Arial, Helvetica, sans-serif; text-align: left;
            }
            #nth-hub-hint {
                position: fixed; z-index: 2147483646; max-width: 220px; padding: 8px 10px; background: #1f1f1f; color: #eee;
                border: 1px solid #2ecc40; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.45);
                font: 12px/1.35 Arial, Helvetica, sans-serif; cursor: pointer;
            }
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
    // Torn's chat ⚙ button, only while it is actually shown.
    function hubTornGear() {
        const g = document.getElementById('notes_settings_button');
        return g && g.getClientRects().length ? g : null;
    }
    // Torn class names are hashed (root___Z_Afv), so they are copied from
    // Torn's own "Utilities" section rather than hard-coded.
    function hubSettingsSection(content) {
        const sec = document.createElement('div');
        sec.id = 'nth-hub-settings';
        const model = Array.from(content.children).find((c) => c.id !== 'nth-hub-settings' && c.querySelector('button span'));
        const head = model && model.querySelector(':scope > span');
        const list = model && model.querySelector(':scope > div');
        const btn = list && list.querySelector('button');
        const iconW = btn && btn.querySelector('[class*="iconWrapper"]');
        const title = btn && btn.querySelector('span');
        const tpl = { list: 'div', btn: '', icon: '', divider: '', title: '' };
        if (model && head && list && btn && iconW && title) {
            sec.className = model.className;
            tpl.list = list.className;
            tpl.btn = btn.className;
            tpl.icon = iconW.className;
            const div = btn.querySelector('[class*="divider"]');
            tpl.divider = div ? div.className : '';
            tpl.title = title.className;
            const h = document.createElement('span');
            h.className = head.className;
            h.textContent = 'Scripts';
            sec.appendChild(h);
        } else {
            sec.className = 'nth-plain';
            const h = document.createElement('span');
            h.textContent = 'Scripts';
            sec.appendChild(h);
        }
        const rows = document.createElement('div');
        if (tpl.list !== 'div') rows.className = tpl.list;
        sec.appendChild(rows);
        sec._nthTpl = tpl;
        return sec;
    }
    function hubFillSection(sec) {
        const items = Array.from(hubMenu().querySelectorAll('[data-hub-item]'));
        const sig = items.map((b) => b.getAttribute('data-hub-item')).join(',');
        if (sec.getAttribute('data-hub-sig') === sig) return;
        sec.setAttribute('data-hub-sig', sig);
        const tpl = sec._nthTpl || {};
        const rows = sec.lastElementChild;
        rows.textContent = '';
        items.forEach((item) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('data-hub-row', item.getAttribute('data-hub-item'));
            if (tpl.btn) b.className = tpl.btn;
            const w = document.createElement('div');
            if (tpl.icon) w.className = tpl.icon;
            const i = document.createElement('i');
            i.innerHTML = item.querySelector('i').innerHTML;
            i.style.background = item.getAttribute('data-hub-bg');
            w.appendChild(i);
            b.appendChild(w);
            if (tpl.divider) { const d = document.createElement('div'); d.className = tpl.divider; b.appendChild(d); }
            const t = document.createElement('span');
            if (tpl.title) t.className = tpl.title;
            t.textContent = item.textContent;
            b.appendChild(t);
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Close Torn's Settings panel, then open the script.
                const g = document.getElementById('notes_settings_button');
                if (g && /opened/.test(g.className)) g.click();
                const it = hubMenu().querySelector(`[data-hub-item="${b.getAttribute('data-hub-row')}"]`);
                if (it) it.click();
            });
            rows.appendChild(b);
        });
    }
    function hubHint(gear) {
        try { if (localStorage.getItem(HUB_HINT_KEY)) return; localStorage.setItem(HUB_HINT_KEY, '1'); } catch (e) { return; }
        if (document.getElementById('nth-hub-hint')) return;
        const tip = document.createElement('div');
        tip.id = 'nth-hub-hint';
        tip.textContent = 'Script settings have moved: tap Torn\'s chat ⚙ and look under "Scripts".';
        const r = gear.getBoundingClientRect();
        tip.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        tip.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
        const close = () => tip.remove();
        tip.addEventListener('click', close);
        setTimeout(close, 10000);
        document.body.appendChild(tip);
    }
    // Keeps the footer button and the Settings section in step with the page.
    // Writes to the DOM only when something changed, so observers settle.
    function hubSync() {
        if (!document.body) return;
        const gear = hubTornGear();
        const root = document.documentElement;
        if (!!gear !== root.classList.contains('nth-hub-tucked')) {
            root.classList.toggle('nth-hub-tucked', !!gear);
            if (gear) hubHint(gear);
        }
        const content = document.querySelector('#settings_panel [class*="content___"]');
        if (!content) return;
        let sec = document.getElementById('nth-hub-settings');
        if (sec && sec.parentNode !== content) { sec.remove(); sec = null; }
        if (!sec) {
            sec = hubSettingsSection(content);
            content.insertBefore(sec, content.firstChild);
        }
        hubFillSection(sec);
    }
    // One watcher per page, whichever script gets here first.
    function hubWatch() {
        const root = document.documentElement;
        if (root.hasAttribute('data-nth-hub-watch')) return;
        root.setAttribute('data-nth-hub-watch', '2');
        let queued = false;
        const kick = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; hubSync(); });
        };
        // Chat Panel hides Torn's ⚙ through a class on <html>.
        new MutationObserver(kick).observe(root, { attributes: true, attributeFilter: ['class'] });
        let tries = 0;
        const findChat = () => {
            const chat = document.getElementById('chatRoot');
            if (chat) { new MutationObserver(kick).observe(chat, { childList: true, subtree: true }); kick(); return; }
            if (++tries < 60) setTimeout(findChat, 1000);
        };
        findChat();
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
        hubWatch();
        const ref = document.getElementById('notes_panel_button') || document.getElementById('people_panel_button');
        let hub = document.querySelector('[data-nth-hub]');
        const inBar = !!(ref && ref.parentNode);
        if (hub && (inBar ? hub.parentNode === ref.parentNode : hub.id === 'nth-hub-float')) { hubPaint(hub, ref); hubSync(); return; }
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
        hubSync();
    }
    function mountButton() {
        hubMount({ id: 'tpc', label: 'Pre-flight checklist', svg: PLANE_SVG,
            bg: 'linear-gradient(to bottom, #3b8fe0, #1d5a9c)', onOpen: openPanel });
    }

    function start() {
        if (!document.body) return setTimeout(start, 300);
        injectStyles();
        mountButton();
        updateBanner();
        document.addEventListener('click', onTravelClick, true);
        let pending = false;
        // Idle in background tabs (Torn PDA keeps them running); catch up on return.
        new MutationObserver(() => {
            if (pending || document.hidden) return;
            pending = true;
            setTimeout(() => {
                pending = false;
                mountButton();   // cheap no-op while the button is in place
                if (onTravelPage() && !bannerHidden && !document.getElementById('tpc-banner')) updateBanner();
            }, 300);
        }).observe(document.body, { childList: true, subtree: true });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) mountButton(); });
    }

    start();
})();
