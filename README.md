# STRAWBERRY FIELD 予約システム

札幌の保育園グループ「STRAWBERRY FIELD」（4園）の業務システムです。
系列の美容室「WOODSTOCK」・まつげサロン「JANIS」を利用するお客様が、
施術中に隣接する保育園へお子様を無料で預けられる仕組みを提供します。

## 構成

4つのHTMLアプリが連携して動作します。

### apps/

| ファイル | 役割 | 使う人 |
|---|---|---|
| `apps/timely.html` | TimelySchool 受付。当日入力・お会計・領収書発行 | 保育園スタッフ |
| `apps/board.html` | 予約管理ボード。タイムライン形式の俯瞰画面 | 保育園スタッフ |
| `apps/salon.html` | サロン側の予約画面。空き状況確認・予約登録 | 美容室/サロンスタッフ |
| `apps/notify.html` | お迎え遅延通知。双方向の進捗共有 | 双方 |

### docs/

スタッフ向け説明書・運用ガイド。

### planning/

設計資料・将来のロードマップ。

## 現在のアーキテクチャ

**localStorage連携** — 4つのHTMLが同じブラウザのlocalStorageを共有して連携します。
同じデバイス・同じブラウザでのみ動作するプロトタイプ構成。

- 予約データキー: `sf_bookings_v1`
- TimelySchool受付データキー: `timely_school_data_v1`

データ構造の詳細は `planning/project-overview.md` を参照。

## デプロイ先

- 本番URL: https://strawberry-field-app.netlify.app
- デプロイ方法: 現状は Netlify Drop（手動）。GitHub連携への移行を準備中。

## 今後の方向性

- **Firebase移行**: localStorage連携をクラウド連携に置き換え、複数端末でリアルタイム共有
- **GitHub + Netlify連携**: コードをプッシュすれば自動デプロイ
- 詳細は `planning/firebase-roadmap.html` を参照

## 開発の進め方

1. ローカルでファイルを編集
2. 同じブラウザで `apps/index.html` から各アプリを開いてテスト
3. JSDOMによる関数テスト（過去のテストハーネスを継承）
4. GitHubにコミット → Netlifyに自動デプロイ

詳細は `CLAUDE.md` を参照。

## デザインシステム

- カラー: Tiffany系 `#0ABAB5`、ゴールド `#C9A961`、サロン別カラー
- 書体: 見出し英字 Cormorant Garamond（italic）、和文 Noto Serif JP
- トーン: 「エレガント・ニューヨーク」

詳細は `planning/project-overview.md` の §1 を参照。
