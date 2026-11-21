# 教学 Agent 的循环由 Mangekyō 维护

2026-11-19 · 记录单元 40 的取舍和实验。单元 12、14 采用 [Pi SDK 决策](0010-pi-agent-sdk.md)与[会话宿主和学习工具设计](../design/agent-harness-and-tools.md)。跨工作单的等待和恢复沿用 [ADR-0007](0007-temporal-durable-execution.md)。

## 决定

保留仓库内可直接修改的 TypeScript 循环。每次模型请求由宿主投影上下文和本轮可用工具，每次工具读取能把事实修订交还给宿主，每次写入复用领域命令。搜索也有回执。在「先搜索、再建题」中断后恢复时，同一搜索应返回当时的候选，否则它会把刚建的题搜出来，改变下一次模型请求。模型或外部工具已经发出而结果未知时，已有的效果账本负责拦住重复发送。选择这条路线，我们承担提供方协议适配、上下文预算、取消和回归验证的维护成本。

## 复核过的替代

| 候选 | 可以直接利用的部分 | 对本产品的代价 |
| --- | --- | --- |
| Pi 1.5.2 agent core | MIT、TypeScript，宿主可以提供 stream 函数、转换上下文、介入工具调用及决定何时停止。实测同一运行中两次 DeepSeek 请求之间能读一份旧作。 | 宿主要衔接模型发送、已扣费结果重放、授权撤回、业务写入和前端 SSE。 |
| Pi Durable 1.5.2 | 独立任务、恢复和后台压缩。 | 官方仍标为实验性。进程在模型请求中断时可依重试配置再次请求，和我们的未知费用核对需要协调。采用它还需重新裁定 Temporal 和 Pi 谁持有恢复状态。 |
| Codex CLI 0.170.0 | app-server 提供回合内补充输入、中断和线程恢复。进入下一次采样前处理新输入，压缩后的会话视图可供恢复和分叉。 | app-server 可以把产品工具交给客户端执行。该版模型提供方配置只接受 Responses 协议，现有 Chat Completions 和 Anthropic Messages 提供方需要协议桥接。[模型协议](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/model-provider-info/src/lib.rs#L119) · [客户端工具测试](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/app-server/tests/suite/v2/dynamic_tools.rs) |
| OpenCode 2.3.0 完整宿主 | `@opencode/sdk` 在进程内运行服务器，会话有持久收件箱、工具事件、压缩和重启恢复。 | 其会话投影与恢复自带存储。接入整套宿主，需要决定中断后的哪个组件有权发下一次请求。[SDK 文档](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/services/site/src/docs/content/build/sdk/index.mdx#L5) · [会话投影](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/projector.ts#L1112) |
| OpenCode 2.3.0 模型层 | 独立包 `@opencode/ai` 可以只执行一次流式请求，也可选用带工具的循环。接入单次请求无需启动 OpenCode 会话。 | 单独使用这个包时，长会话的压缩策略、持久收件箱和重启恢复仍由宿主提供。[公开 API](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/README.md#L49) · [工具循环](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/loop.ts#L192) |

下文依据本机 CLI 所对应的发布提交，Codex 为 `29eb79e9`，OpenCode 为 `a6b15d33`。上游测试用来核对作者实际断言的行为，本次没有运行两套完整测试。Pi 的嵌入实验和 Pi Durable 的证据沿用前次评估。[Pi core](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent-loop.ts) · [Pi Durable](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md)

## 从输入到恢复的源码复核

**学生在工具运行中改口。** Codex 收到 steer 后将输入放进当前回合队列。工具返回后，只要还有待处理输入，执行器会再次采样。上游测试卡住一个工具，在等待期间连续送入两条更正，再检查下一次实际发给模型的请求同时含有工具输出和两条更正。OpenCode 也区分进入当前回合的 steer 与留到下个回合的 queue。Mangekyō 普通对话入口在上一轮未 ready 时返回 HTTP 409。学生能看到 SSE 流，却只能等这一轮结束再纠正题意。[Codex 入队](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/src/session/turn_input.rs#L961) · [Codex 断言](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/tests/suite/pending_input.rs#L1882) · [OpenCode 断言](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/test/session-runner.test.ts#L1734) · [普通对话入口](../../runtime/studio/sessions.ts)

**长会话和提供方溢出。** Codex 在回合中检查窗口，压缩时处理尚未消费的输入，测试逐项比较压缩后、恢复后和分叉后模型看到的历史。OpenCode 默认把摘要与约 15,000 token 的近期原文并置。提供方拒收超长请求时，已开始留下持久输出的步骤与尚未输出的步骤走不同路径，避免重演已经展示的内容。Mangekyō 对旧搜索和读取工作区的结果留预览及重读提示。实测同样八对工具调用，每个结果含 2,400 个“学”，`read_workspace` 从 59,057 压到 46,823 字节，换成 `read_file` 则保持 59,017 字节。这里的 48 KiB 是局部缩减阈值。要判断学生当时是否独立列式，直接打开作答的原始版本。[Codex 压缩](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/src/compact.rs#L403) · [恢复与分叉测试](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/tests/suite/compact_resume_fork.rs#L196) · [OpenCode 压缩说明](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/services/site/src/docs/content/compaction.mdx#L5) · [已输出时的断言](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/test/session-runner.test.ts#L6171) · [本地投影](../../executors/teaching/workspace-context.ts)

**写入成功、回执丢失。** OpenCode 在执行本地工具前发布调用事件，结束后持久化结果。重启按遗留的工作认领恢复会话。它明示恢复为至少一次，源码也保留了从调用事件到副作用结算之间的幂等问题。它另有一个很值得借鉴的测试：子任务结果已存、父会话还未得到通知，重启后补送结果且无需重跑子任务。Codex 的 Code Mode 测试在文件已经追加一个字符后杀掉工具宿主，检查模型收到重置信息，文件仍只有一个字符。这个保证的适用范围是该工具路径。Mangekyō 给同一外部效果预留身份，结果不明时保留 unknown，本地读取与其回执同事务提交。这部分应保留在产品内核。[OpenCode 工具执行](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/runner/step.ts#L135) · [恢复契约](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/execution/restart.ts#L57) · [已知窗口](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/file-mutation.ts#L141) · [子任务测试](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/test/session-execution.test.ts#L1403) · [Codex 宿主崩溃测试](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/core/tests/suite/code_mode_host_recovery_tests.rs#L32) · [本地效果账本](../../kernel/src/work/effects.ts)

**MCP 与自定义提供方。** Mangekyō 实现了通过 HTTP 初始化 MCP 会话、分页发现及调用选中的工具，发现结果也能按回执重放。OpenCode 另有本地 stdio、远程 OAuth 和连接复用，复用键考虑凭据身份、环境和工作目录。引入模型层只解决模型协议适配，这些能力属于完整宿主。评估接入成本时应分开计算。[本地 MCP](../../executors/teaching/mcp-client.ts) · [工具发现与重放](../../executors/teaching/mcp-tools.ts) · [OpenCode 连接池](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/mcp/pool.ts#L43)

## 本机协议实验与教学验收

前五项使用只监听本机的合成 SSE 服务。修好的参数由测试提供方发回。Codex 两组都报告了合成模型缺少目录元数据，均使用同一套默认值。最后一项来自此前使用真实模型的普通同伴会话。[合成输入、逐次请求与终止事件](../evidence/study-agent/harness-protocol-comparison.json)

| 实际运行的入口 | 注入的输入 | 观察到的结果 |
| --- | --- | --- |
| `@opencode/ai@2.3.0` 的 `ai.loop` | 工具保存成功，下一次流给出正常 stop 和空正文 | 请求两次、工具执行一次、最终文本为空，结束原因为 stop。 |
| 同一入口 | 第一次给出截断的 JSON 参数，随后给出有效参数 | 第二次请求包含工具错误。三次模型请求合计只执行一次工具，最后返回正文。 |
| 同一入口 | 工具参数只到一半，结束原因为 length | 工具执行零次，调用方收到 length。 |
| 同一入口 | 给出一段正文后断流，缺失结束原因 | 报告流缺失结束原因，工具执行零次。 |
| Codex CLI 0.170.0 的普通 `exec --json`，无 goal、无工具 | 单次 Responses 请求正常完成。对照组有正文 OK，另一组无输出项 | 两组各发一次请求，均发出 turn.completed 并以 0 退出。只有对照组有 agent_message。 |
| Mangekyō 已留存的真实学习会话 | 学生要求复述旧作中的随机签名，并存一条关联原答的观察 | Agent 读到签名、保存观察，学生只看到写入回执。会话显示 ready，教学验收失败。[原始记录](../evidence/study-agent/workspace.json) |

OpenCode 模型包的实验没有经过 OpenCode 完整会话或界面。Codex 普通回合的实验没有创建目标。上游另行测试了活跃目标连续空转时转为阻塞的行为。[模型包的结束处理](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/loop.ts#L192) · [Codex 目标空转测试](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/app-server/tests/suite/v2/thread_goal_empty_responses.rs#L30)

## 学习工作区的工具

核对了 Notion MCP 的 `search`、`fetch` 和 `update_page`，以及 Linear MCP 的 `get_document` 和 `save_document`。Notion 的 fetch 在数据库块标识不适用时会指向错误中可用的数据源 URL；Linear 的 save_document 在新建时省略 id，更新时只提交有变化的字段。工作区沿用这两种做法。能修正的错误作为工具结果返回，指出字段、可用值或获取正确标识的操作，由 Agent 决定下一步。[Notion 工具目录](https://developers.notion.com/guides/mcp/tools-search) · [Linear MCP](https://linear.app/docs/mcp)

| 操作 | Agent 需要知道什么 |
| --- | --- |
| `search_workspace` | 可以空查，也可以指定关键词、类别或关联对象。返回标题、标识和版本，每页最多八项。 |
| `read_workspace` | 给一个记录标识，或给 `learner` 查看当前有依据的学情观察和近期作答。长文返回下一段的位置。 |
| `save_workspace` | 新建提供类别、标题和正文，修改提供已有标识及改变的字段。工具从本轮实际读写中取得版本；学情观察和作答批注要先打开原作。返回可以在产品里打开的标识和版本。 |

这三项操作共用一套对象标识。题目、教材、概念和观察可显式链接原作。用于检查用途的内部依赖另行保存，标题出现在搜索结果中不能据此宣称同伴读过全文。修订保留原字段的来源，撤回原作的教学用途后，新的模型调用也无法读取沿用那份原作的衍生记录。

在已授权提供方的本机隔离实例运行 `node scripts/acceptance/studio/agent-workspace-acceptance.mjs http://127.0.0.1:端口 输出.json`，会实际交一份新卷、让同伴跨会话查原答、存题、编教材并检查撤权。[两份学习史、工具回执与失败记录](../evidence/study-agent/workspace.json)

## 后续 always-on 如何接入

编排 Agent 可以定期扫学习概览，也可以在自己完成一项工作后立即再作决定。例如它发现今天的新作答推翻了昨天备课的依据，就领取「重写周五练习」工作单，读取原作，修订自己备好的题。一项工作要留下目标、依据版本、可回看的产物和下次值得考虑的条件。若依据和产物均未变化，或当期预算用尽，Temporal 可以等待条件、约定的复查时间或者学习者来信。恢复时用最新用途和预算重建工作上下文。后台编排、跨日预算及其学习收益仍需单独实现和验收。

两套上游都实现了无需用户再发消息的续作。Codex 的 goal 扩展在线程空闲时重新检查持久目标，并对读取目标到启动续作之间的竞争加锁。OpenCode 的 goal 插件在会话即将空闲时另发一次模型请求，判断完成、继续、等待或暂停。判定后重新读取目标，防止学生刚刚取消的工作又被启动。它把重复的理由和一轮没有调用工具视为可能停滞。其定时调度另有宕机后补一次及防重复投递的测试。教学场景可借用空闲时判断和竞争处理，衡量有用进展则要看实际产物，例如新作答是否使周五练习中的某道题需要更换。[Codex 目标续作](https://github.com/openai/codex/blob/29eb79e9866b3262a777fdf8195c1b9e63684c91/codex-rs/ext/goal/src/runtime.rs#L434) · [OpenCode 空闲判定](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/plugin/goal.ts#L104) · [OpenCode 调度测试](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/test/schedule.test.ts#L486) · [单元 14 产品验收](../BACKLOG.md)

## 单元 12 的早期对照

单元 40 使用仓库内循环。早期实测包含 OpenCode 单次模型请求和 Pi 嵌入，完整 OpenCode 作为中途输入、压缩与重启的行为对照。单元 12 已选定 Pi。接入时仍须核对每次请求的用途、费用身份、已知结果重放和未知状态。[SDK 决策](0010-pi-agent-sdk.md) · [单元 12 验收](../BACKLOG.md)

验收从「同一个 45，两份不同的学习史」扩展。让学生在查旧作时纠正题目条件，截取下一次真实模型请求，核对工具结果和更正都在其中；跨过窗口后再查提交前是否看过提示；在保存观察后断开再恢复，检查只存一条、学生拿到先前要求的答复。另测撤回用途后下一次请求实际发出的内容。常驻教研单独按单元 14 验收，前台关闭、无新消息时能自行发现旧讲义值得修订，留下可回看的依据与提议。
