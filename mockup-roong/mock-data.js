// ---------------------------------------------------------------------------
// Mock DataSource for the Roong-settlement redesign previews.
// Same method names + return shapes as the real data-source.js, backed by an
// in-memory store seeded with realistic placeholder data. This lets the preview
// mockups run the REAL page logic end-to-end (select / share / send / confirm /
// cancel / history) without a backend. No real data is used.
// ---------------------------------------------------------------------------
(function () {
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function nowISO() { return new Date().toISOString(); }

  // --- Seed data ---------------------------------------------------------
  var unsettledSeed = [
    { RefID: '#0481', Date: '2026-06-02', Description: 'Hot pot dinner with Roong', Amount: 1240, Note: 'KTC' },
    { RefID: '#0487', Date: '2026-06-05', Description: 'Grocery run w/ Roong', Amount: 860, Note: 'Lotus’s' },
    { RefID: '#0492', Date: '2026-06-07', Description: 'Movie tickets with Roong', Amount: 480, Note: 'Cash' },
    { RefID: '#0498', Date: '2026-06-09', Description: 'Cafe brunch w Roong', Amount: 530, Note: 'KTC' },
    { RefID: '#0505', Date: '2026-06-11', Description: 'Taxi to airport with Roong', Amount: 360, Note: 'Cash' },
  ];

  var pendingSeed = [
    {
      settlement_id: 'RS-2026-0531-1',
      requested_amount: 1130,
      created_at: '2026-05-31T09:12:00Z',
      expense_rows: [
        { RefID: '#0455', Date: '2026-05-24', Description: 'Dinner at Gaa with Roong', roong_share: 900 },
        { RefID: '#0461', Date: '2026-05-27', Description: 'Bookstore w/ Roong', roong_share: 230 },
      ],
    },
  ];

  var historySeed = [
    {
      settlement_id: 'RS-2026-0510-1',
      requested_amount: 640,
      created_at: '2026-05-10T14:02:00Z',
      expense_rows: [
        { RefID: '#0410', Date: '2026-05-03', Description: 'Lunch with Roong', roong_share: 240 },
        { RefID: '#0418', Date: '2026-05-06', Description: 'Pharmacy w Roong', roong_share: 400 },
      ],
    },
    {
      settlement_id: 'RS-2026-0428-1',
      requested_amount: 1500,
      created_at: '2026-04-28T11:30:00Z',
      expense_rows: [
        { RefID: '#0388', Date: '2026-04-21', Description: 'Weekend trip hotel with Roong', roong_share: 1500 },
      ],
    },
  ];

  // --- Mutable store -----------------------------------------------------
  var store = {
    unsettled: clone(unsettledSeed),
    pending: clone(pendingSeed),
    history: clone(historySeed),
    seq: 2,
  };

  function delay(v) { return new Promise(function (res) { setTimeout(function () { res(v); }, 180); }); }

  window.DataSource = {
    isLocal: function () { return false; }, // preview emulates phone / GitHub mode

    loadRoongUnsettled: function () { return delay(clone(store.unsettled)); },
    loadRoongPending:   function () { return delay(clone(store.pending)); },
    loadRoongHistory:   function () { return delay(clone(store.history)); },

    submitRoongRequest: function (items) {
      // items: [{RefID, roong_share}]
      var ids = items.map(function (i) { return i.RefID; });
      var rows = store.unsettled.filter(function (r) { return ids.indexOf(r.RefID) !== -1; });
      var total = items.reduce(function (s, i) { return s + (parseFloat(i.roong_share) || 0); }, 0);
      var shareById = {};
      items.forEach(function (i) { shareById[i.RefID] = parseFloat(i.roong_share) || 0; });
      var sid = 'RS-2026-0614-' + (store.seq++);
      store.pending.unshift({
        settlement_id: sid,
        requested_amount: total,
        created_at: nowISO(),
        expense_rows: rows.map(function (r) {
          return { RefID: r.RefID, Date: r.Date, Description: r.Description, roong_share: shareById[r.RefID] };
        }),
      });
      store.unsettled = store.unsettled.filter(function (r) { return ids.indexOf(r.RefID) === -1; });
      return delay({ settlement_id: sid, requested_amount: total });
    },

    confirmRoong: function (sid) {
      var idx = store.pending.findIndex(function (b) { return b.settlement_id === sid; });
      if (idx === -1) return delay({ settlement_id: sid });
      var batch = store.pending.splice(idx, 1)[0];
      store.history.unshift(batch);
      return delay({ settlement_id: sid, requested_amount: batch.requested_amount, confirmed_at: nowISO() });
    },

    cancelRoong: function (sid) {
      var idx = store.pending.findIndex(function (b) { return b.settlement_id === sid; });
      if (idx === -1) return delay({ settlement_id: sid });
      var batch = store.pending.splice(idx, 1)[0];
      // Return its rows to the unsettled list (rebuild a plausible row shape).
      (batch.expense_rows || []).forEach(function (r) {
        store.unsettled.push({
          RefID: r.RefID, Date: r.Date, Description: r.Description,
          Amount: Math.round((parseFloat(r.roong_share) || 0) * 2), Note: '',
        });
      });
      store.unsettled.sort(function (a, b) { return (a.Date || '') < (b.Date || '') ? -1 : 1; });
      return delay({ settlement_id: sid });
    },
  };
})();
