/* =========================================================
 * tools/smoke-perm.js —— 权限四层冒烟测试（node tools/smoke-perm.js）
 *
 * 覆盖四层拦截，五种角色/状态组合（T6 权限口径反转后）：
 *   admin（管理员 · active）        —— 成绩管理 + 教务六板块全可用
 *   teacher（教师 · active）        —— 只有成绩管理；教务板块不可见不可达
 *   readonly（教师 · readonly）     —— 可看不可写
 *   blocked（管理员 · blocked）     —— 全部写入被拒
 *   readonlyAdmin（管理员 · readonly）—— T6 新增，验证「管理员也不绕过账号状态」
 *
 * 沙箱口径与浏览器一致：core.js → perm.js → 真实模块（home / score / users）
 *   → app.js（负责 L1 导航 / L2 路由兜底 / L3 直达），App.Sync 用假实现替换。
 * DOM 用最小桩件（只保留 innerHTML / textContent / classList / addEventListener），
 * 因此可以直接断言渲染出来的导航与内容片段。
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

/* ---------------- 最小 DOM 桩件 ---------------- */
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

/* ---------------- 假 App.Sync ---------------- */
function fakeSync(profile) {
  return {
    state: {
      enabled: true, signedIn: true, authChecked: true, syncing: false, online: true,
      lastSyncAt: new Date().toISOString(), lastError: '', profileError: '',
      booted: true, blocked: profile.status === 'blocked', profile: profile
    },
    isAdmin() { return profile.role === 'admin'; },
    canEdit() { return profile.status === 'active'; },
    canView() { return profile.status === 'active' || profile.status === 'readonly'; },
    profile() { return profile; },
    status() { return profile.status; },
    me() { return profile.name; },
    myPhone() { return profile.phone; },
    needLogin() { return false; },
    db() { return null; },
    on() { },
    boot() { },
    syncNow() { },
    markAllDeleted() { },
    listUsers() { return Promise.resolve([]); },
    setUserStatus() { return Promise.resolve(); },
    deleteUser() { return Promise.resolve(); }
  };
}

const ROLES = {
  admin: { role: 'admin', status: 'active', name: '管理员', phone: '18700000001' },
  teacher: { role: 'teacher', status: 'active', name: '张老师', phone: '13900000002' },
  readonly: { role: 'teacher', status: 'readonly', name: '只读老师', phone: '13900000003' },
  blocked: { role: 'admin', status: 'blocked', name: '停用管理员', phone: '18700000004' },
  /* T6 新增：管理员身份 + 只读状态 —— 成绩管理写入必须仍被拒 */
  readonlyAdmin: { role: 'admin', status: 'readonly', name: '只读管理员', phone: '18700000005' }
};

/* ---------------- 搭建沙箱 ---------------- */
const sb = makeSandbox();
const LOAD = ['core.js', 'db.js', 'perm.js', 'ui-kit.js', 'module-home.js', 'module-score.js', 'module-users.js', 'app.js'];
LOAD.forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sb, { filename: f });
});

const App = sb.App;
App.Store.init();

/* 未实现的业务模块：按 ARCH §3.3 的注册字段补桩（T3–T5 会替换为真实模块） */
[
  { id: 'students', name: '学生管理', adminOnly: true, order: 10 },
  { id: 'classes', name: '班级管理', adminOnly: true, order: 20 },
  { id: 'customers', name: '客户管理', adminOnly: true, order: 30 },
  { id: 'tasks', name: '日常工作', adminOnly: true, order: 40 },
  { id: 'contracts', name: '合同确认', adminOnly: true, order: 50 }
].forEach(function (m) {
  App.registerModule({
    id: m.id, name: m.name, icon: '<svg></svg>', ready: true, adminOnly: true, order: m.order,
    title: m.name, subtitle: '桩模块',
    render: function () {
      if (App.Perm.denied(this)) return App.Perm.forbiddenCard(this);
      return '<div class="card" data-stub="' + m.id + '"><h3>' + m.name + '</h3></div>';
    },
    bind: function () { }
  });
});

/* Toast 间谍：记录每条提示，用于断言 L4 的「无操作权限」 */
const TOASTS = [];
App.Toast = function (msg, type) { TOASTS.push({ msg: String(msg), type: type || '' }); };

/* 触发 app.js 的启动流程（只跑一次；里面会 boot / DB.start / render） */
function boot() {
  (sb.listeners.document.DOMContentLoaded || []).forEach(function (fn) { fn(); });
}

/* 切换角色并重绘：等价于「换账号登录后重新加载界面」 */
function setRole(key) {
  App.Sync = fakeSync(ROLES[key]);
  App.render();
}

function nav() { return String(sb.els.nav ? sb.els.nav.innerHTML : ''); }
function content() { return String(sb.els.content ? sb.els.content.innerHTML : ''); }
function title() { return String(sb.els['mod-title'] ? sb.els['mod-title'].textContent : ''); }
function topbarHidden() {
  return ['btn-demo', 'btn-backup', 'btn-restore', 'btn-clear'].every(function (id) {
    var el = sb.els[id];
    return !el || el.style.display === 'none';
  });
}
function fireHash(hash) {
  sb.location.hash = hash;
  (sb.listeners.window.hashchange || []).forEach(function (fn) { fn(); });
}
function lastToast() { return TOASTS.length ? TOASTS[TOASTS.length - 1].msg : ''; }
function findMod(id) { return App.modules.filter(function (m) { return m.id === id; })[0]; }

/* =========================================================
 * 0. 注册字段归一化（core.js registerModule）
 * ========================================================= */
console.log('\n=== 0. registerModule 字段归一化 ===');
ok('score 的 teacherOnly 已移除（不再教师专属）', findMod('score').teacherOnly !== true);
eq('score 的 order', findMod('score').order, 5);
ok('home 注册了 adminOnly', findMod('home').adminOnly === true);
eq('home 的 order', findMod('home').order, 0);
ok('users 注册了 adminOnly', findMod('users').adminOnly === true);
eq('未声明 order 的模块默认 100', findMod('archive').order, 100);
ok('未声明 teacherOnly 的模块默认 false', findMod('students').teacherOnly === false);

/* =========================================================
 * 1. L1 导航隐藏
 * ========================================================= */
console.log('\n=== 1. L1 导航隐藏（navHTML 过滤 + order 排序）===');
App.Sync = fakeSync(ROLES.admin);
boot();
setRole('admin');
const navAdmin = nav();
ok('管理员导航含「成绩管理」', navAdmin.indexOf('data-mod="score"') >= 0);
ok('管理员导航含「概览」', navAdmin.indexOf('data-mod="home"') >= 0);
ok('管理员导航含 学生/班级/客户/日常/合同',
  ['students', 'classes', 'customers', 'tasks', 'contracts'].every(function (id) {
    return navAdmin.indexOf('data-mod="' + id + '"') >= 0;
  }));
ok('管理员导航含「账号管理」', navAdmin.indexOf('data-mod="users"') >= 0);
ok('管理员导航渲染「更多模块（规划中）」', navAdmin.indexOf('更多模块（规划中）') >= 0);
ok('管理员导航顺序 home → score → students → … → users',
  navAdmin.indexOf('data-mod="home"') < navAdmin.indexOf('data-mod="score"') &&
  navAdmin.indexOf('data-mod="score"') < navAdmin.indexOf('data-mod="students"') &&
  navAdmin.indexOf('data-mod="students"') < navAdmin.indexOf('data-mod="users"'));

setRole('teacher');
const navTeacher = nav();
ok('教师导航含「成绩管理」', navTeacher.indexOf('data-mod="score"') >= 0);
ok('教师导航不含「概览」', navTeacher.indexOf('data-mod="home"') < 0);
ok('教师导航不含任何教务模块',
  ['students', 'classes', 'customers', 'tasks', 'contracts', 'users'].every(function (id) {
    return navTeacher.indexOf('data-mod="' + id + '"') < 0;
  }));
ok('教师导航不渲染「规划中」区块', navTeacher.indexOf('更多模块（规划中）') < 0);
eq('教师导航条目数（只有成绩管理一项）',
  (navTeacher.match(/class="nav-item/g) || []).length, 1);

/* =========================================================
 * 2. L2 路由兜底
 * ========================================================= */
console.log('\n=== 2. L2 路由兜底（教师→score，管理员→home）===');
setRole('teacher');
eq('教师落地页 = 成绩管理', title(), '成绩管理');
App.go('students');
eq('教师站内跳到 students → 回退成绩管理', title(), '成绩管理');
ok('回退后内容不是 403 卡片', content().indexOf('该模块仅对管理员开放') < 0);

setRole('admin');
App.go('home');
eq('管理员落地页 = 概览', title(), '概览');
App.go('score');
eq('管理员站内跳到 score → 原地渲染成绩管理（不回退）', title(), '成绩管理');

setRole('teacher');
ok('Perm.allowed：教师可访问 score', App.Perm.allowed(findMod('score')) === true);
ok('Perm.allowed：教师不可访问 students', App.Perm.allowed(findMod('students')) === false);
setRole('admin');
ok('Perm.allowed：管理员可访问 score', App.Perm.allowed(findMod('score')) === true);
ok('Perm.allowed：管理员可访问 students', App.Perm.allowed(findMod('students')) === true);

/* =========================================================
 * 3. L3 直达拦截（403 卡片）
 * ========================================================= */
console.log('\n=== 3. L3 直达拦截（手输 URL → 403 卡片）===');
setRole('teacher');
fireHash('#/students');
const c403teacher = content();
ok('教师直达 #/students → 403 卡片文案', c403teacher.indexOf('该模块仅对管理员开放') >= 0);
ok('403 卡片含统一尾句', c403teacher.indexOf('如需使用请联系系统管理员') >= 0);
ok('403 卡片复用 .card 与 .empty 视觉',
  c403teacher.indexOf('class="card"') >= 0 && c403teacher.indexOf('class="empty"') >= 0);
ok('403 时不渲染学生管理内容', c403teacher.indexOf('data-stub="students"') < 0);
ok('403 后标题仍是学生管理（不静默跳走）', title() === '学生管理');

setRole('admin');
fireHash('#/score');
const cAdminScore = content();
ok('管理员直达 #/score → 正常渲染成绩 Tab（不是 403）',
  cAdminScore.indexOf('成绩录入') >= 0 && cAdminScore.indexOf('该模块仅对') < 0);
ok('管理员直达 #/score 后标题 = 成绩管理', title() === '成绩管理');

/* 已允许的模块直达不受影响 */
setRole('admin');
fireHash('#/students');
ok('管理员直达 #/students 正常渲染', content().indexOf('data-stub="students"') >= 0);
setRole('teacher');
fireHash('#/score');
const cTeacherScore = content();
ok('教师直达 #/score 正常渲染成绩 Tab', cTeacherScore.indexOf('成绩录入') >= 0);
const tabCount = function (html) { return (html.match(/data-tab="/g) || []).length; };
ok('管理员直达 #/score 后 Tab 数量与教师一致',
  tabCount(cAdminScore) === tabCount(cTeacherScore) && tabCount(cTeacherScore) === 4);

/* =========================================================
 * 4. L4 写入校验
 * ========================================================= */
console.log('\n=== 4. L4 写入校验（App.Perm.assertWrite / assertScoreAction）===');
TOASTS.length = 0;
setRole('admin');
ok('管理员写成绩被放行', App.Perm.assertWrite('score') === true);
ok('管理员可新增成绩（assertWrite score 放行，无拒绝提示）',
  App.Perm.assertWrite('score') === true && TOASTS.length === 0);
ok('管理员可删除成绩（assertWrite score 放行，无拒绝提示）',
  App.Perm.assertWrite('score') === true && TOASTS.length === 0);
ok('管理员 score 的 denied() 为 false', App.Perm.denied(findMod('score')) === false);
ok('管理员写教务表被放行', App.Perm.assertWrite('students') === true);

TOASTS.length = 0;
setRole('teacher');
ok('教师写成绩被放行', App.Perm.assertWrite('score') === true);
ok('教师 score 的 denied() 为 false', App.Perm.denied(findMod('score')) === false);
ok('教师写教务表被拒', App.Perm.assertWrite('students') === false);
eq('教师越权提示文案', lastToast(), '无操作权限');

TOASTS.length = 0;
setRole('readonly');
ok('只读教师写成绩被拒', App.Perm.assertWrite('score') === false);
eq('只读提示文案', lastToast(), '无操作权限');
ok('只读账号 canEdit=false', App.Perm.canEdit() === false);

TOASTS.length = 0;
setRole('readonlyAdmin');
ok('只读管理员写成绩被拒', App.Perm.assertWrite('score') === false);
eq('只读管理员提示文案', lastToast(), '无操作权限');

TOASTS.length = 0;
setRole('blocked');
ok('停用管理员写成绩被拒', App.Perm.assertWrite('score') === false);
eq('停用管理员写成绩提示文案', lastToast(), '无操作权限');
ok('停用管理员写教务表被拒', App.Perm.assertWrite('students') === false);
eq('停用账号提示文案', lastToast(), '无操作权限');

console.log('\n=== 5. 顶栏按钮（T8：清空数据限管理员 + 确认词）===');

/* 未注册的模块 id（T3–T5 业务模块尚未加载）必须按「管理员专属」兜底，
   否则教师凭一个未知 id 就能绕过角色校验写业务表 */
TOASTS.length = 0;
setRole('teacher');
ok('教师写未注册模块 id 被拒（兜底为管理员专属）',
  App.Perm.assertWrite('not_yet_registered') === false);
eq('未注册模块越权提示文案', lastToast(), '无操作权限');

/* T8：清空数据的守卫升为 assertAdminWrite（canEdit + isAdmin 双门） */
TOASTS.length = 0;
ok('教师调用 assertAdminWrite(\'score\') 被拒', App.Perm.assertAdminWrite('score') === false);
eq('拒绝提示文案 = 无操作权限', lastToast(), '无操作权限');

setRole('admin');
ok('管理员顶栏 4 个按钮可见', topbarHidden() === false);
TOASTS.length = 0;
ok('管理员调用 assertAdminWrite(\'score\') 放行', App.Perm.assertAdminWrite('score') === true);
ok('管理员 assertScoreAction 放行', App.Perm.assertScoreAction() === true);
eq('管理员 assertScoreAction 不产生拒绝提示', TOASTS.length, 0);
setRole('blocked');
ok('停用管理员顶栏 4 个按钮隐藏', topbarHidden() === true);
ok('停用管理员调用 assertAdminWrite(\'score\') 被拒', App.Perm.assertAdminWrite('score') === false);
setRole('readonlyAdmin');
ok('只读管理员顶栏 4 个按钮隐藏', topbarHidden() === true);
ok('只读管理员调用 assertAdminWrite(\'score\') 被拒', App.Perm.assertAdminWrite('score') === false);
setRole('teacher');
ok('教师顶栏 3 个按钮可见（demo/backup/restore）',
  ['btn-demo', 'btn-backup', 'btn-restore'].every(function (id) {
    var el = sb.els[id];
    return !!el && el.style.display !== 'none';
  }));
ok('教师顶栏「清空数据」隐藏',
  !!sb.els['btn-clear'] && sb.els['btn-clear'].style.display === 'none');
ok('教师 assertScoreAction 放行', App.Perm.assertScoreAction() === true);
setRole('readonly');
ok('只读教师 assertScoreAction 被拒', App.Perm.assertScoreAction() === false);

/* =========================================================
 * 6. 数据层边界（score_records / user_profiles 归 sync.js 独占）
 * ========================================================= */
console.log('\n=== 6. App.DB 边界与注册 ===');
let threw = '';
try { App.DB.define('score_records', {}); } catch (e) { threw = e.message; }
ok('App.DB 拒绝注册 score_records', threw.indexOf('sync.js') >= 0, threw);
threw = '';
try { App.DB.define('user_profiles', {}); } catch (e) { threw = e.message; }
ok('App.DB 拒绝注册 user_profiles', threw.indexOf('sync.js') >= 0, threw);
ok('App.DB 已注册 7 张新表',
  ['students', 'classes', 'class_members', 'customers', 'daily_tasks', 'contract_prices', 'contracts']
    .every(function (n) { return !!App.DB.defs[n]; }));
eq('App.DB 表数量（7 新表，不含成绩/账号）', Object.keys(App.DB.defs).length, 7);
ok('App.DB.table 能取到网关', typeof App.DB.table('students').list === 'function');
eq('未拉取时 list 为空数组', App.DB.table('students').list().length, 0);
eq('App.Sync.db() 存在（sync.js 的唯一侵入点）', typeof App.Sync.db, 'function');

/* =========================================================
 * 7. 源码级护栏（模块内保存入口必须走统一出口）
 * ========================================================= */
console.log('\n=== 7. 保存入口源码护栏 ===');
const scoreSrc = fs.readFileSync(path.join(SRC, 'module-score.js'), 'utf8');
ok('module-score 的 guardEdit 调用 assertWrite(\'score\')',
  /assertWrite\('score'\)/.test(scoreSrc));
ok('module-score render 首行做 L3 自检', /denied\(this\)[\s\S]{0,80}forbiddenCard\(this\)/.test(scoreSrc));
const homeSrc = fs.readFileSync(path.join(SRC, 'module-home.js'), 'utf8');
ok('module-home 做 L3 自检', /denied\(this\)/.test(homeSrc));

/* T8：清空数据的源码护栏（DOM 隐藏 / handler 守卫 / 确认词三道都要在 app.js 源码里） */
const appSrc = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
ok('btn-clear 的显示条件包含 isAdmin',
  /clearVisible = App\.Perm\s*\?\s*\(App\.Perm\.isAdmin\(\) && App\.Perm\.canEdit\(\)\)/.test(appSrc));
ok('btn-clear handler 首行调用 assertAdminWrite',
  /getElementById\('btn-clear'\)\.addEventListener\('click',\s*function \(\) \{[\s\S]{0,300}?assertAdminWrite\('score'\)/.test(appSrc));
ok('清空流程存在确认词输入校验（比对 \'清空\'）',
  /confirm-word/.test(appSrc) &&
  /String\(input\.value \|\| ''\)\.trim\(\)/.test(appSrc) &&
  /word !== '清空'/.test(appSrc));
setRole('admin');
App.go('home');
const homeHtml = content();
ok('管理员概览不出现成绩 KPI（成绩记录总数 / 学生人数/考试场次 等）',
  homeHtml.indexOf('成绩记录总数') < 0 && homeHtml.indexOf('考试场次') < 0);
ok('管理员概览不出现「最近录入」表', homeHtml.indexOf('最近录入') < 0);
ok('管理员概览不出现成绩快捷录入按钮',
  homeHtml.indexOf('打开成绩录入窗体') < 0 && homeHtml.indexOf('查看成绩总表') < 0);
ok('管理员概览出现教务模块入口',
  ['students', 'classes', 'customers', 'tasks', 'contracts'].every(function (id) {
    return homeHtml.indexOf('data-goto="' + id + '"') >= 0;
  }));
ok('管理员概览出现同步状态', homeHtml.indexOf('同步状态') >= 0);

/* =========================================================
 * 8. 导航排序比较器：严格反对称（T7 · S-5）
 *
 * 旧实现 `if (a.home) return -1;` 在 a、b 都是 home 时也返回 -1，
 * cmp(a,b) 与 cmp(b,a) 同时为 -1 —— 排序结果依赖引擎比较顺序，不可复现。
 * ========================================================= */
console.log('\n=== 8. 导航排序比较器反对称（S-5）===');
setRole('admin');
ok('App.navCompare 已暴露给测试', typeof App.navCompare === 'function');

const cmp = App.navCompare;
const allMods = App.modules.slice();
let asym = [];
for (let i = 0; i < allMods.length; i++) {
  for (let j = 0; j < allMods.length; j++) {
    const x = Math.sign(cmp(allMods[i], allMods[j]));
    const y = Math.sign(cmp(allMods[j], allMods[i]));
    if (x !== -y) asym.push(allMods[i].id + '×' + allMods[j].id);
  }
}
eq('所有已注册模块两两比较严格反对称', asym.length, 0);

const homeA = { id: 'hx-a', home: true, order: 1, ready: true };
const homeB = { id: 'hx-b', home: true, order: 1, ready: true };
ok('两个 home 模块比较严格反对称（旧实现两边都给 -1）',
  cmp(homeA, homeB) === -cmp(homeB, homeA),
  cmp(homeA, homeB) + ' / ' + cmp(homeB, homeA));
eq('同 home 同 order 时按 id 字典序兜底（可复现）', Math.sign(cmp(homeA, homeB)), -1);

const idsInOrder = (list) => list.slice().sort(cmp).map((m) => m.id).join(',');
eq('反转初序后导航顺序一致（结果可复现）',
  idsInOrder(allMods.slice().reverse()), idsInOrder(allMods));
eq('打乱初序后导航顺序仍一致',
  idsInOrder(allMods.slice().sort(() => 0.5 - Math.random())), idsInOrder(allMods));

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
