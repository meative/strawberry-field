# HANDOFF.md — 開発引き継ぎログ

次回再開時に最初に読むファイル。最新の到達点・残課題・運用メモを記録する。

---

## 最新状況（2026-06-18 更新）

### 完了（2026-06-18）

- **案A：timely→board へのデータ書き込み（完成）**
  受付（timely）で確定した予約を共有ストレージ `sf_bookings_v1` に upsert し、予約表（board）へ即時反映。
  - `salon:'temp'`（一時保育ゾーン）・`fromBoard:false` で書き込み。board は `salon` 有無で取り込み、timely は `fromBoard` 必須の取込ガードで自分の書込を無視（二重取込なしの片方向）。
  - 端末の園は既存 `DATA.settings.branch`（管理画面ドロップダウンで端末ごとに選択・永続化）を再利用。`gardenId = branchToGardenId(branch)`。
  - 新規=upsert＋予約に `sfId` 保持／編集=共有も更新／削除=共有からも除去。
  - テスト `test_caseA_write.js`（25項目）**ALL PASS**。

- **基準日を実時刻の今日に統一（5/23固定を撤廃）**
  - `board.BOARD_BASE` / `salon.DATE_BASE`・新規予約日付 / `notify.ER_BASE` を実時刻化（深夜0時正規化、計4箇所）。timely は元々実時刻。
  - notify は取込フィルタ `TODAY_STR` も 5/23 固定の積み残しがあり実時刻化（これまで通知が当日と連動していなかった）。
  - 「本日（5/23）に戻る」ボタン（board/salon）を基準日から動的生成（例「本日（6/18）に戻る」）。初期ラベル中立化、コメント内 5/23 一掃、死にコード削除。

- **サンプルデータの一掃（本番運用へ）**
  - board：`SAMPLE_BOOKINGS`→`[]`、`REGISTERED`（名前ピッカー用名簿）→`[]`。
  - salon `seedSampleBookings` / notify `seedIfEmpty` の自動種まきを廃止。両画面とも起動時に既存 `seed_*` を `sf_bookings_v1` から purge（冪等）。
  - timely のサンプル投入ボタン＋`loadSampleData` はテスト用に残置（手動・確認ダイアログ付き）。
  - 残置（無害）：salon `SEED_BOOKINGS`（別参照あり）、notify `NOTIFY_SEED`（未使用化）。

- **timely 過去予約フィルタ**
  予約リストの日付ピッカーで「本日より前」の連動予約を3層で除外（カレンダーの予約ドット集合／過去日セル不活性化／一覧の安全網）。本日判定は実時刻。

- **延長保育ゾーンの分離（board）**
  単一 `ext` を `ext_am`（早朝延長保育・朝7:00-8:30）／`ext_pm`（延長保育・夕16:30-20:00）の2ゾーン2行に分割（計10箇所）。色・有料判定・自園生徒の扱いは従来どおり。

- **検証**：全4ファイルを JavaScriptCore で構文チェック OK、残存ハードコード日付なし、`test_caseA_write.js` ALL PASS。
  実機確認：board/salon「本日（6/18）に戻る」、延長保育2段、サンプル消去、notify が当日連動（予約なし=空表示で正常）。

---

### 完了（〜2026-06-17）

- **フェーズ1：園識別子を4園に統一**
  `board.html` / `timely.html` の園キーと表示名を完全一致させた（board が正）。
  - `tsukisamu`=月寒園 / `shiraishi`=白石園 / `factory`=サッポロファクトリー園 / `shiseikan`=資生館園
  - 以前の「`factory`→`null` で予約が弾かれ、受付と予約表が連動しない」問題を解消。
  - timely に逆引き `branchToGardenId` を追加し、`gardenId↔branch` の往復変換を保証。
  - 旧「幼稚舎」「資生館保育園」は園定義/branch値から除去（資生館は「資生館園」へ統一）。

- **フェーズ2：幼稚舎所属バッジ**
  予約データに `affiliation` フィールドを追加（`'youchisha'` のとき金色「幼稚舎」バッジを表示）。
  - 通常所属＝利用園の `gardenId`、幼稚舎所属だけ `'youchisha'`。バッジ判定は `affiliation === 'youchisha'` のみ。
  - board / timely 双方に「幼稚舎所属」トグルUIを追加。全園で選択可。
  - 後方互換：`affiliation` 未設定の既存予約はバッジなしの通常表示（サンプルにもバッジは出ない）。
  - board の affiliation は共有ストレージ（`sf_bookings_v1`）経由で timely 取込時にも引き継がれる。

- **UI調整**
  - 幼稚舎バッジ追加で氏名が切れる問題を、予約バーの折り返し（`.bar-body { flex-wrap: wrap }` ＋ `.bar-name` を伸びず必要時のみ縮む設定）で解決。幅に余裕があれば従来通り1行。
  - 予約追加ボタン（旧FAB）を右下フローティングからヘッダー右（「Live」隣）の tiffany ピルへ移設。延長保育バーとの重なりを解消。空き枠タップでの追加も従来通り併用可。

- **テスト追加**：`test_garden_4.js`（4園往復変換・名前一致）、`test_affiliation.js`（バッジ判定・配線）。
  node 未導入のため JavaScriptCore（`osascript -l JavaScript`）で検証し **ALL PASS**。

- **コミット & デプロイ**：`0b4c5a4` として記録、GitHub `main` へ push 済み。

### 残課題

- **夜間の有料時間帯の現場確認**：依頼文「19:00〜21:00」vs 実装「19:00〜20:00」（ext_pm の開放/有料帯）。あゆみさんか依頼元へ要確認。
- **資生館園の提携サロン構成**：`GARDENS.shiseikan.salons` は暫定で `['woodstock','janis']`。実構成を確認して修正。
- **node 環境でのテスト実走**：現在 node 未導入。導入後 `node test_garden_4.js` / `node test_affiliation.js` / `node test_caseA_write.js` を実走（現状は JavaScriptCore で代替検証）。
- **デプロイ方式の整理**：Netlify 手動アップロードか GitHub 自動連携か未確定。本番URL `strawberry-field-app.netlify.app` を単一URLとして維持。
- **Firebase 移行（フェーズ3）**：複数端末リアルタイム共有。データアクセス権限・拠点別ネットワーク・予約ルールの並行設計が必要。`planning/firebase-roadmap.html` 参照。

---

## 運用メモ：GitHub への push

普通のターミナルからの push は通らない（Password 認証廃止、`gh` 未インストール）。
Claude Code 内から、行頭 `!` で以下の形で実行する：

```
! git push https://meative:<TOKEN>@github.com/meative/strawberry-field.git main
```

- `<TOKEN>` は GitHub Personal Access Token。**毎回新規発行し、使用後は必ず削除（revoke）する。**
- トークンの実値はこのファイルやコミットに絶対に書かない（リポジトリ経由で漏洩するため）。

---

## 開発フロー

1. Claude Code でファイル編集（単一HTMLファイル方式。`str_replace` で部分編集）
2. ブラウザで動作確認（`open apps/board.html` など）
3. テスト（`test_*.js`。node 導入後は `node test_xxx.js`、現状は JavaScriptCore で代替）
4. `git add` → `git commit`（メッセージは日本語可）
5. 上記 push メモの形で `main` へ push

## 注意点

- **localStorage 互換性**：既存ユーザー（あゆみさん等）のデータを壊さない。構造変更時は移行コード・後方互換を入れる。
- **本番URL**：`strawberry-field-app.netlify.app` を維持。
- **データキー**：予約=`sf_bookings_v1`、TimelySchool受付=`timely_school_data_v1`。
