'use strict';
/**
 * SF-NFSERVER-S1-20261027 : お迎え通知の状態を「予約＋イベント集合」から決める純粋関数。
 *
 * ここには Firestore も時計も無い。入力は (booking, events, opts) だけ、出力は state のプレーンオブジェクト。
 * 同じ入力なら必ず同じ出力（冪等）。イベントの順序は入力の並びに依存せず (at, id) で並べ直す。
 * 重複（同じ id）は1件に畳む。終端（done）以降のイベントは効かない。
 *
 * 状態：reserved → waiting（arrived）→ picking（pickup）→ done（done）
 *       reserved / no-show → late-hold（call）         ※ no-show は index.js のスキャンが opts.markNoShowAt で印を付ける
 *       reserved / no-show / late-hold → cancelled（cancel）→ done（cancel_ack）
 *       msg kind late/early は expectedEnd / lateMin だけ更新（status は不変）
 * 後退（waiting 以降 → reserved）は存在しない。端末は status を書けないので「古い端末の判定」も入り込めない。
 */

const JST_OFFSET = '+09:00';
const STATUS = ['reserved', 'waiting', 'picking', 'done', 'no-show', 'late-hold', 'cancelled'];
const TYPES = ['arrived', 'pickup', 'done', 'call', 'cancel', 'cancel_ack', 'msg'];
const SALONS = ['woodstock', 'janis'];

/** 'YYYY-MM-DD' + 'HH:MM'（JST）→ epoch ms。壊れていれば null */
function jstMs(date, hhmm) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const t = Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${JST_OFFSET}`);
  return Number.isFinite(t) ? t : null;
}
/** epoch ms → JST の 'YYYY-MM-DD' */
function jstDate(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** epoch ms → JST の時（0〜23） */
function jstHour(ms) { return new Date(ms + 9 * 3600 * 1000).getUTCHours(); }
/** 'HH:MM' に分を足す（0〜23:59 に丸めない。表示用） */
function addMin(hhmm, min) {
  if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  let t = h * 60 + m + (Number(min) || 0);
  if (t < 0) t = 0;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
/** 旧データの gardenId 無し＝月寒（notify.html の normGarden と同じ） */
function normGarden(g) { return (typeof g === 'string' && g) ? g : 'tsukisamu'; }

/** イベントの時刻（ms）。at は Firestore Timestamp / Date / ms のどれでも受ける */
function evMs(ev) {
  const a = ev && ev.at;
  if (a == null) return 0;
  if (typeof a === 'number') return a;
  if (a instanceof Date) return a.getTime();
  if (typeof a.toMillis === 'function') return a.toMillis();
  if (typeof a.seconds === 'number') return a.seconds * 1000 + Math.floor((a.nanoseconds || 0) / 1e6);
  const p = Date.parse(a); return Number.isFinite(p) ? p : 0;
}

/** 並べ直し＋重複除去。(at, id) の辞書順で決定的 */
function normalizeEvents(events) {
  const byId = new Map();
  (events || []).forEach((e) => { if (e && e.id && !byId.has(e.id)) byId.set(e.id, e); });
  return Array.from(byId.values()).sort((a, b) => (evMs(a) - evMs(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * @param {object} booking  sf_bookings のドキュメント（id を含む）
 * @param {object[]} events 当該 bookingId のイベント（順不同でよい）
 * @param {object} opts     { cur?: 既存 state, now: ms, graceMin?: 5, markNoShowAt?: ms }
 * @returns {object|null}   state。対象外の予約（サロン以外）は null
 */
function reduce(booking, events, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const graceMin = Number.isFinite(o.graceMin) ? o.graceMin : 5;
  const cur = o.cur || null;
  if (!booking || !booking.id) return null;
  if (!SALONS.includes(booking.salon)) return null;          // 早朝・延長・一時など内部生の予約は対象外

  const evs = normalizeEvents(events).filter((e) => TYPES.includes(e.type));
  const st = {
    bookingId: String(booking.id),
    garden: normGarden(booking.gardenId),
    salon: booking.salon,
    date: booking.date || null,
    start: booking.start || null,
    end: booking.end || null,
    status: 'reserved',
    expectedStart: booking.start || null,
    expectedEnd: booking.end || null,
    lateMin: 0,
    callConfirmed: false,
    cancelled: false,
    noShowAt: null,
    lastEventId: null,
    lastEventAt: null,
    eventCount: evs.length,
  };

  for (const e of evs) {
    if (st.status === 'done') break;                           // 終端
    const d = e.data || {};
    switch (e.type) {
      case 'arrived':
        if (st.status !== 'cancelled') st.status = 'waiting';
        break;
      case 'pickup':
        if (st.status !== 'cancelled') st.status = 'picking';
        break;
      case 'done':
        st.status = 'done';
        break;
      case 'call':
        if (st.status === 'reserved' || st.status === 'no-show' || st.status === 'late-hold') st.status = 'late-hold';
        st.callConfirmed = true;
        st.lateMin = Number(d.lateMin) || 0;
        st.expectedStart = addMin(booking.start, st.lateMin);
        st.expectedEnd = addMin(booking.end, st.lateMin);
        break;
      case 'cancel':
        if (st.status === 'reserved' || st.status === 'no-show' || st.status === 'late-hold') { st.status = 'cancelled'; st.cancelled = true; }
        break;
      case 'cancel_ack':
        if (st.status === 'cancelled') st.status = 'done';
        break;
      case 'msg':
        if (e.kind === 'late' || e.kind === 'early') {
          if (typeof d.expectedEnd === 'string') st.expectedEnd = d.expectedEnd;
          if (Number.isFinite(Number(d.lateMin))) st.lateMin = Number(d.lateMin);
        }
        break;
      default: break;
    }
    st.lastEventId = e.id; st.lastEventAt = evMs(e);
  }

  // 予約側のキャンセル印（SF-CANCELMARK）。終端でなければ cancelled
  if (booking.cancelled && st.status !== 'done') { st.status = 'cancelled'; st.cancelled = true; }

  // 未到着の期限 = 予約開始 + 猶予（電話確認の遅れぶんを足す）
  const base = jstMs(booking.date, booking.start);
  st.dueAt = base == null ? null : base + (graceMin + (st.callConfirmed ? st.lateMin : 0)) * 60000;

  // no-show の印：スキャンが付ける（markNoShowAt）か、既存 state から引き継ぐ。
  // 引き継ぐのは「まだ reserved のまま」かつ「期限（dueAt）が変わっていない」とき。
  // 予約時刻が動いて dueAt が変わったら reserved に戻す（2026-10-27 決定）。新しい期限で再判定される。
  if (st.status === 'reserved') {
    if (typeof o.markNoShowAt === 'number') { st.status = 'no-show'; st.noShowAt = o.markNoShowAt; }
    else if (cur && cur.status === 'no-show' && cur.noShowAt && cur.dueAt != null && cur.dueAt === st.dueAt) { st.status = 'no-show'; st.noShowAt = cur.noShowAt; }
  }
  st.computedAt = now;
  return st;
}

/** 2つの state が「書き直す価値のある違い」を持つか（computedAt 等の揺れは無視） */
function stateChanged(a, b) {
  if (!a || !b) return true;
  const keys = ['status', 'start', 'end', 'expectedStart', 'expectedEnd', 'lateMin', 'callConfirmed', 'cancelled', 'noShowAt', 'dueAt', 'lastEventId', 'eventCount', 'salon', 'garden', 'date'];
  return keys.some((k) => (a[k] == null ? null : a[k]) !== (b[k] == null ? null : b[k]));
}

/** スキャン対象か：reserved のまま dueAt を過ぎ、まだ印が無い */
function isNoShowCandidate(state, nowMs) {
  return !!state && state.status === 'reserved' && typeof state.dueAt === 'number' && state.dueAt <= nowMs && !state.noShowAt;
}

/** 開所時間内か（[from, to) 時・JST） */
function inScanHours(nowMs, hours) {
  const h = jstHour(nowMs);
  const from = Array.isArray(hours) && Number.isFinite(hours[0]) ? hours[0] : 7;
  const to = Array.isArray(hours) && Number.isFinite(hours[1]) ? hours[1] : 20;
  return h >= from && h < to;
}

module.exports = { reduce, normalizeEvents, stateChanged, isNoShowCandidate, inScanHours, jstMs, jstDate, jstHour, addMin, evMs, normGarden, STATUS, TYPES, SALONS };
