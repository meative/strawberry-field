// 手順1：sf_config/nfserver を影運転モードで作る（既にあれば mode 以外は保持）＋ 検証用 events の削除（所有者トークン＝Admin 相当）
import { getDoc, setDoc, deleteDoc } from './admin_rest.mjs';
const cur = await getDoc('sf_config/nfserver');
const cfg = Object.assign({ graceMin: 5, scanHours: [7, 20], legacyBridge: true, eventsTtlDays: 90, stateTtlDays: 30 }, cur || {}, { mode: 'shadow',
  note: 'SF-NFSERVER-S1-20261027 影運転。state は sf_notify_state_shadow、旧 sf_notify には書かない', updatedAt: new Date().toISOString(), by: 'setup_shadow-20261027' });
delete cfg._id; delete cfg._createTime; delete cfg._updateTime;
const w = await setDoc('sf_config/nfserver', cfg);
console.log('sf_config/nfserver:', JSON.stringify({ mode: w.mode, graceMin: w.graceMin, scanHours: w.scanHours, legacyBridge: w.legacyBridge, eventsTtlDays: w.eventsTtlDays, stateTtlDays: w.stateTtlDays }));
const before = await getDoc('sf_notify_events/e_rulescheck_20261027');
const st = await deleteDoc('sf_notify_events/e_rulescheck_20261027');
const after = await getDoc('sf_notify_events/e_rulescheck_20261027');
console.log('e_rulescheck_20261027: existed=' + !!before + ' delete=' + st + ' remains=' + !!after);
