// ==UserScript==
// @name         Torn - Poker Sidearm TR
// @namespace    https://greasyfork.org/users/nebigoktug
// @version      1.0.4
// @description  Turkish translation of Poker Sidearm 8.7.1: FOLD / CALL / RAISE advice at Torn poker with Turkish explanations. Torn button names stay in English.
// @author       S7upidity, NebiGoktug
// @license      MIT
// @match        *://www.torn.com/page.php?sid=holdem*
// @match        *://torn.com/page.php?sid=holdem*
// @match        *://www.torn.com/loader.php?sid=holdem*
// @match        *://torn.com/loader.php?sid=holdem*
// @run-at       document-idle
// @connect      ffscouter.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// ==/UserScript==

// Turkish translation of S7upidity\u2019s MIT-licensed "Torn - Poker Sidearm" 8.7.1
// (greasyfork.org/scripts/596796). Advice logic is unchanged; only on-screen
// explanations are translated. Based on 8.7.1 on purpose: the 8.8.1 "research"
// setup sends the Torn API key to the author\u2019s server (s7-access.s7access.workers.dev).
// The only outside connection here is ffscouter.com, and only if a key is entered.
// Copy/export output (hand notes, JSON/CSV) stays in English for analysis.

(function () {
    'use strict';

    // PDA script\u2019i sayfa içi geçişlerde yeniden yükleyebilir; ikinci kopya çalışmasın.
    if (window.__tpsTrRunning) return;
    window.__tpsTrRunning = true;
    const TR_VERSION = '1.0.4';

    const SETTINGS_KEY = 'tornPokerSidearm_settings';
    const HISTORY_KEY = 'tornPokerSidearm_history';
    const LAST_HAND_KEY = 'tornPokerSidearm_lastHand';
    const HAND_NOTES_KEY = 'tornPokerSidearm_handNotes';
    const HAND_RECORDS_KEY = 'tornPokerSidearm_handRecords';
    const THREE_BET_HELP_KEY = 'tornPokerSidearm_seenThreeBetHelp_v1';
    const HISTORY_MAX = 20;
    const PERFORMANCE_MAX = 2000;
    const SIDEARM_VERSION = '8.7.1';
    const DATA_SCHEMA_VERSION = 15;
    const EQUITY_MODEL_VERSION = 5;
    const EQUITY_MODEL_HEADS_UP = 'weighted-range-v1';
    const EQUITY_MODEL_HEADS_UP_RIVER = 'weighted-range-river-exact-v1';
    const EQUITY_MODEL_MULTIWAY = 'joint-multiway-v1';
    const EQUITY_MODEL_LEGACY_MULTIWAY = 'legacy-multiway-factor-v1';
    const PREFLOP_STRATEGY_VERSION = 10;
    const POSTFLOP_ADVICE_MODEL_VERSION = 4;
    const POSTFLOP_ADVICE_MODEL = 'action-first-v2';
    const OPPONENT_MODEL_VERSION = 1;
    const OPPONENT_DATA_SCHEMA_VERSION = 1;
    const WHY_EXPLAINER_VERSION = 3;
    const OPPONENT_HISTORY_KEY = 'tornPokerSidearm_opponentHistory_v1';

    // ── Global tuning values ─────────────────────────────────────
    // Keep user-tweakable fixed values together here.
    const TOPOLOGY_SETTLE_MS = 300;
    const DEPARTED_DEEP_STACK_BB = 150;
    const DEPARTED_ALERT_MS = 10000;
    const TABLE_INSIGHT_ALERT_MS = 8000;
    const MUTATION_REFRESH_DEBOUNCE_MS = 400;
    const SAFETY_REFRESH_MS = 8000;
    const FF_SCORE_CACHE_MS = 120000;
    const EQUITY_TRIALS_HEADS_UP = 700;
    const EQUITY_TRIALS_TWO_VILLAINS = 450;
    const EQUITY_TRIALS_MULTIWAY = 300;
    const EQUITY_TRIALS_MANY_VILLAINS = 220;
    const V6_LOG_ROW_LIMIT = 180;
    const V6_HAND_CACHE_MAX = 6;
    const V6_SEAT_CAPTURE_WINDOW_MS = 1200;
    const V6_NEW_HAND_SETTLE_MS = 250;
    const V6_FINALISE_DELAY_MS = 80;
    const OPPONENT_HISTORY_MIN_HANDS = 30;
    const OPPONENT_HISTORY_MIN_POSTFLOP_ACTIONS = 20;
    const OPPONENT_HISTORY_MAX_INFLUENCE = 0.12;
    // Feature flags: set to 1 to expose these optional UI sections.
    const debug = 0;
    const bountyView = 0;
    const _ffScoreCache = {}; // playerId -> { fair_fight, at }
    const SETTINGS_DEFAULTS = {
        enabled: true,
        bubblePosition: null,
        panelPosition: null,
        bubbleSize: 'M', // S | M | L | XL
        rangeStyle: 'balanced', // tight | balanced | wide
        ffKey: '',
        pricePerHit: 500000,
    };
    const MIN_PRICE = 300000;
    const MAX_PRICE = 10000000;
    const SIGNUP_SOURCE = 'PokerSidearm';
    // FFScouter script commission recipient on supported endpoints
    const REFERRER_PLAYER_ID = 3567556;

    // Development helpers get a gold name treatment in the poker UI/log.
    // Keep this as a simple ID array so helpers can be added/removed easily.
    const DevelopmentHelpers = Object.freeze([3691632, 4148136, 2169567, 2094612]);

    const SEAT_TO_BUCKET = {
        BTN: 'BTN', CO: 'CO',
        SB: 'SB', BB: 'BB',
        UTG: 'EP', 'UTG+1': 'EP', 'UTG+2': 'EP',
        LJ: 'MP', HJ: 'MP', MP: 'MP',
        EP: 'EP', LP: 'BTN',
    };

    function loadSettings() {
        try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
        catch { return { ...SETTINGS_DEFAULTS }; }
    }
    function saveSettings(s) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    }
    let settings = loadSettings();

    function seatToBucket(seat) {
        if (!seat) return 'MP';
        if (SEAT_TO_BUCKET[seat]) return SEAT_TO_BUCKET[seat];
        if (/^UTG\+\d+$/.test(seat)) return 'EP';
        return 'MP';
    }
    function isBtn(pos) { return pos === 'BTN' || pos === 'LP'; }
    function isCo(pos) { return pos === 'CO'; }
    function isLate(pos) { return isBtn(pos) || isCo(pos); }
    function isBlind(pos) { return pos === 'SB' || pos === 'BB'; }

    const PREFLOP_RANGE_STYLES = Object.freeze(['tight', 'balanced', 'wide', 'yo-momma']);

    function currentPreflopRangeStyle() {
        const raw = String(settings.rangeStyle || 'balanced').trim().toLowerCase();
        return PREFLOP_RANGE_STYLES.includes(raw) ? raw : 'balanced';
    }

    function preflopRangeStyleLabel(style = currentPreflopRangeStyle()) {
        const s = String(style || '').toLowerCase();
        if (s === 'tight') return 'Sıkı';
        if (s === 'wide') return 'Geniş';
        if (s === 'yo-momma') return 'Çok geniş';
        return 'Dengeli';
    }

    function preflopRangeStyleDescription(style = currentPreflopRangeStyle()) {
        const s = String(style || '').toLowerCase();
        if (s === 'tight') return 'Sınırdaki ellerle daha az oyuna girer, daha az devam eder.';
        if (s === 'wide') return 'Baskı azken bazı riskli ama potansiyelli elleri de oynar.';
        if (s === 'yo-momma') return 'Çok geniş: özellikle geç pozisyonda çok daha fazla elle açar ve ucuz durumlarda devam eder.';
        return 'Sidearm\u2019ın varsayılan el aralıkları.';
    }

    // Range-style boundaries are deliberately explicit. Balanced is the existing
    // strategy. Tight trims only boundary opens/continues; Wide adds selected
    // lower-pressure hands. Yo Momma is an intentionally extra-wide extension,
    // but still does not loosen the multi-raise / 3-bet / 4-bet safety gates.
    const PREFLOP_TIGHT_RFI_REMOVE = Object.freeze({
        EP: new Set(['55','KQo','QJo','T9s','98s']),
        MP: new Set(['22','33','44','A9s','A8s','KTs','QTs','J9s','87s']),
        CO: new Set(['22','A2s','A3s','A4s','K9s','K8s','Q9s','J8s','T8s','97s','76s']),
        BTN: new Set(['22','A2s','K7s','Q8s','J7s','T7s','86s','65s']),
        SB: new Set(['22','A2s','A3s','K9s','Q9s','J9s','76s']),
        BB: new Set()
    });

    const PREFLOP_WIDE_RFI_ADD = Object.freeze({
        EP: new Set(['44','33','22','A9s','A8s','KTs','QTs','J9s','87s','76s']),
        MP: new Set(['A7s','A6s','A5s','A4s','A3s','A2s','K9s','Q9s','J8s','T8s','97s','76s','65s','54s']),
        CO: new Set(['K7s','K6s','Q8s','J7s','T7s','86s','65s','54s','A9o','KTo','QTo','JTo']),
        BTN: new Set(['K6s','K5s','K4s','K3s','K2s','Q7s','Q6s','J6s','T6s','96s','85s','75s','64s','54s','A9o','A8o','KTo','QTo','JTo']),
        SB: new Set(['K8s','K7s','Q8s','J8s','T8s','97s','86s','65s','54s','A9o','KTo','QTo','JTo']),
        BB: new Set()
    });


    // Yo Momma is intentionally much wider than Wide. These are additional
    // unopened-pot raises beyond the Balanced range. The list is explicit so
    // future calibration can compare exactly what the player selected.
    const PREFLOP_YO_MOMMA_RFI_ADD = Object.freeze({
        EP: new Set([
            '44','33','22','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s',
            'KTs','K9s','K8s','QTs','Q9s','J9s','J8s','T8s','97s','87s','76s','65s','54s',
            'AJo','KJo','QTo','JTo'
        ]),
        MP: new Set([
            'A7s','A6s','A5s','A4s','A3s','A2s','K9s','K8s','K7s','K6s',
            'Q9s','Q8s','Q7s','J8s','J7s','J6s','T8s','T7s','97s','96s','87s','86s','76s','75s','65s','64s','54s',
            'A9o','A8o','KTo','QTo','JTo'
        ]),
        CO: new Set([
            'K7s','K6s','K5s','K4s','K3s','K2s','Q8s','Q7s','Q6s','Q5s',
            'J7s','J6s','J5s','T7s','T6s','T5s','96s','86s','85s','76s','75s','65s','64s','54s','53s','43s',
            'A9o','A8o','A7o','KTo','K9o','QTo','Q9o','JTo','J9o','T9o','98o'
        ]),
        BTN: new Set([
            'K6s','K5s','K4s','K3s','K2s',
            'Q7s','Q6s','Q5s','Q4s','Q3s','Q2s',
            'J6s','J5s','J4s','J3s','J2s',
            'T6s','T5s','T4s','96s','95s','94s','85s','84s','75s','74s','64s','63s','54s','53s','43s',
            'A9o','A8o','A7o','A6o','A5o','A4o','A3o','A2o',
            'KTo','K9o','K8o','K7o','QTo','Q9o','Q8o','JTo','J9o','J8o','T9o','98o','87o','76o'
        ]),
        SB: new Set([
            'K8s','K7s','K6s','K5s','K4s','K3s','K2s',
            'Q8s','Q7s','Q6s','Q5s','J8s','J7s','J6s','J5s','T8s','T7s','T6s','T5s',
            '97s','96s','86s','85s','76s','75s','65s','64s','54s','53s',
            'A9o','A8o','A7o','KTo','K9o','QTo','Q9o','JTo','J9o','T9o','98o'
        ]),
        BB: new Set()
    });

    const DEFAULT_ACTION_META = Object.freeze({ color: '#b39ddb', symbol: '◆', verb: '-' });
    const ACTION_META = Object.freeze({
        '4bet': Object.freeze({ color: '#8e44ad', symbol: '▲▲▲', verb: '4-BET+', bubbleVerb: 'RE-RAISE+', panelVerb: '4-BET+ · Tekrar raise' }),
        '3bet': Object.freeze({ color: '#9b59b6', symbol: '▲▲', verb: '3-BET', bubbleVerb: 'RE-RAISE', panelVerb: '3-BET · Re-raise' }),
        raise: Object.freeze({ color: '#2ecc71', symbol: '▲', verb: 'RAISE' }),
        call: Object.freeze({ color: '#f1c40f', symbol: '●', verb: 'CALL' }),
        check: Object.freeze({ color: '#3498db', symbol: '✓', verb: 'CHECK' }),
        fold: Object.freeze({ color: '#e74c3c', symbol: '✕', verb: 'FOLD' })
    });
    function actionMeta(action) { return ACTION_META[action] || DEFAULT_ACTION_META; }
    function actionColor(action) { return actionMeta(action).color; }
    function actionSymbol(action) { return actionMeta(action).symbol; }
    function actionVerb(action) { return actionMeta(action).verb; }
    function actionBubbleVerb(action) { return actionMeta(action).bubbleVerb || actionMeta(action).verb; }
    function actionPanelVerb(action) { return actionMeta(action).panelVerb || actionMeta(action).verb; }

    // ── TR: görüntülenen metinler için çeviri tabloları ──────────
    // İç değerler (kayıtlar, karşılaştırmalar) İngilizce kalır; sadece ekranda
    // gösterilirken çevrilir.
    const TR_STRENGTH = Object.freeze({ premium: 'Çok güçlü', strong: 'Güçlü', playable: 'Oynanabilir', marginal: 'Sınırda', weak: 'Zayıf' });
    const TR_DEPTH = Object.freeze({ short: 'kısa', mid: 'orta', medium: 'orta', deep: 'derin' });
    const TR_MADE_HAND = Object.freeze({
        'High card': 'Yüksek kart', 'Pair': 'Çift', 'Two pair': 'İki çift', 'Three of a kind': 'Üçlü',
        'Straight': 'Straight', 'Flush': 'Flush', 'Full house': 'Full house', 'Four of a kind': 'Kare',
        'Straight flush': 'Straight flush', 'High pair · overpair': 'Yüksek çift · masadan büyük',
        'High pair · top pair': 'Yüksek çift · en yüksek çift', 'High pair': 'Yüksek çift',
        'Mid pair': 'Orta çift', 'Low pair': 'Düşük çift', 'Unknown': 'Bilinmiyor',
        'On the board…': 'Masada…', 'Waiting for board': 'Masa kartları bekleniyor', 'Hand': 'El'
    });
    function trMadeHand(s) { return TR_MADE_HAND[s] || s; }
    // Torn\u2019daki buton adları (FOLD, CALL, RAISE...) İngilizce kalır; Torn\u2019da
    // karşılığı olmayan durum etiketleri çevrilir.
    const TR_ACTION_LABEL = Object.freeze({ WAIT: 'BEKLE', FOLDED: 'FOLD EDİLDİ' });
    function trActionLabel(s) { return TR_ACTION_LABEL[s] || s; }
    const TR_TEXTURE = Object.freeze({ wet: 'ıslak (çok ihtimalli)', mixed: 'karışık', dry: 'kuru (az ihtimalli)' });

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
    function money(n) {
        if (n == null || isNaN(n)) return '-';
        return '$' + Number(n).toLocaleString();
    }
    function formatTs(unix) {
        if (!unix) return '-';
        try { return new Date(unix * 1000).toLocaleString(); }
        catch { return String(unix); }
    }
    function cardHtml(card) {
        if (!card) return '';
        const rank = card.slice(0, -1);
        const suit = card.slice(-1);
        const red = suit === '♥' || suit === '♦';
        return `<span class="tps-card${red ? ' red' : ''}">${escHtml(rank)}${escHtml(suit)}</span>`;
    }

    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            const fn = (typeof GM_xmlhttpRequest === 'function')
                ? GM_xmlhttpRequest
                : (typeof GM !== 'undefined' && GM.xmlHttpRequest);
            if (!fn) {
                const init = { method: opts.method || 'GET', headers: opts.headers || {} };
                if (opts.data != null) init.body = opts.data;
                fetch(opts.url, init)
                    .then(r => r.text().then(t => resolve({ status: r.status, responseText: t })))
                    .catch(reject);
                return;
            }
            fn({
                method: opts.method || 'GET',
                url: opts.url,
                headers: opts.headers || {},
                data: opts.data,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('timeout')),
                timeout: opts.timeout || 20000,
            });
        });
    }
    function parseJson(res) {
        try { return JSON.parse(res.responseText); }
        catch { throw new Error('Non-JSON (HTTP ' + res.status + ')'); }
    }

    const RANK_VALUES = {
        '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
        'T': 10, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
    };
    const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];


    // ── Standalone table identity / cash-BB mapping ────────────────
    // Torn's felt texture identifies the exact table even while the UI is in
    // BB display mode. Several tables share a blind, so texture identity is
    // preferred over inferring a table from stake alone.
    const TPS_TABLE_BY_TEXTURE = Object.freeze({
        newbie_corner:   { name: 'Newbie Corner',    bb: 10 },
        hobo_holdem:     { name: 'Hobo Holdem',      bb: 25 },
        broke_jokes:     { name: 'Broke Jokes',      bb: 50 },
        '8_bit':         { name: '8-bit',             bb: 100 },
        '8bit':          { name: '8-bit',             bb: 100 },
        sprinkles:       { name: 'Sprinkles',         bb: 250 },
        e_asy_street:    { name: 'E-asy Street',      bb: 500 },
        easy_street:     { name: 'E-asy Street',      bb: 500 },
        gatling_gun:     { name: 'Gatling Gun',       bb: 1000 },
        quickdraw:       { name: 'Quickdraw',         bb: 2500 },
        tight_knit:      { name: 'Tight Knit',        bb: 5000 },
        six_of_the_best: { name: 'Six of the Best',   bb: 10000 },
        ballsy:          { name: 'Ballsy',             bb: 25000 },
        boom_or_bust:    { name: 'Boom or Bust',      bb: 50000 },
        old_n_slow:      { name: "Old 'n Slow",       bb: 100000 },
        periodic:        { name: 'Periodic',           bb: 100000 },
        fourplay:        { name: 'Fourplay',           bb: 100000 },
        duel_at_dawn:    { name: 'Duel at Dawn',      bb: 100000 },
        pound_it:        { name: 'Pound It',           bb: 250000 },
        old_folks_home:  { name: 'Old Folks Home',    bb: 500000 },
        river_wizard:    { name: 'River Wizard',      bb: 1000000 },
        tripod:          { name: 'Tripod',             bb: 1000000 },
        comatose_cove:   { name: 'Comatose Cove',     bb: 1000000 },
        cats_chance:     { name: "Cat's Chance",      bb: 2500000 },
        juan_on_juan:    { name: 'Juan on Juan',      bb: 5000000 },
        slow_cooker:     { name: 'Slow Cooker',       bb: 5000000 },
        high_rollers:    { name: 'High Rollers',      bb: 10000000 },
        fire_pit:        { name: 'Fire Pit',          bb: 25000000 },
        oligarch:        { name: 'Oligarch',          bb: 100000000 }
    });

    const TPS_TABLE_NAMES_BY_BB = (() => {
        const out = new Map();
        for (const meta of Object.values(TPS_TABLE_BY_TEXTURE)) {
            if (!out.has(meta.bb)) out.set(meta.bb, new Set());
            out.get(meta.bb).add(meta.name);
        }
        return out;
    })();

    let _observedTableTextureKey = '';
    let _observedTableTextureAt = 0;

    function tableTextureKeyFromStyle(styleText) {
        const style = String(styleText || '');
        if (!style) return '';

        // Torn currently serves PDA/mobile felts from:
        //   /casino/holdem/images/tables/320/320_gatling_gun.png
        // Older/alternate renders have used:
        //   .../tables_colour/<size>/<size>_gatling_gun.png
        // Accept both and ignore the separate frame image.
        const patterns = [
            /tables_colour\/\d+\/\d+_([a-z0-9_]+)\.(?:png|webp|jpe?g)/i,
            /(?:^|\/)tables\/\d+\/\d+_([a-z0-9_]+)\.(?:png|webp|jpe?g)/i
        ];
        for (const pattern of patterns) {
            const m = style.match(pattern);
            if (m) return m[1].toLowerCase();
        }
        return '';
    }

    function tableTextureKeyFromNode(node) {
        if (!node) return '';
        const texts = [];
        try { texts.push(node.getAttribute?.('style') || ''); } catch (_) {}
        for (const attr of ['src','srcset','data-src','data-srcset','data-background','data-bg','data-image']) {
            try {
                const value = node.getAttribute?.(attr);
                if (value) texts.push(value);
            } catch (_) {}
        }
        try {
            const cs = getComputedStyle(node);
            texts.push(cs?.backgroundImage || '', cs?.background || '');
        } catch (_) {}
        for (const pseudo of ['::before', '::after']) {
            try {
                const cs = getComputedStyle(node, pseudo);
                texts.push(cs?.backgroundImage || '', cs?.background || '');
            } catch (_) {}
        }
        for (const value of texts) {
            const key = tableTextureKeyFromStyle(value);
            if (key) return key;
        }
        return '';
    }

    function getRenderedTableTextureKey() {
        // Torn renders the felt on the table___ element. Read that element first;
        // tableTextureKeyFromNode accepts both current /tables/ URLs and the
        // older tables_colour URL format.
        const preferred = document.querySelectorAll(
            '[class^="table___"], [class*=" table___"]'
        );
        for (const node of preferred) {
            const key = tableTextureKeyFromNode(node);
            if (key) return key;
        }

        // Compatibility fallback for alternate renders where the felt-bearing
        // node is not the normal table___ element.
        const nodes = document.querySelectorAll(
            '[style*="tables_colour"], [style*="/tables/"], ' +
            '[src*="tables_colour"], [src*="/tables/"], ' +
            '[srcset*="tables_colour"], [srcset*="/tables/"], ' +
            '[data-src*="tables_colour"], [data-src*="/tables/"], ' +
            '[data-srcset*="tables_colour"], [data-srcset*="/tables/"], ' +
            '[data-background*="tables_colour"], [data-background*="/tables/"]'
        );
        for (const node of nodes) {
            const key = tableTextureKeyFromNode(node);
            if (key) return key;
        }
        return '';
    }

    function rememberRenderedTableTextureKey(key) {
        const next = String(key || '').trim().toLowerCase();
        if (!next) return false;
        const changed = next !== _observedTableTextureKey;
        _observedTableTextureKey = next;
        _observedTableTextureAt = Date.now();
        return changed;
    }

    function syncRenderedTableTexture() {
        const key = getRenderedTableTextureKey();
        return key ? rememberRenderedTableTextureKey(key) : false;
    }

    function getExactRenderedTableContext() {
        const key = getRenderedTableTextureKey();
        if (key) rememberRenderedTableTextureKey(key);
        const meta = key ? TPS_TABLE_BY_TEXTURE[key] : null;
        if (!meta) return null;
        return { key, name: meta.name, bb: meta.bb, source: 'texture' };
    }

    function tableCashBBForRecord(rec, state = null) {
        const values = [
            state?.bbInfo?.unit === 'cash' ? state.bbInfo.amount : null,
            rec?.tableBB,
            rec?.tableCashBB,
            state?.tableContext?.bb
        ];
        for (const value of values) {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
    }

    function tableBBMatches(a, b) {
        const aa = Number(a), bb = Number(b);
        if (!Number.isFinite(aa) || !Number.isFinite(bb) || aa <= 0 || bb <= 0) return false;
        return Math.abs(aa - bb) < Math.max(0.01, Math.min(aa, bb) * 0.000001);
    }

    function recoverExactTableContextForRecord(rec, state = null) {
        if (!rec || String(rec.tableKey || '').trim()) return false;

        const current = currentV6GameState();
        if (state?.gameId && current?.gameId && String(state.gameId) !== String(current.gameId)) {
            return false;
        }

        // Late recovery is fresh-DOM only. Never reuse a cached texture here:
        // moving between same-stake tables must not attach a stale felt key.
        const exact = getExactRenderedTableContext();
        if (!exact) return false;

        const handBB = tableCashBBForRecord(rec, state);
        if (!tableBBMatches(exact.bb, handBB)) return false;

        rec.tableKey = exact.key;
        rec.tableName = exact.name;
        rec.tableCashBB = exact.bb;
        rec.tableDetectionSource = 'texture-late-bb-match';

        if (state && !state.tableContextFrozen) {
            state.tableContext = { ...exact };
            state.tableContextFrozen = true;
        }
        return true;
    }

    function uniqueTableNameForCashBB(bb) {
        const n = Number(bb);
        if (!Number.isFinite(n) || n <= 0) return '';
        const names = TPS_TABLE_NAMES_BY_BB.get(n);
        return names?.size === 1 ? [...names][0] : '';
    }

    function detectCashBBFromVisibleSourcesUncached() {
        // Cash-mode hand log is authoritative when available.
        const gameLines = getCurrentGameLogLines();
        for (let i = gameLines.length - 1; i >= 0; i--) {
            const line = String(gameLines[i] || '').trim();
            const m = line.match(/posted\s+big\s+blind\s+(\$?\s*[\d,]+(?:\.\d+)?\s*[KMB]?)/i);
            if (!m) continue;
            const p = parseLogAmount(m[1]);
            if (Number.isFinite(p.cash) && p.cash > 0) return p.cash;
        }

        // Visible stake labels are a secondary standalone source.
        const labels = document.querySelectorAll(
            '[class*="stake"], [class*="blind"], [class*="tableName"], [class*="header"]'
        );
        for (const el of labels) {
            const tx = String(el.textContent || '').trim();
            if (!tx || tx.length > 80) continue;
            const m = tx.match(
                /\$\s*([\d,]+(?:\.\d+)?\s*[KMB]?)\s*\/\s*\$\s*([\d,]+(?:\.\d+)?\s*[KMB]?)/i
            );
            if (!m) continue;
            const bb = parseCashLoose(m[2]);
            if (Number.isFinite(bb) && bb > 0) return bb;
        }
        return null;
    }

    function detectStandaloneTableContext() {
        const exact = getExactRenderedTableContext();
        if (exact) return exact;

        const key = getRenderedTableTextureKey();
        const cashBB = detectCashBBFromVisibleSourcesUncached();
        const inferredName = uniqueTableNameForCashBB(cashBB);
        if (key || Number.isFinite(cashBB)) {
            return {
                key,
                name: inferredName,
                bb: Number.isFinite(cashBB) ? cashBB : null,
                source: key
                    ? (Number.isFinite(cashBB) ? 'unknown-texture+cash-bb' : 'unknown-texture')
                    : (inferredName ? 'cash-bb-unique' : 'cash-bb')
            };
        }
        return null;
    }

    function tableContextForGame(gameId = '') {
        const gid = String(gameId || '');
        const state = gid ? _v6Runtime.games.get(gid) : currentV6GameState();
        if (state?.tableContext?.name || Number.isFinite(state?.tableContext?.bb)) {
            return state.tableContext;
        }
        // A named Game ID must never borrow table identity from the currently
        // rendered table; missing is safer than cross-table contamination.
        if (gid) return null;
        return detectStandaloneTableContext();
    }

    // A hand may only consume live DOM from the table it was bound to.
    // Exact felt identity is frozen per Game ID so a rapid table switch cannot
    // overwrite the prior hand with seats/cards/stacks from the newly rendered table.
    function freezeExactTableContextForState(state) {
        if (!state) return false;
        if (state.tableContextFrozen && state.tableContext?.source === 'texture' && state.tableContext.key) {
            const live = getExactRenderedTableContext();
            return !!live && live.key === state.tableContext.key;
        }

        const exact = getExactRenderedTableContext();
        if (exact) {
            state.tableContext = { ...exact };
            state.tableContextFrozen = true;
            return true;
        }
        return true; // no exact anchor yet; retain provisional context without replacing it
    }

    function liveDomMatchesGameTable(state) {
        if (!state) return true;
        if (!state.tableContextFrozen || state.tableContext?.source !== 'texture' || !state.tableContext?.key) {
            return true;
        }
        const live = getExactRenderedTableContext();
        return !!live && live.key === state.tableContext.key;
    }

    function formatTableContextLabel(ctx) {
        if (!ctx) return '';
        const stake = Number.isFinite(ctx.bb) && ctx.bb > 0
            ? `${formatCompactDollars(ctx.bb)} BB`
            : '';
        if (ctx.name && stake) return `${ctx.name} (${stake})`;
        return ctx.name || stake || ctx.key || '';
    }

    let _pageIdentityRaw = null;
    let _pageIdentityCache = { id: '', name: '', playername: '', nameKey: '' };
    function getPageIdentity() {
        let raw = '';
        try { raw = String(document.getElementById('torn-user')?.value || ''); } catch (_) {}
        if (raw === _pageIdentityRaw) return _pageIdentityCache;

        _pageIdentityRaw = raw;
        let id = '';
        let name = '';
        if (raw) {
            try {
                const data = JSON.parse(raw);
                id = String(data?.id || '').trim();
                name = String(data?.playername || '').replace(/\s+/g, ' ').trim();
            } catch (_) {}
        }
        _pageIdentityCache = { id, name, playername: name, nameKey: normalisePlayerName(name) };
        return _pageIdentityCache;
    }

    function pageHeroIdentity(playerId) {
        const id = String(playerId || '').trim();
        if (!id) return null;
        const page = getPageIdentity();
        if (page.id !== id || !page.name) return null;
        return { id, name: page.name, nameKey: page.nameKey, source: 'page-identity' };
    }

    function getSelfSeatElement() {
        const pageId = getPageIdentity().id;
        if (pageId) {
            const exact = document.getElementById('player-' + pageId);
            if (exact && (
                /self/i.test(String(exact.className || '')) ||
                exact.closest?.('[class*="playerMeGateway"], [class*="selfPositioner"]')
            )) return exact;
        }
        return (
            document.querySelector('[id^="player-"][class*="self___"]') ||
            document.querySelector('[id^="player-"][class*="Self"]') ||
            document.querySelector('[class*="selfPositioner"] [id^="player-"]') ||
            document.querySelector('[class*="playerMeGateway"] [id^="player-"]') ||
            document.querySelector('[class*="Self"] [id^="player-"]')
        );
    }

    // ── Stack depth (BB) ─────────────────────────────────────────

    function parseCash(text) {
        if (text == null || text === '') return null;
        const s = String(text).trim();
        if (!s || !/\$/.test(s)) return null;
        const value = parseCashLoose(s);
        return Number.isFinite(value) ? value : null;
    }

    function parseBBToken(text) {
        if (!text) return null;
        const m = String(text).match(/([\d.]+)\s*BB/i);
        return m ? parseFloat(m[1]) : null;
    }

    function readSelfStackRaw() {
        return readSeatStackRaw(getSelfSeatElement());
    }

    function detectTableBBUncached() {
        const table = detectStandaloneTableContext();
        if (Number.isFinite(table?.bb) && table.bb > 0) return table.bb;
        return detectCashBBFromVisibleSourcesUncached();
    }
    function detectTableBB() {
        const state = currentV6GameState();

        if (Number.isFinite(state?.tableContext?.bb) && state.tableContext.bb > 0) {
            return state.tableContext.bb;
        }
        if (state?.bbInfo?.unit === 'cash' && state.bbInfo.amount > 0) {
            return state.bbInfo.amount;
        }

        const gameId = _v6Runtime.currentGameId || getCurrentGameId();
        if (!gameId) return detectTableBBUncached();
        return cacheGameField(
            gameId,
            'tableBB',
            detectTableBBUncached,
            v => Number.isFinite(v) && v > 0
        );
    }

    function getHeroStackBB() {
        const raw = readSelfStackRaw();
        if (!raw) return { stackBB: null, stackCash: null, tableBB: null, source: null };
        if (raw.kind === 'bb' || raw.kind === 'allin') {
            return { stackBB: raw.value, stackCash: null, tableBB: null, source: 'display-bb' };
        }
        const tableBB = detectTableBB();
        if (tableBB && tableBB > 0) {
            return {
                stackBB: raw.value / tableBB,
                stackCash: raw.value,
                tableBB,
                source: 'cash/bb',
            };
        }
        return { stackBB: null, stackCash: raw.value, tableBB: null, source: 'cash-no-bb' };
    }

    /** Map hero stack in BB → deep | mid | short */
    function depthFromStackBB(stackBB) {
        if (stackBB == null || !isFinite(stackBB)) return null;
        if (stackBB < 40) return 'short';
        if (stackBB < 80) return 'mid';
        return 'deep';
    }

    /** Effective depth for charts, automatically detected from the local stack in BB. */
    function resolveStackDepth() {
        const info = getHeroStackBB();
        const detected = depthFromStackBB(info.stackBB);
        return {
            depth: detected || 'deep',
            mode: 'auto',
            stackBB: info.stackBB,
            detected,
            source: info.source,
            fallback: !detected,
        };
    }

    function handClassTag(ev) {
        if (!ev) return 'Bilinmiyor';
        const { hi, lo, suited, isPair } = ev;
        const gap = hi - lo;
        if (isPair) {
            if (hi >= 12) return 'En iyi çift';
            if (hi >= 9) return 'Yüksek çift';
            if (hi >= 6) return 'Orta çift';
            return 'Küçük çift';
        }
        if (hi === 14) {
            if (lo >= 13) return suited ? 'AK suited' : 'AK offsuit';
            if (lo >= 12) return suited ? 'Güçlü as (suited)' : 'Güçlü as (offsuit)';
            if (lo >= 10) return suited ? 'As + 10-J (suited)' : 'As + 10-J (offsuit)';
            return suited ? 'Zayıf as (suited)' : 'Zayıf as (offsuit)';
        }
        // King-x / Queen-x / Jack-x
        if (hi === 13) {
            if (lo >= 12) return suited ? 'KQ suited' : 'KQ offsuit';
            if (lo >= 10) return suited ? 'Papaz + 10-J (suited)' : 'Papaz + 10-J (offsuit)';
            return suited ? 'Zayıf papaz (suited)' : 'Zayıf papaz (offsuit)';
        }
        if (hi === 12) {
            if (lo >= 11) return suited ? 'QJ suited' : 'QJ offsuit';
            if (lo >= 10) return suited ? 'QT suited' : 'QT offsuit';
            return suited ? 'Zayıf kız (suited)' : 'Zayıf kız (offsuit)';
        }
        if (hi === 11) {
            if (lo >= 10) return suited ? 'JT suited' : 'JT offsuit';
            return suited ? 'Zayıf vale (suited)' : 'Zayıf vale (offsuit)';
        }
        // Lower cards
        if (suited && gap <= 1 && lo >= 5) return 'Ardışık (suited)';
        if (suited && gap <= 2 && lo >= 4) return 'Bir boşluklu (suited)';
        if (suited) return 'Zayıf (suited)';
        return 'Zayıf (offsuit)';
    }

    // ── Explicit preflop range definitions ─────────────────────
    // These tables are the explicit strategy/range source for the core ranges.
    // Actions are listed as canonical hand strings. The legacy evaluator remains
    // authoritative for hands outside the explicit table so existing edge-case
    // behaviour is preserved while the main ranges are now auditable and editable.
    const PREFLOP_RANGE_TABLES = {
        rfi: {
            deep: {
                EP:  { raise: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','AKs','AKo','AQs','AQo','AJs','AJo','ATs','KQs','KQo','KJs','KJo','QJs','QJo','JTs','T9s','98s'] },
                MP:  { raise: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','KQs','KQo','KJs','KJo','KTs','QJs','QJo','QTs','JTs','J9s','T9s','98s','87s'] },
                CO:  { raise: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KJo','KTs','K9s','K8s','QJs','QJo','QTs','Q9s','JTs','J9s','J8s','T9s','T8s','98s','97s','87s','76s'] },
                BTN: { raise: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KJo','KTs','K9s','K8s','K7s','QJs','QJo','QTs','Q9s','Q8s','JTs','J9s','J8s','J7s','T9s','T8s','T7s','98s','97s','87s','86s','76s','65s'] },
                SB:  { raise: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KJo','KTs','K9s','QJs','QJo','QTs','Q9s','JTs','J9s','T9s','98s','87s','76s'] },
                BB:  { raise: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KJo','KTs','K9s','QJs','QJo','QTs','Q9s','JTs','J9s','T9s','98s','87s','76s'] }
            },
            mid: {},
            short: {}
        },
        facingRaise: {
            // Explicit continuation/3-bet tables are keyed by opener bucket.
            // The evaluator also applies depth/position restrictions to these
            // sets so the table remains compact rather than duplicating 18 matrices.
            EP:   { threebet: ['AA','KK','QQ','AKs','AKo','AQs'], call: ['JJ','TT','99','AQo','AJs','KQs'] },
            MP:   { threebet: ['AA','KK','QQ','AKs','AKo','AQs'], call: ['JJ','TT','99','88','AQo','AJs','ATs','KQs','KJs','QJs'] },
            Late: { threebet: ['AA','KK','QQ','AKs','AKo','AQs','A5s','A4s','A3s','A2s','AJs','ATs','KJs','KTs'], call: ['JJ','TT','99','88','77','66','AQo','AJo','ATs','KQs','KJs','QJs','JTs','T9s','98s'] },
            Blind:{ threebet: ['AA','KK','QQ','AKs','AKo','AQs','A5s','A4s','A3s','A2s','AJs','ATs','KJs','KTs'], call: ['JJ','TT','99','88','77','66','55','AQo','AJo','ATs','A9s','KQs','KJs','KTs','QJs','QTs','JTs','T9s','98s'] }
        }
    };

    // A range lookup is deliberately exact: suited/offsuit/pairs are distinct.


    function evalPreflopHandBaseline(holeCards, position, facingRaise, openerBucket) {
        if (!holeCards || holeCards.length < 2) return null;
        const r1 = RANK_VALUES[holeCards[0].slice(0, -1)];
        const r2 = RANK_VALUES[holeCards[1].slice(0, -1)];
        if (!r1 || !r2) return null;
        const hi = Math.max(r1, r2);
        const lo = Math.min(r1, r2);
        const suited = holeCards[0].slice(-1) === holeCards[1].slice(-1);
        const isPair = r1 === r2;
        const gap = hi - lo;
        const depth = resolveStackDepth().depth;
        const late = isLate(position);
        const btn = isBtn(position);
        const co = isCo(position);
        const blind = isBlind(position);
        const bb = position === 'BB';
        const sb = position === 'SB';
        const ep = position === 'EP';
        const mp = position === 'MP';
        const op = openerBucket || 'Late';
        const vsEP = op === 'EP';
        const vsMP = op === 'MP';
        const vsLate = op === 'Late' || op === 'Blind';

        let strength, action;

        if (facingRaise) {
            // Value 3-bets
            if (isPair && hi >= 12) {
                return { strength: 'premium', action: '3bet', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 14 && lo >= 13) {
                return { strength: 'premium', action: '3bet', suited, isPair, hi, lo, openerBucket: op };
            }
            if (isPair && hi === 11) {
                if (vsEP && depth !== 'short') {
                    return { strength: 'strong', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'strong', action: '3bet', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 14 && lo === 12) {
                if (vsLate || depth === 'short') {
                    return { strength: 'strong', action: '3bet', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'strong', action: 'call', suited, isPair, hi, lo, openerBucket: op };
            }
            if (isPair && hi === 10) {
                if (vsLate && (late || blind) && depth !== 'short') {
                    return { strength: 'strong', action: '3bet', suited, isPair, hi, lo, openerBucket: op };
                }
                if (!vsEP || late || blind) {
                    return { strength: 'strong', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'playable', action: (depth === 'deep' && bb) ? 'call' : 'fold', suited, isPair, hi, lo, openerBucket: op };
            }

            // Polar bluff 3-bets vs Late only (deep/mid)
            if (depth !== 'short' && vsLate) {
                if (suited && hi === 14 && lo >= 2 && lo <= 5 && (btn || blind)) {
                    return { strength: 'playable', action: '3bet', suited, isPair, hi, lo, openerBucket: op };
                }
                if (suited && hi === 14 && lo >= 10 && lo <= 11 && (late || blind)) {
                    return { strength: 'playable', action: '3bet', suited, isPair, hi, lo, openerBucket: op };
                }
                if (suited && hi === 13 && lo >= 9 && lo <= 11 && btn) {
                    return { strength: 'playable', action: '3bet', suited, isPair, hi, lo, openerBucket: op };
                }
            }

            // Continues - wider BB vs Late, tighter vs EP
            if (isPair && hi >= 9) {
                return { strength: hi >= 10 ? 'strong' : 'playable', action: 'call', suited, isPair, hi, lo, openerBucket: op };
            }
            if (isPair && hi >= 7) {
                if (vsEP) {
                    return { strength: 'playable', action: (bb && depth === 'deep') ? 'call' : 'fold', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'playable', action: (late || blind) && depth !== 'short' ? 'call' : 'fold', suited, isPair, hi, lo, openerBucket: op };
            }
            if (isPair && hi >= 5) {
                if ((bb || btn) && vsLate && depth === 'deep') {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }

            if (hi === 14 && (lo >= 11 || (suited && lo >= 10))) {
                return { strength: 'strong', action: 'call', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 14 && suited && lo >= 5) {
                if (vsEP) {
                    return { strength: 'playable', action: bb && depth === 'deep' && lo >= 8 ? 'call' : 'fold', suited, isPair, hi, lo, openerBucket: op };
                }
                if (vsLate && (bb || late) && depth !== 'short') {
                    return { strength: 'playable', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                if (vsMP && bb && depth === 'deep') {
                    return { strength: 'playable', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'marginal', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 14 && suited) {
                if (bb && vsLate && depth === 'deep') {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }

            if (hi === 13 && lo === 12) {
                if (vsEP) {
                    return { strength: 'playable', action: (suited && (late || bb)) ? 'call' : 'fold', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'playable', action: 'call', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 13 && lo === 11) {
                if (vsLate && (suited || bb || late) && depth !== 'short') {
                    return { strength: 'playable', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                if (vsMP && suited && (bb || late) && depth === 'deep') {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 13 && suited && lo >= 9) {
                if (vsLate && (bb || btn) && depth === 'deep') {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 12 && lo === 11) {
                if (vsLate && (suited || bb) && depth !== 'short') {
                    return { strength: 'playable', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 12 && suited && lo >= 9) {
                if (vsLate && bb && depth === 'deep') {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }
            if (hi === 11 && suited && lo === 10) {
                if (vsLate && (bb || late) && depth !== 'short') {
                    return { strength: 'playable', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                if (vsMP && bb && depth === 'deep') {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }

            if (suited && gap <= 1 && lo >= 5) {
                if (bb && vsLate && depth !== 'short') {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                if (bb && vsMP && depth === 'deep' && lo >= 7) {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                if (late && vsLate && depth === 'deep' && lo >= 7) {
                    return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
                }
                return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
            }
            if (suited && gap === 2 && lo >= 6 && bb && vsLate && depth === 'deep') {
                return { strength: 'marginal', action: 'call', suited, isPair, hi, lo, openerBucket: op };
            }

            return { strength: 'weak', action: 'fold', suited, isPair, hi, lo, openerBucket: op };
        }

        // RFI by true seat
        if (isPair) {
            if (hi >= 10) { strength = 'premium'; action = 'raise'; }
            else if (hi >= 7) { strength = 'strong'; action = 'raise'; }
            else if (hi >= 5) {
                strength = 'playable';
                if (ep) action = depth === 'deep' ? 'raise' : 'fold';
                else if (sb && depth === 'short') action = 'fold';
                else action = 'raise';
            } else {
                strength = 'marginal';
                if (btn || (co && depth === 'deep') || bb) action = depth === 'short' ? 'fold' : 'raise';
                else if (mp && depth === 'deep') action = 'raise';
                else if (sb && depth === 'deep') action = 'raise';
                else action = 'fold';
            }
        } else if (hi === 14) {
            if (lo >= 13) { strength = 'premium'; action = 'raise'; }
            else if (lo >= 12) { strength = suited ? 'premium' : 'strong'; action = 'raise'; }
            else if (lo >= 11) {
                if (suited) { strength = 'strong'; action = 'raise'; }
                else { strength = 'playable'; action = ep ? 'fold' : 'raise'; }
            } else if (lo >= 10) {
                if (suited) {
                    strength = 'strong';
                    action = ep && depth === 'short' ? 'fold' : 'raise';
                } else {
                    strength = 'playable';
                    if (btn || co) action = 'raise';
                    else if (mp || blind) action = depth === 'short' ? 'fold' : 'raise';
                    else action = 'fold';
                }
            } else if (suited) {
                strength = lo >= 5 ? 'playable' : 'marginal';
                if (btn) action = 'raise';
                else if (co && lo >= 4) action = depth === 'short' ? 'fold' : 'raise';
                else if (mp && lo >= 8 && depth === 'deep') action = 'raise';
                else if (sb && lo >= 5 && depth !== 'short') action = 'raise';
                else if (bb && depth !== 'short') action = 'raise';
                else action = 'fold';
            } else {
                strength = 'weak';
                if (btn && lo >= 9) { strength = 'marginal'; action = 'raise'; }
                else if (btn && lo >= 8 && depth === 'deep') { strength = 'marginal'; action = 'raise'; }
                else if (sb && lo >= 10 && depth === 'deep') { strength = 'marginal'; action = 'raise'; }
                else if (bb && lo >= 9 && depth === 'deep') { strength = 'marginal'; action = 'raise'; }
                else action = 'fold';
            }
        } else if (hi === 13) {
            if (lo >= 12 && suited) { strength = 'strong'; action = 'raise'; }
            else if (lo >= 12) { strength = 'playable'; action = ep ? 'fold' : 'raise'; }
            else if (lo >= 11) {
                strength = 'playable';
                if (ep) action = 'fold';
                else if ((co || sb) && !suited && depth === 'short') action = 'fold';
                else action = 'raise';
            } else if (suited && lo >= 9) {
                strength = 'playable';
                action = late || (mp && depth === 'deep') || (sb && depth === 'deep') ? 'raise' : 'fold';
            } else if (suited && lo >= 2) {
                strength = 'marginal';
                action = btn && depth !== 'short' ? 'raise' : 'fold';
            } else {
                strength = 'weak';
                action = btn && lo >= 10 && depth === 'deep' ? 'raise' : 'fold';
            }
        } else if (hi === 12) {
            if (lo >= 11 && suited) { strength = 'strong'; action = 'raise'; }
            else if (lo >= 10 && suited) { strength = 'playable'; action = ep ? 'fold' : 'raise'; }
            else if (lo >= 11) { strength = 'playable'; action = ep || (co && depth === 'short') ? 'fold' : 'raise'; }
            else if (suited && lo >= 8) {
                strength = 'marginal';
                action = btn || (co && depth === 'deep') ? 'raise' : 'fold';
            } else { strength = 'weak'; action = 'fold'; }
        } else if (hi === 11) {
            if (lo >= 10 && suited) { strength = 'strong'; action = late || mp || sb ? 'raise' : 'fold'; }
            else if (lo >= 9 && suited) {
                strength = 'playable';
                action = btn || (co && depth === 'deep') ? 'raise' : 'fold';
            } else if (lo >= 10) {
                strength = 'marginal';
                action = btn && depth !== 'short' ? 'raise' : 'fold';
            } else if (suited && lo >= 7) {
                strength = 'marginal';
                action = btn && depth === 'deep' ? 'raise' : 'fold';
            } else { strength = 'weak'; action = 'fold'; }
        } else if (suited && gap <= 1 && lo >= 5) {
            strength = 'playable';
            if (btn) action = depth === 'short' ? 'fold' : 'raise';
            else if (co && lo >= 6 && depth !== 'short') action = 'raise';
            else if (sb && lo >= 7 && depth === 'deep') action = 'raise';
            else if (mp && lo >= 8 && depth === 'deep') action = 'raise';
            else action = 'fold';
        } else if (suited && gap <= 2 && lo >= 6) {
            strength = 'marginal';
            action = btn && depth === 'deep' ? 'raise' : 'fold';
        } else {
            strength = 'weak';
            action = 'fold';
        }

        if (depth === 'short' && action === 'raise' && strength === 'marginal' && !isPair && !(hi === 14 && lo >= 11)) {
            action = 'fold';
            strength = 'weak';
        }

        return { strength, action, suited, isPair, hi, lo, openerBucket: null };
    }


    // ── V7 pressure-aware preflop strategy ─────────────────────
    // Keep the old positional/opening evaluator as a tested baseline, then
    // modify continuation ranges using actual price, raise count and where the
    // aggression came from. These groups are deliberately explicit so the
    // calibration dataset can be audited and adjusted later.
    const V7_PREFLOP_GROUPS = {
        premium: new Set(['AA','KK','QQ','AKs','AKo']),
        strong: new Set(['JJ','TT','AQs','AQo','AJs','KQs']),
        playable: new Set(['99','88','AJo','ATs','KQo','KJs','QJs','JTs']),
        speculative: new Set([
            '77','66','55','44','33','22',
            'A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s',
            'KTs','K9s','QTs','Q9s','J9s','T9s','T8s','98s','97s',
            '87s','86s','76s','65s','54s'
        ])
    };

    function v7HandGroup(holeCards, baseline = null) {
        const hand = canonicalHand(holeCards);
        if (!hand) return 'weak';
        for (const key of ['premium','strong','playable','speculative']) {
            if (V7_PREFLOP_GROUPS[key].has(hand)) return key;
        }
        if (baseline?.strength === 'premium') return 'premium';
        if (baseline?.strength === 'strong') return 'strong';
        if (baseline?.strength === 'playable') return 'playable';
        if (baseline?.strength === 'marginal') return 'marginal';
        return 'weak';
    }

    function preflopOriginWeight(bucket) {
        if (bucket === 'EP') return 0.75;
        if (bucket === 'MP') return 0.35;
        if (bucket === 'Blind') return -0.20;
        return 0; // Late
    }

    function classifyPreflopPressure(meta = {}) {
        const raises = Number(meta.raiseCount || 0);
        const calls = Number(meta.callCount || 0);
        const target = Number.isFinite(meta.lastRaiseToBB)
            ? meta.lastRaiseToBB
            : (Number.isFinite(meta.highestBetBB) ? meta.highestBetBB : null);
        const cost = Number.isFinite(meta.costToContinueBB) ? meta.costToContinueBB : null;
        const openerBucket = meta.openerBucket || 'Late';
        const lastRaiserBucket = meta.lastRaiserBucket || openerBucket || 'Late';

        let bucket = 'unopened';
        let score = 0;

        if (raises === 0) {
            if (calls > 0) { bucket = 'limped'; score = 0.75; }
        } else if (raises === 1) {
            if (target == null) { bucket = 'open-medium'; score = 2; }
            else if (target <= 2.5) { bucket = 'open-small'; score = 1; }
            else if (target <= 4) { bucket = 'open-medium'; score = 2; }
            else if (target <= 7) { bucket = 'open-large'; score = 3; }
            else { bucket = 'open-huge'; score = 4; }
            score += preflopOriginWeight(openerBucket);
        } else if (raises === 2) {
            if (target == null) { bucket = '3bet-medium'; score = 5; }
            else if (target <= 6) { bucket = '3bet-small'; score = 4; }
            else if (target <= 10) { bucket = '3bet-medium'; score = 5; }
            else { bucket = '3bet-large'; score = 6; }
            score += preflopOriginWeight(openerBucket) * 0.4;
            score += preflopOriginWeight(lastRaiserBucket) * 0.7;
        } else {
            bucket = '4bet-plus';
            score = 7 + Math.max(0, raises - 3) * 0.5;
            score += preflopOriginWeight(openerBucket) * 0.3;
            score += preflopOriginWeight(lastRaiserBucket) * 0.7;
        }

        return {
            strategyVersion: PREFLOP_STRATEGY_VERSION,
            bucket,
            score: Math.round(score * 100) / 100,
            raiseCount: raises,
            callCount: calls,
            highestBetBB: Number.isFinite(meta.highestBetBB) ? meta.highestBetBB : null,
            heroCommittedBB: Number.isFinite(meta.heroCommittedBB) ? meta.heroCommittedBB : null,
            costToContinueBB: cost,
            openRaiseToBB: Number.isFinite(meta.openRaiseToBB) ? meta.openRaiseToBB : null,
            lastRaiseToBB: Number.isFinite(meta.lastRaiseToBB) ? meta.lastRaiseToBB : null,
            openerBucket,
            lastRaiserBucket
        };
    }

    function formatPreflopPressureLabel(p, compact = false) {
        if (!p) return 'Açılmamış';
        const fmt = n => Number.isFinite(n) && (!compact || n > 0.05)
            ? (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : String(Math.round(n * 10) / 10))
            : '';
        const cost = compact ? '' : fmt(p.costToContinueBB);
        const to = fmt(p.lastRaiseToBB || p.highestBetBB);
        const sep = compact ? ' ' : ' · ';
        if (p.bucket === 'unopened') return 'Açılmamış';
        if (p.bucket === 'limped') return `Limp${cost ? sep + cost + 'bb' : ''}`;
        if (p.bucket.startsWith('3bet') || p.bucket === '4bet-plus') {
            const who = p.lastRaiserBucket || p.openerBucket || 'Late';
            return `vs ${who} ${p.raiseCount >= 3 ? '4B+' : '3B'}${to ? sep + to + 'bb' : ''}`;
        }
        return `vs ${p.openerBucket || 'Late'}${to ? sep + to + 'bb' : ''}`;
    }

    function preflopPressureShortLabel(p) {
        return formatPreflopPressureLabel(p, false);
    }

    // The floating bubble is deliberately shorter than the full panel label.
    // Keep the exact sizing/pressure detail in the panel/title, while ensuring
    // the glanceable mobile badge never has to ellipsise useful information.
    function preflopPressureBubbleLabel(p) {
        return formatPreflopPressureLabel(p, true);
    }

    function v7LimpedDecision(holeCards, position, pressure, rfi) {
        const depth = resolveStackDepth().depth;
        const group = v7HandGroup(holeCards, rfi);
        const late = isLate(position);
        const blind = isBlind(position);
        const bb = position === 'BB';
        const cost = Number.isFinite(pressure.costToContinueBB) ? pressure.costToContinueBB : 1;
        const limpers = pressure.callCount || 0;

        // Free option in the BB: never recommend folding when checking costs 0.
        if (cost <= 0.05) {
            if (rfi?.action === 'raise' && ['premium','strong','playable'].includes(group)) {
                return { ...rfi, action: 'raise', pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
            }
            if (rfi?.action === 'raise' && group === 'speculative' && depth === 'deep' && limpers <= 2) {
                return { ...rfi, action: 'raise', pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
            }
            return { ...(rfi || {}), strength: rfi?.strength || 'weak', action: 'check', pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
        }

        if (group === 'premium' || group === 'strong') {
            return { ...(rfi || {}), strength: rfi?.strength || group, action: 'raise', pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
        }
        if (group === 'playable') {
            const act = limpers >= 3 && depth === 'deep' && (late || blind) ? 'call' : 'raise';
            return { ...(rfi || {}), strength: rfi?.strength || 'playable', action: act, pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
        }
        if (group === 'speculative') {
            const canOverlimp = depth === 'deep' && cost <= 1.05 && (late || blind || /^\d\d$/.test(canonicalHand(holeCards) || ''));
            return { ...(rfi || {}), strength: canOverlimp ? 'marginal' : 'weak', action: canOverlimp ? 'call' : 'fold', pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
        }
        if (group === 'marginal' && rfi?.action === 'raise' && late && depth !== 'short' && cost <= 1.05) {
            return { ...rfi, action: 'call', pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
        }
        return { ...(rfi || {}), strength: 'weak', action: 'fold', pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
    }

    function v7SingleRaiseDecision(holeCards, position, pressure, rfi, vsRaise) {
        const hand = canonicalHand(holeCards) || '';
        const depth = resolveStackDepth().depth;
        const group = v7HandGroup(holeCards, vsRaise || rfi);
        const score = Number(pressure.score || 0);
        const cost = Number.isFinite(pressure.costToContinueBB) ? pressure.costToContinueBB : null;
        const lateOrBlind = isLate(position) || isBlind(position);
        const openerLate = pressure.openerBucket === 'Late' || pressure.openerBucket === 'Blind';
        const result = { ...(vsRaise || { strength: 'weak', action: 'fold' }), pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };

        // Tiny opens are cheap enough to defend a little wider, especially IP/BB.
        if (score <= 1.65) {
            if (result.action === 'fold' && rfi?.action === 'raise' && depth !== 'short' && lateOrBlind && pressure.openerBucket !== 'EP') {
                if (['playable','speculative'].includes(group) && (cost == null || cost <= 2.5)) {
                    result.action = 'call';
                    result.strength = group === 'playable' ? 'playable' : 'marginal';
                }
            }
            return result;
        }

        // Standard 3–4bb opens use the proven V6 opponent-position ranges.
        if (score <= 2.8) return result;

        // Large opens remove bluff 3-bets and speculative flats quickly.
        if (score <= 3.9) {
            if (result.action === '3bet' && !['premium','strong'].includes(group)) {
                result.action = (lateOrBlind && openerLate && depth === 'deep' && (cost == null || cost <= 4.5)) ? 'call' : 'fold';
            }
            if (result.action === 'call') {
                if (group === 'marginal' || group === 'speculative') result.action = 'fold';
                else if (group === 'playable' && !(lateOrBlind && openerLate && (cost == null || cost <= 4.5))) result.action = 'fold';
            }
            return result;
        }

        // Very large opens: premiums re-raise; a narrow strong band may call
        // against late/blind aggression; everything else releases.
        if (group === 'premium') {
            result.action = '3bet';
            result.strength = 'premium';
            return result;
        }
        const hugeCall = new Set(['JJ','AQs','AQo']);
        if (hugeCall.has(hand) && openerLate && depth !== 'short' && (cost == null || cost <= 8)) {
            result.action = 'call';
            result.strength = 'strong';
            return result;
        }
        result.action = 'fold';
        result.strength = 'weak';
        return result;
    }

    function v7MultiRaiseDecision(holeCards, position, pressure, rfi, vsRaise) {
        const hand = canonicalHand(holeCards) || '';
        const depth = resolveStackDepth().depth;
        const group = v7HandGroup(holeCards, vsRaise || rfi);
        const score = Number(pressure.score || 0);
        const cost = Number.isFinite(pressure.costToContinueBB) ? pressure.costToContinueBB : null;
        const lastLate = pressure.lastRaiserBucket === 'Late' || pressure.lastRaiserBucket === 'Blind';
        const originalTight = pressure.openerBucket === 'EP';
        const lateOrBlind = isLate(position) || isBlind(position);

        if (group === 'premium') {
            return { ...(vsRaise || rfi || {}), strength: 'premium', action: '4bet', pressureAdjusted: true, pressureBucket: pressure.bucket, handGroup: group };
        }

        const smallCold3Call = new Set(['JJ','TT','99','AQs','AQo','AJs','KQs']);
        const mediumCold3Call = new Set(['JJ','TT','AQs','AQo']);
        const largeCold3Call = new Set(['JJ','AQs']);

        let allow = false;
        if (score <= 4.9 && smallCold3Call.has(hand)) {
            allow = depth !== 'short' && (lastLate || lateOrBlind) && !(originalTight && !['JJ','AQs','AQo'].includes(hand));
            if (cost != null && cost > 6.5) allow = false;
        } else if (score <= 5.9 && mediumCold3Call.has(hand)) {
            const lastReasonable = lastLate || pressure.lastRaiserBucket === 'MP';
            const maxCost = ['JJ','AQs'].includes(hand) ? 10 : 8;
            allow = depth !== 'short' && lastReasonable &&
                !(originalTight && !['JJ','AQs'].includes(hand)) &&
                (cost == null || cost <= maxCost);
        } else if (score <= 6.6 && largeCold3Call.has(hand)) {
            allow = depth === 'deep' && lastLate && (cost == null || cost <= 9);
        }

        return {
            ...(vsRaise || rfi || {}),
            strength: allow ? 'strong' : 'weak',
            action: allow ? 'call' : 'fold',
            pressureAdjusted: true,
            pressureBucket: pressure.bucket,
            handGroup: group
        };
    }

    function defaultPreflopPressure(facingRaise, openerBucket = 'Late') {
        const opener = openerBucket || 'Late';
        return classifyPreflopPressure({
            raiseCount: facingRaise ? 1 : 0,
            callCount: 0,
            openerBucket: opener,
            lastRaiserBucket: opener,
            lastRaiseToBB: facingRaise ? 3 : null,
            highestBetBB: facingRaise ? 3 : 1,
            heroCommittedBB: 0,
            costToContinueBB: facingRaise ? 3 : 1
        });
    }

    function applyPreflopRangeStyle(result, holeCards, position, pressure, rfi = null) {
        if (!result) return result;
        const style = currentPreflopRangeStyle();
        const out = { ...result, rangeStyle: style };
        if (style === 'balanced') return out;

        const hand = canonicalHand(holeCards) || '';
        const pos = String(position || 'MP').toUpperCase();
        const group = out.handGroup || v7HandGroup(holeCards, out);
        const raises = Number(pressure?.raiseCount || 0);
        const bucket = String(pressure?.bucket || 'unopened');
        const cost = Number.isFinite(pressure?.costToContinueBB)
            ? Number(pressure.costToContinueBB)
            : null;
        const score = Number(pressure?.score || 0);
        const lateOrBlind = isLate(position) || isBlind(position);
        const openerIsEarly = pressure?.openerBucket === 'EP';

        if (style === 'tight') {
            if (raises <= 0 && bucket === 'unopened' && out.action === 'raise') {
                if (PREFLOP_TIGHT_RFI_REMOVE[pos]?.has(hand)) {
                    return { ...out, action: 'fold', strength: 'marginal', rangeStyle: style, rangeStyleAdjusted: true };
                }
                return out;
            }

            if (raises <= 0 && bucket === 'limped') {
                if (cost != null && cost <= 0.05) return out; // keep the free BB option
                if (['speculative','marginal'].includes(group) && ['call','raise'].includes(out.action)) {
                    return { ...out, action: 'fold', strength: 'weak', rangeStyle: style, rangeStyleAdjusted: true };
                }
                return out;
            }

            if (raises === 1) {
                if (out.action === 'call' && ['speculative','marginal'].includes(group)) {
                    return { ...out, action: 'fold', strength: 'weak', rangeStyle: style, rangeStyleAdjusted: true };
                }
                if (out.action === '3bet' && !['premium','strong'].includes(group)) {
                    const canFlat = group === 'playable' && lateOrBlind &&
                        !openerIsEarly && (cost == null || cost <= 3.5);
                    return {
                        ...out,
                        action: canFlat ? 'call' : 'fold',
                        strength: canFlat ? 'playable' : 'weak',
                        rangeStyle: style,
                        rangeStyleAdjusted: true
                    };
                }
                return out;
            }

            if (raises >= 2 && out.action === 'call' && !['premium','strong'].includes(group)) {
                return { ...out, action: 'fold', strength: 'weak', rangeStyle: style, rangeStyleAdjusted: true };
            }
            return out;
        }

        if (style === 'wide') {
            // Wide: open selected extra hands and defend a little wider only when
            // the price/pressure is still modest. Never widen the high-pressure
            // multi-raise safety gates.
            if (raises <= 0 && bucket === 'unopened' && out.action === 'fold') {
                if (PREFLOP_WIDE_RFI_ADD[pos]?.has(hand)) {
                    return { ...out, action: 'raise', strength: 'marginal', rangeStyle: style, rangeStyleAdjusted: true };
                }
                return out;
            }

            if (raises <= 0 && bucket === 'limped' && out.action === 'fold') {
                const cheap = cost == null || cost <= 1.05;
                if (cheap && ['speculative','marginal'].includes(group) && lateOrBlind) {
                    return { ...out, action: 'call', strength: 'marginal', rangeStyle: style, rangeStyleAdjusted: true };
                }
                return out;
            }

            if (raises === 1 && out.action === 'fold') {
                const affordable = (cost == null || cost <= 3.5) && score <= 2.8 && !openerIsEarly;
                if (affordable && group === 'playable') {
                    return { ...out, action: 'call', strength: 'playable', rangeStyle: style, rangeStyleAdjusted: true };
                }
                if (affordable && group === 'speculative' && lateOrBlind) {
                    return { ...out, action: 'call', strength: 'marginal', rangeStyle: style, rangeStyleAdjusted: true };
                }
            }
            return out;
        }

        if (style === 'yo-momma') {
            // Yo Momma: extra-wide in low-pressure spots. It opens substantially
            // more hands, overlimps more cheaply, and defends a single modest
            // raise more often. Multiple raises retain the normal safety gates.
            if (raises <= 0 && bucket === 'unopened' && out.action === 'fold') {
                if (PREFLOP_YO_MOMMA_RFI_ADD[pos]?.has(hand)) {
                    return { ...out, action: 'raise', strength: 'marginal', rangeStyle: style, rangeStyleAdjusted: true };
                }
                return out;
            }

            if (raises <= 0 && bucket === 'limped' && out.action === 'fold') {
                const cheap = cost == null || cost <= 1.05;
                const listed = PREFLOP_YO_MOMMA_RFI_ADD[pos]?.has(hand);
                const positionOk = lateOrBlind || pos === 'MP';
                if (cheap && positionOk && (listed || ['playable','speculative','marginal'].includes(group))) {
                    return { ...out, action: 'call', strength: group === 'playable' ? 'playable' : 'marginal', rangeStyle: style, rangeStyleAdjusted: true };
                }
                return out;
            }

            if (raises === 1 && out.action === 'fold') {
                const affordable = (cost == null || cost <= 4.5) && score <= 3.2;
                const notEarlyOrVeryCheap = !openerIsEarly || (cost != null && cost <= 2.5);
                if (affordable && notEarlyOrVeryCheap && group === 'playable') {
                    return { ...out, action: 'call', strength: 'playable', rangeStyle: style, rangeStyleAdjusted: true };
                }
                if (affordable && !openerIsEarly && ['speculative','marginal'].includes(group) && lateOrBlind) {
                    return { ...out, action: 'call', strength: 'marginal', rangeStyle: style, rangeStyleAdjusted: true };
                }
            }
            return out;
        }

        return out;
    }

    function evalPreflopHand(holeCards, position, facingRaise, openerBucket, pressureMeta = null) {
        if (!holeCards || holeCards.length < 2) return null;
        const opener = openerBucket || pressureMeta?.openerBucket || 'Late';
        const rfi = evalPreflopHandBaseline(holeCards, position, false, opener);

        let pressure = pressureMeta;
        if (!pressure) {
            pressure = defaultPreflopPressure(facingRaise, opener);
        } else if (!pressure.bucket) {
            pressure = classifyPreflopPressure({ ...pressure, openerBucket: opener });
        }

        let result;
        if (pressure.raiseCount <= 0 && pressure.bucket === 'unopened') {
            result = { ...rfi, pressureAdjusted: false, pressureBucket: pressure.bucket, handGroup: v7HandGroup(holeCards, rfi) };
        } else if (pressure.raiseCount <= 0 && pressure.bucket === 'limped') {
            result = v7LimpedDecision(holeCards, position, pressure, rfi);
        } else {
            const vsRaise = evalPreflopHandBaseline(holeCards, position, true, opener);
            result = pressure.raiseCount === 1
                ? v7SingleRaiseDecision(holeCards, position, pressure, rfi, vsRaise)
                : v7MultiRaiseDecision(holeCards, position, pressure, rfi, vsRaise);
        }
        const styled = applyPreflopRangeStyle(result, holeCards, position, pressure, rfi);
        if (!styled) return styled;
        return {
            ...styled,
            balancedBaselineAction: result?.action || '',
            balancedBaselineStrength: result?.strength || '',
            rangeStyleAdjusted: !!styled.rangeStyleAdjusted ||
                String(styled.action || '') !== String(result?.action || '') ||
                String(styled.strength || '') !== String(result?.strength || '')
        };
    }

    function syntheticHoleFromCanonical(ch) {
        if (!ch || ch.length < 2) return null;
        const isPair = ch.length === 2;
        const suited = !isPair && ch.endsWith('s');
        const norm = r => (r === 'T' ? '10' : r);
        const r1 = norm(ch[0]);
        const r2 = norm(ch[1]);
        if (isPair) return [r1 + '♠', r2 + '♥'];
        return [r1 + '♠', r2 + (suited ? '♠' : '♥')];
    }

    function canonicalHand(cards) {
        if (!cards || cards.length < 2) return null;
        const order = RANK_ORDER;
        let rA = cards[0].slice(0, -1).replace('10', 'T');
        let rB = cards[1].slice(0, -1).replace('10', 'T');
        let sA = cards[0].slice(-1);
        let sB = cards[1].slice(-1);
        if (order.indexOf(rA) < order.indexOf(rB)) {
            [rA, rB] = [rB, rA];
            [sA, sB] = [sB, sA];
        }
        if (rA === rB) return rA + rB;
        return rA + rB + (sA === sB ? 's' : 'o');
    }

    function buildPositionRanges(position, facingRaise, openerBucket, pressureMeta = null) {
        const fourbet = [], threebet = [], raise = [], call = [], check = [], fold = [];
        const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
        const all = [];
        const op = openerBucket || 'Late';
        const pressure = pressureMeta || defaultPreflopPressure(facingRaise, op);

        for (let i = 0; i < ranks.length; i++) {
            for (let j = i; j < ranks.length; j++) {
                if (i === j) all.push(ranks[i] + ranks[j]);
                else {
                    all.push(ranks[i] + ranks[j] + 's');
                    all.push(ranks[i] + ranks[j] + 'o');
                }
            }
        }
        for (const ch of all) {
            const cards = syntheticHoleFromCanonical(ch);
            if (!cards) continue;
            const ev = evalPreflopHand(cards, position, !!facingRaise, op, pressure);
            if (!ev) { fold.push(ch); continue; }
            if (ev.action === '4bet') fourbet.push(ch);
            else if (ev.action === '3bet') threebet.push(ch);
            else if (ev.action === 'raise') raise.push(ch);
            else if (ev.action === 'call') call.push(ch);
            else if (ev.action === 'check') check.push(ch);
            else fold.push(ch);
        }
        return { fourbet, threebet, raise, call, check, fold };
    }

    // The current strategy uses the same explicit RFI matrix for mid/short until
    // a separate short-stack matrix is deliberately authored.
    PREFLOP_RANGE_TABLES.rfi.mid = PREFLOP_RANGE_TABLES.rfi.deep;
    PREFLOP_RANGE_TABLES.rfi.short = PREFLOP_RANGE_TABLES.rfi.deep;


    // ── DOM: hole cards, seats, position, facing raise ───────────

    function readOwnCardsFromDOM() {
        return readCardsFromSeatElement(getSelfSeatElement());
    }

    // ── Seat geometry (ported from Torn Poker HUD - uses playerPositioner-N) ──

    function heroHasPrivateHoleCards() {
        const cards = readOwnCardsFromDOM();
        return Array.isArray(cards) && cards.length === 2;
    }

    function readCardsFromSeatElement(seat) {
        if (!seat) return null;
        const cards = [];
        const suitMap = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
        const rankMap = { ace:'A', king:'K', queen:'Q', jack:'J', ten:'10',
            nine:'9', eight:'8', seven:'7', six:'6', five:'5', four:'4', three:'3', two:'2' };
        const addClass = cls => {
            const m = String(cls || '').match(/(spades|hearts|diamonds|clubs)-([a-z0-9]+)/i);
            if (!m) return;
            const suit = suitMap[m[1].toLowerCase()];
            const raw = m[2].toLowerCase();
            let rank = rankMap[raw] || '';
            if (!rank) {
                const up = raw.toUpperCase();
                if (/^(A|K|Q|J|10|[2-9])$/.test(up)) rank = up;
                else if (up === 'T') rank = '10';
            }
            if (suit && rank) cards.push(rank + suit);
        };
        const scan = el => {
            if (!el || !el.classList) return;
            for (const cls of el.classList) addClass(cls);
        };
        scan(seat);
        seat.querySelectorAll('*').forEach(scan);
        const unique = [...new Set(cards)];
        return unique.length >= 2 ? unique.slice(0, 2) : null;
    }

    function getSelfSeatId() {
        const marked = getSelfSeatElement();
        if (marked?.id) return marked.id.replace('player-', '');

        // Dynamic fallback: only the hero seat exposes the two private hole cards.
        try {
            for (const seat of document.querySelectorAll('[id^="player-"]')) {
                const cards = readCardsFromSeatElement(seat);
                if (cards && cards.length >= 2 && seat.id) return seat.id.replace('player-', '');
            }
        } catch (_) {}
        return null;
    }

    // Clockwise seat order from Torn's playerPositioner-N wrappers (same as HUD).
    function captureSeatOrder() {
        const posSlots = [];
        const seenIds = new Set();

        document.querySelectorAll('[class*="playerPositioner-"]').forEach(posDiv => {
            let posNum = null;
            for (const c of posDiv.classList) {
                const m = c.match(/playerPositioner-(\d+)___/);
                if (m) { posNum = parseInt(m[1], 10); break; }
            }
            if (posNum === null) return;
            const playerEl = posDiv.querySelector('[id^="player-"]');
            if (!playerEl) return;
            const seatId = playerEl.id.replace('player-', '');
            seenIds.add(seatId);
            posSlots.push({ posNum, seatId });
        });

        // Live captures show PDA renders Hero in a separate playerMeGateway rather
        // than a numbered playerPositioner. Treat that known shape as the bottom
        // self slot immediately; retain the ancestor scan as a desktop fallback.
        const selfEl = getSelfSeatElement();
        if (selfEl) {
            const seatId = selfEl.id.replace('player-', '');
            if (!seenIds.has(seatId)) {
                let posNum = selfEl.closest?.('[class*="playerMeGateway"]') ? -1 : null;
                let el = posNum === null ? selfEl.parentElement : null;
                while (el && el !== document.body) {
                    for (const c of el.classList) {
                        const m = c.match(/(?:playerPositioner|selfPositioner|positioner)[^_]*-(\d+)___/i);
                        if (m) { posNum = parseInt(m[1], 10); break; }
                    }
                    if (posNum !== null) break;
                    el = el.parentElement;
                }
                if (posNum === null) posNum = -1;
                posSlots.push({ posNum, seatId });
            }
        }

        posSlots.sort((a, b) => a.posNum - b.posNum);
        return posSlots.map(s => s.seatId);
    }

    // Dealer button: global [class*="dealer___"] with position-N___ or position-self___
    function getDealerSeatId() {
        const dealerEl = document.querySelector('[class*="dealer___"]');
        if (!dealerEl) return null;

        // Local player has the button
        if (dealerEl.className.split(/\s+/).some(c => c.startsWith('position-self___'))) {
            const selfEl = getSelfSeatElement();
            return selfEl ? selfEl.id.replace('player-', '') : null;
        }

        let dealerPosNum = null;
        for (const c of dealerEl.classList) {
            const m = c.match(/position-(\d+)___/);
            if (m) { dealerPosNum = parseInt(m[1], 10); break; }
        }
        if (dealerPosNum === null) return null;

        const posDiv = [...document.querySelectorAll('[class*="playerPositioner-"]')].find(el => {
            for (const c of el.classList) {
                if (c.match(new RegExp(`playerPositioner-${dealerPosNum}___`))) return true;
            }
            return false;
        });
        if (posDiv) {
            const playerEl = posDiv.querySelector('[id^="player-"]');
            return playerEl ? playerEl.id.replace('player-', '') : null;
        }
        // Non-standard self wrapper
        const selfEl = getSelfSeatElement();
        return selfEl ? selfEl.id.replace('player-', '') : null;
    }

    const _gameScopedCache = new Map();

    // ── V6 live engine ───────────────────────────────────────────
    // One DOM log capture -> one parsed frame -> one canonical state per Game ID.
    // Every consumer reads the same state. Completed hands are finalised later,
    // outside the first refresh of the next hand, to avoid transition spikes.
    const _v6Runtime = {
        frame: {
            at: 0,
            entries: [],
            lines: [],
            segments: [],
            byGameId: new Map(),
            currentGameId: '',
            currentSegment: null,
            signature: ''
        },
        games: new Map(),
        currentGameId: '',
        previousGameId: '',
        gameChangedAt: 0,
        finaliseTimers: new Map(),
        finalisedSignatures: new Map(),
        liveRecords: new Map(),
        refreshRunning: false,
        refreshQueued: false
    };

    let _liveLogSnapshot = {
        at: 0, lines: [], entries: [], gameId: '', gameLines: [], gameEntries: []
    };

    function refreshLiveLogSnapshot(force = false) {
        const now = Date.now();
        if (!force && _v6Runtime.frame.at && now - _v6Runtime.frame.at < 120) {
            return _liveLogSnapshot;
        }

        const entries = getTableLogEntries();
        const frame = buildV6LogFrame(entries);
        _v6Runtime.frame = frame;

        const current = frame.currentSegment;
        _liveLogSnapshot = {
            at: frame.at,
            lines: frame.lines,
            entries: frame.entries,
            gameId: frame.currentGameId,
            gameLines: current ? current.lines.slice() : [],
            gameEntries: current ? current.entries.slice() : []
        };

        if (frame.currentGameId && frame.currentGameId !== _v6Runtime.currentGameId) {
            _v6Runtime.previousGameId = _v6Runtime.currentGameId || '';
            _v6Runtime.currentGameId = frame.currentGameId;
            _v6Runtime.gameChangedAt = now;
            _equityCache = { key: '', value: null, at: 0 };
        }

        // Parse each visible Game-ID segment once per changed segment. Usually
        // only the current game changes; the completed prior game remains cached.
        for (const seg of frame.segments) ensureV6GameState(seg);
        trimV6GameCache();

        return _liveLogSnapshot;
    }

    function trimV6GameCache() {
        while (_v6Runtime.games.size > V6_HAND_CACHE_MAX) {
            const oldest = _v6Runtime.games.keys().next().value;
            if (oldest === _v6Runtime.currentGameId) break;
            _v6Runtime.games.delete(oldest);
            _gameScopedCache.delete(oldest);
        }
    }

    function currentV6GameState() {
        const gid = _v6Runtime.currentGameId || _v6Runtime.frame.currentGameId || '';
        return gid ? (_v6Runtime.games.get(gid) || null) : null;
    }


    // Global table-topology guard. Torn can remove/rebuild several seat nodes when
    // a player joins/leaves. During that brief transition, keep normal log/UI
    // refreshes running but do not launch fresh Monte Carlo work for each
    // intermediate seat layout.
    const _tableTopology = {
        signature: '',
        pendingSignature: '',
        pendingUntil: 0,
        settleTimer: null
    };

    // Deep-stack departure alerts. Snapshot players while seated so their
    // identity/stack survives Torn removing the seat DOM. Alerts are isolated
    // from the poker/equity model.
    let _departedSeatSnapshot = new Map();
    const _departureStackStates = new Map(); // playerId -> current-table departure-only stack state
    let _departureTableKey = '';
    let _departureHeroSeatRemovedAt = 0;
    let _departureTableResetPending = false;
    const _departedAlerted = new Map(); // tableKey:playerId -> last alert time
    let _departedHostHideTimer = null;
    let _departedAudioContext = null;
    const _debugDepartures = []; // debug-only, bounded recent departure observations

    function currentTableTopologySignature() {
        try {
            return [...document.querySelectorAll('[id^="player-"]')]
                .map(el => String(el.id || '').trim())
                .filter(Boolean)
                .sort()
                .join('|');
        } catch (_) {
            return '';
        }
    }

    function scheduleTopologySettleRefresh() {
        if (_tableTopology.settleTimer) clearTimeout(_tableTopology.settleTimer);
        const wait = Math.max(0, _tableTopology.pendingUntil - Date.now()) + 20;
        _tableTopology.settleTimer = setTimeout(() => {
            _tableTopology.settleTimer = null;
            try { runLiveRefreshCycle(); } catch (_) {}
        }, wait);
    }

    function tableTopologyIsStable() {
        const sig = currentTableTopologySignature();
        const now = Date.now();

        // First observation establishes the baseline without delaying play.
        if (!_tableTopology.signature && !_tableTopology.pendingSignature) {
            _tableTopology.signature = sig;
            return true;
        }

        // A new occupied-seat layout starts/restarts the short settle window.
        const reference = _tableTopology.pendingSignature || _tableTopology.signature;
        if (sig !== reference) {
            _tableTopology.pendingSignature = sig;
            _tableTopology.pendingUntil = now + TOPOLOGY_SETTLE_MS;
            scheduleTopologySettleRefresh();
            return false;
        }

        if (_tableTopology.pendingSignature) {
            if (now < _tableTopology.pendingUntil) return false;

            // Layout has remained unchanged for the full settle window.
            _tableTopology.signature = _tableTopology.pendingSignature;
            _tableTopology.pendingSignature = '';
            _tableTopology.pendingUntil = 0;

            // Confirm departures only after Torn's seat rebuild has settled.
            try { reconcileDepartedDeepStackPlayers(); } catch (e) {
                console.warn('[TPS] departed target reconcile', e);
            }
        }

        return true;
    }

    function gameScopedOnce(gameId, key, builder, shouldCache = (v) => v !== null && v !== undefined) {
        const gid = String(gameId || '');
        if (!gid) return builder();

        let bucket = _gameScopedCache.get(gid);
        if (!bucket) {
            bucket = Object.create(null);
            _gameScopedCache.set(gid, bucket);

            // Keep only a few recent games so long poker sessions cannot grow
            // this cache indefinitely.
            while (_gameScopedCache.size > 6) {
                const oldest = _gameScopedCache.keys().next().value;
                _gameScopedCache.delete(oldest);
            }
        }

        if (Object.prototype.hasOwnProperty.call(bucket, key)) return bucket[key];
        const value = builder();
        if (shouldCache(value)) bucket[key] = value;
        return value;
    }

    function getImmutableGameState(gameId) {
        const gid = String(gameId || '');
        if (!gid) return null;
        return gameScopedOnce(gid, 'immutableState', () => ({
            gameId: gid, heroName: '', heroSeatId: '', seatOrder: null,
            dealerSeatId: '', heroPosition: '', tableBB: null
        }));
    }

    function cacheGameField(gameId, field, builder, valid) {
        const state = getImmutableGameState(gameId);
        if (!state) return builder();
        const old = state[field];
        if (old !== '' && old !== null && old !== undefined) return old;
        const value = builder();
        if ((valid ? valid(value) : value != null && value !== '')) state[field] = value;
        return value;
    }

    function getBlindSeatIdsFromLogOnce(gameId) {
        return gameScopedOnce(gameId, 'blindSeatIds', () => {
            const out = { sbId: null, bbId: null };
            try {
                const nameMap = buildNameToSeatBucket();
                for (const line of getGameLogLines(gameId)) {
                    const m = String(line || '').match(/^(.+?)\s+posted\s+(small|big)\s+blind\b/i);
                    if (!m) continue;
                    const info = nameMap.get(m[1].trim().toLowerCase());
                    const id = info && info.seatId ? String(info.seatId) : null;
                    if (m[2].toLowerCase() === 'small') out.sbId = id;
                    else out.bbId = id;
                }
            } catch (_) {}
            return out;
        }, out => !!(out && (out.sbId || out.bbId)));
    }

    function getSelfGeometry() {
        const gameId = getCurrentGameId();
        const selfId = gameId ? cacheGameField(gameId, 'heroSeatId', getSelfSeatId, v => !!v) : getSelfSeatId();
        const order = gameId ? cacheGameField(gameId, 'seatOrder', captureSeatOrder, v => Array.isArray(v) && v.length >= 2) : captureSeatOrder();
        if (!selfId || !order || order.length < 2) return null;
        const total = order.length, myIdx = order.indexOf(String(selfId));
        if (myIdx === -1) return null;

        let dealerId = gameId ? cacheGameField(gameId, 'dealerSeatId', getDealerSeatId, v => !!v) : getDealerSeatId();
        let dealerIdx = dealerId ? order.indexOf(String(dealerId)) : -1;
        if (dealerIdx === -1 && gameId) {
            const blinds = getBlindSeatIdsFromLogOnce(gameId);
            const sbIdx = blinds.sbId ? order.indexOf(String(blinds.sbId)) : -1;
            if (sbIdx !== -1) dealerIdx = (sbIdx - 1 + total) % total;
            else {
                const bbIdx = blinds.bbId ? order.indexOf(String(blinds.bbId)) : -1;
                if (bbIdx !== -1) dealerIdx = (bbIdx - 2 + total) % total;
            }
            if (dealerIdx !== -1) {
                dealerId = order[dealerIdx];
                const state = getImmutableGameState(gameId);
                if (state && !state.dealerSeatId) state.dealerSeatId = dealerId;
            }
        }
        if (dealerIdx === -1) return null;
        return { dist: (myIdx - dealerIdx + total) % total, total, selfId, dealerId, order };
    }

    // Eval seat: EP / MP / CO / BTN / SB / BB
    function getSelfPositionBucket() {
        const geo = getSelfGeometry();
        if (!geo) return null;
        const { dist, total } = geo;
        if (total === 2) return dist === 0 ? 'SB' : 'BB';
        if (dist === 0) return 'BTN';
        if (dist === 1) return 'SB';
        if (dist === 2) return 'BB';
        if (total >= 5 && dist === total - 1) return 'CO';
        if (dist === 3 || dist === 4) return 'EP';
        return 'MP';
    }

    // Exact label: BTN, SB, BB, UTG, CO, HJ, …
    function getSelfExactPosition() {
        const gameId = getCurrentGameId();
        const compute = () => {
            const geo = getSelfGeometry();
            return geo ? exactLabelFromDist(geo.dist, geo.total) : null;
        };
        return gameId ? cacheGameField(gameId, 'heroPosition', compute, v => !!v) : compute();
    }

    function exactLabelFromDist(dist, total) {
        if (total === 2) return dist === 0 ? 'SB' : 'BB';
        if (dist === 0) return 'BTN';
        if (dist === 1) return 'SB';
        if (dist === 2) return 'BB';
        const mid = total - 3;
        const idx = dist - 3;
        if (idx === 0) return 'UTG';
        const late = ['CO', 'HJ', 'LJ'].slice(0, Math.max(0, Math.min(3, mid - 1)));
        const fromEnd = mid - 1 - idx;
        return fromEnd < late.length ? late[fromEnd] : ('UTG+' + idx);
    }

    function openerBucketFromSeat(exact) {
        if (!exact) return 'Late';
        if (exact === 'SB' || exact === 'BB') return 'Blind';
        if (exact === 'BTN' || exact === 'CO') return 'Late';
        if (exact === 'HJ' || exact === 'LJ' || exact === 'MP') return 'MP';
        return 'EP';
    }

    const SEAT_NAME_SELECTORS = Object.freeze([
        '[class*="name___"]',
        '[class*="userName"]',
        '[class*="playerName"]',
        '[class*="name"], [class*="Name"]'
    ]);
    function seatNameElement(el) {
        if (!el) return null;
        for (const selector of SEAT_NAME_SELECTORS) {
            const found = el.querySelector(selector);
            if (found) return found;
        }
        return null;
    }
    function nameFromSeatEl(el, maxLength = 32) {
        if (!el) return '';
        const nameEl = seatNameElement(el);
        let name = nameEl ? (nameEl.textContent || '').trim() : '';
        if (!name) {
            const a = el.querySelector('a[href*="XID="], a[href*="user2ID="]');
            if (a) name = (a.textContent || '').trim();
        }
        const clean = name.replace(/\s+/g, ' ');
        return Number.isFinite(maxLength) && maxLength > 0 ? clean.slice(0, maxLength) : clean;
    }

    function resolvePlayerIdentity(playerId, state = null) {
        const id = String(playerId || '').trim();
        if (!id) return { id: '', name: '', nameKey: '', source: 'none' };

        // Torn already exposes the logged-in player's exact ID/name in #torn-user.
        // Use that as the authoritative fast path for the local Hero.
        const pageHero = pageHeroIdentity(id);
        if (pageHero) return pageHero;

        // Opponent seats expose their visible name directly under #player-ID.
        try {
            const seatName = nameFromSeatEl(document.getElementById('player-' + id));
            if (seatName) {
                return { id, name: seatName, nameKey: normalisePlayerName(seatName), source: 'seat' };
            }
        } catch (_) {}

        const handState = state || currentV6GameState();
        if (handState?.players?.get) {
            const p = handState.players.get(id);
            if (p?.name) {
                const name = String(p.name).replace(/\s+/g, ' ').trim();
                return { id, name, nameKey: normalisePlayerName(name), source: 'hand-state' };
            }
        }

        if (handState?.entries?.length) {
            const e = handState.entries.find(x =>
                String(x?.actorId || '') === id && String(x?.actor || '').trim()
            );
            if (e?.actor) {
                const name = String(e.actor).replace(/\s+/g, ' ').trim();
                return { id, name, nameKey: normalisePlayerName(name), source: 'hand-log' };
            }
        }

        // Older/alternate Torn renders sometimes expose an identity script even
        // when the player is not currently represented by a normal seat name.
        try {
            const script = document.querySelector(`script[playerId="${id}"]`);
            const name = String(script?.getAttribute('playerName') || '').replace(/\s+/g, ' ').trim();
            if (name) return { id, name, nameKey: normalisePlayerName(name), source: 'player-script' };
        } catch (_) {}

        // Profile links are deliberately last-resort: the supplied live captures
        // prove they may be absent even while #player-ID and the name are present.
        try {
            const link = document.querySelector(
                `a[href*="XID=${id}"], a[href*="user2ID=${id}"]`
            );
            const name = String(link?.textContent || '').replace(/\s+/g, ' ').trim();
            if (name) return { id, name, nameKey: normalisePlayerName(name), source: 'profile-link' };
        } catch (_) {}

        return { id, name: '', nameKey: '', source: 'id-only' };
    }

    function resolveOwnerIdentity(state = null) {
        return resolvePlayerIdentity(REFERRER_PLAYER_ID, state);
    }

    function playerSeatNameElements(identity) {
        const out = [];
        const seen = new Set();
        if (!identity?.id) return out;

        const addExactSeatName = el => {
            if (!el || el.nodeType !== 1 || seen.has(el)) return;
            if (el.closest?.('#tps-panel, #tps-bubble, #tps-departed-alerts, #tps-debug-departures, #tps-table-insight-toast, #tps-poker-term-toast')) return;
            seen.add(el);
            out.push(el);
        };
        const addMatchingName = el => {
            if (!identity.nameKey || !el || el.nodeType !== 1 || seen.has(el)) return;
            if (el.closest?.('#tps-panel, #tps-bubble, #tps-departed-alerts, #tps-debug-departures, #tps-table-insight-toast, #tps-poker-term-toast')) return;
            const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (normalisePlayerName(text) !== identity.nameKey) return;
            seen.add(el);
            out.push(el);
        };

        try {
            // The player-ID wrapper is authoritative. For opponent seats we can
            // safely colour the dedicated Torn name element even when the helper's
            // display name has not yet been resolved into the hand-state cache.
            const seat = document.getElementById('player-' + identity.id);
            if (!seat) return out;
            addExactSeatName(seatNameElement(seat));

            // Hero/PDA layouts can render the name as a plain element rather than
            // name___. When we know the display name, match only inside this exact
            // player-ID seat so stack/position text cannot be coloured by mistake.
            if (!out.length || seat === getSelfSeatElement()) {
                seat.querySelectorAll('p, em, a, [class*="name"], [class*="Name"]').forEach(addMatchingName);
            }
        } catch (_) {}

        return out;
    }

    function pokerLogActorId(node, actorEl = null) {
        try {
            const links = [
                ...(actorEl?.querySelectorAll?.('a[href]') || []),
                ...(node?.querySelectorAll?.('a[href*="XID="], a[href*="user2ID="], a[href*="profiles.php"]') || [])
            ];
            for (const a of links) {
                const href = String(a.getAttribute?.('href') || a.href || '');
                const m = href.match(/(?:XID|user2ID)=(\d+)/i);
                if (m) return m[1];
            }
        } catch (_) {}
        return '';
    }

    function pokerLogActorElements(identity) {
        const out = [];
        if (!identity?.id) return out;
        try {
            for (const node of getPokerLogNodes()) {
                const actorEl = node.querySelector('em');
                if (!actorEl) continue;
                const actorId = pokerLogActorId(node, actorEl);
                const actorNameKey = normalisePlayerName(actorEl.textContent || '');
                const exactId = actorId && actorId === identity.id;
                const exactName = !!identity.nameKey && actorNameKey === identity.nameKey;
                if (exactId || exactName) out.push(actorEl);
            }
        } catch (_) {}
        return out;
    }

    function applyPlayerNameClass(identity, className) {
        // Seat colouring is ID-first. A resolved display name is useful for log
        // rows but is no longer required to colour an exact #player-ID seat.
        if (!identity?.id || !className) return 0;
        const seen = new Set();
        for (const el of [...playerSeatNameElements(identity), ...pokerLogActorElements(identity)]) {
            if (!el || seen.has(el)) continue;
            seen.add(el);
            el.classList.add(className);
        }
        return seen.size;
    }

    function applyOwnerRainbowEasterEgg() {
        const state = currentV6GameState();
        const identity = resolveOwnerIdentity(state);
        if (!identity.id) return 0;
        try {
            // Torn recycles React nodes. Clear an old mark before resolving the
            // current owner seat/log name so colour cannot stick to another player.
            document.querySelectorAll('.tps-owner-rainbow').forEach(el =>
                el.classList.remove('tps-owner-rainbow')
            );
            return applyPlayerNameClass(identity, 'tps-owner-rainbow');
        } catch (_) {
            return 0;
        }
    }

    function applyDevelopmentNameColours() {
        try {
            document.querySelectorAll('.tps-development-helper-gold').forEach(el =>
                el.classList.remove('tps-development-helper-gold')
            );
            document.querySelectorAll('.tps-hero-blue').forEach(el =>
                el.classList.remove('tps-hero-blue')
            );

            const ownerId = String(REFERRER_PLAYER_ID || '');
            const helperIds = new Set(DevelopmentHelpers.map(id => String(id)));
            const state = currentV6GameState();
            let marked = 0;

            for (const rawId of DevelopmentHelpers) {
                const id = String(rawId);
                if (!id || id === ownerId) continue;
                marked += applyPlayerNameClass(
                    resolvePlayerIdentity(id, state),
                    'tps-development-helper-gold'
                );
            }

            // The local Hero is blue only when they are neither owner nor helper.
            const page = getPageIdentity();
            const resolvedHero = state ? resolveV6HeroIdentity(state) : null;
            const heroId = String(
                resolvedHero?.id || getSelfSeatId() || state?.heroSeatId || page.id || ''
            );
            if (heroId && heroId !== ownerId && !helperIds.has(heroId)) {
                const heroIdentity = resolvedHero?.nameKey
                    ? {
                        id: heroId,
                        name: resolvedHero.name || '',
                        nameKey: resolvedHero.nameKey,
                        source: resolvedHero.source || 'hero-resolver'
                    }
                    : resolvePlayerIdentity(heroId, state);
                marked += applyPlayerNameClass(heroIdentity, 'tps-hero-blue');
            }

            return marked;
        } catch (_) {
            return 0;
        }
    }

    function tpsDomClassText(el) {
        if (!el) return '';
        try {
            if (typeof el.className === 'string') return el.className;
            return el.getAttribute?.('class') || '';
        } catch (_) { return ''; }
    }

    function tpsDomPath(el) {
        if (!el || el.nodeType !== 1) return '(none)';
        const parts = [];
        let cur = el;
        for (let depth = 0; cur && cur.nodeType === 1 && depth < 7; depth++, cur = cur.parentElement) {
            let bit = String(cur.tagName || '').toLowerCase();
            if (cur.id) bit += '#' + cur.id;
            const classes = tpsDomClassText(cur).split(/\s+/).filter(Boolean).slice(0, 3);
            if (classes.length) bit += '.' + classes.join('.');
            parts.unshift(bit);
            if (cur.id === 'react-root') break;
        }
        return parts.join(' > ');
    }

    function tpsCompactOuterHtml(el, maxLen = 1800) {
        if (!el) return '(none)';
        let html = '';
        try { html = String(el.outerHTML || ''); } catch (_) {}
        html = html.replace(/\s+/g, ' ').trim();
        return html.length > maxLen ? html.slice(0, maxLen) + ' …[truncated]' : html;
    }

    function ownerDomDiagnosticSnapshot() {
        const state = currentV6GameState();
        const identity = resolveOwnerIdentity(state);
        const pageIdentity = getPageIdentity();
        const resolved = state ? resolveV6HeroIdentity(state) : {};
        const ownerSeat = identity.id ? document.getElementById('player-' + identity.id) : null;
        const selfSeat = getSelfSeatElement();
        const candidates = [...playerSeatNameElements(identity), ...pokerLogActorElements(identity)];
        const table = (() => { try { return detectStandaloneTableContext(); } catch (_) { return null; } })();
        const preferredTableTextureNode = (() => {
            try {
                return document.querySelector(
                    '[class^="table___"], [class*=" table___"]'
                );
            } catch (_) { return null; }
        })();
        const renderedTextureKey = (() => { try { return getRenderedTableTextureKey(); } catch (_) { return ''; } })();

        const elementInfo = el => {
            if (!el) return null;
            let cs = null;
            let rect = null;
            try { cs = getComputedStyle(el); } catch (_) {}
            try { rect = el.getBoundingClientRect(); } catch (_) {}
            const positioner = el.closest?.(
                '[class*="selfPositioner"], [class*="playerPositioner-"], [class*="playerPositioner"], [class*="positioner"]'
            );
            const player = el.closest?.('[id^="player-"]');
            return {
                tag: String(el.tagName || ''),
                id: String(el.id || ''),
                className: tpsDomClassText(el),
                text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                path: tpsDomPath(el),
                closestPlayerId: String(player?.id || ''),
                positionerClass: tpsDomClassText(positioner),
                rainbowClass: el.classList?.contains('tps-owner-rainbow') || false,
                style: cs ? {
                    display: cs.display,
                    color: cs.color,
                    backgroundImage: cs.backgroundImage,
                    backgroundClip: cs.backgroundClip,
                    webkitBackgroundClip: cs.webkitBackgroundClip || '',
                    webkitTextFillColor: cs.webkitTextFillColor || '',
                    textShadow: cs.textShadow
                } : null,
                rect: rect ? {
                    x: Math.round(rect.x), y: Math.round(rect.y),
                    width: Math.round(rect.width), height: Math.round(rect.height)
                } : null,
                outerHTML: tpsCompactOuterHtml(el),
                parentHTML: tpsCompactOuterHtml(el.parentElement, 2200)
            };
        };

        const seats = [];
        try {
            document.querySelectorAll('[id^="player-"]').forEach(el => {
                if (seats.length >= 12) return;
                seats.push({
                    id: String(el.id || '').replace('player-', ''),
                    detectedName: resolvePlayerIdentity(String(el.id || '').replace('player-', ''), state).name,
                    path: tpsDomPath(el),
                    className: tpsDomClassText(el),
                    positionerClass: tpsDomClassText(el.closest?.(
                        '[class*="selfPositioner"], [class*="playerPositioner-"], [class*="playerPositioner"], [class*="positioner"]'
                    ))
                });
            });
        } catch (_) {}

        const actionControls = [];
        try {
            const root = document.getElementById('react-root') || document.body;
            root.querySelectorAll('button, [role="button"]').forEach(el => {
                if (actionControls.length >= 24) return;
                const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!/\b(check|call|fold|raise|bet|all[\s-]*in)\b/i.test(text)) return;
                actionControls.push({ text: text.slice(0, 100), path: tpsDomPath(el), className: tpsDomClassText(el) });
            });
        } catch (_) {}

        return {
            sidearmVersion: SIDEARM_VERSION,
            capturedAt: new Date().toISOString(),
            owner: identity,
            pageIdentity,
            hero: {
                currentSelfSeatId: String(getSelfSeatId() || ''),
                selfSeatPath: tpsDomPath(selfSeat),
                resolvedId: String(resolved?.id || ''),
                resolvedName: String(resolved?.name || ''),
                source: String(resolved?.source || state?.heroNameSource || ''),
                storedSeatId: String(state?.heroSeatId || '')
            },
            game: {
                gameId: String(state?.gameId || getCurrentGameId() || ''),
                street: String(state?.street || ''),
                tableKey: String(table?.key || ''),
                tableName: String(table?.name || ''),
                tableBB: Number.isFinite(table?.bb) ? table.bb : null,
                tableSource: String(table?.source || '')
            },
            tableDetection: {
                renderedTextureKey,
                observedTextureKey: _observedTableTextureKey,
                observedTextureAt: _observedTableTextureAt
                    ? new Date(_observedTableTextureAt).toISOString()
                    : '',
                preferredSelectorMatched: !!preferredTableTextureNode,
                preferredSelectorStyle: String(preferredTableTextureNode?.getAttribute?.('style') || '').slice(0, 500),
                preferredComputedBackground: (() => {
                    try { return String(getComputedStyle(preferredTableTextureNode)?.backgroundImage || '').slice(0, 700); }
                    catch (_) { return ''; }
                })(),
                preferredBeforeBackground: (() => {
                    try { return String(getComputedStyle(preferredTableTextureNode, '::before')?.backgroundImage || '').slice(0, 700); }
                    catch (_) { return ''; }
                })(),
                preferredAfterBackground: (() => {
                    try { return String(getComputedStyle(preferredTableTextureNode, '::after')?.backgroundImage || '').slice(0, 700); }
                    catch (_) { return ''; }
                })(),
                broadTextureNodeCount: (() => {
                    try { return document.querySelectorAll('[style*="tables_colour"]').length; }
                    catch (_) { return 0; }
                })()
            },
            support: {
                backgroundClipText: !!globalThis.CSS?.supports?.('background-clip', 'text'),
                webkitBackgroundClipText: !!globalThis.CSS?.supports?.('-webkit-background-clip', 'text'),
                viewport: `${window.innerWidth}x${window.innerHeight}`,
                dpr: window.devicePixelRatio || 1,
                userAgent: navigator.userAgent
            },
            selectorCounts: {
                playerNodes: document.querySelectorAll('[id^="player-"]').length,
                playerPositioners: document.querySelectorAll('[class*="playerPositioner"]').length,
                selfPositioners: document.querySelectorAll('[class*="selfPositioner"], [class*="self___"]').length,
                ownerProfileLinks: identity.id ? document.querySelectorAll(
                    `a[href*="XID=${identity.id}"], a[href*="user2ID=${identity.id}"]`
                ).length : 0,
                ownerNameCandidates: candidates.length,
                rainbowMarked: document.querySelectorAll('.tps-owner-rainbow').length
            },
            ownerSeat: elementInfo(ownerSeat),
            selfSeat: elementInfo(selfSeat),
            nameCandidates: candidates.slice(0, 8).map(elementInfo),
            seats,
            actionControls
        };
    }

    function ownerDomDiagnosticText() {
        const snap = ownerDomDiagnosticSnapshot();
        return 'Torn Poker Sidearm - DOM diagnostic\n' + JSON.stringify(snap, null, 2);
    }

    function buildNameToSeatBucket() {
        const map = new Map();
        const state = currentV6GameState();

        if (state?.players?.size && state.seatOrder?.length >= 2 && state.dealerSeatId) {
            const total = state.seatOrder.length;
            const dealerIdx = state.seatOrder.indexOf(String(state.dealerSeatId));
            if (dealerIdx >= 0) {
                for (const p of state.players.values()) {
                    if (!p.nameKey) continue;
                    const idx = state.seatOrder.indexOf(String(p.id));
                    if (idx < 0) continue;
                    const dist = (idx - dealerIdx + total) % total;
                    const exact = exactLabelFromDist(dist, total);
                    map.set(p.nameKey, { exact, bucket: openerBucketFromSeat(exact), seatId: p.id });
                }
                if (map.size) return map;
            }
        }

        // DOM fallback for the brief period before the hand snapshot has dealer/order.
        const order = captureSeatOrder();
        const dealerId = getDealerSeatId();
        const dealerIdx = dealerId ? order.indexOf(String(dealerId)) : -1;
        if (dealerIdx < 0 || order.length < 2) return map;

        for (let i = 0; i < order.length; i++) {
            const id = order[i];
            const el = document.getElementById('player-' + id);
            const name = nameFromSeatEl(el);
            if (!name) continue;
            const exact = exactLabelFromDist((i - dealerIdx + order.length) % order.length, order.length);
            map.set(normalisePlayerName(name), { exact, bucket: openerBucketFromSeat(exact), seatId: id });
        }
        return map;
    }


    /** Leaf action-log lines only (avoid parent nodes that concatenate every child). */
    function getPokerLogNodes() {
        const primary = [...document.querySelectorAll('[class*="message___"]')]
            .filter(el => !el.querySelector('[class*="message___"]'));
        if (primary.length) return primary.slice(-V6_LOG_ROW_LIMIT);

        return [...document.querySelectorAll(
            '[class*="logList"] li, [class*="log"] li, [class*="logList"] [class*="message"]'
        )].slice(-V6_LOG_ROW_LIMIT);
    }

    function pokerLogBodyText(node) {
        if (!node) return '';

        // HUD-style split: actor comes from <em>; action/body comes from the
        // remaining row. Avoid cloneNode(), which was unnecessarily expensive
        // during hand transitions.
        const actorEl = node.querySelector('em');
        const parts = [];
        for (const child of node.childNodes) {
            if (child === actorEl) continue;
            const tx = String(child.textContent || '').replace(/\s+/g, ' ').trim();
            if (tx) parts.push(tx);
        }
        let body = parts.join(' ').replace(/\s+/g, ' ').trim();

        if (!body) {
            const span = node.querySelector('span');
            body = String(span?.textContent || '').replace(/\s+/g, ' ').trim();
        }

        const actor = String(actorEl?.textContent || '').replace(/\s+/g, ' ').trim();
        if (actor && body.toLowerCase().startsWith(actor.toLowerCase() + ' ')) {
            body = body.slice(actor.length).trim();
        }
        return body;
    }

    function getTableLogEntries() {
        const out = [];
        for (const node of getPokerLogNodes()) {
            const actorEl = node.querySelector('em');
            const actor = String(actorEl?.textContent || '')
                .replace(/\s+/g, ' ').trim();
            const body = pokerLogBodyText(node);

            let actorId = '';
            const links = [
                ...(actorEl?.querySelectorAll?.('a[href]') || []),
                ...node.querySelectorAll('a[href*="XID="], a[href*="user2ID="], a[href*="profiles.php"]')
            ];
            for (const a of links) {
                const href = String(a.getAttribute('href') || a.href || '');
                const m = href.match(/(?:XID|user2ID)=(\d+)/i);
                if (m) {
                    actorId = m[1];
                    break;
                }
            }

            let line = actor && body ? `${actor} ${body}` : (actor || body);
            line = String(line || '').replace(/\s+/g, ' ').trim();
            if (!line || line.length > 320) continue;

            out.push({ actor, actorId, body, line });
        }
        return out;
    }


    function buildV6LogFrame(entries) {
        const list = Array.isArray(entries) ? entries : [];
        const lines = list.map(e => e.line);
        const segments = [];
        let seg = null;

        for (const entry of list) {
            const gid = extractGameId(entry.line);
            if (gid) {
                seg = { gameId: gid, entries: [entry], lines: [entry.line] };
                segments.push(seg);
                continue;
            }
            if (seg) {
                seg.entries.push(entry);
                seg.lines.push(entry.line);
            }
        }

        const keptSegments = segments.slice(-V6_HAND_CACHE_MAX);
        const byGameId = new Map();
        for (const s of keptSegments) {
            s.signature = `${s.entries.length}|${s.entries.length ? s.entries[s.entries.length - 1].line : ''}`;
            byGameId.set(s.gameId, s);
        }
        const currentSegment = keptSegments.length ? keptSegments[keptSegments.length - 1] : null;
        return {
            at: Date.now(),
            entries: list,
            lines,
            segments: keptSegments,
            byGameId,
            currentGameId: currentSegment ? currentSegment.gameId : '',
            currentSegment,
            signature: `${list.length}|${list.length ? list[list.length - 1].line : ''}`
        };
    }

    function extractGameId(line) {
        const s = String(line || '');
        // Torn log identity: "***Game*** bdccdddf2a146a2b8b6df85afb6ddb started"
        const m = s.match(/\*{0,3}\s*Game\s*\*{0,3}\s+([a-f0-9]{16,64})\s+started\b/i);
        return m ? m[1].toLowerCase() : '';
    }

    function getCurrentGameLogLines() {
        const snap = refreshLiveLogSnapshot();
        return snap.gameLines.slice();
    }

    function getCurrentGameId() {
        refreshLiveLogSnapshot();
        return _v6Runtime.frame.currentGameId || '';
    }

    function getGameLogLinesFromList(gameId, list) {
        const wanted = String(gameId || '').toLowerCase();
        if (!wanted || !Array.isArray(list)) return [];
        let start = -1, end = list.length;
        for (let i = 0; i < list.length; i++) {
            const id = extractGameId(list[i]);
            if (!id) continue;
            if (id === wanted) { start = i; continue; }
            if (start >= 0) { end = i; break; }
        }
        return start >= 0 ? list.slice(start, end) : [];
    }

    function getGameLogLines(gameId) {
        const gid = String(gameId || '').toLowerCase();
        if (!gid) return [];
        refreshLiveLogSnapshot();

        const cachedState = _v6Runtime.games.get(gid);
        if (cachedState && cachedState.lines && cachedState.lines.length) return cachedState.lines.slice();

        const seg = _v6Runtime.frame.byGameId.get(gid);
        if (seg) return seg.lines.slice();

        return getGameLogLinesFromList(gid, _v6Runtime.frame.lines);
    }

    /** Parse money: "$55", "55", "5.5 BB", "10bb" */
    function parseLogAmount(text) {
        if (!text) return { cash: null, bb: null };
        const s = String(text).trim();

        const bbM = s.match(/([\d,]+(?:\.\d+)?)\s*bb\b/i);
        if (bbM) {
            const n = parseFloat(bbM[1].replace(/,/g, ''));
            return { cash: null, bb: Number.isFinite(n) ? n : null };
        }

        // parseCashLoose handles both full dollar amounts and Torn's K/M/B
        // abbreviations. Function declarations are hoisted, so it is safe here.
        const cash = parseCashLoose(s);
        return {
            cash: Number.isFinite(cash) ? cash : null,
            bb: null
        };
    }

    function logAmountToBB(text, tableBBInfo) {
        const p = parseLogAmount(text);
        if (p.bb != null && Number.isFinite(p.bb)) return p.bb;
        if (p.cash != null && Number.isFinite(p.cash) && tableBBInfo?.unit === 'cash' && Number(tableBBInfo.amount) > 0) {
            return p.cash / Number(tableBBInfo.amount);
        }
        return null;
    }

    /** Table BB from "posted big blind $10" */
    function detectBBFromLog() {
        const state = currentV6GameState();

        if (state?.bbInfo?.unit === 'cash' && state.bbInfo.amount > 0) {
            return { ...state.bbInfo, source: 'log-cash' };
        }

        const table = state?.tableContext || detectStandaloneTableContext();
        if (Number.isFinite(table?.bb) && table.bb > 0) {
            return { amount: table.bb, unit: 'cash', source: table.source || 'table-context' };
        }

        if (state?.bbInfo?.amount > 0) return { ...state.bbInfo, source: 'log-bb' };

        const domBB = detectCashBBFromVisibleSourcesUncached();
        return domBB && domBB > 0
            ? { amount: domBB, unit: 'cash', source: 'visible-cash-bb' }
            : null;
    }

    function amountToBbToken(amountStr, tableBBInfo) {
        const p = parseLogAmount(amountStr);
        const fmt = n => Math.abs(n - Math.round(n)) < 0.12
            ? String(Math.round(n))
            : String(Math.round(n * 10) / 10);

        // Already stored/displayed by Torn in BB: preserve as BB.
        if (p.bb != null && p.bb >= 0) return fmt(p.bb);

        // Cash actions are converted using this game's detected cash big blind.
        if (p.cash != null && p.cash >= 0 &&
            tableBBInfo && tableBBInfo.unit === 'cash' &&
            Number(tableBBInfo.amount) > 0) {
            return fmt(p.cash / Number(tableBBInfo.amount));
        }

        // Do not emit a dollar amount pretending it is BB.
        return '';
    }

    const HERO_NAME_KEY = 'tornPokerSidearm_heroName';
    const HERO_ID_KEY = 'tornPokerSidearm_heroId';


    function rememberHeroIdentity(playerId, name) {
        const id = String(playerId || '').trim();
        const n = String(name || '').trim().replace(/\s+/g, ' ');
        if (!/^\d+$/.test(id) || !n) return '';
        try {
            localStorage.setItem(HERO_ID_KEY, id);
            localStorage.setItem(HERO_NAME_KEY, n);
        } catch (_) {}
        return n;
    }

    function getRememberedHeroName() {
        try { return String(localStorage.getItem(HERO_NAME_KEY) || '').trim(); }
        catch (_) { return ''; }
    }

    function getRememberedHeroNameForId(playerId) {
        const id = String(playerId || '').trim();
        if (!/^\d+$/.test(id)) return '';
        try {
            const storedId = String(localStorage.getItem(HERO_ID_KEY) || '').trim();
            if (storedId !== id) return '';
            return String(localStorage.getItem(HERO_NAME_KEY) || '').trim();
        } catch (_) {
            return '';
        }
    }

    function getHeroName() {
        const state = currentV6GameState();
        const allowLiveDom = !state || liveDomMatchesGameTable(state);
        const selfId = String((allowLiveDom ? getSelfSeatId() : '') || state?.heroSeatId || '');
        const pageHero = allowLiveDom ? pageHeroIdentity(selfId) : null;

        if (pageHero) {
            return rememberHeroIdentity(selfId, pageHero.name);
        }

        if (state?.heroName &&
            ['page-identity', 'log/self-id', 'self-link/id', 'revealed-card-match', 'id-bound-memory']
                .includes(state.heroNameSource)) {
            return state.heroName;
        }

        const selfEl = allowLiveDom && selfId ? document.getElementById('player-' + selfId) : null;
        if (selfEl && selfId) {
            const exact = exactNameForPlayerIdFromElement(selfEl, selfId);
            if (exact) return rememberHeroIdentity(selfId, exact);
        }

        const remembered = getRememberedHeroNameForId(selfId);
        if (remembered) return remembered;

        return selfId ? '' : getRememberedHeroName();
    }


    function isHeroActor(who) {
        const norm = s => String(s || '')
            .replace(/\[[^\]]*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        const actor = norm(who);
        const hero = norm(getHeroName());
        return !!actor && !!hero && actor === hero;
    }

    function namesMatch(a, b) {
        if (!a || !b) return false;
        const x = String(a).toLowerCase().trim();
        const y = String(b).toLowerCase().trim();
        if (x === y) return true;
        if (x.startsWith(y) || y.startsWith(x)) return true;
        const strip = s => s.replace(/\[.*?\]/g, '').replace(/^-+|-+$/g, '').trim();
        const sx = strip(x);
        const sy = strip(y);
        if (sx && sy && (sx === sy || sx.startsWith(sy) || sy.startsWith(sx))) return true;
        const tx = sx.split(/\s+/)[0];
        const ty = sy.split(/\s+/)[0];
        return !!(tx && ty && (tx === ty || tx.startsWith(ty) || ty.startsWith(tx)));
    }

    function detectPreflopAction(allowLiveDom = true) {
        const state = currentV6GameState();
        if (!state) {
            const pressure = classifyPreflopPressure({
                raiseCount: 0, callCount: 0, openerBucket: 'Late', lastRaiserBucket: 'Late'
            });
            return {
                gameId: getCurrentGameId(), facingRaise: false, openerBucket: 'Late',
                lastRaiserBucket: 'Late', openerSeat: '', lastRaiserSeat: '',
                raiseCount: 0, callCount: 0, foldCount: 0,
                openerName: '', lastRaiserName: '', openerMatched: false, lastRaiserMatched: false,
                heroName: getHeroName(), pressure
            };
        }

        const frozenDecision = state.preflopDecision || null;
        const liveDecision = state.preflopLiveDecision || null;
        const liveReopened = !!(
            liveDecision?.reopenedAfterHero &&
            Number.isFinite(liveDecision?.costToContinueBB) &&
            liveDecision.costToContinueBB > 0.05
        );
        const d = (liveReopened ? liveDecision : frozenDecision) || {
            raiseCount: state.opponentRaiseCount || 0,
            callCount: 0,
            foldCount: 0,
            openerName: state.firstOpponentRaiser || '',
            lastRaiserName: state.lastOpponentRaiser || '',
            highestBetBB: null,
            heroCommittedBB: null,
            costToContinueBB: null,
            openRaiseToBB: null,
            lastRaiseToBB: null,
            reopenedAfterHero: false
        };

        const findSeatInfo = name => {
            const target = normalisePlayerName(name || '');
            if (!target) return { exact: '', bucket: 'Late', matched: false };
            const info = preflopSeatInfoForName(name, state);
            if (info.exact || info.bucket) {
                return { exact: info.exact || '', bucket: info.bucket || 'Late', matched: true };
            }
            if (!allowLiveDom) return { exact: '', bucket: 'Late', matched: false };
            return { exact: '', bucket: 'Late', matched: false };
        };

        const openerName = d.openerName || '';
        const lastRaiserName = d.lastRaiserName || '';
        const openerInfo = findSeatInfo(openerName);
        const lastInfo = findSeatInfo(lastRaiserName);
        const openerBucket = openerName ? openerInfo.bucket : 'Late';
        const lastRaiserBucket = lastRaiserName ? lastInfo.bucket : openerBucket;

        const pressure = classifyPreflopPressure({
            raiseCount: d.raiseCount || 0,
            callCount: d.callCount || 0,
            highestBetBB: d.highestBetBB,
            heroCommittedBB: d.heroCommittedBB,
            costToContinueBB: d.costToContinueBB,
            openRaiseToBB: d.openRaiseToBB,
            lastRaiseToBB: d.lastRaiseToBB,
            openerBucket,
            lastRaiserBucket
        });

        return {
            gameId: state.gameId,
            facingRaise: (d.raiseCount || 0) > 0,
            openerBucket,
            lastRaiserBucket,
            openerSeat: openerInfo.exact || '',
            lastRaiserSeat: lastInfo.exact || '',
            raiseCount: d.raiseCount || 0,
            callCount: d.callCount || 0,
            foldCount: d.foldCount || 0,
            openerName,
            lastRaiserName,
            openerMatched: !!openerInfo.matched,
            lastRaiserMatched: !!lastInfo.matched,
            heroName: state.heroName || (allowLiveDom ? getHeroName() : ''),
            heroActed: !!d.heroActed,
            reopenedAfterHero: !!d.reopenedAfterHero,
            actualAction: d.actualAction || '',
            sequenceBeforeHero: Array.isArray(d.sequenceBeforeHero) ? d.sequenceBeforeHero.slice() : [],
            pressure
        };
    }


    // ── Postflop equity (weighted villain range Monte Carlo) ─────

    const SUIT_CHARS = ['♠', '♥', '♦', '♣'];
    const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const RANK_NUM = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };

    function parseCardFromClass(cls) {
        if (!cls || typeof cls !== 'string') return null;
        // spades-ace___ / hearts-10___ / diamonds-J style (Torn + FlopMaster-ish)
        let m = cls.match(/(spades|hearts|diamonds|clubs)-(ace|king|queen|jack|ten|10|[2-9aAtTjJqQkK])(?:___|_|\b|$)/i);
        if (!m) {
            m = cls.match(/(spades|hearts|diamonds|clubs)-(\w+)/i);
        }
        if (!m) return null;
        const suitMap = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
        const rankMap = {
            ace: 'A', a: 'A', king: 'K', k: 'K', queen: 'Q', q: 'Q',
            jack: 'J', j: 'J', ten: 'T', '10': 'T', t: 'T',
            '2': '2', '3': '3', '4': '4', '5': '5', '6': '6',
            '7': '7', '8': '8', '9': '9',
        };
        const suit = suitMap[m[1].toLowerCase()];
        const raw = String(m[2]).toLowerCase();
        const rank = rankMap[raw] || rankMap[m[2]] || null;
        if (!suit || !rank || !RANK_NUM[rank]) return null;
        return rank + suit; // always T not 10
    }

    function cardsFromElement(el) {
        const found = [];
        if (!el) return found;
        const visit = (node) => {
            if (!node || !node.classList) return;
            for (const cls of node.classList) {
                const c = parseCardFromClass(cls);
                if (c) found.push(c);
            }
        };
        visit(el);
        el.querySelectorAll('*').forEach(visit);
        return found;
    }

    function uniqueCards(list) {
        const seen = new Set();
        const out = [];
        for (const c of list || []) {
            const k = normalizeCardKey(c);
            if (!k || seen.has(k)) continue;
            if (!RANK_NUM[k.slice(0, -1)]) continue;
            seen.add(k);
            out.push(k.slice(0, -1) + k.slice(-1));
            if (out.length >= 7) break;
        }
        return out;
    }

    function cardRankNum(card) {
        const r = normalizeCardKey(card).slice(0, -1);
        return RANK_NUM[r] || 0;
    }
    function cardSuitChar(card) {
        return normalizeCardKey(card).slice(-1);
    }
    function normalizeCardKey(card) {
        if (!card) return '';
        let s = String(card);
        // already rank+suit
        let rank = s.slice(0, -1).replace(/10/i, 'T').toUpperCase();
        if (rank === '1') rank = 'A';
        const suit = s.slice(-1);
        if (!RANK_NUM[rank]) return '';
        if (!SUIT_CHARS.includes(suit)) return '';
        return rank + suit;
    }

    function buildFullDeck() {
        const d = [];
        for (const r of RANK_CHARS) for (const s of SUIT_CHARS) d.push(r + s);
        return d;
    }

    function rankFive(cards5) {
        const ranks = cards5.map(cardRankNum).sort((a, b) => b - a);
        if (ranks.some(r => !r)) return [0, 0, 0, 0, 0, 0];
        const suits = cards5.map(cardSuitChar);
        const isFlush = suits.every(s => s === suits[0]);
        const uniq = [...new Set(ranks)];
        let isStraight = false;
        let straightHigh = 0;
        if (uniq.length === 5) {
            if (ranks[0] - ranks[4] === 4) {
                isStraight = true;
                straightHigh = ranks[0];
            } else if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
                isStraight = true;
                straightHigh = 5;
            }
        }
        const counts = {};
        ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
        const byCount = Object.keys(counts).map(Number).sort((a, b) => {
            if (counts[b] !== counts[a]) return counts[b] - counts[a];
            return b - a;
        });

        if (isStraight && isFlush) return [8, straightHigh];
        if (counts[byCount[0]] === 4) {
            const k = byCount.find(r => counts[r] === 1) || 0;
            return [7, byCount[0], k];
        }
        if (counts[byCount[0]] === 3 && byCount.length > 1 && counts[byCount[1]] === 2) {
            return [6, byCount[0], byCount[1]];
        }
        if (isFlush) return [5, ...ranks];
        if (isStraight) return [4, straightHigh];
        if (counts[byCount[0]] === 3) {
            const kick = ranks.filter(r => r !== byCount[0]);
            return [3, byCount[0], ...kick];
        }
        if (counts[byCount[0]] === 2 && byCount.length > 1 && counts[byCount[1]] === 2) {
            const hp = Math.max(byCount[0], byCount[1]);
            const lp = Math.min(byCount[0], byCount[1]);
            const k = byCount.find(r => counts[r] === 1) || 0;
            return [2, hp, lp, k];
        }
        if (counts[byCount[0]] === 2) {
            const kick = ranks.filter(r => r !== byCount[0]);
            return [1, byCount[0], ...kick];
        }
        return [0, ...ranks];
    }

    function compareRankVectors(a, b) {
        if (!a || !b) return 0;
        const n = Math.max(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const x = a[i] || 0, y = b[i] || 0;
            if (x !== y) return x > y ? 1 : -1;
        }
        return 0;
    }

    function bestRankFromSeven(cards) {
        const list = uniqueCards(cards);
        if (list.length < 5) return null;
        if (list.length === 5) return rankFive(list);
        let best = null;
        const n = list.length;
        const idx = [];
        function rec(start, need) {
            if (need === 0) {
                const hand = idx.map(i => list[i]);
                const r = rankFive(hand);
                if (!best || compareRankVectors(r, best) > 0) best = r;
                return;
            }
            for (let i = start; i <= n - need; i++) {
                idx.push(i);
                rec(i + 1, need - 1);
                idx.pop();
            }
        }
        rec(0, 5);
        return best;
    }

    const HAND_CAT_NAMES = [
        'High card', 'Pair', 'Two pair', 'Three of a kind',
        'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'
    ];

    function describeMadeHand(holeCards, board) {
        const all = uniqueCards([...(holeCards || []), ...(board || [])]);
        if (all.length < 5) return all.length ? 'On the board…' : 'Waiting for board';
        const r = bestRankFromSeven(all);
        if (!r) return 'Unknown';

        // Keep every existing category unchanged except One Pair.
        if (r[0] !== 1) return HAND_CAT_NAMES[r[0]] || 'Unknown';

        const hole = uniqueCards(holeCards || []);
        const brd = uniqueCards(board || []);
        const pairRank = r[1] || 0;
        const boardRanks = brd.map(cardRankNum).filter(Boolean).sort((x, y) => y - x);
        const boardMax = boardRanks.length ? boardRanks[0] : 0;
        const holeRanks = new Set(hole.map(cardRankNum));

        const pocketPair = hole.length >= 2 && cardRankNum(hole[0]) === cardRankNum(hole[1]);
        const overpair = pocketPair && pairRank > boardMax;
        const topPair = pairRank === boardMax && holeRanks.has(pairRank);

        if (overpair) return 'High pair · overpair';
        if (topPair) return 'High pair · top pair';
        if (pairRank >= 11) return 'High pair';
        if (pairRank >= 7) return 'Mid pair';
        return 'Low pair';
    }

    function preflopComboWeight(cards, villainBucket, preflopRaises) {
        const cls = canonicalHand(cards);
        if (!cls) return 0.05;

        const m = cls.match(/^([AKQJT2-9])([AKQJT2-9])([so])?$/);
        if (!m) return 0.08;
        const rv = r => RANK_NUM[r] || 0;
        const a = rv(m[1]), b = rv(m[2]);
        const hi = Math.max(a, b), lo = Math.min(a, b);
        const pair = a === b;
        const suited = m[3] === 's';
        const gap = pair ? 0 : hi - lo;

        // Approximate positional starting ranges. This is deliberately continuous
        // weighting rather than a hard "in/out" range so unusual Torn play remains possible.
        let w = 0.05;
        if (pair) {
            w = hi >= 11 ? 1.00 : hi >= 8 ? 0.82 : hi >= 5 ? 0.58 : 0.38;
        } else if (hi === 14) {
            w = lo >= 12 ? 1.00 : lo >= 10 ? 0.78 : suited && lo >= 5 ? 0.55 : suited ? 0.38 : 0.16;
        } else if (hi === 13) {
            w = lo >= 11 ? 0.88 : lo >= 10 ? 0.62 : suited && lo >= 8 ? 0.38 : 0.12;
        } else if (hi === 12) {
            w = lo >= 10 ? 0.72 : suited && lo >= 8 ? 0.34 : 0.10;
        } else if (hi === 11) {
            w = lo >= 10 ? 0.66 : suited && lo >= 8 ? 0.32 : 0.09;
        } else if (suited && gap <= 2 && hi >= 7) {
            w = 0.34;
        } else if (gap <= 1 && hi >= 9) {
            w = 0.18;
        }

        // Earlier seats are tighter; late/blind ranges retain more marginal combos.
        const bucket = villainBucket || 'Late';
        if (bucket === 'EP') {
            if (w < 0.35) w *= 0.18;
            else if (w < 0.60) w *= 0.45;
            else w *= 0.90;
        } else if (bucket === 'MP') {
            if (w < 0.25) w *= 0.40;
            else if (w < 0.55) w *= 0.72;
        } else if (bucket === 'Blind') {
            w *= 0.90;
        }

        // Multiple preflop raises strongly favour the upper end, without declaring
        // weaker/bluff combinations impossible.
        const raises = Number(preflopRaises || 0);
        if (raises >= 2) {
            if (w >= 0.80) w *= 1.20;
            else if (w >= 0.50) w *= 0.62;
            else w *= 0.22;
        } else if (raises === 1) {
            if (w < 0.20) w *= 0.55;
        }

        return Math.max(0.005, w);
    }

    function drawPotential(cards, board) {
        const all = uniqueCards([...(cards || []), ...(board || [])]);
        const suitCounts = {};
        all.forEach(c => {
            const s = cardSuitChar(c);
            suitCounts[s] = (suitCounts[s] || 0) + 1;
        });
        const flushDraw = Object.values(suitCounts).some(n => n === 4);

        const ranks = [...new Set(all.map(cardRankNum).filter(Boolean))];
        if (ranks.includes(14)) ranks.push(1);
        ranks.sort((a, b) => a - b);
        let straightDraw = false;
        for (let low = 1; low <= 10; low++) {
            let have = 0;
            for (let r = low; r < low + 5; r++) if (ranks.includes(r)) have++;
            if (have === 4) { straightDraw = true; break; }
        }
        return { flushDraw, straightDraw, strongDraw: flushDraw || straightDraw };
    }

    function normalisePlayerName(name) {
        return String(name || '')
            .replace(/\[[^\]]*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function seatContainerForPlayer(el) {
        if (!el) return null;
        return el.closest('[class*="playerPositioner-"]') ||
            el.closest('[class*="playerPositioner"]') ||
            el.parentElement ||
            el;
    }

    function seatMatchesState(el, textPattern, classPattern, stateSelector, stateTextPattern = textPattern) {
        if (!el) return false;
        const seat = seatContainerForPlayer(el);
        const nodes = [el, seat].filter(Boolean);

        for (const node of nodes) {
            const cls = String(node.className || '');
            const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
            if (textPattern?.test(text)) return true;
            if (classPattern?.test(cls)) return true;

            const stateEl = node.querySelector?.(stateSelector);
            if (stateEl && stateTextPattern?.test(String(stateEl.textContent || ''))) return true;
        }
        return false;
    }

    function seatIsSittingOut(el) {
        return seatMatchesState(
            el,
            /\bsitting\s*out\b/i,
            /sitOut|sittingOut|sit-out/i,
            '[class^="state___"], [class*="state___"], [class*="sitOut"], [class*="sittingOut"]'
        );
    }

    function seatIsWaitingForBB(el) {
        // Torn renders players who are seated but not participating in the
        // current hand as "Waiting BB". They must not be treated as villains
        // merely because a player-* seat exists.
        return seatMatchesState(
            el,
            /\bwaiting\s+(?:for\s+)?bb\b/i,
            /waiting(?:For)?BB|wait(?:ing)?[-_]?bb/i,
            '[class^="state___"], [class*="state___"], [class*="waiting"], [class*="wait"]'
        );
    }

    function captureHandSeatSnapshot(gameId, existing = null) {
        const heroId = String(getSelfSeatId() || '');
        const pageHero = getPageIdentity();
        const heroRemembered = normalisePlayerName(getRememberedHeroName());
        const players = existing?.players instanceof Map ? existing.players : new Map();

        const roots = [...document.querySelectorAll('[class*="playerPositioner-"], [class*="playerPositioner"]')];
        const selfEl = getSelfSeatElement();
        if (selfEl && !roots.some(r => r === selfEl || r.contains?.(selfEl))) roots.push(selfEl);
        if (!roots.length) roots.push(...document.querySelectorAll('[id^="player-"]'));

        for (const root of roots) {
            const el = root.matches?.('[id^="player-"]') ? root : root.querySelector?.('[id^="player-"]');
            if (!el) continue;
            const idm = String(el.id || '').match(/^player-(\d+)$/);
            if (!idm) continue;

            const id = idm[1];
            const liveHeroName = heroId && id === heroId && pageHero.id === id ? pageHero.name : '';
            const name = liveHeroName || nameFromSeatEl(el) || '';
            const nameKey = normalisePlayerName(name);
            const isHero =
                (!!heroId && id === heroId) ||
                !!el.closest('[class*="self___"], [class*="selfPositioner"], [class*="Self"]') ||
                (/self/i.test(String(el.className || '')) && !!heroId && id === heroId) ||
                (!!heroRemembered && !!nameKey && nameKey === heroRemembered);

            const old = players.get(id) || {
                id, name: '', nameKey: '', isHero: false,
                sittingOutAtStart: false, sittingOutNow: false,
                waitingBBAtStart: false, waitingBBNow: false,
                initialStackBB: null
            };
            if (name && !old.name) { old.name = name; old.nameKey = nameKey; }
            old.isHero = isHero || (!!heroId && id === heroId);
            const sit = seatIsSittingOut(el);
            const waitingBB = seatIsWaitingForBB(el);
            old.sittingOutNow = sit;
            old.waitingBBNow = waitingBB;
            if (!existing || !existing.seatSnapshotFrozen) {
                old.sittingOutAtStart = old.sittingOutAtStart || sit;
                old.waitingBBAtStart = old.waitingBBAtStart || waitingBB;
            }

            try {
                const raw = readSeatStackRaw(el);
                if (raw && old.initialStackBB == null) {
                    const bb = currentV6GameState()?.bbInfo;
                    if (raw.kind === 'bb') old.initialStackBB = raw.value;
                    else if (raw.kind === 'cash' && bb?.unit === 'cash' && bb.amount > 0)
                        old.initialStackBB = raw.value / bb.amount;
                }
            } catch (_) {}
            players.set(id, old);
        }

        const order = captureSeatOrder();
        const dealerSeatId = getDealerSeatId() || '';
        return { players, seatOrder: order, dealerSeatId, heroSeatId: heroId };
    }

    function refreshHandSittingOutState(state) {
        if (!state?.players) return;
        for (const p of state.players.values()) {
            const el = document.getElementById('player-' + p.id);
            if (el) {
                p.sittingOutNow = seatIsSittingOut(el);
                p.waitingBBNow = seatIsWaitingForBB(el);
            }
        }
    }

    function parseCardsFromLogText(text) {
        const out = [];
        const re = /(10|[2-9TJQKA])\s*([♠♥♦♣])/gi;
        let m;
        while ((m = re.exec(String(text || '')))) {
            out.push(m[1].toUpperCase().replace('T', '10') + m[2]);
        }
        return uniqueCards(out).slice(0, 5);
    }

    function rememberRevealedHand(state, actor, cards, actorId = '', source = 'reveal') {
        if (!state || !(state.revealedHands instanceof Map)) return [];
        const key = normalisePlayerName(actor);
        const shown = uniqueCards(cards || []).slice(0, 2);
        if (!key || shown.length !== 2) return [];

        const previous = state.revealedHands.get(key);
        const sources = new Set(
            [previous?.source, source]
                .filter(Boolean)
                .flatMap(s => String(s).split('+'))
        );

        state.revealedHands.set(key, {
            name: String(actor || previous?.name || key).trim(),
            cards: shown,
            actorId: String(actorId || previous?.actorId || ''),
            source: [...sources].join('+')
        });
        return shown;
    }

    function parseAwardDetails(actor, body, line = '', actorId = '') {
        const text = String(body || '').trim();
        const m = text.match(
            /^(?:won|wins|collected)(?:\s+the\s+pot(?:\s+of)?)?\s*\(?(\$?\s*[\d,]+(?:\.\d+)?(?:\s*BB|\s*[KMB])?)\)?(.*)$/i
        );
        if (!m || !String(actor || '').trim()) return null;

        const parsed = parseLogAmount(m[1]);
        const amount = parsed.bb != null ? parsed.bb : parsed.cash;
        const unit = parsed.bb != null ? 'bb' : (parsed.cash != null ? 'cash' : '');
        const tail = String(m[2] || '').trim();

        const withCards = tail.match(/\bwith\s+\[([^\]]+)\]/i);
        const cards = withCards ? parseCardsFromLogText(withCards[1]).slice(0, 2) : [];
        const didNotShow = /\bdid\s+not\s+show(?:\s+hand)?\b/i.test(tail);

        return {
            winner: String(actor).trim(),
            amount: Number.isFinite(amount) ? amount : null,
            unit,
            cards: cards.length === 2 ? cards : [],
            didNotShow,
            actorId: String(actorId || ''),
            line: String(line || '').trim()
        };
    }

    function applyGameLogToHandState(state, lines, entriesOverride = null) {
        if (!state) return state;
        const entries = Array.isArray(entriesOverride) && entriesOverride.length
            ? entriesOverride
            : (Array.isArray(lines) ? lines : []).map(line => ({
                actor: '', actorId: '', body: String(line || ''), line: String(line || '')
            }));

        state.lines = Array.isArray(lines) ? lines.slice() : entries.map(e => e.line);
        state.entries = entries.slice();

        state.street = 'preflop';
        state.board = []; state.flop = []; state.turn = null; state.river = null;
        state.sbInfo = null; state.bbInfo = null;
        state.foldedNames = new Set();
        state.actionActorNames = new Set();
        state.heroFolded = false;
        state.heroActions = { preflop: [], flop: [], turn: [], river: [] };
        state.villainProfiles = new Map();
        state.latestVillainAction = null;
        state.opponentRaiseCount = 0;
        state.firstOpponentRaiser = '';
        state.lastOpponentRaiser = '';
        state.preflopEvents = [];
        state.preflopDecision = null;
        state.preflopLiveDecision = null;
        state.awards = [];
        state.resultSignature = '';
        state.revealedHeroCards = [];
        state.revealedHands = new Map(); // normalised name -> {name,cards,actorId}
        state.hasNonBlindAction = false;

        const resolvedHero = resolveV6HeroIdentity(state);
        const heroName = resolvedHero.name || getRememberedHeroName() || '';
        let heroKey = resolvedHero.nameKey || normalisePlayerName(heroName);
        const heroPlayer = [...(state.players?.values?.() || [])].find(p =>
            p.isHero || (resolvedHero.id && String(p.id) === String(resolvedHero.id))
        );
        if (!heroKey && heroPlayer?.nameKey) heroKey = heroPlayer.nameKey;
        state.heroName = resolvedHero.name || heroPlayer?.name || heroName || state.heroName || '';

        const byName = new Map();
        for (const p of (state.players?.values?.() || [])) {
            if (p.nameKey) byName.set(p.nameKey, p);
        }

        const checkedThisStreet = new Set();
        let street = 'preflop';

        // These counters deliberately stop at the hero's FIRST voluntary
        // preflop action. They describe the decision Sidearm actually advised,
        // rather than later raises/calls which happen after hero has acted.
        let heroActedPreflop = false;
        let raisesBeforeHero = 0;
        let callsBeforeHero = 0;
        const foldsBeforeHero = new Set();
        let firstRaiserBeforeHero = '';
        let lastRaiserBeforeHero = '';
        const sequenceBeforeHero = [];

        // V8 live preflop pressure continues after Hero's first action. The
        // frozen first-decision snapshot is still kept separately for clean
        // calibration, but the live bubble must react if betting is reopened.
        let liveRaiseCount = 0;
        let liveCallCount = 0;
        const liveFolded = new Set();
        let liveFirstRaiser = '';
        let liveLastRaiser = '';
        const liveSequence = [];

        // Preflop commitment ledger continues through the whole street so a
        // later raise/shove can calculate Hero's new price accurately.
        const preflopCommittedBB = new Map();
        let openRaiseToBB = null;
        let lastRaiseToBB = null;

        const currentPreflopHighestBB = () => {
            let high = 0;
            for (const value of preflopCommittedBB.values()) {
                if (Number.isFinite(value)) high = Math.max(high, value);
            }
            return high || null;
        };

        const preflopMoneySnapshot = () => {
            const heroCommittedBB = heroKey && Number.isFinite(preflopCommittedBB.get(heroKey))
                ? preflopCommittedBB.get(heroKey)
                : 0;
            const highestBetBB = currentPreflopHighestBB();
            return {
                highestBetBB,
                heroCommittedBB,
                costToContinueBB: Number.isFinite(highestBetBB)
                    ? Math.max(0, highestBetBB - heroCommittedBB)
                    : null,
                openRaiseToBB,
                lastRaiseToBB
            };
        };

        const applyPreflopCommitment = (actorKey, verb, rest) => {
            if (!actorKey) return;
            const current = Number.isFinite(preflopCommittedBB.get(actorKey))
                ? preflopCommittedBB.get(actorKey)
                : 0;

            if (verb === 'called') {
                const m = String(rest || '').match(/(\$?[\d,.]+(?:\.\d+)?(?:\s*BB)?)/i);
                const delta = m ? logAmountToBB(m[1], state.bbInfo) : null;
                if (Number.isFinite(delta)) preflopCommittedBB.set(actorKey, current + delta);
                return;
            }

            if (verb === 'raised' || verb === 'bet' || verb === 'bets') {
                const toM = String(rest || '').match(/\bto\s+(\$?[\d,.]+(?:\.\d+)?(?:\s*BB)?)/i);
                const am = String(rest || '').match(/(\$?[\d,.]+(?:\.\d+)?(?:\s*BB)?)/i);
                if (toM) {
                    const target = logAmountToBB(toM[1], state.bbInfo);
                    if (Number.isFinite(target)) {
                        preflopCommittedBB.set(actorKey, target);
                        if (openRaiseToBB == null) openRaiseToBB = target;
                        lastRaiseToBB = target;
                    }
                } else if (am) {
                    const delta = logAmountToBB(am[1], state.bbInfo);
                    if (Number.isFinite(delta)) {
                        const target = current + delta;
                        preflopCommittedBB.set(actorKey, target);
                        if (verb === 'raised') {
                            if (openRaiseToBB == null) openRaiseToBB = target;
                            lastRaiseToBB = target;
                        }
                    }
                }
            }
        };

        const getProfile = actor => {
            const key = normalisePlayerName(actor);
            if (!key || (heroKey && key === heroKey)) return null;
            let p = state.villainProfiles.get(key);
            if (!p) {
                p = {
                    name: String(actor || '').trim(),
                    folded: false,
                    preflopRaises: 0,
                    preflopCalls: 0,
                    checks: 0,
                    calls: 0,
                    bets: 0,
                    raises: 0,
                    checkRaises: 0,
                    streetAggression: { flop: 0, turn: 0, river: 0 },
                    sizeBuckets: [],
                    rawBetAmounts: [],
                    lastAction: '',
                    lastStreet: 'preflop',
                    lastAmount: null
                };
                state.villainProfiles.set(key, p);
            }
            return p;
        };

        for (const entry of entries) {
            const actor = String(entry?.actor || '').replace(/\s+/g, ' ').trim();
            const body = String(entry?.body || '').replace(/\s+/g, ' ').trim();
            const line = String(entry?.line || (actor && body ? actor + ' ' + body : actor || body))
                .replace(/\s+/g, ' ').trim();
            const actorKey = normalisePlayerName(actor);

            const markerText = `${actor} ${body}`.trim();
            if (/^the preflop\b/i.test(markerText)) {
                street = 'preflop'; state.street = street; checkedThisStreet.clear(); continue;
            }
            if (/^the flop\b/i.test(markerText)) {
                street = 'flop'; state.street = street; checkedThisStreet.clear();
                const c = parseCardsFromLogText(markerText);
                if (c.length >= 3) { state.flop = c.slice(-3); state.board = state.flop.slice(); }
                continue;
            }
            if (/^the turn\b/i.test(markerText)) {
                street = 'turn'; state.street = street; checkedThisStreet.clear();
                const c = parseCardsFromLogText(markerText);
                if (c.length) {
                    state.turn = c[c.length - 1];
                    state.board = uniqueCards([...state.flop, state.turn]).slice(0, 4);
                }
                continue;
            }
            if (/^the river\b/i.test(markerText)) {
                street = 'river'; state.street = street; checkedThisStreet.clear();
                const c = parseCardsFromLogText(markerText);
                if (c.length) {
                    state.river = c[c.length - 1];
                    state.board = uniqueCards([...state.flop, state.turn, state.river]).slice(0, 5);
                }
                continue;
            }

            const blind = body.match(/^posted\s+(small|big)\s+blind\s+(.+)$/i);
            if (blind) {
                if (actorKey) state.actionActorNames.add(actorKey);
                const info = parseLogAmount(blind[2]);
                const parsed = info.bb != null && info.bb > 0
                    ? { amount: info.bb, unit: 'bb' }
                    : (info.cash != null && info.cash > 0 ? { amount: info.cash, unit: 'cash' } : null);
                if (blind[1].toLowerCase() === 'small') {
                    state.sbInfo = parsed;
                    if (actorKey) preflopCommittedBB.set(actorKey, 0.5);
                } else {
                    state.bbInfo = parsed;
                    if (actorKey) preflopCommittedBB.set(actorKey, 1);
                }
                continue;
            }

            const action = body.match(/^(checked|called|folded|bets?|bet|raised)\b(.*)$/i);
            if (action && actorKey) {
                state.actionActorNames.add(actorKey);
                state.hasNonBlindAction = true;
                const verb = action[1].toLowerCase();
                const rest = action[2] || '';
                const player = byName.get(actorKey);

                if (street === 'preflop') {
                    const event = {
                        actor, actorKey, actorId: String(entry?.actorId || ''),
                        verb, body, line
                    };
                    state.preflopEvents.push(event);

                    // Track the whole preflop betting sequence for LIVE advice.
                    // This deliberately includes Hero's earlier raises so a later
                    // villain re-raise is correctly classified as a 3-bet/4-bet.
                    liveSequence.push(`${actor}:${body}`);
                    if (verb === 'raised') {
                        liveRaiseCount++;
                        if (!liveFirstRaiser) liveFirstRaiser = actor;
                        liveLastRaiser = actor;
                    } else if (verb === 'called') {
                        liveCallCount++;
                    } else if (verb === 'folded') {
                        liveFolded.add(actorKey);
                    }

                    const isHeroActor = !!heroKey && actorKey === heroKey;
                    if (isHeroActor && !heroActedPreflop) {
                        const money = preflopMoneySnapshot();
                        state.preflopDecision = {
                            heroActed: true,
                            actualAction: verb,
                            actualBody: body,
                            raiseCount: raisesBeforeHero,
                            callCount: callsBeforeHero,
                            foldCount: foldsBeforeHero.size,
                            foldedBeforeHero: [...foldsBeforeHero],
                            openerName: firstRaiserBeforeHero,
                            lastRaiserName: lastRaiserBeforeHero,
                            sequenceBeforeHero: sequenceBeforeHero.slice(),
                            ...money
                        };
                        heroActedPreflop = true;
                    } else if (!heroActedPreflop && !isHeroActor) {
                        sequenceBeforeHero.push(`${actor}:${body}`);
                        if (verb === 'raised') {
                            raisesBeforeHero++;
                            if (!firstRaiserBeforeHero) firstRaiserBeforeHero = actor;
                            lastRaiserBeforeHero = actor;
                        } else if (verb === 'called') {
                            callsBeforeHero++;
                        } else if (verb === 'folded') {
                            foldsBeforeHero.add(actorKey);
                        }
                    }

                    // Apply the action after the Hero snapshot so cost-to-continue
                    // describes the price immediately before Hero acted.
                    applyPreflopCommitment(actorKey, verb, rest);
                }

                if (verb === 'folded') {
                    if (heroKey && actorKey === heroKey) {
                        state.heroFolded = true;
                        // Fold is part of Hero's compact action string just like
                        // check/call/raise. Record it before the early continue.
                        state.heroActions[street].push('F');
                    } else {
                        state.foldedNames.add(actorKey);
                        const vp = getProfile(actor);
                        if (vp) { vp.folded = true; vp.lastAction = 'folded'; vp.lastStreet = street; }
                    }
                    continue;
                }

                if (heroKey && actorKey === heroKey) {
                    let token = '';
                    if (verb === 'checked') token = 'X';
                    else if (verb === 'called') {
                        const am = rest.match(/(\$?[\d,.]+(?:\.\d+)?(?:\s*bb)?)/i);
                        const tok = am ? amountToBbToken(am[1], state.bbInfo) : '';
                        token = tok ? 'C' + tok : 'C';
                    } else if (verb === 'raised' || verb === 'bet' || verb === 'bets') {
                        const toM = rest.match(/\bto\s+(\$?[\d,.]+(?:\.\d+)?(?:\s*bb)?)/i);
                        const am = rest.match(/(\$?[\d,.]+(?:\.\d+)?(?:\s*bb)?)/i);
                        const raw = toM?.[1] || am?.[1] || '';
                        const tok = raw ? amountToBbToken(raw, state.bbInfo) : '';
                        token = tok ? 'R' + tok : 'R';
                    }
                    if (token) state.heroActions[street].push(token);
                    continue;
                }

                const vp = getProfile(actor);
                if (!vp) continue;
                vp.lastAction = verb;
                vp.lastStreet = street;

                if (street === 'preflop') {
                    if (verb === 'raised') {
                        vp.preflopRaises++;
                        state.opponentRaiseCount++;
                        if (!state.firstOpponentRaiser) state.firstOpponentRaiser = actor;
                        state.lastOpponentRaiser = actor;
                    } else if (verb === 'called') vp.preflopCalls++;
                } else if (verb === 'checked') {
                    vp.checks++;
                    checkedThisStreet.add(actorKey);
                    state.latestVillainAction = { who: actor, verb, amount: null, street };
                } else if (verb === 'called') {
                    vp.calls++;
                    const am = rest.match(/(\$?[\d,.]+(?:\.\d+)?(?:\s*[KMB])?)/i);
                    const amount = am ? parseCashLoose(am[1]) : null;
                    vp.lastAmount = amount;
                    state.latestVillainAction = { who: actor, verb, amount, street };
                } else if (verb === 'raised' || verb === 'bet' || verb === 'bets') {
                    if (verb === 'raised') vp.raises++; else vp.bets++;
                    if (checkedThisStreet.has(actorKey)) vp.checkRaises++;
                    if (vp.streetAggression[street] != null) vp.streetAggression[street]++;

                    const toM = rest.match(/\bto\s+\$?([\d,]+(?:\.\d+)?(?:\s*[KMB])?)/i);
                    const am = rest.match(/\$?([\d,]+(?:\.\d+)?(?:\s*[KMB])?)/i);
                    const amount = toM ? parseCashLoose(toM[1]) : (am ? parseCashLoose(am[1]) : null);
                    vp.lastAmount = amount;
                    if (Number.isFinite(amount)) vp.rawBetAmounts.push(amount);
                    state.latestVillainAction = { who: actor, verb, amount, street };
                }
            }

            const reveal = body.match(/^(?:reveals?|shows?|showed)\s+\[?(.+?)\]?$/i);
            if (reveal && actorKey) {
                const shown = rememberRevealedHand(
                    state,
                    actor,
                    parseCardsFromLogText(reveal[1]),
                    entry?.actorId || '',
                    'reveal'
                );
                if (heroKey && actorKey === heroKey && shown.length === 2) {
                    state.revealedHeroCards = shown.slice();
                }
            }

            const award = parseAwardDetails(actor, body, line, entry?.actorId || '');
            if (award) {
                state.awards.push(award);

                // Torn commonly puts the winning hole cards only on the award
                // line ("won X BB/$ with [..]") rather than a separate reveal.
                if (award.cards.length === 2) {
                    const shown = rememberRevealedHand(
                        state, actor, award.cards, award.actorId, 'award'
                    );
                    if (heroKey && actorKey === heroKey && shown.length === 2) {
                        state.revealedHeroCards = shown.slice();
                    }
                }
            }
        }

        // If a player took an action, they were dealt in; do not leave them
        // excluded just because Torn briefly marked their seat as sitting out.
        for (const key of state.actionActorNames) {
            const p = byName.get(key);
            if (p && key !== heroKey && !state.foldedNames.has(key)) p.sittingOutNow = false;
        }

        if (!state.preflopDecision) {
            const money = preflopMoneySnapshot();
            state.preflopDecision = {
                heroActed: false,
                actualAction: '',
                actualBody: '',
                raiseCount: raisesBeforeHero,
                callCount: callsBeforeHero,
                foldCount: foldsBeforeHero.size,
                foldedBeforeHero: [...foldsBeforeHero],
                openerName: firstRaiserBeforeHero,
                lastRaiserName: lastRaiserBeforeHero,
                sequenceBeforeHero: sequenceBeforeHero.slice(),
                ...money
            };
        }

        // Current, unfrozen preflop state. If Hero has already acted and a later
        // raise creates a positive price to continue, detectPreflopAction() uses
        // this instead of the frozen first-decision snapshot.
        {
            const money = preflopMoneySnapshot();
            state.preflopLiveDecision = {
                heroActed: heroActedPreflop,
                actualAction: state.preflopDecision?.actualAction || '',
                actualBody: state.preflopDecision?.actualBody || '',
                raiseCount: liveRaiseCount,
                callCount: liveCallCount,
                foldCount: liveFolded.size,
                foldedBeforeHero: [...liveFolded],
                openerName: liveFirstRaiser,
                lastRaiserName: liveLastRaiser,
                sequenceBeforeHero: liveSequence.slice(),
                reopenedAfterHero: !!heroActedPreflop && Number.isFinite(money.costToContinueBB) && money.costToContinueBB > 0.05,
                ...money
            };
        }

        state.resultSignature = resultStateSignature(state.awards, state.revealedHands);
        state.completed = state.awards.length > 0;
        state.actionLine = heroActionLineFromState(state);
        return state;
    }

    function heroActionLineFromState(state) {
        if(!state||!state.heroActions)return '';
        const streets=['preflop','flop','turn','river'], out=[];
        let first=-1,last=-1;
        streets.forEach((s,i)=>{if((state.heroActions[s]||[]).length){if(first<0)first=i;last=i;}});
        if(first<0)return '';
        for(let i=first;i<=last;i++)out.push((state.heroActions[streets[i]]||[]).join('')||'-');
        return out.join('/');
    }


    function makeV6GameState(gameId, captureSeats = true) {
        const initialTableContext = captureSeats ? detectStandaloneTableContext() : null;
        const seat = captureSeats
            ? captureHandSeatSnapshot(gameId, null)
            : { players: new Map(), seatOrder: [], dealerSeatId: '', heroSeatId: '' };
        const now = Date.now();
        return {
            gameId: String(gameId || ''),
            createdAt: now,
            updatedAt: now,
            parsedSignature: '',
            lines: [],
            entries: [],
            players: seat.players,
            seatOrder: seat.seatOrder || [],
            dealerSeatId: seat.dealerSeatId || '',
            heroSeatId: seat.heroSeatId || '',
            seatSnapshotFrozen: false,
            street: 'preflop',
            board: [],
            sbInfo: null,
            bbInfo: null,
            tableContext: initialTableContext,
            tableContextFrozen: !!(initialTableContext?.source === 'texture' && initialTableContext?.key),
            foldedNames: new Set(),
            actionActorNames: new Set(),
            heroName: getRememberedHeroName() || '',
            heroFolded: false,
            heroActions: { preflop: [], flop: [], turn: [], river: [] },
            villainProfiles: new Map(),
            latestVillainAction: null,
            opponentRaiseCount: 0,
            firstOpponentRaiser: '',
            lastOpponentRaiser: '',
            preflopEvents: [],
            preflopDecision: null,
            preflopLiveDecision: null,
            awards: [],
            resultSignature: '',
            completed: false,
            actionLine: '',
            revealedHeroCards: [],
            revealedHands: new Map()
        };
    }

    function mergeV6SeatSnapshot(state) {
        if (!state || !liveDomMatchesGameTable(state)) return;
        if (state.seatSnapshotFrozen) {
            refreshHandSittingOutState(state);
            return;
        }
        const fresh = captureHandSeatSnapshot(state.gameId, state);
        state.players = fresh.players;
        if (fresh.seatOrder?.length >= 2) state.seatOrder = fresh.seatOrder;
        if (fresh.dealerSeatId) state.dealerSeatId = fresh.dealerSeatId;
        if (fresh.heroSeatId) state.heroSeatId = fresh.heroSeatId;

        const age = Date.now() - state.createdAt;
        if (age >= V6_SEAT_CAPTURE_WINDOW_MS || state.hasNonBlindAction || state.street !== 'preflop') {
            state.seatSnapshotFrozen = true;
        }
    }

    function ensureV6GameState(segment) {
        if (!segment?.gameId) return null;
        let state = _v6Runtime.games.get(segment.gameId);
        const isCurrent = segment.gameId === _v6Runtime.frame.currentGameId;
        if (!state) {
            state = makeV6GameState(segment.gameId, isCurrent);
            _v6Runtime.games.set(segment.gameId, state);
        }

        if (isCurrent) {
            const domMatchesHand = freezeExactTableContextForState(state);
            if (domMatchesHand) {
                mergeV6SeatSnapshot(state);
                resolveV6HeroIdentity(state);
            }
        }
        const sig = segment.signature || `${segment.entries.length}|${segment.entries.at(-1)?.line || ''}`;
        if (state.parsedSignature !== sig) {
            state.parsedSignature = sig;
            applyGameLogToHandState(state, segment.lines, segment.entries);
            state.updatedAt = Date.now();
        }

        // Preserve the most reliable immutable facts in the existing position
        // cache so established position/UI functions keep their exact behaviour.
        const imm = getImmutableGameState(segment.gameId);
        if (imm) {
            if (state.heroSeatId && !imm.heroSeatId) imm.heroSeatId = state.heroSeatId;
            if (state.seatOrder?.length >= 2 && !imm.seatOrder) imm.seatOrder = state.seatOrder.slice();
            if (state.dealerSeatId && !imm.dealerSeatId) imm.dealerSeatId = state.dealerSeatId;
            if (state.heroName && !imm.heroName) imm.heroName = state.heroName;
            if (state.tableContext && !imm.tableContext) {
                imm.tableContext = { ...state.tableContext };
            }
            if (Number.isFinite(state.tableContext?.bb) && state.tableContext.bb > 0 && !imm.tableBB) {
                imm.tableBB = state.tableContext.bb;
            } else if (state.bbInfo?.unit === 'cash' && state.bbInfo.amount > 0 && !imm.tableBB) {
                imm.tableBB = state.bbInfo.amount;
            }
        }
        return state;
    }


    function exactNameForPlayerIdFromElement(el, playerId) {
        if (!el || !playerId) return '';
        const wanted = String(playerId);

        // Only trust a profile/name link when its URL explicitly identifies the
        // same Torn player ID. Never use a generic nearby name node for hero.
        for (const a of el.querySelectorAll('a[href]')) {
            const href = String(a.getAttribute('href') || a.href || '');
            const m = href.match(/(?:XID|user2ID)=(\d+)/i);
            if (!m || m[1] !== wanted) continue;
            const tx = String(a.textContent || '').replace(/\s+/g, ' ').trim();
            if (tx) return tx.slice(0, 40);
        }
        return '';
    }

    function inferHeroNameFromActionActors(state, heroId) {
        if (!state) return '';

        // Strongest source: the structured Torn log links an actor directly to
        // the current self player ID.
        const entries = state.entries?.length
            ? state.entries
            : (_v6Runtime.frame.currentSegment?.gameId === state.gameId
                ? _v6Runtime.frame.currentSegment.entries
                : []);
        for (const e of entries || []) {
            if (heroId && String(e.actorId || '') === String(heroId) && e.actor) {
                return String(e.actor).replace(/\s+/g, ' ').trim();
            }
        }

        // Fallback for mobile rows that omit profile hrefs:
        // all correctly recognised non-hero seat names are removed from the
        // action-actor set. If exactly one actor remains, that actor is the hero.
        const nonHeroSeatNames = new Set();
        for (const p of (state.players?.values?.() || [])) {
            if (heroId && String(p.id) === String(heroId)) continue;
            if (p.nameKey) nonHeroSeatNames.add(p.nameKey);
        }

        const possible = [];
        for (const nameKey of (state.actionActorNames || [])) {
            if (!nameKey || nonHeroSeatNames.has(nameKey)) continue;
            if (/^(?:game|the\s+(?:preflop|flop|turn|river))$/i.test(nameKey)) continue;
            possible.push(nameKey);
        }

        if (possible.length === 1) {
            const key = possible[0];

            // Prefer original capitalization from a structured log entry.
            const e = (entries || []).find(x => normalisePlayerName(x.actor) === key);
            return String(e?.actor || key).replace(/\s+/g, ' ').trim();
        }

        return '';
    }

    function resolveV6HeroIdentity(state) {
        if (!state) return { id: '', name: '', nameKey: '', source: 'none' };

        const allowLiveDom = liveDomMatchesGameTable(state);
        const liveId = String((allowLiveDom ? getSelfSeatId() : '') || state.heroSeatId || '');
        if (allowLiveDom && liveId) state.heroSeatId = liveId;
        const selfEl = allowLiveDom && liveId ? document.getElementById('player-' + liveId) : null;

        let liveName = '';
        let source = 'none';

        const pageHero = allowLiveDom ? pageHeroIdentity(liveId) : null;
        if (pageHero) {
            liveName = pageHero.name;
            source = pageHero.source;
        }

        if (!liveName) {
            liveName = inferHeroNameFromActionActors(state, liveId);
            if (liveName) source = 'log/self-id';
        }

        if (!liveName && selfEl && liveId) {
            liveName = exactNameForPlayerIdFromElement(selfEl, liveId);
            if (liveName) source = 'self-link/id';
        }

        if (!liveName && liveId) {
            const remembered = getRememberedHeroNameForId(liveId);
            const rememberedKey = normalisePlayerName(remembered);
            const actors = state.actionActorNames || new Set();
            if (remembered && (!actors.size || actors.has(rememberedKey))) {
                liveName = remembered;
                source = 'id-bound-memory';
            }
        }

        if (!liveName && !liveId) {
            const remembered = String(state.heroName || getRememberedHeroName() || '')
                .replace(/\s+/g, ' ').trim();
            const rememberedKey = normalisePlayerName(remembered);
            const actors = state.actionActorNames || new Set();
            if (remembered && (!actors.size || actors.has(rememberedKey))) {
                liveName = remembered;
                source = 'remembered/unbound';
            }
        }

        const nameKey = normalisePlayerName(liveName);

        if (liveName) {
            state.heroName = liveName;
            state.heroNameSource = source;
            if (liveId && ['page-identity', 'log/self-id', 'self-link/id'].includes(source)) {
                rememberHeroIdentity(liveId, liveName);
            }
        } else if (!state.heroNameSource) {
            state.heroNameSource = source;
        }

        for (const p of (state.players?.values?.() || [])) {
            p.isHero = !!liveId && String(p.id) === liveId;
            if (p.isHero && liveName) {
                p.name = liveName;
                p.nameKey = nameKey;
            }
        }

        return { id: liveId, name: liveName, nameKey, source };
    }

    // V8.2 BETA6: Torn can temporarily expose the same opponent twice to
    // Sidearm: once as an unnamed/stale seat record and again as a named log
    // actor. It can also retain a folded seat in the DOM after the fold line has
    // scrolled out of the currently rendered log. Reconcile the structured log
    // identity back onto the seat first, then let both log state and the current
    // seat's folded class exclude opponents from live-equity calculations.
    function structuredActorIdentityMap(state) {
        const byName = new Map();
        const byId = new Map();
        for (const e of (state?.entries || [])) {
            const name = String(e?.actor || '').replace(/\s+/g, ' ').trim();
            const nameKey = normalisePlayerName(name);
            const id = String(e?.actorId || '').trim();
            if (!nameKey) continue;
            if (id && /^\d+$/.test(id)) {
                byName.set(nameKey, id);
                if (!byId.has(id)) byId.set(id, { id, name, nameKey });
            }
        }
        return { byName, byId };
    }

    function reconcileStructuredActorsToSeats(state) {
        if (!state?.players || !(state.players instanceof Map)) return { byName: new Map(), byId: new Map() };
        const ids = structuredActorIdentityMap(state);
        for (const [id, info] of ids.byId.entries()) {
            const p = state.players.get(String(id));
            if (!p) continue;
            if (info.name && (!p.name || !p.nameKey || p.nameKey !== info.nameKey)) {
                p.name = info.name;
                p.nameKey = info.nameKey;
            }
        }
        return ids;
    }

    function seatShowsFoldedNow(player, state) {
        if (!player?.id || !state) return false;
        const currentGameId = String(_v6Runtime.currentGameId || getCurrentGameId() || '');
        if (!currentGameId || String(state.gameId || '') !== currentGameId) return false;
        if (!liveDomMatchesGameTable(state)) return false;

        const el = document.getElementById('player-' + String(player.id));
        if (!el) return false;
        const seat = seatContainerForPlayer(el);
        const cls = `${String(el.className || '')} ${String(seat?.className || '')}`;
        return /(?:^|\s)folded(?:___[A-Za-z0-9_-]+)?(?:\s|$)/i.test(cls);
    }

    function playerParticipatedInCurrentHand(player, state, actorIds = null) {
        if (!player || !state) return false;
        const nameKey = player.nameKey || normalisePlayerName(player.name || '');
        if (nameKey && state.actionActorNames?.has?.(nameKey)) return true;

        const pid = String(player.id || '');
        if (!pid) return false;
        const ids = actorIds || reconcileStructuredActorsToSeats(state);
        if (ids?.byId?.has?.(pid)) return true;

        // Structured entries are the strongest fallback because blind posts count
        // as hand participation even before any voluntary action is taken.
        return (state.entries || []).some(e => String(e?.actorId || '') === pid);
    }

    function activeVillainsFromHandState(state) {
        if (!state) return [];

        const hero = resolveV6HeroIdentity(state);
        const heroId = String(hero.id || '');
        const heroKey = hero.nameKey || normalisePlayerName(state.heroName || getHeroName());
        const actorIds = reconcileStructuredActorsToSeats(state);
        const out = [];
        const representedNames = new Set();
        const representedIds = new Set();

        for (const p of (state.players?.values?.() || [])) {
            // Hero exclusion is deliberately redundant: player flag, current
            // self seat ID, stored hero seat ID, and hero name all independently
            // exclude the local player. This prevents a responsive Torn re-render
            // from temporarily turning the hero into a villain.
            if (p.isHero) continue;
            if (heroId && String(p.id) === heroId) continue;
            if (state.heroSeatId && String(p.id) === String(state.heroSeatId)) continue;
            if (heroKey && p.nameKey === heroKey) continue;

            const participated = playerParticipatedInCurrentHand(p, state, actorIds);

            // Seat occupancy is not hand membership. A player captured as sitting
            // out or Waiting BB is excluded unless the current hand log proves
            // participation (blind post or poker action).
            if ((p.sittingOutAtStart || p.waitingBBAtStart) && !participated) continue;
            if (p.nameKey && state.foldedNames.has(p.nameKey)) continue;
            if (seatShowsFoldedNow(p, state)) continue;

            const pid = String(p.id || '');
            // Seat IDs are authoritative. A duplicated React node must not count
            // as a second villain during a table re-render.
            if (pid && representedIds.has(pid)) continue;

            out.push(p);
            if (pid) representedIds.add(pid);
            if (p.nameKey) representedNames.add(p.nameKey);
        }

        // Log-only actors repair genuinely missing seat records. If the structured
        // log says that actor belongs to an ID already represented by a seat, do
        // not add the same opponent again under their name.
        for (const nameKey of state.actionActorNames || []) {
            if (!nameKey || representedNames.has(nameKey)) continue;
            if (heroKey && nameKey === heroKey) continue;
            if (/^(?:game|the\s+(?:preflop|flop|turn|river))$/i.test(nameKey)) continue;
            if (state.foldedNames.has(nameKey)) continue;

            const actorId = String(actorIds.byName.get(nameKey) || '');
            if (actorId && heroId && actorId === heroId) continue;
            if (actorId && state.heroSeatId && actorId === String(state.heroSeatId)) continue;
            if (actorId && representedIds.has(actorId)) continue;

            const profile = state.villainProfiles.get(nameKey);
            out.push({
                id: actorId || ('log:' + nameKey),
                name: profile?.name || nameKey,
                nameKey,
                isHero: false,
                sittingOutAtStart: false,
                fromLogOnly: true
            });
            if (actorId) representedIds.add(actorId);
            representedNames.add(nameKey);
        }

        return out;
    }
    function getHandStateLiveNames(state) {
        const names = new Set();
        for (const p of activeVillainsFromHandState(state)) {
            if (p.nameKey) names.add(p.nameKey);
        }
        return names;
    }

    function countLiveVillains(handState = null) {
        const state = handState || currentV6GameState();
        if (!state) return 0;
        return activeVillainsFromHandState(state).length;
    }

    function classifyBoardTexture(board) {
        const cards = uniqueCards(board || []);
        const ranks = cards.map(cardRankNum).filter(Boolean).sort((a, b) => b - a);
        const suits = cards.map(cardSuitChar).filter(Boolean);
        const rankCounts = new Map();
        const suitCounts = new Map();

        for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
        for (const s of suits) suitCounts.set(s, (suitCounts.get(s) || 0) + 1);

        const paired = [...rankCounts.values()].some(n => n >= 2);
        const trips = [...rankCounts.values()].some(n => n >= 3);
        const maxSuit = suitCounts.size ? Math.max(...suitCounts.values()) : 0;
        const monotone = cards.length >= 3 && maxSuit >= 3;
        const twoTone = !monotone && maxSuit >= 2;

        const uniq = [...new Set(ranks)].sort((a, b) => a - b);
        if (uniq.includes(14)) uniq.unshift(1); // wheel connectivity
        let connected = false;
        let highlyConnected = false;
        for (let i = 0; i < uniq.length; i++) {
            for (let j = i + 1; j < uniq.length; j++) {
                const span = uniq[j] - uniq[i];
                const count = j - i + 1;
                if (count >= 3 && span <= 4) connected = true;
                if (count >= 3 && span <= 3) highlyConnected = true;
            }
        }

        const wetScore =
            (monotone ? 2 : twoTone ? 1 : 0) +
            (highlyConnected ? 2 : connected ? 1 : 0) +
            (paired ? 1 : 0);

        return {
            paired, trips, monotone, twoTone, connected, highlyConnected,
            wetScore,
            label: wetScore >= 3 ? 'wet' : wetScore >= 1 ? 'mixed' : 'dry'
        };
    }


    function betSizeBucket(amount, potBefore) {
        if (!(amount > 0) || !(potBefore > 0)) return 'unknown';
        const ratio = amount / potBefore;
        if (ratio <= 0.25) return 'tiny';
        if (ratio <= 0.45) return 'small';
        if (ratio <= 0.70) return 'medium';
        if (ratio <= 1.00) return 'large';
        return 'overbet';
    }

    function buildLiveVillainProfiles(board, potInfo) {
        const state = currentV6GameState();
        if (!state) return [];

        const liveNames = getHandStateLiveNames(state);
        const out = [];
        for (const [key, src] of state.villainProfiles.entries()) {
            if (!liveNames.has(key) || src.folded) continue;
            const seated = [...(state.players?.values?.() || [])].find(x => x?.nameKey === key) || null;
            const p = {
                ...src,
                id: seated?.id || src.id || '',
                streetAggression: { ...(src.streetAggression || {}) },
                sizeBuckets: [...(src.sizeBuckets || [])]
            };

            p.sizeBuckets = [];
            if (potInfo?.pot > 0) {
                for (const amount of (p.rawBetAmounts || [])) {
                    const bucket = betSizeBucket(amount, potInfo.pot);
                    if (bucket !== 'unknown') p.sizeBuckets.push(bucket);
                }
            }
            out.push(p);
        }

        // Quiet players are still live opponents. Give them neutral profiles so
        // multiway adjustment uses the correct opponent count.
        const known = new Set(out.map(p => normalisePlayerName(p.name)));
        for (const player of activeVillainsFromHandState(state)) {
            const profileKey = player.nameKey || ('id:' + player.id);
            if (known.has(profileKey)) continue;
            out.push({
                id: player.id || '',
                name: player.name || ('Player ' + player.id),
                folded: false,
                preflopRaises: 0, preflopCalls: 0, checks: 0, calls: 0,
                bets: 0, raises: 0, checkRaises: 0,
                streetAggression: { flop: 0, turn: 0, river: 0 },
                sizeBuckets: [], rawBetAmounts: [], lastAction: '', lastStreet: 'preflop'
            });
            known.add(profileKey);
        }
        return out;
    }

    function villainThreatScore(p, texture) {
        let score = 1.0;
        score += Math.min(0.36, (p.preflopRaises || 0) * 0.16);
        score += Math.min(0.14, (p.preflopCalls || 0) * 0.05);
        score += Math.min(0.30, (p.raises || 0) * 0.15);
        score += Math.min(0.18, (p.bets || 0) * 0.07);
        score += Math.min(0.28, (p.checkRaises || 0) * 0.22);

        const lastSize = p.sizeBuckets && p.sizeBuckets.length ? p.sizeBuckets[p.sizeBuckets.length - 1] : '';
        if (lastSize === 'tiny') score -= 0.04;
        else if (lastSize === 'small') score += 0.02;
        else if (lastSize === 'medium') score += 0.08;
        else if (lastSize === 'large') score += 0.16;
        else if (lastSize === 'overbet') score += 0.26;

        const streetWeight = p.lastStreet === 'river' ? 0.16 : p.lastStreet === 'turn' ? 0.10 : p.lastStreet === 'flop' ? 0.05 : 0;
        if (p.lastAction === 'raised' || p.lastAction === 'bet' || p.lastAction === 'bets') score += streetWeight;

        // Wet boards retain more legitimate draw aggression; dry boards make
        // late heavy aggression somewhat more value-dense.
        if (texture && texture.label === 'dry' && (p.raises || p.checkRaises)) score += 0.08;
        if (texture && texture.label === 'wet' && (p.bets || p.raises)) score -= 0.03;

        return Math.max(0.55, Math.min(2.15, score));
    }

    function multiwayTrialCount(villainCount) {
        const n = Math.max(1, Number(villainCount) || 1);
        if (n <= 1) return EQUITY_TRIALS_HEADS_UP;
        if (n === 2) return EQUITY_TRIALS_TWO_VILLAINS;
        if (n <= 4) return EQUITY_TRIALS_MULTIWAY;
        return EQUITY_TRIALS_MANY_VILLAINS;
    }

    function villainRangeBucketForProfile(profile, fallbackBucket = 'Late') {
        try {
            const seat = preflopSeatInfoForName(profile?.name || '', currentV6GameState());
            const bucket = seat?.bucket || '';
            if (bucket === 'EP' || bucket === 'MP') return bucket;
            if (bucket === 'SB' || bucket === 'BB' || bucket === 'Blind') return 'Blind';
            if (bucket === 'CO' || bucket === 'BTN' || bucket === 'Late') return 'Late';
        } catch (_) {}
        return fallbackBucket || 'Late';
    }

    function liveProfileToRangeProfile(profile, fallbackProfile, potInfo) {
        const lastAction = String(profile?.lastAction || '').toLowerCase();
        let aggression = 'none';
        if (lastAction === 'raised') aggression = 'raise';
        else if (lastAction === 'bet' || lastAction === 'bets') aggression = 'bet';
        else if (lastAction === 'called') aggression = 'call';
        else if (lastAction === 'checked') aggression = 'check';

        let sizeRatio = null;
        if (Number.isFinite(profile?.lastAmount) && profile.lastAmount > 0 && potInfo?.pot > 0) {
            sizeRatio = profile.lastAmount / potInfo.pot;
        }

        return {
            villain: profile?.name || fallbackProfile?.villain || '',
            villainId: profile?.id || '',
            bucket: villainRangeBucketForProfile(profile, fallbackProfile?.bucket || 'Late'),
            preflopRaises: Number(profile?.preflopRaises || 0),
            aggression,
            sizeRatio,
            street: profile?.lastStreet || fallbackProfile?.street || 'flop',
            history: opponentHistorySummary(profile)
        };
    }

    function compactVillainCalibrationContext(profile, fallbackProfile, potInfo, texture) {
        const rp = liveProfileToRangeProfile(profile, fallbackProfile, potInfo);
        const hist = rp?.history || {};
        return {
            name: profile?.name || rp?.villain || '',
            id: profile?.id || rp?.villainId || '',
            bucket: rp?.bucket || '',
            preflopRaises: Number(profile?.preflopRaises || 0),
            preflopCalls: Number(profile?.preflopCalls || 0),
            checks: Number(profile?.checks || 0),
            calls: Number(profile?.calls || 0),
            bets: Number(profile?.bets || 0),
            raises: Number(profile?.raises || 0),
            checkRaises: Number(profile?.checkRaises || 0),
            lastAction: String(profile?.lastAction || ''),
            lastStreet: String(profile?.lastStreet || ''),
            sizeBuckets: Array.isArray(profile?.sizeBuckets) ? profile.sizeBuckets.slice() : [],
            aggression: rp?.aggression || 'none',
            sizeRatio: Number.isFinite(rp?.sizeRatio) ? rp.sizeRatio : null,
            threatScore: Number(villainThreatScore(profile || {}, texture).toFixed(4)),
            historyEligible: !!hist.eligible,
            historyHands: Number(hist.hands || 0),
            historyVpipPct: Number.isFinite(hist.vpipPct) ? hist.vpipPct : null,
            historyPfrPct: Number.isFinite(hist.pfrPct) ? hist.pfrPct : null,
            historyPostAggPct: Number.isFinite(hist.postAggPct) ? hist.postAggPct : null
        };
    }

    function opponentHistoryComboMultiplier(cards, board, rangeProfile) {
        const hist = rangeProfile?.history;
        if (!hist?.eligible) return 1;

        // Historical behaviour is intentionally a nudge, never the main range.
        // Current position/action remains dominant; the total history effect is
        // hard-capped at +/-12% in this first beta.
        const neutralStrength = preflopComboWeight(cards, 'Late', 0);
        const weakness = clamp((0.58 - neutralStrength) / 0.53, 0, 1);
        let delta = 0;

        // Loose players retain a few more marginal combos; tight players retain
        // a few fewer. Strong starting hands are barely changed.
        const vpipDelta = clamp((Number(hist.vpipPct) - 28) / 22, -1, 1);
        delta += 0.07 * vpipDelta * weakness;

        // If this player is currently representing preflop aggression, a proven
        // high/low PFR rate slightly widens/tightens that aggressive range.
        if (Number(rangeProfile?.preflopRaises || 0) > 0) {
            const pfrDelta = clamp((Number(hist.pfrPct) - 18) / 18, -1, 1);
            delta += 0.04 * pfrDelta * weakness;
        }

        // For a live postflop bet/raise, long-run aggression only nudges the
        // marginal end of the range. Keep this cheap: no extra hand evaluation
        // is added to every candidate combo.
        if ((rangeProfile?.aggression === 'bet' || rangeProfile?.aggression === 'raise') &&
            Number.isFinite(hist.postAggPct) && hist.postActions >= OPPONENT_HISTORY_MIN_POSTFLOP_ACTIONS) {
            const aggDelta = clamp((Number(hist.postAggPct) - 42) / 28, -1, 1);
            delta += 0.05 * aggDelta * weakness;
        }

        delta = clamp(delta, -OPPONENT_HISTORY_MAX_INFLUENCE, OPPONENT_HISTORY_MAX_INFLUENCE);
        return 1 + delta;
    }

    function buildWeightedComboPool(deck, board, rangeProfile) {
        const combos = [];
        let totalWeight = 0;
        for (let i = 0; i < deck.length - 1; i++) {
            for (let j = i + 1; j < deck.length; j++) {
                const cards = [deck[i], deck[j]];
                let weight = preflopComboWeight(
                    cards,
                    rangeProfile?.bucket,
                    rangeProfile?.preflopRaises
                );
                weight *= postflopComboWeight(cards, board, rangeProfile || {});
                weight *= opponentHistoryComboMultiplier(cards, board, rangeProfile || {});
                if (!(weight > 0)) continue;
                combos.push({
                    cards,
                    keys: cards.map(normalizeCardKey),
                    weight
                });
                totalWeight += weight;
            }
        }
        return { combos, totalWeight };
    }

    function exactRiverHeadsUpEquity(holeCards, board, rangeProfile) {
        const hole = uniqueCards(holeCards);
        const brd = uniqueCards(board);
        if (hole.length < 2 || brd.length !== 5) return null;

        const used = new Set([...hole, ...brd].map(normalizeCardKey));
        const deck = buildFullDeck().filter(c => !used.has(normalizeCardKey(c)));
        if (deck.length < 2) return null;

        const pool = buildWeightedComboPool(deck, brd, rangeProfile || {});
        if (!pool.combos.length || !(pool.totalWeight > 0)) return null;

        const heroRank = bestRankFromSeven(hole.concat(brd));
        if (!heroRank) return null;

        let winWeight = 0, tieWeight = 0, lossWeight = 0, shareWeight = 0;
        for (const item of pool.combos) {
            const oppRank = bestRankFromSeven(item.cards.concat(brd));
            if (!oppRank || !(item.weight > 0)) continue;
            const cmp = compareRankVectors(heroRank, oppRank);
            if (cmp > 0) {
                winWeight += item.weight;
                shareWeight += item.weight;
            } else if (cmp < 0) {
                lossWeight += item.weight;
            } else {
                tieWeight += item.weight;
                shareWeight += item.weight * 0.5;
            }
        }

        const totalWeight = winWeight + tieWeight + lossWeight;
        if (!(totalWeight > 0)) return null;
        const hist = rangeProfile?.history;
        return {
            winPct: 100 * shareWeight / totalWeight,
            headsUpPct: 100 * shareWeight / totalWeight,
            wins: winWeight,
            ties: tieWeight,
            losses: lossWeight,
            trials: pool.combos.length,
            samplingStdErrPct: 0,
            made: describeMadeHand(hole, brd),
            hole,
            board: brd,
            model: 'weighted-range-river-exact',
            villainCount: 1,
            exactEnumeration: true,
            opponentModelVersion: OPPONENT_MODEL_VERSION,
            opponentHistoryApplied: hist?.eligible ? 1 : 0,
            opponentHistoryMaxHands: hist?.eligible ? Number(hist.hands || 0) : 0,
            rangeProfile: rangeProfile || null
        };
    }

    function weightedPickLegal(pool, usedKeys) {
        if (!pool?.combos?.length || !(pool.totalWeight > 0)) return null;

        // Usually a random weighted pick is legal. Rejection first avoids a
        // full scan on every trial; the fallback guarantees a legal pick when
        // several opponents have already consumed cards.
        for (let attempt = 0; attempt < 18; attempt++) {
            let x = Math.random() * pool.totalWeight;
            let picked = pool.combos[pool.combos.length - 1];
            for (const item of pool.combos) {
                x -= item.weight;
                if (x <= 0) { picked = item; break; }
            }
            if (!picked.keys.some(k => usedKeys.has(k))) return picked;
        }

        let legalWeight = 0;
        for (const item of pool.combos) {
            if (!item.keys.some(k => usedKeys.has(k))) legalWeight += item.weight;
        }
        if (!(legalWeight > 0)) return null;

        let x = Math.random() * legalWeight;
        for (const item of pool.combos) {
            if (item.keys.some(k => usedKeys.has(k))) continue;
            x -= item.weight;
            if (x <= 0) return item;
        }
        return null;
    }

    function monteCarloMultiwayEquity(holeCards, board, trials, villainProfiles, fallbackProfile, potInfo, texture) {
        const hole = uniqueCards(holeCards);
        const brd = uniqueCards(board);
        if (hole.length < 2 || brd.length < 3) return null;

        const profiles = Array.isArray(villainProfiles) ? villainProfiles.filter(Boolean) : [];
        if (profiles.length < 2) return monteCarloEquity(hole, brd, trials, fallbackProfile);

        const baseUsed = new Set([...hole, ...brd].map(normalizeCardKey));
        const deck = buildFullDeck().filter(c => !baseUsed.has(normalizeCardKey(c)));
        if (deck.length < (profiles.length * 2)) return null;

        // Put the most action-heavy ranges first. This improves rejection-pick
        // efficiency and makes the pairwise heads-up reference more meaningful.
        const orderedProfiles = profiles.slice().sort((a, b) =>
            villainThreatScore(b, texture) - villainThreatScore(a, texture)
        );
        const poolCache = new Map();
        const pools = orderedProfiles.map(p => {
            const rp = liveProfileToRangeProfile(p, fallbackProfile, potInfo);
            const sig = [
                rp.bucket || 'Late',
                Number(rp.preflopRaises || 0),
                rp.aggression || 'none',
                Number.isFinite(rp.sizeRatio) ? rp.sizeRatio.toFixed(2) : '-',
                rp.street || 'flop'
            ].join('|');
            let pool = poolCache.get(sig);
            if (!pool) {
                pool = buildWeightedComboPool(deck, brd, rp);
                poolCache.set(sig, pool);
            }
            return { profile: rp, pool };
        }).filter(x => x.pool.combos.length && x.pool.totalWeight > 0);
        if (pools.length < 2) return monteCarloEquity(hole, brd, trials, fallbackProfile);

        const needBoard = Math.max(0, 5 - brd.length);
        let wins = 0, ties = 0, losses = 0;
        let equityShares = 0;
        let equityShareSquares = 0;
        let pairwiseShares = 0;
        let pairwiseComparisons = 0;
        let completedTrials = 0;

        for (let t = 0; t < trials; t++) {
            const used = new Set(baseUsed);
            const opponents = [];
            let valid = true;

            for (const entry of pools) {
                const picked = weightedPickLegal(entry.pool, used);
                if (!picked) { valid = false; break; }
                opponents.push(picked.cards);
                picked.keys.forEach(k => used.add(k));
            }
            if (!valid || opponents.length < 2) continue;

            const remaining = deck.filter(c => !used.has(normalizeCardKey(c)));
            for (let i = 0; i < needBoard; i++) {
                const j = i + Math.floor(Math.random() * (remaining.length - i));
                const tmp = remaining[i]; remaining[i] = remaining[j]; remaining[j] = tmp;
            }
            const fullBoard = needBoard === 0 ? brd : brd.concat(remaining.slice(0, needBoard));
            const heroRank = bestRankFromSeven(hole.concat(fullBoard));
            if (!heroRank) continue;

            let beaten = false;
            let tiedOpponents = 0;
            let validRanks = true;
            for (const opp of opponents) {
                const oppRank = bestRankFromSeven(opp.concat(fullBoard));
                if (!oppRank) { validRanks = false; break; }
                const cmp = compareRankVectors(heroRank, oppRank);
                if (cmp < 0) beaten = true;
                else if (cmp === 0) tiedOpponents++;

                pairwiseShares += cmp > 0 ? 1 : (cmp === 0 ? 0.5 : 0);
                pairwiseComparisons++;
            }
            if (!validRanks) continue;

            completedTrials++;
            if (beaten) {
                losses++;
                continue;
            }
            if (tiedOpponents > 0) {
                ties++;
                const share = 1 / (tiedOpponents + 1);
                equityShares += share;
                equityShareSquares += share * share;
            } else {
                wins++;
                equityShares += 1;
                equityShareSquares += 1;
            }
        }

        if (!completedTrials) return null;
        const meanShare = equityShares / completedTrials;
        const sampleVariance = completedTrials > 1
            ? Math.max(0, (equityShareSquares - completedTrials * meanShare * meanShare) / (completedTrials - 1))
            : 0;
        const samplingStdErrPct = 100 * Math.sqrt(sampleVariance / completedTrials);
        return {
            winPct: 100 * meanShare,
            headsUpPct: pairwiseComparisons ? 100 * pairwiseShares / pairwiseComparisons : null,
            wins, ties, losses,
            trials: completedTrials,
            samplingStdErrPct,
            made: describeMadeHand(hole, brd),
            hole,
            board: brd,
            model: 'joint-multiway',
            villainCount: pools.length,
            opponentModelVersion: OPPONENT_MODEL_VERSION,
            opponentHistoryApplied: pools.filter(x => x.profile?.history?.eligible).length,
            opponentHistoryMaxHands: pools.reduce((m, x) => Math.max(m, Number(x.profile?.history?.hands || 0)), 0),
            rangeProfile: fallbackProfile || null
        };
    }

    function detectVillainPostflopProfile(preAct, potInfo) {
        const state = currentV6GameState();
        const latest = state?.latestVillainAction || null;

        let aggression = 'none';
        let sizeRatio = null;
        if (latest) {
            if (latest.verb === 'checked') aggression = 'check';
            else if (latest.verb === 'called') aggression = 'call';
            else if (latest.verb === 'raised' || latest.verb === 'bet' || latest.verb === 'bets') {
                aggression = latest.verb === 'raised' ? 'raise' : 'bet';
                if (latest.amount != null && potInfo?.pot > 0) sizeRatio = latest.amount / potInfo.pot;
            }
        }

        return {
            villain: latest?.who || preAct.lastRaiserName || preAct.openerName || '',
            bucket: preAct.openerBucket || 'Late',
            preflopRaises: preAct.raiseCount || 0,
            aggression,
            sizeRatio,
            street: latest?.street || state?.street || 'flop'
        };
    }

    function postflopComboWeight(cards, board, profile) {
        const rank = bestRankFromSeven([...(cards || []), ...(board || [])]);
        const cat = rank ? rank[0] : 0;
        const draw = drawPotential(cards, board);
        const action = profile && profile.aggression || 'none';
        const size = profile && profile.sizeRatio;

        let w = 1.0;
        if (action === 'bet' || action === 'raise') {
            // Larger bets/raises progressively downweight air and marginal one-pair
            // holdings while retaining strong draws and a non-zero bluff component.
            const pressure = size == null ? 0.65 : Math.max(0.20, Math.min(1.50, size));
            if (cat >= 4) w *= 1.55 + pressure * 0.45;       // straight+
            else if (cat === 3) w *= 1.50 + pressure * 0.35; // trips
            else if (cat === 2) w *= 1.40 + pressure * 0.30; // two pair
            else if (cat === 1) w *= Math.max(0.35, 1.05 - pressure * 0.35);
            else if (draw.strongDraw) w *= 1.15 + pressure * 0.35;
            else w *= Math.max(0.08, 0.58 - pressure * 0.30);

            if (action === 'raise') {
                if (cat >= 2) w *= 1.25;
                else if (!draw.strongDraw) w *= 0.65;
            }
        } else if (action === 'call') {
            if (cat >= 2) w *= 1.20;
            else if (cat === 1) w *= 1.05;
            else if (draw.strongDraw) w *= 1.25;
            else w *= 0.55;
        } else if (action === 'check') {
            // Checks keep the range broad. Strong hands remain possible as traps.
            if (cat >= 2) w *= 0.78;
            else if (cat === 1) w *= 1.05;
            else if (draw.strongDraw) w *= 0.95;
            else w *= 1.12;
        }
        return Math.max(0.002, w);
    }

    function weightedPick(items, totalWeight) {
        if (!items.length) return null;
        let x = Math.random() * totalWeight;
        for (const item of items) {
            x -= item.weight;
            if (x <= 0) return item.cards;
        }
        return items[items.length - 1].cards;
    }

    function monteCarloEquity(holeCards, board, trials, rangeProfile) {
        const hole = uniqueCards(holeCards);
        const brd = uniqueCards(board);
        if (hole.length < 2 || brd.length < 3) return null;
        trials = trials || 1800;

        const used = new Set([...hole, ...brd].map(normalizeCardKey));
        const deck = buildFullDeck().filter(c => !used.has(c));
        if (deck.length < 2) return null;

        // Build all legal villain hole-card combinations with the same weighting
        // used by Multi-Monty, including the deliberately small historical nudge.
        const pool = buildWeightedComboPool(deck, brd, rangeProfile || {});
        const combos = pool.combos;
        const totalWeight = pool.totalWeight;
        if (!combos.length || totalWeight <= 0) return null;

        const needBoard = Math.max(0, 5 - brd.length);
        let wins = 0, ties = 0, losses = 0;

        for (let t = 0; t < trials; t++) {
            const opp = weightedPick(combos, totalWeight);
            if (!opp) continue;
            const oppSet = new Set(opp.map(normalizeCardKey));
            const remaining = deck.filter(c => !oppSet.has(normalizeCardKey(c)));

            for (let i = 0; i < needBoard; i++) {
                const j = i + Math.floor(Math.random() * (remaining.length - i));
                const tmp = remaining[i]; remaining[i] = remaining[j]; remaining[j] = tmp;
            }
            const fullBoard = needBoard === 0 ? brd : brd.concat(remaining.slice(0, needBoard));
            const heroRank = bestRankFromSeven(hole.concat(fullBoard));
            const oppRank = bestRankFromSeven(opp.concat(fullBoard));
            if (!heroRank || !oppRank) continue;
            const cmp = compareRankVectors(heroRank, oppRank);
            if (cmp > 0) wins++;
            else if (cmp < 0) losses++;
            else ties++;
        }

        const total = wins + ties + losses;
        if (!total) return null;
        const shareSum = wins + ties * 0.5;
        const shareSquares = wins + ties * 0.25;
        const meanShare = shareSum / total;
        const sampleVariance = total > 1
            ? Math.max(0, (shareSquares - total * meanShare * meanShare) / (total - 1))
            : 0;
        const winPct = 100 * meanShare;
        const samplingStdErrPct = 100 * Math.sqrt(sampleVariance / total);
        return {
            winPct,
            wins,
            ties,
            losses,
            trials: total,
            samplingStdErrPct,
            made: describeMadeHand(hole, brd),
            hole,
            board: brd,
            model: 'weighted-range',
            villainCount: 1,
            opponentModelVersion: OPPONENT_MODEL_VERSION,
            opponentHistoryApplied: rangeProfile?.history?.eligible ? 1 : 0,
            opponentHistoryMaxHands: rangeProfile?.history?.eligible ? Number(rangeProfile.history.hands || 0) : 0,
            rangeProfile: rangeProfile || null,
        };
    }


    /** Read pot size and amount to call from the holdem UI. */
    function parseCashLoose(text) {
        if (text == null) return null;
        const s = String(text).replace(/,/g, '').trim();

        // Torn abbreviates large amounts in controls, e.g. "$1.3M".
        const parseToken = raw => {
            const m = String(raw || '').match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
            if (!m) return null;
            const base = Number(m[1]);
            if (!Number.isFinite(base)) return null;
            const suffix = (m[2] || '').toUpperCase();
            const mult = suffix === 'K' ? 1e3
                : suffix === 'M' ? 1e6
                : suffix === 'B' ? 1e9
                : 1;
            const value = base * mult;
            return Number.isFinite(value) ? value : null;
        };

        const cash = s.match(/\$\s*([0-9]+(?:\.[0-9]+)?\s*[KMB]?)/i);
        if (cash) return parseToken(cash[1]);

        const bare = s.match(/([0-9]+(?:\.[0-9]+)?\s*[KMB]?)/i);
        return bare ? parseToken(bare[1]) : null;
    }

    function detectPotAndCall() {
        let pot = null;
        let toCall = null;
        let actionState = 'none'; // call | check | folded | none

        // Pot labels: "POT: $525", "Pot $1.2M".
        const potCandidates = document.querySelectorAll(
            '[class*="pot"], [class*="Pot"], [class*="totalPot"], [class*="potSize"]'
        );
        for (const el of potCandidates) {
            const tx = (el.textContent || '').trim();
            if (/pot/i.test(tx) && /\$?\d/.test(tx)) {
                const v = parseCashLoose(tx);
                if (v != null && v > 0 && (pot == null || v > pot)) pot = v;
            }
        }

        if (pot == null) {
            const labels = document.querySelectorAll('div, span, p, strong, b');
            for (const el of labels) {
                if (el.children && el.children.length > 3) continue;
                const tx = (el.textContent || '').trim();
                if (tx.length > 50) continue;
                if (/^pot\s*:?\s*\$?\s*[0-9][\d,.]*\s*[KMB]?/i.test(tx)) {
                    const v = parseCashLoose(tx);
                    if (v != null && v > 0) { pot = v; break; }
                }
            }
        }

        // Current-hand action state comes from the canonical V6 hand state.
        // No second pass over the poker log is needed here.
        try {
            const state = currentV6GameState();
            if (state?.heroFolded) actionState = 'folded';
        } catch (_) {}

        if (actionState !== 'folded') {
            // Only inspect actual button-like controls. We deliberately removed
            // the old broad [class*="call"] DOM fallback because it could pick up
            // unrelated values such as "99" after checking/folding.
            const buttons = [...document.querySelectorAll(
                'button, [role="button"], a[class*="button"], [class*="actionButton"], [class*="action-button"]'
            )];

            const isUsableControl = el => {
                if (!el) return false;
                if (el.disabled) return false;
                const ariaDisabled = String(el.getAttribute && el.getAttribute('aria-disabled') || '').toLowerCase();
                if (ariaDisabled === 'true') return false;
                const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
                if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
                return true;
            };

            // An active explicit CALL control is authoritative.
            for (const el of buttons) {
                if (!isUsableControl(el)) continue;
                const tx = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!/^call\b/i.test(tx) || /^call\s*any\b/i.test(tx)) continue;

                // Require an amount on the actual CALL control. Do not inspect a
                // large parent container for arbitrary numbers.
                const amountMatch = tx.match(/\bcall\b[^\d$]*\$?\s*([0-9][\d,.]*\s*[KMB]?)/i);
                if (!amountMatch) continue;
                const v = parseCashLoose(amountMatch[0]);
                if (v != null && v > 0) {
                    toCall = v;
                    actionState = 'call';
                    break;
                }
            }

            // Torn sometimes replaces CALL with only ALL-IN / FOLD when Hero
            // is covered and can call only for the remaining stack. In that
            // state the amount to call is Hero's actual stack behind. Requiring
            // a usable Fold and the absence of Check avoids treating a proactive
            // shove (where checking is available) as a call.
            if (actionState !== 'call') {
                const texts = buttons
                    .filter(isUsableControl)
                    .map(el => ({ el, tx: (el.textContent || '').replace(/\s+/g, ' ').trim() }));
                const hasAllIn = texts.some(x => /^(?:all[\s-]*in)\b/i.test(x.tx));
                const hasFold = texts.some(x => /^fold\b/i.test(x.tx));
                const hasCheck = texts.some(x => /^check\b/i.test(x.tx));

                if (hasAllIn && hasFold && !hasCheck) {
                    const heroStack = readSelfStackRaw();
                    if (heroStack && (heroStack.kind === 'bb' || heroStack.kind === 'cash') &&
                        Number.isFinite(heroStack.value) && heroStack.value > 0) {
                        toCall = heroStack.value;
                        actionState = 'call';
                    }
                }
            }

            // If no payable call exists, an active CHECK control means free play.
            if (actionState !== 'call') {
                for (const el of buttons) {
                    if (!isUsableControl(el)) continue;
                    const tx = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (/^check\b/i.test(tx)) {
                        actionState = 'check';
                        toCall = 0;
                        break;
                    }
                }
            }
        }

        let potOddsPct = null;
        if (actionState === 'call' && toCall != null && toCall > 0 && pot != null && pot >= 0) {
            potOddsPct = 100 * toCall / (pot + toCall);
            if (!Number.isFinite(potOddsPct) || potOddsPct <= 0 || potOddsPct >= 100) {
                potOddsPct = null;
            }
        }

        let potBB = null, toCallBB = null;
        try {
            const bb = detectTableBB();
            if (bb != null && bb > 0) {
                if (pot != null) potBB = pot / bb;
                if (toCall != null) toCallBB = toCall / bb;
            }
        } catch (_) {}

        return { pot, toCall, potOddsPct, potBB, toCallBB, actionState };
    }

    function postflopAdviceColor(advice) {
        const action = String(advice?.action || '').toLowerCase();
        const size = String(advice?.size || '').toUpperCase();
        if (action === 'check') return '#3498db';
        if (action === 'fold') return '#e74c3c';
        if (action === 'call') return '#2ecc71';
        if (action === 'bet' || action === 'raise') {
            return size === 'L' ? '#9b59b6' : '#2ecc71';
        }
        if (action === 'folded') return '#888';
        return '#b39ddb';
    }

    function postflopSizeWord(size) {
        const s = String(size || '').toUpperCase();
        if (s === 'S') return 'Küçük';
        if (s === 'M') return 'Orta';
        if (s === 'L') return 'Büyük';
        return '';
    }

    function postflopBetPotLabel(size) {
        const s = String(size || '').toUpperCase();
        if (s === 'S') return 'potun ~1/3\u2019ü';
        if (s === 'M') return 'potun ~yarısı';
        if (s === 'L') return 'potun ~3/4\u2019ü';
        return '';
    }

    function postflopSizeHint(size, action = '') {
        const word = postflopSizeWord(size);
        if (!word) return '';
        const a = String(action || '').toLowerCase();
        if (a === 'bet') {
            const pot = postflopBetPotLabel(size);
            return pot ? `${word} (${pot})` : word;
        }
        if (a === 'raise') return `${word} raise`;
        return word;
    }

    function postflopAdviceLabel(advice) {
        const action = String(advice?.action || '').toUpperCase();
        const size = String(advice?.size || '').toUpperCase();
        if (!action) return 'BEKLE';
        if ((action === 'BET' || action === 'RAISE') && size) return `${action} ${size}`;
        return trActionLabel(action);
    }

    // Beginner-facing panel text expands S/M/L without pretending a postflop
    // raise has an exact pot-fraction target. Bet sizes can safely show the
    // model's broad pot fractions because they start from a checked-to pot.
    function postflopAdvicePanelLabel(advice) {
        const action = String(advice?.action || '').toUpperCase();
        const size = String(advice?.size || '').toUpperCase();
        if (!action) return 'BEKLE';
        if ((action === 'BET' || action === 'RAISE') && size) {
            const word = postflopSizeWord(size);
            if (action === 'BET') {
                const pot = postflopBetPotLabel(size);
                return `${action} · ${word}${pot ? ` (${pot})` : ''}`;
            }
            return `${action} · ${word}`;
        }
        return trActionLabel(action);
    }

    // The bubble keeps the action itself on the first line. Size guidance gets
    // its own badge line so mobile bubbles never have to squeeze "BET/RAISE M"
    // into the same narrow row.
    function postflopAdviceBubbleLabel(advice) {
        const action = String(advice?.action || '').toLowerCase();
        const symbolAction = action === 'bet' ? 'raise' : (action === 'folded' ? 'fold' : action);
        const symbol = ['raise', 'call', 'check', 'fold'].includes(symbolAction)
            ? actionSymbol(symbolAction)
            : '';
        const label = action ? trActionLabel(action.toUpperCase()) : 'BEKLE';
        return symbol ? `${symbol} ${label}` : label;
    }

    function postflopAdviceBubbleSizeLabel(advice) {
        const action = String(advice?.action || '').toLowerCase();
        const size = String(advice?.size || '').toUpperCase();
        if (!size || (action !== 'bet' && action !== 'raise')) return '';
        if (action === 'bet') {
            if (size === 'S') return 'POTUN 1/3';
            if (size === 'M') return 'POTUN YARISI';
            if (size === 'L') return 'POTUN 3/4';
        }
        return postflopSizeWord(size).toUpperCase();
    }

    // Compact display-only hand label for the floating advice box. Keep the
    // underlying hand description unchanged in records/debug/export.
    function compactPostflopHandLabel(holeCards, boardCards, made) {
        const text = String(made || 'Hand').trim();
        const lower = text.toLowerCase();
        if (lower.includes('overpair')) return 'Masadan büyük çift';
        if (lower.includes('top pair')) return 'En yüksek çift';
        if (lower.includes('high pair')) return 'Yüksek çift';
        if (lower.includes('mid pair')) return 'Orta çift';
        if (lower.includes('low pair')) return 'Düşük çift';
        if (lower === 'three of a kind') return 'Üçlü (trips)';
        if (lower === 'four of a kind') return 'Kare (quads)';

        // With only high-card strength, a live draw is more useful to a casual
        // player than the generic "High card" label. A five-card board is final:
        // there are no cards still to come, so never describe river high-card as a draw.
        const board = uniqueCards(boardCards || []);
        if (lower === 'high card' && board.length < 5) {
            const draw = drawPotential(holeCards || [], board);
            if (draw.flushDraw && draw.straightDraw) return 'Flush + straight ihtimali';
            if (draw.flushDraw) return 'Flush ihtimali';
            if (draw.straightDraw) return 'Straight ihtimali';
        }
        return trMadeHand(text);
    }

    // Beginner-facing postflop layer. Equity remains the underlying estimate;
    // this turns it into one short action recommendation. S/M/L are deliberately
    // broad sizes rather than exact chip amounts: ~1/3, ~1/2 and ~3/4 pot.
    function buildPostflopAdvice(holeCards, boardCards, equity, potInfo, villainCount) {
        const pct = Number(equity?.winPct);
        if (!Number.isFinite(pct)) return null;

        const hole = uniqueCards(holeCards || []);
        const board = uniqueCards(boardCards || []);
        const state = String(potInfo?.actionState || 'none').toLowerCase();
        const villains = Math.max(1, Number(villainCount || equity?.villainCount) || 1);
        const texture = classifyBoardTexture(board);
        const heroRank = bestRankFromSeven([...hole, ...board]);
        const madeCategory = heroRank ? Number(heroRank[0] || 0) : 0;
        const draw = board.length < 5 ? drawPotential(hole, board) : { strongDraw: false };

        // On a complete five-card board, detect when Hero is simply playing the
        // board. This prevents a shared straight/flush from becoming a misleading
        // value-bet recommendation just because the raw category sounds strong.
        let improvesBoard = true;
        if (board.length === 5) {
            const boardRank = bestRankFromSeven(board);
            if (boardRank && heroRank) improvesBoard = compareRankVectors(heroRank, boardRank) > 0;
        }

        const result = {
            modelVersion: POSTFLOP_ADVICE_MODEL_VERSION,
            model: POSTFLOP_ADVICE_MODEL,
            action: 'wait',
            size: '',
            label: 'WAIT',
            sizeHint: '',
            equityPct: pct,
            potOddsPct: Number.isFinite(potInfo?.potOddsPct) ? Number(potInfo.potOddsPct) : null,
            edgePct: null,
            madeCategory,
            strongDraw: !!draw.strongDraw,
            improvesBoard,
            villainCount: villains
        };

        const finish = (action, size = '') => {
            result.action = action;
            result.size = size;
            result.label = postflopAdviceLabel(result);
            result.sizeHint = postflopSizeHint(size, action);
            return result;
        };

        if (state === 'folded') return finish('folded');

        if (state === 'check') {
            // River board-only hands default to the free option. For a casual
            // player this avoids turning a shared straight/flush into a bluff.
            if (board.length === 5 && !improvesBoard) return finish('check');

            if (pct >= 88 && madeCategory >= 3) return finish('bet', 'L');
            if (pct >= 76 && madeCategory >= 2) {
                return finish('bet', texture.wetScore >= 2 ? 'L' : 'M');
            }
            if (pct >= 64 && madeCategory >= 1) return finish('bet', 'M');
            if (pct >= 54 && (madeCategory >= 1 || draw.strongDraw) && villains <= 3) {
                return finish('bet', 'S');
            }
            if (board.length < 5 && draw.strongDraw && pct >= 42 && villains <= 2) {
                return finish('bet', 'S');
            }
            return finish('check');
        }

        if (state === 'call') {
            const po = Number(potInfo?.potOddsPct);
            if (Number.isFinite(po) && po > 0) {
                const edge = pct - po;
                result.edgePct = edge;

                // Keep a small safety margin over raw pot odds for the beginner
                // recommendation instead of treating a 0.1% simulated edge as a call.
                if (edge < 5) return finish('fold');
                if (pct >= 90 && madeCategory >= 3 && edge >= 30) return finish('raise', 'L');
                if (pct >= 80 && madeCategory >= 2 && edge >= 20) return finish('raise', 'M');
                if (pct >= 70 && madeCategory >= 2 && edge >= 14 && villains <= 2) return finish('raise', 'S');
                return finish('call');
            }

            // If Torn exposes a call state but the price has not parsed yet,
            // stay conservative rather than inventing pot odds.
            if (pct >= 88 && madeCategory >= 3) return finish('raise', 'M');
            if (pct >= 62) return finish('call');
            return finish('fold');
        }

        return finish('wait');
    }

    function postflopDangerNotes(boardCards) {
        const board = uniqueCards(boardCards || []);
        if (board.length < 3) return [];
        const notes = [];

        const suits = {};
        for (const c of board) {
            const suit = cardSuitChar(c);
            if (suit) suits[suit] = (suits[suit] || 0) + 1;
        }
        const maxSuit = Object.values(suits).length ? Math.max(...Object.values(suits)) : 0;
        if (maxSuit >= 4) notes.push('Masada 4 kart aynı renk - flush büyük tehlike');
        else if (maxSuit === 3) notes.push('Masada 3 kart aynı renk - flush olabilir');

        const ranks = board.map(cardRankNum).filter(Boolean);
        const counts = {};
        for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
        const maxCount = Object.values(counts).length ? Math.max(...Object.values(counts)) : 1;
        if (maxCount >= 3) notes.push('Masada üçlü var - full house veya kare olabilir');
        else if (maxCount >= 2) notes.push('Masada çift var - üçlü veya full house olabilir');

        const uniq = [...new Set(ranks)];
        if (uniq.includes(14)) uniq.push(1);
        let bestWindow = 0;
        for (let low = 1; low <= 10; low++) {
            let have = 0;
            for (let r = low; r < low + 5; r++) if (uniq.includes(r)) have++;
            bestWindow = Math.max(bestWindow, have);
        }
        if (bestWindow >= 4) notes.push('Masadaki kartlar çok ardışık - straight büyük tehlike');
        else if (bestWindow === 3) notes.push('Masadaki kartlar ardışık - straight olabilir');

        if (!notes.length) notes.push('Masa oldukça kuru - belirgin bir flush/straight ihtimali yok');
        return notes.slice(0, 2);
    }

    function buildPostflopWhyPayload(ctx) {
        if (!ctx?.equity || !Number.isFinite(ctx.equity.winPct)) return null;
        const eq = ctx.equity;
        const advice = ctx.postflopAdvice || buildPostflopAdvice(
            ctx.holeCards, ctx.boardCards, eq, ctx.potInfo || {}, ctx.villainCount
        );
        if (!advice) return null;

        const made = compactPostflopHandLabel(ctx.holeCards, ctx.boardCards, eq.made);
        const draw = (ctx.boardCards || []).length < 5 ? drawPotential(ctx.holeCards || [], ctx.boardCards || []) : null;
        let drawText = 'Önemli bir ihtimal yok';
        if (draw?.flushDraw && draw?.straightDraw) drawText = 'Flush + straight ihtimali';
        else if (draw?.flushDraw) drawText = 'Flush ihtimali';
        else if (draw?.straightDraw) drawText = 'Straight ihtimali';

        const action = String(advice.action || '').toLowerCase();
        const po = Number(ctx.potInfo?.potOddsPct);
        let reason = '';
        if (action === 'check') reason = 'Check bedava; devam etmek için para ödemene gerek yok.';
        else if (action === 'fold') {
            reason = Number.isFinite(po)
                ? `Call için yaklaşık %${po.toFixed(1)} kazanma şansı gerekiyor; Sidearm\u2019ın tahmini %${eq.winPct.toFixed(1)}.`
                : 'Tahmini kazanma şansın, ödemen gereken miktara göre çok düşük.';
        } else if (action === 'call') {
            reason = Number.isFinite(po)
                ? `Sidearm\u2019ın tahmini kazanma şansı %${eq.winPct.toFixed(1)}; call için gereken yaklaşık %${po.toFixed(1)}.`
                : 'Elin devam etmeye yetecek kadar güçlü, ama raise yapmaya yetecek kadar değil.';
        } else if (action === 'bet' || action === 'raise') {
            const size = advice.sizeHint ? ` Önerilen miktar: ${advice.sizeHint}.` : '';
            reason = `Kazanma şansın ve elinin gücü, pota daha fazla para koymayı destekliyor.${size}`;
        } else if (action === 'folded') reason = 'Bu eli zaten fold ettin.';

        let modelText = '';
        const model = normaliseEquityModelName(eq.model, eq.villainCount);
        if (model === EQUITY_MODEL_HEADS_UP_RIVER) {
            modelText = 'River\u2019da kazanma şansı kesin: rakibin olası tüm elleri tek tek kontrol edildi.';
        } else if (Number(eq.villainCount) > 1) {
            modelText = `Kazanma şansı, oyundaki ${eq.villainCount} rakibin hepsine karşı birlikte simüle edildi.`;
        } else {
            modelText = 'Kazanma şansı, rakibin olası ellerine karşı simüle edildi.';
        }

        const historyApplied = Number(eq.opponentHistoryApplied || 0);
        const historyHands = Number(eq.opponentHistoryMaxHands || 0);
        const historyText = historyApplied > 0
            ? `Rakiplerin geçmiş oyunu tahmini sadece biraz değiştiriyor (${historyApplied} rakip, en fazla ${historyHands} gözlenen el).`
            : 'Rakiplerin geçmiş oyunu henüz hesaba katılmıyor; tahmin şu anki hamlelere ve pozisyona dayanıyor.';

        return {
            version: WHY_EXPLAINER_VERSION,
            stage: 'postflop',
            rows: [
                { label: 'Elin', value: made },
                { label: 'Gelebilecek', value: drawText },
                ...postflopDangerNotes(ctx.boardCards).map(value => ({ label: 'Dikkat', value })),
                { label: 'Neden bu hamle', value: reason }
            ],
            notes: [modelText, historyText].filter(Boolean)
        };
    }

    function buildPreflopWhyPayload(ctx) {
        if (!ctx?.holeCards || ctx.holeCards.length < 2 || !ctx.heroAction) return null;

        const action = String(ctx.heroAction || '').toLowerCase();
        const position = String(ctx.exact || ctx.position || '?');
        const depth = ctx.depthInfo || resolveStackDepth();
        const pressure = ctx.preflopPressure || null;
        const pressureText = preflopPressureShortLabel(pressure);
        const hand = canonicalHand(ctx.holeCards) || ctx.handClass || 'Bilinmeyen el';
        const handClass = ctx.handTag || ctx.handClass || 'Sınıflandırılmamış';
        const strength = String(ctx.heroStrength || ctx.heroEval?.strength || '').trim();
        const strengthText = strength ? (TR_STRENGTH[strength] || strength) : 'Bilinmiyor';
        const rangeStyle = ctx.rangeStyle || ctx.heroEval?.rangeStyle || currentPreflopRangeStyle();
        const rangeStyleText = preflopRangeStyleLabel(rangeStyle);
        const stackText = Number.isFinite(depth?.stackBB)
            ? `${Math.round(depth.stackBB)}bb · ${TR_DEPTH[depth.depth] || 'bilinmeyen'} stack`
            : `${TR_DEPTH[depth?.depth] || 'bilinmeyen'} stack`;

        let reason = '';
        if (action === 'fold') {
            if (pressure?.bucket === 'unopened' || !pressure || Number(pressure.raiseCount || 0) === 0) {
                reason = `Bu el, ${position} pozisyonundan ve bu stack büyüklüğüyle oyuna girilecek eller arasında değil.`;
            } else {
                reason = `${pressureText} karşısında bu el, ${position} pozisyonundan devam edilecek eller arasında değil.`;
            }
        } else if (action === 'check') {
            reason = 'Check bedava; Sidearm pota para koymak yerine bedava seçeneği tercih ediyor.';
        } else if (action === 'call') {
            reason = `Bu el ${pressureText} karşısında devam etmeye yetecek kadar güçlü, ama re-raise için yeterince güçlü değil.`;
        } else if (action === 'raise') {
            if (pressure?.bucket === 'limped') {
                reason = `Bu el, ${position} pozisyonundan limp yapanların üstüne raise yapmaya yetecek kadar güçlü.`;
            } else if (pressure?.bucket === 'unopened' || !pressure || Number(pressure.raiseCount || 0) === 0) {
                reason = `Bu el, ${position} pozisyonundan raise ile oyuna girilecek eller arasında.`;
            } else {
                reason = `Bu el, ${position} pozisyonundan ${pressureText} karşısında raise yapmaya yetecek kadar güçlü.`;
            }
        } else if (action === '3bet') {
            reason = `Bu el, ${pressureText} karşısında 3-bet (re-raise) yapılacak eller arasında.`;
        } else if (action === '4bet') {
            reason = `Bu el, şu ana kadarki raise\u2019lere karşı tekrar raise (4-bet+) yapmaya yetecek kadar güçlü.`;
        } else {
            reason = `Sidearm\u2019ın ${position} pozisyonu için el tablosu bu durumda ${actionVerb(action)} öneriyor.`;
        }

        let modelText = `Öneri, Sidearm\u2019ın pozisyona göre preflop el tablosuna dayanıyor (stil: ${rangeStyleText}).`;
        if (ctx.heroEval?.pressureAdjusted) {
            modelText = `Pozisyon tablosu (stil: ${rangeStyleText}) şu anki raise/call baskısına ve devam etmenin maliyetine göre ayarlandı.`;
        } else if (pressure?.bucket === 'limped') {
            modelText = `Pozisyon tablosu (stil: ${rangeStyleText}) limp yapılmış bir pota göre ayarlandı.`;
        }

        return {
            version: WHY_EXPLAINER_VERSION,
            stage: 'preflop',
            rows: [
                { label: 'El', value: `${hand} · ${handClass}` },
                { label: 'Pozisyon', value: position },
                { label: 'Baskı', value: pressureText },
                { label: 'Stack', value: stackText },
                { label: 'El stili', value: rangeStyleText },
                { label: 'Güç', value: strengthText },
                { label: 'Neden bu hamle', value: reason }
            ],
            notes: [modelText]
        };
    }

    function buildWhyPayload(ctx, stage = '') {
        const mode = String(stage || '').toLowerCase();
        if (mode === 'preflop') return buildPreflopWhyPayload(ctx);
        if (mode === 'postflop') return buildPostflopWhyPayload(ctx);
        return ctx?.preflop && !ctx?.onBoard
            ? buildPreflopWhyPayload(ctx)
            : buildPostflopWhyPayload(ctx);
    }

    function renderWhyPayload(payload) {
        if (!payload) return '';
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const notes = Array.isArray(payload.notes) ? payload.notes : [];
        return `<div class="tps-why-grid">
            ${rows.map(row => `<div><b>${escHtml(row.label)}:</b> ${escHtml(row.value)}</div>`).join('')}
            ${notes.filter(Boolean).map(note => `<div class="tps-dim">${escHtml(note)}</div>`).join('')}
        </div>`;
    }

    function buildWhyControl(ctx, stage = '') {
        const payload = buildWhyPayload(ctx, stage);
        if (!payload) return '';

        const body = renderWhyPayload(payload);
        if (!body) return '';

        const gameId = currentV6GameState()?.gameId || getCurrentGameId() || '';
        const stageKey = payload.stage === 'preflop'
            ? 'preflop'
            : (currentStreetNameForData(currentV6GameState(), ctx?.boardCards || []) || 'post');
        const key = `${gameId}|${stageKey}`;
        const open = _whyExpandedKey === key;

        return `<button type="button" class="tps-why-toggle" id="tps-why-toggle" data-why-key="${escHtml(key)}">${open ? 'Gizle' : 'Neden?'}</button>`
            + `<div class="tps-why-body${open ? ' show' : ''}" id="tps-why-body">${body}</div>`;
    }

    /**
     * Community cards only. Prefer central board containers; never use player seats.
     * Always tries several strategies (Torn mobile uses flipper___ in the board area).
     */
    function readBoardCardsFromDOM() {
        const collected = [];

        // 1) Explicit community / board wrappers
        const roots = document.querySelectorAll(
            '[class*="community___"], [class*="board___"], [class*="Community"], [class*="flop___"], [class*="turn___"], [class*="river___"], [class*="tableCards"], [class*="communityCards"], [class*="boardCards"]'
        );
        roots.forEach(root => {
            if (root.closest('[id^="player-"]')) return;
            collected.push(...cardsFromElement(root));
        });

        // 2) Face-up flippers not in a player seat (flop + turn + river)
        document.querySelectorAll('[class*="flipper___"]').forEach(flip => {
            if (flip.closest('[id^="player-"]')) return;
            if (flip.closest('[class*="self___"]')) return;
            // Skip clearly face-down backs when possible
            const cls = flip.className || '';
            if (/back___/i.test(cls) && !/front___/i.test(cls)) {
                const front = flip.querySelector('[class*="front___"]');
                if (!front) return;
            }
            const front = flip.querySelector('[class*="front___"]') || flip;
            collected.push(...cardsFromElement(front));
        });

        // 3) Fill up to 5 from any non-seat suit-rank classes (turn/river often land here)
        if (uniqueCards(collected).length < 5) {
            document.querySelectorAll('[class*="spades-"],[class*="hearts-"],[class*="diamonds-"],[class*="clubs-"]').forEach(el => {
                if (el.closest('[id^="player-"]')) return;
                for (const cls of el.classList) {
                    const c = parseCardFromClass(cls);
                    if (c) collected.push(c);
                }
            });
        }

        return uniqueCards(collected).slice(0, 5);
    }

    // Cache equity so the button does not flicker every refresh
    let _equityCache = { key: '', value: null, at: 0 };
    // UI-only state: keep the Why? explanation open across live panel refreshes,
    // but reset naturally when the hand/street key changes.
    let _whyExpandedKey = '';


    // ── Hand history (winners from table log) ─────────────────────

    const _arrayStorageCache = new Map();
    function loadStoredArray(key, filterFn = null) {
        if (_arrayStorageCache.has(key)) return _arrayStorageCache.get(key).slice();
        let arr = [];
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(parsed)) arr = filterFn ? parsed.filter(filterFn) : parsed;
        } catch (_) {}
        _arrayStorageCache.set(key, arr);
        return arr.slice();
    }
    function saveStoredArray(key, arr, maxItems) {
        const next = (Array.isArray(arr) ? arr : []).slice(0, maxItems);
        _arrayStorageCache.set(key, next);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch (_) {}
    }

    function loadHistory() {
        return loadStoredArray(HISTORY_KEY);
    }
    function saveHistory(arr) {
        saveStoredArray(HISTORY_KEY, arr, HISTORY_MAX);
    }


    function profileUrlForName(name) {
        // Resolve XID from current table seats when possible
        const seats = document.querySelectorAll('[id^="player-"]');
        const want = String(name || '').toLowerCase().trim();
        for (const el of seats) {
            const id = (el.id || '').replace(/^player-/, '');
            if (!/^\d+$/.test(id)) continue;
            const nEl = el.querySelector('[class*="name___"], [class*="userName"], [class*="Name"], [class*="name"]');
            const n = (nEl && nEl.textContent || '').trim().toLowerCase();
            if (n && (n === want || n.startsWith(want) || want.startsWith(n))) {
                return 'https://www.torn.com/profiles.php?XID=' + encodeURIComponent(id);
            }
            const a = el.querySelector('a[href*="XID="]');
            if (a && a.textContent && a.textContent.trim().toLowerCase().includes(want.split(' ')[0])) {
                const m = a.href.match(/XID=(\d+)/i);
                if (m) return 'https://www.torn.com/profiles.php?XID=' + m[1];
            }
        }
        return null;
    }

    let _histSeen = new Set(loadHistory().map(h => h.key).filter(Boolean));

    // Global result-state dedupe. A Game ID is reconciled only when its complete
    // observed award state changes. This preserves late side-pot/split-pot awards
    // without repeating expensive stats work on every refresh.
    const _processedResultStates = new Map();
    function resultStateSignature(awards, revealedHands = null) {
        const awardSig = (awards || []).map(a => [
            normalisePlayerName(a?.winner),
            Number.isFinite(a?.amount) ? a.amount : '?',
            a?.unit || '',
            Array.isArray(a?.cards) ? a.cards.join(',') : '',
            a?.didNotShow ? 'hidden' : 'shown-or-unspecified'
        ].join(':')).join('|');

        const revealSig = revealedHands instanceof Map
            ? [...revealedHands.entries()]
                .map(([key, value]) =>
                    `${key}:${(value?.cards || []).join(',')}:${value?.source || ''}`
                )
                .sort()
                .join('|')
            : '';

        return revealSig ? `${awardSig}||reveals:${revealSig}` : awardSig;
    }
    function rememberProcessedResultState(gameId, signature) {
        if (!gameId || !signature) return;
        _processedResultStates.delete(gameId);
        _processedResultStates.set(gameId, signature);
        while (_processedResultStates.size > 8) {
            _processedResultStates.delete(_processedResultStates.keys().next().value);
        }
    }


    function boardFromGameLogLines(lines) {
        const board = [];
        for (const raw of (Array.isArray(lines) ? lines : [])) {
            const line = String(raw || '').trim();
            const bm = line.match(/^The\s+(?:flop|turn|river):\s*(.+)$/i);
            if (!bm) continue;
            const found = bm[1].match(/(?:10|[2-9JQKA])[♠♥♦♣]/g) || [];
            for (const c of found) if (!board.includes(c)) board.push(c);
        }
        return board.slice(0, 5);
    }

    function preferMoreCompleteBoard(liveBoard, logBoard) {
        const live = Array.isArray(liveBoard) ? liveBoard.filter(Boolean).slice(0, 5) : [];
        const logged = Array.isArray(logBoard) ? logBoard.filter(Boolean).slice(0, 5) : [];
        return logged.length > live.length ? logged : live;
    }

    function ensurePerformanceRecordForGame(gameId) {
        const gid = String(gameId || '');
        if (!gid) return;
        if (loadHandRecords().some(r => r && r.gameId === gid)) return;

        const liveRecord = _v6Runtime.liveRecords.get(gid) ||
            (_liveHandRecord?.gameId === gid ? _liveHandRecord : null);

        if (!liveRecord || liveRecord.heroDealtVerified !== true) {
            // No preflop private-card proof = observer/showdown-only from the
            // perspective of My Stats. Do not reconstruct a record from reveals.
            return;
        }

        archiveHandRecord(liveRecord);
        _v6Runtime.liveRecords.delete(gid);
        if (_liveHandRecord?.gameId === gid) {
            _liveHandRecord = null;
        }
    }

    function scanAndRecordHistory() {
        refreshLiveLogSnapshot();

        let pendingIndex = 0;
        for (const state of _v6Runtime.games.values()) {
            if (!state.completed || !state.resultSignature) continue;
            if (_v6Runtime.finalisedSignatures.get(state.gameId) === state.resultSignature) continue;
            if (_v6Runtime.finaliseTimers.has(state.gameId)) continue;

            const delay = V6_FINALISE_DELAY_MS + (pendingIndex++ * 35);
            const timer = setTimeout(() => {
                _v6Runtime.finaliseTimers.delete(state.gameId);
                try {
                    const latest = _v6Runtime.games.get(state.gameId) || state;
                    const signature = latest.resultSignature;
                    if (!signature || _v6Runtime.finalisedSignatures.get(latest.gameId) === signature) return;

                    // Build/update the live hand record once, then perform one
                    // History write and one My Stats write for the complete state.
                    ensurePerformanceRecordForGame(latest.gameId);

                    const history = loadHistory();
                    let historyChanged = false;
                    for (const [awardIndex, award] of (latest.awards || []).entries()) {
                        const key = `${latest.gameId}|${awardIndex}|${normalisePlayerName(award.winner)}|${award.amount ?? '?'}`;
                        if (_histSeen.has(key)) continue;
                        _histSeen.add(key);

                        let playerId = null;
                        for (const p of latest.players?.values?.() || []) {
                            if (p.nameKey && p.nameKey === normalisePlayerName(award.winner)) {
                                playerId = p.id;
                                break;
                            }
                        }
                        history.unshift({
                            key,
                            gameId: latest.gameId,
                            t: Date.now(),
                            winner: award.winner,
                            amount: award.amount,
                            playerId
                        });
                        historyChanged = true;
                    }
                    if (historyChanged) saveHistory(history);

                    if (markPerformanceResult(latest.gameId, latest.awards, latest.lines)) {
                        _v6Runtime.finalisedSignatures.set(latest.gameId, signature);
                        rememberProcessedResultState(latest.gameId, signature);
                    }

                    _v6Runtime.liveRecords.delete(latest.gameId);
                    if (_liveHandRecord?.gameId === latest.gameId) {
                        _liveHandRecord = null;
                    }
                } catch (e) {
                    console.error('[TPS] V6 finalise', e);
                }
            }, delay);

            _v6Runtime.finaliseTimers.set(state.gameId, timer);
        }
    }

    function formatHistTime(ts) {
        try {
            const d = new Date(ts);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch { return ''; }
    }

    function buildHistoryHtml() {
        const arr = loadHistory();
        if (!arr.length) {
            return '<div class="tps-dim">Henüz kayıtlı el yok. Kazananlar masa kaydından alınır.</div>';
        }
        const rows = arr.map(h => {
            const amt = h.amount != null && isFinite(h.amount)
                ? ('$' + Number(h.amount).toLocaleString())
                : '-';
            const pid = h.playerId ? String(h.playerId) : '';
            const cached = pid ? _ffScoreCache[pid] : null;
            const ff = cached && cached.fair_fight != null
                ? Number(cached.fair_fight).toFixed(2)
                : (pid ? '...' : '-');
            const attackUrl = pid
                ? ('https://www.torn.com/page.php?sid=attack&user2ID=' + encodeURIComponent(pid))
                : '';
            const profileUrl = pid
                ? ('https://www.torn.com/profiles.php?XID=' + encodeURIComponent(pid))
                : '';
            let nameHtml;
            if (pid) {
                nameHtml = `<a class="tps-hist-name" href="${attackUrl}" target="_blank" rel="noopener" title="Saldır: ${escHtml(h.winner)}">${escHtml(h.winner)}</a>`;
            } else {
                nameHtml = `<span class="tps-hist-name tps-hist-nolink" data-hist-name="${escHtml(h.winner)}">${escHtml(h.winner)}</span>`;
            }
            const ffHtml = pid
                ? `<button type="button" class="tps-hist-ff" data-attack-id="${escHtml(pid)}" title="Saldır">${escHtml(ff)}</button>`
                : `<span class="tps-hist-ff muted">-</span>`;
            return `<div class="tps-hist-row">
                <span class="tps-hist-time">${escHtml(formatHistTime(h.t))}</span>
                ${nameHtml}
                ${ffHtml}
                <span class="tps-hist-amt">${escHtml(amt)}</span>
            </div>`;
        }).join('');
        return rows;
    }


    /**
     * Hero action line e.g. R3/R1C1/C1/F
     * Streets separated by / ; X=check, F=fold, R{n}=raise n BB, C{n}=call n BB
     */

    function buildHeroActionLine() {
        const state = currentV6GameState();
        return state ? heroActionLineFromState(state) : '';
    }

    function getCurrentHeroActionLine() {
        return buildHeroActionLine();
    }


    function buildCopyHandText(ctx) {
        try {
            const lines = [];
            lines.push('Torn Poker Sidearm - hand note');
            const copyGameId = getCurrentGameId();
            if (copyGameId) lines.push('Game ID: ' + copyGameId);
            const copyTable = tableContextForGame(copyGameId);
            const copyTableLabel = formatTableContextLabel(copyTable);
            if (copyTableLabel) lines.push('Table: ' + copyTableLabel);
            lines.push('Seat: ' + (ctx && (ctx.exact || ctx.position) || '?'));

            if (ctx && ctx.holeCards && ctx.holeCards.length) {
                let line = 'Cards: ' + ctx.holeCards.join(' ');
                if (ctx.handClass) line += ' (' + ctx.handClass + (ctx.handTag ? ', ' + ctx.handTag : '') + ')';
                lines.push(line);
            } else if (ctx && ctx.handClass) {
                lines.push('Cards: ' + ctx.handClass + (ctx.handTag ? ' (' + ctx.handTag + ')' : ''));
            }

            // Compact Sidearm hero action sequence, e.g. R3/R1C1/X/F.
            let acts = getCurrentHeroActionLine();
            if (!acts) acts = (ctx && ctx.actionLine) || '';
            if (acts) lines.push('Actions: ' + acts);

            if (ctx && (ctx.preflop || !ctx.onBoard) && ctx.heroAction) {
                lines.push('Advice: ' + actionVerb(ctx.heroAction) + (ctx.potLine ? ' - ' + ctx.potLine : ''));
            }
            let copyBoard = (ctx && Array.isArray(ctx.boardCards)) ? ctx.boardCards.slice() : [];
            const completedForBoard = completedRecordForGame(copyGameId);
            if (completedForBoard) {
                copyBoard = preferMoreCompleteBoard(
                    copyBoard,
                    completedForBoard.board || completedForBoard.boardCards
                );
            }
            if (copyBoard.length) {
                lines.push('Board: ' + copyBoard.join(' '));
            }
            if (ctx && ctx.equity && ctx.equity.winPct != null) {
                lines.push('Equity: ' + ctx.equity.winPct.toFixed(1) + '% (' + (ctx.equity.made || '') + ')');
            }
            if (ctx && ctx.potInfo && ctx.potInfo.potOddsPct != null) {
                lines.push('Pot odds: need ' + ctx.potInfo.potOddsPct.toFixed(1) + '% (pot ' +
                    (ctx.potInfo.pot != null ? ctx.potInfo.pot : '?') +
                    ', call ' + (ctx.potInfo.toCall != null ? ctx.potInfo.toCall : '?') + ')');
            }

            // If this Game ID has completed My Stats data, include the observed
            // result in "Copy this hand" too. During a live hand these lines are
            // simply omitted until an outcome exists.
            const completed = completedRecordForGame(copyGameId);
            if (completed) {
                const outcomeText = formatOutcomeForCopy(completed.outcome);
                if (outcomeText) lines.push('Outcome: ' + outcomeText);
                const netBBText = formatNetBBForCopy(completed.netBB);
                if (netBBText) lines.push('Your net: ' + netBBText);
            }

            const di = ctx && ctx.depthInfo;
            if (di) {
                lines.push('Stack: ' + (di.mode === 'auto' ? 'auto->' + di.depth : di.depth) +
                    (di.stackBB != null ? ' (' + Math.round(di.stackBB) + 'bb)' : ''));
            }
            lines.push('Time: ' + new Date().toISOString());
            return lines.join('\n');
        } catch (e) {
            console.error('[TPS] buildCopyHandText', e);
            return 'Torn Poker Sidearm - hand note\nUnable to build hand note.';
        }
    }

    function loadHandNotes() {
        try {
            const arr = JSON.parse(localStorage.getItem(HAND_NOTES_KEY) || '[]');
            return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()) : [];
        } catch { return []; }
    }

    function loadHandRecords() {
        return loadStoredArray(HAND_RECORDS_KEY, x => x && typeof x === 'object');
    }
    function saveHandRecords(arr) {
        saveStoredArray(HAND_RECORDS_KEY, arr, PERFORMANCE_MAX);
    }


    // ── Lightweight opponent history (BETA) ─────────────────────
    // Sidearm deliberately keeps this much smaller than a full HUD. Historical
    // behaviour only nudges a live range after a meaningful sample; current-hand
    // action/position remains the dominant signal.
    function loadOpponentHistory() {
        if (loadOpponentHistory._cache && typeof loadOpponentHistory._cache === 'object') {
            return loadOpponentHistory._cache;
        }
        let data = null;
        try { data = JSON.parse(localStorage.getItem(OPPONENT_HISTORY_KEY) || 'null'); } catch (_) {}
        if (!data || typeof data !== 'object') data = {};
        if (!data.players || typeof data.players !== 'object') data.players = {};
        if (!data.nameIndex || typeof data.nameIndex !== 'object') data.nameIndex = {};
        data.schemaVersion = OPPONENT_DATA_SCHEMA_VERSION;
        data.modelVersion = OPPONENT_MODEL_VERSION;
        loadOpponentHistory._cache = data;
        return data;
    }

    function saveOpponentHistory(data) {
        const src = data && typeof data === 'object' ? data : loadOpponentHistory();
        const entries = Object.entries(src.players || {})
            .sort((a, b) => Number(b[1]?.lastSeen || 0) - Number(a[1]?.lastSeen || 0))
            .slice(0, 500);
        src.players = Object.fromEntries(entries);
        const allowed = new Set(entries.map(([k]) => k));
        src.nameIndex = Object.fromEntries(
            Object.entries(src.nameIndex || {}).filter(([, key]) => allowed.has(key))
        );
        src.schemaVersion = OPPONENT_DATA_SCHEMA_VERSION;
        src.modelVersion = OPPONENT_MODEL_VERSION;
        src.updatedAt = Date.now();
        loadOpponentHistory._cache = src;
        try { localStorage.setItem(OPPONENT_HISTORY_KEY, JSON.stringify(src)); } catch (_) {}
    }

    function opponentHistorySummary(profile) {
        const data = loadOpponentHistory();
        const nameKey = normalisePlayerName(profile?.name || '');
        const candidates = [];
        const id = String(profile?.id || '').trim();
        if (/^\d+$/.test(id)) candidates.push('id:' + id);
        if (nameKey && data.nameIndex?.[nameKey]) candidates.push(data.nameIndex[nameKey]);
        if (nameKey) candidates.push('name:' + nameKey);

        let row = null;
        for (const key of candidates) {
            if (data.players?.[key]) { row = data.players[key]; break; }
        }
        if (!row) return null;

        const hands = Number(row.hands || 0);
        if (hands < OPPONENT_HISTORY_MIN_HANDS) return null;
        const vpipPct = 100 * Number(row.vpipHands || 0) / Math.max(1, hands);
        const pfrPct = 100 * Number(row.pfrHands || 0) / Math.max(1, hands);
        const postActions = Number(row.postflopActions || 0);
        const postAggPct = postActions >= OPPONENT_HISTORY_MIN_POSTFLOP_ACTIONS
            ? 100 * Number(row.postflopAggressive || 0) / Math.max(1, postActions)
            : null;

        let style = 'normal';
        if (vpipPct <= 18) style = 'tight';
        else if (vpipPct >= 42) style = 'loose';
        if (pfrPct >= 28 && vpipPct >= 28) style = style === 'loose' ? 'loose-aggressive' : 'aggressive';

        return {
            eligible: true,
            hands,
            vpipPct,
            pfrPct,
            postActions,
            postAggPct,
            style,
            lastSeen: Number(row.lastSeen || 0)
        };
    }

    function recordOpponentHistoryForCompletedHand(state, rec) {
        if (!state || !rec || rec.opponentHistoryRecordedVersion === OPPONENT_MODEL_VERSION) return false;
        if (!(state.players instanceof Map)) return false;

        const hero = resolveV6HeroIdentity(state);
        const heroId = String(hero.id || state.heroSeatId || '');
        const heroKey = hero.nameKey || normalisePlayerName(state.heroName || rec.heroName || '');
        const data = loadOpponentHistory();
        const preEvents = Array.isArray(state.preflopEvents) ? state.preflopEvents : [];
        const now = Date.now();
        let changed = false;

        for (const p of state.players.values()) {
            const id = String(p?.id || '').trim();
            const name = String(p?.name || '').trim();
            const nameKey = p?.nameKey || normalisePlayerName(name);
            if (!id && !nameKey) continue;
            if (p?.isHero || (heroId && id === heroId) || (heroKey && nameKey === heroKey)) continue;
            if ((p?.sittingOutAtStart || p?.waitingBBAtStart) && !playerParticipatedInCurrentHand(p, state)) continue;

            const key = /^\d+$/.test(id) ? ('id:' + id) : ('name:' + nameKey);
            const row = data.players[key] || {
                id: /^\d+$/.test(id) ? id : '',
                name,
                nameKey,
                hands: 0,
                vpipHands: 0,
                pfrHands: 0,
                postflopActions: 0,
                postflopAggressive: 0,
                showdowns: 0,
                lastSeen: 0
            };

            const events = preEvents.filter(e => e?.actorKey === nameKey);
            const voluntary = events.some(e => ['called','raised','bet','bets'].includes(String(e?.verb || '').toLowerCase()));
            const raised = events.some(e => String(e?.verb || '').toLowerCase() === 'raised');
            const live = state.villainProfiles?.get?.(nameKey) || null;
            const postCalls = Number(live?.calls || 0);
            const postChecks = Number(live?.checks || 0);
            const postBets = Number(live?.bets || 0);
            const postRaises = Number(live?.raises || 0);
            const postActions = postCalls + postChecks + postBets + postRaises;
            const postAggressive = postBets + postRaises;
            const shown = state.revealedHands instanceof Map && state.revealedHands.has(nameKey);

            row.id = row.id || (/^\d+$/.test(id) ? id : '');
            row.name = name || row.name || '';
            row.nameKey = nameKey || row.nameKey || '';
            row.hands = Number(row.hands || 0) + 1;
            if (voluntary) row.vpipHands = Number(row.vpipHands || 0) + 1;
            if (raised) row.pfrHands = Number(row.pfrHands || 0) + 1;
            row.postflopActions = Number(row.postflopActions || 0) + postActions;
            row.postflopAggressive = Number(row.postflopAggressive || 0) + postAggressive;
            if (shown) row.showdowns = Number(row.showdowns || 0) + 1;
            row.lastSeen = now;
            data.players[key] = row;
            if (nameKey) data.nameIndex[nameKey] = key;
            changed = true;
        }

        rec.opponentHistoryRecordedVersion = OPPONENT_MODEL_VERSION;
        if (changed) saveOpponentHistory(data);
        return changed;
    }

    function preflopSeatInfoForName(name, state = currentV6GameState()) {
        const target = normalisePlayerName(name);
        if (!target) return { exact: '', bucket: '' };

        if (state?.players instanceof Map && state.seatOrder?.length >= 2 && state.dealerSeatId) {
            const order = state.seatOrder.map(String);
            const dealerIdx = order.indexOf(String(state.dealerSeatId));
            if (dealerIdx >= 0) {
                for (const p of state.players.values()) {
                    if (!p?.id || !p?.name) continue;
                    if (normalisePlayerName(p.name) !== target && !namesMatch(p.name, name)) continue;
                    const idx = order.indexOf(String(p.id));
                    if (idx < 0) break;
                    const exact = exactLabelFromDist((idx - dealerIdx + order.length) % order.length, order.length);
                    return { exact, bucket: openerBucketFromSeat(exact) };
                }
            }
        }

        if (!state || liveDomMatchesGameTable(state)) {
            const map = buildNameToSeatBucket();
            for (const [n, info] of map.entries()) {
                if (normalisePlayerName(n) === target || namesMatch(n, name)) {
                    return { exact: info.exact || '', bucket: info.bucket || '' };
                }
            }
        }
        return { exact: '', bucket: '' };
    }

    function preflopParticipantCounts(state) {
        if (!state) return { playersDealt: null, villainsDealt: null, villainsAtDecision: null };

        const hero = resolveV6HeroIdentity(state);
        const heroKey = hero.nameKey || normalisePlayerName(state.heroName);
        const represented = new Set();
        let playersDealt = 0;
        let villainsDealt = 0;

        const actorIds = reconcileStructuredActorsToSeats(state);
        for (const p of (state.players?.values?.() || [])) {
            const participated = playerParticipatedInCurrentHand(p, state, actorIds);
            if ((p.sittingOutAtStart || p.waitingBBAtStart) && !participated) continue;
            playersDealt++;
            const isHero = p.isHero ||
                (hero.id && String(p.id) === String(hero.id)) ||
                (heroKey && p.nameKey === heroKey);
            if (!isHero) villainsDealt++;
            if (p.nameKey) represented.add(p.nameKey);
        }

        // Action-only participants repair an incomplete mobile seat snapshot.
        for (const key of (state.actionActorNames || [])) {
            if (!key || represented.has(key)) continue;
            if (/^(?:game|the\s+(?:preflop|flop|turn|river))$/i.test(key)) continue;
            playersDealt++;
            if (!heroKey || key !== heroKey) villainsDealt++;
            represented.add(key);
        }

        const foldsBefore = new Set(state.preflopDecision?.foldedBeforeHero || []);
        const villainsAtDecision = Math.max(0, villainsDealt - foldsBefore.size);
        return { playersDealt, villainsDealt, villainsAtDecision };
    }

    function firstHeroPreflopToken(state) {
        const a = state?.heroActions?.preflop || [];
        return a.length ? a[0] : '';
    }

    function currentStreetNameForData(state, board) {
        if (state?.street && ['flop','turn','river'].includes(state.street)) return state.street;
        const n = Array.isArray(board) ? board.length : 0;
        if (n >= 5) return 'river';
        if (n >= 4) return 'turn';
        if (n >= 3) return 'flop';
        return '';
    }

    function normaliseEquityModelName(rawModel, villainCount) {
        const raw = String(rawModel || '').trim().toLowerCase();
        if (raw === 'joint-multiway' || raw === EQUITY_MODEL_MULTIWAY) return EQUITY_MODEL_MULTIWAY;
        if (raw === 'weighted-range-river-exact' || raw === EQUITY_MODEL_HEADS_UP_RIVER) return EQUITY_MODEL_HEADS_UP_RIVER;
        if (raw === 'weighted-range' || raw === EQUITY_MODEL_HEADS_UP) return EQUITY_MODEL_HEADS_UP;
        if (raw === EQUITY_MODEL_LEGACY_MULTIWAY) return EQUITY_MODEL_LEGACY_MULTIWAY;
        return Number(villainCount) > 1 ? EQUITY_MODEL_MULTIWAY : EQUITY_MODEL_HEADS_UP;
    }

    function versionUsedJointMultiway(version) {
        const v = String(version || '').trim().toLowerCase();
        if (/^7\.5-beta(?:1|2|3|4|5)(?:\b|$)/.test(v)) return true;
        return false;
    }

    function equityMetaFromExplicitModel(explicitModel, villainCount, storedVersion = 0) {
        const model = normaliseEquityModelName(explicitModel, villainCount);
        const legacyMultiway = model === EQUITY_MODEL_LEGACY_MULTIWAY;
        const version = storedVersion || (legacyMultiway ? 1 : 2);
        return {
            model,
            version,
            calibrationGroup: legacyMultiway ? 'legacy-multiway' : (version >= EQUITY_MODEL_VERSION ? 'current' : 'prior-equity-v2')
        };
    }

    function equityModelMetaForRecord(rec, villainCountOverride = null, explicitModelOverride = '') {
        const villainCount = villainCountOverride != null && Number.isFinite(Number(villainCountOverride))
            ? Number(villainCountOverride)
            : Number(rec?.villainCount);
        const explicit = String(explicitModelOverride || rec?.equityModel || '').trim().toLowerCase();
        const storedVersion = Number(rec?.equityModelVersion) || 0;

        if (explicit) return equityMetaFromExplicitModel(explicit, villainCount, storedVersion);

        // Records without explicit model fields pre-date equity model v3.
        if (!(villainCount > 1)) {
            return { model: EQUITY_MODEL_HEADS_UP, version: storedVersion || 2, calibrationGroup: 'prior-equity-v2' };
        }

        // BETA1/BETA2 already used the joint Multi-Monty engine but pre-date
        // explicit model fields. Keep them as the v2 comparison group.
        if (versionUsedJointMultiway(rec?.sidearmVersion)) {
            return { model: EQUITY_MODEL_MULTIWAY, version: storedVersion || 2, calibrationGroup: 'prior-equity-v2' };
        }

        return { model: EQUITY_MODEL_LEGACY_MULTIWAY, version: 1, calibrationGroup: 'legacy-multiway' };
    }

    function equityModelMetaForSnapshot(rec, snapshot) {
        const villainCount = Number(snapshot?.villainCount);
        const explicit = snapshot?.equityModel || '';
        const storedVersion = Number(snapshot?.equityModelVersion) || Number(rec?.equityModelVersion) || 0;
        if (explicit) return equityMetaFromExplicitModel(explicit, villainCount, storedVersion);
        return equityModelMetaForRecord(rec, villainCount, '');
    }

    function physicalCardOverlapKeys(a, b) {
        const left = new Set((Array.isArray(a) ? a : []).map(normalizeCardKey).filter(Boolean));
        const overlap = [];
        for (const card of (Array.isArray(b) ? b : [])) {
            const key = normalizeCardKey(card);
            if (key && left.has(key) && !overlap.includes(key)) overlap.push(key);
        }
        return overlap;
    }

    function staleHoleCardsForRecord(rec) {
        const cards = Array.isArray(rec?.cards) ? rec.cards.slice(0, 2) : [];
        const board = Array.isArray(rec?.board) && rec.board.length
            ? rec.board.slice(0, 5)
            : (Array.isArray(rec?.boardCards) ? rec.boardCards.slice(0, 5) : []);
        const overlapKeys = cards.length === 2 && board.length >= 3
            ? physicalCardOverlapKeys(cards, board)
            : [];
        const stale = overlapKeys.length > 0;
        return {
            stale,
            reason: stale ? 'stale_hole_cards_sitout_transition' : '',
            overlapKeys,
            preflopDecisionFrozen: rec?.preflopDecisionFrozen === true,
            missingHeroAction: !String(rec?.preflopActualAction || rec?.preflopActualToken || '').trim()
        };
    }

    function preflopDecisionIntegrityForRecord(rec) {
        const tracked = Number(rec?.dataSchemaVersion || 0) >= 12 ||
            Object.prototype.hasOwnProperty.call(rec || {}, 'preflopDecisionFrozen');
        if (!tracked) return { valid: true, reason: '' };
        if (rec?.preflopDecisionFrozen !== true) return { valid: false, reason: 'preflop_decision_not_frozen' };
        if (!String(rec?.preflopActualAction || rec?.preflopActualToken || '').trim()) {
            return { valid: false, reason: 'missing_preflop_actual_action' };
        }
        return { valid: true, reason: '' };
    }

    function stackRawToBB(raw, tableBB) {
        if (!raw || !Number.isFinite(raw.value)) return null;
        if (raw.kind === 'bb') return raw.value;
        if (raw.kind === 'cash' && Number.isFinite(tableBB) && tableBB > 0) return raw.value / tableBB;
        return null;
    }

    function postflopStackTelemetry(ctx, state) {
        const heroStackBB = Number.isFinite(ctx?.depthInfo?.stackBB) ? Number(ctx.depthInfo.stackBB) : null;
        const tableBB = (() => { try { return detectTableBB(); } catch (_) { return null; } })();
        const villainStacks = [];
        if (state) {
            for (const p of activeVillainsFromHandState(state)) {
                try {
                    const raw = readSeatStackRaw(document.getElementById('player-' + p.id));
                    const bb = stackRawToBB(raw, tableBB);
                    if (Number.isFinite(bb) && bb >= 0) villainStacks.push(bb);
                } catch (_) {}
            }
        }
        const minVillainStackBB = villainStacks.length ? Math.min(...villainStacks) : null;
        const maxVillainStackBB = villainStacks.length ? Math.max(...villainStacks) : null;
        const effectiveStackBB = Number.isFinite(heroStackBB) && Number.isFinite(maxVillainStackBB)
            ? Math.min(heroStackBB, maxVillainStackBB) : null;
        const potBB = Number.isFinite(ctx?.potInfo?.potBB) ? Number(ctx.potInfo.potBB) : null;
        const spr = Number.isFinite(effectiveStackBB) && Number.isFinite(potBB) && potBB > 0
            ? effectiveStackBB / potBB : null;
        return { heroStackBB, minVillainStackBB, maxVillainStackBB, effectiveStackBB, spr };
    }

    function makeEquitySnapshot(ctx, state) {
        if (!ctx?.equity || !Number.isFinite(ctx.equity.winPct)) return null;
        const street = currentStreetNameForData(state, ctx.boardCards);
        if (!street) return null;
        const villainCount = Number.isFinite(ctx.equity.villainCount) ? ctx.equity.villainCount : ctx.villainCount;
        const stackTelemetry = postflopStackTelemetry(ctx, state);
        const headsUpEquityPct = Number.isFinite(ctx.equity.headsUpPct) ? ctx.equity.headsUpPct : null;
        return {
            street,
            board: Array.isArray(ctx.boardCards) ? ctx.boardCards.slice() : [],
            predictedEquityPct: ctx.equity.winPct,
            headsUpEquityPct,
            jointToPairwiseGapPct: villainCount > 1 && Number.isFinite(headsUpEquityPct)
                ? headsUpEquityPct - ctx.equity.winPct : null,
            villainCount,
            trials: Number.isFinite(ctx.equity.trials) ? Number(ctx.equity.trials) : null,
            samplingStdErrPct: Number.isFinite(ctx.equity.samplingStdErrPct) ? Number(ctx.equity.samplingStdErrPct) : null,
            villainContexts: Array.isArray(ctx.equity.villainContexts)
                ? ctx.equity.villainContexts.map(v => ({ ...v, sizeBuckets: Array.isArray(v.sizeBuckets) ? v.sizeBuckets.slice() : [] }))
                : [],
            equityModelVersion: EQUITY_MODEL_VERSION,
            equityModel: normaliseEquityModelName(ctx.equity.model, villainCount),
            opponentModelVersion: Number(ctx.equity.opponentModelVersion) || OPPONENT_MODEL_VERSION,
            opponentHistoryApplied: Number(ctx.equity.opponentHistoryApplied || 0),
            opponentHistoryMaxHands: Number(ctx.equity.opponentHistoryMaxHands || 0),
            potOddsPct: Number.isFinite(ctx.potInfo?.potOddsPct) ? ctx.potInfo.potOddsPct : null,
            potBB: Number.isFinite(ctx.potInfo?.potBB) ? Number(ctx.potInfo.potBB) : null,
            toCallBB: Number.isFinite(ctx.potInfo?.toCallBB) ? Number(ctx.potInfo.toCallBB) : null,
            potAmount: Number.isFinite(ctx.potInfo?.pot) ? Number(ctx.potInfo.pot) : null,
            toCallAmount: Number.isFinite(ctx.potInfo?.toCall) ? Number(ctx.potInfo.toCall) : null,
            heroStackBB: stackTelemetry.heroStackBB,
            minVillainStackBB: stackTelemetry.minVillainStackBB,
            maxVillainStackBB: stackTelemetry.maxVillainStackBB,
            effectiveStackBB: stackTelemetry.effectiveStackBB,
            spr: stackTelemetry.spr,
            boardTexture: ctx.equity.boardTexture || '',
            actionState: ctx.potInfo?.actionState || '',
            postflopAdviceModelVersion: POSTFLOP_ADVICE_MODEL_VERSION,
            postflopAdviceModel: POSTFLOP_ADVICE_MODEL,
            postflopAdvice: ctx.postflopAdvice?.action || '',
            postflopAdviceSize: ctx.postflopAdvice?.size || '',
            postflopAdviceLabel: ctx.postflopAdvice?.label || ''
        };
    }

    function buildHandRecord(ctx, historyText) {
        if (!ctx) return null;
        const state = currentV6GameState();
        const gameId = state?.gameId || getCurrentGameId();
        const actionLine = state?.actionLine || ctx.actionLine || '';
        const heroName = state?.heroName || getHeroName() || '';
        const heroId = String(state?.heroSeatId || getPageIdentity().id || getSelfSeatId() || '').trim();
        const tableContext = state?.tableContext || tableContextForGame(gameId);

        const pre = state?.preflopDecision || {};
        const openerInfo = preflopSeatInfoForName(pre.openerName || ctx.openerName || '', state);
        const lastRaiserInfo = preflopSeatInfoForName(pre.lastRaiserName || ctx.lastRaiserName || '', state);
        // Calibration fields must describe the first decision point, not a later
        // reopened/live pressure state. Once preflopDecision exists, derive the
        // stored pressure block strictly from that frozen snapshot.
        const pressure = state?.preflopDecision
            ? classifyPreflopPressure({
                ...pre,
                openerBucket: openerInfo.bucket || ctx.openerBucket || 'Late',
                lastRaiserBucket: lastRaiserInfo.bucket || ctx.lastRaiserBucket || openerInfo.bucket || 'Late'
            })
            : (ctx.preflopPressure || classifyPreflopPressure({
                ...pre,
                openerBucket: openerInfo.bucket || ctx.openerBucket || 'Late',
                lastRaiserBucket: lastRaiserInfo.bucket || ctx.lastRaiserBucket || openerInfo.bucket || 'Late'
            }));
        const counts = preflopParticipantCounts(state);
        const heroPlayer = [...(state?.players?.values?.() || [])].find(p => p.isHero);
        const startingStackBB = Number.isFinite(heroPlayer?.initialStackBB)
            ? heroPlayer.initialStackBB
            : (Number.isFinite(ctx.depthInfo?.stackBB) ? ctx.depthInfo.stackBB : null);
        const stackDepth = depthFromStackBB(startingStackBB) || ctx.depthInfo?.depth || '';
        const equitySnapshot = makeEquitySnapshot(ctx, state);

        const rec = {
            dataSchemaVersion: DATA_SCHEMA_VERSION,
            sidearmVersion: SIDEARM_VERSION,
            id: gameId || (String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)),
            gameId,
            heroId,
            heroName,
            heroIdentitySource: state?.heroNameSource || '',
            heroDealtVerified: false,
            heroIdentityMismatch: false,
            heroIntegrityReason: '',
            joinTransition: false,
            joinTransitionReason: '',
            staleHoleCards: false,
            staleHoleCardsReason: '',
            staleHoleCardOverlap: [],
            preflopDecisionIntegrityReason: '',
            calibrationEligible: true,
            calibrationExclusionReason: '',
            t: state?.createdAt || Date.now(),

            tableKey: tableContext?.key || '',
            tableName: tableContext?.name || '',
            tableCashBB: Number.isFinite(tableContext?.bb) ? tableContext.bb : null,
            tableDetectionSource: tableContext?.source || '',

            cards: Array.isArray(ctx.holeCards) ? ctx.holeCards.slice() : [],
            board: Array.isArray(ctx.boardCards) ? ctx.boardCards.slice() : [],
            seat: ctx.exact || '',
            position: ctx.position || '',
            stackBB: ctx.depthInfo?.stackBB ?? null,
            actionLine,
            history: state?.lines?.length ? state.lines.join('\n') : String(historyText || ''),
            handClass: ctx.handClass || '',
            handTag: ctx.handTag || '',
            heroAction: ctx.heroAction || '',
            heroStrength: ctx.heroStrength || '',
            openerBucket: ctx.openerBucket || '',
            facingRaise: !!ctx.facingRaise,

            // Preflop decision dataset. It remains live until the hero's first
            // voluntary action, then updateLiveHandNote freezes the whole block.
            preflopDecisionFrozen: false,
            preflopStrategyVersion: PREFLOP_STRATEGY_VERSION,
            preflopRangeStyle: ctx.rangeStyle || ctx.heroEval?.rangeStyle || currentPreflopRangeStyle(),
            preflopRangeStyleAdjusted: !!ctx.heroEval?.rangeStyleAdjusted,
            preflopBalancedBaselineAction: ctx.heroEval?.balancedBaselineAction || ctx.heroAction || '',
            preflopBalancedBaselineStrength: ctx.heroEval?.balancedBaselineStrength || ctx.heroStrength || '',
            preflopAdvice: ctx.heroAction || '',
            preflopAdviceStrength: ctx.heroStrength || '',
            preflopHandGroup: ctx.heroEval?.handGroup || v7HandGroup(ctx.holeCards, ctx.heroEval),
            preflopHeroSeat: ctx.exact || '',
            preflopHeroPosition: ctx.position || '',
            preflopStackBB: startingStackBB,
            preflopStackDepth: stackDepth,
            preflopFacingRaise: (pre.raiseCount || 0) > 0,
            preflopRaiseCountBeforeHero: pre.raiseCount || 0,
            preflopCallCountBeforeHero: pre.callCount || 0,
            preflopFoldCountBeforeHero: pre.foldCount || 0,
            preflopOpenerName: pre.openerName || '',
            preflopOpenerSeat: openerInfo.exact || '',
            preflopOpenerBucket: openerInfo.bucket || ctx.openerBucket || '',
            preflopLastRaiserName: pre.lastRaiserName || '',
            preflopLastRaiserSeat: lastRaiserInfo.exact || '',
            preflopLastRaiserBucket: lastRaiserInfo.bucket || ctx.lastRaiserBucket || openerInfo.bucket || '',
            preflopPressureBucket: pressure.bucket || '',
            preflopPressureScore: pressure.score ?? null,
            preflopHighestBetBB: pressure.highestBetBB ?? null,
            preflopHeroCommittedBB: pressure.heroCommittedBB ?? null,
            preflopCostToContinueBB: pressure.costToContinueBB ?? null,
            preflopOpenRaiseToBB: pressure.openRaiseToBB ?? null,
            preflopLastRaiseToBB: pressure.lastRaiseToBB ?? null,
            preflopSequenceBeforeHero: Array.isArray(pre.sequenceBeforeHero)
                ? pre.sequenceBeforeHero.join(' | ') : '',
            preflopActualAction: pre.actualAction || '',
            preflopActualToken: firstHeroPreflopToken(state),
            preflopHeroActed: !!pre.heroActed,
            preflopPlayersDealt: counts.playersDealt,
            preflopVillainsDealt: counts.villainsDealt,
            preflopVillainsAtDecision: counts.villainsAtDecision,

            boardCards: Array.isArray(ctx.boardCards) ? ctx.boardCards.slice() : [],
            potInfo: ctx.potInfo || null,
            predictedEquityPct: Number.isFinite(ctx.equity?.winPct) ? ctx.equity.winPct : null,
            headsUpEquityPct: Number.isFinite(ctx.equity?.headsUpPct) ? ctx.equity.headsUpPct : null,
            jointToPairwiseGapPct: Number(ctx.equity?.villainCount) > 1 && Number.isFinite(ctx.equity?.headsUpPct) && Number.isFinite(ctx.equity?.winPct)
                ? ctx.equity.headsUpPct - ctx.equity.winPct : null,
            equityTrials: Number.isFinite(ctx.equity?.trials) ? Number(ctx.equity.trials) : null,
            equitySamplingStdErrPct: Number.isFinite(ctx.equity?.samplingStdErrPct) ? Number(ctx.equity.samplingStdErrPct) : null,
            villainContexts: Array.isArray(ctx.equity?.villainContexts)
                ? ctx.equity.villainContexts.map(v => ({ ...v, sizeBuckets: Array.isArray(v.sizeBuckets) ? v.sizeBuckets.slice() : [] }))
                : [],
            villainCount: Number.isFinite(ctx.equity?.villainCount)
                ? ctx.equity.villainCount
                : (state ? countLiveVillains(state) : null),
            equityModelVersion: EQUITY_MODEL_VERSION,
            equityModel: normaliseEquityModelName(
                ctx.equity?.model,
                Number.isFinite(ctx.equity?.villainCount)
                    ? ctx.equity.villainCount
                    : (state ? countLiveVillains(state) : null)
            ),
            opponentModelVersion: Number(ctx.equity?.opponentModelVersion) || OPPONENT_MODEL_VERSION,
            opponentHistoryApplied: Number(ctx.equity?.opponentHistoryApplied || 0),
            opponentHistoryMaxHands: Number(ctx.equity?.opponentHistoryMaxHands || 0),
            opponentHistoryRecordedVersion: 0,
            postflopAdviceModelVersion: POSTFLOP_ADVICE_MODEL_VERSION,
            postflopAdviceModel: POSTFLOP_ADVICE_MODEL,
            postflopAdvice: ctx.postflopAdvice?.action || '',
            postflopAdviceSize: ctx.postflopAdvice?.size || '',
            postflopAdviceLabel: ctx.postflopAdvice?.label || '',
            boardTexture: ctx.equity?.boardTexture ||
                (ctx.boardCards?.length >= 3 ? classifyBoardTexture(ctx.boardCards).label : ''),
            potOddsPct: Number.isFinite(ctx.potInfo?.potOddsPct) ? ctx.potInfo.potOddsPct : null,
            equitySnapshots: {},
            revealedHands: {},
            awards: [],
            awardWinnerCount: 0,
            hiddenAwardWinnerCount: 0,
            foldedRiverResult: '',
            foldedRiverReason: '',
            foldedComparedHandCount: 0,
            foldedComparisonWinner: '',
            foldedComparisonWinnerCards: [],
            foldedHeroFinalHand: '',
            foldedWinnerFinalHand: '',
            financialHeroName: '',
            financialHeroSource: '',
            financialUnit: '',
            financialWarning: '',
            investedBB: null,
            returnedBB: null,
            outcome: '', winner: '', wonAmount: null, wonAmountUnit: '', completedAt: null
        };

        if (equitySnapshot) rec.equitySnapshots[equitySnapshot.street] = equitySnapshot;
        return rec;
    }


    function heroFinancialsForGame(gameId, heroName, wonAmount, gameLines = null, heroAwards = null) {
        const gid = String(gameId || '');
        const state = _v6Runtime.games.get(gid);
        const hero = normalisePlayerName(heroName);
        const entries = state?.entries?.length
            ? state.entries
            : (Array.isArray(gameLines) ? gameLines : getGameLogLines(gid)).map(line => {
                const m = String(line || '').match(/^(.+?)\s+(.*)$/);
                return { actor: m?.[1] || '', body: m?.[2] || '', line: String(line || '') };
            });

        const currentState = currentV6GameState();
        const detectedBB = state?.bbInfo?.amount > 0
            ? { ...state.bbInfo, source: 'game-state' }
            : (Number.isFinite(state?.tableContext?.bb) && state.tableContext.bb > 0
                ? { amount: state.tableContext.bb, unit: 'cash', source: state.tableContext.source || 'table-context' }
                : (currentState?.gameId === gid ? detectBBFromLog() : null));
        const tableContext = state?.tableContext || null;
        const bbInfo = state?.bbInfo || detectedBB;
        const bbCash = state?.bbInfo?.unit === 'cash' && state.bbInfo.amount > 0
            ? state.bbInfo.amount
            : (Number.isFinite(tableContext?.bb) && tableContext.bb > 0
                ? tableContext.bb
                : (detectedBB?.unit === 'cash' && detectedBB.amount > 0
                    ? detectedBB.amount
                    : null));
        const nativeUnit = state?.bbInfo?.unit === 'bb'
            ? 'bb'
            : (state?.bbInfo?.unit === 'cash'
                ? 'cash'
                : (bbInfo?.unit === 'bb' ? 'bb' : (bbCash ? 'cash' : '')));

        const committedCash = { preflop: 0, flop: 0, turn: 0, river: 0 };
        const committedBB = { preflop: 0, flop: 0, turn: 0, river: 0 };
        let street = 'preflop';

        let investedCash = 0;
        let investedBB = 0;
        let hasCashLedger = !!bbCash;
        let hasBBLedger = bbInfo?.unit === 'bb' || !!bbCash;

        let refundsCash = 0;
        let refundsBB = 0;
        const contributions = [];

        const amountInfo = raw => {
            const p = parseLogAmount(raw);
            let cash = p.cash;
            let bb = p.bb;

            if (bb != null && bbCash != null) cash = bb * bbCash;
            if (cash != null && bbCash != null) bb = cash / bbCash;

            return {
                cash: Number.isFinite(cash) ? cash : null,
                bb: Number.isFinite(bb) ? bb : null,
                sourceUnit: p.bb != null ? 'bb' : (p.cash != null ? 'cash' : '')
            };
        };

        const addContribution = (action, info) => {
            if (!info) return;
            if (Number.isFinite(info.cash)) {
                investedCash += info.cash;
                committedCash[street] += info.cash;
            } else {
                hasCashLedger = false;
            }
            if (Number.isFinite(info.bb)) {
                investedBB += info.bb;
                committedBB[street] += info.bb;
            } else {
                hasBBLedger = false;
            }

            contributions.push({
                action,
                amount: info.sourceUnit === 'bb' ? info.bb : info.cash,
                unit: info.sourceUnit || nativeUnit || '',
                amountCash: Number.isFinite(info.cash) ? info.cash : null,
                amountBB: Number.isFinite(info.bb) ? info.bb : null
            });
        };

        const addRaiseTo = targetInfo => {
            if (!targetInfo) return;

            let deltaCash = null;
            let deltaBB = null;

            if (Number.isFinite(targetInfo.cash)) {
                deltaCash = Math.max(0, targetInfo.cash - committedCash[street]);
            }
            if (Number.isFinite(targetInfo.bb)) {
                deltaBB = Math.max(0, targetInfo.bb - committedBB[street]);
            }

            if (deltaCash == null && deltaBB == null) return;

            if (deltaCash != null) {
                investedCash += deltaCash;
                committedCash[street] += deltaCash;
            } else {
                hasCashLedger = false;
            }

            if (deltaBB != null) {
                investedBB += deltaBB;
                committedBB[street] += deltaBB;
            } else {
                hasBBLedger = false;
            }

            contributions.push({
                action: 'raised',
                amount: targetInfo.sourceUnit === 'bb' ? deltaBB : deltaCash,
                unit: targetInfo.sourceUnit || nativeUnit || '',
                amountCash: deltaCash,
                amountBB: deltaBB
            });
        };

        for (const e of entries) {
            const actor = String(e.actor || '').trim();
            const body = String(e.body || '').trim();
            const line = String(e.line || '').trim();
            const marker = `${actor} ${body}`.trim();

            if (/^the flop\b/i.test(marker)) { street = 'flop'; continue; }
            if (/^the turn\b/i.test(marker)) { street = 'turn'; continue; }
            if (/^the river\b/i.test(marker)) { street = 'river'; continue; }

            const actorKey = normalisePlayerName(actor);
            const isHero = hero && actorKey === hero;

            if (isHero) {
                let m = body.match(/^posted\s+(?:small|big)\s+blind\s+(.+)$/i);
                if (m) {
                    addContribution('blind', amountInfo(m[1]));
                    continue;
                }

                m = body.match(/^called\s+(.+)$/i);
                if (m) {
                    addContribution('called', amountInfo(m[1]));
                    continue;
                }

                m = body.match(/^(?:bet|bets)\s+(.+)$/i);
                if (m) {
                    addContribution('bet', amountInfo(m[1]));
                    continue;
                }

                m = body.match(/^raised\s+(.+)$/i);
                if (m) {
                    const toM = m[1].match(/\bto\s+(\$?[\d,.]+(?:\.\d+)?(?:\s*BB|\s*[KMB])?)/i);
                    const firstM = m[1].match(/(\$?[\d,.]+(?:\.\d+)?(?:\s*BB|\s*[KMB])?)/i);

                    // "raised X to Y": Y is total commitment on this street.
                    if (toM) addRaiseTo(amountInfo(toM[1]));
                    else if (firstM) addContribution('raised', amountInfo(firstM[1]));
                    continue;
                }

                m = body.match(/^(?:returned|uncalled.*returned)\s+(\$?[\d,.]+(?:\.\d+)?(?:\s*BB|\s*[KMB])?)/i);
                if (m) {
                    const info = amountInfo(m[1]);
                    if (Number.isFinite(info.cash)) refundsCash += info.cash;
                    if (Number.isFinite(info.bb)) refundsBB += info.bb;
                    continue;
                }
            }

            // Some Torn layouts render "uncalled bet ... returned to NAME" as
            // a system row with no actor.
            const ret = line.match(/uncalled.*?(\$?[\d,.]+(?:\.\d+)?(?:\s*BB|\s*[KMB])?).*?returned\s+to\s+(.+)$/i);
            if (ret && normalisePlayerName(ret[2]) === hero) {
                const info = amountInfo(ret[1]);
                if (Number.isFinite(info.cash)) refundsCash += info.cash;
                if (Number.isFinite(info.bb)) refundsBB += info.bb;
            }
        }

        // Awards carry an explicit unit from the V6 parser in v6.14. For an
        // older/fallback award without one, the table's blind unit is the safest
        // interpretation because Torn renders a hand consistently.
        let awardCash = 0;
        let awardBB = 0;
        let awardsHaveCash = true;
        let awardsHaveBB = true;

        const awardList = Array.isArray(heroAwards) ? heroAwards : [];
        if (awardList.length) {
            for (const a of awardList) {
                if (!Number.isFinite(a?.amount)) continue;
                const unit = a.unit || nativeUnit;

                if (unit === 'bb') {
                    awardBB += a.amount;
                    if (bbCash != null) awardCash += a.amount * bbCash;
                    else awardsHaveCash = false;
                } else if (unit === 'cash') {
                    awardCash += a.amount;
                    if (bbCash != null) awardBB += a.amount / bbCash;
                    else awardsHaveBB = false;
                } else {
                    awardsHaveCash = false;
                    awardsHaveBB = false;
                }
            }
        } else if (Number.isFinite(wonAmount) && wonAmount > 0) {
            // Compatibility path for a legacy caller.
            if (nativeUnit === 'bb') {
                awardBB = wonAmount;
                if (bbCash != null) awardCash = wonAmount * bbCash;
                else awardsHaveCash = false;
            } else if (nativeUnit === 'cash') {
                awardCash = wonAmount;
                if (bbCash != null) awardBB = wonAmount / bbCash;
                else awardsHaveBB = false;
            }
        }

        const returnedCash = (awardsHaveCash ? awardCash : 0) + refundsCash;
        const returnedBB = (awardsHaveBB ? awardBB : 0) + refundsBB;

        const cashKnown = hasCashLedger && awardsHaveCash;
        const bbKnown = hasBBLedger && awardsHaveBB;

        const netCash = cashKnown ? returnedCash - investedCash : null;
        const netBB = bbKnown ? returnedBB - investedBB : null;

        return {
            financialUnit: nativeUnit || (bbKnown ? 'bb' : (cashKnown ? 'cash' : '')),
            tableBB: bbCash,
            invested: cashKnown ? investedCash : null,
            returned: cashKnown ? returnedCash : null,
            refunds: hasCashLedger ? refundsCash : null,
            net: netCash,
            investedBB: bbKnown ? investedBB : null,
            returnedBB: bbKnown ? returnedBB : null,
            refundsBB: hasBBLedger ? refundsBB : null,
            netBB,
            contributions
        };
    }

    function heroFoldedInGame(gameId, heroName, gameLines = null) {
        const state = _v6Runtime.games.get(String(gameId || ''));
        if (state) return !!state.heroFolded;
        if (!gameId || !heroName) return false;
        const hero = normalisePlayerName(heroName);
        return (Array.isArray(gameLines) ? gameLines : getGameLogLines(gameId)).some(line => {
            const m = String(line || '').match(/^(.+?)\s+folded\b/i);
            return !!(m && normalisePlayerName(m[1]) === hero);
        });
    }

    function serialiseRevealedHands(state) {
        const out = {};
        if (!(state?.revealedHands instanceof Map)) return out;
        for (const [key, value] of state.revealedHands.entries()) {
            const cards = Array.isArray(value?.cards) ? value.cards.slice(0, 2) : [];
            if (cards.length !== 2) continue;
            out[key] = {
                name: value?.name || key,
                cards,
                actorId: value?.actorId || '',
                source: value?.source || ''
            };
        }
        return out;
    }

    function serialiseAwards(awards) {
        return (awards || []).map(a => ({
            winner: String(a?.winner || '').trim(),
            amount: Number.isFinite(a?.amount) ? a.amount : null,
            unit: a?.unit || '',
            cards: Array.isArray(a?.cards) ? a.cards.slice(0, 2) : [],
            didNotShow: !!a?.didNotShow
        }));
    }

    function revealedHandEntries(source) {
        if (!source) return [];

        let value = source;
        if (typeof value === 'string') {
            try { value = JSON.parse(value); }
            catch (_) { return []; }
        }

        const entries = value instanceof Map
            ? [...value.entries()]
            : Object.entries(value || {});

        return entries.map(([key, hand]) => ({
            key: normalisePlayerName(key || hand?.name),
            name: String(hand?.name || key || '').trim(),
            cards: Array.isArray(hand?.cards) ? hand.cards.slice(0, 2) : [],
            source: hand?.source || ''
        })).filter(h => h.key && h.cards.length === 2);
    }

    function uncappedUniqueCardKeys(cards) {
        const seen = new Set();
        for (const card of cards || []) {
            const key = normalizeCardKey(card);
            if (key && RANK_NUM[key.slice(0, -1)]) seen.add(key);
        }
        return [...seen];
    }

    function exactOracleEquityVsFixedHands(heroCards, boardCards, opponentHands) {
        const hero = Array.isArray(heroCards) ? heroCards.slice(0, 2) : [];
        const board = Array.isArray(boardCards) ? boardCards.slice(0, 5) : [];
        const opponents = (Array.isArray(opponentHands) ? opponentHands : [])
            .filter(h => Array.isArray(h?.cards) && h.cards.length === 2)
            .map(h => ({ name: h.name || '', cards: h.cards.slice(0, 2) }));
        if (hero.length !== 2 || board.length < 3 || board.length > 5 || !opponents.length) return null;
        const allKnown = [...hero, ...board, ...opponents.flatMap(h => h.cards)];
        const keys = allKnown.map(normalizeCardKey).filter(Boolean);
        if (keys.length !== allKnown.length || new Set(keys).size !== keys.length) return null;
        const used = new Set(keys);
        const deck = buildFullDeck().filter(c => !used.has(normalizeCardKey(c)));
        const need = 5 - board.length;
        let shares = 0, runouts = 0, wins = 0, ties = 0, losses = 0;
        const scoreRunout = extra => {
            const fullBoard = board.concat(extra || []);
            const heroRank = bestRankFromSeven(hero.concat(fullBoard));
            if (!heroRank) return;
            let beaten = false, tiedOpponents = 0;
            for (const opp of opponents) {
                const rank = bestRankFromSeven(opp.cards.concat(fullBoard));
                if (!rank) return;
                const cmp = compareRankVectors(heroRank, rank);
                if (cmp < 0) beaten = true;
                else if (cmp === 0) tiedOpponents++;
            }
            runouts++;
            if (beaten) { losses++; return; }
            if (tiedOpponents > 0) { ties++; shares += 1 / (tiedOpponents + 1); }
            else { wins++; shares += 1; }
        };
        if (need === 0) scoreRunout([]);
        else if (need === 1) { for (const c of deck) scoreRunout([c]); }
        else if (need === 2) {
            for (let i = 0; i < deck.length - 1; i++) {
                for (let j = i + 1; j < deck.length; j++) scoreRunout([deck[i], deck[j]]);
            }
        } else return null;
        if (!runouts) return null;
        return { equityPct: 100 * shares / runouts, runouts, wins, ties, losses, opponentCount: opponents.length };
    }

    function oracleEquityForSnapshot(rec, snapshot) {
        const expectedOpponents = Number(snapshot?.villainCount);
        const empty = reason => ({
            equityPct: null, opponentCount: 0, expectedOpponentCount: Number.isFinite(expectedOpponents) ? expectedOpponents : null,
            complete: false, runouts: 0, reason
        });
        if (!rec || !snapshot || !Array.isArray(snapshot.board) || snapshot.board.length < 3) return empty('snapshot_unavailable');
        if (staleHoleCardsForRecord(rec).stale) return empty('stale_hole_cards_sitout_transition');
        const heroCards = Array.isArray(rec.cards) ? rec.cards.slice(0, 2) : [];
        const heroKey = normalisePlayerName(rec.heroName || rec.hero || '');
        const shown = revealedHandEntries(rec.revealedHands).filter(h => h.key !== heroKey && !sameTwoCards(h.cards, heroCards));
        if (!shown.length) return empty('no_opponent_hands_shown');
        const exact = exactOracleEquityVsFixedHands(heroCards, snapshot.board, shown);
        if (!exact) return empty('invalid_or_overlapping_revealed_cards');
        const complete = Number.isFinite(expectedOpponents) && expectedOpponents > 0
            ? exact.opponentCount === expectedOpponents : false;
        return {
            equityPct: exact.equityPct, opponentCount: exact.opponentCount,
            expectedOpponentCount: Number.isFinite(expectedOpponents) ? expectedOpponents : null,
            complete, runouts: exact.runouts,
            reason: complete ? 'complete_revealed_field' : 'partial_revealed_field'
        };
    }

    function hiddenAwardWinnerCount(awards, revealedHands) {
        const shownKeys = new Set(revealedHandEntries(revealedHands).map(h => h.key));
        const winners = [...new Set(
            (awards || []).map(a => normalisePlayerName(a?.winner)).filter(Boolean)
        )];
        return winners.filter(key => !shownKeys.has(key)).length;
    }


    function evaluateFoldedRiverComparison(rec, revealedHands, finalBoard) {
        const result = (value, reason, extra = {}) => ({
            result: value,
            reason,
            winner: extra.winner || '',
            winnerCards: extra.winnerCards || [],
            heroFinalHand: extra.heroFinalHand || '',
            winnerFinalHand: extra.winnerFinalHand || '',
            comparedCount: extra.comparedCount || 0
        });

        if (!rec || rec.outcome !== 'fold') return result('', 'not_folded');

        const heroCards = Array.isArray(rec.cards) ? rec.cards.slice(0, 2) : [];
        const board = Array.isArray(finalBoard) ? finalBoard.slice(0, 5) : [];
        if (physicalCardOverlapKeys(heroCards, board).length) {
            return result('unknown', 'stale_hole_cards_sitout_transition');
        }
        if (heroCards.length !== 2) return result('unknown', 'hero_cards_missing');
        if (board.length !== 5) return result('unknown', 'incomplete_final_board');
        if (uncappedUniqueCardKeys([...heroCards, ...board]).length !== 7) {
            return result('unknown', 'invalid_hero_or_board_cards');
        }

        const heroKey = normalisePlayerName(rec.heroName || rec.hero || '');
        const shown = revealedHandEntries(revealedHands).filter(h =>
            h.key !== heroKey && !sameTwoCards(h.cards, heroCards)
        );
        if (!shown.length) return result('unknown', 'no_opponent_hands_shown');

        const heroRank = bestRankFromSeven([...heroCards, ...board]);
        if (!heroRank) return result('unknown', 'hand_evaluation_failed');

        const comparisons = [];
        for (const hand of shown) {
            // Hero 2 + opponent 2 + board 5 must be nine distinct physical cards.
            if (uncappedUniqueCardKeys([...heroCards, ...hand.cards, ...board]).length !== 9) {
                return result('unknown', 'invalid_or_overlapping_cards');
            }

            const rank = bestRankFromSeven([...hand.cards, ...board]);
            if (!rank) return result('unknown', 'hand_evaluation_failed');

            comparisons.push({
                ...hand,
                rank,
                cmp: compareRankVectors(heroRank, rank)
            });
        }

        let strongest = comparisons[0];
        for (const c of comparisons.slice(1)) {
            if (compareRankVectors(c.rank, strongest.rank) > 0) strongest = c;
        }

        const tiedStrongest = comparisons.filter(c =>
            compareRankVectors(c.rank, strongest.rank) === 0
        );
        const bestNames = tiedStrongest.map(c => c.name).filter(Boolean).join(' / ');

        let comparison;
        if (comparisons.some(c => c.cmp < 0)) {
            comparison = 'would_lose_to_shown_hand';
        } else if (comparisons.some(c => c.cmp === 0)) {
            comparison = 'would_tie_best_shown_hand';
        } else {
            comparison = 'would_beat_all_shown_hands';
        }

        return result(comparison, `compared_${comparisons.length}_shown_hands`, {
            winner: bestNames || strongest.name,
            winnerCards: strongest.cards,
            heroFinalHand: HAND_CAT_NAMES[heroRank[0]] || 'Unknown',
            winnerFinalHand: HAND_CAT_NAMES[strongest.rank[0]] || 'Unknown',
            comparedCount: comparisons.length
        });
    }

    function foldedComparisonForRecord(rec) {
        if (!rec || rec.outcome !== 'fold') {
            return {
                result: '', reason: 'not_folded', winner: '', winnerCards: [],
                heroFinalHand: '', winnerFinalHand: '', comparedCount: 0
            };
        }

        if (staleHoleCardsForRecord(rec).stale) {
            return {
                result: 'unknown', reason: 'stale_hole_cards_sitout_transition', winner: '', winnerCards: [],
                heroFinalHand: '', winnerFinalHand: '', comparedCount: 0
            };
        }

        const currentValues = new Set([
            'would_beat_all_shown_hands',
            'would_lose_to_shown_hand',
            'would_tie_best_shown_hand'
        ]);
        if (currentValues.has(rec.foldedRiverResult)) {
            return {
                result: rec.foldedRiverResult,
                reason: rec.foldedRiverReason || '',
                winner: rec.foldedComparisonWinner || '',
                winnerCards: Array.isArray(rec.foldedComparisonWinnerCards)
                    ? rec.foldedComparisonWinnerCards : [],
                heroFinalHand: rec.foldedHeroFinalHand || '',
                winnerFinalHand: rec.foldedWinnerFinalHand || '',
                comparedCount: Number(rec.foldedComparedHandCount) || 0
            };
        }

        return evaluateFoldedRiverComparison(
            rec,
            rec.revealedHands,
            rec.board || rec.boardCards || []
        );
    }

    function expectedHeroIdentity() {
        const page = getPageIdentity();
        const id = String(page?.id || getSelfSeatId() || '').trim();
        const remembered = id ? getRememberedHeroNameForId(id) : getRememberedHeroName();
        const name = String(page?.name || remembered || '').replace(/\s+/g, ' ').trim();
        return {
            id,
            name,
            nameKey: normalisePlayerName(name),
            source: page?.id && page?.name ? 'page-identity' : (name ? 'id-bound-memory' : 'none')
        };
    }

    function joinTransitionForRecord(rec) {
        const action = String(rec?.preflopActualAction || '').trim().toLowerCase();
        const seat = String(rec?.preflopHeroSeat || rec?.seat || '').trim().toUpperCase();
        const nonBlindSeat = !!seat && seat !== 'SB' && seat !== 'BB';

        // Buying into Torn can require a dead/full blind from a non-blind seat.
        // Preserve those hands for financial/history purposes, but do not treat
        // their forced starting money as a normal positional preflop decision.
        const blindContribution = (() => {
            const c = rec?.contributions;
            if (Array.isArray(c)) {
                return c.some(x => String(x?.action || '').toLowerCase() === 'blind');
            }
            return /\bblind\s*:/i.test(String(c || ''));
        })();
        const committedBeforeAction = Number(rec?.preflopHeroCommittedBB);
        if (nonBlindSeat && (blindContribution || (Number.isFinite(committedBeforeAction) && committedBeforeAction >= 0.5))) {
            return {
                joinTransition: true,
                reason: 'non_blind_forced_blind_table_entry'
            };
        }

        // A voluntary preflop CHECK is only possible from the BB when there is
        // nothing to call. Keep this older transitional-state signature too.
        const impossibleCheck = action === 'checked' && !!seat && seat !== 'BB';
        return {
            joinTransition: impossibleCheck,
            reason: impossibleCheck ? 'non_bb_preflop_check_table_entry' : ''
        };
    }

    function heroIntegrityForRecord(rec, expected = expectedHeroIdentity()) {
        const expectedId = String(expected?.id || '').trim();
        const expectedKey = String(expected?.nameKey || normalisePlayerName(expected?.name || '') || '');
        const recordId = String(rec?.heroId || '').trim();
        const observedName = String(rec?.financialHeroName || rec?.heroName || '').replace(/\s+/g, ' ').trim();
        const observedKey = normalisePlayerName(observedName);

        if (expectedId && recordId && expectedId !== recordId) {
            return { mismatch: true, reason: 'hero_id_mismatch', expectedId, expectedName: expected?.name || '', observedName };
        }
        if (expectedKey && observedKey && expectedKey !== observedKey) {
            return { mismatch: true, reason: 'hero_name_mismatch', expectedId, expectedName: expected?.name || '', observedName };
        }
        return { mismatch: false, reason: '', expectedId, expectedName: expected?.name || '', observedName };
    }

    function calibrationEligibilityForRecord(rec, expected = expectedHeroIdentity()) {
        const integrity = heroIntegrityForRecord(rec, expected);
        const join = joinTransitionForRecord(rec);
        const stale = staleHoleCardsForRecord(rec);
        const decision = preflopDecisionIntegrityForRecord(rec);
        if (integrity.mismatch) return { eligible: false, reason: integrity.reason, integrity, join, stale, decision };
        if (stale.stale) return { eligible: false, reason: stale.reason, integrity, join, stale, decision };
        if (join.joinTransition) return { eligible: false, reason: join.reason, integrity, join, stale, decision };
        if (!decision.valid) return { eligible: false, reason: decision.reason, integrity, join, stale, decision };
        return { eligible: true, reason: '', integrity, join, stale, decision };
    }

    function refreshRecordIntegrityFlags(rec, expected = expectedHeroIdentity()) {
        if (!rec) return null;
        const status = calibrationEligibilityForRecord(rec, expected);
        rec.heroIdentityMismatch = !!status.integrity.mismatch;
        rec.heroIntegrityReason = status.integrity.reason || '';
        rec.joinTransition = !!status.join.joinTransition;
        rec.joinTransitionReason = status.join.reason || '';
        rec.staleHoleCards = !!status.stale.stale;
        rec.staleHoleCardsReason = status.stale.reason || '';
        rec.staleHoleCardOverlap = Array.isArray(status.stale.overlapKeys) ? status.stale.overlapKeys.slice() : [];
        rec.preflopDecisionIntegrityReason = status.decision.reason || '';
        rec.calibrationEligible = !!status.eligible;
        rec.calibrationExclusionReason = status.reason || '';
        return status;
    }

    function sameTwoCards(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) return false;
        const aa = a.map(normalizeCardKey).filter(Boolean).sort();
        const bb = b.map(normalizeCardKey).filter(Boolean).sort();
        return aa.length === 2 && bb.length === 2 && aa[0] === bb[0] && aa[1] === bb[1];
    }

    function resolveFinancialHeroIdentity(rec, state) {
        const allowLiveDom = !state || liveDomMatchesGameTable(state);
        const selfId = String(state?.heroSeatId || (allowLiveDom ? getSelfSeatId() : '') || '');

        if (selfId && state?.entries?.length) {
            const e = state.entries.find(x =>
                String(x?.actorId || '') === selfId && String(x?.actor || '').trim()
            );
            if (e) {
                const name = String(e.actor).replace(/\s+/g, ' ').trim();
                if (name) return { name, source: 'log/self-id' };
            }
        }

        if (Array.isArray(rec?.cards) && rec.cards.length === 2 &&
            state?.revealedHands instanceof Map) {
            const matches = [...state.revealedHands.values()].filter(v =>
                sameTwoCards(rec.cards, v?.cards)
            );
            if (matches.length === 1) {
                const name = String(matches[0]?.name || '').replace(/\s+/g, ' ').trim();
                if (name) return { name, source: 'revealed-card-match' };
            }
        }

        if (selfId) {
            const selfEl = allowLiveDom ? document.getElementById('player-' + selfId) : null;
            const exact = selfEl ? exactNameForPlayerIdFromElement(selfEl, selfId) : '';
            if (exact) return { name: exact, source: 'self-link/id' };

            const remembered = getRememberedHeroNameForId(selfId);
            if (remembered) return { name: remembered, source: 'id-bound-memory' };
        }

        const fallback = String(rec?.heroName || state?.heroName || '').trim();
        return { name: fallback, source: fallback ? 'record-fallback' : 'none' };
    }

    function markPerformanceResult(gameId, observedAwards = [], gameLines = null) {
        const gid = String(gameId || '');
        if (!gid) return false;
        const state = _v6Runtime.games.get(gid);

        const arr = loadHandRecords();
        const idx = arr.findIndex(r => r && r.gameId === gid);
        if (idx < 0) return false;

        const rec = arr[idx];
        if (rec.heroDealtVerified !== true) return false;
        if (!Array.isArray(rec.cards) || rec.cards.length !== 2) return false;

        const expectedHero = expectedHeroIdentity();
        const financialIdentity = resolveFinancialHeroIdentity(rec, state);
        const heroName = String(financialIdentity.name || '').trim();
        if (!heroName) return false;

        rec.heroId = String(rec.heroId || state?.heroSeatId || expectedHero.id || '').trim();
        rec.heroName = heroName;
        rec.heroIdentitySource = financialIdentity.source || rec.heroIdentitySource || '';
        rec.financialHeroName = heroName;
        rec.financialHeroSource = financialIdentity.source || '';

        const finalTable = state?.tableContext || tableContextForGame(gid);
        if (finalTable) {
            rec.tableKey = rec.tableKey || finalTable.key || '';
            rec.tableName = rec.tableName || finalTable.name || '';
            rec.tableCashBB = Number.isFinite(rec.tableCashBB)
                ? rec.tableCashBB
                : (Number.isFinite(finalTable.bb) ? finalTable.bb : null);
            rec.tableDetectionSource = rec.tableDetectionSource || finalTable.source || '';
        }

        const hero = normalisePlayerName(heroName);

        const awards = (Array.isArray(observedAwards) && observedAwards.length)
            ? observedAwards.filter(Boolean)
            : (state?.awards || []);
        if (!awards.length) return false;

        const finalBoard = preferMoreCompleteBoard(
            rec.board || rec.boardCards,
            state?.board || boardFromGameLogLines(Array.isArray(gameLines) ? gameLines : getGameLogLines(gid))
        );
        if (finalBoard.length) {
            rec.board = finalBoard.slice();
            rec.boardCards = finalBoard.slice();
            rec.boardTexture = finalBoard.length >= 3 ? classifyBoardTexture(finalBoard).label : (rec.boardTexture || '');
        }

        if (state?.actionLine) rec.actionLine = state.actionLine;
        if (state?.lines?.length) rec.history = state.lines.join('\n');

        const heroAwards = awards.filter(a => normalisePlayerName(a.winner) === hero);
        const heroAwardUnits = [...new Set(
            heroAwards.map(a => a?.unit || state?.bbInfo?.unit || '').filter(Boolean)
        )];
        const heroReturn = heroAwardUnits.length <= 1
            ? heroAwards.reduce((s, a) => s + (Number.isFinite(a.amount) ? a.amount : 0), 0)
            : null;
        const heroWon = heroAwards.length > 0;
        const folded = !heroWon && heroFoldedInGame(gid, heroName, gameLines);

        if (!rec.completedAt) rec.completedAt = Date.now();
        rec.outcome = heroWon ? 'win' : (folded ? 'fold' : 'loss');
        rec.winner = heroWon ? heroName : String(awards[awards.length - 1]?.winner || '');
        rec.wonAmount = heroWon ? heroReturn : null;
        rec.wonAmountUnit = heroWon && heroAwardUnits.length === 1 ? heroAwardUnits[0] : '';

        rec.revealedHands = serialiseRevealedHands(state);
        rec.awards = serialiseAwards(awards);
        rec.awardWinnerCount = new Set(
            awards.map(a => normalisePlayerName(a?.winner)).filter(Boolean)
        ).size;
        rec.hiddenAwardWinnerCount = hiddenAwardWinnerCount(awards, state?.revealedHands);

        const foldedComparison = evaluateFoldedRiverComparison(
            rec, state?.revealedHands, finalBoard
        );
        rec.foldedRiverResult = foldedComparison.result;
        rec.foldedRiverReason = foldedComparison.reason;
        rec.foldedComparedHandCount = foldedComparison.comparedCount;
        rec.foldedComparisonWinner = foldedComparison.winner;
        rec.foldedComparisonWinnerCards = foldedComparison.winnerCards;
        rec.foldedHeroFinalHand = foldedComparison.heroFinalHand;
        rec.foldedWinnerFinalHand = foldedComparison.winnerFinalHand;

        const fin = heroFinancialsForGame(gid, heroName, heroReturn, gameLines, heroAwards);
        rec.financialUnit = fin.financialUnit || '';
        rec.tableBB = fin.tableBB;
        rec.invested = fin.invested;
        rec.returned = fin.returned;
        rec.net = fin.net;
        rec.investedBB = fin.investedBB;
        rec.returnedBB = fin.returnedBB;
        rec.netBB = fin.netBB;
        rec.contributions = fin.contributions;

        // If the hand began before an exact felt key was captured, recover it
        // only while the same felt is still rendered and its known cash BB
        // agrees with this hand. This keeps late recovery useful without
        // allowing a table switch to relabel the completed hand.
        recoverExactTableContextForRecord(rec, state);

        const hasMoneyActionToken = /[CR]\d/i.test(String(rec.actionLine || ''));
        rec.financialWarning =
            !Number.isFinite(fin.netBB)
                ? 'net_bb_unavailable'
                : (fin.investedBB === 0 && hasMoneyActionToken
                    ? 'zero_invested_despite_call_or_raise_action'
                    : '');

        const integrityStatus = refreshRecordIntegrityFlags(rec, expectedHero);

        // Do not teach the opponent model from a hand whose local-player
        // identity or buy-in transition state is known to be unreliable.
        if (integrityStatus?.eligible) {
            try { recordOpponentHistoryForCompletedHand(state, rec); } catch (e) {
                console.warn('[TPS] opponent history update', e);
            }
        }

        arr[idx] = rec;
        saveHandRecords(arr);
        // A completed hand is the natural time to check whether our recent
        // table image has changed enough to be worth surfacing to the player.
        setTimeout(() => { try { maybeShowTableImageInsight(); } catch (_) {} }, 60);
        return true;
    }

    function completedPerformanceRecords() {
        return loadHandRecords().filter(r =>
            r &&
            r.heroDealtVerified === true &&
            Array.isArray(r.cards) &&
            r.cards.length === 2 &&
            r.completedAt &&
            ['win', 'loss', 'fold'].includes(r.outcome)
        );
    }

    function performanceRecords() {
        const expected = expectedHeroIdentity();
        return completedPerformanceRecords().filter(r => !heroIntegrityForRecord(r, expected).mismatch);
    }

    function calibrationPerformanceRecords() {
        const expected = expectedHeroIdentity();
        return performanceRecords().filter(r => calibrationEligibilityForRecord(r, expected).eligible);
    }

    function brierForPredictionRows(rows) {
        const list = (Array.isArray(rows) ? rows : []).filter(r =>
            Number.isFinite(r?.predictedEquityPct) && (r.outcome === 'win' || r.outcome === 'loss')
        );
        if (!list.length) return null;
        return list.reduce((sum, r) => {
            const p = Math.max(0, Math.min(1, Number(r.predictedEquityPct) / 100));
            const y = r.outcome === 'win' ? 1 : 0;
            return sum + Math.pow(p - y, 2);
        }, 0) / list.length;
    }

    function performanceSummary() {
        const rawRows = completedPerformanceRecords();
        const expected = expectedHeroIdentity();
        const heroMismatchHands = rawRows.filter(r => heroIntegrityForRecord(r, expected).mismatch).length;
        const rows = rawRows.filter(r => !heroIntegrityForRecord(r, expected).mismatch);
        const calibrationRows = rows.filter(r => calibrationEligibilityForRecord(r, expected).eligible);
        const joinTransitionHands = rows.filter(r => joinTransitionForRecord(r).joinTransition).length;
        const completed = rows.length;
        const wins = rows.filter(r => r.outcome === 'win').length;
        const folds = rows.filter(r => r.outcome === 'fold').length;

        const foldComparisons = rows
            .filter(r => r.outcome === 'fold')
            .map(foldedComparisonForRecord);
        const foldedComparable = foldComparisons.filter(c =>
            ['would_beat_all_shown_hands','would_lose_to_shown_hand','would_tie_best_shown_hand']
                .includes(c.result)
        ).length;
        const foldedWouldBeatAllShown = foldComparisons.filter(c =>
            c.result === 'would_beat_all_shown_hands'
        ).length;

        const showdowns = rows.filter(r => r.outcome === 'win' || r.outcome === 'loss');
        const calibrationShowdowns = calibrationRows.filter(r => r.outcome === 'win' || r.outcome === 'loss');
        const allPredicted = calibrationShowdowns.filter(r => Number.isFinite(r.predictedEquityPct));
        const currentPredicted = allPredicted.filter(r =>
            equityModelMetaForRecord(r).calibrationGroup === 'current'
        );
        const legacyMultiwayPredicted = allPredicted.filter(r =>
            equityModelMetaForRecord(r).calibrationGroup === 'legacy-multiway'
        );
        const priorEquityV2Predicted = allPredicted.filter(r =>
            equityModelMetaForRecord(r).calibrationGroup === 'prior-equity-v2'
        );
        const currentMultiwayPredicted = currentPredicted.filter(r => Number(r.villainCount) > 1);
        const currentHeadsUpPredicted = currentPredicted.filter(r => !(Number(r.villainCount) > 1));

        // The headline calibration deliberately excludes legacy multiway-factor
        // predictions. Behavioural/outcome/financial statistics still use all
        // valid records because those observations did not change with the model.
        const avgPred = currentPredicted.length
            ? currentPredicted.reduce((sum, r) => sum + r.predictedEquityPct, 0) / currentPredicted.length
            : null;
        const showdownWins = showdowns.filter(r => r.outcome === 'win').length;
        const showdownActualWin = showdowns.length ? (100 * showdownWins / showdowns.length) : null;
        const pairedWins = currentPredicted.filter(r => r.outcome === 'win').length;
        const actualWin = currentPredicted.length ? (100 * pairedWins / currentPredicted.length) : null;
        const brier = brierForPredictionRows(currentPredicted);
        const currentMultiwayBrier = brierForPredictionRows(currentMultiwayPredicted);
        const currentHeadsUpBrier = brierForPredictionRows(currentHeadsUpPredicted);
        const legacyMultiwayBrier = brierForPredictionRows(legacyMultiwayPredicted);
        const priorEquityV2Brier = brierForPredictionRows(priorEquityV2Predicted);
        const avgFor = list => list.length ? list.reduce((sum, r) => sum + Number(r.predictedEquityPct || 0), 0) / list.length : null;
        const winFor = list => list.length ? 100 * list.filter(r => r.outcome === 'win').length / list.length : null;
        const currentMultiwayAvgPred = avgFor(currentMultiwayPredicted);
        const currentMultiwayActualWin = winFor(currentMultiwayPredicted);
        const currentHeadsUpAvgPred = avgFor(currentHeadsUpPredicted);
        const currentHeadsUpActualWin = winFor(currentHeadsUpPredicted);
        const staleHoleCardHands = rows.filter(r => staleHoleCardsForRecord(r).stale).length;
        const incompletePreflopDecisionHands = rows.filter(r => !preflopDecisionIntegrityForRecord(r).valid).length;
        const rangeStyleAdjustedHands = calibrationRows.filter(r => r.preflopRangeStyleAdjusted === true).length;

        const cashRows = rows.filter(r => Number.isFinite(r.net));
        const net = cashRows.length ? cashRows.reduce((s, r) => s + r.net, 0) : null;
        const bbRows = rows.filter(r => Number.isFinite(r.netBB));
        const netBB = bbRows.length ? bbRows.reduce((s, r) => s + r.netBB, 0) : null;
        const bb100 = bbRows.length ? (netBB / bbRows.length) * 100 : null;

        return {
            storedCompleted: rawRows.length,
            completed, wins, folds,
            heroMismatchHands,
            joinTransitionHands,
            staleHoleCardHands,
            incompletePreflopDecisionHands,
            rangeStyleAdjustedHands,
            calibrationEligibleHands: calibrationRows.length,
            calibrationExcludedHands: rawRows.length - calibrationRows.length,
            foldedComparable,
            foldedWouldBeatAllShown,
            // Backward-compatible aliases for exported summary consumers.
            foldedKnown: foldedComparable,
            foldedWouldBeat: foldedWouldBeatAllShown,
            showdowns: showdowns.length,
            showdownActualWin,
            predicted: currentPredicted.length,
            allPredicted: allPredicted.length,
            avgPred, actualWin, pairedActualWin: actualWin, brier,
            currentModelPredicted: currentPredicted.length,
            currentMultiwayPredicted: currentMultiwayPredicted.length,
            currentMultiwayAvgPred,
            currentMultiwayActualWin,
            currentMultiwayBrier,
            currentHeadsUpPredicted: currentHeadsUpPredicted.length,
            currentHeadsUpAvgPred,
            currentHeadsUpActualWin,
            currentHeadsUpBrier,
            legacyMultiwayPredicted: legacyMultiwayPredicted.length,
            legacyMultiwayBrier,
            priorEquityV2Predicted: priorEquityV2Predicted.length,
            priorEquityV2Brier,
            financialHands: bbRows.length, cashFinancialHands: cashRows.length,
            net, netBB, bb100
        };
    }

    function performanceIntegritySummary() {
        const rawRows = completedPerformanceRecords();
        const expected = expectedHeroIdentity();
        const heroMismatchHands = rawRows.filter(r => heroIntegrityForRecord(r, expected).mismatch).length;
        const identityValid = rawRows.filter(r => !heroIntegrityForRecord(r, expected).mismatch);
        const joinTransitionHands = identityValid.filter(r => joinTransitionForRecord(r).joinTransition).length;
        const staleHoleCardHands = identityValid.filter(r => staleHoleCardsForRecord(r).stale).length;
        const incompletePreflopDecisionHands = identityValid.filter(r => !preflopDecisionIntegrityForRecord(r).valid).length;
        const calibrationEligibleHands = identityValid.filter(r => calibrationEligibilityForRecord(r, expected).eligible).length;
        return {
            storedCompleted: rawRows.length,
            heroMismatchHands,
            joinTransitionHands,
            staleHoleCardHands,
            incompletePreflopDecisionHands,
            calibrationEligibleHands,
            calibrationExcludedHands: rawRows.length - calibrationEligibleHands
        };
    }

    function tableImageRecordTime(rec) {
        const n = Number(rec?.completedAt || rec?.t || 0);
        return Number.isFinite(n) ? n : 0;
    }

    function sameTableForImage(rec, ctx) {
        if (!rec || !ctx) return false;
        const recKey = String(rec.tableKey || '').trim().toLowerCase();
        const ctxKey = String(ctx.key || '').trim().toLowerCase();
        if (recKey && ctxKey) return recKey === ctxKey;

        const recName = normalisePlayerName(rec.tableName || '');
        const ctxName = normalisePlayerName(ctx.name || '');
        if (recName && ctxName) return recName === ctxName;
        return false;
    }

    function currentTableImageRecords() {
        const rows = performanceRecords();
        if (!rows.length) return [];

        const live = getExactRenderedTableContext() || detectStandaloneTableContext();
        const target = live || {
            key: rows[0].tableKey || '',
            name: rows[0].tableName || '',
            bb: rows[0].tableCashBB
        };

        // Do not accidentally show an old table's image during a switch. Wait
        // until at least one completed hand from the currently rendered table exists.
        if (live && !sameTableForImage(rows[0], target)) return [];

        const out = [];
        let newerTime = 0;
        for (const rec of rows) {
            if (!sameTableForImage(rec, target)) break;
            const t = tableImageRecordTime(rec);
            if (newerTime && t && newerTime - t > 20 * 60 * 1000) break;
            out.push(rec);
            newerTime = t || newerTime;
            if (out.length >= 60) break;
        }
        return out;
    }

    function flopPressureOutcomeForRecord(rec) {
        const heroKey = normalisePlayerName(rec?.heroName || rec?.financialHeroName || '');
        const history = String(rec?.history || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        if (!heroKey || !history.length) return { opportunity: 0, folded: 0 };

        let street = 'preflop';
        let facingPressure = false;
        for (const line of history) {
            if (/^the flop\b/i.test(line)) { street = 'flop'; facingPressure = false; continue; }
            if (/^the turn\b/i.test(line) || /^the river\b/i.test(line)) {
                if (street === 'flop') break;
                street = /^the turn\b/i.test(line) ? 'turn' : 'river';
                continue;
            }
            if (street !== 'flop') continue;

            const m = line.match(/^(.+?)\s+(checked|called|folded|bets?|raised)\b/i);
            if (!m) continue;
            const actorKey = normalisePlayerName(m[1]);
            const verb = String(m[2] || '').toLowerCase();
            const isHero = actorKey === heroKey;

            if (!isHero && (verb === 'bet' || verb === 'bets' || verb === 'raised')) {
                facingPressure = true;
                continue;
            }
            if (isHero && facingPressure && ['called','raised','folded'].includes(verb)) {
                return { opportunity: 1, folded: verb === 'folded' ? 1 : 0 };
            }
        }
        return { opportunity: 0, folded: 0 };
    }

    function tableImageStats(rows) {
        const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
        const hands = list.length;
        let vpip = 0, pfr = 0, preflopFolds = 0;
        let threeBetOpp = 0, threeBets = 0;
        let showdowns = 0, showdownWins = 0;
        let flopPressureOpp = 0, flopPressureFolds = 0;

        for (const rec of list) {
            const action = String(rec.preflopActualAction || '').toLowerCase();
            if (action === 'called' || action === 'raised') vpip++;
            if (action === 'raised') pfr++;
            if (action === 'folded') preflopFolds++;

            if (Number(rec.preflopRaiseCountBeforeHero) === 1) {
                threeBetOpp++;
                if (action === 'raised') threeBets++;
            }

            if (rec.outcome === 'win' || rec.outcome === 'loss') {
                showdowns++;
                if (rec.outcome === 'win') showdownWins++;
            }

            const flop = flopPressureOutcomeForRecord(rec);
            flopPressureOpp += flop.opportunity;
            flopPressureFolds += flop.folded;
        }

        const rate = (n, d) => d > 0 ? 100 * n / d : null;
        return {
            hands,
            vpipCount: vpip,
            vpipPct: rate(vpip, hands),
            pfrCount: pfr,
            pfrPct: rate(pfr, hands),
            preflopFoldCount: preflopFolds,
            preflopFoldPct: rate(preflopFolds, hands),
            threeBetOpp,
            threeBets,
            threeBetPct: rate(threeBets, threeBetOpp),
            showdowns,
            showdownWins,
            showdownPct: rate(showdowns, hands),
            showdownWinPct: rate(showdownWins, showdowns),
            flopPressureOpp,
            flopPressureFolds,
            flopPressureFoldPct: rate(flopPressureFolds, flopPressureOpp)
        };
    }

    function plainTableImageLabel(stats) {
        if (!stats || stats.hands < 5 || !Number.isFinite(stats.vpipPct)) return 'Henüz oluşuyor';

        let label = '';
        if (stats.vpipPct < 15) label = 'Çok sıkı';
        else if (stats.vpipPct < 24) label = 'Sıkı';
        else if (stats.vpipPct <= 38) label = 'Dengeli';
        else if (stats.vpipPct <= 52) label = 'Gevşek';
        else label = 'Çok gevşek';

        const ratio = stats.vpipPct > 0 && Number.isFinite(stats.pfrPct)
            ? stats.pfrPct / stats.vpipPct : 0;
        if (stats.pfrPct >= 20 && ratio >= 0.55) label += ' · sık raise yapıyor';
        else if (stats.vpipPct >= 24 && ratio < 0.35) label += ' · daha çok call ediyor';
        return label;
    }

    function tableImageConfidence(hands) {
        if (hands < 8) return 'İlk izlenim';
        if (hands < 15) return 'Henüz oluşuyor';
        if (hands < 30) return 'Makul tahmin';
        return 'Yeterli veri';
    }

    function continuedAgainstFoldAdvice(rec) {
        const advice = String(rec?.preflopAdvice || rec?.heroAction || '').toLowerCase();
        const action = String(rec?.preflopActualAction || '').toLowerCase();
        return advice === 'fold' && (action === 'called' || action === 'raised');
    }

    function tableImageNetBB(rows) {
        const vals = (Array.isArray(rows) ? rows : [])
            .filter(r => Number.isFinite(r?.netBB))
            .map(r => Number(r.netBB));
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    }

    function detectPossibleTilt(sessionRows, allRows) {
        const recentRows = (Array.isArray(sessionRows) ? sessionRows : []).slice(0, 10);
        if (recentRows.length < 6) return null;

        const recentStats = tableImageStats(recentRows);
        const recentIds = new Set(recentRows.map(r => String(r?.gameId || '')).filter(Boolean));
        const baselineRows = (Array.isArray(allRows) ? allRows : [])
            .filter(r => !recentIds.has(String(r?.gameId || '')))
            .slice(0, 500);
        if (baselineRows.length < 30) return null;

        const baselineStats = tableImageStats(baselineRows);
        const recentNet = tableImageNetBB(recentRows);
        const moneySamples = recentRows.filter(r => Number.isFinite(r?.netBB)).length;
        if (!Number.isFinite(recentNet) || moneySamples < 5 || recentNet > -20) return null;

        const signals = [];
        const vpipJump = Number.isFinite(recentStats.vpipPct) && Number.isFinite(baselineStats.vpipPct)
            ? recentStats.vpipPct - baselineStats.vpipPct : 0;
        const pfrJump = Number.isFinite(recentStats.pfrPct) && Number.isFinite(baselineStats.pfrPct)
            ? recentStats.pfrPct - baselineStats.pfrPct : 0;
        const ignoredFolds = recentRows.filter(continuedAgainstFoldAdvice).length;

        if (vpipJump >= 18) signals.push('normalden belirgin şekilde fazla el oynuyorsun');
        if (pfrJump >= 15) signals.push('flop\u2019tan önce normalden çok daha sık raise yapıyorsun');
        if (ignoredFolds >= 2) signals.push(`Sidearm\u2019ın fold dediği ${ignoredFolds} elde devam ettin`);

        if (recentStats.threeBetOpp >= 4 && baselineStats.threeBetOpp >= 12 &&
            Number.isFinite(recentStats.threeBetPct) && Number.isFinite(baselineStats.threeBetPct) &&
            recentStats.threeBetPct - baselineStats.threeBetPct >= 25) {
            signals.push('normalden çok daha sık re-raise yapıyorsun');
        }

        if (!signals.length) return null;

        const severe = recentNet <= -60 || signals.length >= 2 || ignoredFolds >= 3;
        const lossText = `${Math.abs(recentNet).toFixed(recentNet % 1 ? 1 : 0)} BB`;
        const behaviour = signals.length === 1
            ? signals[0]
            : `${signals.slice(0, -1).join(', ')} ve ${signals[signals.length - 1]}`;

        return {
            active: true,
            type: 'possible-tilt',
            kind: 'tilt',
            priority: 140,
            severity: severe ? 'strong' : 'watch',
            recentHands: recentRows.length,
            recentNetBB: recentNet,
            signals,
            text: `Olası tilt: son ${recentRows.length} elde ${lossText} kayıptasın; ayrıca ${behaviour}. Birkaç el sakin oynamayı düşün.`
        };
    }

    function prepareTableImageInsights(sessionRows, recentStats, priorStats, lifetimeStats) {
        const insights = [];
        const recentRows = sessionRows.slice(0, Math.min(12, sessionRows.length));
        const olderRows = sessionRows.slice(12, 42);
        const recent12 = tableImageStats(recentRows);
        const older = tableImageStats(olderRows);

        if (recent12.hands >= 8 && older.hands >= 10 &&
            Number.isFinite(recent12.vpipPct) && Number.isFinite(older.vpipPct)) {
            const vpipShift = recent12.vpipPct - older.vpipPct;
            const pfrShift = (Number.isFinite(recent12.pfrPct) && Number.isFinite(older.pfrPct))
                ? recent12.pfrPct - older.pfrPct : 0;
            if (vpipShift <= -18 || pfrShift <= -15) {
                insights.push({
                    type: 'gear-tighter', priority: 100,
                    text: 'Bu masada eskisinden belirgin şekilde az el oynuyorsun. Masa seni artık daha temkinli biri olarak görebilir.'
                });
            } else if (vpipShift >= 18 || pfrShift >= 15) {
                insights.push({
                    type: 'gear-looser', priority: 100,
                    text: 'Bu masada eskisinden belirgin şekilde fazla el oynuyorsun. Oyuncular raise\u2019lerini daha az ciddiye almaya başlayabilir.'
                });
            }
        }

        if (lifetimeStats?.hands >= 40 && recentStats?.hands >= 8 &&
            Number.isFinite(recentStats.vpipPct) && Number.isFinite(lifetimeStats.vpipPct)) {
            const vpipVsUsual = recentStats.vpipPct - lifetimeStats.vpipPct;
            const pfrVsUsual = (Number.isFinite(recentStats.pfrPct) && Number.isFinite(lifetimeStats.pfrPct))
                ? recentStats.pfrPct - lifetimeStats.pfrPct : 0;
            if (vpipVsUsual <= -15 && pfrVsUsual <= -8) {
                insights.push({
                    type: 'usual-tighter', priority: 95,
                    text: 'Normal oyununa göre bu masada daha az pota giriyor ve daha az raise yapıyorsun.'
                });
            } else if (vpipVsUsual >= 15 && pfrVsUsual >= 8) {
                insights.push({
                    type: 'usual-looser', priority: 95,
                    text: 'Normal oyununa göre bu masada daha çok pota giriyor ve daha sık raise yapıyorsun.'
                });
            } else if (vpipVsUsual <= -18) {
                insights.push({
                    type: 'usual-fewer-pots', priority: 92,
                    text: 'Normalde oynadığından belirgin şekilde az el oynuyorsun.'
                });
            } else if (vpipVsUsual >= 18) {
                insights.push({
                    type: 'usual-more-pots', priority: 92,
                    text: 'Normalde oynadığından belirgin şekilde fazla el oynuyorsun.'
                });
            } else if (pfrVsUsual >= 15) {
                insights.push({
                    type: 'usual-more-raises', priority: 90,
                    text: 'Flop\u2019tan önce normalden çok daha sık raise yapıyorsun.'
                });
            } else if (pfrVsUsual <= -15) {
                insights.push({
                    type: 'usual-fewer-raises', priority: 90,
                    text: 'Flop\u2019tan önce normalden çok daha seyrek raise yapıyorsun.'
                });
            }
        }

        if (recentStats.flopPressureOpp >= 5 && recentStats.flopPressureFoldPct >= 70) {
            insights.push({
                type: 'flop-folding', priority: 90,
                text: `Flop\u2019ta karşılaştığın ${recentStats.flopPressureOpp} bet/raise\u2019in ${recentStats.flopPressureFolds} tanesinde fold ettin. Oyuncular seni daha sık zorlamaya başlayabilir.`
            });
        }

        if (recentStats.threeBetOpp >= 5 && recentStats.threeBetPct <= 10) {
            insights.push({
                type: 'rare-reraise', priority: 82,
                text: `Flop\u2019tan önce ${recentStats.threeBetOpp} fırsatın sadece ${recentStats.threeBets} tanesinde re-raise yaptın. Senden gelen bir re-raise çok güçlü görünebilir.`
            });
        } else if (recentStats.threeBetOpp >= 5 && recentStats.threeBetPct >= 35) {
            insights.push({
                type: 'frequent-reraise', priority: 82,
                text: `Flop\u2019tan önce ${recentStats.threeBetOpp} fırsatın ${recentStats.threeBets} tanesinde re-raise yaptın. Oyuncular daha çok call edip karşılık vermeye başlayabilir.`
            });
        }

        if (recentStats.hands >= 10 && recentStats.vpipPct <= 18) {
            insights.push({
                type: 'tight-image', priority: 70,
                text: 'Son zamanlarda çok seçici oynadın. Bir pota girdiğinde oyuncular güçlü bir elin olduğunu düşünebilir.'
            });
        } else if (recentStats.hands >= 10 && recentStats.vpipPct >= 45) {
            insights.push({
                type: 'loose-image', priority: 70,
                text: 'Son zamanlarda çok el oynadın. Oyuncular her elle oynadığını düşünüp bet\u2019lerine daha sık call edebilir.'
            });
        }

        return insights.sort((a, b) => b.priority - a.priority).slice(0, 3);
    }

    function buildHeroTableImage() {
        const sessionRows = currentTableImageRecords();
        if (!sessionRows.length) return null;

        const allRows = performanceRecords();
        const recentRows = sessionRows.slice(0, 15);
        const priorRows = sessionRows.slice(15, 45);
        const recent = tableImageStats(recentRows);
        const prior = tableImageStats(priorRows);
        const lifetime = tableImageStats(allRows);
        const tilt = detectPossibleTilt(sessionRows, allRows);
        const first = sessionRows[0];
        const tableContext = {
            key: first.tableKey || '',
            name: first.tableName || '',
            bb: Number.isFinite(first.tableCashBB) ? first.tableCashBB : null
        };

        return {
            tableKey: tableContext.key || normalisePlayerName(tableContext.name),
            tableLabel: formatTableContextLabel(tableContext) || tableContext.name || 'Bu masa',
            sessionHands: sessionRows.length,
            lifetimeHands: lifetime.hands,
            recent,
            prior,
            lifetime,
            label: plainTableImageLabel(recent),
            lifetimeLabel: plainTableImageLabel(lifetime),
            confidence: tableImageConfidence(recent.hands),
            insights: prepareTableImageInsights(sessionRows, recent, prior, lifetime),
            tilt
        };
    }

    function rateWithCount(value, made, chances) {
        if (!Number.isFinite(value) || !(chances > 0)) return '-';
        return `${value.toFixed(0)}% (${made}/${chances})`;
    }

    function compactRate(value, made, chances) {
        if (!Number.isFinite(value)) return '-';
        if (Number.isFinite(made) && Number.isFinite(chances) && chances > 0) {
            return `${value.toFixed(0)}% (${made}/${chances})`;
        }
        return `${value.toFixed(0)}%`;
    }

    function buildTableImageHtml() {
        const image = buildHeroTableImage();
        if (!image) {
            return `<div class="tps-row">
                <div class="tps-lab">Masa seni nasıl görüyor olabilir</div>
                <div class="tps-dim">Bu masada birkaç el tamamla; Sidearm görünen hamlelerinden basit bir masa imajı çıkaracak.</div>
            </div>`;
        }

        const s = image.recent;
        const l = image.lifetime;
        const lifetimeReady = l.hands >= 20;
        const compareRows = [
            ['Preflop oyuna girdi', compactRate(s.vpipPct, s.vpipCount, s.hands), lifetimeReady ? compactRate(l.vpipPct, l.vpipCount, l.hands) : 'Öğreniliyor'],
            ['Preflop raise yaptı', compactRate(s.pfrPct, s.pfrCount, s.hands), lifetimeReady ? compactRate(l.pfrPct, l.pfrCount, l.hands) : 'Öğreniliyor'],
            ['Raise\u2019e re-raise yaptı', rateWithCount(s.threeBetPct, s.threeBets, s.threeBetOpp), lifetimeReady ? rateWithCount(l.threeBetPct, l.threeBets, l.threeBetOpp) : 'Öğreniliyor'],
            ['Flop baskısında fold etti', rateWithCount(s.flopPressureFoldPct, s.flopPressureFolds, s.flopPressureOpp), lifetimeReady ? rateWithCount(l.flopPressureFoldPct, l.flopPressureFolds, l.flopPressureOpp) : 'Öğreniliyor'],
            ['Showdown\u2019a kadar gitti', compactRate(s.showdownPct, s.showdowns, s.hands), lifetimeReady ? compactRate(l.showdownPct, l.showdowns, l.hands) : 'Öğreniliyor']
        ].map(row => `<div class="tps-image-compare-row">
            <span>${escHtml(row[0])}</span><b>${escHtml(row[1])}</b><span>${escHtml(row[2])}</span>
        </div>`).join('');

        const insights = image.insights.length
            ? image.insights.map(x => `<div class="tps-image-insight">${escHtml(x.text)}</div>`).join('')
            : '<div class="tps-dim" style="margin-top:6px">Henüz belirgin bir masa imajı sinyali yok.</div>';
        const tilt = image.tilt?.active
            ? `<div class="tps-tilt-warning"><b>Olası tilt</b><div>${escHtml(image.tilt.text.replace(/^Olası tilt:\s*/i, ''))}</div></div>`
            : '';

        return `<div class="tps-row tps-table-image">
            <div class="tps-lab">Masa seni nasıl görüyor olabilir</div>
            <div><b>${escHtml(image.label)}</b> <span class="tps-dim">· ${escHtml(image.confidence)}</span></div>
            <div class="tps-dim">${escHtml(image.tableLabel)} · son ${s.hands} el${image.sessionHands > s.hands ? ` (bu oturumda toplam ${image.sessionHands})` : ''}</div>
            <div class="tps-dim">Genel tarzın: <b>${escHtml(lifetimeReady ? image.lifetimeLabel : 'Henüz öğreniliyor')}</b> · kayıtlı ${l.hands} el</div>
            <div class="tps-image-compare-head"><span></span><span>Son</span><span>Genel</span></div>
            ${compareRows}
            ${tilt}
            ${insights}
        </div>`;
    }

    function markThreeBetHelpSeen() {
        try { localStorage.setItem(THREE_BET_HELP_KEY, '1'); } catch (_) {}
    }

    function maybeShowThreeBetHelp(action) {
        const act = String(action || '').toLowerCase();
        if ((act !== '3bet' && act !== '4bet') || document.hidden) return;
        try {
            if (localStorage.getItem(THREE_BET_HELP_KEY) === '1') return;
        } catch (_) {}
        if (document.getElementById('tps-poker-term-toast')) return;

        injectStyles();
        const host = document.createElement('div');
        host.id = 'tps-poker-term-toast';
        host.innerHTML = `
            <button type="button" class="tps-poker-term-close" aria-label="Kapat">&times;</button>
            <div class="tps-poker-term-title">3-bet nedir?</div>
            <div><b>Sadece re-raise demek.</b></div>
            <div class="tps-poker-term-copy">Preflop\u2019ta big blind ilk bet sayılır, ilk raise ikinci olur; o oyuncunun raise\u2019ine tekrar raise yapmaya <b>3-bet</b> denir.</div>
            <div class="tps-poker-term-copy">Biri senin 3-bet\u2019ine tekrar raise yaparsa, buna <b>4-bet</b> denir.</div>
            <div class="tps-poker-term-copy tps-dim">Sidearm hızlı butonda <b>RE-RAISE</b> gösterir, ayrıntılarda ise poker terimini kullanır. Torn\u2019da yapacağın şey yine <b>Raise</b> butonuna basmak.</div>
            <div class="tps-poker-term-actions">
                <button type="button" class="tps-poker-term-btn" data-tps-term-action="got-it">Anladım</button>
                <button type="button" class="tps-poker-term-btn pri" data-tps-term-action="why">Neden bu el?</button>
            </div>`;
        document.documentElement.appendChild(host);
        markThreeBetHelpSeen();
        requestAnimationFrame(() => host.classList.add('show'));

        const close = () => {
            host.classList.remove('show');
            setTimeout(() => host.remove(), 170);
        };
        host.querySelector('.tps-poker-term-close')?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            close();
        }, { once: true });
        host.querySelector('[data-tps-term-action="got-it"]')?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            close();
        }, { once: true });
        host.querySelector('[data-tps-term-action="why"]')?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            close();
            showPanel();
            setTimeout(() => {
                const toggle = document.querySelector('#tps-panel #tps-why-toggle');
                if (toggle && String(toggle.textContent || '').trim() === 'Neden?') toggle.click();
            }, 0);
        }, { once: true });
    }

    let _tableInsightToastTimer = null;
    let _lastTableInsightToastKey = '';
    let _activeTiltToastKey = '';

    function showTableInsightToast(insight, image, force = false) {
        if (!insight?.text || !image || document.hidden) return;
        const kind = insight.kind === 'tilt' ? 'tilt' : 'table';
        const key = `${image.tableKey || image.tableLabel}|${insight.type}`;
        if (!force && key === _lastTableInsightToastKey) return;
        _lastTableInsightToastKey = key;

        let host = document.getElementById('tps-table-insight-toast');
        if (!host) {
            host = document.createElement('div');
            host.id = 'tps-table-insight-toast';
            document.documentElement.appendChild(host);
        }
        host.classList.toggle('tilt', kind === 'tilt');
        const title = kind === 'tilt' ? 'Tilt uyarısı' : 'Masa yorumu';
        host.innerHTML = `
            <button type="button" class="tps-table-insight-close" aria-label="Kapat">&times;</button>
            <div class="tps-table-insight-title">${title}</div>
            <div>${escHtml(insight.text)}</div>`;
        host.style.top = debug === 1 ? '190px' : '72px';
        host.classList.add('show');

        const closeBtn = host.querySelector('.tps-table-insight-close');
        closeBtn?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            if (_tableInsightToastTimer) clearTimeout(_tableInsightToastTimer);
            _tableInsightToastTimer = null;
            host.classList.remove('show');
        }, { once: true });

        if (_tableInsightToastTimer) clearTimeout(_tableInsightToastTimer);
        _tableInsightToastTimer = setTimeout(() => {
            host.classList.remove('show');
            _tableInsightToastTimer = null;
        }, TABLE_INSIGHT_ALERT_MS);
    }

    function maybeShowTableImageInsight() {
        const image = buildHeroTableImage();
        if (!image) {
            _activeTiltToastKey = '';
            return;
        }

        const tableKey = image.tableKey || image.tableLabel || 'table';
        const tiltKey = `${tableKey}|possible-tilt`;
        if (image.tilt?.active) {
            if (_activeTiltToastKey !== tiltKey) showTableInsightToast(image.tilt, image, true);
            _activeTiltToastKey = tiltKey;
            return;
        }
        _activeTiltToastKey = '';

        if (!image.insights?.length) return;
        showTableInsightToast(image.insights[0], image);
    }

    function buildEquityTrackingDebugHtml() {
        if (debug !== 1) return '';
        const s = performanceSummary();
        const fmt = v => Number.isFinite(v) ? v.toFixed(3) : '-';
        const pct = v => Number.isFinite(v) ? v.toFixed(1) + '%' : '-';
        return `
            <div class="tps-row" style="font-size:10px;line-height:1.35">
                <div class="tps-lab">Equity / model tracking</div>
                <div style="font-family:monospace;white-space:normal;word-break:break-word">
                    <div><b>Schema:</b> ${DATA_SCHEMA_VERSION}</div>
                    <div><b>Preflop model:</b> ${PREFLOP_STRATEGY_VERSION}</div>
                    <div><b>Equity model:</b> ${EQUITY_MODEL_VERSION} · ${escHtml(EQUITY_MODEL_MULTIWAY)} · ${escHtml(EQUITY_MODEL_HEADS_UP_RIVER)}</div>
                    <div><b>Opponent range history:</b> ${OPPONENT_MODEL_VERSION} · min ${OPPONENT_HISTORY_MIN_HANDS} hands · max ${Math.round(OPPONENT_HISTORY_MAX_INFLUENCE * 100)}% nudge</div>
                    <div><b>Postflop advice:</b> ${POSTFLOP_ADVICE_MODEL_VERSION} · ${escHtml(POSTFLOP_ADVICE_MODEL)}</div>
                    <div><b>Why explainer:</b> ${WHY_EXPLAINER_VERSION}</div>
                    <div style="margin-top:5px"><b>Avg current-model equity:</b> ${pct(s.avgPred)}</div>
                    <div><b>Paired actual win:</b> ${pct(s.actualWin)} · same ${s.currentModelPredicted} scored hand${s.currentModelPredicted === 1 ? '' : 's'}</div>
                    <div><b>Current-model Brier:</b> ${fmt(s.brier)} · ${s.currentModelPredicted} scored hand${s.currentModelPredicted === 1 ? '' : 's'}</div>
                    <div><b>New multi-player Brier:</b> ${fmt(s.currentMultiwayBrier)} · ${s.currentMultiwayPredicted} scored hand${s.currentMultiwayPredicted === 1 ? '' : 's'}</div>
                    <div><b>Legacy multi-player Brier:</b> ${fmt(s.legacyMultiwayBrier)} · ${s.legacyMultiwayPredicted} scored hand${s.legacyMultiwayPredicted === 1 ? '' : 's'}</div>
                    <div><b>Prior equity v2 Brier:</b> ${fmt(s.priorEquityV2Brier)} · ${s.priorEquityV2Predicted} scored hand${s.priorEquityV2Predicted === 1 ? '' : 's'}</div>
                </div>
            </div>`;
    }

    function buildPerformanceHtml() {
        const s = performanceSummary();
        const rows = performanceRecords().slice(0, 5);
        const pct = v => Number.isFinite(v) ? v.toFixed(1) + '%' : '-';

        const recent = rows.length ? rows.map(r => {
            const eq = Number.isFinite(r.predictedEquityPct) ? r.predictedEquityPct.toFixed(1) + '%' : '-';
            const po = Number.isFinite(r.potOddsPct) ? r.potOddsPct.toFixed(1) + '%' : '-';
            const foldComparison = foldedComparisonForRecord(r);
            const foldHint = foldComparison.result === 'would_beat_all_shown_hands'
                ? ' ↗'
                : (foldComparison.result === 'would_lose_to_shown_hand'
                    ? ' ↘'
                    : (foldComparison.result === 'would_tie_best_shown_hand' ? ' =' : ''));
            const outcome = r.outcome === 'win'
                ? 'KAZANÇ'
                : (r.outcome === 'fold' ? 'FOLD' + foldHint : 'KAYIP');
            const seat = r.seat || r.position || '-';
            const netBB = Number.isFinite(r.netBB) ? `${r.netBB >= 0 ? '+' : ''}${r.netBB.toFixed(1)}bb` : '-';
            return `<div class="tps-hist-row">
                <span class="tps-hist-time">${escHtml(formatHistTime(r.completedAt || r.t))}</span>
                <span style="min-width:54px;font-weight:700">${outcome}</span>
                <span style="flex:1">${escHtml((r.cards || []).join(' ') || r.handClass || '-')}</span>
                <span title="Tahmini kazanma şansı">${eq}</span>
                <span title="Koltuk / pozisyon">${escHtml(seat)}</span>
                <span title="Net sonuç">${netBB}</span>
            </div>`;
        }).join('') : '<div class="tps-dim">Henüz tamamlanmış el kaydı yok.</div>';

        return `
            <div class="tps-row">
                <div class="tps-lab">İstatistiklerim</div>
                <div class="tps-dim">Bu tarayıcıda en fazla ${PERFORMANCE_MAX.toLocaleString()} el saklanır; hiçbir yere gönderilmez.</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px">
                    <div><b>${s.completed}</b><div class="tps-dim">Tamamlanan el</div></div>
                    <div><b>${s.showdowns}</b><div class="tps-dim">Showdown</div></div>
                    <div><b>${pct(s.showdownActualWin)}</b><div class="tps-dim">Kazanılan showdown</div></div>
                    <div><b>${s.folds}</b><div class="tps-dim">Fold ettiğin el</div></div>
                    <div><b>${s.foldedWouldBeatAllShown}/${s.foldedComparable}</b><div class="tps-dim">Fold ettiğin ama açılan ellerin hepsini yenecek eller</div></div>
                    <div><b>${Number.isFinite(s.netBB) ? s.netBB.toFixed(1) + ' BB' : '-'}</b><div class="tps-dim">Net sonuç</div></div>
                    <div><b>${Number.isFinite(s.bb100) ? s.bb100.toFixed(1) : '-'}</b><div class="tps-dim">100 elde BB</div></div>
                </div>
                ${(s.heroMismatchHands || s.joinTransitionHands || s.staleHoleCardHands || s.incompletePreflopDecisionHands) ? `
                    <div class="tps-dim" style="margin-top:7px">
                        ${s.heroMismatchHands ? `Kimliği eşleşmeyen ${s.heroMismatchHands} el istatistiklere katılmadı. ` : ''}
                        ${s.joinTransitionHands ? `Masaya oturma sırasındaki ${s.joinTransitionHands} el model ayarına katılmadı. ` : ''}
                        ${s.staleHoleCardHands ? `Sit-out\u2019tan kalma eski kartlı ${s.staleHoleCardHands} el katılmadı. ` : ''}
                        ${s.incompletePreflopDecisionHands ? `İlk kararı eksik kalan ${s.incompletePreflopDecisionHands} el katılmadı.` : ''}
                    </div>` : ''}
            </div>
            ${buildTableImageHtml()}
            <div class="tps-lab" style="margin-top:10px">Son sonuçlar</div>
            <div id="tps-performance-list">${recent}</div>
            <div class="tps-btns" style="margin-top:10px">
                <button type="button" class="tps-btn" id="tps-perf-refresh">Yenile</button>
                <button type="button" class="tps-btn" id="tps-perf-json">JSON indir</button>
                <button type="button" class="tps-btn" id="tps-perf-csv">CSV indir</button>
                <button type="button" class="tps-btn danger" id="tps-perf-clear">İstatistikleri sil</button>
            </div>`;
    }

    function performanceExportRows() {
        const expected = expectedHeroIdentity();
        return completedPerformanceRecords().map(r => {
            const eq = r.equitySnapshots || {};
            const snap = street => eq[street] || {};
            const flop = snap('flop'), turn = snap('turn'), river = snap('river');
            const foldComparison = foldedComparisonForRecord(r);
            const eligibility = calibrationEligibilityForRecord(r, expected);
            const flopOracle = oracleEquityForSnapshot(r, flop);
            const turnOracle = oracleEquityForSnapshot(r, turn);
            const riverOracle = oracleEquityForSnapshot(r, river);

            return {
                dataSchemaVersion: r.dataSchemaVersion || 1,
                sidearmVersion: r.sidearmVersion || '',
                gameId: r.gameId || '',
                timestamp: r.completedAt ? new Date(r.completedAt).toISOString() : '',
                tableKey: r.tableKey || '',
                tableName: r.tableName || uniqueTableNameForCashBB(r.tableCashBB ?? r.tableBB) || '',
                tableCashBB: Number.isFinite(r.tableCashBB) ? r.tableCashBB : r.tableBB,
                tableDetectionSource: r.tableDetectionSource || '',
                heroId: r.heroId || '',
                hero: r.heroName || '',
                heroIdentitySource: r.heroIdentitySource || '',
                heroDealtVerified: r.heroDealtVerified === true,
                heroIdentityMismatch: !!eligibility.integrity.mismatch,
                heroIntegrityReason: eligibility.integrity.reason || '',
                joinTransition: !!eligibility.join.joinTransition,
                joinTransitionReason: eligibility.join.reason || '',
                staleHoleCards: !!eligibility.stale.stale,
                staleHoleCardsReason: eligibility.stale.reason || '',
                staleHoleCardOverlap: (eligibility.stale.overlapKeys || []).join(' '),
                preflopDecisionIntegrityReason: eligibility.decision.reason || '',
                calibrationEligible: !!eligibility.eligible,
                calibrationExclusionReason: eligibility.reason || '',
                financialHeroName: r.financialHeroName || '',
                financialHeroSource: r.financialHeroSource || '',
                financialUnit: r.financialUnit || '',
                financialWarning: r.financialWarning || '',

                outcome: r.outcome || '',
                winner: r.winner || '',
                wonAmount: r.wonAmount,
                wonAmountUnit: r.wonAmountUnit || '',
                cards: (r.cards || []).join(' '),
                board: (r.board || r.boardCards || []).join(' '),
                seat: r.seat || '',
                position: r.position || '',
                stackBB: r.stackBB,
                actions: r.actionLine || '',
                handClass: r.handClass || '',
                handTag: r.handTag || '',
                advice: r.heroAction || '',

                preflopDecisionFrozen: r.preflopDecisionFrozen === true,
                preflopStrategyVersion: r.preflopStrategyVersion || '',
                preflopRangeStyle: r.preflopRangeStyle || 'balanced',
                preflopRangeStyleAdjusted: r.preflopRangeStyleAdjusted === true,
                preflopBalancedBaselineAction: r.preflopBalancedBaselineAction || r.preflopAdvice || '',
                preflopBalancedBaselineStrength: r.preflopBalancedBaselineStrength || r.preflopAdviceStrength || '',
                preflopAdvice: r.preflopAdvice || '', 
                preflopAdviceStrength: r.preflopAdviceStrength || '',
                preflopHandGroup: r.preflopHandGroup || '',
                preflopHeroSeat: r.preflopHeroSeat || '',
                preflopHeroPosition: r.preflopHeroPosition || '',
                preflopStackBB: r.preflopStackBB,
                preflopStackDepth: r.preflopStackDepth || '',
                preflopFacingRaise: !!r.preflopFacingRaise,
                preflopRaiseCountBeforeHero: r.preflopRaiseCountBeforeHero,
                preflopCallCountBeforeHero: r.preflopCallCountBeforeHero,
                preflopFoldCountBeforeHero: r.preflopFoldCountBeforeHero,
                preflopOpenerName: r.preflopOpenerName || '',
                preflopOpenerSeat: r.preflopOpenerSeat || '',
                preflopOpenerBucket: r.preflopOpenerBucket || '',
                preflopLastRaiserName: r.preflopLastRaiserName || '',
                preflopLastRaiserSeat: r.preflopLastRaiserSeat || '',
                preflopLastRaiserBucket: r.preflopLastRaiserBucket || '',
                preflopPressureBucket: r.preflopPressureBucket || '',
                preflopPressureScore: r.preflopPressureScore,
                preflopHighestBetBB: r.preflopHighestBetBB,
                preflopHeroCommittedBB: r.preflopHeroCommittedBB,
                preflopCostToContinueBB: r.preflopCostToContinueBB,
                preflopOpenRaiseToBB: r.preflopOpenRaiseToBB,
                preflopLastRaiseToBB: r.preflopLastRaiseToBB,
                preflopSequenceBeforeHero: r.preflopSequenceBeforeHero || '',
                preflopActualAction: r.preflopActualAction || '',
                preflopActualToken: r.preflopActualToken || '',
                preflopPlayersDealt: r.preflopPlayersDealt,
                preflopVillainsDealt: r.preflopVillainsDealt,
                preflopVillainsAtDecision: r.preflopVillainsAtDecision,

                predictedEquityPct: r.predictedEquityPct,
                headsUpEquityPct: r.headsUpEquityPct,
                jointToPairwiseGapPct: r.jointToPairwiseGapPct,
                equityTrials: r.equityTrials,
                equitySamplingStdErrPct: r.equitySamplingStdErrPct,
                villainContexts: Array.isArray(r.villainContexts) ? JSON.stringify(r.villainContexts) : '',
                potOddsPct: r.potOddsPct,
                villainCount: r.villainCount,
                equityModelVersion: r.equityModelVersion || equityModelMetaForRecord(r).version,
                equityModel: r.equityModel || equityModelMetaForRecord(r).model,
                equityCalibrationGroup: equityModelMetaForRecord(r).calibrationGroup,
                opponentModelVersion: r.opponentModelVersion || null,
                opponentHistoryApplied: r.opponentHistoryApplied || 0,
                opponentHistoryMaxHands: r.opponentHistoryMaxHands || 0,
                opponentHistoryRecordedVersion: r.opponentHistoryRecordedVersion || 0,
                postflopAdviceModelVersion: r.postflopAdviceModelVersion || null,
                postflopAdviceModel: r.postflopAdviceModel || '',
                postflopAdvice: r.postflopAdvice || '',
                postflopAdviceSize: r.postflopAdviceSize || '',
                postflopAdviceLabel: r.postflopAdviceLabel || '',
                boardTexture: r.boardTexture || '',

                foldedRiverResult: foldComparison.result || '',
                foldedRiverReason: foldComparison.reason || '',
                foldedComparedHandCount: foldComparison.comparedCount || 0,
                foldedComparisonWinner: foldComparison.winner || '',
                foldedComparisonWinnerCards: (foldComparison.winnerCards || []).join(' '),
                foldedHeroFinalHand: foldComparison.heroFinalHand || '',
                foldedWinnerFinalHand: foldComparison.winnerFinalHand || '',
                awardWinnerCount: r.awardWinnerCount || 0,
                hiddenAwardWinnerCount: r.hiddenAwardWinnerCount || 0,
                awards: Array.isArray(r.awards) ? JSON.stringify(r.awards) : '',
                revealedHands: r.revealedHands ? JSON.stringify(r.revealedHands) : '',

                flopEquityPct: flop.predictedEquityPct,
                flopHeadsUpEquityPct: flop.headsUpEquityPct,
                flopJointToPairwiseGapPct: flop.jointToPairwiseGapPct,
                flopVillainCount: flop.villainCount,
                flopEquityTrials: flop.trials,
                flopEquitySamplingStdErrPct: flop.samplingStdErrPct,
                flopEquityModelVersion: Object.keys(flop).length ? equityModelMetaForSnapshot(r, flop).version : null,
                flopEquityModel: Object.keys(flop).length ? equityModelMetaForSnapshot(r, flop).model : '',
                flopEquityCalibrationGroup: Object.keys(flop).length ? equityModelMetaForSnapshot(r, flop).calibrationGroup : '',
                flopOpponentModelVersion: flop.opponentModelVersion || null,
                flopOpponentHistoryApplied: flop.opponentHistoryApplied || 0,
                flopOpponentHistoryMaxHands: flop.opponentHistoryMaxHands || 0,
                flopVillainContexts: Array.isArray(flop.villainContexts) ? JSON.stringify(flop.villainContexts) : '',
                flopActionState: flop.actionState || '',
                flopPotBB: flop.potBB,
                flopToCallBB: flop.toCallBB,
                flopHeroStackBB: flop.heroStackBB,
                flopMinVillainStackBB: flop.minVillainStackBB,
                flopMaxVillainStackBB: flop.maxVillainStackBB,
                flopEffectiveStackBB: flop.effectiveStackBB,
                flopSPR: flop.spr,
                flopOracleEquityPct: flopOracle.equityPct,
                flopOracleOpponentCount: flopOracle.opponentCount,
                flopOracleExpectedOpponentCount: flopOracle.expectedOpponentCount,
                flopOracleComplete: flopOracle.complete,
                flopOracleRunouts: flopOracle.runouts,
                flopOracleReason: flopOracle.reason,
                flopEquityVsOracleDeltaPct: flopOracle.complete && Number.isFinite(flop.predictedEquityPct) && Number.isFinite(flopOracle.equityPct)
                    ? flop.predictedEquityPct - flopOracle.equityPct : null,
                flopPostflopAdviceModelVersion: flop.postflopAdviceModelVersion || null,
                flopPostflopAdviceModel: flop.postflopAdviceModel || '',
                flopPostflopAdvice: flop.postflopAdvice || '',
                flopPostflopAdviceSize: flop.postflopAdviceSize || '',
                flopPostflopAdviceLabel: flop.postflopAdviceLabel || '',
                flopPotOddsPct: flop.potOddsPct,
                flopBoardTexture: flop.boardTexture || '',
                flopBoard: (flop.board || []).join(' '),

                turnEquityPct: turn.predictedEquityPct,
                turnHeadsUpEquityPct: turn.headsUpEquityPct,
                turnJointToPairwiseGapPct: turn.jointToPairwiseGapPct,
                turnVillainCount: turn.villainCount,
                turnEquityTrials: turn.trials,
                turnEquitySamplingStdErrPct: turn.samplingStdErrPct,
                turnEquityModelVersion: Object.keys(turn).length ? equityModelMetaForSnapshot(r, turn).version : null,
                turnEquityModel: Object.keys(turn).length ? equityModelMetaForSnapshot(r, turn).model : '',
                turnEquityCalibrationGroup: Object.keys(turn).length ? equityModelMetaForSnapshot(r, turn).calibrationGroup : '',
                turnOpponentModelVersion: turn.opponentModelVersion || null,
                turnOpponentHistoryApplied: turn.opponentHistoryApplied || 0,
                turnOpponentHistoryMaxHands: turn.opponentHistoryMaxHands || 0,
                turnVillainContexts: Array.isArray(turn.villainContexts) ? JSON.stringify(turn.villainContexts) : '',
                turnActionState: turn.actionState || '',
                turnPotBB: turn.potBB,
                turnToCallBB: turn.toCallBB,
                turnHeroStackBB: turn.heroStackBB,
                turnMinVillainStackBB: turn.minVillainStackBB,
                turnMaxVillainStackBB: turn.maxVillainStackBB,
                turnEffectiveStackBB: turn.effectiveStackBB,
                turnSPR: turn.spr,
                turnOracleEquityPct: turnOracle.equityPct,
                turnOracleOpponentCount: turnOracle.opponentCount,
                turnOracleExpectedOpponentCount: turnOracle.expectedOpponentCount,
                turnOracleComplete: turnOracle.complete,
                turnOracleRunouts: turnOracle.runouts,
                turnOracleReason: turnOracle.reason,
                turnEquityVsOracleDeltaPct: turnOracle.complete && Number.isFinite(turn.predictedEquityPct) && Number.isFinite(turnOracle.equityPct)
                    ? turn.predictedEquityPct - turnOracle.equityPct : null,
                turnPostflopAdviceModelVersion: turn.postflopAdviceModelVersion || null,
                turnPostflopAdviceModel: turn.postflopAdviceModel || '',
                turnPostflopAdvice: turn.postflopAdvice || '',
                turnPostflopAdviceSize: turn.postflopAdviceSize || '',
                turnPostflopAdviceLabel: turn.postflopAdviceLabel || '',
                turnPotOddsPct: turn.potOddsPct,
                turnBoardTexture: turn.boardTexture || '',
                turnBoard: (turn.board || []).join(' '),

                riverEquityPct: river.predictedEquityPct,
                riverHeadsUpEquityPct: river.headsUpEquityPct,
                riverJointToPairwiseGapPct: river.jointToPairwiseGapPct,
                riverVillainCount: river.villainCount,
                riverEquityTrials: river.trials,
                riverEquitySamplingStdErrPct: river.samplingStdErrPct,
                riverEquityModelVersion: Object.keys(river).length ? equityModelMetaForSnapshot(r, river).version : null,
                riverEquityModel: Object.keys(river).length ? equityModelMetaForSnapshot(r, river).model : '',
                riverEquityCalibrationGroup: Object.keys(river).length ? equityModelMetaForSnapshot(r, river).calibrationGroup : '',
                riverOpponentModelVersion: river.opponentModelVersion || null,
                riverOpponentHistoryApplied: river.opponentHistoryApplied || 0,
                riverOpponentHistoryMaxHands: river.opponentHistoryMaxHands || 0,
                riverVillainContexts: Array.isArray(river.villainContexts) ? JSON.stringify(river.villainContexts) : '',
                riverActionState: river.actionState || '',
                riverPotBB: river.potBB,
                riverToCallBB: river.toCallBB,
                riverHeroStackBB: river.heroStackBB,
                riverMinVillainStackBB: river.minVillainStackBB,
                riverMaxVillainStackBB: river.maxVillainStackBB,
                riverEffectiveStackBB: river.effectiveStackBB,
                riverSPR: river.spr,
                riverOracleEquityPct: riverOracle.equityPct,
                riverOracleOpponentCount: riverOracle.opponentCount,
                riverOracleExpectedOpponentCount: riverOracle.expectedOpponentCount,
                riverOracleComplete: riverOracle.complete,
                riverOracleRunouts: riverOracle.runouts,
                riverOracleReason: riverOracle.reason,
                riverEquityVsOracleDeltaPct: riverOracle.complete && Number.isFinite(river.predictedEquityPct) && Number.isFinite(riverOracle.equityPct)
                    ? river.predictedEquityPct - riverOracle.equityPct : null,
                riverPostflopAdviceModelVersion: river.postflopAdviceModelVersion || null,
                riverPostflopAdviceModel: river.postflopAdviceModel || '',
                riverPostflopAdvice: river.postflopAdvice || '',
                riverPostflopAdviceSize: river.postflopAdviceSize || '',
                riverPostflopAdviceLabel: river.postflopAdviceLabel || '',
                riverPotOddsPct: river.potOddsPct,
                riverBoardTexture: river.boardTexture || '',
                riverBoard: (river.board || []).join(' '),

                tableBB: r.tableBB,
                invested: r.invested,
                returned: r.returned,
                net: r.net,
                investedBB: r.investedBB,
                returnedBB: r.returnedBB,
                netBB: r.netBB,
                contributions: Array.isArray(r.contributions)
                    ? r.contributions.map(x => {
                        const amount = Number.isFinite(x.amount) ? x.amount : '?';
                        return `${x.action}:${amount}${x.unit || ''}`;
                    }).join('|')
                    : ''
            };
        });
    }

    function downloadPerformance(format) {
        const rows = performanceExportRows();
        let body = '';
        let type = '';
        let ext = '';
        if (format === 'json') {
            const expectedHero = expectedHeroIdentity();
            body = JSON.stringify({
                expectedHero: {
                    id: expectedHero.id || '',
                    name: expectedHero.name || '',
                    source: expectedHero.source || ''
                },
                exportedAt: new Date().toISOString(),
                sidearmVersion: SIDEARM_VERSION,
                dataSchemaVersion: DATA_SCHEMA_VERSION,
                modelVersions: {
                    preflop: PREFLOP_STRATEGY_VERSION,
                    equity: EQUITY_MODEL_VERSION,
                    opponentHistory: OPPONENT_MODEL_VERSION,
                    postflopAdvice: POSTFLOP_ADVICE_MODEL_VERSION,
                    whyExplainer: WHY_EXPLAINER_VERSION
                },
                currentPreflopRangeStyle: currentPreflopRangeStyle(),
                integrity: performanceIntegritySummary(),
                summary: performanceSummary(),
                hands: rows
            }, null, 2);
            type = 'application/json';
            ext = 'json';
        } else {
            const cols = rows.length ? Object.keys(rows[0]) : [
                'dataSchemaVersion','sidearmVersion','gameId','timestamp','hero','outcome','cards','actions'
            ];
            const csvCell = v => {
                const s = v == null ? '' : String(v);
                return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            };
            body = [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');
            type = 'text/csv';
            ext = 'csv';
        }
        const blob = new Blob([body], { type: type + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `torn-poker-sidearm-performance-${new Date().toISOString().slice(0,10)}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function formatOutcomeForCopy(outcome) {
        const o = String(outcome || '').trim().toLowerCase();
        if (o === 'win') return 'Win';
        if (o === 'loss') return 'Loss';
        if (o === 'fold') return 'Fold';
        if (o === 'tie') return 'Tie';
        return o ? (o.charAt(0).toUpperCase() + o.slice(1)) : '';
    }

    function formatNetBBForCopy(netBB) {
        const n = Number(netBB);
        if (!Number.isFinite(n)) return '';
        const sign = n > 0 ? '+' : '';
        return sign + n.toFixed(1) + 'bb';
    }

    function completedRecordForGame(gameId) {
        if (!gameId) return null;
        try {
            return loadHandRecords().find(r => r && r.gameId === gameId) || null;
        } catch (_) {
            return null;
        }
    }

    function handRecordToText(rec) {
        if (!rec) return '';
        const lines = ['Torn Poker Sidearm - hand note'];
        if (rec.gameId) lines.push('Game ID: ' + rec.gameId);
        const tableLabel = formatTableContextLabel({
            key: rec.tableKey || '',
            name: rec.tableName || '',
            bb: Number.isFinite(rec.tableCashBB) ? rec.tableCashBB : rec.tableBB
        });
        if (tableLabel) lines.push('Table: ' + tableLabel);
        if (rec.seat) lines.push('Seat: ' + rec.seat);
        if (rec.cards && rec.cards.length) {
            let line = 'Cards: ' + rec.cards.join(' ');
            if (rec.handClass) line += ' (' + rec.handClass + (rec.handTag ? ', ' + rec.handTag : '') + ')';
            lines.push(line);
        } else if (rec.handClass) {
            lines.push('Cards: ' + rec.handClass + (rec.handTag ? ' (' + rec.handTag + ')' : ''));
        }
        if (rec.actionLine) lines.push('Actions: ' + rec.actionLine);
        if (rec.heroAction) lines.push('Advice: ' + actionVerb(rec.heroAction));
        if (rec.board && rec.board.length) lines.push('Board: ' + rec.board.join(' '));
        const outcomeText = formatOutcomeForCopy(rec.outcome);
        if (outcomeText) lines.push('Outcome: ' + outcomeText);
        const netBBText = formatNetBBForCopy(rec.netBB);
        if (netBBText) lines.push('Your net: ' + netBBText);
        if (rec.stackBB != null) lines.push('Stack: ' + Math.round(rec.stackBB) + 'bb');
        return lines.join('\n');
    }

    function saveLastHandNote(text) {
        const note = String(text || '').trim();
        if (!note) return;
        try { localStorage.setItem(LAST_HAND_KEY, note); } catch (_) {}
    }
    function archiveHandRecord(record) {
        if (!record) return;
        if (!record.heroDealtVerified) return;
        if (!Array.isArray(record.cards) || record.cards.length !== 2) return;
        const arr = loadHandRecords();
        const text = handRecordToText(record);

        let idx = -1;
        if (record.gameId) {
            idx = arr.findIndex(x => x && x.gameId === record.gameId);
        } else {
            // Legacy fallback for hands recorded before gameId support.
            const fingerprint = [(record.cards || []).join(','), record.actionLine || '', record.history || ''].join('|');
            idx = arr.findIndex(x =>
                [x.cards || [], x.actionLine || '', x.history || ''].join('|') === fingerprint
            );
        }

        if (idx >= 0) {
            // Replace the earlier partial snapshot with the latest/final state.
            arr.splice(idx, 1);
        }
        arr.unshift(record);
        saveHandRecords(arr);
        if (text) saveLastHandNote(text);
    }
    function loadLastHandNote() {
        const records = loadHandRecords();
        if (records.length) return handRecordToText(records[0]);
        const arr = loadHandNotes();
        if (arr.length) return arr[0];
        try { return localStorage.getItem(LAST_HAND_KEY) || ''; } catch { return ''; }
    }
    function loadLastHandNotes(count) {
        const n = Math.max(1, Math.min(parseInt(count, 10) || 1, HISTORY_MAX));
        const records = loadHandRecords();
        if (records.length) return records.slice(0, n).map(handRecordToText);
        const arr = loadHandNotes();
        if (arr.length) return arr.slice(0, n);
        const legacy = loadLastHandNote();
        return legacy ? [legacy] : [];
    }

    let _liveHandRecord = null;
    function updateLiveHandNote(ctx) {
        if (!ctx?.holeCards?.length) return;
        const state = currentV6GameState();
        if (!state?.gameId || state.completed) return;
        const previous = _v6Runtime.liveRecords.get(state.gameId) || null;
        const privatePreflopProof =
            heroHasPrivateHoleCards() &&
            Array.isArray(ctx.holeCards) &&
            ctx.holeCards.length === 2 &&
            (!Array.isArray(ctx.boardCards) || ctx.boardCards.length < 3) &&
            state.street === 'preflop';

        // Do not manufacture a hand from cards first seen at showdown while
        // observing. For clean calibration data we require Sidearm to have seen
        // the hero's two private cards during preflop.
        if (!previous && !privatePreflopProof) return;

        const next = buildHandRecord(ctx, state.lines.join('\n'));
        next.heroDealtVerified = !!(previous?.heroDealtVerified || privatePreflopProof);

        const decisionFields = [
            'preflopStrategyVersion','preflopRangeStyle','preflopRangeStyleAdjusted','preflopBalancedBaselineAction','preflopBalancedBaselineStrength','preflopAdvice','preflopAdviceStrength','preflopHandGroup',
            'preflopHeroSeat','preflopHeroPosition',
            'preflopStackBB','preflopStackDepth',
            'preflopFacingRaise','preflopRaiseCountBeforeHero',
            'preflopCallCountBeforeHero','preflopFoldCountBeforeHero',
            'preflopOpenerName','preflopOpenerSeat','preflopOpenerBucket',
            'preflopLastRaiserName','preflopLastRaiserSeat','preflopLastRaiserBucket',
            'preflopPressureBucket','preflopPressureScore','preflopHighestBetBB',
            'preflopHeroCommittedBB','preflopCostToContinueBB','preflopOpenRaiseToBB','preflopLastRaiseToBB',
            'preflopSequenceBeforeHero',
            'preflopPlayersDealt','preflopVillainsDealt','preflopVillainsAtDecision',
            'preflopActualAction','preflopActualToken','preflopHeroActed'
        ];

        if (previous) {
            next.id = previous.id;
            next.t = previous.t;
            next.heroName = previous.heroName || next.heroName;
            next.heroIdentitySource = previous.heroIdentitySource || next.heroIdentitySource;

            if (previous.preflopDecisionFrozen === true) {
                // Once the hero has acted, retain the exact same decision
                // snapshot forever. Empty strings, zero counts and false flags
                // are meaningful and must not be filled by later hand state.
                for (const key of decisionFields) next[key] = previous[key];
                next.preflopDecisionFrozen = true;
            } else if (next.preflopHeroActed) {
                // This refresh contains the hero's first voluntary action, so
                // this is the decision point we want for calibration.
                next.preflopDecisionFrozen = true;
            } else {
                // Hero has not acted yet: allow calls/folds/raises before Hero
                // to update the pending decision context.
                next.preflopDecisionFrozen = false;
            }

            next.equitySnapshots = {
                ...(previous.equitySnapshots || {}),
                ...(next.equitySnapshots || {})
            };
        } else {
            next.preflopDecisionFrozen = !!next.preflopHeroActed;
        }

        _v6Runtime.liveRecords.set(state.gameId, next);
        _liveHandRecord = next;
    }


    function maybeStoreLastHand(ctx) {
        updateLiveHandNote(ctx);
    }

    function getContext() {
        refreshLiveLogSnapshot();
        const handState = currentV6GameState();
        const domMatchesHand = !handState || liveDomMatchesGameTable(handState);

        const cachedPosition = handState?.gameId
            ? (getImmutableGameState(handState.gameId)?.heroPosition || '')
            : '';
        const autoExact = domMatchesHand ? getSelfExactPosition() : cachedPosition;
        const autoBucket = domMatchesHand ? getSelfPositionBucket() : seatToBucket(cachedPosition || '');
        const detectedExact = autoExact || autoBucket || '';
        const exact = detectedExact;
        const position = seatToBucket(detectedExact || 'MP');

        const preAct = detectPreflopAction(domMatchesHand);
        const facingRaise = preAct.facingRaise;
        const openerDetected = preAct.openerBucket;
        const openerMatched = !!preAct.openerMatched;
        const openerBucket = openerDetected || 'Late';
        const preflopPressure = classifyPreflopPressure({
            ...(preAct.pressure || {}),
            raiseCount: preAct.raiseCount || 0,
            callCount: preAct.callCount || 0,
            openerBucket,
            lastRaiserBucket: preAct.lastRaiserBucket || openerBucket
        });

        const holeCards = domMatchesHand ? readOwnCardsFromDOM() : null;
        const handClass = holeCards ? canonicalHand(holeCards) : null;
        let heroAction = null, heroStrength = null, heroEval = null;
        const preflopAwaitingAction = !!(
            holeCards &&
            position === 'BB' &&
            preflopPressure?.bucket === 'unopened' &&
            !preAct.heroActed
        );
        if (holeCards && !preflopAwaitingAction) {
            const ev = evalPreflopHand(holeCards, position, facingRaise, openerBucket, preflopPressure);
            if (ev) { heroEval = ev; heroAction = ev.action; heroStrength = ev.strength; }
        }
        const handTag = handClassTag(heroEval);
        const potLine = preflopPressureShortLabel(preflopPressure);
        const depthInfo = domMatchesHand
            ? resolveStackDepth()
            : { depth: 'deep', mode: 'auto', stackBB: null, detected: null, source: 'table-mismatch', fallback: true };

        let domBoard = domMatchesHand ? readBoardCardsFromDOM() : [];
        if (holeCards?.length) {
            const holeKeys = new Set(holeCards.map(normalizeCardKey).filter(Boolean));
            domBoard = domBoard.filter(c => !holeKeys.has(normalizeCardKey(c)));
        }

        let board = preferMoreCompleteBoard(domBoard, handState?.board || []);
        const newHandAge = Date.now() - (_v6Runtime.gameChangedAt || 0);
        if (handState && handState.street === 'preflop' && !handState.board.length &&
            _v6Runtime.gameChangedAt && newHandAge < V6_NEW_HAND_SETTLE_MS) {
            // Prevent the previous hand's clearing board from triggering a fresh
            // Monte Carlo during the exact hand-transition window.
            board = [];
        }

        const onBoard = board.length >= 3;
        const streetPreflop = (handState ? handState.street === 'preflop' : !onBoard) && !onBoard;
        const potInfo = onBoard && domMatchesHand
            ? detectPotAndCall()
            : { pot: null, toCall: null, potOddsPct: null, potBB: null, toCallBB: null, actionState: 'none' };
        const staleHoleCards = !!(onBoard && holeCards?.length >= 2 && physicalCardOverlapKeys(holeCards, board).length);

        let equity = null;
        const liveVillains = handState ? countLiveVillains(handState) : 0;
        const topologyStable = domMatchesHand && tableTopologyIsStable();

        if (onBoard && holeCards?.length >= 2 && !staleHoleCards && liveVillains > 0 && topologyStable) {
            try {
                const fallbackRangeProfile = detectVillainPostflopProfile(preAct, potInfo);
                const texture = classifyBoardTexture(board);
                const villainProfiles = buildLiveVillainProfiles(board, potInfo);
                const rangeProfile = liveVillains === 1 && villainProfiles.length
                    ? liveProfileToRangeProfile(villainProfiles[0], fallbackRangeProfile, potInfo)
                    : fallbackRangeProfile;

                const profileKey = [
                    rangeProfile.bucket,
                    rangeProfile.preflopRaises,
                    rangeProfile.aggression,
                    rangeProfile.sizeRatio == null ? '-' : rangeProfile.sizeRatio.toFixed(2),
                    rangeProfile.street,
                    rangeProfile.villain,
                    rangeProfile.history?.eligible ? `hist${rangeProfile.history.hands}:${rangeProfile.history.vpipPct.toFixed(0)}:${rangeProfile.history.pfrPct.toFixed(0)}` : 'hist-'
                ].join(':');

                const actionHistoryKey = villainProfiles.map(p => [
                    p.name, p.preflopRaises, p.preflopCalls, p.checks, p.calls,
                    p.bets, p.raises, p.checkRaises, p.lastStreet, p.lastAction,
                    (p.sizeBuckets || []).join(',')
                ].join(':')).sort().join(';');

                const key = [
                    handState?.gameId || '',
                    holeCards.map(normalizeCardKey).join(','),
                    board.map(normalizeCardKey).join(','),
                    profileKey,
                    'villains=' + liveVillains,
                    'texture=' + texture.label + ':' + texture.wetScore,
                    'history=' + actionHistoryKey,
                    potInfo.actionState || 'none',
                    potInfo.toCall ?? '-',
                    potInfo.pot ?? '-'
                ].join('|');

                if (_equityCache.key === key && _equityCache.value) {
                    equity = _equityCache.value;
                } else {
                    const trials = multiwayTrialCount(liveVillains);

                    if (liveVillains > 1) {
                        equity = monteCarloMultiwayEquity(
                            holeCards, board, trials, villainProfiles, rangeProfile, potInfo, texture
                        );
                    } else if (board.length === 5) {
                        equity = exactRiverHeadsUpEquity(holeCards, board, rangeProfile);
                    } else {
                        equity = monteCarloEquity(holeCards, board, trials, rangeProfile);
                    }

                    if (equity && Number.isFinite(equity.winPct)) {
                        if (!Number.isFinite(equity.headsUpPct)) equity.headsUpPct = equity.winPct;
                        equity.villainCount = liveVillains;
                        equity.boardTexture = texture.label;
                        equity.model = liveVillains > 1
                            ? 'joint-multiway'
                            : (board.length === 5 ? 'weighted-range-river-exact' : 'weighted-range');
                        equity.villainContexts = villainProfiles.map(p =>
                            compactVillainCalibrationContext(p, fallbackRangeProfile, potInfo, texture)
                        );
                    }
                    _equityCache = { key, value: equity, at: Date.now() };
                }
            } catch (e) {
                console.error('[TPS] V6 weighted multi-villain equity', e);
            }
        }

        const postflopAdvice = (onBoard && equity && holeCards?.length >= 2)
            ? buildPostflopAdvice(holeCards, board, equity, potInfo, liveVillains)
            : null;

        return {
            position, exact, facingRaise,
            openerBucket, openerDetected, openerMatched, openerName: preAct.openerName,
            lastRaiserName: preAct.lastRaiserName, lastRaiserBucket: preAct.lastRaiserBucket,
            preflopPressure,
            rangeStyle: currentPreflopRangeStyle(),
            preflop: streetPreflop, holeCards, handClass, preflopAwaitingAction,
            heroAction, heroStrength, heroEval, handTag, potLine,
            depthInfo, boardCards: board, equity, postflopAdvice, onBoard, potInfo, staleHoleCards,
            actionLine: handState?.actionLine || '',
            villainCount: liveVillains,
            positionAuto: autoBucket, exactAuto: autoExact,
            positionFallback: !autoExact && !autoBucket
        };
    }


    // ── FFScouter API ────────────────────────────────────────────


    async function fetchFfStatsMulti(ids) {
        const key = (settings.ffKey || '').trim();
        if (!key) throw new Error('Önce FFScouter API anahtarını kaydet (Ayarlar).');
        if (!/^[a-zA-Z0-9]{16}$/.test(key)) throw new Error('Anahtar 16 harf/rakam olmalı.');
        const unique = [...new Set(ids.map(String).filter(id => /^\d+$/.test(id)))];
        if (!unique.length) return [];
        // API accepts comma-separated targets
        const url = 'https://ffscouter.com/api/v1/get-stats?key=' + encodeURIComponent(key)
            + '&targets=' + encodeURIComponent(unique.join(','));
        const res = await gmRequest({ url });
        const data = parseJson(res);
        if (data && data.error) throw new Error(data.error + (data.code != null ? ' (' + data.code + ')' : ''));
        if (!Array.isArray(data)) return [];
        const now = Date.now();
        for (const st of data) {
            const pid = String(st.player_id || '');
            if (pid) _ffScoreCache[pid] = { fair_fight: st.fair_fight, at: now, raw: st };
        }
        return data;
    }

    async function ensureHistoryFfScores() {
        const arr = loadHistory();
        const need = [];
        const now = Date.now();
        for (const h of arr) {
            if (!h.playerId) continue;
            const c = _ffScoreCache[String(h.playerId)];
            if (!c || (now - c.at) > FF_SCORE_CACHE_MS) need.push(String(h.playerId));
        }
        if (!need.length) return;
        if (!(settings.ffKey || '').trim()) return;
        try {
            // chunk 10
            for (let i = 0; i < need.length; i += 10) {
                await fetchFfStatsMulti(need.slice(i, i + 10));
            }
        } catch (e) {
            console.warn('[TPS] history FF scores', e);
        }
    }

    async function fetchFfStats(playerId) {
        const key = (settings.ffKey || '').trim();
        if (!key) throw new Error('Önce FFScouter API anahtarını kaydet (Ayarlar).');
        if (!/^[a-zA-Z0-9]{16}$/.test(key)) throw new Error('Anahtar 16 harf/rakam olmalı.');
        const url = `https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(key)}&targets=${encodeURIComponent(playerId)}`;
        const res = await gmRequest({ url });
        const data = parseJson(res);
        if (data && data.error) throw new Error(data.error + (data.code != null ? ` (${data.code})` : ''));
        if (!Array.isArray(data) || !data.length) throw new Error('Bu oyuncu için bilgi yok.');
        return data[0];
    }

    async function registerFfKey(key) {
        const k = (key || '').trim();
        if (!/^[a-zA-Z0-9]{16}$/.test(k)) throw new Error('Anahtar 16 harf/rakam olmalı.');
        const res = await gmRequest({
            method: 'POST',
            url: 'https://ffscouter.com/api/v1/register',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            data: JSON.stringify({
                key: k,
                agree_to_data_policy: true,
                signup_source: SIGNUP_SOURCE,
            }),
        });
        const data = parseJson(res);
        if (data && data.error) throw new Error(data.error + (data.code != null ? ` (${data.code})` : ''));
        if (!data || !data.success) throw new Error(data && data.message ? data.message : 'Register failed.');
        return data;
    }

    async function quoteBounty(quantity, pricePerHit) {
        const q = clamp(parseInt(quantity, 10) || 1, 1, 1000);
        const p = clamp(parseInt(pricePerHit, 10) || MIN_PRICE, MIN_PRICE, MAX_PRICE);
        const url = `https://ffscouter.com/api/v1/bounties/orders/quote?quantity=${q}&price_per_hit=${p}`;
        const res = await gmRequest({ url });
        const data = parseJson(res);
        if (data && data.error) throw new Error(data.error + (data.code != null ? ` (${data.code})` : ''));
        if (!data || !data.quote) throw new Error('Quote failed.');
        return data.quote;
    }

    async function placeBountyOrder(targetPlayerId, quantity, pricePerHit) {
        const body = {
            target_player_id: parseInt(targetPlayerId, 10),
            quantity: clamp(parseInt(quantity, 10) || 1, 1, 1000),
            price_per_hit: clamp(parseInt(pricePerHit, 10) || MIN_PRICE, MIN_PRICE, MAX_PRICE),
            referrer_player_id: REFERRER_PLAYER_ID,
        };
        const res = await gmRequest({
            method: 'POST',
            url: 'https://ffscouter.com/api/v1/bounties/orders',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            data: JSON.stringify(body),
        });
        const data = parseJson(res);
        if (data && data.error) throw new Error(data.error + (data.code != null ? ` (${data.code})` : ''));
        if (!data || !data.order) throw new Error('Place order failed (HTTP ' + res.status + ').');
        return data.order;
    }


    /**
     * Only players seated at the holdem table.
     * Do NOT scan global XID links (chat, sidebar, lists) - that pulls in random names.
     */
    function scanPagePlayers() {
        const map = new Map();

        // Prefer Torn seat nodes: #player-{id} inside the table, not self
        const seats = document.querySelectorAll(
            '[class*="playerPositioner"] [id^="player-"],' +
            '[class*="Player"] [id^="player-"],' +
            '[id^="player-"][class*="player___"],' +
            '[id^="player-"]'
        );

        seats.forEach(el => {
            const m = el.id && el.id.match(/^player-(\d+)$/);
            if (!m) return;
            // Skip hero
            if (/self/i.test(el.className || '')) return;
            if (el.closest('[class*="self___"], [class*="selfPositioner"]')) return;

            // Must look like a table seat (has stack/cards area or positioner parent)
            const inTable =
                el.closest('[class*="playerPositioner"]') ||
                el.closest('[class*="holdem"]') ||
                el.closest('[class*="table"]') ||
                el.querySelector('[class*="potString"], [class*="money"], [class*="detailsItem"]') ||
                el.querySelector('[class*="name"], [class*="Name"]');
            if (!inTable) return;

            let name = nameFromSeatEl(el, 28);
            // Skip empty / placeholder
            if (!name || /^player\s*\d+$/i.test(name)) name = 'Player ' + m[1];

            map.set(m[1], name);
        });

        return [...map.entries()].map(([id, name]) => ({ id, name }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }


    function readSeatStackRaw(seat) {
        if (!seat) return null;
        const items = seat.querySelectorAll('[class*="detailsItem___"]');
        let mobile = null;
        for (const item of items) {
            const p = item.querySelector('p');
            if (p && (/^\$/.test((p.textContent || '').trim()) || /BB/i.test(p.textContent || ''))) {
                mobile = p; break;
            }
        }
        const stackEl = seat.querySelector('[class*="potString___"]')
            || seat.querySelector('[class*="money___"]')
            || seat.querySelector('[class*="pot___"]')
            || mobile;
        if (!stackEl) return null;
        const raw = [...stackEl.childNodes]
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => (n.textContent || '').trim()).filter(Boolean).join('')
            || (stackEl.textContent || '').trim();
        if (!raw) return null;
        if (/all.?in/i.test(raw)) return { kind: 'allin', value: 0, raw };
        const bb = parseBBToken(raw);
        if (bb != null) return { kind: 'bb', value: bb, raw };
        const cash = parseCash(raw);
        return cash != null ? { kind: 'cash', value: cash, raw } : null;
    }

    function normaliseDepartureStack(raw, tableBB) {
        if (!raw) return { bb: null, cash: null };
        if (raw.kind === 'allin') return { bb: 0, cash: 0 };

        const validBB = Number.isFinite(tableBB) && tableBB > 0;
        if (raw.kind === 'bb' && Number.isFinite(raw.value)) {
            return { bb: raw.value, cash: validBB ? raw.value * tableBB : null };
        }
        if (raw.kind === 'cash' && Number.isFinite(raw.value)) {
            return { bb: validBB ? raw.value / tableBB : null, cash: raw.value };
        }
        return { bb: null, cash: null };
    }

    function formatCompactDollars(value) {
        if (value == null || value === '') return '';
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return '';

        const tiers = [
            [1e9, 'B'],
            [1e6, 'M'],
            [1e3, 'K']
        ];
        for (const [divisor, suffix] of tiers) {
            if (n < divisor) continue;
            const scaled = n / divisor;
            const decimals = scaled < 100 ? 1 : 0;
            const text = scaled.toFixed(decimals).replace(/\.0$/, '');
            return `$${text}${suffix}`;
        }
        return `$${Math.round(n)}`;
    }

    function formatDepartureStack(stackBB, stackCash) {
        const bb = Number.isFinite(stackBB) ? `${Math.round(stackBB)}bb` : '?bb';
        const cash = formatCompactDollars(stackCash);
        return cash ? `${bb} · ${cash}` : bb;
    }

    function updateDepartureStackState(id, name, raw, tableContext, seenAt = Date.now()) {
        const pid = String(id || '');
        if (!pid) return null;

        const tableKey = String(tableContext?.key || '');
        const tableBB = Number.isFinite(tableContext?.bb) && tableContext.bb > 0
            ? tableContext.bb
            : null;
        const prior = _departureStackStates.get(pid);
        const prev = prior && prior.tableKey === tableKey
            ? prior
            : {
                id: pid,
                name: name || `Player ${pid}`,
                tableKey,
                tableBB,
                state: 'unknown',
                stackBB: null,
                stackCash: null,
                lastPositiveStackBB: null,
                lastPositiveStackCash: null,
                raw: '',
                seenAt: 0,
                terminalSeenAt: 0
            };

        prev.tableKey = tableKey;
        prev.tableBB = tableBB;
        if (name && !/^Player\s+\d+$/i.test(name)) prev.name = name;

        const { bb, cash } = normaliseDepartureStack(raw, tableBB);
        if (raw?.kind === 'allin') {
            prev.state = 'allin';
            prev.stackBB = 0;
            prev.stackCash = 0;
            prev.raw = raw.raw || 'ALL IN';
            prev.terminalSeenAt = seenAt;
        } else if (Number.isFinite(bb) && bb <= 0) {
            prev.state = 'zero';
            prev.stackBB = 0;
            prev.stackCash = Number.isFinite(cash) ? cash : 0;
            prev.raw = raw?.raw || '0';
            prev.terminalSeenAt = seenAt;
        } else if (Number.isFinite(bb) && bb > 0) {
            // A later positive stack clears an earlier all-in/zero observation.
            // This covers shove -> win -> leave.
            prev.state = 'positive';
            prev.stackBB = bb;
            prev.stackCash = Number.isFinite(cash) ? cash : null;
            prev.lastPositiveStackBB = bb;
            if (Number.isFinite(cash)) prev.lastPositiveStackCash = cash;
            prev.raw = raw?.raw || '';
            prev.terminalSeenAt = 0;
        }
        // If the stack is temporarily unreadable, keep the last confirmed state
        // rather than replacing ALL IN / 0 with "unknown".
        prev.seenAt = seenAt;
        _departureStackStates.set(pid, prev);
        return prev;
    }

    function departureSeatNodesFromMutationNode(node) {
        if (!node || node.nodeType !== 1) return [];
        const out = [];
        if (node.matches?.('[id^="player-"]')) out.push(node);
        node.querySelectorAll?.('[id^="player-"]').forEach(el => out.push(el));
        return out;
    }

    function removedNodeContainsHeroSeat(node, heroId) {
        if (!node || node.nodeType !== 1) return false;

        const wantedId = heroId ? `player-${heroId}` : '';
        if (wantedId && node.id === wantedId) return true;
        if (wantedId && node.querySelector?.(`#${CSS.escape(wantedId)}`)) return true;

        // Extra protection for Torn renders where the self wrapper is removed
        // before the player-ID lookup can be resolved.
        if (node.matches?.('[class*="selfPositioner"], [class*="self___"], [class*="Self"]')) return true;
        if (node.querySelector?.('[class*="selfPositioner"], [class*="self___"], [class*="Self"]')) return true;

        return false;
    }

    function currentDepartureTableContext() {
        // Departure cash conversion is deliberately stricter than normal hand
        // context: only the exact felt currently rendered on screen may supply
        // a BB-to-$ conversion. No Game-ID cache, old table state or stake-text
        // fallback is allowed here.
        return getExactRenderedTableContext();
    }

    function departureAlertKey(tableKey, playerId) {
        return `${String(tableKey || '')}:${String(playerId || '')}`;
    }

    function observeDepartureStackMutations(records) {
        // Lightweight, departure-only watcher. It deliberately runs before the
        // normal 400ms Sidearm refresh so ALL IN / 0 and table-switch signals
        // are less likely to be lost when Torn removes seats quickly.
        try {
            const tableContext = currentDepartureTableContext();
            const rememberedHeroId = String(
                currentV6GameState()?.heroSeatId ||
                getSelfSeatId() ||
                ''
            );

            const inspect = el => {
                const m = String(el?.id || '').match(/^player-(\d+)$/);
                if (!m) return;
                const id = m[1];
                if (id === rememberedHeroId) return;

                const exact = exactNameForPlayerIdFromElement(el, id);
                const loose = nameFromSeatEl(el) || '';
                const name = exact || loose || `Player ${id}`;
                const raw = readSeatStackRaw(el);
                updateDepartureStackState(id, name, raw, tableContext);
            };

            // Current seats catch character/class changes.
            document.querySelectorAll('[id^="player-"]').forEach(inspect);

            // Removed nodes retain their final DOM contents in the mutation
            // record. They can capture both bust state and the hero leaving a
            // table before the replacement table has finished rendering.
            for (const record of records || []) {
                for (const node of record.removedNodes || []) {
                    if (removedNodeContainsHeroSeat(node, rememberedHeroId)) {
                        _departureHeroSeatRemovedAt = Date.now();
                        _departureTableResetPending = true;
                    }
                    departureSeatNodesFromMutationNode(node).forEach(inspect);
                }
            }
        } catch (_) {}
    }

    function snapshotSeatedVillains() {
        const map = new Map();
        const heroId = String(getSelfSeatId() || '');
        const tableContext = currentDepartureTableContext();
        const tableKey = String(tableContext?.key || '');

        document.querySelectorAll('[id^="player-"]').forEach(el => {
            const m = String(el.id || '').match(/^player-(\d+)$/);
            if (!m) return;
            const id = m[1];
            if (id === heroId) return;
            if (/self/i.test(el.className || '') ||
                el.closest('[class*="self___"], [class*="selfPositioner"]')) return;

            const exact = exactNameForPlayerIdFromElement(el, id);
            const loose = nameFromSeatEl(el) || (() => {
                const a = el.querySelector('a[href*="XID="], a[href*="user2ID="]');
                return a ? String(a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) : '';
            })();
            const name = exact || loose || `Player ${id}`;

            const raw = readSeatStackRaw(el);
            const tracked = updateDepartureStackState(id, name, raw, tableContext) ||
                _departureStackStates.get(id);

            const positive = tracked?.state === 'positive' && Number.isFinite(tracked.stackBB)
                ? tracked.stackBB
                : null;
            const bustState = tracked?.state === 'allin' || tracked?.state === 'zero';

            map.set(id, {
                id,
                tableKey,
                name: tracked?.name || name,
                nameKnown: (tracked?.name || name) !== `Player ${id}`,
                stackBB: bustState ? 0 : positive,
                stackCash: bustState
                    ? 0
                    : (Number.isFinite(tracked?.stackCash) ? tracked.stackCash : null),
                lastPositiveStackBB: Number.isFinite(tracked?.lastPositiveStackBB)
                    ? tracked.lastPositiveStackBB
                    : positive,
                lastPositiveStackCash: Number.isFinite(tracked?.lastPositiveStackCash)
                    ? tracked.lastPositiveStackCash
                    : (Number.isFinite(tracked?.stackCash) ? tracked.stackCash : null),
                stackState: tracked?.state || 'unknown',
                stackRaw: tracked?.raw || raw?.raw || '',
                terminalSeenAt: tracked?.terminalSeenAt || 0,
                bustPending: bustState,
                seenAt: Date.now()
            });
        });
        return map;
    }

    function initialiseDepartedSnapshot() {
        if (_departedSeatSnapshot.size) return;
        const ctx = currentDepartureTableContext();
        const snap = snapshotSeatedVillains();
        if (snap.size) _departedSeatSnapshot = snap;
        _departureTableKey = String(ctx?.key || '');
    }

    function ensureDebugDepartureHost() {
        if (debug !== 1) return null;
        let host = document.getElementById('tps-debug-departures');
        if (host) return host;

        host = document.createElement('div');
        host.id = 'tps-debug-departures';
        host.innerHTML = `
            <div class="tps-debug-departures-title">Sidearm DEBUG · departures</div>
            <div class="tps-debug-departures-meta">
                Monitor active · production target ≥ ${DEPARTED_DEEP_STACK_BB}bb · bust/ALL-IN suppression · ${Math.round(DEPARTED_ALERT_MS / 1000)}s timeout
            </div>
            <div id="tps-debug-departures-list">
                <div class="tps-debug-departure-empty">No departures detected yet</div>
            </div>`;
        document.body.appendChild(host);
        return host;
    }

    function removeDebugDeparture(key) {
        const wanted = String(key || '');
        const idx = _debugDepartures.findIndex(d => String(d.key || '') === wanted);
        if (idx >= 0) _debugDepartures.splice(idx, 1);
        renderDebugDepartures();
    }

    function renderDebugDepartures() {
        if (debug !== 1) return;
        const host = ensureDebugDepartureHost();
        if (!host) return;
        const list = host.querySelector('#tps-debug-departures-list');
        if (!list) return;

        if (!_debugDepartures.length) {
            list.innerHTML = '<div class="tps-debug-departure-empty">No departures detected yet</div>';
            return;
        }

        list.innerHTML = _debugDepartures.map(d => {
            const stack = formatDepartureStack(d.stackBB, d.stackCash);
            const lastPositive = formatDepartureStack(
                d.lastPositiveStackBB,
                d.lastPositiveStackCash
            );
            const when = new Date(d.at).toLocaleTimeString([], {
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            const status = d.busted
                ? `BUST / ${String(d.stackState || 'zero').toUpperCase()} · last positive ${lastPositive} · POPUP SUPPRESSED`
                : (d.productionEligible
                    ? (d.popupTriggered ? 'TARGET · POPUP MOUNTED' : 'TARGET · POPUP FAILED/SUPPRESSED')
                    : 'below threshold');

            const tableBits = [
                d.tableName ? `Table: ${d.tableName}` : '',
                d.tableKey ? `key: ${d.tableKey}` : '',
                Number.isFinite(d.tableBB) && d.tableBB > 0 ? `BB: ${formatCompactDollars(d.tableBB)}` : ''
            ].filter(Boolean).join(' · ');

            return `<div class="tps-debug-departure-row" data-debug-departure-key="${escHtml(d.key)}">
                <div class="tps-debug-departure-text">
                    <div><b>${escHtml(d.name)}</b> <span class="tps-dim">[${escHtml(d.id)}]</span></div>
                    <div>${escHtml(stack)} · ${escHtml(status)} · ${escHtml(when)}</div>
                    ${tableBits ? `<div class="tps-dim">${escHtml(tableBits)}</div>` : ''}
                </div>
                <button type="button" class="tps-debug-departure-dismiss"
                    data-debug-departure-key="${escHtml(d.key)}" aria-label="Dismiss">&times;</button>
            </div>`;
        }).join('');

        list.querySelectorAll('.tps-debug-departure-dismiss').forEach(btn => {
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                removeDebugDeparture(btn.dataset.debugDepartureKey || '');
            });
        });
    }

    function recordDebugDeparture(player, productionEligible, popupTriggered) {
        if (debug !== 1 || !player?.id) return;

        const at = Date.now();
        const key = `${String(player.id)}:${at}:${Math.random().toString(36).slice(2, 7)}`;
        const tableContext = currentDepartureTableContext();

        _debugDepartures.unshift({
            key,
            id: String(player.id),
            name: String(player.name || `Player ${player.id}`),
            stackBB: Number.isFinite(player.stackBB) ? player.stackBB : null,
            stackCash: Number.isFinite(player.stackCash) ? player.stackCash : null,
            lastPositiveStackBB: Number.isFinite(player.lastPositiveStackBB)
                ? player.lastPositiveStackBB : null,
            lastPositiveStackCash: Number.isFinite(player.lastPositiveStackCash)
                ? player.lastPositiveStackCash : null,
            stackState: player.stackState || 'unknown',
            tableKey: String(tableContext?.key || player.tableKey || ''),
            tableName: String(tableContext?.name || ''),
            tableBB: Number.isFinite(tableContext?.bb) ? tableContext.bb : null,
            busted: !!player.bustPending,
            productionEligible: !!productionEligible,
            popupTriggered: !!popupTriggered,
            at
        });

        // Safety bound only; normal entries disappear on the same timeout as
        // the production departure popup.
        if (_debugDepartures.length > 8) _debugDepartures.length = 8;

        renderDebugDepartures();
        setTimeout(() => removeDebugDeparture(key), DEPARTED_ALERT_MS);
    }

    function reconcileDepartedDeepStackPlayers() {
        let current = snapshotSeatedVillains();
        const tableContext = currentDepartureTableContext();
        const currentTableKey = String(tableContext?.key || '');

        // An exact rendered-table change is authoritative. Silently establish a
        // new baseline so old-table opponents and dollar conversions can never
        // leak into departure alerts on the new table.
        if (_departureTableKey && currentTableKey && _departureTableKey !== currentTableKey) {
            _departedSeatSnapshot = current;
            _departureStackStates.clear();
            _departureTableKey = currentTableKey;
            _departureTableResetPending = false;
            _departureHeroSeatRemovedAt = 0;
            if (debug === 1) console.debug('[TPS] departure baseline reset: rendered table changed');
            return;
        }
        if (currentTableKey) _departureTableKey = currentTableKey;

        // Departure alerts are only meaningful while the local player is
        // actively dealt into the hand. Observer table switches and movements
        // between tables therefore just refresh the baseline silently.
        if (!heroHasPrivateHoleCards()) {
            _departedSeatSnapshot = current;
            _departureTableResetPending = false;
            _departureHeroSeatRemovedAt = 0;

            const keep = new Set(current.keys());
            for (const id of [..._departureStackStates.keys()]) {
                if (!keep.has(id)) _departureStackStates.delete(id);
            }

            if (debug === 1) {
                console.debug('[TPS] departure alerts paused: hero has no private cards');
            }
            return;
        }

        // Do not treat initial page load as departures.
        if (!_departedSeatSnapshot.size) {
            _departedSeatSnapshot = current;
            _departureTableResetPending = false;
            if (debug === 1) renderDebugDepartures();
            return;
        }

        const now = Date.now();
        const previousIds = new Set(_departedSeatSnapshot.keys());
        const currentIds = new Set(current.keys());
        const missingIds = [...previousIds].filter(id => !currentIds.has(id));
        const newIds = [...currentIds].filter(id => !previousIds.has(id));
        const overlapCount = [...previousIds].filter(id => currentIds.has(id)).length;

        // A player genuinely observed as a new arrival has re-entered the
        // table; any prior departure suppression for this table is stale.
        for (const id of newIds) {
            _departedAlerted.delete(departureAlertKey(currentTableKey || _departureTableKey, id));
        }

        const heroRecentlyRemoved =
            _departureTableResetPending &&
            _departureHeroSeatRemovedAt > 0 &&
            now - _departureHeroSeatRemovedAt <= 5000;

        const substantialTurnover =
            missingIds.length >= 2 ||
            (overlapCount === 0 && newIds.length > 0);

        if (heroRecentlyRemoved && substantialTurnover) {
            // The local player moved away from the old table. None of the old
            // opponents should be classified as "departing targets"; Sidearm is
            // the entity that left that table. Establish the new table as the
            // fresh departure baseline.
            _departedSeatSnapshot = current;

            const keep = new Set(current.keys());
            for (const id of [..._departureStackStates.keys()]) {
                if (!keep.has(id)) _departureStackStates.delete(id);
            }

            _departureTableResetPending = false;
            _departureHeroSeatRemovedAt = 0;

            if (debug === 1) {
                console.debug('[TPS] departure baseline reset after hero table move', {
                    oldVillains: previousIds.size,
                    newVillains: currentIds.size,
                    missing: missingIds.length,
                    arrivals: newIds.length,
                    overlap: overlapCount
                });
            }
            return;
        }

        // A brief self-seat re-render that did not correspond to a table move
        // must not suppress future genuine departures forever.
        if (_departureTableResetPending && now - _departureHeroSeatRemovedAt > 5000) {
            _departureTableResetPending = false;
            _departureHeroSeatRemovedAt = 0;
        }

        for (const [id, previousSnapshot] of _departedSeatSnapshot) {
            if (current.has(id)) continue;

            // The dedicated stack watcher may have seen ALL IN / 0 after the
            // last normal snapshot. Prefer it over the stale previous stack.
            const tracked = _departureStackStates.get(id);
            const busted = tracked?.state === 'allin' || tracked?.state === 'zero';

            const lastPositive = Number.isFinite(tracked?.lastPositiveStackBB)
                ? tracked.lastPositiveStackBB
                : (Number.isFinite(previousSnapshot.lastPositiveStackBB)
                    ? previousSnapshot.lastPositiveStackBB
                    : (Number.isFinite(previousSnapshot.stackBB)
                        ? previousSnapshot.stackBB
                        : null));

            const latestPositive = tracked?.state === 'positive' && Number.isFinite(tracked.stackBB)
                ? tracked.stackBB
                : lastPositive;

            const lastPositiveCash = Number.isFinite(tracked?.lastPositiveStackCash)
                ? tracked.lastPositiveStackCash
                : (Number.isFinite(previousSnapshot.lastPositiveStackCash)
                    ? previousSnapshot.lastPositiveStackCash
                    : (Number.isFinite(previousSnapshot.stackCash)
                        ? previousSnapshot.stackCash
                        : null));

            const latestPositiveCash = tracked?.state === 'positive' && Number.isFinite(tracked.stackCash)
                ? tracked.stackCash
                : lastPositiveCash;

            const departing = {
                ...previousSnapshot,
                name: tracked?.name || previousSnapshot.name,
                stackBB: busted ? 0 : latestPositive,
                stackCash: busted ? 0 : latestPositiveCash,
                lastPositiveStackBB: lastPositive,
                lastPositiveStackCash: lastPositiveCash,
                stackState: tracked?.state || previousSnapshot.stackState || 'unknown',
                stackRaw: tracked?.raw || previousSnapshot.stackRaw || '',
                terminalSeenAt: tracked?.terminalSeenAt || previousSnapshot.terminalSeenAt || 0,
                bustPending: busted
            };

            // A confirmed ALL IN / 0 departure is treated as a bust, not a
            // deep-stack target, regardless of the previous positive stack.
            const eligible = !busted &&
                Number.isFinite(departing.stackBB) &&
                departing.stackBB >= DEPARTED_DEEP_STACK_BB;

            let popupTriggered = false;
            if (eligible) {
                const alertKey = departureAlertKey(
                    departing.tableKey || currentTableKey || _departureTableKey,
                    id
                );
                const last = _departedAlerted.get(alertKey) || 0;
                if (now - last >= DEPARTED_ALERT_MS) {
                    _departedAlerted.set(alertKey, now);
                    popupTriggered = !!showDepartedTargetAlert(departing);
                }
            }

            // Debug sees every confirmed departure, including bust suppression.
            recordDebugDeparture(departing, eligible, popupTriggered);

            // Departure classification is complete; avoid stale terminal state if
            // the same player later rejoins the table.
            _departureStackStates.delete(id);
        }

        _departedSeatSnapshot = current;

        // Bound stale suppression state.
        for (const [key, at] of _departedAlerted) {
            if (now - at > 60000) _departedAlerted.delete(key);
        }
    }

    function cancelDepartedHostHide() {
        if (_departedHostHideTimer) {
            clearTimeout(_departedHostHideTimer);
            _departedHostHideTimer = null;
        }
    }

    function scheduleDepartedHostHideIfEmpty() {
        cancelDepartedHostHide();

        const host = document.getElementById('tps-departed-alerts');
        const list = host?.querySelector('#tps-departed-alert-list');
        if (!host || (list && list.children.length)) return;

        _departedHostHideTimer = setTimeout(() => {
            _departedHostHideTimer = null;
            const currentHost = document.getElementById('tps-departed-alerts');
            const currentList = currentHost?.querySelector('#tps-departed-alert-list');

            // The title/header disappears only after the list has remained empty
            // for the full three-second grace period.
            if (currentHost && (!currentList || currentList.children.length === 0)) {
                currentHost.remove();
            }
        }, 3000);
    }

    function playDepartedTargetChime() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;

            if (!_departedAudioContext) _departedAudioContext = new AudioCtx();
            const ctx = _departedAudioContext;

            // Browsers can suspend audio until the page has received a user
            // gesture. Resume opportunistically; failure is harmless.
            if (ctx.state === 'suspended') {
                try { ctx.resume(); } catch (_) {}
            }

            const now = ctx.currentTime;
            const master = ctx.createGain();
            master.gain.setValueAtTime(0.0001, now);
            master.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
            master.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
            master.connect(ctx.destination);

            const notes = [
                { f: 740, at: 0.00, len: 0.16 },
                { f: 988, at: 0.12, len: 0.20 }
            ];

            for (const note of notes) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(note.f, now + note.at);

                gain.gain.setValueAtTime(0.0001, now + note.at);
                gain.gain.exponentialRampToValueAtTime(0.7, now + note.at + 0.01);
                gain.gain.exponentialRampToValueAtTime(
                    0.0001,
                    now + note.at + note.len
                );

                osc.connect(gain);
                gain.connect(master);
                osc.start(now + note.at);
                osc.stop(now + note.at + note.len + 0.02);
            }
        } catch (e) {
            if (debug === 1) console.debug('[TPS] departure chime unavailable', e);
        }
    }

    function ensureDepartedAlertHost() {
        cancelDepartedHostHide();
        let host = document.getElementById('tps-departed-alerts');

        if (!host) {
            host = document.createElement('div');
            host.id = 'tps-departed-alerts';
            host.innerHTML = `
                <div class="tps-departed-head">
                    <div class="tps-departed-title">Sidearm - Masadan kalkanlar</div>
                    <div class="tps-departed-columns">
                        <span>Oyuncu</span>
                        <span>Son stack</span>
                        <span>FF</span>
                        <span></span>
                    </div>
                </div>
                <div id="tps-departed-alert-list"></div>`;
        }

        // Keep the production alert layer outside Torn's poker/content stacking
        // contexts. Inline critical styles also protect it if Torn's CSS changes.
        if (host.parentElement !== document.documentElement) {
            try {
                document.documentElement.appendChild(host);
            } catch (_) {
                document.body.appendChild(host);
            }
        }

        Object.assign(host.style, {
            position: 'fixed',
            zIndex: '2147483647',
            top: '72px',
            right: '12px',
            left: 'auto',
            bottom: 'auto',
            maxWidth: 'min(92vw, 440px)',
            pointerEvents: 'none',
            isolation: 'isolate'
        });

        return host;
    }

    function removeDepartedTargetAlert(id, instance = '') {
        const playerSelector = `.tps-departed-alert[data-player-id="${CSS.escape(String(id))}"]`;
        const selector = instance
            ? `${playerSelector}[data-alert-instance="${CSS.escape(String(instance))}"]`
            : playerSelector;
        const el = document.querySelector(selector);
        if (el) el.remove();

        scheduleDepartedHostHideIfEmpty();
    }

    function renderDepartedFf(id) {
        const el = document.querySelector(`.tps-departed-alert[data-player-id="${CSS.escape(String(id))}"] .tps-departed-ff`);
        if (!el) return;
        const c = _ffScoreCache[String(id)];
        const ff = c && c.fair_fight != null ? Number(c.fair_fight) : null;
        el.textContent = Number.isFinite(ff) ? `FF ${ff.toFixed(2)}` : 'FF -';
    }

    async function fillDepartedFfScore(id) {
        renderDepartedFf(id);
        const c = _ffScoreCache[String(id)];
        if (c && c.fair_fight != null) return;
        if (!(settings.ffKey || '').trim()) return;
        try {
            await fetchFfStatsMulti([String(id)]);
            renderDepartedFf(id);
        } catch (e) {
            console.warn('[TPS] departed FF score', e);
        }
    }

    function showDepartedTargetAlert(player) {
        if (!player || !player.id || !player.name) return false;

        const host = ensureDepartedAlertHost();
        removeDepartedTargetAlert(player.id);

        const alertInstance = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const row = document.createElement('div');
        row.className = 'tps-departed-alert';
        row.dataset.playerId = String(player.id);
        row.dataset.alertInstance = alertInstance;
        row.style.pointerEvents = 'auto';
        row.style.position = 'relative';
        row.style.zIndex = '1';

        row.innerHTML = `
            <button type="button" class="tps-departed-attack" title="Torn saldırı sayfasını aç">
                <span class="tps-departed-name">${escHtml(player.name)}</span>
                <span class="tps-departed-stack">${escHtml(formatDepartureStack(player.stackBB, player.stackCash))}</span>
                <span class="tps-departed-ff">FF -</span>
            </button>
            <button type="button" class="tps-departed-dismiss" aria-label="Kapat">&times;</button>
        `;

        row.querySelector('.tps-departed-attack').addEventListener('click', () => {
            window.open(
                'https://www.torn.com/page.php?sid=attack&user2ID=' + encodeURIComponent(player.id),
                '_blank',
                'noopener,noreferrer'
            );
        });

        row.querySelector('.tps-departed-dismiss').addEventListener('click', () => {
            removeDepartedTargetAlert(player.id, alertInstance);
        });

        const list = host.querySelector('#tps-departed-alert-list') || host;
        list.appendChild(row);

        // If Torn reparented/rebuilt the page during the same tick, restore the
        // alert once at the document root before deciding whether it was sent.
        if (!row.isConnected || !host.isConnected) {
            const retryHost = ensureDepartedAlertHost();
            const retryList = retryHost.querySelector('#tps-departed-alert-list') || retryHost;
            retryList.appendChild(row);
        }

        const mounted = !!(row.isConnected && host.isConnected);
        if (mounted) {
            cancelDepartedHostHide();
            playDepartedTargetChime();
            fillDepartedFfScore(player.id);
            setTimeout(() => removeDepartedTargetAlert(player.id, alertInstance), DEPARTED_ALERT_MS);
        }

        if (debug === 1) {
            console.debug('[TPS] departure popup', {
                mounted,
                playerId: String(player.id),
                name: player.name,
                stackBB: player.stackBB,
                hostParent: host.parentElement?.tagName || '',
                zIndex: host.style.zIndex,
                top: host.style.top
            });
        }

        return mounted;
    }

    // ── Styles / bubble / panel ──────────────────────────────────

    function injectStyles() {
        if (document.getElementById('tps-styles')) return;
        const s = document.createElement('style');
        s.id = 'tps-styles';
        s.textContent = `
            #tps-bubble {
                touch-action: none; -webkit-user-select: none; user-select: none;
                -webkit-appearance: none !important; appearance: none !important;
                position: fixed; z-index: 99990;
                width: 64px; height: 64px; box-sizing: border-box;
                border-radius: 7px !important;
                background: #14101a !important;
                background-image: none !important;
                border: 2px solid #888 !important;
                clip-path: none !important; -webkit-clip-path: none !important;
                mask: none !important; -webkit-mask: none !important;
                color: #ccc; font: 700 11px/1.15 system-ui,sans-serif;
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                cursor: grab; user-select: none; text-align: center;
                box-shadow: 0 4px 16px rgba(0,0,0,0.5) !important; padding: 4px;
                overflow: hidden;
            }
            #tps-bubble::before, #tps-bubble::after {
                content: none !important; display: none !important;
            }
            #tps-bubble .tps-bubble-label {
                pointer-events: none; display: block; max-width: 100%;
                font-size: 1em; line-height: 1.05; font-weight: 800; white-space: nowrap;
            }

            /* Owner easter egg: a static rainbow across the visible seat name. */
            .tps-owner-rainbow {
                background: linear-gradient(90deg,
                    #ff4d4d 0%, #ff9f43 16%, #feca57 32%, #2ed573 48%,
                    #1e90ff 64%, #9b59b6 80%, #ff6bcb 100%) !important;
                -webkit-background-clip: text !important;
                background-clip: text !important;
                color: transparent !important;
                -webkit-text-fill-color: transparent !important;
                background-repeat: no-repeat !important;
                background-size: 100% 100% !important;
                text-shadow: none !important;
                font-weight: 800 !important;
            }


            /* Development identity colours. Owner rainbow has priority in JS. */
            .tps-development-helper-gold,
            .tps-development-helper-gold * {
                color: #ffd700 !important;
                -webkit-text-fill-color: #ffd700 !important;
                text-shadow: 0 0 4px rgba(255,215,0,.22) !important;
                font-weight: 800 !important;
            }
            .tps-hero-blue,
            .tps-hero-blue * {
                color: #4da3ff !important;
                -webkit-text-fill-color: #4da3ff !important;
                text-shadow: 0 0 4px rgba(77,163,255,.18) !important;
                font-weight: 800 !important;
            }

            #tps-poker-term-toast {
                position: fixed; z-index: 2147483647; right: 12px; top: 72px;
                width: min(86vw, 350px); box-sizing: border-box;
                padding: 11px 38px 11px 12px; border-radius: 9px;
                background: rgba(20,16,26,.98); color: #eee;
                border: 1px solid rgba(155,89,182,.88);
                box-shadow: 0 5px 20px rgba(0,0,0,.58);
                font: 12px/1.38 system-ui,sans-serif;
                opacity: 0; transform: translateY(-8px);
                pointer-events: auto; transition: opacity .15s ease, transform .15s ease;
            }
            #tps-poker-term-toast.show { opacity: 1; transform: translateY(0); }
            .tps-poker-term-title { color: #c4b5fd; font-size: 14px; font-weight: 800; margin-bottom: 5px; }
            .tps-poker-term-copy { margin-top: 5px; }
            .tps-poker-term-close {
                position: absolute; top: 4px; right: 5px; width: 27px; height: 27px;
                padding: 0; border: 0; border-radius: 6px; cursor: pointer;
                background: rgba(255,255,255,.08); color: #ddd; font: 700 19px/25px system-ui,sans-serif;
            }
            .tps-poker-term-actions { display: flex; gap: 7px; margin-top: 9px; }
            .tps-poker-term-btn {
                padding: 6px 9px; border-radius: 6px; border: 1px solid #4a4060;
                background: #2a2238; color: #ddd2f0; font: 700 11px/1.2 system-ui,sans-serif;
                cursor: pointer;
            }
            .tps-poker-term-btn.pri { background: #4a3d9a; border-color: #7c6cf0; color: #fff; }

            #tps-table-insight-toast {
                position: fixed; z-index: 2147483646; left: 12px; top: 72px;
                width: min(82vw, 340px); box-sizing: border-box;
                padding: 9px 38px 9px 11px; border-radius: 9px;
                background: rgba(20,16,26,.96); color: #eee;
                border: 1px solid rgba(124,108,240,.72);
                box-shadow: 0 5px 18px rgba(0,0,0,.5);
                font: 12px/1.35 system-ui,sans-serif;
                opacity: 0; transform: translateY(-8px);
                pointer-events: none; transition: opacity .15s ease, transform .15s ease;
            }
            #tps-table-insight-toast.show { opacity: 1; transform: translateY(0); }
            .tps-table-insight-close {
                position: absolute; top: 4px; right: 5px;
                width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px;
                background: rgba(255,255,255,.08); color: #ddd;
                font: 700 19px/24px system-ui,sans-serif; line-height: 24px;
                cursor: pointer; pointer-events: auto; touch-action: manipulation;
            }
            .tps-table-insight-close:hover, .tps-table-insight-close:focus {
                background: rgba(255,255,255,.16); color: #fff; outline: none;
            }
            .tps-table-insight-title {
                color: #c4b5fd; font-weight: 800; font-size: 11px;
                text-transform: uppercase; letter-spacing: .35px; margin-bottom: 3px;
            }
            .tps-image-grid {
                display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 7px;
            }
            .tps-image-insight {
                margin-top: 6px; padding: 6px 7px; border-radius: 6px;
                background: rgba(124,108,240,.10); border: 1px solid rgba(124,108,240,.20);
                color: #ddd6ea; font-size: 11px;
            }
            .tps-image-compare-head, .tps-image-compare-row {
                display: grid; grid-template-columns: 1.35fr .9fr .9fr; gap: 6px; align-items: center;
            }
            .tps-image-compare-head {
                margin-top: 7px; color: #999; font-size: 9px; font-weight: 700; text-transform: uppercase;
            }
            .tps-image-compare-row {
                padding: 3px 0; border-top: 1px solid rgba(255,255,255,.055); font-size: 10px;
            }
            .tps-image-compare-row > :nth-child(2),
            .tps-image-compare-row > :nth-child(3),
            .tps-image-compare-head > :nth-child(2),
            .tps-image-compare-head > :nth-child(3) { text-align: right; }
            .tps-tilt-warning {
                margin-top: 7px; padding: 7px 8px; border-radius: 7px;
                background: rgba(230,126,34,.13); border: 1px solid rgba(230,126,34,.45);
                color: #f2dfcf; font-size: 11px;
            }
            .tps-tilt-warning b { color: #f0a35c; }
            #tps-table-insight-toast.tilt {
                border-color: rgba(230,126,34,.85); background: rgba(31,20,14,.97);
            }
            #tps-table-insight-toast.tilt .tps-table-insight-title { color: #f0a35c; }

            #tps-debug-departures {
                position: fixed; z-index: 99996; top: 12px; left: 12px;
                width: min(88vw, 330px); max-height: 42vh; overflow: auto;
                padding: 8px 9px; background: rgba(20,16,26,.96);
                color: #ebe4f5; border: 1px solid #f1c40f; border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,.55);
                font: 11px/1.3 system-ui,sans-serif;
                pointer-events: auto;
            }
            .tps-debug-departures-title { color: #f1c40f; font-weight: 800; }
            .tps-debug-departures-meta { color: #aaa; font-size: 9px; margin: 2px 0 5px; }
            .tps-debug-departure-row {
                display: flex; align-items: center; gap: 6px;
                padding: 4px 0; border-top: 1px solid rgba(255,255,255,.08);
            }
            .tps-debug-departure-text { flex: 1; min-width: 0; }
            .tps-debug-departure-dismiss {
                flex: 0 0 auto; width: 24px; height: 24px; padding: 0;
                border: 0; border-radius: 5px; cursor: pointer;
                background: rgba(255,255,255,.08); color: #ddd;
                font: 700 18px/24px system-ui,sans-serif;
            }
            .tps-debug-departure-dismiss:hover {
                background: rgba(255,255,255,.16); color: #fff;
            }
            .tps-debug-departure-empty { color: #888; font-style: italic; }

            #tps-departed-alerts {
                position: fixed;
                z-index: 2147483647;
                top: 72px;
                right: 12px;
                width: min(92vw, 440px);
                max-width: min(92vw, 440px);
                pointer-events: none;
                isolation: isolate;
            }
            .tps-departed-head {
                margin-bottom: 5px;
                padding: 7px 8px 5px;
                background: rgba(20,16,26,.97);
                border: 1px solid rgba(180,150,220,.45);
                border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,.45);
            }
            .tps-departed-title {
                margin-bottom: 4px;
                color: #ddd0f5;
                font: 800 12px/1.2 system-ui,sans-serif;
            }
            .tps-departed-columns {
                display: grid;
                grid-template-columns: minmax(0,1fr) 118px 48px 24px;
                gap: 6px;
                color: #9d93aa;
                font: 700 9px/1.2 system-ui,sans-serif;
                text-transform: uppercase;
                letter-spacing: .35px;
            }
            #tps-departed-alert-list {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .tps-departed-alert {
                display: flex; align-items: stretch; gap: 4px; pointer-events: auto;
                background: #14101a; border: 1px solid #6c5a89; border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,.5); overflow: hidden;
                font: 700 12px/1.2 system-ui,sans-serif;
            }
            .tps-departed-attack {
                display: flex; align-items: center; gap: 8px; min-width: 0;
                padding: 8px 10px; border: 0; background: transparent; color: #fff;
                cursor: pointer; flex: 1; text-align: left;
            }
            .tps-departed-attack:hover { background: rgba(231,76,60,.18); }
            .tps-departed-name {
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .tps-departed-stack { color: #ccc; white-space: nowrap; }
            .tps-departed-alert {
                display: grid;
                grid-template-columns: minmax(0,1fr) 24px;
                gap: 6px;
                align-items: stretch;
            }
            .tps-departed-attack {
                display: grid !important;
                grid-template-columns: minmax(0,1fr) 118px 48px;
                gap: 6px;
                align-items: center;
                text-align: left;
            }
            .tps-departed-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .tps-departed-ff {
                white-space: nowrap;
                text-align: left;
            }
            .tps-departed-ff { color: #f0c674; white-space: nowrap; }
            .tps-departed-dismiss {
                border: 0; border-left: 1px solid rgba(255,255,255,.10);
                background: transparent; color: #aaa; width: 34px; cursor: pointer;
                font-size: 20px; line-height: 1;
            }
            .tps-departed-dismiss:hover { color: #fff; background: rgba(255,255,255,.08); }
            
            .tps-hist-row {
                display: grid; grid-template-columns: 56px 1fr 48px auto; gap: 6px;
                align-items: center; padding: 5px 0;
                border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12px;
            }
            .tps-hist-ff {
                background: #2a2038; border: 1px solid #5a4a78; color: #f0c674;
                border-radius: 6px; font-size: 11px; font-weight: 700; padding: 2px 4px;
                cursor: pointer; text-align: center;
            }
            .tps-hist-ff:hover { border-color: #e74c3c; color: #fff; }
            .tps-hist-ff.muted { cursor: default; opacity: 0.5; border-color: transparent; background: transparent; color: #7a7088; }
            .tps-hist-time { color: #7a7088; font-size: 11px; }
            .tps-hist-name { color: #a29bfe; text-decoration: none; font-weight: 600; }
            .tps-hist-name:hover { text-decoration: underline; }
            .tps-hist-nolink { color: #c8c0d8; cursor: default; }
            .tps-hist-amt { color: #2ecc71; font-weight: 700; text-align: right; }
            .tps-copy-ok { color: #2ecc71 !important; }
            .tps-opener-note { font-size: 11px; color: #7a7088; margin: 4px 0 6px; }
            #tps-bubble .tps-bubble-badge {
                font-size: 9px; line-height: 1.08; font-weight: 700; color: #ddd; margin-top: 3px;
                text-shadow: 0 1px 2px #000; max-width: 100%; white-space: pre-line;
                overflow: visible; text-overflow: clip; text-align: center;
            }
            #tps-bubble.tps-raise { border-color: #2ecc71; }
            #tps-bubble.tps-call { border-color: #f1c40f; }
            #tps-bubble.tps-fold { border-color: #e74c3c; }
            #tps-bubble.tps-3bet { border-color: #9b59b6; }
            #tps-bubble.tps-4bet { border-color: #8e44ad; }
            #tps-bubble.tps-check { border-color: #3498db; }
            #tps-bubble.tps-post { /* live colour is set by refreshBubble() */ }
            .tps-panel {
                position: fixed; z-index: 99995;
                width: min(440px, calc(100vw - 12px));
                max-height: min(92vh, 820px); overflow: auto;
                background: #14101a; color: #ebe4f5;
                border: 1px solid #3d3450; border-radius: 12px;
                box-shadow: 0 14px 44px rgba(0,0,0,0.55);
                font: 13px/1.4 system-ui,sans-serif;
            }
            .tps-head {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 12px; background: #1e1730; border-bottom: 1px solid #3d3450;
                cursor: grab; position: sticky; top: 0; z-index: 2;
            }
            .tps-title { font-weight: 700; color: #c4b5fd; }
            .tps-x { background: none; border: 0; color: #aaa; font-size: 20px; cursor: pointer; }
            .tps-body { padding: 12px; }
            .tps-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
            .tps-tab {
                flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #3d3450;
                background: #1a1424; color: #bbb; font-weight: 600; cursor: pointer; font-size: 12px;
            }
            .tps-tab.active { background: #3d3480; color: #fff; border-color: #7c6cf0; }
            .tps-row { margin-bottom: 10px; }
            .tps-lab { font-size: 11px; color: #9b90b0; font-weight: 600; margin-bottom: 4px; }
            .tps-in, .tps-sel {
                width: 100%; box-sizing: border-box;
                background: #1a1424; color: #ebe4f5;
                border: 1px solid #3d3450; border-radius: 6px;
                padding: 8px 10px; font-size: 13px;
            }
            .tps-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
            .tps-btn {
                background: #2a2238; color: #ddd2f0; border: 1px solid #4a4060;
                border-radius: 6px; padding: 7px 11px; font-size: 12px; font-weight: 600; cursor: pointer;
            }
            .tps-btn:hover { background: #352c48; }
            .tps-btn.pri { background: #4a3d9a; border-color: #7c6cf0; color: #fff; }
            .tps-btn.danger { background: #4a2030; border-color: #c0392b; color: #f5c6cb; }
            .tps-btn.active { box-shadow: 0 0 0 1px #7c6cf0; }
            .tps-card {
                background: #1a1424; border: 1px solid #3d3450; border-radius: 8px;
                padding: 10px; margin-top: 8px;
            }
            .tps-card h3 { margin: 0 0 8px; font-size: 14px; color: #c4b5fd; }
            .tps-stat { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0;
                border-bottom: 1px solid rgba(255,255,255,0.04); }
            .tps-k { color: #9b90b0; }
            .tps-v { font-weight: 600; text-align: right; }
            .tps-dim { color: #7a7088; font-size: 12px; }
            .tps-status { margin-top: 8px; font-size: 12px; color: #b8a9d4; min-height: 1.2em; white-space: pre-wrap; }
            .tps-note { font-size: 11px; color: #7a7088; line-height: 1.45; margin-top: 10px; }
            .tps-verdict {
                border: 1px solid #444; border-radius: 8px; padding: 10px;
                display: flex; gap: 10px; align-items: flex-start; margin-bottom: 10px;
            }
            .tps-verdict-action { font-size: 18px; font-weight: 800; }
            .tps-why-toggle {
                margin-top: 7px; padding: 4px 9px; border-radius: 6px;
                border: 1px solid #514866; background: #201a2c; color: #cfc4e0;
                font: 700 11px/1.2 system-ui,sans-serif; cursor: pointer;
            }
            .tps-why-toggle:hover { background: #2a2238; color: #fff; }
            .tps-why-body {
                display: none; margin-top: 7px; padding: 8px; border-radius: 7px;
                border: 1px solid rgba(255,255,255,.10); background: rgba(255,255,255,.035);
                font-size: 11px; line-height: 1.4; color: #d7d0df;
            }
            .tps-why-body.show { display: block; }
            .tps-why-grid > div + div { margin-top: 4px; }
            .tps-hand-tag {
                display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 999px;
                font-size: 11px; font-weight: 700; background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.12); color: #cfc4e0;
            }
            .tps-card-inline { display: inline-block; margin-right: 4px; }
            .tps-card { display: inline-block; padding: 2px 6px; border-radius: 4px;
                background: #0e0a14; margin-right: 4px; font-weight: 700; }
            .tps-card.red { color: #e74c3c; }
            .tps-sec { margin-top: 10px; }
            .tps-sec-title { font-weight: 700; margin-bottom: 4px; }
            .tps-sec-count { font-weight: 500; opacity: 0.7; font-size: 12px; }
            .tps-chip {
                display: inline-block; padding: 2px 6px; margin: 2px;
                border-radius: 4px; font-size: 11px; border: 1px solid #444; background: #1a1424;
            }
            .tps-chip-4bet { border-color: rgba(142,68,173,0.55); color: #d7b4ef; }
            .tps-chip-3bet { border-color: rgba(155,89,182,0.5); color: #d2a8ef; }
            .tps-chip-check { border-color: rgba(52,152,219,0.45); color: #a9d6f5; }
            .tps-chip-raise { border-color: rgba(46,204,113,0.45); color: #a8efc4; }
            .tps-chip-call { border-color: rgba(241,196,15,0.45); color: #f0e0a0; }
            .tps-chip-fold { border-color: rgba(231,76,60,0.35); color: #c9a; opacity: 0.75; }
            .tps-chip-hero { outline: 2px solid #fff; }
            .tps-pay {
                background: #221830; border: 1px dashed #6c5ce7; border-radius: 8px;
                padding: 10px; margin-top: 8px; font-size: 12px;
            }
            .tps-pay code {
                display: inline-block; background: #0e0a14; padding: 2px 6px;
                border-radius: 4px; color: #a29bfe; user-select: all;
            }
            .tps-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: #cfc4e0; }
        `;
        document.head.appendChild(s);
    }

    // TR 1.0.1: 8.8.1\u2019den alındı. Kayıtlı konum ekran dışındaysa buton görünmüyordu.
    function viewportSafePosition(el, pos, margin = 6) {
        if (!el || !pos) return null;
        const vw = Math.max(1, Number(window.innerWidth || document.documentElement?.clientWidth || 1));
        const vh = Math.max(1, Number(window.innerHeight || document.documentElement?.clientHeight || 1));
        let width = Number(el.offsetWidth || 0);
        let height = Number(el.offsetHeight || 0);
        if (!(width > 0)) width = el.id === 'tps-bubble' ? bubbleSizePx() : Math.min(420, Math.max(80, vw - margin * 2));
        if (!(height > 0)) height = el.id === 'tps-bubble' ? bubbleSizePx() : 80;
        const maxX = Math.max(margin, vw - width - margin);
        const maxY = Math.max(margin, vh - height - margin);
        const rawX = Number(pos.x);
        const rawY = Number(pos.y);
        return {
            x: Math.round(clamp(Number.isFinite(rawX) ? rawX : margin, margin, maxX)),
            y: Math.round(clamp(Number.isFinite(rawY) ? rawY : margin, margin, maxY))
        };
    }

    function applyPos(el, pos) {
        if (!pos) return;
        const safe = viewportSafePosition(el, pos) || pos;
        el.style.left = safe.x + 'px';
        el.style.top = safe.y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    }

    function keepBubbleOnScreen({ persist = true } = {}) {
        const btn = document.getElementById('tps-bubble');
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        const fallback = settings.bubblePosition || { x: r.left, y: r.top };
        const safe = viewportSafePosition(btn, fallback, 6);
        if (!safe) return false;
        const moved = Math.abs(Number(r.left || 0) - safe.x) > 1 || Math.abs(Number(r.top || 0) - safe.y) > 1 ||
            r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight;
        if (moved || settings.bubblePosition) {
            btn.style.left = safe.x + 'px';
            btn.style.top = safe.y + 'px';
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
        }
        if (persist && settings.bubblePosition && (settings.bubblePosition.x !== safe.x || settings.bubblePosition.y !== safe.y)) {
            settings.bubblePosition = { x: safe.x, y: safe.y };
            saveSettings(settings);
        }
        return moved;
    }

    // TR 1.0.1: Torn sayfayı yeniden çizip butonu silerse geri ekle.
    function ensureBubbleVisible() {
        try { ensureBubble(); keepBubbleOnScreen({ persist: true }); } catch (_) {}
    }

    function bubbleSizePx() {
        const s = settings.bubbleSize || 'M';
        if (s === 'S') return 48;
        if (s === 'L') return 72;
        if (s === 'XL') return 88;
        return 64; // M
    }

    function applyBubbleSize(btn) {
        if (!btn) return;
        const px = bubbleSizePx();
        btn.style.width = px + 'px';
        btn.style.height = px + 'px';
        const fs = px <= 48 ? 9 : px <= 64 ? 11 : px <= 72 ? 12 : 13;
        btn.style.fontSize = fs + 'px';

        // Torn's mobile button skin can otherwise leak through and turn Sidearm
        // into a filled/clipped action shape. Keep the original dark box with
        // only the recommendation colour on the outline/text.
        btn.style.setProperty('appearance', 'none', 'important');
        btn.style.setProperty('-webkit-appearance', 'none', 'important');
        btn.style.setProperty('background', '#14101a', 'important');
        btn.style.setProperty('background-image', 'none', 'important');
        btn.style.setProperty('border-radius', '7px', 'important');
        btn.style.setProperty('border-style', 'solid', 'important');
        btn.style.setProperty('border-width', '2px', 'important');
        btn.style.setProperty('clip-path', 'none', 'important');
        btn.style.setProperty('-webkit-clip-path', 'none', 'important');
    }

    // Fit only the primary action row. The hand/context badge keeps its normal
    // size; long labels such as RE-RAISE shrink just enough to avoid clipping.
    function fitBubbleActionLabel(btn) {
        const el = btn?.querySelector?.('.tps-bubble-label');
        if (!el) return;
        el.style.fontSize = '1em';
        const available = Math.max(1, Number(btn.clientWidth || bubbleSizePx()) - 8);
        const needed = Number(el.scrollWidth || 0);
        if (!(needed > available)) return;
        const scale = Math.max(0.50, Math.min(1, available / needed));
        el.style.fontSize = `${Math.round(scale * 100) / 100}em`;
    }

    function ensureBubble() {
        if (document.getElementById('tps-bubble')) return;
        injectStyles();
        const btn = document.createElement('button');
        btn.id = 'tps-bubble';
        btn.type = 'button';
        btn.innerHTML = '<span class="tps-bubble-label">Sidearm</span>';
        btn.title = 'Poker Sidearm';
        applyBubbleSize(btn);

        if (settings.bubblePosition) applyPos(btn, settings.bubblePosition);
        else {
            btn.style.right = '16px';
            btn.style.bottom = '130px';
            btn.style.left = 'auto';
        }

        // Click-drag (mouse + touch). touch-action:none avoids scroll-steal on mobile.
        btn.style.touchAction = 'none';
        let drag = false, wasDrag = false, activePointer = null;
        btn.addEventListener('pointerdown', e => {
            if (e.button !== undefined && e.button !== 0) return;
            drag = false;
            wasDrag = false;
            activePointer = e.pointerId;
            try { btn.setPointerCapture(e.pointerId); } catch (_) {}
            const r = btn.getBoundingClientRect();
            const sx = e.clientX, sy = e.clientY, sl = r.left, st = r.top;
            const onMove = ev => {
                if (activePointer != null && ev.pointerId !== activePointer) return;
                if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) {
                    drag = true;
                    wasDrag = true;
                }
                if (!drag) return;
                ev.preventDefault();
                btn.style.left = clamp(sl + (ev.clientX - sx), 6, window.innerWidth - 70) + 'px';
                btn.style.top = clamp(st + (ev.clientY - sy), 6, window.innerHeight - 70) + 'px';
                btn.style.right = 'auto';
                btn.style.bottom = 'auto';
            };
            const onUp = ev => {
                if (activePointer != null && ev.pointerId !== activePointer) return;
                try { btn.releasePointerCapture(activePointer); } catch (_) {}
                activePointer = null;
                btn.removeEventListener('pointermove', onMove);
                btn.removeEventListener('pointerup', onUp);
                btn.removeEventListener('pointercancel', onUp);
                if (drag) {
                    const nr = btn.getBoundingClientRect();
                    settings.bubblePosition = { x: Math.round(nr.left), y: Math.round(nr.top) };
                    saveSettings(settings);
                }
            };
            btn.addEventListener('pointermove', onMove);
            btn.addEventListener('pointerup', onUp);
            btn.addEventListener('pointercancel', onUp);
        });
        btn.addEventListener('click', e => {
            if (wasDrag) {
                wasDrag = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            showPanel();
        });
        document.body.appendChild(btn);
        try { refreshBubble(); } catch (e) { console.error('[TPS]', e); }
    }

    function refreshBubble(ctxOverride = null) {
        const btn = document.getElementById('tps-bubble');
        if (!btn) return;
        try {
            btn.classList.remove('tps-raise', 'tps-call', 'tps-fold', 'tps-3bet', 'tps-4bet', 'tps-check', 'tps-post');
            const ctx = ctxOverride || getContext();
            let label = 'Sidearm';
            let color = '#b39ddb';
            let badge = '';
            let title = 'Poker Sidearm';

            applyBubbleSize(btn);

            if (!ctx.preflop || ctx.onBoard) {
                btn.classList.add('tps-post');
                if (ctx.equity && ctx.equity.winPct != null) {
                    const pct = ctx.equity.winPct;
                    const po = ctx.potInfo && ctx.potInfo.potOddsPct;
                    const advice = ctx.postflopAdvice || buildPostflopAdvice(
                        ctx.holeCards, ctx.boardCards, ctx.equity, ctx.potInfo || {}, ctx.villainCount
                    );
                    label = postflopAdviceBubbleLabel(advice);
                    color = postflopAdviceColor(advice);
                    const sizeBadge = postflopAdviceBubbleSizeLabel(advice);
                    const equityBadge = `${pct.toFixed(0)}% · ${compactPostflopHandLabel(ctx.holeCards, ctx.boardCards, ctx.equity.made)}`;
                    badge = [sizeBadge, equityBadge].filter(Boolean).join('\n');
                    title = `${postflopAdvicePanelLabel(advice)} · kazanma şansı %${pct.toFixed(1)} · ${trMadeHand(ctx.equity.made || '')}`
                        + (po != null ? ` · gereken %${po.toFixed(1)}` : '');
                    btn.style.borderColor = color;
                } else if (ctx.boardCards && ctx.boardCards.length >= 3 && ctx.holeCards) {
                    label = '…';
                    color = '#888';
                    badge = 'Hesap';
                    title = 'Flop sonrası - kazanma şansı hesaplanıyor…';
                } else if (ctx.boardCards && ctx.boardCards.length >= 3) {
                    label = '…';
                    color = '#888';
                    badge = 'Masa';
                    title = 'Flop sonrası - elindeki kartlar görünmüyor';
                } else {
                    label = '…';
                    color = '#888';
                    badge = 'Flop';
                    title = 'Flop sonrası - masa kartları bekleniyor';
                }
            } else if (ctx.heroAction) {
                const act = ctx.heroAction;
                const sym = actionSymbol(act);
                const verb = actionBubbleVerb(act); // plain-language quick label for 3-bet / 4-bet
                // Primary bubble label keeps the quick visual action symbol.
                label = `${sym} ${verb}`;
                color = actionColor(act);
                // Secondary badge: two compact lines so even mobile/small
                // bubbles show the whole useful read without ellipsis.
                const bubblePressure = preflopPressureBubbleLabel(ctx.preflopPressure);
                badge = [ctx.handClass, bubblePressure].filter(Boolean).join('\n');
                title = `${ctx.handClass || 'El'} - ${actionVerb(act)}${verb !== actionVerb(act) ? ` (${verb})` : ''} · ${ctx.potLine} · ${ctx.exact || '?'} · ${ctx.handTag || ''}`;
                if (act === '4bet') btn.classList.add('tps-4bet');
                else if (act === '3bet') btn.classList.add('tps-3bet');
                else if (act === 'raise') btn.classList.add('tps-raise');
                else if (act === 'call') btn.classList.add('tps-call');
                else if (act === 'check') btn.classList.add('tps-check');
                else btn.classList.add('tps-fold');
            } else if (ctx.holeCards) {
                label = 'BEKLE';
                color = '#b39ddb';
                badge = ctx.handClass || '';
                title = ctx.preflopAwaitingAction
                    ? 'Big blind - sıranın sana gelmesi bekleniyor'
                    : 'Kartlar görüldü - değerlendirme bekleniyor';
            } else if (ctx.exact) {
                label = ctx.exact;
                badge = 'kart yok';
                title = `Koltuk ${ctx.exact} - elindeki kartlar henüz görünmüyor`;
            }

            // Keep the floating button visually identical to the panel's equity logic.
            const appliedColor = color === '#b39ddb' ? 'rgba(255,255,255,0.2)' : color;
            btn.style.setProperty('color', color, 'important');
            btn.style.setProperty('border-color', appliedColor, 'important');
            {
                const di = ctx.depthInfo || resolveStackDepth();
                const bbLab = di.stackBB != null && isFinite(di.stackBB)
                    ? `${Math.round(di.stackBB)}bb`
                    : '?bb';
                const depthLab = di.mode === 'auto'
                    ? `oto→${TR_DEPTH[di.depth] || di.depth} (${bbLab})`
                    : `${TR_DEPTH[di.depth] || di.depth}`;
                btn.title = title + ` · stack ${depthLab}`;
            }
            btn.innerHTML =
                `<span class="tps-bubble-label" style="color:${color}">${escHtml(label)}</span>`
                + (badge ? `<span class="tps-bubble-badge">${escHtml(badge)}</span>` : '');
            fitBubbleActionLabel(btn);
            if (ctx.preflop && !ctx.onBoard) maybeShowThreeBetHelp(ctx.heroAction);
        } catch (err) {
            console.error('[TPS] refreshBubble', err);
            btn.innerHTML = '<span class="tps-bubble-label">Sidearm</span>';
        }
    }

function buildVerdictHtml(ctx) {
        const exact = ctx.exact || 'BTN';
        const facingRaise = ctx.facingRaise;
        const depthInfo = ctx.depthInfo || resolveStackDepth();
        let verdictHtml = '';
        // Prefer equity whenever computed (do not depend on street flags)
        if (ctx.equity && ctx.equity.winPct != null) {
            const eq = ctx.equity;
            const pi = ctx.potInfo || {};
            const advice = ctx.postflopAdvice || buildPostflopAdvice(
                ctx.holeCards, ctx.boardCards, eq, pi, ctx.villainCount
            );
            const actionLabel = postflopAdvicePanelLabel(advice);
            const col = postflopAdviceColor(advice);
            const cards = (ctx.holeCards || []).map(cardHtml).join('');
            const board = (ctx.boardCards || []).map(cardHtml).join('');
            const pct = eq.winPct;
            const po = pi.potOddsPct;
            const whyControl = buildWhyControl(ctx, 'postflop');

            let oddsLine = '';
            if (po != null) {
                const edge = pct - po;
                const edgeStr = (edge >= 0 ? '+' : '') + edge.toFixed(1) + '%';
                oddsLine = `<div class="tps-dim" style="margin-top:6px">
                    Pot ${pi.pot != null ? escHtml(money(pi.pot)) : '-'}
                    · call ${pi.toCall != null ? escHtml(money(pi.toCall)) : '-'}
                    · gereken %${po.toFixed(1)}
                    · fark ${edgeStr}
                </div>`;
            } else if (pi.actionState === 'check') {
                oddsLine = `<div class="tps-dim" style="margin-top:6px">Bedava seçenek (check)</div>`;
            } else if (pi.actionState === 'folded') {
                oddsLine = `<div class="tps-dim" style="margin-top:6px">Bu el zaten fold edildi</div>`;
            }

            verdictHtml = `
                <div class="tps-verdict" style="border-color:${col}">
                    <div>${cards}</div>
                    <div>
                        <div class="tps-verdict-action" style="color:${col}">${escHtml(actionLabel)}</div>
                        <div class="tps-hand-tag">%${pct.toFixed(1)} kazanma şansı · ${escHtml(compactPostflopHandLabel(ctx.holeCards, ctx.boardCards, eq.made))}</div>
                        ${oddsLine}
                        <div class="tps-dim" style="margin-top:5px">${eq.villainCount > 1 ? `${eq.villainCount} rakip` : '1 rakip'} · masa ${TR_TEXTURE[eq.boardTexture || 'mixed'] || eq.boardTexture}</div>
                        <div class="tps-dim" style="margin-top:3px">Masa: ${board || '-'}</div>
                        ${whyControl}
                    </div>
                </div>`;
        } else if ((ctx.onBoard || !ctx.preflop) && ctx.holeCards && ctx.holeCards.length) {
            const cards = (ctx.holeCards || []).map(cardHtml).join('');
            const board = (ctx.boardCards || []).map(cardHtml).join('');
            const stale = !!ctx.staleHoleCards;
            verdictHtml = `
                <div class="tps-verdict" style="border-color:#888">
                    <div>${cards}</div>
                    <div>
                        <div class="tps-verdict-action" style="color:#888">${stale ? 'BEKLE' : 'Flop sonrası'}</div>
                        <div class="tps-dim" style="margin-top:4px">${stale ? 'Sit-out sonrası Torn\'un kartlarını yenilemesi bekleniyor.' : 'Kazanma şansı hesaplanıyor…'}</div>
                        <div class="tps-dim">Masa: ${board || 'bekleniyor…'}</div>
                    </div>
                </div>`;
        } else if (ctx.handClass && ctx.heroAction) {
            const color = actionColor(ctx.heroAction);
            const sym = actionSymbol(ctx.heroAction);
            const verb = actionPanelVerb(ctx.heroAction);
            const line = ctx.potLine || (facingRaise ? 'vs Raise' : 'Açılmamış');
            const match = ctx.heroAction === 'fold'
                ? 'Bu baskı ve koltuk için oynanacak eller arasında değil.'
                : (ctx.heroAction === 'check'
                    ? `Bedava seçenek - ekstra para gerekmiyor (${line}).`
                    : `${ctx.heroAction === '4bet' ? '4-bet+' : (ctx.heroAction === '3bet' ? '3-bet' : ctx.heroAction)} yapılacak eller arasında (${line}).`);
            const cards = (ctx.holeCards || []).map(cardHtml).join('');
            const whyControl = buildWhyControl(ctx, 'preflop');
            verdictHtml = `
                <div class="tps-verdict" style="border-color:${color}">
                    <div>${cards}</div>
                    <div>
                        <div class="tps-verdict-action" style="color:${color}">${sym} ${verb} · ${escHtml(line)}</div>
                        ${ctx.handTag ? `<div class="tps-hand-tag">${escHtml(ctx.handTag)}</div>` : ''}
                        <div class="tps-dim" style="margin-top:4px">${escHtml(match)}</div>
                        <div class="tps-dim">Koltuk ${escHtml(String(exact))} · güç ${escHtml(TR_STRENGTH[ctx.heroStrength] || ctx.heroStrength || '-')} · stack ${escHtml(depthInfo.mode === 'auto' ? ('oto→' + (TR_DEPTH[depthInfo.depth] || depthInfo.depth)) : (TR_DEPTH[depthInfo.depth] || depthInfo.depth))}${depthInfo.stackBB != null ? ' (' + Math.round(depthInfo.stackBB) + 'bb)' : ''}</div>
                        ${whyControl}
                    </div>
                </div>`;
        } else if (ctx.preflop && ctx.preflopAwaitingAction && ctx.handClass) {
            const cards = (ctx.holeCards || []).map(cardHtml).join('');
            verdictHtml = `
                <div class="tps-verdict" style="border-color:#b39ddb">
                    <div>${cards}</div>
                    <div>
                        <div class="tps-verdict-action" style="color:#b39ddb">BEKLE · BB</div>
                        ${ctx.handTag ? `<div class="tps-hand-tag">${escHtml(ctx.handTag)}</div>` : ''}
                        <div class="tps-dim" style="margin-top:4px">Sıranın big blind\u2019a gelmesi bekleniyor.</div>
                        <div class="tps-dim">Kimse raise yapmazsa, biri limp yaptığında Sidearm bedava check / raise kararını gösterecek.</div>
                    </div>
                </div>`;
        } else if (ctx.preflop) {
            verdictHtml = `<div class="tps-dim">Elindeki kartlar henüz görünmüyor - aşağıdaki tablo ${escHtml(String(exact))} pozisyonu için.</div>`;
        } else {
            verdictHtml = `<div class="tps-dim">Flop sonrası - masa / el kartları bekleniyor.</div>`;
        }
        return verdictHtml;
    }

    function buildV6DebugPanelHtml(ctx = null) {
        if (debug !== 1) return '';

        try {
            const equityDebug = buildEquityTrackingDebugHtml();
            const state = currentV6GameState();
            if (!state) {
                return `${equityDebug}<div class="tps-dim">Debug enabled, but no current Game ID / hand state is available.</div>`;
            }

            const hero = resolveV6HeroIdentity(state);
            const active = activeVillainsFromHandState(state);
            const activeIds = new Set(active.map(p => String(p.id || '')));
            const activeNames = new Set(active.map(p => p.nameKey).filter(Boolean));
            const folded = state.foldedNames || new Set();
            const actors = state.actionActorNames || new Set();
            const villainCount = countLiveVillains(state);
            const contextCount = Number.isFinite(ctx?.villainCount) ? ctx.villainCount : null;

            const bool = v => v ? 'Y' : '-';
            const stateLabel = p => {
                const bits = [];
                const id = String(p.id || '');
                const nameKey = p.nameKey || '';
                const isHero =
                    !!p.isHero ||
                    (!!hero.id && id === String(hero.id)) ||
                    (!!state.heroSeatId && id === String(state.heroSeatId)) ||
                    (!!hero.nameKey && !!nameKey && nameKey === hero.nameKey);

                if (isHero) bits.push('HERO');
                if (p.sittingOutAtStart) bits.push('SITOUT_START');
                if (p.sittingOutNow) bits.push('SITOUT_NOW');
                if (p.waitingBBAtStart) bits.push('WAIT_BB_START');
                if (p.waitingBBNow) bits.push('WAIT_BB_NOW');
                if (nameKey && folded.has(nameKey)) bits.push('FOLDED_LOG');
                if (seatShowsFoldedNow(p, state)) bits.push('FOLDED_DOM');

                const participated = playerParticipatedInCurrentHand(p, state);
                const counted =
                    !isHero &&
                    !((p.sittingOutAtStart || p.waitingBBAtStart) && !participated) &&
                    !(nameKey && folded.has(nameKey)) &&
                    !seatShowsFoldedNow(p, state) &&
                    (activeIds.has(id) || (nameKey && activeNames.has(nameKey)));

                if (counted) bits.push('COUNTED');
                else if (!isHero) bits.push('EXCLUDED');

                return bits.join(' · ') || 'SEATED';
            };

            const playerRows = [...(state.players?.values?.() || [])]
                .map(p => {
                    const profile = p.nameKey ? state.villainProfiles?.get(p.nameKey) : null;
                    const id = String(p.id || '');
                    const name = p.name || '(name unknown)';
                    const actorSeen = !!(p.nameKey && actors.has(p.nameKey));
                    const foldedSeen = !!(p.nameKey && folded.has(p.nameKey));
                    const last = profile
                        ? `${profile.lastStreet || '-'} / ${profile.lastAction || '-'}`
                        : '-';

                    return `<tr>
                        <td style="white-space:nowrap">${escHtml(id)}</td>
                        <td>${escHtml(name)}</td>
                        <td>${bool(p.isHero)}</td>
                        <td>${bool(hero.id && id === String(hero.id))}</td>
                        <td>${bool(hero.nameKey && p.nameKey === hero.nameKey)}</td>
                        <td>${bool(p.sittingOutAtStart)}</td>
                        <td>${bool(p.sittingOutNow)}</td>
                        <td>${bool(p.waitingBBAtStart)}</td>
                        <td>${bool(p.waitingBBNow)}</td>
                        <td>${bool(foldedSeen)}</td>
                        <td>${bool(actorSeen)}</td>
                        <td style="white-space:nowrap">${escHtml(last)}</td>
                        <td>${escHtml(stateLabel(p))}</td>
                    </tr>`;
                }).join('');

            const seatedNameKeys = new Set(
                [...(state.players?.values?.() || [])].map(p => p.nameKey).filter(Boolean)
            );

            const logOnly = [...actors]
                .filter(nameKey => {
                    if (!nameKey) return false;
                    if (seatedNameKeys.has(nameKey)) return false;
                    if (hero.nameKey && nameKey === hero.nameKey) return false;
                    return !/^(?:game|the\s+(?:preflop|flop|turn|river))$/i.test(nameKey);
                })
                .map(nameKey => {
                    const profile = state.villainProfiles?.get(nameKey);
                    const isFolded = folded.has(nameKey);
                    const isCounted = !isFolded && activeNames.has(nameKey);
                    return `<tr>
                        <td>log</td>
                        <td>${escHtml(profile?.name || nameKey)}</td>
                        <td>-</td>
                        <td>-</td>
                        <td>${bool(hero.nameKey && nameKey === hero.nameKey)}</td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                        <td>${bool(isFolded)}</td>
                        <td>Y</td>
                        <td style="white-space:nowrap">${escHtml(profile ? `${profile.lastStreet || '-'} / ${profile.lastAction || '-'}` : '-')}</td>
                        <td>${isCounted ? 'LOG ONLY · COUNTED' : 'LOG ONLY · EXCLUDED'}</td>
                    </tr>`;
                }).join('');

            const playerCount = state.players?.size || 0;
            const activeList = active.map(p => p.name || p.nameKey || p.id).join(', ') || '(none)';
            const foldedList = [...folded].join(', ') || '(none)';
            const actorList = [...actors].join(', ') || '(none)';
            const actorIdList = (state.entries || [])
                .filter(e => e.actor && e.actorId)
                .map(e => `${e.actor}=${e.actorId}`)
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(', ') || '(none)';
            const order = (state.seatOrder || []).join(' → ') || '(none)';

            return `${equityDebug}
                <div class="tps-row" style="font-size:10px;line-height:1.35">
                    <div class="tps-lab">V8 live state</div>
                    <div style="font-family:monospace;white-space:normal;word-break:break-word">
                        <div><b>Game:</b> ${escHtml(state.gameId || '—')}</div>
                        <div><b>Street:</b> ${escHtml(state.street || '—')} · <b>Board:</b> ${escHtml((state.board || []).join(' ') || '—')}</div>
                        <div><b>Hero resolved:</b> ${escHtml(hero.name || '—')} [${escHtml(hero.id || '—')}]</div>
                        <div><b>Hero source:</b> ${escHtml(hero.source || state.heroNameSource || '—')}</div>
                        <div><b>Hero key:</b> ${escHtml(hero.nameKey || '—')} · <b>stored hero seat:</b> ${escHtml(state.heroSeatId || '—')}</div>
                        <div><b>Dealer seat:</b> ${escHtml(state.dealerSeatId || '—')}</div>
                        <div><b>Seat order:</b> ${escHtml(order)}</div>
                        <div><b>Recognised seat records:</b> ${playerCount}</div>
                        <div style="margin-top:5px;font-size:12px"><b>LIVE VILLAIN COUNT: ${villainCount}</b>${contextCount != null ? ` · context=${contextCount}` : ''}</div>
                        <div><b>Counted villains:</b> ${escHtml(activeList)}</div>
                        <div><b>Folded names:</b> ${escHtml(foldedList)}</div>
                        <div><b>Action actors:</b> ${escHtml(actorList)}</div>
                        <div><b>Actor IDs from log:</b> ${escHtml(actorIdList)}</div>
                    </div>
                </div>

                <div style="overflow:auto;max-height:52vh;margin-top:8px">
                    <table style="width:100%;border-collapse:collapse;font-size:9px;line-height:1.25">
                        <thead>
                            <tr style="text-align:left">
                                <th>ID</th>
                                <th>Name</th>
                                <th>HeroFlag</th>
                                <th>HeroID</th>
                                <th>HeroName</th>
                                <th>SitStart</th>
                                <th>SitNow</th>
                                <th>WaitBBStart</th>
                                <th>WaitBBNow</th>
                                <th>Fold</th>
                                <th>Actor</th>
                                <th>Last</th>
                                <th>Derived state</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${playerRows || '<tr><td colspan="13">No seat records</td></tr>'}
                            ${logOnly}
                        </tbody>
                    </table>
                </div>

                ${(() => {
                    const d = ownerDomDiagnosticSnapshot();
                    const count = d.selectorCounts || {};
                    return `<div class="tps-row" style="margin-top:8px;font-size:10px;line-height:1.35">
                        <div class="tps-lab">DOM / owner diagnostics</div>
                        <div style="font-family:monospace;white-space:normal;word-break:break-word">
                            <div><b>Referral owner:</b> ${escHtml(d.owner?.name || 'name unknown')} [${escHtml(d.owner?.id || '—')}]</div>
                            <div><b>#torn-user:</b> ${escHtml(d.pageIdentity?.playername || '—')} [${escHtml(d.pageIdentity?.id || '—')}]</div>
                            <div><b>Self seat:</b> ${escHtml(d.hero?.currentSelfSeatId || '—')} · <b>resolved:</b> ${escHtml(d.hero?.resolvedName || '—')} [${escHtml(d.hero?.resolvedId || '—')}]</div>
                            <div><b>Owner #player-ID:</b> ${d.ownerSeat ? 'found' : 'missing'} · <b>name text matches:</b> ${count.ownerNameCandidates || 0} · <b>rainbow marked:</b> ${count.rainbowMarked || 0}</div>
                            <div><b>Seat nodes:</b> ${count.playerNodes || 0} · <b>positioners:</b> ${count.playerPositioners || 0} · <b>self wrappers:</b> ${count.selfPositioners || 0}</div>
                            <div><b>CSS text clip:</b> ${d.support?.backgroundClipText ? 'Y' : '-'} / webkit ${d.support?.webkitBackgroundClipText ? 'Y' : '-'}</div>
                        </div>
                        <div class="tps-btns" style="margin-top:7px">
                            <button type="button" class="tps-btn" data-tps-debug-action="copy-owner-dom">Copy DOM diagnostic</button>
                            <button type="button" class="tps-btn" data-tps-debug-action="force-rainbow">Force rainbow</button>
                            <button type="button" class="tps-btn" data-tps-debug-action="refresh-debug">Refresh</button>
                        </div>
                        <div class="tps-dim" data-tps-debug-status style="margin-top:5px">Copy output is limited to poker/owner elements; page tokens and websocket data are not included.</div>
                    </div>`;
                })()}

                <div class="tps-dim" style="margin-top:8px;font-size:9px">
                    HeroFlag = stored seat flag · HeroID = current self player ID match · HeroName = resolved name match ·
                    SitStart = excluded because sitting out when hand membership was captured · FOLDED_LOG = fold seen in log ·
                    FOLDED_DOM = current Torn seat is visibly folded · Actor = appeared in a poker action · COUNTED = currently included in the villain count.
                </div>`;
        } catch (e) {
            return `<div class="tps-dim">Debug panel error: ${escHtml(e?.message || String(e))}</div>`;
        }
    }

    function refreshPanel(ctxOverride = null) {
        const panel = document.getElementById('tps-panel');
        if (!panel) return;
        try {
            const ctx = ctxOverride || getContext();
            // Fast path: swap verdict card only
            const slot = panel.querySelector('#tps-verdict');
            if (slot) {
                slot.innerHTML = buildVerdictHtml(ctx);
            } else {
                // Template missing #tps-verdict - full rebuild
                const tab = panel.querySelector('.tps-tab.active')?.getAttribute('data-tab') || 'ranges';
                window.__tpsActiveTab = tab;
                showPanel();
                return;
            }
            const opNote = panel.querySelector('#tps-opener-note');
            if (opNote) {
                if (ctx.preflopAwaitingAction) {
                    opNote.textContent = 'Big blind - sıra bekleniyor. Biri limp ya da raise yapınca Sidearm güncellenecek.';
                } else if (ctx.preflopPressure?.bucket === 'limped') {
                    opNote.textContent = 'Limp yapılmış pot · ' + preflopPressureShortLabel(ctx.preflopPressure);
                } else if (ctx.facingRaise) {
                    const origin = ctx.openerMatched
                        ? ('ilk raise: ' + (ctx.openerName || ctx.openerBucket) + ' (' + ctx.openerBucket + ')')
                        : ('ilk raise (tahmini): ' + (ctx.openerBucket || 'Late'));
                    opNote.textContent = 'Baskı: ' + preflopPressureShortLabel(ctx.preflopPressure) + ' · ' + origin;
                } else {
                    opNote.textContent = 'Henüz kimse oyuna girmedi - pozisyona göre normal açılış tablosu.';
                }
            }
            if (debug === 1) {
                const debugSlot = panel.querySelector('#tps-v6-debug-content');
                if (debugSlot) debugSlot.innerHTML = buildV6DebugPanelHtml(ctx);
            }
        } catch (err) {
            console.error('[TPS] refreshPanel', err);
        }
    }


    function closePanel() {
        document.getElementById('tps-panel')?.remove();
    }

    function buildHeroActionDiagHtml() {
        try {
            // Run once so the display represents the current table state.
            let action = '';
            try { action = buildHeroActionLine(); } catch (_) {}
            const d = window.__tpsHeroActionDiag || {};
            const hero = d.hero || '(not detected)';
            const actors = (d.sampleActors && d.sampleActors.length) ? d.sampleActors.join(', ') : '(none)';
            const result = action || d.actionLine || '—';
            return `<div class="tps-dim" style="margin-top:7px;font-size:10px;line-height:1.35">
                Action debug · Hero: <strong>${escHtml(hero)}</strong>
                · game ${escHtml(d.gameId || '—')}
                · log ${Number(d.logLines || 0)}
                · actions ${Number(d.actionLines || 0)}
                · hero matches ${Number(d.heroMatches || 0)}
                · string <strong>${escHtml(result)}</strong><br>
                Actors: ${escHtml(actors)}
                ${Array.isArray(d.heroLines) && d.heroLines.length
                    ? `<br>Hero lines: ${escHtml(d.heroLines.join(' | '))}`
                    : ''}
            </div>`;
        } catch (_) {
            return '<div class="tps-dim" style="margin-top:7px;font-size:10px">Action debug unavailable</div>';
        }
    }

    function showPanel() {
        closePanel();
        injectStyles();
        const ctx = getContext();
        const exact = ctx.exact || 'BTN';
        const position = ctx.position || seatToBucket(exact);
        const facingRaise = ctx.facingRaise;
        const ranges = ctx.preflopAwaitingAction
            ? { fourbet: [], threebet: [], raise: [], call: [], check: [], fold: [] }
            : buildPositionRanges(position, facingRaise, ctx.openerBucket, ctx.preflopPressure);
        const players = scanPagePlayers();

        const playerOpts = players.length
            ? players.map(p => `<option value="${escHtml(p.id)}">${escHtml(p.name)} (${escHtml(p.id)})</option>`).join('')
            : '<option value="">Rakip bulunamadı</option>';

        const verdictHtml = buildVerdictHtml(ctx);

                const chip = (ch, action) => {
            const isHero = ctx.handClass && ch === ctx.handClass;
            return `<span class="tps-chip tps-chip-${action}${isHero ? ' tps-chip-hero' : ''}">${escHtml(ch)}</span>`;
        };
        const section = (title, list, action, color) => {
            if (!list || !list.length) return '';
            return `<div class="tps-sec">
                <div class="tps-sec-title" style="color:${color}">${title} <span class="tps-sec-count">${list.length}</span></div>
                <div>${list.map(ch => chip(ch, action)).join('')}</div>
            </div>`;
        };

        const panel = document.createElement('div');
        panel.id = 'tps-panel';
        panel.className = 'tps-panel';
        panel.innerHTML = `
            <div class="tps-head">
                <span class="tps-title">Poker Sidearm TR <span style="font-size:10px;font-weight:600;opacity:.65">v${TR_VERSION} · Sidearm ${SIDEARM_VERSION}</span>${debug === 1 ? ' <span style="font-size:9px;font-weight:700;color:#f1c40f">DEBUG</span>' : ''}</span>
                <button type="button" class="tps-x" aria-label="Kapat">&times;</button>
            </div>
            <div class="tps-body">
                <div class="tps-tabs">
                    <button type="button" class="tps-tab active" data-tab="ranges">Tavsiye</button>
                    <button type="button" class="tps-tab" data-tab="history">Geçmiş</button>
                    <button type="button" class="tps-tab" data-tab="scouter">${bountyView === 1 ? 'Scouter / Bounty' : 'Scouter'}</button>
                    <button type="button" class="tps-tab" data-tab="settings">Ayarlar</button>
                    <button type="button" class="tps-tab" data-tab="performance">İstatistik</button>
                    ${debug === 1 ? '<button type="button" class="tps-tab" data-tab="debug">Debug</button>' : ''}
                </div>

                <div data-pane="ranges">
                    <div id="tps-verdict">${verdictHtml}</div>
                    <div class="tps-btns" style="margin-top:6px">
                        <button type="button" class="tps-btn" id="tps-copy-hand">Bu eli kopyala</button>
                        <button type="button" class="tps-btn" id="tps-copy-last">Son eli kopyala</button>
                        <button type="button" class="tps-btn" id="tps-copy-last5">Son 5 eli kopyala</button>
                    </div>
                    ${debug === 1 ? `<div id="tps-action-debug">${buildHeroActionDiagHtml()}</div>` : ''}
                    <div class="tps-lab" style="margin-top:9px">Preflop oyun stili</div>
                    <div class="tps-btns">
                        <button type="button" class="tps-btn${currentPreflopRangeStyle() === 'tight' ? ' active' : ''}" data-range-style="tight">Sıkı</button>
                        <button type="button" class="tps-btn${currentPreflopRangeStyle() === 'balanced' ? ' active' : ''}" data-range-style="balanced">Dengeli</button>
                        <button type="button" class="tps-btn${currentPreflopRangeStyle() === 'wide' ? ' active' : ''}" data-range-style="wide">Geniş</button>
                        <button type="button" class="tps-btn${currentPreflopRangeStyle() === 'yo-momma' ? ' active' : ''}" data-range-style="yo-momma">Çok geniş</button>
                    </div>
                    <div class="tps-dim" style="margin-top:4px">${escHtml(preflopRangeStyleDescription())}</div>
                    <div class="tps-opener-note" id="tps-opener-note" style="margin-top:10px">${
                        ctx.preflopAwaitingAction
                            ? 'Big blind - sıra bekleniyor. Biri limp ya da raise yapınca Sidearm güncellenecek.'
                            : (ctx.facingRaise
                                ? (ctx.openerMatched
                                    ? 'Baskı: ' + preflopPressureShortLabel(ctx.preflopPressure) + ' · ilk raise: ' + (ctx.openerName || ctx.openerBucket) + ' (' + ctx.openerBucket + ')'
                                    : 'Baskı: ' + preflopPressureShortLabel(ctx.preflopPressure) + ' · ilk raise (tahmini): ' + (ctx.openerBucket || 'Late'))
                                : (ctx.preflopPressure?.bucket === 'limped'
                                    ? 'Limp yapılmış pot · ' + preflopPressureShortLabel(ctx.preflopPressure)
                                    : 'Henüz kimse oyuna girmedi - pozisyona göre normal açılış tablosu.'))
                    }</div>
                    <div class="tps-lab" style="margin-top:8px">Yüzen buton boyutu</div>
                    <div class="tps-btns">
                        <button type="button" class="tps-btn${(settings.bubbleSize || 'M') === 'S' ? ' active' : ''}" data-bsize="S">S</button>
                        <button type="button" class="tps-btn${(settings.bubbleSize || 'M') === 'M' ? ' active' : ''}" data-bsize="M">M</button>
                        <button type="button" class="tps-btn${(settings.bubbleSize || 'M') === 'L' ? ' active' : ''}" data-bsize="L">L</button>
                        <button type="button" class="tps-btn${(settings.bubbleSize || 'M') === 'XL' ? ' active' : ''}" data-bsize="XL">XL</button>
                    </div>
                    ${ctx.preflopAwaitingAction
                        ? '<div class="tps-dim" style="margin-top:10px">Kimse oyuna girmediği için big blind olarak henüz verilecek bir karar yok. Biri limp ya da raise yapınca tablo güncellenecek.</div>'
                        : `${section('▲▲▲ 4-Bet+', ranges.fourbet, '4bet', '#8e44ad')}
                           ${section('▲▲ 3-Bet', ranges.threebet, '3bet', '#9b59b6')}
                           ${section('▲ Raise', ranges.raise, 'raise', '#2ecc71')}
                           ${section('● Call', ranges.call, 'call', '#f1c40f')}
                           ${section('✓ Check', ranges.check, 'check', '#3498db')}
                           <div class="tps-dim" style="margin-top:8px">Listede olmayan ${(ranges.fold || []).length} el = FOLD.</div>`}
                </div>

                <div data-pane="performance" style="display:none">
                    ${buildPerformanceHtml()}
                </div>

                ${debug === 1 ? `<div data-pane="debug" style="display:none">
                    <div id="tps-v6-debug-content">${buildV6DebugPanelHtml(ctx)}</div>
                </div>` : ''}

                <div data-pane="history" style="display:none">
                    <div class="tps-lab">Son pot kazananları (masa kaydından)</div>
                    <div id="tps-history-list">${buildHistoryHtml()}</div>
                    <div class="tps-btns" style="margin-top:10px">
                        <button type="button" class="tps-btn" id="tps-hist-refresh">Yenile</button>
                        <button type="button" class="tps-btn danger" id="tps-hist-clear">Geçmişi sil</button>
                    </div>
                    <div class="tps-dim" style="margin-top:8px">FF = Fair Fight (FFScouter). Saldırı sayfasını açmak için isme ya da puana dokun. Son ${HISTORY_MAX} potun oyuncu ID\u2019leri saklanır; oyuncu masadan kalksa da puanı görünür.</div>
                </div>

                <div data-pane="scouter" style="display:none">
                    <div class="tps-row">
                        <div class="tps-lab">Masadaki rakip</div>
                        <select class="tps-sel" id="tps-target">${playerOpts}</select>
                        <div class="tps-lab" style="margin-top:6px">Ya da oyuncu ID</div>
                        <input class="tps-in" id="tps-manual-id" type="text" inputmode="numeric" placeholder="Torn oyuncu ID" />
                        <div class="tps-btns">
                            <button type="button" class="tps-btn pri" id="tps-lookup">Bilgileri getir</button>
                        </div>
                    </div>
                    <div id="tps-stats"></div>
                    ${bountyView === 1 ? `<div class="tps-row" style="margin-top:10px">
                        <div class="tps-lab">Bounty Board - reward per hit (${money(MIN_PRICE)}-${money(MAX_PRICE)})</div>
                        <input class="tps-in" id="tps-price" type="number" min="${MIN_PRICE}" max="${MAX_PRICE}" step="1000"
                            value="${clamp(parseInt(settings.pricePerHit, 10) || 500000, MIN_PRICE, MAX_PRICE)}" />
                        <div class="tps-btns">
                            <button type="button" class="tps-btn" data-quote="1">Quote 1</button>
                            <button type="button" class="tps-btn" data-quote="5">Quote 5</button>
                            <button type="button" class="tps-btn" data-quote="10">Quote 10</button>
                        </div>
                        <div class="tps-btns">
                            <button type="button" class="tps-btn danger" data-place="1">Place 1</button>
                            <button type="button" class="tps-btn danger" data-place="5">Place 5</button>
                            <button type="button" class="tps-btn danger" data-place="10">Place 10</button>
                        </div>
                    </div>
                    <div id="tps-quote"></div>
                    <div id="tps-order"></div>` : ''}
                    <div class="tps-status" id="tps-scout-status"></div>
                </div>

                <div data-pane="settings" style="display:none">
                    <div class="tps-row">
                        <div class="tps-lab">FFScouter API anahtarı (sadece Scouter sekmesi ve FF puanları için)</div>
                        <input class="tps-in" id="tps-ffkey" type="password" autocomplete="off"
                            placeholder="16 karakterlik anahtar" value="${escHtml(settings.ffKey || '')}" />
                        <div class="tps-btns">
                            <button type="button" class="tps-btn pri" id="tps-save-key">Anahtarı kaydet</button>
                        </div>
                    </div>
                    <div class="tps-card">
                        <h3>Anahtarın yok mu?</h3>
                        <ol class="tps-dim" style="margin:0 0 8px 18px; padding:0">
                            <li>Bir Torn API anahtarı oluştur:
                                <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener" style="color:#a29bfe">Torn → Settings → API Key</a>
                                (FFScouter için Limited erişim önerilir).</li>
                            <li>FFScouter\u2019ın
                                <a href="https://ffscouter.com/" target="_blank" rel="noopener" style="color:#a29bfe">veri politikası ve kullanım şartlarını</a> oku.</li>
                            <li>16 karakterlik anahtarı aşağıya yapıştır, kutuyu işaretle, sonra kaydet.</li>
                        </ol>
                        <label class="tps-check">
                            <input type="checkbox" id="tps-agree" />
                            <span>ffscouter.com\u2019daki FFScouter veri politikasını ve kullanım şartlarını okudum, kabul ediyorum.</span>
                        </label>
                        <input class="tps-in" id="tps-reg-key" type="text" autocomplete="off"
                            placeholder="Kaydedilecek Torn/FFScouter anahtarını yapıştır" style="margin-top:8px" />
                        <div class="tps-btns">
                            <button type="button" class="tps-btn pri" id="tps-register">Anahtarı FFScouter\u2019a kaydet</button>
                        </div>
                        <div class="tps-dim" style="margin-top:6px">Anahtar sadece ffscouter.com\u2019a gönderilir (POST /api/v1/register · signup_source=${escHtml(SIGNUP_SOURCE)})</div>
                    </div>
                    <div class="tps-status" id="tps-set-status"></div>
                    </div>
            </div>`;

        if (settings.panelPosition) applyPos(panel, settings.panelPosition);
        else {
            panel.style.right = '16px';
            panel.style.top = '80px';
            panel.style.left = 'auto';
        }
        document.body.appendChild(panel);

        panel.querySelector('.tps-x').addEventListener('click', closePanel);

        // Delegate Why? clicks from the stable panel root. refreshPanel replaces
        // #tps-verdict.innerHTML, so a listener attached directly to the button
        // would be destroyed on the next live refresh.
        panel.addEventListener('click', e => {
            const whyToggle = e.target.closest?.('#tps-why-toggle');
            if (!whyToggle || !panel.contains(whyToggle)) return;
            e.preventDefault();
            e.stopPropagation();
            const whyBody = panel.querySelector('#tps-why-body');
            if (!whyBody) return;
            const key = String(whyToggle.getAttribute('data-why-key') || '');
            const open = !whyBody.classList.contains('show');
            _whyExpandedKey = open ? key : '';
            whyBody.classList.toggle('show', open);
            whyToggle.textContent = open ? 'Gizle' : 'Neden?';
        });

        // Debug DOM controls are delegated for the same reason as Why?: the
        // debug pane is refreshed live and its button nodes are replaced.
        panel.addEventListener('click', async e => {
            const btn = e.target.closest?.('[data-tps-debug-action]');
            if (!btn || !panel.contains(btn) || debug !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            const action = btn.getAttribute('data-tps-debug-action');
            const status = panel.querySelector('[data-tps-debug-status]');
            if (action === 'copy-owner-dom') {
                const text = ownerDomDiagnosticText();
                await copyTextToClipboard(text, btn, 'Kopyalandı');
                if (status) status.textContent = 'DOM diagnostic copied - paste that output back into the Sidearm chat.';
            } else if (action === 'force-rainbow') {
                const marked = applyOwnerRainbowEasterEgg();
                if (status) status.textContent = `Rainbow reapplied to ${marked} matching name element${marked === 1 ? '' : 's'}.`;
                const debugSlot = panel.querySelector('#tps-v6-debug-content');
                if (debugSlot) debugSlot.innerHTML = buildV6DebugPanelHtml(getContext());
            } else if (action === 'refresh-debug') {
                const debugSlot = panel.querySelector('#tps-v6-debug-content');
                if (debugSlot) debugSlot.innerHTML = buildV6DebugPanelHtml(getContext());
            }
        });

        // Drag
        const head = panel.querySelector('.tps-head');
        head.style.touchAction = 'none';
        head.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            if (e.button !== undefined && e.button !== 0) return;
            let dragged = false;
            let pid = e.pointerId;
            try { head.setPointerCapture(e.pointerId); } catch (_) {}
            const r = panel.getBoundingClientRect();
            const sx = e.clientX, sy = e.clientY, sl = r.left, st = r.top;
            const onMove = ev => {
                if (ev.pointerId !== pid) return;
                if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) dragged = true;
                if (!dragged) return;
                ev.preventDefault();
                panel.style.left = clamp(sl + (ev.clientX - sx), 6, window.innerWidth - 80) + 'px';
                panel.style.top = clamp(st + (ev.clientY - sy), 6, window.innerHeight - 40) + 'px';
                panel.style.right = 'auto';
            };
            const onUp = ev => {
                if (ev.pointerId !== pid) return;
                try { head.releasePointerCapture(pid); } catch (_) {}
                head.removeEventListener('pointermove', onMove);
                head.removeEventListener('pointerup', onUp);
                head.removeEventListener('pointercancel', onUp);
                if (dragged) {
                    const nr = panel.getBoundingClientRect();
                    settings.panelPosition = { x: Math.round(nr.left), y: Math.round(nr.top) };
                    saveSettings(settings);
                }
            };
            head.addEventListener('pointermove', onMove);
            head.addEventListener('pointerup', onUp);
            head.addEventListener('pointercancel', onUp);
        });

        // Tabs
        panel.querySelectorAll('.tps-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                panel.querySelectorAll('.tps-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const name = tab.getAttribute('data-tab');
                panel.querySelectorAll('[data-pane]').forEach(p => {
                    p.style.display = p.getAttribute('data-pane') === name ? '' : 'none';
                });
            });
        });

        // Restore tab after a full rebuild from refreshPanel
        if (window.__tpsActiveTab) {
            const name = window.__tpsActiveTab;
            window.__tpsActiveTab = null;
            panel.querySelectorAll('.tps-tab').forEach(tab => {
                const on = tab.getAttribute('data-tab') === name;
                tab.classList.toggle('active', on);
            });
            panel.querySelectorAll('[data-pane]').forEach(p => {
                p.style.display = p.getAttribute('data-pane') === name ? '' : 'none';
            });
        }

        async function copyTextToClipboard(text, btn, okLabel) {
            try {
                await navigator.clipboard.writeText(text);
                if (btn) {
                    const prev = btn.textContent;
                    btn.textContent = okLabel || 'Kopyalandı';
                    btn.classList.add('tps-copy-ok');
                    setTimeout(() => {
                        btn.textContent = prev;
                        btn.classList.remove('tps-copy-ok');
                    }, 1200);
                }
            } catch (_) {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    if (btn) btn.textContent = okLabel || 'Kopyalandı';
                } catch (e2) {
                    alert(text);
                }
            }
        }

        panel.querySelector('#tps-copy-hand')?.addEventListener('click', async () => {
            let copyCtx = ctx;
            try {
                const liveCtx = getContext();
                if (liveCtx) copyCtx = liveCtx;
            } catch (_) {}

            const text = buildCopyHandText(copyCtx);
            await copyTextToClipboard(text, panel.querySelector('#tps-copy-hand'), 'Kopyalandı');
        });
        panel.querySelector('#tps-copy-last')?.addEventListener('click', async () => {
            const text = loadLastHandNote();
            if (!text) {
                const btn = panel.querySelector('#tps-copy-last');
                if (btn) {
                    const prev = btn.textContent;
                    btn.textContent = 'Henüz yok';
                    setTimeout(() => { btn.textContent = prev; }, 1200);
                }
                return;
            }
            await copyTextToClipboard(text, panel.querySelector('#tps-copy-last'), 'Kopyalandı');
        });

        panel.querySelector('#tps-copy-last5')?.addEventListener('click', async () => {
            const hands = loadLastHandNotes(5);
            const btn = panel.querySelector('#tps-copy-last5');
            if (!hands.length) {
                if (btn) {
                    const prev = btn.textContent;
                    btn.textContent = 'Henüz yok';
                    setTimeout(() => { btn.textContent = prev; }, 1200);
                }
                return;
            }
            const text = hands.map((hand, i) => `===== Hand ${i + 1} =====\n${hand}`).join('\n\n');
            await copyTextToClipboard(text, btn, 'Kopyalandı');
        });

        function refreshPerformancePane() {
            try { scanAndRecordHistory(); } catch (e) { console.error('[TPS] stats refresh scan', e); }
            const pane = panel.querySelector('[data-pane="performance"]');
            if (pane) pane.innerHTML = buildPerformanceHtml();
            bindPerformanceButtons();
        }

        function bindPerformanceButtons() {
            panel.querySelector('#tps-perf-refresh')?.addEventListener('click', refreshPerformancePane);
            panel.querySelector('#tps-perf-json')?.addEventListener('click', () => downloadPerformance('json'));
            panel.querySelector('#tps-perf-csv')?.addEventListener('click', () => downloadPerformance('csv'));
            panel.querySelector('#tps-perf-clear')?.addEventListener('click', () => {
                if (!confirm('İstatistikler silinsin mi? Kayıtlı tüm eller silinir.')) return;
                saveHandRecords([]);
                _liveHandRecord = null;
                refreshPerformancePane();
            });
        }
        bindPerformanceButtons();

        async function refreshHistoryPane() {
            scanAndRecordHistory();
            const list = panel.querySelector('#tps-history-list');
            if (list) list.innerHTML = buildHistoryHtml();
            await ensureHistoryFfScores();
            if (list) list.innerHTML = buildHistoryHtml();
            list && list.querySelectorAll('[data-attack-id]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.getAttribute('data-attack-id');
                    if (id) window.open('https://www.torn.com/page.php?sid=attack&user2ID=' + encodeURIComponent(id), '_blank', 'noopener,noreferrer');
                });
            });
        }
        panel.querySelector('#tps-hist-refresh')?.addEventListener('click', () => { refreshHistoryPane(); });
        // Load FF scores when history tab is opened
        panel.querySelectorAll('.tps-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                if (tab.getAttribute('data-tab') === 'history') setTimeout(() => refreshHistoryPane(), 50);
                if (tab.getAttribute('data-tab') === 'performance') setTimeout(() => refreshPerformancePane(), 20);
            });
        });
        panel.querySelector('#tps-hist-clear')?.addEventListener('click', () => {
            if (!confirm('Pot kazananları geçmişi silinsin mi?')) return;
            saveHistory([]);
            _histSeen = new Set();
            const list = panel.querySelector('#tps-history-list');
            if (list) list.innerHTML = buildHistoryHtml();
        });

        // Unlinked history names: try open profile search by clicking
        panel.querySelectorAll('.tps-hist-nolink').forEach(el => {
            el.addEventListener('click', () => {
                const n = el.getAttribute('data-hist-name') || '';
                const url = profileUrlForName(n);
                if (url) window.open(url, '_blank', 'noopener');
            });
        });
        panel.querySelectorAll('[data-attack-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-attack-id');
                if (id) window.open('https://www.torn.com/page.php?sid=attack&user2ID=' + encodeURIComponent(id), '_blank', 'noopener,noreferrer');
            });
        });
        panel.querySelectorAll('[data-range-style]').forEach(b => {
            b.addEventListener('click', () => {
                const next = String(b.getAttribute('data-range-style') || 'balanced').toLowerCase();
                settings.rangeStyle = PREFLOP_RANGE_STYLES.includes(next) ? next : 'balanced';
                saveSettings(settings);
                _equityCache = { key: '', value: null, at: 0 };
                showPanel();
                refreshBubble();
            });
        });

        panel.querySelectorAll('[data-bsize]').forEach(b => {
            b.addEventListener('click', () => {
                settings.bubbleSize = b.getAttribute('data-bsize') || 'M';
                saveSettings(settings);
                showPanel();
                refreshBubble();
            });
        });

        const scoutStatus = (msg) => {
            const el = panel.querySelector('#tps-scout-status');
            if (el) el.textContent = msg || '';
        };
        const setStatus = (msg) => {
            const el = panel.querySelector('#tps-set-status');
            if (el) el.textContent = msg || '';
        };

        const resolveId = () => {
            const m = panel.querySelector('#tps-manual-id')?.value.trim();
            return m || panel.querySelector('#tps-target')?.value || null;
        };

        panel.querySelector('#tps-lookup')?.addEventListener('click', async () => {
            const id = resolveId();
            if (!id) { scoutStatus('Bir oyuncu seç ya da ID gir.'); return; }
            const box = panel.querySelector('#tps-stats');
            box.innerHTML = '<div class="tps-dim">Yükleniyor…</div>';
            try {
                const st = await fetchFfStats(id);
                const name = (players.find(p => p.id === id) || {}).name;
                const ff = st.fair_fight != null ? Number(st.fair_fight).toFixed(2) : '-';
                const bs = st.bs_estimate_human || '-';
                const pid = String(st.player_id || id);
                const attackUrl = `https://www.torn.com/page.php?sid=attack&user2ID=${encodeURIComponent(pid)}`;
                const profileUrl = `https://www.torn.com/profiles.php?XID=${encodeURIComponent(pid)}`;
                box.innerHTML = `<div class="tps-card"><h3>${escHtml(name || 'Oyuncu')} [${escHtml(pid)}]</h3>
                    <div class="tps-stat"><span class="tps-k">Fair Fight</span><span class="tps-v">${escHtml(ff)}</span></div>
                    <div class="tps-stat"><span class="tps-k">Tahmini battle stat</span><span class="tps-v">${escHtml(bs)}</span></div>
                    <div class="tps-stat"><span class="tps-k">Açık BSS</span><span class="tps-v">${escHtml(st.bss_public != null ? Number(st.bss_public).toLocaleString() : '-')}</span></div>
                    <div class="tps-stat"><span class="tps-k">Kaynak</span><span class="tps-v">${escHtml(st.source || '-')}</span></div>
                    <div class="tps-stat"><span class="tps-k">Güncellendi</span><span class="tps-v">${escHtml(formatTs(st.last_updated))}</span></div>
                    <div class="tps-btns" style="margin-top:8px">
                        <button type="button" class="tps-btn danger" id="tps-attack">Saldır!</button>
                        <button type="button" class="tps-btn" id="tps-profile">Profil</button>
                    </div>
                </div>`;
                box.querySelector('#tps-attack')?.addEventListener('click', () => {
                    window.open(attackUrl, '_blank', 'noopener,noreferrer');
                });
                box.querySelector('#tps-profile')?.addEventListener('click', () => {
                    window.open(profileUrl, '_blank', 'noopener,noreferrer');
                });
                scoutStatus('Bilgiler yüklendi.');
            } catch (err) {
                box.innerHTML = '';
                scoutStatus(String(err.message || err));
            }
        });

        panel.querySelectorAll('[data-quote]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const qty = parseInt(btn.getAttribute('data-quote'), 10) || 1;
                const price = clamp(parseInt(panel.querySelector('#tps-price').value, 10) || 500000, MIN_PRICE, MAX_PRICE);
                settings.pricePerHit = price; saveSettings(settings);
                const box = panel.querySelector('#tps-quote');
                box.innerHTML = '<div class="tps-dim">Quoting…</div>';
                try {
                    const q = await quoteBounty(qty, price);
                    box.innerHTML = `<div class="tps-card"><h3>Quote · ${qty} @ ${escHtml(money(price))}</h3>
                        <div class="tps-stat"><span class="tps-k">Subtotal</span><span class="tps-v">${escHtml(money(q.subtotal))}</span></div>
                        <div class="tps-stat"><span class="tps-k">Fee</span><span class="tps-v">${escHtml(money(q.fee_amount))} (${q.fee_percent != null ? Math.round(q.fee_percent * 100) + '%' : '-'})</span></div>
                        <div class="tps-stat"><span class="tps-k">Total</span><span class="tps-v">${escHtml(money(q.total_payable))}</span></div>
                        <div class="tps-stat"><span class="tps-k">Xanax expected</span><span class="tps-v">${escHtml(String(q.expected_xanax_quantity ?? '-'))}</span></div>
                    </div>`;
                    scoutStatus('Quote ready.');
                } catch (err) {
                    box.innerHTML = '';
                    scoutStatus(String(err.message || err));
                }
            });
        });

        panel.querySelectorAll('[data-place]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = resolveId();
                if (!id) { scoutStatus('Select a target first.'); return; }
                const qty = parseInt(btn.getAttribute('data-place'), 10) || 1;
                const price = clamp(parseInt(panel.querySelector('#tps-price').value, 10) || 500000, MIN_PRICE, MAX_PRICE);
                settings.pricePerHit = price; saveSettings(settings);
                if (!confirm(`Place FFScouter bounty order?\nTarget ${id}\n${qty} hits @ ${money(price)}\nPay with Xanax using the returned message.`)) return;
                const box = panel.querySelector('#tps-order');
                box.innerHTML = '<div class="tps-dim">Placing…</div>';
                try {
                    const order = await placeBountyOrder(id, qty, price);
                    // Prefer API status_url; fall back to token-based FFScouter URL
                    const pi = order.payment_instructions || {};
                    const msg = pi.message || '';
                    const statusUrl = order.status_url
                        || (order.status_token
                            ? ('https://ffscouter.com/buy-bounties/' + order.status_token)
                            : '');
                    box.innerHTML = `<div class="tps-pay"><strong>Order</strong> ${escHtml(order.reference || '')}<br>
                        Token <code>${escHtml(order.status_token || '')}</code><br>
                        Send Xanax with message <code>${escHtml(msg)}</code><br>
                        Xanax ${escHtml(String(pi.xanax_expected ?? '-'))} · total ${escHtml(money(pi.total_payable))}
                        ${statusUrl ? `<br><a href="${escHtml(statusUrl)}" target="_blank" rel="noopener" style="color:#a29bfe">Status - click here to proceed</a>` : ''}
                    </div>`;
                    try { if (msg) navigator.clipboard.writeText(msg); } catch (_) {}
                    scoutStatus('Order created - pay with Xanax.');
                } catch (err) {
                    box.innerHTML = '';
                    scoutStatus(String(err.message || err));
                }
            });
        });


        panel.querySelector('#tps-save-key')?.addEventListener('click', () => {
            settings.ffKey = panel.querySelector('#tps-ffkey').value.trim();
            saveSettings(settings);
            setStatus(settings.ffKey ? 'Anahtar bu tarayıcıya kaydedildi.' : 'Anahtar silindi.');
        });

        panel.querySelector('#tps-register')?.addEventListener('click', async () => {
            const agree = panel.querySelector('#tps-agree')?.checked;
            if (!agree) {
                setStatus('Önce FFScouter şartlarını okuduğunu onaylayan kutuyu işaretle.');
                return;
            }
            const key = panel.querySelector('#tps-reg-key').value.trim()
                || panel.querySelector('#tps-ffkey').value.trim();
            setStatus('Kaydediliyor…');
            try {
                const data = await registerFfKey(key);
                settings.ffKey = key;
                saveSettings(settings);
                panel.querySelector('#tps-ffkey').value = key;
                setStatus(data.message || 'API anahtarı kaydedildi.');
            } catch (err) {
                setStatus(String(err.message || err));
            }
        });
    }

    // ── Live updates ─────────────────────────────────────────────

    let refreshTimer = null;

    function runLiveRefreshCycle() {
        if (document.hidden) return;
        if (_v6Runtime.refreshRunning) {
            _v6Runtime.refreshQueued = true;
            return;
        }
        _v6Runtime.refreshRunning = true;

        try {
            const tableTextureChanged = (() => {
                try { return syncRenderedTableTexture(); } catch (_) { return false; }
            })();
            if (tableTextureChanged) _equityCache = { key: '', value: null, at: 0 };

            refreshLiveLogSnapshot(true);

            let ctx = null;
            try { ctx = getContext(); }
            catch (e) { console.error('[TPS] V6 context refresh', e); }

            refreshBubble(ctx);
            refreshPanel(ctx);
            try { applyDevelopmentNameColours(); } catch (_) {}
            try { applyOwnerRainbowEasterEgg(); } catch (_) {}

            try { if (ctx) maybeStoreLastHand(ctx); } catch (_) {}

            // Only enqueue completed-hand work here. Actual History/My Stats
            // reconciliation runs on a short timer after this paint-critical path.
            try { scanAndRecordHistory(); } catch (_) {}

            try {
                if (!_tableTopology.pendingSignature) {
                    const snap = snapshotSeatedVillains();
                    if (snap.size) _departedSeatSnapshot = snap;
                }
            } catch (_) {}
        } finally {
            _v6Runtime.refreshRunning = false;
            if (_v6Runtime.refreshQueued) {
                _v6Runtime.refreshQueued = false;
                setTimeout(runLiveRefreshCycle, 0);
            }
        }
    }

    function scheduleRefresh() {
        if (document.hidden) return;
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            runLiveRefreshCycle();
        }, MUTATION_REFRESH_DEBOUNCE_MS);
    }

    function mutationIsSidearmOnly(record) {
        const raw = record?.target;
        const target = raw?.nodeType === 1 ? raw : raw?.parentElement;
        if (target && (
            target.closest?.('#tps-panel') ||
            target.closest?.('#tps-bubble') ||
            target.closest?.('#tps-departed-alerts') ||
            target.closest?.('#tps-debug-departures') ||
            target.closest?.('#tps-table-insight-toast') ||
            target.closest?.('#tps-poker-term-toast')
        )) return true;

        const nodes = [...(record?.addedNodes || []), ...(record?.removedNodes || [])]
            .filter(n => n && n.nodeType === 1);
        if (!nodes.length) return false;
        return nodes.every(n =>
            n.id === 'tps-panel' || n.id === 'tps-bubble' ||
            n.id === 'tps-departed-alerts' || n.id === 'tps-debug-departures' ||
            n.id === 'tps-table-insight-toast' || n.id === 'tps-poker-term-toast' ||
            n.closest?.('#tps-panel') || n.closest?.('#tps-bubble') ||
            n.closest?.('#tps-departed-alerts') || n.closest?.('#tps-debug-departures') ||
            n.closest?.('#tps-table-insight-toast') || n.closest?.('#tps-poker-term-toast')
        );
    }

    const POKER_MUTATION_SELECTOR = [
        '[class^="table___"]', '[class*=" table___"]',
        '[id^="player-"]', '[class*="playerPositioner"]', '[class*="selfPositioner"]',
        '[class*="message___"]', '[class*="logList"]', '[class*="dealer___"]',
        '[class*="community___"]', '[class*="board___"]', '[class*="flop___"]',
        '[class*="turn___"]', '[class*="river___"]', '[class*="tableCards"]',
        '[class*="communityCards"]', '[class*="boardCards"]', '[class*="flipper___"]',
        '[class*="potString___"]', '[class*="money___"]', '[class*="pot___"]',
        '[class*="actionButton"]', '[class*="action-button"]',
        '[class*="spades-"]', '[class*="hearts-"]', '[class*="diamonds-"]', '[class*="clubs-"]'
    ].join(',');

    function nodeOrAncestorLooksPokerRelevant(node) {
        const el = node?.nodeType === 1 ? node : node?.parentElement;
        if (!el) return false;
        try {
            if (el.matches?.(POKER_MUTATION_SELECTOR) || el.closest?.(POKER_MUTATION_SELECTOR)) return true;
            const style = String(el.getAttribute?.('style') || '');
            if (/tables_colour\//i.test(style)) return true;
            if (el.matches?.('button, [role="button"]')) {
                const tx = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                if (/^(?:call|check|fold|all[\s-]*in|bet|raise)\b/i.test(tx)) return true;
            }
        } catch (_) {}
        return false;
    }

    function addedOrRemovedSubtreeLooksPokerRelevant(node) {
        const el = node?.nodeType === 1 ? node : null;
        if (!el) return nodeOrAncestorLooksPokerRelevant(node);
        if (nodeOrAncestorLooksPokerRelevant(el)) return true;
        try {
            if (el.querySelector?.(POKER_MUTATION_SELECTOR)) return true;
            if (el.querySelector?.('[style*="tables_colour"]')) return true;
            return [...(el.querySelectorAll?.('button, [role="button"]') || [])].some(btn => {
                const tx = String(btn.textContent || '').replace(/\s+/g, ' ').trim();
                return /^(?:call|check|fold|all[\s-]*in|bet|raise)\b/i.test(tx);
            });
        } catch (_) {
            return false;
        }
    }

    function nodeOrAncestorTouchesSeat(node) {
        const el = node?.nodeType === 1 ? node : node?.parentElement;
        if (!el) return false;
        try {
            return !!(el.matches?.('[id^="player-"], [class*="playerPositioner"], [class*="selfPositioner"]') ||
                el.closest?.('[id^="player-"], [class*="playerPositioner"], [class*="selfPositioner"]'));
        } catch (_) {
            return false;
        }
    }

    function mutationTouchesSeat(record) {
        if (nodeOrAncestorTouchesSeat(record?.target)) return true;
        const changed = [...(record?.addedNodes || []), ...(record?.removedNodes || [])];
        return changed.some(node => {
            if (nodeOrAncestorTouchesSeat(node)) return true;
            const el = node?.nodeType === 1 ? node : null;
            try { return !!el?.querySelector?.('[id^="player-"]'); } catch (_) { return false; }
        });
    }

    function mutationLooksPokerRelevant(record) {
        if (nodeOrAncestorLooksPokerRelevant(record?.target)) return true;
        const changed = [...(record?.addedNodes || []), ...(record?.removedNodes || [])];
        return changed.some(addedOrRemovedSubtreeLooksPokerRelevant);
    }

    function init() {
        injectStyles();
        ensureBubble();
        ensureBubbleVisible();
        requestAnimationFrame(ensureBubbleVisible);
        setTimeout(ensureBubbleVisible, 250);
        window.addEventListener('resize', ensureBubbleVisible, { passive: true });
        window.addEventListener('pageshow', () => setTimeout(ensureBubbleVisible, 0));
        try { syncRenderedTableTexture(); } catch (_) {}
        try { initialiseDepartedSnapshot(); } catch (_) {}
        if (debug === 1) {
            try { ensureDebugDepartureHost(); renderDebugDepartures(); } catch (_) {}
        }

        // Torn mutations should refresh Sidearm. Sidearm's own panel/bubble
        // mutations must not feed back into the observer and create a refresh loop.
        const obs = new MutationObserver(records => {
            if (document.hidden) return;
            const external = records.filter(r => !mutationIsSidearmOnly(r));
            if (!external.length) return;

            const seatRecords = external.filter(mutationTouchesSeat);
            if (seatRecords.length) {
                try { observeDepartureStackMutations(seatRecords); } catch (_) {}
            }

            let textureChanged = false;
            try { textureChanged = syncRenderedTableTexture(); } catch (_) {}
            if (textureChanged) _equityCache = { key: '', value: null, at: 0 };

            if (textureChanged || external.some(mutationLooksPokerRelevant)) scheduleRefresh();
        });
        obs.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'src', 'srcset', 'data-src', 'data-srcset', 'data-background']
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                _equityCache = { key: '', value: null, at: 0 };
                ensureBubbleVisible();
                runLiveRefreshCycle();
            }
        });

        setInterval(() => {
            if (document.hidden) return;
            ensureBubbleVisible();
            runLiveRefreshCycle();
            const histList = document.querySelector('#tps-history-list');
            if (histList && document.getElementById('tps-panel')) {
                const pane = histList.closest('[data-pane="history"]');
                if (pane && pane.style.display !== 'none') {
                    histList.innerHTML = buildHistoryHtml();
                    histList.querySelectorAll('[data-attack-id]').forEach(btn => {
                        btn.onclick = () => {
                            const id = btn.getAttribute('data-attack-id');
                            if (id) window.open('https://www.torn.com/page.php?sid=attack&user2ID=' + encodeURIComponent(id), '_blank', 'noopener,noreferrer');
                        };
                    });
                }
            }
        }, SAFETY_REFRESH_MS);
    }

    // TR 1.0.2: PDA\u2019da konsol görünmediği için durum ve hatalar ekranda gösterilir.
    function trNotice(text, isError) {
        try {
            const box = document.createElement('div');
            box.textContent = text;
            box.style.cssText = 'position:fixed;left:8px;right:8px;top:70px;z-index:2147483647;padding:8px 10px;'
                + 'border-radius:8px;font:12px/1.35 sans-serif;color:#fff;white-space:pre-wrap;word-break:break-word;'
                + 'background:' + (isError ? '#b71c1c' : '#2e7d32') + ';box-shadow:0 2px 8px rgba(0,0,0,.4)';
            (document.body || document.documentElement).appendChild(box);
            box.addEventListener('click', () => box.remove());
            if (!isError) setTimeout(() => box.remove(), 4000);
        } catch (_) {}
    }

    let _trBootErrors = 0;
    function boot() {
        if (!document.body) {
            setTimeout(boot, 200);
            return;
        }
        try {
            init();
            trNotice('Sidearm TR ' + TR_VERSION + ' çalışıyor. Yuvarlak "Sidearm" butonu sağ altta olmalı.', false);
        }
        catch (e) {
            console.error('[TPS] boot', e);
            if (++_trBootErrors <= 1) trNotice('Sidearm TR açılırken hata verdi (ekran görüntüsü al, dokununca kapanır):\n' + (e && (e.stack || e.message) || e), true);
            setTimeout(boot, 1000);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
