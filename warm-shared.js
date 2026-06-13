/* Shared helpers for the Warm Journal production pages. Generic display
   helpers only — no data writes live here (those go through DataSource).
   Graduated from mockup/mock-shared.js (the read-only "nothing is saved" pill
   was dropped); the window.Mock namespace is kept so call sites are unchanged. */
(function () {
  'use strict';

  var USER_NAME = 'France';

  var GREETINGS = {
    morning: ['Good morning, ' + USER_NAME + ' ☀️',
              'Coffee first, numbers second ☕',
              'Morning, ' + USER_NAME + ' — fresh page today'],
    afternoon: ['Back at it, ' + USER_NAME,
                'Good afternoon, ' + USER_NAME + ' 🌤️',
                'Midday check-in — nice to see you'],
    evening: ['Evening wind-down 🌙',
              'Good evening, ' + USER_NAME,
              'Wrapping up the day, ' + USER_NAME + '?'],
  };

  function greeting() {
    var h = new Date().getHours();
    var pool = h < 12 ? GREETINGS.morning : h < 18 ? GREETINGS.afternoon : GREETINGS.evening;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function dateline() {
    return new Date().toLocaleDateString('en-GB',
      { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // Category -> emoji. Keys match review.html CAT_GROUPS exactly.
  var CAT_EMOJI = {
    'Food': '🍜', 'Drinks and Snacks': '☕', 'Transport': '🚇',
    'Health / Necessaries': '🩺', 'Shopping': '🛍',
    'Groceries': '🛒', 'Utilities and Subs': '💡',
    'Sports': '🎾', 'Social Expenses / Donation': '🎁',
    'With Roong': '💛', 'To Mom': '🌺', 'Other': '📦',
    'Salary': '💰', 'Bonus': '🎉', 'Reimbursement': '↩️',
    'Payback from someone': '🤝', 'Provident Fund': '🏦',
    'Mutual Fund': '📈', 'Coop Account': '🏦',
    'Saving for EOY Tax Deduction': '🧾', 'Interest payment': '🪙',
  };
  function catEmoji(cat) { return CAT_EMOJI[(cat || '').trim()] || '💸'; }

  function fmtBaht(n) {
    var v = Math.round(Number(n) || 0);
    return '฿' + v.toLocaleString('en-US');
  }

  function isDeleted(row) { return String(row.Deleted || '').toLowerCase() === 'true'; }
  function monthKey(dateStr) { return String(dateStr || '').slice(0, 7); } // 'YYYY-MM'
  function thisMonthKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // Build an income-category test from config, falling back to the hardcoded
  // list (mirrors monthly_report.html's fallback behavior).
  var FALLBACK_INCOME = ['Salary','Bonus','Reimbursement','Payback from someone',
    'Provident Fund','Mutual Fund','Coop Account','Saving for EOY Tax Deduction',
    'Interest payment'];
  function incomeTester(cfg) {
    var list = (cfg && Array.isArray(cfg.income_categories) && cfg.income_categories.length)
      ? cfg.income_categories : FALLBACK_INCOME;
    var set = {};
    list.forEach(function (c) { set[String(c).trim()] = true; });
    return function (cat) { return !!set[String(cat || '').trim()]; };
  }

  // Replace a section's content with a soft inline failure note.
  function softFail(el, msg) {
    if (el) el.innerHTML = '<div class="soft-note">' + msg + '</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  window.Mock = {
    greeting: greeting, dateline: dateline, catEmoji: catEmoji, fmtBaht: fmtBaht,
    isDeleted: isDeleted, monthKey: monthKey, thisMonthKey: thisMonthKey,
    incomeTester: incomeTester, softFail: softFail, escapeHtml: escapeHtml,
  };
})();
