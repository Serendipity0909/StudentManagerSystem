/* =========================================================
 * tools/qa-v4-lead.js —— team-lead 独立纯函数复核套件
 *   TZ=Asia/Shanghai node tools/qa-v4-lead.js
 *
 * 定位：不依赖任何 QA worker 产物的「第二层独立验证」。
 *   直接在单个 vm sandbox 里按 index.html 顺序装载
 *   core → db → perm → ui-kit → module-customers，
 *   真实驱动 App.CustomersCore 的 v4 增量与 App.StopResCore 六函数。
 *
 * 与 qa-v4-core.js（QA 专项）互补：本套件用独立构造的数据与独立断言，
 *   交叉验证 validate / filterRows / customerStats / normalize /
 *   visibleFields / localYm / sortRows，避免「自写自测」的盲区。
 *
 * 不连生产库、不执行 DDL、不改任何生产 js、不发布。
 * 末尾输出 === 结果：PASS N / FAIL M ===；FAIL>0 时 process.exit(1)。
 * ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js');
const store = new Map();

function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, children: [],
    hidden: false, disabled: false, checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, click() {}, remove() {}
  };
}

let mod = null;
const sb = {
  console,
  localStorage: {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
  },
  document: {
    createElement() { return makeEl(); }, createElementNS() { return makeEl(); },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, body: makeEl()
  },
  navigator: { onLine: true }, location: { hash: '' },
  setTimeout() { return 0; }, setInterval() { return 0; },
  clearTimeout() {}, clearInterval() {},
  fetch() { return Promise.reject(new Error('offline')); },
  Date, Math, JSON, Intl
};
sb.window = sb; sb.globalThis = sb; sb.self = sb;
sb.App = sb.window.App = {};
vm.createContext(sb);

['core.js', 'db.js', 'perm.js', 'ui-kit.js', 'module-customers.js'].forEach(function (f) {
  sb.App.registerModule = function (m) { mod = m; };
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sb, { filename: f });
});

const App = sb.App, C = App.CustomersCore, S = App.StopResCore;

/* ---------------- 断言框架 ---------------- */
let P = 0, F = 0;
const FAILS = [];
function ok(n, c, d) {
  if (c) { P++; return true; }
  F++; FAILS.push(n + (d ? ' → ' + d : ''));
  console.log('  FAIL  ' + n + (d ? '  → ' + d : ''));
  return false;
}
function eq(n, a, b) { return ok(n, a === b, '实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

console.log('=== team-lead 独立纯函数复核（v4）===');
if (!C || !S) { console.log('FATAL: CustomersCore / StopResCore 未外露'); process.exit(1); }

/* =========================================================
 * 1. CustomersCore v4 增量
 * ========================================================= */
section('1. CustomersCore 意向程度增量');
const base = {
  stu_name: '张小明', school: '实验中学', phone: '13800138000', grade: '高一',
  resource_type: '上门咨询', intended_product: '一对一', intended_subjects: ['数学'],
  intent_level: '高', created_at: '2026-11-01T01:00:00.000Z'
};
ok('合法表单通过', C.validate(Object.assign({}, base)).ok);
const noIntent = C.validate(Object.assign({}, base, { intent_level: undefined }));
ok('缺 intent_level 被拒', !noIntent.ok && !!noIntent.errors.intent_level);
ok('intent_level 空串被拒', !!C.validate(Object.assign({}, base, { intent_level: '' })).errors.intent_level);
ok('intent_level 非枚举被拒', !!C.validate(Object.assign({}, base, { intent_level: '特高' })).errors.intent_level);

const crows = [
  { intent_level: '高' }, { intent_level: '中' }, { intent_level: '' },
  { intent_level: null }, { intent_level: '特高' }
];
eq('filterRows __blank__ 命中 3 条（空/null/非法）',
  C.filterRows(crows, { intent_level: '__blank__' }).length, 3);
eq('filterRows 高 只命中 1 条', C.filterRows(crows, { intent_level: '高' }).length, 1);

const stRow = {
  resource_type: '上门咨询', created_at: '2026-11-01T00:00:00Z',
  visited: true, visit_at: '2026-11-02T00:00:00Z',
  paid: true, paid_at: '2026-11-03T00:00:00Z', paid_amount: 100
};
const st1 = JSON.stringify(C.customerStats([stRow], null));
const st2 = JSON.stringify(C.customerStats([Object.assign({ intent_level: '高' }, stRow)], null));
ok('customerStats 对 intent_level 无感（V-G2 零改动）', st1 === st2);

/* =========================================================
 * 2. StopResCore.validate
 * ========================================================= */
section('2. StopResCore.validate 类型分支与软提示');
const R = {
  stu_name: '张三', phone: '13800138000', grade: '高一', school: '第一中学',
  stop_date: '2026-03-15T02:00:00.000Z', resource_type: '退费资源',
  teacher: '王老师', followup_intent: '高', refund_reason: '课程不合适',
  refund_subjects: '数学', refund_amount: 3000, parent_confirmed: true,
  refund_applied: true, refund_apply_at: '2026-02-15T02:00:00.000Z',
  refund_arrived: false, refund_arrived_at: null
};
const NR = {
  stu_name: '李四', phone: '13900139000', grade: '初一', school: '第二中学',
  stop_date: '2026-01-10T02:00:00.000Z', resource_type: '未续费资源',
  teacher: '陈老师', followup_intent: '中', nonrenew_reason: '搬家', end_subjects: '英语'
};
ok('退费资源合法表单通过', S.validate(Object.assign({}, R)).ok,
  JSON.stringify(S.validate(Object.assign({}, R)).errors));
ok('未续费资源合法表单通过', S.validate(Object.assign({}, NR)).ok,
  JSON.stringify(S.validate(Object.assign({}, NR)).errors));
ok('未续费类型不报退费金额必填（V-C4 隐藏字段不校验）',
  !S.validate(Object.assign({}, NR)).errors.refund_amount);
ok('退费缺 refund_amount 被拒',
  !!S.validate(Object.assign({}, R, { refund_amount: null })).errors.refund_amount);
ok('未续费缺 nonrenew_reason 被拒',
  !!S.validate(Object.assign({}, NR, { nonrenew_reason: '' })).errors.nonrenew_reason);
ok('refund_applied=是 缺时间被拒',
  !!S.validate(Object.assign({}, R, { refund_apply_at: null })).errors.refund_apply_at);
ok('refund_applied=否 不报时间',
  !S.validate(Object.assign({}, R, { refund_applied: false, refund_apply_at: null })).errors.refund_apply_at);
ok('refund_arrived=是 缺时间被拒',
  !!S.validate(Object.assign({}, R, { refund_arrived: true, refund_arrived_at: null })).errors.refund_arrived_at);
const w1 = S.validate(Object.assign({}, NR, { stop_date: '2099-12-31T00:00:00.000Z' }));
ok('未来日期只进 warnings 不拦截（OQ-1 A）', w1.ok && w1.warnings.length > 0);
const w2 = S.validate(Object.assign({}, R, {
  refund_arrived: true, refund_apply_at: '2020-03-20T00:00:00.000Z',
  refund_arrived_at: '2020-03-10T00:00:00.000Z'
}));
ok('到账早于提交只进 warnings 不拦截（OQ-3 A）', w2.ok && w2.warnings.length > 0);
ok('手机号格式校验', !!S.validate(Object.assign({}, NR, { phone: '123' })).errors.phone);
ok('退费金额上限 999999', !!S.validate(Object.assign({}, R, { refund_amount: 1000000 })).errors.refund_amount);

/* =========================================================
 * 3. StopResCore.normalize（pick 保留 null 剥离 undefined 的护栏）
 * ========================================================= */
section('3. StopResCore.normalize 条件字段归一');
const nz = S.normalize(Object.assign({
  refund_amount: 3000, refund_reason: 'X', nonrenew_reason: '脏值', end_subjects: '脏值'
}, { resource_type: '未续费资源' }));
['refund_amount', 'parent_confirmed', 'refund_applied', 'refund_apply_at',
  'refund_arrived', 'refund_arrived_at', 'refund_reason', 'refund_subjects'].forEach(function (k) {
  ok('未续费归一键存在（非 undefined）：' + k, Object.prototype.hasOwnProperty.call(nz, k));
});
eq('未续费 refund_amount===null', nz.refund_amount, null);
eq('未续费 parent_confirmed===false', nz.parent_confirmed, false);
eq('未续费 refund_applied===false', nz.refund_applied, false);
eq('未续费 refund_apply_at===null', nz.refund_apply_at, null);
eq('未续费 refund_arrived===false', nz.refund_arrived, false);
eq('未续费 refund_arrived_at===null', nz.refund_arrived_at, null);
eq('未续费 refund_reason===""', nz.refund_reason, '');
eq('未续费 refund_subjects===""', nz.refund_subjects, '');
const nz2 = S.normalize(Object.assign({}, R, {
  nonrenew_reason: '脏', end_subjects: '脏', refund_applied: false,
  refund_apply_at: '2026-02-15T02:00:00.000Z'
}));
eq('退费清 nonrenew_reason', nz2.nonrenew_reason, '');
eq('退费清 end_subjects', nz2.end_subjects, '');
eq('退费 applied=否 → refund_apply_at=null', nz2.refund_apply_at, null);

/* =========================================================
 * 4. visibleFields / localYm
 * ========================================================= */
section('4. visibleFields 与本地年月');
const vf = S.visibleFields('退费资源'), vn = S.visibleFields('未续费资源');
ok('退费 show 含 refund_amount / hide 含 nonrenew_reason',
  vf.show.indexOf('refund_amount') >= 0 && vf.hide.indexOf('nonrenew_reason') >= 0);
ok('未续费 show 含 end_subjects / hide 含 refund_amount',
  vn.show.indexOf('end_subjects') >= 0 && vn.hide.indexOf('refund_amount') >= 0);
eq('localYm 跨月边界 2026-02-28T16:00Z → 2026-03（禁 slice(0,7)）',
  S.localYm('2026-02-28T16:00:00.000Z'), '2026-03');
eq('localYm 空 → ""', S.localYm(''), '');
eq('localYm 非法 → ""', S.localYm('not-a-date'), '');
ok('UI.localYm 与 StopResCore.localYm 一致',
  App.UI.localYm('2026-02-28T16:00:00.000Z') === S.localYm('2026-02-28T16:00:00.000Z'));

/* =========================================================
 * 5. StopResCore.filterRows（S-1~S-9）
 * ========================================================= */
section('5. filterRows 九类筛选与 AND 组合');
const D = [
  { id: 1, stu_name: '张三', phone: '13800138000', grade: '高一', school: '第一中学',
    stop_date: '2026-03-15T02:00:00.000Z', resource_type: '退费资源',
    followup_intent: '高', parent_confirmed: true, refund_applied: true, refund_arrived: false },
  { id: 2, stu_name: '张三', phone: '13800138000', grade: '初一', school: '第二中学',
    stop_date: '2026-01-10T02:00:00.000Z', resource_type: '未续费资源',
    followup_intent: '中', parent_confirmed: false, refund_applied: false, refund_arrived: false },
  { id: 3, stu_name: '李四', phone: '13900139000', grade: '高一', school: '第一中学',
    stop_date: '2026-02-15T02:00:00.000Z', resource_type: '退费资源',
    followup_intent: '低', parent_confirmed: false, refund_applied: false, refund_arrived: true }
];
eq('S-1 关键字（姓名）', S.filterRows(D, { kw: '李四' }).length, 1);
eq('S-1 关键字（电话）', S.filterRows(D, { kw: '138001' }).length, 2);
eq('S-2 年级', S.filterRows(D, { grade: '初一' }).length, 1);
eq('S-3 学校（模糊）', S.filterRows(D, { school: '第一' }).length, 2);
eq('S-4 资源类型', S.filterRows(D, { resource_type: '退费资源' }).length, 2);
eq('S-5 回流意向', S.filterRows(D, { followup_intent: '高' }).length, 1);
eq('S-6 家长确认三态 yes', S.filterRows(D, { parent_confirmed: 'yes' }).length, 1);
eq('S-7 提交申请三态 no', S.filterRows(D, { refund_applied: 'no' }).length, 2);
eq('S-8 到账三态 yes', S.filterRows(D, { refund_arrived: 'yes' }).length, 1);
eq('S-9 起止月 2026-01~2026-02', S.filterRows(D, { ym_from: '2026-01', ym_to: '2026-02' }).length, 2);
eq('S-9 起>止自动交换', S.filterRows(D, { ym_from: '2026-03', ym_to: '2026-01' }).length, 3);
eq('S-9 只填起月单边界', S.filterRows(D, { ym_from: '2026-02' }).length, 2);
eq('S-9 不填全通过', S.filterRows(D, {}).length, 3);
eq('同人多条不去重（V-E1）', S.filterRows(D, { kw: '张三' }).length, 2);
eq('全部 AND 组合', S.filterRows(D, {
  kw: '张三', resource_type: '退费资源', ym_from: '2026-03', ym_to: '2026-03'
}).length, 1);

/* =========================================================
 * 6. sortRows 三级兜底 + 幂等
 * ========================================================= */
section('6. sortRows 三级兜底与幂等（V-D6）');
const U = [
  { id: 9, stop_date: '2026-03-15T02:00:00.000Z', created_at: '2026-03-01T00:00:00Z' },
  { id: 8, stop_date: '2026-03-15T02:00:00.000Z', created_at: '2026-03-02T00:00:00Z' },
  { id: 7, stop_date: '2026-01-10T02:00:00.000Z', created_at: '2026-01-01T00:00:00Z' },
  { id: 6, stop_date: '2026-03-15T02:00:00.000Z', created_at: '2026-03-02T00:00:00Z' }
];
const s1 = S.sortRows(U).map(function (r) { return r.id; }).join(',');
const s2 = S.sortRows(U).map(function (r) { return r.id; }).join(',');
const s3 = S.sortRows(U).map(function (r) { return r.id; }).join(',');
eq('stop_date↓ → created_at↓ → id↓', s1, '8,6,9,7');
ok('连续 3 次结果一致（刷新不抖动）', s1 === s2 && s2 === s3);

/* =========================================================
 * 结果
 * ========================================================= */
console.log('\n============================');
console.log('=== 结果：PASS ' + P + ' / FAIL ' + F + ' ===');
console.log('============================');
if (F) { FAILS.forEach(function (x) { console.log('  - ' + x); }); process.exit(1); }
process.exit(0);
