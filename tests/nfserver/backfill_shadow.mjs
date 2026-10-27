// 影運転の初期化（1回だけ）：当日のサロン予約について、既存の旧 c / n をイベントへ翻訳して作成し（前進だけ・決定的 id）、
// state を lib/nfstate の reduce で計算して sf_notify_state_shadow に書く。旧 sf_notify には書かない。
// Functions の onCreate / onBookingWritten が同じ reduce を走らせるので、重なっても結果は同じ（冪等）。
import { createRequire } from 'node:module';
import { runQuery, getDoc, setDoc, eq, and, DB, H, BASE, enc } from './admin_rest.mjs';
const require = createRequire(import.meta.url);
const nf = require('../../functions/lib/nfstate.js');
const lg = require('../../functions/lib/legacy.js');
const today = process.argv[2] || nf.jstDate(Date.now());
const now = Date.now();
const cfg = (await getDoc('sf_config/nfserver')) || {};
const STATE = cfg.mode === 'live' ? 'sf_notify_state' : 'sf_notify_state_shadow';

const bookings = (await runQuery('sf_bookings', eq('date', today))).filter((b) => nf.SALONS.includes(b.salon));
const ids = new Set(bookings.map((b) => b._id));
console.log(`date=${today} salon bookings=${bookings.length} state→${STATE}`);

// 1) 旧 c / n → events（当日の予約ぶんだけ）
const old = (await runQuery('sf_notify')).filter((d) => d.k === 'c' || d.k === 'n');
let made = 0, exist = 0;
for (const d of old) {
  const doc = Object.assign({ id: d._id }, d); delete doc._id; delete doc._createTime; delete doc._updateTime;
  for (const e of lg.legacyToEvents(doc, now)) {
    if (!ids.has(e.bookingId)) continue;
    const body = Object.assign({}, e, { at: new Date(e.at), expireAt: new Date(now + (cfg.eventsTtlDays || 90) * 86400000) }); delete body.id;
    const res = await fetch(`https://firestore.googleapis.com/v1/${DB}/documents:commit`, { method: 'POST', headers: H, body: JSON.stringify({ writes: [{
      update: { name: `${DB}/documents/sf_notify_events/${e.id}`, fields: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, enc(v)])) }, currentDocument: { exists: false } }] }) });
    if (res.status === 200) made++; else if (res.status === 409) exist++; else console.warn('create failed', e.id, res.status, (await res.text()).slice(0, 200));
  }
}
console.log(`legacy → events: created=${made} already=${exist}`);

// 2) state を計算して書く
let written = 0, unchanged = 0;
for (const b of bookings) {
  const booking = Object.assign({ id: b._id }, b);
  const evs = (await runQuery('sf_notify_events', eq('bookingId', b._id))).map((e) => Object.assign({ id: e._id }, e));
  const curDoc = await getDoc(`${STATE}/${b._id}`);
  const cur = curDoc ? Object.assign({}, curDoc) : null;
  const next = nf.reduce(booking, evs, { cur, now, graceMin: cfg.graceMin || 5 });
  if (!next) continue;
  if (cur && !nf.stateChanged(cur, next)) { unchanged++; continue; }
  await setDoc(`${STATE}/${b._id}`, Object.assign({}, next, { updatedAt: new Date(now), expireAt: new Date(now + (cfg.stateTtlDays || 30) * 86400000), _w: { dev: 'fn', ver: 'backfill-20261027', at: new Date(now).toISOString() } }));
  written++;
}
console.log(`state: written=${written} unchanged=${unchanged}`);
