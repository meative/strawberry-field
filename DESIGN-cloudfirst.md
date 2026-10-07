# DESIGN — timely 保存層の作り直し：クラウド正本化（SF-CLOUDFIRST）

起草 2026-10-07。**状態：Step 1（書き込み層）・Step 2（読み込み層）実装済み
（SF-CLOUDFIRST-S1-20261007 / SF-CLOUDFIRST-S2-20261007・ともに 2026-10-07、
パッチ `apps/sf_cloudfirst_s1_20261007.py` / `apps/sf_cloudfirst_s2_20261007.py`）。Step 3〜4 は未着手。**
行番号はすべて `c9994a1`（2026-10-07・SF-LSQUOTA 反映後＝Step 1 適用前）時点の `apps/timely.html`。

## 2026-10-07 の作業ログ（Step 2）

- tlApplySnapshot の中身を丸ごと置換：`DATA[kind] = rows`（丸ごと置換）→ `TL_READY[kind] = true` →
  表示キャッシュ → tlRerender。初回の和集合マージと localOnly 送り返しは全廃
- TL_MIRROR・__tlApplying を撤去。TL_SNAP_SEEN → TL_READY に一括改名（11箇所。
  rosterPublishIfChanged / SF-VERIFYSYNC / SF-RESMATCH の参照も読み替え）
- tlPut の会計ガード（pending-over-paid 拒否）の比較相手を TL_MIRROR から DATA（クラウドビュー）に変更。
  rec 自身（呼び出し側が DATA 上で編集した同一オブジェクト）は比較対象にしない
- 書き込み操作11箇所の入り口に `tlGateWrite()` ゲート（submitNewCustomer / submitVisit /
  saveCustomerEdit / deleteCustomer / saveStudent / deleteStudent / sfKinderTapIn /
  submitInternalUsage / approvePayment / tlDeleteVisit / saveHandoverDraft）。TL_READY が
  3コレクションぶん揃うまで「クラウドと同期中です」を出して止める。tlPut / tlDel 自体も
  最終防衛線として同期前の書き込みを拒否
- **設計との差分**：予約系（confirmReservation / removeFromReservation。sf_bookings のみに書く操作）は
  ゲート対象外のまま。TL_READY（tl 3コレクション）は readiness の指標として不適切で、
  sf 側は従来どおり `__sfSnapshotReceived` と SF-DELGUARD が守るため（原則6：board 系の骨格は触らない）
- 旧読み込み層（tlRecTime / tlMergeByVersion / tlReconcile / tlIdSet）は死骸として注記付きで温存
  （Step 3 で削除。tlReconcile は撤去済み TL_MIRROR 参照のため誤呼び出しは ReferenceError で即発覚）
- sfSyncTrack の失敗時巻き戻しから tl 側（TL_MIRROR）を撤去。tl の再送は未送信箱（SF_SYNC.queue）のみ
- 検証：`tests/playwright/test_cloudfirst.js` に 4（陰性対照：キャッシュに種まきした古い visit が
  起動後もクラウドへ送信されない）・5（TL_READY ゲートの閉→開）・6（pending-over-paid 拒否）・
  9（全画面一巡の pageerror ゼロ）を追加し **26項目 ALL PASS**。既存 Playwright 6本 ALL PASS
  （test_resmatch は TL_READY 読み替えのみ）。root の grep テストは既知の3件 FAIL のみ（変更前と同一）

## 2026-10-07 の作業ログ（Step 1）

- 未決事項の決定：1=管理機能は封印（JSONエクスポートのみ残す）／2=TL_READY ゲートは設計どおり／
  3=領収書採番は別件のまま／4=会計下書きはクラウドへ書く／5=切替日は Step 3 後に決定／
  6=WAKESYNC の切り分けは切替前に現場で実施
- module 側 fbPutTl / fbDeleteTl / fbPutBooking / fbPatchBooking / fbDeleteBooking（updateDoc を import に追加）、
  通常側 tlPut / tlDel / saveSettings / tlOpBegin / sfPatchBooking を新設。saveData 25箇所を置換、throw 化
- **設計との差分1**：sfSaveShared 6箇所のうち :13430 / :13499 / :13504 は呼び出し側ではなく
  **ヘルパー（sfUpsertShared / sfRemoveShared / sfRemoveSharedMany）の中身を1件書きに差し替え**た
  （呼び出し側は無改変・意味は対応表どおり）。sfRemoveSharedMany は SF_DELGUARD_MAX の上限を自前で維持
- **設計との差分2**：`tlOpBegin()`（__sfSaveWaits の仕切り直し）を新設。旧 saveData が毎回やっていた
  リセットの後継で、見届けを使う操作（会計確定・月極¥0・会計記録の削除）の先頭で呼ぶ
- 検証：`tests/playwright/test_cloudfirst.js` 17項目（1・2・3・7・7b・8・9）ALL PASS、
  既存 Playwright 6本 ALL PASS、root の grep テストは既知の3件 FAIL のみ（変更前と同一）。
  stubs.js の updateDoc を記録式に変更、test_lsquota の saveData 直接呼びを tlPut に更新
対象は **timely 1本のみ**。board / salon / notify の同期（SF_MIRROR / fbReconcile）は触らない。
判定エンジン・Firebase の設定とルール・クラウドのデータ・月謝アプリ（strawberry-tuition）も触らない。
このファイルは実装が進むたびに「状態」欄と作業分割表を更新すること。

## 背景 — 事故の家系図

| 日付 | 事故 | そのときの対処 | 残った構造的原因 |
|---|---|---|---|
| 2026-07-27 | 会計済みが翌朝お会計待ちへ巻き戻る | SF-SYNCGUARD-20260727（送信成否の見届け・赤帯・再送箱） | 配列まるごとの突き合わせ自体は残った |
| 2026-08-26 | 巻き戻り再発 | SF-VERGUARD-20260826（レコード単位マージ・会計ガード・版ガード） | マージの判定材料（updatedAt チェーン）に漏れがあると負ける |
| 2026-08-31 | 指示していない削除・入力消失 | SF-DELGUARD-20260831（削除の明示化・上限8件・空スナップショット拒否） | 「配列差分から削除を算出する」構造自体は残った |
| 2026-09-25 / 10-02 | 他端末で削除した会計記録が古い端末の再読み込みで復活 | なし（CLAUDE.md §9 の既知の弱点として記録のみ） | 初回スナップショット経路の localOnly 足し戻し（:9535-9553）が削除を尊重しない |
| 2026-10-07 | localStorage 上限超過（署名画像 約4.8MB）で会計・受付がクラウドにも残らず消失 | SF-LSQUOTA-20261007（localStorage とクラウド送信の切り離し・署名除外） | localStorage の成否が保存経路の途中に挟まっている構造は残った |

5件すべての根は同じ：**localStorage の DATA 配列を正本として扱い、配列まるごとをクラウドと
突き合わせる**構造（`saveData` → `tlReconcile` の差分化＋削除算出、`tlApplySnapshot` の
マージ＋localOnly 送り返し）。ガードはこの構造の上に積まれた対症療法で、1つ足すたびに
「写しは何を指すか」「初回フラグはどちらか」という前提が増えた（CLAUDE.md §3 の注意書きの
量がその証拠）。本設計はこの家系を止める。

## 原則（確定）

1. **Firestore（sf_customers / sf_visits / sf_students ＋既存コレクション）を唯一の正本にする。**
   データ形式・コレクション名・docId（＝レコードの id）・Firebase の設定とルールは変えない
2. **受付・会計・修正・削除のたびに、その1件だけを setDoc / updateDoc / deleteDoc で書く。**
   配列差分（tlReconcile）と起動時の localOnly 送り返しは廃止
3. **localStorage は表示用キャッシュに格下げ。** クラウドへ書き戻す材料には使わない。
   起動時はクラウドの snapshot を待って描画（現 TL_SNAP_SEEN と同じ扱い）
4. **オフラインは persistentLocalCache のオフラインキューに任せる。** 送信の成否は
   「その1件の書き込み Promise」で判定し、失敗は既存 SYNCGUARD の赤帯・再送箱に載せる
5. **SF-VERGUARD・SF-DELGUARD・SF-DUPBLOCK・購読窓＋SF-ARCHIVE-TIMELY は維持**
   （新構造での担保は後述の表）
6. **予約ボード側（sf_bookings の SF_MIRROR / fbReconcile）は今回触らない。**
   timely から sf_bookings へ書く箇所（tlDone / tlVisitId の消費）だけ1件書きに揃える

## 新構造の全体像

```
【書き】操作1回 = ドキュメント1〜数件の明示書き込み（配列は二度と書かない）

  受付/会計/編集/削除 ─▶ tlPut(kind, rec) ──▶ fbPutTl(kind, rec)    = setDoc(doc(db, col, rec.id), rec)
                         tlDel(kind, id)  ──▶ fbDeleteTl(kind, id)  = deleteDoc
                         （予約消費）     ──▶ fbPatchBooking(id, patch) = updateDoc（sf_bookings）
                              │
                              ├─ 書く前に updatedAt を刻印（ISO 文字列・形式不変）
                              ├─ DATA へ楽観反映して即描画（snapshot のエコーで確定）
                              ├─ Promise を __sfSaveWaits へ（sfConfirmCloudSave は現行のまま動く）
                              └─ reject は SF_SYNC.queue へ（赤帯・再送も現行のまま）

【読み】snapshot = 正本の写し。マージしない・送り返さない

  onSnapshot(sf_visits 等) ─▶ tlApplySnapshot(kind, rows)
                              └─ DATA[kind] = rows（丸ごと置換）→ TL_READY[kind] = true → 描画
                              └─ saveViewCache(DATA)（表示キャッシュ・signature 除外・失敗しても無害）
```

- **DATA オブジェクトは残す**が、意味を「正本」から「クラウド snapshot ＋楽観反映の表示ビュー」に
  変える。描画コード（render* 群・レポート・領収書）は DATA を読むだけなので無改変で済む
- 楽観反映と snapshot 置換の整合：persistentLocalCache のレイテンシ補償により、自端末の書き込みは
  即座に snapshot へエコーされる（hasPendingWrites 付き）。楽観反映した内容と同じものが届くだけなので
  置換は安全。入力中画面を再描画しない現行の tlRerender の方針（:9578 付近）は踏襲
- settings（園名・スタッフ名）は現行どおり**端末ローカルのみ**（クラウド非同期）。
  保存は新設の `saveSettings()`（localStorage 直書き）に分離する

## saveData(DATA) 呼び出し全25箇所と置き換え対応表

凡例：`put(v)` = tlPut('visits', v)、`put(c)` = tlPut('customers', c)、`put(s)` = tlPut('students', s)、
`del(…)` = tlDel、`patchBk` = fbPatchBooking、`cache` = saveViewCache のみ（クラウド書き込みなし）。

| 行 | 関数 | 画面 | 保存しているもの | 置き換え |
|---|---|---|---|---|
| :8947 | importBoardReservations | （内部）共有予約の取込 | DATA.reservations（sf_bookings からの派生） | `cache` のみ。クラウドへは何も書かない |
| :9285 | tlDeleteVisitExec | 日報明細の削除ボタン | visits から1件除去 | `del('visits', id)` |
| :10937 | submitNewCustomer | 新規顧客登録 | customers に1件追加（署名含む） | `put(c)` |
| :11809 | submitVisit | 当日入力の確定 | visits 追加＋reservations 消費 | `put(v)` ＋ `cache`（reservations は派生なので書かない） |
| :11757 / :11803 | submitVisit 内 | 〃（予約の受付済み化） | sfSaveShared(_shared) で sf_bookings 全件突き合わせ | `patchBk(id, {tlDone, tlVisitId, name, kana, provisional})` × 区間メンバー数 |
| :11862 | changeBranch | 設定（園切替） | settings | `saveSettings()` |
| :11931 / :11948 | addStaff / removeStaff | 設定（スタッフ名簿） | settings | `saveSettings()` |
| :12422 | saveCustomerEdit | 顧客情報の編集 | customers 1件更新 | `put(c)`（updatedAt 刻印は tlPut が一元化 → :11637 問題の根治） |
| :12466 | deleteCustomer | 顧客の削除 | customers 1件除去 | `del('customers', id)` |
| :12705 / :12716 | saveStudent | 内部生名簿の追加・編集 | students 1件 | `put(s)` |
| :12744 | deleteStudent | 内部生名簿の削除 | students 1件除去 | `del('students', id)` |
| :13396 / :13449 | confirmReservation | 予約の編集・新規（timely 内予約リスト） | reservations | `cache` のみ（派生）。:13392 の sfSaveShared → `patchBk(id, {date, start, end, affiliation})` |
| :13430 | confirmReservation 内 sfUpsertShared | 〃（次回予約の共有） | sf_bookings 1件 upsert | `fbPutBooking(rec)`（setDoc 1件。upsert はもともと1件単位なので最短） |
| :13499 / :13504 | removeFromReservation 内 sfRemoveSharedMany / sfRemoveShared | 予約リストから外す | sf_bookings 明示削除 | `fbDeleteBooking(id)` × 列挙件数（上限 SF_DELGUARD_MAX は維持） |
| :13511 | removeFromReservation | 〃 | reservations | `cache` のみ |
| :13872 | removeFromReservationByCustomerId | （内部）受付時の予約カード消込 | reservations | `cache` のみ |
| :15032 | sfKinderTapIn | 内部生タブのワンタップ受付 | visits 追加 | `put(v)`（失敗時 pop は廃止。送信は tlPut が保証） |
| :15097 | submitInternalUsage | 内部生の手入力受付 | visits（＋students 追加のとき） | `put(v)`（＋ `put(s)`） |
| :16518 | saveHandoverDraft | お会計画面の下書き | visits 1件の下書きフィールド | `put(v)`（updatedAt を正しく刻む → handoverUpdatedAt 漏れの根治）。ただし未決事項4 |
| :16601 | approvePayment（月極¥0） | お会計（会計記録を作らない分岐） | visits 1件除去 | `del('visits', id)` |
| :16643 | approvePayment | お会計の確定・修正 | visits 1件更新（paid・金額・領収書番号） | `put(v)` |
| :18041 | handleImport | 設定のJSONインポート | DATA 全体 | **封印**（未決事項1） |
| :18059 | resetAllData | 設定の全データ消去 | DATA 全体を空に | **封印**（未決事項1。現構造では全 doc 削除になり DELGUARD の思想と矛盾） |
| :18292 | loadSampleData | サンプルデータ投入 | DATA 全体 | **封印**（本番園では使わない） |

- tlPut / tlDel は「1操作で関連する数件」をまとめる writeBatch を許す（例：submitVisit の
  visit＋予約消化、組の複数区間）。禁じているのは「配列全体の突き合わせ」であって、
  **id を明示列挙した少数件のアトミック書き**はむしろ推奨
- `saveData` 自体は廃止。移行期の検出用に `function saveData(){ throw new Error('SF-CLOUDFIRST: 廃止') }`
  を一時的に残し、Playwright の pageerror 検出で呼び残しを炙り出してから消す

## 廃止する関数・残す関数

| 対象 | 今の役割 | 新構造 |
|---|---|---|
| `saveData`（:9504） | localStorage ＋ 全 kind の配列差分送信 | **廃止**（上記の対応表で置換） |
| `saveDataLocalOnly`（:9466） | localStorage 書き込み（signature 除外・quota 再試行） | **改名して残す**：`saveViewCache`。中身（SF-LSQUOTA の除外・premig 削除・赤帯）はそのまま |
| `tlReconcile`（:9412） | 配列差分の算出・削除算出・写し更新 | **廃止**（削除算出という概念ごと消える） |
| `tlMergeByVersion`（:9385） | レコード単位マージ（会計ガード・版ガード） | **廃止**。会計ガードだけ tlPut の防御チェックに移植（後述） |
| `tlApplySnapshot`（:9528） | 初回＝和集合マージ＋localOnly 送り返し／2回目以降＝マージ | **中身を置換**：DATA[kind] 丸ごと置換＋TL_READY＋キャッシュ＋再描画のみ。**送り返しは全廃** |
| `sfChangedOnly`（:8343 相当） | 差分判定 | tl 用途は**廃止**。sf_bookings 側（board 系の骨格）はそのまま |
| `TL_MIRROR`（:8984） | クラウド既知状態の写し（差分・削除算出の基準） | **廃止**（基準が要らなくなる） |
| `TL_SNAP_SEEN`（:8985） | 空配列全消し防止・初回分岐・名簿発行・RESMATCH の判定 | **改名して残す**：`TL_READY`。役割は「初回 snapshot 前は書き込み操作を止める」ゲートに一本化 |
| `__tlApplying`（:8986） | snapshot 適用中の書き戻しループ防止 | **廃止**（適用中に書く経路が無くなる） |
| `__sfSaveWaits`（:9009） | saveData 1回分の送信 Promise 集め | **残す**。中身が tlPut の1件 Promise になるだけ |
| `SF_SYNC.queue` / `sfSyncTrack` / `sfSyncRetry` / 赤帯（:9001-9176） | 失敗送信の再送箱と可視化 | **残す**。積む単位が「1件書き」になり簡素化（巻き戻し計算 :8716 相当の tl 側が不要に） |
| `sfConfirmCloudSave`（:9178） | 会計確定時の見届けモーダル | **残す・無改変**（waits の中身が変わるだけ） |
| `fbReconcileTl`（:5748） | writeBatch で配列反映 | **廃止** → `fbPutTl` / `fbDeleteTl`（1件 setDoc / deleteDoc。batch は複数件口だけ残す） |
| `fbReconcile`（:5788）・`sfSaveShared`（:8709）・`SF_MIRROR` | sf_bookings の配列突き合わせ | **残す**（原則6）。ただし timely 内の呼び出し6箇所は上表のとおり1件書きへ置換し、**timely からは呼ばれなくなる**（コードは board 系との共通骨格なので削除しない） |
| `sfDelGuard`（:8688）・`SF_DELGUARD_MAX` | sf_bookings の削除ガード | **残す**（fbDeleteBooking の列挙上限として続投） |
| `rosterPublishIfChanged`（:9608） | サロン向け名簿の発行 | **残す**。呼び出し時機は customers の put / del 後＋customers snapshot 受信時（現行 :9572 と同じ） |
| `loadData`（:8958） | localStorage からの起動時読み込み | **残す**。用途は「snapshot 到着前の仮表示」だけに限定（戻り値を送信系に渡さない） |
| `sfLsQuota*`（:9433-9470） | 保存領域の赤帯 | **残す**（キャッシュ失敗の通知として） |
| SF_ARCHIVE_TL / sfLoadSharedWithArchive（:8460-8510） | 過去月レポートの1回読み | **残す・無改変** |

## 起動シーケンス

```
1. loadData() … localStorage キャッシュを DATA へ（仮表示用）。「同期待ち」バッジ表示
2. 匿名認証 → 3コレクション購読開始（:5804-5819・現行どおり全件・窓なし）
3. kind ごとに初回 snapshot 到着
     → DATA[kind] = rows 丸ごと置換（マージしない・足し戻さない・送り返さない）
     → TL_READY[kind] = true、saveViewCache(DATA)、再描画
4. TL_READY が揃うまで、書き込みを伴う操作（新規登録・受付・会計・編集・削除）は不活性
     （SF-RESMATCH の「顧客データを同期中です」と同じ扱いを全書き込み操作へ拡張）
```

- **初回マージと localOnly 送り返しは廃止。** 従来この経路が担っていた「未送信レコードの救済」は
  persistentLocalCache の未送信キューが担う：tlPut した瞬間に IndexedDB のキューへ入るので、
  タブを閉じても・圏外でも SDK が再送する（SF-OFFLINE-20260826 の既存機構。救済に localStorage は使わない）。
  これが**削除復活バグ（9/25・10/2）の根治**になる——「クラウドに無い＝削除された」と
  「クラウドに無い＝未送信」を localStorage では区別できないが、SDK のキューは区別できる
- 旧 localStorage（STORAGE_KEY）はそのまま表示キャッシュとして続投。**読むだけで送らない**。
  形式は現行互換（signature 除外済み）なので旧→新の変換は不要
- _premig_20260722 は SF-LSQUOTA-20261007 で削除済み（起動時削除コードも残っている）
- persistentLocalCache があるため、2回目以降の起動は圏外でも IndexedDB から fromCache の
  snapshot が即時に届き、TL_READY は立つ（＝圏外でも受付できる）。**真に不活性のままになるのは
  「初回起動（IndexedDB 空）＋圏外」だけ**（未決事項2）

## 多端末の同時編集 — どちらが勝つか

- 書き込み単位が doc になるので、**doc 単位の後勝ち（last-writer-wins）**。配列時代の
  「他人の無関係な1件を巻き添えにする」事故は構造的に消える
- `updatedAt` は現行の **ISO 文字列を維持**し、tlPut が書き込み直前に必ず刻印する（打ち忘れの根治）。
  **serverTimestamp は不採用**：(1) フィールドが Timestamp 型になり「データ形式を変えない」原則に反する
  （12本の後方互換・CSV・レポートに波及）(2) オフライン書き込み中は null になる揺れがある。
  端末時計のズレは許容する——マージ判定が消えるため、updatedAt を比較に使う場面自体が
  「人間が後から見る」用途にほぼ限られる
- **会計（paid）の競合**：tlPut('visits', v) は書く前に DATA（＝クラウドビュー）の同 id を見て、
  `paymentStatus: 'pending'` で `paid` を上書きする書き込みを拒否してログを残す（VERGUARD の新形態。
  正規の操作に paid→pending は存在しないため常に安全、という現行の論拠をそのまま使う）
- 同じ visit を2端末が同時に会計する競合は、SF-SUBMITLOCK（端末内）＋後勝ちで現状と同等。
  領収書番号の採番ズレ（CLAUDE.md §0.6）は本設計のスコープ外だが、1件書き化で
  runTransaction による「当日最大番号+1」へ進む土台はできる（未決事項3）

## 既存ガードの新構造での担保

| ガード | 現行 | 新構造 |
|---|---|---|
| SF-VERGUARD（巻き戻り防止） | マージの会計ガード・版ガード | **構造的に根絶**（送り返し・全件 set が消える）＋ tlPut の pending-over-paid 拒否を防御線として残す |
| SF-DELGUARD（意図しない削除防止） | 差分算出への介入・上限8件・空スナップショット拒否 | tl 側は**削除算出そのものが消滅**し、削除は tlDel の明示 id のみ＝根絶。sf_bookings 側は sfDelGuard 続投。全消し系の管理機能は封印 |
| SF-DUPBLOCK（二重受付防止） | DATA.visits の同日重複判定（:11540-） | ロジック無改変。判定材料が「クラウドビュー」になり、TL_READY 前は受付不可になるため取りこぼしはむしろ減る |
| SF-SYNCGUARD（送信の見届け） | __sfSaveWaits ＋ 赤帯 ＋ 再送箱 | 無改変で動く（waits の中身が1件 Promise に変わるだけ）。オフライン中は Promise が保留のままで赤帯が出ない現行挙動も同じ（SDK が再送するので正しい） |
| 購読窓＋SF-ARCHIVE-TIMELY | sf_bookings は前月1日窓、過去月は SF_ARCHIVE_TL | 無改変。sf_visits / customers / students は**全件購読を維持**（現行の窓禁止理由は tlMerge だったが、新構造でも「ビュー＝全件」が前提。件数が増えたら年次アーカイブで別途設計、という READWINDOW の結論のまま） |
| SF-RESMATCH（顧客重複の入口封じ） | TL_SNAP_SEEN.customers を見る | TL_READY.customers に読み替えるだけ |
| SF-LSQUOTA（保存領域の赤帯） | localStorage 失敗の通知 | saveViewCache に引き継ぎ。キャッシュ失敗は業務影響ゼロになる |
| SF-ROSTER-PUBLISH | 顧客増減でサロン名簿を発行 | 呼び出し時機を customers の put / del 後に変えるだけ |
| SF-WAKESYNC | 前面復帰で接続張り直し・同期待ちバッジ | 無改変（新構造は snapshot への依存が増えるため、むしろ重要度が上がる） |

## Playwright

現存スイートは `tests/playwright/` の6本：startfix / resmatch / archive_board / archive_timely /
wakesync / lsquota（**dupblock・verguard 専用の Playwright は現存しない**。verguard は
lsquota 内の署名移植1項目が触れているだけ）。stubs.js は setDoc / updateDoc / deleteDoc /
writeBatch をすべて `window.__fs.writes` に記録済みなので、スタブの改修はほぼ不要。

| テスト | 新構造での扱い |
|---|---|
| test_startfix | 期待値変更：タップ受付→ `sf_visits/<id>` の set が**1件だけ**出る（全件書き直しが無いことを assert に追加） |
| test_resmatch | ほぼ無改変（TL_SNAP_SEEN → TL_READY の読み替えのみ） |
| test_archive_board | board 無改変なのでそのまま通る |
| test_archive_timely | 無改変で通るはず（SF_ARCHIVE_TL は温存） |
| test_wakesync | 無改変 |
| test_lsquota | 期待値変更：「quota でも送信される」は新構造で自明になるが回帰防止として残す。premig・signature 除外・赤帯の項目は saveViewCache に対してそのまま。tlMergeByVersion の署名移植項目は**削除**（関数ごと廃止） |

新設 `test_cloudfirst.js`（かなめは陰性対照）：

1. 受付1回 → `sf_visits` set 1件のみ（他 kind・他 doc への書き込みゼロ）
2. 会計確定 → 同 doc の set 1件のみ・paid 内容
3. 削除 → deleteDoc 1件。その後 snapshot（削除反映済み）を流しても**復活しない**
4. 起動キャッシュに「クラウドに無い古い visit」を種まき → 起動完了まで待っても
   **クラウドへ何も送信されない**（localOnly 送り返し根絶の陰性対照。旧構造なら set が出る）
5. TL_READY 前は受付・会計ボタンが不活性／TL_READY 後に解放
6. pending-over-paid の書き込みが拒否されログが残る（VERGUARD 新形態）
7. 予約消費 → `sf_bookings/<id>` への **updateDoc(patch)** で、対象外フィールドが無傷
8. 下書き保存 → updatedAt が刻印される（handoverUpdatedAt 漏れの回帰防止）
9. 旧 saveData の呼び残し検出（スタブ期間中：全画面を一巡して pageerror ゼロ）

## 移行手順

- **Firebase 側のデータ移行は不要**（コレクション・docId・フィールド形式すべて不変）。
  ルール・インデックスも不変
- 切替は **push → GitHub Pages 反映 → timely を開く各端末（4園の iPad）の再読み込みだけ**
- **混在期間に注意**：旧コードの端末が残ると、その端末の localOnly 送り返し・配列削除算出が
  生きたまま（＝旧事故の復活ベクターが残る）。timely は園ごとに1〜2台の固定運用なので、
  切替日に4園へ「再読み込みのお願い」を同日に出す。旧端末が書いた doc / 新端末が書いた doc は
  相互に読める（形式不変）ため、混在しても壊れはしない——事故の「確率」が旧端末に残るだけ
- **ロールバック**：`git revert` → Pages 反映 → iPad 再読み込み。新構造が書いたデータは
  旧構造がそのまま読める（フィールド追加なし・updatedAt は旧構造の版ガードがむしろ喜ぶ）。
  戻し判断の目安は「切替後1週間の Firebase コンソール書き込み数・現場報告」
- 切替前チェックリスト：全端末で赤帯（未送信）ゼロ／`[SF-LSQUOTA] bytes=` が5MB未満／
  クラウド件数と日報件数の突き合わせ（読み取り専用スクリプト。2026-10-07 の裏取りと同じ方式）

## 作業の分割（1ステップ＝1実機確認＝1コミット）

| Step | 内容 | 検証 | 見積 |
|---|---|---|---|
| 1 | **書き込み層**：fbPutTl / fbDeleteTl / fbPutBooking / fbPatchBooking / fbDeleteBooking（module側）＋ tlPut / tlDel / saveSettings（通常側）を新設し、呼び出し25箇所＋sfSaveShared 6箇所を置換。saveData は throw 化して呼び残し検出。**読み側は旧のまま**（旧 tlApplySnapshot は後勝ちで新書き込みを受け入れるので共存できる） | test_cloudfirst 1・2・3・7・8 ＋ 既存6本回帰 ＋ 実機1園 | **完了 2026-10-07**（SF-CLOUDFIRST-S1-20261007。テスト17項目＋回帰 PASS。実機1園の確認は未） |
| 2 | **読み込み層**：tlApplySnapshot の中身を丸ごと置換（マージ・初回送り返し廃止）、TL_MIRROR 撤去、TL_SNAP_SEEN → TL_READY、書き込み操作のゲート導入 | test_cloudfirst 4・5・6・9 ＋ 回帰 ＋ 実機1園 | **完了 2026-10-07**（SF-CLOUDFIRST-S2-20261007。テスト26項目＋回帰 PASS） |
| 3 | **後片付け**：tlReconcile / tlMergeByVersion / sfChangedOnly(tl) / saveData の死骸削除、saveDataLocalOnly → saveViewCache 改名、test_lsquota 期待値更新、管理機能の封印 | 全スイート ＋ node --check | 半日 |
| 4 | **本番切替**：4園 iPad の同日再読み込み → 1週間の経過観察（Firebase コンソールの書き込み数／読み取り数／現場報告） | 切替前チェックリスト | 現場協力・暦で1週間 |

Step 1・2 を分けるのは切り分けのため（Step 1 だけ入った状態でも機能劣化ゼロで運用できる）。
編集は §5-2 の Python パッチスクリプト方式（アンカー出現1回検証・2フェーズ・バックアップ・node --check）。
対象は timely 1本だが置換箇所が31箇所あるため、手 Edit ではなくスクリプトで冪等にする。

## リスク

- **書き込み数の増加はほぼ無い**：現行も差分化で変化分しか書いていない。むしろ初回送り返し・
  localWins 再送の「無駄な全件 set」が消える分、減る方向
- **persistentLocalCache への依存が上がる**：未送信の救済を SDK キューに全面委任するため、
  SF-WAKESYNC で疑っている「multiTab プライマリタブの凍結」（9/30 朝の同時空白・未決着）が
  実在するなら、送信も巻き込まれる。切替前に現場の切り分け（persistentSingleTabManager 化の判断）を
  済ませるのが望ましい（未決事項6）
- **TL_READY ゲートの運用影響**：初回起動（IndexedDB 空）＋圏外の端末では受付を開始できない。
  2回目以降の起動は圏外でも IndexedDB から立ち上がるので影響しない（未決事項2）
- **31箇所の置換漏れ**：throw 化した saveData と Playwright の pageerror 検出（テスト9）で炙り出す。
  移行期も「旧 saveData が残っていたら即例外」なので、静かな取りこぼしにはならない
- **reservations の永続性が下がる**：DATA.reservations はキャッシュ格下げ後も実態は従来どおり
  sf_bookings 派生＋timely 固有レコード。timely 固有分（fromBoard:false・sfId 無し）はクラウドに
  正本が無いため、キャッシュ消失（Safari の容量整理）で消えうる。現行も localStorage 頼みなので
  **悪化はしない**が、根治するなら「timely 固有予約も sf_bookings に寄せる」が筋（スコープ外・将来課題）

## 決めきれない点（確認したいこと）

1. **管理機能の封印**：handleImport（JSONインポート）・resetAllData（全消去）・loadSampleData
   （サンプル投入）は、新構造では「クラウド全 doc の一括操作」になり危険です。ボタンごと
   封印（非表示＋無効化）してよいですか。本番園で使う場面が残っていますか
2. **TL_READY ゲート**：「初回起動＋圏外」の端末だけ、snapshot が来るまで受付・会計ができません
   （既設 iPad は IndexedDB があるので影響なし）。この制約を現場は許容できますか
3. **領収書番号の採番ズレ**（CLAUDE.md §0.6）：1件書き化は runTransaction 採番の土台になります。
   本設計に同梱しますか、別件のままにしますか（推奨：別件。切替の変数を増やさない）
4. **会計下書き（saveHandoverDraft）**：新構造では下書きのたびにクラウドへ書きます（1会計あたり
   数回の書き込み増・書き込みは読み取りより単価が高いが件数規模的に軽微）。端末を跨いで下書きを
   引き継ぐ需要が無いなら「下書きはメモリ＋表示キャッシュのみ・確定時に書く」へ軽量化もできます。
   どちらにしますか（推奨：クラウドへ書く。1端末の電池切れでも下書きが残る）
5. **切替日の調整**：4園同日の再読み込みは、どなたがいつ声をかけられますか（混在期間を短くしたい）
6. **SF-WAKESYNC の切り分け**（persistentSingleTabManager 化の判断）を本切替の前に済ませますか
   （推奨：先に済ませる。未送信キューへの依存が上がるため）
