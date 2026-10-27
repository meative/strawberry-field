// Firebase Rules REST API（projects.test）でルールをデプロイせずに検証する。Java 不要。
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/configstore/firebase-tools.json'));
const TOK = cfg.tokens.access_token;
const PROJ = 'strawberry-field-timely';
const src = fs.readFileSync(process.argv[2], 'utf8');
const T = '2026-10-27T07:00:00Z';
const auth = { uid: 'anon1', token: { firebase: { sign_in_provider: 'anonymous' } } };
const base = '/databases/(default)/documents';
const good = { bookingId: 'bk_1', garden: 'tsukisamu', date: '2026-10-27', salon: 'woodstock', type: 'arrived', at: T, clientAt: 1, by: 'Dxyz', ver: '290f1c7' };
const NAMES = []; const tc = (name, exp, req, resource) => { NAMES.push(name); return { expectation: exp, request: req, ...(resource ? { resource } : {}) }; };
const rq = (method, path, extra = {}) => ({ method, path: base + path, time: T, ...extra });
const cases = [
  tc('既存: 未認証は sf_bookings を読めない', 'DENY', rq('get', '/sf_bookings/x')),
  tc('既存: 認証済みは sf_bookings を読める', 'ALLOW', rq('get', '/sf_bookings/x', { auth })),
  tc('既存: 認証済みは sf_bookings に書ける', 'ALLOW', rq('update', '/sf_bookings/x', { auth, resource: { data: { a: 1 } } }), { data: { a: 0 } }),
  tc('既存: 認証済みは sf_config/version に書ける', 'ALLOW', rq('update', '/sf_config/version', { auth, resource: { data: { ver: 'x' } } }), { data: { ver: 'y' } }),
  tc('既存: 認証済みは sf_notify（旧）に書ける', 'ALLOW', rq('create', '/sf_notify/tsukisamu__c__bk', { auth, resource: { data: { g: 'tsukisamu' } } })),
  tc('既存: 認証済みは sf_devices を list できる', 'ALLOW', rq('list', '/sf_devices', { auth })),
  tc('events: 正しい create は通る', 'ALLOW', rq('create', '/sf_notify_events/e1', { auth, resource: { data: good } })),
  tc('events: 未認証の create は拒否', 'DENY', rq('create', '/sf_notify_events/e1', { resource: { data: good } })),
  tc('events: at が request.time と違う（端末時計）は拒否', 'DENY', rq('create', '/sf_notify_events/e1', { auth, resource: { data: { ...good, at: '2026-10-27T06:59:00Z' } } })),
  tc('events: by=fn は拒否', 'DENY', rq('create', '/sf_notify_events/e1', { auth, resource: { data: { ...good, by: 'fn' } } })),
  tc('events: 余分なキーは拒否', 'DENY', rq('create', '/sf_notify_events/e1', { auth, resource: { data: { ...good, status: 'waiting' } } })),
  tc('events: type 不正は拒否', 'DENY', rq('create', '/sf_notify_events/e1', { auth, resource: { data: { ...good, type: 'noshow' } } })),
  tc('events: garden 不正は拒否', 'DENY', rq('create', '/sf_notify_events/e1', { auth, resource: { data: { ...good, garden: 'x' } } })),
  tc('events: update は拒否', 'DENY', rq('update', '/sf_notify_events/e1', { auth, resource: { data: good } }), { data: good }),
  tc('events: delete は拒否', 'DENY', rq('delete', '/sf_notify_events/e1', { auth }), { data: good }),
  tc('events: 認証済みは読める', 'ALLOW', rq('get', '/sf_notify_events/e1', { auth }), { data: good }),
  tc('state: 認証済みは読める', 'ALLOW', rq('get', '/sf_notify_state/bk_1', { auth }), { data: { status: 'waiting' } }),
  tc('state: create は拒否', 'DENY', rq('create', '/sf_notify_state/bk_1', { auth, resource: { data: { status: 'waiting' } } })),
  tc('state: update は拒否', 'DENY', rq('update', '/sf_notify_state/bk_1', { auth, resource: { data: { status: 'done' } } }), { data: { status: 'waiting' } }),
  tc('state: 未認証は読めない', 'DENY', rq('get', '/sf_notify_state/bk_1')),
];
const body = { source: { files: [{ name: 'firestore.rules', content: src }] }, testSuite: { testCases: cases } };
const res = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJ}:test`, { method: 'POST', headers: { authorization: 'Bearer ' + TOK, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const j = await res.json();
if (!res.ok) { console.log(res.status, JSON.stringify(j).slice(0, 1500)); process.exit(2); }
if (j.issues && j.issues.length) { console.log('ISSUES', JSON.stringify(j.issues, null, 1)); }
let fails = 0;
(j.testResults || []).forEach((r, i) => {
  const ok = r.state === 'SUCCESS';
  if (!ok) fails++;
  console.log((ok ? '  PASS ' : '  FAIL ') + NAMES[i] + (ok ? '' : '  ' + JSON.stringify({ state: r.state, msgs: r.debugMessages, err: r.errorPosition })));
});
console.log(fails ? fails + ' FAIL' : 'RULES ALL PASS (' + cases.length + ')');
process.exit(fails ? 1 : 0);
