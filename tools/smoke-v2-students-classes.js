/* =========================================================
 * tools/smoke-v2-students-classes.js —— T3 冒烟测试
 *   node tools/smoke-v2-students-classes.js
 *
 * 沙箱口径与浏览器一致（IIFE + window.App）：
 *   core.js → db.js → perm.js → ui-kit.js → analysis.js → study-plan.js
 *   → module-students.js → module-classes.js
 * App.Sync 用假实现；App.DB.cache 直接塞假数据（渲染层只读缓存）。
 *
 * 覆盖：学生表单校验 / 业务键查重 / 六维筛选 / KPI / 改姓名·学校的成绩影响计数 /
 *       班级表单校验与重名 / classScoreAnalysis（弱关联、同考试取最新、动态满分、
 *       未匹配单列、空班不报错）/ App.DB 边界（不得访问 score_records）。
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
function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', style: {},
    classList: { add() { }, remove() { }, toggle() { } },
    addEventListener() { }, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() { }, insertBefore() { }, remove() { }, setAttribute() { },
    getAttribute() { return null; }, click() { }, focus() { }, setSelectionRange() { }
  };
}

const sandbox = {
  console,
  localStorage: { getItem() { return null; }, setItem() { }, removeItem() { } },
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

['core.js', 'db.js', 'perm.js', 'ui-kit.js', 'analysis.js', 'study-plan.js',
  'module-students.js', 'module-classes.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
});

const App = sandbox.App;
App.Store.init();

/* 假 App.Sync：管理员 + 可写（模块里的 App.Perm 守卫才会放行） */
const PROFILE = { role: 'admin', status: 'active', name: '管理员', phone: '18700000001' };
App.Sync = {
  state: { signedIn: true, enabled: true, authChecked: true, profile: PROFILE, lastSyncAt: new Date().toISOString() },
  isAdmin: () => true,
  canEdit: () => true,
  canView: () => true,
  profile: () => PROFILE,
  status: () => 'active',
  me: () => '管理员',
  myPhone: () => PROFILE.phone,
  needLogin: () => false,
  db: () => null,
  on() { }, boot() { }
};
App.Toast = function () { };
App.render = function () { };

const Stud = App.StudentsCore;
const Cls = App.ClassesCore;
const Score = App.Score;
const UI = App.UI;

/* =========================================================
 * 0. 模块注册与命名空间
 * ========================================================= */
console.log('\n=== 0. 模块注册 / 纯函数外露 ===');
const modStudents = App.modules.filter(function (m) { return m.id === 'students'; })[0];
const modClasses = App.modules.filter(function (m) { return m.id === 'classes'; })[0];
ok('students 模块已注册且 adminOnly', !!modStudents && modStudents.adminOnly === true);
eq('students 的 order', modStudents.order, 10);
ok('classes 模块已注册且 adminOnly', !!modClasses && modClasses.adminOnly === true);
eq('classes 的 order', modClasses.order, 20);
ok('App.StudentsCore 暴露 validate/dupKey/filterRows/kpi/scoreImpact',
  ['validate', 'dupKey', 'filterRows', 'kpi', 'scoreImpact'].every(function (k) { return typeof Stud[k] === 'function'; }));
ok('App.ClassesCore 暴露 classScoreAnalysis/scheduleText/validate/dupName',
  ['classScoreAnalysis', 'scheduleText', 'validate', 'dupName'].every(function (k) { return typeof Cls[k] === 'function'; }));

/* =========================================================
 * 1. 学生表单校验
 * ========================================================= */
console.log('\n=== 1. 学生表单校验（PRD §3.2 字段表）===');
const baseForm = function (over) {
  return Object.assign({
    stu_name: '张三', school: '一中', grade: '初三',
    phone: '13800138000', subjects: ['数学'], teachers: ['王老师']
  }, over || {});
};
eq('合法表单通过', Stud.validate(baseForm()), '');
eq('姓名空 → 拒绝', Stud.validate(baseForm({ stu_name: '   ' })), '姓名不能为空');
ok('姓名超 20 字 → 拒绝', Stud.validate(baseForm({ stu_name: '张'.repeat(21) })).indexOf('20') >= 0);
eq('姓名正好 20 字 → 通过', Stud.validate(baseForm({ stu_name: '张'.repeat(20) })), '');
eq('学校空 → 拒绝', Stud.validate(baseForm({ school: '' })), '学校不能为空');
ok('学校超 40 字 → 拒绝', Stud.validate(baseForm({ school: '一'.repeat(41) })).indexOf('40') >= 0);
eq('年级不在枚举 → 拒绝', Stud.validate(baseForm({ grade: '大一' })), '请选择年级');
ok('电话 123 → 拒绝', Stud.validate(baseForm({ phone: '123' })).indexOf('联系方式') >= 0);
eq('电话 13800138000 → 通过', Stud.validate(baseForm({ phone: '13800138000' })), '');
eq('电话 0755-12345678 → 通过', Stud.validate(baseForm({ phone: '0755-12345678' })), '');
ok('电话 11 位但非 1 开头 → 拒绝', Stud.validate(baseForm({ phone: '23800138000' })).indexOf('联系方式') >= 0);
eq('科目空 → 拒绝', Stud.validate(baseForm({ subjects: [] })), '上课科目至少选择 1 项');
eq('老师空 → 拒绝', Stud.validate(baseForm({ teachers: [] })), '上课老师至少选择 1 位');

/* =========================================================
 * 2. 业务键查重（姓名 + 学校 + 年级）
 * ========================================================= */
console.log('\n=== 2. 查重口径（uk_students_key）===');
App.DB.cache.students = [
  { id: 1, stu_name: '张三', school: '一中', grade: '初三', phone: '13800138000', subjects: ['数学'], teachers: ['王老师'], created_at: '2026-11-01T02:00:00Z' },
  { id: 2, stu_name: '李四', school: '一中', grade: '初三', phone: '13800138001', subjects: ['英语'], teachers: ['李老师'], created_at: '2026-11-02T02:00:00Z' },
  { id: 3, stu_name: '张三', school: '二中', grade: '初三', phone: '13800138002', subjects: ['物理'], teachers: ['王老师'], created_at: '2026-11-03T02:00:00Z' },
  { id: 4, stu_name: '赵六', school: '一中', grade: '初二', phone: '13800138003', subjects: ['化学'], teachers: ['赵老师'], created_at: '2026-11-04T02:00:00Z' }
];
App.DB.cache.classes = [
  { id: 1, class_name: '初三数学A班', teachers: ['王老师'], room: '302', schedules: [{ weekday: 2, start: '18:30', end: '20:30' }], grade: '初三', subject: '数学' },
  { id: 2, class_name: '初三物理B班', teachers: ['李老师'], room: '305', schedules: [{ weekday: 6, start: '09:00', end: '11:00' }], grade: '初三', subject: '物理' }
];
App.DB.cache.class_members = [
  { id: 11, class_id: 1, student_id: 1 },
  { id: 12, class_id: 1, student_id: 2 },
  { id: 13, class_id: 2, student_id: 1 },
  { id: 14, class_id: 1, student_id: 3 },
  { id: 15, class_id: 1, student_id: 4 }
];

const T = App.DB.table('students');
ok('同姓名同校同年级 → 命中', !!T.findBy({ stu_name: '张三', school: '一中', grade: '初三' }));
ok('同姓名不同学校 → 不命中', T.findBy({ stu_name: '张三', school: '三中', grade: '初三' }) === null);
ok('同姓名同校不同年级 → 不命中', T.findBy({ stu_name: '张三', school: '一中', grade: '高一' }) === null);
ok('dupKey 去掉首尾空格后仍命中', !!T.findBy(Stud.dupKey({ stu_name: '  张三 ', school: '一中 ', grade: '初三' })));
eq('dupKey 归一化结果', JSON.stringify(Stud.dupKey({ stu_name: ' 张三 ', school: '一中', grade: '初三' })),
  JSON.stringify({ stu_name: '张三', school: '一中', grade: '初三' }));

/* =========================================================
 * 3. 六维筛选 + 清空
 * ========================================================= */
console.log('\n=== 3. 筛选（关键字 + 学校 + 年级 + 班级 + 科目 + 老师）===');
const MM = App.Students.memberMap();
const ALL = App.DB.cache.students;
const empty = { kw: '', school: '', grade: '', classId: '', subject: '', teacher: '' };
eq('无筛选 = 全量', Stud.filterRows(ALL, empty, MM).length, 4);
eq('关键字「张三」', Stud.filterRows(ALL, Object.assign({}, empty, { kw: '张三' }), MM).length, 2);
eq('关键字「李」', Stud.filterRows(ALL, Object.assign({}, empty, { kw: '李' }), MM).length, 1);
eq('关键字拼音中间态「zhang」不命中', Stud.filterRows(ALL, Object.assign({}, empty, { kw: 'zhang' }), MM).length, 0);
eq('学校「二中」', Stud.filterRows(ALL, Object.assign({}, empty, { school: '二中' }), MM).length, 1);
eq('年级「初二」', Stud.filterRows(ALL, Object.assign({}, empty, { grade: '初二' }), MM).length, 1);
eq('班级「初三数学A班」(id=1)', Stud.filterRows(ALL, Object.assign({}, empty, { classId: '1' }), MM).length, 4);
eq('班级「初三物理B班」(id=2)', Stud.filterRows(ALL, Object.assign({}, empty, { classId: '2' }), MM).length, 1);
eq('科目「物理」', Stud.filterRows(ALL, Object.assign({}, empty, { subject: '物理' }), MM).length, 1);
eq('老师「王老师」', Stud.filterRows(ALL, Object.assign({}, empty, { teacher: '王老师' }), MM).length, 2);
eq('叠加：班级1 + 科目数学 + 老师王老师',
  Stud.filterRows(ALL, Object.assign({}, empty, { classId: '1', subject: '数学', teacher: '王老师' }), MM).length, 1);
eq('叠加：关键字张三 + 学校一中 + 年级初三',
  Stud.filterRows(ALL, Object.assign({}, empty, { kw: '张三', school: '一中', grade: '初三' }), MM).length, 1);
eq('叠加到无交集 → 0 条',
  Stud.filterRows(ALL, Object.assign({}, empty, { school: '二中', classId: '2' }), MM).length, 0);
eq('清空筛选回到全量', Stud.filterRows(ALL, empty, MM).length, ALL.length);

/* =========================================================
 * 4. KPI
 * ========================================================= */
console.log('\n=== 4. KPI（总数 / 学校数 / 班级数 / 本月新增）===');
const K = Stud.kpi(ALL, MM, new Date('2026-11-15T10:00:00'));
eq('学生总数', K.total, 4);
eq('覆盖学校数（去重）', K.schools, 2);
eq('覆盖班级数（class_members 去重 class_id）', K.classes, 2);
eq('本月新增（2026-11 录入 4 人）', K.monthNew, 4);
eq('换到 2026-12 看 → 本月新增 0', Stud.kpi(ALL, MM, new Date('2026-12-01T00:00:00')).monthNew, 0);

/* =========================================================
 * 5. 改姓名/学校 → 成绩关联影响计数（只读 Store.data.records）
 * ========================================================= */
console.log('\n=== 5. 改姓名/学校的成绩影响计数（只读，不写）===');
const RECS = [
  { name: '张三', school: '一中', cls: '初三(1)班', exam: '期中考试', scores: [120, 130, 125, 80, 0, 0, 0, 60, 0], ranks: [1, 1, 1, 1, 0, 0, 0, 1, 0], totalRank: 2, ts: '2026-11-05T02:00:00Z' },
  { name: '张三', school: '一中', cls: '初三(2)班', exam: '期末考试', scores: [130, 140, 135, 90, 0, 0, 0, 70, 0], ranks: [1, 1, 1, 1, 0, 0, 0, 1, 0], totalRank: 1, ts: '2026-11-09T02:00:00Z' },
  { name: '张三', school: '一中', cls: '初三(1)班', exam: '第一次月考', scores: [110, 120, 115, 70, 0, 0, 0, 55, 0], ranks: [2, 2, 2, 2, 0, 0, 0, 2, 0], totalRank: 3, ts: '2026-11-01T02:00:00Z' },
  { name: '李四', school: '一中', cls: '初三(1)班', exam: '期中考试', scores: [100, 110, 105, 60, 0, 0, 0, 50, 0], ranks: [3, 3, 3, 3, 0, 0, 0, 3, 0], totalRank: 4, ts: '2026-11-05T02:00:00Z' }
];
App.Store.data.records = RECS;
eq('旧姓名+旧学校 匹配 3 条', Stud.scoreImpact(RECS, '张三', '一中'), 3);
eq('改成新姓名后 → 0 条', Stud.scoreImpact(RECS, '张三丰', '一中'), 0);
eq('同姓名不同学校 → 0 条', Stud.scoreImpact(RECS, '张三', '二中'), 0);
ok('只读：records 数组对象未被替换或改写', App.Store.data.records === RECS && RECS.length === 4);

/* =========================================================
 * 6. 班级表单校验 / 重名
 * ========================================================= */
console.log('\n=== 6. 班级校验与重名 ===');
const CLS = App.DB.cache.classes;
const okCls = {
  class_name: '初三英语C班', teachers: ['王老师'], room: '401',
  schedules: [{ weekday: 3, start: '18:30', end: '20:30' }], grade: '初三', subject: '英语'
};
eq('合法班级通过', Cls.validate(okCls, CLS, null), '');
eq('班级名空 → 拒绝', Cls.validate(Object.assign({}, okCls, { class_name: '  ' }), CLS, null), '班级名称不能为空');
ok('班级名超 30 字 → 拒绝', Cls.validate(Object.assign({}, okCls, { class_name: '班'.repeat(31) }), CLS, null).indexOf('30') >= 0);
eq('重名 → 拒绝', Cls.validate(Object.assign({}, okCls, { class_name: '初三数学A班' }), CLS, null), '该班级名称已存在');
eq('编辑时排除自身 → 通过', Cls.validate(Object.assign({}, okCls, { class_name: '初三数学A班' }), CLS, 1), '');
eq('老师空 → 拒绝', Cls.validate(Object.assign({}, okCls, { teachers: [] }), CLS, null), '班级老师至少选择 1 位');
eq('课室超 20 字 → 拒绝', Cls.validate(Object.assign({}, okCls, { room: '室'.repeat(21) }), CLS, null), '课室不能超过 20 个字');
eq('上课时间空 → 拒绝', Cls.validate(Object.assign({}, okCls, { schedules: [] }), CLS, null), '上课时间至少填写 1 条');
ok('start >= end → 拒绝',
  Cls.validate(Object.assign({}, okCls, { schedules: [{ weekday: 1, start: '20:30', end: '18:30' }] }), CLS, null).indexOf('早于') >= 0);
ok('星期越界 → 拒绝',
  Cls.validate(Object.assign({}, okCls, { schedules: [{ weekday: 9, start: '08:00', end: '10:00' }] }), CLS, null).indexOf('星期') >= 0);
ok('dupName 命中返回该行', Cls.dupName('初三物理B班', CLS, null) && Cls.dupName('初三物理B班', CLS, null).id === 2);
ok('dupName 未命中返回 null', Cls.dupName('不存在的班', CLS, null) === null);
eq('scheduleText 格式化', Cls.scheduleText([{ weekday: 2, start: '18:30', end: '20:30' }]), '周二 18:30–20:30');
eq('scheduleText 空 → —', Cls.scheduleText([]), '—');

/* =========================================================
 * 7. classScoreAnalysis（弱关联 + 动态满分）
 * ========================================================= */
console.log('\n=== 7. 班级成绩分析（ARCH §4.5）===');
/* 班级 1（初三数学A班）学生：1 张三 / 2 李四 / 3 王五 / 4 赵六 */
const students2 = App.DB.cache.students.concat([
  { id: 9, stu_name: '王五', school: '二中', grade: '初三', phone: '13800138009', subjects: ['语文'], teachers: ['王老师'], created_at: '2026-11-06T02:00:00Z' }
]);
App.DB.cache.students = students2;
const members2 = App.DB.cache.class_members.concat([
  { id: 16, class_id: 1, student_id: 9 }
]);
App.DB.cache.class_members = members2;

/* 王五（二中）成绩：注意成绩里的 cls 与本班名完全不同 —— 弱关联必须仍能匹配 */
const recs2 = RECS.concat([
  { name: '王五', school: '二中', cls: '另一所学校自己的班', exam: '期中考试', scores: [140, 145, 140, 95, 0, 0, 0, 80, 0], ranks: [1, 1, 1, 1, 0, 0, 0, 1, 0], totalRank: 1, ts: '2026-11-05T03:00:00Z' },
  /* 张三「期中考试」的第二行：同学生同考试两行，取 entered_at/ts 最新这一行 */
  { name: '张三', school: '一中', cls: '初三(3)班', exam: '期中考试', scores: [125, 135, 130, 85, 0, 0, 0, 65, 0], ranks: [1, 1, 1, 1, 0, 0, 0, 1, 0], totalRank: 2, ts: '2026-11-08T02:00:00Z', entered_at: '2026-11-08T02:00:00Z' }
]);

const an = Cls.classScoreAnalysis(1, { students: students2, members: members2, records: recs2 });
eq('可分析学生数（本班 5 人：张三/李四/张三(二中)/赵六/王五）', an.kpi.analyzable, 5);
eq('涉及考试场次（期中 / 期末 / 第一次月考 = 3）', an.kpi.exams, 3);
eq('匹配到成绩的学生数（张三·一中 / 李四 / 王五）', an.kpi.matched, 3);
eq('未匹配学生数（张三·二中 与 赵六）', an.kpi.unmatched, 2);
eq('unmatched 单列，含「张三·二中」',
  an.unmatched.filter(function (s) { return s.stu_name === '张三' && s.school === '二中'; }).length, 1);
eq('unmatched 单列，含赵六',
  an.unmatched.filter(function (s) { return s.stu_name === '赵六'; }).length, 1);
ok('弱关联负例：同名的「张三·二中」不会误配「张三·一中」的成绩',
  an.matched.every(function (m) { return m.student.school === '一中' || m.student.stu_name === '王五'; }));
eq('perExam 场次数', an.perExam.length, 3);
eq('perExam 顺序 = 最早录入升序（第一次月考最先）', an.perExam[0].exam, '第一次月考');
eq('期中考试参考人数（张三 + 李四 + 王五）', an.perExam.filter(function (e) { return e.exam === '期中考试'; })[0].count, 3);
ok('perExam 每行含 count/avg/max/min/passRate/avgRate',
  an.perExam.every(function (e) {
    return ['count', 'avg', 'max', 'min', 'passRate', 'avgRate'].every(function (k) { return e[k] !== undefined; });
  }));
eq('perSubject 固定 9 科', an.perSubject.length, 9);

/* 同学生同考试两行 → 取 entered_at 最新（ts=11-08 那条） */
const zs = an.perStudent.filter(function (p) { return p.student.stu_name === '张三'; })[0];
const latestRow = recs2.filter(function (r) {
  return r.name === '张三' && r.school === '一中' && r.exam === '期中考试';
}).sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); }).pop();
eq('同学生同考试两行 → 取最新一行的总分',
  Score.total(an.matched.filter(function (m) { return m.student.id === 1; })[0].byExam['期中考试']),
  Score.total(latestRow));
eq('perStudent 最近一次考试 = 期末考试（时间最晚）', zs.exam, '期末考试');
ok('perStudent 含 total/full/rate/rank/delta', zs.total > 0 && zs.full > 0 && zs.rate > 0 && zs.rank > 0);
eq('perStudent.delta = 期末总分 − 期中最新总分',
  zs.delta,
  Score.total(an.matched.filter(function (m) { return m.student.id === 1; })[0].byExam['期末考试']) -
  Score.total(an.matched.filter(function (m) { return m.student.id === 1; })[0].byExam['期中考试']));

/* 排名池 = 该考试本班全部行 */
const examName = zs.exam;
const pool = an.matched.filter(function (m) { return m.byExam[examName]; })
  .map(function (m) { return m.byExam[examName]; });
eq('perStudent.rank = Score.rankByRate(该考试本班池)', zs.rank, Score.rankByRate(pool, zs.last).rank);

/* 弱关联：王五的成绩记录里班级字段与本班不同名，仍被匹配 */
ok('弱关联：成绩记录的班级名与本班不同名也能匹配',
  an.matched.some(function (m) { return m.student.stu_name === '王五'; }));

/* 空班：不报错且 perExam 为空数组 */
const anEmpty = Cls.classScoreAnalysis(999, { students: students2, members: members2, records: recs2 });
eq('空班：perExam 为空数组', Array.isArray(anEmpty.perExam) && anEmpty.perExam.length, 0);
eq('空班：kpi.analyzable = 0', anEmpty.kpi.analyzable, 0);
eq('空班：unmatched 为空数组', anEmpty.unmatched.length, 0);

/* 同名同校两个学生（不同年级）会命中同一条成绩行 → 统计池必须按成绩行去重 */
const dupStudents = [
  { id: 41, stu_name: '张三', school: '一中', grade: '初三' },
  { id: 42, stu_name: '张三', school: '一中', grade: '初二' }
];
const dupMembers = [{ id: 51, class_id: 6, student_id: 41 }, { id: 52, class_id: 6, student_id: 42 }];
const dupRecs = recs2.filter(function (r) { return r.name === '张三' && r.school === '一中'; });
const anDup = Cls.classScoreAnalysis(6, { students: dupStudents, members: dupMembers, records: dupRecs });
eq('同名同校两人命中同一批成绩 → 考试场次按成绩行去重（3 场，不是 6 场）', anDup.kpi.exams, 3);
eq('同名同校两人 → 期中参考人数 = 1（不因学生数翻倍）',
  anDup.perExam.filter(function (e) { return e.exam === '期中考试'; })[0].count, 1);

/* ---- 动态满分：不是写死的 750 / 450 ---- */
const stu4 = [{ id: 21, stu_name: '周七', school: '一中', grade: '初三', phone: '13800138021', subjects: ['数学'], teachers: ['王老师'] }];
const memA = [{ id: 31, class_id: 5, student_id: 21 }];
/* 只填 4 科：语数英 + 物理 → 满分 150×3 + 100 = 550 */
const recA = [{ name: '周七', school: '一中', cls: '任意班', exam: '单科测试', scores: [120, 130, 110, 80, 0, 0, 0, 0, 0], ranks: [], totalRank: 0, ts: '2026-11-07T02:00:00Z' }];
const anA = Cls.classScoreAnalysis(5, { students: stu4, members: memA, records: recA });
eq('只填 4 科（语数英+物理）→ 分母 550 而不是 750', anA.perExam[0].full, 550);
eq('该生动态满分 = 550', anA.perStudent[0].full, 550);
eq('动态及格线 = round(550×60%) = 330', anA.perExam[0].line, 330);

/* 只填 4 门选科（物化生政）：选科最多计入 3 门 → 满分 300（不是 400，也不是 750） */
const recB = [{ name: '周七', school: '一中', cls: '任意班', exam: '单科测试', scores: [0, 0, 0, 80, 70, 60, 0, 0, 50], ranks: [], totalRank: 0, ts: '2026-11-07T02:00:00Z' }];
const anB = Cls.classScoreAnalysis(5, { students: stu4, members: memA, records: recB });
eq('4 门选科按最多计入 3 门 → 分母 300', anB.perExam[0].full, 300);
ok('任一情形分母都不是满配基准 750', anA.perExam[0].full !== 750 && anB.perExam[0].full !== 750);

/* =========================================================
 * 8. App.DB 边界：不得访问 score_records / user_profiles
 * ========================================================= */
console.log('\n=== 8. App.DB 边界（成绩只准读 Store.data.records）===');
const asked = [];
const realTable = App.DB.table;
App.DB.table = function (name) {
  asked.push(String(name));
  return realTable.call(App.DB, name);
};

modStudents.render.call(modStudents);
modStudents.bind.call(modStudents, { querySelector() { return null; }, querySelectorAll() { return []; } });
eq('学生模块渲染后未请求 score_records', asked.filter(function (n) { return n === 'score_records'; }).length, 0);
eq('学生模块渲染后未请求 user_profiles', asked.filter(function (n) { return n === 'user_profiles'; }).length, 0);

App.Classes.state.view = 'detail';
App.Classes.state.classId = 1;
App.Classes.state.tab = 'analysis';
modClasses.render.call(modClasses);
eq('班级成绩分析渲染后未请求 score_records', asked.filter(function (n) { return n === 'score_records'; }).length, 0);

const srcS = fs.readFileSync(path.join(SRC, 'module-students.js'), 'utf8');
const srcC = fs.readFileSync(path.join(SRC, 'module-classes.js'), 'utf8');
ok('module-students 源码无 App.DB.table(\'score_records\') / from(\'score_records\') 访问',
  !/App\.DB\.table\(\s*['"]score_records['"]/.test(srcS) && !/from\(\s*['"]score_records['"]/.test(srcS));
ok('module-classes 源码无 App.DB.table(\'score_records\') / from(\'score_records\') 访问',
  !/App\.DB\.table\(\s*['"]score_records['"]/.test(srcC) && !/from\(\s*['"]score_records['"]/.test(srcC));
ok('module-classes 只读 Store.data.records（无赋值）',
  !/Store\.data\.records\s*=[^=]/.test(srcC) && !/Store\.data\.records\.(push|splice|sort)\s*\(/.test(srcC));
ok('module-students 只读 Store.data.records（无赋值）',
  !/Store\.data\.records\s*=[^=]/.test(srcS) && !/Store\.data\.records\.(push|splice|sort)\s*\(/.test(srcS));
ok('两个模块 render 首行都做 L3 自检',
  /denied\(this\)/.test(srcS) && /forbiddenCard\(this\)/.test(srcS) &&
  /denied\(this\)/.test(srcC) && /forbiddenCard\(this\)/.test(srcC));

App.DB.table = realTable;

/* =========================================================
 * 9. 渲染内容抽查（空态 / 无权限）
 * ========================================================= */
console.log('\n=== 9. 渲染与 403 卡片 ===');
App.DB.cache.students = [];
App.DB.cache.class_members = [];
const emptyHtml = modStudents.render.call(modStudents);
ok('无学生 → 空态文案逐字', emptyHtml.indexOf('还没有学生档案。点右上『新增学生』开始，或从班级管理里添加学生。') >= 0);

const realIsAdmin = App.Sync.isAdmin;
App.Sync.isAdmin = function () { return false; };
const deniedHtml = modStudents.render.call(modStudents);
ok('非管理员渲染学生模块 → 403 卡片', deniedHtml.indexOf('该模块仅对管理员开放') >= 0 &&
  deniedHtml.indexOf('如需使用请联系系统管理员') >= 0);
const deniedClsHtml = modClasses.render.call(modClasses);
ok('非管理员渲染班级模块 → 403 卡片', deniedClsHtml.indexOf('该模块仅对管理员开放') >= 0);
App.Sync.isAdmin = realIsAdmin;

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
