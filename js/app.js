/* =========================================================
 * app.js —— 外壳：导航、路由、备份/恢复/清空、示例数据
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, Store = App.Store, Score = App.Score, Modal = App.Modal, Toast = App.Toast;
  var currentId = 'home';
  /* 是否「直接访问」：地址栏手输 hash / 首次带 hash 打开 → true。
     用于区分 L2 路由兜底（站内跳转）与 L3 直达拦截（输出 403 卡片）。 */
  var directAccess = false;

  /* ---------- 占位模块（后续按同样方式补充真实实现即可） ---------- */
  var FUTURE = [
    {
      id: 'archive', name: '学生档案',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
      desc: '学籍信息、联系方式、家长信息、奖惩记录、成长档案。'
    },
    {
      id: 'attendance', name: '考勤管理',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
      desc: '日常出勤点名、请假/迟到/早退登记、月度考勤汇总与预警。'
    },
    {
      id: 'timetable', name: '课程课表',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v11"/></svg>',
      desc: '班级课表、教师排课、调课代课记录。'
    },
    {
      id: 'homework', name: '作业管理',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
      desc: '每日作业布置、提交情况跟踪、错题汇集。'
    }
  ];

  FUTURE.forEach(function (m) {
    App.registerModule({
      id: m.id, name: m.name, icon: m.icon, ready: false,
      title: m.name, subtitle: '规划中',
      render: function () {
        return '<div class="card"><h3>' + U.esc(m.name) + '<span class="h-note">即将上线</span></h3>' +
          '<p class="muted" style="margin:0">' + U.esc(m.desc) + '</p>' +
          '<div class="good" style="margin-top:14px">这个模块还没有实现。系统在架构上已经预留：' +
          '新增一个 <code>js/module-xxx.js</code>，调用 <code>App.registerModule(...)</code> 完成数据与界面，' +
          '再在 <code>index.html</code> 里加一行 script 引用即可，侧边栏会自动出现入口。</div></div>';
      },
      bind: function () { }
    });
  });

  /* ---------- 渲染 ---------- */

  /* 角色判定统一走 App.Perm（唯一出口，转发 App.Sync.isAdmin） */
  function isAdmin() {
    if (App.Perm) return App.Perm.isAdmin();
    return !!(App.Sync && App.Sync.isAdmin && App.Sync.isAdmin());
  }
  function allowed(mod) {
    if (App.Perm) return App.Perm.allowed(mod);
    return !(mod && mod.adminOnly && !isAdmin());
  }

  /**
   * 导航排序比较器（home 优先 → order 升序 → ready 优先 → id 字典序）。
   *
   * 必须是**严格反对称**的：cmp(a,b) 恒等于 -cmp(b,a)。
   * 旧实现写成 `if (a.home) return -1;`，a、b 同为 home 时也返回 -1，
   * cmp(a,b) 与 cmp(b,a) 都等于 -1 —— 违反反对称公理，排序结果依赖引擎的
   * 比较顺序，同一份数据在不同初序下可能排出不同导航。
   * 改为差值形式后，最后一级再补 id 字典序兜底，保证完全可复现。
   * 通过 App.navCompare 暴露给冒烟测试断言反对称性。
   */
  function navCompare(a, b) {
    var home = (b.home ? 1 : 0) - (a.home ? 1 : 0);
    if (home !== 0) return home;
    var oa = (a.order === null || a.order === undefined) ? 100 : a.order;
    var ob = (b.order === null || b.order === undefined) ? 100 : b.order;
    if (oa !== ob) return oa - ob;
    var ready = (b.ready ? 1 : 0) - (a.ready ? 1 : 0);
    if (ready !== 0) return ready;
    return String(a.id).localeCompare(String(b.id));
  }

  /** L1 用：导航可见模块（过滤 + 排序：home 优先 → order 升序 → ready 优先） */
  function navList() {
    var list = App.modules.filter(function (m) {
      if (m.hidden) return false;
      if (m.adminOnly && !isAdmin()) return false;      // 管理员专属 → 教师不可见
      if (m.teacherOnly && isAdmin()) return false;     // 教师专属模块（当前无）→ 管理员不可见
      if (!allowed(m)) return false;
      if (m.visible && !m.visible()) return false;
      return true;
    });
    return list.sort(navCompare);
  }

  /** L2 用：当前角色允许的第一个已实现模块（教师→score，管理员→home） */
  function fallbackModule() {
    var list = navList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].ready) return list[i];
    }
    return null;
  }

  function navHTML() {
    var h = '<div class="nav-sec">工作区</div>';
    // 已实现模块：hidden 不展示；adminOnly 仅管理员可见；teacherOnly 仅教师可见（当前无此类模块）；visible 自定义判断
    navList().filter(function (m) { return m.ready; }).forEach(function (m) {
      h += '<div class="nav-item' + (m.id === currentId ? ' active' : '') + '" data-mod="' + m.id + '">' +
        m.icon + '<span>' + U.esc(m.name) + '</span></div>';
    });
    // 规划中模块：仅管理员渲染（教师导航只有「成绩管理」一项，符合 PRD §2.3 口径）
    var soon = isAdmin() ? navList().filter(function (m) { return !m.ready; }) : [];
    if (soon.length) {
      h += '<div class="nav-sec">更多模块（规划中）</div>';
      soon.forEach(function (m) {
        h += '<div class="nav-item soon" data-mod="' + m.id + '">' + m.icon +
          '<span>' + U.esc(m.name) + '</span><span class="soon-tag">规划中</span></div>';
      });
    }
    return h;
  }

  /* 是否需要显示独立登录页（未登录 / 鉴权失效） */
  function authGate() {
    return !!(App.Sync && App.Sync.needLogin && App.Sync.needLogin());
  }

  /* 未登录时统一跳独立登录页；子模块的可见性也在这里兜底，避免越权访问 */
  function pickModule() {
    var find = function (id) {
      return App.modules.filter(function (m) { return m.id === id; })[0];
    };
    var mod = find(currentId);
    /* L2 路由兜底：目标模块当前角色无权限 → 回退到「当前角色允许的第一个模块」
       （教师 → score，管理员 → home）。
       例外：地址栏直接访问（directAccess）不回退，交给模块 render() 首行输出 403（L3）。 */
    if (mod && !allowed(mod) && !directAccess) mod = null;
    if (mod && !mod.ready && !directAccess) mod = null;
    if (!mod) mod = fallbackModule();
    if (!mod) mod = find('home') || App.modules[0];
    if (mod) currentId = mod.id;
    return mod;
  }

  function render() {
    // 登录门控：未登录或鉴权失效时统一重定向到独立登录页
    if (authGate()) {
      var root = document.getElementById('app');
      if (root) root.classList.add('auth-mode');
      document.getElementById('nav').innerHTML = '';
      var host = document.getElementById('content');
      host.innerHTML = App.LoginPage ? App.LoginPage.render() : '';
      if (App.LoginPage && App.LoginPage.bind) App.LoginPage.bind(host);
      return;
    }
    var appEl = document.getElementById('app');
    if (appEl) appEl.classList.remove('auth-mode');

    document.getElementById('nav').innerHTML = navHTML();
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (el) {
      el.addEventListener('click', function () { go(el.getAttribute('data-mod')); });
    });

    /* 顶栏 4 个按钮（示例数据 / 备份 / 恢复 / 清空）作用于成绩数据。
       分两组（T8）：
       · demo / backup / restore：T6 口径不变 ——「可编辑」账号可见（管理员与教师同权），
         守卫仍是 assertScoreAction()（只看 canEdit）。
       · clear（清空数据）：不可撤销的全量删除，升为**管理员专属**——
         isAdmin() && canEdit() 才显示，handler 首行 assertAdminWrite() 双重校验。
       此处只是视觉裁剪，DOM 隐藏挡不住控制台 click()，真正的拦截在 handler 首行。 */
    var canEditNow = App.Perm ? App.Perm.canEdit() : true;
    ['btn-demo', 'btn-backup', 'btn-restore'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = canEditNow ? '' : 'none';
    });
    var clearVisible = App.Perm
      ? (App.Perm.isAdmin() && App.Perm.canEdit())
      : true;
    var clearEl = document.getElementById('btn-clear');
    if (clearEl) clearEl.style.display = clearVisible ? '' : 'none';

    var mod = pickModule();
    if (!mod) return;
    document.getElementById('mod-title').textContent = mod.title || mod.name;
    document.getElementById('mod-sub').textContent = mod.subtitle || '';

    var host = document.getElementById('content');
    host.innerHTML = mod.render();
    if (mod.bind) mod.bind(host);

    // 纯云端模式：容量口径只有云端（本机不再保存任何成绩数据）
    var n = Store.data.records.length;
    var kb = Store.usageKB();
    var signedIn = !!(App.Sync && App.Sync.state.signedIn);
    var cap = '<div class="cs-title">云端数据库 · 实时共享</div>' +
      '<div class="store-line"><span class="k">记录</span><b>' + n + ' 条</b></div>' +
      '<div class="store-line"><span class="k">用量</span><b>约 ' + kb + ' KB</b></div>' +
      '<div class="store-line"><span class="k">上限</span><b>以云端免费额度为准</b></div>' +
      (signedIn ? '' : '<div class="store-line"><span class="k">状态</span><b>未登录</b></div>');
    document.getElementById('store-state').innerHTML = cap;
  }

  function go(id, tab) {
    if (tab && App.ScoreModule) App.ScoreModule.state.tab = tab;
    directAccess = false;                      // 站内跳转：越权时走 L2 兜底，不输出 403
    currentId = id;
    if (App.closeNav) App.closeNav();          // 手机上选完菜单自动收起
    try { location.hash = '#/' + id; } catch (e) { }
    render();
  }

  App.render = render;
  App.go = go;
  /* 测试 seam：暴露排序比较器，冒烟测试据此断言严格反对称性（S-5） */
  App.navCompare = navCompare;

  /* ---------- 示例数据 ---------- */
  function genDemo() {
    var schools = ['城东中学'], classes = ['初三(1)班', '初三(2)班'];
    var exams = ['第一次月考', '期中考试', '期末考试'];
    var names = ['陈思远', '林嘉悦', '王一鸣', '赵梓涵', '刘泽楷', '孙雨桐', '周晨曦', '吴博文', '郑雅静', '黄俊杰'];
    var base = [88, 92, 76, 84, 69, 90, 81, 73, 86, 78];
    var i, j, k, r, bump;
    var n = 0;
    for (i = 0; i < names.length; i++) {
      for (j = 0; j < exams.length; j++) {
        var rec = Score.newRecord();
        rec.name = names[i];
        rec.school = schools[0];
        rec.cls = classes[i % 2];
        rec.exam = exams[j];
        bump = j * 2 + (i % 3) - 2;
        for (k = 0; k < 9; k++) {
          // 百分制底数先算出水平，再按该科满分换算（语数英 150，其余 100），
          // 最后按科满分截断，避免出现 120 分制外的数值
          var pct = base[i] + bump + (Math.random() * 16 - 8) + (k % 3) * 2;
          var v = Math.round(pct / 100 * App.K.SUBJECT_FULL[k]);
          v = Math.max(0, Math.min(App.K.SUBJECT_FULL[k], v));
          rec.scores[k] = v;
        }
        rec.ts = new Date(Date.now() - (exams.length - j) * 86400000 * 12 - i * 60000).toISOString();
        if (Store.data.records.some(function (x) { return Score.key(x) === Score.key(rec); })) continue;
        Store.data.records.push(rec);
        n++;
      }
    }
    // 计算单科排名与总分排名，让示例数据更真实
    recomputeRanks();
    Store.save();
    return n;
  }

  /** 依据现有成绩批量回填单科排名与总分排名（便于批量导入后使用） */
  function recomputeRanks() {
    var all = Store.data.records;
    function siblings(rec) {
      return App.Score.filter(all, { school: rec.school, cls: rec.cls, exam: rec.exam });
    }
    all.forEach(function (rec) {
      var rows = siblings(rec);
      for (var k = 0; k < App.K.NUM_SUBJECTS; k++) {
        if (!(Number(rec.scores[k]) > 0)) { rec.ranks[k] = 0; continue; }
        var higher = rows.filter(function (o) { return (Number(o.scores[k]) || 0) > (Number(rec.scores[k]) || 0); });
        rec.ranks[k] = higher.length + 1;
      }
      /* 总分排名按得分率比较（选科门数不同，绝对分不可直接比较），率相同再比绝对分；
         得分率封顶 100%，且率同时的绝对分比较也按动态满分截断，
         避免历史脏数据（单科超满分 780/750）把合法满分生挤到后面 */
      var myRate = Score.totalRate(rec), myTotal = Score.total(rec);
      var myFull = Score.fullTotal(rec);
      var myCmp = (myFull > 0 && myTotal > myFull) ? myFull : myTotal;
      var hiT = rows.filter(function (o) {
        var f = Score.fullTotal(o), t = Score.total(o);
        if (!(f > 0) || !(t > 0)) return false;
        var r = Math.min(1, t / f);
        var tc = t > f ? f : t;
        return r > myRate + 1e-9 || (Math.abs(r - myRate) <= 1e-9 && tc > myCmp);
      });
      rec.totalRank = hiT.length + 1;
    });
  }

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    Store.init();
    // 内存数据初始化后再启动云端同步（登录、拉取其他老师录入的数据）
    if (App.Sync) App.Sync.boot();
    // 新 7 张表的拉取循环（登录后自动生效；失败不抛错，等下一轮）
    if (App.DB && App.DB.start) {
      try { App.DB.start(); } catch (e) { }
    }

    render();

    var initial = (location.hash || '').replace('#/', '');
    if (initial && App.modules.some(function (m) { return m.id === initial; })) {
      /* 首次带 hash 打开 = 地址栏直接访问：越权时由模块 render() 输出 403（L3），不回退 */
      directAccess = true;
      currentId = initial;
      render();
      directAccess = false;
    }

    window.addEventListener('hashchange', function () {
      var id = (location.hash || '').replace('#/', '');
      if (id && id !== currentId && App.modules.some(function (m) { return m.id === id; })) {
        directAccess = true;        // 地址栏手输 / 粘贴 = 直达访问 → L3 403
        currentId = id;
        render();
        directAccess = false;
      }
    });

    /* 移动端抽屉菜单 */
    var sidebar = document.querySelector('.sidebar');
    var navMask = document.getElementById('nav-mask');
    App.closeNav = function () {
      if (sidebar) sidebar.classList.remove('open');
      if (navMask) navMask.classList.remove('show');
    };
    var mBtn = document.getElementById('btn-menu');
    if (mBtn) mBtn.addEventListener('click', function () {
      sidebar.classList.toggle('open');
      navMask.classList.toggle('show');
    });
    if (navMask) navMask.addEventListener('click', function () { App.closeNav(); });

    /* 顶栏按钮
       L4 守卫：这 4 个按钮只作用于成绩数据。T6 起管理员与教师同权，只由账号状态决定
       （只读 / 停用 / 未登录 → 拒）。DOM 隐藏挡不住控制台 click()，守卫必须写在 handler 第一行。 */
    document.getElementById('btn-backup').addEventListener('click', function () {
      if (!App.Perm.assertScoreAction()) return;
      App.X.backupJSON();
      Toast('备份文件已下载，请妥善保存到云盘或 U 盘', 'ok', 4000);
      render();
    });
    document.getElementById('btn-restore').addEventListener('click', function () {
      if (!App.Perm.assertScoreAction()) return;
      document.getElementById('file-restore').click();
    });
    document.getElementById('file-restore').addEventListener('change', function (e) {
      if (!App.Perm.assertScoreAction()) { e.target.value = ''; return; }
      var f = e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var obj = JSON.parse(fr.result);
          if (!obj || !Array.isArray(obj.records)) {
            throw new Error('文件格式不正确：未找到成绩记录数组');
          }
          Modal.confirm(
            '即将把备份文件里的 <b>' + obj.records.length + '</b> 条成绩记录<b>导入云端</b>。<br>' +
            '「姓名+学校+班级+考试」相同的记录会被备份内容覆盖，其余记录保持原样。<br>' +
            '<span class="muted">当前云端共 <b>' + Store.data.records.length + '</b> 条记录。</span><br>' +
            '其他老师也能看到导入后的结果。',
            function () {
              try {
                var n = App.X.restoreJSON(fr.result);
                Toast('已导入 ' + n + ' 条记录，正在写入云端…', 'ok', 4000);
                render();
              } catch (err2) { Toast('导入失败：' + err2.message, 'error', 6000); }
            }, true);
        } catch (err) {
          Toast('文件解析失败，请确认选择的是本系统导出的 JSON 备份。', 'error', 5000);
        }
        e.target.value = '';
      };
      fr.readAsText(f, 'utf-8');
    });
    document.getElementById('btn-clear').addEventListener('click', function () {
      /* T8：清空全部成绩是全局不可撤销操作，升为管理员专属（canEdit + isAdmin 双门）。
         DOM 隐藏挡不住控制台 click()，守卫必须在 handler 首行。 */
      if (!App.Perm.assertAdminWrite('score')) return;
      var shared = App.Sync && App.Sync.state.signedIn;

      /* 确认词弹窗：复用 App.UI.formModal（同一个「弹窗表单 → 校验 → 保存」包装，
         底层就是 App.Modal，不新造组件）。onSubmit 返回 false 时弹窗保持打开。 */
      var body = document.createElement('div');
      body.innerHTML =
        '<div style="font-size:13.5px;line-height:1.8">' +
        '确定要清除<b>全部 ' + Store.data.records.length + ' 条成绩记录</b>吗？<br>' +
        '<span style="color:#c0392b">数据只保存在云端，清空会逐条删除云端记录，' +
        '<b>所有老师都将看不到这些记录</b>。此操作不可撤销。</span><br>' +
        '建议先点「备份导出」另存一份。</div>' +
        '<label class="f" style="display:block;margin-top:12px">确认词 *' +
        '<input name="confirm-word" maxlength="10" autocomplete="off"' +
        ' placeholder="请输入「清空」两个字">' +
        '<span class="muted" style="font-size:12px">为防止误触，请输入『清空』两个字以确认</span></label>' +
        '<div data-form-err></div>';

      var executed = false;      // 成功执行后 Modal.close() 仍会触发 onClose，用它区分
      App.UI.formModal({
        title: '清空全部成绩记录',
        body: body,
        okText: '确认清空',
        onSubmit: function (close) {
          var input = body.querySelector('[name=confirm-word]');
          var word = input ? String(input.value || '').trim() : '';
          /* 严格相等才执行；输错/留空 → 红字提示 + 弹窗保持打开，绝不删除。
             选择「点击后拒绝」而非「按钮禁用」：禁用按钮本身不给任何反馈，
             用户不知道缺什么；拒绝路径沿用全站表单统一的「onSubmit 返回 false
             保持打开 + 红字 err 提示」口径，行为可预期。 */
          if (word !== '清空') {
            var box = body.querySelector('[data-form-err]');
            if (box) box.innerHTML =
              '<div class="err">确认词不正确：请输入『清空』两个字（当前输入：' +
              (word ? U.esc(word) : '空') + '）</div>';
            if (input && input.focus) input.focus();
            return false;
          }
          // —— 以下为原有清空逻辑（保持不变）——
          // 先登记待删除：内存清空后就无从得知要在云端删哪些
          executed = true;
          if (App.Sync) App.Sync.markAllDeleted();
          Store.data.records = [];
          Store.data.modules = {};
          Store.save();                 // 触发写穿 → 云端逐条删除
          App.ScoreModule.state.reportOpen = false;
          Toast(shared ? '已清空，正在从云端同步删除…' : '已清空全部数据', 'ok');
          render();
          close();
          return true;
        },
        onClose: function () {
          if (!executed) Toast('已取消（未输入确认词）', 'ok', 3200);
        }
      });
    });
    document.getElementById('btn-demo').addEventListener('click', function () {
      if (!App.Perm.assertScoreAction()) return;
      var shared = App.Sync && App.Sync.state.signedIn;
      Modal.confirm(
        '将生成 10 名学生 × 3 场考试的示例数据（共 30 条），用于快速试用。<br>不会覆盖已有记录，重复项将自动跳过。' +
        (shared
          ? '<br><span style="color:#c0392b">当前处于多人共享状态，示例数据<b>也会被其他老师看到</b>，' +
            '建议用完后点击「清空数据」。</span>'
          : ''),
        function () {
          var n = genDemo();
          Toast('已生成 ' + n + ' 条示例数据（含自动计算的单科排名与总分排名）', 'ok', 4000);
          render();
        });
    });

  });
})(window.App);
