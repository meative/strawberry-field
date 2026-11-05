// SF-DATECONFIRM-20261105 : サロンの予約日ズレと制限日の停止（salon 3本）。
// 2026-11-05 月寒の再現が出発点：11/4 に開いたままの画面で 11/16 を選ぶと、制限をすり抜けて 11/17 に入った。
// 時計は page.clock で動かす。Firebase は stubs.js の偽物なので本番には触れない。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const TARGETS = [
  { file: 'salon.html?garden=tsukisamu', garden: 'tsukisamu' },
  { file: 'salon_sp_tsukisamu.html', garden: 'tsukisamu' },
  { file: 'salon_sp_shiraishi.html', garden: 'shiraishi' },
];
const NOW = '2026-11-05T13:23:00+09:00';
const FULL_STOP = 'この日はこの年齢の受け入れができません';
const PART_STOP = 'この時間帯はこの年齢の受け入れができません';

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  if (!ok) fails++;
}
const capFor = (g) => ({
  base: { [g]: { 0: 1, 1: 1, 2: 1, 3: 4 } },
  '2026-11-16': { [g]: { _blocks: [{ from: '09:30', to: '17:00', ages: [0, 1, 2], limit: 0 }] } },   // 終日相当
  '2026-11-19': { [g]: { _blocks: [{ from: '09:30', to: '12:00', ages: [0, 1, 2], limit: 0 }] } },   // 午前だけ
});

async function open(browser, t, loadAt, rows) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.clock.install({ time: new Date(loadAt) });
  await page.goto('file://' + path.join(APPS, t.file.split('?')[0]) + (t.file.includes('?') ? '?' + t.file.split('?')[1] : ''));
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
  await page.evaluate(({ cap, rows }) => { window.__emit('sf_bookings', rows || []); capApplySnapshot(cap); }, { cap: capFor(t.garden), rows });
  return { ctx, page, errors };
}
const setNow = (page, at) => page.clock.setSystemTime(new Date(at));
const setChild = (page, y, m) => page.evaluate(({ y, m }) => {
  const Y = document.getElementById('sBirthYear'), M = document.getElementById('sBirthMonth');
  Y.value = String(y); onBirthChange(); M.value = String(m); onBirthChange();
}, { y, m });
const pick = (page, d) => page.evaluate((d) => { calViewYear = 2026; calViewMonth = 10; calPickDay(d); }, d);
const wish = (page, start, dur) => page.evaluate(({ start, dur }) => {
  const S = document.getElementById('wantStart'), D = document.getElementById('wantDur');
  S.value = start; D.value = String(dur); checkAvailability();
}, { start, dur });
const view = (page) => page.evaluate(() => ({
  hdr: document.getElementById('curDate').textContent.trim(),
  head: (document.querySelector('#resultArea .result-headline') || {}).textContent || '',
  detail: (document.querySelector('#resultArea .result-detail') || {}).textContent || '',
  book: !!document.querySelector('#resultArea .book-btn'),
  chips: document.querySelectorAll('#resultArea .alt-chip').length,
  modal: document.getElementById('modal').classList.contains('show'),
  ctx: document.getElementById('modalCtx').textContent,
  toast: document.getElementById('toast').textContent,
  count: document.getElementById('mbCount').textContent,
  off: dayOffset,
}));
const written = (page) => page.evaluate(() => window.__fs.writes
  .filter(w => w.op === 'set' && w.path.indexOf('sf_bookings/') === 0).map(w => w.data.date));

(async () => {
  const browser = await chromium.launch();
  for (const t of TARGETS) {
    console.log('== ' + t.file);
    for (const [label, loadAt] of [['当日に読込', '2026-11-05T13:00:00+09:00'], ['前日に読込', '2026-11-04T10:00:00+09:00'], ['2日前に読込', '2026-11-03T10:00:00+09:00']]) {
      // [1] 再現そのもの：制限日は入らない。翌日に化けない
      {
        const { ctx, page, errors } = await open(browser, t, loadAt);
        await setNow(page, NOW);
        await setChild(page, 2026, 5); await pick(page, 16); await wish(page, '10:00', 120);
        const v = await view(page);
        check(label + '/制限日：見出しは選んだ日', v.hdr.indexOf('11月16日') === 0, v.hdr);
        check(label + '/制限日：止まる文言', v.head === FULL_STOP, v.head);
        check(label + '/制限日：日付と制限の時間を出す', v.detail.indexOf('11月16日（月） 09:30〜17:00') !== -1, v.detail);
        check(label + '/制限日：予約ボタンも候補も出さない', !v.book && v.chips === 0, v.book + '/' + v.chips);
        check(label + '/制限日：予約を作らない', (await written(page)).length === 0);
        check(label + '/JSエラーなし', errors.length === 0, errors[0]);
        await ctx.close();
      }
      // [2] 制限のない日：表示どおりの日に入り、確認画面と完了メッセージが同じ日を言う
      {
        const { ctx, page, errors } = await open(browser, t, loadAt);
        await setNow(page, NOW);
        await setChild(page, 2026, 5); await pick(page, 18); await wish(page, '10:00', 120);
        await page.click('#resultArea .book-btn');
        let v = await view(page);
        check(label + '/確認画面に保存日', v.modal && v.ctx.indexOf('ご予約日：11月18日（水）') !== -1, v.ctx);
        await page.fill('#mName', 'テスト ハナ');
        await page.click('#modalConfirmBtn');
        v = await view(page);
        const w = await written(page);
        check(label + '/保存日＝選んだ日', w.length === 1 && w[0] === '2026-11-18', w.join());
        check(label + '/完了メッセージに保存日と時間', v.toast.indexOf('11月18日（水） 10:00〜12:00') !== -1, v.toast);
        check(label + '/選んだ日のまま一覧に出る', v.hdr.indexOf('11月18日') === 0 && v.count.indexOf('1 件') === 0, v.hdr + ' / ' + v.count);
        check(label + '/JSエラーなし(2)', errors.length === 0, errors[0]);
        await ctx.close();
      }
    }
    // [3] 判定をすり抜けて直接呼んでも、作る直前で止まる
    {
      const { ctx, page } = await open(browser, t, '2026-11-04T10:00:00+09:00');
      await setNow(page, NOW);
      await setChild(page, 2026, 5); await pick(page, 16);
      await page.evaluate(() => { openReserve('10:00', '12:00'); document.getElementById('mName').value = 'テスト ハナ'; confirmReserve(); });
      let v = await view(page);
      check('直接呼び：作らない', (await written(page)).length === 0);
      check('直接呼び：止めた理由を出す', v.toast.indexOf(FULL_STOP) === 0 && v.toast.indexOf('予約は作成していません') !== -1, v.toast);
      check('直接呼び：確認画面を閉じる', !v.modal);
      await page.evaluate(() => { reserveMode = 'next'; nextCustId = 'x'; openReserve('10:00', '12:00'); confirmReserve(); reserveMode = 'book'; });
      check('次回予約モードも作らない', (await written(page)).length === 0);
      await ctx.close();
    }
    // [4] 制限の対象外の年齢は止めない
    {
      const { ctx, page } = await open(browser, t, '2026-11-05T13:00:00+09:00');
      await setChild(page, 2022, 5); await pick(page, 16); await wish(page, '10:00', 120);
      const v = await view(page);
      check('対象外の年齢は ◎', v.head.indexOf('お預かりできます') !== -1 && v.book, v.head);
      await page.click('#resultArea .book-btn');
      await page.fill('#mName', 'テスト タロウ');
      await page.click('#modalConfirmBtn');
      const w = await written(page);
      check('対象外の年齢は同じ日に入る', w.length === 1 && w[0] === '2026-11-16', w.join());
      await ctx.close();
    }
    // [5] 午前だけの制限：同じ日の時間だけ候補に出す
    {
      const { ctx, page } = await open(browser, t, '2026-11-04T10:00:00+09:00');
      await setNow(page, NOW);
      await setChild(page, 2026, 5); await pick(page, 19); await wish(page, '10:00', 120);
      const v = await view(page);
      check('午前制限：時間帯の文言', v.head === PART_STOP, v.head);
      check('午前制限：候補あり・予約ボタンなし', v.chips > 0 && !v.book, v.chips);
      await page.click('#resultArea .alt-chip');
      const m = await view(page);
      check('午前制限：候補から開いても同じ日', m.ctx.indexOf('11月19日（木）') !== -1, m.ctx);
      await page.fill('#mName', 'テスト ハナ');
      await page.click('#modalConfirmBtn');
      const w = await written(page);
      check('午前制限：候補は同じ日に入る', w.length === 1 && w[0] === '2026-11-19', w.join());
      await ctx.close();
    }
    // [6] 満員は従来の文言のまま（制限と取り違えない）
    {
      const rows = [{ id: 'occ1', gardenId: t.garden, salon: 'woodstock', name: 'テスト', age: '0', months: 6, birthY: 2026, birthM: 5, start: '09:00', end: '15:00', date: '2026-11-20' }];
      const { ctx, page } = await open(browser, t, '2026-11-05T13:00:00+09:00', rows);
      await setChild(page, 2026, 5); await pick(page, 20); await wish(page, '10:00', 120);
      const v = await view(page);
      check('満員は「満員」のまま', v.head === 'この時間は満員です', v.head);
      await ctx.close();
    }
    // [7] 日またぎ：前面復帰・1分タイマーで基準日が進み、選んだ日は保つ
    {
      const { ctx, page } = await open(browser, t, '2026-11-04T10:00:00+09:00');
      await setChild(page, 2026, 5); await pick(page, 18);
      await setNow(page, NOW);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      let v = await view(page);
      check('復帰：選んだ日を保つ', v.hdr.indexOf('11月18日') === 0 && v.off === 13, v.hdr + ' off=' + v.off);
      await page.evaluate(() => calGoToday());
      v = await view(page);
      check('復帰：本日に戻ると実際の今日', v.hdr.indexOf('11月5日') === 0 && v.off === 0, v.hdr);
      await ctx.close();
      const b = await open(browser, t, '2026-11-04T10:00:00+09:00');
      await setNow(b.page, NOW);
      await b.page.clock.runFor(61000);
      const u = await view(b.page);
      check('1分タイマー：本日の画面は新しい本日へ', u.hdr.indexOf('11月5日') === 0 && u.off === 0, u.hdr);
      await b.ctx.close();
    }
    // [8] 確認画面を開いたまま本日の日付が変わったら、作らずに止まる
    {
      const { ctx, page } = await open(browser, t, '2026-11-05T23:50:00+09:00');
      await setChild(page, 2026, 5); await wish(page, '10:00', 120);
      await page.click('#resultArea .book-btn');
      const m = await view(page);
      check('深夜：確認画面は 11/5', m.ctx.indexOf('11月5日（木）') !== -1, m.ctx);
      await page.fill('#mName', 'テスト ハナ');
      await setNow(page, '2026-11-06T00:01:00+09:00');
      await page.click('#modalConfirmBtn');
      const v = await view(page);
      check('深夜：日付が変わったら作らない', (await written(page)).length === 0);
      check('深夜：理由を出す', v.toast.indexOf('日付が変わりました') === 0 && !v.modal, v.toast);
      check('深夜：見出しは新しい本日', v.hdr.indexOf('11月6日') === 0, v.hdr);
      await ctx.close();
    }
    // [9] 組（きょうだい）：制限日は止まり、空いている日は同じ日に入る
    {
      const { ctx, page, errors } = await open(browser, t, '2026-11-04T10:00:00+09:00');
      await setNow(page, NOW);
      await page.evaluate(() => {
        partyMode = true; partyKids = [{ by: 2026, bm: 5 }, { by: 2022, bm: 5 }]; partyStart = '10:00'; partyDur = 120;
        calViewYear = 2026; calViewMonth = 10; calPickDay(16); renderPartyPanel();
      });
      const st = await page.evaluate(() => document.getElementById('partyStatus').textContent);
      check('組：制限日の案内', st.indexOf(FULL_STOP) !== -1, st);
      await page.evaluate(() => partyOpenNames());
      let s = await page.evaluate(() => ({ show: document.getElementById('pfNameModal').classList.contains('show'), toast: document.getElementById('toast').textContent }));
      check('組：制限日は名前入力に進まない', !s.show && s.toast.indexOf(FULL_STOP) === 0, s.toast);
      check('組：制限日は作らない', (await written(page)).length === 0);
      await page.evaluate(() => { calPickDay(18); partyOpenNames(); });
      const ctxText = await page.evaluate(() => document.getElementById('pfNameCtx').textContent);
      check('組：名前入力に保存日', ctxText.indexOf('11月18日') === 0, ctxText);
      await page.evaluate(() => {
        document.getElementById('pfSurname').value = 'テスト';
        document.getElementById('pfGiven0').value = 'ハナ'; document.getElementById('pfGiven1').value = 'タロウ';
        partyConfirmNames();
      });
      const w = await written(page);
      check('組：全員 11/18 に入る', w.length === 2 && w.every(d => d === '2026-11-18'), w.join());
      const toast = await page.evaluate(() => document.getElementById('toast').textContent);
      check('組：完了メッセージに保存日', toast.indexOf('11月18日（水）') !== -1, toast);
      check('組：JSエラーなし', errors.length === 0, errors[0]);
      await ctx.close();
    }
  }
  await browser.close();
  console.log(fails ? fails + ' FAIL' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
