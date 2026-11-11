/* =========================================================
 * db.js —— App.DB：7 张新表的通用云端 CRUD
 *
 * 边界（ARCH §2.4，硬约束）：
 *   · score_records / user_profiles 只归 sync.js 独占，本文件禁止注册、禁止访问；
 *     读成绩一律走 App.Store.data.records。
 *   · 云端实例由 sync.js 的 App.Sync.db() 暴露（对 sync.js 的唯一侵入点是一行）。
 *   · 写穿语义：mutation 直接写云端 + .select() 回读，成功才更新内存缓存 ——
 *     内存永不超前于云端；失败进 retry 队列（不丢改动）并 toast「同步失败 · 请重试」。
 *   · 唯一冲突（23505）不静默回滚，向上抛给模块层做「已存在」提示。
 *   · 无外键、无级联：删学生/班级由应用层顺序双写清 class_members，
 *     refreshAll 之后再做孤儿行清理（仅当 students / classes / class_members
 *     **三张表本轮都拉取成功**、且主表非空时才清理）。
 *   · 拉取一律分页（.range 循环），PostgREST 单次上限 1000 行，单次 select 会静默截断。
 *   · insert 的 created_at 由客户端写死并作为重放幂等戳，避免重放插出重复行。
 *
 * API（ARCH §2.4）：
 *   App.DB.define(name, opts)
 *   App.DB.table(name) → { list, get, count, insert, update, remove, findBy, uniqueOf }
 *   App.DB.cache / refreshAll() / flushRetry() / onChange(fn) / start()
 * ========================================================= */
(function (App) {
  'use strict';

  /* 归 sync.js 独占的表：注册即抛错，避免两套写入逻辑打架 */
  var FORBIDDEN = { score_records: true, user_profiles: true };

  /* 定时拉取间隔：与 sync.js 现有 45s 循环对齐（独立计时器，不侵入 sync.js） */
  var REFRESH_MS = 45000;

  /* 分页拉取步长：PostgREST 默认 db-max-rows = 1000，单次 select('*') 会被静默截断 */
  var PAGE = 1000;
  var MAX_PAGES = 200;                 // 硬上限，防「服务端忽略 range」时死循环（20 万行足够）

  /* retry 队列持久化 key 前缀（后缀是账号标识，换号不串用；登出不清） */
  var RETRY_KEY = 'smdb.retry.';

  var defs = {};        // name → { name, module, unique[], label }
  var cache = {};       // name → [row]（渲染层同步读）
  var retry = [];       // [{ kind:'insert'|'update'|'remove', table, payload, id, createdAt }]
  var listeners = [];   // name → 变更回调（emit 广播用）

  /* 本轮全量拉取是否成功（name → true）。
     **必须是「本轮」语义**：孤儿清理拿它当授权。用「历史上曾经成功过」会让上一轮的旧快照
     被当成权威数据，进而把云端真实行判成孤儿删掉（BUG-1 的根因）。 */
  var roundOk = {};

  /* 当前缓存归属的账号（手机号优先）。换号 / 登出必须清空缓存与 roundOk。 */
  var cacheOwner = '';
  var retryOwner = '';  // retry 队列已经从哪个账号的 localStorage 恢复过

  var started = false;
  var timer = null;

  function nowISO() { return new Date().toISOString(); }

  /** 最后修改人（沿用 sync.js 的昵称打码口径） */
  function editorName() {
    try {
      var S = App.Sync;
      return (S && S.me && S.me()) || '';
    } catch (e) { return ''; }
  }

  /** 账号标识：手机号唯一，取不到退昵称，都没有给空串 */
  function currentOwner() {
    var S = App.Sync;
    if (!S) return '';
    try {
      if (typeof S.myPhone === 'function') {
        var p = S.myPhone();
        if (p) return 'p:' + p;
      }
      if (typeof S.me === 'function') {
        var n = S.me();
        if (n) return 'n:' + n;
      }
    } catch (e) { }
    return '';
  }

  /**
   * 复位「与本账号相关」的内存状态：缓存 / 本轮成功标记 / 待重放队列。
   * 登出、换号、拉取前发现 owner 变化时调用。
   * cache 是导出给渲染层读的对象引用，只能原地清空，不能整体重新赋值。
   * 待重放队列在入队时已按账号落盘，这里清内存不会丢数据。
   */
  function resetState() {
    Object.keys(cache).forEach(function (k) { cache[k] = []; });
    Object.keys(roundOk).forEach(function (k) { delete roundOk[k]; });
    retry.length = 0;
    cacheOwner = '';
    retryOwner = '';
  }

  /** 云端 database 实例（未就绪时抛错：调用方都在登录后触发） */
  function gateway() {
    var S = App.Sync;
    if (!S || !S.db) throw new Error('云端同步层尚未就绪，请稍后重试');
    var c = S.db();
    if (!c || !c.database) throw new Error('云端实例尚未就绪，请稍后重试');
    return c.database;
  }

  /** 唯一约束冲突判定（与 sync.js isUniqueViolation 同口径，额外兼容 DATABASE_23505） */
  function isUniqueViolation(e) {
    if (!e) return false;
    var code = String(e.code || '');
    if (code === '23505' || code === 'unique_violation') return true;
    if (code.indexOf('23505') >= 0) return true;
    var s = String((e.message || '') + ' ' + (e.details || '') + ' ' + (e.hint || '') + ' ' + code);
    return /23505|duplicate key|unique constraint|unique_violation/i.test(s);
  }

  function need(name) {
    var d = defs[name];
    if (!d) throw new Error('未注册的数据表：' + name + '（请先调用 App.DB.define）');
    return d;
  }

  /** 复制要落库的字段：id / owner_id / owner_name 由云端维护，前端不写 */
  function pick(row) {
    var out = {};
    var src = row || {};
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      if (k === 'id' || k === 'owner_id' || k === 'owner_name') continue;
      if (src[k] === undefined) continue;
      out[k] = src[k];
    }
    return out;
  }

  function upsertCache(name, row) {
    var list = cache[name] || (cache[name] = []);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(row.id)) { list[i] = row; return row; }
    }
    list.push(row);
    return row;
  }

  function dropCache(name, id) {
    cache[name] = (cache[name] || []).filter(function (r) { return String(r.id) !== String(id); });
  }

  function emit(name) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](name); } catch (e) { /* 单个监听器出错不影响其它 */ }
    }
  }

  function repaint() {
    if (App.render) { try { App.render(); } catch (e) { } }
  }

  function failToast() {
    var now = Date.now();
    if (failToast._at && now - failToast._at < 8000) return;   // 18 条并发失败只提示一次
    failToast._at = now;
    if (App.Toast) App.Toast('同步失败 · 请重试', 'error', 5000);
  }

  function deniedError() {
    var e = new Error('无操作权限');
    e.denied = true;
    return e;
  }

  function uniqueError(def, cause) {
    var e = new Error('「' + def.label + '」已存在，请前往该记录修改');
    e.code = '23505';
    e.unique = true;
    e.cause = cause;
    return e;
  }

  function enqueueRetry(item) {
    for (var i = 0; i < retry.length; i++) {
      var it = retry[i];
      if (it.kind === item.kind && it.table === item.table && it.id === item.id &&
        JSON.stringify(it.payload || null) === JSON.stringify(item.payload || null)) {
        return;   // 同一笔改动不重复入队
      }
    }
    retry.push(item);
  }

  /* ---- retry 队列持久化（S-2：刷新页面不再丢未同步的写操作） ---- */

  function ls() {
    try {
      return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    } catch (e) { return null; }
  }

  function retryKey() { return RETRY_KEY + (cacheOwner || retryOwner || 'anon'); }

  /** 队列落盘（每个账号一个 key，换号互不串用；正常清空时移除 key） */
  function saveRetry() {
    var store = ls();
    if (!store) return;
    try {
      var k = retryKey();
      if (!retry.length) { store.removeItem(k); return; }
      store.setItem(k, JSON.stringify(retry));
    } catch (e) { /* 配额满 / 隐私模式：只丢持久化，内存队列仍有效 */ }
  }

  /** 登录后恢复本账号上次没发出去的写操作（合并进内存队列，去重由 enqueueRetry 负责） */
  function loadRetry() {
    var store = ls();
    if (!store) return 0;
    try {
      var raw = store.getItem(retryKey());
      if (!raw) return 0;
      var arr = JSON.parse(raw);
      if (!arr || !arr.length) return 0;
      var before = retry.length;
      arr.forEach(function (it) {
        if (!it || !it.table) return;
        if (it.kind !== 'insert' && it.kind !== 'update' && it.kind !== 'remove') return;
        enqueueRetry(it);
      });
      return retry.length - before;
    } catch (e) { return 0; }
  }

  /* =========================================================
   * 表定义注册
   * ========================================================= */

  /**
   * @param {string} name 表名
   * @param {{module?:string, unique?:string[], label?:string, createdCol?:string, updatedCol?:string}} opts
   *        module：写入守卫使用的模块 id（决定角色要求）；unique：业务唯一键列（UI 查重）
   *        createdCol：创建时间列名（默认 'created_at'；传 '' 表示该表没有这一列）
   *        updatedCol：更新时间列名（默认 'updated_at'；传 '' 表示该表没有这一列）
   *
   * 为什么需要 createdCol / updatedCol：各表实际列不完全一致 —— class_members 只有
   * joined_at，既没有 created_at 也没有 updated_at。若无脑写 updated_at，PostgREST 会报
   * 42703（column does not exist），插入班级成员会直接失败。列名集中在定义处声明，
   * 写入路径只按声明补列。
   */
  function define(name, opts) {
    if (FORBIDDEN[name]) throw new Error('表 ' + name + ' 归 sync.js 独占，App.DB 不得注册');
    var o = opts || {};
    defs[name] = {
      name: name,
      module: o.module || name,
      unique: o.unique || [],
      label: o.label || name,
      createdCol: o.createdCol === undefined ? 'created_at' : o.createdCol,
      updatedCol: o.updatedCol === undefined ? 'updated_at' : o.updatedCol
    };
    if (!cache[name]) cache[name] = [];
    return defs[name];
  }

  /* =========================================================
   * 表网关
   * ========================================================= */

  function table(name) {
    var d = need(name);

    return {
      /** 缓存同步读（渲染用；云端的唯一权威副本由 refreshAll 覆盖） */
      list: function () { return (cache[name] || []).slice(); },

      get: function (id) {
        var list = cache[name] || [];
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].id) === String(id)) return list[i];
        }
        return null;
      },

      count: function () { return (cache[name] || []).length; },

      /** 业务唯一键命中行（UI 查重用；不发起网络请求） */
      findBy: function (vals) {
        var keys = d.unique;
        if (!keys.length || !vals) return null;
        var list = cache[name] || [];
        for (var i = 0; i < list.length; i++) {
          var row = list[i], hit = true;
          for (var j = 0; j < keys.length; j++) {
            if (String(row[keys[j]] === null || row[keys[j]] === undefined ? '' : row[keys[j]]) !==
              String(vals[keys[j]] === null || vals[keys[j]] === undefined ? '' : vals[keys[j]])) {
              hit = false; break;
            }
          }
          if (hit) return row;
        }
        return null;
      },

      /** 唯一键列名（渲染层拼提示文案用） */
      uniqueOf: function () { return d.unique.slice(); },

      /** 新增一行：校验 → 补幂等戳/时间戳 → 写云端 → 回读 → 缓存 */
      insert: function (row) {
        if (!App.Perm || !App.Perm.assertWrite(d.module)) return Promise.reject(deniedError());
        var payload = pick(row);
        /* BUG-2 根因修复：created_at 由**客户端**写入，并作为重放的幂等戳。
           以前交给云端 default，重放时无从判断「上一次到底写进去没有」，
           customers / daily_tasks 又没有唯一索引，于是重放 = 重复插一行。
           改造后：先写一个确定的 created_at，失败后带着它进 retry 队列，
           重放前按它回查一次，命中即视为已写入。 */
        if (d.createdCol && !payload[d.createdCol]) payload[d.createdCol] = nowISO();
        if (d.updatedCol) payload[d.updatedCol] = nowISO();
        payload.last_editor = editorName();      // 7 张表都有 last_editor（已核对 information_schema）
        var g;
        try { g = gateway(); } catch (e) { return Promise.reject(e); }
        return g.from(name).insert(payload).select().then(function (res) {
          if (res && res.error) throw res.error;
          var hit = res && res.data && res.data[0];
          if (!hit) throw new Error('云端未返回写入结果，请重试');
          upsertCache(name, hit);
          emit(name); repaint();
          return hit;
        }).catch(function (e) {
          if (isUniqueViolation(e)) throw uniqueError(d, e);
          /* 队列里必须带上这次写死的 created_at，否则重放无从回查 */
          enqueueRetry({
            kind: 'insert', table: name, payload: payload,
            createdAt: d.createdCol ? payload[d.createdCol] : ''
          });
          saveRetry();
          failToast();
          throw e;
        });
      },

      /** 修改一行：按云端主键更新（创建时间列只读，永不回写） */
      update: function (id, patch) {
        if (!App.Perm || !App.Perm.assertWrite(d.module)) return Promise.reject(deniedError());
        var payload = pick(patch);
        if (d.createdCol) delete payload[d.createdCol];
        if (d.updatedCol) payload[d.updatedCol] = nowISO();
        payload.last_editor = editorName();      // 7 张表都有 last_editor（已核对 information_schema）
        var g;
        try { g = gateway(); } catch (e) { return Promise.reject(e); }
        return g.from(name).update(payload).eq('id', id).select().then(function (res) {
          if (res && res.error) throw res.error;
          var hit = res && res.data && res.data[0];
          if (!hit) throw new Error('该记录已被删除，无法修改');
          upsertCache(name, hit);
          emit(name); repaint();
          return hit;
        }).catch(function (e) {
          if (isUniqueViolation(e)) throw uniqueError(d, e);
          enqueueRetry({ kind: 'update', table: name, id: id, payload: payload });
          saveRetry();
          failToast();
          throw e;
        });
      },

      /** 删除一行：按云端主键删除，成功后移出缓存 */
      remove: function (id) {
        if (!App.Perm || !App.Perm.assertWrite(d.module)) return Promise.reject(deniedError());
        var g;
        try { g = gateway(); } catch (e) { return Promise.reject(e); }
        return g.from(name).delete().eq('id', id).then(function (res) {
          if (res && res.error) throw res.error;
          dropCache(name, id);
          emit(name); repaint();
          return true;
        }).catch(function (e) {
          enqueueRetry({ kind: 'remove', table: name, id: id });
          saveRetry();
          failToast();
          throw e;
        });
      }
    };
  }

  /* =========================================================
   * 全量拉取 / 重试 / 孤儿清理
   * ========================================================= */

  function signedIn() {
    var S = App.Sync;
    return !!(S && S.state && S.state.signedIn);
  }

  /**
   * 分页拉取一张表。
   *
   * **为什么必须分页**（S-1）：PostgREST 默认 `db-max-rows = 1000`，单次 `select('*')`
   * 会被**静默截断**且不报错 —— 学员超 1000 人时页面会「少人」，更糟的是孤儿清理会
   * 把截断后看不见的行判成孤儿去删。这里用 `.range(from,to)` 循环，直到返回行数 < 步长。
   *
   * **本轮语义**（BUG-1 根因修复）：只有**每一页都成功**才写 `cache[name]` 并置
   * `roundOk[name] = true`。任何一页失败 → 立即返回 false，**cache / roundOk 都不动**，
   * 绝不能拿上一轮的旧快照充当本轮权威数据。
   *
   * @param {string} name 表名
   * @returns {Promise<boolean>} 本轮是否完整拉取成功
   */
  function fetchTable(name) {
    var g;
    try { g = gateway(); } catch (e) { return Promise.resolve(false); }

    var acc = [];
    var from = 0;
    var pages = 0;

    function step() {
      /* 硬上限：服务端若忽略 range 会无限返回同一页，这里兜底防死循环。
         触顶说明数据量超出设计预期，按「本轮失败」处理（不覆盖缓存，等价于跳过清理）。 */
      if (pages >= MAX_PAGES) return Promise.reject(new Error('单表行数超过分页上限'));
      var to = from + PAGE - 1;
      pages++;
      return g.from(name).select('*').range(from, to).then(function (res) {
        if (res && res.error) throw res.error;
        var rows = (res && res.data) || [];
        acc = acc.concat(rows);
        if (rows.length < PAGE) return acc;      // 不满一页 = 已到末尾
        from += PAGE;
        return step();
      });
    }

    return step().then(function (rows) {
      cache[name] = rows;
      roundOk[name] = true;
      return true;
    }).catch(function () {
      return false;                              // 失败：cache 与 roundOk 均保持原样
    });
  }

  /**
   * 账号对齐：当前登录账号与缓存归属不一致时，先把别人的状态全部扔掉。
   *
   * 为什么必须有（BUG-1 的第二个成因）：缓存是模块级全局对象，换号后若不复位，
   * A 账号拉到的 students / classes 会被当成 B 账号的权威数据参与孤儿判定，
   * 而 class_members 是新拉的 —— 两边对不上，桥表行就被判成孤儿删掉。
   *
   * retry 队列在入队时已按账号落盘（见 saveRetry），所以清内存不丢数据；
   * 清完立刻把本账号上次没发出去的写操作读回来。
   * @returns {boolean} 是否发生了复位
   */
  function syncOwner() {
    var owner = currentOwner();
    if (!owner || owner === cacheOwner) return false;
    resetState();
    cacheOwner = owner;
    retryOwner = owner;
    loadRetry();
    return true;
  }

  /**
   * 全量拉取（last-write-wins，与成绩拉取同一语义）：
   * 账号对齐 → 清空本轮判定 → 逐表分页拉取（覆盖缓存）→ 孤儿清理 → 通知 + 重绘。
   *
   * **判定按轮次**（BUG-1 根因修复）：每轮开始时把 roundOk 清零，只有本轮真正拉成功的
   * 表才置 true，cleanOrphans 只认本轮结果。旧实现用 loaded「曾经成功过」，
   * 一旦某轮 students / classes 拉取失败，上一轮的旧快照就成了孤儿判定的依据。
   */
  function refreshAll() {
    if (!signedIn()) return Promise.resolve(false);
    syncOwner();
    Object.keys(roundOk).forEach(function (k) { delete roundOk[k]; });

    var names = Object.keys(defs);
    var chain = Promise.resolve();
    if (retry.length) chain = chain.then(function () { return flushRetry(); });   // 先把欠的写补上，再拉
    names.forEach(function (n) {
      chain = chain.then(function () { return fetchTable(n); });
    });
    return chain.then(function () {
      cleanOrphans(roundOk);
      emit('');
      repaint();
      return true;
    });
  }

  /**
   * 孤儿行清理：删学生/班级时应用层先删桥表再删主行（无事务），
   * 中途失败会留下 class_id / student_id 已不存在的桥表行，这里补偿清理。
   *
   * 三道闸门（BUG-1）：
   *   1. students / classes / class_members **三张表本轮都拉成功**才动手。
   *      缺任何一张，都无法区分「真的不存在」和「这一轮没拉到」。
   *   2. 主表本轮拉到 0 行而桥表非空 → 直接跳过（见下方注释）。
   *   3. 只删「确实查不到对端」的行，删除前用本轮的 stu / cls 集合判定。
   * @param {Object<string,boolean>} round 本轮各表拉取结果
   */
  function cleanOrphans(round) {
    var r = round || {};
    if (!r.students || !r.classes || !r.class_members) return;

    var members = cache.class_members || [];
    if (!members.length) return;

    var students = cache.students || [];
    var classes = cache.classes || [];

    /* 闸门 2：主表本轮返回空数组，而桥表有行 —— 两种可能无法区分：
       (a) 真的把学生/班级全删了，桥表行确实是孤儿；
       (b) 服务端过滤 / RLS / 分页异常让主表「看起来是空的」。
       删云端是不可撤销操作，误删一次数据就没了；跳过只是把清理推迟到下一个健康轮次，
       代价仅是几行僵尸数据（渲染时因对端缺失本就不显示）。**取「跳过」。** */
    if (!students.length || !classes.length) return;

    var stu = {}, cls = {};
    students.forEach(function (row) { stu[String(row.id)] = true; });
    classes.forEach(function (row) { cls[String(row.id)] = true; });

    var g;
    try { g = gateway(); } catch (e) { return; }
    members.forEach(function (m) {
      if (cls[String(m.class_id)] && stu[String(m.student_id)]) return;
      g.from('class_members').delete().eq('id', m.id).then(function (res) {
        if (res && res.error) return;             // 删除失败就留着，下一轮再试
        dropCache('class_members', m.id);
      }).catch(function () { });
    });
  }

  /**
   * 重放一条 insert。
   *
   * BUG-2 根因修复：原实现直接 `insert(payload)` 重放。students / classes /
   * class_members / contract_prices / contracts 有 uk_* 唯一索引，重放撞 23505 被兜住；
   * 但 customers / daily_tasks 按 PRD 故意**没有**唯一索引，同一条重放两次 = 云端两行。
   *
   * 现在：入队时已把客户端写死的 created_at 记在 item.createdAt 上，
   * 重放前先按它（+ 该表唯一键）回查一次 —— 上一次其实写成功了、只是响应/回执丢了，
   * 回查就能命中，直接收编进缓存并跳过写入。23505 分支保留为第二道保险。
   *
   * @returns {Promise<Object>} 命中时返回 { skipped:true, row }，否则走正常 insert 的返回
   */
  function replayInsert(g, item) {
    var def = defs[item.table] || { unique: [] };
    var stamp = item.createdAt || '';
    if (!stamp) return g.from(item.table).insert(item.payload).select();

    /* 幂等戳列名跟着表定义走（class_members 的戳是 joined_at，不是 created_at） */
    var stampCol = def.createdCol || 'created_at';
    var probe = g.from(item.table).select('*').eq(stampCol, stamp);
    (def.unique || []).forEach(function (col) {
      var v = item.payload ? item.payload[col] : undefined;
      if (v !== undefined && v !== null) probe = probe.eq(col, v);
    });

    return probe.then(function (res) {
      if (res && res.error) {
        /* 回查失败（表无 created_at 等）→ 不阻塞重放，退回直接写，靠 23505 兜底 */
        return g.from(item.table).insert(item.payload).select();
      }
      var hit = res && res.data && res.data[0];
      if (hit) return { skipped: true, row: hit };
      return g.from(item.table).insert(item.payload).select();
    });
  }

  /** 重放失败队列（online / visibilitychange / 定时 tick / 登录后触发） */
  function flushRetry() {
    if (!retry.length) return Promise.resolve(0);
    if (!signedIn()) return Promise.resolve(retry.length);
    var queue = retry.slice();
    /* 原地清空而不是 retry = []：App.DB.retry 导出的是这个数组**引用**，
       重新赋值会让外部（测试 / 调试面板）看到一份永远不变的陈旧副本。 */
    retry.length = 0;
    var chain = Promise.resolve(0);
    queue.forEach(function (item) {
      chain = chain.then(function (fails) {
        var g;
        try { g = gateway(); } catch (e) {
          retry.push(item); return fails + 1;
        }
        var q;
        if (item.kind === 'insert') q = replayInsert(g, item);
        else if (item.kind === 'update') q = g.from(item.table).update(item.payload).eq('id', item.id).select();
        else q = g.from(item.table).delete().eq('id', item.id);
        return q.then(function (res) {
          if (res && res.skipped) {                     // 上次已写入：收编缓存，不重复写
            if (res.row) upsertCache(item.table, res.row);
            return fails;
          }
          if (res && res.error) {
            if (item.kind === 'insert' && isUniqueViolation(res.error)) return fails;   // 别人已写入，放弃重放
            retry.push(item);
            return fails + 1;
          }
          if (item.kind !== 'remove' && res && res.data && res.data[0]) upsertCache(item.table, res.data[0]);
          if (item.kind === 'remove') dropCache(item.table, item.id);
          return fails;
        }).catch(function () {
          retry.push(item);
          return fails + 1;
        });
      });
    });
    return chain.then(function (fails) {
      saveRetry();                                      // 队列变化立刻落盘
      if (fails > 0) failToast(); else repaint();
      return fails;
    });
  }

  /** 监听变更（模块可在 mount 时订阅，避免每次整页重绘） */
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  /**
   * 启动拉取循环：登录成功后由 app.js 调用一次。
   * 三个触发点与 sync.js 现有实现对齐（45s 定时 / visibilitychange / online），
   * 但用独立计时器，不侵入 sync.js 的任何代码。
   */
  function start() {
    if (started) return;
    started = true;
    syncOwner();          // 登录后先对齐账号，再补发队列、再拉全量
    if (typeof setInterval === 'function') {
      timer = setInterval(function () {
        flushRetry();
        refreshAll();
      }, REFRESH_MS);
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { flushRetry(); refreshAll(); }
      });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', function () { flushRetry(); refreshAll(); });
    }
    flushRetry();
    refreshAll();
  }

  /**
   * 停止拉取循环。
   * 登出时必须把缓存与本轮判定复位（BUG-1 成因二）：否则下一个人在同一浏览器登录，
   * 会拿着上一个人的缓存当权威数据参与孤儿判定。retry 队列已按账号落盘，清内存不丢。
   */
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    started = false;
    resetState();
  }

  /* =========================================================
   * 7 张新表的集中注册（全 adminOnly；成绩/账号表禁止注册）
   * ========================================================= */
  define('students', { module: 'students', unique: ['stu_name', 'school', 'grade'], label: '学生' });
  define('classes', { module: 'classes', unique: ['class_name'], label: '班级' });
  define('class_members', {
    module: 'classes', unique: ['class_id', 'student_id'], label: '班级学生',
    /* 实表只有 joined_at（default now()），既无 created_at 也无 updated_at ——
       写 updated_at 会被 PostgREST 判 42703。幂等戳改用 joined_at。 */
    createdCol: 'joined_at', updatedCol: ''
  });
  define('customers', { module: 'customers', unique: [], label: '客户' });
  define('daily_tasks', { module: 'tasks', unique: [], label: '待办' });
  /* T9：价目由「年份×年级×阶段×方案」细粒度行改为「一方案一行」，唯一键随之改为
     年份 + 年级 + 方案名称（云端 uk_prices_key 与之一致） */
  define('contract_prices', { module: 'contracts', unique: ['year', 'grade', 'plan_name'], label: '价目方案' });
  define('contracts', { module: 'contracts', unique: ['stu_name', 'grade'], label: '合同' });

  App.DB = {
    cache: cache,
    defs: defs,
    retry: retry,
    define: define,
    table: table,
    refreshAll: refreshAll,
    flushRetry: flushRetry,
    onChange: onChange,
    start: start,
    stop: stop,
    /** 供测试与调试：**本轮**各表是否拉取成功（每轮开始时清零） */
    roundOk: roundOk,
    /** 供测试与调试：立即复位缓存 / 本轮判定 / 内存队列 */
    reset: resetState
  };
})(window.App);
