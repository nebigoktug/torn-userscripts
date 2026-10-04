// ==UserScript==
// @name         Torn Chat Panel
// @namespace    https://github.com/nebigoktug
// @version      1.3.0
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
 * makes. And when you have read a chat to the bottom, it first lets Torn's
 * own window mark it read (scrolled to the bottom, then the ✕ on Torn's
 * "new messages" pill); only if Torn doesn't, it sends Torn's own "read"
 * request for that chat once, so the unread count doesn't come back on the
 * next page. Nothing is requested in the background.
 *
 * Torn's chat keeps running underneath the panel. When you tap a chat, the
 * matching button in Torn's chat bar is tapped so Torn opens (and loads) that
 * chat; scrolling up scrolls Torn's window so Torn loads older messages; Send
 * puts your text into Torn's message box and taps Torn's send button. Every
 * one of these happens only because you tapped or scrolled.
 *
 * New chats: Torn's own "Start chat" button on a profile (or mini profile)
 * opens the panel on that chat. Torn's search suggestions get a 💬 per
 * player: it opens the player's profile and taps Torn's "Start chat" there
 * once, because you tapped the 💬.
 *
 * Torn's own chat is hidden (a setting) but keeps running underneath; the
 * panel has its own button in the chat bar, with the unread total on it.
 *
 * Times are TCT, like the rest of Torn.
 */

(function () {
    'use strict';

    if (!/^(www\.)?torn\.com$/i.test(location.hostname)) return;
    if (window.__twcRunning) return;
    window.__twcRunning = true;

    const VERSION  = '1.3.0';
    const REPO_URL = 'https://github.com/nebigoktug/torn-userscripts';
    const LS_CONVS = 'twc_convs';      // chat list (names, last message) for a quick start
    const LS_ME    = 'twc_me';
    const LS_EMOJI_SEEN = 'twc_emoji_seen';     // emoji -> how often it appeared in your chats
    const LS_EMOJI_UPTO = 'twc_emoji_upto';     // chat -> newest message already counted
    const LS_EMOJI_RECENT = 'twc_emoji_recent';
    const DEFAULT_MAX_LEN = 840;                // Torn wiki: chat messages are capped at 840 characters
    const LS_PREFS = 'twc_prefs';
    const AUTHOR = { name: 'Nebigoktug', id: 3980062 };
    const touch = 'ontouchstart' in window;
    const prefs = Object.assign({ size: 'm', enterSends: !touch, wallpaper: true, ffbs: true, hideTorn: true, closeTornWins: true, muteSound: false, images: 'trusted', pinned: [], muted: [] },
        (() => { try { return JSON.parse(localStorage.getItem(LS_PREFS) || '{}') || {}; } catch (e) { return {}; } })());
    const savePrefs = () => lsSet(LS_PREFS, JSON.stringify(prefs));

    // Chat sound off (a setting). A sound counts as the chat's when its file
    // name says so or when Torn's chat code is what plays it; other sounds
    // (casino etc.) are left alone. The last few sounds are listed in the
    // settings so the guess can be checked.
    const soundsSeen = [];
    (function hookSounds() {
        const MP = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
        if (!MP || !MP.play) return;
        const nativePlay = MP.play;
        MP.play = function () {
            try {
                const src = String(this.currentSrc || this.src || (this.querySelector && this.querySelector('source') && this.querySelector('source').src) || '');
                const stack = String(new Error().stack || '');
                const chat = /chat|tchat|message|notif|sendbird|centrifug/i.test(src) || /chat/i.test(stack);
                const blocked = chat && prefs.muteSound;
                soundsSeen.unshift({ file: src.replace(/^.*\//, '').slice(0, 60) || '(no file)', chat, blocked, at: Date.now() });
                soundsSeen.length = Math.min(soundsSeen.length, 5);
                if (blocked) return Promise.resolve();
            } catch (e) {}
            return nativePlay.apply(this, arguments);
        };
    })();

    // Failsafe. The panel depends on how Torn's chat is built. If that changes
    // (no chat bar, no data, windows that won't open), Torn's own chat is shown
    // again and the panel says why, so nobody is left without a chat. The state
    // is remembered for a few hours, so pages don't hide and unhide it each
    // time, and cleared as soon as the panel sees the chat working again.
    const LS_DEGRADED = 'twc_degraded';
    const DEGRADED_TTL_MS = 6 * 3600 * 1000;
    const health = { json: false, ws: false, openFails: 0,
        degraded: (() => { try { const d = JSON.parse(localStorage.getItem(LS_DEGRADED) || 'null');
            return d && d.v === VERSION && Date.now() - d.at < DEGRADED_TTL_MS ? d.reason : null; } catch (e) { return null; } })() };
    const DEGRADED_TEXT = {
        bar: "Torn's chat bar looks different from what this version knows.",
        data: "No chat data came from Torn's chat on this page.",
        windows: "Torn's chat windows could not be opened.",
    };
    const hidingTorn = () => !!prefs.hideTorn && !health.degraded;
    function degrade(reason) {
        if (health.degraded) return;
        health.degraded = reason;
        lsSet(LS_DEGRADED, JSON.stringify({ reason, at: Date.now(), v: VERSION }));
        console.warn('[Torn Chat Panel] showing Torn\'s own chat again:', DEGRADED_TEXT[reason] || reason);
        applyHideTorn();
        paintWarn();
    }
    function recovered() {
        if (!health.degraded) return;
        health.degraded = null;
        try { localStorage.removeItem(LS_DEGRADED); } catch (e) {}
        applyHideTorn();
        paintWarn();
    }

    // Hide Torn's chat from the very start of every page load (document-start),
    // before Torn draws it, so its windows don't flash up on page changes.
    if (hidingTorn()) {
        document.documentElement.classList.add('twc-hide-torn');
        injectBadgeStyles();
    }
    const isPinned = (key) => prefs.pinned.includes(key);
    const isMuted = (key) => prefs.muted.includes(key);
    const ROOM_ICONS = { faction: '🛡️', company: '🏢', global: '🌐', trade: '🔁' };
    const ROOM_COLORS = { faction: '#1f7a4d', company: '#5b6b7a', global: '#1f6fb2', trade: '#c46a1b' };

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
            if (!c || !c.key || /:(undefined|null)?$/.test(c.key)) return;
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

    const onlineMap = new Map();   // player ID -> "online" / "idle" / "offline", from Torn's own status lookups
    const statusClass = (st) => !st ? '' : /online/i.test(st) ? ' st-on' : /idle/i.test(st) ? ' st-idle' : ' st-off';
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
    let myName = lsGet(LS_ME + '_name') || '';
    function learnMe(uid, name) {
        if (uid && uid !== myId) { myId = uid; lsSet(LS_ME, String(uid)); }
        if (uid && uid === myId && name && name !== myName) { myName = name; lsSet(LS_ME + '_name', name); }
    }
    function addMessages(key, items, opts) {
        const b = box(key);
        let added = 0;
        (items || []).forEach((m) => {
            if (!m || !m.messageId || b.ids.has(m.messageId)) return;
            clean(m);
            // Our own pending bubble: replace it with the real one.
            const pi = b.list.findIndex((x) => (x.pending || x.sentOk) && x.content === m.content &&
                Math.abs((m.createdAt || 0) - x.createdAt) < 120000);
            if (pi >= 0) {
                b.list.splice(pi, 1);
                if (m.sender) learnMe(m.sender.userId, m.sender.name);
            }
            b.ids.add(m.messageId);
            b.list.push(m);
            countEmojis(key, m);
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
        health.json = true;
        if ((m = path.match(/^\/tchat\/(rooms|dm)\/([^/]+)\/read$/))) { readDone(m[1] === 'rooms' ? roomKey(m[2]) : dmKey(m[2])); return; }
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
                // Only a chat's first load jumps to the newest; a later reload of the
                // same messages must not pull the reader away from where they are.
                renderMessages(older, before === 0 || undefined);
            }
        } else if (path === '/tchat/unread' && data) {
            Object.entries(data.rooms || {}).forEach(([id, n]) => { conv(roomKey(id), { type: 'room', id }).unread = Number(n) || 0; });
            Object.entries(data.dm || {}).forEach(([id, n]) => { conv(dmKey(id), { type: 'dm', id }).unread = Number(n) || 0; });
        } else if (path === '/tchat/social/online' && data && typeof data === 'object') {
            Object.entries(data).forEach(([uid, st]) => {
                onlineMap.set(String(uid), String(st));
                const c = convs.get(dmKey(uid));
                if (c) c.online = String(st);
            });
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
    // Which chat a live message belongs to. Room events name the room; private
    // messages come without an id, so they go by sender, or for our own echo
    // by the bubble waiting for it.
    let lastSentKey = null;
    function keyForEvent(rawId, m) {
        const id = rawId == null ? '' : String(rawId);
        if (id && id !== 'undefined' && (convs.has(roomKey(id)) || ROOM_ICONS[id] || !/^\d+$/.test(id))) return roomKey(id);
        if (id && /^\d+$/.test(id)) return dmKey(id);
        const waiting = pendingKeyFor(m);
        if (waiting) return waiting;
        const sid = m.sender && m.sender.userId;
        if (sid && sid !== myId) return dmKey(sid);
        return lastSentKey && lastSentKey.startsWith('dm:') ? lastSentKey : null;
    }
    function pendingKeyFor(m) {
        for (const [key, b] of msgs) if (b.list.some((x) => x.pending && x.content === m.content)) return key;
        return null;
    }

    // Live events from the chat WebSocket (Centrifugo, JSON, one reply per line).
    function onSocketText(text) {
        health.ws = true;
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
                const m = clean(got.message);
                const key = keyForEvent(got.id, m);
                if (!key) return;
                const id = key.slice(key.indexOf(':') + 1);
                if (key.startsWith('dm:')) {
                    const c = conv(key, { type: 'dm', id });
                    if (m.sender && String(m.sender.userId) === id) { c.name = c.name || m.sender.name; c.avatar = c.avatar || m.sender.avatar; }
                    else if (m.sender) learnMe(m.sender.userId, m.sender.name);
                } else conv(key, { type: 'room', id });
                addMessages(key, [m]);
                const c = convs.get(key);
                if (key !== currentKey && !isMine(key, m)) c.unread = (c.unread || 0) + 1;
                if (key === currentKey && !isMine(key, m)) needRead(key);
                if (key === currentKey) renderMessages(false, isMine(key, m) || undefined);
                saveConvs();
                renderSoon();
            }
            const rs = acts.onReadStateUpdated;
            if (rs && rs.id != null && rs.snapshotUnreadCount != null) {
                const key = /room/i.test(rs.scope || '') ? roomKey(rs.id) : convs.has(dmKey(rs.id)) ? dmKey(rs.id) : roomKey(rs.id);
                const c = convs.get(key);
                if (c) { c.unread = Number(rs.snapshotUnreadCount) || 0; renderSoon(); }
                if (!Number(rs.snapshotUnreadCount)) readDone(key);
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
                    p.then((r) => {
                        if (/\/read$/.test(path)) { if (r.ok) onJson(path, {}); return null; }
                        return /json/.test(r.headers.get('content-type') || '') ? r.clone().json() : null;
                    }).then((d) => { if (d) onJson(path, d); }).catch(() => {});
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
                        // "read" answers are empty: report a successful one by its path.
                        if (/\/read$/.test(path)) { if (this.status >= 200 && this.status < 300) onJson(path, {}); return; }
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
                if (people && !document.getElementById('private-channel-list')) { people.click(); openedPeople = true; }
                card = await waitFor(() => document.getElementById('private_chat_card_' + c.id), 3000);
            }
            if (card) (card.querySelector('button, [role="button"]') || card).click();
        }
        const win = await waitFor(() => tornWindow(c), 4000);
        if (win) health.openFails = 0;
        else if (++health.openFails >= 2) degrade('windows');
        if (win) { openedWins.add(String(c.id)); applyHideTorn(); }
        return win;
    }
    // One request, only after a tap on a chat Torn hasn't loaded: the same
    // address Torn's chat uses. It goes through the fetch hook above, so the
    // answer is read like Torn's own.
    // ---- read state
    // A chat you open with unread messages (or that gets new ones while open)
    // waits to be marked read until you are at the bottom of it.
    const readState = new Map();          // key -> { pending, busy, lastSent }
    const readFails = { dm: 0, rooms: 0 };
    function needRead(key) { const r = readState.get(key) || {}; r.pending = true; readState.set(key, r); }
    function readDone(key) { const r = readState.get(key); if (r) r.pending = false; }
    function markReadIfSeen() {
        const c = convs.get(currentKey);
        const el = root && root.querySelector('.twc-msgs');
        if (!c || !el || document.hidden) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 120) return;
        markRead(c, false);
    }
    // force: the ✕ on the unread pill (read everything without scrolling through it).
    async function markRead(c, force) {
        const r = readState.get(c.key);
        if (!r || !r.pending || r.busy) return;
        if (!force && Date.now() - (r.lastSent || 0) < 10000) return;
        r.busy = true;
        try {
            // First let Torn do it: its window at the bottom is what Torn itself reacts to.
            // (Right after opening a chat, Torn's window may still be on its way.)
            const win = tornWindow(c) || await waitFor(() => tornWindow(c), 3000);
            if (win) win.querySelectorAll('*').forEach((x) => {
                if (x.scrollHeight > x.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(x).overflowY)) {
                    x.scrollTop = x.scrollHeight;
                    x.dispatchEvent(new Event('scroll'));
                }
            });
            await waitFor(() => !r.pending, 1500);
            // Then Torn's own "N new messages ✕" pill: its ✕ clears the unread state.
            if (r.pending && win) {
                const pill = Array.from(win.querySelectorAll('div, span, button')).find((x) =>
                    /\bnew messages?/i.test(x.textContent || '') && x.textContent.length < 40 && x.querySelector('button, svg, [role="button"]'));
                const x = pill && Array.from(pill.querySelectorAll('button, [role="button"], svg')).pop();
                if (x) {
                    (x.closest('button, [role="button"]') || x).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    await waitFor(() => !r.pending, 1500);
                }
            }
            const type = c.type === 'dm' ? 'dm' : 'rooms';
            if (r.pending && readFails[type] < 2) {
                r.lastSent = Date.now();
                const resp = await window.fetch(`/tchat/${type}/${encodeURIComponent(c.id)}/read`,
                    { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } });
                if (resp.ok) r.pending = false; else readFails[type]++;
            }
        } catch (e) { /* try again on the next visit to the bottom */ }
        r.busy = false;
    }

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

    // ------------------------------------------------------------ emojis
    // Torn's chat uses ordinary Unicode emojis (no custom set, no picker of
    // its own). "Chats" shows the ones people actually use in your chats,
    // counted from the messages Torn loads; each message is counted once.
    const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?[\u{1F3FB}-\u{1F3FF}]?(?:\u200D\p{Extended_Pictographic}\uFE0F?[\u{1F3FB}-\u{1F3FF}]?)*|[\u{1F1E6}-\u{1F1FF}]{2}/gu;
    const loadJson = (k, d) => { try { return JSON.parse(lsGet(k) || 'null') || d; } catch (e) { return d; } };
    const emojiSeen = loadJson(LS_EMOJI_SEEN, {});
    const emojiUpto = loadJson(LS_EMOJI_UPTO, {});
    let emojiRecent = loadJson(LS_EMOJI_RECENT, []);
    let emojiSaveTimer = null;
    function countEmojis(key, m) {
        if (!m || m.pending || !m.createdAt || m.createdAt <= (emojiUpto[key] || 0)) return;
        const found = String(m.content || '').match(EMOJI_RE);
        if (found) found.forEach((e) => { emojiSeen[e] = (emojiSeen[e] || 0) + 1; });
        emojiUpto[key] = Math.max(emojiUpto[key] || 0, m.createdAt);
        clearTimeout(emojiSaveTimer);
        emojiSaveTimer = setTimeout(() => {
            const keep = Object.entries(emojiSeen).sort((a, b) => b[1] - a[1]).slice(0, 200);
            Object.keys(emojiSeen).forEach((k) => delete emojiSeen[k]);
            keep.forEach(([k, v]) => { emojiSeen[k] = v; });
            lsSet(LS_EMOJI_SEEN, JSON.stringify(emojiSeen));
            lsSet(LS_EMOJI_UPTO, JSON.stringify(emojiUpto));
        }, 2000);
    }
    const sp = (s) => s.split(' ');
    const EMOJI_SETS = [
        { id: 'recent', icon: '🕘', title: 'Recent', list: () => emojiRecent },
        { id: 'chats', icon: '💬', title: 'Most used in your chats',
            list: () => Object.entries(emojiSeen).sort((a, b) => b[1] - a[1]).slice(0, 48).map(([e]) => e) },
        { id: 'torn', icon: '🏙️', title: 'Torn', list: () => sp('💰 💵 💸 🤑 💎 🏦 📈 📉 🌸 🌺 🌷 🌹 🧸 🐼 📦 🛍️ ✈️ 🏝️ 🧳 💊 💉 🍺 🍬 🍫 🥤 🔫 🗡️ ⚔️ 🛡️ 💣 🎯 👊 💪 🔥 ⚡ ✨ 💀 ☠️ 🏴‍☠️ 🏥 🚔 ⛓️ 🎰 🎲 🃏 🏆 🥇 🤝 🫡 👀 💤 ⏰ 🕵️') },
        { id: 'smileys', icon: '😀', title: 'Smileys', list: () => sp('😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😴 🤤 😪 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 🤡 👻 👽 🤖 💩') },
        { id: 'hands', icon: '👍', title: 'People & hands', list: () => sp('👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 👋 👏 🙌 👐 🤲 🙏 🤝 💪 🫶 ✍️ 💅 🤳 👀 🧠 🫂 🤷 🤦 🙋 🙅 🙆 💁 🙇 🕺 💃 🏃 🚶') },
        { id: 'hearts', icon: '❤️', title: 'Hearts & symbols', list: () => sp('❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ✅ ❌ ❗ ❓ ‼️ ⁉️ 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 🗯️ ⭐ 🌟 ⚠️ 🚫 ⛔ 🔞 🆗 🆒 🆕 🆘 ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔝 🔴 🟢 🔵 🟡 ⚫ ⚪') },
        { id: 'nature', icon: '🐶', title: 'Animals & nature', list: () => sp('🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦎 🐙 🦑 🦀 🐠 🐬 🐳 🦈 🐊 🐘 🦒 🐪 🌵 🌲 🌴 🍀 🍁 🌻 🌼 💐 🌈 ☀️ 🌙 ⭐ ☁️ ⛈️ ❄️ 🌊') },
        { id: 'food', icon: '🍔', title: 'Food & things', list: () => sp('🍏 🍎 🍌 🍉 🍇 🍓 🍒 🍑 🍍 🥑 🌶️ 🍞 🧀 🥓 🍔 🍟 🍕 🌭 🌮 🍣 🍜 🍰 🎂 🧁 🍩 🍪 🍿 ☕ 🍵 🍷 🍸 🍹 🥃 🍻 🥂 🍾 🎉 🎊 🎁 🎈 🎮 🎧 🎵 📱 💻 📷 🔑 🔒 💡 📌 📎 ✂️ 🚗 🏍️ 🚀 🏠 🏰 🗽 🌍 🇬🇧 🇺🇸 🇹🇷') },
    ];
    let emojiTab = null;
    function emojiPicker(conv, ta) {
        const pick = conv.querySelector('.twc-emoji');
        const tabs = pick.querySelector('.twc-etabs');
        const grid = pick.querySelector('.twc-egrid');
        const paint = () => {
            const set = EMOJI_SETS.find((x) => x.id === emojiTab) || EMOJI_SETS[0];
            tabs.innerHTML = EMOJI_SETS.map((x) => `<button type="button" data-tab="${x.id}" title="${x.title}" class="${x.id === set.id ? 'on' : ''}">${x.icon}</button>`).join('');
            const list = set.list();
            grid.innerHTML = list.length ? list.map((e) => `<button type="button" data-e="${esc(e)}">${e}</button>`).join('')
                : `<div class="twc-enote">${set.id === 'recent' ? 'Emojis you pick show up here.' : 'Emojis from your chats show up here as messages come in.'}</div>`;
        };
        tabs.addEventListener('click', (e) => {
            const b = e.target.closest('[data-tab]');
            if (b) { emojiTab = b.getAttribute('data-tab'); paint(); }
        });
        grid.addEventListener('click', (e) => {
            const b = e.target.closest('[data-e]');
            if (!b) return;
            const em = b.getAttribute('data-e');
            const at = ta.selectionStart != null && document.activeElement === ta ? ta.selectionStart : ta.value.length;
            const end = ta.selectionEnd != null && document.activeElement === ta ? ta.selectionEnd : at;
            ta.value = ta.value.slice(0, at) + em + ta.value.slice(end);
            // Keep the phone keyboard closed while picking; on desktop keep typing.
            if (!('ontouchstart' in window)) { ta.focus(); ta.selectionStart = ta.selectionEnd = at + em.length; }
            ta.dispatchEvent(new Event('input'));
            emojiRecent = [em].concat(emojiRecent.filter((x) => x !== em)).slice(0, 32);
            lsSet(LS_EMOJI_RECENT, JSON.stringify(emojiRecent));
        });
        conv.querySelector('.twc-ebtn').addEventListener('click', () => {
            const show = pick.hidden;
            pick.hidden = !show;
            if (show) {
                if (!emojiTab) emojiTab = emojiRecent.length ? 'recent' : Object.keys(emojiSeen).length ? 'chats' : 'torn';
                paint();
            }
        });
    }
    // Characters as Torn counts them (rooms with graphemeCount count an emoji as one).
    function lengthFor(c, text) {
        if (c.rules && c.rules.graphemeCount && typeof Intl !== 'undefined' && Intl.Segmenter) {
            let n = 0;
            for (const _ of new Intl.Segmenter().segment(text)) n++;   // eslint-disable-line no-unused-vars
            return n;
        }
        return text.length;
    }

    // ------------------------------------------------------------ FF/BS chips
    // FF/BS Badges keeps FFScouter estimates in localStorage
    // (pid -> [ff, bsRaw, bsHuman, ts]). We only read that cache: players it
    // hasn't looked up show nothing, and no request is made.
    let ffbsCache = null, ffbsReadAt = 0;
    function ffbsFor(uid) {
        if (!prefs.ffbs || !uid) return null;
        if (!ffbsCache || Date.now() - ffbsReadAt > 60000) {
            ffbsReadAt = Date.now();
            try { ffbsCache = JSON.parse(localStorage.getItem('ffbs_stats_cache') || 'null') || {}; } catch (e) { ffbsCache = {}; }
        }
        const e = ffbsCache[uid];
        return Array.isArray(e) && (e[0] != null || e[2]) ? { ff: e[0], bs: e[2] } : null;
    }
    function ffbsChip(uid) {
        const v = ffbsFor(uid);
        if (!v) return '';
        const ff = Number(v.ff);
        const tier = isNaN(ff) ? 'g' : ff < 1.5 ? 'ok' : ff < 2.25 ? 'y' : ff < 3 ? 'o' : 'r';
        return `<span class="twc-ff ${tier}" title="FairFight / estimated battle stats (FF/BS Badges)">${isNaN(ff) ? '' : 'FF ' + ff.toFixed(2)}${v.bs ? (isNaN(ff) ? '' : ' · ') + esc(v.bs) : ''}</span>`;
    }

    // ------------------------------------------------------------ formatting
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // ---- image previews
    // A link ending in .jpg/.jpeg/.png/.gif/.webp (query string allowed) is shown
    // as the image itself. Loading an image tells its host your IP address, so by
    // default only well-known image hosts are previewed (a setting: off / trusted
    // / all). Images that fail to load turn back into plain links for good.
    const IMG_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;
    const TRUSTED_IMG_HOSTS = /(^|\.)(imgur\.com|ibb\.co|discordapp\.(com|net)|discord\.com|tenor\.com|giphy\.com|redd\.it|twimg\.com|torn\.com|postimg\.cc|gyazo\.com|imgbox\.com)$/i;
    const brokenImgs = new Set();
    function previewable(url) {
        if (prefs.images === 'off' || brokenImgs.has(url)) return false;
        let u;
        try { u = new URL(url); } catch (e) { return false; }
        if (u.protocol !== 'https:' || !IMG_EXT_RE.test(u.pathname)) return false;
        return prefs.images === 'all' || TRUSTED_IMG_HOSTS.test(u.hostname);
    }
    function linkHtml(u) {
        // u is already HTML-escaped; the real URL is needed for the checks.
        const raw = decode(u);
        if (previewable(raw)) {
            return `<a class="twc-imglink" href="${u}" target="_blank" rel="noopener noreferrer" data-url="${u}">` +
                `<img class="twc-img" src="${u}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="Image"></a>`;
        }
        return `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, '').replace(/^(.{42}).+$/, '$1…')}</a>`;
    }
    // Rendered message text, by content: the whole list is redrawn on every new
    // message, so each text is only worked through once.
    const linkifyCache = new Map();
    function linkify(s) {
        const key = prefs.images + '|' + s;
        const hit = linkifyCache.get(key);
        if (hit !== undefined) return hit;
        const html = esc(s)
            .replace(/\bhttps?:\/\/[^\s<]+/g, linkHtml)
            .replace(/(^|[\s(])@([A-Za-z0-9_-]{2,20})/g, (a, pre, n) => `${pre}<b class="twc-at">@${n}</b>`)
            .replace(/\n/g, '<br>');
        if (linkifyCache.size > 3000) linkifyCache.clear();
        linkifyCache.set(key, html);
        return html;
    }
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
    // Telegram-like palette; the player ID is hashed so neighbouring IDs still get different colours.
    const NAME_COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#4bc7cf', '#d4a5f5', '#9ccc65', '#ff8a65'];
    const nameColor = (uid) => {
        let h = (Number(uid) || 0) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
        return NAME_COLORS[(h ^ (h >>> 16)) % NAME_COLORS.length];
    };
    function avatarHtml(c) {
        if (c.type === 'room') {
            // Situational rooms (Travelling, Hospital, Jail…) have ids we don't know ahead, so go by name too.
            const n = String(c.name || c.id);
            const guess = /travel|abroad|flight/i.test(n) ? ['✈️', '#2a7fa8'] : /hosp/i.test(n) ? ['🏥', '#a8323a'] : /jail/i.test(n) ? ['⛓️', '#6b5a3a'] : null;
            const icon = ROOM_ICONS[c.id] || (guess && guess[0]) || '💬';
            const bg = ROOM_COLORS[c.id] || (guess && guess[1]) || '#54656f';
            return `<span class="twc-av twc-room" style="background:${bg} !important">${icon}</span>`;
        }
        const dot = c.online && /online/i.test(c.online) ? '<i class="twc-dot on"></i>' : c.online && /idle/i.test(c.online) ? '<i class="twc-dot idle"></i>' : '';
        return `<span class="twc-av${statusClass(c.online || onlineMap.get(String(c.id)))}">${c.avatar ? `<img src="${esc(c.avatar)}" alt="" loading="lazy">` : esc((c.name || '?').slice(0, 1))}${dot}</span>`;
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
            --mine: #005c4b; --theirs: #202c33; --accent: #00a884; --badge: #00a884; --input: #2a3942; --link: #53bdeb; --dots: rgba(255,255,255,.035);
            --headbar: rgba(18,24,28,.95); --press: rgba(255,255,255,.04); --ring: rgba(255,255,255,.14); --ring-off: rgba(255,255,255,.1);
            --text: #e9edef; --meta: #8696a0; }
        body:not(.dark-mode) #twc-root { --bg: #efeae2; --panel: #fff; --head: #f0f2f5; --fg: #111b21; --muted: #667781; --line: #e9edef;
            --mine: #d9fdd3; --theirs: #fff; --accent: #008069; --badge: #25d366; --input: #fff; --link: #027eb5; --dots: rgba(0,0,0,.05);
            --headbar: rgba(240,242,245,.95); --press: rgba(0,0,0,.04); --ring: rgba(0,0,0,.12); --ring-off: rgba(0,0,0,.08);
            --text: #111b21; --meta: #667781; }
        #twc-root { position: fixed; inset: 0; z-index: 2147483647; isolation: isolate; display: flex; background: var(--bg); color: var(--fg);
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
        #twc-root .twc-head { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 12px; flex: none;
            background: var(--headbar); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
            border-bottom: 1px solid rgba(255,255,255,.04); position: relative; z-index: 3; }
        #twc-root .twc-head h1 { flex: 1; margin: 0; font-size: 19px; font-weight: 600; }
        #twc-root .twc-ib { background: none; border: 0; padding: 6px; cursor: pointer; font-size: 20px; line-height: 1; color: var(--muted); }
        #twc-root .twc-ib:hover { color: var(--fg); }
        #twc-root .twc-search { padding: 6px 12px 8px; background: var(--panel); flex: none; }
        #twc-root .twc-sbox { position: relative; display: block; }
        #twc-root .twc-sbox svg { position: absolute; left: 12px; top: 50%; width: 17px; height: 17px; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
        #twc-root .twc-search input { width: 100%; padding: 8px 12px 8px 38px; border-radius: 8px; border: 0; background: var(--head); color: var(--fg); font-size: 14px;
            outline: none; box-shadow: 0 0 0 1px transparent; transition: box-shadow .15s; }
        #twc-root .twc-search input:focus { box-shadow: 0 0 0 1px var(--accent); }
        #twc-root .twc-sbox:focus-within svg { color: var(--accent); }
        #twc-root .twc-items { flex: 1; overflow-y: auto; }
        #twc-root .twc-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; cursor: pointer;
            transition: background-color .12s; -webkit-tap-highlight-color: transparent; }
        #twc-root .twc-item:hover, #twc-root .twc-item:active { background: var(--press); }
        #twc-root .twc-item.sel { background: var(--head); }
        #twc-root .twc-item .twc-mid { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
            border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: -10px; }
        #twc-root .twc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        /* Right column: time on top, status icons + unread badge under it. */
        #twc-root .twc-side { flex: none; min-width: 60px; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        #twc-root .twc-flags { display: flex; gap: 4px; align-items: center; justify-content: flex-end; min-height: 20px; }
        #twc-root .twc-name { min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #twc-root .twc-time { font-size: 0.75rem; line-height: 16px; color: var(--muted); white-space: nowrap; }
        #twc-root .twc-item.unread .twc-time { color: var(--badge); }
        #twc-root .twc-prev { min-width: 0; font-size: 13.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #twc-root .twc-badge { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--badge); color: #fff !important;
            font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
        #twc-root .twc-av { position: relative; flex: none; width: 46px; height: 46px; border-radius: 50%; background: var(--head);
            display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 600; color: var(--muted); }
        #twc-root .twc-av img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
        /* A thin ring keeps avatars apart from the background; green / grey when the
           player's status is known (Torn's chat looks it up for the people you see). */
        #twc-root .twc-av img, #twc-root .twc-sav img, #twc-root .twc-av.twc-room {
            box-sizing: border-box; border: 1.5px solid var(--ring); }
        #twc-root .twc-av:not(.twc-room):not(:has(img)), #twc-root .twc-sav:not(:has(img)) { box-sizing: border-box; border: 1.5px solid var(--ring); }
        #twc-root .st-on img, #twc-root .twc-av.st-on:not(:has(img)), #twc-root .twc-sav.st-on:not(:has(img)) { border-color: #22c55e; }
        #twc-root .st-idle img, #twc-root .twc-av.st-idle:not(:has(img)), #twc-root .twc-sav.st-idle:not(:has(img)) { border-color: rgba(240,178,50,.75); }
        #twc-root .st-off img, #twc-root .twc-av.st-off:not(:has(img)), #twc-root .twc-sav.st-off:not(:has(img)) { border-color: var(--ring-off); }
        #twc-root .twc-item .twc-av { margin: 2px 2px 2px 0; }
        #twc-root .twc-head .twc-av { width: 40px; height: 40px; font-size: 20px; margin-right: 2px; }
        #twc-root .twc-dot { position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--panel); }
        #twc-root .twc-dot.on { background: #25d366; }
        #twc-root .twc-dot.idle { background: #f0b232; }
        #twc-root .twc-empty { padding: 30px 20px; text-align: center; color: var(--muted); font-size: 14px; }
        #twc-root .twc-ctitle { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; line-height: 1.25; }
        #twc-root .twc-ctitle b { display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #twc-root .twc-ctitle small { display: flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--muted); }
        #twc-root .twc-head > * { align-self: center; }
        #twc-root .twc-head .twc-ib { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 0;
            border-radius: 50%; flex: none; }
        #twc-root .twc-head .twc-ib:active { background: rgba(255,255,255,.08); }
        #twc-root .twc-head .twc-back { color: var(--fg) !important; font-size: 24px; margin-right: -2px; }
        #twc-root .twc-ctitle a { color: inherit; text-decoration: none; }
        #twc-root .twc-msgwrap { position: relative; flex: 1; min-height: 0; display: flex; }
        #twc-root .twc-msgs { flex: 1; overflow-y: auto; overflow-anchor: auto; padding: 8px 4% 10px; display: flex; flex-direction: column; gap: 2px;
            background-color: var(--bg); background-image: radial-gradient(var(--dots) 1px, transparent 1.2px), radial-gradient(var(--dots) 1px, transparent 1.2px);
            background-size: 26px 26px; background-position: 0 0, 13px 13px; overscroll-behavior: contain; }
        #twc-root .twc-day { align-self: center; margin: 12px auto; }
        #twc-root .twc-day span { display: inline-block; padding: 3px 10px; border-radius: 999px; background: rgba(11,20,26,.62); font-size: 0.75rem;
            line-height: 1.4; color: #e9edef !important; -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
            box-shadow: 0 1px .5px rgba(0,0,0,.13); }
        #twc-root .twc-unread { align-self: stretch; display: flex; align-items: center; gap: 10px; margin: 14px -4% 6px; padding: 0 4%; }
        #twc-root .twc-unread::before, #twc-root .twc-unread::after { content: ''; flex: 1; height: 1px; background: rgba(229,83,75,.55); }
        #twc-root .twc-unread span { padding: 3px 10px; border-radius: 999px; background: rgba(229,83,75,.16); color: #ff8a80 !important;
            font-size: 0.72rem; font-weight: 600; white-space: nowrap; }
        #twc-root .twc-jump { position: absolute; right: 14px; bottom: 64px; height: 34px; display: flex; align-items: stretch; border-radius: 17px; overflow: hidden;
            background: rgba(32,44,51,.92); box-shadow: 0 2px 8px rgba(0,0,0,.35);
            -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); opacity: 0; transform: translateY(6px); transition: opacity .22s, transform .22s; }
        #twc-root .twc-jump button { border: 0; background: none; cursor: pointer; color: #e9edef !important; font-size: 13px; font-weight: 600; line-height: 34px; }
        #twc-root .twc-jumpgo { padding: 0 14px; }
        #twc-root .twc-jump.on { opacity: 1; transform: none; }
        #twc-root .twc-jump span { display: inline-block; min-width: 18px; margin-left: 4px; padding: 0 6px; border-radius: 9px; background: var(--badge);
            color: #fff !important; font-size: 11px; line-height: 18px; vertical-align: 1px; }
        #twc-root .twc-down { position: absolute; right: 14px; bottom: 12px; width: 42px; height: 42px; border-radius: 50%; border: 0; cursor: pointer;
            background: var(--head); color: var(--muted) !important; font-size: 22px; line-height: 30px; box-shadow: 0 2px 6px rgba(0,0,0,.3); }
        #twc-root .twc-down b { position: absolute; top: -6px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
            background: var(--badge); color: #fff !important; font-size: 11px; line-height: 20px; }
        #twc-root .twc-older { align-self: center; margin: 6px 0; font-size: 12.5px; color: var(--muted); }
        /* Grouped bubbles: 2px apart inside a group, 10px between groups. The side
           facing the sender is 6px-cornered where bubbles join; only the first has
           a tail, only the last gets a fully round bottom corner. */
        #twc-root .twc-b { position: relative; max-width: min(78%, 560px); padding: 8px 14px; background: var(--theirs);
            align-self: flex-start; box-shadow: 0 1px .5px rgba(0,0,0,.13); overflow-wrap: anywhere; margin-top: 2px;
            border-radius: 6px 12px 12px 6px; }
        #twc-root .twc-b.first { margin-top: 10px; border-top-left-radius: 0; }
        #twc-root .twc-b.last { border-bottom-left-radius: 12px; }
        /* Tail on the first bubble of a group, like WhatsApp. */
        #twc-root .twc-b.first::before { content: ''; position: absolute; top: 0; left: -8px; width: 0; height: 0; border-style: solid;
            border-width: 0 8px 10px 0; border-color: transparent var(--theirs) transparent transparent; }
        #twc-root .twc-b.mine { align-self: flex-end; background: var(--mine); border-radius: 12px 6px 6px 12px; }
        #twc-root .twc-b.mine.first { border-top-right-radius: 0; }
        #twc-root .twc-b.mine.last { border-bottom-right-radius: 12px; }
        #twc-root .twc-b.mine.first::before { left: auto; right: -8px; border-width: 0 0 10px 8px; border-color: transparent transparent transparent var(--mine); }
        #twc-root .twc-b.indent { margin-left: 42px; }
        #twc-root .twc-sav { position: absolute; left: -46px; top: 0; width: 32px; height: 32px; border-radius: 50%; overflow: hidden; background: var(--head);
            display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; color: var(--muted) !important; text-decoration: none; }
        #twc-root .twc-sav img { width: 100%; height: 100%; object-fit: cover; }
        #twc-root .twc-b .twc-from { display: block; font-size: 13px; font-weight: 600; margin-bottom: 1px; text-decoration: none; }
        /* Emoji-only messages stay in their bubble, just larger. */
        #twc-root .twc-b.jumbo { padding: 6px 12px 8px; }
        #twc-root .twc-b.jumbo .twc-txt { font-size: 32px; line-height: 1.2; }
        #twc-root .twc-b.jumbo .twc-meta { top: 14px; }
        #twc-root .twc-b.mention { box-shadow: inset 3px 0 0 var(--accent), 0 1px .5px rgba(0,0,0,.13); }
        #twc-root .twc-at { color: var(--link) !important; font-weight: 600; }
        #twc-root .twc-imglink { display: block; width: fit-content; }
        #twc-root .twc-img { display: block; max-width: 250px; max-height: 200px; width: auto; height: auto; min-width: 60px; min-height: 40px;
            border-radius: 8px; object-fit: cover; cursor: pointer; margin-top: 4px; background: rgba(134,150,160,.12); }
        @media (max-width: 360px) { #twc-root .twc-img { max-width: 100%; } }
        #twc-root .twc-tick { font-style: normal; margin-left: 3px; color: var(--link) !important; }
        #twc-root .twc-tick.bad { color: #e5534b !important; font-weight: 700; }
        #twc-root .twc-b .twc-txt { font-size: 14.5px; color: var(--text) !important; }
        #twc-root .twc-b .twc-txt a { color: var(--link) !important; }
        /* Time floats to the bottom-right with at least 16px between it and the text. */
        #twc-root .twc-b .twc-meta { float: right; position: relative; top: 5px; margin: 0 -4px 0 16px; font-size: 11px; line-height: 15px;
            color: var(--meta) !important; white-space: nowrap; }
        #twc-root .twc-b .twc-txt { line-height: 1.4; }

        #twc-root .twc-b.failed { outline: 1px solid #e5534b; }
        #twc-root .twc-compose { display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px; background: var(--head); flex: none; }
        #twc-root .twc-compose textarea { flex: 1; resize: none; max-height: 120px; min-height: 40px; padding: 10px 12px; border-radius: 20px; border: 0;
            background: var(--input); color: var(--fg); font: inherit; outline: none; }
        #twc-root .twc-send { flex: none; width: 42px; height: 42px; border-radius: 50%; border: 0; background: var(--accent); color: #fff !important;
            font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        #twc-root .twc-send { transition: opacity .15s, transform .1s; }
        #twc-root .twc-send:disabled, #twc-root .twc-send.idle { opacity: .5; pointer-events: none; }
        #twc-root .twc-send:active { transform: scale(.94); }
        #twc-root .twc-count { font-size: 11px; color: var(--muted); align-self: center; }
        #twc-root .twc-count.over { color: #e5534b; font-weight: 700; }
        #twc-root .twc-ebtn { align-self: center; font-size: 22px; padding: 4px; filter: grayscale(.2); }
        #twc-root .twc-emoji { flex: none; background: var(--panel); border-top: 1px solid var(--line); }
        #twc-root .twc-etabs { display: flex; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--line); overflow-x: auto; }
        #twc-root .twc-etabs button { flex: none; background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 8px; font-size: 18px; cursor: pointer; opacity: .6; }
        #twc-root .twc-etabs button.on { opacity: 1; border-bottom-color: var(--accent); }
        #twc-root .twc-egrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); max-height: 190px; overflow-y: auto; padding: 4px 6px; }
        #twc-root .twc-egrid button { background: none; border: 0; border-radius: 6px; padding: 5px 0; font-size: 24px; line-height: 1.2; cursor: pointer; }
        #twc-root .twc-egrid button:hover { background: var(--head); }
        #twc-root .twc-enote { grid-column: 1 / -1; padding: 14px; text-align: center; font-size: 13px; color: var(--muted); }
        #twc-root .twc-err { padding: 6px 12px; font-size: 12.5px; color: #e5534b; background: var(--head); }
        #twc-root .twc-pick { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted); text-align: center; padding: 20px; }
        #twc-root .twc-warn { padding: 9px 14px; font-size: 12.5px; line-height: 1.45; background: rgba(240,178,50,.14); color: var(--fg) !important;
            border-bottom: 1px solid rgba(240,178,50,.35); flex: none; }
        #twc-root .twc-warn a { color: var(--link) !important; }
        #twc-root .twc-about { margin: 10px 18px 0; font-size: 11.5px; color: var(--muted) !important; }
        #twc-root .twc-about a { color: var(--muted) !important; }
        #twc-root.sz-s { font-size: 13.5px; } #twc-root.sz-s .twc-b .twc-txt { font-size: 13px; }
        #twc-root.sz-l { font-size: 17px; } #twc-root.sz-l .twc-b .twc-txt { font-size: 17px; } #twc-root.sz-l .twc-prev { font-size: 15px; }
        #twc-root.nowall .twc-msgs { background-image: none; }
        #twc-root .twc-ico { font-style: normal; font-size: 13px; opacity: .8; }
        #twc-root .twc-item.muted .twc-badge { background: var(--muted); }
        #twc-root .twc-fromrow { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
        #twc-root .twc-ff { display: inline-block; padding: 0 5px; border-radius: 4px; font-size: 10.5px; font-weight: 700; line-height: 16px;
            background: rgba(134,150,160,.18); color: var(--muted) !important; white-space: nowrap; }
        #twc-root .twc-ff.ok { background: rgba(46,204,64,.18); color: #3ccf6a !important; }
        #twc-root .twc-ff.y { background: rgba(240,178,50,.18); color: #e0a526 !important; }
        #twc-root .twc-ff.o { background: rgba(255,140,0,.18); color: #ff8c1a !important; }
        #twc-root .twc-ff.r { background: rgba(229,83,75,.18); color: #e5534b !important; }
        #twc-root .twc-ctitle small .twc-ff { margin-left: 2px; vertical-align: 1px; }
        #twc-root .twc-sheet { position: absolute; inset: 0; z-index: 5; background: rgba(0,0,0,.45); display: flex; align-items: flex-end; justify-content: center; }
        #twc-root .twc-sheet-box { width: 100%; max-width: 480px; max-height: 80%; overflow-y: auto; background: var(--panel); border-radius: 14px 14px 0 0;
            padding: 8px 0 calc(10px + env(safe-area-inset-bottom)); box-shadow: 0 -4px 20px rgba(0,0,0,.35); animation: twc-up .16s ease-out; }
        @media (min-width: 760px) { #twc-root .twc-sheet { align-items: center; } #twc-root .twc-sheet-box { border-radius: 14px; } }
        @keyframes twc-up { from { transform: translateY(30px); opacity: .5; } }
        #twc-root .twc-sheet-title { padding: 8px 18px 10px; font-weight: 600; color: var(--muted); font-size: 13px; }
        #twc-root .twc-sheet-box > button { display: flex; align-items: center; gap: 14px; width: 100%; padding: 13px 18px; background: none; border: 0;
            color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
        #twc-root .twc-sheet-box > button:hover { background: var(--head); }
        #twc-root .twc-sheet-box > button i { font-style: normal; width: 22px; text-align: center; }
        #twc-root .twc-set { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 18px; cursor: pointer; }
        #twc-root .twc-set small { display: block; font-size: 11.5px; color: var(--muted); }
        #twc-root .twc-set select { background: var(--head); color: var(--fg); border: 0; border-radius: 6px; padding: 5px 8px; font: inherit; }
        #twc-root .twc-set input[type="checkbox"] { width: 20px; height: 20px; accent-color: var(--accent); }
        #twc-root .twc-sounds { margin: 0 18px 6px; font-size: 11.5px; color: var(--muted); }
        #twc-root .twc-sounds span { display: block; color: var(--muted); }
        #twc-root .twc-support { margin: 8px 18px 4px; padding: 10px 12px; border-radius: 10px; background: var(--head); font-size: 13px; line-height: 1.45; }
        #twc-root .twc-support a { color: var(--link) !important; font-weight: 600; }
        #twc-root .twc-done { display: block; margin: 10px 18px 2px auto; padding: 8px 18px; border: 0; border-radius: 18px; background: var(--accent); color: #fff !important; font: inherit; font-weight: 600; cursor: pointer; }
        #twc-root .twc-toast { position: absolute; left: 50%; bottom: 90px; transform: translateX(-50%); z-index: 6; padding: 8px 14px; border-radius: 18px;
            background: rgba(0,0,0,.8); color: #fff !important; font-size: 13px; }
        /* Phones: long-press opens our menu (Copy is in it), so no text selection fighting it. */
        @media (pointer: coarse) { #twc-root .twc-b, #twc-root .twc-item { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; } }
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
        root.classList.add('sz-' + prefs.size);
        root.classList.toggle('nowall', !prefs.wallpaper);
        root.innerHTML = `
            <section class="twc-list">
                <div class="twc-warn" hidden></div>
                <div class="twc-head"><h1>Chats</h1><button class="twc-ib" data-a="settings" title="Settings">⚙</button><button class="twc-ib" data-a="close" title="Close">✕</button></div>
                <div class="twc-search"><label class="twc-sbox"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><input type="search" placeholder="Search" autocomplete="off"></label></div>
                <div class="twc-items"></div>
            </section>
            <section class="twc-conv"><div class="twc-pick"><div style="font-size:40px">💬</div>Pick a chat</div></section>`;
        document.body.appendChild(root);
        paintWarn();
        root.querySelector('[data-a="close"]').addEventListener('click', requestClose);
        root.querySelector('[data-a="settings"]').addEventListener('click', openSettings);
        // Long-press (or right-click) a chat: pin / mute.
        onLongPress(root.querySelector('.twc-items'), '[data-key]', (it) => chatSheet(it.getAttribute('data-key')));
        history.pushState({ twc: 1 }, '');
        navDepth = 1;
        window.addEventListener('popstate', onPop);
        fitViewport();
        if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
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
            if (people && !document.getElementById('private-channel-list')) { people.click(); openedPeople = true; }
        }
    }
    function closePanel() {
        if (!root) return;
        closeOpenedWindows();
        root.remove();
        root = null;
        currentKey = null;
        navDepth = 0;
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('popstate', onPop);
        if (window.visualViewport) window.visualViewport.removeEventListener('resize', fitViewport);
    }
    // The phone's back button: conversation -> list -> close. Each level is a
    // history entry of our own, so Back never leaves the Torn page by surprise.
    let navDepth = 0;
    const narrow = () => window.innerWidth < 760;
    function onPop(e) {
        const depth = (e.state && e.state.twc) || 0;
        if (depth < 2 && currentKey && narrow()) backToList(true);
        if (depth < 1) closePanel();
        else navDepth = depth;
    }
    function requestClose() { if (navDepth > 0) history.go(-navDepth); else closePanel(); }
    function requestBack() { if (navDepth >= 2) history.back(); else backToList(); }
    function onKey(e) {
        if (e.key !== 'Escape' || !root) return;
        const sheet = root.querySelector('.twc-sheet');
        if (sheet) { sheet.remove(); return; }
        if (currentKey && narrow()) requestBack(); else requestClose();
    }
    // Keep the compose bar above the on-screen keyboard.
    function fitViewport() {
        if (!root || !window.visualViewport) return;
        const v = window.visualViewport;
        root.style.top = v.offsetTop + 'px';
        root.style.height = v.height + 'px';
        root.style.bottom = 'auto';
    }

    // ------------------------------------------------------------ Torn's chat, hidden
    // Everything in #chatRoot except the bar of buttons (Torn's chat windows,
    // the people list, chat settings) is made invisible and untouchable, not
    // removed: the panel still needs those windows to load and send.
    function applyHideTorn() {
        const hide = hidingTorn();
        document.documentElement.classList.toggle('twc-hide-torn', hide);
        const chat = chatRoot();
        if (!hide && chat) chat.querySelectorAll('[data-twc-hidden]').forEach((el) => el.removeAttribute('data-twc-hidden'));
        const anchor = document.getElementById('people_panel_button') || document.getElementById('twc-btn');
        if (!chat || !anchor || !chat.contains(anchor)) return;
        // Torn's chat Settings panel (opened by Torn's ⚙, which stays in the
        // bar) is left visible: only what is next to it is hidden.
        const mark = (el) => {
            const keep = el.id === 'settings_panel' || !!el.querySelector('#settings_panel');
            if (hide && !keep) { if (!el.hasAttribute('data-twc-hidden')) el.setAttribute('data-twc-hidden', ''); return; }
            if (el.hasAttribute('data-twc-hidden')) el.removeAttribute('data-twc-hidden');
            if (hide && el.id !== 'settings_panel') Array.from(el.children).forEach(mark);
        };
        for (let el = anchor.parentNode; el && el !== chat; el = el.parentNode) {
            Array.from(el.parentNode.children).forEach((sib) => { if (sib !== el) mark(sib); });
        }
    }
    // Torn windows the panel opened; closed again when the panel closes.
    const openedWins = new Set();
    let openedPeople = false;
    function closeOpenedWindows() {
        if (!prefs.closeTornWins) { openedWins.clear(); return; }
        openedWins.forEach((id) => {
            const win = document.getElementById(id);
            const x = win && chatRoot() && chatRoot().contains(win) && win.querySelector('[class*="closeIcon"]');
            if (x) x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        openedWins.clear();
        if (openedPeople) {
            openedPeople = false;
            const people = document.getElementById('private-channel-list');
            const btn = document.getElementById('people_panel_button');
            if (people && btn) btn.click();
        }
    }

    function paintWarn() {
        const el = root && root.querySelector('.twc-warn');
        if (!el) return;
        el.hidden = !health.degraded;
        if (health.degraded) el.innerHTML = `⚠️ ${esc(DEGRADED_TEXT[health.degraded] || 'Torn\'s chat changed.')} Torn's own chat is shown again,
            and this panel may miss messages. <a href="${REPO_URL}/issues" target="_blank" rel="noopener">Report it</a> or check for an update.`;
    }

    // ------------------------------------------------------------ sheets (menus)
    function onLongPress(container, sel, fn) {
        let timer = null, sx = 0, sy = 0, fired = false;
        container.addEventListener('touchstart', (e) => {
            const t = e.target.closest(sel);
            if (!t) return;
            fired = false;
            sx = e.touches[0].clientX; sy = e.touches[0].clientY;
            timer = setTimeout(() => { fired = true; timer = null; if (navigator.vibrate) navigator.vibrate(15); fn(t, e); }, 480);
        }, { passive: true });
        const cancel = () => { clearTimeout(timer); timer = null; };
        container.addEventListener('touchmove', (e) => {
            if (timer && (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10)) cancel();
        }, { passive: true });
        container.addEventListener('touchend', (e) => { cancel(); if (fired) { e.preventDefault(); fired = false; } });
        container.addEventListener('contextmenu', (e) => {
            const t = e.target.closest(sel);
            if (!t || e.target.closest('a')) return;
            e.preventDefault();
            fn(t, e);
        });
    }
    function sheet(title, actions) {
        if (!root) return;
        const old = root.querySelector('.twc-sheet');
        if (old) old.remove();
        const el = document.createElement('div');
        el.className = 'twc-sheet';
        el.innerHTML = `<div class="twc-sheet-box">${title ? `<div class="twc-sheet-title">${title}</div>` : ''}` +
            actions.map((a, i) => `<button type="button" data-i="${i}">${a.icon ? `<i>${a.icon}</i>` : ''}${esc(a.label)}</button>`).join('') + '</div>';
        root.appendChild(el);
        el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-i]');
            if (!b && e.target !== el) return;
            el.remove();
            if (b) actions[Number(b.getAttribute('data-i'))].run();
        });
    }
    function chatSheet(key) {
        const c = convs.get(key);
        if (!c) return;
        const toggle = (list, on) => { const i = prefs[list].indexOf(key); if (on && i < 0) prefs[list].push(key); if (!on && i >= 0) prefs[list].splice(i, 1); savePrefs(); renderList(); paintUnread(); };
        sheet(esc(titleOf(c)), [
            { icon: '📌', label: isPinned(key) ? 'Unpin' : 'Pin to top', run: () => toggle('pinned', !isPinned(key)) },
            { icon: '🔕', label: isMuted(key) ? 'Unmute' : 'Mute (no unread count on the button)', run: () => toggle('muted', !isMuted(key)) },
            c.type === 'dm' ? { icon: '👤', label: 'Open profile', run: () => { location.href = '/profiles.php?XID=' + encodeURIComponent(c.id); } } : null,
        ].filter(Boolean));
    }
    function copyText(t) {
        const done = () => showToast('Copied');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => fallback());
        else fallback();
        function fallback() {
            const ta = document.createElement('textarea');
            ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); done(); } catch (e) {}
            ta.remove();
        }
    }
    function showToast(text) {
        if (!root) return;
        const t = document.createElement('div');
        t.className = 'twc-toast';
        t.textContent = text;
        root.appendChild(t);
        setTimeout(() => t.remove(), 1400);
    }
    function messageSheet(bubble) {
        const c = convs.get(currentKey);
        const b = c && box(c.key);
        const m = b && b.list.find((x) => x.messageId === bubble.getAttribute('data-id'));
        if (!m) return;
        const uid = m.sender && m.sender.userId;
        const mine = isMine(c.key, m);
        const link = (String(m.content).match(/\bhttps?:\/\/[^\s<]+/) || [])[0];
        sheet('', [
            !mine && m.sender && m.sender.name ? { icon: '↩️', label: 'Reply to ' + m.sender.name, run: () => insertText('@' + m.sender.name + ' ') } : null,
            { icon: '📋', label: 'Copy text', run: () => copyText(m.content) },
            link ? { icon: '🔗', label: 'Open link', run: () => window.open(link, '_blank', 'noopener') } : null,
            uid && !mine ? { icon: '👤', label: 'Open ' + (m.sender.name || 'profile'), run: () => { location.href = '/profiles.php?XID=' + encodeURIComponent(uid); } } : null,
            uid && !mine && c.type === 'room' ? { icon: '💬', label: 'Message privately', run: () => { const k = dmKey(uid); conv(k, { type: 'dm', id: String(uid), name: m.sender.name, avatar: m.sender.avatar }); openConv(k); } } : null,
        ].filter(Boolean));
    }
    function insertText(t) {
        const ta = root && root.querySelector('.twc-compose textarea');
        if (!ta) return;
        ta.value = (ta.value && !/\s$/.test(ta.value) ? ta.value + ' ' : ta.value) + t;
        ta.dispatchEvent(new Event('input'));
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
    }

    // ------------------------------------------------------------ settings
    function openSettings() {
        const row = (label, html) => `<label class="twc-set"><span>${label}</span>${html}</label>`;
        const sel = (k, opts) => `<select data-k="${k}">${opts.map(([v, t]) => `<option value="${v}" ${String(prefs[k]) === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
        const chk = (k) => `<input type="checkbox" data-k="${k}" ${prefs[k] ? 'checked' : ''}>`;
        sheet('Settings', []);
        const box_ = root.querySelector('.twc-sheet-box');
        box_.insertAdjacentHTML('beforeend', `
            ${row('Text size', sel('size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]))}
            ${row('Enter sends the message', chk('enterSends'))}
            ${row('Patterned background', chk('wallpaper'))}
            ${row('FF / BS next to names <small>(from FF/BS Badges, no extra requests)</small>', chk('ffbs'))}
            ${row('Hide Torn\'s own chat <small>(it keeps running underneath; Torn\'s ⚙ chat settings stay in the bar)</small>', chk('hideTorn'))}
            ${row('Close the Torn chat windows the panel opened, when it closes', chk('closeTornWins'))}
            ${row('Mute chat sounds <small>(only sounds that come from Torn\'s chat)</small>', chk('muteSound'))}
            ${row('Image previews <small>(loading an image shows its host your IP; "trusted" = imgur, Discord, Tenor, Giphy, Torn…)</small>',
                sel('images', [['trusted', 'Trusted hosts'], ['all', 'All links'], ['off', 'Off']]))}
            ${soundsSeen.length ? `<div class="twc-sounds">Sounds on this page: ${soundsSeen.map((x) =>
                `<span>${esc(x.file)} — ${x.blocked ? 'muted' : x.chat ? 'chat' : 'not chat'}, ${tct(x.at)}</span>`).join('')}</div>` : ''}
            <div class="twc-support">Enjoying the panel? A Xanax or a few $ to
                <a href="/profiles.php?XID=${AUTHOR.id}">${AUTHOR.name} [${AUTHOR.id}]</a> keeps it going ❤️</div>
            <div class="twc-about">Times are TCT · Torn Chat Panel v${VERSION} · <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></div>
            <button type="button" class="twc-done">Done</button>`);
        const sh = root.querySelector('.twc-sheet');
        sh.addEventListener('click', (e) => { if (e.target.closest('.twc-done')) sh.remove(); });
        box_.addEventListener('change', (e) => {
            const k = e.target.getAttribute('data-k');
            if (!k) return;
            prefs[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
            savePrefs();
            root.classList.remove('sz-s', 'sz-m', 'sz-l');
            root.classList.add('sz-' + prefs.size);
            root.classList.toggle('nowall', !prefs.wallpaper);
            applyHideTorn();
            if (currentKey) { paintHeader(); renderMessages(); }
        });
    }
    function backToList(fromPop) {
        if (!fromPop && navDepth >= 2) { history.back(); return; }
        currentKey = null;
        if (!root) return;
        root.classList.remove('open');
        root.querySelector('.twc-conv').innerHTML = '<div class="twc-pick"><div style="font-size:40px">💬</div>Pick a chat</div>';
        renderList();
    }

    // Torn's unread counts go past 99, so the real number is shown (999+ only
    // to keep the badges narrow).
    const countText = (n) => (Number(n) > 999 ? '999+' : String(n));

    let renderQueued = false;
    function renderSoon() {
        paintUnreadSoon();
        if (renderQueued || !root) return;
        renderQueued = true;
        requestAnimationFrame(() => { renderQueued = false; renderList(); paintHeader(); });
    }
    // Total unread (muted chats left out) on the footer button and its menu entry.
    let unreadTimer = null;
    function paintUnreadSoon() {
        if (unreadTimer) return;
        unreadTimer = setTimeout(() => { unreadTimer = null; paintUnread(); }, 300);
    }
    function paintUnread() {
        let n = 0;
        convs.forEach((c) => { if (!c.stale && !isMuted(c.key)) n += Number(c.unread) || 0; });
        const label = n ? countText(n) : '';
        const el = document.getElementById('twc-btn');
        if (!el) return;
        if (label) el.setAttribute('data-twc-unread', label); else el.removeAttribute('data-twc-unread');
        injectBadgeStyles();
    }
    function injectBadgeStyles() {
        if (document.getElementById('twc-badge-styles')) return;
        const st = document.createElement('style');
        st.id = 'twc-badge-styles';
        st.textContent = `
            /* Round, lifted button wherever it sits (chat bar or floating). */
            #twc-btn { position: relative; display: flex; align-items: center; justify-content: center; border-radius: 50% !important;
                width: 40px !important; height: 40px !important; min-width: 40px; padding: 0 !important; margin: auto 4px; align-self: center;
                border: 0 !important; box-shadow: 0 4px 12px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.25) !important; overflow: visible; }
            #twc-btn:active { transform: scale(.94); }
            #twc-btn svg { width: 22px; height: 22px; }
            #twc-btn.twc-float { position: fixed; right: 14px; bottom: 160px; z-index: 2147483639; width: 52px !important; height: 52px !important;
                cursor: pointer; margin: 0; }
            #twc-btn[data-twc-unread]::after {
                content: attr(data-twc-unread); position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px;
                border-radius: 9px; background: #e5534b; color: #fff; font: 700 11px/18px Arial, sans-serif; text-align: center;
                box-sizing: border-box; pointer-events: none; z-index: 1; }
            /* Torn's own chat, hidden but still running underneath (it loads and sends for us). */
            /* Every element inside, too: Torn's windows set pointer-events: auto on themselves,
               which would otherwise take taps through the invisible layer. */
            html.twc-hide-torn [data-twc-hidden] { opacity: 0 !important; }
            html.twc-hide-torn [data-twc-hidden], html.twc-hide-torn [data-twc-hidden] * { pointer-events: none !important; }
            /* The same by structure, so it already applies while Torn first draws its chat on
               each page (the attributes above only come a moment later). Torn's chat root holds
               the windows area and the button bar; everything but the bar is hidden, except
               Torn's chat Settings panel, opened by Torn's ⚙ that stays in the bar. */
            html.twc-hide-torn #chatRoot > div > div:not(:has(#people_panel_button, #twc-btn, #notes_settings_button, [data-nth-hub])) { pointer-events: none !important; }
            html.twc-hide-torn #chatRoot > div > div:not(:has(#people_panel_button, #twc-btn, #notes_settings_button, [data-nth-hub])) > :not(#settings_panel):not(:has(#settings_panel)) { opacity: 0 !important; }
            html.twc-hide-torn #chatRoot > div > div:not(:has(#people_panel_button, #twc-btn, #notes_settings_button, [data-nth-hub])) > :not(#settings_panel):not(:has(#settings_panel)),
            html.twc-hide-torn #chatRoot > div > div:not(:has(#people_panel_button, #twc-btn, #notes_settings_button, [data-nth-hub])) > :not(#settings_panel):not(:has(#settings_panel)) * { pointer-events: none !important; }
            html.twc-hide-torn #settings_panel { pointer-events: auto !important; }
            html.twc-hide-torn #chatRoot [id^="chat_panel_button:"], html.twc-hide-torn #people_panel_button { display: none !important; }`;
        (document.head || document.documentElement).appendChild(st);
    }
    function sortedConvs() {
        return Array.from(convs.values())
            .filter((c) => c.type && c.id)
            .filter((c) => !query || titleOf(c).toLowerCase().includes(query) || (c.last && String(c.last.content).toLowerCase().includes(query)))
            .sort((a, b) => (isPinned(b.key) - isPinned(a.key)) || (((b.last && b.last.createdAt) || 0) - ((a.last && a.last.createdAt) || 0)));
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
            const muted = isMuted(c.key);
            return `<div class="twc-item${c.unread ? ' unread' : ''}${muted ? ' muted' : ''}${c.key === currentKey ? ' sel' : ''}" data-key="${esc(c.key)}">
                ${avatarHtml(c)}
                <div class="twc-mid">
                    <div class="twc-main"><span class="twc-name">${esc(titleOf(c))}</span>
                        <span class="twc-prev">${l ? esc(who + String(l.content).replace(/\s+/g, ' ')) : '&nbsp;'}</span></div>
                    <div class="twc-side"><span class="twc-time">${listTime(l && l.createdAt)}</span>
                        <span class="twc-flags">${muted ? '<i class="twc-ico" title="Muted">🔕</i>' : ''}${isPinned(c.key) ? '<i class="twc-ico" title="Pinned">📌</i>' : ''}` +
                        `${c.unread ? `<span class="twc-badge">${countText(c.unread)}</span>` : ''}</span></div>
                </div></div>`;
        }).join('');
    }

    function openConv(key) {
        const c = convs.get(key);
        if (!c || !root) return;
        if (narrow() && navDepth === 1) { history.pushState({ twc: 2 }, ''); navDepth = 2; }
        currentKey = key;
        olderPending = 0;
        ffbsReadAt = 0;   // pick up players FF/BS Badges looked up since
        root.classList.add('open');
        const max = (c.rules && c.rules.maxLength) || DEFAULT_MAX_LEN;
        root.querySelector('.twc-conv').innerHTML = `
            <div class="twc-head">
                <button class="twc-ib twc-back" data-a="back" title="Back">←</button>
                ${avatarHtml(c)}
                <div class="twc-ctitle"></div>
                <button class="twc-ib" data-a="close2" title="Close">✕</button>
            </div>
            <div class="twc-msgwrap"><div class="twc-msgs"></div>
                <button type="button" class="twc-down" hidden title="Newest messages"><b hidden></b>⌄</button>
                <div class="twc-jump" hidden><button type="button" class="twc-jumpgo" title="First unread message">↑ <span></span></button></div></div>
            <div class="twc-err" hidden></div>
            <div class="twc-emoji" hidden><div class="twc-etabs"></div><div class="twc-egrid"></div></div>
            <div class="twc-compose">
                <button type="button" class="twc-ib twc-ebtn" title="Emoji">😊</button>
                <textarea rows="1" placeholder="Message"></textarea>
                <span class="twc-count" hidden></span>
                <button class="twc-send" title="Send">➤</button>
            </div>`;
        const conv = root.querySelector('.twc-conv');
        conv.querySelector('[data-a="back"]').addEventListener('click', requestBack);
        conv.querySelector('[data-a="close2"]').addEventListener('click', requestClose);
        onLongPress(conv.querySelector('.twc-msgs'), '.twc-b[data-id]', (b) => messageSheet(b));
        const ta = conv.querySelector('textarea');
        const count = conv.querySelector('.twc-count');
        ta.addEventListener('input', () => {
            ta.style.height = 'auto';
            ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
            // Counter appears near the limit (always in rooms with a small one, like Trade).
            const n = lengthFor(c, ta.value);
            count.hidden = !(max <= 200 || n > max * 0.8);
            count.textContent = `${n}/${max}`;
            count.classList.toggle('over', n > max);
            const send = conv.querySelector('.twc-send');
            send.disabled = sending || n > max;
            send.classList.toggle('idle', !ta.value.trim());
        });
        emojiPicker(conv, ta);
        ta.dispatchEvent(new Event('input'));
        ta.addEventListener('keydown', (e) => {
            // Enter sends on desktop; on phones Enter is a new line, like WhatsApp.
            if (e.key === 'Enter' && !e.shiftKey && prefs.enterSends) { e.preventDefault(); doSend(); }
        });
        conv.querySelector('.twc-send').addEventListener('click', doSend);
        const box_ = conv.querySelector('.twc-msgs');
        box_.addEventListener('scroll', () => { if (box_.scrollTop < 60) loadOlder(); paintDown(); }, { passive: true });
        // Images load after the text: stay at the bottom if the reader was there.
        // "Following" = the reader is at the very bottom. Any scroll away from it,
        // even a little, stops new messages and images from pulling the view down.
        following = true;
        box_.addEventListener('scroll', () => { following = box_.scrollHeight - box_.scrollTop - box_.clientHeight < FOLLOW_PX; }, { passive: true });
        box_.addEventListener('load', (e) => {
            if (e.target.classList && e.target.classList.contains('twc-img') && following) box_.scrollTop = box_.scrollHeight;
        }, true);
        box_.addEventListener('error', (e) => {
            const img = e.target;
            if (!img.classList || !img.classList.contains('twc-img')) return;
            const a = img.closest('.twc-imglink');
            const url = decode(a.getAttribute('data-url'));
            brokenImgs.add(url);
            linkifyCache.clear();
            a.classList.remove('twc-imglink');
            a.textContent = url.replace(/^https?:\/\/(www\.)?/, '').replace(/^(.{42}).+$/, '$1…');
        }, true);
        conv.querySelector('.twc-down').addEventListener('click', () => { box_.scrollTo({ top: box_.scrollHeight, behavior: 'smooth' }); newBelow = 0; });
        newBelow = 0; shownCount = 0;
        // Where the unread part starts: fixed to a message once the history is in.
        unreadMark = { key, count: Number(c.unread) || 0, id: null, seen: false };
        if (unreadMark.count) needRead(key);
        c.unread = 0;
        // ↑ N: jump to the first unread message, and (like the ✕ on Torn's own pill)
        // count them all as read right away; the divider stays as a marker.
        conv.querySelector('.twc-jumpgo').addEventListener('click', () => {
            const div = box_.querySelector('.twc-unread');
            if (div) div.scrollIntoView({ behavior: 'smooth', block: 'start' });
            unreadMark.seen = true;
            paintJump();
            needRead(key);
            markRead(c, true);
        });
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
        const chip = c.type === 'dm' ? ffbsChip(c.id) : '';
        const html = `<b>${name}</b>${status || chip ? `<small>${esc(status)}${status && chip ? ' ' : ''}${chip}</small>` : ''}`;
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
        const nearBottom = following;
        const oldHeight = el.scrollHeight, oldTop = el.scrollTop;
        // The message at the top of the view, to put it back exactly where it was
        // after the redraw (images briefly have no height while re-created).
        let anchor = null;
        if (!keepTop && stick !== true && !nearBottom) {
            const top = el.getBoundingClientRect().top;
            const first = Array.from(el.querySelectorAll('.twc-b[data-id]')).find((x) => x.getBoundingClientRect().bottom > top);
            if (first) anchor = { id: first.getAttribute('data-id'), off: first.getBoundingClientRect().top - top };
        }
        let html = `<div class="twc-older">${olderPending ? 'Loading older messages…' : ''}</div>`;
        if (!b.list.length) html += `<div class="twc-empty">${b.loaded ? 'No messages yet.' : 'Loading messages…'}</div>`;
        else if (!b.loaded) html += '<div class="twc-older">Loading earlier messages…</div>';
        // Groups: same sender, same day, no gap over 5 minutes. Each message knows
        // whether it opens and/or closes its group, which drives spacing and corners.
        const starts = b.list.map((m, i) => {
            if (!i) return true;
            const p = b.list[i - 1];
            const at = m.createdAt || Date.now(), pat = p.createdAt || Date.now();
            return dayKey(at) !== dayKey(pat) || (m.sender && m.sender.userId) !== (p.sender && p.sender.userId) || at - pat > 5 * 60000;
        });
        let lastDay = '', idx = -1;
        if (unreadMark && unreadMark.key === c.key && unreadMark.count && !unreadMark.id && b.loaded && b.list.length) {
            const real = b.list.filter((x) => !x.pending && !isMine(c.key, x));
            const at = real[Math.max(0, real.length - unreadMark.count)];
            unreadMark.id = at ? at.messageId : null;
            unreadMark.partial = unreadMark.count > real.length;
        }
        const unreadId = unreadMark && unreadMark.key === c.key ? unreadMark.id : null;
        const room = c.type === 'room';
        b.list.forEach((m) => {
            idx++;
            const at = m.createdAt || Date.now();
            const d = dayKey(at);
            if (d !== lastDay) { html += `<div class="twc-day"><span>${dayLabel(at)}</span></div>`; lastDay = d; }
            if (unreadId && m.messageId === unreadId) {
                const n = unreadMark.count;
                html += `<div class="twc-unread"><span>${countText(n)} unread message${n === 1 ? '' : 's'}${unreadMark.partial ? ' (older ones not loaded)' : ''}</span></div>`;
            }
            const mine = isMine(c.key, m);
            const uid = m.sender && m.sender.userId;
            const first = starts[idx] || (unreadId && m.messageId === unreadId);
            const last = idx === b.list.length - 1 || starts[idx + 1];
            const jumbo = isJumbo(m.content);
            const from = room && !mine && first && m.sender
                ? `<span class="twc-fromrow"><a class="twc-from" href="/profiles.php?XID=${encodeURIComponent(uid)}" style="color:${nameColor(uid)} !important">${esc(m.sender.name)}</a>${ffbsChip(uid)}</span>` : '';
            const av = room && !mine && first && m.sender
                ? `<a class="twc-sav${statusClass(onlineMap.get(String(uid)))}" href="/profiles.php?XID=${encodeURIComponent(uid)}">${m.sender.avatar ? `<img src="${esc(m.sender.avatar)}" alt="" loading="lazy">` : esc(String(m.sender.name || '?').slice(0, 1))}</a>` : '';
            const tick = mine ? (m.pending ? '<i class="twc-tick">🕓</i>' : m.failed ? '<i class="twc-tick bad">!</i>' : '<i class="twc-tick">✓</i>') : '';
            const cls = ['twc-b', mine ? 'mine' : '', first ? 'first' : '', last ? 'last' : '', room && !mine ? 'indent' : '', jumbo ? 'jumbo' : '',
                m.pending ? 'pending' : '', m.failed ? 'failed' : '', !mine && mentionsMe(m.content) ? 'mention' : ''].filter(Boolean).join(' ');
            html += `<div class="${cls}" data-id="${esc(m.messageId)}">${av}${from}<span class="twc-txt">${linkify(m.content)}</span>` +
                `<span class="twc-meta">${m.createdAt ? tct(m.createdAt) : ''}${tick}</span></div>`;
        });
        el.innerHTML = html;
        if (keepTop) el.scrollTop = el.scrollHeight - oldHeight + oldTop;
        else if (stick === true || nearBottom) { el.scrollTop = el.scrollHeight; newBelow = 0; following = true; }
        else {
            const same = anchor && el.querySelector(`.twc-b[data-id="${anchor.id.replace(/"/g, '')}"]`);
            if (same) el.scrollTop += same.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.off;
            else el.scrollTop = oldTop;
            if (b.list.length > shownCount) newBelow += b.list.length - shownCount;
        }
        shownCount = b.list.length;
        paintDown();
    }
    let newBelow = 0, shownCount = 0, unreadMark = null;
    let following = true;
    const FOLLOW_PX = 24;
    // "↑ N" until the unread divider has been on screen once (or tapped).
    function paintJump() {
        const el = root && root.querySelector('.twc-msgs');
        const btn = root && root.querySelector('.twc-jump');
        if (!el || !btn) return;
        const div = el.querySelector('.twc-unread');
        if (div && !unreadMark.seen) {
            const r = div.getBoundingClientRect(), v = el.getBoundingClientRect();
            if (r.bottom > v.top && r.top < v.bottom && v.height > 0) unreadMark.seen = true;
        }
        const show = !!div && !unreadMark.seen;
        btn.querySelector('span').textContent = unreadMark && unreadMark.count ? countText(unreadMark.count) : '';
        btn.classList.toggle('on', show);
        if (show) btn.hidden = false;
        else if (!btn.hidden) setTimeout(() => { if (!btn.classList.contains('on')) btn.hidden = true; }, 250);
    }
    function paintDown() {
        paintJump();
        markReadIfSeen();
        const el = root && root.querySelector('.twc-msgs');
        const btn = root && root.querySelector('.twc-down');
        if (!el || !btn) return;
        const away = !following && el.scrollHeight - el.scrollTop - el.clientHeight > 80;
        if (!away) newBelow = 0;
        btn.hidden = !away;
        btn.querySelector('b').textContent = newBelow ? String(newBelow) : '';
        btn.querySelector('b').hidden = !newBelow;
    }
    const isJumbo = (t) => {
        const s = String(t || '').trim();
        if (!s || s.length > 40) return false;
        const found = s.match(EMOJI_RE);
        return !!found && found.length <= 3 && !s.replace(EMOJI_RE, '').replace(/[\s\uFE0F\u200D]/g, '');
    };
    const mentionsMe = (t) => !!myName && new RegExp('@' + myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(String(t || ''));

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
        const pick = root.querySelector('.twc-emoji');
        if (pick) pick.hidden = true;
        lastSentKey = c.key;
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
            setTimeout(() => { if (pending.pending) { pending.pending = false; pending.sentOk = true; if (currentKey === c.key) renderMessages(); } }, 8000);
        }
        if (currentKey === c.key) renderMessages(false, true);
    }

    // ------------------------------------------------------------ entry button
    const CHAT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"%CLS%>' +
        '<path fill="#fff" d="M12 3C7 3 3 6.6 3 11c0 2.2 1 4.2 2.7 5.6L5 21l4.2-2.2c.9.2 1.8.3 2.8.3 5 0 9-3.6 9-8s-4-8-9-8z"/></svg>';
    // ------------------------------------------------------------ new chats from Torn's pages
    // Torn's own "Start chat" button (profile and mini profile) opens a private
    // window in Torn's chat, which the panel keeps hidden: the panel opens on
    // that chat instead. Torn's search suggestions get a 💬 that goes to the
    // player's profile with #twc-chat, where Torn's "Start chat" is tapped
    // once for you (that tap is the 💬 you made).
    const START_SEL = '.profile-button-initiateChat';
    async function startChatFromTorn(uid, name) {
        const key = dmKey(uid);
        const c = conv(key, { type: 'dm', id: String(uid) });
        if (!c.name && name) c.name = name;
        saveConvs();
        const win = await waitFor(() => tornWindow(c), 5000);
        if (win) { openedWins.add(String(uid)); applyHideTorn(); }
        // With Torn's chat shown, Torn's own window is what you see.
        if (!hidingTorn()) return;
        openPanel();
        openConv(key);
    }
    function profileName(uid) {
        const m = /^(.+?)'s Profile/.exec(document.title);
        return m && new RegExp('[?&]XID=' + uid + '(\\D|$)').test(location.search) ? m[1] : '';
    }
    function onStartChatClick(e) {
        const b = e.target && e.target.closest && e.target.closest(START_SEL);
        if (!b) return;
        const m = /profile-(\d+)/.exec(b.id || '') || /[?&]XID=(\d+)/.exec(location.search);
        if (m) startChatFromTorn(m[1], profileName(m[1]));
    }
    // 💬 next to each player in Torn's search suggestions.
    function addSearchChat() {
        document.querySelectorAll('#userword-listbox a[id^="userword-option-"]').forEach((a) => {
            if (a.querySelector('.twc-schat')) return;
            const uid = a.id.replace('userword-option-', '');
            if (!/^\d+$/.test(uid)) return;
            const b = document.createElement('span');
            b.className = 'twc-schat';
            b.setAttribute('role', 'button');
            b.title = 'Start chat';
            b.textContent = '💬';
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                location.href = `https://www.torn.com/profiles.php?XID=${uid}#twc-chat`;
            }, true);
            a.appendChild(b);
        });
    }
    async function startChatFromHash() {
        if (location.hash !== '#twc-chat' || !/\/profiles\.php/.test(location.pathname)) return;
        history.replaceState(history.state, '', location.pathname + location.search);
        const b = await waitFor(() => document.querySelector(START_SEL), 10000);
        if (b) b.click();
    }
    function hookStartChat() {
        document.addEventListener('click', onStartChatClick, true);
        const st = document.createElement('style');
        st.textContent = `#userword-listbox a[id^="userword-option-"] { display: flex; align-items: center; }
            .twc-schat { margin-left: auto; padding: 0 8px; font-size: 16px; line-height: 24px; cursor: pointer; flex: none; }`;
        (document.head || document.documentElement).appendChild(st);
        let queued = false;
        new MutationObserver(() => {
            if (queued || !document.getElementById('userword-listbox')) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; addSearchChat(); });
        }).observe(document.getElementById('header-root') || document.body, { childList: true, subtree: true });
        addSearchChat();
        startChatFromHash();
    }

    // Our own button in Torn's chat bar (not in the shared script menu), where
    // Torn's chat buttons were. Without a chat bar it floats bottom-right.
    function mountButton() {
        if (!document.body) return;
        const ref = document.getElementById('people_panel_button') || document.getElementById('notes_settings_button');
        let btn = document.getElementById('twc-btn');
        const placed = btn && (ref ? btn.parentNode === ref.parentNode : btn.classList.contains('twc-float'));
        if (!placed) {
            if (btn) btn.remove();
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'twc-btn';
            btn.title = 'Chats';
            btn.innerHTML = CHAT_SVG.replace('%CLS%', '');
            btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (root) requestClose(); else openPanel(); });
            if (ref && ref.parentNode) {
                btn.className = ref.className;
                const svgCls = ref.querySelector('svg') && ref.querySelector('svg').className && ref.querySelector('svg').className.baseVal;
                if (svgCls) btn.querySelector('svg').setAttribute('class', svgCls);
                // First in the bar, before the shared script button and Torn's own.
                const first = Array.from(ref.parentNode.children).find((el) => el.tagName === 'BUTTON' || el.querySelector('button')) || ref;
                ref.parentNode.insertBefore(btn, first);
            } else {
                btn.classList.add('twc-float');
                document.body.appendChild(btn);
            }
            btn.style.setProperty('background', 'linear-gradient(to bottom, #25c26e, #0b8a4a)', 'important');
        }
        injectBadgeStyles();
        applyHideTorn();
        paintUnreadSoon();
    }

    function start() {
        if (!document.body) return setTimeout(start, 200);
        mountButton();
        hookStartChat();
        readBootstrap();
        let pending = false;
        new MutationObserver(() => {
            if (pending || document.hidden) return;
            pending = true;
            setTimeout(() => { pending = false; mountButton(); }, 300);
        }).observe(document.body, { childList: true });
        // Torn's chat renders after the page; hide its windows as they appear.
        waitFor(() => chatRoot(), 15000).then((chat) => {
            if (!chat) return;
            const barFound = () => !!(document.getElementById('people_panel_button') || document.getElementById('notes_settings_button') ||
                chat.querySelector('[id^="chat_panel_button:"]'));
            setTimeout(() => {
                if (!barFound()) { degrade('bar'); return; }
                if (health.json || health.ws) { recovered(); return; }
                setTimeout(() => {
                    if (health.json || health.ws) recovered();
                    else if (!document.hidden) degrade('data');
                }, 15000);
            }, 8000);
            let p2 = false;
            new MutationObserver(() => {
                if (p2) return;
                p2 = true;
                requestAnimationFrame(() => { p2 = false; mountButton(); });
            }).observe(chat, { childList: true, subtree: true });
            mountButton();
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
