// ==UserScript==
// @name         Torn Holdem Diag
// @namespace    https://greasyfork.org/users/nebigoktug
// @version      0.1.0
// @description  Temporary diagnostic: shows on the poker page whether Poker Sidearm TR started, where its button is, and any script errors. Remove after use.
// @author       NebiGoktug
// @license      MIT
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (!/holdem|poker|casino/i.test(location.href)) return;
  if (window.__thdRunning) return;
  window.__thdRunning = true;

  const started = Date.now();
  const errors = [];
  window.addEventListener('error', (e) => {
    errors.push(`${e.message || e} @ ${String(e.filename || '').split('/').pop()}:${e.lineno || '?'}`);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    errors.push('promise: ' + String(e.reason && (e.reason.message || e.reason)));
  });

  function report() {
    const bubble = document.getElementById('tps-bubble');
    let where = 'yok';
    if (bubble) {
      const r = bubble.getBoundingClientRect();
      const onScreen = r.width > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
      where = `var · ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} · ${onScreen ? 'ekranda' : 'EKRAN DIŞINDA'}`;
    }
    const lines = [
      'Holdem teşhis (dokununca kapanır)',
      'Adres: ' + location.href,
      'Ekran: ' + innerWidth + 'x' + innerHeight,
      'Sidearm TR başladı mı: ' + (window.__tpsTrRunning ? 'EVET' : 'HAYIR'),
      'Sidearm butonu: ' + where,
      'Panel: ' + (document.getElementById('tps-panel') ? 'açık' : 'kapalı'),
      'Süre: ' + Math.round((Date.now() - started) / 1000) + ' sn',
      'Hatalar: ' + (errors.length ? '\n- ' + errors.slice(0, 6).join('\n- ') : 'yok'),
    ];
    let box = document.getElementById('thd-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'thd-box';
      box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;padding:8px 10px;'
        + 'border-radius:8px;font:11px/1.35 monospace;color:#fff;background:rgba(20,20,60,.92);'
        + 'white-space:pre-wrap;word-break:break-all;box-shadow:0 2px 8px rgba(0,0,0,.5)';
      box.addEventListener('click', () => { box.remove(); clearInterval(timer); });
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = lines.join('\n');
  }

  const timer = setInterval(() => { if (document.body) report(); }, 2000);
})();
