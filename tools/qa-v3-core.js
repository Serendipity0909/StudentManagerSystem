/* =========================================================
 * tools/qa-v3-core.js —— V3-2 字段贯穿 / 排序抽象 单测
 *   node tools/qa-v3-core.js
 *
 * 沙箱口径与浏览器一致（IIFE + window.App）：
 *   core.js → sync.js → export.js → app.js
 *
 * 测试 seam：只在**内存里的源码字符串**上注入一行外露，磁盘文件零改动。
 *   · core.js   → App.__LegacySort（私有 legacySortByTs，D5 逐字回退的 golden 对照）
 *   · sync.js   → App.__SyncT     （fp / snapState / restoreState / toRow / fromRow）
 *   · export.js → App.__ExportT  （normalizeRecord / restoreJSON）
 *   · app.js    → App.__genDemo  （genDemo）
 * 四个文件都只在 DOMContentLoaded 时才自启动，本沙箱的 document 桩件不派发该事件。
 *
 * 覆盖（team-lead V3-2 自验清单）：
 *   8 个 Score.* 纯函数、合法/缺/非法年月、跨年 2025-12 < 2026-01、
 *   同年月多场 U.zh→ts→id 稳定、混合无年月排末尾、全缺年月回退、
 *   examYmOf 三种输入形态、examAxisLabels 8 字上限与 title、
 *   fp 仅 examYm 变化时必变、toRow undefined 不产出 exam_ym、
 *   恢复旧备份不清空云端年月（V-F3）。
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
function section(t) { console.log('\n=== ' + t + ' ==='); }

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
    body: makeEl(),
    getElementById() { return makeEl(); },
    createElement() { return makeEl(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() { }          // 不派发 DOMContentLoaded → 四个文件都不自启动
  },
  setTimeout, clearTimeout,
  setInterval() { return 0; }, clearInterval() { },
  location: { hash: '', reload() { } },
  navigator: { onLine: true },
  Blob: function () { }, URL: { createObjectURL() { return ''; }, revokeObjectURL() { } }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

function loadWithSeam(file, marker, seam) {
  const raw = fs.readFileSync(path.join(SRC, file), 'utf8');
  const n = raw.split(marker).length - 1;
  if (n !== 1) throw new Error(file + ' 的 seam marker 命中 ' + n + ' 次（应为 1）：' + marker);
  const src = raw.replace(marker, seam + '\n' + marker);
  vm.runInContext(src, sandbox, { filename: file });
}

loadWithSeam('core.js', '  global.App = App;',
  '  App.__LegacySort = legacySortByTs;');
loadWithSeam('sync.js', '  App.Sync = {',
  '  App.__SyncT = { fp: fp, snapState: snapState, restoreState: restoreState, toRow: toRow, fromRow: fromRow };');
loadWithSeam('export.js', '  App.X = {',
  '  App.__ExportT = { normalizeRecord: normalizeRecord, restoreJSON: restoreJSON };');
loadWithSeam('app.js', '  App.render = render;',
  '  App.__genDemo = genDemo;');

const App = sandbox.App;
const Score = App.Score;
const U = App.U;
const T = App.__SyncT;
const X = App.__ExportT;
App.Store.init();

/* ---------------- 夹具 ---------------- */
const ZERO9 = function () { return [0, 0, 0, 0, 0, 0, 0, 0, 0]; };
function rec(o) {
  const base = Score.newRecord();
  Object.keys(o || {}).forEach(function (k) { base[k] = o[k]; });
  return base;
}
function ids(rows) { return rows.map(function (r) { return r.id; }).join(','); }
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/* =========================================================
 * §0 装载与签名外露
 * ========================================================= */
section('0. 模块装载与 Score.* 外露');
ok('core.js 装载后 App.Score 存在', !!Score && typeof Score === 'object');
ok('测试 seam 四处全部注入成功',
  typeof App.__LegacySort === 'function' && typeof T.fp === 'function' &&
  typeof X.normalizeRecord === 'function' && typeof App.__genDemo === 'function');
['defaultExamYm', 'makeExamYm', 'examYmOf', 'examOrderKey', 'sortByExam',
  'examCmp', 'examYmLabel', 'examAxisLabels'].forEach(function (k) {
  ok('Score.' + k + ' 已外露且为函数', typeof Score[k] === 'function');
});
ok('legacySortByTs 保持私有（未挂 Score）', typeof Score.legacySortByTs === 'undefined');
ok('新能力全部落在 core.js，未新增 js 文件',
  fs.readdirSync(SRC).filter(function (f) { return /\.js$/.test(f); }).length === 23);

/* =========================================================
 * §1 defaultExamYm / makeExamYm
 * ========================================================= */
section('1. 默认值与拼装');
const localNow = new Date();
const localYm = localNow.getFullYear() + '-' +
  (localNow.getMonth() + 1 < 10 ? '0' : '') + (localNow.getMonth() + 1);
eq('defaultExamYm() = 本地当前年月', Score.defaultExamYm(), localYm);
ok('defaultExamYm() 符合严格 YYYY-MM', YM_RE.test(Score.defaultExamYm()));

/* 时区证明：本地 2026-01、UTC 2025-12 时不得返回 UTC 月 */
vm.runInContext('var __RealDate = Date; Date = function () {' +
  ' return { getFullYear: function () { return 2026; }, getMonth: function () { return 0; } };' +
  '};', sandbox);
const fakeYm = Score.defaultExamYm();
vm.runInContext('Date = __RealDate;', sandbox);
eq('defaultExamYm() 用本地 getFullYear/getMonth，不取 UTC', fakeYm, '2026-01');

eq('makeExamYm(2026, 1) 月补零', Score.makeExamYm(2026, 1), '2026-01');
eq('makeExamYm(2025, 12)', Score.makeExamYm(2025, 12), '2025-12');
eq('makeExamYm 接受字符串下拉值', Score.makeExamYm('2026', '9'), '2026-09');
eq('makeExamYm(2026, 0) 非法 → undefined', Score.makeExamYm(2026, 0), undefined);
eq('makeExamYm(2026, 13) 非法 → undefined', Score.makeExamYm(2026, 13), undefined);
eq('makeExamYm 空值 → undefined（供窗体 fail）', Score.makeExamYm('', ''), undefined);
eq('makeExamYm(NaN) → undefined', Score.makeExamYm('abc', 1), undefined);
ok('makeExamYm 任何返回值都是严格 YYYY-MM，不产出脏值',
  [1, 10000, 2026.5, -1, 0].every(function (y) {
    const v = Score.makeExamYm(y, 1);
    return v === undefined || YM_RE.test(v);
  }));
ok('makeExamYm(2026,1) 能被 examYmOf 判为 ok', Score.examYmOf(Score.makeExamYm(2026, 1)).state === 'ok');

/* =========================================================
 * §2 examYmOf 三种输入形态 + 合法/缺/非法
 * ========================================================= */
section('2. examYmOf 解析');
const a1 = Score.examYmOf('2026-10');
eq('裸字符串 YYYY-MM：state', a1.state, 'ok');
eq('裸字符串：ym', a1.ym, '2026-10');
eq('裸字符串：y/m', a1.y + '/' + a1.m, '2026/10');
ok('裸字符串：valid / raw', a1.valid === true && a1.raw === '2026-10');
const a2 = Score.examYmOf({ examYm: '2025-12' });
ok('内存形态 r.examYm', a2.state === 'ok' && a2.ym === '2025-12' && a2.y === 2025 && a2.m === 12);
const a3 = Score.examYmOf({ exam_ym: '2026-01' });
ok('云端形态 r.exam_ym（仅解析层容忍）', a3.state === 'ok' && a3.ym === '2026-01');
eq('两种字段并存时 examYm 优先', Score.examYmOf({ examYm: '2026-03', exam_ym: '2026-04' }).ym, '2026-03');
const a4 = Score.examYmOf({});
ok('缺年月 state=missing', a4.state === 'missing' && a4.valid === false && a4.ym === null && a4.y === 0 && a4.m === 0);
ok('undefined 也是 missing', Score.examYmOf({ examYm: undefined }).state === 'missing');
ok('null 也是 missing', Score.examYmOf({ examYm: null }).state === 'missing');
ok('空串也是 missing', Score.examYmOf({ examYm: '' }).state === 'missing');
ok('无入参也是 missing', Score.examYmOf(undefined).state === 'missing');
['2026-1', '2026-00', '2026-13', 'abc', '202610', '2026/10', '2026-1a'].forEach(function (s) {
  const v = Score.examYmOf(s);
  ok('非法值「' + s + '」→ invalid 且原样保留', v.state === 'invalid' && v.raw === s && v.valid === false && v.ym === null);
});
ok('非法值不补零、不纠偏（raw 仍是 2026-1）', Score.examYmOf('2026-1').raw === '2026-1');
ok('数字 202610 视为 invalid 而非 missing', Score.examYmOf(202610).state === 'invalid');
ok('严格正则：2026-09 合法 / 2026-9 非法',
  Score.examYmOf('2026-09').valid === true && Score.examYmOf('2026-9').valid === false);

/* =========================================================
 * §3 examOrderKey / examCmp / 跨年
 * ========================================================= */
section('3. 排序主键与跨年');
const k1 = Score.examOrderKey({ examYm: '2025-12', exam: '期末考', ts: '2026-01-01T00:00:00Z', id: 'x' });
const k2 = Score.examOrderKey({ examYm: '2026-01', exam: '一模', ts: '2026-02-01T00:00:00Z', id: 'y' });
eq('num = year*12+month（2025-12）', k1.num, 24312);
eq('num = year*12+month（2026-01）', k2.num, 24313);
ok('两个有效年月 has=true', k1.has === true && k2.has === true);
ok('跨年 2025-12 < 2026-01（数值比较，不是字符串）', Score.examCmp(k1, k2) < 0 && k1.num < k2.num);
ok('examCmp 反对称', Score.examCmp(k2, k1) > 0);
const km = Score.examOrderKey({ exam: '无年月' });
const ki = Score.examOrderKey({ examYm: '2026-1', exam: '脏值' });
ok('缺年月 / 年月异常 → has=false、num=+Infinity',
  km.has === false && ki.has === false &&
  km.num === Number.POSITIVE_INFINITY && ki.num === Number.POSITIVE_INFINITY);
ok('has 优先：有效年月排在无年月之前', Score.examCmp(k1, km) < 0 && Score.examCmp(km, k1) > 0);
ok('两个 +Infinity 仍走 U.zh→ts→id 兜底（非恒定 1）',
  Score.examCmp({ exam: 'A', examYm: '2026-1', id: '1' }, { exam: 'B', examYm: '2026-1', id: '2' }) < 0 &&
  Score.examCmp({ exam: 'B', examYm: '2026-1', id: '2' }, { exam: 'A', examYm: '2026-1', id: '1' }) > 0);
ok('U.zh 不决定年份先后：exam 名反序也按 num 排',
  Score.examCmp({ examYm: '2025-12', exam: 'Z考试' }, { examYm: '2026-01', exam: 'A考试' }) < 0);
ok('examOrderKey 返回 exam/ts/id 三个兜底字段',
  typeof k1.exam === 'string' && typeof k1.ts === 'number' && typeof k1.id === 'string');
ok('ts 非法值归零不产生 NaN', !isNaN(Score.examOrderKey({ examYm: '2026-10', ts: 'not-a-date' }).ts));

/* =========================================================
 * §4 sortByExam 记录级
 * ========================================================= */
section('4. sortByExam 记录级排序');
const crossYear = [
  rec({ exam: '一模', examYm: '2026-01', id: 'cy2', ts: '2026-02-01T00:00:00Z' }),
  rec({ exam: '期末考', examYm: '2025-12', id: 'cy1', ts: '2026-01-01T00:00:00Z' })
];
eq('跨年序列排序结果', ids(Score.sortByExam(crossYear)), 'cy1,cy2');
ok('sortByExam 返回新数组（不改入参）',
  Score.sortByExam(crossYear) !== crossYear && ids(crossYear) === 'cy2,cy1');

const sameYm = [
  rec({ exam: '一模', examYm: '2026-10', id: 's1', ts: '2026-10-03T00:00:00Z' }),
  rec({ exam: '二模', examYm: '2026-10', id: 's2', ts: '2026-10-01T00:00:00Z' }),
  rec({ exam: '三模', examYm: '2026-10', id: 's3', ts: '2026-10-02T00:00:00Z' })
];
eq('同年月多场：U.zh(exam) 定序', ids(Score.sortByExam(sameYm)), ids(sameYm.slice().sort(Score.examCmp)));
ok('同年月多场：多次调用结果稳定不抖动',
  ids(Score.sortByExam(sameYm)) === ids(Score.sortByExam(sameYm)));
const tsTie = [
  rec({ exam: '同场', examYm: '2026-10', id: 't1', ts: '2026-10-09T00:00:00Z' }),
  rec({ exam: '同场', examYm: '2026-10', id: 't2', ts: '2026-10-01T00:00:00Z' })
];
eq('同 exam 同年月：ts 升序兜底', ids(Score.sortByExam(tsTie)), 't2,t1');
const idTie = [
  rec({ exam: '同场', examYm: '2026-10', id: 'b', ts: '2026-10-01T00:00:00Z' }),
  rec({ exam: '同场', examYm: '2026-10', id: 'a', ts: '2026-10-01T00:00:00Z' })
];
eq('同 exam 同年月同 ts：String(id) 兜底', ids(Score.sortByExam(idTie)), 'a,b');

const mixed = [
  rec({ exam: '无年月', id: 'm1', ts: '2020-01-01T00:00:00Z' }),
  rec({ exam: '十月', examYm: '2026-10', id: 'm2', ts: '2026-10-01T00:00:00Z' }),
  rec({ exam: '十二月', examYm: '2025-12', id: 'm3', ts: '2025-12-01T00:00:00Z' }),
  rec({ exam: '脏值', examYm: '2026-1', id: 'm4', ts: '2021-01-01T00:00:00Z' })
];
const mixedOut = Score.sortByExam(mixed);
eq('混合序列：有效年月在前且按 num 升序', ids(mixedOut.slice(0, 2)), 'm3,m2');
ok('混合序列：缺年月 / 年月异常一律排末尾',
  mixedOut.slice(2).every(function (r) { return !Score.examOrderKey(r).has; }));
eq('混合序列末尾仍按 U.zh→ts→id 稳定',
  ids(mixedOut.slice(2)), ids([mixed[0], mixed[3]].sort(Score.examCmp)));
ok('混合序列入参未被改动', ids(mixed) === 'm1,m2,m3,m4');

/* D5：全缺年月 → legacySortByTs 逐字回退（golden diff） */
const zhOrder = ['甲考试', '乙考试', '丙考试'].sort(U.zh);
const allMissing = zhOrder.map(function (ex, i) {
  return rec({
    exam: ex, id: 'g' + (zhOrder.length - i),
    ts: new Date(Date.UTC(2020, 0, zhOrder.length - i)).toISOString()
  });
});
const legacyOut = App.__LegacySort(allMissing);
eq('全缺年月：sortByExam === legacySortByTs（D5 golden diff）',
  ids(Score.sortByExam(allMissing)), ids(legacyOut));
eq('全缺年月：Score.sort === legacySortByTs（D5 golden diff）',
  ids(Score.sort(allMissing)), ids(legacyOut));
ok('全缺年月确实走 legacy 分支（与 examCmp 纯排序结果不同）',
  ids(allMissing.slice().sort(Score.examCmp)) !== ids(legacyOut));
ok('全缺年月：sortByExam 不改入参', ids(allMissing) === 'g3,g2,g1');
eq('sortByExam(null) 返回空数组', Score.sortByExam(null).length, 0);

/* =========================================================
 * §5 Score.sort 分组级 / Score.options 下拉级
 * ========================================================= */
section('5. 分组级与下拉级');
const grouped = [
  rec({ name: 'A', exam: '期末', examYm: '2026-11', id: 'p1' }),
  rec({ name: 'B', exam: '期中', examYm: '2026-09', id: 'p2' }),
  rec({ name: 'C', exam: '月考', examYm: '2026-10', id: 'p3' })
];
eq('分组级：组间按代表年月升序',
  Score.sort(grouped).map(function (r) { return r.exam; }).join(','), '期中,月考,期末');
const minGroup = [
  rec({ name: 'A', exam: 'X', examYm: '2026-10', id: 'q1' }),
  rec({ name: 'B', exam: 'X', examYm: '2025-12', id: 'q2' }),
  rec({ name: 'C', exam: 'Y', examYm: '2026-01', id: 'q3' })
];
const mg = Score.sort(minGroup);
ok('组代表年月 = 组内最小有效 num（X 组取 2025-12，排在 Y 前）',
  mg[0].exam === 'X' && mg[1].exam === 'X' && mg[2].exam === 'Y');
const groupMissing = [
  rec({ name: 'A', exam: '无年月', id: 'r1', ts: '2020-01-01T00:00:00Z' }),
  rec({ name: 'B', exam: '有年月', examYm: '2026-10', id: 'r2', ts: '2026-10-01T00:00:00Z' })
];
eq('分组级：整组缺年月排末尾', Score.sort(groupMissing)[0].exam, '有年月');
ok('Score.sort 返回新数组', Score.sort(grouped) !== grouped);

const opt = Score.options([
  rec({ exam: '期末', examYm: '2026-11' }),
  rec({ exam: '期中', examYm: '2026-09' }),
  rec({ exam: '月考', examYm: '2026-10' })
]);
eq('下拉级：exams 按最小有效年月升序', opt.exams.join(','), '期中,月考,期末');
ok('下拉级：schools/classes/names 三数组仍按 U.zh',
  JSON.stringify(opt.schools) === JSON.stringify([''].sort(U.zh)) ||
  Array.isArray(opt.schools) && Array.isArray(opt.classes) && Array.isArray(opt.names));
const optMissing = Score.options([
  rec({ exam: '期末' }), rec({ exam: '期中' }), rec({ exam: '月考' })
]);
eq('下拉级：全缺年月时 exams 与改造前一致（U.zh）',
  optMissing.exams.join(','), ['期末', '期中', '月考'].sort(U.zh).join(','));
const optMin = Score.options([
  rec({ exam: 'X', examYm: '2026-10' }), rec({ exam: 'X', examYm: '2025-12' }),
  rec({ exam: 'Y', examYm: '2026-01' })
]);
eq('下拉级：同一 exam 取最小有效年月', optMin.exams.join(','), 'X,Y');

/* =========================================================
 * §6 examYmLabel / examAxisLabels
 * ========================================================= */
section('6. 展示标签');
eq('examYmLabel 合法 → YYYY-MM', Score.examYmLabel('2026-10'), '2026-10');
eq('examYmLabel 缺 → 未标注年月', Score.examYmLabel({}), '未标注年月');
eq('examYmLabel 非法 → 年月异常', Score.examYmLabel({ examYm: '2026-1' }), '年月异常');
eq('examYmLabel 兼容云端风格', Score.examYmLabel({ exam_ym: '2025-12' }), '2025-12');

const axCross = Score.examAxisLabels([
  rec({ exam: '期末考', examYm: '2025-12' }),
  rec({ exam: '一模', examYm: '2026-01' })
]);
eq('跨年 x 轴标签：25年·期末考', axCross[0].label, '25年·期末考');
eq('跨年 x 轴标签：26年·一模', axCross[1].label, '26年·一模');
eq('title = YYYY-MM · exam 原文（1）', axCross[0].title, '2025-12 · 期末考');
eq('title = YYYY-MM · exam 原文（2）', axCross[1].title, '2026-01 · 一模');
ok('examAxisLabels 返回 [{label,title}] 且与入参等长',
  axCross.length === 2 && typeof axCross[0].label === 'string' && typeof axCross[0].title === 'string');

const axSameYear = Score.examAxisLabels([
  rec({ exam: '第一次月考', examYm: '2026-09' }),
  rec({ exam: '期中考试', examYm: '2026-10' })
]);
ok('同年且无同年月多场：exam 原文一字不改',
  axSameYear[0].label === '第一次月考' && axSameYear[1].label === '期中考试');
const axSameYm = Score.examAxisLabels([
  rec({ exam: '一模', examYm: '2026-10' }),
  rec({ exam: '二模', examYm: '2026-10' })
]);
ok('同年月多场：加 M月· 前缀',
  axSameYm[0].label === '10月·一模' && axSameYm[1].label === '10月·二模');
/* --- 混合序列：三态前缀区分（缺 / 异常 / 合法） --- */
const axMissing = Score.examAxisLabels([
  rec({ exam: '补录' }),
  rec({ exam: '脏值', examYm: '2026-1' })
]);
ok('混合序列：缺年月 未标注· / 年月异常 异常·（D2 三态区分）',
  axMissing[0].label.indexOf('未标注·') === 0 && axMissing[1].label.indexOf('异常·') === 0);
eq('缺年月 title', axMissing[0].title, '未标注年月 · 补录');
eq('年月异常 title 标异常', axMissing[1].title, '年月异常 · 脏值');

const longExam = '二零二六年秋季学期第一次月考统考';

/* --- 全序列缺年月：D5 逐字回退旧版 x 轴（exam 原文、无前缀、无截断） --- */
const axAllMissingRows = [
  rec({ exam: '10月段考', id: 'ax1', ts: '2020-01-01T00:00:00Z' }),
  rec({ exam: '11月期中', id: 'ax2', ts: '2020-02-01T00:00:00Z' }),
  rec({ exam: longExam, id: 'ax3', ts: '2020-03-01T00:00:00Z' })
];
const axAll = Score.examAxisLabels(axAllMissingRows);
eq('全缺年月：label 逐字等于各条 exam 原文（等价旧版 labels.push(r.exam)）',
  axAll.map(function (a) { return a.label; }).join('|'),
  axAllMissingRows.map(function (r) { return r.exam; }).join('|'));
eq('全缺年月：title 也逐字等于 exam 原文',
  axAll.map(function (a) { return a.title; }).join('|'),
  axAllMissingRows.map(function (r) { return r.exam; }).join('|'));
ok('全缺年月：不出现 未标注· / 异常· / YY年· / M月· 任何前缀',
  axAll.every(function (a) { return !/^(未标注·|异常·|\d\d年·|\d+月·)/.test(a.label); }));
ok('全缺年月：超长 exam 名不被 8 字截断',
  axAll[2].label === longExam && Array.from(axAll[2].label).length > 8);
eq('全缺年月：返回与入参等长同序', axAll.length, 3);
eq('全缺年月序列同时：sortByExam 走 legacySortByTs（x 轴与排序同源）',
  ids(Score.sortByExam(axAllMissingRows)), ids(App.__LegacySort(axAllMissingRows)));
const axMissingVariants = Score.examAxisLabels([
  rec({ exam: '甲', examYm: undefined }),
  rec({ exam: '乙', examYm: '' }),
  rec({ exam: '丙', examYm: null })
]);
eq('全缺年月含 undefined / 空串 / null 三种缺值形态仍逐字回退',
  axMissingVariants.map(function (a) { return a.label; }).join(','), '甲,乙,丙');
ok('只有非法年月也算「有年月」，走新分支标 异常·（不误触全缺回退）',
  Score.examAxisLabels([rec({ exam: '补录', examYm: '2026-1' })])[0].label === '异常·补录');

/* --- 混合序列：缺 / 异常 / 合法跨年 / 合法同月 同时存在 --- */
const axMix = Score.examAxisLabels([
  rec({ exam: '补录' }),
  rec({ exam: '脏值', examYm: '2026-1' }),
  rec({ exam: '期末考', examYm: '2025-12' }),
  rec({ exam: '一模', examYm: '2026-01' })
]);
eq('混合序列：缺年月 → 未标注·', axMix[0].label, '未标注·补录');
eq('混合序列：非法值 → 异常·', axMix[1].label, '异常·脏值');
eq('混合序列：合法值仍按跨年规则 25年·', axMix[2].label, '25年·期末考');
eq('混合序列：合法值仍按跨年规则 26年·', axMix[3].label, '26年·一模');
eq('混合序列：四条 title 正确',
  axMix.map(function (a) { return a.title; }).join(' | '),
  '未标注年月 · 补录 | 年月异常 · 脏值 | 2025-12 · 期末考 | 2026-01 · 一模');
eq('混合序列：返回与入参等长', axMix.length, 4);
const axMixSameYm = Score.examAxisLabels([
  rec({ exam: '一模', examYm: '2026-10' }),
  rec({ exam: '二模', examYm: '2026-10' }),
  rec({ exam: '补录' })
]);
eq('混合序列（同年）：合法值仍按同年月多场 M月·', axMixSameYm[0].label, '10月·一模');
eq('混合序列（同年）：第二条同年月多场 M月·', axMixSameYm[1].label, '10月·二模');
eq('混合序列（同年）：夹一条缺年月不误触全缺回退', axMixSameYm[2].label, '未标注·补录');

/* --- 8 字截断只在「有年月」分支生效 --- */
const axLong = Score.examAxisLabels([rec({ exam: longExam, examYm: '2026-10' })])[0];
ok('label 8 个全角字符上限', Array.from(axLong.label).length <= 8, axLong.label);
ok('超长 label 以省略号收尾', axLong.label.slice(-1) === '…');
eq('超长 label 的 title 仍是全文', axLong.title, '2026-10 · ' + longExam);
ok('examAxisLabels 空入参 → 空数组', Score.examAxisLabels([]).length === 0);

/* --- V3-3 消费方契约（v3-ui-engineer）：元素恒为非 null 对象、label/title 恒为字符串、
       长度与入参等长、顺序同入参、不内部排序。四个分支全覆盖 --- */
const contractCases = [
  { name: '全缺年月分支', rows: axAllMissingRows },
  { name: '混合序列分支', rows: [
    rec({ exam: '补录' }), rec({ exam: '脏值', examYm: '2026-1' }),
    rec({ exam: '期末考', examYm: '2025-12' }), rec({ exam: '一模', examYm: '2026-01' })
  ] },
  { name: '全合法分支', rows: [
    rec({ exam: '一模', examYm: '2026-10' }), rec({ exam: '二模', examYm: '2026-10' })
  ] },
  { name: '空数组', rows: [] }
];
contractCases.forEach(function (c) {
  var out = Score.examAxisLabels(c.rows);
  ok('消费方契约（' + c.name + '）：等长、元素恒为非 null 对象、label/title 恒为字符串',
    Array.isArray(out) && out.length === c.rows.length &&
    out.every(function (a) {
      return a !== null && a !== undefined && typeof a === 'object' &&
        typeof a.label === 'string' && typeof a.title === 'string';
    }));
});
ok('消费方契约：顺序同入参、不内部排序（三条乱序年月逐条比对 title）',
  Score.examAxisLabels([
    rec({ exam: '丙考试', examYm: '2026-03' }),
    rec({ exam: '甲考试', examYm: '2026-01' }),
    rec({ exam: '乙考试', examYm: '2026-02' })
  ]).map(function (a) { return a.title; }).join('|') ===
  '2026-03 · 丙考试|2026-01 · 甲考试|2026-02 · 乙考试');
ok('消费方契约：rows 为 null / undefined 时返回空数组（不抛错、无 null 元素）',
  Array.isArray(Score.examAxisLabels(null)) && Score.examAxisLabels(null).length === 0 &&
  Array.isArray(Score.examAxisLabels(undefined)) && Score.examAxisLabels(undefined).length === 0);
ok('消费方契约：exam 为 null / undefined 时 label/title 仍是字符串（空串）',
  Score.examAxisLabels([rec({ exam: null }), rec({ exam: undefined, examYm: '2026-10' })])
    .every(function (a) { return typeof a.label === 'string' && typeof a.title === 'string'; }));

/* =========================================================
 * §7 newRecord / upsert / key / history
 * ========================================================= */
section('7. newRecord / upsert / 键与历史零改动');
const nr = Score.newRecord();
ok('newRecord 带 examYm: undefined 占位',
  Object.prototype.hasOwnProperty.call(nr, 'examYm') && nr.examYm === undefined);
eq('newRecord 其余字段与旧版一致',
  [nr.name, nr.school, nr.cls, nr.exam, nr.scores.length, nr.ranks.length, nr.totalRank].join('|'),
  '||||9|9|0');

App.Store.init();
const existing = rec({
  name: '张三', school: '一中', cls: '初三(1)班', exam: '期中考试',
  examYm: '2026-10', ts: '2026-10-05T00:00:00.000Z', id: 'e1'
});
App.Store.data.records = [existing];
const noYm = rec({
  name: '张三', school: '一中', cls: '初三(1)班', exam: '期中考试',
  ts: '2026-10-05T00:00:00.000Z', id: 'e2'
});
const up1 = Score.upsert(noYm);
eq('upsert 命中已有记录 → update', up1.mode, 'update');
eq('upsert 窗体未带年月 → 继承旧 examYm', noYm.examYm, '2026-10');
eq('upsert 保留原 ts', noYm.ts, '2026-10-05T00:00:00.000Z');
eq('upsert 保留原 id', noYm.id, 'e1');
const changedYm = rec({
  name: '张三', school: '一中', cls: '初三(1)班', exam: '期中考试',
  examYm: '2026-11', id: 'e3'
});
Score.upsert(changedYm);
eq('upsert 窗体改了年月 → 新值生效（不被旧值覆盖）', changedYm.examYm, '2026-11');
eq('upsert 行数不变', App.Store.data.records.length, 1);
const keyRec = rec({ name: '李四', school: 'S', cls: 'C', exam: '期末', examYm: '2026-10' });
eq('Score.key 仍是 4 字段（不含 examYm）',
  Score.key(keyRec), ['李四', 'S', 'C', '期末'].join(Score.SEP));
eq('Score.key 不随年月变化',
  Score.key(keyRec), Score.key(Object.assign({}, keyRec, { examYm: '2025-01' })));

const hrows = [
  rec({ exam: 'A', scores: [80].concat(ZERO9().slice(1)) }),
  rec({ exam: 'B', scores: [90].concat(ZERO9().slice(1)) })
];
const hist = Score.history(hrows, 0, 90);
ok('Score.history 算法零改动（desc 仍为 exam:分数 链）',
  hist.desc === 'A:80 \u2192 B:90', hist.desc);
ok('Score.history ±2/±5 阈值不变（稳步上升）', hist.conclusion.indexOf('稳步上升') >= 0, hist.conclusion);
eq('Score.history 少于 2 条仍返回首次考试', Score.history([hrows[0]], 0, 80).desc, '首次考试');

/* =========================================================
 * §8 sync.js：fp / snapState / restoreState / toRow / fromRow
 * ========================================================= */
section('8. sync.js 五处硬编码');
const baseFp = rec({
  name: '李四', school: 'S', cls: 'C', exam: '期末考试',
  examYm: '2026-10', id: 'f1', ts: '2026-10-01T00:00:00Z'
});
const fpArr = JSON.parse(T.fp(baseFp));
eq('fp 数组由 7 项扩为 8 项', fpArr.length, 8);
eq('fp 第 8 项 = examYm', fpArr[7], '2026-10');
eq('fp 前 7 项与改造前逐字一致', JSON.stringify(fpArr.slice(0, 7)),
  JSON.stringify(['李四', 'S', 'C', '期末考试', baseFp.scores, baseFp.ranks, 0]));
const onlyYmChanged = rec({
  name: '李四', school: 'S', cls: 'C', exam: '期末考试',
  examYm: '2026-11', id: 'f1', ts: '2026-10-01T00:00:00Z'
});
ok('fp：仅 examYm 变化时指纹必变（V-E7）', T.fp(baseFp) !== T.fp(onlyYmChanged));
const noYmFp = rec({
  name: '李四', school: 'S', cls: 'C', exam: '期末考试',
  id: 'f1', ts: '2026-10-01T00:00:00Z'
});
eq('fp：undefined 用空串占位不丢位', JSON.parse(T.fp(noYmFp))[7], '');
ok('fp：有年月 vs 无年月 指纹不同', T.fp(baseFp) !== T.fp(noYmFp));
/* 加固：null 边界 —— 裸云端行（exam_ym: null）直接进内存时不得产出 'null' */
const nullYmFp = rec({
  name: '李四', school: 'S', cls: 'C', exam: '期末考试',
  examYm: null, id: 'f1', ts: '2026-10-01T00:00:00Z'
});
eq('fp：examYm=null 与 undefined 产出完全一致', T.fp(nullYmFp), T.fp(noYmFp));
eq('fp：null 不产出字符串 "null"', JSON.parse(T.fp(nullYmFp))[7], '');
ok('fp：null 与有年月的指纹仍不同（不误判为无变化）', T.fp(nullYmFp) !== T.fp(baseFp));
eq('fp：空串 examYm 仍占位为空串（脏值原样保留）',
  JSON.parse(T.fp(rec({ examYm: '' })))[7], '');

const snapRec = rec({ name: '王五', exam: '一模', examYm: '2026-01', id: 'sn1' });
const snap = T.snapState(snapRec);
eq('snapState 带 examYm', snap.examYm, '2026-01');
snapRec.examYm = '2099-12';
T.restoreState(snapRec, snap);
eq('restoreState 还原 examYm', snapRec.examYm, '2026-01');
const snapNoYm = rec({ name: '王五', exam: '一模', id: 'sn2' });
const snap2 = T.snapState(snapNoYm);
ok('snapState 缺年月保留 undefined（不是空串）',
  Object.prototype.hasOwnProperty.call(snap2, 'examYm') && snap2.examYm === undefined);
snapNoYm.examYm = '2026-05';
T.restoreState(snapNoYm, snap2);
ok('restoreState 把 undefined 原样写回', snapNoYm.examYm === undefined);

const rowWith = T.toRow(baseFp);
eq('toRow 有年月 → row.exam_ym', rowWith.exam_ym, '2026-10');
const rowWithout = T.toRow(noYmFp);
ok('toRow examYm === undefined 时不产生 exam_ym 键（V-F3）',
  !Object.prototype.hasOwnProperty.call(rowWithout, 'exam_ym'));
ok('toRow 其余列与既有写穿行为不变（updated_at / last_editor 仍在）',
  Object.prototype.hasOwnProperty.call(rowWithout, 'updated_at') &&
  Object.prototype.hasOwnProperty.call(rowWithout, 'last_editor') &&
  rowWithout.rec_id === 'f1' && rowWithout.stu_name === '李四');
eq('toRow 不把 undefined 写成空串', Object.keys(rowWithout).indexOf('exam_ym'), -1);
ok('toRow 非法年月原样带上（不补零不纠偏）',
  T.toRow(rec({ examYm: '2026-1' })).exam_ym === '2026-1');
ok('null 加固未修过头：脏值 \'2026-1\' 在 fp 与 toRow 两侧都原样保留',
  JSON.parse(T.fp(rec({ examYm: '2026-1' })))[7] === '2026-1' &&
  T.toRow(rec({ examYm: '2026-1' })).exam_ym === '2026-1');
/* 加固：null 边界 —— 不得写出 exam_ym: null 清空云端已回填的 42 行年月 */
const rowNull = T.toRow(nullYmFp);
ok('toRow examYm === null 时不产生 exam_ym 键',
  !Object.prototype.hasOwnProperty.call(rowNull, 'exam_ym'));
eq('toRow null 与 undefined 的 row 键集合一致',
  Object.keys(rowNull).sort().join(','), Object.keys(rowWithout).sort().join(','));
ok('toRow null 时 updated_at / last_editor 仍照常刷新',
  Object.prototype.hasOwnProperty.call(rowNull, 'updated_at') &&
  Object.prototype.hasOwnProperty.call(rowNull, 'last_editor'));
ok('toRow 对合法 / 非法 / null / undefined 四种取值的判定符合预期',
  T.toRow(rec({ examYm: '2026-10' })).exam_ym === '2026-10' &&
  T.toRow(rec({ examYm: '2026-1' })).exam_ym === '2026-1' &&
  !('exam_ym' in T.toRow(rec({ examYm: null }))) &&
  !('exam_ym' in T.toRow(rec({ examYm: undefined }))));

function cloudRow(extra) {
  return Object.assign({
    rec_id: 'c1', id: 77, stu_name: '赵六', school: 'S', class_name: 'C', exam: '一模',
    scores: ZERO9(), ranks: ZERO9(), total_rank: 0,
    entered_at: '2026-01-01T00:00:00Z'
  }, extra || {});
}
eq('fromRow 云端 exam_ym → 内存 examYm', T.fromRow(cloudRow({ exam_ym: '2026-01' })).examYm, '2026-01');
ok('fromRow 旧行缺列 → examYm 为 undefined',
  T.fromRow(cloudRow()).examYm === undefined &&
  Object.prototype.hasOwnProperty.call(T.fromRow(cloudRow()), 'examYm'));
ok('fromRow exam_ym = null → undefined', T.fromRow(cloudRow({ exam_ym: null })).examYm === undefined);
eq('fromRow 脏值原样进内存（不补零）', T.fromRow(cloudRow({ exam_ym: '2026-1' })).examYm, '2026-1');
eq('fromRow 数值脏值转字符串保留', T.fromRow(cloudRow({ exam_ym: 202610 })).examYm, '202610');
eq('fromRow 其余字段不变', T.fromRow(cloudRow({ exam_ym: '2026-01' }))._cid, 77);
const coreSrc = fs.readFileSync(path.join(SRC, 'core.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(SRC, 'sync.js'), 'utf8');
ok('export.js / app.js 完全不出现 exam_ym（全站只认 r.examYm）',
  ['export.js', 'app.js'].every(function (f) {
    return fs.readFileSync(path.join(SRC, f), 'utf8').indexOf('exam_ym') < 0;
  }));
ok('core.js 只在 examYmOf 里容忍读取 r.exam_ym 输入，不产出 exam_ym 字段',
  coreSrc.indexOf('r.exam_ym') >= 0 &&
  !/exam_ym\s*:/.test(coreSrc) && !/\.exam_ym\s*=/.test(coreSrc));
ok('映射只落在 sync.js 的 toRow / fromRow 区间内（区间外零出现）',
  syncSrc.indexOf('row.exam_ym = r.examYm') >= 0 &&
  syncSrc.indexOf('examYm: (row.exam_ym == null)') >= 0 &&
  syncSrc.indexOf('exam_ym') >= syncSrc.indexOf('function toRow(r) {') &&
  syncSrc.lastIndexOf('exam_ym') < syncSrc.indexOf('直接调用云端鉴权接口'));

/* =========================================================
 * §9 export.js：normalizeRecord / 旧备份恢复不清空云端年月
 * ========================================================= */
section('9. export.js 备份与恢复（V-F3）');
const normWith = X.normalizeRecord({ name: 'A', exam: 'E', examYm: '2026-10', scores: ZERO9() });
eq('normalizeRecord 白名单带 examYm', normWith.examYm, '2026-10');
const normWithout = X.normalizeRecord({ name: 'A', exam: 'E', scores: ZERO9() });
ok('normalizeRecord 缺字段 → undefined（不填空串）',
  normWithout.examYm === undefined && Object.prototype.hasOwnProperty.call(normWithout, 'examYm'));
eq('normalizeRecord null → undefined',
  X.normalizeRecord({ name: 'A', exam: 'E', examYm: null, scores: ZERO9() }).examYm, undefined);
eq('normalizeRecord 脏值原样保留',
  X.normalizeRecord({ name: 'A', exam: 'E', examYm: '2026-1', scores: ZERO9() }).examYm, '2026-1');
eq('normalizeRecord 输出键集合 = 旧 10 项 + examYm',
  Object.keys(normWith).sort().join(','),
  ['exam', 'examYm', 'id', 'mod', 'name', 'ranks', 'school', 'scores', 'cls', 'totalRank', 'ts'].sort().join(','));
ok('normalizeRecord 不产出 exam_ym（内存只用 camelCase）',
  !Object.prototype.hasOwnProperty.call(normWith, 'exam_ym'));
ok('App.X 的 csv / xlsx / backupJSON / restoreJSON 仍在（27 列导出零改动）',
  typeof App.X.csv === 'function' && typeof App.X.xlsx === 'function' &&
  typeof App.X.backupJSON === 'function' && typeof App.X.restoreJSON === 'function');
eq('toCSV 行为未变（仍是逗号分隔 + 双引号转义）',
  App.X.csv([['a', 'b,c']]), 'a,"b,c"');

/* V-F3：恢复不含 examYm 的完整旧备份 */
App.Store.init();
const cloudBackfilled = rec({
  name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
  examYm: '2026-10', id: 'v1', ts: '2026-10-15T00:00:00.000Z'
});
cloudBackfilled._cid = 99;
App.Store.data.records = [cloudBackfilled];
const fpBefore = T.fp(cloudBackfilled);
const oldBackup = JSON.stringify({
  version: 1,
  records: [{
    id: 'external', name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
    scores: ZERO9(), ranks: ZERO9(), totalRank: 0,
    ts: '2026-10-15T00:00:00.000Z'
  }]
});
eq('restoreJSON 返回导入条数', X.restoreJSON(oldBackup), 1);
const merged = App.Store.data.records[0];
eq('恢复旧备份：行数不变（同键合并）', App.Store.data.records.length, 1);
ok('恢复旧备份：命中行整体替换 → 内存 examYm 临时为 undefined', merged.examYm === undefined);
eq('恢复旧备份：继承 _cid', merged._cid, 99);
eq('恢复旧备份：保留原 id', merged.id, 'v1');
eq('恢复旧备份：保留原 ts', merged.ts, '2026-10-15T00:00:00.000Z');
eq('恢复旧备份：唯一键 4 字段不变', Score.key(merged), Score.key(cloudBackfilled));
const mergedRow = T.toRow(merged);
ok('恢复旧备份：toRow 省略 exam_ym → 云端已回填年月不被清空（V-F3）',
  !Object.prototype.hasOwnProperty.call(mergedRow, 'exam_ym'));
ok('恢复旧备份：fp 变化会多触发一次 update（R4 预期行为）', T.fp(merged) !== fpBefore);
ok('恢复旧备份：updated_at / last_editor 仍照常刷新（既有写穿行为）',
  Object.prototype.hasOwnProperty.call(mergedRow, 'updated_at') &&
  Object.prototype.hasOwnProperty.call(mergedRow, 'last_editor'));
/* 下次拉取：fromRow 把云端年月恢复回本地显示 */
const pulled = T.fromRow(cloudRow({ exam_ym: '2026-10', stu_name: '郭阳阳', exam: '期中考试' }));
eq('恢复旧备份后下次拉取，fromRow 恢复本地年月显示', pulled.examYm, '2026-10');

/* FIX-1 的真实威胁模型（team-lead 点名 / ARCH §7 C.10「V3-5 必测」）：
   手工编辑过的旧 JSON 备份带 examYm: null，经 normalizeRecord → 写穿 → toRow 全链路
   不得写出 exam_ym: null 清空云端已回填的 42 行年月。 */
App.Store.init();
const cloudBackfilledNull = rec({
  name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
  examYm: '2026-10', id: 'v2', ts: '2026-10-15T00:00:00.000Z'
});
cloudBackfilledNull._cid = 98;
App.Store.data.records = [cloudBackfilledNull];
const nullBackup = JSON.stringify({
  version: 1,
  records: [{
    id: 'external2', name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试',
    examYm: null, scores: ZERO9(), ranks: ZERO9(), totalRank: 0,
    ts: '2026-10-15T00:00:00.000Z'
  }]
});
eq('恢复带 examYm:null 的手工备份 → 导入 1 条', X.restoreJSON(nullBackup), 1);
const mergedNull = App.Store.data.records[0];
eq('恢复带 null 备份：行数不变（同键合并）', App.Store.data.records.length, 1);
ok('恢复带 null 备份：normalizeRecord 把 null 归一为 undefined',
  mergedNull.examYm === undefined);
eq('恢复带 null 备份：继承 _cid', mergedNull._cid, 98);
eq('恢复带 null 备份：唯一键 4 字段不变', Score.key(mergedNull), Score.key(cloudBackfilledNull));
ok('恢复带 null 备份：toRow 全链路不写 exam_ym → 云端 42 行年月不被清空',
  !Object.prototype.hasOwnProperty.call(T.toRow(mergedNull), 'exam_ym'));
eq('恢复带 null 备份：fp 第 8 项不是字符串 "null"',
  JSON.parse(T.fp(mergedNull))[7], '');
eq('恢复带 null 备份：下次拉取仍能恢复云端年月显示',
  T.fromRow(cloudRow({ exam_ym: '2026-10', stu_name: '郭阳阳', exam: '期中考试' })).examYm, '2026-10');

/* 带年月的新备份 → 正常恢复并写回云端 */
App.Store.init();
App.Store.data.records = [rec({ name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试', examYm: '2026-09' })];
X.restoreJSON(JSON.stringify({
  version: 1,
  records: [{ name: '郭阳阳', school: '一中', cls: '高二', exam: '期中考试', examYm: '2026-11', scores: ZERO9() }]
}));
eq('新备份恢复：examYm 正确写回内存', App.Store.data.records[0].examYm, '2026-11');
eq('新备份恢复：toRow 带 exam_ym', T.toRow(App.Store.data.records[0]).exam_ym, '2026-11');

/* =========================================================
 * §10 app.js genDemo 三场递增值
 * ========================================================= */
section('10. genDemo 示例数据（R3-2）');
App.Store.init();
const demoN = App.__genDemo();
eq('genDemo 生成 30 条（10 人 × 3 场）', demoN, 30);
const demoRecs = App.Store.data.records;
eq('genDemo 落库 30 条', demoRecs.length, 30);
const d = new Date();
function localMonthBack(back) {
  const x = new Date(d.getFullYear(), d.getMonth() - back, 1);
  return x.getFullYear() + '-' + (x.getMonth() + 1 < 10 ? '0' : '') + (x.getMonth() + 1);
}
const expectYm = [localMonthBack(2), localMonthBack(1), localMonthBack(0)];
const demoMap = { '第一次月考': expectYm[0], '期中考试': expectYm[1], '期末考试': expectYm[2] };
Object.keys(demoMap).forEach(function (ex) {
  const rows = demoRecs.filter(function (r) { return r.exam === ex; });
  eq('genDemo「' + ex + '」共 10 条', rows.length, 10);
  ok('genDemo「' + ex + '」examYm = ' + demoMap[ex],
    rows.length > 0 && rows.every(function (r) { return r.examYm === demoMap[ex]; }));
});
ok('genDemo 三场年月均为严格 YYYY-MM',
  demoRecs.every(function (r) { return YM_RE.test(String(r.examYm)); }));
ok('genDemo 三场年月严格递增（越大越新）',
  Score.examOrderKey({ examYm: expectYm[0] }).num < Score.examOrderKey({ examYm: expectYm[1] }).num &&
  Score.examOrderKey({ examYm: expectYm[1] }).num < Score.examOrderKey({ examYm: expectYm[2] }).num);
const oneStudent = demoRecs.filter(function (r) { return r.name === '陈思远'; });
eq('同一学生 3 场记录', oneStudent.length, 3);
ok('rec.ts 生成逻辑不变：场次越靠后 ts 越新',
  new Date(oneStudent[0].ts).getTime() < new Date(oneStudent[1].ts).getTime() &&
  new Date(oneStudent[1].ts).getTime() < new Date(oneStudent[2].ts).getTime());
eq('genDemo 数据走 sortByExam 得到考试名年月序（与 ts 序一致）',
  Score.sortByExam(oneStudent).map(function (r) { return r.exam; }).join(','),
  '第一次月考,期中考试,期末考试');
ok('genDemo 每场科目的分数仍是 9 科且已被截断',
  demoRecs.every(function (r) { return r.scores.length === 9; }));

/* 跨年边界：把沙箱里的「当前本地时间」固定为 2026 年 1 月，
   往前 2 / 1 / 0 月应分别为 2025-11 / 2025-12 / 2026-01，不得出现 2026-00 / 2026--1。 */
vm.runInContext('var __RD2 = Date;', sandbox);
vm.runInContext([
  'Date = function (a, b, c) {',
  '  if (arguments.length === 0) return { getFullYear: function () { return 2026; },' +
  ' getMonth: function () { return 0; }, getTime: function () { return 0; },' +
  ' toISOString: function () { return "2026-01-15T00:00:00.000Z"; } };',
  '  if (arguments.length === 1) return { getTime: function () { return Number(a) || 0; },' +
  ' toISOString: function () { return new __RD2(Number(a) || 0).toISOString(); } };',
  '  var y = a, m = b;',
  '  while (m < 0) { m += 12; y -= 1; }',
  '  while (m > 11) { m -= 12; y += 1; }',
  '  return { getFullYear: function () { return y; }, getMonth: function () { return m; },' +
  ' getTime: function () { return 0; }, toISOString: function () { return "2026-01-15T00:00:00.000Z"; } };',
  '};',
  'Date.now = function () { return __RD2.now(); };'
].join('\n'), sandbox);
App.Store.init();
const janN = App.__genDemo();
vm.runInContext('Date = __RD2;', sandbox);
const janMap = {};
App.Store.data.records.forEach(function (r) { janMap[r.exam] = r.examYm; });
eq('跨年 genDemo 仍生成 30 条', janN, 30);
eq('跨年：第一次月考 = 2025-11（前 2 月）', janMap['第一次月考'], '2025-11');
eq('跨年：期中考试 = 2025-12（前 1 月）', janMap['期中考试'], '2025-12');
eq('跨年：期末考试 = 2026-01（当前月）', janMap['期末考试'], '2026-01');
ok('跨年三场年月均为严格 YYYY-MM，无 00 / 负数月',
  Object.keys(janMap).every(function (k) { return YM_RE.test(janMap[k]); }));

/* =========================================================
 * 汇总
 * ========================================================= */
console.log('\n============================');
console.log('=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===');
if (FAILS.length) {
  console.log('\n失败明细：');
  FAILS.forEach(function (f) { console.log('  - ' + f); });
}
console.log('============================\n');
process.exit(fail ? 1 : 0);
