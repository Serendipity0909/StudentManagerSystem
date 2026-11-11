/* =========================================================
 * perm.js —— App.Perm：权限四层（L1 导航 / L2 路由 / L3 直达 / L4 写入）的统一出口
 *
 * 口径（T6 权限反转后）：
 *   · 角色唯一判定 App.Sync.isAdmin()（profile.role === 'admin'）
 *   · 管理员：概览 / 成绩管理 / 学生 / 班级 / 客户 / 日常工作 / 合同 / 账号 —— 全部可用
 *   · 教师  ：概览与教务板块一律不可见、不可达；「成绩管理」与管理员同权
 *   · 账户状态叠加规则沿用 App.Sync.canEdit()（readonly / blocked / deleted 一律不可写）
 *
 * 本文件加载期只依赖 core.js 暴露的 window.App；App.Sync 全部在运行时惰性取，
 * 因此脚本顺序上排在 sync.js 之前也安全（见 ARCH §3.2）。
 * ========================================================= */
(function (App) {
  'use strict';

  /* 教师专属模块兜底名单：**T6 口径反转后为空**。
     用户明确要求「管理员完全可用于成绩管理」，因此 score 不再是教师专属。
     机制保留的理由：① 将来若再出现只允许教师的模块，注册时写 teacherOnly:true 即可，
     这里的兜底仍能防止注册对象丢了标记（score 历史上就在 init 归一化前丢过一次）；
     ② assertWrite 里「未注册 id 兜底为管理员专属」的兄弟分支要与它对称，删掉会让逻辑变脆。 */
  var TEACHER_MODULES = {};

  function sync() { return App.Sync || null; }

  /** 当前是否管理员（唯一角色判定出口，转发 App.Sync.isAdmin） */
  function isAdmin() {
    var S = sync();
    return !!(S && S.isAdmin && S.isAdmin());
  }

  /** 当前账号是否可写（账号状态：active 才可写；readonly/blocked/deleted 一律拒） */
  function canEdit() {
    var S = sync();
    if (!S || !S.canEdit) return true;      // 未接入云端时不受限（与 module-score.js 口径一致）
    return S.canEdit() !== false;
  }

  /** 账号状态文案（仅用于提示，不参与判定） */
  function statusLabel() {
    var S = sync();
    var st = (S && S.profile && S.profile() && S.profile().status) || 'active';
    if (st === 'readonly') return '只读';
    if (st === 'blocked') return '已停用';
    if (st === 'deleted') return '已删除';
    return '正常';
  }

  /** 把模块 id / 模块对象统一成模块对象 */
  function modOf(mod) {
    if (!mod) return null;
    if (typeof mod !== 'string') return mod;
    var hit = null;
    var list = App.modules || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === mod) { hit = list[i]; break; }
    }
    return hit || { id: mod };
  }

  /** 是否教师专属模块（T6 后无模块命中；机制保留，见 TEACHER_MODULES 注释） */
  function isTeacherOnly(mod) {
    var m = modOf(mod);
    if (!m) return false;
    if (m.teacherOnly) return true;
    return !!TEACHER_MODULES[m.id];
  }

  /**
   * L1 / L2 / L3 共用判定：当前角色能否访问该模块。
   * adminOnly && !admin → 否；teacherOnly && admin → 否；其余放行。
   * T6 后 score 既非 adminOnly 也非 teacherOnly，因此管理员与教师都放行。
   */
  function allowed(mod) {
    var m = modOf(mod);
    if (!m) return true;
    var admin = isAdmin();
    if (m.adminOnly && !admin) return false;
    if (isTeacherOnly(m) && admin) return false;
    return true;
  }

  function denied(mod) { return !allowed(mod); }

  /**
   * 该模块归属的角色中文名（用于 403 卡片与提示文案）。
   * T6 后不存在教师专属模块，恒返回「管理员」；`教师` 分支仅为保留 teacherOnly 机制而存在，
   * 因此「该模块仅对教师开放」这类文案实际已不可达（管理员进成绩管理不再走 403）。
   */
  function ownerRoleText(mod) {
    return isTeacherOnly(mod) ? '教师' : '管理员';
  }

  /**
   * L3 403 卡片（视觉复用 .card + .empty）：
   * 文案「该模块仅对<角色>开放。如需使用请联系系统管理员。」
   * T6 后能触发 403 的只剩「管理员专属模块 × 教师/只读账号」，
   * 因此实际渲染出的角色词恒为「管理员」；成绩管理不再有 403 路径。
   */
  function forbiddenCard(mod) {
    var m = modOf(mod) || {};
    var title = m.title || m.name || '该模块';
    return '<div class="card"><h3>' + App.U.esc(title) +
      '<span class="h-note">无访问权限</span></h3>' +
      '<div class="empty">该模块仅对' + ownerRoleText(m) + '开放。如需使用请联系系统管理员。</div>' +
      '</div>';
  }

  /** 拒绝原因（供调试与更详细的 toast 使用；判定本身不看它） */
  function denyDetail(mod) {
    var m = modOf(mod) || {};
    if (!canEdit()) return '账号状态为「' + statusLabel() + '」，不能写入数据';
    if (!allowed(m)) return '该模块仅对' + ownerRoleText(m) + '开放';
    return '';
  }

  function toastDenied() {
    if (App.Toast) App.Toast('无操作权限', 'error', 3200);
  }

  /**
   * L4 写入校验（唯一出口）：
   *   ① App.Sync.canEdit()（readonly / blocked / deleted / 未登录 → 拒）
   *   ② 角色匹配：score 由 T6 起对「管理员 + 教师」同等放行，角色不参与判定；
   *      其余业务模块仍要求「管理员」。
   * 不通过 → toast「无操作权限」并返回 false，调用方必须立即中止写入。
   * @param {string|Object} moduleId 模块 id 或模块对象
   * @returns {boolean}
   */
  function assertWrite(moduleId) {
    var id = (typeof moduleId === 'string') ? moduleId : ((moduleId && moduleId.id) || '');
    var m = modOf(moduleId) || { id: id };
    /* 未注册的模块 id（业务模块尚未加载时，App.DB 仍可能被调用）按
       「业务表 = 管理员专属」兜底，绝不能让教师凭一个未知 id 绕过角色校验。 */
    var registered = (App.modules || []).some(function (x) { return x.id === id; });
    if (!registered && !isTeacherOnly(m)) m = { id: id, adminOnly: true };
    if (!canEdit()) { toastDenied(); return false; }
    /* 成绩管理：T6 起管理员与教师同权，只剩账号状态这一道门（上面已判过） */
    if (id === 'score' && !isTeacherOnly(m)) return true;
    if (!allowed(m)) { toastDenied(); return false; }
    return true;
  }

  /**
   * 顶栏 4 个成绩相关按钮（示例数据 / 备份导出 / 恢复导入 / 清空数据）的守卫。
   * T6 起这些按钮对「可编辑」账号一律放行（管理员也能用），只由账号状态决定；
   * 只读 / 停用 / 未登录 → toast「无操作权限」。
   * DOM 隐藏挡不住控制台 click()，所以 handler 首行仍必须调用本函数。
   */
  function assertScoreAction() {
    if (!canEdit()) { toastDenied(); return false; }
    return true;
  }

  /** 学生 / 班级 / 客户 / 日常 / 合同等业务表：要求管理员且账号可写 */
  function assertAdminWrite(moduleId) {
    if (!canEdit()) { toastDenied(); return false; }
    if (!isAdmin()) { toastDenied(); return false; }
    return true;
  }

  App.Perm = {
    isAdmin: isAdmin,
    canEdit: canEdit,
    statusLabel: statusLabel,
    isTeacherOnly: isTeacherOnly,
    allowed: allowed,
    denied: denied,
    forbid: forbiddenCard,
    forbiddenCard: forbiddenCard,
    denyDetail: denyDetail,
    assertWrite: assertWrite,
    assertAdminWrite: assertAdminWrite,
    assertScoreAction: assertScoreAction,
    /** 教师专属模块名单（只读导出，供测试与调试） */
    TEACHER_MODULES: TEACHER_MODULES
  };
})(window.App);
