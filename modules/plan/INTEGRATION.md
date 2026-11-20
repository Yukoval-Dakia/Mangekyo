# 动态「今天」接线

## 读写入口

| 消费方 | 入口与责任 |
| --- | --- |
| Studio 目标和「我」 | 原有 `activity.setStudyGoal`、`activity.studyGoal` 继续承载文本。仍按现有规则取最新创建的目标，清空目标后保留空值。旧版非空文本读取为 active。对这条事实发 `plan.setGoalStatus({id,expectedRev,status})`。值为 active、paused、completed 或 exited。 |
| 学习者和同伴 | `plan.saveRule({id,expectedRev,data})` 创建、修订或撤回 `plan.rule`。创建传 null 版本，撤回传 null 数据。事实 ID 跨修订保持稳定，调用方复用请求 ID 做重试。两个新命令均声明 destructive，同伴调用只生成提议，决定提议走已有内核入口。交互端从会话绑定 actor。 |
| 现实约束 | `rules.ts` 的 PlanRule 支持考试日期、范围和百分比权重、校内进度或预习、每日或指定星期的时段、学校作业、例外日以及本人选择。窗口起止是本地午夜后的分钟数，weekday 取 0–6，周日为 0，null 表示每天。当前状态由已有获准声明投影；`sessionRule` 可为新声明计算时段或本地日末的绝对截止点。 |
| 前哨和工作单 | 只允许 active 且文本非空的当前目标派发备课。排队、实际发出和采纳前重新跟随目标与拒绝意图。重排只产生视图。进行中的活动、草稿和已完成活动的写入权在 Activity。 |
| 排期入口 | 加载 `plan.today` 和 `plan/today@1`。在 gatherSnapshot 内读当前目标、有效规则与预测槽位，调用 deriver.gather(ctx, read)。生产宿主负责通过当前用途和接收方复验的事实或槽位构建 TodayInput。将已发放活动定位到固定版本，保留 manifest 中的引用。当前日期、筛选模式、规则新增/撤回、活动状态变化及时段边界均需重新请求视图。 |
| Python 和 Activity | 原样传入 CanonicalEvidenceSliceV1.constraints；把 candidate_pool.ref、ranked_candidates.ref 与实际可重开的发放版本关联，使用 est_min、info_gain 和适用情境的 r_now，未知数值省略。将高信心错答对应到同概念的最小反例。曝光、适用范围、权限及答案冲突在来源处裁决，未备齐时 open 为 null。同伴阅读 shortlist 中获准的真实题目，返回 contentOrder，再调用同一规划函数；无模型时省略该字段。 |
| 真实入口 | `GET /api/today` 由 `runtime/studio/organizer.ts` 在同一读快照中执行 `gatherSnapshot → todayDeriver.gather → todayDeriver.derive`。它直接执行推导，声明的 slot 供内核加载。Web 入口是 `surfaces/web/src/today.tsx`。每项的 candidate.open、durationBasis、evidence、delayImpact 及 why 分别用于打开、估时和解释。证据句柄由宿主按本人权限映射。budget_min 为 null 且没有其他时间信息时，assumedMinutes 为 15。本人给 0 时保留休息。 |
| 操作 | 以稳定的规划候选 id 写 lock、defer、replace 或 rest 规则。defer.until 是可重新出现的第一个本地日期；撤回休息或锁定时使用该规则的当前修订。使用已获准的活动引用恢复 draftRef。只传本人的当前有效规则；同一选择的下一次修订沿用同一事实 ID。 |
| 产物发放和离线 | activity 引用由宿主打开已有课堂、练习或后测；pack 引用由 `openPack(id,rev)` 打开。浏览器缓存发布版题面与本人的选择。无模型时 `checkPack(id,rev,choice)` 提供确定性自检；离线正式提交使用既有命令队列，重连后按冻结题面复核。record 是 `activity.recordEvidence` 已有的 title/text 输入，学习者主动保存并同意该命令的 teaching 用途时才写入；统一结构化答卷与时长仍由 Activity 发放/提交入口记录。 |
| 战役态与回归 | 自动冲刺从考前七天至考试当日，自动减压为随后两天，本人可指定 campaign。冲刺以同读快照中获准候选的 `examPrep` 参数提权。母题覆盖数来自同范围且仍可读的 `instance_of` 边去重，急救卡和限时模拟来自已有可打开产物。最长三分钟的急救卡才获得短卡权重。减压至多建议一个现成复盘，额外最多十分钟，保留硬保护，长假摸底延后。lastOpenedAt 取本次返回前的访问时刻，摸底提交后按新判断重排。 |
| 分数对账 | 事前区间由评估所有者提供冻结评估引用、方法标定、误差和匹配的范围权重。考后用 `examScore` 传入同一冻结考试的独立正式评分及提交引用，复用可见评分和计划的读见证。对账区分落在区间内、低于区间和高于区间。冻结输入、正式得分或版本绑定缺失时返回 unknown。 |

现有 Organizer 投影自编卷和内置包。母题边、急救卡、正式评分及冻结预测的生产投影由获准来源的宿主提供。

## 考场用时计算

`plan/exam-pacing@1` 接收最多八条同一冻结卷、同一评分标尺、同一读截止的已授权提交投影。字段是 `id`、可选的 `effective_duration_ms`、可选的 `score: {earned, maximum}`。宿主的读取见证把每行 id 映射回提交版本、冻结卷、正式评估与用途及接收方。Python 只读取这些值。

每行缺字段时列出缺项。策略在可比较的多次整卷作答中列出「用时更久且分数相同或更低」的实际观察。现有有效用时记录在整份提交级别，策略输出保留这一粒度。

## 固定时钟复验

在装好依赖并构建 kernel 的工作区运行：

```sh
pnpm --filter @mangekyo/studio exec tsx ../../modules/plan/test/today-acceptance.mjs
```

样例固定在东京 2026-11-18 20:00。20 分钟中锁定项占 4 分钟。周四已有换算作业时选择 graph、units，各 8 分钟；撤销作业后变为 convert、graph。两次锁定对象相同。另验三周回归、单手 3 分钟、自述到期、跨日草稿、三种战役、推迟、替换、休息。PGlite 从空库加载真实模块，核验无模型包的正误反馈、学习记录保存及重复提交、本人决定目标变更、旧修订冲突、约束撤回、gather 的跟随见证。

本模块没有运行宿主浏览器、后台工作单、Python 服务、在线模型或断网重连队列。以上接线须由各入口所有者联合验收。
