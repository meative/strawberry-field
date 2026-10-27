# SF-NFSERVER の運用スクリプト（所有者トークン＝Admin 相当・Firestore REST）

`admin_rest.mjs` が Firebase CLI のログイン情報（`~/.config/configstore/firebase-tools.json`）の access_token で
Firestore REST を叩く。ルールの対象外（Functions の Admin SDK と同じ権限）なので、**書くスクリプトは慎重に**。
トークンが切れていたら `firebase projects:list` を1回実行する。

```bash
node tests/nfserver/setup_shadow.mjs           # 手順1：sf_config/nfserver を mode:'shadow' で作る（1回）＋ 検証用 events の削除
node tests/nfserver/backfill_shadow.mjs [日付]  # 影運転の初期化（1回）：当日の旧 c/n → events、state を reduce で計算して *_shadow へ
node tests/nfserver/compare_shadow.mjs [日付]   # 読み取り専用：旧 sf_notify の c と sf_notify_state_shadow を予約ごとに突き合わせ（氏名は出さない）
```

- `compare_shadow` の「一致」：旧 c の status と shadow の status が同じ。旧 c が無い（端末が書いていない）予約は
  shadow が reserved / no-show / cancelled なら一致扱い。旧 c の waiting＋sentComing は picking と比べる
- モードの切替は `sf_config/nfserver.mode`（off / shadow / live）。Functions は30秒以内に追従する
