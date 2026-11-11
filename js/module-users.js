/* =========================================================
 * module-users.js —— 权限管理（左侧菜单中的独立子模块）
 * · 在侧边栏独立显示，仅管理员可见（不再放进头像下拉菜单）
 * · 权限层级只到「账户级」，不做角色/菜单/操作级细分
 * · 管理员可查看全部账户，并对其他账户做两类处理：
 *     ① 限制编辑（保留账户）：只读 / 停用，随时可恢复
 *     ② 删除账户：不可恢复，该账号无法再登录
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U, Modal = App.Modal, Toast = App.Toast;

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/>' +
    '<path d="M3.5 19c0-3.2 2.5-5.2 5.5-5.2s5.5 2 5.5 5.2"/><path d="M16 7.5a3 3 0 010 6"/>' +
    '<path d="M17.6 13.9c1.7.6 2.9 2.2 2.9 4.3"/></svg>';

  var STATUS = {
    active: { label: '正常', chip: 'ch-green', desc: '可查看、可录入、可修改、可删除' },
    readonly: { label: '只读', chip: 'ch-amber', desc: '可查看全部成绩，但不能录入、修改、删除' },
    blocked: { label: '已停用', chip: 'ch-red', desc: '保留账户，但不能查看与录入任何数据' },
    deleted: { label: '已删除', chip: 'ch-red', desc: '账户已删除，无法登录；其已录入的成绩数据保留' }
  };

  function stInfo(s) { return STATUS[s] || STATUS.active; }
  function maskPhone(p) {
    p = String(p || '');
    return p.length === 11 ? p.slice(0, 3) + '****' + p.slice(-4) : (p || '-');
  }

  App.registerModule({
    id: 'users', name: '权限管理', icon: ICON, ready: true, hidden: false,
    adminOnly: true,               // 只有管理员在左侧菜单中看到入口
    title: '权限管理', subtitle: '账户级权限：只读 / 停用 / 删除账户',

    render: function () {
      var Sync = App.Sync;
      /* L3 直达拦截：统一 403 卡片（文案按 PRD §2.2），与其它管理员模块一致 */
      if (App.Perm && App.Perm.denied(this)) return App.Perm.forbiddenCard(this);
      if (!Sync || !Sync.isAdmin || !Sync.isAdmin()) {
        return '<div class="card"><h3>权限管理</h3>' +
          '<div class="empty">权限管理仅对<b>管理员</b>开放。<br>' +
          '如果你应当是管理员但看不到账户列表，请刷新页面重新加载账号档案，' +
          '或联系系统管理员确认你的账号身份。</div></div>';
      }

      var h = '<div class="card"><h3>权限说明<span class="h-note">权限只到账户级，不细分角色、菜单或操作</span></h3>' +
        '<div class="grid g2" style="margin-top:6px">' +
        '<div class="box-info">' +
        '<div class="bi-t">① 限制编辑（保留账户）</div>' +
        '<div class="bi-d">账户仍然存在，可随时恢复。两种限制方式：</div>' +
        '<ul class="bi-ul">' +
        '<li><b>只读</b>：能查看全部成绩数据，但不能录入、修改、删除</li>' +
        '<li><b>停用</b>：保留账户，但完全不能查看与录入数据（登录即提示停用）</li>' +
        '</ul></div>' +
        '<div class="box-warn">' +
        '<div class="bi-t">② 删除账户</div>' +
        '<div class="bi-d">账户被删除后<b>不可恢复</b>，该老师无法再次登录系统；' +
        '如需继续合作，只能重新注册新账号。<br>' +
        '注意：删除账户<b>不会删除</b>他已经录入的成绩数据，历史数据仍保留在系统里。</div>' +
        '</div></div></div>';

      h += '<div class="card"><h3>账户列表<span class="h-note" id="u-count">加载中…</span></h3>' +
        '<div id="user-list" class="muted">正在加载账户列表…</div></div>';
      return h;
    },

    bind: function (host) {
      var box = host.querySelector('#user-list');
      if (!box) return;
      var Sync = App.Sync;
      if (!Sync || !Sync.isAdmin || !Sync.isAdmin()) return;

      Sync.listUsers().then(function (rows) {
        var mine = Sync.myPhone();
        rows.sort(function (a, b) {
          return (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) ||
            String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });
        var cnt = host.querySelector('#u-count');
        if (cnt) cnt.textContent = '共 ' + rows.length + ' 个账户';

        var h = '<div class="tbl-wrap"><table><thead><tr>' +
          '<th>昵称</th><th>手机号</th><th>身份</th><th>当前状态</th><th>权限说明</th>' +
          '<th class="c">功能权限</th></tr></thead><tbody>';
        rows.forEach(function (u) {
          var isSelf = String(u.phone || '') === String(mine || '\u0000');
          var isAdmin = u.role === 'admin';
          var info = stInfo(u.status);
          var acts = '';
          if (isSelf || isAdmin) {
            acts = '<span class="muted">' + (isSelf ? '（当前账号）' : '管理员不可操作') + '</span>';
          } else if (u.status === 'deleted') {
            acts = '<span class="muted">账户已删除</span>';
          } else {
            if (u.status === 'active') {
              acts += '<button data-act="readonly" data-p="' + U.esc(u.phone) + '">设为只读</button> ';
              acts += '<button data-act="blocked" data-p="' + U.esc(u.phone) + '">停用</button> ';
            } else {
              acts += '<button class="primary" data-act="active" data-p="' + U.esc(u.phone) + '">恢复正常</button> ';
            }
            acts += '<button data-act="delete" data-p="' + U.esc(u.phone) + '" style="color:#c0392b">删除账户</button>';
          }
          h += '<tr>' +
            '<td><b>' + U.esc(u.name || '（未设置昵称）') + '</b>' +
            (isSelf ? ' <span class="chip ch-blue">我</span>' : '') + '</td>' +
            '<td class="muted">' + U.esc(maskPhone(u.phone)) + '</td>' +
            '<td>' + (isAdmin ? '<span class="chip ch-blue">管理员</span>' : '教师') + '</td>' +
            '<td><span class="chip ' + info.chip + '">' + info.label + '</span></td>' +
            '<td class="muted" style="font-size:12.5px">' + info.desc + '</td>' +
            '<td class="c" style="white-space:nowrap">' + acts + '</td></tr>';
        });
        h += '</tbody></table></div>';
        box.innerHTML = h;

        Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (btn) {
          btn.addEventListener('click', function () {
            var act = btn.getAttribute('data-act');
            var phone = btn.getAttribute('data-p');
            var row = rows.filter(function (r) { return String(r.phone) === String(phone); })[0] || {};
            var who = '<b>' + U.esc(row.name || maskPhone(phone)) + '</b>（' + U.esc(maskPhone(phone)) + '）';

            if (act === 'delete') {
              Modal.confirm(
                '确定要<b>删除账户</b> ' + who + ' 吗？<br><br>' +
                '<span style="color:#c0392b">· 删除后<b>不可恢复</b>，该老师将无法再次登录<br>' +
                '· 如需继续合作，只能让他重新注册新账号<br>' +
                '· 他已经录入的成绩数据<b>会保留</b>，不会被删除</span><br><br>' +
                '如果只是暂时不想让他改数据，建议改用「设为只读」或「停用」。',
                function () { doDelete(phone); }, true);
              return;
            }
            var map = {
              readonly: ['设为只读', '设为只读后，该老师仍可查看全部成绩，但无法录入、修改或删除任何数据。'],
              blocked: ['停用账户', '停用后该老师可以登录，但看不到任何数据、也无法录入。账户保留，可随时恢复。'],
              active: ['恢复正常', '恢复后该老师重新拥有查看与录入、修改、删除的完整权限。']
            };
            var m = map[act];
            Modal.confirm('确定要将 ' + who + ' ' + m[0] + '吗？<br>' + m[1],
              function () { doStatus(phone, act, m[0]); }, true);
          });
        });
      }).catch(function (err) {
        box.innerHTML = '<div class="err">账户列表加载失败：' + U.esc(err && err.message ? err.message : err) + '</div>';
      });

      function done(msg) {
        Toast(msg, 'ok');
        App.render();
      }
      function doStatus(phone, st, label) {
        /* L4：账号状态变更同样是写入，必须校验「管理员 + 账号可写」；
           管理员账号不可被降级/删除（唯一管理员保护），已在列表层隐藏操作入口，此处再兜一次 */
        if (App.Perm && !App.Perm.assertAdminWrite('users')) return;
        var target = rows.filter(function (r) { return String(r.phone) === String(phone); })[0] || {};
        if (target.role === 'admin') { Toast('管理员账号不可被降级或停用', 'error', 4000); return; }
        App.Sync.setUserStatus(phone, st).then(function () {
          done('已' + label + '，对方下次刷新或 45 秒内自动生效');
        }).catch(function (e) {
          Toast('操作失败：' + (e && e.message ? e.message : e), 'error', 6000);
        });
      }
      function doDelete(phone) {
        if (App.Perm && !App.Perm.assertAdminWrite('users')) return;
        var target = rows.filter(function (r) { return String(r.phone) === String(phone); })[0] || {};
        if (target.role === 'admin') { Toast('管理员账号不可被删除（唯一管理员保护）', 'error', 4000); return; }
        App.Sync.deleteUser(phone).then(function () {
          done('账户已删除，该账号无法再登录（其已录入数据保留）');
        }).catch(function (e) {
          Toast('删除失败：' + (e && e.message ? e.message : e), 'error', 6000);
        });
      }
    }
  });
})(window.App);
