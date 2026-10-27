// SF-NFSERVER : Firestore REST を「プロジェクト所有者の OAuth トークン」で叩くヘルパ（ルールの対象外＝Admin 相当）。
// トークンは Firebase CLI のログイン情報（~/.config/configstore/firebase-tools.json）。切れていたら `firebase projects:list` で更新される。
import fs from 'node:fs';
export const PROJ = 'strawberry-field-timely';
export const DB = `projects/${PROJ}/databases/(default)`;
export const BASE = `https://firestore.googleapis.com/v1/${DB}/documents`;
const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/configstore/firebase-tools.json', 'utf8'));
if (!cfg.tokens || !cfg.tokens.access_token || Date.now() > (cfg.tokens.expires_at || 0)) {
  console.error('firebase CLI の access_token が無いか期限切れ。`firebase projects:list` を1回実行してから再実行してください'); process.exit(2);
}
export const H = { authorization: 'Bearer ' + cfg.tokens.access_token, 'content-type': 'application/json' };

export function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  return { stringValue: String(v) };
}
export function dec(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  return v;
}
export const decDoc = (d) => ({ _id: d.name.split('/').pop(), _createTime: d.createTime, _updateTime: d.updateTime, ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, x]) => [k, dec(x)])) });
export const eq = (f, v) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: enc(v) } });
export const and = (...fs) => ({ compositeFilter: { op: 'AND', filters: fs } });
export async function runQuery(coll, where, limit = 2000) {
  const body = { structuredQuery: { from: [{ collectionId: coll }], limit } };
  if (where) body.structuredQuery.where = where;
  const res = await fetch(`${BASE}:runQuery`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error('runQuery ' + coll + ': ' + JSON.stringify(j).slice(0, 300));
  return j.filter((x) => x.document).map((x) => decDoc(x.document));
}
export async function getDoc(path) {
  const res = await fetch(`${BASE}/${path}`, { headers: H });
  if (res.status === 404) return null;
  const j = await res.json(); if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  return decDoc(j);
}
export async function setDoc(path, obj, mask) {
  const url = `${BASE}/${path}` + (mask ? '?' + mask.map((m) => 'updateMask.fieldPaths=' + m).join('&') : '');
  const res = await fetch(url, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])) }) });
  const j = await res.json(); if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  return decDoc(j);
}
export async function deleteDoc(path) {
  const res = await fetch(`${BASE}/${path}`, { method: 'DELETE', headers: H });
  return res.status;
}
