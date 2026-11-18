# 功能盘点来源与证据边界

2026-11-15。供 [功能盘点](feature-sweep.md) 引用；历史来源不构成 Mangekyo 的现行规格。

## 范围与方法

- 新规格：本仓库 `docs/PRD.md`，辅以 `GLOSSARY.md`、`docs/kernel-design.md`、`docs/BACKLOG.md`。覆盖判定以 PRD 为准，不把工作单元尚未排入等同于产品不做。
- 旧源码：`/Volumes/YukovalSBak/yukoval-projects/the-learning-project`。只读静态盘点，没有启动旧服务、调用产品模型或进行浏览器验收。文件存在、函数存在、工单 Done 均不等于端到端功能可用。
- 旧文档：代码仓库以外的 `tlp-docs` 与 `tlp-status` 也在范围内。旧 README 明确原 `docs/` 已移到 `tlp-docs/repo-docs/`；只扫旧 git 仓库会漏掉大量近期产品决定。
- Linear：通过恢复后的 MCP 只读获取。枚举全部 23 个项目，YUK 团队含归档项的全部工单索引共 2,229 条，250 条一页，共 9 页；最后一页 `hasNextPage=false`，按 ID 去重仍为 2,229 条。进一步读取下面 36 张重点工单正文，以及 4 张工单的全部 30 条评论。没有逐条读取其余 2,193 张工单正文，没有遍历全部附件、项目文档和评论。
- 并行分工：源码、旧文档、Linear 索引三路；主线程独立取回 Linear 正文，并核验文档与关键源码。子任务出现的错误标题、虚构引文和 PRD 错误映射已剔除，未作为报告证据。
- 本次没有复制旧代码、schema、提示词、配置或测试，没有改 PRD、内核规格、术语、BACKLOG、ADR 或 Linear，没有创建 git commit。以下本机绝对路径便于核查，旧目录移动后需重新定位。

## 文档证据

### D01：Owner 要求总账

[owner-goals.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/planning/owner-goals.md:1)

60 条编号记录。第 10 行明确“状态初稿……按记忆填写，未核实”；其中的“已交付”等状态不能直接当作运行证明。

| 行号 | 原文节选 | 在本次盘点中的用途 |
|---|---|---|
| 21 | 全面的 Generative UI 支持，包括笔记/题目/对话 | 三个材料面的共同呈现能力 |
| 25 | Backtrace：相似的错法、相似的解法 | 保留具体历史追溯目标 |
| 26 | 传统算法与统计信号，AI 也需要 | 与新版 §6 对照 |
| 27 | 题库/知识点/notes……同时利于人类和 AI 的低摩擦工具 | 保留共同工具目标 |
| 28 | 多因素、长追踪的数据提取，brainstorm | 长程分析仍是探索方向 |
| 29 | Steering：马上期中考，AI 应当能够响应 | 目标与考试安排 |
| 30 | 题目的解法入库时应该有先验数据 | 提前备好解答 |
| 31 | Agent 一启动就带最近数据 | 同伴上下文连续性 |
| 37 | 允许多次提交……必须能分部分提交 | 活动和工具的增量完成语义 |
| 40 | 配置页让用户自己选模型和思考强度 | 配置的用户控制面 |
| 41 | 收件箱每天少于 5 个决策 | 打扰负担的产品目标 |
| 43 | 拟题进题库 Pending，不进收件箱 | 生成材料不要求逐题审批 |
| 44、52 | 流式传输；及时显示工具和流式文字 | 等待过程中的可见进度 |
| 45、62 | 照片直接依赖模型多模态；完整抽取并标注 | 图片和手写是正式学习证据 |
| 46、47、70 | 作答记录、排版打磨；笔记版式已认可 | 可读性目标，非继承旧 CSS |
| 48 | AI 运行错误提示能不能手动消掉 | 错误可读、可处理 |
| 50、67 | 3D 吉祥物；手机上压扁 | 视觉身份遗产，PRD 未表态 |
| 57 | 数据高塔：AI 轻易查看每个数据流，帮助提前备好 | 产品北极星 |
| 59、71 | 给模型 Python；所有 agent 有界工作区 | 计算与解题工具能力 |
| 60 | 搜索工具目标 <1s/请求……解决真实题目搜索问题 | 检索价值与速度分别验收 |
| 61 | 放开，作答时也不收 | 同伴可读参考解，不等于向学习者泄题 |
| 63 | 练习准备在后台，准备过程中也可以自行补充 | 按需求备料 |
| 64 | 笔记可以适当横向扩充知识背景 | 笔记不局限于错题答案 |
| 68 | 科目经验……当做一个文档库 | 学科语境共同维护 |
| 69 | 「看过」「做对」「自己会了」按推荐 | 独立掌握与受助完成分开 |
| 73 | 聊天里不允许模型修改上一个回答的 UI 内容，但笔记里可以 | 对话历史与可编辑作品的区别 |

### D02：七支柱愿景

[vision-pillars.md](/Volumes/YukovalSBak/yukoval-projects/tlp-status/vision-pillars.md:1)

2026-10-10 愿景评审稿，包含建议、待拍板取舍与当时状态；不将所有建议升级为 owner 决定。原文确实是七支柱，与新版七性质同源。

| 行号 | 原文节选 |
|---|---|
| 13 | 学习分析学习者状态，智能动态安排学习者任务，提供尽可能多的帮助 |
| 51 | 发生时间和录入时间分开，原件永远在，识别错了能改 |
| 59、60 | 解题过程回放须先证明额外价值；语音通道由可访问性需求触发 |
| 78、84 | 错误模式治好一个退役一个；状态不升级为永久结论 |
| 104 | 永远不需要先批阅一堆内部建议才能开始学习 |
| 110–115 | 稳定路线、积压恢复、学校进度预览、考试节奏、错后换壳、自我批评 |
| 134、140 | 学科语境可见可改；教材版本对齐而学习史不乱 |
| 160、174 | 材料有来路；本人材料优先等题源次序在此仍是推荐 |
| 188、194 | 帮助逐步放手，挫败时不说教，拒绝加练不换说法重推 |
| 199 | 教 AI、考 AI 是远期可试的学习方式 |
| 218、220 | 能看、能改、能导出、能删；删除与隐藏、停用分开 |
| 224、226 | 掌握带情境；小问不重复计数 |
| 228–232 | 进步对比、时间价值、分数预测、家长分享、师生材料接力 |
| 250–267 | 32 张点子卡的完整去向索引 |

### D03：练习队列重做

[2026-11-04-practice-queue-redesign.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-04-practice-queue-redesign.md:33)

第 33 行：“Coach 看着真实的题和你的情况，排一个带理由的队列。”第 48 行统一今日重点与选题；第 57 行允许有理由地推迟到期题；第 63–65 行要求无现成队列时先提供确定性版本，正在做和已做的项冻结。这些是产品语义；随机抽样器、锁和旧队列结构不迁移。

### D04：知识点学情档案

[2026-11-14-learner-profile-contract.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-14-learner-profile-contract.md:7)

第 7 行要求同伴、教练、选题、错因、周报、整理共用同一数字来源；第 15 行“未知不是零”；第 20–31 行列出能力、记忆、证据新鲜度、用时、看过/跳过/提问、帮助依赖、错因复发/消退、先修、可疑题、已备帮助。文件开头是当时未实现状态，不能覆盖后来的 Linear 状态。

### D05：提示连续性

[2026-11-14-hint-continuity.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-14-hint-continuity.md:7)

第 7–11 行：重新打开恢复已发布提示，不调用模型；按原顺序显示，仅下一阶可生成；区分正文缺失、结果未知和权限不可用；求助绑定当前已保存作答版本，并计入援助。

### D06：有效作答时间

[2026-11-14-visible-answer-time.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-14-visible-answer-time.md:7)

“切到后台时暂停计时，只上报活跃时间。”这是前台有效用时，**不是答案显示/隐藏时间控制**。

### D07：生成练习直链

[2026-11-14-generated-practice-link.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-14-generated-practice-link.md:13)

“URL paper target overrides list/item selection. Direct entry must not fetch/recompose DayStream.”目标是链接打开指定卷、复用已有作答页面，**不是变式与原题来源链的设计**。

### D08：长文章跨页续排

[2026-11-15-long-passage-flow.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-15-long-passage-flow.md:5)

第 5–8 行要求纸卷长材料按阅读顺序续排、不裁丢、不缩字号掩盖溢出；第 35 行要求 PDF 全文覆盖原冻结材料。这是打印排版语义，**不是虚拟滚动或阅读位置保存**。

### D09：上传即可练

[2026-11-13-upload-ready-practice.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-13-upload-ready-practice.md:11)

第 11–14 行要求新上传合法题可出现在现有练习流，已有作答和进行中的题不被重置，常规规划暂不可用时仍能打开上传题。其锁协议、marker、旧事件名不迁移。

### D10：实际作答题的掌握度难度基准

[2026-11-13-answered-mastery-beta.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-13-answered-mastery-beta.md:3)

“同一有效作答集、当前标定值和计数下，新增未答题不再改变掌握度。”第 17 行明确：当前难度重标定、合法新作答、更正和用途改变仍可影响数值。**不是永久冻结掌握度，也不是单纯把作答接入掌握度**。

### D11：学习计划掌握进度

[2026-11-14-learning-plan-progress.md](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-14-learning-plan-progress.md:6)

每个知识点展示掌握档、范围、近期证据量和待更新状态；“初步证据已满足”不冒充“计划已完成”，未知不用 0% 代替。

### D12：旧领域术语

[CONTEXT.md](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/CONTEXT.md:16)

“学习状态与学习安排”明确独立作答、按知识点计证据、动态调整；“抽取与分析”区分大题/小题/共享材料、手写和外部判分证据；“学习内容”含复习、组卷、探针、错因、记忆与作答卷导出。该文件也保留了带补注的历史定义，发生冲突时不取最早一句压过后来的裁决。

## Linear 正文与评论证据

所有状态均为 2026-11-15 读取时的工单状态，表示工作流状态，不表示本次验证了功能。

| 工单 | 状态 | 核读的功能要求 |
|---|---|---|
| [YUK-37](https://linear.app/yukoval-studios/issue/YUK-37) | Done | 记忆是注意力先验，不与学习事实争真相；mempalace 方案被否定后转向另一实现 |
| [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) | Done | 教学检查题与回答进入正式题、提交和判分链，不只留聊天文字 |
| [YUK-88](https://linear.app/yukoval-studios/issue/YUK-88) | Done | 可编辑富笔记、块级标错、引用反链、活笔记、撤销 |
| [YUK-94](https://linear.app/yukoval-studios/issue/YUK-94) | Done | AI 随学习演化笔记；协调学习者编辑；可查看与撤销 AI 修改 |
| [YUK-98](https://linear.app/yukoval-studios/issue/YUK-98) | Done | 部分得分给自评建议，学习者可覆盖 |
| [YUK-100](https://linear.app/yukoval-studios/issue/YUK-100) | Done | 评分建议考虑有效错因，不由各界面另判 |
| [YUK-1346](https://linear.app/yukoval-studios/issue/YUK-1346) | In Progress | 单轮仅用于回答：可保留原聊天，但不进入长期派生及之后上下文 |
| [YUK-1398](https://linear.app/yukoval-studios/issue/YUK-1398) | In Progress | 危机支持、用途与转介边界；核读全部 12 条评论 |
| [YUK-1417](https://linear.app/yukoval-studios/issue/YUK-1417) | Backlog | 离开编辑后未完成 AI 修改不静默丢失；版本冲突保草稿 |
| [YUK-1427](https://linear.app/yukoval-studios/issue/YUK-1427) | Backlog | 纸卡与屏幕任务同身份，拍回不双计；缺页与迟交 |
| [YUK-1462](https://linear.app/yukoval-studios/issue/YUK-1462) | Backlog | 同题前后对比、可编辑成长叙事、带证据导出 |
| [YUK-1548](https://linear.app/yukoval-studios/issue/YUK-1548) | Done | 对话、笔记、题目共同支持图形/图表/交互内容 |
| [YUK-1595](https://linear.app/yukoval-studios/issue/YUK-1595) | In Progress | 与学习者共同创造学习方式；明确只讨论理念、不自动进入实施队列 |
| [YUK-1766](https://linear.app/yukoval-studios/issue/YUK-1766) | In Progress | 相似具体错法与本人成功解法；核读全部 10 条评论，真实目标仍未通过的记录 |
| [YUK-1808](https://linear.app/yukoval-studios/issue/YUK-1808) | In Progress | 用户选择模型/思考等级，实际请求与展示一致；核读全部 7 条评论 |
| [YUK-1882](https://linear.app/yukoval-studios/issue/YUK-1882) | In Progress | 作答入口也能当场提供危机转介，不等判分 |
| [YUK-1905](https://linear.app/yukoval-studios/issue/YUK-1905) | Done | 每天少于五个决策是减负目标，不是把建议藏起来的硬上限 |
| [YUK-2028](https://linear.app/yukoval-studios/issue/YUK-2028) | Backlog | 基于真实成果的备题/复习提醒 |
| [YUK-2058](https://linear.app/yukoval-studios/issue/YUK-2058) | In Progress | 外部找题的搜索词不能带出学习者原文 |
| [YUK-2084](https://linear.app/yukoval-studios/issue/YUK-2084) | Backlog | 过程模型：乱猜、苦想、先对后改错、提示依赖、回避 |
| [YUK-2085](https://linear.app/yukoval-studios/issue/YUK-2085) | Backlog | 错后当天换题再学；信心高却答错优先复测 |
| [YUK-2088](https://linear.app/yukoval-studios/issue/YUK-2088) | Backlog | 已备帮助→提供→打开→使用→后续独立表现 |
| [YUK-2089](https://linear.app/yukoval-studios/issue/YUK-2089) | Backlog | 不预告方法的辨析练习，典型错项与误解关联 |
| [YUK-2092](https://linear.app/yukoval-studios/issue/YUK-2092) | Backlog | 学习者话语的语义检索与跨来源综合，遵守用途 |
| [YUK-2093](https://linear.app/yukoval-studios/issue/YUK-2093) | In Progress | 我觉得你怎样、凭什么、哪里没把握、什么会改变看法 |
| [YUK-2094](https://linear.app/yukoval-studios/issue/YUK-2094) | Backlog | 按用途过滤数据后做长程计算分析；固定每周运行不是新版既定义务 |
| [YUK-2096](https://linear.app/yukoval-studios/issue/YUK-2096) | Backlog | 例题渐隐、自我解释、先试再讲 |
| [YUK-2097](https://linear.app/yukoval-studios/issue/YUK-2097) | Backlog | 帮助形式按后续独立表现调整，记录无用/取消/重画 |
| [YUK-2098](https://linear.app/yukoval-studios/issue/YUK-2098) | Backlog | 当天自述状态可查看可撤回，影响安排；不收身体睡眠数据 |
| [YUK-2122](https://linear.app/yukoval-studios/issue/YUK-2122) | In Progress | 目标达成/停滞可见，接受完成后不继续拉旧目标题 |
| [YUK-2128](https://linear.app/yukoval-studios/issue/YUK-2128) | In Progress | 误解复发与改善、退役，不把旧标签永久贴在人身上 |
| [YUK-2140](https://linear.app/yukoval-studios/issue/YUK-2140) | In Progress | 打印卷拍回原任务；1 条评论明确新片仅源码就绪，回收尚未完成 |
| [YUK-2159](https://linear.app/yukoval-studios/issue/YUK-2159) | Done | 从解法先验提出先修关系，拒绝后不反复提 |
| [YUK-2166](https://linear.app/yukoval-studios/issue/YUK-2166) | In Progress | 各类练习结束后复盘；错因与过程信号进小结和后续安排 |
| [YUK-2173](https://linear.app/yukoval-studios/issue/YUK-2173) | Backlog | 跳过/放弃与提问焦点成为可追溯记录 |
| [YUK-2229](https://linear.app/yukoval-studios/issue/YUK-2229) | In Progress | 保存使用编辑基版本，迟到回执不清掉新稿或另一篇笔记 |

YUK-1766 的评论还限定了重要语义：本人失败作答不能冒充成功解法，模型推断的方法不能冒充本人写过的方法；照片无 OCR 时不能悄悄把常见使用场景排除。YUK-1398 的评论说明专业模板审定与部分入口仍未完成，不能据测试 PR 或 In Progress 状态宣称已交付。

## 源码证据

下列 18 个文件的所引函数体或实际返回结构由主线程直接阅读，不以文件名、注释或子任务结论代替执行代码。每行是静态观察，未执行测试；不是全文件或全依赖闭包的正确性审计。代码路径均在旧主仓库，不复制到新仓库。

| ID | 入口与观察 | 源码位置 | 对应盘点 |
|---|---|---|---|
| C01 | 创建录入会话：原件资产引用、可选学科与用途进入接纳；保留 uploaded 或失败会话回执 | [createIngestionSession](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/ingestion/server/create-session.ts:14) | F01、F08、F65 |
| C02 | 逐块自动入库：缺题干留待处理；普通标注失败仍可入库；受限用途不发送给标注模型；每题保留图片与作答标记 | [runAutoEnrollForSession 循环](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/ingestion/server/auto-enroll.ts:244) | F02–05、F14 |
| C03 | 单题作答：原生作答、附件、自动保存、冲突选择、待判与已记账反馈；只读当前已确认保存的题/修订/保存版本 | [use-practice-submit 的返回面](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/ui/use-practice-submit.ts:1415)；[有效用时](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/ui/use-practice-submit.ts:993) | F22–23、F27 |
| C04 | 正式提交：要求原始发放身份；返回 pending run 或 committed 结果；传递自评、原始 capture 与独立证据要求 | [submitReviewAnswer](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/grading/server/review-operation.ts:360) | F21、F24–25、F29、F67 |
| C05 | 判分申诉：校验请求，对原生 evaluation 创建申诉并按回执请求重判；历史缺原始绑定明确拒绝新执行 | [createPracticeAppeal](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/settlement/server/appeal-operation.ts:20) | F26 |
| C06 | 定位测试：已有未完成题先返回同题；根据答题量/精度停止；供给结束但证据不足时给低把握及后续日常校准说明 | [runPlacementAdvanceTx](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/placement/server/placement-advance.ts:90) | F73 |
| C07 | 错后处理：重新读取当前有效判分，改判正确不再自动归因；学习者已有错因时不自动覆盖；加载实际思路与原生错答上下文 | [requestFailureLearning](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/failure-learning/server/failure-learning.ts:125) | F04、F39、F43 |
| C08 | 知识点页：返回同一判断的掌握范围、证据量、记忆/新鲜度，及邻居、笔记、反链和时间线；未知保留 null | [loadKnowledgeNodePage 返回面](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/knowledge/server/node-page.ts:435) | F35–36、F42、F59 |
| C09 | 统一学情读口：组合能力和记忆，显式标注未校准、组件未知、预测封存尚未接通，而非伪造一致性与校准 | [readLearnerJudgments](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/kernel/read-models/learner-judgment.ts:176) | F35、F45、F58 |
| C10 | 笔记阅读/编辑：块锚点跳转、保存版本、撤销 AI 修订、冲突提示；当前 save 成功无身份守卫清草稿，不能视作已兑现 YUK-2229 | [NoteReaderPage 保存与撤销](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/notes/ui/NoteReaderPage.tsx:257) | F22、F59–60 |
| C11 | 笔记精修：检查目标与版本，修改正文并同步反链，记录前后版本、反向 patch、任务与费用；不只是生成一段文字 | [persistNoteRefineApply](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/notes/server/note-refine-apply.ts:129) | F59–60 |
| C12 | 完成建议：读取目标/学习项证据和已决历史，避免已有 pending 与无新证据的重复建议；写需人接受的 completion 提议及回退信息 | [proposeComputedCompletion](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/agency/server/learning-item-completion-producer.ts:21) | F49、F66 |
| C13 | 同伴对话接纳：冻结当前用途、对话上下文与已保存草稿焦点，危机策略可覆盖普通用途，回执模糊时按原身份对账 | [acceptCopilotTurnAfterAdmission](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/copilot/server/chat-acceptance.ts:205) | F27、F34、F63、F65 |
| C14 | 教学简报读取：先读已有效果结果，再已备探针，最后新发现；不是要求学习者先批一堆内部报告 | [loadTeachingBrief](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/shell/server/teaching-brief.ts:1308) | F55、F57、F66 |
| C15 | 配置读面：分别给出值、来源、默认/有效值、到期状态；任务行带实际 binding、预算、覆盖值和人读分组 | [buildAdminConfigReadModel](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/observability/server/config-read-model.ts:245) | F68 |
| C16 | 备题员完成时核读库存，未确认合格题数则返回 awaiting_admission 或 no_progress；生成流程结束不等于题已备齐 | [runQuestionPreparer](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/supply/server/question-preparer.ts:81) | F13、F16、F55、F67 |
| C17 | 确定性今日流：去重并组合到期题、变式、卷、新题与前沿题，再按时间和容量预算裁切 | [composeDailyStream](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/scheduling/server/stream-composer.ts:112) | F36、F47、F54 |
| C18 | 纸卷导出：按幂等键/内容判断重放与冲突，逐题创建冻结发放并保存导出项 | [createWorksheetExport](/Volumes/YukovalSBak/yukoval-projects/the-learning-project/src/capabilities/practice/session/server/worksheet/export-store.ts:383) | F06 |

C18 不是拍照回收解码、原任务对位和掌握度完整闭环的证明。YUK-2140 的最新评论仍明确拍回链未交付。

源码与文档/工单出现的状态差异保留：例如 C12 已有完成提议生产者，不等于 YUK-2122 整体目标生命周期已验收；C09 明示 `sealing: 'not_connected'`，不能因为存在统一读口而声称预测对账已完成；C10 的主线保存路径与尚在另一 PR 的修复不能混为一谈。

## Linear 项目覆盖

项目枚举无下一页。以下按功能归并；工程项目中的实现任务不转为新产品义务。

| 项目 | 盘点用途 |
|---|---|
| P-YUK-1 Foundation B — SubjectProfile + Frontend Subject Awareness | 学科中立、学科语境 |
| P-YUK-2 Product Track 1 — Review / Learning Item / Teaching 收口 | 复习、目标、教学 |
| P-YUK-3 Project Ops — Roadmap & Docs SOT | 识别文档来源与工程范围 |
| P-YUK-4 Memory Module — mempalace Sidecar Evaluation | 区分失败选型与仍有价值的记忆目标 |
| P-YUK-5 Track 2 起步 + Foundation 末尾收口 | 更正、可靠性与共享工具 |
| P-YUK-6 Foundation D — Copilot Orchestrator + DomainTool Registry | 同伴与工具对等 |
| P-YUK-7 Track-1 Follow-up — Note / Teaching / Review polish | 活笔记、提示、评分建议 |
| P-YUK-8 Security & Dependency Audit 2026-05-28 | 不继承旧依赖修补清单 |
| P-YUK-9 Security & Stability Audit 2026-06-06 | 同上，区分产品边界和旧工程债 |
| P-YUK-10 领域模型重构 — note/题库/FSRS/组卷 | 材料、复习、供给 |
| P-YUK-11 私人教研团 — AI-native rethink | 核心产品愿景与近期缺口 |
| P-YUK-12 记忆层 — mem0 + KG 一致性 | 记忆持续性与用途 |
| P-YUK-13 UI 重绘 — claude design | 可读性与交互目标，非继承样式 |
| P-YUK-14 学习者全面档案 — n=1 firm-up | 证据、画像、校准 |
| P-YUK-15 Rust 同构核心 — 确定性 cold-start 引擎 | 冷启动目标，非继承 Rust 选型 |
| P-YUK-16 产品可用性硬化 — Truth → Journey → Polish | 状态诚实与完整旅程 |
| P-YUK-17 Codex Security remediation 2026-07-18 | 旧工程处置背景 |
| P-YUK-18 Architecture deepening — 架构深化评审落地 | 实现层背景 |
| P-YUK-19 私人教研团真实性验证 — Grounding before expansion | 区分真实产物和任务成功 |
| P-YUK-20 Architecture Deepening FULL — 语义、成本与运行所有权 | 提炼运行/成本价值，不迁移旧机制 |
| P-YUK-21 TLP · Security Cloud Findings — Grounding & Remediation | 旧安全清单背景 |
| P-YUK-22 TLP · Agent readiness — 运行可观测性与工程质量 | 维护者可诊断目标 |
| P-YUK-23 TLP · TS 全栈与实时自适应学习 | 自适应闭环，不继承旧栈迁移义务 |

全部工单状态分布：Done 1,455；In Progress 178；In Review 15；Backlog 408；Todo 36；Triage 67；Canceled 53；Duplicate 17。数字来自索引，不将取消项当成未完成承诺，也不将无项目工单排除在搜索之外。
