# -*- coding: utf-8 -*-
# SF-SINGLETAB-20261016 : persistentMultipleTabManager → persistentSingleTabManager（12本）。
# 白石（10/16 朝・ボードと受付）と月寒（10/15 17:10・ボード）で「同期待ち」が出たまま＝
# 同一 iPad の別タブ（通知）が multiTab の代表のまま背面で凍結し、前面タブがサーバーと
# 通信できなかった（通知だけ操作できた＝通知が代表）。single なら各タブが自分でつながる。
# 永続キャッシュは先着1タブ（Web Locks で判定）。2つ目以降は memoryLocalCache へフォール
# バックし、console.warn＋ヘッダー小バッジ「このタブはオフライン保存なし」（業務は継続）。
# すべて置換前にアンカーの一意性を検証し、1つでも合わなければ何も書かない。
import io

FILES = ['timely.html',
         'board.html', 'board_sp_factory.html', 'board_sp_shiraishi.html', 'board_sp_shiseikan.html', 'board_sp_tsukisamu.html',
         'salon.html', 'salon_sp_shiraishi.html', 'salon_sp_tsukisamu.html',
         'notify.html', 'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html']

OLD_IMPORT = "    getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,"
NEW_IMPORT = "    getFirestore, initializeFirestore, persistentLocalCache, persistentSingleTabManager, memoryLocalCache,   /* SF-SINGLETAB-20261016 */"

OLD_BLOCK = """  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (e) {
    console.warn('[firestore] 永続キャッシュを使えないため既定キャッシュにフォールバック', e);
    db = getFirestore(app);
  }"""

NEW_BLOCK = """  /* ============================================================
     SF-SINGLETAB-20261016 : persistentMultipleTabManager → persistentSingleTabManager。
     白石（10/16 朝・ボードと受付）と月寒（10/15 17:10・ボード）で「同期待ち」が出たまま
     復帰しない事象。同一 iPad の別タブ（通知）が multiTab の「代表タブ」のまま背面で凍結し、
     前面のタブがサーバーと通信できなくなっていた（通知だけ操作できた＝通知が代表だった）。
     single にすると各タブが自分でサーバーとつながる。永続キャッシュを持てるのは1タブだけ
     なので、先着を Web Locks（sf_fs_persist_v1。タブが閉じると自動で解放）で判定し、
     2つ目以降のタブ（failed-precondition 相当）は memoryLocalCache にフォールバックして
     console.warn とヘッダーの小バッジ「このタブはオフライン保存なし」で知らせる（業務は継続。
     未送信の救済は SF-UNSENTBOX-20261014 の未送信箱が localStorage で担うため memory モード
     でも失われない）。Web Locks が無い環境（旧 Safari 等）は従来どおり永続を試す。
     SF-WAKESYNC-20260930 の「同期待ち」判定・張り直しは据え置き。
     ============================================================ */
  let db;
  let sfCacheMode = 'persistent';
  const sfMemBadge = () => {
    try {
      const mk = () => {
        if (document.getElementById('sfMemBadge')) return;
        const b = document.createElement('span');
        b.id = 'sfMemBadge';
        b.textContent = 'このタブはオフライン保存なし';
        b.style.cssText = 'display:inline-block;font-size:11px;letter-spacing:.04em;line-height:1;padding:4px 9px;'
          + 'border-radius:999px;border:1px solid #C0553F;color:#8B3A28;background:#FDF2E9;white-space:nowrap;'
          + 'vertical-align:middle;margin-left:6px;';
        const w = document.getElementById('sfWakeBadge');
        if (w && w.parentNode) { w.parentNode.insertBefore(b, w.nextSibling); }
        else { b.style.position = 'fixed'; b.style.top = '6px'; b.style.right = '8px'; b.style.zIndex = '9999'; document.body.appendChild(b); }
      };
      if (document.body) mk(); else document.addEventListener('DOMContentLoaded', mk);
    } catch (e) {}
  };
  const __sfDbReady = (async () => {
    let owner = true;
    try {
      if (window.__sfPersistUnavailable) {
        owner = false;   // テスト用：2つ目のタブ（failed-precondition）の模擬
      } else if (navigator.locks && navigator.locks.request) {
        owner = await new Promise((resolve) => {
          navigator.locks.request('sf_fs_persist_v1', { ifAvailable: true }, (lock) => {
            if (!lock) { resolve(false); return Promise.resolve(); }
            resolve(true);
            return new Promise(() => {});   // タブが閉じるまで保持（＝先着1タブが永続キャッシュの持ち主）
          }).catch(() => resolve(true));
        });
      }
    } catch (e) { owner = true; }
    try {
      if (!owner) { const err = new Error('another tab owns persistence'); err.code = 'failed-precondition'; throw err; }
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() })
      });
    } catch (e) {
      sfCacheMode = 'memory';
      console.warn('[SF-SINGLETAB-20261016] このタブは永続キャッシュを使えないため memoryLocalCache で継続します'
        + '（オフライン保存なし・業務は継続）', (e && e.code) || '', e);
      try {
        db = initializeFirestore(app, { localCache: memoryLocalCache() });
      } catch (e2) { db = getFirestore(app); }
      sfMemBadge();
    }
    window.__sfCacheMode = sfCacheMode;
  })();"""

OLD_SIGNIN = """  signInAnonymously(auth).then(() => {
    sfDeviceBeat('boot'); sfVersionCheck('boot');   /* SF-DEVICES-20261015 : 起動時の台帳更新と版確認 */"""
NEW_SIGNIN = """  __sfDbReady.then(() => signInAnonymously(auth)).then(() => {   /* SF-SINGLETAB-20261016 : キャッシュ初期化（先着判定）を待ってから購読を開始 */
    sfDeviceBeat('boot'); sfVersionCheck('boot');   /* SF-DEVICES-20261015 : 起動時の台帳更新と版確認 */"""

OLD_WAKEGUARD = "    if (sfWakeBusy) return Promise.resolve(false);"
NEW_WAKEGUARD = "    if (!db || sfWakeBusy) return Promise.resolve(false);   /* SF-SINGLETAB-20261016 : キャッシュ初期化前は何もしない */"

OLD_WAKENOTE = "persistentSingleTabManager への切替は現場の切り分け結果を待つ（未着手）。 */"
NEW_WAKENOTE = ("persistentSingleTabManager へは SF-SINGLETAB-20261016 で切替済み（各タブが自分でつながるため\n"
                "     代表タブ凍結の巻き添えは起きなくなった。復帰時の張り直しと「同期待ち」判定は据え置き）。 */")

OLD_MULTI = "multiTabManager を使う。"
NEW_MULTI = "multiTabManager を使っていた（SF-SINGLETAB-20261016 で singleTabManager に切替。経緯は db 初期化の注記）。"

for f in FILES:
    s = io.open(f, encoding='utf-8').read()
    edits = [(OLD_IMPORT, NEW_IMPORT), (OLD_BLOCK, NEW_BLOCK), (OLD_SIGNIN, NEW_SIGNIN),
             (OLD_WAKEGUARD, NEW_WAKEGUARD), (OLD_WAKENOTE, NEW_WAKENOTE), (OLD_MULTI, NEW_MULTI)]
    for old, new in edits:
        n = s.count(old)
        if n != 1:
            raise SystemExit('ANCHOR NG (%s): count=%d for: %s' % (f, n, old[:70]))
    for old, new in edits:
        s = s.replace(old, new)
    io.open(f, 'w', encoding='utf-8').write(s)
    print('%-26s 6 edits OK' % f)
print('DONE')
