# QA 报告 · v4 客户意向程度 + 结停课资源

| 项目 | 内容 |
|---|---|
| 版本 | v4 增量（客户管理 Tab① 意向程度 + Tab③ 结停课资源） |
| 报告日期 | 2026-11-27 |
| 权威契约 | `docs/ARCH-v4-customer-intent-stopres.md`（686 行）、`docs/PRD-v4-customer-intent-stopres.md`（499 行） |
| 交付边界 | R4 原为「先本地实现 + 全量测试」；用户 2026-11-27 明确授权后，**生产 DDL 已执行、已发布上线、已 commit/push**（见 §9） |
| 结论 | **IS_PASS: YES**：本地功能、生产库、线上版本、GitHub 仓库四端一致，v2/v3/v4 全量回归 0 失败 |

---

## 1. 交付背景（重要）

上一轮团队执行被中断，v4 **只完成 5 个设计文档，业务代码 0 行落盘**，导致用户在本地产物中看不到任何 v4 功能。本轮由 team-lead 亲自落盘核心 JS 保证确定性，并补齐测试护栏、QA 套件、文档与构建产物。

复核命令实测（中断前状态）：

```text
js/db.js 0 / js/ui-kit.js 0 / js/module-customers.js 0   ← v4 符号命中数全为 0
tools/smoke-db.js:222  eq('注册了 7 张表', ..., 7)
tools/smoke-perm.js:383 eq('App.DB 表数量（7 新表…）', ..., 7)
tools/qa-v4-*.js 不存在
git status: 仅 5 个 ?? docs/*v4* 文档，HEAD = 1be52ff（v3）
```

---

## 2. 改动文件清单

### 2.1 生产代码（3 个，v4 符号已全部落盘）

| 文件 | 改动 |
|---|---|
| `js/db.js` | 注册第 8 张表 `define('stop_resources', {module:'customers', unique:[], label:'结停课资源'})`；注释 7→8 表。**未改 `fetchTable` / `refreshAll` / `pick`**（J-1 裁决：单表容错是既存能力） |
| `js/ui-kit.js` | 新增 `INTENT_LEVELS=['低','中','高']`、`STOP_RESOURCE_TYPES=['退费资源','未续费资源']`、`localYm(iso)`（本地 getter 取年月，禁 `slice(0,7)`），并挂到导出对象。既有 `RESOURCE_TYPES` / `PRIORITY` / `GRADES` / `STAGES` 一字未改 |
| `js/module-customers.js` | `CustomersCore.validate` 增 `intent_level` 必选；`filterRows` 特判 `__blank__` 哨兵；`customerStats` **零改动**；外露 `App.StopResCore` 六函数；`TABS` 加 Tab③；`state` 加独立 `stopFilters`/`stopSortKey`/`stopSortDesc`；三分支 render/bind；意向程度 列/chip/筛选/表单/详情；Tab③ 10 列 + S-1~S-9 筛选 + 5 分区表单 + `data-srow` hidden+disabled 联动 + 布尔→时间联动 + 详情/编辑/删除；`normalize` 严格写 `''/false/null` |

### 2.2 测试护栏与 QA 套件

| 文件 | 说明 | 结果 |
|---|---|---|
| `tools/smoke-db.js` | `TABLES` 追加 `stop_resources`（8 表）；`:222` 7→8；新增「单表拉取失败不阻断其余 7 表」真防回归断言（6 条，`cloud.failSelect.stop_resources=true` 实际触发 select 抛错） | **65 / 0** |
| `tools/smoke-perm.js` | `:380` 8 表名 `.every()`、`:383` 7→8 | **95 / 0** |
| `tools/smoke-v2-customer-task.js` | `baseForm()` 补 `intent_level:'高'`（R1 裁决：改夹具不改校验）+ 追加 3 条 v4 断言（缺/空串/非枚举被拒） | **103 / 0** |
| `tools/qa-v4-fixtures.js` | 假数据夹具：V-D3 跨月边界、脏值跨类型、同人多条、S-1~S-9 数据集、统计 golden、三级排序数据集 | — |
| `tools/qa-v4-core.js` | QA 专项纯函数套件：10 个 section / 318 处断言，覆盖装载签名、CustomersCore 增量、customerStats golden、StopResCore 六函数、V-C4 隐藏字段、normalize 逐键非 undefined、毒桩证明零读库 | **361 / 0** |
| `tools/qa-v4-ui.js` | UI/CRUD 专项：vm 装载 + 168 处断言 + 39 处事件直接驱动 + 5 处权限守卫，覆盖三分支、意向程度展示面、Tab③ CRUD、条件联动、排序 shim、权限 | **334 / 0** |
| `tools/qa-v4-lead.js` | team-lead 独立纯函数复核（第二层验证，独立构造数据）：`CustomersCore` 增量 + `StopResCore` 六函数全驱动 | **61 / 0** |
| `tools/qa-v4.js` | 主集成套件：静态契约 A1~A5（基础设施/内核/表单完备性/DDL V-G1/R4 边界与构建产物）+ 全量回归 spawnSync 汇总，三层验证全部 `required:true` | **50 / 0**（Exit 0） |

> **三层验证（最终状态）**：中断恢复后 `v4-core-qa` 补齐了 `tools/qa-v4-core.js`（56 KB / 361 断言），`qa-v4.js` 已把它从「存在即纳入、缺失不阻塞」**改回 `required:true`**。现为三层互相独立的验证编排，数据与断言各自独立构造、互补不重复：
> ① `qa-v4-core.js`（QA 专项纯函数，361/0）② `qa-v4-ui.js`（UI/CRUD，334/0）③ `qa-v4-lead.js`（team-lead 独立复核，61/0）。`qa-v4-fixtures.js` 被 core 与 UI 套件共用。
>
> **护栏有效性反证（重要）**：故意以 `TZ=UTC` 运行 `qa-v4-core.js` → `PASS 349 / FAIL 12`、`EXIT=1`，其中 `V-D3 核心：边界 ISO … → 实际="2026-02" 期望="2026-03"` 明确失败。证明「禁 `slice(0,7)` / 必须本地 getter」是真实护栏而非空转断言，且 `FAIL>0 → process.exit(1)` 退出门有效。另 `TZ=Asia/Shanghai` 连续两次输出 byte-identical，无抖动。

### 2.3 文档与构建产物

| 文件 | 说明 |
|---|---|
| `docs/PRD-v4-customer-intent-stopres.md` | PM 交付（499 行，22 需求池 / 25 字段定义 / 38 验收 / 6 OQ / 3 冲突点） |
| `docs/ARCH-v4-customer-intent-stopres.md` | 架构交付（686 行，唯一实现契约，IS_PASS: YES） |
| `docs/ddl-v4-customer-intent-stopres.sql` | 云端 DDL：24 列、4 RLS policy、2 GRANT + 序列 USAGE、5 个幂等 DO 块、无 UNIQUE/INDEX/FK；**已于 2026-11-27 在生产库执行并验证**（见 §9.2） |
| `docs/class-diagram-v4.mermaid` / `docs/sequence-diagram-v4.mermaid` | 类图 / 时序图 |
| `README.md` | 新增 v4 章节；R4 状态已更新为「DDL 已执行、已上线」，并保留「重建环境须先执行 DDL」提示 |
| `index.html` | 24 个本地资源统一 `?v=202611271940`（缓存击穿；本地实现阶段曾为 `202611271856`） |
| `学生管理系统-单文件版.html` | 重打包，773931 bytes（约 755.8 KB；v3 为 737172），已内联全部 v4 代码 |

---

## 3. 关键实现裁决与坑修复

1. **J-1（推翻 PM C-1）**：`db.js` 的 `fetchTable` 已内建单表 `.catch → return false`，`refreshAll` 用 `chain.then` 串联不会因单表失败中断。**不改 db.js 容错逻辑**，只加断言保护；R4 阶段新表拉取失败仅表现为 Tab③ 空态，其余 7 表正常。
2. **J-2（真实回归风险）**：`smoke-db.js:222` 与 `smoke-perm.js:383` 两条独立 `eq(...,7)` 硬断言 + `smoke-db.js:23` 的 `TABLES` 假云端数组，加第 8 表必 FAIL / 抛 TypeError → 三处同步改 8。
3. **J-3（不新增 js 文件）**：`qa-750.js:587/602/625` 与 `qa-v3.js` 硬编码 23 个 js 文件，新增 js 会触发回归 → Tab③ 全部落进 `module-customers.js`。
4. **J-4（本地年月）**：`UI.fromDateInput` 把本地 `2026-03-01 00:00` 存成 `2026-02-28T16:00Z`，用 `iso.slice(0,7)` 会错判为 `2026-02` → 新增 `UI.localYm` 用本地 getter，月份筛选/展示统一走它。
5. **`UI.bindSort` 只有 3 参数且写死 `state.sortKey/sortDesc`**：Tab③ 用 `sortShim` 承接后写回 `stopSortKey/stopSortDesc`，避免污染 Tab① 排序态。
6. **归一必须写 `null`/`''`/`false`，禁止 `undefined`/`delete`**：`db.js pick()` 跳过 `undefined` 但保留 `null`，用 `undefined` 会导致 update 不动该列、跨类型脏值残留（破 V-C4）。
7. **R1 存量口径**：历史客户 `intent_level` 显示「未填写」、不回填；仅新增/编辑强制必选；筛选保留「未填写」（`__blank__` 哨兵）。编辑存量客户时需补选，属用户主动写入，不算批量回填。
8. **两表零关联**：`customers` 与 `stop_resources` 独立 `table()` 句柄，无 JOIN / FK / 查重 / 自动同步 / 一键转客户；同一人可有多条；回流由人工在 Tab① 按新客户登记。

---

## 4. 全量回归结果（0 失败）

运行口径统一 `TZ=Asia/Shanghai`（本地年月依赖本地 getter）。

| 套件 | 结果 |
|---|---|
| `smoke-db.js` | PASS 65 / FAIL 0 |
| `smoke-perm.js` | PASS 95 / FAIL 0 |
| `smoke-v2-contracts.js` | PASS 386 / FAIL 0 |
| `smoke-v2-customer-task.js` | PASS 103 / FAIL 0 |
| `smoke-v2-students-classes.js` | PASS 100 / FAIL 0 |
| `smoke-analysis.js` | PASS 247 / FAIL 0 |
| `qa-750.js` | PASS 305 / FAIL 0 |
| `qa-v3.js`（v3 主集成） | PASS 219 / FAIL 0，12 个子套件全 rc=0 |
| `qa-v4-core.js`（v4 专项纯函数） | PASS 361 / FAIL 0 |
| `qa-v4-ui.js`（v4 UI/CRUD） | PASS 334 / FAIL 0 |
| `qa-v4-lead.js`（v4 team-lead 独立复核） | PASS 61 / FAIL 0 |
| `qa-v4.js` 主集成门 | PASS 50 / FAIL 0，Exit 0，子套件 PASS 合计 **2276** |

> **发现的唯一真实回归**：给 `CustomersCore.validate` 加 `intent_level` 必选后，`smoke-v2-customer-task.js` 4 条断言 FAIL（旧「合法表单」夹具缺该字段）。按 R1 裁决**更新夹具而非放宽校验**，复跑 103/0、`qa-v3` 219/0 全恢复。这是预期的功能变更影响，不是产品缺陷。

### 4.1 DDL 静态核对（V-G1，7/7 全过；上线前的只读核对记录）

① `customers` 既有列零改写（仅 1 条 `ADD COLUMN IF NOT EXISTS intent_level`、无 `UPDATE … SET` 回填）；② `stop_resources` 恰好 24 列、列名/类型/NOT NULL/DEFAULT 与 §2.2 一致；③ 除主键外无 UNIQUE / INDEX / FOREIGN KEY；④ 4 条 RLS policy 名称与 `is_viewer()`/`is_editor()` 一致；⑤ GRANT 2 行 + 序列 USAGE 齐全；⑥ COMMENT 含「零关联」；⑦ 5 个 `DO $ddl$` 块各自幂等（首次执行须按 ①→②→③④⑤ 对象依赖顺序）。生产库实际执行结果见 §9.2。

### 4.2 单文件版端到端冒烟

抽取内联脚本在 vm 中装载并真实调用：

```text
App.UI.INTENT_LEVELS = ["低","中","高"]
App.UI.STOP_RESOURCE_TYPES = ["退费资源","未续费资源"]
App.UI.localYm("2026-02-28T16:00:00.000Z") = 2026-03
App.DB.defs 表数 = 8，含 stop_resources = true
App.StopResCore 函数 = validate,filterRows,normalize,visibleFields,localYm,sortRows
normalize 未续费 → refund_amount = null，key 存在 = true
validate 未续费合法 = true
```

证明用户双击本地单文件版即可看到并操作 v4 功能。

---

## 5. 需求覆盖对照

| 用户原始要求 | 实现 | 验收 |
|---|---|---|
| 客户信息新增必填「意向程度」低/中/高 | `customers.intent_level` + 表单下拉 + validate 必选 | V-A1/A2/A3、`qa-v4-lead` §1 |
| 可按意向程度筛选 | 工具栏含 低/中/高/未填写（`__blank__`） | V-A5、`qa-v4-lead` §1 |
| 客户管理新增子版块「结停课资源」 | Tab③，仅管理员可见 | V-B1、`qa-v4-ui` §3 |
| 学生姓名/电话/年级/学校/结停课时间(年月日)/资源类型 | 5 分区表单，18 业务字段齐全 | `qa-v4.js` A3 逐字段核对 |
| 按类型填退费原因/未续费原因 + 退费科目·老师/结课科目·老师 | 条件联动分区，科目与老师**全手填** | V-C1~C5、`qa-v4-ui` §7 |
| 共同填「回流可跟进意向」低/中/高 | 独立分区，复用 `INTENT_LEVELS` | `qa-v4-lead` §2 |
| 退费资源：金额/家长确认/是否提交申请/提交时间/是否到账/到账时间 | 6 个退费专属字段，布尔「是」时时间必填 | V-C5、`qa-v4-lead` §2/§3 |
| 两表信息不相通、单独表单、允许回流重登、同一人多条 | 独立句柄 + 零关联 + 不去重 | V-E1/E2/E3、`qa-v4-ui` §6 |
| 按客户信息 + 月份筛选（不用到具体日） | S-1~S-9，两个 `<input type="month">` | `qa-v4-lead` §5 |
| 正常增、删、查、改 | Tab③ 完整 CRUD + 二次确认删除 | V-B4~B7、`qa-v4-ui` §4/§5 |
| 存量客户不回填、筛选保留未填写 | R1 口径 | `qa-v4-lead` §1 |

---

## 6. R4 边界与解除记录

**上线前（本轮实现阶段）**，R4 红线全部保持，未越界：

- ✅ 未执行任何生产 DDL（`customers` 加列、`stop_resources` 建表均未做）
- ✅ 未连生产库、未跑生产回填
- ✅ 未发布上线（当时线上仍是 v3，`?v=202611201518`）
- ✅ 未 git commit / push
- ✅ 未改 `Tab② 统计分析` 口径、未改成绩 26 列导出与 v3 考试年月排序

**用户明确授权后**（`很好，帮我发布上线吧；git同步更新代码库`），R4 挂起事项已全部执行完毕，实际结果见 §9。以下原「上线前必做」三项均已闭环：

1. ✅ 已按 ①→②→③→④→⑤ 顺序执行 5 个幂等 DDL 块，并做生产库权威复核。
2. ✅ 已先确认 DDL 生效（表/列/RLS/policy/GRANT/序列/COMMENT/存量零改写），再刷新构建产物，避免线上空态。
3. ✅ 已 `python3 build-single.py`、`workbuddy_sites_deploy` 发布，并完成线上逐项验证与 git 同步。

---

## 7. 已知小瑕疵（非阻塞）

- `ARCH-v4` / `PRD-v4` / 本报告引用了 `docs/backup-pre-v3.json` 等 v3 回滚底稿路径；这些底稿因含内部标识被 `.gitignore` 排除在公开仓库之外，本地与线上发布目录仍保留，不影响功能与运行。
- 编辑存量客户时需补选意向程度（R1 直接后果，属用户主动写入，非批量回填）。
- **`isTrue()` 与 `triState()` 真值词表不对称（QA 发现，本轮不修）**：`js/module-customers.js:85-87` 的 `isTrue` 只认 `true / 1 / 'true' / 't'`，不认中文 `'是'`；`triState`（:202-208）认 `'是' / '否' / yes / no / …`。消费方：`stopValidate`（:419/423/428）与 `stopNormalize`（:344-345）用 `isTrue`，`stopFilterRows`（:473-477）用 `triState`。**当前 UI 的 `qc()` 从 checkbox 产真布尔，生产路径不受影响，故非 bug**；仅当未来接入外部数据源（CSV 导入、其它客户端写库）把布尔列写成字符串 `'是'` 时，筛选能命中但条件必填校验 / 布尔否→时间归 null 不会触发。QA 已在 §4 用一条断言固化该真实行为避免误判。**后续改进建议**：把 `isTrue` 扩展到 `'是'`（及 `'yes'`），或统一抽 `boolOf()` 供校验/归一/筛选共用，消除两套词表。本轮不做范围外改动。

---

## 8. 结论

**IS_PASS: YES（本地实现 + 全量测试 + 生产上线 + 代码同步）**。v4 需求的用户原始 16 个字段与全部业务逻辑均已落地，`qa-v4.js` 主集成门 50/0、三层专项 361/334/61 全绿、v2/v3 全量回归 0 失败、子套件 PASS 合计 2276；生产 DDL 已执行、线上 24 个资源与本地 md5 全匹配、GitHub `main` 已同步至 `55e969c`。

原「待用户确认」事项已由用户明确授权并执行完毕，详见 §9。

---

## 9. 上线与代码同步记录（2026-11-27）

### 9.1 发布前基线

| 项 | 值 |
|---|---|
| 线上入口 | `https://student-scores-36336.app.workbuddy.host/?sharecode=…`（覆盖同一应用 `wbapp_4awyu0XEG4n9gJgerWLkYW`，未新建） |
| 发布前线上版本号 | `?v=202611201518`（v3），v4 符号命中 0 |
| 本地最终版本号 | `?v=202611271940`（24 个本地资源同戳） |
| `js/` 冻结双采样 | 两次 `md5` 聚合均为 `9bd48bae8f6e04c68e0d969a412870f3`，确认无并发写入 |
| 单文件版 | 773931 bytes，内联 `App.StopResCore` / `stop_resources` / `③ 结停课资源` / `intent_level` / `localYm` |
| 验收门 | `TZ=Asia/Shanghai node tools/qa-v4.js` → `PASS 50 / FAIL 0`，子套件合计 2276 |

### 9.2 生产 DDL 执行与复核

按脚本 5 个幂等 `DO $ddl$` 块顺序执行（`mode=migrate`）：① `customers ADD COLUMN IF NOT EXISTS intent_level`；② `CREATE TABLE stop_resources`（24 列）；③ 4 条 RLS policy；④ GRANT + 序列 USAGE；⑤ COMMENT。

权威复核 SQL（单条只读）返回：

```json
[{"customers_rows":0,"has_intent":1,"intent_nonblank":0,"policies":4,"rls_on":true,"stop_cols":24,"stop_rows":0}]
```

即：`stop_resources` 24 列、`customers.intent_level` 已加、`rowsecurity=true`、4 条 policy、两表 0 行且存量 `intent_level` 无回填 —— **存量数据零改写**。另经 `pg_tables` 复核 `customers` / `stop_resources` 均 `rowsecurity=true`（`describe_table` 的 `RLSOn` 字段曾误报 false，已排除）。

### 9.3 发布与线上验证

`workbuddy_sites_deploy`（`action=deploy`、`directory=学生管理系统`、`language=static`、`entryHtml=index.html`、`appId=wbapp_4awyu0XEG4n9gJgerWLkYW`、`domainPrefix=student-scores`、`userAskedToPublish=true`）→ `verified:true`、`deployedAs:web-page`，**覆盖同一链接，未新建应用**。

| 验证项 | 结果 |
|---|---|
| 线上入口 | HTTP 200 |
| 线上 `index.html` 版本号 | `?v=202611271940` |
| 本地 vs 线上 `index.html` md5 | `2508907dca6d03c253cbb52336eff391` 双向一致 |
| 24 个本地资源 | HTTP 200 = 24，md5 与本地一致 = 24（**全匹配**） |
| 线上 `module-customers.js` v4 符号 | `App.StopResCore` 6 / `stop_resources` 2 / `③ 结停课资源` 4 / `intent_level` 20 / `localYm` 4 |

> 探测静态资源时版本号须用 `?v=<stamp>&sharecode=<code>` 拼接；误用第二个 `?` 会污染 sharecode 导致 403（v3 阶段已固化的经验）。

### 9.4 GitHub 同步

| 项 | 结果 |
|---|---|
| commit | `55e969c`（19 files changed, +5521 / −37） |
| push | `1be52ff..55e969c  main -> main` |
| 远端 HEAD | `55e969c9e0dcad34ab9ed772bed5796a629ad9b0` |
| 远端 tree | `truncated:false`，72 个文件；13 个关键文件全部存在，抽样 blob sha 与本地**全部一致** |
| 脱敏 | `docs/backup-pre-v3.json`、`docs/v3-postflight-snapshot.json`、`.workbuddy/` 均被 `.gitignore` 排除，远端不存在；新增文件命中的手机号全为标准测试假号（13400134000 / 1380013800x / 13900139000 等），真实凭据 / sharecode 0 命中 |

> 公开仓库中 `wbapp_` 应用 ID 仅存在于 HEAD 历史已跟踪文件（`baseline-score*.txt`、`QA-v2-recheck.md`、`QA-v3-report.md`），本轮未修改这些文件，按历史公开口径保留。
