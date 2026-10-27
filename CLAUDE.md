# CLAUDE.md — Claude Code 向け開発ガイド

STRAWBERRY FIELD 予約システムを Claude Code で扱うときに、最初に読んでください。
（最終更新 2026-10-27 / 全面改訂は 2026-08-28）

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
cd ~/dev/strawberry-field
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
  購読に日付窓 `SF-READWINDOW-20260908`）
- **2026-09-30：Phase 3・4 完了・本番反映済み**（過去月のオンデマンド読み `SF-ARCHIVE-BOARD-20260930` /
  `SF-ARCHIVE-TIMELY-20260930`）。購読窓は据え置き。設計・状態・作業ログは **`DESIGN-readwindow.md`** が正

### 作業ログ

- 2026-09-05：5/29 のテストデータ4件（髙嶋 英憲・英二／ファクトリー・月寒／合計¥7,000）を
  お会計待ちから削除。詳細はローカルメモ（`claude/` 配下・git管理外。顧客名を含むため
  ファイル名はここに書かない）

## 0.6 残タスク（未着手）

- **領収書番号の採番ズレ**（2026-09-25 の SF-DUPBLOCK 検証で発見・別件）：
  `approvePayment()` の連番は「当日 `paidAt` が付いた visits を自分込みで数え直す」方式
  （timely.html の `sameDayCount`、SF-JSTDATE-20260830 のコメント付近）。端末単体では冪等だが、
  会計の合間に**他端末の会計が同期で届く／会計記録が削除される**と数が変わり、
  番号の重複・飛びを作りうる。直すなら「当日の最大番号+1」方式か採番の永続化。
  現状は実害報告なし・優先度低。

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
| `fleet.html` | **端末一覧（本部用・読み取り専用）**。sf_devices を購読し lastSeen が進まない端末を可視化（SF-FLEETVIEW-20261022）。**同期12本には数えない**（SF_MIRROR 等の同期骨格を持たない13本目） | 本部 |

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

行番号は `14f9cdd`（2026-08-27）時点の `apps/timely.html`（【A】のみ。【B】は 2026-10-07 の
SF-CLOUDFIRST-S1〜S3 で作り直したため、行番号ではなくマーカーで grep すること。
設計・経緯・移行手順は **`DESIGN-cloudfirst.md`** が正）。

```
【A】共有予約 sf_bookings … 丸ごと置換（従来どおり）
  onSnapshot ─▶ window.sfApplySnapshot(arr)          :8391
               └─ SF_MIRROR = arr        ← 無条件の置換。版ガードは無い
               └─ importBoardReservations() で DATA.reservations へマージ取り込み

【B】受付業務データ sf_visits / sf_customers / sf_students … クラウドが唯一の正本
     （SF-CLOUDFIRST-S1/S2/S3-20261007。マージ・写し・初回送り返しは廃止）
  onSnapshot ─▶ window.tlApplySnapshot(kind, rows)
               └─ DATA[kind] = rows      ← 丸ごと置換。マージしない・送り返さない
               └─ TL_READY[kind] = true → saveViewCache（表示キャッシュ）→ tlRerender
  書き込みは操作1回＝その1件だけ：
    tlPut(kind, rec) ─▶ fbPutTl    = setDoc    （updatedAt を必ず刻印。paid を pending で潰す書き込みは拒否）
    tlDel(kind, id)  ─▶ fbDeleteTl = deleteDoc （削除は明示 id のみ。差分からの削除算出は存在しない）
    予約消費          ─▶ fbPatchBooking = updateDoc（対象外フィールドは無傷）
  TL_READY が3種揃うまで、書き込み操作11箇所は tlGateWrite で不活性（「クラウドと同期中です」）
  見届け（SF-UNSENTBOX-20261014）：tlPut / tlDel の promise が10秒未決着・失敗なら
    赤帯「未送信 n件」＋localStorage の未送信箱 timely_unsent_box_v1（kind・id・rec・at）に控え、
    起動時（初回同期後）・online 復帰・sfWakeSync 後・赤帯タップで同じ id を再送（冪等）。
    箱に入るのは自分が tlPut / tlDel した1件だけ。snapshot 由来は構造上入らない。7日超は知らせるだけ
```

送信側の差分化（sfChangedOnly → fbReconcile の writeBatch）は **sf_bookings（A）だけ**になった。
timely の業務データ（B）は常に1件書きで、localStorage は仮表示キャッシュ（`saveViewCache`）に格下げ。
**DATA[kind] を書き戻しの材料にするコード・配列を丸ごとクラウドと突き合わせるコードを書かないこと。**

- 関数名：board/salon/notify は `sfLoad` / `sfSave`、timely の共有予約の読みは `sfLoadShared`
  （`sfSaveShared` は board 系との共通骨格として残っているが **timely からはもう呼ばれない**。
  timely の共有書きは sfUpsertShared / sfRemoveShared(Many) / sfPatchBooking の1件書き）
- `sfCanon()`（:8329）… キー順に依存しない正規化JSON。差分判定に使う
- `sfChangedOnly(next, prev)`（:8343）… **変わったレコードだけ**書く（**sf_bookings 側のみ**）。
  かつて1件の保存でコレクション全件を書き直し、Firestore の1日あたり書き込み上限を
  使い切って本番の保存が止まった（SF-WRITEDIFF-20260724）。**この差分化を壊さないこと。**
- **初回スナップショットのフラグは2系統ある。** 片方を見て「ガード済み」と判断しないこと。
  - `window.__sfSnapshotReceived` … **sf側・単一**。「共有側で消えた fromBoard 予約を
    DATA.reservations から消す」**削除パス**を守る
  - `TL_READY`（旧 TL_SNAP_SEEN）… **tl側・kind別**。初回 snapshot が3種揃うまで書き込み操作を
    止めるゲート（`tlGateWrite` ＋ tlPut / tlDel の最終防衛線）と、名簿発行・SF-RESMATCH を守る。
    注意：匿名認証が失敗する真の圏外では立たないが、**認証成功＋Firestore 不達**では
    persistentLocalCache が**空の fromCache snapshot を配って立つ**（DESIGN-cloudfirst.md 未決事項2）
- `SF-SYNCGUARD-20260727` … お会計時にクラウド送信の成否を確認し、
  失敗をスタッフに見せる（`sfConfirmCloudSave` / `sfSyncPopup` / `sfSyncRetry`）。
  握りつぶすと「翌日にお会計待ちへ戻る」事故になるので、成否を返す設計を維持する。
  送信失敗時の再送：sf_bookings 側は該当 id を写し（SF_MIRROR）から引き算して巻き戻す。
  tl 側は写しが無く、未送信箱（SF_SYNC.queue）→ `fbReconcileTl`（再送口として存続）で送り直す。
  「写しは常にクラウドと一致する」と仮定したコードを書かないこと。
- 差分ゼロなら `fbReconcile` を呼ばない（sf_bookings 側）。「保存したのに Promise が返らない」のは正常。
  tl 側は tlPut / tlDel が常に1件書きの Promise を返す（ゲートや会計ガードで拒否されたときは null）
- **`SF-READWINDOW-20260908` 以降、`SF_MIRROR` には日付窓内の予約しか入っていない**
  （board＝当月1日〜 / salon・notify＝昨日〜 / timely＝前月1日〜。窓開始は `window.SF_WINDOW_START`、
  起動時に1回計算し日をまたいでも張り直さない）。**「SF_MIRROR は全件」を前提にしたコードを書かないこと。**
  過去分は Phase 3/4 のオンデマンド読み（`SF-ARCHIVE-BOARD-20260930` / `SF-ARCHIVE-TIMELY-20260930`、
  下の 2026-09-30 の表）で扱う。timely の fromBoard 削除パスは
  窓内の予約だけを削除対象にしている（窓外は「削除された」のではなく「購読していない」だけ）
- **board の `sfLoad()` は SF_MIRROR ＋ 過去月アーカイブ（`SF_ARCHIVE`）の合成ビュー**（SF-ARCHIVE-BOARD-20260930）。
  写しだけが要るときは `sfLoadLive()`。`sfSave()` は窓内／過去月に振り分け、**削除対象の算出は SF_MIRROR だけ**
  （アーカイブ由来は差分計算で決して削除されない。明示削除は `sfArchiveDeleteExplicit`）。
  **アーカイブを SF_MIRROR に混ぜるコード・アーカイブを削除計算に入れるコードを書かないこと**

### 同期コードを持つファイルは12本

`SF_MIRROR = Array.isArray(...)` は **git管理下の apps/*.html 12本すべて**にあります
（board 5 / salon 3 / notify 3 / timely 1）。同期の骨格に手を入れるときの修正対象は最大12ファイル。
なお `__sfSnapshotReceived` 相当の初回ガードと、業務データの TL_READY ゲート・1件書き
（SF-CLOUDFIRST）を持つのは **timely だけ**で、他11本にはありません。

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
| `tests/playwright/` | **Playwright**。`stubs.js` が gstatic の Firebase を偽物に差し替えるので本番に触れない（2026-09-30〜） | `npm i -D playwright && npx playwright install chromium` の後 `node tests/playwright/test_*.js` |

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

### 本番 smoke は読み取り専用（2026-10-27 の事故から・★厳守）

2026-10-27、リリース確認の smoke（Playwright で本番 URL を開くだけ）が **本番に書き込んだ**。notify は起動時の初回
nfSave で sf_notify の n ドキュメント（キャンセル通知・key 収束）を新しい ts で書き直し、現場の全端末に
「15:24 受信」のキャンセルカードを再着信させた（SF-CXLACK-20261027）。本番ページを開けば端末台帳（sf_devices）の
setDoc も走る。**「開くだけ」は書き込みである。**

- 本番 URL を開く確認は **`tests/prod/smoke_notify_readonly.mjs`**（Firestore SDK の setDoc / updateDoc / deleteDoc /
  addDoc / writeBatch / runTransaction を SDK の層で無効化してから開く。遮った件数を `blocked` に出す）だけを使う。
  board / salon / timely の smoke を作るときも同じ仕組みで書き込みを遮ること
- **書き込みを伴う確認**（E2E・ルールの裏取り・Functions の発火確認）は、**テスト園 `gardenId='smoke'` の予約**か、
  **存在しない bookingId（`probe-…`）** だけで行う。本番の園・本番の予約・本番の sf_notify には触らない
- 本番 URL を手元のブラウザで開くときも同じ（端末台帳に Mac の端末が増え、notify は初回 nfSave を書く）。
  見るだけなら REST の読み取り（`tests/nfserver/compare_shadow.mjs` 方式）で代替する

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
- **（2026-10-07 更新）この表の時代にあった tl 側のマージ・版ガード・会計ガード・写し（TL_MIRROR）・
  初回スナップショット経路は、SF-CLOUDFIRST-S1〜S3-20261007 でまるごと置き換えました**（→ §3【B】）。
  「初回経路が削除を尊重せず、他端末で消した記録が復活する」問題（9/25・10/2）もこれで根治。
  下書きの `handoverUpdatedAt` が版ガードに乗らない穴も、tlPut が `updatedAt` を必ず刻印する形で解消。
  現存するガードは tlPut の pending-over-paid 拒否（比較相手は DATA＝クラウドビュー）と
  TL_READY ゲートだけ。**新しい書き込みパスは必ず tlPut / tlDel を通すこと**（fbPutTl 直呼び禁止）
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

### 2026-09-11 に入った機能

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-EXTFEE19-20260911` | **自園生徒の早朝・延長料金を実お迎え時刻で判定**（設計: DESIGN-extfee19.md）。延長は19:05まで全員¥0・19:06以降（20:00閉園まで）¥700を1回だけ（延長月極 `monthlyPm` の子は常に¥0）。早朝は¥700（早朝月極 `monthlyAm` は¥0）。旧・20時超+350の加算は自園生徒では廃止。月極判定は月謝アプリの公開名簿 `kindergarten_public/roster`（timely も board と同じ2つ目アプリで購読）。フラグ無しは「月極なし」扱い。**月極の¥0会計は会計記録を作らない**（件数は SF_MIRROR から数えるので日報・月報は不変）。内部生タブ上部にボード予約のワンタップ受付（ext_am は月極でない子だけ・visit に sfId を控え二重受付防止）。境目は `SF_EXT19_CUTOFF`、金額は `USAGE_TYPES.*.flatRate` | timely のみ |

⚠ 料金・集計の前提: 早朝・延長の**件数**は従来どおり sf_bookings（`sfKinderExtCounts`）、**金額**は会計記録（visits）。SF-EXTFEE19 で金額側の決まり方だけが変わり、件数集計・売上合計の集計方法・youchisha×ext の取込除外（SF-KINDER-TIMELY-HIDE-STEP4-V6）は無改変。

### 2026-09-30 に入った機能

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-RESMATCH-20260930` | ボード由来（`sf:` キー）の予約から「当日入力を開く」で、**先に DATA.customers を探す**（guestName / guestKana を `sfDupKata` で正規化、完全一致＋2文字以上の前方一致）。完全一致1件→当日入力（`_pendingResSfId` 保持でサロン割引・tlDone 消費は従来どおり）／前方一致だけ・複数→生年月日つき選択モーダル（`sfSyncPopup`）／0件→`TL_SNAP_SEEN.customers`（現 `TL_READY.customers`）が立っていれば新規登録、未同期なら「顧客データを同期中です」で止まる。従来は無条件に新規登録へ飛ばしており、顧客重複（9/8・9/30）の入口だった | timely |
| `SF-ARCHIVE-BOARD-20260930` | **過去月のオンデマンド読み（Phase 3）**。表示日付が窓より前になったら、その月の sf_bookings を `getDocs` で1回だけ読み `SF_ARCHIVE['YYYY-MM']` に月単位でキャッシュ（クエリは date 範囲のみ。gardenId 条件は複合インデックスが要るので手元で絞る）。`sfLoad()` は合成ビュー、`sfSave()` は振り分け＋削除計算は写しのみ。過去月は閲覧専用（帯「過去の月（閲覧のみ）」、「この月を編集可能にする」で解除）。カレンダーは読み込んだ月だけドット、未読込は薄く＋「この月を読み込む」 | board 5本 |
| `SF-ARCHIVE-TIMELY-20260930` | **日報・月報の過去月（Phase 4）**。窓より前の日付／月を選んだら同じ方式で `SF_ARCHIVE_TL` に読み、`sfKinderExtCounts` の集計元だけ「写し＋アーカイブ」に（件数のみ・金額は sf_visits・CSV も同じ数）。DATA.reservations・削除パス・予約リストは無改変 | timely |
| `SF-WAKESYNC-20260930` | タブが前面に戻ったら（visibilitychange / pageshow persisted）`disableNetwork`→`enableNetwork` で接続を張り直す。最終受信から90秒以上なら ヘッダーに「同期待ち」（`#sfWakeBadge`）を出し、サーバー確定（fromCache=false）の snapshot で消す。iPad で同一 origin の複数タブを開くと multiTab のプライマリタブが凍結される疑い（9/30 朝の同時空白）への対処。`persistentSingleTabManager` への切替は現場の切り分け待ち | 12本すべて |

顧客重複の再検出は読み取り専用スクリプト（クラウドの sf_customers / sf_visits を匿名認証で読むだけ）で行い、
結果と統合手順は `claude/dup_report_20260930.md`（git 管理外・顧客名を含む）に置いた。

これにより以前の懸案のうち **board のオフライン永続化・日付のUTCズレ・予約の消化漏れ・
二重受付**は解決済み。§3 の「オフライン永続化」「落とし穴」を読むときはこの表も前提にすること。

### 2026-10-07 に入った機能（SF-CLOUDFIRST：timely 保存層の作り直し）

設計・経緯・移行手順・E2E 結果は **`DESIGN-cloudfirst.md`** が正。§3【B】はこの構造で全面書き換え済み。
7/27 巻き戻り・8/26 再発・8/31 入力消失・9/25 と 10/2 の削除復活・10/7 容量超過消失の
根（localStorage の DATA 配列を正本とした配列まるごとの突き合わせ）を止めた。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-LSQUOTA-20261007` | localStorage 上限超過（署名画像 約4.8MB）でも会計・受付をクラウドへ必ず送る。キャッシュから signature を除外、premig 退避を削除、赤帯「保存領域がいっぱいです」 | timely |
| `SF-CLOUDFIRST-S1-20261007` | **書き込み層**：操作1回＝その1件だけを setDoc / updateDoc / deleteDoc（tlPut / tlDel / saveSettings / tlOpBegin / sfPatchBooking、module 側 fbPutTl / fbDeleteTl / fbPutBooking / fbPatchBooking / fbDeleteBooking）。saveData 25箇所＋sfSaveShared 系6箇所を置換。管理機能（JSON読込・全消去・サンプル投入）は封印、JSONエクスポートは残す | timely |
| `SF-CLOUDFIRST-S2-20261007` | **読み込み層**：snapshot を DATA[kind] へ丸ごと置換。マージ・写し（TL_MIRROR）・初回 localOnly 送り返しを廃止（削除復活の根治）。TL_SNAP_SEEN → TL_READY に改名し、書き込み11入り口を tlGateWrite で同期前不活性に。会計ガードは tlPut の pending-over-paid 拒否として存続 | timely |
| `SF-CLOUDFIRST-S3-20261007` | **後片付け**：tlIdSet / tlRecTime / tlMergeByVersion / tlReconcile / saveData を削除、封印済み loadSampleData の旧本体を削除、saveDataLocalOnly → `saveViewCache` に改名 | timely |

検証は `tests/playwright/test_cloudfirst.js`（26項目）＋既存6本、本番 E2E は Playwright
headed（スタブ無し・REST 読み取りで裏取り）。残タスクは Step 4：4園 iPad の同日再読み込みと
1週間の経過観察（混在期間は旧端末側にのみ旧事故の確率が残る。形式は相互互換で壊れない）。

### 2026-10-15 に入った機能（SF-UNSENTBOX：未送信箱と受付証跡）

10/13・10/14 に内部生（早朝・延長）の受付 visit が**全園でクラウドに届かないままリロードで消えた**。
原因は「setDoc が失敗せず未決着のまま端末がリロード/タブ破棄される」経路：赤帯と SF_SYNC.queue は
Promise の決着しか見ておらず、どちらもメモリのみ（S2 が localStorage 救済マージを廃止して以降、
この取りこぼしは完全消失になる）。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-UNSENTBOX-20261014` | **案A（未送信箱）**：tlPut / tlDel の promise に10秒の見届け。未決着・失敗は赤帯「未送信 n件」＋localStorage の未送信箱 `timely_unsent_box_v1`（kind・id・rec・at）へ控え、成功の決着で外す。起動時（初回同期3種後に1回）・online 復帰・sfWakeSync 後・赤帯タップで fbPutTl / fbDeleteTl 再送（冪等）。再送前にクラウドビューの updatedAt と照合（同版以上＝届いた）、削除後の書き直しを尊重、paid を pending の控えで潰さない、**7日超は知らせるだけで自動でも手動でも再送しない**。箱に入るのは自分が書いた1件だけで snapshot 由来は構造上入らない（削除復活の根絶は不変）。**案B（受付証跡）**：sfKinderTapIn と submitInternalUsage（同園・同日・同区分・氏名 trim 一致で1件に決まるときだけ）が予約へ `sfPatchBooking(id,{tlDone,tlVisitId})`。受付済み判定・再受付可否は従来どおり visit 側で tlDone は参照しない。**案C（張り直し）**：書き込み直前、最終 snapshot 受信から90秒超なら sfWakeSync() を先に実行 | timely |

検証は `tests/playwright/test_unsentbox.js`（16項目。stubs.js の `window.__fsHang` で「失敗せず
永遠に未決着」を再現）＋既存7本 ALL PASS、本番 E2E 14項目（ファクトリー・テスト予約→タップ受付→
visit 到達・tlDone / tlVisitId 付与・他フィールド無傷→削除→残骸ゼロ）。
test_cloudfirst [1] は案Bで「受付1回＝ set 1件＋予約への patch 1件」に仕様変更済み。

### 2026-10-15 に入った機能（SF-TOMBSTONE / SF-WRITESTAMP / SF-DEVICES：墓石・書き込み刻印・端末台帳）

10/7 に削除した会計待ち2件が 10/8 朝 07:40 に復活していた（REST の createTime=updateTime が2件とも
同一マイクロ秒＝単一 writeBatch・updatedAt 無し・旧フィールド構成）。**旧版ページを開いたままの端末が
旧コードの「初回送り返し」で書き戻した**もの。書いた端末・版がクラウドに何も残らず特定に手間取った。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-TOMBSTONE-20261015` | 削除の墓石。tlDel が `sf_tombstones/{id}` に {kind, deletedAt, by} を書き、購読側（tlApplyTombstones / tlSweepTombstoned）が「墓石付き id が snapshot に現れたら自動で deleteDoc し直し・表示からも除く」（ログ `[SF-TOMBSTONE] revived=`）。墓石は90日保持（超えたら効かせず、1回8件まで掃除）。墓石を書くのは自分の tlDel だけで snapshot からは作らない | timely |
| `SF-WRITESTAMP-20261015` | 書き込み刻印。全 setDoc / updateDoc / batch.set のペイロードに `_w:{dev, ver, at}`（端末ID・版・時刻）。既存フィールドは不変。**sfChangedOnly の差分判定からは sfStripW で _w を除外**（混ぜると毎回「全件変わった」になり全件書き直しになる） | 12本 |
| `SF-DEVICES-20261015` | 端末台帳と版確認。起動時・前面復帰時に `sf_devices/{dev}` へ {garden, app, ver, ua, iosVersion, lastSeen, tabsHint} を setDoc（1端末1件）。`sf_config/version` の ver と自分の `SF_APP_VER` が違えば自動再読込（**1日1回まで**・入力中＝activeElement か `window.__sfBusyHint()` は後回し）。端末IDは localStorage `sf_device_id_v1`（同一端末の12本で共通） | 12本 |

**リリース手順（版の刻印）**：①実装をコミット → ②その短縮SHAを12本の `const SF_APP_VER = '…'` に
刻印する版コミット → push → ③ REST で `sf_config/version` に {ver: 短縮SHA} を書く。③を忘れると
版確認は何もしない（リロードループはしない）。パッチは `apps/sf_fleet_20261015.py`（アンカー一意検証つき）。
検証は test_tombstone.js（9項目）・test_fleet.js（12本×4）・test_devices.js（7項目）＋既存8本 ALL PASS。

### 2026-10-16 に入った機能（SF-SINGLETAB：persistentSingleTabManager への切替）

白石（10/16 朝・ボードと受付）と月寒（10/15 17:10・ボード）で「同期待ち」が出たまま復帰しない
事象。multiTab では同一 iPad の**別タブ（通知）が代表タブのまま背面で凍結**し、前面のタブが
サーバーと通信できなくなる（通知だけ操作できた＝通知が代表だった）。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-SINGLETAB-20261016` | persistentLocalCache の tabManager を multiple → **single** に。各タブが自分でサーバーとつながるため代表タブ凍結の巻き添えが構造的に消える。永続キャッシュは先着1タブ（Web Locks `sf_fs_persist_v1`・タブを閉じると自動解放）。2つ目以降のタブは **memoryLocalCache** にフォールバックし、console.warn＋ヘッダー小バッジ「このタブはオフライン保存なし」（業務は継続。未送信の救済は SF-UNSENTBOX の localStorage 未送信箱が担う）。Web Locks が無い旧 Safari は従来どおり永続を試す。購読開始は `__sfDbReady`（先着判定）を待ってから。SF-WAKESYNC の「同期待ち」判定・張り直しは据え置き | 12本 |

パッチは `apps/sf_singletab_20261016.py`（12本×6編集・アンカー一意検証）。検証は
test_singletab.js（19項目）＋既存11本 ALL PASS。本番 E2E は Mac で timely と board を同一ブラウザの
2タブで開き、両タブが各自サーバー snapshot を受信（REST で入れた変更が両方に届く）・「同期待ち」なし・
2タブ目にバッジ・書き込み1件到達を確認。

### 2026-10-16 に入った機能（SF-HOMESCREEN：ホーム画面に追加＝独立アプリ化）

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-HOMESCREEN-20261016` | iPad の「ホーム画面に追加」で各アプリが独立アプリ（standalone）として開く。head に apple-mobile-web-app-capable / status-bar-style / **title（受付・ボード・サロン・通知＋園名）** / apple-touch-icon（`apps/icons/` の4色アイコン：受=ティファニー・ボ=藍・サ=茜・通=若葉）/ **manifest（`<base>.manifest.json`、display:standalone・start_url=自分自身）**。timely は capable / status-bar-style 既設のため title 以降のみ追加。standalone 起動は `navigator.standalone` / `display-mode: standalone` で検知し、**台帳（sf_devices）に standalone:true を記録**・ヘッダーに小バッジ「アプリ版」。アプリ間リンクは12本に `<a href>` / window.open / target=_blank / location 遷移が**存在しない**ことを確認（今後足すときは同一ウィンドウ遷移 `location.href` のみ。standalone で別窓は Safari に抜ける） | 12本 |

**領収書印刷（sfPrintReceipt）の standalone 実機確認手順**（未実施。iPad 実機が要る）：
1) iPad の Safari で timely を開き、共有 →「ホーム画面に追加」 2) ホームのアイコン（受）から起動し、
ヘッダーに「アプリ版」が出ることを確認 3) 会計済みの明細から領収書を開き「印刷」をタップ
4) AirPrint のダイアログが出て印刷できれば OK。**無反応・ダイアログが出ない場合は standalone の
window.print 非対応**（sfPrintReceipt は隠し iframe → print の作り）。その端末は Safari 版で印刷する
運用に戻し、結果を報告すること（NG なら印刷ボタンだけ Safari で開く代替を別タスクで入れる）。
検証は test_fleet.js に追加（12本のソース検査＝メタ5点・manifest 内容・アイコン実在、
standalone 模擬で台帳 standalone:true＋バッジ「アプリ版」、通常起動は standalone:false）＋既存12本 ALL PASS。

### 2026-10-16 に入った機能（SF-KBFIX：standalone のキーボード不出対策＋退避フラグ）

白石 JANIS の iPad で、standalone（アプリ版）の salon_sp_shiraishi の「予約のお名前」欄を
タップしても**ソフトキーボードが出ない**（フォーカスは当たり「ペースト」だけ出る。Safari では出る）。
コード点検では #mName を塞ぐ経路なし＝fixed オーバーレイ内 input の standalone 固有の WebKit 挙動。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-KBFIX-20261016` | (a) `input, textarea, select { -webkit-user-select: text !important }` を head 末尾に追加（祖先の user-select:none を恒久的に打ち消す。salon 系の `[onclick]` 一括 none ルールの将来の巻き込みも封じる。Safari では無害）。(b) **standalone のときだけ** touchend（ユーザー操作の同期内）で入力欄を明示 focus してキーボードを呼ぶ。(c) **退避フラグ**：`sf_config/standalone` の `enabled=false` で capable メタを no に反転し manifest link を除去（以後の「ホーム画面に追加」は通常タブで開く）。standalone 実行中の端末には赤バッジ「アプリ版停止中・Safariで開き直してください」（既にアプリ版の端末はアイコンの再追加が必要） | 12本 |

**実機確認手順（白石のサロン iPad）**：1) アプリ版（受/サのアイコン）を起動し直す（版が
上がっていなければ一度開き直す。バッジ「アプリ版」を確認） 2) 年齢→時間→「予約のお名前」
モーダルで名前欄をタップ 3) **ソフトキーボードが出て入力できれば OK** 4) 出ない場合は
欄をもう一度タップ（touchend フォールバックが効く）。それでも出なければ
`sf_config/standalone` の enabled を false にして（Firebase コンソールか REST）、ホーム画面の
アイコンを**削除→再追加**すると通常タブ起動に戻る。結果を報告すること。
検証：キーボードは実機でしか出ないため Mac では回帰のみ（test_fleet に CSS 存在と退避フラグの
動作＝capable反転・manifest除去・赤バッジを追加）。全12スイート ALL PASS。

### 2026-10-22 に入った機能（SF-NETWATCH：接続の見張り番＋本部の端末一覧）

発端：10/22 15:01〜16:30、月寒 board（アプリ版）が**前面のまま** Firestore と通信できなくなり、
ボードが空に見え9月の読み込みも失敗（クラウドのデータは無事）。SF-WAKESYNC は前面復帰
イベント駆動のため「前面のまま静かに死ぬ」凍結を誰も検知できず、sf_devices の lastSeen も
起動/復帰時にしか打たれないので本部からも見えなかった。復旧は端末の再起動。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-NETWATCH-20261022` | **接続の見張り番**。30秒ごとに最終サーバー確認（sfWakeLastSnap）を見て、2分以上あいたら 段階1=確認リスナーのみ（購読中と同じクエリ＝**追加読み取りなし**）→15秒待つ → 段階2=sfWakeSync（張り直し）→15秒待つ。連続2回失敗で大赤帯「⚠ 通信が止まっています／アプリを開き直してください」（タップで即再試行・サーバー確認が取れた瞬間に自動で消える＝sfWakeMarkSnapshot をラップ）。生存確認のたび **10分に1回を上限に sfDeviceBeat で lastSeen を進める**（ハートビート）。画面が隠れている間は何もしない（スリープ中の空振り・書き込みを避ける）。閾値・状態は `window.SF_NW`、tick は `window.__sfNetWatchTick(force)` | 12本 |
| `SF-BOARDROSTER-20261022` | ボード「予約を追加」の氏名候補を **sf_roster/all**（サロンと同じ軽量名簿）につなぐ。2026-07-22 のサンプル名簿削除以降 `REGISTERED` が空配列のままで「この行に登録者はいません」が常時出ていた（10/22 調査⑤で再発見・接続の問題ではない）。候補の選択は丸め年齢の近似ではなく**名簿の実生年月**をセット（無ければ未選択のまま）。未受信は「名簿を同期中です」で本当の0件と区別 | board 5本 |
| `SF-FLEETVIEW-20261022` | **本部用の端末一覧 `apps/fleet.html`**（新規・読み取り専用・一切書き込まない）。sf_devices を購読し、lastSeen 15分未満=稼働中／15〜60分=**「進んでいません」**（スリープか凍結・圏外）／60分超=オフ に振り分け。配信中の版（sf_config/version）と違う端末は「旧版」で強調。standalone バッジ・tabsHint・iOS 版も表示。index.html にリンク（本部用） | fleet.html + index.html |

**lastSeen の読みかた（NETWATCH 以降）**：画面が点いていて接続が生きている端末は最長10分ごとに
進む。**営業時間中に15分以上進まないボード・受付端末は現場へ声かけ**（スリープか凍結）。
パッチは `apps/sf_netwatch_20261022.py`（12本・アンカー一意検証・node --check）。
検証は test_netwatch.js（board 完全シナリオ＋残り11本＋fleet.html の 23項目）・
test_boardroster.js（board 5本 × 7項目）＋既存12スイート ALL PASS。
パッチは `apps/sf_boardroster_20261022.py`（board 5本・アンカー一意検証・node --check）。

### 2026-10-27 に入った機能（SF-NFGUARD2：お迎え通知の「復帰直後の誤判定」を止める）

発端：10/26 月寒。12:30〜15:00 の予約の子が 12:29「お預かりしました」のあと 14:25 / 14:30 / 15:18 に
「まだ来園されていません」へ3回戻り、完了後もアラートが出続けた。sf_notify は翌朝の日またぎ nfSave で
当日分が消えるため履歴は残っていないが、sf_devices の lastSeen 14:30:35 と 15:18:26 がアラート時刻と一致
（その瞬間に起動または前面復帰した端末がある）。時計ずれは全端末 ±2 秒で無関係。
原因は**背面で凍っていた端末の復帰直後**：期限切れの `setInterval(checkArrivals)` がサーバー snapshot より
先に走り、停止前の 'reserved' を根拠に no-show を判定して新しい stTs で `c` を書く。SF-NFGUARD-20260925 の
版ガードは「決定の新しさ」しか比べないので、古いデータに基づく新しい決定は自端末でも他端末でも通る。
standalone（Safari と別インスタンス）と single-tab で、独立に凍って独立に判定するインスタンスが増えていた。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-NFGUARD2-20261027` | **A**：sf_notify の購読に `includeMetadataChanges` を付け、サーバー確定（fromCache=false）の受信時刻を `window.__nfSrvAt` に残す。`checkArrivals` の自動判定（no-show＋未到着アラート）は `nfCanAutoJudge()`＝**前面 かつ __nfSrvAt あり かつ 最終受信（__sfWakeLastSnap）から5分以内**のときだけ。復帰直後は最終受信が数時間前なのでサーバー snapshot が届くまで判定しない（静かな時間帯は NETWATCH が2分超で確認を取って進めるので正常時は止まらない）。刻印 sfWakeMarkSnapshot もサーバー確定のときだけ（metadata だけの fromCache=true で刻印すると「同期待ち」と NETWATCH が誤って fresh になる）。**B**：`nfApplyChildStates` で、届いた status が reserved / no-show、手元が late-hold / waiting / picking / done なら **stTs に関係なく適用しない**（`NF_ARRIVED_STATUS`）。拒否したら `__nfRejected` を立て、適用直後に nfSave で自分の前進側の状態を書き戻す（クラウドが reserved のまま残り、起動してきた端末が再アラートするのを防ぐ） | notify 3本 |

残る経路：永続キャッシュが古いまま起動した端末の「初回アップロード」が 'reserved' を書くことはありうるが、
B により他端末は戻らず即書き戻すので収束する（アラートは出ない）。
パッチは `apps/sf_nfguard2_20261027.py`（notify 3本・5編集・アンカー一意検証・node --check）。
検証は test_nfguard2.js（3本×17項目：配線／起動時 fromCache のみでは判定せず fromCache=false 後に判定／
復帰模擬（時刻だけ 14:25 へ・snapshot 無し）で判定なし・書き込みゼロ・waiting 受信後も不変／対照（本当に
未到着なら確認後に判定）／waiting・done・late-hold への reserved・no-show は無視して waiting を書き戻す／
前進は受け入れる／古い doc は従来どおり stTs で拒否／hidden では判定しない）＋既存スイート ALL PASS。
test_wakesync.js は確認リスナーの数え方を sf_bookings 限定に変更（notify の sf_notify 購読にも metadata が付いたため）。

### 2026-10-27 に入った機能（SF-CXLACK：キャンセル通知の「確認しました」が効かない・再着信する）

発端：10/27 月寒。美容室がキャンセルした予約のカード（07:09）が 15:24 に再着信し、「確認しました」を押しても消えない。
原因：(1) キャンセル済み予約は取り込まれないため、キャンセル後に起動した端末には子が無く、`ackCancel` が `nfChild()` の
null で return してカードも n も消えなかった（SF-CANCELFLAG-20260926 の欠陥）。(2) 起動端末は `__nfCxlSeen` が空で、
sf_bookings が sf_notify より先に届くと Date.now() の ts でカードを作り直し、n ドキュメント（key 収束）を上書き→全端末で再着信。
15:24 の再着信は本番 smoke の新規コンテキストが起こした。(3) NFGUARD2 の B に cancelled が無かった。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-CXLACK-20261027` | `nfHandleCancelledBooking`：sf_notify 初回受信前は何もしない（`nfApplySnapshot` が初回受信後に `importSharedBookings` を呼び直す）／クラウドの c が done なら積まない／子が無ければ **cancelled の子を作る**（表示・確認・c の共有が同じ経路に）／通知と子の時刻は **予約の `cancelledAt` に固定**（端末ごとに ts が違わない＝n / c を書き直さない・再着信しない）。`ackCancel`：子が無ければ予約（または通知）から done の子を作って従来経路へ（c に done が残り、起動端末がカードを再生成しない）、通知は sfId でも消す。`NF_ARRIVED_STATUS` に cancelled を追加 | notify 3本 |

パッチは `apps/sf_cxlack_20261027.py`（notify 3本・4編集・アンカー一意検証・node --check）。検証は test_cxlack.js
（3本×9項目：bookings 先着でも sf_notify 到着後に1枚だけ・ts=cancelledAt／確認しました→カード消滅・c done・n 削除／
childIdx -1 の旧カードからの確認／リロード後（c=done）はカード無し・n を書かない／他端末の n がある起動で書き直し無し／
B：cancelled に reserved・no-show は効かず done は通る／取り消しで reserved に戻る）＋ test_nfguard2・test_wakesync ALL PASS。

### 2026-10-27 に入った機能（SF-NFSERVER-S1：お迎え通知の状態をサーバーで決める・影運転）

設計・経緯・手順は **`DESIGN-nfserver.md`** が正。端末（notify 3本）は無改変。

| マーカー | 内容 | 対象 |
|---|---|---|
| `SF-NFSERVER-S1-20261027` | **Cloud Functions 4本**（`functions/`・v2・asia-northeast1・Node 22）：`onNotifyEventCreated`（sf_notify_events の onCreate → 予約＋全イベントから state を再計算）／`notifyNoShowScan`（毎分・JST 7〜20時・reserved のまま dueAt を過ぎた子に1回だけ no-show）／`onBookingWrittenForNotify`（予約 → reserved の state・時刻追従）／`onLegacyNotifyWritten`（旧 sf_notify の c / n を前進イベントに翻訳）。判定は `functions/lib/nfstate.js` の純粋関数 `reduce`（node:test 21項目）。モードは `sf_config/nfserver.mode`：いまは **shadow**（state は `sf_notify_state_shadow`、旧 sf_notify には書かない）。ルールは `firestore.rules`（events は create のみ・state は Functions のみ）。運用スクリプトは `tests/nfserver/`（所有者トークンの REST＝Admin 相当。compare_shadow は読み取り専用） | functions/ + firestore.* |

**Functions を触るときの約束**：`firebase deploy --only functions --project strawberry-field-timely`（`--force` は使わない。
掃除ポリシーは設定済み）。2nd gen の Firestore トリガーは初回デプロイで Eventarc の権限伝播待ちに失敗することがある→数分後に再実行。
`firebase functions:log` でログ。`mode:'off'` にすれば4本とも何もしない（即時の退避）。

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
- **本番に書くテストをしない。** smoke は `tests/prod/smoke_notify_readonly.mjs`（書き込み遮断）、書き込みが要る確認はテスト園 `gardenId='smoke'` か存在しない bookingId だけ（§7）

### 環境

- ローカル：`~/dev/strawberry-field`（**作業マシンは2台。必ず pull から始める → §0**）
  - 2026-10-02 に iCloud 同期（`~/Documents/`）の外へ引っ越し。旧フォルダは `~/Documents/strawberry-field_OLD_iCloud/` に残置（編集禁止）。Mac mini 側でも同様に `~/dev/` へ clone し直すこと
  - 姉妹リポジトリ strawberry-tuition- も同じく `~/dev/strawberry-tuition-/` に引っ越し済み
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
