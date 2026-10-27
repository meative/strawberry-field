'use strict';
/**
 * SF-NFSERVER-S1-20261027 : 旧形式（sf_notify の c / n / s）との橋渡し。純粋関数。
 *
 * 旧→新 legacyToEvents(doc, nowMs)：旧版端末が書いた c / n ドキュメントを、状態を前進させるイベントだけに翻訳する。
 *   - c（子の状態）：waiting → arrived、late-hold → call、cancelled → cancel、done → done（cancelled 印付きは cancel_ack）。
 *     reserved / no-show は翻訳しない（旧版端末の「未到着判定」や後退を新構造に持ち込まない）。
 *   - n（受信ボード）：coming → pickup、call → call、cancel → cancel、late / early / soon / soon-early / handoff → msg。
 *   - s（様子ログ）は childName しか持たず bookingId が引けないため S1 では翻訳しない（未決）。
 *   - _w.dev === 'fn'（Functions 自身が書いた旧形式）は翻訳しない（往復ループ防止）。
 *   イベント id は決定的（legacy_{docId}_{status|type}[_{ts}]）なので、同じ旧ドキュメントを何度見ても1回しか作られない。
 *
 * 新→旧 buildLegacyC(state) / buildLegacyN(state, events)：live モードでのみ使う（S1 の shadow では呼ばない）。
 */
const nf = require('./nfstate.js');

const OLD_STATUS_TO_EVENT = { waiting: 'arrived', 'late-hold': 'call', cancelled: 'cancel', done: 'done' };
const N_TYPE_TO_EVENT = { coming: 'pickup', call: 'call', cancel: 'cancel' };
const N_MSG_KINDS = ['late', 'early', 'soon', 'soon-early', 'handoff'];

function legacyToEvents(doc, nowMs) {
  const out = [];
  if (!doc || !doc.id || !doc.k || !doc.data) return out;
  const w = doc._w || {};
  if (w.dev === 'fn') return out;
  const by = 'legacy:' + (w.dev || 'unknown');
  const ver = w.ver || null;
  const garden = nf.normGarden(doc.g);
  const base = (id, bookingId, salon, type, atMs, extra) => Object.assign({
    id, bookingId: String(bookingId), garden, salon, date: nf.jstDate(atMs), type, at: atMs, clientAt: atMs, by, ver,
  }, extra || {});

  if (doc.k === 'c') {
    const d = doc.data;
    if (!d.sfId || !nf.SALONS.includes(d.salonKey)) return out;
    const type = OLD_STATUS_TO_EVENT[d.status];
    if (!type) return out;
    const atMs = Number(d.stTs) || Number(doc.ts) || nowMs;
    if (d.status === 'done' && d.cancelled) {
      out.push(base('legacy_' + doc.id + '_cancelled', d.sfId, d.salonKey, 'cancel', atMs - 1));
      out.push(base('legacy_' + doc.id + '_done', d.sfId, d.salonKey, 'cancel_ack', atMs));
      return out;
    }
    const extra = {};
    if (type === 'call') extra.data = { lateMin: Number(d.callLateMin) || 0 };
    out.push(base('legacy_' + doc.id + '_' + d.status, d.sfId, d.salonKey, type, atMs, extra));
    return out;
  }
  if (doc.k === 'n') {
    const n = doc.data;
    if (!n.sfId || !nf.SALONS.includes(n.salonKey)) return out;
    const atMs = Number(n.ts) || Number(doc.ts) || nowMs;
    const idBase = 'legacy_' + doc.id + '_' + n.type + '_' + atMs;
    if (N_TYPE_TO_EVENT[n.type]) {
      const type = N_TYPE_TO_EVENT[n.type];
      const extra = {};
      if (type === 'call') extra.data = { lateMin: Number(n.lateMin) || 0 };
      if (type === 'pickup' && n.nextReservation) extra.data = { nextReservation: String(n.nextReservation) };
      out.push(base(idBase, n.sfId, n.salonKey, type, atMs, extra));
    } else if (N_MSG_KINDS.includes(n.type)) {
      const data = {};
      if (n.lateMin != null) data.lateMin = Number(n.lateMin) || 0;
      if (n.expectedEnd) data.expectedEnd = String(n.expectedEnd);
      if (n.type === 'handoff' && n.handoffTo) data.handoffTo = String(n.handoffTo);
      out.push(base(idBase, n.sfId, n.salonKey, 'msg', atMs, { kind: n.type, data }));
    }
    return out;
  }
  return out;
}

/** 旧 c ドキュメント（live モードで Functions が書く）。notify.html の nfBuildDocs と同じ形 */
function buildLegacyC(state, nowMs) {
  const data = { salonKey: state.salon, sfId: state.bookingId, status: state.status, stTs: nowMs };
  if (state.lateMin) data.lateMin = state.lateMin;
  if (state.expectedEnd && state.expectedEnd !== state.end) data.expectedEnd = state.expectedEnd;
  if (state.callConfirmed) { data.callConfirmed = true; data.callLateMin = state.lateMin || 0; }
  if (state.cancelled) data.cancelled = true;
  if (state.status === 'picking') data.sentComing = true;
  return { id: state.garden + '__c__' + encodeURIComponent(state.bookingId), g: state.garden, k: 'c', key: state.bookingId, ts: nowMs, data };
}

module.exports = { legacyToEvents, buildLegacyC, OLD_STATUS_TO_EVENT, N_TYPE_TO_EVENT, N_MSG_KINDS };
