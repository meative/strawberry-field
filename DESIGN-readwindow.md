# DESIGN — Firestore 読み取り削減（SF-READWINDOW-20260907）

設計確定 2026-09-07。**2026-09-08 時点：Phase 0〜2 完了・本番反映済み**（`a5fce50` / `8507bdd`）。
次は実測 → Phase 3（期限 9/30）→ Phase 4。このファイルは実装が進むたびに「状態」欄を更新すること。

## 2026-09-08 の作業ログ

- Phase 0：sf_bookings 899件を検出スニペットで点検。date 無し 0 件（窓導入の絶対条件クリア）。
  完全重複3組の後発3件を削除（timely 側の参照は予約リストの写しのみ、visits 参照なしを確認してから）。
  日曜の ext_am 10件は幼稚舎生の日曜終日預かりの実利用、前日付け39件は board に UTC 経路が無く
  すべてスタッフの後日入力 → 対応不要
- Phase 1：salon 3本・notify 3本に永続キャッシュ移植（`a5fce50`）。Playwright で7本の IndexedDB 起動を確認
- Phase 2：12本に日付窓（`8507bdd`）。Playwright 12/12・timely 登録ガード 34/34。
  本番 URL で board / salon / notify / timely の4画面を確認（SF_WINDOW_START のログ＝
  2026-09-01 / 09-07 / 09-07 / 08-01、今日の予約表示、コンソールエラー 0）→ 合格。
  以後、各 iPad の再読み込みで新しい購読に切り替わる
- 現場で変わること：board で今月より前の日に移動すると予約が空表示（Phase 3 まで）。
  salon / notify / timely の日常操作は変わらない
- 別件：日曜の休日保育を「早朝（ext_am）」で記録している運用。日報の区分に「休日保育」を
  立てるかは判断待ち（CLAUDE.md §9「区分追加は3箇所同時」案件）

---

## 背景（確定した実測値）

- 2026-09-02：読み取り14万件/日で Spark 無料枠（5万件/日）を超過し枠切れ → 同日 Blaze へ移行
- 2026-09-04 実測：読み取り 3.9万件/日（無料枠の78%）、書き込み191、削除3、
  同時接続ピーク6、リスナーピーク15前後
- クラウド実件数：sf_bookings **855**、sf_visits 66、sf_customers 45前後、sf_students 6
- 1ページ読み込み ≒ 970件 = **855（sf_bookings）+ 117（timelyの3コレクション）**。
  読み取りの約88%が sf_bookings。バグではなく、12ファイル全部が where も limit も
  無しで全件購読しているのが原因（onSnapshot 13箇所は洗い出し済み・多重登録なし）
- 放置すると予約の蓄積に比例して線形に増える

## 方針（3本柱）

1. **sf_bookings に日付窓**：`onSnapshot(query(collection(db, COL), where('date', '>=', 窓開始)))`。
   下限のみ・上限なし（次回予約などの将来日レコードは常に窓内）
2. **persistentLocalCache を salon 3本・notify 3本へ**（SF-OFFLINE-SALON / SF-OFFLINE-NOTIFY）。
   board.html の initializeFirestore try/catch ブロックの移植。timely（SF-OFFLINE-20260826）・
   board（SF-OFFLINE-BOARD-20260830）は導入済み
3. **窓の外はオンデマンド1回読み（getDocs）**：board の過去日表示・カレンダードットと
   timely の過去月レポートだけが対象

## 確定した設計判断

### 判断1：過去データは案C（オンデマンド読み）。案A（消失許容）・案B（集計doc）は不採用

過去日のボードが空表示になると現場では「予約が消えた」に見える（実際に会計の巻き戻り・
入力消失を経験しているため、そう見えること自体がコスト）。timely レポートの
オンデマンド読み（Phase 4）はどのみち必須なので、board 側（Phase 3）はその機構の再利用。
案B（予約のある日付だけを持つ集計doc）は、12ファイル全部の書き込み側で集計docの保守が
必要になり、消し忘れ・足し忘れが永久にズレとして残るため不採用。

### 判断2：フェーズ分割（暫定広窓 → あとで絞る）。一発断行はしない

本番稼働中・12ファイル・iPad 運用。暫定広窓なら各フェーズで機能劣化ゼロのまま
分割コミットできる。**Phase 1+2 完了時点で Firebase 使用状況を実測し、Phase 3・4 が
本当に必要かを数字で判断する**（広窓だけで無料枠に余裕があれば 3・4 は急がない）。

### 判断3：窓の開始日は日またぎで張り直さない

窓は下限のみなので、タブを開きっぱなしで日をまたいでも窓は「広がる」方向にしか
ずれず、データが隠れる事故は起きない。逆に張り直すと新しいクエリ＝新しいリスナーで
**全件再読みが発生**する。次のページ読み込みで自然に新しい窓になるのを待つ方が
安全で安上がり。SF-BOARDBASE-ROLL-20260830（基準日の付け替え）とは独立で、干渉しない。

### 窓の広さ（アプリ別）

| 系統 | 暫定（Phase 2） | 最終 | 根拠 |
|---|---|---|---|
| salon 3本 | 昨日 | 昨日のまま | 過去日を参照するコードが無い（選択日と当日のみ） |
| notify 3本 | 昨日 | 昨日のまま | 当日分しか表示しない |
| board 5本 | **当月1日** | 昨日（Phase 3 後） | 月末に今月のボードを振り返る運用（8/31「8/24 のぶんが消えていた」報告）を守る。当初案の「35日前」は8月分597件がほぼ全部残り効かないため変更。**Phase 3 は 9/30 より前に本番投入**が条件（間に合わなくても当月窓なら崖は出ない） |
| timely 1本 | 前月1日 | 昨日（Phase 4 後） | 日報・月報の早朝・延長件数が SF_MIRROR の過去日走査に依存（sfKinderExtCounts :8327） |

窓開始は各ファイル冒頭の定数（SF_WINDOW_DAYS 等）とし、起動時に1回だけ
JST（端末時計）で計算する。

## 壊してはいけないものと対処（実コードで確認済み）

- **date 無しレコード**：board :2557 / :1774 / :2922、salon :2066 / :2300、notify :1048 に
  「date 無し＝表示中の日付扱い」の分岐が現存。**where はフィールド欠落 doc を返さない**ため、
  date 無しの生きたレコードがあると窓導入で全画面から消える。
  → **Phase 0 で 0件確認が実装の絶対条件**。見つかったら**削除ではなく date の補完**で対処
  （補完値はレコード内容を見て決める。createdAt 由来を第一候補とする）。
  この分岐の由来：初期コミット（6/16, 321e840）では予約レコードに date フィールドが無く
  （単日プロトタイプ）、6/19 の Firestore 移行（88b672e）で「date を持たない移行前
  レコードを表示し続けるための後方互換」として導入された。分岐自体は窓導入後も触らず残す
- **timely の fromBoard 削除パス**（:8737-8740）：「共有に無い id は DATA.reservations からも
  消す」ため、窓導入で過去の fromBoard 予約が誤削除される。→ Phase 4 で
  「窓内のレコードだけ削除対象」のガードを窓と同時に入れる
- **sf_visits / sf_customers / sf_students への窓・limit は禁止**：tlMergeByVersion が
  「cloud に無い id は手元からも落とす」設計のため、窓外レコードがローカルからも消える
  事故に直結する。117件は許容。増えたら年次アーカイブ移設で別途設計
- **組（partyId）・区間（groupId）・次回予約（fromNextOf）**：区間・組は同日内で完結、
  次回予約は将来日。いずれも日付窓で分断されない
- **判定エンジン（rangeAvailable / capEffAge / consumedSlots / rebuildUsed）**：対象日は
  常に今日以降＝窓内。一切触らない
- **sf_capacity**：base + 日別例外で高々十数doc（読みの1%未満）。触らない
- **sf_notify**：当日分しか表示しないので窓は可能だが doc 数未計測。測ってから判断
- 過去日レコードのオンデマンド読み分は **SF_MIRROR に混ぜず表示専用キャッシュ**に持つ
  （混ぜると次のスナップショットで消える・sfSave の差分/削除計算に絡む）。
  過去日予約の編集・削除は fbReconcile の set が upsert・削除が明示 deleteDoc なので
  mirror に無くても正しく動くが、Phase 3 の実機確認項目に含める

## 実装順（1フェーズ＝1実機確認＝1コミット）

| Phase | 内容 | 対象 | 状態 |
|---|---|---|---|
| 0 | 検出スニペットで sf_bookings の健全性確認（date無し0件の確認・重複・日曜ext・連日ペア）と掃除 | クラウドデータ | **完了 2026-09-08**：899件中 no-date 0・bad-format 0。完全重複3組は後から作られた3件（`board_1784777591766_81x87` / `board_1784802110252_362nv` / `board_1784802251050_838pq`）を削除。日曜の ext_am 10件は幼稚舎生の日曜終日預かり（休日保育）の実利用で対応不要（区分を立てるかは別件）。前日付け39件は board に UTC 経路が無く全部スタッフの後日入力、対応不要 |
| 1 | persistentLocalCache 移植 | salon 3本 + notify 3本 | **完了 2026-09-08** `a5fce50`（sf_offline_salon_notify_20260908.py。Playwright で7本の IndexedDB 起動を確認） |
| 2 | 日付窓（暫定広窓）。パッチスクリプト sf_readwindow_20260908.py（アンカー出現1回検証・2フェーズ書き込み・バックアップ・node --check・期待差分の機械算出）。timely は fromBoard 削除パスの窓ガードも同時に投入 | 12本全部 | **完了 2026-09-08** `8507bdd`（Playwright 12/12、本番4画面で確認合格） |
| — | **Firebase 使用状況を実測**し Phase 3・4 の要否を数字で判断 | — | **次のアクション**：9/9 以降に Firebase コンソールで読み取り数/日を確認（比較基準 9/4：3.9万件/日） |
| 3 | 過去日ナビ＋カレンダードットのオンデマンド読み → board の窓を昨日へ。**期限：9/30 より前**（月末に今月より前のボードを見る運用のため） | board 5本 | 未着手 |
| 4 | レポートのオンデマンド読み（SF_ARCHIVE）＋fromBoard削除パスの窓ガード → timely の窓を昨日へ | timely 1本 | 未着手 |

## Phase 0 検出スニペット（ASCII のみ・board.html のコンソールで実行）

窓導入後は過去分がミラーに無くなるため、**必ず窓導入前に実行**する。
検出対象：date 無し／形式不正、完全重複（園|日付|名前|サロン|開始）、日曜の ext_am/ext_pm、
同一内容の連日ペア（SF-JSTDATE-20260830 以前の前日ズレの典型形）、月別件数。

```js
(function () {
  if (typeof sfLoad !== 'function') { console.error('run on board.html (sfLoad not found)'); return; }
  var rows = sfLoad();
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var t = new Date();
  var todayStr = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  var fmtOk = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); };
  var noDate = [], badDate = [], byKey = {}, extSun = [], byMonth = {}, idx = {};
  var isExt = { ext_am: 1, ext_pm: 1 };
  var keyOf = function (r, d) {
    return [r.gardenId || '', d, r.name || '', r.salon || '', r.start || ''].join('|');
  };
  rows.forEach(function (r) {
    if (!r) return;
    if (!r.date) { noDate.push(r); return; }
    if (!fmtOk(r.date)) { badDate.push(r); return; }
    byMonth[String(r.date).slice(0, 7)] = (byMonth[String(r.date).slice(0, 7)] || 0) + 1;
    var k = keyOf(r, r.date);
    (byKey[k] = byKey[k] || []).push(r);
    idx[k] = r;
    if (isExt[r.salon] && new Date(r.date + 'T12:00:00').getDay() === 0) extSun.push(r);
  });
  var dups = Object.keys(byKey).filter(function (k) { return byKey[k].length > 1; });
  var shifted = [];
  rows.forEach(function (r) {
    if (!r || !r.date || !fmtOk(r.date)) return;
    var d = new Date(r.date + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    var nx = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    var hit = idx[keyOf(r, nx)];
    if (hit) shifted.push({ id_a: r.id, date_a: r.date, id_b: hit.id, date_b: nx,
      name: r.name || '', salon: r.salon || '', start: r.start || '', gardenId: r.gardenId || '' });
  });
  console.log('total:', rows.length,
    '| past(date<today):', rows.filter(function (r) { return r && r.date && r.date < todayStr; }).length);
  console.log('no date field:', noDate.length); if (noDate.length) console.table(noDate);
  console.log('bad date format:', badDate.length); if (badDate.length) console.table(badDate);
  console.log('per month:'); console.table(byMonth);
  console.log('exact duplicates:', dups.length);
  dups.forEach(function (k) {
    console.log(' DUP', k, byKey[k].map(function (r) { return r.id; }));
  });
  console.log('ext_am/ext_pm on Sunday:', extSun.length);
  if (extSun.length) console.table(extSun.map(function (r) {
    return { id: r.id, date: r.date, gardenId: r.gardenId, salon: r.salon, name: r.name, start: r.start };
  }));
  console.log('same booking on consecutive dates (JST shift suspects):', shifted.length);
  if (shifted.length) console.table(shifted);
})();
```

## 期待効果

- 窓（暫定広窓）のみ：board ≒280件・timely ≒480件/load → 全体 3.9万 → 1万前後/日
- 最終形（昨日窓＋キャッシュ）：5千前後/日。以後、予約総数が増えても読みは増えない
