# 收场与次日热身接线

- `learner/session-closure@1` 使用 `gather(ctx, {scope, read})`。`scope` 是 `{kind:'attempt'|'classroom',id,rev}` 或 `{kind:'today',day,timeZone}`。交卷读 storage，正式课堂身份读 teaching，使用当前修订。宿主在同一快照按每个来源的用途和本人接收方权限重开证据。仅纳入本次交卷、正式课堂的成员或该时区本地日期的记录。交卷核对正式判分、冻结题项和帮助曝光，正向反证核对原提交、旧错步及边的原始依据。卡点来自显式未解状态，念头来自该场未处理的浮标。缺覆盖用 null，已完整读取且无记录用空数组。普通试卷的判分成功与独立完成是两个证据维度，当前普通 Workbook 帮助曝光读取返回未知时沿用未知。
- `plan/tomorrow-warmup@1` 使用 `gather(ctx, {now,timeZone,read})`。当前时刻取服务器时钟。`read(ctx,{day,timeZone,startsAt})` 读取明日同一快照的 `TodayInput`，只传实际可打开的候选。本地休息、拒绝和时间约束沿用 Today。候选读取完整但无满足项返回 `empty`，缺证或已锁定原版无法打开返回 `unavailable`。该收场请求直接执行 gather 和 derive，两个入口都产生空 effects。
- 明天再说是客户端关闭。本人明确点选后，宿主在学习者写事务内重新核本场和明日输入，以 `tomorrowWarmupLock({day,timeZone,activityId,open}, current)` 生成已有 `plan.saveRule` 所需数据。同一学习者和时区沿用一条热身规则，首次创建传 `expectedRev:null`，后续本地日期以当前修订更新。两次点选并发时由现有修订冲突防止覆盖。请求 ID 与书写输入一并绑定，重复请求使用内核存档的同一回执，身份变化或候选版本变化返回冲突。用会话绑定 actor，拒绝失权或其他学习者的来源。收到 `locked` 时重显已锁入口。
- Today 从同一快照的候选目录调用 `todayWarmupRules(rules,day,timeZone,catalog)`。与原日期、时区、活动 ID 和冻结可打开版本匹配的本人锁按既有保护处理，未完成时置于保护列表首位。普通锁保持既有规则。
