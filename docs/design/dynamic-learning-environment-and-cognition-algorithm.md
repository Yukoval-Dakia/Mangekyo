# Mangekyō 动态学习环境与底层算法体系升级方案

- **审计与设计基线**：`origin/main@597272e7`（纯只读审计，未改动本地工作区）
- **联合产出**：本构想会话 × GPT-6.2 Astra（`xhigh`）独立深挖与交叉质询定稿
- **架构边界**：严格遵守 `docs/PRD.md` §4/§5（三类数据、四类模块构件、6 模块归位、零学科硬编码、`gather → derive` 纯计算协议、Shadow PK 门禁、`runtime/` 行数与 ≤ 10% 测试预算红线）
- **实证声明**：以下方案为架构设计与数学规格，尚未在真实 PG / Python Worker 上运行测试或通过 Shadow PK 切换生产默认方法

> **关联索引**： [ADR-0011：动态学习环境与认知 v4](../adr/0011-dynamic-learning-environment-and-cognition-v4.md) · [四级自治与自研遗忘](autonomy-and-forgetting.md) · [Teaching-Craft 主动教学规范与评测契约](teaching-skills-and-prompts.md) · [Mangekyo 术语表](../../GLOSSARY.md)

---

## 一、产品与体验共识：从“四格伴学软件”迈向“细粒度动态学习环境”

在跳出纯功能堆叠、对照真实世界（国际象棋 Lichess 失误切片、音乐学院练习曲 Etude、高三活页错题本、认知科学专家反转效应 / KLI 框架 / Kurt VanLehn 内外环、Math Academy FIRe、Bret Victor 可探索实验台）后，本会话确立以下 **4 条不可动摇的产品共识**：

1. **拒绝粗粒度“4 大模式切换”，坚持“稳定安静大桌面 × 4 根细粒度连续旋钮”**
   - 同一晚上、同一科目、甚至同一道大题的不同步骤里，学习者的状态都是交织叠加的；切大模式不仅死板，还会破坏空间熟悉感。
   - 大桌面保持克制稳定，后台由算法实时驱动 4 根细粒度旋钮：
     - **旋钮 1｜知识形态呈现（KLI）**：按“这一小块知识本身是什么”动态混合呈现（易混辨析并排对照 / 动作步骤渐隐微练 / 原理直觉大白话讲义 + 纯演示活图解 / 开放建构草稿批注）。**讲解归讲解，活图解专心建直觉，正规题目独立衔接，不往活图解里硬塞伪题目。**
     - **旋钮 2｜单点/单步局部伸缩**：同一页个人教材或课堂内，已稳部分自动折叠为一行速查，卡过两次的误解展开详讲并钉上本人原话吐槽，未开课部分清晰留白不计掌握度。
     - **旋钮 3｜30 秒内环微响应**：针对当前卡住的那一步做轻点拨、高信心错答甩最小反例、顺畅步骤零打扰，同时保留“晚自习 30 秒极速点破通道”。
     - **旋钮 4｜微动作练习曲（Etude）与活页主体感**：在“整堂课 / 整道大题”之外，支持从真实错步切出 15–60 秒专项微练手（如“只判切入点不算完”）；学习者的土味批注是一等公民，薄弱活页随独立变式通过肉眼可见“由厚变薄”。
2. **同科不同知识点，绝不共享同一水平评估——连“评估尺子与遗忘规律”都不能共享**
   - 与题端已有的「灵活判分契约」上下对称：每个知识点不仅拥有独立的进度状态（`learned / current / not_started / excluded`）与个人目标水位（`school / exam / selective / olympiad`），还必须拥有**适配其知识形态的评估维度与遗忘动力学**（如物理学史主看隔天辨析防混、受力分析主看陌生场景防漏、解析几何主看限时计算抗错、政治大题主看多主体论证结构）。
3. **跨 3–4 知识点的综合大题必须有严谨归因，不能切细后“算不清账”**
   - 切细知识点后，靠暴力循环把一道综合题的错/对复制给全部知识点是灾难性的。必须由数学模型（步骤级分项映射优先 + 题级软合取贝叶斯责任分配 + 后验协方差保留）解决归因。
4. **“算法算真东西，Agent 做高价值表达”——绝不拿 Agent 替代底层算法**
   - 多知识点归因、图谱先验推断、幂律遗忘与个人参数拟合、联合信息量选题、预算优化、教法 Bandit 探索全部由纯确定性 Python 推导器计算；Agent 只读取确定性信号与真实题面组织教学，禁止 Agent 凭感觉估算掌握度、修改遗忘参数或自动晋升已验证教法。

---

## 二、现状算法全面深挖与 19 项真缺陷清单（`origin/main@597272e7`）

### P0｜直接破坏数据正确性、隐私边界与归因可信度的硬漏洞

| # | 位置（`origin/main@597272e7`） | 缺陷事实 | 后果 |
|---|---|---|---|
| **P0-1** | `modules/learner/question-selection.ts:581–610` ↔ `executors/python-deriver/cognition.py:149–167` | **Omission 键不一致**：`omissions[].ref.id` 写原事实 `fact.id`，而事件 `ref` 写合成键 `` `${fact.id}#${itemId}` ``；Python 仅精确比对 `(event.ref, event.rev)` | 撤回、缺独立见证或权限变更的条目无法屏蔽对应合成事件，可能泄露进 cognition 推导 |
| **P0-2** | `modules/learner/textbook-mastery.ts:217–243` | **多题提交按数组位置配对**：仅检查事件数量与 anchor 数量一致，靠 `multiIndex` 顺序配对而非 `item_id` 精确映射 | 输入排序微调即可把作答错误挂到其他题目与知识点 |
| **P0-3** | `executors/python-deriver/cognition.py:36–38,167–174`；`modules/learner/textbook-mastery.ts:229–280`；`retention.ts:264–305`；`knowledge-mastery.ts:245–261` | **多知识点暴力复制计账 + 丢弃分项契约**：`AssessmentCriterion`（`modules/content/assessment-values.ts:21–41`）已具备分项得分与输入地址，但未进入 `CanonicalEvidenceSliceV1`；综合题答错一次直接向全部 `concept_ids` 各写一次满权错误 | 4 知识点大题错 1 步连坐另外 3 个已稳节点；综合题越复杂证据量越虚高；forecast 重复投影伪造独立外观 |
| **P0-4** | `modules/learner/question-selection.ts:592–610`；`modules/content/question-evaluators.ts:121–131,236–256` | **`partial` 被压扁成 `incorrect` 且丢失新颖度**：评估器已产出 `proportion / earned`，下游却把 `partial` 硬转 `incorrect`，丢弃 `score_norm`，并把 `item_novelty` 写死为 `'same'` | 过程分与部分得分诊断信号完全浪费，迁移/变式证据退化为原题 |

### P1｜核心数学建模与算法空白

| # | 位置 | 缺陷事实 | 后果 |
|---|---|---|---|
| **P1-1** | `cognition.py:54–56,77,102–124` | **动态路径双重衰减 + 锚点错位 + 区间拼接错误**：循环内先对 `(a, b)` 做指数 `_decay`，末尾再算 `p = mastery * 2^(-retrieval_age / half_life)`；`(alpha_t, beta_t)` 锚定末次 scored 事件而 `retrieval_age` 锚定末次 independent 事件；Beta 区间围绕均值算出后又强行平移到 `p` | 概率、方差与时间原点数学不一致；纯指数衰减在长假后陡崖归零；无个人学习率 |
| **P1-2** | `cognition.py:14–18,67–124` | **非心理测量模型 + 受助污染独立后验**：`difficulty = 1 - mastery` 把学习者状态误写成题目难度；无题目辨别度 $a$、猜测率 $g$（选择题 0.25 地板）、失误率 $s$；只要存在 1 条独立记录，后续 `hinted/solution_seen` 仍按硬编码权重 `0.3/0.2` 混入同一 `(a, b)` 后验 | 刷简单题与解难题权重无差别；看过解答的熟悉度污染独立迁移能力估计 |
| **P1-3** | `cognition.py:36–38,178–213`；`graph-mastery.ts:50–93`；`prerequisite-radar.ts:50–98` | **零节点先验推断 + 维度稀疏爆炸 + 多维坍缩**：图谱边未入 Python 切片；`(concept, rep, ctx, method, novelty)` 桶完全孤立、无层级部分池化；`state_vector` 超过 1 维时整体 `uncertainty` 直接坍缩成 `unknown("multiple-dimensions")` | 新节点与稀疏轴永久冷启动盲区，上层无法消费多维不确定性 |
| **P1-4** | `modules/content/knowledge-edge.ts:13–35,147–190`；`knowledge-traversal.ts:61–80` | **图谱缺 DAG 无环约束 + 遍历提前截断**：边契约未强制先修图无环与权重范围；遍历遇单个邻居 `fits` 失败即 `return output(true)` 截断，遮蔽同层其他合法边 | 图谱推断可能死循环或静默遗漏合法先修路径 |
| **P1-5** | `executors/python-deriver/information_gain.py:258–274` | **Joint EIG 实为单桶熵减算术平均**：未计算联合隐变量互信息，也未区分“覆盖广”与“诊断可辨识” | 4 个未知 KC 的模糊大题反而排在可精确定位单瓶颈或二分前沿的好探针前面 |

### P2｜规划魔数、残余原型与门禁松动

| # | 位置 | 缺陷事实 |
|---|---|---|
| **P2-1** | `modules/learner/knowledge-mastery.ts:85–88,178–188`；`retention.ts:95–122` | TS 侧仍残留固定 7 天半衰期与 `0.60` 阈值原型 |
| **P2-2** | `modules/plan/graph-candidates.ts:69–82,149–178`；`today.ts:428–518`；`question-selection.ts`；`node-practice.ts:145–160` | **将 `unknown` 硬填成伪概率魔数**：`0.82/0.72` 信息量、`0.35/0.65` 保持率、`0.5` 默认信息、`info_gain * 3` 与一连串手写加分（`90/65/45/10/25/18/15`） |
| **P2-3** | `modules/learner/shadow-calibration-pk.ts:71–78,138–161`；`retention-replay.ts:60–102` | Shadow 重放未保证 recorded/shadow/baseline 在**严格同一预测样本集**上成对比较；`minCalibrationImprovement` 解析后未进入 `shadow_wins_ready` 门禁 |
| **P2-4** | `executors/python-deriver/intervention_lift.py:6–7,85–134`；`exam_pacing.py:215–236,301–319` | `intervention_lift` 仅算 8 次前后测差值均值（单学习者长期 `unknown`、无探索-利用、无基线难度校正）；`exam_pacing` 仅用 `5/9` 固定超时阈值做同卷描述性对比，无潜能力与相对难度估计 |

---

## 三、六大核心算法支柱（统一数学模型 × 单学习者可行 ML × 纯 Python Stdlib 确定性实现）

> **运行约束确认**：`executors/python-deriver/` 当前为 **100% 纯 Python 标准库**（无 `numpy`/`scipy` 重依赖，单请求载荷上限 `256 KB`、超时 `30s`）。以下全部算法均针对单学习者数据规模（活跃节点 $|V| \le 500$、事件 $N \in [10, 5000]$）设计为**纯 Python stdlib 确定性可重放实现**（稀疏/块对角 Laplace 近似 + 有界阻尼牛顿 / L-BFGS + 高斯-埃尔米特求积 + 固定排序与零随机性或显式确定性种子），单次推导控制在 **5–30 ms**。

### 支柱 1｜Criterion 优先 × 贝叶斯多知识点综合题归因（Multi-KC Credit Assignment）

1. **观测层与分项优先**：
   - 每个 `AssessmentCriterion` $j$ 为最小归因单元，携带 `criterion_id`、`input_refs[]`、`earned`、`maximum`、`outcome`、`kc_links[{kc_id, weight, role, source}]`（$\sum_c w_{jc} = 1$）与 `interaction: 'conjunctive' | 'compensatory'`。
   - `maximum = null` 或主观不可客观计分项，**不进入数值似然**，忠实输出质性状态或 `unknown`。
2. **统一联合似然（Soft-AND 合取 / 补偿 + $g/s$ 分离）**：
   - 单 KC 有效成功概率见支柱 3 的统一耦合式 $q_{jc}(t) = \sigma\!\left(a_{jc}(\theta_c^{\text{eff}}(t) - b_{jc})\right)$；
   - **合取型（默认，适用于物理/数学/代码多步推理）**：软合取加权几何平均
     $$q_j(t) = \exp\!\left(\sum_{c \in \mathcal{C}(j)} w_{jc} \ln \max(q_{jc}(t), \varepsilon)\right)$$
   - **补偿型（适用于多路径/综合表述）**：$q_j(t) = \sigma\!\left(\sum_{c} w_{jc} a_{jc}(\theta_c^{\text{eff}}(t) - b_{jc})\right)$；
   - **猜测率 $g_j$（如四选一 $g \approx 0.25$，作答题 $g \approx 0.02$）与失误率 $s_j$**：
     $$p_j(t) = g_j + (1 - g_j - s_j)\, q_j(t), \quad g_j, s_j \in [0, 0.4],\; g_j + s_j \le 0.8$$
   - 全分/零分用 Bernoulli 似然；部分得分 $y_j = \text{earned}_j / \text{maximum}_j \in (0, 1)$ 用准二项（Quasi-Binomial）对数似然 $\phi_j [y_j \ln p_j + (1 - y_j)\ln(1 - p_j)]$，彻底消除 `partial → incorrect` 的信息损失。
3. **直觉与数学完美一致的责任分配（解决“跨 3–4 知识点怎么算账”）**：
   - 相对责任权重按对数似然梯度敏感度计算：
     $$r_{jc} = \frac{w_{jc} \left|\partial \ln P(y_j \mid \boldsymbol{\theta}, t) / \partial \theta_c\right|}{\sum_k w_{jk} \left|\partial \ln P(y_j \mid \boldsymbol{\theta}, t) / \partial \theta_k\right|}$$
   - **关键性质**：在 Soft-AND 下，一道 4-KC 大题 `[C1, C2, C3, C4]` 若 `C1, C2, C4` 已稳（$q \approx 0.95$）而 `C3` 仅 $0.40$，答错时梯度天然正比于 $(1 - q_{jc})$，**`C3` 自动承担约 12 倍于其余三点的错误责任**，已稳节点绝不被连坐；若 4 点全是 `unknown`，则后验在 $\Sigma_{\boldsymbol{\theta}}$ 中留下非对角负协方差（标明“四点中至少有一处断点但尚未定位”），不强行判任一点 `fragile`，并立即交给支柱 5 安排精准隔离探针。
   - **回退铁律**：无 `criterion → KC` 映射时，单 KC 题走 `single_kc_fallback`；多 KC 题仅更新联合状态，各 KC 软归因仅写入 `prior_belief` / `joint_diagnostics`，**严禁把一条题级观测复制成多条 `observed` 独立证据**。
4. **严格区分「正向先修先验」与「反向隐式复习（FIRe）」**：
   - **正向（$p \to c$）**：见支柱 2，先修节点掌握度影响后继节点的冷启动先验与 KST 前沿；
   - **反向 FIRe（$c \to p$）**：当学习者**独立做对**高阶综合节点 $c$ 时，沿已核证有向先修边 $A_{pc}$ 向先修节点 $p$ 回传有上限的**隐式稳定性续期学分**（$\Delta S_p^{\text{fire}} \le \gamma_{\text{fire}} A_{pc} \Delta S_c$），用于压缩多余的基础复习队列；该信用严格标记为 `implicit_fire`，**绝不将从未直接作答过的 $p$ 伪造为 `observed` 独立掌握**。

### 支柱 2｜图谱 DAG 层级先验推断 + KST 前沿 + 三态契约（严守 PRD §3 #4 与 F37）

1. **有向无环图校验与层级先验**：
   - `knowledge-edge` 先修子图在进入推导前做严格拓扑无环校验（出现环、冲突反向边时局部回退为 `unknown` 并记录结构告警，绝不静默发散），单节点入边权重和 $\le 1$，传播深度有界，未核证边降权仅作弱先验依据。
   - 节点潜能力层级先验（结合 KLI 形态组均值 + 先修传播）：
     $$\eta_c \sim \mathcal{N}\!\left(\mu_{\text{KLI}(c)} + \rho \sum_{p \in \text{Pa}(c)} A_{pc}\,\eta_p,\; \tau_{\text{KLI}(c)}^2\right)$$
   - **跨轴部分池化（根治维度稀疏爆炸）**：同一 KC 下的细粒度轴 `(representation, context, method, novelty)` 不再孤立从 `Beta(1,1)` 起步，而是作为 KC 主能力 $\theta_c$ 周围的正则化随机效应偏移 $\delta_{c, \text{axis}} \sim \mathcal{N}(0, \tau_{\text{axis}}^2)$（仅在有直接观测时偏离中心，无观测轴保留明确 `prior_belief` 与宽区间）。
2. **强制三态分离契约（绝不混淆“见过真证据”和“图谱推测”）**：
   - `observed`：存在获准且有效的直接 criterion 或明确单 KC 独立作答证据，给出后验均值、一致可信区间与完整 `evidence_refs`；
   - `prior_belief`：尚无直接独立证据，仅基于图谱先修、跨轴层级或 FIRe 推导，给出先验概率、宽区间、`basis_refs` 与 `prior_reason: 'graph' | 'hierarchy' | 'fire'`；**任何时候不得覆盖或伪装成 `observed`，V1 兼容视图不得将 `prior_belief` 映射为 `known`**；
   - `unknown`：证据覆盖不完整、权限撤回、映射缺失、图环或不可辨识，给出结构化 `reason` 与 `needed`。
3. **KST 知识前沿（有界 Beam Search）**：
   - 仅保留满足先修闭包（$c \in Z \Rightarrow \text{Pa}(c) \subseteq Z$）的候选知识状态集合，用固定最大宽度 Beam Search 维持多项式复杂度（超限显式标 `truncated`），定位“先修大概率已备、当前最值得探索/学习”的最小前沿集合。
4. **F37 零漂移硬保证**：
   - 题库新增未答题既不进入观测集，也不改变图谱边集与个人参数拟合集，因此已有 `observed` 节点后验漂移严格为 `0`。

### 支柱 3｜异构 KLI 评估剖面 × 统一无双重衰减的自研幂律遗忘与单学习者 ML

1. **四大 KLI 异构知识形态（每个知识点独立绑定）**：
   - `memory_discrimination`（记忆与易混辨析）：快遗忘指数 $\gamma$ 偏高、易混干扰项 $I_c$ 权重高、核心评估指标为隔天无混淆提取；
   - `procedural_fluency`（程序与执行熟练）：中等衰减、叠加步骤耗时/失误率稳定度评估；
   - `principle_intuition`（概念与原理直觉）：巩固后衰减极慢（低 $\gamma$）、核心评估指标为跨表征/陌生情境迁移；
   - `open_construction`（开放论证与建构）：按 rubric 分维度保留能力剖面，无法客观量化项严格保持 `unknown`。
2. **能力与幂律遗忘的单源统一耦合（彻底根治 `cognition@3` 双重衰减与区间错位！）**：
   - **结构能力 $\theta_c$**（长期能力表征，不因放假三周清零）与**读时幂律保持度 $R_c(t)$** 分离存储、在同一对数几率尺度上无损耦合（干扰项通过等效稳定度 $S_c^{\text{eff}}(t) = S_c \exp(-\lambda_I I_c(t))$ 调制，并以邻居基础保持率 $R_k^{\text{base}}(t)$ 计算，既满足零间隔归一化又避免双向易混边递归）：
     $$R_c^{\text{base}}(t) = \left(1 + \frac{\Delta t_c}{S_c \cdot \kappa_{\text{KLI}(c)}}\right)^{-\gamma_{\text{KLI}(c)}}, \quad I_c(t) = \sum_{k \in \text{Conf}(c)} \kappa_{ck}\!\left(1 - R_k^{\text{base}}(t)\right)$$
     $$R_c(t) = \left(1 + \frac{\Delta t_c \cdot \exp(\lambda_I I_c(t))}{S_c \cdot \kappa_{\text{KLI}(c)}}\right)^{-\gamma_{\text{KLI}(c)}}, \quad \theta_c^{\text{eff}}(t) = \theta_c + \psi_{\text{KLI}(c)} \ln R_c(t)$$
   - **数学优美性**：
     - $\Delta t_c = 0$ 时无论易混邻居状态如何，分子均为 $0$，恒有 $R_c(0) = 1 \implies \ln R_c(0) = 0 \implies \theta_c^{\text{eff}}(0) = \theta_c$（精确退化为纯 IRT/MIRT）；$I_c(t) = 0$ 时退化为无干扰基础幂律 $R_c^{\text{base}}(t)$；
     - 随时间流逝 $\ln R_c(t) < 0$，**简单题（$b \ll \theta$）比难题（$b \approx \theta$）保持可解更久**，且预测概率自然收敛到猜测下界 $g_j$ 而非畸变跌破 $g_j$；
     - 间隔复习效应（Desirable Difficulty）：仅当**独立提取成功**时更新稳定性 $S_c \leftarrow S_c \cdot \left(1 + \alpha_{\text{space}}(1 - R_c(t_{\text{prev}})) \cdot w_{\text{novelty}}\right)$（临近遗忘时成功提取增益远大于当天死刷），失败时适度回落但不抹除结构能力 $\theta_c$，天然表达“长假回归后的再学习节省”；
     - **独立证据 vs 受助证据严格分轨**：`hinted / solution_seen` 绝不混入独立能力 $\theta_c$ 的正增益或陌生迁移后验，仅作为独立辅助轨迹记录（用于评估脚手架依赖与微响应）。
     - 统一后验 $(\hat{\boldsymbol{\theta}}, \Sigma_{\boldsymbol{\theta}})$ 经 Laplace + 数值求积直接产出**唯一一致的预测区间**，彻底消灭拼接平移。
3. **单学习者样本分档的 ML 拟合策略（防小样本过拟合）**：
   - 采用分层正则化 Empirical Bayes MAP（纯 Python L-BFGS / 阻尼牛顿，固定初始化与确定性收敛条件），严格按有效独立样本量 $N$ 逐级放开自由度：
     - **$N < 30$（冷启动）**：锁定 KLI 群体先验与题目默认参数，只推算后验状态，**零个人自由参数拟合**；
     - **$30 \le N < 500$（成长期）**：强 $L_2$ 正则化向群体先验收缩，仅拟合个人全局/KLI 级衰减尺度 $\kappa$、间隔增益 $\alpha_{\text{space}}$ 与个人失误偏移，按时间前向切分防泄漏；
     - **$N \ge 500$（长期伴学）**：放开高频 KC 级稳定度偏移、题目相对难度微调与局部协方差估计；每次拟合输出 `fit_status / effective_evidence / parameter_bounds / regularization_strength` 可审计追溯。

### 支柱 4｜动态相对难度与外部课程进度正交建模

- 题目参数 $(a_i, b_i, g_i, s_i)$ 独立于学习者状态（样本不足时用题库/赛道先验，绝不把单个学习者偶然失误写成题库难度）；对当前学习者而言的**动态相对难度**由 $b_i - \theta_c^{\text{eff}}(t)$ 与赛道目标水位共同实时投影（热身 / 甜点挑战 / 压轴突破 / 超纲）。
- 外部真实生活坐标作为 `modules/plan` 事实（由拍卷、同步笔记、对话自动推断并允许本人粘性修正），与能力后验完全正交：
  - `study_stage ∈ {learned, current, not_started, excluded}`
  - `target_level ∈ {school, exam, selective, olympiad}`
  - `mastery_state ∈ {observed, prior_belief, unknown}`

### 支柱 5｜诊断可辨识的联合信息量选题（Joint EIG + Fisher）与预算约束编排

- 在联合隐变量 $Z = \{\boldsymbol{\theta}, \text{misconception}_h, \text{frontier}\}$ 上基于 Laplace 高斯后验计算候选集 $S$ 的联合期望信息增益：
  $$\text{EIG}(S) = H(P(Z \mid D)) - \mathbb{E}_{y_S}\!\left[H(P(Z \mid D, y_S))\right]$$
- 叠加 Fisher 信息可辨识度 $D(S) = \ln \det(F_S + \lambda I)$ 与误解假设区分度（优先挑能把两个竞争误解 $H_1, H_2$ 劈开的最小反例题）；**对覆盖 4 个未知 KC 但无法归因的模糊综合题，覆盖虽高但诊断价值自动被压低**。
- 在锁定项、可用时长预算、考试范围权重与精力带宽硬约束下，采用条件边际增益 $\Delta(q \mid S)$ + 有界 Lazy Greedy / Beam Search 做动态组卷与今日编排，彻底删除 `graph-candidates.ts` / `today.ts` / `node-practice.ts` / `question-selection.ts` 中的所有硬编码魔数（`0.82/0.72/0.35/0.65/0.5/info_gain*3`）。

### 支柱 6｜单学习者样本高效的教法研究 ML（分层 Contextual Bandit + 严格确认门禁）

- 用分层部分池化（`beta_global` → `beta_KLI` → `beta_concept`）的 **Contextual Thompson Sampling** 替代“只能傻等 8 组×14 天才能动”的僵局；
- 上下文特征：`KLI 形态 + 前沿位置 + error_stage + 新颖度 + 当前带宽 + 近期受助记录`；动作臂（Arm）为现有教学策略/脚手架组合（不新增领域实体）；
- **防幻觉奖励与双门禁**：奖励严格取自后续独立变式/迁移后测（扣除耗时与污染惩罚），受助正确或即时爽感绝不产生正奖励；Bandit 仅负责安全边界内的探索选择与事前冻结预测，**正式晋升 `verified playbook` 仍由升级后的 `intervention-lift@1` 严格确认门禁把关**。

---

## 四、算法信号 → 细粒度动态学习环境的精确映射

| 动态环境旋钮 | 消费的确定性算法信号 | 确定性行为映射 | Agent 职责边界 |
|---|---|---|---|
| **1. 知识形态呈现** | `kli_profile`、`error_stage`、原题 vs 迁移落差、置信区间 | 辨析类出对照卡；程序类出渐隐与短链；原理类出扎实白话讲义 + 纯演示活图解 + 衔接正规题；开放类出草稿结构台 | 只做白话讲解、造活图解与举例，**不自算掌握度** |
| **2. 局部折叠 / 展开** | `KST frontier`、单点三态 (`observed / prior_belief / unknown`)、先修后验、误解分离度 | 稳定且高保持节点折叠为一行速查；活跃误解与低保持节点展开并挂载本人历史吐槽/错题；未开课节点轻标不施压 | 只润色展示，**绝不拿邻居先验冒充本人已掌握** |
| **3. 30 秒内环微响应** | `criterion responsibility`、`error_stage`、作答信心、连续同错、是否选快通道 | 顺畅步静默；卡步只点破停住的 criterion；高信心错答直出最小反例；快通道 30 秒点破即放行 | 执行已裁决的响应策略，**不改写掌握度或遗忘参数** |
| **4. 微动作练习曲 & 活页薄本** | `joint_eig`、`identifiability`、`crossing_at`、单步薄弱 criterion、`bandit_posterior`、外部进度与预算 | 从错步切出 15–60 秒专项微练手（如只判切入点）；独立变式通过后对应项自动从活页薄本抽走归档 | 在已批准候选里组织题面与节奏，**不绕过预算和锁** |

---

## 五、Mangekyō 零膨胀落地契约（内核 / 模块 / Python Worker）

### 5.1 完整 `CanonicalEvidenceSliceV2`（向后兼容 V1，补齐图谱与学习坐标）

```ts
type EvidenceInputRefV2 = { readonly slot_id: string; readonly path: string };

type CriterionKcLinkV2 = {
  readonly kc_id: string;
  readonly weight: number; // sum == 1 within a criterion
  readonly role: 'target' | 'prerequisite';
  readonly source: 'authored' | 'verified_edge' | 'question_fallback';
};

type CriterionObservationV2 = {
  readonly criterion_id: string;
  readonly input_refs: readonly EvidenceInputRefV2[];
  readonly earned: number | null;
  readonly maximum: number | null;
  readonly outcome: 'correct' | 'incorrect' | 'partial' | 'unknown';
  readonly score_norm?: number;
  readonly interaction?: 'conjunctive' | 'compensatory';
  readonly kc_links: readonly CriterionKcLinkV2[];
  readonly evaluator: { readonly id: string; readonly version: string };
  readonly error_stage?: 'reading' | 'modeling' | 'strategy' | 'execution' | 'expression';
};

type DiagnosticItemModelV2 = {
  readonly discrimination: number; // [0.25, 4.0]
  readonly difficulty: number;     // [-6, 6]
  readonly guess: number;          // [0, 0.4]
  readonly slip: number;           // [0, 0.4], guess + slip <= 0.8
  readonly source: 'calibrated' | 'population_prior';
};

type EvidenceEventV2 = EvidenceEventV1 & {
  readonly fact_ref: { readonly id: string; readonly rev: number }; // canonical source fact id (fixes P0-1!)
  readonly item_id?: string;                                        // explicit 1:1 pairing key (fixes P0-2!)
  readonly criteria?: readonly CriterionObservationV2[];
  readonly attribution_status: 'criterion' | 'single_kc_fallback' | 'question_fallback' | 'unknown';
  readonly item_model?: DiagnosticItemModelV2;
};

type ConceptGraphNodeV2 = {
  readonly kc_id: string;
  readonly kli_profile: 'memory_discrimination' | 'procedural_fluency' | 'principle_intuition' | 'open_construction';
  readonly study_stage?: 'learned' | 'current' | 'not_started' | 'excluded';
  readonly target_level?: 'school' | 'exam' | 'selective' | 'olympiad';
};

type ConceptGraphEdgeV2 = {
  readonly from_kc_id: string;
  readonly to_kc_id: string;
  readonly kind: 'prereq_of' | 'confuses_with' | 'subskill_of';
  readonly weight: number;
  readonly verified: boolean;
  readonly ref: { readonly id: string; readonly rev: number };
};

type CanonicalEvidenceSliceV2 = {
  readonly schema_version: 'v2';
  readonly clock_watermark: string;
  readonly as_of_at: string;
  readonly authorization: {
    readonly purpose: readonly string[];
    readonly recipient_id: string;
    readonly inputs: readonly {
      readonly ref: { readonly id: string; readonly rev: number };
      readonly access_epoch: string;
      readonly mode: 'pinned' | 'following' | 'asof';
      readonly sticky: boolean;
    }[];
  };
  readonly concept_graph?: {
    readonly nodes: readonly ConceptGraphNodeV2[];
    readonly edges: readonly ConceptGraphEdgeV2[];
  };
  readonly events: readonly EvidenceEventV2[];
  readonly omissions?: readonly {
    readonly ref: { readonly id: string; readonly rev: number };
    readonly item_id?: string;
    readonly reason: string;
  }[];
  readonly constraints: CanonicalEvidenceSliceV1['constraints'];
  readonly candidate_pool: readonly EvidenceCandidateV2[];
};
```

### 5.2 三态输出契约与 Python Worker 版本化路由

```ts
type MasteryBeliefV2Common = {
  readonly kc_id: string;
  readonly kli_profile: ConceptGraphNodeV2['kli_profile'];
  readonly joint_diagnostics?: readonly {
    readonly kc_ids: readonly string[];
    readonly status: 'localized' | 'unlocalized' | 'truncated';
    readonly covariance_ref?: string;
  }[];
  readonly frontier?: readonly { readonly kc_id: string; readonly score: number }[];
  readonly parameter_fit?: {
    readonly fit_status: 'prior_locked' | 'regularized_map' | 'individualized_map' | 'unknown';
    readonly effective_evidence: number;
    readonly parameter_bounds: Record<string, readonly [number, number]>;
    readonly regularization_strength: number;
  };
  readonly env_policy?: {
    readonly knowledge_form: string;
    readonly local_scale: 'collapsed' | 'expanded' | 'blank';
    readonly micro_response: 'silent' | 'hint' | 'counterexample' | 'fast_lane';
    readonly etude?: { readonly criterion_id: string; readonly seconds: number };
  };
};

type MasteryBeliefV2 =
  | (MasteryBeliefV2Common & {
      readonly state: 'observed';
      readonly probability: number;
      readonly interval: readonly [number, number];
      readonly stability_days: number;
      readonly r_now: number;
      readonly evidence_refs: readonly { readonly id: string; readonly rev: number }[];
      readonly attribution: readonly { readonly criterion_id: string; readonly responsibility: number }[];
    })
  | (MasteryBeliefV2Common & {
      readonly state: 'prior_belief';
      readonly probability: number;
      readonly interval: readonly [number, number];
      readonly basis_refs: readonly { readonly id: string; readonly rev: number }[];
      readonly prior_reason: 'graph' | 'hierarchy' | 'fire';
    })
  | (MasteryBeliefV2Common & {
      readonly state: 'unknown';
      readonly reason: string;
      readonly needed: readonly string[];
    });
```

- **三态 `MasteryBeliefV2`**：严格区分 `observed`（含 `probability / interval / stability_days / r_now / evidence_refs / attribution[{criterion_id, responsibility}]`）、`prior_belief`（含 `probability / interval / basis_refs / prior_reason: 'graph' | 'hierarchy' | 'fire'`）与 `unknown`（含 `reason / needed`），同时附带 `joint_diagnostics`、`frontier`、`parameter_fit` 与 `env_policy`（4 旋钮确定性输出）。
- **新增版本化 Worker 路由（纯 Python stdlib，保留旧版兼容与 baseline 对照）**：
  - `learner/cognition@4` → 统一归因 + 图谱层级先验 + 异构 KLI 幂律遗忘 + 单学习者 MAP
  - `plan/information-gain@2` → Multi-KC Joint EIG + Fisher 可辨识度 + KST 前沿 + 预算优化
  - `learner/intervention-policy@1` → 分层 Contextual Thompson Sampling（与 `intervention-lift@1` 严格确认门禁解耦）
- **零膨胀模块归属（严格保护 `runtime/` 11,604L 上限与 ≤ 10% 测试预算）**：
  - `kernel`：仅公开 V2 纯类型与 manifest 见证，不加表；
  - `content`：在 assessment release / 知识边增加 `criterion → KC` 映射、节点 KLI 形态与先修边 DAG 无环校验，修复 `knowledge-traversal.ts` 提前截断；
  - `activity`：保留 `criterion` 实得分、`item_id` 与帮助曝光；
  - `learner`：接入 V2 切片构建、修复 `omission` 键不一致与多 item 顺序配对、接入 `cognition@4` 三态投影、修复 `shadow-calibration-pk.ts` 同样本成对比较与 ECE 改善门禁；
  - `plan`：接入 `information-gain@2` 与 `study_stage / target_level` 约束，清零本地伪概率魔数；
  - `runtime/`：**不新增任何领域逻辑与手写算法**，仅做超薄契约透传。

---

## 六、给开发主线的分波次实施路线（Wave A–D）与硬验收反证清单

### Wave A｜证据与归因契约止血（P0 清零，生产仍保 `cognition@3`）
- **范围**：落地 `CanonicalEvidenceSliceV2`（含 `fact_ref / item_id / criteria / concept_graph`）；修完 P0-1（omission 键统一）、P0-2（多 item 按 `item_id` 精确配对）、P0-3（停止多 KC 复制计账）、P0-4（保留 `partial` / `score_norm` / 真实 `item_novelty`）；补 `knowledge-edge` DAG 无环校验与 `knowledge-traversal` 截断修复；修复 `shadow-calibration-pk.ts` 同样本成对比较与 ECE 改善门禁。
- **不做**：不切换生产默认 `cognition@3`，不改今日默认排序，不引入 Bandit。
- **硬验收与反证**：① 4-KC 综合题仅 1 个 criterion 指向目标 KC 时不再向其余 3 点复制错误；② `partial` 不再被压成 `incorrect`；③ 撤回/omission/epoch 变更 100% 屏蔽对应合成 item 事件；④ 乱序多 item 提交产出逐字节一致结果；⑤ V1/V2 适配器 F37 漂移严格为 `0`。

### Wave B｜`cognition@4` 统一归因、图谱先验与多形态幂律遗忘引擎 + Shadow PK
- **范围**：在 `executors/python-deriver/` 用纯 Python stdlib 实现 `learner/cognition@4`（Soft-AND/补偿 + $g/s$ 分离 + 梯度责任归因 + 正向 DAG 层级先验 + 反向有界 FIRe + 跨轴部分池化 + KST Beam Frontier + KLI 异构幂律无双重衰减 + 分档 Empirical Bayes MAP + 三态输出）；接入 Shadow Replay 与合成对抗基准集（覆盖全部 14 项黄金场景）。
- **不做**：未在同样本事前预测上显著战胜 `cognition@3`（Brier、LogLoss、ECE 达标、Coverage 达标、F37 零漂移、受助零污染）前，**禁止切换生产默认方法**。
- **硬验收与反证**：① 4-KC 综合题中 3 稳 1 弱答错，责任显著集中在弱点且不把 3 稳点判为 `fragile`；② 高先修先验但无直接独立作答严格输出 `prior_belief`（V1 兼容视图绝不翻成 `known`）；③ $N=10$ 锁定先验不拟合个人参数，$N=200$ 正则化 MAP 稳定收敛，$N=5000$ 个人参数拟合可重放；④ 新增未答题 F37 漂移 = `0`；⑤ 受助正确不提升陌生迁移独立后验。

### Wave C｜`plan/information-gain@2` 联合可辨识选题 + 清除规划魔数 + 4 旋钮策略接线
- **范围**：实现 `plan/information-gain@2`（Joint EIG + Fisher 可辨识度 + 误解假设区分度 + KST 前沿二分 + 预算约束边际增益组卷）；彻底清零 `graph-candidates.ts` / `today.ts` / `node-practice.ts` / `question-selection.ts` 的硬编码伪概率与 TS 7 天残余原型；将 4 根细粒度环境旋钮的确定性 policy 输出接入课堂、活教材折叠、内环微响应与微动作练习曲切片。
- **不做**：不让 Agent 自行计算概率或覆盖锁定项，不把学校未开课进度误算为薄弱。
- **硬验收与反证**：① 4-未知-KC 模糊题的诊断排序严格低于可辨识隔离探针或误解区分探针；② `unknown` 候选绝不被静默填成 `0.82/0.72/0.5`；③ 固定输入重放 4 旋钮策略输出逐字节一致；④ 结合外部 `study_stage / target_level`（如学考 vs 选考、未开课）自动过滤超纲与伪焦虑。

### Wave D｜单学习者样本高效教法研究（Contextual Bandit）× 相对难度 `exam-pacing` × 活页/练习曲闭环
- **范围**：实现 `learner/intervention-policy@1`（分层 Contextual Thompson Sampling，奖励仅锚定独立变式/迁移后测，保留 `intervention-lift@1` 为 `verified playbook` 严格确认门禁）；升级 `exam-pacing` 接入潜能力与相对难度校准；打通前端“本人土味批注一等置顶 + 活页由厚变薄 + 15–60 秒微动作练习曲 + 30 秒快通道”。
- **不做**：不把即时正确或受助正确算作正 Lift，不自动晋升 `verified playbook`。
- **硬验收与反证**：① $N=10$ 仅走安全全局先验；② 受助污染样本在 Bandit 与 Lift 中的假阳性率为 `0`；③ 缺独立迁移后测时持续保持 `unknown`。


---

## 七、Colab + GPU 离线教研、群体先验校准与深度 KT/FSRS 标杆对照轨（Track GPU-Lab）

Track GPU-Lab 是离线教研轨，服务于群体先验校准、方法对照和超参数研究。它不改变线上推导器的执行边界，也不把公开数据集中的群体规律直接写成某位学习者的个人观测。

### 7.1 群体先验离线校准

使用 Google Colab GPU 与 PyTorch 建立可复现的离线校准 notebook。每次运行固定环境镜像、随机种子、数据清洗版本、时间切分规则和导出工具版本，并把它们写入运行摘要。公开数据集按可用许可和字段质量纳入清单，首批覆盖 FSRS/Anki 记忆日志、EdNet、ASSISTments 与 Algebra 交互序列。每个数据集分别保留原始数据集标识、许可、事件字段映射、去重规则、学生级切分策略、训练/验证/测试样本计数和切分哈希。

校准目标是消除冷启动阶段手工拍定的群体魔数。对四类 KLI 形态分别估计以下群体先验参数，并保留估计区间与有效样本量：

- $μ_{\text{KLI}}$：结构能力的形态组中心。
- $τ_{\text{KLI}}$：形态组间的先验尺度。
- $κ_{\text{KLI}}$：稳定性对形态的尺度系数。
- $γ_{\text{KLI}}$：幂律遗忘指数。
- $ψ_{\text{KLI}}$：保持率映射到能力对数几率尺度的耦合系数。

同一校准轨同时估计题目 IRT 先验，包括辨别度 $a$、难度 $b$、猜测率 $g$ 和失误率 $s$ 的分布、截断范围与数据集来源。题目参数与学习者参数分开拟合，不能用单一学习者的偶然失误反推群体题目难度。四类 KLI 形态的映射、缺失字段处理和低覆盖数据集的降权规则必须在运行摘要中可读。

离线校准采用学生级或事件时间级前向切分，严禁把同一学生未来事件泄漏到训练先验。公开数据集之间先独立校准，再进行分层汇总。汇总只生成群体先验和置信边界，不生成任何 Mangekyō 学习者的 `observed` 证据。覆盖不足、数据集间方向冲突或指标不稳定时，导出包保留宽区间或 `unknown` 校准状态。

### 7.2 深度标杆对照与 Monte Carlo 超参扫描

在相同的前向切分与相同的预测事件上训练 DKT、AKT 与 FSRS-5 对照基线。FSRS-5 仅作为离线记忆预测标杆，DKT 与 AKT 作为深度序列建模标杆。每个基线记录模型版本、训练数据哈希、特征映射、训练预算、实际 checkpoint、推理输出哈希和失败运行。对照模型不进入 `executors/python-deriver/`，也不参与线上请求。

同一 Colab GPU 轨运行大规模合成学生 Monte Carlo 仿真。合成生成器显式采样 KLI 形态、先修 DAG、题目 IRT 参数、独立与受助事件、间隔、易混关系、误解阶段和外部课程进度，并保存生成种子与参数摘要。每个场景都同时送入 `learner/cognition@4`、现行 baseline 和离线深度标杆，使用严格相同的事前前向切分样本和预测锚点。事后观测只能用于对账，不能回填原预测输入。

扫描的核心超参至少包括 Empirical Bayes 正则强度 $λ$、先修图谱传播权重 $ρ$、反向 FIRe 上限 $γ_{\text{fire}}$、跨轴部分池化方差 $τ_{\text{axis}}^2$。扫描采用固定网格或固定候选列表，记录每个组合的完整输入哈希、输出哈希和资源预算。不得只报告最佳点，必须保留稳定区间、边界行为和失败组合，避免针对单一样本过拟合。

离线 Shadow PK 以同一预测样本集对齐线上 `learner/cognition@4` 与深度标杆的 Brier、LogLoss、ECE、区间覆盖率、覆盖样本数和未知率。报告按 KLI 形态、样本量档位、题型、独立性、迁移新颖度和先修图谱密度分层，并给出与深度模型上界之间的差距及计算成本、延迟和可解释性权衡。线上方法即使在总体分数接近深度上界时，也必须继续报告受助污染、三态误标、F37 漂移和缺失见证等硬门禁。任何一项硬门禁失败，都不能以平均指标改善抵销。

### 7.3 版本化只读 JSON 先验导出包

Colab GPU 运行只通过一个紧凑、确定、版本化的 JSON 先验导出包向仓库交付结果。导出包只含推导器可读取的群体先验，不含公开数据集原文、学习者个人记录、训练 checkpoint 或不可审计的二进制状态。推荐结构如下：

```json
{
  "prior_bundle_version": "kli-population-v1",
  "generator": {"notebook": "...", "runtime": "...", "seed": 0},
  "datasets": [
    {"id": "...", "license": "...", "split_hash": "...", "counts": {"train": 0, "valid": 0, "test": 0}}
  ],
  "kli_profiles": {
    "memory_discrimination": {"mu": 0, "tau": 0, "kappa": 0, "gamma": 0, "psi": 0},
    "procedural_fluency": {"mu": 0, "tau": 0, "kappa": 0, "gamma": 0, "psi": 0},
    "principle_intuition": {"mu": 0, "tau": 0, "kappa": 0, "gamma": 0, "psi": 0},
    "open_construction": {"mu": 0, "tau": 0, "kappa": 0, "gamma": 0, "psi": 0}
  },
  "irt_prior": {"discrimination": {"mean": 0, "interval": [0, 0]}, "difficulty": {"mean": 0, "interval": [0, 0]}, "guess": {"mean": 0, "interval": [0, 0]}, "slip": {"mean": 0, "interval": [0, 0]}},
  "calibration": {"status": "review_required", "metrics": {"brier": 0, "logloss": 0, "ece": 0}, "confidence_bounds": {}, "shadow_summary": {}},
  "provenance": {"content_hash": "...", "created_at": "...", "review_status": "pending"}
}
```

实际导出必须使用明确的小数精度、固定键排序、固定数组排序和 UTF-8 编码，并由校验和绑定 notebook、数据集清单、切分哈希、参数扫描摘要与校准结果。`prior_bundle_version` 变化时不可原地改写旧包。人工评审至少核对数据集许可、切分无泄漏、参数边界、置信边界、分层指标、失败运行和线上零重依赖证明。评审通过后才把只读 JSON 包提交入仓，并在推导器方法版本和 Shadow PK 报告中引用它。

推导器只读取已经入仓且版本固定的包。包缺失、版本不兼容、校验和不匹配、评审未通过或字段越界时，推导器保留 `unknown` 或回退到明确版本的内置安全先验，并记录结构化原因。它不能联网拉取新包，不能在请求时运行校准，也不能把群体先验直接输出为学习者的 `observed`。

### 7.4 线上零重依赖边界与生产铁律

`executors/python-deriver/` 始终保持 **5–30 ms 的纯 Python stdlib 确定性推导**。生产路径明确禁止 GPU、网络、PyTorch、numpy 和 scipy 运行时依赖。运行时只接收 `gather` 生成的序列化输入包和已经审核入仓的只读 JSON 先验，固定排序、固定版本、固定边界和固定路由，保证可重放与可审计。

Google Colab GPU 永远只用于离线研究、群体先验校准、DKT/AKT/FSRS-5 标杆对照与合成学生超参扫描。任何 notebook、checkpoint、远程服务或 Python 科学计算库都不得随线上请求进入 `executors/python-deriver/`。FSRS-5 可作为离线参照，其输出不能直接成为生产保持算法，也不能取代 `docs/design/autonomy-and-forgetting.md` 已定的自研具名版本化推导。该边界不改变 `docs/PRD.md` §3 #4/#5 关于确定性推导、证据可追溯和未知合法值的要求。

Track GPU-Lab 的最终验收是边界验收与效果验收同时成立：离线报告完整保留原始指标、成本和失败运行，线上方法通过同样本 Shadow PK 与三态/F37/受助污染门禁，仓库中的 JSON 包可在无网络、无 GPU、无 PyTorch/numpy/scipy 环境下被纯标准库读取。任何一项只能证明离线研究成功，不能据此宣称生产默认方法已经切换。
