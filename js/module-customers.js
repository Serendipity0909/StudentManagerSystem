/* =========================================================
 * module-customers.js —— 客户管理（Tab① 客户列表 / Tab② 统计分析）
 *
 * 硬规则（PRD §3.4）：客户数据与学生数据完全互不互通——
 *   不做跨表查重、不做外键、缴费不生成学生档案、同名同电话允许。
 *
 * 列名完全照抄 docs/ddl-v2.sql 的 customers 表：
 *   stu_name / school / phone / grade / resource_type / created_at /
 *   intended_product / intended_subjects / appointment_at / visited /
 *   visit_at / test_status / suggested_class_type / paid / paid_at /
 *   paid_amount / yellow_form / referral_name / referral_grade /
 *   referral_amount / referral_claimed / note_makeup / note_progress /
 *   note_relation / note_scores / note_schedule / note_other / updated_at
 *
 * 纯函数外露：App.CustomersCore = { validate, filterRows, customerStats }
 *   —— 不读 App.DB / App.Store / 不碰 DOM，数据全部走参数。
 *
 * 统计口径（PRD §6.1，每个指标用自己的时间字段，不可混用）：
 *   总资源数 = created_at ∈ 区间；上门资源数 = visited===true && visit_at ∈ 区间；
 *   签单学生数 = paid===true && paid_at ∈ 区间；签单金额 = 签单行 paid_amount 求和（round2）。
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, UI = App.UI, Toast = App.Toast;
  var esc = function (s) { return U.esc(s); };

  var TABLE = 'customers';

  /* 枚举（ui-kit 先于本文件加载，读取其常量） */
  var GRADES = (UI && UI.GRADES) || [];
  var RESOURCE_TYPES = (UI && UI.RESOURCE_TYPES) || ['转介绍', '上门咨询', '电话咨询', '网络留资', '地推', '老生续报', '其他'];
  var INTENDED_PRODUCTS = (UI && UI.INTENDED_PRODUCTS) || ['一对一', '班课'];
  var TEST_STATUS = (UI && UI.TEST_STATUS) || ['未测评', '优秀', '良好', '一般', '待提升'];
  var CLASS_TYPES = (UI && UI.CLASS_TYPES) || ['一对一', '小班(2–6人)', '大班(7人以上)', '待定'];
  var SUBJECTS = (UI && UI.SUBJECTS) || [];

  /* 6 个独立备注（各 ≤500 字） */
  var NOTE_FIELDS = [
    { name: 'note_makeup', label: '补课经历' },
    { name: 'note_progress', label: '学校授课进度' },
    { name: 'note_relation', label: '亲子关系' },
    { name: 'note_scores', label: '平时成绩' },
    { name: 'note_schedule', label: '建议排课时间和班级' },
    { name: 'note_other', label: '其余备注' }
  ];

  var state = {
    tab: 'list',
    filters: {
      kw: '', resource_type: '', grade: '', intended_product: '',
      visited: '', paid: '', yellow_form: '', referral_claimed: '',
      period: '', from: '', to: ''
    },
    statKind: 'month',          /* 统计 Tab 周期：week / month / year（默认当月） */
    sortKey: 'created_at',
    sortDesc: true
  };

  /* =========================================================
   * Core 纯函数（Node 测试直接调用；数据全部走参数）
   * ========================================================= */

  function tstr(v) {
    return String(v === null || v === undefined ? '' : v).trim();
  }

  function isTrue(v) {
    return v === true || v === 1 || v === 'true' || v === 't';
  }

  /**
   * 表单校验 + 条件字段联动归一（就地修改 form）。
   * 返回 {ok:boolean, errors:{field:msg}}。
   * 联动规则：
   *   visited=false 且填了 visit_at → 自动置空（form._clearedVisit = true，页面层 toast）
   *   paid=false → paid_at / paid_amount 自动置空
   */
  function validate(form) {
    var f = (form = form || {});
    var errors = {};

    /* —— 基础信息 —— */
    var name = tstr(f.stu_name);
    if (!name) errors.stu_name = '学生姓名不能为空';
    else if (name.length > 20) errors.stu_name = '学生姓名不能超过 20 个字';

    var school = tstr(f.school);
    if (!school) errors.school = '学校不能为空';
    else if (school.length > 40) errors.school = '学校不能超过 40 个字';

    var phone = tstr(f.phone);
    if (!phone) errors.phone = '联系电话不能为空';
    else if (!/^1\d{10}$/.test(phone)) errors.phone = '客户联系电话必须是 1 开头的 11 位手机号';

    var grade = tstr(f.grade);
    if (!grade) errors.grade = '请选择年级';
    else if (GRADES.indexOf(grade) < 0) errors.grade = '年级不合法';

    var rt = tstr(f.resource_type);
    if (!rt) errors.resource_type = '请选择客户资源类型';
    else if (RESOURCE_TYPES.indexOf(rt) < 0) errors.resource_type = '客户资源类型不合法';

    /* —— 意向与跟进 —— */
    var product = tstr(f.intended_product);
    if (!product) errors.intended_product = '请选择意向产品';
    else if (INTENDED_PRODUCTS.indexOf(product) < 0) errors.intended_product = '意向产品不合法';

    if (!f.intended_subjects || !f.intended_subjects.length) {
      errors.intended_subjects = '意向科目至少选择 1 项';
    }

    var created = f.created_at ? new Date(f.created_at) : null;
    var createdMs = (created && !isNaN(created.getTime())) ? created.getTime() : null;

    var visited = isTrue(f.visited);
    if (visited) {
      if (!f.visit_at) errors.visit_at = '已上门时必须填写上门时间';
      else {
        var visit = new Date(f.visit_at);
        if (isNaN(visit.getTime())) errors.visit_at = '上门时间格式不合法';
        else if (createdMs !== null && visit.getTime() < createdMs) errors.visit_at = '上门时间不能早于录入时间';
      }
    } else {
      /* 「是否上门 = 否」但填了上门时间 → 自动置空（页面层 toast「已清除上门时间」） */
      if (f.visit_at) f._clearedVisit = true;
      f.visit_at = null;
    }

    var testStatus = tstr(f.test_status) || '未测评';
    if (TEST_STATUS.indexOf(testStatus) < 0) errors.test_status = '测试情况不合法';

    var classType = tstr(f.suggested_class_type);
    if (classType && CLASS_TYPES.indexOf(classType) < 0) errors.suggested_class_type = '建议班型不合法';

    /* —— 成交 —— */
    var paid = isTrue(f.paid);
    if (paid) {
      if (!f.paid_at) errors.paid_at = '已缴费时必须填写缴费时间';
      else if (isNaN(new Date(f.paid_at).getTime())) errors.paid_at = '缴费时间格式不合法';

      var amount = (f.paid_amount === null || f.paid_amount === undefined ||
        String(f.paid_amount).trim() === '') ? null : Number(f.paid_amount);
      if (amount === null) errors.paid_amount = '已缴费时必须填写缴费金额';
      else if (!isFinite(amount)) errors.paid_amount = '缴费金额必须是数字';
      else if (!(amount > 0)) errors.paid_amount = '缴费金额必须大于 0';
      else if (amount > 999999) errors.paid_amount = '缴费金额不能超过 999999';
    } else {
      f.paid_at = null;
      f.paid_amount = null;
    }

    /* —— 转介绍（resource_type === '转介绍' 时 referral_name 必填） —— */
    if (rt === '转介绍') {
      var rn = tstr(f.referral_name);
      if (!rn) errors.referral_name = '转介绍客户必须填写转介绍人姓名';
      else if (rn.length > 20) errors.referral_name = '转介绍人姓名不能超过 20 个字';
    }
    if (f.referral_grade && GRADES.indexOf(tstr(f.referral_grade)) < 0) {
      errors.referral_grade = '转介绍人年级不合法';
    }
    var reward = (f.referral_amount === null || f.referral_amount === undefined ||
      String(f.referral_amount).trim() === '') ? null : Number(f.referral_amount);
    if (reward !== null) {
      if (!isFinite(reward)) errors.referral_amount = '奖励金额必须是数字';
      else if (reward < 0) errors.referral_amount = '奖励金额不能小于 0';
      else if (reward > 999999) errors.referral_amount = '奖励金额不能超过 999999';
    }

    /* —— 6 个备注，各 ≤500 字 —— */
    NOTE_FIELDS.forEach(function (n) {
      var v = tstr(f[n.name]);
      if (v.length > 500) errors[n.name] = n.label + '不能超过 500 字';
    });

    return { ok: Object.keys(errors).length === 0, errors: errors };
  }

  /** 三态筛选值：'' / null / undefined / 'all' → 不过滤；'yes'/'no' → true/false */
  function triState(v) {
    var s = (v === null || v === undefined) ? '' : String(v).trim();
    if (s === '' || s === 'all') return null;
    if (s === 'yes' || s === 'true' || s === '1' || s === '是') return true;
    if (s === 'no' || s === 'false' || s === '0' || s === '否') return false;
    return null;
  }

  /**
   * 列表筛选（纯函数）。
   * filters = { kw, resource_type, grade, intended_product, visited, paid,
   *             yellow_form, referral_claimed }；
   * range 可空，非空时按 created_at ∈ 区间过滤（周期筛选口径 = 总资源数基准字段）。
   */
  function filterRows(rows, filters, range) {
    var list = (rows || []).slice();
    var f = filters || {};

    var kw = tstr(f.kw).toLowerCase();
    if (kw) {
      list = list.filter(function (r) {
        return tstr(r.stu_name).toLowerCase().indexOf(kw) >= 0 ||
          tstr(r.phone).toLowerCase().indexOf(kw) >= 0;
      });
    }

    ['resource_type', 'grade', 'intended_product'].forEach(function (k) {
      var want = tstr(f[k]);
      if (!want) return;
      list = list.filter(function (r) { return tstr(r[k]) === want; });
    });

    ['visited', 'paid', 'yellow_form', 'referral_claimed'].forEach(function (k) {
      var want = triState(f[k]);
      if (want === null) return;
      list = list.filter(function (r) { return isTrue(r[k]) === want; });
    });

    if (range && range.start && range.end) {
      list = list.filter(function (r) { return UI.inRange(r.created_at, range); });
    }
    return list;
  }

  /**
   * 统计（纯函数，口径 PRD §6.1：每个指标用自己的时间字段，不可混用）。
   * rows: 全量客户行；range: {start:Date, end:Date}（可空 = 全部时段）。
   * returns { total, visited, signed, signedAmount,
   *           byType: [{ type, total, visited, signed, signedAmount }] }
   */
  function customerStats(rows, range) {
    var list = rows || [];
    var hasRange = !!(range && range.start && range.end);
    var inR = function (v) { return hasRange ? UI.inRange(v, range) : true; };

    var total = 0, visited = 0, signed = 0, signedAmount = 0;
    var map = {};
    function bucket(type) {
      if (!map[type]) map[type] = { type: type, total: 0, visited: 0, signed: 0, signedAmount: 0 };
      return map[type];
    }

    list.forEach(function (r) {
      var type = tstr(r.resource_type) || '未分类';
      if (inR(r.created_at)) { total++; bucket(type).total++; }
      if (isTrue(r.visited) && inR(r.visit_at)) { visited++; bucket(type).visited++; }
      if (isTrue(r.paid) && inR(r.paid_at)) {
        signed++;
        bucket(type).signed++;
        var amt = Number(r.paid_amount) || 0;
        signedAmount = UI.round2(signedAmount + amt);
        bucket(type).signedAmount = UI.round2(bucket(type).signedAmount + amt);
      }
    });

    /* 分组排序：按 RESOURCE_TYPES 枚举顺序，未知类型排最后（中文字典序） */
    var byType = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      var ia = RESOURCE_TYPES.indexOf(a.type), ib = RESOURCE_TYPES.indexOf(b.type);
      if (ia < 0) ia = 999; if (ib < 0) ib = 999;
      return (ia - ib) || U.zh(a.type, b.type);
    });

    return { total: total, visited: visited, signed: signed, signedAmount: signedAmount, byType: byType };
  }

  App.CustomersCore = { validate: validate, filterRows: filterRows, customerStats: customerStats };

  /* =========================================================
   * 页面层
   * ========================================================= */

  function rows() { return App.DB.table(TABLE).list(); }
  function byId(id) {
    return rows().filter(function (r) { return String(r.id) === String(id); })[0] || null;
  }

  function resetFilters() {
    state.filters = {
      kw: '', resource_type: '', grade: '', intended_product: '',
      visited: '', paid: '', yellow_form: '', referral_claimed: '',
      period: '', from: '', to: ''
    };
  }

  /** 列表 Tab 的周期区间（null = 不过滤） */
  function listRange() {
    var p = state.filters.period;
    if (p === 'week' || p === 'month' || p === 'year') return UI.periodRange(p, new Date());
    if (p === 'custom' && state.filters.from && state.filters.to) {
      return UI.periodRange('custom', new Date(), { from: state.filters.from, to: state.filters.to });
    }
    return null;
  }

  function opts(list, sel, blank) {
    var h = (blank === undefined || blank === null) ? '' : '<option value="">' + esc(blank) + '</option>';
    (list || []).forEach(function (x) {
      var v = (x && typeof x === 'object') ? x.value : x;
      var l = (x && typeof x === 'object') ? x.label : x;
      var hit = String(v) === String(sel === null || sel === undefined ? '' : sel);
      h += '<option value="' + esc(v) + '"' + (hit ? ' selected' : '') + '>' + esc(l) + '</option>';
    });
    return h;
  }

  function boolOpts(sel, yesLabel, noLabel) {
    var v = tstr(sel);
    return '<option value="">全部</option>' +
      '<option value="yes"' + (v === 'yes' ? ' selected' : '') + '>' + esc(yesLabel) + '</option>' +
      '<option value="no"' + (v === 'no' ? ' selected' : '') + '>' + esc(noLabel) + '</option>';
  }

  function fWrap(name, label, inner) {
    return '<label class="f" style="min-width:130px">' + esc(label) + '<select data-f="' + name + '">' + inner + '</select></label>';
  }

  var TABS = [
    { id: 'list', name: '① 客户列表' },
    { id: 'stats', name: '② 统计分析' }
  ];

  /* ---------- Tab① 客户列表 ---------- */

  function renderList() {
    var f = state.filters;
    var range = listRange();
    var list = Core_list(f, range);

    /* 排序：默认录入时间倒序；表头可点 姓名/学校/年级/资源类型/录入时间/意向产品 */
    var k = state.sortKey, dir = state.sortDesc ? -1 : 1;
    list.sort(function (a, b) {
      if (k === 'created_at') {
        return dir * (((new Date(a.created_at).getTime()) || 0) - ((new Date(b.created_at).getTime()) || 0));
      }
      return dir * U.zh(tstr(a[k]), tstr(b[k]));
    });

    var h = '<div class="card" style="margin-bottom:12px"><div class="toolbar" style="margin-bottom:0">' +
      '<label class="f" style="min-width:150px">关键字<input data-f="kw" placeholder="姓名 / 电话" value="' + esc(f.kw) + '"></label>' +
      fWrap('resource_type', '资源类型', opts(RESOURCE_TYPES, f.resource_type, '（全部）')) +
      fWrap('grade', '年级', opts(GRADES, f.grade, '（全部）')) +
      fWrap('intended_product', '意向产品', opts(INTENDED_PRODUCTS, f.intended_product, '（全部）')) +
      fWrap('visited', '是否上门', boolOpts(f.visited, '已上门', '未上门')) +
      fWrap('paid', '是否缴费', boolOpts(f.paid, '已缴费', '未缴费')) +
      fWrap('yellow_form', '黄表', boolOpts(f.yellow_form, '已填', '未填')) +
      fWrap('referral_claimed', '领取奖励', boolOpts(f.referral_claimed, '已领取', '未领取')) +
      fWrap('period', '周期', '<option value=""' + (f.period === '' ? ' selected' : '') + '>全部时段</option>' +
        '<option value="week"' + (f.period === 'week' ? ' selected' : '') + '>当周</option>' +
        '<option value="month"' + (f.period === 'month' ? ' selected' : '') + '>当月</option>' +
        '<option value="year"' + (f.period === 'year' ? ' selected' : '') + '>本年</option>' +
        '<option value="custom"' + (f.period === 'custom' ? ' selected' : '') + '>自定义</option>') +
      '<label class="f" style="min-width:130px">起<input type="date" data-f="from" value="' + esc(f.from) + '"></label>' +
      '<label class="f" style="min-width:130px">止<input type="date" data-f="to" value="' + esc(f.to) + '"></label>' +
      '<button data-act="clear">清空筛选</button>' +
      '<span style="flex:1"></span>' +
      '<span class="muted" id="cust-range-text" style="font-size:12.5px">' +
      (range ? esc(UI.rangeText(range)) : '') + '</span>' +
      '<button class="primary" data-act="new">新增客户</button>' +
      '</div></div>';

    if (!rows().length) {
      h += '<div class="card">' + UI.empty('还没有客户资源。点右上『新增客户』录入第一条。') + '</div>';
      return h;
    }
    if (!list.length) {
      h += '<div class="card">' + UI.empty('没有符合条件的客户', '试试调整筛选条件或清空筛选。') +
        '<div style="text-align:center;margin-top:10px"><button data-act="clear">清空筛选</button></div></div>';
      return h;
    }

    var cols = [
      { key: 'stu_name', label: '姓名' },
      { key: 'school', label: '学校' },
      { key: 'phone', label: '电话' },
      { key: 'grade', label: '年级' },
      { key: 'resource_type', label: '资源类型' },
      { key: 'created_at', label: '录入时间' },
      { key: 'intended_product', label: '意向产品' },
      { key: '', label: '是否上门' },
      { key: '', label: '是否缴费' },
      { key: '', label: '操作', cls: 'c', width: '150px' }
    ];

    h += '<div class="card"><div class="tbl-wrap"><table><thead><tr>' +
      UI.sortHeader(cols, state.sortKey, state.sortDesc) +
      '</tr></thead><tbody>';
    list.forEach(function (r) {
      h += '<tr>' +
        '<td><b>' + esc(r.stu_name) + '</b></td>' +
        '<td>' + esc(r.school) + '</td>' +
        '<td class="muted">' + esc(r.phone) + '</td>' +
        '<td>' + esc(r.grade) + '</td>' +
        '<td>' + esc(r.resource_type) + '</td>' +
        '<td class="muted">' + esc(U.hms(r.created_at)) + '</td>' +
        '<td>' + esc(r.intended_product) + '</td>' +
        '<td>' + (isTrue(r.visited)
          ? '<span class="chip ch-green">已上门</span> <span class="muted" style="font-size:12px">' + esc(U.hms(r.visit_at)) + '</span>'
          : '<span class="chip">未上门</span>') + '</td>' +
        '<td>' + (isTrue(r.paid)
          ? '<span class="chip ch-red">已缴费</span> <b style="color:#c0392b">' + esc(UI.moneyPretty(r.paid_amount)) + '</b>'
          : '<span class="chip">未缴费</span>') + '</td>' +
        '<td class="c" style="white-space:nowrap">' +
        '<button data-act="detail" data-id="' + esc(r.id) + '">详情</button> ' +
        '<button data-act="edit" data-id="' + esc(r.id) + '">编辑</button> ' +
        '<button data-act="del" data-id="' + esc(r.id) + '" style="color:#c0392b">删除</button>' +
        '</td></tr>';
    });
    h += '</tbody></table></div></div>';
    return h;
  }

  function Core_list(f, range) {
    return App.CustomersCore.filterRows(rows(), f, range);
  }

  /* ---------- Tab② 统计分析 ---------- */

  function renderStats() {
    var kind = (state.statKind === 'week' || state.statKind === 'year') ? state.statKind : 'month';
    var range = UI.periodRange(kind, new Date());
    var st = App.CustomersCore.customerStats(rows(), range);

    var h = '<div class="card" style="margin-bottom:12px"><div class="toolbar" style="margin-bottom:0">' +
      ['week|当周', 'month|当月', 'year|本年'].map(function (x) {
        var p = x.split('|');
        return '<button data-k="' + p[0] + '"' + (kind === p[0] ? ' class="primary"' : '') + '>' + p[1] + '</button>';
      }).join('') +
      '<span class="muted" style="font-size:12.5px;margin-left:8px">区间：' + esc(UI.rangeText(range)) + '</span>' +
      '</div></div>';

    h += '<div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">' +
      UI.kpi('总资源数', String(st.total), '按录入时间归属') +
      UI.kpi('上门资源数', String(st.visited), '按上门时间归属') +
      UI.kpi('签单学生数', String(st.signed), '按缴费时间归属') +
      UI.kpi('签单金额（元）', esc(UI.moneyPretty(st.signedAmount)), '签单行缴费金额求和') +
      '</div>';

    h += '<div class="grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">' +
      UI.kpi('上门率', esc(UI.pctText(st.visited, st.total)), '上门 ÷ 总资源') +
      UI.kpi('签单率', esc(UI.pctText(st.signed, st.total)), '签单 ÷ 总资源') +
      UI.kpi('上门签单率', esc(UI.pctText(st.signed, st.visited)), '签单 ÷ 上门') +
      '</div>';

    if (!st.total) {
      h += '<div class="card">' + UI.empty('当前周期没有资源数据，试试切换到更大的时间范围。') + '</div>';
      return h;
    }

    h += '<div class="card"><h3>按资源类型分类分析<span class="h-note">口径：每个指标用各自的时间字段归属区间</span></h3>' +
      '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>资源类型</th><th class="c">资源数</th><th class="c">上门数</th><th class="c">签单数</th>' +
      '<th class="c">签单金额</th><th class="c">上门率</th><th class="c">签单率</th>' +
      '</tr></thead><tbody>';
    st.byType.forEach(function (g) {
      h += '<tr><td>' + esc(g.type) + '</td>' +
        '<td class="c">' + g.total + '</td>' +
        '<td class="c">' + g.visited + '</td>' +
        '<td class="c">' + g.signed + '</td>' +
        '<td class="c">' + esc(UI.moneyPretty(g.signedAmount)) + '</td>' +
        '<td class="c">' + esc(UI.pctText(g.visited, g.total)) + '</td>' +
        '<td class="c">' + esc(UI.pctText(g.signed, g.total)) + '</td></tr>';
    });
    h += '<tr style="font-weight:700;background:#f7faf8"><td>合计</td>' +
      '<td class="c">' + st.total + '</td>' +
      '<td class="c">' + st.visited + '</td>' +
      '<td class="c">' + st.signed + '</td>' +
      '<td class="c">' + esc(UI.moneyPretty(st.signedAmount)) + '</td>' +
      '<td class="c">' + esc(UI.pctText(st.visited, st.total)) + '</td>' +
      '<td class="c">' + esc(UI.pctText(st.signed, st.total)) + '</td></tr>';
    h += '</tbody></table></div></div>';
    return h;
  }

  /* ---------- 新增 / 编辑弹窗 ---------- */

  function openForm(existing) {
    /* L4 写入校验（App.DB 内部还有同一道守卫，这里先拦一次给更好的提示） */
    if (App.Perm && !App.Perm.assertWrite('customers')) return;

    var body = document.createElement('div');
    var v = existing || {};
    var isReferral = tstr(v.resource_type) === '转介绍';

    body.innerHTML =
      '<div id="phone-hint"></div>' +
      '<div style="max-height:62vh;overflow:auto;padding-right:4px">' +
      '<div class="muted" style="font-weight:700;margin:4px 0 6px">基础信息</div>' +
      '<div class="form-grid">' +
      '<label class="f">学生姓名 *<input name="stu_name" maxlength="20" value="' + esc(v.stu_name) + '"></label>' +
      '<label class="f">学校 *<input name="school" maxlength="40" value="' + esc(v.school) + '"></label>' +
      '<label class="f">联系电话 *<input name="phone" inputmode="tel" maxlength="11" placeholder="11 位手机号" value="' + esc(v.phone) + '"></label>' +
      '<label class="f">年级 *<select name="grade">' + opts(GRADES, v.grade, '（请选择）') + '</select></label>' +
      '<label class="f">客户资源类型 *<select name="resource_type">' + opts(RESOURCE_TYPES, v.resource_type, '（请选择）') + '</select></label>' +
      (existing
        ? '<label class="f">录入时间（只读）<input value="' + esc(U.hms(v.created_at)) + '" disabled></label>'
        : '<label class="f">录入时间<input value="保存时自动生成" disabled></label>') +
      '</div>' +

      '<div class="muted" style="font-weight:700;margin:14px 0 6px">意向与跟进</div>' +
      '<div class="form-grid">' +
      '<label class="f">意向产品 *<select name="intended_product">' + opts(INTENDED_PRODUCTS, v.intended_product, '（请选择）') + '</select></label>' +
      '<label class="f" style="grid-column:1/-1">意向科目 *（≥1）<div id="ms-subjects"></div></label>' +
      '<label class="f">预约上门时间<input type="datetime-local" name="appointment_at" value="' + esc(UI.toLocalInput(v.appointment_at)) + '">' +
      '<span class="muted" style="font-size:12px">早于录入时间仅提示，不阻止</span></label>' +
      '<label class="f">是否上门<input type="checkbox" name="visited"' + (isTrue(v.visited) ? ' checked' : '') + ' style="width:auto"></label>' +
      '<label class="f">上门时间<input type="datetime-local" name="visit_at" value="' + esc(UI.toLocalInput(v.visit_at)) + '"' +
      (isTrue(v.visited) ? '' : ' disabled') + '></label>' +
      '<label class="f">测试情况<select name="test_status">' + opts(TEST_STATUS, v.test_status || '未测评') + '</select></label>' +
      '<label class="f">建议班型<select name="suggested_class_type">' + opts(CLASS_TYPES, v.suggested_class_type, '（待定）') + '</select></label>' +
      '</div>' +

      '<div class="muted" style="font-weight:700;margin:14px 0 6px">成交</div>' +
      '<div class="form-grid">' +
      '<label class="f">是否缴费<input type="checkbox" name="paid"' + (isTrue(v.paid) ? ' checked' : '') + ' style="width:auto"></label>' +
      '<label class="f">缴费时间<input type="datetime-local" name="paid_at" value="' + esc(UI.toLocalInput(v.paid_at)) + '"' +
      (isTrue(v.paid) ? '' : ' disabled') + '></label>' +
      '<label class="f">缴费金额（元）<input type="number" name="paid_amount" step="0.01" min="0" max="999999" placeholder="> 0，≤ 999999" value="' +
      (v.paid_amount === null || v.paid_amount === undefined ? '' : esc(v.paid_amount)) + '"' +
      (isTrue(v.paid) ? '' : ' disabled') + '></label>' +
      '<label class="f">是否填写黄表<input type="checkbox" name="yellow_form"' + (isTrue(v.yellow_form) ? ' checked' : '') + ' style="width:auto"></label>' +
      '</div>' +

      '<div class="muted" style="font-weight:700;margin:14px 0 6px">转介绍奖励' +
      (isReferral ? '（资源类型 = 转介绍）' : '（资源类型 ≠ 转介绍时可不填）') + '</div>' +
      '<div class="form-grid">' +
      '<label class="f">转介绍人姓名' + (isReferral ? ' *' : '') +
      '<input name="referral_name" maxlength="20" value="' + esc(v.referral_name) + '"></label>' +
      '<label class="f">转介绍人年级<select name="referral_grade" id="ref-grade">' + opts(GRADES, v.referral_grade, '（可不选）') + '</select></label>' +
      '<label class="f">奖励金额（元）<input type="number" name="referral_amount" step="0.01" min="0" value="' +
      (v.referral_amount === null || v.referral_amount === undefined ? '' : esc(v.referral_amount)) + '"></label>' +
      '<label class="f">是否领取奖励<input type="checkbox" name="referral_claimed"' + (isTrue(v.referral_claimed) ? ' checked' : '') + ' style="width:auto"></label>' +
      '</div>' +

      '<div class="muted" style="font-weight:700;margin:14px 0 6px">其它情况备注（各 ≤500 字）</div>' +
      '<div class="form-grid">' +
      NOTE_FIELDS.map(function (n) {
        return '<label class="f" style="grid-column:1/-1">' + esc(n.label) +
          '<textarea name="' + n.name + '" rows="2" maxlength="500">' + esc(v[n.name]) + '</textarea></label>';
      }).join('') +
      '</div>' +
      '</div>' +
      '<div data-form-err></div>';

    /* 意向科目多选（9 科 + 其他，可手填） */
    var msSub = UI.multiSelect({
      options: SUBJECTS,
      value: (existing && existing.intended_subjects) || [],
      allowCustom: true,
      placeholder: '选择或手填科目后回车'
    });
    var msBox = body.querySelector('#ms-subjects');
    if (msBox) msBox.appendChild(msSub.el);

    var q = function (n) {
      var el = body.querySelector('[name=' + n + ']');
      return el ? el.value : '';
    };
    var errBox = function () { return body.querySelector('[data-form-err]'); };

    /* 电话重复软提示：允许保存，只签名提示 */
    function phoneHint() {
      var p = tstr(q('phone'));
      var box = body.querySelector('#phone-hint');
      if (!box) return;
      if (!/^1\d{10}$/.test(p)) { box.innerHTML = ''; return; }
      var n = rows().filter(function (r) {
        return tstr(r.phone) === p && (!existing || String(r.id) !== String(existing.id));
      }).length;
      box.innerHTML = n > 0
        ? '<div class="box-warn" style="margin-bottom:10px;padding:7px 11px;font-size:12.5px">' +
        '该手机号已有 ' + n + ' 条客户记录（同一客户可多次咨询，允许保存）</div>'
        : '';
    }
    U.onCommitted(body.querySelector('[name=phone]'), function () { phoneHint(); });
    phoneHint();

    /* 条件字段联动：是否上门 / 是否缴费 / 资源类型（转介绍） */
    var ckVisit = body.querySelector('[name=visited]');
    var inVisit = body.querySelector('[name=visit_at]');
    function syncVisit() {
      if (!inVisit) return;
      inVisit.disabled = !ckVisit.checked;
      if (!ckVisit.checked) inVisit.value = '';
    }
    if (ckVisit) ckVisit.addEventListener('change', syncVisit);

    var ckPaid = body.querySelector('[name=paid]');
    var inPaidAt = body.querySelector('[name=paid_at]');
    var inPaidAmt = body.querySelector('[name=paid_amount]');
    function syncPaid() {
      if (inPaidAt) { inPaidAt.disabled = !ckPaid.checked; if (!ckPaid.checked) inPaidAt.value = ''; }
      if (inPaidAmt) { inPaidAmt.disabled = !ckPaid.checked; if (!ckPaid.checked) inPaidAmt.value = ''; }
    }
    if (ckPaid) ckPaid.addEventListener('change', syncPaid);

    var selType = body.querySelector('[name=resource_type]');
    if (selType) selType.addEventListener('change', function () { /* 必填与否由校验层按 resource_type 判定 */ });

    /* 提交 */
    function submit(close) {
      var form = {
        stu_name: tstr(q('stu_name')),
        school: tstr(q('school')),
        phone: tstr(q('phone')),
        grade: q('grade'),
        resource_type: q('resource_type'),
        created_at: existing ? existing.created_at : new Date().toISOString(),
        intended_product: q('intended_product'),
        intended_subjects: msSub ? msSub.getValue() : [],
        appointment_at: UI.fromLocalInput(q('appointment_at')),
        visited: !!(ckVisit && ckVisit.checked),
        visit_at: UI.fromLocalInput(q('visit_at')),
        test_status: q('test_status') || '未测评',
        suggested_class_type: q('suggested_class_type'),
        paid: !!(ckPaid && ckPaid.checked),
        paid_at: UI.fromLocalInput(q('paid_at')),
        paid_amount: UI.numOrNull(q('paid_amount')),
        yellow_form: !!(body.querySelector('[name=yellow_form]') && body.querySelector('[name=yellow_form]').checked),
        referral_name: tstr(q('referral_name')),
        referral_grade: q('referral_grade'),
        referral_amount: UI.numOrNull(q('referral_amount')),
        referral_claimed: !!(body.querySelector('[name=referral_claimed]') && body.querySelector('[name=referral_claimed]').checked),
        note_makeup: tstr(q('note_makeup')),
        note_progress: tstr(q('note_progress')),
        note_relation: tstr(q('note_relation')),
        note_scores: tstr(q('note_scores')),
        note_schedule: tstr(q('note_schedule')),
        note_other: tstr(q('note_other'))
      };

      var res = App.CustomersCore.validate(form);
      if (!res.ok) {
        var first = Object.keys(res.errors)[0];
        var box = errBox();
        if (box) box.innerHTML = '<div class="err">' + esc(res.errors[first]) + '</div>';
        var el = body.querySelector('[name=' + first + ']');
        if (el && el.focus) el.focus();
        Toast(res.errors[first], 'error', 4000);
        return false;
      }

      /* 数字归一：金额 2 位小数；referral_amount 列 NOT NULL DEFAULT 0 */
      if (form.paid_amount !== null) form.paid_amount = UI.round2(form.paid_amount);
      form.referral_amount = (form.referral_amount === null) ? 0 : UI.round2(form.referral_amount);
      var clearedVisit = !!form._clearedVisit;   /* 「否」上门却填了时间 → 保存后 toast */
      delete form._clearedVisit;

      var t = App.DB.table(TABLE);
      var after = function () {
        if (clearedVisit) Toast('已清除上门时间', 'warn');
        else Toast(existing ? '客户已更新' : '客户已新增', 'ok');
        close();
      };
      var onFail = function (e) {
        Toast('保存失败：' + (e && e.message ? e.message : e), 'error', 5000);
      };
      if (existing) t.update(existing.id, form).then(after, onFail);
      else t.insert(form).then(after, onFail);
      return false;   /* 等云端回读成功后再手动关窗 */
    }

    UI.formModal({
      title: existing ? '编辑客户 · ' + v.stu_name : '新增客户',
      body: body,
      okText: '保存',
      onSubmit: submit
    });
  }

  /* ---------- 详情弹窗 ---------- */

  function openDetail(row) {
    if (!row) return;
    var body = document.createElement('div');
    var t = function (k) {
      var v = row[k];
      return (v === null || v === undefined || v === '') ? '—' : esc(v);
    };

    function sec(title, rowsHtml) {
      return '<div class="muted" style="font-weight:700;margin:12px 0 4px">' + title + '</div>' +
        '<table style="width:100%;font-size:13px;border-collapse:collapse">' + rowsHtml + '</table>';
    }
    function tr(label, valueHtml) {
      return '<tr><td class="muted" style="width:150px;padding:4px 6px 4px 0;vertical-align:top">' + label + '</td>' +
        '<td style="padding:4px 0">' + valueHtml + '</td></tr>';
    }

    body.innerHTML = sec('基础信息',
      tr('学生姓名', '<b>' + t('stu_name') + '</b>') +
      tr('学校', t('school')) +
      tr('联系电话', t('phone')) +
      tr('年级', t('grade')) +
      tr('客户资源类型', t('resource_type')) +
      tr('录入时间', esc(U.hms(row.created_at)))) +
      sec('意向与跟进',
        tr('意向产品', t('intended_product')) +
        tr('意向科目', (row.intended_subjects || []).length ? esc((row.intended_subjects || []).join('、')) : '—') +
        tr('预约上门时间', row.appointment_at ? esc(U.hms(row.appointment_at)) : '—') +
        tr('是否上门', isTrue(row.visited) ? '<span class="chip ch-green">已上门</span>' : '<span class="chip">未上门</span>') +
        tr('上门时间', row.visit_at ? esc(U.hms(row.visit_at)) : '—') +
        tr('测试情况', t('test_status')) +
        tr('建议班型', t('suggested_class_type'))) +
      sec('成交',
        tr('是否缴费', isTrue(row.paid) ? '<span class="chip ch-red">已缴费</span>' : '<span class="chip">未缴费</span>') +
        tr('缴费时间', row.paid_at ? esc(U.hms(row.paid_at)) : '—') +
        tr('缴费金额', isTrue(row.paid) ? esc(UI.moneyPretty(row.paid_amount)) + ' 元' : '—') +
        tr('是否填写黄表', isTrue(row.yellow_form) ? '是' : '否')) +
      sec('转介绍奖励',
        tr('转介绍人姓名', t('referral_name')) +
        tr('转介绍人年级', t('referral_grade')) +
        tr('奖励金额', (row.referral_amount === null || row.referral_amount === undefined) ? '—' : esc(UI.money(row.referral_amount)) + ' 元') +
        tr('是否领取奖励', isTrue(row.referral_claimed) ? '是' : '否')) +
      sec('其它情况备注',
        NOTE_FIELDS.map(function (n) { return tr(n.label, t(n.name)); }).join('')) +
      sec('系统信息',
        tr('最后修改', esc(U.hms(row.updated_at))) +
        tr('最后修改人', t('last_editor')));

    App.Modal.open({ title: '客户详情 · ' + row.stu_name, body: body, okText: '关闭' });
  }

  /* ---------- 删除 ---------- */

  function confirmDel(id) {
    var row = byId(id);
    if (!row) return;
    if (App.Perm && !App.Perm.assertWrite('customers')) return;
    UI.confirmDanger(
      '确定删除客户 <b>' + esc(row.stu_name) + '</b>（' + esc(row.phone) + '）吗？<br><br>' +
      '<span style="color:#c0392b">删除后该客户记录不再计入统计，且不可恢复。</span>',
      function () {
        App.DB.table(TABLE).remove(id).then(function () {
          Toast('客户已删除', 'ok');
        }).catch(function (e) {
          Toast('删除失败：' + (e && e.message ? e.message : e), 'error', 5000);
        });
      });
  }

  /* =========================================================
   * 模块注册
   * ========================================================= */

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/>' +
    '<path d="M3.5 19c0-3.2 2.5-5.2 5.5-5.2s5.5 2 5.5 5.2"/>' +
    '<path d="M14.5 6.5h6"/><path d="M17.5 3.5v6"/>' +
    '<path d="M16 14.5h4.5"/><path d="M16 18h4.5"/></svg>';

  App.registerModule({
    id: 'customers', name: '客户管理', icon: ICON, ready: true,
    adminOnly: true,
    order: 30,
    title: '客户管理', subtitle: '客户资源 · 意向跟进 · 成交统计（与学生数据完全隔离）',

    render: function () {
      /* L3 直达拦截：非管理员手输 #/customers 时输出统一 403 卡片 */
      if (App.Perm.denied(this)) return App.Perm.forbiddenCard(this);
      var h = '<div class="toolbar" style="margin-bottom:14px">';
      TABS.forEach(function (t) {
        h += '<button data-tab="' + t.id + '"' + (state.tab === t.id ? ' class="primary"' : '') + '>' + t.name + '</button>';
      });
      h += '</div>';
      h += (state.tab === 'stats') ? renderStats() : renderList();
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

      if (state.tab === 'stats') {
        Array.prototype.forEach.call(host.querySelectorAll('[data-k]'), function (b) {
          b.addEventListener('click', function () {
            state.statKind = b.getAttribute('data-k');
            App.render();
          });
        });
        return;
      }

      /* 筛选：关键字用输入法安全绑定（U.onCommitted），下拉用 change */
      var kw = host.querySelector('[data-f="kw"]');
      if (kw) U.onCommitted(kw, function (val) {
        state.filters.kw = tstr(val);
        App.render();
      });
      ['resource_type', 'grade', 'intended_product', 'visited', 'paid',
        'yellow_form', 'referral_claimed', 'period'].forEach(function (k) {
          var el = host.querySelector('[data-f="' + k + '"]');
          if (el) el.addEventListener('change', function () {
            state.filters[k] = el.value;
            App.render();
          });
        });
      ['from', 'to'].forEach(function (k) {
        var el = host.querySelector('[data-f="' + k + '"]');
        if (el) el.addEventListener('change', function () {
          state.filters[k] = el.value;
          if (state.filters[k] && state.filters.period !== 'custom') state.filters.period = 'custom';
          App.render();
        });
      });

      UI.bindSort(host, state, App.render);

      Array.prototype.forEach.call(host.querySelectorAll('[data-act]'), function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          var id = b.getAttribute('data-id');
          if (act === 'new') openForm(null);
          else if (act === 'edit') openForm(byId(id));
          else if (act === 'detail') openDetail(byId(id));
          else if (act === 'del') confirmDel(id);
          else if (act === 'clear') { resetFilters(); App.render(); }
        });
      });
    }
  });
})(window.App);
