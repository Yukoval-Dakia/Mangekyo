# 00｜Mangekyō 全范围总纲、架构铁律与反糊弄验收总则

- 版本：2026-11-20｜**Owner 拍板的全范围最高标准主规格**
- 套件索引：
  - `00-MASTER-BLUEPRINT-AND-ANTI-SLOP.md`（本文件：总纲、架构纠偏铁律、反糊弄红线、分波次交付门禁）
  - `01-CAPTURE-CONTENT-AND-IQDB.md`（全渠道交入、纸卷闭环、智能题库 IQDB、知识图谱、Notion-like 个人活教材）
  - `02-PERSONALIZED-EXTRACTION-AND-COGNITION.md`（全活动 Agent 个性化抽取、零正则红线、自研多维遗忘与认知引擎、对账与 Shadow 重放）
  - `03-TEACHING-CLASSROOM-ASSESSMENT-AND-PLANNING.md`（学习型课堂、Generative UI、练习试卷、同一评估契约、目标生命周期与动态「今天」）
  - `04-ALWAYS-DOING-COMPANION-AND-FRONTIER-TOOLS.md`（两层 Always-Doing 编排、唯一全能同伴、Memory Gateway、超越前沿的 10 窄工具与完整 Python SDK）
  - `05-SURFACES-PRIVACY-OPS-AND-ACCEPTANCE.md`（四处 Material 3 Expressive 表面、离线多设备、数据自主与永久删除、低打扰设置、危机转介、全量贯通验收总表）

---

## 1. 产品终极定义与最大范围边界

Mangekyō 是**一位学习者的私人教研团**：**接住学习者一切真实经历，由 Agent 从所有活动中持续抽取可被质疑的个性化理解，在学习者开口前主动把最合适的帮助备好，并用之后真实独立的表现检验自己帮得对不对。**

本套件将 [PRD.md](../PRD.md)（11 场景、13 承诺）、[product-spec.md](../product-spec.md)（D01–D10）、[feature-disposition.md](../feature-disposition.md)（F01–F73 中全部 70 项纳入 + F70 纳入部分）、[always-doing-and-agent-tools.md](../design/always-doing-and-agent-tools.md)、[frontier-agent-tools-spec.md](../design/frontier-agent-tools-spec.md) 与 [agent-personalized-extraction.md](../design/agent-personalized-extraction.md) **合拢为唯一无歧义的最高执行标准**。

**明确不做的只有 PRD §10 与 product-spec §3 列出的排除项**：多租户、家长/教师端、真人协作、第二个学习者对话 Agent、公开插件市场与第三方代码运行、身体/睡眠数据、原生客户端、完整离线推理、微服务与通用工作流编辑器、被动监听与群聊监控、未经本人决定自动联系第三方、无证据的数值提分或按分钟保证收益承诺。**除此之外的全部学习与智能能力均为必须交付的正式产品范围，禁止自行裁切为演示切片。**

---

## 2. 架构铁律：立刻止血 `runtime/studio` 单体塌陷，回归 PRD §5

截至 `origin/main@42f45e1`，仓库出现严重结构偏移：`runtime/studio/` 生产代码已膨胀至 **13,425 行**（超过 4 个模块总和的 2.3 倍），`modules/capture` 与 `modules/plan` 缺失，全仓仅 3 个 deriver、7 个 slot，30+ 条路由和大量重复授权/投影代码手写在 `runtime/studio/`，且 `scripts/check-structure.mjs` 漏检了 `runtime/`。

从本规格生效起，执行以下 **6 条架构铁律**：

1. **严格 6 模块归位（按事实所有权划分）**：
   - `modules/capture`：原件、多页交入、分层抽取定位、打印回传匹配、语音/链接原件；
   - `modules/content`：题目与灵活评估契约、智能题库语义标签与变式族、知识图谱与教材映射、学科语境、Notion-like 个人活教材块与版本化方法模板；
   - `modules/activity`：学习型课堂（编排/调整/归档）、练习试卷与冻结发放、提交与草稿、过程事实（有效用时/帮助曝光/信心）、自评/申诉/正式评估；
   - `modules/learner`：学习者声明与偏好、结构化错因（`misconception`）、实证有效教法（`playbook`）、多维掌握度与自研遗忘模型（接 Python 推导器）、预测/对账/校准与 Shadow 重放；
   - `modules/plan`：目标生命周期、学校进度/考试范围、时间约束与锁定项、动态「今天」编排与长假摸底规划；
   - `modules/companion`：唯一同伴会话、人格、长期记忆与断言复核（`claim` / `memoryAssertion` / `memoryReview`）、后台教研设置与工作单。
2. **`modules/*` 四构件边界与零基础设施泄漏**：模块只写事实类型、命令、槽位/推导器、块；严禁直接访问 DB、网络、provider SDK 或环境变量。
3. **停止 `runtime/studio` 膨胀并纳入结构门禁**：
   - 立即将 `runtime/` 纳入 `scripts/check-structure.mjs` 的行数上限（严控收缩至 ≤ 8,000 行，硬顶 15,000 行）与依赖方向检查；
   - 禁止继续往 `runtime/studio/` 添加新的领域判断、手写推导或业务路由；
   - 将当前各处重复手写的「`purpose` 过滤 + `accessEpoch` 核对 + `witness` 跟踪 + 出站前重验」抽成**内核/统一读层原语**，消灭每加一个工具写数百行重复防御代码的“隐性防御税”；
   - 推进命令与槽位声明到 HTTP 端点和 Agent 工具 schema 的自动派生。
4. **双引擎执行边界**：
   - **Temporal** 唯一负责耐久执行、重试、等待、信号唤醒、版本切换与恢复（`mangekyoCoordinator` + `mangekyoWork`）；
   - **独立隔离 Python 执行环境**分两套职责清晰运行：（a）受控推导器 Python Worker（单元 6，跑自研遗忘模型、信息量选题与统计计算）；（b）会话/评阅用隔离 Python 沙箱（无外网、挂载只读 `mangekyo` SDK、支持 SymPy/绘图与受控学生代码评估）。
5. **Agent SDK 对齐 ADR-0010**：逐步将手写双协议循环收敛到 Pi Agent Core + Pi AI（或单一干净可编辑 Agent Loop 抽象），统一支持只读并发、同 `ref` 写互斥、流式 SSE 进度与中断恢复。
6. **四级最小拍板自治 + ≤ 10% 测试与防御预算**：
   - Tier 1（纯后台计算/归因/抽取/库存备课）与 Tier 2（更新 AI 自建讲义、生成备选变式/短测、落库带来源的个性化偏好/错因/观察）**直接生效并返回 `undo_token`**，在前端轻提示可一键撤回；
   - 仅 Tier 3（修改学习者亲手编辑的粘性事实、改动锁定安排、修改正式目标承诺）与 Tier 4（永久删除、超预算外调、不可逆外部动作）需要用户显式确认；
   - 测试代码占比跨语言统一 ≤ 10%，靠下沉公共原语和精简高信号测试（不变量 + 真实端到端旅程）而非靠删功能压预算。

---

## 3. 《反糊弄红线总表（Anti-Slop Law）》

**以下 12 类行为一律判定为验收不通过（Fail），禁止合入主线或宣称完成：**

| # | 禁止的糊弄套路（Slop） | 必须做到的真实标准 |
|---|---|---|
| **S01** | **正则/前缀伪命令收取**（如 `^记住：`, `^纠正 <ULID>：`, `^学习范围：subject=...`） | 彻底删除此类正则；一切自然语言意图与个性化数据由 **Agent 从全部 6 类活动**中语义抽取，带 `evidence_refs` 与 `undo_token`。 |
| **S02** | **静态模板冒充智能教研**（如 `deterministicReview` 写死 3 句通用提示、`budgetCap !== 0` 一律拒跑） | 前哨接入真实便宜模型分诊，后台放开 `heavy_tutor_prep / deep_analyst / question_author / personalized_extractor`，产出针对具体错因与题面的真实材料。 |
| **S03** | **人工阉割适用面**（如 `ordinaryPaper()` 拒绝所有带材料/题源/正式评估的试卷） | 所有合法获准的对象（含材料卷、题库卷、正式评估卷、后测、跨卷）统一走统一授权读层，禁止用白名单窄条件绕开真实场景。 |
| **S04** | **返回 `unavailable` 占位却宣称功能完工**（如 `lens="diagnose"` 5 个字段硬编码 `unavailable`） | 规格要求的字段必须真连接上游真实数据；只有当学习者**确实没有该历史证据**时才允许返回诚实的 `unknown`（注明缺什么证据），不得因“没接线”长期返回 `unavailable`。 |
| **S05** | **用单题原题二值规则冒充自研遗忘/掌握度模型**（如 `same-item` + `lastIndependentResult`） | 建立知识点/子技能 × 表征 × 情境维度的连续掌握度与读时衰减保持率，区分原题/变式/新情境与受助/独立证据，输出概率与不确定性。 |
| **S06** | **只造读取/复验壳、不造上游生产者**（如 `memory-gateway` 声明了 `verified_playbooks / chronicle / learner_model` 却没人写入） | 每个消费端区域必须有可验证的真实上游生产链与端到端写入证据。 |
| **S07** | **只跑 API/CLI 单测、不接真实 4 表面 Web UI** | 任何用户可见能力必须接入「今天 / 同伴 / 材料 / 我 + 随处交入」真实 Web 界面，通过真实浏览器交互验收，不能藏在孤立测试或隐藏路由里。 |
| **S08** | **硬编码演示页冒充通用能力**（如写死 `/materials/riding`、`/classroom/first45` 或固定 JSON 抽取） | 骑行与内置包只能作为 `content` 数据存在，与用户自己交入的任意学科走**完全相同的通用代码路径**。 |
| **S09** | **合并巨型工具/全量覆写代替低摩擦窄工具**（如保留六合一 `save_workspace` 整页覆写） | 拆窄高频工具，支持 `block_id` / 锚点局部 `patch`、批量直读、结果句柄零复述传参、统一 `{ code, field, message, next }` 自愈报错。 |
| **S10** | **靠堆叠手写防御税绕过统一内核抽象** | 授权、用途、撤销、版本号和防剧透统一由内核读层与槽位契约执行，禁止每个接口复制粘贴一套 `witness` 校验。 |
| **S11** | **偷换「更正」「自评」「申诉」「撤回」「永久删除」语义** | 五者各自对应不同事实与生命周期：更正改事实并传播；自评独立保存不覆盖正式判分；申诉触发独立复核可维持原判；撤回留历史；永久删除不可逆且跨存储防复活。 |
| **S12** | **忽略失败出口与诚实“不知道”** | 无模型、网络断线、OCR 模糊、判分冲突、题库缺口、预算耗尽都必须有真实可见的状态与可执行下一步，绝不猜分、绝不静默降级、绝不无限转圈。 |

---

## 4. 全范围分波次实施路线（Wave 1 – Wave 5）

开发线须按依赖顺序推进，**每一波次必须以“真实隔离 PG + Temporal + Web 浏览器 + 真实模型（含便宜前哨与主模型）”贯通验收为准**，严禁跨波次留烂尾桩：

- **Wave 1（架构止血 + 清除 Slop + 核心数据管道打通）**
  - `runtime/` 纳入 `check-structure.mjs`；拆出 `modules/capture`、`modules/plan`；下沉统一授权/投影/复验读层；
  - 彻底删除正则收取 Slop（`explicitClaimRequest`、`explicit-memory.ts`、`memoryScopeFromMessage`）；
  - 落地**全活动 Agent 个性化抽取**双轨骨架（`save_memory` 即时写 + 活动后异步抽取 Agent 产出偏好/声明/错因/断言/教法）；
  - 拆窄 `save_workspace`（`save_page` 局部 `patch`、`save_question`、`save_relation`、`save_memory`）、统一全工具 `ToolError`、解除 Python SDK 的 `ordinaryPaper()` 限制。
- **Wave 2（核心教学闭环 + 多维认知与自研遗忘模型）**
  - 落地 `modules/capture` 多模态分层拍卷抽取（印刷题/手写/红笔/未知只问一次 + 独立双解验算 + 判分与错因归因）与清洁打印卷拍回闭环（D01）；
  - 落地 Python 推导器 Worker（单元 6）+ 知识点/表征/情境维度的**自研多维遗忘与掌握度模型**（连续概率、读时衰减、不确定性、信息量选题、Shadow 全历史重放与方法切换）；
  - 补实 `open_learning(lens="diagnose" | "remediate" | "grade")` 全部真实字段与 `search_learning` 向量语义混合召回 + 曝光覆盖过滤；
  - 补齐智能题库（IQDB）完整契约：语义找题、缺口补题与独立验算、通用灵活评估契约（含代码项目隔离执行、分步过程、画图约束、申诉与自评）。
- **Wave 3（真·Always-Doing + 学习型课堂 + Generative UI + 动态「今天」）**
  - 前哨接真实便宜模型 + 黄金分诊回归集；放开后台 `heavy_tutor_prep / deep_analyst / question_author`，支持关掉界面自主回看旧作修订讲义与备齐明天；
  - 完整学习型课堂（编排/动态调整/归档冻结 + 全部具名教学法 + 教同伴 + 共创方法模板）与通用版本化 Generative UI 块（含 Python 产物驱动与防剧透揭示）；
  - Notion-like 活教材完整闭环（块级编辑、双向关联、AI Diff 分项采纳、双端草稿冲突双份保留）；
  - 动态「今天」与目标生命周期（约束求解 + 锁定保护 + 跨日不断 + 长假摸底 + 空库无模型内置包）。
- **Wave 4（数据自主全生命周期 + 多设备离线 + 低打扰 + 危机与语音/链接）**
  - D06 / ADR-0008 全链路落地（四用途预设、24h 不留存临时加密销毁、全量导出、跨 PG/S3/索引/Temporal/离线设备的不可逆永久删除与防复活单调水位）；
  - 多设备视图缓存与离线待发队列（单元 18）；
  - 低打扰意图持久化拒绝、模型/实际 served/双预算透明面板（D07）；
  - 公开链接按需抓取、按需语音口述与朗读（D09）、危机支持与离线转介不变量（D10）。
- **Wave 5（全量贯通验收与部署定型）**
  - 跑通 `05` 中全部 11 个 PRD 场景 + 7 条跨模块端到端旅程 + F01–F73 逐项运行证据 + PRD §9 全部内核反证与变更局部性验证 + 私有单机一键可运行部署产物 + 清理全部历史冗余 worktree。
