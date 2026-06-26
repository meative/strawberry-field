# DESIGN — お子様「状態」の端末間同期（notify.html）

作成 2026-06-26 / ステータス: **設計確定・実装未着手**

このファイルは、notify.html の「お迎え・遅延通知」を**別々の端末間でリアルタイム同期**させるための設計メモ。チャットで設計を固めた成果。次セッションはこれを読んで実装の第一歩から入る。

---

## 0. 背景（なぜこれをやるのか）

現状の notify.html は、1画面の中に「サロン側パネル（左）」と「保育園側 受信ボード（右）」が同居し、ボタン押下→通知表示→音が鳴る、が**その画面内で完結**している。画面上部の但し書き「実際は別々のiPadで動きます（Firebase連携後）」がこれを指す。

つまり機能はすでに全部できている。足りないのは、**サロン側端末の操作を、保育園側端末に届ける**こと。これは新規開発ではなく **Firebase化の続き**。予約データ（sf_bookings）で既にできている同期を、各お子様の「状態」にも広げる。

---

## 1. スコープ（今回やること／やらないこと）

### やること
- お子様の **状態（status）** を全端末で同期する
- 状態に付随する情報も同期: lateMin, expectedEnd, expectedStart, callLateMin, callConfirmed, sentComing, cancelTime/cancelTs, lastLateTime 等

### やらないこと（次段階に回す）
- **「様子のお便り」（ごきげん / お昼寝 / ミルク / ごはん）の同期**。これは status とは別の「流れてくる通知」（履歴型）。状態同期が確実に動いてから別途実装する。

理由: 状態同期がお迎え運用の中心。まずそこを確実に動かし、切り分けやすくするため一度に全部やらない。

---

## 2. 設計の核（方式①: 状態を予約レコードに持たせる）

チャットで2方式を比較し、**方式①（状態型）**に決定。

- **方式①**: 各予約（sf_bookings の1件）に「状態」フィールドを持たせ、出来事のたびに書き換える。常に「今の状態」が1つ見える。お迎え現場の「今どの子がどういう状態か」の共有に最適。
- 方式②（履歴型・別コレクション）は「様子のお便り」など流れてくる通知向け。次段階で部分的に使う想定。

### 載せる場所
**既存の sf_bookings の各レコードに状態フィールドを追記する。新コレクションは作らない。**

### 紐付けキー
**既存の sfId（= sf_bookings のドキュメントID）。** 新しい紐付けの仕組みは不要。
→ notify.html には既に importSharedBookings() があり、Firestore レコード r.id を読んで各お子様に sfId: r.id を付けている。「どの予約がどの子か」の対応はすでに取れている。これが今回の設計が安全に始められる最大の理由。

---

## 3. 状態の一覧（STATUS_INFO）

notify.html に既に定義済み。同期対象はこの status 値。

| status | 表示 | 意味 |
|---|---|---|
| reserved | 予約済み | 朝の初期状態 |
| waiting | お預かり中 | 来園して預かり確定 |
| late-hold | 電話確認済み | 電話で来園予定を確認 |
| no-show | 未到着 | 受付時間経過の自動アラート |
| cancelled | キャンセル | 本日お預かりなし |
| done | お迎え完了 | 一連の流れ終了 |

状態遷移の主な流れ:
reserved →（来園）waiting →（お迎え完了）done
reserved →（電話確認）late-hold →（来園）waiting
reserved →（キャンセル）cancelled →（保育園が確認）done

---

## 4. 実装の2側面

### A. 書き込み側（状態を Firestore に保存）
押されたら該当レコードの状態を Firestore に書き込むよう、各ボタン関数を変更する。対象関数:

- markArrived(salonKey, idx) — 預かり完了 → waiting
- confirmCall(kind, lateMin) — 電話確認 → late-hold（+ lateMin/expectedEnd 等）
- markPickedUp(salonKey, idx) — お迎え完了 → done
- confirmCancel() — キャンセル → cancelled
- sendNotify(type, i) — 遅れ/早まり/もう向かっています等（lateMin, expectedEnd, sentComing 更新）
- ackCancel(salonKey, idx) — 保育園がキャンセル確認 → done
- ackCall(salonKey, idx) — 保育園が電話確認内容を確認（status は late-hold のまま）
- askSalon(salonKey, idx) — サロンに確認（状態は変えないが要検討）

### B. 読み込み側（状態を画面に反映）
各端末の onSnapshot（sf_bookings 購読）が状態変化を検知 → importSharedBookings() に「状態の取り込み」を足す → 該当画面を再描画（renderChildren / renderArrivalList / renderFeed）。

現状の importSharedBookings() は、既存の子には次回予約・氏名・月齢などを更新しているが、**status は reserved の子の時間しか触っていない**（来園後の状態はローカルのまま）。ここに「Firestore 側の status を正として取り込む」ロジックを足すのが読み込み側の肝。

---

## 5. 重要な注意・リスク（実装時に必ず守る）

- **本番稼働中の sf_bookings に手を入れる。** 既存の予約データ構造を壊さないこと。状態フィールドは「無ければ reserved とみなす」後方互換にする（古いレコードや他画面が壊れないように）。
- **書き込みの競合**: サロン側と保育園側がほぼ同時に同じ子を操作する可能性。Firestore は last-write-wins。どちらを優先すべきか（特に状態の巻き戻り）を実装時に検討。
- **段階的に進める。** 一度に全関数を変えない。まず**書き込み側の1関数だけ**（例: markArrived）を変更 → 2端末で「片方で預かり完了→もう片方に反映」を確認 → 1つずつ増やす。
- **Firestore ルール厳格化（期限 7/19）との関係**: この同期作業で sf_bookings への書き込みが増える。ルールを if request.auth != null にしても、匿名認証済みなら書ける設計なので問題ないが、**ルール厳格化を先に済ませる場合は、その後この実装の書き込みが通るか必ず確認**する。
- **検証は実機（別々の端末）で。** 1画面内では「同期しているか」を確認できない（元々ローカルで動くため）。必ず2台（iPad + Mac 等）で開いて、片方の操作が他方に出るかを見る。

---

## 6. 次セッションの最初の一歩（推奨）

1. このファイルを読む
2. notify.html の importSharedBookings() と markArrived() の現物を確認
3. **書き込み側を1関数だけ**実装: markArrived が waiting を Firestore に保存するようにする（既存の sfLoad/sfSave 系の仕組みを流用）
4. 2端末で確認: 保育園側で「預かり完了」→ サロン側端末の表示が変わるか
5. 動いたら次の関数へ。動かなければここで切り分け

---

## 関連
- 親ドキュメント: HANDOFF.md
- 最優先の別タスク: Firestore ルール厳格化（期限 2026-07-19）
- 「様子のお便り」同期: 本タスク完了後の次段階
