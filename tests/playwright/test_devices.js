// SF-DEVICES-20261015 : 版確認と自動リロードの検証（timely で代表。台帳と getDoc は test_fleet が12本で確認済み）。
// [A] 版が一致 → リロードしない
// [B] 版が古い → 自動リロード1回。リロード後も古いままだが「1日1回まで」で2回目はしない
// [C] 本日すでにリロード済み（ガード） → リロードせずログで見送り
// [D] 入力中 → 後回しのログを出し、すぐにはリロードしない
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILE = 'file://' + path.join(APPS, 'timely.html');
// ページに埋まっている版（リリースで SHA に置換されるためソースから読む）
const PAGE_VER = (fs.readFileSync(path.join(APPS, 'timely.html'), 'utf8').match(/const SF_APP_VER = '([^']+)';/) || [])[1];

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  [' + (extra || '') + ']'));
  if (!ok) fails++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function boot(browser, { cloudVer, reloadGuardAt, typing }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const logs = [], errors = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  await page.addInitScript((o) => {
    window.__cloud = { sf_config: [{ id: 'version', ver: o.cloudVer }] };
    try { sessionStorage.setItem('sf_test_loads', String(Number(sessionStorage.getItem('sf_test_loads') || 0) + 1)); } catch (e) {}
    if (o.reloadGuardAt != null) { try { localStorage.setItem('sf_verreload_at_v1', String(o.reloadGuardAt)); } catch (e) {} }
    if (o.typing) {
      // module（版確認）より先に入力中状態を作る：body が現れた瞬間に input を置いて focus する
      const t = setInterval(() => {
        if (!document.body) return;
        clearInterval(t);
        const i = document.createElement('input'); i.id = 'sfTestTyping';
        document.body.appendChild(i); i.focus();
        setInterval(() => { try { i.focus(); } catch (e) {} }, 50);   // アプリ側の描画で focus が外れても維持
      }, 0);
    }
  }, { cloudVer, reloadGuardAt, typing: !!typing });
  await page.goto(FILE);
  return { ctx, page, logs, errors };
}
async function loadCount(page) {
  try { return await page.evaluate(() => Number(sessionStorage.getItem('sf_test_loads') || 0)); }
  catch (e) { return -1; }   // ナビゲーション中
}

(async () => {
  check('ソースから版（SF_APP_VER）を読めた', !!PAGE_VER, String(PAGE_VER));
  const browser = await chromium.launch();

  // [A] 一致 → リロードしない
  const A = await boot(browser, { cloudVer: PAGE_VER });
  await A.page.waitForFunction(() => window.__fs && window.__fs.calls.some(c => c[0] === 'getDoc' && c[1] === 'sf_config/version'), null, { timeout: 15000 });
  await sleep(2000);
  check('[A] 版が一致ならリロードしない', (await loadCount(A.page)) === 1 && !A.logs.some(t => t.indexOf('再読み込みします') >= 0), JSON.stringify(A.logs.filter(t => t.indexOf('DEVICES') >= 0)).slice(0, 160));
  check('[A] pageerror なし', A.errors.length === 0, A.errors.join(' | ').slice(0, 160));
  await A.ctx.close();

  // [B] 古い → 1回だけ自動リロード
  const B = await boot(browser, { cloudVer: 'ver-newer-test' });
  let n = 0;
  for (let i = 0; i < 40; i++) { n = await loadCount(B.page); if (n >= 2) break; await sleep(300); }
  check('[B] 版が古いと自動リロード（load 2回目）', n === 2, 'loads=' + n);
  await sleep(3500);   // 2回目の起動でも版は古いままだが、1日1回ガードで3回目は起きない
  const n2 = await loadCount(B.page);
  const guard = await B.page.evaluate(() => Number(localStorage.getItem('sf_verreload_at_v1') || 0));
  check('[B] 「1日1回まで」で2回目のリロードはしない（ガード刻印あり）', n2 === 2 && guard > 0, 'loads=' + n2 + ' guard=' + guard);
  await B.ctx.close();

  // [C] 本日リロード済みガード → 見送りログ
  const C = await boot(browser, { cloudVer: 'ver-newer-test', reloadGuardAt: Date.now() });
  await C.page.waitForFunction(() => window.__fs && window.__fs.calls.some(c => c[0] === 'getDoc' && c[1] === 'sf_config/version'), null, { timeout: 15000 });
  await sleep(2500);
  check('[C] ガード中はリロードせず「見送り」をログ', (await loadCount(C.page)) === 1 && C.logs.some(t => t.indexOf('本日は再読込済みのため見送り') >= 0),
    JSON.stringify(C.logs.filter(t => t.indexOf('DEVICES') >= 0)).slice(0, 200));
  await C.ctx.close();

  // [D] 入力中 → 後回し（すぐにはリロードしない）
  const D = await boot(browser, { cloudVer: 'ver-newer-test', typing: true });
  await D.page.waitForFunction(() => window.__fs && window.__fs.calls.some(c => c[0] === 'getDoc' && c[1] === 'sf_config/version'), null, { timeout: 15000 });
  await sleep(3000);
  check('[D] 入力中は「後回し」をログし、すぐにはリロードしない',
    (await loadCount(D.page)) === 1 && D.logs.some(t => t.indexOf('入力中のため再読込を後回し') >= 0),
    JSON.stringify(D.logs.filter(t => t.indexOf('DEVICES') >= 0)).slice(0, 200));
  await D.ctx.close();

  await browser.close();
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
