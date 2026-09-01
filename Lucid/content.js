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
        // NOTE: marker is "notice" — NOT the bare [data-djtf-toast] which would
        // also capture the refresh countdown toast and clobber it.
        let toastTimer = null;
        function showToast(msg) {
          try {
            let el = document.querySelector('[data-djtf-toast="notice"]');
            if (!el) {
              el = document.createElement('div');
              el.setAttribute('data-djtf-toast', 'notice');
          el.style.cssText = [
            'position:fixed','bottom:200px','left:50%','transform:translateX(-50%)',
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
    const groups = root.querySelectorAll('div.group');
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
  // Text we copied on Stop; only written to storage as the refresh fires, so
  // the delete runs on the POST-refresh page — never on the arming page.
  let stopCopyText = '';
  // True from the moment this page arms the delete flag until it reloads. The
  // safety interval may tick in the window between arming and navigation, and
  // must NOT delete on the page that armed it — the fresh page does that.
  let deleteJustArmed = false;
  // Per-tab session id. sessionStorage is scoped to ONE tab and survives a
  // reload of that tab — so the fresh page after refresh has the SAME id as
  // the arming page, while OTHER tabs have a different id. The pending-delete
  // flag is tagged with this id so only the tab that armed it (and its own
  // post-refresh page) can perform the delete. Prevents cross-tab deletion
  // when roleplaying in two tabs at once.
  let tabSessionId = '';
  try {
    tabSessionId = sessionStorage.getItem('djtfTabSession');
    if (!tabSessionId) {
      tabSessionId = 's' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('djtfTabSession', tabSessionId);
    }
  } catch (_) {
    tabSessionId = 'mem' + Math.random().toString(36).slice(2, 10);
  }

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
        // Arm the post-refresh delete ONLY as we actually reload. This is the
        // page that COPIES the message; the delete must run on the fresh page.
        // If the user cancels, stopCopyText stays un-armed and nothing deletes.
        const doReload = () => { try { location.reload(); } catch (_) {} };
        if (stopCopyText) {
          try {
            // This page armed the flag — mark it so no interval tick deletes
            // here before the reload navigates.
            deleteJustArmed = true;
            // Tag the flag with THIS tab's session id so only this tab (after
            // its own refresh) can delete — other tabs never see a match.
            chrome.storage.local.set({ djtfDeletePending: stopCopyText, djtfDeleteSession: tabSessionId }, doReload);
            return; // reload happens in the set callback (guarantees persistence)
          } catch (_) { /* fall through */ }
        }
        doReload();
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

      // ── Copy on Stop ─────────────────────────────
      // On Stop, copy the user's last message to the clipboard so the
      // prompt survives the reload. Runs immediately; Cancel on the
      // refresh toast does NOT undo it (text is in clipboard).
      let stopCopyDone = false;

      // The message container. On the live DJ page, messages are
      // <div class="group ..."> WITHOUT data-sentry attributes (that was
      // a stale assumption from fixtures). Buttons carry the real labels.
      function findGroupOf(el) {
        if (!el) return null;
        return el.closest('.group') || el.parentElement;
      }
      function groupText(g) {
        if (!g) return '';
        const md = g.querySelector('div.markdown');
        if (md && md.textContent) {
          const t = md.textContent.trim();
          return (t === '\u200B') ? '' : t;
        }
        const t = (g.textContent || '').trim();
        return (t === '\u200B') ? '' : t;
      }
      // Enumerate USER message groups from the Delete/Edit/Copy user buttons.
      function userMessageGroups() {
        const root = document.querySelector('.scrollchatmessages') || document.body;
        const map = new Map();
        root.querySelectorAll(
          'button[aria-label="Delete user message"], button[aria-label="Edit user message"], button[aria-label="Copy user message"]'
        ).forEach((b) => { const g = findGroupOf(b); if (g) map.set(g, true); });
        return Array.from(map.keys());
      }
      // Enumerate bot groups for exclusion (assistant buttons).
      function botGroupSet() {
        const root = document.querySelector('.scrollchatmessages') || document.body;
        const set = new Set();
        root.querySelectorAll(
          'button[aria-label="Delete assistant message"], button[aria-label="Edit assistant message"], button[aria-label="Copy assistant message"]'
        ).forEach((b) => { const g = findGroupOf(b); if (g) set.add(g); });
        return set;
      }

      function lastUserMessageText() {
        // Pass 1: user-labeled groups. The LAST one in DOM order is the
        // user's most recent message.
        const userGroups = userMessageGroups();
        for (let i = userGroups.length - 1; i >= 0; i--) {
          const t = groupText(userGroups[i]);
          if (t) return t;
        }
        // Pass 2: no labeled groups (streaming). Crawl every .group, skip
        // bot-labeled ones, and skip the trailing unlabeled streaming
        // partial.
        const root = document.querySelector('.scrollchatmessages') || document.body;
        const all = Array.from(root.querySelectorAll('.group'));
        const bots = botGroupSet();
        const generating = isGenerating();
        for (let i = all.length - 1; i >= 0; i--) {
          if (bots.has(all[i])) continue;
          if (generating && i === all.length - 1) continue;
          const t = groupText(all[i]);
          if (t) return t;
        }
        return '';
      }

      function copyText(text) {
        if (!text) return Promise.resolve(false);
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
              if (stopCopyDone) return;
              stopCopyDone = true;
              const lastUser = lastUserMessageText();
              if (!lastUser) {
                try { showToast('\u26a0\ufe0f Couldn\u2019t find your last message to copy'); } catch (_) {}
                return;
              }
              // Hold the text; it is armed to djtfDeletePending only when the
              // refresh actually fires (see showRefreshToast), so the orphan page
              // never deletes its own message before reloading.
              stopCopyText = lastUser.slice(0, 4000);
              const willRefresh = autoRefresh;
              const tail = willRefresh ? ' \u2014 will auto-delete after refresh' : '';

              // Prefer DJ's OWN "Copy user message" button — it copies the exact
              // raw source (blank lines preserved), unlike our DOM-text
              // reconstruction which normalizes whitespace. Fall back to our
              // textarea copy only if the button isn't available.
              const userGroups = userMessageGroups();
              const lastGroup = userGroups[userGroups.length - 1];
              const copyBtn = lastGroup && lastGroup.querySelector('button[aria-label="Copy user message"]');
              if (copyBtn) {
                copyBtn.click();
                try { showToast('\u2713 Message copied' + tail); } catch (_) {}
                return;
              }

              copyText(lastUser).then((ok) => {
                try {
                  showToast(ok ? '\u2713 Message copied' + tail : 'Message NOT copied (clipboard blocked)');
                } catch (_) {}
              });
            }

      // Normalize for tolerant message matching (DJ re-renders can change
      // whitespace/smart quotes between the captured text and the reloaded
      // DOM — exact === fails. Compare on whitespace-collapsed lowercase.)
      function normForMatch(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9\u00C0-\u024F]+/g, ' ').trim();
      }

      // ── Post-refresh auto-delete of the copied message ──
      // After a reload, if a delete-pending text was saved, find the matching
      // USER message in the chat and click its own delete button (React-safe).
      // Retry a few times in case the chat loads lazily; clear the flag once
      // found+deleted, or after giving up.
      let deletePendingAttempts = 0;
      const DELETE_PENDING_MAX_ATTEMPTS = 10;

      function findPendingUserMessage(text) {
        const root = document.querySelector('.scrollchatmessages') || document.body;
        const target = normForMatch(text);
        if (!target) return null;
        // Pass 1: user-labeled groups with matching text.
        const userGroups = userMessageGroups();
        for (const g of userGroups) {
          if (normForMatch(groupText(g)) === target) return g;
        }
        // Pass 2: any non-bot .group with matching text.
        const bots = botGroupSet();
        for (const g of Array.from(root.querySelectorAll('.group'))) {
          if (bots.has(g)) continue;
          if (normForMatch(groupText(g)) === target) return g;
        }
        return null;
      }

      function maybeDeletePendingMessage() {
        // If the extension context was invalidated (reload/update while this
        // tab was open), chrome.runtime.id is undefined — bail BEFORE touching
        // any chrome.* API so the 2.5s safety interval can't spam "Extension
        // context invalidated" errors.
        try { if (!chrome.runtime || !chrome.runtime.id) return; } catch (_) { return; }
        // If THIS page armed the pending flag, don't delete here — the reload is
        // imminent and the fresh page does the delete. This page's interval must
        // never delete before navigating.
        if (deleteJustArmed) return;
        try {
          chrome.storage.local.get(['djtfDeletePending', 'djtfDeleteSession'], (res) => {
            try {
              const pending = res && res.djtfDeletePending;
              if (!pending) return;
              // CROSS-TAB GUARD: the flag is tagged with the session id of the
              // tab that armed it. If it doesn't match THIS tab, this is a
              // different tab's pending delete (user roleplaying in two tabs) —
              // never delete here. Only the owning tab (after its own refresh)
              // performs the delete.
              if (res.djtfDeleteSession !== tabSessionId) return;
              let g = findPendingUserMessage(pending);
              // If exact text matching keeps failing (the copied text can differ
              // from the post-refresh DOM — e.g. a thinking block inside the user
              // message, or markdown whitespace drift), fall back to the LAST
              // user message: the flag was armed for "the user's last message at
              // Stop time", so once the flag has survived a few attempts it's the
              // right target.
              if (!g) {
                deletePendingAttempts++;
                if (deletePendingAttempts >= 3) {
                  const userGroups = userMessageGroups();
                  if (userGroups.length) g = userGroups[userGroups.length - 1];
                }
              }
              if (!g) {
                if (deletePendingAttempts > DELETE_PENDING_MAX_ATTEMPTS) {
                  try { chrome.storage.local.remove(['djtfDeletePending']); } catch (_) {}
                  deletePendingAttempts = 0;
                }
                return;
              }
              // Click DJ's own "Delete user message" button by aria-label — far
              // more reliable than hunting the trash icon (the button exists even
              // while invisible until hover).
              const delBtn = g.querySelector('button[aria-label="Delete user message"]');
              if (!delBtn) {
                // Can't find the delete control — stop trying.
                try { chrome.storage.local.remove(['djtfDeletePending']); } catch (_) {}
                return;
              }
              delBtn.click();
              // DJ then shows a confirmation modal ("Delete Message?") with a
              // Cancel / red Delete button. Click the Delete confirm. The modal
              // renders async, so poll briefly.
              confirmDeleteDialog();
            } catch (_) { try { chrome.storage.local.remove(['djtfDeletePending']); } catch (_) {} }
          });
        } catch (_) {}
      }

      // Click the red "Delete" confirm in DJ's "Delete Message?" confirmation
      // modal. The modal is a floating dialog (Radix portal) with the heading,
      // so locate it by that heading, then click its Delete button. Poll a few
      // times because the dialog animates in.
      function confirmDeleteDialog() {
        let tries = 0;
        const MAX = 12;
        const attempt = () => {
          tries++;
          try {
            // Find the heading element exactly matching the modal title.
            let heading = null;
            document.querySelectorAll('h2').forEach((h) => {
              if (heading) return;
              const tx = (h.textContent || '').trim();
              if (tx === 'Delete Message?') heading = h;
            });
            if (!heading) { headlessRetry(); return; }
            // The modal container wraps the heading + buttons.
            const modal = heading.closest('[role="dialog"]') ||
                          heading.closest('div[class*="bg-black/90"]') ||
                          heading.parentElement;
            if (!modal) { headlessRetry(); return; }
            // Click the confirm button: red "Delete" (never "Cancel").
            const btns = Array.from(modal.querySelectorAll('button'));
            for (const b of btns) {
              const bt = (b.textContent || '').trim();
              if (bt === 'Delete') {
                b.click();
                // Done — clear the pending flag so we don't redo it.
                try { chrome.storage.local.remove(['djtfDeletePending']); } catch (_) {}
                return;
              }
            }
            headlessRetry();
          } catch (_) { headlessRetry(); }
        };
        const headlessRetry = () => {
          if (tries >= MAX) {
            // Give up on the confirm; drop the flag so we don't keep retrying forever.
            try { chrome.storage.local.remove(['djtfDeletePending']); } catch (_) {}
            return;
          }
          setTimeout(attempt, 250);
        };
        attempt();
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
