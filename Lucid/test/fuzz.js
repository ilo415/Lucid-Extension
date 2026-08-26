const c = require('../fixer-core.js');
const corpus = [
  '<thinking>', '</thinking>', '<thinking></thinking>', 'a<b>c',
  '```\n<thinking>\n```\n```\n</thinking>\n```',
  '<thinking>\n```\n```\n</thinking>',
  '<thinking>\n1) x\n```\n2) y\n</thinking>```\n\nReply here.',
  '> 📍Throne Room\n\nShe waits, silent. The guards watched.',
  'no tags at all, just prose. Spans multiple lines here.',
  '```\n<thinking>\n```\n',
  '<thinkiing>\n1) plan\n</thinkiing>\n\nShe turned. Snow fell outside.',
  '<!-- comment --> <thinking>plan</thinking> text',
  'a'.repeat(5000),
  '<thinking>\n1) a\n2) b\n\nShe walked into the room, closed the door quietly behind her.\nHe looked up, unsurprised.\n"About time," he said, setting his cup down.',
];
let pass = 0, fail = 0;
for (const input of corpus) {
  try {
    const r = c.rebuildMessageText(input);
    if (r && !r.ambiguous && r.text) {
      // Canonical: one open tag, one close tag, has a closing fence, starts with fence.
      const opens = (r.text.match(/<thinking>/g) || []).length;
      const closes = (r.text.match(/<\/thinking>/g) || []).length;
      const ok = opens === 1 && closes === 1 &&
        /^```[\s\S]*<\/thinking>\s*```/.test(r.text);
      if (!ok) { console.log('SHAPE FAIL:', JSON.stringify(input).slice(0,70)); console.log('  out:', JSON.stringify(r.text).slice(0,150)); fail++; }
      else pass++;
    } else pass++;
  } catch (e) { console.log('THROW:', JSON.stringify(input).slice(0,60), e.message); fail++; }
}
console.log('fuzz:', pass, 'ok,', fail, 'fail');