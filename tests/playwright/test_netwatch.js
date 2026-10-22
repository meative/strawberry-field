// SF-NETWATCH-20261022 : 接続の見張り番の検証。
//   (A) board.html で完全シナリオ：
//       fresh では何もしない → 2分無受信で 段階1(確認リスナーのみ) → 段階2(張り直し) →
//       2回連続失敗で大赤帯 → サーバー確認で自動クリア＋lastSeen ハートビート →
//       hidden では見張らない（force は例外）→ 赤帯タップで即再試行
//   (B) 残り11本：見張り番の存在と fresh 動作（マーカー・SF_NW・tick）
//   (C) apps/fleet.html（本部用端末一覧）：稼働中/進んでいません/オフ の振り分け・旧版の強調・
//       配信中の版の表示・読み取り専用（書き込みゼロ）
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const OTHERS = ['timely.html', 'board_sp_tsukisamu.html', 'board_sp_shiraishi.html', 'board_sp_factory.html',
  'board_sp_shiseikan.html', 'salon.html', 'salon_sp_shiraishi.html', 'salon_sp_tsukisamu.html', 'notify.html',
  'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html'];

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + String(extra).slice(0, 220) + ']' : ''));
  if (!ok) fails++;
}

async function boot(browser, file) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.clock.install({ time: new Date('2026-10-22T09:00:00+09:00') });
  await page.goto('file://' + path.join(APPS, file));
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
  await page.evaluate(() => window.__emit('sf_bookings', [], false));   // 初回受信＝刻印
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch();

  // ---------- (A) board.html 完全シナリオ ----------
  {
    const { ctx, page, errors } = await boot(browser, 'board.html');
    const api = await page.evaluate(() => ({
      nw: !!window.SF_NW, tick: typeof window.__sfNetWatchTick,
      stale: window.SF_NW.staleMs, fails: window.SF_NW.fails }));
    check('(A) board: SF_NW と __sfNetWatchTick が公開・staleMs=120s',
      api.nw && api.tick === 'function' && api.stale === 120000 && api.fails === 0, JSON.stringify(api));

    // fresh：受信直後の tick は何もしない
    let r = await page.evaluate(() => {
      window.SF_NW.beatMs = 0;   // ハートビートの間隔制限を外す（検証しやすく）
      window.__fs.writes.length = 0;
      const st = window.__sfNetWatchTick(true);
      return { st, beats: window.__fs.writes.filter(w => w.path.indexOf('sf_devices/') === 0).length,
               confirms: window.__fs.listeners.filter(l => l.active && l.opts && l.opts.includeMetadataChanges).length };
    });
    check('(A) fresh では probe しない・ハートビートだけ打つ', r.st === 'fresh' && r.beats === 1 && r.confirms === 0, JSON.stringify(r));

    // 段階1で生存確認できる場合：確認リスナーのみ（接続はいじらない）
    await page.clock.fastForward(125_000);   // 2分超の無受信（自動 tick は cooldown 管理下）
    r = await page.evaluate(async () => {
      window.SF_NW.lastAttempt = 0; window.SF_NW.probing = false;   // 自動 tick の cooldown をリセット
      const callsBefore = window.__fs.calls.length;
      const st = window.__sfNetWatchTick(true);
      await new Promise(res => setTimeout(res, 0));
      const conf = window.__fs.listeners.filter(l => l.active && l.opts && l.opts.includeMetadataChanges);
      const net = window.__fs.calls.slice(callsBefore).map(c => c[0]).filter(x => x === 'disableNetwork' || x === 'enableNetwork');
      // 段階1の待ち時間内にサーバー確定 snapshot が届く（＝静かなだけで生きている）
      conf[0].cb({ docs: [], size: 0, metadata: { fromCache: false } });
      return { st, confN: conf.length, net: net.join('>'),
               fails: window.SF_NW.fails, banner: !!document.getElementById('sfNetBanner') };
    });
    check('(A) 段階1：確認リスナーのみで生存確認（張り直し無し・fails 0・赤帯無し）',
      r.st === 'probe' && r.confN === 1 && r.net === '' && r.fails === 0 && !r.banner, JSON.stringify(r));

    // 死んでいる場合：段階1→段階2（張り直し）→失敗。2回で大赤帯
    for (let i = 1; i <= 2; i++) {
      await page.clock.fastForward(125_000);
      await page.evaluate(() => { window.SF_NW.lastAttempt = 0; window.SF_NW.probing = false; window.__fs.calls.length = 0; window.__sfNetWatchTick(true); });
      await page.clock.fastForward(16_000);   // 段階1の待ち（15s）→ 届かない → 段階2 sfWakeSync
      await page.clock.fastForward(16_000);   // 段階2の待ち（15s）→ 届かない → fails++
      r = await page.evaluate((want) => {
        const net = window.__fs.calls.map(c => c[0]).filter(x => x === 'disableNetwork' || x === 'enableNetwork');
        const b = document.getElementById('sfNetBanner');
        return { net: net.join('>'), fails: window.SF_NW.fails,
                 banner: !!(b && b.style.display !== 'none'), text: b ? b.textContent : '' };
      }, i);
      if (i === 1) check('(A) 失敗1回目：段階2で張り直しは実行・fails=1・赤帯はまだ出ない',
        r.net === 'disableNetwork>enableNetwork' && r.fails === 1 && !r.banner, JSON.stringify(r));
      else check('(A) 失敗2回目以降：大赤帯「通信が止まっています」を表示',
        /* 自動 tick（30秒間隔）も失敗を数えるため fails は 2 以上になる */
        r.fails >= 2 && r.banner && r.text.indexOf('通信が止まっています') >= 0 && r.text.indexOf('アプリを開き直してください') >= 0,
        JSON.stringify({ fails: r.fails, banner: r.banner }));
    }

    // 復活：サーバー確定 snapshot で赤帯が自動で消え、ハートビートが打たれる
    r = await page.evaluate(() => {
      window.__fs.writes.length = 0;
      window.__emit('sf_bookings', [], false);
      const b = document.getElementById('sfNetBanner');
      return { banner: b.style.display !== 'none', fails: window.SF_NW.fails,
               beat: window.__fs.writes.some(w => w.path.indexOf('sf_devices/') === 0) };
    });
    check('(A) サーバー確認が取れた瞬間に赤帯が消え fails=0・lastSeen ハートビート',
      !r.banner && r.fails === 0 && r.beat, JSON.stringify(r));

    // hidden では見張らない（force は例外）
    r = await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      const a = window.__sfNetWatchTick();
      const b = window.__sfNetWatchTick(true);
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      return { a, b };
    });
    check('(A) hidden では tick が何もしない（force は動く）', r.a === 'hidden' && r.b !== 'hidden', JSON.stringify(r));

    // 赤帯タップ＝即再試行（cooldown 無視で probe が走る）
    await page.clock.fastForward(125_000);
    r = await page.evaluate(async () => {
      window.SF_NW.probing = false; window.SF_NW.lastAttempt = Date.now();   // cooldown 中でも
      const b = document.getElementById('sfNetBanner');
      b.style.display = 'block';
      b.onclick();
      await new Promise(res => setTimeout(res, 0));
      return { probing: window.SF_NW.probing };
    });
    check('(A) 赤帯タップで cooldown を無視して即再試行', r.probing === true);

    const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
    check('(A) no page errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ---------- (B) 残り11本：存在と fresh 動作 ----------
  for (const file of OTHERS) {
    const { ctx, page, errors } = await boot(browser, file);
    const r = await page.evaluate(() => {
      window.SF_NW.beatMs = 0;
      window.__fs.writes.length = 0;
      const st = window.__sfNetWatchTick(true);
      return { nw: !!window.SF_NW, tick: typeof window.__sfNetWatchTick, st,
               beat: window.__fs.writes.some(w => w.path.indexOf('sf_devices/') === 0) };
    });
    const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
    check('(B) ' + file + ' : 見張り番あり・fresh tick・ハートビート・エラー無し',
      r.nw && r.tick === 'function' && r.st === 'fresh' && r.beat && relevant.length === 0,
      JSON.stringify(r) + (relevant.length ? ' | ' + relevant[0] : ''));
    await ctx.close();
  }

  // ---------- (C) fleet.html（本部用端末一覧） ----------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await installStubs(page);
    await page.clock.install({ time: new Date('2026-10-22T16:30:00+09:00') });
    await page.goto('file://' + path.join(APPS, 'fleet.html'));
    await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_devices'), null, { timeout: 15000 });
    const r = await page.evaluate(() => {
      const now = Date.now();
      const iso = (ms) => new Date(now - ms).toISOString();
      window.__emit('sf_config', [{ id: 'version', ver: 'e01d547', updatedAt: iso(0) }], false);
      window.__emit('sf_devices', [
        { id: 'Dfresh001', garden: 'tsukisamu', app: 'board', ver: 'e01d547', standalone: true, lastSeen: iso(60e3), tabsHint: 1, iosVersion: '26.6' },
        { id: 'Dwarn0001', garden: 'tsukisamu', app: 'board', ver: 'e01d547', standalone: true, lastSeen: iso(20 * 60e3), tabsHint: 1, iosVersion: '26.6' },
        { id: 'Dsleep001', garden: 'factory', app: 'timely', ver: 'e01d547', standalone: false, lastSeen: iso(2 * 3600e3), tabsHint: 2, iosVersion: '18.7' },
        { id: 'Doldver01', garden: 'shiraishi', app: 'salon', ver: 'd33704e', standalone: false, lastSeen: iso(30e3), tabsHint: 1, iosVersion: '16.6' },
      ], false);
      const html = document.getElementById('rows').innerHTML;
      const sum = document.getElementById('summary').textContent;
      const ver = document.getElementById('verLine').textContent;
      return {
        okBadge: (html.match(/稼働中/g) || []).length,
        warnBadge: (html.match(/進んでいません/g) || []).length,
        offBadge: (html.match(/>オフ</g) || []).length,
        oldver: html.indexOf('旧版') >= 0 && html.indexOf('d33704e') >= 0,
        pwa: (html.match(/アプリ版/g) || []).length,
        gardenLabel: html.indexOf('月寒園') >= 0 && html.indexOf('白石園') >= 0,
        sumWarn: sum.indexOf('進んでいない端末') >= 0,
        verLine: ver.indexOf('e01d547') >= 0,
        writes: window.__fs.writes.length,
      };
    });
    check('(C) fleet: 稼働中2・進んでいません1・オフ1 に振り分け',
      r.okBadge === 2 && r.warnBadge >= 1 && r.offBadge === 1, JSON.stringify(r));
    check('(C) fleet: 旧版の強調・アプリ版バッジ・園名ラベル・サマリー・配信中の版',
      r.oldver && r.pwa === 2 && r.gardenLabel && r.sumWarn && r.verLine, JSON.stringify(r));
    check('(C) fleet: 読み取り専用（書き込みゼロ）', r.writes === 0, 'writes=' + r.writes);
    const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
    check('(C) fleet: no page errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log(fails ? ('\nFAILED: ' + fails) : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
