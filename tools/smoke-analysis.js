/* 冒烟测试：成绩分析 / 提分方案口径（node tools/smoke-analysis.js）
 * 口径：高考 6 科 750 分制 + 动态选科识别（语数英必考，选考取最高 3 门，未填不计入分母）
 * 覆盖：
 *   1) 百分位钳制（Bug-1）        2) 6 科 750/450            3) 3 科 450/270
 *   4) 0 分不计分母                5) 7 科取最高 3 门（overflow）  6) 同分按固定科目顺序
 *   7) 不同满分按得分率排名        8) 班级排名取班级池 / 年级排名优先教师录入
 *   9) 位次百分位不可计算给提示    10) 总结精简（≤2 段×2 句、3 条建议）
 *  11) 无旧口径文案（九科/1050/630） 12) 占比合计 100%        13) 总分对比用得分率
 *  14) 提分 delta 守恒 + 动态满分封顶   15) 里程碑无「前 0 名」
 *  16) 动作库频次+验收            17) 整篇报告六节渲染         18) 趋势降级/得分率折线
 *  19) GradeSize 科类回退标注      20) 各科表现「未计入」说明
 *  21) Score.stat 总分列动态均值    22) 空记录边界              23) 超满分脏数据 clamp/封顶
 *  24) 入口截断：clampScores / upsert 保证 Store 内无超满分
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = path.join(__dirname, '..', 'js');
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { getElementById: () => null, createElement: () => ({ style: {} }) }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
['core.js', 'data-locator.js', 'locator.js', 'data-gradesize.js', 'gradesize.js',
  'analysis.js', 'study-plan.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
});

const App = sandbox.App;
const Score = App.Score, A = App.Analysis, GS = App.GradeSize, P = App.StudyPlan, K = App.K;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, actual, expect) {
  ok(name, actual === expect, 'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}
function near(name, actual, expect, tol) {
  ok(name, Math.abs(Number(actual) - Number(expect)) <= (tol === undefined ? 0.05 : tol),
    'actual=' + actual + ' expect≈' + expect);
}

/* ---------- 报告渲染函数：从 module-score.js 整段抽出（含 helper） ---------- */
const MS = fs.readFileSync(path.join(SRC, 'module-score.js'), 'utf8');
const iTab = MS.indexOf('* Tab 4');
const iStart = MS.lastIndexOf('/*', iTab);
const allSrc = MS.slice(MS.indexOf('function locatorSection('), iStart);
const render = new Function('U', 'Ue', 'Score', 'App', 'state', 'Store', 'K',
  allSrc + '\nreturn { reportHTML: reportHTML, sectionOverview: sectionOverview, ' +
  'sectionSubjects: sectionSubjects, sectionRank: sectionRank, sectionTrend: sectionTrend, ' +
  'sectionGoodWeak: sectionGoodWeak, sectionPlan: sectionPlan };'
)(
  App.U,
  function (s) { return App.U.esc(s); },
  Score,
  {
    Analysis: A, GradeSize: GS, StudyPlan: P,
    /* 用真实的院校定位模块（含 bodyHTML），验证报告「六、阶段规划」内嵌明细不产生第二个章节标题 */
    Locator: App.Locator
  },
  { gradeN: {}, reportOpen: true },
  { data: { records: [] } },
  K
);

/* ---------- 造数据 ---------- */
function Z9() { return [0, 0, 0, 0, 0, 0, 0, 0, 0]; }
function rec(o) {
  return Object.assign({
    name: '张三', school: '纪中', cls: '28届', exam: '一模',
    scores: Z9(), ranks: Z9(), totalRank: 0
  }, o);
}
function build(target, rows, gradeN, studentRows) {
  return A.build({
    target: target,
    classRows: rows.filter(function (r) { return r.cls === target.cls; }),
    gradeRows: Score.gradePool(rows, target),
    studentRows: studentRows || [target],
    gradeSize: gradeN ? { n: gradeN, source: 'manual', note: '测试' } : null,
    track: '物理类'
  });
}

/* 6 科：语 118 数 132 英 121 物 88 化 79 生 85 → 623 / 750 */
const S6 = [118, 132, 121, 88, 79, 0, 0, 0, 85];
/* 3 科：语数英 → 371 / 450 */
const S3 = [118, 132, 121, 0, 0, 0, 0, 0, 0];
/* 9 科全有分：物 88 化 79 政 90 史 75 地 60 生 85 → 取 政90/物88/生85 = 263 */
const S9 = [118, 132, 121, 88, 79, 90, 75, 60, 85];
/* 3 科高分：400 / 450 = 88.9%（绝对分低于 6 科的 623，但得分率更高） */
const SX = [140, 140, 120, 0, 0, 0, 0, 0, 0];
const SLOW = [110, 120, 110, 70, 60, 0, 0, 0, 70];   // 540 / 750 = 72%

const r6 = rec({ scores: S6.slice() });
const r3 = rec({ scores: S3.slice() });
const r9 = rec({ scores: S9.slice() });
const rX = rec({ name: '高分率', scores: SX.slice() });
const rLow = rec({ name: '乙', scores: SLOW.slice(), totalRank: 900 });

console.log('\n=== 1. Score.pctOf 钳制 ===');
eq('300/3 -> 0', Score.pctOf(300, 3), 0);
eq('300/250 -> 0', Score.pctOf(300, 250), 0);
eq('2000/1406 -> 0', Score.pctOf(2000, 1406), 0);
eq('30/1000 -> 3', Score.pctOf(30, 1000), 3);
eq('1000/1000 -> 100', Score.pctOf(1000, 1000), 100);
eq('rank 0 -> 0', Score.pctOf(0, 100), 0);
eq('total 0 -> 0', Score.pctOf(5, 0), 0);

console.log('\n=== 2. 6 科 = 750 / 450 ===');
const f6 = Score.fields(r6);
eq('满分 750', f6.full, 750);
eq('及格线 450', f6.pass, 450);
eq('计入 6 科', f6.all.length, 6);
eq('必考 3 科', f6.coreCount, 3);
eq('选考 3 科', f6.electiveCount, 3);
eq('complete = true', f6.complete, true);
eq('overflow = false', f6.overflow, false);
eq('没有缺必考', f6.missingCore.length, 0);
eq('总分 623', Score.total(r6), 623);
near('得分率 83.1%', Score.totalRate(r6) * 100, 83.1, 0.06);
eq('K.FULL_TOTAL 满配基准 750', K.FULL_TOTAL, 750);
eq('K.PASS_TOTAL 满配基准 450', K.PASS_TOTAL, 450);

console.log('\n=== 3. 只填语数英 = 450 / 270 ===');
const f3 = Score.fields(r3);
eq('满分 450', f3.full, 450);
eq('及格线 270', f3.pass, 270);
eq('计入 3 科', f3.all.length, 3);
eq('complete = false（选科未满 3 门）', f3.complete, false);
eq('总分 371', Score.total(r3), 371);
near('得分率 82.4%', Score.totalRate(r3) * 100, 82.4, 0.06);
eq('未选科的学生不会因缺选科而掉率', Score.totalRate(r3) > 0.8, true);

console.log('\n=== 4. 0 分 / 未填不计入分母 ===');
const r0 = rec({ scores: [0, 132, 121, 0, 0, 0, 0, 0, 0] });
const f0 = Score.fields(r0);
eq('语文 0 分 → 满分只算数英 300', f0.full, 300);
eq('及格线 180', f0.pass, 180);
eq('缺必考语文', f0.missingCore.join(','), '语文');
eq('total 253', Score.total(r0), 253);
ok('得分率仍按 300 算（84.3%），不被 0 分拉低', Math.round(Score.totalRate(r0) * 1000) / 10 === 84.3,
  'rate=' + Score.totalRate(r0));
ok('未计入科目进 absent', build(r0, [r0], 100).absent.join(',').indexOf('语文') >= 0);

console.log('\n=== 5. 选科超 3 门：按最高 3 门计入（overflow） ===');
const f9 = Score.fields(r9);
eq('overflow = true', f9.overflow, true);
eq('选科仍只计 3 门', f9.electiveCount, 3);
eq('计入选科 = 物理/政治/生物', f9.elective.join(','), '3,5,8');
eq('被舍弃 = 化学/历史/地理', f9.dropped.join(','), '化学,历史,地理');
eq('总分 634（118+132+121+88+90+85）', Score.total(r9), 634);
eq('满分仍是 750', f9.full, 750);
const an9 = build(r9, [r9], 1000);
eq('各科只列计入的 6 科', an9.subjects.length, 6);
eq('dropped 数组', an9.dropped.join(','), '化学,历史,地理');
eq('absent 为空（9 科都有分）', an9.absent.length, 0);
ok('总结说明「按最高 3 门计入」',
  an9.summary.paragraphs.join('').indexOf('按最高 3 门计入') >= 0, an9.summary.paragraphs.join(''));

console.log('\n=== 6. 同分选科按固定顺序（物理→化学→政治→历史→地理→生物） ===');
const tie = Score.fields(rec({ scores: [0, 0, 0, 80, 80, 80, 80, 0, 0] }));
eq('同分取前 3 门固定顺序', tie.elective.join(','), '3,4,5');
eq('被舍弃 = 历史', tie.dropped.join(','), '历史');

console.log('\n=== 7. 不同满分学生按得分率排名 ===');
ok('B（623/750）绝对分高于 A（400/450）', Score.total(r6) > Score.total(rX));
ok('A 得分率高于 B', Score.totalRate(rX) > Score.totalRate(r6));
eq('A 得分率排名第 1', Score.rankByRate([rX, r6], rX).rank, 1);
eq('B 得分率排名第 2', Score.rankByRate([rX, r6], r6).rank, 2);
eq('无成绩 valid=false', Score.rankByRate([rX, r6], rec({ scores: Z9() })).valid, false);
eq('rankOf(total) 走得分率', Score.rankOf([rX, r6], rX, 'total').rank, 1);
eq('单科排名仍按分数', Score.rankOf([rX, r6], rX, 0).rank, 1);

console.log('\n=== 8. 班级排名取班级池，教师录入只作年级排名 ===');
const c1 = rec({ name: '甲', scores: S6.slice(), totalRank: 800, ranks: new Array(9).fill(800) });
const c2 = rec({ name: '乙', scores: SLOW.slice(), totalRank: 900 });
const c3 = rec({ name: '丙', scores: [96, 100, 96, 50, 45, 0, 0, 0, 52], totalRank: 950 });
const anC = build(c1, [c1, c2, c3], 1739);
eq('总分班级排名 1', anC.rankTable[0].rankClass, 1);
eq('总分年级排名 = 教师录入 800', anC.rankTable[0].rankGrade, 800);
eq('年级排名来源 teacher', anC.rankTable[0].rankGradeSource, 'teacher');
eq('班级有效人数 3', anC.rankTable[0].classTotal, 3);
ok('单科年级排名取教师录入 800', anC.rankTable.filter(function (x) { return x.idx !== 'total'; })
  .every(function (x) { return x.rankGrade === 800; }));
const htmlRankC = render.sectionRank(anC, { n: 1739, source: 'web', note: '2025 年招生计划' });
ok('位次节同表展示班级 1 / 年级 800',
  htmlRankC.indexOf('<td class="num">1</td>') >= 0 && htmlRankC.indexOf('<td class="num">800</td>') >= 0);

console.log('\n=== 9. 百分位不可计算（排名超出年级人数）→ 显示 — 并提示核对 ===');
const bad = rec({ name: '丁', scores: S6.slice(), totalRank: 300, ranks: new Array(9).fill(300) });
const anBad = build(bad, [bad, c2, c3], 0);      // 年级人数未知 → rankTotal = 3
eq('rankTotal 退回样本人数 3', anBad.overview.rankTotal, 3);
eq('rank 仍为录入值 300', anBad.overview.rank, 300);
eq('pct 归零', anBad.overview.pct, 0);
eq('pctInvalid true', anBad.overview.pctInvalid, true);
ok('要点给出核对年级人数提示', anBad.summary.bullets.join('').indexOf('待核对') >= 0, anBad.summary.bullets.join(' | '));
ok('总结不出现「位次偏后」', anBad.summary.paragraphs.join('').indexOf('位次偏后') < 0);
ok('单科 reasons 不写「前 0%」', anBad.subjects.every(function (s) { return s.reasons.join('').indexOf('前 0%') < 0; }));
const htmlRankBad = render.sectionRank(anBad, { n: null, source: null, note: '年级人数未知' });
ok('位次表百分位显示 —', htmlRankBad.indexOf('>—</td>') >= 0, htmlRankBad.slice(0, 400));
ok('表下提示超出年级人数', htmlRankBad.indexOf('超出年级人数 3') >= 0 && htmlRankBad.indexOf('百分位暂不计算') >= 0);

console.log('\n=== 10. 总结精简：≤2 段 × ≤2 句、3 条建议、3~4 条要点 ===');
const an6 = build(r6, [r6, c2, c3], 1000);
ok('段落数 ≤ 2', an6.summary.paragraphs.length <= 2, String(an6.summary.paragraphs.length));
ok('每段 ≤ 2 句', an6.summary.paragraphs.every(function (p) {
  return (p.match(/[。！？]/g) || []).length <= 2;
}), an6.summary.paragraphs.join(' || '));
eq('建议恰好 3 条', an6.summary.advice.length, 3);
ok('要点 3~4 条', an6.summary.bullets.length >= 3 && an6.summary.bullets.length <= 4,
  String(an6.summary.bullets.length));
ok('headline 含总分/满分/得分率',
  an6.summary.headline.indexOf('623') >= 0 && an6.summary.headline.indexOf('750') >= 0 &&
  an6.summary.headline.indexOf('得分率') >= 0, an6.summary.headline);
ok('headline 单句', (an6.summary.headline.match(/[。！？]/g) || []).length <= 1);
eq('overview.full = 750', an6.overview.full, 750);
eq('overview.passLine = 450', an6.overview.passLine, 450);
eq('overview.subjectCount = 6', an6.overview.subjectCount, 6);
eq('overview.electiveCount = 3', an6.overview.electiveCount, 3);
eq('overview.complete = true', an6.overview.complete, true);
eq('overview.overflow = false', an6.overview.overflow, false);
eq('overview.missingCore 空', an6.overview.missingCore.length, 0);

console.log('\n=== 11. 无旧口径文案（九科 / 1050 / 630） ===');
const an3 = build(r3, [r3], 1000);
const allText = [an6, an3, an9, anC, anBad].map(function (a) {
  return a.summary.headline + a.summary.paragraphs.join('') +
    a.summary.bullets.join('') + a.summary.advice.join('');
}).join('|');
ok('无「九科」', allText.indexOf('九科') < 0, allText.slice(0, 200));
ok('无「1050」', allText.indexOf('1050') < 0);
ok('无「630」', allText.indexOf('630') < 0);

console.log('\n=== 12. 占比：只列计入科目，两个占比各自合计 100% ===');
const sumFullShare = an6.share.reduce(function (a, s) { return a + s.fullShare; }, 0);
const sumScoreShare = an6.share.reduce(function (a, s) { return a + s.scoreShare; }, 0);
near('fullShare 合计 100', sumFullShare, 100, 0.01);
near('scoreShare 合计 100', sumScoreShare, 100, 0.01);
eq('share 只含计入科目（6 条）', an6.share.length, 6);
near('3 科学生 fullShare 合计 100',
  an3.share.reduce(function (a, s) { return a + s.fullShare; }, 0), 100, 0.01);

console.log('\n=== 13. 总分对比改用得分率差 ===');
near('classCmp.total.rate = 个人得分率', anC.classCmp.total.rate * 100, anC.overview.totalRate * 100, 0.01);
ok('classCmp.total 带 rateDiff', typeof anC.classCmp.total.rateDiff === 'number');
ok('单科对比仍带分数差 diff', typeof anC.classCmp.rows[0].diff === 'number');
ok('单科对比同时带 rateDiff', typeof anC.classCmp.rows[0].rateDiff === 'number');

console.log('\n=== 14. 提分 delta 守恒 + 动态满分封顶 ===');
const plan6 = P.build({ target: r6, analysis: an6, loc: {}, gradeRows: [c2, c3], classRows: [r6, c2, c3] });
const sumD6 = plan6.perSubject.reduce(function (a, x) { return a + x.delta; }, 0);
near('Σdelta = plan.delta', sumD6, plan6.delta);
near('目标总分 = 当前 + delta', plan6.targetTotal, an6.overview.total + plan6.delta);
ok('目标总分 ≤ 动态满分 750', plan6.targetTotal <= 750, String(plan6.targetTotal));
ok('只对计入科目分摊（6 条）', plan6.perSubject.length === 6, String(plan6.perSubject.length));
const plan3 = P.build({ target: r3, analysis: an3, loc: {}, gradeRows: [], classRows: [r3] });
const sumD3 = plan3.perSubject.reduce(function (a, x) { return a + x.delta; }, 0);
near('3 科 Σdelta 守恒', sumD3, plan3.delta);
ok('3 科目标总分 ≤ 450', plan3.targetTotal <= 450, String(plan3.targetTotal));
ok('3 科只分摊语数英（3 条）', plan3.perSubject.length === 3, String(plan3.perSubject.length));

console.log('\n=== 15. 里程碑边界：无排名时不生成「前 0 名」 ===');
const planNoRank = P.build({
  target: rec({ name: '无排名', scores: S6.slice(), totalRank: 0 }),
  analysis: { overview: { total: 623, full: 750, passLine: 450, gradeAvg: 600, rank: 0 } },
  loc: { ok: true, tierName: '二本A', gap: 12, nextName: '重点本科', nextLimit: 100 },
  gradeRows: [c2, c3]
});
const mText = planNoRank.milestones.map(function (m) { return m.note; }).join(' | ');
ok('里程碑不含「前 0 名」', mText.indexOf('前 0 名') < 0, mText);
ok('改为待补充排名后确定', mText.indexOf('待补充排名后确定') >= 0, mText);
const planRank = P.build({
  target: rec({ name: '有排名', scores: S6.slice(), totalRank: 200 }),
  analysis: { overview: { total: 623, full: 750, passLine: 450, gradeAvg: 600, rank: 200 } },
  /* 定位表行：985 线对应名次上限 120 名（名次节点改由定位表给出，不再用「当前名次 − 缺口」反推） */
  loc: {
    ok: true, tierName: '二本A', gap: 12, nextName: '重点本科', nextLimit: 100,
    grade: '28届', school: '纪中', row: { t985: 120, t211: 400, ttk: 600, ta: 900, tb: 1100 }
  },
  gradeRows: [c2, c3]
});
ok('有排名时里程碑名次取自定位表上限',
  planRank.milestones.map(function (m) { return m.note; }).join('').indexOf('前 120 名') >= 0,
  planRank.milestones.map(function (m) { return m.note; }).join(' | '));
eq('目标总分对标 985 线 630 分（623 → 630）', planRank.targetTotal, 630);
eq('目标批次标签为 985线', planRank.targetLine && planRank.targetLine.name, '985线');
eq('定位表名次上限回传', planRank.rankCutoff, 120);

console.log('\n=== 16. 提分动作：每条都有频次 + 可验收标准 ===');
const sp = fs.readFileSync(path.join(SRC, 'study-plan.js'), 'utf8');
const block = sp.slice(sp.indexOf('var ACTIONS'), sp.indexOf('function actionsOf'));
const actions = block.split('\n').map(function (l) { return l.trim(); })
  .filter(function (l) { return /^'[^']+',?$/.test(l); })
  .map(function (l) { return l.replace(/^'/, '').replace(/',?$/, ''); });
eq('动作条数 81（9 科 × 3 档 × 3 条）', actions.length, 81);
const RE_FREQ = new RegExp('(每天|每日|每周|每两周|每月|连续 ?[0-9]+ ?天|周末)');
const RE_ACC = new RegExp('(正确率|全对|目标|≥|得分率|完整度|覆盖|自评|失分|错 ?≤|以上|控制在)');
const noFreq = actions.filter(function (a) { return !RE_FREQ.test(a); });
const noAcc = actions.filter(function (a) { return !RE_ACC.test(a); });
eq('无频次动作 0 条', noFreq.length, 0);
eq('无验收动作 0 条', noAcc.length, 0);
if (noFreq.length) console.log('    无频次: ' + noFreq.join(' / '));
if (noAcc.length) console.log('    无验收: ' + noAcc.join(' / '));

console.log('\n=== 17. 整篇报告六节渲染（不出现章节渲染失败 / 旧口径） ===');
function full(target, rows, gradeN) {
  return render.reportHTML(target, rows.filter(function (r) { return r.cls === target.cls; }), [target], gradeN);
}
const rep6 = full(r6, [r6, c2, c3], { n: 1000, source: 'manual', note: '手动填写' });
ok('报告无「渲染失败」', rep6.indexOf('渲染失败') < 0);
const SECTIONS = ['一、成绩总览', '二、各科表现', '三、位次', '四、趋势', '五、优势与短板', '六、阶段规划'];
ok('六节标题齐全', SECTIONS.every(function (t) { return rep6.indexOf(t) >= 0; }),
  SECTIONS.filter(function (t) { return rep6.indexOf(t) < 0; }).join(','));
ok('报告无「九科」', rep6.indexOf('九科') < 0);
ok('报告无「1050」', rep6.indexOf('1050') < 0);
ok('报告目标总分对标 26 届批次线（出现「批次线」或「线」档位字样）',
  rep6.indexOf('批次线') >= 0 || rep6.indexOf('985线') >= 0);
ok('报告不再出现「按每名分差估算」的旧口径', rep6.indexOf('每名分差') < 0);
ok('总分显示 623 / 750', rep6.indexOf('623') >= 0 && rep6.indexOf('750') >= 0);
ok('含得分率条形 + 60% 基准 + 班均竖标',
  rep6.indexOf('rate-bar') >= 0 && rep6.indexOf('rate-base') >= 0 && rep6.indexOf('rate-avg') >= 0);
ok('未出现旧十节冗余标题', rep6.indexOf('五、班级均分对比') < 0 && rep6.indexOf('八、成绩总结') < 0);
ok('报告内嵌院校定位明细（无「九、院校定位」章标题）',
  rep6.indexOf('九、院校定位') < 0 && rep6.indexOf('院校定位明细') >= 0, rep6.indexOf('院校定位明细'));

const bad2 = rec({ name: '戊', school: '江门培英', scores: S6.slice(), totalRank: 300, ranks: new Array(9).fill(300) });
const repBad = full(bad2, [bad2, c2, c3], null);
ok('异常排名报告无渲染失败', repBad.indexOf('渲染失败') < 0);
ok('百分位显示 —', repBad.indexOf('>—</td>') >= 0);
ok('给出核对提示', repBad.indexOf('百分位暂不计算') >= 0);

console.log('\n=== 18. 趋势：得分率折线 + 单次考试降级 ===');
const prev = rec({ name: '甲', exam: '零模', scores: [108, 120, 112, 72, 62, 0, 0, 0, 74] });
const anT = A.build({
  target: c1, classRows: [c1, c2], gradeRows: [c1, c2],
  studentRows: [prev, c1], gradeSize: { n: 1000, source: 'manual', note: '测试' }, track: '物理类'
});
ok('两次考试：每条记录带得分率', anT.trend.exams.every(function (e) { return typeof e.rate === 'number'; }));
const htmlT = render.sectionTrend(anT, c1);
ok('两次考试输出折线占位', htmlT.indexOf('an-chart-trend') >= 0);
ok('结论 1：共 2 次考试', htmlT.indexOf('共 2 次考试') >= 0);
ok('结论 2：进退科目', htmlT.indexOf('进步科目') >= 0 && htmlT.indexOf('退步科目') >= 0);
ok('趋势带得分率百分点', htmlT.indexOf('个百分点') >= 0);
const htmlT1 = render.sectionTrend(an6, r6);
ok('单次考试给出提示', htmlT1.indexOf('仅 1 次考试') >= 0);
eq('「仅 1 次考试」只出现 1 次', (htmlT1.match(/仅 1 次考试/g) || []).length, 1);

console.log('\n=== 19. GradeSize 科类回退标注 ===');
const g1 = GS.estimate({ school: '纪中', grade: '30届', track: '物理类' });
eq('无定位表行时用联网人数', g1.n, 1739);
eq('source web', g1.source, 'web');
eq('approxTrack = true', g1.approxTrack, true);
ok('note 注明整届/非单科类', g1.note.indexOf('非单科类人数') >= 0, g1.note);
const g2 = GS.estimate({ school: '纪中', grade: '30届', track: '' });
eq('未指定科类 approxTrack = false', g2.approxTrack, false);
const g3 = GS.estimate({ school: '纪中', grade: '28届', track: '物理类' });
eq('定位表命中科类行', g3.n, 1406);

console.log('\n=== 20. 各科表现：未计入科目一行小字 ===');
const htmlSubj6 = render.sectionSubjects(an6);
eq('6 科 + 总分 = 7 条得分率条', (htmlSubj6.match(/rate-bar/g) || []).length, 7);
ok('6 科学生有「缺考 / 未选」说明', htmlSubj6.indexOf('缺考 / 未选') >= 0);
const htmlSubj9 = render.sectionSubjects(an9);
ok('9 科全填的学生提示「超 3 门舍弃」', htmlSubj9.indexOf('超 3 门舍弃') >= 0);
ok('列出被舍弃的化学', htmlSubj9.indexOf('化学') >= 0);
const htmlSubj0 = render.sectionSubjects(build(r0, [r0], 100));
ok('缺必考语文时给出提示', htmlSubj0.indexOf('语文') >= 0);

console.log('\n=== 21. Score.stat 总分列：full/line 取样本内动态均值 + avgFull ===');
const st6 = Score.stat([r6, c1, c2], 'total');          // 依次 750 / 750 / 750
eq('样本动态满分均值 750', st6.avgFull, 750);
eq('full = avgFull', st6.full, 750);
eq('line = 750 × 60% = 450', st6.line, 450);
const mixPool = Score.stat([r6, r3], 'total');          // 750 与 450 混合
eq('混合样本 avgFull = 600', mixPool.avgFull, 600);
eq('混合样本 line = round(600 × 60%) = 360', mixPool.line, 360);
eq('mixed avgRate = 平均得分率', Math.round((0.8307 + 0.8244) / 2 * 1000) / 10,
  Math.round(mixPool.avgRate * 1000) / 10);
const stSubj = Score.stat([r6, c1], 0);
eq('单科 full 仍是 150', stSubj.full, 150);
eq('单科 line 仍是 90', stSubj.line, 90);

console.log('\n=== 22. 边界：完全没填成绩的学生 ===');
const empty = rec({ name: '空记录', scores: Z9() });
const fe = Score.fields(empty);
eq('满分 0', fe.full, 0);
eq('及格线 0', fe.pass, 0);
eq('计入 0 科', fe.all.length, 0);
eq('total 0', Score.total(empty), 0);
eq('得分率 0', Score.totalRate(empty), 0);
eq('rankByRate valid=false', Score.rankByRate([r6, empty], empty).valid, false);
const anE = build(empty, [empty, r6], 100);
eq('absent 9 科', anE.absent.length, 9);
eq('subjects 空', anE.subjects.length, 0);
eq('overview.complete = false', anE.overview.complete, false);
ok('空记录总结不抛错且含 0', anE.summary.headline.indexOf('/ 0') >= 0, anE.summary.headline);
const repE = full(empty, [empty, r6], null);
ok('空记录报告无渲染失败', repE.indexOf('渲染失败') < 0);
const planE = P.build({ target: empty, analysis: anE, loc: {}, gradeRows: [r6], classRows: [empty, r6] });
eq('空记录 plan.delta = 0', planE.delta, 0);
eq('空记录无分摊科目', planE.perSubject.length, 0);

console.log('\n=== 23. 脏数据：单科超满分（得分率必须 clamp，目标分必须封顶）===');
/* 物化生各填 110（满分 100）→ 总分 780 > 动态满分 750 */
const rOver = rec({ name: '超满分', exam: '一模', scores: [150, 150, 150, 110, 110, 0, 0, 0, 110], totalRank: 5 });
eq('总分 780（不静默截断）', Score.total(rOver), 780);
eq('动态满分 750', Score.fullTotal(rOver), 750);
eq('Score.totalRate clamp 到 1', Score.totalRate(rOver), 1);
const anOver = build(rOver, [rOver, rec({ name: '乙', scores: [120, 120, 120, 80, 80, 0, 0, 0, 80] })], 100);
eq('overview.totalRate clamp 到 1', anOver.overview.totalRate, 1);
eq('classCmp.total.rate clamp 到 1', anOver.classCmp.total.rate, 1);
eq('gradeCmp.total.rate clamp 到 1', anOver.gradeCmp.total.rate, 1);
eq('rankTable 总分 rate clamp 到 1', anOver.rankTable[0].rate, 1);
ok('share.rate 均 ≤ 100%', anOver.share.every(function (s) { return s.rate <= 1; }));
const overText = JSON.stringify(anOver.summary);
ok('总结中不出现 104%', overText.indexOf('104') < 0, anOver.summary.headline);
ok('headline 得分率 100%', anOver.summary.headline.indexOf('得分率 100%') >= 0, anOver.summary.headline);
ok('平均得分率不超 1（stat clamp）', Score.stat([rOver], 'total').avgRate <= 1,
  String(Score.stat([rOver], 'total').avgRate));
const repOver = full(rOver, [rOver], { n: 100, source: 'manual', note: 'x' });
ok('报告不出现「104%」', repOver.indexOf('104%') < 0);
ok('报告无渲染失败', repOver.indexOf('渲染失败') < 0);
const planOver = P.build({ target: rOver, analysis: anOver, loc: {}, gradeRows: [rOver], classRows: [rOver] });
ok('目标总分 ≤ 动态满分 750', planOver.targetTotal <= 750, String(planOver.targetTotal));
eq('delta 回落为 0', planOver.delta, 0);
near('Σdelta ≡ delta', planOver.perSubject.reduce(function (a, x) { return a + x.delta; }, 0), planOver.delta);
ok('说明里点出「超满分」需核对',
  planOver.paragraphs.join('').indexOf('超满分') >= 0, planOver.paragraphs[1]);

console.log('\n=== 24. 入口截断：超满分进不了 Store（Score.clampScores / upsert）===');
/* 治本：不在渲染层兜底，而是在写库前按单科满分截断 */
const dirty = rec({ name: '脏数据', exam: '一模', scores: [160, 150, 150, 110, 105, 0, 0, 0, -20] });
const normed = Score.clampScores(dirty);
eq('语文 160 → 150', normed.rec.scores[0], 150);
eq('物理 110 → 100', normed.rec.scores[3], 100);
eq('化学 105 → 100', normed.rec.scores[4], 100);
eq('生物 -20 → 0', normed.rec.scores[8], 0);
eq('截断清单命中 3 科（生物只归零不算超满分）', normed.clamped.length, 3, normed.clamped.join('、'));
ok('截断清单带科目名（语文/物理/化学）',
  normed.clamped.indexOf('语文') >= 0 && normed.clamped.indexOf('物理') >= 0 &&
  normed.clamped.indexOf('化学') >= 0, normed.clamped.join('、'));
/* 生物被归零后只剩物理/化学 2 门选科 → 满分 450 + 200 = 650 */
eq('截断后总分 = 650（3 必考 + 2 选科）', Score.total(dirty), 650);
eq('截断后动态满分 = 650', Score.fullTotal(dirty), 650);
ok('截断后总分不超动态满分', Score.total(dirty) <= Score.fullTotal(dirty));
eq('截断后得分率 = 100%', Math.round(Score.totalRate(dirty) * 100), 100);

/* upsert 必须把 clamped 明细回传给调用方（UI 据此 toast），且落库值已被截断 */
App.Store.init();
const resUp = Score.upsert(rec({
  name: '落库校验', school: '纪中', cls: '28届', exam: '二模',
  scores: [151, 100, 100, 120, 0, 0, 0, 0, 0], ranks: Z9(), totalRank: 3
}));
ok('upsert 返回值带 clamped 明细', Array.isArray(resUp.clamped) && resUp.clamped.length === 2,
  JSON.stringify(resUp.clamped));
eq('Store 中语文已截断到 150', App.Store.data.records[0].scores[0], 150);
eq('Store 中物理已截断到 100', App.Store.data.records[0].scores[3], 100);
ok('Store 内无超满分成绩', App.Store.data.records.every(function (r) {
  return r.scores.every(function (v, i) { return (Number(v) || 0) <= K.SUBJECT_FULL[i]; });
}));

/* ---------- 排名层：脏数据不得越位到合法满分生之前 ---------- */
const rCleanMax = rec({ name: '满分生', exam: '一模', scores: [150, 150, 150, 100, 100, 0, 0, 0, 100] }); // 750/750
const rDirtyMax = rec({ name: '脏数据', exam: '一模', scores: [150, 150, 150, 110, 110, 0, 0, 0, 110] }); // 780/750
eq('脏数据原始总分 780', Score.total(rDirtyMax), 780);
eq('两者得分率都被 clamp 到 100%',
  Score.totalRate(rCleanMax) === 1 && Score.totalRate(rDirtyMax) === 1, true);
eq('脏数据不得排在满分生之前', Score.rankByRate([rCleanMax, rDirtyMax], rCleanMax).rank, 1);
eq('截断后两者同率同分 → 脏数据最多并列第 1，不越位',
  Score.rankByRate([rCleanMax, rDirtyMax], rDirtyMax).rank, 1);
eq('合法同率仍按绝对分排序（B 600 > A2 360 → A2 第 2）',
  Score.rankByRate([rec({ name: 'A', scores: [120, 120, 120, 0, 0, 0, 0, 0, 0] }),
    rec({ name: 'B', scores: [150, 150, 150, 50, 50, 0, 0, 0, 50] })],
  rec({ name: 'A2', scores: [120, 120, 120, 0, 0, 0, 0, 0, 0] })).rank, 2);
/* app.js 的 recomputeRanks 必须与 core 对称（源码级守门，Node 下无 DOM 跑不到） */
const APP_SRC = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
ok('recomputeRanks 用了 Math.min(1, t / f)', APP_SRC.indexOf('Math.min(1, t / f)') >= 0);
ok('recomputeRanks 率同时的绝对分也按满分截断', APP_SRC.indexOf('var tc = t > f ? f : t;') >= 0);

/* =========================================================
 * 25. 目标总分 = 26 届批次线（名次反推口径已废弃）
 * ========================================================= */
console.log('\n=== 25. 目标总分：26 届批次线 × 定位表名次 ===');
const L26 = P.LINES26 || {};
eq('物理类五条批次线', (L26['物理类'] || []).map(function (x) { return x.line; }).join(','), '425,500,539,600,630');
eq('历史类五条批次线', (L26['历史类'] || []).map(function (x) { return x.line; }).join(','), '440,500,546,600,630');

/* 直接给分构造某个总分；测试先断言总分与预期一致，避免分数算错却以为是逻辑错
 * locExtra：传 {ok:true, tierName, nextName, nextLimit, rank} 时走「定位表档次 → 批次线」主路径，
 *           不传则模拟「无排名/定位表无数据」，走「分数就近对标」分支。 */
function linePlan(scores, totalRank, locRow, track, locExtra) {
  const t = rec({ name: '线测', scores: scores, totalRank: totalRank || 0 });
  const ov = {
    total: Score.total(t), full: Score.fullTotal(t),
    passLine: Score.passTotal(t), gradeAvg: 500, rank: totalRank || 0
  };
  const loc = Object.assign({
    ok: false, track: track || '', row: locRow || { t985: 300, t211: 511, ttk: 1011, ta: 1100, tb: 1142 },
    grade: '29届', school: '纪中'
  }, locExtra || {});
  return {
    plan: P.build({ target: t, analysis: { overview: ov }, loc: loc, gradeRows: [] }),
    total: ov.total
  };
}

/* 物理类：[语,数,英,物,化,政,史,地,生] */
const P460 = linePlan([100, 100, 100, 80, 40, 0, 0, 0, 40]);
eq('物理类 460 分', P460.total, 460);
eq('460 → 目标二本A线 500', P460.plan.targetTotal, 500);
eq('460 不是压线', P460.plan.onLine, false);
ok('460 文案给出距线 40 分', P460.plan.paragraphs.join('').indexOf('距该线 40 分') >= 0,
  P460.plan.paragraphs.join(' | '));

const P500 = linePlan([110, 110, 110, 70, 50, 0, 0, 0, 50]);
eq('物理类 500 分', P500.total, 500);
eq('压线 500 → 目标上一档 539（压线不算已过）', P500.plan.targetTotal, 539);
eq('压线标记 onLine = true', P500.plan.onLine, true);
eq('压线时当前档为二本A', P500.plan.curLine && P500.plan.curLine.name, '二本A线');
ok('压线文案说明同分并列', P500.plan.paragraphs.join('').indexOf('压线未稳') >= 0,
  P500.plan.paragraphs.join(' | '));

const P539 = linePlan([120, 120, 120, 60, 60, 0, 0, 0, 59]);
eq('物理类 539 分', P539.total, 539);
eq('压线 539 → 目标双一流线 600', P539.plan.targetTotal, 600);
eq('539 目标档名次上限取定位表 t211 = 511', P539.plan.rankCutoff, 511);

const P424 = linePlan([95, 95, 94, 50, 45, 0, 0, 0, 45]);
eq('物理类 424 分', P424.total, 424);
eq('424（未达本科线）→ 目标 425', P424.plan.targetTotal, 425);

const P425 = linePlan([95, 95, 95, 50, 45, 0, 0, 0, 45]);
eq('物理类 425 分', P425.total, 425);
eq('压线本科线 425 → 目标 500', P425.plan.targetTotal, 500);
eq('425 压线标记', P425.plan.onLine, true);

const PTop = linePlan([145, 145, 145, 65, 65, 0, 0, 0, 65]);
eq('物理类 630 分', PTop.total, 630);
eq('已越 985 线 → 转为 +10 稳线冲分', PTop.plan.targetTotal, 640);
eq('top 分支来源', PTop.plan.targetTotalSource, 'top');

/* 历史类：物 0 分、历史有分 */
const H446 = linePlan([100, 100, 100, 0, 40, 0, 60, 46, 0]);
eq('历史类 446 分', H446.total, 446);
eq('历史类 446 → 目标 500（本科线 440 已过）', H446.plan.targetTotal, 500);
eq('历史类科类识别', H446.plan.track, '历史类');

const H440 = linePlan([98, 98, 98, 0, 40, 0, 60, 46, 0]);
eq('历史类 440 分', H440.total, 440);
eq('压线本科线 440 → 目标 500', H440.plan.targetTotal, 500);
eq('440 压线标记', H440.plan.onLine, true);

const H546 = linePlan([120, 120, 120, 0, 60, 0, 66, 60, 0]);
eq('历史类 546 分', H546.total, 546);
eq('压线特控线 546 → 目标 600', H546.plan.targetTotal, 600);
eq('历史类特控线 546 ≠ 物理类 539', H546.plan.curLine && H546.plan.curLine.line, 546);

/* 只填语数英（没有物理/历史）→ 科类无法判定，不套批次线，退回得分率档位 */
const P3 = linePlan([140, 140, 140, 0, 0, 0, 0, 0, 0]);
eq('3 科总分 420', P3.total, 420);
eq('3 科 420：科类无法判定 → 退回 fallback', P3.plan.targetTotalSource, 'fallback');
eq('3 科 420 的保底目标 430', P3.plan.targetTotal, 430);
ok('文案要求补录物理/历史成绩', P3.plan.paragraphs.join('').indexOf('补录物理或历史成绩') >= 0,
  P3.plan.paragraphs.join(' | '));

const P3b = linePlan([150, 150, 150, 0, 0, 0, 0, 0, 0]);
eq('3 科满分 450', P3b.total, 450);
eq('3 科 450：已达该组合满分，目标 450', P3b.plan.targetTotal, 450);

/* 物理、历史都 0 分 → 同样不判定科类 */
const PNo = linePlan([60, 60, 60, 0, 40, 40, 0, 0, 40], 0, null, '');
eq('科类无法判定走 fallback', PNo.plan.targetTotalSource, 'fallback');
eq('科类未判定标记 trackAssumed', PNo.plan.trackAssumed, true);
ok('科类未判定不产生批次线目标', !PNo.plan.targetLine);

/* 物理、历史同时有分（数据异常）→ 也不能硬判，按未判定处理 */
const PBoth = linePlan([100, 100, 100, 60, 0, 0, 60, 0, 0], 0, null, '');
eq('物史同时有分 → 不判定科类', PBoth.plan.trackAssumed, true);
eq('物史同时有分走 fallback', PBoth.plan.targetTotalSource, 'fallback');

/* 主路径：定位表档次 → 该档次 26 届批次线（分数与名次不一致时以定位表为主） */
const R460 = linePlan([100, 100, 100, 80, 40, 0, 0, 0, 40], 420, null, '物理类',
  { ok: true, tierName: '二本A', nextName: '重点本科', nextLimit: 600, rank: 420 });
eq('定位表给「重点本科」→ 目标取特控线 539（不是按分数就近的 500）', R460.plan.targetTotal, 539);
eq('目标由定位表档次决定', R460.plan.targetFromRank, true);
eq('名次上限回传 600', R460.plan.rankCutoff, 600);
ok('文案同时给名次与分数线', R460.plan.paragraphs.join('').indexOf('需进入前 600 名') >= 0,
  R460.plan.paragraphs.join(' | '));

/* 分数已越过名次目标线（分数跑在名次前面）→ 顺延到分数之上的最近一条线 */
const R545 = linePlan([112, 118, 105, 72, 68, 0, 0, 0, 70], 420, null, '物理类',
  { ok: true, tierName: '双一流层次', nextName: '二本A', nextLimit: 900, rank: 420 });
eq('545 分：名次目标线 500 已被越过 → 顺延到 600', R545.plan.targetTotal, 600);

/* 名次正好等于当前档次的划线上限 → 压线进档提示（同分并列可能被挤出） */
const REdge = linePlan([100, 100, 100, 80, 40, 0, 0, 0, 40], 1011, null, '物理类',
  { ok: true, tierName: '重点本科', nextName: '双一流层次', nextLimit: 511, limit: 1011, rank: 1011 });
eq('名次卡在当前档划线上限 → rankOnEdge', REdge.plan.rankOnEdge, true);
ok('文案提示压线进档并给余量建议', REdge.plan.paragraphs.join('').indexOf('压线进档') >= 0 &&
  REdge.plan.paragraphs.join('').indexOf('留出余量') >= 0, REdge.plan.paragraphs.join(' | '));

/* 增量守恒与封顶（沿用到新口径） */
const sumD = P460.plan.perSubject.reduce(function (a, x) { return a + x.delta; }, 0);
ok('Σ单科 delta ≡ 总 delta（460 案例）', Math.abs(sumD - P460.plan.delta) < 0.51,
  sumD + ' vs ' + P460.plan.delta);
ok('目标总分不超过动态满分', P460.plan.targetTotal <= 750);

console.log('\n=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===\n');
process.exit(fail ? 1 : 0);
