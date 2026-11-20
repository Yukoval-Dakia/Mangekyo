# Mangekyō Agent 工具体系规格：全面对齐并超越产业前沿

- 日期：2026-11-20
- 定位：对 [agent-harness-and-tools.md](agent-harness-and-tools.md) §4 与 [always-doing-and-agent-tools.md](always-doing-and-agent-tools.md) §4 的**可实现级工具契约补全**，明确给出“全面对齐产业前沿”与“学习原生超越前沿”的接口设计、错误自愈规范、沙箱数据原语与验收标准。
- 红线约束：沿用既有内核的 `rev` / `accessEpoch` / `basis` 证据链；严守 **四级最小拍板自治（Tier 1–2 直落可撤回）**、**自研遗忘模型（非 FSRS）**、**防御工程总占比 ≤ 10%**（靠更聪明的原语降摩擦，而非靠繁复审批/状态机堆防御）。

---

## 1. 对标矩阵：哪些要“全面对齐”，哪些要“原生超越”

| 能力维度 | 产业前沿标杆（2025–2026） | Mangekyō 对齐项 | Mangekyō 学习原生超越项 |
|---|---|---|---|
| **工具规模与发现** | Anthropic Tool Search / Deferred Loading（核心 ≤10，长尾按需拉 schema） | 前哨 4+3 极简原语；主 Agent ~10 个窄核心工具 + `find_tools` 动态加载 | **场景自适应工具视图**：按 `mode`（伴学/考测/后台备课/前哨）自动裁剪可见工具与参数约束 |
| **并发与互斥** | Codex CLI `parallel.rs` / Claude Code（读并发、写互斥） | 解除 `parallel_tool_calls: false`，只读工具默认并发，同 `ref` 写自动串行 | **批处理原生读 + 复合镜头**：1 次调用取回跨表关联学习切片，把 5 轮串行压成 1 轮 |
| **检索与导航** | Notion / Linear MCP（混合检索 + `excerpt` + 时间/结构化过滤） | PG FTS/`pg_trgm` + 向量混合检索，必返 `excerpt / occurredAt / tags / unapplied_filters` | **认知态检索**：按 `answer_exposed=false`、掌握度区间、自研遗忘紧急度、知识图谱多跳先修联合筛选 |
| **内容局部编辑** | Codex `apply_patch` / Claude Code `Edit` / Notion block update | `save_page` / `save_question` 支持 `block_id` 或唯一文本锚点局部 `patch` | **Tier 1–2 直落 + `undo_token` 一键撤回 + 产物句柄插入**（模型不必复述长文/表格） |
| **批量数据分析** | Anthropic Programmatic Tool Calling / Codex Code Mode | 隔离 `python` 沙箱接入只读 `mangekyo` 客户端 | **学习原生分析原语**：沙箱内置 `attempts / forgetting / kg_prereqs / question_bank / sympy` 一次算完复盘与验算 |
| **多模态与上下文** | 原生 Image Block 返回 + 长会话自动摘要 | `open_learning` 按需返回原图裁剪块；裁剪覆盖全工具输出 | **不可变结果句柄 `@res_* / @calc_*`**：跨压缩不丢失，工具间直接按句柄传参零复述 |
| **错误与自愈** | 明确错误码 + 参数提示 | 统一 `{ code, field, message, next }`；拆清 `not_found / access_revoked / basis_stale` | **自动歧义消解 + 局部成功回执**：搜不到/重名直接附带 Top 候选与内联摘要，一轮自愈 |

---

## 2. 全面对齐前沿：主 Agent 核心工具清单（窄职责、低摩擦）

淘汰 `executors/teaching/workspace-tools.ts` 中六合一的 `save_workspace`，主 Agent 常驻仅暴露 **10 个高频窄工具**（长尾命令、学科插件、外部 MCP 全部经 `find_tools` 按需加载）：

### 2.1 读取与探索（默认并发安全 `concurrency: "parallel"`）
1. **`search_learning`**
   - 入参：`{ query?, kind?, filters?: { since?, until?, tags?, kc_ids?, answer_exposed?, mastery_lt?, retention_lt?, status? }, related?: { ref, depth?: 1|2|3 }, limit?: number, cursor? }`
   - 返回：`{ items: [{ ref, rev, kind, title, excerpt, occurredAt, tags, state, match_reason }], unapplied_filters?: string[], cursor? }`
   - 底层实现：PG `tsvector` + `pg_trgm` + 向量混合召回 + RRF 融合，取代 `position(lower(...))`。
2. **`open_learning`**
   - 入参：`{ refs: string | string[], part?: string | "image_crop" | "diff", lens?: "raw" | "diagnose" | "grade" | "remediate", cursor? }`
   - 特性：
     - 支持 **1–8 个 `refs` 批量直读**与 **`current_attempt` / `current_page` 语义别名**（宿主自动将本轮已展示且授权对象注册进 `opened`，免空跑一次读）。
     - 长文按**结构块/题号/公式完整边界**分页，禁止按 4000 字符硬劈 LaTeX 或表格。
     - `part: "image_crop"` 返回原生多模态图像内容块（手写答卷/几何原图区域），同时暴露 `effective_duration_ms`、`help_exposure[]`、`ocr_confidence`。
3. **`read_learner_radar`**（取代极简版 `read_workspace("learner")`）
   - 入参：`{ scope?: { subject_id?, kc_ids? }, horizon_hours?: number }`
   - 返回结构化决策全景：**Top-N 脆点（`Learner Model`）+ 自研遗忘模型 24–48h 滑坡预警队列 + 活跃错因「病」档案 + 已备未做库存清单 + 近 7 天用户撤回/负反馈 + 当前在途 `Todo` 看板**。
4. **`retrieve_memory`**
   - 透传至 Memory Gateway：`{ intent: "tutoring" | "planning" | "execution" | "history" | "reflection", scope, query?, budget_tokens? }`，返回带 `evidence` 指针与「省略区域展开索引」的 `ContextBundle`。
5. **`find_tools`**
   - 语义发现长尾领域命令、学科插件与外部 MCP 工具，按 `schemaRef` 注入下一轮上下文（平时 0 token 占用）。

### 2.2 写入与产出（同 `ref` 自动互斥串行 `concurrency: "exclusive_per_ref"`）
6. **`save_page`**
   - 新建：`{ title, content | blocks, tags?, links?, insert_artifacts?: HandleRef[] }`
   - 局部修改（**首选，禁用整页重写**）：`{ ref, expected_rev?, patch: [{ op: "replace_block" | "insert_after" | "replace_anchor" | "delete_block", target, content }] }`
   - 自治策略：Agent 自建或 Tier 1–2 讲义/方法卡直接生效并返回 `{ status: "saved", ref, rev, undo_token }`；修改学习者原创页返回可分项采纳的 `proposed` diff。
7. **`save_question`**
   - 窄字段结构：`{ ref?, stem, choices?, answer, rubric, kc_ids, difficulty?, interaction?, sources?, patch? }`
   - 自动对接智能题库自治门控：返回 `{ status: "draft" | "needs_verification" | "ready", ref, rev, missing?: [...], next? }`。
8. **`record_observation` / `save_memory` / `save_relation`**（三项独立极简 schema）
   - `record_observation`：写 `inferred` 学情观察（必须附已打开的 `evidence_refs`；**严禁直接写 `Learner Model` 掌握度或自研遗忘参数**）。
   - `save_memory`：用户明确“记住/纠正/忘掉”的即时 `Claim` 写入（带原话片段与 `supersedes`）。
   - `save_relation`：维护知识图谱有向边（先修/易混/迁移），支持多跳查询联动。
9. **`prepare_activity` / `request_assessment` / `correct_transcription`**（学习行动组）
   - 编排微课/短测/冻结试卷、发起独立重判、修正 OCR（自动触发下游派生失效重算）。
10. **`run_calculation` + `delegate_work` / `wait_for_work` / `emit_todo_hint`**（算力与协同组）
    - `run_calculation`：隔离 Python 沙箱（详见第 3.3 节）。
    - `emit_todo_hint`：主 Agent 将远期跟进线索直接回挂给轻量前哨的 `Working State` Todo 表，自己干净退场。

---

## 3. 五项「超越产业前沿」的学习原生设计

通用 Coding/Workspace Agent 不存在“防剧透、学情认知、考后批量归因、一键撤回自动教研”这些需求。Mangekyō 通过以下 5 项轻设计建立结构性优势：

### 3.1 复合学习镜头（Composite Learning Lenses）—— 1 轮顶 6 轮
`open_learning({ refs: "current_attempt", lens: "diagnose" })` 由服务端确定性查询一次性拼装跨对象黄金切片：
- **`diagnose` 镜头**：冻结题面 + 原图裁剪句柄 + 学生作答 + 有效用时与提示曝光 + 获准读回的正式评估摘要 + 该知识点最近 3 次历史作答摘要 + 当前掌握度与自研遗忘保持率。
- **`remediate` 镜头**：目标错因「病」档案 + 知识图谱 2 跳先修薄弱点 + 题库未暴露候选库存计数 + 近期被用户撤回/忽略过的策略反例。
- **`grade` 镜头**：冻结题面、作答与锁定评估引用。只有获准的正式评分执行器可读取评分契约。

> 效果：把原本需要 5–6 轮串行工具调用的“取证阶段”压成 **1 轮确定性读取**，延迟降 70%+，同时杜绝模型漏看提示曝光或历史错因。

### 3.2 认知与防剧透边界内置在工具层（Epistemic-Aware Tool Boundary）
- **考测防剧透**：处于练习/考试态时，`search_learning` / `open_learning` 在服务端硬过滤 `answer`、`rubric` 与关联解析，模型即使误传参数也拿不到答案，不会“顺嘴漏题”。
- **证据绑定免机械重复**：只要原件已在当前页面注入或 `open_learning` 打开过，写观察/批注时自动校验并绑定精确 `evidence_span`；未打开则直接给出带现成参数的 `next` 引导。
- **全量 Tier 1–2 写操作自带 `undo_token`**：每次后台自动备题、更新讲义或排期都返回可追溯 `undo_token` 并在前端露出轻提示，学习者一点撤回即回滚并写入负反馈信号给前哨与 `Experience Ledger`。

### 3.3 学习原生 Programmatic Tool Calling（Python 沙箱内置只读 `mangekyo` SDK）
在现有隔离 Docker/Python 沙箱（`executors/teaching/agent-tools.ts`）中注入极薄的只读代理模块 `mangekyo`（走宿主受控本地通道，复用同一 `maySend` / `accessEpoch` 鉴权，**零写权、零外网**）：

```python
import mangekyo as mk
# 1 次脚本完成：拉取近 14 天所有作答 + 自研遗忘曲线 + 2 跳先修图谱 + SymPy 验算
attempts = mk.attempts(since="14d", subject="math")
risks = mk.forgetting_risks(horizon_hours=48)
prereqs = mk.kg_prereqs("kc_ellipse_e", depth=2)
candidates = mk.questions(kc_ids=prereqs, answer_exposed=False, limit=30)
# 在 Python 内完成统计、筛选、绘图或 SymPy 独立求解，只 print 紧凑结论或存为 @calc_* 产物
```

> 效果：考后整卷复盘、30 道题库约束优化、数学题符号验算与函数配图全部 **1 轮沙箱搞定**，Token 降 80–90%，彻底消除 LLM 数数和算术幻觉。

### 3.4 不可变结果句柄 `@res_*` / `@calc_*`（跨压缩零复述传参）
- 超过阈值（如 >2 KiB）的工具输出、批量查询结果、Python 生成的图表/题目 JSON 自动获配短句柄（如 `@res_04`、`@calc_02`）存入当前会话临时产物区。
- **上下文折叠时**：旧工具载荷压缩为 `≤200 字结构化头 + @res_04 句柄`（覆盖 `open_learning / search_learning / python / exa_search` 全部工具），而非粗暴截断前 320 字符。
- **零复述传参**：模型可直接调用 `save_page({ ref, patch: [{ op: "insert_after", target: "blk_3", artifact: "@calc_02" }] })` 或 `run_calculation({ inputs: ["@res_04"], code: "..." })`，无需重新逐字生成上千 token 的数据或 SVG/Markdown。

### 3.5 一枪自愈的结构化错误协议 + 自动歧义消解
所有工具错误（含参数校验、权限、版本冲突、沙箱失败）统一返回严格结构，**绝不透出 SQL/堆栈，绝不把不同原因坍缩成一句 `unavailable`**：

```ts
type ToolError = {
  ok: false;
  code:
    | 'invalid_args'        // 缺字段/类型错/未知字段 -> 附 valid_fields
    | 'not_found'           // 真不存在 -> 附模糊匹配 candidates[]
    | 'ambiguous_ref'       // 标题重名 -> 附带 excerpt/occurredAt 的 Top 5 候选
    | 'access_revoked'      // 用户撤回授权（不泄露内容）-> 建议向用户说明或改用其他证据
    | 'basis_stale'         // 衍生记录所依赖原作已更新/撤回 -> 附最新源 ref
    | 'version_conflict'    // 并发更新冲突 -> 附最新 rev 与变更块列表
    | 'evidence_not_opened' // 写观察前未读原作 -> next 直接给好 open_learning 参数
    | 'budget_or_limit'     // 输出过长/超时/额度满 -> 给降载建议
    | 'partial_success';    // 批量读/写部分成功 -> 明确列出 succeeded[] 与 failed[]
  field?: string;
  message: string;          // ≤ 80 字，直接说人话
  candidates?: Array<{ ref: string; title: string; occurredAt?: string; excerpt?: string }>;
  next?: { tool: string; args: Record<string, unknown>; why: string };
};
```

示例对比（版本冲突）：
- 旧版：`{"error":"条目已更新。请用 read_workspace 打开当前版本，再传 id 和变动字段。"}`
- 新版：`{"ok":false,"code":"version_conflict","field":"expected_rev","message":"该页已更新至 rev=4（改动了 blk_2）。","next":{"tool":"open_learning","args":{"refs":"01J...","part":"blk_2"},"why":"确认 blk_2 最新内容后再提交 patch"}}`

---

## 4. 实施分期与验收标准（轻巧可控，不超 10% 防御预算）

| 阶段 | 落地内容 | 硬验收标准（可自动化回归） |
|---|---|---|
| **Phase 1（立刻见效）** | 只读并发 + 混合检索（含 `excerpt/occurredAt/tags`）+ `read_learner_radar` + 拆窄 `save_*` 与局部 `patch` + 统一 `ToolError`（拆清 `not_found / access_revoked / basis_stale`） | 1) 读 3 份作答并发 1 轮完成；2) 同义词中文查询 Top-3 命中；3) 局部改页输出 token 降 ≥60%；4) 错参/版本冲突/未读原作 1 轮自愈率 ≥95% |
| **Phase 2（超越前沿）** | 复合镜头（`diagnose / remediate / grade`）+ Python 沙箱只读 `mangekyo` SDK + `@res_*/@calc_*` 零复述句柄 + `open_learning` 多模态原图裁剪与 `current_attempt` 预注册 | 1) 考后 10 题整卷复盘 tool 轮数 ≤2 轮；2) 手写错 OCR 题经原图裁剪纠正识别；3) 压缩后通过 `@calc_*` 句柄无损插入讲义 |
| **Phase 3（持续进化）** | 20–30 条 **Tool Ergonomics & Self-Healing 回归集**（同时跑主模型与便宜前哨模型），追踪单任务工具轮数、误调率、1 枪自愈率、Token 成本 | 每次增删工具或改 Prompt 跑回归，保证“零新增冗余工具、自愈率不回退” |
