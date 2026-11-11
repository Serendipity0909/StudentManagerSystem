/* =========================================================
 * ui-kit.js —— App.UI：模块公共件（金额 / 比率 / 周期 / 表单 / 多选 / 时间行 / 排序表头）
 *
 * 约定（ARCH §4.1 与 §8 共享约定）：
 *   · 金额：内部以「元」为单位，取整唯一入口 round2（round half up），展示 toFixed(2)
 *   · 比率：1 位小数；分母为 0 一律返回 null，渲染层输出「—」，禁止 0% / NaN
 *   · 时间落库 ISO 8601 UTC；统计区间在本地时区计算（含首含尾，周一为周首）
 *   · 视觉只复用既有 class（.card / .grid / .kpi / .toolbar / .tbl-wrap / .chip /
 *     .modal / .empty / .form-grid / .f），不引入第二套样式体系
 *   · 本文件加载期不触碰 DOM / App.Sync，只依赖 core.js 的 window.App
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U;
  var esc = function (s) { return U.esc(s); };

  /* =========================================================
   * 1. 数值与金额
   * ========================================================= */

  /** 四舍五入到 2 位（round half up，避免 1.005 → 1.00 的二进制误差） */
  function round2(n) {
    var v = Number(n);
    if (!isFinite(v)) return 0;
    var sign = v < 0 ? -1 : 1;
    return sign * Math.round(Math.abs(v) * 100 + 1e-9) / 100;
  }

  /** 展示金额：round2 后 toFixed(2)，如 '7230.00'；空值输出 '0.00' */
  function money(n) {
    return round2(n).toFixed(2);
  }

  /** 金额 → 带千分位（仅展示用） */
  function moneyPretty(n) {
    var s = money(n).split('.');
    s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return s.join('.');
  }

  /**
   * 比率（0–100 的百分数，1 位小数）。
   * 分母 <= 0 或非数字 → 返回 null，调用方必须渲染「—」（禁止 0% / NaN / Infinity）。
   */
  function pct(num, den) {
    var a = Number(num), b = Number(den);
    if (!isFinite(a) || !isFinite(b) || !(b > 0)) return null;
    return Math.round(a / b * 1000) / 10;
  }

  /** 比率 → 展示字符串（null → '—'）；withSign 时带 % */
  function pctText(num, den, withSign) {
    var p = pct(num, den);
    if (p === null) return '—';
    return p.toFixed(1) + (withSign === false ? '' : '%');
  }

  /** 整数或空串（输入框取值用）：非法输入返回 0 */
  function int(n) {
    var v = Math.round(Number(n));
    return isFinite(v) ? v : 0;
  }

  /** 数字输入取值：空串 → null（用于「选填金额」），非法 → null */
  function numOrNull(n) {
    var s = String(n === null || n === undefined ? '' : n).trim();
    if (s === '') return null;
    var v = Number(s);
    return isFinite(v) ? v : null;
  }

  /* =========================================================
   * 2. 日期与周期
   * ========================================================= */

  function toDate(v) {
    if (!v) return null;
    var d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  /** 当天 00:00:00.000 */
  function dayStart(d) {
    var x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /** 当天 23:59:59.999 */
  function dayEnd(d) {
    var x = new Date(d.getTime());
    x.setHours(23, 59, 59, 999);
    return x;
  }

  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  /** 本周一 00:00（周日属于「本周」的最后一天，即周一为周首） */
  function weekStart(d) {
    var x = dayStart(d);
    var w = x.getDay();                  // 0=周日
    var back = (w === 0) ? 6 : (w - 1);  // 周一 → 0，周日 → 6
    return addDays(x, -back);
  }

  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0); }
  function monthEnd(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }
  function yearStart(d) { return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0); }
  function yearEnd(d) { return new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999); }

  /**
   * 周期区间（本地时区，含首含尾）：
   *   'day'   → 当天 00:00:00.000 – 23:59:59.999
   *   'week'  → 本周一 00:00:00.000 – 本周日 23:59:59.999
   *   'month' → 当月 1 日 00:00:00.000 – 月末 23:59:59.999
   *   'year'  → 1/1 00:00:00.000 – 12/31 23:59:59.999
   *   'custom'→ 由 from / to 传入（字符串或 Date）
   * @param {string} kind 'day'|'week'|'month'|'year'|'custom'
   * @param {Date} [now] 基准时刻，默认当前
   * @param {{from?:*, to?:*}} [custom] 自定义区间
   * @returns {{start:Date, end:Date}}
   */
  function periodRange(kind, now, custom) {
    var base = toDate(now) || new Date();
    var c = custom || {};
    var start, end;
    if (kind === 'day') { start = dayStart(base); end = dayEnd(base); }
    else if (kind === 'week') { start = weekStart(base); end = dayEnd(addDays(start, 6)); }
    else if (kind === 'month') { start = monthStart(base); end = monthEnd(base); }
    else if (kind === 'year') { start = yearStart(base); end = yearEnd(base); }
    else {
      var s = toDate(c.from), e = toDate(c.to);
      start = s ? dayStart(s) : dayStart(base);
      end = e ? dayEnd(e) : dayEnd(base);
      if (end.getTime() < start.getTime()) { var t = start; start = dayStart(end); end = dayEnd(t); }
    }
    return { start: start, end: end };
  }

  /** 时间戳是否落在区间内（含首含尾；无效时间戳 → false） */
  function inRange(ts, range) {
    var d = toDate(ts);
    if (!d || !range || !range.start || !range.end) return false;
    return d.getTime() >= range.start.getTime() && d.getTime() <= range.end.getTime();
  }

  /** 区间文案：2026-11-09 ~ 2026-11-15 */
  function rangeText(range) {
    if (!range) return '—';
    return U.dateStr(range.start) + ' ~ ' + U.dateStr(range.end);
  }

  /** ISO / Date → <input type="datetime-local"> 需要的本地值 'YYYY-MM-DDTHH:mm' */
  function toLocalInput(v) {
    var d = toDate(v);
    if (!d) return '';
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** <input type="datetime-local"> 的值 → ISO 8601 UTC（空值 → null） */
  function fromLocalInput(v) {
    var s = String(v || '').trim();
    if (!s) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** <input type="date"> 的值 → ISO（当天 00:00 本地） */
  function fromDateInput(v) {
    var s = String(v || '').trim();
    if (!s) return null;
    var d = new Date(s + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  var WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /** 星期数字（1=周一 … 7=周日）→ 中文 */
  function weekdayName(n) {
    var i = Math.floor(Number(n));
    return (i >= 1 && i <= 7) ? WEEKDAYS[i - 1] : '';
  }

  /** 上课时间数组 → 「周二 18:30–20:30；周六 09:00–11:00」 */
  function scheduleText(list) {
    var arr = list || [];
    if (!arr.length) return '—';
    return arr.map(function (s) {
      var w = weekdayName(s.weekday);
      return (w ? w + ' ' : '') + (s.start || '') + '–' + (s.end || '');
    }).join('；');
  }

  /* =========================================================
   * 3. 枚举与展示件
   * ========================================================= */

  var GRADES = ['小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级',
    '初一', '初二', '初三', '高一', '高二', '高三'];

  /** 9 科（与成绩模块对齐）+ 其他 */
  var SUBJECTS = (App.K ? App.K.SUBJECTS.slice() : []).concat(['其他']);

  var RESOURCE_TYPES = ['转介绍', '上门咨询', '电话咨询', '网络留资', '地推', '老生续报', '其他'];
  var INTENDED_PRODUCTS = ['一对一', '班课'];
  var TEST_STATUS = ['未测评', '优秀', '良好', '一般', '待提升'];
  var CLASS_TYPES = ['一对一', '小班(2–6人)', '大班(7人以上)', '待定'];
  var PRIORITY = [
    { value: 'high', label: '高', chip: 'ch-red' },
    { value: 'mid', label: '中', chip: 'ch-amber' },
    { value: 'low', label: '低', chip: 'ch-blue' }
  ];
  var STAGES = ['A', 'B', 'C', 'D'];   /* T9 起连报方案改为价目表内的自定义方案（plan_name），旧的 PLANS 枚举已废弃移除 */

  function options(list) {
    return (list || []).map(function (x) {
      return '<option value="' + esc(x) + '">' + esc(x) + '</option>';
    }).join('');
  }

  function optionsWithLabel(list, selected) {
    var sel = String(selected === null || selected === undefined ? '' : selected);
    return (list || []).map(function (x) {
      var v = (x && typeof x === 'object') ? String(x.value) : String(x);
      var l = (x && typeof x === 'object') ? String(x.label) : String(x);
      return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }

  function statusChip(label, tone) {
    var cls = tone === 'ok' ? 'ch-green' : (tone === 'warn' ? 'ch-amber' : (tone === 'danger' ? 'ch-red' : 'ch-blue'));
    return '<span class="chip ' + cls + '">' + esc(label) + '</span>';
  }

  function priorityChip(v) {
    for (var i = 0; i < PRIORITY.length; i++) {
      if (PRIORITY[i].value === v) return statusChip(PRIORITY[i].label, v === 'high' ? 'danger' : (v === 'mid' ? 'warn' : 'info'));
    }
    return statusChip('中', 'warn');
  }

  /** 空态（复用 .empty） */
  function empty(text, hint) {
    return '<div class="empty">' + text + (hint ? '<br><span class="muted">' + esc(hint) + '</span>' : '') + '</div>';
  }

  /** KPI 卡 */
  function kpi(label, value, desc) {
    return '<div class="kpi"><div class="k">' + esc(label) + '</div>' +
      '<div class="v">' + value + '</div>' +
      (desc ? '<div class="d">' + esc(desc) + '</div>' : '') + '</div>';
  }

  /* =========================================================
   * 4. 排序表头
   * ========================================================= */

  /**
   * 生成可排序表头单元格。
   * @param {Array<{key?:string,label:string,cls?:string,width?:string}>} cols
   *        key 为空表示该列不排序
   * @param {string} sortKey 当前排序列
   * @param {boolean} sortDesc 是否降序
   */
  function sortHeader(cols, sortKey, sortDesc) {
    var h = '';
    (cols || []).forEach(function (c) {
      var cls = c.cls || '';
      if (!c.key) return h += '<th class="' + cls + '">' + esc(c.label) + '</th>';
      var arrow = (c.key === sortKey) ? (sortDesc ? ' ▾' : ' ▴') : '';
      h += '<th class="sortable ' + cls + '" data-sort="' + esc(c.key) + '"' +
        ' title="点击按「' + esc(c.label) + '」排序" style="cursor:pointer' +
        (c.width ? ';width:' + esc(c.width) : '') + '">' + esc(c.label) + arrow + '</th>';
    });
    return h;
  }

  /**
   * 绑定表头排序：点击同一列切换升降序，换列时按该列升序（文本/时间默认升序）。
   * @param {Element} host 渲染容器
   * @param {{sortKey:string,sortDesc:boolean}} state 模块 state（就地修改）
   * @param {Function} [onChange] 排序后回调（通常是 App.render）
   */
  function bindSort(host, state, onChange) {
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (state.sortKey === key) state.sortDesc = !state.sortDesc;
        else { state.sortKey = key; state.sortDesc = false; }
        if (onChange) onChange();
      });
    });
  }

  /**
   * 通用排序比较器（数字 / 日期 / 中文文本自动识别）。
   * @returns {function(a,b):number} 已按 sortDesc 取反
   */
  function comparator(sortKey, sortDesc, kind) {
    return function (a, b) {
      var va = a ? a[sortKey] : null, vb = b ? b[sortKey] : null;
      var r;
      if (kind === 'number') r = (Number(va) || 0) - (Number(vb) || 0);
      else if (kind === 'date') r = (toDate(va) ? toDate(va).getTime() : 0) - (toDate(vb) ? toDate(vb).getTime() : 0);
      else r = U.zh(va === null || va === undefined ? '' : va, vb === null || vb === undefined ? '' : vb);
      return sortDesc ? -r : r;
    };
  }

  /* =========================================================
   * 5. 表单件：字段渲染 / 取值 / 校验
   * ========================================================= */

  /**
   * 渲染一个表单字段。
   * spec = {name, label, type:'text'|'number'|'textarea'|'select'|'date'|'datetime'|'checkbox'|'phone',
   *         options:[], required:boolean, readonly:boolean, placeholder, hint, rows, step, min, max, cls}
   */
  function field(spec) {
    var s = spec || {};
    var name = s.name || '';
    var req = s.required ? ' *' : '';
    var dis = s.readonly ? ' disabled' : '';
    var ph = s.placeholder ? ' placeholder="' + esc(s.placeholder) + '"' : '';
    var hint = s.hint ? '<span class="muted" style="font-size:12px">' + esc(s.hint) + '</span>' : '';
    var input;

    if (s.type === 'textarea') {
      input = '<textarea name="' + esc(name) + '" rows="' + int(s.rows || 3) + '"' + dis + ph + '>' +
        esc(s.value === null || s.value === undefined ? '' : s.value) + '</textarea>';
    } else if (s.type === 'select') {
      input = '<select name="' + esc(name) + '"' + dis + '>' +
        (s.blank ? '<option value="">' + esc(s.blank) + '</option>' : '') +
        optionsWithLabel(s.options, s.value) + '</select>';
    } else if (s.type === 'checkbox') {
      input = '<label class="muted" style="display:flex;align-items:center;gap:8px;height:38px">' +
        '<input type="checkbox" name="' + esc(name) + '"' + (s.value ? ' checked' : '') + dis + '>' +
        esc(s.checkboxLabel || '是') + '</label>';
    } else if (s.type === 'date') {
      input = '<input type="date" name="' + esc(name) + '" value="' +
        esc(s.value ? U.dateStr(s.value) : '') + '"' + dis + '>';
    } else if (s.type === 'datetime') {
      input = '<input type="datetime-local" name="' + esc(name) + '" value="' +
        esc(toLocalInput(s.value)) + '"' + dis + '>';
    } else {
      var extra = '';
      if (s.type === 'number') extra = ' step="' + esc(s.step || '0.01') + '"' +
        (s.min !== undefined ? ' min="' + esc(s.min) + '"' : '') +
        (s.max !== undefined ? ' max="' + esc(s.max) + '"' : '');
      if (s.type === 'phone') extra = ' inputmode="tel" autocomplete="off"';
      input = '<input type="' + (s.type === 'number' ? 'number' : 'text') + '" name="' + esc(name) + '"' +
        ' value="' + esc(s.value === null || s.value === undefined ? '' : s.value) + '"' + dis + extra + ph + '>';
    }

    return '<label class="f' + (s.cls ? ' ' + s.cls : '') + '">' + esc(s.label || '') + req + input + hint + '</label>';
  }

  /** 批量渲染字段（.form-grid 容器） */
  function formGrid(specs) {
    return '<div class="form-grid">' + (specs || []).map(field).join('') + '</div>';
  }

  /** 取单个字段值（trim；checkbox → boolean；datetime/date → ISO） */
  function readField(root, spec) {
    var el = root && root.querySelector('[name="' + spec.name + '"]');
    if (!el) return spec.type === 'checkbox' ? false : '';
    if (spec.type === 'checkbox') return !!el.checked;
    if (spec.type === 'datetime') return fromLocalInput(el.value);
    if (spec.type === 'date') return fromDateInput(el.value);
    if (spec.type === 'number') return numOrNull(el.value);
    return String(el.value === null || el.value === undefined ? '' : el.value).trim();
  }

  /** 按字段定义批量取值 → 对象（字段名 → 值） */
  function readForm(root, specs) {
    var out = {};
    (specs || []).forEach(function (s) { out[s.name] = readField(root, s); });
    return out;
  }

  /** 在表单内显示错误（复用 .err），返回 false 便于 `return fail(...)` */
  function fail(root, msg) {
    var box = root && root.querySelector('[data-form-err]');
    if (box) box.innerHTML = '<div class="err">' + esc(msg) + '</div>';
    if (App.Toast) App.Toast(msg, 'error', 4000);
    return false;
  }

  function clearError(root) {
    var box = root && root.querySelector('[data-form-err]');
    if (box) box.innerHTML = '';
  }

  /* =========================================================
   * 6. 校验器
   * ========================================================= */

  /** 学生/班级联系方式：/^[0-9\-]{7,20}$/，11 位必须以 1 开头 */
  function isPhone(v) {
    var s = String(v || '').trim();
    if (!/^[0-9\-]{7,20}$/.test(s)) return false;
    var digits = s.replace(/\D/g, '');
    if (digits.length === 11) return /^1/.test(digits);
    return digits.length >= 7;
  }

  /** 客户手机号：强制 11 位且以 1 开头 */
  function isMobile(v) {
    return /^1\d{10}$/.test(String(v || '').trim());
  }

  function textLen(v) { return String(v === null || v === undefined ? '' : v).trim().length; }

  /** 必填文本 + 长度区间 */
  function checkText(v, label, min, max) {
    var n = textLen(v);
    if (n === 0) return label + '不能为空';
    if (min && n < min) return label + '至少 ' + min + ' 个字';
    if (max && n > max) return label + '不能超过 ' + max + ' 个字';
    return '';
  }

  /** 必填数组（多选）+ 最少项数 */
  function checkList(v, label, min) {
    var n = (v && v.length) || 0;
    if (n === 0) return label + '至少选择 1 项';
    if (min && n < min) return label + '至少选择 ' + min + ' 项';
    return '';
  }

  /** 数值区间（可为空时传 required=false） */
  function checkNumber(v, label, opt) {
    var o = opt || {};
    if (v === null || v === undefined || v === '') return o.required ? label + '不能为空' : '';
    var n = Number(v);
    if (!isFinite(n)) return label + '必须是数字';
    if (o.min !== undefined && n < o.min) return label + '不能小于 ' + o.min;
    if (o.max !== undefined && n > o.max) return label + '不能大于 ' + o.max;
    return '';
  }

  /* =========================================================
   * 7. 多选 + 手填（MultiSelect）
   * ========================================================= */

  /**
   * 多选组件：已选项显示为 chips，可从下拉候选里追加，也可手填新值。
   * 用法：
   *   var ms = App.UI.multiSelect({ options: App.UI.SUBJECTS, value: ['数学'], allowCustom: true });
   *   host.appendChild(ms.el);  ...  ms.getValue() → ['数学','化学']
   */
  function multiSelect(opts) {
    var o = opts || {};
    var pool = (o.options || []).slice();
    var selected = (o.value || []).slice();
    var allowCustom = o.allowCustom !== false;
    var listId = 'ms-' + U.uid();

    var wrap = document.createElement('div');
    wrap.className = 'ms';
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;' +
      'border:1px solid var(--line,#dfe3e8);border-radius:8px;padding:6px;min-height:38px';

    function renderChips() {
      var chips = wrap.querySelectorAll('.ms-chip');
      Array.prototype.forEach.call(chips, function (c) { c.remove(); });
      var anchor = wrap.querySelector('input');
      selected.forEach(function (v, i) {
        var chip = document.createElement('span');
        chip.className = 'chip ch-blue ms-chip';
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px';
        chip.innerHTML = '<span>' + esc(v) + '</span>';
        var x = document.createElement('b');
        x.textContent = '×';
        x.style.cssText = 'cursor:pointer;font-weight:400;opacity:.75';
        x.addEventListener('click', function () {
          selected.splice(i, 1);
          renderChips();
        });
        chip.appendChild(x);
        wrap.insertBefore(chip, anchor);
      });
    }

    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('list', listId);
    input.placeholder = o.placeholder || '选择或手填后回车';
    input.style.cssText = 'border:0;outline:0;flex:1;min-width:120px;font-size:13px;background:transparent';

    var dl = document.createElement('datalist');
    dl.id = listId;
    pool.forEach(function (v) {
      var op = document.createElement('option');
      op.value = v;
      dl.appendChild(op);
    });

    function add(val) {
      var v = String(val || '').trim();
      if (!v) return;
      if (selected.indexOf(v) < 0) selected.push(v);
      input.value = '';
      renderChips();
      if (o.onChange) o.onChange(selected.slice());
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        add(input.value);
      } else if (e.key === 'Backspace' && !input.value && selected.length) {
        selected.pop();
        renderChips();
        if (o.onChange) o.onChange(selected.slice());
      }
    });
    if (!allowCustom) {
      input.addEventListener('change', function () { add(input.value); });
    }

    wrap.appendChild(input);
    wrap.appendChild(dl);
    renderChips();

    return {
      el: wrap,
      getValue: function () { return selected.slice(); },
      setValue: function (arr) { selected = (arr || []).slice(); renderChips(); },
      add: add
    };
  }

  /* =========================================================
   * 8. 时间行（TimeRow）：星期 + 起止时间，可增删
   * ========================================================= */

  /**
   * 上课时间编辑组件（班级用）：
   *   var tr = App.UI.timeRow({ value: [{weekday:2,start:'18:30',end:'20:30'}] });
   *   tr.getValue() → [{weekday,start,end}]（已按星期升序）
   *   tr.validate() → '' 或错误文案（start < end 必填）
   */
  function timeRow(opts) {
    var o = opts || {};
    var rows = (o.value && o.value.length) ? o.value.map(function (x) {
      return { weekday: int(x.weekday) || 1, start: x.start || '', end: x.end || '' };
    }) : [{ weekday: 1, start: '', end: '' }];

    var wrap = document.createElement('div');
    wrap.className = 'time-rows';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';

    function render() {
      wrap.innerHTML = '';
      rows.forEach(function (r, i) {
        var line = document.createElement('div');
        line.style.cssText = 'display:flex;gap:8px;align-items:center';
        line.innerHTML =
          '<select data-w="' + i + '" style="max-width:110px">' +
          WEEKDAYS.map(function (w, wi) {
            return '<option value="' + (wi + 1) + '"' + (r.weekday === wi + 1 ? ' selected' : '') + '>' + w + '</option>';
          }).join('') + '</select>' +
          '<input type="time" data-s="' + i + '" value="' + esc(r.start) + '">' +
          '<span class="muted">—</span>' +
          '<input type="time" data-e="' + i + '" value="' + esc(r.end) + '">' +
          '<button type="button" data-del="' + i + '" class="ghost" style="color:#c0392b">删除</button>';
        wrap.appendChild(line);
      });
      var add = document.createElement('button');
      add.type = 'button';
      add.textContent = '＋ 添加上课时间';
      add.addEventListener('click', function () {
        rows.push({ weekday: 1, start: '', end: '' });
        render();
      });
      wrap.appendChild(add);
      bind();
    }

    function bind() {
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-w]'), function (el) {
        el.addEventListener('change', function () { rows[int(el.getAttribute('data-w'))].weekday = int(el.value); });
      });
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-s]'), function (el) {
        el.addEventListener('input', function () { rows[int(el.getAttribute('data-s'))].start = el.value; });
      });
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-e]'), function (el) {
        el.addEventListener('input', function () { rows[int(el.getAttribute('data-e'))].end = el.value; });
      });
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-del]'), function (el) {
        el.addEventListener('click', function () {
          var i = int(el.getAttribute('data-del'));
          rows.splice(i, 1);
          if (!rows.length) rows.push({ weekday: 1, start: '', end: '' });
          render();
        });
      });
    }

    render();

    return {
      el: wrap,
      getValue: function () {
        return rows.filter(function (r) { return r.start && r.end; }).map(function (r) {
          return { weekday: r.weekday, start: r.start, end: r.end };
        }).sort(function (a, b) { return a.weekday - b.weekday || String(a.start).localeCompare(String(b.start)); });
      },
      setValue: function (arr) {
        rows = (arr || []).map(function (x) { return { weekday: int(x.weekday) || 1, start: x.start || '', end: x.end || '' }; });
        if (!rows.length) rows = [{ weekday: 1, start: '', end: '' }];
        render();
      },
      validate: function () {
        var filled = rows.filter(function (r) { return r.start || r.end; });
        if (!filled.length) return '上课时间至少填写 1 条';
        for (var i = 0; i < filled.length; i++) {
          var r = filled[i];
          if (!r.start || !r.end) return '第 ' + (i + 1) + ' 条上课时间需要同时填写开始与结束时间';
          if (!(r.start < r.end)) return '第 ' + (i + 1) + ' 条上课时间的开始时间必须早于结束时间';
        }
        return '';
      }
    };
  }

  /* =========================================================
   * 9. 确认框 / 统一提交包装
   * ========================================================= */

  /**
   * 统一「弹窗表单 → 校验 → 保存」包装，复用现有 App.Modal。
   * @param {{title:string, body:Element, okText?:string, cancelText?:string,
   *          onSubmit:function(close):boolean|void, onClose?:Function}} opts
   *        onSubmit 返回 false 表示校验未通过，弹窗保持打开。
   */
  function formModal(opts) {
    var o = opts || {};
    return App.Modal.open({
      title: o.title,
      body: o.body,
      okText: o.okText || '保存',
      cancelText: o.cancelText || '取消',
      onOk: function (mask) {
        if (o.onSubmit) return o.onSubmit(function () { mask.remove(); });
        return true;
      },
      onClose: o.onClose
    });
  }

  /** 二次确认（危险操作用 danger=true，按钮文案为「确认删除」） */
  function confirmDanger(html, onOk) {
    return App.Modal.confirm(html, onOk, true);
  }

  /* =========================================================
   * 导出
   * ========================================================= */
  App.UI = {
    /* 数值 */
    round2: round2,
    money: money,
    moneyPretty: moneyPretty,
    pct: pct,
    pctText: pctText,
    int: int,
    numOrNull: numOrNull,
    /* 日期 */
    toDate: toDate,
    dayStart: dayStart,
    dayEnd: dayEnd,
    addDays: addDays,
    weekStart: weekStart,
    monthStart: monthStart,
    monthEnd: monthEnd,
    yearStart: yearStart,
    yearEnd: yearEnd,
    periodRange: periodRange,
    inRange: inRange,
    rangeText: rangeText,
    toLocalInput: toLocalInput,
    fromLocalInput: fromLocalInput,
    fromDateInput: fromDateInput,
    WEEKDAYS: WEEKDAYS,
    weekdayName: weekdayName,
    scheduleText: scheduleText,
    /* 枚举 */
    GRADES: GRADES,
    SUBJECTS: SUBJECTS,
    RESOURCE_TYPES: RESOURCE_TYPES,
    INTENDED_PRODUCTS: INTENDED_PRODUCTS,
    TEST_STATUS: TEST_STATUS,
    CLASS_TYPES: CLASS_TYPES,
    PRIORITY: PRIORITY,
    STAGES: STAGES,
    options: options,
    optionsWithLabel: optionsWithLabel,
    /* 展示件 */
    statusChip: statusChip,
    priorityChip: priorityChip,
    empty: empty,
    kpi: kpi,
    /* 排序 */
    sortHeader: sortHeader,
    bindSort: bindSort,
    comparator: comparator,
    /* 表单 */
    field: field,
    formGrid: formGrid,
    readField: readField,
    readForm: readForm,
    fail: fail,
    clearError: clearError,
    multiSelect: multiSelect,
    timeRow: timeRow,
    formModal: formModal,
    confirmDanger: confirmDanger,
    /* 校验 */
    isPhone: isPhone,
    isMobile: isMobile,
    textLen: textLen,
    checkText: checkText,
    checkList: checkList,
    checkNumber: checkNumber
  };
})(window.App);
