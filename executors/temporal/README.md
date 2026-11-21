# Temporal 工作执行

中继用 `startWork(client, executionRef, { taskQueue })` 启动工作流。`executionRef` 是 PG 与工作意图同事务保存的随机 ULID，既是 Workflow ID，也是唯一业务入参。重投使用原值。在 Temporal 保留工作流历史期间，相同 ID 的运行中或已关闭记录均视作已交付。`describeWork(client, executionRef)` 查看运行状态、部署版本及活动尝试。

`pnpm --filter @mangekyo/temporal worker` 加载 `MANGEKYO_EXECUTE_WORK_MODULE` 指向的本地模块。该模块导出 `executeWork(executionRef)` 和幂等的 `onTerminalFailure(executionRef)`。执行函数从 PG 解析工作意图，按当前工作代次和效果账本处理。执行最多尝试四次。耗尽后，独立 Activity 持续尝试记录失败状态，记录成功后工作流以失败结束。工作流历史记录不透明引用、平台运行元数据和脱敏后的失败。Activity 心跳不带业务载荷。

Worker 从 `TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE`、`TEMPORAL_TASK_QUEUE`、`TEMPORAL_DEPLOYMENT` 和 `TEMPORAL_BUILD_ID` 读取配置。同一部署的每个构建使用独立 Build ID。新 Worker 开始轮询后，通过 `temporal worker deployment set-current-version --deployment-name <部署名> --build-id <新版本>` 切换流量。兼容升级可保留旧版 Worker，直到绑定旧版的运行结束。需要停机的版本按对应切换流程执行。

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

## Studio v13 草稿库切换到 v14

适用于尚未登记 v14 的库。只有写过定时订正预约的 v13 草稿构建需要恢复这些预约，正式主线的 v13 不会写这种预约。旧版 v14 已登记的库不会重跑迁移，也不会补做撤权、墓碑回查或抬高 Worker 门槛。有草稿预约或升级来历不明时，保持停写及停轮询，先核对墓碑、授权、PG 意图及 Temporal 历史，再制定修复方案。已被旧构建取消的预约保留终态。

1. 关闭所有写入入口和外发，禁用旧 Web、Worker 和中继的自动拉起，停止这些进程并确认退出。**禁止旧草稿 Worker 在 v14 上轮询。** v14 把最低 Worker schema 提至 14，只能拒绝旧 Studio 重新启动。已启动的旧 Worker 不会再次读取门槛，若继续轮询，原 Run 可能由旧 Activity 完成并把订正预约取消。保留原 PG store、对象路径、Temporal namespace 和队列。对未决外发保留原身份并对账。
2. 保持停写，记录原 store ID、所有现有队列及其构建。在原 namespace 对各队列列出活跃 Run，包括普通队列上的 `mangekyoWork` 和 `mangekyoCoordinator`，记录 Workflow ID、Run ID、队列及部署。用 PG 的 `work.execution_ref`、尚未交接的 outbox 和已启用设置里的 `coordinatorRef` 逐个 describe 复核。未确认的 Work 意图也可能已启动，必须用原 `execution_ref` 查询。Visibility 可能延迟，有遗漏则复查。未曾启动的意图由新版中继处理。不要 cancel、terminate、reset 或另启同一业务的工作流。

   ```sh
   export TEMPORAL_ADDRESS TEMPORAL_NAMESPACE
   temporal task-queue describe --task-queue "$queue" -o json > pollers-before.json
   temporal workflow list --query "TaskQueue='$queue' AND ExecutionStatus='Running'" -o json > runs.json
   jq -r '.[] | [.execution.workflowId,.execution.runId] | @tsv' runs.json > runs.tsv
   ```

   `queue` 是包含 store ID 的完整队列名，例如 `mangekyo-studio-<store ID>`。每条队列单独保存清单及 describe 结果，避免覆盖原记录。

   在原 Studio schema 查询 PG 的交接身份和协调器身份。

   ```sql
   SELECT w.id, w.generation, w.execution_ref, o.state AS delivery
   FROM work w LEFT JOIN work_outbox o
     ON (o.learner_id, o.intent_id) = (w.learner_id, w.execution_ref)
   WHERE w.state = 'ready' AND w.execution_ref IS NOT NULL;
   SELECT 'coordinator:' || (r.data->>'coordinatorRef') AS workflow_id
   FROM facts f JOIN fact_revs r ON (r.learner_id, r.fact_id, r.rev) = (f.learner_id, f.id, f.current_rev)
   WHERE f.type = 'companion.researchSettings' AND f.retracted_rev IS NULL AND r.data->'enabled' = 'true'::jsonb;
   ```
3. 用新版以 `MANGEKYO_PROCESS=web` 启动并完成迁移，继续隔离用户入口。确认库仍是原 store，schema 和最低 Worker schema 均为 14。用同一数据库和 namespace 启动新版 `MANGEKYO_PROCESS=worker`，以唯一的 `MANGEKYO_BUILD_ID` 标识构建。待开始轮询，把各队列的部署版本指向新构建，含普通队列和现有订正能力队列。

   ```sql
   SELECT max(version) AS schema_version FROM kernel_schema_migrations;
   SELECT store_id, minimum_worker_schema FROM kernel_runtime_identity WHERE singleton;
   ```

   ```sh
   temporal worker deployment set-current-version --deployment-name "$queue" --build-id "$build"
   ```

4. 每条队列用各 Run 原来的部署名，按原 Workflow ID 和 Run ID 改绑 Work 和 Coordinator。切换默认构建后，旧 Run 仍可能固定在旧构建。

   ```sh
   while read -r workflow run; do
     temporal workflow update-options --workflow-id "$workflow" --run-id "$run" \
       --versioning-override-behavior pinned --versioning-override-deployment-name "$deployment" \
       --versioning-override-build-id "$build" </dev/null || exit 1
     temporal workflow describe --workflow-id "$workflow" --run-id "$run" -o json \
       </dev/null > "describe-$run.json" || exit 1
   done < runs.tsv
   ```

5. 核对 describe 的 `versioningInfo.versioningOverride.pinned.version` 以及原 Run ID。让已提交的 wake outbox 通过正常入口唤醒协调器（例如新版 Worker 启动校对），用历史确认该 Run 收到唤醒并由新构建运行 `advanceCoordinator`。订正 Work 等待已有 Activity 继续或重试，在原 Run 历史核对新版的 Workflow Task 及后续 Activity 身份，以及 PG 中的结果、等待原因或合法终态。

   ```sh
   temporal workflow show --workflow-id "$workflow" --run-id "$run" -o json > "history-$run.json"
   ```

   如果启动校对早于换绑，Signal 会留在同一活跃 Run 的历史中，换绑后核对其消费。对于仍在定时等待的 Run，等到实际复查再确认。若清单中的 Run 已关闭，核对终态和后继，如有后继则继续核对。确认无旧构建执行，同一工作代次未重复派发，普通 Todo 可继续，且删除或撤权的预约未派发，再按现有配置恢复入口和外发。发现差异时保留 PG、对象和 Temporal 历史并继续隔离。

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

## Studio v14 切换到 S02 v16

保留上节的停写、停外发、停止旧 Worker 和中继、登记原 Run 及原意图、按原身份重绑步骤。仅新版 Web 执行迁移。新版 Worker 启动前核对原 store ID 以及 schema 和最低 Worker schema 均为 16。已启动的旧 Worker 不会重读门槛，必须在首个迁移事务前确认退出。

正式主线 v14 已有订正预约的 routed 队列、授权与墓碑触发器。保留原 v14 迁移，v15 添加工作载荷关联，v16 安装按效果原身份归档的键并补登记既有复习单。两步在同一个迁移事务内完成。

已确认来自本地 S02 草稿的 v14/v15 库，若仍带草稿收费归档约束，则由 v16 追加正式订正结构并继续补登记。契约单独跑过的 v15 库也走此路径。墓碑和原收费身份保留，能确认的漏删正文在停写期间补清。两类结构以库中列、索引和触发器共同识别，无法确认的结构会中止升级。按原 store 和 Run 继续，保留旧迁移日志。未知来历的库应保持停写并先在副本核对授权、墓碑、已有收费及 Temporal 历史。
