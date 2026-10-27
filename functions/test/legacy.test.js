'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const lg = require('../lib/legacy.js');
const nf = require('../lib/nfstate.js');

const NOW = Date.parse('2026-10-27T05:00:00Z');
const cdoc = (status, extra) => ({ id: 'tsukisamu__c__bk_1', g: 'tsukisamu', k: 'c', key: 'bk_1', ts: NOW, _w: { dev: 'Dabc', ver: '290f1c7' },
  data: Object.assign({ salonKey: 'woodstock', sfId: 'bk_1', status, stTs: NOW }, extra || {}) });

test('c: waiting → arrived（決定的 id・by は legacy:端末）', () => {
  const e = lg.legacyToEvents(cdoc('waiting'), NOW);
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].type, 'arrived');
  assert.strictEqual(e[0].id, 'legacy_tsukisamu__c__bk_1_waiting');
  assert.strictEqual(e[0].by, 'legacy:Dabc');
  assert.strictEqual(e[0].bookingId, 'bk_1');
  assert.strictEqual(e[0].date, '2026-10-27');
  assert.deepStrictEqual(lg.legacyToEvents(cdoc('waiting'), NOW + 5000), e.map((x) => Object.assign({}, x)));   // 何度見ても同じ
});

test('★c: reserved / no-show は翻訳しない（旧端末の判定・後退を持ち込まない）', () => {
  assert.strictEqual(lg.legacyToEvents(cdoc('reserved'), NOW).length, 0);
  assert.strictEqual(lg.legacyToEvents(cdoc('no-show'), NOW).length, 0);
});

test('c: late-hold → call(lateMin) / cancelled → cancel / done+cancelled → cancel, cancel_ack / done → done', () => {
  const call = lg.legacyToEvents(cdoc('late-hold', { callConfirmed: true, callLateMin: 20 }), NOW);
  assert.strictEqual(call[0].type, 'call'); assert.strictEqual(call[0].data.lateMin, 20);
  assert.strictEqual(lg.legacyToEvents(cdoc('cancelled', { cancelled: true }), NOW)[0].type, 'cancel');
  const ack = lg.legacyToEvents(cdoc('done', { cancelled: true }), NOW);
  assert.deepStrictEqual(ack.map((x) => x.type), ['cancel', 'cancel_ack']);
  assert.strictEqual(lg.legacyToEvents(cdoc('done'), NOW)[0].type, 'done');
});

test('★fn が書いた旧形式は翻訳しない（往復ループ防止）', () => {
  const d = cdoc('waiting'); d._w = { dev: 'fn', ver: 'x' };
  assert.strictEqual(lg.legacyToEvents(d, NOW).length, 0);
});

test('n: coming → pickup / call → call / late → msg(kind late)', () => {
  const ndoc = (type, extra) => ({ id: 'tsukisamu__n__woodstock%7CX', g: 'tsukisamu', k: 'n', key: 'woodstock|X', ts: NOW, _w: { dev: 'Dabc' },
    data: Object.assign({ key: 'woodstock|X', type, salonKey: 'woodstock', sfId: 'bk_1', ts: NOW }, extra || {}) });
  assert.strictEqual(lg.legacyToEvents(ndoc('coming'), NOW)[0].type, 'pickup');
  const c = lg.legacyToEvents(ndoc('call', { lateMin: 15 }), NOW)[0];
  assert.strictEqual(c.type, 'call'); assert.strictEqual(c.data.lateMin, 15);
  const l = lg.legacyToEvents(ndoc('late', { lateMin: 10, expectedEnd: '15:10' }), NOW)[0];
  assert.strictEqual(l.type, 'msg'); assert.strictEqual(l.kind, 'late'); assert.strictEqual(l.data.expectedEnd, '15:10');
  assert.strictEqual(lg.legacyToEvents(ndoc('unknown'), NOW).length, 0);
});

test('翻訳したイベントを reduce に通すと旧 c と同じ status になる', () => {
  const bk = { id: 'bk_1', salon: 'woodstock', gardenId: 'tsukisamu', date: '2026-10-27', start: '12:30', end: '15:00' };
  for (const st of ['waiting', 'late-hold', 'cancelled', 'done']) {
    const evs = lg.legacyToEvents(cdoc(st, st === 'late-hold' ? { callLateMin: 5 } : {}), NOW);
    assert.strictEqual(nf.reduce(bk, evs, { now: NOW }).status, st, st);
  }
});

test('buildLegacyC: notify.html の c と同じ形', () => {
  const bk = { id: 'bk_1', salon: 'woodstock', gardenId: 'tsukisamu', date: '2026-10-27', start: '12:30', end: '15:00' };
  const s = nf.reduce(bk, [{ id: 'c1', type: 'call', at: NOW, data: { lateMin: 10 } }], { now: NOW });
  const c = lg.buildLegacyC(s, NOW);
  assert.strictEqual(c.id, 'tsukisamu__c__bk_1'); assert.strictEqual(c.k, 'c');
  assert.strictEqual(c.data.status, 'late-hold'); assert.strictEqual(c.data.callLateMin, 10); assert.strictEqual(c.data.stTs, NOW);
});
