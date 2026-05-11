// ==UserScript==
// @name         XXXX website Stale-Follower Remover
// @namespace    https://github.com/coombeseo/twitter-follower-remover
// @version      0.1.0
// @description  Conservatively remove followers from your /followers list. Dry-run by default. Pacing 60–120s.
// @match        https://exmple.com/*/followers
// @match        https://exmple.com/*/followers/*
// @match        https://twitter.com/*/followers
// @match        https://twitter.com/*/followers/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// not respsible if you get banned
// run with tamper monkey chrom addon
// dont fuck with the cadence


(function () {
  'use strict';

  // ---------- config ----------
  const MIN_DELAY_MS = 60_000;
  const MAX_DELAY_MS = 120_000;
  const SCROLL_SETTLE_MS = 1_500;
  const MAX_EMPTY_SCROLLS = 3;
  const HARD_CAP = 100;

  // ---------- state ----------
  const processed = new Set();
  let running = false;
  let stopRequested = false;
  let removedCount = 0;
  let targetN = 25;
  let dryRun = true;
  let startScrollY = 0;
  let panel = null;
  let statusEl = null;
  let countEl = null;
  let lastEl = null;

  // ---------- utils ----------
  const rand = (a, b) => a + Math.random() * (b - a);
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (stopRequested) return reject(new Error('stopped'));
        if (Date.now() - start >= ms) return resolve();
        setTimeout(tick, Math.min(250, ms - (Date.now() - start)));
      };
      tick();
    });

  const waitFor = async (predicate, { timeout = 5000, interval = 100 } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopRequested) throw new Error('stopped');
      const v = predicate();
      if (v) return v;
      await new Promise((r) => setTimeout(r, interval));
    }
    return null;
  };

  const setStatus = (s) => {
    if (statusEl) statusEl.textContent = s;
    console.log('[follower-remover]', s);
  };
  const setCount = () => {
    if (countEl) countEl.textContent = `${removedCount}/${targetN}`;
  };
  const setLast = (h) => {
    if (lastEl) lastEl.textContent = h ? `last: ${h}` : '';
  };

  // ---------- self-handle detection ----------
  const getSelfHandle = () => {
    const a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    if (!a) return null;
    const m = a.getAttribute('href')?.match(/^\/([^\/?#]+)/);
    return m ? '@' + m[1].toLowerCase() : null;
  };

  // ---------- DOM probes ----------
  const getCells = () =>
    Array.from(document.querySelectorAll('[data-testid="UserCell"]'));

  const handleFromCell = (cell) => {
    // First span text starting with "@" wins. Falls back to parsing the avatar link.
    const spans = cell.querySelectorAll('span');
    for (const s of spans) {
      const t = s.textContent?.trim();
      if (t && t.startsWith('@') && !t.includes(' ')) return t.toLowerCase();
    }
    const a = cell.querySelector('a[href^="/"]');
    const m = a?.getAttribute('href')?.match(/^\/([^\/?#]+)/);
    return m ? '@' + m[1].toLowerCase() : null;
  };

  const moreButtonInCell = (cell) =>
    cell.querySelector('[data-testid="userActions"]') ||
    cell.querySelector('button[aria-haspopup="menu"]') ||
    Array.from(cell.querySelectorAll('button')).find((b) =>
      /more/i.test(b.getAttribute('aria-label') || '')
    ) ||
    null;

  const findMenuItem = () => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    for (const it of items) {
      const txt = (it.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (txt.includes('remove') && txt.includes('follower')) return it;
    }
    if (items.length) {
      console.log(
        '[follower-remover] no remove-follower match. menu items present:',
        items.map((it) => (it.textContent || '').trim())
      );
    }
    return null;
  };

  const findConfirmButton = () =>
    document.querySelector('[data-testid="confirmationSheetConfirm"]');

  const closeAnyMenu = () => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  };

  // ---------- core action ----------
  const removeOnCell = async (cell) => {
    const handle = handleFromCell(cell);
    if (!handle) return { ok: false, reason: 'no-handle' };
    if (processed.has(handle)) return { ok: false, reason: 'already-processed' };

    const self = getSelfHandle();
    if (self && handle === self) {
      processed.add(handle);
      return { ok: false, reason: 'self', handle };
    }

    const moreBtn = moreButtonInCell(cell);
    if (!moreBtn) return { ok: false, reason: 'no-more-button', handle };

    cell.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    await sleep(rand(150, 350));
    moreBtn.click();
    await sleep(rand(250, 700));

    const item = await waitFor(findMenuItem, { timeout: 4000 });
    if (!item) {
      closeAnyMenu();
      return { ok: false, reason: 'menu-item-not-found', handle };
    }

    if (dryRun) {
      console.log(`[DRY] would remove ${handle}`);
      closeAnyMenu();
      processed.add(handle);
      return { ok: true, handle, dry: true };
    }

    item.click();
    await sleep(rand(200, 500));
    const confirm = await waitFor(findConfirmButton, { timeout: 4000 });
    if (!confirm) {
      closeAnyMenu();
      return { ok: false, reason: 'confirm-not-found', handle };
    }
    confirm.click();
    processed.add(handle);
    return { ok: true, handle, dry: false };
  };

  const findNextCell = () => {
    // Never go above where we started, and never back up past the current floor.
    const floorY = Math.max(startScrollY, window.scrollY);
    for (const cell of getCells()) {
      const h = handleFromCell(cell);
      if (!h || processed.has(h)) continue;
      const absTop = cell.getBoundingClientRect().top + window.scrollY;
      if (absTop < floorY) continue;
      return cell;
    }
    return null;
  };

  const scrollForward = () => {
    window.scrollBy({ top: Math.floor(window.innerHeight * 0.8), behavior: 'instant' });
  };

  // ---------- main loop ----------
  const run = async () => {
    if (running) return;
    if (targetN > HARD_CAP) {
      if (!confirm(`N=${targetN} exceeds hard cap of ${HARD_CAP}. Continue anyway?`)) return;
    }
    running = true;
    stopRequested = false;
    removedCount = 0;
    processed.clear();
    startScrollY = window.scrollY;
    setCount();
    setLast('');
    setStatus(dryRun ? 'starting (DRY-RUN)' : 'starting (LIVE)');

    let emptyScrolls = 0;
    try {
      while (!stopRequested && removedCount < targetN) {
        let cell = findNextCell();
        if (!cell) {
          if (emptyScrolls >= MAX_EMPTY_SCROLLS) {
            setStatus('exhausted (no new followers visible)');
            break;
          }
          setStatus('scrolling for more rows');
          scrollForward();
          await sleep(SCROLL_SETTLE_MS);
          emptyScrolls += 1;
          continue;
        }
        emptyScrolls = 0;

        const handle = handleFromCell(cell);
        setStatus(`processing ${handle}`);
        const res = await removeOnCell(cell);

        if (res.ok) {
          removedCount += 1;
          setCount();
          setLast(`${res.dry ? '[dry] ' : ''}${res.handle}`);
        } else if (res.reason === 'self') {
          setStatus(`skipped self (${res.handle})`);
        } else {
          setStatus(`skip: ${res.reason}${res.handle ? ' on ' + res.handle : ''}`);
        }

        if (removedCount >= targetN) break;

        const wait = Math.round(rand(MIN_DELAY_MS, MAX_DELAY_MS));
        const until = Date.now() + wait;
        while (!stopRequested && Date.now() < until) {
          const left = Math.ceil((until - Date.now()) / 1000);
          setStatus(`waiting ${left}s before next`);
          await sleep(Math.min(1000, until - Date.now()));
        }
      }
      if (!stopRequested) setStatus(`done · ${removedCount}/${targetN}`);
      else setStatus(`stopped · ${removedCount}/${targetN}`);
    } catch (e) {
      if (e.message === 'stopped') setStatus(`stopped · ${removedCount}/${targetN}`);
      else setStatus('error: ' + e.message);
    } finally {
      running = false;
      stopRequested = false;
    }
  };

  const stop = () => {
    if (!running) return;
    stopRequested = true;
    setStatus('stop requested');
  };

  // ---------- UI ----------
  const buildPanel = () => {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'tfr-panel';
    panel.style.cssText = `
      position: fixed; top: 12px; right: 12px; z-index: 2147483647;
      background: #15202b; color: #e7e9ea; border: 1px solid #38444d;
      border-radius: 10px; padding: 10px 12px; width: 240px;
      font: 12px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,0.45);
    `;
    panel.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;">Follower Remover</div>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <input type="checkbox" id="tfr-dry" checked /> Dry-run
      </label>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
        N: <input type="number" id="tfr-n" value="25" min="1" max="500"
          style="width:60px;background:#1d2733;color:#e7e9ea;border:1px solid #38444d;border-radius:4px;padding:2px 4px;" />
      </label>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button id="tfr-start" style="flex:1;background:#1d9bf0;color:#fff;border:0;border-radius:6px;padding:6px 0;cursor:pointer;">Start</button>
        <button id="tfr-stop"  style="flex:1;background:#3a3a3a;color:#fff;border:0;border-radius:6px;padding:6px 0;cursor:pointer;">Stop</button>
      </div>
      <div id="tfr-count" style="font-weight:600;">0/25</div>
      <div id="tfr-status" style="opacity:0.85;margin-top:2px;">idle</div>
      <div id="tfr-last"   style="opacity:0.7;margin-top:2px;font-size:11px;"></div>
    `;
    document.body.appendChild(panel);

    statusEl = panel.querySelector('#tfr-status');
    countEl  = panel.querySelector('#tfr-count');
    lastEl   = panel.querySelector('#tfr-last');

    panel.querySelector('#tfr-dry').addEventListener('change', (e) => {
      dryRun = e.target.checked;
    });
    panel.querySelector('#tfr-n').addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      if (Number.isFinite(v) && v > 0) targetN = v;
      setCount();
    });
    panel.querySelector('#tfr-start').addEventListener('click', () => run());
    panel.querySelector('#tfr-stop').addEventListener('click', () => stop());
  };

  const removePanel = () => {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = statusEl = countEl = lastEl = null;
  };

  const onFollowersPage = () => /\/followers(\/|$|\?)/.test(location.pathname + location.search);

  const sync = () => {
    if (onFollowersPage()) buildPanel();
    else removePanel();
  };

  // SPA navigation handling: exmple.com swaps routes without full reload.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sync();
    }
  }, 750);

  sync();

  // ---------- console helpers (for hot-reloading the script without losing scroll) ----------
  // Workflow:
  //   1) before editing the userscript: in console, run __tfr.bookmark()
  //   2) edit + save script in Tampermonkey
  //   3) reload the tab
  //   4) in console, run __tfr.resumeTo()  (auto-scrolls until bookmarked handle reappears)
  window.__tfr = {
    bookmark: () => {
      const cell = document.querySelector('[data-testid="UserCell"]');
      if (!cell) {
        console.log('[follower-remover] no UserCell in DOM');
        return null;
      }
      const h = handleFromCell(cell);
      if (!h) {
        console.log('[follower-remover] could not extract handle from top cell');
        return null;
      }
      localStorage.setItem('tfr-bookmark', h);
      console.log('[follower-remover] bookmarked', h);
      return h;
    },
    resumeTo: async (handle, { maxScrolls = 300 } = {}) => {
      handle = (handle || localStorage.getItem('tfr-bookmark') || '').toLowerCase();
      if (!handle) {
        console.log('[follower-remover] no bookmark to resume to');
        return null;
      }
      console.log('[follower-remover] scrolling to', handle);
      for (let i = 0; i < maxScrolls; i++) {
        const cell = getCells().find((c) => handleFromCell(c) === handle);
        if (cell) {
          cell.scrollIntoView({ block: 'center', behavior: 'instant' });
          await new Promise((r) => setTimeout(r, 400));
          console.log('[follower-remover] resumed to', handle);
          return cell;
        }
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.8) });
        await new Promise((r) => setTimeout(r, 700));
      }
      console.log('[follower-remover] not found within', maxScrolls, 'scrolls');
      return null;
    },
  };
})();
