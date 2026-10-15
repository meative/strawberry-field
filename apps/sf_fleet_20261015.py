# -*- coding: utf-8 -*-
# SF-TOMBSTONE-20261015 / SF-WRITESTAMP-20261015 / SF-DEVICES-20261015
# 12本（timely / board 5本 / salon 3本 / notify 3本）へ：
#  ③ 書き込み刻印 _w:{dev, ver, at}（全 setDoc / updateDoc / batch.set。既存フィールドは不変）
#     ＋ sfChangedOnly の差分判定から _w を除外（混ざると毎回「全件変わった」になり全件書き直しになる）
#  ④ 端末台帳 sf_devices/{dev} と版確認 sf_config/version（起動時・前面復帰時。古ければ1日1回まで自動再読込、入力中は後回し）
#  ② 墓石 sf_tombstones（timely のみ：tlDel で書く・購読して復活を自動削除・90日保持）
# すべて置換前にアンカーの一意性を検証し、1つでも合わなければ何も書かない。
import io, sys, re

FILES = {
    'timely.html':            ('timely', "(typeof DATA !== 'undefined' && DATA.settings && DATA.settings.branch) || ''"),
    'board.html':             ('board',  "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'board_sp_factory.html':  ('board',  "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'board_sp_shiraishi.html':('board',  "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'board_sp_shiseikan.html':('board',  "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'board_sp_tsukisamu.html':('board',  "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'salon.html':             ('salon',  "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'salon_sp_shiraishi.html':('salon',  "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'salon_sp_tsukisamu.html':('salon',  "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'notify.html':            ('notify', "(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'notify_sp_shiraishi.html':('notify',"(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
    'notify_sp_tsukisamu.html':('notify',"(typeof CURRENT_GARDEN !== 'undefined' && CURRENT_GARDEN) || ''"),
}

MODULE_BLOCK = """  const auth = getAuth(app);
  /* ============================================================
     SF-WRITESTAMP-20261015 : 書き込み刻印。すべての setDoc / updateDoc / batch.set の
     ペイロードに _w:{dev, ver, at} を付ける（データ形式の追加のみ。既存フィールドは不変）。
     10/8 朝、旧版ページを開いたままの端末が削除済み visit 2件を書き戻した事故で、
     「どの端末のどの版がいつ書いたか」がクラウド側に何も残っておらず特定に手間取った。
     SF-DEVICES-20261015 : 端末台帳 sf_devices/{dev}（1端末1件・更新のみ）と版確認。
     sf_config/version の ver と自分の SF_APP_VER が違えば自動再読込（1日1回まで・入力中は後回し）。
     ============================================================ */
  const SF_APP_NAME = '__APP__';
  const SF_APP_VER = '__VER__';   // 版の刻印。リリース時にコミット短縮SHAへ置換する（手順は CLAUDE.md）
  const SF_DEV_ID = (() => {
    try {
      let d = localStorage.getItem('sf_device_id_v1');
      if (!d) { d = 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('sf_device_id_v1', d); }
      return d;
    } catch (e) { return 'D-nostorage'; }
  })();
  const SF_TAB_ID = 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  window.SF_APP_VER = SF_APP_VER; window.SF_DEV_ID = SF_DEV_ID;
  const sfStamp = (rec) => {
    try { return Object.assign({}, rec, { _w: { dev: SF_DEV_ID, ver: SF_APP_VER, at: new Date().toISOString() } }); }
    catch (e) { return rec; }
  };
  const sfGardenHint = () => { try { return __GARDEN__; } catch (e) { return ''; } };
  const sfDeviceBeat = (why) => {
    try {
      const ua = String(navigator.userAgent || '');
      let ios = (ua.match(/(?:iPhone|iPad|CPU) OS (\\d+[._]\\d+)/) || [])[1] || '';
      ios = ios ? ios.replace('_', '.')
        : ((/Macintosh/.test(ua) && (ua.match(/Version\\/(\\d+\\.\\d+)/) || [])[1]) ? 'mac-safari ' + (ua.match(/Version\\/(\\d+\\.\\d+)/) || [])[1] : '');
      let tabsHint = 1;   // 同一端末で最近5分に生きていたタブ数の目安（複数タブ運用の検知用）
      try {
        const K = 'sf_tabs_hint_v1', now = Date.now();
        const m = JSON.parse(localStorage.getItem(K) || '{}');
        m[SF_TAB_ID] = now;
        Object.keys(m).forEach(k => { if (now - m[k] > 5 * 60 * 1000) delete m[k]; });
        localStorage.setItem(K, JSON.stringify(m));
        tabsHint = Object.keys(m).length;
      } catch (e) {}
      setDoc(doc(db, 'sf_devices', SF_DEV_ID), sfStamp({
        garden: sfGardenHint(), app: SF_APP_NAME, ver: SF_APP_VER, ua: ua.slice(0, 200),
        iosVersion: ios, lastSeen: new Date().toISOString(), tabsHint: tabsHint,
      })).catch((e) => console.warn('[SF-DEVICES-20261015] 台帳の更新に失敗', e));
    } catch (e) {}
  };
  let __sfVerBusy = false;
  const sfVersionCheck = (why) => {
    if (__sfVerBusy) return;
    __sfVerBusy = true;
    getDoc(doc(db, 'sf_config', 'version')).then((snap) => {
      __sfVerBusy = false;
      const latest = (snap && snap.exists() && snap.data()) ? snap.data().ver : null;
      if (!latest || latest === SF_APP_VER) return;
      const K = 'sf_verreload_at_v1';
      let last = 0; try { last = Number(localStorage.getItem(K) || 0); } catch (e) {}
      if (Date.now() - last < 24 * 3600 * 1000) {
        console.warn('[SF-DEVICES-20261015] 版が古い（' + SF_APP_VER + '→' + latest + '）。本日は再読込済みのため見送り');
        return;
      }
      const tryReload = () => {
        const a = document.activeElement;
        const typing = !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable))
          || !!(typeof window.__sfBusyHint === 'function' && window.__sfBusyHint());
        if (typing) { console.log('[SF-DEVICES-20261015] 入力中のため再読込を後回し'); setTimeout(tryReload, 60 * 1000); return; }
        try { localStorage.setItem(K, String(Date.now())); } catch (e) {}
        console.warn('[SF-DEVICES-20261015] 新しい版へ再読み込みします ' + SF_APP_VER + ' → ' + latest);
        location.reload();
      };
      tryReload();
    }).catch((e) => { __sfVerBusy = false; });
  };
  window.sfDeviceBeat = sfDeviceBeat; window.sfVersionCheck = sfVersionCheck;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { sfDeviceBeat('visible'); sfVersionCheck('visible'); }
  });
  window.addEventListener('pageshow', (e) => { if (e && e.persisted) { sfDeviceBeat('pageshow'); sfVersionCheck('pageshow'); } });
  /* ===== SF-WRITESTAMP-20261015 / SF-DEVICES-20261015 ここまで ===== */"""

STRIPW = """/* SF-WRITESTAMP-20261015 : _w（書き込み刻印）は差分判定から除く。snapshot 由来のレコードには
   _w が付き、手元で組み立てたレコードには付かないため、混ぜて比較すると毎回「全件変わった」と
   判定されて全件書き直し（書き込み枠の浪費と上書き競合）になる。 */
function sfStripW(o) {
  if (o && typeof o === 'object' && !Array.isArray(o) && o._w !== undefined) {
    var c = Object.assign({}, o); delete c._w; return c;
  }
  return o;
}
function sfCanon(v) {"""

TOMB_MODULE = """  window.fbPutBooking = async (rec) => {"""

TOMB_MODULE_NEW = """  /* SF-TOMBSTONE-20261015 : 削除の墓石。tlDel が sf_tombstones/{id} に {kind, deletedAt, by} を
     書き、購読側（tlApplyTombstones）が「墓石付き id が snapshot に現れたら自動で deleteDoc し直す」。
     旧版ページの初回送り返し（10/8 の復活事故）をデータ側から無効化する。 */
  window.fbPutTombstone = async (kind, id) => {
    try {
      await setDoc(doc(db, 'sf_tombstones', String(id)), sfStamp({ kind: kind, deletedAt: new Date().toISOString(), by: SF_DEV_ID }));
      return { ok: true };
    } catch (e) { return fbErr('[SF-TOMBSTONE-20261015] 墓石の書き込みに失敗', e); }
  };
  window.fbDeleteTombstone = async (id) => {
    try { await deleteDoc(doc(db, 'sf_tombstones', String(id))); return { ok: true }; }
    catch (e) { return fbErr('[SF-TOMBSTONE-20261015] 墓石の削除に失敗', e); }
  };
  window.fbPutBooking = async (rec) => {"""

TOMB_SUB_ANCHOR = """      }, (e) => console.error('[onSnapshot] subscribe failed', kind, e));
    });"""

TOMB_SUB_NEW = TOMB_SUB_ANCHOR + """
    /* SF-TOMBSTONE-20261015 : 墓石を購読（90日より古いものは tlApplyTombstones 側で破棄・掃除） */
    onSnapshot(collection(db, 'sf_tombstones'), (snap) => {
      const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      if (typeof window.tlApplyTombstones === 'function') window.tlApplyTombstones(rows);
    }, (e) => console.error('[onSnapshot] subscribe failed', 'sf_tombstones', e));"""

TOMB_CLASSIC_ANCHOR = """/* ===== SF-ROSTER-PUBLISH-20260722 : サロン向け軽量名簿の発行 ====="""

TOMB_CLASSIC = """/* ============================================================
   SF-TOMBSTONE-20261015 : 削除の墓石。
   10/7 に削除した会計待ち2件が、旧版ページを開いたままの端末の「初回送り返し」
   （配列まるごとの writeBatch）で 10/8 朝 07:40 に復活した（REST の createTime=updateTime が
   2件とも同一マイクロ秒・updatedAt 無し・旧フィールド構成が証拠）。削除の事実そのものを
   クラウドに残し（sf_tombstones/{id} = {kind, deletedAt, by}）、墓石付き id が snapshot に
   現れたら自動で deleteDoc し直して表示からも除く。墓石は90日保持（超えたら破棄・掃除）。
   墓石を書くのは tlDel（自分の削除）だけ。snapshot 由来のレコードから墓石は作らない。
   ============================================================ */
var TL_TOMB = {};
window.tlApplyTombstones = function (rows) {
  var now = Date.now(), live = {}, purge = [];
  (rows || []).forEach(function (t) {
    if (!t || !t.id) return;
    var ts = Date.parse(t.deletedAt || '');
    if (isFinite(ts) && (now - ts) > 90 * 24 * 3600 * 1000) { purge.push(String(t.id)); return; }   // 90日で破棄
    live[String(t.id)] = t;
  });
  TL_TOMB = live;
  /* 期限切れ墓石の掃除（上限8件/回：SF-DELGUARD-20260831 と同じ節度） */
  purge.slice(0, 8).forEach(function (id) {
    if (typeof window.fbDeleteTombstone === 'function') window.fbDeleteTombstone(id);
  });
  tlSweepTombstoned('tombstones');
};
function tlSweepTombstoned(why) {
  try {
    var removed = 0;
    TL_KINDS.forEach(function (kind) {
      if (!TL_READY[kind]) return;   // クラウドビュー未確立では判定しない
      var revived = (DATA[kind] || []).filter(function (x) { return x && TL_TOMB[String(x.id)] && TL_TOMB[String(x.id)].kind === kind; });
      if (!revived.length) return;
      console.error('[SF-TOMBSTONE] revived=' + revived.map(function (x) { return kind + '/' + x.id; }).join(',')
        + ' → 自動で削除し直します (' + (why || '') + ')');
      DATA[kind] = (DATA[kind] || []).filter(function (x) { return !(x && TL_TOMB[String(x.id)] && TL_TOMB[String(x.id)].kind === kind); });
      revived.forEach(function (x) { if (typeof window.fbDeleteTl === 'function') window.fbDeleteTl(kind, x.id); });
      removed += revived.length;
    });
    if (removed) { saveViewCache(DATA); tlRerender(); }
  } catch (e) { console.error('[SF-TOMBSTONE]', e); }
}
/* SF-DEVICES-20261015 : 入力中の画面では自動再読込を後回しにする（module 側 sfVersionCheck が参照） */
window.__sfBusyHint = function () {
  var s = (typeof _currentScreen !== 'undefined') ? _currentScreen : '';
  return ['new', 'visit', 'payment', 'receipt'].indexOf(s) >= 0;
};

/* ===== SF-ROSTER-PUBLISH-20260722 : サロン向け軽量名簿の発行 ====="""


def patch(path, app, garden):
    s = io.open(path, encoding='utf-8').read()
    edits = []

    # E1: getDoc を import に追加
    if app == 'timely':
        edits.append(("onSnapshot, doc, setDoc, updateDoc, deleteDoc, writeBatch,",
                      "onSnapshot, doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch,"))
    else:
        edits.append(("onSnapshot, doc, setDoc, deleteDoc, writeBatch",
                      "onSnapshot, doc, getDoc, setDoc, deleteDoc, writeBatch"))

    # E2: 刻印＋台帳＋版確認ブロック（auth 行の直後）
    block = MODULE_BLOCK.replace('__APP__', app).replace('__GARDEN__', garden).replace('__VER__', 'dev')
    edits.append(("  const auth = getAuth(app);", block))

    # E3: sf_bookings の batch.set を刻印
    edits.append(("batch.set(doc(db, COL, String(r.id)), r);",
                  "batch.set(doc(db, COL, String(r.id)), sfStamp(r));   /* SF-WRITESTAMP-20261015 */"))

    # E4: 起動時の台帳更新と版確認
    edits.append(("signInAnonymously(auth).then(() => {",
                  "signInAnonymously(auth).then(() => {\n"
                  "    sfDeviceBeat('boot'); sfVersionCheck('boot');   /* SF-DEVICES-20261015 : 起動時の台帳更新と版確認 */"))

    # E5: sfChangedOnly の _w 除外
    edits.append(("function sfCanon(v) {", STRIPW))
    edits.append(("m[String(p.id)] = { o: p, s: sfCanon(p) };",
                  "m[String(p.id)] = { o: p, s: sfCanon(sfStripW(p)) };   /* SF-WRITESTAMP-20261015 */"))
    edits.append(("if (!e || e.o === n || e.s !== sfCanon(n)) out.push(n);",
                  "if (!e || e.o === n || e.s !== sfCanon(sfStripW(n))) out.push(n);   /* SF-WRITESTAMP-20261015 */"))

    # 家族ごとの書き込み口
    if app == 'board':
        edits.append(("return setDoc(doc(db, 'sf_kinder_attendance', kinderTodayId), payload, { merge: true });",
                      "return setDoc(doc(db, 'sf_kinder_attendance', kinderTodayId), sfStamp(payload), { merge: true });   /* SF-WRITESTAMP-20261015 */"))
        edits.append(("try { await setDoc(doc(db, CAP_COL, String(docId)), data); }",
                      "try { await setDoc(doc(db, CAP_COL, String(docId)), sfStamp(data)); }   /* SF-WRITESTAMP-20261015 */"))
    if app == 'notify':
        edits.append(("batch.set(doc(db, NFCOL, String(d.id)), d);",
                      "batch.set(doc(db, NFCOL, String(d.id)), sfStamp(d));   /* SF-WRITESTAMP-20261015 */"))
    if app == 'timely':
        edits.append(("(arr || []).forEach(r => { if (r && r.id) batch.set(doc(db, col, String(r.id)), r); });",
                      "(arr || []).forEach(r => { if (r && r.id) batch.set(doc(db, col, String(r.id)), sfStamp(r)); });   /* SF-WRITESTAMP-20261015 */"))
        edits.append(("try { await setDoc(doc(db, col, String(rec.id)), rec); return { ok: true }; }",
                      "try { await setDoc(doc(db, col, String(rec.id)), sfStamp(rec)); return { ok: true }; }   /* SF-WRITESTAMP-20261015 */"))
        edits.append(("try { await setDoc(doc(db, COL, String(rec.id)), rec); return { ok: true }; }",
                      "try { await setDoc(doc(db, COL, String(rec.id)), sfStamp(rec)); return { ok: true }; }   /* SF-WRITESTAMP-20261015 */"))
        edits.append(("try { await updateDoc(doc(db, COL, String(id)), patch); return { ok: true }; }",
                      "try { await updateDoc(doc(db, COL, String(id)), sfStamp(patch)); return { ok: true }; }   /* SF-WRITESTAMP-20261015 */"))
        edits.append(("""      await setDoc(doc(db, ROSTER_COL, ROSTER_DOC), {
        items: items || [],
        count: (items || []).length,
        updatedAt: new Date().toISOString(),
      });""",
                      """      await setDoc(doc(db, ROSTER_COL, ROSTER_DOC), sfStamp({
        items: items || [],
        count: (items || []).length,
        updatedAt: new Date().toISOString(),
      }));   /* SF-WRITESTAMP-20261015 */"""))
        # ② 墓石：module 側の書き口・購読、classic 側の適用・掃除、tlDel のフック、snapshot 後の sweep
        edits.append((TOMB_MODULE, TOMB_MODULE_NEW))
        edits.append((TOMB_SUB_ANCHOR, TOMB_SUB_NEW))
        edits.append((TOMB_CLASSIC_ANCHOR, TOMB_CLASSIC))
        edits.append(("  sfUnsentWatch(kind, String(id), true, p);   /* SF-UNSENTBOX-20261014 (案A) : 10秒見届け。未決着なら未送信箱へ */",
                      "  sfUnsentWatch(kind, String(id), true, p);   /* SF-UNSENTBOX-20261014 (案A) : 10秒見届け。未決着なら未送信箱へ */\n"
                      "  /* SF-TOMBSTONE-20261015 : 削除の墓石。旧版端末の書き戻しで復活しても購読側が自動で消せる */\n"
                      "  try { if (typeof window.fbPutTombstone === 'function') window.fbPutTombstone(kind, String(id)); } catch (e) { console.error(e); }"))
        edits.append(("""    setTimeout(function () { try { sfUnsentResend('boot'); } catch (e) { console.error(e); } }, 1200);
  }""",
                      """    setTimeout(function () { try { sfUnsentResend('boot'); } catch (e) { console.error(e); } }, 1200);
  }
  tlSweepTombstoned(kind);   /* SF-TOMBSTONE-20261015 : 墓石付き id が snapshot に現れたら自動で消す */"""))

    # 一意性検証 → 置換
    for old, new in edits:
        n = s.count(old)
        if n != 1:
            raise SystemExit('ANCHOR NG (%s): count=%d for: %s' % (path, n, old[:80]))
    for old, new in edits:
        s = s.replace(old, new)
    io.open(path, 'w', encoding='utf-8').write(s)
    return len(edits)

total = 0
for f, (app, garden) in FILES.items():
    n = patch(f, app, garden)
    total += n
    print('%-26s %2d edits OK' % (f, n))
print('TOTAL edits:', total)
