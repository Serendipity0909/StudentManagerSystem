/* 冒烟测试：院校定位（locator.js）—— node tools/smoke-locator.js */
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = path.join(__dirname, '..', 'js');
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { getElementById: () => null, createElement: () => ({ style: {} }) }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
['core.js', 'data-locator.js', 'locator.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
});
const L = sandbox.window.App.Locator;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, actual, expect) {
  ok(name, actual === expect, '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expect));
}
/* 9 科：语文 数学 英语 物理 化学 政治 历史 地理 生物 */
const SC_PHY = [110, 120, 100, 80, 70, 60, 0, 55, 65];   // 物理>0 历史=0 → 物理类
const SC_HIS = [110, 120, 100, 0, 70, 60, 75, 55, 65];   // 历史>0 物理=0 → 历史类
function rec(o) {
  return Object.assign({ name: '张三', cls: '28届', exam: '一模', scores: SC_PHY.slice(),
    ranks: [1,2,3,4,5,6,0,8,9], totalRank: 0 }, o);
}

console.log('\n=== 院校定位冒烟测试（阈值表 ' + L.thresholds.length + ' 条）===\n');

/* 用例1：顺序取首个命中（28届二中物理类 985=30 > 双一流=25，非单调） */
console.log('用例1  顺序首个命中 · 已达最高档次');
eq('gradeOf("28届高三3班") 取届别', L.gradeOf('28届高三3班'), '28届');
let r1 = L.locate({ grade: '28届', school: '二中', track: '物理类', rank: 28 });
eq('档次', r1.tierName, '985层次');
eq('上限', r1.limit, 30);
ok('reachedTop', r1.reachedTop === true);
eq('名次差', r1.gap, 0);

/* 用例2：非单调中间档（28届二中历史类 985=10 双一流=6 特控=58 二本A=50）
   名次差口径 = 当前排名 − 紧邻上一档（双一流 6）的上限 */
console.log('用例2  非单调中间档 · 名次差取紧邻上一档');
let r2 = L.locate({ grade: '28届', school: '二中', track: '历史类', rank: 12 });
eq('档次', r2.tierName, '重点本科');
eq('上限', r2.limit, 58);
eq('上一档（紧邻）', r2.nextName, '双一流层次');
eq('名次差 = 12 - 6', r2.gap, 6);
ok('未误判为双一流（6 < 12）', r2.tierName !== '双一流层次');

/* 用例3：二本B < 二本A 的非单调行（29届华辰物理类 特控=495 二本A=750 二本B=699） */
console.log('用例3  二本A/二本B 顺序颠倒');
let r3 = L.locate({ grade: '29届', school: '华辰', track: '物理类', rank: 720 });
eq('档次', r3.tierName, '二本A');
eq('上一档', r3.nextName, '重点本科');
eq('名次差 = 720 - 495', r3.gap, 225);

/* 用例4：未达最低档次线 */
console.log('用例4  排名超二本B上限 → below-min');
let r4 = L.locate({ grade: '28届', school: '侨中', track: '物理类', rank: 2000 });
ok('ok=false', r4.ok === false);
eq('reason', r4.reason, 'below-min');
ok('row 已取到（供文案显示二本B上限）', r4.row && r4.row.tb === 1443);

/* 用例5：学校查不到 → no-school（严格 trim，禁止别名兜底） */
console.log('用例5  学校不在阈值表 → no-school（无别名兜底）');
['迪茵', '江门培英', '江门棠下', '江门省实', '华实', '古镇', '实中'].forEach(s => {
  let r = L.locate({ grade: '28届', school: s, track: '物理类', rank: 10 });
  ok('「' + s + '」→ no-school', r.reason === 'no-school', '实际=' + r.reason + '/' + r.tierName);
});
let r5 = L.locate({ grade: '28届', school: '华辰', track: '物理类', rank: 10 });
eq('「华辰」本身可直接命中 985层次', r5.tierName, '985层次');

/* 用例6：排名缺失 / 科类缺失 */
console.log('用例6  排名缺失 · 科类缺失');
eq('rank=0 → no-rank', L.locate({ grade: '28届', school: '侨中', track: '物理类', rank: 0 }).reason, 'no-rank');
eq('rank 空 → no-rank', L.locate({ grade: '28届', school: '侨中', track: '物理类' }).reason, 'no-rank');
eq('track 空 → no-track', L.locate({ grade: '28届', school: '侨中', rank: 10 }).reason, 'no-track');
eq('detectTrack(物理)', L.detectTrack(rec({ scores: SC_PHY })), '物理类');
eq('detectTrack(历史)', L.detectTrack(rec({ scores: SC_HIS })), '历史类');
eq('detectTrack(双缺考)', L.detectTrack(rec({ scores: [1,1,1,0,1,1,0,1,1] })), '');

/* 用例7：trim 严格匹配 + 支持名单 + 区块渲染 */
console.log('用例7  trim 匹配 · 支持名单 · 报告区块渲染');
let r7 = L.locate({ grade: '28届', school: '  侨中  ', track: '物理类', rank: 50 });
eq('带空格「  侨中  」trim 后命中', r7.tierName, '985层次');
let sup = L.supportedSchools('28届');
eq('28届支持学校数', sup.length, 17);
ok('含 侨中/华辰/实验/纪中', ['侨中', '华辰', '实验', '纪中'].every(s => sup.indexOf(s) >= 0));
let h7 = L.sectionHTML(rec({ school: '迪茵', cls: '28届高三3班', totalRank: 12 }), [], []);
ok('区块含主提示「暂无该学校数据，无法查询」', h7.indexOf('暂无该学校数据，无法查询') >= 0);
ok('区块含浅色辅助行「当前支持：」', h7.indexOf('当前支持：') >= 0);
let h7b = L.sectionHTML(rec({ school: '侨中', cls: '29届高三1班', totalRank: 500 }), [], []);
ok('29届含扩招备注', h7b.indexOf('29届扩招') >= 0);
ok('29届侨中物理类 r500 → 重点本科（985=60 / 双一流=240 均未达）',
  L.locate({ grade: '29届', school: '侨中', track: '物理类', rank: 500 }).tierName === '重点本科');

console.log('\n=== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ===\n');
process.exit(fail ? 1 : 0);
