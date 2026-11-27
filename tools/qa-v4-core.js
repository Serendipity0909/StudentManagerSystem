/* =========================================================
 * tools/qa-v4-core.js —— v4 纯函数层单测
 *   App.StopResCore 六函数 + App.CustomersCore v4 增量
 *
 * 运行（必须带时区，否则 V-D3 会假失败）：
 *   TZ=Asia/Shanghai node tools/qa-v4-core.js
 *
 * 权威契约：docs/ARCH-v4-customer-intent-stopres.md §3.2 / §3.3 / §10
 *   V-A2/A5/A6、V-C1~C5、V-D1~D6、V-E1、V-G2、OQ-1 A / OQ-3 A / OQ-4 A
 *
 * 被测真实实现（本套件所有断言按读到的实现书写，不凭猜测）：
 *   js/module-customers.js
 *     · CustomersCore.validate        L96-199   （intent_level 必选 / 枚举）
 *     · CustomersCore.filterRows      L216-255  （__blank__ 哨兵特判）
 *     · CustomersCore.customerStats   L263-296  （V-G2 口径零改动）
 *     · StopResCore.localYm           L315-322  （优先委托 UI.localYm）
 *     · StopResCore.visibleFields     L325-330
 *     · StopResCore.normalize         L335-357  （浅拷贝 + 归一）
 *     · StopResCore.validate          L362-445  （{ok,errors,warnings}）
 *     · StopResCore.filterRows        L450-491  （S-1~S-9 全部 AND）
 *     · StopResCore.sortRows          L494-504  （三级兜底）
 *   js/ui-kit.js：localYm L186-192 / fromDateInput L176-181 /
 *     GRADES L216-217 / INTENT_LEVELS L235 / STOP_RESOURCE_TYPES L237
 *   js/db.js：pick() L122-132（L128 `if (src[k] === undefined) continue;`
 *     —— 这正是 normalize 必须写 null/false/'' 而非 undefined 的原因）
 *
 * 沙箱口径（参考 tools/qa-v3-core.js 与 tools/smoke-v2-customer-task.js）：
 *   core.js → db.js → perm.js → ui-kit.js → module-customers.js
 *   Node vm + 最小 DOM 桩 + localStorage(Map) 桩；
 *   core.js 载入后把 App.registerModule 换成「捕获模块对象」的桩件
 *   （module-customers.js 末尾 L1452 会调用它），并给
 *   App.Modal / Toast / Perm / render 最小桩件。
 *   db.js 的 start() 不自动调用 → 全程零网络、零 DDL、零发布、零生产 js 改动。
 *
 * 与 tools/qa-v4-ui.js（渲染 / CRUD / 权限层）互补，本套件只测纯函数。
 * ========================================================= */
'use strict';

/* 时区兜底：即使忘记带 TZ 前缀也尽量对齐 UTC+8；正式运行仍用 TZ=Asia/Shanghai */
if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fx = require('./qa-v4-fixtures.js');

const SRC = path.join(__dirname, '..', 'js');
const ISO = fx.ISO;

/* ---------------- 断言框架（对齐 tools/qa-v3-core.js） ---------------- */
let pass = 0, fail = 0;
const FAILS = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); return; }
  fail++;
  FAILS.push(name + (detail === undefined ? '' : '  → ' + detail));
  console.log('  FAIL  ' + name + (detail === undefined ? '' : '  → ' + detail));
}
function eq(name, actual, expect) {
  ok(name, actual === expect, '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expect));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function ids(rows) { return (rows || []).map(function (r) { return String(r.id); }).join(','); }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/* ---------------- 最小 DOM 桩件 ---------------- */
function makeEl(id) {
  return {
    id: id || '',
    innerHTML: '', textContent: '', value: '', style: {},
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    addEventListener() { }, removeEventListener() { },
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() { }, insertBefore() { }, remove() { },
    setAttribute() { }, getAttribute() { return null; }, hasAttribute() { return false; },
    click() { }, focus() { }, setSelectionRange() { }
  };
}

const storeMap = new Map();
const sandbox = {
  console,
  localStorage: {
    getItem(k) { return storeMap.has(k) ? storeMap.get(k) : null; },
    setItem(k, v) { storeMap.set(k, String(v)); },
    removeItem(k) { storeMap.delete(k); },
    clear() { storeMap.clear(); }
  },
  document: {
    body: makeEl('body'),
    getElementById(id) { return makeEl(id); },
    createElement() { return makeEl(''); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() { },        /* 不派发 DOMContentLoaded → 不自启动 */
    hidden: false
  },
  setTimeout, clearTimeout,
  setInterval() { return 0; }, clearInterval() { },
  addEventListener() { },         /* window 级 */
  location: { hash: '', reload() { } },
  navigator: { onLine: true },
  Blob: function () { }, URL: { createObjectURL() { return ''; }, revokeObjectURL() { } }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

/* ---------------- 按 index.html 顺序装载 ---------------- */
function load(file) {
  vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), sandbox, { filename: file });
}

load('core.js');   /* 定义 window.App（含真实 U / Store / Score / Toast / Modal / registerModule） */

/* 载入 core.js 之后注入最小桩件：
   · registerModule 换成捕获桩（module-customers.js 末尾会调用，避免真实注册表副作用）
   · Toast / Modal / Perm / render 给最小桩件（纯函数层不触碰，保险起见全给上） */
let capturedModule = null;
sandbox.App.registerModule = function (m) { capturedModule = m; return m; };
sandbox.App.Toast = function () { };
sandbox.App.Modal = { open() { }, close() { }, body: null };
sandbox.App.render = function () { };
sandbox.App.Perm = {
  denied() { return false; }, forbiddenCard() { return ''; }, assertWrite() { return true; },
  assertAdminWrite() { return true; }, isAdmin() { return true; }, canEdit() { return true; }
};

load('db.js');               /* App.DB（start() 不自动调用 → 不发任何网络请求） */
load('perm.js');             /* App.Perm（真实版，惰性取 App.Sync，加载期无副作用） */
load('ui-kit.js');           /* App.UI：localYm / fromDateInput / 三个枚举 / round2 / inRange */
load('module-customers.js'); /* App.CustomersCore + App.StopResCore + registerModule(...) */

const App = sandbox.App;
const UI = App.UI;
const CC = App.CustomersCore;
const SC = App.StopResCore;

/* ---------------- 辅助 ---------------- */
function sids(filters, rows) { return ids(SC.filterRows(rows || fx.stopFilterDataset(), filters)); }
function cids(filters, rows, range) { return ids(CC.filterRows(rows || fx.customerFilterDataset(), filters, range)); }

/* =========================================================
 * §0 装载 / 签名外露 / 常量 / 时区自检
 * ========================================================= */
section('0. 模块装载、纯函数签名与常量');

ok('App.CustomersCore 已外露', !!CC && typeof CC === 'object');
ok('App.StopResCore 已外露', !!SC && typeof SC === 'object');
['validate', 'filterRows', 'customerStats'].forEach(function (k) {
  ok('CustomersCore.' + k + ' 是函数', typeof CC[k] === 'function');
});
['validate', 'filterRows', 'normalize', 'visibleFields', 'localYm', 'sortRows'].forEach(function (k) {
  ok('StopResCore.' + k + ' 是函数', typeof SC[k] === 'function');
});
ok('registerModule 捕获桩命中 customers 模块对象',
  !!capturedModule && capturedModule.id === 'customers' &&
  typeof capturedModule.render === 'function' && typeof capturedModule.bind === 'function' &&
  capturedModule.adminOnly === true);

eq('UI.INTENT_LEVELS = [低,中,高]', UI.INTENT_LEVELS.join(','), '低,中,高');
eq('UI.STOP_RESOURCE_TYPES = [退费资源,未续费资源]', UI.STOP_RESOURCE_TYPES.join(','), '退费资源,未续费资源');
ok('UI.GRADES 含夹具使用的年级 ' + fx.GRADE_OK, UI.GRADES.indexOf(fx.GRADE_OK) >= 0);
eq('UI.GRADES 仍为 12 项（v4 未改动）', UI.GRADES.length, 12);
eq('UI.RESOURCE_TYPES 仍是 7 项客户来源（未被新表污染）', UI.RESOURCE_TYPES.length, 7);
ok('UI.RESOURCE_TYPES 与 UI.STOP_RESOURCE_TYPES 值域互不重叠',
  UI.RESOURCE_TYPES.every(function (x) { return UI.STOP_RESOURCE_TYPES.indexOf(x) < 0; }));
eq('UI.PRIORITY 仍是英文值 high/mid/low（未被改名复用）',
  UI.PRIORITY.map(function (p) { return p.value; }).join(','), 'high,mid,low');
eq('夹具 REFUND_FIELDS 与实现 STOP_REFUND_FIELDS 一致（8 项）', fx.REFUND_FIELDS.length, 8);
eq('夹具 NONRENEW_FIELDS 与实现 STOP_NONRENEW_FIELDS 一致（2 项）', fx.NONRENEW_FIELDS.length, 2);

/* 时区自检：这两条在不带 TZ 的环境会 FAIL，明确提示正确运行方式 */
if (new Date(ISO.MARCH_BOUNDARY).getMonth() !== 2) {
  console.log('  [提示] 当前进程非 UTC+8 时区，V-D3 会假失败；请用 TZ=Asia/Shanghai node tools/qa-v4-core.js 运行');
}
eq('时区自检：本地 2026-03-01 00:00 → UTC 2026-02-28T16:00Z',
  new Date('2026-03-01T00:00:00').toISOString(), ISO.MARCH_BOUNDARY);
eq('UI.fromDateInput("2026-03-01") 与夹具边界 ISO 一致',
  UI.fromDateInput('2026-03-01'), ISO.MARCH_BOUNDARY);

/* =========================================================
 * §1 CustomersCore.validate —— V-A2 / V-A6 意向程度必选
 * ========================================================= */
section('1. CustomersCore.validate：intent_level 必选 / 枚举');

const cv = function (over) { return CC.validate(Object.assign(fx.validCustomerForm(), over || {})); };

const cvHigh = cv({ intent_level: '高' });
ok('完整合法表单带「高」→ ok=true', cvHigh.ok === true);
eq('完整合法表单带「高」→ errors 为空', Object.keys(cvHigh.errors).length, 0);
ok('带「中」→ ok=true', cv({ intent_level: '中' }).ok === true);
ok('带「低」→ ok=true', cv({ intent_level: '低' }).ok === true);
ok('带「 高 」(tstr trim) → ok=true', cv({ intent_level: ' 高 ' }).ok === true);

/* 缺 / 空串 / null（三者都走「请选择意向程度」） */
function noIntentForm() { const f = fx.validCustomerForm(); delete f.intent_level; return f; }
const cvMissing = CC.validate(noIntentForm());
ok('缺 intent_level（无该键）→ ok=false', cvMissing.ok === false);
eq('缺 intent_level → errors.intent_level = 请选择意向程度', cvMissing.errors.intent_level, '请选择意向程度');
eq('空串 intent_level → errors.intent_level = 请选择意向程度',
  cv({ intent_level: '' }).errors.intent_level, '请选择意向程度');
eq('null intent_level → errors.intent_level = 请选择意向程度',
  cv({ intent_level: null }).errors.intent_level, '请选择意向程度');
eq('undefined intent_level → errors.intent_level = 请选择意向程度',
  cv({ intent_level: undefined }).errors.intent_level, '请选择意向程度');
/* 非枚举值 */
const cvBad = cv({ intent_level: '超高' });
ok('非枚举「超高」→ ok=false', cvBad.ok === false);
eq('非枚举 → errors.intent_level = 意向程度不合法', cvBad.errors.intent_level, '意向程度不合法');
eq('非枚举数字 9 → 同样判不合法', cv({ intent_level: 9 }).errors.intent_level, '意向程度不合法');
eq('非枚举布尔 true → 同样判不合法', cv({ intent_level: true }).errors.intent_level, '意向程度不合法');
eq('非枚举英文 high（PRIORITY 值）→ 同样判不合法',
  cv({ intent_level: 'high' }).errors.intent_level, '意向程度不合法');
/* 回归保护：合法表单只改 intent_level，不应牵连其它字段 */
eq('只改 intent_level 时错误集合恰为 1 项（其余字段零回归）', Object.keys(cvBad.errors).length, 1);
ok('validate 返回 {ok, errors} 结构（CustomersCore 无 warnings）',
  hasOwn(cvHigh, 'ok') && hasOwn(cvHigh, 'errors') && !hasOwn(cvHigh, 'warnings'));
eq('CC.validate(null) 不抛错、返回 ok=false', CC.validate(null).ok, false);

/* =========================================================
 * §2 CustomersCore.filterRows —— V-A5 哨兵 / V-A6 不崩溃 / 其余筛选不回归
 * ========================================================= */
section('2. CustomersCore.filterRows：__blank__ 哨兵与筛选不回归');

eq('不填筛选 → 全 7 行', cids({}), '401,402,403,404,405,406,407');
eq('intent_level=__blank__ → 命中空串/缺字段/null/非法值 4 行',
  cids({ intent_level: '__blank__' }), '404,405,406,407');
eq('intent_level=高 → 只命中高', cids({ intent_level: '高' }), '401');
eq('intent_level=中 → 只命中中', cids({ intent_level: '中' }), '402');
eq('intent_level=低 → 只命中低', cids({ intent_level: '低' }), '403');
eq('非 __blank__ 筛选按精确等值（脏值「超高」命中 407）',
  cids({ intent_level: '超高' }), '407');
eq('非枚举筛选串「不存在」→ 0 行', cids({ intent_level: '不存在' }), '');

/* 哨兵特判：INTENT_LEVELS.indexOf(tstr(v)) < 0，逐个单独验证 */
const blankOne = function (row) { return ids(CC.filterRows([row], { intent_level: '__blank__' })); };
eq('哨兵命中空串行', blankOne(fx.makeCustomer({ id: 1, intent_level: '' })), '1');
eq('哨兵命中 null 行', blankOne(fx.makeCustomer({ id: 2, intent_level: null })), '2');
eq('哨兵命中无字段行', blankOne(fx.makeCustomer({ id: 3 })), '3');
eq('哨兵命中非枚举脏值行', blankOne(fx.makeCustomer({ id: 4, intent_level: '未知' })), '4');
eq('哨兵不命中合法「高」', blankOne(fx.makeCustomer({ id: 5, intent_level: '高' })), '');
eq('哨兵不命中合法「低」', blankOne(fx.makeCustomer({ id: 6, intent_level: '低' })), '');
eq('夹具带意向行不被哨兵命中', blankOne(fx.customerRowWithIntent()), '');
eq('夹具不带意向行被哨兵命中', blankOne(fx.customerRowWithoutIntent()), '302');

/* 其余筛选不回归（kw / 通用枚举循环 / 三态 / range / 组合 AND） */
eq('S-kw 姓名模糊', cids({ kw: '赵' }), '401');
eq('S-kw 电话模糊', cids({ kw: '13800138003' }), '403');
eq('S-kw 不分大小写（英文姓名）',
  ids(CC.filterRows([fx.makeCustomer({ id: 8, stu_name: 'Alice' })], { kw: 'ALICE' })), '8');
eq('grade 等值', cids({ grade: '初一' }), '401,404,407');
eq('resource_type 等值', cids({ resource_type: '电话咨询' }), '402,405,407');
eq('intended_product 等值（通用枚举循环仍在）', ids(CC.filterRows([
  fx.makeCustomer({ id: 11, intended_product: '一对一' }),
  fx.makeCustomer({ id: 12, intended_product: '班课' })
], { intended_product: '班课' })), '12');
eq('三态 visited=no → 全部（数据集均未上门）', cids({ visited: 'no' }), '401,402,403,404,405,406,407');
eq('三态 visited=yes → 0 行', cids({ visited: 'yes' }), '');
eq('三态 paid=否 → 全部', cids({ paid: '否' }), '401,402,403,404,405,406,407');
eq('三态 all → 不过滤', cids({ paid: 'all' }), '401,402,403,404,405,406,407');
eq('三态非法值 maybe → 不过滤', cids({ paid: 'maybe' }), '401,402,403,404,405,406,407');

const janRange = { start: new Date(2026, 0, 1, 0, 0, 0, 0), end: new Date(2026, 0, 31, 23, 59, 59, 999) };
eq('range 落在 2026-01 → 0 行（数据集 created_at 均为 3 月）',
  cids({}, fx.customerFilterDataset(), janRange), '');
const marRows = [fx.makeCustomer({ id: 21, created_at: ISO.MAR }), fx.makeCustomer({ id: 22, created_at: ISO.JAN })];
eq('range 按 created_at 生效（不回归）',
  ids(CC.filterRows(marRows, {}, { start: new Date('2026-03-01T00:00:00'), end: new Date('2026-03-31T23:59:59') })), '21');
eq('多条件 AND（kw + grade + resource_type + intent_level）',
  cids({ kw: '赵', grade: '初一', resource_type: '上门咨询', intent_level: '高' }), '401');
eq('AND：哨兵 + grade 收缩', cids({ intent_level: '__blank__', grade: '初一' }), '404,407');
const dsCustomer = fx.customerFilterDataset();
const outCustomer = CC.filterRows(dsCustomer, {});
ok('filterRows 返回新数组、不改入参顺序',
  outCustomer !== dsCustomer && ids(dsCustomer) === '401,402,403,404,405,406,407');
eq('CC.filterRows(null) → 空数组', CC.filterRows(null, {}).length, 0);

/* =========================================================
 * §3 CustomersCore.customerStats —— V-G2 统计口径零改动
 *   自己构造期望值；不接收 intent_level / stop_resources
 * ========================================================= */
section('3. CustomersCore.customerStats：V-G2 golden（不统计新字段）');

const st = CC.customerStats(fx.customerStatsRows(), null);
eq('total = 4', st.total, 4);
eq('visited = 2', st.visited, 2);
eq('signed = 2', st.signed, 2);
eq('signedAmount = 3000.75（round2 累加）', st.signedAmount, 3000.75);
eq('返回键恰为 5 项（无 intent_level / stop_resources 相关输出）',
  Object.keys(st).sort().join(','), 'byType,signed,signedAmount,total,visited');
eq('byType 长度 3', st.byType.length, 3);
eq('byType 顺序按 RESOURCE_TYPES 枚举',
  st.byType.map(function (b) { return b.type; }).join(','), '上门咨询,电话咨询,其他');
eq('byType[上门咨询] = (2,1,1,1000.5)',
  [st.byType[0].total, st.byType[0].visited, st.byType[0].signed, st.byType[0].signedAmount].join(','),
  '2,1,1,1000.5');
eq('byType[电话咨询] = (1,1,1,2000.25)',
  [st.byType[1].total, st.byType[1].visited, st.byType[1].signed, st.byType[1].signedAmount].join(','),
  '1,1,1,2000.25');
eq('byType[其他] = (1,0,0,0)',
  [st.byType[2].total, st.byType[2].visited, st.byType[2].signed, st.byType[2].signedAmount].join(','),
  '1,0,0,0');

/* V-G2 核心 1：给每行加 intent_level / stop_resources 脏字段，输出逐字不变 */
const dirtyStatsRows = fx.customerStatsRows().map(function (r) {
  r.intent_level = '高';
  r.stop_resources = [{ id: 999, stu_name: '结停课串线' }];
  return r;
});
eq('V-G2：行上带 intent_level + stop_resources，输出 JSON 与基线完全一致',
  JSON.stringify(CC.customerStats(dirtyStatsRows, null)), JSON.stringify(st));
/* V-G2 核心 2：两批数据唯一差别是 intent_level 值，输出一致（统计根本不看该列） */
const withHigh = fx.customerStatsRows().map(function (r) { r.intent_level = '高'; return r; });
const withLow = fx.customerStatsRows().map(function (r) { r.intent_level = '低'; return r; });
eq('V-G2：intent_level 全「高」vs 全「低」输出一致',
  JSON.stringify(CC.customerStats(withHigh, null)), JSON.stringify(CC.customerStats(withLow, null)));
eq('V-G2：intent_level 全「高」输出仍等于基线',
  JSON.stringify(CC.customerStats(withHigh, null)), JSON.stringify(st));
/* 签名未变：多余第 3 参数被忽略 */
eq('V-G2：多传第 3 参数不改变输出（签名未扩展）',
  JSON.stringify(CC.customerStats(fx.customerStatsRows(), null, { intent_level: '高' })), JSON.stringify(st));
/* range 口径不回归 */
const stJan = CC.customerStats(fx.customerStatsRows(), janRange);
eq('range=2026-01 → total 1', stJan.total, 1);
eq('range=2026-01 → visited 1', stJan.visited, 1);
eq('range=2026-01 → signed 1', stJan.signed, 1);
eq('range=2026-01 → signedAmount 1000.5', stJan.signedAmount, 1000.5);
eq('customerStats(null) 不抛错且 total=0', CC.customerStats(null, null).total, 0);
eq('customerStats([]) → byType 空数组', CC.customerStats([], null).byType.length, 0);

/* =========================================================
 * §4 StopResCore.validate —— V-B2 字段覆盖 / V-C4 隐藏字段不校验 /
 *    V-C5 布尔→时间联动 / OQ-1 A / OQ-3 A
 * ========================================================= */
section('4. StopResCore.validate：两类分别合法、条件必填、软提示');

const rv = function (over) { return SC.validate(Object.assign(fx.validRefundForm(), over || {})); };
const nv = function (over) { return SC.validate(Object.assign(fx.validNonrenewForm(), over || {})); };

const rValid = rv({});
ok('合法退费资源 → ok=true', rValid.ok === true);
eq('合法退费资源 → errors 为空', Object.keys(rValid.errors).length, 0);
ok('合法退费资源 → 返回 {ok,errors,warnings}',
  hasOwn(rValid, 'ok') && hasOwn(rValid, 'errors') && Array.isArray(rValid.warnings));
eq('合法退费资源（过去日期）→ warnings 为空', rValid.warnings.length, 0);

const nValid = nv({});
ok('合法未续费资源 → ok=true', nValid.ok === true);
eq('合法未续费资源 → errors 为空', Object.keys(nValid.errors).length, 0);
eq('合法未续费资源 → warnings 为空', nValid.warnings.length, 0);
ok('V-C4：未续费类型不报「退费金额必填」',
  nValid.errors.refund_amount === undefined &&
  JSON.stringify(nValid.errors).indexOf('退费金额') < 0);
/* V-C4 加强：带全部退费脏值的未续费 form 依然合法且不报任何退费错误 */
const dirtyValidate = SC.validate(fx.dirtyCrossTypeForm());
ok('V-C4：切类型后残留退费脏值的 form → 仍 ok=true', dirtyValidate.ok === true);
eq('V-C4：残留脏值 form 的 errors 为空', Object.keys(dirtyValidate.errors).length, 0);
ok('V-C4：残留脏值 form 不报 refund_* 任何一项',
  fx.REFUND_FIELDS.every(function (k) { return dirtyValidate.errors[k] === undefined; }));
ok('V-C4：未续费显式带 refund_amount=null 不报错', nv({ refund_amount: null }).ok === true);
ok('V-C4：未续费显式带 refund_amount=8888 也不报错（隐藏字段不校验）',
  nv({ refund_amount: 8888 }).ok === true);
ok('V-C4：未续费类型填充退费专属必填项不影响（仍只看未续费两项）',
  nv({ refund_reason: 'x', refund_subjects: 'y', refund_amount: 1 }).ok === true);

/* 基础 8 项恒校验：逐个删除 → 对应 errors 键（对退费 / 未续费两型都验） */
['stu_name', 'phone', 'grade', 'school', 'stop_date', 'resource_type', 'teacher', 'followup_intent']
  .forEach(function (k) {
    const fr = fx.validRefundForm(); delete fr[k];
    ok('退费缺基础字段 ' + k + ' → errors.' + k, hasOwn(SC.validate(fr).errors, k));
    const fn = fx.validNonrenewForm(); delete fn[k];
    ok('未续费缺基础字段 ' + k + ' → errors.' + k, hasOwn(SC.validate(fn).errors, k));
  });
/* 退费专属 3 项必填 */
['refund_amount', 'refund_reason', 'refund_subjects'].forEach(function (k) {
  const f = fx.validRefundForm(); delete f[k];
  ok('退费缺 ' + k + ' → errors.' + k, hasOwn(SC.validate(f).errors, k));
});
eq('退费缺 refund_amount → 文案「请填写退费金额」',
  SC.validate((function () { const f = fx.validRefundForm(); delete f.refund_amount; return f; })()).errors.refund_amount,
  '请填写退费金额');
eq('退费 refund_amount="" → 同样必填',
  rv({ refund_amount: '' }).errors.refund_amount, '请填写退费金额');
/* 未续费专属 2 项必填 */
['nonrenew_reason', 'end_subjects'].forEach(function (k) {
  const f = fx.validNonrenewForm(); delete f[k];
  ok('未续费缺 ' + k + ' → errors.' + k, hasOwn(SC.validate(f).errors, k));
});
eq('未续费缺 nonrenew_reason → 文案', nv({ nonrenew_reason: '' }).errors.nonrenew_reason, '请填写未续费原因');
eq('未续费缺 end_subjects → 文案', nv({ end_subjects: '' }).errors.end_subjects, '请填写结课科目');

/* 非法值 / 文本与金额上限边界 */
eq('phone 格式非法 → errors.phone', rv({ phone: '12345' }).errors.phone, '联系电话必须是 1 开头的 11 位手机号');
eq('phone 为空 → errors.phone', rv({ phone: '' }).errors.phone, '联系电话不能为空');
eq('grade 非枚举 → errors.grade', rv({ grade: '大学一年级' }).errors.grade, '年级不合法');
eq('grade 为空 → errors.grade', rv({ grade: '' }).errors.grade, '请选择年级');
eq('resource_type 非枚举 → errors.resource_type', rv({ resource_type: '转介绍' }).errors.resource_type, '资源类型不合法');
eq('resource_type 为空 → errors.resource_type', rv({ resource_type: '' }).errors.resource_type, '请选择资源类型');
eq('followup_intent 非枚举 → errors.followup_intent',
  rv({ followup_intent: '超高' }).errors.followup_intent, '回流可跟进意向不合法');
eq('followup_intent 合法「低」→ 通过', rv({ followup_intent: '低' }).ok, true);
eq('stop_date 非法 → errors.stop_date', rv({ stop_date: ISO.INVALID }).errors.stop_date, '结停课时间格式不合法');
eq('stop_date 为空 → errors.stop_date', rv({ stop_date: '' }).errors.stop_date, '请选择结停课时间');
eq('refund_amount=0 → 必须大于 0', rv({ refund_amount: 0 }).errors.refund_amount, '退费金额必须大于 0');
eq('refund_amount 负数 → 必须大于 0', rv({ refund_amount: -5 }).errors.refund_amount, '退费金额必须大于 0');
eq('refund_amount>999999 → 超过上限', rv({ refund_amount: 1000000 }).errors.refund_amount, '退费金额不能超过 999999');
eq('refund_amount 非数字 → 必须是数字', rv({ refund_amount: 'abc' }).errors.refund_amount, '退费金额必须是数字');
ok('refund_amount 合法边界 0.01 / 999999 均通过',
  rv({ refund_amount: 0.01 }).ok === true && rv({ refund_amount: 999999 }).ok === true);
ok('refund_amount 接受数字字符串 "3000"', rv({ refund_amount: '3000' }).ok === true);
eq('teacher 超 200 字 → errors.teacher',
  rv({ teacher: new Array(202).join('x') }).errors.teacher, '科目老师不能超过 200 个字');
eq('teacher 空 → errors.teacher', rv({ teacher: '' }).errors.teacher, '请填写科目老师');
eq('refund_reason 超 500 字 → errors.refund_reason',
  rv({ refund_reason: new Array(502).join('x') }).errors.refund_reason, '退费原因不能超过 500 字');
eq('refund_subjects 超 200 字 → errors.refund_subjects',
  rv({ refund_subjects: new Array(202).join('x') }).errors.refund_subjects, '退费科目不能超过 200 字');
eq('nonrenew_reason 超 500 字 → errors.nonrenew_reason',
  nv({ nonrenew_reason: new Array(502).join('x') }).errors.nonrenew_reason, '未续费原因不能超过 500 字');
eq('end_subjects 超 200 字 → errors.end_subjects',
  nv({ end_subjects: new Array(202).join('x') }).errors.end_subjects, '结课科目不能超过 200 字');
eq('stu_name 超 20 字 → errors.stu_name',
  rv({ stu_name: new Array(22).join('x') }).errors.stu_name, '学生姓名不能超过 20 个字');
eq('school 超 40 字 → errors.school',
  rv({ school: new Array(42).join('x') }).errors.school, '学校不能超过 40 个字');

/* V-C5：布尔→时间条件必填 */
ok('V-C5：refund_applied=是 缺 refund_apply_at → 报错',
  hasOwn(rv({ refund_applied: true }).errors, 'refund_apply_at'));
eq('V-C5：refund_applied=是 缺时间 → 文案',
  rv({ refund_applied: true }).errors.refund_apply_at, '已提交退费申请时必须填写退费提交时间');
ok('V-C5：refund_applied=否 不报 refund_apply_at',
  rv({ refund_applied: false, refund_apply_at: null }).errors.refund_apply_at === undefined);
ok('V-C5：refund_arrived=是 缺 refund_arrived_at → 报错',
  hasOwn(rv({ refund_arrived: true }).errors, 'refund_arrived_at'));
eq('V-C5：refund_arrived=是 缺时间 → 文案',
  rv({ refund_arrived: true }).errors.refund_arrived_at, '退费已到账时必须填写退费到账时间');
ok('V-C5：refund_arrived=否 不报 refund_arrived_at',
  rv({ refund_arrived: false, refund_arrived_at: null }).errors.refund_arrived_at === undefined);
ok('V-C5：布尔是 + 时间填好 → 通过',
  rv({ refund_applied: true, refund_apply_at: ISO.APPLY_AT,
       refund_arrived: true, refund_arrived_at: ISO.APPLY_AT }).ok === true);
eq('V-C5：布尔是 + 时间格式非法 → 格式不合法',
  rv({ refund_applied: true, refund_apply_at: ISO.INVALID }).errors.refund_apply_at,
  '退费提交时间格式不合法');
eq('V-C5：布尔是 + 到账时间格式非法 → 格式不合法',
  rv({ refund_arrived: true, refund_arrived_at: ISO.INVALID }).errors.refund_arrived_at,
  '退费到账时间格式不合法');
ok('V-C5：isTrue 兼容 true / 1 / "true" / "t" 四种真值形态驱动条件必填',
  [true, 1, 'true', 't'].every(function (v) { return hasOwn(rv({ refund_applied: v }).errors, 'refund_apply_at'); }));
ok('isTrue 不认中文「是」（与筛选 triState 值域不同，纯函数真实行为）',
  rv({ refund_applied: '是' }).errors.refund_apply_at === undefined);
ok('V-C5：未续费类型完全不校验退费布尔→时间联动',
  nv({ refund_applied: true, refund_arrived: true }).ok === true);
ok('V-C5：未知 resource_type 不进入任何类型专属分支（只报基础错误）',
  SC.validate(Object.assign(fx.validRefundForm(), { resource_type: '未知' })).errors.refund_amount === undefined);

/* OQ-1 A：未来日期只进 warnings，不拦截 */
const futureRes = rv({ stop_date: ISO.FUTURE });
ok('OQ-1 A：未来结停课时间 → ok 仍为 true（不拦截）', futureRes.ok === true);
eq('OQ-1 A：未来结停课时间 → errors 为空', Object.keys(futureRes.errors).length, 0);
ok('OQ-1 A：未来结停课时间 → warnings 含「晚于今天」',
  futureRes.warnings.length >= 1 &&
  futureRes.warnings.some(function (w) { return w.indexOf('晚于今天') >= 0; }));

/* OQ-3 A：到账早于提交只进 warnings，不拦截 */
const earlyRes = rv({
  refund_applied: true, refund_apply_at: ISO.APPLY_AT,
  refund_arrived: true, refund_arrived_at: ISO.ARRIVED_AT
});
ok('OQ-3 A：到账早于提交 → ok 仍为 true', earlyRes.ok === true);
eq('OQ-3 A：到账早于提交 → errors 为空', Object.keys(earlyRes.errors).length, 0);
ok('OQ-3 A：到账早于提交 → warnings 含「早于」',
  earlyRes.warnings.length >= 1 &&
  earlyRes.warnings.some(function (w) { return w.indexOf('早于') >= 0; }));
ok('OQ-3 A：到账不早于提交 → 不产生该 warning',
  rv({ refund_applied: true, refund_apply_at: ISO.ARRIVED_AT,
       refund_arrived: true, refund_arrived_at: ISO.APPLY_AT })
    .warnings.every(function (w) { return w.indexOf('早于') < 0; }));
ok('OQ-3 A：只勾选一个布尔（缺另一个）→ 不产生「早于」warning',
  rv({ refund_applied: true, refund_apply_at: ISO.APPLY_AT,
       refund_arrived: false, refund_arrived_at: ISO.ARRIVED_AT })
    .warnings.every(function (w) { return w.indexOf('早于') < 0; }));
eq('SC.validate(null) 不抛错、返回 ok=false', SC.validate(null).ok, false);

/* =========================================================
 * §5 StopResCore.normalize —— V-C4 pick() 护栏（键必须存在且非 undefined）
 *    V-C5 布尔否 → 时间归 null
 * ========================================================= */
section('5. StopResCore.normalize：按类型归一 + null 键护栏');

/* 退费类型：未续费专属列写 ''，键必须存在 */
const nzRefund = SC.normalize(fx.makeStop({
  resource_type: '退费资源',
  nonrenew_reason: '旧未续费原因', end_subjects: '旧结课科目'
}));
eq('退费类型 → nonrenew_reason === ""', nzRefund.nonrenew_reason, '');
eq('退费类型 → end_subjects === ""', nzRefund.end_subjects, '');
ok('退费类型 → 两个未续费键存在且非 undefined（pick 护栏）',
  hasOwn(nzRefund, 'nonrenew_reason') && nzRefund.nonrenew_reason !== undefined &&
  hasOwn(nzRefund, 'end_subjects') && nzRefund.end_subjects !== undefined);
eq('退费类型 → 当前类型 refund_amount 原值保留', nzRefund.refund_amount, 3000);
eq('退费类型 → 当前类型 refund_reason 原值保留', nzRefund.refund_reason, '课程不合适');

/* V-C5：布尔否 → 对应时间归 null，且键存在 */
const nzBoolNo = SC.normalize(fx.makeStop({
  resource_type: '退费资源',
  refund_applied: false, refund_apply_at: ISO.FEB,
  refund_arrived: false, refund_arrived_at: ISO.MAR
}));
eq('退费 + refund_applied=否 → refund_apply_at === null', nzBoolNo.refund_apply_at, null);
eq('退费 + refund_arrived=否 → refund_arrived_at === null', nzBoolNo.refund_arrived_at, null);
ok('退费 + 布尔否 → 两个时间键存在且非 undefined',
  hasOwn(nzBoolNo, 'refund_apply_at') && nzBoolNo.refund_apply_at !== undefined &&
  hasOwn(nzBoolNo, 'refund_arrived_at') && nzBoolNo.refund_arrived_at !== undefined);
const nzBoolYes = SC.normalize(fx.makeStop({
  resource_type: '退费资源',
  refund_applied: true, refund_apply_at: ISO.FEB,
  refund_arrived: true, refund_arrived_at: ISO.MAR
}));
eq('退费 + refund_applied=是 → refund_apply_at 保留', nzBoolYes.refund_apply_at, ISO.FEB);
eq('退费 + refund_arrived=是 → refund_arrived_at 保留', nzBoolYes.refund_arrived_at, ISO.MAR);
/* 源 form 不含时间键时，布尔否分支也应新建键（不是 undefined） */
const nzNoTimeKeys = SC.normalize(Object.assign(fx.validRefundForm(), { refund_applied: false, refund_arrived: false }));
ok('退费 + 源无时间键 + 布尔否 → 两个时间键被新建且为 null',
  hasOwn(nzNoTimeKeys, 'refund_apply_at') && nzNoTimeKeys.refund_apply_at === null &&
  hasOwn(nzNoTimeKeys, 'refund_arrived_at') && nzNoTimeKeys.refund_arrived_at === null);

/* V-C4 关键护栏：未续费类型 → 8 个退费专属列严格写空值，键必须存在且非 undefined */
const dirtyForm = fx.dirtyCrossTypeForm();
const nzNonrenew = SC.normalize(dirtyForm);
const EXPECT_EMPTY = {
  refund_reason: '', refund_subjects: '', refund_amount: null,
  parent_confirmed: false, refund_applied: false, refund_apply_at: null,
  refund_arrived: false, refund_arrived_at: null
};
Object.keys(EXPECT_EMPTY).forEach(function (k) {
  eq('未续费类型 → ' + k + ' === ' + JSON.stringify(EXPECT_EMPTY[k]), nzNonrenew[k], EXPECT_EMPTY[k]);
  ok('未续费类型 → ' + k + ' 键存在且非 undefined（pick 保留 null 的关键护栏）',
    hasOwn(nzNonrenew, k) && nzNonrenew[k] !== undefined);
});
eq('未续费类型 → 8 个退费专属键全部命中',
  fx.REFUND_FIELDS.filter(function (k) { return hasOwn(nzNonrenew, k) && nzNonrenew[k] !== undefined; }).length, 8);
eq('未续费类型 → 当前类型 nonrenew_reason 保留', nzNonrenew.nonrenew_reason, '课时用完');
eq('未续费类型 → 当前类型 end_subjects 保留', nzNonrenew.end_subjects, '数学');
eq('未续费类型 → 基础共用字段 stu_name 保留', nzNonrenew.stu_name, '切换丁');
eq('未续费类型 → 基础共用字段 resource_type 保留', nzNonrenew.resource_type, '未续费资源');
/* db.js pick() 语义护栏：把归一结果喂给真实的列裁剪逻辑等价物，null/false/'' 均须保留 */
function pickLike(row) {
  const out = {};
  Object.keys(row).forEach(function (k) {
    if (k === 'id' || k === 'owner_id' || k === 'owner_name') return;
    if (row[k] === undefined) return;      /* 对齐 js/db.js L128 */
    out[k] = row[k];
  });
  return out;
}
const picked = pickLike(nzNonrenew);
ok('pick() 等价护栏：8 个退费专属列全部落在落库字段里（update 才会清空跨类型脏值）',
  fx.REFUND_FIELDS.every(function (k) { return hasOwn(picked, k); }));
eq('pick() 等价护栏：refund_amount 落库值为 null（不是被剥离）', picked.refund_amount, null);
eq('pick() 等价护栏：parent_confirmed 落库值为 false', picked.parent_confirmed, false);
eq('pick() 等价护栏：refund_apply_at 落库值为 null', picked.refund_apply_at, null);
ok('pick() 等价护栏：归一结果中不存在任何 undefined 值',
  Object.keys(nzNonrenew).every(function (k) { return nzNonrenew[k] !== undefined; }));
/* 端到端 V-C4：归一后提交校验通过、不报退费必填（对齐 module-customers.js L1322-1324 调用顺序） */
const nzThenValidate = SC.validate(nzNonrenew);
ok('V-C4 端到端：normalize(切类型脏值 form) → validate 通过', nzThenValidate.ok === true);
ok('V-C4 端到端：归一后不报任何退费字段错误',
  fx.REFUND_FIELDS.every(function (k) { return nzThenValidate.errors[k] === undefined; }));
/* 归一返回新对象、不改入参 */
ok('normalize 返回新对象（!== 入参）', nzNonrenew !== dirtyForm);
eq('normalize 不改写入参：原 refund_amount 仍是 8888', dirtyForm.refund_amount, 8888);
eq('normalize 不改写入参：原 refund_applied 仍是 true', dirtyForm.refund_applied, true);
eq('normalize 不改写入参：原 refund_reason 仍是旧值', dirtyForm.refund_reason, '旧退费原因');
/* 未知类型：不做归一，纯拷贝 */
const unknownRt = SC.normalize(fx.makeStop({ resource_type: '未知类型', refund_amount: 123 }));
eq('未知 resource_type → 不归一，refund_amount 原样保留', unknownRt.refund_amount, 123);
eq('normalize(undefined) 返回空对象不抛错', Object.keys(SC.normalize(undefined)).length, 0);

/* =========================================================
 * §6 StopResCore.visibleFields —— V-C1 / V-C2 显示矩阵
 * ========================================================= */
section('6. StopResCore.visibleFields：退费 8 / 未续费 2');

const vfR = SC.visibleFields('退费资源');
eq('退费 → show 8 项', vfR.show.length, 8);
eq('退费 → hide 2 项', vfR.hide.length, 2);
ok('退费 → show 恰为 8 个退费专属字段',
  fx.REFUND_FIELDS.every(function (k) { return vfR.show.indexOf(k) >= 0; }) &&
  vfR.show.length === fx.REFUND_FIELDS.length);
ok('退费 → hide 恰为 2 个未续费专属字段',
  fx.NONRENEW_FIELDS.every(function (k) { return vfR.hide.indexOf(k) >= 0; }) &&
  vfR.hide.length === fx.NONRENEW_FIELDS.length);

const vfN = SC.visibleFields('未续费资源');
eq('未续费 → show 2 项', vfN.show.length, 2);
eq('未续费 → hide 8 项', vfN.hide.length, 8);
ok('未续费 → show 恰为 2 个未续费专属字段',
  fx.NONRENEW_FIELDS.every(function (k) { return vfN.show.indexOf(k) >= 0; }) &&
  vfN.show.length === fx.NONRENEW_FIELDS.length);
ok('未续费 → hide 恰为 8 个退费专属字段',
  fx.REFUND_FIELDS.every(function (k) { return vfN.hide.indexOf(k) >= 0; }) &&
  vfN.hide.length === fx.REFUND_FIELDS.length);
ok('两型 show / hide 恰好互补互换',
  vfR.show.join(',') === vfN.hide.join(',') && vfR.hide.join(',') === vfN.show.join(','));
ok('show 与 hide 无交集（退费）',
  vfR.show.every(function (k) { return vfR.hide.indexOf(k) < 0; }));
ok('show 与 hide 无交集（未续费）',
  vfN.show.every(function (k) { return vfN.hide.indexOf(k) < 0; }));
ok('共用 8 字段不出现在 show / hide（只列类型专属）',
  ['stu_name', 'phone', 'grade', 'school', 'stop_date', 'resource_type', 'teacher', 'followup_intent']
    .every(function (k) { return vfR.show.indexOf(k) < 0 && vfR.hide.indexOf(k) < 0; }));
/* slice() 返回新数组，两次调用互不影响 */
const vfR2 = SC.visibleFields('退费资源');
vfR2.show.push('__污染__');
eq('visibleFields 每次返回新数组（slice 副本，不共享状态）', SC.visibleFields('退费资源').show.length, 8);
eq('visibleFields("") 走 else 分支 → 按未续费处理', SC.visibleFields('').show.length, 2);

/* =========================================================
 * §7 StopResCore.localYm —— V-D3 禁 slice(0,7) 口径
 * ========================================================= */
section('7. StopResCore.localYm：UTC 存储 → 本地年月（禁 slice）');

eq('V-D3 核心：边界 ISO 2026-02-28T16:00Z 在 UTC+8 → "2026-03"',
  SC.localYm(ISO.MARCH_BOUNDARY), '2026-03');
eq('V-D3：UI.fromDateInput("2026-03-01") 经 localYm → "2026-03"',
  SC.localYm(UI.fromDateInput('2026-03-01')), '2026-03');
eq('V-D3 反证：slice(0,7) 会错判为 "2026-02"（实现不得采用）',
  ISO.MARCH_BOUNDARY.slice(0, 7), '2026-02');
ok('V-D3：localYm 结果 !== slice 结果（证明用了本地 getter）',
  SC.localYm(ISO.MARCH_BOUNDARY) !== ISO.MARCH_BOUNDARY.slice(0, 7));
eq('stopLocalYm 优先复用 UI.localYm（逐值一致）',
  SC.localYm(ISO.MARCH_BOUNDARY), UI.localYm(ISO.MARCH_BOUNDARY));
eq('2026-02-15T02:00Z（本地 2 月）→ "2026-02"', SC.localYm(ISO.FEB), '2026-02');
eq('2026-01-10T02:00Z（本地 1 月）→ "2026-01"', SC.localYm(ISO.JAN), '2026-01');
eq('2026-03-15T02:00Z（本地 3 月）→ "2026-03"', SC.localYm(ISO.MAR), '2026-03');
eq('2026-04-20T02:00Z（本地 4 月）→ "2026-04"', SC.localYm(ISO.APR), '2026-04');
eq('跨年边界 2025-12-31T16:00Z（本地 2026-01）→ "2026-01"',
  SC.localYm('2025-12-31T16:00:00.000Z'), '2026-01');
eq('空串 → ""', SC.localYm(''), '');
eq('null → ""', SC.localYm(null), '');
eq('undefined → ""', SC.localYm(undefined), '');
eq('非法字符串 → ""', SC.localYm(ISO.INVALID), '');
eq('夹具 boundaryRow().stop_date → "2026-03"', SC.localYm(fx.boundaryRow().stop_date), '2026-03');
ok('所有非空返回均严格 YYYY-MM',
  [ISO.JAN, ISO.FEB, ISO.MAR, ISO.APR, ISO.MARCH_BOUNDARY]
    .every(function (s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(SC.localYm(s)); }));
ok('localYm 与 UI.localYm 在空 / 非法 / 边界值上全部一致',
  ['', null, undefined, ISO.INVALID, ISO.JAN, ISO.MARCH_BOUNDARY]
    .every(function (s) { return SC.localYm(s) === UI.localYm(s); }));

/* =========================================================
 * §8 StopResCore.filterRows —— S-1~S-9 / 全部 AND / 同人多条不去重
 * ========================================================= */
section('8. StopResCore.filterRows：S-1~S-9 全维度 AND');

eq('不填筛选 → 全 6 行', sids({}), '501,502,503,504,505,506');
eq('SC.filterRows(null) → 空数组', SC.filterRows(null, {}).length, 0);

/* S-1 关键字：姓名 / 电话模糊、不分大小写 */
eq('S-1 kw 姓名模糊「张三」→ 2 行（同人多条不去重）', sids({ kw: '张三' }), '501,502');
eq('S-1 kw 姓名不分大小写「ALICE」', sids({ kw: 'ALICE' }), '503');
eq('S-1 kw 姓名不分大小写「bob」', sids({ kw: 'bob' }), '504');
eq('S-1 kw 姓名不分大小写「BOB」', sids({ kw: 'BOB' }), '504');
eq('S-1 kw 姓名不分大小写「dAvE」', sids({ kw: 'dAvE' }), '506');
eq('S-1 kw 电话精确「13700137000」', sids({ kw: '13700137000' }), '503');
eq('S-1 kw 电话模糊子串「13700137」', sids({ kw: '13700137' }), '503');
eq('S-1 kw 电话模糊「13900139」', sids({ kw: '13900139' }), '502');
eq('S-1 kw 无命中「不存在」→ 0 行', sids({ kw: '不存在' }), '');

/* S-2 年级（等值） */
eq('S-2 grade=初一', sids({ grade: '初一' }), '501,505');
eq('S-2 grade=初二', sids({ grade: '初二' }), '502,506');
eq('S-2 grade=高一', sids({ grade: '高一' }), '504');
eq('S-2 grade=不存在 → 0 行', sids({ grade: '不存在' }), '');

/* S-3 学校（模糊、不分大小写） */
eq('S-3 school=第一中学', sids({ school: '第一中学' }), '501,504');
eq('S-3 school 模糊「中学」', sids({ school: '中学' }), '501,502,504');
eq('S-3 school 不分大小写「ALPHA」→ Alpha School / alpha school',
  sids({ school: 'ALPHA' }), '503,505');
eq('S-3 school 不分大小写「SCHOOL」', sids({ school: 'SCHOOL' }), '503,505,506');
eq('S-3 school 无命中', sids({ school: '不存在学校' }), '');

/* S-4 资源类型（等值） */
eq('S-4 resource_type=退费资源', sids({ resource_type: '退费资源' }), '501,503,504,506');
eq('S-4 resource_type=未续费资源', sids({ resource_type: '未续费资源' }), '502,505');
eq('S-4 非法资源类型 → 0 行', sids({ resource_type: '转介绍' }), '');

/* S-5 回流意向（等值） */
eq('S-5 followup_intent=高', sids({ followup_intent: '高' }), '501,504,505');
eq('S-5 followup_intent=中', sids({ followup_intent: '中' }), '502,506');
eq('S-5 followup_intent=低', sids({ followup_intent: '低' }), '503');
eq('S-5 非法回流意向 → 0 行', sids({ followup_intent: '超高' }), '');

/* S-6~S-8 三个退费三态（triState：yes/no/是/否/true/false/1/0/all） */
eq('S-6 parent_confirmed=yes', sids({ parent_confirmed: 'yes' }), '501,504,506');
eq('S-6 parent_confirmed=no', sids({ parent_confirmed: 'no' }), '502,503,505');
eq('S-6 parent_confirmed=是', sids({ parent_confirmed: '是' }), '501,504,506');
eq('S-6 parent_confirmed=否', sids({ parent_confirmed: '否' }), '502,503,505');
eq('S-6 parent_confirmed=all → 不过滤', sids({ parent_confirmed: 'all' }), '501,502,503,504,505,506');
eq('S-6 parent_confirmed=非法值 → 不过滤', sids({ parent_confirmed: 'maybe' }), '501,502,503,504,505,506');
eq('S-7 refund_applied=yes', sids({ refund_applied: 'yes' }), '501,504');
eq('S-7 refund_applied=no', sids({ refund_applied: 'no' }), '502,503,505,506');
eq('S-7 refund_applied=1', sids({ refund_applied: '1' }), '501,504');
eq('S-7 refund_applied=0', sids({ refund_applied: '0' }), '502,503,505,506');
eq('S-8 refund_arrived=yes', sids({ refund_arrived: 'yes' }), '503,504');
eq('S-8 refund_arrived=no', sids({ refund_arrived: 'no' }), '501,502,505,506');
eq('S-8 refund_arrived=true', sids({ refund_arrived: 'true' }), '503,504');
eq('S-8 refund_arrived=false', sids({ refund_arrived: 'false' }), '501,502,505,506');
eq('S-6~S-8 三态组合 AND（pc=yes + ra=yes + rr=no）',
  sids({ parent_confirmed: 'yes', refund_applied: 'yes', refund_arrived: 'no' }), '501');

/* S-9 起月 / 止月（stop_date 本地 YYYY-MM） */
eq('S-9 ym 2026-02..2026-03', sids({ ym_from: '2026-02', ym_to: '2026-03' }), '502,503,504,506');
eq('S-9 V-D3：只筛 2026-03 → 边界行 503 必须命中（禁 slice 口径）',
  sids({ ym_from: '2026-03', ym_to: '2026-03' }), '503,504');
eq('S-9 ym 2026-03..2026-04', sids({ ym_from: '2026-03', ym_to: '2026-04' }), '503,504,505');
eq('S-9 ym 2026-01..2026-01', sids({ ym_from: '2026-01', ym_to: '2026-01' }), '501');
eq('S-9 起>止自动交换（04..01 等价 01..04）',
  sids({ ym_from: '2026-04', ym_to: '2026-01' }), '501,502,503,504,505,506');
eq('S-9 起>止自动交换（03..02 等价 02..03）',
  sids({ ym_from: '2026-03', ym_to: '2026-02' }), '502,503,504,506');
eq('S-9 只填起月（单边界 ≥2026-03）', sids({ ym_from: '2026-03' }), '503,504,505');
eq('S-9 只填止月（单边界 ≤2026-02）', sids({ ym_to: '2026-02' }), '501,502,506');
eq('S-9 只填起月 2026-04', sids({ ym_from: '2026-04' }), '505');
eq('S-9 只填止月 2026-01', sids({ ym_to: '2026-01' }), '501');
eq('S-9 两端都不填 → 全通过', sids({ ym_from: '', ym_to: '' }), '501,502,503,504,505,506');
eq('S-9 区间无命中 2027-01..2027-12', sids({ ym_from: '2027-01', ym_to: '2027-12' }), '');
const ymRows = [
  fx.makeStop({ id: 901, stop_date: '' }),
  fx.makeStop({ id: 902, stop_date: ISO.INVALID }),
  fx.makeStop({ id: 903, stop_date: ISO.MAR })
];
eq('S-9 stop_date 空 / 非法行在月份筛选时被排除',
  sids({ ym_from: '2026-01' }, ymRows), '903');
eq('S-9 不设月份筛选时空 stop_date 行仍通过（不误杀）',
  sids({}, ymRows), '901,902,903');
eq('S-9 夹具 boundaryRow 在 2026-03 单月筛选下命中',
  ids(SC.filterRows([fx.boundaryRow()], { ym_from: '2026-03', ym_to: '2026-03' })), '103');

/* 全部 AND（跨维度） */
eq('AND 全 9 维收缩到单行 501',
  sids({
    kw: '张三', grade: '初一', school: '第一中学', resource_type: '退费资源',
    followup_intent: '高', parent_confirmed: 'yes', refund_applied: 'yes',
    refund_arrived: 'no', ym_from: '2026-01', ym_to: '2026-01'
  }), '501');
eq('AND：退费 + 已到账', sids({ resource_type: '退费资源', refund_arrived: 'yes' }), '503,504');
eq('AND：初一 + ≥2026-03', sids({ grade: '初一', ym_from: '2026-03' }), '505');
eq('AND：未续费 + 高意向 + 否三态',
  sids({ resource_type: '未续费资源', followup_intent: '高', parent_confirmed: 'no' }), '505');
eq('AND 互斥条件 → 0 行',
  sids({ resource_type: '退费资源', grade: '高一', followup_intent: '低' }), '');
eq('AND：关键字与月份同时收窄', sids({ kw: '张三', ym_from: '2026-02', ym_to: '2026-02' }), '502');

/* 同人多条不去重（B-3 / V-E1） */
const sameRows = fx.samePersonRows();
eq('同人多条：不填筛选 → 3 行全在', sids({}, sameRows), '201,202,203');
eq('同人多条：按姓名筛选不去重', sids({ kw: '王小明' }, sameRows), '201,202,203');
eq('同人多条：按电话筛选不去重', sids({ kw: '13800000001' }, sameRows), '201,202,203');
eq('同人多条：跨类型不去重', sids({ resource_type: '退费资源' }, sameRows), '201,203');
eq('同人多条：月份全区间不去重', sids({ ym_from: '2026-01', ym_to: '2026-03' }, sameRows), '201,202,203');
ok('同人多条：每行 id 恰好出现一次（无去重、无丢行）',
  SC.filterRows(sameRows, {}).length === 3 && sids({}, sameRows).split(',').length === 3);

/* 两表筛选互不复用：CustomersCore 的筛选键不该影响 StopRes 结果 */
eq('V-E1：客户表筛选键（intent_level/visited/paid/intended_product）被 StopRes 忽略',
  sids({ intent_level: '高', visited: 'yes', paid: 'yes', intended_product: '一对一' }),
  '501,502,503,504,505,506');
eq('V-E1：StopRes 筛选键（ym_from/refund_applied）不影响 CustomersCore',
  cids({ ym_from: '2026-03', refund_applied: 'yes' }), '401,402,403,404,405,406,407');
const dsStop = fx.stopFilterDataset();
ok('SC.filterRows 返回新数组、不改入参顺序',
  SC.filterRows(dsStop, {}) !== dsStop && ids(dsStop) === '501,502,503,504,505,506');

/* =========================================================
 * §9 StopResCore.sortRows —— OQ-4 A 三级兜底 / V-D6 稳定性
 * ========================================================= */
section('9. StopResCore.sortRows：stop_date↓ → created_at↓ → id↓');

const sortRows = fx.stopSortDataset();
eq('综合数据集三级兜底排序结果', ids(SC.sortRows(sortRows)), '4,3,2,1,5');
eq('V-D6 连续第 2 次结果一致', ids(SC.sortRows(sortRows)), '4,3,2,1,5');
eq('V-D6 连续第 3 次结果一致', ids(SC.sortRows(sortRows)), '4,3,2,1,5');
ok('V-D6：打乱入参顺序后结果仍一致（排序与输入顺序无关）',
  ids(SC.sortRows(sortRows.slice().reverse())) === '4,3,2,1,5');
ok('sortRows 返回新数组、不改入参顺序',
  SC.sortRows(sortRows) !== sortRows && ids(sortRows) === '1,2,3,4,5');
/* 逐级兜底单独验证 */
eq('第 1 级：只差 stop_date → 新日期在前',
  ids(SC.sortRows([
    fx.makeStop({ id: 11, stop_date: ISO.JAN, created_at: ISO.JAN }),
    fx.makeStop({ id: 12, stop_date: ISO.MAR, created_at: ISO.JAN })
  ])), '12,11');
eq('第 2 级：stop_date 相同 → created_at 新的在前',
  ids(SC.sortRows([
    fx.makeStop({ id: 11, stop_date: ISO.MAR, created_at: ISO.JAN }),
    fx.makeStop({ id: 12, stop_date: ISO.MAR, created_at: ISO.MAR })
  ])), '12,11');
eq('第 3 级：stop_date 与 created_at 全同 → id 大的在前',
  ids(SC.sortRows([
    fx.makeStop({ id: 11, stop_date: ISO.MAR, created_at: ISO.MAR }),
    fx.makeStop({ id: 12, stop_date: ISO.MAR, created_at: ISO.MAR })
  ])), '12,11');
eq('第 3 级：id 数字比较（9 < 10）',
  ids(SC.sortRows([
    fx.makeStop({ id: 9, stop_date: ISO.MAR, created_at: ISO.MAR }),
    fx.makeStop({ id: 10, stop_date: ISO.MAR, created_at: ISO.MAR })
  ])), '10,9');
eq('stop_date 非法（归 0）排末尾',
  ids(SC.sortRows([
    fx.makeStop({ id: 11, stop_date: '', created_at: ISO.APR }),
    fx.makeStop({ id: 12, stop_date: ISO.JAN, created_at: ISO.JAN })
  ])), '12,11');
eq('sortRows(null) → 空数组', SC.sortRows(null).length, 0);
eq('sortRows([]) → 空数组', SC.sortRows([]).length, 0);
eq('sortRows 单行 → 原样 1 行', ids(SC.sortRows([fx.makeStop({ id: 77 })])), '77');
eq('V-D6：stop_date / created_at / id 全同的两行连续 3 次不抖动',
  [1, 2, 3].map(function () {
    return ids(SC.sortRows([
      fx.makeStop({ id: 31, stop_date: ISO.MAR, created_at: ISO.MAR }),
      fx.makeStop({ id: 32, stop_date: ISO.MAR, created_at: ISO.MAR })
    ]));
  }).join('|'), '32,31|32,31|32,31');

/* =========================================================
 * §10 V-E1 两表隔离：纯函数不读 App.DB，传什么返回什么
 * ========================================================= */
section('10. V-E1 两表隔离：纯函数不读 App.DB / 不做跨表查询');

const realDB = App.DB;
/* 10.1 往 DB 缓存塞入两张表的数据，纯函数不得从中补行 */
App.DB.cache.customers = [{ id: 9001, stu_name: '串线客户', phone: '10000000000' }];
App.DB.cache.stop_resources = [{ id: 9002, stu_name: '串线资源' }];
try {
  eq('StopResCore.filterRows([], {}) 空入参 → 空数组（不从 App.DB 补行）', SC.filterRows([], {}).length, 0);
  eq('CustomersCore.filterRows([], {}) 空入参 → 空数组', CC.filterRows([], {}).length, 0);
  const passed = fx.stopFilterDataset();
  eq('传什么返回什么：filterRows 结果 ids 恰为入参（不混入 DB 行）',
    ids(SC.filterRows(passed, {})), ids(passed));
  eq('传什么返回什么：sortRows 不增删行（长度不变）', SC.sortRows(passed).length, passed.length);
  ok('传什么返回什么：sortRows 不引入任何 DB 行',
    SC.sortRows(passed).every(function (r) { return r.id !== 9001 && r.id !== 9002; }));
  eq('两表零关联：StopRes 结果不含 customers 表的 9001 行',
    ids(SC.filterRows(fx.samePersonRows(), {})), '201,202,203');
  eq('两表零关联：Customers 结果不含 stop_resources 表的 9002 行',
    ids(CC.filterRows(fx.customerFilterDataset(), {})), '401,402,403,404,405,406,407');
  eq('两表零关联：customerStats 不统计 stop_resources 行',
    CC.customerStats(fx.customerStatsRows(), null).total, 4);
  const nzIsolated = SC.normalize(fx.dirtyCrossTypeForm());
  ok('两表零关联：normalize 输出键全部来自入参或归一写入（无 DB 注入）',
    Object.keys(nzIsolated).every(function (k) {
      return hasOwn(fx.dirtyCrossTypeForm(), k) ||
        fx.REFUND_FIELDS.indexOf(k) >= 0 || fx.NONRENEW_FIELDS.indexOf(k) >= 0;
    }));
} finally {
  delete App.DB.cache.customers;
  delete App.DB.cache.stop_resources;
}

/* 10.2 把 App.DB / Perm / Modal / Toast / render / Store / Sync 全部换成「调用即抛错」的毒桩，
 *      9 个纯函数仍须正常返回 —— 直接证明它们一个都不读 App.* 运行时状态。 */
const boom = function () { throw new Error('纯函数不应访问 App.* 运行时状态'); };
const poison = {
  table: boom, cache: {}, defs: {}, list: boom, refreshAll: boom, init: boom,
  denied: boom, forbiddenCard: boom, assertWrite: boom, open: boom, close: boom
};
const saved = {
  DB: App.DB, Perm: App.Perm, Modal: App.Modal, Toast: App.Toast, render: App.render,
  Store: App.Store, Sync: App.Sync, registerModule: App.registerModule
};
Object.keys(saved).forEach(function (k) {
  App[k] = (typeof saved[k] === 'function') ? boom : poison;
});
try {
  const probes = [
    ['CustomersCore.validate', function () { return CC.validate(fx.validCustomerForm()); }],
    ['CustomersCore.filterRows', function () { return CC.filterRows(fx.customerFilterDataset(), { intent_level: '__blank__' }); }],
    ['CustomersCore.customerStats', function () { return CC.customerStats(fx.customerStatsRows(), null); }],
    ['StopResCore.validate', function () { return SC.validate(fx.validRefundForm()); }],
    ['StopResCore.filterRows', function () { return SC.filterRows(fx.stopFilterDataset(), { ym_from: '2026-03' }); }],
    ['StopResCore.normalize', function () { return SC.normalize(fx.dirtyCrossTypeForm()); }],
    ['StopResCore.visibleFields', function () { return SC.visibleFields('退费资源'); }],
    ['StopResCore.localYm', function () { return SC.localYm(ISO.MARCH_BOUNDARY); }],
    ['StopResCore.sortRows', function () { return SC.sortRows(fx.stopSortDataset()); }]
  ];
  probes.forEach(function (p) {
    let threw = null, val;
    try { val = p[1](); } catch (e) { threw = e; }
    ok('V-E1：毒化 App.* 后 ' + p[0] + ' 仍正常返回（证明零读库 / 零权限 / 零渲染依赖）',
      threw === null && val !== undefined, threw ? threw.message : '');
  });
  eq('V-E1：毒桩下 localYm 边界值仍为 2026-03', SC.localYm(ISO.MARCH_BOUNDARY), '2026-03');
  eq('V-E1：毒桩下 customerStats 仍为 total 4', CC.customerStats(fx.customerStatsRows(), null).total, 4);
} finally {
  Object.keys(saved).forEach(function (k) { App[k] = saved[k]; });
}
ok('V-E1：毒桩已还原（App.DB 恢复为真实对象）', App.DB === realDB && typeof App.DB.table === 'function');

/* ---------------- 汇总 ---------------- */
console.log('\n============================');
if (FAILS.length) {
  console.log('失败明细：');
  FAILS.forEach(function (f) { console.log('  - ' + f); });
}
console.log('=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
