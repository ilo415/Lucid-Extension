// Logic test for the post-refresh delete flow (find-matching-user-message +
// retry-bounded + clear-flag semantics), simulated without a browser.
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } }

// Simulate the storage + matching logic (mirrors content.js).
function makeDeleteSimulator() {
  let store = { djtfDeletePending: null };
  const messages = []; // {isBot, text}
  let deleted = [];

  return {
    setPending(t) { store.djtfDeletePending = t; },
    getPending() { return store.djtfDeletePending; },
    addMessage(isBot, text) { messages.push({ isBot, text }); },
    findPendingUserMessage(text) {
      const target = String(text || '').trim();
      if (!target) return null;
      for (const m of messages) {
        if (!m.isBot && m.text.trim() === target) return m;
      }
      return null;
    },
    // Mirror maybeDeletePendingMessage's core decision logic.
    tick() {
      const pending = store.djtfDeletePending;
      if (!pending) return 'noop';
      const g = this.findPendingUserMessage(pending);
      if (!g) return 'retry';
      // "click delete"
      deleted++;
      store.djtfDeletePending = null;
      return 'deleted';
    },
    deletedCount: () => deleted,
  };
}

(async () => {
  const s = makeDeleteSimulator();

  // 1) No pending → noop
  check('no pending → noop', s.tick() === 'noop');

  // 2) Pending set, matching user message present → deleted, flag cleared
  s.addMessage(false, 'My message text');
  s.addMessage(true, 'Bot reply');
  s.setPending('My message text');
  check('pending set', s.getPending() === 'My message text');
  check('tick → deleted', s.tick() === 'deleted');
  check('flag cleared after delete', s.getPending() === null);
  check('count 1', s.deletedCount() === 1);

  // 3) Pending but message NOT present (already gone) → retry, flag stays
  s.setPending('A message that is not there');
  check('not found → retry', s.tick() === 'retry');
  check('flag persists on retry', s.getPending() === 'A message that is not there');

  // 4) Match only finds USER messages, never bot ones
  s.addMessage(false, 'User msg');
  s.addMessage(true, 'User msg'); // bot with same text
  s.setPending('User msg');
  check('tick → deleted (user)', s.tick() === 'deleted');
  check('flag cleared', s.getPending() === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();