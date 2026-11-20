/* =========================================================
 * tools/qa-v3-classes.js —— V3-4 班级分析排序口径 · 定向回归
 *   node tools/qa-v3-classes.js
 *
 * 沙箱口径与浏览器一致（IIFE + window.App）：
 *   core.js → db.js → perm.js → ui-kit.js → analysis.js → study-plan.js
 *          → module-students.js → module-classes.js
 * 通过 deps 显式给 App.ClassesCore.classScoreAnalysis 喂假数据，不读真实缓存。
 *
 * 夹具自带 examYm，补现有「全缺年月」夹具（smoke-v2-students-classes.js）
 * 未覆盖的年月生效分支：
 *   V-A1          后补录的 10 月按年月排到 11 月之前，结论「明显下滑」
 *   V-B1 / V-B2   跨年 2025-12 < 2026-01 按 year*12+month 数值比较
 *   V-D2          混合序列无年月的组排末尾、标题取该组最小有效年月
 *   V-G3 ①         同考试去重仍按 entered_at 取较新一行，且不拆成两次
 *   V-D1          全序列缺年月逐字回退旧的录入时间升序
 * ========================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.resolve(__dirname, '../js');

function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertBefore() {}, remove() {}, setAttribute() {},
    getAttribute() { return null; }, click() {}, focus() {}, setSelectionRange() {}
  };
}
const sandbox = {
  console,
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  document: {
    getElementById() { return makeEl(); }, createElement() { return makeEl(); },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}
  },
  setTimeout, clearTimeout, location: { hash: '' }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
['core.js', 'db.js', 'perm.js', 'ui-kit.js', 'analysis.js', 'study-plan.js',
  'module-students.js', 'module-classes.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
});
const App = sandbox.App, Score = App.Score, Cls = App.ClassesCore;
App.Store.init();

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function eq(name, actual, expect) {
  ok(name, actual === expect, 'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}

const students = [{ id: 1, stu_name: '学生A', school: '一中', grade: '高三', phone: '', subjects: [], teachers: [], created_at: '2026-01-01' }];
const members = [{ id: 1, class_id: 1, student_id: 1 }];

function rec(exam, examYm, scores, enteredAt) {
  return {
    name: '学生A', school: '一中', cls: '高三(1)班', exam: exam,
    examYm: examYm, scores: scores, ranks: [0, 0, 0, 0, 0, 0, 0, 0, 0], totalRank: 0,
    entered_at: enteredAt, ts: enteredAt
  };
}
const LOW = [60, 60, 60, 40, 40, 0, 0, 0, 47];     /* 307 / 750 ~ 40.9% */
const HIGH = [120, 120, 120, 80, 80, 0, 0, 0, 87];  /* 607 / 750 ~ 80.9% */
function joinExams(rows) { return rows.map(function (r) { return r.exam; }).join('|'); }

console.log('\n=== V-A1：后补录的 10 月必须排在 11 月之前，结论「明显下滑」===');
/* 录入顺序：先 11 月段考（11-05），后补录 10 月段考（11-19，entered_at 更晚） */
const recA = [
  rec('11月段考', '2026-11', LOW.slice(), '2026-11-05T02:00:00Z'),
  rec('10月段考', '2026-10', HIGH.slice(), '2026-11-19T02:00:00Z')
];
const anA = Cls.classScoreAnalysis(1, { students: students, members: members, records: recA });
eq('perExam 顺序按年月 = [10月段考, 11月段考]', joinExams(anA.perExam), '10月段考|11月段考');
eq('perExam[0].examYm = 2026-10', anA.perExam[0].examYm, '2026-10');
eq('perExam[1].examYm = 2026-11', anA.perExam[1].examYm, '2026-11');
eq('perStudent 最近一次 = 11月段考（年月最大）', anA.perStudent[0].exam, '11月段考');
ok('perStudent.delta < 0（年月序下 40.9% 减 80.9%）', anA.perStudent[0].delta < 0, 'delta=' + anA.perStudent[0].delta);
const sortedA = Score.sortByExam(recA);
eq('sortByExam 序列 = [10月段考, 11月段考]', joinExams(sortedA), '10月段考|11月段考');
const hist = Score.history(sortedA, 0, 60);
ok('Score.history 结论含「明显下滑」', hist.conclusion.indexOf('明显下滑') >= 0, hist.conclusion + ' / ' + hist.desc);
const buildA = App.Analysis.build({
  target: recA[0], classRows: recA, gradeRows: recA, studentRows: sortedA, track: '物理类'
});
ok('Analysis.build trend.rateDelta < 0（首考 80.9% 到最近 40.9%）', buildA.trend.rateDelta < 0, 'rateDelta=' + buildA.trend.rateDelta);
eq('trend.exams[0].exam = 10月段考（首考）', buildA.trend.exams[0].exam, '10月段考');
eq('trend.exams[last].exam = 11月段考（最近）', buildA.trend.exams[buildA.trend.exams.length - 1].exam, '11月段考');

console.log('\n=== V-B1 / V-B2：跨年 2025-12 < 2026-01 按 year*12+month 数值 ===');
const recB = [
  rec('26年10月', '2026-10', HIGH.slice(), '2026-10-05T02:00:00Z'),
  rec('25年12月', '2025-12', HIGH.slice(), '2025-12-05T02:00:00Z'),
  rec('26年9月', '2026-09', HIGH.slice(), '2026-09-05T02:00:00Z'),
  rec('26年1月', '2026-01', HIGH.slice(), '2026-01-05T02:00:00Z')
];
const anB = Cls.classScoreAnalysis(1, { students: students, members: members, records: recB });
eq('perExam 跨年数值升序', joinExams(anB.perExam), '25年12月|26年1月|26年9月|26年10月');
eq('sortByExam 跨年数值升序', joinExams(Score.sortByExam(recB)), '25年12月|26年1月|26年9月|26年10月');

console.log('\n=== V-D2：混合序列无年月的组排末尾；标题取该组最小有效年月 ===');
const recC = [
  rec('有年月10月', '2026-10', HIGH.slice(), '2026-10-05T02:00:00Z'),
  rec('无年月', undefined, HIGH.slice(), '2026-09-01T02:00:00Z'),
  rec('有年月11月', '2026-11', LOW.slice(), '2026-11-05T02:00:00Z')
];
const anC = Cls.classScoreAnalysis(1, { students: students, members: members, records: recC });
eq('无年月组排末尾', joinExams(anC.perExam), '有年月10月|有年月11月|无年月');
eq('无年月组 examYm = null（标题不加括号）', anC.perExam[2].examYm, null);

console.log('\n=== V-G3 ①：同考试去重仍按 entered_at 取较新一行，且不拆成两次 ===');
const recD = [
  rec('期中考试', undefined, HIGH.slice(), '2026-11-05T02:00:00Z'),
  rec('期中考试', undefined, LOW.slice(), '2026-11-08T02:00:00Z')
];
const anD = Cls.classScoreAnalysis(1, { students: students, members: members, records: recD });
eq('同考试只算 1 场', anD.kpi.exams, 1);
eq('取 entered_at 较新行（低分行）',
  anD.matched[0].byExam['期中考试'].scores.join(','), LOW.join(','));

console.log('\n=== V-D1：全序列缺年月逐字回退（夹具等价）===');
const recE = [
  rec('第一次月考', undefined, HIGH.slice(), '2026-11-01T02:00:00Z'),
  rec('期中考试', undefined, HIGH.slice(), '2026-11-05T02:00:00Z'),
  rec('期末考试', undefined, LOW.slice(), '2026-11-09T02:00:00Z')
];
const anE = Cls.classScoreAnalysis(1, { students: students, members: members, records: recE });
eq('全缺年月 perExam 按最早录入升序', joinExams(anE.perExam), '第一次月考|期中考试|期末考试');
eq('全缺年月 perStudent 最近一次 = 期末考试', anE.perStudent[0].exam, '期末考试');
ok('全缺年月所有 examYm 为 null', anE.perExam.every(function (e) { return e.examYm === null; }));

console.log('\n=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
