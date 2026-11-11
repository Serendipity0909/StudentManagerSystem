/* =========================================================
 * module-home.js —— 模块⓪：概览（管理员首页）
 *
 * 变更（v2 / T2）：
 *   · 注册为 adminOnly + order:0 —— 教师落地页是「成绩管理」，导航里只有成绩一项；
 *   · 管理员版内容裁剪：不出现任何成绩 KPI、无「最近录入」表、无成绩快捷录入按钮；
 *     只保留「教务模块入口 + 同步状态」。
 *   · render() 首行 L3 自检：非管理员直达 → 统一 403 卡片（PRD §2.2 文案）。
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U;

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>' +
    '<path d="M10 20v-6h4v6"/></svg>';

  /* 管理员首页的教务模块入口（顺序与导航一致；成绩管理不在此列） */
  var ENTRIES = [
    { id: 'students', name: '学生管理', desc: '学生档案、联系方式、上课科目与老师' },
    { id: 'classes', name: '班级管理', desc: '班级卡片、上课时间、班内学生与成绩分析' },
    { id: 'customers', name: '客户管理', desc: '资源登记、跟进状态、周期统计' },
    { id: 'tasks', name: '日常工作', desc: '待办看板与日 / 周 / 月完成率汇总' },
    { id: 'contracts', name: '合同确认', desc: '价目维护、合同登记与台账' }
  ];

  /** 安全读取 App.DB 缓存（模块未上线 / 未登录 / 未拉到时返回空数组） */
  function rows(name) {
    try {
      if (App.DB && App.DB.table) return App.DB.table(name).list();
    } catch (e) { }
    return [];
  }

  function kpi(k, v, d) {
    return '<div class="kpi"><div class="k">' + U.esc(k) + '</div><div class="v">' + v + '</div>' +
      (d ? '<div class="d">' + U.esc(d) + '</div>' : '') + '</div>';
  }

  App.registerModule({
    id: 'home',
    name: '概览',
    icon: ICON,
    ready: true,
    home: true,
    adminOnly: true,          // 教师看不到概览（教师只有「成绩管理」）
    order: 0,
    title: '概览',
    subtitle: '教务数据速览与模块入口',
    render: function () {
      /* L3 直达拦截：非管理员不应渲染任何内容 */
      if (App.Perm && App.Perm.denied(this)) return App.Perm.forbiddenCard(this);

      var students = rows('students');
      var classes = rows('classes');
      var customers = rows('customers');
      var tasks = rows('daily_tasks');
      var todo = tasks.filter(function (t) { return t.status !== 'done'; }).length;
      var signed = customers.filter(function (c) { return c.paid === true; }).length;

      var S = App.Sync ? App.Sync.state : null;
      var lastSync = S ? S.lastSyncAt : null;

      var h = '<div class="grid g4">' +
        kpi('学生档案', students.length + ' 人', classes.length ? '覆盖 ' + classes.length + ' 个班级' : '尚未分班') +
        kpi('班级', classes.length + ' 个', '含上课时间与任课老师') +
        kpi('客户资源', customers.length + ' 条', signed ? '已签单 ' + signed + ' 人' : '暂无签单') +
        kpi('待办未完成', todo + ' 项', tasks.length ? '共 ' + tasks.length + ' 项' : '暂无待办') +
        '</div>';

      h += '<div class="card"><h3>教务模块<span class="h-note">成绩数据由教师账号维护，此处不展示</span></h3>' +
        '<div class="grid g3" style="margin-top:6px">';
      ENTRIES.forEach(function (e) {
        h += '<div class="card" style="margin:0;box-shadow:none;border:1px solid var(--line,#e6e9ee)">' +
          '<h3 style="margin:0 0 6px">' + U.esc(e.name) + '</h3>' +
          '<div class="muted" style="font-size:12.5px;line-height:1.7;min-height:44px">' + U.esc(e.desc) + '</div>' +
          '<button data-goto="' + e.id + '" style="margin-top:10px">进入' + U.esc(e.name) + '</button>' +
          '</div>';
      });
      h += '</div></div>';

      h += '<div class="card"><h3>同步状态<span class="h-note">云端数据库 · 实时共享</span></h3>' +
        '<div class="store-line"><span class="k">当前身份</span><b>管理员</b></div>' +
        '<div class="store-line"><span class="k">数据存储位置</span><b>云端数据库（多人实时共享）</b></div>' +
        '<div class="store-line"><span class="k">最近同步</span><b>' + U.hms(lastSync) + '</b></div>' +
        '<div class="store-line"><span class="k">账号状态</span><b>' +
        U.esc(App.Perm ? App.Perm.statusLabel() : '正常') + '</b></div>' +
        '<div class="hint">学生 / 班级 / 客户 / 日常 / 合同的数据同样保存在云端；' +
        '换设备登录即可继续。成绩数据归教师账号维护，管理员不可见也不可修改。</div>' +
        '</div>';

      if (!students.length && !classes.length && !customers.length && !tasks.length) {
        h += '<div class="card"><h3>开始使用</h3>' +
          '<div class="empty">还没有教务数据。点上方任意模块入口开始录入；' +
          '成绩数据请由教师账号在「成绩管理」中维护。</div></div>';
      }

      return h;
    },
    bind: function (host) {
      Array.prototype.forEach.call(host.querySelectorAll('[data-goto]'), function (b) {
        b.addEventListener('click', function () { App.go(b.getAttribute('data-goto')); });
      });
    }
  });
})(window.App);
