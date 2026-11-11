/* =========================================================
 * tools/smoke-v2-customer-task.js —— 客户管理 + 日常工作 冒烟测试
 * 运行：node tools/smoke-v2-customer-task.js
 *
 * 沙箱口径与 tools/smoke-perm.js 一致：
 *   core.js → db.js → perm.js → ui-kit.js → module-customers.js → module-tasks.js
 *   （Node vm 沙箱 + 最小 DOM 桩 + 假 App.Sync）
 * 只测纯函数（App.CustomersCore / App.TasksCore）与 L3 渲染拦截，
 * 不开弹窗（Modal 桩不支持 .body 查询），不触云端。
 * ========================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js');

/* ---------------- 断言框架 ---------------- */
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

/* ---------------- 最小 DOM 桩件（与 smoke-perm 相同） ---------------- */
function makeEl(id) {
  return {
    id: id || '',
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
    addEventListener() { },
    removeEventListener() { },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() { },
    insertBefore() { },
    remove() { },
    setAttribute() { },
    getAttribute() { return null; },
    hasAttribute() { return false; },
    click() { },
    focus() { }
  };
}

function makeSandbox() {
  const els = {};
  const listeners = { document: {}, window: {} };
  const document = {
    getElementById(id) {
      if (!els[id]) els[id] = makeEl(id);
      return els[id];
    },
    createElement() { return makeEl(''); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) {
      (listeners.document[type] = listeners.document[type] || []).push(fn);
    },
    body: { appendChild() { } }
  };
  const sb = {
    console,
    document,
    els,
    listeners,
    localStorage: { getItem() { return null; }, setItem() { }, removeItem() { } },
    setTimeout,
    clearTimeout,
    addEventListener(type, fn) {
      (listeners.window[type] = listeners.window[type] || []).push(fn);
    },
    location: { hash: '' }
  };
  sb.window = sb;
  vm.createContext(sb);
  return sb;
}

/* ---------------- 搭建沙箱 ---------------- */
const sb = makeSandbox();
const LOAD = ['core.js', 'db.js', 'perm.js', 'ui-kit.js', 'module-customers.js', 'module-tasks.js'];
LOAD.forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sb, { filename: f });
});

const App = sb.App;
App.Store.init();
App.Toast = function () { };   /* 静音 toast（不依赖 DOM 桩细节） */

const UI = App.UI, CC = App.CustomersCore, TC = App.TasksCore;

/* 基准时刻：2026-11-11（周三）12:00 本地时间 */
const NOW = new Date(2026, 10, 11, 12, 0, 0, 0);

/** y/m/d（m 从 1 起）→ ISO 时间戳（本地时区构造，跨时区稳定） */
function ts(y, m, d, h, mi) {
  return new Date(y, m - 1, d, h || 10, mi || 0, 0, 0).toISOString();
}

/* =========================================================
 * 0. 模块注册与 L3 直达拦截
 * ========================================================= */
console.log('\n=== 0. 模块注册与 L3 直达拦截 ===');
function findMod(id) { return App.modules.filter(function (m) { return m.id === id; })[0]; }
ok('customers 模块已注册且 adminOnly', !!findMod('customers') && findMod('customers').adminOnly === true);
eq('customers 的 order = 30', findMod('customers').order, 30);
ok('tasks 模块已注册且 adminOnly', !!findMod('tasks') && findMod('tasks').adminOnly === true);
eq('tasks 的 order = 40', findMod('tasks').order, 40);

function fakeSync(role) {
  return {
    state: { signedIn: true, profile: {} },
    isAdmin() { return role === 'admin'; },
    canEdit() { return role === 'admin'; },
    me() { return role === 'admin' ? '管理员' : '张老师'; }
  };
}

App.Sync = fakeSync('teacher');
const t403a = findMod('customers').render.call(findMod('customers'));
ok('教师直达客户管理 → 403 卡片', t403a.indexOf('该模块仅对管理员开放') >= 0);
ok('403 卡片含统一尾句', t403a.indexOf('如需使用请联系系统管理员') >= 0);
const t403b = findMod('tasks').render.call(findMod('tasks'));
ok('教师直达日常工作 → 403 卡片', t403b.indexOf('该模块仅对管理员开放') >= 0);

App.Sync = fakeSync('admin');
const cHtml = findMod('customers').render.call(findMod('customers'));
ok('管理员渲染客户列表含「新增客户」', cHtml.indexOf('新增客户') >= 0);
ok('客户模块 render 首行 L3 自检（源码护栏）',
  /denied\(this\)[\s\S]{0,80}forbiddenCard\(this\)/.test(fs.readFileSync(path.join(SRC, 'module-customers.js'), 'utf8')));
ok('任务模块 render 首行 L3 自检（源码护栏）',
  /denied\(this\)[\s\S]{0,80}forbiddenCard\(this\)/.test(fs.readFileSync(path.join(SRC, 'module-tasks.js'), 'utf8')));
const kHtml = findMod('tasks').render.call(findMod('tasks'));
ok('管理员渲染待办看板含「新增待办」', kHtml.indexOf('新增待办') >= 0);

/* =========================================================
 * 1. 客户校验：电话（客户场景强制 11 位手机）
 * ========================================================= */
console.log('\n=== 1. 客户校验 · 电话 ===');
function baseForm() {
  return {
    stu_name: '张小明', school: '实验中学', phone: '13800138000', grade: '高一',
    resource_type: '上门咨询', created_at: ts(2026, 11, 1, 9),
    intended_product: '一对一', intended_subjects: ['数学', '英语'],
    appointment_at: null, visited: false, visit_at: null,
    test_status: '未测评', suggested_class_type: '',
    paid: false, paid_at: null, paid_amount: null, yellow_form: false,
    referral_name: '', referral_grade: '', referral_amount: 0, referral_claimed: false,
    note_makeup: '', note_progress: '', note_relation: '',
    note_scores: '', note_schedule: '', note_other: ''
  };
}

eq('合法表单通过（13800138000）', CC.validate(baseForm()).ok, true);
const f2 = baseForm(); f2.phone = '1234567';
ok('电话 1234567 被拒', CC.validate(f2).ok === false && !!CC.validate(f2).errors.phone);
const f3 = baseForm(); f3.phone = '0755-12345678';
ok('电话 0755-12345678 被拒（座机不允许）', CC.validate(f3).ok === false && !!CC.validate(f3).errors.phone);
const f4 = baseForm(); f4.phone = '';
ok('电话为空被拒', CC.validate(f4).ok === false && !!CC.validate(f4).errors.phone);

/* =========================================================
 * 2. 客户校验：条件字段联动
 * ========================================================= */
console.log('\n=== 2. 客户校验 · 条件字段联动 ===');
const g1 = baseForm(); g1.visited = false; g1.visit_at = ts(2026, 11, 5, 14);
const r1 = CC.validate(g1);
eq('visited=false 有 visit_at → 校验通过', r1.ok, true);
eq('visited=false → visit_at 被自动清空', g1.visit_at, null);

const g2 = baseForm(); g2.visited = true; g2.visit_at = null;
const r2 = CC.validate(g2);
ok('visited=true 无 visit_at → 拒', r2.ok === false && !!r2.errors.visit_at);

const g3 = baseForm(); g3.visited = true; g3.visit_at = ts(2026, 10, 20, 10);  // 早于 created_at(11-01)
const r3 = CC.validate(g3);
ok('visit_at 早于 created_at → 拒', r3.ok === false && !!r3.errors.visit_at);

const g4 = baseForm(); g4.paid = true; g4.paid_at = ts(2026, 11, 6, 15); g4.paid_amount = null;
const r4 = CC.validate(g4);
ok('paid=true 无 paid_amount → 拒（红字定位金额）', r4.ok === false && !!r4.errors.paid_amount);
const g5 = baseForm(); g5.paid = true; g5.paid_at = ts(2026, 11, 6, 15); g5.paid_amount = 0;
ok('paid_amount = 0 → 拒', CC.validate(g5).ok === false);
const g6 = baseForm(); g6.paid = true; g6.paid_at = ts(2026, 11, 6, 15); g6.paid_amount = 12000.5;
eq('paid_amount = 12000.5 → 通', CC.validate(g6).ok, true);
const g7 = baseForm(); g7.paid = true; g7.paid_at = ts(2026, 11, 6, 15); g7.paid_amount = 1000000;
ok('paid_amount > 999999 → 拒', CC.validate(g7).ok === false);
const g8 = baseForm(); g8.paid = false; g8.paid_at = ts(2026, 11, 6, 15); g8.paid_amount = 100;
CC.validate(g8);
eq('paid=false → paid_at 自动置空', g8.paid_at, null);
eq('paid=false → paid_amount 自动置空', g8.paid_amount, null);

const g9 = baseForm(); g9.resource_type = '转介绍'; g9.referral_name = '';
ok('转介绍无 referrer_name → 拒', CC.validate(g9).ok === false && !!CC.validate(g9).errors.referral_name);
const g10 = baseForm(); g10.resource_type = '上门咨询'; g10.referral_name = '';
eq('非转介绍不要求 referrer_name', CC.validate(g10).ok, true);

const g11 = baseForm(); g11.stu_name = new Array(21 + 1).join('张');
ok('姓名 21 字 → 拒', CC.validate(g11).ok === false);
const g12 = baseForm(); g12.school = new Array(41 + 1).join('校');
ok('学校 41 字 → 拒', CC.validate(g12).ok === false);
const g13 = baseForm(); g13.intended_subjects = [];
ok('意向科目空 → 拒', CC.validate(g13).ok === false);
const g14 = baseForm(); g14.note_makeup = new Array(501 + 1).join('备');
ok('备注 501 字 → 拒', CC.validate(g14).ok === false && !!CC.validate(g14).errors.note_makeup);

/* =========================================================
 * 3. 客户统计：周期归属分字段验证（created_at / visit_at / paid_at 不可混用）
 * ========================================================= */
console.log('\n=== 3. 客户统计 · 周期归属分字段 ===');
/* 一条记录：created_at 在本月、visit_at 在上月、paid_at 在本月 */
const crossRow = {
  resource_type: '上门咨询',
  created_at: ts(2026, 11, 5, 10),
  visited: true, visit_at: ts(2026, 10, 20, 10),
  paid: true, paid_at: ts(2026, 11, 8, 10), paid_amount: 12000.5
};
const monthRange = UI.periodRange('month', NOW);
const ms1 = CC.customerStats([crossRow], monthRange);
eq('当月：total 含它（created_at ∈ 当月）', ms1.total, 1);
eq('当月：visited 不含它（visit_at ∈ 上月）', ms1.visited, 0);
eq('当月：signed 含它（paid_at ∈ 当月）', ms1.signed, 1);
eq('当月：signedAmount = 12000.5', ms1.signedAmount, 12000.5);

const lastMonthRange = UI.periodRange('month', new Date(2026, 9, 15, 10, 0, 0));
const ms2 = CC.customerStats([crossRow], lastMonthRange);
eq('上月：visited 含它', ms2.visited, 1);
eq('上月：total 不含它（created_at ∈ 本月）', ms2.total, 0);
eq('上月：signed 不含它（paid_at ∈ 本月）', ms2.signed, 0);

/* =========================================================
 * 4. 客户统计：D4 当周场景 + 比率
 * ========================================================= */
console.log('\n=== 4. 客户统计 · 当周场景（D4） ===');
const weekRange = UI.periodRange('week', NOW);   /* 2026-11-09 ~ 2026-11-15 */
function wkRow(i, visited, paid, amount, type) {
  return {
    resource_type: type || (i % 2 ? '上门咨询' : '电话咨询'),
    created_at: ts(2026, 11, 9 + (i % 5), 9 + i),
    visited: visited, visit_at: visited ? ts(2026, 11, 9 + (i % 5), 11) : null,
    paid: paid, paid_at: paid ? ts(2026, 11, 9 + (i % 5), 16) : null,
    paid_amount: paid ? amount : null
  };
}
const wkRows = [];
for (let i = 0; i < 10; i++) {
  const visited = i < 4;                 /* 4 个 visited 且 visit_at 在本周 */
  const paid = i < 3;                     /* 3 个 paid 且 paid_at 在本周 */
  wkRows.push(wkRow(i, visited, paid, [4000, 5000, 3000][i] || 0));
}
const ws = CC.customerStats(wkRows, weekRange);
eq('当周总资源数 = 10', ws.total, 10);
eq('当周上门资源数 = 4', ws.visited, 4);
eq('当周签单学生数 = 3', ws.signed, 3);
eq('当周签单金额 = 12000', ws.signedAmount, 12000);
eq('上门率 40.0%', UI.pctText(ws.visited, ws.total), '40.0%');
eq('签单率 30.0%', UI.pctText(ws.signed, ws.total), '30.0%');
eq('上门签单率 75.0%', UI.pctText(ws.signed, ws.visited), '75.0%');

/* =========================================================
 * 5. byType 自检与分母 0
 * ========================================================= */
console.log('\n=== 5. byType 自检 / 分母 0 ===');
const sumTotal = ws.byType.reduce(function (a, g) { return a + g.total; }, 0);
const sumAmount = ws.byType.reduce(function (a, g) { return a + g.signedAmount; }, 0);
eq('ΣbyType.total === total（D6）', sumTotal, ws.total);
eq('ΣbyType.signedAmount === signedAmount（D6）', sumAmount, ws.signedAmount);
ok('byType 按资源类型分组（2 组）', ws.byType.length === 2 &&
  ws.byType.every(function (g) { return ['上门咨询', '电话咨询'].indexOf(g.type) >= 0; }));

const es = CC.customerStats([], monthRange);
eq('空数组不抛错：total = 0', es.total, 0);
eq('空数组：byType = []', Array.isArray(es.byType) && es.byType.length, 0);
eq('分母 0 → 上门率显示「—」', UI.pctText(es.visited, es.total), '—');
eq('分母 0 → pct 返回 null（渲染层输出 —，禁止 0%/NaN）', UI.pct(0, 0), null);
ok('分母 0 不出现 0% 字面量', UI.pctText(0, 0).indexOf('0%') < 0);

/* =========================================================
 * 6. filterRows
 * ========================================================= */
console.log('\n=== 6. filterRows 筛选 ===');
const fr = wkRows.map(function (r, i) {
  r.stu_name = ['张小明', '李小红', '王小刚'][i % 3];
  r.phone = '1380013800' + i;
  r.grade = '高一';
  r.intended_product = '一对一';
  return r;
});
eq('关键字命中电话', CC.filterRows(fr, { kw: '13800138005' }).length, 1);
ok('关键字命中姓名', CC.filterRows(fr, { kw: '张' }).length === 4);
eq('资源类型筛选', CC.filterRows(fr, { resource_type: '上门咨询' }).length, 5);
eq('是否上门 = yes', CC.filterRows(fr, { visited: 'yes' }).length, 4);
eq('是否缴费 = no', CC.filterRows(fr, { paid: 'no' }).length, 7);
eq('周期筛选（当周 created_at ∈ 区间）', CC.filterRows(fr, {}, weekRange).length, 10);
eq('周期筛选（当月区间同样本全命中）', CC.filterRows(fr, {}, monthRange).length, 10);

/* =========================================================
 * 7. 任务校验
 * ========================================================= */
console.log('\n=== 7. 任务校验 ===');
function taskForm() {
  return { title: '整理月考成绩单', priority: 'mid', due_at: ts(2026, 11, 11, 18), status: 'todo', done_at: null, remark: '' };
}
eq('合法任务通过', TC.validate(taskForm()).ok, true);
const k1 = taskForm(); k1.title = '';
ok('空标题被拒', TC.validate(k1).ok === false);
const k2 = taskForm(); k2.title = new Array(61 + 1).join('题');
ok('标题 61 字被拒', TC.validate(k2).ok === false);
const k3 = taskForm(); k3.due_at = null;
ok('缺预期完成时间被拒', TC.validate(k3).ok === false);
const k4 = taskForm(); k4.priority = '';
const r4k = TC.validate(k4);
eq('优先级空 → 归一为 mid', r4k.ok === true && k4.priority, 'mid');
const k5 = taskForm(); k5.status = 'done'; k5.done_at = ts(2026, 11, 11, 16);
eq('status=done 且有 done_at → 通', TC.validate(k5).ok, true);
const k6 = taskForm(); k6.status = 'done'; k6.done_at = null;
ok('status=done 无 done_at → 拒', TC.validate(k6).ok === false && !!TC.validate(k6).errors.done_at);
const k7 = taskForm(); k7.status = 'todo'; k7.done_at = ts(2026, 11, 11, 16);
TC.validate(k7);
eq('status=todo → done_at 自动清空', k7.done_at, null);
const k8 = taskForm(); k8.remark = new Array(501 + 1).join('备');
ok('备注 501 字被拒', TC.validate(k8).ok === false);

/* =========================================================
 * 8. 看板分组：优先级排序 + 边界
 * ========================================================= */
console.log('\n=== 8. 看板分组 · 排序与边界 ===');
function grp(groups, key) { return groups.filter(function (g) { return g.key === key; })[0] || null; }

/* 优先级排序：同一分组内 高 > 中 > 低，同优先级 due_at 升序 */
const prTasks = [
  { id: 'a', title: '低A', priority: 'low', due_at: ts(2026, 11, 11, 23), status: 'todo' },
  { id: 'b', title: '高B', priority: 'high', due_at: ts(2026, 11, 11, 22), status: 'todo' },
  { id: 'c', title: '中C', priority: 'mid', due_at: ts(2026, 11, 11, 21), status: 'todo' },
  { id: 'd', title: '中D', priority: 'mid', due_at: ts(2026, 11, 11, 20), status: 'todo' },
  { id: 'e', title: '高E', priority: 'high', due_at: ts(2026, 11, 11, 19), status: 'todo' }
];
const gToday = grp(TC.taskGroups(prTasks, NOW), 'today');
ok('今天组存在', !!gToday);
eq('组内排序：高>中>低，同优先级 due_at 升序',
  gToday.items.map(function (t) { return t.id; }).join(','), 'e,b,d,c,a');

/* 分组边界 */
function oneTask(due, status, doneAt) {
  return { id: 'x', title: 'T', priority: 'mid', due_at: due.toISOString(), status: status || 'todo', done_at: doneAt ? doneAt.toISOString() : null };
}
const today2359 = new Date(2026, 10, 11, 23, 59, 0);
const tomorrow000 = new Date(2026, 10, 12, 0, 0, 0);
const sunday = UI.addDays(UI.weekStart(NOW), 6);          /* 本周日 */
const sunday2359 = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 23, 59, 0);
const nextMonday = UI.addDays(UI.weekStart(NOW), 7);      /* 下周一 00:00 */
const yesterday = new Date(2026, 10, 10, 8, 0, 0);
const todayEarly = new Date(2026, 10, 11, 8, 0, 0);       /* 今天早些时候（已过） */

eq('今天 23:59 → 「今天」', grp(TC.taskGroups([oneTask(today2359)], NOW), 'today') !== null, true);
eq('明天 00:00 → 「明天」', grp(TC.taskGroups([oneTask(tomorrow000)], NOW), 'tomorrow') !== null, true);
eq('本周日 23:59 → 「本周」', grp(TC.taskGroups([oneTask(sunday2359)], NOW), 'week') !== null, true);
ok('下周一 → 「以后」', grp(TC.taskGroups([oneTask(nextMonday)], NOW), 'later') !== null &&
  grp(TC.taskGroups([oneTask(nextMonday)], NOW), 'week') === null);
eq('todo 且 due_at 已过（昨天）→ 「已逾期」', grp(TC.taskGroups([oneTask(yesterday)], NOW), 'overdue') !== null, true);
eq('todo 且今天早于 now → 「已逾期」（不计入今天）', grp(TC.taskGroups([oneTask(todayEarly)], NOW), 'overdue') !== null, true);
ok('已逾期组不在「今天」', grp(TC.taskGroups([oneTask(yesterday)], NOW), 'today') === null);
const doneG = grp(TC.taskGroups([oneTask(today2359, 'done', NOW)], NOW), 'done');
ok('done 任务 → 「已完成」', doneG !== null && doneG.items.length === 1);

/* 已完成组按 done_at 降序 */
const doneTasks = [
  { id: 'p', title: '早完成', priority: 'mid', due_at: ts(2026, 11, 10, 10), status: 'done', done_at: ts(2026, 11, 10, 12) },
  { id: 'q', title: '晚完成', priority: 'low', due_at: ts(2026, 11, 9, 10), status: 'done', done_at: ts(2026, 11, 11, 9) }
];
const doneGroup = grp(TC.taskGroups(doneTasks, NOW), 'done');
eq('已完成组按 done_at 降序', doneGroup.items.map(function (t) { return t.id; }).join(','), 'q,p');

/* 空分组不渲染 */
const onlyToday = TC.taskGroups([oneTask(today2359)], NOW);
eq('只有「今天」任务 → 仅渲染 1 个分组（空分组不出现）', onlyToday.length, 1);
eq('「已逾期」空分组不出现', grp(onlyToday, 'overdue') === null, true);

/* =========================================================
 * 9. 汇总口径（PRD §6.2）
 * ========================================================= */
console.log('\n=== 9. 汇总口径 · 跨周期完成计入 due_at 所属周期 ===');
/* 3 个任务：本周 1 完成 + 1 未完成 + 上周 due 本周才完成 */
const sumTasks = [
  { title: '本周已完成', priority: 'mid', due_at: ts(2026, 11, 11, 14), status: 'done', done_at: ts(2026, 11, 11, 15) },
  { title: '本周未完成', priority: 'low', due_at: ts(2026, 11, 13, 10), status: 'todo', done_at: null },
  { title: '上周的活本周干完', priority: 'high', due_at: ts(2026, 11, 5, 10), status: 'done', done_at: ts(2026, 11, 10, 9) }
];
const sum = TC.taskSummary(sumTasks, 'week', NOW, 12);
ok('汇总返回 12 个周期', sum.length === 12);
const curWeek = sum[sum.length - 1];                      /* 升序，末位 = 当前周 */
const prevWeek = sum[sum.length - 2];
ok('末位周期为当前周（周一 ' + UI.rangeText({ start: UI.weekStart(NOW), end: UI.weekStart(NOW) }) + '）',
  curWeek.start.getTime() === UI.weekStart(NOW).getTime());
eq('本周 planned = 2', curWeek.planned, 2);
eq('本周 done = 1', curWeek.done, 1);
eq('本周 undone = 1', curWeek.undone, 1);
eq('本周 overdue = 0', curWeek.overdue, 0);
eq('本周完成率 = 50.0%', curWeek.rate, '50.0%');
eq('上周 planned = 1', prevWeek.planned, 1);
eq('上周 done = 1（跨周期完成计入 due_at 所属周期）', prevWeek.done, 1);
eq('上周完成率 = 100.0%', prevWeek.rate, '100.0%');
ok('所有周期完成率都不超过 100%', sum.every(function (r) {
  return r.rate === '—' || parseFloat(r.rate) <= 100;
}));
ok('planned=0 的周期 rate 为「—」而不是 0%', sum.some(function (r) { return r.planned === 0 && r.rate === '—'; }) &&
  sum.every(function (r) { return r.planned > 0 || r.rate === '—'; }));
ok('undone = planned − done（全部周期）', sum.every(function (r) { return r.undone === r.planned - r.done; }));

/* 逾期口径：本周未完成且 due_at < now → 计入 overdue */
const odSum = TC.taskSummary([
  { title: '今天上午到期未完成', priority: 'mid', due_at: ts(2026, 11, 11, 9), status: 'todo' }
], 'day', NOW, 3);
eq('今日行 overdue = 1', odSum[odSum.length - 1].overdue, 1);

/* 月粒度：自然月 */
const moSum = TC.taskSummary(sumTasks, 'month', NOW, 3);
const moNow = moSum[moSum.length - 1];
ok('月粒度末位 = 当前月（标签 2026年11月）', moNow.label === '2026年11月');
eq('11 月 planned = 3（三个任务 due_at 都在 11 月）', moNow.planned, 3);
eq('11 月 done = 2', moNow.done, 2);
ok('10 月 planned = 0 → rate「—」', moSum[moSum.length - 2].planned === 0 && moSum[moSum.length - 2].rate === '—');

/* =========================================================
 * 汇总
 * ========================================================= */
console.log('\n=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===');
if (fail) {
  console.log('\n失败清单：');
  FAILS.forEach(function (f, i) { console.log('  ' + (i + 1) + '. ' + f); });
}
console.log('');
process.exit(fail ? 1 : 0);
