# Temporal 工作执行

中继用 `startWork(client, executionRef, { taskQueue })` 启动工作流。`executionRef` 是 PG 与工作意图同事务保存的随机 ULID，既是 Workflow ID，也是唯一业务入参。重投使用原值。在 Temporal 保留工作流历史期间，相同 ID 的运行中或已关闭记录均视作已交付。`describeWork(client, executionRef)` 查看运行状态、部署版本及活动尝试。

`pnpm --filter @mangekyo/temporal worker` 加载 `MANGEKYO_EXECUTE_WORK_MODULE` 指向的本地模块。该模块导出 `executeWork(executionRef)` 和幂等的 `onTerminalFailure(executionRef)`。执行函数从 PG 解析工作意图，按当前工作代次和效果账本处理。执行最多尝试四次。耗尽后，独立 Activity 持续尝试记录失败状态，记录成功后工作流以失败结束。工作流历史记录不透明引用、平台运行元数据和脱敏后的失败。Activity 心跳不带业务载荷。

Worker 从 `TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE`、`TEMPORAL_TASK_QUEUE`、`TEMPORAL_DEPLOYMENT` 和 `TEMPORAL_BUILD_ID` 读取配置。同一部署的每个构建使用独立 Build ID。新 Worker 开始轮询后，通过 `temporal worker deployment set-current-version --deployment-name <部署名> --build-id <新版本>` 切换流量。保留旧版 Worker，直到绑定旧版的运行结束。

使用独立本地开发服务器复现恢复验证。验证会新建自己的命名空间，终止并重新启动实际 Worker 进程，并输出工作流 ID、运行 ID、状态和版本。

```sh
temporal server start-dev --ip 127.0.0.1 --port 7423 --headless \
  --dynamic-config-value frontend.workerVersioningWorkflowAPIs=true \
  --dynamic-config-value frontend.workerVersioningRuleAPIs=true \
  --dynamic-config-value system.enableDeploymentVersions=true
TEMPORAL_ADDRESS=127.0.0.1:7423 pnpm --filter @mangekyo/temporal verify:runtime
```

## 后台协调器

配置命令的 outbox 和启动校对共用 `startOrWakeCoordinator(client, coordinatorRef, wakeRef, { taskQueue })`。宿主为每位学习者独立分配并持久保存一个小写 UUIDv4 `coordinatorRef`，跨配置代次复用。`wakeRef` 是已提交的唤醒引用，采用现有 outbox 的规范 ULID 格式。交接成功返回 `coordinator:<coordinatorRef>`。交接确认丢失时用原引用重投，运行中的实例接收 Signal，已关闭的实例可按同一 Workflow ID 重开。

Worker 宿主用 `createWorkWorker(..., { ...config, advanceCoordinator })` 注入适配器。使用 `worker` 命令时，可由 `MANGEKYO_EXECUTE_WORK_MODULE` 指向的模块导出同名函数。协调器沿用 Worker 的版本绑定，调用方使用已注册该 Activity 的 Task Queue 和构建。

- 适配器签名为 `advanceCoordinator({ coordinatorRef, wakeRef? }, signal)`。`AbortSignal` 由 Activity 在宿主进程内传入。宿主按协调器作用域查询当前配置和所有已提交未消费事件，校验用途、暂停及代次，在外发和接受迟到结果前重查授权并按 PG 回执去重。幂等键来自稳定业务身份，跨 Activity 尝试和 Run 复用。外发结果未知时由宿主保留效果记录并进入等待。
- 首轮即使零待办也调用一次适配器。Signal 只保留一个最新提示，Activity 运行期间收到的提示触发后续复查。`advanced` 表示已取得持久推进且应继续检查。`waiting` 可指定绝对毫秒时点 `recheckAtMs`，定时等待至少五秒且可由 Signal 提前唤醒。省略时点时只等 Signal。`disabled` 在没有待查提示时结束当前运行。
- Activity 结束、消息处理完成后，主 Workflow 按服务端建议 Continue-As-New，传递协调器引用和待查提示，新 Run 重新读取宿主当前状态。Temporal 持有等待和恢复状态，PG 持有业务事件、回执和效果。历史中的 Activity 返回值只保留状态与复查时点，异常转为固定错误。
- 每轮 Activity 最多三次尝试，单次限时一分钟，心跳超时十秒。耗尽后 Workflow 进入 `FAILED`。后续显式唤醒或启动校对可重新交接，已提交事件仍由宿主按回执查收。

实现对照 [TS 1.26.0 SignalWithStart 源码](https://github.com/temporalio/sdk-typescript/blob/v1.26.0/packages/client/src/workflow-client.ts#L695-L729)、[消息处理](https://docs.temporal.io/develop/typescript/workflows/message-passing) 和 [Continue-As-New](https://docs.temporal.io/develop/typescript/workflows/continue-as-new)。

### 单元 14 本地验收

基线 `5cc2ecf5c8e603b60a24264a7883b0f29b47e5c3`。Temporal TS `1.26.0`、CLI `1.10.1`、Server `1.32.2`。真实 Worker 使用独立 namespace `u14-mwnj9wbr`、task queue `u14-mwnj9wbr-queue` 与构建 `isolated-probe`。无模型宿主以本机文件模拟现行配置、未消费事件和回执。

| 断言 | 实测值 |
| --- | --- |
| 零待办首轮、确认丢失后经同一入口重投、杀进程恢复 | 杀前待办 `0`、Activity 调度 `1`、定时器 `0`。`SIGKILL` 前后 PID `80302 → 80557`、同一 Activity `1` 的尝试 `1 → 2`。交接、重投和恢复沿用 Run `440a1604-dd68-410d-946c-e25a90bb860b` 和相同唤醒引用，假发现回执 `1 → 1`。 |
| 在途通知跨 Continue-As-New | 旧 Run `6eb150b6-d201-4433-8f8a-44766bb08672` 在活动调度事件 `15` 后收到 21 条 Signal，首末事件 `16`、`60`，随后结算于事件 `65`、续接于 `69`，期间未调度第二个 Activity。Workflow ID `coordinator:b53de873-080c-44e3-af49-3cfcb7ea3b11` 保持，新 Run `26561c93-55c7-4b57-8da9-e4141d607a89` 携带 `01ARZ3NDEKTSV4RRFFQ69G5FB4`。 |
| 假宿主扫描和代次反例 | 假准入 `0 → 2`，包含没有单独发送 Signal 的事件 `01ARZ3NDEKTSV4RRFFQ69G5FB3`。代次 `1 → 2` 后拒绝代次 `1` 的事件 `01ARZ3NDEKTSV4RRFFQ69G5FB2` 和代次 `1` 的在途候选。 |
| 定时复查与配置关闭、重开 | 目标 `1795091781498`，定时 `13931ms`，触发 `1795091781523`，调用只有协调器引用。过期目标 `1` 触发 `5000ms` 等待，由关闭提示取消，定时复查回执保持 `1`。Run `6510904d-c069-4899-a02b-4657a8f98baa` 完成，重开沿用 Workflow ID 并获得 Run `d5df51a4-6add-49b1-9aff-ce8a9215394e`。 |
| 最终失败与载荷 | 失败 Run `9fbd93b4-4f4c-4910-8b70-4932b0cff579` 的尝试为 `[1, 2, 3]`，一次 Activity 调度、零定时器，假回执 `5 → 5`。解码核对 Workflow 输入、Signal、Activity 输入与结果、续接参数，历史中两种私有样例值出现次数均为 `0`。 |
| 旧 Work 历史重放与恢复 | 基线进程 PID `80296` 死亡后，新包 PID `80302` 完成原 Run `01a1f3ce-42a9-7947-bde1-97e546f15b9a`，Activity `1` 的尝试 `1 → 2`，原单一输入保留。`Worker.runReplayHistory` 及现有 `verify:runtime` 均通过。 |

实际命令如下。只为隔离验收将服务端续接建议的历史阈值降至 20 个事件。

```sh
"$HOME/Library/Application Support/Mangekyo/development/bin/temporal" server start-dev \
  --ip 127.0.0.1 --port 17414 --headless \
  --dynamic-config-value frontend.workerVersioningWorkflowAPIs=true \
  --dynamic-config-value frontend.workerVersioningRuleAPIs=true \
  --dynamic-config-value system.enableDeploymentVersions=true \
  --dynamic-config-value limit.historyCount.suggestContinueAsNew=20
TEMPORAL_ADDRESS=127.0.0.1:17414 node /tmp/mangekyo-unit14.DsgQCV/probe.mjs "$PWD"
TEMPORAL_ADDRESS=127.0.0.1:17414 pnpm --filter @mangekyo/temporal verify:runtime
pnpm typecheck
pnpm check:structure
pnpm check:test-budget
pnpm test
git diff --check
```

`probe.mjs`、假宿主、基线执行器及机器可读的断言结果保存在本机 `/tmp/mangekyo-unit14.DsgQCV/`，本轮输出和历史位于 `run-NekmUy/`。测试门禁从基线 `1771 / 17589`（`10.0688%`）到 `1771 / 17738`（`9.9842%`），Vitest 通过 47 项。

上游接入后需复验实际 PG 配置和 outbox 交接、代次与撤权准入、效果回执及预算、已授权旧作读取和无人值守交付。生产部署、协调器换版及服务器故障恢复另验。
