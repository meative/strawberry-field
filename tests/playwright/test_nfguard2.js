// SF-NFGUARD2-20261027 : notify 3本。復帰直後・起動直後の「古いデータに基づく未到着判定」を止め、
// 来園後の状態（late-hold / waiting / picking / done）が届いた reserved / no-show で戻らないことを検証する。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILES = ['notify.html', 'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html'];
const T0 = '2026-10-27T12:00:00+09:00';

let fails = 0;
function check(file, name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + file + ' : ' + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) fails++;
}

async function boot(browser, file) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.clock.install({ time: new Date(T0) });
  await page.goto('file://' + path.join(APPS, file));
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings')
    && window.__fs.listeners.some(l => l.name === 'sf_notify'), null, { timeout: 15000 });
  // ページ内ヘルパー
  await page.evaluate(() => {
    window.__t = {
      bk: (id, start, end) => ({ id, salon: 'woodstock', gardenId: CURRENT_GARDEN, date: todayStr(), start, end, name: 'テスト タロウ', age: '1歳', months: 18 }),
      cdoc: (sfId, status, stTs) => ({ id: nfDocId('c', sfId), g: CURRENT_GARDEN, k: 'c', key: sfId, ts: stTs, data: { salonKey: 'woodstock', sfId, status, stTs } }),
      child: (id) => (children.woodstock || []).find(c => c.sfId === id) || null,
      nfWrites: () => window.__fs.writes.filter(w => w.path.indexOf('sf_notify/') === 0),
      cWrites: (sfId) => window.__fs.writes.filter(w => w.path.indexOf('sf_notify/') === 0 && w.data && w.data.k === 'c' && (!sfId || w.data.data.sfId === sfId)).map(w => w.data.data.status),
      alerts: () => (statusLogs.woodstock || []).filter(e => e && e.kind === 'alert').length,
      reset: () => { window.__fs.writes.length = 0; },
    };
  });
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch();
  for (const file of FILES) {
    // 配線：sf_notify の購読が metadata 付き
    {
      const { ctx, page, errors } = await boot(browser, file);
      const r = await page.evaluate(() => {
        const l = window.__fs.listeners.filter(x => x.active && x.name === 'sf_notify');
        return { n: l.length, meta: l.every(x => x.opts && x.opts.includeMetadataChanges), judge: typeof nfCanAutoJudge, srvAt: window.__nfSrvAt };
      });
      check(file, '(0) sf_notify listener has includeMetadataChanges / nfCanAutoJudge exists / __nfSrvAt unset at boot',
        r.n === 1 && r.meta && r.judge === 'function' && !r.srvAt, JSON.stringify(r));
      check(file, '(0) no page errors', errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // (1) 起動時：キャッシュ由来（fromCache=true）だけでは判定しない → サーバー確定後に判定する
    {
      const { ctx, page, errors } = await boot(browser, file);
      let r = await page.evaluate(() => {
        window.__emit('sf_bookings', [window.__t.bk('bk_t1', '11:30', '13:00')], true);
        window.__emit('sf_notify', [], true);
        const c = window.__t.child('bk_t1');
        return { st: c && c.status, can: nfCanAutoJudge(), srvAt: window.__nfSrvAt || 0 };
      });
      check(file, '(1a) cache-only boot: child reserved, cannot auto-judge, __nfSrvAt unset', r.st === 'reserved' && !r.can && !r.srvAt, JSON.stringify(r));
      r = await page.evaluate(() => {
        window.__t.reset();
        checkArrivals();
        const c = window.__t.child('bk_t1');
        return { st: c.status, alerts: window.__t.alerts(), cw: window.__t.cWrites() };
      });
      check(file, '(1b) checkArrivals on cache-only data: still reserved, no alert, no no-show write',
        r.st === 'reserved' && r.alerts === 0 && !r.cw.includes('no-show'), JSON.stringify(r));
      r = await page.evaluate(() => {
        window.__emit('sf_notify', [], false);   // サーバー確定（c ドキュメント無し＝本当に予約済みのまま）
        const can = nfCanAutoJudge();
        window.__t.reset();
        checkArrivals();
        const c = window.__t.child('bk_t1');
        return { can, srvAt: window.__nfSrvAt > 0, st: c.status, alerts: window.__t.alerts(), cw: window.__t.cWrites() };
      });
      check(file, '(1c) after fromCache=false: can judge → no-show + alert + c write (legit path kept)',
        r.can && r.srvAt && r.st === 'no-show' && r.alerts === 1 && r.cw.includes('no-show'), JSON.stringify(r));
      check(file, '(1) no page errors', errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // (2) 復帰模擬：最終受信が数時間前のまま checkArrivals が走っても書き込みゼロ。サーバー snapshot で waiting が入り、そのまま
    {
      const { ctx, page, errors } = await boot(browser, file);
      let r = await page.evaluate(() => {
        window.__emit('sf_bookings', [window.__t.bk('bk_t1', '12:30', '15:00')], false);
        window.__emit('sf_notify', [], false);
        const c = window.__t.child('bk_t1');
        return { st: c && c.status, can: nfCanAutoJudge(), last: window.__sfWakeLastSnap };
      });
      check(file, '(2a) live boot at 12:00: child reserved, can judge (fresh)', r.st === 'reserved' && r.can && r.last > 0, JSON.stringify(r));
      // 停止 → 14:25 に復帰（タイマーは進めず時刻だけ進める＝snapshot は届いていない）
      await page.clock.setSystemTime(new Date('2026-10-27T14:25:00+09:00'));
      r = await page.evaluate(async () => {
        window.__t.reset();
        checkArrivals();                                     // 期限切れタイマー相当
        document.dispatchEvent(new Event('visibilitychange'));   // 前面復帰（sfWakeSync・台帳更新）
        await new Promise(res => setTimeout(res, 0)); await new Promise(res => setTimeout(res, 0));
        checkArrivals();
        const c = window.__t.child('bk_t1');
        return { can: nfCanAutoJudge(), st: c.status, alerts: window.__t.alerts(), nw: window.__t.nfWrites().length,
                 age: Date.now() - window.__sfWakeLastSnap };
      });
      check(file, '(2b) resume at 14:25 before server snapshot: no judgment, no alert, zero sf_notify writes',
        !r.can && r.st === 'reserved' && r.alerts === 0 && r.nw === 0 && r.age > 5 * 60 * 1000, JSON.stringify(r));
      r = await page.evaluate(() => {
        const ts = new Date('2026-10-27T12:29:00+09:00').getTime();
        window.__t.reset();
        window.__emit('sf_notify', [window.__t.cdoc('bk_t1', 'waiting', ts)], false);   // 他端末が 12:29 に書いた waiting が届く
        checkArrivals();
        const c = window.__t.child('bk_t1');
        return { can: nfCanAutoJudge(), st: c.status, stTs: c.stTs === ts, alerts: window.__t.alerts(), nw: window.__t.nfWrites().length };
      });
      check(file, '(2c) server snapshot brings waiting: applied, can judge again, no alert, zero writes',
        r.can && r.st === 'waiting' && r.stTs && r.alerts === 0 && r.nw === 0, JSON.stringify(r));
      check(file, '(2) no page errors', errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // (2') 復帰模擬の対照：サーバー snapshot が「c 無し＝本当に未到着」なら復帰後に判定する
    {
      const { ctx, page } = await boot(browser, file);
      const r = await page.evaluate(async () => {
        window.__emit('sf_bookings', [window.__t.bk('bk_t1', '12:30', '15:00')], false);
        window.__emit('sf_notify', [], false);
        return true;
      });
      await page.clock.setSystemTime(new Date('2026-10-27T14:25:00+09:00'));
      const r2 = await page.evaluate(() => {
        window.__t.reset();
        checkArrivals();
        const before = { st: window.__t.child('bk_t1').status, nw: window.__t.nfWrites().length };
        window.__emit('sf_notify', [], false);
        checkArrivals();
        const c = window.__t.child('bk_t1');
        return { before, st: c.status, alerts: window.__t.alerts(), cw: window.__t.cWrites() };
      });
      check(file, "(2d) control: still reserved on server → judged after confirmation (no-show + alert + write)",
        r && r2.before.st === 'reserved' && r2.before.nw === 0 && r2.st === 'no-show' && r2.alerts === 1 && r2.cw.includes('no-show'), JSON.stringify(r2));
      await ctx.close();
    }

    // (3) 受信側の後退拒否：waiting / done / late-hold に対する reserved / no-show は stTs が新しくても適用しない
    {
      const { ctx, page, errors } = await boot(browser, file);
      let r = await page.evaluate(() => {
        window.__emit('sf_bookings', [window.__t.bk('bk_t1', '12:30', '15:00'), window.__t.bk('bk_t2', '12:30', '15:00')], false);
        window.__emit('sf_notify', [], false);
        markArrived('woodstock', 0, 'bk_t1');
        const c = window.__t.child('bk_t1');
        return { st: c.status, stTs: c.stTs };
      });
      check(file, '(3a) markArrived → waiting with stTs', r.st === 'waiting' && r.stTs > 0, JSON.stringify(r));
      r = await page.evaluate(() => {
        const now = Date.now();
        window.__t.reset();
        window.__emit('sf_notify', [window.__t.cdoc('bk_t1', 'reserved', now + 60000)], false);
        const a = window.__t.child('bk_t1').status;
        const w1 = window.__t.cWrites('bk_t1');   // bk_t2（未到着のまま）の初回アップロードは対象外
        window.__t.reset();
        window.__emit('sf_notify', [window.__t.cdoc('bk_t1', 'no-show', now + 120000)], false);
        const b = window.__t.child('bk_t1').status;
        const w2 = window.__t.cWrites('bk_t1');
        return { a, b, w1, w2 };
      });
      check(file, '(3b) newer reserved / no-show over waiting: ignored, and own waiting is written back at once',
        r.a === 'waiting' && r.b === 'waiting' && r.w1.join() === 'waiting' && r.w2.join() === 'waiting', JSON.stringify(r));
      r = await page.evaluate(() => {
        const now = Date.now();
        window.__emit('sf_notify', [window.__t.cdoc('bk_t1', 'done', now + 180000)], false);   // 前進は受け入れる
        const a = window.__t.child('bk_t1').status;
        window.__emit('sf_notify', [window.__t.cdoc('bk_t1', 'reserved', now + 240000)], false);
        const b = window.__t.child('bk_t1').status;
        const c = window.__t.child('bk_t1'); c.status = 'late-hold'; c.stTs = now + 300000;
        window.__emit('sf_notify', [window.__t.cdoc('bk_t1', 'no-show', now + 360000)], false);
        const d = window.__t.child('bk_t1').status;
        return { a, b, d };
      });
      check(file, '(3c) forward done accepted / reserved over done ignored / no-show over late-hold ignored',
        r.a === 'done' && r.b === 'done' && r.d === 'late-hold', JSON.stringify(r));
      r = await page.evaluate(() => {
        const now = Date.now();
        window.__emit('sf_notify', [window.__t.cdoc('bk_t2', 'waiting', now)], false);   // 予約済み → 来園は従来どおり適用
        const a = window.__t.child('bk_t2').status;
        const c = window.__t.child('bk_t2'); c.stTs = now + 999999;                     // 既存 NFGUARD：自分の方が新しければ古い doc は無視
        window.__emit('sf_notify', [window.__t.cdoc('bk_t2', 'done', now - 1000)], false);
        const b = window.__t.child('bk_t2').status;
        return { a, b };
      });
      check(file, '(3d) reserved→waiting from cloud applied / older doc still rejected by stTs guard (NFGUARD regression)',
        r.a === 'waiting' && r.b === 'waiting', JSON.stringify(r));
      check(file, '(3) no page errors', errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e)).length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }

    // (4) 画面が隠れている間は判定しない
    {
      const { ctx, page } = await boot(browser, file);
      const r = await page.evaluate(() => {
        window.__emit('sf_bookings', [window.__t.bk('bk_t1', '11:30', '13:00')], false);
        window.__emit('sf_notify', [], false);
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        const can = nfCanAutoJudge();
        checkArrivals();
        const a = window.__t.child('bk_t1').status;
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        checkArrivals();
        const b = window.__t.child('bk_t1').status;
        return { can, a, b };
      });
      check(file, '(4) hidden: no judgment / visible again: judged', !r.can && r.a === 'reserved' && r.b === 'no-show', JSON.stringify(r));
      await ctx.close();
    }
  }
  await browser.close();
  console.log(fails ? ('\n' + fails + ' FAIL') : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
