/* =========================================================
 * module-tasks.js —— 日常工作（Tab① 待办看板 / Tab② 汇总）
 *
 * 列名完全照抄 docs/ddl-v2.sql 的 daily_tasks 表：
 *   title / priority(high|mid|low) / due_at / status(todo|done) /
 *   done_at / remark / created_by / created_at / updated_at
 *
 * 看板分组（ARCH §4.3）：
 *   已逾期(todo 且 due_at < now) → 今天 → 明天 → 本周 → 以后 → 已完成(默认折叠)
 *   组内排序：优先级 高>中>低 → due_at 升序；已完成组按 done_at 降序；空分组不渲染。
 *
 * 汇总口径（PRD §6.2）：
 *   周期归属一律用 due_at（周 = 周一~周日；月 = 自然月；日 = 自然日）；
 *   每周期 planned = due_at∈区间，done = 其中 status==='done'，
 *   undone = planned−done，overdue = 其中 status!=='done' 且 due_at < now；
 *   rate = pctText(done, planned)，分母 0 →「—」。
 *   跨周期完成（上周的活本周干完）计入其 due_at 所属周期 → 完成率不超 100%。
 *
 * 纯函数外露：App.TasksCore = { validate, taskSummary, taskGroups }
 *   —— 不读 App.DB / App.Store / 不碰 DOM，数据全部走参数。
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, UI = App.UI, Toast = App.Toast;
  var esc = function (s) { return U.esc(s); };

  var TABLE = 'daily_tasks';

  var PRIORITIES = [
    { value: 'high', label: '高' },
    { value: 'mid', label: '中' },
    { value: 'low', label: '低' }
  ];

  var state = {
    tab: 'board',
    gran: 'day',            /* 汇总粒度：day / week / month（默认每天） */
    doneCollapsed: true     /* 已完成分组默认折叠 */
  };

  var DAY_MS = 86400000;

  function tstr(v) {
    return String(v === null || v === undefined ? '' : v).trim();
  }

  function pctText(num, den) {
    return (UI && UI.pctText) ? UI.pctText(num, den) : '—';
  }

  /* =========================================================
   * Core 纯函数（Node 测试直接调用；数据全部走参数）
   * ========================================================= */

  /**
   * 表单校验 + 归一（就地修改 form）。
   * status='done' → done_at 必填；status='todo' → done_at 自动清空。
   */
  function validate(form) {
    var f = (form = form || {});
    var errors = {};

    var title = tstr(f.title);
    if (!title) errors.title = '任务标题不能为空';
    else if (title.length > 60) errors.title = '任务标题不能超过 60 个字';

    var priority = tstr(f.priority) || 'mid';
    if (['high', 'mid', 'low'].indexOf(priority) < 0) errors.priority = '优先级不合法';

    if (!f.due_at) errors.due_at = '请填写预期完成时间';
    else if (isNaN(new Date(f.due_at).getTime())) errors.due_at = '预期完成时间格式不合法';

    var status = tstr(f.status) || 'todo';
    if (['todo', 'done'].indexOf(status) < 0) errors.status = '完成状态不合法';

    if (status === 'done') {
      if (!f.done_at) errors.done_at = '已完成时必须填写完成时间';
      else if (isNaN(new Date(f.done_at).getTime())) errors.done_at = '完成时间格式不合法';
    } else {
      f.done_at = null;   /* 改回未完成 → 完成时间清空 */
    }

    if (tstr(f.remark).length > 500) errors.remark = '备注不能超过 500 个字';

    /* 归一 */
    f.title = title;
    f.priority = priority;
    f.status = status;

    return { ok: Object.keys(errors).length === 0, errors: errors };
  }

  var PRI_RANK = { high: 0, mid: 1, low: 2 };
  var GROUP_ORDER = ['overdue', 'today', 'tomorrow', 'week', 'later', 'done'];
  var GROUP_LABELS = {
    overdue: '已逾期', today: '今天', tomorrow: '明天',
    week: '本周', later: '以后', done: '已完成'
  };

  /**
   * 看板分组（纯函数）。
   * 分组：已逾期(todo 且 due_at < now) → 今天 → 明天 → 本周 → 以后 → 已完成；
   * 组内排序：优先级 高>中>低 → due_at 升序；已完成组按 done_at 降序。
   * 空分组不返回（渲染层零噪音）。
   * returns [{ key, label, count, items }]
   */
  function taskGroups(tasks, now) {
    var base = (now && !isNaN(new Date(now).getTime())) ? new Date(now) : new Date();

    var todayStart = UI.dayStart(base).getTime();
    var tomorrowStart = todayStart + DAY_MS;
    var dayAfter = tomorrowStart + DAY_MS;
    var wkStart = UI.weekStart(base);
    var wkEnd = UI.dayEnd(UI.addDays(wkStart, 6)).getTime();
    var nowMs = base.getTime();

    var buckets = {};
    GROUP_ORDER.forEach(function (k) { buckets[k] = []; });

    (tasks || []).forEach(function (t) {
      if (String(t.status) === 'done') { buckets.done.push(t); return; }
      var d = t.due_at ? new Date(t.due_at) : null;
      if (!d || isNaN(d.getTime())) { buckets.later.push(t); return; }
      var ms = d.getTime();
      var key;
      if (ms < nowMs) key = 'overdue';                  /* 未完成且预期时间已过（含今天早些时候） */
      else if (ms < tomorrowStart) key = 'today';       /* 今天（含今天 23:59） */
      else if (ms < dayAfter) key = 'tomorrow';         /* 明天（从明天 00:00 起） */
      else if (ms <= wkEnd) key = 'week';               /* 本周内更晚的日子（含周日 23:59） */
      else key = 'later';
      buckets[key].push(t);
    });

    GROUP_ORDER.forEach(function (k) {
      if (k === 'done') {
        buckets.done.sort(function (a, b) {
          var da = a.done_at ? new Date(a.done_at).getTime() : 0;
          var db = b.done_at ? new Date(b.done_at).getTime() : 0;
          return db - da;                               /* 已完成组：done_at 降序 */
        });
      } else {
        buckets[k].sort(function (a, b) {
          var pa = (PRI_RANK[a.priority] === undefined) ? 1 : PRI_RANK[a.priority];
          var pb = (PRI_RANK[b.priority] === undefined) ? 1 : PRI_RANK[b.priority];
          if (pa !== pb) return pa - pb;                /* 优先级 高 > 中 > 低 */
          var da = a.due_at ? new Date(a.due_at).getTime() : Infinity;
          var db = b.due_at ? new Date(b.due_at).getTime() : Infinity;
          return da - db;                               /* 同优先级按 due_at 升序 */
        });
      }
    });

    return GROUP_ORDER
      .filter(function (k) { return buckets[k].length > 0; })
      .map(function (k) {
        return { key: k, label: GROUP_LABELS[k], count: buckets[k].length, items: buckets[k] };
      });
  }

  /**
   * 周期汇总（纯函数，口径 PRD §6.2：周期归属一律用 due_at）。
   * @param {Array} tasks 全量任务
   * @param {string} granularity 'day' | 'week' | 'month'
   * @param {Date} now 汇总执行时刻（逾期判定基准）
   * @param {number} [periods] 周期数（默认 日 14 / 周 12 / 月 12）
   * @returns {[{label, start, end, planned, done, undone, overdue, rate}]}
   *          按时间升序返回，末位 = 当前周期；rate 为字符串（'50.0%' 或 '—'）。
   */
  function taskSummary(tasks, granularity, now, periods) {
    var gran = (granularity === 'week' || granularity === 'month') ? granularity : 'day';
    var base = (now && !isNaN(new Date(now).getTime())) ? new Date(now) : new Date();
    var n = Math.max(1, (UI && UI.int ? UI.int(periods) : Math.round(Number(periods) || 0)) ||
      (gran === 'day' ? 14 : 12));
    var list = tasks || [];

    var out = [];

    if (gran === 'day') {
      var cur = UI.dayStart(base);
      for (var i = n - 1; i >= 0; i--) {
        var s = UI.addDays(cur, -i);
        out.push({ label: U.dateStr(s), start: s, end: UI.dayEnd(s) });
      }
    } else if (gran === 'week') {
      var curW = UI.weekStart(base);
      for (var j = n - 1; j >= 0; j--) {
        var w = UI.addDays(curW, -7 * j);
        out.push({ label: U.dateStr(w) + ' ~ ' + U.dateStr(UI.addDays(w, 6)), start: w, end: UI.dayEnd(UI.addDays(w, 6)) });
      }
    } else {
      var y = base.getFullYear(), m = base.getMonth();
      for (var k = n - 1; k >= 0; k--) {
        var mm = m - k;
        var yy = y + Math.floor(mm / 12);
        mm = ((mm % 12) + 12) % 12;
        var ms = new Date(yy, mm, 1, 0, 0, 0, 0);
        var me = new Date(yy, mm + 1, 0, 23, 59, 59, 999);
        out.push({ label: yy + '年' + (mm + 1) + '月', start: ms, end: me });
      }
    }

    var nowMs = base.getTime();
    return out.map(function (p) {
      var planned = 0, done = 0, overdue = 0;
      var sMs = p.start.getTime(), eMs = p.end.getTime();
      list.forEach(function (t) {
        var d = t.due_at ? new Date(t.due_at) : null;
        if (!d || isNaN(d.getTime())) return;
        var ms = d.getTime();
        if (ms < sMs || ms > eMs) return;
        planned++;
        if (String(t.status) === 'done') done++;
        else if (ms < nowMs) overdue++;
      });
      return {
        label: p.label, start: p.start, end: p.end,
        planned: planned, done: done, undone: planned - done, overdue: overdue,
        rate: pctText(done, planned)
      };
    });
  }

  App.TasksCore = { validate: validate, taskSummary: taskSummary, taskGroups: taskGroups };

  /* =========================================================
   * 页面层
   * ========================================================= */

  function rows() { return App.DB.table(TABLE).list(); }
  function byId(id) {
    return rows().filter(function (r) { return String(r.id) === String(id); })[0] || null;
  }

  /* ---------- Tab① 待办看板 ---------- */

  function taskCard(t) {
    var done = String(t.status) === 'done';
    var remark = tstr(t.remark);
    var remarkCut = remark.length > 40 ? remark.slice(0, 40) + '…' : remark;
    return '<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 2px;border-top:1px dashed #eef0f2">' +
      '<input type="checkbox" data-act="toggle" data-id="' + esc(t.id) + '"' + (done ? ' checked' : '') +
      ' title="' + (done ? '取消完成（清空完成时间）' : '勾选完成（自动写入完成时间）') + '" style="margin-top:4px">' +
      '<div style="flex:1;min-width:0">' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<b style="' + (done ? 'text-decoration:line-through;color:#9aa4ad' : '') + '">' + esc(t.title) + '</b>' +
      UI.priorityChip(t.priority) +
      '<span class="muted" style="font-size:12px">预期 ' + esc(U.hms(t.due_at)) + '</span>' +
      (done ? '<span class="chip ch-green">已完成</span><span class="muted" style="font-size:12px">完成于 ' + esc(U.hms(t.done_at)) + '</span>' : '') +
      '</div>' +
      (remarkCut ? '<div class="muted" style="font-size:12.5px;margin-top:3px">' + esc(remarkCut) + '</div>' : '') +
      '</div>' +
      '<div style="white-space:nowrap">' +
      '<button data-act="edit" data-id="' + esc(t.id) + '">编辑</button> ' +
      '<button data-act="del" data-id="' + esc(t.id) + '" style="color:#c0392b">删除</button>' +
      '</div></div>';
  }

  function renderBoard() {
    var all = rows();
    var groups = App.TasksCore.taskGroups(all, new Date());

    var h = '<div class="card" style="margin-bottom:12px">' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<input id="quick-task" placeholder="＋ 新增任务：写完标题后回车保存（默认优先级「中」，预期完成时间今天 23:59）"' +
      ' style="flex:1" maxlength="60">' +
      '<button class="primary" data-act="new-task">新增待办</button>' +
      '</div></div>';

    if (!all.length) {
      h += '<div class="card">' + UI.empty('还没有任务。在下方输入框里写第一条待办，回车保存。') + '</div>';
      return h;
    }

    groups.forEach(function (g) {
      if (g.key === 'done' && state.doneCollapsed) {
        h += '<div class="card" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:center">' +
          '<h3 style="margin:0">已完成 <span class="chip ch-green">' + g.count + '</span>' +
          '<span class="muted" style="font-size:12px;font-weight:400;margin-left:6px">默认折叠</span></h3>' +
          '<button data-act="expand-done">展开</button></div></div>';
        return;
      }
      h += '<div class="card" style="margin-bottom:12px"><h3>' + esc(g.label) +
      ' <span class="chip' + (g.key === 'overdue' ? ' ch-red' : (g.key === 'done' ? ' ch-green' : ' ch-blue')) + '">' + g.count + '</span>' +
      (g.key === 'done' ? '<button data-act="collapse-done" style="float:right">收起</button>' : '') +
      '</h3>';
      g.items.forEach(function (t) { h += taskCard(t); });
      h += '</div>';
    });
    return h;
  }

  /* ---------- Tab② 汇总 ---------- */

  function renderSummary() {
    var gran = state.gran;
    var periods = gran === 'day' ? 14 : 12;
    var sum = App.TasksCore.taskSummary(rows(), gran, new Date(), periods);

    var h = '<div class="card" style="margin-bottom:12px"><div class="toolbar" style="margin-bottom:0">' +
      [['day', '每天'], ['week', '每周'], ['month', '每月']].map(function (x) {
        return '<button data-gran="' + x[0] + '"' + (gran === x[0] ? ' class="primary"' : '') + '>' + x[1] + '</button>';
      }).join('') +
      '<span class="muted" style="font-size:12.5px;margin-left:8px">最近 ' + periods + ' 个周期 · 周期归属按「预期完成时间」</span>' +
      '</div></div>';

    if (!rows().length) {
      h += '<div class="card">' + UI.empty('还没有任务，暂无可汇总的数据。') + '</div>';
      return h;
    }

    h += '<div class="card"><h3>完成情况汇总<span class="h-note">跨周期完成计入其预期完成时间所属周期</span></h3>' +
      '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>周期</th><th class="c">计划数</th><th class="c">已完成</th><th class="c">未完成</th>' +
      '<th class="c">逾期数</th><th style="min-width:220px">完成率</th>' +
      '</tr></thead><tbody>';
    sum.forEach(function (r) {
      var p = UI.pct(r.done, r.planned);
      var width = (p === null) ? 0 : Math.max(0, Math.min(100, p));
      h += '<tr>' +
        '<td>' + esc(r.label) + '</td>' +
        '<td class="c">' + r.planned + '</td>' +
        '<td class="c">' + r.done + '</td>' +
        '<td class="c">' + r.undone + '</td>' +
        '<td class="c"' + (r.overdue > 0 ? ' style="color:#c0392b;font-weight:700"' : '') + '>' + r.overdue + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:10px">' +
        '<div style="flex:1;height:10px;border-radius:6px;background:#eef0f2;overflow:hidden">' +
        '<div style="height:10px;border-radius:6px;background:' + (width >= 100 ? '#2f7c62' : (width >= 60 ? '#4f9d7f' : '#c8892e')) +
        ';width:' + width + '%"></div></div>' +
        '<b style="min-width:48px;text-align:right">' + esc(r.rate) + '</b>' +
        '</div></td></tr>';
    });
    h += '</tbody></table></div></div>';
    return h;
  }

  /* ---------- 快捷新增（回车即存，只填标题） ---------- */

  function quickAdd(title) {
    var t = tstr(title);
    if (!t) return;
    if (App.Perm && !App.Perm.assertWrite('tasks')) return;
    var form = {
      title: t,
      priority: 'mid',
      due_at: UI.dayEnd(new Date()).toISOString(),   /* 默认今天 23:59 */
      status: 'todo',
      done_at: null,
      remark: '',
      created_by: (App.Sync && App.Sync.me && App.Sync.me()) || ''
    };
    var res = App.TasksCore.validate(form);
    if (!res.ok) {
      Toast(res.errors[Object.keys(res.errors)[0]], 'error', 4000);
      return;
    }
    App.DB.table(TABLE).insert(form).then(function () {
      Toast('已添加待办', 'ok');
    }).catch(function (e) {
      Toast('保存失败：' + (e && e.message ? e.message : e), 'error', 5000);
    });
  }

  /* ---------- 勾选完成 / 取消完成 ---------- */

  function toggleTask(id) {
    if (App.Perm && !App.Perm.assertWrite('tasks')) return;
    var row = byId(id);
    if (!row) return;
    var patch;
    if (String(row.status) === 'done') {
      patch = { status: 'todo', done_at: null };   /* 取消完成 → 完成时间自动清空 */
    } else {
      patch = { status: 'done', done_at: new Date().toISOString() };   /* 勾选即置完成并写完成时间 */
    }
    App.DB.table(TABLE).update(id, patch).catch(function (e) {
      Toast('操作失败：' + (e && e.message ? e.message : e), 'error', 5000);
    });
  }

  /* ---------- 新增 / 编辑弹窗 ---------- */

  function openTaskForm(existing) {
    if (App.Perm && !App.Perm.assertWrite('tasks')) return;

    var body = document.createElement('div');
    var v = existing || {};
    var dueDefault = existing ? existing.due_at : new Date(Date.now() + 3600000).toISOString();

    body.innerHTML =
      '<div class="form-grid">' +
      '<label class="f" style="grid-column:1/-1">任务标题 *<input name="title" maxlength="60" value="' + esc(v.title) + '"></label>' +
      '<label class="f">优先级<select name="priority">' + PRIORITIES.map(function (p) {
        var sel = (tstr(v.priority) || 'mid') === p.value;
        return '<option value="' + p.value + '"' + (sel ? ' selected' : '') + '>' + p.label + '</option>';
      }).join('') + '</select></label>' +
      '<label class="f">预期完成时间 *<input type="datetime-local" name="due_at" value="' + esc(UI.toLocalInput(dueDefault)) + '">' +
      '<span class="muted" style="font-size:12px">允许填过去时间（补录），未完成会归入「已逾期」</span></label>' +
      '<label class="f">完成状态<select name="status">' +
      '<option value="todo"' + (String(v.status) !== 'done' ? ' selected' : '') + '>未完成</option>' +
      '<option value="done"' + (String(v.status) === 'done' ? ' selected' : '') + '>已完成</option>' +
      '</select></label>' +
      '<label class="f">完成时间<input type="datetime-local" name="done_at" id="in-done-at" value="' +
      esc(UI.toLocalInput(v.done_at)) + '"' + (String(v.status) === 'done' ? '' : ' disabled') + '>' +
      '<span class="muted" style="font-size:12px">勾选完成时自动写入当前时间，可改</span></label>' +
      '</div>' +
      '<label class="f" style="display:block;margin-top:12px">备注<textarea name="remark" rows="3" maxlength="500">' + esc(v.remark) + '</textarea></label>' +
      '<div data-form-err></div>';

    var q = function (n) {
      var el = body.querySelector('[name=' + n + ']');
      return el ? el.value : '';
    };

    var selStatus = body.querySelector('[name=status]');
    var inDoneAt = body.querySelector('#in-done-at');
    if (selStatus) selStatus.addEventListener('change', function () {
      var done = selStatus.value === 'done';
      if (inDoneAt) {
        inDoneAt.disabled = !done;
        if (done && !inDoneAt.value) inDoneAt.value = UI.toLocalInput(new Date());
        if (!done) inDoneAt.value = '';
      }
    });

    function submit(close) {
      var form = {
        title: tstr(q('title')),
        priority: q('priority') || 'mid',
        due_at: UI.fromLocalInput(q('due_at')),
        status: q('status') || 'todo',
        done_at: (q('status') === 'done')
          ? (UI.fromLocalInput(q('done_at')) || new Date().toISOString())
          : null,
        remark: tstr(q('remark')),
        created_by: (existing && existing.created_by) ||
          (App.Sync && App.Sync.me && App.Sync.me()) || ''
      };

      var res = App.TasksCore.validate(form);
      if (!res.ok) {
        var first = Object.keys(res.errors)[0];
        var box = body.querySelector('[data-form-err]');
        if (box) box.innerHTML = '<div class="err">' + esc(res.errors[first]) + '</div>';
        var el = body.querySelector('[name=' + first + ']');
        if (el && el.focus) el.focus();
        Toast(res.errors[first], 'error', 4000);
        return false;
      }

      var t = App.DB.table(TABLE);
      var after = function () {
        Toast(existing ? '任务已更新' : '任务已新增', 'ok');
        close();
      };
      var onFail = function (e) {
        Toast('保存失败：' + (e && e.message ? e.message : e), 'error', 5000);
      };
      if (existing) t.update(existing.id, form).then(after, onFail);
      else t.insert(form).then(after, onFail);
      return false;
    }

    UI.formModal({
      title: existing ? '编辑待办 · ' + v.title : '新增待办',
      body: body,
      okText: '保存',
      onSubmit: submit
    });
  }

  /* ---------- 删除 ---------- */

  function confirmDel(id) {
    var row = byId(id);
    if (!row) return;
    if (App.Perm && !App.Perm.assertWrite('tasks')) return;
    var done = String(row.status) === 'done';
    var msg = done
      ? '确定删除任务 <b>' + esc(row.title) + '</b> 吗？<br><br>' +
        '<span style="color:#c0392b">该任务已完成，删除会影响历史汇总数据，且不可恢复。</span>'
      : '确定删除任务 <b>' + esc(row.title) + '</b> 吗？删除后不可恢复。';
    UI.confirmDanger(msg, function () {
      App.DB.table(TABLE).remove(id).then(function () {
        Toast('任务已删除', 'ok');
      }).catch(function (e) {
        Toast('删除失败：' + (e && e.message ? e.message : e), 'error', 5000);
      });
    });
  }

  /* =========================================================
   * 模块注册
   * ========================================================= */

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="2.5"/>' +
    '<path d="M8 9h8"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';

  var TABS = [
    { id: 'board', name: '① 待办看板' },
    { id: 'summary', name: '② 汇总' }
  ];

  App.registerModule({
    id: 'tasks', name: '日常工作', icon: ICON, ready: true,
    adminOnly: true,
    order: 40,
    title: '日常工作', subtitle: '待办看板 · 优先级 · 每日/每周/每月汇总',

    render: function () {
      /* L3 直达拦截：非管理员手输 #/tasks 时输出统一 403 卡片 */
      if (App.Perm.denied(this)) return App.Perm.forbiddenCard(this);
      var h = '<div class="toolbar" style="margin-bottom:14px">';
      TABS.forEach(function (t) {
        h += '<button data-tab="' + t.id + '"' + (state.tab === t.id ? ' class="primary"' : '') + '>' + t.name + '</button>';
      });
      h += '</div>';
      h += (state.tab === 'summary') ? renderSummary() : renderBoard();
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

      if (state.tab === 'summary') {
        Array.prototype.forEach.call(host.querySelectorAll('[data-gran]'), function (b) {
          b.addEventListener('click', function () {
            state.gran = b.getAttribute('data-gran');
            App.render();
          });
        });
        return;
      }

      /* 快捷新增：单行输入，回车即存 */
      var quick = host.querySelector('#quick-task');
      if (quick) quick.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          quickAdd(quick.value);
          quick.value = '';
        }
      });

      Array.prototype.forEach.call(host.querySelectorAll('[data-act]'), function (el) {
        var act = el.getAttribute('data-act');
        if (act === 'toggle') {
          el.addEventListener('change', function () {
            toggleTask(el.getAttribute('data-id'));
          });
        } else {
          el.addEventListener('click', function () {
            var id = el.getAttribute('data-id');
            if (act === 'new-task') openTaskForm(null);
            else if (act === 'edit') openTaskForm(byId(id));
            else if (act === 'del') confirmDel(id);
            else if (act === 'expand-done') { state.doneCollapsed = false; App.render(); }
            else if (act === 'collapse-done') { state.doneCollapsed = true; App.render(); }
          });
        }
      });
    }
  });
})(window.App);
