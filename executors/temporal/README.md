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
