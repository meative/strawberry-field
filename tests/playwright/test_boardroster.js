// SF-BOARDROSTER-20261022 : ボード「予約を追加」の氏名候補を sf_roster につないだ検証（board 5本）。
//   1) 名簿受信前は「名簿を同期中です」（未受信と0件の区別）
//   2) sf_roster/all 受信で REGISTERED が埋まり、五十音索引・行絞り込みが機能する
//   3) 入力の予測候補（onNameInput・ひらがな→カタカナ照合）
//   4) 候補の選択で氏名＋実生年月がセットされる（生年月の無い名簿行は未選択のまま）
//   5) 実生年月からの年齢表示（丸め年齢の廃止）
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');

const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILES = ['board.html', 'board_sp_tsukisamu.html', 'board_sp_shiraishi.html', 'board_sp_factory.html', 'board_sp_shiseikan.html'];

const ITEMS = [
  { id: 'C1', name: '森 はると', kana: 'モリ ハルト', birthY: 2024, birthM: 5, branch: '月寒園' },
  { id: 'C2', name: '高嶋 テスト', kana: 'タカシマ テスト', birthY: 2021, birthM: 1, branch: '月寒園' },
  { id: 'C3', name: '鈴木', kana: 'すずき', birthY: null, birthM: null, branch: '月寒園' },
];

let fails = 0;
function check(file, name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + file + ' : ' + name + (extra ? '  [' + String(extra).slice(0, 220) + ']' : ''));
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
    await page.clock.install({ time: new Date('2026-10-22T10:00:00+09:00') });
    await page.goto('file://' + path.join(APPS, file));
    await page.waitForFunction(() => window.__fs && window.__fs.listeners.some(l => l.name === 'sf_roster'), null, { timeout: 15000 });
    await page.evaluate(() => window.__emit('sf_bookings', [], false));

    // [1] 受信前：同期中の案内（0件とは区別）
    let r = await page.evaluate(() => {
      filterByKana('ア');
      return { msg: document.getElementById('kanaResult').textContent, loaded: ROSTER_LOADED, n: REGISTERED.length };
    });
    check(file, '[1] 受信前は「名簿を同期中です」', !r.loaded && r.n === 0 && r.msg.indexOf('名簿を同期中です') >= 0, JSON.stringify(r));

    // [2] sf_roster/all 受信 → 索引・行絞り込み
    r = await page.evaluate((items) => {
      window.__emit('sf_roster', [{ id: 'all', items: items, count: items.length }], false);
      filterByKana('マ');
      const ma = document.getElementById('kanaResult').textContent;
      filterByKana('サ');
      const sa = document.getElementById('kanaResult').textContent;
      filterByKana('ア');
      const a = document.getElementById('kanaResult').textContent;
      const idx = document.getElementById('kanaIndex');
      const emptyRows = idx ? idx.querySelectorAll('.kana-btn.is-empty').length : -1;
      return { loaded: ROSTER_LOADED, n: REGISTERED.length, ma, sa, a, emptyRows };
    }, ITEMS);
    check(file, '[2] 名簿受信で 3名・マ行=森・サ行=鈴木（かな正規化）・ア行は本当の0件表示',
      r.loaded && r.n === 3 && r.ma.indexOf('森 はると') >= 0 && r.sa.indexOf('鈴木') >= 0
      && r.a.indexOf('この行に登録者はいません') >= 0 && r.emptyRows === 7, JSON.stringify({ n: r.n, emptyRows: r.emptyRows }));
    check(file, '[5] 実生年月からの年齢表示（2024/5生→2歳）', r.ma.indexOf('2歳') >= 0, r.ma.slice(0, 80));

    // [3] 入力の予測候補（ひらがな入力 → カタカナ名簿に一致）
    r = await page.evaluate(() => {
      document.getElementById('mName').value = 'もり';
      onNameInput();
      const box = document.getElementById('nameSuggest');
      return { shown: box.classList.contains('show'), text: box.textContent };
    });
    check(file, '[3] 「もり」で予測候補に森が出る', r.shown && r.text.indexOf('森 はると') >= 0, r.text.slice(0, 60));

    // [4] 候補の選択 → 氏名＋実生年月（無い行は未選択のまま）
    r = await page.evaluate(() => {
      buildBirthSelectors();
      pickCustomer('C1');
      const a = { name: document.getElementById('mName').value,
                  by: document.getElementById('mBirthYear').value, bm: document.getElementById('mBirthMonth').value,
                  suggestClosed: !document.getElementById('nameSuggest').classList.contains('show') };
      pickCustomer('C3');
      const b = { name: document.getElementById('mName').value,
                  by: document.getElementById('mBirthYear').value, bm: document.getElementById('mBirthMonth').value };
      pickCustomer('CX');   // 名簿に無い id は何もしない
      const c = { name: document.getElementById('mName').value };
      return { a, b, c };
    });
    check(file, '[4] 選択で氏名＋実生年月（2024/5）をセット・候補は閉じる',
      r.a.name === '森 はると' && r.a.by === '2024' && r.a.bm === '5' && r.a.suggestClosed, JSON.stringify(r.a));
    check(file, '[4] 生年月の無い行は未選択に戻す／無い id は何もしない',
      r.b.name === '鈴木' && r.b.by === '' && r.b.bm === '' && r.c.name === '鈴木', JSON.stringify(r.b));

    const relevant = errors.filter(e => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));
    check(file, 'no page errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
    await ctx.close();
  }
  await browser.close();
  console.log(fails ? ('\nFAILED: ' + fails) : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
