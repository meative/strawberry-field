// SF-ARCHIVE-BOARD-20260930 : board 5本。過去月のオンデマンド読み（1回だけ・キャッシュ）、閲覧専用、
// 編集可能にした月の差分書き込みと「アーカイブ由来は削除対象にならない」、窓内は pristine と DOM 一致。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const PRISTINE = process.env.SF_PRISTINE || '';   // 比較用（git show HEAD:apps/*.html を置いたディレクトリ）。無ければ比較を省く
const FILES = ['board.html', 'board_sp_tsukisamu.html', 'board_sp_shiraishi.html', 'board_sp_factory.html', 'board_sp_shiseikan.html'];
const NOW = '2026-09-30T10:00:00+09:00';   // 窓 = 2026-09-01

let fails = 0;
function check(file, name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + file + ' : ' + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) fails++;
}
const tick = (page, ms) => page.waitForTimeout(ms || 30);

function seed(g) {
  const base = { salon: 'temp', age: '1', months: 4, birthY: 2025, birthM: 5, provisional: false, fromBoard: true, kana: '' };
  const live = [
    { ...base, id: 'L1', gardenId: g, name: 'ライブ一', date: '2026-09-30', start: '10:00', end: '11:30' },
    { ...base, id: 'L2', gardenId: g, name: 'ライブ二', date: '2026-09-30', start: '13:00', end: '14:00' },
    { ...base, id: 'L3', gardenId: g, name: 'ライブ三', date: '2026-09-15', start: '10:00', end: '11:00' },
  ];
  const cloud = [
    { ...base, id: 'A1', gardenId: g, name: '八月一', date: '2026-08-15', start: '10:00', end: '11:30', memo: 'before' },
    { ...base, id: 'A2', gardenId: g, name: '八月二', date: '2026-08-15', start: '13:00', end: '14:00' },
    { ...base, id: 'A3', gardenId: g, name: '八月キャンセル', date: '2026-08-20', start: '10:00', end: '11:00', cancelled: true, cancelledAt: 1, cancelledBy: 'salon' },
    { ...base, id: 'A4', gardenId: (g === 'tsukisamu' ? 'shiraishi' : 'tsukisamu'), name: '他園八月', date: '2026-08-15', start: '10:00', end: '11:00' },
    { ...base, id: 'J1', gardenId: g, name: '七月一', date: '2026-07-10', start: '10:00', end: '11:00' },
    ...live,
  ];
  return { live, cloud };
}

async function boot(browser, file, dir) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.clock.install({ time: new Date(NOW) });
  await page.goto('file://' + path.join(dir, file));
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
  const g = await page.evaluate(() => CURRENT_GARDEN);
  const s = seed(g);
  await page.evaluate((s) => { window.__cloud = { sf_bookings: s.cloud }; window.sfAlert = (m) => { (window.__alerts = window.__alerts || []).push(m); return Promise.resolve(); }; window.sfConfirm = () => Promise.resolve(true); window.sfChoose = () => Promise.resolve('ok'); }, s);
  await page.evaluate((rows) => window.__emit('sf_bookings', rows, false), s.live);
  await tick(page);
  return { ctx, page, errors, g, s };
}

const snap = () => ({
  board: document.getElementById('board').innerHTML,
  names: Array.from(document.querySelectorAll('.booking-bar')).map(b => b.title.split('（')[0]),
  band: (function () { const b = document.getElementById('sfArchiveBand'); return b ? { shown: b.style.display !== 'none', text: b.textContent.trim(), cls: b.className } : null; })(),
  fetches: window.__sfArchiveFetchCount || 0,
  getDocs: window.__fs.calls.filter(c => c[0] === 'getDocs').map(c => c[2]),
  mirrorIds: SF_MIRROR.map(r => r.id).sort(),
  archIds: Object.keys(SF_ARCHIVE).sort().map(k => k + ':' + SF_ARCHIVE[k].map(r => r.id).sort().join(',')),
  mode: sfArchiveMode(),
  bodyRo: document.body.classList.contains('sf-archive-readonly'),
  date: boardDateStr(),
});

(async () => {
  const browser = await chromium.launch();
  for (const file of FILES) {
    const { ctx, page, errors, g, s } = await boot(browser, file, APPS);

    // ---- 窓内（本日）：従来どおり。帯なし・getDocs なし ----
    let st = await page.evaluate(snap);
    check(file, 'live day: no band, no getDocs, mode=live, bars L1/L2', !st.band.shown && st.getDocs.length === 0 && st.mode === 'live' && st.names.includes('ライブ一') && st.names.includes('ライブ二') && !st.bodyRo, JSON.stringify({ names: st.names, band: st.band }));
    if (PRISTINE && fs.existsSync(path.join(PRISTINE, file))) {
      const pr = await boot(browser, file, PRISTINE);
      const a = await page.evaluate(() => ({ board: document.getElementById('board').innerHTML, cal: (toggleCalendar(), document.getElementById('calGrid').innerHTML), title: document.getElementById('calTitle').textContent }));
      const b = await pr.page.evaluate(() => ({ board: document.getElementById('board').innerHTML, cal: (toggleCalendar(), document.getElementById('calGrid').innerHTML), title: document.getElementById('calTitle').textContent }));
      check(file, 'live day: #board and September calendar grid identical to pristine', a.board === b.board && a.cal === b.cal && a.title === b.title, a.board === b.board ? 'cal differs' : 'board differs');
      // 9/15 に移動しても一致（窓内の別日）
      const a2 = await page.evaluate(() => { closeCalendar(); calViewYear = 2026; calViewMonth = 8; calPickDay(15); return { board: document.getElementById('board').innerHTML, d: boardDateStr(), band: document.getElementById('sfArchiveBand').style.display }; });
      const b2 = await pr.page.evaluate(() => { closeCalendar(); calViewYear = 2026; calViewMonth = 8; calPickDay(15); return { board: document.getElementById('board').innerHTML, d: boardDateStr() }; });
      check(file, 'live 9/15: #board identical to pristine, still no band/getDocs', a2.board === b2.board && a2.d === '2026-09-15' && a2.band === 'none' && (await page.evaluate(() => window.__fs.calls.filter(c => c[0] === 'getDocs').length)) === 0);
      await pr.ctx.close();
      await page.evaluate(() => { calGoToday(); });
    }

    // ---- 過去月へ移動：1回だけ getDocs（date 範囲のみ）→ 表示・帯 ----
    await page.evaluate(() => { calViewYear = 2026; calViewMonth = 7; calPickDay(15); });
    await tick(page, 60);
    st = await page.evaluate(snap);
    check(file, '8/15: one getDocs on date range 2026-08-01..31, band 閲覧のみ with count, A1/A2 shown (A4 other garden hidden), readonly',
      st.date === '2026-08-15' && st.fetches === 1 && st.getDocs.length === 1 && st.getDocs[0] === 'date>=2026-08-01&date<=2026-08-31'
      && st.band.shown && /閲覧のみ/.test(st.band.text) && /2026年8月/.test(st.band.text) && /読み込み済み ・ 3 件/.test(st.band.text)
      && st.names.includes('八月一') && st.names.includes('八月二') && !st.names.includes('他園八月') && st.mode === 'readonly' && st.bodyRo
      && st.mirrorIds.join() === 'L1,L2,L3' && st.archIds.join('|') === '2026-08:A1,A2,A3,A4', JSON.stringify({ d: st.date, f: st.fetches, g: st.getDocs, band: st.band, names: st.names, arch: st.archIds }));

    // 同じ月の別日・戻り → キャッシュ（getDocs 増えない）
    await page.evaluate(() => { changeDay(1); changeDay(-1); calViewYear = 2026; calViewMonth = 7; calPickDay(20); });
    await tick(page);
    st = await page.evaluate(snap);
    check(file, 'same month again: cached (still 1 getDocs), 8/20 shows cancelled A3 bar', st.fetches === 1 && st.getDocs.length === 1 && st.date === '2026-08-20' && st.names.includes('八月キャンセル'), JSON.stringify({ f: st.fetches, names: st.names }));
    // 過去月の未確認キャンセルは帯・一覧に出ない（写しだけを見る）
    const cxl = await page.evaluate(() => { const b = document.getElementById('sfCxlBand'); return b ? b.textContent : ''; });
    check(file, 'old unacked cancel (A3) does not appear in the cancel band', !/八月キャンセル/.test(cxl));
    // SF_MIRROR は窓内のまま（不変条件）
    check(file, 'SF_MIRROR still window-only after archive load', st.mirrorIds.join() === 'L1,L2,L3');

    // ---- カレンダー：8月は点く、7月は未読込（薄い＋ボタン）→ 読み込むと点く ----
    let cal = await page.evaluate(() => { toggleCalendar(); const gr = document.getElementById('calGrid'); const note = document.getElementById('sfArchiveCalNote');
      const has = Array.from(gr.querySelectorAll('.cal-day.has-booking')).map(e => e.textContent); const unl = gr.querySelectorAll('.cal-day.arc-unloaded').length;
      return { title: document.getElementById('calTitle').textContent, has, unl, note: note ? note.style.display : 'x' }; });
    check(file, 'calendar Aug: dots on 15/20, no unloaded marks, note hidden', /8月/.test(cal.title) && cal.has.join() === '15,20' && cal.unl === 0 && cal.note === 'none', JSON.stringify(cal));
    cal = await page.evaluate(() => { calShiftMonth(-1); const gr = document.getElementById('calGrid'); const note = document.getElementById('sfArchiveCalNote');
      return { title: document.getElementById('calTitle').textContent, has: gr.querySelectorAll('.cal-day.has-booking').length, unl: gr.querySelectorAll('.cal-day.arc-unloaded').length, days: gr.querySelectorAll('.cal-day:not(.empty)').length, note: note.style.display, noteText: note.textContent, btn: !!note.querySelector('button') }; });
    check(file, 'calendar Jul: unloaded (all days dimmed, no dots, note with button)', /7月/.test(cal.title) && cal.has === 0 && cal.unl === cal.days && cal.days === 31 && cal.note === 'block' && /未読込/.test(cal.noteText) && cal.btn, JSON.stringify(cal));
    await page.evaluate(() => document.querySelector('#sfArchiveCalNote button').click());
    await tick(page, 60);
    cal = await page.evaluate(() => { const gr = document.getElementById('calGrid'); const note = document.getElementById('sfArchiveCalNote');
      return { has: Array.from(gr.querySelectorAll('.cal-day.has-booking')).map(e => e.textContent), unl: gr.querySelectorAll('.cal-day.arc-unloaded').length, note: note.style.display, fetches: window.__sfArchiveFetchCount, calls: window.__fs.calls.filter(c => c[0] === 'getDocs').map(c => c[2]) }; });
    check(file, 'calendar Jul after load button: 1 more getDocs (Jul range), dot on 10, note hidden', cal.fetches === 2 && cal.calls[1] === 'date>=2026-07-01&date<=2026-07-31' && cal.has.join() === '10' && cal.unl === 0 && cal.note === 'none', JSON.stringify(cal));
    // 9月（窓内）はリアルタイムのまま（未読込表示なし）
    cal = await page.evaluate(() => { calShiftMonth(2); const gr = document.getElementById('calGrid'); return { title: document.getElementById('calTitle').textContent, has: Array.from(gr.querySelectorAll('.cal-day.has-booking')).map(e => e.textContent), unl: gr.querySelectorAll('.cal-day.arc-unloaded').length, note: document.getElementById('sfArchiveCalNote').style.display }; });
    check(file, 'calendar Sep (window): live dots 15/30, no unloaded marks', /9月/.test(cal.title) && cal.has.join() === '15,30' && cal.unl === 0 && cal.note === 'none', JSON.stringify(cal));
    await page.evaluate(() => closeCalendar());

    // ---- 閲覧のみガード ----
    await page.evaluate(() => { calViewYear = 2026; calViewMonth = 7; calPickDay(15); });
    await tick(page);
    let ro = await page.evaluate(() => {
      window.__alerts = [];
      openModal(); const m1 = document.getElementById('modal').classList.contains('show');
      onSlotTap('temp', 0, 4); const m2 = document.getElementById('modal').classList.contains('show');
      const i = bookings.findIndex(b => b.sfId === 'A1');
      onBarTap(i); const m3 = document.getElementById('modal').classList.contains('show');
      const r = { m1, m2, m3, title: document.getElementById('modalTitle').textContent,
        save: document.getElementById('mSave').style.display, del: document.getElementById('mDelete').style.display, cxl: document.getElementById('mCancelMark').style.display,
        w0: window.__fs.writes.length, alerts: window.__alerts.length };
      document.getElementById('mMemo').value = 'tampered';
      return r;
    });
    await page.evaluate(async () => { await saveBooking(); await cancelBookingMark(); await deleteBooking(); });
    const ro2 = await page.evaluate(() => ({ alerts: window.__alerts.length, w: window.__fs.writes.length, memo: sfLoad().find(r => r.id === 'A1').memo, cancelled: !!sfLoad().find(r => r.id === 'A1').cancelled, n: sfLoad().filter(r => r.id === 'A1').length }));
    check(file, 'readonly: new/slot blocked with alert, bar tap opens view-only modal (save/delete/cancel hidden), save/cancel/delete refused, no writes',
      !ro.m1 && !ro.m2 && ro.m3 && /閲覧のみ/.test(ro.title) && ro.save === 'none' && ro.del === 'none' && ro.cxl === 'none' && ro.alerts === 2
      && ro2.alerts === 5 && ro2.w === ro.w0 && ro2.memo === 'before' && !ro2.cancelled && ro2.n === 1, JSON.stringify({ ro, ro2 }));
    // ドラッグ：閲覧のみは pointerdown で動かない
    const drag = await page.evaluate(() => {
      closeModal();
      const bar = document.querySelector('.booking-bar[title^="八月一"] .bar-body');
      const before = bookings.find(b => b.sfId === 'A1').start;
      bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 400, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 400, pointerId: 1 }));
      return { before, after: bookings.find(b => b.sfId === 'A1').start, drag: dragState, writes: window.__fs.writes.length };
    });
    check(file, 'readonly: pointer drag does not move the bar or write', drag.before === drag.after && drag.drag === null && drag.writes === ro.w0, JSON.stringify(drag));

    // ---- 編集可能にする → 1件直す → その1件だけ set、削除なし、SF_MIRROR 無変化 ----
    await page.evaluate(() => document.querySelector('#sfArchiveBand .edit-btn').click());
    let ed = await page.evaluate(async () => {
      const w0 = window.__fs.writes.length;
      const i = bookings.findIndex(b => b.sfId === 'A1');
      onBarTap(i);
      const save = document.getElementById('mSave').style.display;
      document.getElementById('mMemo').value = 'fixed';
      await saveBooking();
      const writes = window.__fs.writes.slice(w0);
      return { band: document.getElementById('sfArchiveBand').className, save, writes: writes.map(x => x.op + ':' + x.path + (x.data ? ':' + x.data.memo : '')),
        mirror: SF_MIRROR.map(r => r.id).sort().join(), arch: SF_ARCHIVE['2026-08'].find(r => r.id === 'A1').memo, view: sfLoad().find(r => r.id === 'A1').memo, mode: sfArchiveMode() };
    });
    check(file, 'editable: edit A1 memo → exactly one set (A1), no delete, SF_MIRROR unchanged, cache+view updated',
      /edit/.test(ed.band) && ed.save === '' && ed.writes.join('|') === 'set:sf_bookings/A1:fixed' && ed.mirror === 'L1,L2,L3' && ed.arch === 'fixed' && ed.view === 'fixed' && ed.mode === 'editable', JSON.stringify(ed));

    // ---- 陰性対照：アーカイブを含まない配列を allowDelete=true で保存しても、アーカイブ由来は削除されない ----
    const neg = await page.evaluate(() => {
      const w0 = window.__fs.writes.length;
      const liveOnly = sfLoadLive();                       // アーカイブを忘れた呼び出し側を模す
      const naive = sfLoad().map(r => r.id).filter(id => !liveOnly.some(r => r.id === id));   // ガード無しの素朴な差分（写し∪アーカイブ − 渡された配列）
      sfSave(liveOnly, true);
      const writes = window.__fs.writes.slice(w0);
      return { naive: naive.sort(), writes: writes.map(x => x.op + ':' + x.path), arch: SF_ARCHIVE['2026-08'].map(r => r.id).sort().join(), view: sfLoad().length };
    });
    check(file, 'negative control: naive diff would delete ' + neg.naive.length + ' archive ids, guarded sfSave deletes nothing and cache intact',
      neg.naive.length === 5 && neg.writes.length === 0 && neg.arch === 'A1,A2,A3,A4' && neg.view === 8, JSON.stringify(neg));

    // ---- 編集可能：新規作成（過去日）→ set のみ、アーカイブに入り SF_MIRROR には入らない ----
    ed = await page.evaluate(async () => {
      const w0 = window.__fs.writes.length;
      onSlotTap('temp', 0, 8);
      document.getElementById('mName').value = '八月新規';
      setBirthYM(2025, 1);
      await saveBooking();
      const writes = window.__fs.writes.slice(w0);
      const w = writes[0] || {};
      return { n: writes.length, op: w.op, date: w.data && w.data.date, name: w.data && w.data.name, inArch: SF_ARCHIVE['2026-08'].some(r => r.name === '八月新規'), inMirror: SF_MIRROR.some(r => r.name === '八月新規'),
        bar: Array.from(document.querySelectorAll('.booking-bar')).some(b => /八月新規/.test(b.title)) };
    });
    check(file, 'editable: new booking on 8/15 → one set with date 2026-08-15, cached in archive, not in SF_MIRROR, bar shown', ed.n === 1 && ed.op === 'set' && ed.date === '2026-08-15' && ed.name === '八月新規' && ed.inArch && !ed.inMirror && ed.bar, JSON.stringify(ed));

    // ---- 編集可能：明示的な削除（A2）→ delete は A2 だけ ----
    ed = await page.evaluate(async () => {
      const w0 = window.__fs.writes.length;
      const i = bookings.findIndex(b => b.sfId === 'A2');
      onBarTap(i);
      await deleteBooking();
      const writes = window.__fs.writes.slice(w0);
      return { writes: writes.map(x => x.op + ':' + x.path), arch: SF_ARCHIVE['2026-08'].map(r => r.id).sort().join(','), bar: Array.from(document.querySelectorAll('.booking-bar')).some(b => /八月二/.test(b.title)), mirror: SF_MIRROR.map(r => r.id).sort().join() };
    });
    check(file, 'editable: explicit delete A2 → exactly delete:A2, removed from cache and board, SF_MIRROR unchanged', ed.writes.join('|') === 'delete:sf_bookings/A2' && !/A2/.test(ed.arch) && /A1/.test(ed.arch) && !ed.bar && ed.mirror === 'L1,L2,L3', JSON.stringify(ed));

    // ---- 窓内スナップショットが届いてもアーカイブは残る ----
    ed = await page.evaluate((live) => { window.__emit('sf_bookings', live, false); return { names: Array.from(document.querySelectorAll('.booking-bar')).map(b => b.title.split('（')[0]), mirror: SF_MIRROR.map(r => r.id).sort().join() }; }, s.live);
    check(file, 'window snapshot after edits: 8/15 still shows A1 + new record', ed.names.includes('八月一') && ed.names.includes('八月新規') && ed.mirror === 'L1,L2,L3', JSON.stringify(ed));

    // ---- 本日に戻って L1 を明示削除 → delete は L1 だけ（アーカイブに触れない） ----
    ed = await page.evaluate(async () => {
      calGoToday();
      const w0 = window.__fs.writes.length;
      const i = bookings.findIndex(b => b.sfId === 'L1');
      onBarTap(i);
      await deleteBooking();
      return { writes: window.__fs.writes.slice(w0).map(x => x.op + ':' + x.path), arch: SF_ARCHIVE['2026-08'].length, band: document.getElementById('sfArchiveBand').style.display, mode: sfArchiveMode() };
    });
    check(file, 'back to today: explicit delete L1 → only delete:L1; archive cache untouched; band hidden', ed.writes.join('|') === 'delete:sf_bookings/L1' && ed.arch === 4 && ed.band === 'none' && ed.mode === 'live', JSON.stringify(ed));

    // ---- 「閲覧のみに戻す」 ----
    ed = await page.evaluate(() => { calViewYear = 2026; calViewMonth = 7; calPickDay(15); document.querySelector('#sfArchiveBand button:last-child').click(); return { mode: sfArchiveMode(), cls: document.getElementById('sfArchiveBand').className }; });
    check(file, 'back to readonly via band button', ed.mode === 'readonly' && !/edit/.test(ed.cls), JSON.stringify(ed));

    // ---- 読み込み失敗：帯にエラー、再試行で回復 ----
    ed = await page.evaluate(async () => {
      window.__cloudFail = true;
      calViewYear = 2026; calViewMonth = 5; calPickDay(10);
      await new Promise(r => setTimeout(r, 30));
      const t1 = document.getElementById('sfArchiveBand').textContent;
      window.__cloudFail = false;
      sfArchiveRetry();
      await new Promise(r => setTimeout(r, 30));
      return { t1, t2: document.getElementById('sfArchiveBand').textContent, st: SF_ARCHIVE_STATE['2026-06'] };
    });
    check(file, 'fetch failure shows error in band; retry recovers', /失敗/.test(ed.t1) && /読み込み済み/.test(ed.t2) && ed.st === 'loaded', JSON.stringify(ed));

    const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
    check(file, 'no page errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
    await ctx.close();
  }
  await browser.close();
  console.log(fails ? ('\nFAILED: ' + fails) : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
