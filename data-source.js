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

  // LOCAL mode: the Flask backend gates its data/image endpoints with a
  // per-machine access key (printed in the terminal, embedded as ?key= in the
  // URL it prints). Persist it as a SameSite=Strict cookie so it rides every
  // same-origin request — fetch() and <img> slip loads alike — but is never sent
  // cross-site, closing both the open-LAN and the CSRF gaps. Provision from
  // ?key= on any page; otherwise prompt once (paste the key from the terminal).
  (function provisionLocalKey() {
    if (MODE !== 'local') return;
    var m = /[?&]key=([^&]+)/.exec(window.location.search);
    if (m) {
      document.cookie = 'budget_key=' + m[1] + '; path=/; max-age=31536000; SameSite=Strict';
      try { history.replaceState(null, '', window.location.pathname + window.location.hash); } catch (e) {}
      return;
    }
    if (!/(?:^|;\s*)budget_key=/.test(document.cookie)) {
      var k = window.prompt(
        'Budget server access key\n\n' +
        'Paste the key shown in the terminal next to the phone URL (the part after ?key=).');
      if (k && k.trim()) {
        document.cookie = 'budget_key=' + k.trim() + '; path=/; max-age=31536000; SameSite=Strict';
      }
    }
  })();

  // Where the private data repo lives. If you ever fork this for someone
  // else's GitHub account, change these two strings and the same code keeps
  // working.
  var REPO_OWNER = 'Piyapart98';
  var REPO_NAME = 'budget-data';
  var BRANCH = 'main';

  // The code repo hosts the hourly OCR Action (.github/workflows/ocr-inbox.yml).
  // "Read slip" dispatches that workflow. Triggering it needs a SEPARATE token
  // with Actions:write here — kept apart from the data token below so the data
  // PAT stays Contents-only (least privilege).
  var CODE_REPO_NAME = 'budget-code';
  var OCR_WORKFLOW_FILE = 'ocr-inbox.yml';
  var VERIFY_WORKFLOW_FILE = 'verify-inbox.yml';

  var TOKEN_KEY = 'budget_github_token_v1';
  var ACTIONS_TOKEN_KEY = 'budget_github_actions_token_v1';

  // Column orders MUST match run_pipeline.py (DB_COLUMNS / CHANGELOG_COLUMNS).
  // The Mac side reads the CSVs by header name so order isn't strictly
  // required for correctness, but keeping them aligned makes diffs readable.
  var DB_COLUMNS = ['Date', 'Description', 'Amount', 'Category', 'Note',
                    'RefID', 'ReviewedAt', 'Edited', 'Deleted',
                    'settlement_id', 'roong_share',
                    'Card',    // trailing → old 11-col rows read Card as ''
                    'Settle']; // "True"/"" — on the settlement page even when
                               // Category isn't With Roong; trailing for compat
  var CHANGELOG_COLUMNS = ['Timestamp', 'RefID', 'Action', 'Field',
                           'OldValue', 'NewValue', 'Reason'];
  var ROONG_SETTLEMENT_COLUMNS = [
    'settlement_id', 'created_at', 'status', 'requested_amount',
    'row_ids', 'slip_file', 'confirmed_at', 'confirmed_method',
    'income_ref',  // payback row RefID(s), 'none', or '' = unlinked. Trailing.
  ];
  var ROONG_CATEGORY = 'With Roong';
  var ROONG_SETTLEMENTS_PATH = 'roong_settlements.csv';

  // Normalize any settle value to the stored form: 'True' or ''.
  function settleFlag(v) {
    return String(v == null ? '' : v).trim().toLowerCase() === 'true' ? 'True' : '';
  }

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

  // Separate token for dispatching the OCR Action (Actions:write on budget-code).
  // Prompted on first "Read slip" tap; stored only in this browser.
  function getActionsToken() {
    var t = localStorage.getItem(ACTIONS_TOKEN_KEY);
    if (!t) {
      t = window.prompt(
        'GitHub Actions token (for "Read slip")\n\n' +
        'Paste a fine-grained PAT scoped to ' + REPO_OWNER + '/' + CODE_REPO_NAME +
        ' with Actions: Read and write (nothing else).\n' +
        'Saved in this browser only; used solely to run the OCR workflow.'
      );
      if (!t || !t.trim()) {
        throw new Error('No Actions token provided.');
      }
      t = t.trim();
      localStorage.setItem(ACTIONS_TOKEN_KEY, t);
    }
    return t;
  }

  function resetActionsToken() {
    localStorage.removeItem(ACTIONS_TOKEN_KEY);
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

  // Per-page-load read cache (GitHub mode). The Roong settlement page reads the
  // same big file (database.csv) from three call sites — unsettled, pending, and
  // history — plus settlements.csv twice. Without caching that's the large
  // database.csv downloaded 3× on every open. ghGetCached fetches each path once
  // and hands back the in-flight promise (so even the parallel unsettled+pending
  // calls share one request). Any write (ghPut) clears the cache, so reloads
  // after a submit/confirm/cancel see fresh data — same freshness as before.
  var _ghReadCache = {};
  function ghGetCached(path) {
    if (_ghReadCache[path]) return _ghReadCache[path];
    var p = ghGet(path);
    _ghReadCache[path] = p;
    // Don't cache a failure — drop it so a retry can refetch.
    p.catch(function () { if (_ghReadCache[path] === p) delete _ghReadCache[path]; });
    return p;
  }
  function invalidateGhReadCache() { _ghReadCache = {}; }

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
    // A write may have changed any cached file — drop the read cache so the next
    // read refetches from GitHub.
    invalidateGhReadCache();
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
    var got = await ghGetCached('database.csv');
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

  // saveGoals — persist the monthly budget goals. The monthly_total is always
  // recomputed as the sum of the category goals (never trusted from the
  // caller). Local: POST /api/goals (Flask recomputes + writes goals.json).
  // GitHub: read goals.json, overlay the new categories onto whatever is there
  // (preserving any other keys), recompute the total, and PUT it back.
  async function saveGoals(goals) {
    var cats = (goals && goals.categories) ? goals.categories : {};
    if (MODE === 'local') {
      var res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: cats }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    var got = await ghGet('goals.json');
    var merged = got.content ? JSON.parse(got.content) : {};
    merged.categories = Object.assign({}, merged.categories || {}, cats);
    var total = 0;
    Object.keys(merged.categories).forEach(function (k) {
      total += Number(merged.categories[k]) || 0;
    });
    merged.monthly_total = total;
    await ghPut('goals.json', JSON.stringify(merged, null, 2), got.sha,
                'edit goals from phone');
    return merged;
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

  // loadCards — the editable card list, [{last4, name}, ...]. local → /api/cards;
  // github → cards.json in budget-data (the single source of truth).
  async function loadCards() {
    if (MODE === 'local') {
      var res = await fetch('/api/cards');
      if (!res.ok) throw new Error('GET /api/cards: ' + res.status);
      var data = await res.json();
      return (data && data.cards) ? data.cards : [];
    }
    var got = await ghGet('cards.json');
    if (!got.content) return [];
    try {
      var map = JSON.parse(got.content);
      return Object.keys(map).map(function (l4) { return { last4: l4, name: map[l4] }; });
    } catch (e) { return []; }
  }

  // saveCard — add (or rename) a card. last4 must be 4 digits. local → POST
  // /api/cards (Mac writes cards.json + refreshes config.json); github → merge
  // into cards.json and PUT it. Returns the updated [{last4, name}, ...].
  // Optional dueDay (1-28) also sets the card's payment due day in one step
  // (homepage countdown) — written via card_cycles.json / /api/cards/cycles.
  async function saveCard(last4, name, dueDay) {
    last4 = String(last4 || '').trim();
    name = String(name || '').trim();
    if (!/^\d{4}$/.test(last4)) throw new Error('Card last-4 must be exactly 4 digits.');
    if (!name) throw new Error('Card name is required.');
    var dd = (dueDay === undefined || dueDay === null || dueDay === '') ? null : Number(dueDay);
    if (dd !== null && !(dd >= 1 && dd <= 28)) throw new Error('Due day must be 1-28.');
    if (MODE === 'local') {
      var payload = { last4: last4, name: name };
      if (dd !== null) payload.due_day = dd;
      var res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'POST /api/cards: ' + res.status);
      return data.cards || [];
    }
    var got = await ghGet('cards.json');
    var map = {};
    if (got.content) { try { map = JSON.parse(got.content); } catch (e) { map = {}; } }
    map[last4] = name;
    await ghPut('cards.json', JSON.stringify(map, null, 2), got.sha, 'add card from phone');
    if (dd !== null) await saveCardCycle(last4, { due_day: dd });
    return Object.keys(map).map(function (l4) { return { last4: l4, name: map[l4] }; });
  }

  // loadCardCycles — the per-card billing-cycle config {last4: {due_day, paid_for}}
  // for the homepage due-date countdown. local → /api/cards/cycles; github →
  // card_cycles.json in budget-data. Returns {} when absent.
  async function loadCardCycles() {
    if (MODE === 'local') {
      var res = await fetch('/api/cards/cycles');
      if (!res.ok) throw new Error('GET /api/cards/cycles: ' + res.status);
      return res.json();
    }
    var got = await ghGetCached('card_cycles.json');
    if (!got.content) return {};
    try { return JSON.parse(got.content); } catch (e) { return {}; }
  }

  // saveCardCycle — patch one card's cycle config. patch = {due_day?, paid_for?}.
  // Pass due_day:null or paid_for:null to clear a field. local → POST
  // /api/cards/cycles; github → read-merge-PUT card_cycles.json (ghPut clears the
  // read cache). Returns the full merged {last4: {...}} map.
  async function saveCardCycle(last4, patch) {
    last4 = String(last4 || '').trim();
    if (!/^\d{4}$/.test(last4)) throw new Error('Card last-4 must be exactly 4 digits.');
    patch = patch || {};
    if (MODE === 'local') {
      var body = { last4: last4 };
      if ('due_day' in patch) body.due_day = patch.due_day;
      if ('paid_for' in patch) body.paid_for = patch.paid_for;
      var res = await fetch('/api/cards/cycles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'POST /api/cards/cycles: ' + res.status);
      return data;
    }
    var got = await ghGet('card_cycles.json');
    var map = {};
    if (got.content) { try { map = JSON.parse(got.content); } catch (e) { map = {}; } }
    var entry = Object.assign({}, map[last4] || {});
    if ('due_day' in patch) {
      if (patch.due_day === null || patch.due_day === '') delete entry.due_day;
      else entry.due_day = Number(patch.due_day);
    }
    if ('paid_for' in patch) {
      if (!patch.paid_for) delete entry.paid_for;
      else entry.paid_for = String(patch.paid_for);
    }
    map[last4] = entry;
    await ghPut('card_cycles.json', JSON.stringify(map, null, 2), got.sha, 'set card due day from phone');
    return map;
  }

  // loadUtilities — recurring utilities/subs for the homepage countdown,
  // [{id, name, due_day, emoji?, paid_for}, ...]. local → /api/utilities;
  // github → utilities.json in budget-data. Returns [] when absent.
  async function loadUtilities() {
    if (MODE === 'local') {
      var res = await fetch('/api/utilities');
      if (!res.ok) throw new Error('GET /api/utilities: ' + res.status);
      var data = await res.json();
      return Array.isArray(data) ? data : [];
    }
    var got = await ghGetCached('utilities.json');
    if (!got.content) return [];
    try { var arr = JSON.parse(got.content); return Array.isArray(arr) ? arr : []; }
    catch (e) { return []; }
  }

  // saveUtility — add or patch one utility. Omit id (or pass an unknown id) to
  // create; pass an existing id to patch. patch = {id?, name?, due_day?,
  // emoji?, paid_for?}; pass due_day:null / emoji:null / paid_for:null to
  // clear. local → POST
  // /api/utilities; github → read-merge-PUT utilities.json (ghPut clears cache).
  // Returns the full updated [{...}] list.
  async function saveUtility(patch) {
    patch = patch || {};
    if (MODE === 'local') {
      var res = await fetch('/api/utilities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      var data = await res.json().catch(function () { return []; });
      if (!res.ok) throw new Error((data && data.error) || 'POST /api/utilities: ' + res.status);
      return Array.isArray(data) ? data : [];
    }
    var got = await ghGet('utilities.json');
    var items = [];
    if (got.content) { try { items = JSON.parse(got.content); } catch (e) { items = []; } }
    if (!Array.isArray(items)) items = [];
    var uid = String(patch.id || '').trim();
    var idx = uid ? items.findIndex(function (u) { return String(u.id) === uid; }) : -1;
    var entry = idx >= 0 ? Object.assign({}, items[idx]) : {};
    if ('name' in patch) entry.name = String(patch.name == null ? '' : patch.name).trim();
    if ('due_day' in patch) {
      if (patch.due_day === null || patch.due_day === '') delete entry.due_day;
      else entry.due_day = Number(patch.due_day);
    }
    if ('paid_for' in patch) {
      if (!patch.paid_for) delete entry.paid_for;
      else entry.paid_for = String(patch.paid_for);
    }
    if ('emoji' in patch) {
      var em = String(patch.emoji == null ? '' : patch.emoji).trim();
      if (em) entry.emoji = em; else delete entry.emoji;
    }
    if (idx >= 0) { entry.id = items[idx].id; items[idx] = entry; }
    else {
      var slug = (entry.name || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
      entry.id = slug + '-' + Date.now().toString(36);
      items.push(entry);
    }
    await ghPut('utilities.json', JSON.stringify(items, null, 2), got.sha, 'save utility from phone');
    return items;
  }

  // deleteUtility — remove one utility by id. local → POST /api/utilities/delete;
  // github → read-filter-PUT utilities.json. Returns the updated list.
  async function deleteUtility(id) {
    id = String(id || '').trim();
    if (!id) throw new Error('utility id is required');
    if (MODE === 'local') {
      var res = await fetch('/api/utilities/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id }),
      });
      var data = await res.json().catch(function () { return []; });
      if (!res.ok) throw new Error((data && data.error) || 'POST /api/utilities/delete: ' + res.status);
      return Array.isArray(data) ? data : [];
    }
    var got = await ghGet('utilities.json');
    var items = [];
    if (got.content) { try { items = JSON.parse(got.content); } catch (e) { items = []; } }
    if (!Array.isArray(items)) items = [];
    items = items.filter(function (u) { return String(u.id) !== id; });
    await ghPut('utilities.json', JSON.stringify(items, null, 2), got.sha, 'delete utility from phone');
    return items;
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
    return {
      cards: cards,
      generated_at: snap.generated_at,
      upload_errors: snap.upload_errors || {},
      duplicate_notes: snap.duplicate_notes || {},
    };
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

  // Amount must be a non-negative number — mirrors the Flask /api/entry + /api/edit
  // guard so a GitHub-mode write can't store "abc" and NaN every report total.
  function assertAmount(v) {
    var n = Number(String(v == null ? '' : v).trim());
    if (!isFinite(n) || n < 0) throw new Error('Amount must be a non-negative number.');
  }

  async function submitEntry(payload) {
    assertAmount(payload.Amount);
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
        Card:        String(payload.Card || '').trim(),
        Settle:      settleFlag(payload.Settle),
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
    if (payload.Field === 'Amount') assertAmount(payload.NewValue);
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

  // Unsettled rows for the settlement page: the With Roong category PLUS any row
  // ticked "Include in settlement" (Settle=True). Flagged rows are tagged
  // _flagged so the page can render them in their own section. Sorted With Roong
  // first, then flagged, date ascending within each group.
  async function loadRoongUnsettled() {
    var db = await loadDatabase();
    return db.filter(function (r) {
      return (r.Category === ROONG_CATEGORY ||
              String(r.Settle || '').toLowerCase() === 'true') &&
             !(r.settlement_id || '').trim() &&
             String(r.Deleted || '').toLowerCase() !== 'true';
    }).map(function (r) {
      return Object.assign(r, { _flagged: r.Category !== ROONG_CATEGORY });
    }).sort(function (a, b) {
      if (a._flagged !== b._flagged) return a._flagged ? 1 : -1;
      return String(a.Date || '').localeCompare(String(b.Date || ''));
    });
  }

  async function loadRoongPending() {
    if (MODE === 'local') {
      var res = await fetch('/api/roong/pending');
      if (!res.ok) throw new Error('GET /api/roong/pending: ' + res.status);
      return res.json();
    }
    var got = await ghGetCached(ROONG_SETTLEMENTS_PATH);
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
    var got = await ghGetCached(ROONG_SETTLEMENTS_PATH);
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

  async function confirmRoong(settlementId, incomeRef) {
    // Slip upload is Mac-only (needs server filesystem). On GitHub mode
    // we always confirm as manual. incomeRef (optional): payback row
    // RefID(s), 'none' for no-money-movement, or falsy to leave unlinked.
    if (MODE === 'local') {
      // Called from the manual path — use FormData
      var fd = new FormData();
      fd.append('settlement_id', settlementId);
      fd.append('method', 'manual');
      if (incomeRef) fd.append('income_ref', incomeRef);
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
          if (incomeRef) rows[i].income_ref = incomeRef;
          break;
        }
      }
      return rows;
    }, 'roong confirm: ' + settlementId, ROONG_SETTLEMENT_COLUMNS);
    return { ok: true, settlement_id: settlementId, confirmed_at: ts, requested_amount: '' };
  }

  async function linkRoongIncome(settlementId, incomeRef) {
    // Attach (or replace) the payback income-row reference on a settlement.
    // Manual action only — nothing calls this automatically.
    if (MODE === 'local') {
      var res = await fetch('/api/roong/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settlement_id: settlementId, income_ref: incomeRef || '' }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    await mutateCsv(ROONG_SETTLEMENTS_PATH, function (rows) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].settlement_id === settlementId) {
          rows[i].income_ref = incomeRef || '';
          break;
        }
      }
      return rows;
    }, 'roong link: ' + settlementId, ROONG_SETTLEMENT_COLUMNS);
    return { ok: true, settlement_id: settlementId, income_ref: incomeRef || '' };
  }

  async function unconfirmRoong(settlementId) {
    // Revert a settled settlement to 'pending' (payment didn't happen).
    // Clears confirmed_at/confirmed_method/income_ref; shares stay stamped.
    if (MODE === 'local') {
      var res = await fetch('/api/roong/unconfirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settlement_id: settlementId }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Server returned ' + res.status);
      return data;
    }
    await mutateCsv(ROONG_SETTLEMENTS_PATH, function (rows) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].settlement_id === settlementId) {
          rows[i].status = 'pending';
          rows[i].confirmed_at = '';
          rows[i].confirmed_method = '';
          rows[i].income_ref = '';
          break;
        }
      }
      return rows;
    }, 'roong unconfirm: ' + settlementId, ROONG_SETTLEMENT_COLUMNS);
    return { ok: true, settlement_id: settlementId, status: 'pending' };
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
    //   3. append confirmed (Description, Category) pairs to User_History.csv
    //      so the hourly OCR Action predicts better next run — BEST-EFFORT.
    //   4. archive slip images into inbox/archive/<YYYY-MM>/ (keep forever;
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
        Card:        String(fields.Card || '').trim(),
        Settle:      settleFlag(fields.Settle),
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

    // 3. Teach the category predictor — best-effort. Append each confirmed
    //    (Description, Category) to User_History.csv so the hourly OCR Action
    //    predicts better on its next run (the same re-learn the Mac does in
    //    commit_decisions). A failure never aborts the batch — the rows and
    //    queue are already committed above.
    var historyRows = confirmed
      .map(function (dec) {
        var f = dec.fields || {};
        return {
          Description: String(f.Description || '').trim(),
          Category:    String(f.Category || '').trim(),
        };
      })
      .filter(function (r) { return r.Description && r.Category; });
    if (historyRows.length) {
      progress('Updating category history…');
      try {
        await mutateCsv('User_History.csv', function (rows) {
          var nextId = 1;
          rows.forEach(function (r) {
            var n = parseInt(r.History_ID, 10);
            if (!isNaN(n) && n >= nextId) nextId = n + 1;
          });
          var today = new Date().toISOString().slice(0, 10);
          historyRows.forEach(function (hr) {
            rows.push({
              History_ID:  String(nextId++),
              Date:        today,
              Description: hr.Description,
              Category:    hr.Category,
            });
          });
          return rows;
        }, 'review from phone: learn ' + historyRows.length + ' categor' +
           (historyRows.length === 1 ? 'y' : 'ies'),
           ['History_ID', 'Date', 'Description', 'Category']);
      } catch (e) {
        if (window.console && console.warn) {
          console.warn('history update failed (predictions unaffected this batch): ' +
                       (e && e.message));
        }
      }
    }

    // 4. Archive images — best-effort. Downloads run in parallel (the slow leg
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

  // triggerOcr — force an OCR run now ("Read slip"), so a freshly-uploaded slip
  // is reviewable without waiting for the hourly Action / a pipeline restart.
  //   local  → POST /api/scan (kicks the background scan worker on the Mac).
  //   github → workflow_dispatch the OCR Action on budget-code (needs the
  //            Actions token). After this resolves, the caller polls loadDrafts
  //            for the refreshed queue.
  async function triggerOcr() {
    if (MODE === 'local') {
      var res = await fetch('/api/scan', { method: 'POST' });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'POST /api/scan: ' + res.status);
      return data;
    }
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + CODE_REPO_NAME +
              '/actions/workflows/' + OCR_WORKFLOW_FILE + '/dispatches';
    var res2 = await ghFetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + getActionsToken(),
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: BRANCH }),
    });
    if (res2.status === 204) return { status: 'dispatched' };
    if (res2.status === 401 || res2.status === 403) {
      resetActionsToken();   // bad/expired token — re-prompt next tap
      throw new Error('Actions token rejected (' + res2.status +
                      '). It needs Actions: read+write on ' + CODE_REPO_NAME +
                      '. Re-enter it on the next tap.');
    }
    var d = await res2.json().catch(function () { return {}; });
    throw new Error('Dispatch failed: ' + res2.status + ' ' + (d.message || ''));
  }

  // uploadStatement — step 1 of the two-step flow: STORE the PDF only (no
  // parsing yet). The user then reviews and taps Verify (verifyStatement).
  //   local  → POST /api/verify/upload (saves into 01_inbox/statements/).
  //   github → ghPutRaw into budget-data inbox/statements/. The filename embeds
  //            a content hash so a re-upload of the same bytes is detectable
  //            (listStatements) and lands on the same path (idempotent).
  // `base64` is the PDF bytes (no data: prefix); `hash16` = first 16 hex of sha-256.
  async function uploadStatement(card, base64, hash16) {
    if (MODE === 'local') {
      var res = await fetch('/api/verify/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card: card, content_b64: base64, hash16: hash16 }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'POST /api/verify/upload: ' + res.status);
      return data;
    }
    var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    var name = 'inbox/statements/' + card + '_' + (hash16 || 'nohash') + '_' + stamp + '.pdf';
    await ghPutRaw(name, base64, 'upload statement from phone');
    return { status: 'uploaded', filename: name };
  }

  // verifyStatement — step 2: parse whatever is now in inbox/statements/. The
  // typed password rides a one-shot workflow_dispatch input and is never stored.
  //   local  → no-op success; the page reload re-parses live (Keychain password).
  //   github → workflow_dispatch verify-inbox.yml (best-effort; the hourly cron
  //            is the fallback for unencrypted PDFs).
  async function verifyStatement(password) {
    if (MODE === 'local') return { status: 'ok' };
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + CODE_REPO_NAME +
              '/actions/workflows/' + VERIFY_WORKFLOW_FILE + '/dispatches';
    try {
      var res = await ghFetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + getActionsToken(),
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: BRANCH, inputs: { password: password || '' } }),
      });
      if (res.status === 204) return { status: 'dispatched' };
      if (res.status === 401 || res.status === 403) {
        resetActionsToken();
        return { status: 'queued', note: 'Action token rejected — re-enter it. Meanwhile the hourly sweep runs unencrypted PDFs only.' };
      }
      return { status: 'queued', note: 'Verify dispatch failed (' + res.status + ') — hourly sweep will retry (unencrypted only).' };
    } catch (e) {
      return { status: 'queued', note: 'Verify dispatch unavailable — hourly sweep will retry (unencrypted only).' };
    }
  }

  // listStatements — filenames already in the pipeline, for duplicate detection
  // and the pending (awaiting-verify) state.
  //   { pending: [names in inbox/statements/], archived: [names in inbox/archive/statements/] }
  //   local  → GET /api/verify/statements; github → GitHub contents listing.
  async function listStatements() {
    if (MODE === 'local') {
      var res = await fetch('/api/verify/statements');
      if (!res.ok) return { pending: [], archived: [] };
      return res.json().catch(function () { return { pending: [], archived: [] }; });
    }
    async function dirNames(path) {
      var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
                '/contents/' + encodeURIComponent(path) +
                '?ref=' + encodeURIComponent(BRANCH) + '&_t=' + Date.now();
      var res = await ghFetch(url, { headers: ghHeaders(), cache: 'no-store' });
      if (!res.ok) return [];           // 404 = dir doesn't exist yet
      var arr = await res.json().catch(function () { return []; });
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (e) { return e.type === 'file'; })
                .map(function (e) { return e.name; });
    }
    var pending = await dirNames('inbox/statements');
    var archived = await dirNames('inbox/archive/statements');
    return { pending: pending, archived: archived };
  }

  // removeStatement — delete an uploaded-but-not-yet-verified PDF (undo an
  // accidental upload). `filename` is a basename under inbox/statements/.
  //   local  → POST /api/verify/remove; github → contents GET (for sha) + DELETE.
  async function removeStatement(filename) {
    if (MODE === 'local') {
      var res = await fetch('/api/verify/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: filename }),
      });
      if (!res.ok) throw new Error('POST /api/verify/remove: ' + res.status);
      return res.json().catch(function () { return {}; });
    }
    var path = 'inbox/statements/' + filename;
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME +
              '/contents/' + encodeURIComponent(path) +
              '?ref=' + encodeURIComponent(BRANCH) + '&_t=' + Date.now();
    var getRes = await ghFetch(url, { headers: ghHeaders(), cache: 'no-store' });
    if (!getRes.ok) throw new Error('statement not found (' + getRes.status + ')');
    var meta = await getRes.json();
    return ghDelete(path, meta.sha, 'remove uploaded statement from phone');
  }

  // latestVerifyRun — status of the most recent verify-inbox Action run, for the
  // live "what the server is doing" line. Best-effort: returns null in local mode
  // or when no Actions token is stored (never prompts). Shape:
  //   { status: 'queued'|'in_progress'|'completed', conclusion: 'success'|..., created_at }
  async function latestVerifyRun() {
    if (MODE === 'local') return null;
    var tok = localStorage.getItem(ACTIONS_TOKEN_KEY);   // peek — do NOT prompt
    if (!tok) return null;
    try {
      var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + CODE_REPO_NAME +
                '/actions/workflows/' + VERIFY_WORKFLOW_FILE + '/runs?per_page=1&_t=' + Date.now();
      var res = await ghFetch(url, {
        headers: {
          'Authorization': 'Bearer ' + tok,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        cache: 'no-store',
      });
      if (!res.ok) return null;
      var d = await res.json();
      var run = d.workflow_runs && d.workflow_runs[0];
      return run ? { status: run.status, conclusion: run.conclusion, created_at: run.created_at } : null;
    } catch (e) { return null; }
  }

  // finalizeVerifiedCard — end of the verify workflow for a card: file the
  // statement to the archive and clear it from the active view.
  //   local  → POST /api/verify/archive (moves the local PDF to 02_archive/).
  //   github → the PDF is already in inbox/archive/statements/ (the verify
  //            Action moved it on success); just drop this card from verify.json
  //            so the page returns to the upload (Pick PDF) state.
  async function finalizeVerifiedCard(last4) {
    if (MODE === 'local') {
      var res = await fetch('/api/verify/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card: last4 }),
      });
      var d = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(d.error || 'POST /api/verify/archive: ' + res.status);
      return d;
    }
    var got = await ghGet('verify.json');
    var snap = { generated_at: null, cards: [] };
    if (got.content) { try { snap = JSON.parse(got.content); } catch (e) { /* keep default */ } }
    snap.cards = (snap.cards || []).filter(function (c) { return c.card_last4 !== last4; });
    if (snap.upload_errors) delete snap.upload_errors[last4];
    if (snap.duplicate_notes) delete snap.duplicate_notes[last4];
    snap.generated_at = new Date().toISOString();
    await ghPut('verify.json', JSON.stringify(snap, null, 2), got.sha,
                'archive verified statement from phone');
    return { status: 'archived' };
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
    saveGoals:           saveGoals,
    loadConfig:          loadConfig,
    loadCards:           loadCards,
    saveCard:            saveCard,
    loadCardCycles:      loadCardCycles,
    saveCardCycle:       saveCardCycle,
    loadUtilities:       loadUtilities,
    saveUtility:         saveUtility,
    deleteUtility:       deleteUtility,
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
    linkRoongIncome:     linkRoongIncome,
    unconfirmRoong:      unconfirmRoong,
    cancelRoong:         cancelRoong,

    loadDrafts:          loadDrafts,
    loadSlipImage:       loadSlipImage,
    submitReview:        submitReview,
    triggerOcr:          triggerOcr,
    uploadStatement:     uploadStatement,
    verifyStatement:     verifyStatement,
    listStatements:      listStatements,
    removeStatement:     removeStatement,
    latestVerifyRun:     latestVerifyRun,
    finalizeVerifiedCard: finalizeVerifiedCard,

    resetToken:          resetToken,
    resetActionsToken:   resetActionsToken,
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
