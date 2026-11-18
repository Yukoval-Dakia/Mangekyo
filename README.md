# Mangekyō

一位学习者的私人教研团。可以从[产品概览](docs/product-overview.md)了解题库、个人教材、课堂和试卷如何配合。

## 在本机打开 Mangekyō

从**今天**进入自己的材料、当天安排、笔记和练习。可以导入课文、PDF 或照片，在材料页核对识别结果，选段让同伴备课，保存笔记和自编小卷，再独立作答、回看错题或打印。**我**里可以留下教学偏好，让下一次同伴对话接着用。[学生工作区与旧 TLP 的实现对照](docs/evidence/student-workspace/README.md)

普通同伴对话通过 SSE 接收所选模型的公开正文增量。诊断示例「同一个 45，两份不同的学习史」位于材料中的「示例课堂」。这里会先显示阅读、核对阶段，再呈现经过验证的题目与教研依据。已有会话的旧链接可以继续使用。[浏览器实测与两份真实教学记录](docs/evidence/product-shell/README.md)

照片识别和 PDF 文字提取使用 macOS 的 Vision、PDFKit 和本机 Swift。原件默认存于当前用户的私人数据目录，设置 `MANGEKYO_INTAKE_DATA_DIR` 可指定位置。其他系统可以导入 UTF-8 文本或手动补充原件文字。

本地开发使用 Node 26、pnpm 10、PostgreSQL 和 Temporal CLI。为这个项目准备独立的本地数据库，设置 `MANGEKYO_DATABASE_URL`。服务默认在该库的 `mangekyo_studio` schema 建表并写入示例。先启动持久化的开发用 Temporal 服务。

```sh
mkdir -p "$HOME/.local/share/mangekyo"
temporal server start-dev --ip 127.0.0.1 --port 7423 --ui-port 8423 \
  --db-filename "$HOME/.local/share/mangekyo/temporal.db" \
  --dynamic-config-value frontend.workerVersioningWorkflowAPIs=true \
  --dynamic-config-value frontend.workerVersioningRuleAPIs=true \
  --dynamic-config-value system.enableDeploymentVersions=true
```

在另一个终端启动应用。

```sh
pnpm install --frozen-lockfile
MANGEKYO_ACTIVATE_LOCAL_BUILD=1 pnpm dev
```

打开[本机应用](http://127.0.0.1:4317/today)。在「模型设置」保存多套模型配置，每套指定服务地址、协议、模型、思考强度和可选密钥。默认使用本机 Magpie 的 DeepSeek 4.1 Flash（high）。支持 OpenAI 兼容的 Chat Completions 和 Anthropic Messages。可为同伴对话、材料备课、诊断教学和试卷批改分别选模型，或跟随当前配置。远程端点使用 HTTPS，本机支持 HTTP。服务端保存密钥，浏览器只显示配置状态。

在同一面板添加采用 Streamable HTTP 的 MCP 服务，点击「从服务读取工具」并勾选允许的项目。在同伴的输入框旁选择本轮可调用的服务；对话里的「本轮信息」记录工具名和返回内容。每轮重新选择。开放题评阅使用评分约定允许的内建工具。[跨协议与工具实测](docs/evidence/study-agent/harness.json)

要复验外部工具，可选一个返回已知回执的只读工具，用下面的命令新开真实同伴对话。预期回执仅供验收脚本核对，问题中应省略回执。

```sh
node runtime/studio/test/mcp-acceptance.mjs http://127.0.0.1:4317 服务ID 工具名 本轮问题 预期回执 --live
```

同伴答疑、从材料备课与试卷的 LLM 判分使用多轮工具调用。Python 使用本机 Docker 中的 `python:3.12-alpine` 镜像，首次使用前运行 `docker pull python:3.12-alpine`。每次调用在无网络、无宿主挂载的容器中执行。每轮有独立的临时文本文件，供模型和 Python 交换数据。「模型与工具」可开启 Exa 的公共额度或填写单独的 API 密钥。带材料、备忘或历史的对话需要检索时，在当前消息中另起一行写「公开检索：主题」。模型端点需支持所选协议的流式回复和工具调用。

在试卷中添加「评分标准」题，填写题面和评阅标准，交卷后点「发送本题并批改」。标准写明「总分 3 分」等数值总分时，模型按标准逐项给分，系统核对分值范围和满分合计。系统核对原答引用，保存评阅方法版本、来源和工具记录。可在批改前单独填写允许发送给 Exa 的公开主题。[真实评阅与工具记录](docs/evidence/study-agent/observed.json)

复验 LLM 判分可运行 `node runtime/studio/test/assessment-acceptance.mjs http://127.0.0.1:4317 --live`。它会在指定本机实例新建一份开放题试卷，通过正式交卷与评阅入口检查部分得分、原文引用、Python 结果、重复请求和重新打开。

打开服务后，`pnpm verify:teaching --live` 会通过同一个 HTTP 入口新建两份会话并调用模型，检查读取原作、追问或跳过，以及对明确错步的回应。传入两个已有会话 ID 可以只读复验。这两种用法都会打印当轮依据和回答。[验收与实例](docs/evidence/unit40/README.md)

`pnpm studio:serve` 可启动已构建的前后端。设置 `MANGEKYO_PROCESS=web` 可单独接收命令，`MANGEKYO_PROCESS=worker` 可单独运行交接和 Worker。开发构建按源码指纹固定版本；发行环境应使用唯一构建 ID、显式管理版本流量，并保留仍有在途任务的旧 Worker。保存模型设置后，新会话使用对应配置。续聊时会核对原会话绑定的模型和端点，切回原配置即可继续。[Temporal 适配器](executors/temporal/README.md)

## 当前实现

- 单元 40 的本地验收涵盖版本化数据库迁移、事务内登记工作、幂等交接、真实 Worker 被杀后的恢复、版本隔离、迟到结果和未知外部效果。[运行证据](docs/evidence/unit40/README.md)
- 教研室是第一项智能验收。自由对话和起步课堂已接入产品导航。四页真实拍卷、个人化排课、跨设备和删除生命周期仍按工作单推进。[工作单](docs/BACKLOG.md)
- 从旧 TLP 的实现记录和愿景中盘点了 73 项候选，Mangekyō 纳入 70 项、部分纳入 1 项、排除 2 项。学生在新版怎样使用这些能力，见[产品概览](docs/product-overview.md)；范围和验收见[功能去向](docs/feature-disposition.md)。
- 产品行为以 [PRD](docs/PRD.md) 与[产品规格](docs/product-spec.md)为准，内核实现遵循[内核规格](docs/kernel-design.md)与[实现契约](docs/implementation-contract.md)。较早的命令、边界和生成器检查见[历史验证记录](docs/verification.md)。
