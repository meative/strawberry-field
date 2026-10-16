// SF-SINGLETAB-20261016 : persistentSingleTabManager への切替の検証（12本）。
// [1] 起動で initializeFirestore が persistentLocalCache + persistentSingleTabManager で呼ばれる
// [2] failed-precondition（2つ目のタブ）を __sfPersistUnavailable で模擬 → memoryLocalCache に
//     フォールバックし、console.warn と小バッジ「このタブはオフライン保存なし」。業務は継続
//     （購読が始まり書き込み口も生きている）
// [3] timely の未送信箱（SF-UNSENTBOX-20261014）が memory モードでも動く（見届け→箱→再送）
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILES = ['timely.html',
  'board.html', 'board_sp_factory.html', 'board_sp_shiraishi.html', 'board_sp_shiseikan.html', 'board_sp_tsukisamu.html',
  'salon.html', 'salon_sp_shiraishi.html', 'salon_sp_tsukisamu.html',
  'notify.html', 'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html'];

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  [' + (extra || '') + ']'));
  if (!ok) fails++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();

  // [1] 12本すべて：single で初期化・バッジなし
  for (const f of FILES) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await installStubs(page);
    await page.goto('file://' + path.join(APPS, f));
    await page.waitForFunction(() => window.__fs && window.__fs.calls.some(c => c[0] === 'initializeFirestore'), null, { timeout: 15000 });
    const r = await page.evaluate(() => ({
      init: window.__fs.calls.filter(c => c[0] === 'initializeFirestore').map(c => c.slice(1)),
      mode: window.__sfCacheMode,
      badge: !!document.getElementById('sfMemBadge'),
    }));
    check(f + ' : persistent + singleTabManager で初期化・memory バッジなし',
      r.init.length === 1 && r.init[0][0] === 'persistent' && r.init[0][1] === 'single'
      && r.mode === 'persistent' && r.badge === false && errors.length === 0,
      JSON.stringify(r) + ' err=' + errors.join('|').slice(0, 80));
    await ctx.close();
  }

  // [2] failed-precondition の模擬（timely と board.html で代表）：memory フォールバック＋警告＋バッジ＋業務継続
  for (const f of ['timely.html', 'board.html']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [], warns = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'warn') warns.push(m.text()); });
    await installStubs(page);
    await page.addInitScript(() => { window.__sfPersistUnavailable = true; });
    await page.goto('file://' + path.join(APPS, f));
    await page.waitForFunction(() => window.__fs && window.__fs.calls.some(c => c[0] === 'initializeFirestore'), null, { timeout: 15000 });
    await page.waitForFunction(() => !!document.getElementById('sfMemBadge'), null, { timeout: 5000 });
    const r = await page.evaluate(async () => {
      const b = document.getElementById('sfMemBadge');
      // 業務継続：書き込み口が生きている（fbReconcile で1件）
      window.__fs.writes.length = 0;
      await window.fbReconcile([{ id: 'b_mem1', date: '2026-10-16', gardenId: 'tsukisamu', name: 'テスト' }], []);
      return {
        init: window.__fs.calls.filter(c => c[0] === 'initializeFirestore').map(c => c.slice(1)),
        mode: window.__sfCacheMode,
        badgeText: b ? b.textContent : '',
        wrote: window.__fs.writes.some(w => w.path === 'sf_bookings/b_mem1'),
        subs: window.__fs.listeners.length > 0,
      };
    });
    check(f + ' : failed-precondition 模擬で memoryLocalCache にフォールバック',
      r.init.length === 1 && r.init[0][0] === 'memory' && r.mode === 'memory', JSON.stringify(r.init));
    check(f + ' : console.warn とバッジ「このタブはオフライン保存なし」・購読/書き込みは継続',
      warns.some(t => t.indexOf('[SF-SINGLETAB-20261016]') >= 0) && r.badgeText === 'このタブはオフライン保存なし'
      && r.wrote === true && r.subs === true && errors.length === 0,
      JSON.stringify({ w: warns.slice(0, 1), b: r.badgeText, wrote: r.wrote, subs: r.subs, e: errors.slice(0, 1) }));
    await ctx.close();
  }

  // [3] memory モードでも未送信箱が動く（timely）：hang → 10秒で箱 → リロード後に再送で空
  const ctx3 = await browser.newContext();
  const page3 = await ctx3.newPage();
  const errors3 = [];
  page3.on('pageerror', (e) => errors3.push(String(e && e.message || e)));
  await installStubs(page3);
  await page3.addInitScript(() => { window.__sfPersistUnavailable = true; });
  await page3.goto('file://' + path.join(APPS, 'timely.html'));
  await page3.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_visits'), null, { timeout: 15000 });
  await page3.evaluate(() => {
    window.__emit('sf_customers', [], false); window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false); window.__emit('sf_bookings', [], false);
    window.__emit('sf_tombstones', [], false);
  });
  await page3.waitForFunction(() => typeof tlReadyAll === 'function' && tlReadyAll(), null, { timeout: 5000 });
  const vid = await page3.evaluate(() => {
    window.__fsHang = true;
    const v = { id: 'V_mem1', childName: 'テスト メモリ', branch: DATA.settings.branch, visitDate: '2026-10-16',
      usageType: 'temporary', paymentStatus: 'pending', agreed: true, items: [], createdAt: new Date().toISOString() };
    DATA.visits.push(v); tlPut('visits', v); return v.id;
  });
  await sleep(11000);
  const r3a = await page3.evaluate(() => ({
    box: JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]'),
    bar: (document.querySelector('#sfSyncBar.show') || {}).textContent || '',
  }));
  check('[3] memory モードでも 10秒見届け→未送信箱＋赤帯が動く',
    r3a.box.length === 1 && r3a.box[0].id === vid && r3a.bar.indexOf('未送信 1件') >= 0, JSON.stringify(r3a).slice(0, 160));
  await page3.reload();
  await page3.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_visits'), null, { timeout: 15000 });
  await page3.evaluate(() => {
    window.__emit('sf_customers', [], false); window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false); window.__emit('sf_bookings', [], false);
    window.__emit('sf_tombstones', [], false);
  });
  await page3.waitForFunction(() => JSON.parse(localStorage.getItem('timely_unsent_box_v1') || '[]').length === 0, null, { timeout: 10000 });
  const r3b = await page3.evaluate((id) => ({
    resent: window.__fs.writes.some(w => w.op === 'set' && w.path === 'sf_visits/' + id),
    mode: window.__sfCacheMode,
  }), vid);
  check('[3] リロード（memory モードのまま）後に箱から再送され空になる', r3b.resent === true && r3b.mode === 'memory', JSON.stringify(r3b));
  check('[3] pageerror なし', errors3.length === 0, errors3.join(' | ').slice(0, 160));
  await ctx3.close();

  await browser.close();
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
