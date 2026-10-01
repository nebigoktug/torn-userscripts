// ==UserScript==
// @name         Torn Chat Panel
// @namespace    https://github.com/nebigoktug
// @version      0.1.2
// @description  A full-screen messenger-style view of Torn's Chat 3.1: one list of all your chats with last message, time, unread count and online dot, and a bubble view per chat. Torn's own chat does the work underneath: messages are read from what Torn already loads, and sending types into Torn's own message box.
// @author       Nebigoktug
// @license      MIT
// @supportURL   https://github.com/nebigoktug/torn-userscripts/issues
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Chat_Panel.user.js
// @updateURL    https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Chat_Panel.user.js
// ==/UserScript==

/*
 * Torn Chat Panel
 *
 * Chat 3.1 loads its data as JSON (/tchat/rooms, /tchat/dm, …/messages) and
 * gets new messages over its WebSocket. This script listens to those
 * answers on the page you are viewing and draws them as a chat list and
 * bubbles.
 *
 * Non-API requests (disclosed per Torn's scripting rules): when you tap a
 * chat whose messages Torn hasn't loaded on this page (a private chat whose
 * window was already open, for example), the script asks Torn's chat for
 * that chat's latest 50 messages once — the same request Torn's own chat
 * makes. Nothing is requested automatically.
 *
 * Torn's chat keeps running underneath the panel. When you tap a chat, the
 * matching button in Torn's chat bar is tapped so Torn opens (and loads) that
 * chat; scrolling up scrolls Torn's window so Torn loads older messages; Send
 * puts your text into Torn's message box and taps Torn's send button. Every
 * one of these happens only because you tapped or scrolled.
 *
 * Times are TCT, like the rest of Torn.
 */

(function () {
    'use strict';

    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;
    if (window.__twcRunning) return;
    window.__twcRunning = true;

    const VERSION  = '0.1.2';
    const REPO_URL = 'https://github.com/nebigoktug/torn-userscripts';
    const LS_CONVS = 'twc_convs';      // chat list (names, last message) for a quick start
    const LS_ME    = 'twc_me';
    const ROOM_ICONS = { faction: '🛡️', company: '🏢', global: '🌐', trade: '🔁' };

    // ------------------------------------------------------------ state
    const convs = new Map();   // key "room:faction" / "dm:123" -> conversation
    const msgs = new Map();    // key -> { list: [message], ids: Set, hasOlder }
    let myId = Number(lsGet(LS_ME)) || 0;
    let currentKey = null;
    let olderPending = 0;

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    try {
        (JSON.parse(lsGet(LS_CONVS) || '[]') || []).forEach((c) => {
            if (!c || !c.key) return;
            // v0.1.0/0.1.1 saved previews still HTML-encoded.
            if (c.last && /&(#\d+|#x[0-9a-f]+|quot|amp|lt|gt|apos);/i.test(c.last.content || '')) c.last.content = decode(c.last.content);
            convs.set(c.key, Object.assign(c, { stale: true }));
        });
    } catch (e) {}
    let saveTimer = null;
    function saveConvs() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => lsSet(LS_CONVS, JSON.stringify(Array.from(convs.values()).slice(0, 80)
            .map(({ stale, ...c }) => c))), 1000);
    }

    const roomKey = (id) => 'room:' + id;
    const dmKey = (uid) => 'dm:' + uid;
    function conv(key, init) {
        let c = convs.get(key);
        if (!c) { c = Object.assign({ key, unread: 0, last: null }, init); convs.set(key, c); }
        else if (init) Object.assign(c, init);
        c.stale = false;
        return c;
    }
    function box(key) {
        let b = msgs.get(key);
        if (!b) { b = { list: [], ids: new Set(), hasOlder: true }; msgs.set(key, b); }
        return b;
    }
    function learnMe(uid) {
        if (uid && uid !== myId) { myId = uid; lsSet(LS_ME, String(uid)); }
    }
    function addMessages(key, items, opts) {
        const b = box(key);
        let added = 0;
        (items || []).forEach((m) => {
            if (!m || !m.messageId || b.ids.has(m.messageId)) return;
            clean(m);
            // Our own pending bubble: replace it with the real one.
            const pi = b.list.findIndex((x) => x.pending && x.content === m.content && isMine(key, m));
            if (pi >= 0) b.list.splice(pi, 1);
            b.ids.add(m.messageId);
            b.list.push(m);
            added++;
        });
        if (opts && 'hasOlder' in opts) { b.hasOlder = !!opts.hasOlder; b.loaded = true; }
        b.list.sort((a, c) => (a.createdAt || 0) - (c.createdAt || 0));
        const newest = b.list[b.list.length - 1];
        if (newest && !newest.pending) {
            const c = conv(key);
            if (!c.last || (newest.createdAt || 0) >= (c.last.createdAt || 0)) c.last = slim(newest);
        }
        return added;
    }
    // Torn sends chat text already HTML-encoded ("She&#039;s"). Decode it once
    // on the way in; everything is escaped again when drawn.
    // (A function declaration, so the saved-list loader above can use it.)
    function decode(str) {
        const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
        return String(str == null ? '' : str).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
            if (e[0] === '#') {
                const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
            }
            return ent[e.toLowerCase()] != null ? ent[e.toLowerCase()] : all;
        });
    }
    function clean(m) {
        if (m && !m.__twcClean) {
            m.content = decode(m.content);
            if (m.sender && m.sender.name) m.sender.name = decode(m.sender.name);
            m.__twcClean = true;
        }
        return m;
    }
    const slim = (m) => ({ content: String(clean(m).content || '').slice(0, 200), createdAt: m.createdAt,
        senderId: m.sender && m.sender.userId, senderName: m.sender && m.sender.name });
    function isMine(key, m) {
        const uid = m && m.sender && m.sender.userId;
        if (!uid) return !!(m && m.pending);
        if (key.startsWith('dm:')) return String(uid) !== key.slice(3);
        return uid === myId;
    }

    // ------------------------------------------------------------ reading Torn's chat data
    function onJson(path, data) {
        let m;
        if (path === '/tchat/rooms' && data && Array.isArray(data.items)) {
            data.items.forEach((r) => { if (!r.isLeft) conv(roomKey(r.id), { type: 'room', id: r.id, name: decode(r.name), rules: r.rules || null }); });
        } else if ((m = path.match(/^\/tchat\/rooms\/([^/]+)\/join$/)) && data && data.id) {
            conv(roomKey(data.id), { type: 'room', id: data.id, name: decode(data.name), rules: data.rules || null });
        } else if (path === '/tchat/dm' && data && Array.isArray(data.items)) {
            data.items.forEach(dmItem);
        } else if ((m = path.match(/^\/tchat\/dm\/(\d+)$/)) && data && data.otherUser) {
            dmItem(data);
        } else if ((m = path.match(/^\/tchat\/(rooms|dm)\/([^/]+)\/messages$/)) && data && Array.isArray(data.items)) {
            const key = m[1] === 'rooms' ? roomKey(m[2]) : dmKey(m[2]);
            const before = box(key).list.length;
            addMessages(key, data.items, { hasOlder: data.hasOlder });
            if (key.startsWith('dm:')) data.items.forEach((x) => { if (x.sender && String(x.sender.userId) !== m[2]) learnMe(x.sender.userId); });
            if (key === currentKey) {
                // Only an "older" page keeps the reader's place; a first load jumps to the newest.
                const older = !!olderPending && box(key).list.length > before && before > 0;
                olderPending = 0;
                renderMessages(older, !older);
            }
        } else if (path === '/tchat/unread' && data) {
            Object.entries(data.rooms || {}).forEach(([id, n]) => { conv(roomKey(id), { type: 'room', id }).unread = Number(n) || 0; });
            Object.entries(data.dm || {}).forEach(([id, n]) => { conv(dmKey(id), { type: 'dm', id }).unread = Number(n) || 0; });
        } else if (path === '/tchat/social/online' && data && typeof data === 'object') {
            Object.entries(data).forEach(([uid, st]) => { const c = convs.get(dmKey(uid)); if (c) c.online = String(st); });
        } else return;
        saveConvs();
        renderSoon();
    }
    function dmItem(d) {
        const u = d.otherUser || {};
        if (!u.userId) return;
        const c = conv(dmKey(u.userId), { type: 'dm', id: String(u.userId), name: decode(u.name), avatar: u.avatar });
        if (d.lastMessage && (!c.last || (d.lastMessage.createdAt || 0) >= (c.last.createdAt || 0))) c.last = slim(d.lastMessage);
        if (d.lastMessage && d.lastMessage.sender && d.lastMessage.sender.userId !== u.userId) learnMe(d.lastMessage.sender.userId);
    }
    // Live events from the chat WebSocket (Centrifugo, JSON, one reply per line).
    function onSocketText(text) {
        String(text).split('\n').forEach((line) => {
            if (line.indexOf('tchat') < 0) return;
            let f;
            try { f = JSON.parse(line); } catch (e) { return; }
            const acts = f && f.push && f.push.pub && f.push.pub.data && f.push.pub.data.message &&
                f.push.pub.data.message.namespaces && f.push.pub.data.message.namespaces.tchat &&
                f.push.pub.data.message.namespaces.tchat.actions;
            if (!acts) return;
            const got = acts.onMessageReceived;
            if (got && got.message) {
                const id = String(got.id);
                const m = clean(got.message);
                const key = convs.has(roomKey(id)) || ROOM_ICONS[id] ? roomKey(id) : dmKey(id);
                if (key.startsWith('dm:')) {
                    const c = conv(key, { type: 'dm', id });
                    if (m.sender && String(m.sender.userId) === id) { c.name = c.name || m.sender.name; c.avatar = c.avatar || m.sender.avatar; }
                    else if (m.sender) learnMe(m.sender.userId);
                } else conv(key, { type: 'room', id });
                addMessages(key, [m]);
                const c = convs.get(key);
                if (key !== currentKey && !isMine(key, m)) c.unread = (c.unread || 0) + 1;
                if (key === currentKey) renderMessages(false, true);
                saveConvs();
                renderSoon();
            }
            const rs = acts.onReadStateUpdated;
            if (rs && rs.id != null && rs.snapshotUnreadCount != null) {
                const key = /room/i.test(rs.scope || '') ? roomKey(rs.id) : convs.has(dmKey(rs.id)) ? dmKey(rs.id) : roomKey(rs.id);
                const c = convs.get(key);
                if (c) { c.unread = Number(rs.snapshotUnreadCount) || 0; renderSoon(); }
            }
        });
    }

    // Hooks. Nothing here changes what Torn sends or receives: answers are
    // cloned before reading, and the WebSocket class is never replaced
    // (sockets are found through their handlers, like the Chat Inspector).
    const pathOf = (u) => { try { return new URL(u, location.href).pathname; } catch (e) { return ''; } };
    const nativeFetch = window.fetch;
    if (nativeFetch) {
        window.fetch = function (input) {
            const p = nativeFetch.apply(this, arguments);
            try {
                const path = pathOf(typeof input === 'string' ? input : (input && input.url) || '');
                if (path.startsWith('/tchat/')) {
                    p.then((r) => (/json/.test(r.headers.get('content-type') || '') ? r.clone().json() : null))
                        .then((d) => { if (d) onJson(path, d); }).catch(() => {});
                }
            } catch (e) {}
            return p;
        };
    }
    const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP) {
        const open = XP.open, send = XP.send;
        XP.open = function (method, url) { this.__twcPath = pathOf(String(url || '')); return open.apply(this, arguments); };
        XP.send = function () {
            if (this.__twcPath && this.__twcPath.startsWith('/tchat/')) {
                const path = this.__twcPath;
                this.addEventListener('load', () => {
                    try {
                        const d = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
                        onJson(path, d);
                    } catch (e) {}
                });
            }
            return send.apply(this, arguments);
        };
    }
    const seenSockets = new WeakSet();
    function watchSocket(ws) {
        if (seenSockets.has(ws) || !/centrifugo/i.test(ws.url || '')) return;
        seenSockets.add(ws);
        EventTarget.prototype.addEventListener.call(ws, 'message', (e) => {
            if (typeof e.data === 'string') { try { onSocketText(e.data); } catch (err) {} }
        });
    }
    (function hookSockets() {
        const P = window.WebSocket && window.WebSocket.prototype;
        if (!P) return;
        ['onopen', 'onmessage', 'onclose', 'onerror'].forEach((prop) => {
            const d = Object.getOwnPropertyDescriptor(P, prop);
            if (!d || !d.set) return;
            Object.defineProperty(P, prop, Object.assign({}, d, {
                set(v) { try { watchSocket(this); } catch (e) {} return d.set.call(this, v); },
            }));
        });
        const add = P.addEventListener || EventTarget.prototype.addEventListener;
        P.addEventListener = function () { try { watchSocket(this); } catch (e) {} return add.apply(this, arguments); };
    })();

    // Own user ID from Torn's chat bootstrap data, if it carries one.
    function readBootstrap() {
        const el = document.getElementById('tchat-bootstrap');
        if (!el) return;
        try {
            const find = (o, d) => {
                if (!o || typeof o !== 'object' || d > 4) return 0;
                for (const [k, v] of Object.entries(o)) {
                    if (/^(user_?id|uid|id|userID)$/i.test(k) && Number(v) > 0 && String(v).length >= 4) return Number(v);
                    const r = find(v, d + 1);
                    if (r) return r;
                }
                return 0;
            };
            const id = find(JSON.parse(el.textContent), 0);
            if (id) learnMe(id);
        } catch (e) {}
    }

    // ------------------------------------------------------------ driving Torn's chat (on your taps only)
    const chatRoot = () => document.getElementById('chatRoot');
    function tornWindow(c) {
        const root = chatRoot();
        if (!root) return null;
        const el = document.getElementById(String(c.id));
        return el && root.contains(el) && el.querySelector('textarea') ? el : null;
    }
    function waitFor(fn, ms) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const tick = () => {
                const v = fn();
                if (v || Date.now() - t0 > ms) { resolve(v || null); return; }
                setTimeout(tick, 120);
            };
            tick();
        });
    }
    // Make Torn open this chat (which also makes Torn load its messages).
    async function openInTorn(c) {
        const have = tornWindow(c);
        if (have) return have;
        const btn = document.getElementById('chat_panel_button:' + c.id);
        if (btn) btn.click();
        else if (c.type === 'dm') {
            let card = document.getElementById('private_chat_card_' + c.id);
            if (!card) {
                const people = document.getElementById('people_panel_button');
                if (people) people.click();
                card = await waitFor(() => document.getElementById('private_chat_card_' + c.id), 3000);
            }
            if (card) (card.querySelector('button, [role="button"]') || card).click();
        }
        return waitFor(() => tornWindow(c), 4000);
    }
    // One request, only after a tap on a chat Torn hasn't loaded: the same
    // address Torn's chat uses. It goes through the fetch hook above, so the
    // answer is read like Torn's own.
    const historyAsked = new Set();
    async function fetchHistory(c) {
        if (historyAsked.has(c.key)) return '';
        historyAsked.add(c.key);
        const url = `/tchat/${c.type === 'dm' ? 'dm' : 'rooms'}/${encodeURIComponent(c.id)}/messages?prev_limit=50`;
        try {
            const r = await window.fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
            if (!r.ok) { historyAsked.delete(c.key); return `Torn's chat answered ${r.status} for this chat.`; }
            await waitFor(() => box(c.key).loaded, 1000);
            return box(c.key).loaded ? '' : 'No messages came back for this chat.';
        } catch (e) {
            historyAsked.delete(c.key);
            return 'Could not load this chat\'s messages.';
        }
    }

    // Scroll Torn's window to its top so Torn loads the next older page.
    function loadOlder() {
        const c = convs.get(currentKey);
        const b = c && box(c.key);
        if (!c || !b.hasOlder || olderPending) return;
        const win = tornWindow(c);
        if (!win) return;
        olderPending = Date.now();
        setTimeout(() => { if (olderPending && Date.now() - olderPending >= 4000) { olderPending = 0; paintOlder(); } }, 4100);
        paintOlder();
        const sentinel = win.querySelector('[class*="topSentinel"]');
        win.querySelectorAll('*').forEach((el) => {
            if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
                el.scrollTop = 0;
                el.dispatchEvent(new Event('scroll'));
            }
        });
        if (sentinel) try { sentinel.scrollIntoView({ block: 'start' }); } catch (e) {}
    }
    async function sendText(c, text) {
        const win = await openInTorn(c);
        if (!win) return 'Could not open this chat in Torn.';
        const ta = win.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = await waitFor(() => { const b = ta.parentElement && ta.parentElement.querySelector('button'); return b && !b.disabled ? b : null; }, 1500);
        if (!btn) return 'Torn did not accept the message (too long, or a cooldown?).';
        btn.click();
        const cleared = await waitFor(() => ta.value === '', 2500);
        return cleared === null && ta.value !== '' ? 'Torn did not send it — check Torn\'s chat window.' : '';
    }

    // ------------------------------------------------------------ formatting
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const linkify = (s) => esc(s).replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).replace(/\n/g, '<br>');
    const pad = (n) => String(n).padStart(2, '0');
    const tct = (ms) => { const d = new Date(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
    const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
    function dayLabel(ms) {
        const k = dayKey(ms), today = dayKey(Date.now()), yest = dayKey(Date.now() - 864e5);
        if (k === today) return 'Today';
        if (k === yest) return 'Yesterday';
        const d = new Date(ms);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric', timeZone: 'UTC' });
    }
    function listTime(ms) {
        if (!ms) return '';
        const k = dayKey(ms);
        if (k === dayKey(Date.now())) return tct(ms);
        if (k === dayKey(Date.now() - 864e5)) return 'Yesterday';
        return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    }
    const NAME_COLORS = ['#e5786d', '#5fb0e8', '#f0a64b', '#7dcf8a', '#c690e8', '#e8c95f', '#5fd1c4', '#e88fb5'];
    const nameColor = (uid) => NAME_COLORS[Math.abs(Number(uid) || 0) % NAME_COLORS.length];
    function avatarHtml(c) {
        if (c.type === 'room') return `<span class="twc-av twc-room">${ROOM_ICONS[c.id] || '💬'}</span>`;
        const dot = c.online && /online/i.test(c.online) ? '<i class="twc-dot on"></i>' : c.online && /idle/i.test(c.online) ? '<i class="twc-dot idle"></i>' : '';
        return `<span class="twc-av">${c.avatar ? `<img src="${esc(c.avatar)}" alt="" loading="lazy">` : esc((c.name || '?').slice(0, 1))}${dot}</span>`;
    }
    const titleOf = (c) => c.name || (c.type === 'room' ? c.id.charAt(0).toUpperCase() + c.id.slice(1) : 'Player ' + c.id);

    // ------------------------------------------------------------ UI
    let root = null;
    let query = '';
    function injectStyles() {
        if (document.getElementById('twc-styles')) return;
        const st = document.createElement('style');
        st.id = 'twc-styles';
        st.textContent = `
        #twc-root { --bg: #0b141a; --panel: #111b21; --head: #202c33; --fg: #e9edef; --muted: #8696a0; --line: #222d34;
            --mine: #005c4b; --theirs: #202c33; --accent: #00a884; --badge: #00a884; --input: #2a3942; --link: #53bdeb; }
        body:not(.dark-mode) #twc-root { --bg: #efeae2; --panel: #fff; --head: #f0f2f5; --fg: #111b21; --muted: #667781; --line: #e9edef;
            --mine: #d9fdd3; --theirs: #fff; --accent: #008069; --badge: #25d366; --input: #fff; --link: #027eb5; }
        #twc-root { position: fixed; inset: 0; z-index: 2147483640; display: flex; background: var(--bg); color: var(--fg);
            font: 15px/1.35 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        #twc-root * { box-sizing: border-box; }
        #twc-root, #twc-root span, #twc-root div, #twc-root b, #twc-root p { color: var(--fg); }
        #twc-root .twc-list { flex: 0 0 100%; display: flex; flex-direction: column; background: var(--panel); min-width: 0; }
        #twc-root .twc-conv { flex: 1 1 auto; display: none; flex-direction: column; min-width: 0; background: var(--bg); }
        #twc-root.open .twc-list { display: none; }
        #twc-root.open .twc-conv { display: flex; }
        @media (min-width: 760px) {
            #twc-root .twc-list { flex: 0 0 360px; border-right: 1px solid var(--line); display: flex !important; }
            #twc-root .twc-conv { display: flex; }
            #twc-root .twc-back { display: none !important; }
        }
        #twc-root .twc-head { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 12px; background: var(--head); flex: none; }
        #twc-root .twc-head h1 { flex: 1; margin: 0; font-size: 19px; font-weight: 600; }
        #twc-root .twc-ib { background: none; border: 0; padding: 6px; cursor: pointer; font-size: 20px; line-height: 1; color: var(--muted); }
        #twc-root .twc-ib:hover { color: var(--fg); }
        #twc-root .twc-search { padding: 6px 12px 8px; background: var(--panel); flex: none; }
        #twc-root .twc-search input { width: 100%; padding: 8px 12px; border-radius: 8px; border: 0; background: var(--head); color: var(--fg); font-size: 14px; outline: none; }
        #twc-root .twc-items { flex: 1; overflow-y: auto; }
        #twc-root .twc-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; cursor: pointer; }
        #twc-root .twc-item:hover, #twc-root .twc-item.sel { background: var(--head); }
        #twc-root .twc-item .twc-mid { flex: 1; min-width: 0; border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: -10px; }
        #twc-root .twc-row { display: flex; align-items: baseline; gap: 6px; }
        #twc-root .twc-name { flex: 1; min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #twc-root .twc-time { font-size: 12px; color: var(--muted); }
        #twc-root .twc-item.unread .twc-time { color: var(--badge); }
        #twc-root .twc-prev { flex: 1; min-width: 0; font-size: 13.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #twc-root .twc-badge { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--badge); color: #fff !important;
            font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
        #twc-root .twc-av { position: relative; flex: none; width: 46px; height: 46px; border-radius: 50%; background: var(--head);
            display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 600; color: var(--muted); }
        #twc-root .twc-av img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
        #twc-root .twc-head .twc-av { width: 38px; height: 38px; font-size: 17px; }
        #twc-root .twc-dot { position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--panel); }
        #twc-root .twc-dot.on { background: #25d366; }
        #twc-root .twc-dot.idle { background: #f0b232; }
        #twc-root .twc-empty { padding: 30px 20px; text-align: center; color: var(--muted); font-size: 14px; }
        #twc-root .twc-ctitle { flex: 1; min-width: 0; }
        #twc-root .twc-ctitle b { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #twc-root .twc-ctitle small { display: block; font-size: 12.5px; color: var(--muted); }
        #twc-root .twc-ctitle a { color: inherit; text-decoration: none; }
        #twc-root .twc-msgs { flex: 1; overflow-y: auto; padding: 8px 6% 10px; display: flex; flex-direction: column; gap: 2px; }
        #twc-root .twc-day { align-self: center; margin: 10px 0 6px; padding: 5px 12px; border-radius: 8px; background: var(--head); font-size: 12.5px; color: var(--muted); }
        #twc-root .twc-older { align-self: center; margin: 6px 0; font-size: 12.5px; color: var(--muted); }
        #twc-root .twc-b { position: relative; max-width: min(78%, 560px); padding: 6px 8px 7px; border-radius: 8px; background: var(--theirs);
            align-self: flex-start; box-shadow: 0 1px .5px rgba(0,0,0,.13); overflow-wrap: anywhere; margin-top: 1px; }
        #twc-root .twc-b.first { margin-top: 8px; border-top-left-radius: 0; }
        #twc-root .twc-b.mine { align-self: flex-end; background: var(--mine); }
        #twc-root .twc-b.mine.first { border-top-left-radius: 8px; border-top-right-radius: 0; }
        #twc-root .twc-b .twc-from { display: block; font-size: 13px; font-weight: 600; margin-bottom: 1px; }
        #twc-root .twc-b .twc-txt { font-size: 14.5px; }
        #twc-root .twc-b .twc-txt a { color: var(--link) !important; }
        #twc-root .twc-b .twc-meta { float: right; margin: 6px 0 -4px 10px; font-size: 11px; color: var(--muted); white-space: nowrap; }
        #twc-root .twc-b.pending .twc-meta::after { content: ' 🕓'; }
        #twc-root .twc-b.failed { outline: 1px solid #e5534b; }
        #twc-root .twc-compose { display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px; background: var(--head); flex: none; }
        #twc-root .twc-compose textarea { flex: 1; resize: none; max-height: 120px; min-height: 40px; padding: 10px 12px; border-radius: 20px; border: 0;
            background: var(--input); color: var(--fg); font: inherit; outline: none; }
        #twc-root .twc-send { flex: none; width: 42px; height: 42px; border-radius: 50%; border: 0; background: var(--accent); color: #fff !important;
            font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        #twc-root .twc-send:disabled { opacity: .5; }
        #twc-root .twc-count { font-size: 11px; color: var(--muted); align-self: center; }
        #twc-root .twc-err { padding: 6px 12px; font-size: 12.5px; color: #e5534b; background: var(--head); }
        #twc-root .twc-pick { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted); text-align: center; padding: 20px; }
        #twc-root .twc-foot { padding: 6px 12px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--line); flex: none; }
        #twc-root .twc-foot a { color: var(--muted); }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    function openPanel() {
        if (root) return;
        injectStyles();
        readBootstrap();
        root = document.createElement('div');
        root.id = 'twc-root';
        // "chat-box" makes FF/BS Badges skip the names in here, as in Torn's chat.
        root.className = 'chat-box';
        root.innerHTML = `
            <section class="twc-list">
                <div class="twc-head"><h1>Chats</h1><button class="twc-ib" data-a="close" title="Close">✕</button></div>
                <div class="twc-search"><input type="search" placeholder="Search" autocomplete="off"></div>
                <div class="twc-items"></div>
                <div class="twc-foot">Times in TCT · Torn Chat Panel v${VERSION} · <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></div>
            </section>
            <section class="twc-conv"><div class="twc-pick"><div style="font-size:40px">💬</div>Pick a chat</div></section>`;
        document.body.appendChild(root);
        root.querySelector('[data-a="close"]').addEventListener('click', closePanel);
        const search = root.querySelector('.twc-search input');
        search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderList(); });
        root.querySelector('.twc-items').addEventListener('click', (e) => {
            const it = e.target.closest('[data-key]');
            if (it) openConv(it.getAttribute('data-key'));
        });
        document.addEventListener('keydown', onKey, true);
        renderList();
        // No private chats known yet: open Torn's people panel so Torn loads them.
        if (!Array.from(convs.values()).some((c) => c.type === 'dm' && !c.stale)) {
            const people = document.getElementById('people_panel_button');
            if (people && !document.getElementById('private-channel-list')) people.click();
        }
    }
    function closePanel() {
        if (!root) return;
        root.remove();
        root = null;
        currentKey = null;
        document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
        if (e.key !== 'Escape' || !root) return;
        if (currentKey && window.innerWidth < 760) backToList(); else closePanel();
    }
    function backToList() {
        currentKey = null;
        if (!root) return;
        root.classList.remove('open');
        root.querySelector('.twc-conv').innerHTML = '<div class="twc-pick"><div style="font-size:40px">💬</div>Pick a chat</div>';
        renderList();
    }

    let renderQueued = false;
    function renderSoon() {
        if (renderQueued || !root) return;
        renderQueued = true;
        requestAnimationFrame(() => { renderQueued = false; renderList(); paintHeader(); });
    }
    function sortedConvs() {
        return Array.from(convs.values())
            .filter((c) => c.type && c.id)
            .filter((c) => !query || titleOf(c).toLowerCase().includes(query) || (c.last && String(c.last.content).toLowerCase().includes(query)))
            .sort((a, b) => ((b.last && b.last.createdAt) || 0) - ((a.last && a.last.createdAt) || 0));
    }
    function renderList() {
        const el = root && root.querySelector('.twc-items');
        if (!el) return;
        const list = sortedConvs();
        if (!list.length) {
            el.innerHTML = `<div class="twc-empty">${query ? 'No chats found.' : 'Waiting for Torn\'s chat to load…<br>Open Torn\'s chat once if this stays empty.'}</div>`;
            return;
        }
        el.innerHTML = list.map((c) => {
            const l = c.last;
            const who = l && c.type === 'room' && l.senderName ? (l.senderId === myId ? 'You' : l.senderName) + ': '
                : l && c.type === 'dm' && String(l.senderId) !== c.id ? 'You: ' : '';
            return `<div class="twc-item${c.unread ? ' unread' : ''}${c.key === currentKey ? ' sel' : ''}" data-key="${esc(c.key)}">
                ${avatarHtml(c)}
                <div class="twc-mid">
                    <div class="twc-row"><span class="twc-name">${esc(titleOf(c))}</span><span class="twc-time">${listTime(l && l.createdAt)}</span></div>
                    <div class="twc-row"><span class="twc-prev">${l ? esc(who + String(l.content).replace(/\s+/g, ' ')) : '&nbsp;'}</span>${c.unread ? `<span class="twc-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
                </div></div>`;
        }).join('');
    }

    function openConv(key) {
        const c = convs.get(key);
        if (!c || !root) return;
        currentKey = key;
        olderPending = 0;
        root.classList.add('open');
        const max = c.rules && c.rules.maxLength;
        root.querySelector('.twc-conv').innerHTML = `
            <div class="twc-head">
                <button class="twc-ib twc-back" data-a="back" title="Back">←</button>
                ${avatarHtml(c)}
                <div class="twc-ctitle"></div>
                <button class="twc-ib" data-a="close2" title="Close">✕</button>
            </div>
            <div class="twc-msgs"></div>
            <div class="twc-err" hidden></div>
            <div class="twc-compose">
                <textarea rows="1" placeholder="Message" ${max ? `maxlength="${max}"` : ''}></textarea>
                ${max ? `<span class="twc-count">0/${max}</span>` : ''}
                <button class="twc-send" title="Send">➤</button>
            </div>`;
        const conv = root.querySelector('.twc-conv');
        conv.querySelector('[data-a="back"]').addEventListener('click', backToList);
        conv.querySelector('[data-a="close2"]').addEventListener('click', closePanel);
        const ta = conv.querySelector('textarea');
        const count = conv.querySelector('.twc-count');
        ta.addEventListener('input', () => {
            ta.style.height = 'auto';
            ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
            if (count) count.textContent = `${ta.value.length}/${max}`;
        });
        ta.addEventListener('keydown', (e) => {
            // Enter sends on desktop; on phones Enter is a new line, like WhatsApp.
            if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); doSend(); }
        });
        conv.querySelector('.twc-send').addEventListener('click', doSend);
        const box_ = conv.querySelector('.twc-msgs');
        box_.addEventListener('scroll', () => { if (box_.scrollTop < 60) loadOlder(); }, { passive: true });
        c.unread = 0;
        paintHeader();
        renderMessages(false, true);
        renderList();
        // Let Torn open this chat too: that loads its messages and marks them read.
        // If Torn already had it open, it won't load them again: ask once ourselves.
        openInTorn(c).then(async (win) => {
            if (currentKey !== key || box(key).loaded) return;
            await waitFor(() => box(key).loaded || currentKey !== key, 1500);
            if (currentKey !== key || box(key).loaded) return;
            const err = await fetchHistory(c);
            if (currentKey !== key) return;
            if (err) showErr(err + (win ? '' : ' Could not open this chat in Torn\'s chat bar either.'));
        });
    }
    function paintHeader() {
        const c = convs.get(currentKey);
        const t = root && root.querySelector('.twc-ctitle');
        if (!c || !t) return;
        const status = c.type === 'dm' ? (c.online ? String(c.online).toLowerCase() : '') : (c.rules && c.rules.cooldown ? `${c.rules.cooldown}s between messages` : '');
        const name = c.type === 'dm' ? `<a href="/profiles.php?XID=${encodeURIComponent(c.id)}">${esc(titleOf(c))}</a>` : esc(titleOf(c));
        const html = `<b>${name}</b>${status ? `<small>${esc(status)}</small>` : ''}`;
        if (t.innerHTML !== html) t.innerHTML = html;
    }
    function showErr(text) {
        const e = root && root.querySelector('.twc-err');
        if (!e) return;
        e.hidden = !text;
        e.textContent = text || '';
    }
    function paintOlder() {
        const el = root && root.querySelector('.twc-older');
        if (el) el.textContent = olderPending ? 'Loading older messages…' : '';
    }

    // keepTop: older messages were added above, keep the reader's place.
    // stick: scroll to the bottom if the reader was already near it.
    function renderMessages(keepTop, stick) {
        const el = root && root.querySelector('.twc-msgs');
        const c = convs.get(currentKey);
        if (!el || !c) return;
        const b = box(c.key);
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        const oldHeight = el.scrollHeight, oldTop = el.scrollTop;
        let html = `<div class="twc-older">${olderPending ? 'Loading older messages…' : ''}</div>`;
        if (!b.list.length) html += `<div class="twc-empty">${b.loaded ? 'No messages yet.' : 'Loading messages…'}</div>`;
        else if (!b.loaded) html += '<div class="twc-older">Loading earlier messages…</div>';
        let lastDay = '', lastSender = null;
        b.list.forEach((m) => {
            const d = dayKey(m.createdAt || Date.now());
            if (d !== lastDay) { html += `<div class="twc-day">${dayLabel(m.createdAt || Date.now())}</div>`; lastDay = d; lastSender = null; }
            const mine = isMine(c.key, m);
            const uid = m.sender && m.sender.userId;
            const first = uid !== lastSender;
            lastSender = uid;
            const from = c.type === 'room' && !mine && first && m.sender
                ? `<span class="twc-from" style="color:${nameColor(uid)} !important">${esc(m.sender.name)}</span>` : '';
            html += `<div class="twc-b${mine ? ' mine' : ''}${first ? ' first' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}">${from}` +
                `<span class="twc-txt">${linkify(m.content)}</span><span class="twc-meta">${m.createdAt ? tct(m.createdAt) : ''}</span></div>`;
        });
        el.innerHTML = html;
        if (keepTop) el.scrollTop = el.scrollHeight - oldHeight + oldTop;
        else if (stick === true ? true : nearBottom) el.scrollTop = el.scrollHeight;
    }

    let sending = false;
    async function doSend() {
        const c = convs.get(currentKey);
        const ta = root && root.querySelector('.twc-compose textarea');
        if (!c || !ta || sending) return;
        const text = ta.value.trim();
        if (!text) return;
        sending = true;
        showErr('');
        const btn = root.querySelector('.twc-send');
        btn.disabled = true;
        const pending = { messageId: 'pending-' + Date.now(), content: text, createdAt: Date.now(), pending: true,
            sender: myId ? { userId: myId } : null };
        const b = box(c.key);
        b.list.push(pending);
        ta.value = '';
        ta.dispatchEvent(new Event('input'));
        renderMessages(false, true);
        const err = await sendText(c, text);
        sending = false;
        if (root) root.querySelector('.twc-send') && (root.querySelector('.twc-send').disabled = false);
        if (err) {
            pending.pending = false;
            pending.failed = true;
            showErr(err);
            if (root && !ta.value) { ta.value = text; ta.dispatchEvent(new Event('input')); }
        } else {
            // Torn took it; the real message replaces this bubble when it comes back.
            setTimeout(() => { if (pending.pending) { pending.pending = false; if (currentKey === c.key) renderMessages(); } }, 8000);
        }
        if (currentKey === c.key) renderMessages(false, true);
    }

    // ------------------------------------------------------------ entry button
    const CHAT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<path fill="#fff" d="M12 3C7 3 3 6.6 3 11c0 2.2 1 4.2 2.7 5.6L5 21l4.2-2.2c.9.2 1.8.3 2.8.3 5 0 9-3.6 9-8s-4-8-9-8z"/></svg>';
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
        hubMount({ id: 'twc', label: 'Chat panel', svg: CHAT_SVG,
            bg: 'linear-gradient(to bottom, #25c26e, #0b8a4a)', onOpen: openPanel });
    }

    function start() {
        if (!document.body) return setTimeout(start, 200);
        mountButton();
        readBootstrap();
        let pending = false;
        new MutationObserver(() => {
            if (pending || document.hidden) return;
            pending = true;
            setTimeout(() => { pending = false; mountButton(); }, 500);
        }).observe(document.body, { childList: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
