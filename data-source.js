/*
  data-source.js — single abstraction layer for all data reads/writes used by
  entry_form.html, edit_log.html, and monthly_report.html.

  Two modes, auto-detected from window.location.hostname:

    • LOCAL  — pages served by Flask (run_pipeline.py). Uses /api/* endpoints
               exactly like before. No behavior change for desktop use.

    • GITHUB — pages served by GitHub Pages (https://*.github.io/budget-app/).
               Reads/writes directly against the private budget-data repo
               using the GitHub Contents API with a Personal Access Token
               that the user pastes in on first load. Token persists in
               localStorage. CSV files are parsed/serialized client-side.

  All call sites in the HTML pages talk to window.DataSource — they never
  branch on mode. The mode is invisible to the pages.
*/

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Mode + repo config
  // -------------------------------------------------------------------------
  // GitHub Pages always serves under <user>.github.io. Anything else (local
  // file://, localhost, LAN IP) is treated as the Mac/Flask backend.
  var IS_GITHUB = /\.github\.io$/i.test(window.location.hostname);
  var MODE = IS_GITHUB ? 'github' : 'local';

  // Where the private data repo lives. If you ever fork this for someone
  // else's GitHub account, change these two strings and the same code keeps
  // working.
  var REPO_OWNER = 'Piyapart98';
  var REPO_NAME = 'budget-data';
  var BRANCH = 'main';

  var TOKEN_KEY = 'budget_github_token_v1';

  // Column orders MUST match run_pipeline.py (DB_COLUMNS / CHANGELOG_COLUMNS).
  // The Mac side reads the CSVs by header name so order isn't strictly
  // required for correctness, but keeping them aligned makes diffs readable.
  var DB_COLUMNS = ['Date', 'Description', 'Amount', 'Category', 'Note',
                    'RefID', 'ReviewedAt', 'Edited', 'Deleted',
                    'settlement_id', 'roong_share'];
  var CHANGELOG_COLUMNS = ['Timestamp', 'RefID', 'Action', 'Field',
                           'OldValue', 'NewValue', 'Reason'];
  var ROONG_SETTLEMENT_COLUMNS = [
    'settlement_id', 'created_at', 'status', 'requested_amount',
    'row_ids', 'slip_file', 'confirmed_at', 'confirmed_method',
  ];
  var ROONG_CATEGORY = 'With Roong';
  var ROONG_SETTLEMENTS_PATH = 'roong_settlements.csv';

  // -------------------------------------------------------------------------
  // Token management (GitHub mode only)
  // -------------------------------------------------------------------------

  function getToken() {
    var t = localStorage.getItem(TOKEN_KEY);
    if (!t) {
      t = window.prompt(
        'GitHub Personal Access Token\n\n' +
        'Paste the fine-grained PAT scoped to budget-data (Contents: read+write).\n' +
        'It will be saved in this browser only and never sent anywhere else.'
      );
      if (!t || !t.trim()) {
        throw new Error('No token provided. Reload the page to try again.');
      }
      t = t.trim();
      localStorage.setItem(TOKEN_KEY, t);
    }
    return t;
  }

  function resetToken() {
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
  }

  // -------------------------------------------------------------------------
  // Base64 that handles Unicode (Thai, etc.). atob/btoa alone choke on
  // multi-byte chars.
  // -------------------------------------------------------------------------

  function toBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function fromBase64(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // -------------------------------------------------------------------------
  // CSV parse + serialize (RFC 4180-ish)
  // -------------------------------------------------------------------------

  function parseCSV(text) {
    var rows = [];
    var row = [];
    var cell = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else inQuotes = false;
        } else cell += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c === '\r') { /* skip */ }
        else cell += c;
      }
    }
    if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
    return rows;
  }

  function csvToObjects(text) {
    if (!text || !text.trim()) return [];
    var rows = parseCSV(text);
    if (!rows.length) return [];
    var headers = rows[0];
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      // Skip rows that are entirely empty (trailing newline at end of file).
      var any = false;
      for (var j = 0; j < r.length; j++) if (r[j] !== '') { any = true; break; }
      if (!any) continue;
      var obj = {};
      for (var k = 0; k < headers.length; k++) obj[headers[k]] = r[k] || '';
      out.push(obj);
    }
    return out;
  }

  function escapeCell(v) {
    var s = (v == null) ? '' : String(v);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 ||
        s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function objectsToCsv(objs, columns) {
    var lines = [columns.join(',')];
    for (var i = 0; i < objs.length; i++) {
      var row = objs[i];
      var cells = [];
      for (var j = 0; j < columns.length; j++) cells.push(escapeCell(row[columns[j]]));
      lines.push(cells.join(','));
    }
    return lines.join('\n') + '\n';
  }

  // -------------------------------------------------------------------------
  // GitHub Contents API client
  // -------------------------------------------------------------------------

  function ghHeaders() {
    return {
      'Authorization': 'Bearer ' + getToken(),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  // fetch with a hard timeout. Mobile Safari can leave a request stalled
  // forever on a weak cellular link — without this, one dead request silently
  // freezes a whole submit batch (no error, no alert). GETs retry once on
  // timeout/network error; writes (PUT/DELETE) do NOT auto-retry, because the
  // write may have landed server-side — callers' idempotency handles re-runs.
  var GH_TIMEOUT_MS = 30000;

  async function ghFetch(url, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var retries = method === 'GET' ? 1 : 0;
    for (var attempt = 0; ; attempt++) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, GH_TIMEOUT_MS);
      try {
        return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      } catch (e) {
        if (attempt < retries) continue;
        if (e && e.name === 'AbortError') {
          throw new Error('GitHub request timed out after ' + (GH_TIMEOUT_MS / 1000) +
                          's (' + method + '). Check your connection and retry.');
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // GET a file. Returns { content, sha }. If the file doesn't exist returns
  // { content: '', sha: null } so first-time creates work naturally.
  async function ghGet(path) {
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
              '/contents/' + encodeURIComponent(path) +
              '?ref=' + encodeURIComponent(BRANCH) +
              // Cache-bust — without this, Safari sometimes serves a stale
              // version after the user just committed via the same page.
              '&_t=' + Date.now();
    var res = await ghFetch(url, { headers: ghHeaders(), cache: 'no-store' });
    if (res.status === 404) return { content: '', sha: null };
    if (res.status === 401) {
      // Token rejected — wipe it so the next call re-prompts.
      localStorage.removeItem(TOKEN_KEY);
      throw new Error('GitHub rejected your token. Reload to re-enter it.');
    }
    if (!res.ok) {
      var err = await res.text();
      throw new Error('GitHub GET ' + path + ': ' + res.status + ' ' + err);
    }
    var data = await res.json();
    return { content: fromBase64(data.content || ''), sha: data.sha };
  }

  // PUT a file. Pass null sha for new files. Returns the response JSON.
  async function ghPut(path, content, sha, message) {
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
              '/contents/' + encodeURIComponent(path);
    var body = {
      message: message,
      content: toBase64(content),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;
    var res = await ghFetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      var data = await res.json().catch(function () { return {}; });
      var e = new Error('GitHub PUT ' + path + ': ' + res.status + ' ' + (data.message || ''));
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  // CSV mutator with optimistic concurrency. mutator(rows) returns the new
  // rows array (it can mutate in place too). If GitHub rejects the PUT
  // because the SHA is stale (someone else just pushed), we refetch and
  // retry — up to 3 times.
  async function mutateCsv(path, mutator, message, columns) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var got = await ghGet(path);
      var rows = csvToObjects(got.content);
      var newRows = mutator(rows);
      var newCsv = objectsToCsv(newRows, columns);
      try {
        return await ghPut(path, newCsv, got.sha, message);
      } catch (e) {
        // 409 = SHA conflict, 422 = also possible on race. Retry.
        if (e.status === 409 || e.status === 422) continue;
        throw e;
      }
    }
    throw new Error('Could not update ' + path + ' — too many concurrent writers.');
  }

  // -------------------------------------------------------------------------
  // Shared helpers used in both modes
  // -------------------------------------------------------------------------

  function nowHuman() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // Phone-side RefID generator. We deliberately do NOT use sequential #NNNN
  // because the Mac assigns those for slip-review rows during the local
  // session, and would race with phone entries (both seeing the same max).
  // 'p' + millisecond timestamp is globally unique without coordination.
  // The Mac treats this as just another opaque RefID for edit/delete.
  function phoneRefId() {
    return 'p' + Date.now();
  }

  // -------------------------------------------------------------------------
  // Public API — same shape regardless of mode
  // -------------------------------------------------------------------------

  async function loadDatabase() {
    if (MODE === 'local') {
      var res = await fetch('/api/database');
      if (!res.ok) throw new Error('GET /api/database: ' + res.status);
      return res.json();
    }
    var got = await ghGet('database.csv');
    return csvToObjects(got.content);
  }

  async function loadChangelog() {
    if (MODE === 'local') {
      var res = await fetch('/api/changelog');
      if (!res.ok) throw new Error('GET /api/changelog: ' + res.status);
      return res.json();
    }
    var got = await ghGet('changelog.csv');
    return csvToObjects(got.content);
  }

  async function loadGoals() {
    if (MODE === 'local') {
      var res = await fetch('/api/goals');
      if (!res.ok) throw new Error('GET /api/goals: ' + res.status);
      return res.json();
    }
    var got = await ghGet('goals.json');
    return got.content ? JSON.parse(got.content) : {};
  }

  async function loadConfig() {
    if (MODE === 'local') {
      var res = await fetch('/api/config');
      if (!res.ok) throw new Error('GET /api/config: ' + res.status);
      return res.json();
    }
    // In GitHub mode the Mac sync writes a snapshot of /api/config into
    // config.json each time it pushes. If config.json isn't there yet
    // (first-time use before any Mac sync push) we return a sane empty
    // shape so the pages still work — the Note datalist will just be empty
    // and the report will treat no category as spending.
    var got = await ghGet('config.json');
    if (!got.content) {
      return { cards: [], extra_note_suggestions: [], income_categories: [] };
    }
    try { return JSON.parse(got.content); }
    catch (e) { return { cards: [], extra_note_suggestions: [], income_categories: [] }; }
  }

  // loadVerification — statement vs DB cross-check.
  // Local mode: calls /api/verify (optional ?card=XXXX to scope to one card),
  //   which parses the PDFs live.
  // GitHub mode: the phone can't parse PDFs (no Flask, no files). Instead it
  //   reads verify.json — a snapshot the Mac writes on every run. Same shape
  //   as /api/verify. Buckets are as-of the last Mac run; the snapshot carries
  //   a `generated_at` so the page can show how fresh it is.
  async function loadVerification(card) {
    if (MODE === 'local') {
      var url = '/api/verify';
      if (card) url += '?card=' + encodeURIComponent(card);
      var res = await fetch(url);
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    // GitHub mode — read the snapshot.
    var got = await ghGet('verify.json');
    var snap = { generated_at: null, cards: [] };
    if (got.content) {
      try { snap = JSON.parse(got.content); } catch (e) { snap = { generated_at: null, cards: [] }; }
    }
    var cards = snap.cards || [];
    if (card) {
      var hit = null;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].card_last4 === card) { hit = cards[i]; break; }
      }
      if (!hit) {
        throw new Error('No statement snapshot for card *' + card +
          '. Run the pipeline on your Mac to generate one.');
      }
      hit.generated_at = snap.generated_at;
      return hit;
    }
    return { cards: cards, generated_at: snap.generated_at };
  }

  // archiveStatement — move a verified statement PDF out of the inbox into
  // 02_archive/statements/. Mac-only (operates on local files).
  async function archiveStatement(card) {
    if (MODE !== 'local') {
      throw new Error('mac-only');
    }
    var res = await fetch('/api/verify/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card: card }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
    return data;
  }

  async function submitEntry(payload) {
    if (MODE === 'local') {
      var res = await fetch('/api/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    // GitHub mode: append a row with a unique timestamp-based RefID so it
    // never collides with Mac-assigned sequential #NNNN slip IDs.
    var assignedRef = phoneRefId();
    var ts = nowHuman();
    await mutateCsv('database.csv', function (rows) {
      rows.push({
        Date:        String(payload.Date || '').trim(),
        Description: String(payload.Description || '').trim(),
        Amount:      String(payload.Amount || '').trim(),
        Category:    String(payload.Category || '').trim(),
        Note:        String(payload.Note || '').trim(),
        RefID:       assignedRef,
        ReviewedAt:  ts,
        Edited:      'No',
        Deleted:     'False',
      });
      return rows;
    }, 'entry from phone: ' + (payload.Description || '') + ' ' + (payload.Amount || ''),
       DB_COLUMNS);
    return {
      ok: true,
      row: Object.assign({}, payload, {
        RefID: assignedRef, ReviewedAt: ts, Edited: 'No', Deleted: 'False',
      }),
    };
  }

  async function submitEdit(payload) {
    if (MODE === 'local') {
      var res = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    var oldVal = null;
    var ts = nowHuman();
    await mutateCsv('database.csv', function (rows) {
      var target = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].RefID === payload.RefID) { target = rows[i]; break; }
      }
      if (!target) throw new Error('Row not found: ' + payload.RefID);
      oldVal = target[payload.Field] || '';
      target[payload.Field] = payload.NewValue;
      target.Edited = 'Yes';
      return rows;
    }, 'edit from phone: ' + payload.RefID + ' ' + payload.Field, DB_COLUMNS);

    await mutateCsv('changelog.csv', function (rows) {
      rows.push({
        Timestamp: ts,
        RefID:     payload.RefID,
        Action:    'edit',
        Field:     payload.Field,
        OldValue:  oldVal,
        NewValue:  payload.NewValue,
        Reason:    payload.Reason,
      });
      return rows;
    }, 'changelog: edit ' + payload.RefID, CHANGELOG_COLUMNS);

    return { ok: true };
  }

  async function submitDelete(payload) {
    if (MODE === 'local') {
      var res = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    var ts = nowHuman();
    await mutateCsv('database.csv', function (rows) {
      var target = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].RefID === payload.RefID) { target = rows[i]; break; }
      }
      if (!target) throw new Error('Row not found: ' + payload.RefID);
      if (String(target.Deleted || '').toLowerCase() === 'true') {
        throw new Error('Row already deleted');
      }
      target.Deleted = 'True';
      return rows;
    }, 'delete from phone: ' + payload.RefID, DB_COLUMNS);

    await mutateCsv('changelog.csv', function (rows) {
      rows.push({
        Timestamp: ts,
        RefID:     payload.RefID,
        Action:    'delete',
        Field:     '',
        OldValue:  '',
        NewValue:  '',
        Reason:    payload.Reason,
      });
      return rows;
    }, 'changelog: delete ' + payload.RefID, CHANGELOG_COLUMNS);

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Roong Settlement helpers
  // -------------------------------------------------------------------------

  // Generate next settlement ID from a list of existing settlement rows.
  function nextSettlementId(rows) {
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      var sid = (rows[i].settlement_id || '').trim();
      if (/^S\d+$/i.test(sid)) {
        var n = parseInt(sid.slice(1), 10);
        if (n > max) max = n;
      }
    }
    var next = max + 1;
    return 'S' + (next < 10 ? '00' + next : next < 100 ? '0' + next : next);
  }

  // Enrich a list of settlement records with their expense_rows from db rows.
  function enrichWithExpenseRows(settlements, dbRows) {
    for (var i = 0; i < settlements.length; i++) {
      var sid = settlements[i].settlement_id;
      settlements[i].expense_rows = dbRows.filter(function (r) {
        return r.settlement_id === sid &&
               String(r.Deleted || '').toLowerCase() !== 'true';
      });
    }
    return settlements;
  }

  async function loadRoongUnsettled() {
    var db = await loadDatabase();
    return db.filter(function (r) {
      return r.Category === ROONG_CATEGORY &&
             !(r.settlement_id || '').trim() &&
             String(r.Deleted || '').toLowerCase() !== 'true';
    });
  }

  async function loadRoongPending() {
    if (MODE === 'local') {
      var res = await fetch('/api/roong/pending');
      if (!res.ok) throw new Error('GET /api/roong/pending: ' + res.status);
      return res.json();
    }
    var got = await ghGet(ROONG_SETTLEMENTS_PATH);
    var settlements = csvToObjects(got.content);
    var pending = settlements.filter(function (s) { return s.status === 'pending'; });
    var db = await loadDatabase();
    return enrichWithExpenseRows(pending, db);
  }

  async function loadRoongHistory() {
    if (MODE === 'local') {
      var res = await fetch('/api/roong/history');
      if (!res.ok) throw new Error('GET /api/roong/history: ' + res.status);
      return res.json();
    }
    var got = await ghGet(ROONG_SETTLEMENTS_PATH);
    var settlements = csvToObjects(got.content);
    var settled = settlements.filter(function (s) { return s.status === 'settled'; });
    settled.sort(function (a, b) {
      var ka = a.confirmed_at || a.created_at || '';
      var kb = b.confirmed_at || b.created_at || '';
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
    var db = await loadDatabase();
    return enrichWithExpenseRows(settled, db);
  }

  async function submitRoongRequest(rowsPayload) {
    // rowsPayload: [{RefID, roong_share}, ...]
    if (MODE === 'local') {
      var res = await fetch('/api/roong/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rowsPayload }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }

    var ts = nowHuman();
    var sid;
    var totalShare = 0;
    var refIds = rowsPayload.map(function (r) { return r.RefID; });
    var shareMap = {};
    rowsPayload.forEach(function (r) {
      shareMap[r.RefID] = r.roong_share;
      totalShare += parseFloat(r.roong_share) || 0;
    });

    // Read settlements first to derive next settlement ID
    var settleGot = await ghGet(ROONG_SETTLEMENTS_PATH);
    var settleRows = csvToObjects(settleGot.content);
    sid = nextSettlementId(settleRows);

    // Step 1: stamp DB rows
    await mutateCsv('database.csv', function (rows) {
      for (var i = 0; i < rows.length; i++) {
        if (refIds.indexOf(rows[i].RefID) !== -1) {
          rows[i].settlement_id = sid;
          rows[i].roong_share = String(shareMap[rows[i].RefID]);
        }
      }
      return rows;
    }, 'roong request ' + sid + ': stamp ' + refIds.length + ' rows', DB_COLUMNS);

    // Step 2: append settlement record
    var newSettlement = {
      settlement_id:    sid,
      created_at:       ts,
      status:           'pending',
      requested_amount: String(totalShare),
      row_ids:          refIds.join('|'),
      slip_file:        '',
      confirmed_at:     '',
      confirmed_method: '',
    };
    settleRows.push(newSettlement);
    var newSettleCsv = objectsToCsv(settleRows, ROONG_SETTLEMENT_COLUMNS);
    await ghPut(ROONG_SETTLEMENTS_PATH, newSettleCsv, settleGot.sha,
                'roong request: create ' + sid);

    return { ok: true, settlement_id: sid };
  }

  async function confirmRoong(settlementId) {
    // Slip upload is Mac-only (needs server filesystem). On GitHub mode
    // we always confirm as manual.
    if (MODE === 'local') {
      // Called from the manual path — use FormData
      var fd = new FormData();
      fd.append('settlement_id', settlementId);
      fd.append('method', 'manual');
      var res = await fetch('/api/roong/confirm', { method: 'POST', body: fd });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    var ts = nowHuman();
    await mutateCsv(ROONG_SETTLEMENTS_PATH, function (rows) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].settlement_id === settlementId) {
          rows[i].status = 'settled';
          rows[i].confirmed_at = ts;
          rows[i].confirmed_method = 'manual';
          break;
        }
      }
      return rows;
    }, 'roong confirm: ' + settlementId, ROONG_SETTLEMENT_COLUMNS);
    return { ok: true, settlement_id: settlementId, confirmed_at: ts, requested_amount: '' };
  }

  async function cancelRoong(settlementId) {
    if (MODE === 'local') {
      var res = await fetch('/api/roong/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settlement_id: settlementId }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    // Step 1: clear settlement_id + roong_share from DB rows
    await mutateCsv('database.csv', function (rows) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].settlement_id === settlementId) {
          rows[i].settlement_id = '';
          rows[i].roong_share = '';
        }
      }
      return rows;
    }, 'roong cancel: unstamp ' + settlementId, DB_COLUMNS);

    // Step 2: remove the settlement record
    await mutateCsv(ROONG_SETTLEMENTS_PATH, function (rows) {
      return rows.filter(function (r) { return r.settlement_id !== settlementId; });
    }, 'roong cancel: remove ' + settlementId, ROONG_SETTLEMENT_COLUMNS);

    return { ok: true, settlement_id: settlementId };
  }

  // -------------------------------------------------------------------------
  // Slip review (GitHub-native ingestion channel)
  //
  // The phone uploads slip images into budget-data/inbox/; a scheduled GitHub
  // Action (ocr-inbox.yml) OCRs each new image into drafts.json. These three
  // methods let the swipe review page (review.html) read those drafts, show the
  // slip image, and commit decisions — mirroring the Mac /api/drafts +
  // /api/review/submit flow so review.html is identical in both modes.
  // -------------------------------------------------------------------------

  // Blob -> bare base64 (strips the "data:...;base64," prefix FileReader adds).
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('blobToBase64 failed')); };
      reader.onload = function () {
        var s = String(reader.result || '');
        var comma = s.indexOf(',');
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      reader.readAsDataURL(blob);
    });
  }

  // Binary-safe GET — ghGet() decodes content as UTF-8 text, which corrupts a
  // JPEG/PNG. For images we keep the raw base64 the API returns.
  //
  // The Contents API only inlines base64 `content` for files <= 1 MB; for larger
  // files it returns 200 with content:"" / encoding:"none". So when content is
  // empty we re-fetch the same URL with the raw media type (good up to 100 MB)
  // and base64-encode the bytes ourselves. sha comes from the JSON call (the raw
  // response carries no JSON), so callers' archive/delete flow is unchanged.
  async function ghGetRaw(path) {
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
              '/contents/' + encodeURIComponent(path) +
              '?ref=' + encodeURIComponent(BRANCH) + '&_t=' + Date.now();
    var res = await ghFetch(url, { headers: ghHeaders(), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('GitHub GET(raw) ' + path + ': ' + res.status);
    var data = await res.json();
    var base64 = (data.content || '').replace(/\s/g, '');
    if (!base64) {
      // Large file (>1 MB): bytes not inlined — fetch them via the raw media type.
      var rawHeaders = Object.assign({}, ghHeaders(), { 'Accept': 'application/vnd.github.raw' });
      var rawRes = await ghFetch(url, { headers: rawHeaders, cache: 'no-store' });
      if (rawRes.status === 404) return null;
      if (!rawRes.ok) throw new Error('GitHub GET(raw bytes) ' + path + ': ' + rawRes.status);
      base64 = await blobToBase64(await rawRes.blob());
    }
    return { base64: base64, sha: data.sha };
  }

  // PUT raw base64 content (already-encoded bytes — do NOT re-encode).
  async function ghPutRaw(path, base64, message) {
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
              '/contents/' + encodeURIComponent(path);
    var res = await ghFetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify({ message: message, content: base64, branch: BRANCH }),
    });
    if (!res.ok) {
      var d = await res.json().catch(function () { return {}; });
      throw new Error('GitHub PUT(raw) ' + path + ': ' + res.status + ' ' + (d.message || ''));
    }
    return res.json();
  }

  async function ghDelete(path, sha, message) {
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
              '/contents/' + encodeURIComponent(path);
    var res = await ghFetch(url, {
      method: 'DELETE',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify({ message: message, sha: sha, branch: BRANCH }),
    });
    if (!res.ok && res.status !== 404) {
      var d = await res.json().catch(function () { return {}; });
      throw new Error('GitHub DELETE ' + path + ': ' + res.status + ' ' + (d.message || ''));
    }
    return true;
  }

  function mimeForName(name) {
    var n = (name || '').toLowerCase();
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.heic')) return 'image/heic';
    return 'image/jpeg';
  }

  // YYYY-MM bucket for the keep-forever archive (spec §3). From the slip's
  // transaction date when known, else the current month.
  function slipMonth(dateStr) {
    var m = /^(\d{4})-(\d{2})/.exec(dateStr || '');
    if (m) return m[1] + '-' + m[2];
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // loadDrafts — normalized list: {id, filename, image_path, slip_path,
  // slip_type, fields, is_duplicate}. id is the stable key review.html dedups
  // on (slip_path on Mac, filename on GitHub).
  async function loadDrafts() {
    if (MODE === 'local') {
      var res = await fetch('/api/drafts');
      if (!res.ok) throw new Error('GET /api/drafts: ' + res.status);
      var data = await res.json();
      var drafts = (data && data.drafts) ? data.drafts : [];
      return drafts.map(function (d) {
        return {
          id:         d.slip_path || d.filename,
          filename:   d.filename,
          image_path: d.image_path || null,
          slip_path:  d.slip_path || null,
          slip_type:  d.slip_type || '',
          fields:     d.fields || {},
          is_duplicate: !!d.is_duplicate,
        };
      });
    }
    // GitHub: drafts.json written by ocr_inbox.py — a bare array (but tolerate
    // the Mac batch shape {drafts:[...]} too).
    var got = await ghGet('drafts.json');
    var arr = [];
    if (got.content) {
      try {
        var parsed = JSON.parse(got.content);
        arr = Array.isArray(parsed) ? parsed : (parsed.drafts || []);
      } catch (e) { arr = []; }
    }
    return arr.map(function (d) {
      return {
        id:         d.filename,
        filename:   d.filename,
        image_path: d.image_path || ('inbox/' + d.filename),
        slip_path:  null,
        slip_type:  d.slip_type || '',
        fields:     d.fields || {},
        is_duplicate: !!d.is_duplicate,
      };
    });
  }

  // loadSlipImage — an <img>-ready src for a draft (from loadDrafts).
  async function loadSlipImage(slip) {
    if (MODE === 'local') {
      // Existing Flask slip route serves both inbox and archived images.
      return '/slips/' + encodeURIComponent(slip.filename);
    }
    var path = slip.image_path || ('inbox/' + slip.filename);
    var got = await ghGetRaw(path);
    if (!got) return '';
    return 'data:' + mimeForName(slip.filename) + ';base64,' + got.base64;
  }

  // submitReview — commit a batch of decisions (the review gate). Mirrors the
  // Mac commit_decisions() contract. Nothing here runs until "Submit batch".
  //
  // decisions: [{id, slip_path, filename, image_path, slip_type, decision,
  //              edited, fields?}]  (fields present only for 'confirmed').
  // onProgress (optional): function(text) — UI status updates during the batch.
  async function submitReview(decisions, onProgress) {
    var progress = typeof onProgress === 'function' ? onProgress : function () {};
    if (MODE === 'local') {
      var res = await fetch('/api/review/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: decisions }),
      });
      if (!res.ok) {
        var txt = await res.text();
        throw new Error('Server ' + res.status + ': ' + txt);
      }
      return res.json();
    }

    // GitHub mode — replicate commit_decisions(). GitHub has no transactions, so
    // the order puts the durable, user-visible writes FIRST and keeps every step
    // idempotent / re-runnable:
    //   1. append confirmed rows to database.csv, skipping any whose Date+Amount
    //      already exists (duplicate guard — mirrors ocr_inbox.is_duplicate).
    //   2. rewrite drafts.json removing every decided slip (retry on SHA race).
    //      → after these two commits (<10 s) the batch is committed and the
    //        review queue is correct; nothing later can lose data.
    //   3. archive slip images into inbox/archive/<YYYY-MM>/ (keep forever;
    //      rejected get a REJECTED_ prefix and no DB row) — BEST-EFFORT: a slip
    //      whose archive move fails just stays in inbox/ for a later sweep, it
    //      never aborts the batch. This used to run first, which meant a stalled
    //      request on cellular did all the housekeeping and none of the real
    //      work (2026-06-12 incident: 11/20 slips archived, zero rows written).
    var confirmed = decisions.filter(function (d) { return d.decision === 'confirmed'; });
    var rejected  = decisions.filter(function (d) { return d.decision === 'rejected'; });
    var ts = nowHuman();
    var base = Date.now();

    // 1. Append confirmed rows, skipping any whose Date+Amount already matches a
    //    non-deleted DB row. This makes re-submitting an interrupted batch
    //    idempotent (no silent duplicate). The guard compares only against rows
    //    that existed BEFORE this batch, so two genuinely-identical confirmed
    //    slips in one fresh batch both still write.
    var newRows = confirmed.map(function (dec, idx) {
      var fields = dec.fields || {};
      return {
        Date:        String(fields.Date || '').trim(),
        Description: String(fields.Description || '').trim(),
        Amount:      String(fields.Amount || '').trim(),
        Category:    String(fields.Category || '').trim(),
        Note:        String(fields.Note || '').trim(),
        RefID:       'p' + (base + idx),     // unique within the batch
        ReviewedAt:  ts,
        Edited:      'No',
        Deleted:     'False',
      };
    });
    var addedCount = newRows.length;
    if (newRows.length) {
      progress('Committing ' + newRows.length + ' row(s)…');
      await mutateCsv('database.csv', function (rows) {
        var existing = {};
        rows.forEach(function (r) {
          if (String(r.Deleted || '').toLowerCase() !== 'true') {
            existing[r.Date + ' ' + r.Amount] = true;
          }
        });
        var toAdd = newRows.filter(function (nr) {
          return !existing[nr.Date + ' ' + nr.Amount];
        });
        addedCount = toAdd.length;
        return rows.concat(toAdd);
      }, 'review from phone: commit confirmed row(s)', DB_COLUMNS);
    }

    // 2. Drop every decided slip from drafts.json, retrying on a SHA race.
    progress('Clearing review queue…');
    var decidedIds = {};
    decisions.forEach(function (d) { decidedIds[d.id] = true; });
    for (var attempt = 0; attempt < 3; attempt++) {
      var draftsGot = await ghGet('drafts.json');
      var draftArr = [];
      if (draftsGot.content) {
        try {
          var p = JSON.parse(draftsGot.content);
          draftArr = Array.isArray(p) ? p : (p.drafts || []);
        } catch (e) { draftArr = []; }
      }
      var remaining = draftArr.filter(function (d) { return !decidedIds[d.filename]; });
      try {
        await ghPut('drafts.json', JSON.stringify(remaining, null, 2), draftsGot.sha,
                    'review from phone: clear ' + decisions.length + ' decided slip(s)');
        break;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
        throw e;
      }
    }

    // 3. Archive images — best-effort. Downloads run in parallel (the slow leg
    //    on 4G, especially >1 MB photos which cost two GETs); the archive PUT
    //    and inbox DELETE stay SERIAL — each is a commit to the same branch and
    //    concurrent commits race (409). A slip whose inbox image is already
    //    gone (re-run of an interrupted submit) no-ops. Per-slip failures are
    //    collected, not thrown — the rows are already committed above, and a
    //    leftover inbox image is harmless (no draft points at it anymore).
    var archiveFailed = 0;
    var fetched = await Promise.all(decisions.map(async function (dec) {
      var srcPath = dec.image_path || ('inbox/' + dec.filename);
      try {
        return { dec: dec, srcPath: srcPath, img: await ghGetRaw(srcPath) };
      } catch (e) {
        return { dec: dec, srcPath: srcPath, img: null, failed: true };
      }
    }));
    for (var i = 0; i < fetched.length; i++) {
      var f = fetched[i];
      if (f.failed) { archiveFailed++; continue; }
      if (!f.img) continue;
      progress('Archiving slips ' + (i + 1) + '/' + fetched.length + '…');
      var aFields = f.dec.fields || {};
      var month = slipMonth(aFields.Date);
      var archiveName = (f.dec.decision === 'rejected' ? 'REJECTED_' : '') + f.dec.filename;
      var destPath = 'inbox/archive/' + month + '/' + archiveName;
      try {
        try {
          await ghPutRaw(destPath, f.img.base64, 'archive slip ' + archiveName);
        } catch (e) {
          // 422 here usually means the archive copy already exists (PUT without
          // sha onto an existing path) — a half-finished earlier run. Treat as
          // archived and fall through to delete the inbox original.
          if (!/422/.test(String(e && e.message))) throw e;
        }
        await ghDelete(f.srcPath, f.img.sha, 'remove inbox slip ' + f.dec.filename);
      } catch (e) {
        archiveFailed++;
        if (window.console && console.warn) {
          console.warn('archive failed for ' + f.dec.filename + ': ' + (e && e.message));
        }
      }
    }

    return { confirmed: addedCount, rejected: rejected.length,
             archive_failed: archiveFailed };
  }

  // loadScanStatus — Mac-only (background OCR worker). Exported only in local
  // mode so review.html's `typeof DataSource.loadScanStatus === 'function'`
  // guard skips polling on the phone (drafts refresh hourly via the Action).
  async function loadScanStatus() {
    var res = await fetch('/api/scan/status');
    if (!res.ok) throw new Error('GET /api/scan/status: ' + res.status);
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  window.DataSource = {
    MODE:           MODE,
    isLocal:        function () { return MODE === 'local'; },
    isGithub:       function () { return MODE === 'github'; },
    REPO_OWNER:     REPO_OWNER,
    REPO_NAME:      REPO_NAME,

    loadDatabase:        loadDatabase,
    loadChangelog:       loadChangelog,
    loadGoals:           loadGoals,
    loadConfig:          loadConfig,
    loadVerification:    loadVerification,
    archiveStatement:    archiveStatement,
    submitEntry:         submitEntry,
    submitEdit:          submitEdit,
    submitDelete:        submitDelete,

    loadRoongUnsettled:  loadRoongUnsettled,
    loadRoongPending:    loadRoongPending,
    loadRoongHistory:    loadRoongHistory,
    submitRoongRequest:  submitRoongRequest,
    confirmRoong:        confirmRoong,
    cancelRoong:         cancelRoong,

    loadDrafts:          loadDrafts,
    loadSlipImage:       loadSlipImage,
    submitReview:        submitReview,

    resetToken:          resetToken,
  };

  // Mac-only: drives the review page's "scanning… N of M" polling. Left off the
  // export in GitHub mode so review.html's typeof guard skips polling there.
  if (MODE === 'local') {
    window.DataSource.loadScanStatus = loadScanStatus;
  }

  // -------------------------------------------------------------------------
  // Auto-injected mode footer (GitHub mode only)
  //
  // Adds a tiny pill at the bottom-right of every page that shows the user
  // is in GitHub mode and lets them clear the saved token if it stops
  // working. Skipped in local mode — Mac doesn't need it.
  // -------------------------------------------------------------------------
  function injectFooter() {
    if (MODE !== 'github') return;
    if (document.getElementById('ds-mode-footer')) return;
    var f = document.createElement('div');
    f.id = 'ds-mode-footer';
    f.style.cssText =
      'position:fixed;right:10px;bottom:10px;z-index:9999;' +
      'font:11px ui-monospace,monospace;background:rgba(26,25,23,0.85);color:#f5f4f0;' +
      'padding:5px 9px;border-radius:999px;display:flex;gap:6px;align-items:center;' +
      'box-shadow:0 1px 4px rgba(0,0,0,0.15);';
    f.innerHTML = 'github · ' + REPO_OWNER + '/' + REPO_NAME +
                  ' <a href="#" id="ds-reset-token" style="color:#86c9a3;text-decoration:none;">reset token</a>';
    document.body.appendChild(f);
    document.getElementById('ds-reset-token').addEventListener('click', function (e) {
      e.preventDefault();
      if (confirm('Clear the saved GitHub token? You will be prompted to enter a new one.')) {
        resetToken();
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectFooter);
  } else {
    injectFooter();
  }
})();
