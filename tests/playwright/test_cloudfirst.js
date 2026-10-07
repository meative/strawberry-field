// SF-CLOUDFIRST-S1-20261007 : 書き込み層の作り直し Step 1（DESIGN-cloudfirst.md）の検証。
// 操作1回＝その1件だけが setDoc / updateDoc / deleteDoc で書かれること
// （配列まるごとの書き直しが無いこと）と、saveData の廃止（throw 化）を確かめる。
// 番号は設計書「新設 test_cloudfirst.js」の項目番号：今回は Step 1 ぶんの 1・2・3・7・8・9。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILE = 'file://' + path.join(APPS, 'timely.html');
const BRANCH = '月寒園';

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) fails++;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.addInitScript((seed) => {
    localStorage.setItem('timely_school_data_v1', JSON.stringify(seed));
    localStorage.setItem('timely_school_branch_v1', seed.settings.branch);
  }, { customers: [], visits: [], students: [], settings: { branch: BRANCH, staff: ['テスト'] }, reservations: [] });
  await page.goto(FILE);
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
  const today = await page.evaluate(() => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); });

  // 初回スナップショット（空の業務データ＋予約2件：延長のタップ受付用と patch 用）
  const bookings = [
    { id: 'bk_ext1', gardenId: 'tsukisamu', date: today, start: '16:30', end: '17:30',
      salon: 'ext_pm', affiliation: 'youchisha', name: 'テスト タロウ', kana: '', fromBoard: true, provisional: false },
    { id: 'bk_temp1', gardenId: 'tsukisamu', date: today, start: '10:00', end: '12:00',
      salon: 'woodstock', name: 'テスト ハナコ', kana: 'テスト ハナコ', fromBoard: true, provisional: false, memo: 'メモは無傷のこと' },
  ];
  await page.evaluate((o) => {
    window.__emit('sf_customers', [], false); window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false); window.__emit('sf_bookings', o.bookings, false);
  }, { bookings });
  await page.waitForFunction(() => (sfLoadShared() || []).some(r => r.id === 'bk_ext1'), null, { timeout: 5000 });

  // [1] 受付1回 → sf_visits の set が1件だけ（他のコレクション・他の doc への書き込みゼロ）
  const r1 = await page.evaluate(() => {
    window.__fs.writes.length = 0;
    sfKinderTapIn('bk_ext1');
    const v = (DATA.visits || []).find(x => x.sfId === 'bk_ext1') || null;
    return { visitId: v && v.id, updatedAt: v && v.updatedAt,
             writes: window.__fs.writes.map(w => w.op + ':' + w.path) };
  });
  check('[1] 受付1回で sf_visits の set が1件だけ',
    r1.visitId && r1.writes.length === 1 && r1.writes[0] === 'set:sf_visits/' + r1.visitId,
    JSON.stringify(r1.writes));
  check('[1] tlPut が updatedAt を刻印する', !!r1.updatedAt);

  // [2] 会計確定（approvePayment と同じ tlOpBegin + tlPut 経路）→ 同じ doc の set 1件・paid
  const r2 = await page.evaluate(() => {
    window.__fs.writes.length = 0;
    const v = (DATA.visits || []).find(x => x.sfId === 'bk_ext1');
    v.paymentStatus = 'paid';
    v.paidAt = new Date().toISOString();
    v.totalAmount = 700;
    tlOpBegin();
    tlPut('visits', v);
    const w = window.__fs.writes;
    return { n: w.length, op: w[0] && w[0].op, path: w[0] && w[0].path,
             paid: w[0] && w[0].data.paymentStatus, vid: v.id, waits: __sfSaveWaits.length };
  });
  check('[2] 会計確定で同じ doc の set が1件だけ・paid で届く',
    r2.n === 1 && r2.op === 'set' && r2.path === 'sf_visits/' + r2.vid && r2.paid === 'paid',
    JSON.stringify(r2));
  check('[2] tlOpBegin 後の見届け対象はこの1件だけ', r2.waits === 1, 'waits=' + r2.waits);

  // [3] 削除 → deleteDoc 1件。削除反映後の snapshot を流しても復活しない
  const r3 = await page.evaluate(() => {
    const v = (DATA.visits || []).find(x => x.sfId === 'bk_ext1');
    window.__fs.writes.length = 0;
    tlDeleteVisitExec(v.id);
    const afterDel = window.__fs.writes.map(w => w.op + ':' + w.path);
    // 他端末にも削除が行き渡ったあとの snapshot（空）を流す ＝ 2回目以降の経路
    window.__emit('sf_visits', [], false);
    return { vid: v.id, afterDel,
             stillThere: (DATA.visits || []).some(x => x.id === v.id) };
  });
  check('[3] 削除で deleteDoc が1件だけ',
    r3.afterDel.length === 1 && r3.afterDel[0] === 'delete:sf_visits/' + r3.vid,
    JSON.stringify(r3.afterDel));
  check('[3] 削除反映後の snapshot で復活しない', r3.stillThere === false);

  // [7] 予約消費 → sf_bookings への updateDoc(patch)。対象外フィールドは無傷
  const r7 = await page.evaluate(() => {
    window.__fs.writes.length = 0;
    sfPatchBooking('bk_temp1', { tlDone: true, tlVisitId: 'V_dummy1' });
    const w = window.__fs.writes;
    const rec = (SF_MIRROR || []).find(r => r.id === 'bk_temp1');
    return { n: w.length, op: w[0] && w[0].op, path: w[0] && w[0].path,
             patchKeys: w[0] ? Object.keys(w[0].data).sort().join(',') : '',
             mirrorDone: rec && rec.tlDone, mirrorMemo: rec && rec.memo, mirrorName: rec && rec.name };
  });
  check('[7] 予約消費は updateDoc(patch) 1件（set ではない）',
    r7.n === 1 && r7.op === 'update' && r7.path === 'sf_bookings/bk_temp1' && r7.patchKeys === 'tlDone,tlVisitId',
    JSON.stringify(r7));
  check('[7] 写しは楽観更新・対象外フィールド（memo/name）は無傷',
    r7.mirrorDone === true && r7.mirrorMemo === 'メモは無傷のこと' && r7.mirrorName === 'テスト ハナコ');

  // [7b] 受付発予約の upsert は set 1件、明示削除は delete 1件、上限超過は 0 件
  const r7b = await page.evaluate(() => {
    window.__fs.writes.length = 0;
    sfUpsertShared({ id: 'tl_test1', gardenId: 'tsukisamu', salon: 'temp', name: 'テスト', date: '2026-10-07', start: '10:00', end: '11:00', fromBoard: false });
    const up = window.__fs.writes.map(w => w.op + ':' + w.path);
    window.__fs.writes.length = 0;
    sfRemoveSharedMany(['tl_test1']);
    const del = window.__fs.writes.map(w => w.op + ':' + w.path);
    window.__fs.writes.length = 0;
    const refused = sfRemoveSharedMany(['a1','a2','a3','a4','a5','a6','a7','a8','a9']);   // SF_DELGUARD_MAX=8 超
    return { up, del, refused, refusedWrites: window.__fs.writes.length };
  });
  check('[7b] upsert は set 1件', r7b.up.length === 1 && r7b.up[0] === 'set:sf_bookings/tl_test1', JSON.stringify(r7b.up));
  check('[7b] 明示削除は delete 1件', r7b.del.length === 1 && r7b.del[0] === 'delete:sf_bookings/tl_test1', JSON.stringify(r7b.del));
  check('[7b] 上限（SF_DELGUARD_MAX）超の削除は拒否・書き込み 0', r7b.refused === false && r7b.refusedWrites === 0);

  // [8] 会計下書き（saveHandoverDraft）→ sf_visits の set 1件・updatedAt 刻印
  const r8 = await page.evaluate(() => {
    const v = { id: 'V_draft1', customerId: null, childName: 'テスト コドモ', branch: DATA.settings.branch,
      createdAt: new Date().toISOString(), visitDate: '2026-10-07', visitStart: '10:00', visitEnd: '12:00',
      usageType: 'temporary', paymentStatus: 'pending', agreed: true, items: [] };
    DATA.visits.push(v);
    currentPaymentVisit = v;
    window.__fs.writes.length = 0;
    saveHandoverDraft();
    const w = window.__fs.writes.filter(x => x.path === 'sf_visits/V_draft1');
    return { n: w.length, op: w[0] && w[0].op,
             updatedAt: w[0] && w[0].data.updatedAt, handoverUpdatedAt: w[0] && w[0].data.handoverUpdatedAt,
             total: window.__fs.writes.length };
  });
  check('[8] 下書き保存で sf_visits の set 1件だけ', r8.n === 1 && r8.total === 1 && r8.op === 'set', JSON.stringify(r8));
  check('[8] 下書きにも updatedAt が刻印される（版ガード負けの穴の根治）', !!r8.updatedAt && !!r8.handoverUpdatedAt);

  // [9] saveData は throw 化（呼び残し検出）・封印した管理機能は何もしない
  const r9 = await page.evaluate(() => {
    let thrown = '';
    try { saveData(DATA); } catch (e) { thrown = String(e && e.message || e); }
    window.__fs.writes.length = 0;
    const before = JSON.stringify({ c: DATA.customers.length, v: DATA.visits.length, s: (DATA.students || []).length });
    resetAllData();
    loadSampleData();
    const after = JSON.stringify({ c: DATA.customers.length, v: DATA.visits.length, s: (DATA.students || []).length });
    return { thrown, unchanged: before === after, writes: window.__fs.writes.length };
  });
  check('[9] saveData は throw する（呼び残し検出）', r9.thrown.indexOf('SF-CLOUDFIRST') >= 0, r9.thrown.slice(0, 60));
  check('[9] 封印した resetAllData / loadSampleData は何もしない（確認ダイアログも出ない）',
    r9.unchanged && r9.writes === 0, JSON.stringify(r9));
  const srcCount = (fs.readFileSync(path.join(APPS, 'timely.html'), 'utf8').match(/saveData\(DATA\)/g) || []).length;
  check('[9] ソース上の saveData(DATA) 残存は封印済み死コードの1箇所だけ', srcCount === 1, 'count=' + srcCount);

  check('pageerror なし（＝テスト中に通った経路に saveData の呼び残しが無い）', errors.length === 0, errors.join(' | ').slice(0, 200));

  await browser.close();
  console.log(fails ? ('FAILED: ' + fails) : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
