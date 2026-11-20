# 04｜Always-Doing 两层编排、唯一全能同伴、Memory Gateway 与超越前沿的工具体系

- 归属模块：`modules/companion`、`executors/teaching`、`executors/temporal`（对接 `kernel` 统一读层）
- 覆盖范围：PRD §2.3、§2.4、§2.11、D07、D09（F10–F16、F27–F30、F63、F66–F69）与 [always-doing-and-agent-tools.md](../design/always-doing-and-agent-tools.md)、[frontier-agent-tools-spec.md](../design/frontier-agent-tools-spec.md)

---

## 1. 真·Always-Doing 两层编排架构（解除 0 成本静态模板硬锁）

### 1.1 轻量前哨编排 Agent（`mangekyoCoordinator`）
- **常驻运行**：Temporal 长生命周期 Workflow（`Continue-As-New`），由事件信号（`wakeCoordinator`）与定时窗口（`recheckAtMs`）唤醒。
- **必须接入真实便宜快模型分诊**（彻底废除当前“只放注释不接模型、靠硬编码条件只发 0 元复习单”的残缺实现）：
  - **0-Token 变更门控**：唤醒先由确定性代码检查到期 `scheduled` Todo（直接派发）与新事实游标（无变化直接休眠，0 Token）；
  - **可缓存战情室热快照（~1.5k–3k tokens）**：
    - 稳定前缀（高 Prompt Cache 命中）：目标与红线（`Belief Store`）+ 学情雷达（脆点 Top-N、活跃错因、24–48h 遗忘预警队列、近期负荷/情绪）+ 供给与在途 `Todo` 看板（含已备未做库存）+ 编排备忘录（`Orchestrator Memo`：≤ 5 条 × ≤ 40 字，每条必带 `expires_at`）；
    - 动态尾缀（Delta Digest）：5 类事件源的 1 句结构化语义摘要（学习行为、前台对话 Digest、遗忘/认知引擎预警、用户撤回/治理动作、执行器完工回执）。
  - **菜单式 Skill 卡 + 极简原语**：按唤醒源预挂 2–3 张 Skill 卡（`remediate_misconception`、`preemptive_forgetting_prep`、`defer_or_cancel_on_fatigue_or_undo`、`exam_or_goal_shift_replan`、`chain_post_work_followup`、`escalate_ambiguous_deep_case`）；仅开放 4 个编排原语（`emit_todo / update_or_cancel_todo / noop / escalate_to_user`）+ 最多 3 个浅层只读窥视（单次 ≤ 2 次）。
  - **黄金分诊回归集**：维护 20–30 条覆盖误派/漏派/撤回命中/跳数上限的真实便宜模型回归样例；低频用强模型复盘被用户撤回的 `Experience Ledger` 负样本并提议补充 Skill `when_not`。

### 1.2 强力后台执行者（`mangekyoWork`）与五类 Worker Profile
**彻底解除 `runtime/studio/research.ts` 中 `workerProfile !== 'deterministic_compute' || budgetCap !== 0 || autonomyTier !== 1` 的硬锁！** 在用户已设置的后台预算与暂停开关内，完整放开 5 类后台工作：
1. `deterministic_compute`：遗忘重算、信息量摸底、确定性兜底安排（0 模型费用）；
2. `personalized_extractor`：全活动异步个性化数据抽取（产出偏好、声明、错因、断言演化与 `playbook`）；
3. `heavy_tutor_prep`：备好「今天」的真实讲义、针对具体错因的微课/复习单、自主回看获准旧作修订自己写过的个人教材草稿（Tier 1–2 直落并附 `undo_token`）；
4. `question_author`：针对题库缺口生成变式/诊断题并完成独立多解并行验算；
5. `deep_analyst`：跨多份原卷、多学科或复杂卡壳场景做深度诊断与归因。

- **三态持久化 `Todo` 契约**（`immediate` / `scheduled(fire_at)` / `event(有限枚举)`）：统一带 `dedup_key`、`source_fact_rev`、`autonomy_tier`、`budget_cap`、`chain_id`、`hop_count`（静默自动接力硬顶 3–5 跳）。
- **真·离场自主工作（单元 14）**：即使关闭全部浏览器界面、清空待办且无新消息/定时课，后台同伴仍能按获准范围自行回看旧作与自己写过的讲义，留下有原文依据的修订提议；服务重启后由 Temporal 自动续跑，学生回来直接看到已保存成果与依据。

---

## 2. 唯一全能同伴与 Memory Gateway

### 2.1 唯一同伴（`modules/companion` + `executors/teaching`）
- **一贯身份**：全产品只有一个面向学习者的对话者，人格全局一致、可定制、分寸得当（不说教、不替做、不叠前置 AI 审查链）。
- **架构收敛**：对齐 [ADR-0010](../adr/0010-pi-agent-sdk.md)（Pi Agent Core + Pi AI，或统一干净会话内核），告别多套割裂协议循环；执行进度、等待、工具结果复用与断线恢复由 Temporal 唯一托管。
- **默认模型与路由**：按产品规格 D07，统一设置面板支持自定义服务地址与密钥（仅存服务端，切换端点绝不串发原密钥），教学 Agent 默认配置 DeepSeek 4.1 Flash（`thinking: high`），且每次运行公开实际生效的 `served_model` 与费用，未知不伪造。
- **富流式 SSE**：实时推送公开正文、学生易懂的工具进度（如“在查你上次的解法”“正在核对这道题”“这道题可用”）、逐笔校验绘图、Generative UI 块与可一键撤回的写入卡片；断线/刷新无缝恢复已完成进度与产物。

### 2.2 全量供血的 Memory Gateway
统一按 5 种 `intent` 装配带 token/字节预算的 `ContextBundle`，附带 `omitted[]` 展开句柄（**严禁空转，每个区域均由 `02` 的全活动抽取与认知引擎真实供血**）：
- `tutoring`：`current_object` + `preferences` + `claims` + `memory`（经 `memory-review` 核验）+ `course_knowledge` + `learner_model`（多维掌握度/错因/保持率）+ `verified_playbooks`；
- `planning`：`goal` + `constraints_and_locks` + `learner_model` + `forgetting_queue` + `todo` + `inventory`；
- `execution`：`todo_spec` + `chronicle_refs` + `verified_playbooks` + `experience`（近期撤回/失败反例）；
- `history`：`chronicle` + `claim → evidence` 精确指针 + 双时间线（`validFrom / recordedAt`）；
- `reflection`：跨周 `experience` + 预测对账校准 + 被撤回负样本汇总。

---

## 3. 全面对齐并超越产业前沿的工具体系（10 窄核心工具 + `find_tools`）

**彻底淘汰六合一 `save_workspace`**；主 Agent 常驻仅暴露 **10 个高内聚窄工具**（长尾领域命令、学科工具与获准 MCP 全部经 `find_tools` 按需注入，平时 0 Token 占用），并按 `mode`（伴学/考测/后台备课/前哨）自动裁剪视图与防剧透边界。

### 3.1 读取与探索组（默认并发安全 `concurrency: "parallel"`）
1. **`search_learning`**
   - 底层：**PG `tsvector` + `pg_trgm` + 语义向量混合召回 + RRF 融合**（补齐向量语义通道，消除中文同义词盲区）。
   - 入参：`{ query?, kind?, filters?: { since?, until?, tags?, kc_ids?, answer_exposed?, mastery_lt?, retention_lt?, status? }, related?: { ref, depth?: 1|2|3 }, limit?, cursor? }`。
   - **真实认知态过滤**：`answer_exposed=false` 必须对接真实活动曝光史，绝不再长期退回 `unappliedFilters` 占位警告。
   - 返回：`{ items: [{ ref, rev, kind, title, excerpt, occurredAt, tags, state, match_reason }], unapplied_filters?, cursor? }`。
2. **`open_learning`**
   - 入参：`{ refs: string | string[], part?: string | "image_crop" | "diff", lens?: "raw" | "diagnose" | "grade" | "remediate", cursor? }`。
   - 特性：1–8 批量直读；`current_attempt / current_page` 自动语义别名且宿主预注册进 `opened`；按结构块/题号/公式完整边界分页（绝不按 4000 字符硬劈 LaTeX/表格）；`part: "image_crop"` 返回原生多模态原图裁剪块。
   - **三大无阉割复合镜头（1 轮顶 6 轮，严禁字段硬编码 `unavailable`）**：
     - `lens: "diagnose"`：冻结题面 + 原图裁剪句柄 + 学生原答 + 真实前台 `effective_duration_ms` + `help_exposure[]` + 冻结评估结果 + **该知识点最近 3 次真实历史作答摘要 + 当前多维掌握度与自研遗忘保持率**（仅当该生确实无历史数据时相应子项返回诚实 `unknown`）；
     - `lens: "remediate"`：目标活跃错因「病」档案 + 知识图谱 2 跳先修薄弱点 + 题库未暴露候选库存计数 + 近期被用户撤回/忽略的策略反例；
     - `lens: "grade"`：冻结题面 + 学生原答 + 锁定评估契约（强制屏蔽后续修订与干扰上下文）。
3. **`read_learner_radar`**
   - 返回结构化决策全景：脆点 Top-N（多维掌握度）+ 自研遗忘模型 24–48h 滑坡预警队列 + 活跃错因「病」清单 + 已备未做库存 + 近 7 天用户撤回/负反馈 + 当前在途 `Todo` 看板。
4. **`retrieve_memory`**
   - 透传至 Memory Gateway，按 `intent` 与结构化 `scope`（绝不靠正则从消息拆）拉取或展开 `ContextBundle`。
5. **`find_tools`**
   - 按需发现长尾领域命令、学科工具与获准 MCP 工具（并在实际派发前强制复验当前授权）。

### 3.2 写入与行动组（同 `ref` 自动串行互斥 `concurrency: "exclusive_per_ref"`）
6. **`save_page`**
   - 新建：`{ title, content | blocks, tags?, links?, insert_artifacts?: HandleRef[] }`；
   - **局部修改（首选，禁用整页重写）**：`{ ref, expected_rev?, patch: [{ op: "replace_block" | "insert_after" | "replace_anchor" | "delete_block", target, content?, artifact? }] }`；
   - 自治策略：AI 自建/Tier 1–2 页直接生效并返 `{ status: "saved", ref, rev, undo_token }`；修改学习者原创页返回块级可分项采纳的 `proposed` diff。
7. **`save_question`**
   - 窄结构写入 IQDB（题干/共享材料/作答位/交互块/解法/评估契约/语义标签/来源/patch），自动过独立验证门控返回 `{ status: "draft" | "needs_verification" | "ready", ref, rev, missing?, next? }`。
8. **`save_memory` / `record_observation` / `save_relation`**（三项独立极简窄工具）
   - `save_memory`：自然语言明确“记住/更新/忘掉”的语义写入（支持按已有条目语义更新或软遗忘，带原话摘录、`valid_until` 与 `undo_token`）；
   - `record_observation`：基于已打开 `evidence_refs` 记录可撤回学情观察（严禁直接篡改掌握度或遗忘参数）；
   - `save_relation`：维护知识图谱与变式族谱有向边。
9. **`prepare_activity` / `request_assessment` / `correct_transcription`**
   - 编排学习型课堂/短测/冻结试卷/交互块、发起独立评估或申诉复核、修正 OCR 抽取并自动传播。
10. **`run_calculation` + `emit_todo_hint`**
    - `emit_todo_hint`：主 Agent 将远期跟进线索直接回挂前哨 `Todo` 表后干净退场；
    - **`run_calculation`（完整学习原生 Python 沙箱）**见下节。

### 3.3 完整版 Python 沙箱只读 `mangekyo` SDK + 不可变产物句柄 `@res_* / @calc_*`
- **彻底废除 `python-attempts.ts` 中的 `ordinaryPaper()` 人工阉割限制**！通过统一内核授权读层，在隔离无外网 Python 沙箱中暴露极薄只读代理模块 `mangekyo`（复用同一 `maySend / accessEpoch` 鉴权、零写权）：
  - `mk.attempts(since=..., subject=..., paper_ids=...)`（支持跨卷、含材料卷、题库卷、正式评估卷、独立后测，含作答结果、有效用时与帮助曝光态）；
  - `mk.forgetting_risks(horizon_hours=48)`（读取自研遗忘预警队列）；
  - `mk.kg_prereqs(kc_id, depth=2)`（读取知识图谱多跳先修/后继）；
  - `mk.questions(kc_ids=..., answer_exposed=False, limit=30)`（题库多条件筛选）；
  - 内置 `sympy / numpy / matplotlib` 支持独立符号验算与精确绘图，输出保存为不可变产物句柄 `@calc_*`。
- **不可变结果句柄（`@res_*` / `@calc_*`）**：超阈值（如 >2 KiB）的工具回包与 Python 产物自动获配短句柄；上下文压缩时保留 `≤200 字结构化头 + @res_*`（覆盖全部工具）；模型可直接通过 `save_page(patch=[{..., artifact: "@calc_02"}])` 或 `run_calculation(inputs=["@res_04"])` **零复述传参**。

### 3.4 统一一枪自愈错误协议（覆盖全部读写工具）
所有工具（含写工具、检索、沙箱、权限、版本冲突）统一返回严格 `ToolError`，**绝不混用旧版 `{ error: "..." }`，绝不把不同根因坍缩成 `unavailable`**：
```ts
type ToolError = {
  ok: false;
  code:
    | 'invalid_args'        // 附 valid_fields
    | 'not_found'           // 附模糊匹配 candidates[]
    | 'ambiguous_ref'       // 附带 excerpt/occurredAt 的 Top 5 候选
    | 'access_revoked'      // 不泄露被撤内容，提示改用其他证据或告知用户
    | 'basis_stale'         // 附最新源 ref
    | 'version_conflict'    // 附最新 rev 与变更块列表
    | 'evidence_not_opened' // next 直接给好 open_learning 参数
    | 'budget_or_limit'     // 给降载建议
    | 'partial_success';    // 明确 succeeded[] 与 failed[]
  field?: string;
  message: string;          // ≤ 80 字
  candidates?: Array<{ ref: string; title: string; occurredAt?: string; excerpt?: string }>;
  next?: { tool: string; args: Record<string, unknown>; why: string };
};
```

---

## 4. 本域禁止糊弄清单与硬验收矩阵

### 禁止糊弄清单
- ❌ 禁止前哨不接真实便宜模型或用 `budgetCap === 0` 锁死后台只跑静态 3 步模板。
- ❌ 禁止保留六合一 `save_workspace` 或在写工具中继续返回无结构 `{ error: "..." }`。
- ❌ 禁止 `open_learning(lens="diagnose")` 继续返回硬编码 `unavailable`。
- ❌ 禁止 Python `mangekyo` SDK 继续用 `ordinaryPaper()` 拒绝带材料/题源/正式评估的试卷。
- ❌ 禁止在练习/考测态下把答案、评分规则或解答图泄露给工具回包或前端。

### 硬验收矩阵
1. **真·Always-Doing 离场自主教研**：放入获准旧讲义 + 两份对讲义结论有区分力的作答，清空待办、关闭全部页面 → 便宜模型前哨真实分诊 → 派发 `heavy_tutor_prep` 调阅两份作答并提出带原文依据的讲义修订（带 `undo_token`）→ 途中杀掉 Worker 由 Temporal 自动恢复 → 重开页面直接看到成果。
2. **前沿工具全链路效率验收**：（a）并发 1 轮读 3 份对象；（b）中文同义词混合检索 Top-3 命中且 `answer_exposed=false` 真实过滤；（c）`save_page` 局部 `patch` 插入 Python 生成的 `@calc_*` 图像句柄（输出 Token 降 ≥60%）；（d）考后跨 3 份含题源试卷的整卷复盘在 1 轮 Python 沙箱完成；（e）错参/版本冲突/未读原作 1 轮自愈率 ≥95%。
3. **20–30 条分诊 + 工具自愈回归集**：在真实便宜前哨模型与主模型上自动化运行并持续守门。
