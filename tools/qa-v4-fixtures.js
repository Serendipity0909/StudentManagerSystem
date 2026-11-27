/* =========================================================
 * tools/qa-v4-fixtures.js —— v4 纯函数层测试 · 假数据夹具（CommonJS）
 *
 * 由 tools/qa-v4-core.js require；纯 POJO，不含任何生产依赖、不读磁盘、不碰 DOM。
 * 只导出夹具数据 / 工厂，不写任何断言（断言全在 qa-v4-core.js）。
 *
 * 时区口径：本套夹具必须以 TZ=Asia/Shanghai 运行。
 *   UI.fromDateInput('2026-03-01') = new Date('2026-03-01T00:00:00').toISOString()
 *   在 UTC+8 下 = '2026-02-28T16:00:00.000Z'（本地展示 2026-03-01 00:00）。
 *   若用 iso.slice(0,7) 会错判为 '2026-02'（V-D3）；localYm 必须得 '2026-03'。
 *
 * 覆盖：
 *   · V-D3「2026-03-01 命中 2026-03」边界行（MARCH_BOUNDARY / boundaryRow）
 *   · V-C4「切类型后旧值残留」脏值 form（dirtyCrossTypeForm）
 *   · B-3 / V-E1「同一人多条」（samePersonRows）
 *   · 客户行带 / 不带 intent_level（V-A5 哨兵 __blank__）
 *   · S-1~S-9 结停课筛选数据集、V-G2 统计 golden 数据集、三级排序数据集
 * ========================================================= */
'use strict';

/* ---------------- 日期常量（均标注 TZ=Asia/Shanghai 下的本地年月） ---------------- */
var ISO = {
  /* V-D3 边界：UI.fromDateInput('2026-03-01') 在 UTC+8 的 ISO = 本地 2026-03-01 00:00 */
  MARCH_BOUNDARY: '2026-02-28T16:00:00.000Z', // 本地 2026-03
  JAN: '2026-01-10T02:00:00.000Z',            // 本地 2026-01
  FEB: '2026-02-15T02:00:00.000Z',            // 本地 2026-02
  MAR: '2026-03-15T02:00:00.000Z',            // 本地 2026-03
  APR: '2026-04-20T02:00:00.000Z',            // 本地 2026-04
  PAST: '2020-01-15T02:00:00.000Z',           // 稳定过去日期：合法表单不触发未来软提示
  FUTURE: '2099-12-31T00:00:00.000Z',         // 稳定未来日期：OQ-1 A 软提示
  APPLY_AT: '2020-03-20T00:00:00.000Z',       // 退费提交时间（较晚）
  ARRIVED_AT: '2020-03-10T00:00:00.000Z',     // 退费到账时间（早于提交，OQ-3 A）
  INVALID: 'not-a-date'
};

/* UI.GRADES 内的合法值（夹具不依赖生产 js，值写死后由 qa-v4-core.js 校验与 UI.GRADES 一致） */
var GRADE_OK = '初一';

/* ---------------- 通用工厂 ---------------- */

/** 完整合法「退费资源」行；over 逐键覆盖。业务列与 ddl-v4 一致。 */
function makeStop(over) {
  var base = {
    id: 1,
    stu_name: '张三', phone: '13800138000', grade: GRADE_OK, school: '第一中学',
    stop_date: ISO.MAR, resource_type: '退费资源', teacher: '王老师',
    followup_intent: '高',
    refund_reason: '课程不合适', refund_subjects: '数学、英语',
    refund_amount: 3000, parent_confirmed: true, refund_applied: true,
    refund_apply_at: ISO.FEB, refund_arrived: false, refund_arrived_at: null,
    nonrenew_reason: '', end_subjects: '',
    created_at: ISO.MAR
  };
  Object.keys(over || {}).forEach(function (k) { base[k] = over[k]; });
  return base;
}

/** 完整合法「未续费资源」行（退费专属列均为空值）。 */
function makeNonrenew(over) {
  var base = makeStop({
    id: 2, resource_type: '未续费资源',
    refund_reason: '', refund_subjects: '', refund_amount: null,
    parent_confirmed: false, refund_applied: false, refund_apply_at: null,
    refund_arrived: false, refund_arrived_at: null,
    nonrenew_reason: '搬家转学', end_subjects: '语文、物理'
  });
  Object.keys(over || {}).forEach(function (k) { base[k] = over[k]; });
  return base;
}

/** 完整合法客户行（默认不写 intent_level = 存量未填写）。 */
function makeCustomer(over) {
  var base = {
    id: 1, stu_name: '客户甲', phone: '13900139000', grade: '初二',
    school: '第二中学', resource_type: '上门咨询', created_at: ISO.MAR,
    visited: false, visit_at: null, paid: false, paid_at: null, paid_amount: null
  };
  Object.keys(over || {}).forEach(function (k) { base[k] = over[k]; });
  return base;
}

/* ---------------- 具名单行夹具 ---------------- */

/** 合法退费资源行 */
function refundRow() { return makeStop({ id: 101, stu_name: '退费甲' }); }

/** 合法未续费资源行 */
function nonrenewRow() { return makeNonrenew({ id: 102, stu_name: '未续费乙' }); }

/** V-D3：stop_date 用 2026-03-01 本地语义 ISO，localYm 必须得 '2026-03'。 */
function boundaryRow() {
  return makeStop({ id: 103, stu_name: '边界丙', stop_date: ISO.MARCH_BOUNDARY });
}

/** V-C4：会话内切到「未续费资源」，退费专属字段仍是旧脏值（hidden+disabled 不清空）。
 *  normalize 必须把它们强制写成 '' / false / null 且键仍存在（pick() 保留 null）。 */
function dirtyCrossTypeForm() {
  return {
    id: 104, stu_name: '切换丁', phone: '13800138000', grade: GRADE_OK,
    school: '第一中学', stop_date: ISO.MAR, resource_type: '未续费资源',
    teacher: '李老师', followup_intent: '中',
    refund_reason: '旧退费原因', refund_subjects: '旧退费科目',
    refund_amount: 8888, parent_confirmed: true, refund_applied: true,
    refund_apply_at: ISO.FEB, refund_arrived: true, refund_arrived_at: ISO.MAR,
    nonrenew_reason: '课时用完', end_subjects: '数学',
    created_at: ISO.MAR
  };
}

/** B-3 / V-E1：同一人（同姓名同电话）多条，跨类型跨月份；filterRows 不得去重。 */
function samePersonRows() {
  return [
    makeStop({ id: 201, stu_name: '王小明', phone: '13800000001', stop_date: ISO.JAN }),
    makeNonrenew({ id: 202, stu_name: '王小明', phone: '13800000001', stop_date: ISO.FEB }),
    makeStop({ id: 203, stu_name: '王小明', phone: '13800000001', stop_date: ISO.MAR })
  ];
}

/** 客户行：带 intent_level */
function customerRowWithIntent() { return makeCustomer({ id: 301, intent_level: '高' }); }

/** 客户行：不带 intent_level（存量行，无该字段） */
function customerRowWithoutIntent() { return makeCustomer({ id: 302 }); }

/* ---------------- 合法表单（validate 用；stop_date 用稳定过去日期） ---------------- */

function validCustomerForm() {
  return {
    stu_name: '客户甲', school: '第二中学', phone: '13900139000',
    grade: '初二', resource_type: '上门咨询', intent_level: '高',
    intended_product: '一对一', intended_subjects: ['语文', '数学'],
    visited: false, paid: false, test_status: '未测评'
  };
}

function validRefundForm() {
  return {
    stu_name: '退费甲', phone: '13800138000', grade: GRADE_OK, school: '第一中学',
    stop_date: ISO.PAST, resource_type: '退费资源', teacher: '王老师',
    followup_intent: '高',
    refund_reason: '课程不合适', refund_subjects: '数学', refund_amount: 3000
  };
}

function validNonrenewForm() {
  return {
    stu_name: '未续费乙', phone: '13800138000', grade: GRADE_OK, school: '第一中学',
    stop_date: ISO.PAST, resource_type: '未续费资源', teacher: '王老师',
    followup_intent: '中',
    nonrenew_reason: '搬家转学', end_subjects: '语文、物理'
  };
}

/* ---------------- 结停课资源筛选数据集（S-1~S-9 全覆盖） ----------------
 * id  | 姓名   | 电话         | 年级 | 学校         | 本地月  | 类型     | 回流 | pc   | ra   | rr
 * 501 | 张三   | 13800138000  | 初一 | 第一中学     | 2026-01 | 退费     | 高   | true | true | false
 * 502 | 张三   | 13900139000  | 初二 | 第二中学     | 2026-02 | 未续费   | 中   | false| false| false
 * 503 | Alice  | 13700137000  | 初三 | Alpha School | 2026-03*| 退费     | 低   | false| false| true   (*边界 ISO)
 * 504 | bob    | 13600136000  | 高一 | 第一中学     | 2026-03 | 退费     | 高   | true | true | true
 * 505 | 陈大   | 13500135000  | 初一 | alpha school | 2026-04 | 未续费   | 高   | false| false| false
 * 506 | Dave   | 13400134000  | 初二 | Beta School  | 2026-02 | 退费     | 中   | true | false| false
 */
function stopFilterDataset() {
  return [
    makeStop({
      id: 501, stu_name: '张三', phone: '13800138000', grade: '初一', school: '第一中学',
      stop_date: ISO.JAN, resource_type: '退费资源', followup_intent: '高',
      parent_confirmed: true, refund_applied: true, refund_arrived: false
    }),
    makeNonrenew({
      id: 502, stu_name: '张三', phone: '13900139000', grade: '初二', school: '第二中学',
      stop_date: ISO.FEB, resource_type: '未续费资源', followup_intent: '中',
      parent_confirmed: false, refund_applied: false, refund_arrived: false
    }),
    makeStop({
      id: 503, stu_name: 'Alice', phone: '13700137000', grade: '初三', school: 'Alpha School',
      stop_date: ISO.MARCH_BOUNDARY, resource_type: '退费资源', followup_intent: '低',
      parent_confirmed: false, refund_applied: false, refund_arrived: true
    }),
    makeStop({
      id: 504, stu_name: 'bob', phone: '13600136000', grade: '高一', school: '第一中学',
      stop_date: ISO.MAR, resource_type: '退费资源', followup_intent: '高',
      parent_confirmed: true, refund_applied: true, refund_arrived: true
    }),
    makeNonrenew({
      id: 505, stu_name: '陈大', phone: '13500135000', grade: '初一', school: 'alpha school',
      stop_date: ISO.APR, resource_type: '未续费资源', followup_intent: '高',
      parent_confirmed: false, refund_applied: false, refund_arrived: false
    }),
    makeStop({
      id: 506, stu_name: 'Dave', phone: '13400134000', grade: '初二', school: 'Beta School',
      stop_date: ISO.FEB, resource_type: '退费资源', followup_intent: '中',
      parent_confirmed: true, refund_applied: false, refund_arrived: false
    })
  ];
}

/* ---------------- 客户筛选数据集（intent_level 哨兵 + 其余筛选不回归） ----------------
 * 401 高 / 402 中 / 403 低 / 404 空串(存量) / 405 无字段 / 406 null / 407 非法值 '超高'
 */
function customerFilterDataset() {
  return [
    makeCustomer({ id: 401, stu_name: '赵一', phone: '13800138001', intent_level: '高', grade: '初一', resource_type: '上门咨询' }),
    makeCustomer({ id: 402, stu_name: '钱二', phone: '13800138002', intent_level: '中', grade: '初二', resource_type: '电话咨询' }),
    makeCustomer({ id: 403, stu_name: '孙三', phone: '13800138003', intent_level: '低', grade: '初三', resource_type: '上门咨询' }),
    makeCustomer({ id: 404, stu_name: '李四', phone: '13800138004', intent_level: '', grade: '初一', resource_type: '上门咨询' }),
    makeCustomer({ id: 405, stu_name: '周五', phone: '13800138005', grade: '初二', resource_type: '电话咨询' }),
    makeCustomer({ id: 406, stu_name: '吴六', phone: '13800138006', intent_level: null, grade: '初三', resource_type: '上门咨询' }),
    makeCustomer({ id: 407, stu_name: '郑七', phone: '13800138007', intent_level: '超高', grade: '初一', resource_type: '电话咨询' })
  ];
}

/* ---------------- V-G2 customerStats golden 数据集（range 空 = 全时段） ----------------
 * r1 上门咨询 visited+ paid 1000.50 / r2 上门咨询 均未 / r3 电话咨询 visited+ paid 2000.25 / r4 其他 均未
 * 期望：total 4 / visited 2 / signed 2 / signedAmount 3000.75
 *       byType 顺序 = 上门咨询(2,1,1,1000.50) → 电话咨询(1,1,1,2000.25) → 其他(1,0,0,0)
 */
function customerStatsRows() {
  return [
    makeCustomer({
      id: 601, stu_name: '统计甲', resource_type: '上门咨询', created_at: ISO.JAN,
      visited: true, visit_at: ISO.JAN, paid: true, paid_at: ISO.JAN, paid_amount: 1000.50
    }),
    makeCustomer({
      id: 602, stu_name: '统计乙', resource_type: '上门咨询', created_at: ISO.FEB,
      visited: false, paid: false, paid_amount: 0
    }),
    makeCustomer({
      id: 603, stu_name: '统计丙', resource_type: '电话咨询', created_at: ISO.MAR,
      visited: true, visit_at: ISO.MAR, paid: true, paid_at: ISO.MAR, paid_amount: 2000.25
    }),
    makeCustomer({
      id: 604, stu_name: '统计丁', resource_type: '其他', created_at: ISO.APR,
      visited: false, paid: false
    })
  ];
}

/* ---------------- 排序数据集（stop_date↓ → created_at↓ → id↓ 三级兜底） ----------------
 * 期望顺序 = 4(D) → 3(C) → 2(B) → 1(A) → 5(E, stop_date 非法归 0 排末尾)
 */
function stopSortDataset() {
  return [
    makeStop({ id: 1, stop_date: ISO.JAN, created_at: ISO.JAN }),  // A 最旧
    makeStop({ id: 2, stop_date: ISO.MAR, created_at: ISO.JAN }),  // B 新日期 / 旧 created_at
    makeStop({ id: 3, stop_date: ISO.MAR, created_at: ISO.MAR }),  // C 新日期 / 新 created_at
    makeStop({ id: 4, stop_date: ISO.MAR, created_at: ISO.MAR }),  // D 与 C 全同，id 更大
    makeStop({ id: 5, stop_date: '', created_at: ISO.APR })        // E stop_date 非法 → 0
  ];
}

module.exports = {
  ISO: ISO,
  GRADE_OK: GRADE_OK,
  REFUND_FIELDS: ['refund_reason', 'refund_subjects', 'refund_amount',
    'parent_confirmed', 'refund_applied', 'refund_apply_at', 'refund_arrived', 'refund_arrived_at'],
  NONRENEW_FIELDS: ['nonrenew_reason', 'end_subjects'],
  makeStop: makeStop,
  makeNonrenew: makeNonrenew,
  makeCustomer: makeCustomer,
  refundRow: refundRow,
  nonrenewRow: nonrenewRow,
  boundaryRow: boundaryRow,
  dirtyCrossTypeForm: dirtyCrossTypeForm,
  samePersonRows: samePersonRows,
  customerRowWithIntent: customerRowWithIntent,
  customerRowWithoutIntent: customerRowWithoutIntent,
  validCustomerForm: validCustomerForm,
  validRefundForm: validRefundForm,
  validNonrenewForm: validNonrenewForm,
  stopFilterDataset: stopFilterDataset,
  customerFilterDataset: customerFilterDataset,
  customerStatsRows: customerStatsRows,
  stopSortDataset: stopSortDataset
};
