# Mangekyo 单元 0：候选 B——独立依赖索引传播

2026-11-16。独立架构咨询；候选设计，未经运行验收，不代表最终选型。工作区 `/Users/yuqi/Documents/ChatGPT/Mangekyō` 只读；未访问旧项目、未复制旧代码、未委派。本文件是唯一设计交付，执行、规格整合和最终验收交回主代理。

## 结论与证据边界

建议把 B 作为与“直接查询 manifest 传播”进行同样例实验的完整候选：**manifest 是唯一的输入依据；内核在封存 manifest 的同一事务内生成规范化的直接依赖边与范围订阅，写事务沿这些索引同步传播；生效仍独立逐项核验 manifest。** 不维护传递闭包，不通过消息投递决定正确性，不在模块里加传播器、仓储、索引声明或数据库查询。

先采用下文的最小语义澄清，再比较两种实现。当前不能推荐 B 已经胜过 A：B 有望减少“寻找受影响者”的读放大，但多一份持久索引、更多 WAL 和恢复检查；同学习者行锁、实际受影响子图大小和完整 range 读取成本仍在。

已读 PRD、kernel-design、development-plan、BACKLOG、GLOSSARY、implementation-contract 及 ADR 0001–0006。仓库基线 HEAD 为 `8b39d00e2e203bfb0d33033713b2d306d2945f94`；工作区原本有未提交规划文件，故实际依据是当前文件内容，不以该 SHA 冒充全部文本的版本。相关原文件 SHA-256：

| 文件 | SHA-256 |
|---|---|
| docs/PRD.md | 78f7a9e2b2ff9eaf1939e7289d42a2aad43448d03b29c2cdda2e925e8431d267 |
| docs/kernel-design.md | dcaa96e6041aa1c4267d4b56f7d1e6c71586f636ec22e911f3270c2251d94f37 |
| docs/development-plan.md | 7e164840468f36b84ec46f2487fafb0aede92deeed6aab8525c6386ea3dd6e3b |
| docs/BACKLOG.md | 6cba789ccd4d31660d8aac813ee589a0b51631204f6672b1059a2403f3353e78 |
| GLOSSARY.md | ad3d163aae42f15a9fbf4fb43503b8731268dea539469d81129c984db2b547a5 |
| docs/implementation-contract.md | fc4512735028608f2270cd2ff1c1eb9dcb497588915727f7d9388e061a252b63 |

现状只有设计文档，没有产品代码、队列库、数据库配置或运行测量。下面的表、接口、复杂度和时序是提案；所有 PostgreSQL 并发、崩溃恢复、规模及真实旅程检查均为 **NOT_RUN**。静态阅读不能证明 PRD 的两秒回执、半分钟处理、几秒更正或“始终有内容”。

## 1. K01–K08 对 B 的约束及最小一致语义

| 项 | 现行矛盾／缺口 | 本候选采用的澄清；对 B 的影响 |
|---|---|---|
| K01 | PRD §4.2.3、GLOSSARY:31–38 的固定版本长期有效；kernel:139–145、168 却让事实 pinned 同 following 一起失效 | 普通新修订只使 following 失效；pinned 仍可用该旧事实修订。事实撤回或用途不允许时，pinned 也不能供新计算使用。推导 pinned 不随 superseded 失效，但其自身输入被否定时必须传递 stale。提交更正使用 following；已发题面使用 pinned。索引必须分别存身份失效边、当前指针边、访问策略边，不能把三个事件合并为“版本变了”。 |
| K02 | PRD §7 / ADR 0004 用现成队列；kernel §7 自己实现 claim、租约、重试 | `work` 只存领域需求、等待、合并水位、当前运行身份；库唯一负责领取、租约、退避、进程故障重投。库须支持调用方事务入队，或同事务持久登记且由唯一适配器可靠转交的协议。本候选优先要求同连接事务入队，不实现第二套租约表。 |
| K03 | derive 无 tools / 纯计算，但付费推导需要模型 | 保留纯 derive：gather 先在只读快照取完并封存输入，再在数据库快照与学习者锁外，经受限效果能力取得模型结果；derive 只处理完整固定包。SDK、网络及凭据在执行环境／网关里。动态再读拆子推导或会话；不扩充 Python 纯计算协议的环境权限。 |
| K04 | `work.ticks bigint[]` 又被解释为所缺槽位，未生效对象没有 tick | 替换为稳定的 `WaitTarget`：事实 ID、槽位键或范围表达式，带观察到的版本／代数。登记等待时在学习者锁内复核，再落等待关系；变更同事务唤醒。不比较“未来 tick 是否相交”。 |
| K05 | JSON 中内嵌 `at(now)` 函数不可序列化 | 值存模型名／版本、参数、记忆状态及基准时间；读接口显式接收 `asOfTime`，内核调用该推导器定义内的纯 `evaluateAt(state, time)`。它是推导器的可选方法，不是第五类构件。固定时钟可重现；无事件不日刷。 |
| K06 | undo 新建无前驱，旧命令之后可能已有本人编辑 | 每条命令回执保存写入前后修订和元数据版本。撤销先检查全部目标仍处于该命令写出的版本；全部匹配则新建→撤回，修订→追加前驱内容，撤回／用途变更→追加前态。任一冲突整批不写，返回明确冲突，可由学习者用普通更正命令解决；绝不静默覆盖后续本人编辑。sticky 的“曾手改”历史不倒退。 |
| K07 | effective 被置 stale 后还要求返回 current effective + stale；无公共历史接口 | 当前有效指针和最后一次生效指针分开。失效清空 current，保留 last；读返回 `current`、`stale`、`empty`、`denied` 联合，计算状态与值分离。旧值只用于展示／解释，不能由 gather 当有效输入取走。回溯走内核受用途过滤的接口，模块不查库。 |
| K08 | “全部 ULID”与 uuid 列、效果只认 derivation 身份矛盾 | 领域 ID 统一 ULID 并区分类型；租约 token 是库的不透明内部标识，不冒充领域 ID。效果 owner 是预留的推导运行 ID 或会话步骤 ID；方法版本、固定输入摘要、调用标签一并绑定。done 复用，started/unknown 核对，无法核对不盲重付；不声称 provider exactly-once 扣费。 |

这些是本候选的明确输入语义，不要求 owner 先选择具体库。K06 的“发生后续编辑时怎样自动三方合并”没有既有产品定义；这里选择安全冲突结果。若主代理认为 PRD“所有命令可撤销”要求自动保留任意后续编辑的合并，应提交 owner 定义新结果，而不能暗中采用覆盖。

另有必须同步消除的明显问题：

- kernel:76–106 声称五种模块构件且有独立 slots 目录，和 PRD §5 / 实现契约 §1 冲突。B 把槽位、scope 可用字段、策略、accept、adopt 放进推导器构件；可导出公开槽位类型，但不要求另一份模块登记表。
- kernel:145/169 把“成员在水位内”与“失效事件刻度在水位内”混用。旧成员通常是在水位之后被更正，比较 `ended_tick <= cutoff` 必然漏判；应比较 manifest 中成员身份与其失效状态。
- kernel:146 的“REPEATABLE READ 或单连接”不等价。同一连接的 READ COMMITTED 多次查询可能读到不同提交；gather 必须是真正的只读 REPEATABLE READ 快照。
- kernel:157–173 只有一个 status 和 ended_tick，会丢失“先被正常替换、后来才被否定”的历史。应分开失效时间与选择区间；superseded 旧推导的依赖边也不能删。
- PRD §2.1 把新增判分后的掌握度／安排统称“过时”，§4.2.3 和 kernel §13.3 又要求新证据只 behind。B 把场景“过时”理解为需要更新的产品用语；机制上新证据 behind，更正 stale，二者均可按策略触发备课，用户结果不变。
- PRD §2.1 的“此刻先不算”与 §2.3 的夜间备课不冲突：传播后先记需求；锁屏／不在场且存在备课需求时由工作单启动，不用每天定时扫全量，也不把 lazy 解释为永远不能后台需求计算。
- “不可变推导”约束 value、manifest、方法版本；可变的是内核维护的有效性和选择状态。否则任何 stale 标记本身也会违背不可变要求。

## 2. 引用、失效与新鲜度的共同语义

### 2.1 引用真值表

每次读取都显式携带 learner、actor／使用目的、引用模式。`pinned` 必须显式给出版本，不能偷偷把“当前”当固定引用。

| 输入 | 普通修订／正常替换 | 输入被否定／事实撤回 | 当前用途不允许 |
|---|---|---|---|
| fact pinned `(F,r)` | 继续有效，不改为新修订 | fact 撤回阻止今后的计算；历史仍可由学习者查看 | 拒读、相关产物 stale |
| fact following `(F,r)` | `current_rev != r` 即 stale | stale | 拒读、stale |
| derivation pinned `D` | D 正常 superseded 不影响使用 | D.invalidated 后 stale，传递 | 拒读、stale |
| slot following `(S,D)` | `S.current != D` 即 stale | stale | 拒读、stale |
| slot asof `(S,D)` | D 正常 superseded → behind，D 本体仍有效 | D.invalidated → stale | 拒读、stale |
| range asof `(Q,C,members[])` | 截止 C 后新生效成员／正常替换 → behind | 清单内任何成员后来被否定 → stale，与否定事件时间是否大于 C 无关 | 拒读受限成员，不拿旧包绕过限制 |

固定引用保护的是内容版本，不是免除撤回和权限的永久通行证。事实普通更正不宣布历史修订为假；需要纠正正在使用的作答、目标等，模块按产品语义选 following。这也是为什么题面和提交必须有各自身份。

推导的逻辑状态有两个独立轴：

1. **有效性**：从未失效或已失效；一旦失效不复活，只能产生新推导。
2. **选择历史**：候选、曾在何时被选中、何时被其他答案替换／移除、拒绝、shadow。

因此 D0 可以在 t1 正常 superseded、t2 才 invalidated；固定引用 D0 的后代在 t1 不 stale、在 t2 必须 stale。`behind` 是“这份仍有效的答案没纳入后来信息”，对同一推导单调置位；它不是错误或失效，**不沿依赖边传播**。D0 因自己的 range 新增而 behind，不使固定／asof 引用 D0 的安排自动 behind；当掌握度 D1 真正生效替换 D0 时，安排才 behind。若产品希望提前显示“上游正在补证据”，另附读取元信息，不偷改 behind 定义。

新推导可以引用仍有效但 behind 的截至值，避免连续证据使长推导永远不能生效。被标记 stale 的展示旧值绝不能支撑新结果。一个输出仍可因自己其他输入无效而 stale，stale 对外优先于 behind，但保留两种原因供审计。

### 2.2 来源与采纳不是一条普通失效边

采纳事实获得独立身份。抽取 D 被更好的抽取替换或被上游更正否定，不自动删除、回滚其已采纳事实；新抽取只能通过普通采纳命令请求新修订，sticky 时成提议。否则会破坏“独立后续人生”。

来源撤回要区分：撤回原件使依赖该原件的抽取不能再作为新计算输入；撤回某条已采纳题目／提交则使依赖该事实的判断 stale。原件撤回是否连带撤回独立事实不是现有 PRD 已授权的永久删除语义，不能自动执行。

用途有更严格的保护：派生值与来源事实不能成为绕过“只保存”的通道。内核读取派生值时检查 manifest 祖先的当前用途；采纳命令给新事实保留来源和用途上界，读取它时同样检查该来源的用途上界。该检查只影响可读性／计算有效性，不写新事实、不重写内容。内核将这些用途根作为 manifest 的权限见证和对应策略边封存；源用途收窄能找到间接依赖。学习者查看自己历史与 AI／推导器取数是不同权限。永久删除、离线副本抹除仍属 D06，未在此定义。

## 3. 调用方使用例及公开类型草图

下面是候选接口语义，不是待复制的实现代码；`Submission`、`Grade`、`Mastery` 等来自模块公开类型。槽位元数据属于 `defineDeriver`，不另写第五类构件。

```ts
type Tick = string; // JSON 中的十进制 bigint；计算端用 bigint，禁止 Number 截断
type SlotRef = { learner: LearnerId; type: SlotType; key: CanonicalSlotKey };
type FactRef = { learner: LearnerId; id: FactId; rev: number };
type Scope = { slotType: SlotType; where: EqualityOrContains[] };

type InputRef =
  | { kind: 'fact'; ref: FactRef; mode: 'pinned' | 'following' }
  | { kind: 'derivation'; slot: SlotRef; id: DerivationId;
      mode: 'pinned' | 'following' | 'asof' }
  | { kind: 'range'; query: Scope; cutoff: Tick;
      members: { slot: SlotRef; id: DerivationId }[]; memberDigest: string };

type Manifest = {
  schemaVersion: 1; learner: LearnerId; owner: DerivationId;
  gatherTick: Tick; method: MethodVersion; inputs: InputRef[];
  policyWitnesses: PolicyRoot[]; // 内核计算，模块不能伪造
};
type WaitTarget =
  | { kind: 'fact'; learner: LearnerId; id: FactId; observedRev: number | null }
  | { kind: 'slot'; ref: SlotRef; observedGeneration: Tick }
  | { kind: 'range'; learner: LearnerId; query: Scope; observedGeneration: Tick };

// 命令：同 ID、同命令类型和规范化输入得到同一回执。
await kernel.command(L, { id: correctionId, type: 'activity.correctSubmission',
  input: { submission: S3, expectedRev: 1, answer: { kind: 'known', text: 'B' } } });

defineDeriver({
  name: 'learner/mastery', version: 'fixture-v1',
  slot: { type: Mastery, key: ({ knowledgePoint }) => ({ knowledgePoint }),
    policy: { stale: 'eager', behind: 'batch' } },
  gather: ctx => ctx.snapshot(async read => ({
    grades: await read.range(Grade, {
      where: [{ path: 'value.knowledgePoints', contains: ctx.key.knowledgePoint }],
      asof: 'snapshot' // cutoff = 此 RR 快照内的 learner.clock
    }),
    preferences: await read.fact(learnerPreferencesId, { mode: 'following' })
  })),
  derive: fixedInput => deterministicMasteryState(fixedInput)
});

// 安排引用掌握度的截至答案，不追随每一个新证据而拒绝旧候选。
const planInput = await ctx.snapshot(async read => ({
  mastery: await read.slot(Mastery, { knowledgePoint: K }, { mode: 'asof' }),
  goal: await read.fact(goalId, { mode: 'following' }),
  time: await read.fact(timeId, { mode: 'following' }),
  question: await read.fact(questionId, { mode: 'pinned', rev: issuedRevision })
}));

// 判分 gather：未知是提交的合法值，但本场景不把它猜成判分。
const submission = await read.fact(S7, { mode: 'following' });
if (submission.value.answer.kind === 'unknown')
  return read.waitForChange(submission.ref); // 内核登记 FactTarget；不持有数据库快照等待

// 前台／会话无需了解索引、锁和 work 表。
const today = await kernel.readSlot(L, Today, todayKey, {
  actor, demand: 'read', asOfTime: fixedClock.now()
});
const evidence = await kernel.explain(L, today.derivationId, { actor, cursor });
```

`ctx.snapshot` 中只有受记录的读取，没有模型调用。遇到缺失依赖时返回 `Wait` 数据；内核关闭快照后，在短写事务中登记等待和所需上游需求。`gather` 不能把读不到的 stale 旧值当成正常值。`explain` 返回用途过滤的 manifest／事实修订／推导引用与原因，支持分页；用户点击证据不需要模块自己“自行查询”。

范围过滤先限于公开槽位 key 和不可变输出里的结构化等值／集合包含条件，不接受 SQL、数据库函数或模块回调查询。例中的知识点集合由判分／关联推导的正常输入决定，相关关联的 following 引用也必须入 manifest。方法版本、模型配置版本与范围表达式版本均被固定；不能偷偷按当前代码解释旧 scope。

## 4. 内核表结构草图

保留 learners、facts/fact_revs、commands、effects 和领域 work 的职责；下面是最少需要明确的增量。字段省略 SQL 类型细节和索引命名，不是可直接应用的迁移。

```sql
-- 每个关联键与 FK 都含 learner_id，防止跨学习者引用。
learners(id, clock bigint)
facts(learner_id, id, current_rev, ever_learner_edited)
fact_revs(learner_id, fact_id, rev, data, purpose, retracted,
          author, source_derivation_id, command_id, tick)
commands(learner_id, id, type, canonical_input_digest, input,
         receipt /* before+after refs, output */, tick)

-- 在结果产生前预留运行／推导身份；长计算不占锁。
derivation_runs(learner_id, id, slot_type, slot_key, method_version,
                lane /* live|shadow:run */, active_delivery_epoch,
                manifest_id, phase, rejection_reason)
input_manifests(learner_id, id, owner_id, schema_version,
                gather_tick, canonical_body jsonb, body_digest)
derivations(learner_id, id /* FK runs */, manifest_id, value jsonb,
            value_digest, created_tick) -- value/manifest/method 不变
derivation_state(learner_id, id, invalidated_tick, invalidation_cause,
                 effective_from_tick, selection_ended_tick,
                 selection_end_reason, behind_since_tick)
slot_state(learner_id, slot_type, slot_key,
           current_effective_id null, last_effective_id null,
           generation bigint, last_terminal_error)

-- 所有边均由 normalize(manifest) 生成，无模块写入口。
dependency_edges(learner_id, manifest_id, entry_no, sub_no,
                 source_kind, source_id, source_revision,
                 source_slot_type, source_slot_key, edge_kind)
-- edge_kind: fact_current, fact_revision_access, derivation_validity,
--            slot_current, slot_freshness, policy_access
-- range 的每个实际成员也有 derivation_validity 边。

range_subscriptions(learner_id, manifest_id, entry_no,
                    slot_type, canonical_scope jsonb, scope_digest,
                    cutoff bigint, member_digest, member_count)
-- 空范围同样有订阅，不能因为没有成员而省略。

work(learner_id, id, slot_type, slot_key,
     demand_state /* ready|running|waiting|idle|blocked */,
     desired_tick, completed_tick, current_run_id, delivery_epoch,
     dispatch_generation, queue_job_id)
work_waits(learner_id, work_id, target_kind,
           fact_id, slot_type, slot_key, scope,
           observed_version_or_generation)

effects(learner_id, owner_kind, owner_id, step_id, label,
        input_digest, method_config_digest, effect_id,
        state /* started|done|unknown|reconciled_failure */,
        provider_request_id, result, cost, actual_route)
```

建议普通 B-tree 反向索引 `(learner_id, source_kind, source_id, edge_kind)`，槽位指针反查索引 `(learner_id, source_slot_type, source_slot_key, edge_kind)`，范围订阅按 learner+slot_type 缩小集合再执行规范化谓词匹配。首版不加专门的范围成员投影表：枚举成员直接查询通用推导存储的 slot key／immutable value；反向“谁订阅新成员”从 range_subscriptions 查。需要优化时才测量 JSONB 表达式索引或 scope 原子索引，不让模块声明数据库索引。

`UNIQUE(learner, slot_type, slot_key)` 的 work 需求行保证每槽位一个生产运行；库自身 job 状态负责投递。shadow 的工作不占生产槽位运行权。多个独立解答方法使用不同的子槽位键，例如 `{questionRevision, method}`，再由共识解答槽位汇总；不能让同一槽位的三个生产 worker 绕过唯一约束竞争写有效指针。

`effective_from_tick` 与 `selection_ended_tick` 记录被选中区间；`invalidated_tick` 记录依据何时变假。两种结束时间不能共用一列。指针、状态、work 都由内核维护，不是第四种领域数据；同样 effects、索引也只是三种数据的存储／运行元数据，不向模块开放新构件。

## 5. 索引何时写：与不可变 manifest 的事务一致性

**封存时写，且在计算／付费调用之前；不等生效再补索引。**

1. worker 经队列投递进入内核，学习者锁内确认这次有效投递、分配运行 ID／delivery epoch；数据库提交后做 gather。
2. gather 使用只读 RR：读取 learner.clock=T，读完所有事实、槽位和范围；收集器自动记录实际版本、范围成员、用途见证和方法版本。模块拿不到制造任意 manifest 的入口。
3. 关闭快照。进入新的 READ COMMITTED 写事务，第一把领域锁是 learner 行；重新核验该读取清单。已经更正则不发付费请求，取消本次封存／进入新的 gather；只有新增证据则允许封存并记 behind。
4. 同事务插入 immutable manifest、运行关联、`dependency_edges=normalize(manifest)`、range_subscriptions 与初始有效性／新鲜度。任何插入失败整体回滚。即使 range 是空集，也写一条订阅。提交后才进入外部效果／derive。
5. 固定包含源输入和已保存的效果返回。产出候选时只允许引用已封存的 manifest ID，不允许提交一个“补过／删过输入”的清单。候选 immutable value 与该关联同事务落地，再走 accept；可与 accept 合并为一个事务。

manifest → edges 的映射有版本，规范化去重必须保留模式、range 所属 entry 和用途。每个非 shadow manifest 应满足：`stored_edges == normalize(manifest).edges`，`stored_ranges == normalize(manifest).ranges`，不是仅行数相等。可从 manifest 完整重建这些索引。主键冲突若内容不同必须报错，不能 `ON CONFLICT DO NOTHING` 掩盖错边。

候选登记前发生的变化，不可能靠反向通知找得到该候选；第 3 步和 accept 的正向核验负责补上这段窗口。候选登记后发生的变化，索引同步更新其有效性／behind。**两道机制共享语义函数，但方向不同；accept 不能仅凭“索引没有标脏”通过。**

生产索引覆盖：

- 已封存但尚在付费／计算的运行、普通 candidate、当前 effective、正常 superseded 的旧推导。后者可能被其他产物 pinned/asof 引用，必须保留。
- 已 rejected／stale 的索引可以保留作审计，传播只需忽略已终结的消费者，重复事件不反复调度。没有显式保留策略前不删除历史边；不预做复杂 GC。
- **shadow 默认不建生产依赖边和范围订阅**，保存同格式 manifest，按需调用同一正向验证器报告当前有效性。它不生效、不采纳、不唤醒或污染生产 work。切换方法后新建生产运行并重新 gather／核验；不能把旧 shadow 直接改 status 为 effective。需要 shadow 反查报表时可建隔离的临时索引，但不能混入 live 传播。

## 6. 命令、更正、生效与传播的事务边界

所有内核领域写事务都先锁 learner，再分配本事务的 tick；幂等命中不推进 clock。一个外部命令及其传播、内联采纳命令、工作登记共享一次事务和一个 tick。队列库自己的租约维护不属于事实／推导的领域变更，不必每次续租推进 learner.clock；它不得直接改领域表。无模型／对象存储／子进程 I/O 可发生在持有 learner 锁期间。

### 6.1 命令／更正

```text
BEGIN READ COMMITTED
  lock learner
  再查 (learner, command_id)：存在且 type+规范输入相同 → 原回执
                             存在但不同 → ID_REUSE
  校验权限、schema、预期修订和 destructive/proposal
  tick = clock + 1
  通过唯一 FactWrite 解释器追加修订，更新事实当前摘要
  由原状态+新状态产生 fact_current / retracted / purpose_narrowed 变化
  索引反查并同步传播到不动点
  执行声明式槽位触发；合并需求、等待唤醒；同连接登记库 job
  存含 before/after 的命令回执
COMMIT → 返回回执
```

并发同 ID 必须在 learner 锁后复查；只有事务外的“查到没有”不足以幂等。按学习者隔离命令 ID，并把命令类型、actor 语义和规范化输入计入身份。两次真实作答用两个 ID，不能按内容摘要去重。

采纳也调用这个 FactWrite 解释器的事务内分支，不递归开事务、再锁 learner、再发 HTTP 或直接插 facts。采纳身份由来源槽位／原件身份／稳定局部键确定，不随模型措辞或运行 ID 漂移；同次重试返回相同结果。已 sticky 的事实只产生持久提议，不覆盖。adopt 能力只属于带该定义的已生效生产槽位。

### 6.2 候选生效

```text
BEGIN READ COMMITTED
  lock learner
  校验当前投递 epoch / run 身份，防旧 worker 越权
  对候选的 immutable manifest 逐项正向核验：
    pinned fact 的版本存在且未撤回；following 另比 current_rev
    derivation 未 invalidated；following 另比 slot.current
    range 的实际成员仍有效、使用目的仍允许
    当前启用的方法／配置允许本次运行，slot.accept 机械规则满足
  不通过 → 保留候选和原因，记 rejected；按需求决定重新 gather / blocked
  通过 → 分配 tick：
    旧 current 结束选择区间（通常 superseded，不是 invalidated）
    新候选成为 current；更新 last；记录 effective tick
    计算自 gather 截止水位以来新增输入，设置新候选 behind
    对 slot_current、slot_freshness、新 range 成员事件传播到不动点
    同事务执行内联 adoption；其事实变化继续上述传播
    更新 work / waits，合并下一轮需求并登记唯一 job
COMMIT
```

若新候选因自己采纳的事实而反过来失效，应按相同传播规则处理并报告定义中的环，不豁免输入检查；共同样例须保证采纳输出不是当前推导的 following 输入。边仅指向封存时已存在的输入推导，不能指向尚未产生的未来结果。

槽位 accept 回调只能读已记录的候选、当前值及声明式状态；如果允许它再读领域数据，必须通过记录式 ctx 纳入同一候选 manifest 并重新封存，不能在这里开一个不记账的查询后门。首版建议 accept 为候选／当前值上的纯机械判断。

### 6.3 索引传播算法

每个写事务用事务内变化队列和 visited 集合做 BFS 到不动点，不创建异步传播 job：

| 变化 | 反查及动作 |
|---|---|
| F 普通新修订 | `fact_current(F)` 消费者失效；pinned 版本消费者保留 |
| F 撤回／用途收窄 | 对应版本访问／用途根边的消费者失效，pinned 同样不能绕过 |
| D 首次 invalidated | `derivation_validity(D)` 的候选／生效／历史消费者失效；包括 range 成员边；若 D 是 current 同时清空指针 |
| S.current 从 D0 变成 D1／空 | `slot_current(S)` 消费者失效；`slot_freshness(S)` 的 asof 消费者 behind；旧 D0 并不因此变假 |
| D1 新生效 | 命中其 scope 的 range_subscriptions，若 `D1.effective_from > cutoff` 则 behind；实际成员失效已经由成员边处理 |
| work 等待目标的版本／代数变化 | 唤醒为待重 gather；不是直接断言所有依赖已可算 |

每个消费者只第一次失效时继续展开它的输出；从 current 移除的变更也加入队列。historical/superseded 节点虽无 current 指针，失效仍向其后代传播。先收集本事务所有变化，再确定各槽位最终需求；同一槽位的重复 stale/behind 合并成一个需求水位，避免一条命令入多个重复 job。

新生效与采纳引起的新变化都处理完，事务才提交。若一条更正影响整个历史导致锁持有太长，应把这一结果作为 B 的规模反证；不能改为“先返回正确回执，慢慢异步置 stale”来掩盖失效窗口。

同一 learner 的两个提交只有两种确定顺序：更正先提交→旧候选拒绝；候选先提交→更正事务将它及后代置 stale。第二种不声称旧候选从未短暂有效，但更正回执返回后绝不能仍可作为新依据。READ COMMITTED 写事务必须在取得 learner 锁之后重新查询依赖，不能使用锁前建立的旧 RR 快照作生效检查。

## 7. range：成员、新证据、晚登记与 behind

### 7.1 范围究竟是哪一组东西

本候选采用**提交可见性时间**：`range(Q,C)` 是“学习者账本刻度 C 时，Q 中各槽位当时选中的有效推导版本”。C 默认是 RR 快照里读到的 learner.clock，不是 ULID 大小、作答拍摄时间、最后一个命中成员的 tick，也不是后来失效的 ended_tick。需要历史 C 时按选择区间重建：`effective_from <= C < selection_ended`，未结束区间视为无穷；当前已知被否定的历史成员不能再供新生效计算。

manifest 必须包含规范 scope、cutoff、**实际成员 `(slot,id)` 清单**及摘要；只有 scope+水位不足以解释“当时到底读了谁”。不是把水位以内所有历史版本一起算入，也不是只保存今天的 current ID 后猜昨天。

scope 只能依赖不可变成员 key/value；成员的知识点分类若读了可更正事实，其推导必须跟随该事实。不能让范围过滤偷偷 join 当前可变 facts，否则成员是否属于范围会在输出没变化时暗变，索引无法从 manifest 推得。

对“新事实在 C 前发生、但 C 后才首次判分”的成员，本提案仍视为新生效证据→behind。这是计算水位，不是业务发生时间。对原本不在 Q 的成员，更正后新版本进入 Q，也在新版本生效后按新增进入 Q→behind；原本在 Q 的旧版本若被该更正否定，旧 Q 的消费者立即 stale。新 Q 的消费者随后由 behind 策略重算，不永久遗漏新成员。

这里有一个需要主代理在共同语义中明确的边界：若“截至昨晚全部判分”实际要求“截至昨晚所有发生过的作答，含当时尚未判分或被误分到别处的作答”，则需要额外定义证据的业务时间／归属修正语义，不能从现行 tick 规格推出。B 不把这种未定需求伪装成已解决；本候选和下文共同样例都采用生效可见性水位。现有 §2.1–2.3 在此定义下仍会更新相关掌握度和安排。

### 7.2 反查规则及竞态

| 时序 | B 的动作／最终状态 |
|---|---|
| C 时 range 中有 G0；C 后 G0 被更正失效 | 由 G0 的成员边命中所有消费者，stale；候选 reject。即使失效 tick > C 也一样 |
| C 后有新槽位 G1 生效且命中 Q | 范围订阅匹配 G1 的不可变输出，cutoff < effective_tick 的消费者 behind；不 stale |
| G0 正常被 G0b 替换，G0 仍有效 | 包含 G0 的 range 仍可表示截至 C；新 G0b 使其 behind，不用重复计算两份旧证据 |
| G0b 替换时 G0 其实已 invalidated | 成员边先使消费者 stale；不能用“替换事件只 behind”掩盖否定 |
| C 时 Q 为空，C 后首个 G1 生效 | 空范围的订阅同样命中→behind；不会因为没有 member edges 而漏掉 |
| gather 后、封存前出现新 G1 | 封存事务按 scope 查询 `effective_from > C` 的发布记录，置 behind；尚无订阅也不会漏 |
| gather 后、封存前 G0 已失效 | 正向核验实际成员直接发现，重 gather／拒绝；不靠通知 |
| 封存后、accept 前出现新 G1 | 同事务范围传播置 behind，accept 仍重新确认并允许生效 |
| 新成员后又很快被撤回／失效 | 老范围本来没读该成员，不能因此被伪称输入被否定；behind 可保持，下一份新推导重新取成员。不清除旧推导 behind 标记 |
| 不匹配 Q 的普通新成员 | 不更改此范围消费者；不同 learner 无任何影响 |

范围发布查找要覆盖封存前已经正常被替换的较新版本；只查“现在 current 且 tick > C”可能漏掉发布历史。用 derivation_state 的生效区间和 immutable 输出可重建，不要求另一条业务写路径。每次事务至多给同一消费者设置一次 behind，合并所有命中范围的需求。

范围本身不是“必须非空”的等待条件。空判分集合法地产生“还不知道”；只有 gather 显式要求上游已就绪／至少一条匹配证据时才登记范围等待。范围过滤被用途检查拒绝时，应拒绝／报告受限，不能静默把禁止读取当“没有证据”。

## 8. 等待唤醒与队列库的职责

### 8.1 不丢唤醒

gather 返回 `Wait(targets, observedVersions)` 后：

1. 关闭只读快照，短写事务先锁 learner。
2. 在这个锁内重新读取所有目标状态。若所缺值已经可用，或者观察版本已变化，直接将 work 置 ready、合并上游需求并登记一次投递；不落 sleeping 状态。
3. 若仍缺少，写 `work_waits`，work 置 waiting；为缺少的上游槽位按策略登记需求。不存在的槽位以稳定 slot key 表示，generation 初值 0，不猜 future tick。
4. 目标生效、失效、被撤回、用途变化或终结失败的事务，在相同 learner 锁内找到等待关系，删除旧关系并将 work 重新置 ready 或 blocked。醒来后从头 gather，不复用旧半包。

两个窗口由同一把锁串行：目标先完成→登记时复核发现；等待先登记→目标提交前找到 waiter。等待多个目标时可在任一目标变化后重 gather，仍缺其他目标则重新等待；不把“收到一个通知”当“全部输入齐全”。合并需求与唯一 work 行防止惊群导致同槽位并行重复执行。

第 7 题的提交 answer=unknown 是合法事实值；判分等待的是 FactTarget 的修订变化，而非不存在的判分 tick。澄清问题由普通推导／采纳命令写为 companion 对话事实，以 submission+歧义字段的稳定身份去重；同一未知值重复读取、worker 重投不再问一次。未知不是异常，不能靠队列不停 retry。若后续仍 unknown，重新登记新的观察版本继续等；本人更正成 known 才让判分继续。

被等槽位终结错误时唤醒下游，返回“上游失败／无方法”的 blocked 状态并保留旧值；等事实撤回则报告 withdrawn，权限不允许则 denied。没有新需求或明确恢复信号不忙轮询。一次新配置、人工重试、provider 可用事件或新输入可重新触发正常需求；队列库的进程故障重试不等于领域上永远重试错误值。

### 8.2 一份需求状态、一套租约

| 内核拥有 | 队列库拥有 |
|---|---|
| 什么槽位需要算；stale/behind 策略；是否等待领域输入；需求合并；预算；当前 run；生效／采纳 | ready job 投递；并发 worker 领取；lease／heartbeat；进程失联后重投；退避与执行次数记录 |
| 每次 handler 启动时登记新的 delivery epoch，并拒绝更旧 epoch 的候选 | 可观察的投递身份；同一次或新一次 delivery 的定义；故障后的下一次启动 |
| started/done/unknown 效果身份及是否允许重新发送 | 不得据“job retry”自动再次执行付费效果 |

内核 epoch 是领域提交 fence，不自设过期时间，不用自己的 cron 抢租约；库是唯一租约时钟。旧 worker 在新 delivery 已启动并登记 epoch 后到达，其结果只能保存为迟到诊断／效果结果，不能改 current。若库提供更强的有效租约校验，适配器可同时检查；不能宣称仅有 epoch 就能证明“库租约尚未过期”。尚未有新投递时旧计算完成能否提交，须由适配器明确；本候选允许仍持有当前领域 fence 者按 manifest 接受，安全性不依赖墙钟租约超时。

投递期间的新证据只推进 `desired_tick`，**不撤销仍可按 asof 生效的当前运行 epoch**，否则持续新证据会把长计算永远拒掉。accept 后若仍欠新的输入，留一个后续需求；下一轮取新快照。`completed_tick` 表示已覆盖的需求水位，不直接写 accept tick 冒充已经消费了期间全部新证据。behind 的 batch／预算策略限制昂贵连环计算，但不得把受否定的旧值当有效兜底。

库选择的必要实测条件：同一个调用方 PostgreSQL 事务能登记 job、去重键行为可解释、handler 在 claim 事务关闭后调用内核、重投身份可用于 fence、重启后 ready job 可找回。入队键使用 work ID + dispatch generation；当前 job 仍 running 时登记下一代不被旧 singleton 去重吞掉。handler 若看到 work=waiting/idle 或 generation 过期就幂等结束，不再次计算。

领域锁序保持 learner→领域状态→同事务 queue enqueue；库不得持有 claim 行锁再同步进入等待 learner 的长事务。job 完成确认丢失时库可重投，内核通过已完成的运行／候选回执直接结束。尚未选库，以上是单元 4 的选择与故障注入门槛，不是已验证的库能力。

## 9. 外部效果、恢复与用途

K03 的最小实施顺序是：RR 记录读取→短事务封存 manifest+索引→锁外执行 gather 的受限效果→纯 derive。受限模型能力接收固定包、任务档位、稳定标签和请求摘要；模块没有 SDK、环境变量、网络连接，也不能借它再次读事实。Python 纯计算 worker 仍只收 JSON 并返回 JSON。

效果开始前，内核短事务校验权限、预算、运行身份与输入有效性，登记稳定 effect_id、实际模型／参数配置摘要、输入摘要、started，然后提交。外部调用在锁外；结果成功另一个短事务保存 done+result+真实成本。相同 owner+step+label 但请求摘要不同必须报身份复用错误。源输入变化需要重新 gather 时分配新 run；同固定输入因进程故障重试则复用原 run 与效果，不能 attempt++ 就换付费身份。

恢复规则：

| 崩溃／竞态位置 | 恢复行为 |
|---|---|
| 命令修订写入后、索引传播／job／回执前 | 同事务回滚；重发命令重做，绝不出现只提交事实而漏传播 |
| manifest 插入后、索引插入未完成 | 同事务回滚；不能出现已封存而无完整边的 live 运行 |
| gather 快照读完，封存前进程死 | 未封存无付费效果；重 gather，期间变更按新快照反映 |
| 封存完成，derive 未返回 | 库重投后按 fence/manifest 状态恢复；可复用纯输入包；输入已失效则重新 gather |
| effect=started，provider 调用前／后进程死 | 都属于本地无法判定是否发生；按效果标识向 provider 取回／核对，不假装一定没发出 |
| provider 已完成、保存 done 前响应丢失 | unknown；若 provider 不支持核对，保持待核对，禁止隐式重付。用户另发明确的新付费尝试是新效果并记录风险 |
| done 保存、候选／会话步骤未保存 | 从效果账本取 result，继续纯 derive／保存步骤；不重调 provider |
| accept 提交、queue ack 丢失 | 新投递查到同 run 的已接受／拒绝结果即返回，不再次采纳或建事实 |
| candidate 生效后发生更正 | 同步传播 stale，current 清空；旧值与费用保留，新运行独立 |
| 等待登记／唤醒任一步进程死 | 状态和库 job 同事务原子提交；重启查持久 waiting，不靠内存通知恢复 |
| 索引被人为损坏 | 停止相关 learner 写入／生效，重建并校验；不能继续以“漏通知不影响 accept”为由容忍当前旧值错误有效 |

会话效果使用 `{owner:'session-step', sessionId, stepId}`，步骤身份先持久化；每步动态读取的依据保存，再进入效果。恢复保存点，不确定性重放旧模型输出。生产与 shadow 效果命名空间隔离；既有 done 只有在 owner／方法／输入摘要及用途仍允许时可复用。

用途收窄在下一次写事务内使已有依赖 stale；每次读取与每次效果发送准入都检查当前用途，不能把缓存输入包当永续授权。已在撤销前准入并发出的远程请求无法“撤回网络”，保留其时间和状态，返回后也不得越过新的权限／生效检查。是否要求 provider 删除已发送数据属 D06／外部数据契约，本方案不作未授权承诺。

`NOTIFY` 可用于提示 worker／界面少等一轮，不能代替 work_waits、领域状态或库 job：通知只发给监听者，且同事务相同通知可能合并，断线恢复应读持久状态。[PostgreSQL NOTIFY 文档](https://www.postgresql.org/docs/current/sql-notify.html)。

## 10. 失效后如何读；撤销如何表现

建议读接口返回下列形状，而非多个可以拼成非法组合的布尔值：

```ts
type ComputeState =
  | { kind: 'idle' }
  | { kind: 'pending'; phase: 'ready' | 'running' | 'waiting'; waitingOn?: SafeWaitRef[] }
  | { kind: 'error'; code: string; retryable: boolean }
  | { kind: 'unavailable'; reason: 'no-method' | 'budget' | 'withdrawn' };
type SlotRead<T> =
  | { kind: 'current'; id: DerivationId; value: T;
      freshness: { kind: 'fresh' } | { kind: 'behind'; since: Tick };
      compute: ComputeState }
  | { kind: 'stale'; id: DerivationId; lastValue: T;
      cause: SafeCause; compute: ComputeState }
  | { kind: 'empty'; compute: ComputeState }
  | { kind: 'denied' };
// T 内部还可以是 {kind:'known',...}|{kind:'unknown',reason}，与计算状态不同。
```

effective D0 被否定时：原子清空 current、保留 last=D0；读返回 stale+D0 的历史值，若重算失败再附 error，不改成“未知”，也不抹掉已有判分。后续 D1 正常生效后，current/last 都指 D1；D0 可通过 `readDerivation`／`explain` 的历史接口查阅。普通 following 读取若无 current 返回 Wait；显式历史读取结果有 `displayOnly` 能力边界，不能作为 derive 输入。pinned/asof 可以引用正常 superseded 且未失效的 D0，与 stale 展示读取不同。

`readSlot` 为 lazy 策略产生需求时，先在短 learner 写事务复核与登记，再返回统一状态；单纯读取 fresh 值不推进 clock。用户仍看得到 old value，但“今天可学”不能仅靠显示 stale 判分来宣称通过：无模型兜底必须从现有、许可且有效的材料生成真正可学的确定性安排。若没有任何材料且无模型，是 D08 未定义边界，不能捏造卡片。

`evaluateAt` 使用显式时间与值中固定的模型版本；不改变 manifest／behind，不投递每日重算。旧方法停用后旧产物仍可读；若对应历史状态解码／时间评估器已不可用，返回明确 unavailable，不按新算法重新解释旧状态冒充同一推导。

撤销例：命令 C 新建 A、修订 B:r1→r2。A 当前仍是 C 的版本、B 当前 r2 时，undo(C) 同事务追加 A 的撤回修订和 B:r3=原 r1 的内容，二者都传播；如果 B 已有人写 r3，整个 undo 返回 conflict，A 也不撤回。提议尚未执行时拒绝提议只改变提议状态，不伪造反向事实命令。撤销本身稳定 ID、可重放，并受 destructive/权限与 sticky 规则约束。

## 11. PRD §2.1–2.3 完整数据流

### §2.1 四页物理卷

1. 表面上传原件到内核对象存储适配器，确认四份原件可恢复后发一条稳定 ID 的交入命令；同事务写四个原件事实、四个抽取需求和回执，不等模型。对象上传中断与数据库登记交界需单元 22 验证，不能先回“收到”再依赖易失缓冲。
2. 四个抽取槽位各自 gather+封存索引，锁外并行模型效果，候选逐个按 learner 锁生效；采纳命令把题、提交、红笔记录写为不同事实，指回来源与稳定局部键。整页模型 I/O 不持有 learner 锁。
3. 解答用两个不同方法子槽位，确定性共识槽位读取两份独立结果；不一致才请求第三个子槽位。每个产物都有自己的输入和成本，不能“同一结果换个标签”冒充独立解答。
4. 判分跟随提交、固定该次活动的题面版本、引用有效共识解答；结果分、过程质量、错因分开。帮助曝光的输入也经记录式读取进入证据权重计算，界面不计算分数／权重。
5. S7 answer=unknown：判分返回 FactTarget 等待；澄清只落一次正常对话事实。其他题继续，unknown 不阻塞全卷，也不伪造成错题分。
6. 每条有效判分通过 range_subscriptions 找到相关掌握度：首次供给触发槽位创建；已有截至结果 behind 并按 eager/batch 形成需求。确定性 Python 记忆推导读取真实判分集合，不调用语言模型。
7. 掌握度替换后，相应 asof 安排 behind；若之前有更正，则是 stale。安排可先按 lazy 保留需求，用户锁屏时教研工作单消费该需求。两秒／半分钟均须真实测量。

### §2.2 把 S3 从 D 更正为 B

1. 更正命令带 expectedRev，写新提交修订和 sticky。历史 D 保留。
2. fact_current 索引→判分 G3 invalidated；其成员边→掌握度 M0 invalidated；M0 的 derivation_validity 边→安排 P0 invalidated。整链在更正事务内完成，current 都相应清空；读立即可见 stale 旧值及待更新状态。
3. 已按 M0 封存的 P_late 即使不接收取消通知，accept 仍发现 M0 invalidated，保存 rejected 原因。若迟到的是旧 delivery，也由 fence 拒绝。
4. 新判分 G3b→新掌握度 M1→新安排 P1；用途、目标和锁定仍受当前事实约束。“因为更正了第 3 题”的原因来自 command_id→失效原因→新结果的已有依据，展示措辞可由视图推导生成。
5. 之后重抽取采纳 S3 时，因为 sticky 只写提议；不能通过“模型换了版本”开另一条更新事实的路径。

### §2.3 夜里备课，早上打开今天

1. 锁屏／在场状态变化和已存在的备课需求让工作单启动；无需求不因钟表走到凌晨而开一轮 agent。工作单／提示词属于会话宿主运行配置，不给领域模块增加 service。
2. 会话通过受限视图读掌握度、目标、25 分钟约束和材料；动态读取逐步保存，不让单个纯 derive 重新取数。
3. 请求笔记草稿槽位；五个变式候选各有三条独立解答子槽位，机械共识通过的才采纳成 content 事实。采纳、验题失败、等待与花费均保留。缺材料时工作单不能提前报完成。
4. 安排 gather 固定统计筛选与真实内容，模型最终选择走受限效果，纯 derive 输出固定结果；accept 核验所有引用，材料齐备才完成工作单。持续新增判分只造成截至候选 behind，可先交付，再合并一次后续需求。
5. 所有 provider 不可用时，启用相同槽位的确定性安排推导器，从已有可用内容产出安排，不依赖新笔记／新变式必须成功；错误账本不被抹掉。空库无材料的首次体验保留 D08 边界。
6. 早上 Today 视图读有效安排和已交付材料；必要时显式 evaluateAt(now) 展示当前记忆估计。无新事实、无新需求、无人读取时无新运行／付费；内部队列的必要恢复／租约维护不能伪记为教研活动。
