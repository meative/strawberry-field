// tests/board/test_board.js
// board.html の「園切替」「延長保育の時間帯解放」ロジックを JSDOM で検証する。
// 実行: cd tests && node board/test_board.js   （要 jsdom: npm i -D jsdom）
//
// 注意（CLAUDE.md 準拠）:
//  - <script> は丸ごと JSDOM(runScripts:'dangerously') で実行する
//  - localStorage / AudioContext / alert などはモック
//  - CURRENT_GARDEN・GARDENS・SLOTS は const/let で window に出ないため、
//    window 関数（isSlotOpen/isExtPaid/gardenName/switchGarden）と DOM・localStorage 経由で検証する

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', '..', 'apps', 'board.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// SLOTS は 7:00〜19:45 を15分刻み。時刻→index 換算（START_HOUR=7, SLOT_MIN=15）。
function idxOf(t) {
  const [h, m] = t.split(':').map(Number);
  return ((h - 7) * 60 + m) / 15;
}

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  OK  ' + label); }
  else { fail++; console.log('  NG  ' + label); }
}

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/',
  beforeParse(window) {
    // 音・タイマー・alert のモック（描画初期化で参照されても落ちないように）
    window.AudioContext = window.webkitAudioContext = function () {
      return { createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: {} }),
               createGain: () => ({ connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }),
               destination: {}, currentTime: 0, close() {} };
    };
    window.alert = () => {};
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  },
});

const w = dom.window;

function run() {
  // --- ② 延長保育: 利用可能時間帯（isSlotOpen） ---
  const openCases = [
    ['07:00', true], ['08:00', true], ['08:15', true], ['08:30', false],
    ['15:00', false], ['16:15', false], ['16:30', true], ['19:45', true],
  ];
  openCases.forEach(([t, exp]) =>
    ok(w.isSlotOpen('ext', idxOf(t)) === exp, `isSlotOpen ext ${t} => ${exp}`));
  ok(w.isSlotOpen('temp', idxOf('10:00')) === true, 'isSlotOpen temp 10:00 => true（常に開放）');

  // --- ② 延長保育: 有料/無料の判定（isExtPaid） ---
  const paidCases = [
    ['07:00', true], ['07:45', true], ['08:00', false],
    ['18:45', false], ['19:00', true], ['19:45', true],
  ];
  paidCases.forEach(([t, exp]) =>
    ok(w.isExtPaid(t) === exp, `isExtPaid ${t} => ${exp}`));

  // --- ① 園切替: 3園が有効・名称 ---
  ok(w.gardenName('tsukisamu') === '月寒園', 'gardenName tsukisamu => 月寒園');
  ok(w.gardenName('shiraishi') === '白石園', 'gardenName shiraishi => 白石園');
  ok(w.gardenName('factory') === 'サッポロファクトリー園', 'gardenName factory => サッポロファクトリー園');
  ok(w.normGarden('') === 'tsukisamu', 'normGarden 空 => 月寒園(tsukisamu)');
  ok(w.normGarden('shiraishi') === 'shiraishi', 'normGarden shiraishi => そのまま');

  // 切替UIに3園ぶんのボタンが描画される
  const btns = w.document.querySelectorAll('#gardenSeg .g-btn');
  ok(btns.length === 3, `園切替ボタンが3つ描画される（実際: ${btns.length}）`);

  // --- ① 園切替: 切替で保存・ラベル更新 ---
  w.switchGarden('shiraishi');
  ok(w.localStorage.getItem('sf_board_garden_v1') === 'shiraishi', '切替で localStorage に園が保存される');
  ok(w.document.getElementById('gardenLabel').textContent === '白石園', 'ヘッダのラベルが白石園に更新される');
  const activeBtn = w.document.querySelector('#gardenSeg .g-btn.active');
  ok(activeBtn && activeBtn.textContent.indexOf('白石園') >= 0, '白石園のタブが active になる');

  console.log(`\n=== board.html: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

// スクリプト実行（init）完了後に検証
if (w.document.readyState === 'complete') run();
else w.addEventListener('load', run);
