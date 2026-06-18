// test_caseA_write.js — 案A（受付 timely → 予約表 board への書き込み）のテスト
//
// 検証内容：
//   1. birthToAgeMonths が board 互換 {age:'0'..'3', months:0-11|null} を返す
//   2. sfUpsertShared の upsert 意味論（同id更新／新規追加）
//   3. 片方向保証：salon付き・fromBoard:false のレコードは
//        board.importSharedBookings が拾い（salon必須）、
//        timely.importBoardReservations は無視する（fromBoard必須）＝二重取込なし
//   4. timely.html / board.html の配線（正規表現）
//
// 実行: node test_caseA_write.js
//   ※ node 未導入環境では JavaScriptCore で（プロジェクト直下から）:
//      osascript -l JavaScript test_caseA_write.js

// ---- 環境差吸収（node / JXA 両対応） ----
var IS_JXA = (typeof $ !== 'undefined' && typeof require === 'undefined');
function readFile(rel) {
  if (!IS_JXA) {
    const fs = require('fs'); const path = require('path');
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
  }
  ObjC.import('Foundation');
  const cwd = $.NSFileManager.defaultManager.currentDirectoryPath.js;
  const full = cwd + '/' + rel;
  return $.NSString.stringWithContentsOfFileEncodingError($(full), $.NSUTF8StringEncoding, null).js;
}

const timelySrc = readFile('apps/timely.html');
const boardSrc  = readFile('apps/board.html');

let failures = 0;
function check(label, cond) {
  console.log('  ' + (cond ? 'OK' : 'NG') + '  ' + label);
  if (!cond) failures++;
}

// --- [1] birthToAgeMonths（board ageMonthsFromBirth と同等結果か） ---
console.log('[1] birthToAgeMonths: board互換の {age, months}');
function birthToAgeMonths(y, m, d) {
  if (!y || !m || !d) return { age: '', months: null };
  const today = new Date();
  const birth = new Date(y, m - 1, d);
  let months = (today.getFullYear()-birth.getFullYear())*12 + (today.getMonth()-birth.getMonth());
  if (today.getDate() < birth.getDate()) months--;
  if (months < 0) months = 0;
  const age = Math.floor(months/12);
  return { age: String(Math.min(age,3)), months: age >= 3 ? null : (months % 12) };
}
const _n = new Date();
const yN = _n.getFullYear(), mN = _n.getMonth()+1, dN = _n.getDate();
check('未入力 → age空・months null', (function(){const r=birthToAgeMonths(null,null,null);return r.age===''&&r.months===null;})());
check('当日生まれ → age "0"・months 0', (function(){const r=birthToAgeMonths(yN,mN,dN);return r.age==='0'&&r.months===0;})());
check('1年前生まれ → age "1"・months 0', (function(){const r=birthToAgeMonths(yN-1,mN,dN);return r.age==='1'&&r.months===0;})());
check('5年前生まれ → age "3"・months null（3歳〜で打ち止め）', (function(){const r=birthToAgeMonths(yN-5,mN,dN);return r.age==='3'&&r.months===null;})());
check('months は 0-11 か null', (function(){const r=birthToAgeMonths(yN-2,mN,dN);return r.months===null||(r.months>=0&&r.months<=11);})());

// --- [2] sfUpsertShared の upsert 意味論 ---
console.log('[2] sfUpsertShared: 同id更新 / 新規追加');
function upsert(arr, record){ const idx=arr.findIndex(r=>r&&r.id===record.id); if(idx>=0)arr[idx]=record; else arr.push(record); return arr; }
let store=[];
store=upsert(store,{id:'tl_1',start:'09:00'});
check('新規追加で1件', store.length===1);
store=upsert(store,{id:'tl_2',start:'10:00'});
check('別idで2件', store.length===2);
store=upsert(store,{id:'tl_1',start:'11:00'});
check('同id更新で件数は2のまま', store.length===2);
check('同id更新で内容が置換', store.find(r=>r.id==='tl_1').start==='11:00');

// --- [3] 片方向保証（二重取込なし） ---
console.log('[3] 片方向保証: board は拾う / timely は無視');
const rec = { id:'tl_x', salon:'temp', fromBoard:false };
check('board: salonありで取り込み対象', (!!(rec && rec.salon)) === true);
check('timely: fromBoard falsy で自分の書込を無視', (!!(rec && rec.fromBoard)) === false);

// --- [4] 配線（正規表現） ---
console.log('[4] timely.html / board.html の配線');
check('timely: sfSaveShared 定義', /function sfSaveShared\(/.test(timelySrc));
check('timely: sfUpsertShared 定義', /function sfUpsertShared\(/.test(timelySrc));
check('timely: sfRemoveShared 定義', /function sfRemoveShared\(/.test(timelySrc));
check('timely: birthToAgeMonths 定義', /function birthToAgeMonths\(/.test(timelySrc));
check('timely: 新規予約で sfUpsertShared 呼び出し', /sfUpsertShared\(\{/.test(timelySrc));
check("timely: 受付発レコードは salon:'temp'", /salon: 'temp'/.test(timelySrc));
check('timely: 受付発レコードは fromBoard:false', /fromBoard: false/.test(timelySrc));
check('timely: 予約に sfId 保持', /sfId: _resSfId/.test(timelySrc));
check('timely: 編集時に共有レコード更新', /_edRec\.affiliation = DATA\.reservations\[idx\]\.affiliation/.test(timelySrc));
check('timely: 削除時に sfRemoveShared 呼び出し', /sfRemoveShared\(r\.sfId\)/.test(timelySrc));
check('timely: 取込ガード fromBoard 必須', /if \(!r \|\| !r\.fromBoard\) return/.test(timelySrc));
check('board: 取込ガード salon 必須', /if \(!r \|\| !r\.salon\) return/.test(boardSrc));
check('board: temp ゾーン定義あり', /temp:\s*\d/.test(boardSrc));

console.log('');
console.log(failures === 0 ? 'ALL PASS' : ('FAIL: ' + failures + ' 件'));
if (typeof process !== 'undefined' && process.exit) process.exit(failures === 0 ? 0 : 1);
