/* =========================================================
 * sync.js —— 云端同步层（纯云端模式）
 * 设计：数据只保存在云端数据库，页面内存仅作当前工作副本。
 *       · 写穿：任何增删改立即写入云端（失败必须让用户感知并自动重试）
 *       · 拉取：云端数据无条件覆盖内存，以「最后一次写入」为准（last-write-wins）
 *       · 业务模块（core / module-*）完全不需要知道云端的存在
 * 本机会话标记（sm_*）与 SDK 自己的 workbuddy-cloud.* 键保留，
 * 成绩数据不再写入本机 localStorage。
 * ========================================================= */
(function (global, App) {
  'use strict';
  if (!App) return;

  var U = App.U, Store = App.Store, Score = App.Score, Toast = App.Toast, Modal = App.Modal;

  /* publicConfig —— 来自云服务环境，仅这四个值可下发到前端 */
  var CFG = {
    endpoint: 'https://student-scores-36336.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_4awyu0XEG4n9gJgerWLkYW_whVREcYOumW64fbLY2Us9xwh4gkKC7bM'
  };
  var TABLE = 'score_records';
  var SEP = (App.Score && App.Score.SEP) || '\u0001';
  /* 历史版本把成绩数据缓存在本机的键，纯云端模式下不再使用，启动时清理 */
  var LEGACY_DB_KEY = 'student_mgmt_db_v1';

  var cloud = null, sdkReady = false, session = null;
  var snap = null;          // 上次同步后各记录的指纹 { 记录标识: fingerprint }
  var synced = null;        // 上次确认写入云端的内容 { 记录标识: 记录快照 }，唯一键冲突时回滚用
  var listeners = [];

  /* 本机标记：用于识别「已点过退出登录但会话仍然残留」，防止换账号时串号 */
  var LS_LOGGED_OUT = 'sm_logged_out';
  var LS_PHONE_CTX = 'sm_phone_ctx';
  /* 档案加载失败的固定提示语（身份都取不到时绝不建档，避免产生幽灵档案） */
  var PROFILE_ERR_MSG = '档案加载失败，请刷新重试';
  var profileReady = null;   // 上一次 ensureProfile() 的 Promise（并发去重用）
  var profileChain = null;   // 登录准备期「取权威身份 + 配档案」整条链路的 Promise

  var state = {
    enabled: false,         // 云端组件是否可用
    signedIn: false,
    authChecked: false,     // 会话探测是否已完成（完成前不跳登录页，避免闪屏）
    syncing: false,
    online: true,
    lastSyncAt: null,
    lastError: '',
    profileError: '',       // 档案/身份未能加载（此时一律禁止查看与录入）
    booted: false,
    blocked: false,         // 账号被管理员停用
    profile: null           // 当前用户在 user_profiles 中的档案
  };

  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) { } } }
  function noop() { }

  /* ---------------- 工具 ---------------- */
  /**
   * 记录指纹。必须包含 4 个键字段：
   * 只改学校/班级/考试时分数没动，指纹里没有键字段就会判定「无变化」而不推送。
   */
  function fp(r) {
    return JSON.stringify([r.name, r.school, r.cls, r.exam, r.scores, r.ranks, Number(r.totalRank) || 0]);
  }
  /**
   * 记录的同步标识：有云端主键就一律用主键。
   * 用业务键当标识时，改键后指纹会被记到新键下，旧键下的记录就再也推不出去了。
   */
  function snapKey(r) {
    return (r._cid || r._cid === 0) ? ('c' + SEP + r._cid) : ('l' + SEP + r.id);
  }
  /** 记录快照（冲突回滚用：只存业务字段与主键，不存内存 id） */
  function snapState(r) {
    return {
      name: r.name, school: r.school, cls: r.cls, exam: r.exam,
      scores: (r.scores || []).slice(), ranks: (r.ranks || []).slice(),
      totalRank: Number(r.totalRank) || 0,
      ts: r.ts, mod: r.mod, _cid: r._cid || null, _by: r._by || ''
    };
  }
  /** 把内存记录还原到快照（保留内存 id，界面上仍是同一行） */
  function restoreState(r, s) {
    r.name = s.name; r.school = s.school; r.cls = s.cls; r.exam = s.exam;
    r.scores = s.scores.slice(); r.ranks = s.ranks.slice();
    r.totalRank = s.totalRank; r.ts = s.ts; r.mod = s.mod;
    r._cid = s._cid; r._by = s._by;
  }
  function rowKey(row) {
    return [row.stu_name, row.school, row.class_name, row.exam].join(SEP);
  }
  /** 待删除队列条目 → 业务键 / 云端主键 */
  function delKeyOf(entry) { return String(entry).split(SEP).slice(0, 4).join(SEP); }
  function delCidOf(entry) {
    var p = String(entry).split(SEP);
    return (p.length > 4 && p[4]) ? p[4] : null;
  }
  /** 「张三 / 一中 / 初三(1)班 / 期中」 */
  function recText(r) {
    return [r.name, r.school, r.cls, r.exam].join(' / ');
  }
  function mask(s) {
    s = String(s || '');
    return s.length > 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
  }
  function me() {
    // 优先用老师自己设置的昵称（会作为「最后修改人」记录到云端）
    if (state.profile && state.profile.name) return state.profile.name;
    if (!session || !session.user) return '';
    var n = String(session.user.name || '');
    if (/^1\d{10}$/.test(n)) return mask(n);       // 昵称缺失时不要把完整手机号写进云端
    return n || (session.user.phone ? mask(session.user.phone) : '') || '老师';
  }

  function toRow(r) {
    var s = [], rk = [], i;
    for (i = 0; i < App.K.NUM_SUBJECTS; i++) { s.push(Number(r.scores[i]) || 0); rk.push(Number(r.ranks[i]) || 0); }
    return {
      rec_id: r.id || '',
      stu_name: r.name, school: r.school, class_name: r.cls, exam: r.exam,
      scores: s, ranks: rk,
      total: Score.total(r),
      total_rank: Number(r.totalRank) || 0,
      entered_at: r.ts || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_editor: me()
    };
  }

  function fromRow(row) {
    var s = [], rk = [], i;
    for (i = 0; i < App.K.NUM_SUBJECTS; i++) {
      s.push(Number((row.scores || [])[i]) || 0);
      rk.push(Number((row.ranks || [])[i]) || 0);
    }
    /* 云端下发也按单科满分截断：历史/外部直写进库的超满分数据不得污染内存 Store */
    s = App.Score.clampScores({ scores: s }).rec.scores;
    return {
      id: row.rec_id || U.uid(),
      // 云端主键：保存时必须按它 update，改了键字段也不会插出第二条
      _cid: (row.id === undefined || row.id === null) ? null : row.id,
      name: row.stu_name, school: row.school, cls: row.class_name, exam: row.exam,
      scores: s, ranks: rk,
      totalRank: Number(row.total_rank) || 0,
      ts: row.entered_at || row.created_at,
      mod: row.updated_at,
      _by: row.last_editor || row.owner_name || ''
    };
  }

  /* =========================================================
   * 直接调用云端鉴权接口
   * SDK 的 verifyOtp() 在老用户（isExistingUser=true）场景下只做「验证码换会话」，
   * 会把用户填写的新密码直接丢弃，导致「验证码重设密码后仍提示
   * user password not set」。因此老用户重设密码改为手动三步：
   *   /v1/verification/verify → /v1/reset → signInWithPassword
   * ========================================================= */
  var AUTH_BASE = CFG.endpoint + '/.cloud/auth';
  var PATH_VERIFY = '/v1/verification/verify';
  var PATH_RESET = '/v1/reset';

  /** 从响应体里挑出最像「人话」的错误描述（云端返回的是 gRPC 风格的错误） */
  function errorTextOf(j) {
    if (!j || typeof j !== 'object') return '';
    if (j.error_description) return String(j.error_description);
    var e = j.error;
    if (e && typeof e === 'object') return String(e.message || e.msg || '');
    if (typeof e === 'string' && e && e !== 'true') return '';   // e 只是枚举名（如 invalid_argument），不当描述用
    return String(j.message || '');
  }

  /** 带 access-key 的裸 POST（与 SDK 内部一致） */
  function apiPost(path, body) {
    return fetch(AUTH_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wb-webapp-access-key': CFG.publishableKey
      },
      body: JSON.stringify(body || {})
    }).then(function (resp) {
      return resp.text().then(function (txt) {
        var j = null;
        try { j = txt ? JSON.parse(txt) : {}; } catch (e) { j = {}; }
        if (!resp.ok || (j && j.error)) {
          // 优先透出服务端给的 error_description，否则只报 HTTP 状态码
          var desc = errorTextOf(j);
          var rid = (j && (j.requestId || j.request_id)) || '';
          var err = new Error(desc
            ? ('云端请求失败：' + desc)
            : ('云端请求失败（HTTP ' + resp.status + '）'));
          err.requestId = rid;
          try {
            console.warn('[sync] 云端请求失败', {
              path: path, status: resp.status, requestId: rid, description: desc || ''
            });
          } catch (e2) { }
          throw err;
        }
        return j || {};
      });
    });
  }

  /**
   * 手机号归一化（与 SDK 内部 normalizePhone 完全一致）。
   * 云端鉴权接口只接受 E.164 格式：「+86 18772667782」（国家码后带一个空格），
   * 直接传 11 位裸号码会被服务端的 proto 校验拒掉（400 invalid_argument）。
   */
  function normalizePhone(p) {
    var t = String(p || '').replace(/\D/g, '');
    if (t.indexOf('0086') === 0) t = t.slice(4);
    else if (t.indexOf('86') === 0 && t.length === 13) t = t.slice(2);
    return /^1\d{10}$/.test(t) ? ('+86 ' + t) : String(p || '');
  }

  /** 从响应里取字段：先找 { data: {...} }，再找顶层（不同接口包裹方式不一致） */
  function pickField(j, keys) {
    var src = [j && j.data, j], s, i, v;
    for (s = 0; s < src.length; s++) {
      if (!src[s] || typeof src[s] !== 'object') continue;
      for (i = 0; i < keys.length; i++) {
        v = src[s][keys[i]];
        if (v !== undefined && v !== null && v !== '') return v;
      }
    }
    return '';
  }

  /**
   * 老用户用验证码重设密码：
   * ① 验证码 → verification_token
   * ② token + 新密码 → 真正写入密码（与 SDK resetPasswordForEmail 对 email 的用法同构）
   *
   * 注意 /v1/reset 的字段名是 phone_number（不是 phone），且必须是 E.164
   * 格式「+86 18772667782」。用 phone 或 11 位裸号码时，服务端收不到号码，
   * 会在 proto 校验阶段直接 400：error_description = "email or phone number is empty"。
   * 这也是「/v1/verification/verify 返回 200、紧接着 /v1/reset 报 HTTP 400」的原因。
   */
  function resetPasswordByOtp(phone, verificationId, code, newPwd) {
    return apiPost(PATH_VERIFY, {
      verification_id: verificationId,
      verification_code: code
    }).then(function (j) {
      var token = pickField(j, ['verification_token', 'verificationToken', 'token']);
      if (!token) throw new Error('验证码校验失败，请重新获取验证码后重试');
      return apiPost(PATH_RESET, {
        phone_number: normalizePhone(phone),
        new_password: newPwd,
        verification_token: token
      });
    });
  }

  /* ---------------- 初始化 ---------------- */
  function boot() {
    if (state.booted) return;
    state.booted = true;
    // 纯云端模式：清掉历史版本缓存的本机成绩数据，避免与云端不一致
    try { global.localStorage.removeItem(LEGACY_DB_KEY); } catch (e) { }
    // 前置条件：内存数据已初始化（由 app.js 在 Store.init() 之后调用本方法）
    if (!Store.data) return;
    state.online = !global.navigator || navigator.onLine !== false;
    App.Sync.on(renderState);
    if (!global.WorkBuddyCloud || !global.WorkBuddyCloud.createWorkBuddyCloud) {
      sdkReady = false;
      state.enabled = false;
      state.authChecked = true;
      state.lastError = '云端组件未能加载（可能未联网），请检查网络后刷新页面。';
      buildUserArea(); emit();
      if (App.render) App.render();
      return;
    }
    try {
      cloud = global.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
        publishableKey: CFG.publishableKey
      });
      sdkReady = true;
      state.enabled = true;
      buildUserArea();
    } catch (e) {
      sdkReady = false;
      state.enabled = false;
      state.authChecked = true;
      state.lastError = '云端初始化失败：' + e.message;
      buildUserArea(); emit();
      if (App.render) App.render();
      return;
    }

    Store.hooks.afterSave.push(function () {
      schedule();
    });

    // 会话探测完成后统一由 checkSession 决定是否跳转登录页
    checkSession();

    setInterval(function () {
      if (!state.signedIn) return;
      // 定期复核账号状态 + 拉取其他老师的最新录入（不做任何提醒，直接呈现）
      recheckProfile()
        .then(function () { if (!state.blocked) requestPull(); })
        .catch(function (e) {
          // 档案中途丢失：立刻拦截，不让无身份的会话继续读写云端
          if (!state.blocked && e && e.message === PROFILE_ERR_MSG) {
            state.profileError = e.message;
            state.lastError = e.message;
            showProfileErrorGate(e.message);
            if (App.render) App.render();
          }
        });
    }, 45000);
    global.addEventListener('online', function () {
      state.online = true; emit();
      if (state.signedIn) { requestPush(); requestPull(); }
    });
    global.addEventListener('offline', function () { state.online = false; emit(); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.signedIn) requestPull();
    });
  }

  /**
   * 会话检查。三种情况判定为「需要重新登录」：
   *   ① 拿不到会话（从未登录 / 登录过期 / 鉴权失效）
   *   ② 本机标了「已退出登录」却仍取到会话 —— SDK 会话残留，必须清掉，
   *      否则退出后登录新账号时仍是原来那个账号与权限（串号）
   *   ③ 取到的会话手机号与本机记录的账号不一致
   *
   * 注意第 ③ 条：真实 SDK 返回的 session.user 里根本没有 phone 字段，
   * 手机号只存在于 raw 原始负载里，所以必须先取权威身份（GET /v1/user/me）
   * 再拿标准 phone 与 sm_phone_ctx 比对，否则换号码登录时判定永远不生效。
   */
  function checkSession() {
    return cloud.auth.getSession().then(function (res) {
      var s = res && res.data;
      if (!s) { finishSessionCheck(null); return null; }
      if (loggedOutFlag()) { dropStaleSession(); finishSessionCheck(null); return null; }

      session = s;                       // fetchCanonicalUser() 需要先把会话挂上去
      return fetchCanonicalUser().then(function () {
        var phone = phoneOfUser(session && session.user);
        var last = ctxPhone();
        if (phone && last && phone !== last) {
          // 换号：旧会话与本机记录的账号对不上，丢弃后回到登录页（不会与登出标记互相触发）
          dropStaleSession();
          finishSessionCheck(null);
          return null;
        }
        finishSessionCheck(s);
        return s;
      });
    }).catch(function () {
      session = null;                    // 探测失败：不要留下半成品会话
      finishSessionCheck(null);
    });
  }

  /** 会话探测收口：统一置位 authChecked，并决定进入系统还是登录页 */
  function finishSessionCheck(s) {
    state.authChecked = true;
    if (s) { onSignedIn(s); return; }
    state.signedIn = false;
    buildUserArea(); emit();
    if (App.render) App.render();
  }

  /** 换账号时清掉上一个账号遗留的同步指纹、待删除队列与档案 */
  function resetAccountContext() {
    snap = null;
    synced = null;
    Store.data.deletedKeys = [];
    state.profile = null;
    state.profileError = '';
    state.blocked = false;
    profileReady = null;
    profileChain = null;
  }

  function onSignedIn(s) {
    var prevPhone = myPhone();
    var prevId = (session && session.user) ? String(session.user.id || '') : '';
    session = s;
    state.signedIn = true;
    state.lastError = '';
    var newId = (s && s.user) ? String(s.user.id || '') : '';
    var newPhone = phoneOfUser(s && s.user);
    // 换号判定：手机号或 user_id 任一变化，都要丢掉上一个账号的上下文
    if ((prevId && newId && prevId !== newId) || (prevPhone && newPhone && prevPhone !== newPhone)) {
      resetAccountContext();
    }
    // 档案必须按新会话重新取，绝不能沿用上一个账号的权限
    state.profile = null;
    state.profileError = '';
    state.blocked = false;
    profileReady = null;
    profileChain = null;
    snap = null;
    synced = null;
    lsSet(LS_LOGGED_OUT, null);
    if (newPhone) lsSet(LS_PHONE_CTX, newPhone);
    var box = document.getElementById('login-gate');
    if (box) box.remove();
    buildUserArea();
    emit();
    if (App.render) App.render();

    // 登录返回的 user 只有 {id,name,...}，手机号藏在 raw 里。
    // 必须先用 GET /v1/user/me 取权威身份（带标准 phone），再做档案匹配，
    // 否则会匹配不上 user_profiles，甚至拿空手机号建出幽灵档案。
    var ready = fetchCanonicalUser()
      .then(function () {
        var phone = phoneOfUser(session && session.user);
        if (phone) lsSet(LS_PHONE_CTX, phone);
        buildUserArea();
        emit();
        if (App.render) App.render();
        return ensureProfile();
      });
    // 准备期：所有「回写档案」的请求（密码状态 / 昵称）都必须排队等这条链路，
    // 不能在它还没落地时就自己再起一次 ensureProfile()，否则会并发建出两份档案。
    profileChain = ready.then(
      function (p) { profileChain = null; return p; },
      function (e) { profileChain = null; throw e; }
    );

    profileChain
      .then(function () {
        if (state.blocked) { showBlockedGate(); return; }
        if (App.render) App.render();
        requestPull();          // 登录成功后先全量拉取，数据齐了才算就绪
      })
      .catch(function (e) {
        var msg = (e && e.message) ? e.message : String(e);
        state.lastError = msg;
        state.profileError = msg;
        if (state.blocked) { showBlockedGate(); return; }
        showProfileErrorGate(msg);
        if (App.render) App.render();
      });
  }

  /**
   * 拉取权威用户（GET /v1/user/me）。
   * 登录接口返回的 session.user 经 SDK 的 Dt() 解析后不含 phone，
   * 手机号只存在于 raw 原始负载里；而 getUser() 经 Fe() 解析带标准 phone 字段。
   * 这里把 phone / name 合并进 session.user，供后续档案匹配使用。
   */
  function fetchCanonicalUser() {
    if (!cloud || !session) return Promise.resolve(null);
    return cloud.auth.getUser().then(function (res) {
      var u = (res && res.data && (res.data.user || res.data)) || null;
      if (!u || typeof u !== 'object') return null;
      if (!session.user) session.user = {};
      var p = phoneOfUser(u);
      var n = String(u.name || u.nickname || u.nick_name || '');
      if (p) session.user.phone = p;
      // 服务端没给昵称时，name 常常就是手机号，那就不当作昵称
      if (n && !/^1\d{10}$/.test(n)) session.user.name = n;
      if (u.raw) session.user.raw = u.raw;
      return session.user;
    }).catch(function () { return null; });   // 取不到不阻塞：还有 user_id 可用
  }

  /* ---------------- 用户档案与权限 ---------------- */
  var PROFILES = 'user_profiles';

  /**
   * 当前登录手机号。不同来源把号码放在不同字段上（phone / phoneNumber /
   * username / name / raw.phone_number / raw.phone / raw.user_metadata.phone），
   * 这里统一探测，避免拿到空串导致账号档案匹配不上。
   */
  function phoneOfUser(u) {
    if (!u) return '';
    var raw = u.raw || {};
    var md = raw.user_metadata || {};
    var cands = [
      u.phone, u.phoneNumber, u.phone_number, u.username, u.name, u.email,
      raw.phone_number, raw.phone, md.phone
    ];
    for (var i = 0; i < cands.length; i++) {
      var v = String(cands[i] || '').replace(/^\+86\s*/, '').replace(/[\s-]/g, '');
      if (/^1\d{10}$/.test(v)) return v;
    }
    return '';
  }
  function myPhone() {
    var p = phoneOfUser(session && session.user);
    if (p) return p;
    return state.profile && state.profile.phone ? String(state.profile.phone) : '';
  }

  /** 建档用昵称：SDK 常把手机号直接当 name，这里打码处理 */
  function profileName(u, phone) {
    var n = String((u && u.name) || '').trim();
    if (/^1\d{10}$/.test(n)) return mask(n);
    return n || (phone ? mask(phone) : '老师');
  }

  /* ---------------- 本机会话标记（防止退出后仍串到上一个账号） ---------------- */
  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try { if (v === null || v === undefined) global.localStorage.removeItem(k); else global.localStorage.setItem(k, v); }
    catch (e) { }
  }
  function loggedOutFlag() { return lsGet(LS_LOGGED_OUT) === '1'; }
  function ctxPhone() { return lsGet(LS_PHONE_CTX) || ''; }

  /** 清理 SDK 可能残留在 localStorage 里的会话/令牌（sm_* 标记必须保留） */
  function clearSessionKeys() {
    try {
      Object.keys(global.localStorage).forEach(function (k) {
        if (k === LEGACY_DB_KEY || k.indexOf('sm_') === 0) return;
        if (!/auth|session|token|refresh|userid|account/i.test(k)) return;
        global.localStorage.removeItem(k);
      });
    } catch (e) { }
  }

  /** 会话无效或与上次登录的账号不一致：丢弃本地会话状态，回到登录页 */
  function dropStaleSession() {
    try { cloud.auth.signOut(); } catch (e) { }
    clearSessionKeys();
    session = null;
    state.signedIn = false;
    state.profile = null;
    state.profileError = '';
    state.blocked = false;
    snap = null;
    synced = null;
    profileReady = null;
    profileChain = null;
    lsSet(LS_LOGGED_OUT, null);     // 标记已消费，避免重复清理造成死循环
    lsSet(LS_PHONE_CTX, null);
  }

  /* ---------------- 登录门控 / 登出 ---------------- */
  /** 是否需要重定向到独立登录页（纯云端模式：未登录一律停在登录页） */
  function needLogin() {
    return state.authChecked && !state.signedIn;
  }

  function confirmSignOut() {
    Modal.confirm('确定要退出登录吗？<br>' +
      '退出后需要重新登录才能查看与录入数据。<br>' +
      '<span class="muted">成绩数据始终保存在云端，退出不会删除任何数据；' +
      '换设备、换账号登录即可继续。</span>',
      function () { signOutHere(); }, true);
  }

  /**
   * 退出登录：① 通知云端失效会话 ② 清理可能残留的本地令牌
   * ③ 清空上一个账号的同步上下文 ④ 打「已退出」标记。
   * 缺任何一步，下一个账号登录时就可能沿用上个账号的身份与权限（串号）。
   */
  function signOutHere() {
    lsSet(LS_LOGGED_OUT, '1');
    lsSet(LS_PHONE_CTX, null);
    session = null;
    state.signedIn = false;
    state.profile = null;
    state.profileError = '';
    state.blocked = false;
    state.lastSyncAt = null;
    state.lastError = '';
    profileReady = null;
    profileChain = null;
    snap = null;
    synced = null;
    Store.data.deletedKeys = [];
    Store.data.records = [];
    var done = function () { try { global.location.reload(); } catch (e) { } };
    try {
      cloud.auth.signOut()
        .then(function () { clearSessionKeys(); }, function () { clearSessionKeys(); })
        .then(done, done);
    } catch (e) { clearSessionKeys(); done(); }
    setTimeout(done, 1500);
  }

  function listProfiles() {
    return cloud.database.from(PROFILES).select('*').then(function (res) {
      if (res.error) throw res.error;
      return res.data || [];
    });
  }

  /**
   * 在档案列表里找自己：先按 user_id（权威），再按手机号。
   * 两者都拿不到时返回 null —— 绝不退回「按空手机号匹配」，否则会命中幽灵档案。
   */
  function findMine(rows, uid, phone) {
    var i;
    if (uid === undefined || uid === null) {
      uid = (session && session.user) ? String(session.user.id || '') : '';
    }
    if (phone === undefined || phone === null) phone = myPhone();
    uid = String(uid || '');
    phone = String(phone || '');
    if (uid) {
      for (i = 0; i < rows.length; i++) {
        if (String(rows[i].user_id || '') === uid) return rows[i];
      }
    }
    if (phone) {
      for (i = 0; i < rows.length; i++) {
        if (String(rows[i].phone || '') === phone) return rows[i];
      }
    }
    return null;
  }

  /** 账号状态：active 正常 / readonly 只读 / blocked 停用 / deleted 已删除 */
  function status() {
    return (state.profile && state.profile.status) || 'active';
  }
  function isGatedStatus(st) { return st === 'blocked' || st === 'deleted'; }
  /**
   * 账号权限判定（统一的唯一出口）：
   * · 未登录 → 一律不可查看 / 不可编辑（由 needLogin 跳登录页拦截）
   * · 档案未能加载 → 一律不可操作，避免身份不明的人写入数据
   * · 只读账号可查看不可编辑；停用 / 已删除账号全部拒绝
   */
  function canView() {
    if (!state.signedIn || state.profileError) return false;
    var s = status();
    return s === 'active' || s === 'readonly';
  }
  function canEdit() {
    if (!state.signedIn || state.profileError) return false;
    return status() === 'active';
  }
  function isGated() { return isGatedStatus(status()); }

  /** 按 id → user_id → phone 的优先级精确定位一行并打补丁 */
  function patchProfile(row, patch) {
    var p = Object.assign({ updated_at: new Date().toISOString() }, patch);
    var q = cloud.database.from(PROFILES).update(p);
    if (row && row.id) q = q.eq('id', row.id);
    else if (row && row.user_id) q = q.eq('user_id', row.user_id);
    else q = q.eq('phone', row ? row.phone : myPhone());
    return q.select().then(function (res) {
      if (res.error) throw res.error;
      var m = res.data && res.data[0];
      if (m) state.profile = Object.assign({}, state.profile || {}, m);
      else if (state.profile) state.profile = Object.assign({}, state.profile, patch);
      return state.profile;
    });
  }

  /** 修改自己的档案（昵称、密码状态等）；角色与状态字段由数据库触发器保护 */
  function updateProfile(patch) {
    if (state.profile) return patchProfile(state.profile, patch);
    var p = Object.assign({ updated_at: new Date().toISOString() }, patch);
    return cloud.database.from(PROFILES).update(p).eq('phone', myPhone()).select()
      .then(function (res) {
        if (res.error) throw res.error;
        var row = res.data && res.data[0];
        if (row) state.profile = Object.assign({}, state.profile || {}, row);
        return state.profile;
      });
  }

  /**
   * 登录后确保自己有档案；首次登录自动注册为普通教师角色。
   * 身份（user_id 与手机号）都拿不到时绝不建档 —— 直接抛错，
   * 由界面提示「档案加载失败，请刷新重试」，防止再产生空手机号的幽灵档案。
   */
  function ensureProfile() {
    // 并发去重：建档链路正在进行（或已完成）时直接复用同一个 Promise。
    // 登录瞬间 markPasswordSet / saveNick 也会想配档案，没有这层保护就会出现
    // 两次 select + 两次 insert，生成同一 user_id 的两行档案。
    if (profileReady) return profileReady;

    var u = (session && session.user) || {};
    var uid = String(u.id || '');
    var phone = String(myPhone() || '');
    if (!uid && !phone) {
      // 身份不明：不缓存失败结果，下次仍可重试
      return Promise.reject(new Error(PROFILE_ERR_MSG));
    }
    profileReady = listProfiles().then(function (rows) {
      var mine = findMine(rows, uid, phone);
      if (mine) {
        // 档案的 phone 为空（历史脏数据）时补写，保证「权限管理」里看得到号码
        if (phone && !String(mine.phone || '')) {
          return patchProfile(mine, { phone: phone }).catch(function () { return null; })
            .then(function (row2) {
              state.profile = row2 || Object.assign({}, mine, { phone: phone });
              state.blocked = isGatedStatus(state.profile.status);
              return state.profile;
            });
        }
        state.profile = mine;
        state.blocked = isGatedStatus(mine.status);
        return mine;
      }
      // 身份明确但仍无档案 → 首次登录，自动注册为普通教师。
      // 用 upsert + 唯一索引兜底（user_id / phone 均已在库上建唯一索引），
      // 即便极端情况下仍有并发写入，也只会更新同一行，不会再出现重复档案。
      var ins = {
        phone: phone || '',
        name: profileName(u, phone),
        role: 'teacher',
        status: 'active'
      };
      if (uid) ins.user_id = uid;      // 不传时由数据库 DEFAULT auth.uid() 填充
      var onConflict = uid ? 'user_id' : 'phone';
      return cloud.database.from(PROFILES).upsert(ins, { onConflict: onConflict })
        .select()
        .then(function (r2) {
          if (r2.error) throw r2.error;
          // 以本地 ins 为底、服务端返回行覆盖，避免将来 .select('部分列')
          // 时把 phone / name 等关键字段丢掉（幽灵档案同类风险）
          state.profile = Object.assign({}, ins, (r2.data && r2.data[0]) || {});
          state.blocked = false;
          return state.profile;
        });
    }).catch(function (e) {
      profileReady = null;              // 失败不留残桩，下次请求可以重新走一遍
      throw e;
    });
    return profileReady;
  }

  /**
   * 档案就绪后执行。
   * 登录准备期（profileChain 非空）必须等那一条链路落地，绝不能再起一次
   * ensureProfile() —— 否则「取权威身份」还在路上时就会按空手机号去建档。
   */
  function withProfile(fn) {
    var p;
    if (profileChain) p = profileChain;
    else if (state.profile) p = Promise.resolve(state.profile);
    else p = profileReady || ensureProfile();
    return p.then(fn).catch(noop);
  }

  /** 密码状态：设置 / 修改成功后回写档案，让「未设置密码」提示立即同步 */
  function markPasswordSet() {
    if (state.profile && state.profile.pwd_set) return Promise.resolve(state.profile);
    return withProfile(function () { return updateProfile({ pwd_set: true }); })
      .then(function () {
        if (state.profile) state.profile.pwd_set = true;
        buildUserArea();
        if (App.render) App.render();
        return state.profile;
      });
  }

  function hasPassword() {
    return !!(state.profile && state.profile.pwd_set);
  }

  /** 定期复核自己的账号状态，管理员停用/删除后立即生效 */
  function recheckProfile() {
    var u = (session && session.user) || {};
    var uid = String(u.id || '');
    if (!uid && !myPhone()) return Promise.reject(new Error(PROFILE_ERR_MSG));
    return listProfiles().then(function (rows) {
      var mine = findMine(rows, uid, myPhone());
      // 档案被彻底删掉（不是改状态）时同样视为身份不明，立即拦截
      if (!mine) throw new Error(PROFILE_ERR_MSG);
      var wasGated = isGated();
      state.profile = mine;
      state.blocked = isGated();
      if (state.profileError) {
        // 之前档案加载失败，现在恢复了 → 解除拦截
        state.profileError = '';
        state.lastError = '';
        var g = document.getElementById('login-gate');
        if (g) g.remove();
        if (App.render) App.render();
      }
      if (isGated() && !wasGated) showBlockedGate();
      return mine;
    });
  }

  /** 取（或建）全屏拦截层节点 */
  function ensureGate() {
    var gate = document.getElementById('login-gate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'login-gate';
      gate.className = 'login-gate';
      document.body.appendChild(gate);
    }
    return gate;
  }

  /** 被停用 / 已删除后的全屏提示页 */
  function showBlockedGate() {
    var st = status();
    var deleted = st === 'deleted';
    var gate = ensureGate();
    gate.innerHTML =
      '<div class="login-card"><div class="login-head">' +
      '<div class="lg-title">' + (deleted ? '账号已被删除' : '账号已停用') + '</div>' +
      '<div class="lg-sub">' + (deleted ? '此账号已由管理员删除，无法继续使用' : '请联系管理员开通后再使用') + '</div></div>' +
      '<p class="lg-tip">' +
      (deleted
        ? '你的账号已被管理员<b>删除</b>，登录权限已取消。<br>如需继续使用，请让管理员为你重新注册账号。'
        : '你的账号当前已被管理员<b>停用</b>，暂时无法查看与录入数据。<br>停用只是限制使用，管理员可随时恢复。') +
      '<br>成绩数据保存在云端，不会因此丢失。</p>' +
      '<button type="button" id="lg-out" class="primary block">退出登录</button></div>';
    gate.querySelector('#lg-out').addEventListener('click', function () {
      cloud.auth.signOut().then(function () { global.location.reload(); })
        .catch(function () { global.location.reload(); });
    });
    emit();
  }

  /** 身份/档案加载失败的全屏提示页（此时一律不建档、不开放数据） */
  function showProfileErrorGate(msg) {
    var gate = ensureGate();
    gate.innerHTML =
      '<div class="login-card"><div class="login-head">' +
      '<div class="lg-title">档案加载失败</div>' +
      '<div class="lg-sub">' + U.esc(PROFILE_ERR_MSG) + '</div></div>' +
      '<p class="lg-tip">未能读取到你的账号档案' +
      (msg && msg !== PROFILE_ERR_MSG ? '（' + U.esc(msg) + '）' : '') +
      '。<br>为避免生成重复档案，系统暂时不开放查看与录入。<br>' +
      '请先点「刷新重试」；若反复失败，请退出登录后重新登录。</p>' +
      '<button type="button" id="lg-reload" class="primary block">刷新重试</button>' +
      '<button type="button" id="lg-out" class="link-btn">退出登录</button></div>';
    gate.querySelector('#lg-reload').addEventListener('click', function () {
      try { global.location.reload(); } catch (e) { }
    });
    gate.querySelector('#lg-out').addEventListener('click', function () {
      try { cloud.auth.signOut().then(function () { global.location.reload(); })
        .catch(function () { global.location.reload(); }); } catch (e) { global.location.reload(); }
    });
    emit();
  }

  /* ---------------- 登录 / 注册 / 账号设置 ---------------- */
  var pendingOtp = null;

  function pwdMsg(p) { return U.checkPassword(p); }

  /* 统一排版：每一行都是「标签在上、输入框在下」，间距一致，密码框带明文切换 */
  function fieldHTML(label, inner, note) {
    return '<div class="af-field">' +
      '<label>' + label + (note ? '<span class="muted">' + note + '</span>' : '') + '</label>' +
      inner + '</div>';
  }
  function pwHTML(id, ph, ac) {
    return '<div class="af-pw"><input id="' + id + '" type="password" placeholder="' + ph +
      '" autocomplete="' + ac + '">' +
      '<button type="button" class="af-eye" data-eye="' + id + '">显示</button></div>';
  }

  function authFormHTML(o) {
    o = o || {};
    var ph = U.esc(o.phone || '');
    return '' +
      '<div class="seg" id="lg-tabs">' +
      '  <button type="button" class="seg-btn active" data-tab="pwd">密码登录</button>' +
      '  <button type="button" class="seg-btn" data-tab="otp">' +
      (o.requirePwd ? '验证码重设' : '验证码登录 / 注册') + '</button>' +
      '</div>' +
      '<div class="af-pane" id="lg-pwd">' +
      fieldHTML('手机号', '<input id="lp-phone" type="tel" inputmode="numeric" maxlength="11" ' +
        'placeholder="请输入 11 位手机号" autocomplete="username" value="' + ph + '">') +
      fieldHTML('密码', pwHTML('lp-pwd', '请输入登录密码', 'current-password')) +
      '  <div class="af-err" id="lp-err"></div>' +
      '  <div class="af-actions"><button type="button" id="lp-go" class="primary block">登 录</button></div>' +
      '  <div class="af-tip">还没有账号？切到「' + (o.requirePwd ? '验证码重设' : '验证码登录 / 注册') +
      '」，用手机号验证后设置密码。<br>忘记密码也可以用短信验证码重设。</div>' +
      '  <button type="button" id="lp-reset" class="link-btn">忘记密码？用短信验证码重设</button>' +
      '</div>' +
      '<div class="af-pane" id="lg-otp" style="display:none">' +
      fieldHTML('手机号',
        '<div class="af-row"><input id="lo-phone" type="tel" inputmode="numeric" maxlength="11" ' +
        'placeholder="请输入 11 位手机号" autocomplete="username" value="' + ph + '">' +
        '<button type="button" id="lo-send">获取验证码</button></div>' +
        '<div class="af-err" id="lo-phone-err"></div>') +
      fieldHTML('短信验证码',
        '<input id="lo-code" type="text" inputmode="numeric" maxlength="8" ' +
        'placeholder="请输入短信验证码" autocomplete="one-time-code">') +
      fieldHTML(o.requirePwd ? '新密码' : '设置登录密码',
        pwHTML('lo-pwd', '6 位以上，需含字母和数字', 'new-password'),
        o.requirePwd ? '' : '（新用户必填）') +
      fieldHTML('确认密码', pwHTML('lo-pwd2', '请再次输入密码', 'new-password')) +
      (o.requirePwd ? '' :
        fieldHTML('昵称', '<input id="lo-name" type="text" maxlength="20" placeholder="例如：王老师">', '（选填）')) +
      '  <div class="af-err" id="lo-err"></div>' +
      '  <div class="af-actions"><button type="button" id="lo-go" class="primary block">' +
      (o.requirePwd ? '确认重设密码' : '登录 / 注册') + '</button></div>' +
      '  <div class="af-tip">密码需 6 位以上，且必须同时包含字母和数字（不能是纯数字或纯字母）。</div>' +
      '</div>';
  }

  /** 把表单行为绑定到已渲染好的 DOM 上；closeFn 用于成功后关闭容器 */
  function bindAuthForm(body, o, closeFn) {
    o = o || {};
    function close() { if (closeFn) closeFn(); }
    function v(sel) { var el = body.querySelector(sel); return el ? String(el.value || '').trim() : ''; }
    function err(sel, msg) {
      var el = body.querySelector(sel);
      if (el) el.innerHTML = msg ? '<div class="af-err-box">' + U.esc(msg) + '</div>' : '';
    }
    function switchTab(t) {
      Array.prototype.forEach.call(body.querySelectorAll('.seg-btn'), function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === t);
      });
      Array.prototype.forEach.call(body.querySelectorAll('.af-pane'), function (p) {
        p.style.display = p.id === ('lg-' + t) ? '' : 'none';
      });
      err('#lp-err', ''); err('#lo-err', '');
    }
    Array.prototype.forEach.call(body.querySelectorAll('.seg-btn'), function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });
    switchTab(o.tab === 'otp' ? 'otp' : 'pwd');

    /* 密码明文切换 */
    Array.prototype.forEach.call(body.querySelectorAll('[data-eye]'), function (btn) {
      btn.addEventListener('click', function () {
        var inp = body.querySelector('#' + btn.getAttribute('data-eye'));
        if (!inp) return;
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        btn.textContent = show ? '隐藏' : '显示';
      });
    });

    /* 昵称保存（注册与重设两条路径共用） */
    function saveNick(nick) {
      if (!nick) return;
      withProfile(function () { return updateProfile({ name: nick }); })
        .then(function () { Toast('昵称已设置为「' + nick + '」', 'ok'); })
        .catch(function () { });
    }

    /* —— 密码登录 —— */
    body.querySelector('#lp-reset').addEventListener('click', function () {
      close();
      openAuthModal('otp', { requirePwd: true, phone: v('#lp-phone') });
    });
    body.querySelector('#lp-go').addEventListener('click', function () {
      var phone = v('#lp-phone'), pwd = v('#lp-pwd');
      err('#lp-err', '');
      if (!/^1\d{10}$/.test(phone)) return err('#lp-err', '请输入正确的 11 位手机号');
      if (!pwd) return err('#lp-err', '请输入密码');
      var btn = body.querySelector('#lp-go');
      btn.disabled = true; btn.textContent = '登录中…';
      cloud.auth.signInWithPassword({ phone: phone, password: pwd }).then(function (res) {
        btn.disabled = false; btn.textContent = '登 录';
        if (res.error) {
          var m = String(res.error.message || '');
          // SDK 明确报「未设置密码」→ 引导去验证码页设密码，并自动切过去、预填手机号
          if (/password\s*not\s*set/i.test(m)) {
            var otpTab = o.requirePwd ? '验证码重设' : '验证码登录 / 注册';
            switchTab('otp');                 // 先切页：switchTab 会清空错误区，必须在写提示前切
            var target = body.querySelector('#lo-phone');
            if (target) target.value = phone;
            // 原密码页保留标准提示语（切回去仍看得到）；验证码页给出下一步动作
            err('#lp-err', '该账号尚未设置密码，请切换到「' + otpTab + '」用短信验证码设置密码');
            err('#lo-err', '该账号尚未设置密码，请获取短信验证码后设置登录密码');
            return;
          }
          return err('#lp-err', m || '手机号或密码不正确');
        }
        close();
        Toast('登录成功', 'ok');
        onSignedIn(res.data);
        // 用密码登录成功 → 该账号肯定已设置密码，回写档案消除「未设置密码」提示
        markPasswordSet();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '登 录';
        err('#lp-err', (e && e.message) || '登录失败，请重试');
      });
    });

    /* —— 验证码：注册 / 登录 / 重设密码 —— */
    var sendEl = body.querySelector('#lo-send');
    var cd = 0, timer = null;
    sendEl.addEventListener('click', function () {
      var phone = v('#lo-phone');
      err('#lo-phone-err', ''); err('#lo-err', '');
      if (!/^1\d{10}$/.test(phone)) {
        err('#lo-phone-err', '请输入正确的 11 位手机号');
        return;
      }
      sendEl.disabled = true;
      cloud.auth.sendOtp({ phone: phone }).then(function (sent) {
        if (sent.error) {
          sendEl.disabled = false;
          return err('#lo-err', sent.error.message || '验证码发送失败，请稍后再试');
        }
        pendingOtp = {
          phone: phone,
          verificationId: sent.data.verificationId,
          isExistingUser: !!sent.data.isExistingUser
        };
        Toast('验证码已发送，请查收短信', 'ok', 3000);
        cd = 60;
        sendEl.textContent = cd + ' 秒后重发';
        timer = setInterval(function () {
          cd--;
          sendEl.textContent = cd > 0 ? cd + ' 秒后重发' : '获取验证码';
          if (cd <= 0) { clearInterval(timer); timer = null; sendEl.disabled = false; sendEl.textContent = '获取验证码'; }
        }, 1000);
      }).catch(function (e) {
        sendEl.disabled = false;
        err('#lo-err', (e && e.message) || '网络异常，验证码发送失败');
      });
    });

    body.querySelector('#lo-go').addEventListener('click', function () {
      var goBtn = body.querySelector('#lo-go');
      var label = o.requirePwd ? '确认重设密码' : '登录 / 注册';
      var phone = v('#lo-phone'), code = v('#lo-code');
      var pwd = v('#lo-pwd'), pwd2 = v('#lo-pwd2');
      var nick = v('#lo-name');
      err('#lo-err', '');
      if (!/^1\d{10}$/.test(phone)) return err('#lo-err', '请输入正确的 11 位手机号');
      if (!pendingOtp || pendingOtp.phone !== phone) return err('#lo-err', '请先获取当前手机号的验证码');
      if (!code) return err('#lo-err', '请输入短信验证码');
      if (o.requirePwd || !pendingOtp.isExistingUser || pwd) {
        var pe = pwdMsg(pwd);
        if (pe) return err('#lo-err', pe);
        if (pwd !== pwd2) return err('#lo-err', '两次输入的密码不一致');
      }
      goBtn.disabled = true; goBtn.textContent = '处理中…';
      var finish = function () { goBtn.disabled = false; goBtn.textContent = label; };

      /* 老用户重设密码：绕开 SDK verifyOtp（它会丢弃密码），手动三步 */
      var needReset = !!pwd && (o.requirePwd || pendingOtp.isExistingUser);
      if (needReset) {
        resetPasswordByOtp(phone, pendingOtp.verificationId, code, pwd)
          .then(function () {
            // 密码已写入云端 → 用新密码建立会话
            return cloud.auth.signInWithPassword({ phone: phone, password: pwd });
          })
          .then(function (res) {
            if (!res || res.error) {
              throw new Error((res && res.error && res.error.message) ||
                '密码已重设，但自动登录失败，请手动登录一次');
            }
            finish();
            pendingOtp = null;
            close();
            Toast('密码已重设，下次登录请使用新密码', 'ok', 4000);
            onSignedIn(res.data);
            markPasswordSet();
            saveNick(nick);
          })
          .catch(function (e) {
            finish();
            err('#lo-err', (e && e.message) || '重设密码失败，请稍后再试');
          });
        return;
      }

      /* 新用户注册 / 老用户免密登录：走 SDK（signUp 分支会带上 password） */
      var payload = {
        phone: pendingOtp.phone,
        verificationId: pendingOtp.verificationId,
        isExistingUser: pendingOtp.isExistingUser,
        token: code
      };
      if (pwd) payload.password = pwd;
      cloud.auth.verifyOtp(payload).then(function (done) {
        finish();
        if (done.error) return err('#lo-err', done.error.message || '验证码不正确或已过期');
        var setPwd = !!pwd;
        pendingOtp = null;
        close();
        Toast(o.requirePwd ? '密码已重设，下次登录请使用新密码' : '登录成功', 'ok', 4000);
        onSignedIn(done.data);
        // 设置了密码 → 立即回写档案，登录提示与密码状态保持同步
        if (setPwd) markPasswordSet();
        saveNick(nick);
      }).catch(function (e) {
        finish();
        err('#lo-err', (e && e.message) || '验证失败，请重试');
      });
    });

    setTimeout(function () {
      var first = body.querySelector(o.tab === 'otp' ? '#lo-phone' : '#lp-phone');
      if (first) first.focus();
    }, 60);
  }

  /** 构造一份完整的登录表单（独立登录页与弹窗共用） */
  function buildAuthForm(tab, opts) {
    var o = Object.assign({}, opts || {}, { tab: tab === 'otp' ? 'otp' : 'pwd' });
    var body = document.createElement('div');
    body.className = 'af';
    body.innerHTML = authFormHTML(o);
    bindAuthForm(body, o, function () { if (o.onClose) o.onClose(); });
    return body;
  }

  function openAuthModal(tab, opts) {
    opts = opts || {};
    var mask = null;
    var o = Object.assign({}, opts, {
      onClose: function () { if (mask) mask.remove(); }
    });
    var body = buildAuthForm(tab, o);
    mask = Modal.open({
      title: o.requirePwd ? '重设登录密码' : '登录 · 学生成绩管理系统',
      body: body, okText: null, cancelText: '关闭'
    });
    return mask;
  }

  /* ---------------- 用户设置 ---------------- */
  function openSettingsModal() {
    var p = state.profile || {};
    var phone = myPhone();
    var pwdChip = hasPassword()
      ? '<span class="chip ch-green">已设置</span>'
      : '<span class="chip ch-amber">未设置</span>';
    var body = document.createElement('div');
    body.className = 'af';
    body.innerHTML =
      '<div class="set-sec"><h4>基本资料</h4>' +
      fieldHTML('手机号码',
        '<input class="ro" id="st-phone" value="' + U.esc(phone) + '" readonly disabled>' +
        '<div class="af-note">手机号即登录账号，不可修改。</div>') +
      fieldHTML('昵称',
        '<input id="st-name" maxlength="20" placeholder="例如：王老师" value="' + U.esc(p.name || '') + '">',
        '（会显示在右上角与「最后修改人」）') +
      fieldHTML('登录密码', '<div class="af-static">' + pwdChip +
        (hasPassword()
          ? '<span class="muted" style="margin-left:8px">可在下方「修改密码」中更改</span>'
          : '<span class="muted" style="margin-left:8px">尚未设置密码，只能用验证码登录</span>') + '</div>') +
      '  <div class="af-err" id="st-name-err"></div>' +
      '  <div class="af-actions"><button type="button" id="st-save" class="primary">保存基本资料</button></div>' +
      '</div>' +
      '<div class="set-sec"><h4>修改密码</h4>' +
      fieldHTML('原密码', pwHTML('st-old', '请输入当前密码', 'current-password')) +
      fieldHTML('新密码', pwHTML('st-new', '6 位以上，需含字母和数字', 'new-password')) +
      fieldHTML('确认新密码', pwHTML('st-new2', '请再次输入新密码', 'new-password')) +
      '  <div class="af-err" id="st-err"></div>' +
      '  <div class="af-actions"><button type="button" id="st-pwd" class="primary">修改密码</button></div>' +
      (hasPassword() ? '' :
        '  <div class="af-tip">你的账号当初是验证码登录、从未设过密码。</div>' +
        '  <button type="button" id="st-pwd-otp" class="link-btn">用短信验证码设置密码</button>') +
      '</div>' +
      '<div class="set-sec"><h4>账号权限</h4>' +
      '<div class="muted" style="font-size:13px;line-height:1.8">' + statusDesc(p.status) + '</div></div>';

    var mask = Modal.open({ title: '用户设置', body: body, okText: null, cancelText: '关闭' });
    function v(s) { var el = body.querySelector(s); return el ? String(el.value || '').trim() : ''; }
    function err(s, m) {
      var el = body.querySelector(s);
      if (el) el.innerHTML = m ? '<div class="af-err-box">' + U.esc(m) + '</div>' : '';
    }
    Array.prototype.forEach.call(body.querySelectorAll('[data-eye]'), function (btn) {
      btn.addEventListener('click', function () {
        var inp = body.querySelector('#' + btn.getAttribute('data-eye'));
        if (!inp) return;
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        btn.textContent = show ? '隐藏' : '显示';
      });
    });

    body.querySelector('#st-save').addEventListener('click', function () {
      var name = v('#st-name');
      err('#st-name-err', '');
      if (!name) return err('#st-name-err', '昵称不能为空（可填「王老师」这样的称呼）');
      var btn = body.querySelector('#st-save'); btn.disabled = true; btn.textContent = '保存中…';
      updateProfile({ name: name }).then(function () {
        btn.disabled = false; btn.textContent = '保存基本资料';
        Toast('基本资料已更新', 'ok');
        buildUserArea();
        if (App.render) App.render();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '保存基本资料';
        err('#st-name-err', (e && e.message) || '保存失败');
      });
    });

    body.querySelector('#st-pwd').addEventListener('click', function () {
      var old = v('#st-old'), np = v('#st-new'), np2 = v('#st-new2');
      err('#st-err', '');
      if (!old) return err('#st-err', '请输入原密码');
      var pe = pwdMsg(np);
      if (pe) return err('#st-err', pe);
      if (np !== np2) return err('#st-err', '两次输入的新密码不一致');
      var btn = body.querySelector('#st-pwd'); btn.disabled = true; btn.textContent = '提交中…';
      cloud.auth.resetPasswordForOld({ oldPassword: old, newPassword: np }).then(function (res) {
        btn.disabled = false; btn.textContent = '修改密码';
        if (res && res.error) return err('#st-err', res.error.message || '修改失败');
        ['#st-old', '#st-new', '#st-new2'].forEach(function (sel) { body.querySelector(sel).value = ''; });
        Toast('密码修改成功，下次登录请使用新密码', 'ok', 4000);
        // 密码状态写回档案，关闭后重开设置页不再提示「未设置密码」
        markPasswordSet().then(function () {
          if (App.render) App.render();
          mask.remove();
        });
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '修改密码';
        err('#st-err', (e && e.message) || '修改失败');
      });
    });

    var oLink = body.querySelector('#st-pwd-otp');
    if (oLink) oLink.addEventListener('click', function () {
      mask.remove();
      openAuthModal('otp', { requirePwd: true, phone: myPhone() });
    });
    return mask;
  }

  function statusDesc(st) {
    if (st === 'readonly') return '只读：可以查看全部成绩，但不能录入、修改或删除。';
    if (st === 'blocked') return '已停用：保留账号，但无法查看与录入任何数据。';
    if (st === 'deleted') return '已删除：账号已被管理员删除，无法继续使用。';
    return '正常：可以查看、录入、修改与删除成绩数据。';
  }

  /* =========================================================
   * 同步调度：推（写穿）与拉（last-write-wins）分离，统一排队串行执行。
   * 同一时刻只有一个云端任务在跑；推送优先于拉取，避免刚录入的数据被旧版本覆盖。
   * ========================================================= */
  var task = { running: false, push: false, pull: false };

  function requestPush() {
    task.push = true;
    runQueue();
  }
  function requestPull() {
    // 有本地改动正等待写穿时，先把推送提到本次队列的最前面执行：
    // 否则一次定时拉取会用云端旧版本覆盖掉老师刚录入、还没来得及上传的内容。
    if (schedule._t) { clearTimeout(schedule._t); schedule._t = null; task.push = true; }
    task.pull = true;
    runQueue();
  }

  function runQueue() {
    if (task.running) return;
    if (!task.push && !task.pull) return;
    if (!state.signedIn || !cloud || isGated() || state.profileError) {
      task.push = false; task.pull = false;
      return;
    }
    task.running = true;
    state.syncing = true; emit();
    var doPush = task.push, doPull = task.pull;
    task.push = false; task.pull = false;
    var chain = doPush ? pushChanges() : Promise.resolve(null);
    chain
      .then(function () { return doPull ? pullChanges() : null; })
      .catch(function (e) {
        if (e && e.message) state.lastError = e.message;
      })
      .then(function () {
        task.running = false;
        state.syncing = false;
        emit();
        if (App.render) { try { App.render(); } catch (e2) { } }
        runQueue();                 // 期间新产生的任务继续跑
      });
  }

  /** 本地数据一改就排一次推送（debounce 合并连续录入） */
  function schedule() {
    if (!state.signedIn) return;
    clearTimeout(schedule._t);
    schedule._t = setTimeout(function () { schedule._t = null; requestPush(); }, 800);
  }

  /** 保存失败提示：30 秒内不重复打扰，但状态灯始终显示「同步失败」 */
  function toastSaveFail(n) {
    var now = Date.now();
    if (toastSaveFail._at && now - toastSaveFail._at < 30000) return;
    toastSaveFail._at = now;
    Toast(n > 0
      ? ('保存到云端失败：' + n + ' 条改动未写入，请重试')
      : '保存到云端失败，请重试', 'error', 6000);
  }
  /** 失败后自动重试一次（本机没有副本，必须把改动补上去） */
  function scheduleRetry() {
    clearTimeout(scheduleRetry._t);
    scheduleRetry._t = setTimeout(function () {
      if (state.signedIn) requestPush();
    }, 8000);
  }

  /**
   * 写穿：把内存里的增删改立即写到云端。
   * 失败的记录不更新指纹 → 下轮继续重试（相当于标记重试，绝不静默丢弃）。
   *
   * 只读 / 停用 / 未登录时：不动 snap，直接返回。
   * 绝不能在这里执行 snapshot() —— 那会把「还排在 800ms 去抖窗口里、或上次推送失败待重试」
   * 的改动标成已同步，既不写云端，账号恢复 active 后也不会补写，界面上会显示云端并不存在的值。
   */
  function pushChanges() {
    if (!canEdit()) return Promise.resolve();
    return pushDeletes().then(function (failDel) {
      return pushRows().then(function (failRows) { return failDel + failRows; });
    }).then(function (fails) {
      if (fails > 0) {
        state.lastError = '有 ' + fails + ' 条改动未写入云端';
        toastSaveFail(fails);
        scheduleRetry();
      } else {
        state.lastError = '';
        state.lastSyncAt = new Date().toISOString();
      }
    }).catch(function (e) {
      state.lastError = (e && e.message) ? e.message : String(e);
      toastSaveFail(0);
      scheduleRetry();
    });
  }

  /** 拉取：云端数据无条件覆盖内存（以云端最新一次写入为准） */
  function pullChanges() {
    return cloud.database.from(TABLE).select('*').then(function (res) {
      if (res.error) throw res.error;
      var rows = res.data || [];
      var gone = {}, i;
      (Store.data.deletedKeys || []).forEach(function (k) { gone[delKeyOf(k)] = 1; });
      var next = [];
      for (i = 0; i < rows.length; i++) {
        if (gone[rowKey(rows[i])]) continue;      // 等待删除的记录不再拉回来
        next.push(fromRow(rows[i]));
      }
      Store.data.records = next;                  // 云端为准：无条件覆盖
      Store.data.modules = Store.data.modules || {};
      snap = snapshot();                          // 刷新基线，避免把云端数据当成本地改动回传
      state.lastSyncAt = new Date().toISOString();
      // 拉取成功不清掉写入失败标记：必须等失败的改动真正补写成功
    });
  }

  function snapshot() {
    var m = {}, c = {};
    Store.data.records.forEach(function (r) {
      var k = snapKey(r);
      m[k] = fp(r);
      c[k] = snapState(r);
    });
    synced = c;
    return m;
  }

  /**
   * 待删除队列：逐条从云端删除，失败的留到下次重试。
   * 记到队列里时带着云端主键就按主键删：改过键字段的记录，只按新业务键去删会删空。
   */
  function pushDeletes() {
    var keys = (Store.data.deletedKeys || []).slice();
    if (!keys.length) return Promise.resolve(0);
    var rest = [];
    var chain = Promise.resolve(0);
    keys.forEach(function (k) {
      chain = chain.then(function (fails) {
        var p = String(k).split(SEP);
        var cid = delCidOf(k);
        var q = cloud.database.from(TABLE).delete();
        q = cid ? q.eq('id', cid) : q.match({
          stu_name: p[0], school: p[1], class_name: p[2], exam: p[3]
        });
        return q.then(function (res) {
          if (res && res.error) { rest.push(k); return fails + 1; }
          return fails;
        }).catch(function () { rest.push(k); return fails + 1; });
      });
    });
    return chain.then(function (fails) {
      Store.data.deletedKeys = rest;
      return fails;
    });
  }

  /* ---------------- 单条记录的云端写入 ---------------- */

  /** PostgREST 返回的唯一约束冲突（23505 duplicate key） */
  function isUniqueViolation(e) {
    if (!e) return false;
    var code = String(e.code || '');
    if (code === '23505' || code === 'unique_violation') return true;
    var s = String((e.message || '') + ' ' + (e.details || '') + ' ' + (e.hint || ''));
    return /duplicate key|unique constraint|unique_violation|already exists/i.test(s);
  }

  /**
   * 按云端主键更新一条记录 —— 绝不用业务键做 upsert。
   * 编辑时改了学校/班级/考试，业务键就变了，按业务键匹配必然插出一条新的。
   * 返回 {ok} / {ok, reinserted} / {ok:false, conflict:true} / {ok:false}
   */
  function updateByCid(r, row) {
    return cloud.database.from(TABLE).update(row).eq('id', r._cid).select()
      .then(function (res) {
        if (res && res.error) {
          if (isUniqueViolation(res.error)) return { ok: false, conflict: true };
          return { ok: false };
        }
        var hit = res && res.data && res.data[0];
        if (hit) return { ok: true, updated_at: hit.updated_at };
        // 一条都没命中：原记录已被别人删掉了 → 回退为插入，绝不静默丢失
        return insertRow(r, row).then(function (ins) {
          if (ins.ok) return { ok: true, reinserted: true, cid: ins.cid, updated_at: ins.updated_at };
          if (ins.conflict) return { ok: false, conflict: true };
          return { ok: false };
        });
      })
      .catch(function (e) {
        if (isUniqueViolation(e)) return { ok: false, conflict: true };
        return { ok: false };
      });
  }

  /**
   * 插入一条本地新建的记录，并把云端主键回填到内存记录上
   * （不回填的话，下一次编辑又会走 insert，同样插出一条新的）。
   */
  function insertRow(r, row) {
    return cloud.database.from(TABLE).insert(row).select()
      .then(function (res) {
        if (res && res.error) {
          if (isUniqueViolation(res.error)) return adoptByKey(r, row);
          return { ok: false };
        }
        var hit = res && res.data && res.data[0];
        if (!hit) return { ok: false };
        return { ok: true, cid: hit.id, updated_at: hit.updated_at };
      })
      .catch(function (e) {
        if (isUniqueViolation(e)) return adoptByKey(r, row);
        return { ok: false };
      });
  }

  /**
   * 插入撞上唯一索引：说明这条业务键已经被别人（或上次中断的写入）占用。
   * 查出那一行的主键，改为按主键更新它，沿用 last-write-wins，不产生第二条。
   */
  function adoptByKey(r, row) {
    return cloud.database.from(TABLE).select('id')
      .match({ stu_name: r.name, school: r.school, class_name: r.cls, exam: r.exam })
      .then(function (res) {
        var hit = res && res.data && res.data[0];
        if (!hit || !hit.id) return { ok: false };
        return cloud.database.from(TABLE).update(row).eq('id', hit.id).select()
          .then(function (up) {
            var got = up && up.data && up.data[0];
            if (!got) return { ok: false };
            return { ok: true, cid: hit.id, updated_at: got.updated_at, adopted: true };
          });
      })
      .catch(function () { return { ok: false }; });
  }

  /**
   * 逐条写入有改动的记录：已有云端主键 → update by id；本地新建 → insert。
   * last-write-wins：不检测版本冲突，直接覆盖。
   * 返回写入失败条数；成功的记录才会更新指纹（失败的下轮继续重试）。
   */
  function pushRows() {
    var chain = Promise.resolve({ done: [], states: [], failed: 0, conflicts: [], reinserted: [] });
    Store.data.records.forEach(function (r) {
      chain = chain.then(function (acc) {
        var before = fp(r);
        if (snap && snap[snapKey(r)] !== undefined && snap[snapKey(r)] === before) return acc;   // 无变化
        var row = toRow(r);
        return ((r._cid || r._cid === 0) ? updateByCid(r, row) : insertRow(r, row))
          .then(function (res) {
            if (res.ok) {
              if (res.cid) r._cid = res.cid;             // 回填云端主键
              if (res.updated_at) r.mod = res.updated_at;
              if (res.reinserted) acc.reinserted.push(r);
              // 推送期间又被改过 → 不标记已同步，下轮继续推最新内容
              if (fp(r) === before) {
                var k = snapKey(r);                      // insert 回填后标识才从内存 id 换成主键
                acc.done.push([k, before]);
                acc.states.push([k, snapState(r)]);
              } else acc.failed++;
              return acc;
            }
            if (res.conflict) { acc.conflicts.push(r); return acc; }
            acc.failed++;
            return acc;
          })
          .catch(function () { acc.failed++; return acc; });
      });
    });
    return chain.then(function (acc) {
      if (!snap) snap = {};
      if (!synced) synced = {};
      var i;
      for (i = 0; i < acc.done.length; i++) {
        snap[acc.done[i][0]] = acc.done[i][1];
        synced[acc.done[i][0]] = acc.states[i][1];
      }
      for (i = 0; i < acc.conflicts.length; i++) settleConflict(acc.conflicts[i]);
      for (i = 0; i < acc.reinserted.length; i++) {
        Toast('「' + recText(acc.reinserted[i]) + '」的原记录已不在云端，已按最新内容重新写入', 'warn', 5000);
      }
      return acc.failed;
    });
  }

  /**
   * 唯一键冲突：这次改动写不进云端，按产品语义把内存回滚到「上次确认在云端的内容」，
   * 并补登记指纹，免得这条记录被无限重试、反复弹失败提示。
   */
  function settleConflict(r) {
    var k = snapKey(r);
    var label = recText(r);                   // 提示里要说「想存成什么」，必须在回滚前取
    var prev = synced && synced[k];
    if (prev) restoreState(r, prev);
    snap[k] = fp(r);
    Toast('保存失败：已存在相同「姓名+学校+班级+考试」的记录（' + label +
      '），本次修改未保存，请改为修改已有的那一条', 'error', 6000);
  }

  /* ---------------- 顶栏用户区 / 头像菜单 / 同步状态 ---------------- */
  function displayName() {
    if (!state.signedIn) return '未登录';
    var p = state.profile;
    if (p && p.name) return p.name;
    var u = session && session.user;
    var raw = (u && u.name) || '';
    // 未设置昵称时，某些账号的 name 就是手机号，这里打码显示
    if (/^1\d{10}$/.test(String(raw))) return mask(raw);
    return raw || mask(myPhone()) || '老师';
  }

  function buildUserArea() {
    var box = document.getElementById('user-box');
    if (!box) return;
    var name = displayName();
    box.innerHTML =
      '<div class="sync-state" id="sync-state"></div>' +
      '<div class="user-chip" id="user-chip" title="账号菜单">' +
      '<span class="avatar">' + U.esc(name.slice(0, 1)) + '</span>' +
      '<span class="uname">' + U.esc(name) + '</span>' +
      '<span class="caret">▾</span>' +
      '</div>' +
      '<div class="user-menu" id="user-menu" style="display:none"></div>';

    var chip = box.querySelector('#user-chip');
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleUserMenu();
    });
    if (!buildUserArea._bound) {      // 只绑一次，避免反复重建累积监听器
      buildUserArea._bound = true;
      document.addEventListener('click', function (e) {
        var m = document.getElementById('user-menu');
        if (m && m.style.display !== 'none' && (!e.target || !m.contains(e.target))) m.style.display = 'none';
      });
    }
    renderState();
  }

  function closeUserMenu() {
    var m = document.getElementById('user-menu');
    if (m) m.style.display = 'none';
  }

  function toggleUserMenu() {
    var m = document.getElementById('user-menu');
    if (!m) return;
    if (m.style.display !== 'none') { m.style.display = 'none'; return; }
    var items = [];
    if (!state.signedIn) {
      items.push({ label: '登录 / 注册', fn: function () { openAuthModal('pwd'); } });
    } else {
      items.push({ label: '用户设置（昵称 · 密码）', fn: openSettingsModal });
      items.push({ label: '退出登录', danger: true, fn: confirmSignOut });
    }

    var st = status();
    var stChip = st === 'active' ? '<span class="chip ch-green">正常</span>'
      : st === 'readonly' ? '<span class="chip ch-amber">只读</span>'
        : st === 'blocked' ? '<span class="chip ch-red">已停用</span>'
          : st === 'deleted' ? '<span class="chip ch-red">已删除</span>' : '';

    var h = '';
    if (state.signedIn) {
      h += '<div class="um-head">' +
        '<div class="um-name">' + U.esc(displayName()) + '</div>' +
        '<div class="um-sub">' + U.esc(mask(myPhone())) + ' ' + stChip + '</div>' +
        '</div>';
    }
    items.forEach(function (it) {
      h += '<div class="um-item' + (it.disabled ? ' dis' : '') + (it.danger ? ' danger' : '') + '" data-i="' +
        U.esc(it.label) + '">' + U.esc(it.label) + '</div>';
    });
    m.innerHTML = h;
    m.style.display = '';

    Array.prototype.forEach.call(m.querySelectorAll('.um-item'), function (el) {
      el.addEventListener('click', function () {
        var label = el.getAttribute('data-i');
        var it = items.filter(function (x) { return x.label === label; })[0];
        closeUserMenu();
        if (it && it.fn && !it.disabled) it.fn();
      });
    });
  }

  /** 顶栏同步状态：未登录 / 同步中 / 已同步 HH:MM / 同步失败请重试 */
  function renderState() {
    var el = document.getElementById('sync-state');
    if (!el) return;
    if (!state.signedIn) {
      el.innerHTML = '<span class="pill off">未登录</span>';
      return;
    }
    if (state.blocked) {
      el.innerHTML = '<span class="pill err">' + (status() === 'deleted' ? '账号已删除' : '账号已停用') + '</span>';
      return;
    }
    if (state.profileError) {
      el.innerHTML = '<span class="pill err" title="' + U.esc(state.profileError) + '">档案加载失败</span>';
      return;
    }
    if (state.syncing) {
      el.innerHTML = '<span class="pill wait">同步中…</span>';
      return;
    }
    if (state.lastError) {
      el.innerHTML = '<span class="pill err" title="' + U.esc(state.lastError) + '">同步失败 · 请重试</span>';
      return;
    }
    var t = state.lastSyncAt ? new Date(state.lastSyncAt) : null;
    var hh = t ? ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) : '';
    var ro = status() === 'readonly' ? ' · 只读' : '';
    el.innerHTML = '<span class="pill ok">已同步 ' + hh + ro + '</span>';
  }

  App.Sync = {
    state: state,
    /** 把 cloud 实例暴露给 App.DB（新增 7 张表走通用 CRUD；成绩同步逻辑不使用它） */
    db: function () { return cloud; },
    on: function (fn) { listeners.push(fn); },
    user: function () { return session && session.user ? session.user : null; },
    me: me,
    myPhone: myPhone,
    /** 当前用户档案 {phone,name,role,status}；未取到时为 null */
    profile: function () { return state.profile; },
    isAdmin: function () { return !!(state.profile && state.profile.role === 'admin'); },
    /** 账号级权限：可查看 / 可编辑（只读与停用账号不可编辑） */
    canView: canView,
    canEdit: canEdit,
    status: status,
    /** 是否需要跳转到独立登录页（未登录 / 鉴权失效） */
    needLogin: needLogin,
    /** 打开登录弹窗（密码登录 / 验证码登录注册） */
    openLogin: function () { openAuthModal('pwd'); },
    /** 构造登录表单节点（独立登录页复用） */
    buildAuthForm: buildAuthForm,
    openSettings: openSettingsModal,
    /** 退出登录：彻底清理会话与同步上下文，避免换号串号 */
    signOut: signOutHere,
    confirmSignOut: confirmSignOut,
    /** 该账号是否已设置过登录密码 */
    hasPassword: hasPassword,
    /** 自己修改昵称 */
    setNickname: function (name) { return updateProfile({ name: name }); },
    /** 管理员：列出全部用户档案 */
    listUsers: function () { return listProfiles(); },
    /** 管理员：限制编辑（保留账号）—— readonly 只读 / blocked 停用 / active 恢复正常 */
    setUserStatus: function (phone, st) {
      return cloud.database.from(PROFILES)
        .update({ status: st, updated_at: new Date().toISOString() })
        .eq('phone', phone)
        .select()
        .then(function (res) {
          if (res.error) throw res.error;
          if (String(phone) === myPhone() && state.profile) { state.profile.status = st; renderState(); }
          return res.data;
        });
    },
    /** 管理员：删除账户（账号置为 deleted，不可恢复、不可再登录；已录入的成绩数据保留） */
    deleteUser: function (phone) {
      return cloud.database.from(PROFILES)
        .update({ status: 'deleted', updated_at: new Date().toISOString() })
        .eq('phone', phone)
        .select()
        .then(function (res) {
          if (res.error) throw res.error;
          if (String(phone) === myPhone() && state.profile) {
            state.profile.status = 'deleted';
            state.blocked = true;
            showBlockedGate();
          }
          return res.data;
        });
    },
    /** 立即同步一次：先补写本机改动，再拉取云端最新数据 */
    syncNow: function () { requestPush(); requestPull(); },
    boot: boot,
    /**
     * 清空数据：把当前全部记录登记为待删除，交给写穿逻辑逐条从云端删除。
     * 纯云端模式下本机不留副本，必须走云端删除才能真的清干净。
     */
    markAllDeleted: function () {
      Store.data.deletedKeys = Store.data.deletedKeys || [];
      Store.data.records.forEach(function (r) {
        var k = Score.delKey(r);
        if (Store.data.deletedKeys.indexOf(k) < 0) Store.data.deletedKeys.push(k);
      });
    }
  };

  // 正常流程由 app.js 在 Store.init() 之后调用 boot()；此处为兜底，避免漏调用导致永不登录
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () { if (!state.booted) boot(); }, 80);
  });
})(window, window.App);
