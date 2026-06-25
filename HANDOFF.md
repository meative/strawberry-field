# STRAWBERRY FIELD 引き継ぎ資料 v12 (2026-06-25 時点)

次回の作業をスムーズに再開するための記録。チャットにアップロードするか、`~/Documents/strawberry-field/HANDOFF.md` を参照すれば続きから再開できる。

---

## ⊙ いまの全体像（30秒で把握）

- 4つのHTMLアプリ (board / salon / notify / timely) は **Firestore + onSnapshot ミラー方式**で本番連携している (複数端末でリアルタイム共有できる。localStorage 時代の制約は解消済み)。
- 全アプリに **Firebase 匿名認証 (signInAnonymously)** を追加済み。サインインで定員購読も signInAnonymously().then() 内に置いて動く。
- **白石エリア対応が完全完了 (2026-06-24)**。salon / notify / board の3画面で BUDDY BROWN / JANIS白石 を実店名表示。実データ連動テストも実機で完了。
- ホスティングは **GitHub Pages** (Netlify ではない)。`main` への push で自動反映。
- **board(資生館/factory)対応を push 済み・本番反映**（`origin/main = 03349a7`）。**notify 園名表示は `dcfc241` でローカルコミット済み・push 待ち**。
- 残る大きな仕事は **ステップ3: Firestore セキュリティルール厳格化 (7/19 期限)** のみ。

---

## ⚠️ 重要訂正：ホスティングは GitHub Pages (Netlify ではない)

- 本番URL (board)：**`https://meative.github.io/strawberry-field/apps/board.html`**
- `main` ブランチへ push → GitHub Pages が自動デプロイ (反映に数十秒〜数分のラグ)。
- CLAUDE.md の「Netlify Drop / strawberry-field-app.netlify.app / GitHub+Netlify連携に移行予定」は旧情報。実態は GitHub Pages。recap や HANDOFF で Netlify と書かない。
- 旧 Netlify 本番 (`strawberry-field-app.netlify.app`) はクレジット切れで役目終了・放置可。

### 本番URL一覧 (Ayumi さんに渡すもの)
```
トップメニュー： https://meative.github.io/strawberry-field/
受付(timely)： https://meative.github.io/strawberry-field/apps/timely.html
予約ボード： https://meative.github.io/strawberry-field/apps/board.html
サロン予約： https://meative.github.io/strawberry-field/apps/salon.html
お迎え通知： https://meative.github.io/strawberry-field/apps/notify.html
取扱説明書： https://meative.github.io/strawberry-field/docs/timely-staff-manual.html
```

**★ Ayumi さんへの必須案内：白石店は `?garden=shiraishi` 付きURLを使うこと。**
- サロン予約(白石)： `https://meative.github.io/strawberry-field/apps/salon.html?garden=shiraishi`
- お迎え通知(白石)： `https://meative.github.io/strawberry-field/apps/notify.html?garden=shiraishi`
- パラメータなしのURLを開くと、白石の子が**月寒園の予約として入ってしまう**。「1サロン=1端末」で各店が固定URLをブックマークして使う運用。

---

## ✅ 完了 (今セッション v12) — 白石エリア対応

白石ビルに 白石園(保育園)・BUDDY BROWN(美容室)・JANIS白石(マツエク) が同居。サロン客が施術中に白石園へ預ける。すべて白石園との連動が中心。

- **実装方針 (Method X)**：データ識別子は全画面 `woodstock` / `janis` 共通＋`gardenId='shiraishi'` で区別。**表示だけ出し分け、value は絶対に変更しない**。月寒とデータスキーマを共有し、ラベルと色だけ差し替える。
- **salon / notify**：`?garden=shiraishi` で白石モード (BUDDY BROWN / JANIS白石、白石園連携、ティファニーグリーン)。各店が固定URLを使用。
- **board**：画面内タブ切替。白石園タブで5箇所すべて実店名表示 (凡例・モーダルselect・ゾーンラベル・文脈・トースト)。`GARDEN_ZONE_NAME` 辞書 + `zoneEn()` / `zoneJp()` + `updateZoneLabels()`。en/jp とも「BUDDY BROWN」「JANIS白石」で統一 (カタカナ化しない)。色は据え置き (gold / blue)。
- **コミット (5件)**：
  - `58706e3` salon: 白石 BUDDY BROWN をティファニーグリーンに変更
  - `9814a1c` 〜 `aa400e9` board: 白石ゾーンラベル・文脈・トーストを実店名表示 (GARDEN_ZONE_NAME + zoneEn/zoneJp)
  - `ea6de28` board: 凡例・モーダル区分selectも実店名表示 (updateZoneLabels で出し分け、value識別子・色は据え置き)
**push 完了・本番反映確認済み**: `origin/main = 03349a7`（board 対応まで反映）。notify(`dcfc241`)は push 待ち。
- **★実データ連動テスト完了 (2026-06-24)**：salon(白石)で予約作成 → Firestore に区分ごと振り分け保存 → board(白石園)に正しいゾーン・色・時間で表示 → 月寒タブには出ない (gardenId フィルタ) → 削除で空き枠が戻る (capacity 連動)。すべて実機で確認。テストデータも掃除済み。

---

## 🏛 これまでに完成した本番機能 (累積・全て push 済み)

### 1. Firestore 移行 (localStorage → Firestore ミラー方式)
- 全アプリが共有予約データ (コレクション `sf_bookings`) を **Firestore + onSnapshot** で連携。
- 設計：`SF_MIRROR` (メモリ上の写し) を正本のコピーとして保持。`sfLoad()` は double-load (既存コードと互換)。`sfSave()` は追加から削除id を算出し `window.fbReconcile` (module側 writeBatch) へ委譲。`onSnapshot` → `window.sfApplySnapshot(arr)` で写しを丸ごと置換し再描画。
- timely は関数名が `sfLoadShared` / `sfSaveShared`、自前業務データ (`timely_school_data_v1`「DATA」/「saveDate」は Firestore 対象外・自宅予約のみミラー化)。notify は案A (マージ・状態保持・削除非依存) で children のローカル状態を守る。
- firebaseConfig (4アプリ共通・projectId `strawberry-field-timely`)、コレクション `sf_bookings` / `sf_capacity` を共有。

### 2. 匿名認証 (4アプリ・ステップ2)
- 各アプリの module に `getAuth, signInAnonymously` を import、`const auth = getAuth(app)`、`onSnapshot` 購読を `signInAnonymously(auth).then(){...}` の中へ移動。
- timely は起動ガード `window.__sfSnapshotReceived` と整合 (初回スナップショット受信で削除パス解除)。

### 3. 年齢別定員 (capacity・Phase 1〜4)
- **データ**：コレクション `sf_capacity`、doc `base` = 基本設定 `{ gardenId:{ '0'..'3': n } }`、doc `YYYY-MM-DD` = 日別例外 (書いた年齢だけ)。`capEffective(garden,age,date)` = 日別例外 → 基本 → null(無制限)。未設定=無制限で安全。
- **board**：@保育園管理設定 (基本設定UI) / 日別例外UI (月カレンダー・対象日独立・gold ドット) / 年齢別 空き状況サマリー (残りの席 / 満員=ボルドー / 制限なし)。`CAP_MIRROR` ミラー、`countReservations` (temp/woodstock/janis のみ・仔予約も数える・ext/年齢不明除外)。
- **salon**：`sf_capacity` 読み取り購読＋満員ブロック (`confirmReserve` の今日予約枠で書き込み前にガード) ＋空き表示連動 (`checkAvailability` 冒頭で満員なら専用表示) ＋満員表示のボルドー化 (board の満員チップ `#B23E4C` と統一)。
- 年齢区分は board/salon とも `'0'/'1'/'2'/'3'` (3=3歳〜、3/4/5は '3')。`normAge` で正規化。
- 日別例外エディタに月カレンダー (commit `cd2dee0`)：対象日を board 表示日から独立 (`selectCapDate`)、例外のある日に gold ドット (`capHasDaily` = any-garden 判定)。新関数 `renderCapCalendar` / `capCalMove` / `selectCapDate` / `capHasDaily` / `loadCapDailyInputs`、状態 `capCalYM`。書き込みパス (`fbCapSet` / `fbCapDelete`) は無変更。既存ボード日付カレンダー (`calOverlay` / `renderCalendar`) も無変更 (別物)。

---

## ⊙ 次にやること

### 最優先 (期限あり)
- [ ] **ステップ3：Firestore セキュリティルール厳格化 (7/19 期限)**
  - `allow read,write: if true` → `if request.auth != null` (`sf_bookings`・`sf_capacity` 両方)。
  - **順序厳守**：コード push 済み (済) → 全 iPad が新コードでリロード → **その後**ルール変更。
  - 匿名認証は4画面実装済み。`sf_capacity` 購読は `signInAnonymously().then()` 内にあること (確認済み・厳格化後も動く)。

### 任意・将来
- [ ] Ayumi さんへの案内実施：白石店は `?garden=shiraishi` 必須 (本資料の本番URL一覧を渡す)。
- [ ] 資生館の salon 設定確認 (placeholder `['woodstock','janis']`)。
- [ ] 延長保育時間の差異解消：spec(19:00-21:00) vs 実装(19:00-20:00)。
- [ ] `sf_capacity/2026-06-21` の test override 削除 (tsukisamu age-1=0、`window.fbCapDelete`)。
- [ ] salon「次回予約」モードへの満員ガード追加 (今は「今回の予約」モードのみブロック)。
- [ ] 案A (timely⇄board) の edit/delete 伝播のブラウザ最終確認。

---

## ⚙ 環境・リソース

| 項目 | 内容 |
|---|---|
| ローカル | `~/Documents/strawberry-field` (apps は `apps/`) |
| GitHub | `https://github.com/meative/strawberry-field` (Public・ユーザー meative・ブランチ `main`) |
| 本番 | **GitHub Pages**：`https://meative.github.io/strawberry-field/` (main push で自動反映) |
| Firebase | projectId `strawberry-field-timely` / コレクション `sf_bookings`・`sf_capacity` / 匿名認証ON |
| 旧本番 (終了) | Netlify `strawberry-field-app.netlify.app` (クレジット切れ・放置可) |
| 別プロジェクト | `github.com/meative/strawberry-tuition` → Pages `meative.github.io/strawberry-tuition/`。Firebase も別 `strawberry-tuition`。**混同しない** |
| 最新コミット | `03349a7`（board, push済）/ `dcfc241`（notify, push待ち） |
| 開発 | Mac / Terminal.app / Claude Code (Opus 4.8) |
| 4園 | 月寒(tsukisamu) / 白石(shiraishi) / サッポロファクトリー(factory) / 資生館(shiseikan)。白石ビルに 白石園・BUDDY BROWN・JANIS白石 が同居。月寒系サロン = WOODSTOCK / JANIS |

---

## ⊙ 作業の進め方 (このプロジェクトの約束事)

- **2-Claude 方式**：macOS ターミナルで Claude Code (Opus) を動かしスクショ共有、チャット側 Claude が差分レビュー・設計判断。
- **承認は option 1 (Yes) のみ。option 2 (bulk-allow / don't ask again) は絶対押さない。**
- **`dangerouslyDisableSandbox` には反射的に Yes しない**。低リスクな読み取り操作でも拒否が正解 (今セッションも git ls-remote 用に出てきたが拒否し、素のターミナルで実行した)。
- **1ステップずつ**：バックアップ (`cp apps/X.html apps/X.html.backup`) → 編集 → 構文チェック (`osascript -l JavaScript` の new Function 方式) → 実機ブラウザ確認 → コミット。
- **実機確認前にコミットしない** (急ぎがちなので毎回止める)。構文 VALID ≠ 実機で動く。Edit は幽霊適用 (適用したつもりで未適用) が起きるので、必ず grep / sed で実物確認。
- **Claude Code の stale cache に注意**：ローカル状態が前回 push より前で止まり「未プッシュN件」と誤報することがある。**production evidence (`git ls-remote` でリモート SHA を直接確認 / GitHub Pages の実挙動) で覆す**。今セッションも「未push 5件」の誤報を ls-remote で否定した。
- **git add はファイル明示** (`git add apps/X.html`)。`git add .` / `-A` は不可 (`.backup`・`HANDOFF.md` 等の混入防止)。
- **pwd 確認してから作業** (`strawberry-tuition` への迷い込み防止)。
- **PAT**：ワンタイム classic PAT (repo scope) を push URL に直接注入 (`https://<TOKEN>@github.com/...`)、ユーザーが実行、**push 後すぐ revoke**。Claude Code には絶対貼らない／素のターミナル (タイトルに claude が付かないウィンドウ) のみで使用。今は push 済みなので当面 PAT 不要。
- 文言は「エレガント・ニューヨーク」トーン。デザインは Cormorant Garamond / Noto Serif JP / Inter、ivory / tiffany #0ABAB5 / gold #C9A961、満員=ボルドー #B23E4C。

---

## ⊙ 注意点・既知の事項

- **ブラウザ実機操作・スクショ・コンソール実行はユーザー側** (Claude Code 環境にはブラウザ / JS ランタイムが無い)。Claude はコード根拠での確認と new Function 構文検証を担当。コンソールは Chrome DevTools を使う (Claude Code ターミナルではページ内関数が動かない)。Chrome は `allow pasting` を一度打つと貼り付け可。**日本語を含むコンソールペーストは SyntaxError になるので JS のみ**。
- macOS の `Operation not permitted` (git が書類フォルダにアクセス不可) 対処：システム設定 → プライバシーとセキュリティ → フルディスクアクセス → ターミナルをオン → 再起動。
- GitHub Pages 無料版は Public リポジトリ必須。顧客個人情報を含めない設計 (データは Firestore、サンプルは全消し済み)。
- テストデータ確認 / 掃除はコンソールから：例外一覧 `Object.keys(CAP_MIRROR).filter(k => k !== 'base')`、削除 `capDeleteDaily('YYYY-MM-DD')` (`base` には触れない)。
