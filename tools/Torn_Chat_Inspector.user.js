// ==UserScript==
// @name         Torn Chat Inspector (dev tool)
// @namespace    https://github.com/nebigoktug
// @version      0.1.0
// @description  Developer tool: records how Torn's chat is built (page structure) and what its live messages look like, with all message text and names removed, so a chat reskin can be written against it. Makes no requests; nothing leaves your device unless you copy or save the report yourself.
// @author       Nebigoktug
// @license      MIT
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/tools/Torn_Chat_Inspector.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/tools/Torn_Chat_Inspector.user.js
// ==/UserScript==

/*
 * Torn Chat Inspector (temporary developer tool)
 *
 * Runs at page start so it sees the chat connection being opened. It only
 * listens: WebSocket frames and chat-related fetch/XHR answers that Torn's
 * own page receives are summarised by shape (field names and value types).
 * Message text, names and other free text are replaced by their length.
 * Tap "Chat inspector" in the footer menu to see the counts and to copy or
 * save the report. Uninstall it when the report has been taken.
 */

(function () {
    'use strict';

    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;
    if (window.__tciRunning) return;
    window.__tciRunning = true;

    const VERSION = '0.1.0';
    const MAX_SAMPLES = 3;          // kept per distinct message shape
    const MAX_SHAPES = 300;
    const CHAT_URL_RE = /chat|sendbird|message|socket|ws\b|pusher|centrifug/i;

    // ------------------------------------------------------------ redaction
    // Field names whose short values are protocol words, not user text.
    const KEEP_KEY_RE = /^(type|event|action|kind|op|cmd|command|method|channeltype|roomtype|status|state|category|role|code|path|url|endpoint)$/i;
    function redact(v, key, depth) {
        if (depth > 8) return '…';
        if (v === null) return null;
        if (Array.isArray(v)) {
            const out = v.slice(0, 3).map((x) => redact(x, key, depth + 1));
            if (v.length > 3) out.push(`…${v.length} items`);
            return out;
        }
        switch (typeof v) {
            case 'object': {
                const o = {};
                Object.keys(v).slice(0, 60).forEach((k) => { o[k] = redact(v[k], k, depth + 1); });
                return o;
            }
            case 'string':
                if (key && KEEP_KEY_RE.test(key) && v.length <= 40 && !/\s/.test(v)) return v;
                if (/^\d{4}-\d\d-\d\dT/.test(v)) return 'str:iso-date';
                if (/^https?:\/\//.test(v)) return 'str:url ' + v.replace(/^(https?:\/\/[^/?#]+[^?#]*).*/, '$1').replace(/\d+/g, '9');
                return `str(${v.length})`;
            case 'number':
                if (v > 1e12 && v < 1e13) return 'num:ms-time';
                if (v > 1e9 && v < 1e10) return 'num:s-time';
                return Number.isInteger(v) ? `int(${String(Math.abs(v)).length}d)` : 'float';
            case 'boolean': return v;
            default: return typeof v;
        }
    }
    const shapeOf = (v) => {
        if (Array.isArray(v)) return '[' + (v.length ? shapeOf(v[0]) : '') + ']';
        if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => k + ':' + shapeOf(v[k])).join(',') + '}';
        return typeof v;
    };
    // Socket frames may be plain JSON or carry a numeric prefix (socket.io "42[...]").
    function parseFrame(data) {
        if (typeof data !== 'string') {
            const n = data && (data.byteLength != null ? data.byteLength : data.size);
            return { kind: 'binary', note: `binary(${n || '?'} bytes)` };
        }
        const m = data.match(/^(\d*)([[{][\s\S]*)$/);
        if (m) { try { return { kind: 'json', prefix: m[1], json: JSON.parse(m[2]) }; } catch (e) {} }
        return { kind: 'text', note: `text(${data.length}) starts "${data.slice(0, 6).replace(/[A-Za-z]/g, 'a')}"` };
    }
    const cleanUrl = (u) => String(u || '').replace(/([?&](key|token|auth|sig|signature|session|access_token|rfcv)=)[^&]*/gi, '$1…');

    // ------------------------------------------------------------ recording
    const rec = { sockets: [], http: [], shapes: {} };
    function note(channel, dir, data) {
        const p = parseFrame(data);
        const sig = channel + '|' + dir + '|' + (p.kind === 'json' ? p.prefix + shapeOf(p.json) : p.kind);
        let s = rec.shapes[sig];
        if (!s) {
            if (Object.keys(rec.shapes).length >= MAX_SHAPES) return;
            s = rec.shapes[sig] = { channel, dir, prefix: p.prefix || '', count: 0, samples: [] };
        }
        s.count++;
        if (s.samples.length < MAX_SAMPLES) s.samples.push(p.kind === 'json' ? redact(p.json, '', 0) : p.note);
        paintCounts();
    }

    const NativeWS = window.WebSocket;
    if (NativeWS) {
        const Wrapped = function (url, protocols) {
            const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
            const entry = { url: cleanUrl(url), opened: new Date().toISOString(), frames: 0 };
            rec.sockets.push(entry);
            const ch = 'ws#' + rec.sockets.length;
            ws.addEventListener('message', (e) => { entry.frames++; try { note(ch, 'in', e.data); } catch (err) {} });
            const send = ws.send;
            ws.send = function (data) { try { note(ch, 'out', data); } catch (err) {} return send.apply(this, arguments); };
            return ws;
        };
        Wrapped.prototype = NativeWS.prototype;
        ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { Wrapped[k] = NativeWS[k]; });
        window.WebSocket = Wrapped;
    }

    function noteHttp(method, url, body, text) {
        if (!CHAT_URL_RE.test(url)) return;
        const entry = { method, url: cleanUrl(url).replace(/\d{5,}/g, '9…') };
        if (body && typeof body === 'string') { try { entry.request = redact(JSON.parse(body), '', 0); } catch (e) { entry.request = `str(${body.length})`; } }
        const ch = 'http ' + entry.url.replace(/\?.*/, '');
        if (rec.http.length < 100) rec.http.push(entry);
        if (text != null) note(ch, 'in', text);
    }
    const nativeFetch = window.fetch;
    if (nativeFetch) {
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const method = (init && init.method) || (input && input.method) || 'GET';
            const p = nativeFetch.apply(this, arguments);
            if (CHAT_URL_RE.test(url)) {
                p.then((r) => r.clone().text()).then((t) => noteHttp(method, url, init && init.body, t)).catch(() => {});
            }
            return p;
        };
    }
    const X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (X) {
        const open = X.open, send = X.send;
        X.open = function (method, url) { this.__tci = { method, url: String(url || '') }; return open.apply(this, arguments); };
        X.send = function (body) {
            const info = this.__tci;
            if (info && CHAT_URL_RE.test(info.url)) {
                this.addEventListener('load', () => { try { noteHttp(info.method, info.url, body, this.responseText); } catch (e) {} });
            }
            return send.apply(this, arguments);
        };
    }

    // ------------------------------------------------------------ page structure
    // Chat containers with every text and free-text attribute replaced by its length.
    function chatRoots() {
        const all = Array.from(document.querySelectorAll('#chatRoot, [id*="chat" i], [class*="chat" i]'))
            .filter((el) => !el.closest('[id^="tci-"]'));
        return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
    }
    const KEEP_ATTR_RE = /^(class|id|role|type|tabindex|aria-(expanded|selected|hidden|live|haspopup|controls|labelledby)|data-(?!placeholder|name|user|text|content).*)$/i;
    function redactDom(root) {
        const clone = root.cloneNode(true);
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        const texts = [];
        while (walker.nextNode()) texts.push(walker.currentNode);
        texts.forEach((t) => { const s = t.nodeValue.trim(); if (s) t.nodeValue = `[text ${s.length}]`; });
        clone.querySelectorAll('*').forEach((el) => {
            if (/^(script|style|svg)$/i.test(el.tagName)) { el.innerHTML = el.tagName.toLowerCase() === 'svg' ? '' : '[…]'; }
            Array.from(el.attributes).forEach((a) => {
                if (KEEP_ATTR_RE.test(a.name)) return;
                if (a.name === 'href' || a.name === 'src') el.setAttribute(a.name, a.value.replace(/^(https?:\/\/[^/]+)?([^?#]*).*/, '$2').replace(/\d+/g, '9'));
                else el.setAttribute(a.name, `[${a.value.length}]`);
            });
        });
        return clone.outerHTML;
    }

    function report() {
        return {
            tool: 'Torn Chat Inspector ' + VERSION,
            when: new Date().toISOString(),
            page: location.pathname + location.search.replace(/\d{5,}/g, '9…'),
            userAgent: navigator.userAgent,
            hookedBeforeChat: rec.sockets.length > 0 || rec.http.length > 0,
            sockets: rec.sockets,
            http: rec.http,
            messages: Object.values(rec.shapes),
            dom: chatRoots().map(redactDom),
        };
    }

    // ------------------------------------------------------------ panel
    function paintCounts() {
        const el = document.getElementById('tci-counts');
        if (el) el.textContent = counts();
    }
    const counts = () => `Sockets: ${rec.sockets.length} · message types: ${Object.keys(rec.shapes).length} · ` +
        `frames: ${Object.values(rec.shapes).reduce((s, x) => s + x.count, 0)} · chat boxes on page: ${chatRoots().length}`;
    function openPanel() {
        if (document.getElementById('tci-overlay')) return;
        const o = document.createElement('div');
        o.id = 'tci-overlay';
        o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;font:14px/1.4 Arial,sans-serif';
        o.innerHTML = `<div style="width:420px;max-width:94vw;max-height:90vh;overflow:auto;box-sizing:border-box;padding:16px;border-radius:12px;background:#1f2227;color:#f1f3f5;border:1px solid #3a3f47">
            <h3 style="margin:0 0 8px;font-size:16px;color:#f1f3f5">🔎 Chat inspector <small>v${VERSION}</small></h3>
            <p style="margin:0 0 8px;font-size:12px;color:#c3c8cf">Open a few chats (a private one, faction, global) and let some messages arrive, then take the report.
               Texts and names are removed. Nothing is sent anywhere.</p>
            <div id="tci-counts" style="font-size:12px;margin-bottom:10px;color:#f1f3f5">${counts()}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button id="tci-copy" style="padding:8px 12px;border:0;border-radius:7px;background:#e08a1e;color:#fff;font-weight:700">Copy report</button>
                <button id="tci-save" style="padding:8px 12px;border:0;border-radius:7px;background:#4a90d9;color:#fff;font-weight:700">Save file</button>
                <button id="tci-close" style="padding:8px 12px;border:1px solid #3a3f47;border-radius:7px;background:transparent;color:#f1f3f5">Close</button>
            </div>
            <div id="tci-msg" style="font-size:12px;margin-top:8px;color:#c3c8cf"></div>
            <textarea id="tci-out" readonly style="display:none;width:100%;height:160px;margin-top:8px;box-sizing:border-box;font:11px monospace;background:#15171b;color:#f1f3f5;border:1px solid #3a3f47"></textarea>
        </div>`;
        document.body.appendChild(o);
        const msg = (t) => { o.querySelector('#tci-msg').textContent = t; };
        o.addEventListener('click', (e) => { if (e.target === o) o.remove(); });
        o.querySelector('#tci-close').addEventListener('click', () => o.remove());
        o.querySelector('#tci-copy').addEventListener('click', async () => {
            const text = JSON.stringify(report(), null, 1);
            const ta = o.querySelector('#tci-out');
            ta.value = text;
            try { await navigator.clipboard.writeText(text); msg(`Copied (${Math.round(text.length / 1024)} KB).`); }
            catch (e) { ta.style.display = 'block'; ta.select(); msg('Clipboard blocked: the report is in the box below, select all and copy it.'); }
        });
        o.querySelector('#tci-save').addEventListener('click', () => {
            const text = JSON.stringify(report(), null, 1);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
            a.download = 'torn-chat-report.json';
            document.body.appendChild(a); a.click(); a.remove();
            msg('If no download started (Torn PDA may block it), use Copy report instead.');
        });
    }

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
    const LENS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<circle cx="10" cy="10" r="6" fill="none" stroke="#fff" stroke-width="2.4"/>' +
        '<path stroke="#fff" stroke-width="2.6" stroke-linecap="round" d="M14.5 14.5L20 20"/></svg>';
    function mountButton() {
        hubMount({ id: 'tci', label: 'Chat inspector', svg: LENS_SVG,
            bg: 'linear-gradient(to bottom, #8a8f98, #4a4f58)', onOpen: openPanel });
    }

    function start() {
        if (!document.body) return setTimeout(start, 300);
        mountButton();
        let pending = false;
        new MutationObserver(() => {
            if (pending || document.hidden) return;
            pending = true;
            setTimeout(() => { pending = false; mountButton(); }, 500);
        }).observe(document.body, { childList: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
