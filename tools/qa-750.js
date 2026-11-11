/* =========================================================
 * tools/qa-750.js —— 750 分制改造 · QA 独立回归（node tools/qa-750.js）
 *
 * 由 QA 独立设计：数据、断言、边界用例均不复用 tools/smoke-analysis.js，
 * 目的不是重复工程师自测，而是从「验收口径」反向验证实现。
 *
 * 加载链与浏览器一致（IIFE + window.App）：
 *   core.js → data-locator.js → locator.js → data-gradesize.js → gradesize.js
 *          → analysis.js → study-plan.js
 * 报告渲染函数：module-score.js 内的 locatorSection … Tab 4 之间整段抽取后求值
 * （该段只依赖 U / Ue / Score / App / state / Store / K，可在 node 沙箱跑）。
 *
 * 验收基准：
 *   1) 语数英 150/90，选考科 100/60；满配 6 科 750 / 450
 *   2) 选科由数据决定，>3 门取最高 3 门（同分按 物理→化学→政治→历史→地理→生物）
 *   3) 0 分 / 未填不计入分母
 *   4) 跨学生排名按得分率（率同再比绝对分），教师录入 totalRank 优先作年级排名
 *   5) 报告六节，无旧口径文案（九科 / 1050 / 630）
 *   6) 提分目标 = min(动态满分, 当前 + gap)，Σ单科 delta 恒等于总 delta
 * ========================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'js');

/* ---------- 沙箱 ---------- */
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { getElementById: () => null, createElement: () => ({ style: {} }) }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
['core.js', 'data-locator.js', 'locator.js', 'data-gradesize.js', 'gradesize.js',
  'analysis.js', 'study-plan.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
});

const App = sandbox.App;
const Score = App.Score;
const A = App.Analysis;
const P = App.StudyPlan;
const GS = App.GradeSize;
const Loc = App.Locator;
const K = App.K;

/* Store 必须初始化，reportHTML 内部会用 Store.data.records 取年级池 */
App.Store.init();

/* ---------- 断言框架 ---------- */
let pass = 0, fail = 0;
const FAILS = [], INFOS = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  FAILS.push(name + (detail === undefined ? '' : ' → ' + detail));
}
function eq(name, actual, expect) {
  ok(name, actual === expect, 'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}
function near(name, actual, expect, tol) {
  const t = tol === undefined ? 0.05 : tol;
  ok(name, Math.abs(Number(actual) - Number(expect)) <= t,
    'actual=' + actual + ' expect≈' + expect + ' tol=' + t);
}
function info(msg) { INFOS.push(msg); }

/* =========================================================
 * 报告渲染函数提取（与浏览器同一份源码）
 * ========================================================= */
const state = { gradeN: {}, reportOpen: true };
const MS = fs.readFileSync(path.join(SRC, 'module-score.js'), 'utf8');
const iTab4 = MS.indexOf('* Tab 4');
const iHead = MS.lastIndexOf('/*', iTab4);
const renderSrc = MS.slice(MS.indexOf('function locatorSection('), iHead);
const render = new Function('U', 'Ue', 'Score', 'App', 'state', 'Store', 'K',
  renderSrc + '\nreturn { reportHTML: reportHTML };'
)(
  App.U,
  function (s) { return App.U.esc(s); },
  Score,
  { Analysis: A, GradeSize: GS, StudyPlan: P, Locator: Loc },
  state,
  App.Store,
  K
);

/* =========================================================
 * 造数据
 * ========================================================= */
function Z9() { return [0, 0, 0, 0, 0, 0, 0, 0, 0]; }
function rec(o) {
  return Object.assign({
    name: '测试生', school: '纪中', cls: '28届', exam: '一模',
    scores: Z9(), ranks: Z9(), totalRank: 0
  }, o);
}

/* 6 科：112+138+126 + 物92 化84 生88 = 640 / 750 */
const S6 = [112, 138, 126, 92, 84, 0, 0, 0, 88];
/* 3 科：仅语数英 = 376 / 450 */
const S3 = [112, 138, 126, 0, 0, 0, 0, 0, 0];
/* 语文 0 分 + 数英 + 物化生 = 528 / 600（必考缺 1 门） */
const SNC = [0, 138, 126, 92, 84, 0, 0, 0, 88];
/* 6 门选科全有分（overflow 极值）= 646 / 750，舍弃 化/史/地 */
const S9 = [112, 138, 126, 92, 84, 90, 75, 60, 88];
/* 4 门选科（overflow）= 644 / 750，舍弃 化学 */
const S4 = [112, 138, 126, 92, 84, 90, 0, 0, 86];
/* 4 门选科全同分 → 取 物/化/政，舍弃 生物 */
const STIE = [110, 130, 120, 80, 80, 80, 0, 0, 80];
/* 4 门选科，第 3、4 门同分 → 取 化(70) 舍弃 生(70) */
const STIE34 = [110, 130, 120, 95, 70, 70, 0, 0, 70];
/* 超满分（物理/化学/生物 各填 110，超过 100 分满分）→ 780 / 750 */
const SOVER = [150, 150, 150, 110, 110, 0, 0, 0, 110];
/* 满分记录 = 750 / 750，无提升空间 */
const SMAX = [150, 150, 150, 100, 100, 0, 0, 0, 100];
/* 得分率对比：A 三科 360/450 = 80% vs B 六科 600/750 = 80% */
const SRATE_A = [120, 120, 120, 0, 0, 0, 0, 0, 0];
const SRATE_B = [120, 120, 120, 80, 80, 0, 0, 0, 80];
/* A 高分率版：400/450 = 88.9% */
const SRATE_A2 = [140, 130, 130, 0, 0, 0, 0, 0, 0];

const r6 = rec({ name: '六科生', scores: S6.slice() });
const r3 = rec({ name: '三科生', scores: S3.slice() });
const rNC = rec({ name: '语文缺考', scores: SNC.slice() });
const r9 = rec({ name: '六选科', scores: S9.slice() });
const r4 = rec({ name: '四选科', scores: S4.slice() });
const rTie = rec({ name: '四选科同分', scores: STIE.slice() });
const rTie34 = rec({ name: '三四门同分', scores: STIE34.slice() });
const rOver = rec({ name: '超满分', scores: SOVER.slice() });
const rMax = rec({ name: '满分生', scores: SMAX.slice() });
const rEmpty = rec({ name: '空记录' });
const rRateA = rec({ name: '三科80', scores: SRATE_A.slice() });
const rRateB = rec({ name: '六科80', scores: SRATE_B.slice() });
const rRateA2 = rec({ name: '三科88', scores: SRATE_A2.slice() });

const POOL = [r6, r3, rNC, r9, r4, rTie, rRateA, rRateB];

function buildAn(target, pool, gradeN) {
  const rows = pool && pool.length ? pool : [target];
  return A.build({
    target: target,
    classRows: rows.filter(function (r) { return r.cls === target.cls; }),
    gradeRows: Score.gradePool(rows, target),
    studentRows: [target],
    gradeSize: gradeN ? { n: gradeN, source: 'manual', note: 'qa' } : null,
    track: '物理类'
  });
}

function renderReport(target, rows, gradeN) {
  const list = rows && rows.length ? rows : [target];
  App.Store.data.records = list.slice();
  state.gradeN = {};
  if (gradeN > 0) {
    state.gradeN[String(target.school || '').trim() + '|' + Score.gradeOf(target.cls)] = gradeN;
  }
  const clsRows = list.filter(function (r) { return r.cls === target.cls; });
  return render.reportHTML(target, clsRows, [target]);
}

/* =========================================================
 * 1. 常量与单科满分 / 及格线
 * ========================================================= */
console.log('\n=== 1. 常量：语数英 150/90，选考 100/60 ===');
eq('K.SUBJECT_FULL 语数英', K.SUBJECT_FULL.slice(0, 3).join(','), '150,150,150');
eq('K.SUBJECT_FULL 选考六科', K.SUBJECT_FULL.slice(3).join(','), '100,100,100,100,100,100');
eq('K.SUBJECT_PASS 语数英', K.SUBJECT_PASS.slice(0, 3).join(','), '90,90,90');
eq('K.SUBJECT_PASS 选考六科', K.SUBJECT_PASS.slice(3).join(','), '60,60,60,60,60,60');
eq('K.CORE_IDX', K.CORE_IDX.join(','), '0,1,2');
eq('K.ELECTIVE_IDX', K.ELECTIVE_IDX.join(','), '3,4,5,6,7,8');
eq('K.ELECTIVE_MAX', K.ELECTIVE_MAX, 3);
near('K.PASS_RATE', K.PASS_RATE, 0.6, 1e-9);
eq('fullOf(0) 语文 150', Score.fullOf(0), 150);
eq('fullOf(8) 生物 100', Score.fullOf(8), 100);
eq('passOf(1) 数学 90', Score.passOf(1), 90);
eq('passOf(5) 政治 60', Score.passOf(5), 60);
eq("fullOf('total') = 满配基准 750", Score.fullOf('total'), 750);
eq("passOf('total') = 满配基准 450", Score.passOf('total'), 450);

/* =========================================================
 * 2. fields / total / fullTotal / passTotal / totalRate：6 科
 * ========================================================= */
console.log('\n=== 2. 6 科：750 / 450 ===');
const f6 = Score.fields(r6);
eq('满分 750', f6.full, 750);
eq('及格线 450', f6.pass, 450);
eq('all = 0,1,2,3,4,8', f6.all.join(','), '0,1,2,3,4,8');
eq('coreCount 3', f6.coreCount, 3);
eq('electiveCount 3', f6.electiveCount, 3);
eq('complete true', f6.complete, true);
eq('overflow false', f6.overflow, false);
eq('missingCore 空', f6.missingCore.length, 0);
eq('dropped 空', f6.dropped.length, 0);
eq('elective 已按科目序重排', f6.elective.join(','), '3,4,8');
eq('Score.total 640', Score.total(r6), 640);
eq('Score.fullTotal 750', Score.fullTotal(r6), 750);
eq('Score.passTotal 450', Score.passTotal(r6), 450);
near('totalRate = 640/750', Score.totalRate(r6) * 100, 85.33, 0.01);

/* =========================================================
 * 3. 只填语数英：450 / 270
 * ========================================================= */
console.log('\n=== 3. 只填语数英：450 / 270 ===');
const f3 = Score.fields(r3);
eq('满分 450', f3.full, 450);
eq('及格线 270', f3.pass, 270);
eq('all 只有语数英', f3.all.join(','), '0,1,2');
eq('complete false（选科 0 门）', f3.complete, false);
eq('overflow false', f3.overflow, false);
eq('missingCore 空（语数英都有分）', f3.missingCore.length, 0);
eq('Score.total 376', Score.total(r3), 376);
near('totalRate = 376/450', Score.totalRate(r3) * 100, 83.56, 0.01);
ok('不因缺 3 门选科而把得分率拉低（>80%）', Score.totalRate(r3) > 0.8, Score.totalRate(r3));

/* =========================================================
 * 4. 语文 0 分（其余两科 + 3 选科有分）：600 / 360
 * ========================================================= */
console.log('\n=== 4. 语文 0 分 + 3 选科：600 / 360 ===');
const fNC = Score.fields(rNC);
eq('满分 600（3×150 缺语文 + 3×100）', fNC.full, 600);
eq('及格线 360', fNC.pass, 360);
eq('core 只剩数学/英语', fNC.core.join(','), '1,2');
eq('missingCore = 语文', fNC.missingCore.join(','), '语文');
eq('electiveCount 3', fNC.electiveCount, 3);
eq('complete false', fNC.complete, false);
eq('Score.total 528', Score.total(rNC), 528);
near('totalRate = 528/600', Score.totalRate(rNC) * 100, 88, 0.01);

/* =========================================================
 * 5. 选科溢出：4 门 / 6 门（全部选科都有分）
 * ========================================================= */
console.log('\n=== 5. 选科 overflow：取分最高的 3 门 ===');
const f9 = Score.fields(r9);
eq('6 门选科 → overflow true', f9.overflow, true);
eq('electiveCount 封顶 3', f9.electiveCount, 3);
eq('取 物92/政90/生88', f9.elective.join(','), '3,5,8');
eq('舍弃 化学/历史/地理', f9.dropped.join(','), '化学,历史,地理');
eq('droppedIdx = 4,6,7', f9.droppedIdx.join(','), '4,6,7');
eq('满分仍为 750', f9.full, 750);
eq('Score.total 646', Score.total(r9), 646);
eq('electivePool 按分降序', f9.electivePool.map(function (x) { return x.idx; }).join(','), '3,5,8,4,6,7');

const f4 = Score.fields(r4);
eq('4 门选科 → overflow true', f4.overflow, true);
eq('取 物92/政90/生86', f4.elective.join(','), '3,5,8');
eq('舍弃 化学(84)', f4.dropped.join(','), '化学');
eq('满分 750', f4.full, 750);
eq('Score.total 644', Score.total(r4), 644);

/* =========================================================
 * 6. 同分取舍：固定科目顺序（物理→化学→政治→历史→地理→生物）
 * ========================================================= */
console.log('\n=== 6. 同分按固定顺序取舍 ===');
const fTie = Score.fields(rTie);
eq('4 门全 80 分 → 取 物/化/政', fTie.elective.join(','), '3,4,5');
eq('舍弃 生物（下标最大）', fTie.dropped.join(','), '生物');
eq('electivePool 全同分时序号升序', fTie.electivePool.map(function (x) { return x.idx; }).join(','), '3,4,5,8');

const fTie34 = Score.fields(rTie34);
eq('第 3、4 门同分（化70/生70）→ 取 化', fTie34.elective.join(','), '3,4,5');
eq('舍弃 生物', fTie34.dropped.join(','), '生物');
eq('被舍弃科目确实有分（不是缺考）', Number(rTie34.scores[8]) > 0, true);

/* =========================================================
 * 7. 边界：全 0 分 / 空记录
 * ========================================================= */
console.log('\n=== 7. 边界：全 0 分空记录 ===');
const fZ = Score.fields(rEmpty);
eq('满分 0', fZ.full, 0);
eq('及格线 0', fZ.pass, 0);
eq('all 为空', fZ.all.length, 0);
eq('complete false', fZ.complete, false);
eq('overflow false', fZ.overflow, false);
eq('missingCore 3 门', fZ.missingCore.length, 3);
eq('Score.total 0', Score.total(rEmpty), 0);
eq('totalRate 为 0 且不抛异常', Score.totalRate(rEmpty), 0);
eq('rankByRate valid=false', Score.rankByRate([rEmpty], rEmpty).valid, false);
let anZ = null, anZErr = null;
try { anZ = buildAn(rEmpty, [rEmpty, r6], 800); } catch (e) { anZErr = e; }
ok('Analysis.build 不抛异常', anZErr === null, anZErr && anZErr.message);
ok('overview.passed = false', anZ && anZ.overview.passed === false);
eq('overview.subjectCount 0', anZ && anZ.overview.subjectCount, 0);
eq('overview.totalRate 0', anZ && anZ.overview.totalRate, 0);
eq('share 为空', anZ && anZ.share.length, 0);
eq('subjects 为空', anZ && anZ.subjects.length, 0);
eq('rankTable 只有总分一行', anZ && anZ.rankTable.length, 1);
eq('advice 仍恰好 3 条', anZ && anZ.summary.advice.length, 3);
ok('headline 不出现 NaN / undefined',
  anZ && !/NaN|undefined/.test(anZ.summary.headline), anZ && anZ.summary.headline);
let planZ = null, planZErr = null;
try { planZ = P.build({ target: rEmpty, analysis: anZ, loc: {}, gradeRows: [r6], classRows: [r6] }); }
catch (e) { planZErr = e; }
ok('StudyPlan.build 不抛异常', planZErr === null, planZErr && planZErr.message);eq('无成绩学生 delta = 0', planZ && planZ.delta, 0);
eq('无成绩学生分摊 0 条', planZ && planZ.perSubject.length, 0);

/* =========================================================
 * 8. 边界：单科分数超过满分 → rate 必须 clamp
 * ========================================================= */
console.log('\n=== 8. 边界：分数超过满分（物理/化学/生物 填 110） ===');
eq('rateOf(105, 3) clamp 到 1', Score.rateOf(105, 3), 1);
eq('rateOf(300, 0) clamp 到 1', Score.rateOf(300, 0), 1);
eq('rateOf(-5, 0) clamp 到 0', Score.rateOf(-5, 0), 0);
eq('Score.totalRate 已 clamp 到 1', Score.totalRate(rOver), 1);
eq('但绝对总分仍为 780（不做静默截断）', Score.total(rOver), 780);
const anOver = buildAn(rOver, [rOver, r6], 800);
eq('Analysis.overview.totalRate 已 clamp 到 1', anOver.overview.totalRate, 1);
const headRate = Number((anOver.summary.headline.match(/得分率\s*([0-9.]+)%/) || [])[1]);
ok('总结 headline 的得分率数值 ≤ 100%', isFinite(headRate) && headRate <= 100,
  'headRate=' + headRate + ' :: ' + anOver.summary.headline);
ok('share / rankTable / classCmp / gradeCmp 的得分率均 ≤ 1',
  anOver.share.every(function (s) { return s.rate <= 1; }) &&
  anOver.rankTable.every(function (r) { return r.rate <= 1; }) &&
  anOver.classCmp.total.rate <= 1 && anOver.gradeCmp.total.rate <= 1,
  'share=' + anOver.share.map(function (s) { return s.rate; }).join(',') +
  ' classCmp=' + anOver.classCmp.total.rate);
ok('Score.stat 平均得分率不因超满分 >100%', Score.stat([rOver], 'total').avgRate <= 1,
  Score.stat([rOver], 'total').avgRate);
ok('趋势单次得分率不因超满分 >100%',
  anOver.trend.exams.every(function (e) { return e.rate <= 1; }),
  anOver.trend.exams.map(function (e) { return e.rate; }).join(','));
const planOver = P.build({
  target: rOver, analysis: anOver, loc: {},
  gradeRows: [rOver, r6], classRows: [rOver, r6]
});
ok('提分目标总分不得超过动态满分', planOver.targetTotal <= anOver.overview.full,
  'targetTotal=' + planOver.targetTotal + ' full=' + anOver.overview.full);
eq('超满分时目标总分取动态满分 750', planOver.targetTotal, 750);
eq('超满分时 delta 回落为 0', planOver.delta, 0);
near('超满分时 Σ单科 delta 仍 = 总 delta',
  planOver.perSubject.reduce(function (a, x) { return a + x.delta; }, 0), planOver.delta, 0.5);
ok('超满分时说明当前已达满分、不再叠加提分量',
  /已满分|超满分/.test(planOver.paragraphs.join('')) &&
  /不再叠加提分量|转为保持/.test(planOver.paragraphs.join('')),
  planOver.paragraphs[1]);
const repOver = renderReport(rOver, [rOver, r6], 800);
const overPcts = (repOver.match(/[0-9]+(?:\.[0-9]+)?%/g) || []).map(function (s) { return parseFloat(s); });
const badPcts = overPcts.filter(function (v) { return v > 100; });
eq('超满分报告里所有百分数 ≤ 100%', badPcts.length, 0, badPcts.join(',') + '%');
ok('超满分报告给出琥珀色核对提示',
  repOver.indexOf('#fdf8ee') >= 0 && /核对/.test(repOver) && /超满分录入|存在超满分分数/.test(repOver),
  '琥珀=' + (repOver.indexOf('#fdf8ee') >= 0) + ' 核对=' + /核对/.test(repOver));
ok('超满分报告的大号总分按 min(总分, 动态满分) 展示为 750 / 750',
  /an-total-v">750<span> \/ 750<\/span>/.test(repOver),
  (repOver.match(/an-total-v">[^<]*<span>[^<]*<\/span>/) || [])[0]);
if (/总分 780 \/ 750/.test(repOver) && /an-total-v">750<span>/.test(repOver)) {
  info('（低风险留痕）超满分时大号总分已按 750 / 750 展示并附琥珀说明，但 summary.headline 仍写「总分 780 / 750」，' +
    '同一报告内两处总分口径不一致（780 全篇出现 ' + (repOver.match(/780/g) || []).length +
    ' 次）。该路径仅能由云端/历史脏数据触发（UI 写入已被 upsert 截断），风险 低。');
}

/* =========================================================
 * 9. rankByRate：先比得分率，率同再比绝对分
 * ========================================================= */
console.log('\n=== 9. 跨学生排名：得分率优先 ===');
near('A 得分率 80%', Score.totalRate(rRateA) * 100, 80, 1e-6);
near('B 得分率 80%', Score.totalRate(rRateB) * 100, 80, 1e-6);
ok('B 绝对分 600 > A 360', Score.total(rRateB) > Score.total(rRateA));
eq('率同 → 绝对分高的 B 排第 1', Score.rankByRate([rRateA, rRateB], rRateB).rank, 1);
eq('率同 → A 排第 2', Score.rankByRate([rRateA, rRateB], rRateA).rank, 2);
eq('率同但绝对分低者不会被判并列', Score.rankByRate([rRateA, rRateB], rRateA).total, 2);
near('A2 得分率 88.9%', Score.totalRate(rRateA2) * 100, 88.89, 0.01);
ok('A2 绝对分 400 低于 B 的 600', Score.total(rRateA2) < Score.total(rRateB));
eq('率高的 A2 排第 1（绝对分更低也算）', Score.rankByRate([rRateA2, rRateB], rRateA2).rank, 1);
eq('B 退到第 2', Score.rankByRate([rRateA2, rRateB], rRateB).rank, 2);
eq('空记录不计入名次池', Score.rankByRate([rRateA, rRateB, rEmpty], rRateA).total, 2);
eq('rankOf(total) 与 rankByRate 同口径', Score.rankOf([rRateA2, rRateB], rRateB, 'total').rank, 2);
eq('单科排名仍按绝对分（英语同分并列第 1）',
  Score.rankOf([rRateA, rRateB], rRateA, 2).rank, 1);

/* =========================================================
 * 10. 年级排名来源优先级：教师录入 totalRank 优先
 * ========================================================= */
console.log('\n=== 10. 年级排名：教师录入优先，班级排名恒按系统 ===');
const rTeacher = rec({ name: '教师排名', scores: S3.slice(), totalRank: 260, ranks: [12, 0, 0, 0, 0, 0, 0, 0, 0] });
const anT = buildAn(rTeacher, [rTeacher, r6, r9], 1200);
eq('年级排名取教师录入 260', anT.overview.rank, 260);
eq('来源标记 teacher', anT.overview.rankSource, 'teacher');
eq('班级排名恒由班级池按得分率算（83.6% < 85.3% < 86.1% → 第 3）', anT.overview.rankClass, 3);
const rNoTeacher = rec({ name: '无教师排名', scores: S3.slice(), totalRank: 0 });
const anNT = buildAn(rNoTeacher, [rNoTeacher, r6, r9], 1200);
eq('无录入 → 来源 system', anNT.overview.rankSource, 'system');
eq('无录入 → 系统按得分率给名次', anNT.overview.rank, 3);
near('百分位 = 名次/年级人数', anNT.overview.pct, 0.3, 0.01);

/* =========================================================
 * 11. Score.stat：总分列用样本内动态满分，单科列固定
 * ========================================================= */
console.log('\n=== 11. Score.stat 总分列动态满分 ===');
const stMix = Score.stat([rRateA, rRateB], 'total');
eq('样本 2 人', stMix.count, 2);
near('均分 480', stMix.avg, 480, 0.01);
near('平均得分率 80%', stMix.avgRate * 100, 80, 0.01);
near('full = 样本内动态满分均值 600', stMix.full, 600, 0.01);
eq('line = round(600×60%) = 360', stMix.line, 360);
eq('两名学生各自都过自己的及格线', stMix.passCount, 2);
near('avgFull 600', stMix.avgFull, 600, 0.01);
const stSubj = Score.stat([r6], 0);
eq('单科列满分固定 150', stSubj.full, 150);
eq('单科列及格线固定 90', stSubj.line, 90);

/* =========================================================
 * 12. Score.sort：同考试内按得分率降序（率同再比绝对分）
 * ========================================================= */
console.log('\n=== 12. Score.sort 按得分率排序 ===');
const tsFixed = '2026-01-01T00:00:00.000Z';
const sortRows = [
  rec({ name: 'A', scores: SRATE_A.slice(), ts: tsFixed }),
  rec({ name: 'B', scores: SRATE_B.slice(), ts: tsFixed }),
  rec({ name: 'A2', scores: SRATE_A2.slice(), ts: tsFixed })
];
eq('排序结果 A2 → B → A', Score.sort(sortRows).map(function (r) { return r.name; }).join(','), 'A2,B,A');

/* =========================================================
 * 13. Analysis.share：两个占比各自合计 100%，只含计入科目
 * ========================================================= */
console.log('\n=== 13. 科目占比：只列计入科目，各自合计 100% ===');
const an6 = buildAn(r6, POOL, 1200);
const an3 = buildAn(r3, POOL, 1200);
const anNC = buildAn(rNC, POOL, 1200);
const an9 = buildAn(r9, POOL, 1200);
function sumBy(arr, key) {
  return arr.reduce(function (a, x) { return a + x[key]; }, 0);
}
eq('6 科 share 条数 = 6', an6.share.length, 6);
near('6 科 fullShare 合计 100', sumBy(an6.share, 'fullShare'), 100, 0.01);
near('6 科 scoreShare 合计 100', sumBy(an6.share, 'scoreShare'), 100, 0.01);
eq('3 科 share 条数 = 3', an3.share.length, 3);
near('3 科 fullShare 合计 100', sumBy(an3.share, 'fullShare'), 100, 0.01);
near('3 科 scoreShare 合计 100', sumBy(an3.share, 'scoreShare'), 100, 0.01);
eq('语文 0 分 share 条数 = 5', anNC.share.length, 5);
near('语文 0 分 fullShare 合计 100', sumBy(anNC.share, 'fullShare'), 100, 0.01);
eq('overflow share 条数 = 6（不含被舍弃科）', an9.share.length, 6);
ok('share 不含被舍弃的化学/历史/地理',
  an9.share.every(function (s) { return ['化学', '历史', '地理'].indexOf(s.name) < 0; }),
  an9.share.map(function (s) { return s.name; }).join(','));
near('语文 0 分：单科满分占比 150/600 = 25', anNC.share[0].fullShare, 25, 0.01);

/* =========================================================
 * 14. absent / dropped 归类
 * ========================================================= */
console.log('\n=== 14. absent / dropped 归类 ===');
eq('6 科：absent = 政治/历史/地理', an6.absent.join(','), '政治,历史,地理');
eq('6 科：dropped 空', an6.dropped.length, 0);
eq('6 门选科：absent 空', an9.absent.length, 0);
eq('6 门选科：dropped = 化学/历史/地理', an9.dropped.join(','), '化学,历史,地理');
const an4 = buildAn(r4, POOL, 1200);
eq('4 门选科：absent = 历史/地理（0 分）', an4.absent.join(','), '历史,地理');
eq('4 门选科：dropped = 化学（有分但被舍弃）', an4.dropped.join(','), '化学');
ok('dropped 与 absent 互斥（同一科不会两边都算）',
  an4.dropped.every(function (n) { return an4.absent.indexOf(n) < 0; }));

/* =========================================================
 * 15. 报告总结：≤2 段 × ≤2 句、advice 恰 3 条
 * ========================================================= */
console.log('\n=== 15. 总结精简（含 absent + dropped 同时出现） ===');
function sentCount(s) { return (String(s).match(/[。！？]/g) || []).length; }
[['6 科', an6], ['3 科', an3], ['语文 0 分', anNC], ['6 门选科', an9], ['4 门选科(混合)', an4], ['空记录', anZ]]
  .forEach(function (pair) {
    const label = pair[0], an = pair[1];
    ok(label + '：段落数 ≤ 2', an.summary.paragraphs.length <= 2, an.summary.paragraphs.length);
    ok(label + '：每段 ≤ 2 句',
      an.summary.paragraphs.every(function (p) { return sentCount(p) <= 2; }),
      an.summary.paragraphs.map(sentCount).join('/') + ' :: ' + an.summary.paragraphs.join(' | '));
    eq(label + '：advice 恰 3 条', an.summary.advice.length, 3);
    ok(label + '：bullets 3~4 条',
      an.summary.bullets.length >= 3 && an.summary.bullets.length <= 4, an.summary.bullets.length);
    ok(label + '：headline 单句', sentCount(an.summary.headline) <= 1, an.summary.headline);
  });
eq('6 科 overview.full 750', an6.overview.full, 750);
eq('6 科 overview.passLine 450', an6.overview.passLine, 450);
eq('3 科 overview.full 450', an3.overview.full, 450);
eq('3 科 overview.passLine 270', an3.overview.passLine, 270);
eq('语文 0 分 overview.full 600', anNC.overview.full, 600);
eq('语文 0 分 overview.passLine 360', anNC.overview.passLine, 360);
eq('6 门选科 overview.overflow true', an9.overview.overflow, true);
eq('6 门选科 overview.droppedElectives', an9.overview.droppedElectives.join(','), '化学,历史,地理');
ok('4 门选科段落同时说明缺考与舍弃',
  an4.summary.paragraphs.join('').indexOf('缺考') >= 0 &&
  an4.summary.paragraphs.join('').indexOf('未计入') >= 0,
  an4.summary.paragraphs.join(' | '));

/* =========================================================
 * 16. 趋势按得分率（跨考试可比），≥2 次才计算
 * ========================================================= */
console.log('\n=== 16. 趋势：按得分率、≥2 次考试 ===');
const prev = rec({ name: '六科生', exam: '零模', scores: [100, 100, 100, 0, 0, 0, 0, 0, 0] }); // 300/450 = 66.7%
const anTrend = A.build({
  target: r6, classRows: [r6], gradeRows: [r6], studentRows: [prev, r6],
  gradeSize: null, track: '物理类'
});
eq('两次考试', anTrend.trend.exams.length, 2);
eq('第一次满分 450 / 第二次 750',
  anTrend.trend.exams.map(function (e) { return e.full; }).join(','), '450,750');
near('得分率增量按率算（66.7% → 85.3%）', anTrend.trend.rateDelta, 18.7, 0.05);
ok('总分增量不是唯一口径（绝对 +280 但率 +18.7pp）',
  Math.abs(anTrend.trend.totalDelta - 340) < 0.06, anTrend.trend.totalDelta);
const anOne = buildAn(r6, POOL, 1200);
eq('单次考试 trend.exams 只有 1 条', anOne.trend.exams.length, 1);
eq('单次考试 rateDelta = 0', anOne.trend.rateDelta, 0);

/* =========================================================
 * 17. 报告渲染：六节 + 无旧口径 + 动态满分
 * ========================================================= */
console.log('\n=== 17. 报告渲染串：六节 / 无旧口径 / 动态满分 ===');
ok('报告渲染函数抽取成功', typeof render.reportHTML === 'function' && renderSrc.length > 8000, renderSrc.length);
const rep6 = renderReport(r6, POOL, 1200);
const rep3 = renderReport(r3, POOL, 1200);
const rep9 = renderReport(r9, POOL, 1200);
const repZ = renderReport(rEmpty, [rEmpty], 1200);

const SECTIONS = ['一、成绩总览', '二、各科表现', '三、位次', '四、趋势', '五、优势与短板', '六、阶段规划'];
[['6 科', rep6], ['3 科', rep3], ['6 门选科', rep9], ['空记录', repZ]].forEach(function (pair) {
  const label = pair[0], html = pair[1];
  ok(label + ' 报告无「渲染失败」', html.indexOf('渲染失败') < 0);
  ok(label + ' 报告六节齐全', SECTIONS.every(function (t) { return html.indexOf(t) >= 0; }),
    SECTIONS.filter(function (t) { return html.indexOf(t) < 0; }).join(','));
  let last = -1, asc = true;
  SECTIONS.forEach(function (t) {
    const at = html.indexOf(t);
    if (at < last) asc = false;
    last = at;
  });
  ok(label + ' 六节顺序正确', asc);
  ok(label + ' 无「九科」', html.indexOf('九科') < 0);
  ok(label + ' 无「1050」', html.indexOf('1050') < 0);
  ok(label + ' 无「630」', html.indexOf('630') < 0);
  ok(label + ' 无旧章节「九、」/「十、」', html.indexOf('九、') < 0 && html.indexOf('十、') < 0);
  ok(label + ' 无「七、年级排名」', html.indexOf('七、年级排名') < 0);
});
ok('6 科报告显示 640 / 750', rep6.indexOf('640') >= 0 && rep6.indexOf('/ 750') >= 0);
ok('3 科报告用动态满分 450 与及格线 270',
  rep3.indexOf('/ 450') >= 0 && rep3.indexOf('及格线 270') >= 0);
ok('6 门选科报告提示被舍弃科目（未计入）', rep9.indexOf('未计入') >= 0 && rep9.indexOf('化学') >= 0);
ok('语文 0 分报告提示必考未录入',
  renderReport(rNC, POOL, 1200).indexOf('必考科目未录入') >= 0);
ok('报告内嵌院校定位明细且不再单独成章',
  rep6.indexOf('院校定位明细') >= 0 && rep6.indexOf('九、院校定位') < 0);

/* =========================================================
 * 18. StudyPlan：Σdelta 守恒 + 动态满分封顶
 * ========================================================= */
console.log('\n=== 18. 提分方案：Σdelta 守恒 + 封顶 ===');
function checkPlan(label, target, pool, expectCount) {
  const an = buildAn(target, pool, 1200);
  const plan = P.build({
    target: target, analysis: an, loc: {},
    gradeRows: pool || [target], classRows: pool || [target]
  });
  const sum = plan.perSubject.reduce(function (a, x) { return a + x.delta; }, 0);
  near(label + '：Σ单科 delta = 总 delta', sum, plan.delta, 0.5);
  near(label + '：目标总分 = 当前 + delta', plan.targetTotal, an.overview.total + plan.delta, 0.06);
  ok(label + '：目标总分 ≤ 动态满分', plan.targetTotal <= an.overview.full,
    plan.targetTotal + ' > ' + an.overview.full);
  ok(label + '：目标总分 ≤ 单科满分之和（逐科核对）',
    plan.perSubject.every(function (x) { return x.goal <= x.full + 0.001; }),
    plan.perSubject.map(function (x) { return x.name + x.goal + '/' + x.full; }).join(','));
  eq(label + '：只分摊到计入科目', plan.perSubject.length, expectCount);
  return plan;
}
const plan6 = checkPlan('6 科', r6, POOL, 6);
const plan3 = checkPlan('3 科', r3, POOL, 3);
const planNC = checkPlan('语文 0 分', rNC, POOL, 5);
const plan9 = checkPlan('6 门选科', r9, POOL, 6);
const plan4 = checkPlan('4 门选科', r4, POOL, 6);
ok('6 科 delta 落在合理区间（1~110）', plan6.delta >= 1 && plan6.delta <= 110, plan6.delta);
ok('3 科 delta 落在合理区间（1~74）', plan3.delta >= 1 && plan3.delta <= 74, plan3.delta);
ok('6 门选科不把被舍弃科目列入分摊',
  plan9.perSubject.every(function (x) { return ['化学', '历史', '地理'].indexOf(x.name) < 0; }),
  plan9.perSubject.map(function (x) { return x.name; }).join(','));

const anMax = buildAn(rMax, [rMax, r6], 1200);
const planMax = P.build({ target: rMax, analysis: anMax, loc: {}, gradeRows: [rMax, r6], classRows: [rMax, r6] });
eq('满分学生 delta = 0', planMax.delta, 0);
eq('满分学生目标总分 = 750', planMax.targetTotal, 750);
ok('满分学生不产生负数 delta',
  planMax.perSubject.every(function (x) { return x.delta >= 0; }),
  planMax.perSubject.map(function (x) { return x.name + ':' + x.delta; }).join(','));

/* =========================================================
 * 19. 静态一致性：分母只能来自 Score.fields()
 * ========================================================= */
console.log('\n=== 19. 静态一致性：标称 750/450 不得当分母 ===');
const jsFiles = fs.readdirSync(SRC).filter(function (f) { return /\.js$/.test(f); });
const srcMap = {};
jsFiles.forEach(function (f) { srcMap[f] = fs.readFileSync(path.join(SRC, f), 'utf8'); });

const tokenFiles = jsFiles.filter(function (f) { return /K\.(FULL_TOTAL|PASS_TOTAL)/.test(srcMap[f]); });
eq('K.FULL_TOTAL / K.PASS_TOTAL 只出现在 core.js', tokenFiles.join(','), 'core.js');
const tokenUses = (srcMap['core.js'].match(/K\.(FULL_TOTAL|PASS_TOTAL)/g) || []).length;
ok('满配基准只在 fullOf/passOf 内被引用（共 4 处，其中 total 分支 2 处）', tokenUses === 4, tokenUses);

const accFiles = jsFiles.filter(function (f) {
  return /(\+=\s*(K|App\.K)\.SUBJECT_FULL)|((K|App\.K)\.SUBJECT_FULL\[[^\]]*\]\s*\+)/.test(srcMap[f]);
});
eq('累加满分的代码只在 core.js（Score.fields）', accFiles.join(','), 'core.js');

const numFiles = jsFiles.filter(function (f) { return /NUM_SUBJECTS/.test(srcMap[f]); }).sort();
const NUM_ALLOW = ['analysis.js', 'app.js', 'core.js', 'export.js', 'module-score.js', 'sync.js'];
const numExtra = numFiles.filter(function (f) { return NUM_ALLOW.indexOf(f) < 0; });
eq('NUM_SUBJECTS 未扩散到新的计算文件', numExtra.join(','), '');
const numBad = [];
jsFiles.forEach(function (f) {
  srcMap[f].split('\n').forEach(function (line, i) {
    if (/NUM_SUBJECTS/.test(line) && /(full|pass)\s*(\+=|=)/.test(line)) {
      numBad.push(f + ':' + (i + 1) + ' ' + line.trim());
    }
  });
});
eq('没有「用 NUM_SUBJECTS 累加满分/及格线」的行', numBad.length, 0, numBad.join(' | '));
const okLoopFiles = jsFiles.filter(function (f) {
  return /for\s*\([^)]*NUM_SUBJECTS/.test(srcMap[f]);
}).sort();
eq('NUM_SUBJECTS 只用于「枚举 9 个输入位/科目位」的循环', okLoopFiles.join(','),
  'analysis.js,app.js,core.js,export.js,module-score.js,sync.js');

/* =========================================================
 * 20. 旧口径残留扫描
 * ========================================================= */
console.log('\n=== 20. 旧口径残留扫描 ===');
/* 旧口径扫描词：不再包含裸「630」——630 现在是 985 批次线的合法分数线 */
const PATTERNS = ['1050', '九科', '十、', '九、', '七、年级排名', '及格线 630'];
const codeEntries = jsFiles.map(function (f) {
  return { name: 'js/' + f, content: srcMap[f] };
});
codeEntries.push({ name: 'index.html', content: fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') });
codeEntries.push({ name: 'assets/style.css', content: fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8') });
const readme = { name: 'README.md', content: fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') };

function hitsOf(entries) {
  const out = [];
  PATTERNS.forEach(function (p) {
    entries.forEach(function (e) {
      e.content.split('\n').forEach(function (line, i) {
        if (line.indexOf(p) >= 0) {
          out.push(e.name + ':' + (i + 1) + ' [' + p + '] ' + line.trim().slice(0, 80));
        }
      });
    });
  });
  return out;
}
const codeHits = hitsOf(codeEntries);
eq('js/ + index.html + assets/ 无旧口径残留', codeHits.length, 0, codeHits.join(' | '));
const readmeHits = hitsOf([readme]);
if (readmeHits.length) {
  readmeHits.forEach(function (h) { info('README 残留（需人工判断）：' + h); });
}

/* =========================================================
 * 21. 追加：满分生不误报超分 + 教师排名与系统排名口径不互相污染
 * ========================================================= */
console.log('\n=== 21. 满分生 100% 不误报 + 教师/系统排名口径隔离 ===');
const repMax = renderReport(rMax, [rMax, r6], 800);
const anMaxRep = buildAn(rMax, [rMax, r6], 800);
eq('满分生 totalRate = 1', anMaxRep.overview.totalRate, 1);
ok('满分生报告显示 100%', repMax.indexOf('100%') >= 0);
ok('满分生 report 不出现超分告警文案', !/检测到超满分录入|存在超满分分数|已超过动态满分/.test(repMax),
  (repMax.match(/检测到超满分录入|存在超满分分数|已超过动态满分/) || [])[0]);
ok('满分生 report 无琥珀告警区块', repMax.indexOf('#fdf8ee') < 0);
ok('满分生 overview.overfull = false', anMaxRep.overview.overfull === false);
const maxPcts = (repMax.match(/[0-9]+(?:\.[0-9]+)?%/g) || []).map(function (s) { return parseFloat(s); });
eq('满分生报告所有百分数 ≤ 100%', maxPcts.filter(function (v) { return v > 100.001; }).length, 0);
ok('满分生报告提示已无提分缺口（不给出虚构的增长目标）',
  repMax.indexOf('已无明确提分缺口') >= 0, repMax.match(/已无明确提分缺口|当前各科已无/));

/* 教师 totalRank 与系统得分率排名冲突：年级取教师值，班级恒走系统，互不污染 */
const rHi = rec({ name: '甲', scores: S6.slice(), totalRank: 900 });         // 640/750 = 85.3%
const rLo = rec({ name: '乙', scores: [100, 110, 100, 0, 0, 0, 0, 0, 0], totalRank: 50, ranks: [7, 0, 0, 0, 0, 0, 0, 0, 0] });
const anMix = A.build({
  target: rLo, classRows: [rHi, rLo], gradeRows: [rHi, rLo], studentRows: [rLo],
  gradeSize: { n: 1000, source: 'manual', note: 'qa' }, track: '物理类'
});
eq('冲突时系统得分率排名为 2', Score.rankByRate([rHi, rLo], rLo).rank, 2);
eq('年级排名仍取教师录入 50', anMix.overview.rank, 50);
eq('年级排名来源 teacher', anMix.overview.rankSource, 'teacher');
eq('班级排名仍走系统得分率 → 2', anMix.overview.rankClass, 2);
ok('班级排名未被教师排名污染（≠50）', anMix.overview.rankClass !== anMix.overview.rank);
eq('班级排名不超出班级人数', anMix.overview.rankClass <= anMix.overview.classTotal, true);
near('百分位用教师排名 / 年级人数', anMix.overview.pct, 5, 0.01);
eq('位次表总分行的年级名次同为教师值', anMix.rankTable[0].rankGrade, 50);
eq('单科年级名次取教师录入 ranks[0] = 7', anMix.rankTable[1].rankGrade, 7);
eq('单科名次来源 teacher', anMix.rankTable[1].rankGradeSource, 'teacher');
eq('单科班级名次仍走系统（语文 100 分低于 112 → 第 2）', anMix.rankTable[1].rankClass, 2);

/* 已修复留痕：排名层 clamp 超满分记录（第 2 轮修复，断言随修复翻转） */
const rClean = rec({ name: '满分生', scores: SMAX.slice() });
const rDirty = rec({ name: '超分生', scores: SOVER.slice() });
eq('显示层：超分生与满分生 totalRate 都是 1',
  Score.totalRate(rDirty) === 1 && Score.totalRate(rClean) === 1, true);
eq('（已修复）脏数据不得排在合法满分生之前：rankByRate 率与截断分双 clamp',
  Score.rankByRate([rClean, rDirty], rClean).rank, 1);
eq('（已修复）clamp 后两者同率同截断分 → 脏数据最多并列第 1',
  Score.rankByRate([rClean, rDirty], rDirty).rank, 1);
info('超满分残余路径已收口：UI 写入由 Score.clampScores/upsert 截断，云端下发由 sync.js fromRow 截断；' +
  'Score.rankByRate / app.js recomputeRanks 的得分率与率同绝对分均已 Math.min 到动态满分，' +
  '脏记录不再以 104% 或未截断绝对分越位（以上两条断言已由此前的 2 翻转为 1）。');

/* ---------- 保存链路：max 属性只是 UI 约束，真正拦截靠 clampScores + upsert ---------- */
console.log('\n--- 21b. 保存链路：超满分能否落库 ---');
const rClamp = rec({ scores: [160, 150, 150, 110, 0, 0, 0, 0, 0] });
const clRes = Score.clampScores(rClamp);
eq('clampScores 语文 160 → 150', rClamp.scores[0], 150);
eq('clampScores 物理 110 → 100', rClamp.scores[3], 100);
eq('clampScores 合法分数不动', rClamp.scores[1], 150);
eq('clampScores 返回被截断科目名', clRes.clamped.join(','), '语文,物理');
const rBad = rec({ scores: [-5, NaN, '90', 0, 0, 0, 0, 0, 0] });
Score.clampScores(rBad);
eq('clampScores 负数 → 0', rBad.scores[0], 0);
eq('clampScores 非数字 → 0', rBad.scores[1], 0);
eq('clampScores 字符串数字 → 90', rBad.scores[2], 90);

App.Store.data = App.Store.blank();
const insRes = Score.upsert(rec({ name: '脏数据', scores: SOVER.slice() }));
eq('upsert 后 Store 内物理被截断为 100', App.Store.data.records[0].scores[3], 100);
eq('upsert 后 Store 内生物被截断为 100', App.Store.data.records[0].scores[8], 100);
eq('upsert 返回 clamped 名单供 UI 提示', insRes.clamped.join(','), '物理,化学,生物');
eq('Store 内总分不再是 780 而是 750', Score.total(App.Store.data.records[0]), 750);
eq('Store 内得分率恒为 1（脏数据落不了库）', Score.totalRate(App.Store.data.records[0]), 1);
ok('Store 内不存在总分 > 动态满分的记录',
  App.Store.data.records.every(function (r) { return Score.total(r) <= Score.fullTotal(r); }),
  App.Store.data.records.map(function (r) { return Score.total(r) + '/' + Score.fullTotal(r); }).join(','));

/* =========================================================
 * 汇总
 * ========================================================= */
console.log('\n============================');
if (INFOS.length) {
  console.log('INFO（' + INFOS.length + ' 条，人工判断项）');
  INFOS.forEach(function (s) { console.log('  · ' + s); });
  console.log('----------------------------');
}
if (FAILS.length) {
  console.log('FAIL（' + FAILS.length + ' 条）');
  FAILS.forEach(function (s) { console.log('  × ' + s); });
  console.log('----------------------------');
}
console.log('结果：PASS ' + pass + ' / FAIL ' + fail);
console.log('============================');
process.exit(fail ? 1 : 0);
