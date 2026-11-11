# QA 复验报告（T11）

- 复验人：独立 QA（Edward）
- 日期：2026-10-20
- 方式：**不复用作者测试的断言与数据**。在 `/tmp/qa-t11/qa.js` 自建 vm 沙箱（`core.js → db.js → perm.js → ui-kit.js → module-contracts.js`），自造方案/合同/快照数据，手工推算期望金额后逐项比对；渲染走真实入口（模块 `render()` 与 `openContractDetail` 捕获 Modal body）。共 **170 项断言，全部通过**。
- 仓库改动：仅新建本报告。源码 / 测试 / 构建脚本 / 其他文档零改动（无 git 仓库，用目录内容核对；`build-single.py` 产物输出在仓库外父目录）。

## 结论

**可上线。** 4 项用户需求（多方案组合、结余行条件渲染、明细单去公式注释、方案备注）均按口径实现；两份 T9 历史合同（id=2 郭远阳 5900 / id=3 郭小阳 11700）查看明细与修改回填全通；8 套冒烟 + 全量语法检查 + 单文件构建全绿。**阻塞级 Bug：0 个**。发现 1 个低危观察项（见「G 找茬」G-1）与 2 处设计裁量（不构成缺陷）。

## 阻塞级 Bug

无。

## A–F 逐项结论

### A. 多方案聚合计算 ✅（自造算式，全部命中）

测试数据（自造）：方案甲（unit_price 240，A 7 次 / B 18 次，资料费各 100，报 2 科数学+英语）＋ 方案乙（unit_price 200，C 6 次，资料费 50，报 1 科物理）。

| 项 | 手工算式（我写） | `priceContractMulti` 实际 | 结果 |
|---|---|---|---|
| A1 两方案无优惠 | 甲 O=240×7×2+240×18×2=3360+8640=**12000**，M=100×2+100×2=**400**；乙 O=200×6×1=**1200**，M=**50**；整单 O=**13200** D=0 T=**13200** M=**450** S=**13650** 应付=**13650** | 12000/400/1200/50；13200/0/13200/450/13650/13650 | ✅ |
| A2 优惠独立（甲85折/乙减300；再改甲9折） | 85折：甲 T=12000×0.85=**10200** D=**1800**；乙 T=1200−300=**900** D=**300**；整单 D=**2100** T=**11100** S=**11550**。改甲 9 折：甲 T=**10800** D=**1200**，**乙必须仍 900/300** | 全部一致；乙在两次运行间纹丝不动；整单 discountType=`'mixed'`（`module-contracts.js:545-558`） | ✅ |
| A3 整单=Σ方案 | O_total=ΣO_p、D_total=ΣD_p、T_total=ΣT_p、M_total=ΣM_p、S=T+M | 两套输入逐项相等 | ✅ |
| A4 结余 20000 > 小计 11550 | 应付 **0**、抵扣 **11550**、剩余 **8450**；方案层不下沉：甲 payable=小计 **10600**、乙 = **950**，各方案 deduction=**0** | 全部一致，无负数（结余只在聚合层抵一次：`priceContractMulti` 内 `balance:0` 传给每方案，`:518`；整单抵扣 `:541-543`） | ✅ |
| A5 单方案两入口一致 | `priceContractMulti([单方案],300)` 与 `priceContract(单方案,balance=300)` | original/discountAmount/tuition/materialAmount/subtotal/deduction/payable/balanceLeft/subjectCount 及 subjectRows、stageMaterial 深比较**逐字段一致** | ✅ |

### B. 结余行条件渲染 ✅

渲染入口：`openContractDetail`（内部即 `detailCardHTML`，`module-contracts.js:1383-1462`；条件在 `summaryRowsHTML :1350-1356`）。

- `deduction=0`（balance=0）→ 输出 HTML **不含**「电子账户结余抵扣」✅
- `deduction=500`（balance=500，小计 11550）→ 含该行，金额 `500.00`，应付 `11050.00` ✅
- 优惠行为 0 时不渲染（`:1343-1345` `if (num(res.discountAmount) > 0)`）→ 无优惠场景 HTML 不含「优惠（」✅

### C. 公式注释已清除 ✅

对**明细单渲染产物**（台账「查看明细」弹窗 + 登记页 `#ct-detail` 区块两路）逐串检查：`不参与任何优惠`、`S = 折后课时费`、`口径：`、`（O）`、`（M` **全部不出现**。汇总行现为纯短标签「课时费原价合计 / 折后课时费 / 资料费合计 / 小计」（`:1341-1348`），底部无口径说明块。注意：登记页**方案块表单**（`planBlockHTML :1771`）仍保留「优惠只作用于课时费，资料费不参与任何优惠」提示——那是录入表单说明，不属于明细单，符合需求边界。

### D. 备注 ✅

- 校验（`validatePlan :696-698`，`REMARK_MAX=200 :48`）：

| 输入 | 结果 |
|---|---|
| 空 | 通过（选填） |
| 200 字 | 通过 |
| 201 字 | 拒绝：「备注不能超过 200 个字」 |
| 200 个空格 | 通过（trim 后长度 0，视为空备注；落库 payload 也 trim → `''`，见 `:2525`）——合理裁量 |

表单层另有 `maxlength=200`（`:2486`）双保险。
- 快照：`items.plans[i].remark` 落库 ✅（`itemsSnapshot :1039`，读价目行 remark 进快照 `:1553`）。
- 明细单：有备注显示「备注：xxx」（`remarkLineHTML :1377-1381`）；无备注不显示 ✅。两方案备注**相同且都有** → 去重只显示 1 次（`:1414-1423`）；不同 → 各方案块各 1 次 ✅。单方案 T11 合同（items.plans 长度 1）备注也正常显示 1 次 ✅。
- 云端列：`docs/ddl-v2.sql` 已声明 `contract_prices.remark text NOT NULL DEFAULT ''`（建表段 + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS remark` 幂等补列 + `COMMENT ON COLUMN`，文件头注明已对线上库执行并实测备注往返）。**我无云端凭据，未能实测云端，仅确认 DDL 声明。**

### E. 历史合同兼容（最重要）✅

自造 T9 格式快照（`items` 单方案 object，7 键：planName / plan / stages / subjects / lines / subjectRows / stageMaterial）：

- **id=2 郭远阳**：寒春连报 A7+B18、240 元/科、1 科数学、资料费 100/阶段、无优惠 → O=240×25=6000、M=200、S=6200、抵扣 300、**应付 5900**。`snapshotResult` 还原：方案名「寒春连报」、科目行数 1、阶段列 A/B（stageList 为阶段对象数组，渲染 `A 阶段(7次)`、`B 阶段(18次)` 列均出现）、金额逐项一致；明细单含 5900.00、结余抵扣 300.00 ✅
- **id=3 郭小阳**：同价目 2 科 → O=12000、M=400、抵扣 700、**应付 11700**，明细含数学/英语两行、11700.00 ✅
- **「修改」回填**（`loadContractForEdit :2174-2220`）：姓名/年级/年份/editingId/方案名/科目（A、B 各回填「数学」）/优惠类型/结余（=抵扣300+剩余0）全部正确；登记页勾选框 `checked`，回填重算应付复现 **5900.00** ✅
- **价目变更**：单价 240→300 或方案删除 → `priceChanged=true`（`:2119-2139`），明细仍按快照 6000.00/5900.00 渲染并出现「该价目已变更，明细为签订时快照」提示；价目未变时无提示（对照）✅
- **lines-only 更老格式**：`items={lines:[...]}` → `snapshotResult` 不抛错，科目行/金额（O=2000、M=80、应付 2080）还原正确；但**明细卡只显示「还没有可用的报读方案」占位文案，不出金额表**（见 G-1）；台账行金额仍来自行字段，正常 ✅（渲染本身通过）

### F. 回归 ✅

| 套件 | 结果 |
|---|---|
| smoke-analysis | PASS 247 / FAIL 0 |
| smoke-locator | PASS 37 / FAIL 0 |
| qa-750 | PASS 305 / FAIL 0 |
| smoke-perm | PASS 95 / FAIL 0 |
| smoke-db | 59 passed / 0 failed |
| smoke-v2-students-classes | PASS 100 / FAIL 0 |
| smoke-v2-customer-task | PASS 100 / FAIL 0 |
| smoke-v2-contracts | PASS 306 / FAIL 0 |
| `node --check` 全量 23 个 js | 全部通过 |
| `python3 build-single.py` | exit 0，生成单文件版 678.6 KB |

## G 找茬发现

**G-1（低危观察项，非阻塞）：lines-only 老快照「查看明细」是空壳。**
无 `items.plan`/`items.plans` 时 `snapshotSingleView` 的 `stageList=[]`，`detailCardHTML:1405-1411` 判 `hasAny=false` 提前返回「还没有可用的报读方案」占位——不崩溃、台账金额正常，但点「查看明细」看不到科目表与金额。线上若真存在此类远古合同，用户会看到空卡。建议后续迭代：lines-only 时从 lines 反推阶段列（`normSubjectRows` 已能反推科目行，缺的只是阶段列与资料费单价）。

**G-2（核实为无问题）：方案名含「+」不串味。**
自造「A+B方案」+「C方案」组合：`contracts.plan` 拼接为 `A+B方案+C方案`（`:1944`），快照 `items.plans[i].planName` 各自原样保存/还原、`loadContractForEdit` 回填两个方案名精确无误、登记页勾选框 `data-plan-name="A+B方案"` 正常渲染。全链路按**整串精确匹配**，从不按 `+` 拆分。

**G-3（核实为无问题）：重复勾选同一方案被拒。**
`validateContract :825-831`：两份同名方案 → 「方案「X」重复选择，请合并为一次」。

**G-4（核实为无问题）：切换年级后已勾方案清空、提示正确。**
年级/年份 change 处理器先清 `plans` 与 `droppedPlans` 再重渲染（`:2706-2720`）；残留失效方案时 `syncEntryPlans :1494-1500` 移除并记入 `droppedPlans`，页面出现「…在价目中已不存在，已从本次登记中移除，请重新勾选」。注意该提示是**一次性**的（下一次渲染重算即消失），与「提示后需重选」的交互预期相符。

**G-5（核实为无问题）：`discount_type='mixed'` 台账显示。**
各方案优惠不同 → 整单 `'mixed'`、`discount_value=0`（`:545-558`），台账「优惠」列显示「多方案优惠」（`discountText :659`，实测台账渲染输出含该文案）。DDL 侧 `contracts.discount_type` **无 CHECK 约束**（ddl-v2.sql:310，文件头 :40 注明已实测写入），不会撞库。

**G-6（核实为无问题）：方案被删后编辑旧合同。**
T11 多方案快照中方案甲已从价目删除 → 编辑时只剩方案乙回填，`droppedPlans=['方案甲']`，页面提示「方案甲在价目中已不存在…请重新勾选」；已删方案的历史明细仍可从台账「查看明细」完整复现（快照自洽）。

**附：两处设计裁量（非缺陷，记录备查）**
1. T9 格式历史合同明细单不显示备注（T9 本无备注概念；T11 单方案合同走 `items.plans` 分支备注正常显示）。
2. 明细单「资料费」行保留「（单科/阶段）」短标签与「100×2=200.00」单元格内算式——是数值构成展示，非被点名的公式注释。

## 我无法验证的部分

1. **云端实测**：无 Supabase 凭据。`contract_prices.remark` 列、`contracts.discount_type='mixed'` 写入、RLS 策略仅核对了 `docs/ddl-v2.sql` 声明（含幂等 `ADD COLUMN IF NOT EXISTS`），未连库实测。
2. **浏览器交互细节**：科目多选 chip 的退格/点击删除同步（`mountStage` 的兜底监听）、输入法 composition、真实点击流——vm 沙箱无真实 DOM 事件，仅验证了渲染产物与状态机；作者冒烟 `smoke-v2-contracts`（306 项全过）覆盖了这部分，但按任务要求不作为我的独立结论依据。
3. **线上真实数据**：id=2 / id=3 两份合同的**真实快照内容**无云端访问权限，我用同构 T9 格式（7 键、金额 5900/11700）自造复现；若线上行字段与 items 内金额不一致（人工改库），`snapshotSingleView` 以行字段金额为准渲染，属于口径内行为。
