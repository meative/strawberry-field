# Playwright テスト（Firebase をスタブ化・本番には触れない）

`stubs.js` が `https://www.gstatic.com/firebasejs/**` への module import を横取りして偽の
Firebase（`window.__fs` に呼び出しを記録、`window.__emit(collection, rows, fromCache)` で
snapshot を注入）を返す。ほかの外部通信はすべて abort する。**Firestore の読み書きは発生しない。**

```bash
cd ~/Documents/strawberry-field
npm i -D playwright && npx playwright install chromium   # node_modules は .gitignore 済み
node tests/playwright/test_wakesync.js    # SF-WAKESYNC-20260930 : 12本すべて
node tests/playwright/test_resmatch.js    # SF-RESMATCH-20260930 : timely.html
SF_PRISTINE=/path/to/HEAD-copies node tests/playwright/test_archive_board.js   # SF-ARCHIVE-BOARD-20260930 : board 5本
node tests/playwright/test_archive_timely.js                                    # SF-ARCHIVE-TIMELY-20260930 : timely.html
```

- `test_wakesync.js` … 前面復帰（visibilitychange / pageshow persisted）で disableNetwork→enableNetwork が
  順に呼ばれる、90秒以上未受信ならヘッダーに「同期待ち」が出る、fromCache=false の snapshot で消える、
  二重発火は1回にまとまる、hidden では何もしない
- `test_resmatch.js` … ボード由来の予約から「当日入力を開く」で、完全一致1件→当日入力／前方一致・複数→
  生年月日つき選択モーダル／該当なし→新規登録／顧客未同期→「同期中」で止まる、サロン割引と tlDone 消費の回帰、
  sf: でないキーの従来経路

- `test_archive_board.js` … 過去月へ移動→getDocs は1回だけ（date 範囲のみ）→同じ月はキャッシュ、閲覧専用ガード
  （新規・空きコマ・ドラッグ・確定・削除・キャンセルにする）、編集可能にした月で1件直すと set はその1件だけ、
  陰性対照（アーカイブを含まない配列を allowDelete=true で保存しても削除ゼロ）、明示削除は id 1件だけ、
  窓内スナップショット後もアーカイブが残る、カレンダーの未読込表示、読み込み失敗と再試行。
  `SF_PRISTINE` に `git show HEAD~N:apps/board*.html` を置いたディレクトリを渡すと、窓内の #board とカレンダーが
  改修前と DOM 一致することも検証する（省略可）
- `test_archive_timely.js` … 窓（前月1日）より前の日報・月報で早朝・延長の件数が出る、1回だけ読む、
  区分別CSVと同じ数、SF_MIRROR / DATA.reservations には流れない、読み込み失敗の toast と再試行
- `test_unsentbox.js` … SF-UNSENTBOX-20261014 : `window.__fsHang`（setDoc が失敗せず永遠に未決着）で
  2026-10-13/14 の受付消失を再現 → 10秒で赤帯「未送信 n件」と localStorage の未送信箱（kind・id・rec・at）、
  リロード・online 復帰・sfWakeSync 後の再送と決着での空化、snapshot 由来・成功した書き込みは箱に入らない
  （陰性対照）、7日より古い控えは知らせるだけで自動でも手動でも再送しない、90秒超未受信の書き込みで
  送信前に disableNetwork→enableNetwork、受付の予約証跡（tlDone / tlVisitId の patch）
- `test_tombstone.js` … SF-TOMBSTONE-20261015 : tlDel で deleteDoc＋sf_tombstones/{id}（kind・deletedAt・by）、
  墓石付き id が snapshot に現れたら自動 deleteDoc・表示除去・ログ [SF-TOMBSTONE] revived=、到着順が逆でも効く、
  90日超の墓石は効かせず掃除する、陰性対照
- `test_fleet.js` … SF-WRITESTAMP-20261015 / SF-DEVICES-20261015 : 12本すべてで、起動時の sf_devices 台帳と
  sf_config/version の getDoc、全書き込み口（fbReconcile / kinderSave / fbCapSet / nfWrite / fbPutTl / fbPatchBooking）の
  _w:{dev,ver,at} 刻印と既存フィールド不変、sfChangedOnly が _w だけの違いを無視、前面復帰の台帳更新
- `test_devices.js` … SF-DEVICES-20261015 : 版一致でリロードなし／版が古いと自動リロード1回（1日1回ガード・刻印）／
  ガード中は見送りログ／入力中は後回し
- `stubs.js` の `getDocs` は `window.__cloud[コレクション]` を where 条件で絞って返す。`window.__cloudFail = true` で失敗させられる。
  `getDoc` も同様に `window.__cloud` から id 一致の1件を返す。`window.__fsHang = true` で setDoc / updateDoc / deleteDoc を永遠に未決着にできる

`apps/` の場所は既定でこのリポジトリ直下。別の場所を見るなら `SF_APPS=/path/to/apps` を付ける。
