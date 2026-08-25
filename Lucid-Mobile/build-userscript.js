/* Build script: assembles Lucid.user.js (mobile userscript) from the desktop
   extension's source files. Reads ../Lucid/{fixer-core.js,content.js} so the
   phone build and the desktop extension share the exact same logic and can
   never drift apart.
   Usage: node build-userscript.js  (run from Lucid-Mobile/)
   Output: Lucid.user.js in this directory. */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const desktop = path.join(root, '..', 'Lucid');
const core = fs.readFileSync(path.join(desktop, 'fixer-core.js'), 'utf8');
const content = fs.readFileSync(path.join(desktop, 'content.js'), 'utf8');

const header = `// ==UserScript==
// @name         Lucid (Mobile)
// @namespace    lucid-mobile
// @version      1.7.0
// @description  Mends DreamJourney thinking blocks on phones: broken fences, missing/swapped/typo'd thinking tags, plus a per-message fix button and empty-send continue. Desktop-extension logic bundled as a user script.
// @author       Nyveria
// @match        https://dreamjourneyai.com/app/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// ==/UserScript==

/* ═══════════════════════════════════════════════════════════════
   LUCID — MOBILE USER SCRIPT (auto-generated)
   Bundles fixer-core.js + content.js from the desktop extension so
   behavior stays identical. The only additions:
     1) chrome.* shims (GM_* / localStorage fallback)
     2) runtime.onMessage becomes a no-op-safe stub (popup toggles
        don't exist on mobile — settings default to ON)
   Rebuild with: node build-userscript.js
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── chrome.* shim ──
  // Prefer GM_* (Tampermonkey/Violentmonkey); fall back to localStorage
  // (Userscripts on iOS has no GM storage in some versions).
  function gmHas() {
    try { return typeof GM_getValue === 'function'; } catch { return false; }
  }
  function lsGet(key) { try { const v = localStorage.getItem('lucid:' + key); return v ? JSON.parse(v) : undefined; } catch { return undefined; } }
  function lsSet(key, val) { try { localStorage.setItem('lucid:' + key, JSON.stringify(val)); } catch {} }

  const storage = {
    local: {
      get(keys, cb) {
        const res = {};
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) {
          const v = gmHas() ? GM_getValue(k) : lsGet(k);
          if (v !== undefined) res[k] = v;
        }
        if (cb) cb(res);
      },
      set(items, cb) {
        for (const [k, v] of Object.entries(items)) {
          if (gmHas()) GM_setValue(k, v); else lsSet(k, v);
        }
        if (cb) cb();
      },
    },
  };

  // No-op runtime stub — the mobile build has no popup.
  const runtime = {
    onMessage: { addListener() {} },
    lastError: undefined,
  };

  const chrome = { storage, runtime };
  if (typeof window !== 'undefined') {
    const hostHasRuntime = !!(window.chrome && window.chrome.runtime && window.chrome.storage);
    if (!hostHasRuntime) {
      try {
        Object.defineProperty(window, 'chrome', { value: chrome, configurable: true, writable: true });
      } catch (e) {
        try { window.chrome = chrome; } catch (e2) { /* page frozen — content.js guards its own use */ }
      }
    }
  }
`;

const footer = `
})();
`;

const bundle = header + core + '\n' + content + footer;

fs.writeFileSync(path.join(root, 'Lucid.user.js'), bundle, 'utf8');
console.log('Wrote Lucid.user.js (' + (bundle.length / 1024).toFixed(1) + ' KB)');