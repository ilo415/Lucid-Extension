// ==UserScript==
// @name         Lucid (Mobile)
// @namespace    lucid-mobile
// @version      1.8.4
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
/* ═══════════════════════════════════════════════════════════════
   DJ Thinking Fixer — core logic
   Pure text normalizer + DOM surgery. No chrome.* APIs here, so the
   same file works in the extension AND in the standalone test page.
   Exposes global `DJTFCore`.
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  // ── Levenshtein — used to fuzzy-match typo'd <thinking> tags ──
  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }

  // Is a tag name close enough to "thinking" to count as one?
  // Broad by design: these tags only ever appear around a thinking block,
  // so being permissive (thinkg/thik/tink/thing/thnking…) is safe — the
  // canonical rebuild normalizes whatever we accept. Guarded against common
  // English words that merely neighbor "think" in edit distance (third,
  // thick, thin…) — those would be false positives on prose.
  const THINK_NEIGHBORS = new Set(['third', 'thick', 'thin', 'thine', 'thigh', 'thief', 'thing', 'thongs', 'thorn', 'those', 'than', 'then', 'them', 'this', 'that', 'their', 'there', 'these']);

  function isThinkingTag(name) {
    const n = String(name).toLowerCase().replace(/[^a-z]/g, '');
    if (!n) return false;
    if (n === 'thinking') return true;
    if (n.includes('think')) return true;      // think, thinkng, thinkking, thinkin…
    if (n.length < 3 || n.length > 12) return false;
    if (THINK_NEIGHBORS.has(n)) return false;  // common words, not tags
    // Very close to "think" (thik, tink, thing, thin…) or "thinking"
    // (thiking, thnking, thikng, thinkin…). Two small edit ops from the
    // stem, three from the full word.
    return levenshtein(n, 'think') <= 2 || levenshtein(n, 'thinking') <= 3;
  }

  // ── Tagless fallback ─────────────────────────────────────────
  // When BOTH <thinking> tags are missing entirely, the ONLY reliable
  // recovery signal is a real fenced block (``` ... ```) — the fences are
  // explicit block delimiters and unambiguous. We no longer guess a block
  // exists from any system-prompt wording (SEER/director templates vary by
  // user and don't appear in bot replies), so tagless-AND-fenceless text
  // falls through as "nothing to fix."

  // Find where the actual reply begins after a thinking block that has no
    // closing tag. Boundaries, in order of reliability:
    //   1. A fence-only line AFTER real content — the block's closing fence
    //      (a fence right after <thinking> is a stray opener-fence, NOT one).
    //   2. A STRUCTURE SHIFT: thinking blocks are dense list/header text
    //      ("1) …", "a) …", "- …", "STEP 1:", "DECISION:") while the reply is
    //      continuous prose. The first prose-like line that starts a sustained
    //      run (>=2 following prose lines, or a prose bulge) marks the story
    //      beginning. This is format-based — generic to every set-up, unlike
    //      user prompt conventions (SEER/CAS) which are deliberately NOT used.
    // Returns the index of the boundary, or -1 if none found.
    function findReplyBoundary(text, from) {
      if (!text || from == null) return -1;
      const slice = text.slice(from);

      // 1) Closing fence.
      const lines = slice.split('\n');
      let seenContent = false;
      let acc = from;
      for (const line of lines) {
        const isFence = /^\s*```+\s*$/.test(line);
        const isBlank = line.trim() === '';
        if (isFence) {
          if (seenContent) return acc;
        } else if (!isBlank) {
          seenContent = true;
        }
        acc += line.length + 1;
      }

      // 2) Structure shift — first prose line that starts a sustained prose run.
            return findProseBoundary(slice, from);
    }

    // Is this a "thinking-style" line — list item, ALL-CAPS/Title-case header
    // ending in a colon, or a short directive ("Write…", "Don't…")?
    function isThinkingStyleLine(line) {
      const t = line.trim();
      if (!t) return true; // blank lines belong to the block
      // list markers: "1)", "12)", "a)", "b)", "- ", "* ", "• "
      if (/^(\d+[.)]|[a-z][.)]|\*\s|-\s|•\s)/i.test(t)) return true;
      // header: "STEP 1: plan…", "DECISION: go", "IMPORTANT:…", "a) writing: …"
            if (/^[A-Z][A-Za-z0-9 _/-]{0,24}:/.test(t)) return true;
      // short directive: "Write it…", "Avoid…", "Don't…", "Keep it…"
      if (t.length < 60 && /^(write|avoid|don't|do not|keep|use|remember|make|start|end|vary|show|focus|imagine|you are|i am)\b/i.test(t)) return true;
      return false;
    }

    // Is this a story-style (prose) line — starts with a capital, reads as a
    // normal sentence, not a list/header/directive?
    function isProseLine(line) {
      const t = line.trim();
      if (!t) return false;
      if (isThinkingStyleLine(t)) return false;
      // Not list/header; must start with a capital or quote and be a normal
      // > 40-char sentence-length run.
      if (!/^[A-Z"“']/.test(t)) return false;
      if (t.length < 30) return false;       // too short to be a paragraph start
      return true;
    }

    // Scan for the first prose line that begins (or is followed by) a sustained
        // prose run — the "story bulge." Returns absolute offset, or -1.
        function findProseBoundary(slice, baseFrom) {
          const lines = slice.split('\n');
          let acc = baseFrom;
          for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            if (!t) { acc += lines[i].length + 1; continue; }
            if (isProseLine(lines[i])) {
              // look ahead: count CONSECUTIVE non-thinking non-blank lines (the
              // story run). Short dialogue lines are story too — don't break the
              // run on them. A >= 2-line run proves prose, not a stray example.
              let proseNext = 0;
              for (let j = i + 1; j < lines.length; j++) {
                const n = lines[j].trim();
                if (!n) continue;
                if (isThinkingStyleLine(n)) break;   // back to list/header = block
                proseNext++;                          // story line (any length)
              }
              if (proseNext >= 2) return acc;
              // Single prose line but long (a whole paragraph on one line) counts.
              if (lines[i].length >= 200) return acc;
            }
            acc += lines[i].length + 1;
          }
          return -1;
        }

  const TAG_RE = /<\s*\/?\s*([A-Za-z]{2,24})\s*>/g;

  // Model junk markers that sometimes prefix or pollute the thinking block.
  const BRAIN_RE = /\[brain\][\s:]*/gi;

  // Find every thinking-ish tag in a string with its position/kind.
  function findThinkingTags(text) {
    const tags = [];
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(text))) {
      if (isThinkingTag(m[1])) {
        tags.push({
          index: m.index,
          close: text[m.index + 1] === '/',
          raw: m[0],
          len: m[0].length,
        });
      }
    }
    return tags;
  }

  /* ── Core normalizer ───────────────────────────────────────────
     Given raw text that may contain a (possibly malformed) thinking
     block, return:
       null                          → no thinking tags found
       { thinking, rest, repaired }  → canonical thinking block +
                                       leftover response text +
                                       whether a repair was needed
     Handles:
       • missing opening tag         (<thinking> forgotten)
       • missing closing tag         (</thinking> forgotten)
       • closing BEFORE opening      ("</thinking> at the top" / swapped)
       • typo'd tags                 (<thinkng>, <thiking>, ...)
       • stray extra tags inside     (double <thinking>, premature </thinking>)
       • fence lines hugging the block edges
  ──────────────────────────────────────────────────────────────── */
  function normalizeThinkingBlock(text) {
    if (!text) return null;
    const tags = findThinkingTags(text);

    // ── Tagless fallback ──
    // Both <thinking> tags missing entirely. The only recoverable shape is
    // a real fenced block: ``` line ... ``` line — the fences ARE the block
    // markers, unambiguous even without SEER/director content. Anything
    // after the closing fence is the response.
    if (!tags.length) {
      const fencedMatch = /^\s*```+\s*\n?([\s\S]*?)\n?\s*```+\s*([\s\S]*)$/.exec(text);
      if (fencedMatch) {
        let body = fencedMatch[1];
        let rest = fencedMatch[2].replace(/^\s*\n+/, '').trim();
        body = body.replace(/^\s+|\s+$/g, '').replace(/^```+\s*$/gm, '');
        if (body) {
          return { thinking: '<thinking>\n' + body + '\n</thinking>', rest, repaired: true, tagless: true, fenced: true };
        }
      }
      // Tagless AND fenceless: no reliable delimiters, so nothing to fix.
      return null;
    }

    const openIdx = tags.findIndex(t => !t.close);
    let closeIdx = -1;
    for (let i = tags.length - 1; i >= 0; i--) {
      if (tags[i].close) { closeIdx = i; break; }
    }
    if (openIdx === -1 && closeIdx === -1) return null;

    let repaired = false;
    let bodyStart, bodyEnd, restStart;

    if (openIdx === -1) {
      // No opener — body is everything before the closing tag.
      bodyStart = 0;
      bodyEnd = tags[closeIdx].index;
      restStart = tags[closeIdx].index + tags[closeIdx].len;
      repaired = true;
    } else if (closeIdx === -1) {
          // No closer — body starts after the opening tag. Without a closer we
          // look for a boundary: a closing fence line, or a STRUCTURE SHIFT into
          // sustained prose (the story). If neither exists, the reply is
          // indistinguishable from the thinking body — do NOT silently absorb it
          // into the block (that hides the user's roleplay). Instead flag it
          // ambiguous so the UI can tell the user to hand-fix or reroll.
          bodyStart = tags[openIdx].index + tags[openIdx].len;
                    const boundary = findReplyBoundary(text, bodyStart);
                    if (boundary === -1) {
                      // No fence and no structure shift. If the rest is ALL
                      // thinking-style lines (no prose at all), there's no reply in here
                      // to lose — safely close the block at the end.
                      const restText = text.slice(bodyStart);
                      let hasProse = false;
                      for (const line of restText.split('\n')) {
                        if (line.trim() && isProseLine(line)) { hasProse = true; break; }
                      }
                      if (!hasProse) {
                        bodyEnd = text.length;
                        restStart = text.length;
                        repaired = true;
                      } else {
                        // Prose IS present but no sustained shift → genuinely can't tell
                        // where thinking ends. Don't hide the reply: flag ambiguous.
                        return { ambiguous: true, repaired: false, reason: 'no-closer-no-boundary' };
                      }
                    } else {
                                          bodyEnd = boundary;
                                          restStart = boundary;
                                          // The shift only counts if there were actual thinking-style
                                          // lines BEFORE the prose — otherwise this isn't a thinking
                                          // block with a reply, it's just prose after a stray <thinking>
                                          // (ambiguous).
                                          const pre = text.slice(bodyStart, boundary);
                                          let hasThinkingLine = false;
                                          for (const line of pre.split('\n')) {
                                            if (line.trim() && isThinkingStyleLine(line)) { hasThinkingLine = true; break; }
                                          }
                                          if (!hasThinkingLine) {
                                            return { ambiguous: true, repaired: false, reason: 'no-closer-no-thinking-lines' };
                                          }
                                          repaired = true;
                                        }
        } else if (tags[closeIdx].index < tags[openIdx].index) {
      // Closing appears BEFORE opening — the "swapped" case. Treat the
      // text between the misplaced closer and the opener as the body and
      // anything after the opener as the response.
      bodyStart = tags[closeIdx].index + tags[closeIdx].len;
      bodyEnd = tags[openIdx].index;
      restStart = tags[openIdx].index + tags[openIdx].len;
      repaired = true;
    } else {
      bodyStart = tags[openIdx].index + tags[openIdx].len;
      bodyEnd = tags[closeIdx].index;
      restStart = tags[closeIdx].index + tags[closeIdx].len;
      const inner = tags.filter(t => t.index > bodyStart && t.index < bodyEnd);
      if (inner.length) repaired = true;
      // Well-ordered but typo'd tags (or funky whitespace) still need the
      // block text rewritten — the canonical rebuild only lands if repaired.
      const rawOpen = tags[openIdx].raw.toLowerCase().replace(/\s+/g, '');
      const rawClose = tags[closeIdx].raw.toLowerCase().replace(/\s+/g, '');
      if (rawOpen !== '<thinking>' || rawClose !== '</thinking>') repaired = true;
    }

    let body = text.slice(bodyStart, bodyEnd);
    // If the model leaked a junk marker anywhere in the block, force a repair
    // so the DOM actually rewrites (auto-fix regardless of recovered shape).
    const hadBrain = BRAIN_RE.test(text);
    if (hadBrain) repaired = true;
    // A stray fence INSIDE the thinking body (e.g. "<thinking>\n\n\n```\n1)…")
    // is malformed — the strip below would silently absorb it and the block
    // would look canonical, so flag it first or the rewrite never fires.
    if (/```/.test(body)) repaired = true;
    // Strip leftover thinking tags inside the body (double opens, premature closes).
    body = body.replace(TAG_RE, (full, name) => (isThinkingTag(name) ? '' : full));
    // Strip model junk markers ([BRAIN], [BRAIN]:) that leaked into the block.
    body = body.replace(BRAIN_RE, '');
    // Fences are NEVER legit inside a thinking body. Remove every triple-backtick
    // run — covers fence-only lines (edges AND middle) AND fences fused directly
    // to content (e.g. "```SYSTEM PROCESS" where the model glued a stray fence
    // onto the first content line, or a mid-block code-fence line).
    body = body.replace(/```+/g, '');

    // Region before the opening tag's own position — should only be a fence.
        const beforeOpen = openIdx !== -1 ? text.slice(0, tags[openIdx].index) : '';
        const leading = beforeOpen.replace(/^\s*```+\s*\n?/, '').replace(BRAIN_RE, '').trim();
        // Everything after the closing tag — keep the raw form so we can tell a
        // real closing fence apart from "nothing at all" (both used to collapse
        // to '' after stripping, which is how a missing closer slipped through).
        const rawRest = text.slice(restStart);
        const hasCloseFence = /^\s*```+\s*(\n|$)/.test(rawRest);
        let rest = rawRest.replace(/^\s*```+\s*\n?/, '').replace(BRAIN_RE, '').replace(/\s+$/, '');

        const thinking = '<thinking>\n' + body.replace(/^\s+|\s+$/g, '') + '\n</thinking>';

        // Well-formed ONLY when BOTH fence wrappers are present: an opening fence
        // in front of <thinking> and a closing fence right after </thinking>.
        // A block with only one of the two — e.g. a fused "```<thinking>" with no
        // closing fence — is broken on DJ (the fence is never closed, so it
        // renders as literal text, never a collapsible ThinkingProcess).
        // Tolerated positions: fence glued to the tag OR on its own line
        // (both are the canonical shapes DJ emits).
        const hasOpenFence = openIdx !== -1 && /```/.test(text.slice(0, tags[openIdx].index));
        const fenced = hasOpenFence && hasCloseFence;
        if (!repaired && fenced && leading === '' && rest.trim() === '' && body.trim() !== '') {
          return { thinking, rest: '', repaired: false };
        }
        // Well-ordered clean tags but the wrapper is incomplete (missing opening
        // OR closing fence) — DJ renders bare/incomplete blocks as visible text.
        // Rebuild with a complete fence wrapper.
        if (!repaired && openIdx !== -1 && closeIdx !== -1 && !fenced) {
          repaired = true;
        }
        return { thinking, rest, repaired: true };
  }

  // ── Escape + minimal markdown (for response text rescued from a
  //    swallowed code block — we only re-render what we had to pull out) ──
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return t;
  }

  function renderMarkdownMin(src) {
    if (!src) return '';
    const blocks = String(src).split(/\n{2,}/);
    const out = [];
    for (let raw of blocks) {
      raw = raw.replace(/^\s+|\s+$/g, '');
      if (!raw) continue;
      const lines = raw.split('\n');
      if (lines.every(l => /^>\s?/.test(l))) {
        out.push('<blockquote>' + lines.map(l => inline(l.replace(/^>\s?/, ''))).join('<br>') + '</blockquote>');
      } else if (lines.every(l => /^[-*]\s+/.test(l))) {
        out.push('<ul>' + lines.map(l => '<li>' + inline(l.replace(/^[-*]\s+/, '')) + '</li>').join('') + '</ul>');
      } else if (/^#{1,4}\s/.test(raw)) {
        const h = raw.match(/^(#{1,4})\s+(.*)$/);
        out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>');
      } else {
        out.push('<p>' + lines.map(inline).join('<br>') + '</p>');
      }
    }
    return out.join('');
  }

  // ── DOM helpers ──
  function makeThinkingPre(thinkingText) {
    const pre = document.createElement('pre');
    pre.className = 'djtf-think-body';
    const code = document.createElement('code');
    code.textContent = thinkingText;
    pre.appendChild(code);
    return pre;
  }

  /* ── Rebuild raw message text ──────────────────────────────────
     Given the raw markdown source of a message (as DJ's edit dialog
     exposes it via textarea.value), return the canonical text with a
     well-formed fenced thinking block, or null when there is no
     thinking block / nothing to fix. Canonical form matches what DJ's
     renderer recognizes as a ThinkingProcess block:
       ```<thinking>
       body
       </thinking>```
  ──────────────────────────────────────────────────────────────── */
  /* ── Quotation-mark normalization ──────────────────────────────
     DJ's dialogue highlighter only matches ASCII straight quotes
     ("). When a model emits smart/curly quotes (“ ” ‘ ’ „ ‚ ‛) the
     highlighter can't pair them up, so dialogue goes un-highlighted
     and — worse — a stray closing quote at the end of a sentence
     (e.g. «…says "Always do. ») breaks highlighting for the rest of
     the reply. Normalizing all of them to their straight ASCII
     equivalents fixes that for the whole message.
  ──────────────────────────────────────────────────────────────── */
  function hasCurlyQuotes(text) {
    return /[\u201C\u201D\u201E\u2018\u2019\u201A\u201B]/.test(String(text || ''));
  }

  function normalizeQuotes(text) {
    if (!text) return text;
    return String(text)
      .replace(/[\u201C\u201D\u201E]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  }

  function rebuildMessageText(text) {
      if (!text) return null;
      const quotesBad = hasCurlyQuotes(text);
      // Already canonical: opening fence, clean <thinking>, body with NO stray
      // fences inside, </thinking>, closing fence (anything after that is the
      // normal response). The tempered dot (?:(?!```)[\s\S])*? refuses to cross
      // any ``` inside the body, so "<thinking>\n```\nbody</thinking>" is NOT
      // treated as canonical. Still rebuilds when the response carries curly
      // quotes — the dialogue-highlight fix applies even to healthy blocks.
      const canonicalShape = /^\s*```+\s*\n?\s*<thinking>(?:(?!```)[\s\S])*?<\/thinking>\s*```+/.test(text);
      if (canonicalShape && !quotesBad) {
        // The shape regex is lazy and happily matches DUPLICATE open/close tags
        // inside the block (it only refuses fences). A block with extra tags is
        // still malformed — fall through so normalizeThinkingBlock fixes it.
        const opens = (text.match(/<thinking>/g) || []).length;
        const closes = (text.match(/<\/thinking>/g) || []).length;
        if (opens === 1 && closes === 1) return null;
        // fall through → normalize will flag and strip the duplicates
      }
    const norm = normalizeThinkingBlock(text);
        // Ambiguous: a missing closer with no detectable boundary (no fence, no
        // structure shift). We can't safely split thinking from story — surface
        // this to the user instead of silently absorbing the reply into the block.
        if (norm && norm.ambiguous) {
          return { ambiguous: true, norm, quotesFixed: quotesBad };
        }
        if (!norm || !norm.repaired) {
          // Thinking block is fine but quotes are bad → purely a quote cleanup.
          if (quotesBad) {
            return { text: normalizeQuotes(text), norm: null, quotesFixed: true };
          }
          return null;
        }
    const fenced = '```\n' + norm.thinking + '\n```';
    const rest = norm.rest ? '\n\n' + norm.rest : '';
    let out = fenced + rest;
    const quotesFixed = quotesBad;
    if (quotesFixed) out = normalizeQuotes(out);
    return { text: out, norm, quotesFixed };
  }

  /* ── Content-level health of a thinking area ───────────────────
     DJ renders a parsed thinking block as its ThinkingProcess
     component — but the box's presence only proves DJ found A block,
     not that the content is well-formed. The model can still nest a
     duplicate <thinking> or stray fence inside it. Health = exactly
     one opener at the start, one closer at the end, no inner tags,
     no stray fences, no [BRAIN] junk.
  ──────────────────────────────────────────────────────────────── */
  function isHealthyThinkingText(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (t.includes('```')) return false;              // stray fence inside
    if (BRAIN_RE.test(t)) return false;               // junk marker inside
    const tags = findThinkingTags(t);
    if (tags.length !== 2) return false;              // exactly open + close
    const open = tags[0];
    const close = tags[1];
    if (open.close || !close.close) return false;     // open first, close last
    // Opener at the very start, closer at the very end.
    if (t.slice(0, open.index).trim() !== '') return false;
    if (t.slice(close.index + close.len).trim() !== '') return false;
    return true;
  }

  /* ── Thinking-content presence ─────────────────────────────────
     Find the raw thinking text inside an element regardless of how DJ
     rendered it: native box, raw <thinking> element, or pre/code.
  ──────────────────────────────────────────────────────────────── */
  function thinkingContentOf(el) {
    if (!el || el.nodeType !== 1) return '';
    let box = el.querySelector('div[data-sentry-element="ThinkingProcess"]');
    if (box) {
      // The box contains UI chrome (the "Show thinking process" button label)
            // — strip any button text so the content health check only sees the
            // actual thinking text.
      let content = (box.textContent || '');
      box.querySelectorAll('button').forEach((b) => {
        if (b.textContent) content = content.split(b.textContent).join('');
      });
      return content.trim();
    }
    const th = el.querySelector('thinking, think');
    if (th) return (th.textContent || '').trim();
    const pre = el.querySelector('pre code, pre, code');
    if (pre) return (pre.textContent || '').trim();
    return '';
  }

  function hasNativeThinkingBox(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      return !!el.querySelector(
        'div[data-sentry-element="ThinkingProcess"], button[aria-label="Show thinking process"]'
      );
    } catch {
      return false;
    }
  }

  /* ── Candidate message containers ──────────────────────────────
     DJ renders messages as Tailwind `.group` wrappers inside a
     `.scrollchatmessages` scroll container. Assistant messages are
     reliably identified by their toolbar buttons' aria-labels
     ("Edit assistant message", "Copy assistant message", ...).
     Returns the outermost .group per message that carries a thinking
     signature (malformed blocks) — well-formed blocks are skipped
     because DJ renders them natively.
  ──────────────────────────────────────────────────────────────── */
  function hasSignature(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const content = thinkingContentOf(el);
      const native = hasNativeThinkingBox(el);

      // Curly quotes anywhere in the message = a fix candidate even when the
      // thinking block is perfectly healthy (dialogue-highlight repair).
      const full = el.innerText || el.textContent || '';
      if (hasCurlyQuotes(full)) return true;

      if (native) {
        // DJ parsed a block. Only fix when malformation is VISIBLE inside:
        // stray fences, [BRAIN] junk, or thinking tags that aren't healthy.
        if (!content) return false;
        if (content.includes('```') || BRAIN_RE.test(content)) return true;
        const tags = findThinkingTags(content);
        if (!tags.length) return false;           // tags consumed by DJ → fine
        return !isHealthyThinkingText(content);
      }

      // No native box: any visible thinking text is a fix candidate.
      if (content.length > 0) return true;

      // No visible thinking region at all — but literal tags may still be
      // loose text (renderer escaped them, unfenced). Only count when they
      // start a line, never mid-paragraph.
      const t = el.innerText || el.textContent || '';
      if (t.length < 10 || t.length > 20000) return false;

      const tags = findThinkingTags(t);
      if (!tags.length) return false;
      return tags.some((tag) => /(^|\n)\s*$/.test(t.slice(0, tag.index)));
    } catch {
      return false;
    }
  }

  function findCandidates(rootEl) {
    const root = rootEl || document;
    if (!root || !root.querySelectorAll) return [];
    const seen = new Set();
    const out = [];

    // 1) Assistant-message toolbar buttons → closest .group wrapper.
    root.querySelectorAll('button[aria-label]').forEach((b) => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (!/assistant message/.test(label)) return;
      const g = b.closest('.group') || b.parentElement;
      if (!g || seen.has(g)) return;
      seen.add(g);
      if (hasSignature(g)) out.push(g);
    });

    // 2) Fallback: .group elements with a thinking signature, so a
    //    malformed block is still caught if the toolbar is missing.
    root.querySelectorAll('.group').forEach((g) => {
      if (!seen.has(g) && hasSignature(g)) {
        seen.add(g);
        out.push(g);
      }
    });

    return out;
  }

  // ── Repair one message container ──────────────────────────────
  // Returns the number of blocks repaired (0 = nothing to do).
  // ──────────────────────────────────────────────────────────────── */
  function repairMessage(container, opts) {
    if (!container || container.nodeType !== 1) return 0;
    opts = opts || {};
    let fixed = 0;

    // ── Case A: fenced code blocks (pre/code) holding the thinking text ──
    const blocks = [];
    container.querySelectorAll('pre').forEach(p => blocks.push(p));
    container.querySelectorAll('code').forEach(c => {
      if (!c.closest('pre')) blocks.push(c);
    });

    for (const block of blocks) {
      if (block.closest('.djtf-thinking')) continue; // already processed
      const txt = block.textContent || '';
      const norm = normalizeThinkingBlock(txt);
      if (!norm) continue;

      if (norm.repaired) {
        block.textContent = norm.thinking;          // fixes tags/order/typos
        fixed++;
        if (norm.rest && norm.rest.trim()) {
          // Response got swallowed into the code block (closing fence was
          // forgotten) — lift it back out and render it.
          const wrap = document.createElement('div');
          wrap.className = 'djtf-response';
          wrap.innerHTML = renderMarkdownMin(norm.rest);
          block.parentNode.insertBefore(wrap, block.nextSibling);
        }
      }
    }

    // ── Case B: tags eaten as real HTML elements (missing opening
    //    fence — <thinking> got parsed as an unknown element) ──
    const thEl = container.querySelector('thinking, think');
    if (thEl && !thEl.closest('.djtf-thinking')) {
      // Only treat it as a thinking block if it plausibly holds real content.
      // UI chrome (tooltips, labels) can contain stray tiny <thinking> tags.
      const body = (thEl.textContent || '').trim();
      const looksReal = body.length >= 5 && (body.includes('\n') || body.length >= 20);
      if (looksReal) {
        const pre = makeThinkingPre('<thinking>\n' + body + '\n</thinking>');
        thEl.parentNode.insertBefore(pre, thEl);
        thEl.remove();
        fixed++;
      }
    } else if (!thEl) {
      // ── Case C: literal tags in loose text (renderer escaped them,
          //    no <pre> anywhere) — wrap the run of text nodes in a block ──
          const textNodes = [];
          {
            const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
            let x;
            while ((x = w.nextNode())) {
              // Never re-process text we already repaired (lives inside a block/shell).
              if (x.parentNode && x.parentNode.closest('pre, code, .djtf-thinking')) continue;
              if (findThinkingTags(x.nodeValue || '').length) textNodes.push(x);
            }
          }
        if (textNodes.length) {
          let first = textNodes[0];
          const last = textNodes[textNodes.length - 1];

        // Missing-opener heuristic: if every tag-bearing node is a CLOSING tag
        // (no <thinking> anywhere), the thinking content starts at the top of
        // the block element that holds the closing tag, not at the tag itself.
        const anyOpener = textNodes.some((n) =>
          findThinkingTags(n.nodeValue || '').some((t) => !t.close));
        if (!anyOpener && first.parentNode && first.parentNode.nodeType === 1) {
          const blockStart = first.parentNode;
          const w2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
          let x;
          while ((x = w2.nextNode())) {
            if (blockStart.contains(x)) { first = x; break; }
          }
        }

        const parts = [];
        {
          const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
          let x, collecting = false;
          while ((x = w.nextNode())) {
            if (x === first) collecting = true;
            if (collecting) parts.push(x.nodeValue || '');
            if (x === last) break;
          }
        }
        const norm = normalizeThinkingBlock(parts.join(''));
        if (norm) {
          const pre = makeThinkingPre(norm.thinking);
          if (first === last) {
            // Single text node — keep the response tail, insert block before it.
            first.nodeValue = norm.rest || '';
            first.parentNode.insertBefore(pre, first);
          } else {
            // Delete everything strictly between first and last, then trim
            // the tail off `last` (that tail becomes the response text).
            const range = document.createRange();
            range.setStartAfter(first);
            range.setEndBefore(last);
            range.deleteContents();
            last.nodeValue = norm.rest || '';
            last.parentNode.insertBefore(pre, last);
          }
          if (norm.repaired) fixed++;
        }
      }
    }

    // Loose [BRAIN]-style markers outside the block get stripped regardless
    // of which case ran — they're model junk, never RP prose.
    sweepJunkMarkers(container);

    return fixed;
  }

  // ── Junk sweep: strip [BRAIN]-style markers that DJ left as loose text
  //    outside the thinking block (e.g. "[BRAIN]:``` " rendered as a text
  //    node before the code block). Only touches text that looks like the
  //    marker itself — never RP prose. ──
  function sweepJunkMarkers(container) {
    if (!container || container.nodeType !== 1) return 0;
    const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let x, cleaned = 0;
    while ((x = w.nextNode())) {
      if (!x.nodeValue) continue;
      // Skip text inside blocks we manage (pre/code/shell already normalized).
      if (x.parentNode && x.parentNode.closest('pre, code, .djtf-thinking')) continue;
      const v = x.nodeValue;
      // "[BRAIN]:" / "[BRAIN]:```" / "[BRAIN]" at the start of a text run.
      const junk = /^\s*\[brain\][\s:]*`*/i;
      if (junk.test(v)) {
        const cleanedVal = v.replace(junk, '');
        x.nodeValue = cleanedVal;
        cleaned++;
      }
    }
    return cleaned;
  }

  root.DJTFCore = {
      levenshtein,
      isThinkingTag,
      findThinkingTags,
      normalizeThinkingBlock,
      esc,
      inline,
      renderMarkdownMin,
      makeThinkingPre,
      repairMessage,
      sweepJunkMarkers,
      hasSignature,
      findCandidates,
      rebuildMessageText,
      hasNativeThinkingBox,
      isHealthyThinkingText,
      thinkingContentOf,
      hasCurlyQuotes,
      normalizeQuotes,
    };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.DJTFCore;
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* ═══════════════════════════════════════════════════════════════
   DJ Thinking Fixer — content script
   React-safe: NEVER mutates DOM nodes DJ/React owns. All fixes go
   through DJ's own edit dialog (click Edit → read raw source → write
   back → Save), which lets React re-render from its own state.
   Manual per-message "Fix thinking" button (Nebula-style) +
   empty-send continue. No background auto-fix, no collapse.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const SAFETY_INTERVAL = 2500;

    let stats = { fixed: 0, lastAt: null };
        let autoRefresh = true;   // after clicking Stop, offer a 3s cancel-able reload
        let saveOnStop = true;    // on Stop, copy user msg + copy/delete bot partial

        // ── Storage ──
        function loadState(cb) {
              try { if (!chrome.runtime || !chrome.runtime.id) { if (cb) cb(); return; } } catch (_) { if (cb) cb(); return; }
              chrome.storage.local.get(['djtfStats', 'djtfContinue', 'djtfAutoRefresh', 'djtfSaveOnStop'], (res) => {
            continueEnabled = res.djtfContinue !== false;
            autoRefresh = res.djtfAutoRefresh !== false;
            saveOnStop = res.djtfSaveOnStop !== false;
            if (res.djtfStats) stats = res.djtfStats;
            if (cb) cb();
          });
        }

        function saveState() {
                try { if (!chrome.runtime || !chrome.runtime.id) return; } catch (_) { return; }
                try { chrome.storage.local.set({ djtfStats: stats, djtfContinue: continueEnabled, djtfAutoRefresh: autoRefresh, djtfSaveOnStop: saveOnStop }); } catch (_) {}
              }

    // In-page toast (floats over the chat) for user-facing notices.
    let toastTimer = null;
    function showToast(msg) {
      try {
        let el = document.querySelector('[data-djtf-toast]');
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-djtf-toast', '1');
          el.style.cssText = [
            'position:fixed','bottom:90px','left:50%','transform:translateX(-50%)',
            'z-index:99999','max-width:480px',
            'background:rgba(19,19,34,.97)','border:1px solid rgba(245,158,11,.55)',
            'color:#fbbf24','border-radius:10px','padding:10px 14px',
            'box-shadow:0 8px 30px rgba(0,0,0,.5)','font-family:inherit','font-size:13px',
            'line-height:1.4','text-align:center'
          ].join(';');
          document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { try { el.style.display = 'none'; } catch (_) {} }, 6000);
      } catch (_) {}
    }

  function bumpStats(n) {
      stats.fixed += n;
      stats.lastAt = Date.now();
      try { if (!chrome.runtime || !chrome.runtime.id) return; } catch (_) { return; }
      try { chrome.storage.local.set({ djtfStats: stats }); } catch (_) {}
    }

  // ── "Still generating?" fast-path via the composer ──
  // Generation = the composer send control is disabled. Scope detection is
  // fragile (form vs sibling), so we search the bottom-of-viewport zone for
  // any disabled send-like button, plus any visible stop button.
  function isGenerating() {
    try {
      const btns = Array.from(document.querySelectorAll('button'));
      // Stop / generate buttons get aria-labels or text when streaming.
      const stop = btns.find((b) => {
        const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase();
        return /stop|halt|cancel/.test(t) && b.offsetParent !== null;
      });
      if (stop) return true;

      // The composer's own send button is disabled whenever the textarea is
      // EMPTY — that's DJ's idle state, not generation. A disabled send only
      // means streaming when the box actually has content in it.
      const comp = composerEls();
      const compSend = comp ? comp.send : null;
      const compTa = comp ? comp.textarea : null;

      // Send control disabled — any OTHER disabled button in the composer
      // zone (bottom 35% of the viewport) that looks like a send/submit.
      const h = window.innerHeight;
      const send = btns.find((b) => {
        if (b.offsetParent === null) return false;
        if (!(b.disabled || b.getAttribute('aria-disabled') === 'true')) return false;
        if (b === compSend && compTa && compTa.value.trim() === '') return false;
        const r = b.getBoundingClientRect();
        if (r.top < h * 0.65) return false;               // composer zone only
        const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase();
        const inner = (b.innerHTML || '').toLowerCase();
        return /send|submit|arrow|paper|plane|➤|→/.test(label + ' ' + inner) ||
               b.type === 'submit';
      });
      return !!send;
    } catch { /* never fail the page */ }
    return false;
  }

  // ── Message discovery ──
  function rootEl() {
    return document.querySelector('.scrollchatmessages') || document.querySelector('main') || document.body;
  }

  // ── Dialog fix (React-safe, via DJ's own Edit/Save) ──
  function closeDialog(dialog) {
    if (!dialog) return;
    const cancel = Array.from(dialog.querySelectorAll('button')).find((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      return t.includes('cancel') || a.includes('cancel') || a.includes('close');
    });
    if (cancel) { cancel.click(); return; }
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  }

  // Core: read an edit-dialog textarea, rebuild if malformed, save.
  // React-safe: native setter + events + DJ's own Save button.
  // Returns {fixed: 0|1, via}.
  // Double-reads the textarea: if the source is still being written
  // (long replies stream while the dialog is open), abort instead of
  // saving a half-written message.
  function fixTextarea(textarea, dialog) {
    const original = textarea.value;
    // Sample twice 400ms apart — if the source changed, it's still streaming.
    const before = textarea.value;
    return new Promise((resolve) => {
      setTimeout(() => {
        if (textarea.value !== before) {
          closeDialog(dialog);
          resolve({ fixed: 0, via: 'still-streaming' });
          return;
        }
        const rebuilt = DJTFCore.rebuildMessageText(original);
                if (rebuilt && rebuilt.ambiguous) {
                  // Can't determine where thinking ends / story begins. DON'T save
                  // (we'd hide the user's reply inside the block). Leave the dialog
                  // open so the user can hand-edit, and report it as ambiguous.
                  resolve({ fixed: 0, via: 'ambiguous' });
                  return;
                }
                if (!rebuilt) {
                  closeDialog(dialog);
                  resolve({ fixed: 0, via: 'no-repair-needed' });
                  return;
                }
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(textarea, rebuilt.text);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        const saveBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
          b.textContent.includes('Save') || b.querySelector('svg.lucide-check'));
        if (saveBtn) setTimeout(() => saveBtn.click(), 100);
        resolve({ fixed: 1, via: 'dialog' });
      }, 400);
    });
  }

  // Inspect/repair whatever edit dialog is CURRENTLY open (user opened Edit
  // manually and hit Scan). The dialog's textarea is ground truth — we don't
  // need to know which message it belongs to.
  async function fixOpenDialog() {
    const dialog = document.querySelector('div[role="dialog"]');
    const textarea = dialog?.querySelector('textarea');
    if (!textarea) return { fixed: 0, via: 'no-dialog' };
    const res = await fixTextarea(textarea, dialog);
    if (res.fixed) bumpStats(res.fixed);
    return res;
  }

  // Opens (or reuses) DJ's edit dialog for a specific message, reads the raw
  // source, rebuilds if malformed, saves. React-safe: only drives DJ's own
  // controls. If a dialog is already open we never stack a second one.
  // Resolves {fixed: 0|1, via, dialog}.
  function fixViaDialog(el) {
    return new Promise((resolve) => {
      let dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) {
        const editBtn = el.querySelector('button[aria-label="Edit assistant message"]');
        if (!editBtn) { resolve({ fixed: 0, via: 'no-edit-btn' }); return; }
        editBtn.click();
      }
      const startedAt = Date.now();
      const poll = setInterval(() => {
        dialog = document.querySelector('div[role="dialog"]');
        const textarea = dialog?.querySelector('textarea');
        if (!textarea) {
          if (Date.now() - startedAt > 3000) {
            clearInterval(poll);
            closeDialog(dialog);
            resolve({ fixed: 0, via: 'timeout', dialog: dialog || null });
          }
          return;
        }
        clearInterval(poll);
        fixTextarea(textarea, dialog).then((res) => resolve({ ...res, dialog }));
      }, 60);
    });
  }

  // ── Injected per-message "Fix thinking" button (Nebula pattern) ──
  // Always available on any message with a thinking block (well-formed OR
  // malformed) so the user can manually check/fix at any time — no need to
  // trust the auto-fixer. Solid purple, always visible (like Nebula's
  // remove-thinking button) but with a wand icon instead of captions-off.
  const BTN_ATTR = 'data-djtf-fixbtn';

  function buildFixBtn(size) {
    const btn = document.createElement('button');
    btn.setAttribute(BTN_ATTR, '1');
    btn.type = 'button';
    btn.title = 'Check / fix thinking block';
    btn.setAttribute('aria-label', 'Check / fix thinking block');
    // Inline styles, NOT Tailwind classes: DJ's CSS build doesn't ship
    // arbitrary utilities, so classes render inconsistently. Here we match
    // the surrounding action icons — transparent base, light icon, and only a
    // faint purple wash on hover (like the bookmark / eye / comment buttons).
    // The delete button keeps its own red styling (DJ's native button).
    const px = Math.round(size) || 28;
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'flex:0 0 auto', 'width:' + px + 'px', 'height:' + px + 'px',
      'padding:0', 'border-radius:8px', 'cursor:pointer',
      'background:transparent', 'color:#94a3b8',
      'border:1px solid transparent', 'transition:background .15s, color .15s, border-color .15s',
    ].join(';') + ';';
    btn.onmouseenter = () => {
      btn.style.background = 'rgba(139,92,246,.15)';
      btn.style.borderColor = 'rgba(168,85,247,.35)';
      btn.style.color = '#c4b5fd';
    };
    btn.onmouseleave = () => {
      btn.style.background = 'transparent';
      btn.style.borderColor = 'transparent';
      btn.style.color = '#94a3b8';
    };
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-wand-2" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>';
    return btn;
  }

  // Messages with ANY thinking block (native box or malformed) + an edit
  // button — these all get the manual fix button.
  function thinkingGroups() {
    const root = rootEl();
    if (!root) return [];
    const out = [];
    root.querySelectorAll('.group').forEach((g) => {
      if (!g.querySelector('button[aria-label="Edit assistant message"]')) return;
      const has = DJTFCore.hasNativeThinkingBox(g) || DJTFCore.hasSignature(g);
      if (has) out.push(g);
    });
    return out;
  }

  // Find the message's LEFT action cluster (where bookmark / lore / Nebula's
  // remove-thinking button live) so our fix button sits far from the reroll /
  // edit / copy buttons on the right — no misclicks.
  function leftActionCluster(g) {
    const actionBar = g.querySelector('.flex.mx-0.gap-y-1.w-full.justify-between');
    if (actionBar) {
      const first = actionBar.firstElementChild;
      if (first) return first;
    }
    // Fallback: the toolbar row containing the bookmark button.
    const bm = g.querySelector('button[aria-label*="bookmark"], button[title*="bookmark" i]');
    if (bm) return bm.parentElement || bm.parentNode || null;
    return null;
  }

  function injectFixButtons() {
    const groups = thinkingGroups();
    for (const g of groups) {
      if (g.querySelector(`[${BTN_ATTR}]`)) continue;
      const cluster = leftActionCluster(g);
      if (!cluster) continue;
      // Size-match to the bookmark button so we align evenly in the same row.
      const bookmark = cluster.querySelector('button[aria-label*="bookmark"], button[title*="bookmark" i]') ||
                       cluster.querySelector('button');
      let px = 28;
      if (bookmark) {
        const r = bookmark.getBoundingClientRect();
        if (r && r.height > 4 && r.width > 4) px = Math.min(r.height, r.width);
      }
      const btn = buildFixBtn(px);
                  btn.addEventListener('click', async (e) => {
                    // Async closure: if the extension context is invalidated mid-flight
                    // (reload, page teardown), the awaited work rejects as an uncaught
                    // promise. Swallow that so it can't surface in the Errors panel.
                    try {
                      e.stopPropagation();
                      btn.disabled = true;
                      btn.style.opacity = '.6';
                      const res = await fixViaDialog(g);
                      if (res.fixed) {
                        bumpStats(res.fixed);
                        btn.style.background = 'rgba(5,150,105,.2)'; btn.style.color = '#6ee7b7'; btn.style.borderColor = 'rgba(52,211,153,.4)';
                        btn.title = 'Fixed ✓';
                      } else if (res.via === 'ambiguous') {
                        // Can't tell where thinking ends / prose begins. The edit
                        // dialog stays OPEN so the user can hand-place </thinking>.
                        // Surface a clear notice + leave the button amber.
                        btn.style.background = 'rgba(245,158,11,.18)'; btn.style.color = '#fbbf24'; btn.style.borderColor = 'rgba(245,158,11,.45)';
                        btn.title = 'Can\u2019t find reply start \u2014 fix manually or reroll';
                        showToast('⚠️ Lucid couldn\u2019t find where the reply starts. Fix </thinking> in the open editor, or reroll the message.');
                      } else if (res.via === 'no-repair-needed') {
                        btn.style.background = 'rgba(82,82,91,.2)'; btn.style.color = '#a1a1aa'; btn.style.borderColor = 'rgba(113,113,122,.3)';
                        btn.title = 'Looks clean ✔';
                      }
                      // Timeout / no-edit-btn: stay purple so the user can retry.
                    } catch (_) { /* extension context invalidated / page gone — give up quietly */ }
                    try {
                      btn.style.opacity = '1';
                      btn.disabled = false;
                      // Amber ambiguous state persists longer (user needs to act).
                                            if (btn.title.indexOf('Can\u2019t find reply start') === -1) {
                        setTimeout(() => { btn.style.background = 'transparent'; btn.style.color = '#94a3b8'; btn.style.borderColor = 'transparent'; btn.title = 'Check / fix thinking block'; }, 1500);
                      }
                    } catch (_) {}
                  });
      // Place right AFTER the bookmark button so they sit together and align.
      if (bookmark && bookmark.parentNode === cluster) {
        cluster.insertBefore(btn, bookmark.nextSibling);
      } else {
        cluster.insertBefore(btn, cluster.firstChild);
      }
    }
  }

  // ── Empty-send "continue" (GhostBuddy-style) ──────────────────
  // DJ disables the send button when the composer textarea is empty, so you
  // can't nudge the bot to keep writing. We force-enable it when empty, and
  // when the user sends an empty message we inject a zero-width space (ZWS)
  // so the backend actually receives a message; once the bot finishes
  // replying we delete the invisible bubble via DJ's own delete control.
  // React-safe: only drives DJ's own controls (send button state, textarea
  // value through the native setter, the message delete button).
  const ZWS = '\u200B';
  let continueEnabled = true;
  const cont = {
      active: false,          // a ZWS send is in flight
      zws: ZWS,
      doneTimer: null,        // reply-completion poll
      cleanupTimer: null,     // textarea restore
    };

  // Composer controls with defensive fallbacks (the site has been known to
  // change class names; try the deprecated selectors first, then generic).
  function composerEls() {
    const form =
      document.querySelector('form.chatform') ||
      document.querySelector('form[class*="chat"]') ||
      document.querySelector('main form') ||
      document.querySelector('form');
    if (!form) return null;
    const textarea =
      form.querySelector('textarea.submittextarea') ||
      form.querySelector('textarea');
    if (!textarea) return null;
    const send =
      form.querySelector('button svg.lucide-send-horizontal')?.closest('button') ||
      form.querySelector('button[type="submit"]') ||
      form.querySelector('button[aria-label*="send" i], button[title*="send" i]');
    return { form, textarea, send };
  }

  // Only re-enable when the box is empty AND nothing is generating — during
  // generation DJ correctly disables send and we must not fight it (it also
  // keeps isGenerating()'s disabled-send detection working).
  function maybeEnableSend() {
    if (!continueEnabled) return;
    if (isGenerating()) return;
    const c = composerEls();
    if (!c || !c.send) return;
    if (c.textarea.value.trim() === '' && c.send.hasAttribute('disabled')) {
      c.send.removeAttribute('disabled');
    }
  }

  // Inject a ZWS before the click lands so React's own submit handler sees a
  // non-empty value and actually sends. The bot reads the near-invisible
  // message as "continue".
  function armEmptySend(e) {
    if (!continueEnabled || cont.active) return;
    const c = composerEls();
    if (!c || !c.send || !c.textarea) return;
    if (c.textarea.value.trim() !== '') return;   // real content — let it be
    if (isGenerating()) return;                   // never during generation
    cont.active = true;
    cont.zws = ZWS;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(c.textarea, ZWS);
    c.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    c.textarea.dispatchEvent(new Event('change', { bubbles: true }));
    if (c.send.hasAttribute('disabled')) c.send.removeAttribute('disabled');
    // Restore the empty box a moment after the submit consumes the value.
    clearTimeout(cont.cleanupTimer);
    cont.cleanupTimer = setTimeout(() => {
      if (c.textarea.value === ZWS) {
        setter.call(c.textarea, '');
        c.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 400);
    watchForZwsBubble();
  }

  // After the ZWS message appears, wait for the bot's reply to finish, then
  // click the message's own delete button (React-safe: DJ's control).
  function watchForZwsBubble() {
      const root = document.querySelector('.scrollchatmessages') || document.body;
      let found = null;

    const tryDelete = () => {
      // Only delete once the composer is idle again (reply finished) and the
      // bubble still exists.
      if (isGenerating()) return;
      const bubble = found || findZwsBubble();
      if (!bubble) { stopWatching(); cont.active = false; return; }
      found = bubble;
      bubble.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      setTimeout(() => {
        const trash = bubble.querySelector('svg.lucide.lucide-trash2, svg.lucide-trash-2');
        const delBtn = trash ? trash.closest('button') : null;
        if (delBtn) {
          delBtn.click();
          stopWatching();
          cont.active = false;
        } else {
          stopWatching();
          cont.active = false; // give up — the bubble may not have a delete
        }
      }, 120);
    };

    const stopWatching = () => {
          if (cont.doneTimer) { clearInterval(cont.doneTimer); cont.doneTimer = null; }
          found = null;
        };

    // Poll for completion: once the send control is enabled again AND the
    // bubble exists, attempt deletion every 800ms until it succeeds.
    cont.doneTimer = setInterval(() => {
      if (!findZwsBubble()) return; // bubble not rendered yet — keep waiting
      tryDelete();
    }, 800);

    // Fallback: never wait forever.
    setTimeout(() => {
      if (cont.active) {
        clearInterval(cont.doneTimer);
        cont.doneTimer = null;
        cont.active = false;
      }
    }, 120000);
  }

  function findZwsBubble() {
    const root = document.querySelector('.scrollchatmessages') || document.body;
    const groups = root.querySelectorAll('div.group[data-sentry-component="ChatMessage"]');
    for (const g of groups) {
      const md = g.querySelector('div.markdown');
      if (md && md.textContent === cont.zws) return g;
    }
    return null;
  }

  function hookComposer() {
    const attach = () => {
      const c = composerEls();
      if (!c || !c.textarea) return;
      if (!c.textarea.dataset.djtfContAttached) {
        c.textarea.dataset.djtfContAttached = '1';
        c.textarea.addEventListener('input', maybeEnableSend);
        c.textarea.addEventListener('keyup', maybeEnableSend);
        c.form.addEventListener('submit', () => {
          if (cont.active) {
            clearTimeout(cont.cleanupTimer);
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setTimeout(() => { if (c.textarea.value === ZWS) { setter.call(c.textarea, ''); c.textarea.dispatchEvent(new Event('input', { bubbles: true })); } }, 300);
          }
        });
      }
      if (c.send && !c.send.dataset.djtfContClick) {
        c.send.dataset.djtfContClick = '1';
        c.send.addEventListener('mousedown', armEmptySend);
        // DJ may re-disable the button on its own re-renders; keep the
        // enabled state fresh.
        if (window.MutationObserver) {
          const ob = new MutationObserver(maybeEnableSend);
          ob.observe(c.send, { attributes: true, attributeFilter: ['disabled'] });
        }
      }
      maybeEnableSend();
    };
    attach();
    // The composer can remount (e.g. after sending); re-hook on mutations.
    if (window.MutationObserver && !window.__djtfContObs) {
      window.__djtfContObs = new MutationObserver(() => {
        attach();
        maybeEnableSend();
      });
      window.__djtfContObs.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ── Auto-refresh on Stop (Aster port) ──────────────────────
  // When the user clicks DJ's "Stop generating" button, offer a 3-second
  // countdown toast with a Cancel button, then reload the page. A hard
  // reload after stopping a generation reduces the chance of DJ's double
  // or vanishing-message bug (Aster's proven behavior, faithful port).
  // Only the exact stop button triggers it; nothing reloads unprompted.
  let refreshToastActive = false;

  function showRefreshToast() {
    if (!autoRefresh || refreshToastActive) return;
    refreshToastActive = true;
    let left = 3;
    let cancelled = false;
    const t = document.createElement('div');
    t.setAttribute('data-djtf-toast', 'refresh');
    t.style.cssText = [
      'position:fixed','bottom:90px','left:50%','transform:translateX(-50%)',
      'z-index:99999','min-width:320px',
      'background:rgba(19,19,34,.97)','border:1px solid rgba(139,92,246,.55)',
      'color:#e2e8f0','border-radius:10px','padding:10px 14px',
      'box-shadow:0 8px 30px rgba(0,0,0,.5)','font-family:inherit','font-size:13px',
      'line-height:1.4','text-align:center'
    ].join(';');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px';
    row.innerHTML = '<span>Refresh in</span><b class="djtf-refresh-count">3</b>';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = [
      'background:rgba(255,255,255,.08)','border:1px solid rgba(255,255,255,.2)',
      'color:#e2e8f0','border-radius:6px','padding:2px 10px','font-size:12px',
      'cursor:pointer','font-family:inherit'
    ].join(';');
    cancel.addEventListener('click', () => { cancelled = true; t.remove(); refreshToastActive = false; });
    row.appendChild(cancel);
    const note = document.createElement('div');
    note.textContent = 'Refreshing after Stop reduces double / vanishing messages.';
    note.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:6px';
    t.appendChild(row); t.appendChild(note);
    document.body.appendChild(t);

    const countEl = t.querySelector('.djtf-refresh-count');
    const iv = setInterval(() => {
      if (cancelled) { clearInterval(iv); return; }
      left--;
      if (countEl) countEl.textContent = String(left);
      if (left <= 0) {
        clearInterval(iv);
        try { t.remove(); } catch (_) {}
        refreshToastActive = false;
        location.reload();
      }
    }, 1000);
  }

  // Delegated Stop-button listener (matches Aster's method, which lets the
      // actual Stop action land on DJ first — NO preventDefault/stopPropagation
      // here, so the generation genuinely stops — and only then offers the
      // refresh, because the reset-state must reflect the stopped generation).
      function hookStopButton() {
        document.addEventListener('click', (e) => {
          if (!autoRefresh || !e.target || !e.target.closest) return;
          const stop = e.target.closest('[aria-label="Stop generating response"], [aria-label="Stop generating"], [title*="Stop generating" i]');
          if (stop) {
                      // Do NOT preventDefault / stopPropagation — let DJ's own handler run
                      // so the generation actually stops. We only observe and offer refresh.
                      if (saveOnStop) copyUserOnStop();
                      showRefreshToast();
                    }
        }, true);
      }

      // ── Copy on Stop ────────────────────────────────────────────
            // When Stop is clicked, copy the user's last message to the clipboard
            // so their prompt survives the page reload (DJ stops the bot's reply
            // itself — we only preserve the user's own words). Runs immediately;
            // Cancel on the refresh toast does NOT undo it (text is in clipboard).
            let stopCopyDone = false;

            function lastUserMessageText() {
                          const root = document.querySelector('.scrollchatmessages') || document.body;
                          const groups = Array.from(root.querySelectorAll('div.group[data-sentry-component="ChatMessage"]'));
                          // While a generation is streaming, the LAST group is the bot's
                          // partial (it has no "Edit assistant message" button yet, so the
                          // isBot check would mislabel it). Skip the final group while
                          // generating, then take the last remaining USER message.
                          const generating = isGenerating();
                          for (let i = groups.length - 1; i >= 0; i--) {
                            if (generating && i === groups.length - 1) continue;
                            const md = groups[i].querySelector('div.markdown');
                            if (!md || !md.textContent || md.textContent.trim() === '\u200B') continue;
                            const isBot = !!groups[i].querySelector('button[aria-label="Edit assistant message"]');
                            if (!isBot) return md.textContent.trim();
                          }
                          // Fallback: no non-bot found (or not generating) — last group.
                          const last = groups[groups.length - 1];
                          const md = last && last.querySelector('div.markdown');
                          return (md && md.textContent && md.textContent.trim() !== '\u200B') ? md.textContent.trim() : '';
                        }

            function copyText(text) {
                          if (!text) return Promise.resolve(false);
                          // Try the async clipboard API; on ANY rejection fall back to the
                          // sync execCommand path. Never let a rejected promise hang the
                          // flow — cap the wait at 1s so a pending write can't race the
                          // page reload (which would lose the copy).
                          const timeout = new Promise((res) => setTimeout(() => res(false), 1000));
                          const attempt = (async () => {
                            try {
                              if (navigator.clipboard && navigator.clipboard.writeText) {
                                await navigator.clipboard.writeText(text);
                                return true;
                              }
                            } catch (_) { /* fall through to execCommand */ }
                            try {
                              const ta = document.createElement('textarea');
                              ta.value = text;
                              ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
                              document.body.appendChild(ta);
                              ta.focus(); ta.select();
                              let ok = false;
                              try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
                              ta.remove();
                              return ok;
                            } catch (_) { return false; }
                          })();
                          return Promise.race([attempt, timeout]);
                        }

            function copyUserOnStop() {
                          if (stopCopyDone) return;         // once per page load
                          stopCopyDone = true;
                          const lastUser = lastUserMessageText();
                          if (lastUser) {
                            // Copy FIRST, persist the delete intent only if the copy
                            // succeeded — and delay any reload long enough for the write.
                            copyText(lastUser).then((ok) => {
                              if (ok) {
                                try {
                                  chrome.storage.local.set({ djtfDeletePending: lastUser.slice(0, 4000) });
                                } catch (_) {}
                              }
                            });
                          }
                        }

                        // Normalize for tolerant message matching (DJ re-renders can change
                        // whitespace/smart quotes between the captured text and the reloaded
                        // DOM — exact === fails. Compare on whitespace-collapsed lowercase.)
                        function normForMatch(s) {
                          return String(s || '').toLowerCase().replace(/[^a-z0-9\u00C0-\u024F]+/g, ' ').trim();
                        }

                        // ── Post-refresh auto-delete of the copied message ──
                        // After a reload, if a delete-pending text was saved, find the
                        // matching USER message in the chat and click its own delete
                        // button (React-safe). Retry a few times in case the chat loads
                        // lazily; clear the flag once found+deleted, or after giving up.
                        let deletePendingAttempts = 0;
                        const DELETE_PENDING_MAX_ATTEMPTS = 10;

                        function findPendingUserMessage(text) {
                                                  const root = document.querySelector('.scrollchatmessages') || document.body;
                                                  const groups = Array.from(root.querySelectorAll('div.group[data-sentry-component="ChatMessage"]'));
                                                  const target = normForMatch(text);
                                                  if (!target) return null;
                                                  for (const g of groups) {
                                                    const md = g.querySelector('div.markdown');
                                                    if (!md || !md.textContent) continue;
                                                    const isBot = !!g.querySelector('button[aria-label="Edit assistant message"]');
                                                    if (isBot) continue;
                                                    if (normForMatch(md.textContent) === target) return g;
                                                  }
                                                  return null;
                                                }

                        function maybeDeletePendingMessage() {
                                                  // If the extension context was invalidated (reload/
                                                  // update while this tab was open), chrome.runtime.id
                                                  // is undefined — bail BEFORE touching any chrome.*
                                                  // API so the 2.5s safety interval can't spam
                                                  // "Extension context invalidated" errors.
                                                  try { if (!chrome.runtime || !chrome.runtime.id) return; } catch (_) { return; }
                                                  try {
                                                    chrome.storage.local.get(['djtfDeletePending'], (res) => {
                                                      try {
                                                        const pending = res && res.djtfDeletePending;
                                                        if (!pending) return;
                                                        const g = findPendingUserMessage(pending);
                                                        if (!g) {
                                                          deletePendingAttempts++;
                                                          if (deletePendingAttempts > DELETE_PENDING_MAX_ATTEMPTS) {
                                                            try { chrome.storage.local.remove(['djtfDeletePending']); } catch (_) {}
                                                            deletePendingAttempts = 0;
                                                          }
                                                          return;
                                                        }
                                                        g.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
                                                        setTimeout(() => {
                                                          try {
                                                            const trash = g.querySelector('svg.lucide.lucide-trash2, svg.lucide-trash-2');
                                                            const delBtn = trash ? trash.closest('button') : null;
                                                            if (delBtn) delBtn.click();
                                                          } catch (_) {}
                                                          try { chrome.storage.local.remove(['djtfDeletePending']); } catch (_) {}
                                                        }, 150);
                                                      } catch (_) {}
                                                    });
                                                  } catch (_) {}
                                                }

  // ── Observers ──
  const injectObs = new MutationObserver(() => {
    // Debounce injection so we don't fight React's own render bursts.
    if (injectTimer) return;
    injectTimer = setTimeout(() => { injectTimer = null; injectFixButtons(); }, 400);
  });
  let injectTimer = null;

  function start() {
        injectObs.observe(document.body, { childList: true, subtree: true });
        hookComposer();
        hookStopButton();
        setInterval(() => { injectFixButtons(); maybeEnableSend(); maybeDeletePendingMessage(); }, SAFETY_INTERVAL);
        // Initial button pass after the app has had time to settle.
        setTimeout(injectFixButtons, 4000);
        // If a delete-pending flag survived the reload, start looking for the
        // matching message (chat may load lazily).
        setTimeout(maybeDeletePendingMessage, 3000);
      }

  // ── Messaging (popup) ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try {
        switch (msg.action) {
          case 'scan':
            // If the user has Edit open right now, fix that dialog directly.
            // The dialog fix is async; resolve via .then so the listener
            // returns true immediately and the channel stays open.
            fixOpenDialog().then((res) => {
              try {
                if (res.via === 'no-dialog') injectFixButtons();
                sendResponse({ ok: true, fixed: res.fixed, via: res.via });
              } catch (_) {}
            }).catch(() => {
              try { sendResponse({ ok: true, fixed: 0, via: 'no-dialog' }); } catch (_) {}
            });
            break;
          case 'getState':
                      sendResponse({ stats, cont: continueEnabled, autoRefresh, saveOnStop });
                      break;
                    case 'setAutoRefresh':
                      autoRefresh = !!msg.value;
                      saveState();
                      sendResponse({ ok: true });
                      break;
                    case 'setSaveOnStop':
                      saveOnStop = !!msg.value;
                      saveState();
                      sendResponse({ ok: true });
                      break;
          case 'setContinue':
            continueEnabled = !!msg.value;
            saveState();
            if (continueEnabled) maybeEnableSend();
            sendResponse({ ok: true });
            break;
          case 'resetStats':
            stats = { fixed: 0, lastAt: null };
            chrome.storage.local.set({ djtfStats: stats });
            sendResponse({ ok: true });
            break;
          default:
            sendResponse({ ok: false });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return true;
    });

  loadState(() => {
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  });
})();

})();
