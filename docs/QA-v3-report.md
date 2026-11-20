# QA-v3 报告：考试年月字段与排序改造

> 版本：v3（2026-11-20）｜编制：交付总监（team-lead）汇编，各专项套件由工程师产出并独立复跑
> 权威规格：`docs/ARCH-v3-exam-ym.md`（唯一权威实现契约）；产品口径：`docs/PRD-v3-exam-ym.md` v3.3
> 结论：**全量回归 0 失败，G1 生产红线全过，准予发布**

---

## 0. TL;DR

用户诉求：成绩报告按「录入时间」排序，导致「先录 11 月、后补录 10 月」时月份顺序颠倒。v3 引入「考试年份 + 月份」（云端 `exam_ym` / 内存 `examYm`），保存、读取、展示、对比一律改按考试年月（数值键 `year*12+month`），同年与跨年均正确。

- 改动覆盖 5 个阶段：V3-1 数据基础设施 → V3-2 字段贯穿与排序抽象 → V3-3 录入 UI / 总表 / 趋势图 → V3-4 分析与班级链路 → V3-5 集成回归与发布。
- 生产数据 42 行零丢失、既有 16 列零改写，全部指纹逐字节一致。
- 导出契约保持 26 列（`5 + 2×9 + 3`）逐字不变，页面新增「考试年月」列仅 UI。

---

## 1. 交付物清单

| 阶段 | 产物 | 状态 |
|---|---|---|
| V3-1 | `docs/baseline-score.txt`（v3 新基线章节）、`docs/baseline-score-42.txt`（降级为采集底稿）、`docs/backup-pre-v3.json`、`docs/ddl-v3-exam-ym.sql`、`docs/v3-postflight-snapshot.json`、`tools/qa-v3-data.js` | ✅ 已执行并留证 |
| V3-2 | `js/core.js`（8 个 `Score.*` 纯函数 + `legacySortByTs`）、`js/sync.js`（5+1 字段贯穿）、`js/export.js`（`normalizeRecord` 白名单）、`js/app.js`（`genDemo` 示例年月）、`tools/qa-v3-core.js` | ✅ 216 条断言 |
| V3-3 | `js/module-score.js`（年月双下拉 / 覆盖确认 / 总表列 / 两处趋势图 / 分组排序）、`js/charts.js`（`opt.labelTitles`）、`assets/style.css`、`tools/qa-v3-ui.js` | ✅ 85 条断言 |
| V3-4 | `js/analysis.js`、`js/locator.js`（契约注释）、`js/module-classes.js`（`timeOf` 三用途分离）、`tools/qa-v3-classes.js` | ✅ 19 条断言 |
| V3-5 | `tools/qa-v3.js`（集成入口）、`docs/QA-v3-report.md`（本文）、`README.md`（26 列 + 字段说明）、`index.html`（`?v=` 刷新）、`学生管理系统-单文件版.html`（重打包） | ✅ 见 §2 / §6 |
| 文档 | `docs/PRD-v3-exam-ym.md` v3.3、`docs/ARCH-v3-exam-ym.md`、`docs/class-diagram-v3.mermaid`、`docs/sequence-diagram-v3.mermaid` | ✅ 事实口径已对齐源码 |

---

## 2. 全量回归结果

### 2.1 基础 10 套（v2 既有，验证无回归）

| 套件 | PASS | FAIL | rc |
|---|---|---|---|
| `qa-750.js` | 305 | 0 | 0 |
| `smoke-analysis.js` | 247 | 0 | 0 |
| `smoke-db.js` | 59 | 0 | 0 |
| `smoke-v2-students-classes.js` | 100 | 0 | 0 |
| `smoke-perm.js` | 95 | 0 | 0 |
| `smoke-locator.js` | 37 | 0 | 0 |
| `smoke-v2-customer-task.js` | 100 | 0 | 0 |
| `smoke-v2-contracts.js` | 386 | 0 | 0 |
| `qa-v3-core.js` | 216 | 0 | 0 |
| `qa-v3-data.js` | 40 | 0 | 0 |
| **小计** | **1585** | **0** | 全 0 |

### 2.2 v3 专项新增

| 套件 | PASS | FAIL | 说明 |
|---|---|---|---|
| `qa-v3-classes.js` | 19 | 0 | V-A1 / V-B1·V-B2 / V-D2 / V-G3① / V-D1 定向用例，项目根与 `/tmp` 双路径运行均通过 |
| `qa-v3-ui.js` | 85 / 81 | 0 | 26 列导出 golden diff、D5 x 轴 label golden diff、趋势图长度对齐；三态（未提交 / 已提交 / git 不可用）rc 全 0 |
| `qa-v3.js` | 219 | 0 | 12 套子测试汇总 + V-A1~V-H3 共 27 条逐条断言，独立复跑 rc=0 |

### 2.3 独立验证（team-lead 亲自执行，不采信自报）

- 全量 `node --check` 覆盖 `js/*.js` + `tools/*.js`：**0 语法错误**。
- 全模块装载冒烟：`loaded 23/23 files; failures 0`，`Score` 纯函数 8/8，注册模块 12。
- `defaultExamYm()` = `2026-11`（本机当前月）、`makeExamYm(2025,12)` = `2025-12`、跨年序 `2025-12 < 2026-01`、全缺年月 x 轴逐字回退 `["一模","二模"]`、非法值前缀 `异常·二模`。
- 单文件版内联脚本（600400 字符）独立装载：装载 OK、8/8 纯函数、12 模块、跨年序与 D5 回退与多文件版一致 → **两版功能一致**。

### 2.4 集成入口 `tools/qa-v3.js`

发布前最后一道关，**独立复跑 `PASS 219 / FAIL 0`，rc=0**，连续两次运行结果一致（幂等）。

- 单个 vm sandbox 按 `index.html` 顺序装载全部 23 个 js（12 模块注册、0 抛错），跨 `core / sync / export / module-score / module-classes / analysis / charts` 串真实数据链；`openForm` / `submit` 用真实表单 DOM 桩件驱动，覆盖确认（V-B3）、连续录入保留年月（V-E4）、未来年月软提示（V-E6）、必填校验（V-E5）均为真跑，seam 只在内存源码字符串注入、磁盘零改动。
- V-A1 ~ V-H3 共 27 条逐条映射，末尾有自检断言「27 条全部有映射」。
- 硬项均为真实函数执行：V-F3 两条链路（旧备份 + 带 `examYm:null` 手工备份）真实 `restoreJSON → toRow` 断言不产出 `exam_ym` 键；V-G3 真实 `classScoreAnalysis` 去重取较新行；V-H1/H2 真 md5 复算 42 行三列 fp3；V-F1 真实 `masterExportRows()` 26 列 golden 逐字比对；V-D1 全缺年月 `sortByExam === legacySortByTs` + x 轴 label golden diff；V-E7 真实 `fp/snapState/toRow/fromRow` 只改年月触发写穿。
- 12 套子测试由 `spawnSync` 汇总，全部 rc=0 / FAIL=0，子套件 PASS 合计 **1689**（跳过 0）。任一子套件 rc≠0 或 FAIL>0 或汇总行解析不到即 `process.exit(1)`，退出门有效。

**全量合计**：基础 10 套 1585 条 + v3 专项 104 条（19 + 85）+ 集成入口 219 条 = **1908 条断言，0 失败**。

---

## 3. G1 生产终验（只读，2026-11-20 15:10 CST）

严格使用 `docs/baseline-score.txt` 规范 SQL（口径 A / C / fp3 各自独立，**不同拼串口径的 md5 不可互比**；禁用 `concat_ws('~')` 变体，避免 `e921c070…` 第三指纹假失败）。

| 校验项 | 生产实测 | 权威值 | 结论 |
|---|---|---|---|
| 口径 A（8 字段，跨版本权威基准） | `n=42` / `d08aab5b7f0aa8028873f67bd0248859` | 同 | ✅ 逐字节一致 |
| 口径 C（全 16 列，V-H1/V-H2 强制补充） | `n=42` / `4120b89db2e0df7be40c564f7e41b70b` | 同 | ✅ 逐字节一致 |
| 三列专项 fp3 | `120df1f4d7924b7dd1adeaff47beb3d5` | 与 `backup-pre-v3.json` 42 行复算一致 | ✅ |
| `exam_ym` 分布 | `2026-10 = 41`、`2026-11 = 1` | 与 dry-run 一致 | ✅ |
| 结构 | 17 列、非法年月 0、自定义触发器 0、RLS 策略 4 | 16 既有列 + `exam_ym` | ✅ |

**结论**：并行开发与测试未写坏生产数据，42 行完好，既有列零改写，唯一索引与 RLS 未改动。

---

## 4. 验收映射（V-A1 ~ V-H3 要点）

| 组 | 关键验收 | 证据 |
|---|---|---|
| V-A | 后补录 10 月排在 11 月之前、`Score.history` 结论「明显下滑」；趋势图 labels 按 `studentRows` 1:1 产出且有长度对齐保护 | `qa-v3-classes.js` V-A1、`qa-v3-ui.js` 组 3、`qa-v3-core.js` |
| V-B | 跨年 `2025-12 < 2026-01` 按 `year*12+month` 数值；8 全角字上限按 code point；覆盖确认 `App.Modal.open` 原生 `okText`/`cancelText`、取消不写库 | `qa-v3-classes.js` V-B1/B2、`qa-v3-ui.js` 组 2、源码走查 `module-score.js:406-424` |
| V-C | `examCmp` 兜底 `U.zh(exam)→ts→id` 不抖动；`Score.history` 算法零改动 | `qa-v3-core.js` |
| V-D | 全缺年月逐字回退 `legacySortByTs`；混合序列 `num=+Infinity` 排末尾且不参与首/末；缺 `未标注·` / 非法 `异常·` 两态区分 | `qa-v3-core.js`、`qa-v3-ui.js` D5 golden diff |
| V-E | 双下拉默认当前月、编辑回显、未来年月软提示不拦截、连续录入保留、脏值编辑「保留原值」、`makeExamYm` 严格校验、只改年月也触发 push | 源码走查 `module-score.js:80-214, 304-310, 433-453`；`qa-v3-core.js` V-E7 |
| V-F | 26 列导出契约逐字一致、无「考试年月」列；JSON 备份含 `records[].examYm`；恢复不含该字段的旧备份不清空云端 42 行年月 | `qa-v3-ui.js` 组 1（含 `git show HEAD` 函数体逐字比对）、`qa-v3-core.js` §7 C.10 端到端 8 条 |
| V-G | 四处统一 `Score.sortByExam` / `Score.sort` / `Score.options`；`perStudent last/prev` 改年月序；同考试去重仍按 `entered_at` | `qa-v3-classes.js` V-G3①、`qa-v3-core.js` |
| V-H | 口径 A + C 并用、三列 diff；`build-single.py` 刷 `?v=`；单文件版重打包 | §3 生产终验、§6 构建记录 |

---

## 5. 技术裁决与已知设计取舍

### 5.1 三条正式裁决

1. **V3-4 `hasAnyYm` 条件分流：采纳**。`legacySortByTs` 是**分组级**排序（按 `学校|班级|考试` 编序号 + 组内得分率），不是 `module-classes.js perStudent` 原先的纯 `timeOf` 升序；无条件替换为 `Score.sortByExam` 会让 `smoke-v2-students-classes.js:290` 的 `last` 从「期末考试」漂移，破坏 D5。故保留全缺年月时的纯 `timeOf` 回退。
2. **D5 是文案级，不是 DOM 字节级**。ARCH §6.2 #17 限定的是 x 轴 **label 文本**，§7 护栏是「长度 + 每一项文本」的字符串序列比对，且明写「`title` 可保留」。全缺年月回退分支下挂一个内容等于 label 的 `<title>` 属无害 tooltip，不违规；V3-5 golden diff 按 label 字符串序列断言，禁止比对 SVG DOM 字节。
3. **空串 `examYm: ''` 不收紧判据**。已独立验证 `examYmOf('')` → `state: missing`，`fp` 对 `undefined`/`null`/`''` 三值同编 `''`，写回幂等、不清空合法值；收紧到 `!== ''` 反而会让用户显式清空年月时云端保留旧值。V-F3 的保护范围是「备份不含该字段」，`''` 是含字段的显式值，不属该范围。6 条断言覆盖，记为已知设计取舍。

### 5.2 其他已知项（非缺陷）

- **26 列既存笔误**：`masterExportRows()` 实际输出 26 列（`5 + 2×9 + 3`），历史文档/README 与 `module-score.js:658` 源码注释写「27 列」属既存笔误，v3 零改动；PRD/ARCH/README 已按 26 更正，源码注释按约定保留原样。
- **`qa-v3-ui.js` 提交状态自适应**：`git show HEAD` 的逐字比对只在 HEAD 为改造前时执行；v3 提交或同步 GitHub 后自动降级为 INFO 并跳过，硬编码 26 列 `GOLDEN_HEAD` 三态始终执行，不会因提交状态变红。
- **`RLSOn=false`**：`pg_policies` 确有 4 条 permissive 策略，属既存状态，v3 不改 RLS 开关。
- **V-H2 边界**：`updated_at` / `last_editor` 刷新属 `toRow` 既有写穿行为，V-H2 只约束定点回填动作；用户主动恢复旧备份不计违规。
- **`<title>` 增量**：全缺年月回退分支下 x 轴多一个内容等于 label 的 tooltip，为 V3-3 第 11 条要求的新能力，按 §5.1 裁决 2 合规。

---

## 6. 构建与发布记录

### 6.1 构建产物

| 项 | 构建前 | 构建后 |
|---|---|---|
| `index.html` 本地资源版本号 | `?v=202611112053` | `?v=202611201518`（24 个资源全部刷新） |
| `学生管理系统-单文件版.html` | 706,109 bytes，v3 功能 0 命中 | 737,172 bytes（719.9 KB），v3 功能 45 命中 |
| 缓存控制 | `<meta http-equiv="Cache-Control" content="no-store">` | 保持 |

构建后 `qa-v3-ui.js` 仍 85/0，单文件版内联脚本独立装载验证通过（§2.3）。

### 6.2 发布前线上基线（带内部访问码探测）

| 项 | 发布前线上 |
|---|---|
| `index.html` 版本号 | `?v=202611111753` |
| `js/core.js` `examYm` | 0 命中 |
| `js/sync.js` `exam_ym` | 0 命中 |
| `js/module-score.js` `examYear` / `ym-col` | 0 / 0 命中 |

### 6.3 发布

已复用既有应用 `wbapp_4awyu0XEG4n9gJgerWLkYW`（`directory=学生管理系统`、`language=static`、`entryHtml=index.html`、`domainPrefix=student-scores`），**覆盖同一线上链接、未新建应用**。发布返回 `verified: true`、`deployedAs: web-page`，链接保持 `https://student-scores-36336.app.workbuddy.host/?sharecode=…`（访问码见内部渠道，勿外传）。

---

## 7. 发布后线上验证（2026-11-20 15:30 CST）

| 校验项 | 发布前 | 发布后 | 结论 |
|---|---|---|---|
| `index.html` 版本号 | `?v=202611111753` | `?v=202611201518` | ✅ 已刷新 |
| `js/core.js` | `examYm` 0 命中 | `examYm` 14、`examAxisLabels` 1、`sortByExam` 3、`defaultExamYm` 1 | ✅ |
| `js/sync.js` | `exam_ym` 0 命中 | `exam_ym` 6、null-safe 判据 1 | ✅ |
| `js/module-score.js` | `examYear`/`ym-col` 0 命中 | `examYear` 6、`ym-col` 2、`examAxisLabels` 3、`覆盖并保存` 2 | ✅ |
| `js/module-classes.js` | — | `hasAnyYm` 2 | ✅ |
| `js/charts.js` / `assets/style.css` | — | `labelTitles` 6 / `ym-col` 1 | ✅ |
| **24 个本地资源 md5** | — | **MATCH 24 / DIFF 0** | ✅ 线上代码与本地最终版逐字节一致 |
| `index.html` md5 | — | `99f70c0bdde3223b5fb3c3da3f52b693` 两边相同 | ✅ |

**缓存击穿有效性**：`no-store` meta 保留 + 全部 24 个资源带新 `?v=202611201518`，浏览器不会命中旧的启发式缓存；24/24 逐字一致证明线上无残留旧代码，T14 的「线上/本地不一致」根因已被结构性消除。

**数据同步**：云端 REST 端点 `/.cloud/database/rest/score_records` 可达（占位 apikey 探测返回预期 `401 invalid_client` 鉴权响应，端点本身正常）；真实会话下的读写由前端 SDK 携带有效凭据完成，生产库 G1 终验（§3）已确认 42 行、`exam_ym` 列、权限与 RLS 全部正常。未使用真实凭据探测，避免污染线上会话。

**待人工走查**：用管理员账号登录后在「成绩录入」确认考试年份/月份下拉出现且默认当前月、保存一条补录 10 月成绩后报告按年月排序、数据同步无报错。此为 UI 交互层，自动化套件已用真实表单 DOM 桩件覆盖 V-B3 / V-E4 / V-E5 / V-E6，但线上真实会话仍建议肉眼确认一次。

---

## 8. 结论

v3 考试年月改造**全部功能验收通过**，全量回归 0 失败，G1 生产红线全过，多文件版与单文件版功能一致，构建产物已刷新。无阻塞性遗留问题；§5 所列均为有意为之的设计取舍，不影响交付。
