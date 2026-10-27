# DESIGN — お迎え通知の作り直し：状態はサーバーが決める（SF-NFSERVER）

作成 2026-10-27（設計のみ・コード無改変）。対象は notify 3本（notify.html / notify_sp_tsukisamu.html /
notify_sp_shiraishi.html）と、新設する Cloud Functions・Firestore ルール。

## 2026-10-27 の作業ログ（手順0・ルール適用）

- 「ルール変更 OK」の承認を受け、**手順0**：`firebase init firestore` でコンソールの現行ルール
  （`match /{document=**} { allow read, write: if request.auth != null; }` の1本）とインデックス（空）を
  取り出し、`firestore.rules` / `firestore.indexes.json` / `firebase.json` / `.firebaserc` として無改変で
  コミット（545abb0）。以後ルールの変更はこのファイル＋`firebase deploy --only firestore:rules`。
- **発見**：Firestore のルールは「どれか1つの match が allow なら許可」なので、全体 match を残したまま
  個別 match を足しても `if false` は効かない。§7 を「全体 match を `/{collection}/{document=**}` にして
  2コレクションを除外する」形に改めた。
- **検証**：Java が無くエミュレータが動かないため、Firebase Rules REST API `projects.test` で20項目
  （`tests/rules/rules_rest_test.mjs`）。既存コレクションの読み書きは不変、events は create（serverTimestamp）
  だけ、update / delete / 端末時計の at / by='fn' / 余分なキーは拒否、state は read のみ。ALL PASS。
- **本番適用**：`firebase deploy --only firestore:rules`。匿名 idToken の REST で裏取り
  （`tests/rules/rules_live_check.mjs`）：sf_config 読み 200、events の create（REQUEST_TIME）200、同 id 再 create
  409、update / delete 403、端末時計の create 403、state 書き 403、旧 sf_notify 読み 200。
  検証用に `sf_notify_events/e_rulescheck_20261027`（bookingId `rulescheck`）が1件残る（端末からは消せない。
  Functions 導入時に Admin SDK で消す）。
- 手順4（ルール）を手順2（Functions）より先に適用したが、新コレクションはまだ誰も使わないので
  既存の挙動に影響しない（既存コレクションは従来どおり）。
- 未決7（Firestore のロケーション）：`firebase firestore:databases:get` で **asia-northeast1** を確認。
  Functions も asia-northeast1 でよい。

---

## 0. 要約

- 端末は **イベントを追記するだけ**（`sf_notify_events`・create のみ）。子の状態は **Cloud Functions が
  イベントから計算**して `sf_notify_state/{bookingId}` に書き、端末は読むだけ。未到着（no-show）は
  **1分おきのスケジュール関数が1回だけ**書く。
- これで「端末が古いデータを根拠に状態を書く」経路そのものが無くなる。10台でも100台でも、何時間
  開きっぱなしでも、端末が状態を戻すことは構造上できない（書けないので）。
- 端末側の checkArrivals / nfSave / NF_MIRROR / stTs 版ガード（SF-NFGUARD / NFGUARD2）は全廃。
- 移行中は Functions が旧形式（sf_notify の c/s/n）にも書き、旧版端末の操作も Functions がイベントへ
  翻訳する（双方向ブリッジ）。全端末が新版になったらブリッジを止める。
- **Firestore ルール**（§7）は 2026-10-27 に承認・適用済み。残る承認事項は手順7（旧 sf_notify の書き込み禁止）だけ。

---

## 1. 背景 — なぜ端末に状態を書かせてはいけないか

| 日付 | 事故 | 直接原因 | 入れた対策 |
|---|---|---|---|
| 9/21 月寒 | 数時間後に「予約済み」へ戻り誤アラート | children が空の瞬間に nfSave が全削除・日またぎ固定 | SF-NFGUARD-20260925（当日 c 削除禁止・stTs 版ガード） |
| 10/26 月寒 | 「お預かりしました」が3回戻り、完了後もアラート | 凍っていた端末の復帰直後、期限切れタイマーが古い 'reserved' で no-show を判定し新しい stTs で書く | SF-NFGUARD2-20261027（サーバー確定まで判定しない・後退拒否） |

どちらも「**各端末が自分の手元の配列を正として、状態ドキュメントを書く**」構造が根。端末の数だけ
"正" があり、凍結・復帰・起動・キャッシュの鮮度の組み合わせごとに穴が出る。SF-NFGUARD2 で既知の
経路は塞いだが、「次の未知の経路が無い」ことは証明できない。端末が状態を書けない構造にすれば証明できる。

timely の SF-CLOUDFIRST（10/7）と同じ思想：**正本を1つにし、端末は1操作=1件の追記だけ**。
違いは「状態の計算（判定）もサーバーに置く」こと。未到着判定は時刻に依存するので、端末の時計・
端末の生存に依存させない。

---

## 2. 前提（要件）

- 保育園4園（月寒・白石・ファクトリー・資生館）とサロン各店（WOODSTOCK・JANIS・BUDDY BROWN・JANIS白石）が
  **常時開きっぱなしでチャットのように**使う。端末は10台以上、個人スマホも含む、減らせない。
- 「何台が何時間開いていても、状態が戻らない・誤アラートが出ない」を**構造で**保証する。
- 匿名認証のまま（端末の `by` は自己申告。なりすまし対策は対象外・§11）。
- GitHub Pages 配信・自動更新（SF-DEVICES）はそのまま使う。
- Blaze 課金。読み取りの暴走（CLAUDE.md §0.5）を再発させない。

---

## 3. データ構造

### 3-1. `sf_notify_events/{eventId}` — 端末が追記するイベント（create のみ）

| フィールド | 型 | 内容 |
|---|---|---|
| `bookingId` | string | sf_bookings のドキュメントID（= 今の `sfId`） |
| `garden` | string | `tsukisamu` / `shiraishi` / `factory` / `shiseikan`（購読の絞り込み用） |
| `date` | string | `YYYY-MM-DD`（JST。購読の絞り込み・TTL 用。予約の date と同じ） |
| `salon` | string | `woodstock` / `janis`（識別子は Method X のとおり変えない） |
| `type` | string | §3-2 の列挙 |
| `kind` | string? | `type:'msg'` のときの種別（`soon` / `soon-early` / `late` / `early` / `handoff` / `report` / `ack_call` / `ack_cancel` / `alert`） |
| `data` | map? | 種別ごとの付帯（`lateMin`, `expectedEnd`, `expectedStart`, `reportKey`, `nextReservation`, `handoffTo`, `text`） |
| `at` | timestamp | `serverTimestamp()`（**端末の時計は使わない**） |
| `clientAt` | number | 端末の Date.now()（表示順の補助・デバッグ用。判定には使わない） |
| `by` | string | 端末ID（`SF_DEV_ID`）。Functions が書くものは `fn` |
| `ver` | string | `SF_APP_VER` |
| `expireAt` | timestamp | TTL（§3-5） |

**ドキュメントID は端末が決める**：`e_{bookingId}_{type}_{clientAt36}_{dev}`。再送（SF-UNSENTBOX 方式）で
同じIDを `setDoc` しても、ルールが create 以外を拒むので**重複が構造的に作れない**（2回目は permission-denied
＝「届いていた」と解釈して箱から外す）。

### 3-2. イベント種別と状態への効き方

| type | 誰が | 状態への効き方 | 旧コードの対応 |
|---|---|---|---|
| `arrived` | 保育園 | → `waiting` | markArrived |
| `pickup` | サロン | → `picking`（「もう向かっています」） | sendNotify('coming') |
| `done` | 保育園 | → `done`（終端） | markPickedUp |
| `call` | サロン | → `late-hold`（電話確認済み・来園予定。no-show を止める）。`data.lateMin` で `expectedStart/End` をずらす | confirmCall |
| `cancel` | サロン | → `cancelled`（保育園確認待ち） | confirmCancel |
| `cancel_ack` | 保育園 | `cancelled` → `done`（記録として残す） | ackCancel |
| `msg` | 両方 / fn | 状態は変えない。`kind:'late'/'early'` は `expectedEnd` だけ更新。`kind:'alert'` は Functions の未到着アラート | sendNotify(soon/late/early/handoff)・sendReport・ackCall・pushAutoAlert |

`no-show` はイベントではなく **Functions が state に書く**（§4-2）。来園すれば `arrived` で `waiting` へ進む。
後退は定義しない：reducer（§4-1）は「終端（done）以降のイベントは無視」「`waiting` 以降に `call` が来ても
status は変えない（expected だけ更新）」とする。

### 3-3. `sf_notify_state/{bookingId}` — Functions だけが書く状態（端末は read のみ）

| フィールド | 型 | 内容 |
|---|---|---|
| `bookingId` / `garden` / `salon` / `date` | string | 予約から転記 |
| `status` | string | `reserved` / `waiting` / `picking` / `done` / `no-show` / `late-hold` / `cancelled` |
| `start` / `end` | string | 予約の時刻（転記。予約が動けば追従） |
| `expectedStart` / `expectedEnd` | string | call / late / early を畳み込んだ見込み |
| `lateMin` | number | 累計のズレ（正=遅れ） |
| `dueAt` | timestamp | 未到着判定の期限 = `date start` + 猶予（既定5分・`sf_config/nfserver.graceMin`）。call の遅れ分も加える |
| `noShowAt` | timestamp? | no-show を書いた時刻（1回きりの印） |
| `lastEventId` / `lastEventAt` | string / timestamp | 畳み込んだ最後のイベント |
| `eventCount` | number | 畳み込んだイベント数（冪等性の確認用） |
| `updatedAt` | timestamp | serverTimestamp |
| `expireAt` | timestamp | TTL |

**reserved の state は予約から作る**（§4-3）。これで「state が無い＝予約が無い」になり、端末は
sf_bookings と state の2本で描ける。

### 3-4. 旧形式 `sf_notify`（c / s / n）— 互換期間だけ Functions が書く

形式は現行のまま（`{g, k, key, ts, data, _w:{dev:'fn', ver}}`）。c は state から、n は直近の `pickup/call/cancel/msg`
から、s は当日の msg/alert から組む。`_w.dev = 'fn'` で見分ける。ブリッジを止めたら書かない・消す（§8）。

### 3-5. 保持期間（TTL）

Firestore の TTL ポリシー（削除は無料）で `expireAt` を使う。events 90日・state 30日（未決 §11）。
旧 sf_notify の「翌朝に当日分を消す」掃除は不要になる（端末は消さない）。

### 3-6. 複合インデックス（`firestore.indexes.json`）

- `sf_notify_events`: (`garden` ASC, `date` ASC, `at` ASC)、(`bookingId` ASC, `at` ASC)
- `sf_notify_state`: (`garden` ASC, `date` ASC)、(`date` ASC, `status` ASC, `dueAt` ASC)

---

## 4. Cloud Functions（プロジェクト strawberry-field-timely・asia-northeast1・v2）

構成は eye405-app に倣う：`functions/index.js`（登録だけ）＋ `functions/lib/*.js`（純粋関数）＋
`functions/test/*.test.js`（node:test）。Node 22・firebase-admin ^14・firebase-functions ^7。
純粋関数 `lib/nfstate.js` の `reduce(booking, events, now)` に判定を集め、Functions 3本は「読む→reduce→書く」だけ。

### 4-1. `onNotifyEventCreated` — events の onCreate で state を再計算

```
onDocumentCreated({ document: 'sf_notify_events/{id}', region })
  1. ev = event.data.data()。ev.by === 'fn' のアラート（kind:'alert'）は無視（自分が書いたもの）
  2. db.runTransaction:
       booking = get sf_bookings/{bookingId}（無ければ state を書かず warn で終了）
       evs = query sf_notify_events where bookingId == X orderBy at（トランザクション内の読み）
       next = reduce(booking, evs, now)
       cur  = get sf_notify_state/{bookingId}
       if (cur && cur.eventCount >= evs.length && cur.lastEventId === next.lastEventId) return  // 既に反映済み
       set sf_notify_state/{bookingId} = next（merge なし・丸ごと）
  3. ブリッジが on なら旧形式 c/n/s を書く（§8）
```

**冪等性**：state は「そのイベント集合の純粋関数」なので、同じ呼び出しが2回来ても、順番が入れ替わっても、
最後に commit した結果は同じ。トランザクション内でイベント集合を読むため、2つの呼び出しが競合しても
後勝ちの結果は常に「より多いイベント集合」の畳み込みになる。`at` は serverTimestamp なので端末の時計は
順序に関与しない（同一秒の衝突は eventId の辞書順で決める・reduce 内で固定）。

`reduce` の規則（抜粋）：
- 初期 = `reserved`（予約の start/end）。終端（done）以降は何も効かない。
- `arrived` → waiting。`pickup` → picking（waiting でなくても）。`done` → done。
- `call` → status が reserved / no-show のときだけ late-hold。`lateMin` を expected に反映。
- `cancel` → cancelled（reserved / no-show / late-hold のときだけ）。`cancel_ack` → done。
- `msg` の late/early → expectedEnd だけ更新。他の msg は無視（表示は端末が events から行う）。
- `dueAt` = date+start+graceMin（call の遅れがあれば +lateMin）。no-show の印は state の `noShowAt` を保つ
  （reduce は `noShowAt` を引数の cur から引き継ぎ、arrived 以降は status を前進させる）。

### 4-2. `notifyNoShowScan` — 1分おきの未到着判定（1回だけ・冪等）

```
onSchedule({ schedule: 'every 1 minutes', timeZone: 'Asia/Tokyo', region })
  営業時間外（既定 07:00〜20:00 JST の外。sf_config/nfserver.scanHours）は即 return
  q = sf_notify_state where date == today && status == 'reserved' && dueAt <= now   （通常0件＝読み取り1）
  各 doc について db.runTransaction:
     cur = get state; evs = query events where bookingId == X
     if (evs に arrived/call/cancel がある || cur.noShowAt) return      // 既に動いている・既に印あり
     booking = get sf_bookings/{id}; if (booking.cancelled) return
     create sf_notify_events/noshow_{bookingId} = {type:'msg', kind:'alert', by:'fn', ...}   // create() は既存なら失敗
     set state {status:'no-show', noShowAt: now, ...}
```

**1回だけ**の担保は3重：クエリ条件（status が reserved のものだけ）、state の `noShowAt`、イベントIDの固定
（`noshow_{bookingId}` を `create()`＝既存なら例外）。1分関数が重なって走っても2回目は必ず落ちる。
予約時刻が動いた（board で変更）場合は §4-3 が dueAt を更新するので、新しい時刻で判定し直す
（no-show 後に時刻が後ろへ動いたら reserved に戻すかは未決 §11）。

### 4-3. `onBookingWrittenForNotify` — 予約から reserved の state を作る・追従させる

```
onDocumentWritten({ document: 'sf_bookings/{id}', region })
  after が無い（削除）→ state を削除（イベントは残す）
  after.date が今日より前 → 何もしない（過去の取り込みは対象外）
  salon が woodstock/janis 以外（ext_am / ext_pm / temp など内部生）→ 何もしない
  cancelled → state.status = 'cancelled'（イベントは不要。表示は端末が「美容室がキャンセル」を出す）
  それ以外 → runTransaction で evs を読み reduce(after, evs) を書く（start/end/dueAt の追従）
```

これにより notify 端末は **state が無い予約を描かない**（state が来るまで「同期中」）。board で予約が
増える瞬間の多端末競合も、state を書くのが Functions 1本なので起きない。

### 4-4. 旧形式ブリッジ（互換期間のみ・`sf_config/nfserver.legacyBridge == true` のとき）

- **新→旧**：4-1 / 4-2 / 4-3 の末尾で `sf_notify` の c（state から）・n（直近の pickup/call/cancel/msg）・
  s（当日の msg/alert の一覧）を書く。`_w.dev='fn'`。`ts` と `data.stTs` は now（旧版端末の版ガードに勝つ）。
- **旧→新** `onLegacyNotifyWritten`：`sf_notify/{id}` の onWritten で `_w.dev !== 'fn'` かつ `k === 'c'` の
  **status の前進**（reserved→waiting / →done / →late-hold / →cancelled）を `arrived/done/call/cancel` イベントに
  翻訳（eventId = `legacy_{docId}_{status}` で冪等）。`k === 'n'` の coming/call/cancel も同様に翻訳。
  `k === 's'` の様子ログ（report）は `msg/report` に翻訳（`legacy_{salon}_{ts}`）。
  **後退（waiting→reserved 等）は翻訳しない**：旧版端末の誤判定が新構造へ流れ込む唯一の口を塞ぐ。
- 旧版端末の no-show（pushAutoAlert）は翻訳しない。新構造の no-show は 4-2 だけが書く。

---

## 5. 端末側の変更一覧（notify 3本・同一パッチで同時に）

| # | いま | 新 |
|---|---|---|
| 1 | `onSnapshot(sf_notify)` 全件購読（園の絞り込みは手元） | `sf_notify_state where garden==G && date==today`、`sf_notify_events where garden==G && date==today orderBy at`。日またぎで張り直し（nfDayRollCheck に相乗り）。sf_bookings の購読は現状維持 |
| 2 | `children[salon][]` を予約＋手元の状態で組む | 予約（sf_bookings）× state を **sfId で結合して毎回組み直す**（手元に状態を持たない）。state が無い予約は「同期中」表示 |
| 3 | `nfSave / nfBuildDocs / nfApplySnapshot / nfApplyChildStates / NF_MIRROR / NF_SNAP_SEEN / NF_BOOKINGS_SEEN / __nfApplying / stTs / NF_CHILD_FIELDS / NF_ARRIVED_STATUS / __nfRejected / nfCanAutoJudge / NF_JUDGE_MAX_AGE_MS / __nfSrvAt` | **全部削除**（SF-NOTIFY-CLOUD / NFSAVE-CANON / NFGUARD / NFGUARD2 のマーカーごと） |
| 4 | `checkArrivals`（30秒）・`pushAutoAlert` | **削除**。未到着はサーバーの state `no-show` と `msg/alert` イベントで描く |
| 5 | `markArrived / markPickedUp / confirmCall / confirmCancel / ackCancel / ackCall / sendNotify / sendReport` が children を書き換える | すべて `nfEmit(type, bookingId, kind, data)` 1本に集約。`setDoc(doc(db,'sf_notify_events', id), {..., at: serverTimestamp()})`。状態は触らない。楽観表示は SDK の latency compensation（自分の pending イベントも snapshot に載る）に任せ、ボタンは「送信中」に |
| 6 | `notifications[]`（受信ボード）を手元で増減・n doc で共有 | 当日 events から導出：子ごとに最新の `pickup/call/cancel/msg(soon/late/early/handoff)` を1枚のカード、`done/cancel_ack/arrived` が後に来たら下げる（純粋関数 `feedOf(events, state)`） |
| 7 | `statusLogs[salon]`（様子ログ）を手元で増減・s doc | 当日 events（`arrived/done/msg`）から導出。表示ラベルは端末の辞書（`NF_LABELS[type|kind]`）で生成 |
| 8 | 音・点滅：`__nfSeenKeys`（key\|ts） | events の `at` が直近10分以内かつ `by !== SF_DEV_ID` かつ未再生 eventId のときだけ鳴らす（初回 snapshot は鳴らさない＝現状踏襲） |
| 9 | 未送信：なし（nfWrite の失敗は console のみ） | SF-UNSENTBOX-20261014 と同型の**イベント未送信箱**（localStorage `notify_unsent_events_v1`）。10秒で未決着なら箱へ、起動時・online・sfWakeSync 後・赤帯タップで同じ eventId を再送。permission-denied（既存）は「届いていた」として外す |
| 10 | 日またぎ掃除（nfSave が昨日分を削除） | **端末は消さない**。TTL が消す |
| 11 | `nfHandleCancelledBooking`（予約の cancelled 印→受信ボード） | state.status === 'cancelled' かつ `cancel` イベントが無い → 「美容室がキャンセルしました」カード（端末記憶 `__nfCxlSeen` は不要・state 由来で冪等） |
| 12 | SF-WAKESYNC / NETWATCH / DEVICES / SINGLETAB / UNSENTBOX の基盤 | **据え置き**（接続の見張りと台帳はそのまま要る） |
| 13 | テスト用フック | `localStorage sf_emulator_host` があれば `connectFirestoreEmulator`（§10 のエミュレータ E2E 用。本番では無視） |

削除で notify は 500〜700行減る見込み。残る「判定」は表示の導出関数だけになり、**端末は Firestore に状態を1バイトも書かない**。

---

## 6. 起動シーケンス（新）

1. `__sfDbReady` → 匿名サインイン → 台帳・版確認（現状）
2. 購読3本（sf_bookings 窓・state 当日・events 当日）を張る。3本の初回 snapshot が揃うまで「クラウドと同期中です」
3. 描画 = `view(bookings, state, events)` の純粋関数。snapshot が来るたび丸ごと作り直す（差分マージ無し）
4. ボタン → `nfEmit` → 自分の pending が snapshot に載る → 描画。サーバーの state 反映は通常1〜2秒後
5. 前面復帰（WAKESYNC）→ 張り直し → snapshot 丸ごと → 描画。**復帰時に端末が判断することは無い**

---

## 7. Firestore ルール（2026-10-27 承認・適用済み）

現行ルールはコンソールにしか無かった（`match /{document=**} { allow read, write: if request.auth != null; }`）。
手順0 で `firestore.rules` としてリポジトリに取り出し、次の形に変えて適用した（実物は `firestore.rules`）。

- **全体 match を `/{collection}/{document=**}` にし、`sf_notify_events` と `sf_notify_state` を除外**。
  Firestore のルールは match ごとの allow の OR なので、全体 match を残したままでは個別の `if false` が効かない。
- `sf_notify_events/{id}`：read は signedIn、**create だけ** signedIn かつ `nfEventOk()`（キー集合の制限・
  bookingId / garden / date / salon / type の値域・`at == request.time`＝serverTimestamp 必須・`by != 'fn'`）。
  update / delete は `false`。
- `sf_notify_state/{id}`：read は signedIn、write は `false`（Functions＝Admin SDK はルールの対象外）。
- 旧 `sf_notify` は互換期間中は従来どおり（全体 match）。ブリッジ停止後に除外リストへ足して書き込み禁止にする（手順7・要承認）。

検証は `tests/rules/`（REST `projects.test` 20項目＋本番裏取り）。

## 8. 移行手順（Functions → ルール → 端末 の順）

| 手順 | 内容 | 戻し方 |
|---|---|---|
| 0 | **済（10/27・545abb0）** `firebase.json` / `.firebaserc` / `firestore.rules`（現行）/ `firestore.indexes.json` を追加。`functions/` は手順2で。GitHub Pages 配信には影響しない（hosting は使わない） | ファイル削除 |
| 1 | `sf_config/nfserver` を作る：`{graceMin:5, scanHours:[7,20], legacyBridge:true, enabled:false}`。`enabled:false` の間、端末の新コードは出さない | — |
| 2 | **Functions デプロイ**（3本＋ブリッジ）。この時点で動くのは 4-3（予約→state）と 旧→新ブリッジだけ＝**影運転**。既存端末は何も変わらない。fleet のように `apps/nfstate.html`（読み取り専用の確認ページ・任意）か REST で、state と旧 c doc が一致するかを 2〜3 営業日見る。4-2 も走るが、state の no-show と旧端末のアラートの時刻が一致するかを見る材料になる（旧形式へは書かない設定で始める：`legacyBridge:'readonly'`） | `firebase functions:delete` 3本（state は残っても誰も読まない） |
| 3 | 影運転の差分がゼロ → `legacyBridge:true`（新→旧も書く）。旧端末の画面が Functions 由来の c/n/s で描かれることを確認（_w.dev='fn'） | `legacyBridge:'readonly'` |
| 4 | **済（10/27・前倒し）** ルール適用（§7）。REST `projects.test` 20項目＋本番裏取りで確認。新コレクションはまだ誰も使わないので先に入れても既存に影響しない | 545abb0 の `firestore.rules` を再デプロイ（Firebase はルールの履歴も保持） |
| 5 | **端末配信**：notify 3本の新コード（§5）をコミット → 版の刻印 → push → 本番 smoke → `sf_config/version`。新端末は events/state だけを見る。旧端末はブリッジで新端末の操作が見える（新→旧）、旧端末の操作も新端末に見える（旧→新・前進だけ） | notify 3本を前の版へ戻して版の刻印（旧形式はブリッジが書き続けているので旧端末は即復帰） |
| 6 | fleet.html で notify 全端末が新版になったのを確認（個人スマホは本人に開き直してもらう）。1週間の経過観察 | — |
| 7 | `legacyBridge:false`（旧形式を書かない）→ 旧 sf_notify の match を `allow write: if false`（承認）→ 旧ドキュメント削除 | ブリッジ再開 |
| 8 | 端末の未送信箱と TTL の動作確認。DESIGN-status-sync.md を「置換済み」に更新 | — |

**順序の理由**：Functions が先に居れば、ルールと端末のどちらを戻しても旧形式が書かれ続けるので、
どの段階でも旧端末が壊れない。端末を先に出すと「state を書く人が居ない」状態ができる。

---

## 9. 課金見積（月寒＋白石の実測ベース・4園分で安全側に2倍）

実測：1日の予約（内部生を除く）は園あたり 2〜8件。イベントは子1人あたり 5〜8件（arrived / soon /
coming / done / 様子 2〜3）。端末は notify 12台前後（sf_devices）。

| 項目 | 1日 | 1か月 | 単価（asia-northeast1・要確認） | 月額目安 |
|---|---|---|---|---|
| events 書き込み（端末） | ~150 | ~4,500 | $0.115 / 10万 writes | ≈ ¥1 |
| Functions の読み（4-1：イベント集合＋予約＋state ≈ 12 reads × 150 ＝ 1,800、4-2：空クエリ1 read × 780 ≈ 800、4-3：≈ 300） | ~3,000 | ~90,000 | $0.038 / 10万 reads | ≈ ¥5 |
| Functions の書き（state ≈ 450 ＋ 互換期間の c/n/s ≈ 900） | ~1,400 | ~40,000 | $0.115 / 10万 writes | ≈ ¥7 |
| 端末の読み（12台 × 当日 state 20 + events 150 の初回 ＋ 変化分 ≈ 12 × 300） | ~3,600 | ~110,000 | 同上 | ≈ ¥6 |
| Functions 実行回数（4-1 150 ＋ 4-2 780 ＋ 4-3 300） | ~1,200 | ~37,000 | 無料枠 200万/月 | ¥0 |
| Functions 実行時間（≈ 0.3 s × 256MB × 37,000） | — | ≈ 2,800 GB-s | 無料枠 40万 GB-s/月 | ¥0 |
| Cloud Scheduler（1 job） | — | — | 3 job まで無料 | ¥0 |
| Eventarc / Pub/Sub（Firestore トリガー） | — | 37,000 msg | 無料枠内 | ¥0 |
| Artifact Registry（関数コンテナ） | — | ~0.5 GB | $0.10/GB/月 | ≈ ¥8 |
| TTL 削除 | ~600 | — | 無料 | ¥0 |

合計 **月 ¥30 前後**（Firestore の無料枠 5万 reads/日・2万 writes/日は Blaze でも効くので実際はほぼ ¥0）。
現状の読み取り（2026-09-04 実測 3.9万/日）に対し、端末の sf_notify 全件購読が当日分に絞られるぶん
**減る方向**。CLAUDE.md §0.5 の「毎朝使用状況を見る」は手順2〜6 の間は必ず続ける。

4-2 を Cloud Tasks で「予約ごとに dueAt に1回」にすれば 780 回/日の空振りも消えるが、部品が増えるので
初版はスケジュール方式（§11）。

---

## 10. エミュレータでの検証計画

eye405-app と同じく `firebase emulators:exec` で Firestore＋Functions（＋Auth）を立てる。プロジェクトIDは `demo-strawberry`。

### 10-1. 純粋関数（node:test・エミュレータ不要・`functions/test/nfstate.test.js`）
- reduce：イベント順序の入れ替え・重複・同一秒衝突で結果が同じ（冪等・可換）
- 後退しない：waiting/done/late-hold に対する「何も無い」「call」「cancel」で status が戻らない
- call の lateMin → expectedStart/End/dueAt、late/early の累積、early の開始時刻クランプ（現行 sendNotify と同値）
- no-show：dueAt 前は付かない・arrived/call/cancel があれば付かない・noShowAt は1回で固定
- feedOf / labels：受信ボード1枚/子・done で下がる・handoff は「お迎え完了」ボタンを出さない（現行踏襲）

### 10-2. Functions 統合（`functions/test/emu.*.test.js`・`emulators:exec`）
- events を1件 create → state が期待どおり。同じ events を2回・逆順で create しても state が同じ
- 4-1 を同じイベントで2回呼ぶ（emulator の再送を模擬）→ state の eventCount が増えない
- 4-2 を時計を進めて2回走らせる → `noshow_{id}` が1件・state.noShowAt が1回・2回目は create 失敗で終了
- 4-3：予約の時刻変更 → dueAt 追従、cancelled → state cancelled、削除 → state 削除
- ブリッジ：legacyBridge の各モードで c/n/s の有無、旧 c の前進だけが events に翻訳され後退は無視

### 10-3. ルール（Firebase Rules REST API `projects.test`・`tests/rules/rules_rest_test.mjs`。Java が無いためエミュレータは使わない）
- 匿名ユーザー：events create OK（serverTimestamp）、`at` を固定時刻にすると拒否、`by:'fn'` 拒否、余分なキー拒否、
  update / delete 拒否、state write 拒否、未認証は read も拒否
- 既存コレクション（sf_bookings / sf_visits / sf_devices ...）の挙動が現行ルールと同じ（取り出した現行ルールで回帰）

### 10-4. 端末（Playwright）
- 既存 `tests/playwright/stubs.js` に `addDoc / serverTimestamp(sentinel) / connectFirestoreEmulator` と
  `__emit` の `hasPendingWrites` を足し、新テスト `test_nfserver.js`：ボタン→events への setDoc 1件（状態の書き込みゼロ）、
  state/events の snapshot だけで描画が決まる、復帰模擬（時刻だけ進める）で書き込みゼロ・判定ゼロ、
  未送信箱の再送と permission-denied の扱い、日またぎで購読の張り直し、音は他端末のイベントだけ
- **エミュレータ E2E**：`localStorage sf_emulator_host` で notify 3本を本物の SDK＋エミュレータにつなぎ、
  2つのブラウザコンテキスト（保育園・サロン）で「預かり→向かっています→完了」と「no-show→来園」を通す。
  本番には触れない

### 10-5. 本番（手順8の前）
- 影運転の比較スクリプト（REST 読み取り専用）：state と旧 c doc の status が一致しない予約を日次で列挙
- notify 3本 smoke（起動・購読3本のサーバー確定・JSエラー0・版）

---

## 11. 未決事項（決めてほしいこと）

1. **call / cancel を独立イベントにするか `msg` の kind にするか**：状態に効くので独立にした（§3-2）。
   `type` を 4つに固定したいなら `msg` に畳めるが、reducer が kind を見ることになる。
2. **no-show 後に予約時刻が後ろへ動いたら reserved へ戻すか**：戻す（dueAt が未来になった時点で status を
   reserved に戻し noShowAt を消す）案と、戻さない案。現行は戻さない。
3. **スキャンの営業時間**：07:00〜20:00 JST を既定にした。サロンの最終予約に合わせて調整。
4. **TTL**：events 90日・state 30日。記録として残したい期間があれば延ばす（コストは容量のみ）。
5. **個人スマホの未送信箱**：standalone でない Safari は背面でタブが落ちやすい。localStorage の箱で足りるか、
   それとも「送信中はボタンをロックして決着まで待つ」だけにするか。
6. **なりすまし**：匿名認証なので `by` は自己申告。園・サロンの区別も自己申告。本気で防ぐなら端末ごとの
   招待コード→カスタムクレーム（eye405 の role と同型）。本設計の範囲外。
7. ~~Firestore のロケーションと Functions リージョン~~ → **解決**：`(default)` は asia-northeast1（10/27 確認）。Functions も asia-northeast1。
8. **Cloud Tasks 方式**（予約ごとに dueAt で1回）への切替時期：初版はスケジュール方式。空振り読み取りが
   気になれば切替。
9. **影運転の期間**：2〜3 営業日を提案。長いほど安全だが、その間は旧構造の事故が起きうる。
10. **fleet.html への state 表示**（本部から各園の当日状態を見る）：読み取り専用なので安全だが、読み取り回数が増える。

---

## 12. リスク

- **Functions が落ちている間**は状態が止まる（イベントは溜まる・復旧後に全部畳み込まれる＝取りこぼし無し）。
  端末は「state の updatedAt が最後のイベントより 2 分以上古い」ときに「サーバー処理待ち」を出す。
- **デプロイ・ルール変更の手順ミス**が本番の保育を止めうる → §8 の順序と、各手順の戻し方を守る。
- **ブリッジの双方向ループ**：fn が書いた旧 c（_w.dev='fn'）を旧→新ブリッジが拾わないこと、fn のイベントを
  4-1 が拾わないことを 10-2 で必ず検証。
- **読み取り増**：端末の購読を当日分に絞るのが前提。`where garden==G && date==today` を外すと全件購読に戻る。
