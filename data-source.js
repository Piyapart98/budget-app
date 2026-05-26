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
                    'RefID', 'ReviewedAt', 'Edited', 'Deleted'];
  var CHANGELOG_COLUMNS = ['Timestamp', 'RefID', 'Action', 'Field',
                           'OldValue', 'NewValue', 'Reason'];

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

  // GET a file. Returns { content, sha }. If the file doesn't exist returns
  // { content: '', sha: null } so first-time creates work naturally.
  async function ghGet(path) {
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
              '/contents/' + encodeURIComponent(path) +
              '?ref=' + encodeURIComponent(BRANCH) +
              // Cache-bust — without this, Safari sometimes serves a stale
              // version after the user just committed via the same page.
              '&_t=' + Date.now();
    var res = await fetch(url, { headers: ghHeaders(), cache: 'no-store' });
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
    var res = await fetch(url, {
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
  // Export
  // -------------------------------------------------------------------------

  window.DataSource = {
    MODE:           MODE,
    isLocal:        function () { return MODE === 'local'; },
    isGithub:       function () { return MODE === 'github'; },
    REPO_OWNER:     REPO_OWNER,
    REPO_NAME:      REPO_NAME,

    loadDatabase:   loadDatabase,
    loadChangelog:  loadChangelog,
    loadGoals:      loadGoals,
    loadConfig:     loadConfig,
    submitEntry:    submitEntry,
    submitEdit:     submitEdit,
    submitDelete:   submitDelete,

    resetToken:     resetToken,
  };

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
