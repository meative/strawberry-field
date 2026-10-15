// SF-TOMBSTONE-20261015 : 削除の墓石の検証（timely）。
// [1] tlDel で deleteDoc 1件＋sf_tombstones/{id} に {kind, deletedAt, by}（＋_w 刻印）
// [2] 墓石付き id が visits の snapshot に現れたら自動で deleteDoc し直し・表示からも除く・ログ [SF-TOMBSTONE] revived=
// [3] 到着順が逆（visits が先・墓石が後）でも同じ結果
// [4] 90日より古い墓石は効かせない（復活を消さない）・期限切れ墓石は掃除される
// [5] 陰性対照：墓石の無いレコードは消えない
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILE = 'file://' + path.join(APPS, 'timely.html');

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  [' + (extra || '') + ']'));
  if (!ok) fails++;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => logs.push(m.text()));
  await installStubs(page);
  await page.addInitScript((seed) => {
    localStorage.setItem('timely_school_data_v1', JSON.stringify(seed));
  }, { customers: [], visits: [], students: [], reservations: [], settings: { branch: '月寒園', staff: ['テスト'] } });
  await page.goto(FILE);
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_tombstones'), null, { timeout: 15000 });
  const mkV = (id) => ({ id, customerId: null, childName: 'テスト ' + id, branch: '月寒園', createdAt: '2026-10-10T00:00:00.000Z',
    visitDate: '2026-10-10', visitStart: '10:00', visitEnd: '11:00', usageType: 'temporary', paymentStatus: 'pending', agreed: true, items: [] });
  await page.evaluate((v) => {
    window.__emit('sf_customers', [], false); window.__emit('sf_students', [], false);
    window.__emit('sf_visits', [v], false); window.__emit('sf_bookings', [], false);
    window.__emit('sf_tombstones', [], false);
  }, mkV('V_del1'));
  await page.waitForFunction(() => typeof tlReadyAll === 'function' && tlReadyAll(), null, { timeout: 5000 });

  // [1] tlDel → delete 1件＋墓石 set 1件
  const r1 = await page.evaluate(() => {
    window.__fs.writes.length = 0;
    tlDel('visits', 'V_del1');
    const w = window.__fs.writes.map(x => x.op + ':' + x.path);
    const tomb = window.__fs.writes.find(x => x.path === 'sf_tombstones/V_del1');
    return { w, tomb: tomb ? tomb.data : null, dev: localStorage.getItem('sf_device_id_v1') };
  });
  check('[1] tlDel で deleteDoc 1件＋sf_tombstones への set 1件',
    r1.w.length === 2 && r1.w.includes('delete:sf_visits/V_del1') && r1.w.includes('set:sf_tombstones/V_del1'), JSON.stringify(r1.w));
  check('[1] 墓石の中身は {kind, deletedAt, by}＋_w 刻印（by=端末ID）',
    !!r1.tomb && r1.tomb.kind === 'visits' && isFinite(Date.parse(r1.tomb.deletedAt)) && r1.tomb.by === r1.dev
    && r1.tomb._w && r1.tomb._w.dev === r1.dev && typeof r1.tomb._w.ver === 'string', JSON.stringify(r1.tomb));

  // [2] 墓石→復活 snapshot：自動で deleteDoc し直し・表示からも除く
  const r2 = await page.evaluate((v) => {
    window.__emit('sf_tombstones', [{ id: 'V_z1', kind: 'visits', deletedAt: new Date().toISOString(), by: 'Dxx' }], false);
    window.__fs.writes.length = 0;
    window.__emit('sf_visits', [v, Object.assign({}, v, { id: 'V_ok1', childName: 'テスト 生存' })], false);
    return { w: window.__fs.writes.map(x => x.op + ':' + x.path),
             inData: (DATA.visits || []).map(x => x.id).sort() };
  }, mkV('V_z1'));
  check('[2] 復活した墓石付き id を自動で deleteDoc し直す', r2.w.length === 1 && r2.w[0] === 'delete:sf_visits/V_z1', JSON.stringify(r2.w));
  check('[2] 表示（DATA）からも除かれ、墓石の無いレコードは残る', JSON.stringify(r2.inData) === JSON.stringify(['V_ok1']), JSON.stringify(r2.inData));
  check('[2] ログ [SF-TOMBSTONE] revived= が残る', logs.some(t => t.indexOf('[SF-TOMBSTONE] revived=visits/V_z1') >= 0), logs.filter(t => t.indexOf('TOMBSTONE') >= 0).join(' | ').slice(0, 160));

  // [3] 到着順が逆：visits が先に復活分を運び、墓石が後から届く
  const r3 = await page.evaluate((v) => {
    window.__emit('sf_visits', [Object.assign({}, v), { id: 'V_ok1', childName: 'テスト 生存', visitDate: '2026-10-10', usageType: 'temporary', paymentStatus: 'pending', branch: '月寒園' }], false);
    const before = (DATA.visits || []).some(x => x.id === 'V_z2');
    window.__fs.writes.length = 0;
    window.__emit('sf_tombstones', [{ id: 'V_z2', kind: 'visits', deletedAt: new Date().toISOString(), by: 'Dxx' }], false);
    return { before, w: window.__fs.writes.map(x => x.op + ':' + x.path), after: (DATA.visits || []).some(x => x.id === 'V_z2') };
  }, mkV('V_z2'));
  check('[3] 逆順（visits→墓石）でも自動削除と表示除去が効く',
    r3.before === true && r3.w.includes('delete:sf_visits/V_z2') && r3.after === false, JSON.stringify(r3));

  // [4] 90日超の墓石は効かせない＋期限切れ墓石は掃除される
  const r4 = await page.evaluate((v) => {
    const old = new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString();
    window.__fs.writes.length = 0;
    window.__emit('sf_tombstones', [{ id: 'V_oldtomb', kind: 'visits', deletedAt: old, by: 'Dxx' }], false);
    const purge = window.__fs.writes.map(x => x.op + ':' + x.path);
    window.__fs.writes.length = 0;
    window.__emit('sf_visits', [Object.assign({}, v), { id: 'V_ok1', childName: 'テスト 生存', visitDate: '2026-10-10', usageType: 'temporary', paymentStatus: 'pending', branch: '月寒園' }], false);
    return { purge, w: window.__fs.writes.map(x => x.op + ':' + x.path), stays: (DATA.visits || []).some(x => x.id === 'V_oldtomb') };
  }, mkV('V_oldtomb'));
  check('[4] 期限切れ墓石は掃除される（delete:sf_tombstones）', r4.purge.includes('delete:sf_tombstones/V_oldtomb'), JSON.stringify(r4.purge));
  check('[4] 90日超の墓石ではレコードを消さない', r4.w.length === 0 && r4.stays === true, JSON.stringify(r4));

  // [5] 陰性対照は [2][4] の V_ok1 / V_oldtomb 残存で担保。最後に pageerror を確認
  check('pageerror なし', errors.length === 0, errors.join(' | ').slice(0, 200));

  await browser.close();
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
