# Lucid

**DreamJourney roleplay extension — desktop browser + mobile userscript.**

Mends the malformed "thinking blocks" that reasoning models emit before their reply — broken code fences, missing or swapped `<thinking>`/`</thinking>` tags, typos, stray inner fences, fused fences, and bare tags with no fence. It also lets you send an empty message to keep a bot writing, called *empty-send continue*.

Fixes go through DreamJourney's **own edit dialog** (click Edit → rewrite raw source → Save), never raw DOM surgery, so DreamJourney/React never breaks.

📋 **[View the changelog](CHANGELOG.md)** for version history.

---

## 📥 Download

Choose the one for your device. Clicking a link downloads the file directly.

### 🖥️ Desktop — browser extension (Chrome, Edge, Opera GX, Brave, Vivaldi)

1. 📦 **Download the extension:** [Lucid-desktop.zip](https://github.com/ilo415/Lucid-Extension/raw/main/dist/Lucid-desktop.zip)
   *(just the desktop extension — everything you need, nothing else)*
2. **Unzip** it to a folder you'll keep (e.g. `Downloads/Lucid`).
3. Open your browser's extensions page:
   - Chrome/Edge/Brave/Vivaldi: `chrome://extensions`
   - Opera GX / Opera: `opera://extensions`
4. Turn on **Developer mode** (top-right).
5. Click **Load unpacked** and select the **`Lucid`** folder you unzipped.
6. Open a DreamJourney chat. Done.

> Keep that `Lucid` folder — the extension runs from it. Don't delete it after loading.

### 📱 Phone — mobile userscript (Android / iPhone / iPad)

1. ⬇️ **Download the userscript:** [Lucid.user.js](https://github.com/ilo415/Lucid-Extension/raw/main/Lucid-Mobile/Lucid.user.js)
   *(or view it: [Lucid-Mobile/ folder](https://github.com/ilo415/Lucid-Extension/tree/main/Lucid-Mobile))*
2. **Android:** install [Tampermonkey](https://play.google.com/store/apps/details?id=net.tampermonkey.droid) (or use [Kiwi Browser](https://play.google.com/store/apps/details?id=com.kiwibrowser.browser.next) to load the desktop extension directly), then open the `.user.js` — it registers itself.
3. **iPhone/iPad:** install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) (Settings → Safari → Extensions → enable it), then open `Lucid.user.js` in Safari.

Full phone steps: see [Lucid-Mobile/README-MOBILE.md](https://github.com/ilo415/Lucid-Extension/blob/main/Lucid-Mobile/README-MOBILE.md).

---

## What it does

- **Per-message wand button** — a wand appears on any message with a thinking block; click it to check or mend that one message on demand. No background edits.
- **Empty-send continue** — leave the message box empty and press **Send**. Lucid force-enables the send button, sends an invisible zero-width space so DreamJourney accepts the message, then deletes the ghost bubble after the reply finishes. The bot keeps writing — no `OOC: Continue` typing.
- **Fence/tag repair** — normalizes the thinking block to the canonical form DreamJourney recognizes:
  | Failure | What you'd see | What it does |
  |---|---|---|
  | Missing opening ` ``` ` | `<thinking>` parses as a hidden HTML tag; thinking bleeds into the visible reply | Wraps the thinking region in a code fence |
  | Missing closing ` ``` ` | Entire reply renders as one giant code block | Lifts the response back out and renders it |
  | Missing `<thinking>` or `</thinking>` | Block open-ended or empty | Inserts the missing tag |
  | `</thinking>` before `<thinking>` | Everything after is garbage | Moves the closer to the end |
  | Typo'd tags (`<thinkng>`, `<thiking>`, `<thinkking>`) | Tags render literally | Fuzzy-matches (Levenshtein ≤ 2) and rewrites canonical |
  | Stray duplicate tags inside | Weird nested block | Strips extras |
  | Stray/fused fences inside | Broken code block | Strips fences (never legit inside a thinking body) |
  | Bare `<thinking>…</thinking>` with no fence at all | Thinking renders as visible text, never a collapsed box | Wraps it in the code-fence wrapper |
  | `[BRAIN]:` junk | Marker at the top of the reply | Strips it |
- **Quote cleanup** — normalizes smart/curly quotes to straight ASCII so DreamJourney's dialogue highlighter actually matches.

---

## Structure

```
Lucid-Extension/
├── README.md
├── LICENSE
├── Lucid/               ← desktop browser extension (Chrome / Edge / Opera / Brave)
│   ├── manifest.json    MV3, matches dreamjourneyai.com/app/*
│   ├── fixer-core.js    pure normalizer (DOM-independent, unit-tested)
│   ├── content.js       React-safe content script (edit-dialog path)
│   ├── popup.html/js    scan, stats, continue toggle
│   ├── styles.css         injected styles
│   ├── icons/           16/48/128 icon
│   ├── readme.md         detailed docs
│   └── test/             node test suite (node test/normalizer.test.js)
└── Lucid-Mobile/       ← phone userscript (same logic, bundled)
    ├── build-userscript.js   pulls from ../Lucid/ (can't drift)
    ├── Lucid.user.js         the distributable script
    └── README-MOBILE.md      Android / iOS install
```

---

## Install — desktop (Chrome / Edge / Opera GX / Brave / Vivaldi)

1. `chrome://extensions` (or your browser's extension page)
2. Enable **Developer mode**
3. **Load unpacked** → select `Lucid/`
4. Open a DreamJourney chat. Done.

## Install — phone

See `Lucid-Mobile/README-MOBILE.md`. Android: Tampermonkey or Kiwi Browser. iPhone/iPad: Userscripts (Safari).

---

## Rebuild the mobile script after editing desktop code

```bash
cd Lucid-Mobile
node build-userscript.js    # regenerates Lucid.user.js from ../Lucid/
```

Keeps the phone and desktop builds on identical logic.

---

## License

MIT. This is a personal DreamJourney tool — fork it, tweak it, whatever you need.