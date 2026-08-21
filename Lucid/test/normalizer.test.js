/* Unit tests for DJTFCore.normalizeThinkingBlock — run with node.
   Usage: node test/normalizer.test.js  (from the extension dir) */
const path = require('path');
const core = require(path.join(__dirname, '..', 'fixer-core.js'));
const { normalizeThinkingBlock } = core;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
  }
}

// ── 1. Well-formed — no repair ──
// NOTE: "well-formed" now means tags present AND wrapped in the code fence
// DJ needs to render a ThinkingProcess. Bare tags with no fence render as
// visible text on DJ, so a bare tagged block IS a fix candidate.
{
  const text = `<thinking>\n1) I am roleplay director.\n2) story reflection\n</thinking>`;
  const r = normalizeThinkingBlock(text);
  check('1 bare tags (no fence) → repaired (adds fence)', r.repaired, true);
  check('1 thinking content preserved', r.thinking, text);
  check('1 well-formed → no rest', r.rest, '');
}

// 1b. A truly canonical FENCED block must be left alone.
{
  const text = '```\n<thinking>\n1) plan\n2) write\n</thinking>\n```';
  const r = normalizeThinkingBlock(text);
  check('1b fenced well-formed → repaired=false', r.repaired, false);
  check('1b fenced thinking preserved', r.thinking, '<thinking>\n1) plan\n2) write\n</thinking>');
}

// ── 2. Missing closing </thinking> ──
{
  const text = `<thinking>\n1) plan\n2) write\n`;
  const r = normalizeThinkingBlock(text);
  check('2 missing closer → repaired', r.repaired, true);
  check('2 missing closer → closer appended', r.thinking.endsWith('</thinking>'), true);
  check('2 missing closer → opener intact', r.thinking.startsWith('<thinking>'), true);
}

// ── 3. Missing opening <thinking> (only closer present) ──
{
  const text = `1) plan\n2) write\n</thinking>`;
  const r = normalizeThinkingBlock(text);
  check('3 missing opener → repaired', r.repaired, true);
  check('3 missing opener → opener prepended', r.thinking.startsWith('<thinking>'), true);
  check('3 missing opener → body kept', r.thinking.includes('1) plan'), true);
}

// ── 4. </thinking> at the top (swapped) ──
{
  const text = `</thinking>\n1) plan\n2) write\n<thinking>`;
  const r = normalizeThinkingBlock(text);
  check('4 swapped → repaired', r.repaired, true);
  check('4 swapped → opener at top', r.thinking.startsWith('<thinking>'), true);
  check('4 swapped → closer at bottom', r.thinking.endsWith('</thinking>'), true);
  check('4 swapped → body between', r.thinking.includes('1) plan'), true);
}

// ── 5. Typo'd tags ──
{
  const text = `<thinkng>\n1) plan\n</thinkng>`;
  const r = normalizeThinkingBlock(text);
  check('5 typo <thinkng> → repaired', r.repaired, true);
  check('5 typo → canonical opener', r.thinking.startsWith('<thinking>'), true);
  check('5 typo → canonical closer', r.thinking.endsWith('</thinking>'), true);
}
{
  const text = `<thiking>\n1) plan\n2) more\n</thiking>`;
  const r = normalizeThinkingBlock(text);
  check('5b typo <thiking> → repaired', r.repaired, true);
  check('5b typo → canonical tags', r.thinking.startsWith('<thinking>') && r.thinking.endsWith('</thinking>'), true);
}

// ── 6. Response swallowed inside (forgot closing fence) ──
{
  const text = `<thinking>\n1) plan\n</thinking>\n\nHuahua goes still.\n\nThen she blushes.`;
  const r = normalizeThinkingBlock(text);
  check('6 swallowed response → repaired', r.repaired, true);
  check('6 swallowed response → rest kept', r.rest.includes('Huahua goes still.'), true);
  check('6 thinking contains only thinking', !r.thinking.includes('Huahua'), true);
}

// ── 7. Stray duplicate tags inside ──
{
  const text = `<thinking>\n<thinking>\n1) plan\n</thinking>`;
  const r = normalizeThinkingBlock(text);
  check('7 double open → repaired', r.repaired, true);
  check('7 double open → single opener', (r.thinking.match(/<thinking>/g) || []).length, 1);
  check('7 double open → body kept once', r.thinking.includes('1) plan'), true);
}

// ── 8. Not a thinking message ──
{
  check('8 no tags → null', normalizeThinkingBlock('Just a normal reply, nothing weird here.'), null);
  check('8b other tags only → null', normalizeThinkingBlock('<b>bold</b> and <i>italic</i> text'), null);
}

// ── 9. Fence lines hugging the block ──
{
  const text = '```\n<thinking>\n1) plan\n</thinking>\n```';
  const r = normalizeThinkingBlock(text);
  check('9 fenced → repaired=false (already fine)', r.repaired, false);
  check('9 fenced → thinking has no stray fences', !r.thinking.includes('```'), true);
}

// ── 10. Premature closer then content, closing tag at top variant ──
{
  // Model: </thinking> then the thinking content then <thinking> then response
  const text = `</thinking>\n1) plan\n2) write\n<thinking>\n\nHuahua reacts.`;
  const r = normalizeThinkingBlock(text);
  check('10 closer-at-top w/ response → repaired', r.repaired, true);
  check('10 → body correct', r.thinking.includes('1) plan'), true);
  check('10 → response preserved', r.rest.includes('Huahua reacts.'), true);
}

// ── 11. [BRAIN] junk markers ──
{
  // [BRAIN]: glued to the fence before the opener
  const text = `[BRAIN]:\`\`\`\n<thinking>\n1) plan\n2) write\n</thinking>\n\`\`\``;
  const r = normalizeThinkingBlock(text);
  check('11 [BRAIN]: prefix → repaired', r.repaired, true);
  check('11 [BRAIN] not in output', !r.thinking.includes('[BRAIN]'), true);
  check('11 body kept', r.thinking.includes('1) plan'), true);
}
{
  // [BRAIN] inside the thinking body
  const text = `<thinking>\n[BRAIN]\n1) plan\n</thinking>`;
  const r = normalizeThinkingBlock(text);
  check('11b [BRAIN] in body → repaired', r.repaired, true);
  check('11b [BRAIN] stripped from body', !r.thinking.includes('[BRAIN]'), true);
  check('11b body kept', r.thinking.includes('1) plan'), true);
}
{
  // [BRAIN]: at top of reply, no opening tag, only closer
  const text = `[BRAIN]:\`\`\`\n1) plan\n2) write\n</thinking>`;
  const r = normalizeThinkingBlock(text);
  check('11c [BRAIN] + missing opener → repaired', r.repaired, true);
  check('11c opener prepended', r.thinking.startsWith('<thinking>'), true);
  check('11c [BRAIN] stripped', !r.thinking.includes('[BRAIN]'), true);
}

// ── 12. rebuildMessageText (raw source → canonical fenced form) ──
{
  const c = require('../fixer-core.js');
  // Malformed: </thinking> at top, content after — the "reverse logic" case
  // Nebula handles by cutting everything before the closing tag.
  const raw = `</thinking>\n1) plan\n2) write\n<thinking>\n\nHuahua reacts.`;
  const r = c.rebuildMessageText(raw);
  check('12 raw swapped → rebuilt', !!r, true);
  check('12 fenced opener', r?.text.startsWith('```\n<thinking>'), true);
  check('12 fenced closer', r?.text.includes('\n</thinking>\n```'), true);
  check('12 response preserved', r?.text.includes('Huahua reacts.'), true);
  check('12 no [BRAIN] in output', !r?.text.includes('[BRAIN]'), true);
}
{
  const c = require('../fixer-core.js');
  // Missing closing fence: thinking + response raw in one text (dialog case).
  const raw = `\`\`\`<thinking>\n1) plan\n2) write\n</thinking>\n\n**Huahua goes still.**`;
  const r = c.rebuildMessageText(raw);
  check('12b raw missing-fence → rebuilt', !!r, true);
  check('12b response kept after block', r?.text.includes('**Huahua goes still.**'), true);
  check('12b block fenced canonically', r?.text.startsWith('```\n<thinking>') && r?.text.includes('\n</thinking>\n```'), true);
}
{
  const c = require('../fixer-core.js');
  // Already well-formed → nothing to do (null).
  const raw = `\`\`\`<thinking>\n1) plan\n2) write\n</thinking>\`\`\`\n\nHuahua reacts.`;
  const r = c.rebuildMessageText(raw);
  check('12c well-formed source → null (no rebuild)', r, null);
}
{
  const c = require('../fixer-core.js');
  // Source with a [BRAIN]: prefix before the fence → cleaned + rebuilt.
  const raw = `[BRAIN]:\`\`\`\n<thinking>\n1) plan\n</thinking>\n\`\`\`\n\nHuahua reacts.`;
  const r = c.rebuildMessageText(raw);
  check('12d [BRAIN] prefix → rebuilt', !!r, true);
  check('12d [BRAIN] gone', !r?.text.includes('[BRAIN]'), true);
}

// ── 13. Nested/duplicated opener (David's `<thinking>```\n<thinking>` case) ──
{
  const c = require('../fixer-core.js');
  const raw = `<thinking>\n\`\`\`\n<thinking>\n1) plan\n2) write\n</thinking>`;
  const norm = c.normalizeThinkingBlock(raw);
  check('13 nested opener detected', !!norm, true);
  check('13 repaired', norm?.repaired, true);
  check('13 single opener in output', (norm?.thinking.match(/<thinking>/g) || []).length, 1);
  check('13 no stray fence', !norm?.thinking.includes('```'), true);
  check('13 body kept', norm?.thinking.includes('1) plan'), true);

  const rebuilt = c.rebuildMessageText(raw);
  check('13b rebuild → fenced canonical', rebuilt?.text.startsWith('```\n<thinking>'), true);
  check('13b rebuild → fence not nested', !rebuilt?.text.includes('<thinking>\n```'), true);
}
{
  const c = require('../fixer-core.js');
  // Same but with a trailing fence inside too
  const raw = `<thinking>\n\`\`\`\n<thinking>\n1) plan\n</thinking>\n\`\`\``;
  const rebuilt = c.rebuildMessageText(raw);
  check('13c rebuild w/ trailing fence → canonical', !!rebuilt, true);
  check('13c single open in body', (rebuilt?.text.match(/<thinking>/g) || []).length, 1);
  check('13c response empty', rebuilt?.text.includes('1) plan'), true);
}
{
  const c = require('../fixer-core.js');
  // Health check: the nested case is UNHEALTHY, a clean box is HEALTHY.
  check('13d nested content unhealthy', c.isHealthyThinkingText(`<thinking>\n\`\`\`\n<thinking>\n1) plan\n</thinking>`), false);
  check('13e clean content healthy', c.isHealthyThinkingText(`<thinking>\n1) plan\n2) write\n</thinking>`), true);
  check('13f [BRAIN] content unhealthy', c.isHealthyThinkingText(`<thinking>\n[BRAIN]\n1) plan\n</thinking>`), false);
  check('13g no-tags content unhealthy', c.isHealthyThinkingText(`just prose`), false);
}

// ── 14. Stray fence inside the thinking body ──
// (David's new case: "<thinking>\n\n\n```\n1) I am roleplay director…")
{
  const c = require('../fixer-core.js');
  const raw = `<thinking>\n\n\n\`\`\`\n1) I am roleplay director.\n\n2) story reflection\n\n</thinking>`;
  const norm = c.normalizeThinkingBlock(raw);
  check('14 stray inner fence → detected', !!norm, true);
  check('14 repaired (not swallowed by strip)', norm?.repaired, true);
  check('14 body kept', norm?.thinking.includes('1) I am roleplay director.'), true);
  check('14 no fence in output', !norm?.thinking.includes('```'), true);
  check('14 single opener', (norm?.thinking.match(/<thinking>/g) || []).length, 1);

  const rebuilt = c.rebuildMessageText(raw);
  check('14b rebuild fires', !!rebuilt, true);
  check('14b canonical fenced', rebuilt?.text.startsWith('```\n<thinking>'), true);
  check('14b stray fence gone', !rebuilt?.text.includes('<thinking>\n\n\n```'), true);
  check('14b content intact', rebuilt?.text.includes('2) story reflection'), true);
}
{
  const c = require('../fixer-core.js');
  // Control: a genuinely well-formed fenced block must NOT be flagged.
  const raw = `\`\`\`\n<thinking>\n1) plan\n2) write\n</thinking>\n\`\`\`\n\nHuahua reacts.`;
  const r = c.rebuildMessageText(raw);
  check('14c well-formed control → null (no rebuild)', r, null);
}
{
  const c = require('../fixer-core.js');
  // Health check: stray-fence content is unhealthy, plain content is healthy.
  check('14d fence content unhealthy', c.isHealthyThinkingText(`<thinking>\n\n\n\`\`\`\n1) plan\n</thinking>`), false);
  check('14e plain content healthy', c.isHealthyThinkingText(`<thinking>\n1) plan\n2) write\n</thinking>`), true);
}

// ── 15. Fence-placement matrix ──
// Every combination of ``` fences around <thinking>BODY</thinking>.
// Rule: a fence OUTSIDE the tags (before opener / after closer) is the
// canonical wrapper and needs no repair; a fence INSIDE (after opener /
// before closer / mid-body) is malformed and must be stripped + rebuilt.
{
  const c = require('../fixer-core.js');
  const BODY = '1) plan\n2) write';

  const cases = [
    // [name, raw, expectRebuild]
    ['no fences', `<thinking>\n${BODY}\n</thinking>`, true],
    ['fence before opener', '```\n<thinking>\n' + BODY + '\n</thinking>', false],
    ['fence after closer', `<thinking>\n${BODY}\n</thinking>\n\`\`\``, true],
    ['both outside', '```\n<thinking>\n' + BODY + '\n</thinking>\n```', false],
    ['fence after opener', `<thinking>\n\`\`\`\n${BODY}\n</thinking>`, true],
    ['fence before closer', `<thinking>\n${BODY}\n\`\`\`\n</thinking>`, true],
    ['fence after opener + before closer', `<thinking>\n\`\`\`\n${BODY}\n\`\`\`\n</thinking>`, true],
    ['fence before opener + after opener', '```\n<thinking>\n```\n' + BODY + '\n</thinking>', true],
    ['fence before closer + after closer', `<thinking>\n${BODY}\n\`\`\`\n</thinking>\n\`\`\``, true],
    ['fence mid-body', `<thinking>\n1) plan\n\`\`\`\n2) write\n</thinking>`, true],
    ['all four positions', '```\n<thinking>\n```\n' + BODY + '\n```\n</thinking>\n```', true],
    ['missing opener + fence', '```\n' + BODY + '\n</thinking>', true],
    ['missing closer + fence', `<thinking>\n${BODY}\n\`\`\``, true],
    ['[BRAIN]: + fences', '[BRAIN]:```\n<thinking>\n' + BODY + '\n</thinking>\n```', true],
  ];

  for (const [name, raw, expectRebuild] of cases) {
    const rebuilt = c.rebuildMessageText(raw);
    const didRebuild = !!rebuilt;
    let ok = didRebuild === expectRebuild;
    if (didRebuild) {
      const t = rebuilt.text;
      const opens = (t.match(/<thinking>/g) || []).length;
      const closes = (t.match(/<\/thinking>/g) || []).length;
      const innerFence = t.includes('<thinking>\n```') || t.includes('\n```\n</thinking>');
      // Compare body on whitespace-normalized lines (fence removal can leave
      // blank lines where the fence was).
      const norm = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
      const bodyOk = norm(t) === norm('```\n<thinking>\n' + BODY + '\n</thinking>\n```');
      ok = ok && opens === 1 && closes === 1 && !innerFence && bodyOk;
    }
    check(`15 ${name} → ${expectRebuild ? 'rebuild' : 'leave'}`, ok, true);
    if (!ok) console.log(`       raw: ${JSON.stringify(raw)}\n       out: ${JSON.stringify(rebuilt?.text)}`);
  }
}

// ── 16. Tag-variant matrix (positions × tag problems) ──
// Same fence positions but with typo'd/missing/swapped/dup tags — every
// one of these must rebuild to a single canonical block.
{
  const c = require('../fixer-core.js');
  const BODY = '1) plan\n2) write';

  const cases = [
    ['typo opener <thinkng>', `<thinkng>\n${BODY}\n</thinking>`],
    ['typo closer </thinkng>', `<thinking>\n${BODY}\n</thinkng>`],
    ['typo both', `<thinkng>\n${BODY}\n</thinkng>`],
    ['missing opener', `${BODY}\n</thinking>`],
    ['missing closer', `<thinking>\n${BODY}`],
    ['swapped', `</thinking>\n${BODY}\n<thinking>`],
    ['double opener', `<thinking>\n<thinking>\n${BODY}\n</thinking>`],
    ['double closer', `<thinking>\n${BODY}\n</thinking>\n</thinking>`],
    ['double both', `<thinking>\n<thinking>\n${BODY}\n</thinking>\n</thinking>`],
    ['typo opener + inner fence', `<thinkng>\n\`\`\`\n${BODY}\n</thinkng>`],
    ['swapped + fence', `</thinking>\n${BODY}\n<thinking>\n\`\`\``],
    ['missing opener + [BRAIN]', `[BRAIN]:\n${BODY}\n</thinking>`],
    ['<think> short tag', `<think>\n${BODY}\n</think>`],
  ];

  for (const [name, raw] of cases) {
    const rebuilt = c.rebuildMessageText(raw);
    const ok = !!rebuilt &&
      (rebuilt.text.match(/<thinking>/g) || []).length === 1 &&
      (rebuilt.text.match(/<\/thinking>/g) || []).length === 1 &&
      !rebuilt.text.includes('```\n```') &&
      rebuilt.text.includes(BODY);
    check(`16 ${name} → canonical rebuild`, ok, true);
    if (!ok) console.log(`       raw: ${JSON.stringify(raw)}\n       out: ${JSON.stringify(rebuilt?.text)}`);
  }
}

// ── 17. Combination stress cases ──
{
  const c = require('../fixer-core.js');
  const BODY = '1) plan\n2) write';
  const cases = [
    // [name, raw, expectRebuild]
    ['inner fences + response after', `<thinking>\n\`\`\`\n${BODY}\n\`\`\`\n</thinking>\n\nHuahua reacts.`, true],
    ['all-four + response', '```\n<thinking>\n```\n' + BODY + '\n```\n</thinking>\n```\n\nHuahua reacts.', true],
    ['typo + swapped + [BRAIN]', `[BRAIN]:\`\`\`\n</thinkng>\n${BODY}\n<thinkng>\n\`\`\``, true],
    ['fence inside + missing closer', `<thinking>\n\`\`\`\n${BODY}\n\`\`\``, true],
    ['double fence lines', `<thinking>\n\`\`\`\n\`\`\`\n${BODY}\n\`\`\`\n</thinking>`, true],
    ['fence + [BRAIN] + response', `<thinking>\n\`\`\`\n[BRAIN]\n${BODY}\n</thinking>\n\nShe looks up.`, true],
    ['spaces around fence', `<thinking>\n\`\`\` \n${BODY}\n \`\`\`\n</thinking>`, true],
  ];

  for (const [name, raw, expectRebuild] of cases) {
    const rebuilt = c.rebuildMessageText(raw);
    const didRebuild = !!rebuilt;
    let ok = didRebuild === expectRebuild;
    if (didRebuild) {
      const t = rebuilt.text;
      const opens = (t.match(/<thinking>/g) || []).length;
      const closes = (t.match(/<\/thinking>/g) || []).length;
      const innerFence = t.includes('<thinking>\n```') || t.includes('\n```\n</thinking>');
      const norm = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
      const bodyOk = norm(t).includes(norm(BODY));
      ok = ok && opens === 1 && closes === 1 && !innerFence && bodyOk;
    }
    check(`17 ${name} → ${expectRebuild ? 'rebuild' : 'leave'}`, ok, true);
    if (!ok) console.log(`       raw: ${JSON.stringify(raw)}\n       out: ${JSON.stringify(rebuilt?.text)}`);
  }
}

// ── 18. Response-body preservation through rebuilds ──
// Whatever the fence mess, the actual RP response after the block must
// survive the rebuild intact.
{
  const c = require('../fixer-core.js');
  const RESP = 'Huahua goes still.\n\nThen she blushes.\n\n[End of Turn]';
  const cases = [
    `<thinking>\n\`\`\`\n1) plan\n</thinking>\n\n${RESP}`,
    `[BRAIN]:\`\`\`\n<thinking>\n1) plan\n</thinking>\n\`\`\`\n\n${RESP}`,
    `<thinking>\n1) plan\n\`\`\`\n</thinking>\n\n${RESP}`,
  ];
  for (const raw of cases) {
    const rebuilt = c.rebuildMessageText(raw);
    const ok = !!rebuilt && rebuilt.text.includes(RESP);
    check(`18 response preserved → ${JSON.stringify(raw.slice(0, 40))}…`, ok, true);
    if (!ok) console.log(`       out: ${JSON.stringify(rebuilt?.text)}`);
  }
}

// ── 19. Tag misspelling spectrum ──
// Every way the <thinking> / </thinking> word itself can be mangled. The
// matcher is broad by design because these tags only surround the thinking
// block — permissive matching is safe, the rebuild normalizes.
{
  const c = require('../fixer-core.js');
  const BODY = '1) plan\n2) write';

  const openVariants = [
    '<thinking>', '<think>', '<thinkg>', '<thik>', '<tink>', '<thing>',
    '<thinkng>', '<thinkking>', '<thiking>', '<thnking>', '<thikng>',
    '<thinkin>', '<tinking>', '<thi nk>', '< thinking >', '< THINKING >',
  ];
  const closeVariants = openVariants.map((t) => t.replace('<', '</'));

  // "Canonical" tag spellings (possibly with spaces/case): the tag itself is
  // fine, but a BARE tagged block still needs its fence wrapper added (bare
  // <thinking> renders as visible text on DJ). So these rebuild to the fenced
  // canonical form, not null.
  const canonical = ['<thinking>', '< thinking >', '< THINKING >'];
  const misspelled = [
    ' thinking', '<thinkg>', '<thik>', '<tink>',
    '<thinkng>', '<thinkking>', '<thiking>', '<thnking>', '<thikng>',
    '<thinkin>', '<tinking>', '<thi nk>',
  ];

  for (const open of canonical) {
    const raw = `${open}\n${BODY}\n</thinking>`;
    const rebuilt = c.rebuildMessageText(raw);
    const ok = !!rebuilt &&
      rebuilt.text.startsWith('```\n<thinking>') &&
      (rebuilt.text.match(/<thinking>/g) || []).length === 1 &&
      (rebuilt.text.match(/<\/thinking>/g) || []).length === 1 &&
      rebuilt.text.includes(BODY);
    check(`19 open ${JSON.stringify(open)} → fenced canonical`, ok, true);
    if (!ok) console.log(`       out: ${JSON.stringify(rebuilt?.text)}`);
  }
  for (const open of misspelled) {
    const raw = `${open}\n${BODY}\n</thinking>`;
    const rebuilt = c.rebuildMessageText(raw);
    const ok = !!rebuilt &&
      rebuilt.text.startsWith('```\n<thinking>') &&
      (rebuilt.text.match(/<thinking>/g) || []).length === 1 &&
      (rebuilt.text.match(/<\/thinking>/g) || []).length === 1 &&
      rebuilt.text.includes(BODY);
    check(`19 open ${JSON.stringify(open)} → canonical`, ok, true);
    if (!ok) console.log(`       raw: ${JSON.stringify(raw)}\n       out: ${JSON.stringify(rebuilt?.text)}`);
  }
  // Near-words that merely neighbor "think" must NOT be thinking tags —
  // they'd produce false positives on prose (e.g. "<thing>" in a reply).
  const nearWords = ['thing', 'third', 'thick', 'thin', 'thine', 'thigh', 'thief', 'thorn', 'than', 'then', 'them', 'this', 'that'];
  for (const w of nearWords) {
    check(`19n near-word ${JSON.stringify(w)} → NOT a thinking tag`, c.isThinkingTag(w), false);
  }
  // But real misspellings of "thinking" still count.
  check('19n thinkg → thinking tag', c.isThinkingTag('thinkg'), true);
  check('19n thnking → thinking tag', c.isThinkingTag('thnking'), true);
  check('19n thinkk → thinking tag', c.isThinkingTag('thinkk'), true);
  check('19n thikingg → thinking tag', c.isThinkingTag('thikingg'), true);
  check('19n tihnking → thinking tag', c.isThinkingTag('tihnking'), true);

  for (const close of closeVariants) {
    if (!/<\/.*>/.test(close)) continue;
    const raw = `<thinking>\n${BODY}\n${close}`;
    const rebuilt = c.rebuildMessageText(raw);
    // Bare tagged block (no opening fence) always rebuilds to the fenced
    // canonical form, whether the closer is canonical or typo'd.
    const ok = !!rebuilt &&
      rebuilt.text.startsWith('```\n<thinking>') &&
      (rebuilt.text.match(/<thinking>/g) || []).length === 1 &&
      (rebuilt.text.match(/<\/thinking>/g) || []).length === 1 &&
      rebuilt.text.includes(BODY);
    check(`19 close ${JSON.stringify(close)} → fenced canonical`, ok, true);
    if (!ok) console.log(`       out: ${JSON.stringify(rebuilt?.text)}`);
  }
}

// ── 20. Both tags missing, NO fences (tagless + fenceless) ──
// No <thinking> tags and no fences at all → there are no reliable
// delimiters, so there is nothing to fix (no guessing from content).
{
  const c = require('../fixer-core.js');

  const norm = c.normalizeThinkingBlock("1) I am roleplay director.\n\n2) story reflection\nHuahua goes still.");
  check('20 tagless + fenceless → nothing to fix', !!norm, false);
  const r = c.rebuildMessageText("1) I am roleplay director.\n\n2) story reflection\nHuahua goes still.");
  check('20 tagless + fenceless rebuild → null', r === null, true);

  // A normal RP reply must not be touched either.
  const norm2 = c.normalizeThinkingBlock("She smiles at the afternoon sun.");
  check('20c normal reply → no thinking', !!norm2, false);
}

// ── 21. Single-tag-missing (opener OR closer) with a reply after ──
{
  const c = require('../fixer-core.js');
  const RESP = '> 📍Throne Room | 🕐12:18 PM\n> 👤Nathan — 👕robe\nHuahua goes still.\n\nThen she blushes.';

  // Missing opener, closer present, reply follows → body before </thinking>,
  // response preserved.
  const mo = c.rebuildMessageText('1) I am roleplay director.\n2) story reflection\n</thinking>\n\n' + RESP);
  check('21 missing opener → rebuilt', !!mo, true);
  check('21 missing opener → opener added', mo?.text.startsWith('```\n<thinking>'), true);
  check('21 missing opener → response preserved', mo?.text.includes('Huahua goes still.'), true);
  check('21 missing opener → response not in block',
    mo ? !mo.text.includes('Huahua goes still.\n</thinking>') : false, true);

  // Missing closer, opener present, reply follows (CAS-style text).
  // CAS headers are NO LONGER a boundary (per-user convention, removed like
  // SEER), so without a closing fence the reply absorbs into the block.
  const mc = c.rebuildMessageText('<thinking>\n1) I am roleplay director.\n2) story reflection\n\n' + RESP);
  check('21 missing closer → rebuilt', !!mc, true);
  check('21 missing closer → closer added', mc ? mc.text.includes('</thinking>') : false, true);
  check('21 missing closer → CAS not a boundary, reply absorbed', mc ? mc.text.includes('Then she blushes.\n</thinking>') : false, true);

  // Missing closer, reply begins with the SEER end marker. SEER is no longer
  // a boundary signal (director templates vary, not in bot replies), so this
  // case has no fence/CAS marker → the whole text is treated as thinking.
  const mseer = c.rebuildMessageText('<thinking>\n1) I am roleplay director.\nc) i will start the synergized response below.\n\nHuahua reacts.');
  check('21 missing closer + SEER marker → rebuilt (whole text is block)', !!mseer, true);
  check('21 missing closer + no CAS/fence → response absorbed into block',
    mseer ? mseer.text.includes('Huahua reacts.\n</thinking>') : false, true);

  // Missing closer, NO reply after (pure thinking) → whole thing is the block.
  const nop = c.rebuildMessageText('<thinking>\n1) plan\n2) write');
  check('21 missing closer, no reply → rebuilt', !!nop, true);
  check('21 missing closer, no reply → all in block', nop?.text.includes('1) plan\n2) write\n</thinking>'), true);
}

// ── 22. Fence-as-boundary (tag missing, fence present) ──
{
  const c = require('../fixer-core.js');

  // Missing CLOSER tag but closer fence present → fence is the boundary.
  const a = c.rebuildMessageText('<thinking>\n1) I am roleplay director.\n2) story reflection\n```\n\nHuahua reacts.');
  check('22 missing closer + closer fence → rebuilt', !!a, true);
  check('22 closer fence = boundary → response preserved', a?.text.includes('Huahua reacts.'), true);
  check('22 closer fence outside block', a ? a.text.indexOf('Huahua reacts.') > a.text.indexOf('</thinking>') : false, true);

  // Missing OPENER tag but opener fence present → fence starts the block.
  const b = c.rebuildMessageText('```\n1) I am roleplay director.\n2) story reflection\n</thinking>\n\nHuahua reacts.');
  check('22 missing opener + opener fence → rebuilt', !!b, true);
  check('22 opener fence consumed, opener added', b?.text.startsWith('```\n<thinking>'), true);
  check('22 response preserved', b?.text.includes('Huahua reacts.'), true);

  // Both a stray opener-fence AND a closer fence, closer tag missing.
  const cc = c.rebuildMessageText('<thinking>\n```\n1) I am roleplay director.\n2) story reflection\n```\n\nHuahua reacts.');
  check('22 stray opener-fence + closer fence → rebuilt', !!cc, true);
  check('22 stray opener-fence skipped', cc ? !cc.text.includes('<thinking>\n```') : false, true);
  check('22 response preserved', cc?.text.includes('Huahua reacts.'), true);

  // Missing closer, NO fence marker → ambiguous, whole text becomes the
  // block (no boundary signal exists — honest fallback).
  const dd = c.rebuildMessageText('<thinking>\n1) I am roleplay director.\n2) story reflection\n\nHuahua reacts.');
  check('22 no markers → ambiguous, all-in-block', dd?.text.includes('Huahua reacts.\n</thinking>'), true);

  // Missing opener tag + opener fence + closer tag.
  const ff = c.rebuildMessageText('```\n1) I am roleplay director.\n2) story reflection\n</thinking>\n\nHuahua reacts.');
  check('22 missing opener, fence + closer tag → rebuilt', !!ff, true);
  check('22 response preserved', ff?.text.includes('Huahua reacts.'), true);
}

// ── 23. Curly quote normalization (dialogue highlight fix) ──
{
  const c = require('../fixer-core.js');

  // Detection
  check('23 curly double detected', c.hasCurlyQuotes('He said \u201CAlways do.\u201D'), true);
  check('23 curly single detected', c.hasCurlyQuotes('don\u2019t'), true);
  check('23 straight not flagged', c.hasCurlyQuotes('He said "Always do."'), false);

  // normalizeQuotes mapping
  check('23 curly double → straight', c.normalizeQuotes('\u201CHello\u201D') === '"Hello"', true);
  check('23 curly single → straight', c.normalizeQuotes('\u2018Hi\u2019') === "'Hi'", true);
  check('23 apostrophe → straight', c.normalizeQuotes('don\u2019t') === "don't", true);
  check('23 low-9 doubles → straight', c.normalizeQuotes('\u201EHi\u201C') === '"Hi"', true);

  // Healthy canonical block + curly quotes → still rebuilt (quote fix only).
  const hq = c.rebuildMessageText('```\n<thinking>\n1) plan\n</thinking>\n```\n\nHe whispered \u201CAlways do.\u201D');
  check('23 healthy block + curly → rebuilt', !!hq, true);
  check('23 quotes normalized in output', hq ? !hq.text.includes('\u201C') && !hq.text.includes('\u201D') : false, true);
  check('23 thinking block preserved', hq?.text.includes('<thinking>\n1) plan\n</thinking>'), true);

  // The exact "Always do" failure: opening quote straight, closing curly.
  const ad = c.rebuildMessageText('```\n<thinking>\n1) plan\n</thinking>\n```\n\n\u201CYou feel so good,\u201D he said. \u201CAlways do.\u201D');
  check('23 mixed pair → both normalized', ad ? !/[\u201C\u201D]/.test(ad.text) : false, true);

  // Malformed block + curly quotes → both fixed together.
  const mq = c.rebuildMessageText('<thinking>\n1) plan\n\n\u201CAlways do.\u201D');
  check('23 malformed + curly → rebuilt', !!mq, true);
  check('23 malformed + curly → quotes fixed', mq ? !mq.text.includes('\u201C') : false, true);
  check('23 malformed + curly → closer added', mq?.text.includes('</thinking>'), true);

  // Healthy + straight quotes → null (nothing to do).
  const ok = c.rebuildMessageText('```\n<thinking>\n1) plan\n</thinking>\n```\n\nHe said "Always do."');
  check('23 healthy + straight → no rebuild', ok === null, true);
}

// ── 24. Fences only, no tags (the pure fenced block) ──
{
  const c = require('../fixer-core.js');

  // Classic: ```\ncontent\n``` with no <thinking> tags anywhere.
  const f1 = c.rebuildMessageText('```\n1) I am roleplay director.\n2) story reflection\n```');
  check('24 fenced only → rebuilt', !!f1, true);
  check('24 fenced only → tags added', f1?.text.startsWith('```\n<thinking>') && f1?.text.includes('</thinking>\n```'), true);
  check('24 fenced only → content preserved', f1?.text.includes('1) I am roleplay director.'), true);

  // Fenced block + response after it.
  const f2 = c.rebuildMessageText('```\n1) plan\n2) write\n```\n\nHuahua reacts.');
  check('24 fenced + response → rebuilt', !!f2, true);
  check('24 fenced + response → response preserved outside', f2?.text.includes('Huahua reacts.') && f2.text.indexOf('Huahua reacts.') > f2.text.indexOf('</thinking>'), true);

  // Fenced block with director-style reasoning inside + a response after.
  const f3 = c.rebuildMessageText('```\n1) I am roleplay director.\n2) "story reflection"\na) latest event: X.\n4) "writing plan"\nc) i will start the synergized response below.\n```\n\nHuahua goes still.');
  check('24 fenced reasoning block → rebuilt', !!f3, true);
  check('24 fenced reasoning → content inside block', f3?.text.includes('below.\n</thinking>'), true);
  check('24 fenced reasoning → response preserved', f3?.text.includes('Huahua goes still.'), true);

  // Already canonical → null (no tags, but this IS the canonical form after a
  // prior fix — fenced with tags inside; the canonical regex catches it).
  const f4 = c.rebuildMessageText('```\n<thinking>\n1) plan\n</thinking>\n```');
  check('24 canonical with tags → no rebuild', f4 === null, true);
}

// ── 25. Fused fences (stray ``` glued to content) ──
{
  const c = require('../fixer-core.js');

  // A stray ``` fused to the first content line inside a tagged block
  // (David's "```SYSTEM PROCESS" case).
  const fused = c.rebuildMessageText('```\n<thinking>\n```SYSTEM PROCESS — RUN\nSTEP 1: plan\n</thinking>\n```');
  check('25 fused fence at start → rebuilt', !!fused, true);
  check('25 fused fence removed', fused ? !fused.text.includes('```SYSTEM') : false, true);
  check('25 content preserved', fused?.text.includes('SYSTEM PROCESS — RUN\nSTEP 1: plan'), true);

  // Fused fence mid-body (a ``` glued to a later line, not the first).
  const fusedMid = c.rebuildMessageText('<thinking>\nSTEP 1: plan\n```DECISION: go\nSTEP 2: check\n</thinking>');
  check('25 fused fence mid-body → rebuilt', !!fusedMid, true);
  check('25 fused fence mid-body removed', fusedMid ? !/```[A-Za-z]/.test(fusedMid.text) : false, true);

  // Tagless fenced block with a fused inner fence.
  const fusedTagless = c.rebuildMessageText('```\nSTEP 1: plan\n```DECISION: go\n```\n\nHuahua reacts.');
  check('25 tagless fused fence → rebuilt', !!fusedTagless, true);
  check('25 tagless fused fence removed', fusedTagless ? !/```[A-Za-z]/.test(fusedTagless.text) : false, true);
  check('25 tagless response preserved', fusedTagless?.text.includes('Huahua reacts.'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);