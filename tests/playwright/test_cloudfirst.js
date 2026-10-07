// SF-CLOUDFIRST-S1-20261007 / SF-CLOUDFIRST-S2-20261007 : 保存層の作り直し（DESIGN-cloudfirst.md）の検証。
// 操作1回＝その1件だけが setDoc / updateDoc / deleteDoc で書かれること（Step 1）と、
// 読み込み層＝snapshot 丸ごと置換・送り返し全廃・TL_READY ゲート（Step 2）を確かめる。
// 番号は設計書「新設 test_cloudfirst.js」の項目番号：1〜9 すべて（4・5・6 のかなめは陰性対照）。
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

  // [6] pending-over-paid の書き込みが拒否されログが残る（VERGUARD 新形態・比較相手はクラウドビュー DATA）
  const r6 = await page.evaluate(() => {
    const paid = (DATA.visits || []).find(x => x.sfId === 'bk_ext1');
    const stale = JSON.parse(JSON.stringify(paid));   // 古い端末が持っていた参照（別オブジェクト）を再現
    stale.paymentStatus = 'pending';
    window.__fs.writes.length = 0;
    const logs = [];
    const orig = console.error;
    console.error = function () { logs.push(Array.prototype.join.call(arguments, ' ')); orig.apply(console, arguments); };
    const res = tlPut('visits', stale);
    console.error = orig;
    return { resNull: res === null, writes: window.__fs.writes.length,
             still: paid.paymentStatus, logged: logs.some(s => s.indexOf('拒否') >= 0) };
  });
  check('[6] pending-over-paid の書き込みは拒否・書き込み 0・DATA は paid のまま',
    r6.resNull && r6.writes === 0 && r6.still === 'paid', JSON.stringify(r6));
  check('[6] 拒否が console.error に残る', r6.logged);

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

  // [9] 全画面を一巡して pageerror ゼロ（旧 saveData / 旧シンボルの呼び残し検出）
  await page.evaluate(() => {
    ['search', 'reservation', 'paymentList', 'report', 'admin', 'internal', 'new', 'home'].forEach(s => navigate(s));
    if (typeof renderDailyReport === 'function') renderDailyReport();
    if (typeof renderMonthlyReport === 'function') renderMonthlyReport();
    navigate('home');
  });

  check('pageerror なし（＝テスト中に通った経路に saveData の呼び残しが無い）', errors.length === 0, errors.join(' | ').slice(0, 200));

  // ============================================================
  // Step 2（SF-CLOUDFIRST-S2-20261007）：別コンテキストで起動シーケンスを検証。
  // 起動キャッシュに「クラウドに無い古い記録」（他端末で削除済みの状況）を種まきして開く。
  // ============================================================
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(String(e && e.message || e)));
  await installStubs(page2);
  await page2.addInitScript((seed) => {
    localStorage.setItem('timely_school_data_v1', JSON.stringify(seed));
    localStorage.setItem('timely_school_branch_v1', seed.settings.branch);
  }, {
    customers: [{ id: 'C_old1', childName: '削除済 タロウ', childKana: 'サクジョズミ タロウ', branch: BRANCH,
      updatedAt: '2026-09-01T00:00:00.000Z' }],
    visits: [{ id: 'V_old1', customerId: 'C_old1', childName: '削除済 タロウ', branch: BRANCH,
      visitDate: '2026-09-25', visitStart: '10:00', visitEnd: '12:00', usageType: 'temporary',
      paymentStatus: 'pending', createdAt: '2026-09-25T01:00:00.000Z', updatedAt: '2026-09-25T01:00:00.000Z' }],
    students: [], reservations: [],
    settings: { branch: BRANCH, staff: ['テスト'] },
  });
  await page2.goto(FILE);
  await page2.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_visits'), null, { timeout: 15000 });

  // [5] TL_READY 前：仮表示（キャッシュ）はあるが、書き込みを伴う操作はゲートで止まる
  const r5a = await page2.evaluate(() => {
    window.__fs.writes.length = 0;
    const cached = (DATA.visits || []).length;        // loadData の仮表示
    sfKinderTapIn('bk_ext2');                          // 受付 → ゲートが先に止める
    const t1 = (document.querySelector('#sfSyncBox .ttl') || {}).textContent; sfSyncClose();
    tlDeleteVisit('V_old1');                           // 会計記録の削除 → 同じく止まる
    const t2 = (document.querySelector('#sfSyncBox .ttl') || {}).textContent; sfSyncClose();
    const put = tlPut('visits', { id: 'V_gate1', paymentStatus: 'pending' });   // 最終防衛線の直叩き
    sfSyncClose();
    return { cached, t1, t2, putNull: put === null, ready: tlReadyAll(),
             writes: window.__fs.writes.length, stillThere: DATA.visits.some(v => v.id === 'V_old1') };
  });
  check('[5] TL_READY 前は受付・削除がゲートで止まり「クラウドと同期中です」が出る',
    r5a.ready === false && r5a.cached === 1 && r5a.t1 === 'クラウドと同期中です' && r5a.t2 === 'クラウドと同期中です'
    && r5a.stillThere, JSON.stringify(r5a));
  check('[5] ゲート中は書き込みゼロ（tlPut 直叩きも拒否）', r5a.putNull && r5a.writes === 0);

  // 初回 snapshot：クラウドに古い記録は無い（＝他端末で削除済み）
  await page2.evaluate(() => {
    window.__fs.writes.length = 0;
    window.__emit('sf_customers', [], false);
    window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false);
    window.__emit('sf_bookings', [], false);
  });
  await page2.waitForFunction(() => tlReadyAll(), null, { timeout: 5000 });
  await page2.waitForTimeout(600);   // 旧構造ならこの間に初回送り返し（fbReconcileTl の set）が出ていた

  // [4] 陰性対照：起動完了までクラウドへ何も送信されない＋古い記録は復活しない
  const r4 = await page2.evaluate(() => ({
    tlWrites: window.__fs.writes.filter(w => /^sf_(visits|customers|students)\//.test(w.path)).length,
    bkWrites: window.__fs.writes.filter(w => w.path.indexOf('sf_bookings/') === 0).length,
    allWrites: window.__fs.writes.map(w => w.op + ':' + w.path),
    oldGone: !(DATA.visits || []).some(v => v.id === 'V_old1') && !(DATA.customers || []).some(c => c.id === 'C_old1'),
    cachedGone: !((JSON.parse(localStorage.getItem('timely_school_data_v1')) || {}).visits || []).some(v => v.id === 'V_old1'),
  }));
  check('[4] 陰性対照：キャッシュの古い記録が起動後もクラウドへ送信されない（localOnly 送り返しの根絶）',
    r4.tlWrites === 0 && r4.bkWrites === 0, JSON.stringify(r4.allWrites));
  check('[4] クラウドに無い古い visit / customer は表示からもキャッシュからも消える', r4.oldGone && r4.cachedGone);

  // [5b] TL_READY 後はゲートが解放され、受付が1件書きで通る
  await page2.evaluate((t) => {
    window.__emit('sf_bookings', [{ id: 'bk_ext2', gardenId: 'tsukisamu', date: t, start: '16:30', end: '17:30',
      salon: 'ext_pm', affiliation: 'youchisha', name: 'ゲート カイホウ', kana: '', fromBoard: true, provisional: false }], false);
  }, today);
  await page2.waitForFunction(() => (sfLoadShared() || []).some(r => r.id === 'bk_ext2'), null, { timeout: 5000 });
  const r5b = await page2.evaluate(() => {
    window.__fs.writes.length = 0;
    sfKinderTapIn('bk_ext2');
    const v = (DATA.visits || []).find(x => x.sfId === 'bk_ext2') || null;
    return { ok: !!v, writes: window.__fs.writes.filter(w => w.path.indexOf('sf_visits/') === 0).length };
  });
  check('[5] TL_READY 後はゲートが解放され受付できる（set 1件）', r5b.ok && r5b.writes === 1, JSON.stringify(r5b));

  check('pageerror なし（Step 2 起動シーケンス）', errors2.length === 0, errors2.join(' | ').slice(0, 200));
  await ctx2.close();

  await browser.close();
  console.log(fails ? ('FAILED: ' + fails) : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
