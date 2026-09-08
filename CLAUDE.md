# CLAUDE.md — Claude Code 向け開発ガイド

STRAWBERRY FIELD 予約システムを Claude Code で扱うときに、最初に読んでください。
（最終更新 2026-09-07 / 全面改訂は 2026-08-28）

---

## 0. ⚠️ セッション開始時に必ず確認すること

### このMacのクローンはリモートより遅れていることがある（実際に2回起きた）

- 2026-08-19〜08-27：**GitHub の Web UI アップロード**での作業がこのMacに未反映だった
  （コミットが全部 `Add files via upload` / `Delete timely.html`）→ 08-28 に `14f9cdd` まで pull
- 2026-08-29〜09-01：**別マシンからの17コミット**がこのMacに未反映だった
  → 2026-09-05 に `51c416e` まで pull（現在の HEAD）

**作業マシンは2台ある。**「このMacが正」という前提は置けないので、**毎回いちばん最初に**
これを実行してください。**古いファイルを編集すると本番の変更を巻き戻します。**

```bash
cd ~/Documents/strawberry-field
git fetch origin main
git log --oneline HEAD..origin/main   # 空でなければ、このMacが遅れている
git log --oneline origin/main..HEAD   # 空でなければ、未pushがある
```

遅れていたら `git pull --ff-only origin main`（作業ツリーがきれいな前提）。
ローカル変更とぶつかる場合は、勝手にマージせずユーザーに相談すること。

Web UI アップロードは使わない（コミット履歴とマーカーが唯一の変更記録になるため）。
どちらのマシンでも、必ず git クローンで編集 → コミット → push する。

### 毎朝 Firebase の使用状況を見る（Blaze には自動停止が無い）

2026-09-02 に Spark（無料）から **Blaze（従量課金）へ移行済み**。Blaze には Firestore を
自動停止する仕組みが無く、**予算アラートは通知するだけ**で止めてはくれない。
読み取りの暴走（→ §0.5）が解決するまで、毎朝 Firebase コンソールの使用状況を確認すること。

### 作業ツリーの状態

`git status` には **150件以上の untracked なバックアップ・パッチスクリプト**が出ます。
これは正常です（`.gitignore` の対象外の命名ゆれで残っているだけ）。
消さないこと。`git add .` / `git add -A` は**絶対に使わない**（バックアップが混入する）。
コミットは必ず**ファイル名を明示**：`git add apps/timely.html`

---

## 0.5 ⚠️ 最優先タスク：Firestore 読み取りの暴走（2026-09-05 時点・未解決）

- 2026-09-02、**読み取り14万件/日**で Spark 無料枠（5万件/日）を超過して枠切れ →
  同日 Blaze へ移行して復旧（→ §0）
- 移行後の 2026-09-04 実測は **3.9万件/日**まで減ったが、それでも無料枠の**78%**
- クラウドの実データは **visits 61 + customers 43 + students 6 = 110ドキュメント**しかない。
  3.9万件/日 ÷ 110件 ≒ **1日350回以上、全データを読み直している**計算
- 原因の第一候補：**onSnapshot の張り直し・多重登録**と、**全件購読にクエリ絞り込みが無い**こと
- 調査の入り口：`grep -n "onSnapshot" apps/*.html` で購読箇所を洗い出す
- **2026-09-08 進捗：Phase 0〜2 完了・本番反映済み**（永続キャッシュを12本全部に、sf_bookings の
  購読に日付窓 `SF-READWINDOW-20260908`）。残りは実測 → Phase 3（board の過去日オンデマンド読み、
  **期限 9/30**）→ Phase 4（timely）。設計・状態・作業ログは **`DESIGN-readwindow.md`** が正

### 作業ログ

- 2026-09-05：5/29 のテストデータ4件（髙嶋 英憲・英二／ファクトリー・月寒／合計¥7,000）を
  お会計待ちから削除。詳細はローカルメモ（`claude/` 配下・git管理外。顧客名を含むため
  ファイル名はここに書かない）

---

## 1. プロジェクト概要

札幌の保育園グループ「STRAWBERRY FIELD」（4園）の業務システム。
系列の美容室・まつげサロンのお客様が、施術中に隣接する保育園へお子様を無料で預けられる仕組み。

現場ではスタッフ（あゆみさん他）が **iPad** で日常運用しています。**すでに本番稼働中**です。
壊すと当日の保育・会計が止まるので、慎重に進めること。

### 4園とサロン

| gardenId | 園名 | 併設サロン |
|---|---|---|
| `tsukisamu` | 月寒園 | WOODSTOCK（美容室）/ JANIS（まつげ） |
| `shiraishi` | 白石園 | BUDDY BROWN（美容室）/ JANIS白石 |
| `factory` | サッポロファクトリー園 | なし |
| `shiseikan` | 資生館園 | なし |

**重要**：白石のサロンは表示名だけ違い、**データ上の識別子は `woodstock` / `janis` のまま**。
`gardenId` で区別し、ラベルだけ `GARDEN_ZONE_NAME` 辞書（board.html）で差し替える。
**value は絶対に変えない**（Method X）。

---

## 2. リポジトリ構成

```
strawberry-field/
├── index.html              トップメニュー（各アプリへのリンク）
├── apps/                   本体（4アプリ × 園別バリアント = 12ファイル）
├── docs/                   スタッフ向け説明書（HTML）
├── planning/               設計資料
├── tests/                  テスト置き場（README + board テスト1本）
├── test_*.js               ルート直下の検証スクリプト（3本）
├── dist/                   ★ Netlify時代の遺物。使っていない
├── HANDOFF.md              ★ v13 / 2026-06-26 で更新停止。古い情報を含む
├── DESIGN-status-sync.md   ★「実装未着手」とあるが実装済み（SF-NOTIFY-CLOUD-20260723）
├── netlify.toml            ★ 遺物。デプロイは GitHub Pages
└── .nojekyll               GitHub Pages 用（消さない）
```

### apps/ の本番ファイル（git 管理下は12本）

| ファイル | 役割 | 使う人 |
|---|---|---|
| `timely.html` (625KB) | TimelySchool 受付。当日入力・お会計・領収書 | 保育園スタッフ |
| `board.html` (177KB) | 予約管理ボード（タイムライン俯瞰）。園切替タブあり | 保育園スタッフ |
| `board_sp_{tsukisamu,shiraishi,factory,shiseikan}.html` | 上記の**園固定・iPad最適化版**（切替UIは非表示） | 各園 iPad |
| `salon.html` (144KB) | サロン側の空き確認・予約登録 | サロンスタッフ |
| `salon_sp_{shiraishi,tsukisamu}.html` | 上記の**園固定版** | 各店 iPad |
| `notify.html` (147KB) | お迎え遅延通知（双方向） | 双方 |
| `notify_sp_{shiraishi,tsukisamu}.html` | 上記の**園固定版** | 各店 iPad |

`_sp_` 版との差分は基本 **`CURRENT_GARDEN` の固定と、園切替UIの非表示だけ**（board はモバイルCSSも追加）。

> **★ 最重要ルール：機能を直すときは同系統の全ファイルを一緒に直す。**
> `salon.html` だけ直して `salon_sp_shiraishi.html` を忘れる＝白石店だけ古いまま動く、が過去に何度も起きています。
>
> - board 系 … `board.html` + `board_sp_*.html` の **5本**
> - salon 系 … `salon.html` + `salon_sp_*.html` の **3本**
> - notify 系 … `notify.html` + `notify_sp_*.html` の **3本**
> - timely … `timely.html` の **1本**

`apps/` には `*.py`（パッチスクリプト）と大量の `.bak_* / .bk-* / .prepatch / .backup*`
（バックアップ）も同居しています。git 管理外です。

---

## 3. アーキテクチャ（現状 = Firestore 本番稼働中）

**localStorage プロトタイプは卒業済みです。** 古い CLAUDE.md / README の
「localStorage連携」「Firebase移行予定」は**旧情報**。

### Firestore

- projectId: **`strawberry-field-timely`**（4アプリ共通の firebaseConfig をHTMLに直書き）
- 料金プラン：**Blaze（従量課金）**。2026-09-02 に Spark から移行（読み取り超過の枠切れが契機 → §0.5）
- Firebase JS SDK 10.12.5 を `https://www.gstatic.com/firebasejs/` から `<script type="module">` で読む
- **匿名認証**（`signInAnonymously`）必須。**購読は必ず `signInAnonymously(auth).then()` の内側**に置く
  （ルールが `request.auth != null` なので、外に置くと permission-denied で落ちる）

| コレクション | 内容 | 読み書きするアプリ |
|---|---|---|
| `sf_bookings` | 予約1件＝1ドキュメント（docId = レコードの `id`） | 全4アプリ |
| `sf_capacity` | 年齢別定員。doc `base`＝基本設定、doc `YYYY-MM-DD`＝日別例外 | board(RW) / salon(R・満員判定) |
| `sf_visits` / `sf_customers` / `sf_students` | 受付の業務データ（来園・顧客・園児） | timely |
| `sf_roster` / doc `all` | サロン向け軽量名簿（住所・電話・アレルギーは載せない） | timely(W) / salon(R) |
| `sf_notify` | お迎え通知・様子ログ・子の状態 | notify / board |
| `sf_kinder_attendance` / doc `YYYY-MM-DD` | 幼稚舎の出欠 | board |

別プロジェクト `strawberry-tuition`（月謝アプリ）の `kindergarten_public/roster` も
board が読み取り専用で購読しています。**2つのFirebaseプロジェクトを混同しないこと。**

### 同期の設計 — 受信経路は2本ある（★ここを1本だと思うと必ず間違える）

行番号は `14f9cdd`（2026-08-27）時点の `apps/timely.html`。

```
【A】共有予約 sf_bookings … 丸ごと置換（従来どおり）
  onSnapshot ─▶ window.sfApplySnapshot(arr)          :8391
               └─ SF_MIRROR = arr        ← 無条件の置換。版ガードは無い
               └─ importBoardReservations() で DATA.reservations へマージ取り込み

【B】受付業務データ sf_visits / sf_customers / sf_students … レコード単位マージ
  onSnapshot ─▶ window.tlApplySnapshot(kind, rows)   :9074
               └─ tlMergeByVersion(kind, local, cloud)   :9003
                    cloud を土台に走査し、同じ id が両方にある時だけ手元を残す：
                    (1) 会計ガード  visits かつ 手元paid × cloud pending → 手元  :9011
                    (2) 版ガード    tlRecTime(手元) > tlRecTime(cloud)   → 手元  :9013
                    cloud に無い id は落とす（＝他端末の削除を尊重）
               └─ 手元が勝った分(localWins)は fbReconcileTl で送り直す
```

送信側は A/B 共通で差分のみ：

```
sfSave()/sfSaveShared(arr) ─▶ sfChangedOnly(next, 写し) ─▶ fbReconcile() ─▶ writeBatch
```

- 関数名：board/salon/notify は `sfLoad` / `sfSave`、**timely は `sfLoadShared` / `sfSaveShared`**
- `sfCanon()`（:8329）… キー順に依存しない正規化JSON。差分判定に使う
- `sfChangedOnly(next, prev)`（:8343）… **変わったレコードだけ**書く。
  かつて1件の保存でコレクション全件を書き直し、Firestore の1日あたり書き込み上限を
  使い切って本番の保存が止まった（SF-WRITEDIFF-20260724）。**この差分化を壊さないこと。**
- **初回スナップショットのフラグは2系統ある。** 片方を見て「ガード済み」と判断しないこと。
  - `window.__sfSnapshotReceived`（:8304 / :8393）… **sf側・単一**。参照は :8562 の1箇所だけで、
    「共有側で消えた fromBoard 予約を DATA.reservations から消す」**削除パス**を守る
  - `TL_SNAP_SEEN`（:8611）… **tl側・kind別**。`saveData` の**送信パス**（:9064、空配列で
    クラウドを全消しするのを防ぐ）、`tlApplySnapshot` の初回分岐（:9079）、名簿発行（:9156）を守る
- `SF-SYNCGUARD-20260727` … お会計時にクラウド送信の成否を確認し、
  失敗をスタッフに見せる（`sfConfirmCloudSave` / `sfSyncPopup` / `sfSyncRetry`）。
  握りつぶすと「翌日にお会計待ちへ戻る」事故になるので、成否を返す設計を維持する。
  **送信失敗時は `sfSyncTrack` が該当 id を写しから引き算して巻き戻す**（:8716-8722）ので、
  次の保存で自然に再送される。「写しは常にクラウドと一致する」と仮定したコードを書かないこと。
- 差分ゼロなら `fbReconcile` を呼ばない（:8378 / :9036）。「保存したのに Promise が返らない」のは正常
- **`SF-READWINDOW-20260908` 以降、`SF_MIRROR` には日付窓内の予約しか入っていない**
  （board＝当月1日〜 / salon・notify＝昨日〜 / timely＝前月1日〜。窓開始は `window.SF_WINDOW_START`、
  起動時に1回計算し日をまたいでも張り直さない）。**「SF_MIRROR は全件」を前提にしたコードを書かないこと。**
  過去分は Phase 3/4 のオンデマンド読み（未実装）で扱う。timely の fromBoard 削除パスは
  窓内の予約だけを削除対象にしている（窓外は「削除された」のではなく「購読していない」だけ）

### 同期コードを持つファイルは12本

`SF_MIRROR = Array.isArray(...)` は **git管理下の apps/*.html 12本すべて**にあります
（board 5 / salon 3 / notify 3 / timely 1）。同期の骨格に手を入れるときの修正対象は最大12ファイル。
なお `__sfSnapshotReceived` 相当の初回ガードを持つのは **timely だけ**で、他11本にはありません。

### オフライン永続化は12本すべて（SF-OFFLINE-20260826 / SF-OFFLINE-BOARD-20260830 / SF-OFFLINE-SALON・NOTIFY-20260908）

timely（:5592-5599）・board 5本・salon 3本・notify 3本の全12本が `initializeFirestore(app,
{ localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })` で、
未送信の書き込みを IndexedDB に永続化します。タブを閉じても送信待ちが消えず、
電波が戻れば Firestore SDK 自身が再送します（salon / notify は 2026-09-08 に移植。
`apps/sf_offline_salon_notify_20260908.py`）。

- 永続キャッシュはリスナー再開時に**変わっていないドキュメントを再送しない**（＝読み取り課金されない）
  ので、読み取り削減の柱2でもある（→ `DESIGN-readwindow.md`）
- **この module ブロックより前に `getFirestore(app)` を呼ぶコードを足すと壊れます。**
  `initializeFirestore` が「already started」で同期例外を投げ、catch が既定キャッシュへ落として
  **console.warn 一行だけ残して静かに永続化が無効化されます**。初期化は `<head>` 内のこの位置に置き続けること
- オフライン中は `batch.commit()` の Promise が resolve も reject もせず保留になるため、
  `sfSyncTrack` は未送信箱に積まず、**画面上部の赤い「未送信N件」帯は出ません**

### localStorage は今も使う（ただし端末ローカル設定のみ）

`sf_board_garden_v1`（最後に選んだ園）など。**業務データの正本は Firestore** です。

---

## 4. URL パラメータ

- `?garden=tsukisamu|shiraishi|factory|shiseikan` … 園の指定。**board/salon/notify すべて対応**
  （board は SF-GARDENPARAM-20260724 で後追い対応）。採用値は localStorage にも保存される
- `?view=salon` … board をサロン閲覧モードに。保育園の定員設定ボタンを隠し、誤操作を防ぐ

ただし現場は**「1店舗＝1端末＝固定URL」**運用のため、実際には `_sp_` 版を直接ブックマークしています。

---

## 5. 編集の作法

### 5-1. 小さな1ファイルの修正

`Edit`（str_replace）でOK。**全文書き換えは禁止**（timely.html は625KB）。

### 5-2. 複数ファイルにまたがる修正 → Python パッチスクリプト

このプロジェクトの標準的なやり方です。`apps/sf_datesync_20260726.py` が良いお手本。
スクリプトは以下を満たすように書きます。

1. 冒頭の docstring に **症状 / 原因 / 直し方 / 安全設計**を日本語で書く
2. `TARGETS`（または `FILES`）に**同系統の全ファイル**を列挙する
3. アンカー文字列はファイルから programmatically 抽出し、
   **全ファイルで出現回数 == 1 を検証。1つでも違えば0バイトも書かずに中断**
4. 固有マーカー（`SF-XXXX-YYYYMMDD`）で**冪等**にする（適用済みなら skip）
5. **タイムスタンプ付きバックアップ**：`apps/board.html.bak_20260726_090840` 形式
6. `<script>` ブロックごとに `node --check` で構文検証
7. **2フェーズ**：全ファイル検証 → 全ファイル書き込み

命名は `sf_<機能>_<YYYYMMDD>.py` / `fix_<機能>.py` / `patch_<対象>_<YYYYMMDD>.py`。
`apps/` 直下に置きます（`.gitignore` 対象で、リポジトリには入りません）。

### 5-3. 構文チェック

編集後は必ず `<script>` を抽出して `node --check`。
ルートの `verify_js.py` は**別プロジェクト（strawberry-tuition）向けにハードコードされている**ので、
そのままでは使えません。パッチスクリプト内蔵のチェックを使うか、その場でワンライナーを書くこと。

### 5-4. コード内コメント

このコードベースは**「なぜそう書いたか」を日本語コメントで残す文化**です。踏襲してください。

```js
/* SF-DATESYNC-20260726/D2 : 満員でとめたときは、画面の空き状況も最新に描き直す。
   そのままだと「◎ お預かりできます」が残ってしまい、
   なぜ予約できないのかお客様にもスタッフにも分からないため。 */
```

機能ごとに `SF-<機能名>-<YYYYMMDD>` のマーカーを付け、grep で追えるようにします。

---

## 6. テスト

**素直に信じられるテストスイートはありません。** 現状は次のとおりです。

| 場所 | 中身 | 動くか |
|---|---|---|
| `test_affiliation.js` / `test_caseA_write.js` / `test_garden_4.js` | HTMLソースへの **grep ベースの配線チェック**（jsdom不要） | `node test_xxx.js` で動く。ただし `test_affiliation.js` は **既知の1件FAIL**（`新規予約 push に affiliation`） |
| `tests/board/test_board.js` | JSDOM ベース | **jsdom 未インストールのため動かない**（`node_modules` なし・`package.json` なし） |
| `tests/README.md` に列挙された timely の148件 | 過去セッションの遺産 | **ファイルが存在しない** |

新しくテストを書くなら、**grep ベースの配線チェック方式**（ルートの `test_*.js`）が
このプロジェクトで実際に動く唯一の形です。JSDOM を使うなら先に `npm i -D jsdom` が必要。

JSDOM を使う場合の既知のハマりどころ：

1. `<script>` 抽出時に `api.anthropic` を含む artifact 内スクリプトは除外する
2. localStorage モックは「実際に読み書きする」形にする（空モックだとデータ種まきが効かない）
3. `AudioContext` / `setInterval` / `requestAnimationFrame` / `alert` もモックが要る
4. ネストしたテンプレートリテラル `` `${...?`...`:`...`}` `` は構文エラー → 文字列連結に書き換える

**最終的な確認はユーザーによる実機ブラウザ確認です。** 構文 VALID ≠ 実機で動く。

---

## 7. デプロイ

### GitHub Pages（Netlify ではない）

- リポジトリ： https://github.com/meative/strawberry-field （Public）
- 本番： https://meative.github.io/strawberry-field/
- `main` へ push すると自動反映（数十秒〜数分のラグ）

```
トップ　　　 https://meative.github.io/strawberry-field/
受付　　　　 .../apps/timely.html
予約ボード　 .../apps/board.html
サロン予約　 .../apps/salon.html
お迎え通知　 .../apps/notify.html
取扱説明書　 .../docs/timely-staff-manual.html
```

- `netlify.toml` / `dist/` / `strawberry-field-app.netlify.app` は**旧構成の遺物**。触らない・言及しない
- GitHub Pages 無料版は Public リポジトリ必須。**顧客の個人情報をリポジトリに入れない**
  （データは Firestore、サンプルデータは削除済み）

### push（2026-09-08 から gh 認証。ワンタイム PAT 運用は廃止）

このMacは `gh`（`/usr/local/bin/gh`、`meative` で repo スコープ・ログイン済み）を
git の credential helper に登録済み（`gh auth setup-git` 実行済み。`~/.gitconfig` の
`[credential "https://github.com"]` が `gh auth git-credential` を指す）。
**Claude Code から `git push origin main` を直接実行してよい。** PAT を貼る必要はない。

push の前後は必ずこの手順：

```bash
git fetch origin main && git log --oneline HEAD..origin/main   # 空でなければ先に pull（§0）
git push origin main
git ls-remote origin main                                        # リモート SHA が HEAD と一致するか
```

本番へ入るファイルを push したときは、bare clone で実体を確認する（サイズ・MD5・マーカー数）：

```bash
git clone -q --bare https://github.com/meative/strawberry-field.git /tmp/sf_check
git --git-dir=/tmp/sf_check show main:apps/timely.html | wc -c
git --git-dir=/tmp/sf_check show main:apps/timely.html | md5
git --git-dir=/tmp/sf_check show main:apps/timely.html | grep -c "SF-<マーカー>"
```

別マシンで gh を使う場合はそちらでも `gh auth login` → `gh auth setup-git` が要る。

### コミットメッセージ

日本語で「何を直したか」＋「なぜそれが問題だったか」を書き、末尾に機能マーカーを付けます。

```
fix: 会計レポートの日別・月別サマリーに割引列を追加。基本料金は表示されるのに
割引額が出ず、合計0円の理由が読み取れなかった (SF-DISCOUNT-COL-20260724)
```

---

## 8. コーディング規約・デザイン

### カラー

| 用途 | 値 |
|---|---|
| ティファニー | `--tiffany: #0ABAB5` |
| ゴールド | `--gold: #C9A961` |
| インク | `--ink: #1A1F26` |
| 満員 | ボルドー `#B23E4C` |
| WOODSTOCK / BUDDY BROWN | ゴールド系 |
| JANIS | ブルー `#3F6E94`〜`#5B8DB8` |

### 書体

見出し英字 `Cormorant Garamond` italic / 和文 `Noto Serif JP` / 補助 `Inter`

### 文言

「エレガント・ニューヨーク」のトーン。接客は丁寧でやわらかい言葉遣い。
**英字ラベル（小さく italic）＋ 和文ラベル（メイン）の二段構成**が基本。
既存のセクション構造（`section-card` / `section-header` / `section-title`）を踏襲。

### データ操作

- `DATA.visits.push(...)`, `DATA.customers.push(...)` の後に `saveData(DATA)` を呼ぶ
- レコードの照合は **`sfId`（id）優先**、なければ「同名＋同開始時刻」でフォールバック
- **後方互換を維持**（古いキー名・古い値のデータも読めるようにする）
- 年齢区分は `'0'/'1'/'2'/'3'` の4種（3歳以上はすべて `'3'`）。`normAge` で正規化
- 定員は**同時人数**で判定する（1日あたりの合計ではない）。時間帯が終われば再び受け入れ可能

---

## 9. 実装済み機能（重複実装に注意）

主要な機能は `SF-*` マーカーで grep できます。`grep -o "SF-[A-Z0-9-]*" apps/timely.html | sort -u`

### timely.html（受付）

- お会計画面の構成：お客様情報 → 割引 → ご使用時間料金 → お伝え事項 → 特記事項 → 備考 → 受領者
- 割引タブ：割引なし / 通常割引 / WOODSTOCK割引 / JANIS割引。サロン経由予約は自動選択・全額入力
- 特記事項（`paymentSpecialNote`）は領収書に**表示される** / 備考（`paymentInternalNote`）は**表示されない**園内メモ
- 時間逆転バリデーション（当日入力・お会計の両方）／来園前授乳の24時間対応
- 園を跨いだ顧客検索（他園バッジ）／領収書のA4一枚レイアウト（scale 0.50）
- 食事記録は3択（食べた / 残した / 食べてない）＋ 容器返却の出し分け
- 組（きょうだい）のまとめ会計。`partyId` で束ね、領収書に「次のお子様」ボタン
- 会計レポートの日別・月別サマリーに割引列

### board.html（予約ボード）

- 年齢別定員：基本設定＋日別例外（月カレンダー・gold ドット）、空き状況サマリー
- 定員超過の事後検知（赤表示・表示のみで予約可否は不変）
- 幼稚舎の出欠チップ（`sf_kinder_attendance`）
- 区間グループ（サロンを続けて使う予約）の印と3択ダイアログ（`sfChoose`）
- `?view=salon` でサロン閲覧モード

### salon.html（サロン予約）

- 空き状況チップ3段階（残り○名 / 一部満員＋空く時刻 / 満員）
- 組（きょうだい）のまとめ予約：**人数と生年月 → 時間 → 判定 → 最後に名前**の流れ
- 2つのサロンを続けて使う区間UI（`groupId` で束ねる）
- 3歳以上も月齢表示

### notify.html（お迎え通知）

- お迎え通知・様子ログ・子の状態を端末間で共有（`sf_notify`）
- 当日分だけ表示し、日付変更を検知して自動更新
- 子の特定は**配列の添字ではなく識別子**で行う（添字だと予約を移した後に別の子へ操作が及ぶ）

### 2026-08-17〜08-27 に入った機能（`14f9cdd` で pull 済み）

この期間は Web UI アップロードで本番へ入ったため、コミットメッセージが `Add files via upload` しか
残っていません。**何が入ったかはコード内の `SF-*` マーカーからしか辿れません。**
以下は実コードを読んで確認した内容です。

| マーカー | 内容 | 入っているファイル |
|---|---|---|
| `SF-ZONE-20260817` | 会計の**区分を5種に分割**（一時預かり / WOODSTOCK / JANIS / 自園生徒・早朝 / 自園生徒・延長）。`sfZoneKey()` で判定し `sfZoneLabel()` で表示。日報CSV・月報明細CSVに**『所属』列を新設**（14列→15列） | timely のみ |
| `SF-KINDERCOUNT-20260819` | 自園生徒の早朝・延長の**件数だけ**、集計元を会計記録から共有予約（`SF_MIRROR`）に差し替え。金額は会計記録のまま | timely のみ |
| `SF-ZONECSV-20260819` | 日報・月報に「区分別CSV」ボタンを追加（区分/件数/金額の3列） | timely のみ |
| `SF-EXT-SHARE-20260824` | 早朝・延長（`ext_am`/`ext_pm`）も **`sf_bookings` に保存**するよう変更。`sfExtAffiliation()` が ext を必ず `affiliation:'youchisha'` に固定 | **board 5本すべて** |
| `SF-VERGUARD-20260826` | `tlApplySnapshot` を丸ごと置換から**レコード単位マージ**へ（→ §3【B】） | timely のみ |
| `SF-OFFLINE-20260826` | Firestore のオフライン永続キャッシュ（→ §3） | timely のみ |
| `SF-TLDELETE-20260827` | 日別レポート明細に**1件削除ボタン**。`tlConfirmCloudDelete` がクラウド反映を10秒待って見届ける。印刷時は列ごと非表示。V2（`SF-TLDELETE-V2-20260827`）で確認を標準 confirm から `sfSyncPopup` の中央モーダルに変更（**V2 も `14f9cdd` で反映済み**） | timely のみ |

**この付近を触るときの落とし穴（実コードで確認済み）:**

- **区分の追加は3箇所同時に直す。** 同じ集計ロジックが `sfBuildZoneRows`（:16471）/
  `renderDailyReport` 内（:16067-16087）/ `renderMonthlyReport` 内（:16259-16292）に**重複**しており、
  共通関数になっていません。加えて `SF_ZONE_ORDER` / `SF_ZONE_EN` / `sfZoneLabel` の3つも要更新。
  `SF_ZONE_ORDER` に無いキーは集計から静かに落ちるのに金額は合計に残り、内訳と合計がズレます
- **月報サマリーCSV（`downloadMonthlySummaryCsv`, :16630〜）だけがこの仕組みに乗っていません。**
  :16657 で生の `v.usageType` を見て3列に集計するため、サロン経由分が「一時預かり」に混ざります
- **区分の判定材料は `v.salon`（予約から引き継いだ識別子）だけで、お会計で選んだ割引タブは見ていません。**
  飛び込み来園に手動で WOODSTOCK割引を当てても区分は「一時預かり」のまま。
  **区分別内訳とサロン割引額は一致しません**
- **早朝・延長の件数は「加算」ではなく「上書き」。** ボード予約が0件の日は会計記録があっても
  件数0に上書きされ、行の表示条件（`count>0`）で**行ごと消える**のに金額は合計に残ります
- **合計人数は行の合算と一致しないのが仕様。** 早朝＋延長は同一日・同一氏名を1名に畳んだ
  実人数（`sfKinderExtCounts` の `unique`、SF-KINDERCOUNT-V2-20260819）に置き換わります
- **版ガードは更新時刻が付くレコードにしか効かない。** `tlRecTime()`（:8998）が見るのは
  `updatedAt || modifiedAt || paidAt || createdAt` の**最初に見つかったもの**（最大値ではない）。
  会計前の下書き保存 `saveHandoverDraft()`（:15377-15400）が打つのは `handoverUpdatedAt` で、
  このチェーンに**入っていません**。手元の編集がクラウド未達のままスナップショットが来ると失われます。
  **新しい編集パスを足すときは必ず `updatedAt` を打つこと**
- **会計ガードは visits 専用かつ paid→pending の一方向だけ。** customers / students には版ガードしか
  効かないので、顧客情報の編集（更新箇所は :11637 のみ）で `updatedAt` を打ち忘れると巻き戻ります
- **マージで手元を残しても写し（`TL_MIRROR[kind]`）にはクラウド側を入れます。**
  写しは「クラウドの既知状態」であって DATA の写しではありません。DATA と同じにすると
  `localWins` が差分判定から消えて再送されなくなります
- **初回スナップショット経路だけは削除を尊重しません。** `tlApplySnapshot` の初回分岐（:9080-9099）は
  `localOnly` を和集合で足し戻すため、他端末で削除した記録が古い端末の再読み込みで**復活しえます**。
  削除が確実に効くのは購読中のタブが通る2回目以降の経路（:9103-9104）です
- **board.html:2479 の行内コメント「ext は呼び出し側で除外済み」は SF-EXT-SHARE 以降は嘘です**
  （5本すべてに同じ古いコメントが残っています）。これを信じて「ext は共有されない」前提で触ると、
  timely の区分別内訳・区分別CSVの早朝・延長件数が壊れます
- `sfZoneChanged()` は幼稚舎チェックを**入れるだけで外しません**。ext のコマを開いた後に区分を
  一時預かりへ戻すと `affiliation:'youchisha'` の temp レコードができ、ボードにも「幼稚舎」バッジが出ます

### 2026-08-29〜09-01 に入った機能（別マシンで実装・`51c416e` で pull 済み）

この期間は**別マシンの Claude Code** で実装され、通常のコミットメッセージとマーカーが残っています
（`git log 14f9cdd..51c416e` で17コミット）。対象ファイルはコミットの実測です。

| マーカー | 内容 | 入っているファイル |
|---|---|---|
| `SF-DISCLABEL-GARDEN-20260827` | 白石園の割引表記 | timely |
| `SF-KINDER-AGE-20260829` / `-V2` | 幼稚舎の予約も名簿から実年齢表示 | board 5本 |
| `SF-RESBADGE-20260829` / `SF-PENDDEL-20260829` | 予約バッジを本日以降のみに／会計待ちに削除ボタン | timely |
| `SF-JSTDATE-20260830` | 日付をUTCではなくJST基準に（早朝受付が前日で記録される不具合を修正） | timely |
| `SF-RESCONSUME-20260830` | 予約カード以外の入り口から受付しても予約を受付済みに（二重受付・予約の溜まり解消） | timely |
| `SF-OFFLINE-BOARD-20260830` / `SF-UPDATEDAT-BOARD-20260830` | board にもオフライン永続化と予約の `updatedAt`（→ §3） | board 5本 |
| `SF-TOURFREE-20260830` | 見学会の無料預かり・体験2時間無料券を区分に追加 | timely |
| `SF-RESFIX-20260830` | 区間②の孤児化・サロン判定のガード・組の `partyId` 伝搬を修正 | timely |
| `SF-BOARDBASE-ROLL-20260830` | ボードが日をまたいでも本日のままになるよう基準日を作り直す | board 5本 |
| `SF-PAYDATE-20260830` | お会計待ちを日付で区切り、本日より前の件に注意を表示 | timely |
| `SF-NOTIFYRECV-20260830` / `SF-NOTIFYSOUND-20260830` | お迎え通知が受信側で鳴らない問題を修正 | notify 3本 |
| `SF-SALONMANUAL-20260830` | サロン未設定の記録でも割引から区分を判定し割引額を自動入力 | timely |
| `SF-CAPLABEL-20260830` / `SF-BOARDCHIME-20260830` | 定員表示を実際の設定から生成／サロン予約のチャイム | board 5本 |
| `SF-DUPGUARD-20260830` | 同じ日に同じお子様を二度受付しようとしたら確認を出す | timely |
| `SF-CUSTADDR-20260831` | 顧客情報の編集にご住所と緊急連絡先を表示 | timely |
| `SF-DELGUARD-20260831` | 指示していない削除を実行させないデータ消失防御 | timely + board 5本 |
| `SF-XPARK-20260901` / `SF-AMPMPARK-20260901` | 他園所属の幼稚舎生を早朝・延長のチップに表示 | board 5本 |

これにより以前の懸案のうち **board のオフライン永続化・日付のUTCズレ・予約の消化漏れ・
二重受付**は解決済み。§3 の「オフライン永続化」「落とし穴」を読むときはこの表も前提にすること。

---

## 10. 作業の進め方（このプロジェクトの約束事）

- **1ステップずつ**：バックアップ → 編集 → 構文チェック → **ユーザーの実機ブラウザ確認** → コミット
- **実機確認前にコミットしない。**
- **承認は option 1 (Yes) のみ。option 2（bulk-allow / don't ask again）は押さない。**
- **`dangerouslyDisableSandbox` に反射的に Yes しない。** 読み取り操作でも拒否が正解のことが多い
- `git add` はファイル明示。`git add .` / `-A` は不可
- 作業前に `pwd` 確認（別プロジェクト `strawberry-tuition` への迷い込み防止）
- Edit は「適用したつもりで未適用」が起きるので、**必ず grep / sed で実物を確認**する
- **リモート SHA は `git ls-remote` で直接確認する。** ローカルの `origin/main` は古いことがある

### 環境

- ローカル：`~/Documents/strawberry-field`（**作業マシンは2台。必ず pull から始める → §0**）
- 開発：Mac / Terminal.app / Claude Code
- ブラウザ実機操作・スクリーンショット・コンソール実行は**ユーザー側**が行う（Chrome DevTools）
- Chrome のコンソールは `allow pasting` を一度打つと貼り付け可。
  **日本語を含むコンソールペーストは SyntaxError になるので JS のみ**
- macOS の `Operation not permitted`（git が書類フォルダにアクセス不可）対処：
  システム設定 → プライバシーとセキュリティ → フルディスクアクセス → ターミナルをオン → 再起動

---

## 11. 古い情報に注意

以下は**リポジトリに残っているが、現状と食い違います**。参照するときは注意してください。

| ファイル | 何が古いか |
|---|---|
| `README.md` | localStorage連携・Netlify Drop・Firebase移行予定 → **全部旧情報** |
| `HANDOFF.md` | v13 / 2026-06-26 で更新停止。以降2ヶ月分の作業が反映されていない |
| `DESIGN-status-sync.md` | 「設計確定・実装未着手」→ 実装済み（SF-NOTIFY-CLOUD-20260723） |
| `planning/project-overview.md` | localStorage前提の初期仕様書。デザイン規約の参照には今も有効 |
| `planning/firebase-roadmap.html` | 移行計画。移行はほぼ完了済み |
| `netlify.toml` / `dist/` | Netlify時代の遺物 |
| `verify_js.py` | パスが別プロジェクト（strawberry-tuition）にハードコード |
| `tests/README.md` | 列挙されている148件のテストファイルは存在しない |

---

## 12. 関連ファイル

- `README.md` — プロジェクト全体ガイド（※旧情報あり・上記参照）
- `planning/project-overview.md` — 初期仕様書（デザイン規約 §1 は現役）
- `docs/timely-staff-manual.html` — スタッフ向け取扱説明書
- `docs/distribution-guide.html` — 配布ガイド
- `docs/onboarding-guide.html` — 進め方ガイド
