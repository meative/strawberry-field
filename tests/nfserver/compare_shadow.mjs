// 読み取り専用：当日の 旧 sf_notify（c の status）と sf_notify_state_shadow の status を予約ごとに突き合わせる。氏名は出さない。
import { createRequire } from 'node:module';
import { runQuery, getDoc, eq } from './admin_rest.mjs';
const require = createRequire(import.meta.url);
const nf = require('../../functions/lib/nfstate.js');
const today = process.argv[2] || nf.jstDate(Date.now());
const jst = (ms) => (ms ? new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) : '');
const cfg = (await getDoc('sf_config/nfserver')) || {};
const STATE = cfg.mode === 'live' ? 'sf_notify_state' : 'sf_notify_state_shadow';
const bookings = (await runQuery('sf_bookings', eq('date', today))).filter((b) => nf.SALONS.includes(b.salon))
  .sort((a, b) => (nf.normGarden(a.gardenId) + a.start).localeCompare(nf.normGarden(b.gardenId) + b.start));
const oldAll = await runQuery('sf_notify');
const oldC = new Map(oldAll.filter((d) => d.k === 'c' && d.data && d.data.sfId).map((d) => [String(d.data.sfId), d]));
const states = new Map((await runQuery(STATE, eq('date', today))).map((s) => [s._id, s]));
const events = await runQuery('sf_notify_events', eq('date', today));
const evByBk = new Map(); events.forEach((e) => { const k = String(e.bookingId); evByBk.set(k, (evByBk.get(k) || 0) + 1); });
const alerts = oldAll.filter((d) => d.k === 's').reduce((n, d) => n + ((d.data || []).filter((e) => e && e.kind === 'alert' && nf.jstDate(e.ts || 0) === today).length), 0);

const norm = (c) => { if (!c) return '(なし)'; const s = c.data.status || 'reserved'; return (s === 'waiting' && c.data.sentComing) ? 'picking' : s; };
let match = 0, mismatch = 0, missing = 0;
const rows = bookings.map((b) => {
  const c = oldC.get(b._id); const s = states.get(b._id);
  const o = norm(c), n = s ? s.status : '(なし)';
  let judge;
  if (!s) { judge = 'state なし'; missing++; }
  else if (o === '(なし)' ? n === 'reserved' || n === 'no-show' || n === 'cancelled' : o === n) { judge = '一致'; match++; }
  else { judge = '不一致'; mismatch++; }
  return { 予約: b._id.slice(0, 12) + '…', 園: nf.normGarden(b.gardenId), サロン: b.salon, 時間: `${b.start}-${b.end}`, 予約cancel: b.cancelled ? 'Y' : '',
    旧c: o, 旧c書き手: c && c._w ? c._w.dev.slice(0, 8) : '', 旧stTs: c ? jst(c.data.stTs) : '', shadow: n, noShowAt: s ? jst(s.noShowAt) : '', events: evByBk.get(b._id) || 0, 判定: judge };
});
console.log(`date=${today}  salon予約=${bookings.length}  旧c=${oldC.size}  ${STATE}=${states.size}  events(当日)=${events.length}  旧sの未到着アラート(当日)=${alerts}`);
console.table(rows);
console.log(`一致=${match} 不一致=${mismatch} stateなし=${missing}`);
