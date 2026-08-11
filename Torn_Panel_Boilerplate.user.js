// ==UserScript==
// @name          Torn Panel Boilerplate
// @version       1.0
// @description   Reusable floating-panel UI skeleton (drag + minimize + color-coded status + localStorage). Blackjack ToolKit tarzı. İçini kendi mantığınla doldur.
// @author        nebigoktug
// @match         https://www.torn.com/*
// @match         https://www.torn.com/pda.php*
// @grant         none
// @license       MIT
// @namespace     torn.panel.boilerplate
// @downloadURL   https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Panel_Boilerplate.user.js
// @updateURL     https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_Panel_Boilerplate.user.js
// ==/UserScript==

(function () {
    'use strict';

    /* =====================================================================
     *  KONFİG — her yeni script için burayı değiştir
     * ===================================================================== */
    const CFG = {
        ID: 'torn-boilerplate-panel',        // panel DOM id (benzersiz yap)
        TITLE: 'My Panel',                    // header başlığı
        NS: 'torn_boilerplate',               // localStorage anahtar öneki
        WIDTH: 230,                           // panel genişliği (px)
        ACCENT: '#FFD700',                    // varsayılan vurgu / border rengi
    };

    // localStorage anahtarları (NS ile öneklenir, çakışma olmaz)
    const K = {
        POS: `${CFG.NS}_pos`,
        MIN: `${CFG.NS}_minimized`,
        DATA: `${CFG.NS}_data`,               // kendi verini burada tut
    };

    // Renk kodlu durum paleti (Blackjack'ten). Kendi durumlarına eşle.
    const STATUS = {
        primary:  '#FF5722',  // turuncu (ör. Hit / uyarı)
        good:     '#4CAF50',  // yeşil   (ör. Stand / OK)
        info:     '#2196F3',  // mavi    (ör. Double / bilgi)
        special:  '#9C27B0',  // mor     (ör. Surrender / özel)
        neutral:  '#888888',  // gri     (boşta)
    };

    /* =====================================================================
     *  STATE
     * ===================================================================== */
    let isMinimized = false;
    let isDragging = false;
    let dragOffsetX = 0, dragOffsetY = 0;
    let lastRenderedState = '';   // gereksiz DOM yenilemesini engeller

    /* =====================================================================
     *  UTILS
     * ===================================================================== */
    // Blackjack'teki k/m/b formatlayıcı — para/sayı gösterimi için
    function fmtKMB(num) {
        if (typeof num !== 'number' || !isFinite(num)) return 'NaN';
        if (num === 0) return '0';
        const abs = Math.abs(num), sign = num < 0 ? '-' : '';
        if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'b';
        if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'm';
        if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'k';
        return sign + abs.toLocaleString();
    }

    function saveData(obj) { localStorage.setItem(K.DATA, JSON.stringify(obj)); }
    function loadData(fallback = {}) {
        try { return JSON.parse(localStorage.getItem(K.DATA)) ?? fallback; }
        catch { return fallback; }
    }

    /* =====================================================================
     *  STYLES
     * ===================================================================== */
    function injectStyles() {
        if (document.getElementById(`${CFG.ID}-style`)) return;
        const s = document.createElement('style');
        s.id = `${CFG.ID}-style`;
        s.textContent = `
            #${CFG.ID} {
                position: fixed; top: 10px; right: 10px; z-index: 2147483647;
                background-color: #1a1a1a; border: 2px solid ${CFG.ACCENT}; border-radius: 8px;
                padding: 8px; width: ${CFG.WIDTH}px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                font-family: monospace; color: #E0E0E0; line-height: 1.4;
            }
            #${CFG.ID} .bp-header {
                display:flex; justify-content:space-between; align-items:center;
                cursor: move; user-select:none; padding-bottom:6px; margin-bottom:6px;
                border-bottom:1px solid #333; font-weight:bold; color:${CFG.ACCENT};
            }
            #${CFG.ID} .bp-min { cursor:pointer; padding:0 6px; opacity:.7; }
            #${CFG.ID} .bp-min:hover { opacity:1; }

            #${CFG.ID} .bp-body { display:flex; flex-direction:column; gap:6px; }

            /* renk yardımcıları */
            .bp-green { color:#4CAF50; font-weight:bold; }
            .bp-red   { color:#FF6F69; font-weight:bold; }
            .bp-grey  { color:#AAAAAA; }
            .bp-gold  { color:${CFG.ACCENT}; font-weight:bold; }

            /* büyük durum kutusu (ana aksiyon) */
            .bp-status {
                text-align:center; font-size:16px; font-weight:800; padding:10px;
                border-radius:4px; border:2px solid var(--bp-color,${CFG.ACCENT});
                background: color-mix(in srgb, var(--bp-color,${CFG.ACCENT}) 20%, #1a1a1a);
                color:#fff; text-transform:uppercase;
            }
            /* gerekçe / alt bilgi satırı */
            .bp-reason { font-size:11px; text-align:center; color:${CFG.ACCENT}; }
            .bp-sub    { font-size:12px; text-align:center; color:#ccc; }

            /* genel buton */
            .bp-btn {
                background:#333; border:1px solid #555; color:${CFG.ACCENT}; cursor:pointer;
                border-radius:4px; padding:6px; font-size:11px; font-weight:bold; text-transform:uppercase;
            }
            .bp-btn:hover { background:#444; border-color:${CFG.ACCENT}; }

            /* grid bilgi kutusu (Risk paneli tarzı) */
            .bp-grid {
                background:#111; border:1px solid #333; padding:5px; border-radius:4px;
                font-size:10px; display:grid; grid-template-columns:1fr 1fr; gap:2px;
            }
            .bp-grid .lbl { color:#888; text-align:left; }
            .bp-grid .val { text-align:right; font-weight:bold; }

            /* input */
            .bp-input {
                width:100%; box-sizing:border-box; background:#333; color:#fff;
                border:1px solid #555; padding:4px; text-align:right; font-family:monospace; border-radius:4px;
            }
        `;
        document.head.appendChild(s);
    }

    /* =====================================================================
     *  PANEL İSKELETİ
     * ===================================================================== */
    function createPanel() {
        if (document.getElementById(CFG.ID)) return;
        injectStyles();

        const panel = document.createElement('div');
        panel.id = CFG.ID;

        // header
        const header = document.createElement('div');
        header.className = 'bp-header';
        header.innerHTML = `<span>${CFG.TITLE}</span>`;
        const minBtn = document.createElement('span');
        minBtn.className = 'bp-min';
        minBtn.textContent = '_';
        minBtn.onclick = toggleMinimize;
        header.appendChild(minBtn);

        // body
        const body = document.createElement('div');
        body.className = 'bp-body';
        body.id = `${CFG.ID}-body`;

        panel.append(header, body);
        document.body.appendChild(panel);

        restorePosition(panel);
        setupDrag(panel, header);

        isMinimized = localStorage.getItem(K.MIN) === 'true';
        applyMinimize();

        render(); // ilk çizim
    }

    /* =====================================================================
     *  RENDER — kendi içeriğini buraya koy
     * ===================================================================== */
    function render() {
        const body = document.getElementById(`${CFG.ID}-body`);
        if (!body) return;

        // ---- ÖRNEK: kendi durum mantığınla değiştir ----
        const state = getState();

        // gereksiz yeniden çizimi engelle
        const key = JSON.stringify(state);
        if (key === lastRenderedState) return;
        lastRenderedState = key;

        const color = STATUS[state.tone] || STATUS.neutral;
        document.getElementById(CFG.ID).style.borderColor = color;

        body.innerHTML = `
            <div class="bp-status" style="--bp-color:${color}">${state.action}</div>
            ${state.reason ? `<div class="bp-reason">${state.reason}</div>` : ''}
            ${state.sub ? `<div class="bp-sub">${state.sub}</div>` : ''}
        `;

        // ---- örnek buton (isteğe bağlı) ----
        // const btn = document.createElement('button');
        // btn.className = 'bp-btn'; btn.textContent = 'DO SOMETHING';
        // btn.onclick = () => { /* ... */ };
        // body.appendChild(btn);
    }

    // ---- BURAYI DOLDUR: sayfadan durumu oku, ne göstereceğine karar ver ----
    function getState() {
        // Örnek dönüş. Kendi DOM okumanı / mantığını yaz.
        return {
            action: 'HAZIR',              // büyük kutuda görünecek metin
            tone:   'neutral',            // STATUS anahtarı: primary/good/info/special/neutral
            reason: 'İçini doldur',       // sarı gerekçe satırı (opsiyonel)
            sub:    '',                   // ham veri / alt bilgi (opsiyonel)
        };
    }

    /* =====================================================================
     *  MINIMIZE
     * ===================================================================== */
    function toggleMinimize() {
        isMinimized = !isMinimized;
        localStorage.setItem(K.MIN, String(isMinimized));
        applyMinimize();
    }
    function applyMinimize() {
        const body = document.getElementById(`${CFG.ID}-body`);
        if (body) body.style.display = isMinimized ? 'none' : 'flex';
    }

    /* =====================================================================
     *  DRAG (PC: header'dan sürükle / Mobil: tek parmak header)
     * ===================================================================== */
    function setupDrag(panel, handle) {
        const start = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return;
            if (e.type === 'touchstart' && e.touches.length !== 1) return;
            isDragging = true;
            const cx = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            const cy = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const r = panel.getBoundingClientRect();
            dragOffsetX = cx - r.left; dragOffsetY = cy - r.top;
            e.preventDefault();
        };
        const move = (e) => {
            if (!isDragging) return;
            const cx = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            const cy = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            panel.style.left = `${cx - dragOffsetX}px`;
            panel.style.top  = `${cy - dragOffsetY}px`;
            panel.style.right = 'auto';
            e.preventDefault();
        };
        const end = () => {
            if (!isDragging) return;
            isDragging = false;
            const r = panel.getBoundingClientRect();
            localStorage.setItem(K.POS, JSON.stringify({ left: r.left, top: r.top }));
        };
        handle.addEventListener('mousedown', start);
        handle.addEventListener('touchstart', start, { passive: false });
        document.addEventListener('mousemove', move);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('mouseup', end);
        document.addEventListener('touchend', end);
    }
    function restorePosition(panel) {
        try {
            const p = JSON.parse(localStorage.getItem(K.POS));
            if (p) { panel.style.left = `${p.left}px`; panel.style.top = `${p.top}px`; panel.style.right = 'auto'; }
        } catch {}
    }

    /* =====================================================================
     *  OYUN/SAYFA DURUMU İZLEME (MutationObserver)
     *  Sayfa DOM'u değişince render() tetiklenir.
     * ===================================================================== */
    function watch() {
        const obs = new MutationObserver(() => {
            if (!document.getElementById(CFG.ID)) createPanel();
            render();
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    /* =====================================================================
     *  BAŞLAT
     * ===================================================================== */
    function init() {
        createPanel();
        watch();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
