# Always-Doing 分层编排、主 Agent 记忆与工具升级设计

- 日期：2026-11-19
- 定位：Owner 拍板的增量架构规范，补充 Agent 会话宿主与工具设计的 §4–§5，承接 Memory & Cognition Architecture R0，并沿用[四级自治与自研遗忘](autonomy-and-forgetting.md)。防御工程总投入上限为 10%。

---

## 1. 核心架构：轻量前哨 Agent + 三态 Todo 事件 → 强力主 Agent

Agent 不具备人类低功耗的多线持续注意力。要实现高性价比的 **Always-Doing** 并避免高频唤醒强力模型，采用两层分工，直接映射现有 Temporal 骨架：

1. **轻量前哨编排 Agent（便宜快模型 → 挂在 `mangekyoCoordinator`）**
   - 长期存活（`Continue-As-New`），由**事件（`wakeCoordinator`）与定时（`recheckAtMs`）**高频唤醒。
   - 只做全局态势感知与任务分诊，**绝不亲自写长讲义、出难题或做深度教学推理**；动作仅限发/改/撤 `Todo`、维护短备忘或升给用户。
2. **强力主 Agent / 专项执行者（强模型或确定性计算 → 挂在 `mangekyoWork`）**
   - 覆盖**前台实时伴学对话**与**后台按单执行**两种态，支持多条并行。
   - 仅在用户发起对话或 `Todo` 命中触发条件时拉起，干完即退；按 **四级自治**执行。Tier 1–4 对应既有级别 0–3。Tier 1–2 直接生效，可撤回的写入保留 `fact_revs`。Tier 3 在相关活动或本人已编辑的教材页就地采纳或忽略。Tier 4 显式确认战略路线、超出既有授权的隐私外发与费用上限，或不可逆操作。
   - 执行完毕写回事实与 1 句语义 Digest → 可再次轻量唤醒前哨决定是否接力下一步，形成连续 Always-Doing。

### 1.1 三态 `Todo` 事件契约（落在 PG `Working State`）

每条 `Todo` 为一等持久化对象，核心字段：
- `todo_id`、`dedup_key`（业务幂等键，如 `remediate:kc_ellipse_e`、`plan:2026-11-20`）
- `trigger`（三选一，**禁止前哨手写复杂表达式**）：
  - `immediate`：同事务写 outbox，立刻派发 `mangekyoWork`。
  - `scheduled`（`fire_at`）：到点自动派发（如自研遗忘预测滑坡前 6–12h 提前备短测）。
  - `event`（**有限枚举触发器**）：如 `on_attempt_submitted(topic_id)`、`on_work_completed(todo_id)`、`on_material_uploaded(tag)`、`on_session_ended()`。
- `worker_profile`：`heavy_tutor_prep` / `deep_analyst` / `question_author` / `deterministic_compute`（纯算力/遗忘重算不调 LLM）。
- `goal`、`refs[]`、`source_fact_rev`、`autonomy_tier`、`budget_cap`、`chain_id`、`hop_count`。

### 1.2 四个极简护栏（严格落在 ≤10% 防御预算内）

1. **0-Token 变更门控**：定时唤醒先由确定性代码检查是否有到期 `scheduled` Todo（有则直接派 `mangekyoWork`，免问前哨）；若无到期 Todo 且自上次游标无新事实写入（`fact_rev` 未变），直接休眠，**连便宜模型都不调**。
2. **语义去重键 `dedup_key`**：同键未完任务只更新/忽略，防止连续错题叠罗汉式并发拉起多个重型 Agent。
3. **触发前确定性复验**：`scheduled` / `event` Todo 命中准备派发前，检查 `source_fact_rev` 未撤回、目标未过期、当期预算未耗尽。
4. **自动接力跳数硬顶**：同一静默周期内由 `todo.completed` 链式触发的 `hop_count` 上限 3–5 跳 + 周期预算封顶，杜绝自激循环。

---

## 2. 轻量前哨的「全貌感知」与便宜模型 Skill + Prompt 设计

前哨必须**轻而不瞎**，且面向低智力/便宜模型将开放式规划降维为**菜单式分诊 + 槽位填充**。

### 2.1 每次唤醒的战情室热快照（~1.5k–3k tokens，代码物化、吃 Prompt Cache）

- **稳定前缀（高缓存命中，仅底层变动时刷新）**：
  1. **目标与红线（`Belief Store`）**：当前目标、DDL/考试时间、用户明确偏好与禁区。
  2. **学情雷达（`Learner Model` + 自研遗忘模型）**：最脆 Top-N 知识点、活跃错因「病」档案、未来 24–48h 即将跌破保持阈值队列、近期负荷/情绪状态标签。
  3. **供给与在途看板（`Working State`）**：全部活跃 `Todo`（含 `dedup_key` 与触发器）、**已备好但未使用的库存材料**。
  4. **编排备忘录（`Orchestrator Memo`）**：**最多 5 条 × ≤40 字、整表覆写、每条必带 `expires_at`**（过期由代码自动清理），保存未成熟观察线索。
- **动态尾缀（增量语义流 Delta Digest）**：
  - 统一订阅 5 类事件源（学习行为、前台对话信号、自研遗忘/认知引擎、用户治理/撤回动作、执行器完工回执）。
  - 确定性事件用模板渲染 1 句话；**前台对话与强力 Agent 结单时顺手吐 1 句结构化语义 Digest**，前哨无需重读万字长文。

### 2.2 前哨工具权限（极简 + 硬上限）

- **最多 4 个编排原语**：`emit_todo`、`update_or_cancel_todo`、`noop(next_recheck_hint?)`、`escalate_to_user`（Tier 3 仅就地呈现，Tier 4 显式确认）。
- **最多 3 个浅层只读窥视**（单次唤醒硬限 **≤2 次**；需要深翻多份卷子则立刻派 `deep_analyst` Todo）：`inspect_event(event_id)`、`search_workspace(query, kind)`、`read_recent_experience(topic_id)`。

### 2.3 菜单式 Skill 卡 + 便宜模型防呆纪律

- **按唤醒源预挂载 2–3 张 Skill 卡**（不把全库糊进 Prompt）。每张卡固定 5 段结构：`when`、`when_not`（克制行动偏置的核心）、`must_check`、`todo_template`、`examples`（固定 2 正 1 反极短 Few-Shot）。
- **Prompt 铁律**：`noop` / 及时 `cancel_todo` 为默认首选；必须点名命中某张 Skill 且确认无现成库存才允许 `emit_todo`；所有 ID 只能从快照原样复制；输出单一严格 JSON（`matched_skill / reason_brief / actions / memo_table / next_recheck_hint`）。
- **首批 6 张核心 Skill 卡**：
  1. `remediate_misconception`（同类错因重复出现且无现成库存 → `immediate` 补救备课）
  2. `preemptive_forgetting_prep`（自研遗忘模型预测即将滑坡 → 提前 6–12h `scheduled` 低负担复测）
  3. `defer_or_cancel_on_fatigue_or_undo`（用户喊累、提前掌握、或刚撤回同类产物 → 立刻撤回/推迟待发 Todo）
  4. `exam_or_goal_shift_replan`（前台对话出现考试改期/新目标 → `immediate` 重排计划并清理过时 Todo）
  5. `chain_post_work_followup`（强力 Agent 完工或整套练习提交 → 评估是否挂下一跳 `event`/`scheduled` 验收 Todo）
  6. `escalate_ambiguous_deep_case`（需要翻阅多份原卷或跨学科权衡 → 不自己猜，派 `deep_analyst` Todo）
- **持续进化**：建立 **20–30 条黄金分诊 Fixture Eval**（测误派率/漏派率/撤回命中率），改 Prompt/换便宜模型秒级回归；低频用强力模型复盘 `Experience Ledger`（尤其是被用户撤回/忽略的负样本），自动提议给 Skill 补 `when_not` 与反例。

---

## 3. 主 Agent 的记忆装配与写入边界

主 Agent（前台伴学 + 后台领单）统一通过 **Memory Gateway** 按 `intent` 装配带预算的 `ContextBundle`，并附带「被省略区域与展开方式」索引：

- `tutoring` → 课程知识 + `Learner Model`（掌握度与自研遗忘状态）+ 命中的 `Verified Playbooks` + `Belief Store` 偏好/红线。
- `planning` → `Learner Model` + 目标/DDL + `Working State`（在途 Todo 与已备库存）。
- `execution` → 当前 `Todo` 契约 + 引用 `Chronicle` 原件 + 相关 `Playbooks` + `Experience Ledger` 近期失败案例。
- `history` → 原始 `Chronicle` 事件 + `Claim → Evidence` 精确指针 + 双时间线（`validFrom / recordedAt`）。

**四条写入权威边界**：
1. 用户显式“记住/纠正/忘掉”走即时路径提交 `Claim`（带原话片段与 `supersedes`），提交成功才回执。
2. 主 Agent 可写 `inferred` 学情观察，**严禁直接修改 `Learner Model` 掌握度或自研遗忘参数**（仅由判分/遗忘计算引擎产出）。
3. `Experience Ledger` 由宿主自动记账；主 Agent 不能自评晋升 `Playbook`，须经后测或用户反馈独立验证。
4. 前台回合或后台 `Todo` 结束时，顺手回写 1 句结构化语义 Digest 供前哨消费。

---

## 4. 主 Agent 数据盲区修复与 5 项前沿工具升级（按 ROI 排序）

对照当前实现（`executors/teaching/workspace-tools.ts`、`study-agent.ts`、`runtime/studio/workspace-read.ts`、`workspace-agent.ts`）与产业前沿（Claude Code / Codex CLI / Notion & Linear MCP / Programmatic Tool Calling），优先落以下 5 项：

### P1. 放开只读并发 + 升级混合检索与 `learner` 雷达视图
- **解除 `parallel_tool_calls: false`**（`study-agent.ts`）：按 Codex 共享/独占锁模型，**只读工具默认并发，同对象写工具互斥串行**；后台重型 `Todo` 放宽步数上限（前台 12 步、后台按任务预算配置）。
- **替换纯子串匹配**：将 `workspace-read.ts` 的 `position(lower(...))` 升级为 **PG FTS/`pg_trgm` + 语义向量混合检索**，支持 `since` 时间与硬约束过滤（题库未暴露答案等）；返回强制包含 `excerpt`、`occurredAt`、`tags` 与未生效筛选提示。
- **充实 `learner` 视图**：不再仅拼最近 8 条标题，改为返回 **自研遗忘预警队列、活跃错因「病」、知识图谱多跳先修查询入口、已备未做库存、近期用户撤回/负反馈、在途 Todo 摘要**。

### P2. 拆分六合一 `save_workspace` + 引入局部 `patch` 与批量读取
- 将 `save_workspace` 按对象拆为高频窄工具（`save_page`、`save_question`、`record_observation`、`save_memory`、`save_relation`、`prepare_activity`），低频/插件/MCP 能力统一走 `find_tools` 按需加载。
- `save_page` / `save_question` 支持 **`block_id` 或唯一文本锚点局部 `patch`**，消灭全文覆写。
- `open_learning` 支持 **`refs: string[]` 小批量直读**，长文按结构段落（`part` / 题号）切片，不按 4000 字符硬截断公式/表格；上下文裁剪覆盖所有工具输出（含 `python` / `exa_search`）。

### P3. Python 沙箱注入受控只读数据客户端（Programmatic Tool Calling）
- 在现有隔离 `python` 沙箱中暴露极轻的只读 `mangekyo` 客户端（复用同一权限与 `accessEpoch` 过滤），允许主 Agent 用 **1 次脚本**完成多份作答统计、错因聚类、遗忘曲线核验或大题库筛选，再输出紧凑结论，避免 10 轮串行 tool call 人工数数。

### P4. 结构化自愈报错 + 拆清 `unavailable` 语义
- 工具错误统一返回 `{ code, field?, message, next?: { tool, args } }`（例如版本冲突附最新 `rev` 与变更提示，沙箱超长输出提示写入文件或聚合打印）。
- 将 `workspace-read.ts` 坍缩的 `unavailable` 明确拆分为 `not_found`、`access_revoked`（不泄露撤权正文）、`basis_stale`，防止 Agent 盲重试或误判为“从未发生”。

### P5. 多模态原图裁剪返回 + `current_attempt` 语义别名
- `open_learning({ ref, part: "image_crop" })` 支持返回原生图像内容块（手写卷、几何图、公式原图区域），消除 OCR 失真盲区，同时在作答视图中暴露有效用时与帮助曝光（`help_exposure`）。
- 支持 `current_attempt` / `current_page` 语义别名，并将本轮用户正在查看且已授权的原件由宿主预注册进 `opened` 集合，免去重复空跑一次只读调用。


## 5. 开发与合入顺序

以[产品共享合同](product-contracts.md)的正常入口验收衔接两条在途主线。两边共用实际来源、用途和版本见证。队列状态进 Working State，正式产物经各领域原有命令或推导接受。调度、接力和外部效果复用内核账本与 Temporal 恢复路径。学习保持、预测和对账沿用自研版本化槽位，支持 shadow 对照。

| 合入顺序 | 后台教研与 Temporal（单元 14） | 同伴工具与记忆（单元 12、13、21） |
| --- | --- | --- |
| 1 | 持久三态 Todo 与唤醒门控。已有协调器登记 immediate、scheduled、有限枚举 event；到期或命中后按工作单派发 Worker。先贯通启用后零待办、读取获准旧作、确定性任务写回可打开产物及 Digest。初次启用的配置修订可触发一次发现。 | 记忆装载提炼为四类 intent 共用的 Memory Gateway。保留实际来源、有效期、预算、缺项和展开入口。本人即时 Claim、前台完成 Digest 与同伴出站见证作为首条真实路径。 |
| 2 | 快照物化、短 Memo 与 5 类事件 Digest。先把后端实际 Todo、已备库存和用户目标接到 1.5k–3k token 快照。实现按唤醒源选择卡片、至多两次窥视和严格输出。 | P1 并行读取、同对象写入串行，后台步数按任务预算。图谱检索承接多跳与时间、范围、曝光过滤。PG FTS 和 pg_trgm 提供词法候选，向量候选通过同一融合、权限和版本入口。learner 雷达接自研保持预测、错因、先修、库存、反馈及在途 Todo。 |
| 3 | 首批 6 张卡，配 20–30 条黄金分诊 Fixture，比较误派、漏派和撤回命中。用前后台统一 Digest 接下一跳。并行 Worker 按工作单预算，首个完整链覆盖正常结单、重开与可继续学习。 | P2 与 P4 共用工具合同。窄写工具与 find_tools、块/锚点 patch、小批量及结构切片、全工具上下文裁剪一起接线；统一错误码与可执行下一步，区分找不到、撤权、基版失效。 |
| 4 | 验证真实留存、反馈回流与多步接力。模型路由只在适用用途、接收方和额度内运行，在可用路径稳定后再比较不同轻量模型和 Skill 版本。 | P3 在现有 Python 隔离中接只读客户端，复用同一授权批量读。P5 复用原始材料锚点返回原生裁剪，补有效用时、实际曝光和 current_attempt / current_page，宿主预注入已授权的已读引用。 |

验收优先覆盖一条真实学生主路径和一个关键失败。后台证明无变化时模型调用为零、到期确定性任务无需前哨、完成摘要只触发一次下一跳。主 Agent 证明新材料或作答实际进入获准模型请求，可跟回版本与原文；本人直接更正记忆可立即回看；检索、脚本和图像沿用同一授权边界。各批保持常规 CI 在两分钟内，独立复核仅用于内核事务、数据删除和隐私外发。
