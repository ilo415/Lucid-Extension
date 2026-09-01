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

      // [BRAIN] / [BRAIN]: is model junk wherever it appears — in the thinking
      // body OR at the top of the reply prose. A well-formed block with
      // "[BRAIN]:" leaked into the response would otherwise pass the native-box
      // check below and never get a wand, leaving the marker visible. Check the
      // full message text, not just the thinking region.
      if (BRAIN_RE.test(full)) return true;

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
