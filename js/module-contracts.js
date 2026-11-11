/* =========================================================
 * 合同确认模块（PRD §3.6 · 计价口径 PRD §6.4 / ARCH §4.4）
 *
 * T9 价目方案化改造：价目从「年份 × 年级 × 阶段 × 连报方案」的细粒度行，
 * 改为**一个报读方案一行**（自定义方案名 + 阶段配置数组 + 方案级优惠 + 备注）。
 *
 * T11 多方案组合：一张合同可同时报**多个**方案，每个方案独立算金额与优惠，
 * 结余仍是整单一个。明细单去掉公式注释，只留数字与短标签。
 *
 * 三个 Tab：
 *   ① 合同登记：姓名 + 年级 + 年份 → 勾选报读方案（可多选，≥1）
 *                → 每个方案逐阶段选科目 → 每个方案各自的优惠（默认取预设，可覆盖）
 *                → 电子账户结余（整单一个）→ 优惠明细单（Excel 风格）
 *   ② 合同台账：筛选 + 明细复现（只读签订时快照，三格式兼容）+ 修改重算 + 删除
 *   ③ 价目维护：按 年份 → 年级 分组列方案；新增/编辑方案（阶段多行配置 + 方案优惠 + 备注 + 预览）
 *
 * 计价红线（PRD §6.4）：
 *   · 一切金额取整走 App.UI.round2（round half up），不得自行按小数位截断；
 *   · 折扣/减免**只作用于课时费**，一次性取整，资料费永不参与；
 *   · 单方案：单价 × 各阶段次数 × 该阶段科目数 + 资料费（按阶段分别收取）− 优惠；
 *   · 多方案：O=ΣO_p、D=ΣD_p、T=ΣT_p、M=ΣM_p、S=T+M，各方案优惠相互独立；
 *   · 结余抵扣 ≤ 小计，应付下限 0；结余剩余只提示，不落台账；无抵扣时该行不渲染。
 *
 * 纯函数外露（可测、不含 DOM）：
 *   App.ContractsCore = { priceContract, priceContractMulti, priceEntry, entryPlanList,
 *                         mergePlanViews, validatePlan, validateContract, findPlan,
 *                         plansFor, planSummary, planDiscountText, planLabel, planStageList,
 *                         stageOrder, priceYears, previewPlan, itemsSnapshot, snapshotResult,
 *                         discountText, dupContract, normalizePlan, normRate, parseRate,
 *                         discountInputError, DEFAULT_MATERIAL, YEAR_MIN, YEAR_MAX,
 *                         PLAN_NAME_MAX, REMARK_MAX }
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, Toast = App.Toast, Modal = App.Modal, UI = App.UI;

  /* 单季度单科目资料费默认值（可逐个方案、逐个阶段手动改；永不参与任何优惠） */
  var DEFAULT_MATERIAL = 100;

  /* 价目年份允许区间（与云端 CHECK 一致） */
  var YEAR_MIN = 2000;
  var YEAR_MAX = 2100;

  var STAGE_LIST = UI.STAGES;      // ['A','B','C','D']
  var DISCOUNT_TYPES = ['none', 'pct', 'amount'];
  var PLAN_NAME_MAX = 20;
  var REMARK_MAX = 200;            // T11：方案备注字数上限

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/>' +
    '<path d="M15 3v4h4"/><path d="M9 12h6M9 16h4"/></svg>';

  var TABS = [
    { id: 'entry', name: '① 合同登记' },
    { id: 'ledger', name: '② 合同台账' },
    { id: 'prices', name: '③ 价目维护' }
  ];

  /* =========================================================
   * 1. 模块状态
   * ========================================================= */

  /** 一个「已勾选的报读方案」的默认值（T11：合同可同时报多个方案） */
  function planEntryDefaults(row) {
    var p = normalizePlan(row || {});
    return {
      name: String((row && row.plan_name) || ''),
      /* discountTouched = 该方案的优惠被用户手动改过；未改过时跟随方案预设 */
      discount: { type: p.discount_type, value: p.discount_value },
      discountTouched: false,
      subjects: { A: [], B: [], C: [], D: [] }
    };
  }

  function entryDefaults() {
    return {
      stu_name: '',
      grade: '',
      year: '',
      /* plans = 已勾选的报读方案（按价目列表顺序），每项见 planEntryDefaults */
      plans: [],
      /* 电子账户结余是整单一个（不按方案分摊） */
      balance: null
    };
  }

  var state = {
    tab: 'entry',
    entry: entryDefaults(),
    editingId: null,                        // 非空 = 正在修改该合同（保存走 update）
    droppedPlans: [],                       // 修改合同时因价目消失而移除的方案名（提示用户重选）
    ledger: { kw: '', grade: '', year: '', plan: '', from: '', to: '' },
    priceYear: '',                          // 价目维护的年份筛选（'' = 全部）
    refocus: ''
  };

  function contractsTable() { return App.DB.table('contracts'); }
  function pricesTable() { return App.DB.table('contract_prices'); }

  function esc(s) { return U.esc(s); }
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function round2(n) { return UI.round2(n); }
  function money(n) { return UI.money(n); }
  /** 金额的「读起来顺」写法：整数不拖两位小数（300 → '300'，299.5 → '299.50'） */
  function moneyTrim(n) {
    var v = round2(num(n));
    return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : money(v);
  }

  function uniqList(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (v) {
      var s = String(v === null || v === undefined ? '' : v).trim();
      if (!s || seen[s]) return;
      seen[s] = true;
      out.push(s);
    });
    return out;
  }

  function clampInt(v, lo, hi, dft) {
    var n = Math.round(num(v));
    if (!isFinite(n)) return dft;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /** 阶段排序权重（A → 0 … D → 3；非法值排最后） */
  function stageOrder(stage) {
    var i = STAGE_LIST.indexOf(String(stage || ''));
    return i < 0 ? 99 : i;
  }

  /**
   * 折扣输入 → 折扣系数（严格版，供校验使用）。
   *
   * 用户两种写法都认：`0.85`（系数）与 `85`（百分数，即 85 折）。判定规则：
   *   · 值 ≤ 1  → 视为系数写法，必须 > 0；
   *   · 值 > 1  → 视为百分数写法，必须是 1–100 之间的**整数**（85折 / 88折）。
   * 其余一律非法。
   *
   * 之所以百分数写法要求整数：`1.5` 这类值两种解释都成立（1.5 折还是 1.5%），
   * 与其猜，不如拒绝并要求用户写成 `0.15` 或 `15`。校验必须走这个函数，
   * 不能用下面的 normRate —— 那是有兜底的展示用归一层，会把非法值抹成 1。
   *
   * @param {*} v 原始输入（数字或数字字符串）
   * @returns {number} 折扣系数（0,1]；非法返回 NaN
   */
  function parseRate(v) {
    var k = Number(v);
    if (!isFinite(k) || !(k > 0)) return NaN;
    if (k <= 1) return k;
    if (k > 100) return NaN;
    if (Math.round(k) !== k) return NaN;
    return k / 100;
  }

  /** 折扣系数归一（展示/计价用）：0.85 与 85 等价；非法值退化为 1（不打折） */
  function normRate(v) {
    var k = parseRate(v);
    return isNaN(k) ? 1 : k;
  }

  function updatedTime(row) {
    var t = Date.parse((row && row.updated_at) || '');
    return isNaN(t) ? 0 : t;
  }

  function idNumber(row) {
    var n = Number(row && row.id);
    return isFinite(n) ? n : 0;
  }

  /* =========================================================
   * 2. 纯函数：方案（价目）归一与查询
   * ========================================================= */

  /**
   * 把「云端行 / 表单值 / 已归一对象」统一成规范结构。
   * stages 在云端是 jsonb（PostgREST 已解析成数组），这里再做一次防御性归一：
   * 阶段按 A→D 排序、次数取整数并夹在 1–200、资料费非负。
   * @returns {{unit_price:number, stages:Array<{stage:string,sessions:number,material_fee:number}>,
   *            discount_type:string, discount_value:number}}
   */
  function normalizePlan(src) {
    var s = src || {};
    var list = [];
    var seen = {};
    var raw = s.stages;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (e) { raw = []; }
    }
    (Array.isArray(raw) ? raw : []).forEach(function (x) {
      var st = String((x && x.stage) || '').toUpperCase();
      if (STAGE_LIST.indexOf(st) < 0 || seen[st]) return;
      seen[st] = true;
      list.push({
        stage: st,
        sessions: clampInt(x && x.sessions, 1, 200, 1),
        material_fee: round2(Math.max(0, num(x && x.material_fee)))
      });
    });
    list.sort(function (a, b) { return stageOrder(a.stage) - stageOrder(b.stage); });

    var dt = String(s.discount_type || 'none');
    if (DISCOUNT_TYPES.indexOf(dt) < 0) dt = 'none';
    var dv = num(s.discount_value);
    if (dt === 'pct') dv = normRate(dv);
    else if (dt === 'amount') dv = round2(Math.max(0, dv));
    else dv = 0;

    return {
      unit_price: round2(Math.max(0, num(s.unit_price))),
      stages: list,
      discount_type: dt,
      discount_value: dv
    };
  }

  /** 方案的阶段列表（A→D 顺序） */
  function planStageList(plan) {
    return normalizePlan(plan).stages.map(function (s) { return s.stage; });
  }

  /** 兼容旧名：planStages(plan) → ['A','B'] */
  function planStages(plan) { return planStageList(plan); }

  /** 阶段组合摘要：'A 7次 + B 18次' */
  function planSummary(plan) {
    var list = normalizePlan(plan).stages;
    if (!list.length) return '未配置阶段';
    return list.map(function (s) { return s.stage + ' ' + s.sessions + '次'; }).join(' + ');
  }

  /** 方案优惠摘要：'85折' / '减300元' / '无优惠' */
  function planDiscountText(plan) {
    var p = normalizePlan(plan);
    if (p.discount_type === 'pct') {
      var k = normRate(p.discount_value);
      var pct = Math.round(k * 1000) / 10;
      return (pct % 10 === 0 ? String(pct / 10) : String(pct)) + '折';
    }
    if (p.discount_type === 'amount') return '减' + moneyTrim(p.discount_value) + '元';
    return '无优惠';
  }

  /** 下拉展示用的完整标签：'寒春连报（A 7次 + B 18次 · 240元/科 · 85折）' */
  function planLabel(row) {
    var r = row || {};
    var name = String(r.plan_name || '');
    var p = normalizePlan(r);
    return name + '（' + planSummary(p) + ' · ' + money(p.unit_price) + '元/科 · ' +
      planDiscountText(p) + '）';
  }

  /** 价目里已存在的年份（升序去重，数字） */
  function priceYears(prices) {
    var seen = {}, out = [];
    (prices || []).forEach(function (p) {
      var y = num(p && p.year);
      if (!y || seen[y]) return;
      seen[y] = true;
      out.push(y);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  /** 某年份 + 年级下的全部方案（按方案名称中文排序） */
  function plansFor(prices, year, grade) {
    var y = num(year);
    var g = String(grade === null || grade === undefined ? '' : grade);
    return (prices || []).filter(function (p) {
      return num(p && p.year) === y && String((p && p.grade) || '') === g;
    }).sort(function (a, b) {
      return U.zh(String(a.plan_name || ''), String(b.plan_name || '')) ||
        (idNumber(b) - idNumber(a));
    });
  }

  /**
   * 按「年份 + 年级 + 方案名称」命中一个方案行。
   * 云端有 uk_prices_key 兜底，缓存里仍可能出现短暂重复行（并发写入中间态）：
   * 按「updated_at 较新者优先，同刻取 id 较大者」确定性选择。
   */
  function findPlan(prices, year, grade, planName) {
    var y = num(year);
    var g = String(grade === null || grade === undefined ? '' : grade);
    var n = String(planName === null || planName === undefined ? '' : planName).trim();
    var hit = null;
    (prices || []).forEach(function (p) {
      if (!p) return;
      if (num(p.year) !== y) return;
      if (String(p.grade || '') !== g) return;
      if (String(p.plan_name || '') !== n) return;
      if (!hit) { hit = p; return; }
      var tNew = updatedTime(p), tOld = updatedTime(hit);
      if (tNew > tOld || (tNew === tOld && idNumber(p) > idNumber(hit))) hit = p;
    });
    return hit;
  }

  /* =========================================================
   * 3. 纯函数：计价（PRD §6.4 · T9 公式）
   * ========================================================= */

  /**
   * 优惠解析：input.discount 给了就用它（用户覆盖），没给就用方案预设。
   * @returns {{type:string, value:number}}
   */
  function resolveDiscount(discount, plan) {
    var src = discount || {};
    var p = normalizePlan(plan);
    var given = (src.type !== undefined && src.type !== null && String(src.type) !== '');
    var type = String(given ? src.type : (p.discount_type || 'none'));
    if (DISCOUNT_TYPES.indexOf(type) < 0) type = 'none';
    var rawVal = (src.value === undefined || src.value === null || src.value === '')
      ? p.discount_value
      : num(src.value);
    var value = 0;
    if (type === 'pct') {
      value = normRate(rawVal);
      if (!(value > 0) || value > 1) value = 1;
    } else if (type === 'amount') {
      value = round2(Math.max(0, num(rawVal)));
    }
    return { type: type, value: value };
  }

  /**
   * 合同计价（唯一入口）。
   *
   * 公式（用户口径）：
   *   报读费用 = 课时单价 × 各阶段次数 × 该阶段科目数 + 资料费（按阶段分别收取）− 优惠
   *   当各阶段科目数相同时，等价于 课时单价 × (Σ阶段次数) × 科目数 + 资料费 − 优惠。
   *
   * @param {Object} input
   *   { year, grade, planName, plan:{unit_price,stages:[{stage,sessions,material_fee}],
   *     discount_type,discount_value}, subjects:{A:['数学'],B:[…]},
   *     discount:{type:'none'|'pct'|'amount', value}, balance }
   * @returns {{
   *   subjectRows: Array<{subject, stagesHit:Object, sessionsTotal:number, amount:number}>,
   *   stageMaterial: Array<{stage, unitFee:number, count:number, amount:number}>,
   *   missing: Array, stageList: Array, planName:string,
   *   original:number, discountAmount:number, tuition:number, materialAmount:number,
   *   subtotal:number, deduction:number, payable:number, balanceLeft:number,
   *   discountType:string, discountValue:number, subjectCount:number, ok:boolean
   * }}
   */
  function priceContract(input) {
    var i = input || {};
    var plan = normalizePlan(i.plan);
    var stageList = plan.stages;
    var sel = i.subjects || {};
    var up = round2(num(plan.unit_price));
    var disc = resolveDiscount(i.discount, plan);

    /* 各阶段的已选科目 */
    var stageSubs = {};
    stageList.forEach(function (s) {
      stageSubs[s.stage] = uniqList(sel[s.stage] || []);
    });

    /* 科目行：跨阶段合并成一行（用户公式 240×(7+18) 的来源） */
    var order = [], hitMap = {};
    stageList.forEach(function (s) {
      stageSubs[s.stage].forEach(function (sub) {
        if (!hitMap[sub]) { hitMap[sub] = {}; order.push(sub); }
        hitMap[sub][s.stage] = true;
      });
    });

    var subjectRows = order.map(function (sub) {
      var sessions = 0, missingStage = false;
      stageList.forEach(function (s) {
        if (hitMap[sub][s.stage]) sessions += s.sessions;
      });
      if (!(up > 0) || !sessions) missingStage = true;
      return {
        subject: sub,
        stagesHit: hitMap[sub],
        sessionsTotal: sessions,
        amount: missingStage ? 0 : round2(up * sessions)
      };
    });

    /* O（课时费原价）、M（资料费）、按阶段的资料费明细 */
    var original = 0, materialAmount = 0, stageMaterial = [];
    stageList.forEach(function (s) {
      var count = stageSubs[s.stage].length;
      var fee = round2(num(s.material_fee));
      original += up * s.sessions * count;
      var m = round2(fee * count);
      materialAmount += m;
      stageMaterial.push({ stage: s.stage, unitFee: fee, count: count, amount: m });
    });
    original = round2(original);
    materialAmount = round2(materialAmount);

    /* 优惠只作用课时费，一次性取整（不逐科取整） */
    var tuition, discountAmount;
    if (disc.type === 'pct') {
      tuition = round2(original * disc.value);
    } else if (disc.type === 'amount') {
      var off = Math.min(disc.value, original);      // 减免超 O → 截断为 O
      tuition = round2(Math.max(0, original - off));
    } else {
      tuition = round2(original);
    }
    discountAmount = round2(original - tuition);

    var subtotal = round2(tuition + materialAmount);

    var balance = num(i.balance);
    if (balance < 0) balance = 0;                    // 结余不得为负
    var deduction = round2(Math.min(balance, subtotal));   // 抵扣 ≤ 小计
    var payable = round2(subtotal - deduction);            // 下限 0，不出负数
    var balanceLeft = round2(balance - deduction);         // 仅提示，不落台账

    var stageOk = stageList.length > 0 && up > 0 &&
      stageList.every(function (s) { return stageSubs[s.stage].length > 0; });

    return {
      year: i.year,
      grade: i.grade === null || i.grade === undefined ? '' : String(i.grade),
      planName: String(i.planName || i.plan_name || ''),
      unitPrice: up,
      stageList: stageList.slice(),
      subjectRows: subjectRows,
      stageMaterial: stageMaterial,
      /* 保留字段：T9 后「缺价」不再是行级概念（选到方案即价目存在），恒为空数组 */
      missing: [],
      subjectCount: subjectRows.length,
      original: original,
      discountAmount: discountAmount,
      tuition: tuition,
      materialAmount: materialAmount,
      subtotal: subtotal,
      deduction: deduction,
      payable: payable,
      balanceLeft: balanceLeft,
      discountType: disc.type,
      discountValue: disc.value,
      ok: stageOk
    };
  }

  /* ------------------------------------------------------------------
   * 多方案聚合（T11）
   *
   * 一张合同可以同时报多个报读方案（如「寒春连报」+「暑期班」）。
   * 每个方案**独立**算 O_p → 优惠_p（只作用该方案自己的课时费）→ T_p → M_p，
   * 方案之间互不影响；最后逐项求和得到整单金额。
   * 电子账户结余是**整单一个**，只在聚合层做一次抵扣，不按方案分摊。
   * ------------------------------------------------------------------ */

  /**
   * 归一「合同报读方案列表」。
   *
   * 兼容两种入参：`{plans:[…]}`（T11 多方案）与单方案平铺写法
   * `{planName, plan, subjects, discount}`（价目弹窗预览、老测试、老报表都在用）。
   * 只给了空列表时返回一条空名称记录，让 validateContract 统一报「请选择报读方案」。
   *
   * @param {Object} input
   * @returns {Array<{planName:string, plan:Object|null, subjects:Object, discount:*, remark:string}>}
   */
  function entryPlanList(input) {
    var i = input || {};
    var out = [];
    if (Array.isArray(i.plans)) {
      i.plans.forEach(function (p) {
        var x = p || {};
        out.push({
          planName: String(x.planName || x.plan_name || x.name || '').trim(),
          plan: x.plan || null,
          subjects: x.subjects || {},
          discount: x.discount,
          remark: String(x.remark || '')
        });
      });
    }
    if (out.length) return out;
    return [{
      planName: String(i.planName || i.plan_name || '').trim(),
      plan: i.plan || null,
      subjects: i.subjects || {},
      discount: i.discount,
      remark: String(i.remark || '')
    }];
  }

  /**
   * 多方案计价（T11 聚合入口；单方案版 priceContract 保留给价目预览）。
   *
   *   O = ΣO_p、D = ΣD_p、T = ΣT_p、M = ΣM_p、S = T + M
   *   C = min(结余, S)、P = S − C、R = 结余 − C    （结余整单一个，不按方案分摊）
   *
   * @param {Array} plans [{planName, plan, subjects, discount, remark}]
   * @param {number} balance 整单电子账户结余
   * @returns {Object} 与 priceContract 同构，另加 plans[] / planNames / multi
   */
  function priceContractMulti(plans, balance) {
    var list = [];
    (plans || []).forEach(function (p) {
      var x = p || {};
      var name = String(x.planName || x.plan_name || x.name || '');
      var one = priceContract({
        year: x.year,
        grade: x.grade,
        planName: name,
        plan: x.plan || null,
        subjects: x.subjects || {},
        discount: x.discount,
        balance: 0                       // 结余只在整单层面抵一次
      });
      one.planName = name;
      one.remark = String(x.remark || '');
      list.push(one);
    });

    var original = 0, discountAmount = 0, tuition = 0, materialAmount = 0, subjectCount = 0;
    list.forEach(function (r) {
      original += num(r.original);
      discountAmount += num(r.discountAmount);
      tuition += num(r.tuition);
      materialAmount += num(r.materialAmount);
      subjectCount += num(r.subjectCount);
    });
    original = round2(original);
    discountAmount = round2(discountAmount);
    tuition = round2(tuition);
    materialAmount = round2(materialAmount);

    var subtotal = round2(tuition + materialAmount);
    var b = num(balance);
    if (b < 0) b = 0;                                  // 结余不得为负
    var deduction = round2(Math.min(b, subtotal));     // 抵扣 ≤ 小计
    var payable = round2(subtotal - deduction);        // 下限 0
    var balanceLeft = round2(b - deduction);           // 仅提示，不落台账

    /* 整单优惠「类型」：所有方案一致 → 沿用；多种并存 → 'mixed'（明细单逐方案展示） */
    var sigs = [];
    list.forEach(function (r) {
      var sig = String(r.discountType || 'none') + ':' + round2(num(r.discountValue));
      if (sigs.indexOf(sig) < 0) sigs.push(sig);
    });
    var discountType = 'none', discountValue = 0;
    if (sigs.length === 1 && list.length) {
      discountType = String(list[0].discountType || 'none');
      discountValue = num(list[0].discountValue);
    } else if (sigs.length > 1) {
      discountType = 'mixed';
      discountValue = 0;
    }

    return {
      plans: list,
      planNames: list.map(function (r) { return r.planName; }),
      planName: list.map(function (r) { return r.planName; }).join('+'),
      stageList: [],
      subjectRows: [],
      missing: [],
      subjectCount: subjectCount,
      original: original,
      discountAmount: discountAmount,
      tuition: tuition,
      materialAmount: materialAmount,
      subtotal: subtotal,
      deduction: deduction,
      payable: payable,
      balanceLeft: balanceLeft,
      discountType: discountType,
      discountValue: discountValue,
      ok: list.length > 0 && list.every(function (r) { return r.ok; }),
      multi: list.length > 1
    };
  }

  /**
   * 统一计价入口：input 带 `plans` 数组走多方案聚合，否则走单方案 priceContract。
   * 渲染层只认这一个入口，避免两条路径算出的金额不一致。
   */
  function priceEntry(input) {
    var i = input || {};
    if (Array.isArray(i.plans)) return priceContractMulti(entryPlanList(i), i.balance);
    return priceContract(i);
  }

  /**
   * 把多个方案的科目行 / 资料费明细合并成一份视图（台账列、老渲染路径用）。
   * @returns {{subjectRows:Array, stageMaterial:Array, subjectCount:number}}
   */
  function mergePlanViews(list) {
    var subMap = {}, subOrder = [], matMap = {}, matOrder = [];
    (list || []).forEach(function (p) {
      (p.subjectRows || []).forEach(function (x) {
        var key = String(x.subject || '');
        if (!subMap[key]) {
          subMap[key] = { subject: key, stagesHit: {}, sessionsTotal: 0, amount: 0 };
          subOrder.push(key);
        }
        var hit = subMap[key];
        Object.keys(x.stagesHit || {}).forEach(function (k) { hit.stagesHit[k] = true; });
        hit.sessionsTotal += Math.round(num(x.sessionsTotal));
        hit.amount = round2(hit.amount + num(x.amount));
      });
      (p.stageMaterial || []).forEach(function (m) {
        var key = String(m.stage || '') + '|' + round2(num(m.unitFee));
        if (!matMap[key]) {
          matMap[key] = { stage: String(m.stage || ''), unitFee: round2(num(m.unitFee)), count: 0, amount: 0 };
          matOrder.push(key);
        }
        matMap[key].count += Math.round(num(m.count));
        matMap[key].amount = round2(matMap[key].amount + num(m.amount));
      });
    });
    return {
      subjectRows: subOrder.map(function (k) { return subMap[k]; }),
      stageMaterial: matOrder.map(function (k) { return matMap[k]; }),
      subjectCount: subOrder.length
    };
  }

  /**
   * 方案录入时的预览：假设每个阶段各报 1 科，套用方案自身的优惠。
   * 仅用于管理员录价目时核对，不参与合同落库。
   * @returns {{original:number, discountAmount:number, tuition:number,
   *            materialAmount:number, payable:number, formula:string}}
   */
  function previewPlan(plan) {
    var p = normalizePlan(plan);
    var one = {};
    p.stages.forEach(function (s) { one[s.stage] = ['示例科目']; });
    var r = priceContract({
      year: '', grade: '', planName: '', plan: p, subjects: one, discount: null, balance: 0
    });
    var sessions = p.stages.reduce(function (a, s) { return a + s.sessions; }, 0);
    var formula = '课时费 ' + money(p.unit_price) + ' × ' + sessions + ' 次 × 1 科 = ' +
      money(r.original) + '；资料费 ' + money(r.materialAmount) +
      (r.discountAmount > 0 ? '；优惠 − ' + money(r.discountAmount) : '；无优惠');
    return {
      original: r.original,
      discountAmount: r.discountAmount,
      tuition: r.tuition,
      materialAmount: r.materialAmount,
      payable: r.payable,
      formula: formula
    };
  }

  /** 折扣展示文案（明细单与台账共用；入参是 priceContract / snapshotResult 的结果） */
  function discountText(res) {
    var r = res || {};
    var t = r.discountType || 'none';
    if (t === 'mixed') return '多方案优惠';      // T11：各方案优惠不同，逐方案展示
    if (t === 'pct') {
      var k = normRate(r.discountValue);
      var pct = Math.round(k * 1000) / 10;
      return (pct % 10 === 0 ? String(pct / 10) : String(pct)) + '折';
    }
    if (t === 'amount') {
      return num(r.discountValue) > 0 ? '减免 ' + moneyTrim(num(r.discountValue)) + ' 元' : '无优惠';
    }
    return '无优惠';
  }

  /* =========================================================
   * 4. 纯函数：校验
   * ========================================================= */

  /**
   * 价目方案校验（PRD §3.6.1 字段表）。
   * @param {Object} f {year, grade, plan_name, unit_price, stages:[{stage,sessions,material_fee}],
   *                    discount_type, discount_value}
   * @param {Array} prices 全部方案（唯一键查重）
   * @param {*} exceptId 编辑时排除自身
   * @returns {string} '' = 通过
   */
  function validatePlan(f, prices, exceptId) {
    var p = f || {};

    var y = Number(p.year);
    if (!isFinite(y) || Math.round(y) !== y) return '年份必须是整数';
    if (y < YEAR_MIN || y > YEAR_MAX) return '年份需在 ' + YEAR_MIN + '–' + YEAR_MAX + ' 之间';

    if (UI.GRADES.indexOf(String(p.grade || '')) < 0) return '请选择年级';

    var name = String(p.plan_name === null || p.plan_name === undefined ? '' : p.plan_name).trim();
    if (!name) return '请填写方案名称';
    if (name.length > PLAN_NAME_MAX) return '方案名称不能超过 ' + PLAN_NAME_MAX + ' 个字';

    /* T11：方案备注（选填，≤200 字）。只做长度校验，内容不限。 */
    var remark = String(p.remark === null || p.remark === undefined ? '' : p.remark).trim();
    if (remark.length > REMARK_MAX) return '备注不能超过 ' + REMARK_MAX + ' 个字';

    var up = Number(p.unit_price);
    if (!isFinite(up) || up <= 0) return '课时费原价必须大于 0';
    if (up > 100000) return '课时费原价过大，请核对';

    /* 阶段配置 */
    var raw = p.stages;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (e) { raw = []; }
    }
    if (!Array.isArray(raw) || !raw.length) return '至少配置 1 个阶段';
    var seen = {};
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i] || {};
      var st = String(s.stage || '').toUpperCase();
      if (STAGE_LIST.indexOf(st) < 0) return '第 ' + (i + 1) + ' 行：请选择阶段';
      if (seen[st]) return st + ' 阶段重复配置，请合并为一行';
      seen[st] = true;
      var sn = Number(s.sessions);
      if (!isFinite(sn) || Math.round(sn) !== sn) return st + ' 阶段：上课次数必须是整数';
      if (sn < 1 || sn > 200) return st + ' 阶段：上课次数需在 1–200 之间';
      var mf = Number(s.material_fee);
      if (s.material_fee === null || s.material_fee === undefined || s.material_fee === '' ||
        !isFinite(mf)) {
        return st + ' 阶段：请填写资料费（不收取请填 0）';
      }
      if (mf < 0) return st + ' 阶段：资料费不能为负数';
      if (mf > 100000) return st + ' 阶段：资料费过大，请核对';
    }

    /* 方案优惠 */
    var dt = String(p.discount_type || 'none');
    if (DISCOUNT_TYPES.indexOf(dt) < 0) return '请选择报读优惠类型';
    var dv = Number(p.discount_value);
    if (dt === 'pct') {
      /* 必须校验**原始值**：若先经 normRate 归一，0 与 101 都会被抹成 1（不打折），
         校验会永久失效 */
      if (isNaN(parseRate(p.discount_value))) {
        return '折扣需在 1–100 之间（如 85 表示 85 折）';
      }
    } else if (dt === 'amount') {
      if (!isFinite(dv)) return '减免金额必须大于 0';
      if (dv <= 0) return '减免金额必须大于 0';
      if (dv > 100000) return '减免金额过大，请核对';
    } else {
      dv = 0;
    }

    var dup = findPlan(prices, y, p.grade, name);
    if (dup && !(exceptId !== null && exceptId !== undefined && String(dup.id) === String(exceptId))) {
      return '该年份年级下已有同名方案';
    }
    return '';
  }

  /** 合同唯一键（学生姓名 + 年级）命中行 */
  function dupContract(name, grade, contracts, exceptId) {
    var n = String(name === null || name === undefined ? '' : name).trim();
    var g = String(grade === null || grade === undefined ? '' : grade);
    if (!n) return null;
    var list = contracts || [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i] || {};
      if (String(row.stu_name || '').trim() !== n) continue;
      if (String(row.grade || '') !== g) continue;
      if (exceptId !== null && exceptId !== undefined && String(row.id) === String(exceptId)) continue;
      return row;
    }
    return null;
  }

  /**
   * 用户手动覆盖的优惠是否合法（没覆盖 → 返回 ''，沿用方案预设即可）。
   *
   * 关键：必须校验**原始输入**。`resolveDiscount` 会把非法值兜底成 1（不打折）或 0，
   * 若拿兜底后的值再判断，0 / 101 / 负数全部会被放行，校验形同虚设。
   *
   * @param {{type?:string,value?:*}} discount
   * @returns {string} '' = 合法
   */
  function discountInputError(discount) {
    var d = discount || {};
    var given = (d.type !== undefined && d.type !== null && String(d.type) !== '');
    if (!given) return '';
    var t = String(d.type);
    if (t === 'pct') {
      if (isNaN(parseRate(d.value))) return '折扣需在 1–100 之间（如 85 表示 85 折）';
    } else if (t === 'amount') {
      var v = Number(d.value);
      if (!isFinite(v)) return '优惠金额必须大于 0';
      if (v < 0) return '优惠金额不能为负数';
      if (v === 0) return '优惠金额必须大于 0';
    }
    return '';
  }

  /**
   * 合同提交校验（PRD §3.6.2 全部前置条件）。
   *
   * T11：支持一张合同报多个方案。入参可给 `plans:[…]`（多方案），也可给单方案平铺写法
   * `{planName, subjects, discount}`（价目预览 / 老调用方）。两种写法共用同一套逐方案判据，
   * 避免「多方案另写一份校验」导致两条路径的报错口径分叉。
   * 多方案时错误文案加「方案「X」：」前缀，用户才知道是哪一个方案填错了。
   *
   * @param {Object} input 同 priceContract 的 input（或带 plans 数组）
   * @param {Array} prices 全部方案（方案是否存在 / 是否选到）
   * @param {{contracts?:Array, exceptId?:*}} [opt]
   * @returns {string} '' = 通过
   */
  function validateContract(input, prices, opt) {
    var i = input || {};
    var o = opt || {};

    var name = String(i.stu_name === null || i.stu_name === undefined ? '' : i.stu_name).trim();
    if (!name) return '学生姓名不能为空';
    if (name.length > 20) return '学生姓名不能超过 20 个字';

    if (UI.GRADES.indexOf(String(i.grade || '')) < 0) return '请选择合同年级';

    var year = Number(i.year);
    if (!isFinite(year) || !year) return '请选择合同年份';

    /* --- 报读方案：至少选 1 个，且不能重复 --- */
    var list = entryPlanList(i);
    var pickedNames = [];
    var seenName = {};
    for (var n = 0; n < list.length; n++) {
      var pn = String(list[n].planName || '').trim();
      if (!pn) continue;
      if (seenName[pn]) return '方案「' + pn + '」重复选择，请合并为一次';
      seenName[pn] = true;
      pickedNames.push(pn);
    }
    if (!pickedNames.length) return '请选择报读方案';

    for (var x = 0; x < list.length; x++) {
      var p = list[x];
      if (!p.planName) continue;
      var tag = list.length > 1 ? '方案「' + p.planName + '」：' : '';

      var row = findPlan(prices, year, i.grade, p.planName);
      var plan = normalizePlan(p.plan && normalizePlan(p.plan).stages.length ? p.plan : row);
      if (!plan.stages.length) {
        return '该年份年级还没有价目方案，请先到『价目维护』新增';
      }
      if (!(plan.unit_price > 0)) return tag + '该方案的课时费原价无效，请到『价目维护』核对';

      /* 每个阶段都必须至少选 1 科（方案定义了报读哪几个阶段） */
      var sel = p.subjects || {};
      var picked = 0;
      for (var k = 0; k < plan.stages.length; k++) {
        var st = plan.stages[k].stage;
        var cnt = uniqList(sel[st] || []).length;
        picked += cnt;
        if (!cnt) return tag + st + ' 阶段至少选择 1 科';
      }
      /* 不允许选到方案之外的阶段 */
      var allow = plan.stages.map(function (s) { return s.stage; });
      var extra = [];
      STAGE_LIST.forEach(function (s2) {
        if (allow.indexOf(s2) < 0 && uniqList(sel[s2] || []).length) extra.push(s2);
      });
      if (extra.length) {
        return tag + '该方案只包含 ' + allow.join(' / ') + ' 阶段，请清空 ' +
          extra.join(' / ') + ' 阶段科目';
      }
      if (!picked) return tag + '请至少选择一个阶段科目';

      /* 优惠：用户手动覆盖时才校验（未覆盖则沿用方案预设，方案已由 validatePlan 保证合法） */
      var derr = discountInputError(p.discount);
      if (derr) return tag + derr;
      var d = resolveDiscount(p.discount, plan);
      if (d.type === 'pct' && (!(d.value > 0) || d.value > 1)) return tag + '折扣需在 1–100 之间';
      if (d.type === 'amount' && num(d.value) < 0) return tag + '优惠金额不能为负数';
    }

    var bal = i.balance;
    if (bal !== null && bal !== undefined && bal !== '' && Number(bal) < 0) {
      return '电子账户结余不能为负数';
    }

    if (o.contracts) {
      var dup = dupContract(name, i.grade, o.contracts, o.exceptId);
      if (dup) return '该学生在' + i.grade + '已有合同，请直接修改';
    }
    return '';
  }

  /* =========================================================
   * 5. 纯函数：明细快照
   * ========================================================= */

  /* --- 快照里三种形状共用的归一辅助 --- */

  /** 快照里的一条「阶段 × 科目」明细行 */
  function normLine(l) {
    var x = l || {};
    return {
      stage: String(x.stage || ''),
      subject: String(x.subject || ''),
      unitPrice: (x.unitPrice === null || x.unitPrice === undefined) ? null : round2(num(x.unitPrice)),
      sessions: (x.sessions === null || x.sessions === undefined) ? null : Math.round(num(x.sessions)),
      amount: round2(num(x.amount)),
      material: round2(num(x.material))
    };
  }

  /** 科目行：优先用快照里的 subjectRows；没有就从 lines 现推（lines-only 老快照） */
  function normSubjectRows(raw, lines) {
    var rows = (raw || []).map(function (x) {
      return {
        subject: String((x && x.subject) || ''),
        stagesHit: (x && x.stagesHit) || {},
        sessionsTotal: Math.round(num(x && x.sessionsTotal)),
        amount: round2(num(x && x.amount))
      };
    });
    if (rows.length) return rows;
    var map = {}, order = [];
    (lines || []).forEach(function (l) {
      if (!map[l.subject]) {
        map[l.subject] = { subject: l.subject, stagesHit: {}, sessionsTotal: 0, amount: 0 };
        order.push(l.subject);
      }
      map[l.subject].stagesHit[l.stage] = true;
      map[l.subject].sessionsTotal += Math.round(num(l.sessions));
      map[l.subject].amount = round2(map[l.subject].amount + num(l.amount));
    });
    return order.map(function (k) { return map[k]; });
  }

  /** 阶段资料费明细：优先用快照；没有就按方案阶段配置 × lines 里的科目数现推 */
  function normStageMaterial(raw, plan, lines) {
    var list = (raw || []).map(function (m) {
      return {
        stage: String((m && m.stage) || ''),
        unitFee: round2(num(m && m.unitFee)),
        count: Math.round(num(m && m.count)),
        amount: round2(num(m && m.amount))
      };
    });
    if (list.length) return list;
    (plan && plan.stages ? plan.stages : []).forEach(function (s) {
      var count = 0;
      (lines || []).forEach(function (l) { if (l.stage === s.stage) count++; });
      list.push({
        stage: s.stage, unitFee: round2(s.material_fee),
        count: count, amount: round2(s.material_fee * count)
      });
    });
    return list;
  }

  /**
   * 合同明细快照（落 `contracts.items` jsonb）。
   *
   * T11 新格式（多方案）：
   *   {
   *     plans: [{
   *       planName, unit_price, stages:[{stage,sessions,material_fee}], subjects:{A:[科目]},
   *       discount:{type,value}, lines:[…], subjectRows:[…], stageMaterial:[…],
   *       original, discountAmount, tuition, materialAmount, remark
   *     }],
   *     pricesVersion:'2026'
   *   }
   *
   * 同时保留 T9 的平铺冗余字段（planName / plan / stages / lines / subjectRows /
   * stageMaterial）：台账旧渲染路径与老快照共用一套读取代码，单方案时两者完全等价。
   * —— 价目日后被改 / 被删，台账仍能复现签订时的金额与阶段列。
   */
  function itemsSnapshot(input, result) {
    var i = input || {};
    var multi = Array.isArray(i.plans);
    var list = entryPlanList(i);
    var r = result || (multi ? priceContractMulti(list, i.balance) : priceContract(i));
    var year = String(i.year === null || i.year === undefined ? '' : i.year);

    var planSnaps = list.map(function (p, idx) {
      var rowRes = (r && r.plans && r.plans[idx]) ? r.plans[idx] : null;

      /* 方案配置：优先用入参里归一过的 plan；否则从计价结果反推（stageList 就是阶段配置） */
      var cfgSrc = (p.plan && normalizePlan(p.plan).stages.length)
        ? p.plan
        : (rowRes
          ? {
            unit_price: rowRes.unitPrice,
            stages: rowRes.stageList,
            discount_type: rowRes.discountType,
            discount_value: rowRes.discountValue
          }
          : {});
      var plan = normalizePlan(cfgSrc);

      var subs = {};
      plan.stages.forEach(function (s) {
        var arr = uniqList((p.subjects || {})[s.stage] || []);
        if (arr.length) subs[s.stage] = arr;
      });

      var lines = [];
      plan.stages.forEach(function (s) {
        (subs[s.stage] || []).forEach(function (sub) {
          lines.push({
            stage: s.stage,
            subject: sub,
            unitPrice: round2(plan.unit_price),
            sessions: s.sessions,
            amount: round2(plan.unit_price * s.sessions),
            material: round2(s.material_fee)
          });
        });
      });

      var res = rowRes || priceContract({
        year: i.year, grade: i.grade, planName: p.planName, plan: plan,
        subjects: p.subjects || {}, discount: p.discount, balance: 0
      });

      return {
        planName: String(p.planName || ''),
        unit_price: round2(plan.unit_price),
        stages: plan.stages.map(function (s) {
          return { stage: s.stage, sessions: s.sessions, material_fee: round2(s.material_fee) };
        }),
        subjects: subs,
        discount: { type: String(res.discountType || 'none'), value: num(res.discountValue) },
        lines: lines,
        subjectRows: (res.subjectRows || []).map(function (x) {
          return {
            subject: x.subject, stagesHit: x.stagesHit,
            sessionsTotal: x.sessionsTotal, amount: x.amount
          };
        }),
        stageMaterial: (res.stageMaterial || []).map(function (m) {
          return { stage: m.stage, unitFee: m.unitFee, count: m.count, amount: m.amount };
        }),
        original: round2(num(res.original)),
        discountAmount: round2(num(res.discountAmount)),
        tuition: round2(num(res.tuition)),
        materialAmount: round2(num(res.materialAmount)),
        remark: String(p.remark || '')
      };
    });

    /* 平铺冗余字段：多方案时是「合并视图」，单方案时与 T9 快照逐字段等价 */
    var merged = mergePlanViews(planSnaps);
    var stagesMap = {};
    planSnaps.forEach(function (ps) {
      Object.keys(ps.subjects || {}).forEach(function (st) {
        stagesMap[st] = uniqList((stagesMap[st] || []).concat(ps.subjects[st]));
      });
    });
    var allLines = [];
    planSnaps.forEach(function (ps) { allLines = allLines.concat(ps.lines); });

    return {
      plans: planSnaps,
      planName: planSnaps.map(function (ps) { return ps.planName; }).join('+'),
      plan: planSnaps.length === 1 ? {
        unit_price: planSnaps[0].unit_price,
        stages: planSnaps[0].stages,
        discount_type: planSnaps[0].discount.type,
        discount_value: planSnaps[0].discount.value
      } : null,
      stages: stagesMap,
      lines: allLines,
      subjectRows: merged.subjectRows,
      stageMaterial: merged.stageMaterial,
      pricesVersion: year
    };
  }

  /** 单方案快照（T9 items.plan 格式 / 更早的 lines-only 格式）还原成明细视图 */
  function snapshotSingleView(row, items) {
    var r = row || {};
    var plan = normalizePlan(items.plan || {});
    var lines = (items.lines || []).map(normLine);
    var subjectRows = normSubjectRows(items.subjectRows, lines);
    var stageMaterial = normStageMaterial(items.stageMaterial, plan, lines);

    var original = round2(num(r.original_amount));
    var discountAmount = round2(num(r.discount_amount));
    var material = round2(num(r.material_amount));
    var tuition = round2(original - discountAmount);
    return {
      year: r.year,
      grade: r.grade || '',
      planName: String(items.planName || r.plan || ''),
      unitPrice: round2(plan.unit_price),
      stageList: plan.stages.slice(),
      subjectRows: subjectRows,
      stageMaterial: stageMaterial,
      missing: [],
      subjectCount: subjectRows.length,
      original: original,
      discountAmount: discountAmount,
      tuition: tuition,
      materialAmount: material,
      subtotal: round2(tuition + material),
      deduction: round2(num(r.account_deduction)),
      payable: round2(num(r.payable_amount)),
      balanceLeft: round2(num(r.balance_remain)),
      discountType: String(r.discount_type || 'none'),
      discountValue: num(r.discount_value),
      plans: null,
      multi: false,
      ok: true
    };
  }

  /** T11 多方案快照（items.plans 数组）还原成明细视图 */
  function snapshotMultiView(row, items) {
    var r = row || {};
    var plans = (items.plans || []).map(function (x0) {
      var x = x0 || {};
      var d = x.discount || {};
      var plan = normalizePlan({
        unit_price: x.unit_price,
        stages: x.stages,
        discount_type: d.type || 'none',
        discount_value: d.value
      });
      var lines = (x.lines || []).map(normLine);
      var subjectRows = normSubjectRows(x.subjectRows, lines);
      var stageMaterial = normStageMaterial(x.stageMaterial, plan, lines);
      var original = round2(num(x.original));
      var discountAmount = round2(num(x.discountAmount));
      var materialAmount = round2(num(x.materialAmount));
      var tuition = (x.tuition === null || x.tuition === undefined)
        ? round2(original - discountAmount)
        : round2(num(x.tuition));
      return {
        planName: String(x.planName || ''),
        remark: String(x.remark || ''),
        unitPrice: round2(plan.unit_price),
        stageList: plan.stages.slice(),
        subjectRows: subjectRows,
        stageMaterial: stageMaterial,
        missing: [],
        subjectCount: subjectRows.length,
        original: original,
        discountAmount: discountAmount,
        tuition: tuition,
        materialAmount: materialAmount,
        subtotal: round2(tuition + materialAmount),
        deduction: 0,
        payable: 0,
        balanceLeft: 0,
        discountType: String(d.type || 'none'),
        discountValue: num(d.value),
        ok: true
      };
    });

    var merged = mergePlanViews(plans);
    var sumOriginal = 0, sumDisc = 0, sumTuition = 0, sumMaterial = 0;
    plans.forEach(function (p) {
      sumOriginal += p.original;
      sumDisc += p.discountAmount;
      sumTuition += p.tuition;
      sumMaterial += p.materialAmount;
    });
    var has = function (v) { return v !== null && v !== undefined && v !== ''; };

    var original = has(r.original_amount) ? round2(num(r.original_amount)) : round2(sumOriginal);
    var discountAmount = has(r.discount_amount) ? round2(num(r.discount_amount)) : round2(sumDisc);
    var material = has(r.material_amount) ? round2(num(r.material_amount)) : round2(sumMaterial);
    var tuition = has(r.original_amount) && has(r.discount_amount)
      ? round2(original - discountAmount)
      : round2(sumTuition);

    /* 只有一个方案时，把该方案的科目表镜像到顶层字段：
       与 T9 单方案快照完全同构，老调用方（台账列、导出）无需改动 */
    var single = plans.length === 1 ? plans[0] : null;

    return {
      year: r.year,
      grade: r.grade || '',
      planName: String(items.planName || r.plan || plans.map(function (p) { return p.planName; }).join('+')),
      unitPrice: single ? single.unitPrice : 0,
      stageList: single ? single.stageList.slice() : [],
      subjectRows: single ? single.subjectRows : merged.subjectRows,
      stageMaterial: single ? single.stageMaterial : merged.stageMaterial,
      missing: [],
      subjectCount: merged.subjectCount,
      original: original,
      discountAmount: discountAmount,
      tuition: tuition,
      materialAmount: material,
      subtotal: round2(tuition + material),
      deduction: round2(num(r.account_deduction)),
      payable: round2(num(r.payable_amount)),
      balanceLeft: round2(num(r.balance_remain)),
      discountType: String(r.discount_type || 'none'),
      discountValue: num(r.discount_value),
      plans: plans,
      multi: plans.length > 1,
      ok: true
    };
  }

  /**
   * 由台账行（items 快照 + 落库金额）还原一份「明细单」结构，供查看明细使用。
   *
   * 三格式并存，内部分支：
   *   ① items.plans 数组  —— T11 多方案（新签合同）
   *   ② items.plan 对象   —— T9 单方案（id=2 / id=3 两行真实数据就是这个格式）
   *   ③ 仅 items.lines    —— 更早的快照（科目行与资料费由 lines 现推）
   */
  function snapshotResult(row) {
    var r = row || {};
    var items = r.items || {};
    if (Array.isArray(items.plans) && items.plans.length) return snapshotMultiView(r, items);
    return snapshotSingleView(r, items);
  }


  App.ContractsCore = {
    DEFAULT_MATERIAL: DEFAULT_MATERIAL,
    YEAR_MIN: YEAR_MIN,
    YEAR_MAX: YEAR_MAX,
    PLAN_NAME_MAX: PLAN_NAME_MAX,
    REMARK_MAX: REMARK_MAX,
    priceContract: priceContract,
    priceContractMulti: priceContractMulti,
    priceEntry: priceEntry,
    entryPlanList: entryPlanList,
    mergePlanViews: mergePlanViews,
    previewPlan: previewPlan,
    validatePlan: validatePlan,
    validateContract: validateContract,
    normalizePlan: normalizePlan,
    findPlan: findPlan,
    plansFor: plansFor,
    planStageList: planStageList,
    planStages: planStages,
    planSummary: planSummary,
    planDiscountText: planDiscountText,
    planLabel: planLabel,
    stageOrder: stageOrder,
    priceYears: priceYears,
    itemsSnapshot: itemsSnapshot,
    snapshotResult: snapshotResult,
    snapshotPlanConfigs: snapshotPlanConfigs,
    priceChanged: priceChanged,
    discountText: discountText,
    resolveDiscount: resolveDiscount,
    dupContract: dupContract,
    normRate: normRate,
    parseRate: parseRate,
    discountInputError: discountInputError
  };

  /* =========================================================
   * 6. 读表辅助
   * ========================================================= */

  function allPrices() { return pricesTable().list(); }
  function allContracts() { return contractsTable().list(); }

  /** 学生档案里的姓名候选（仅做联想，不强绑定 —— PRD §3.6.2 第 1 点） */
  function studentNames() {
    var out = [], seen = {};
    try {
      App.DB.table('students').list().forEach(function (s) {
        var n = String(s.stu_name || '').trim();
        if (!n || seen[n]) return;
        seen[n] = true;
        out.push(n);
      });
    } catch (e) { /* 学生表未就绪时不影响登记 */ }
    return out.sort(function (a, b) { return U.zh(a, b); });
  }

  /* =========================================================
   * 7. 优惠明细单渲染
   *    PRD §3.6.3 · T9 Excel 风格 · T11 多方案 · T12 合并横表 · T13 备注条下方化
   *
   * T11：多方案各自独立算价、只留「数字 + 短标签」、结余行条件渲染、方案备注。
   * T12：把原来的「每个方案一张竖表 + 表格外再一张汇总表」合并成**一张横表**，
   *      整屏一截就能发家长核对。
   *   · 列 = 科目 |（单价）| 各方案各阶段平铺 | 小计
   *   · 行 = 科目并集（同名科目跨方案合并成一行）→ 资料费 → 方案小计（仅多方案）→ 汇总块
   *   · 单价全部一致 → 单列显示单价、单元格打 ✓；
   *     单价不一致 → 不设单价列，列头写「· 240.00 元/科」，单元格改「240.00×7=1680.00」
   *   · 备注升级成浅黄提示条（T13：放在表格**下方**，紧凑一行，长文自然换行）
   * ========================================================= */

  /** 明细弹窗宽度：只作用于「合同明细」这一个弹窗（其它弹窗仍是默认 660px） */
  var DETAIL_MODAL_WIDTH = 1120;

  /**
   * 把「计价结果 / 快照视图」归一成方案视图列表。
   *
   * 三种来源都能吃：
   *   · 登记页 priceEntry(input) → plans[]（单方案时也有一条）
   *   · 多方案快照 snapshotMultiView → plans[]
   *   · T9 单方案 / 更早的 lines-only 快照 → plans === null，顶层字段本身就是唯一方案
   *
   * @param {Object} r 计价结果或快照视图
   * @returns {Array<Object>} [{planName, unitPrice, stageList, subjectRows, stageMaterial,
   *                            remark, original, discountAmount, tuition, materialAmount,
   *                            subtotal, discountType, discountValue}]
   */
  function detailPlanViews(r) {
    var res = r || {};

    function toView(src) {
      var v = src || {};
      return {
        planName: String(v.planName || ''),
        unitPrice: round2(num(v.unitPrice)),
        stageList: (v.stageList || []).slice(),
        subjectRows: v.subjectRows || [],
        stageMaterial: v.stageMaterial || [],
        remark: String(v.remark === null || v.remark === undefined ? '' : v.remark),
        original: round2(num(v.original)),
        discountAmount: round2(num(v.discountAmount)),
        tuition: round2(num(v.tuition)),
        materialAmount: round2(num(v.materialAmount)),
        subtotal: round2(num(v.subtotal)),
        discountType: String(v.discountType || 'none'),
        discountValue: num(v.discountValue)
      };
    }

    if (Array.isArray(res.plans) && res.plans.length) return res.plans.map(toView);
    return [toView(res)];
  }

  /**
   * 横表的列模型：一个「方案 × 阶段」= 一列，顺序 = 方案勾选顺序 → 阶段 A→D。
   * @param {Array<Object>} views 方案视图列表
   * @returns {{cols:Array<Object>, uniform:boolean}}
   *          cols[i] = {vi 方案下标, planName, stage, sessions}
   *          uniform = 所有方案课时单价是否一致（决定「单价列 / 金额式单元格」）
   */
  function detailColumns(views) {
    var list = views || [];
    var cols = [];
    list.forEach(function (v, vi) {
      (v.stageList || []).forEach(function (s) {
        cols.push({
          vi: vi,
          planName: String(v.planName || ''),
          stage: String(s.stage || ''),
          sessions: Math.max(0, Math.round(num(s.sessions)))
        });
      });
    });
    var uniform = true;
    list.forEach(function (v) {
      if (round2(num(v.unitPrice)) !== round2(num(list[0].unitPrice))) uniform = false;
    });
    return { cols: cols, uniform: uniform };
  }

  /**
   * 科目行 = 所有方案的科目并集（同名科目合并成一行）。
   * 排序取「首次出现序」（方案顺序 → 阶段 A→D → 录入顺序），
   * 不取字典序的理由：单方案（T9 与旧快照）的行序与改造前逐行一致，
   * 多方案时同一科目也永远落在它第一次出现的位置，家长对着纸质单好找。
   *
   * @param {Array<Object>} views 方案视图列表
   * @returns {Array<{subject:string, hit:Object, amount:number}>} hit 的键 = '方案下标|阶段'
   */
  function detailSubjectRows(views) {
    var map = {}, order = [];
    (views || []).forEach(function (v, vi) {
      (v.subjectRows || []).forEach(function (row) {
        var key = String((row && row.subject) || '');
        if (!map[key]) {
          map[key] = { subject: key, hit: {}, amount: 0 };
          order.push(key);
        }
        Object.keys((row && row.stagesHit) || {}).forEach(function (st) {
          map[key].hit[vi + '|' + st] = true;
        });
        map[key].amount = round2(map[key].amount + num(row && row.amount));
      });
    });
    return order.map(function (k) { return map[k]; });
  }

  /** 折扣百分比文案：「85折」/「8折」/「88折」 */
  function pctLabel(value) {
    var pct = Math.round(normRate(value) * 1000) / 10;
    return (pct % 10 === 0 ? String(pct / 10) : String(pct)) + '折';
  }

  /**
   * 明细单「优惠」行的文案。
   *   单方案 → 沿用 discountText（「85折」/「减免 300 元」）
   *   多方案 → 按方案顺序拼接：「减免 50 + 300 元」/「85折 + 9折」/「85折 + 减免 300 元」
   *
   * @param {Array<Object>} views 方案视图列表
   * @param {Object} r 整单计价结果（单方案时直接透传给 discountText）
   */
  function detailDiscountText(views, r) {
    var list = views || [];
    if (list.length <= 1) return discountText(r);

    var hit = list.filter(function (v) { return num(v.discountAmount) > 0; });
    if (!hit.length) return discountText(r);

    var allAmount = hit.every(function (v) { return v.discountType === 'amount'; });
    if (allAmount) {
      return '减免 ' + hit.map(function (v) { return moneyTrim(num(v.discountValue)); }).join(' + ') + ' 元';
    }
    return hit.map(function (v) {
      if (v.discountType === 'pct') return pctLabel(v.discountValue);
      if (v.discountType === 'amount') return '减免 ' + moneyTrim(num(v.discountValue)) + ' 元';
      return discountText(v);
    }).join(' + ');
  }

  /**
   * 备注提示条（T12 需求 2 · **T13 布局微调**）：放在整张明细表**之后**（表格下方、
   * 底部提示块之前），默认只占一行高度——不抢表格的视觉主体，长文本自然换行成多行。
   *
   * 去重规则沿用 T11 / T12，零功能改动：
   *   · 所有方案备注相同且非空 → 只显示一条（不带方案名）
   *   · 备注各自不同（或只有一个方案有）→ 逐条显示，多方案时前缀「方案名：」，每条一行
   *   · 一条备注都没有 → 整块不渲染
   *
   * 样式（T13）：浅黄底 `#fff8e1` + 左 3px 琥珀竖条 + 粗体 `📌 备注` 标签；
   * 内边距 6px 11px、字号 12.5px、行高 1.5、与表格上间距 8px；
   * 标签与正文**同一行**（inline），多方案多条备注逐条一行。
   * 不用 ellipsis / max-height 截断——内容多就让它长，占几行由内容决定。
   *
   * @param {Array<Object>} views 方案视图列表
   * @returns {string} HTML 片段（可能是空串）
   */
  function remarkTipHTML(views) {
    var list = views || [];
    var texts = list.map(function (v) { return String(v.remark || '').trim(); });
    if (!texts.some(Boolean)) return '';

    var multi = list.length > 1;
    var allSame = texts.every(function (t) { return !!t && t === texts[0]; });
    var items = [];
    if (allSame) {
      items.push({ label: '', text: texts[0] });
    } else {
      list.forEach(function (v, idx) {
        if (!texts[idx]) return;
        items.push({ label: multi ? String(v.planName || '方案') : '', text: texts[idx] });
      });
    }

    var style = 'background:#fff8e1;border-left:3px solid var(--amber,#c8892e);' +
      'border-radius:0 8px 8px 0;padding:6px 11px;font-size:12.5px;line-height:1.5;' +
      'margin:8px 0 0;color:#6b5410';
    var h = '<div class="ct-remark-tip" style="' + style + '">';
    items.forEach(function (x, idx) {
      h += '<div' + (idx ? ' style="margin-top:2px;word-break:break-word"' : ' style="word-break:break-word"') + '>' +
        (idx === 0 ? '<span style="font-weight:700;color:#a06d00">📌 备注</span> ' : '') +
        (x.label ? '<b>' + esc(x.label) + '</b>：' : '') + esc(x.text) + '</div>';
    });
    h += '</div>';
    return h;
  }

  /**
   * 合并后的单张横表（T12 需求 1）。
   * 表格内既有科目 / 资料费行，也有方案小计与整单汇总（汇总行用 colspan 跨掉除金额列外的所有列）。
   *
   * @param {Object} r 计价结果或快照视图
   * @returns {string} HTML
   */
  function detailTableHTML(r) {
    var res = r || {};
    var views = detailPlanViews(res);
    var meta = detailColumns(views);
    var cols = meta.cols;
    var uniform = meta.uniform;
    var multi = views.length > 1;

    /* 列宽估算：科目列宽一点，阶段列等宽，末列金额列固定 —— 列数多时让外层容器横向滚动 */
    var labelCols = uniform ? 2 : 1;
    var minWidth = (uniform ? 190 : 130) + cols.length * 112 + 118;

    /* 表头统一浅绿底（截图发给家长时行列边界更清楚） */
    var headStyle = 'background:#eaf5ef;color:#255c46;padding:8px 9px;' +
      'border-bottom:1px solid #cfe3da;white-space:nowrap';

    var h = '<div class="ct-detail-wrap" style="overflow-x:auto;border:1px solid var(--line,#e2e9e7);' +
      'border-radius:10px;background:#fff">' +
      '<table class="ct-detail-table" style="width:100%;min-width:' + minWidth + 'px;' +
      'border-collapse:collapse;font-size:12.5px">' +
      '<thead><tr><th style="' + headStyle + ';text-align:left">科目</th>';

    if (uniform) {
      h += '<th class="num" style="' + headStyle + ';text-align:right">课时单价(元/次课)</th>';
    }
    cols.forEach(function (c) {
      var v = views[c.vi] || {};
      var head = (multi ? (esc(c.planName || '方案') + ' · ') : '') +
        esc(c.stage) + ' 阶段(' + c.sessions + '次)';
      if (!uniform) head += ' · ' + money(num(v.unitPrice)) + ' 元/科';
      h += '<th class="num" style="' + headStyle + ';text-align:right">' + head + '</th>';
    });
    h += '<th class="num" style="' + headStyle + ';text-align:right">小计(元)</th>' +
      '</tr></thead><tbody>';

    var totalCols = labelCols + cols.length + 1;

    if (!cols.length) {
      h += '<tr><td colspan="' + Math.max(totalCols, 2) + '" style="padding:10px;color:var(--ink3,#8b96a3)">' +
        '还没有选择报读科目</td></tr>';
      h += '</tbody></table></div>';
      return h;
    }

    var cellStyle = 'padding:6px 9px;border-bottom:1px solid var(--line2,#eef3f1);white-space:nowrap';

    /* ---- 科目行：所有方案的科目并集，同名合并一行 ---- */
    detailSubjectRows(views).forEach(function (row) {
      h += '<tr>' +
        '<td style="' + cellStyle + '"><b>' + esc(row.subject) + '</b></td>';
      if (uniform) {
        h += '<td class="num" style="' + cellStyle + ';text-align:right">' + money(views[0].unitPrice) + '</td>';
      }
      cols.forEach(function (c) {
        var v = views[c.vi] || {};
        var on = !!row.hit[c.vi + '|' + c.stage];
        var text = '';
        if (on) {
          /* 单价不一致时把「单价 × 次数 = 金额」写全，家长能自己复核 */
          text = uniform
            ? '✓'
            : money(num(v.unitPrice)) + '×' + c.sessions + '=' + money(round2(num(v.unitPrice) * c.sessions));
        }
        h += '<td class="num" style="' + cellStyle + ';text-align:right">' + text + '</td>';
      });
      h += '<td class="num" style="' + cellStyle + ';text-align:right">' + money(row.amount) + '</td></tr>';
    });

    /* ---- 资料费行：每列「单价×该阶段科目数=金额」，末列整单合计 ---- */
    var feeTexts = [];
    views.forEach(function (v) {
      (v.stageMaterial || []).forEach(function (m) {
        var t = money(m.unitFee);
        if (feeTexts.indexOf(t) < 0) feeTexts.push(t);
      });
    });
    h += '<tr style="background:#fbfcfd">' +
      '<td style="' + cellStyle + ';background:#fbfcfd"><b>资料费</b>' +
      '<span style="color:var(--ink3,#8b96a3);font-size:11.5px">（单科/阶段）</span></td>';
    if (uniform) {
      h += '<td class="num" style="' + cellStyle + ';text-align:right;background:#fbfcfd">' +
        (feeTexts.length === 1 ? feeTexts[0] : (feeTexts.join(' / ') || '—')) + '</td>';
    }
    cols.forEach(function (c) {
      var v = views[c.vi] || {};
      var hit = null;
      (v.stageMaterial || []).forEach(function (m) {
        if (String(m.stage) === String(c.stage)) hit = m;
      });
      h += '<td class="num" style="' + cellStyle + ';text-align:right;background:#fbfcfd">' +
        (hit ? money(hit.unitFee) + '×' + hit.count + '=' + money(hit.amount) : '—') + '</td>';
    });
    h += '<td class="num" style="' + cellStyle + ';text-align:right;background:#fbfcfd">' +
      money(num(res.materialAmount)) + '</td></tr>';

    /* ---- 方案小计行（多方案才有）：按方案分组的 colspan，金额 = 该方案 T + M ---- */
    var canSubRow = multi && views.every(function (v) { return (v.stageList || []).length > 0; });
    if (canSubRow) {
      h += '<tr style="background:#f6faf8">' +
        '<td colspan="' + labelCols + '" style="' + cellStyle + ';background:#f6faf8"><b>方案小计</b></td>';
      views.forEach(function (v) {
        h += '<td class="num" colspan="' + (v.stageList || []).length + '" ' +
          'style="' + cellStyle + ';text-align:right;background:#f6faf8">' +
          esc(v.planName || '方案') + ' ' + money(v.subtotal) + '</td>';
      });
      h += '<td class="num" style="' + cellStyle + ';text-align:right;background:#f6faf8"><b>' +
        money(num(res.subtotal)) + '</b></td></tr>';
    }

    /* ---- 整单汇总：并进同一张表，单元格用 colspan 跨掉除金额列外的所有列 ---- */
    var sumRows = [];
    sumRows.push(['课时费原价合计', money(res.original), '']);
    if (num(res.discountAmount) > 0) {
      sumRows.push(['优惠（' + detailDiscountText(views, res) + '）', '－' + money(res.discountAmount), '']);
    }
    sumRows.push(['折后课时费', money(res.tuition), '']);
    sumRows.push(['资料费合计', money(res.materialAmount), '']);
    sumRows.push(['小计', money(res.subtotal), 'sub']);
    /* T11 需求 2：只有真的抵扣了才出现这一行 */
    if (num(res.deduction) > 0) {
      sumRows.push(['电子账户结余抵扣', '－ ' + money(res.deduction), '']);
    }
    sumRows.push(['应付金额', money(res.payable), 'pay']);

    sumRows.forEach(function (row) {
      var flag = row[2];
      var pay = flag === 'pay';
      var bg = pay ? '#e8f5ef' : '#fbfdfc';
      var weight = pay ? ';font-weight:700;font-size:13.5px' : '';
      var border = (pay || flag === 'sub') ? ';border-top:2px solid #cfe3da' : '';
      h += '<tr>' +
        '<td colspan="' + (totalCols - 1) + '" style="' + cellStyle + ';background:' + bg + weight + border + '">' +
        esc(row[0]) + '</td>' +
        '<td class="num" style="' + cellStyle + ';text-align:right;background:' + bg + weight + border + '">' +
        esc(row[1]) + '</td></tr>';
    });

    h += '</tbody></table></div>';
    return h;
  }

  /**
   * 明细单卡片：标题 → 学生信息 → 一张合并横表 → 备注提示条（T13 起移到表格下方）
   *   → 提示（优惠截断 / 结余剩余）。
   * 登记页实时明细与台账「查看明细」弹窗共用本函数（T12 需求 9）。
   *
   * @param {Object} input {stu_name, grade, year, planName?}
   * @param {Object} res 计价结果或快照视图
   * @param {Object} [opt] {note: 右上角小字说明}
   * @returns {string} HTML
   */
  function detailCardHTML(input, res, opt) {
    var i = input || {};
    var r = res || {};
    var o = opt || {};
    var views = detailPlanViews(r);

    var planText = views
      .map(function (v) { return String(v.planName || ''); })
      .filter(Boolean).join(' + ');

    var h = '<div class="card"><h3>优惠明细单' +
      (o.note ? '<span class="h-note">' + esc(o.note) + '</span>' : '') + '</h3>';

    h += '<div class="muted" style="font-size:12.5px;margin-bottom:8px">' +
      '学生：' + esc(i.stu_name || '—') +
      '　　年级：' + esc(i.grade || '—') +
      '　　年份：' + esc(i.year || '—') +
      '　　方案：' + esc(planText || '—') + '</div>';

    h += '<div style="border-top:1px solid var(--line,#dfe3e8);margin:6px 0 10px"></div>';

    var hasAny = views.some(function (v) { return (v.stageList || []).length; });
    if (!hasAny) {
      h += '<div class="muted" style="padding:10px 0">还没有可用的报读方案（先选年级 / 年份 / 方案）。</div></div>';
      return h;
    }

    /* T13：备注条移到表格**下方**（紧贴表格、仍在优惠截断 / 结余剩余提示块之前），
       默认一行高度，不抢表格的视觉主体；内容长时自然换行多行 */
    h += detailTableHTML(r);
    h += remarkTipHTML(views);

    if (r.discountType === 'amount' && num(r.discountValue) > num(r.original) && num(r.original) >= 0) {
      h += '<div class="hint" style="margin-top:10px">优惠金额超过课时费合计，已按 ' +
        money(r.original) + ' 元截断（不会把课时费打成负数）。</div>';
    }
    if (num(r.balanceLeft) > 0) {
      h += '<div class="hint" style="margin-top:10px">结余剩余 ' + money(r.balanceLeft) +
        ' 元可下次使用（仅提示，不计入台账）。</div>';
    }

    h += '</div>';
    return h;
  }

  /**
   * 加宽「合同明细」弹窗（T12 需求 1 第 8 点）。
   * Modal.open 的 DOM 是 .mask > .modal，这里只给这一个弹窗盖 inline max-width，
   * 其它弹窗（方案表单 / 确认框）继续用 stylesheet 的 660px，互不影响。
   *
   * @param {Element} mask Modal.open 的返回值
   * @returns {Element} 原样返回，便于链式使用
   */
  function widenDetailModal(mask) {
    try {
      var el = mask && mask.querySelector ? mask.querySelector('.modal') : null;
      if (el && el.style) el.style.maxWidth = DETAIL_MODAL_WIDTH + 'px';
    } catch (e) { /* 测试桩件或极老浏览器：加宽失败不影响内容渲染 */ }
    return mask;
  }

  /* T12：合并横表的纯函数也外露（测试直接断言列模型 / 科目行合并 / 优惠文案拼接；
     第二个赋值块是因为 DETAIL_MODAL_WIDTH 是 var，放在上面那个字面量里会读到 undefined） */
  App.ContractsCore.detailPlanViews = detailPlanViews;
  App.ContractsCore.detailColumns = detailColumns;
  App.ContractsCore.detailSubjectRows = detailSubjectRows;
  App.ContractsCore.detailDiscountText = detailDiscountText;
  App.ContractsCore.detailTableHTML = detailTableHTML;
  App.ContractsCore.detailCardHTML = detailCardHTML;
  App.ContractsCore.remarkTipHTML = remarkTipHTML;
  App.ContractsCore.DETAIL_MODAL_WIDTH = DETAIL_MODAL_WIDTH;

  /* =========================================================
   * 8. Tab ① 合同登记
   * ========================================================= */

  /** 已勾选方案的价目行（按 entry.plans 顺序；价目里找不到 → null） */
  function entryPlanRows() {
    var e = state.entry;
    var prices = allPrices();
    return (e.plans || []).map(function (pe) {
      return { entry: pe, row: findPlan(prices, e.year, e.grade, pe.name) };
    });
  }

  /** 阶段科目多选组件的挂载键：一个方案 × 一个阶段 = 一个组件 */
  function planMountKey(idx, stage) { return 'plan' + idx + '-' + stage; }

  /**
   * 把 entry.plans 与「当前年份 + 年级」下的可用方案对齐：
   *   · 价目里已经不存在（换年级/换年份/方案被删）的勾选 → 移除，记进 state.droppedPlans；
   *   · 未手动改过优惠的方案 → 优惠跟随方案预设（价目改了也能跟上）；
   *   · 方案阶段之外的科目 → 清空，避免残留脏数据。
   * @returns {Array} 该年份年级下可勾选的全部方案行
   */
  function syncEntryPlans() {
    var e = state.entry;
    var prices = allPrices();
    var avail = (e.year && e.grade) ? plansFor(prices, e.year, e.grade) : [];
    var map = {};
    avail.forEach(function (r) { map[String(r.plan_name || '')] = r; });

    var dropped = [];
    e.plans = (e.plans || []).filter(function (pe) {
      if (pe && map[pe.name]) return true;
      if (pe && pe.name) dropped.push(pe.name);
      return false;
    });
    state.droppedPlans = dropped;

    /* 方案块顺序 = 勾选框列表顺序（价目里的中文排序），与点击先后无关：
       增删勾选不会让已有方案块跳位置 */
    var order = {};
    avail.forEach(function (r, i) { order[String(r.plan_name || '')] = i; });
    e.plans.sort(function (a, b) {
      var ia = order[a.name], ib = order[b.name];
      if (ia === undefined) ia = 999;
      if (ib === undefined) ib = 999;
      return ia - ib;
    });

    e.plans.forEach(function (pe) {
      var row = map[pe.name];
      if (!pe.subjects) pe.subjects = { A: [], B: [], C: [], D: [] };
      STAGE_LIST.forEach(function (st) {
        if (!Array.isArray(pe.subjects[st])) pe.subjects[st] = [];
      });
      if (!pe.discountTouched) {
        var p = normalizePlan(row);
        pe.discount = { type: p.discount_type, value: p.discount_value };
      }
      var allow = planStageList(row);
      STAGE_LIST.forEach(function (st) { if (allow.indexOf(st) < 0) pe.subjects[st] = []; });
    });
    return avail;
  }

  function readEntryInput() {
    var e = state.entry;
    var prices = allPrices();
    return {
      stu_name: e.stu_name,
      grade: e.grade,
      year: e.year,
      /* T11：多方案。顺序 = 价目列表顺序（syncEntryPlans 已对齐） */
      plans: (e.plans || []).map(function (pe) {
        var row = findPlan(prices, e.year, e.grade, pe.name);
        var subs = pe.subjects || {};
        return {
          planName: pe.name,
          plan: row ? normalizePlan(row) : null,
          subjects: {
            A: (subs.A || []).slice(),
            B: (subs.B || []).slice(),
            C: (subs.C || []).slice(),
            D: (subs.D || []).slice()
          },
          discount: pe.discount
            ? { type: pe.discount.type, value: pe.discount.value }
            : null,
          /* 方案备注随价目走（需求 4），签合同时快照进 items[].remark */
          remark: row ? String(row.remark || '') : ''
        };
      }),
      balance: e.balance
    };
  }

  /** 第一个填错的优惠（多方案时带方案名前缀，用户才知道改哪个） */
  function entryDiscountError() {
    var e = state.entry;
    var list = e.plans || [];
    for (var i = 0; i < list.length; i++) {
      var err = discountInputError(list[i].discount);
      if (err) return (list.length > 1 ? '「' + list[i].name + '」' : '') + err;
    }
    return '';
  }

  /** 年份默认值：当前年（若价目里有）→ 否则最新年；已有明确年份时不动 */
  function ensureYear() {
    var e = state.entry;
    var years = priceYears(allPrices());
    if (!years.length) return years;
    if (e.year) return years;
    var nowY = new Date().getFullYear();
    e.year = years.indexOf(nowY) >= 0 ? nowY : years[years.length - 1];
    return years;
  }

  /**
   * 年份下拉候选：价目已有年份；若当前年份不在其中（例：修改一份价目年份已被删的合同），
   * 仍把它补进候选，避免下拉框静默跳到别的年份。
   */
  function yearOptions(years, cur) {
    var list = (years || []).slice();
    var y = num(cur);
    if (y && list.indexOf(y) < 0) list.push(y);
    return list.sort(function (a, b) { return a - b; });
  }

  function renderEntry() {
    var years = ensureYear();
    var e = state.entry;

    /* 勾选的方案与当前年份年级的价目对齐（失效方案移除、优惠跟随预设） */
    var avail = syncEntryPlans();

    var h = '';

    if (state.editingId) {
      var cur0 = contractsTable().get(state.editingId);
      h += '<div class="hint">正在修改合同：<b>' + esc(cur0 ? cur0.stu_name : e.stu_name) + '</b>（' +
        esc(e.grade || '') + '）。保存后覆盖原记录（唯一键：学生姓名 + 年级）。' +
        '<button id="ct-cancel-edit" class="ghost" style="margin-left:10px">取消修改</button></div>';
    }

    if (!years.length) {
      h += '<div class="hint">还没有任何价目方案。请先到『③ 价目维护』新增方案' +
        '（年份 / 年级 / 方案名称 / 课时费原价 / 阶段配置 / 报读优惠 / 备注）。</div>';
    } else if (!e.year) {
      h += '<div class="hint">请选择合同年份。</div>';
    } else if (years.indexOf(num(e.year)) < 0) {
      h += '<div class="hint">' + esc(e.year) + ' 年还没有价目方案，请先到『价目维护』新增。</div>';
    }

    if ((state.droppedPlans || []).length) {
      h += '<div class="err">原合同的方案「' + esc(state.droppedPlans.join('、')) +
        '」在价目中已不存在，已从本次登记中移除，请重新勾选。</div>';
    }

    /* ---- 输入区 ---- */
    h += '<div class="card"><h3>合同登记' +
      '<span class="h-note">唯一键：学生姓名 + 年级</span></h3>' +
      '<div data-form-err></div>';

    var names = studentNames();
    h += '<div class="form-grid">' +
      '<label class="f">学生姓名 *' +
      '<input type="text" id="ct-name" list="ct-name-list" autocomplete="off" ' +
      'value="' + esc(e.stu_name) + '" placeholder="输入姓名，可从学生档案联想">' +
      '<datalist id="ct-name-list">' +
      names.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('') +
      '</datalist>' +
      '<span class="muted" style="font-size:12px">仅做联想，不强绑定学生档案</span>' +
      '</label>' +
      '<label class="f">合同年级 *<select id="ct-grade"><option value="">请选择</option>' +
      UI.optionsWithLabel(UI.GRADES, e.grade) + '</select></label>' +
      '<label class="f">合同年份 *<select id="ct-year">' +
      (years.length ? UI.optionsWithLabel(yearOptions(years, e.year), e.year) : '<option value="">暂无方案</option>') +
      '</select></label>' +
      '</div>';

    /* ---- 报读方案多选（勾选框；勾一个就多一个方案块） ---- */
    h += planPickerHTML(avail, e);

    /* ---- 每个已勾选方案：阶段摘要 + 逐阶段科目多选 + 该方案自己的优惠 ---- */
    var rows = entryPlanRows();
    rows.forEach(function (it, idx) {
      if (!it.row) return;
      h += planBlockHTML(it.entry, idx, it.row);
    });

    /* ---- 电子账户结余：整单一个，不按方案分摊 ---- */
    h += '<div class="form-grid" style="margin-top:12px">' +
      '<label class="f">电子账户结余（元，选填）' +
      '<input type="number" id="ct-balance" min="0" step="0.01" value="' +
      (e.balance === null || e.balance === undefined ? '' : esc(num(e.balance))) + '">' +
      '<span class="muted" style="font-size:12px">整单抵扣一次；抵扣上限 = 折后课时费 + 资料费合计</span></label>' +
      '</div>';

    /* 首屏就把明细单算出来（render 自洽，不依赖 bind 才能看到金额） */
    var input = readEntryInput();
    var res = priceEntry(input);
    var discErr0 = entryDiscountError();
    var canSave0 = res.ok && !discErr0 && (e.plans || []).length > 0;

    h += '<div class="toolbar" style="margin-top:12px">' +
      '<span id="ct-save-hint">' +
      (discErr0 ? '<span class="chip ch-red">' + esc(discErr0) + '</span>' : saveHintHTML(res)) +
      '</span><div class="spacer"></div>' +
      '<button class="primary" id="ct-save"' + (canSave0 ? '' : ' disabled style="opacity:.5"') + '>保存合同</button>' +
      '<button id="ct-reset">重置</button>' +
      '</div></div>';

    /* ---- 明细单 ---- */
    h += '<div id="ct-detail">' + detailCardHTML(input, res) + '</div>';
    return h;
  }

  /** 报读方案多选区（勾选框列表；至少勾 1 个） */
  function planPickerHTML(avail, e) {
    if (!e.grade || !e.year) {
      return '<div class="hint" style="margin-top:10px">请先选择年级与年份，再选择报读方案。</div>';
    }
    if (!avail.length) {
      return '<div class="err" style="margin-top:10px">该年份年级还没有价目方案，请先到『③ 价目维护』新增。</div>';
    }
    var chosen = {};
    (e.plans || []).forEach(function (pe) { chosen[pe.name] = true; });

    var h = '<div style="margin-top:12px">' +
      '<div class="muted" style="font-size:12.5px;font-weight:600;margin-bottom:6px">' +
      '报读方案 * <span style="font-weight:400">（可同时勾选多个，至少 1 个；每个方案独立计价、独立优惠）</span>' +
      '</div><div id="ct-plan-picker" style="display:flex;flex-wrap:wrap;gap:10px 18px">';
    avail.forEach(function (p) {
      var name = String(p.plan_name || '');
      h += '<label class="muted" style="display:inline-flex;align-items:center;gap:6px;font-size:13px">' +
        '<input type="checkbox" data-plan-name="' + esc(name) + '"' +
        (chosen[name] ? ' checked' : '') + '>' +
        esc(planLabel(p)) + '</label>';
    });
    h += '</div>';
    if (!(e.plans || []).length) {
      h += '<div class="chip ch-amber" style="margin-top:8px">至少勾选 1 个报读方案</div>';
    }
    h += '</div>';
    return h;
  }

  /**
   * 单个「已勾选方案」的录入块：
   *   方案名 + 阶段摘要 chip → 每阶段科目多选 → 该方案自己的优惠（默认预设，可覆盖）。
   */
  function planBlockHTML(pe, idx, row) {
    var plan = normalizePlan(row);
    var preset = { type: plan.discount_type, value: plan.discount_value };
    var d = pe.discount || preset;
    var touched = !!pe.discountTouched;
    var subs = pe.subjects || { A: [], B: [], C: [], D: [] };

    var h = '<div style="margin-top:12px;padding:10px 12px;border:1px solid var(--line,#dfe3e8);' +
      'border-radius:8px;background:#fcfdfe">';

    /* 方案名 + 每阶段摘要 chip（需求 1.2 的「A 阶段·7 次·资料费 100.00 元/科」） */
    h += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<b style="font-size:13.5px">' + esc(pe.name) + '</b>';
    plan.stages.forEach(function (s) {
      h += '<span class="chip">' + esc(s.stage) + ' 阶段·' + esc(s.sessions) + ' 次·资料费 ' +
        money(s.material_fee) + ' 元/科</span>';
    });
    if (touched) h += '<span class="chip ch-amber">已手动调整优惠</span>';
    h += '</div>';

    /* 每阶段科目多选（该方案自己的，互不影响） */
    if (plan.stages.length) {
      h += '<div style="margin-top:8px">';
      plan.stages.forEach(function (s) {
        var count = uniqList(subs[s.stage] || []).length;
        h += '<div style="margin:8px 0">' +
          '<div class="muted" style="font-size:12.5px;margin-bottom:4px">' +
          esc(s.stage) + ' 阶段 · ' + esc(s.sessions) + ' 次课 · 资料费 ' +
          money(s.material_fee) + ' 元/科' +
          (count ? ' <span class="chip ch-green">已选 ' + count + ' 科</span>'
            : ' <span class="chip ch-amber">至少选 1 科</span>') +
          '</div>' +
          '<div data-mount="' + esc(planMountKey(idx, s.stage)) + '"></div>' +
          '</div>';
      });
      h += '</div>';
    }

    /* 该方案自己的优惠（discountTouched 每方案一份） */
    var discOpts = [
      { key: 'none', label: '原价' },
      { key: 'pct', label: '课时费折扣' },
      { key: 'amount', label: '课时费金额减免' }
    ];
    h += '<div class="form-grid" style="margin-top:10px">' +
      '<label class="f">折扣优惠 *<span style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;height:auto;padding:6px 0">' +
      discOpts.map(function (o) {
        return '<span class="muted" style="display:inline-flex;align-items:center;gap:6px;font-size:13px">' +
          '<input type="radio" name="ct-disc-' + idx + '" data-disc="' + o.key +
          '" data-plan="' + idx + '"' +
          (String(d.type) === o.key ? ' checked' : '') + '>' + o.label + '</span>';
      }).join('') +
      '</span>' +
      '<span class="muted" style="font-size:12px">方案预设：' + esc(planDiscountText(plan)) +
      (touched ? '　<span class="chip ch-amber">已手动调整</span>' : '') +
      '　（优惠只作用于课时费，资料费不参与任何优惠）</span></label>' +
      (String(d.type) === 'pct'
        ? '<label class="f">折扣（百分数）<input type="number" id="ct-pct-' + idx +
          '" min="1" max="100" step="1" value="' +
          esc(Math.round(normRate(d.value) * 1000) / 10) + '">' +
          '<span class="muted" style="font-size:12px">如 85 表示 85 折（' +
          esc(discountText({ discountType: 'pct', discountValue: d.value })) + '）</span></label>'
        : '') +
      (String(d.type) === 'amount'
        ? '<label class="f">减免金额（元）<input type="number" id="ct-off-' + idx +
          '" min="0" step="0.01" value="' + esc(round2(num(d.value))) + '">' +
          '<span class="muted" style="font-size:12px">' +
          '不得超过课时费合计，超出按课时费截断</span></label>'
        : '') +
      '</div>';

    h += '</div>';
    return h;
  }

  function saveHintHTML(res) {
    var e = state.entry;
    if (!(e.plans || []).length) return '<span class="chip ch-red">未选择报读方案</span>';
    if (!res.ok) return '<span class="chip ch-amber">每个阶段至少选 1 科</span>';
    return '<span class="chip ch-green">已选 ' + e.plans.length + ' 个方案 · 应付 ' +
      money(res.payable) + ' 元</span>';
  }

  function refreshDetail(host) {
    if (!host || !host.querySelector) return null;
    var input = readEntryInput();
    var res = priceEntry(input);

    var box = host.querySelector('#ct-detail');
    if (box) box.innerHTML = detailCardHTML(input, res);

    var hint = host.querySelector('#ct-save-hint');
    var discErr = entryDiscountError();
    if (hint) {
      /* 优惠填错时先把话说在前面，不留到点保存才报错 */
      hint.innerHTML = discErr
        ? '<span class="chip ch-red">' + esc(discErr) + '</span>'
        : saveHintHTML(res);
    }

    var saveBtn = host.querySelector('#ct-save');
    if (saveBtn) {
      var canSave = res.ok && !discErr && (state.entry.plans || []).length > 0;
      saveBtn.disabled = !canSave;
      saveBtn.style.opacity = canSave ? '' : '.5';
    }
    return res;
  }

  /* 已挂载的阶段科目多选组件（键 = plan<方案序号>-<阶段>；
     多方案时每个方案 × 每个阶段各一份，保存／重算时以组件当前值为准，避免 state 落后） */
  var mounts = {};

  function resetMounts() { mounts = {}; }

  function mountStage(host, idx, st) {
    var key = planMountKey(idx, st);
    var box = host.querySelector('[data-mount="' + key + '"]');
    if (!box) return;
    var pe = state.entry.plans[idx];
    if (!pe) return;
    if (!pe.subjects) pe.subjects = { A: [], B: [], C: [], D: [] };
    if (!Array.isArray(pe.subjects[st])) pe.subjects[st] = [];

    var ms = UI.multiSelect({
      options: UI.SUBJECTS,
      value: pe.subjects[st].slice(),
      allowCustom: true,
      placeholder: '选择或手填科目后回车',
      onChange: function (list) {
        pe.subjects[st] = list.slice();
        refreshDetail(host);
      }
    });
    /* 多选组件「删除 chip」与「退格删除」两条路径不会回调 onChange，
       这里在容器上补一次同步：先让组件改完自身状态（其监听器在同一元素上），再回写 state。 */
    function syncFromWidget() {
      pe.subjects[st] = ms.getValue();
      refreshDetail(host);
    }
    ms.el.addEventListener('click', function (ev) {
      var t = ev && ev.target;
      if (!t || String(t.tagName || '').toUpperCase() !== 'B') return;
      var chip = t.parentNode;
      if (!chip || String(chip.className || '').indexOf('ms-chip') < 0) return;
      syncFromWidget();
    });
    ms.el.addEventListener('keydown', function (ev) {
      if (!ev || ev.key !== 'Backspace') return;
      syncFromWidget();
    });
    mounts[key] = ms;
    box.appendChild(ms.el);
  }

  /** DOM → state（保存前兜底同步：避免用户输入后未失焦就点保存） */
  function syncEntryFromDom(host) {
    if (!host || !host.querySelector) return;
    var e = state.entry;
    var el;
    el = host.querySelector('#ct-name');
    if (el) e.stu_name = String(el.value || '').trim();
    el = host.querySelector('#ct-grade');
    if (el) e.grade = String(el.value || '');
    el = host.querySelector('#ct-year');
    if (el) e.year = el.value === '' ? '' : num(el.value);
    el = host.querySelector('#ct-balance');
    if (el) e.balance = UI.numOrNull(el.value);

    /* 优惠存**原始输入**（如 85），不做归一：归一交给 priceContract / 展示层。
       若在这里就 normRate，用户输入 101 会被抹成 1（不打折），校验将永远放行。 */
    (e.plans || []).forEach(function (pe, idx) {
      var pctEl = host.querySelector('#ct-pct-' + idx);
      if (pctEl) pe.discount = { type: 'pct', value: UI.numOrNull(pctEl.value) };
      var offEl = host.querySelector('#ct-off-' + idx);
      if (offEl) pe.discount = { type: 'amount', value: UI.numOrNull(offEl.value) };
      /* 阶段科目以组件当前值为准（chip 删除 / 退格删除不会触发 onChange） */
      STAGE_LIST.forEach(function (st) {
        var ms = mounts[planMountKey(idx, st)];
        if (ms && ms.getValue) {
          if (!pe.subjects) pe.subjects = { A: [], B: [], C: [], D: [] };
          pe.subjects[st] = ms.getValue();
        }
      });
    });
  }

  function saveEntry(host) {
    if (App.Perm && !App.Perm.assertWrite('contracts')) return;
    syncEntryFromDom(host);
    UI.clearError(host);

    var input = readEntryInput();
    var err = validateContract(input, allPrices(), {
      contracts: allContracts(),
      exceptId: state.editingId
    });
    if (err) {
      UI.fail(host, err);
      var nameEl = host.querySelector('#ct-name');
      if (err.indexOf('学生姓名') >= 0 && nameEl) nameEl.focus();
      return;
    }

    /* 姓名 + 年级 已有合同：不重复新建，直接引导去修改（PRD §3.6.2 第 1 点） */
    if (!state.editingId) {
      var dup = dupContract(input.stu_name, input.grade, allContracts(), null);
      if (dup) {
        Modal.confirm(
          '该学生在 <b>' + esc(input.grade) + '</b> 已有合同（应付 ' + money(num(dup.payable_amount)) +
          ' 元），是否打开修改？',
          function () { loadContractForEdit(dup); }
        );
        return;
      }
    }

    var res = priceEntry(input);
    if (!res.ok) {
      UI.fail(host, '每个阶段至少选 1 科后再保存');
      return;
    }

    var payload = {
      stu_name: String(input.stu_name).trim(),
      grade: input.grade,
      year: num(input.year),
      /* T11：多方案名称用「+」拼接（如「寒春连报+暑期班」），台账筛选按整串匹配 */
      plan: (input.plans || []).map(function (p) { return p.planName; }).join('+'),
      items: itemsSnapshot(input, res),
      original_amount: res.original,
      discount_type: res.discountType,
      discount_value: (res.discountType === 'pct' || res.discountType === 'amount') ? res.discountValue : 0,
      discount_amount: res.discountAmount,
      material_amount: res.materialAmount,
      account_deduction: res.deduction,
      payable_amount: res.payable,
      balance_remain: res.balanceLeft,
      created_by: (App.Sync && App.Sync.me && App.Sync.me()) || ''
    };

    var editingId = state.editingId;
    var p = editingId ? contractsTable().update(editingId, payload) : contractsTable().insert(payload);
    p.then(function (row) {
      Toast(editingId
        ? '已保存合同「' + row.stu_name + ' · ' + row.grade + '」'
        : '已登记合同「' + row.stu_name + ' · ' + row.grade + '」，应付 ' + money(num(row.payable_amount)) + ' 元',
        'ok', 4000);
      state.entry = entryDefaults();
      state.editingId = null;
      state.droppedPlans = [];
      state.tab = 'ledger';
      App.render();
    }).catch(function (e) {
      UI.fail(host, (e && e.message) ? e.message : '保存失败，请重试');
    });
  }

  /* =========================================================
   * 9. Tab ② 合同台账
   * ========================================================= */

  function filteredContracts() {
    var f = state.ledger;
    var kw = String(f.kw || '').trim();
    var from = f.from ? new Date(f.from + 'T00:00:00') : null;
    var to = f.to ? new Date(f.to + 'T23:59:59.999') : null;
    var rows = allContracts().filter(function (r) {
      if (kw && String(r.stu_name || '').indexOf(kw) < 0) return false;
      if (f.grade && String(r.grade || '') !== f.grade) return false;
      if (f.year && String(r.year || '') !== String(f.year)) return false;
      if (f.plan && String(r.plan || '') !== f.plan) return false;
      var t = Date.parse(r.created_at || '');
      if (from && !(t >= from.getTime())) return false;
      if (to && !(t <= to.getTime())) return false;
      return true;
    });
    rows.sort(function (a, b) {
      var ta = Date.parse(a.created_at || '') || 0;
      var tb = Date.parse(b.created_at || '') || 0;
      if (tb !== ta) return tb - ta;
      return idNumber(b) - idNumber(a);
    });
    return rows;
  }

  /** 台账里出现过的方案名称（筛选下拉用） */
  function contractPlanNames() {
    var seen = {}, out = [];
    allContracts().forEach(function (r) {
      var n = String(r.plan || '').trim();
      if (!n || seen[n]) return;
      seen[n] = true;
      out.push(n);
    });
    return out.sort(function (a, b) { return U.zh(a, b); });
  }

  function renderLedger() {
    var f = state.ledger;
    var list = filteredContracts();
    var years = priceYears(allPrices());

    var sumPay = 0, sumOrig = 0, sumDisc = 0;
    list.forEach(function (r) {
      sumPay += num(r.payable_amount);
      sumOrig += num(r.original_amount);
      sumDisc += num(r.discount_amount);
    });

    var h = '<div class="grid g4" style="margin-bottom:14px">' +
      UI.kpi('合同数', list.length + ' 份', '当前筛选结果') +
      UI.kpi('应付金额合计', money(sumPay) + ' 元', '含结余抵扣后') +
      UI.kpi('课时费原价合计', money(sumOrig) + ' 元', '优惠前') +
      UI.kpi('优惠减免合计', money(sumDisc) + ' 元', '不含资料费') +
      '</div>';

    h += '<div class="card"><div class="toolbar" style="flex-wrap:wrap;gap:8px">' +
      '<input id="lg-kw" placeholder="姓名关键字" value="' + esc(f.kw) + '" style="max-width:180px">' +
      '<select id="lg-grade"><option value="">全部年级</option>' +
      UI.optionsWithLabel(UI.GRADES, f.grade) + '</select>' +
      '<select id="lg-year"><option value="">全部年份</option>' +
      UI.optionsWithLabel(years, f.year) + '</select>' +
      '<select id="lg-plan"><option value="">全部方案</option>' +
      UI.optionsWithLabel(contractPlanNames(), f.plan) + '</select>' +
      '<input type="date" id="lg-from" value="' + esc(f.from || '') + '" title="创建时间起">' +
      '<span class="muted">—</span>' +
      '<input type="date" id="lg-to" value="' + esc(f.to || '') + '" title="创建时间止">' +
      '<button id="lg-clear">清空筛选</button>' +
      '<div class="spacer"></div>' +
      '<button class="primary" id="lg-new">去登记合同</button>' +
      '</div>';

    if (!allContracts().length) {
      h += UI.empty('还没有合同。到『① 合同登记』录入第一份合同，或先在『③ 价目维护』新增价目方案。');
      h += '</div>';
      return h;
    }
    if (!list.length) {
      h += '<div class="empty">没有符合筛选条件的合同</div></div>';
      return h;
    }

    h += '<div class="tbl-wrap"><table class="an-table"><thead><tr>' +
      '<th>学生姓名</th><th>年级</th><th class="num">年份</th><th>报读方案</th>' +
      '<th class="num">报读科目数</th><th class="num">课时费原价</th><th>优惠</th>' +
      '<th class="num">应付金额</th><th>创建时间</th><th class="c">操作</th>' +
      '</tr></thead><tbody>';

    list.forEach(function (r) {
      var snap = snapshotResult(r);
      h += '<tr>' +
        '<td><b>' + esc(r.stu_name) + '</b>' + (priceChanged(r)
          ? ' <span class="chip ch-amber" title="价目已变更，明细为签订时快照">价目已变更</span>' : '') + '</td>' +
        '<td>' + esc(r.grade) + '</td>' +
        '<td class="num">' + esc(r.year) + '</td>' +
        '<td>' + esc(r.plan || '—') + '</td>' +
        '<td class="num">' + snap.subjectCount + '</td>' +
        '<td class="num">' + money(num(r.original_amount)) + '</td>' +
        '<td>' + esc(discountText(snap)) + '</td>' +
        '<td class="num"><b>' + money(num(r.payable_amount)) + '</b></td>' +
        '<td class="muted">' + esc(U.hms(r.created_at)) + '</td>' +
        '<td class="c" style="white-space:nowrap">' +
        '<button data-lact="view" data-id="' + esc(r.id) + '">查看明细</button> ' +
        '<button data-lact="edit" data-id="' + esc(r.id) + '">修改</button> ' +
        '<button data-lact="del" data-id="' + esc(r.id) + '" style="color:#c0392b">删除</button>' +
        '</td></tr>';
    });
    h += '</tbody></table></div>' +
      '<div class="hint" style="margin-top:10px">台账金额来自签订时的明细快照（items）；' +
      '价目后续被修改或删除，都不会改变已签合同的历史金额。</div></div>';
    return h;
  }

  /** 快照里的「方案名 + 方案配置」清单（T11 plans / T9 plan / lines-only 三格式通用） */
  function snapshotPlanConfigs(row) {
    var items = (row && row.items) || {};
    var out = [];
    if (Array.isArray(items.plans) && items.plans.length) {
      items.plans.forEach(function (x) {
        var d = (x && x.discount) || {};
        out.push({
          planName: String((x && x.planName) || '').trim(),
          cfg: normalizePlan({
            unit_price: x && x.unit_price,
            stages: x && x.stages,
            discount_type: d.type || 'none',
            discount_value: d.value
          })
        });
      });
      return out;
    }
    if (items.plan) {
      out.push({
        planName: String(items.planName || row.plan || '').trim(),
        cfg: normalizePlan(items.plan)
      });
    }
    return out;
  }

  /** 价目是否已与签订时的快照不一致（PRD §3.6.4：明细为签订时快照） */
  function priceChanged(row) {
    var snaps = snapshotPlanConfigs(row);
    if (!snaps.length) return false;
    for (var i = 0; i < snaps.length; i++) {
      var s = snaps[i];
      var cur = findPlan(allPrices(), row.year, row.grade, s.planName);
      if (!cur) return true;                                   // 方案已删除
      var now = normalizePlan(cur);
      var then = s.cfg;
      if (round2(now.unit_price) !== round2(then.unit_price)) return true;
      if (now.discount_type !== then.discount_type) return true;
      if (Math.abs(num(now.discount_value) - num(then.discount_value)) > 1e-9) return true;
      if (now.stages.length !== then.stages.length) return true;
      for (var k = 0; k < now.stages.length; k++) {
        if (now.stages[k].stage !== then.stages[k].stage) return true;
        if (now.stages[k].sessions !== then.stages[k].sessions) return true;
        if (Math.abs(now.stages[k].material_fee - then.stages[k].material_fee) > 1e-9) return true;
      }
    }
    return false;
  }

  /**
   * 台账「查看明细」弹窗：内容与登记页实时明细同一个 detailCardHTML（T12 需求 9），
   * 弹窗本身加宽到 1120px（横表列多时不挤成一团）。
   */
  function openContractDetail(row) {
    if (!row) return null;
    var snap = snapshotResult(row);
    var body = document.createElement('div');
    var changed = priceChanged(row);
    body.innerHTML = detailCardHTML(
      {
        stu_name: row.stu_name, grade: row.grade, year: row.year,
        planName: snap.planName || row.plan
      },
      snap,
      { note: changed ? '该价目已变更，明细为签订时快照' : '签订时快照' }
    );
    return widenDetailModal(Modal.open({ title: '合同明细', body: body, okText: null, cancelText: '关闭' }));
  }

  /** 快照里一个方案的科目表（多方案/T9 都用） */
  function snapshotSubjects(x) {
    var subs = { A: [], B: [], C: [], D: [] };
    var map = (x && x.subjects) || (x && x.stages) || {};
    var keys = Object.keys(map);
    keys.forEach(function (k) {
      if (subs[k] !== undefined) subs[k] = uniqList(map[k] || []);
    });
    /* 更早的 lines-only 快照：科目只能从 lines 反推 */
    if (!keys.length && x && x.lines && x.lines.length) {
      x.lines.forEach(function (l) {
        if (subs[l.stage] && subs[l.stage].indexOf(l.subject) < 0) subs[l.stage].push(l.subject);
      });
    }
    return subs;
  }

  function loadContractForEdit(row) {
    if (!row) return;
    var items = row.items || {};
    var prices = allPrices();
    var plans = [];

    if (Array.isArray(items.plans) && items.plans.length) {
      /* T11 多方案快照 */
      items.plans.forEach(function (x) {
        var d = (x && x.discount) || {};
        plans.push({
          name: String((x && x.planName) || ''),
          discount: { type: String(d.type || 'none'), value: num(d.value) },
          /* 快照里的优惠就是当时生效的，先按「已手动调整」处理，避免被当前价目预设覆盖 */
          discountTouched: true,
          subjects: snapshotSubjects(x)
        });
      });
    } else {
      /* T9 单方案 object 格式 / 更早的 lines-only 格式 */
      plans.push({
        name: String(items.planName || row.plan || ''),
        discount: { type: String(row.discount_type || 'none'), value: num(row.discount_value) },
        discountTouched: true,
        subjects: snapshotSubjects(items)
      });
    }

    /* 与当前价目预设一致 → 回到「跟随方案」；不一致 → 保留手动调整标记 */
    plans.forEach(function (pe) {
      var cur = findPlan(prices, num(row.year), row.grade, pe.name);
      if (cur && sameDiscount(pe.discount, normalizePlan(cur))) pe.discountTouched = false;
    });

    state.entry = {
      stu_name: String(row.stu_name || ''),
      grade: String(row.grade || ''),
      year: num(row.year),
      plans: plans,
      /* 结余原值 = 已抵扣 + 剩余，回填后可原样重算 */
      balance: round2(num(row.account_deduction) + num(row.balance_remain))
    };
    state.editingId = row.id;
    state.droppedPlans = [];
    state.tab = 'entry';
    App.render();
  }

  function removeContract(row) {
    if (!row) return;
    if (App.Perm && !App.Perm.assertWrite('contracts')) return;
    Modal.confirm(
      '确定删除 <b>' + esc(row.stu_name) + '</b> 在 <b>' + esc(row.grade) + '</b> 的合同吗？<br>' +
      '<span class="muted">应付金额 ' + money(num(row.payable_amount)) +
      ' 元。删除后不可恢复（学生档案与成绩不受影响）。</span>',
      function () {
        contractsTable().remove(row.id).then(function () {
          Toast('已删除合同「' + row.stu_name + ' · ' + row.grade + '」', 'ok');
          if (String(state.editingId) === String(row.id)) {
            state.entry = entryDefaults();
            state.editingId = null;
          }
          App.render();
        }).catch(function (e) {
          Toast('删除失败：' + (e && e.message ? e.message : e), 'error', 6000);
        });
      }, true);
  }

  /* =========================================================
   * 10. Tab ③ 价目维护（方案列表 + 方案表单）
   * ========================================================= */

  /** 方案按 年份 → 年级 分组 */
  function groupPlans(prices) {
    var byYear = {}, years = [];
    (prices || []).forEach(function (p) {
      var y = num(p.year);
      if (!y) return;
      if (!byYear[y]) { byYear[y] = { year: y, grades: {}, gradeOrder: [] }; years.push(y); }
      var g = String(p.grade || '未填年级');
      if (!byYear[y].grades[g]) { byYear[y].grades[g] = []; byYear[y].gradeOrder.push(g); }
      byYear[y].grades[g].push(p);
    });
    years.sort(function (a, b) { return b - a; });          // 年份倒序：新学年在上
    return years.map(function (y) {
      var bucket = byYear[y];
      bucket.gradeOrder.sort(function (a, b) {
        var ia = UI.GRADES.indexOf(a), ib = UI.GRADES.indexOf(b);
        if (ia < 0) ia = 999;
        if (ib < 0) ib = 999;
        if (ia !== ib) return ia - ib;
        return U.zh(a, b);
      });
      return bucket;
    });
  }

  function renderPrices() {
    var prices = allPrices();
    var years = priceYears(prices);
    if (state.priceYear && years.indexOf(num(state.priceYear)) < 0) state.priceYear = '';

    var filtered = state.priceYear
      ? prices.filter(function (p) { return String(p.year) === String(state.priceYear); })
      : prices;

    var h = '<div class="card"><div class="toolbar" style="flex-wrap:wrap;gap:8px">' +
      '<span class="muted">年份</span>' +
      '<select id="pr-year"><option value="">全部年份</option>' +
      UI.optionsWithLabel(years, state.priceYear) + '</select>' +
      '<div class="spacer"></div>' +
      '<button class="primary" id="pr-add">新增方案</button>' +
      '</div>';

    if (!prices.length) {
      h += UI.empty('还没有任何价目方案。点右上『新增方案』录入第一个方案' +
        '（年份 / 年级 / 方案名称 / 课时费原价 / 阶段配置 / 报读优惠）。');
      h += '</div>';
      return h;
    }
    if (!filtered.length) {
      h += UI.empty('该年份还没有方案，换一个年份或点『新增方案』。');
      h += '</div>';
      return h;
    }

    h += '<div class="muted" style="margin:6px 0">共 ' + filtered.length +
      ' 个方案 · 一个方案一行 · 唯一键：年份 + 年级 + 方案名称</div>';

    groupPlans(filtered).forEach(function (bucket) {
      h += '<div style="margin:14px 0 6px;font-weight:600;font-size:14px">' +
        esc(bucket.year) + ' 年</div>';
      bucket.gradeOrder.forEach(function (g) {
        var list = bucket.grades[g].slice().sort(function (a, b) {
          return U.zh(String(a.plan_name || ''), String(b.plan_name || ''));
        });
        h += '<div class="tbl-wrap" style="margin-bottom:10px">' +
          '<table class="an-table"><thead><tr>' +
          '<th>' + esc(g) + '</th><th>方案名称</th><th>阶段组合</th>' +
          '<th class="num">课时费原价(元/科/次课)</th><th>报读优惠</th><th>备注</th>' +
          '<th>最近修改</th><th class="c">操作</th>' +
          '</tr></thead><tbody>';
        list.forEach(function (p) {
          var np = normalizePlan(p);
          var rk = String(p.remark || '').trim();
          var rkShort = rk.length > 24 ? rk.slice(0, 24) + '…' : rk;
          h += '<tr data-prow="' + esc(p.id) + '">' +
            '<td class="muted">' + esc(g) + '</td>' +
            '<td><b>' + esc(p.plan_name) + '</b></td>' +
            '<td>' + esc(planSummary(np)) + '</td>' +
            '<td class="num">' + money(np.unit_price) + '</td>' +
            '<td>' + esc(planDiscountText(np)) + '</td>' +
            '<td class="muted" style="max-width:220px">' + (rk
              ? '<span title="' + esc(rk) + '">' + esc(rkShort) + '</span>'
              : '<span style="color:#b9c0c8">—</span>') + '</td>' +
            '<td class="muted">' + esc(U.hms(p.updated_at || p.created_at)) + '</td>' +
            '<td class="c" style="white-space:nowrap">' +
            '<button data-pact="edit" data-id="' + esc(p.id) + '">编辑</button> ' +
            '<button data-pact="del" data-id="' + esc(p.id) + '" style="color:#c0392b">删除</button>' +
            '</td></tr>';
        });
        h += '</tbody></table></div>';
      });
    });

    h += '<div class="hint" style="margin-top:10px">一个方案 = 一行：方案可含任意阶段组合（如 A+B），' +
      '每个阶段有自己的上课次数与「单季度单科目资料费」。' +
      '合同登记时**可同时勾选多个方案**，每个方案独立计价、独立优惠；' +
      '报读费用 = 课时单价 × 各阶段次数 × 该阶段科目数 ＋ 资料费（按阶段分别收取）− 优惠；' +
      '优惠只作用于课时费，资料费永不参与任何优惠。' +
      '方案备注会显示在价目列表与合同明细单里。价目被修改或删除后，已签合同仍保留签订时的金额快照。</div></div>';
    return h;
  }

  /* --- 方案表单（自定义多行阶段编辑器，不用 formGrid） --- */

  function stageRowsHTML(rows) {
    return (rows || []).map(function (r, i) {
      return '<tr data-strow="' + i + '">' +
        '<td><select data-role="stage">' + UI.optionsWithLabel(STAGE_LIST, r.stage) + '</select></td>' +
        '<td><input type="number" data-role="sessions" min="1" max="200" step="1" value="' +
        esc(r.sessions === '' || r.sessions === null || r.sessions === undefined ? '' : r.sessions) +
        '" style="max-width:110px;text-align:right"></td>' +
        '<td><input type="number" data-role="material_fee" min="0" step="0.01" value="' +
        esc(r.material_fee === null || r.material_fee === undefined ? DEFAULT_MATERIAL : r.material_fee) +
        '" style="max-width:120px;text-align:right"></td>' +
        '<td class="c"><button type="button" data-del-row="' + i + '" class="ghost"' +
        ((rows || []).length <= 1 ? ' disabled style="opacity:.4"' : '') + '>删除</button></td>' +
        '</tr>';
    }).join('');
  }

  /** 从表单 DOM 读出方案草稿（供校验与预览） */
  function readPlanForm(body) {
    var q = function (sel) {
      var el = body.querySelector(sel);
      return el ? el.value : '';
    };
    var rows = [];
    Array.prototype.forEach.call(body.querySelectorAll('[data-strow]'), function (tr) {
      var st = tr.querySelector('[data-role="stage"]');
      var sn = tr.querySelector('[data-role="sessions"]');
      var mf = tr.querySelector('[data-role="material_fee"]');
      rows.push({
        stage: String(st ? st.value : ''),
        sessions: sn ? sn.value : '',
        material_fee: mf ? mf.value : ''
      });
    });
    var discType = 'none';
    Array.prototype.forEach.call(body.querySelectorAll('[name="pl-disc"]'), function (rb) {
      if (rb.checked) discType = String(rb.getAttribute('value') || 'none');
    });
    var discVal = 0;
    /* 折扣存**原始输入**（'85'）交给 validatePlan 判断合法性；
       归一（85 → 0.85）由 normalizePlan / previewPlan 负责。 */
    if (discType === 'pct') discVal = String(q('#pl-pct') || '').trim();
    else if (discType === 'amount') discVal = String(q('#pl-amount') || '').trim();
    return {
      year: q('#pl-year'),
      grade: q('#pl-grade'),
      plan_name: String(q('#pl-name') || '').trim(),
      unit_price: q('#pl-price'),
      stages: rows,
      discount_type: discType,
      discount_value: discVal,
      /* T11：方案备注（选填，≤200 字）；只在明细单里展示，不参与计价 */
      remark: String(q('#pl-remark') || '').trim()
    };
  }

  /** 预览行：假设每阶段各报 1 科 */
  function previewHTML(form) {
    var p = normalizePlan({
      unit_price: form.unit_price,
      stages: form.stages,
      discount_type: form.discount_type,
      discount_value: form.discount_value
    });
    if (!p.stages.length || !(p.unit_price > 0)) {
      return '<span class="muted">填好课时单价与阶段次数后，这里会给出 1 科的试算结果。</span>';
    }
    var pv = previewPlan(p);
    return '<b>示例（每个阶段各报 1 科）</b>：' + esc(pv.formula) +
      '　→　<b>应付 ' + money(pv.payable) + ' 元</b>';
  }

  function openPlanForm(existing) {
    if (App.Perm && !App.Perm.assertWrite('contracts')) return null;
    var years = priceYears(allPrices());
    var defYear = existing ? num(existing.year)
      : (state.priceYear ? num(state.priceYear)
        : (years.length ? years[years.length - 1] : new Date().getFullYear()));
    var np = normalizePlan(existing || {});
    var initRows = np.stages.length
      ? np.stages.map(function (s) {
        return { stage: s.stage, sessions: s.sessions, material_fee: s.material_fee };
      })
      : [{ stage: 'A', sessions: '', material_fee: DEFAULT_MATERIAL }];

    var body = document.createElement('div');
    body.innerHTML =
      '<div data-form-err></div>' +
      '<div class="form-grid">' +
      '<label class="f">年份 *<input type="number" id="pl-year" min="' + YEAR_MIN + '" max="' + YEAR_MAX +
      '" step="1" value="' + esc(defYear) + '">' +
      '<span class="muted" style="font-size:12px">可新增年份，如 ' + (new Date().getFullYear() + 1) + '</span></label>' +
      '<label class="f">年级 *<select id="pl-grade"><option value="">请选择</option>' +
      UI.optionsWithLabel(UI.GRADES, existing ? existing.grade : '') + '</select></label>' +
      '<label class="f">方案名称 *<input type="text" id="pl-name" maxlength="' + PLAN_NAME_MAX +
      '" value="' + esc(existing ? existing.plan_name : '') + '" placeholder="如：寒春连报">' +
      '<span class="muted" style="font-size:12px">1–' + PLAN_NAME_MAX + ' 字，同年份年级内不可重名</span></label>' +
      '<label class="f">课时费原价（元/科目/次课）*<input type="number" id="pl-price" min="0" step="0.01" value="' +
      esc(np.unit_price > 0 ? np.unit_price : '') + '"></label>' +
      '</div>' +

      '<div style="margin-top:14px">' +
      '<div class="muted" style="font-size:12.5px;font-weight:600;margin-bottom:6px">' +
      '阶段配置 * <span style="font-weight:400">（一个方案可含多个阶段，如寒春连报 = A + B）</span></div>' +
      '<div class="tbl-wrap"><table class="an-table"><thead><tr>' +
      '<th>阶段</th><th class="num">上课次数(1-200)</th>' +
      '<th class="num">单季度单科目资料费(元)</th><th class="c">操作</th>' +
      '</tr></thead><tbody id="pl-rows">' + stageRowsHTML(initRows) + '</tbody></table></div>' +
      '<button type="button" id="pl-add-row" class="ghost" style="margin-top:8px">+ 添加阶段</button>' +
      '</div>' +

      '<div style="margin-top:14px">' +
      '<div class="muted" style="font-size:12.5px;font-weight:600;margin-bottom:6px">报读优惠</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center">' +
      '<span class="muted" style="display:inline-flex;align-items:center;gap:6px;font-size:13px">' +
      '<input type="radio" name="pl-disc" value="none"' +
      (np.discount_type === 'none' ? ' checked' : '') + '>无优惠</span>' +
      '<span class="muted" style="display:inline-flex;align-items:center;gap:6px;font-size:13px">' +
      '<input type="radio" name="pl-disc" value="pct"' +
      (np.discount_type === 'pct' ? ' checked' : '') + '>课时费折扣' +
      '<input type="number" id="pl-pct" min="1" max="100" step="1" style="max-width:90px" ' +
      'value="' + esc(np.discount_type === 'pct' ? Math.round(np.discount_value * 1000) / 10 : 85) + '">%</span>' +
      '<span class="muted" style="display:inline-flex;align-items:center;gap:6px;font-size:13px">' +
      '<input type="radio" name="pl-disc" value="amount"' +
      (np.discount_type === 'amount' ? ' checked' : '') + '>课时费金额减免' +
      '<input type="number" id="pl-amount" min="0" step="0.01" style="max-width:110px" ' +
      'value="' + esc(np.discount_type === 'amount' ? np.discount_value : '') + '">元</span>' +
      '</div>' +
      '<div class="hint" style="margin-top:8px">优惠只作用于课时费（可折扣或减免金额），' +
      '<b>资料费不参与任何优惠</b>。折扣请填百分数：<b>85 表示 85 折</b>、80 表示 8 折。</div>' +
      '</div>' +

      /* T11 需求 4：方案备注（选填，≤200 字），会随合同快照进明细单 */
      '<div style="margin-top:14px">' +
      '<div class="muted" style="font-size:12.5px;font-weight:600;margin-bottom:6px">' +
      '备注 <span style="font-weight:400">（选填，≤' + REMARK_MAX + ' 字；会显示在价目列表与合同明细里）</span></div>' +
      '<textarea id="pl-remark" rows="2" maxlength="' + REMARK_MAX + '" ' +
      'style="width:100%;box-sizing:border-box;resize:vertical" ' +
      'placeholder="如：含 4 次晚辅、不含教材费">' +
      esc(existing ? String(existing.remark || '') : '') + '</textarea>' +
      '</div>' +

      '<div class="hint" id="pl-preview" style="margin-top:12px">' + previewHTML(readPlanFormShallow(body, initRows, defYear, existing, np)) + '</div>';

    /* 预填不依赖 DOM 读值（渲染时输入框可能还没挂上），先算一遍初始预览 */
    var modal = UI.formModal({
      title: existing ? '编辑价目方案' : '新增价目方案',
      body: body,
      okText: existing ? '保存修改' : '保存',
      onSubmit: function () {
        UI.clearError(body);
        var form = readPlanForm(body);
        var err = validatePlan(form, allPrices(), existing ? existing.id : null);
        if (err) { UI.fail(body, err); return false; }

        var cleanStages = (form.stages || []).map(function (s) {
          return {
            stage: String(s.stage || '').toUpperCase(),
            sessions: Math.round(num(s.sessions)),
            material_fee: round2(num(s.material_fee))
          };
        }).sort(function (a, b) { return stageOrder(a.stage) - stageOrder(b.stage); });

        var payload = {
          year: Math.round(num(form.year)),
          grade: String(form.grade || ''),
          plan_name: String(form.plan_name || '').trim(),
          unit_price: round2(num(form.unit_price)),
          stages: cleanStages,
          discount_type: form.discount_type,
          /* 表单里折扣填的是百分数（85），落库统一存系数（0.85） */
          discount_value: form.discount_type === 'pct'
            ? round2(parseRate(form.discount_value))
            : (form.discount_type === 'amount' ? round2(num(form.discount_value)) : 0),
          /* T11：方案备注（选填） */
          remark: String(form.remark || '').trim()
        };

        var p = existing ? pricesTable().update(existing.id, payload) : pricesTable().insert(payload);
        p.then(function (row) {
          Toast(existing ? '已保存方案「' + row.plan_name + '」' : '已新增方案「' + row.plan_name + '」', 'ok');
          state.priceYear = num(row.year);
          App.render();
        }).catch(function (e) {
          UI.fail(body, (e && e.message) ? e.message : '保存失败，请重试');
        });
        return true;
      }
    });

    /* ---- 交互：增删阶段行 / 优惠单选 / 实时预览 ---- */
    function rerenderRows() {
      var rows = [];
      Array.prototype.forEach.call(body.querySelectorAll('[data-strow]'), function (tr) {
        var st = tr.querySelector('[data-role="stage"]');
        var sn = tr.querySelector('[data-role="sessions"]');
        var mf = tr.querySelector('[data-role="material_fee"]');
        rows.push({
          stage: String(st ? st.value : 'A'),
          sessions: sn ? sn.value : '',
          material_fee: mf ? mf.value : DEFAULT_MATERIAL
        });
      });
      return rows;
    }

    function paintRows(rows) {
      var box = body.querySelector('#pl-rows');
      if (box) box.innerHTML = stageRowsHTML(rows);
    }

    function updatePreview() {
      var box = body.querySelector('#pl-preview');
      if (box) box.innerHTML = previewHTML(readPlanForm(body));
    }

    var addRow = body.querySelector('#pl-add-row');
    if (addRow) addRow.addEventListener('click', function () {
      var rows = rerenderRows();
      var used = {};
      rows.forEach(function (r) { used[String(r.stage)] = true; });
      var next = 'A';
      for (var i = 0; i < STAGE_LIST.length; i++) {
        if (!used[STAGE_LIST[i]]) { next = STAGE_LIST[i]; break; }
      }
      rows.push({ stage: next, sessions: '', material_fee: DEFAULT_MATERIAL });
      paintRows(rows);
      updatePreview();
    });

    body.addEventListener('click', function (ev) {
      var t = ev && ev.target;
      if (!t || !t.getAttribute) return;
      var idx = t.getAttribute('data-del-row');
      if (idx === null || idx === undefined) return;
      var rows = rerenderRows();
      if (rows.length <= 1) return;                 // 至少保留 1 行
      rows.splice(Number(idx), 1);
      paintRows(rows);
      updatePreview();
    });

    Array.prototype.forEach.call(body.querySelectorAll('[name="pl-disc"]'), function (rb) {
      rb.addEventListener('change', updatePreview);
    });
    ['#pl-price', '#pl-pct', '#pl-amount', '#pl-year', '#pl-grade', '#pl-name'].forEach(function (sel) {
      var el = body.querySelector(sel);
      if (el) el.addEventListener('input', updatePreview);
      if (el) el.addEventListener('change', updatePreview);
    });
    body.addEventListener('input', function (ev) {
      var t = ev && ev.target;
      if (t && t.getAttribute && t.getAttribute('data-role')) updatePreview();
    });

    updatePreview();
    return modal;
  }

  /** 初始预览用的浅读（不依赖 DOM，只用已有值） */
  function readPlanFormShallow(body, rows, defYear, existing, np) {
    return {
      year: defYear,
      grade: existing ? existing.grade : '',
      plan_name: existing ? existing.plan_name : '',
      unit_price: np.unit_price,
      stages: rows,
      discount_type: np.discount_type,
      discount_value: np.discount_value,
      remark: existing ? String(existing.remark || '') : ''
    };
  }

  function removePlanRow(row) {
    if (!row) return;
    if (App.Perm && !App.Perm.assertWrite('contracts')) return;
    Modal.confirm(
      '确定删除方案 <b>' + esc(row.plan_name) + '</b>（' + esc(row.year) + ' 年 · ' +
      esc(row.grade) + '）吗？<br><span class="muted">已签订的合同保留签订时的金额快照，不受影响；' +
      '未签合同再次登记该方案时会提示先新增方案。</span>',
      function () {
        pricesTable().remove(row.id).then(function () {
          Toast('已删除方案「' + row.plan_name + '」', 'ok');
          App.render();
        }).catch(function (e) {
          Toast('删除失败：' + (e && e.message ? e.message : e), 'error', 6000);
        });
      }, true);
  }

  /* =========================================================
   * 11. 模块注册
   * ========================================================= */

  App.registerModule({
    id: 'contracts',
    name: '合同确认',
    icon: ICON,
    ready: true,
    adminOnly: true,
    order: 50,
    title: '合同确认',
    subtitle: '价目方案 · 合同登记 · 优惠明细单 · 合同台账',

    render: function () {
      /* L3 直达拦截：非管理员手输 #/contracts 时输出统一 403 卡片 */
      if (App.Perm && App.Perm.denied(this)) return App.Perm.forbiddenCard(this);

      var h = '<div class="toolbar" style="margin-bottom:14px">';
      TABS.forEach(function (t) {
        h += '<button data-tab="' + t.id + '"' + (state.tab === t.id ? ' class="primary"' : '') + '>' +
          t.name + '</button>';
      });
      h += '</div>';

      if (state.tab === 'ledger') h += renderLedger();
      else if (state.tab === 'prices') h += renderPrices();
      else h += renderEntry();
      return h;
    },

    bind: function (host) {
      if (!host || !host.querySelectorAll) return;

      Array.prototype.forEach.call(host.querySelectorAll('[data-tab]'), function (b) {
        b.addEventListener('click', function () {
          state.tab = b.getAttribute('data-tab');
          App.render();
        });
      });

      if (state.tab === 'prices') { bindPrices(host); return; }
      if (state.tab === 'ledger') { bindLedger(host); return; }
      bindEntry(host);
    }
  });

  /* ---- Tab ① 绑定 ---- */
  function bindEntry(host) {
    var e = state.entry;

    /* 上一轮挂载的组件随整页重绘已失效，先清空引用 */
    resetMounts();

    var nameEl = host.querySelector('#ct-name');
    if (nameEl) {
      U.onCommitted(nameEl, function (v) {
        e.stu_name = String(v || '').trim();
        refreshDetail(host);
      });
      nameEl.addEventListener('change', function () {
        e.stu_name = String(nameEl.value || '').trim();
        refreshDetail(host);
      });
    }

    var gradeEl = host.querySelector('#ct-grade');
    if (gradeEl) gradeEl.addEventListener('change', function () {
      e.grade = String(gradeEl.value || '');
      e.plans = [];                        // 年级变了 → 方案要重选（原来勾的都不再适用）
      state.droppedPlans = [];
      App.render();
    });

    var yearEl = host.querySelector('#ct-year');
    if (yearEl) yearEl.addEventListener('change', function () {
      e.year = yearEl.value === '' ? '' : num(yearEl.value);
      e.plans = [];
      state.droppedPlans = [];
      App.render();
    });

    /* 报读方案多选：勾一个 = 加一个方案块，取消勾选 = 移除该块 */
    Array.prototype.forEach.call(host.querySelectorAll('[data-plan-name]'), function (cb) {
      cb.addEventListener('change', function () {
        var name = String(cb.getAttribute('data-plan-name') || '');
        var hit = -1;
        (e.plans || []).forEach(function (pe, k) { if (pe.name === name) hit = k; });
        if (cb.checked) {
          if (hit < 0) {
            var row = findPlan(allPrices(), e.year, e.grade, name);
            if (row) e.plans.push(planEntryDefaults(row));
          }
        } else if (hit >= 0) {
          e.plans.splice(hit, 1);
        }
        App.render();
      });
    });

    /* 每个方案的每个阶段各挂一个科目多选 */
    (e.plans || []).forEach(function (pe, idx) {
      var row = findPlan(allPrices(), e.year, e.grade, pe.name);
      if (!row) return;
      planStageList(row).forEach(function (st) { mountStage(host, idx, st); });
    });

    /* 每个方案自己的优惠单选（discountTouched 每方案一份） */
    Array.prototype.forEach.call(host.querySelectorAll('[data-disc][data-plan]'), function (rb) {
      rb.addEventListener('change', function () {
        if (!rb.checked) return;
        var idx = Number(rb.getAttribute('data-plan'));
        var pe = e.plans[idx];
        if (!pe) return;
        var key = rb.getAttribute('data-disc');
        var row = findPlan(allPrices(), e.year, e.grade, pe.name);
        var preset = normalizePlan(row || {});
        if (key === 'none') {
          pe.discount = { type: 'none', value: 0 };
        } else if (key === 'pct') {
          pe.discount = {
            type: 'pct',
            value: preset.discount_type === 'pct' ? preset.discount_value
              : normRate(pe.discount && pe.discount.type === 'pct' ? pe.discount.value : 0.85)
          };
        } else {
          pe.discount = {
            type: 'amount',
            value: preset.discount_type === 'amount' ? preset.discount_value
              : num(pe.discount && pe.discount.type === 'amount' ? pe.discount.value : 0)
          };
        }
        pe.discountTouched = !sameDiscount(pe.discount, preset);
        if (pe.discountTouched) Toast('已手动调整优惠，与方案预设不同', 'warn', 3600);
        App.render();
      });
    });

    /* 每个方案的折扣 / 减免输入 */
    (e.plans || []).forEach(function (pe, idx) {
      var row = findPlan(allPrices(), e.year, e.grade, pe.name);
      var preset = normalizePlan(row || {});

      var pctEl = host.querySelector('#ct-pct-' + idx);
      if (pctEl) {
        pctEl.addEventListener('input', function () {
          /* 存原始输入（85），归一在计价与展示层做；否则用户输 101 会被抹成 1 而逃过校验 */
          pe.discount = { type: 'pct', value: UI.numOrNull(pctEl.value) };
          pe.discountTouched = !sameDiscount(pe.discount, preset);
          refreshDetail(host);
        });
        pctEl.addEventListener('change', function () {
          if (pe.discountTouched) Toast('已手动调整优惠，与方案预设不同', 'warn', 3600);
        });
      }

      var offEl = host.querySelector('#ct-off-' + idx);
      if (offEl) {
        offEl.addEventListener('input', function () {
          pe.discount = { type: 'amount', value: UI.numOrNull(offEl.value) };
          pe.discountTouched = !sameDiscount(pe.discount, preset);
          refreshDetail(host);
        });
        offEl.addEventListener('change', function () {
          if (pe.discountTouched) Toast('已手动调整优惠，与方案预设不同', 'warn', 3600);
        });
      }
    });

    var balEl = host.querySelector('#ct-balance');
    if (balEl) balEl.addEventListener('input', function () {
      e.balance = UI.numOrNull(balEl.value);
      refreshDetail(host);
    });

    var saveBtn = host.querySelector('#ct-save');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveEntry(host); });

    var reset = function () {
      state.entry = entryDefaults();
      state.editingId = null;
      state.droppedPlans = [];
      App.render();
    };
    var resetBtn = host.querySelector('#ct-reset');
    if (resetBtn) resetBtn.addEventListener('click', reset);
    var cancelEdit = host.querySelector('#ct-cancel-edit');
    if (cancelEdit) cancelEdit.addEventListener('click', reset);

    refreshDetail(host);
  }

  /** 当前优惠是否与方案预设一致 */
  function sameDiscount(d, preset) {
    var x = resolveDiscount(d, preset);
    var p = normalizePlan(preset);
    return x.type === p.discount_type &&
      Math.abs(num(x.value) - num(p.discount_value)) < 1e-9;
  }

  /* ---- Tab ② 绑定 ---- */
  function bindLedger(host) {
    var f = state.ledger;

    var kwEl = host.querySelector('#lg-kw');
    if (kwEl) U.onCommitted(kwEl, function (v) {
      if (String(v) === f.kw) return;
      f.kw = String(v || '');
      state.refocus = '#lg-kw';
      App.render();
    });

    var pairs = [['#lg-grade', 'grade'], ['#lg-year', 'year'], ['#lg-plan', 'plan']];
    pairs.forEach(function (p) {
      var el = host.querySelector(p[0]);
      if (el) el.addEventListener('change', function () { f[p[1]] = String(el.value || ''); App.render(); });
    });

    var fromEl = host.querySelector('#lg-from');
    if (fromEl) fromEl.addEventListener('change', function () { f.from = String(fromEl.value || ''); App.render(); });
    var toEl = host.querySelector('#lg-to');
    if (toEl) toEl.addEventListener('change', function () { f.to = String(toEl.value || ''); App.render(); });

    var clear = host.querySelector('#lg-clear');
    if (clear) clear.addEventListener('click', function () {
      state.ledger = { kw: '', grade: '', year: '', plan: '', from: '', to: '' };
      App.render();
    });

    var add = host.querySelector('#lg-new');
    if (add) add.addEventListener('click', function () {
      state.entry = entryDefaults();
      state.editingId = null;
      state.tab = 'entry';
      App.render();
    });

    Array.prototype.forEach.call(host.querySelectorAll('[data-lact]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var row = contractsTable().get(id);
        if (!row) return;
        var act = b.getAttribute('data-lact');
        if (act === 'view') openContractDetail(row);
        else if (act === 'edit') loadContractForEdit(row);
        else if (act === 'del') removeContract(row);
      });
    });

    if (state.refocus) {
      var t = host.querySelector(state.refocus);
      state.refocus = '';
      if (t) { t.focus(); try { t.setSelectionRange(t.value.length, t.value.length); } catch (e) { } }
    }
  }

  /* ---- Tab ③ 绑定 ---- */
  function bindPrices(host) {
    var yearEl = host.querySelector('#pr-year');
    if (yearEl) yearEl.addEventListener('change', function () {
      state.priceYear = yearEl.value === '' ? '' : num(yearEl.value);
      App.render();
    });

    var add = host.querySelector('#pr-add');
    if (add) add.addEventListener('click', function () { openPlanForm(null); });

    Array.prototype.forEach.call(host.querySelectorAll('[data-pact]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var act = b.getAttribute('data-pact');
        var row = pricesTable().get(id);
        if (act === 'edit') { if (row) openPlanForm(row); return; }
        if (row) removePlanRow(row);
      });
    });
  }

  /* =========================================================
   * 12. 对外（后续模块 / 调试用）
   * ========================================================= */
  App.Contracts = {
    openPlanForm: openPlanForm,
    openPriceForm: openPlanForm,        // 兼容旧名
    openContractDetail: openContractDetail,
    loadContractForEdit: loadContractForEdit,
    saveEntry: saveEntry,
    state: state
  };
})(window.App);
