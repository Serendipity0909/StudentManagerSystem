/* =========================================================
 * tools/qa-v3-data.js —— V3-1 数据基础设施回归（node tools/qa-v3-data.js）
 *
 * 目的：把 team-lead 在生产实测的 6 项断言固化成可复跑的机器校验，
 *       避免「文档写了通过、实际没人复核」。
 *
 * 数据来源：
 *   - docs/v3-postflight-snapshot.json  —— 生产实测前/后测量值（MCP db_exec_sql）
 *   - docs/backup-pre-v3.json          —— 改造前 42 行三列逐行底稿
 *   - docs/baseline-score.txt          —— 权威基线（口径 A + 口径 C）
 *
 * 本脚本不连云端：它校验「留证之间的自洽性」+「权威常量未被篡改」。
 * 云端真实值由 team-lead 用 MCP 复测（见 ddl-v3-exam-ym.sql 的校验 SQL）。
 * ========================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOCS = path.join(__dirname, '..', 'docs');
const snap = JSON.parse(fs.readFileSync(path.join(DOCS, 'v3-postflight-snapshot.json'), 'utf8'));
const backup = JSON.parse(fs.readFileSync(path.join(DOCS, 'backup-pre-v3.json'), 'utf8'));
const baseline = fs.readFileSync(path.join(DOCS, 'baseline-score.txt'), 'utf8');

let pass = 0, fail = 0;
const FAILS = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); return; }
  fail++;
  FAILS.push(name + (detail === undefined ? '' : '  → ' + detail));
  console.log('  FAIL  ' + name + (detail === undefined ? '' : '  → ' + detail));
}
function eq(name, actual, expect) {
  ok(name, actual === expect, '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expect));
}
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

console.log('\n=== V3-1 数据基础设施回归 ===\n');
console.log('[1] 权威常量与基线文档一致性');
const E = snap.expected;
ok('E-1 口径 A 常量出现在 baseline-score.txt', baseline.indexOf(E.fp_A) >= 0);
ok('E-2 口径 C 常量出现在 baseline-score.txt', baseline.indexOf(E.fp_C) >= 0);
ok('E-3 三列 fp3 常量出现在 baseline-score.txt', baseline.indexOf(E.fp3) >= 0);
ok('E-4 baseline-score.txt 含 v3 新基线章节', baseline.indexOf('v3 新基线') >= 0);
ok('E-5 baseline-score.txt 保留 40 行历史留证（不覆写）', baseline.indexOf('af05d139d587b91d331d7a3348270750') >= 0);
ok('E-6 baseline-score.txt 标注历史留证非本次基准', baseline.indexOf('历史留证，非本次基准') >= 0);
eq('E-7 backup 行数', backup.three_cols.length, E.n);
eq('E-8 backup _meta.rows', backup._meta.rows, E.n);
eq('E-9 backup _meta.fingerprint_A', backup._meta.fingerprint_A, E.fp_A);
eq('E-10 backup _meta.fingerprint_C_16cols', backup._meta.fingerprint_C_16cols, E.fp_C);

console.log('\n[2] 行数与指纹：ADD COLUMN + 定点回填前后逐字节不变');
const P = snap.pre, Q = snap.post;
eq('V-H1 行数（pre）', P.n, E.n);
eq('V-H1 行数（post）', Q.n, E.n);
eq('V-H1 口径 A pre == post', Q.fp_A, P.fp_A);
eq('V-H1 口径 A == 权威常量', Q.fp_A, E.fp_A);
eq('V-H1 口径 C pre == post', Q.fp_C, P.fp_C);
eq('V-H1 口径 C == 权威常量', Q.fp_C, E.fp_C);
eq('V-H1 列数 pre', P.cols, E.pre_cols);
eq('V-H1 列数 post（仅 +1）', Q.cols, E.post_cols);

console.log('\n[3] V-H2 三列零改写（逐行底稿复算）');
const rows = backup.three_cols.slice().sort((a, b) => a.id - b.id);
const fp3 = md5(rows.map(r => [
  String(r.id),
  r.entered_at == null ? '' : r.entered_at,
  r.updated_at == null ? '' : String(r.updated_at),
  r.last_editor == null ? '' : r.last_editor
].join('|')).join('\n'));
eq('V-H2 底稿复算 fp3 == 权威常量', fp3, E.fp3);
eq('V-H2 云端 post fp3 == 底稿复算', Q.fp3, fp3);
eq('V-H2 pre fp3 == post fp3', Q.fp3, P.fp3);
eq('V-H2 无自定义触发器（pre）', P.custom_triggers, 0);
eq('V-H2 无自定义触发器（post）', Q.custom_triggers, 0);
eq('V-H2 无列级 REVOKE', P.column_revoke, false);

console.log('\n[4] 回填结果：格式 / 分布 / 非法值');
eq('V-4.1 非法年月数', Q.bad_ym, E.bad_ym);
eq('V-4.2 2026-10 行数', Q.distribution['2026-10'], E.distribution['2026-10']);
eq('V-4.3 2026-11 行数', Q.distribution['2026-11'], E.distribution['2026-11']);
eq('V-4.4 分布合计 == 42', Q.distribution['2026-10'] + Q.distribution['2026-11'], E.n);

console.log('\n[5] 结构不变：触发器 / RLS / 索引 / 唯一键');
eq('V-5.1 触发器 pre == post', Q.custom_triggers, P.custom_triggers);
eq('V-5.2 RLS 策略数 pre == post', Q.rls_policies, P.rls_policies);
eq('V-5.3 RLS 策略数 == 4', Q.rls_policies, E.rls_policies);
eq('V-5.4 索引数 pre == post', Q.indexes, P.indexes);
eq('V-5.5 索引数 == 2', Q.indexes, E.indexes);
ok('V-5.6 唯一索引定义不变', Q.unique_index === 'score_records_unique_stu (stu_name, school, class_name, exam)');

console.log('\n[6] 新增列定义与权限');
const C = Q.exam_ym_column;
eq('V-6.1 exam_ym 类型 text', C.data_type, 'text');
eq('V-6.2 exam_ym 可空', C.is_nullable, 'YES');
eq('V-6.3 exam_ym 无 DB 默认值', C.column_default, null);
ok('V-6.4 authenticated 具备 INSERT/UPDATE/SELECT',
  ['INSERT', 'UPDATE', 'SELECT'].every(p => (C.grants.authenticated || []).indexOf(p) >= 0));
ok('V-6.5 anon 仅 SELECT（与既有列一致）',
  JSON.stringify(C.grants.anon) === JSON.stringify(['SELECT']));
ok('V-6.6 无列级 REVOKE（权限自动继承）', Object.keys(C.grants).length >= 3);

console.log('\n=== 结果：' + pass + ' PASS / ' + fail + ' FAIL ===');
if (fail) {
  console.log('\n失败项：\n  - ' + FAILS.join('\n  - '));
  process.exit(1);
}
console.log('V3-1 G1 红线全过，无需回滚。\n');
