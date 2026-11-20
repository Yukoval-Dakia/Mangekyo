# 课堂与前哨读取

从 `@mangekyo/module-learner/facts/cognition` 导入 `projectClassroomRadar` 和 `readVerifiedPlaybook`。课堂宿主在 start、adjust、advance 或 archive 的已授权读取中绑定实际学习者、用途、接收方及模型设置版本。后台巡检重新按后台用途读取。模型提供的参数不能指定学习者、接收方或授权范围。

**雷达。** 在一个 `GatherContext.snapshotTick` 和同一个规范 UTC 业务时刻收集数据，调用 `projectClassroomRadar(asOf, sources)`。宿主保留正式 manifest 中的 `BusWitness`（learner、type、id、rev、accessEpoch、mode）、有效槽版本和覆盖范围。每个集合必须是当前获准范围的完整结果。不可枚举、达到分页上限、来源过期或未接通时省略该字段；完整盘点得零时传空集合。模型发前复验用途、接收方、删除水位和来源版本。临时状态按其来源 TTL 到期，稳定偏好继续遵循原声明。

| 输出 | 正式来源及计量单位 |
| --- | --- |
| weakTop3 | 有独立作答和实际知识点的当前概率预测；同一知识点取已观测维度中最低的 masteryProb，依次返回至多三项。局部原题桶不能充当知识点。 |
| forgetting24h | 同时刻的冻结预测中，在未来 24 小时内跨越遗忘阈值的不同知识点数。 |
| highConfidenceWrong | 当前计算结果中 high-confidence-error 的不同作答引用数。 |
| examGaps | 已确认考纲内，通过完整对照判定尚无测量的知识点数。 |
| exhaustedFamilies | 在给定目标、时间和授权范围内，完整盘点后可用变式数为零的题目家族数。 |
| warmBackfills | 已登记待回填的不同温对象任务数。 |
| gardening | 当前待人工决定的不同提案数。策略降级本身不能代替待审提案。 |
| workAndInventory | 当前可派/在途的不同工作单数、实际可领取的不同成品数，分别保留未知。 |

**教法。** `readVerifiedPlaybook(read, {id, rev, accessEpoch})` 需要绑定教学用途和真实接收方的 `ReadContext`。仅把返回的当前 verified 策略用于教学；核对其版本、反思来源、后测来源和核验槽，保存 statusId 供最终复验。返回空或读取拒绝时省略教法。草案文本、未知 Lift 和已降级版本不能进入该槽。

**工作信号。** 使用内核 `Todo` 投影和原生 `TodoInput` 登记。当前状态、revision、sourceFactRev、settingsRevision、expiresAtMs 和 eligibility 一起决定工作是否仍可派发。先确认用途及全部证据，再统计活动工作单。过期或取消的预约不计入。雷达读本身不创建预约和学习记录。

**订正和后测。** 正式订正第一次提交时，在同一事务创建预约并绑定原始命令回执。完成或取消后重放该命令，返回原回执；单独再调 `emitTodo` 只会对活跃工作去重。发放与采纳时均复验当前代次、授权及截止。读取订正反证时，`hypothesesAsOf` 的第四个参数接收按实际用途重新打开的提交及全部依据。缺少任何一项时省略该边。

Lift 的配对读取器须从事前登记的任务和正式交付、评分及曝光事实生成数据，以原始提交身份去重，在同一 `gather` 中登记全部依赖。宿主从同用途同快照获取这些事实；已有教学授权的交卷另行取得研究授权后才能用于后台周任务。
