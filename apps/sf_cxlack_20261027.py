# -*- coding: utf-8 -*-
"""
SF-CXLACK-20261027 : キャンセル通知の「確認しました」が効かない・カードが起動端末のたびに再着信する（notify 3本）

症状（10/27 月寒）：美容室がキャンセルした予約のカード（07:09 発生）が 15:24 に「再着信」し、「確認しました」を押しても消えない。
原因：
  (1) キャンセル済みの予約は importSharedBookings が children に取り込まない（SF-CANCELFLAG-20260926）。キャンセル後に起動した
      端末では子が存在せず、nfHandleCancelledBooking は childIdx:-1 のカードを積む。ackCancel は nfChild() が null を返すと
      何もせず return するため、カードも n ドキュメントも消えない。
  (2) 起動した端末は __nfCxlSeen（localStorage）が空なので、sf_bookings が sf_notify より先に届くと Date.now() の ts で
      キャンセル通知を作り直し、nfSave が n ドキュメント（key 収束）を新しい ts で上書きする → 全端末で「再着信」して鳴る。
      10/27 15:24 の再着信は本番 smoke（新規コンテキスト）が起こした。
  (3) NFGUARD2 の B（NF_ARRIVED_STATUS）に cancelled が無く、届いた reserved / no-show が手元の cancelled を戻しうる。
直し方：
  A. nfHandleCancelledBooking：sf_notify の初回受信（NF_SNAP_SEEN）前は何もしない（初回受信後に importSharedBookings を呼び直す）。
     クラウドの c が done（確認済み）ならカードを積まない。子が無ければ cancelled の子を作る（確認・表示・c の共有が他端末と同じ経路になる）。
     通知と子の時刻は予約の cancelledAt に固定（端末ごとに ts が違わない＝n/c が書き直されない・再着信しない）。
  B. ackCancel：子が無ければ予約から done の子を作ってから従来どおり（c に done を残す＝起動端末がカードを再生成しない）。
     通知は key でも sfId でも消す。
  C. NF_ARRIVED_STATUS に cancelled を追加。
安全設計：全アンカー出現回数==1 を検証、編集単位で冪等、タイムスタンプ付きバックアップ、<script> ごとに node --check。
"""
import io, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ['notify.html', 'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html']

OLD_ARR = "const NF_ARRIVED_STATUS = { 'late-hold': 1, waiting: 1, picking: 1, done: 1 };"
NEW_ARR = "const NF_ARRIVED_STATUS = { 'late-hold': 1, waiting: 1, picking: 1, done: 1, cancelled: 1 /* SF-CXLACK-20261027 : キャンセルも戻さない */ };"

OLD_CXL_HEAD = """  const name = (r.info && r.info.name) ? r.info.name : r.name;
  if (!name) return;
  const list = children[r.salon] || [];
  const idx = list.findIndex(c => c && c.sfId === r.id);
  const c = idx >= 0 ? list[idx] : null;
  let changed = false;
  /* 取り込み済みの子は「キャンセル」に（お預かり中・完了・お迎え中は触らない） */
  if (c && (c.status === 'reserved' || c.status === 'no-show' || c.status === 'late-hold')) {
    const now = new Date();
    c.status = 'cancelled'; c.cancelled = true; c.stTs = Date.now();
    c.cancelTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    c.cancelTs = now.getTime();
    changed = true;
  }
  if (!__nfCxlSeen[r.id]) {
    __nfCxlSeen[r.id] = 1;
    nfCxlSaveSeen();
    const key = `${r.salon}|${name}`;
    const dup = (notifications || []).some(n => n && n.key === key && n.type === 'cancel');
    if (!dup) {
      const now2 = new Date();
      const tm = `${String(now2.getHours()).padStart(2,'0')}:${String(now2.getMinutes()).padStart(2,'0')}`;
      notifications = (notifications || []).filter(x => x && x.key !== key);
      notifications.unshift({
        key, type: 'cancel', salon: SALON_JP[r.salon], salonKey: r.salon, childIdx: idx,
        sfId: r.id, childName: name, time: tm, ts: now2.getTime(),"""
NEW_CXL_HEAD = """  const name = (r.info && r.info.name) ? r.info.name : r.name;
  if (!name) return;
  /* SF-CXLACK-20261027 : クラウドの通知・子状態（sf_notify）を見てから判断する。初回受信前に作ると、
     Date.now() の ts で通知を作り直して n ドキュメントを上書きし、全端末で「再着信」する（10/27 15:24）。
     初回受信後は nfApplySnapshot が importSharedBookings を呼び直すので、ここで待っても取りこぼさない。 */
  if (!NF_SNAP_SEEN) return;
  /* SF-CXLACK-20261027 : 時刻は予約の cancelledAt に固定（端末ごとに違わない＝n / c が書き直されない） */
  const cxlTs = Number(r.cancelledAt) || Date.parse(r.cancelledAt) || Date.now();
  const cxlD = new Date(cxlTs);
  const cxlTm = `${String(cxlD.getHours()).padStart(2,'0')}:${String(cxlD.getMinutes()).padStart(2,'0')}`;
  /* SF-CXLACK-20261027 : クラウドの c が done＝どこかの端末が「確認しました」済み。カードを積まない・子も作らない */
  const cxlCloud = NF_MIRROR[nfDocId('c', r.id)];
  if (cxlCloud && cxlCloud.data && cxlCloud.data.status === 'done') {
    if (!__nfCxlSeen[r.id]) { __nfCxlSeen[r.id] = 1; nfCxlSaveSeen(); }
    return;
  }
  const list = children[r.salon] || [];
  let idx = list.findIndex(c => c && c.sfId === r.id);
  let c = idx >= 0 ? list[idx] : null;
  let changed = false;
  /* SF-CXLACK-20261027 : キャンセル後に起動した端末には子が無い（取り込みはキャンセルを除外）。cancelled の子を作って、
     表示・「確認しました」・c の共有を、キャンセル前から居た端末と同じ経路に乗せる。 */
  if (!c) {
    c = { name, age: r.age, months: r.months, start: r.start, end: r.end,
      groupId: r.groupId || null, groupSeq: r.groupSeq || null, groupTotal: r.groupTotal || null,
      status: 'cancelled', cancelled: true, stTs: cxlTs, cancelTs: cxlTs, cancelTime: cxlTm,
      sfId: r.id, nextReservation: null, nextResvRaw: null, provisional: r.provisional, date: r.date || todayStr() };
    list.push(c); idx = list.length - 1;
    if (!__nfCxlSeen[r.id]) { __nfCxlSeen[r.id] = 1; nfCxlSaveSeen(); }
    changed = true;
  }
  /* 取り込み済みの子は「キャンセル」に（お預かり中・完了・お迎え中は触らない） */
  if (c && (c.status === 'reserved' || c.status === 'no-show' || c.status === 'late-hold')) {
    c.status = 'cancelled'; c.cancelled = true; c.stTs = cxlTs;   /* SF-CXLACK-20261027 : 時刻は cancelledAt */
    c.cancelTime = cxlTm;
    c.cancelTs = cxlTs;
    changed = true;
  }
  if (!__nfCxlSeen[r.id] || c.status === 'cancelled') {   /* SF-CXLACK-20261027 : 確認前なら、カードが無いときだけ積み直す */
    __nfCxlSeen[r.id] = 1;
    nfCxlSaveSeen();
    const key = `${r.salon}|${name}`;
    const dup = (notifications || []).some(n => n && n.type === 'cancel' && (n.key === key || n.sfId === r.id));
    if (!dup) {
      const tm = cxlTm;
      notifications = (notifications || []).filter(x => x && x.key !== key);
      notifications.unshift({
        key, type: 'cancel', salon: SALON_JP[r.salon], salonKey: r.salon, childIdx: idx,
        sfId: r.id, childName: name, time: tm, ts: cxlTs,   /* SF-CXLACK-20261027 : ts は cancelledAt */"""

OLD_ACK = """function ackCancel(salonKey, idx, sfId) {
  /* SF-NOTIFY-CHILD-IDENTITY-20260723 */
  const c = nfChild(salonKey, idx, sfId);
  if (!c) return;
  c.status = 'done';
  c.stTs = Date.now();   /* SF-NFGUARD-20260925 */
  // 受信ボードのキャンセル通知を消す
  const key = `${salonKey}|${c.name}`;
  notifications = notifications.filter(x => x.key !== key);"""
NEW_ACK = """function ackCancel(salonKey, idx, sfId) {
  /* SF-NOTIFY-CHILD-IDENTITY-20260723 */
  let c = nfChild(salonKey, idx, sfId);
  /* SF-CXLACK-20261027 : キャンセル後に起動した端末には子が無く、従来はここで return してカードも n も消えなかった。
     予約から done（キャンセル確認済み）の子を作って従来の経路に乗せる＝c に done が残り、起動端末がカードを再生成しない。 */
  if (!c && sfId) {
    const r = (typeof sfLoad === 'function' ? sfLoad() : []).find(x => x && x.id === sfId);
    const n = (notifications || []).find(x => x && x.type === 'cancel' && x.sfId === sfId);
    if (r || n) {
      c = { name: (r && ((r.info && r.info.name) || r.name)) || (n && n.childName) || '', age: r ? r.age : undefined, months: r ? r.months : undefined,
        start: (r && r.start) || (n && n.start), end: (r && r.end) || (n && n.end),
        status: 'cancelled', cancelled: true, sfId, date: (r && r.date) || todayStr() };
      (children[salonKey] = children[salonKey] || []).push(c);
    }
  }
  if (!c) { notifications = (notifications || []).filter(x => !(x && x.type === 'cancel' && x.sfId === sfId)); renderFeed(null); return; }
  c.status = 'done';
  c.cancelled = true;
  c.stTs = Date.now();   /* SF-NFGUARD-20260925 */
  if (!__nfCxlSeen[sfId || c.sfId]) { __nfCxlSeen[sfId || c.sfId] = 1; nfCxlSaveSeen(); }
  // 受信ボードのキャンセル通知を消す
  const key = `${salonKey}|${c.name}`;
  notifications = notifications.filter(x => !(x.key === key || (x.type === 'cancel' && x.sfId && x.sfId === c.sfId)));   /* SF-CXLACK-20261027 : sfId でも消す */"""

OLD_FIRST = """  if (first && NF_BOOKINGS_SEEN) nfSave();   /* SF-NFGUARD-20260925 : 予約初回前は保留。sfApplySnapshot 側が受信後に実行する */"""
NEW_FIRST = """  /* SF-CXLACK-20261027 : 初回受信後に取り込みを呼び直す。キャンセル済み予約の扱い（nfHandleCancelledBooking）は
     クラウドの通知・子状態を見てから決めるため、sf_bookings が先に届いた順でも取りこぼさない。 */
  if (first && NF_BOOKINGS_SEEN && typeof importSharedBookings === 'function') { try { importSharedBookings(); } catch (e) { console.error('[SF-CXLACK-20261027]', e); } }
  if (first && NF_BOOKINGS_SEEN) nfSave();   /* SF-NFGUARD-20260925 : 予約初回前は保留。sfApplySnapshot 側が受信後に実行する */"""

EDITS = [(OLD_ARR, NEW_ARR), (OLD_CXL_HEAD, NEW_CXL_HEAD), (OLD_ACK, NEW_ACK), (OLD_FIRST, NEW_FIRST)]

def node_check(path, s):
    ok = True
    for m in re.finditer(r'<script([^>]*)>(.*?)</script>', s, re.S):
        attrs, body = m.group(1), m.group(2)
        if 'src=' in attrs or not body.strip(): continue
        fd, tmp = tempfile.mkstemp(suffix='.mjs' if 'module' in attrs else '.js'); os.close(fd)
        io.open(tmp, 'w', encoding='utf-8').write(body)
        r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True); os.unlink(tmp)
        if r.returncode != 0: ok = False; print('  node --check NG (%s):\n%s' % (path, r.stderr[:600]))
    return ok

plan = {}
for f in FILES:
    s = io.open(os.path.join(HERE, f), encoding='utf-8').read()
    todo = []
    for old, new in EDITS:
        if new in s: continue
        n = s.count(old)
        if n != 1: raise SystemExit('ANCHOR NG (%s): count=%d for: %s' % (f, n, old[:60]))
        todo.append((old, new))
    if not todo: print('%-26s already applied, skip' % f); continue
    plan[f] = (s, todo)
if not plan: print('nothing to do'); sys.exit(0)
stamp = time.strftime('%Y%m%d_%H%M%S')
for f, (s, todo) in plan.items():
    p = os.path.join(HERE, f)
    shutil.copy2(p, p + '.bak_' + stamp)
    for old, new in todo: s = s.replace(old, new)
    io.open(p, 'w', encoding='utf-8').write(s)
    print('%-26s %d edits OK, syntax %s' % (f, len(todo), 'OK' if node_check(p, s) else 'NG'))
print('DONE')
