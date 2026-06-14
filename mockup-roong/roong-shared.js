// ---------------------------------------------------------------------------
// Shared Roong-settlement logic for the redesign previews.
// This is the REAL page logic (helpers, state, actions, listeners, history),
// lifted verbatim from roong_settlement.html. Each option HTML supplies its
// own render() + CSS, then calls loadAll(). Interactive hooks (data-idx,
// data-type, ids) are kept identical so every feature works the same way.
// ---------------------------------------------------------------------------

// ----- Helpers -------------------------------------------------------------
function fmtBaht(n) {
  const v = parseFloat(n) || 0;
  return '฿' + (v === Math.round(v) ? Math.round(v).toLocaleString() : v.toFixed(2));
}
function stripRoong(s) {
  return (s || '')
    .replace(/\s+with\s+roong\s*$/i, '')
    .replace(/\s+w\/?\s*roong\s*$/i, '')
    .trim();
}
function fmtDateShort(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', {day:'numeric', month:'short'});
  } catch { return iso; }
}
function fmtDateRange(rows) {
  const dates = rows.map(r => r.Date).filter(Boolean).sort();
  if (!dates.length) return '';
  const s = fmtDateShort(dates[0]);
  const e = fmtDateShort(dates[dates.length - 1]);
  return s === e ? s : `${s} – ${e}`;
}
function buildShareableText(rows, shareMap) {
  const sorted = [...rows].sort((a,b) => (a.Date||'') < (b.Date||'') ? -1 : 1);
  const dateRange = fmtDateRange(sorted);
  let lines = [`Date: ${dateRange}`, ''];
  let total = 0;
  for (const r of sorted) {
    const share = shareMap[r.RefID] || 0;
    total += share;
    const shareStr = share === Math.round(share) ? `฿${Math.round(share)}` : `฿${share.toFixed(2)}`;
    lines.push(`* ${fmtDateShort(r.Date)} ${stripRoong(r.Description)} - your share: ${shareStr}`);
  }
  lines.push('---');
  const totStr = total === Math.round(total) ? `฿${Math.round(total)}` : `฿${total.toFixed(2)}`;
  lines.push(`Total amount: ${totStr}`);
  return lines.join('\n');
}
let toastTimer;
function showToast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function mapUnsettled(rows) {
  return rows
    .map(r => ({...r, _pct: 50, _share: parseFloat(r.Amount || 0) * 0.5, _checked: true}))
    .sort((a, b) => (a.Date || '') < (b.Date || '') ? -1 : (a.Date || '') > (b.Date || '') ? 1 : 0);
}
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ----- State ---------------------------------------------------------------
let unsettled = [];
let pendingBatches = [];
let lastConfirmed = null;

// ----- Load ----------------------------------------------------------------
async function loadAll() {
  try {
    const [u, p] = await Promise.all([
      DataSource.loadRoongUnsettled(),
      DataSource.loadRoongPending(),
    ]);
    unsettled = mapUnsettled(u);
    pendingBatches = p;
    render();
  } catch (e) {
    document.getElementById('main-content').innerHTML =
      `<div class="empty">Could not load data.<br>${e.message}</div>`;
  }
}

// ----- Listeners (re-attached after each render) ---------------------------
function attachListeners() {
  const selectAll = document.getElementById('select-all-cb');
  if (selectAll) {
    if (selectAll.dataset.indeterminate === 'true') selectAll.indeterminate = true;
    selectAll.addEventListener('change', () => {
      unsettled.forEach(r => { r._checked = selectAll.checked; });
      render();
    });
  }
  document.querySelectorAll('input[type=checkbox][data-idx]').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = parseInt(cb.dataset.idx);
      unsettled[i]._checked = cb.checked;
      render();
    });
  });
  document.querySelectorAll('input[data-type=pct]').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.idx);
      const pct = Math.max(0, Math.min(100, parseFloat(input.value) || 0));
      const amount = parseFloat(unsettled[i].Amount || 0);
      unsettled[i]._pct = pct;
      unsettled[i]._share = amount * pct / 100;
      const bahtInput = document.querySelector(`input[data-type=baht][data-idx="${i}"]`);
      if (bahtInput) bahtInput.value = unsettled[i]._share.toFixed(2);
      const preview = document.getElementById(`preview-${i}`);
      if (preview) preview.textContent = `Roong pays ${fmtBaht(unsettled[i]._share)}`;
      updateSummaryBar();
    });
  });
  document.querySelectorAll('input[data-type=baht]').forEach(input => {
    input.addEventListener('input', () => {
      const i = parseInt(input.dataset.idx);
      const amount = parseFloat(unsettled[i].Amount || 0);
      const share = Math.max(0, parseFloat(input.value) || 0);
      unsettled[i]._share = share;
      unsettled[i]._pct = amount > 0 ? Math.round(share / amount * 100) : 0;
      const pctInput = document.querySelector(`input[data-type=pct][data-idx="${i}"]`);
      if (pctInput) pctInput.value = unsettled[i]._pct;
      const preview = document.getElementById(`preview-${i}`);
      if (preview) preview.textContent = `Roong pays ${fmtBaht(share)}`;
      updateSummaryBar();
    });
  });
}

function updateSummaryBar() {
  const checkedRows = unsettled.filter(r => r._checked);
  const herTotal = checkedRows.reduce((s, r) => s + r._share, 0);
  const bar = document.getElementById('summary-bar');
  if (!bar) return;
  const tot = bar.querySelector('.summary-total'); if (tot) tot.textContent = fmtBaht(herTotal);
  const cnt = bar.querySelector('.summary-count'); if (cnt) cnt.textContent = `${checkedRows.length} selected`;
  const btn = document.getElementById('btn-send');
  if (btn) {
    btn.disabled = checkedRows.length === 0;
    btn.textContent = checkedRows.length > 0 ? `Send request (${checkedRows.length})` : 'Send request';
  }
}

// ----- Actions -------------------------------------------------------------
async function sendRequest() {
  const checkedRows = unsettled.filter(r => r._checked);
  if (!checkedRows.length) return;
  const btn = document.getElementById('btn-send');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await DataSource.submitRoongRequest(
      checkedRows.map(r => ({RefID: r.RefID, roong_share: r._share}))
    );
    lastConfirmed = null;
    const [u, p] = await Promise.all([
      DataSource.loadRoongUnsettled(),
      DataSource.loadRoongPending(),
    ]);
    unsettled = mapUnsettled(u);
    pendingBatches = p;
    render();
    const pending = document.querySelector('.batch-card');
    if (pending) pending.scrollIntoView({behavior:'smooth', block:'start'});
  } catch(e) {
    showToast('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = `Send request (${checkedRows.length})`;
  }
}

function copyText(btn) {
  const sid = btn.dataset.sid;
  const textEl = document.getElementById('st-' + sid);
  if (!textEl) return;
  const text = textEl.textContent;
  function onSuccess() {
    btn.classList.add('copied');
    const ic = btn.querySelector('.copy-icon'); if (ic) ic.textContent = '✓';
    btn.childNodes[btn.childNodes.length - 1].textContent = ' Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      const ic2 = btn.querySelector('.copy-icon'); if (ic2) ic2.textContent = '⎘';
      btn.childNodes[btn.childNodes.length - 1].textContent = ' Copy text';
    }, 2000);
  }
  function fallbackCopy() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try {
      const ok = document.execCommand('copy');
      if (ok) { onSuccess(); } else { showToast('Could not copy — try long-pressing the text'); }
    } catch { showToast('Could not copy — try long-pressing the text'); }
    finally { document.body.removeChild(ta); }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(fallbackCopy);
  } else { fallbackCopy(); }
}

async function uploadSlip(input) {
  const sid = input.dataset.sid;
  if (!input.files || !input.files[0]) return;
  const confirmBtn = document.querySelector(`.btn-confirm[data-sid="${sid}"]`);
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Uploading…'; }
  try {
    // Preview: no real upload endpoint; just confirm the batch.
    const data = await DataSource.confirmRoong(sid);
    await onConfirmed(data);
  } catch(e) {
    showToast('Upload failed: ' + e.message);
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '✓ Mark received'; }
  }
}

async function confirmManual(btn) {
  const sid = btn.dataset.sid;
  btn.disabled = true;
  btn.textContent = 'Confirming…';
  try {
    const data = await DataSource.confirmRoong(sid);
    await onConfirmed(data);
  } catch(e) {
    showToast('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = '✓ Mark received';
  }
}

async function cancelBatch(btn) {
  const sid = btn.dataset.sid;
  if (!confirm(`Cancel settlement ${sid}? The expenses will return to the unsettled list.`)) return;
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  try {
    await DataSource.cancelRoong(sid);
    lastConfirmed = null;
    const [u, p] = await Promise.all([
      DataSource.loadRoongUnsettled(),
      DataSource.loadRoongPending(),
    ]);
    unsettled = mapUnsettled(u);
    pendingBatches = p;
    render();
    showToast(`${sid} cancelled — expenses returned to unsettled`);
  } catch(e) {
    showToast('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = '✕ Cancel';
  }
}

async function onConfirmed(data) {
  const batch = pendingBatches.find(b => b.settlement_id === data.settlement_id);
  const n = batch ? (batch.expense_rows || []).length : '?';
  lastConfirmed = {
    settlement_id:    data.settlement_id,
    requested_amount: data.requested_amount || (batch && batch.requested_amount) || '',
    confirmed_at:     data.confirmed_at || '',
    n,
  };
  const [u, p] = await Promise.all([
    DataSource.loadRoongUnsettled(),
    DataSource.loadRoongPending(),
  ]);
  unsettled = mapUnsettled(u);
  pendingBatches = p;
  render();
  window.scrollTo({top:0, behavior:'smooth'});
}

// ----- History -------------------------------------------------------------
async function loadHistory() {
  try {
    const history = await DataSource.loadRoongHistory();
    const el = document.getElementById('history-content');
    if (!el) return;
    if (!history.length) {
      el.innerHTML = `<div class="empty">No settled batches yet</div>`;
      return;
    }
    el.innerHTML = history.map(renderHistRow).join('');
  } catch(e) {
    const el = document.getElementById('history-content');
    if (el) el.innerHTML = `<div class="empty">Could not load history</div>`;
  }
}
