# QA v2 报告（对抗性验证）

> **口径更新（2026-11-11，原文未改动）**：本篇为历史报告，其中涉及权限与价目的旧口径请按最新实现理解 ——
> ① **T6 反转**了成绩模块权限：管理员与教师同权使用「成绩管理」，文中「管理员不见成绩 / 教师专属」相关段落已作废；
> ② **T8 收紧**了顶栏「清空数据」：管理员专属 + 需输入确认词「清空」，前三个按钮仍对 `canEdit()` 账号可见；
> ③ **T9 改造**了合同价目模型：价目改为「一个报读方案一行」（`plan_name` + `stages jsonb` + 方案级优惠），文中按「年份×年级×阶段×方案」描述的价目结构已作废。
> ④ **T11 再改造**：合同可同时报**多个**方案（各方案独立计价与优惠、结余整单一个）；价目新增 `remark` 备注列；
>    明细单去掉公式注释（不再有 `（O）`/`S =`/底部「口径：…」块），「电子账户结余抵扣」与「优惠（…）」行改为条件渲染。
>    文中关于「报读方案下拉单选」「明细单 7 行固定」「管理员不能……」的价目/明细描述按最新实现理解。
> 本报告当时的结论（2 个阻塞 Bug + 5 条建议）均已修复并通过复验，原结论与证据保留。

> 执行者：Edward（独立 QA）。原则：不修改任何源码 / 测试 / 构建脚本 / 配置；只报告。
> 所有结论均附「文件:行号」或「实际执行的命令 + 输出原文」。
> 临时验证脚本全部放在 `/tmp/`（`qa-xss.js` / `qa-xss2.js` / `qa-price.js` / `qa-custats.js` / `qa-time.js` / `qa-perm.js` / `qa-db.js`），未写入项目目录。
> 唯一新增的项目文件是本报告。另：按基线要求执行了 `python3 build-single.py`，它生成了 `2026-10-20-17-22-01/学生管理系统-单文件版.html`（注意在**父目录**，非项目根，详见 S-3）。

---

## 结论

| 项 | 值 |
|---|---|
| 发现**阻塞级** Bug | **2 个** |
| 发现**建议级**问题 | 5 个 |
| 总体判定 | **修复后上线** |

**一句话**：功能面（XSS / 计价 / 统计口径 / 权限四层 / 时间边界 / 空态）实测**全部通过**，而且过了"算例 4 取整陷阱"这个硬骨头；但 `App.DB` 的**离线补偿逻辑**有两个会造成**云端数据被改坏**的缺陷（误删班级成员、重复插入客户/待办），这两条必须在真机多端并发前修掉。

---

## 一、测试基线（原文照抄各套末行）

| 套件 | 末行原文 | 退出码 |
|---|---|---|
| `smoke-analysis.js` | `=== 结果：PASS 247 / FAIL 0 ===` | 0 |
| `smoke-locator.js` | `=== 结果：PASS 37 / FAIL 0 ===` | 0 |
| `qa-750.js` | `结果：PASS 305 / FAIL 0` | 0 |
| `smoke-perm.js` | `=== 结果：PASS 80 / FAIL 0 ===` | 0 |
| `smoke-v2-students-classes.js` | `=== 结果：PASS 100 / FAIL 0 ===` | 0 |
| `smoke-v2-customer-task.js` | `=== 结果：PASS 100 / FAIL 0 ===` | 0 |
| `smoke-v2-contracts.js` | `=== 结果：PASS 135 / FAIL 0 ===` | 0 |
| 合计 | **PASS 1004 / FAIL 0** | — |

`node --check` 逐个检查 23 个 `js/*.js`，**全部通过**：

```
$ for f in js/*.js; do node --check "$f"; done | grep -v "^OK"
语法检查完成（以上为失败项，无输出表示全部通过）
23
```

```
$ python3 build-single.py
已生成: /Users/guoyuanyang/WorkBuddy/2026-10-20-17-22-01/学生管理系统-单文件版.html
体积: 603.1 KB
```

> 基线全绿 —— 但这只说明"作者自己的断言被自己的实现满足了"。以下 A–J 是我独立构造的反例。

---

## 二、数据红线 G1

**我无法独立验证 fp**，如实说明：

- `docs/baseline-score.txt` 只记录了 `n = 40` 与两个指纹值（第 21 行 `fp = af05d139d587b91d331d7a3348270750`），**没有保存 40 行明细**，因此无法在本地重算 md5。
- 我没有云端数据库凭据，不能执行那条 SQL。
- 项目不是 git 仓库（`git rev-parse` 退出码 128），无法用 diff 证明"改版前后 `score_records` 未被触碰"。

我能给出的间接证据（均为实测）：

1. `App.DB` 对 `score_records` / `user_profiles` 有硬防火墙，实测拒绝：

```
$ node -e '...App.DB.define("score_records")...'
✓ score_records 被拒绝注册：表 score_records 归 sync.js 独占，App.DB 不得注册
✓ user_profiles 被拒绝注册：表 user_profiles 归 sync.js 独占，App.DB 不得注册
✓ App.DB.table(score_records) 被拒：未注册的数据表：score_records（请先调用 App.DB.define）
已注册表清单：students, classes, class_members, customers, daily_tasks, contract_prices, contracts
```

2. 本轮新增的 7 个模块里**没有任何一处**绕过 `App.DB` 直连云表：

```
$ grep -nE "\.from\('" js/module-*.js     → 无输出
$ grep -n "Sync.db()" js/module-*.js      → 无输出
```

3. `js/sync.js` **完全没有引用** 7 张新表：

```
$ grep -nE "students|classes|customers|daily_tasks|contract_prices|contracts|class_members" js/sync.js
(无输出)
```

4. `js/db.js:23` 的 `FORBIDDEN` 常量与 `js/db.js:149` 的注册拦截确实生效（同上实测）。

**结论：G1＝未验证（客观不可验证）**。建议由能连云端的人在改版前后各跑一次口径 A SQL 存档，不要用"代码没改"替代"数据没变"。

---

## 三、阻塞级 Bug（必须修）

### BUG-1 孤儿清理会**误删正常班级成员**（云端数据丢失，静默）

- **位置**：`js/db.js:284`（写入 `loaded`）、`js/db.js:313-328`（`cleanOrphans`）、`js/db.js:278-287`（`fetchTable`）
- **根因**：`loaded[name]` 记录的是「**曾经**成功过」，而不是「**本轮**成功」。全文件只有 `db.js:284` 一处赋值 `= true`，**从不复位**：

```
$ grep -n "loaded" js/db.js
32:  var loaded = {};      // name → 最近一次全量拉取是否成功（孤儿清理前置条件）
284:      loaded[name] = true;
314:    if (!loaded.students || !loaded.classes) return;
427:    loaded: loaded
```

  于是 `db.js:314` 那句守卫 `if (!loaded.students || !loaded.classes) return;` 的注释承诺（"只有 students 与 classes 都拉取成功才动手 —— 否则会把「没拉到」误判成「不存在」"）**并不成立**。

- **触发链**：`fetchTable` 在 `res.error` 时直接 `return false`，**不更新也不清空缓存**（`db.js:281-286`）→ 本轮 `cache.classes` 是上一轮的旧数据 → 但 `class_members` 本轮拉取成功、包含了新班的成员 → `cleanOrphans`（`db.js:322-327`）判定该成员"父班不存在"→ 直接 `delete().eq('id', ...)` 从云端删除。
- **复现（实测，非推演）**：

```
$ node /tmp/qa-db.js
=== 场景 1：首轮全部成功（建立 loaded 基线）===
  loaded = {"students":true,"classes":true,"class_members":true,...}
  删除调用 = 无 ✓

=== 场景 2：classes 本轮拉取失败，但云上已新增 c2 班与其成员 ===
  classes 缓存 = ["c1"]
  class_members 缓存 = ["m1"]
  本轮云端删除调用 = class_members:m2
  ✗ 误删了合法成员 m2（父班 c2 本轮只是拉取失败，并未被删除）
```

- **期望**：拉取失败的表的缓存必须视为"未知"，本轮跳过孤儿清理。
- **实际**：按陈旧缓存判定，永久删除云端桥表行。
- **影响**：某次网络抖动后，另一位老师刚建好的班级里的学生**全部从班级消失**（成绩还在，但班级统计 `classAssScoreAnalysis` 的"可分析学生数"归零）。用户看不到任何报错，也没有撤销入口。
- **放大器**：`App.DB` 的 `cache` 与 `loaded` 在登出时**完全不重置**（`App.DB.stop()` 只清 timer；`js/sync.js` 全文无任何 `App.DB` 复位调用）：

```
$ grep -n "App.DB" js/sync.js js/app.js
js/sync.js:1639:    /** 把 cloud 实例暴露给 App.DB ... */
js/app.js:268:    if (App.DB && App.DB.start) {
```

  意味着 A 账号登出、B 账号登录后，`loaded.classes` 仍是 A 那次留下的 `true` —— 第一次 refresh 就要拿 B 的缓存去对 A 的 `loaded` 做判断。

### BUG-2 失败重放会**重复插入**客户 / 待办（云端无唯一约束兜底）

- **位置**：`js/db.js:341-359`（`flushRetry` 重放）、`js/db.js:220`（insert 失败入队）、`js/db.js:410-411`（表定义 `unique: []`）
- **根因**：insert 失败入队后，重放逻辑 `db.js:344` 直接再 `insert(item.payload)`，**没有任何幂等键**（`id` 由云端生成、payload 里没有客户端 uuid）。若某次请求"服务端已写入成功、客户端拿到错误"（超时 / 响应中断 / 移动网切换），重放就会写第二条。
- **云端为什么挡不住**：`docs/ddl-v2.sql` 里只有 5 个唯一索引，`customers` 与 `daily_tasks` **没有任何唯一约束**：

```
$ grep -nE "unique|UNIQUE" docs/ddl-v2.sql
49:  CREATE UNIQUE INDEX IF NOT EXISTS uk_students_key ON students (stu_name, school, grade);
86:  CREATE UNIQUE INDEX IF NOT EXISTS uk_classes_name ON classes (class_name);
118: CREATE UNIQUE INDEX IF NOT EXISTS uk_members_pair ON class_members (class_id, student_id);
249: CREATE UNIQUE INDEX IF NOT EXISTS uk_prices_key ON contract_prices (year, grade, stage, plan);
293: CREATE UNIQUE INDEX IF NOT EXISTS uk_contracts_key ON contracts (stu_name, grade);
```

- **复现（实测）**：

```
$ node /tmp/qa-db.js
=== 场景 3：retry 队列重放是否会重复插入 ===
  customers insert 实际调用云端次数 = 2（期望 1，若为 2 则同一条数据被写两次）
  customers 表 unique 键 = []（为空则云端无法用唯一约束挡住重复）
  daily_tasks 表 unique 键 = []
  ✗ 存在重复插入风险
```

- **影响**：客户统计口径直接被污染 —— 「总资源数」「签单金额」都会因为同一客户存在两行而虚高（`module-customers.js:244-251` 是逐行累加，不做去重）。而页面上的重复行看起来像"录入时手抖点两次"，用户很难判断是系统还是人。
- **对比**：`students` / `classes` / `contract_prices` / `contracts` 因为有 `uk_*`，重放会被 23505 拦住，`db.js:349` 有对应分支（`if (item.kind === 'insert' && isUniqueViolation(res.error)) return fails;`），所以这 4 张表安全。**只有 customers 和 daily_tasks 裸奔。**

---

## 四、建议级问题（不阻塞）

### S-1 `select('*')` 无分页，超上限会静默截断（架构风险）

- **位置**：`js/db.js:281`（7 张新表全量拉取）、`js/sync.js:1320`（`score_records` 拉取）
- **证据**：全项目**没有任何** `.range(` / `.limit(` / `.offset(`：

```
$ grep -nE "\.range\(|limit\(|offset\(" js/db.js js/sync.js
(无输出)
```

  而 SDK 本身是提供了 `range(` 与 `limit(` 方法的（抓取 CDN 产物可见各 1 处定义）：

```
$ curl -sL "https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js" -o sdk.js
$ grep -o -E "(max-rows|maxRows|Range|Content-Range|limit\(|offset\(|1000|range\()" sdk.js | sort | uniq -c
   1 limit(
   1 range(
```

- **风险等级**：**中**。PostgREST 默认 `db-max-rows` 通常是 1000，客户端拿不到"被截断"的信号（200 + 部分数据），代码也没有行数校验。
- **触发条件**：任一表行数 > 服务端上限。`score_records` 目前 40 行，短期无风险；`customers` / `daily_tasks` 是持续累积型，长期会撞线。
- **后果**：**只丢可见性、不丢数据** —— `js/sync.js:1326-1329` 的 `pullChanges` 只在记录命中 `deletedKeys` 时才不回填，不会删除云端多余行，所以超限不会造成删除。表现为"后录入的数据在列表里查不到，但云端有"。
- **建议**：`fetchTable` 加分页循环 + 拉完比对 `count(*)`。

### S-2 retry 队列只存在内存里，刷新即丢

- **位置**：`js/db.js:30`（`var retry = []`）
- 未持久化到 localStorage。用户断网时录入的数据入队后，一旦关页 / 刷新，队列清空且**没有任何提示**，用户以为已保存（`failToast` 只说「同步失败 · 请重试」）。
- 建议：队列写 localStorage，重放成功再清；启动时提示"有 N 条未同步"。

### S-3 单文件产物落在**父目录**，且仍依赖 CDN

- **位置**：`build-single.py:5-6`（`ROOT = dirname(dirname(...))`、`SRC = ROOT/学生管理系统`）、`:26`（`out = ROOT/学生管理系统-单文件版.html`）
- 实测产物路径为 `/Users/guoyuanyang/WorkBuddy/2026-10-20-17-22-01/学生管理系统-单文件版.html`，**不在项目根 `学生管理系统/` 内**。谁在项目根找这个文件会找不到。
- 另外 `index.html:44` 的 CDN `<script>` 被原样保留进单文件：

```
$ grep -o 'cdn.jsdelivr.net[^"]*' 学生管理系统-单文件版.html
cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js
```

  所以"单文件"**不是离线可用**，断网双击会白屏在登录页（SDK 未定义 → `sync.js` 走不通）。若宣传为"双击即用"需修正口径。

### S-4 删学生的桥表失败被静默吞掉，却仍提示"已删除"

- **位置**：`js/module-students.js:421`
  ```js
  return membersTable().remove(m.id).catch(function () { });   // 失败被吞
  ```
- 桥表删除失败时依旧继续删主行，并 `Toast('已删除学生...', 'ok')`（`module-students.js:426`）。补偿完全依赖 BUG-1 里那个有缺陷的 `cleanOrphans`。
- 期望（PRD 无明文，属健壮性）：桥表清理失败应提示"已删除学生，但班级归属清理失败，将自动重试"。

### S-5 导航排序比较函数不是合法 comparator

- **位置**：`js/app.js:74-81`
  ```js
  return list.sort(function (a, b) {
    if (a.home) return -1;   // a 与 b 都是 home 时也返回 -1，违反反对称
    if (b.home) return 1;
  ```
- 当前只有 1 个 `home` 模块，实际输出正确（实测顺序见下），属潜在雷而非现症。建议改成 `(b.home?1:0)-(a.home?1:0)`。

### 附：T6 口径带来的运营风险（非 bug，提示）

`js/perm.js:149-152` 的 `assertScoreAction()` 只判 `canEdit()`，不判角色，且 `js/app.js:311-383` 用它守卫「备份导出 / 恢复导入 / 清空数据 / 生成示例数据」。按 T6「成绩管理管理员与教师同权」的口径这是**预期行为**，但等于**任何教师都能一键清空全部成绩记录**（`app.js:350-368` → `App.Sync.markAllDeleted()`）。请产品确认这是有意为之，否则就是 G1 红线的最大人为风险点。

---

## 五、逐项验证结论

### A. XSS —— **通过**

- 转义函数 `js/core.js:99-103` 实现完整（`& < > " '` 五个全转），无遗漏：

```js
esc: function (s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

- **动态验证**（把所有云端字段灌成 `"><img src=x onerror=alert(1)>` 与 `<script>alert(2)</script>`，渲染 8 个模块后扫描原始标签）—— 8 个模块全部干净：

```
$ node /tmp/qa-xss.js
=== 列表/看板渲染 XSS 扫描 ===
  ✓ home 无未转义载荷（输出 2484 字符）
  ✓ score 无未转义载荷（输出 1070 字符）
  ✓ students 无未转义载荷（输出 3494 字符）
  ✓ classes 无未转义载荷（输出 1072 字符）
  ✓ customers 无未转义载荷（输出 4371 字符）
  ✓ tasks 无未转义载荷（输出 1262 字符）
  ✓ contracts 无未转义载荷（输出 4633 字符）
  ✓ users 无未转义载荷（输出 655 字符）
=== 结果：未转义点 0 处 ===
```

- **静态交叉验证**：扫了 6 个模块所有"像 HTML 拼接"的行，共 127 处云端字段引用，29 处初筛候选**全部人工看过，均为误报**：
  - `opts()` / `UI.optionsWithLabel()` 内部已 `esc`（`module-customers.js:294-305`、`ui-kit.js:233-240`）
  - `Ue` 就是 `U.esc` 的别名（`module-score.js:12`）
  - `t.name` / `info.desc` / `info.label` 是**静态枚举**，不是云端数据（`module-customers.js:761`、`module-users.js:19-24,111`）
- **重点逐项确认**：
  - 学生姓名 / 学校：`module-students.js` 列表与详情均 `esc`（`module-classes.js:539-542`、`module-customers.js:388-389`）
  - 客户 6 个备注字段（多行文本，最易漏）：唯一渲染点是 `module-customers.js:537` 的 `<textarea>`，用 `esc(v[n.name])`；详情弹窗走 `t()` 包装 `esc`（`:674-677, 714`）。`</textarea>` 逃逸被 `&lt;` 挡住。
  - 待办标题 / 备注：`module-tasks.js:407` `esc(v.remark)`
  - 班级名 / 老师名 / 课室：`module-classes.js:483-488` 全部 `esc`，`teachers` 数组 `(c.teachers||[]).join('、')` 后再 `esc`
  - jsonb 数组元素：`module-classes.js:541-542`、`module-customers.js:697` 均 `join` 后 `esc`
- 注意：`module-customers.js:719` 的 `title: '客户详情 · ' + row.stu_name` **没有显式转义**，但 `core.js:209` 的 Modal 对 `opts.title` 做了 `U.esc(opts.title)`，因此安全 —— 属"依赖下游转义"，建议顺手补上以免将来换渲染方式时爆掉。

### B. PostgREST `numeric` 字符串导致的隐式拼接 —— **通过（已全部转换）**

- 合同模块：`num()` 定义在 `module-contracts.js:75-78`（`Number(v)` 非有限值退 `0`），所有金额运算**无一处绕过**：
  - `module-contracts.js:220` 单价 `round2(num(price.unit_price))`
  - `module-contracts.js:984-986` 台账汇总 `sumPay += num(r.payable_amount)` / `sumOrig += num(r.original_amount)` / `sumDisc += num(r.discount_amount)`
  - `module-contracts.js:1107` `round2(num(row.account_deduction) + num(row.balance_remain))`
  - `module-contracts.js:1037-1039` 台账行渲染
- 客户模块：`module-customers.js:249` `var amt = Number(r.paid_amount) || 0;`
- 实测字符串累加（`"1234.50"+"0.10"+"0.20"`）：

```
$ node /tmp/qa-custats.js
  signed=3，signedAmount=1234.8（期望 1234.50+0.10+0.20 = 1234.80）→ ✓
```

- 班级成绩统计（`scores` 数组元素类型）：实测字符串与数字结果完全一致（已归一）：

```
数字 scores [100,100,100] → 班均总分=300  参考人数=1  平均得分率=0.6667
字符串 scores ["100","100","100"] → 班均总分=300  参考人数=1  平均得分率=0.6667
✓ 字符串与数字结果一致（已归一）
```

- 结论：**未发现拼接风险**。

### C. 权限四层 —— **通过（独立实测，未复用 smoke-perm.js）**

```
$ node /tmp/qa-perm.js
=== L1 导航 ===
  ✓ 教师导航只有 score（实际：score）
  ✓ 管理员业务导航 = home → score → students → classes → customers → tasks → contracts → users
=== L2 站内跳转越权 → 回退 ===
  ✓ 教师 go("students") 回退到成绩管理（标题=成绩管理）
=== L3 地址栏直达越权 → 403 ===
  ✓ 教师 hashchange 直达 customers → 403 卡片
=== L3 每个模块 render() 直调 403 自检 ===
  ✓ home / students / classes / customers / tasks / contracts / users 教师直调 render → 403
  ✓ score 教师可用（T6 反转，无 403）
  ✓ score 管理员可用（T6 反转，无 403）
=== L4 写入守卫 ===
  ✓ 教师写学生/班级/客户/待办/合同表 → 拒绝    ✓ 教师写成绩 → 允许
  ✓ 只读 / 停用 / 已删除账号写任何表 → 拒绝
  ✓ 正常管理员写学生表 / 成绩 → 允许
=== L4 App.DB 层是否真的每次调 assertWrite ===
  ✓ students / classes / class_members / customers / daily_tasks / contract_prices / contracts
    insert/update/remove → DENIED/DENIED/DENIED
  结论：App.DB 全部在写前拦截 = ✓
结果：权限层不符 0 项
```

- **L1**：`js/app.js:65-82` `navList()`；`adminOnly && !isAdmin()` 过滤（`:68`），`teacherOnly && isAdmin()` 过滤（`:69`）。8 模块 `order`：home（`home:true`）→ score 5（`module-score.js:1350`）→ students 10 → classes 20 → customers 30 → tasks 40 → contracts 50 → users 无 `order`（默认 100，`app.js:77-78`），因此顺序天然正确。教师侧「规划中」模块也不渲染（`app.js:101` 三元）。
- **L2**：`js/app.js:118-132` `pickModule()`；`if (mod && !allowed(mod) && !directAccess) mod = null;`（`:126`）→ 回退 `fallbackModule()`（`:85-91`，取第一个 `ready`）。绕过写法已排查：`go()` 在 `:186` 强制 `directAccess = false`，`hashchange` 在 `:286` 强制 `= true`，`DOMContentLoaded` 首屏带 hash 在 `:277-280` 强制 `= true` 后立即复位。**未发现可绕过的写法。**
- **L3**：8 个模块 `render()` 首行**全部**有自检，无一遗漏：
  `module-home.js:53`、`module-score.js:1355`、`module-students.js:538`、`module-classes.js:674`、`module-customers.js:758`、`module-tasks.js:513`、`module-contracts.js:1331`、`module-users.js:40`。
- **L4**：
  - `canEdit()` **在角色判定之前**（`perm.js:136` 先判 `canEdit()`，`:138` 才走 score 特例，`:139` 走 `allowed()`）→ 只读账号不会因 score 分支越权。**实测只读账号写成绩被拒**（见上）。
  - 只读 / 停用 / 已删除 / 未登录：`sync.js:630-633` `canEdit()` 要求 `signedIn && !profileError && status==='active'`；未注册模块 id 兜底为管理员专属（`perm.js:134-135`）。实测全拒。
  - `App.DB` 的 `insert/update/remove` **每次**都调 `assertWrite`：`db.js:205`、`db.js:228`、`db.js:252`。实测 7 张表 × 3 操作 = 21 条路径全部 DENIED。
  - **无模块绕过 `App.DB`** 直连 `App.Sync.db()`（grep 无输出，见 G1 第 2 条）。

### D. 合同计价 —— **通过（全部手算复核）**

手算（PRD §6.4）后与实现逐一对照，实现位于 `js/module-contracts.js:199-266`：

| 算例 | 手算 | 实测 | 判定 |
|---|---|---|---|
| 1｜高二 AB 3 科 85 折 结余 500 | O=7800, T=6630, D=1170, M=600, S=7230, C=500, **P=6730** | 完全一致 | ✓ |
| 2｜初三 单A 2 科 8 折 | O=1800, T=1440, D=360, M=200, **P=1640** | 完全一致 | ✓ |
| 3｜高一 单B 1 科 优惠 300 结余 2000 | O=1500, T=1200, M=100, **C=1300, P=0, R=700** | 完全一致 | ✓ |
| 4｜3 科各 1234.50，85 折 | T=round2(3147.975)=**3147.98**, P=3447.98 | `T=3147.98`、`money()="3147.98"` | ✓ |

```
$ node /tmp/qa-price.js
✓ 算例1 {"O":7800,"T":6630,"D":1170,"M":600,"S":7230,"C":500,"P":6730,"R":0}
✓ 算例2 {"O":1800,"T":1440,"D":360,"M":200,"S":1640,"C":0,"P":1640,"R":0}
✓ 算例3 {"O":1500,"T":1200,"D":300,"M":100,"S":1300,"C":1300,"P":0,"R":700}
✓ 算例4 {"O":3703.5,"T":3147.98,"D":555.52,"M":300,"S":3447.98,"C":0,"P":3447.98}
    T 的字符串形式 = 3147.98（期望 3147.98）
```

- **关键取整陷阱确认已避开**。`toFixed(2)` 确实会给错答案，而实现没用它：

```
$ node -e 'const p=3703.5*0.85; console.log(String(p), "| toFixed:", p.toFixed(2), "| *100:", p*100)'
3147.975 | toFixed: 3147.97 | *100: 314797.5
```

  `js/ui-kit.js:23-28` 用 `Math.round(Math.abs(v)*100 + 1e-9)/100` → `314797.5 → 314798 → 3147.98` ✓。
- 逐项确认：
  - 折扣**只**作用于课时费合计，资料费不参与：`module-contracts.js:248` `tuition = round2(original * rate)`，`:259` `subtotal = round2(tuition + material)`，`material` 在 `:240` 独立算。
  - **一次性取整**而非逐科取整：`original` 先合计（`:234-239`），再整体乘系数（`:248`）。✓
  - 结余 > 应付：`C = min(balance, subtotal)`（`:263`）、`P = subtotal - deduction`（`:264`），不出负数。实测 `P=0`、`R=998399`。
  - 缺价目：`missing.push(...)`（`:230`）+ `ok=false`（`module-contracts.js:401` 的 `probe`），金额与资料费都不计（`:217` `amount:0, material:0`）。实测 `missing=1, ok=false, O=0, M=0`。
  - 金额优惠超 O 截断：`:252` `if (off > original) off = original;`，实测 `T=0, P=100`（=100 资料费），符合"资料费不参与抵扣"。
  - 折扣系数 `85` 与 `0.85` 等价：`:117-122` `normRate`，实测 `T=1049.33` ✓。

### E. 客户统计口径 —— **通过（构造了字段混用反例）**

一条记录 `created_at` 在本月（11-05）、`visit_at` 在上月（10-20）、`paid_at` 在下月（12-03），分别查三个周期：

```
$ node /tmp/qa-custats.js
区间：prev = 2026-10-01 ~ 2026-10-31 / cur = 2026-11-01 ~ 2026-11-30 / next = 2026-12-01 ~ 2026-12-31
  ✓ prev → total=0 visited=1 signed=0 amount=0
  ✓ cur  → total=1 visited=0 signed=0 amount=0
  ✓ next → total=0 visited=0 signed=1 amount=1234.5
结果：口径不符 0 项
```

- 实现 `js/module-customers.js:242-253` 三个指标各用各自字段，**未混用**：
  - 总资源数 → `inR(r.created_at)`（`:244`）
  - 上门资源数 → `isTrue(r.visited) && inR(r.visit_at)`（`:245`）
  - 签单学生数 / 金额 → `isTrue(r.paid) && inR(r.paid_at)`（`:246-251`）
- 列表筛选的区间基准字段也是 `created_at`（`module-customers.js:218-220`），与"总资源数"口径一致；实测上月筛选命中 0 条（若误用 `visit_at` 会是 1 条）。
- 分类小计与总计勾稽一致（`byType` 合计 = 总计，实测 ✓）。

### F. 时间与周期边界 —— **通过**

```
$ node /tmp/qa-time.js
时区：Asia/Shanghai，UTC 偏移 8 小时
=== week 以周一为周首 ===
  ✓ 2026-11-15（周日）→ 2026-11-09 00:00 ~ 2026-11-15 23:59:59.999 [周一→周日]
  ✓ 2026-11-16（周一）→ 2026-11-16 00:00 ~ 2026-11-22 23:59:59.999 [周一→周日]
=== week 含首含尾 ===
  ✓ 周日 23:59:59.999 在区间内   ✓ 周一 00:00:00.000 在区间内
  ✓ 周一 -1ms 不在区间内         ✓ 周日 +1ms 不在区间内
=== month 月末 ===
  ✓ 2027-02 → ...-02-28 23:59:59.999（28 天）
  ✓ 2028-02 → ...-02-29 23:59:59.999（29 天，闰年）
  ✓ 2026-04（30 天）/ 2026-01（31 天）/ 2026-12（31 天）/ 2026-11（30 天）
=== 跨时区 ===
  ✓ 本地 11-01 00:30（UTC 串 2026-10-31T16:30:00.000Z）归 11 月
  ✓ 本地 11-30 23:30（UTC 串 2026-11-30T15:30:00.000Z）归 11 月
  ✓ 本地 12-01 00:00:00.000 不归 11 月
结果：时间边界不符 0 项
```

- 周一为周首：`js/ui-kit.js:104-109` `var back = (w === 0) ? 6 : (w - 1);`（周日回退 6 天）。✓
- 含首含尾：`js/ui-kit.js:146-150` `inRange` 用 `>= start && <= end`，`end` 为 `...23:59:59.999`。✓
- **时区**：`periodRange` 用本地构造的 `Date`（`ui-kit.js:128-143`），`inRange` 用 `toDate(ts).getTime()` 与区间端点比较 —— 云端 UTC ISO 串先被解析成绝对时刻，再与本地区间端点比较，**比较的是同一时间轴上的瞬时**，因此不存在"深夜 8 小时偏移导致跨期错账"。实测本地 00:30（=UTC 前一日 16:30Z）正确归入当月。
- 月末：`ui-kit.js:112` `new Date(y, m+1, 0, 23,59,59,999)` 自动处理闰年/大小月，三种月末实测正确。

### G. `App.DB` 写入可靠性 —— **部分不通过**

| 子项 | 结论 |
|---|---|
| retry 重放是否重复插入 | **不通过 → BUG-2**（customers / daily_tasks 实测写两次，云端无唯一约束兜底） |
| `class_members` 孤儿清理是否误删正常数据 | **不通过 → BUG-1**（`loaded` 粘滞，实测删掉合法成员 m2） |
| 删学生"先桥表后主行"中途失败 | **有条件接受**：顺序正确（`module-students.js:417-424`），桥表失败被 `.catch(()=>{})` 吞（`:421`），用户仍见"已删除学生"（`:426`）。有补偿（cleanOrphans）但补偿本身有 BUG-1。见 S-4 |
| 唯一键 23505 是否友好提示 | **通过**。实测：`重复学生 → 用户看到：「学生」已存在，请前往该记录修改`（`unique=true, code=23505`，`db.js:120-126`） |

### H. PostgREST 1000 行上限 —— **风险存在（中）**

见 **S-1**。要点：
- 无分页、无 `range()`、无行数校验（grep 无输出）。
- 超限行为：**静默截断**（客户端拿不到信号）。
- 触发条件：任一表 > 服务端 `db-max-rows`（PostgREST 惯例 1000）。
- 后果：**只影响可见性，不造成删除**（`sync.js:1326-1329` 只按 `deletedKeys` 跳过，不会删云端多余行）。因此定为「中」而非「高」。

### I. 单文件版可用性 —— **通过**

单文件产物内联完整性：

```
$ for m in core db perm ui-kit module-home ... module-users module-login sync app; do grep -c "===== $m.js =====" 学生管理系统-单文件版.html; done
core.js : 1   db.js : 1   perm.js : 1   ui-kit.js : 1
module-home.js : 1   module-score.js : 1   module-students.js : 1   module-classes.js : 1
module-customers.js : 1   module-tasks.js : 1   module-contracts.js : 1   module-users.js : 1
module-login.js : 1   sync.js : 1   app.js : 1
=== 残留 js 外链 === 0
=== 残留 css 外链 === 0
```

真实浏览器（Chrome headless，注入诊断脚本采集 `window.onerror` / `unhandledrejection` / `console.error|warn`）：

```
SDK 已加载        : True
window.App        : True
已注册模块顺序    : home → score → students → classes → customers → tasks → contracts → users → archive → attendance → timetable → homework
ready 模块        : home, score, students, classes, customers, tasks, contracts, users
auth-mode 类      : auth-mode
content 内容长度  : 3199
content 开头      : <div class="auth-page"><div class="auth-wrap"><div class="auth-brand">...
捕获错误数        : 0
未处理拒绝数      : 0
```

- 登录页正常出现（截图 `/tmp/qa-login.png`：左侧品牌区 + 右侧「登录 / 注册」表单，手机号/密码输入框、登录按钮、密码登录/验证码登录切换齐全，布局无错位）。
- **8 个业务模块全部注册，`ready` 顺序 = `home → score → students → classes → customers → tasks → contracts → users`，与要求完全一致**；另有 4 个 `FUTURE` 占位（`archive/attendance/timetable/homework`，`app.js:14-50`），非缺陷。
- **控制台 0 报错、0 未处理 Promise 拒绝。**
- 注：`nav` 内容长度为 0 是预期（`app.js:139` 在 `auth-mode` 下清空导航）。

### J. 空态与异常文案 —— **通过（7/7 逐字命中）**

```
✓ 学生空态：module-students.js ←「还没有学生档案。点右上『新增学生』开始，或从班级管理里添加学生。」
✓ 班内无学生：module-classes.js ←「本班还没有学生，请先在『班级学生』中添加」
✓ 班级空态：module-classes.js ←「还没有班级。点右上『新增班级』创建第一个班级。」
✓ 客户空态：module-customers.js ←「还没有客户资源。点右上『新增客户』录入第一条。」
✓ 任务空态：module-tasks.js ←「还没有任务。在下方输入框里写第一条待办，回车保存。」
✓ 价目空年份：module-contracts.js ←「该年份还没有价目」
✓ 登记页黄条：module-contracts.js ←「还没有价目，请先到『价目维护』录入」
```

- 筛选无结果另有独立文案：`module-classes.js:529`「没有符合条件的学生」；客户统计无数据：`module-customers.js:441`「当前周期没有资源数据，试试切换到更大的时间范围。」
- 403 三种场景（教师站内跳转 / 教师地址栏直达 / 教师直调 render）已在 C 节实测，文案统一为「该模块仅对管理员开放。如需使用请联系系统管理员。」（`perm.js:99-106`）。

---

## 六、我没能验证的部分（如实说明）

1. **G1 数据红线本身**：无法连云端 DB，`docs/baseline-score.txt` 未保存 40 行明细，无法重算 `fp=af05d139d587b91d331d7a3348270750`。只能证明"代码层面 `App.DB` 碰不到 `score_records`"，不能证明"数据没变"。**这是本次 QA 最大的验证缺口，务必由能连云端的人补一次口径 A 实测。**
2. **真实登录态**：需要手机号 + 短信验证码（`sync.js` 的验证码登录）/ 已设密码的账号，我无法自助完成。因此所有权限测试用的是 `App.Sync` 桩（`isAdmin/canEdit/profile/needLogin` 按真实实现的行为对齐），**真实 RLS / 服务端权限未验证**。
3. **真实多人并发**：BUG-1 / BUG-2 的触发是"某次请求失败"或"两老师同时写"，我用可控 stub 精确复现了逻辑，但没在真机上制造网络抖动去观察生产表现。
4. **服务端 `db-max-rows` 实际取值**：SDK 客户端无默认分页（已验证），服务端配置不可见，所以 H 的触发阈值（是否为 1000）是**推断**。
5. **图表渲染**：`js/charts.js` 的 SVG 输出未做像素级核对（`smoke-analysis` 覆盖了数值，未覆盖视觉）。
6. **`module-score.js` 中那 1 处 `.insert(`**：出现在 `module-score.js`，但成绩表归 `sync.js` 独占，我未逐行确认它是否只作用于非 `score_records` 的对象（本次重点是 v2 新增的 6 个板块，若需可追加）。

---

## 七、修复优先级建议

| 顺序 | 项 | 位置 | 理由 |
|---|---|---|---|
| 1 | BUG-1 `loaded` 每轮复位 | `db.js:284` / `:313` | 会造成**静默数据丢失**，且无撤销 |
| 2 | BUG-2 insert 幂等 | `db.js:341`，或给 customers/daily_tasks 补唯一索引 | 会造成**统计口径持续污染** |
| 3 | S-1 分页 | `db.js:281`、`sync.js:1320` | 长期必撞，越早越省事 |
| 4 | S-2 retry 持久化 | `db.js:30` | 用户丢数据却以为已保存 |
| 5 | S-3 产物路径 / CDN 口径 | `build-single.py:26`、`index.html:44` | 影响交付物预期 |
| 6 | S-4 / S-5 | 见上 | 健壮性与可维护性 |

---

*报告生成时间：2026-11-10。所有命令均在项目根目录执行，临时脚本位于 `/tmp/`。*
