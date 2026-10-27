# -*- coding: utf-8 -*-
"""
SF-NFGUARD2-20261027 : お迎え通知の「復帰直後の誤判定」を塞ぐ（notify 3本）

症状（10/26 月寒）：12:30〜15:00 の予約の子が 12:29「お預かりしました」のあと、14:25 / 14:30 / 15:18 に
  「まだ来園されていません」へ3回戻り、完了後もアラートが出続けた。sf_devices の lastSeen 14:30:35 と
  15:18:26 がアラート時刻と一致（＝その瞬間に起動または前面復帰した端末がある）。

原因：背面で凍っていた端末（standalone・single-tab で各インスタンスが独立）が前面復帰した瞬間、
  期限切れの setInterval(checkArrivals) がサーバー snapshot より先に走り、停止前の 'reserved' を根拠に
  no-show を判定 → 新しい stTs で c ドキュメントを書く。SF-NFGUARD-20260925 の版ガードは「決定の新しさ」
  （stTs）しか比べないため、古いデータに基づく新しい決定は自端末でも他端末でも通ってしまう。

直し方：
  A. sf_notify の購読に includeMetadataChanges を付け、サーバー確定（fromCache=false）の受信時刻を
     window.__nfSrvAt に残す。checkArrivals は「前面」かつ「__nfSrvAt あり」かつ「最終受信
     （__sfWakeLastSnap）から5分以内」のときだけ自動判定する。刻印（sfWakeMarkSnapshot）も
     サーバー確定のときだけ行う（metadata-only の fromCache=true で刻印すると「同期待ち」と
     NETWATCH の生存判定が誤って fresh になるため）。
  B. nfApplyChildStates で、届いた status が reserved / no-show、手元が late-hold / waiting / picking / done
     なら stTs に関係なく適用しない（来園前へ戻す正規の経路は存在しない）。

安全設計：全ファイルで各アンカーの出現回数 == 1 を検証し、1つでも違えば0バイトも書かない。
  マーカー SF-NFGUARD2-20261027 で冪等（適用済みは skip）。タイムスタンプ付きバックアップ。
  書き込み後に <script> ブロックごとに node --check。
"""
import io, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ['notify.html', 'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html']
MARK = 'SF-NFGUARD2-20261027'

OLD_SUB = """    onSnapshot(collection(db, NFCOL), (snap) => {
      window.sfWakeMarkSnapshot();   /* SF-WAKESYNC-20260930 : 受信の刻印 */
      const arr = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      if (typeof window.nfApplySnapshot === 'function') window.nfApplySnapshot(arr);
    }, (e) => console.error('[onSnapshot sf_notify] subscribe failed', e));"""
NEW_SUB = """    /* SF-NFGUARD2-20261027 : metadata 付きで購読し、サーバー確定（fromCache=false）の受信時刻を
       window.__nfSrvAt に残す。checkArrivals の自動判定はこれが立ち、かつ最終受信が新しいときだけ動く。
       刻印（sfWakeMarkSnapshot）もサーバー確定のときだけ：includeMetadataChanges を付けると
       disableNetwork 直後などに fromCache=true の metadata だけの snapshot が届くため、それで刻印すると
       「同期待ち」と NETWATCH の生存判定が誤って fresh になる。 */
    onSnapshot(collection(db, NFCOL), { includeMetadataChanges: true }, (snap) => {
      const srv = !(snap.metadata && snap.metadata.fromCache);
      if (srv) { window.__nfSrvAt = Date.now(); window.sfWakeMarkSnapshot(); }   /* SF-WAKESYNC-20260930 : 受信の刻印（サーバー確定のみ） */
      const arr = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      if (typeof window.nfApplySnapshot === 'function') window.nfApplySnapshot(arr);
    }, (e) => console.error('[onSnapshot sf_notify] subscribe failed', e));"""

OLD_FIELDS = """                         'stTs' /* SF-NFGUARD-20260925 : 状態を最後に変えた時刻（版ガード用） */];"""
NEW_FIELDS = """                         'stTs' /* SF-NFGUARD-20260925 : 状態を最後に変えた時刻（版ガード用） */];
/* SF-NFGUARD2-20261027 : 来園後の状態。届いた 'reserved' / 'no-show' でここから戻すことは stTs の新旧に関係なく拒否する。 */
const NF_ARRIVED_STATUS = { 'late-hold': 1, waiting: 1, picking: 1, done: 1 };
let __nfRejected = false;   // SF-NFGUARD2-20261027 : 直近の適用で後退を拒否したか（拒否したら自分の状態を書き戻す）"""

OLD_APPLY = """      const docTs = Math.max(w.ts || 0, s.stTs || 0);
      if ((c.stTs || 0) > docTs) return;
      NF_CHILD_FIELDS.forEach(f => { if (s[f] !== undefined) c[f] = s[f]; });"""
NEW_APPLY = """      const docTs = Math.max(w.ts || 0, s.stTs || 0);
      if ((c.stTs || 0) > docTs) return;
      /* SF-NFGUARD2-20261027 : 来園後の状態（late-hold / waiting / picking / done）を、届いた 'reserved' / 'no-show' で
         戻さない（stTs の新旧に関係なく）。来園前へ戻す正規の経路は無く、戻ってくるのは古いデータに基づく
         他端末の判定だけ。拒否した側は want≠mirror となり自分の状態を書き直すので、クラウドは前進側に収束する。 */
      if ((s.status === 'reserved' || s.status === 'no-show') && NF_ARRIVED_STATUS[c.status]) { __nfRejected = true; return; }
      NF_CHILD_FIELDS.forEach(f => { if (s[f] !== undefined) c[f] = s[f]; });"""

OLD_CHECK = """// 未到着の自動判定（予約開始+5分を過ぎてreservedのままなら no-show）
function checkArrivals() {
  let changed = false;
  allChildren().forEach(({c, salonKey}) => {"""
NEW_CHECK = """/* SF-NFGUARD2-20261027 : 自動判定は「この端末がいま最新を見ている」ときだけ。
   10/26 月寒：背面で凍っていた端末が前面復帰した瞬間、期限切れの setInterval がサーバー snapshot より先に
   走り、停止前の 'reserved' を根拠に no-show を判定 → 新しい stTs で c を書き、他端末の 'waiting' / 'done' を
   3回戻した。版ガード（stTs）は「決定の新しさ」しか比べないので、古いデータに基づく新しい決定は通ってしまう。
   条件：画面が前面 ／ 起動後にサーバー確定の sf_notify を1回以上受信（__nfSrvAt）／
   最終受信（__sfWakeLastSnap。静かな時間帯は NETWATCH が2分超で確認を取って進める）から5分以内。
   復帰直後は最終受信が数時間前のままなので、サーバー snapshot が届くまで判定しない。 */
const NF_JUDGE_MAX_AGE_MS = 5 * 60 * 1000;
function nfCanAutoJudge() {
  try {
    if (document.visibilityState !== 'visible') return false;
    if (!(window.__nfSrvAt > 0)) return false;
    if ((Date.now() - (window.__sfWakeLastSnap || 0)) > NF_JUDGE_MAX_AGE_MS) return false;
    return true;
  } catch (e) { return false; }
}
// 未到着の自動判定（予約開始+5分を過ぎてreservedのままなら no-show）
function checkArrivals() {
  let changed = false;
  if (!nfCanAutoJudge()) { renderArrivalList(); return; }   /* SF-NFGUARD2-20261027 : 最新を見ていない間は判定しない */
  allChildren().forEach(({c, salonKey}) => {"""

OLD_AFTER = """  } finally {
    __nfApplying = false;
  }
  /* SF-NOTIFYRECV-20260830 : 受け取った端末で音と点滅を出す。"""
NEW_AFTER = """  } finally {
    __nfApplying = false;
  }
  /* SF-NFGUARD2-20261027 : 後退を拒否したら、自分の（前進側の）状態をすぐ書き戻す。次の描画まで待つと
     その間クラウドが 'reserved' / 'no-show' のままになり、起動してきた端末がそれを見て再アラートしうる。
     書き戻しは差分方式（nfSave）なので、相手が前進側を受け入れれば往復は止まる。 */
  if (__nfRejected) { __nfRejected = false; if (NF_BOOKINGS_SEEN) { try { nfSave(); } catch (e) {} } }
  /* SF-NOTIFYRECV-20260830 : 受け取った端末で音と点滅を出す。"""

EDITS = [(OLD_SUB, NEW_SUB), (OLD_FIELDS, NEW_FIELDS), (OLD_APPLY, NEW_APPLY), (OLD_CHECK, NEW_CHECK), (OLD_AFTER, NEW_AFTER)]

def node_check(path, s):
    ok = True
    for m in re.finditer(r'<script([^>]*)>(.*?)</script>', s, re.S):
        attrs, body = m.group(1), m.group(2)
        if 'src=' in attrs or not body.strip(): continue
        ext = '.mjs' if 'module' in attrs else '.js'
        fd, tmp = tempfile.mkstemp(suffix=ext); os.close(fd)
        io.open(tmp, 'w', encoding='utf-8').write(body)
        r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
        os.unlink(tmp)
        if r.returncode != 0:
            ok = False; print('  node --check NG (%s):\n%s' % (path, r.stderr[:800]))
    return ok

# phase 1: verify
plan = {}
for f in FILES:
    p = os.path.join(HERE, f)
    s = io.open(p, encoding='utf-8').read()
    todo = []
    for old, new in EDITS:
        if new in s: continue   # この編集は適用済み（冪等）
        n = s.count(old)
        if n != 1:
            raise SystemExit('ANCHOR NG (%s): count=%d for: %s' % (f, n, old[:60]))
        todo.append((old, new))
    if not todo:
        print('%-26s already applied, skip' % f); continue
    plan[f] = (s, todo)
if not plan:
    print('nothing to do'); sys.exit(0)

# phase 2: write
stamp = time.strftime('%Y%m%d_%H%M%S')
for f, (s, todo) in plan.items():
    p = os.path.join(HERE, f)
    shutil.copy2(p, p + '.bak_' + stamp)
    for old, new in todo:
        s = s.replace(old, new)
    io.open(p, 'w', encoding='utf-8').write(s)
    print('%-26s %d edits OK, syntax %s' % (f, len(todo), 'OK' if node_check(p, s) else 'NG'))
print('DONE')
