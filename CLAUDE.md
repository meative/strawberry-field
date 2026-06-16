# CLAUDE.md — Claude Code 向け開発ガイド

このプロジェクトを Claude Code で扱うときに、最初に読んでください。

## プロジェクト概要

**STRAWBERRY FIELD 予約システム** — 札幌の保育園グループの業務システム。
4つのHTMLアプリが localStorage で連携するプロトタイプから、
Firebase連携・GitHub-Netlify連携の本番運用フェーズへ移行中です。

詳細は `README.md` と `planning/project-overview.md` を参照してください。

## 開発の前提

### 単一HTMLファイル方式

各アプリは1ファイル完結のHTMLで、`<style>` と `<script>` を内包しています。
ビルドステップは無く、ブラウザで開けばそのまま動きます。

- ファイルサイズが大きい（特に `apps/timely.html` は500KB超）
- 編集は `str_replace` または部分書き換えで行うこと
- 全文書き換えは避ける（コンテキスト消費が大きく、変更履歴も追いづらい）

### localStorage連携の制約

現状は同じブラウザのlocalStorageでデータを共有しています。

- 予約データ: キー `sf_bookings_v1`
- TimelySchool受付データ: キー `timely_school_data_v1`
- 別タブ間の `storage` イベント + 4秒ポーリングで同期

これは将来Firebaseに置き換える前提のプロトタイプ実装です。
新機能を追加するときも、まずlocalStorage前提で実装し、Firebase移行時にデータ層だけ差し替える設計を意識してください。

## コーディング規約

### スタイル

- カラー変数: `--tiffany: #0ABAB5`、`--gold: #C9A961`、`--ink: #1A1F26`
- 書体: 見出し英字 `Cormorant Garamond` italic、和文 `Noto Serif JP`
- サロン別: WOODSTOCK = ゴールド、JANIS = ブルー `#3F6E94`〜`#5B8DB8`
- 既存のセクション構造（`section-card`, `section-header`, `section-title`）を踏襲

### 文言

- 「エレガント・ニューヨーク」のトーン
- 接客は丁寧でやわらかい言葉遣い
- 英字ラベル（小さく italic）+ 和文ラベル（メイン）の二段構成が基本

### データ操作

- `DATA.visits.push(...)`, `DATA.customers.push(...)` のように直接編集後、`saveData(DATA)` を呼ぶ
- レコードの照合は **`sfId`（id）優先**、なければ「同名+同開始時刻」でフォールバック
- 既存データの後方互換性を維持（古いキー名のデータも読めるようにする）

## テストのやり方

### JSDOMベースのテストハーネス

ネットワーク制限で実ブラウザが使えなかった経緯から、JSDOMでスクリプトを評価して関数単位でテストする方式を取っています。

```bash
# テストファイルは test_xxx.js の形式
node test_timely.js
node test_discount_v2.js
# など
```

新機能を追加するときは、対応する `test_xxx.js` を追加してください。

### テスト時の注意点

1. **`<script>` 抽出時に `api.anthropic` を含むartifact内スクリプトは除外**する
2. **localStorageモックは「実際に読み書きする」形にする**（空モックだとデータ種まきが効かない）
3. **AudioContext / setInterval / requestAnimationFrame / alert もモック**が必要
4. **テスト失敗のほとんどはテスト側の問題**。実コードを疑う前にテストを見直すこと
5. ネストしたテンプレートリテラル `` `${...?`...`:`...`}` `` はJS構文エラーになる → 文字列連結に書き換える

## 編集時の注意

### timely.html（500KB超の大ファイル）

最も大きく、最も頻繁に編集されるファイル。

- 編集は `str_replace` で部分的に
- 構文チェック必須: `node --check` で `<script>` を抽出して検査
- 既存のテスト全件パスを確認してからコミット

### 既知の機能（timely.html）

過去のセッションで実装済み。重複実装に注意してください。

- お会計画面の構成: お客様情報 → 割引 → ご使用時間料金 → お伝え事項 → 特記事項 → 備考 → 受領者
- 割引タブ: 割引なし / 通常割引 / WOODSTOCK割引 / JANIS割引
- サロン経由予約は自動で対応する割引タブが選択・全額入力される
- 特記事項（`paymentSpecialNote`）は領収書に表示される
- 備考（`paymentInternalNote`）は領収書に表示されない保育園内メモ
- 時間逆転バリデーション（当日入力・お会計の両方）
- 来園前授乳の24時間対応
- 園を跨いだ顧客検索（他園バッジ表示）
- 領収書のA4一枚レイアウト（情報帯統合、scale 0.50）

## デプロイ

### 現状

Netlify Drop で手動アップロード。本番URL: https://strawberry-field-app.netlify.app

### 移行計画

GitHub + Netlify連携に移行予定。

1. GitHubリポジトリにプッシュ
2. Netlifyの管理画面でリポジトリと連携
3. `main` ブランチへのプッシュで自動デプロイ

`netlify.toml` がリポジトリのルートに置かれている前提。

## ユーザーとのコミュニケーション

- 開発者は日本語ネイティブ（札幌・JOINTS NINE所属）
- Mac環境で作業
- スタッフ（あゆみさん他）に iPad で使ってもらっている
- 文言や設計の判断は丁寧に確認を取りながら進める

## 関連ファイル

- `README.md` — プロジェクト全体ガイド
- `planning/project-overview.md` — 詳細な仕様書
- `planning/firebase-roadmap.html` — Firebase移行計画
- `docs/timely-staff-manual.html` — スタッフ向け取扱説明書
