// SF-WAKESYNC-20260930 : 12本すべてで、前面復帰 → disableNetwork→enableNetwork、
// 90秒以上未受信なら「同期待ち」バッジ、サーバー確定 snapshot で消える、を検証する。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILES = ['timely.html', 'board.html', 'board_sp_tsukisamu.html', 'board_sp_shiraishi.html', 'board_sp_factory.html',
  'board_sp_shiseikan.html', 'salon.html', 'salon_sp_shiraishi.html', 'salon_sp_tsukisamu.html', 'notify.html',
  'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html'];

let fails = 0;
function check(file, name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + file + ' : ' + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) fails++;
}

(async () => {
  const browser = await chromium.launch();
  for (const file of FILES) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await installStubs(page);
    await page.clock.install({ time: new Date('2026-09-30T09:00:00+09:00') });
    await page.goto('file://' + path.join(APPS, file));
    // wait for the module to subscribe (signInAnonymously resolved → onSnapshot registered)
    await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
    await page.evaluate(() => window.__emit('sf_bookings', [], false));   // 初回受信（空）

    const api = await page.evaluate(() => ({
      fn: typeof window.sfWakeSync, mark: typeof window.sfWakeMarkSnapshot,
      badge: !!document.getElementById('sfWakeBadge'),
      shown: !!(document.getElementById('sfWakeBadge') && document.getElementById('sfWakeBadge').classList.contains('show')),
      last: window.__sfWakeLastSnap
    }));
    check(file, 'sfWakeSync / sfWakeMarkSnapshot exposed, badge present and hidden',
      api.fn === 'function' && api.mark === 'function' && api.badge && !api.shown && api.last > 0);

    // (A) 前面復帰・未受信 10 秒 → 再接続は呼ばれるがバッジは出ない
    await page.clock.fastForward(10_000);
    let r = await page.evaluate(async () => {
      const before = window.__fs.calls.length;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(res => setTimeout(res, 0)); await new Promise(res => setTimeout(res, 0));
      const seq = window.__fs.calls.slice(before).map(c => c[0]);
      return { seq, shown: document.getElementById('sfWakeBadge').classList.contains('show'), count: window.__sfWakeCount, vis: document.visibilityState,
        confirm: window.__fs.listeners.filter(l => l.active && l.opts && l.opts.includeMetadataChanges).length };
    });
    check(file, '(A) visible after 10s: disableNetwork→enableNetwork called, no badge, no confirm listener',
      r.vis === 'visible' && r.seq.join('>') === 'disableNetwork>enableNetwork' && !r.shown && r.count === 1 && r.confirm === 0, r.seq.join('>'));

    // (B) 91 秒未受信 → 再接続 + バッジ表示 + 確認リスナー（同じ sf_bookings クエリ・metadata付き）
    await page.clock.fastForward(91_000);
    r = await page.evaluate(async () => {
      const before = window.__fs.calls.length;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(res => setTimeout(res, 0)); await new Promise(res => setTimeout(res, 0));
      const seq = window.__fs.calls.slice(before).map(c => c[0]);
      const conf = window.__fs.listeners.filter(l => l.active && l.opts && l.opts.includeMetadataChanges);
      const b = document.getElementById('sfWakeBadge');
      return { seq, shown: b.classList.contains('show'), display: getComputedStyle(b).display, text: b.textContent.trim(),
        confirm: conf.length, confirmName: conf.length ? conf[0].name : null,
        confirmWhere: conf.length && conf[0].ref.c && conf[0].ref.c[0] ? conf[0].ref.c[0].f + conf[0].ref.c[0].op : null };
    });
    check(file, '(B) visible after 91s: reconnect + badge shown + confirm listener on same query',
      r.seq.join('>') === 'disableNetwork>enableNetwork' && r.shown && r.display !== 'none' && r.text === '同期待ち'
      && r.confirm === 1 && r.confirmName === 'sf_bookings' && r.confirmWhere === 'date>=', JSON.stringify(r));

    // (B2) キャッシュ由来（fromCache=true）の snapshot ではまだ消えない
    r = await page.evaluate(() => {
      const conf = window.__fs.listeners.filter(l => l.active && l.opts && l.opts.includeMetadataChanges)[0];
      conf.cb({ docs: [], size: 0, metadata: { fromCache: true } });
      return { shown: document.getElementById('sfWakeBadge').classList.contains('show'), active: conf.active };
    });
    check(file, '(B2) fromCache=true snapshot keeps the badge', r.shown && r.active);

    // (B3) サーバー確定（fromCache=false）で消える・確認リスナーは解除される
    r = await page.evaluate(() => {
      const conf = window.__fs.listeners.filter(l => l.active && l.opts && l.opts.includeMetadataChanges)[0];
      conf.cb({ docs: [], size: 0, metadata: { fromCache: false } });
      return { shown: document.getElementById('sfWakeBadge').classList.contains('show'), active: conf.active, last: window.__sfWakeLastSnap };
    });
    check(file, '(B3) fromCache=false snapshot hides the badge and unsubscribes the confirm listener', !r.shown && !r.active);

    // (C) 通常の受信（購読中リスナーの snapshot）でも消える
    await page.clock.fastForward(91_000);
    r = await page.evaluate(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(res => setTimeout(res, 0)); await new Promise(res => setTimeout(res, 0));
      const shownBefore = document.getElementById('sfWakeBadge').classList.contains('show');
      window.__emit('sf_bookings', [], true);   // 通常の購読リスナー経由（fromCache に関係なく受信＝刻印）
      const conf = window.__fs.listeners.filter(l => l.active && l.opts && l.opts.includeMetadataChanges).length;
      return { shownBefore, shownAfter: document.getElementById('sfWakeBadge').classList.contains('show'), conf };
    });
    check(file, '(C) regular data snapshot clears the badge and drops the confirm listener', r.shownBefore && !r.shownAfter && r.conf === 0);

    // (D) 二重発火ガード：同期的に2回イベントが来ても再接続は1回
    r = await page.evaluate(async () => {
      const before = window.__fs.calls.length;
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(res => setTimeout(res, 0)); await new Promise(res => setTimeout(res, 0));
      return window.__fs.calls.slice(before).map(c => c[0]).join('>');
    });
    check(file, '(D) two synchronous visibilitychange events → one reconnect', r === 'disableNetwork>enableNetwork', r);

    // (E) bfcache 復帰（pageshow persisted）でも再接続。persisted=false は無視
    r = await page.evaluate(async () => {
      const before = window.__fs.calls.length;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
      await new Promise(res => setTimeout(res, 0));
      const a = window.__fs.calls.slice(before).map(c => c[0]).join('>');
      const b0 = window.__fs.calls.length;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await new Promise(res => setTimeout(res, 0)); await new Promise(res => setTimeout(res, 0));
      return { a, b: window.__fs.calls.slice(b0).map(c => c[0]).join('>') };
    });
    check(file, '(E) pageshow persisted=false ignored / persisted=true reconnects', r.a === '' && r.b === 'disableNetwork>enableNetwork', JSON.stringify(r));

    // (F) 隠れる方向（hidden）では何もしない
    r = await page.evaluate(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      const before = window.__fs.calls.length;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(res => setTimeout(res, 0));
      const seq = window.__fs.calls.slice(before).map(c => c[0]).join('>');
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      return seq;
    });
    check(file, '(F) visibilitychange to hidden does nothing', r === '');

    // ページエラーが無いこと（スタブ環境で起きる想定外の例外を拾う）
    const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
    check(file, 'no page errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));

    await ctx.close();
  }
  await browser.close();
  console.log(fails ? ('\nFAILED: ' + fails) : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
