# Playwright テスト（Firebase をスタブ化・本番には触れない）

`stubs.js` が `https://www.gstatic.com/firebasejs/**` への module import を横取りして偽の
Firebase（`window.__fs` に呼び出しを記録、`window.__emit(collection, rows, fromCache)` で
snapshot を注入）を返す。ほかの外部通信はすべて abort する。**Firestore の読み書きは発生しない。**

```bash
cd ~/Documents/strawberry-field
npm i -D playwright && npx playwright install chromium   # node_modules は .gitignore 済み
node tests/playwright/test_wakesync.js    # SF-WAKESYNC-20260930 : 12本すべて
node tests/playwright/test_resmatch.js    # SF-RESMATCH-20260930 : timely.html
```

- `test_wakesync.js` … 前面復帰（visibilitychange / pageshow persisted）で disableNetwork→enableNetwork が
  順に呼ばれる、90秒以上未受信ならヘッダーに「同期待ち」が出る、fromCache=false の snapshot で消える、
  二重発火は1回にまとまる、hidden では何もしない
- `test_resmatch.js` … ボード由来の予約から「当日入力を開く」で、完全一致1件→当日入力／前方一致・複数→
  生年月日つき選択モーダル／該当なし→新規登録／顧客未同期→「同期中」で止まる、サロン割引と tlDone 消費の回帰、
  sf: でないキーの従来経路

`apps/` の場所は既定でこのリポジトリ直下。別の場所を見るなら `SF_APPS=/path/to/apps` を付ける。
