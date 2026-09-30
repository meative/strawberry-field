// SF-ARCHIVE-TIMELY-20260930 : timely.html。窓（前月1日）より前の日報・月報で早朝・延長の件数が出る、
// 1回だけ読む、CSV と同じ数、DATA.reservations / SF_MIRROR には流れない。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILE = 'file://' + path.join(APPS, 'timely.html');
const BRANCH = 'サッポロファクトリー園';   // 既定 → gardenId 'factory'
const NOW = '2026-09-30T10:00:00+09:00';   // timely の窓 = 2026-08-01

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) fails++;
}

const ext = (id, date, salon, name, gardenId) => ({ id, gardenId: gardenId || 'factory', salon, affiliation: 'youchisha', name, date, start: salon === 'ext_am' ? '07:00' : '16:30', end: salon === 'ext_am' ? '08:30' : '17:30', fromBoard: true });
const CLOUD = [
  ext('J1', '2026-07-10', 'ext_am', '生徒A'), ext('J2', '2026-07-10', 'ext_am', '生徒B'), ext('J3', '2026-07-10', 'ext_pm', '生徒A'),
  ext('J4', '2026-07-22', 'ext_pm', '生徒C'),
  ext('J5', '2026-07-10', 'ext_am', '他園生徒', 'tsukisamu'),                                   // 他園 → 数えない
  { id: 'J6', gardenId: 'factory', salon: 'temp', name: '一時', date: '2026-07-10', start: '10:00', end: '11:00', fromBoard: true },   // 一時預かり → 数えない
  ext('A1', '2026-08-05', 'ext_am', '生徒A'),                                                   // 窓内（写しにある）
];
const LIVE = [ext('A1', '2026-08-05', 'ext_am', '生徒A')];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.clock.install({ time: new Date(NOW) });
  await page.addInitScript((seed) => { localStorage.setItem('timely_school_data_v1', JSON.stringify(seed)); },
    { customers: [], visits: [], students: [], reservations: [], settings: { branch: BRANCH, staff: ['テスト'] } });
  await page.goto(FILE);
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
  await page.evaluate((c) => { window.__cloud = { sf_bookings: c }; window.__csv = []; window.downloadCsv = (fn, rows) => { window.__csv.push({ fn, rows }); }; }, CLOUD);
  await page.evaluate((rows) => { window.__emit('sf_bookings', rows, false); window.__emit('sf_customers', [], false); window.__emit('sf_visits', [], false); window.__emit('sf_students', [], false); }, LIVE);
  await page.waitForTimeout(30);

  const pre = await page.evaluate(() => ({ win: window.SF_WINDOW_START, mirror: SF_MIRROR.map(r => r.id).join(), res: DATA.reservations.length, fn: typeof sfArchiveEnsureTl }));
  check('precondition: window=2026-08-01, mirror A1, no reservations (youchisha ext excluded), helper defined', pre.win === '2026-08-01' && pre.mirror === 'A1' && pre.res === 0 && pre.fn === 'function', JSON.stringify(pre));

  // 窓内の日報：getDocs なし、8/5 の早朝 1
  let r = await page.evaluate(() => { document.getElementById('reportDate').value = '2026-08-05'; renderDailyReport(); return { g: window.__fs.calls.filter(c => c[0] === 'getDocs').length, kc: sfKinderCountsForDate(DATA.settings.branch, '2026-08-05') }; });
  check('in-window daily 8/5: no getDocs, morning=1', r.g === 0 && r.kc.morning === 1 && r.kc.extension === 0 && r.kc.unique === 1, JSON.stringify(r));

  // 過去月の日報：1回読む → 描き直しで件数が出る
  r = await page.evaluate(async () => {
    document.getElementById('reportDate').value = '2026-07-10';
    renderDailyReport();
    const first = sfKinderCountsForDate(DATA.settings.branch, '2026-07-10');
    await new Promise(res => setTimeout(res, 40));
    const after = sfKinderCountsForDate(DATA.settings.branch, '2026-07-10');
    const html = document.getElementById('dailyReportBody').innerHTML;
    return { calls: window.__fs.calls.filter(c => c[0] === 'getDocs').map(c => c[2]), first, after, st: SF_ARCHIVE_TL_STATE['2026-07'], n: (SF_ARCHIVE_TL['2026-07'] || []).length,
      hasNote: /予約管理ボードの予約数で集計/.test(html), mirror: SF_MIRROR.map(x => x.id).join(), res: DATA.reservations.length };
  });
  check('past daily 7/10: one getDocs (Jul range), counts 0 before load → morning=2 extension=1 unique=2 after, note rendered, mirror/reservations untouched',
    r.calls.length === 1 && r.calls[0] === 'date>=2026-07-01&date<=2026-07-31' && r.first.morning === 0 && r.after.morning === 2 && r.after.extension === 1 && r.after.unique === 2
    && r.st === 'loaded' && r.n === 6 && r.hasNote && r.mirror === 'A1' && r.res === 0, JSON.stringify(r));

  // 区分別CSV（日報）：同じ数
  r = await page.evaluate(() => { window.__csv = []; downloadDailyZoneCsv(); const rows = window.__csv[0].rows; return { fn: window.__csv[0].fn, rows: rows.map(x => x.join(',')) }; });
  const rowOf = (rows, key) => rows.find(x => x.indexOf(key) === 0) || '';
  check('daily zone CSV 7/10: morning row count 2, extension row count 1', /2026-07-10/.test(r.fn) && /,2,/.test(rowOf(r.rows, '自園生徒・早朝')) && /,1,/.test(rowOf(r.rows, '自園生徒・延長')), JSON.stringify(r.rows));

  // 過去月の月報：同じ月はキャッシュ（getDocs 増えない）
  r = await page.evaluate(async () => {
    document.getElementById('reportMonth').value = '2026-07';
    renderMonthlyReport();
    await new Promise(res => setTimeout(res, 30));
    const kc = sfKinderCountsForMonth(DATA.settings.branch, 2026, 7);
    window.__csv = []; downloadMonthlyZoneCsv();
    return { g: window.__fs.calls.filter(c => c[0] === 'getDocs').length, kc, rows: window.__csv[0].rows.map(x => x.join(',')), fn: window.__csv[0].fn };
  });
  check('past monthly 2026-07: cached (still 1 getDocs), morning=2 extension=2 unique=3, monthly zone CSV matches', r.g === 1 && r.kc.morning === 2 && r.kc.extension === 2 && r.kc.unique === 3 && /2026-07/.test(r.fn)
    && /,2,/.test(rowOf(r.rows, '自園生徒・早朝')) && /,2,/.test(rowOf(r.rows, '自園生徒・延長')), JSON.stringify(r));

  // 別の過去月 → もう1回だけ
  r = await page.evaluate(async () => { document.getElementById('reportMonth').value = '2026-06'; renderMonthlyReport(); await new Promise(res => setTimeout(res, 30)); return { calls: window.__fs.calls.filter(c => c[0] === 'getDocs').map(c => c[2]), kc: sfKinderCountsForMonth(DATA.settings.branch, 2026, 6) }; });
  check('another past month 2026-06: one more getDocs, counts 0', r.calls.length === 2 && r.calls[1] === 'date>=2026-06-01&date<=2026-06-31' && r.kc.morning === 0, JSON.stringify(r));

  // 窓内の月報：getDocs 増えない
  r = await page.evaluate(async () => { document.getElementById('reportMonth').value = '2026-08'; renderMonthlyReport(); await new Promise(res => setTimeout(res, 20)); return { g: window.__fs.calls.filter(c => c[0] === 'getDocs').length, kc: sfKinderCountsForMonth(DATA.settings.branch, 2026, 8) }; });
  check('in-window monthly 2026-08: no extra getDocs, morning=1', r.g === 2 && r.kc.morning === 1, JSON.stringify(r));

  // 読み込み失敗 → toast、state=error、次の描画で再試行
  r = await page.evaluate(async () => {
    window.__cloudFail = true; window.__toasts = []; const _t = window.toast; window.toast = (m, e) => { window.__toasts.push(m); };
    document.getElementById('reportMonth').value = '2026-05'; renderMonthlyReport(); await new Promise(res => setTimeout(res, 30));
    const st1 = SF_ARCHIVE_TL_STATE['2026-05'];
    window.__cloudFail = false; delete SF_ARCHIVE_TL_STATE['2026-05']; renderMonthlyReport(); await new Promise(res => setTimeout(res, 30));
    window.toast = _t;
    return { st1, st2: SF_ARCHIVE_TL_STATE['2026-05'], toasts: window.__toasts.length };
  });
  check('fetch failure: state=error with toast; retry loads', r.st1 === 'error' && r.toasts === 1 && r.st2 === 'loaded', JSON.stringify(r));

  const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
  check('no page errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
  await ctx.close(); await browser.close();
  console.log(fails ? ('\nFAILED: ' + fails) : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
