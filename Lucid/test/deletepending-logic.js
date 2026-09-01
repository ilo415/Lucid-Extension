// Logic test for the post-refresh delete flow (find-matching-user-message +
// retry-bounded + clear-flag semantics), simulated without a browser.
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } }

// Simulate the storage + matching logic (mirrors content.js).
function makeDeleteSimulator(sessionId) {
  let store = { djtfDeletePending: null, djtfDeleteSession: null };
  const messages = []; // {isBot, text}
  let deleted = 0;
  const mySession = sessionId || ('s' + Math.random().toString(36).slice(2, 10));

  return {
    setPending(t, session) { store.djtfDeletePending = t; store.djtfDeleteSession = session || mySession; },
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
      // CROSS-TAB GUARD: session must match this tab.
      if (store.djtfDeleteSession !== mySession) return 'other-tab';
      const g = this.findPendingUserMessage(pending);
      if (!g) return 'retry';
      deleted++;
      store.djtfDeletePending = null;
      return 'deleted';
    },
    deletedCount: () => deleted,
  };
}

(async () => {
  const s = makeDeleteSimulator('tab-A-session');

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

  // 5) CROSS-TAB: another tab sees the flag, but session doesn't match → no delete
  const tabB = makeDeleteSimulator('tab-B-session');
  tabB.addMessage(false, 'Message that tab A wants to delete');
  tabB.setPending('Message that tab A wants to delete', 'tab-A-session'); // armed in tab A
  check('tab B sees A\'s flag → other-tab (no delete)', tabB.tick() === 'other-tab');
  check('tab B deleted nothing', tabB.deletedCount() === 0);
  check('flag still present for tab A', tabB.getPending() === 'Message that tab A wants to delete');

  // 6) Same tab AFTER refresh keeps its session → deletes correctly
  // (tab A reloads: fresh page, same sessionStorage id, flag still there)
  const tabA_afterRefresh = makeDeleteSimulator('tab-A-session');
  tabA_afterRefresh.addMessage(false, 'Message that tab A wants to delete');
  tabA_afterRefresh.setPending('Message that tab A wants to delete', 'tab-A-session');
  check('tab A after refresh → deleted', tabA_afterRefresh.tick() === 'deleted');
  check('tab A after refresh deleted 1', tabA_afterRefresh.deletedCount() === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();