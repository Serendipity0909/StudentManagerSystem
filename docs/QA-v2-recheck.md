# QA 复验报告（T7）

> **口径更新（2026-11-11，原文未改动）**：本篇为历史复验记录，涉及权限与价目的旧口径按最新实现理解 ——
> ① **T6 反转**成绩模块权限（管理员与教师同权）；② **T8** 将「清空数据」收紧为管理员专属 + 确认词；
> ③ **T9** 将合同价目改为「一个报读方案一行」；④ **T11** 合同支持多方案组合、价目加 `remark` 备注、
> 明细单去掉公式注释（结余/优惠行条件渲染）。当时的复验结论不变（BUG-1/2/3 均已修复、可上线）。

> 复验人：Edward（QA）· 复验日期：2026-11-10
> 范围：仅复验 BUG-1 / BUG-2 / BUG-3 的修复效果，独立构造场景验证，不依赖作者测试。
> 独立验证脚本：`/tmp/qa_recheck/harness.js`（vm 加载 `js/db.js` + 假 `App.Sync` / 假 gateway，46 项断言全部通过）、`/tmp/qa_recheck/probe_update.js`。脚本均在 `/tmp`，未改动项目任何源码/测试/构建脚本。

## 结论

- **BUG-1：已修复**（判据：全仓 `loaded` 变量已删除；`roundOk` 每轮清零；独立复现「第 2 轮 classes 失败」场景云端 delete 调用次数 = 0；真孤儿仍被清理；闸门②③生效；换号复位生效）
- **BUG-2：已修复**（判据：幂等戳入队 + 重放前回查；独立复现「写成功但响应丢失」场景云端最终 1 行、insert 仅 1 次；反向场景正常重试未被查重误伤）
- **BUG-3：已修复**（判据：class_members insert/update payload 均不含 `updated_at`，insert 含客户端写死的 `joined_at`；MCP 实测云端列与 `define()` 声明一致；其余 6 表 payload 无非法列）
- 回归：8 套全绿（末行原文见下）；`node --check` 全量 0 错误；`build-single.py` 构建成功（616.8 KB）
- **总体判定：可上线**（附 1 条低优先级遗留风险，见「我额外发现的问题」）

---

## BUG-1 复验

### 代码判据（`js/db.js`）

| 项 | 位置 | 证据 |
|---|---|---|
| `loaded` 完全消失 | 全仓 grep | `grep -rn "loaded" js/ tools/` 仅命中 `db.js:463` 的**注释**（"旧实现用 loaded…"）与上一轮 QA 报告的历史引文；代码中无任何 `loaded` 变量 |
| `roundOk` 每轮清零 | `db.js:469` | `Object.keys(roundOk).forEach(function (k) { delete roundOk[k]; });`（`refreshAll` 开头、拉取之前） |
| 只有本轮成功才置 true | `db.js:428-434` | `fetchTable` 成功分支 `roundOk[name] = true`（:430）；失败分支 `return false`，**cache 与 roundOk 均不动**（:432-434） |
| 闸门① 三表本轮都成功 | `db.js:498` | `if (!r.students \|\| !r.classes \|\| !r.class_members) return;`（`cleanOrphans` 首行） |
| 闸门② 主表空数组跳过 | `db.js:511` | `if (!students.length \|\| !classes.length) return;` |
| 闸门③ 删除失败不摘缓存 | `db.js:521-524` | delete 后 `if (res && res.error) return;` 才 `dropCache` |
| `syncOwner` 换号复位 | `db.js:448-456` + `:88-94` | owner 变化 → `resetState()`（原地清 cache / roundOk / retry） |
| `stop()` 复位 | `db.js:647-651` | `stop()` 末行调用 `resetState()` |

### 我的独立复现（harness.js 场景 1.0–1.5，输出原文）

**核心场景 1.1**——第 1 轮三表全成功（students=[1]、classes=[10]、members=[m100]）；第 2 轮前云端新增班级 99 与合法成员 m101（class_id=99），然后置 `classes.failSelect=true` 再 `refreshAll()`：

```
===== 场景 1.1（核心）：第 2 轮 classes 拉取失败，class_members 出现「第 1 轮没见过的班级」的成员 =====
  [PASS] 【BUG-1 判据】第 2 轮云端 class_members delete 调用次数 = 0（实际 0）
  [PASS] 第 2 轮 roundOk.classes 为空（本轮失败不复位旧值）
  [PASS] 第 2 轮 roundOk.students / class_members 仍 true（本轮成功）
  [PASS] 云端成员 101 仍在（未被误删）
```

> 该场景正是上一轮 BUG-1 的触发条件：旧实现会拿第 1 轮 classes 旧快照（只有班级 10）判 m101 为孤儿并删除。现实测 delete 调用次数 = 0，成员 101 完好。

### 反向验证（功能未被修坏）

```
===== 场景 1.2（反向）：真孤儿仍然被清理 =====
  [PASS] 真孤儿 102 / 103 已被清理，合法 100 / 101 保留（云端剩 [100,101]）
```

（102 = class_id 指向不存在的班级 777；103 = student_id 指向不存在的学生 999；两者都被清，合法行未受牵连。）

### 闸门②（主表空数组跳过）与闸门③（删除失败不摘缓存）

```
===== 场景 1.3：闸门② —— 主表本轮空数组 + 桥表有行 → 跳过 =====
  [PASS] 主表空数组时 0 次 delete（实际 0）
  [PASS] 成员 104 未被删
===== 场景 1.4：闸门③ —— 删除失败的行不摘缓存 =====
  [PASS] 删除失败时缓存仍保留该行（cache 里有 105）
  [PASS] 云端也保留（等下一轮再试）
  [PASS] 恢复健康后孤儿 105 被清理
```

### 换号复位（syncOwner）

```
===== 场景 1.5：syncOwner 换号复位 =====
  [PASS] 换号后 roundOk 全空
  [PASS] 换号后缓存全空（students 长度 0）
  [PASS] 换号后内存 retry 清空（长度 0）
  [PASS] cache / retry 仍是原引用（原地清空，未换引用）
```

### 结论：**已修复**。三道闸门 + 本轮语义 + 换号复位全部实测生效，且正常孤儿清理能力保留。

---

## BUG-2 复验

### 代码判据（`js/db.js`）

| 项 | 位置 |
|---|---|
| 客户端写死幂等戳 | `db.js:311`：`if (d.createdCol && !payload[d.createdCol]) payload[d.createdCol] = nowISO();` |
| 入队带 `createdAt` | `db.js:326-329`：`enqueueRetry({ kind:'insert', table, payload, createdAt: d.createdCol ? payload[d.createdCol] : '' })` |
| 重放前回查 | `db.js:541-562`：`replayInsert` 按戳列（`def.createdCol \|\| 'created_at'`）+ 唯一键 `.eq()` 回查，命中返回 `{skipped:true,row}`；回查失败退回直接写（23505 兜底，`db.js:556-557`） |
| 命中后收编缓存不写 | `db.js:585-588`：`if (res && res.skipped) { if (res.row) upsertCache(...); return fails; }` |
| 23505 第二道保险 | `db.js:590`：insert 重放撞唯一冲突 → 放弃 |

### 我的独立复现（harness.js 场景 2.1，输出原文）

**场景**：假 gateway 的 customers `onInsert` 钩子模拟「服务端已写入 1 行但响应在回程丢失」（写入后返回网络错）；随后 `flushRetry()` 重放：

```
===== 场景 2.1：insert 服务端已写入但响应丢失 → 重放不重复插入 =====
  [PASS] 第一次 insert 到达 gateway 1 次
  [PASS] 服务端已写入 1 行
  [PASS] 失败进入 retry 队列（长度 1）
  [PASS] 队列项带幂等戳 createdAt（2026-11-10T09:35:28.667Z）
  [PASS] flushRetry 返回失败数 0（实际 0）
  [PASS] 【BUG-2 判据】重放后 insert 总调用仍为 1（实际 1）
  [PASS] 【BUG-2 判据】云端最终行数 = 1（实际 1）
  [PASS] 重放命中后收编缓存（cache.customers 长度 1）
  [PASS] retry 队列原地清空（长度 0，引用不变）
```

### 反向验证（真失败 → 正常重试不被查重误伤）

```
===== 场景 2.2（反向）：第一次真失败 → 重放应补写 1 行 =====
  [PASS] 第一次失败：服务端 0 行
  [PASS] 重放补写成功：云端 = 1 行（实际 1）
  [PASS] 重放 insert 调用了第二次（总 2 次，查重未误伤正常重试）
  [PASS] flushRetry 无遗留失败（实际 0）
```

### daily_tasks 同口径 + 客户端写死 created_at

```
===== 场景 2.3：daily_tasks 同样具备幂等性 + 客户端写死 created_at =====
  [PASS] customers insert payload 含客户端写死的 created_at ISO 串（2026-11-10T09:35:28.667Z）
  [PASS] daily_tasks insert payload 含客户端写死的 created_at ISO 串（2026-11-10T09:35:28.723Z）
  [PASS] daily_tasks 幂等戳与 payload 一致
  [PASS] daily_tasks 重放后云端 = 1 行、insert 仍 1 次（实际 1 行 / 1 次）
```

（另注：`module-customers.js:605` 表单侧也自带 `created_at: new Date().toISOString()`，与 db 层双保险。）

### 结论：**已修复**。写丢响应不重插、真失败能补写、幂等戳确实由客户端写死并贯穿入队 → 回查 → 收编全链路。

---

## BUG-3 复验

### 1. class_members 的 insert/update payload（harness.js 场景 3.1 + probe_update.js，输出原文）

```
===== 场景 3.1：class_members insert/update payload 列核对 =====
  [PASS] insert payload 不含 updated_at
  [PASS] insert payload 含 joined_at（ISO 串：2026-11-10T09:35:28.728Z）
  [PASS] insert payload 列集合 = ["class_id","created_by","joined_at","last_editor","student_id"]
        （全部是实表列：id,owner_id,owner_name,last_editor,class_id,student_id,joined_at,created_by 的子集）
  [PASS] update 调用 1 次（实际 1）
  [PASS] 更新后 joined_at 保持原值未被回写
```

update 路径独立探针（probe_update.js）：

```
update 实际发送列 = ["created_by","last_editor"]
含 updated_at ? false
含 joined_at ? false
```

即：insert 补 `joined_at`（`db.js:311`，createdCol 声明于 `db.js:662`）、不写 `updated_at`（updatedCol:''）；update 删戳列（`db.js:340`）、不补 `updated_at`（`db.js:341` 对空串短路）。**「把学生加入班级」不再必然 42703。**

### 2. 云端实表列与 define() 声明逐一核对

用 MCP `db_describe_table`（应用 `wbapp_4awyu0XEG4n9gJgerWLkYW`）实测：

- **class_members**（实测）：`id, owner_id, owner_name, last_editor, class_id, student_id, joined_at(default now()), created_by` —— 与题目给的实测列一致，**确无 created_at / updated_at**，与 `define('class_members',{createdCol:'joined_at',updatedCol:''})`（`db.js:658-663`）吻合。
- **contracts**（实测）：含 `created_at / updated_at / created_by / last_editor` —— 与默认声明（created_at+updated_at）及 `module-contracts.js:910-931` payload 吻合。
- **daily_tasks**（实测）：含 `created_at / updated_at / created_by / last_editor / title / priority / due_at / status / done_at / remark` —— 与默认声明吻合。

其余 4 表（students / classes / customers / contract_prices）与 `docs/ddl-v2.sql` 逐列核对一致（DDL §①②④⑥：均含 created_at、updated_at、last_editor；customers 另含全部 28 个业务列）。

**逐表 payload 非法列探针**（harness.js 场景 3.2，对 7 张表各发一次 insert 后核对实际发送列 ⊆ 实表列）：

```
  [PASS] students insert payload 无非法列（多出列：[]）
  [PASS] classes insert payload 无非法列（多出列：[]）
  [PASS] customers insert payload 无非法列（多出列：[]）
  [PASS] daily_tasks insert payload 无非法列（多出列：[]）
  [PASS] contract_prices insert payload 无非法列（多出列：[]）
  [PASS] contracts insert payload 无非法列（多出列：[]）
```

**重点排查结论：除 class_members 外，没有别的表存在「写了不存在的列」**。自动补的三列（createdCol / updatedCol / last_editor）在 7 张表全都实际存在。

### 3. pick(row) 白名单性质

`db.js:122-132`：`pick` 只剔除 `id / owner_id / owner_name` 与 `undefined` 字段，**不做正向白名单**。实测探针（场景 3.3）：

```
  [INFO] 传入 __strange_field=1 后实际发到 gateway 的列：
         ["stu_name","school","grade","__strange_field","created_at","updated_at","last_editor"]
```

即：若未来某个模块往 insert/update 传入陌生字段，会原样透传到 PostgREST 触发 42703。**当前全部 7 个调用方（module-students/classes/customers/tasks/contracts 的 payload）已逐一核对无陌生字段**，故现在不炸；这是防御缺口而非现行 Bug（详见「我额外发现的问题」）。

### 结论：**已修复**。写入路径按声明补列，class_members 双向（insert/update）均不写非法列，7 表声明与云端实表全部吻合。

---

## 回归（8 套末行原文 + 全量检查）

```
$ node tools/smoke-analysis.js          → === 结果：PASS 247 / FAIL 0 ===
$ node tools/smoke-locator.js           → === 结果：PASS 37 / FAIL 0 ===
$ node tools/qa-750.js                  → 结果：PASS 305 / FAIL 0
$ node tools/smoke-perm.js              → === 结果：PASS 86 / FAIL 0 ===
$ node tools/smoke-v2-students-classes.js → === 结果：PASS 100 / FAIL 0 ===
$ node tools/smoke-v2-customer-task.js  → === 结果：PASS 100 / FAIL 0 ===
$ node tools/smoke-v2-contracts.js      → === 结果：PASS 135 / FAIL 0 ===
$ node tools/smoke-db.js                → smoke-db: 59 passed, 0 failed
```

- `node --check` 全量（js/*.js + tools/*.js）：0 错误（exit 0）
- `python3 build-single.py`：`已生成: …/学生管理系统-单文件版.html`，体积 616.8 KB

合计：8 套 1069 项断言全绿。

---

## 顺手确认项

1. **FUTURE 占位模块**（archive / attendance / timetable / homework）：
   - `js/app.js:37-39`：`FUTURE.forEach(… App.registerModule({ id, name, icon, ready: false, … }))` —— 4 个模块全部 `ready:false` ✓
   - `js/app.js:115`：`var soon = isAdmin() ? navList().filter(function (m) { return !m.ready; }) : [];` —— 「规划中」区块**仅管理员渲染**，教师侧为空 ✓
   - 教师导航 = `navList().filter(ready)`（`app.js:110`）且 `adminOnly` 对教师隐藏（`app.js:89`）；7 个业务模块 + home + users 均为 `adminOnly:true`，唯一非 adminOnly 且 ready 的是 `score`（`module-score.js:1346-1348`）→ **教师导航只剩「成绩管理」一项** ✓
2. **retry 原地清空**：`db.js:572`：`retry.length = 0;`（注释明说「原地清空而不是 retry = []」，`App.DB.retry` 导出的引用不变；harness 场景 2.1 已实测「长度 0，引用不变」）✓

## 我额外发现的问题

1. **【低优先级 · 防御缺口】`pick()` 不做列白名单**（`db.js:122-132`）：只做黑名单剔除（id/owner_id/owner_name），模块传来的任何陌生字段都会透传云端 → 42703。当前 7 个调用方 payload 已逐一核对干净，**不阻塞上线**；建议后续把 `define()` 扩展为完整列清单并让 `pick` 正向过滤（一劳永逸，顺带把 createdCol/updatedCol 声明合并进去）。
2. **【待复核 · 非本次范围】MCP `db_describe_table` 显示 class_members / contracts / daily_tasks 的 `RLSOn:false`**，而 `docs/ddl-v2.sql` 声明 `ENABLE ROW LEVEL SECURITY`。可能是 describe 工具口径问题，也可能策略未真正启用。授权（GRANT）仍在，anon 只有 SELECT，风险有限，但建议开发用 `db_list_rls` 复核一次策略是否挂载。

## 我无法验证的部分

- **真实网络环境下的 PostgREST 行为**（分页 range、23505、42703 报文格式）：本复验用假 gateway 模拟，协议语义按 PostgREST 文档对齐；线上端到端（真实浏览器 + 云端）未在本轮覆盖。
- **`stop()` 由登出真实触发的链路**（sync.js → App.DB.stop）：只验证了 `stop()` 本身会 `resetState()`（`db.js:647-651`）及 `resetState` 行为，未在完整应用里跑登出流程（回归套件已覆盖相关逻辑）。
- **retry 队列 localStorage 持久化**（saveRetry/loadRetry）：本复验 vm 环境无 localStorage，只验证了内存队列链路；持久化路径属 S-2 范围，非本次三个 Bug 的验证目标。
