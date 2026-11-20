# Mangekyō 个性化数据抽取规格：移除正则 Slop，转向全活动 Agent 抽取

- 日期：2026-11-20
- 决策来源：Owner 明确裁决——**移除正则收取这类 Slop，个性化数据由 Agent 从所有学习活动中自动抽取**。
- 关联文档：[PRD.md](../PRD.md) · [always-doing-and-agent-tools.md](always-doing-and-agent-tools.md) · [frontier-agent-tools-spec.md](frontier-agent-tools-spec.md)

---

## 1. 立即清除的正则收取 Slop 清单

以下要求学习者在自然语言里输入固定前缀或 26 位 ULID 的硬编码正则路径必须彻底移除，不再作为产品能力保留：

1. **`modules/companion/claim.ts` — `explicitClaimRequest()`**
   - 移除 `^记住(并用于教学)?[：:]`、`^纠正(并用于教学)? +<ULID>[：:]`、`^忘掉 +<ULID>$` 正则解析。
   - 解除 `claimInput()` / `claimValue()` 对“原话必须匹配上述正则”的 schema 限制；改为结构化语义字段：`{ action: 'remember' | 'correct' | 'forget', text, scope?, evidence_refs, quote_excerpt?, valid_until?, supersedes? }`。
2. **`runtime/studio/explicit-memory.ts` 与 `runtime/studio/teach.ts` 对应短路拦截**
   - 移除回复前靠正则拦截用户消息的旁路写入；所有对话内的记忆写入/更正/遗忘均由主 Agent 通过结构化工具完成，或由活动后异步抽取 Agent 沉淀。
3. **`runtime/studio/memory-gateway.ts` — `memoryScopeFromMessage()`**
   - 移除 `/^学习范围[：:]([^\n]+)$/mu` 伪命令行解析。
   - 记忆检索范围（`scope`）由两处自然决定：**（a）当前页面/学习对象的结构化上下文自动绑定**（当前试卷/题目/教材页/学科），**（b）Agent 自主调用 `retrieve_memory` / `search_learning` 按需取数**。

> 注：「我」界面依然保留学习者直接可视化查看、编辑、更正、删除任意个性化条目的操作入口；只是彻底消灭对话里的伪正则指令。

---

## 2. 核心设计：全活动 Agent 抽取（All-Activity Agent Extraction）

个性化数据不是聊天框的副产品，而是**从学习者全部 6 类日常活动中持续抽出的结构化认知与偏好事实**。

### 2.1 六大活动来源与抽取目标

| 活动来源（原始事实） | Agent 抽取的个性化数据 | 典型产出类型 |
|---|---|---|
| **1. 同伴对话（Companion Turns）** | 长期偏好、作息/时间/目标约束、讲解风格喜好、短期状态（带 TTL，如疲劳/考试周）、口头暴露的误解、显式“记住/改掉/忘掉”意图 | `learner.preference` / `companion.claim` / `learner.misconception` |
| **2. 作答、卷面与独立后测（Attempts / Recall / Posttests）** | 超越对错的结构化**稳定错因**、典型失误习惯（跳步/漏单位/符号错）、提示依赖模式、卡壳耗时特征 | `learner.misconception` / `companion.memoryAssertion` |
| **3. 拍卷与原件交入（Intake：照片 / PDF / 讲义）** | 多模态分层抽取：**印刷题干 / 本人手写作答 / 红笔事后订正（按个人习惯处理）/ 边栏批注 / 看不清（`unknown`）** | `capture` 分层事实 + `activity` 提交事实 |
| **4. 个人教材与活笔记（Textbook & Notes）** | 学习者自创的口诀/理解框架、高频反复改写的难点、自标错处与反引脉络 | `learner.playbook` / `companion.memoryAssertion` |
| **5. 互动课堂与生成式作品（Artifacts & Classroom）** | 实证有效的脚手架/类比/可视化方式（用后独立做对的讲法）与无效策略 | `learner.playbook`（回灌 `verified_playbooks`） |
| **6. 隐式交互与负反馈（Undo / Reject / Skip / Lock）** | 撤回后台备课、忽略某类推荐、反复推迟或锁住某安排所折射的打扰边界与节奏偏好 | `learner.preference`（短期/长期）+ `Experience Ledger` |

### 2.2 双轨执行模型（低延迟 + 零打扰 + 可控成本）

1. **轨 1：回合内即时写入（In-Turn Tool Call）**
   - 当学习者在自然对话中直接表达“以后物理题先画图别直接给公式”“周六不安排学习”“之前那条改一下/忘掉”时，主 Agent 在回复同一回合直接调用窄写工具 `save_memory`（支持 `remember / update / forget`，按语义匹配已有条目而非让用户抄 ULID）。
   - Tier 1–2 直落并返回 `undo_token`，界面附带轻量可撤回提示，不打断对话。
2. **轨 2：全活动异步抽取（Post-Activity Async Extractor，挂接 Temporal / Always-Doing）**
   - 任何获准（`purpose` 允许）的学习活动落库后（交卷、完成对话片段、原件入库、保存教材笔记、触发撤回/拒绝），由异步抽取工作流在后台消费**增量活动切片 + 相关已有画像摘要**，由 Agent（便宜/中档模型按需路由，受预算约束）统一产出增量抽取结果：
     - **新增**（附精确 `evidence_refs` 与简短原话/作答摘录）
     - **强化或反驳已有断言**（接入现有 `modules/companion/memory-review.ts` 的 `supporting / contradicting` 正反证据校验，让 `MemoryAssertion` 自动演化而非手工维护）
     - **衰减或过期**（短期疲劳、考前冲刺等必须带 `valid_until` TTL，到期自动失效，不变成永久标签）

### 2.3 让 `memory-gateway` 真正活起来

清除空转区域，把上述抽取产出稳定灌入 `memory-gateway.ts` 已规划的各区：
- `preferences` ← 对话/隐式反馈抽取的稳定偏好与约束
- `claims` ← 明确的声明与短期状态（无正则门槛）
- `memory` ← 跨活动归纳并经 `memory-review` 校验的长期 `MemoryAssertion`
- `learner_model` ← 知识点掌握度、连续保持率与结构化 `misconception`
- `verified_playbooks` ← 经后续独立作答验证有效的个人讲解/脚手架方法
- `experience` / `chronicle` ← 撤回、拒绝、跳过与近期教学实效摘要

---

## 3. 质量与安全红线（不靠正则，靠结构与证据链）

1. **零正则语义抽取**：禁止用关键词表或正则匹配代替 Agent 理解用户意图或提取画像；规则校验仅限技术边界（ID 格式、长度、枚举、TTL、权限）。
2. **强证据绑定**：每条抽取必须指向真实且当前获准的源活动 `evidence_refs`（`fact_id + rev + excerpt`）；撤回源材料用途时，依内核依赖规则自动失效或重新校验。
3. **粘性与防复活**：学习者亲手编辑、否定或删除的条目具有粘性（`sticky`），后续异步抽取不得静默覆写或从旧活动重新复活已删条目。
4. **防过拟合与“不知道”诚实原则**：单次孤立口误或偶然情绪不得直接固化为长期能力标签；证据不足保持观察态或 `unknown`。
5. **全量可查可撤回**：所有 Agent 抽取结果带 `undo_token`，在「我 → 它对我的理解」透明展示来源证据并支持一键更正/删除。

---

## 4. 验收标准

1. **Slop 清零**：代码库中不再存在 `explicitClaimRequest`、`memoryScopeFromMessage` 及任何要求用户输入前缀语法或 ULID 的对话记忆解析逻辑。
2. **自然对话即时抽取**：用户在普通聊天中说“我每周六打球不学，以后讲物理题先画受力图别直接扔公式”，无需任何特殊格式，Agent 自动落库两条带原话证据与 `undo_token` 的个性化记录，并可在下一轮伴学与排期中真实生效。
3. **跨活动异步抽取闭环**：连续完成「交卷错题 + 修改个人教材页 + 撤回一张自动复习单」后，异步抽取 Agent 自动产出结构化错因、个人理解断言与负反馈偏好，写入对应内核事实并能经 `memory-gateway` 被同伴与前哨读回；撤回任一源活动授权后，对应抽取条目按既有边界失效且不外发。
