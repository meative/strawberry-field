// test_garden_4.js — 4園化（識別子統一）のテスト
//
// 検証内容（フェーズ1）：
//   1. board.html の GARDENS と timely.html の GARDEN_BRANCH が
//      4園すべてでキー・表示名一致（board を正とする）
//   2. timely の gardenId <-> branch 往復変換が4園で成立し、null にならない
//   3. 「幼稚舎」「資生館保育園」が園定義/branch値として残っていない
//      （幼稚舎は所属=affiliation でフェーズ2扱い。資生館は「資生館園」へ統一）
//
// 実行: node test_garden_4.js
// ※ node 未導入の環境では osascript -l JavaScript で同等ロジックを確認済み（ALL PASS）

const fs = require('fs');
const path = require('path');

const boardSrc  = fs.readFileSync(path.join(__dirname, 'apps/board.html'), 'utf8');
const timelySrc = fs.readFileSync(path.join(__dirname, 'apps/timely.html'), 'utf8');

const EXPECTED = {
  tsukisamu: '月寒園',
  shiraishi: '白石園',
  factory:   'サッポロファクトリー園',
  shiseikan: '資生館園',
};

let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? 'OK' : 'NG'}  ${label}`);
  if (!cond) failures++;
}

// --- board.html の GARDENS を抽出 ---
function parseBoardGardens(src) {
  const block = src.match(/const GARDENS = \{([\s\S]*?)\};/)[1];
  const map = {};
  const re = /(\w+):\s*\{\s*name:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) map[m[1]] = m[2];
  return map;
}

// --- timely.html の GARDEN_BRANCH を抽出 ---
function parseTimelyBranch(src) {
  const block = src.match(/const GARDEN_BRANCH = \{([\s\S]*?)\};/)[1];
  const map = {};
  const re = /(\w+):\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) map[m[1]] = m[2];
  return map;
}

const board  = parseBoardGardens(boardSrc);
const timely = parseTimelyBranch(timelySrc);

console.log('[1] board GARDENS と EXPECTED の一致（4園）');
Object.keys(EXPECTED).forEach(id => {
  check(`board ${id} = ${EXPECTED[id]}`, board[id] === EXPECTED[id]);
});
check('board は4園ちょうど', Object.keys(board).length === 4);

console.log('[2] timely GARDEN_BRANCH と board の一致（board を正）');
Object.keys(EXPECTED).forEach(id => {
  check(`timely ${id} = board ${id}`, timely[id] === board[id]);
});
check('timely は4園ちょうど', Object.keys(timely).length === 4);

console.log('[3] gardenId <-> branch 往復変換（timely 同等ロジック）');
const gardenIdToBranch = gid =>
  (gid == null || gid === '') ? '月寒園' : (timely[gid] || null);
const BRANCH_GARDEN = Object.fromEntries(
  Object.entries(timely).map(([gid, name]) => [name, gid])
);
const branchToGardenId = b =>
  (b == null || b === '') ? 'tsukisamu' : (BRANCH_GARDEN[b] || null);

Object.keys(EXPECTED).forEach(id => {
  const br = gardenIdToBranch(id);
  const back = branchToGardenId(br);
  check(`${id} -> ${br} -> ${back}`, br != null && back === id);
});

console.log('[4] 幼稚舎・資生館保育園 が園定義/branch値として残っていない');
check('timely ドロップダウンに幼稚舎 option なし',
  !/<option value="幼稚舎"/.test(timelySrc));
check('timely ドロップダウンに資生館保育園 option なし',
  !/<option value="資生館保育園"/.test(timelySrc));
check('timely GARDEN_BRANCH に資生館保育園 なし', timely['資生館保育園'] === undefined &&
  !Object.values(timely).includes('資生館保育園'));
check('board GARDENS に幼稚舎 なし', !Object.values(board).includes('幼稚舎'));

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `FAIL: ${failures} 件`);
process.exit(failures === 0 ? 0 : 1);
