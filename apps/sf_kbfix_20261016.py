# -*- coding: utf-8 -*-
# SF-KBFIX-20261016 : standalone（ホーム画面アプリ）で入力欄タップ時にソフトキーボードが
# 出ない問題（白石 JANIS・salon_sp_shiraishi の「予約のお名前」。フォーカスは当たり
# 「ペースト」だけ出る。Safari では出る）への対処（12本へ横展開）＋退避フラグ。
#  ② -a 入力欄とその実効 user-select を強制 text（祖先の -webkit-user-select:none を打ち消す。
#        Safari では無害。salon 系の [onclick] 一括ルールの将来の巻き込みも恒久封じ）
#     -b standalone のときだけ、touchend（ユーザー操作の同期内）で入力欄を明示 focus して
#        キーボードを呼ぶ（fixed オーバーレイ内 input の既知の WebKit 挙動対策）
#  ④ 退避フラグ：sf_config/standalone の enabled=false で、apple-mobile-web-app-capable を
#     no に反転し manifest の link を外す（以後の「ホーム画面に追加」は通常タブで開く）。
#     standalone 実行中の端末には赤バッジ「アプリ版停止中・Safariで開き直してください」。
import io

FILES = ['timely.html',
         'board.html', 'board_sp_factory.html', 'board_sp_shiraishi.html', 'board_sp_shiseikan.html', 'board_sp_tsukisamu.html',
         'salon.html', 'salon_sp_shiraishi.html', 'salon_sp_tsukisamu.html',
         'notify.html', 'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html']

OLD_HEAD = "</head>\n<body>"
NEW_HEAD = """<style>
/* SF-KBFIX-20261016 : standalone（ホーム画面アプリ）で入力欄タップ時にキーボードが出ない対策。
   祖先に -webkit-user-select:none があっても入力欄では必ず選択可能にする（Safari では無害） */
input, textarea, select { -webkit-user-select: text !important; user-select: text !important; }
</style>
</head>
<body>"""

OLD_SA = "  window.__sfStandalone = SF_STANDALONE;"
NEW_SA = """  window.__sfStandalone = SF_STANDALONE;
  /* SF-KBFIX-20261016 : standalone では fixed オーバーレイ内の入力欄をタップしても
     ソフトキーボードが出ないことがある（フォーカスは当たり「ペースト」だけ出る既知挙動）。
     touchend＝ユーザー操作の同期内で明示的に focus してキーボードを呼ぶ。
     Safari（非 standalone）には適用しない。 */
  if (SF_STANDALONE) {
    document.addEventListener('touchend', (e) => {
      try {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.disabled && !t.readOnly
            && document.activeElement !== t) t.focus();
      } catch (e2) {}
    }, { passive: true });
  }"""

OLD_EXPOSE = "  window.sfDeviceBeat = sfDeviceBeat; window.sfVersionCheck = sfVersionCheck;"
NEW_EXPOSE = """  /* SF-KBFIX-20261016 (退避フラグ) : sf_config/standalone の enabled=false で standalone を
     即時無効化する。capable メタを no に反転し manifest の link を外す＝以後の
     「ホーム画面に追加」は通常タブで開く。standalone 実行中の端末には赤バッジで
     Safari へ戻るよう知らせる（既にアプリ版で開いている分は再追加が必要）。 */
  const sfStandaloneCheck = () => {
    getDoc(doc(db, 'sf_config', 'standalone')).then((snap) => {
      if (!snap || !snap.exists()) return;
      const d = snap.data() || {};
      if (d.enabled !== false) return;
      try {
        const m = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
        if (m) m.setAttribute('content', 'no');
        const l = document.querySelector('link[rel="manifest"]');
        if (l) l.remove();
        console.warn('[SF-KBFIX-20261016] standalone は sf_config/standalone で無効化されています'
          + '（以後の「ホーム画面に追加」は通常タブで開きます）');
        if (SF_STANDALONE) {
          const mk = () => {
            try {
              let b = document.getElementById('sfPwaBadge');
              if (!b) {
                b = document.createElement('span'); b.id = 'sfPwaBadge';
                b.style.cssText = 'display:inline-block;font-size:11px;line-height:1;padding:4px 9px;border-radius:999px;'
                  + 'white-space:nowrap;vertical-align:middle;margin-left:6px;position:fixed;top:6px;left:8px;z-index:9999;';
                document.body.appendChild(b);
              }
              b.textContent = 'アプリ版停止中・Safariで開き直してください';
              b.style.borderColor = '#C0553F'; b.style.border = '1px solid #C0553F';
              b.style.color = '#8B3A28'; b.style.background = '#FDF2E9';
            } catch (e) {}
          };
          if (document.body) mk(); else document.addEventListener('DOMContentLoaded', mk);
        }
      } catch (e) {}
    }).catch(() => {});
  };
  window.sfStandaloneCheck = sfStandaloneCheck;
  window.sfDeviceBeat = sfDeviceBeat; window.sfVersionCheck = sfVersionCheck;"""

OLD_BOOT = "    sfDeviceBeat('boot'); sfVersionCheck('boot');   /* SF-DEVICES-20261015 : 起動時の台帳更新と版確認 */"
NEW_BOOT = "    sfDeviceBeat('boot'); sfVersionCheck('boot'); sfStandaloneCheck();   /* SF-DEVICES-20261015 / SF-KBFIX-20261016 : 起動時の台帳・版・standalone フラグ確認 */"

for f in FILES:
    s = io.open(f, encoding='utf-8').read()
    edits = [(OLD_HEAD, NEW_HEAD), (OLD_SA, NEW_SA), (OLD_EXPOSE, NEW_EXPOSE), (OLD_BOOT, NEW_BOOT)]
    for o, n in edits:
        c = s.count(o)
        if c != 1:
            raise SystemExit('ANCHOR NG (%s): count=%d for: %s' % (f, c, o[:60]))
    for o, n in edits:
        s = s.replace(o, n)
    io.open(f, 'w', encoding='utf-8').write(s)
    print('%-26s 4 edits OK' % f)
print('DONE')
