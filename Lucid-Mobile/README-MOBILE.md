# Lucid — Mobile (User Script)

The desktop extension's logic, bundled as a single user script so it runs in
phone browsers that don't support real extensions.

**File:** `Lucid.user.js` (auto-generated from the desktop `Lucid/` source —
`fixer-core.js` + `content.js` — never edit by hand, rebuild with
`node build-userscript.js`). Build script lives here in `Lucid-Mobile/` and
reads the sources from `../Lucid/`, so the phone build can never drift from
the desktop extension.

---

## Android

**Option A — Tampermonkey (recommended):**
1. Install [Tampermonkey](https://play.google.com/store/apps/details?id=net.tampermonkey.droid) from the Play Store (works in Chrome/Firefox/any browser).
2. Open `Lucid.user.js` in the browser (or install via Tampermonkey's dashboard → Utilities → Import).
3. Open DreamJourney — Lucid runs automatically.

**Option B — Kiwi Browser (real extension, zero porting):**
1. Install [Kiwi Browser](https://play.google.com/store/apps/details?id=com.kiwibrowser.browser.next).
2. `chrome://extensions` → enable Developer mode → Load unpacked → select the
   **desktop extension folder** (`Lucid/` — works as-is on Android).
3. Same behavior as desktop: auto-fix + per-message wand button.

## iPhone / iPad (Safari)

iOS doesn't let any browser run real extensions (Apple requires WebKit).
User scripts via a Safari manager are the only path:

1. Install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) from the App Store (free) — or Tampermonkey's iOS build.
2. Enable the Userscripts extension in Settings → Safari → Extensions → allow it.
3. Open `Lucid.user.js` in Safari → "Install" → it registers for dreamjourneyai.com.
4. Open DreamJourney — Lucid runs.

> iPhone note: Tampermonkey iOS historically required the desktop Safari
> extension companion; Userscripts is the more reliable free route. Both use
> the same file — localStorage fallback keeps settings working even without
> GM_* storage.

---

## What's bundled

- Full thinking-block repair: missing ``` fences, missing/swapped/typo'd
  `<thinking>`/`</thinking>` tags, single-tag-missing with fence-boundary
  detection, tagless-but-fenced blocks, stray inner fences, fused fences,
  bare tags with no fence (adds the wrapper DJ needs), smart-quote
  normalization, `[BRAIN]`-style junk markers.
- Per-message **wand button** — tap to check or fix any message manually.
- **Empty-send continue** — send with the box empty to nudge the bot to keep
  writing (same ZWS trick as desktop).
- Settings default ON (no popup on mobile): empty-send continue enabled.

## Caveats

- On small screens the wand button is sized to the bookmark button, so it
  stays aligned; hover feedback becomes tap feedback (purple wash).
- The React-safe edit-dialog path is used everywhere — the same protection
  that prevents DJ crashes on desktop applies on mobile.
- Tested headless (storage shim, normalizer, chrome-preservation); the DOM
  selectors are shared with the desktop extension, which is battle-tested.

## Rebuild

```bash
node build-userscript.js   # regenerates Lucid.user.js
```