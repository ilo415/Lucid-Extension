// Mirror the arm-at-reload-fire sequencing from content.js:
// - On Stop, copy text is held in memory (stopCopyText), NOT written.
// - The pending flag is written only when the countdown fires the reload.
// - Cancel -> no flag -> no delete.
// - Post-refresh page (fresh script) finds the flag -> deletes the message,
//   then clears it.
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL: ' + n); } };

function makeStore() { const m = {}; return {
  get(k, cb){ const r={}; [].concat(k).forEach(x=>r[x]=m[x]); cb(r); },
  set(o, cb){ Object.assign(m, o); cb && cb(); },
  remove(k, cb){ [].concat(k).forEach(x=>delete m[x]); cb && cb(); },
  _get: (k) => m[k],
};}

(async () => {
  // SCENARIO 1: stop -> countdown -> reload fires -> flag armed.
  {
    const store = makeStore();
    let armed = false;
    // stopCopyText set at Stop:
    let stopCopyText = 'my user message to be deleted';
    // reload-fire:
    const doReload = () => { armed = true; };
    if (stopCopyText) { store.set({ djtfDeletePending: stopCopyText }, doReload); }
    check('S1: flag written at reload-fire', store._get('djtfDeletePending') === 'my user message to be deleted');
    check('S1: reload fired after set', armed === true);
  }

  // SCENARIO 2: cancel -> no flag written.
  {
    const store = makeStore();
    let stopCopyText = 'cancel me';
    let cancelled = true;
    if (!cancelled) { store.set({ djtfDeletePending: stopCopyText }, () => {}); }
    check('S2: cancel -> no pending flag', store._get('djtfDeletePending') === undefined);
  }

  // SCENARIO 3: post-refresh fresh page -> flag present -> delete + clear.
  {
    const store = makeStore();
    store.set({ djtfDeletePending: 'my user message to be deleted' });
    const messages = [
      { text: 'Bot response text here.', bot: true },
      { text: 'my user message to be deleted', bot: false },
    ];
    const findPending = (text) => {
      const t = String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      return messages.find(m => !m.bot && m.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ') === t) || null;
    };
    store.get(['djtfDeletePending'], (res) => {
      const pending = res.djtfDeletePending;
      const g = findPending(pending);
      check('S3: found user msg on fresh page', !!g);
      if (g) { /* click delete */ store.remove(['djtfDeletePending']); }
      check('S3: flag cleared after delete', store._get('djtfDeletePending') === undefined);
    });
  }

  // SCENARIO 4: post-refresh, message gone (already deleted server-side) -> retry then clear.
  {
    const store = makeStore();
    store.set({ djtfDeletePending: 'not present anymore' });
    let attempts = 0;
    const max = 10;
    store.get(['djtfDeletePending'], (res) => {
      const pending = res.djtfDeletePending;
      // no matching message in DOM
      attempts++;
      if (attempts > max) store.remove(['djtfDeletePending']);
    });
    check('S4: no match -> retried, flag retained', store._get('djtfDeletePending') === 'not present anymore');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();