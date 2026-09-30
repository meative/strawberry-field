// Fake Firebase modules served in place of gstatic (no network, no prod reads).
// Everything is recorded on window.__fs so tests can inspect calls and emit snapshots.
const FIRESTORE = `
const S = (window.__fs = window.__fs || { calls: [], listeners: [], writes: [] });
export function initializeFirestore(app, opts) { S.calls.push(['initializeFirestore']); return { app, fake: true }; }
export function getFirestore(app) { return { app, fake: true }; }
export function persistentLocalCache(o) { return o; }
export function persistentMultipleTabManager() { return {}; }
export function collection(db, name) { return { kind: 'collection', name }; }
export function doc(db, a, b) { return { kind: 'doc', name: (a && a.kind === 'collection') ? a.name : a, id: (a && a.kind === 'collection') ? b : b }; }
export function query(ref, ...c) { return { kind: 'query', ref, c }; }
export function where(f, op, v) { return { f, op, v }; }
export function onSnapshot(ref, a, b, c) {
  let opts = null, cb = a, err = b;
  if (a && typeof a !== 'function') { opts = a; cb = b; err = c; }
  const l = { ref, opts, cb, err, active: true, name: ref.kind === 'query' ? ref.ref.name : ref.name };
  S.listeners.push(l);
  return () => { l.active = false; };
}
export function setDoc(ref, data) { S.writes.push({ op: 'set', path: ref.name + '/' + ref.id, data }); return Promise.resolve(); }
export function deleteDoc(ref) { S.writes.push({ op: 'delete', path: ref.name + '/' + ref.id }); return Promise.resolve(); }
export function writeBatch(db) {
  const ops = [];
  return {
    set(ref, data) { ops.push({ op: 'set', path: ref.name + '/' + ref.id, data }); },
    delete(ref) { ops.push({ op: 'delete', path: ref.name + '/' + ref.id }); },
    commit() { ops.forEach(o => S.writes.push(o)); S.calls.push(['commit', ops.length]); return Promise.resolve(); }
  };
}
export function disableNetwork(db) { S.calls.push(['disableNetwork', Date.now()]); return Promise.resolve(); }
export function enableNetwork(db) { S.calls.push(['enableNetwork', Date.now()]); return Promise.resolve(); }
export function getDoc() { return Promise.resolve({ exists: () => false, data: () => null }); }
export function getDocs() { return Promise.resolve({ docs: [] }); }
export function updateDoc() { return Promise.resolve(); }
export function serverTimestamp() { return new Date().toISOString(); }
// test helper: emit a snapshot to every active listener on a collection name
window.__emit = function (name, rows, fromCache) {
  const metadata = { fromCache: !!fromCache, hasPendingWrites: false };
  let n = 0;
  S.listeners.filter(l => l.active && l.name === name).forEach(l => {
    n++;
    if (l.ref.kind === 'doc') {
      const d = rows && rows.length ? rows[0] : null;
      l.cb({ exists: () => !!d, data: () => d, metadata, id: l.ref.id });
    } else {
      l.cb({ docs: (rows || []).map(r => ({ id: r.id, data: () => r, metadata })), size: (rows || []).length, metadata, empty: !(rows && rows.length) });
    }
  });
  return n;
};
`;
const APP = `export function initializeApp(cfg, name) { return { cfg, name: name || '[DEFAULT]' }; }`;
const AUTH = `
export function getAuth(app) { return { app }; }
export function signInAnonymously(auth) { return Promise.resolve({ user: { uid: 'test-uid' } }); }
export function onAuthStateChanged(auth, cb) { setTimeout(() => cb({ uid: 'test-uid' }), 0); return () => {}; }
`;

async function installStubs(page) {
  // registered first = lowest priority (Playwright matches the most recently added route first)
  await page.route(/^https?:\/\//, (route) => route.abort());
  await page.route('https://www.gstatic.com/firebasejs/**', (route) => {
    const url = route.request().url();
    let body = '';
    if (url.includes('firebase-firestore')) body = FIRESTORE;
    else if (url.includes('firebase-app')) body = APP;
    else if (url.includes('firebase-auth')) body = AUTH;
    else body = 'export default {};';
    route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body });
  });
}
module.exports = { installStubs };
