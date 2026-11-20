/* =========================================================
 * tools/qa-v3-ui.js —— v3「考试年月」UI / 导出契约独立回归
 *   node tools/qa-v3-ui.js
 *
 * 由 V3-3（成绩模块 UI）交付，QA 独立从「验收口径」反向验证，
 * 数据、断言均不复用 qa-v3-core.js / qa-750.js / smoke-analysis.js。
 *
 * 三组断言：
 *   1) V-F1：26 列导出契约零改动 golden diff
 *      - masterExportRows() 只定义在 js/module-score.js；
 *      - 用 git show HEAD:js/module-score.js 取改造前版本，函数体逐字比对；
 *      - 真实执行函数，断言表头 26 列、列名顺序、不含「考试年月」列，
 *        并把改造前 26 列列名数组硬编码为 golden 兜底。
 *   2) D5：x 轴 label golden diff
 *      - 全缺年月序列逐字回退（无前缀、无 8 字截断）；
 *      - 混合序列四种前缀分支：未标注· / 异常· / YY年· / M月·，等长同序。
 *   3) 混合序列趋势图 x 轴长度对齐保护
 *      - 从 module-score.js 真实源码抽取两处 label 构造块（与 qa-750.js 的
 *        reportHTML 抽取同法），用真实 Score.examAxisLabels 求值，
 *        验证 labels / labelTitles 与 score / rank 等长、不错位；
 *      - 用真实 charts.js dualLine + 假 DOM 验证只在 labelTitles[i]
 *        非 null/undefined 时挂 <title>，不传时行为向后兼容。
 *
 * 说明：被测函数（masterExportRows / examAxisLabels / 两处 label 构造块 /
 * charts.js dualLine）全部取自真实源码、真实执行；只对其协作者提供夹具
 * （masterRowsData 返回一行样本、studentRows/exs/sc 为构造数据、DOM 为假节点），
 * 不 stub 被测函数本身。
 * ========================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'js');

/* ---------- 断言框架（与 tools/ 现有套件同风格） ---------- */
let pass = 0, fail = 0;
const FAILS = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  FAILS.push(name + (detail === undefined ? '' : ' → ' + detail));
}
function eq(name, actual, expect) {
  ok(name, actual === expect,
    'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}
function eqArr(name, actual, expect) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expect),
    'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}

/* ---------- 假 DOM：只支持 charts.js 用到的 createElementNS ---------- */
function fakeEl(tag) {
  return {
    tag: tag,
    attrs: {},
    children: [],
    _text: null,
    setAttribute: function (k, v) { this.attrs[k] = v; },
    appendChild: function (c) { this.children.push(c); return c; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; }
  };
}

/* ---------- vm sandbox：装载真实 core.js + charts.js ---------- */
const sandbox = {
  console: console,
  localStorage: { getItem: () => null, setItem: () => { }, removeItem: () => { } },
  document: {
    getElementById: () => null,
    createElement: (t) => fakeEl(t),
    createElementNS: (ns, t) => fakeEl(t),
    addEventListener: () => { }
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
['core.js', 'charts.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
});

const App = sandbox.App;
const Score = App.Score;
const K = App.K;
const U = App.U;
const S = K.SUBJECTS;
const Chart = App.Chart;

/* ---------- 通用源码工具 ---------- */

/** 用花括号配对抽取 `function <name>(...){...}` 全文（跳过字符串与注释） */
function extractFunction(src, name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** 抽取 [startMarker, endMarker) 之间的真实源码片段 */
function extractBlock(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  const j = src.indexOf(endMarker, i);
  if (j < 0) return null;
  return src.slice(i, j);
}

/** 递归收集 svg 树里的所有 <title> 节点文本 */
function collectTitles(node, out) {
  out = out || [];
  (node.children || []).forEach(function (c) {
    if (c.tag === 'title') out.push(c._text);
    collectTitles(c, out);
  });
  return out;
}

/** x 轴标签：dualLine 默认 H=380 / pt=34 / pb=76 → y = 34+270+18 = 322 */
function xAxisTexts(svg) {
  return (svg.children || []).filter(function (n) {
    return n.tag === 'text' && n.attrs['text-anchor'] === 'middle' && Number(n.attrs.y) === 322;
  });
}

/* =========================================================
 * 1. V-F1：26 列导出契约零改动 golden diff
 * ========================================================= */
console.log('\n=== 1. V-F1：26 列导出契约零改动 golden diff ===');

/* 改造前 26 列列名数组（硬编码 golden 兜底，来自改造前 masterExportRows 的 head） */
const GOLDEN_HEAD = [
  '序号', '姓名', '学校', '班级', '考试名称',
  '语文', '语文排名', '数学', '数学排名', '英语', '英语排名',
  '物理', '物理排名', '化学', '化学排名', '政治', '政治排名',
  '历史', '历史排名', '地理', '地理排名', '生物', '生物排名',
  '总分', '总分排名', '录入时间'
];
eq('硬编码 golden 自身为 26 列', GOLDEN_HEAD.length, 26);

const jsFiles = fs.readdirSync(SRC).filter(function (f) { return /\.js$/.test(f); });
const defFiles = jsFiles.filter(function (f) {
  return /function\s+masterExportRows\s*\(/.test(fs.readFileSync(path.join(SRC, f), 'utf8'));
});
eq('masterExportRows 只在 js/module-score.js 定义', defFiles.join(','), 'module-score.js');
eq('js/export.js 不含 masterExportRows',
  /function\s+masterExportRows\s*\(/.test(fs.readFileSync(path.join(SRC, 'export.js'), 'utf8')), false);

const curSrc = fs.readFileSync(path.join(SRC, 'module-score.js'), 'utf8');
const curFn = extractFunction(curSrc, 'masterExportRows');
/* 与提交状态无关的持久守门：当前导出函数体本身不得出现「考试年月」列 */
ok('当前 masterExportRows 函数体可抽取', !!curFn);
eq('当前函数体不含「考试年月」', (curFn || '').indexOf('考试年月'), -1);

let headSrc = null, gitErr = null;
try {
  headSrc = cp.execFileSync('git', ['show', 'HEAD:js/module-score.js'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
} catch (e) { gitErr = e && e.message ? e.message : String(e); }

/* git 基线只作「加强证据」，绝不绑架验收结果（V-F1 的实质是 26 列导出契约零改动）：
   - git 不可用（非 git 仓库 / 无该路径） → INFO，跳过逐字比对，不判失败；
   - HEAD 已含 v3 的 ym-col（v3 已提交） → INFO，跳过逐字比对（否则退化为自比对），不判失败；
   - HEAD 为改造前                       → 做函数体逐字比对（加强证据）。
   硬编码 GOLDEN_HEAD 与下方「真实执行 masterExportRows」的 26 列长度 / 表头逐字断言
   在以上三种状态都始终执行，才是与提交状态无关的持久守门员。 */
if (!headSrc) {
  console.log('  INFO：git show HEAD:js/module-score.js 不可用（' + (gitErr || '未知原因') +
    '），跳过 git 函数体比对；26 列契约由硬编码 GOLDEN_HEAD 持久兜底。');
} else if (headSrc.indexOf('ym-col') >= 0) {
  console.log('  INFO：HEAD 已含 v3，跳过 git 函数体比对；26 列契约由硬编码 GOLDEN_HEAD 持久兜底。');
} else {
  const headFn = extractFunction(headSrc, 'masterExportRows');
  ok('改造前 masterExportRows 函数体可抽取', !!headFn);
  ok('抽取到的函数体非空且足够长（非平凡比对）',
    !!(curFn && headFn && curFn.length > 300 && headFn.length > 300),
    'curLen=' + (curFn ? curFn.length : 0) + ' headLen=' + (headFn ? headFn.length : 0));
  if (headFn && curFn) {
    eq('函数体与改造前逐字一致（V-F1 零改动）', curFn, headFn);
    eq('改造前函数体不含「考试年月」', headFn.indexOf('考试年月'), -1);
  }
}

/* 真实执行 masterExportRows：只给协作者夹具，函数体本身取当前源码 */
const exportFn = extractFunction(curSrc, 'masterExportRows');
ok('当前 masterExportRows 可求值', !!exportFn);
const sampleRec = {
  name: '测试生', school: '纪中', cls: '28届', exam: '一模',
  scores: [112, 138, 126, 92, 84, 0, 0, 0, 88],
  ranks: [1, 2, 3, 4, 5, 0, 0, 0, 6],
  totalRank: 7, ts: '2026-01-01T00:00:00.000Z', examYm: '2026-01'
};
let rows = null, evalErr = null;
try {
  const make = new Function('S', 'K', 'Score', 'U', 'masterRowsData',
    exportFn + '\nreturn masterExportRows();');
  rows = make(S, K, Score, U, function () { return [sampleRec]; });
} catch (e) { evalErr = e && e.message ? e.message : String(e); }
ok('masterExportRows() 真实执行无异常', rows !== null, evalErr);
if (rows) {
  const head = rows[0];
  ok('返回至少含表头 + 1 行数据', rows.length >= 2, 'rows.length=' + rows.length);
  eq('表头列数 = 26', head.length, 26);
  eq('列数口径 5 + 2×科目数 + 3 = 26', 5 + 2 * S.length + 3, 26);
  eq('科目数为 9', S.length, 9);
  eqArr('表头与硬编码 golden 逐字一致', head, GOLDEN_HEAD);
  eq('表头不含「考试年月」列', head.indexOf('考试年月'), -1);
  eq('表头第 1 列 = 序号', head[0], '序号');
  eq('表头第 5 列 = 考试名称', head[4], '考试名称');
  eq('表头末列 = 录入时间', head[25], '录入时间');
  eq('数据行列数 = 26', rows[1].length, 26);
  eq('数据行第 2 列回写姓名', rows[1][1], '测试生');
  eq('数据行第 5 列回写考试名称', rows[1][4], '一模');
  eq('数据行不含「考试年月」文本列', rows[1].indexOf('考试年月'), -1);
}

/* =========================================================
 * 2. D5：x 轴 label golden diff
 * ========================================================= */
console.log('\n=== 2. D5：x 轴 label golden diff ===');

function rec(exam, examYm, ts) {
  const r = { id: exam, name: '测试生', school: '纪中', cls: '28届', exam: exam, ts: ts || '2026-01-01' };
  if (examYm !== undefined) r.examYm = examYm;
  return r;
}
function labelsOf(rowsIn) { return Score.examAxisLabels(rowsIn).map(function (a) { return a.label; }); }
function titlesOf(rowsIn) { return Score.examAxisLabels(rowsIn).map(function (a) { return a.title; }); }

/* 2.1 全缺年月：逐字回退，无前缀、无 8 字截断 */
const allMissing = [
  rec('一场名称特别长的期末考试', undefined, '2026-01-01'),
  rec('二模', undefined, '2026-02-01'),
  rec('三模', undefined, '2026-03-01')
];
const sortedMissing = Score.sortByExam(allMissing);
const missLabels = labelsOf(sortedMissing);
eqArr('全缺年月 label 与 exam 原文逐项严格相等', missLabels, sortedMissing.map(function (r) { return r.exam; }));
eq('全缺年月输出与入参等长', missLabels.length, sortedMissing.length);
eq('全缺年月无「未标注·」前缀', missLabels.join('').indexOf('未标注·'), -1);
eq('全缺年月无「异常·」前缀', missLabels.join('').indexOf('异常·'), -1);
eq('长考试名未被 8 字截断（无省略号）', missLabels.join('').indexOf('…'), -1);
eq('长考试名逐字保留', missLabels.indexOf('一场名称特别长的期末考试') >= 0, true);
eqArr('全缺年月 title 亦为 exam 原文', titlesOf(sortedMissing), sortedMissing.map(function (r) { return r.exam; }));
eq('全序列缺年月时 sortByExam 走 ts 回退（顺序不乱）',
  sortedMissing.map(function (r) { return r.exam; }).join(','),
  '一场名称特别长的期末考试,二模,三模');

/* 2.2 跨年序列：YY年· + 异常· + 未标注· */
const crossYear = [
  rec('一模', '2025-12'), rec('二模', '2026-01'), rec('三模', 'bad-ym'), rec('四模')
];
const crossLabels = labelsOf(crossYear);
eqArr('跨年四种分支 label 正确', crossLabels,
  ['25年·一模', '26年·二模', '异常·三模', '未标注·四模']);
eq('跨年序列等长', crossLabels.length, crossYear.length);
eq('跨年序列 title 为完整说明', titlesOf(crossYear)[0], '2025-12 · 一模');
eq('非法值 title 标注年月异常', titlesOf(crossYear)[2], '年月异常 · 三模');
eq('缺年月 title 标注未标注年月', titlesOf(crossYear)[3], '未标注年月 · 四模');
eq('跨年序列同序（title 含 exam 原文）',
  titlesOf(crossYear).every(function (t, i) { return t.indexOf(crossYear[i].exam) >= 0; }), true);

/* 2.3 同年同月多场：M月·（crossYear=false 时生效） */
const sameYm = [
  rec('一模', '2026-10'), rec('二模', '2026-10'), rec('三模', '2026-11'),
  rec('四模', 'bad-ym'), rec('五模')
];
const sameLabels = labelsOf(sameYm);
eqArr('同年月多场四种分支 label 正确', sameLabels,
  ['10月·一模', '10月·二模', '三模', '异常·四模', '未标注·五模']);
eq('同年月序列等长', sameLabels.length, sameYm.length);
eq('同年月但唯一的一场不加月前缀', sameLabels[2], '三模');
eq('M月· 分支 title 仍带完整年月', titlesOf(sameYm)[0], '2026-10 · 一模');
eq('同年月序列同序（title 含 exam 原文）',
  titlesOf(sameYm).every(function (t, i) { return t.indexOf(sameYm[i].exam) >= 0; }), true);

/* 2.4 8 字上限截断（混合序列新分支） */
const longMixed = [rec('一场名称特别长的期末考试', '2026-10'), rec('二模', '2026-11')];
const longLabel = labelsOf(longMixed)[0];
ok('混合序列长标签被截到 8 个全角字符上限',
  Array.from(longLabel).length <= 8, 'len=' + Array.from(longLabel).length + ' label=' + longLabel);
eq('混合序列长标签以省略号收尾', longLabel.slice(-1), '…');
eq('截断不影响 title 完整性', titlesOf(longMixed)[0], '2026-10 · 一场名称特别长的期末考试');

/* 2.5 空 / null 入参 */
eq('rows=null 返回空数组', JSON.stringify(Score.examAxisLabels(null)), '[]');
eq('rows=undefined 返回空数组', JSON.stringify(Score.examAxisLabels(undefined)), '[]');

/* =========================================================
 * 3. 混合序列趋势图 x 轴长度对齐保护
 * ========================================================= */
console.log('\n=== 3. 混合序列趋势图 x 轴长度对齐保护 ===');

/* 从真实源码抽取两处 label 构造块（被测逻辑本身不 stub） */
const blockA = extractBlock(curSrc,
  'var ax = Score.examAxisLabels(studentRows);',
  'ct.appendChild(App.Chart.dualLine({');
const blockB = extractBlock(curSrc,
  'var ax2 = Score.examAxisLabels(studentRows);',
  'trendBox.appendChild(App.Chart.dualLine({');
ok('历史趋势图 label 构造块可抽取', !!blockA);
ok('报告趋势图 label 构造块可抽取', !!blockB);

const makeA = blockA
  ? new Function('Score', 'studentRows', 'sc', blockA + '\nreturn { labels: axisLabels, titles: axisTitles };')
  : null;
const makeB = blockB
  ? new Function('Score', 'studentRows', 'exs', blockB + '\nreturn { labels: axisLabels2, titles: axisTitles2 };')
  : null;

/* V-D2 场景：studentRows 含无年月行，trend.exams 已过滤掉它们 → 长度不等 */
const mixedRows = [
  rec('一模', '2025-12'), rec('二模', undefined), rec('三模', '2026-01'),
  rec('四模', 'bad-ym'), rec('五模', '2026-02')
];
const studentRows = Score.sortByExam(mixedRows);
const exsFiltered = [
  { exam: '一模', rate: 0.7 }, { exam: '三模', rate: 0.8 }, { exam: '五模', rate: 0.85 }
]; // 只保留 has 子序列，长度 3 < studentRows.length 5
const scoreArr = exsFiltered.map(function (e) { return Math.round(e.rate * 1000) / 10; });
const rankArr = exsFiltered.map(function () { return 0; });
const scHistoric = [70, 0, 80, 0, 85];   // 历史趋势图：由 studentRows 逐条 push，长度 5
const rkHistoric = [1, 0, 2, 0, 3];
eq('构造的 V-D2 不等长场景成立', exsFiltered.length < studentRows.length, true);

if (makeA) {
  const outA = makeA(Score, studentRows, scHistoric);
  eq('历史趋势图 labels 与 score 等长', outA.labels.length, scHistoric.length);
  eq('历史趋势图 labelTitles 与 labels 等长', outA.titles.length, outA.labels.length);
  eq('历史趋势图 labels 与 rank 等长', outA.labels.length, rkHistoric.length);
  eq('历史趋势图 labels 全为字符串',
    outA.labels.every(function (x) { return typeof x === 'string'; }), true);
  eq('历史趋势图 labelTitles 全为字符串',
    outA.titles.every(function (x) { return typeof x === 'string'; }), true);
  eq('历史趋势图无 undefined 标签', outA.labels.indexOf(undefined), -1);
  eqArr('历史趋势图等长时保留完整 examAxisLabels（未触发回退）',
    outA.labels, labelsOf(studentRows));
  eq('历史趋势图等长时 title 带完整说明',
    outA.titles.some(function (t) { return t.indexOf(' · ') >= 0; }), true);
}

if (makeB) {
  const outB = makeB(Score, studentRows, exsFiltered);
  eq('报告趋势图 labels 与 exs/score 等长（触发回退）', outB.labels.length, scoreArr.length);
  eq('报告趋势图 labelTitles 与 labels 等长', outB.titles.length, outB.labels.length);
  eq('报告趋势图 labels 与 rank 等长', outB.labels.length, rankArr.length);
  eqArr('报告趋势图不等长时回退为 exam 原文，x 轴与 score 不错位',
    outB.labels, exsFiltered.map(function (e) { return e.exam; }));
  eq('报告趋势图 labels 全为字符串',
    outB.labels.every(function (x) { return typeof x === 'string'; }), true);
  eq('报告趋势图 labelTitles 全为字符串',
    outB.titles.every(function (x) { return typeof x === 'string'; }), true);
  eq('报告趋势图无 undefined 标签', outB.labels.indexOf(undefined), -1);

  /* 真实 charts.js dualLine 渲染：M 个 score 点应对应 M 个 x 轴标签 */
  const svgB = Chart.dualLine({
    title: '混合序列趋势', labels: outB.labels, labelTitles: outB.titles,
    score: scoreArr, rank: rankArr, scoreLabel: '得分率(%)', rankLabel: '总分排名'
  });
  eq('dualLine 渲染出 M 个 x 轴标签', xAxisTexts(svgB).length, scoreArr.length);
  eqArr('dualLine x 轴文案与回退 labels 逐项一致',
    xAxisTexts(svgB).map(function (n) { return n._text; }), outB.labels);
  eq('dualLine 给每个非 null 的 labelTitles 挂 <title>',
    collectTitles(svgB).length, outB.titles.length);
  eqArr('dualLine <title> 内容逐项等于 labelTitles',
    collectTitles(svgB), outB.titles);

  /* 等长场景：不触发回退，保留完整 title */
  const exsFull = studentRows.map(function (r) { return { exam: r.exam, rate: 0.8 }; });
  const outBFull = makeB(Score, studentRows, exsFull);
  eq('报告趋势图等长时不回退（保留完整 title）',
    outBFull.titles.some(function (t) { return t.indexOf(' · ') >= 0; }), true);
  eq('报告趋势图等长时 labels 与 exs 等长', outBFull.labels.length, exsFull.length);
  eq('报告趋势图等长时 labelTitles 与 labels 等长', outBFull.titles.length, outBFull.labels.length);
}

/* 3.3 charts.js：只在 labelTitles[i] 非 null/undefined 时挂 <title> */
const labels5 = ['a', 'b', 'c', 'd', 'e'];
const scores5 = [10, 20, 30, 40, 50];
const ranks5 = [1, 2, 3, 4, 5];

const svgNoTitles = Chart.dualLine({ labels: labels5, score: scores5, rank: ranks5 });
eq('不传 labelTitles 时 0 个 <title>（API 向后兼容）', collectTitles(svgNoTitles).length, 0);
eq('不传 labelTitles 时 x 轴仍渲染 5 个标签', xAxisTexts(svgNoTitles).length, 5);

const mixedTitles = ['TA', null, undefined, '', 'TE'];
const svgMixed = Chart.dualLine({
  labels: labels5, labelTitles: mixedTitles, score: scores5, rank: ranks5
});
eq('混合 labelTitles 只为 3 个非 null/undefined 项挂 <title>',
  collectTitles(svgMixed).length, 3);
eqArr('混合 labelTitles 的 <title> 内容正确（含空串仍挂）',
  collectTitles(svgMixed), ['TA', '', 'TE']);
eq('混合 labelTitles 时 x 轴 5 个标签仍在', xAxisTexts(svgMixed).length, 5);
eq('x 轴第 2 个标签无 <title>（null）', xAxisTexts(svgMixed)[1].children.length, 0);
eq('x 轴第 3 个标签无 <title>（undefined）', xAxisTexts(svgMixed)[2].children.length, 0);
eq('x 轴第 1 个标签有 <title>', xAxisTexts(svgMixed)[0].children.length, 1);
eq('opt.labels 仍为字符串数组',
  labels5.every(function (x) { return typeof x === 'string'; }), true);
const escapedTitle = collectTitles(
  Chart.dualLine({ labels: ['x'], score: [1], rank: [1], labelTitles: ['A & B'] })
)[0];
eq('U.esc 确实对 & 做了转义', U.esc('A & B') !== 'A & B', true);
eq('<title> 内容等于 U.esc 后的字符串', escapedTitle, U.esc('A & B'));
eq('<title> 不含未转义的原文', escapedTitle !== 'A & B', true);

/* =========================================================
 * 汇总
 * ========================================================= */
console.log('\n============================');
if (FAILS.length) {
  console.log('FAIL（' + FAILS.length + ' 条）');
  FAILS.forEach(function (s) { console.log('  × ' + s); });
  console.log('----------------------------');
}
console.log('=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===');
console.log('============================');
process.exit(fail ? 1 : 0);
