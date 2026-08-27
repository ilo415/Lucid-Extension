// ── Lucid popup ──

function flash(msg, color) {
  const s = document.getElementById('status');
  s.textContent = msg;
  s.style.color = color || '#34d399';
  setTimeout(() => { s.textContent = ''; }, 2000);
}

function send(action, value) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) return resolve(null);
      chrome.tabs.sendMessage(tabs[0].id, { action, value }, (resp) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp);
      });
    });
  });
}

function fmtTime(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function refresh() {
  const state = await send('getState');
  if (!state) {
    flash('Open a DreamJourney chat page first', '#f87171');
    return;
  }
  document.getElementById('toggle-continue').checked = state.cont !== false;
  document.getElementById('toggle-refresh').checked = state.autoRefresh !== false;
  document.getElementById('toggle-saveonstop').checked = state.saveOnStop !== false;
  document.getElementById('stat-fixed').textContent = state.stats?.fixed ?? 0;
  document.getElementById('stat-last').textContent = fmtTime(state.stats?.lastAt);
}

document.addEventListener('DOMContentLoaded', () => {
  refresh();

  document.getElementById('toggle-continue').addEventListener('change', (e) => {
    send('setContinue', e.target.checked);
    flash(e.target.checked ? 'Empty send = continue enabled' : 'Empty send disabled');
  });

  document.getElementById('toggle-refresh').addEventListener('change', (e) => {
    send('setAutoRefresh', e.target.checked);
    flash(e.target.checked ? 'Auto-refresh on Stop enabled' : 'Auto-refresh on Stop disabled');
  });

  document.getElementById('toggle-saveonstop').addEventListener('change', (e) => {
    send('setSaveOnStop', e.target.checked);
    flash(e.target.checked ? 'Copy + delete on Stop enabled' : 'Copy + delete on Stop disabled');
  });

  document.getElementById('btn-reset').addEventListener('click', async () => {
    await send('resetStats');
    refresh();
    flash('Stats reset');
  });
});
