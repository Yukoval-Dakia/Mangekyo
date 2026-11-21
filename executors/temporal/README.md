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
- Activity 在最后一次尝试失败时，Workflow 先检查运行期间是否已确认新的唤醒：有则携带该提示进入下一轮（必要时在安全等待点 Continue-As-New），不会带着待查提示关闭。没有新提示时当前 Run 有界地以 `FAILED` 关闭；同 Workflow ID 的下一次 `startOrWakeCoordinator` 交付按 `ALLOW_DUPLICATE` 打开新 Run 重新消费，已提交事件与回执仍由 PG 判定。
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

### P1 修复验收（Signal 在最终尝试失败前确认）

修复后 `coordinator-workflow.ts` 在 `advanceCoordinator` 失败时先判 `hasWake()`：运行期间已确认的 Signal 驱动下一轮 Activity，而不是随 Run 关闭被丢弃。隔离 namespace `p1-mwnmas41`、task queue `p1-mwnmas41-q`、无模型文件宿主下的真实 Worker 验收（源码指纹 `git diff HEAD` 输出 sha256 `847d5233...288589`）：

- 唤醒 A 的 Activity 在第 3 次尝试阻塞时确认 Signal B（历史中 Signal 事件在 `ActivityTaskFailed` 事件 `12` 之前）；同一 Run `dc19740f-e8b2-4239-bafe-564501a49d9b` 于事件 `16` 调度 `wakeRef=...FC1` 的新 Activity，B 回执写入，A 无第 4 次尝试。
- 唤醒 C 三次失败（`[1, 2, 3]`）且期间无新 Signal，Run 有界关闭 `FAILED`，失败后无额外 Activity 调度，幂等回执仅 `1` 条；后续 `startOrWakeCoordinator` 重投打开新 Run `5dad5e4d-...` 从尝试 `1` 重新消费 C。
- 旧 `mangekyoWork` 历史（11 事件）经 `Worker.runReplayHistory` 重放通过。历史文本中私有样例值与学习者标识出现次数为 `0`，错误只剩固定 `CoordinatorAdvanceFailed`。

命令：`TEMPORAL_ADDRESS=127.0.0.1:17415 node /tmp/mangekyo-unit14.DsgQCV/p1-probe.mjs "$PWD"`，断言结果位于 `/tmp/mangekyo-unit14.DsgQCV/p1-run-Jm7BvS/proof.json`。

上游接入后需复验实际 PG 配置和 outbox 交接、代次与撤权准入、效果回执及预算、已授权旧作读取和无人值守交付。生产部署、协调器换版及服务器故障恢复另验。

### 定时订正预约的滚动升级

新 Studio 应用 schema v14 后，订正预约以原 Work ID 保持 pending。已在线的旧协调器仍可处理普通 Todo。定时订正的扫描只由支持该能力的协调器 Activity 执行，派发只走 `correction-retest-v1` 能力队列。旧 Studio 的删除及教研设置修订仍会在各自的提交事务中取消受影响的预约。

在同一 store 和 namespace 启动新 Worker 并将普通队列与订正能力队列设为新构建。若 `coordinator:<coordinatorRef>` 的活跃 Run 仍固定在旧构建，要用原 Workflow ID 和 Run ID 将该 Run 换绑到普通队列的新构建。以 `describe` 结果中的部署名为准，Studio 默认使用含 store ID 的普通队列名。

```sh
temporal workflow update-options --workflow-id "$workflow" --run-id "$run" \
  --versioning-override-behavior pinned --versioning-override-deployment-name "$deployment" \
  --versioning-override-build-id "$build"
```

Worker 启动校对和普通教研变更均通过已提交的 wake outbox 唤醒原 Workflow。已绑定新构建的 Run 可直接响应唤醒及定时复查。闭合的 Run 由下一次正常唤醒以同一 Workflow ID 重开。预约的时点、截止时间、去重键及 Work ID 沿用 PG 数据。已终态取消的旧草稿预约不会重新发放。新订正请求应由新 Web 接收，重启 Web 时也使用兼容 v14 的构建。

## Studio v6/v7 原地切换到生命周期 v8

v8 将最低 Worker schema 提到 8。此切换需要停机。支持同一 PG 集群上的 **Studio 专库、直连数据库名、原对象目录、同一 Temporal namespace 与队列**。旧 Web 的读取、离线提交以及已启动 Worker 均使用原数据库名。变更该名字保留库 OID、store ID、工作与收费身份，并使旧 DSN 失效。共享库、维护库、会把旧 DSN 自动改指新库的代理、可继续提供旧副本的其他宿主需要先隔离，本流程仅覆盖上述专库拓扑。

1. 关闭入口、外发和旧进程的自动拉起。记下原 DSN、schema、对象根目录、namespace、完整队列与 build ID。对照原 schema 的 `kernel_runtime_identity.store_id` 与原队列后缀。保留 `work.execution_ref`、未交付 outbox、已启用配置的 `coordinatorRef` 和 `effects` 中未决调用身份。停止所有旧 Web 和 Worker 及其读取服务。保留未决发送的原身份，结果未知时等对账。升级期间保持外部流量关闭。
2. 在原 namespace 记录运行中的 Workflow ID 和 Run ID，包括等待 Signal 或定时器的协调器。下列命令中的 `TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE` 为此次切换的地址和 namespace，`queue` 为 **含 store ID 的完整旧队列**。PG 中已确认交接且尚未完成的工作和已启用协调器须逐个 describe 核对。Visibility 有延迟，遗漏或与 PG 不符时保持隔离并复查。未交接的 outbox 留给同一 store 的中继处理。

   ```sh
   temporal workflow list --query "TaskQueue='$queue' AND ExecutionStatus='Running'" -o json > runs.json
   jq -r '.[] | [.execution.workflowId,.execution.runId] | @tsv' runs.json > runs.tsv
   ```

3. 在仓库根目录执行下列命令。原库与维护库之间需要直连相同集群并有改名权限。脚本校验 store ID，写入无正文的切换记录，然后由 PG 原地改名。若仍有会话或 prepared transaction，PG 拒绝改名。完成正在提交的事务或人工核清未决事务后，在原 DSN 上重试。成功时脚本输出新库名。保持原库名退役。若脚本中途退出，先在维护库核对两个名字与 OID。

   ```sh
   psql -X "$OLD_DSN" -v schema="$studio_schema" -v store_id="$store_id" -f scripts/cutover-v8.sql
   ```

4. 只向 v8 分发新 DSN；原 schema 与对象路径保持一致。在入口仍关闭时，用 `MANGEKYO_PROCESS=web` 启动 v8 完成迁移。核对 PG 最新迁移与最低 Worker 版本均为 8，store ID 保持原值。启动同队列的 v8 Worker，设置唯一的 `MANGEKYO_BUILD_ID` 为下文的 `build`。待 v8 开始轮询，执行 `temporal worker deployment set-current-version --deployment-name "$queue" --build-id "$build"`。单机开发环境也可由 `MANGEKYO_ACTIVATE_LOCAL_BUILD=1` 完成选版。
5. v6、v7 到本版的两个 Workflow 定义兼容同一历史。对原清单逐个修改**同一 Run** 的 PINNED 版本，保留原 Workflow ID、历史、Activity 重试及 PG 意图。

   ```sh
   while read -r workflow run; do
     temporal workflow update-options --workflow-id "$workflow" --run-id "$run" \
       --versioning-override-behavior pinned --versioning-override-deployment-name "$queue" \
       --versioning-override-build-id "$build" </dev/null || exit 1
     temporal workflow describe --workflow-id "$workflow" --run-id "$run" -o json </dev/null || exit 1
   done < runs.tsv
   ```

6. 逐条核对 describe 中的 `versioningInfo.versioningOverride.pinned.version` 及后续 Workflow Task 使用的构建。若清单中的 Run 已关闭，查其终态和后继 Run，再处理仍在运行的后继。重复查询全队列，核对新增或续接的 Run 已在目标构建，核实原工作结果或仍有持久等待、协调器和未决 outbox 均可追踪。依配置恢复外发与用户入口。失败时保留当前 PG、对象和 Temporal 状态，入口继续关闭。此处设置的显式 pin 在下次不兼容升级时也需要迁移。

旧版交入的本机原件可能没有 store-id 所有权标记。学习者确认后，服务器先写墓碑并封锁读取，无法核实归属的原件保留为 pending。本次原地切换不会为这些文件补签归属。

**备份恢复另有前置条件。** 上述命令只迁移当前权威库。库内墓碑随快照一起回退，OID 和 store ID 无法证明备份时间点之后的删除、撤权、临时密钥销毁或收费发送。恢复副本须在断开客户端、对象读取、Temporal 中继及外发的隔离环境中校对，先取得独立账本从备份点到最近权威水位的完整证明，再应用阻断、清理对象与派生数据、核对在途发送及 Run。当前实现仅有同库墓碑与本机对象，缺少独立完整性证明时，恢复副本必须保持隔离。备份、其他设备、外部副本的物理清除状态仍为未核实。
