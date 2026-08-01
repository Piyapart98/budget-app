/* ============================================================================
   Warm Journal v2 — shared behaviour for the v2/ pages.

   Depends on ../warm-shared.js (window.Mock: catEmoji, fmtBaht, isDeleted,
   monthKey, incomeTester, savingTester, escapeHtml, greeting, dateline) and
   ../data-source.js (window.DataSource). Adds only what v2 needs on top:

     V2.icon()        inline SVG sprite — no emoji is ever used as a UI control
     V2.nav()         the navigation shell, both variants
     V2.sheet()       bottom sheet + scrim
     V2.toast()       transient confirmation, optional undo
     V2.editSheet()   THE shared entry editor — every editable field, one reason
     V2.flags()       anomaly detection, thresholds in one place
     V2.verifiedRefs()  RefIDs proven against a card statement
     V2.frequents()   auto-derived repeats for the Add screen

   Spec: docs/superpowers/specs/2026-08-01-warm-journal-v2-design.md
   ========================================================================== */
(function () {
  'use strict';

  var esc = function (s) { return window.Mock.escapeHtml(s); };

  // --------------------------------------------------------------------------
  // Icons. Category emoji are DATA (the user picked them) and stay as emoji;
  // interface controls are always SVG so they render at one weight and colour.
  // --------------------------------------------------------------------------
  var PATHS = {
    home:    'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    chart:   'M4 20V10M10 20V4M16 20v-7M22 20H2',
    plus:    'M12 5v14M5 12h14',
    check:   'M20 6 9 17l-5-5',
    checkc:  'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14.01l-3-3',
    scale:   'M7 20V4M7 4 3.5 7.5M7 4l3.5 3.5M17 4v16M17 20l-3.5-3.5M17 20l3.5-3.5',
    list:    'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    search:  'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    filter:  'M3 5h18l-7 8v6l-4 2v-8z',
    x:       'M18 6 6 18M6 6l12 12',
    left:    'M15 18l-6-6 6-6',
    right:   'M9 18l6-6-6-6',
    down:    'M6 9l6 6 6-6',
    up:      'M6 15l6-6 6 6',
    alert:   'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
    shield:  'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
    edit:    'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    trash:   'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
    undo:    'M3 7v6h6M3.5 13a9 9 0 1 0 2.3-6.4L3 9',
    link:    'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19',
    doc:     'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15h6M9 11h2',
    copy:    'M9 9h10v12H9zM5 15H3V3h12v2',
    bolt:    'M13 2 4 14h7l-1 8 9-12h-7z',
    card:    'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20',
    refresh: 'M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5'
  };
  function icon(name, cls) {
    var d = PATHS[name];
    if (!d) return '';
    var parts = d.split('M').filter(Boolean).map(function (p) {
      return '<path d="M' + p + '"/>';
    }).join('');
    return '<svg class="i ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' +
           parts + '</svg>';
  }

  // --------------------------------------------------------------------------
  // Navigation. Two variants ship for the trial; one is deleted at graduation.
  // Review deliberately points at the LIVE ../review.html — v2 does not touch it.
  // --------------------------------------------------------------------------
  var NAV_KEY = 'v2NavMode';
  function navMode() {
    try { return localStorage.getItem(NAV_KEY) === 'hub' ? 'hub' : 'tab'; }
    catch (e) { return 'tab'; }
  }
  function setNavMode(m) {
    try { localStorage.setItem(NAV_KEY, m === 'hub' ? 'hub' : 'tab'); } catch (e) {}
  }

  var DESTS = [
    { key: 'home',   label: 'Home',       href: 'index.html',      icon: 'home' },
    { key: 'report', label: 'Report',     href: 'report.html',     icon: 'chart' },
    { key: 'entry',  label: 'Add',        href: 'entry.html',      icon: 'plus' },
    { key: 'review', label: 'Review',     href: '../review.html',  icon: 'checkc' },
    { key: 'settle', label: 'Settle',     href: 'settle.html',     icon: 'scale' },
    { key: 'log',    label: 'Log',        href: 'log.html',        icon: 'list' },
    { key: 'verify', label: 'Card check', href: 'verify.html',     icon: 'shield' }
  ];
  var TAB_KEYS = ['home', 'report', 'entry', 'review', 'settle'];
  function dest(k) {
    for (var i = 0; i < DESTS.length; i++) if (DESTS[i].key === k) return DESTS[i];
    return null;
  }

  /** Render the nav shell into <body>. `badges` = {review: n, settle: n}. */
  function nav(current, badges) {
    badges = badges || {};
    var host = document.getElementById('v2-nav');
    if (!host) {
      host = document.createElement('div');
      host.id = 'v2-nav';
      document.body.appendChild(host);
    }
    if (navMode() === 'hub') {
      // Hub mode: Home carries the map, so all we pin is a floating Add.
      host.innerHTML = current === 'entry' ? '' :
        '<a class="fab" href="entry.html" aria-label="Add entry">' + icon('plus', 'lg') + '</a>';
      return;
    }
    host.innerHTML = '<nav class="tabbar">' + TAB_KEYS.map(function (k) {
      var d = dest(k);
      if (k === 'entry') {
        return '<a href="' + d.href + '" aria-label="Add entry">' +
               '<span class="addbtn">' + icon('plus', 'lg') + '</span></a>';
      }
      var n = badges[k] || 0;
      return '<a href="' + d.href + '"' + (current === k ? ' aria-current="page"' : '') + '>' +
             '<span class="wrapi">' + icon(d.icon) +
             (n ? '<span class="dot">' + n + '</span>' : '') + '</span>' +
             '<span>' + d.label + '</span></a>';
    }).join('') + '</nav>';
  }

  /** Tiles for Home's "Go to" grid: in tab mode, only what the tab bar omits. */
  function hubTiles() {
    return navMode() === 'hub'
      ? ['review', 'report', 'log', 'settle', 'verify', 'entry']
      : ['log', 'verify', 'entry'];
  }

  // --------------------------------------------------------------------------
  // Sheet / scrim / toast
  // --------------------------------------------------------------------------
  function ensureChrome() {
    if (document.getElementById('v2-scrim')) return;
    var scrim = document.createElement('div');
    scrim.className = 'scrim'; scrim.id = 'v2-scrim';
    scrim.addEventListener('click', closeSheet);
    var sheet = document.createElement('div');
    sheet.className = 'sheet'; sheet.id = 'v2-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    var toast = document.createElement('div');
    toast.className = 'toast'; toast.id = 'v2-toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    document.body.appendChild(toast);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheet();
    });
  }
  function sheet(html) {
    ensureChrome();
    var el = document.getElementById('v2-sheet');
    el.innerHTML = '<div class="grab"></div>' + html;
    el.classList.add('on');
    document.getElementById('v2-scrim').classList.add('on');
    el.scrollTop = 0;
    return el;
  }
  function closeSheet() {
    var el = document.getElementById('v2-sheet');
    if (el) el.classList.remove('on');
    var s = document.getElementById('v2-scrim');
    if (s) s.classList.remove('on');
  }
  var toastTimer = null;
  function toast(msg, undoFn) {
    ensureChrome();
    var el = document.getElementById('v2-toast');
    el.innerHTML = icon('checkc', 'sm') + '<span>' + esc(msg) + '</span>' +
                   (undoFn ? '<button type="button" id="v2-undo">Undo</button>' : '');
    el.classList.add('on');
    if (undoFn) {
      document.getElementById('v2-undo').onclick = function () {
        el.classList.remove('on');
        undoFn();
      };
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 4200);
  }
  function busy(msg) {
    ensureChrome();
    var el = document.getElementById('v2-toast');
    el.innerHTML = '<span class="spin"></span><span>' + esc(msg) + '</span>';
    el.classList.add('on');
    clearTimeout(toastTimer);
  }

  // --------------------------------------------------------------------------
  // Categories, from config with the hardcoded fallback. Saving is tested
  // BEFORE income — a stale config may still list saving cats under income.
  // --------------------------------------------------------------------------
  var SPEND_FALLBACK = ['Food', 'Drinks and Snacks', 'Groceries', 'Transport',
    'Utilities and Subs', 'Health / Necessaries', 'Shopping', 'Sports',
    'Social Expenses / Donation', 'With Roong', 'To Mom', 'Other spending'];

  function catGroups(cfg) {
    var isSaving = window.Mock.savingTester(cfg);
    var isIncome = window.Mock.incomeTester(cfg);
    var income = (cfg && cfg.income_categories) || [];
    var saving = (cfg && cfg.saving_categories) || [];
    // Anything configured as income but actually a saving category belongs to
    // saving — same precedence the live pages use.
    income = income.filter(function (c) { return !isSaving(c); });
    return {
      spend:  SPEND_FALLBACK.slice(),
      income: income.length ? income : ['Salary', 'Bonus', 'Reimbursement',
                'Payback from someone', 'Interest payment', 'Other income'],
      saving: saving.length ? saving : ['Provident Fund', 'Mutual Fund',
                'Coop Saving Account', 'Coop Stock',
                'Saving for EOY Tax Deduction', 'Other saving'],
      isIncome: function (c) { return !isSaving(c) && isIncome(c); },
      isSaving: isSaving,
      isSpend:  function (c) { return !isSaving(c) && !isIncome(c); }
    };
  }

  // Income that is money coming back, not earnings — excluded from "real income"
  // exactly as monthly_report.html excludes it.
  var EXCLUDED_INCOME = ['Reimbursement', 'Payback from someone'];
  function isExcludedIncome(cat) {
    return EXCLUDED_INCOME.indexOf(String(cat || '').trim()) !== -1;
  }

  var CARD_NONE = 'None (cash)';
  function cardNames(cfg) {
    var cards = (cfg && cfg.cards) || [];
    return cards.map(function (c) { return c.name; }).filter(Boolean);
  }

  // --------------------------------------------------------------------------
  // THE shared entry editor. Every field in EDITABLE_FIELDS, one reason, one
  // submitEdits call. Used by the log rows, the home feed and the report's
  // expanded category entries.
  // --------------------------------------------------------------------------
  var REASONS = ['wrong category', 'wrong amount', 'wrong date', 'duplicate',
                 'typo', 'card correction'];

  function editSheet(row, opts) {
    opts = opts || {};
    var cfg = opts.config || null;
    var groups = catGroups(cfg);
    var cards = cardNames(cfg);
    var chosenReason = '';

    function optionsFor(list, current) {
      return list.map(function (c) {
        return '<option value="' + esc(c) + '"' + (c === current ? ' selected' : '') + '>' +
               window.Mock.catEmoji(c) + '  ' + esc(c) + '</option>';
      }).join('');
    }
    // A row whose category is no longer in any list (renamed, legacy) must not
    // silently lose it when the sheet opens.
    var cat = row.Category || '';
    var known = groups.spend.concat(groups.income, groups.saving);
    var orphan = cat && known.indexOf(cat) === -1
      ? '<optgroup label="Current"><option value="' + esc(cat) + '" selected>' +
        esc(cat) + '</option></optgroup>' : '';

    var settleOn = String(row.Settle || '') === 'True';

    sheet(
      '<h3>Edit entry</h3>' +
      '<div class="sh-sub">' + esc(row.RefID) + ' · every field is editable · soft delete only</div>' +

      '<div class="fblock"><label class="fl" for="v2-f-desc">Description</label>' +
        '<input class="inp" id="v2-f-desc" value="' + esc(row.Description || '') + '"></div>' +

      '<div class="fgrid">' +
        '<div class="fblock"><label class="fl" for="v2-f-amt">Amount (THB)</label>' +
          '<input class="inp" id="v2-f-amt" type="number" inputmode="decimal" step="0.01" ' +
          'value="' + esc(row.Amount || '') + '"></div>' +
        '<div class="fblock"><label class="fl" for="v2-f-date">Date</label>' +
          '<input class="inp" id="v2-f-date" type="date" value="' + esc(row.Date || '') + '"></div>' +
      '</div>' +

      '<div class="fblock"><label class="fl" for="v2-f-cat">Category</label>' +
        '<select class="inp" id="v2-f-cat">' + orphan +
          '<optgroup label="Spending">' + optionsFor(groups.spend, cat) + '</optgroup>' +
          '<optgroup label="Income">' + optionsFor(groups.income, cat) + '</optgroup>' +
          '<optgroup label="Saving">' + optionsFor(groups.saving, cat) + '</optgroup>' +
        '</select></div>' +

      '<div class="fgrid">' +
        '<div class="fblock"><label class="fl" for="v2-f-card">Card</label>' +
          '<select class="inp" id="v2-f-card">' +
            '<option value=""' + (!row.Card ? ' selected' : '') + '>' + CARD_NONE + '</option>' +
            cards.map(function (c) {
              return '<option value="' + esc(c) + '"' +
                     (row.Card === c ? ' selected' : '') + '>' + esc(c) + '</option>';
            }).join('') +
            (row.Card && cards.indexOf(row.Card) === -1
              ? '<option value="' + esc(row.Card) + '" selected>' + esc(row.Card) + '</option>' : '') +
          '</select></div>' +
        '<div class="fblock"><label class="fl" for="v2-f-note">Note</label>' +
          '<input class="inp" id="v2-f-note" value="' + esc(row.Note || '') + '" placeholder="optional"></div>' +
      '</div>' +

      '<div class="toggle-row">' +
        '<div class="grow"><div style="font-weight:600;font-size:14px">Include in settlement</div>' +
        '<div class="faint">shows up on the settlement page</div></div>' +
        '<span class="tick' + (settleOn ? ' on' : '') + '" id="v2-f-settle" role="checkbox" ' +
        'tabindex="0" aria-checked="' + settleOn + '">' + (settleOn ? icon('check', 'sm') : '') + '</span>' +
      '</div>' +

      '<div class="fl" style="margin-top:6px">Reason for the change (logged to changelog.csv)</div>' +
      '<div class="reasons" id="v2-reasons">' + REASONS.map(function (r) {
        return '<button type="button" class="chip tap plain" data-reason="' + esc(r) + '">' +
               esc(r) + '</button>';
      }).join('') + '</div>' +
      '<input class="inp" id="v2-f-reason" placeholder="…or type your own reason" ' +
        'aria-label="Custom reason">' +

      '<div class="row" style="gap:9px;margin-top:14px">' +
        '<button type="button" class="btn btn-red" style="flex:1" id="v2-del">' +
          icon('trash', 'sm') + ' Delete</button>' +
        '<button type="button" class="btn btn-green" style="flex:1.6" id="v2-save">' +
          icon('check', 'sm') + ' Save changes</button>' +
      '</div>' +
      '<p class="faint center" style="margin-top:9px">' +
        'Delete is a soft delete — the row stays in the file, marked deleted.</p>'
    );

    var settleEl = document.getElementById('v2-f-settle');
    function toggleSettle() {
      var on = !settleEl.classList.contains('on');
      settleEl.classList.toggle('on', on);
      settleEl.setAttribute('aria-checked', String(on));
      settleEl.innerHTML = on ? icon('check', 'sm') : '';
    }
    settleEl.addEventListener('click', toggleSettle);
    settleEl.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleSettle(); }
    });

    document.getElementById('v2-reasons').addEventListener('click', function (e) {
      var b = e.target.closest('[data-reason]');
      if (!b) return;
      [].forEach.call(this.querySelectorAll('[data-reason]'), function (x) {
        x.classList.remove('on'); x.classList.add('plain');
      });
      b.classList.add('on'); b.classList.remove('plain');
      chosenReason = b.dataset.reason;
      document.getElementById('v2-f-reason').value = '';
    });

    function reasonValue() {
      var typed = document.getElementById('v2-f-reason').value.trim();
      return typed || chosenReason;
    }

    document.getElementById('v2-save').addEventListener('click', async function () {
      var btn = this;
      var reason = reasonValue();
      if (!reason) {
        document.getElementById('v2-f-reason').focus();
        toast('Pick or type a reason first');
        return;
      }
      var next = {
        Description: document.getElementById('v2-f-desc').value.trim(),
        Amount:      document.getElementById('v2-f-amt').value.trim(),
        Date:        document.getElementById('v2-f-date').value,
        Category:    document.getElementById('v2-f-cat').value,
        Card:        document.getElementById('v2-f-card').value,
        Note:        document.getElementById('v2-f-note').value.trim(),
        Settle:      settleEl.classList.contains('on') ? 'True' : ''
      };
      // Send only what actually differs — the server skips no-ops anyway, but
      // this keeps the request honest and the changelog tight.
      var fields = {};
      Object.keys(next).forEach(function (k) {
        if (String(row[k] == null ? '' : row[k]) !== next[k]) fields[k] = next[k];
      });
      if (!Object.keys(fields).length) { closeSheet(); toast('Nothing changed'); return; }

      btn.disabled = true;
      busy('Saving…');
      try {
        await DataSource.submitEdits({
          Reason: reason,
          Edits: [{ RefID: row.RefID, Fields: fields }]
        });
        Object.keys(fields).forEach(function (k) { row[k] = fields[k]; });
        row.Edited = 'Yes';
        closeSheet();
        toast('Saved · ' + Object.keys(fields).length + ' field' +
              (Object.keys(fields).length === 1 ? '' : 's') + ' · reason logged');
        if (opts.onSaved) opts.onSaved(row, fields);
      } catch (e) {
        btn.disabled = false;
        toast('Could not save: ' + e.message);
      }
    });

    document.getElementById('v2-del').addEventListener('click', async function () {
      var reason = reasonValue();
      if (!reason) {
        document.getElementById('v2-f-reason').focus();
        toast('A reason is required to delete');
        return;
      }
      if (!confirm('Soft-delete "' + (row.Description || row.RefID) + '"?')) return;
      this.disabled = true;
      busy('Deleting…');
      try {
        await DataSource.submitDelete({ RefID: row.RefID, Reason: reason });
        row.Deleted = 'True';
        closeSheet();
        toast('Row soft-deleted — it stays in the file');
        if (opts.onDeleted) opts.onDeleted(row);
      } catch (e) {
        this.disabled = false;
        toast('Could not delete: ' + e.message);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Derived state — nothing here is stored, everything is computed from data
  // that already exists. See spec §6.
  // --------------------------------------------------------------------------

  /**
   * Thresholds in one place so they are tunable without hunting.
   *
   * `catchAll` is deliberately NOT "Other spending": that is a category France
   * chooses on purpose, not an un-triaged state. Only a blank category, or the
   * bare legacy "Other" from before the 2026-07-25 rename, counts as missing.
   *
   * `recentDays` bounds every flag type. Attention is about what is actionable
   * now — without it, 1,800 rows of history produce ~136 flags and the "needs a
   * look" filter becomes noise nobody reads.
   */
  var FLAG = {
    unusualMultiple: 4,      // x the category median
    unusualFloor:    800,    // and at least this many baht
    uncategorisedDays: 3,
    unsettledDays:   21,
    recentDays:      60,
    catchAll: ['', 'Other']
  };

  function median(nums) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function daysAgo(dateStr) {
    var d = new Date(String(dateStr || '') + 'T00:00:00');
    if (isNaN(d)) return 0;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  /**
   * Returns { RefID: [reason, ...] } for rows worth a second look.
   * `rows` should be the live (non-deleted) set.
   */
  function flags(rows, cfg, windowDays) {
    var groups = catGroups(cfg);
    var span = windowDays == null ? FLAG.recentDays : windowDays;
    var spend = rows.filter(function (r) { return groups.isSpend(r.Category); });

    // Medians come from ALL history — a good baseline needs the long run — but
    // only recent rows are ever flagged.
    var byCat = {};
    spend.forEach(function (r) {
      (byCat[r.Category] = byCat[r.Category] || []).push(Number(r.Amount) || 0);
    });
    var med = {};
    Object.keys(byCat).forEach(function (c) { med[c] = median(byCat[c]); });

    var recent = spend.filter(function (r) { return daysAgo(r.Date) <= span; });

    var seen = {};
    recent.forEach(function (r) {
      var k = r.Date + '|' + r.Amount + '|' + r.Category;
      (seen[k] = seen[k] || []).push(r.RefID);
    });

    var out = {};
    function add(ref, why) { (out[ref] = out[ref] || []).push(why); }

    recent.forEach(function (r) {
      var amt = Number(r.Amount) || 0;
      var m = med[r.Category] || 0;
      if (m > 0 && amt >= m * FLAG.unusualMultiple && amt >= FLAG.unusualFloor) {
        add(r.RefID, Math.round(amt / m) + '× your typical ' + r.Category +
                     ' (median ' + window.Mock.fmtBaht(m) + ')');
      }
      if (FLAG.catchAll.indexOf(String(r.Category || '').trim()) !== -1 &&
          daysAgo(r.Date) > FLAG.uncategorisedDays) {
        add(r.RefID, 'still uncategorised after ' + daysAgo(r.Date) + ' days');
      }
      if (String(r.Settle || '') === 'True' && !r.settlement_id &&
          daysAgo(r.Date) > FLAG.unsettledDays) {
        add(r.RefID, 'unsettled for ' + daysAgo(r.Date) + ' days');
      }
    });

    Object.keys(seen).forEach(function (k) {
      if (seen[k].length < 2) return;
      seen[k].forEach(function (ref) {
        add(ref, 'possible duplicate (' + seen[k].length + ' identical rows that day)');
      });
    });
    return out;
  }

  /**
   * RefIDs proven against a card statement, from verify.json's matched[] —
   * each entry carries the DB row's RefID (statement_verify.py writes it).
   * Returns { refs: {RefID:true}, generatedAt: str|null, cards: n }.
   */
  function verifiedRefs(verify) {
    var refs = {}, n = 0;
    var cards = (verify && verify.cards) || [];
    cards.forEach(function (c) {
      (c.matched || []).forEach(function (m) {
        var ref = m && m.db && m.db.RefID;
        if (ref) { refs[ref] = true; n++; }
      });
    });
    return {
      refs: refs,
      count: n,
      cards: cards.length,
      generatedAt: (verify && verify.generated_at) || null
    };
  }

  /**
   * Auto-derived repeats for the Add screen: the (Description, Category)
   * pairs seen at least MIN times in the last DAYS days, most recent first,
   * carrying their most common amount. Nothing is stored; a phone-local hide
   * list keeps it out of the way without touching the repo.
   */
  var FREQ = { days: 90, min: 3, max: 5, hideKey: 'v2HiddenFrequents' };
  function hiddenFrequents() {
    try { return JSON.parse(localStorage.getItem(FREQ.hideKey) || '[]'); }
    catch (e) { return []; }
  }
  function hideFrequent(key) {
    var h = hiddenFrequents();
    if (h.indexOf(key) === -1) h.push(key);
    try { localStorage.setItem(FREQ.hideKey, JSON.stringify(h)); } catch (e) {}
  }
  function resetFrequents() {
    try { localStorage.removeItem(FREQ.hideKey); } catch (e) {}
  }
  function frequents(rows, cfg) {
    var groups = catGroups(cfg);
    var hidden = hiddenFrequents();
    var cutoff = new Date(Date.now() - FREQ.days * 86400000)
      .toISOString().slice(0, 10);
    var buckets = {};
    rows.forEach(function (r) {
      if (window.Mock.isDeleted(r)) return;
      if (!groups.isSpend(r.Category)) return;
      if (String(r.Date || '') < cutoff) return;
      var desc = String(r.Description || '').trim();
      if (!desc) return;
      var key = desc.toLowerCase() + '|' + r.Category;
      var b = buckets[key] || (buckets[key] = {
        key: key, desc: desc, cat: r.Category, n: 0, amounts: [], last: ''
      });
      b.n++;
      b.amounts.push(Math.round(Number(r.Amount) || 0));
      if (r.Date > b.last) { b.last = r.Date; b.desc = desc; }
    });
    return Object.keys(buckets).map(function (k) { return buckets[k]; })
      .filter(function (b) { return b.n >= FREQ.min && hidden.indexOf(b.key) === -1; })
      .map(function (b) {
        // Median, not the modal amount: one odd ฿7 top-up recorded three times
        // would otherwise become "the" price of a 7-ELEVEN run.
        b.amount = Math.round(median(b.amounts));
        return b;
      })
      .sort(function (x, y) {
        return y.n - x.n || (y.last < x.last ? -1 : 1);
      })
      .slice(0, FREQ.max);
  }

  // --------------------------------------------------------------------------
  // Small shared formatters
  // --------------------------------------------------------------------------
  function shortDay(iso) {
    var d = new Date(String(iso || '') + 'T00:00:00');
    if (isNaN(d)) return String(iso || '');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function niceDay(iso) {
    var d = new Date(String(iso || '') + 'T00:00:00');
    if (isNaN(d)) return String(iso || '');
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((today - d) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function live(rows) {
    return (rows || []).filter(function (r) { return !window.Mock.isDeleted(r); });
  }
  /** Sticky-topbar shadow, shared by every page that has one. */
  function wireTopbar() {
    var tb = document.querySelector('.topbar');
    if (!tb) return;
    window.addEventListener('scroll', function () {
      tb.classList.toggle('stuck', window.scrollY > 4);
    }, { passive: true });
  }
  /** The always-present escape hatch back to the live pages. */
  function liveLinkHtml(href, label) {
    return '<a class="livelink" href="' + (href || '../index.html') + '">' +
           '<u>' + esc(label || 'Open the current version of this page') + '</u></a>';
  }

  window.V2 = {
    icon: icon,
    nav: nav, navMode: navMode, setNavMode: setNavMode, hubTiles: hubTiles, dest: dest,
    sheet: sheet, closeSheet: closeSheet, toast: toast, busy: busy,
    editSheet: editSheet,
    catGroups: catGroups, cardNames: cardNames, CARD_NONE: CARD_NONE,
    isExcludedIncome: isExcludedIncome, EXCLUDED_INCOME: EXCLUDED_INCOME,
    flags: flags, FLAG: FLAG, verifiedRefs: verifiedRefs,
    frequents: frequents, hideFrequent: hideFrequent, resetFrequents: resetFrequents,
    median: median, daysAgo: daysAgo,
    shortDay: shortDay, niceDay: niceDay, live: live,
    wireTopbar: wireTopbar, liveLinkHtml: liveLinkHtml, esc: esc
  };
})();
