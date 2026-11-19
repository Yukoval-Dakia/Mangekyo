# 采用 Pi 作为 Agent SDK

2026-11-19｜已决定。Owner 选择 Pi，以保留模型、上下文和工具的自定义空间。此决定适用于单元 12 的会话宿主及在其上运行的常驻教研。[完整设计](../design/agent-harness-and-tools.md) · [源码对照](../design/agent-harness-source-review.md)

- **Pi Agent Core** 提供可嵌入的回合、工具调用和结构化事件。Mangekyō 注入 `streamFn`，通过 `prepareRequest`、`transformContext` 和 `convertToLlm` 构造每次模型请求。工具接入内核的授权、领域命令、槽位和效果账本。
- **Pi AI** 提供模型流式协议。按当前授权的提供方和模型路由使用 `Models.streamSimple` 或产品提供的模型适配器，由 `streamFn` 调用。Mangekyō 控制自定义端点、工具可用性、消息投影、实际发送次数、取消和公开事件。适配时用可观测的传输计数核对重试行为。
- **Temporal** 继续依 [ADR-0007](0007-temporal-durable-execution.md) 独占执行进度、重试、等待、取消、汇合和版本路由。Pi Core 在单个执行步骤内运行。一次采样及其工具批次结算后，`finishTurn` 把控制权交回 Temporal。Pi CLI 的会话存储和 Pi Durable 保留为源码参考。

以已核对的 Pi 1.5.2 为首个接入版本。内存实验中，`finishTurn` 在工具返回后结束步骤。序列化历史，再从工具结果用 `runAgentLoopContinue` 发起下一次采样，工具总共执行一次，上一轮的正文与结果都进入新请求。真实提供方断流、Worker 中断后的回执复用、撤权和未知收费仍须在单元 12 验收。此前的 OpenCode、Codex 和 Vercel 比较记录继续作为对照。
