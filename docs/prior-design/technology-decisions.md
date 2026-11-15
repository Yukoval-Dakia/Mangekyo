# the-learning-project 技术选型裁决

**2026-11-15｜设计裁决｜配套 [架构设计](architecture.md) 与 [重构 PRD](refactoring-prd.md)**

本次从目标重新选择整套架构。旧项目的库、语言、已有代码量不构成沿用理由；旧文档仅用于辨认必须保留的产品能力。没有深读旧实现，没有编写应用代码，也没有通过原型证明性能或开发成本。

明确选择：**Python/FastAPI/Pydantic 业务后端，PostgreSQL/SQLAlchemy Core/Alembic 存储，Temporal 耐久编排，Pydantic AI agent，Python OCI 计算池，PowerSync/SQLite 多端同步，React Web 与 React Native/Expo 客户端。** 下文给出选择成立的理由与代价，实施机制以架构设计为准。

## 1. 用什么标准裁决

| 标准 | 对本项目意味着什么 |
| --- | --- |
| 一项状态有一个权威 | 学习事实、会话、运行进度、授权、费用有不同所有者；同一种进度不能由两个框架各自恢复 |
| 少维护通用引擎 | 使用现成数据库、工作流、同步和 agent 循环；自有代码集中在教学语义、接纳、权限与跨系统交接 |
| 局部修改能被机器约束 | 类型与运行校验、导入图、数据库角色、契约兼容、负面样例共同阻止越界 |
| 计算与交互各自扩展 | GPU、长任务、外部工具和插件可以独立分配资源，不能阻塞在线事务或客户端 |
| 版本、故障和退出有办法处理 | 在途代码可以继续运行；取消能撤销资格；来源更正能使旧结果失效；离线工作能恢复；插件卸载后记录仍可读 |

没有用框架下载量、路由跑分或“某模型更熟悉某语言”推导结论。低成本模型是否更可靠，最终要比较同类变更的总返工、集成与审查成本，不能仅比较生成代码的费用。

## 2. 业务后端：Python + FastAPI + Pydantic

**选择理由是可信后台实现与契约的集中。** 长期变化重心包含复杂计算协调、动态 agent 工作和教学领域命令。Python 让这些服务端职责共用类型化接口、错误语义和测试设施；计算包仍隔离部署。FastAPI 提供请求/响应模型及 OpenAPI 接口装配，Pydantic 为 HTTP、工作流消息、工具和计算结果提供共同的建模基础。[FastAPI 功能](https://fastapi.tiangolo.com/features/)、[Pydantic Schema](https://pydantic.dev/docs/validation/latest/concepts/json_schema/)。

“共用”只发生在确实相同的概念上。HTTP 命令、内部领域对象、数据库行和提供方工具参数有不同寿命；各自具名建模，复用稳定的基础契约。持久 Workflow/Activity/Signal 载荷独立版本化，新入口向旧运行发送消息时显式转换；仅固定旧 Worker 不能修复新消息格式。客户端只得到 OpenAPI/Schema 与生成物，不导入后端实现。

| 认真考虑的替代 | 为什么本项目没有选它 |
| --- | --- |
| TypeScript + Fastify，Python 负责计算/agent | 最强替代。静态类型与客户端工具链一致，HTTP 生命周期完整；代价是后端保留两套类型、适配和工程设施。当前目标的长期后台重心使 Python 更合适，这属于架构判断，不是 Python 普遍优于 TS |
| TypeScript + NestJS | 模块和依赖注入可以规范入口组织；仍需额外约束数据库与跨语言边界。其框架模块不能替代领域所有权，为当前需要增加一套业务后端模型没有足够收益 |
| Hono | Web 标准、跨运行时和薄入口有实际价值；当前控制面固定为有状态后台服务，不需要以边缘运行时通用性换取自行组合更多服务端约定 |
| Java/Kotlin 或 Go 控制面 + Python 计算 | 能很好地构建业务后端，但增加第三种主要开发语言与工具链；当前没有必须依赖其运行特征的要求 |

Fastify 可通过自定义验证/序列化编译器或受约束的 Schema 子集支持所需协议。其默认 Ajv 与 `fast-json-stringify` 的方言组合需要核对，**不能写成“Fastify 不支持 OpenAPI 3.1，所以只能换语言”**。这个问题可解决，只是不消除双后端语言的维护面。[Fastify 编译器接口](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[默认响应序列化器](https://github.com/fastify/fast-json-stringify)。

最强反对意见也成立：独立计算本来就需要跨进程协议，同一种语言不会消除它；Python 缺少语言层面的包私有性，SQL 结果的静态类型也不如某些 TS 查询工具直接。因此选择同时绑定 Pyright strict、import-linter、严格 DTO、数据库角色和真实行为验证。若不愿维护这些约束，就不能声称 Python 是可靠并行开发的方案。

控制面目标为 Python 3.14 标准构建，库采用受支持的稳定系列；计算镜像按各自原生依赖独立锁定版本。具体补丁组合须在实现时核验，本文未安装或运行该组合。[Python 支持周期](https://devguide.python.org/versions/)。

## 3. 契约与存储：明确表达边界，减少隐式行为

选择各域的 Pydantic 传输模型作为作者来源，导出 OpenAPI 3.1 与 JSON Schema 2020-12；TS 使用 `openapi-typescript` 和 Ajv2020。没有再引入一套独立手写 Zod 模型。采用可移植 JSON 子集，明确严格校验、缺省、额外字段、金额与时间；自定义业务判断不能伪装成 Schema 已经覆盖的通用约束。

这比手写原始 JSON Schema 再生成整个后端更贴近命令和工具的实际实现，同时保持语言中立的发布协议。代价是需要生成物漂移检查和两种语言共同的正反样例；Pydantic 的验证模式与序列化模式必须区分，不能宣称导出一次便自动一致。[Schema 模式](https://pydantic.dev/docs/validation/latest/concepts/json_schema/)、[严格模式](https://pydantic.dev/docs/validation/latest/concepts/strict_mode/)、[OpenAPI 类型生成](https://openapi-ts.dev/introduction)。

**业务库选择 PostgreSQL 18。** 短事务、唯一约束、并发锁、权限与可恢复备份直接支撑正式状态；关系查询、全文和 pgvector 能减少附加存储服务。文档型数据库作为唯一权威会使关系与跨对象不变量更多落到应用代码；分布式 SQL 需要额外的故障和成本理由；设备 SQLite 不适合替代服务端的统一接纳权威。18 的支持窗口是新设计基线的理由，各基础服务的内部库仍各自服从兼容矩阵。[支持政策](https://www.postgresql.org/support/versioning/)、[pgvector](https://github.com/pgvector/pgvector)。

**访问选择 SQLAlchemy 2.1 Core + psycopg 3，迁移选择 Alembic。** Core 的 Table、SQL 表达式和显式事务满足本系统，不默认使用 Session 对象图。ORM 的自动刷新、过期加载与级联会增加模型写代码时需要记住的隐含前提。行结果在适配器内转为具名 DTO，承认这里仍需要显式映射与数据库验证。[SQLAlchemy Core](https://docs.sqlalchemy.org/en/21/core/index.html)、[Session 行为](https://docs.sqlalchemy.org/en/21/orm/session_basics.html)。

Alembic 与 SQLAlchemy 的元数据配合，无需额外维护另一套查询/迁移模型。各域拥有迁移目录、明确依赖和不可变历史，发布时只有一个实际执行者。自动生成结果必须审查，多个并行分支仍需合并与验证。Kysely、Drizzle 和 Prisma 都是可行 TS 选择；没有因为某个新候选版本处于 RC 就否定其稳定系列，也没有混用两个工具分别生成同一数据库结构。[Alembic 分支](https://alembic.sqlalchemy.org/en/latest/branches.html)、[autogenerate 限制](https://alembic.sqlalchemy.org/en/latest/autogenerate.html)。

## 4. 耐久后台：Temporal 是唯一执行恢复权威

选择 Temporal 是为了将长时间等待、失败恢复、受限扇出、取消和在途 Worker 版本放到一个明确系统中。业务 outbox 只做可靠交接；计算队列、agent 运行库和设备命令日志都不能另行决定同一工作的恢复进度。[Activity 语义](https://docs.temporal.io/activity-definition)、[Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)。

**DBOS 是最强替代，而不是被忽略的简化选项。** 它能以应用加 PostgreSQL 提供耐久执行，支持分布式队列与不同语言应用协作，生产集群有 Conductor 协调恢复。若重心是少量应用进程的事务后台，它可能更省。当前要求将独立计算池、长期在途工作和执行版本治理视为长期常态，因此接受 Temporal 独立服务的运维成本。[DBOS 架构](https://docs.dbos.dev/architecture)。

普通队列可以分发任务，但采用它们后，长时间人类等待、运行版本和跨步骤恢复中的更多机制需要由项目定义。这里不同时保留 pg-boss/BullMQ/Celery 与 Temporal 管理同一类工作，也不建设自有通用工作流 DSL。

代价是明确的：正式 Temporal Server、独立持久化、监控、历史大小管理、旧 Worker 排空和恢复演练。它不保证外部收费接口恰好执行一次；预算、效果身份及未知结果核对仍是业务宿主的责任。[自托管部署](https://docs.temporal.io/self-hosted-guide/deployment)、[运行限制](https://docs.temporal.io/workflow-execution/limits)。

## 5. Agent：Pydantic AI + TemporalDurability

**选择实际的 Agent 循环与原生耐久集成，不自行开发另一个 agent 引擎。** Pydantic AI 负责模型与工具的多轮协作、结果建模及提供方适配；Temporal 保存可恢复步骤。动态调用的每一次收费与写入仍经过平台准入，学习结论仍由领域接纳。

选用稳定 v2 的 `Agent` 和 `TemporalDurability`，不用已弃用包装，也不以 0.x Harness 能力作为必须依赖。稳定版允许新增消息/事件种类，因此适配器必须处理未知项、固定版本并检查保存历史。嵌套 agent 采用原生 Child Workflow 路径，避免把完整子循环作为一个失败后从头执行的 Activity。[版本政策](https://pydantic.dev/docs/ai/project/version-policy/)、[Temporal 集成](https://pydantic.dev/docs/ai/capabilities/durable_execution/temporal/)。

| 替代 | 真正优势 | 本设计的取舍 |
| --- | --- | --- |
| LangGraph | 显式图、持久线程、人工介入和 checkpoint 历史适合复杂 agent 状态图 | 可以独立成为运行权威；同时启用其 checkpointer 与 Temporal 恢复相同循环会增加状态协调。将其降为无持久图，或让它接管所有通用后台，又需额外集成。当前选择已有原生 Temporal 步骤集成的运行库 |
| Pi / Vercel AI SDK 等 TS 运行库 | 工具循环、提供方适配与 TS 应用结合自然 | 若选择 TS 后端值得考虑；当前 Python 控制面下，需额外证明逐步耐久、跨语言工具与保存历史的组合收益。没有因为旧项目使用 Pi 就继续保留 |
| 自研 agent loop | 可以完全决定行为 | 需要长期维护工具协议、流式事件、模型差异和恢复集成；没有必要为这些通用能力再造一套内核 |

LangGraph 的持久化确有线程、状态和子图 checkpoint 机制，不能把它描述成“只有图、没有恢复”。不选它来自整体状态所有权的取舍。[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)。TS 替代方案也有完整工具循环能力，当前选择没有把这一点算成 Python 的独占优势。[Vercel AI SDK Agents](https://ai-sdk.dev/docs/agents/overview)。

原有能力以如下责任划分延续：**会话与分支属于 teaching；动态模型—工具循环属于 Agent；执行恢复属于 Temporal；长期记忆属于相关领域；Skill 是版本化能力包；MCP 是工具连接协议；主动备课是有预算的领域工作。** 这样可以增加更强 agent，而不让其私有会话格式成为整个学习产品的骨架。

自有部分仍然存在：会话追加/分支、授权、根预算、来源、工具代理、SDK 格式适配和学习结果接纳。这些属于产品语义。Pydantic AI 不是替代所有产品代码的框架，也不能证明所有旧提供方鉴权方式自动兼容。

## 6. 计算和插件：普通 Worker 为主，Ray 有明确使用条件

默认选择 Python OCI Worker，按 CPU、GPU、模型 I/O 和不可信扩展划分资源池。科学计算使用合适的成熟算法库，由具体方法包固定依赖；不因为 agent 支持工具，就把统计拟合、搜索、优化或符号验证改成 LLM 提示词。

**独立作业增加时扩 Worker；单个作业需要跨节点数据分布、任务放置与紧耦合并行时选 Ray。** Ray 的作业身份与对象存储检查点接入统一执行协议，Temporal 仍拥有业务工作的继续与停止。资源标签仅用于调度，实际 CPU、内存及设备限制由运行环境实施。[Ray 资源](https://docs.ray.io/en/latest/ray-core/scheduling/resources.html)、[Ray 作业提交](https://docs.ray.io/en/latest/cluster/running-applications/job-submission/doc/ray.job_submission.JobSubmissionClient.submit_job.html)。

不将 Ray 或 Kubernetes 变成每个安装必需的服务；也不在 API 进程直接运行重计算。这是根据工作负载选择运行方式，不能改写成版本里程碑。

**第三方可执行插件默认 OCI + gVisor + 能力代理。** OCI 容纳 Python/原生科学依赖；WASM 并非所有此类库的自然宿主。普通容器共享内核，不能单独承担这里需要的隔离；gVisor 增加隔离层，仍需正确配置挂载、网络与资源。非受信任 GPU 代码使用单独受隔离机器/VM，默认不进入共享 GPU 池。[gVisor 安全模型](https://gvisor.dev/docs/architecture_guide/security/)。

插件清单声明输入、输出、版本、扩展位置和所需能力；实际权限由宿主求交。工具不能获得数据库凭据或任意网络出口；需要的读取与效果由代理办理。UI 默认使用可携带语义表示，Web 特殊交互使用沙箱 iframe，原生端采用宿主渲染。插件自由止于其公开契约，新的业务语义仍要明确设计。

## 7. 客户端与同步：React / Expo + PowerSync / SQLite

**Web 选 React/Vite/TanStack Router，原生移动端选 React Native/Expo，桌面用 Web/PWA。** 登录后的资料工作区和离线会话没有推导出 SSR 或 SEO 必需条件，因此不让一个全栈页面框架同时拥有业务 API。两端共享协议、命令状态机和同步适配，保留适合各自设备的 UI。[React Native 的框架建议](https://reactnative.dev/docs/environment-setup)、[Vite](https://vite.dev/guide/)、[Router 类型约束](https://tanstack.com/router/latest/docs/framework/react/guide/type-safety)。

Flutter 是有力的跨端选择，但此处会再引入 Dart，且桌面资料交互与移动作答仍需分别设计；双原生 Swift/Kotlin 会扩大独立实现面；仅 Web 无法完整替代原生设备集成。React/Expo 的取舍是减少非 UI 的重复实现，不承诺“一份界面跑遍所有端”。

**同步选 PowerSync Open Edition：PostgreSQL 受控读面下行到设备 SQLite。** 已有 Web 与 React Native 的持久 SQLite SDK，且内部 bucket 存储可使用 PostgreSQL，避免另加 MongoDB。按实际发行版核对许可与功能；不依赖企业自定义写检查点。[客户端](https://docs.powersync.com/client-sdks/overview)、[自托管](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances)、[许可](https://powersync.com/legal/licensing-terms)。

| 替代 | 为什么没有选择 |
| --- | --- |
| Electric | 可以向 Expo 同步；当前官方集成尚需补齐统一持久本地层。此需求下 PowerSync 的现成 SQLite 路径更直接，不声称 Electric 不能做离线 |
| 自研全量/增量同步 | 可以完全控制协议，但要长期承担快照、一致检查点、断线恢复和设备数据库状态，不值得重建这些通用机制 |
| 全系统 CRDT | 能合并操作，不能自行决定一个评分、目标或学情应该何时成立；正式业务状态仍需接纳规则 |

Electric 的对照依据是其 Expo 文档与示例，而非历史版本印象。[Electric Expo](https://electric.ax/docs/sync/integrations/expo)。

**代价是自有命令上行与两库衔接。** 同步库只读；草稿、命令日志与乐观覆盖层放入独立 SQLite 实例。服务器接受回执和同步检查点表达不同事实，客户端按同一部署纪元下的命令/对象版本对账后才能清除覆盖层。若使用默认行级 CRUD 上传，会把同步写入与正式提交混为一谈，因此这里有意承担这一小块产品协议，而不重写下行复制。[一致性](https://docs.powersync.com/architecture/consistency)、[本地表](https://docs.powersync.com/client-sdks/advanced/local-only-usage)。

## 8. 其余选型也有明确边界

| 项目 | 明确选择与依据 | 接受的代价 / 不选择的默认方向 |
| --- | --- | --- |
| 对象存储 | S3 兼容接口，原件与大产物不可变引用 | 需验证实际使用的操作、完整性与保留规则；不以已有某云桶作为选型依据，不把大文件塞进业务表 |
| 检索与记忆 | PostgreSQL 全文/pgvector，来源与领域有效性在查询时检查 | 索引可重建；不增加 Mem0 事实权威或默认独立向量数据库。中文分词、向量模型与检索质量需按真实材料评估 |
| 认证 | OIDC，原生授权码 + PKCE，Web 安全会话 | 身份提供方为部署输入，业务只接收验证后的主体；不自研登录协议、不将提供方 token 当领域授权 |
| 可观测性 | OpenTelemetry 与独立业务运行/费用记录 | 诊断后端可替换；日志不能承担正式回执。默认关联身份、耗时与费用，原文留在受控业务产物中 |
| 恢复 | pgBackRest/WAL + 对象备份 + 不随应用库回退的必要控制记录 | 必须跨应用库、Temporal、对象及外部效果对账；“备份成功”不等于恢复后业务正确 |
| 运行部署 | Linux OCI，Docker Compose 描述控制面；远端 Worker 独立接入 | 承担 Temporal 与 PowerSync 的常驻成本；没有要求 Kafka、Redis 或 Kubernetes 才能运行 |
| 工程组织 | uv/Pyright/Ruff/import-linter；pnpm/TS strict；Nx OSS 任务图与 TS 边界 | 两种语言各自维护检查；不用付费 Conformance 代替缺失的 Python 约束 |
| 验证 | pytest、Vitest、真实 PostgreSQL、Temporal 历史重放、Playwright 与实际移动端 | 机制正确和算法质量分别证明；不从类型通过推导学习结果可靠 |

相关机制依据：[pgvector](https://github.com/pgvector/pgvector)、[OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html)、[OpenTelemetry](https://opentelemetry.io/docs/concepts/signals/)、[pgBackRest](https://pgbackrest.org/user-guide.html)、[import-linter](https://import-linter.readthedocs.io/en/stable/)、[Nx 边界范围](https://nx.dev/docs/features/enforce-module-boundaries/)。具体供应商、硬件与模型不是所有权边界；没有现实部署和数据评估依据时，不虚构某家厂商或某个模型已经最优。

## 9. 自有机制必须保持有限

成熟框架不会替本产品回答“这条结论还能不能成立”“这次工具调用是否已获授权”“用户离线写的内容何时可以删除”。因此仍保留五类自有机制，每类有明确所有者和小接口：

| 自有机制 | 所有者 | 普通作者只需要调用什么 |
| --- | --- | --- |
| 命令接纳、回执与 outbox | 领域应用入口 / jobs | 提交具名命令、查询回执 |
| 证据、版本守卫与候选接纳 | 来源领域 / consistency | 读取带来源的输入、递交候选；不手写锁序或传播算法 |
| 预算、能力与外部效果准入 | execution | 请求具名能力，接收完成/拒绝/未知结果 |
| 离线命令日志与覆盖层收敛 | 客户端共享包 | 保存本地意图、展示同步状态；不手写数据库复制 |
| 会话与 SDK 的适配 | teaching / agent-runtime | 版本化定义、消息和工具结果；不编写另一套耐久 agent 引擎 |

这些机制的实现、检查规则和基准由少量高质量审查维护。低成本模型主要扩展方法、工具适配、局部领域职责与客户端界面；它们不能修改共享不变量来让自己的测试通过。并行任务由稳定契约解耦，具有独立写入范围和运行环境；依赖同一契约或迁移的任务仍需协调。

若事实表明一个新插件必须修改这五类机制中的多个、需要了解整个会话和恢复历史才能工作，说明边界设计失败，应该修改接口，而不是再增加一页提示词规定。这是本次选型应接受的反证。

## 10. 结论的证据边界

已经完成的是官方能力与限制核对、替代方案比较、独立架构复核和文档一致性检查。尚未完成的是依赖组合安装、运行压力、恢复故障注入、真实设备同步和低成本模型并行开发对照。架构文档列出了具体反证场景；它们是实现的证明责任，不是版本计划，也不应被写成已通过。
