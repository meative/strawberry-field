// SF-UNSENTBOX-20261014 : 未送信箱（永続）＋10秒見届け＋受付証跡＋送信前の接続張り直しの検証。
// stubs.js の window.__fsHang で「setDoc が失敗せず永遠に未決着」（2026-10-13/14 の消失状況）を再現する。
// [1] 10秒後に赤帯「未送信 n件」と localStorage の箱（kind・id・rec・at）
// [2] リロード後に箱から再送され、決着（ok）で箱が空になる（起動時・online・sfWakeSync 後の3経路）
// [3] snapshot 由来のレコードは箱に入らない／成功した書き込みも入らない（陰性対照）
// [4] 7日より古い控えは赤帯で知らせるだけで自動再送しない（手動タップでも送らない）
// [C] 最終 snapshot 受信から90秒超の書き込みで、送信前に接続を張り直す（disableNetwork→enableNetwork）
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILE = 'file://' + path.join(APPS, 'timely.html');
const BOX_KEY = 'timely_unsent_box_v1';
const BRANCH = '月寒園';

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  [' + (extra || '') + ']'));
  if (!ok) fails++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.addInitScript((seed) => {
    localStorage.setItem('timely_school_data_v1', JSON.stringify(seed));
  }, { customers: [], visits: [], students: [], reservations: [], settings: { branch: BRANCH, staff: ['テスト'] } });
  await page.goto(FILE);
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_visits'), null, { timeout: 15000 });
  const today = await page.evaluate(() => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); });
  const bookings = [{ id: 'bk_ext1', gardenId: 'tsukisamu', date: today, start: '16:30', end: '17:30',
    salon: 'ext_pm', affiliation: 'youchisha', name: 'テスト タロウ', kana: '', fromBoard: true, provisional: false }];
  await page.evaluate((o) => {
    window.__emit('sf_customers', [], false); window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false); window.__emit('sf_bookings', o.bookings, false);
  }, { bookings });
  await page.waitForFunction(() => (sfLoadShared() || []).some(r => r.id === 'bk_ext1'), null, { timeout: 5000 });

  // ============ [1] 未決着の setDoc → 10秒後に赤帯＋箱 ============
  const r1a = await page.evaluate(() => {
    window.__fsHang = true;   // 以後の書き込みは失敗せず永遠に未決着
    window.__fs.writes.length = 0;
    sfKinderTapIn('bk_ext1');
    const v = (DATA.visits || []).find(x => x.sfId === 'bk_ext1') || null;
    return { visitId: v && v.id,
             writes: window.__fs.writes.map(w => w.op + ':' + w.path),
             boxNow: JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length,
             barNow: !!document.querySelector('#sfSyncBar.show') };
  });
  check('[1] 受付は画面に楽観反映され、visit の set＋予約証跡の update が発行される（どちらも未決着）',
    !!r1a.visitId && r1a.writes.length === 2 && r1a.writes[0] === 'set:sf_visits/' + r1a.visitId
    && r1a.writes[1] === 'update:sf_bookings/bk_ext1', JSON.stringify(r1a.writes));
  check('[1] 10秒経つまでは箱は空・赤帯も出ない（見届け中）', r1a.boxNow === 0 && r1a.barNow === false,
    JSON.stringify({ box: r1a.boxNow, bar: r1a.barNow }));
  await sleep(11000);
  const r1b = await page.evaluate(() => {
    const box = JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]');
    const bar = document.querySelector('#sfSyncBar.show');
    return { box, barText: bar ? bar.textContent : '' };
  });
  check('[1] 10秒後に赤帯「未送信 1件」', r1b.barText.indexOf('未送信 1件') >= 0, r1b.barText.slice(0, 80));
  check('[1] 箱に kind・id・rec・at が永続化される（visit の1件だけ。予約 patch は箱の対象外）',
    r1b.box.length === 1 && r1b.box[0].kind === 'visits' && r1b.box[0].id === r1a.visitId
    && r1b.box[0].del === false && r1b.box[0].rec && r1b.box[0].rec.id === r1a.visitId
    && r1b.box[0].rec.sfId === 'bk_ext1' && isFinite(Date.parse(r1b.box[0].at)),
    JSON.stringify(r1b.box).slice(0, 200));

  // ============ [2] リロード → 起動時の再送で箱が空になる ============
  await page.reload();
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_visits'), null, { timeout: 15000 });
  const r2a = await page.evaluate(() => {
    const bar = document.querySelector('#sfSyncBar.show');
    return { barText: bar ? bar.textContent : '',
             boxLen: JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length };
  });
  check('[2] リロード直後（同期前）から赤帯で箱の中身を知らせる', r2a.boxLen === 1 && r2a.barText.indexOf('未送信 1件') >= 0,
    JSON.stringify(r2a));
  await page.evaluate((o) => {
    window.__fs.writes.length = 0;
    window.__emit('sf_customers', [], false); window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false); window.__emit('sf_bookings', o.bookings, false);
  }, { bookings });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length === 0, null, { timeout: 10000 });
  const r2b = await page.evaluate((vid) => {
    const w = window.__fs.writes.filter(x => x.path === 'sf_visits/' + vid);
    return { n: w.length, op: w[0] && w[0].op, sfId: w[0] && w[0].data && w[0].data.sfId,
             name: w[0] && w[0].data && w[0].data.childName,
             bar: !!document.querySelector('#sfSyncBar.show') };
  }, r1a.visitId);
  check('[2] 起動時（初回同期後）に箱の控えが同じ id・同じ内容で再送される', r2b.n === 1 && r2b.op === 'set'
    && r2b.sfId === 'bk_ext1' && r2b.name === 'テスト タロウ', JSON.stringify(r2b));
  check('[2] 決着（ok）で箱が空になり赤帯が消える', r2b.bar === false, 'bar=' + r2b.bar);

  // --- [2] online 復帰と sfWakeSync 後の再送（箱へ手で控えを入れて確かめる） ---
  const r2c = await page.evaluate(async () => {
    window.__fs.writes.length = 0;
    sfUnsentAdd({ kind: 'visits', id: 'V_man1', rec: { id: 'V_man1', childName: 'テスト オンライン', updatedAt: new Date().toISOString() }, del: false, at: new Date().toISOString() });
    window.dispatchEvent(new Event('online'));
    await new Promise(r => setTimeout(r, 500));
    const afterOnline = window.__fs.writes.map(w => w.op + ':' + w.path);
    const boxAfterOnline = JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length;
    window.__fs.writes.length = 0;
    sfUnsentAdd({ kind: 'visits', id: 'V_man2', rec: { id: 'V_man2', childName: 'テスト ウェイク', updatedAt: new Date().toISOString() }, del: false, at: new Date().toISOString() });
    await window.sfWakeSync('test');
    await new Promise(r => setTimeout(r, 2000));   // wakesync 後の再送は 1.5 秒後
    const afterWake = window.__fs.writes.map(w => w.op + ':' + w.path);
    const boxAfterWake = JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length;
    return { afterOnline, boxAfterOnline, afterWake, boxAfterWake };
  });
  check('[2] online 復帰でも箱から再送される', r2c.afterOnline.indexOf('set:sf_visits/V_man1') >= 0 && r2c.boxAfterOnline === 0,
    JSON.stringify(r2c.afterOnline));
  check('[2] sfWakeSync 後にも箱から再送される', r2c.afterWake.indexOf('set:sf_visits/V_man2') >= 0 && r2c.boxAfterWake === 0,
    JSON.stringify(r2c.afterWake));

  // ============ [3] 陰性対照：snapshot 由来・成功した書き込みは箱に入らない ============
  // ============ [C] 90秒超未受信の書き込みで、送信前に接続を張り直す ============
  const r3a = await page.evaluate(async () => {
    // snapshot 由来のレコードを流し込む（他端末の書き込みが届いた状況）
    window.__emit('sf_visits', [{ id: 'V_snap1', childName: 'テスト スナップ', visitDate: '2026-10-14', usageType: 'temporary', paymentStatus: 'pending', updatedAt: new Date().toISOString() }], false);
    // 成功する書き込み（__fsHang は false）
    const enableBefore = window.__fs.calls.filter(c => c[0] === 'enableNetwork').length;
    window.__sfWakeLastSnap = Date.now() - 120000;   // 最終受信を 120 秒前に偽装（案C の発火条件）
    const v = { id: 'V_ok1', customerId: null, childName: 'テスト セイコウ', branch: DATA.settings.branch,
      createdAt: new Date().toISOString(), visitDate: '2026-10-14', visitStart: '10:00', visitEnd: '11:00',
      usageType: 'temporary', paymentStatus: 'pending', agreed: true, items: [] };
    DATA.visits.push(v);
    tlPut('visits', v);
    await new Promise(r => setTimeout(r, 300));   // enableNetwork は disableNetwork の resolve 後（非同期）
    const enableAfter = window.__fs.calls.filter(c => c[0] === 'enableNetwork').length;
    return { enableBefore, enableAfter };
  });
  await sleep(11500);   // 見届けの10秒を跨いで、箱に何も残らないことを見る
  const r3b = await page.evaluate(() => ({
    box: JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length,
    bar: !!document.querySelector('#sfSyncBar.show'),
    snapInData: (DATA.visits || []).some(x => x && x.id === 'V_snap1'),
  }));
  check('[3] snapshot 由来のレコード・成功した書き込みは10秒経っても箱に入らない（赤帯も出ない）',
    r3b.box === 0 && r3b.bar === false && r3b.snapInData === true, JSON.stringify(r3b));
  check('[C] 90秒超未受信の書き込みで disableNetwork→enableNetwork が走る（送信前の張り直し）',
    r3a.enableAfter === r3a.enableBefore + 1, JSON.stringify(r3a));
  check('pageerror なし（コンテキスト1）', errors.length === 0, errors.join(' | ').slice(0, 200));
  await ctx.close();

  // ============ [4] 7日より古い控えは知らせるだけで自動再送しない ============
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(String(e && e.message || e)));
  await installStubs(page2);
  const oldAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();   // 8日前
  await page2.addInitScript((o) => {
    localStorage.setItem('timely_school_data_v1', JSON.stringify(o.seed));
    localStorage.setItem(o.boxKey, JSON.stringify([{ kind: 'visits', id: 'V_old1',
      rec: { id: 'V_old1', childName: 'テスト フルイ', visitDate: '2026-10-06', usageType: 'morning', paymentStatus: 'pending', updatedAt: o.oldAt },
      del: false, at: o.oldAt }]));
  }, { seed: { customers: [], visits: [], students: [], reservations: [], settings: { branch: BRANCH, staff: ['テスト'] } }, boxKey: BOX_KEY, oldAt });
  await page2.goto(FILE);
  await page2.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_visits'), null, { timeout: 15000 });
  await page2.evaluate(() => {
    window.__fs.writes.length = 0;
    window.__emit('sf_customers', [], false); window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false); window.__emit('sf_bookings', [], false);
  });
  await sleep(3000);   // 起動時の再送（1.2秒後）を跨ぐ
  const r4a = await page2.evaluate(() => {
    const bar = document.querySelector('#sfSyncBar.show');
    const writes = window.__fs.writes.map(w => w.op + ':' + w.path);
    // 手動タップでも 7日超は送らない
    document.getElementById('sfSyncBar').click();
    return { barText: bar ? bar.textContent : '', writes,
             box: JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length };
  });
  await sleep(1000);
  const r4b = await page2.evaluate(() => ({
    writes: window.__fs.writes.map(w => w.op + ':' + w.path),
    box: JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length,
    barText: (document.querySelector('#sfSyncBar.show') || {}).textContent || '',
  }));
  check('[4] 7日より古い控えは赤帯で知らせる（件数＋古い旨の注記）',
    r4a.barText.indexOf('未送信 1件') >= 0 && r4a.barText.indexOf('7日より古い') >= 0, r4a.barText.slice(0, 120));
  check('[4] 起動時の自動再送では送らない・箱には残る', r4a.writes.indexOf('set:sf_visits/V_old1') < 0 && r4a.box === 1,
    JSON.stringify(r4a.writes));
  check('[4] 赤帯の手動タップでも送らない・箱と注記は残る',
    r4b.writes.indexOf('set:sf_visits/V_old1') < 0 && r4b.box === 1 && r4b.barText.indexOf('7日より古い') >= 0,
    JSON.stringify(r4b.writes) + ' box=' + r4b.box);
  check('pageerror なし（コンテキスト2）', errors2.length === 0, errors2.join(' | ').slice(0, 200));

  await browser.close();
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
