# 混合 fleet 首轮开发记录

2026-11-16 至 2026-11-17。目标：在已有单元 0–2 基础上交付内核命令执行子系统，准备可复用的并行开发骨架。没有复制旧项目代码，没有部署或发出外部消息，没有提交仓库内既有未提交修改。

## 分工与结果

同时启动六个新上下文子代理，每个分配独立 `/tmp/mangekyo-fleet/<lane>` 文件系统副本，主代理独占集成仓库。未创建 Git worktree，副本保留当时尚未提交的完整设计与实现。

| 工作面 | 请求路由 | 交付 | 结果 |
| --- | --- | --- | --- |
| handle | group/powerful, high | 命令入口与规范化 JSON | 接受，经具体反例修正并集成 |
| writes | group/powerful, high | 事实修订写入 | 隔离失效后停止；主代理恢复测试并接管修复 |
| reads | group/flash, high | 事实读取、用途与学习者边界 | 接受；草稿测试失败后修复并集成 |
| structure | group/flash, high | AST 依赖检查与行数检查 | 接受；修正内部相对引用和跨模块边界 |
| generators | group/flash, high | 模块与替代推导器生成器 | 接受；主代理修复失败清理删除既有目录的风险 |
| review | group/powerful, high | 独立审查与反例矩阵 | 发现并修复加载索引、声明验证与退休命令重放问题 |

运行时目录确认两组支持 high；派发前检查组成员，未包含 Astra。本记录证明请求路由和实际工具结果。未取得每个最终 assistant response 与 routing log 的完整一一关联，**不把组名或子代理自报当作实际模型/vendor 证明**。本轮实际后端与成本完整归因为 UNKNOWN，未据此计算速度、成本或模型质量排名。

## 隔离失效

观察到 writes 实现出现在主仓库，而其分配副本没有该文件；主仓库的测试夹具和集成测试也被移除。立即中断并关闭该子代理，从主会话原始工具输入恢复完整测试，再由主代理修复类型错误、无效写入形态的放行、sticky 被用途变更清除等问题。源码、测试和 PostgreSQL 验收随后重新运行。

子代理记录中存在带 `/tmp` workdir 的命令请求，尚未确定从请求到实际文件变更之间为何越界。故结论是**实际隔离失效**，不归因为已确认的主观越权。文件副本和文字所有权约定不足以证明写权限隔离。扩大并行前，必须用实际独立可写根和受控补丁集成；当前仓库的主写入者仍为主代理。

六路并行产生了可集成代码，同时需要纠错和接管。此次试验不能证明任意八个便宜模型能稳定独立交付产品能力。

## 可用入口

- `pnpm typecheck`、`pnpm test`、`pnpm check:structure`、`pnpm test:boundary`。
- `MANGEKYO_TEST_DATABASE_URL=... pnpm test:pg`，只对本任务独立数据库运行；测试建立并删除自身 schema。
- `pnpm new:module <name>` 生成模块定义、事实、命令、槽位、确定性推导器、样例和简短 AGENTS 模板。随后正常安装 workspace 依赖。
- `pnpm new:deriver <module> <name> [root] [--slot <slot-type>]` 生成相同 note-length 输入协议的替代方法；其他领域槽位需按其公开输入协议改写样例与实现，不能直接当作通用业务方法。

结构检查只是静态依赖与代码量检查，不是运行时沙箱。生成的 note-length 是工程样例，不是已完成的 capture/content/activity 学习模块。

## 交付边界

命令入口以 learner、命令 ID、类型、原始 JSON、actor、purpose 作为请求。规范化身份包含 actor/purpose，防止相同 ID 换身份或用途重放。已持久化回执在命令定义退出后仍可重放。失败校验、冲突和 hook 失败均回滚事实、命令、登记和 tick。

内部 `CommandHooks.onFactsChanged` 是必填事务接线点，和事实及回执使用同一个 `DbTransaction`；测试实际写入后续登记并验证回滚。生产过时传播、按槽位定义生成 work 和队列租约尚属单元 4；没有提供默默忽略这些工作的默认生产装配，也不宣称整链已闭合。

AI destructive 请求只持久化提议。确认、拒绝、采纳、undo 和效果账本属单元 5，未实现。`ctx.read.slot/range` 明确拒绝未实现读取。命令事实读取不等于已经实现 gather manifest。公共模块声明入口继续不导出 Db 或执行器。

最初的 66 项本地测试、10 项 PostgreSQL 测试是历史运行证据。owner 重申 10% 测试预算后，已合并两种数据库的重复夹具和不变量样例，删除日常声明及工具的重复测试；现行套件与比例见 [验证记录](verification.md)。
