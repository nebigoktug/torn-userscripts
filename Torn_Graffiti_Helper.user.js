// ==UserScript==
// @name         Torn Graffiti Helper
// @namespace    https://greasyfork.org/users/nebigoktug
// @version      1.2.2
// @description  Adds rep progress, colour suggestions and crew/CS100 targets directly into Torn's graffiti page. Read-only, no automation.
// @author       NebiGoktug
// @license      MIT
// @match        https://www.torn.com/page.php?sid=crimes*
// @icon         https://www.torn.com/favicon.ico
// @run-at       document-idle
// @grant        none
// @downloadURL https://update.greasyfork.org/scripts/587425/Torn%20Graffiti%20Helper.user.js
// @updateURL https://update.greasyfork.org/scripts/587425/Torn%20Graffiti%20Helper.meta.js
// ==/UserScript==

/*
 * Torn Graffiti Helper
 *
 * Torn shows your graffiti stats across a collapsed carousel, and never tells
 * you how far the next reputation tier is. This puts that where you need it.
 *
 * Adds:
 *   - A strip above the location list: skill, enhancer, nerve, current goal
 *   - Per-card badge: tags remaining to the next reputation tier
 *   - Per-card colour suggestion, toggled between rep and cash
 *
 * Colour suggestions come from Emforus' graffiti guide (Torn forums thread
 * 16344567, built from ~32k logs). The author's own caveat applies: the
 * sample is small and he does not recommend treating it as a rule. Badges
 * are a hint, not an instruction.
 *
 * This script only reads the page. It never clicks, submits, or automates
 * anything — that would be against Torn's rules.
 *
 * MIT licensed.
 */

(function () {
  'use strict';

  /* Only the crimes hub can show graffiti, and moving between crimes there is
     hash-only, so nothing else ever needs the observer. Also guards against
     Torn PDA injecting on any URL that merely contains "torn". */
  if (!/^(www\.)?torn\.com$/i.test(location.hostname) ||
      !/\/page\.php$/i.test(location.pathname) || !/sid=crimes/i.test(location.search)) return;
  /* Torn PDA can inject the script again on in-page navigation. Each copy
     would add its own whole-page observer, and the page slows down the longer
     PDA stays open. Run once. */
  if (window.__tghRunning) return;
  window.__tghRunning = true;

  const STORE_KEY = 'nb_graffiti_v2';
  const NERVE_PER_ATTEMPT = 3;
  const REP_TIERS = [25, 50, 100, 250, 500];

  /* What unlocks at each crime skill level, for the "coming up" hint. */
  const CS_GATES = [
    [15, 'Ladder'], [25, 'Wire Cutters'], [35, 'Paint Mask'],
    [50, 'Residential + Red-Light'], [70, 'Crew unique'],
    [95, 'Points'], [100, 'Final unique'],
  ];

  /* Emforus' guide. Low confidence — see header comment. */
  const COLOUR_HINT = {
    'East Side': { cash: 'purple', rep: 'red' },
    'West Side': { cash: 'green', rep: 'blue' },
    'North Side': { cash: 'green', rep: 'orange' },
    'Residential': { cash: 'white', rep: 'blue' },
    'Red-Light': { cash: 'green', rep: 'pink' },
    'Financial': { cash: 'black', rep: 'red' },
    'City Center': { cash: 'green', rep: 'blue' },
  };

  /* Cards are identified by their image filename rather than their label, so
     the script survives wording changes. Torn's naming isn't fully consistent
     (City Center ships as CentreCity.jpg), so match on a prefix and fall back
     to the visible title if the filename is one we haven't seen. */
  const LOCATION_BY_IMAGE = [
    [/EastSide/i, 'East Side'],
    [/WestSide/i, 'West Side'],
    [/NorthSide/i, 'North Side'],
    // Torn ships this as ResidentalDistrict.jpg — a typo. Match both spellings.
    [/Resident[ai]l/i, 'Residential'],
    [/RedLight|Red-Light/i, 'Red-Light'],
    [/Financial/i, 'Financial'],
    [/CentreCity|CityCentre|CityCenter/i, 'City Center'],
  ];

  const LOCATION_BY_TITLE = [
    [/east/i, 'East Side'], [/west/i, 'West Side'], [/north/i, 'North Side'],
    [/residential/i, 'Residential'], [/red[-\s]?light/i, 'Red-Light'],
    [/financial/i, 'Financial'], [/city\s*cent/i, 'City Center'],
  ];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = (el) => el?.textContent?.replace(/\s+/g, ' ').trim() || '';
  const int = (v) => { const m = String(v).replace(/,/g, '').match(/\d+/); return m ? +m[0] : null; };
  const onGraffitiPage = () => /sid=crimes/i.test(location.href) && /graffiti/i.test(location.hash);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // --------------------------------------------------------------- storage

  const load = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } };
  const save = (data) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch {} };
  const getMode = () => load().mode || 'rep';
  const setMode = (mode) => { const d = load(); d.mode = mode; save(d); };

  // --------------------------------------------------------------- reading

  /* Torn's stats carousel is removed from the DOM while collapsed, so we
     cache what we read. Without this, a collapsed panel would look like a
     missing Paint Mask. */
  const readStats = () => {
    const stats = { ...(load().stats || {}) };
    let found = false;

    $$('li[class*="statistic" i] button[aria-label]').forEach((btn) => {
      const label = btn.getAttribute('aria-label') || '';
      let m;
      if ((m = label.match(/^Skill:\s*([\d.]+)/i))) { stats.skill = parseFloat(m[1]); found = true; }
      if ((m = label.match(/^Enhancer:\s*(.+)/i))) { stats.enhancer = m[1].trim(); found = true; }
      if ((m = label.match(/^Unique outcomes:\s*(\d+)\s*\/\s*(\d+)/i))) {
        stats.uniques = +m[1]; stats.uniquesTotal = +m[2]; found = true;
      }
      if ((m = label.match(/^Spray Paint\s*:\s*(\w+):\s*(\d+)/i))) {
        stats.cans = stats.cans || {};
        stats.cans[m[1].toLowerCase()] = +m[2];
        found = true;
      }
    });

    if (found) { const d = load(); d.stats = stats; save(d); }
    return stats;
  };

  const readNerve = () => {
    for (const el of $$('[class*="nerve" i], [id*="nerve" i]')) {
      const m = text(el).match(/(\d+)\s*\/\s*(\d+)/);
      if (m) return { current: +m[1], max: +m[2] };
    }
    return null;
  };

  const readCard = (card) => {
    const srcset = $('[class*="crimeOptionImage" i] img', card)?.getAttribute('srcset') || '';
    const file = srcset.match(/\/([\w-]+)\.jpg/)?.[1] || '';

    let name = LOCATION_BY_IMAGE.find(([re]) => re.test(file))?.[1];

    // Fallback: if Torn ships a filename we don't recognise, read the title.
    if (!name) {
      const title = text($('[class*="tabletTitleAndTagCount" i]', card));
      name = LOCATION_BY_TITLE.find(([re]) => re.test(title))?.[1];
    }
    if (!name) return null;

    const rep = $('[aria-label*="Reputation" i]', card)
      ?.getAttribute('aria-label')?.match(/Reputation\s+(\d+)\s+out of/i);

    // e.g. "Pink spray selected, 85% left. Click to change"
    const spray = $('[class*="sprayCanButton" i][aria-label]', card)
      ?.getAttribute('aria-label')?.match(/(\w+)\s+spray selected,\s*(\d+)%\s*left/i);

    return {
      name,
      locked: /locked/i.test(card.className),
      // Read only Torn's own text; strip any badge we may have added nearby.
      tags: int(text($('[class*="tagsCount" i]', card))?.replace(/\+\d+\u2192\d+|MAX/g, '')),
      stars: rep ? +rep[1] : null,
      colour: spray ? spray[1].toLowerCase() : null,
      paint: spray ? +spray[2] : null,
    };
  };

  const tagsToNextTier = (tags) => {
    if (tags == null) return null;
    const tier = REP_TIERS.find((t) => tags < t);
    return tier ? { tier, remaining: tier - tags } : null;
  };

  // ---------------------------------------------------------------- styles

  const STYLES = `
  .gh-badge {
    display:inline-block; margin-left:5px; padding:0 3px; border-radius:2px;
    font:9px/13px ui-monospace,Menlo,monospace; vertical-align:middle;
    background:rgba(255,255,255,.07); color:#8a8; white-space:nowrap;
  }
  .gh-badge.close { color:#dd8; background:rgba(220,220,80,.12); }
  .gh-badge.done  { color:#6a6; }
  .gh-colour {
    display:inline-block; margin-left:3px; padding:0 3px; border-radius:2px;
    font:9px/13px ui-monospace,monospace; vertical-align:middle; white-space:nowrap;
  }
  .gh-colour.good    { color:#8c8; }
  .gh-colour.suggest { color:#e94; background:rgba(230,150,60,.12); }
  .gh-colour.nostock { color:#c66; background:rgba(200,80,80,.12); }
  .gh-strip {
    display:flex; gap:2px 7px; align-items:center; padding:4px 7px; margin:0 0 2px;
    background:linear-gradient(#1a1a1a,#141414); border:1px solid #2a2a2a;
    border-radius:3px; font:10px/1.3 ui-monospace,Menlo,monospace; color:#999;
    overflow-x:auto; white-space:nowrap; scrollbar-width:none;
  }
  .gh-strip::-webkit-scrollbar { display:none; }
  .gh-strip > * { flex:none; }
  .gh-strip .dim { color:#666; }
  .gh-strip .val { color:#bbb; }
  .gh-strip .goal { color:#9d9; }
  .gh-strip .alert { color:#fa6; }
  .gh-strip .good { color:#6a6; }
  .gh-strip .div { color:#333; }
  .gh-toggle {
    cursor:pointer; user-select:none; padding:1px 5px; border-radius:2px;
    border:1px solid #3a4a3a; background:#1e2a1e; color:#9d9;
  }
  `;

  // -------------------------------------------------------------- painting

  /* Badges are placed inline next to existing elements. Torn's list is
     virtualised with JS-computed row heights, so anything added to a card's
     flow would break the layout.
     Each badge is only touched when its text actually changes — rewriting
     identical nodes would wake the observer for nothing. */
  const setBadge = (parent, className, content, title) => {
    let el = $(`:scope > .${className.split(' ')[0]}`, parent);
    if (content == null) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('span');
      parent.appendChild(el);
    }
    if (el.className !== className) el.className = className;
    if (el.textContent !== content) el.textContent = content;
    if (title && el.title !== title) el.title = title;
  };

  const paintCard = (cardEl, stats, mode) => {
    const card = readCard(cardEl);
    if (!card) return;

    const tagsEl = $('[class*="tagsCount" i]', cardEl);
    if (tagsEl) {
      /* The badge goes next to tagsCount, never inside it. Writing into the
         element we also read from would make readCard parse our own output
         and make every write look like a foreign mutation. */
      const host = tagsEl.parentElement || tagsEl;
      if (card.locked) {
        setBadge(host, 'gh-badge', null);
      } else {
        const next = tagsToNextTier(card.tags);
        setBadge(
          host,
          'gh-badge' + (next && next.remaining <= 25 ? ' close' : next ? '' : ' done'),
          next ? `+${next.remaining}\u2192${next.tier}` : 'MAX'
        );
      }
    }

    const starsEl = $('[class*="reputationIconWrapper" i]', cardEl);
    const hint = COLOUR_HINT[card.name];
    if (!starsEl) return;

    if (!hint || card.locked || !card.colour) {
      setBadge(starsEl, 'gh-colour', null);
      return;
    }

    const wanted = hint[mode];
    // null = not known yet (the stats carousel hasn't been seen open), which is
    // not the same as having none.
    const stock = stats.cans ? (stats.cans[wanted] ?? 0) : null;

    if (card.colour === wanted) {
      setBadge(starsEl, 'gh-colour good', '\u2713',
        `Already using the suggested ${mode} colour (Emforus, low confidence)`);
    } else if (stock === 0) {
      // No point suggesting a colour the player doesn't have.
      setBadge(starsEl, 'gh-colour nostock', `${wanted}?`,
        `${wanted} suggested for ${mode}, but you have none`);
    } else {
      setBadge(starsEl, 'gh-colour suggest', `\u2192${wanted}`,
        `Emforus suggests ${wanted} for ${mode} here (low confidence).` +
        (stock == null ? ' Open the stats panel once to see your stock.' : ` You have ${stock}.`));
    }
  };

  const buildStrip = (stats, cards, nerve, mode) => {
    const parts = [];
    const cs = stats.skill;

    if (cs != null) parts.push(`<span class="dim">CS</span> <span class="val">${cs}</span>`);

    // Torn reports this as "Paint Mask, owned", so match loosely.
    if (/paint mask/i.test(stats.enhancer || '')) parts.push('<span class="good">mask</span>');
    else if (stats.enhancer) parts.push(`<span class="alert">${esc(stats.enhancer)}</span>`);

    if (nerve) {
      const attempts = Math.floor(nerve.current / NERVE_PER_ATTEMPT);
      parts.push(`<span class="dim">n</span><span class="${attempts ? 'val' : 'alert'}">${nerve.current}</span><span class="dim">=${attempts}x</span>`);
    }
    if (stats.uniques != null) {
      parts.push(`<span class="dim">u</span><span class="val">${stats.uniques}/${stats.uniquesTotal || 41}</span>`);
    }

    // One goal only: crew if you don't have it, otherwise CS100.
    const unlocked = cards.filter((c) => !c.locked && c.tags != null);
    const inCrew = cards.some((c) => c.name === 'City Center' && !c.locked);
    if (!inCrew && unlocked.length) {
      const closest = [...unlocked].sort((a, b) => b.tags - a.tags)[0];
      const short = Math.max(0, 500 - closest.tags);
      if (short === 0 && cs != null && cs >= 70) {
        parts.push(`<span class="goal">${closest.name} R5* \u2192 unique</span>`);
      } else if (cs != null && cs < 70) {
        parts.push(`<span class="goal">crew: CS+${(70 - cs).toFixed(2)} \u00b7 ${closest.name}+${short}</span>`);
      } else {
        parts.push(`<span class="goal">crew: ${closest.name}+${short}</span>`);
      }
    } else if (cs != null && cs < 100) {
      parts.push(`<span class="goal">CS100 +${(100 - cs).toFixed(2)}</span>`);
    }

    if (cs != null) {
      const gate = CS_GATES.find(([lvl]) => lvl > cs && lvl - cs <= 3);
      if (gate) parts.push(`<span class="dim">CS${gate[0]}:</span> <span class="val">${gate[1]}</span>`);
    }

    const alerts = [];
    cards.filter((c) => !c.locked && c.paint != null && c.paint <= 15).forEach((c) => {
      const spare = stats.cans?.[c.colour];
      alerts.push(`${c.name.split(' ')[0]} ${c.colour} ${c.paint}%${spare === 0 ? ' (no spare)' : ''}`);
    });
    if (stats.cans) {
      const inUse = [...new Set(cards.filter((c) => !c.locked && c.colour).map((c) => c.colour))];
      const empty = inUse.filter((c) => (stats.cans[c] ?? 0) === 0);
      if (empty.length) alerts.push(`out: ${empty.join(',')}`);
    }
    if (alerts.length) parts.push(`<span class="alert">${alerts.join(' \u00b7 ')}</span>`);

    return `<span class="gh-toggle" id="gh-toggle">${mode}</span><span class="div">|</span>`
      + parts.join('<span class="div">|</span>');
  };

  // ------------------------------------------------------------------ run

  let stylesAdded = false;
  let observer = null;
  let writing = false;

  /* Everything this script injects is tagged, so the observer can tell its
     own writes apart from Torn's. Without this the observer sees render()'s
     output, fires again, and the script rewrites the DOM forever. */
  /* Recognises our own injected nodes — including text nodes inside a badge,
     since setBadge rewrites those and the observer reports them by node. */
  const isOurs = (node) => {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!el && (
      el.classList?.contains('gh-strip') ||
      el.classList?.contains('gh-badge') ||
      el.classList?.contains('gh-colour') ||
      !!el.closest?.('.gh-strip')
    );
  };

  let queued = false;
  /* True if a batch contains anything Torn changed, as opposed to only our
     own badges. Torn updates counters by swapping text nodes, so we can't
     restrict this to elements — we check what the mutation happened *inside*
     instead, and only ignore it when that's one of our own badges. */
  const hasForeignMutation = (mutations) => mutations.some((m) => {
    if (m.type === 'characterData') return !isOurs(m.target.parentElement);
    if (m.type === 'attributes') return !isOurs(m.target);
    const touched = [...m.addedNodes, ...m.removedNodes];
    // Adding or removing only our own badges is not a foreign change.
    if (touched.length && touched.every(isOurs)) return false;
    // Anything inside one of our badges is ours too.
    return !isOurs(m.target);
  });

  const render = () => {
    if (!onGraffitiPage()) {
      const stale = $$('.gh-strip');
      if (stale.length) {
        writing = true;
        stale.forEach((el) => el.remove());
        observer?.takeRecords();
        writing = false;
      }
      return;
    }

    if (!stylesAdded) {
      const el = document.createElement('style');
      el.textContent = STYLES;
      document.head.appendChild(el);
      stylesAdded = true;
    }

    const cardEls = $$('[class*="crimeOption___" i]');
    if (!cardEls.length) return;

    const stats = readStats();
    const cards = cardEls.map(readCard).filter(Boolean);
    const nerve = readNerve();
    const mode = getMode();

    // Pause observation for the duration of the write.
    writing = true;
    try {
      cardEls.forEach((el) => paintCard(el, stats, mode));

      const list = cardEls[0].closest('[class*="virtualItem" i]')?.parentElement;
      const container = list?.parentElement;
      if (!container) return;

      let strip = $(':scope > .gh-strip', container);
      if (!strip) {
        strip = document.createElement('div');
        strip.className = 'gh-strip';
        container.insertBefore(strip, list);
      }

      const html = buildStrip(stats, cards, nerve, mode);
      if (strip.innerHTML !== html) {
        strip.innerHTML = html;
        $('#gh-toggle', strip).addEventListener('click', (e) => {
          e.stopPropagation();
          setMode(getMode() === 'rep' ? 'cash' : 'rep');
          render();
        });
      }
    } finally {
      /* Drain the records our own writes produced. This is deterministic —
         unlike a timer, it can't race the observer's microtask queue.
         Torn may have changed something in the same tick, so re-queue if the
         drained batch contains anything that wasn't ours. */
      const drained = observer?.takeRecords() || [];
      writing = false;
      if (drained.length && !queued && hasForeignMutation(drained)) scheduleRender(drained);
    }
  };

  /* `mutations` is null for a forced render (hash change), which must not be
     filtered out as "nothing foreign happened". */
  const scheduleRender = (mutations) => {
    if (writing || queued) return;
    // Torn's timers change text every second all over the page: ignore them in
    // a background tab, and on other crimes once nothing of ours is left.
    if (mutations && (document.hidden || (!onGraffitiPage() && !document.querySelector('.gh-strip')))) return;
    if (mutations && !hasForeignMutation(mutations)) return;

    queued = true;
    setTimeout(() => {
      queued = false;
      try { render(); } catch (err) { console.warn('[graffiti-helper]', err); }
    }, 400);
  };

  const start = () => {
    if (!document.body) return setTimeout(start, 300);
    render();
    observer = new MutationObserver(scheduleRender);
    /* characterData matters: Torn updates tag counts and spray percentages by
       rewriting text in place, which produces no childList mutation. */
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });

    // Moving between crimes only changes the hash: listen instead of polling.
    window.addEventListener('hashchange', () => scheduleRender(null));
    window.addEventListener('popstate', () => scheduleRender(null));
    // Catch up after the tab was in the background.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(null); });
  };

  start();
})();
