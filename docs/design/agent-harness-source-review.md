# Agent 会话宿主源码对照

2026-11-19 · [会话宿主与学习工具设计](agent-harness-and-tools.md)

核对的是三个固定发布版本的源码与测试断言。用本机已有的 `@opencode/ai@2.3.0` 和 `pi-agent-core@1.5.2` 另跑了模拟传输与输入实验。Owner 已选 [Pi SDK](../adr/0010-pi-agent-sdk.md)。真实提供方与 Mangekyō 的 PostgreSQL / Temporal 贯通属于接入验收。

| 对象 | 固定源码 | 可接入的层 |
| --- | --- | --- |
| Codex CLI 0.170.0 | [`29eb79e9`](https://github.com/openai/codex/tree/29eb79e9866b3262a777fdf8195c1b9e63684c91) | `codex app-server` 的 JSON-RPC 进程协议。行为和测试用于完整宿主对照。 |
| OpenCode 2.3.0 | [`a6b15d33`](https://github.com/anomalyco/opencode/tree/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7) | 独立模型包 `@opencode/ai`。完整服务有另外的 SDK、会话持久化和运行器。 |
| Pi 1.5.2 | [`b4afdddf`](https://github.com/earendil-works/pi/tree/b4afdddf44e059c67ccf5097e5317d913521b470) | `@earendil-works/pi-ai` 模型层、`pi-agent-core` 回合和独立工具调用。Coding agent 和 Pi Durable 各有更完整的状态管理。 |

## Codex

**回合内输入有明确落点。** `steer_input` 锁定活跃回合、核对客户端附带的回合 ID 并接纳输入。`run_turn` 在构造下一次请求前读取并记录待处理输入，再捕获这一步的上下文和工具视图。采样或工具处理结束后，模型要求继续和队列尚有输入均可触发下一步。上游持久化测试把输入保存卡在检查点，断言下一次请求等保存完成，第一份请求没有更正、后一份有更正。另一个用例在回合最终 flush 时送入更正，检查它仍会进模型。Mangekyō 可直接采用这两个对外可观测断言，并把输入保存绑定到既有命令和 outbox。[接纳](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/src/session/turn_input.rs#L961) · [回合循环](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/src/session/turn.rs#L534) · [检查点测试](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/tests/suite/pending_input_persistence.rs#L203)

**动态工具确实能交给客户端执行。** `DynamicToolHandler` 解析参数，在活跃回合里按调用 ID 登记待回执项，发开始事件、等可取消的客户端回执，再把结构化内容写回模型。app-server 测试从模型产生调用开始，断言客户端收到调用标识、传回结果，并检查第二份模型请求的工具结果。配置层仅支持 Responses。现有 Chat Completions 和 Anthropic Messages 路由若经完整宿主接入，需要另外实现模型桥及对请求发送、费用和历史的控制。工具回调可实现领域命令，模型请求仍由 Codex 的运行器发起。并行工具以共享/独占锁区分，提供了“独立读可并行，有冲突的动作串行”的行为参考。[工具处理](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/src/tools/handlers/dynamic.rs#L122) · [协议测试](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/app-server/tests/suite/v2/dynamic_tools.rs#L484) · [并行调度](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/src/tools/parallel.rs#L279) · [WireApi](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/model-provider-info/src/lib.rs#L112)

**压缩与恢复共享同一可重建视图。** `run_turn` 在采样之间按窗口状态触发压缩，`run_auto_compact` 按提供方能力走不同路径。源码把替换后的历史持久化，恢复从 rollout 重建。测试逐项比较压缩后、resume 后和 fork 后发给模型的历史。同样的断言在 Mangekyō 还需要加入用途变更、分叉后的读写资格和固定版本引用。工具副作用的保证按工具解释，Code Mode 有杀死工具宿主后只留下一个文件追加的测试，适用范围是该路径。[窗口判断](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/src/session/turn.rs#L678) · [历史重建](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/src/session/rollout_reconstruction.rs#L191) · [压缩和分叉测试](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/tests/suite/compact_resume_fork.rs#L196) · [工具宿主中断测试](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/tests/suite/code_mode_host_recovery_tests.rs#L32)

**Goal 延续已有目标。** `restore_after_resume` 读持久目标，`continue_if_idle` 在同一 permit 内重读状态并启动空闲线程，避免并发取消时复活旧目标。代码要求能访问 live thread。Mangekyō 借鉴回合结束和暂停之间的竞争防护，自行实现跨作品发现、学习价值、适用预算和服务重启后无前台的首次调度。[Goal 恢复与准入](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/ext/goal/src/runtime.rs#L410)

## OpenCode

**模型包有可直接复用的单次接口。** `ai.stream(input, {signal})` 进入 `LLM.stream → stepStream → LLMClient.stream`，终止事件携带完整 assistant message 和 usage。`input.fetch` 在构造出的 HTTP 请求上接管传输，也可用 `AI.make({layer})` 接入执行器。宿主可提供工具定义、收集成对的结构化块、保留原生提供方元数据，并在效果边界控制实际发送。它仍需逐路由验证默认 transport 行为、自动降级、缓存和费用报账，尤其是从可选 WebSocket/提供方续接模式退回 HTTP 的情况。第一轮适配实验固定单次 HTTP 请求。[单次流](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/llm.ts#L102) · [Promise 接口与取消](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/index.ts#L95) · [传输注入](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/route/executor.ts#L271)

**包内循环拥有工具执行与下一次采样。** `ai.loop` 把工具错误按调用 ID 送回模型，完整保留 assistant 消息和对应结果。若 `length` 截断则跳过工具批次，非法 JSON 用结构化错误回传，修正由模型决定。默认的 `runTools` 无界并行，`until` 在步骤之后可以终止，并没有带持久控制输入的宿主边界。复用单次流后，由 Mangekyō 决定哪些调用能并行、何时已交付、什么应当等待和哪类结果未知。[循环](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/llm.ts#L218) · [工具消息和截断](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/loop.ts#L20) · [并行和校验](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/tool-runtime.ts#L45)

**完整宿主提供更丰富的会话行为。** `SessionInbox` 区分 steer 和 queue，runner 在相应边界选取、提升和记录输入。完整 runner 每步估算上下文，处理提供方溢出和已输出的部分结果。重启路径扫描遗留 claim，按轮记录尝试次数，普通会话恢复明确为至少一次。子任务已完成、父会话未收到通知时，有测试覆盖重启补送；外部副作用仍需要自己的幂等机制。接入 `@opencode/sdk` 会同时接入其会话存储、事件投影和恢复，而内核规约要求 Temporal 持有执行进度。[SDK](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/services/site/src/docs/content/build/sdk/index.mdx#L5) · [收件箱](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/inbox.ts#L53) · [runner](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/runner/llm.ts#L76) · [重启恢复](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/execution/restart.ts#L46)

**普通会话恢复和 goal 延续有不同的策略。** Goal 插件在空闲时单独采样作决定，采样后重读目标，等待需有明确唤醒源，旧进程启动的目标在新进程会被置为暂停。另一个 Schedule 服务有到期执行和补跑逻辑。Mangekyō 采用可唤醒等待和重读暂停状态的做法，教研发现和继续由同一已获预算的会话做决定，确定性宿主检查交付物和进展。完整宿主的 MCP 池以环境及连接身份复用连接，可作接入范围参照。[Goal 插件](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/plugin/goal.ts#L138) · [Schedule 测试](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/test/schedule.test.ts#L486) · [MCP 连接池](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/mcp/pool.ts#L43)

## Pi

**模型层与回合层都可嵌入。** `pi-agent-core` 导出 `runAgentLoop`、`runAgentLoopContinue` 和 `Agent`。每次请求先经 `prepareRequest`，再做 `transformContext → convertToLlm → streamFn`，传入取消信号。模型、工具和消息可在 `prepareNextTurn` 更新，`finishTurn` 能让调用方继续或结束。多步循环显式区分 steer 和 follow-up，前者进入活跃回合可消费的边界，后者在会话本要结束时被取出。`Agent` 自带的队列在进程内。若直接运行整轮，事件回调可被等待，过程内状态仍需要外部重建。可复用 `pi-ai` 的 `Models.streamSimple(model, context, options)` 作为单次采样接口，也有 `runToolCall` 可单独做参数准备、校验、前后钩子和执行。导入后者会带入 Pi 的消息与 schema 约定。Mangekyō 统一从领域声明生成 schema，当前设计采用自己的工具运行边界。[核心循环](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent-loop.ts#L175) · [模型接口](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/ai/src/models.ts#L958) · [独立工具调用](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent-loop.ts#L801) · [队列和取消](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent.ts#L289)

**Coding agent 的压缩在 core 之上。** `AgentSession` 判断预请求和溢出压缩，`SessionManager` 记录摘要与保留起点，并沿所选分支重建上下文。可借鉴保留边界、溢出与正常压缩的区分，以及压缩期间接收输入的测试。Mangekyō 需将上下文存取和撤权重验接到自己的事实与推导。Pi 的普通回合对 `length` 工具批次给错误结果，也不把模型生成的半段参数直接交给工具。[自动压缩](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/agent-session.ts#L3117) · [上下文重建](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/session-manager.ts#L577) · [截断处理](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent-loop.ts#L267)

**Pi Durable 自己持有执行。** `Harness.open` 绑定存储，`resume()` 启动遗留任务。Generation 保存 prepare、request、retry、poll、tools 等阶段，睡眠和子任务也有持久状态。丢进程的普通请求按 retry policy 可能重新发送。已取得 deferred handle 则有专门的保留和继续 poll 路径。阶段划分和测试可以供参考。接入完整 Durable 会引入另一执行恢复方，并需改造模型重发、权限和载荷寿命。[公开说明](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/README.md#persist-and-resume) · [阶段与 provider handle](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/src/harness/generation.ts#L71) · [中断后处理](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/src/harness/generation.ts#L504)

## 本机模拟实验

使用已安装的 `@opencode/ai@2.3.0`，用 `openai-compatible.configure` 创建合成模型，给 `ai.stream` 注入内存 `fetch` 和带 `execute` 计数的本地工具。四种输入均断言实际进入传输一次、执行工具零次。没有连接网络服务。

| 注入的 Chat Completions SSE | 读到的结果 |
| --- | --- |
| 先返回正文，再返回完整工具调用 | `finish=tool-calls`，终止消息同时含 `text` 与 `tool-call`。 |
| 工具参数是断开的 JSON，流正常结束 | 同一次流产生 `tool-input-error`，完整正文仍在。 |
| 半段工具参数，结束原因为 `length` | 终止原因是 `length`，终止消息没有可执行工具调用。 |
| 一段正文后关闭流，省掉结束原因 | 报告 `OpenAI Chat stream ended without finish_reason`，无正常终止消息。 |

另用 `pi-agent-core@1.5.2` 的 `runAgentLoop` 注入内存 `streamFn`。第一个模型步骤发一次 `read_attempt`，工具回调加入两条 steer，启动时另有一条 follow-up 待处理。断言工具只执行一次，第二次采样同时含原工具结果和两条更正，第三次才首次出现 follow-up。此实验覆盖内存中输入与模型请求的边界。

OpenCode 的实验验证了适配位置可用于隔开模型和工具，也提供了正文丢失的对照。此前 Mangekyō 的同类模拟把带工具的 assistant 正文置为 `null`，实际教学中另出现过仅回执和错误声称已保存。既有 [OpenCode loop / Codex CLI 模拟结果](../evidence/study-agent/harness-protocol-comparison.json)、[真实教学记录](../evidence/study-agent/workspace.json) 和 [Pi core 既有嵌入实验](../adr/0009-editable-agent-loop.md) 可对照。

## 选型结论

| 用途 | 取舍 |
| --- | --- |
| 采用的 SDK | Pi Agent Core + Pi AI。用 Core 的回合和结构化工具事件，以注入的 `streamFn` 控制采样与模型协议。Pi AI 作为模型适配层。 |
| 行为对照 | 从 Codex 取输入持久化、动态工具和压缩恢复的断言。从 OpenCode 取收件箱、部分输出、补送子任务结果的断言。此前的 OpenCode 单次调用和 Vercel `streamText` 保留为模型协议层对照。 |
| Mangekyō 自己实现 | 学习工作单和交付条件、动态权限及费用、副作用提交、会话输入与可见事件、长期记忆和证据引用、领域工具生成、跨日自主教研。Temporal 提供执行恢复原语。 |

Pi 接入验收在获准的 Chat Completions、Anthropic Messages 和产品需开的 Responses 路由中核对模型身份、混合内容、完整工具参数、签名元数据、SSE 断线、取消和费用恢复。记录发送次数、实际出站内容、可观察 finish/usage 和 Worker 中断后的重放。只有原生窗口及权限策略允许时才启用提供方压缩、服务器端上下文句柄和托管工具。[Pi SDK 决策](../adr/0010-pi-agent-sdk.md) · [Temporal 消息与处理器](https://docs.temporal.io/develop/typescript/workflows/message-passing)
