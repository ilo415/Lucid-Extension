# Lucid

A browser extension that **mends broken thinking blocks** on DreamJourney.AI roleplay replies — the ones thinking models emit before the actual reply.

When the model is a thinking model, every reply starts with a block like this:

````
```
<thinking>
1) I am roleplay director.
...
</thinking>
```
````

…but models fuck it up. The extension catches and fixes it every time:

| Failure | What you'd see | What the fixer does |
|---|---|---|
| Forgot the closing ```` ``` ```` | The entire reply renders as one giant code block | Lifts the response back out of the block and renders it |
| Forgot the opening ```` ``` ```` | `<thinking>` gets parsed as a hidden HTML tag; the thinking bleeds into the visible message | Wraps the thinking region in a proper code block |
| Forgot `<thinking>` or `</thinking>` | Block is open-ended or empty | Inserts the missing tag |
| Put `</thinking>` at the top instead of the bottom | Everything after is garbage | Moves the closer to the end |
| Typo'd tags (`<thinkng>`, `<thiking>`, `<thinkking>`…) | Tags render literally | Fuzzy-matches (Levenshtein ≤ 2) and rewrites canonical |
| Stray duplicate tags inside | Weird nested block | Strips extras |
| `[BRAIN]:` glued before the fence, or `[BRAIN]` inside the block | Junk marker at the top of the reply or inside the thinking | Strips `[BRAIN]`-style markers (also from loose text nodes outside the block) |
| Failed to wrap the whole thing in a code fence (bare `<thinking>…</thinking>` with no ```) | The thinking renders as visible text — DJ never turns it into a collapsed box | Wraps the block in the ``` fence wrapper DJ needs |

## Features

- **Per-message fix button** — a wand appears on any message with a thinking block; click it to check or mend that one message on demand. No unsolicited dialogs.
- **Empty-send continue** — hit Send with the box empty and the bot keeps writing (no `OOC: Continue` typing). Lucid force-enables the send button when the box is empty, sends a zero-width space so DJ accepts it, then deletes the invisible bubble after the reply so history stays clean.
- **Stats** — tracks how many blocks it has repaired (popup).
- **Dark violet skin** — matches the DreamJourney / lorebook-tool aesthetic.

## Installation

1. Open Chrome / Edge / Opera GX / Vivaldi / Brave.
2. Go to `chrome://extensions/` (or the browser's extension page).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select the `Lucid` folder.
6. Open a DreamJourney chat with a thinking-model bot. That's it.

## How it works

- `fixer-core.js` — all the logic, pure and DOM-independent:
  - `normalizeThinkingBlock(text)` — finds thinking-ish tags (fuzzy), locates the open/close positions, handles missing / swapped / duplicated / typo'd tags, strips `[BRAIN]`-style junk markers, returns the canonical block plus any leftover response text.
  - `rebuildMessageText(raw)` — turns a message's raw markdown source into the canonical fenced form DJ recognizes (` ```<thinking>…</thinking>``` `), or null if already correct.
  - `repairMessage(container)` — DOM-surgery fallback (three cases) for when the edit dialog isn't available:
    - **Case A** — thinking in a `<pre>`/`<code>`: rewrites the block; lifts a swallowed response out and renders it.
    - **Case B** — tags eaten as HTML elements: wraps the content in a block.
    - **Case C** — literal escaped tags: wraps the exact text-node run.
- `content.js` — React-safe operation, copied from Nebula's proven approach:
  1. **Never mutates DOM that DJ/React owns.** All fixes go through DJ's own edit dialog — the extension only clicks DJ's Edit button, swaps `textarea.value` via the React-compatible setter, and clicks DJ's Save. React re-renders from its own state, so no hydration crashes, no reconciliation errors.
  2. **Manual per-message wand.** Every message with a thinking block gets a wand button (left action cluster, sized to the bookmark button). Click it to check or mend that one message on demand — no unsolicited dialogs, no background edits.
  3. **Scan** with an Edit dialog open fixes that dialog directly (ground truth, no message targeting needed). Lucid never touches a dialog you opened yourself.
  4. A message is "malformed" when its thinking content is unhealthy: box present *or not* — the check reads the actual thinking text (stripped of DJ's button chrome) and requires exactly one opener at the start, one closer at the end, no stray fences, no `[BRAIN]`. A genuinely well-formed box is never touched.
- `repairMessage` (raw DOM surgery) still exists in the library for headless verification, but is **not called on live pages** — raw DOM mutation of React-owned nodes is what caused the app crash (React #418 hydration / `insertBefore` NotFoundError).
- The popup can force a scan of the current page.

## Why "confirm it's correct" now works

The extension no longer guesses from rendered DOM. It opens DJ's own edit dialog and reads the **raw source text** — the same data DJ persists. If that source's thinking block is malformed (missing/extra fence, missing/swapped/typo'd tags, `[BRAIN]` junk), it rebuilds it into DJ's canonical fenced form and saves. A source that's already well-formed is left untouched.

## Files

```
Lucid/
├── manifest.json       MV3, dreamjourneyai.com/app/*
├── fixer-core.js       normalizer + DOM repair + mini markdown
├── content.js          observer / settle detection / messaging
├── styles.css          collapse pill + block styling
├── popup.html/js       toggles, stats
├── icons/              generated icons
└── test/               fixture test page (open in a browser)
```

The phone userscript lives separately in `Lucid-Mobile/` (`Lucid.user.js`,
built from these same sources via `node build-userscript.js` so the phone and
desktop can never drift).

## Notes / caveats

- Content script runs on `dreamjourneyai.com/app/*`; the popup's "Scan" needs an open chat page.
- Repairs are skipped while the reply is still streaming (2s stability window) so it never fights live output.
- If the model regenerates a reply (swipe), the new node gets repaired fresh.
- The mini-markdown renderer is only used for response text that was trapped inside a broken code block. Normal replies are never re-rendered.