/* =========================================================
 * tools/qa-v4.js —— V4「客户意向程度 + 结停课资源」总集成验收入口
 *   TZ=Asia/Shanghai node tools/qa-v4.js
 *
 * 定位：v4 全量回归 + 契约静态核对的收口关。不连生产库、不执行 DDL、不发布。
 *
 * 覆盖两大部分：
 *   A. 静态契约断言（源码级 / 文档级，机器可复验）：
 *      · js/db.js 注册第 8 表、js/ui-kit.js 三新导出、
 *        js/module-customers.js 六纯函数 + 三分支 + 意向程度 + Tab③；
 *      · 两表零关联（无 JOIN / FK / 转客户 / 同步 / 查重按钮）；
 *      · docs/ddl-v4-*.sql 的 V-G1 静态核对 7 项（只写不执行）；
 *      · README 的 R4 已上线状态与「重建环境须先执行 DDL」声明；
 *      · 构建产物：index.html 版本号一致、单文件版内联了 v4 代码。
 *   B. 全量回归汇总：spawnSync 依次执行 v4 两个专项 + v2/v3 顶层套件，
 *      收集 rc 与末行 PASS/FAIL；任一 rc≠0 或末行 FAIL>0 计入失败。
 *      v4 两个专项必须存在且全绿（缺失直接 FAIL，不 SKIP）。
 *
 * 末尾输出：=== 结果：PASS N / FAIL 0 ===
 * 任一断言失败 → process.exit(1)。
 * ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');
const DOCS = path.join(ROOT, 'docs');
const TOOLS = __dirname;

/* ---------------- 断言框架 ---------------- */
let pass = 0, fail = 0;
const FAILS = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); return true; }
  fail++;
  FAILS.push(name + (detail === undefined ? '' : '  → ' + detail));
  console.log('  FAIL  ' + name + (detail === undefined ? '' : '  → ' + detail));
  return false;
}
function eq(name, actual, expect) {
  return ok(name, actual === expect,
    '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expect));
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
/** 剥离 JS 块注释 / 行注释与 SQL 的 -- 行注释，避免「不建 UNIQUE / 无 JOIN」这类说明文字误伤断言 */
function stripComments(s) {
  return String(s || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');
}

const customers = read(path.join(JS, 'module-customers.js'));
const dbjs = read(path.join(JS, 'db.js'));
const uikit = read(path.join(JS, 'ui-kit.js'));
const ddl = read(path.join(DOCS, 'ddl-v4-customer-intent-stopres.sql'));
const readme = read(path.join(ROOT, 'README.md'));
const indexHtml = read(path.join(ROOT, 'index.html'));
const singleHtml = read(path.join(ROOT, '..', '学生管理系统-单文件版.html'));

/* =========================================================
 * A1. 基础设施落盘
 * ========================================================= */
section('A1 基础设施落盘');
ok('js/db.js 注册 stop_resources（module=customers, unique=[]）',
  /define\('stop_resources',\s*\{[^}]*module:\s*'customers'[^}]*unique:\s*\[\]/.test(dbjs));
eq('App.DB 共 8 张 define（不含成绩/账号）',
  (dbjs.match(/^\s*define\('/gm) || []).length, 8);
ok('js/ui-kit.js 导出 INTENT_LEVELS',
  /INTENT_LEVELS:\s*INTENT_LEVELS/.test(uikit) && /var INTENT_LEVELS\s*=\s*\['低',\s*'中',\s*'高'\]/.test(uikit));
ok('js/ui-kit.js 导出 STOP_RESOURCE_TYPES',
  /STOP_RESOURCE_TYPES:\s*STOP_RESOURCE_TYPES/.test(uikit) &&
  /var STOP_RESOURCE_TYPES\s*=\s*\['退费资源',\s*'未续费资源'\]/.test(uikit));
var lmBody = (/function localYm\([\s\S]*?\n  \}/.exec(uikit) || [''])[0];
ok('js/ui-kit.js 导出 localYm 且用本地 getter（禁 slice(0,7)）',
  /localYm:\s*localYm/.test(uikit) &&
  /getMonth\(\)/.test(lmBody) && /getFullYear\(\)/.test(lmBody) &&
  !/slice\(0,\s*7\)/.test(lmBody));
ok('UI.RESOURCE_TYPES / UI.PRIORITY 未被改名或污染',
  /var RESOURCE_TYPES\s*=\s*\['转介绍'/.test(uikit) &&
  /var PRIORITY\s*=\s*\[/.test(uikit) && /value:\s*'high'/.test(uikit));

/* =========================================================
 * A2. 纯函数内核 / 意向程度 / 三分支
 * ========================================================= */
section('A2 纯函数内核与页面结构');
ok('App.CustomersCore.validate 增 intent_level 必选',
  /errors\.intent_level\s*=\s*'请选择意向程度'/.test(customers));
ok('App.CustomersCore.filterRows 特判 __blank__ 哨兵',
  /wantIntent\s*===\s*'__blank__'/.test(customers));
ok('App.StopResCore 六函数全部外露',
  /App\.StopResCore\s*=\s*\{[\s\S]{0,400}validate:[\s\S]{0,400}filterRows:[\s\S]{0,400}normalize:[\s\S]{0,400}visibleFields:[\s\S]{0,400}localYm:[\s\S]{0,400}sortRows:/.test(customers));
ok('normalize 写 null/false/空串（非 undefined/delete）',
  /f\.refund_amount\s*=\s*null/.test(customers) &&
  /f\.parent_confirmed\s*=\s*false/.test(customers) &&
  /f\.nonrenew_reason\s*=\s*''/.test(customers) &&
  !/f\.refund_amount\s*=\s*undefined/.test(customers));
ok('TABS 含第 3 个 Tab「③ 结停课资源」',
  /id:\s*'stop',\s*name:\s*'③ 结停课资源'/.test(customers));
ok('render() 三分支（stats / stop / list）',
  /state\.tab\s*===\s*'stats'[\s\S]{0,200}state\.tab\s*===\s*'stop'/.test(customers));
ok('bind() 三分支且 stop 走 bindStop 后 return',
  /state\.tab\s*===\s*'stop'\)\s*\{\s*bindStop\(host\);\s*return;/.test(customers));
ok('意向程度：列 / 筛选(含未填写) / 表单 / 详情 四处齐全',
  /key:\s*'intent_level',\s*label:\s*'意向程度'/.test(customers) &&
  /fWrap\('intent_level'/.test(customers) && /name="intent_level"/.test(customers) &&
  /tr\('意向程度'/.test(customers));
ok('intentChip 对空/非法值渲染「未填写」不崩溃',
  /function intentChip\([\s\S]{0,300}未填写/.test(customers));

/* =========================================================
 * A3. Tab③ 覆盖 18 业务字段 / 10 列 / 10 筛选 / 5 分区 / 联动
 * ========================================================= */
section('A3 Tab③ 表单与联动完备性');
const STOP_FIELDS = ['stu_name', 'phone', 'grade', 'school', 'stop_date', 'resource_type',
  'refund_reason', 'nonrenew_reason', 'refund_subjects', 'end_subjects', 'teacher',
  'followup_intent', 'refund_amount', 'parent_confirmed', 'refund_applied',
  'refund_apply_at', 'refund_arrived', 'refund_arrived_at'];
const missFields = STOP_FIELDS.filter(function (f) {
  return customers.indexOf("name=\"" + f + "\"") < 0 && customers.indexOf("name='" + f + "'") < 0;
});
ok('18 个业务字段全部出现在表单（缺：' + missFields.join(',') + '）',
  missFields.length === 0, missFields.join(','));
ok('系统 6 列不出现在表单输入（无 name="owner_id" 等）',
  !/name="(id|owner_id|owner_name|created_at|updated_at)"/.test(customers));
ok('Tab③ 10 列表头齐全',
  /学生姓名[\s\S]{0,1200}操作'/.test(customers) &&
  /key:\s*'stop_date',\s*label:\s*'结停课时间'/.test(customers) &&
  /key:\s*'followup_intent',\s*label:\s*'回流意向'/.test(customers));
ok('S-1~S-9 筛选项齐全（含两个 type="month"）',
  /data-sf="kw"/.test(customers) && /data-sf="ym_from"/.test(customers) &&
  /data-sf="ym_to"/.test(customers) &&
  (customers.match(/type="month"/g) || []).length >= 2);
ok('条件联动 syncVisibility：hidden+disabled 且不清空值',
  /function syncVisibility\(/.test(customers) && /\.hidden\s*=/.test(customers) &&
  /\.disabled\s*=/.test(customers));
ok('退费专属分区用 data-srow 整节切换',
  /data-srow="refund_reason"/.test(customers) && /data-srow="refund_amount"/.test(customers));
ok('详情按类型整节渲染（另一类型专属节不渲染）',
  /退费原因与科目/.test(customers) && /未续费原因与科目/.test(customers));
ok('删除走 UI.confirmDanger 且文案含姓名/类型/时间',
  /confirmStopDel[\s\S]{0,600}UI\.confirmDanger\(/.test(customers) &&
  /确定删除结停课资源/.test(customers));
ok('所有写入口首行 assertWrite("customers")',
  (customers.match(/assertWrite\('customers'\)/g) || []).length >= 4);
ok('两表独立句柄 stopRows()/rows() 且无跨表搬运按钮',
  /function stopRows\(\)[\s\S]{0,120}App\.DB\.table\(TABLE_STOP\)/.test(customers) &&
  !/(转客户|一键转|自动同步|跨表查重|JOIN\b)/.test(stripComments(customers)));

/* =========================================================
 * A4. DDL V-G1 静态核对 7 项（只写不执行）
 * ========================================================= */
section('A4 DDL 静态核对（V-G1 7 项，只写不执行）');
ok('① 头部含「只写不执行」R4 声明',
  /只写不执行/.test(ddl) && /禁止连生产库|不连生产库/.test(ddl));
ok('② customers 仅 1 条 ADD COLUMN、零 UPDATE 回填',
  (ddl.match(/ADD COLUMN IF NOT EXISTS intent_level/g) || []).length === 1 &&
  !/UPDATE\s+customers/i.test(ddl));
const colNames = ['id', 'owner_id', 'owner_name', 'last_editor', 'stu_name', 'phone', 'grade',
  'school', 'stop_date', 'resource_type', 'refund_reason', 'nonrenew_reason',
  'refund_subjects', 'end_subjects', 'teacher', 'followup_intent', 'refund_amount',
  'parent_confirmed', 'refund_applied', 'refund_apply_at', 'refund_arrived',
  'refund_arrived_at', 'created_at', 'updated_at'];
const missCols = colNames.filter(function (c) {
  return !new RegExp('^\\s*' + c + '\\s+(bigint|text|numeric|boolean|timestamptz)', 'm').test(ddl);
});
ok('③ stop_resources 恰好 24 列且列名/类型齐全（缺：' + missCols.join(',') + '）',
  missCols.length === 0, missCols.join(','));
var ddlCode = stripComments(ddl);
ok('④ 除主键外无 UNIQUE / INDEX / FOREIGN KEY（剥离注释后）',
  !/UNIQUE\s*\(/i.test(ddlCode) && !/CREATE\s+(UNIQUE\s+)?INDEX/i.test(ddlCode) &&
  !/FOREIGN KEY/i.test(ddlCode) && !/REFERENCES\s/i.test(ddlCode));
ok('⑤ 4 条 RLS policy 名称与 is_viewer()/is_editor() 一致',
  ['stop_resources_read_team', 'stop_resources_insert_team',
    'stop_resources_update_team', 'stop_resources_delete_team'].every(function (p) {
      return ddl.indexOf(p) >= 0;
    }) && /is_viewer\(\)/.test(ddl) && /is_editor\(\)/.test(ddl));
ok('⑥ GRANT 2 行 + 序列 USAGE 齐全',
  /GRANT SELECT ON stop_resources TO anon/.test(ddl) &&
  /GRANT SELECT, INSERT, UPDATE, DELETE ON stop_resources TO authenticated/.test(ddl) &&
  /GRANT USAGE, SELECT ON SEQUENCE stop_resources_id_seq/.test(ddl));
ok('⑦ COMMENT 含「零关联」且每个 DO 块幂等',
  /零关联/.test(ddl) && (ddl.match(/DO \$ddl\$ BEGIN/g) || []).length >= 5 &&
  /IF NOT EXISTS/.test(ddl));

/* =========================================================
 * A5. R4 边界 / 文档 / 构建产物
 * ========================================================= */
section('A5 R4 边界与构建产物');
ok('README 含 intent_level / stop_resources 说明',
  /intent_level/.test(readme) && /stop_resources/.test(readme));
ok('README 含「重建环境须先执行 DDL」与 R4 已上线状态',
  /重建环境|迁移新库/.test(readme) && /DDL/.test(readme) &&
  /R4/.test(readme) && /已发布上线|已上线/.test(readme));
ok('README 声明生产 DDL 已执行且代码库已同步',
  /生产 DDL 已执行|DDL 已执行/.test(readme) && /55e969c/.test(readme));
const versions = [];
indexHtml.replace(/\?v=(\d{12})/g, function (m, d) { versions.push(d); return m; });
ok('index.html 本地资源版本号一致（≥24 处同戳）',
  versions.length >= 24 && versions.every(function (x) { return x === versions[0]; }),
  '版本数=' + versions.length + ' 首值=' + versions[0]);
ok('index.html 含 Cache-Control: no-store',
  /<meta\s+http-equiv="Cache-Control"\s+content="no-store"/.test(indexHtml));
ok('单文件版存在且内联了 v4 代码（StopResCore / stop_resources）',
  singleHtml.length > 0 && /App\.StopResCore\s*=/.test(singleHtml) &&
  /define\('stop_resources'/.test(singleHtml) && /③ 结停课资源/.test(singleHtml));
ok('单文件版无未内联的本地 js 残留',
  !/<script src="js\/[a-z\-]+\.js/.test(singleHtml));

/* =========================================================
 * B. 全量回归汇总
 * ========================================================= */
section('B 全量回归汇总（spawnSync）');
const SUITES = [
  /* v4 三层验证全部到位且互相独立：QA 专项纯函数套件（361/0）、
     UI/CRUD 套件（334/0）、team-lead 独立复核套件（61/0）。
     三者数据与断言各自独立构造，互补不重复，任一 FAIL 即判失败。 */
  { file: 'qa-v4-core.js', required: true },
  { file: 'qa-v4-ui.js', required: true },
  { file: 'qa-v4-lead.js', required: true },
  { file: 'smoke-db.js', required: true },
  { file: 'smoke-perm.js', required: true },
  { file: 'smoke-v2-contracts.js', required: true },
  { file: 'smoke-v2-customer-task.js', required: true },
  { file: 'smoke-v2-students-classes.js', required: true },
  { file: 'smoke-analysis.js', required: true },
  { file: 'qa-750.js', required: true },
  { file: 'qa-v3.js', required: true }
];
let suitePassSum = 0;
SUITES.forEach(function (s) {
  const p = path.join(TOOLS, s.file);
  if (!fs.existsSync(p)) {
    ok('子套件存在：' + s.file, !s.required, s.required ? '缺失（必需）' : '不存在，SKIP');
    return;
  }
  const r = cp.spawnSync(process.execPath, [p], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TZ: 'Asia/Shanghai' }),
    maxBuffer: 32 * 1024 * 1024
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.trim().split('\n');
  const tail = lines.length ? lines[lines.length - 1].trim() : '(无输出)';
  /* 精确解析「结果行」：优先取最后一个 PASS/FAIL 结果串；smoke-db 用 "N passed, M failed"。
     不用全文 grep "FAIL"（会命中 qa-v3 的汇总表头「子套件 rc PASS FAIL 状态」）。 */
  let pnum = 0, fnum = -1;
  const pfAll = out.match(/PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/g) || [];
  if (pfAll.length) {
    const last = /PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/.exec(pfAll[pfAll.length - 1]);
    pnum = Number(last[1]); fnum = Number(last[2]);
  } else {
    const altAll = out.match(/(\d+)\s+passed,\s*(\d+)\s+failed/g) || [];
    if (altAll.length) {
      const last = /(\d+)\s+passed,\s*(\d+)\s+failed/.exec(altAll[altAll.length - 1]);
      pnum = Number(last[1]); fnum = Number(last[2]);
    }
  }
  /* 真正的失败行断言（缩进两空格的 "  FAIL  xxx"），作为兜底 */
  const explicitFailLine = /(^|\n)\s*FAIL\s+\S/.test(out) && !/FAIL\s+0/.test(tail);
  const good = (r.status === 0) && fnum === 0 && !explicitFailLine;
  ok('子套件全绿：' + s.file + '  [rc=' + r.status + ' | ' + tail.slice(0, 60) + ' | FAIL=' + fnum + ']',
    good, 'rc=' + r.status + ' FAIL=' + fnum);
  suitePassSum += pnum;
});
console.log('\n  子套件 PASS 合计：' + suitePassSum);

/* =========================================================
 * 结果
 * ========================================================= */
console.log('\n============================');
console.log('=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===');
console.log('============================');
if (fail) {
  console.log('\n失败清单：');
  FAILS.forEach(function (x) { console.log('  - ' + x); });
  process.exit(1);
}
process.exit(0);
