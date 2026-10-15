// SF-WRITESTAMP-20261015 / SF-DEVICES-20261015 : 12本すべてで
//  - 起動時に sf_devices/{dev} へ台帳 1件（garden/app/ver/ua/iosVersion/lastSeen/tabsHint＋_w）
//  - 起動時に sf_config/version を getDoc（版確認）
//  - すべての書き込み口のペイロードに _w:{dev, ver, at} が付き、既存フィールドは不変
//  - sfChangedOnly は _w だけの違いを「変わっていない」と判定（全件書き直しの防止）
//  - 前面復帰（visibilitychange）で台帳が更新される
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILES = [
  ['timely.html', 'timely'],
  ['board.html', 'board'], ['board_sp_factory.html', 'board'], ['board_sp_shiraishi.html', 'board'],
  ['board_sp_shiseikan.html', 'board'], ['board_sp_tsukisamu.html', 'board'],
  ['salon.html', 'salon'], ['salon_sp_shiraishi.html', 'salon'], ['salon_sp_tsukisamu.html', 'salon'],
  ['notify.html', 'notify'], ['notify_sp_shiraishi.html', 'notify'], ['notify_sp_tsukisamu.html', 'notify'],
];

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  [' + (extra || '') + ']'));
  if (!ok) fails++;
}

(async () => {
  const browser = await chromium.launch();
  for (const [file, app] of FILES) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await installStubs(page);
    await page.goto('file://' + path.join(APPS, file));
    await page.waitForFunction(() => typeof window.fbReconcile === 'function' && window.__fs, null, { timeout: 15000 });
    await page.waitForFunction(() => window.__fs.writes.some(w => w.path.indexOf('sf_devices/') === 0), null, { timeout: 10000 });
    const r = await page.evaluate(async (app0) => {
      const dev = localStorage.getItem('sf_device_id_v1');
      const beat = window.__fs.writes.find(w => w.path === 'sf_devices/' + dev);
      const verGet = window.__fs.calls.some(c => c[0] === 'getDoc' && c[1] === 'sf_config/version');
      // 書き込み口：sf_bookings の reconcile
      window.__fs.writes.length = 0;
      await window.fbReconcile([{ id: 'b_ws1', date: '2026-10-15', gardenId: 'tsukisamu', name: 'テスト' }], []);
      const bw = window.__fs.writes.find(w => w.path === 'sf_bookings/b_ws1');
      // 家族ごとの追加の書き込み口
      let extra = {};
      if (app0 === 'board') {
        window.__fs.writes.length = 0;
        await window.kinderSave('tsukisamu', 'am', 'テスト', true);
        extra.kinder = window.__fs.writes.find(w => w.path.indexOf('sf_kinder_attendance/') === 0);
        window.__fs.writes.length = 0;
        await window.fbCapSet('base', { ages: { a0: 1 } });
        extra.cap = window.__fs.writes.find(w => w.path === 'sf_capacity/base');
      }
      if (app0 === 'notify') {
        window.__fs.writes.length = 0;
        await window.nfWrite([{ id: 'nf_ws1', msg: 'x' }], []);
        extra.nf = window.__fs.writes.find(w => w.path === 'sf_notify/nf_ws1');
      }
      if (app0 === 'timely') {
        window.__fs.writes.length = 0;
        await window.fbPutTl('visits', { id: 'V_ws1', childName: 'テスト' });
        extra.tl = window.__fs.writes.find(w => w.path === 'sf_visits/V_ws1');
        window.__fs.writes.length = 0;
        await window.fbPatchBooking('b_ws1', { tlDone: true });
        extra.patch = window.__fs.writes.find(w => w.path === 'sf_bookings/b_ws1');
      }
      // 差分判定：_w だけの違いは「変わっていない」
      const diffSame = sfChangedOnly([{ id: 1, a: 1, _w: { at: 'x' } }], [{ id: 1, a: 1, _w: { at: 'y' } }]).length;
      const diffReal = sfChangedOnly([{ id: 1, a: 2, _w: { at: 'x' } }], [{ id: 1, a: 1, _w: { at: 'x' } }]).length;
      // 前面復帰で台帳更新
      window.__fs.writes.length = 0;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r2 => setTimeout(r2, 300));
      const beat2 = window.__fs.writes.some(w => w.path === 'sf_devices/' + dev);
      return { dev, ver: window.SF_APP_VER, beat: beat ? beat.data : null, verGet, bw: bw ? bw.data : null, extra, diffSame, diffReal, beat2 };
    }, app);
    const okW = (d) => !!(d && d._w && d._w.dev === r.dev && d._w.ver === r.ver && isFinite(Date.parse(d._w.at)));
    const b = r.beat || {};
    check(file + ' : 起動時に sf_devices へ台帳1件（全フィールド＋_w）＋版の getDoc',
      okW(b) && b.app === app && b.ver === r.ver && typeof b.garden === 'string' && typeof b.ua === 'string'
      && typeof b.iosVersion === 'string' && isFinite(Date.parse(b.lastSeen)) && b.tabsHint >= 1 && r.verGet,
      JSON.stringify(b).slice(0, 160) + ' verGet=' + r.verGet);
    let extraOk = okW(r.bw) && r.bw.date === '2026-10-15' && r.bw.name === 'テスト';
    let extraWhat = 'reconcile';
    if (app === 'board') { extraOk = extraOk && okW(r.extra.kinder && r.extra.kinder.data) && okW(r.extra.cap && r.extra.cap.data); extraWhat += '+kinder+cap'; }
    if (app === 'notify') { extraOk = extraOk && okW(r.extra.nf && r.extra.nf.data) && r.extra.nf.data.msg === 'x'; extraWhat += '+nfWrite'; }
    if (app === 'timely') { extraOk = extraOk && okW(r.extra.tl && r.extra.tl.data) && okW(r.extra.patch && r.extra.patch.data) && r.extra.patch.data.tlDone === true; extraWhat += '+fbPutTl+patch'; }
    check(file + ' : 書き込み口（' + extraWhat + '）すべてに _w・既存フィールド不変', extraOk, JSON.stringify(r.extra).slice(0, 160));
    check(file + ' : 差分判定は _w を無視（同内容=0件・実変更=1件）・前面復帰で台帳更新',
      r.diffSame === 0 && r.diffReal === 1 && r.beat2 === true,
      JSON.stringify({ s: r.diffSame, r: r.diffReal, b2: r.beat2 }));
    check(file + ' : pageerror なし', errors.length === 0, errors.join(' | ').slice(0, 160));
    await ctx.close();
  }
  await browser.close();
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
