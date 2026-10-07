// SF-RESMATCH-20260930 : timely.html の selectFromReservation('sf:...') が登録済みの子を探すことを検証する。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILE = 'file://' + path.join(APPS, 'timely.html');
const BRANCH = 'サッポロファクトリー園';   // loadData() の既定 → gardenId 'factory'

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) fails++;
}

const CUSTOMERS = [
  { id: 'C1', branch: BRANCH, childName: '森 はると', childKana: 'モリ ハルト', birthY: 2023, birthM: 3, birthD: 2, parentTel: '09000000001', createdAt: '2026-07-01T00:00:00.000Z' },
  { id: 'C2', branch: BRANCH, childName: '田中 さくら', childKana: 'タナカ サクラ', birthY: 2022, birthM: 5, birthD: 6, parentTel: '09000000002', createdAt: '2026-07-01T00:00:00.000Z' },
  { id: 'C3', branch: '月寒園', childName: '森 ゆい', childKana: 'モリ ユイ', birthY: 2024, birthM: 1, birthD: 9, parentTel: '09000000003', createdAt: '2026-07-01T00:00:00.000Z' },
];
function bookings(today) {
  const base = { gardenId: 'factory', date: today, start: '10:00', end: '12:00', fromBoard: true, provisional: false };
  return [
    { ...base, id: 'board_1', name: '森 はると', kana: 'モリ ハルト' },              // 完全一致1件
    { ...base, id: 'board_2', name: 'モリ ハルト', kana: '', provisional: true },    // カタカナ仮名（ふりがな側と完全一致）
    { ...base, id: 'board_3', name: 'モリ', kana: '' , provisional: true },         // 姓だけ → 前方一致 2件
    { ...base, id: 'board_4', name: 'スズキ', kana: '', provisional: true },        // 該当なし
    { ...base, id: 'board_5', name: 'モ', kana: '', provisional: true },            // 1文字 → 前方一致しない（陰性対照）
    { ...base, id: 'bk_6', name: '森 はると', kana: 'モリ ハルト', salon: 'woodstock', fromBoard: false },  // サロン発
    { ...base, id: 'board_7', name: 'タナカ', kana: '', provisional: true },        // 前方一致1件（完全一致なし）→ 確認
  ];
}

async function boot(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.addInitScript((seed) => {
    localStorage.setItem('timely_school_data_v1', JSON.stringify(seed));
  }, { customers: [], visits: [], students: [], settings: { branch: BRANCH, staff: ['テスト'] },
       reservations: opts.localReservations || [] });
  await page.goto(FILE);
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_customers') && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
  const today = await page.evaluate(() => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); });
  if (!opts.skipCustomers) {
    await page.evaluate((rows) => { window.__emit('sf_customers', rows, false); window.__emit('sf_visits', [], false); window.__emit('sf_students', [], false); }, CUSTOMERS);
  }
  await page.evaluate((rows) => window.__emit('sf_bookings', rows, false), bookings(today));
  await page.waitForFunction(() => (DATA.reservations || []).some(r => r.sfId === 'board_1'), null, { timeout: 5000 });
  await page.evaluate('window.__state = ' + state.toString());
  return { ctx, page, errors, today };
}

const state = () => ({
  screen: (document.querySelector('.screen.active') || {}).id,
  cust: currentCustomer ? currentCustomer.id : null,
  pending: window._pendingResSfId || null,
  popup: (function () { const ov = document.getElementById('sfSyncOv'); return ov && ov.classList.contains('show') ? { title: document.querySelector('#sfSyncBox .ttl').textContent, btns: Array.from(document.querySelectorAll('#sfSyncBox .btns button')).map(b => b.textContent) } : null; })(),
  visitDate: (document.getElementById('visitDate') || {}).value,
  sH: (document.getElementById('visitStartH') || {}).value, sM: (document.getElementById('visitStartM') || {}).value,
  eH: (document.getElementById('visitEndH') || {}).value,
  newName: (document.getElementById('childName') || {}).value,
});

(async () => {
  const browser = await chromium.launch();

  // ---- 環境の前提 ----
  {
    const { ctx, page, errors, today } = await boot(browser);
    const pre = await page.evaluate(() => ({
      synced: TL_READY.customers, n: DATA.customers.length, res: DATA.reservations.filter(r => r.fromBoard).length,
      branch: DATA.settings.branch, hasFn: typeof sfResMatchCustomers,
    }));
    check('precondition: customers synced (3), 7 board reservations imported, helpers defined',
      pre.synced && pre.n === 3 && pre.res === 7 && pre.hasFn === 'function', JSON.stringify(pre));

    // T1 完全一致1件 → visit（時刻・日付は予約から、_pendingResSfId 保持）
    await page.evaluate(() => selectFromReservation('sf:board_1'));
    let s = await page.evaluate(state);
    check('T1 exact single match → visit screen with C1, times preset, pending kept',
      s.screen === 'screen-visit' && s.cust === 'C1' && s.pending === 'board_1' && s.visitDate === today && String(s.sH) === '10' && String(s.sM) === '0' && String(s.eH) === '12', JSON.stringify(s));

    // T2 カタカナ仮名（ふりがな側と完全一致）→ visit
    await page.evaluate(() => { navigate('home'); selectFromReservation('sf:board_2'); });
    s = await page.evaluate(state);
    check('T2 katakana provisional name matches childKana → visit with C1', s.screen === 'screen-visit' && s.cust === 'C1' && s.pending === 'board_2', JSON.stringify(s));

    // T3 姓だけ → 2件の選択モーダル（生年月日つき）。2件目を選ぶと C3 で visit
    await page.evaluate(() => { navigate('home'); selectFromReservation('sf:board_3'); });
    s = await page.evaluate(state);
    const okModal = s.popup && s.popup.btns.length === 4 && /2023年3月2日/.test(s.popup.btns[0]) && /2024年1月9日/.test(s.popup.btns[1]) && /月寒園/.test(s.popup.btns[1])
      && s.popup.btns[2] === '別のお子様として新規登録' && s.popup.btns[3] === 'やめる' && s.screen === 'screen-home';
    check('T3 surname-only → selection modal with 2 candidates (birth dates, other-garden label), screen unchanged', !!okModal, JSON.stringify(s.popup));
    await page.evaluate(() => document.querySelectorAll('#sfSyncBox .btns button')[1].click());
    s = await page.evaluate(state);
    check('T3b choosing 2nd candidate → visit with C3, pending kept', s.screen === 'screen-visit' && s.cust === 'C3' && s.pending === 'board_3' && !s.popup, JSON.stringify(s));

    // T3c 「やめる」で pending が解除される
    await page.evaluate(() => { navigate('home'); selectFromReservation('sf:board_3'); });
    await page.evaluate(() => Array.from(document.querySelectorAll('#sfSyncBox .btns button')).find(b => b.textContent === 'やめる').click());
    s = await page.evaluate(() => Object.assign(window.__state(), { rt: window._reservedTimes }));
    check('T3c cancel → stays home, pending/_reservedTimes cleared', s.screen === 'screen-home' && s.pending === null && s.rt === null && !s.popup, JSON.stringify(s));

    // T3d 「別のお子様として新規登録」→ new 画面に氏名プリセット
    await page.evaluate(() => selectFromReservation('sf:board_3'));
    await page.evaluate(() => Array.from(document.querySelectorAll('#sfSyncBox .btns button')).find(b => b.textContent === '別のお子様として新規登録').click());
    await page.waitForTimeout(50);
    s = await page.evaluate(state);
    check('T3d "register as another child" → new screen with name preset, pending kept', s.screen === 'screen-new' && s.newName === 'モリ' && s.pending === 'board_3', JSON.stringify(s));

    // T4 該当なし（同期済み）→ 従来どおり新規登録へ
    await page.evaluate(() => { navigate('home'); selectFromReservation('sf:board_4'); });
    await page.waitForTimeout(50);
    s = await page.evaluate(state);
    check('T4 no match & synced → new screen, name preset, pending kept', s.screen === 'screen-new' && s.newName === 'スズキ' && s.pending === 'board_4' && s.cust === null && !s.popup, JSON.stringify(s));

    // T5 陰性対照：1文字は前方一致しない → 新規登録
    await page.evaluate(() => { navigate('home'); selectFromReservation('sf:board_5'); });
    await page.waitForTimeout(50);
    s = await page.evaluate(state);
    check('T5 negative control: 1-char name does not prefix-match → new screen', s.screen === 'screen-new' && s.newName === 'モ' && !s.popup, JSON.stringify(s));

    // T6 前方一致1件（完全一致なし）→ 自動では選ばず確認モーダル
    await page.evaluate(() => { navigate('home'); selectFromReservation('sf:board_7'); });
    s = await page.evaluate(state);
    check('T6 prefix-only single candidate → confirm modal (not auto-selected)', s.screen === 'screen-home' && s.popup && s.popup.btns.length === 3 && /田中 さくら/.test(s.popup.btns[0]), JSON.stringify(s.popup));
    await page.evaluate(() => document.querySelectorAll('#sfSyncBox .btns button')[0].click());
    s = await page.evaluate(state);
    check('T6b confirm → visit with C2', s.screen === 'screen-visit' && s.cust === 'C2' && s.pending === 'board_7', JSON.stringify(s));

    // T7 回帰：サロン発予約 → 既存客で visit → 保存でサロン割引判定（salon:'woodstock'）と tlDone 消費
    await page.evaluate(() => { navigate('home'); selectFromReservation('sf:bk_6'); });
    s = await page.evaluate(state);
    check('T7 salon-origin reservation → visit with C1', s.screen === 'screen-visit' && s.cust === 'C1' && s.pending === 'bk_6', JSON.stringify(s));
    const r7 = await page.evaluate(async () => {
      document.getElementById('agreeCheck').checked = true;
      const w0 = window.__fs.writes.length;
      submitVisit(true);
      await new Promise(res => setTimeout(res, 50));
      const v = DATA.visits[DATA.visits.length - 1] || {};
      const shared = sfLoadShared().find(r => r.id === 'bk_6') || {};
      const writes = window.__fs.writes.slice(w0);
      const bkWrite = writes.find(x => x.path === 'sf_bookings/bk_6');
      return { salon: v.salon, cust: v.customerId, name: v.childName, resGone: !(DATA.reservations || []).some(r => r.sfId === 'bk_6'),
        tlDone: shared.tlDone === true, tlVisitId: shared.tlVisitId === v.id, sharedName: shared.name, pending: window._pendingResSfId || null,
        bkWrite: !!(bkWrite && bkWrite.data && bkWrite.data.tlDone === true && bkWrite.data.name === '森 はると'),
        visitWrite: writes.some(x => x.path === 'sf_visits/' + v.id && x.data && x.data.salon === 'woodstock') };
    });
    check('T7b submitVisit: visit.salon=woodstock, customerId=C1, reservation consumed, shared tlDone+tlVisitId+name written to cloud',
      r7.salon === 'woodstock' && r7.cust === 'C1' && r7.resGone && r7.tlDone && r7.tlVisitId && r7.sharedName === '森 はると' && r7.pending === null && r7.bkWrite && r7.visitWrite, JSON.stringify(r7));

    // T8 陰性対照：sf: でないキー（登録済み顧客の予約）は従来経路のまま
    await page.evaluate((today) => { navigate('home'); DATA.reservations.push({ customerId: 'C2', branch: DATA.settings.branch, reservationDate: today, reservationStart: '13:00', reservationEnd: '15:00' }); selectFromReservation('C2|' + today); }, today);
    s = await page.evaluate(state);
    check('T8 negative control: customerId|date key → visit with C2, pending untouched (null)', s.screen === 'screen-visit' && s.cust === 'C2' && s.pending === null && String(s.sH) === '13', JSON.stringify(s));

    // T9 予約一覧の UI 経路：ボタンの onclick が sf: キーのまま（描画の回帰なし）
    const ui = await page.evaluate(() => { navigate('home'); _resListViewMode = 'today'; navigate('reservation'); renderReservationList(); return document.getElementById('reservationListBody').innerHTML.includes("selectFromReservation('sf:board_1')"); });
    check('T9 reservation list still renders sf: keys for board reservations', ui);

    const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
    check('no page errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---- 未同期：顧客スナップショット未着のまま該当なし → 新規登録に飛ばさない ----
  {
    const { ctx, page, errors } = await boot(browser, { skipCustomers: true });
    const pre = await page.evaluate(() => ({ synced: TL_READY.customers, n: DATA.customers.length }));
    await page.evaluate(() => selectFromReservation('sf:board_4'));
    const s = await page.evaluate(() => Object.assign(window.__state(), { rt: window._reservedTimes }));
    check('U1 unsynced & no local match → "顧客データを同期中です" popup, stays home, pending cleared',
      !pre.synced && pre.n === 0 && s.screen === 'screen-home' && s.popup && s.popup.title === '顧客データを同期中です' && s.pending === null && s.rt === null, JSON.stringify(s));
    // 同期後は同じ予約で新規登録へ進める
    await page.evaluate((rows) => { sfSyncClose(); window.__emit('sf_customers', rows, false); selectFromReservation('sf:board_4'); }, CUSTOMERS);
    await page.waitForTimeout(50);
    const s2 = await page.evaluate(state);
    check('U2 after customers arrive → same reservation proceeds to new screen', s2.screen === 'screen-new' && s2.newName === 'スズキ' && s2.pending === 'board_4', JSON.stringify(s2));
    // 未同期でも手元に一致があれば受付へ進める
    const { ctx: ctx2, page: page2 } = await boot(browser, { skipCustomers: true });
    await page2.evaluate((c) => { DATA.customers.push(c); selectFromReservation('sf:board_1'); }, CUSTOMERS[0]);
    const s3 = await page2.evaluate(state);
    check('U3 unsynced but local exact match → visit (does not block)', s3.screen === 'screen-visit' && s3.cust === 'C1', JSON.stringify(s3));
    const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
    check('no page errors (unsynced run)', relevant.length === 0, relevant.slice(0, 3).join(' | '));
    await ctx.close(); await ctx2.close();
  }

  await browser.close();
  console.log(fails ? ('\nFAILED: ' + fails) : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
