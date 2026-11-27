/* =========================================================
 * tools/qa-v4-ui.js —— v4 UI / CRUD 层独立验收套件（R4 本地测试）
 *   TZ=Asia/Shanghai node tools/qa-v4-ui.js
 *
 * 被测真实实现：js/module-customers.js（三分支 render/bind、意向程度展示面、
 *   Tab③ 新增/编辑/详情/删除、条件联动），协作者 core.js / db.js / perm.js /
 *   ui-kit.js 全部按 index.html 顺序加载真实源码。
 *
 * 夹具（不 stub 被测函数本身）：
 *   · 假 App.DB.table(name)：内存数组 + 同步 resolved Promise + 触发 App.render 计数；
 *   · 假 App.Modal / App.Toast / App.render / App.Sync（真实 App.Perm 由假 Sync 驱动）；
 *   · 轻量 DOM 桩件：innerHTML 正则解析出【树形】元素（保留 data-srow 与其内部
 *     input 的父子关系），querySelector/querySelectorAll 支持 [data-...] / [name=x] /
 *     th[data-sort] / .cls / #id / 'input, select, textarea'，事件回调可真实 dispatch。
 *
 * 只在 vm 【内存中】给 module-customers.js 追加一行 `App.__state = state;`
 * 观测钩子（便于精确断言私有 state 的排序/筛选隔离），磁盘上的生产 js 零改动。
 *
 * 运行方式：TZ=Asia/Shanghai node tools/qa-v4-ui.js
 * 末行：=== 结果：PASS N / FAIL M ===   （FAIL>0 → exit 1）
 * ========================================================= */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'js');

/* ---------------- 断言框架（ok / eq / section） ---------------- */
let pass = 0, fail = 0;
const FAILS = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  FAILS.push(name + (detail === undefined ? '' : ' → ' + detail));
}
function eq(name, actual, expect) {
  ok(name, actual === expect,
    'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}
function eqArr(name, actual, expect) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expect),
    'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect));
}
function section(name) { console.log('\n=== ' + name + ' ==='); }
function has(name, html, needle) {
  ok(name, String(html).indexOf(needle) >= 0, 'missing=' + JSON.stringify(needle));
}
function hasNot(name, html, needle) {
  ok(name, String(html).indexOf(needle) < 0, 'unexpected=' + JSON.stringify(needle));
}
function occurrences(html, needle) {
  return String(html).split(needle).length - 1;
}

/* =========================================================
 * 1. 轻量 DOM 桩件
 * ========================================================= */
const VOID_TAGS = { input: 1, br: 1, hr: 1, img: 1, meta: 1, link: 1, source: 1,
  area: 1, base: 1, col: 1, embed: 1, param: 1, track: 1, wbr: 1 };

const domErrors = [];
const toasts = [];   /* 需在加载 module-customers.js 前就位：该文件在加载期捕获 App.Toast */

function El(tag) {
  this.tag = String(tag || '').toLowerCase();
  this.attrs = Object.create(null);
  this.children = [];
  this._parent = null;
  this._html = '';
  this._listeners = Object.create(null);
  this._value = '';              /* 无 value 属性元素的默认值 */
  this._valueOverride = undefined; /* setVal() / applyAttrs 写入后优先 */
  this.checked = false;
  this.disabled = false;
  this.hidden = false;
  this.selected = false;
  this.type = '';
  this.name = '';
  this.id = '';
  this.className = '';
  this.textContent = '';
  this._focused = false;
  this.style = { cssText: '', display: '' };
  this.classList = {
    add: (c) => { this.className += ' ' + c; },
    remove: () => { },
    toggle: () => { },
    contains: (c) => (' ' + this.className + ' ').indexOf(' ' + c + ' ') >= 0
  };
}

/* <select> 的 value 需由带 selected 的 <option> 推导（真实浏览器语义）。
   q('resource_type') / q('intent_level') 都靠它回显，否则编辑态会读成空串。 */
Object.defineProperty(El.prototype, 'value', {
  get: function () {
    if (this._valueOverride !== undefined) return this._valueOverride;
    if (this.tag === 'select') {
      const opts = [];
      (function walk(n) {
        n.children.forEach(function (c) { if (c.tag === 'option') opts.push(c); walk(c); });
      })(this);
      for (let i = opts.length - 1; i >= 0; i--) {
        if (opts[i].selected) return opts[i].getAttribute('value') || '';
      }
      return opts.length ? (opts[0].getAttribute('value') || '') : '';
    }
    return this._value;
  },
  set: function (v) { this._valueOverride = v; }
});

Object.defineProperty(El.prototype, 'innerHTML', {
  get: function () { return this._html; },
  set: function (html) {
    this._html = String(html === null || html === undefined ? '' : html);
    this.children = [];
    parseInto(this, this._html);
  }
});

/** 把一段 HTML 解析成【树】：保留 data-srow / form-grid / label 与内部 input 的父子关系 */
function parseInto(root, html) {
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)([^>]*)>/g;
  const stack = [root];
  let last = 0, m;
  const addText = (txt) => {
    if (!txt) return;
    const top = stack[stack.length - 1];
    top.textContent += txt;
  };
  while ((m = re.exec(html))) {
    if (m.index > last) addText(html.slice(last, m.index));
    if (m[1]) {                                   /* 结束标签：弹栈到匹配项 */
      const t = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === t) { stack.length = i; break; }
      }
    } else {                                      /* 开始标签 */
      const t = m[2].toLowerCase();
      const el = new El(t);
      applyAttrs(el, m[3] || '');
      stack[stack.length - 1].appendChild(el);
      const selfClose = /\/\s*$/.test(m[3] || '');
      if (!VOID_TAGS[t] && !selfClose) stack.push(el);
    }
    last = re.lastIndex;
  }
  if (last < html.length) addText(html.slice(last));
}

/** 属性串 → el.attrs + 常用 property（支持无引号值 / 无值布尔属性 / style 值含分号） */
function applyAttrs(el, s) {
  const re = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const k = m[1].toLowerCase();
    const v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    el.attrs[k] = v;
    if (k === 'value') el.value = v;
    else if (k === 'name') el.name = v;
    else if (k === 'type') el.type = v;
    else if (k === 'id') el.id = v;
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'checked') el.checked = true;
    else if (k === 'disabled') el.disabled = true;
    else if (k === 'selected') el.selected = true;
    else if (k === 'hidden') el.hidden = true;
    else if (k === 'placeholder') el.placeholder = v;
  }
}

El.prototype.setAttribute = function (k, v) {
  const key = String(k).toLowerCase(), val = String(v);
  this.attrs[key] = val;
  if (key === 'id') this.id = val;
  else if (key === 'name') this.name = val;
  else if (key === 'type') this.type = val;
  else if (key === 'value') this.value = val;
  else if (key === 'class') this.className = val;
  else if (key === 'style') this.style.cssText = val;
};
El.prototype.getAttribute = function (k) {
  const key = String(k).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(this.attrs, key)) return this.attrs[key];
  if (key in this) {
    const v = this[key];
    return (v === undefined || v === null || typeof v === 'function') ? null : String(v);
  }
  return null;
};
El.prototype.hasAttribute = function (k) {
  const key = String(k).toLowerCase();
  return Object.prototype.hasOwnProperty.call(this.attrs, key) || (key in this);
};
El.prototype.addEventListener = function (t, fn) {
  (this._listeners[t] = this._listeners[t] || []).push(fn);
};
El.prototype.removeEventListener = function (t, fn) {
  const a = this._listeners[t] || [];
  const i = a.indexOf(fn);
  if (i >= 0) a.splice(i, 1);
};
El.prototype.dispatch = function (t, evt) {
  (this._listeners[t] || []).slice().forEach(function (fn) {
    try { fn(evt || {}); } catch (e) { domErrors.push(t + ': ' + (e && e.message ? e.message : e)); }
  });
};
El.prototype.click = function () {
  this.dispatch('click', { target: this, preventDefault: function () { } });
};
El.prototype.focus = function () { this._focused = true; };
El.prototype.appendChild = function (c) {
  this.children.push(c); c._parent = this; return c;
};
El.prototype.insertBefore = function (c, anchor) {
  const i = anchor ? this.children.indexOf(anchor) : -1;
  if (i >= 0) { c._parent = this; this.children.splice(i, 0, c); }
  else this.appendChild(c);
  return c;
};
El.prototype.remove = function () {
  if (!this._parent) return;
  const i = this._parent.children.indexOf(this);
  if (i >= 0) this._parent.children.splice(i, 1);
};

/* ---- 选择器：tag / [attr] / [attr="v"] / [attr=v] / .cls / #id / 组合 / 逗号列表 ---- */
function attrVal(el, name) {
  if (Object.prototype.hasOwnProperty.call(el.attrs, name)) return el.attrs[name];
  if (name in el) {
    const v = el[name];
    return (v === undefined || v === null || typeof v === 'function') ? undefined : String(v);
  }
  return undefined;
}
function parseSimple(raw) {
  let s = String(raw).trim().split(/\s+/).pop() || '';
  const out = { tag: null, conds: [] };
  const tm = /^([a-zA-Z][\w-]*)/.exec(s);
  if (tm) { out.tag = tm[1].toLowerCase(); s = s.slice(tm[0].length); }
  const re = /(#([\w-]+))|(\.([\w-]+))|\[([^\]=]+?)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) out.conds.push({ kind: 'id', val: m[2] });
    else if (m[3]) out.conds.push({ kind: 'cls', val: m[4] });
    else {
      const name = m[5].trim().toLowerCase();
      const hasVal = m[6] !== undefined || m[7] !== undefined || m[8] !== undefined;
      const val = m[6] !== undefined ? m[6] : (m[7] !== undefined ? m[7] : m[8]);
      out.conds.push({ kind: 'attr', name: name, hasVal: hasVal, val: val });
    }
  }
  return out;
}
function matches(el, g) {
  if (g.tag && el.tag !== g.tag) return false;
  for (let i = 0; i < g.conds.length; i++) {
    const c = g.conds[i];
    if (c.kind === 'id') {
      if (el.id !== c.val && el.attrs.id !== c.val) return false;
    } else if (c.kind === 'cls') {
      if ((' ' + el.className + ' ').indexOf(' ' + c.val + ' ') < 0) return false;
    } else {
      const v = attrVal(el, c.name);
      if (v === undefined) return false;
      if (c.hasVal && v !== c.val) return false;
    }
  }
  return true;
}
El.prototype.querySelectorAll = function (sel) {
  const groups = String(sel).split(',').map(parseSimple);
  const out = [];
  (function walk(n) {
    n.children.forEach(function (c) { out.push(c); walk(c); });
  })(this);
  return out.filter(function (el) { return groups.some(function (g) { return matches(el, g); }); });
};
El.prototype.querySelector = function (sel) {
  return this.querySelectorAll(sel)[0] || null;
};

const documentStub = {
  createElement: function (t) { return new El(t); },
  createElementNS: function (ns, t) { return new El(t); },
  getElementById: function (id) { const e = new El('div'); e.id = id; return e; },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  addEventListener: function () { },
  removeEventListener: function () { },
  body: new El('body')
};

/* =========================================================
 * 2. vm 沙箱：按 index.html 顺序加载真实源码
 * ========================================================= */
const sandbox = {
  console: console,
  document: documentStub,
  localStorage: { getItem: () => null, setItem: () => { }, removeItem: () => { } },
  setTimeout: function () { return 0; },
  clearTimeout: function () { },
  location: { hash: '' },
  URL: { createObjectURL: () => '', revokeObjectURL: () => { } }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

const LOAD = ['core.js', 'db.js', 'perm.js', 'ui-kit.js', 'module-customers.js'];
const RAW_SRC = {};
LOAD.forEach(function (f) {
  let src = fs.readFileSync(path.join(SRC, f), 'utf8');
  RAW_SRC[f] = src;
  if (f === 'module-customers.js') {
    /* 仅内存注入：暴露私有 state 引用，供 V-D6/D7 精确断言排序/筛选隔离 */
    const st = src.indexOf('  var state = {');
    const end = src.indexOf('\n  };', st) + '\n  };'.length;
    if (st < 0 || end < '\n  };'.length) throw new Error('无法定位 state 定义，拒绝注入观测钩子');
    src = src.slice(0, end) + '\n  App.__state = state;' + src.slice(end);
  }
  vm.runInContext(src, sandbox, { filename: f });
  if (f === 'core.js') {
    /* module-customers.js 第 30 行 `var Toast = App.Toast;` 在加载期捕获引用，
       必须在它加载之前把 Toast 换成收集器，否则 toast 断言取不到文案。 */
    sandbox.App.Toast = function (msg, type, ms) { toasts.push({ msg: msg, type: type }); };
  }
});

const App = sandbox.App;
const UI = App.UI;
const U = App.U;
const MC_SRC = RAW_SRC['module-customers.js'];
const UK_SRC = RAW_SRC['ui-kit.js'];
const DB_SRC = RAW_SRC['db.js'];

/* 捕获模块对象（真实 App.registerModule 已 push 进 App.modules） */
const mod = (App.modules || []).filter(function (m) { return m.id === 'customers'; })[0];
ok('customers 模块已注册且含 render/bind', !!(mod && mod.render && mod.bind));
ok('内存观测钩子已拿到私有 state', !!(App.__state && App.__state.stopFilters && 'stopSortKey' in App.__state));

/* ---------------- 假协作者 ---------------- */
let role = 'admin', readonly = false;
App.Sync = {
  state: { signedIn: true, profile: {} },
  isAdmin: function () { return role === 'admin'; },
  canEdit: function () { return !readonly; },
  me: function () { return '管理员'; },
  profile: function () { return { status: readonly ? 'readonly' : 'active' }; },
  db: function () { return { database: {} }; }
};
App.Store.init();

let renderCount = 0;
App.render = function () { renderCount++; };

const modalCalls = [], confirmCalls = [];
App.Modal = {
  /* 复刻真实 Modal.open 对 onOk 返回值的判定：!== false 才 close() */
  open: function (opts) {
    const mask = { removed: false, remove: function () { this.removed = true; } };
    opts._mask = mask;
    opts._triggerOk = function () {
      const r = opts.onOk ? opts.onOk(mask) : true;
      if (r !== false) mask.remove();
      return r;
    };
    modalCalls.push(opts);
    return mask;
  },
  confirm: function (html, onOk, danger) {
    confirmCalls.push({ html: html, onOk: onOk, danger: danger });
    return { remove: function () { } };
  }
};

/* 假 App.DB.table：内存数组 + 同步 resolved Promise + 触发 App.render 计数 */
const tables = Object.create(null);
const handles = Object.create(null);
const insertCalls = [], updateCalls = [], removeCalls = [];
let seq = 0;
function tableOf(name) {
  if (!tables[name]) tables[name] = { rows: [] };
  if (handles[name]) return handles[name];
  const box = tables[name];
  const api = {
    _box: box,
    list: function () { return box.rows.slice(); },
    get: function (id) { return box.rows.filter(function (r) { return String(r.id) === String(id); })[0] || null; },
    count: function () { return box.rows.length; },
    findBy: function () { return null; },
    uniqueOf: function () { return []; },
    insert: function (row) {
      const payload = Object.assign({}, row);
      const saved = Object.assign({}, payload);
      saved.id = ++seq;
      box.rows.push(saved);
      insertCalls.push({ table: name, payload: payload });
      App.render();
      return Promise.resolve(saved);
    },
    update: function (id, patch) {
      const payload = Object.assign({}, patch);
      const hit = box.rows.filter(function (r) { return String(r.id) === String(id); })[0];
      if (hit) Object.assign(hit, payload);
      updateCalls.push({ table: name, id: id, payload: payload });
      App.render();
      return Promise.resolve(hit || null);
    },
    remove: function (id) {
      box.rows = box.rows.filter(function (r) { return String(r.id) !== String(id); });
      removeCalls.push({ table: name, id: id });
      App.render();
      return Promise.resolve(true);
    }
  };
  handles[name] = api;
  return api;
}
/* 保留真实 App.DB.defs / define 等，只替换 table 工厂（不打真实云端） */
App.DB.table = tableOf;

const CUST = 'customers', STOP = 'stop_resources';
const db = { customers: tableOf(CUST)._box, stop: tableOf(STOP)._box };

/* ---------------- 通用辅助 ---------------- */
function resetDb() {
  Object.keys(tables).forEach(function (n) { tables[n].rows.length = 0; });
  seq = 0; renderCount = 0;
  insertCalls.length = 0; updateCalls.length = 0; removeCalls.length = 0;
  modalCalls.length = 0; confirmCalls.length = 0; toasts.length = 0; domErrors.length = 0;
}
function resetState() {
  const s = App.__state;
  s.tab = 'list'; s.statKind = 'month';
  s.sortKey = 'created_at'; s.sortDesc = true;
  s.stopSortKey = 'stop_date'; s.stopSortDesc = true;
  Object.keys(s.filters).forEach(function (k) { s.filters[k] = ''; });
  Object.keys(s.stopFilters).forEach(function (k) { s.stopFilters[k] = ''; });
  role = 'admin'; readonly = false;
}
function resetAll() { resetDb(); resetState(); }
function renderHtml() { return mod.render(); }
function host() {
  const h = new El('div');
  h.innerHTML = renderHtml();
  mod.bind(h);
  return h;
}
function must(root, sel) {
  const el = root.querySelector(sel);
  if (!el) throw new Error('DOM 桩件未找到元素：' + sel);
  return el;
}
function setVal(body, name, v) {
  const el = must(body, '[name=' + name + ']');
  el.value = v;
  return el;
}
function setChk(body, name, v, fire) {
  const el = must(body, '[name=' + name + ']');
  el.checked = !!v;
  if (fire) el.dispatch('change');
  return el;
}
function lastModal() { return modalCalls[modalCalls.length - 1]; }
function lastConfirm() { return confirmCalls[confirmCalls.length - 1]; }
function clickSel(h, sel) { must(h, sel).click(); }
function btnBy(h, act, id) {
  return h.querySelectorAll('[data-sact="' + act + '"]').filter(function (b) {
    return String(b.getAttribute('data-id')) === String(id);
  })[0] || null;
}
function custBtnBy(h, act, id) {
  return h.querySelectorAll('[data-act="' + act + '"]').filter(function (b) {
    return String(b.getAttribute('data-id')) === String(id);
  })[0] || null;
}
/** 真实驱动 formModal 的 onOk → onSubmit(close)；返回 false 时不自动关窗 */
function triggerSubmit() {
  const m = lastModal();
  if (!m || !m._triggerOk) throw new Error('没有捕获到 formModal 的 Modal.open 调用');
  return m._triggerOk();
}
/** multiSelect：通过真实 keydown(Enter) 回调把科目加入已选（协作者，不 stub 被测函数） */
function addSubject(body, text) {
  const box = must(body, '#ms-subjects');
  const inp = box.querySelectorAll('input')[0];
  if (!inp) throw new Error('multiSelect 的 input 未挂载');
  inp.value = text;
  inp.dispatch('keydown', { key: 'Enter', preventDefault: function () { } });
}
function tick() { return new Promise(function (r) { setImmediate(r); }); }

/** 花括号配对抽取函数体（跳过字符串/注释），用于静态源码护栏 */
function fnBody(src, name) {
  const marker = 'function ' + name + '(';
  const s = src.indexOf(marker);
  if (s < 0) return '';
  const open = src.indexOf('{', s);
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return '';
}

/* 造数据夹具 */
function isoLocal(y, m, d) { return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(); }
function custRow(over) {
  return Object.assign({
    id: 0, stu_name: '张小明', school: '实验中学', phone: '13800138000', grade: '高一',
    resource_type: '上门咨询', intent_level: '高', intended_product: '一对一',
    intended_subjects: ['数学'], created_at: new Date().toISOString(),
    visited: false, visit_at: null, paid: false, paid_at: null, paid_amount: null,
    updated_at: new Date().toISOString(), last_editor: '管理员'
  }, over || {});
}
function stopRow(over) {
  return Object.assign({
    id: 0, stu_name: '李小华', phone: '13900139000', grade: '初一', school: '纪中',
    stop_date: isoLocal(2026, 3, 1), resource_type: '退费资源',
    refund_reason: '课程不合适', refund_subjects: '数学、物理', nonrenew_reason: '', end_subjects: '',
    teacher: '邓老师', followup_intent: '中', refund_amount: 3000,
    parent_confirmed: true, refund_applied: false, refund_apply_at: null,
    refund_arrived: false, refund_arrived_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_editor: '管理员'
  }, over || {});
}
function seedCustomers(list) {
  list.forEach(function (r) {
    const c = Object.assign({}, r); c.id = ++seq; db.customers.rows.push(c);
  });
}
function seedStop(list) {
  list.forEach(function (r) {
    const c = Object.assign({}, r); c.id = ++seq; db.stop.rows.push(c);
  });
}

/* =========================================================
 * 0. 加载 + 静态源码护栏
 * ========================================================= */
/* 全部用例包在 async main 内：假表 insert/update/remove 返回 resolved Promise，
   `.then(after)` 需 flush microtask 后才能断言 close()/toast。 */
async function main() {
section('0. 沙箱加载 / 权威契约静态护栏');
eq('按 index.html 顺序加载 5 个真实 js', LOAD.length, 5);
ok('App.UI 由真实 ui-kit.js 导出', !!(UI && UI.formModal && UI.confirmDanger && UI.sortHeader && UI.bindSort));
eqArr('UI.INTENT_LEVELS = 低/中/高', UI.INTENT_LEVELS, ['低', '中', '高']);
eqArr('UI.STOP_RESOURCE_TYPES = 退费/未续费', UI.STOP_RESOURCE_TYPES, ['退费资源', '未续费资源']);
ok('UI.RESOURCE_TYPES 与 STOP_RESOURCE_TYPES 值域不混淆',
  UI.RESOURCE_TYPES.length === 7 && UI.RESOURCE_TYPES.indexOf('退费资源') < 0);
ok('UI.PRIORITY 仍为英文值（未被改名/复用）',
  JSON.stringify(UI.PRIORITY.map(function (p) { return p.value; })) === JSON.stringify(['high', 'mid', 'low']));
ok('App.CustomersCore / App.StopResCore 已外露', !!(App.CustomersCore && App.StopResCore));
['validate', 'filterRows', 'normalize', 'visibleFields', 'localYm', 'sortRows'].forEach(function (k) {
  ok('StopResCore.' + k + ' 存在', typeof App.StopResCore[k] === 'function');
});
eq('App.DB.defs 共 8 张表（第 8 表已注册）', Object.keys(App.DB.defs).length, 8);
ok('defs.stop_resources：module=customers / unique=[]',
  !!App.DB.defs.stop_resources && App.DB.defs.stop_resources.module === 'customers' &&
  App.DB.defs.stop_resources.unique.length === 0);
has('db.js 末尾 define 第 8 表', DB_SRC, "define('stop_resources', { module: 'customers', unique: [], label: '结停课资源' });");
has('ui-kit.js formModal 用 App.Modal.open({onOk})', UK_SRC, 'return App.Modal.open({');
has('ui-kit.js confirmDanger 用 App.Modal.confirm(...,true)', UK_SRC, 'return App.Modal.confirm(html, onOk, true);');
has('ui-kit.js bindSort 只签 3 个参数', UK_SRC, 'function bindSort(host, state, onChange)');
has('ui-kit.js sortHeader 生成 data-sort 属性', UK_SRC, 'data-sort="');
has('TABS 三项（list/stats/stop）', MC_SRC, "{ id: 'stop', name: '③ 结停课资源' }");
has('render() 三分支', MC_SRC, "(state.tab === 'stats') ? renderStats()\n        : (state.tab === 'stop') ? renderStop()\n        : renderList();");
has('bind() stats 提前 return', MC_SRC, "if (state.tab === 'stats') {");
has('bind() stop 走 bindStop(host) 再 return', MC_SRC, "if (state.tab === 'stop') { bindStop(host); return; }");
has('bindStop 用 sortShim 承接 bindSort', MC_SRC, 'UI.bindSort(host, sortShim, function () {');
has('resetStopFilters 独立复位', MC_SRC, 'function resetStopFilters()');
has('renderList 意向程度筛选项 __blank__', MC_SRC, "'<option value=\"__blank__\"'");
has('openStopDetail 用 sec()/tr() 按类型整节渲染', MC_SRC, "h += sec('退费办理',");
has('confirmStopDel 二次确认', MC_SRC, 'UI.confirmDanger(');
/* V-F1：4 个写入口必须调用 assertWrite('customers')，且在任何 App.DB.table 写之前 */
['openForm', 'openStopForm', 'confirmDel', 'confirmStopDel'].forEach(function (n) {
  const body = fnBody(MC_SRC, n);
  ok(n + ' 函数体可抽取', body.length > 100, 'len=' + body.length);
  const a = body.indexOf("assertWrite('customers')");
  const w = body.indexOf('App.DB.table(');
  ok(n + " 内含 assertWrite('customers')", a >= 0);
  ok(n + ' 权限守卫在 DB 写入之前', a >= 0 && (w < 0 || a < w), 'guard=' + a + ' write=' + w);
});
has('openStopForm 提交经 StopResCore.normalize', fnBody(MC_SRC, 'openStopForm'), 'App.StopResCore.normalize(form)');

/* =========================================================
 * 1. V-B3 三分支 render
 * ========================================================= */
section('1. V-B3 三分支 render（list / stats / stop）');
resetAll();
seedCustomers([
  custRow({ stu_name: '甲', intent_level: '高' }),
  custRow({ stu_name: '乙', intent_level: '' }),
  custRow({ stu_name: '丙', intent_level: '特高' })
]);
seedStop([stopRow()]);

App.__state.tab = 'list';
const hList = renderHtml();
has('list：Tab① 按钮', hList, 'data-tab="list"');
has('list：Tab② 按钮', hList, 'data-tab="stats"');
has('list：Tab③ 按钮', hList, 'data-tab="stop"');
has('list：意向程度列头', hList, '>意向程度</th>');
has('list：value="__blank__" 未填写选项', hList, 'value="__blank__"');
has('list：未填写选项文案', hList, '>未填写</option>');
hasNot('list：不含 Tab③ 的 data-sact 按钮', hList, 'data-sact=');

App.__state.tab = 'stats';
const hStats = renderHtml();
has('stats：含「按资源类型分类分析」', hStats, '按资源类型分类分析');
hasNot('stats：不含 Tab③ 表格（data-sact 按钮）', hStats, 'data-sact=');
hasNot('stats：不含 Tab③ 表格（data-sf 筛选）', hStats, 'data-sf=');
hasNot('stats：不含 Tab③ 表格（type="month" 筛选控件）', hStats, 'type="month"');
hasNot('stats：不含「新增结停课资源」按钮', hStats, '新增结停课资源');
/* 注：Tab 切换栏本身必然含「③ 结停课资源」文字，按「表格」口径断言，不误伤 Tab 按钮 */
has('stats：三个 Tab 按钮仍都在', hStats, 'data-tab="stop"');

App.__state.tab = 'stop';
const hStop = renderHtml();
has('stop：含「新增结停课资源」按钮', hStop, 'data-sact="new">新增结停课资源');
has('stop：清空筛选 data-sact="clear"', hStop, 'data-sact="clear"');
has('stop：详情/编辑/删除 data-sact', hStop, 'data-sact="detail"');
has('stop：编辑 data-sact', hStop, 'data-sact="edit"');
has('stop：删除 data-sact', hStop, 'data-sact="del"');
eq('stop：10 个列头 <th', occurrences(hStop, '<th ') + occurrences(hStop, '<th>'), 10);
eq('stop：9 个 data-sort 列头', occurrences(hStop, 'data-sort="'), 9);
eq('stop：type="month" 两个筛选控件', occurrences(hStop, 'type="month"'), 2);
has('stop：起月 data-sf="ym_from"', hStop, 'data-sf="ym_from"');
has('stop：止月 data-sf="ym_to"', hStop, 'data-sf="ym_to"');
hasNot('stop：不含 Tab① 的 data-act 按钮', hStop, 'data-act=');
hasNot('stop：不含 Tab① 的 data-f 筛选', hStop, 'data-f=');

/* =========================================================
 * 2. V-A1/A2/A3/A4/A6 意向程度展示面
 * ========================================================= */
section('2. V-A1/A2/A3/A4/A6 意向程度（表单 / 提交 / 详情 / 灰 chip）');
resetAll();

/* V-A1：新增客户表单含 name="intent_level" 下拉，选项 低/中/高 */
let h = host();
clickSel(h, '[data-act="new"]');
let m = lastModal();
ok('新增客户弹出 formModal（UI.formModal→App.Modal.open）', !!m && m.okText === '保存' && !!m.body);
let fbody = m.body;
has('客户表单含 name="intent_level" 下拉', fbody.innerHTML, 'name="intent_level"');
const intentSel = must(fbody, '[name=intent_level]');
const intentOpts = intentSel.querySelectorAll('option');
eq('意向程度下拉共 4 项（含「（请选择）」）', intentOpts.length, 4);
eqArr('意向程度 3 个枚举选项文案',
  intentOpts.slice(1).map(function (o) { return o.textContent; }), ['低', '中', '高']);
eqArr('意向程度 3 个枚举选项值',
  intentOpts.slice(1).map(function (o) { return o.getAttribute('value'); }), ['低', '中', '高']);
eq('意向程度 blank 项 value 为空', intentOpts[0].getAttribute('value'), '');

/* V-A2：不选意向程度提交 → 校验拒、返回 false 不关窗、不写库 */
addSubject(fbody, '数学');
setVal(fbody, 'stu_name', '赵一');
setVal(fbody, 'school', '一中');
setVal(fbody, 'phone', '13800138001');
setVal(fbody, 'grade', '高一');
setVal(fbody, 'resource_type', '上门咨询');
setVal(fbody, 'intended_product', '一对一');
setVal(fbody, 'intent_level', '');
eq('V-A2 缺意向程度：onSubmit 返回 false', triggerSubmit(), false);
eq('V-A2 缺意向程度：不写库', insertCalls.length, 0);
eq('V-A2 校验失败：formModal 不关窗', lastModal()._mask.removed, false);
ok('V-A2 报错文案含「请选择意向程度」',
  toasts.some(function (t) { return String(t.msg).indexOf('请选择意向程度') >= 0; }));

/* V-A3/A4：选「高」提交 → insert payload 收集到 intent_level */
resetAll();
h = host();
clickSel(h, '[data-act="new"]');
m = lastModal(); fbody = m.body;
addSubject(fbody, '英语');
setVal(fbody, 'stu_name', '钱二');
setVal(fbody, 'school', '二中');
setVal(fbody, 'phone', '13800138002');
setVal(fbody, 'grade', '高二');
setVal(fbody, 'resource_type', '电话咨询');
setVal(fbody, 'intended_product', '班课');
setVal(fbody, 'intent_level', '高');
eq('V-A3 合法表单 onSubmit 返回 false（等云端回读）', triggerSubmit(), false);
ok('V-A3 写入 customers 表 1 行', insertCalls.length === 1 && insertCalls[0].table === CUST);
eq('V-A3 submit() 收集到 intent_level=高', insertCalls[0].payload.intent_level, '高');
eq('V-A3 intended_subjects 由真实 multiSelect 收集',
  JSON.stringify(insertCalls[0].payload.intended_subjects), JSON.stringify(['英语']));
await tick();
eq('V-A3 成功后由 close() 手动关窗', lastModal()._mask.removed, true);
eq('V-A3 写穿触发 App.render 计数', renderCount >= 1, true);
eq('V-A3 customers 表新增 1 行', db.customers.rows.length, 1);

/* V-A4：详情含「意向程度」行 */
resetAll();
seedCustomers([custRow({ stu_name: '孙三', intent_level: '中' })]);
h = host();
const custId = db.customers.rows[0].id;
ok('列表存在详情按钮', !!custBtnBy(h, 'detail', custId));
custBtnBy(h, 'detail', custId).click();
const detailModal = lastModal();
ok('客户详情弹出 App.Modal.open', !!detailModal && detailModal.okText === '关闭');
has('V-A4 详情含「意向程度」行', detailModal.body.innerHTML, '意向程度');
has('V-A4 详情渲染 chip「中」', detailModal.body.innerHTML, 'ch-amber">中</span>');

/* V-A6：存量 '' / 非法值渲染灰 chip「未填写」，不崩溃不改写 */
resetAll();
seedCustomers([
  custRow({ stu_name: '甲', intent_level: '' }),
  custRow({ stu_name: '乙', intent_level: '特高' }),
  custRow({ stu_name: '丙', intent_level: '高' })
]);
let h6 = '';
try { h6 = renderHtml(); } catch (e) { h6 = 'THROW:' + e.message; }
ok('V-A6 存量空/非法值渲染不崩溃', h6.indexOf('THROW:') < 0, h6.slice(0, 80));
eq('V-A6 灰 chip「未填写」出现 2 次（空串 + 非法值）',
  occurrences(h6, '<span class="chip" title="历史未填写">未填写</span>'), 2);
has('V-A6 合法值「高」渲染红 chip', h6, 'ch-red">高</span>');
hasNot('V-A6 不出现 undefined', h6, 'undefined');
eq('V-A6 不自动改写存量数据（表内仍 3 行、intent_level 原样）', db.customers.rows.length, 3);
eq('V-A6 存量空串仍为空串（未改写）', db.customers.rows[0].intent_level, '');
eq('V-A6 存量非法值原样保留', db.customers.rows[1].intent_level, '特高');

/* =========================================================
 * 3. V-B4/B6 CRUD：新增 / 编辑
 * ========================================================= */
section('3. V-B4/B6 Tab③ 新增 / 编辑（真实驱动 submit → insert / update）');
resetAll();
App.__state.tab = 'stop';

const STOP_BIZ = ['stu_name', 'phone', 'grade', 'school', 'stop_date', 'resource_type',
  'refund_reason', 'refund_subjects', 'nonrenew_reason', 'end_subjects',
  'teacher', 'followup_intent', 'refund_amount', 'parent_confirmed',
  'refund_applied', 'refund_apply_at', 'refund_arrived', 'refund_arrived_at'];

/* ---- V-B4 新增 ---- */
h = host();
clickSel(h, '[data-sact="new"]');
m = lastModal();
ok('V-B4 新增结停课资源弹出 formModal', !!m && String(m.title).indexOf('新增结停课资源') >= 0);
let sb = m.body;
has('V-B4 表单 5 分区：基础信息', sb.innerHTML, '基础信息');
has('V-B4 表单 5 分区：原因与科目', sb.innerHTML, '原因与科目');
has('V-B4 表单 5 分区：回流可跟进意向', sb.innerHTML, '回流可跟进意向');
has('V-B4 表单 5 分区：退费办理', sb.innerHTML, '退费办理（仅退费资源）');
STOP_BIZ.forEach(function (k) {
  has('V-B4 表单含业务字段 name="' + k + '"', sb.innerHTML, 'name="' + k + '"');
});
/* 系统列不出现在表单（V-B2：6 系统列前端不写；编辑只读展示的是无 name 的 disabled input） */
['id', 'owner_id', 'owner_name', 'last_editor', 'updated_at'].forEach(function (k) {
  hasNot('V-B4 表单不出现系统列 name="' + k + '"', sb.innerHTML, 'name="' + k + '"');
});
setVal(sb, 'stu_name', '周结');
setVal(sb, 'phone', '13700137000');
setVal(sb, 'grade', '初三');
setVal(sb, 'school', '三中');
setVal(sb, 'stop_date', '2026-03-01');
setVal(sb, 'resource_type', '未续费资源');
setVal(sb, 'nonrenew_reason', '课程结束');
setVal(sb, 'end_subjects', '英语');
setVal(sb, 'teacher', '陈老师');
setVal(sb, 'followup_intent', '低');
eq('V-B4 新增 onSubmit 返回 false（等云端回读）', triggerSubmit(), false);
ok('V-B4 insert 被真实调用（写 stop_resources）',
  insertCalls.length === 1 && insertCalls[0].table === STOP);
const pNew = insertCalls[0].payload;
STOP_BIZ.forEach(function (k) {
  ok('V-B4 新增行 18 业务字段齐全：' + k, Object.prototype.hasOwnProperty.call(pNew, k));
});
eq('V-B4 新增行 18 业务字段计数', STOP_BIZ.filter(function (k) {
  return Object.prototype.hasOwnProperty.call(pNew, k);
}).length, 18);
['id', 'owner_id', 'owner_name', 'last_editor', 'updated_at'].forEach(function (k) {
  ok('V-B4 新增 payload 无系统列 ' + k, !Object.prototype.hasOwnProperty.call(pNew, k));
});
eq('V-B4 stu_name 落库', pNew.stu_name, '周结');
eq('V-B4 resource_type 落库', pNew.resource_type, '未续费资源');
eq('V-B4 stop_date 走 UI.fromDateInput 存 ISO', typeof pNew.stop_date, 'string');
eq('V-B4 归一：非当前类型 refund_reason=空串', pNew.refund_reason, '');
eq('V-B4 归一：非当前类型 refund_amount=null', pNew.refund_amount, null);
eq('V-B4 归一：非当前类型 parent_confirmed=false', pNew.parent_confirmed, false);
eq('V-B4 归一：非当前类型 refund_apply_at=null', pNew.refund_apply_at, null);
ok('V-B4 归一写的是 null/false/""，不是 undefined',
  Object.keys(pNew).every(function (k) { return pNew[k] !== undefined; }));
await tick();
eq('V-B4 成功后 close() 关窗', lastModal()._mask.removed, true);
eq('V-B4 stop_resources 表新增 1 行', db.stop.rows.length, 1);
ok('V-B4 成功 toast「结停课资源已新增」',
  toasts.some(function (t) { return String(t.msg).indexOf('结停课资源已新增') >= 0; }));

/* ---- V-B6 编辑 → update 被调用 ---- */
const existing = db.stop.rows[0];
resetAll();
App.__state.tab = 'stop';
seedStop([Object.assign({}, existing)]);
const editRow = db.stop.rows[0];
h = host();
ok('Tab③ 存在编辑按钮', !!btnBy(h, 'edit', editRow.id));
btnBy(h, 'edit', editRow.id).click();
m = lastModal();
ok('V-B6 编辑结停课资源弹出 formModal', !!m && String(m.title).indexOf('编辑结停课资源') >= 0);
sb = m.body;
has('V-B6 编辑表单含只读系统信息分区', sb.innerHTML, '系统信息（只读）');
eq('V-B6 编辑回显 stu_name', must(sb, '[name=stu_name]').value, editRow.stu_name);
eq('V-B6 编辑回显 resource_type', must(sb, '[name=resource_type]').value, editRow.resource_type);
setVal(sb, 'school', '四中');
setVal(sb, 'teacher', '林老师');
eq('V-B6 编辑 onSubmit 返回 false', triggerSubmit(), false);
eq('V-B6 update 被调用 1 次', updateCalls.length, 1);
eq('V-B6 update 目标是该行 id', String(updateCalls[0].id), String(editRow.id));
eq('V-B6 update 表为 stop_resources', updateCalls[0].table, STOP);
eq('V-B6 编辑未误触发 insert', insertCalls.length, 0);
eq('V-B6 school 已更新', db.stop.rows[0].school, '四中');
eq('V-B6 teacher 已更新', db.stop.rows[0].teacher, '林老师');
eq('V-B6 created_at 未被回写（沿用原值）', db.stop.rows[0].created_at, editRow.created_at);
await tick();
ok('V-B6 成功 toast「结停课资源已更新」',
  toasts.some(function (t) { return String(t.msg).indexOf('结停课资源已更新') >= 0; }));

/* =========================================================
 * 4. V-B5 详情按当前类型只渲染对应分区
 * ========================================================= */
section('4. V-B5 详情按类型整节渲染（另一类型专属节不渲染）');
resetAll();
App.__state.tab = 'stop';
seedStop([
  stopRow({ stu_name: '退费甲', resource_type: '退费资源', refund_amount: 5000 }),
  stopRow({ stu_name: '未续费乙', resource_type: '未续费资源',
    refund_reason: '', refund_subjects: '', refund_amount: null,
    nonrenew_reason: '搬家', end_subjects: '化学' })
]);
h = host();
const refundRow = db.stop.rows[0], nonRow = db.stop.rows[1];

btnBy(h, 'detail', refundRow.id).click();
const dRefund = lastModal().body.innerHTML;
has('V-B5 退费行详情含「退费原因与科目」节', dRefund, '退费原因与科目');
has('V-B5 退费行详情含「退费办理」节', dRefund, '退费办理');
has('V-B5 退费行详情含「退费金额」行', dRefund, '退费金额');
hasNot('V-B5 退费行不渲染「未续费原因」节', dRefund, '未续费原因与科目');
hasNot('V-B5 退费行不渲染「未续费原因」行', dRefund, '未续费原因');
hasNot('V-B5 退费行不渲染「结课科目」行', dRefund, '结课科目');
has('V-B5 退费行详情含基础信息节', dRefund, '基础信息');
has('V-B5 退费行详情含回流可跟进意向节', dRefund, '回流可跟进意向');
has('V-B5 退费行详情含系统信息节', dRefund, '系统信息');

btnBy(h, 'detail', nonRow.id).click();
const dNon = lastModal().body.innerHTML;
has('V-B5 未续费行详情含「未续费原因与科目」节', dNon, '未续费原因与科目');
has('V-B5 未续费行详情含「结课科目」行', dNon, '结课科目');
hasNot('V-B5 未续费行不渲染「退费办理」节', dNon, '退费办理');
hasNot('V-B5 未续费行不渲染「退费金额」行', dNon, '退费金额');
hasNot('V-B5 未续费行不渲染「退费原因」行', dNon, '退费原因');
has('V-B5 未续费行详情仍含回流可跟进意向节', dNon, '回流可跟进意向');

/* =========================================================
 * 5. V-B7 删除二次确认
 * ========================================================= */
section('5. V-B7 删除二次确认（文案含姓名/类型/结停课时间；取消不写库；确认 remove）');
resetAll();
App.__state.tab = 'stop';
seedStop([stopRow({ stu_name: '吴删除', resource_type: '退费资源', stop_date: isoLocal(2026, 3, 1) })]);
const delRow = db.stop.rows[0];
h = host();
btnBy(h, 'del', delRow.id).click();
const cf = lastConfirm();
ok('V-B7 调用 UI.confirmDanger → App.Modal.confirm(...,true)', !!cf && cf.danger === true);
has('V-B7 确认文案含姓名', cf.html, '吴删除');
has('V-B7 确认文案含资源类型', cf.html, '退费资源');
has('V-B7 确认文案含结停课时间', cf.html, App.U.hms(delRow.stop_date));
has('V-B7 确认文案含不可恢复提示', cf.html, '删除后不可恢复');
eq('V-B7 取消（未调 onOk）不写库：remove 调用 0 次', removeCalls.length, 0);
eq('V-B7 取消（未调 onOk）行数不变', db.stop.rows.length, 1);
cf.onOk();
eq('V-B7 确认后 remove 被调用 1 次', removeCalls.length, 1);
eq('V-B7 remove 表为 stop_resources', removeCalls[0].table, STOP);
eq('V-B7 remove 目标 id 正确', String(removeCalls[0].id), String(delRow.id));
eq('V-B7 确认后行数归零', db.stop.rows.length, 0);
await tick();
ok('V-B7 成功 toast「结停课资源已删除」',
  toasts.some(function (t) { return String(t.msg).indexOf('结停课资源已删除') >= 0; }));

/* =========================================================
 * 6. V-B8 / V-E2 / V-E3 两表零关联
 * ========================================================= */
section('6. V-B8 / V-E2 / V-E3 两表零关联（独立句柄 / 无搬运按钮 / 同人多条）');
resetAll();
App.__state.tab = 'stop';
const tCust = App.DB.table(CUST), tStop = App.DB.table(STOP);
ok('V-E3 customers 与 stop_resources 是独立 table() 句柄', tCust !== tStop);
ok('V-E3 两表底层数组独立', tCust._box.rows !== tStop._box.rows);
eq('V-E3 defs.stop_resources.unique=[]（无唯一约束）', App.DB.defs.stop_resources.unique.length, 0);
hasNot('module-customers.js 不调用 findBy（本表不查重）', MC_SRC, 'findBy(');
/* DOM 无「转客户 / 同步 / 查重 / 一键」类按钮：三个 Tab 全量输出都查 */
seedCustomers([custRow({ stu_name: '零关联客户' })]);
seedStop([stopRow({ stu_name: '零关联结停' })]);
['list', 'stats', 'stop'].forEach(function (tab) {
  App.__state.tab = tab;
  const out = renderHtml();
  ['转客户', '一键', '查重', '同步'].forEach(function (w) {
    hasNot('V-E2 Tab=' + tab + ' 无「' + w + '」按钮', out, w);
  });
});
/* customers 写入不影响 stop_resources（独立句柄） */
App.__state.tab = 'list';
h = host();
clickSel(h, '[data-act="new"]');
sb = lastModal().body;
addSubject(sb, '数学');
setVal(sb, 'stu_name', '同人A'); setVal(sb, 'school', '一中'); setVal(sb, 'phone', '13800138009');
setVal(sb, 'grade', '高一'); setVal(sb, 'resource_type', '上门咨询');
setVal(sb, 'intended_product', '一对一'); setVal(sb, 'intent_level', '高');
triggerSubmit();
await tick();
eq('V-E3 客户表新增 1 行', db.customers.rows.length, 2);
eq('V-E3 结停课表未被联动写入', db.stop.rows.length, 1);

/* V-B8：同一人连登 2 条 → 2 行 */
resetAll();
App.__state.tab = 'stop';
function driveStopInsert(name) {
  h = host();
  clickSel(h, '[data-sact="new"]');
  const mm = lastModal(); const b = mm.body;
  setVal(b, 'stu_name', name);
  setVal(b, 'phone', '13600136000');
  setVal(b, 'grade', '初二');
  setVal(b, 'school', '五中');
  setVal(b, 'stop_date', '2026-03-01');
  setVal(b, 'resource_type', '未续费资源');
  setVal(b, 'nonrenew_reason', '课程结束');
  setVal(b, 'end_subjects', '物理');
  setVal(b, 'teacher', '邓老师');
  setVal(b, 'followup_intent', '中');
  triggerSubmit();
}
driveStopInsert('连登甲');
driveStopInsert('连登甲');
await tick();
eq('V-B8 同人连登 2 条 → stop_resources 恰好 2 行', db.stop.rows.length, 2);
eq('V-B8 两行姓名相同', db.stop.rows[0].stu_name, db.stop.rows[1].stu_name);
ok('V-B8 两行 id 不同（未去重）', String(db.stop.rows[0].id) !== String(db.stop.rows[1].id));
eq('V-B8 两次 insert 均落 stop_resources', insertCalls.length, 2);

/* =========================================================
 * 7. V-C1~C5 条件联动（DOM hidden+disabled / 不清空 / 归一 / 布尔→时间）
 * ========================================================= */
section('7. V-C1~C5 条件联动（真实驱动 syncVisibility + normalize）');
resetAll();
App.__state.tab = 'stop';
h = host();
clickSel(h, '[data-sact="new"]');
m = lastModal(); sb = m.body;
const REFUND_ROWS = ['refund_reason', 'refund_subjects', 'refund_amount'];
const NONRENEW_ROWS = ['nonrenew_reason', 'end_subjects'];
function rowOf(name) { return must(sb, '[data-srow="' + name + '"]'); }
function rowState(name) {
  const r = rowOf(name);
  const inputs = r.querySelectorAll('input, select, textarea');
  return { hidden: r.hidden, display: r.style.display,
    n: inputs.length, allDisabled: inputs.length > 0 && inputs.every(function (e) { return e.disabled === true; }),
    anyDisabled: inputs.some(function (e) { return e.disabled === true; }) };
}

/* 初始 type0 = 未续费资源（openStopForm(null)） */
eq('V-C1 初始资源类型 = 未续费资源', must(sb, '[name=resource_type]').value, '未续费资源');
REFUND_ROWS.forEach(function (n) {
  const s = rowState(n);
  eq('V-C1 初始退费分区 hidden：' + n, s.hidden, true);
  eq('V-C1 初始退费分区 display=none：' + n, s.display, 'none');
  ok('V-C1 初始退费分区内控件全部 disabled：' + n, s.allDisabled, 'n=' + s.n);
});
NONRENEW_ROWS.forEach(function (n) {
  const s = rowState(n);
  eq('V-C1 初始未续费分区可见：' + n, s.hidden, false);
  ok('V-C1 初始未续费分区控件未禁用：' + n, !s.anyDisabled);
});
ok('V-C1 共用字段 teacher 恒显示（不在两组里）', rowOf('teacher').hidden === false);

/* V-C3：填 refund_amount 后切到未续费再切回，值仍在（切换不清空） */
const inAmt = must(sb, '[name=refund_amount]');
inAmt.value = '3000';
const selType = must(sb, '[name=resource_type]');
selType.value = '退费资源'; selType.dispatch('change');
REFUND_ROWS.forEach(function (n) {
  eq('V-C1 切退费后退费分区可见：' + n, rowState(n).hidden, false);
});
['refund_reason', 'refund_subjects'].forEach(function (n) {
  ok('V-C1 切退费后 ' + n + ' 分区控件全部启用', !rowState(n).anyDisabled);
});
/* data-srow="refund_amount" 包住整个「退费办理」节：业务控件启用，但两个时间输入
   依 V-C5 布尔「否」联动仍 disabled —— 属正确行为，不能对整节一刀切断言启用。 */
['refund_amount', 'parent_confirmed', 'refund_applied', 'refund_arrived'].forEach(function (n) {
  eq('V-C1 切退费后退费业务控件启用：' + n, must(sb, '[name=' + n + ']').disabled, false);
});
eq('V-C5 布尔否 → refund_apply_at 仍禁用', must(sb, '[name=refund_apply_at]').disabled, true);
eq('V-C5 布尔否 → refund_arrived_at 仍禁用', must(sb, '[name=refund_arrived_at]').disabled, true);
NONRENEW_ROWS.forEach(function (n) {
  eq('V-C1 切退费后未续费分区 hidden：' + n, rowState(n).hidden, true);
  ok('V-C1 切退费后未续费分区控件全部 disabled：' + n, rowState(n).allDisabled);
});
eq('V-C3 退费类型下 refund_amount 仍在', inAmt.value, '3000');
selType.value = '未续费资源'; selType.dispatch('change');
eq('V-C3 切到未续费不清空 refund_amount', inAmt.value, '3000');
selType.value = '退费资源'; selType.dispatch('change');
eq('V-C3 切回退费值仍可恢复', inAmt.value, '3000');

/* V-C5：布尔「否」→ 时间输入禁用且置空 */
const applyAt = must(sb, '[name=refund_apply_at]');
const arrivedAt = must(sb, '[name=refund_arrived_at]');
eq('V-C5 refund_applied=否 → refund_apply_at disabled', applyAt.disabled, true);
eq('V-C5 refund_applied=否 → refund_apply_at 置空', applyAt.value, '');
eq('V-C5 refund_arrived=否 → refund_arrived_at disabled', arrivedAt.disabled, true);
eq('V-C5 refund_arrived=否 → refund_arrived_at 置空', arrivedAt.value, '');
/* 布尔「是」→ 启用 + 条件必填 */
setChk(sb, 'refund_applied', true, true);
eq('V-C5 refund_applied=是 → refund_apply_at 启用', applyAt.disabled, false);
eq('V-C5 另一布尔仍为否 → refund_arrived_at 仍禁用', arrivedAt.disabled, true);
/* 勾了「是」却不填时间 → 条件必填拦截 */
setVal(sb, 'stu_name', '联动甲'); setVal(sb, 'phone', '13500135000');
setVal(sb, 'grade', '初三'); setVal(sb, 'school', '六中');
setVal(sb, 'stop_date', '2026-03-01'); setVal(sb, 'teacher', '王老师');
setVal(sb, 'followup_intent', '高');
setVal(sb, 'refund_reason', '时间冲突'); setVal(sb, 'refund_subjects', '数学');
setVal(sb, 'refund_amount', '3000');
eq('V-C5 布尔是但缺时间 → onSubmit 返回 false', triggerSubmit(), false);
eq('V-C5 条件必填拦截不写库', insertCalls.length, 0);
ok('V-C5 报错文案为「退费提交时间」必填',
  toasts.some(function (t) { return String(t.msg).indexOf('退费提交时间') >= 0; }));
/* 填上时间 → 通过，保存非 null */
setVal(sb, 'refund_apply_at', '2026-03-05');
eq('V-C5 填时间后 onSubmit 返回 false（正常等回读）', triggerSubmit(), false);
eq('V-C5 条件必填满足后 insert 被调用', insertCalls.length, 1);
const pC5 = insertCalls[0].payload;
eq('V-C5 refund_applied=是 保存 true', pC5.refund_applied, true);
ok('V-C5 refund_apply_at 保存非空 ISO', !!pC5.refund_apply_at && typeof pC5.refund_apply_at === 'string');
eq('V-C5 refund_arrived=否 → refund_arrived_at 保存 null', pC5.refund_arrived_at, null);
eq('V-C5 另一类型专属列 nonrenew_reason 归一为空串', pC5.nonrenew_reason, '');
eq('V-C5 另一类型专属列 end_subjects 归一为空串', pC5.end_subjects, '');
ok('V-C5 归一字段无 undefined',
  Object.keys(pC5).every(function (k) { return pC5[k] !== undefined; }));
await tick();

/* V-C4：会话内不清空，但保存时归一 —— 未续费提交带「退费脏值」 */
resetAll();
App.__state.tab = 'stop';
h = host();
clickSel(h, '[data-sact="new"]');
m = lastModal(); sb = m.body;
setVal(sb, 'stu_name', '归一甲'); setVal(sb, 'phone', '13400134000');
setVal(sb, 'grade', '初一'); setVal(sb, 'school', '七中');
setVal(sb, 'stop_date', '2026-03-01'); setVal(sb, 'teacher', '赵老师');
setVal(sb, 'followup_intent', '低');
setVal(sb, 'nonrenew_reason', '转学'); setVal(sb, 'end_subjects', '语文');
/* 跨类型脏值：隐藏分区里照样填，DOM 不清空 */
setVal(sb, 'refund_reason', '脏退费原因');
setVal(sb, 'refund_subjects', '脏退费科目');
setVal(sb, 'refund_amount', '8888');
setChk(sb, 'parent_confirmed', true, false);
setChk(sb, 'refund_applied', true, false);
setChk(sb, 'refund_arrived', true, false);
eq('V-C4 提交前 DOM 仍保留跨类型脏值', must(sb, '[name=refund_amount]').value, '8888');
eq('V-C4 未续费类型 onSubmit 返回 false', triggerSubmit(), false);
eq('V-C4 insert 被调用（validate 不校验隐藏字段）', insertCalls.length, 1);
const pC4 = insertCalls[0].payload;
eq('V-C4 validate 未报「退费金额必填」', pC4.resource_type, '未续费资源');
eq('V-C4 归一 refund_reason = ""', pC4.refund_reason, '');
eq('V-C4 归一 refund_subjects = ""', pC4.refund_subjects, '');
eq('V-C4 归一 refund_amount = null', pC4.refund_amount, null);
eq('V-C4 归一 parent_confirmed = false', pC4.parent_confirmed, false);
eq('V-C4 归一 refund_applied = false', pC4.refund_applied, false);
eq('V-C4 归一 refund_apply_at = null', pC4.refund_apply_at, null);
eq('V-C4 归一 refund_arrived = false', pC4.refund_arrived, false);
eq('V-C4 归一 refund_arrived_at = null', pC4.refund_arrived_at, null);
ok('V-C4 归一写的是 ""/false/null 而非 undefined/delete（pick() 保留 null 键）',
  Object.keys(pC4).every(function (k) { return pC4[k] !== undefined; }) &&
  ['refund_reason', 'refund_subjects', 'refund_amount', 'parent_confirmed',
    'refund_applied', 'refund_apply_at', 'refund_arrived', 'refund_arrived_at']
    .every(function (k) { return Object.prototype.hasOwnProperty.call(pC4, k); }));
eq('V-C4 当前类型字段 nonrenew_reason 保留', pC4.nonrenew_reason, '转学');
eq('V-C4 当前类型字段 end_subjects 保留', pC4.end_subjects, '语文');
/* 纯函数层同步核对 db.js pick 语义（跳过 undefined、保留 null） */
has('db.js pick() 跳过 undefined', DB_SRC, 'if (src[k] === undefined) continue;');
has('db.js pick() 保留 null（无 null 跳过分支）', DB_SRC, 'out[k] = src[k];');
await tick();

/* =========================================================
 * 8. V-D6 / V-D7 排序隔离 + 筛选复位
 * ========================================================= */
section('8. V-D6/D7 排序隔离（shim 写回 stop* 键，不污染 Tab①）与筛选复位');
resetAll();
App.__state.tab = 'stop';
seedStop([
  stopRow({ stu_name: '赵', stop_date: isoLocal(2026, 3, 2) }),
  stopRow({ stu_name: '钱', stop_date: isoLocal(2026, 3, 1) }),
  stopRow({ stu_name: '孙', stop_date: isoLocal(2026, 2, 28) })
]);
const stopHtml = renderHtml();
has('V-D6 UI.sortHeader 生成 data-sort="stop_date"', stopHtml, 'data-sort="stop_date"');
has('V-D6 UI.sortHeader 生成 data-sort="stu_name"', stopHtml, 'data-sort="stu_name"');
has('V-D6 UI.sortHeader 生成 data-sort="refund_amount"', stopHtml, 'data-sort="refund_amount"');
eq('V-D6 9 个可排序表头', occurrences(stopHtml, 'data-sort="'), 9);

/* V-D7：设置 Tab① 排序态为专属值，点击 Tab③ 表头后不得污染 */
App.__state.sortKey = 'created_at'; App.__state.sortDesc = true;
App.__state.stopSortKey = 'stop_date'; App.__state.stopSortDesc = true;
h = host();
const thName = h.querySelectorAll('th[data-sort]').filter(function (t) {
  return t.getAttribute('data-sort') === 'stu_name';
})[0];
ok('Tab③ 存在 th[data-sort="stu_name"]', !!thName);
thName.click();
eq('V-D7 点击换列写回 state.stopSortKey', App.__state.stopSortKey, 'stu_name');
eq('V-D7 换列默认 stopSortDesc=false', App.__state.stopSortDesc, false);
eq('V-D7 不污染 Tab① state.sortKey', App.__state.sortKey, 'created_at');
eq('V-D7 不污染 Tab① state.sortDesc', App.__state.sortDesc, true);
thName.click();
eq('V-D7 再点同列切换 stopSortDesc=true', App.__state.stopSortDesc, true);
eq('V-D7 再点仍不污染 Tab① state.sortKey', App.__state.sortKey, 'created_at');
eq('V-D7 再点仍不污染 Tab① state.sortDesc', App.__state.sortDesc, true);
ok('V-D7 排序回调触发 App.render', renderCount >= 2);

/* V-D5/复位：resetStopFilters() 复位 Tab③ 筛选态且不动 Tab① filters */
App.__state.stopFilters.kw = '张三';
App.__state.stopFilters.grade = '高一';
App.__state.stopFilters.resource_type = '退费资源';
App.__state.stopFilters.ym_from = '2026-01';
App.__state.filters.kw = '李四';
App.__state.filters.grade = '高二';
App.__state.filters.intent_level = '__blank__';
h = host();
clickSel(h, '[data-sact="clear"]');
const sf = App.__state.stopFilters;
ok('V-D7 复位后 stopFilters.kw 为空', sf.kw === '');
ok('V-D7 复位后 stopFilters 全 10 项为空串',
  ['kw', 'grade', 'school', 'resource_type', 'followup_intent',
    'parent_confirmed', 'refund_applied', 'refund_arrived', 'ym_from', 'ym_to']
    .every(function (k) { return sf[k] === ''; }), JSON.stringify(sf));
eq('V-D7 复位 stopFilters 不动 Tab① filters.kw', App.__state.filters.kw, '李四');
eq('V-D7 复位 stopFilters 不动 Tab① filters.grade', App.__state.filters.grade, '高二');
eq('V-D7 复位 stopFilters 不动 Tab① filters.intent_level', App.__state.filters.intent_level, '__blank__');

/* =========================================================
 * 9. V-F1 权限：非管理员 / readonly 时四个写入口都不写库
 * ========================================================= */
section('9. V-F1 权限守卫（真实 App.Perm.assertWrite × 假 App.Sync）');
function permissionScenario(label, r, ro) {
  resetAll();
  App.__state.tab = 'list';
  seedCustomers([custRow({ stu_name: '权限客户' })]);
  App.__state.tab = 'stop';
  seedStop([stopRow({ stu_name: '权限结停' })]);
  /* 先在管理员态渲染 + bind（非管理员 render 会直接出 403 卡片、无按钮） */
  const custHost = (function () { App.__state.tab = 'list'; return host(); })();
  const stopHost = (function () { App.__state.tab = 'stop'; return host(); })();
  const cid = db.customers.rows[0].id, sid = db.stop.rows[0].id;
  role = r; readonly = ro;
  const before = {
    ins: insertCalls.length, upd: updateCalls.length, rem: removeCalls.length,
    cust: db.customers.rows.length, stop: db.stop.rows.length,
    modals: modalCalls.length, confirms: confirmCalls.length
  };
  must(custHost, '[data-act="new"]').click();
  custBtnBy(custHost, 'del', cid).click();
  must(stopHost, '[data-sact="new"]').click();
  btnBy(stopHost, 'del', sid).click();
  eq(label + ' openForm 不弹窗', modalCalls.length, before.modals);
  eq(label + ' confirmDel 不弹确认', confirmCalls.length, before.confirms);
  eq(label + ' openStopForm 不弹窗', modalCalls.length, before.modals);
  eq(label + ' confirmStopDel 不弹确认', confirmCalls.length, before.confirms);
  eq(label + ' 无 insert', insertCalls.length, before.ins);
  eq(label + ' 无 update', updateCalls.length, before.upd);
  eq(label + ' 无 remove', removeCalls.length, before.rem);
  eq(label + ' customers 行数不变', db.customers.rows.length, before.cust);
  eq(label + ' stop_resources 行数不变', db.stop.rows.length, before.stop);
  ok(label + ' toast「无操作权限」',
    toasts.filter(function (t) { return String(t.msg).indexOf('无操作权限') >= 0; }).length >= 4);
}
permissionScenario('非管理员(teacher)', 'teacher', false);
permissionScenario('管理员但 readonly', 'admin', true);
/* 管理员可写 → 四个入口均应放行（正对照） */
resetAll();
App.__state.tab = 'list';
const okHost = host();
clickSel(okHost, '[data-act="new"]');
ok('V-F1 正对照：admin 可打开新增客户表单', !!lastModal() && !!lastModal().body);
App.__state.tab = 'stop';
const okStopHost = host();
clickSel(okStopHost, '[data-sact="new"]');
ok('V-F1 正对照：admin 可打开新增结停课资源表单', !!lastModal() && !!lastModal().body);
eq('V-F1 正对照：App.Perm.assertWrite(customers) = true', App.Perm.assertWrite('customers'), true);

/* =========================================================
 * 汇总
 * ========================================================= */
ok('DOM 事件回调全链路无异常', domErrors.length === 0, JSON.stringify(domErrors.slice(0, 3)));
finish();
}   /* end of async main */

function finish() {
  console.log('\n============================');
  if (FAILS.length) {
    console.log('FAIL（' + FAILS.length + ' 条）');
    FAILS.forEach(function (s, i) { console.log('  ' + (i + 1) + '. ' + s); });
    console.log('----------------------------');
  }
  console.log('=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  fail++;
  FAILS.push('FATAL 未捕获异常 → ' + (e && e.stack ? e.stack : e));
  finish();
});
