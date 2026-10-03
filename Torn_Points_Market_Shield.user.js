// ==UserScript==
// @name         Torn Points Market Shield
// @namespace    https://github.com/nebigoktug
// @version      1.1.0
// @description  Fat-finger guard for selling points: blocks a listing priced below a hard floor ($28,000 by default) and asks for a second confirmation when the price is below 95% of the cheapest current listings. Never lists, buys or clicks anything itself.
// @author       Nebigoktug
// @license      MIT
// @supportURL   https://github.com/nebigoktug/torn-userscripts/issues
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Points_Market_Shield.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Points_Market_Shield.user.js
// ==/UserScript==

/*
 * Torn Points Market Shield (PMA-Shield)
 *
 * While you type a price into the points market's sell form, the price is
 * checked against two floors:
 *
 *   Hard floor     $28,000 per point (setting). Below it the listing is
 *                  BLOCKED: the button is locked and every submit is cancelled.
 *   Market floor   95% (setting) of the median of the 3 cheapest listings.
 *                  Below it the listing is SUSPICIOUS: it only goes through
 *                  after a second confirmation in our own dialog.
 *
 * Clicks, form submits and the Enter key are caught before Torn sees them,
 * so a locked button can't be bypassed by pressing Enter quickly.
 *
 * Market prices: Torn API (market → pointsmarket, a Public key is enough),
 * or, without a key, the listings shown on the page you are viewing. No other
 * requests are made. The script only reads and blocks; it never submits.
 */

(function () {
    'use strict';

    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;
    // Torn PDA can inject the script again on in-page navigation; run once.
    if (window.__pmaRunning) return;
    window.__pmaRunning = true;

    const VERSION  = '1.1.0';
    const REPO_URL = 'https://github.com/nebigoktug/torn-userscripts';
    const LS_KEY   = 'pma_api_key';
    const LS_PREFS = 'pma_prefs';
    const OTHER_KEYS = ['ffbs_api_key', 'tsd_api_key', 'tfs_api_key', 'tpc_api_key']; // offered on first setup
    const MARKET_TTL_MS = 60 * 1000;   // reuse API prices for a minute
    const CHEAPEST_N = 3;

    const DEFAULT_PREFS = { staticFloor: 28000, pct: 95, enabled: true };

    /*
     * pmarket.php markup (checked on a saved page, Oct 2026). The "ADD LISTING"
     * button sits in span.points-want-to-add[href=…addlisting1], and Torn's
     * confirm step opens in .confirm-wrap, also inside form#add. If Torn
     * renames these, the fields are looked up by their label text instead.
     */
    const SEL = {
        price: '#quantity-price',       // "Price each"
        qty: '#quantity-points',        // "Points"
        container: 'form#add',
        listings: '.users-point-sell > li',
        // The "$" in the price box is a button that fills in the maximum
        // ($100,000); it must keep working while the form is blocked.
        exempt: '.input-money-symbol, .input-money-symbol *',
    };

    // ------------------------------------------------------------ storage
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
    const loadJson = (k, dflt) => { try { return JSON.parse(lsGet(k) || 'null') || dflt; } catch (e) { return dflt; } };
    let prefs = Object.assign({}, DEFAULT_PREFS, loadJson(LS_PREFS, {}));
    const savePrefs = () => lsSet(LS_PREFS, JSON.stringify(prefs));

    // ------------------------------------------------------------ helpers
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const full = (n) => '$' + Math.round(n).toLocaleString('en-US');
    const short = (n) => {
        const a = Math.abs(n);
        if (a >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'b';
        if (a >= 1e6) return '$' + (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'm';
        if (a >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
        return '$' + Math.round(n);
    };
    const onMarketPage = () => /\/pmarket\.php$/i.test(location.pathname);
    // "31,000" → 31000. Torn's money fields also take "31k" / "1.5m" and,
    // relative to the field's maximum (data-money), max / half / quarter /
    // 1/3 / 25%.
    function parseMoney(v, max) {
        const s = String(v || '').trim().toLowerCase().replace(/[\s,$]/g, '');
        if (max > 0) {
            const word = { max: 1, all: 1, half: 1 / 2, quarter: 1 / 4 }[s];
            if (word) return Math.floor(max * word);
            let f = s.match(/^(\d+)\/(\d+)$/);
            if (f && Number(f[2])) return Math.floor(max * Number(f[1]) / Number(f[2]));
            f = s.match(/^(\d+(?:\.\d+)?)%$/);
            if (f) return Math.floor(max * parseFloat(f[1]) / 100);
        }
        const m = s.match(/^(\d+(?:\.\d+)?)([kmb])$/);
        if (m) return Math.round(parseFloat(m[1]) * { k: 1e3, m: 1e6, b: 1e9 }[m[2]]);
        const digits = s.replace(/[^0-9]/g, '');
        return digits ? Number(digits) : 0;
    }
    const median = (a) => {
        const s = a.slice().sort((x, y) => x - y);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    // ------------------------------------------------------------ market prices
    let market = { costs: [], source: '', at: 0, error: '' };
    let loading = null;

    async function apiMarket(key) {
        const resp = await fetch(`https://api.torn.com/market/?selections=pointsmarket&key=${encodeURIComponent(key)}&comment=PMAShield`);
        const data = await resp.json();
        if (data && data.error) throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
        return Object.values((data && data.pointsmarket) || {}).map((l) => Number(l.cost)).filter((c) => c > 0);
    }
    // Per-point price of each listing on the page you are viewing. A row
    // shows the price per point and the total; the per-point one is smaller.
    function pageMarket() {
        const costs = [];
        document.querySelectorAll(SEL.listings).forEach((li) => {
            const own = li.querySelector('.cost-each, .cost, [class*="cost"]');
            const src = own ? own.textContent : li.textContent;
            const nums = (src.match(/\$\s?[\d,]+/g) || []).map(parseMoney).filter((n) => n >= 1000);
            if (nums.length) costs.push(Math.min(...nums));
        });
        return costs;
    }
    function loadMarket(force) {
        if (loading) return loading;
        const key = lsGet(LS_KEY);
        if (!force && market.source === 'API' && Date.now() - market.at < MARKET_TTL_MS) return Promise.resolve();
        loading = (async () => {
            if (key) {
                try {
                    const costs = await apiMarket(key);
                    if (costs.length) { market = { costs, source: 'API', at: Date.now(), error: '' }; return; }
                } catch (e) { market.error = e.message; }
            }
            const costs = pageMarket();
            if (costs.length) market = { costs, source: 'page', at: Date.now(), error: market.error };
        })().finally(() => { loading = null; evaluate(); });
        return loading;
    }
    function floors() {
        const cheapest = market.costs.slice().sort((a, b) => a - b).slice(0, CHEAPEST_N);
        const ref = cheapest.length ? median(cheapest) : 0;
        const dyn = ref ? Math.ceil(ref * prefs.pct / 100) : 0;
        return { ref, dyn, stat: prefs.staticFloor, min: Math.max(dyn, prefs.staticFloor) };
    }

    // ------------------------------------------------------------ finding the sell form
    const CLICKABLE = 'button, input[type="submit"], input[type="button"], input[type="image"], a, [role="button"], span[href]';
    const ours = (el) => !!(el && el.closest && el.closest('[id^="pma-"]'));
    function hint(i) {
        const parts = [i.name, i.id, i.placeholder, i.className, i.getAttribute('aria-label'), i.getAttribute('data-name')];
        // Torn's money fields keep the raw value in a hidden sibling input.
        const hidden = i.parentNode && i.parentNode.querySelector('input[type="hidden"][name]');
        if (hidden) parts.push(hidden.name);
        if (i.id) { const l = document.querySelector(`label[for="${CSS.escape(i.id)}"]`); if (l) parts.push(l.textContent); }
        const p = i.parentNode;
        if (p && p.textContent.length < 80) parts.push(p.textContent);
        return parts.filter(Boolean).join(' ').toLowerCase();
    }
    function findForm() {
        let price = SEL.price ? document.querySelector(SEL.price) : null;
        let qty = SEL.qty ? document.querySelector(SEL.qty) : null;
        if (!price) {
            const inputs = Array.from(document.querySelectorAll('input')).filter((i) =>
                !/^(hidden|checkbox|radio|submit|button|image|search|password)$/i.test(i.type) &&
                !ours(i) && !i.closest(SEL.listings));
            price = inputs.find((i) => /price|cost|per point|\$/.test(hint(i)));
            if (!qty) qty = inputs.find((i) => i !== price && /amount|quantity|qty|points/.test(hint(i)));
        }
        if (!price) return null;
        let container = SEL.container ? document.querySelector(SEL.container) : null;
        if (!container) {
            container = price.form || null;
            if (!container) {
                let el = price.parentNode;
                for (let d = 0; el && el !== document.body && d < 8; d++, el = el.parentNode) {
                    const btn = Array.from(el.querySelectorAll(CLICKABLE)).some((b) => !b.closest(SEL.listings) && !ours(b));
                    if (btn) { container = el; break; }
                }
            }
        }
        return { price, qty, container: container || price.parentNode };
    }

    // ------------------------------------------------------------ state machine
    let ctx = null;          // { price, qty, container }
    let approved = null;     // "price|qty" confirmed in our dialog
    let last = { state: 'IDLE' };

    function check() {
        if (!ctx || !ctx.price.isConnected) ctx = onMarketPage() ? findForm() : null;
        if (!ctx || !prefs.enabled) return { state: 'IDLE' };
        const price = parseMoney(ctx.price.value, Number(ctx.price.getAttribute('data-money')) || 0);
        const qty = ctx.qty ? parseMoney(ctx.qty.value) : 0;
        const f = floors();
        const r = { price, qty, total: price * qty, expected: f.ref * qty, f };
        if (!price) r.state = 'IDLE';
        else if (price < f.stat) { r.state = 'BLOCKED'; r.code = 'FATAL_BELOW_MIN'; }
        else if (f.dyn && price < f.dyn) { r.state = 'SUSPICIOUS'; r.code = 'BELOW_MARKET_FLOOR'; }
        else r.state = 'SAFE';
        r.sig = price + '|' + qty;
        return r;
    }

    function buttons() {
        if (!ctx || !ctx.container) return [];
        return Array.from(ctx.container.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"]'))
            .filter((b) => !ours(b) && !b.closest(SEL.listings) && !b.matches(SEL.exempt));
    }

    function evaluate() {
        const r = check();
        if (r.state !== last.state && r.code) console.warn(`[PMA-Shield] ${r.code}: price ${full(r.price)}, allowed min ${full(r.f.min)}`);
        last = r;
        paint(r);
        return r;
    }

    function paint(r) {
        if (!ctx) { const c = document.getElementById('pma-card'); if (c) c.remove(); return; }
        injectStyles();
        const inp = ctx.price;
        inp.classList.remove('pma-in-safe', 'pma-in-sus', 'pma-in-blocked');
        if (r.state === 'SAFE') inp.classList.add('pma-in-safe');
        if (r.state === 'SUSPICIOUS') inp.classList.add('pma-in-sus');
        if (r.state === 'BLOCKED') inp.classList.add('pma-in-blocked');

        // Lock only while BLOCKED; a SUSPICIOUS click opens our dialog instead.
        buttons().forEach((b) => {
            const locked = b.hasAttribute('data-pma-locked');
            if (r.state === 'BLOCKED' && !locked) {
                b.setAttribute('data-pma-locked', b.disabled ? 'was' : '');
                b.disabled = true;
                b.classList.add('pma-button-disabled');
            } else if (r.state !== 'BLOCKED' && locked) {
                if (b.getAttribute('data-pma-locked') !== 'was') b.disabled = false;
                b.removeAttribute('data-pma-locked');
                b.classList.remove('pma-button-disabled');
            }
        });

        let card = document.getElementById('pma-card');
        if (!card) {
            card = document.createElement('div');
            card.id = 'pma-card';
            const host = ctx.container;
            if (host.parentNode) host.parentNode.insertBefore(card, host.nextSibling); else document.body.appendChild(card);
        }
        const f = r.f || floors();
        const mkt = f.ref
            ? `Market: ${full(f.ref)} (median of ${Math.min(CHEAPEST_N, market.costs.length)} cheapest, ${market.source}) · floor ${full(f.dyn)} (${prefs.pct}%)`
            : `Market price unknown — only the ${full(f.stat)} hard floor applies.`;
        const totalLine = r.qty && r.price
            ? `<div class="pma-sub">Total: <b>${short(r.total)}</b>${f.ref ? ` · at market ≈ ${short(r.expected)}` : ''}</div>` : '';
        let html;
        if (!prefs.enabled) {
            html = `<div class="pma-sub">🛡 Points Market Shield is off.</div>`;
        } else if (r.state === 'BLOCKED') {
            html = `<b>⛔ Critical: price is below the hard floor!</b>
                <div>Entered: <b>${full(r.price)}</b> | Allowed min: <b>${full(f.stat)}</b></div>${totalLine}<div class="pma-sub">${mkt}</div>`;
        } else if (r.state === 'SUSPICIOUS') {
            html = `<b>⚠ Price is below the market floor (${prefs.pct}%).</b>
                <div>Entered: <b>${full(r.price)}</b> | Market floor: <b>${full(f.dyn)}</b></div>${totalLine}
                <div class="pma-sub">Listing will ask for a second confirmation. ${mkt}</div>`;
        } else {
            html = `${r.state === 'SAFE' ? `<div>✅ ${full(r.price)} per point</div>${totalLine}` : ''}<div class="pma-sub">🛡 ${mkt}</div>`;
        }
        // Only touch the DOM on a change, or our own MutationObserver loops.
        const cls = 'pma-' + r.state.toLowerCase() + (card.classList.contains('pma-flash') ? ' pma-flash' : '');
        if (card.className !== cls) card.className = cls;
        if (card._pmaHtml !== html) { card._pmaHtml = html; card.innerHTML = html; }
    }

    // ------------------------------------------------------------ event interception
    function isGuarded(e) {
        if (!ctx || !ctx.container || !ctx.container.isConnected) return null;
        const t = e.target;
        if (!t || ours(t)) return null;
        if (e.type === 'submit') return ctx.container.contains(t) || t.contains(ctx.price) ? t : null;
        if (e.type.startsWith('key')) {
            if (e.key !== 'Enter') return null;
            return ctx.container.contains(t) ? t : null;
        }
        const el = t.closest && t.closest(CLICKABLE);
        if (!el || !ctx.container.contains(el) || el.closest(SEL.listings) || el.matches(SEL.exempt)) return null;
        return el;
    }
    function guard(e) {
        const el = isGuarded(e);
        if (!el) return;
        const r = evaluate();
        if (r.state === 'IDLE' || r.state === 'SAFE') return;
        if (r.state === 'SUSPICIOUS' && approved === r.sig) return;
        e.stopImmediatePropagation();
        e.stopPropagation();
        // mousedown/pointerdown/touchend are only hidden from Torn: cancelling
        // them on a phone would also cancel the click that opens our dialog.
        const main = e.type === 'click' || e.type === 'submit' || e.type.startsWith('key');
        if (!main) return;
        e.preventDefault();
        if (e.type !== 'click' && e.type !== 'keydown' && e.type !== 'submit') return;
        if (r.state === 'BLOCKED') {
            console.warn(`[PMA-Shield] FATAL_BELOW_MIN: ${e.type} cancelled`);
            const card = document.getElementById('pma-card');
            if (card) { card.classList.remove('pma-flash'); void card.offsetWidth; card.classList.add('pma-flash'); }
        } else {
            openConfirm(r, el);
        }
    }
    ['click', 'mousedown', 'pointerdown', 'touchend', 'submit', 'keydown', 'keypress', 'keyup']
        .forEach((t) => window.addEventListener(t, guard, true));

    function openConfirm(r, trigger) {
        if (document.getElementById('pma-modal')) return;
        injectStyles();
        const m = document.createElement('div');
        m.id = 'pma-modal';
        m.innerHTML = `<div class="pma-box" role="dialog" aria-label="Confirm low price">
            <h3>⚠ Below market — are you sure?</h3>
            <p>You are listing at <b>${full(r.price)}</b> per point.<br>
               The cheapest listings are around <b>${full(r.f.ref)}</b>; ${prefs.pct}% of that is ${full(r.f.dyn)}.</p>
            ${r.qty ? `<p>Total: <b>${full(r.total)}</b> (at market ≈ ${full(r.expected)}, you get ${full(r.expected - r.total)} less)</p>` : ''}
            <div class="pma-row"><button type="button" data-a="no" class="pma-no">Cancel</button>
            <button type="button" data-a="yes" class="pma-yes">Yes, list at ${short(r.price)}</button></div></div>`;
        document.body.appendChild(m);
        m.querySelector('[data-a="no"]').focus();
        const close = () => m.remove();
        m.addEventListener('click', (e) => { if (e.target === m) close(); });
        m.querySelector('[data-a="no"]').addEventListener('click', close);
        m.querySelector('[data-a="yes"]').addEventListener('click', () => {
            close();
            approved = r.sig;
            console.info(`[PMA-Shield] below-market price ${full(r.price)} confirmed by user`);
            // Replay the user's own action now that it is approved.
            if (trigger.matches && trigger.matches(CLICKABLE)) trigger.click();
            else {
                const btn = buttons()[0];
                if (btn) btn.click();
                else if (ctx.price.form && ctx.price.form.requestSubmit) ctx.price.form.requestSubmit();
            }
        });
    }

    // ------------------------------------------------------------ styles
    function injectStyles() {
        if (document.getElementById('pma-styles')) return;
        const st = document.createElement('style');
        st.id = 'pma-styles';
        st.textContent = `
        :root { --pma-bg: #1f2227; --pma-bg2: #15171b; --pma-fg: #f1f3f5; --pma-muted: #c3c8cf; --pma-border: #3a3f47;
            --pma-ok: #2ecc40; --pma-warn: #ff9800; --pma-bad: #ff2e2e; --pma-link: #4aa3ff; }
        body:not(.dark-mode) { --pma-bg: #fff; --pma-bg2: #f1f3f5; --pma-fg: #15181b; --pma-muted: #454c55; --pma-border: #d0d5db;
            --pma-ok: #1f9a30; --pma-warn: #c46a00; --pma-link: #1a73e8; }
        input.pma-in-safe { border: 2px solid var(--pma-ok) !important; }
        input.pma-in-sus { border: 2px solid var(--pma-warn) !important; box-shadow: 0 0 8px rgba(255,152,0,.6) !important; }
        input.pma-in-blocked { border: 2px solid #ff2e2e !important; box-shadow: 0 0 8px rgba(255,0,0,0.6) !important;
            animation: pma-pulse 1s ease-in-out infinite; }
        @keyframes pma-pulse { 50% { box-shadow: 0 0 2px rgba(255,0,0,.3); } }
        .pma-button-disabled { opacity: .35 !important; filter: grayscale(1) !important; pointer-events: none !important; }
        #pma-card { margin: 8px 0; padding: 8px 12px; border-radius: 8px; font: 13px/1.45 Arial, Helvetica, sans-serif;
            background: var(--pma-bg); border: 2px solid var(--pma-border); clear: both; }
        #pma-card, #pma-card * { color: var(--pma-fg) !important; }
        #pma-card.pma-safe { border-color: var(--pma-ok); }
        #pma-card.pma-suspicious { border-color: var(--pma-warn); }
        #pma-card.pma-blocked { border-color: var(--pma-bad); }
        #pma-card.pma-blocked > b:first-child { color: var(--pma-bad) !important; }
        #pma-card .pma-sub, #pma-card .pma-sub * { font-size: 11px; color: var(--pma-muted) !important; }
        #pma-card.pma-flash { animation: pma-shake .35s; }
        @keyframes pma-shake { 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
        #pma-modal, #pma-overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.7);
            display: flex; align-items: center; justify-content: center; font-family: Arial, Helvetica, sans-serif; }
        #pma-modal .pma-box, #pma-overlay .pma-box { width: 400px; max-width: 92vw; max-height: 90vh; overflow-y: auto; box-sizing: border-box;
            padding: 16px; border-radius: 12px; background: var(--pma-bg); border: 2px solid var(--pma-warn); font-size: 14px; line-height: 1.4; }
        #pma-overlay .pma-box { border: 1px solid var(--pma-border); position: relative; }
        #pma-modal *, #pma-overlay * { color: var(--pma-fg) !important; }
        #pma-modal h3, #pma-overlay h3 { margin: 0 0 10px; font-size: 16px; }
        #pma-modal p { margin: 0 0 8px; }
        .pma-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
        #pma-modal button, #pma-overlay .pma-btn { padding: 8px 12px; border-radius: 7px; border: 0; font-weight: 700; font-size: 13px; cursor: pointer; }
        #pma-modal .pma-no { background: var(--pma-bg2); border: 1px solid var(--pma-border); }
        #pma-modal .pma-yes { background: var(--pma-warn); color: #fff !important; }
        #pma-overlay .pma-btn { background: #e08a1e; color: #fff !important; }
        #pma-overlay .pma-close { position: absolute; top: 6px; right: 10px; background: none; border: 0; font-size: 20px; cursor: pointer; }
        #pma-overlay label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--pma-muted) !important; }
        #pma-overlay input[type="text"], #pma-overlay input[type="number"] { box-sizing: border-box; width: 100%; padding: 6px 7px; font-size: 13px;
            border-radius: 6px; background: var(--pma-bg2); border: 1px solid var(--pma-border); }
        #pma-overlay .pma-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        #pma-overlay .pma-note { font-size: 11px; color: var(--pma-muted) !important; margin-top: 10px; line-height: 1.5; }
        #pma-overlay a { color: var(--pma-link) !important; }
        #pma-overlay table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
        #pma-overlay th, #pma-overlay td { text-align: left; vertical-align: top; padding: 4px; border-bottom: 1px solid var(--pma-border); }
        #pma-overlay td { color: var(--pma-muted) !important; }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    // ------------------------------------------------------------ settings panel
    const TOS_ROWS = [
        ['Data storage', 'Only locally: your key and settings stay in this browser.'],
        ['Data sharing', 'Nobody. Your key goes only to api.torn.com.'],
        ['Purpose of use', 'Personal: protecting your own points listings from typos.'],
        ['Key storage & sharing', 'Stored locally on this device. Not shared.'],
        ['Key access level', 'Public (market → pointsmarket). Optional: without a key the listings on the page are used.'],
    ];
    function openPanel() {
        if (document.getElementById('pma-overlay')) return;
        injectStyles();
        const reuse = lsGet(LS_KEY) || OTHER_KEYS.map(lsGet).find((k) => /^[A-Za-z0-9]{16}$/.test(k || '')) || '';
        const found = onMarketPage() ? findForm() : null;
        const det = !onMarketPage() ? 'Open the Points Market to check the sell form.'
            : found ? `Sell form found: price field ✓, amount field ${found.qty ? '✓' : '✗'}, buttons: ${(ctx = found, buttons().length)}.`
            : 'Sell form NOT found on this page — the shield is not active here.';
        const o = document.createElement('div');
        o.id = 'pma-overlay';
        o.innerHTML = `<div class="pma-box" role="dialog" aria-label="Points Market Shield">
            <button class="pma-close" title="Close">&times;</button>
            <h3>🛡 Points Market Shield <small>v${VERSION}</small></h3>
            <label style="flex-direction:row;align-items:center;gap:6px;margin-bottom:10px"><input type="checkbox" id="pma-on" ${prefs.enabled ? 'checked' : ''}> Shield on</label>
            <div class="pma-grid">
                <label>Hard floor ($/point)<input type="number" id="pma-stat" min="0" step="100" value="${prefs.staticFloor}"></label>
                <label>Market floor (% of cheapest)<input type="number" id="pma-pct" min="50" max="100" step="1" value="${prefs.pct}"></label>
            </div>
            <label style="margin-top:10px">API key (Public is enough, optional)<input type="text" id="pma-key" autocomplete="off" spellcheck="false" value="${esc(reuse)}"></label>
            <div class="pma-row"><button class="pma-btn" id="pma-save">Save</button></div>
            <div class="pma-note" id="pma-msg">${esc(det)}<br>Market: ${market.costs.length ? `${market.costs.length} listings from ${market.source}` : 'not loaded yet'}${market.error ? ` · ${esc(market.error)}` : ''}</div>
            <table>${TOS_ROWS.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
            <div class="pma-note"><a href="https://www.torn.com/pmarket.php">Points Market</a> · <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></div>
        </div>`;
        document.body.appendChild(o);
        const close = () => o.remove();
        o.addEventListener('click', (e) => { if (e.target === o) close(); });
        o.querySelector('.pma-close').addEventListener('click', close);
        o.querySelector('#pma-save').addEventListener('click', () => {
            const n = (s, d) => { const v = Number(o.querySelector(s).value); return isNaN(v) ? d : v; };
            prefs.enabled = o.querySelector('#pma-on').checked;
            prefs.staticFloor = Math.max(0, Math.round(n('#pma-stat', DEFAULT_PREFS.staticFloor)));
            prefs.pct = Math.min(100, Math.max(50, n('#pma-pct', DEFAULT_PREFS.pct)));
            savePrefs();
            const key = o.querySelector('#pma-key').value.trim();
            if (!key) lsDel(LS_KEY);
            else if (/^[A-Za-z0-9]{16}$/.test(key)) lsSet(LS_KEY, key);
            else { o.querySelector('#pma-msg').textContent = 'A Torn API key is 16 letters/numbers.'; return; }
            close();
            if (onMarketPage()) loadMarket(true);
        });
    }

    // ------------------------------------------------------------ entry button
    const SHIELD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<path fill="#fff" d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/>' +
        '<path fill="none" stroke="#2b6cb0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M8.5 12l2.5 2.5 4.5-5"/></svg>';
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
            #nth-hub-settings [data-hub-row] { cursor: pointer; }
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
        hubMount({ id: 'pma', label: 'Points market shield', svg: SHIELD_SVG,
            bg: 'linear-gradient(to bottom, #4a90d9, #22548f)', onOpen: openPanel });
    }

    // ------------------------------------------------------------ start
    function start() {
        if (!document.body) return setTimeout(start, 300);
        mountButton();
        if (onMarketPage()) { evaluate(); loadMarket(false); }
        // Re-check on every keystroke in the sell form.
        document.addEventListener('input', (e) => { if (ctx && (e.target === ctx.price || e.target === ctx.qty)) { approved = null; evaluate(); } }, true);
        document.addEventListener('change', (e) => { if (ctx && (e.target === ctx.price || e.target === ctx.qty)) evaluate(); }, true);
        document.addEventListener('focusin', (e) => { if (ctx && e.target === ctx.price) loadMarket(false); }, true);
        let pending = false;
        new MutationObserver(() => {
            if (pending || document.hidden) return;
            pending = true;
            setTimeout(() => {
                pending = false;
                mountButton();
                if (!onMarketPage()) return;
                const hadForm = !!ctx && ctx.price.isConnected;
                evaluate();
                // Listings re-rendered and no API data: re-read them from the page.
                if (!hadForm || market.source !== 'API') loadMarket(false);
            }, 250);
        }).observe(document.body, { childList: true, subtree: true });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) mountButton(); });
    }

    start();
})();
