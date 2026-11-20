/* =========================================================
 * tools/qa-v3.js —— V3「考试年月改造」总集成验收入口（唯一新建文件）
 *   node tools/qa-v3.js
 *
 * 定位：发布前最后一道集成关。按「证明功能可用」而非「确认文件存在」
 *       的力度写断言 —— 在单个 vm sandbox 里按 index.html 的顺序装载
 *       js/ 全部 23 个模块，让 core / sync / export / module-score /
 *       module-classes / analysis / charts 真实串成一条数据链并执行。
 *
 * 覆盖两大部分：
 *   A. 跨文件集成断言：逐条映射 docs/ARCH-v3-exam-ym.md §8 的
 *      V-A1 ~ V-H3（27 条，每条 ≥1 条断言），硬项 V-F3 / V-G3 /
 *      V-H1 / V-H2 / V-F1 / V-D1 / V-E7 加强为端到端链路。
 *      · 测试 seam 只在**内存里的源码字符串**上注入，磁盘文件零改动。
 *      · openForm / submit 通过真实表单 DOM 桩件驱动，Modal.open /
 *        Toast / render / 权限用沙箱内对象覆盖（不落盘）。
 *   B. 12 个子套件回归：child_process.spawnSync 依次执行，收集 rc 与
 *      末行 PASS/FAIL 数，输出汇总表；任一 rc≠0 或 FAIL>0 计入失败。
 *      若 qa-v3-ui.js 不存在则标注 SKIP，不判失败。
 *
 * 数据侧只读 docs/v3-postflight-snapshot.json / backup-pre-v3.json /
 * baseline-score.txt / index.html / build-single.py / 单文件版产物，
 * 不连云端、不跑 build-single.py、不 commit / push、不发布。
 *
 * 末尾输出：=== 结果：PASS N / FAIL 0 ===
 * 任一断言失败或子套件异常 → process.exit(1)。
 * ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'js');
const DOCS = path.join(ROOT, 'docs');
const TOOLS = __dirname;

/* ---------------- 断言框架 ---------------- */
let pass = 0, fail = 0;
const FAILS = [];
const SECTION_IDS = [];          // 记录 §8 验收项覆盖情况

/** 兼容「eq(v('V-A1'), 名称, 实际, 期望)」这类带验收 ID 前缀的调用：
 *  参数求值时 v(id) 已完成 §8 覆盖标注，这里把 id 前缀丢弃、其余参数前移一位，
 *  使断言真正比较「实际值 vs 期望值」，而不是误把 id / 描述当比较对象。 */
function normalizeArgs(args) {
  var a = Array.prototype.slice.call(args);
  if (a.length && /^(BASE|V-[A-H]\d)$/.test(String(a[0]))) a.shift();
  return a;
}
function ok(name, cond, detail) {
  var a = normalizeArgs(arguments);
  name = a[0]; cond = a[1]; detail = a[2];
  if (cond) { pass++; console.log('  PASS  ' + name); return true; }
  fail++;
  FAILS.push(name + (detail === undefined ? '' : '  → ' + detail));
  console.log('  FAIL  ' + name + (detail === undefined ? '' : '  → ' + detail));
  return false;
}
function eq(name, actual, expect) {
  var a = normalizeArgs(arguments);
  name = a[0]; actual = a[1]; expect = a[2];
  return ok(name, actual === expect,
    '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expect));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
/** 标注该断言映射的 §8 验收项（用于末尾「逐条覆盖」自检） */
function v(id) { if (SECTION_IDS.indexOf(id) < 0) SECTION_IDS.push(id); return id; }

/* =========================================================
 * 第一部分：vm 全量装载 js/ 全部模块（跨文件集成基座）
 * ========================================================= */

/* ---------- 智能 DOM 桩件 ----------
 * 普通元素：可读写 innerHTML / textContent / value / style，记录事件。
 * 表单 body：按 selector 返回预置元素；[data-s] / [data-r] 返回 9 个输入。
 * SVG：charts.js 的 el() 用 createElementNS，需要 appendChild 收集子节点。
 */
function makeEl(tag) {
  return {
    tagName: tag || 'div', innerHTML: '', textContent: '', value: '',
    style: {}, attrs: {}, children: [], firstChild: null,
    className: '', id: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    _handlers: {},
    addEventListener(evt, fn) { this._handlers[evt] = fn; },
    removeEventListener() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    remove() {}, setAttribute(k, val) { this.attrs[k] = val; },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    click() { if (this._handlers.click) this._handlers.click({ target: this }); },
    focus() {}, setSelectionRange() {}, scrollIntoView() {},
    getContext() { return null; }
  };
}

/** 构造一次 openForm 需要的表单 body 桩件（可反复调用，互不干扰） */
function makeFormBody(curY, curM) {
  const els = {};
  const scoreInputs = [], rankInputs = [];
  for (let i = 0; i < 9; i++) { scoreInputs.push(makeEl('input')); rankInputs.push(makeEl('input')); }
  function put(sel, props) {
    const e = makeEl('input');
    Object.keys(props || {}).forEach(function (k) { e[k] = props[k]; });
    els[sel] = e; return e;
  }
  /* 文本字段 */
  ['[name=name]', '[name=school]', '[name=cls]', '[name=exam]', '[name=totalRank]'].forEach(function (s) { put(s, {}); });
  /* 年月下拉：默认选中「当前年月」，等价于浏览器解析 <option selected> 后的 value */
  put('[name=examYear]', { value: String(curY) });
  put('[name=examMonth]', { value: curM });
  /* 提示 / 计分 / 错误容器 */
  ['#ym-future-hint', '#ym-missing-row', '#ym-use-current', '#live-hint',
    '#live-total', '#subj-rows', '#form-err'].forEach(function (s) { put(s, {}); });
  /* 连续录入按钮插入的 footer */
  put('footer', {});

  const body = makeEl('div');
  body._els = els;
  body._scoreInputs = scoreInputs;
  body._rankInputs = rankInputs;
  body.querySelector = function (sel) {
    if (!els[sel]) els[sel] = makeEl('input');
    return els[sel];
  };
  body.querySelectorAll = function (sel) {
    if (sel === '[data-s]') return scoreInputs;
    if (sel === '[data-r]') return rankInputs;
    return [];
  };
  return body;
}

/* ---------- sandbox 全局 ---------- */
let CURRENT_FORM = null;          // 下一次 document.createElement('div') 交给 openForm 的 body
let CAPTURED_BLOB = '';           // backupJSON 写出的 JSON 文本
let MODAL_CALLS = [];             // App.Modal.open 捕获的 opts 序列

const sandbox = {
  console,
  localStorage: {
    getItem() { return null; }, setItem() {}, removeItem() {}, clear() {}
  },
  document: {
    body: makeEl('body'), head: makeEl('head'), documentElement: makeEl('html'),
    getElementById() { return makeEl(); },
    createElement(tag) {
      if (tag === 'div' && CURRENT_FORM) { const b = CURRENT_FORM; CURRENT_FORM = null; return b; }
      return makeEl(tag);
    },
    createElementNS(ns, tag) {
      const e = makeEl(tag);
      e.namespaceURI = ns;
      return e;
    },
    createTextNode(t) { const e = makeEl('#text'); e.textContent = t; return e; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}
  },
  setTimeout() { return 0; }, clearTimeout() {},       // 不注册真实定时器
  setInterval() { return 0; }, clearInterval() {},
  location: { hash: '', href: '', reload() {} },
  navigator: { onLine: true },
  Blob: function (parts) { CAPTURED_BLOB = (parts || []).join(''); },
  URL: { createObjectURL() { return 'blob:stub'; }, revokeObjectURL() {} },
  FileReader: function () {}, fetch() { return Promise.resolve({ ok: true, json() { return Promise.resolve({}); } }); },
  XMLHttpRequest: function () {}, alert() {}, confirm() { return true; }, prompt() { return ''; },
  Intl: Intl
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------- 按 index.html 顺序装载全部本地 js ---------- */
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const JS_FILES = [];
indexHtml.replace(/src="js\/([a-z\-]+\.js)(?:\?v=\d+)?"/g, function (m, f) { JS_FILES.push(f); return m; });

/** 在内存源码里注入一行外露（磁盘零改动），marker 必须恰好命中 1 次 */
function loadWithSeam(file, marker, seam) {
  const raw = fs.readFileSync(path.join(SRC, file), 'utf8');
  const n = raw.split(marker).length - 1;
  if (n !== 1) throw new Error(file + ' 的 seam marker 命中 ' + n + ' 次（应为 1）：' + marker);
  vm.runInContext(raw.replace(marker, seam + '\n' + marker), sandbox, { filename: file });
}
const SEAMS = {
  'core.js': ['  global.App = App;', '  App.__LegacySort = legacySortByTs;'],
  'sync.js': ['  App.Sync = {',
    '  App.__SyncT = { fp: fp, snapState: snapState, restoreState: restoreState, toRow: toRow, fromRow: fromRow };'],
  'export.js': ['  App.X = {',
    '  App.__ExportT = { normalizeRecord: normalizeRecord, restoreJSON: restoreJSON };'],
  'module-score.js': ['  App.ScoreModule = {',
    '  App.__ScoreT = { masterExportRows: masterExportRows, masterRowsData: masterRowsData, renderMaster: renderMaster };'],
  'app.js': ['  App.render = render;', '  App.__genDemo = genDemo;']
};
let LOAD_OK = 0, LOAD_ERR = [];
JS_FILES.forEach(function (f) {
  try {
    const s = SEAMS[f];
    if (s) loadWithSeam(f, s[0], s[1]);
    else vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
    LOAD_OK++;
  } catch (e) { LOAD_ERR.push(f + ': ' + e.message); }
});

const App = sandbox.App;
const Score = App && App.Score;
const U = App && App.U;
const T = App && App.__SyncT;
const X = App && App.__ExportT;
const ST = App && App.__ScoreT;

/* ---------- 沙箱内协作者覆盖（不落盘） ----------
 * 让 openForm / submit / renderMaster 在无登录、无真实 DOM 的沙箱里
 * 仍能走完真实业务函数；被测函数本身一律保持源码原样、真实执行。 */
if (App) {
  App.Sync.canEdit = function () { return true; };        // guardEdit / canEdit 放行
  App.Perm.assertWrite = function () { return true; };   // L4 写入校验放行
  App.render = function () {};                           // 屏蔽全量重绘（persistRec 末尾调用）
  App.U.download = function () {};                       // backupJSON 不产生真实下载
  App.Store.hooks.afterSave = [];                        // 不触发云端 schedule（boot 未跑，本就为空）
  App.Modal.open = function (opts) {
    MODAL_CALLS.push(opts);
    const mask = makeEl('div');
    mask.querySelector = function (sel) {
      if (!mask._els) mask._els = {};
      if (!mask._els[sel]) mask._els[sel] = makeEl('footer');
      return mask._els[sel];
    };
    return mask;
  };
}

/* ---------- 通用夹具 ---------- */
const ZERO9 = function () { return [0, 0, 0, 0, 0, 0, 0, 0, 0]; };
function rec(o) {
  const base = Score.newRecord();
  Object.keys(o || {}).forEach(function (k) { base[k] = o[k]; });
  return base;
}
function ids(rows) { return rows.map(function (r) { return r.id; }).join(','); }
function examNames(rows) { return rows.map(function (r) { return r.exam; }).join('|'); }
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function localYm() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1);
}
function cloudRow(extra) {
  return Object.assign({
    rec_id: 'c1', id: 77, stu_name: '赵六', school: 'S', class_name: 'C', exam: '一模',
    scores: ZERO9(), ranks: ZERO9(), total_rank: 0,
    entered_at: '2026-01-01T00:00:00Z'
  }, extra || {});
}
/** 驱动一次 openForm，返回 { body, opts, mask, curY, curM } */
function driveForm(existing, formValues) {
  const curYm = Score.defaultExamYm();
  const curY = Number(curYm.slice(0, 4));
  const curM = curYm.slice(5, 7);
  MODAL_CALLS = [];
  const body = makeFormBody(curY, curM);
  CURRENT_FORM = body;
  const mask = App.ScoreModule.openForm(existing || null);
  const opts = MODAL_CALLS[MODAL_CALLS.length - 1];
  /* 预置表单字段（模拟用户填写） */
  const F = {
    '[name=name]': '郭阳阳', '[name=school]': '一中', '[name=cls]': '高二',
    '[name=exam]': '期中考试', '[name=totalRank]': ''
  };
  Object.keys(F).forEach(function (k) { body.querySelector(k).value = F[k]; });
  Object.keys(formValues || {}).forEach(function (k) { body.querySelector(k).value = formValues[k]; });
  return { body: body, opts: opts, mask: mask, curY: curY, curM: curM, curYm: curYm };
}

/* =========================================================
 * §0 装载基座与跨文件集成契约
 * ========================================================= */
section('0. 全量装载与跨文件集成基座');
eq(v('BASE'), 'index.html 声明的本地 js 数与装载成功数一致', LOAD_OK, JS_FILES.length);
ok('23 个 js 全部装载成功且 0 抛错', LOAD_ERR.length === 0 && LOAD_OK === 23, LOAD_ERR.join('; '));
eq('js/ 目录实际文件数 == 23',
  fs.readdirSync(SRC).filter(function (f) { return /\.js$/.test(f); }).length, 23);
ok('App 全局命名空间存在', !!App && typeof App === 'object');
ok('跨文件命名空间齐备（core/sync/export/score/classes/analysis/charts/perm）',
  !!Score && !!App.Sync && !!App.X && !!App.ScoreModule && !!App.ClassesCore &&
  !!App.Analysis && !!App.Chart && !!App.Perm);
eq('App.registerModule 注册模块数 == 12', App.modules.length, 12);
ok('5 处测试 seam 全部注入成功',
  typeof App.__LegacySort === 'function' && typeof T.fp === 'function' &&
  typeof X.normalizeRecord === 'function' && typeof ST.masterExportRows === 'function' &&
  typeof App.__genDemo === 'function');
['defaultExamYm', 'makeExamYm', 'examYmOf', 'examOrderKey', 'examCmp',
  'sortByExam', 'sort', 'options', 'examYmLabel', 'examAxisLabels', 'history', 'upsert'].forEach(function (k) {
  ok('Score.' + k + ' 已外露且为函数', typeof Score[k] === 'function');
});
App.Store.init();

/* =========================================================
 * V-A1：补录 10 月按年月排在 11 月之前 → 明显下滑；x 轴 1:1 不内部排序
 * ========================================================= */
section('V-A1 补录年月序 + 趋势图 x 轴（core→analysis→charts 真实链路）');
const LOW = [60, 60, 60, 40, 40, 0, 0, 0, 47];      /* ~40.9% */
const HIGH = [120, 120, 120, 80, 80, 0, 0, 0, 87]; /* ~80.9% */
const recA = [
  rec({ exam: '11月段考', examYm: '2026-11', scores: LOW.slice(), id: 'a2', ts: '2026-11-05T02:00:00Z' }),
  rec({ exam: '10月段考', examYm: '2026-10', scores: HIGH.slice(), id: 'a1', ts: '2026-11-19T02:00:00Z' })
];
const sortedA = Score.sortByExam(recA);
eq(v('V-A1'), 'sortByExam 把补录的 10 月排到 11 月之前', examNames(sortedA), '10月段考|11月段考');
ok('Score.history 结论含「明显下滑」（相邻 −40.04）',
  Score.history(sortedA, 0, 60).conclusion.indexOf('明显下滑') >= 0,
  Score.history(sortedA, 0, 60).conclusion);
const buildA = App.Analysis.build({
  target: sortedA[0], classRows: recA, gradeRows: recA, studentRows: sortedA, track: '物理类'
});
eq('Analysis.build trend.exams[0] = 10月段考（首考）', buildA.trend.exams[0].exam, '10月段考');
eq('Analysis.build trend.exams[last] = 11月段考（最近）',
  buildA.trend.exams[buildA.trend.exams.length - 1].exam, '11月段考');
ok('Analysis.build trend.rateDelta < 0（首考 80.9% → 最近 40.9%）', buildA.trend.rateDelta < 0,
  'rateDelta=' + buildA.trend.rateDelta);
const axA = Score.examAxisLabels(sortedA);
eq('examAxisLabels 与 studentRows 等长（1:1 不内部排序）', axA.length, sortedA.length);
ok('examAxisLabels 顺序同入参（title 逐条对应 exam 原文）',
  axA.every(function (a, i) { return a.title.indexOf(sortedA[i].exam) >= 0; }));
const chartA = App.Chart.dualLine({
  title: '集成趋势', labels: axA.map(function (a) { return a.label; }),
  labelTitles: axA.map(function (a) { return a.title; }),
  score: sortedA.map(function (r) { return Math.round(Score.totalRate(r) * 1000) / 10; }),
  rank: [0, 0], scoreLabel: '得分率(%)', rankLabel: '总分排名'
});
ok('Chart.dualLine 真实执行不抛错且产出 SVG 节点', !!chartA && chartA.tagName === 'svg');
ok('Chart.dualLine 子节点数 > 0（图表真实绘制）', chartA.children.length > 0);

/* =========================================================
 * V-A2：Score.sort 分组代表年月 → 总表 10 月行在前；examYmLabel 两列值
 * ========================================================= */
section('V-A2 分组级年月序 + 总表 UI「考试年月」列');
const groupedA = [
  rec({ name: '甲', exam: '期末', examYm: '2026-11', id: 'p1' }),
  rec({ name: '乙', exam: '期中', examYm: '2026-09', id: 'p2' }),
  rec({ name: '丙', exam: '月考', examYm: '2026-10', id: 'p3' })
];
eq(v('V-A2'), 'Score.sort 组间按代表年月升序', examNames(Score.sort(groupedA)), '期中|月考|期末');
eq('examYmLabel 合法值显示 YYYY-MM', Score.examYmLabel(groupedA[0]), '2026-11');
eq('examYmLabel 缺年月显示「未标注年月」', Score.examYmLabel(rec({})), '未标注年月');
App.Store.init();
App.Store.data.records = [recA[0], recA[1]];
const masterHtml = ST.renderMaster();
ok('renderMaster() 真实渲染出「考试年月」列头', masterHtml.indexOf('考试年月') >= 0);
ok('renderMaster() 显示两条年月值 2026-10 / 2026-11',
  masterHtml.indexOf('2026-10') >= 0 && masterHtml.indexOf('2026-11') >= 0);
ok('renderMaster() 10 月行排在 11 月行之前（分组级年月序）',
  masterHtml.indexOf('2026-10') < masterHtml.indexOf('2026-11'));

/* =========================================================
 * V-B1：跨年 24312 < 24313；25年·/26年·；8 字 code point；末−首 +10pp
 * ========================================================= */
section('V-B1 跨年数值序 + x 轴跨年标签 + 8 字上限');
const kDec = Score.examOrderKey({ examYm: '2025-12' });
const kJan = Score.examOrderKey({ examYm: '2026-01' });
eq(v('V-B1'), '2025-12 num = 24312', kDec.num, 24312);
eq('2026-01 num = 24313', kJan.num, 24313);
ok('跨年 examCmp < 0（数值比较非字符串）',
  Score.examCmp({ examYm: '2025-12' }, { examYm: '2026-01' }) < 0 && kDec.num < kJan.num);
const axCross = Score.examAxisLabels([
  rec({ exam: '期末考', examYm: '2025-12' }), rec({ exam: '一模', examYm: '2026-01' })
]);
eq('跨年 x 轴标签：25年·期末考', axCross[0].label, '25年·期末考');
eq('跨年 x 轴标签：26年·一模', axCross[1].label, '26年·一模');
ok('8 全角字符上限按 code point 计数（Array.from）',
  Array.from(axCross[0].label).length <= 8 && Array.from(axCross[1].label).length <= 8);
const up1 = rec({ exam: '首考', examYm: '2025-12', scores: [70, 70, 70, 45, 45, 0, 0, 0, 45] });
const up2 = rec({ exam: '末考', examYm: '2026-01', scores: [80, 80, 80, 50, 50, 0, 0, 0, 50] });
const buildB1 = App.Analysis.build({ target: up1, classRows: [up1, up2], gradeRows: [up1, up2], studentRows: [up1, up2] });
ok('Analysis.build 末−首 rateDelta > 0（跨年上升）', buildB1.trend.rateDelta > 0,
  'rateDelta=' + buildB1.trend.rateDelta);

/* =========================================================
 * V-B2：三个 num 严格升序；全局禁用 U.zh(exam) 决定年份先后
 * ========================================================= */
section('V-B2 三场年月严格升序 + 禁用考试名定年份');
const n1 = Score.examOrderKey({ examYm: '2025-10' }).num;
const n2 = Score.examOrderKey({ examYm: '2026-09' }).num;
const n3 = Score.examOrderKey({ examYm: '2026-10' }).num;
ok(v('V-B2'), '2025-10 < 2026-09 < 2026-10 三个 num 严格升序', n1 < n2 && n2 < n3,
  [n1, n2, n3].join(','));
const zhReverse = [
  rec({ exam: 'A考试', examYm: '2026-01', id: 'z3' }),
  rec({ exam: 'Z考试', examYm: '2025-12', id: 'z1' }),
  rec({ exam: 'M考试', examYm: '2025-10', id: 'z2' })
];
eq('exam 名反序仍按 num 排（U.zh 不决定年份先后）',
  ids(Score.sortByExam(zhReverse)), 'z2,z1,z3');

/* =========================================================
 * V-B3：覆盖确认文案 + 返回修改不写库 + 覆盖并保存走 upsert
 * ========================================================= */
section('V-B3 覆盖确认（真实驱动 openForm / submit）');
App.Store.init();
const oldHit = rec({
  name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
  examYm: '2026-09', scores: LOW.slice(), id: 'hit1', ts: '2026-09-01T00:00:00Z'
});
App.Store.data.records = [oldHit];
const formB3 = driveForm(null, { '[name=examYear]': '2026', '[name=examMonth]': '10' });
ok('openForm 生成主录入窗（okText=提交录入）', !!formB3.opts && formB3.opts.okText === '提交录入');
const submitB3 = formB3.opts.onOk(formB3.mask);
eq(v('V-B3'), 'submit 命中同键且年月不同 → 返回 false（录入窗保持打开）', submitB3, false);
const confirmOpts = MODAL_CALLS[MODAL_CALLS.length - 1];
eq('覆盖确认 okText = 覆盖并保存', confirmOpts.okText, '覆盖并保存');
eq('覆盖确认 cancelText = 返回修改', confirmOpts.cancelText, '返回修改');
ok('覆盖确认文案由 Modal.open 原生参数提供（源码无 DOM 文案改写）',
  fs.readFileSync(path.join(SRC, 'module-score.js'), 'utf8').indexOf("querySelector('[data-ok]')") < 0);
eq('返回修改不产生写入：记录数不变', App.Store.data.records.length, 1);
eq('返回修改不产生写入：原记录 examYm 不变', App.Store.data.records[0].examYm, '2026-09');
confirmOpts.onOk(formB3.mask);   // 点「覆盖并保存」→ persistRec → Score.upsert
eq('覆盖并保存：行数不变（upsert update）', App.Store.data.records.length, 1);
eq('覆盖并保存：examYm 更新为 2026-10', App.Store.data.records[0].examYm, '2026-10');

/* =========================================================
 * V-C1：examCmp 第 3–5 级兜底 U.zh→ts→id；多次 render 不抖动
 * ========================================================= */
section('V-C1 排序兜底链与稳定性');
const tieArr = [
  rec({ exam: '同场', examYm: '2026-10', id: 'b', ts: '2026-10-01T00:00:00Z' }),
  rec({ exam: '同场', examYm: '2026-10', id: 'a', ts: '2026-10-01T00:00:00Z' }),
  rec({ exam: '同场', examYm: '2026-10', id: 'c', ts: '2026-10-01T00:00:00Z' })
];
eq(v('V-C1'), '同 exam 同年月同 ts：String(id) 兜底', ids(Score.sortByExam(tieArr)), 'a,b,c');
ok('连续 3 次 sortByExam 结果完全一致（多次 App.render 不抖动）',
  ids(Score.sortByExam(tieArr)) === ids(Score.sortByExam(tieArr)) &&
  ids(Score.sortByExam(tieArr)) === ids(Score.sortByExam(tieArr)));
ok('examOrderKey 返回 exam/ts/id 三个兜底字段',
  typeof kDec.exam === 'string' && typeof kDec.ts === 'number' && typeof kDec.id === 'string');

/* =========================================================
 * V-C2：last=arr[n-1]、prev=arr[n-2]；analysis 首/末与 dir 用同一序列
 * ========================================================= */
section('V-C2 首末序列一致性');
const seqC = [
  rec({ exam: '一', examYm: '2026-09', scores: HIGH.slice() }),
  rec({ exam: '二', examYm: '2026-10', scores: [100, 100, 100, 60, 60, 0, 0, 0, 60].slice() }),
  rec({ exam: '三', examYm: '2026-11', scores: LOW.slice() })
];
const buildC2 = App.Analysis.build({ target: seqC[2], classRows: seqC, gradeRows: seqC, studentRows: seqC });
eq(v('V-C2'), 'trend.exams 顺序 == 传入 studentRows 顺序',
  buildC2.trend.exams.map(function (e) { return e.exam; }).join(','), '一,二,三');
eq('trend.exams[0] = 首考（arr[0]）', buildC2.trend.exams[0].exam, '一');
eq('trend.exams[n-1] = 最近（arr[n-1]）', buildC2.trend.exams[2].exam, '三');
ok('totalDelta = last − first（符号随年月序）', buildC2.trend.totalDelta < 0,
  'totalDelta=' + buildC2.trend.totalDelta);
ok('bySubject[0].dir 与 delta 符号一致（同一序列）',
  buildC2.trend.bySubject[0].delta < 0 && buildC2.trend.bySubject[0].dir === 'down',
  'delta=' + buildC2.trend.bySubject[0].delta + ' dir=' + buildC2.trend.bySubject[0].dir);

/* =========================================================
 * V-C3：Score.history 算法不改（±2/±5），仅输入序列改 sortByExam
 * ========================================================= */
section('V-C3 Score.history 阈值零改动');
function histOf(a, b) { return Score.history([rec({ exam: 'A', scores: [a].concat(ZERO9().slice(1)) }), rec({ exam: 'B', scores: [b].concat(ZERO9().slice(1)) })], 0, b).conclusion; }
ok(v('V-C3'), '±1 → 基本持平', histOf(80, 81).indexOf('基本持平') >= 0, histOf(80, 81));
ok('+3 → 略有上升', histOf(80, 83).indexOf('略有上升') >= 0, histOf(80, 83));
ok('+6 → 稳步上升', histOf(80, 86).indexOf('稳步上升') >= 0, histOf(80, 86));
ok('−6 → 明显下滑', histOf(80, 74).indexOf('明显下滑') >= 0, histOf(80, 74));
eq('desc 链仍为 exam:分数 链（算法零改动）',
  Score.history([rec({ exam: 'A', scores: [80].concat(ZERO9().slice(1)) }), rec({ exam: 'B', scores: [90].concat(ZERO9().slice(1)) })], 0, 90).desc,
  'A:80 \u2192 B:90');
eq('少于 2 条仍返回首次考试', Score.history([recA[0]], 0, 60).desc, '首次考试');

/* =========================================================
 * V-D1：全缺年月 → legacySortByTs 逐字回退；x 轴 label golden diff
 * ========================================================= */
section('V-D1 全缺年月逐字回退（D5 golden diff，硬项）');
const longExam = '二零二六年秋季学期第一次月考统考';
const allMissing = [
  rec({ exam: '10月段考', id: 'g1', ts: '2020-01-01T00:00:00Z' }),
  rec({ exam: '11月期中', id: 'g2', ts: '2020-02-01T00:00:00Z' }),
  rec({ exam: longExam, id: 'g3', ts: '2020-03-01T00:00:00Z' })
];
const legacyOut = App.__LegacySort(allMissing);
eq(v('V-D1'), '全缺年月：sortByExam === legacySortByTs（逐字回退）',
  ids(Score.sortByExam(allMissing)), ids(legacyOut));
eq('全缺年月：Score.sort === legacySortByTs（总表同一回退分支）',
  ids(Score.sort(allMissing)), ids(legacyOut));
/* 故意让 exam 的 U.zh 顺序与录入时间序冲突：证明 sortByExam 在全缺年月时
   逐字回退 legacySortByTs，而不是走 examCmp 的纯 U.zh→ts→id 排序。 */
const zhOrder = ['甲考试', '乙考试', '丙考试'].sort(U.zh);
const conflict = zhOrder.map(function (ex, i) {
  return rec({ exam: ex, id: 'c' + (zhOrder.length - i),
    ts: new Date(Date.UTC(2020, 0, zhOrder.length - i)).toISOString() });
});
ok('全缺年月确实走 legacy 分支（与 examCmp 纯排序结果不同）',
  ids(conflict.slice().sort(Score.examCmp)) !== ids(App.__LegacySort(conflict)) &&
  ids(Score.sortByExam(conflict)) === ids(App.__LegacySort(conflict)));
const axD1 = Score.examAxisLabels(allMissing);
eq('x 轴 label golden diff：逐字等于 exam 原文（无前缀、无截断）',
  axD1.map(function (a) { return a.label; }).join('|'), examNames(allMissing).replace(/\|/g, '|'));
ok('x 轴 label 不出现任何 未标注·/异常·/YY年·/M月· 前缀',
  axD1.every(function (a) { return !/^(未标注·|异常·|\d\d年·|\d+月·)/.test(a.label); }));
ok('全缺年月：超长 exam 名不被 8 字截断', axD1[2].label === longExam);
eq('x 轴 title 也逐字等于 exam 原文',
  axD1.map(function (a) { return a.title; }).join('|'),
  allMissing.map(function (r) { return r.exam; }).join('|'));
App.Store.init();
App.Store.data.records = allMissing.slice();
ok('renderMaster() 全缺年月数据仍正常渲染（走 Score.sort 回退）',
  ST.renderMaster().indexOf('未标注年月') >= 0);

/* =========================================================
 * V-D2：has 优先、num=+Infinity 排末尾；首/末只对 has 子序列取
 * ========================================================= */
section('V-D2 混合序列 has 优先与趋势过滤');
const mixedD = [
  rec({ exam: '无年月', id: 'm1', ts: '2020-01-01T00:00:00Z' }),
  rec({ exam: '十月', examYm: '2026-10', id: 'm2', ts: '2026-10-01T00:00:00Z' }),
  rec({ exam: '十二月', examYm: '2025-12', id: 'm3', ts: '2025-12-01T00:00:00Z' }),
  rec({ exam: '脏值', examYm: '2026-1', id: 'm4', ts: '2021-01-01T00:00:00Z' })
];
const mixedOut = Score.sortByExam(mixedD);
eq(v('V-D2'), '混合序列：有效年月在前按 num 升序', ids(mixedOut.slice(0, 2)), 'm3,m2');
ok('混合序列：缺年月 / 异常一律排末尾', mixedOut.slice(2).every(function (r) { return !Score.examOrderKey(r).has; }));
ok('缺年月 / 异常 → has=false、num=+Infinity',
  Score.examOrderKey(mixedD[0]).has === false &&
  Score.examOrderKey(mixedD[0]).num === Number.POSITIVE_INFINITY &&
  Score.examOrderKey(mixedD[3]).num === Number.POSITIVE_INFINITY);
const hasOnly = [mixedD[2], mixedD[1]];   // 调用方过滤无年月行后再喂趋势图
const buildD2 = App.Analysis.build({ target: hasOnly[1], classRows: hasOnly, gradeRows: hasOnly, studentRows: hasOnly });
eq('趋势计算只取 has 子序列（exams 长度 == 2，未混入无年月行）', buildD2.trend.exams.length, 2);

/* =========================================================
 * V-D3：非法值 invalid / fromRow 原值 / 年月异常 / 前缀三态
 * ========================================================= */
section('V-D3 非法年月三态与 UI 区分');
const badYm = Score.examYmOf('2026-1');
eq(v('V-D3'), 'examYmOf 正则不匹配 → state=invalid', badYm.state, 'invalid');
ok('非法值 has=false、原样保留', badYm.valid === false && badYm.raw === '2026-1' &&
  Score.examOrderKey({ examYm: '2026-1' }).has === false);
eq('fromRow 云端脏值原样进内存（不补零不纠偏）',
  T.fromRow(cloudRow({ exam_ym: '2026-1' })).examYm, '2026-1');
eq('examYmLabel 非法值 → 年月异常', Score.examYmLabel({ examYm: '2026-1' }), '年月异常');
const axD3 = Score.examAxisLabels([rec({ exam: '补录' }), rec({ exam: '脏值', examYm: '2026-1' })]);
ok('x 轴可见前缀：缺年月 未标注· / 非法值 异常·',
  axD3[0].label.indexOf('未标注·') === 0 && axD3[1].label.indexOf('异常·') === 0);
eq('非法值 title 标「年月异常 · exam 原文」', axD3[1].title, '年月异常 · 脏值');

/* =========================================================
 * V-E1：defaultExamYm 本地 new Date；窗体两个 select 默认当前 y/m
 * ========================================================= */
section('V-E1 默认值与两个下拉');
eq(v('V-E1'), 'defaultExamYm() = 本地当前年月', Score.defaultExamYm(), localYm());
ok('defaultExamYm() 符合严格 YYYY-MM', YM_RE.test(Score.defaultExamYm()));
App.Store.init();
const formE1 = driveForm(null);
ok('openForm 生成 HTML 含 examYear / examMonth 两个 <select>',
  formE1.body.innerHTML.indexOf('name="examYear"') >= 0 &&
  formE1.body.innerHTML.indexOf('name="examMonth"') >= 0);
ok('新建态默认选中当前年（option selected）',
  formE1.body.innerHTML.indexOf('value="' + formE1.curY + '" selected') >= 0,
  'curY=' + formE1.curY);
ok('新建态默认选中当前月（option selected）',
  formE1.body.innerHTML.indexOf('value="' + formE1.curM + '" selected') >= 0,
  'curM=' + formE1.curM);

/* =========================================================
 * V-E2：submit → makeExamYm(2025,12) → toRow exam_ym → fromRow 回显
 * ========================================================= */
section('V-E2 年月落库写穿链路（module-score→core→sync）');
eq(v('V-E2'), 'makeExamYm(2025, 12) = 2025-12', Score.makeExamYm(2025, 12), '2025-12');
App.Store.init();
const formE2 = driveForm(null, { '[name=examYear]': '2025', '[name=examMonth]': '12' });
eq('submit 成功返回 true', formE2.opts.onOk(formE2.mask), true);
eq('落库记录 examYm = 2025-12', App.Store.data.records[0].examYm, '2025-12');
eq('toRow 条件带 exam_ym = 2025-12', T.toRow(App.Store.data.records[0]).exam_ym, '2025-12');
eq('fromRow 刷新回显 examYm = 2025-12',
  T.fromRow(cloudRow({ exam_ym: '2025-12' })).examYm, '2025-12');

/* =========================================================
 * V-E3：openForm(existing) 回显 y/m；提交未改值不变（fp 含该字段）
 * ========================================================= */
section('V-E3 编辑回显与 fp 不误判');
App.Store.init();
const existingE3 = rec({
  name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
  examYm: '2026-10', scores: HIGH.slice(), id: 'e3', ts: '2026-10-01T00:00:00Z'
});
App.Store.data.records = [existingE3];
const formE3 = driveForm(existingE3);
ok(v('V-E3'), 'openForm(existing) 回显年 2026（option selected）',
  formE3.body.innerHTML.indexOf('value="2026" selected') >= 0);
ok('openForm(existing) 回显月 10（option selected）',
  formE3.body.innerHTML.indexOf('value="10" selected') >= 0);
eq('编辑态 okText = 保存修改', formE3.opts.okText, '保存修改');
const fpBase = rec({ name: 'A', exam: 'E', examYm: '2026-10', scores: ZERO9(), id: 'fp1' });
const fpChanged = Object.assign({}, fpBase, { examYm: '2026-11' });
ok('fp 含 examYm：仅年月变化指纹必变（不会误判为无变化）', T.fp(fpBase) !== T.fp(fpChanged));
eq('fp 第 8 项 = examYm', JSON.parse(T.fp(fpBase))[7], '2026-10');

/* =========================================================
 * V-E4：keep 追加 examYear/examMonth，重置时保留；只清姓名/分数/排名
 * ========================================================= */
section('V-E4 连续录入保留年月');
App.Store.init();
const formE4 = driveForm(null, { '[name=examYear]': '2025', '[name=examMonth]': '12' });
/* 连续录入按钮注册在 footer.insertBefore 的 cont 上；这里直接取回 body 的 footer 子节点 */
const footerE4 = formE4.mask.querySelector('footer');   // cont 插在 Modal.open 返回的 mask footer 上
const contBtn = footerE4.children[0];
ok(v('V-E4'), '连续录入按钮已注册 click handler', !!contBtn && typeof contBtn._handlers.click === 'function');
/* 填写姓名与分数，然后触发「提交并继续录入下一位」 */
formE4.body.querySelector('[name=name]').value = '下一位';
formE4.body._scoreInputs[0].value = '99';
if (contBtn && contBtn._handlers.click) contBtn._handlers.click();
eq('连续录入后 examYear 保留 2025', formE4.body.querySelector('[name=examYear]').value, '2025');
eq('连续录入后 examMonth 保留 12', formE4.body.querySelector('[name=examMonth]').value, '12');
eq('连续录入后 学校保留', formE4.body.querySelector('[name=school]').value, '一中');
eq('连续录入后 考试名称保留', formE4.body.querySelector('[name=exam]').value, '期中考试');
eq('连续录入后 姓名清空', formE4.body.querySelector('[name=name]').value, '');
eq('连续录入后 分数清空', formE4.body._scoreInputs[0].value, '');
ok('源码 keep 对象含 examYear / examMonth',
  fs.readFileSync(path.join(SRC, 'module-score.js'), 'utf8').indexOf('examYear: body.querySelector') >= 0);

/* =========================================================
 * V-E5：makeExamYm() undefined → fail('请选择考试年份和月份！','[name=examYear]')
 * ========================================================= */
section('V-E5 年月必填校验');
eq(v('V-E5'), 'makeExamYm(空, 空) → undefined', Score.makeExamYm('', ''), undefined);
App.Store.init();
const formE5 = driveForm(null, { '[name=examYear]': '', '[name=examMonth]': '' });
eq('submit 返回 false（校验拦截）', formE5.opts.onOk(formE5.mask), false);
ok('form-err 显示「请选择考试年份和月份！」',
  formE5.body.querySelector('#form-err').innerHTML.indexOf('请选择考试年份和月份') >= 0,
  formE5.body.querySelector('#form-err').innerHTML);
eq('校验失败不落库（记录数 0）', App.Store.data.records.length, 0);

/* =========================================================
 * V-E6：年月 > defaultExamYm → 黄条软提示；submit 不拦截
 * ========================================================= */
section('V-E6 未来年月软提示不拦截');
App.Store.init();
const futureY = String(new Date().getFullYear() + 1);
const formE6 = driveForm(null, { '[name=examYear]': futureY, '[name=examMonth]': '01' });
const selY = formE6.body.querySelector('[name=examYear]');
if (selY._handlers.change) selY._handlers.change();     // 触发 paintYmFuture
ok(v('V-E6'), '未来年月 → 黄条软提示显示（display 非 none）',
  formE6.body.querySelector('#ym-future-hint').style.display === '');
ok('软提示文案含「晚于当前年月」且注明「不影响保存」',
  formE6.body.querySelector('#ym-future-hint').innerHTML.indexOf('晚于当前年月') >= 0 &&
  formE6.body.querySelector('#ym-future-hint').innerHTML.indexOf('软提示') >= 0);
eq('submit 不拦截：返回 true', formE6.opts.onOk(formE6.mask), true);
eq('submit 不拦截：记录落库 examYm = ' + futureY + '-01',
  App.Store.data.records[0].examYm, futureY + '-01');

/* =========================================================
 * V-E7：fp 含 examYm → 只改年月触发 pushRows 推 toRow（硬项）
 * ========================================================= */
section('V-E7 只改年月触发写穿（硬项）');
const fpE7a = rec({ name: '李四', school: 'S', cls: 'C', exam: '期末考试', examYm: '2026-10', id: 'f1', scores: ZERO9() });
const fpE7b = Object.assign({}, fpE7a, { examYm: '2026-11' });
ok(v('V-E7'), 'fp：仅 examYm 变化时 snap[k] !== fp(r)（会触发 pushRows）',
  T.fp(fpE7a) !== T.fp(fpE7b));
eq('toRow 推出云端新值 exam_ym = 2026-11', T.toRow(fpE7b).exam_ym, '2026-11');
eq('fromRow 刷新后保留 examYm = 2026-11',
  T.fromRow(cloudRow({ exam_ym: '2026-11' })).examYm, '2026-11');
eq('snapState 带 examYm', T.snapState(fpE7a).examYm, '2026-10');
const snapRestore = rec({ examYm: '2099-12', id: 'f1' });
T.restoreState(snapRestore, T.snapState(fpE7a));
eq('restoreState 还原 examYm', snapRestore.examYm, '2026-10');
const syncSrc = fs.readFileSync(path.join(SRC, 'sync.js'), 'utf8');
ok('sync.js fp 源码含 examYm 第 8 项', /JSON\.stringify\(\[[\s\S]*?examYm/.test(syncSrc));
ok('sync.js toRow 条件写 exam_ym + fromRow 读 exam_ym',
  syncSrc.indexOf('row.exam_ym = r.examYm') >= 0 &&
  syncSrc.indexOf('examYm: (row.exam_ym == null)') >= 0);
ok('sync.js pushRows 使用 fp / toRow（源码契约）',
  syncSrc.indexOf('function pushRows()') >= 0 && syncSrc.indexOf('toRow(') >= 0);

/* =========================================================
 * V-F1：masterExportRows 26 列 golden，无「考试年月」列（硬项）
 * ========================================================= */
section('V-F1 26 列导出契约零改动（硬项）');
const GOLDEN_HEAD = [
  '序号', '姓名', '学校', '班级', '考试名称',
  '语文', '语文排名', '数学', '数学排名', '英语', '英语排名',
  '物理', '物理排名', '化学', '化学排名', '政治', '政治排名',
  '历史', '历史排名', '地理', '地理排名', '生物', '生物排名',
  '总分', '总分排名', '录入时间'
];
App.Store.init();
App.Store.data.records = [recA[0], recA[1]];
const exportRows = ST.masterExportRows();
eq(v('V-F1'), 'masterExportRows 表头 26 列（5 + 2×9 + 3）', exportRows[0].length, 26);
eq('masterExportRows 表头列名/顺序逐字一致（golden diff）',
  JSON.stringify(exportRows[0]), JSON.stringify(GOLDEN_HEAD));
ok('导出表头不含「考试年月」列', exportRows[0].indexOf('考试年月') < 0,
  JSON.stringify(exportRows[0]));
eq('masterExportRows 数据行数 == 记录数', exportRows.length, 3);
eq('导出行仍是 26 列（未因 UI 加列而变宽）', exportRows[1].length, 26);
ok('App.X.csv 真实序列化 26 列不抛错',
  typeof App.X.csv(exportRows) === 'string' && App.X.csv(exportRows).length > 0);
ok('masterExportRows 只定义在 module-score.js（export.js 里没有）',
  fs.readFileSync(path.join(SRC, 'export.js'), 'utf8').indexOf('masterExportRows') < 0);
ok('export.js 四个序列化器仍在（toCSV/xlsx/backup/restore 零改动）',
  typeof App.X.csv === 'function' && typeof App.X.xlsx === 'function' &&
  typeof App.X.backupJSON === 'function' && typeof App.X.restoreJSON === 'function');
ok('UI「考试年月」列只在 renderMaster，不进导出（V-A2 已证 renderMaster 含该列）',
  masterHtml.indexOf('考试年月') >= 0 && exportRows[0].indexOf('考试年月') < 0);

/* =========================================================
 * V-F2：backupJSON 透传 examYm；normalizeRecord；restoreJSON 同键合并
 * ========================================================= */
section('V-F2 备份 / 恢复白名单');
App.Store.init();
App.Store.data.records = [rec({ name: '备份甲', exam: '期中', examYm: '2026-10', scores: HIGH.slice(), id: 'bk1' })];
CAPTURED_BLOB = '';
eq(v('V-F2'), 'backupJSON 返回导出条数 1', App.X.backupJSON(), 1);
let backupObj = null;
try { backupObj = JSON.parse(CAPTURED_BLOB); } catch (e) { backupObj = null; }
ok('backupJSON 透传 examYm（备份 JSON 内含 2026-10）',
  !!backupObj && backupObj.records[0].examYm === '2026-10');
eq('normalizeRecord 白名单带 examYm', X.normalizeRecord({ name: 'A', exam: 'E', examYm: '2026-10', scores: ZERO9() }).examYm, '2026-10');
ok('normalizeRecord 缺字段 → undefined（不填空串）',
  X.normalizeRecord({ name: 'A', exam: 'E', scores: ZERO9() }).examYm === undefined);
App.Store.init();
App.Store.data.records = [rec({ name: '备份甲', exam: '期中', examYm: '2026-09', scores: ZERO9(), id: 'old1' })];
eq('restoreJSON 新备份导入 1 条', X.restoreJSON(JSON.stringify({
  version: 1, records: [{ name: '备份甲', exam: '期中', examYm: '2026-11', scores: ZERO9() }]
})), 1);
eq('restoreJSON 同键合并：行数不变', App.Store.data.records.length, 1);
eq('restoreJSON 同键合并：examYm 保留 2026-11', App.Store.data.records[0].examYm, '2026-11');
eq('toRow 条件带 exam_ym = 2026-11', T.toRow(App.Store.data.records[0]).exam_ym, '2026-11');

/* =========================================================
 * V-F3：恢复不含 examYm 的旧备份 → 云端年月不清空（硬项，端到端）
 * ========================================================= */
section('V-F3 旧备份恢复不清空云端年月（硬项）');
App.Store.init();
const cloudBackfilled = rec({
  name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
  examYm: '2026-10', scores: HIGH.slice(), id: 'v1', ts: '2026-10-15T00:00:00.000Z'
});
cloudBackfilled._cid = 99;
App.Store.data.records = [cloudBackfilled];
const fpBeforeF3 = T.fp(cloudBackfilled);
const oldBackup = JSON.stringify({
  version: 1,
  records: [{
    id: 'external', name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
    scores: ZERO9(), ranks: ZERO9(), totalRank: 0, ts: '2026-10-15T00:00:00.000Z'
  }]
});
eq(v('V-F3'), '恢复不含 examYm 的完整旧备份 → 导入 1 条', X.restoreJSON(oldBackup), 1);
const mergedF3 = App.Store.data.records[0];
eq('恢复旧备份：行数不变（同键合并）', App.Store.data.records.length, 1);
ok('恢复旧备份：命中行整体替换 → 内存 examYm = undefined', mergedF3.examYm === undefined);
eq('恢复旧备份：继承 _cid', mergedF3._cid, 99);
eq('恢复旧备份：保留原 id', mergedF3.id, 'v1');
eq('恢复旧备份：唯一键 4 字段不变', Score.key(mergedF3), Score.key(cloudBackfilled));
const mergedRowF3 = T.toRow(mergedF3);
ok('恢复旧备份：toRow 省略 exam_ym → 云端 42 行年月不被清空',
  !Object.prototype.hasOwnProperty.call(mergedRowF3, 'exam_ym'));
ok('恢复旧备份：fp 变化会多触发一次 update（R4 预期）', T.fp(mergedF3) !== fpBeforeF3);
ok('恢复旧备份：updated_at / last_editor 仍照常刷新',
  Object.prototype.hasOwnProperty.call(mergedRowF3, 'updated_at') &&
  Object.prototype.hasOwnProperty.call(mergedRowF3, 'last_editor'));
eq('下次拉取 fromRow 恢复本地年月显示',
  T.fromRow(cloudRow({ exam_ym: '2026-10', stu_name: '郭阳阳', exam: '期中考试' })).examYm, '2026-10');
/* §7 C.10：带 examYm: null 的手工备份全链路同样不清空 */
App.Store.init();
const cloudNull = rec({
  name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
  examYm: '2026-10', scores: HIGH.slice(), id: 'v2', ts: '2026-10-15T00:00:00.000Z'
});
cloudNull._cid = 98;
App.Store.data.records = [cloudNull];
eq('恢复带 examYm:null 的手工备份 → 导入 1 条', X.restoreJSON(JSON.stringify({
  version: 1,
  records: [{
    id: 'external2', name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
    examYm: null, scores: ZERO9(), ranks: ZERO9(), totalRank: 0, ts: '2026-10-15T00:00:00.000Z'
  }]
})), 1);
ok('null 备份：normalizeRecord 归一为 undefined（fp 第 8 项不是 "null"）',
  App.Store.data.records[0].examYm === undefined && JSON.parse(T.fp(App.Store.data.records[0]))[7] === '');
ok('null 备份：toRow 全链路不写 exam_ym → 云端年月不被清空',
  !Object.prototype.hasOwnProperty.call(T.toRow(App.Store.data.records[0]), 'exam_ym'));

/* =========================================================
 * V-G1：四处统一调用 sortByExam / sort / options，共用 examOrderKey.num
 * ========================================================= */
section('V-G1 四处统一调用与唯一排序键');
const scoreSrc = fs.readFileSync(path.join(SRC, 'module-score.js'), 'utf8');
const classesSrc = fs.readFileSync(path.join(SRC, 'module-classes.js'), 'utf8');
const analysisSrc = fs.readFileSync(path.join(SRC, 'analysis.js'), 'utf8');
ok(v('V-G1'), 'module-score.js 调用 Score.sortByExam / Score.sort / Score.options',
  scoreSrc.indexOf('Score.sortByExam(') >= 0 && scoreSrc.indexOf('Score.sort(') >= 0 &&
  scoreSrc.indexOf('Score.options(') >= 0);
ok('module-classes.js 调用 Score.sortByExam / Score.examOrderKey',
  classesSrc.indexOf('Score.sortByExam(') >= 0 && classesSrc.indexOf('Score.examOrderKey(') >= 0);
ok('analysis.js 不自行排序 studentRows（exams 直接 map 传入序列）',
  analysisSrc.indexOf('studentRows.map(') >= 0 &&
  !/studentRows[^\n]*\.sort\(/.test(analysisSrc));
ok('examOrderKey 只在 core.js 定义（唯一排序键来源）',
  fs.readFileSync(path.join(SRC, 'core.js'), 'utf8').indexOf('examOrderKey: function') >= 0 &&
  classesSrc.indexOf('year * 12') < 0);
const g1Data = [
  rec({ exam: '期末', examYm: '2026-11' }), rec({ exam: '期中', examYm: '2026-09' }),
  rec({ exam: '月考', examYm: '2026-10' })
];
ok('三层级对同一数据集给出一致年月序（sort / sortByExam / options.exams）',
  examNames(Score.sort(g1Data)) === '期中|月考|期末' &&
  examNames(Score.sortByExam(g1Data)) === '期中|月考|期末' &&
  Score.options(g1Data).exams.join('|') === '期中|月考|期末');

/* =========================================================
 * V-G2：ClassesCore perStudent last/prev 改 sortByExam 序列；delta 符号随年月序
 * ========================================================= */
section('V-G2 班级分析最近一次按年月序');
const studentsG = [{ id: 1, stu_name: '学生A', school: '一中', grade: '高三', phone: '', subjects: [], teachers: [], created_at: '2026-01-01' }];
const membersG = [{ id: 1, class_id: 1, student_id: 1 }];
function clsRec(exam, ym, scores, enteredAt) {
  return {
    name: '学生A', school: '一中', cls: '高三(1)班', exam: exam, examYm: ym,
    scores: scores, ranks: ZERO9(), totalRank: 0, entered_at: enteredAt, ts: enteredAt
  };
}
const clsG = App.ClassesCore.classScoreAnalysis(1, {
  students: studentsG, members: membersG,
  records: [
    clsRec('11月段考', '2026-11', LOW.slice(), '2026-11-05T02:00:00Z'),
    clsRec('10月段考', '2026-10', HIGH.slice(), '2026-11-19T02:00:00Z')
  ]
});
eq(v('V-G2'), 'perExam 顺序按年月 = 10月段考|11月段考',
  clsG.perExam.map(function (e) { return e.exam; }).join('|'), '10月段考|11月段考');
eq('perStudent 最近一次 = 11月段考（年月最大，非录入最晚）', clsG.perStudent[0].exam, '11月段考');
ok('perStudent.delta < 0（年月序下 40.9% − 80.9%）', clsG.perStudent[0].delta < 0,
  'delta=' + clsG.perStudent[0].delta);
eq('perExam[0].examYm = 2026-10', clsG.perExam[0].examYm, '2026-10');

/* =========================================================
 * V-G3：同考试去重仍按 entered_at 取较新一行，不拆成两次（硬项）
 * ========================================================= */
section('V-G3 同考试去重仍按 entered_at（硬项）');
const dupRows = [
  clsRec('段考', '2026-10', [100, 100, 100, 60, 60, 0, 0, 0, 60], '2026-10-01T02:00:00Z'),  // 旧行 480
  clsRec('段考', '2026-10', [60, 60, 60, 40, 40, 0, 0, 0, 47], '2026-10-20T02:00:00Z'),   // 新行 307
  clsRec('期末', '2026-12', HIGH.slice(), '2026-12-01T02:00:00Z')
];
const clsG3 = App.ClassesCore.classScoreAnalysis(1, {
  students: studentsG, members: membersG, records: dupRows
});
const segExams = clsG3.perExam.map(function (e) { return e.exam; });
eq(v('V-G3'), '同一场考试不被拆成两次（perExam 里「段考」只出现 1 次）',
  segExams.filter(function (e) { return e === '段考'; }).length, 1);
eq('perExam 共 2 场考试（段考 + 期末）', segExams.length, 2);
eq('分组位置按 exam_ym：段考(2026-10) 在 期末(2026-12) 前', segExams.join('|'), '段考|期末');
ok('byExam 去重取 entered_at 较新一行（avg ≈ 307 而非 480）',
  clsG3.perExam[0].avg < 400 && clsG3.perExam[0].avg > 250,
  'avg=' + clsG3.perExam[0].avg);
ok('去重不影响「该场只算一次」：kpi.exams == 2', clsG3.kpi.exams === 2,
  'kpi.exams=' + clsG3.kpi.exams);

/* =========================================================
 * V-H1 / V-H2：G1 生产终验红线（真数据 + 真 md5 复算，硬项）
 * ========================================================= */
section('V-H1 / V-H2 生产红线（硬项）');
const snap = JSON.parse(fs.readFileSync(path.join(DOCS, 'v3-postflight-snapshot.json'), 'utf8'));
const backup = JSON.parse(fs.readFileSync(path.join(DOCS, 'backup-pre-v3.json'), 'utf8'));
const baseline = fs.readFileSync(path.join(DOCS, 'baseline-score.txt'), 'utf8');
const E = snap.expected, P = snap.pre, Q = snap.post;
const FP_A = 'd08aab5b7f0aa8028873f67bd0248859';
const FP_C = '4120b89db2e0df7be40c564f7e41b70b';
const FP3 = '120df1f4d7924b7dd1adeaff47beb3d5';
eq(v('V-H1'), '权威常量 口径 A', E.fp_A, FP_A);
eq('权威常量 口径 C', E.fp_C, FP_C);
eq('权威常量 三列 fp3', E.fp3, FP3);
eq('口径 A 行数 n=42（pre）', P.n, 42);
eq('口径 A 行数 n=42（post）', Q.n, 42);
eq('口径 A pre == post（逐字节一致）', Q.fp_A, P.fp_A);
eq('口径 A post == 权威常量', Q.fp_A, FP_A);
eq('口径 C pre == post（逐字节一致）', Q.fp_C, P.fp_C);
eq('口径 C post == 权威常量', Q.fp_C, FP_C);
ok('baseline-score.txt 同时含口径 A / 口径 C / fp3 三常量',
  baseline.indexOf(FP_A) >= 0 && baseline.indexOf(FP_C) >= 0 && baseline.indexOf(FP3) >= 0);
ok('baseline-score.txt 保留 40 行历史留证（不覆写）',
  baseline.indexOf('af05d139d587b91d331d7a3348270750') >= 0);
eq('列数 16 → 17（仅 +1 exam_ym）', P.cols + 1, Q.cols);
eq('唯一索引定义不变', Q.unique_index, 'score_records_unique_stu (stu_name, school, class_name, exam)');
eq('RLS 策略 4 条不变', Q.rls_policies, 4);
eq('索引 2 个不变', Q.indexes, 2);
eq('自定义触发器 0（pre）', P.custom_triggers, 0);
ok(v('V-H2'), '触发器预检 pg_trigger=[]（post 无自定义触发器）', Q.custom_triggers === 0);
eq('无列级 REVOKE', P.column_revoke, false);
/* 真复算：backup-pre-v3.json 42 行三列按同式 md5 */
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
const three = backup.three_cols.slice().sort(function (a, b) { return a.id - b.id; });
const recomputed = md5(three.map(function (r) {
  return [String(r.id), r.entered_at == null ? '' : r.entered_at,
    r.updated_at == null ? '' : String(r.updated_at),
    r.last_editor == null ? '' : r.last_editor].join('|');
}).join('\n'));
eq('V-H2 底稿 42 行三列复算 fp3 == 权威常量', three.length, 42);
eq('V-H2 复算 fp3 逐字节一致', recomputed, FP3);
eq('V-H2 云端 post fp3 == 底稿复算', Q.fp3, recomputed);
eq('V-H2 pre fp3 == post fp3', Q.fp3, P.fp3);
eq('V-H2 非法年月数 0（bad_ym）', Q.bad_ym, 0);
eq('V-H2 分布 2026-10 = 41', Q.distribution['2026-10'], 41);
eq('V-H2 分布 2026-11 = 1', Q.distribution['2026-11'], 1);
eq('V-H2 分布合计 == 42', Q.distribution['2026-10'] + Q.distribution['2026-11'], 42);
eq('backup _meta.rows == 42', backup._meta.rows, 42);
ok('exam_ym 列定义：text / nullable / 无默认值',
  Q.exam_ym_column.data_type === 'text' && Q.exam_ym_column.is_nullable === 'YES' &&
  Q.exam_ym_column.column_default === null);

/* =========================================================
 * V-H3：构建刷新 ?v= 缓存击穿 + 单文件版内联新 js
 * ========================================================= */
section('V-H3 构建产物缓存击穿');
ok(v('V-H3'), 'index.html 含 <meta http-equiv="Cache-Control" content="no-store">',
  /<meta\s+http-equiv="Cache-Control"\s+content="no-store"/.test(indexHtml));
const stamped = JS_FILES.every(function (f) {
  return indexHtml.indexOf('src="js/' + f + '?v=') >= 0;
});
ok('23 个本地 js 全部带 ?v= 版本号', stamped && JS_FILES.length === 23);
ok('assets/style.css 带 ?v= 版本号',
  /href="assets\/style\.css\?v=\d+"/.test(indexHtml));
const versions = [];
indexHtml.replace(/\?v=(\d{12})/g, function (m, d) { versions.push(d); return m; });
ok('本地资源版本号一致（同次构建同一时间戳）',
  versions.length >= 24 && versions.every(function (x) { return x === versions[0]; }),
  '版本数=' + versions.length + ' 首值=' + versions[0]);
ok('CDN SDK 行绝对不动（不带 ?v=）',
  /src="https:\/\/cdn\.jsdelivr\.net\/npm\/@tencent-ai\/workbuddy-cloud-sdk@dev\/lib\/index\.global\.js"/.test(indexHtml));
const buildPy = fs.readFileSync(path.join(ROOT, 'build-single.py'), 'utf8');
ok('build-single.py 含 stamp_local_assets 版本号刷新逻辑',
  buildPy.indexOf('def stamp_local_assets') >= 0 && buildPy.indexOf('STAMP') >= 0);
ok('build-single.py 内联兼容带 ?v= 的 script/css 写法',
  buildPy.indexOf('(?:\\?v=\\d+)?') >= 0);
const singlePath = path.join(ROOT, '..', '学生管理系统-单文件版.html');
const singleExists = fs.existsSync(singlePath);
ok('单文件版产物存在', singleExists);
if (singleExists) {
  const singleHtml = fs.readFileSync(singlePath, 'utf8');
  ok('单文件版内联了新 module-score.js（含 examYm / examYear 窗体字段）',
    singleHtml.indexOf('examYm') >= 0 && singleHtml.indexOf('examYear') >= 0);
  ok('单文件版无未内联的本地 js 残留',
    !/<script src="js\/[a-z\-]+\.js/.test(singleHtml));
}

/* =========================================================
 * §8 逐条覆盖自检（V-A1 ~ V-H3 共 27 条）
 * ========================================================= */
section('§8 验收项逐条覆盖自检');
const V_IDS = [
  'V-A1', 'V-A2', 'V-B1', 'V-B2', 'V-B3',
  'V-C1', 'V-C2', 'V-C3', 'V-D1', 'V-D2', 'V-D3',
  'V-E1', 'V-E2', 'V-E3', 'V-E4', 'V-E5', 'V-E6', 'V-E7',
  'V-F1', 'V-F2', 'V-F3', 'V-G1', 'V-G2', 'V-G3',
  'V-H1', 'V-H2', 'V-H3'
];
const missing = V_IDS.filter(function (x) { return SECTION_IDS.indexOf(x) < 0; });
eq('V-A1 ~ V-H3 共 27 条验收项全部有断言映射', missing.length, 0);
if (missing.length) console.log('  未覆盖：' + missing.join(', '));

/* =========================================================
 * 第二部分：12 个子套件 spawnSync 回归 + 汇总表
 * ========================================================= */
const SUITES = [
  'qa-750', 'smoke-analysis', 'smoke-db', 'smoke-v2-students-classes',
  'smoke-perm', 'smoke-locator', 'smoke-v2-customer-task', 'smoke-v2-contracts',
  'qa-v3-core', 'qa-v3-data', 'qa-v3-classes', 'qa-v3-ui'
];

/** 解析末行 PASS/FAIL 数，兼容 4 种既有汇总行格式 */
function parseCounts(out) {
  const lines = String(out || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = lines[i];
    let m;
    if ((m = L.match(/PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/i))) return { pass: +m[1], fail: +m[2], line: L.trim() };
    if ((m = L.match(/(\d+)\s+PASS\s*\/\s*(\d+)\s+FAIL/i))) return { pass: +m[1], fail: +m[2], line: L.trim() };
    if ((m = L.match(/(\d+)\s+passed\s*,\s*(\d+)\s+failed/i))) return { pass: +m[1], fail: +m[2], line: L.trim() };
  }
  return null;
}

section('子套件回归（child_process.spawnSync）');
const rows = [];
let suiteTotalPass = 0;
let suiteFailCount = 0;
SUITES.forEach(function (name) {
  const file = path.join(TOOLS, name + '.js');
  if (!fs.existsSync(file)) {
    /* team-lead 裁决：qa-v3-ui.js 不存在则跳过标注，不判失败 */
    if (name === 'qa-v3-ui') {
      rows.push({ name: name, rc: '-', pass: '-', fail: '-', status: 'SKIP（文件不存在，按裁决不判失败）' });
      console.log('  SKIP  ' + name + '（文件不存在）');
    } else {
      rows.push({ name: name, rc: '-', pass: '-', fail: '-', status: 'MISSING' });
      suiteFailCount++;
      ok('子套件 ' + name + ' 文件存在', false, '缺少 ' + file);
    }
    return;
  }
  const r = cp.spawnSync(process.execPath, [file], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000
  });
  const rc = (r.error || r.status === null) ? -1 : r.status;
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  const c = parseCounts(out);
  const p = c ? c.pass : 0;
  const f = c ? c.fail : 0;
  if (c) suiteTotalPass += p;
  const good = rc === 0 && f === 0 && c !== null && p > 0;
  if (!good) suiteFailCount++;
  rows.push({ name: name, rc: rc, pass: p, fail: f, status: good ? 'OK' : 'FAIL' });
  ok('子套件 ' + name + ' rc=0 / FAIL=0 / PASS>0', good,
    'rc=' + rc + ' PASS=' + p + ' FAIL=' + f + (c ? '' : '（未解析到汇总行）'));
});

/* 汇总表 */
console.log('\n------------------------ 子套件汇总表 ------------------------');
console.log(pad('子套件', 34) + pad('rc', 6) + pad('PASS', 8) + pad('FAIL', 8) + '状态');
console.log('----------------------------------------------------------------------');
function pad(s, n) { s = String(s); return s + new Array(Math.max(1, n - s.length)).join(' '); }
rows.forEach(function (r) {
  console.log(pad(r.name, 34) + pad(r.rc, 6) + pad(r.pass, 8) + pad(r.fail, 8) + r.status);
});
console.log('----------------------------------------------------------------------');
console.log('子套件合计：' + rows.length + ' 个 / 跳过 ' +
  rows.filter(function (r) { return r.status.indexOf('SKIP') === 0; }).length +
  ' / 失败 ' + suiteFailCount + ' / 子套件 PASS 合计 ' + suiteTotalPass);
eq('12 个子套件全部 rc=0 且 FAIL=0（SKIP 除外）', suiteFailCount, 0);

/* =========================================================
 * 汇总
 * ========================================================= */
console.log('\n============================');
console.log('=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===');
console.log('============================');
if (FAILS.length) {
  console.log('\n失败明细：');
  FAILS.forEach(function (f) { console.log('  - ' + f); });
}
console.log('');
/* 任一子套件 rc≠0 / FAIL>0，或任一断言失败 → 非零退出 */
process.exit(fail || suiteFailCount ? 1 : 0);
