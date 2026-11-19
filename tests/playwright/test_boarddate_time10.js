// SF-BOARDDATE-20261119（board 5本）／ SF-TIME10-20261119（board 5本＋salon 3本）
// B：2026-11-19 報告。ボード「＋ 予約を追加」で日付を 12/4 に変えて確定すると、今日の日付で入っていた。
//    → 日付を変えて保存したら、その日付の1件だけ・今日には入らない。確認に保存日を出す。
// C：開始時刻の選択を10分刻みに。旧予約（11:45 など15分刻み）の表示・定員計算と整合すること。
// Firebase は stubs.js の偽物なので本番には触れない。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const BOARDS = [
  { file: 'board.html', garden: 'tsukisamu' },
  { file: 'board_sp_tsukisamu.html', garden: 'tsukisamu' },
  { file: 'board_sp_shiraishi.html', garden: 'shiraishi' },
  { file: 'board_sp_factory.html', garden: 'factory' },
  { file: 'board_sp_shiseikan.html', garden: 'shiseikan' },
];
const SALONS = [
  { file: 'salon.html', q: '?garden=tsukisamu', garden: 'tsukisamu' },
  { file: 'salon_sp_tsukisamu.html', q: '', garden: 'tsukisamu' },
  { file: 'salon_sp_shiraishi.html', q: '', garden: 'shiraishi' },
];
const NOW = '2026-11-19T10:08:00+09:00';
const TODAY = '2026-11-19';

let fails = 0;
function check(file, name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + file + ' : ' + name + (extra !== undefined ? '  [' + String(extra).slice(0, 240) + ']' : ''));
  if (!ok) fails++;
}

async function openPage(browser, file, q, waitName) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.clock.install({ time: new Date(NOW) });
  await page.goto('file://' + path.join(APPS, file) + (q || ''));
  await page.waitForFunction((n) => window.__fs && window.__fs.listeners.some(l => l.name === n), waitName, { timeout: 15000 });
  return { ctx, page, errors };
}
const bkWrites = (page) => page.evaluate(() => window.__fs.writes
  .filter(w => w.op === 'set' && w.path.indexOf('sf_bookings/') === 0).map(w => ({ id: w.path.split('/')[1], date: w.data.date, start: w.data.start, end: w.data.end })));
const dlg = (page) => page.evaluate(() => {
  const o = document.getElementById('sfdOverlay');
  const shown = !!(o && getComputedStyle(o).display !== 'none' && o.classList.contains('show'));
  return { shown, msg: shown ? o.querySelector('.sfd-msg').textContent : '', ok: shown ? o.querySelector('.sfd-ok').textContent : '' };
});
const fill = (page, o) => page.evaluate((o) => {
  document.getElementById('mName').value = o.name;
  setBirthYM(2024, 5);
  const S = document.getElementById('mStart'); S.value = o.start; updateEndPreview();
  setDuration(o.dur);
  if (o.date) { const D = document.getElementById('mDate'); D.value = o.date; D.dispatchEvent(new Event('change')); }
}, o);

(async () => {
  const browser = await chromium.launch();

  // ================= board =================
  for (const t of BOARDS) {
    console.log('== ' + t.file);
    const seed = [{ id: 'old1', gardenId: t.garden, salon: 'temp', name: 'テスト 旧', age: '2', months: 6, birthY: 2024, birthM: 5,
      start: '11:45', end: '13:45', date: TODAY, fromBoard: true }];
    // [1] 再現：予約バーを開いて閉じた後に「＋ 予約を追加」→ 12/4 に変えて確定 → 12/4 の1件だけ
    {
      const { ctx, page, errors } = await openPage(browser, t.file, '', 'sf_bookings');
      await page.evaluate((rows) => window.__emit('sf_bookings', rows, false), seed);
      await page.evaluate(() => { const i = bookings.findIndex(b => b.sfId === 'old1'); onBarTap(i); closeModal(); window.__fs.writes.length = 0; openModal(); });
      let v = await page.evaluate(() => ({ disp: document.getElementById('mDateField').style.display, val: document.getElementById('mDate').value, btn: document.getElementById('mSave').textContent }));
      check(t.file, '[1a] 新規でも日付欄が出て、表示日で初期化・確定ボタンに日付', v.disp === '' && v.val === TODAY && v.btn === '11/19（木）で確定', JSON.stringify(v));
      await fill(page, { name: 'テスト 十二月', start: '11:40', dur: 240, date: '2026-12-04' });
      v = await page.evaluate(() => document.getElementById('mSave').textContent);
      check(t.file, '[1b] 日付欄の change で確定ボタンが「12/4（金）で確定」', v === '12/4（金）で確定', v);
      await page.evaluate(() => { saveBooking(); });
      await page.waitForTimeout(150);
      const d = await dlg(page);
      check(t.file, '[1c] 表示日と違う日は確認を出し、保存日を明示', d.shown && d.msg.indexOf('12月4日（金）') === 0 && d.msg.indexOf('11:40 〜 15:40') !== -1 && d.ok === '12月4日（金） に入れる', JSON.stringify(d));
      check(t.file, '[1d] 確認前は何も書かない', (await bkWrites(page)).length === 0);
      await page.click('#sfdOverlay .sfd-ok');
      await page.waitForTimeout(200);
      const w = await bkWrites(page);
      check(t.file, '[1e] 書き込みは 12/4 の1件だけ・今日には入らない', w.length === 1 && w[0].date === '2026-12-04' && w[0].start === '11:40' && w[0].end === '15:40', JSON.stringify(w));
      v = await page.evaluate(() => ({ onBoard: bookings.filter(b => b.name === 'テスト 十二月').length,
        mirror: SF_MIRROR.filter(r => r.name === 'テスト 十二月').map(r => r.date) }));
      check(t.file, '[1f] 今日のボードには置かず、写しには 12/4 で入る', v.onBoard === 0 && v.mirror.length === 1 && v.mirror[0] === '2026-12-04', JSON.stringify(v));
      check(t.file, '[1g] ページエラーなし', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
    // [2] 確認で「やめる」→ 書かない ／ [3] 表示日のままなら確認なしで今日に1件 ／ [4] 空きコマからでも日付が効く
    {
      const { ctx, page, errors } = await openPage(browser, t.file, '', 'sf_bookings');
      await page.evaluate((rows) => window.__emit('sf_bookings', rows, false), seed);
      await page.evaluate(() => { window.__fs.writes.length = 0; openModal(); });
      await fill(page, { name: 'テスト やめ', start: '10:00', dur: 90, date: '2026-12-04' });
      await page.evaluate(() => { saveBooking(); });
      await page.waitForTimeout(150);
      await page.click('#sfdOverlay .sfd-cancel');
      await page.waitForTimeout(150);
      check(t.file, '[2] 確認で取りやめれば書かない', (await bkWrites(page)).length === 0);

      await page.evaluate(() => { closeModal(); openModal(); });
      await fill(page, { name: 'テスト 本日', start: '13:10', dur: 60 });
      await page.evaluate(() => { saveBooking(); });
      await page.waitForTimeout(200);
      let d = await dlg(page);
      let w = await bkWrites(page);
      check(t.file, '[3] 表示日のままなら確認なし・今日に1件・ボードに出る', !d.shown && w.length === 1 && w[0].date === TODAY
        && (await page.evaluate(() => bookings.some(b => b.name === 'テスト 本日' && b.start === '13:10'))), JSON.stringify({ d, w }));

      await page.evaluate(() => { window.__fs.writes.length = 0; onSlotTap('temp', 0, SLOTS.indexOf('15:45')); });
      let v = await page.evaluate(() => ({ disp: document.getElementById('mDateField').style.display, start: document.getElementById('mStart').value }));
      check(t.file, '[4a] 空きコマからも日付欄が出る・15分のコマの時刻（15:45）は丸めずに保つ', v.disp === '' && v.start === '15:45', JSON.stringify(v));
      await fill(page, { name: 'テスト 空きコマ', start: '15:50', dur: 60, date: '2026-11-25' });
      await page.evaluate(() => { saveBooking(); });
      await page.waitForTimeout(150);
      await page.click('#sfdOverlay .sfd-ok');
      await page.waitForTimeout(200);
      w = await bkWrites(page);
      check(t.file, '[4b] 空きコマから別の日 → その日の1件だけ', w.length === 1 && w[0].date === '2026-11-25' && w[0].start === '15:50', JSON.stringify(w));
      check(t.file, '[2-4] ページエラーなし', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
    // [5] 編集で別の日へ移すときも確認 ／ [6] 10分刻みの選択肢・旧15分予約の表示・小数位置・ドラッグ
    {
      const { ctx, page, errors } = await openPage(browser, t.file, '', 'sf_bookings');
      const rows = seed.concat([{ id: 'new10', gardenId: t.garden, salon: 'temp', name: 'テスト 十分', age: '2', months: 6, birthY: 2024, birthM: 5,
        start: '11:40', end: '12:50', date: TODAY, fromBoard: true }]);
      await page.evaluate((rows) => window.__emit('sf_bookings', rows, false), rows);
      await page.evaluate(() => { window.__fs.writes.length = 0; const i = bookings.findIndex(b => b.sfId === 'old1'); onBarTap(i); });
      let v = await page.evaluate(() => ({ start: document.getElementById('mStart').value,
        opts: Array.from(document.getElementById('mStart').options).map(o => o.value) }));
      check(t.file, '[6a] 旧予約 11:45 は編集で 11:45 のまま選ばれる', v.start === '11:45', v.start);
      const tens = v.opts.filter(x => x !== '11:45');
      check(t.file, '[6b] 選択肢は 07:00〜19:50 の10分刻み（＋その予約の時刻だけ）', tens.length === 78 && tens[0] === '07:00' && tens[77] === '19:50'
        && tens.every(x => Number(x.slice(3)) % 10 === 0) && v.opts.indexOf('11:40') !== -1 && v.opts.indexOf('11:50') !== -1, v.opts.length + ' ' + v.opts.slice(0, 8).join(','));
      await page.evaluate(() => { document.getElementById('mDate').value = '2026-11-20'; document.getElementById('mDate').dispatchEvent(new Event('change')); saveBooking(); });
      await page.waitForTimeout(150);
      const d = await dlg(page);
      check(t.file, '[5a] 編集で別の日へ移すときも確認（保存日を明示）', d.shown && d.msg.indexOf('この予約を 11月20日（金）') === 0, JSON.stringify(d));
      await page.click('#sfdOverlay .sfd-ok');
      await page.waitForTimeout(200);
      const w = await bkWrites(page);
      check(t.file, '[5b] 移した日付で1件だけ書く', w.length === 1 && w[0].id === 'old1' && w[0].date === '2026-11-20', JSON.stringify(w));

      v = await page.evaluate(() => {
        const b = bookings.find(x => x.sfId === 'new10');
        const bar = document.querySelector('.booking-bar[data-idx="' + bookings.indexOf(b) + '"]');
        return { si: slotIndex('11:40'), se: slotIndex('12:50'), s45: slotIndex('11:45'), end: slotIndex('20:00'), bad: slotIndex('xx'),
          bar: !!bar, left: bar ? bar.style.left : '', t: sfSlotTime(slotIndex('11:40')), t2: sfSlotTime(slotIndex('11:40') + 2) };
      });
      const expLeft = ((11 * 60 + 40 - 420) / 15) / 52 * 100;
      check(t.file, '[6c] 10分の時刻は小数位置（11:40=18.67）・目盛りの時刻は従来どおり・閉園は -1', Math.abs(v.si - 280 / 15) < 1e-9 && Math.abs(v.se - 350 / 15) < 1e-9 && v.s45 === 19 && v.end === -1 && v.bad === -1, JSON.stringify(v));
      check(t.file, '[6d] 11:40 の予約バーが描かれ、位置が分どおり', v.bar && Math.abs(parseFloat(v.left) - expLeft) < 1e-3, v.left + ' vs ' + expLeft);
      check(t.file, '[6e] ドラッグの時刻は分で出す（2マス＝30分あと）', v.t === '11:40' && v.t2 === '12:10', v.t + '/' + v.t2);
      // 区分のレーン：10分の予約と重なる 12:00〜 は同じレーンに置かない
      v = await page.evaluate(() => findFreeLane('temp', '12:00', '13:00', -1));
      check(t.file, '[6f] 10分の時刻の予約とも重なり判定する（12:00〜13:00 はレーン0に置かない）', v !== 0, v);
      check(t.file, '[5-6] ページエラーなし', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  }

  // ================= salon =================
  for (const t of SALONS) {
    console.log('== ' + t.file);
    const { ctx, page, errors } = await openPage(browser, t.file, t.q, 'sf_bookings');
    await page.evaluate(({ g }) => {
      // 2歳の同時定員1。ボード由来の 11:45〜14:45（15分刻み）が1件
      window.__emit('sf_bookings', [{ id: 'b1145', gardenId: g, salon: 'temp', name: 'テスト', age: '2', months: 6, birthY: 2024, birthM: 5,
        start: '11:45', end: '14:45', date: '2026-11-19', fromBoard: true }]);
      capApplySnapshot({ base: { [g]: { 0: 3, 1: 3, 2: 1, 3: 3 } } });
      const Y = document.getElementById('sBirthYear'), M = document.getElementById('sBirthMonth');
      Y.value = '2024'; onBirthChange(); M.value = '5'; onBirthChange();
    }, { g: t.garden });
    let v = await page.evaluate(() => Array.from(document.getElementById('wantStart').options).map(o => o.value));
    check(t.file, '[S1] 開始時刻の選択肢が10分刻み（09:30〜16:00）', v[0] === '09:30' && v[1] === '09:40' && v[v.length - 1] === '16:00' && v.length === 40, v.length + ' ' + v.slice(0, 4).join(','));
    const judge = (start, dur) => page.evaluate(({ start, dur }) => {
      const S = document.getElementById('wantStart'), D = document.getElementById('wantDur');
      S.value = start; D.value = String(dur); checkAvailability();
      return { head: (document.querySelector('#resultArea .result-headline') || {}).textContent || '', book: !!document.querySelector('#resultArea .book-btn'),
        alts: Array.from(document.querySelectorAll('#resultArea .alt-chip')).map(e => e.textContent) };
    }, { start, dur });
    v = await judge('10:10', 90);
    check(t.file, '[S2] 10:10〜11:40 は空き（10分の開始で判定できる）', v.head.indexOf('お預かりできます') !== -1 && v.book, JSON.stringify(v));
    v = await judge('10:20', 90);
    check(t.file, '[S3] 10:20〜11:50 はボードの 11:45 開始と重なるので満員（従来は 11:45 が数えられず漏れていた）', v.head === 'この時間は満員です' && !v.book, JSON.stringify(v));
    check(t.file, '[S4] 候補は10分刻みで、11:45〜14:45 と重ならない', v.alts.length > 0 && v.alts.every(a => { const s = a.slice(0, 5), e = a.slice(-5); return (e <= '11:45' || s >= '14:45') && Number(s.slice(3)) % 10 === 0; }), v.alts.join(' / '));
    v = await judge('14:50', 60);
    check(t.file, '[S5] 14:50〜15:50 は空き（14:45 終了の直後）', v.head.indexOf('お預かりできます') !== -1, JSON.stringify(v));
    v = await page.evaluate(() => { rebuildUsed(); const i = SLOTS.indexOf('11:40'), j = SLOTS.indexOf('14:40'), k = SLOTS.indexOf('14:50'); return [used['2'][i], used['2'][i + 1], used['2'][j], used['2'][k]]; });
    check(t.file, '[S6] 占有は分で重なるスロットに数える（11:40枠=1, 11:50=1, 14:40=1, 14:50=0）', JSON.stringify(v) === '[1,1,1,0]', JSON.stringify(v));
    check(t.file, '[S] ページエラーなし', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log(fails ? `\nFAIL ${fails} 件` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
