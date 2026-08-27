# Changelog

All notable changes to **Lucid** (formerly *DJ Thinking Fixer*).

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Versions
are grouped newest-first.

---

## [1.10.4] — 2026-08-26

### Fixed
- **Copy preserved DreamJourney formatting.** The copy on Stop was rebuilding
  the message from the rendered DOM (`.markdown` text content), which collapsed
  whitespace and dropped the blank line before `Target:` / `Mode:` lines. Now it
  clicks DreamJourney's own **Copy user message** button so the **exact raw
  source** (blank lines included) lands on the clipboard. Falls back to the
  DOM-text copy only if the button isn't present.

## [1.10.3] — 2026-08-26

### Fixed
- **Post-refresh delete no longer stalls.** If the copied text didn't
  exact-match the fresh page's DOM (thinking block inside the user message,
  markdown whitespace drift), the delete gave up silently. It now falls back to
  deleting the **last user message** after a few failed matches — the flag is
  always armed for "the user's last message at Stop time".

## [1.10.2] — 2026-08-26

### Fixed
- **Toast overlap (take two).** Widened the vertical gap: the "Message copied"
  notice now renders at `bottom:200px`, the refresh countdown at `bottom:90px`,
  so they stack cleanly with a visible gap.

## [1.10.1] — 2026-08-26

### Fixed
- **Toast overlap.** The notice and the refresh countdown both sat at
  `bottom:90px` centered, so the copy toast covered the countdown. The notice
  moved to `bottom:150px` (above the countdown).

## [1.10] — 2026-08-26

### Added
- **Delete confirmation handling.** DreamJourney confirms message deletion with
  a "Delete Message?" dialog (Cancel / red Delete). After clicking a message's
  delete button, the extension now clicks the modal's **Delete** button too, so
  the post-refresh auto-delete actually completes.

## [1.9.2] — 2026-08-26

### Fixed
- **Delete ran before refresh.** The pending-delete flag was written on Stop, so
  the background interval deleted the message on the *same* page before the
  countdown fired — and there was nothing left to delete after refresh. The
  copied text is now held in memory and written to storage **only when the
  refresh actually fires** (Cancel ⇒ no flag ⇒ no delete). Reload runs in the
  storage write callback so the flag always persists.
- **Countdown toast clobbered.** The generic notice toast matched the refresh
  toast's element and overwrote it. Toast markers are now distinct:
  `data-djtf-toast="notice"` vs `"refresh"`.

## [1.9.1] — 2026-08-26

### Fixed
- **Container selectors matched only fixtures.** Real DreamJourney messages are
  `div.group` *without* `data-sentry-component` (a fixture-only assumption), so
  message searches found nothing. Rewrote the copy/delete block to find user
  messages via their `Delete/Edit/Copy user message` buttons and bot messages
  via the `assistant` variants, skipping the streaming partial.

## [1.9] — 2026-08-26

### Added
- **Copy on Stop.** Copy the user's last message to the clipboard when stopping
  a generation, so the prompt survives the refresh. (Refined through 1.9.1 →
  1.10 into a click-the-copy-button implementation.)

## [1.8] — 2026-08-26

### Added
- **Auto-delete of the copied message after refresh.** Persists the copied text
  and, after the reload, finds and deletes the matching user message via
  DreamJourney's own delete control.

## [1.7] — 2026-08-26

### Added
- **Copy + delete on Stop** (initial version): copy the user's message and
  auto-clean the stale copy post-refresh. Refined/renamed through later versions.

## [1.6] — 2026-08-26

### Added
- **Auto-refresh on Stop.** Clicking `Stop generating` opens a 3-second
  cancelable countdown that reloads the page, reducing duplicate / vanishing
  message bugs.

## [1.5] — 2026-08-26

### Added
- **Structure-shift reply detection.** When `</thinking>` is missing, detect the
  thinking→prose boundary by structure (list/header lines vs a sustained prose
  run). If prose exists but no confident boundary, flag the message
  **ambiguous** and tell the user to fix or reroll instead of hiding their
  reply. Missing-closer blocks that are all thinking-style lines close safely at
  the end.

## [1.4] — 2026-08-26

### Fixed
- **Missing closing fence repaired.** A block like `` ```<thinking>…</thinking> ``
  with no closing fence rendered as literal text; the well-formed check only
  required the *opening* fence. Now requires **both** wrappers.
- **Fenced duplicate tags repaired.** Fully-fenced blocks with duplicate
  `<thinking>` / `</thinking>` no longer slipped past the canonical fast-path.

### Added
- **Full catalog test matrix** (tag state × fence placement, 90 combos).

## [1.3] — 2026-08-26

### Fixed
- **Wand click context-invalidation error.** Wrapped the async wand handler in
  try/catch so a reload mid-click no longer surfaces as an uncaught error.
- **Scan handler** now resolves its response via `.then()` (was reporting
  `fixed: undefined`).

## [1.2] — 2026-08-26

### Removed
- **Reply-boundary detection simplified.** Only a closing code fence is now used
  to delimit the end of a thinking block. The prior heuristics around message
  headers are gone, so behavior no longer depends on any particular message
  layout.

## [1.1] — 2026-08-26

### Added
- **No-fence repair.** Bare `<thinking>…</thinking>` with no code fence (renders
  as visible text) is now wrapped in the fence DreamJourney needs.

## [1.0] — 2026-08-21

### Changed
- **Rebranded** from *DJ Thinking Fixer* → **Lucid**.
- Split desktop extension and mobile userscript into separate folders
  (`Lucid/` and `Lucid-Mobile/`) that share source; mobile can't drift from
  desktop.

### Surfaces
- Desktop extension: Chrome/Edge/Opera GX/Brave/Vivaldi (MV3).
- Mobile userscript: Tampermonkey / Kiwi / Userscripts-style managers.

## [0.x] — *DJ Thinking Fixer* era

- Removed background auto-fix and collapse (manual per-message action only).
- Empty-send **continue**: force-enable send on an empty composer, inject a
  zero-width space, delete the invisible placeholder after the reply.
- Repairs via DreamJourney's own edit dialog (React-safe): missing fences/tags,
  swapped tags, typos, stray inner fences, fused fences, curly-quote
  normalization.
