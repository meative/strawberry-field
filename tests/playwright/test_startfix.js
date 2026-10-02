// SF-EXTFEE19-STARTFIX-20261002 : ボードの早朝予約（ext_am）の start が 08:00 以降でも、
// ワンタップ受付で作る visit が「08:15〜08:00」と逆転しないこと・金額が ¥700 のままであることを検証する。
// 2026-09-14 月寒で実発生（予約 08:15〜08:30 → visit 08:15〜08:00）。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILE = 'file://' + path.join(APPS, 'timely.html');
const BRANCH = '月寒園';

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (!ok) fails++;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.addInitScript((seed) => {
    localStorage.setItem('timely_school_data_v1', JSON.stringify(seed));
    localStorage.setItem('timely_school_branch_v1', seed.settings.branch);
  }, { customers: [], visits: [], students: [], settings: { branch: BRANCH, staff: ['テスト'] }, reservations: [] });
  await page.goto(FILE);
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
  const today = await page.evaluate(() => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); });

  // 早朝予約2件（逆転を起こす 08:15 と、正常系の 07:30）＋延長1件（従来どおりの対照）
  const bookings = [
    { id: 'board_ext1', gardenId: 'tsukisamu', date: today, start: '08:15', end: '08:30',
      salon: 'ext_am', affiliation: 'youchisha', name: 'テスト タロウ', kana: '', fromBoard: true, provisional: false },
    { id: 'board_ext2', gardenId: 'tsukisamu', date: today, start: '07:30', end: '08:00',
      salon: 'ext_am', affiliation: 'youchisha', name: 'テスト ジロウ', kana: '', fromBoard: true, provisional: false },
    { id: 'board_ext3', gardenId: 'tsukisamu', date: today, start: '16:30', end: '17:30',
      salon: 'ext_pm', affiliation: 'youchisha', name: 'テスト サブロウ', kana: '', fromBoard: true, provisional: false },
  ];
  await page.evaluate((rows) => {
    window.__emit('sf_customers', [], false); window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false); window.__emit('sf_bookings', rows, false);
  }, bookings);
  await page.waitForFunction(() => (sfLoadShared() || []).some(r => r.id === 'board_ext1'), null, { timeout: 5000 });

  // [1] 逆転する早朝予約（08:15〜08:30）をワンタップ受付
  const r1 = await page.evaluate(() => {
    sfKinderTapIn('board_ext1');
    const v = (DATA.visits || []).find(x => x.sfId === 'board_ext1') || null;
    if (!v) return { v: null };
    const amt = calcInternalAmount('morning', v.visitStart, v.visitEnd, v);
    return { v: { start: v.visitStart, end: v.visitEnd, usage: v.usageType }, total: amt.total,
             inverted: timeToMinutes(v.visitStart) >= timeToMinutes(v.visitEnd) };
  });
  check('ext_am 08:15-08:30 -> visit が作られる', !!r1.v, JSON.stringify(r1));
  check('visit が逆転しない（start < end）', r1.v && !r1.inverted, r1.v && (r1.v.start + '-' + r1.v.end));
  check('start は既定開始 07:00 に落ちる・end は 08:00 固定', r1.v && r1.v.start === '07:00' && r1.v.end === '08:00', r1.v && (r1.v.start + '-' + r1.v.end));
  check('金額は ¥700 のまま', r1.total === 700, 'total=' + r1.total);

  // [2] 正常系の早朝予約（07:30〜08:00）は従来どおり予約の start を使う
  const r2 = await page.evaluate(() => {
    sfKinderTapIn('board_ext2');
    const v = (DATA.visits || []).find(x => x.sfId === 'board_ext2') || null;
    return v ? { start: v.visitStart, end: v.visitEnd, total: calcInternalAmount('morning', v.visitStart, v.visitEnd, v).total } : null;
  });
  check('ext_am 07:30-08:00 は 07:30〜08:00 のまま・¥700', !!r2 && r2.start === '07:30' && r2.end === '08:00' && r2.total === 700, JSON.stringify(r2));

  // [3] 延長（ext_pm）は従来どおり固定の 19:00〜20:00（予約時刻は使わない）
  const r3 = await page.evaluate(() => {
    sfKinderTapIn('board_ext3');
    const v = (DATA.visits || []).find(x => x.sfId === 'board_ext3') || null;
    return v ? { start: v.visitStart, end: v.visitEnd, usage: v.usageType,
                 inverted: timeToMinutes(v.visitStart) >= timeToMinutes(v.visitEnd) } : null;
  });
  check('ext_pm は固定 19:00〜20:00・逆転なし', !!r3 && r3.start === '19:00' && r3.end === '20:00' && r3.usage === 'extension' && !r3.inverted, JSON.stringify(r3));

  // [4] 二重受付防止（同じ sfId はもう一度押しても増えない）は従来どおり
  const r4 = await page.evaluate(() => {
    const before = DATA.visits.length;
    sfKinderTapIn('board_ext1');
    return { before, after: DATA.visits.length };
  });
  check('同じ予約の二重タップで visit が増えない', r4.before === r4.after, JSON.stringify(r4));

  check('pageerror なし', errors.length === 0, errors.join(' | ').slice(0, 200));

  await browser.close();
  console.log(fails ? ('FAILED: ' + fails) : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
