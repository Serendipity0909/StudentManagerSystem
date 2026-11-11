/* =========================================================
 * tools/smoke-db.js —— T7 数据层冒烟测试（node tools/smoke-db.js）
 *
 * 只针对 App.DB（js/db.js）本身，不渲染任何模块：
 *   core.js → db.js，App.Sync 用**可编排的假云端**替换。
 *
 * 假云端刻意复刻 PostgREST 的两个关键行为：
 *   1. 单次 select 受 db-max-rows（1000）限制 —— 用来验证分页；
 *   2. insert 可能「写成功但响应丢失」—— 用来验证重放的幂等回查。
 *
 * 覆盖：
 *   BUG-1 孤儿误删（本轮判定 / 三表闸门 / 主表为空跳过 / 登出复位 / 换号复位）
 *   BUG-2 重放重复插入（客户端 created_at 幂等戳 / 回查命中即跳过 / 首次真失败仍写入）
 *   列差异（class_members 无 updated_at，写它会 42703）
 *   分页（2500 行 / 中途某页失败不覆盖缓存）
 *   retry 队列持久化（按账号落盘 / 重新登录恢复 / 登出不删盘）
 * ========================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js');
const TABLES = ['students', 'classes', 'class_members', 'customers', 'daily_tasks',
  'contract_prices', 'contracts'];

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

/* ---------------- 假 localStorage ---------------- */
function makeStore() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); },
    keys() { return Array.from(m.keys()); }
  };
}

/* ---------------- 最小 DOM 桩件 ---------------- */
function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', style: {},
    classList: { add() { }, remove() { }, toggle() { } },
    addEventListener() { }, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() { }, insertBefore() { }, remove() { }, setAttribute() { },
    getAttribute() { return null; }, click() { }, focus() { }
  };
}

const store = makeStore();
const sandbox = {
  console,
  localStorage: store,
  document: {
    getElementById() { return makeEl(); },
    createElement() { return makeEl(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() { }
  },
  setTimeout,
  clearTimeout,
  location: { hash: '' }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

['core.js', 'db.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
});

const App = sandbox.App;
const TOASTS = [];
App.Toast = function (msg, kind) { TOASTS.push({ msg, kind }); };
App.render = function () { };
App.Perm = { assertWrite() { return true; }, canEdit() { return true; }, isAdmin() { return true; } };

/* =========================================================
 * 假云端：PostgREST 链式 builder 的最小复刻
 * ========================================================= */
let cloud = null;
let seq = 1000;

function resetCloud() {
  cloud = {
    rows: {}, insertCalls: [], updateCalls: [], deleteCalls: [],
    pageCount: {}, failSelect: {}, failPage: {}, failInsert: {}, loseResponse: {}
  };
  TABLES.forEach(function (t) { cloud.rows[t] = []; });
  seq = 1000;
  return cloud;
}

function matchRow(row, filters) {
  return filters.every(function (f) {
    var v = row[f[0]];
    return String(v === null || v === undefined ? '' : v) === String(f[1]);
  });
}

function pushRow(t, payload) {
  var row = Object.assign({}, payload, { id: ++seq, owner_id: 'u1', owner_name: '管理员' });
  cloud.rows[t].push(row);
  return row;
}

function makeBuilder(table) {
  var st = { table: table, action: 'select', payload: null, filters: [], from: 0, to: null };
  var api = {
    select() { return api; },
    insert(p) { st.action = 'insert'; st.payload = p || {}; return api; },
    update(p) { st.action = 'update'; st.payload = p || {}; return api; },
    delete() { st.action = 'delete'; return api; },
    eq(col, val) { st.filters.push([col, val]); return api; },
    range(from, to) { st.from = from; st.to = to; return api; },
    then(res, rej) { return Promise.resolve().then(function () { return exec(st); }).then(res, rej); }
  };
  return api;
}

function exec(st) {
  var t = st.table;

  if (st.action === 'select') {
    cloud.pageCount[t] = (cloud.pageCount[t] || 0) + 1;
    var page = cloud.pageCount[t];
    if (st.filters.some(function (f) { return f[0] === 'created_at' || f[0] === 'joined_at'; })) {
      cloud.probeCount = (cloud.probeCount || 0) + 1;
    }
    if (cloud.failSelect[t]) return { error: { code: 'DATABASE_ERROR', message: 'select failed' } };
    if (cloud.failPage[t] && page >= cloud.failPage[t]) {
      return { error: { code: 'DATABASE_ERROR', message: 'page ' + page + ' failed' } };
    }
    var rows = (cloud.rows[t] || []).filter(function (r) { return matchRow(r, st.filters); });
    var from = st.from || 0;
    var to = (st.to === null || st.to === undefined) ? rows.length : st.to;
    return { data: rows.slice(from, to + 1).map(function (r) { return Object.assign({}, r); }) };
  }

  if (st.action === 'insert') {
    cloud.insertCalls.push({ table: t, payload: Object.assign({}, st.payload) });
    if (cloud.loseResponse[t]) {           // 真写进去了，只是回执丢了
      pushRow(t, st.payload);
      return { error: { code: 'DATABASE_ERROR', message: 'socket hang up' } };
    }
    if (cloud.failInsert[t]) return { error: { code: 'DATABASE_ERROR', message: 'insert failed' } };
    var row = pushRow(t, st.payload);
    return { data: [Object.assign({}, row)] };
  }

  if (st.action === 'update') {
    cloud.updateCalls.push({ table: t, filters: st.filters.slice(), payload: Object.assign({}, st.payload) });
    var hit = (cloud.rows[t] || []).filter(function (r) { return matchRow(r, st.filters); })[0];
    if (!hit) return { data: [] };
    Object.assign(hit, st.payload);
    return { data: [Object.assign({}, hit)] };
  }

  cloud.deleteCalls.push({ table: t, filters: st.filters.slice() });
  var idx = (cloud.rows[t] || []).findIndex(function (r) { return matchRow(r, st.filters); });
  if (idx >= 0) cloud.rows[t].splice(idx, 1);
  return { data: [] };
}

const gateway = { from(t) { return makeBuilder(t); } };

/* 可切换账号的假 App.Sync（换号测试用） */
let phone = '18700000001';
App.Sync = {
  state: { signedIn: true, enabled: true, authChecked: true, profile: { role: 'admin', status: 'active' } },
  isAdmin() { return true; },
  canEdit() { return true; },
  canView() { return true; },
  profile() { return { role: 'admin', status: 'active' }; },
  status() { return 'active'; },
  me() { return '管理员'; },
  myPhone() { return phone; },
  needLogin() { return false; },
  db() { return { database: gateway }; },
  on() { }, boot() { }
};

const DB = App.DB;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 每轮重置页计数 / 探针计数（模拟「本轮」的干净起点） */
function newRound() {
  cloud.pageCount = {};
  cloud.probeCount = 0;
  cloud.deleteCalls = [];
  cloud.insertCalls = [];
}

function newAccount(p) {
  phone = p;
  DB.reset();
}

async function insertQuiet(tbl, payload) {
  try { await DB.table(tbl).insert(payload); return null; } catch (e) { return e; }
}

async function main() {
  /* =========================================================
   * 0. 边界：表定义 / 分页常量 / 列声明
   * ========================================================= */
  console.log('\n=== 0. 表定义与边界 ===');
  eq('注册了 7 张表', Object.keys(DB.defs).length, 7);
  ok('score_records 仍未注册（归 sync.js 独占）', DB.defs.score_records === undefined);
  eq('class_members 的幂等戳列是 joined_at', DB.defs.class_members.createdCol, 'joined_at');
  eq('class_members 没有 updated 列', DB.defs.class_members.updatedCol, '');
  eq('students 的幂等戳列是 created_at', DB.defs.students.createdCol, 'created_at');
  ok('分页相关状态不再叫 loaded（旧口径已删除）', DB.loaded === undefined && typeof DB.roundOk === 'object');

  /* =========================================================
   * 1. BUG-1：孤儿清理 —— 三表本轮都成功才动手
   * ========================================================= */
  console.log('\n=== 1. BUG-1 孤儿清理：三表闸门 ===');
  resetCloud();
  newAccount('18700000001');
  cloud.rows.students = [{ id: 1, stu_name: '张三' }];
  cloud.rows.classes = [{ id: 10, class_name: '一班' }];
  cloud.rows.class_members = [
    { id: 100, class_id: 10, student_id: 1 },       // 正常，不能删
    { id: 101, class_id: 10, student_id: 999 },     // 孤儿：学生不存在
    { id: 102, class_id: 88, student_id: 1 }        // 孤儿：班级不存在
  ];
  newRound();
  await DB.refreshAll();
  eq('三表都成功 → 只删真正的孤儿（2 行）', cloud.deleteCalls.length, 2);
  eq('被删的正是 101 / 102',
    cloud.deleteCalls.map(function (d) { return String(d.filters[0][1]); }).sort().join(','), '101,102');
  eq('正常行保留在缓存里', DB.cache.class_members.length, 1);
  ok('本轮三表都标记成功', DB.roundOk.students && DB.roundOk.classes && DB.roundOk.class_members);

  /* --- 1.1 classes 拉取失败：不得清理（QA 复现路径） --- */
  console.log('\n=== 1.1 classes 拉取失败 → 云端删除调用必须为 0 ===');
  cloud.failSelect.classes = true;
  cloud.rows.class_members.push({ id: 103, class_id: 99, student_id: 1 });   // 新桥表行，对端 class 99 不在本轮可见数据里
  newRound();
  await DB.refreshAll();
  eq('classes 拉取失败时不做孤儿清理（云端删除调用 = 0）', cloud.deleteCalls.length, 0);
  ok('roundOk.classes 未置 true', DB.roundOk.classes !== true);
  ok('失败时缓存保持上一轮快照（未被清空）', DB.cache.classes.length === 1);
  /* 这条断言证明「陷阱已就位」：桥表里确实有一行对端班级不在本轮班级快照里，
     旧实现（用「历史上曾经成功过」当授权）必然把它判成孤儿删掉。 */
  ok('陷阱已就位：m103 的对端班级 99 不在本轮班级快照中',
    DB.cache.class_members.some(function (m) { return String(m.class_id) === '99'; }) &&
    !DB.cache.classes.some(function (c) { return String(c.id) === '99'; }));
  cloud.failSelect.classes = false;

  /* --- 1.2 class_members 拉取失败：不得清理 --- */
  console.log('\n=== 1.2 class_members 拉取失败 → 云端删除调用必须为 0 ===');
  cloud.failSelect.class_members = true;
  DB.cache.class_members = [{ id: 104, class_id: 77, student_id: 1 }];       // 缓存里的僵尸行
  newRound();
  await DB.refreshAll();
  eq('class_members 拉取失败时不清理', cloud.deleteCalls.length, 0);
  ok('roundOk.class_members 未置 true', DB.roundOk.class_members !== true);
  cloud.failSelect.class_members = false;

  /* --- 1.3 主表本轮为空：跳过（不做批量删除） --- */
  console.log('\n=== 1.3 主表本轮为空 + 桥表非空 → 跳过 ===');
  resetCloud();
  newAccount('18700000001');
  cloud.rows.students = [];
  cloud.rows.classes = [{ id: 10, class_name: '一班' }];
  cloud.rows.class_members = [{ id: 100, class_id: 10, student_id: 1 }];
  newRound();
  await DB.refreshAll();
  eq('students 本轮 0 行 → 不做任何删除', cloud.deleteCalls.length, 0);
  ok('三表本身都拉成功（是「空」不是「失败」）', DB.roundOk.students && DB.roundOk.classes && DB.roundOk.class_members);

  /* =========================================================
   * 2. BUG-1：登出 / 换号必须复位
   * ========================================================= */
  console.log('\n=== 2. BUG-1 登出与换号复位 ===');
  resetCloud();
  newAccount('18700000001');
  cloud.rows.students = [{ id: 1, stu_name: '张三' }];
  cloud.rows.classes = [{ id: 10, class_name: '一班' }];
  cloud.rows.class_members = [{ id: 100, class_id: 10, student_id: 1 }];
  newRound();
  await DB.refreshAll();
  eq('复位前缓存有 1 名学生', DB.cache.students.length, 1);
  DB.stop();
  eq('登出后 students 缓存清空', DB.cache.students.length, 0);
  eq('登出后 roundOk 清空', Object.keys(DB.roundOk).length, 0);
  eq('登出后内存 retry 队列清空', DB.retry.length, 0);

  /* --- 2.1 换号不复用上一个账号的缓存 --- */
  resetCloud();
  newAccount('18700000001');
  cloud.rows.students = [{ id: 1, stu_name: '张三' }];
  cloud.rows.classes = [{ id: 10, class_name: '一班' }];
  newRound();
  await DB.refreshAll();
  eq('账号 A 看到 1 名学生', DB.cache.students.length, 1);

  phone = '18700000002';                       // 换人登录，未显式 stop
  cloud.rows.students = [{ id: 2, stu_name: '李四' }, { id: 3, stu_name: '王五' }];
  cloud.rows.classes = [{ id: 20, class_name: '二班' }];
  newRound();
  await DB.refreshAll();
  eq('换号后缓存只剩 B 账号的 2 名学生', DB.cache.students.length, 2);
  ok('A 账号的学生没有残留在 B 的缓存里',
    DB.cache.students.every(function (r) { return String(r.stu_name) !== '张三'; }));

  /* =========================================================
   * 3. BUG-2：insert 幂等戳
   * ========================================================= */
  console.log('\n=== 3. BUG-2 insert 的客户端幂等戳 ===');
  resetCloud();
  newAccount('18700000003');
  newRound();
  await DB.refreshAll();
  await DB.table('customers').insert({ cust_name: '甲公司' });
  await DB.table('daily_tasks').insert({ title: '回访家长' });
  var payCust = cloud.insertCalls.filter(function (c) { return c.table === 'customers'; })[0].payload;
  var payTask = cloud.insertCalls.filter(function (c) { return c.table === 'daily_tasks'; })[0].payload;
  ok('customers.created_at 由客户端写入且为 ISO 串', ISO_RE.test(String(payCust.created_at)), payCust.created_at);
  ok('daily_tasks.created_at 由客户端写入且为 ISO 串', ISO_RE.test(String(payTask.created_at)), payTask.created_at);

  /* --- 3.1 class_members 不能带 updated_at（实表无此列） --- */
  console.log('\n=== 3.1 class_members 列差异 ===');
  resetCloud();
  newAccount('18700000003');
  newRound();
  await DB.refreshAll();
  await DB.table('class_members').insert({ class_id: 10, student_id: 1, created_by: '管理员' });
  var payMem = cloud.insertCalls.filter(function (c) { return c.table === 'class_members'; })[0].payload;
  ok('不带 updated_at（否则云端 42703）', !('updated_at' in payMem), JSON.stringify(payMem));
  ok('带 joined_at 作为幂等戳', ISO_RE.test(String(payMem.joined_at)), payMem.joined_at);

  /* =========================================================
   * 4. BUG-2：重放不重复插入
   * ========================================================= */
  console.log('\n=== 4. BUG-2 重放幂等 ===');
  resetCloud();
  newAccount('18700000004');
  newRound();
  await DB.refreshAll();
  cloud.loseResponse.customers = true;             // 写入成功，回执丢失
  var e1 = await insertQuiet('customers', { cust_name: '乙公司' });
  ok('首次 insert 抛错（客户端认为失败）', !!e1);
  eq('云端其实已有 1 行', cloud.rows.customers.length, 1);
  eq('失败写入进入 retry 队列', DB.retry.length, 1);
  ok('队列项携带 createdAt', ISO_RE.test(String(DB.retry[0].createdAt)), DB.retry[0].createdAt);

  cloud.loseResponse.customers = false;
  newRound();
  var fails1 = await DB.flushRetry();
  eq('重放没有写出第二行（幂等回查命中）', cloud.rows.customers.length, 1);
  eq('重放无失败', fails1, 0);
  eq('重放队列已清空', DB.retry.length, 0);
  ok('重放前确实按幂等戳回查过', cloud.probeCount >= 1, cloud.probeCount);
  eq('命中行被收编进缓存', DB.cache.customers.length, 1);

  /* --- 4.1 首次 insert 真失败：重放仍必须写入 --- */
  console.log('\n=== 4.1 真失败的重放仍会写入 ===');
  resetCloud();
  newAccount('18700000004');
  newRound();
  await DB.refreshAll();
  cloud.failInsert.daily_tasks = true;
  await insertQuiet('daily_tasks', { title: '真失败' });
  eq('首次写入云端 0 行', cloud.rows.daily_tasks.length, 0);
  eq('进入 retry 队列', DB.retry.length, 1);

  cloud.failInsert.daily_tasks = false;
  newRound();
  await DB.flushRetry();
  eq('重放后云端 1 行', cloud.rows.daily_tasks.length, 1);
  eq('队列清空', DB.retry.length, 0);

  /* =========================================================
   * 5. 建议级 S-1：分页拉取
   * ========================================================= */
  console.log('\n=== 5. S-1 分页拉取（2500 行） ===');
  resetCloud();
  newAccount('18700000005');
  for (var i = 0; i < 2500; i++) cloud.rows.students.push({ id: i + 1, stu_name: 'S' + i });
  cloud.rows.classes = [{ id: 10, class_name: '一班' }];
  newRound();
  await DB.refreshAll();
  eq('2500 行全部进缓存（不再截断到 1000）', DB.cache.students.length, 2500);
  eq('分 3 次请求（1000 / 1000 / 500）', cloud.pageCount.students, 3);
  ok('末行也在（id=2500）', !!DB.cache.students.filter(function (r) { return r.id === 2500; }).length);

  /* --- 5.1 分页中途某页失败：不覆盖缓存 --- */
  console.log('\n=== 5.1 分页中途失败不覆盖缓存 ===');
  var keep = DB.cache.students.length;
  cloud.failPage.students = 2;                     // 第二页开始失败
  newRound();
  await DB.refreshAll();
  eq('拉取失败时缓存维持原样', DB.cache.students.length, keep);
  ok('roundOk.students 未置 true', DB.roundOk.students !== true);

  /* =========================================================
   * 6. 建议级 S-2：retry 队列持久化
   * ========================================================= */
  console.log('\n=== 6. S-2 retry 队列持久化 ===');
  resetCloud();
  store.clear();
  newAccount('18700000006');
  newRound();
  await DB.refreshAll();
  cloud.failInsert.customers = true;
  await insertQuiet('customers', { cust_name: '丙公司' });
  var key = 'smdb.retry.p:18700000006';
  var raw = store.getItem(key);
  ok('队列已按账号落盘', !!raw);
  eq('落盘 1 条', raw ? JSON.parse(raw).length : -1, 1);

  /* --- 6.1 重新登录（内存全丢）后能恢复并重放 --- */
  console.log('\n=== 6.1 重新登录恢复队列 ===');
  DB.reset();                                       // 模拟刷新页面：内存全清，localStorage 还在
  eq('reset 后内存队列为 0', DB.retry.length, 0);
  ok('reset 不动 localStorage', !!store.getItem(key));
  cloud.failInsert.customers = false;
  newRound();
  await DB.refreshAll();                            // syncOwner → loadRetry → flushRetry
  eq('恢复后重放写入云端 1 行', cloud.rows.customers.length, 1);
  eq('重放后内存队列清空', DB.retry.length, 0);
  eq('重放成功后落盘 key 被移除', store.getItem(key), null);

  /* --- 6.2 登出不清盘（换号不串用） --- */
  console.log('\n=== 6.2 登出不清盘 ===');
  cloud.failInsert.customers = true;
  await insertQuiet('customers', { cust_name: '丁公司' });
  ok('再次失败后重新落盘', !!store.getItem(key));
  DB.stop();
  eq('登出后内存队列清空', DB.retry.length, 0);
  ok('登出后盘上队列保留（换号也能各自恢复）', !!store.getItem(key));

  /* =========================================================
   * 7. 回归护栏：App.DB 不得碰 score_records
   * ========================================================= */
  console.log('\n=== 7. 硬边界 ===');
  var threw = false;
  try { DB.define('score_records', {}); } catch (e) { threw = true; }
  ok('注册 score_records 抛错', threw);
  threw = false;
  try { DB.define('user_profiles', {}); } catch (e) { threw = true; }
  ok('注册 user_profiles 抛错', threw);

  /* ---------------- 汇总 ---------------- */
  console.log('\n----------------------------------------');
  console.log('smoke-db: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('失败项：');
    FAILS.forEach(function (f) { console.log('  · ' + f); });
    process.exitCode = 1;
  }
}

main().catch(function (e) {
  console.error('测试运行异常：', e);
  process.exitCode = 1;
});
