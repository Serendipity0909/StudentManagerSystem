/* =========================================================
 * core.js —— 内核：存储 / 工具 / 成绩算法 / 模块注册
 * 新增业务模块时，只需调用 App.registerModule(...) 即可。
 * ========================================================= */
(function (global) {
  'use strict';

  /* 复合键的分隔符（控制字符，不会出现在姓名/学校/班级/考试名里） */
  var SEP = '\u0001';

  /* ---------- 常量 ----------
   * 计分口径按高考 6 科制：
   *   必考（语数英）各 150 分，及格 90；选考（理化政史地生）各 100 分，及格 60。
   *   满配 = 语数英 + 3 门选科 = 750 分，及格线 = 750 × 60% = 450 分。
   * 注意：750 / 450 只是「满配基准」，供文案引用；
   *   实际分析与排名一律使用 Score.fields()/fullTotal()/passTotal() 得到的动态值，
   *   因为学生选科门数不同（只填语数英 → 满分 450，及格线 270）。
   */
  var K = {
    NUM_SUBJECTS: 9,
    SUBJECTS: ['语文', '数学', '英语', '物理', '化学', '政治', '历史', '地理', '生物'],
    SUBJECT_FULL: [150, 150, 150, 100, 100, 100, 100, 100, 100],
    SUBJECT_PASS: [90, 90, 90, 60, 60, 60, 60, 60, 60],
    CORE_IDX: [0, 1, 2],              // 必考：语文 / 数学 / 英语
    ELECTIVE_IDX: [3, 4, 5, 6, 7, 8], // 选考：物理 化学 政治 历史 地理 生物
    ELECTIVE_MAX: 3,                  // 最多计入 3 门选科（超出按分数最高取 3 门）
    FULL_TOTAL: 750,                  // 满配（6 科）满分，仅供文案引用
    PASS_TOTAL: 450,                  // 满配及格线 = 750 × 60%，仅供文案引用
    PASS_RATE: 0.6,
    PASS_SCORE: 60,      // 兼容保留：不再用于单科及格判定，判定统一走 Score.lineFor
    TIER_GOOD: 0.75,     // 优势科目：得分率 ≥ 75%
    TIER_WEAK: 0.60      // 薄弱科目：得分率 < 60%
  };

  /* ---------- 存储层（纯云端模式：数据只保留在内存，不写本机） ----------
   * 内存只是当前工作副本，唯一权威副本在云端数据库。
   * 每次 save() 都会触发 afterSave 钩子 → 同步层立即写穿到云端；
   * 传入 silent=true 表示「这次变更来自云端拉取，不需要再回传」。
   */
  var LEGACY_DB_KEY = 'student_mgmt_db_v1';

  var Store = {
    data: null,

    /** 变更钩子：让同步层在数据变更后接管，业务代码无需感知 */
    hooks: { afterSave: [], afterInit: [] },
    fire: function (name) {
      var list = this.hooks[name] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i](this.data); } catch (e) { if (console && console.error) console.error(e); }
      }
    },

    blank: function () {
      return {
        version: 1,
        createdAt: new Date().toISOString(),
        // 成绩模块数据：一行 = 一名学生一次考试
        records: [],
        modules: {},          // 预留给后续模块（档案/考勤/课表…）
        meta: { lastModified: null },
        // 已删除、等待从云端移除的唯一键（姓名+学校+班级+考试），仅保存在内存中
        deletedKeys: []
      };
    },

    init: function () {
      // 清掉历史版本留在本机的成绩数据缓存：纯云端模式下不保留本机副本
      try { global.localStorage.removeItem(LEGACY_DB_KEY); } catch (e) { }
      this.data = this.blank();
      return this.data;
    },

    save: function (silent) {
      this.data.meta.lastModified = new Date().toISOString();
      // 不再写 localStorage：内存更新后直接由同步层写穿到云端
      if (!silent) this.fire('afterSave');
      return true;
    },

    /** 用外部数据整体替换（仅内存），替换后照常触发写穿 */
    replace: function (obj) {
      if (obj && Array.isArray(obj.records)) this.data.records = obj.records;
      if (obj && obj.modules) this.data.modules = obj.modules;
      this.save();
    },

    /** 云端用量估算：一条记录（9 科分数 + 9 科排名 + 索引）约 1 KB */
    usageKB: function () {
      return (this.data.records || []).length;
    }
  };

  /* ---------- 工具 ---------- */
  var U = {
    uid: function () {
      return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    },
    esc: function (s) {
      return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    /** 一位小数，去尾零 */
    f1: function (n) {
      return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
    },
    nowStr: function () {
      var d = new Date(), p = function (x) { return x < 10 ? '0' + x : '' + x; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    },
    dateStr: function (ts) {
      if (!ts) return '-';
      var d = ts instanceof Date ? ts : new Date(ts);
      if (isNaN(d.getTime())) return '-';
      var p = function (x) { return x < 10 ? '0' + x : '' + x; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
    hms: function (iso) {
      if (!iso) return '-';
      var d = new Date(iso);
      if (isNaN(d)) return '-';
      var p = function (x) { return x < 10 ? '0' + x : '' + x; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    zh: function (a, b) {
      return String(a).localeCompare(String(b), 'zh-Hans-CN');
    },
    download: function (filename, blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 300);
    },
    debounce: function (fn, ms) {
      var t; return function () {
        var self = this, args = arguments;
        clearTimeout(t); t = setTimeout(function () { fn.apply(self, args); }, ms || 200);
      };
    },
    /**
     * 输入框「输入法安全」绑定：拼音/五笔等组合输入期间（尚未选词上屏）不触发回调，
     * 只在汉字确定上屏（compositionend）或用户已提交的输入（change/回车）后执行。
     * 回调收到的是输入框最终文本，避免拿 "zhang" "zhangs" 这类拼音中间态去搜索。
     */
    onCommitted: function (el, handler, delay) {
      if (!el) return;
      var composing = false, skipNext = false;
      var soft = delay ? U.debounce(handler, delay) : handler;
      function run() { handler(el.value); }
      el.addEventListener('compositionstart', function () { composing = true; });
      el.addEventListener('compositionupdate', function () { composing = true; });
      el.addEventListener('compositionend', function () {
        composing = false;
        skipNext = true;          // 随后浏览器补发的 input 事件不再重复触发
        run();                    // 拼音转汉字后按最终文本匹配
      });
      el.addEventListener('input', function () {
        if (composing) return;    // 组合输入中间态：忽略
        if (skipNext) { skipNext = false; return; }
        soft(el.value);
      });
      el.addEventListener('change', function () { composing = false; run(); });
      el.addEventListener('blur', function () { if (!composing) run(); });
    },
    /** 密码强度校验：6 位以上且必须同时含字母与数字 */
    checkPassword: function (p) {
      p = String(p || '');
      if (p.length < 6) return '密码长度不能少于 6 位';
      if (!/[A-Za-z]/.test(p)) return '密码必须包含字母';
      if (!/\d/.test(p)) return '密码必须包含数字';
      return '';
    }
  };

  /* ---------- 提示条 ---------- */
  function Toast(msg, type, ms) {
    var box = document.getElementById('toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-box';
      box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:200;display:flex;' +
        'flex-direction:column;gap:8px;align-items:flex-end';
      document.body.appendChild(box);
    }
    var bg = type === 'error' ? '#c0392b' : (type === 'warn' ? '#c8892e' : '#2f7c62');
    var el = document.createElement('div');
    el.style.cssText = 'background:' + bg + ';color:#fff;padding:10px 16px;border-radius:9px;' +
      'font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.18);max-width:420px;line-height:1.6';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s'; el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 320);
    }, ms || 2600);
  }

  /* ---------- 模态框 ---------- */
  var Modal = {
    open: function (opts) {
      var root = document.getElementById('modal-root');
      var mask = document.createElement('div');
      mask.className = 'mask';
      mask.innerHTML =
        '<div class="modal">' +
        '  <header><h3>' + U.esc(opts.title) + '</h3>' +
        '    <button class="ghost" data-close style="font-size:18px;line-height:1;padding:2px 8px">&times;</button></header>' +
        '  <div class="body"></div>' +
        '  <footer>' +
        '    <button data-close class="' + (opts.hideCancel ? '' : '') + '">' + U.esc(opts.cancelText || '取消') + '</button>' +
        (opts.okText === null ? '' : '    <button class="primary" data-ok>' + U.esc(opts.okText || '确定') + '</button>') +
        '  </footer>' +
        '</div>';
      // okText 为 null 时根本没有渲染确定按钮，此处要做存在性判断
      var cancelBtn = mask.querySelector('footer [data-close]');
      var okBtn = mask.querySelector('[data-ok]');
      if (opts.hideCancel && cancelBtn) cancelBtn.style.display = 'none';
      if (opts.okText === null && okBtn) okBtn.style.display = 'none';
      var body = mask.querySelector('.body');
      body.appendChild(opts.body);

      function close() { mask.remove(); if (opts.onClose) { try { opts.onClose(); } catch (e) { } } }
      mask.addEventListener('click', function (e) {
        if (e.target === mask || e.target.hasAttribute('data-close')) close();
      });
      var okEl = mask.querySelector('[data-ok]');
      if (okEl) okEl.addEventListener('click', function () {
        if (!opts.onOk || opts.onOk(mask) !== false) close();
      });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      });
      root.appendChild(mask);
      if (opts.focus) { var t = mask.querySelector(opts.focus); if (t) t.focus(); }
      return mask;
    },
    confirm: function (msg, onOk, danger) {
      var el = document.createElement('div');
      el.innerHTML = '<div style="font-size:13.5px;line-height:1.8">' + msg + '</div>';
      return Modal.open({
        title: '确认操作', body: el, okText: danger ? '确认删除' : '确定',
        cancelText: '取消', onOk: onOk
      });
    }
  };

  /* =========================================================
   * 成绩算法（完全复刻原 VBA 的业务口径）
   * ========================================================= */
  var Score = {
    /** 一条空记录 */
    newRecord: function () {
      var s = [], r = [];
      for (var i = 0; i < K.NUM_SUBJECTS; i++) { s.push(0); r.push(0); }
      return {
        id: U.uid(), name: '', school: '', cls: '', exam: '',
        scores: s, ranks: r, totalRank: 0, ts: new Date().toISOString()
      };
    },

    SEP: SEP,

    key: function (rec) {
      return [rec.name, rec.school, rec.cls, rec.exam].join(SEP);
    },

    /**
     * 待删除队列条目：业务键 + 云端主键。
     * 编辑把业务键改掉之后，只按业务键删会删空（云端那行的键已经被改成新的了），
     * 带上云端主键才能保证删到的还是原来那一行。
     */
    delKey: function (rec) {
      return Score.key(rec) + (rec._cid ? SEP + rec._cid : '');
    },

    /**
     * 动态选科识别：由数据自动判断该生「计入了哪几科」。
     *
     * 规则：
     *   1. 语数英（core）：有分即计入（必考）；
     *   2. 选考科目（elective）：有分的计入；超过 3 门时取分数最高的 3 门
     *      （同分按 物理→化学→政治→历史→地理→生物 的固定顺序，即下标升序）；
     *   3. 未收集到的科目（0 分 / 未填）**不计入分母**，即不拉低得分率。
     *
     * @param {Object} rec 成绩记录（只需 scores 数组，可传临时对象）
     * @returns {{core:number[],elective:number[],all:number[],full:number,pass:number,
     *            coreCount:number,electiveCount:number,complete:boolean,overflow:boolean,
     *            missingCore:string[],dropped:string[],droppedIdx:number[],electivePool:Object[]}}
     */
    fields: function (rec) {
      var s = (rec && rec.scores) || [];
      var i, v, core = [], pool = [], elective = [];
      for (i = 0; i < K.CORE_IDX.length; i++) {
        if ((Number(s[K.CORE_IDX[i]]) || 0) > 0) core.push(K.CORE_IDX[i]);
      }
      for (i = 0; i < K.ELECTIVE_IDX.length; i++) {
        v = Number(s[K.ELECTIVE_IDX[i]]) || 0;
        if (v > 0) pool.push({ idx: K.ELECTIVE_IDX[i], score: v });
      }
      /* 分数高的优先；同分按下标（物理→…→生物）固定顺序，保证结果稳定可复现 */
      pool.sort(function (a, b) { return (b.score - a.score) || (a.idx - b.idx); });
      for (i = 0; i < pool.length && i < K.ELECTIVE_MAX; i++) {
        elective.push(pool[i].idx);
      }
      elective.sort(function (a, b) { return a - b; });   // 展示/累加统一按科目固定顺序

      var all = core.concat(elective);
      all.sort(function (a, b) { return a - b; });

      var full = 0;
      for (i = 0; i < all.length; i++) full += K.SUBJECT_FULL[all[i]];

      var missingCore = [];
      for (i = 0; i < K.CORE_IDX.length; i++) {
        if ((Number(s[K.CORE_IDX[i]]) || 0) <= 0) missingCore.push(K.SUBJECTS[K.CORE_IDX[i]]);
      }

      var droppedIdx = [], dropped = [];
      for (i = K.ELECTIVE_MAX; i < pool.length; i++) {
        droppedIdx.push(pool[i].idx);
        dropped.push(K.SUBJECTS[pool[i].idx]);
      }

      return {
        core: core,
        elective: elective,
        all: all,
        full: full,
        pass: Math.round(full * K.PASS_RATE),
        coreCount: core.length,
        electiveCount: elective.length,
        complete: core.length === K.CORE_IDX.length && elective.length === K.ELECTIVE_MAX,
        overflow: pool.length > K.ELECTIVE_MAX,
        missingCore: missingCore,
        dropped: dropped,
        droppedIdx: droppedIdx,
        electivePool: pool
      };
    },

    /** 动态满分：只累加「已计入科目」的满分（6 科 750 / 3 科 450 / 无成绩 0） */
    fullTotal: function (rec) {
      return Score.fields(rec).full;
    },

    /** 动态及格线：round(动态满分 × 60%)（满配 450 / 仅语数英 270） */
    passTotal: function (rec) {
      return Score.fields(rec).pass;
    },

    /**
     * 总分 = 已计入科目分数之和。
     * 语义变更（旧版为 9 科直接相加）：未计入的科目（缺考 / 未选 / 超 3 门被舍弃）不加分，
     * 因此分母也同步收窄，得分率才是跨选科组合可比的指标。
     */
    total: function (rec) {
      var f = Score.fields(rec);
      var s = (rec && rec.scores) || [], t = 0;
      for (var i = 0; i < f.all.length; i++) t += Number(s[f.all[i]]) || 0;
      return t;
    },

    /** 得分率 = 总分 / 动态满分，clamp 到 0..1（无成绩返回 0） */
    totalRate: function (rec) {
      var full = Score.fullTotal(rec);
      var t = Score.total(rec);
      if (!(full > 0)) return 0;
      var r = t / full;
      if (r < 0) r = 0;
      if (r > 1) r = 1;
      return r;
    },

    /**
     * 单科满分：语数英 150，其余六科 100。
     * 'total' 返回「满配基准」750（仅供文案引用，动态值请用 Score.fullTotal(rec)）。
     * @param {number|string} i 科目下标 0..8 或 'total'
     */
    fullOf: function (i) {
      if (i === 'total') return K.FULL_TOTAL;
      var n = Number(i);
      return (n >= 0 && n < K.NUM_SUBJECTS) ? K.SUBJECT_FULL[n] : K.FULL_TOTAL;
    },

    /** 单科及格线：语数英 90，其余 60；'total' 返回满配基准 450（动态值用 Score.passTotal(rec)） */
    passOf: function (i) {
      if (i === 'total') return K.PASS_TOTAL;
      var n = Number(i);
      return (n >= 0 && n < K.NUM_SUBJECTS) ? K.SUBJECT_PASS[n] : K.PASS_TOTAL;
    },

    /** 得分率 = 得分 / 满分，统一 clamp 到 0..1（缺考 0 分返回 0） */
    rateOf: function (score, i) {
      var full = Score.fullOf(i);
      var s = Number(score) || 0;
      if (!(full > 0)) return 0;
      var r = s / full;
      if (r < 0) r = 0;
      if (r > 1) r = 1;
      return r;
    },

    /** 及格线（列口径）：'total' → 450（满配基准），科目 → 90/60 */
    lineFor: function (col) {
      return Score.passOf(col);
    },

    /**
     * 从班级字段里取届别：与 locator 旧实现完全一致（去空白 → 匹配「NN届」），
     * 抽不到时返回 trim 后的原值。
     * @param {string} cls 记录的班级字段（如「28届」「28届高三3班」）
     * @returns {string}
     */
    gradeOf: function (cls) {
      var s = String(cls || '').replace(/\s|\u3000/g, '');
      var m = s.match(/(\d{1,2})届/);
      return m ? (m[1] + '届') : String(cls || '').trim();
    },

    /**
     * 年级池：同校 + 同届（Score.gradeOf）+ 同考试的全部记录（跨班级合并）。
     * @param {Array} rows 全量记录
     * @param {Object} ref 参照记录（取 school / cls / exam）
     * @returns {Array}
     */
    gradePool: function (rows, ref) {
      var list = rows || [];
      ref = ref || {};
      var school = String(ref.school || '');
      var exam = String(ref.exam || '');
      var grade = Score.gradeOf(ref.cls);
      return list.filter(function (r) {
        return String(r.school || '') === school &&
          String(r.exam || '') === exam &&
          Score.gradeOf(r.cls) === grade;
      });
    },

    /**
     * 按「得分率」排名（总分口径唯一可比的跨组合指标）。
     * 得分率相同再比绝对分（满分更高的组合绝对值通常更大），避免同分率混并列。
     * @param {Array} pool 名次池
     * @param {Object} ref 参照记录
     * @returns {{rank:number,total:number,valid:boolean}}
     *   valid 仅在 ref 有任一分且动态满分 > 0 时为 true
     */
    rankByRate: function (pool, ref) {
      var rows = pool || [];
      var myFull = Score.fullTotal(ref || {});
      var myTotal = Score.total(ref || {});
      var myRate = myFull > 0 ? Math.min(1, myTotal / myFull) : 0;   // 得分率上限 100%
      /* 率同再比绝对分时，比较基准同样按动态满分截断：
         否则超满分脏数据（780/750）会以未截断的绝对分把合法满分生（750/750）挤到第 2 名 */
      var myCmp = (myFull > 0 && myTotal > myFull) ? myFull : myTotal;
      var total = 0, higher = 0, i;
      for (i = 0; i < rows.length; i++) {
        var f = Score.fullTotal(rows[i]);
        var t = Score.total(rows[i]);
        if (!(f > 0) || !(t > 0)) continue;
        total++;
        var r = Math.min(1, t / f);           // 超满分脏数据不得以 104% 越位
        var tc = t > f ? f : t;               // 对称：率相同也按截断后的绝对分比较
        if (r > myRate + 1e-9) higher++;
        else if (Math.abs(r - myRate) <= 1e-9 && tc > myCmp) higher++;
      }
      if (!(myFull > 0) || !(myTotal > 0)) return { rank: 0, total: total, valid: false };
      return { rank: higher + 1, total: total, valid: true };
    },

    /**
     * 在给定池子里按某列排名。
     * 'total' 走得分率排名（不同学生满分不同，直接比绝对分不成立）；
     * 单科仍按分数排名，只统计该列 > 0 的记录。
     * @param {Array} pool 名次池
     * @param {Object} ref 参照记录
     * @param {number|string} col 0..8 或 'total'
     * @returns {{rank:number,total:number,mine:number,valid:boolean}}
     */
    rankOf: function (pool, ref, col) {
      var rows = pool || [];
      if (col === 'total') {
        var rr = Score.rankByRate(rows, ref);
        return { rank: rr.rank, total: rr.total, mine: Score.total(ref || {}), valid: rr.valid };
      }
      var valOf = function (r) {
        return Number(r.scores && r.scores[col]) || 0;
      };
      var mine = valOf(ref || {});
      var total = 0, higher = 0;
      for (var i = 0; i < rows.length; i++) {
        var v = valOf(rows[i]);
        if (v > 0) {
          total++;
          if (v > mine) higher++;
        }
      }
      if (!(mine > 0)) return { rank: 0, total: total, mine: mine, valid: false };
      return { rank: higher + 1, total: total, mine: mine, valid: true };
    },

    /**
     * 百分位：排名 / 总人数 * 100，保留 1 位小数（3.2 表示前 3.2%）。
     * 人数或排名无效、或「排名 > 人数」（口径不一致）时返回 0；
     * 0 一律视为「不可计算」，由调用方输出 pctInvalid 提示，禁止出现「前 120%」。
     */
    pctOf: function (rank, total) {
      var r = Number(rank) || 0, t = Number(total) || 0;
      if (!(r > 0) || !(t > 0)) return 0;
      if (r > t) return 0;
      return Math.round(r / t * 1000) / 10;
    },

    /**
     * 总表排序 —— 对应 SortMasterSheetEx：
     * 1) 每个「学校|班级|考试」取最早录入时间；
     * 2) 在「学校|班级」内按该时间先后编出考试序号；
     * 3) 再按 学校↑ → 班级↑ → 考试序号↑ → 总分↓ → 姓名↑ 排序。
     */
    sort: function (list) {
      var arr = list.slice();
      var examTs = {}, order = {}, i, k, sc;
      for (i = 0; i < arr.length; i++) {
        k = [arr[i].school, arr[i].cls, arr[i].exam].join('|');
        var t = new Date(arr[i].ts || 0).getTime();
        if (!(k in examTs) || t < examTs[k]) examTs[k] = t;
      }
      var bySc = {};
      for (k in examTs) {
        sc = k.split('|').slice(0, 2).join('|');
        (bySc[sc] = bySc[sc] || []).push(k);
      }
      for (sc in bySc) {
        bySc[sc].sort(function (a, b) { return examTs[a] - examTs[b]; });
        for (i = 0; i < bySc[sc].length; i++) order[bySc[sc][i]] = i + 1;
      }
      arr.sort(function (a, b) {
        var ka = [a.school, a.cls, a.exam].join('|'), kb = [b.school, b.cls, b.exam].join('|');
        /* 同一考试内按得分率降序（选科门数不同，绝对分不可直接比较），率相同再比绝对分 */
        return U.zh(a.school, b.school) || U.zh(a.cls, b.cls) ||
          (order[ka] - order[kb]) ||
          (Score.totalRate(b) - Score.totalRate(a)) ||
          (Score.total(b) - Score.total(a)) || U.zh(a.name, b.name);
      });
      return arr;
    },

    /** 去重后的学校/班级/姓名/考试列表 */
    options: function (list) {
      var s = {}, c = {}, n = {}, e = {}, i;
      for (i = 0; i < list.length; i++) {
        s[list[i].school] = 1; c[list[i].cls] = 1; n[list[i].name] = 1; e[list[i].exam] = 1;
      }
      var toArr = function (o) { return Object.keys(o).sort(U.zh); };
      return { schools: toArr(s), classes: toArr(c), names: toArr(n), exams: toArr(e) };
    },

    /** 按条件取子集 */
    filter: function (list, cond) {
      return list.filter(function (r) {
        for (var k in cond) {
          if (cond[k] && String(r[k] || '') !== String(cond[k])) return false;
        }
        return true;
      });
    },

    /**
     * 单科/总分统计：只统计 >0 的分数（0 = 缺考不参与）。
     * col: 0..8 科目下标，'total' 表示总分
     * 总分列的满分/及格线是**逐生动态**的（选科门数不同），因此：
     *   full/line 返回样本内动态满分的均值（line = round(avgFull × 60%)），
     *   并额外返回 avgFull 供调用方展示；单科列依旧是固定满分/及格线。
     * passCount / avgRate 均按每条记录自己的满分与及格线判定。
     */
    stat: function (rows, col) {
      var list = rows || [];
      var isTotal = col === 'total';
      var singleFull = isTotal ? 0 : Score.fullOf(col);
      var singleLine = isTotal ? 0 : Score.lineFor(col);
      var n = 0, sum = 0, mx = null, mn = null, pass = 0, rateSum = 0, fullSum = 0;

      for (var i = 0; i < list.length; i++) {
        var rec = list[i] || {};
        var v, full, line;
        if (isTotal) {
          full = Score.fullTotal(rec);
          v = Score.total(rec);
          line = Score.passTotal(rec);
        } else {
          full = singleFull;
          line = singleLine;
          v = Number(rec.scores && rec.scores[col]) || 0;
        }
        if (!(v > 0) || !(full > 0)) continue;
        n++; sum += v;
        if (mx === null || v > mx) mx = v;
        if (mn === null || v < mn) mn = v;
        if (v >= line) pass++;
        /* 得分率 clamp 到 0..1：单科超满分的脏数据不能把平均得分率推过 100% */
        rateSum += v >= full ? 1 : v / full;
        fullSum += full;
      }

      var avgFull = n ? fullSum / n : 0;
      return {
        count: n, avg: n ? sum / n : 0, max: mx, min: mn,
        passRate: n ? pass / n * 100 : 0,
        passCount: pass,                 // 及格人数（按各自及格线判定）
        avgRate: n ? rateSum / n : 0,    // 平均得分率（0..1）
        full: isTotal ? avgFull : singleFull,           // 总分列 = 样本内动态满分均值
        line: isTotal ? Math.round(avgFull * K.PASS_RATE) : singleLine,
        avgFull: avgFull                 // 样本内动态满分的均值（总分列专用）
      };
    },

    /** 单科历史趋势 —— 对应 AnalyzeSubjectHistory */
    history: function (rows, subjIdx, currentScore) {
      if (rows.length < 2) return { desc: '首次考试', conclusion: '暂无历史数据' };
      var h = [], i, desc = [];
      for (i = 0; i < rows.length; i++) {
        h.push(Number(rows[i].scores[subjIdx]) || 0);
        desc.push(rows[i].exam + ':' + h[i]);
      }
      var totalChange = h[h.length - 1] - h[0];
      var up = 0, down = 0;
      for (i = 1; i < h.length; i++) {
        if (h[i] > h[i - 1] + 2) up++;
        else if (h[i] < h[i - 1] - 2) down++;
      }
      var c;
      if (up > down) {
        c = totalChange > 5 ? '稳步上升(+\u2191' + U.f1(totalChange) + ')' : '略有上升(+\u2191' + U.f1(totalChange) + ')';
      } else if (down > up) {
        c = totalChange < -5 ? '明显下滑(\u2193' + U.f1(Math.abs(totalChange)) + ')' : '略有下降(\u2193' + U.f1(Math.abs(totalChange)) + ')';
      } else {
        c = '基本持平(\u2192)';
      }
      return { desc: desc.join(' \u2192 '), conclusion: c, current: currentScore };
    },

    /**
     * 单科学习建议 —— 改为「得分率」分档，避免 150 分制下 90 分被当成优秀。
     * ≥90% 优秀 / ≥80% 良好 / ≥70% 中等 / ≥60% 刚过及格线 / 其余 待加强。
     * 仍保留「低于班均 5 分」「下滑趋势」两句追加。
     */
    advice: function (subjIdx, score, diff, trendDesc) {
      var nm = K.SUBJECTS[subjIdx];
      var r = Score.rateOf(score, subjIdx);
      var pct = Math.round(r * 100);
      var a;
      if (r >= 0.9) a = nm + '得分率 ' + pct + '%，处于优秀区间，建议做压轴题与跨章节综合题，向满分冲刺。';
      else if (r >= 0.8) a = nm + '得分率 ' + pct + '%，处于良好区间，基础扎实，可按题型做专项拔高，把中档题的错误率压到 5% 以内。';
      else if (r >= 0.7) a = nm + '得分率 ' + pct + '%，处于中等水平，先锁定高频考点，逐个题型清零。';
      else if (r >= 0.6) a = nm + '得分率 ' + pct + '%，刚过及格线，建议回归课本例题，把基础题的正确率稳定在 90% 以上。';
      else a = nm + '得分率 ' + pct + '%，属于待加强区间（低于及格线），建议从课本概念与公式入手，每天固定时段做单点突破。';
      if (diff < -5) a += '低于班级均分较多，需重点关注。';
      if (String(trendDesc || '').indexOf('下滑') >= 0 || String(trendDesc || '').indexOf('下降') >= 0) {
        a += '近期有下滑趋势，需及时调整学习方法。';
      }
      return a;
    },

    /**
     * 单科分数按该科满分截断（治本：脏数据不进 Store）。
     * 负数 → 0；超满分 → 满分；非数字 → 0。
     * @param {Object} rec 记录（就地修改 scores）
     * @returns {{rec:Object, clamped:Array<string>}} clamped 为被截断的科目名（供 toast 提示）
     */
    clampScores: function (rec) {
      var out = [], clamped = [];
      var s = (rec && rec.scores) || [];
      for (var i = 0; i < K.NUM_SUBJECTS; i++) {
        var cap = K.SUBJECT_FULL[i];
        var v = Number(s[i]);
        if (!isFinite(v)) v = 0;
        if (v < 0) v = 0;
        if (v > cap) {
          clamped.push(K.SUBJECTS[i]);
          v = cap;
        }
        out.push(v);
      }
      if (rec) rec.scores = out;
      return { rec: rec, clamped: clamped };
    },

    /**
     * 写入/更新（Upsert），返回 {mode:'new'|'update', record, clamped}。
     * 先按内存主键定位：编辑时把学校/班级/考试改掉，业务键就变了，
     * 只按业务键匹配会当成「新记录」在原记录之外再插一条。
     * 命中后必须继承云端主键 _cid，否则保存时会退化成 insert 再插一条。
     * 写入前统一按单科满分截断，保证 Store 里不存在超满分数据。
     */
    upsert: function (record) {
      var list = Store.data.records, i, idx = -1;
      var norm = Score.clampScores(record);          // 截断：脏数据进不了 Store
      var clamped = norm.clamped;
      var key = Score.key(record);
      record.mod = new Date().toISOString();      // 最后修改时间（ts 仍是原始录入时间，不能动）
      if (record.id) {
        for (i = 0; i < list.length; i++) {
          if (list[i].id === record.id) { idx = i; break; }
        }
      }
      if (idx < 0) {
        for (i = 0; i < list.length; i++) {
          if (Score.key(list[i]) === key) { idx = i; break; }
        }
      }
      if (idx >= 0) {
        record.id = list[idx].id;
        record.ts = list[idx].ts;                 // 保留原始录入时间，避免打乱考试顺序
        if (list[idx]._cid) record._cid = list[idx]._cid;   // 云端主键必须跟着走
        if (list[idx]._by) record._by = list[idx]._by;
        list[idx] = record;
        Store.save();
        return { mode: 'update', record: record, clamped: clamped };
      }
      record.ts = record.ts || record.mod;
      list.push(record);
      Store.save();
      return { mode: 'new', record: record, clamped: clamped };
    },

    remove: function (id) {
      var hit = null;
      for (var i = 0; i < Store.data.records.length; i++) {
        if (Store.data.records[i].id === id) { hit = Store.data.records[i]; break; }
      }
      Store.data.records = Store.data.records.filter(function (r) { return r.id !== id; });
      if (hit) {
        var k = Score.delKey(hit);
        Store.data.deletedKeys = Store.data.deletedKeys || [];
        if (Store.data.deletedKeys.indexOf(k) < 0) Store.data.deletedKeys.push(k);
      }
      Store.save();
    }
  };

  /* ---------- 模块注册表 ---------- */
  var modules = [];
  var App = {
    K: K, U: U, Store: Store, Score: Score, Toast: Toast, Modal: Modal, Chart: null, X: null,
    modules: modules,
    registerModule: function (m) {
      // 归一化导航字段（只补默认值，不触碰任何成绩算法）：
      //   order 导航排序（home:0 / score:5 / 业务模块 10-50 / users:90 / 默认 100）
      //   teacherOnly 教师专属（成绩管理）、adminOnly 显式布尔化
      if (m.order === null || m.order === undefined) m.order = 100;
      m.teacherOnly = !!m.teacherOnly;
      m.adminOnly = !!m.adminOnly;
      modules.push(m);
      return m;
    },
    render: function () { /* 由 app.js 覆盖 */ }
  };

  global.App = App;
})(window);
