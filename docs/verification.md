# 验证记录

## 2026-11-16 单元 0

- 已核对 K01–K08 的规格位置、两种完整设计和 20 个共同场景。
- 独立静态审查发现等待见证与领域时间缺口，已修复并加入 S19、S20。
- `git diff --check` 通过，文档相对链接检查通过。
- 未运行内核、数据库、模型或真实学习旅程。两种实现尚未选型。

## 2026-11-16 单元 1

- `pnpm typecheck` 通过。
- `pnpm test` 通过 4 项测试，覆盖 PGlite 参数绑定、tick、回滚、跨作用域插入拒绝和 pg 事务生命周期。
- `MANGEKYO_TEST_DATABASE_URL=... pnpm test:pg` 通过 2 项真实 PostgreSQL 测试，覆盖跨连接互斥、提交可见性、独立学习者 tick 和回滚。
- 测试环境为本机 Docker 容器 `mangekyo-dev`，PostgreSQL 18 Alpine，仅监听 `127.0.0.1:55432`。
- 初次 pg 测试错误地期待读取未提交行，已修正为观察第二个写入在锁释放前未完成。修正后通过，没有把该失败实现误判为数据库缺陷。
- 尚未实现单元 2 的完整 schema、声明 API 或模块加载。

## 2026-11-16 单元 2

- 已实现事实、命令、槽位与推导器声明，受限 `ctx`/效果工具类型，目录加载和最小手写模块。`kernel/test/fixtures/minimal/` 是加载样例，不是已交付的学习领域模块。
- `kernel/src/schema.ts` 按内核规格建立 10 张表及学习者作用域外键；`applyKernelSchema` 是全新数据库的幂等建表入口，重复调用不删除数据，尚未声称支持版本迁移。
- 发现 `@mangekyo/kernel` 根入口和 `./db` 会把数据库适配器暴露给模块，现已将公共声明包限制为纯 JS/类型声明入口，不含 Db；Db 与执行适配器仅供内核及执行环境使用。
- 独立审查指出函数式 `tools.effect` 会让模块直接执行任意效果，且与单元 0 的声明式效果请求矛盾。已把 gather 改为返回 `{kind:'input',data,effects}`；效果由内核在快照外执行，回执并入固定输入。
- 包边界夹具先因继承仓库 `include` 而没有验证到包 exports；已改为独立消费方，使用临时目录内的实际打包安装验证 Db 导入被拒绝。
- `pnpm typecheck`、`pnpm test:boundary` 通过。
- `pnpm test` 通过 13 项，覆盖声明校验、受限上下文类型、实际目录加载、重复/非声明/额外导出拒绝、PGlite 建表和 Db 回滚/作用域。
- `MANGEKYO_TEST_DATABASE_URL=... pnpm test:pg` 通过 4 项，覆盖跨连接锁与回滚、完整建表、幂等重入、作用域外键及 effective 推导缺 tick 的数据库约束。
- PostgreSQL 测试曾共享 `public`，出现 `cannot drop table learners because other objects depend on it`；为各测试建立并删除独立 schema，不用 `CASCADE` 删除另一组测试的内核表。schema 初始化失败也已修复为管理连接建 schema、业务连接显式设置 search_path。
- 开发依赖：Node 26.10.0、pnpm 10.33.0、TypeScript 6.0.3、Vitest 5.1.0、zod 4.6.7、PGlite 0.5.16、pg 8.23.1。真实 PostgreSQL 仍为本机 `mangekyo-dev` 隔离容器，非 TEST。
- 独立静态审查已完成。已修复声明包的 Db 导出、效果回调、读取 access epoch 和回执状态；对审查提出的跨学习者外键顺序推断补了真实反例，当前外键能拒绝跨作用域修订，没有按错误推断改坏约束。目录加载器仍只证明声明加载，不证明模块代码沙箱；静态 import 检查、gather 进程隔离和 provider 网关由后续单元承担。
- 尚未运行命令执行、推导传播、模型或真实学习旅程。

## 2026-11-17 命令执行子系统与混合 fleet

实现范围与六路派发结果见 [fleet 记录](fleet-experiment.md)。本轮继承单元 0–2 的未提交工作，没有将既有内容归为本轮新增。

- `node node_modules/typescript/bin/tsc --noEmit` 通过；`tsc -p kernel/tsconfig.build.json` 构建通过。
- 最终标准入口 `pnpm typecheck && pnpm test && pnpm check:structure` 全部通过；本地 Vitest 共 10 文件、66 项，包含跨模块重复事实所有权的启动拒绝反例。
- 真实 PostgreSQL：3 文件、10 项通过，含本轮 6 项命令测试及原有 4 项 Db/schema 测试。覆盖八路同 ID 重放、不同内容同 ID 争用、不同 ID 的真实重复提交、登记写入后失败的整体回滚、八路 AI 提议重放和同 revision 并发更正。
- 数据库仍为只监听 `127.0.0.1:55432` 的任务专用 `mangekyo-dev`，非 TEST。仅使用每项测试自己的 schema；未操作 TEST 或旧项目数据。
- `node kernel/test/package-boundary/check.mjs` 通过：实际 tarball 安装消费方可编译、可运行，Db 私有入口被拒绝。
- 生成器最终版本新建 `acceptance-final` 和替代方法；消费实际 kernel tarball，未使用 source paths 映射，类型检查通过，4 项样例通过。样例调用真实 `slot.key(...)` 再传给 gather。另有旧生成样例 4 项通过，不将其计作真实产品能力。
- 生成器真实目录加载得到 1 事实、1 命令、1 槽位、2 推导器。结构检查在仓库及生成模块均通过；生成器覆盖/路径/故障清理反例通过。
- 独立审查前后共发现并修复六项 P2，末轮三项定点复核全部通过：按名字误索引类型、无效声明回调、退出命令无法重放、空用途无法恢复、用途修改重跑 schema 转换、生成器槽位 key 断点。主代理另外修复生成器故障清理、sticky 保留、无效 writes 静默成功和跨模块重复事实所有权。
- `git diff --check` 通过。现有 AGENTS 文件没有修改；只有生成器的字符串模板会在新模块中生成说明。

### 保留的失败

- 沙箱下 pnpm 启动器联网验签失败：`ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE`。允许访问官方注册表后启动与包边界检查成功；最初的本地检查直接调用已安装的 TypeScript/Vitest。
- 首次 canonical/reads 草稿合测 6 项失败：undefined 被丢弃；SQL 参数类型冲突；用途样例错误；无效 JSON 在数据库边界先被拒绝。修复实现和不正确夹具后通过。
- 首次 PostgreSQL 并发套件 1/9 失败：用 JSON 字符串比较 JSONB 回执，因对象键顺序不同误判；改为逐个深度比较完整回执，重跑通过，事实/修订/tick/登记数量断言保留。
- 最初用 Node test runner 运行了子代理写成 Vitest 的结构检查测试，runner 不匹配失败；统一接入 Vitest 后 20 项通过。
- writes 工作面的隔离失效、中止、测试恢复与主代理接管见 fleet 记录。不能将该 lane 记为成功的独立交付。
- 原始检查输出摘录（含失败与成功）保存在 本机的 `docs/evidence/fleet-checks.jsonl`，其余过程留在本会话工具记录中。没有隐藏失败或将后续成功伪称为一次通过。

### 未验证与后续工作

未完成生产传播/生效/需求调度、队列库选择、完整 gather manifest、提议确认/拒绝、采纳/撤销、效果账本、Python worker、模型、HTTP/Web 或真实学习旅程。必填 `onFactsChanged` hook 仅证明事务接线，未宣称这些行为已经实现。A/B 内核比较和公共接口冻结仍在单元 25。

请求模型组已记录；每个实际后端、费用和耗时未完成可靠归因，标记 UNKNOWN，不据此给出 fleet 性价比结论。副本隔离失败说明当前还不能把规模扩展当作已验证能力。

## 2026-11-17 测试预算收敛（当日状态）

Owner 重申测试比例不超过 10%。上节的 66/10 是历史运行结果，不能再当作现行套件规模。

- 口径：测试代码 /（生产代码 + 测试代码），统计 TS/JS 非空行。夹具、测试基础设施、预算检查脚本自身和生成器内嵌测试样例全部计入测试；文档、证据、依赖、构建产物不计。当前 **253 / (2,364 + 253) = 9.67%**。
- `pnpm test` 与 `pnpm test:pg` 前置 `check-test-budget`；超限返回非零。额外用只有测试的临时目录验证，比例 100% 时被拒绝。
- 删除了声明、目录加载、schema 和工具的重复/常规测试。数据库夹具与关键命令不变量合并为一个共用套件，分别在 PGlite 和 PostgreSQL 执行。生成器保留固定正反样例，包边界仍使用实际 tarball 安装消费方。没有增加生产能力凑分母，也没有将删除的测试改名后继续维护。
- 仍维护的重点：幂等与真实重复提交、旧修订可读、学习者更正的 sticky、用途收窄阻止旧值读取、并发更正的单一胜者、事实/登记/回执/tick 同事务回滚、AI 提议与重放身份、防跨学习者插入、生成器失败不删除既有代码、包 exports 拒绝 Db。
- 当前标准 `pnpm typecheck && pnpm test && pnpm check:structure` 全部通过；本地 2 文件、6 项，真实 PostgreSQL 1 文件、5 项通过；实际打包边界检查通过。
- 精简后的新模块与替代推导器已在临时目录生成、通过类型检查和样例执行（本轮新增 2 项；临时目录含历史样例时合计 10 项，不计入仓库现行测试数）。
- 已删除的精细回归断言不再自动维护；上节独立审查和已运行证据保留为历史记录，不能代替未来变更的验收。10% 是预算约束，不表示测试覆盖率。

## 2026-11-18 单元 40 与教研室

本地 PostgreSQL、Temporal 和真实 LLM 首次联合运行。验证记录包含中断恢复、版本诊断、两个真实教学分支、浏览器及设置面板。[验收记录](evidence/unit40/README.md)

## 2026-11-18 四个产品入口与流式同伴

Chrome 在手机和桌面尺寸完成文字交入、目标、讲义、练习与自由对话。独立进程通过 PostgreSQL 推送真实模型的中途正文。合入后类型、结构、生产构建、打包消费检查均通过，常规测试 11 项、PostgreSQL 测试 8 项通过。[复验记录](evidence/product-shell/README.md)
