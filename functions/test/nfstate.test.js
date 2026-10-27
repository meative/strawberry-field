'use strict';
// SF-NFSERVER-S1-20261027 : reduce の冪等性（順序入替・重複・後退イベント）と判定の規則
const { test } = require('node:test');
const assert = require('node:assert');
const nf = require('../lib/nfstate.js');

const BK = { id: 'bk_1', salon: 'woodstock', gardenId: 'tsukisamu', date: '2026-10-27', start: '12:30', end: '15:00' };
const T = (hhmm) => nf.jstMs('2026-10-27', hhmm);
const ev = (id, type, at, extra) => Object.assign({ id, type, at: T(at) }, extra || {});
const strip = (s) => { const o = Object.assign({}, s); delete o.computedAt; return o; };
const shuffle = (a, seed) => { const x = a.slice(); let s = seed; for (let i = x.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

test('イベント無し → reserved・dueAt = 開始+5分', () => {
  const s = nf.reduce(BK, [], { now: T('12:00') });
  assert.strictEqual(s.status, 'reserved');
  assert.strictEqual(s.dueAt, T('12:35'));
  assert.strictEqual(s.eventCount, 0);
  assert.strictEqual(s.expectedEnd, '15:00');
});

test('内部生（ext_am / temp）は対象外 → null', () => {
  assert.strictEqual(nf.reduce(Object.assign({}, BK, { salon: 'ext_am' }), [], { now: 0 }), null);
  assert.strictEqual(nf.reduce(Object.assign({}, BK, { salon: 'temp' }), [], { now: 0 }), null);
});

test('arrived → pickup → done の前進', () => {
  const evs = [ev('e1', 'arrived', '12:29'), ev('e2', 'pickup', '14:40'), ev('e3', 'done', '14:55')];
  assert.strictEqual(nf.reduce(BK, evs.slice(0, 1), { now: 0 }).status, 'waiting');
  assert.strictEqual(nf.reduce(BK, evs.slice(0, 2), { now: 0 }).status, 'picking');
  const s = nf.reduce(BK, evs, { now: 0 });
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.lastEventId, 'e3');
  assert.strictEqual(s.eventCount, 3);
});

test('★順序を入れ替えても・重複しても state は同じ', () => {
  const evs = [ev('e1', 'arrived', '12:29'), ev('m1', 'msg', '13:00', { kind: 'late', data: { lateMin: 15, expectedEnd: '15:15' } }),
    ev('e2', 'pickup', '14:40'), ev('m2', 'msg', '14:41', { kind: 'report', data: { reportKey: 'play' } }), ev('e3', 'done', '14:55')];
  const base = strip(nf.reduce(BK, evs, { now: 0 }));
  for (let seed = 1; seed <= 20; seed++) {
    assert.deepStrictEqual(strip(nf.reduce(BK, shuffle(evs, seed), { now: 0 })), base, 'seed ' + seed);
  }
  const dup = evs.concat(evs, [evs[0]]);
  assert.deepStrictEqual(strip(nf.reduce(BK, dup, { now: 0 })), base);
  assert.strictEqual(base.eventCount, 5);
  assert.strictEqual(base.expectedEnd, '15:15');
  assert.strictEqual(base.lateMin, 15);
});

test('同一時刻のイベントは id の辞書順で決定的', () => {
  const a = [ev('a_done', 'done', '14:55'), ev('b_arrived', 'arrived', '14:55')];
  const s1 = nf.reduce(BK, a, { now: 0 }), s2 = nf.reduce(BK, a.slice().reverse(), { now: 0 });
  assert.strictEqual(s1.status, s2.status);
  assert.strictEqual(s1.status, 'done');   // a_done が先、b_arrived は終端後なので効かない
});

test('★後退しない：waiting 以降に call / cancel が来ても status は戻らない', () => {
  const w = [ev('e1', 'arrived', '12:29')];
  assert.strictEqual(nf.reduce(BK, w.concat([ev('c1', 'call', '13:00', { data: { lateMin: 10 } })]), { now: 0 }).status, 'waiting');
  assert.strictEqual(nf.reduce(BK, w.concat([ev('x1', 'cancel', '13:00')]), { now: 0 }).status, 'waiting');
  const d = w.concat([ev('e3', 'done', '14:55')]);
  assert.strictEqual(nf.reduce(BK, d.concat([ev('e9', 'arrived', '15:10')]), { now: 0 }).status, 'done');
  assert.strictEqual(nf.reduce(BK, d.concat([ev('x2', 'cancel', '15:10')]), { now: 0 }).status, 'done');
});

test('call → late-hold、遅れぶん expected と dueAt が後ろへ', () => {
  const s = nf.reduce(BK, [ev('c1', 'call', '12:40', { data: { lateMin: 20 } })], { now: 0 });
  assert.strictEqual(s.status, 'late-hold');
  assert.strictEqual(s.expectedStart, '12:50');
  assert.strictEqual(s.expectedEnd, '15:20');
  assert.strictEqual(s.dueAt, T('12:55'));   // 12:30 + 5 + 20
  assert.strictEqual(s.callConfirmed, true);
});

test('cancel → cancelled → cancel_ack → done（cancelled 印は残る）', () => {
  const s1 = nf.reduce(BK, [ev('x1', 'cancel', '12:00')], { now: 0 });
  assert.strictEqual(s1.status, 'cancelled'); assert.strictEqual(s1.cancelled, true);
  const s2 = nf.reduce(BK, [ev('x1', 'cancel', '12:00'), ev('x2', 'cancel_ack', '12:05')], { now: 0 });
  assert.strictEqual(s2.status, 'done'); assert.strictEqual(s2.cancelled, true);
  // cancelled のあとの arrived は効かない（取り直しは新しい予約で）
  assert.strictEqual(nf.reduce(BK, [ev('x1', 'cancel', '12:00'), ev('e1', 'arrived', '12:30')], { now: 0 }).status, 'cancelled');
});

test('予約側の cancelled 印 → cancelled（done は変えない）', () => {
  const bk = Object.assign({}, BK, { cancelled: true });
  assert.strictEqual(nf.reduce(bk, [], { now: 0 }).status, 'cancelled');
  assert.strictEqual(nf.reduce(bk, [ev('e1', 'arrived', '12:29'), ev('e3', 'done', '14:55')], { now: 0 }).status, 'done');
});

test('no-show：スキャンの印（markNoShowAt）→ 引き継ぎ → arrived で前進', () => {
  const marked = nf.reduce(BK, [], { now: T('12:36'), markNoShowAt: T('12:36') });
  assert.strictEqual(marked.status, 'no-show'); assert.strictEqual(marked.noShowAt, T('12:36'));
  // 次の再計算（cur を渡す）でも no-show のまま
  const again = nf.reduce(BK, [], { now: T('12:40'), cur: marked });
  assert.strictEqual(again.status, 'no-show'); assert.strictEqual(again.noShowAt, T('12:36'));
  // 来園すれば waiting
  const arr = nf.reduce(BK, [ev('e1', 'arrived', '12:45')], { now: T('12:45'), cur: again });
  assert.strictEqual(arr.status, 'waiting'); assert.strictEqual(arr.noShowAt, null);
  // 電話確認なら late-hold
  const call = nf.reduce(BK, [ev('c1', 'call', '12:45', { data: { lateMin: 30 } })], { now: T('12:45'), cur: again });
  assert.strictEqual(call.status, 'late-hold');
});

test('★no-show 後に予約時刻が動いたら reserved に戻る（2026-10-27 決定）', () => {
  const marked = nf.reduce(BK, [], { now: T('12:36'), markNoShowAt: T('12:36') });
  const moved = nf.reduce(Object.assign({}, BK, { start: '13:30', end: '16:00' }), [], { now: T('12:40'), cur: marked });
  assert.strictEqual(moved.status, 'reserved');
  assert.strictEqual(moved.noShowAt, null);
  assert.strictEqual(moved.dueAt, T('13:35'));
  assert.strictEqual(nf.isNoShowCandidate(moved, T('13:34')), false);
  assert.strictEqual(nf.isNoShowCandidate(moved, T('13:35')), true);
});

test('isNoShowCandidate / inScanHours / stateChanged', () => {
  const s = nf.reduce(BK, [], { now: 0 });
  assert.strictEqual(nf.isNoShowCandidate(s, T('12:34')), false);
  assert.strictEqual(nf.isNoShowCandidate(s, T('12:35')), true);
  assert.strictEqual(nf.isNoShowCandidate(nf.reduce(BK, [ev('e1', 'arrived', '12:29')], { now: 0 }), T('13:00')), false);
  assert.strictEqual(nf.inScanHours(T('06:59'), [7, 20]), false);
  assert.strictEqual(nf.inScanHours(T('07:00'), [7, 20]), true);
  assert.strictEqual(nf.inScanHours(T('19:59'), [7, 20]), true);
  assert.strictEqual(nf.inScanHours(T('20:00'), [7, 20]), false);
  assert.strictEqual(nf.stateChanged(s, nf.reduce(BK, [], { now: 99 })), false);   // computedAt の違いは無視
  assert.strictEqual(nf.stateChanged(s, nf.reduce(BK, [ev('e1', 'arrived', '12:29')], { now: 0 })), true);
});

test('at は Timestamp 風 / Date / ms のどれでも', () => {
  const ms = T('12:29');
  const a = nf.reduce(BK, [{ id: 'e1', type: 'arrived', at: { seconds: Math.floor(ms / 1000), nanoseconds: 0 } }], { now: 0 });
  const b = nf.reduce(BK, [{ id: 'e1', type: 'arrived', at: new Date(ms) }], { now: 0 });
  const c = nf.reduce(BK, [{ id: 'e1', type: 'arrived', at: { toMillis: () => ms } }], { now: 0 });
  assert.strictEqual(a.lastEventAt, ms); assert.strictEqual(b.lastEventAt, ms); assert.strictEqual(c.lastEventAt, ms);
});

test('不正な type は無視・gardenId 無しは月寒', () => {
  const s = nf.reduce(Object.assign({}, BK, { gardenId: undefined }), [ev('z', 'noshow', '12:00'), ev('e1', 'arrived', '12:29')], { now: 0 });
  assert.strictEqual(s.garden, 'tsukisamu');
  assert.strictEqual(s.status, 'waiting');
  assert.strictEqual(s.eventCount, 1);
});
