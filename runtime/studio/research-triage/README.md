# Research triage assets

Local, model-agnostic assets for the Always-Doing sentinel described in `docs/design/always-doing-and-agent-tools.md` §2.2–§2.3.

- `skills.ts` — six fixed skill cards with `when` / `when_not` / `must_check` / `todo_template` / `examples`, plus deterministic selection of 2–3 cards for a wake source.
- `snapshot.ts` — local snapshot shape and validator for facts, events, todos, inventory, forecasts, work, memos, signals, chain and budget. IDs must be snapshot ULIDs; revisions/ticks are strings or positive integers.
- `response.ts` — strict single-JSON response parser. It rejects extra fields, expression-like text, IDs outside the snapshot, and any `emit_todo` fields not copied from the matched card template. Models never write trigger expressions.
- `fixtures.json` — 30 golden triage scenarios covering repeated misconceptions, ready/used/withdrawn inventory, scheduled and due time points, empty water levels, fatigue/undo withdrawals, goal shifts, completed/failed work, ambiguous deep cases, and invalid outputs.
- `fixtures.ts` — fixture loader and scorer. Reports hits, false positives, misses, withdrawal hits/misses, invalid responses, and rates.
- `score-fixtures.mjs` — runnable entry for bundled simulated outputs from the repository root: `pnpm --filter @mangekyo/studio exec tsx research-triage/score-fixtures.mjs`. These are fixture outputs for scoring/validator regression, not a real-model evaluation.

This directory intentionally has no PG/schema, Temporal, provider, UI, or shared package changes. A later host can materialize the same snapshot from PG, call a cheap model with `triagePromptBlock(wakeSource)`, then pass the raw reply through `parseTriageResponse` before applying orchestration primitives. No credentials or paid model are used here.

## Studio 的付费前哨

通过现有 `PUT /api/research/settings` 提交 `requestId`、当前 `revision`、`enabled`，以及
`scoutBudget: { limitMicros, expiresAtMs, route, maxRetentionDays, maxPerCallMicros }`。金额使用整数 USD 微元
（1 USD = 1,000,000 微元），有效期使用 Unix 毫秒。额度按学习者累计计入已结算费用与
仍占用的预留。暂停、续期、提高上限和换路由均延续同一账本。连续启用时省略 `scoutBudget` 可保留原设置。关闭或传 `null` 撤回付费授权。恢复付费需重新提交额度、接收方、到期时间及最大留存天数；仅启用则运行本地教研。旧设置缺少留存许可时仅运行本地教研。未配置时仍可运行本地确定性复习单。

Web 和 Worker 的 `MANGEKYO_RESEARCH_SCOUT_MODULE` 载入可信服务端模块中的 `researchScoutHost`。
宿主提供 `route`、`reserveUsdMicros`、明确的 `retentionDays` 和 `sample(input, signal)`。路由标识随接收者或
定价策略换代。宿主须在 `sample` 被调用时启动一次请求、执行报价的单次硬上限和传入的
输出 token 上限，并禁止内部重试或后备路由。宿主回传 `reply`、实际 `actualUsdMicros`
和实际 `servedModel`。缺少实际费用时留空，只有明确确认零实付时传零。未安装匹配
宿主时等待；当前树没有第三方付费宿主实现。真实供应商接线需要相同币种的可执行单次
硬上限、可核对实付以及明确版本的接收者。

前哨仅发送可核对的独立卷摘要及预绑定菜单。冻结试卷须与当前独立卷一致。
有材料或题源关联、缺少冻结证据时，前哨拒绝外发该卷。已删除材料不会通过旧作
产生新的复习单，旧复习结果也不能用来重新读出已删除来源。

作答修订与访问代次共同标识效果。预留、发送标识和金额沿用内核效果账本。
有明确实付时先提交金额，即使原件已删或回执已折叠，也只更新金额。业务决定
应用时重新检查授权和来源。消费标记与 Todo 登记在一个事务中写入，待消费的结果
可以从原效果重开。积压逐项处理，额度不足时等待现有唤醒或定时复验。费用未知
和交付未知继续占用额度。更新 schema 12 前应停止旧 Studio/Worker，由新版本接管。

研究协调器可能长期处于等待状态。若升级时将退出旧构建，先核对该学习者的
`mangekyoCoordinator` 工作流及在途前哨效果，再确认新 Worker 已在原任务队列注册。
已绑定旧构建的协调器可按原 workflow ID 定向接续。下例保留原 run 和已结算效果。

```sh
temporal workflow update-options --workflow-id "$coordinator_id" \
  --versioning-override-behavior one_time \
  --versioning-override-deployment-name "$deployment_name" \
  --versioning-override-build-id "$new_build_id"
```

以 `temporal workflow describe` 核对原 run 已绑定目标构建，并用获准作答核对下一次唤醒。
旧试验设置缺少留存或单次价格授权，升级后仍可查账，恢复付费需由本人重新授权。
