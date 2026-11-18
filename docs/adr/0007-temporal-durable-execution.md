# Temporal 作为唯一耐久执行层

2026-11-17｜accepted，取代 ADR-0004。Owner 采用技术复审推荐：TS 业务内核与模块、Temporal、Python 计算、PostgreSQL/S3、React PWA。复杂会话的恢复、等待、并行与执行版本由 Temporal 承担；自有会话日志不再驱动第二份执行游标。PG 仍独占领域事实、候选生效、用途、预算及未知外部效果账本。

命令与 outbox 登记同 PG 事务；幂等 relay 用稳定工作身份交接 Temporal。它们不是跨系统原子事务。DBOS 的同库方案是评估过的替代，但本次选择独立编排平台来承担恢复责任；不并行接入两种生产引擎。详见[技术复审](../design/technology-review-2026-11-17.md)。能力与行为尚待运行验证，本文不把选型当成实现。
