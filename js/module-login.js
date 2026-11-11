/* =========================================================
 * module-login.js —— 独立登录页
 * · 未登录、登录过期或鉴权失效时，由 app.js 统一重定向到这里
 * · 表单本身复用 sync.js 的 buildAuthForm，登录成功后自动回到系统
 * · 纯云端模式：数据只保存在云端，未登录一律停在登录页，没有「离线使用」出口
 * ========================================================= */
(function (App) {
  'use strict';

  var U = App.U;

  var BRAND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4v10l-8 4-8-4V7z"/>' +
    '<path d="M12 8.5l4 2v5l-4 2-4-2v-5z"/><path d="M12 12v9"/></svg>';

  var FEATS = [
    ['9 科成绩录入，自动算总分与排名', '与 Excel 原表口径完全一致'],
    ['班级统计、多场考试对比、中文评语报告', '点一下就出图，不用再做透视表'],
    ['多位老师实时共享同一份数据', '数据实时保存在云端，换设备登录即可继续']
  ];

  App.LoginPage = {
    render: function () {
      var h = '<div class="auth-page"><div class="auth-wrap">';

      h += '<div class="auth-brand">' +
        '<div class="ab-logo">' + BRAND_SVG + '</div>' +
        '<div class="ab-title">学生成绩管理系统</div>' +
        '<div class="ab-sub">STUDENT SCORE MANAGEMENT · 多人协作版</div>' +
        '<ul class="ab-feats">';
      FEATS.forEach(function (f) {
        h += '<li><b>' + U.esc(f[0]) + '</b><span>' + U.esc(f[1]) + '</span></li>';
      });
      h += '</ul>' +
        '<div class="ab-foot">数据实时保存在云端，多位老师共享同一份；' +
        '换电脑、换设备登录即可继续使用，容量以云端免费额度为准。</div>' +
        '</div>';

      h += '<div class="auth-card">' +
        '<div class="ac-head">' +
        '<div class="ac-title">登录 / 注册</div>' +
        '<div class="ac-sub">请使用手机号登录，登录后才能查看与录入共享数据</div>' +
        '</div>' +
        '<div id="auth-host"></div>' +
        (App.Sync && !App.Sync.state.enabled
          ? '<div class="ac-note">云端组件尚未加载完成（可能是网络不通）。<br>' +
            '数据全部保存在云端，请检查网络后刷新页面再登录。</div>'
          : '') +
        '</div>';

      h += '</div></div>';
      return h;
    },

    bind: function (host) {
      var mount = host.querySelector('#auth-host');
      var Sync = App.Sync;
      if (mount && Sync && Sync.buildAuthForm) {
        mount.innerHTML = '';
        mount.appendChild(Sync.buildAuthForm('pwd', {}));
      } else if (mount) {
        mount.innerHTML = '<div class="af-tip">云端组件未加载，当前无法登录。请检查网络后刷新页面。</div>';
      }
    }
  };
})(window.App);
