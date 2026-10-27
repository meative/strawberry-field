# STRAWBERRY FIELD Cloud Functions（SF-NFSERVER）

設計は `../DESIGN-nfserver.md`。構成は eye405-app と同じ（`index.js` は登録だけ・判定は `lib/` の純粋関数・`test/` は node:test）。

```bash
cd functions && npm install && npm test                      # 純粋関数のテスト（Firebase 不要）
firebase deploy --only functions --project strawberry-field-timely
firebase functions:log --project strawberry-field-timely
```

- モード：`sf_config/nfserver.mode` = off / shadow / live（30秒以内に反映）
- 旧 sf_notify を書くのは live かつ legacyBridge=true のときだけ（S1 では c のみ。n / s は S2）
