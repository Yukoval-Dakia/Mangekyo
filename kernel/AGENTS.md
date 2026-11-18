# Kernel

- 内核是事实、推导和内核状态的唯一写入者。模块只能经公开上下文请求操作，不能导入 Db 或内部文件。
- `Db` 只暴露给内核与执行环境。所有学习者领域写入经 `tx({learner}, ...)` 和 `withLearnerWrite`。每次回调节点只写一个学习者。
- `withLearnerWrite` 在事务内锁学习者行并推进一次 tick。回调里不运行模型、推导、子进程或外部 I/O。
- 用 `tx.insert` 写带 `learner_id` 的行，适配器拒绝跨作用域插入。参数化 `query` 是底层逃生口，不能用来规避内核领域协议。
- Tick 在 TypeScript 和 JSON 中是十进制字符串。数据库 `bigint` 不转 Number。
- PGlite 用于局部状态验证。锁竞争、连接隔离和并发必须在真实 PostgreSQL 验证。
- 先读 `docs/kernel-design.md` 和 `docs/implementation-contract.md`。契约变更单独交付，不在填充任务里顺手修改。
