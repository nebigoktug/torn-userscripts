// ==UserScript==
// @name         Torn Pickpocketing Helper
// @namespace    https://greasyfork.org/users/nebigoktug
// @version      1.0.0
// @description  Colours every pickpocketing mark by how safe it is for your crime skill, its activity and its build, with a short tag next to the name. Read-only, no automation.
// @author       NebiGoktug
// @license      MIT
// @match        https://www.torn.com/page.php?sid=crimes*
// @match        https://www.torn.com/loader.php?sid=crimes*
// @icon         https://www.torn.com/favicon.ico
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Torn Pickpocketing Helper
 *
 * Marks on the pickpocketing page appear and vanish within seconds, and the
 * mark type, its activity (an icon) and its build all change your odds. This
 * reads all three plus your crime skill and puts a verdict on each mark:
 *
 *   - a coloured strip on the left: green = go, amber = risky for your
 *     skill, red = skip, purple = police officer (avoid)
 *   - a short tag after the name: the activity, and the reason when the
 *     activity or build pushes the verdict up (▲) or down (▼)
 *
 * Risk tiers, skill levels and per-mark advice come from Emforus' guide
 * "[Crimes 2.0] Pickpocketing: An In-Depth Guide" (Torn forums thread
 * 16358739, ~8.4k logs). The author's own caveat applies: some marks have
 * little data. The colours are a hint, not a promise.
 *
 * No panel, no settings, no API key, no requests. This script only reads the
 * page. It never clicks, commits or automates anything — that would be
 * against Torn's rules.
 *
 * MIT licensed.
 */

(function () {
  'use strict';

  // Torn PDA can inject the same script again on in-page navigation.
  if (window.__tppRunning) return;
  window.__tppRunning = true;

  const GREEN = '#37b24d', AMBER = '#f59f00', RED = '#f03e3e', PURPLE = '#7048e8';
  const LEVEL_COLORS = [RED, AMBER, GREEN];

  // Activity icons are one sprite (status-icons-*.svg), 34 px per icon,
  // picked with background-position-y.
  const ACTIVITY_BY_OFFSET = {
    '0': 'Cycling',
    '-34': 'Distracted',   // thought cloud
    '-68': 'Distracted',   // speech bubbles
    '-102': 'Music',
    '-136': 'Loitering',
    '-170': 'On phone',
    '-204': 'Running',     // also jogging
    '-238': 'Soliciting',
    '-272': 'Stumbling',
    '-306': 'Walking',
    '-340': 'Begging',
  };
  // The guide's rule of thumb: the less attention a mark pays, the better.
  const OBLIVIOUS = ['On phone', 'Music'];

  // min: crime skill from which the guide calls the mark worth doing.
  // good/bad: activities and builds the guide says to prefer or avoid.
  const MARKS = {
    'drunk man':       { min: 1,  bad: ['Distracted', 'Muscular'] },
    'drunk woman':     { min: 1,  bad: ['Distracted'] },
    'elderly man':     { min: 1 },
    'elderly woman':   { min: 1 },
    'homeless person': { min: 1,  bad: ['Loitering'] },
    'junkie':          { min: 1,  bad: ['Loitering', 'Muscular'] },
    'young man':       { min: 10 },
    'young woman':     { min: 10, good: ['On phone'] },
    'student':         { min: 10, good: ['On phone'], bad: ['Athletic'] },
    'classy lady':     { min: 10, good: ['Heavyset'], bad: ['Skinny', 'Average'] },
    'laborer':         { min: 10, bad: ['Distracted'] },
    'postal worker':   { min: 10, good: ['Walking'] },
    'rich kid':        { min: 40, good: ['Walking', 'Skinny', 'Heavyset'] },
    'sex worker':      { min: 40, good: ['On phone'] },
    'thug':            { min: 40, good: ['Running'], bad: ['Muscular'] },
    'businessman':     { min: 65, bad: ['Walking', 'Skinny'] },
    'businesswoman':   { min: 65, bad: ['Walking', 'Heavyset'] },
    'gang member':     { min: 65, bad: ['Muscular'] },
    'jogger':          { min: 65, good: ['Walking'] },
    'mobster':         { min: 101 },  // "Avoid entirely, ideally."
    'cyclist':         { min: 80 },
    'police officer':  { cop: true },
  };

  const q = (root, sel) => root.querySelector(sel);

  function crimeSkill() {
    const el = document.querySelector('[aria-label^="Crime skill:"]');
    const m = el && /Crime skill:\s*([\d.]+)/.exec(el.getAttribute('aria-label'));
    return m ? parseFloat(m[1]) : null;
  }

  // Returns the strip colour and the tag text: the activity and, when they
  // matter, the build, each marked ▲ (helps) or ▼ (hurts).
  function verdict(mark, activity, build, skill) {
    const act = activity.toLowerCase();
    if (mark.cop) return { color: PURPLE, tag: [act, 'avoid'].filter(Boolean).join(' · ') };
    if (mark.min > 100) return { color: RED, tag: [act, 'avoid'].filter(Boolean).join(' · ') };
    // Below the guide's level by up to 15 skill: amber; further: red.
    const gap = skill == null ? 0 : skill - mark.min;
    let level = gap >= 0 ? 2 : gap >= -15 ? 1 : 0;
    const score = (x) => (mark.bad || []).includes(x) ? -1 : (mark.good || []).includes(x) ? 1 : 0;
    let actScore = score(activity);
    const buildScore = score(build);
    if (!actScore && !buildScore && OBLIVIOUS.includes(activity)) actScore = 1;
    if (actScore < 0 || buildScore < 0) level = Math.max(0, level - 1);
    else if (actScore > 0 || buildScore > 0) level = Math.min(2, level + 1);
    const mark1 = (n) => (n > 0 ? ' ▲' : n < 0 ? ' ▼' : '');
    const parts = [];
    if (act) parts.push(act + mark1(actScore));
    if (buildScore) parts.push(build.toLowerCase() + mark1(buildScore));
    return { color: LEVEL_COLORS[level], tag: parts.join(' · ') };
  }

  function paint(option, skill) {
    const title = q(option, '[class*="titleAndProps___"]');
    const nameEl = title && title.firstElementChild;
    if (!nameEl) return;
    const name = nameEl.textContent.trim();
    const mark = MARKS[name.toLowerCase()];
    const icon = q(option, '[class*="activity___"] [class*="icon___"]');
    const offset = icon ? String(parseInt(icon.style.backgroundPositionY, 10)) : '';
    const activity = ACTIVITY_BY_OFFSET[offset] || '';
    const buildEl = q(title, '[class*="physicalProps___"] [aria-hidden="true"]');
    const build = buildEl ? buildEl.textContent.trim().split(' ')[0] : '';
    const locked = option.classList.contains('crime-option-locked');

    // Rows are recycled by Torn's virtual list, so the result is keyed by
    // what is shown now, not by the row.
    const key = [name, activity, build, skill, locked].join('|');
    let tag = q(title, '.tpp-tag');
    if (option.getAttribute('data-tpp') === key && tag) return;
    option.setAttribute('data-tpp', key);
    if (!mark) {
      option.style.removeProperty('box-shadow');
      if (tag) tag.remove();
      return;
    }
    const v = verdict(mark, activity, build, skill);
    option.style.setProperty('box-shadow', `inset 4px 0 0 ${locked ? '#666' : v.color}`, 'important');
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'tpp-tag';
      nameEl.after(tag);
    }
    tag.style.color = locked ? '#888' : v.color;
    tag.textContent = v.tag;
  }

  function injectStyles() {
    if (document.getElementById('tpp-styles')) return;
    const st = document.createElement('style');
    st.id = 'tpp-styles';
    st.textContent = `
      .tpp-tag { display: block; font-size: 10px; line-height: 12px; font-weight: bold; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  function onPickpocketing() {
    return /pickpocketing/.test(location.hash);
  }

  function scan() {
    if (!onPickpocketing()) return;
    const skill = crimeSkill();
    document.querySelectorAll('.crime-option').forEach((o) => paint(o, skill));
  }

  let queued = false;
  function kick() {
    if (queued || document.hidden || !onPickpocketing()) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }

  function start() {
    if (!document.body) return setTimeout(start, 200);
    injectStyles();
    // The activity icon changes through its style attribute; our own writes
    // (data-tpp, style on the row, the tag) settle because paint() skips
    // rows whose key hasn't changed.
    new MutationObserver(kick).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'aria-label'],
    });
    window.addEventListener('hashchange', kick);
    document.addEventListener('visibilitychange', kick);
    kick();
  }
  start();
})();
