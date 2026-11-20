# 08｜全链路统一信息总线重构裁决（物理极简统一 × 记忆深度完整 × 能力零缩水）

- 版本：2026-11-21｜**Owner 确认的最高收口与重构裁决层**
- 效力：统一收口 `00`–`07` 中的重叠概念、双轨机制与胖工具定义；凡涉及底层存储模型、内核总线、记忆权威边界、前哨协议与工具目录之处，**以本文为最终实现基准**；产品全范围与功能细节继续完整承接 `01`–`07` 与 [PRD.md](../PRD.md) / [product-spec.md](../product-spec.md)（**一毫米不缩水**）。
- 核心铁律（承接 R0 §14）：**「六类认知状态是严格的逻辑权威边界，而不是六个物理数据库；物理基础设施彻底做减法，记忆深度与产品能力零妥协。」**

---

## 1. 物理基础设施极简收口（砍掉 40%+ 架构冗余与 6 份重复鉴权税）

### 1.1 立即修复的现代码病灶
1. **修隐私默认值 Bug**：将 `kernel/src/schema.ts` 的默认 `purpose` 从 `'{all}'` 改为 `'{storage}'`（严格落实 D06 首次未确认默认“仅保存”）。
2. **废除 `runtime/studio` 旁路读层与重复路由**：禁止模块外服务各自实例化 `createCommandHandler`（传空 `onFactsChanged` 绕过传播）或裸查 `facts` 复制鉴权；Web / Agent 工具 / Memory Gateway / 前哨快照 / Python SDK **全部收口为同一内核总线的轻量 Preset**。
3. **取消 `working_todos` 双轨调度**：并入内核 `work(family, trigger, fire_at, event_match, priority, dedup_key)`，由 Temporal 唯一托管耐久执行。

### 1.2 统一物理核心：4 族底层资产事实 ＋ 唯一 3 总线原语
- **统一物理载体（大模块收口，消灭孤岛）**：
  1. **`Asset`（统一 `ContentUnit + Block[]`）**：收口拍卷分层切片、共享材料、Notion 只读页面/DB 行、题库题、活教材页、规范实体（Concept/Method/Archetype，内置 `aliases + embedding + merged_into` 透明重定向）与学科语境。差异仅留在薄类型字段（如 `question` 挂 `response_schema + assessment_contract`，`textbook` 挂 `base_rev` 双端冲突），**共享同一套混合检索、权限/`access_epoch`、防剧透与 `Ref(unit_id, block_id)` 反链**。
     - **消灭 `notion_read` 双轨分裂**：`notion_read` 不建旁路数据副本，检测到更新时**就地推进 `capture.source` 新修订**，按 `notion_block_id` 做块级哈希 Diff，仅变动块重跑切片与连边。
  2. **`Activity`（统一活动三元组）**：单题、练习卷、独立后测、回忆卡、学习型课堂、聊天检查、作文、代码项目、教同伴、挑刺构题统一为带 `modality` 的单一模型——共享同一套冻结 `items[]`、带 `base_rev` 草稿（含原位草稿 `scratchpad`）、不可变提交、统一 `Process`（有效用时 / 帮助曝光与跨题污染 / 信心 / 跳过 / UI 状态）与同一 `Evaluation`（8 态 `status` + 分步证据 + 5 值 `error_stage` + 迁移资格）。
  3. **`Edge`（唯一跨源有向边）**：`(from_ref, to_ref, kind, basis[], author, confidence, sticky)`，一份结构统一贯通知识图谱、变式族谱、母题折叠、教材映射、题-页反链、**题目 ↔ Notion 笔记 2 跳互联**，以及 **记忆主张间的逻辑关系网（`supports / contradicts / supersedes / related_to`）**。
  4. **`Turn` + 内核 `work`**：前台对话回合与后台耐久工作单统一承载 `@res_* / @calc_*` 句柄与执行上下文。
- **唯一 3 个内核总线原语**（全端共用单点 `guardAccess()` + `BlobRef` 外置加密正文 + 零正文独立防复活 `tombstones`）：
  1. `bus.query(scope, filter, actor)`：单点强执 `learner_id + purpose + access_epoch + tombstones + 防剧透`，并行执行 PG FTS / `pg_trgm` / 向量 RRF 融合，自动收集 `witnesses[]`。
  2. `bus.resolve(refs[], preset)`：1–8 批量直读 + 1–2 跳 `Edge` 展开 + `overlay` 活槽位聚合 + 超 2 KiB 自动物化 `@res_*` 句柄 + 读时自动惰性刷新冷对象。
  3. `bus.mutate(command)`：统一校验 `expected_rev / sticky / 绿黄红自治`，返回 `undo_token | proposal_id` 或唯一 **7 码一枪自愈 `ToolError`**。
- **冷历史 × 活外衣的零风暴实现**：
  - 冻结题面、原答、原图、有效用时、当时帮助曝光永存 `fact_revs`（历史 `pinned` 永不篡改）；
  - 题目的活元信息（`overlay.question_meta`）与作答的活诊断（`overlay.submission_diagnosis`）全部声明 **`policy: 'lazy'`**，从源头杜绝同步级联风暴；复用 `derivation_deps` 反查与 `work.priority`（`0=热立即 / 1=温≤20%后台预算攒批 / 2=冷标 behind 读时惰性刷新`）；本人修改标 `sticky=true`，读层按 `merge(overlay, sticky_overrides)` 合成，重算遇 `sticky` 自动转黄灯 `proposals` 永不覆盖。

---

## 2. 记忆与认知深度零妥协（严格守住 R0 六类逻辑权威边界）

**绝不把全部记忆压扁成一句通用文本！** 在上述极简物理底座上，通过强类型 Schema、写入权威门控与独立生命周期，完整守住 《Memory & Cognition Architecture · R0》 的六类逻辑边界：

| 逻辑层（权威边界） | 物理承接（0 多余数据库） | 不可妥协的核心语义深度 |
|---|---|---|
| **1. Chronicle（一手原始经历）** | `Asset(capture, notion)` + `Activity` + `Turn` | 永不篡改的原始证据流，带精确 `occurredAt / recordedAt / span / contentHash`，唯一合法源头。 |
| **2. Belief Store（可争议主张网：严格二分 `Directive` 与 `Hypothesis`）** | 物理同属内核 `facts`，逻辑拆清为两个正交子模型 + `Edge(supports/contradicts/supersedes)`：<br>• **`Directive`（主权规则与边界）**：吸收 `preference / refusal / 显式声明 / 短期 TTL 状态`。权威来自**学习者意志**，无需做题证伪；硬执行于排期、过滤与防打扰（`refusal` 必带 `goal + intent_key + reopen_condition` 机械防换词重推）；只因本人改/撤或 `validTo` 到期失效，**稳定偏好绝不按 30 天淘汰**。<br>• **`Hypothesis`（实证认知假设）**：吸收 `misconception / metacognitive_habit / observation / memoryAssertion`（`observation` 为其 `tentative` 初态，单科错因 vs 跨科元认知仅 `scope` 不同）。权威来自**客观证据**，走 `supports / contradicts / disputed / improving / retired / relapsed` 科学证伪演化。 | ① **双时间**：`validFrom/validTo`（现实有效区间）× `recordedAt/supersededAt`（认知时间），支持 `asOf` 历史时点查询；<br>② **冲突并存**：`Hypothesis` 矛盾先标 `disputed` 并保留双方证据，严禁粗暴后写覆盖；<br>③ **5 级信任梯度**：用户原话/业务事件 > 一手工具观测 > 独立验证观察 > Agent 推论 > Agent 摘要/便条；`Consolidation` 派生摘要严禁回流当提取源（杜绝自证循环）；<br>④ **区分三层置信度**：原话确定度 ≠ 事实真伪 ≠ 教学结果有效证据。 |
| **3. Learner Model（独立多维状态）** | `modules/learner` + `executors/python-worker` | **严禁 LLM 自由改写**；由计算\*引擎维护 `(KC/子技能 × 表征 × 情境 × 方法)` 的连续掌握度、不确定性、读时遗忘 `R(t)`、事前冻结预测对账校准与 Shadow 全历史重放。 |
| **4. Experience Ledger（完整执行轨迹）** | 内核 `runs + actions + outcomes` 结构化轨迹投影（**零双写，但绝不删字段**） | 完整记录 `runId / objective / strategyId / actionRefs / observationRefs / outcome / verificationRefs / userFeedbackRefs / latencyMs / tokenCost`，支撑控制混杂因素后的因果复盘。 |
| **5. Verified Playbooks（程序性记忆）** | `learner.playbook` 独立结构化事实 + `understanding_status` 核验槽 | **绝不退化为一句文本！** 必须包含 `preconditions（适用前提）/ strategy_steps / counterexamples（已知反例）/ exit_conditions / version`；仅允许 Reflection 提议 → 独立后测 Lift 验证晋升 → 失效自动降级回滚。 |
| **6. Working State（可恢复现场）** | 内核 `work` + Temporal Workflow | 承载目标计划、步骤游标、待审提议与三态工作单（`immediate` / `scheduled(fire_at)` / **有限枚举 `event`**，保住跨周因果跟进如 `on_attempt_submitted(concept_id)`）。 |

### 全活动「以用定抽」双轨精简规则（零正则 + 正向证据不遗漏）
- **轨 1（回合内即时）**：自然语言明确表达记住/改/忘/约束/疲劳时，主 Agent 调 `save_belief` 语义定位已有条目（绝不让用户抄 ULID），直接写入带精确 `span` 与 `undo_token`。
- **轨 2（活动后异步批抽，便宜模型）**：
  - 严格按 `learner.clock` 攒批 + 源活动 `purpose` 门控 + **Link-Before-Create**（注入同 `concept_ids` Top-K，默认允许 `noop`）；单次弱推断锁死 `tentative` 不污染常驻 Prompt；
  - **独立全对的正确处理**：先走 **0-LLM 确定性正向更新**（自动给旧活跃错因挂 `contradict` 证据、结算教学干预正 Lift、入“旧稳桥接池 `mastery>0.8`”）；仅当“攻破活跃错因或课后首次陌生迁移全对”时低频触发抽取 1 条本人成功策略（喂养 Backtrace 成功通道）；
  - 撤回/跳过先走 0-LLM 计数门控（同模式 ≥2 次或附理由才抽打扰边界与 `when_not` 提议）。

---

## 3. Agent ↔ 计算\* 黄金接口与四通道精准利用

### 3.1 唯一零拷贝计算契约（`CanonicalEvidenceSlice@v1`）
通过统一 `bus` 一次过权限投影（**彻底废除 `ordinaryPaper()` 限制**），同一切片零拷贝喂给 `executors/python-worker` 与隔离 Python 沙箱：
- **输入**：`{ clock_watermark, as_of_at, events: [{ ref, rev, occurred_at, concept_ids[], item_novelty: 'same'|'isomorphic'|'transfer', help_level: 'independent'|'hinted'|'solution_seen', outcome, score_norm?, effective_duration_ms?, confidence?, error_stage?, claim_ids[] }], constraints: { budget_min, locks[], deadlines[] }, candidate_pool[] }`。
- **输出**：`{ method_version, state: 'known'|'unknown', state_vector, r_now?, crossing_at?, uncertainty, ranked_candidates: [{ ref, info_gain, est_min, reason_code }], anomalies: [{ type, refs[] }], artifacts?: ['@calc_*'] }`。

### 3.2 四通道利用接线（双层记忆装配 + 极简不阉割 UX）
1. **通道 1（硬利用，0-LLM）**：用途/删除代次、TTL 状态、战役态、拒绝意图、曝光与跨题污染、答案冲突、5 值 `error_stage`、高信心错答、遗忘 `R(t)` 直接硬输入排期、组卷、防剧透与路由。
2. **通道 2（0-LLM 界面原位浮现，<150ms）**：做题/错步首秒亮 **≤3 贴边胶囊 + 侧滑抽屉**（`[Notion块]`、`[Backtrace 错法+旧稳题]`、`[母题覆盖]`），不离作答流、不增第 5 导航；活教材旁反引错题与 Diff；开卷前命中跨科元认知仅浮 1 句轻提醒。
3. **通道 3（双层 Memory Gateway：首轮极速预装配 + 深度按需检索）**：
   - **首轮伴学/课堂 JIT 预装配（硬顶 ≤800t，5 槽）**：`锚点≤220t（版本+草稿分叉diff+UI状态+已展提示）| 错因≤150t | 桥接≤180t（1 Notion块+1旧错+1旧稳题）| 教法≤150t（top-2 Playbook+TTL+拒绝）| 规则/未呈步≤100t`，确保首字 <1s 且开口就懂你；
   - **深度按需检索**：保留 R0 完整 6 意图（`conversation / tutoring / planning / execution / history / reflection`）、`asOf` 历史时点查询、`omitted[]` 展开句柄、精确区分“搜不到”与“外部故障”。
4. **通道 4（后台直学成品 + 防臃肿 UX）**：后台备齐微课、考前 3 分钟急救卡、反幻觉检查卡与母题/时间策略报告；**「今天」保留完整紧凑的 2–3 项今日组合单**（总时长/逐项为什么/推迟影响/可锁定换选休息 + 一键切 `3min 单手`），不阉割掌控感；Trace、园艺清单、校准与预算全沉「我」折叠区，0 强制表单。

---

## 4. 极简高智 Always-On 编排 ＋ 真·10 常驻窄工具 ＋ 零新表自进化

### 4.1 90% 0-Token 直通 ＋ 定长 ≤1200t 单轮前哨
- **代码直通层（0 LLM）**：提交/Notion 增量直驱确定性计算（遗忘/掌握度/正向反证）与异步抽取；到期 `scheduled` 与命中有限枚举 `event` 的 `work` 直接派发；热对象直刷、冷对象标 `behind` 读时惰性刷新。
- **定长热快照（≤1200t，前缀 100% 吃 Cache）**：单一 8 项键值雷达（脆点 Top3 / 24h 遗忘 / 高信心错答 / 考纲空白 / 弹药=0 / 温回填数 / 园艺候选 / 在途工作+库存）+ `Memo`（≤3 条×30 字带 TTL）+ 1 句动态 Digest + 按唤醒源预挂 **≤2 张家族卡**（4 大家族 4 卡，每卡 ≤150t）。
- **单轮无工具前哨**：默认 0 工具单轮输出严格 JSON（`noop` / `upsert_work` / `cancel_work`），信息不足直接派 `deep_analyst`（不让便宜模型多轮折腾窥视工具）；任务分 `P0(前台/Reactive/Prep)` 与 `P1(Synthesis/Maintenance，硬限 ≤20% 后台预算，前台活跃立即让路)`；**统一自治口径**：**绿灯 = Tier 1–2（直落+`undo_token`）** / **黄灯 = 待审园艺收件箱（非打扰批采）** / **红灯 = Tier 3–4（显式确认）**。

### 4.2 真·10 个常驻窄工具（底统表窄，绝不回退六合一）＋ 3 个按需维护原语
- **读 4（默认并发）**：
  1. `search_learning`（PG 混合+向量+认知过滤+1–3 跳图谱，天然覆及 Notion 快照）
  2. `open_learning`（1–8 批量、`current_*` 别名、`image_crop`、完整无阉割 `diagnose / remediate / grade` 3 镜头、读时惰性刷新冷对象）
  3. `read_context`（统一 Memory Gateway 入口：支持 `radar / conversation / tutoring / planning / execution / history / reflection` + `asOf` + `expand`）
  4. `find_tools`（按需注入长尾工具、MCP 与维护原语，平时 0 Token）
- **写与算 6（同 `ref` 自动互斥）**：
  5. `save_page`（新建 + `block_id`/锚点 `patch` + `@calc_*` 插入 + 可选 `merge_pages / split_page / archive` 跨页重构）
  6. `save_question`（窄结构入 IQDB + `patch` + 活外衣解法追加 + 独立多解验算门控，**保持与 `save_page` 分离**）
  7. `save_belief`（结构化写入/更正/撤回 Belief，**强制显式区分 `category: 'directive' | 'hypothesis'`**：`directive` 走主权规则/拒绝/TTL 校验，`hypothesis` 走 `evidence_refs + supports/contradicts` 实证门控；严禁直接改掌握度/遗忘参数或跳过独立验证直写 `Playbook`）
  8. `save_edge`（维护跨源图谱边、变式/母题边与 Claim 间 `supports/contradicts/supersedes` 关系边）
  9. `manage_activity`（统一编排课堂/短测/交互块、发起评估或申诉、更正 OCR 转写）
  10. `run_calculation`（隔离 Python 沙箱 + 全量只读 `mangekyo` SDK + `@res_*/@calc_*` 零复述传参）＋ `schedule_followup`（可按需挂 `find_tools` 或作为工作单回挂原语，支持 `immediate | scheduled | 有限 event`）。
- **经 `find_tools` 按需载入**：`evolve_graph`（实体合拆与 `merged_into` 重定向，默认黄灯）、`refresh_living_slots`（只刷旧题/旧作答活外衣，硬锁不动冷原答与 `sticky`）、`notion_read`（按需刷新最新 Notion 块至 `capture.source`）。
- **统一 7 码一枪自愈 `ToolError`**：`invalid_args | not_found(含 candidates[]) | access_revoked | basis_stale | version_conflict | evidence_not_opened | limit_exceeded`（部分成功改为 `ok: true, warnings[]`），必带 `message(≤60字)` + 可直接重放的 `next: { tool, args }`。

### 4.3 零新表自进化 ＋ 25 条黄金回归门禁
- 复用 `derivations.manifest` 与 `Experience` 轨迹：
  1. 追踪 `ContextBundle` 区块与预备库存实际引用率，持续修剪无效上下文；
  2. 任一 Skill 14 天 `undo_token` 撤回率 >15% 时，才触发 1 次低频强模型复盘并仅提 1 条 `when_not` 补丁；
  3. 每周确定性 Python 任务对账教学干预后 72h–14d 的**独立变式/迁移 Lift**（受助正确与原题重做不计正 Lift），达标才晋升 `verified_playbook`，显著负 Lift 自动降权并通知黄灯园艺清单；
  4. 持续运行 **25 条黄金回归**（15 前哨分诊 + 10 工具与一枪自愈），确保改 Prompt/工具/模型后**Token 不涨、分诊与自愈率 ≥95%**。
