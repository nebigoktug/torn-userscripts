// ==UserScript==
// @name         Torn Shoplifting Assistant
// @namespace    http://torn.com/
// @version      2.0.0
// @description  Shoplifting güvenlik durumu, dinamik mağaza listesi, akıllı öneri (düzeltilmiş API şeması)
// @author       nebigoktug
// @match        https://www.torn.com/page.php?sid=crimes*
// @match        https://www.torn.com/loader.php?sid=crimes*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// ==/UserScript==

(function () {
    'use strict';

    // ---- AYARLAR ----
    const STORAGE_KEY = 'tsa_stats_v2';
    const POLL_MS = 30000; // 30 sn
    let apiKey = GM_getValue('torn_api_key', '');
    let pollTimer = null;

    // Mağaza adlarını güzelleştirmek için (opsiyonel). API'de olmayan anahtarlar
    // otomatik başlıklandırılır, yani liste eksik olsa da script çalışır.
    const SHOP_META = {
        bitsnbobs:  { name: 'Bits & Bobs', icon: '🛠️' },
        pharmacy:   { name: 'Pharmacy',    icon: '💊' },
        jewelry:    { name: 'Jewelry',     icon: '💍' },
        clothing:   { name: 'Clothing',    icon: '👕' },
        super:      { name: 'Super Store', icon: '🛒' },
        nikeh:      { name: 'Sally\'s',    icon: '🎰' },
        bigals:     { name: 'Big Al\'s',   icon: '🔫' },
        docks:      { name: 'Docks',       icon: '⚓' },
        postoffice: { name: 'Post Office', icon: '📮' },
        market:     { name: 'TC Market',   icon: '🏪' }
    };

    // ---- STORAGE (tek sistem: GM_*) ----
    function getStats() {
        try {
            return JSON.parse(GM_getValue(STORAGE_KEY, '{"shops":{}}'));
        } catch (e) {
            return { shops: {} };
        }
    }
    function saveStats(stats) {
        GM_setValue(STORAGE_KEY, JSON.stringify(stats));
    }
    function updateStats(shopId, success) {
        const stats = getStats();
        if (!stats.shops[shopId]) stats.shops[shopId] = { attempts: 0, wins: 0, losses: 0 };
        stats.shops[shopId].attempts += 1;
        success ? stats.shops[shopId].wins++ : stats.shops[shopId].losses++;
        saveStats(stats);
    }
    function getSuccessRate(shopId) {
        const s = getStats().shops[shopId];
        if (!s || s.attempts === 0) return null;
        return (s.wins / s.attempts * 100).toFixed(1);
    }

    // ---- API ----
    function promptForApiKey() {
        const key = prompt('Torn Public API Key girin (Settings → API):');
        if (key) {
            apiKey = key.trim();
            GM_setValue('torn_api_key', apiKey);
            fetchSecurityData(renderPanel);
        }
    }

    function fetchSecurityData(callback) {
        if (!apiKey) { promptForApiKey(); return; }
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.torn.com/torn/?selections=shoplifting&key=${apiKey}&comment=ShopAssistant`,
            onload: function (res) {
                let data;
                try { data = JSON.parse(res.responseText); }
                catch (e) { setStatus('API yanıtı okunamadı.'); return; }
                if (data.error) {
                    setStatus('API Hatası: ' + data.error.error);
                    if (data.error.code === 2) { // yanlış key
                        GM_setValue('torn_api_key', '');
                        apiKey = '';
                    }
                    return;
                }
                callback(data.shoplifting || {});
            },
            onerror: function () { setStatus('API bağlantısı başarısız.'); }
        });
    }

    // ---- GÜVENLİK MANTIĞI (DÜZELTİLDİ) ----
    // Her mağaza = [{title, disabled}, ...]. disabled:true => o önlem KAPALI (iyi).
    function activeDefenses(arr) {
        if (!Array.isArray(arr)) return [];
        return arr.filter(d => !d.disabled).map(d => d.title);
    }
    function disabledDefenses(arr) {
        if (!Array.isArray(arr)) return [];
        return arr.filter(d => d.disabled).map(d => d.title);
    }
    function shopState(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return 'unknown';
        const active = activeDefenses(arr).length;
        if (active === 0) return 'safe';       // tüm önlemler kapalı
        if (active < arr.length) return 'partial';
        return 'risky';                         // tümü aktif
    }
    function prettyName(id) {
        return (SHOP_META[id] && SHOP_META[id].name) ||
            id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, c => c.toUpperCase());
    }
    function icon(id) { return (SHOP_META[id] && SHOP_META[id].icon) || '🏬'; }

    // ---- UI ----
    function setStatus(msg) {
        const el = document.getElementById('tsa-status');
        if (el) el.textContent = msg;
    }

    function renderPanel(shopData) {
        let container = document.getElementById('tsa-panel');
        if (!container) {
            container = document.createElement('div');
            container.id = 'tsa-panel';
            container.style.cssText =
                'background:#1a1a2e;color:#eee;padding:12px;border-radius:8px;' +
                'margin:10px 0;border:1px solid #444;font-family:Arial,sans-serif;';
            const anchor = document.querySelector('.content-wrapper') ||
                           document.querySelector('#mainContainer') || document.body;
            anchor.prepend(container);
        }
        container.innerHTML = '';

        // Başlık
        const title = document.createElement('div');
        title.innerHTML =
            '<b>🔍 Shoplifting Assistant</b> ' +
            `<span style="font-size:12px;color:#aaa;">(${new Date().toLocaleTimeString()})</span>` +
            ' <span id="tsa-status" style="font-size:12px;color:#ff9800;"></span>';
        container.appendChild(title);

        // Mağazaları riske göre sırala (az aktif önlem = üstte)
        const ids = Object.keys(shopData).sort((a, b) =>
            activeDefenses(shopData[a]).length - activeDefenses(shopData[b]).length);

        const list = document.createElement('div');
        list.style.marginTop = '10px';

        for (const id of ids) {
            const arr = shopData[id];
            const state = shopState(arr);
            const rate = getSuccessRate(id);
            const rateText = rate !== null ? `%${rate}` : '—';
            const colors = { safe: '#4caf50', partial: '#ffc107', risky: '#f44336', unknown: '#888' };
            const bg = { safe: '#1e3a2e', partial: '#3a3a1e', risky: '#3a1e1e', unknown: '#222' };
            const label = { safe: '✅ GÜVENLİ', partial: '⚠️ Kısmi', risky: '❌ Riskli', unknown: '❓' };

            const row = document.createElement('div');
            row.style.cssText =
                'display:flex;align-items:center;justify-content:space-between;' +
                `padding:6px 8px;margin:3px 0;background:${bg[state]};border-radius:4px;` +
                `border-left:4px solid ${colors[state]};`;

            const active = activeDefenses(arr);
            const defensesText = arr && arr.length
                ? arr.map(d => `${d.title}:${d.disabled ? '🟢' : '🔴'}`).join('  ')
                : 'veri yok';

            const left = document.createElement('span');
            left.innerHTML = `${icon(id)} <b>${prettyName(id)}</b>  ${defensesText}`;

            const right = document.createElement('span');
            right.style.color = colors[state];
            if (state === 'safe') right.style.fontWeight = 'bold';
            right.innerHTML = `Başarı: ${rateText}  ${label[state]}`;

            row.appendChild(left);
            row.appendChild(right);
            list.appendChild(row);
        }
        container.appendChild(list);

        // Öneri: tümüyle güvenli mağazalar
        const rec = document.createElement('div');
        rec.style.cssText = 'margin-top:12px;padding:8px;background:#2a2a3e;border-radius:4px;';
        const safe = ids.filter(id => shopState(shopData[id]) === 'safe');
        if (safe.length) {
            rec.innerHTML = '<b>🎯 Şu an güvenli:</b> <span style="color:#4caf50;">' +
                safe.map(prettyName).join(' → ') + '</span>';
        } else {
            const partial = ids.filter(id => shopState(shopData[id]) === 'partial');
            rec.innerHTML = partial.length
                ? '<b>🎯 En düşük risk:</b> <span style="color:#ffc107;">' +
                    partial.slice(0, 3).map(prettyName).join(' → ') + '</span>'
                : '<span style="color:#ff9800;">Tüm mağazalarda güvenlik aktif — bekle.</span>';
        }
        container.appendChild(rec);

        // İstatistik özeti
        const stats = getStats();
        let ta = 0, tw = 0;
        for (const s in stats.shops) { ta += stats.shops[s].attempts; tw += stats.shops[s].wins; }
        const summary = document.createElement('div');
        summary.style.cssText = 'margin-top:8px;font-size:13px;color:#aaa;';
        summary.innerHTML = `📊 Toplam Deneme: ${ta} | Başarılı: ${tw}` +
            (ta ? ` (${(tw / ta * 100).toFixed(1)}%)` : '');
        container.appendChild(summary);
    }

    // ---- SPA GEZİNME TESPİTİ ----
    // Crimes tek sayfa uygulaması; hash #/shoplifting olduğunda paneli göster.
    function isShopliftingView() {
        return location.hash.includes('shoplifting');
    }

    function startPolling() {
        stopPolling();
        fetchSecurityData(renderPanel);
        pollTimer = setInterval(() => fetchSecurityData(renderPanel), POLL_MS);
    }
    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        const p = document.getElementById('tsa-panel');
        if (p) p.remove();
    }

    function route() {
        if (isShopliftingView()) {
            if (!document.getElementById('tsa-panel')) startPolling();
        } else {
            stopPolling();
        }
    }

    window.addEventListener('hashchange', route);
    // İlk yükleme (React'in DOM'u kurması için ufak gecikme)
    setTimeout(route, 1500);
})();
