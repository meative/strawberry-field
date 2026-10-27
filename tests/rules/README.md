# Firestore ルールの検証（SF-NFSERVER・2026-10-27〜）

このMacには Java が無く Firestore エミュレータが動かないため、ルールは **Firebase Rules REST API の
`projects.test`** でデプロイせずに検証する（本番データには触れない。CLI のログイン情報
`~/.config/configstore/firebase-tools.json` の access_token を使う。切れていたら `firebase projects:list` を
1回打つと更新される）。

```bash
node tests/rules/rules_rest_test.mjs firestore.rules     # 20項目。既存コレクションの読み書き・events の create 条件・update/delete 拒否・state 書き込み拒否
firebase deploy --only firestore:rules --project strawberry-field-timely
node tests/rules/rules_live_check.mjs                    # 本番の裏取り（匿名 idToken・REST）。events に e_rulescheck_20261027 を1件作る（2回目は 409＝正常）
```

- 追加・変更したルールは `firestore.rules` を直して REST テストに項目を足してから deploy する
- ルールは「どれか1つの match が allow なら許可」。全体 match（`/{collection}/{document=**}`）の除外リスト
  `nfServerOwned` を更新し忘れると、個別 match の `if false` は効かない
