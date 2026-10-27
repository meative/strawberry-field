// SF-CXLACK-20261027 : notify 3本。美容室キャンセルのカードが「確認しました」で消える（キャンセル後に起動した端末でも）、
// リロード後も消えたまま、通知の ts は cancelledAt に固定され起動端末が n を書き直さない、NFGUARD2 の B が cancelled を守る。
const path = require('path');
const { chromium } = require('playwright');
const { installStubs } = require('./stubs');
const APPS = path.resolve(process.env.SF_APPS || path.join(__dirname, '..', '..', 'apps'));
const FILES = ['notify.html', 'notify_sp_shiraishi.html', 'notify_sp_tsukisamu.html'];
const T0 = '2026-10-27T15:00:00+09:00';
const CXL_AT = Date.parse('2026-10-27T07:09:00+09:00');
let fails = 0;
const check = (f, name, ok, extra) => { console.log((ok ? '  PASS ' : '  FAIL ') + f + ' : ' + name + (extra ? '  [' + extra + ']' : '')); if (!ok) fails++; };
const noErr = (errors) => errors.filter((e) => !/AudioContext|Failed to fetch|net::ERR|Load failed/i.test(e));

async function boot(browser, file, initLS) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await installStubs(page);
  if (initLS) await page.addInitScript((ls) => { Object.keys(ls).forEach((k) => localStorage.setItem(k, ls[k])); }, initLS);
  await page.clock.install({ time: new Date(T0) });
  await page.goto('file://' + path.join(APPS, file));
  await page.waitForFunction(() => window.__fs && window.__fs.listeners.some((l) => l.name === 'sf_bookings') && window.__fs.listeners.some((l) => l.name === 'sf_notify'), null, { timeout: 15000 });
  await page.evaluate((cxlAt) => {
    window.__t = {
      bk: (id, extra) => Object.assign({ id, salon: 'woodstock', gardenId: CURRENT_GARDEN, date: todayStr(), start: '09:30', end: '11:00', name: 'テスト ハナコ', age: '1歳', months: 18 }, extra || {}),
      cxl: (id) => window.__t.bk(id, { cancelled: true, cancelledAt: cxlAt, cancelledBy: 'salon' }),
      ndoc: (id, ts) => ({ id: nfDocId('n', 'woodstock|テスト ハナコ'), g: CURRENT_GARDEN, k: 'n', key: 'woodstock|テスト ハナコ', ts, data: { key: 'woodstock|テスト ハナコ', type: 'cancel', salon: 'X', salonKey: 'woodstock', childIdx: -1, sfId: id, childName: 'テスト ハナコ', time: '07:09', ts, start: '09:30', end: '11:00', badge: 'b', headline: 'h', detail: 'd' } }),
      cdoc: (id, status, stTs, extra) => ({ id: nfDocId('c', id), g: CURRENT_GARDEN, k: 'c', key: id, ts: stTs, data: Object.assign({ salonKey: 'woodstock', sfId: id, status, stTs }, extra || {}) }),
      child: (id) => (children.woodstock || []).find((c) => c.sfId === id) || null,
      cards: () => (notifications || []).filter((n) => n.type === 'cancel').length,
      feedCards: () => document.querySelectorAll('#feed .feed-item.cancel').length,
      writes: () => window.__fs.writes.filter((w) => w.path.indexOf('sf_notify/') === 0).map((w) => ({ op: w.op, k: w.data ? w.data.k : w.path.split('__')[1], ts: w.data ? w.data.ts : null, st: w.data && w.data.data ? w.data.data.status : null })),
      reset: () => { window.__fs.writes.length = 0; },
    };
  }, CXL_AT);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch();
  for (const file of FILES) {
    // (1) キャンセル後に起動した端末：カードが出る（ts = cancelledAt）→ 確認しました → カードが消え、c に done・n は削除
    {
      const { ctx, page, errors } = await boot(browser, file);
      let r = await page.evaluate(() => {
        window.__emit('sf_bookings', [window.__t.cxl('bk_c1')], false);   // sf_bookings が先
        const before = { cards: window.__t.cards(), child: !!window.__t.child('bk_c1') };
        window.__emit('sf_notify', [], false);                             // sf_notify（空）が後
        const c = window.__t.child('bk_c1');
        const n = (notifications || []).find((x) => x.type === 'cancel');
        return { before, cards: window.__t.cards(), feed: window.__t.feedCards(), st: c && c.status, cxl: c && c.cancelled, nts: n && n.ts, nw: window.__t.writes() };
      });
      check(file, '(1a) bookings first: no card until sf_notify arrives; then one card, child cancelled, n.ts == cancelledAt',
        r.before.cards === 0 && !r.before.child && r.cards === 1 && r.feed === 1 && r.st === 'cancelled' && r.cxl === true && r.nts === CXL_AT
        && r.nw.some((w) => w.op === 'set' && w.k === 'n' && w.ts === CXL_AT) && r.nw.some((w) => w.op === 'set' && w.k === 'c' && w.st === 'cancelled'), JSON.stringify(r));
      r = await page.evaluate(() => {
        window.__t.reset();
        document.querySelector('#feed .feed-item.cancel .feed-ack').click();   // 確認しました（カードは childIdx 付き）
        const c = window.__t.child('bk_c1');
        return { cards: window.__t.cards(), feed: window.__t.feedCards(), st: c && c.status, w: window.__t.writes() };
      });
      check(file, '(1b) ack: card gone, child done, writes = c done + n delete',
        r.cards === 0 && r.feed === 0 && r.st === 'done' && r.w.some((w) => w.op === 'set' && w.k === 'c' && w.st === 'done') && r.w.some((w) => w.op === 'delete' && w.k === 'n'), JSON.stringify(r));
      // 旧カード（childIdx:-1・子が無い端末）からの ack も効く
      r = await page.evaluate(() => {
        children.woodstock = [];
        notifications = [{ key: 'woodstock|テスト ハナコ', type: 'cancel', salonKey: 'woodstock', childIdx: -1, sfId: 'bk_c1', childName: 'テスト ハナコ', ts: 1, start: '09:30', end: '11:00', badge: 'b', headline: 'h', detail: 'd', salon: 'X' }];
        renderFeed(null);
        window.__t.reset();
        ackCancel('woodstock', -1, 'bk_c1');
        const c = window.__t.child('bk_c1');
        return { cards: window.__t.cards(), feed: window.__t.feedCards(), st: c && c.status, w: window.__t.writes() };
      });
      check(file, '(1c) ack with childIdx -1 and no child: child created as done, card gone, c done written',
        r.cards === 0 && r.feed === 0 && r.st === 'done' && r.w.some((w) => w.op === 'set' && w.k === 'c' && w.st === 'done'), JSON.stringify(r));
      check(file, '(1) no page errors', noErr(errors).length === 0, noErr(errors).slice(0, 2).join(' | '));
      await ctx.close();
    }
    // (2) リロード後（クラウド：c=done・n 無し）：カードは出ない・n を書かない・子は done
    {
      const { ctx, page, errors } = await boot(browser, file);
      const r = await page.evaluate(() => {
        window.__emit('sf_bookings', [window.__t.cxl('bk_c1')], false);
        window.__emit('sf_notify', [window.__t.cdoc('bk_c1', 'done', Date.now() - 60000, { cancelled: true })], false);
        const c = window.__t.child('bk_c1');
        return { cards: window.__t.cards(), feed: window.__t.feedCards(), child: !!c, st: c && c.status, nWrites: window.__t.writes().filter((w) => w.k === 'n').length };
      });
      check(file, '(2) reload after ack: no card, no n write, no child re-created as cancelled', r.cards === 0 && r.feed === 0 && !r.child && r.nWrites === 0, JSON.stringify(r));
      check(file, '(2) no page errors', noErr(errors).length === 0);
      await ctx.close();
    }
    // (3) 別端末が作った n（ts=cancelledAt）がある状態で起動：カード1枚・n を書き直さない（再着信しない）
    {
      const { ctx, page } = await boot(browser, file);
      const r = await page.evaluate((cxlAt) => {
        window.__emit('sf_bookings', [window.__t.cxl('bk_c1')], false);
        window.__emit('sf_notify', [window.__t.ndoc('bk_c1', cxlAt), window.__t.cdoc('bk_c1', 'cancelled', cxlAt, { cancelled: true, cancelTs: cxlAt, cancelTime: '07:09' })], false);
        const n = (notifications || []).filter((x) => x.type === 'cancel');
        return { cards: n.length, ts: n[0] && n[0].ts, nWrites: window.__t.writes().filter((w) => w.k === 'n').length, cWrites: window.__t.writes().filter((w) => w.k === 'c').length };
      }, CXL_AT);
      check(file, '(3) boot with cloud card: one card with original ts, no n / c rewrite', r.cards === 1 && r.ts === CXL_AT && r.nWrites === 0 && r.cWrites === 0, JSON.stringify(r));
      await ctx.close();
    }
    // (4) NFGUARD2 B：手元 cancelled に対する reserved / no-show（新しい stTs）は無視、done は受け入れる
    {
      const { ctx, page } = await boot(browser, file);
      const r = await page.evaluate(() => {
        window.__emit('sf_bookings', [window.__t.cxl('bk_c1')], false);
        window.__emit('sf_notify', [], false);
        const now = Date.now();
        window.__emit('sf_notify', [window.__t.cdoc('bk_c1', 'reserved', now + 60000)], false);
        const a = window.__t.child('bk_c1').status;
        window.__emit('sf_notify', [window.__t.cdoc('bk_c1', 'no-show', now + 120000)], false);
        const b = window.__t.child('bk_c1').status;
        window.__emit('sf_notify', [window.__t.cdoc('bk_c1', 'done', now + 180000, { cancelled: true })], false);
        const c = window.__t.child('bk_c1').status;
        return { a, b, c, cards: window.__t.cards() };
      });
      check(file, '(4) B: cancelled not reverted by reserved / no-show; done (ack from another device) applied and card gone', r.a === 'cancelled' && r.b === 'cancelled' && r.c === 'done' && r.cards === 0, JSON.stringify(r));
      await ctx.close();
    }
    // (5) 取り消し（美容室がキャンセルを撤回）：cancelled → reserved に戻りカードも下がる（SF-CANCELFLAG の回帰）
    {
      const { ctx, page } = await boot(browser, file);
      const r = await page.evaluate(() => {
        window.__emit('sf_bookings', [window.__t.cxl('bk_c1')], false);
        window.__emit('sf_notify', [], false);
        const before = { st: window.__t.child('bk_c1').status, cards: window.__t.cards() };
        window.__emit('sf_bookings', [window.__t.bk('bk_c1')], false);   // cancelled 印が消えた
        return { before, st: window.__t.child('bk_c1').status, cards: window.__t.cards() };
      });
      check(file, '(5) uncancel: back to reserved, card withdrawn', r.before.st === 'cancelled' && r.before.cards === 1 && r.st === 'reserved' && r.cards === 0, JSON.stringify(r));
      await ctx.close();
    }
  }
  await browser.close();
  console.log(fails ? '\n' + fails + ' FAIL' : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
