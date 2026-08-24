// Logic verification for the auto-refresh flow without a browser:
// simulate the showRefreshToast guard + countdown + cancel logic.
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } }

function makeRefreshLogic() {
  let active = false;
  let reloadCalled = false;
  let toastCount = 0;

  function showToast() {  // mirrors real showRefreshToast: auto-guard, no force
    if (active) return { shown: false };  // guard: no dup while one is counting
    active = true; toastCount++;
    let left = 3, cancelled = false;
    const iv = setInterval(() => {
      if (cancelled) { clearInterval(iv); return; }
      left--;
      if (left <= 0) { clearInterval(iv); reloadCalled = true; active = false; }
    }, 50); // accelerated
    return {
      shown: true, count: () => left,
      cancel() { cancelled = true; active = false; },
    };
  }
  return { show: showToast, reloaded: () => reloadCalled, active: () => active, toasts: () => toastCount };
}

(async () => {
  const a = makeRefreshLogic();
  // 1) First show works
  const t1 = a.show();
  check('first toast shows', t1.shown === true);
  check('guard active while counting', a.active() === true);
  // 2) Second show while active → blocked (no dup)
  const t2 = a.show();
  check('second toast blocked (guard)', t2.shown === false);
  check('only one toast created', a.toasts() === 1);
  // 3) Cancel: no reload
  t1.cancel();
  check('cancel clears active', a.active() === false);
  await new Promise(r => setTimeout(r, 120));
  check('no reload after cancel', a.reloaded() === false);
  // 4) Show again, let it count down → reload fires
  const t3 = a.show();
  await new Promise(r => setTimeout(r, 200));
  check('countdown triggers reload', a.reloaded() === true);
  check('active cleared after reload', a.active() === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();