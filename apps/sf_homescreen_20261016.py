# -*- coding: utf-8 -*-
# SF-HOMESCREEN-20261016 : iPad の「ホーム画面に追加」で各アプリを独立アプリ（standalone）として
# 開けるようにする（12本）。
#  - head に apple-mobile-web-app-capable / status-bar-style / title（アプリ名＋園名）/
#    apple-touch-icon（apps/icons/ の4色アイコン）/ manifest（display:standalone・start_url=自分自身）
#    ※ timely は capable / status-bar-style が既設（SF 以前から）なので title 以降だけ足す
#  - standalone 起動を検知して台帳（sf_devices）に standalone を記録、ヘッダーに小さく「アプリ版」
#  - アプリ間リンクの同一ウィンドウ化：12本に他アプリへの <a href> / window.open / target="_blank" /
#    location.href 遷移は存在しないことを確認済み（このスクリプトでも再検査する）
import io, json, os, re, sys

FILES = {
    # base: (family, homescreen title)
    'timely.html':             ('timely', '受付'),
    'board.html':              ('board',  'ボード'),
    'board_sp_tsukisamu.html': ('board',  'ボード月寒'),
    'board_sp_shiraishi.html': ('board',  'ボード白石'),
    'board_sp_shiseikan.html': ('board',  'ボード資生館'),
    'board_sp_factory.html':   ('board',  'ボードファクトリー'),
    'salon.html':              ('salon',  'サロン'),
    'salon_sp_shiraishi.html': ('salon',  'サロン白石'),
    'salon_sp_tsukisamu.html': ('salon',  'サロン月寒'),
    'notify.html':             ('notify', '通知'),
    'notify_sp_shiraishi.html':('notify', '通知白石'),
    'notify_sp_tsukisamu.html':('notify', '通知月寒'),
}
FAM_COLOR = {'timely': '#0ABAB5', 'board': '#4A6FA5', 'salon': '#C0553F', 'notify': '#6BAE5C'}

HEAD_FULL = """<meta charset="UTF-8">
<!-- SF-HOMESCREEN-20261016 : iPad「ホーム画面に追加」で独立アプリ（standalone）として開く -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="__TITLE__">
<link rel="apple-touch-icon" href="icons/__FAM__.png">
<link rel="manifest" href="__BASE__.manifest.json">"""

HEAD_TIMELY = """<meta name="apple-mobile-web-app-status-bar-style" content="default">
<!-- SF-HOMESCREEN-20261016 : capable / status-bar-style は既設。タイトル・アイコン・manifest を追加 -->
<meta name="apple-mobile-web-app-title" content="__TITLE__">
<link rel="apple-touch-icon" href="icons/__FAM__.png">
<link rel="manifest" href="__BASE__.manifest.json">"""

STANDALONE_BLOCK = """  window.SF_APP_VER = SF_APP_VER; window.SF_DEV_ID = SF_DEV_ID;
  /* SF-HOMESCREEN-20261016 : 「ホーム画面に追加」からの起動（standalone）を検知。
     台帳（sf_devices）に standalone を記録し、ヘッダーに小さく「アプリ版」を出して
     現場が Safari 版と見分けられるようにする。 */
  const SF_STANDALONE = (() => {
    try {
      if (window.navigator.standalone === true) return true;   // iOS Safari
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) {}
    return false;
  })();
  window.__sfStandalone = SF_STANDALONE;
  if (SF_STANDALONE) {
    const mkPwa = () => {
      try {
        if (document.getElementById('sfPwaBadge')) return;
        const b = document.createElement('span');
        b.id = 'sfPwaBadge';
        b.textContent = 'アプリ版';
        b.style.cssText = 'display:inline-block;font-size:11px;letter-spacing:.04em;line-height:1;padding:4px 9px;'
          + 'border-radius:999px;border:1px solid #0ABAB5;color:#067F7B;background:#E9FAF9;white-space:nowrap;'
          + 'vertical-align:middle;margin-left:6px;';
        const w = document.getElementById('sfWakeBadge');
        if (w && w.parentNode) { w.parentNode.insertBefore(b, w.nextSibling); }
        else { b.style.position = 'fixed'; b.style.top = '6px'; b.style.left = '8px'; b.style.zIndex = '9999'; document.body.appendChild(b); }
      } catch (e) {}
    };
    if (document.body) mkPwa(); else document.addEventListener('DOMContentLoaded', mkPwa);
  }"""

OLD_BEAT = "        garden: sfGardenHint(), app: SF_APP_NAME, ver: SF_APP_VER, ua: ua.slice(0, 200),"
NEW_BEAT = "        garden: sfGardenHint(), app: SF_APP_NAME, ver: SF_APP_VER, standalone: SF_STANDALONE, ua: ua.slice(0, 200),   /* SF-HOMESCREEN-20261016 */"

# 事前検査：他アプリへのリンク・window.open・target=_blank・location での .html 遷移が無いこと
LINK_PAT = re.compile(r'window\.open\(|target="_blank"|location\.href\s*=\s*[\'"][a-z_]+\.html|location\.(assign|replace)\(')

for base, (fam, title) in FILES.items():
    s = io.open(base, encoding='utf-8').read()
    hits = LINK_PAT.findall(s)
    if hits:
        raise SystemExit('LINK FOUND (%s): %s — standalone では Safari に抜けるため要対処' % (base, hits[:3]))

for base, (fam, title) in FILES.items():
    s = io.open(base, encoding='utf-8').read()
    name = base[:-5]  # ".html" を外す
    if base == 'timely.html':
        old = '<meta name="apple-mobile-web-app-status-bar-style" content="default">'
        assert s.count(old) == 1, base
        assert s.count('apple-mobile-web-app-capable') == 1, base
        new = HEAD_TIMELY.replace('__TITLE__', title).replace('__FAM__', fam).replace('__BASE__', name)
    else:
        old = '<meta charset="UTF-8">'
        assert s.count(old) == 1, base
        assert s.count('apple-mobile-web-app-capable') == 0, base
        new = HEAD_FULL.replace('__TITLE__', title).replace('__FAM__', fam).replace('__BASE__', name)
    edits = [(old, new),
             ("  window.SF_APP_VER = SF_APP_VER; window.SF_DEV_ID = SF_DEV_ID;", STANDALONE_BLOCK),
             (OLD_BEAT, NEW_BEAT)]
    for o, n in edits:
        c = s.count(o)
        if c != 1:
            raise SystemExit('ANCHOR NG (%s): count=%d for: %s' % (base, c, o[:70]))
    for o, n in edits:
        s = s.replace(o, n)
    io.open(base, 'w', encoding='utf-8').write(s)

    # manifest（display: standalone・start_url は自分自身）
    man = {
        'name': title + '（STRAWBERRY FIELD）',
        'short_name': title,
        'display': 'standalone',
        'start_url': './' + base,
        'scope': './',
        'background_color': '#FBF7F0',
        'theme_color': FAM_COLOR[fam],
        'icons': [{'src': 'icons/' + fam + '.png', 'sizes': '180x180', 'type': 'image/png'}],
    }
    io.open(name + '.manifest.json', 'w', encoding='utf-8').write(
        json.dumps(man, ensure_ascii=False, indent=2) + '\n')
    print('%-26s 3 edits + manifest OK (%s)' % (base, title))

for fam in FAM_COLOR:
    assert os.path.exists('icons/%s.png' % fam), 'icon missing: ' + fam
print('DONE（リンク再検査もすべて該当なし）')
