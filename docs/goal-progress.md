# 重建 goal 的执行检查点

## 新对话从这里开始 · 2026-11-18

长程 goal 的交付物是一位学生能持续使用的 Mangekyō。按[产品说明](product-overview.md)理解学习体验，按 [PRD §9](PRD.md#9-验收)、[产品规格](product-spec.md)和[功能承接表](feature-disposition.md)逐项核对完成度。范围是 70 项完整纳入和 1 项部分纳入，另有 2 项排除。按[内核设计](kernel-design.md)和[工作单元](BACKLOG.md)安排依赖。原 11 个场景、13 条承诺、D01–D10 的反例，以及每个纳入项都需要实际行为证据。

**接手基线。** 产品代码截至 `5e202b9` 已包含真实 SSE 对话、材料备课、个人笔记与小卷、逐题保存的 LLM 评分标准，以及同伴和评阅共用的 Python、任务文件和 Exa 工具。先重跑有代表性的学生路径，再对缺口派工。当前主工作区的 `docs/product-spec.md` 有未提交的产品规格修订，新对话须从该工作区读取并保留；新建的干净 worktree 需要一并取得这一版需求。[学生工作区记录](evidence/student-workspace/README.md) · [同一个 45，两份学习史](evidence/unit40/README.md) · [真实工具与 2/3 判分](evidence/study-agent/observed.json)

**常驻同伴的验收。** 所有客户端关闭、待办为空时，让后台自行发现并推进一项值得回看的旧作修订。用离开期间的实际读取与产物时间验证，随后重启后台并观察它自行接续。学生再次打开页面时直接读到成果。此项待实现。[单元 14](BACKLOG.md#单元-14常驻同伴与后台教研)

### Generative UI 从旧 TLP 学什么

以下是旧主线 `c40e375` 的静态源码证据。此次没有运行旧应用。新 UI 使用 Mangekyō 的 Material 3 Expressive 设计。

| 旧实现中可以核对的行为 | Mangekyō 的实现与验收方向 |
| --- | --- |
| 同伴回复中的函数图由模型给出表达式和参数范围，学生拖动滑块，本地按参数重新计算图形。旧组件刷新后回到初始值。[PlotBlock](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/ui-next/blocks/PlotBlock.tsx) | 拖动时即时反馈。学生选择「交给同伴」时保存这次的参数和图的版本，同伴据此继续教，重新打开也能看回原回答。 |
| Markdown 的草稿块有占位，完整块由同一入口解析并显示图表、示意图和题目引用。[MarkdownRenderer](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/ui/lib/markdown-renderer.tsx) · [BlockView](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/ui/components/blocks/BlockView.tsx) | 题目、对话、教材和课堂打开同一版内容；SSE 中断仍能阅读题意并恢复。修订教材后，旧对话仍能打开当时的图和已交状态。 |
| 断句组件把原文的可见字符与可点击字隙对齐。鼠标、触屏、方向键和空格最终切换相同的字隙 ID。草稿与交卷共用答案结构，交卷时区分某些作答位的主动留白。[BreakTapBlock](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/ui/blocks/BreakTapBlock.tsx) · [envelope](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/ui/blocks/envelope.ts) | 学生提交稳定的位置或对象标识，换行和缩放后结果一致。题库保存本版题面、作答结构、界面与判分契约；历史重判可以复核各项依据。 |
| 自定义题块向宿主建议写入已绑定的作答位，由宿主校验。供其他页面使用的旧题块入口会拒绝自定义块。[CustomBlock](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/ui/blocks/CustomBlock.tsx) · [issued-blocks](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/ui/blocks/issued-blocks.tsx) | 用同一版本化动作接口接收学习者选择，区分探索、草稿、正式提交与揭示。服务端按发题时的契约判分，交卷前的客户端响应不含私有答案和解答图。 |

**第一项新增验收。** 让真实 Agent 为新给的一段古文生成点选断句题，保存进题库后结束出题会话。从试卷重新打开，分别通过触屏和键盘提交两套成立的完整断法，再交一份混合断法。前两份按题内契约拿满分，第三份按同一套完整方案计算部分得分。再给同伴一组内置讲义之外的骑行条件，让它现场生成可操作的图，先提交预测再揭示结果；同伴读到学生实际交的变量，随后修订教材并重开旧回复。两种形状应能沿用同一条发题、作答、判分和回看路径。[题库与判分设计](design/intelligent-question-database.md)

### 并行开发与完成条件

主代理负责集成和学生验收。首批可同时查清并领取六条有独立结果的工作：生成界面与跨页面呈现、题目定义与判分、题库语义标签与自我治理、可更正和撤回的 Agent 记忆、拍卷录入与纸上作答回收、今日安排与跨日学习。先约定共同使用的题目版本、作答和依据引用；接口确定后并行编写。另一位独立验收者从学生入口操作，持续复验「同一个 45」中读取的依据、追问或跳过的理由及追答后的下一步。

子代理统一请求 `auto/deepseek-v4.1-flash`，思考强度 `high`。每个写手独占一个 Git worktree 和约定文件，涉及共享契约的修改由一人集成。审查交给没有编写该差异的独立 agent。并发数按可独立交付的工作和实际可用容量调整，主代理同时推进集成与验收。统一设置、自定义模型、SSE、Material 3 Expressive 和手机操作随各条真实旅程一起验证。

首批交付后继续按承接表推进。逐项登记能从哪个学生入口进入、做了什么、观察到什么、证据在哪里，以及失败或中断后怎样继续。最终按产品规格的贯通验收检查拍整卷到回练、更正后重判、记忆撤权、带证据安排学习、离线再同步和无模型起步。实现、独立审查、修复和真实回归都属于同一个 goal。

## 2026-11-17 旧 goal 检查点

以下为当时的暂停记录。新对话的运行状态由该对话的 goal 工具管理。

## 2026-11-18 实现进展

Owner 已在本次开发会话授权开始实现。单元 40 和教研室第一项智能验收见[本地运行记录](evidence/unit40/README.md)。下文保留 11 月 17 日检查点，长期 goal 的运行状态单独管理。

## 目标与完成证据

尽快用新架构交付现行 PRD、product-spec 与 feature-disposition 确认的完整功能。D01–D10 已按 owner 本轮明确授权全部裁决；F01–F73 为70纳入/1部分/2排除。旧代码不复制，既有排除保留。范围完成不等于代码完成。

完成需要：PRD原11场景、13承诺、产品规格全部纳入能力与反例的实际证据；双内核设计同条件比较后冻结一条生产实现；无模型、恢复、数据生命周期、费用和离线分别验收。外部发布不由本 goal 自动授权。

## 当前基线

- 单元 0–2 的设计、数据库与声明底座已存在；单元 3 的命令路径已实现，生产传播尚未接线。
- 工程生成器与结构检查已有初版，单元 7 的最终契约仍依赖单元 25。
- 测试预算最近实测为 253 / (2364 + 253) = 9.67%。每轮实际检查，不把这个快照当成固定数值。
- 所有未提交改动保留。既有设计、命令子系统和测试收敛的证据见 verification；不因新 goal 重置工作。

## 执行次序

1. 单元 40→4：Temporal/outbox 与单一恢复责任、manifest 三种引用、生效重验、同步传播及需求见证。
2. 单元 5/6/8：采纳与撤销、效果账本、Python 纯计算宿主、首条旅程领域类型；独立任务在契约确定后并行。
3. 单元 24/9/10/11/22：确定性掌握度与安排、联调样例、更正、自动入口及第一条可见 Web 链。
4. M2：真实模型与照片、供给、会话、预测对账和备课；实测比较内核并冻结。
5. 原场景与29–39完整功能按依赖接入；28覆盖全部纳入范围和反例。D01–D10 不再阻塞于产品选择，未实现/未验证仍如实报告。

## 架构约束怎样生效

- 填充任务先给公开类型、文件所有权和有区分力的输入输出；契约变更先独立审查。
- `check:structure` 检查依赖方向与规模；模块公共包入口不暴露 Db/执行器；`check:test-budget` 在测试入口阻止超过 10%。
- 不用扩大生产代码、压缩测试或隐藏夹具绕过预算。新增维护测试只用于有区分力的关键不变量。
- 并发、锁与恢复采用独立本地 PostgreSQL 证据；固定样例、静态检查和真实用户旅程分别报告。
- 不为交付速度添加模块 SQL、手写路由登记表、第二写入口或双重 claim 循环。PRD §11 信号出现时定位并重审模型。
- 上轮文件副本隔离失效未获解释。当前只允许主代理写主仓库；子代理先承担独立只读调查。恢复并行写入前，必须实际证明可写范围隔离。

## 本次已完成的规格工作与代码边界

- 技术已采用：TS、Temporal、Python、PG/S3、React PWA；此前 pg-boss 调研不是接入证据。
- D01–D10 与73项范围已闭合，新增 product-spec、ADR-0007/0008 和29–40工作单，旧文档冲突同步修正。
- 永久删除、临时载荷、schema迁移、跨语言预算及Temporal接线在现有原型中均未完成；相关运行接受为 NOT_RUN。
- 此次仅改规格/索引，不改产品代码，Goal保持暂停。完整证据待恢复实现后取得。

任何检查点只在实际观察到结果后更新为完成；当前整个 goal 未完成。
