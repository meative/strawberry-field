// 本番 smoke（読み取り専用）：notify 3本を GitHub Pages から開き、起動・購読（サーバー確定受信）・JSエラー0・版を確認する。
// ★ Firestore の書き込み関数（setDoc / updateDoc / deleteDoc / addDoc / writeBatch / runTransaction）を SDK の層で
//   無効化するので、本番に1バイトも書かない（10/27 に smoke が sf_notify の n を書き直して現場に再着信させた再発防止）。
//   読みは本物（匿名認証・onSnapshot）。遮った書き込みは window.__sfBlocked に記録して最後に出す。
// 使い方: node tests/prod/smoke_notify_readonly.mjs <期待する SF_APP_VER>   （playwright は NODE_PATH か import パスで解決）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const VER = process.argv[2];
if (!VER) { console.error('usage: smoke_notify_readonly.mjs <SF_APP_VER>'); process.exit(2); }
const BASE = 'https://meative.github.io/strawberry-field/apps/';
const FILES = ['notify.html', 'notify_sp_tsukisamu.html', 'notify_sp_shiraishi.html'];
const FS_URL = 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
const WRAPPER = `
import * as real from '${FS_URL}?sfreal=1';
export * from '${FS_URL}?sfreal=1';
const S = (window.__sfBlocked = window.__sfBlocked || []);
const p = (r) => (r && (r.path || (r._key && r._key.path && r._key.path.toString()))) || String(r);
export function setDoc(ref) { S.push('set ' + p(ref)); return Promise.resolve(); }
export function updateDoc(ref) { S.push('update ' + p(ref)); return Promise.resolve(); }
export function deleteDoc(ref) { S.push('delete ' + p(ref)); return Promise.resolve(); }
export function addDoc(ref) { S.push('add ' + p(ref)); return Promise.resolve({ id: 'blocked' }); }
export function runTransaction() { S.push('transaction'); return Promise.resolve(); }
export function writeBatch() {
  const ops = [];
  return { set(r) { ops.push('batch.set ' + p(r)); }, update(r) { ops.push('batch.update ' + p(r)); }, delete(r) { ops.push('batch.delete ' + p(r)); },
           commit() { ops.forEach((o) => S.push(o)); return Promise.resolve(); } };
}
`;
let fails = 0;
const browser = await chromium.launch();
for (const f of FILES) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.route((u) => u.href === FS_URL, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: WRAPPER }));
  const errors = [], cerr = [], logs = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text()); logs.push(m.text()); });
  // 版違いの自動再読込を止める（評価中のナビゲーションを防ぐ）。端末IDは書かないので sf_devices にも残らない
  await page.addInitScript(() => { try { localStorage.setItem('sf_verreload_at_v1', String(Date.now())); } catch (e) {} });
  const t0 = Date.now();
  await page.goto(BASE + f + '?v=' + Date.now(), { waitUntil: 'load' });
  let ok = false;
  try { await page.waitForFunction(() => window.__nfSrvAt > 0 && typeof window.sfApplySnapshot === 'function', null, { timeout: 20000 }); ok = true; } catch (e) {}
  const r = await page.evaluate(() => ({ ver: window.SF_APP_VER, srvAt: window.__nfSrvAt || 0, seen: (typeof NF_SNAP_SEEN !== 'undefined') ? NF_SNAP_SEEN : null,
    bk: (typeof NF_BOOKINGS_SEEN !== 'undefined') ? NF_BOOKINGS_SEEN : null, mode: window.__sfCacheMode, blocked: (window.__sfBlocked || []).length,
    blockedSample: (window.__sfBlocked || []).slice(0, 4) }));
  const sync = logs.filter((l) => l.indexOf('[notify] 同期を受信') === 0).length;
  const good = ok && r.ver === VER && errors.length === 0 && cerr.length === 0 && sync >= 1 && r.seen && r.bk;
  if (!good) fails++;
  console.log((good ? 'PASS ' : 'FAIL ') + f + ' ' + JSON.stringify({ ...r, sync, ms: Date.now() - t0, errors, cerr: cerr.slice(0, 3) }));
  await ctx.close();
}
await browser.close();
console.log(fails ? fails + ' FAIL' : 'SMOKE ALL PASS (read-only)');
process.exit(fails ? 1 : 0);
