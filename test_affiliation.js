// test_affiliation.js — フェーズ2（所属=affiliation バッジ機能）のテスト
//
// 検証内容：
//   1. affiliation のバッジ判定ロジック（'youchisha' のときだけバッジ／後方互換）
//   2. 「通常所属＝利用園のgardenId」の値設計
//   3. board.html にバッジ描画・CSS・入力トグル・保存/復元の配線が入っている
//   4. timely.html に受付トグル・予約への affiliation 付与・board取込での引き継ぎが入っている
//
// 実行: node test_affiliation.js
// ※ node 未導入環境では osascript -l JavaScript で同等ロジックを確認済み（ALL PASS）

const fs = require('fs');
const path = require('path');
const boardSrc  = fs.readFileSync(path.join(__dirname, 'apps/board.html'), 'utf8');
const timelySrc = fs.readFileSync(path.join(__dirname, 'apps/timely.html'), 'utf8');

let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? 'OK' : 'NG'}  ${label}`);
  if (!cond) failures++;
}

// --- [1] バッジ判定ロジック（board の描画条件と同一） ---
console.log('[1] バッジ判定: affiliation==="youchisha" のときだけ表示');
const showBadge = b => (b.affiliation === 'youchisha');
check('youchisha → バッジあり', showBadge({ affiliation: 'youchisha' }) === true);
check('通常(tsukisamu) → バッジなし', showBadge({ affiliation: 'tsukisamu' }) === false);
check('通常(factory) → バッジなし', showBadge({ affiliation: 'factory' }) === false);
check('affiliation 未設定（既存予約）→ バッジなし（後方互換）', showBadge({}) === false);
check('affiliation=null → バッジなし', showBadge({ affiliation: null }) === false);

// --- [2] 値設計: 通常所属は利用園の gardenId、幼稚舎所属だけ 'youchisha' ---
console.log('[2] 保存時の affiliation 値設計');
const GARDEN_BRANCH = { tsukisamu:'月寒園', shiraishi:'白石園', factory:'サッポロファクトリー園', shiseikan:'資生館園' };
const BRANCH_GARDEN = Object.fromEntries(Object.entries(GARDEN_BRANCH).map(([g,n])=>[n,g]));
const branchToGardenId = b => (b==null||b==='') ? 'tsukisamu' : (BRANCH_GARDEN[b]||null);
const calcAffil = (youchisha, branch) => youchisha ? 'youchisha' : branchToGardenId(branch);
check('幼稚舎ON（月寒園）→ youchisha', calcAffil(true,  '月寒園') === 'youchisha');
check('通常OFF（月寒園）→ tsukisamu', calcAffil(false, '月寒園') === 'tsukisamu');
check('通常OFF（資生館園）→ shiseikan', calcAffil(false, '資生館園') === 'shiseikan');
check('幼稚舎ON（資生館園）→ youchisha', calcAffil(true, '資生館園') === 'youchisha');
// バッジは利用園に依らず youchisha のときだけ → 4園すべてで確認
['月寒園','白石園','サッポロファクトリー園','資生館園'].forEach(b => {
  check(`${b}: 通常はバッジなし`, showBadge({ affiliation: calcAffil(false, b) }) === false);
  check(`${b}: 幼稚舎はバッジあり`, showBadge({ affiliation: calcAffil(true, b) }) === true);
});

// --- [3] board.html の配線 ---
console.log('[3] board.html の配線');
check('バッジ描画コード', /b\.affiliation === 'youchisha'.*affil-badge/s.test(boardSrc));
check('バッジCSS .affil-badge', /\.affil-badge\s*\{/.test(boardSrc));
check('入力トグル #mYouchisha', /id="mYouchisha"/.test(boardSrc));
check('新規nbに affiliation', /const nb = \{[\s\S]*?affiliation:/.test(boardSrc));
check('共有保存 sfWriteNew に affiliation', /affiliation: b\.affiliation \|\| CURRENT_GARDEN/.test(boardSrc));
check('共有復元 rehydrate に affiliation', /affiliation: r\.affiliation \}\)/.test(boardSrc));

// --- [4] timely.html の配線 ---
console.log('[4] timely.html の配線');
check('受付トグル #resYouchisha', /id="resYouchisha"/.test(timelySrc));
check('新規予約 push に affiliation', /affiliation: youchisha \? 'youchisha' : branchToGardenId\(branch\)/.test(timelySrc));
check('board取込で affiliation 引き継ぎ', /affiliation: r\.affiliation \|\| branchToGardenId\(branch\)/.test(timelySrc));
check('編集opener でトグル復元', /resYouchisha'\)\.checked = \(reservation\.affiliation === 'youchisha'\)/.test(timelySrc));

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `FAIL: ${failures} 件`);
process.exit(failures === 0 ? 0 : 1);
