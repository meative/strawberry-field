# 本番 smoke（読み取り専用）

```bash
NODE_PATH=<playwright の node_modules> node tests/prod/smoke_notify_readonly.mjs <SF_APP_VER>
```

- Firestore SDK の書き込み関数を SDK の層で無効化してから開く。**本番には1バイトも書かない**（遮った書き込みは `blocked` に件数）
- 2026-10-27 に書き込みを伴う smoke が sf_notify の n ドキュメントを書き直し、現場の全端末にキャンセル通知を再着信させた。
  本番 URL を開く確認はこの読み取り専用版だけを使うこと（CLAUDE.md §7）
- 書き込みを伴う確認は、テスト園（`gardenId='smoke'`）の予約か、存在しない bookingId（`probe-…`）だけで行う
