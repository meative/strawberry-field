/**
 * STRAWBERRY FIELD Cloud Functions — お迎え通知の状態をサーバーで決める（SF-NFSERVER-S1-20261027）
 *
 * 設計は DESIGN-nfserver.md。端末は sf_notify_events に追記するだけ（ルールで create のみ）。
 * 状態（sf_notify_state）を書くのはここだけ。判定は lib/nfstate.js の純粋関数 reduce に集めてある。
 *
 * モード（sf_config/nfserver.mode）
 *   off    : 何もしない
 *   shadow : 影運転。state は sf_notify_state_shadow に書き、旧 sf_notify には一切書かない。
 *            旧→新ブリッジ（旧版端末の c / n をイベントに翻訳）は動かす＝「読むだけ」。no-show の印は state だけ（アラートのイベントは作らない）
 *   live   : state は sf_notify_state。legacyBridge が true なら旧形式（c）も書く（S2 で n / s を追加）
 *
 * ★ firebase-admin v14：admin.firestore() は無い。サブパスから直接 require する（eye405-app と同じ）
 */
'use strict';
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const nf = require('./lib/nfstate.js');
const lg = require('./lib/legacy.js');

initializeApp();
const db = getFirestore();
const REGION = 'asia-northeast1';
const VER = 'S1-20261027';
const EVENTS = 'sf_notify_events';
const LEGACY = 'sf_notify';
const OPTS = { region: REGION, memory: '256MiB', maxInstances: 5 };

/* ---------- 設定（30秒だけメモ） ---------- */
const CFG_DEFAULT = { mode: 'off', graceMin: 5, scanHours: [7, 20], legacyBridge: true, eventsTtlDays: 90, stateTtlDays: 30 };
let cfgCache = { at: 0, v: null };
async function getConfig() {
  const now = Date.now();
  if (cfgCache.v && now - cfgCache.at < 30 * 1000) return cfgCache.v;
  let v = Object.assign({}, CFG_DEFAULT);
  try {
    const snap = await db.doc('sf_config/nfserver').get();
    if (snap.exists) v = Object.assign(v, snap.data());
  } catch (e) { console.warn('[SF-NFSERVER] config read failed', e); }
  cfgCache = { at: now, v };
  return v;
}
const stateColl = (cfg) => (cfg.mode === 'live' ? 'sf_notify_state' : 'sf_notify_state_shadow');
const stamp = (now) => ({ dev: 'fn', ver: VER, at: new Date(now).toISOString() });
const expireAt = (now, days) => Timestamp.fromMillis(now + (Number(days) || 30) * 86400000);
/** Firestore から読んだ state（Timestamp 混じり）を reduce が比較できる形に */
function plainState(d) {
  if (!d) return null;
  const o = Object.assign({}, d);
  ['dueAt', 'noShowAt', 'lastEventAt'].forEach((k) => { if (o[k] != null && typeof o[k] !== 'number') o[k] = nf.evMs({ at: o[k] }); });
  return o;
}

/* ---------- 中核：予約1件の state を「予約＋イベント集合」から作り直す（トランザクション・冪等） ---------- */
async function recompute(bookingId, cfg, extra) {
  const now = Date.now();
  const x = extra || {};
  return db.runTransaction(async (tx) => {
    const bkRef = db.doc(`sf_bookings/${bookingId}`);
    const stRef = db.doc(`${stateColl(cfg)}/${bookingId}`);
    const [bkSnap, stSnap] = await Promise.all([tx.get(bkRef), tx.get(stRef)]);
    if (!bkSnap.exists) {
      if (stSnap.exists) tx.delete(stRef);
      return { result: 'no-booking' };
    }
    const evSnap = await tx.get(db.collection(EVENTS).where('bookingId', '==', String(bookingId)));
    const evs = evSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const cur = stSnap.exists ? plainState(stSnap.data()) : null;
    const booking = Object.assign({ id: bkSnap.id }, bkSnap.data());
    if (x.requireCandidate && !nf.isNoShowCandidate(cur, now)) return { result: 'not-candidate' };
    if (x.requireCandidate && (booking.cancelled || evs.some((e) => ['arrived', 'pickup', 'done', 'call', 'cancel'].includes(e.type)))) return { result: 'moved-already' };
    const next = nf.reduce(booking, evs, { cur, now, graceMin: cfg.graceMin, markNoShowAt: x.markNoShowAt });
    if (!next) {
      if (stSnap.exists) tx.delete(stRef);
      return { result: 'not-salon' };
    }
    if (cur && !nf.stateChanged(cur, next)) return { result: 'unchanged', state: cur };
    tx.set(stRef, Object.assign({}, next, {
      updatedAt: FieldValue.serverTimestamp(), expireAt: expireAt(now, cfg.stateTtlDays), _w: stamp(now),
    }));
    if (x.noShowEvent && cfg.mode === 'live') {
      const evRef = db.collection(EVENTS).doc(`noshow_${bookingId}_${next.dueAt}`);
      tx.create(evRef, {
        bookingId: String(bookingId), garden: next.garden, date: next.date, salon: next.salon,
        type: 'msg', kind: 'alert', data: { dueAt: next.dueAt },
        at: FieldValue.serverTimestamp(), clientAt: now, by: 'fn', ver: VER, expireAt: expireAt(now, cfg.eventsTtlDays),
      });
    }
    if (cfg.mode === 'live' && cfg.legacyBridge === true) {
      const c = lg.buildLegacyC(next, now);
      tx.set(db.doc(`${LEGACY}/${c.id}`), Object.assign({}, c, { _w: stamp(now) }));
    }
    return { result: 'written', state: next };
  });
}

/* ---------- 1. events の onCreate → state 再計算 ---------- */
exports.onNotifyEventCreated = onDocumentCreated(Object.assign({ document: `${EVENTS}/{id}` }, OPTS), async (event) => {
  const cfg = await getConfig();
  if (cfg.mode === 'off') return;
  const ev = event.data && event.data.data();
  if (!ev || !ev.bookingId) return;
  if (ev.by === 'fn') return;                                  // 自分のアラートでは再計算しない（state は同時に書いてある）
  try {
    const r = await recompute(String(ev.bookingId), cfg);
    console.log(`[SF-NFSERVER] event ${event.params.id} type=${ev.type} by=${ev.by} → ${r.result}${r.state ? ' status=' + r.state.status : ''}`);
  } catch (e) { console.error('[SF-NFSERVER] recompute failed', event.params.id, e); throw e; }
});

/* ---------- 2. 1分おきの未到着判定（開所時間のみ・1回だけ・冪等） ---------- */
exports.notifyNoShowScan = onSchedule(Object.assign({ schedule: 'every 1 minutes', timeZone: 'Asia/Tokyo' }, OPTS), async () => {
  const cfg = await getConfig();
  if (cfg.mode === 'off') return;
  const now = Date.now();
  if (!nf.inScanHours(now, cfg.scanHours)) return;
  const today = nf.jstDate(now);
  const q = db.collection(stateColl(cfg)).where('date', '==', today).where('status', '==', 'reserved').where('dueAt', '<=', now);
  const snap = await q.get();                                  // 通常0件（＝読み取り1）
  for (const d of snap.docs) {
    try {
      const r = await recompute(d.id, cfg, { requireCandidate: true, markNoShowAt: now, noShowEvent: true });
      console.log(`[SF-NFSERVER] noshow-scan ${d.id} → ${r.result}`);
    } catch (e) {
      if (e && e.code === 6) console.log(`[SF-NFSERVER] noshow-scan ${d.id} → alert already exists`);   // ALREADY_EXISTS
      else console.error('[SF-NFSERVER] noshow-scan failed', d.id, e);
    }
  }
});

/* ---------- 3. 予約から reserved の state を作る・追従させる ---------- */
exports.onBookingWrittenForNotify = onDocumentWritten(Object.assign({ document: 'sf_bookings/{id}' }, OPTS), async (event) => {
  const cfg = await getConfig();
  if (cfg.mode === 'off') return;
  const id = String(event.params.id);
  const after = event.data && event.data.after;
  if (!after || !after.exists) {
    await db.doc(`${stateColl(cfg)}/${id}`).delete().catch(() => {});
    return;
  }
  const b = after.data();
  if (!nf.SALONS.includes(b.salon)) return;                    // 内部生（早朝・延長・一時）は対象外
  if (typeof b.date === 'string' && b.date < nf.jstDate(Date.now())) return;   // 過去の予約は触らない
  const r = await recompute(id, cfg);
  console.log(`[SF-NFSERVER] booking ${id} → ${r.result}${r.state ? ' status=' + r.state.status : ''}`);
});

/* ---------- 4. 旧→新ブリッジ：旧版端末が書いた c / n をイベントに翻訳（前進だけ・決定的 id で冪等） ---------- */
exports.onLegacyNotifyWritten = onDocumentWritten(Object.assign({ document: `${LEGACY}/{id}` }, OPTS), async (event) => {
  const cfg = await getConfig();
  if (cfg.mode === 'off' || cfg.legacyBridge === false) return;
  const after = event.data && event.data.after;
  if (!after || !after.exists) return;
  const now = Date.now();
  const evs = lg.legacyToEvents(Object.assign({ id: event.params.id }, after.data()), now);
  for (const e of evs) {
    const body = Object.assign({}, e, { at: Timestamp.fromMillis(e.at), expireAt: expireAt(now, cfg.eventsTtlDays) });
    delete body.id;
    try {
      await db.collection(EVENTS).doc(e.id).create(body);
      console.log(`[SF-NFSERVER] legacy ${event.params.id} → event ${e.id} (${e.type})`);
    } catch (err) {
      if (!(err && err.code === 6)) console.error('[SF-NFSERVER] legacy create failed', e.id, err);   // 6 = ALREADY_EXISTS は正常
    }
  }
});
