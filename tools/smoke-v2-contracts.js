/* =========================================================
 * tools/smoke-v2-contracts.js —— 合同确认模块冒烟测试（T9 + T11 口径）
 *   node tools/smoke-v2-contracts.js
 *
 * 沙箱口径与浏览器一致（IIFE + window.App）：
 *   core.js → db.js → perm.js → ui-kit.js → module-contracts.js
 * App.Sync 用假实现；App.DB.cache 直接塞假价目方案 / 假合同（渲染层只读缓存）。
 *
 * 重点：
 *   §3  T9 新计价公式逐条算例
 *         报读费用 = 课时单价 × 各阶段次数 × 该阶段科目数 + 资料费（按阶段分别收取）− 优惠
 *         · Excel 算例 1 科寒春连报 → 5900
 *         · 微信算例 2 科寒春连报 → 11700
 *         · 单阶段单科 1730 / 跨阶段不同科目数 85 折 / 一科目跨阶段合并成一行
 *         · 优惠截断 / 结余封顶 / pct 一次性取整（78699.38）
 *   §4  多方案聚合（T11）：O=ΣO_p、D=ΣD_p、T=ΣT_p、M=ΣM_p、S=T+M，各方案优惠互不影响
 *   §11 明细单口径简化（无「（O）」「S =」「口径：」）、结余行条件渲染、方案备注、旧快照兼容
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

function near(name, actual, expect) {
  ok(name, Math.abs(Number(actual) - expect) < 1e-9, '实际=' + actual + ' 期望=' + expect);
}

/** 统计某串在文本里出现几次（备注去重断言用） */
function countOf(hay, needle) {
  let n = 0, i = 0;
  while (true) {
    const k = hay.indexOf(needle, i);
    if (k < 0) return n;
    n++;
    i = k + needle.length;
  }
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

['core.js', 'db.js', 'perm.js', 'ui-kit.js', 'module-contracts.js'].forEach(function (f) {
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
  on() { }, boot() { }, markAllDeleted() { }
};
const TOASTS = [];
App.Toast = function (msg, type) { TOASTS.push({ msg: String(msg), type: type || '' }); };
App.render = function () { };
/* 捕获弹窗：明细弹窗的 body.innerHTML 就是 detailCardHTML 的输出；
   shell 模拟 .mask > .modal，用来验证「明细弹窗加宽」（T12） */
let LAST_MODAL = null;
let LAST_MODAL_SHELL = null;
App.Modal.open = function (opt) {
  LAST_MODAL = opt;
  const shell = makeEl();
  const mask = makeEl();
  mask.querySelector = function (sel) { return sel === '.modal' ? shell : null; };
  LAST_MODAL_SHELL = shell;
  return mask;
};
App.Modal.confirm = function (msg, onOk) { if (onOk) onOk(); return makeEl(); };

const Core = App.ContractsCore;
const UI = App.UI;

/* =========================================================
 * 测试夹具
 * ========================================================= */
const PLAN_HC = {          // 寒春连报：A 7 次 + B 18 次，各阶段资料费 100，无优惠
  unit_price: 240,
  stages: [{ stage: 'A', sessions: 7, material_fee: 100 }, { stage: 'B', sessions: 18, material_fee: 100 }],
  discount_type: 'none',
  discount_value: 0
};
const PLAN_SPRING = {      // 只报春季：A 7 次
  unit_price: 240,
  stages: [{ stage: 'A', sessions: 7, material_fee: 100 }],
  discount_type: 'none',
  discount_value: 0
};
const PLAN_SUMMER = {      // 暑期班：C 10 次，单科资料费 50，方案自带 85 折
  unit_price: 200,
  stages: [{ stage: 'C', sessions: 10, material_fee: 50 }],
  discount_type: 'pct',
  discount_value: 0.85
};

function calc(over) {
  return Core.priceContract(Object.assign({
    year: 2026, grade: '高二', planName: '寒春连报', plan: PLAN_HC,
    subjects: { A: [], B: [] }, discount: { type: 'none', value: 0 }, balance: 0
  }, over || {}));
}

/** 明细单片段：登记页 render() 里 id="ct-detail" 之后就是明细单本体 */
function detailPart(html) {
  const k = String(html).indexOf('id="ct-detail"');
  return k < 0 ? '' : String(html).slice(k);
}

/* =========================================================
 * 0. 模块注册与命名空间
 * ========================================================= */
console.log('\n=== 0. 模块注册 / 纯函数外露 ===');
const mod = App.modules.filter(function (m) { return m.id === 'contracts'; })[0];
ok('contracts 模块已注册且 adminOnly', !!mod && mod.adminOnly === true);
eq('contracts 的 order', mod && mod.order, 50);
eq('contracts 的 ready', mod && mod.ready, true);
ok('ContractsCore 暴露计价与校验纯函数',
  ['priceContract', 'validatePlan', 'validateContract', 'normalizePlan', 'findPlan',
    'plansFor', 'planSummary', 'planDiscountText', 'planLabel', 'previewPlan',
    'itemsSnapshot', 'snapshotResult', 'discountText', 'dupContract']
    .every(function (k) { return typeof Core[k] === 'function'; }));
ok('T11 新增多方案聚合入口已外露',
  ['priceContractMulti', 'priceEntry', 'entryPlanList', 'mergePlanViews']
    .every(function (k) { return typeof Core[k] === 'function'; }));
ok('T12 合并横表的纯函数已外露',
  ['detailPlanViews', 'detailColumns', 'detailSubjectRows', 'detailDiscountText', 'remarkTipHTML']
    .every(function (k) { return typeof Core[k] === 'function'; }));
ok('明细弹窗宽度 ≥ 1080px', Core.DETAIL_MODAL_WIDTH >= 1080, Core.DETAIL_MODAL_WIDTH);
eq('默认资料费常量 = 100 元/科/阶段', Core.DEFAULT_MATERIAL, 100);
eq('方案备注字数上限 = 200', Core.REMARK_MAX, 200);
ok('旧接口 planStages 仍可用（向后兼容）', typeof Core.planStages === 'function');

/* =========================================================
 * 1. 方案归一 normalizePlan（云端 jsonb → 规范结构）
 * ========================================================= */
console.log('\n=== 1. 方案归一 ===');
const np1 = Core.normalizePlan(PLAN_HC);
eq('归一后阶段数', np1.stages.length, 2);
eq('归一后阶段顺序 A→B', np1.stages.map(function (s) { return s.stage; }).join(''), 'AB');
eq('归一后 A 阶段次数', np1.stages[0].sessions, 7);
eq('归一后课时单价', np1.unit_price, 240);

const npJson = Core.normalizePlan({
  unit_price: '240.00',
  stages: '[{"stage":"B","sessions":"18","material_fee":"100"},{"stage":"A","sessions":"7","material_fee":"100"}]',
  discount_type: 'pct', discount_value: '85'
});
eq('stages 是 JSON 字符串时也能解析', npJson.stages.length, 2);
eq('乱序阶段被排成 A→B', npJson.stages.map(function (s) { return s.stage; }).join(''), 'AB');
near('折扣百分数 85 归一为 0.85', npJson.discount_value, 0.85);
eq('数值字符串被转成数字', typeof npJson.unit_price, 'number');

const npDup = Core.normalizePlan({
  unit_price: 100,
  stages: [{ stage: 'A', sessions: 5 }, { stage: 'A', sessions: 9 }, { stage: 'X', sessions: 3 }]
});
eq('重复阶段只保留第一条、非法阶段被丢弃', npDup.stages.length, 1);
eq('非法阶段被丢弃后剩下 A', npDup.stages[0].stage, 'A');
eq('次数缺失时兜底 1',
  Core.normalizePlan({ unit_price: 1, stages: [{ stage: 'A' }] }).stages[0].sessions, 1);
eq('次数越界被夹到 200',
  Core.normalizePlan({ unit_price: 1, stages: [{ stage: 'A', sessions: 9999 }] }).stages[0].sessions, 200);
eq('资料费负数被夹到 0',
  Core.normalizePlan({ unit_price: 1, stages: [{ stage: 'A', sessions: 1, material_fee: -5 }] }).stages[0].material_fee, 0);
eq('未知优惠类型退化为 none', Core.normalizePlan({ discount_type: 'nope' }).discount_type, 'none');

/* =========================================================
 * 2. 方案摘要 / 优惠文案
 * ========================================================= */
console.log('\n=== 2. 方案摘要与优惠文案 ===');
eq('阶段组合摘要', Core.planSummary(PLAN_HC), 'A 7次 + B 18次');
eq('单阶段摘要', Core.planSummary(PLAN_SPRING), 'A 7次');
eq('无优惠文案', Core.planDiscountText({ discount_type: 'none', discount_value: 0 }), '无优惠');
eq('85 折文案', Core.planDiscountText({ discount_type: 'pct', discount_value: 0.85 }), '85折');
eq('8 折文案', Core.planDiscountText({ discount_type: 'pct', discount_value: 0.8 }), '8折');
eq('88 折文案（自定义折扣）', Core.planDiscountText({ discount_type: 'pct', discount_value: 0.88 }), '88折');
eq('金额减免文案（整数不拖小数）',
  Core.planDiscountText({ discount_type: 'amount', discount_value: 300 }), '减300元');
eq('方案下拉标签格式',
  Core.planLabel({
    plan_name: '寒春连报', unit_price: 240,
    stages: [{ stage: 'A', sessions: 7 }, { stage: 'B', sessions: 18 }],
    discount_type: 'pct', discount_value: 0.85
  }), '寒春连报（A 7次 + B 18次 · 240.00元/科 · 85折）');
eq('折扣文案（明细单用）', Core.discountText({ discountType: 'pct', discountValue: 0.85 }), '85折');
eq('金额优惠文案（明细单用）',
  Core.discountText({ discountType: 'amount', discountValue: 300 }), '减免 300 元');
eq('多方案优惠文案（各方案优惠不同）', Core.discountText({ discountType: 'mixed' }), '多方案优惠');

/* =========================================================
 * 3. 必测算例（逐条命名）
 * ========================================================= */
console.log('\n=== 3. 计价算例（用户口径逐条核对）===');

/* 算例 1 —— Excel */
const r1 = calc({ subjects: { A: ['数学'], B: ['数学'] }, discount: { type: 'amount', value: 300 } });
near('Excel算例 1科寒春连报：O = 240×25×1 = 6000', r1.original, 6000);
near('Excel算例 1科寒春连报：M = 100+100 = 200', r1.materialAmount, 200);
near('Excel算例 1科寒春连报：P = 6000−300+200 = 5900', r1.payable, 5900);
eq('Excel算例 1科寒春连报：科目行只有 1 行（跨阶段合并）', r1.subjectRows.length, 1);
eq('Excel算例 1科寒春连报：该科目总次数 = 25', r1.subjectRows[0].sessionsTotal, 25);

/* 算例 2 —— 微信 */
const r2 = calc({
  subjects: { A: ['数学', '英语'], B: ['数学', '英语'] },
  discount: { type: 'amount', value: 700 }
});
near('微信算例 2科寒春连报：O = 240×25×2 = 12000', r2.original, 12000);
near('微信算例 2科寒春连报：M = 100×2×2 = 400', r2.materialAmount, 400);
near('微信算例 2科寒春连报：P = 12000−700+400 = 11700', r2.payable, 11700);
eq('微信算例：科目行 2 行', r2.subjectRows.length, 2);

/* 算例 3 —— 单阶段单科 */
const r3 = calc({ plan: PLAN_SPRING, subjects: { A: ['数学'] }, discount: { type: 'amount', value: 50 } });
near('单阶段单科：O = 240×7 = 1680', r3.original, 1680);
near('单阶段单科：M = 100', r3.materialAmount, 100);
near('单阶段单科：P = 1680−50+100 = 1730', r3.payable, 1730);
eq('单阶段单科：明细单只有 1 个阶段列', r3.stageList.length, 1);

/* 算例 4 —— 跨阶段不同科目数（公式的自然推广） */
const r4 = calc({
  subjects: { A: ['数学'], B: ['数学', '英语'] },
  discount: { type: 'pct', value: 0.85 }
});
near('跨阶段不同科目数：O = 240×7×1 + 240×18×2 = 10320', r4.original, 10320);
near('跨阶段不同科目数：T = round2(10320×0.85) = 8772', r4.tuition, 8772);
near('跨阶段不同科目数：M = 100×1 + 100×2 = 300', r4.materialAmount, 300);
near('跨阶段不同科目数：D = 10320−8772 = 1548', r4.discountAmount, 1548);
near('跨阶段不同科目数：P = 8772+300 = 9072', r4.payable, 9072);

/* 算例 5 —— 跨阶段同科目合并成一行 */
const r5 = calc({ subjects: { A: ['数学'], B: ['数学'] } });
eq('跨阶段同科目合并成一行（subjectRows = 1）', r5.subjectRows.length, 1);
eq('跨阶段同科目：该行总次数 25', r5.subjectRows[0].sessionsTotal, 25);
near('跨阶段同科目：该行小计 240×25 = 6000', r5.subjectRows[0].amount, 6000);
ok('跨阶段同科目：两阶段都打勾',
  r5.subjectRows[0].stagesHit.A === true && r5.subjectRows[0].stagesHit.B === true);

/* 算例 6 —— 优惠金额 > 课时费 → 截断 */
const r6 = calc({ subjects: { A: ['数学'], B: ['数学'] }, discount: { type: 'amount', value: 99999 } });
near('优惠金额 > 课时费：折后课时费截断为 0', r6.tuition, 0);
near('优惠金额 > 课时费：优惠金额 = 原价（不出现负课时费）', r6.discountAmount, 6000);
near('优惠金额 > 课时费：应付只剩资料费 200', r6.payable, 200);

/* 算例 7 —— 结余 > 应付 → 应付 0，剩余保留 */
const r7 = calc({ subjects: { A: ['数学'], B: ['数学'] }, balance: 20000 });
near('结余 > 应付：应付为 0', r7.payable, 0);
near('结余 > 应付：抵扣封顶为小计 6200', r7.deduction, 6200);
near('结余 > 应付：剩余结余 13800', r7.balanceLeft, 13800);

/* 算例 8 —— 方案优惠默认带入（discount 未传） */
const r8 = calc({
  plan: {
    unit_price: 240,
    stages: [{ stage: 'A', sessions: 7, material_fee: 100 }, { stage: 'B', sessions: 18, material_fee: 100 }],
    discount_type: 'pct', discount_value: 0.85
  },
  subjects: { A: ['数学'], B: ['数学'] },
  discount: undefined
});
eq('方案优惠默认带入：discountType = pct', r8.discountType, 'pct');
near('方案优惠默认带入：discountValue = 0.85', r8.discountValue, 0.85);
near('方案优惠默认带入：折后课时费 6000×0.85 = 5100', r8.tuition, 5100);
near('方案优惠默认带入：应付 5100+200 = 5300', r8.payable, 5300);

/* 算例 9 —— pct 一次性取整（node 实测 92587.5×0.85 = 78699.375 → 78699.38） */
const r9 = calc({
  plan: { unit_price: 1234.50, stages: [{ stage: 'A', sessions: 25, material_fee: 0 }], discount_type: 'none' },
  subjects: { A: ['数学', '英语', '物理'] },
  discount: { type: 'pct', value: 0.85 }
});
near('pct 一次性取整：O = 1234.50×25×3 = 92587.5', r9.original, 92587.5);
near('pct 一次性取整：T = 78699.38（整单一次取整，不逐科）', r9.tuition, 78699.38);
near('pct 一次性取整：D = 92587.5−78699.38 = 13888.12', r9.discountAmount, 13888.12);

/* 算例 10 —— 空阶段 / 空 subjects → 拒绝 */
eq('空阶段方案：priceContract 判为不可保存',
  calc({ plan: { unit_price: 240, stages: [] }, subjects: {} }).ok, false);
ok('空 subjects：validateContract 拒绝',
  Core.validateContract({
    stu_name: '郭欣阳', grade: '高二', year: 2026, planName: '寒春连报',
    plan: PLAN_HC, subjects: { A: [], B: [] }, discount: { type: 'none', value: 0 }
  }, []).indexOf('至少选择 1 科') >= 0);

/* =========================================================
 * 4. 计价边界
 * ========================================================= */
console.log('\n=== 4. 计价边界 ===');
const rNone = calc({ subjects: { A: ['数学'], B: ['数学'] } });
near('无优惠：折后课时费 = 原价', rNone.tuition, rNone.original);
near('无优惠：优惠金额 = 0', rNone.discountAmount, 0);
near('小计 S = 折后课时费 + 资料费 = 6200', rNone.subtotal, 6200);
eq('stageMaterial 行数 = 方案阶段数', rNone.stageMaterial.length, 2);
near('资料费按阶段：A 阶段 100×1 = 100', rNone.stageMaterial[0].amount, 100);
near('资料费按阶段：B 阶段 100×1 = 100', rNone.stageMaterial[1].amount, 100);
const rBalance = calc({ subjects: { A: ['数学'], B: ['数学'] }, balance: 500 });
near('结余 < 小计：抵扣 = 结余 500', rBalance.deduction, 500);
near('结余 < 小计：应付 = 6200−500 = 5700', rBalance.payable, 5700);
near('结余 < 小计：剩余 0', rBalance.balanceLeft, 0);
near('负结余被夹到 0（不产生负数抵扣）',
  calc({ subjects: { A: ['数学'] }, balance: -100 }).deduction, 0);
ok('无方案时 ok=false 且不抛错',
  Core.priceContract({ year: 2026, grade: '高二', planName: '', plan: null, subjects: {}, balance: 0 }).ok === false);
near('资料费不同阶段不同单价：140 + 100 = 240',
  calc({
    plan: {
      unit_price: 240,
      stages: [{ stage: 'A', sessions: 7, material_fee: 140 }, { stage: 'B', sessions: 18, material_fee: 100 }],
      discount_type: 'none', discount_value: 0
    },
    subjects: { A: ['数学'], B: ['数学'] }
  }).materialAmount, 240);

/* =========================================================
 * 5. 方案校验 validatePlan
 * ========================================================= */
console.log('\n=== 5. 方案校验（PRD §3.6.1 字段表）===');
const ALL = [{
  id: 1, year: 2026, grade: '高二', plan_name: '寒春连报', unit_price: 240,
  stages: PLAN_HC.stages, discount_type: 'none', discount_value: 0
}];
function vp(over) {
  return Core.validatePlan(Object.assign({
    year: 2026, grade: '高二', plan_name: '新方案', unit_price: 240,
    stages: [{ stage: 'A', sessions: 7, material_fee: 100 }],
    discount_type: 'none', discount_value: 0, remark: ''
  }, over || {}), ALL, null);
}
eq('合法方案通过', vp(), '');
eq('年份必须是整数', vp({ year: 2026.5 }), '年份必须是整数');
ok('年份下界越界被拒', vp({ year: 1999 }).indexOf('2000') >= 0);
ok('年份上界越界被拒', vp({ year: 2101 }).indexOf('2100') >= 0);
ok('年级非法被拒', vp({ grade: '大一' }).indexOf('年级') >= 0);
eq('方案名称不能为空', vp({ plan_name: '   ' }), '请填写方案名称');
ok('方案名称超 20 字被拒', vp({ plan_name: '方'.repeat(21) }).indexOf('20') >= 0);
eq('方案名称正好 20 字通过', vp({ plan_name: '方'.repeat(20) }), '');
ok('课时费 <= 0 被拒', vp({ unit_price: 0 }).indexOf('大于 0') >= 0);
eq('同年份年级重名被拒', vp({ plan_name: '寒春连报' }), '该年份年级下已有同名方案');
eq('编辑自身不算重名', Core.validatePlan({
  year: 2026, grade: '高二', plan_name: '寒春连报', unit_price: 240,
  stages: [{ stage: 'A', sessions: 7, material_fee: 100 }],
  discount_type: 'none', discount_value: 0
}, ALL, 1), '');
eq('不同年份同名允许', vp({ plan_name: '寒春连报', year: 2027 }), '');
eq('阶段为空被拒', vp({ stages: [] }), '至少配置 1 个阶段');
eq('阶段非法被拒', vp({ stages: [{ stage: 'X', sessions: 7 }] }), '第 1 行：请选择阶段');
ok('阶段重复被拒',
  vp({
    stages: [
      { stage: 'A', sessions: 7, material_fee: 100 },
      { stage: 'A', sessions: 9, material_fee: 100 }
    ]
  }).indexOf('重复') >= 0);
ok('资料费留空被拒', vp({ stages: [{ stage: 'A', sessions: 7 }] }).indexOf('请填写资料费') >= 0);
eq('上课次数为小数被拒', vp({ stages: [{ stage: 'A', sessions: 7.5 }] }), 'A 阶段：上课次数必须是整数');
ok('上课次数 0 被拒', vp({ stages: [{ stage: 'A', sessions: 0 }] }).indexOf('1–200') >= 0);
ok('上课次数 201 被拒', vp({ stages: [{ stage: 'A', sessions: 201 }] }).indexOf('1–200') >= 0);
ok('资料费负数被拒',
  vp({ stages: [{ stage: 'A', sessions: 7, material_fee: -1 }] }).indexOf('资料费不能为负数') >= 0);
eq('资料费 0 允许', vp({ stages: [{ stage: 'A', sessions: 7, material_fee: 0 }] }), '');
ok('折扣 0 被拒', vp({ discount_type: 'pct', discount_value: 0 }).indexOf('1–100') >= 0);
eq('折扣 85（百分数写法）通过', vp({ discount_type: 'pct', discount_value: 85 }), '');
eq('折扣 0.85（小数写法）通过', vp({ discount_type: 'pct', discount_value: 0.85 }), '');
ok('折扣 101 被拒', vp({ discount_type: 'pct', discount_value: 101 }).indexOf('1–100') >= 0);
ok('减免金额 0 被拒', vp({ discount_type: 'amount', discount_value: 0 }).indexOf('大于 0') >= 0);
eq('减免金额 300 通过', vp({ discount_type: 'amount', discount_value: 300 }), '');
eq('无优惠时 discount_value 不影响校验', vp({ discount_type: 'none', discount_value: 999 }), '');
/* T11 方案备注（选填 ≤200 字） */
eq('备注留空允许', vp({ remark: '' }), '');
eq('备注正好 200 字允许', vp({ remark: '备'.repeat(200) }), '');
ok('备注超 200 字被拒', vp({ remark: '备'.repeat(201) }).indexOf('200') >= 0);
/* 备注按 trim 后的长度计（首尾空白不算字数） */
eq('备注首尾空白不计入字数（200 个空格不超长）', vp({ remark: ' '.repeat(200) }), '');

/* 折扣校验的「防死代码」护栏：
   normRate 会把 0 / 101 / 1.5 一律兜底成 1（不打折），若校验用了归一后的值就永远放行。
   这 5 条专门盯住这个坑（T9 初版真踩过）。 */
ok('折扣 85.5（非整数百分数）被拒',
  vp({ discount_type: 'pct', discount_value: 85.5 }).indexOf('1–100') >= 0);
eq('parseRate(85) = 0.85', Core.parseRate(85), 0.85);
eq('parseRate(0.88) = 0.88', Core.parseRate(0.88), 0.88);
ok('parseRate(0) 非法 → NaN', isNaN(Core.parseRate(0)));
ok('parseRate(101) 非法 → NaN', isNaN(Core.parseRate(101)));
eq('discountInputError 未给优惠时返回空串', Core.discountInputError(undefined), '');

/* =========================================================
 * 6. 合同校验 validateContract
 * ========================================================= */
console.log('\n=== 6. 合同校验（PRD §3.6.2）===');
function vc(over) {
  return Core.validateContract(Object.assign({
    stu_name: '郭欣阳', grade: '高二', year: 2026, planName: '寒春连报',
    plan: PLAN_HC, subjects: { A: ['数学'], B: ['数学'] },
    discount: { type: 'none', value: 0 }, balance: 0
  }, over || {}), ALL, {});
}
eq('合法合同通过', vc(), '');
eq('学生姓名不能为空', vc({ stu_name: '  ' }), '学生姓名不能为空');
ok('学生姓名超 20 字被拒', vc({ stu_name: '名'.repeat(21) }).indexOf('20') >= 0);
ok('年级非法被拒', vc({ grade: '大一' }).indexOf('年级') >= 0);
eq('未选年份被拒', vc({ year: '' }), '请选择合同年份');
eq('未选方案被拒', vc({ planName: '' }), '请选择报读方案');
eq('A 阶段没选科目被拒', vc({ subjects: { A: [], B: ['数学'] } }), 'A 阶段至少选择 1 科');
eq('B 阶段没选科目被拒', vc({ subjects: { A: ['数学'], B: [] } }), 'B 阶段至少选择 1 科');
ok('选到方案外阶段被拒',
  vc({ subjects: { A: ['数学'], B: ['数学'], C: ['物理'] } }).indexOf('只包含 A / B 阶段') >= 0);
eq('负结余被拒', vc({ balance: -1 }), '电子账户结余不能为负数');
ok('负优惠金额被拒', vc({ discount: { type: 'amount', value: -5 } }).indexOf('不能为负数') >= 0);
ok('折扣越界被拒', vc({ discount: { type: 'pct', value: 1.5 } }).indexOf('1–100') >= 0);
ok('折扣 101 被拒（校验原始值，不被兜底放过）',
  vc({ discount: { type: 'pct', value: 101 } }).indexOf('1–100') >= 0);
ok('减免 0 元被拒（应选「无优惠」）',
  vc({ discount: { type: 'amount', value: 0 } }).indexOf('大于 0') >= 0);
eq('减免 300 元合法', vc({ discount: { type: 'amount', value: 300 } }), '');
eq('折扣 85（百分数写法）合法', vc({ discount: { type: 'pct', value: 85 } }), '');
eq('同一学生同年级已有合同被拦',
  Core.validateContract({
    stu_name: '郭欣阳', grade: '高二', year: 2026, planName: '寒春连报', plan: PLAN_HC,
    subjects: { A: ['数学'], B: ['数学'] }
  }, ALL, { contracts: [{ id: 9, stu_name: '郭欣阳', grade: '高二' }] }),
  '该学生在高二已有合同，请直接修改');
eq('方案不存在的提示文案',
  Core.validateContract({
    stu_name: '郭欣阳', grade: '高二', year: 2030, planName: '不存在的方案',
    plan: null, subjects: { A: ['数学'] }
  }, ALL, {}), '该年份年级还没有价目方案，请先到『价目维护』新增');

/* --- T11 多方案合同校验 --- */
const ALL_MULTI = ALL.concat([
  { id: 5, year: 2026, grade: '高二', plan_name: '暑期班', unit_price: 200, stages: PLAN_SUMMER.stages, discount_type: 'pct', discount_value: 0.85 }
]);
function vcm(plans) {
  return Core.validateContract({
    stu_name: '郭欣阳', grade: '高二', year: 2026, plans: plans, balance: 0
  }, ALL_MULTI, {});
}
eq('多方案：两个方案都填好 → 通过',
  vcm([
    { planName: '寒春连报', subjects: { A: ['数学'], B: ['数学'] } },
    { planName: '暑期班', subjects: { C: ['物理'] } }
  ]), '');
ok('多方案：没勾任何方案被拒',
  vcm([]).indexOf('请选择报读方案') >= 0);
ok('多方案：第二个方案缺科目 → 报错带方案名前缀',
  vcm([
    { planName: '寒春连报', subjects: { A: ['数学'], B: ['数学'] } },
    { planName: '暑期班', subjects: { C: [] } }
  ]).indexOf('方案「暑期班」：C 阶段至少选择 1 科') >= 0);
ok('多方案：重复勾同一个方案被拒',
  vcm([
    { planName: '寒春连报', subjects: { A: ['数学'], B: ['数学'] } },
    { planName: '寒春连报', subjects: { A: ['英语'], B: ['英语'] } }
  ]).indexOf('重复选择') >= 0);
ok('多方案：第二个方案的优惠非法 → 报错带方案名前缀',
  vcm([
    { planName: '寒春连报', subjects: { A: ['数学'], B: ['数学'] } },
    { planName: '暑期班', subjects: { C: ['物理'] }, discount: { type: 'pct', value: 101 } }
  ]).indexOf('方案「暑期班」：折扣需在 1–100 之间') >= 0);
eq('多方案：第二个方案没勾优惠 → 沿用方案预设，通过',
  vcm([
    { planName: '寒春连报', subjects: { A: ['数学'], B: ['数学'] } },
    { planName: '暑期班', subjects: { C: ['物理'] }, discount: null }
  ]), '');
ok('单方案时错误文案不带方案名前缀（老口径不变）',
  vc({ subjects: { A: [], B: ['数学'] } }) === 'A 阶段至少选择 1 科');

/* =========================================================
 * 7. 价目命中 / 分组
 * ========================================================= */
console.log('\n=== 7. 价目命中与分组 ===');
const PRICES = [
  { id: 1, year: 2026, grade: '高二', plan_name: '寒春连报', unit_price: 240, stages: PLAN_HC.stages, discount_type: 'none', discount_value: 0, remark: '含寒春两季', updated_at: '2026-11-11T10:00:00Z' },
  { id: 2, year: 2026, grade: '高二', plan_name: '单报春季', unit_price: 240, stages: PLAN_SPRING.stages, discount_type: 'amount', discount_value: 50, remark: '', updated_at: '2026-11-11T10:00:00Z' },
  { id: 3, year: 2027, grade: '高二', plan_name: '寒春连报', unit_price: 260, stages: PLAN_HC.stages, discount_type: 'none', discount_value: 0, remark: '', updated_at: '2026-11-11T10:00:00Z' },
  { id: 4, year: 2026, grade: '高二', plan_name: '寒春连报', unit_price: 250, stages: PLAN_HC.stages, discount_type: 'none', discount_value: 0, remark: '', updated_at: '2026-11-11T11:00:00Z' }
];
eq('命中方案：同键重复行取 updated_at 较新者',
  Core.findPlan(PRICES, 2026, '高二', '寒春连报').unit_price, 250);
eq('命中方案：跨年份不串',
  Core.findPlan(PRICES, 2027, '高二', '寒春连报').unit_price, 260);
eq('命中方案：不存在返回 null', Core.findPlan(PRICES, 2026, '高一', '寒春连报'), null);
eq('plansFor 返回该年份年级的全部方案', Core.plansFor(PRICES, 2026, '高二').length, 3);
eq('priceYears 升序去重', Core.priceYears(PRICES).join(','), '2026,2027');
eq('priceYears 空表返回空数组', Core.priceYears([]).length, 0);
eq('planStageList 返回阶段列表', Core.planStageList(PLAN_HC).join(''), 'AB');

/* =========================================================
 * 8. 明细快照往返
 * ========================================================= */
console.log('\n=== 8. 明细快照（items jsonb）往返 ===');
const snapInput = {
  year: 2026, grade: '高二', planName: '寒春连报', plan: PLAN_HC,
  subjects: { A: ['数学', '英语'], B: ['数学'] },
  discount: { type: 'pct', value: 0.85 }, balance: 0
};
const snapRes = Core.priceContract(snapInput);
const snap = Core.itemsSnapshot(snapInput, snapRes);
eq('快照记录方案名称', snap.planName, '寒春连报');
eq('快照记录阶段配置（2 个阶段）', snap.plan.stages.length, 2);
eq('快照记录每阶段科目', snap.stages.A.join(','), '数学,英语');
eq('快照 lines 是「阶段 × 科目」的明细行', snap.lines.length, 3);
ok('快照带科目行（明细单复现用）', Array.isArray(snap.subjectRows) && snap.subjectRows.length === 2);
ok('快照带阶段资料费明细', Array.isArray(snap.stageMaterial) && snap.stageMaterial.length === 2);
eq('快照 pricesVersion = 年份', snap.pricesVersion, '2026');
eq('T11 快照同时带 plans 数组（单方案时长度 1）', snap.plans.length, 1);
eq('T11 单方案快照的 plans[0].planName', snap.plans[0].planName, '寒春连报');

const row = {
  id: 77, stu_name: '郭欣阳', grade: '高二', year: 2026, plan: '寒春连报',
  items: snap,
  original_amount: snapRes.original,
  discount_type: snapRes.discountType,
  discount_value: snapRes.discountValue,
  discount_amount: snapRes.discountAmount,
  material_amount: snapRes.materialAmount,
  account_deduction: 0,
  payable_amount: snapRes.payable,
  balance_remain: 0
};
const back = Core.snapshotResult(row);
eq('往返：方案名称一致', back.planName, '寒春连报');
eq('往返：科目行数一致', back.subjectRows.length, snapRes.subjectRows.length);
eq('往返：阶段列数一致', back.stageList.length, 2);
near('往返：应付金额一致', back.payable, snapRes.payable);
near('往返：课时费一致', back.tuition, snapRes.tuition);
near('往返：资料费一致', back.materialAmount, snapRes.materialAmount);
eq('往返：科目行小计可复现', back.subjectRows[0].amount, snapRes.subjectRows[0].amount);
eq('往返：优惠文案可复现', Core.discountText(back), '85折');

/* 老快照（只有 lines、没有 subjectRows）也要能复现 */
const legacyRow = {
  id: 78, stu_name: '老数据', grade: '高二', year: 2026, plan: '寒春连报',
  items: {
    plan: PLAN_HC,
    stages: { A: ['数学'], B: ['数学'] },
    lines: [
      { stage: 'A', subject: '数学', unitPrice: 240, sessions: 7, amount: 1680, material: 100 },
      { stage: 'B', subject: '数学', unitPrice: 240, sessions: 18, amount: 4320, material: 100 }
    ],
    pricesVersion: '2026'
  },
  original_amount: 6000, discount_type: 'none', discount_value: 0, discount_amount: 0,
  material_amount: 200, account_deduction: 0, payable_amount: 6200, balance_remain: 0
};
const legacyBack = Core.snapshotResult(legacyRow);
eq('老快照（只有 lines）也能推出科目行', legacyBack.subjectRows.length, 1);
eq('老快照科目行总次数 25', legacyBack.subjectRows[0].sessionsTotal, 25);
near('老快照应付可复现', legacyBack.payable, 6200);
eq('老快照没有 plans 数组', legacyBack.plans, null);

/* --- T11 多方案快照往返 --- */
const MULTI_INPUT = {
  stu_name: '郭欣阳', year: 2026, grade: '高二', balance: 0,
  plans: [
    {
      planName: '寒春连报', plan: PLAN_HC,
      subjects: { A: ['数学'], B: ['数学'] },
      discount: { type: 'amount', value: 300 },
      remark: '含寒春两季'
    },
    {
      planName: '暑期班', plan: PLAN_SUMMER,
      subjects: { C: ['物理'] },
      discount: null,                     // 沿用方案预设 85 折
      remark: ''
    }
  ]
};
const multiRes = Core.priceEntry(MULTI_INPUT);
const multiSnap = Core.itemsSnapshot(MULTI_INPUT, multiRes);
eq('多方案快照 plans 长度 2', multiSnap.plans.length, 2);
eq('多方案快照 planName 用 + 拼接', multiSnap.planName, '寒春连报+暑期班');
eq('多方案快照记录方案备注', multiSnap.plans[0].remark, '含寒春两季');
eq('多方案快照记录单方案阶段数', multiSnap.plans[0].stages.length, 2);
eq('多方案快照记录单方案科目', multiSnap.plans[1].subjects.C.join(','), '物理');
eq('多方案快照记录单方案优惠类型', multiSnap.plans[1].discount.type, 'pct');
near('多方案快照记录单方案折后课时费', multiSnap.plans[1].tuition, 1700);
near('多方案快照记录单方案资料费', multiSnap.plans[1].materialAmount, 50);

const multiRow = {
  id: 80, stu_name: '郭欣阳', grade: '高二', year: 2026, plan: '寒春连报+暑期班',
  items: multiSnap,
  original_amount: multiRes.original,
  discount_type: multiRes.discountType,
  discount_value: multiRes.discountValue,
  discount_amount: multiRes.discountAmount,
  material_amount: multiRes.materialAmount,
  account_deduction: 0,
  payable_amount: multiRes.payable,
  balance_remain: 0
};
const multiBack = Core.snapshotResult(multiRow);
eq('多方案往返：plans 长度 2', multiBack.plans.length, 2);
eq('多方案往返：标记为 multi', multiBack.multi, true);
eq('多方案往返：方案名+号拼接', multiBack.planName, '寒春连报+暑期班');
eq('多方案往返：备注随方案带回', multiBack.plans[0].remark, '含寒春两季');
near('多方案往返：应付一致', multiBack.payable, multiRes.payable);
near('多方案往返：课时费一致', multiBack.tuition, multiRes.tuition);
eq('多方案往返：合并科目行 2 行（数学 + 物理）', multiBack.subjectRows.length, 2);
eq('多方案往返：整单优惠类型 = mixed', multiBack.discountType, 'mixed');
eq('多方案往返：优惠文案 = 多方案优惠', Core.discountText(multiBack), '多方案优惠');
assertPlansSum(multiBack);

/** 断言「各方案金额之和 = 整单金额」 */
function assertPlansSum(view) {
  let o = 0, d = 0, m = 0;
  (view.plans || []).forEach(function (p) {
    o += p.original;
    d += p.discountAmount;
    m += p.materialAmount;
  });
  near('多方案：整单 O = ΣO_p', view.original, Math.round(o * 100) / 100);
  near('多方案：整单 D = ΣD_p', view.discountAmount, Math.round(d * 100) / 100);
  near('多方案：整单 M = ΣM_p', view.materialAmount, Math.round(m * 100) / 100);
}

/* =========================================================
 * 9. 方案预览（录价目时的试算行）
 * ========================================================= */
console.log('\n=== 9. 方案预览 previewPlan ===');
const pv = Core.previewPlan(PLAN_HC);
near('预览：1 科 O = 240×25 = 6000', pv.original, 6000);
near('预览：资料费 = 100+100 = 200', pv.materialAmount, 200);
near('预览：无优惠时应付 = 6200', pv.payable, 6200);
ok('预览：文案含单价与总次数', pv.formula.indexOf('240.00') >= 0 && pv.formula.indexOf('25 次') >= 0);
const pvDisc = Core.previewPlan({
  unit_price: 240,
  stages: [{ stage: 'A', sessions: 7, material_fee: 100 }, { stage: 'B', sessions: 18, material_fee: 100 }],
  discount_type: 'amount', discount_value: 300
});
near('预览：带减免时应付 = 6000−300+200 = 5900', pvDisc.payable, 5900);

/* =========================================================
 * 10. 渲染 smoke（价目列表 / 合同登记 / 明细单 / 台账）
 * ========================================================= */
console.log('\n=== 10. 渲染 smoke ===');
App.DB.cache.contract_prices = PRICES.slice(0, 3);
App.DB.cache.contracts = [];

/* 价目维护 tab */
App.Contracts.state.tab = 'prices';
App.Contracts.state.priceYear = '';
const priceHtml = mod.render();
ok('价目列表渲染出方案名称', priceHtml.indexOf('寒春连报') >= 0);
ok('价目列表渲染出阶段组合摘要', priceHtml.indexOf('A 7次 + B 18次') >= 0);
ok('价目列表渲染出优惠摘要', priceHtml.indexOf('减50元') >= 0);
ok('价目列表按年份分组', priceHtml.indexOf('2026 年') >= 0 && priceHtml.indexOf('2027 年') >= 0);
ok('价目列表有「新增方案」入口', priceHtml.indexOf('新增方案') >= 0);
ok('价目列表提示唯一键', priceHtml.indexOf('年份 + 年级 + 方案名称') >= 0);
ok('价目列表不再出现旧的「阶段 / 连报方案」四列口径',
  priceHtml.indexOf('连报方案') < 0 && priceHtml.indexOf('单报 A 阶段') < 0);
ok('价目列表渲染出「备注」列', priceHtml.indexOf('<th>备注</th>') >= 0);
ok('价目列表渲染出方案备注（title 存全文）',
  priceHtml.indexOf('含寒春两季') >= 0 && priceHtml.indexOf('title="含寒春两季"') >= 0);
ok('无备注的方案显示占位 —', priceHtml.indexOf('单报春季') >= 0);

/* ---------------- 合同登记：多方案 ---------------- */
App.DB.cache.contract_prices = [
  { id: 11, year: 2026, grade: '高二', plan_name: '寒春连报', unit_price: 240, stages: PLAN_HC.stages, discount_type: 'none', discount_value: 0, remark: '含寒春两季', updated_at: '2026-11-11T10:00:00Z' },
  { id: 12, year: 2026, grade: '高二', plan_name: '暑期班', unit_price: 200, stages: PLAN_SUMMER.stages, discount_type: 'pct', discount_value: 0.85, remark: '', updated_at: '2026-11-11T10:00:00Z' }
];
App.Contracts.state.tab = 'entry';
App.Contracts.state.editingId = null;
App.Contracts.state.droppedPlans = [];
App.Contracts.state.entry = {
  stu_name: '郭欣阳', grade: '高二', year: 2026, balance: 0,
  plans: [
    { name: '寒春连报', discount: { type: 'amount', value: 300 }, discountTouched: true, subjects: { A: ['数学'], B: ['数学'] } },
    { name: '暑期班', discount: { type: 'pct', value: 0.85 }, discountTouched: false, subjects: { C: ['物理'] } }
  ]
};
const entryHtml = mod.render();
const entryDetail = detailPart(entryHtml);
ok('登记页渲染方案勾选框（含方案标签）', entryHtml.indexOf('寒春连报（A 7次 + B 18次') >= 0);
ok('登记页方案勾选框可多选（两个都 checked）',
  /data-plan-name="寒春连报" checked/.test(entryHtml) && /data-plan-name="暑期班" checked/.test(entryHtml));
ok('登记页按方案×阶段渲染多选区（plan0-A / plan0-B / plan1-C）',
  entryHtml.indexOf('data-mount="plan0-A"') >= 0 &&
  entryHtml.indexOf('data-mount="plan0-B"') >= 0 &&
  entryHtml.indexOf('data-mount="plan1-C"') >= 0);
ok('登记页不渲染方案外的阶段', entryHtml.indexOf('data-mount="plan0-C"') < 0);
ok('登记页每个方案各有一组优惠单选（name 不同）',
  entryHtml.indexOf('name="ct-disc-0"') >= 0 && entryHtml.indexOf('name="ct-disc-1"') >= 0);
ok('登记页阶段摘要 chip（A 阶段·7 次·资料费 100.00 元/科）',
  entryHtml.indexOf('A 阶段·7 次·资料费 100.00 元/科') >= 0);

/* 明细单：多方案 → 一张合并横表（T12 需求 1） */
eq('多方案明细只渲染一张 table（合并视图）', countOf(entryDetail, '<table'), 1);
ok('合并表带 ct-detail-table 类 + 横向滚动容器',
  entryDetail.indexOf('class="ct-detail-table"') >= 0 && entryDetail.indexOf('ct-detail-wrap') >= 0);
ok('阶段列平铺所有方案（列头带方案名前缀）',
  entryDetail.indexOf('寒春连报 · A 阶段(7次)') >= 0 &&
  entryDetail.indexOf('寒春连报 · B 阶段(18次)') >= 0 &&
  entryDetail.indexOf('暑期班 · C 阶段(10次)') >= 0);
ok('明细单渲染阶段列标题',
  entryDetail.indexOf('A 阶段(7次)') >= 0 && entryDetail.indexOf('B 阶段(18次)') >= 0 &&
  entryDetail.indexOf('C 阶段(10次)') >= 0);
ok('明细单渲染科目行', entryDetail.indexOf('>数学<') >= 0 && entryDetail.indexOf('>物理<') >= 0);
ok('明细单渲染资料费行（单价×科目数）',
  entryDetail.indexOf('资料费') >= 0 && entryDetail.indexOf('100.00×1=100.00') >= 0);
ok('多方案不再另起「合计（N 个方案）」第二张表（已并入表尾）',
  entryDetail.indexOf('合计（2 个方案）') < 0);
ok('方案小计行按方案分组（方案名 + 该方案小计）',
  entryDetail.indexOf('方案小计') >= 0 &&
  entryDetail.indexOf('寒春连报 5900.00') >= 0 &&
  entryDetail.indexOf('暑期班 1750.00') >= 0);
ok('明细单渲染应付金额', entryDetail.indexOf('应付金额') >= 0);
ok('明细单里没有残留的旧竖表标题「1. 寒春连报」',
  entryDetail.indexOf('1. 寒春连报') < 0);

/* T12 需求 1 第 4 点：两种单价模式（本夹具 240 / 200 不一致） */
ok('单价不一致 → 不设「课时单价(元/次课)」列',
  entryDetail.indexOf('课时单价(元/次课)') < 0);
ok('单价不一致 → 列头附「· 240.00 元/科」「· 200.00 元/科」',
  entryDetail.indexOf('A 阶段(7次) · 240.00 元/科') >= 0 &&
  entryDetail.indexOf('C 阶段(10次) · 200.00 元/科') >= 0);
ok('单价不一致 → 单元格改成「240.00×7=1680.00」式金额',
  entryDetail.indexOf('240.00×7=1680.00') >= 0 &&
  entryDetail.indexOf('240.00×18=4320.00') >= 0 &&
  entryDetail.indexOf('200.00×10=2000.00') >= 0);

/* 同名科目跨方案合并成一行（暑期班改报数学） */
const savedSubj1 = App.Contracts.state.entry.plans[1].subjects;
App.Contracts.state.entry.plans[1].subjects = { C: ['数学'] };
const mergedSubjDetail = detailPart(mod.render());
eq('同名科目跨方案合并成一行', countOf(mergedSubjDetail, '>数学<'), 1);
ok('合并行小计 = 各方案该科金额之和（6000 + 2000 = 8000.00）',
  mergedSubjDetail.indexOf('8000.00') >= 0);
App.Contracts.state.entry.plans[1].subjects = savedSubj1;

/* 单价全部一致 → 单列 + ✓ 模式 */
const summerRow = App.DB.cache.contract_prices[1];
summerRow.unit_price = 240;
const uniDetail = detailPart(mod.render());
ok('单价一致 → 显示「课时单价(元/次课)」列',
  uniDetail.indexOf('课时单价(元/次课)') >= 0);
ok('单价一致 → 单元格打 ✓，不再写「元/科」后缀',
  uniDetail.indexOf('✓') >= 0 && uniDetail.indexOf('元/科') < 0);
summerRow.unit_price = 200;
/* 算账：寒春连报 O=240×25=6000、减 300、M=200 → 5900
         暑期班   O=200×10=2000、85 折 1700、M=50 → 1750
         合计 S=7650、应付 7650 */
ok('明细单渲染出整单小计 7650.00', entryDetail.indexOf('7650.00') >= 0);
ok('明细单渲染出方案一应付小计 5900.00', entryDetail.indexOf('5900.00') >= 0);
ok('明细单渲染出方案二小计 1750.00', entryDetail.indexOf('1750.00') >= 0);

/* T11 需求 3：明细单不再写公式注释 */
ok('明细单不再出现「课时费原价合计（O）」', entryDetail.indexOf('（O）') < 0);
ok('明细单不再出现「资料费合计（M，不参与任何优惠）」',
  entryDetail.indexOf('（M，不参与任何优惠）') < 0);
ok('明细单不再出现「小计（S = 折后课时费 + 资料费）」',
  entryDetail.indexOf('S =') < 0 && entryDetail.indexOf('小计（') < 0);
ok('明细单不再出现底部「口径：…」说明块', entryDetail.indexOf('口径：') < 0);
ok('明细单保留「资料费合计」标签', entryDetail.indexOf('资料费合计') >= 0);
ok('明细单保留「课时费原价合计」标签', entryDetail.indexOf('课时费原价合计') >= 0);

/* T11 需求 2：结余行条件渲染 */
ok('无结余时明细单不渲染「电子账户结余抵扣」行',
  entryDetail.indexOf('电子账户结余抵扣') < 0);
App.Contracts.state.entry.balance = 1000;
const balHtml = mod.render();
const balDetail = detailPart(balHtml);
ok('结余 1000 时明细单渲染「电子账户结余抵扣」行',
  balDetail.indexOf('电子账户结余抵扣') >= 0);
ok('结余 1000 时抵扣金额渲染为 − 1000.00', balDetail.indexOf('－ 1000.00') >= 0);
ok('结余 1000 时应付 = 7650−1000 = 6650.00', balDetail.indexOf('6650.00') >= 0);
App.Contracts.state.entry.balance = 0;

/* T12 需求 2 + T13 布局微调：备注提示条（渲染在表格**下方**、紧凑一行） */
ok('备注提示条渲染（浅黄底 + 📌 备注 标签 + 全文）',
  entryDetail.indexOf('ct-remark-tip') >= 0 &&
  entryDetail.indexOf('#fff8e1') >= 0 &&
  entryDetail.indexOf('📌 备注') >= 0 &&
  entryDetail.indexOf('含寒春两季') >= 0);
ok('T13：备注提示条在表格下方（<table 先于提示条出现）',
  entryDetail.indexOf('<table') < entryDetail.indexOf('ct-remark-tip'));
ok('T13：紧凑样式（6px 11px 内边距 + 12.5px 字号 + 1.5 行高 + 8px 上间距）',
  entryDetail.indexOf('padding:6px 11px') >= 0 &&
  entryDetail.indexOf('font-size:12.5px;line-height:1.5') >= 0 &&
  entryDetail.indexOf('margin:8px 0 0') >= 0);
ok('T13：左竖条压到 3px（不再 4px）',
  entryDetail.indexOf('border-left:3px solid var(--amber') >= 0 &&
  entryDetail.indexOf('border-left:4px solid var(--amber') < 0);
ok('T13：标签与正文同一行（inline，不单独占一行）',
  entryDetail.indexOf('📌 备注</span> <b>寒春连报</b>：含寒春两季') >= 0);
ok('T13：不用 ellipsis / max-height 截断（长文自然换行）',
  entryDetail.indexOf('text-overflow') < 0 && entryDetail.indexOf('max-height') < 0);
eq('只有一个方案有备注 → 提示条只出现一次', countOf(entryDetail, 'ct-remark-tip'), 1);
ok('多方案里只有一方有备注 → 带方案名前缀',
  entryDetail.indexOf('<b>寒春连报</b>：含寒春两季') >= 0);
ok('无备注的方案不占提示条行（不出现空的备注条目）',
  entryDetail.indexOf('<b>暑期班</b>：<') < 0 && entryDetail.indexOf('：</div>') < 0);
/* 两个方案备注相同时合并成一条 */
App.DB.cache.contract_prices[1].remark = '含寒春两季';
const sameRemarkDetail = detailPart(mod.render());
eq('两方案备注相同 → 去重成一条提示', countOf(sameRemarkDetail, 'ct-remark-tip'), 1);
eq('两方案备注相同 → 全文只出现一次', countOf(sameRemarkDetail, '含寒春两季'), 1);
ok('两方案备注相同 → 不带方案名前缀', sameRemarkDetail.indexOf('<b>寒春连报</b>：') < 0);
/* 两个方案备注不同 → 逐条显示，各带方案名前缀 */
App.DB.cache.contract_prices[1].remark = '含 4 次晚辅';
const diffRemarkDetail = detailPart(mod.render());
ok('两方案备注不同 → 逐条显示，各带方案名前缀',
  diffRemarkDetail.indexOf('<b>寒春连报</b>：含寒春两季') >= 0 &&
  diffRemarkDetail.indexOf('<b>暑期班</b>：含 4 次晚辅') >= 0);
App.DB.cache.contract_prices[1].remark = '';

/* 无优惠时明细单不渲染「优惠（…）」行 */
App.Contracts.state.entry.plans[0].discount = { type: 'none', value: 0 };
App.Contracts.state.entry.plans[0].discountTouched = true;
App.Contracts.state.entry.plans[1].discount = { type: 'none', value: 0 };
App.Contracts.state.entry.plans[1].discountTouched = true;
const noDiscDetail = detailPart(mod.render());
ok('无优惠时明细单不渲染「优惠（…）」行', noDiscDetail.indexOf('优惠（') < 0);
App.Contracts.state.entry.plans[0].discount = { type: 'amount', value: 300 };
App.Contracts.state.entry.plans[1].discount = { type: 'pct', value: 0.85 };
App.Contracts.state.entry.plans[1].discountTouched = false;

/* 优惠合法 → 保存按钮可点；优惠填错 → 红字 + 置灰 */
const okHtml = mod.render();
ok('优惠合法时保存按钮可点', /id="ct-save">保存合同/.test(okHtml));
ok('登记页提示优惠只作用课时费', okHtml.indexOf('优惠只作用于课时费') >= 0);
App.Contracts.state.entry.plans[0].discount = { type: 'pct', value: 101 };
const badDiscHtml = mod.render();
ok('折扣 101 时登记页给出 1–100 红字提示', badDiscHtml.indexOf('1–100') >= 0);
ok('折扣 101 时保存按钮置灰', /id="ct-save"[^>]*disabled/.test(badDiscHtml));
App.Contracts.state.entry.plans[0].discount = { type: 'amount', value: -5 };
ok('减免 -5 时保存按钮置灰', /id="ct-save"[^>]*disabled/.test(mod.render()));
App.Contracts.state.entry.plans[0].discount = { type: 'amount', value: 300 };

/* 一个方案都没勾 → 提示 + 置灰 */
const savedPlans = App.Contracts.state.entry.plans;
App.Contracts.state.entry.plans = [];
const noneHtml = mod.render();
ok('没勾方案时提示「至少勾选 1 个报读方案」', noneHtml.indexOf('至少勾选 1 个报读方案') >= 0);
ok('没勾方案时保存按钮置灰', /id="ct-save"[^>]*disabled/.test(noneHtml));
ok('没勾方案时明细单给出占位说明', noneHtml.indexOf('还没有可用的报读方案') >= 0);
App.Contracts.state.entry.plans = savedPlans;

/* 无价目：给引导而不是报错 */
App.DB.cache.contract_prices = [];
const emptyHtml = mod.render();
ok('无价目时登记页引导先去价目维护', emptyHtml.indexOf('价目维护') >= 0);
ok('无价目时明细单给出占位说明', emptyHtml.indexOf('还没有可用的报读方案') >= 0);

/* 台账空态 */
App.Contracts.state.tab = 'ledger';
const ledgerHtml = mod.render();
ok('台账空态给出引导', ledgerHtml.indexOf('还没有合同') >= 0);
ok('台账不再出现旧的「连报方案」枚举', ledgerHtml.indexOf('单报 A 阶段') < 0);

/* =========================================================
 * 11. 多方案聚合口径 + 旧快照兼容（真实数据形状）
 * ========================================================= */
console.log('\n=== 11. 多方案聚合 / 旧快照兼容 / 备注往返 ===');

/* --- 各方案优惠相互独立 --- */
near('聚合：整单课时费原价 O = 6000 + 2000 = 8000', multiRes.original, 8000);
near('聚合：整单优惠 D = 300 + 300 = 600', multiRes.discountAmount, 600);
near('聚合：整单折后课时费 T = 5700 + 1700 = 7400', multiRes.tuition, 7400);
near('聚合：整单资料费 M = 200 + 50 = 250', multiRes.materialAmount, 250);
near('聚合：整单小计 S = 7400 + 250 = 7650', multiRes.subtotal, 7650);
near('聚合：结余 0 → 应付 7650', multiRes.payable, 7650);
near('聚合：方案一（减 300）折后 5700', multiRes.plans[0].tuition, 5700);
near('聚合：方案二（85折）折后 1700', multiRes.plans[1].tuition, 1700);
eq('聚合：方案一优惠类型 amount', multiRes.plans[0].discountType, 'amount');
eq('聚合：方案二优惠类型 pct', multiRes.plans[1].discountType, 'pct');
eq('聚合：整单优惠类型 mixed（两方案优惠不同）', multiRes.discountType, 'mixed');

const changedOne = Core.priceContractMulti([
  { planName: '寒春连报', plan: PLAN_HC, subjects: { A: ['数学'], B: ['数学'] }, discount: { type: 'pct', value: 0.5 } },
  { planName: '暑期班', plan: PLAN_SUMMER, subjects: { C: ['物理'] }, discount: null }
], 0);
near('只改方案一优惠 → 方案一折后 3000', changedOne.plans[0].tuition, 3000);
near('只改方案一优惠 → 方案二折后不变（1700）', changedOne.plans[1].tuition, 1700);
near('只改方案一优惠 → 整单 O 不变（8000）', changedOne.original, 8000);
near('只改方案一优惠 → 整单 D = 3000 + 300', changedOne.discountAmount, 3300);

const withBal = Core.priceContractMulti(MULTI_INPUT.plans, 1000);
near('聚合结余：抵扣 1000（整单一次，不按方案分摊）', withBal.deduction, 1000);
near('聚合结余：应付 6650', withBal.payable, 6650);
near('聚合结余：剩余 0', withBal.balanceLeft, 0);
near('聚合结余：方案层 deduction 全为 0（结余不下沉）',
  withBal.plans[0].deduction + withBal.plans[1].deduction, 0);
const overBal = Core.priceContractMulti(MULTI_INPUT.plans, 99999);
near('聚合结余 > 小计：应付 0', overBal.payable, 0);
near('聚合结余 > 小计：抵扣封顶 = 小计 7650', overBal.deduction, 7650);
near('聚合结余 > 小计：剩余 92349', overBal.balanceLeft, 92349);
eq('空方案列表：ok = false', Core.priceContractMulti([], 0).ok, false);
eq('单方案走聚合入口，金额与 priceContract 一致',
  Core.priceContractMulti([MULTI_INPUT.plans[0]], 0).payable, r1.payable);
eq('priceEntry 带 plans → 走多方案', Core.priceEntry(MULTI_INPUT).plans.length, 2);
eq('priceEntry 不带 plans → 走单方案（无 plans 字段）', Core.priceEntry(snapInput).plans, undefined);
eq('entryPlanList 单方案平铺写法也能归一', Core.entryPlanList({ planName: 'A', subjects: {} }).length, 1);
eq('entryPlanList 空输入返回一条空名称记录', Core.entryPlanList({})[0].planName, '');
eq('mergePlanViews 合并科目行去重', Core.mergePlanViews(multiRes.plans).subjectRows.length, 2);

/* --- 旧快照兼容：contracts id=2 的真实形状（T9 单方案 object） --- */
const REAL_ROW_2 = {
  id: 2, stu_name: '郭远阳', grade: '高二', year: 2026, plan: '寒春连报',
  items: {
    lines: [
      { stage: 'A', subject: '数学', unitPrice: 240, sessions: 7, amount: 1680, material: 100 },
      { stage: 'B', subject: '数学', unitPrice: 240, sessions: 18, amount: 4320, material: 100 }
    ],
    plan: {
      unit_price: 240,
      stages: [{ stage: 'A', sessions: 7, material_fee: 100 }, { stage: 'B', sessions: 18, material_fee: 100 }],
      discount_type: 'none', discount_value: 0
    },
    planName: '寒春连报',
    pricesVersion: '2026',
    stageMaterial: [
      { stage: 'A', unitFee: 100, count: 1, amount: 100 },
      { stage: 'B', unitFee: 100, count: 1, amount: 100 }
    ],
    stages: { A: ['数学'], B: ['数学'] },
    subjectRows: [{ subject: '数学', stagesHit: { A: true, B: true }, sessionsTotal: 25, amount: 6000 }]
  },
  original_amount: 6000, discount_type: 'none', discount_value: 0, discount_amount: 0,
  material_amount: 200, account_deduction: 0, payable_amount: 6200, balance_remain: 0
};
App.DB.cache.contract_prices = [
  { id: 11, year: 2026, grade: '高二', plan_name: '寒春连报', unit_price: 240, stages: PLAN_HC.stages, discount_type: 'none', discount_value: 0, remark: '含寒春两季', updated_at: '2026-11-11T10:00:00Z' }
];
const realBack = Core.snapshotResult(REAL_ROW_2);
eq('旧快照（T9 单方案 object）：方案名', realBack.planName, '寒春连报');
eq('旧快照：科目行 1 行', realBack.subjectRows.length, 1);
eq('旧快照：阶段列 2 个', realBack.stageList.length, 2);
near('旧快照：应付 6200', realBack.payable, 6200);
ok('旧快照：无 plans 数组（走单方案分支）', realBack.plans === null);
eq('旧快照：价目未变更（unit_price / stages 一致）', Core.priceChanged(REAL_ROW_2), false);

LAST_MODAL = null;
App.Contracts.openContractDetail(REAL_ROW_2);
const modalHtml = LAST_MODAL && LAST_MODAL.body ? LAST_MODAL.body.innerHTML : '';
ok('旧快照「查看明细」照常渲染学生姓名', modalHtml.indexOf('郭远阳') >= 0);
ok('旧快照「查看明细」渲染阶段列', modalHtml.indexOf('A 阶段(7次)') >= 0);
ok('旧快照「查看明细」渲染应付 6200.00', modalHtml.indexOf('6200.00') >= 0);
ok('旧快照「查看明细」注明签订时快照', modalHtml.indexOf('签订时快照') >= 0);
ok('旧快照「查看明细」同样不含「（O）」注释', modalHtml.indexOf('（O）') < 0);
ok('旧快照「查看明细」同样不含「口径：」块', modalHtml.indexOf('口径：') < 0);
/* T12：单方案旧快照也走同一张合并横表（天然退化为一组阶段列） */
eq('旧快照明细同样只有一张表（合并视图）', countOf(modalHtml, '<table'), 1);
ok('旧快照明细不残留旧竖表标题',
  modalHtml.indexOf('1. 寒春连报') < 0 && modalHtml.indexOf('合计（') < 0);
ok('单方案不加方案名前缀（列头就是「A 阶段(7次)」）',
  modalHtml.indexOf('寒春连报 · A 阶段(7次)') < 0);
ok('单方案显示单价列 + ✓ 单元格',
  modalHtml.indexOf('课时单价(元/次课)') >= 0 && modalHtml.indexOf('✓') >= 0);
ok('旧快照明细汇总行仍在同一张表内（colspan）',
  modalHtml.indexOf('colspan="') >= 0 && modalHtml.indexOf('课时费原价合计') >= 0);

/* 价目变了 → 明细仍按快照，但显示「价目已变更」 */
App.DB.cache.contract_prices[0].unit_price = 260;
const changedBack = Core.snapshotResult(REAL_ROW_2);
near('价目改动后：快照金额不变（仍 6200）', changedBack.payable, 6200);
eq('价目改动后：priceChanged 为 true', Core.priceChanged(REAL_ROW_2), true);
LAST_MODAL = null;
App.Contracts.openContractDetail(REAL_ROW_2);
ok('价目改动后：明细带「该价目已变更」chip',
  LAST_MODAL.body.innerHTML.indexOf('该价目已变更') >= 0);
App.DB.cache.contract_prices[0].unit_price = 240;
eq('价目改回后：priceChanged 恢复 false', Core.priceChanged(REAL_ROW_2), false);

/* 旧快照「修改」能把方案与科目回填进登记页 */
App.Contracts.loadContractForEdit(REAL_ROW_2);
eq('旧快照修改：回填 1 个方案', App.Contracts.state.entry.plans.length, 1);
eq('旧快照修改：方案名回填', App.Contracts.state.entry.plans[0].name, '寒春连报');
eq('旧快照修改：科目回填', App.Contracts.state.entry.plans[0].subjects.A.join(','), '数学');
eq('旧快照修改：结余回填 = 抵扣 + 剩余',
  App.Contracts.state.entry.balance, 0);
App.Contracts.state.editingId = null;

/* 多方案快照「修改」回填 */
App.Contracts.loadContractForEdit(multiRow);
eq('多方案快照修改：回填 2 个方案', App.Contracts.state.entry.plans.length, 2);
eq('多方案快照修改：方案二科目回填', App.Contracts.state.entry.plans[1].subjects.C.join(','), '物理');
eq('多方案快照修改：方案一优惠回填', App.Contracts.state.entry.plans[0].discount.type, 'amount');
eq('多方案快照修改：方案二优惠回填', App.Contracts.state.entry.plans[1].discount.type, 'pct');
App.Contracts.state.editingId = null;
App.Contracts.state.entry = { stu_name: '', grade: '', year: '', plans: [], balance: null };

/* --- 备注往返（等价于云端 remark 列 INSERT→SELECT） --- */
const snapWithRemark = Core.itemsSnapshot({
  year: 2026, grade: '高二', planName: '寒春连报', plan: PLAN_HC,
  subjects: { A: ['数学'], B: ['数学'] },
  discount: { type: 'none', value: 0 }, balance: 0,
  remark: '含 4 次晚辅'
}, null);
const remarkRow = {
  id: 81, stu_name: '备注测试', grade: '高二', year: 2026, plan: '寒春连报',
  items: snapWithRemark,
  original_amount: 6000, discount_type: 'none', discount_value: 0, discount_amount: 0,
  material_amount: 200, account_deduction: 0, payable_amount: 6200, balance_remain: 0
};
eq('备注往返：快照写入 plans[0].remark',
  snapWithRemark.plans[0].remark, '含 4 次晚辅');
LAST_MODAL = null;
LAST_MODAL_SHELL = null;
App.Contracts.openContractDetail(remarkRow);
ok('备注往返：明细单提示条显示「含 4 次晚辅」',
  LAST_MODAL.body.innerHTML.indexOf('📌 备注') >= 0 &&
  LAST_MODAL.body.innerHTML.indexOf('含 4 次晚辅') >= 0);
eq('明细弹窗加宽到 1120px', LAST_MODAL_SHELL.style.maxWidth, '1120px');
const noRemarkRow = JSON.parse(JSON.stringify(remarkRow));
noRemarkRow.id = 82;
noRemarkRow.items.plans[0].remark = '';
LAST_MODAL = null;
App.Contracts.openContractDetail(noRemarkRow);
ok('无备注时明细单不渲染提示条',
  LAST_MODAL.body.innerHTML.indexOf('ct-remark-tip') < 0 &&
  LAST_MODAL.body.innerHTML.indexOf('📌') < 0);

/* =========================================================
 * 12. T12：明细单合并成一张横表 + 备注提示条
 * ========================================================= */
console.log('\n=== 12. 明细单合并横表（T12）===');

/* --- 12.1 列模型：阶段列平铺所有方案 --- */
const mv = Core.detailPlanViews(multiRes);
eq('detailPlanViews：多方案 → 2 个方案视图', mv.length, 2);
eq('detailPlanViews：方案顺序 = 勾选顺序', mv.map(function (v) { return v.planName; }).join('+'), '寒春连报+暑期班');
const colMeta = Core.detailColumns(mv);
eq('列模型：阶段列平铺 = 3 列（A / B / C）', colMeta.cols.length, 3);
eq('列模型：列顺序 = 方案顺序 → 阶段 A→D',
  colMeta.cols.map(function (c) { return c.vi + ':' + c.stage; }).join(' '), '0:A 0:B 1:C');
eq('列模型：单价 240 / 200 不一致 → uniform=false', colMeta.uniform, false);

const samePriceRes = Core.priceContractMulti([
  { planName: '甲', plan: { unit_price: 240, stages: [{ stage: 'A', sessions: 7, material_fee: 100 }] },
    subjects: { A: ['数学'] }, discount: { type: 'none', value: 0 } },
  { planName: '乙', plan: { unit_price: 240, stages: [{ stage: 'C', sessions: 10, material_fee: 50 }] },
    subjects: { C: ['物理'] }, discount: { type: 'none', value: 0 } }
], 0);
eq('列模型：单价一致 → uniform=true',
  Core.detailColumns(Core.detailPlanViews(samePriceRes)).uniform, true);

/* --- 12.2 科目行：并集 + 同名合并 + 小计求和 --- */
const mergedRows = Core.detailSubjectRows(mv);
eq('科目行：数学 + 物理 = 2 行', mergedRows.length, 2);
near('科目行：数学小计 = 6000', mergedRows[0].amount, 6000);
ok('科目行：数学命中方案一的 A / B 两个阶段，不命中方案二的 C',
  mergedRows[0].hit['0|A'] === true && mergedRows[0].hit['0|B'] === true && !mergedRows[0].hit['1|C']);
eq('科目行：排序取首次出现序（数学在物理前）',
  mergedRows.map(function (r) { return r.subject; }).join(','), '数学,物理');

const sharedRes = Core.priceContractMulti([
  { planName: '甲', plan: { unit_price: 240, stages: [{ stage: 'A', sessions: 7, material_fee: 100 }] },
    subjects: { A: ['数学'] }, discount: { type: 'none', value: 0 } },
  { planName: '乙', plan: { unit_price: 200, stages: [{ stage: 'C', sessions: 10, material_fee: 50 }] },
    subjects: { C: ['数学'] }, discount: { type: 'none', value: 0 } }
], 0);
const sharedRows = Core.detailSubjectRows(Core.detailPlanViews(sharedRes));
eq('科目行：同名科目跨方案只占一行', sharedRows.length, 1);
near('科目行：合并后小计 = 1680 + 2000', sharedRows[0].amount, 3680);
ok('科目行：合并后两个方案的阶段都打上命中标记',
  sharedRows[0].hit['0|A'] === true && sharedRows[0].hit['1|C'] === true);

/* --- 12.3 优惠文案拼接 --- */
const bothAmount = Core.priceContractMulti([
  { planName: '甲', plan: { unit_price: 240, stages: [{ stage: 'A', sessions: 7, material_fee: 100 }] },
    subjects: { A: ['数学'] }, discount: { type: 'amount', value: 50 } },
  { planName: '乙', plan: { unit_price: 240, stages: [{ stage: 'C', sessions: 10, material_fee: 50 }] },
    subjects: { C: ['物理'] }, discount: { type: 'amount', value: 300 } }
], 0);
eq('优惠拼接：两方案同为减免 → 「减免 50 + 300 元」',
  Core.detailDiscountText(Core.detailPlanViews(bothAmount), bothAmount), '减免 50 + 300 元');
eq('优惠拼接：减免 + 折扣按方案顺序 → 「减免 300 元 + 85折」',
  Core.detailDiscountText(mv, multiRes), '减免 300 元 + 85折');
eq('优惠拼接：单方案沿用 discountText', Core.detailDiscountText(Core.detailPlanViews(r1), r1), '减免 300 元');

/* --- 12.4 多方案弹窗：一张表 + 汇总行在表内 --- */
LAST_MODAL = null;
LAST_MODAL_SHELL = null;
App.Contracts.openContractDetail(multiRow);
const mh = LAST_MODAL.body.innerHTML;
eq('多方案明细只渲染一张 table（合并视图）', countOf(mh, '<table'), 1);
ok('汇总行在同一张表内（colspan 跨掉非金额列）', countOf(mh, 'colspan="') >= 7);
ok('汇总顺序：原价 → 优惠 → 折后 → 资料费 → 小计 → 抵扣 → 应付',
  ['课时费原价合计', '优惠（', '折后课时费', '资料费合计', '>小计<', '应付金额']
    .map(function (k) { return mh.indexOf(k); })
    .every(function (v, i, arr) { return v >= 0 && (i === 0 || v > arr[i - 1]); }));
ok('应付金额行加粗 + 高亮底色',
  mh.indexOf('font-weight:700;font-size:13.5px') >= 0 && mh.indexOf('#e8f5ef') >= 0);
ok('表格外层是横向滚动容器（overflow-x:auto）',
  mh.indexOf('ct-detail-wrap') >= 0 && mh.indexOf('overflow-x:auto') >= 0);
ok('表头浅绿底 + 行分隔清晰',
  mh.indexOf('#eaf5ef') >= 0 && mh.indexOf('border-bottom:1px solid var(--line2,#eef3f1)') >= 0);
ok('表格 min-width 按列数自适应', /min-width:\d+px/.test(mh));
ok('方案小计行存在且按方案分组', mh.indexOf('方案小计') >= 0 &&
  mh.indexOf('寒春连报 5900.00') >= 0 && mh.indexOf('暑期班 1750.00') >= 0);

/* --- 12.5 结余抵扣行（合并表口径下复验）--- */
ok('无结余 → 合并表里没有「电子账户结余抵扣」行', mh.indexOf('电子账户结余抵扣') < 0);
const balRow2 = JSON.parse(JSON.stringify(multiRow));
balRow2.id = 83;
balRow2.account_deduction = 1000;
balRow2.payable_amount = 6650;
LAST_MODAL = null;
App.Contracts.openContractDetail(balRow2);
const bmh = LAST_MODAL.body.innerHTML;
ok('带结余 → 合并表出现抵扣行，应付 6650.00',
  bmh.indexOf('电子账户结余抵扣') >= 0 && bmh.indexOf('6650.00') >= 0);
ok('抵扣行排在应付行之前', bmh.indexOf('电子账户结余抵扣') < bmh.indexOf('应付金额'));

/* --- 12.6 备注提示条（快照路径）--- */
ok('快照明细带备注提示条（浅黄 + 标签 + 全文）',
  mh.indexOf('ct-remark-tip') >= 0 && mh.indexOf('#fff8e1') >= 0 &&
  mh.indexOf('📌 备注') >= 0 && mh.indexOf('含寒春两季') >= 0);
ok('T13：快照路径的提示条也在表格下方', mh.indexOf('<table') < mh.indexOf('ct-remark-tip'));
ok('多方案只有一方有备注 → 带方案名前缀', mh.indexOf('<b>寒春连报</b>：含寒春两季') >= 0);

/* --- 12.7 两种单价模式（表格层）--- */
ok('单价不一致的表格：无单价列、单元格是金额式',
  mh.indexOf('课时单价(元/次课)') < 0 && mh.indexOf('240.00×7=1680.00') >= 0);
const samePriceHtml = Core.detailTableHTML(samePriceRes);
ok('单价一致的表格：有单价列 + ✓ 单元格',
  samePriceHtml.indexOf('课时单价(元/次课)') >= 0 && samePriceHtml.indexOf('✓') >= 0 &&
  samePriceHtml.indexOf('元/科') < 0);

/* --- 12.8 远古 lines-only 快照也走合并表 --- */
LAST_MODAL = null;
App.Contracts.openContractDetail(legacyRow);
const lh = LAST_MODAL.body.innerHTML;
eq('lines-only 快照同样只有一张表', countOf(lh, '<table'), 1);
ok('lines-only 快照金额正确（应付 6200.00 + 单价 240.00）',
  lh.indexOf('6200.00') >= 0 && lh.indexOf('240.00') >= 0);
ok('lines-only 快照同样显示单价列 + ✓',
  lh.indexOf('课时单价(元/次课)') >= 0 && lh.indexOf('✓') >= 0);
ok('lines-only 快照没有备注提示条', lh.indexOf('ct-remark-tip') < 0);

/* --- 12.10 线上真实多方案合同（contracts id=5，用户用 T11 版登记的那一条）--- */
const REAL_ROW_5 = {
  id: 5, stu_name: '郭阳阳', grade: '高二', year: 2026, plan: '单寒假+寒春连报',
  items: {
    plan: null,
    lines: [
      { stage: 'A', amount: 1680, subject: '数学', material: 100, sessions: 7, unitPrice: 240 },
      { stage: 'A', amount: 1680, subject: '物理', material: 100, sessions: 7, unitPrice: 240 },
      { stage: 'B', amount: 4320, subject: '物理', material: 100, sessions: 18, unitPrice: 240 }
    ],
    plans: [
      {
        lines: [{ stage: 'A', amount: 1680, subject: '数学', material: 100, sessions: 7, unitPrice: 240 }],
        remark: '11月17号当天，在读生可享最高优惠报读',
        stages: [{ stage: 'A', sessions: 7, material_fee: 100 }],
        tuition: 1630, discount: { type: 'amount', value: 50 }, original: 1680,
        planName: '单寒假', subjects: { A: ['数学'] }, unit_price: 240,
        subjectRows: [{ amount: 1680, subject: '数学', stagesHit: { A: true }, sessionsTotal: 7 }],
        stageMaterial: [{ count: 1, stage: 'A', amount: 100, unitFee: 100 }],
        discountAmount: 50, materialAmount: 100
      },
      {
        lines: [
          { stage: 'A', amount: 1680, subject: '物理', material: 100, sessions: 7, unitPrice: 240 },
          { stage: 'B', amount: 4320, subject: '物理', material: 100, sessions: 18, unitPrice: 240 }
        ],
        remark: '11月17号当天，在读生可享最高优惠报读',
        stages: [{ stage: 'A', sessions: 7, material_fee: 100 }, { stage: 'B', sessions: 18, material_fee: 100 }],
        tuition: 5700, discount: { type: 'amount', value: 300 }, original: 6000,
        planName: '寒春连报', subjects: { A: ['物理'], B: ['物理'] }, unit_price: 240,
        subjectRows: [{ amount: 6000, subject: '物理', stagesHit: { A: true, B: true }, sessionsTotal: 25 }],
        stageMaterial: [
          { count: 1, stage: 'A', amount: 100, unitFee: 100 },
          { count: 1, stage: 'B', amount: 100, unitFee: 100 }
        ],
        discountAmount: 300, materialAmount: 200
      }
    ],
    stages: { A: ['数学', '物理'], B: ['物理'] },
    planName: '单寒假+寒春连报',
    subjectRows: [
      { amount: 1680, subject: '数学', stagesHit: { A: true }, sessionsTotal: 7 },
      { amount: 6000, subject: '物理', stagesHit: { A: true, B: true }, sessionsTotal: 25 }
    ],
    pricesVersion: '2026',
    stageMaterial: [
      { count: 2, stage: 'A', amount: 200, unitFee: 100 },
      { count: 1, stage: 'B', amount: 100, unitFee: 100 }
    ]
  },
  original_amount: '7680.00', discount_type: 'mixed', discount_value: '0.00',
  discount_amount: '350.00', material_amount: '300.00',
  account_deduction: '0.00', payable_amount: '7630.00', balance_remain: '0.00'
};
const real5 = Core.snapshotResult(REAL_ROW_5);
eq('线上 id=5：两个方案', real5.plans.length, 2);
near('线上 id=5：应付 7630', real5.payable, 7630);
const real5Cols = Core.detailColumns(Core.detailPlanViews(real5));
eq('线上 id=5：阶段列 3 个（两方案都含 A 阶段也不串列）', real5Cols.cols.length, 3);
eq('线上 id=5：列标识 = 方案下标 + 阶段',
  real5Cols.cols.map(function (c) { return c.vi + ':' + c.stage; }).join(' '), '0:A 1:A 1:B');
eq('线上 id=5：两方案单价都是 240 → uniform=true', real5Cols.uniform, true);
const real5Rows = Core.detailSubjectRows(Core.detailPlanViews(real5));
eq('线上 id=5：科目行 2 行（数学 / 物理）', real5Rows.length, 2);
near('线上 id=5：数学小计 1680', real5Rows[0].amount, 1680);
near('线上 id=5：物理小计 6000（寒春连报 A + B）', real5Rows[1].amount, 6000);
eq('线上 id=5：优惠文案「减免 50 + 300 元」', Core.detailDiscountText(Core.detailPlanViews(real5), real5), '减免 50 + 300 元');

LAST_MODAL = null;
App.Contracts.openContractDetail(REAL_ROW_5);
const r5h = LAST_MODAL.body.innerHTML;
eq('线上 id=5：明细只有一张表', countOf(r5h, '<table'), 1);
ok('线上 id=5：列头带各自方案名前缀（单寒假 · A / 寒春连报 · A / 寒春连报 · B）',
  r5h.indexOf('单寒假 · A 阶段(7次)') >= 0 &&
  r5h.indexOf('寒春连报 · A 阶段(7次)') >= 0 &&
  r5h.indexOf('寒春连报 · B 阶段(18次)') >= 0);
ok('线上 id=5：单价一致 → 单价列 + ✓', r5h.indexOf('课时单价(元/次课)') >= 0 && r5h.indexOf('✓') >= 0);
ok('线上 id=5：应付 7630.00 + 优惠 －350.00', r5h.indexOf('7630.00') >= 0 && r5h.indexOf('－350.00') >= 0);
ok('线上 id=5：两方案备注相同 → 提示条只出现一次',
  countOf(r5h, 'ct-remark-tip') === 1 && countOf(r5h, '11月17号当天，在读生可享最高优惠报读') === 1);

/* --- 12.9 两处入口共用同一套结构 + 旧竖表彻底移除 --- */
ok('登记页实时明细与台账弹窗共用同一套合并表结构',
  entryDetail.indexOf('ct-detail-table') >= 0 && mh.indexOf('ct-detail-table') >= 0 &&
  countOf(entryDetail, '<table') === 1 && countOf(mh, '<table') === 1);
const MOD_SRC = fs.readFileSync(path.join(SRC, 'module-contracts.js'), 'utf8');
ok('旧的竖表函数 planTableHTML / summaryTableHTML 已彻底移除',
  MOD_SRC.indexOf('function planTableHTML') < 0 && MOD_SRC.indexOf('function summaryTableHTML') < 0);

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
