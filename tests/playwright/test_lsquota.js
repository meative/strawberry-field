// SF-LSQUOTA-20261007 : iPad の localStorage 上限超過（署名画像で約4.8MB）で saveData が
// 失敗すると、クラウド送信までスキップされて会計・受付が消えていた（10/5 資生館・10/6-7 月寒）。
// ここでは
//   (1) localStorage.setItem が QuotaExceeded でも visit がクラウドへ送られること
//   (2) localStorage の写しに customers[].signature が含まれないこと（メモリには残る）
//   (3) 起動時に _premig_20260722 が削除されること
//   (4) QuotaExceeded 時に premig を削除して再試行し、成功したら赤い帯が消えること
//   (5) tlMergeByVersion が手元優先時にクラウドの署名を移植すること
// を検証する。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILE = 'file://' + path.join(APPS, 'timely.html');
const BRANCH = '月寒園';
const PREMIG = 'timely_school_data_v1_premig_20260722';

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
    localStorage.setItem('timely_school_data_v1', JSON.stringify(seed.data));
    localStorage.setItem('timely_school_branch_v1', seed.data.settings.branch);
    // 移行前退避が残っている端末を再現（起動時に消えるはず）
    localStorage.setItem(seed.premig, JSON.stringify(seed.data));
  }, { premig: PREMIG, data: { customers: [], visits: [], students: [], settings: { branch: BRANCH, staff: ['テスト'] }, reservations: [] } });
  await page.goto(FILE);
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_bookings'), null, { timeout: 15000 });
  const today = await page.evaluate(() => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); });

  // [1] 起動時に _premig_20260722 が削除される
  const r1 = await page.evaluate((k) => localStorage.getItem(k), PREMIG);
  check('起動時に _premig_20260722 が削除される', r1 === null, 'premig=' + (r1 ? r1.length + 'chars' : 'null'));

  // クラウドの初回スナップショット（署名つき顧客1名・予約1件）
  const customer = { id: 'C_sig1', branch: BRANCH, childName: 'テスト ハナコ', childKana: 'テスト ハナコ',
    birthY: 2024, birthM: 4, birthD: 1, parentName: 'テスト ママ', parentTel: '09000000001',
    signature: 'data:image/png;base64,' + 'A'.repeat(30000), createdAt: '2026-10-01T00:00:00.000Z' };
  const bookings = [
    { id: 'bk_ext1', gardenId: 'tsukisamu', date: today, start: '16:30', end: '17:30',
      salon: 'ext_pm', affiliation: 'youchisha', name: 'テスト タロウ', kana: '', fromBoard: true, provisional: false },
  ];
  await page.evaluate((o) => {
    window.__emit('sf_customers', o.customers, false); window.__emit('sf_visits', [], false);
    window.__emit('sf_students', [], false); window.__emit('sf_bookings', o.bookings, false);
  }, { customers: [customer], bookings });
  await page.waitForFunction(() => (sfLoadShared() || []).some(r => r.id === 'bk_ext1'), null, { timeout: 5000 });

  // [2] localStorage の写しに signature が無い・メモリには残る
  const r2 = await page.evaluate(() => {
    const raw = localStorage.getItem('timely_school_data_v1');
    const stored = JSON.parse(raw);
    const mem = (DATA.customers || []).find(c => c.id === 'C_sig1');
    return {
      storedHasSig: (stored.customers || []).some(c => 'signature' in c),
      rawHasDataUrl: raw.indexOf('data:image/png') >= 0,
      memSigLen: mem && mem.signature ? mem.signature.length : 0,
    };
  });
  check('localStorage の customers に signature キーが無い', r2.storedHasSig === false);
  check('localStorage に署名の dataURL が含まれない', r2.rawHasDataUrl === false);
  check('メモリ上の DATA.customers には署名が残る', r2.memSigLen > 30000, 'len=' + r2.memSigLen);

  // localStorage.setItem を QuotaExceeded にモック（__lsFull が真の間だけ失敗）
  await page.evaluate(() => {
    window.__origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (window.__lsFull) throw new DOMException('quota exceeded (test)', 'QuotaExceededError');
      return window.__origSetItem.call(this, k, v);
    };
  });

  // [3] QuotaExceeded でも visit はクラウドへ送られる（ワンタップ受付）
  const r3 = await page.evaluate(() => {
    window.__lsFull = true;
    window.__fs.writes.length = 0;
    sfKinderTapIn('bk_ext1');
    const v = (DATA.visits || []).find(x => x.sfId === 'bk_ext1') || null;
    const sent = window.__fs.writes.filter(w => w.op === 'set' && w.path.indexOf('sf_visits/') === 0);
    const bar = document.getElementById('sfLsQuotaBar');
    return {
      visitKept: !!v, visitId: v && v.id,
      sentIds: sent.map(w => w.data && w.data.id),
      barShown: !!(bar && bar.style.display !== 'none'),
      barText: bar ? bar.textContent : '',
    };
  });
  check('QuotaExceeded でも visit が DATA に残る（pop されない）', r3.visitKept);
  check('QuotaExceeded でも visit がクラウドへ送られる', r3.visitId && r3.sentIds.indexOf(r3.visitId) >= 0, JSON.stringify(r3.sentIds));
  check('赤い帯「この端末の保存領域がいっぱいです」が出る', r3.barShown && r3.barText.indexOf('この端末の保存領域がいっぱいです') >= 0);

  // [4] QuotaExceeded でも会計の更新（paid）がクラウドへ送られる
  const r4 = await page.evaluate(() => {
    window.__fs.writes.length = 0;
    const v = (DATA.visits || []).find(x => x.sfId === 'bk_ext1');
    v.paymentStatus = 'paid';
    v.paidAt = new Date().toISOString();
    v.updatedAt = new Date().toISOString();
    v.totalAmount = 700;
    saveData(DATA);
    const sent = window.__fs.writes.filter(w => w.op === 'set' && w.path === 'sf_visits/' + v.id);
    return { sent: sent.length, paid: sent.length ? sent[0].data.paymentStatus : null };
  });
  check('QuotaExceeded でも会計済み(paid)の更新がクラウドへ送られる', r4.sent >= 1 && r4.paid === 'paid', JSON.stringify(r4));

  // [5] premig が残っている端末では、QuotaExceeded → premig 削除 → 再試行で成功し、帯が消える
  const r5 = await page.evaluate((premig) => {
    window.__lsFull = false;
    window.__origSetItem.call(localStorage, premig, 'x'.repeat(1000));  // premig を復元
    // premig が残っている間だけ失敗するモック（削除後の再試行は成功する）
    Storage.prototype.setItem = function (k, v) {
      if (localStorage.getItem(premig) !== null) throw new DOMException('quota exceeded (test)', 'QuotaExceededError');
      return window.__origSetItem.call(this, k, v);
    };
    const ok = saveDataLocalOnly(DATA);
    const bar = document.getElementById('sfLsQuotaBar');
    return { ok, premigGone: localStorage.getItem(premig) === null,
             barHidden: !bar || bar.style.display === 'none',
             saved: !!localStorage.getItem('timely_school_data_v1') };
  }, PREMIG);
  check('QuotaExceeded 時に premig を削除して再試行 → 保存成功', r5.ok === true && r5.premigGone && r5.saved, JSON.stringify(r5));
  check('保存が成功したら赤い帯が消える', r5.barHidden);

  // [6] tlMergeByVersion：手元優先（新しい）だが署名が無いとき、クラウドの署名を移植する
  const r6 = await page.evaluate(() => {
    const local = [{ id: 'C_m1', childName: 'テスト', updatedAt: '2026-10-07T10:00:00.000Z' }];
    const cloud = [{ id: 'C_m1', childName: 'テスト', updatedAt: '2026-10-07T09:00:00.000Z', signature: 'data:image/png;base64,SIG' }];
    const mg = tlMergeByVersion('customers', local, cloud);
    return { win: mg.localWins.length, sig: mg.rows[0] && mg.rows[0].signature };
  });
  check('手元優先の customers にクラウドの署名が移植される', r6.win === 1 && r6.sig === 'data:image/png;base64,SIG', JSON.stringify(r6));

  check('pageerror なし', errors.length === 0, errors.join(' | ').slice(0, 200));

  await browser.close();
  console.log(fails ? ('FAILED: ' + fails) : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
