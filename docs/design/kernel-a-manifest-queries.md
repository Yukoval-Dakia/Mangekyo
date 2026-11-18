# Mangekyo 单元 0 · 独立候选 A：manifest 直接查询传播

日期：2026-11-16。性质：供主代理比较、消歧与安排实验的候选设计；未获选、未冻结、未实施。仓库只读，本文及辅助证据仅在 `/tmp/mangekyo-unit0/`。

## 0. 推荐与证据边界

**推荐把 A 做成一条完整、可被否证的基线：每个推导自己的 manifest 是依赖关系的唯一语义来源，内核直接查询这些 JSONB 清单，在同学习者写事务内完成传递失效；不建独立依赖边表、反向依赖台账或异步失效消费者。** PostgreSQL 的普通 B-tree/GIN 索引可以加速同一份数据；它们不是由应用维护的另一份依赖真相。队列只运送已经登记的需求，不能决定输入是否有效。

A 的主要代价是：更正会扫描/检索历史清单；范围在清单中保存精确成员，使存储和写放大随实际读取量增长；长链传播延长学习者行锁占用。不要预先宣布它优于独立依赖索引。若其锁持有时间或范围清单成本在共同实验中不可接受，比较候选 B，而不是把失效异步化以隐藏代价。

已完整读取用户指定的 PRD、kernel-design、development-plan、BACKLOG、GLOSSARY、implementation-contract 及 ADR 0001–0006。当前 HEAD 为 `8b39d00e2e203bfb0d33033713b2d306d2945f94`；本轮依据包括工作区中尚未提交的开发计划、实现契约与 BACKLOG 修订，不能只用该 SHA 重现。源文件哈希见同目录 `candidate-a-source-state.json`。开始时已有 README/BACKLOG 修改及四份未跟踪文档；均未编辑。

当前只有文档，没有内核代码、数据库迁移、队列适配器或可运行产品。环境未发现 `psql`；没有启动数据库、安装依赖、访问旧项目或执行产品旅程。下文 SQL 是实现草图，性能、PostgreSQL 并发、真实模型和 Web 行为均为 **NOT_RUN**。本文使用的设计方法来自本机 `codebase-design` skill；没有委派，也没有调用 Astra。

主要本地依据：

- `docs/PRD.md:37–67,153–184`：§2.1–2.3 与六条规则。
- `docs/PRD.md:186–197,222–247,286–324`：四种模块构件、技术约束、反证与冻结条件。
- `docs/kernel-design.md:16–74,111–204,227–238`：原始存储、命令、生效、传播、效果及不变量。
- `docs/development-plan.md:15–28,39–43` 与 `docs/BACKLOG.md:11–15,129–133`：K01–K08、共同实验与单元 25 冻结关口。
- `docs/implementation-contract.md:5–30,41–47`，ADR 0002/0004/0005/0006：所有权、类型、单写入者、队列、串行化与 gather/derive。

以下是建议的最小一致解释，并不是悄悄修改上述规格。

## 1. K01–K08：约束、矛盾与最小消歧

| 编号 | 对 A 的约束 / 明显矛盾 | 本候选采用的最小一致语义 |
|---|---|---|
| K01 | PRD §4.2/GLOSSARY 固定引用长期锁版本；kernel §5 却让 fact pinned/following 一样随修订失效。 | fact pinned 锁确切修订，普通更正不使它失效；following 随当前修订变化失效。事实撤回和用途收窄覆盖两者。derivation pinned 锁产物身份，普通 supersede 不影响它，但产物输入后来失效仍使它失效。题面冻结用 pinned；本人作答、目标和需被更正的依据用 following。不能把所有读取都改 pinned 来规避更正。 |
| K02 | ADR 0004/PRD 要现成队列库；kernel §7 又自行 claim、租约、重试。 | `work` 保存领域需求、固定输入、等待和执行世代；现成库独占队列投递、租约、心跳和传输重试。内核不轮询 claim work、不另算超时租约。登记需求与库的 job 插入必须能使用同一个 PostgreSQL 事务；库不满足则淘汰该库。库自有租约元数据不是 ADR 0005 所指的学习者语义写入。 |
| K03 | derive 纯计算、无 tools；付费推导又必须用模型，且现有 §9 允许 gather/会话 effect。 | gather 先在只读快照中返回数据和**声明式效果请求**；内核封口读取、关闭快照、保存固定包，再经效果账本执行请求，最后把响应加入固定包交给纯 derive。效果请求仍是推导器定义的返回值，不是第五类模块构件。不把 tools 塞入 derive，不在数据库快照/行锁内等模型。需要根据响应再读库时拆子推导或回会话。 |
| K04 | waiting.ticks 是 bigint[]，文本又说等槽位；空槽位没有未来 tick。 | 等待项使用带学习者作用域的稳定 FactId/SlotRef，加“变化版本/满足条件”，不用未来 tick。登记等待与复查条件在同一学习者锁内，变化和唤醒也在该锁内。失败、未知、撤回分别有结果。 |
| K05 | JSONB/跨语言值不能携带 at(now) 函数。 | 保存可序列化记忆状态和算法版本；读时由内核调用已加载的确定性呈现函数 `project(state, explicitNow)`。函数是推导器定义内的代码，不入 JSON、不访问环境。客户端只渲染结果，不自行重算掌握度。不因时间流逝写事实或调队列。 |
| K06 | undo 对新建无前驱；直接抄前驱会覆盖后续修改。 | 撤销是带前置修订检查的补偿命令。新建→追加撤回修订；更正→追加前驱的完整内容/状态；撤回→追加恢复修订。若任何目标已不是原命令写出的修订，整批返回 conflict，不写任何补偿，不静默覆盖后来改动。允许用户随后发明确的局部更正。 |
| K07 | stale 后不再是 effective，read 又要 effective+stale；旧值回溯不能交给模块查库。 | `effective_id` 失效即清空；另保留 `last_answer_id`。读接口以判别联合返回有效、过时旧值或尚无答案，计算状态独立分型。历史/证据经内核的用途过滤只读接口打开；gather 不得用展示旧值充当有效输入。 |
| K08 | ULID 与 command_id uuid 矛盾；效果还要覆盖 session。 | 领域 ID 统一为有品牌的 ULID 文本；命令外键也为 ULID。tick 在 JSON/IPC 中用十进制字符串，数据库为 bigint。队列库自有 UUID、随机 fencing token 是内部不透明值，不冒充领域 ID。效果键为 `Owner(derivation|session)+stableStep+label`，并绑定请求摘要和冻结的模型配置；unknown 必须核对，不宣称 provider exactly-once。 |

额外必须修正的规格矛盾：

1. kernel §3 写“五种东西”，PRD/实现契约只准四种。槽位声明（触发、scope、policy、接受/采纳规则）属于推导器构件，可有公共槽位类型文件，但不是第五种独立模块机制。
2. kernel §5 的“REPEATABLE READ 或单连接”错误地把连接复用当快照保证。gather 必须是真正的只读 REPEATABLE READ 事务；写路径用 READ COMMITTED，并在业务读取前取得学习者行锁。[PostgreSQL 隔离级别](https://www.postgresql.org/docs/current/transaction-iso.html)
3. kernel §5/§6 一处按成员在 W 前存在判失效，一处按 `watermark 覆盖 ended_tick` 判失效。若成员在 W 时有效、W 后才失效，后者恰好漏掉必须拒绝的候选。范围成员按**读取时身份集合**定义，不能要求失效刻度也 ≤W。
4. 单一 `status='superseded'|'stale'` 和一个 ended_tick 不足以表示“曾被正常替代、后来才发现依据错了”。若只传播 candidate/effective，仍引用旧 superseded 产物的 asof/pinned 使用者会漏失效。
5. `behind` 不是错误或失效；`unknown` 是合法结果；等待是工作状态。不能把三者压成 nullable value 或相互替换。
6. “过时 lazy 不重算”不等于“后台教研永远不发需求”。§2.1 暂不计算安排，§2.3 学习者离场后工作单产生显式需求，这与需求驱动一致。
7. 撤销不是抹除历史或撤回已发生的 provider 扣费；永久删除仍属 D06，不能用本候选的逻辑撤回替代。

## 2. 唯一语义：有效性、新鲜度、当前性分开

### 2.1 引用规则

每个输入在读取时都绑定学习者、准确身份、版本和读取用途。用途收窄/撤回还推进事实 `access_epoch`；manifest 保存读取到的 epoch，以检测“撤回后又恢复”的中间变化，防止旧候选重新冒充从未失效。

用途检查不能只看推导自己的 slot_type：内核读取 slot/range/历史值时，沿 manifest 检查事实叶子是否允许**当前消费用途**。例如只准判分而不准生成安排的材料，不能先生成判分/摘要再被安排间接读取。此遍历来自原 manifest，不另存一个可漂移的权限依赖图。来源已采纳为独立事实时，先按该事实自身的用途判断其数据；要打开更早来源原文仍单独检查来源用途。

| 输入 | 普通新修订/新生效 | 原依据被更正而失效 | 撤回 / 用途收窄 |
|---|---|---|---|
| fact pinned(id,rev) | 旧修订仍可作为冻结输入，不因 current_rev 前进失效 | 对本事实的普通内容更正仍只生成新版本；使用者既然选择冻结，就保留原版本语义 | 失效；pinned 不跨越访问撤销 |
| fact following(id,rev) | current_rev 变化即 stale | 同左 | stale |
| derivation pinned(id) | 被正常替代仍有效；不标 behind | 该 id 的 invalidated_tick 出现即 stale，即使它早已 superseded | 通过来源和访问检查失效 |
| slot following(slot,id) | 当前有效指针不再等于该 id 即 stale，包括指针变空 | stale | stale / 拒绝读取 |
| slot asof(slot,id) | 普通替代或后续证据只使直接使用者 behind | 该 id 的依据失效即 stale，包括“先替代、后失效” | stale / 拒绝读取 |
| range(scope,W,members) | W 后新增可用成员/正常替代使直接使用者 behind | 已记录成员中任一个 id 被 invalidated 即 stale | stale / 拒绝读取 |

asof 不能通过引用一个当前已经 stale 的 id 开始新推导。正常 superseded、尚未 invalidated 的 id 可以作为显式历史依据。pinned 也不能使已 invalidated 的推导变回有效。事实来源 `provenance` 用于解释，不自动把已采纳事实与来源绑成 following：采纳正是获得独立身份的边界；来源变了，经命令提出新修订，sticky 时变提议。

**有效性单调下降。** 一个 accepted 推导一旦 invalidated，永不复活。撤销更正、恢复用途和切回旧方法，都产生新的修订/推导与生效记录。新鲜度不承担真伪判断；behind 不沿依赖链无条件传递。只有被替代导致的 following 指针变化，或实际输入失效，才进一步改变下游。

### 2.2 范围成员怎样稳定定义

范围不是“当前查出什么就当时读过什么”。本候选选择更直接且容易核对的做法：**manifest 内枚举准确成员**，保存范围描述和成员摘要便于核对，不维护另一份成员依赖表。

一次读取保存：

```
{ slotType, selectorVersion, scope, watermark: W,
  members: [{slotKey, derivationId}, ...], membersDigest }
```

- W 是 gather 快照中的学习者 clock，不是墙上时间、ULID 顺序或范围内最大的 ended_tick。所有数据与 W 来自同一快照。
- 成员是该快照内、落在声明的范围中、满足该槽位证据资格规则的槽位所指的**有效推导**；每槽至多一个。顺序规范为 slotKey/derivationId，摘要固定。实际 derive 用到的每个值都能对应到成员。
- `scope` 只用内核支持的类型化选择器，如 `{knowledgePoint: K}` 的等值键组合；不能传 SQL、任意查库回调或随墙钟变化的谓词。选择器版本属于槽位契约。领域给 scope/资格的纯投影，位于推导器的槽位/触发声明内，由内核执行。
- 现有 `slot_state` 增加当前 `scope_keys`、`eligible`、`scope_source` 与 `changed_tick`，供内核做范围枚举。它是槽位身份/需求目录，不是依赖边索引。scope 的领域依据来自已记录的事实修订或推导；`scope_source` 只指向现有槽位锚点或相应推导/清单，不另复制一份依赖边。其变化必须在相应更正/生效事务内更新目录并使相关旧推导失效。不能让模块另维护一张“知识点→判分”关系表。
- 每个推导还保存当次不可变的 `scope_keys` 快照，用于解释及检测 W 后新生效成员。更正知识点归属时不原地修改旧推导的标签；旧成员通过跟随的归属依据失效，新版本带新标签。
- 范围内**已经符合证据资格、但当前没有有效值**的槽位，返回稳定身份的缺项，严格范围读取等待它们。不能默默丢掉失效判分，算出看似改善的掌握度。未识别出的作答不具备判分证据资格，保留未知/覆盖不足，不算零分；第 7 题可等待，而其他已知题的证据仍可形成掌握度。资格变更必须有其输入依据，不能按“结果是否方便”筛选。
- 空范围是合法空集合；仍记录 selector/scope/W，后续第一个合格成员到达会使它 behind。不能因为 `members=[]` 就不保存依赖范围。
- 正常替代后，旧范围仍引用原成员 id；后来原成员被证明失效，仍能找到使用它的范围。绝不通过当前标签或当前指针重建原范围。
- W 后的新成员不扩充旧 manifest。它使旧结果 behind，新一轮 gather 才记录新集合。成员的真实作答日期即使早于 W，只要它在 W 后才生效，就属于“新增可用证据”，不伪装成旧快照成员。

这比隐式谓词+水位占更多空间，尤其同一千条证据被多个掌握度/安排反复读取时。它使 K01/范围反例首先具备明确 oracle。scope/资格投影是此方案最需用共同样例审查的部分：如果真实领域不能用现有触发声明和已记录输入表达它，须修改该契约或报告反证，不能退回模块 SQL。

### 2.3 有效推导失效后怎样读

失效事务把 `slot_state.effective_id` 清空，保留 `last_answer_id` 和失效原因。后者永远只指曾被接受的产物，不指 rejected 候选。新推导生效时两指针都更新。读同一快照，故不存在“旧指针搭配新状态”的拼接结果。

展示读取允许返回旧值、历史依据和“待更新”；gather 的有效输入读取拒绝 stale，只能等待、取得确定性兜底，或按明示的合法历史模式读取尚未失效的版本。展示读取的结果类型不能直接交给 gather 当 `ValidInput`。用途不允许时，AI 的展示读取也返回 denied，不能把 last value 或旧摘要当绕行入口。停用方法只改变未来是否可计算，不自动抹掉旧 accepted；旧记忆状态的确定性呈现代码版本仍须可加载，或明确显示 unavailable，不能悄悄用新公式解释旧状态。

## 3. 核心类型与表结构草图

下面表达语义与约束，不是要求实现者照抄全部物理列。`Tick` 在边界为字符串；所有引用都含 learner，SQL 每层仍显式过滤 learner。

```ts
type SlotRef = { learner: LearnerId; type: SlotType; key: SlotKey };
type Outcome<T> = { kind: 'value'; value: T }
                | { kind: 'unknown'; reason: string };
type InputRef =
  | { kind: 'fact'; id: FactId; rev: Revision; accessEpoch: Tick;
      mode: 'pinned' | 'following'; purpose: SlotType }
  | { kind: 'slot'; slot: SlotRef; derivationId: DerivationId;
      mode: 'pinned' | 'following' | 'asof' }
  | { kind: 'range'; slotType: SlotType; selectorVersion: string;
      scope: Scope; watermark: Tick;
      members: readonly { slotKey: SlotKey; derivationId: DerivationId }[];
      membersDigest: Digest };

type WaitTarget =
  | { kind: 'slot'; ref: SlotRef; observedChange: Tick;
      until: 'valid' | 'changed' }
  | { kind: 'fact'; learner: LearnerId; id: FactId;
      observedRev: Revision; until: 'revised' }
  | { kind: 'range'; learner: LearnerId; type: SlotType;
      scope: Scope; observedChange: Tick };

type Computation =
  | { kind: 'idle' }
  | { kind: 'pending'; phase: 'queued' | 'executing' }
  | { kind: 'waiting'; on: readonly WaitTarget[] }
  | { kind: 'error'; code: ErrorCode; recoverable: boolean }
  | { kind: 'unavailable'; reason: 'no-active-method' };
type SlotRead<T> =
  | { kind: 'effective'; id: DerivationId; outcome: Outcome<T>;
      freshness: { kind: 'fresh' } | { kind: 'behind'; since: Tick };
      computation: Computation }
  | { kind: 'stale'; last: { id: DerivationId; outcome: Outcome<T> };
      invalidatedAt: Tick; cause: Cause; computation: Computation }
  | { kind: 'empty'; computation: Computation };

type ReadResult<T> = { kind: 'ok'; result: SlotRead<T> }
                   | { kind: 'denied'; reason: 'purpose' | 'scope' };

type FactWrite =
  | { kind: 'create'; factType: FactType; localKey: string; data: Json }
  | { kind: 'revise'; id: FactId; expectedRev: Revision; data: Json }
  | { kind: 'retract'; id: FactId; expectedRev: Revision }
  | { kind: 'set-purpose'; id: FactId; expectedRev: Revision; purpose: Purpose };

type GatherPlan<G> = { data: G; effects: readonly EffectRequest[] };
// 内核执行效果后补全响应；derive 仍是固定可序列化输入 -> Outcome。
type DeriveInput<G> = { data: G; receipts: readonly EffectReceipt[] };
type EffectOwner = { kind: 'derivation'; id: DerivationId }
                 | { kind: 'session'; id: SessionId; step: SessionStepId };
```

存储建议：

```sql
learners(id text primary key, clock bigint not null);

facts(learner_id, id text, type text, current_rev int, access_epoch bigint,
      sticky boolean, origin_key text,
      primary key(learner_id,id), unique(learner_id,type,origin_key));
fact_revs(learner_id, fact_id, rev int, data jsonb,
          life_state text, purpose text[], author jsonb,
          command_id text, tick bigint,
          primary key(learner_id,fact_id,rev));
-- life_state='present'|'retracted'；用途、撤回也有修订历史。
-- facts 的当前元数据只是最近修订的受约束快捷读取，不是另一个写入口。

commands(learner_id, id text, type text, actor jsonb,
         canonical_input jsonb, receipt jsonb, tick bigint,
         primary key(learner_id,id));

-- payload/manifest/method 一经形成不可修改；下列是内核维护的生命周期元数据。
derivations(learner_id, id text, slot_type text, slot_key text,
            method text, method_version text, value jsonb, manifest jsonb,
            gather_tick bigint, scope_keys jsonb,
            disposition text,                     -- candidate|accepted|rejected|shadow
            accepted_tick bigint, current_until_tick bigint,
            invalidated_tick bigint, invalidation_reason jsonb,
            behind_since_tick bigint, source_run_id text,
            primary key(learner_id,id));
-- superseded：accepted 且 current_until_tick 非空，而 invalidated_tick 仍可为空。
-- stale：accepted 且 invalidated_tick 非空；可同时有更早的正常 supersede。
-- 拒绝/影子没有 accepted_tick；检查约束排除非法列组合。

slot_state(learner_id, slot_type text, slot_key text,
           effective_id text, last_answer_id text,
           scope_keys jsonb, scope_source jsonb, eligible boolean,
           changed_tick bigint,
           primary key(learner_id,slot_type,slot_key));

work(learner_id, id text, slot_type text, slot_key text,
     demand_generation bigint, satisfied_generation bigint,
     state text, run_id text, fence bigint, waiting_on jsonb,
     primary key(learner_id,id), unique(learner_id,slot_type,slot_key));
-- work 是一条可合并的需求，不含 lease_until/heartbeat/自定义 claim 算法。
-- 状态用 CHECK 与类型联合对应；等待 targets 不存于 bigint[]。

work_runs(learner_id, run_id text, work_id text, demand_generation bigint,
          fence bigint, reserved_derivation_id text,
          method_version text, gather_tick bigint,
          manifest jsonb, fixed_input jsonb, outcome jsonb,
          primary key(learner_id,run_id));
-- 内核运行证据；先保留推导 ID，才能在产出候选以前登记模型效果。
-- 输入包/清单固定后不改，新的 gather 使用新 run；恢复不覆写失败证据。

effects(learner_id, owner_kind text, owner_id text, step_id text, label text,
        request_digest text, request jsonb, state text,
        result jsonb, provider_reference jsonb, tick bigint,
        primary key(learner_id,owner_kind,owner_id,step_id,label));
-- started|done|unknown；done 结果校验后才能喂给 derive。

proposals(learner_id, id text, command_id text, target_revisions jsonb,
          proposed_write jsonb, state text, tick bigint, ...);
-- 库自有 queue 表：由适配器调用库公开接口维护，不是 modules 的表。
```

所有外键使用 `(learner_id,id)` 组合，防跨学习者引用；work/slot/derivation 的关联和有效指针还要检查 type/key 一致。每槽位的 current accepted 结果加唯一约束，`effective_id` 与有效区间只能经同一个内核事务改变。大图片/大产物仍在对象存储，DB 保存耐久引用和摘要，不把原件复制进每份 manifest。

`work_runs`、effects、proposals、会话步骤是内核的运行/意图元数据，不向模块暴露第四种领域数据。没有 domain repository、传播 handler 或模块队列注册器。

## 4. 不建独立依赖索引，如何找到依赖者

### 4.1 查询来源与可用物理索引

manifest 在数据库中采用适合 containment 的固定形状：`{facts:[...], slots:[...], ranges:[...], method:{...}}`。引用必须在同一个 JSON 对象中匹配身份和模式，不能把两个不相关数组成员拼成一条边。

```sql
CREATE INDEX derivation_manifest_gin
  ON derivations USING gin (manifest jsonb_path_ops);
CREATE INDEX derivation_scope_gin
  ON derivations USING gin (scope_keys jsonb_path_ops);
CREATE INDEX derivation_slot_history
  ON derivations(learner_id, slot_type, slot_key, accepted_tick);
CREATE INDEX slot_scope_gin
  ON slot_state USING gin (scope_keys jsonb_path_ops);
```

可再按实测做 partial index，但**不能仅索引 current effective 而在查询时遗漏仍被引用的 superseded 历史**。GIN 由 PostgreSQL 同步维护，A 无 `dependencies(from,to)` 表、无应用维护的反向邻接列、无“先写清单再补索引”的双写恢复。

`jsonb_path_ops` 支持 `@>`；具体是否走 GIN、是否先按 learner 过滤，由真实 EXPLAIN 决定，不承诺所有参数化 JSON 查询都会命中索引。[PostgreSQL JSONB 索引](https://www.postgresql.org/docs/18/datatype-json.html)

### 4.2 事实更正的直接依赖

```sql
SELECT d.id
FROM derivations d
WHERE d.learner_id = $1
  AND d.disposition = 'accepted'
  AND d.invalidated_tick IS NULL
  AND d.manifest @> jsonb_build_object(
    'facts', jsonb_build_array(jsonb_build_object(
      'id', $2::text, 'mode', 'following')));
```

再用 `jsonb_array_elements(manifest->'facts')` 校验该输入确为当前事实、其 rev 不再是 current_rev；全部参数绑定。事实撤回/用途收窄则匹配所有模式，并检查 access_epoch。这里不能把 `fact pinned` 也按普通更正一并失效。仍在计算中的 run 在 demand 上记录需重查；它最终提交时全量重验，绝不因没有 accepted 行而漏过。

### 4.3 推导失效的直接依赖

```sql
SELECT d.id
FROM derivations d
WHERE d.learner_id = $1
  AND d.disposition = 'accepted'
  AND d.invalidated_tick IS NULL
  AND (
    d.manifest @> jsonb_build_object('slots', jsonb_build_array(
      jsonb_build_object('derivationId', $2::text)))
    OR
    d.manifest @> jsonb_build_object('ranges', jsonb_build_array(
      jsonb_build_object('members', jsonb_build_array(
        jsonb_build_object('derivationId', $2::text)))))
  );
```

失效传给 slots 中 pinned/following/asof 全部引用，及准确范围成员。普通替代只找 `slots` 中相同 SlotRef 的 following 做 stale；asof 做 behind；range 用成员 id 和 scope 找实际受到替代/新增影响者。不能把“替代”和“失效”合并成同一事件。

### 4.4 范围读取、新增和候选校验

初次范围读取在 gather 快照中从 `slot_state` 做 `learner+slot_type+scope_keys @> scope+eligible` 过滤，检查所有合格槽位有有效指针，再连接 derivations，读 value 与 id。缺项返回 WaitTarget。空范围也保存描述。scope 元数据只能由声明的、版本化输入产生；未满足该要求就拒绝该 scope 定义。

候选生效时将清单范围项展开为成员，反连接 accepted derivations，检查：

```sql
-- 简化形状；member_id 来自经过校验的 manifest 展开，不由模块传 SQL。
SELECT EXISTS (
  SELECT 1
  FROM unnest($member_ids::text[]) AS m(id)
  LEFT JOIN derivations src
    ON src.learner_id = $learner AND src.id = m.id
  WHERE src.id IS NULL OR src.accepted_tick IS NULL
     OR src.invalidated_tick IS NOT NULL
);
```

任一成员 invalidated 就拒绝，包括 `invalidated_tick > W`、成员当前早已不在原 scope 的情况。固定成员无需与当前 effective 指针相等，因此正常 supersede 不导致错误拒绝。

是否 behind：查询同 learner/type、当次不可变 scope_keys 匹配、`accepted_tick > W` 的生效历史及相关正常替代记录；即使新结果已再次替代、scope 又变化，也不能假装“从未出现过新增”。behind 的依据保留最早变化刻度。W 后只出现过 rejected/shadow 不能构成新增证据。若涉及 W 内的成员失效，stale 优先于 behind。

新增/替代事务反找 range 使用者时先用 containment 预筛 type/scope，再逐个用内核相同的 typed selector 验证是否匹配，比较 W 和成员集合。初期 selector 仅有等值键组合；新类型化选择器若不能保证读与反向匹配一致，不能接入。缺乏匹配键时宁可扫描同 learner/type 的 ranges，不以可能漏判的 JSON 近似匹配换性能。

### 4.5 同事务求闭包

```
changedFacts / invalidatedDerivations / pointerChanges / additions
  -> 参数化查询直接依赖者
  -> 首次写 invalidated_tick，或标记 behind
  -> 若它是 current，清 effective_id、保留 last_answer_id
  -> 产生新的失效 / 指针变化，加入事务内 frontier
  -> 查历史 accepted 清单，直至没有新增失效
  -> 合并 eager/显式需求、登记唤醒与库 job
```

frontier/visited 仅在当前事务内，是算法的临时内存，不是持久依赖索引。批量 id 可分批查询；同一推导只首次失效一次。behind 本身不递归广播，但它的 eager 重算将来发生真正的指针替代时，会按引用模式影响下游。

生效时即使已有 invalidated 标记，仍重验直接事实版本、访问 epoch、slot 指针及范围成员，并验证所读推导的有效性依据。保守基线可递归核对所引用推导的 manifest，用 visited 限制同一祖先重复查询；它不把“没收到通知”当有效证明。整条已提交历史应满足闭包不变量；两者不符即内核缺陷，不能继续生效。查询与校验都由内核完成，模块没有传播代码。

## 5. 事务、同学习者行锁与刻度

### 5.1 原则

所有**学习者语义写入**先锁 learners 行；拿锁之前不做用于决策的事实/推导读取。采用 READ COMMITTED，等锁结束后的语句看见最新已提交状态。不能先在旧 REPEATABLE READ 快照中读业务值，再拿锁并假定刷新了快照。

成功改变内核语义状态的短事务推进一次 clock。该事务内事实修订、派生失效、指针变化、需求/等待修改和效果状态可共用同一 tick；它表示同一个提交的因果组，不要求同事务内有全序。无效输入、纯只读、幂等回执复用不推进 clock。队列库自己的 lease/heartbeat 不推进学习者时钟。

clock 是观察水位，不是“任何 clock 变化都使推导过时”的全局守卫。否则心跳、会话保存或无关事实会造成拒绝风暴。accept 始终按 manifest 中实际输入检查。

### 5.2 命令与更正

1. 校验边界 schema/作用域，开始事务；锁 learner。
2. **锁后重新检查** `(learner,id)` 幂等行。type、actor、canonical input 相同返回原 receipt；不同返回 id-reuse。锁外查询只能是优化，不能代替锁内检查。
3. 命令 read/write 只经 ctx；纯写计划带 expectedRev，不允许外部效果。检查权限、破坏性提议、sticky 与各目标修订；不跨模块任意写事实。
4. 分配 tick；追加事实修订（含用途/撤回），更新 current 元数据和声明式槽位目录。
5. 同事务执行失效闭包、需求合并、等待复查与队列 job 登记；保存完整 receipt，提交后回执。四页收件不等待抽取/模型。
6. 同一 id 并发首次到达，由 learner 锁串行化。相同内容但**不同命令 id**的两次真实作答各有独立事实。

采纳仍通过此命令执行器：内核可以有通用的内部 adoption 命令，目标 FactType/schema/可写字段由所属模块定义；有领域规则时调用事实所有模块自己的命令。抽取器只返回候选与声明的采纳意图，不自行写 content/activity 表，不复制另一模块实现。跨模块只用公共事实/槽位类型和内核生成的命令调用边界。

### 5.3 gather、效果与 derive

- 库投递一个 work 引用。handler 在 learner 锁内做语义 admission，读取需求世代，分配稳定 run/预留 DerivationId，记录当前 fencing 世代后迅速提交。
- 在单独的只读 REPEATABLE READ 事务里运行 gather；ctx 强制记录每次实际读取，检查用途。产出 GatherPlan 后关闭快照；单连接本身不够。[PostgreSQL REPEATABLE READ](https://www.postgresql.org/docs/current/transaction-iso.html)
- 在短的 learner 锁事务内保存固定清单/输入和方法配置，再验一次输入，避免在已经明确过时的基础上开始付费；允许合法 asof/range behind。当前 run 此后不能再取数。
- 内核检查 model effect 请求的档位/schema/预算，并在 started 的短事务中复查用途，按稳定身份先登记 started 再提交；锁外调用 provider，结果在新短事务中写 done/unknown。实际模型、参数、原回复、provider reference、成本都保留。新返回值也须经过 schema 校验。
- 内核把数据、所有效果响应与显式时间组成固定输入包。derive 仅做纯计算；TS/Python 协议输入相同。不允许 derive 查询数据库/网络或读取时钟。
- 两种独立解答是独立子槽位/方法与效果身份，不把一次 provider 回复复制成两份。第三方法只在合并推导发现不一致、提出该子槽位需求后运行。

started 提交是外部效果的授权起点。用途撤回阻止其后新的效果授权；已经授权/在途的调用不承诺能取消。若 provider 请求尚未提交而网关已观察到撤回，则停止发送并留可核对状态；绝不为了取消保证而持有 learner 锁等待网络。结果返回与候选生效时还要复查用途。这个在途边界须进入共同故障样例；本地协议不能保证 provider 删除已收到内容。

这样保留 gather/derive 的两段模块形态。内核在 gather 固定包的形成过程中实现“读取封口后做效果”；不是把 gather 变成长期持有数据库事务的付费会话。若后续必须按模型返回临时再查一条材料，改用工作单会话或新的子推导；不开放隐藏读取。

### 5.4 候选生效

1. 开写事务，先锁 learner；检查 work/run/fence、目标槽位、method version 和 shadow 标记。旧世代结果记为迟到证据，不移动指针。
2. 全量重验 manifest，包括用途、following 版本/指针、引用推导是否 invalidated、所有范围成员。校验通过后执行无 I/O 的纯 accept 规则。
3. 失败：保存 rejected 原值和清单、明确原因。输入已变则登记新的 gather 需求；接受规则不通过不自动无限重算。schema/代码错误进入可观察 error，provider outage 才按分类允许重试/兜底。
4. 成功：分配 tick；旧 current 结束当前区间，新 accepted 开始区间，更新 effective/last 指针，按 W 后新增计算 behind。
5. 仍在同一事务里执行普通替代通知、adoption 命令、由采纳引起的事实变更闭包、等待复查和后续需求/queue 插入。adoption 使用同一执行器与事务，不递归获取第二把 learner 锁，不自行提前提交。
6. 事务末尾新 accepted 仍须满足不变量。若采纳反过来修改了自身 following 输入，使新结果自失效，拒绝这类自破坏接受/采纳组合并保存错误；不能留下“生效但依据已错”的提交。真正的领域循环需拆开事实身份或工作单，不用兼容分支掩盖。
7. 提交以后才确认库 job。若 DB 成功后 ack 丢失，重投看到已满足的 work generation，返回 no-op。

锁外计算多长都不影响更正抢锁。更正先提交→旧候选拒绝；候选先提交→之后更正将它及下游同事务失效；不存在检查与提交间的空隙。

## 6. 需求、队列、等待与恢复

### 6.1 库和内核只各有一份职责

| 内核拥有 | PostgreSQL 队列库拥有 |
|---|---|
| 槽位是否需要、eager/lazy/显式工作单需求、预算 | 哪个 worker 收到 job、可见时间、并发、租约/心跳 |
| work 需求世代合并、waiting targets、固定包 | handler 失败后的传输重试、退避、投递 attempt |
| 输入有效性、accept、fencing 世代、shadow | job 完成/取消的操作元数据 |
| provider unknown 的核对、分类错误与兜底选择 | 不知道 mastery、stale、scope、用途是什么 |

库选择的硬门槛：公开接口可把 enqueue 放进调用方事务或提供等价同库原子登记；能以稳定去重键处理 job 重复；能在恢复后重投；可在边界层观测投递身份。具体库在单元 4 查当时文档并试验，本报告不预先选择库，也不假定“同一个数据库”自动等于“同一个事务”。

队列 job 键包含 `(workId,demandGeneration)`，库负责投递去重；work 的世代仍是领域幂等依据。模块见不到该键。若所选库无法做原子登记，不能默默加一套 dispatcher/outbox 租约系统；先换库或明确返回单元 0 修约束。

### 6.2 合并需求与迟到结果

每槽位一条 work，需求到达只递增/合并 demand generation；正在算时不再启动并行领域 work。handler 的语义 admission 更新 fence；它不自行抢 ready 行或判断 lease 到期。租约过期后的重新投递由库产生，内核接受新投递时 fence 前进，旧 handler 即使晚返回也无法生效。

这里的 fencing 保证“新执行世代取得所有权后，旧世代不能提交”。若旧 handler 在库 lease 已过期、但新世代尚未 admission 时完成，只要 manifest 仍有效，可线性化完成一次；后续重投 no-op。若共同 oracle 要求 lease 一过期立即禁止提交，队列适配器必须能在接受事务内证明库所有权，不能用内核再造 lease 时钟。此项须在库试验中明确。

运行期间来了新证据：

- following 输入变化：该 run 不能生效，下一 run 重 gather。
- asof/range 仅新增：run 可以生效并 behind，满足它已记录的输入水位；新需求仍保留，由策略/预算合并处理。不能因为所有输入不够“最新”而永远拒绝。
- 持续新增时每次重算都能产出一个截至结果；eager 的后续计算受批量/预算约束，不能同时启动无限 work。停止新事实/新需求后把已经登记的有限依赖链处理完，不创建日刷或无变化重算循环。

### 6.3 等待登记与唤醒的无丢失协议

gather 缺值时先得到 WaitTargets。之后用新的短事务：锁 learner，**重查**这些 targets 和它们的 changed_tick/修订。缺少的可计算槽位同时登记前置需求（包括原本 lazy 的槽位，因为下游现在明确在读它），不只登记一个永远没人填的 waiting。预期由学习者修订的未知事实则不伪造后台写入需求。若形成循环等待，返回结构错误并保留目标链，不能用周期重投掩盖。

- 条件已满足或读取后发生过相关变化：置 ready，清等待并同事务 enqueue，不写一个必将错过的 waiting。
- 仍未满足：保存完整等待对象和观察版本，置 waiting，提交并正常结束本次队列 job。
- 后续 fact/slot 变化事务在同一 learner 锁下查询 `work.waiting_on` JSON，复查所有相关条件；可运行则 ready+enqueue。多个条件可采用“任一变化都重 gather”，由 gather 决定是否继续等，避免猜测未来 tick。

等待中的 work 不占用库 lease，不用轮询模型。槽位失效也唤醒，以便重新选择依据；失败唤醒后能返回 dependency_error 或确定性兜底；用途撤回返回 access-denied，不无限等待。合法 unknown 不自动变 error；判分需要已知作答时等待 `FactId` 的修订，其他能处理 unknown 的推导器正常产出不确定性。

“只问一次”由一个命令的稳定身份/目标修订实现，例如 `(submissionId,ambiguousRev,clarify)` 关联的对话事实或提议。重投、waiting 唤醒不重复创建询问。学习者更正该提交后唤醒判分；没有 UI 私有的“已经问过”布尔写路径。

### 6.4 恢复与效果

| 中断位置 | 持久状态与恢复行为 |
|---|---|
| 命令提交前 | 整体回滚；相同 command ID 重放。 |
| 命令已提交、抽取未开始 | work 与库 job 同事务存在；库恢复投递，四原件仍在。 |
| gather 快照中 / 固定包保存前 | 无付费效果；库重投重 gather；旧临时包不当成完成。 |
| 固定包已存 / 部分效果 done | 同一 run 使用已存输入，done 结果复用；不为重试重新生成所有 effect ID。 |
| started 已提交、调用前后崩溃 | 结果未知；凭稳定请求身份/可用 provider reference 核对，未核对前不盲重付。即使实际上尚未发出，也不伪称已安全完成。 |
| provider 完成、done 尚未保存 | 仍为 unknown；若 provider 可查询则取回，不可查询则保留不确定性。明确人工决定再次付费时使用新身份并留记录。 |
| 响应到达时用途已撤回 | 原始证据受限保存；不能喂给 derive/公开读取，不接受旧 run。外部已发生的泄露/扣费不能靠 stale 撤销。 |
| 纯 derive 崩溃 | 固定包可重用；库负责重投，内核保持 run/fence 规则。 |
| 生效/采纳中崩溃 | PostgreSQL 全部提交或全部回滚；无半条事实、半次传播。 |
| 生效已提交、库 ack 丢失 | generation 已满足，重投 no-op；不重复采纳。 |
| 旧 worker 在新世代后返回 | fence 不符，保存迟到结果/成本，不生效。 |
| 等待期间进程重启 | waiting_on 在库 job 外持久；后续相关事务复查唤醒。启动时也可逐 learner 核验 waiting 条件，不能全量重算所有槽位。 |
| superseded 旧依据后来失效 | 查询其历史 manifest 闭包，仍使引用它的有效 asof/pinned 下游失效。 |

效果返回 `done` 只证明本地已有结果，不能推广成 provider 只收费一次。会话使用同一协议，step ID 在计划产生时持久，恢复使用已保存步骤/效果；不重放旧模型对话来猜已经执行的命令。模型全挂时，错误分类解除付费方法的自旋，关键槽位提出确定性方法的同一类候选，仍走同一个 accept。

## 7. 调用方使用例

这些示意只用公开类型/ctx；名字是本报告的共同样例别名，真实边界使用 ULID。API 形状是候选，不是现有库。

### 7.1 更正、普通读取与证据

```ts
await kernel.handle(learner, {
  id: commandId,
  type: 'activity.correctSubmission',
  input: { submissionId: S3, expectedRev: 1,
           answer: { kind: 'known', text: 'B' } },
});

const read = await kernel.read(learner, PlanSlot.ref('tomorrow'), {
  actor: learnerActor, demand: 'ensure',
});
// 先处理 read.kind='denied'；其余取 read.result。
// result.kind='stale' 时显示 last 的安排与“因更正待更新”；
// outcome.kind='unknown' 时显示不知道；computation.error 单独显示。

const evidence = await kernel.evidence(learner, cardAnswerId, {
  actor: learnerActor, purpose: 'inspect-own-evidence',
});
// 内核按 manifest 回溯精确修订和范围成员，输出可打开的证据树。
// 同伴/推导器用自己的 actor/purpose；不能借 owner 目的越权。
```

历史证据/last value 是读接口，不增加事实写路径。列举槽位、打开原件、按 manifest 打开旧判分都经内核。已有 purpose 被收窄的叶子不向 AI 原文回显，必要时以不可访问占位；也不把仍含受限内容的旧摘要当安全替代品。

### 7.2 判分与掌握度

```ts
const Grade = defineDeriver({
  slot: { type: 'activity.grade', /* key, triggers, scope, policy */ },
  async gather(ctx, key) {
    const submission = await ctx.fact(key.submissionId, { mode: 'following' });
    if (submission.answer.kind === 'unknown') {
      return ctx.waitForRevision(submission.ref); // kernel stores WaitTarget
    }
    const paper = await ctx.fact(submission.questionRef, { mode: 'pinned' });
    const solution = await ctx.slot(SolutionSlot.ref(paper.ref), {
      mode: 'following', require: 'valid',
    });
    return { data: { submission, paper, solution }, effects: [] };
  },
  derive: fixedInput => deterministicGrade(fixedInput),
});

const Mastery = defineDeriver({
  slot: { type: 'learner.mastery', /* scope/资格来自明确的公开输入 */ },
  async gather(ctx, key) {
    const grades = await ctx.range(GradeSlot.type, {
      selectorVersion: 'knowledge-point/v1',
      scope: { knowledgePoint: key.knowledgePoint },
      mode: 'asof', require: 'complete-eligible',
    });
    return { data: { evidence: grades.values, asOf: ctx.snapshotTick }, effects: [] };
  },
  derive: fixedInput => memoryState(fixedInput), // 同一包可在 Python 执行
  project: (state, explicitNow) => memoryAt(state, explicitNow),
});
```

帮助曝光与“是否独立作答”的缺席判断也必须被记录：不能直接查“暂时没有 exposure”却只记录查出的零条。可把该活动的帮助证据集合做截至/跟随的范围输入；新帮助曝光在提交前出现时，应使判分证据属性/掌握度按其声明模式重算。exact false/empty 的依据属于 manifest，不藏在 UI。

### 7.3 付费抽取

```ts
const Extract = defineDeriver({
  slot: { type: 'capture.extract', policy: 'eager', /* 原件触发 */ },
  async gather(ctx, pageKey) {
    const page = await ctx.fact(pageKey.original, { mode: 'following' });
    const preference = await ctx.slot(RedPenPreference.ref(), {
      mode: 'following', require: 'valid',
    });
    return {
      data: { page, preference },
      effects: [{ kind: 'model', label: 'extract-page', tier: 'vision-extract',
                  request: makeRequest(page, preference), outputSchema: ExtractSchema }],
    };
  },
  derive: fixedInput => parseAndLocate(fixedInput),
  // 采纳只描述内核命令意图；target types/schema 由所属模块定义。
});
```

模块拿不到对象存储密钥、provider 凭据、网络、Db 或队列库。效果请求中的对象引用由网关在用途复查后解析；不能把永久下载 URL 作为绕过授权的能力传给推导器。

## 8. §2.1–2.3 的完整数据流

### §2.1 四页原件到判分

1. 对象存储先确认四个原件耐久引用，再执行一条“交入”命令写四条原件事实；同事务建四个 eager 抽取需求/job，返回“收到 4 页”。对象存储不与 PostgreSQL 假装分布式原子：未提交的上传可成为待清理孤儿，但不能先承诺收到再丢文件。
2. 四个抽取 run 并行执行模型效果。每页保留坐标/区域本地键、原始回复与费用。内核接受后调用采纳命令，按来源原件+稳定本地键映射题/提交身份；重投不重复造事实。红笔按偏好单记，不能冒充本人作答。跨页匹配能力以单元 8/23 的实际身份契约为准，不虚构模型总能给稳定区域键。
3. 题面作为内容事实、识别作答作为提交事实，各带来源。已学习者更正的目标 sticky，后续采纳最多产生带 expectedRev 的提议。所有采纳仍是命令，没有抽取 worker 直接写事实的捷径。
4. 两个解答子槽位独立做，解答合并推导比较结果，不一致才请求第三方法；判分、过程质量、错因是分开的公开槽位。第 7 题识别 unknown 被接受为合法识别值，判分等待提交事实修订，持久询问命令只生效一次。
5. 判分生效/新增使相关掌握度 range behind 或原依据 invalidated 后 stale，eager/显式需求安排掌握度。计算是确定性记忆模型；安排 lazy 此刻可显示旧值/待更新而不立刻付费。PRD 口语“判分后掌握度过时”在精确类型上区分新增 behind 和更正 stale，产品看到更新的结果不变。

### §2.2 本人把 D 改 B

1. 同一个更正命令事务追加 S3 rev2、置 sticky。只影响声明 following 的旧判分及其依赖闭包；已发出的 pinned 题面保留。
2. 内核从 manifest 找 G3→M→P；即使 M 已正常 superseded、P 仍 asof 引用旧 M，也能经历史 accepted 行失效。effective 指针清空，last 指针保留；旧值可读但不能让新安排生效。
3. 后台旧候选到达：先拿同一 learner 锁，全量重验范围成员/祖先，拒绝。该结论不靠队列通知先到还是后到。
4. 更正产生判分/掌握度重算需求；正在看的安排或工作单会提出安排需求。新判分、新掌握度、新安排各自生效，原因链保存“来自更正 S3”；UI 只呈现该依据，不自己算传播。
5. 新模型再抽取仍认 D：相同采纳身份命中 sticky，生成提议。不会用另一个 fact ID 绕开 sticky，也不会私下“修复”用户输入。

### §2.3 夜里备课与早上今天

1. 锁屏/离场记录与“明天需要可用安排”的需求触发教研工作单。它等待/读取有效掌握度、following 的目标/25 分钟约束/锁定项；不是每天定时盲跑。
2. 会话经公共槽位请求笔记、五道候选变式及独立验证。草稿先是推导；验证一致后才经采纳命令成为材料事实。会话每步、效果、命令 ID 与材料交付身份均保存。
3. 规划 gather 用截至的统计证据筛候选，固定真实题目/笔记内容，再经模型效果做选择；纯 derive 校验结果/约束，accept 核对依据与锁定项。动态按模型意见继续找材料是会话下一步，不是 derive 暗中读取。
4. 工作单只有在有效安排和其引用的全部可学材料都存在、可访问、验证合格时结束；不能把“已经排 job”当交付。早上读今天是读已备好的安排视图和材料，不启动一条独立的前台规划路径。
5. 模型全挂：相同 PlanSlot 的确定性推导器从已有可学材料生成合规安排，走同一个 accept；旧判断仍可读、失败/过时如实标记。不要求在无材料的空库中凭空生成内容，D08 仍未决。
6. 无新事实、无新需求、无人读取且现有工作已完成时，不创建新 run/效果；短暂崩溃恢复旧 work 不被错误算作“新教研”。时间推进只影响内核显式时钟下的读时记忆投影。

## 9. 可以交给 A/B 共用的输入与预期结果

以下为设计 oracle，**未执行**。使用同一 fixture 构造器生成 ULID；S3/G3/M0/P0 是人读别名。两候选的命令回执、SlotRead、证据树和失败原因必须在语义归一化后相同，不能各选更方便的引用模式或成员粒度。

基线：S3 rev1=D；G3 在 tick20 生效，following S3；G4 在 tick21 生效；M0 在 tick30 生效，范围 W=25、成员 `{G3,G4}`；P0 在 tick40 生效，asof M0、following 目标/约束；旧规划候选 CP 的 gather 同样读取 M0。范围标签均 K，且输入中记录其依据。

| 样例 | 输入/调度 | 必须观察到 |
|---|---|---|
| C01 更正闭包 | tick50 把 S3 rev1=D 改 rev2=B，CP 此后提交 | G3/M0/P0 同一提交 stale，current 指针空、last 值可读；G4 有效；CP rejected，不能靠通知是否已消费决定。 |
| C02 两种并发先后 | 更正事务与 CP accept 同时竞争 learner 行 | CP 先→之后被更正失效；更正先→CP 拒绝。不得出现更正已提交而旧 CP 仍成为有效结果。 |
| C03 新增不饥饿 | 从基线分支，tick50 新 G5，长 M1 仍以 W=25 输入完成 | M1 可接受并 behind；旧 M0 behind；范围不被偷偷扩成三成员，不能无限 rejected。 |
| C04 asof 与 pinned | M1 正常替代 M0；另有 pinned M0 的固定产物 | P0 asof M0 behind，固定产物保持；following M0 的使用者 stale。 |
| C05 先替代后失效 | C04 后再更正 S3，令旧 G3/M0 的依据无效 | 即使 M0 已 superseded，也将 P0 和 pinned M0 的产物 stale；这是只扫 effective 会漏的反例。 |
| C06 范围方向 | W=25 的 G3 在 tick50 invalidated | 范围依赖无效，候选拒绝；不能因 ended_tick=50 不在 W 内而放行。 |
| C07 标签移动 | G3 的归属依据 K 改为 J | 原 range 精确成员 G3 仍被失效；不得按当前 J 标签漏掉原 K 使用者。J 的新快照只接受新版本成员。 |
| C08 空范围 | W=25 时 scope=L 无成员，后有首个合格成员 | 旧空结果 behind；scope=M 的无关新增不影响 L。 |
| C09 缺失与未知 | K 有合格但 stale 的 G3；另一个提交识别 unknown | 范围不得默默丢 G3，等待其稳定槽位；unknown 提交不当 0 分；改提交后判分被唤醒，询问重投只一次。 |
| C10 等待竞态 | gather 发现 X 无值；X 在 waiting 登记前或后生效 | 登记前：锁内复查发现可运行；登记后：X 事务唤醒；两顺序都不能永久 waiting。 |
| C11 失败/撤回唤醒 | 等待 X 时 X error、方法停用或用途撤回 | dependency_error/unavailable/access-denied 明确可读；不伪装 unknown，不无限重试。 |
| C12 固定题面 | Q rev1 已发出并被 pinned，随后 Q rev2 更正 | 历史活动仍显示 Q rev1；following Q 的解答/用途重新计算。撤回/用途收窄对 pinned 也有作用。 |
| C13 访问先撤后恢复 | run 读 access_epoch=a，随后收窄再恢复 | 旧 run 不能借当前 permission 又放宽而生效；须新 run。AI 证据入口也不能读被限制的旧原文。 |
| C14 幂等与 sticky | 同 ID 重放/不同输入；两个不同 ID 同内容提交；重抽取 S3 | 回执复用/拒绝重用；两真实提交两事实；S3 本人修订保持，重抽取成为提议。 |
| C15 撤销 | 新建/更正/撤回/批量采纳后 undo；再加后续本人修改 | 分别追加撤回/前驱/恢复；任何目标修订冲突则整批不写，保留后续本人修改。 |
| C16 效果恢复 | done 后重投；started 后崩溃；会话效果完成但 step 未存 | done 不再次调用；unknown 核对而不盲重付；同一步使用同一 effect owner/key。 |
| C17 世代与重复 ack | 新 handler admission 后旧结果返回；accept 提交后 ack 丢失 | 旧 fence 拒绝；重投 no-op；采纳/事实只一次。 |
| C18 read 状态 | 有效 unknown、stale+pending、empty+error、有效 behind | 返回四种可区分情况；只有有效结果可成为默认 gather 输入；展示旧值不制造有效性。 |
| C19 时间与 shadow | 固定时钟推进三周；shadow 重放同历史 | 读取记忆改变但无日刷 run；shadow 不移动有效指针、不采纳、不触发真实供给，成本与结果单列。 |
| C20 完整旅程 | 四原件/九题/一未知→S3 更正→离场备课→模型全挂 | 有材料条件下确定性安排仍可学；产品表面保留真实原件、失败、成本与未知，不用固定样例冒充照片识别。 |

共同输入还须包含多学习者隔离的反例、无关范围新增、一次事务多事实修订、同 tick 的采纳与失效。所有等待/并发/队列事务行为必须用真实 PostgreSQL；单连接 PGlite 只验证它能验证的状态机。

## 10. 性能与比较：量什么，怎样否证

### 10.1 规模与分布

以下是实验档位，不是声称真实学习者已有这些数量：

| 档位 | 判分/提交 | 知识点 | 每范围成员 | 用途 |
|---|---:|---:|---:|---|
| 小 | 100 / 100 | 20 | 0、1、10 | 逐事件检查共同 oracle |
| 接近长期使用假设 | 10,000 / 10,000 | 500 | 中位 20，热点 1,000 | 主要比较档，需由真实采样修正 |
| 压力 | 100,000 / 100,000 | 2,000 | 热点 10,000，重尾 | 检查清单/历史积累的拐点，不自动转成产品指标 |

必须再变化：链深 3/10/50、单源扇出 1/100/10,000、同一槽位保留 1/10/100 个历史版本、1%/10% 更正率、5%/50% 采纳后手工改动、范围 scope 移动、空/未知/撤回、1/4/16 个并发 worker、持续新增证据。A/B 使用同样值、引用语义、成员集合、队列库/配置、硬件和事务数据，分数据库或干净快照串行运行，不能共享写环境互相扰动。

### 10.2 必报指标

- **正确性先行**：共同 oracle 通过率；漏失效、错误失效、旧候选误接受、重复事实、跨用途读取、等待丢失、付费 unknown 的计数。任一不可解释错误即否证，不能用更快平均数抵消。
- 更正命令端到端与纯 DB 提交 p50/p95/p99；锁等待时间、锁持有时间、传播闭包大小、SQL 次数、扫描行/索引命中、缓冲区和 WAL。
- candidate accept 校验耗时、迟到/输入变化拒绝率、连续新增时首个可接受截至结果所需时间；不只是测重试次数。
- range 读取/展开/有效性重验/behind 检测耗时；manifest 字节、JSONB TOAST、GIN 体积及更新放大、历史 superseded 扫描成本；内存峰值和 Python IPC 包大小。
- 需求到首次执行/等待到唤醒延迟、重复投递数、fencing 拒绝数；重启与上述每个故障点恢复时间、人工核对次数。
- provider 实际调用数/原始费用/unknown 费用暴露；确定性联调与真实照片模型耗时分别报告。
- 实现复杂度：内核实际行数（≤15,000）、独立状态表示与恢复分支数、新命令/推导器触碰文件数，维护者是否必须懂反向边维护；不能只数表少几个。
- §2.1 四页 2 秒收件/半分钟结果、§2.2 更正几秒可见、§2.3 早上已备好，须在真实 Web/实际原件上单列达成情况。本文没有达成这些目标的证据。

主代理应在跑结果之前预登记可接受的 DB 锁预算、数据档位与回归容限；现行规格没有 p99 锁预算，本文不擅自把一个数字当 owner 要求。先记录分布再定标准会偏向胜者。

### 10.3 与实质不同方案的取舍

| 方案 | 对决定有意义的优势 | 代价 / 不能掩盖的约束 |
|---|---|---|
| A：直接查询 manifest（含物理 GIN） | 一份依赖语义；输入解释、校验、传播读同一清单；不用修复边表双写；容易给出准确成员 oracle。 | 存储重复、历史清单检索与递归核验较重；热点传播可能占住唯一 learner 锁。 |
| B：由内核同事务维护独立依赖索引 | 反向邻接/范围定位通常可减少待扫描数据，但须实测；大扇出可能更容易批处理。 | manifest 与边/范围索引须闭包一致；回填、旧历史、写放大和恢复是新责任。若只索引 current，C05 同样失败。 |
| 纯读时递归推算 stale、异步后台标记 | 写事务可能短。 | 不满足本候选沿用的同事务失效与需求/唤醒登记；容易使无人读取时不备课。不是等价的小优化，若选需重新证明完整产品结果。 |

A 的最小优化顺序：参数化批量 containment、合理索引、同事务 frontier 去重、批读输入校验；不要首先加跨事务缓存、领域专属反向表或异步传播。如果 A 的成本不能满足主代理预登记的预算，而 B 通过相同 oracle 且恢复复杂度可控，选择 B 有直接依据。两者都失败则回到 PRD §11，不靠减少更正传播范围获得漂亮成绩。

## 11. 迁移、回滚与交接

当前没有代码/真实学习数据，所以没有旧库迁移，也没有理由读取旧项目。单元 0 的最小文档修订应集中在 kernel-design/GLOSSARY，保留 PRD 的产品结果；主代理整合两份候选以后再写，不由本咨询直接修改。

进入比较实验后：

1. 冻结共同语义/fixture 与 manifest schema 版本，不冻结 A 的存储实现；A/B 可以用不同数据库和索引布局，公共命令/SlotRead/证据结果一致。
2. 从同一事实修订、推导与运行证据快照构造两种实验。B 的索引应能从 manifests 回填并核对；切回 A 应能停止读边表而不改变业务依据。不得为了迁移丢弃 superseded 历史。
3. 真正切换前停派新 work，排空或按 generation/fence 作废在途 run，明确处理 started/unknown 效果；保留 completed 结果。不要在两种实现上同时接受同一槽位。
4. 回滚保留原 schema/原始证据及兼容读；若语义/schema 不兼容，做停写恢复，不承诺热切。简单改模型配置不等于能恢复已经失效的旧 accepted 推导。
5. 单元 25 通过后仅保留胜出的生产路径，实验实现可留在测试/实验边界，不能变成永久的第二事实写入口或两个 accept 引擎。

本次交给主代理的事项：选择共同语义、审查 scope/资格投影样例、准备真正 PostgreSQL/队列能力试验、预登记比较预算，然后整合必要规格修订。执行与最终验收由主代理负责，本报告不代表用户已经接受候选 A。

## 12. 尚未解决的语义与需要实测的项

**无需 owner 再裁决、由单元 0/后续契约负责人核清的项：**

- scope/eligible 的声明式投影究竟允许哪些公开输入，如何保证投影依据全部进入 manifest；必须用“知识点更正、未知→已知、帮助曝光从无到有、跨页抽取匹配”共同样例审查。本报告给出机制与失败边界，但还没有冻结具体 DSL/type schema。
- 成员清单、历史 accepted 扫描、递归有效性重验在真实长期规模下的体积/锁成本；SQL 索引计划与 PGlite 支持范围；全部 NOT_RUN。
- 候选队列库的调用方事务接入、去重/重投/异常分类、投递身份及 fencing 能力；lease 过期但新世代尚未 admission 的共同 oracle 必须统一。本文给出了默认线性化语义，不假定库已经支持。
- `GatherPlan` 的 effect 输出 schema 与 TS/Python 固定包、恢复版本兼容；provider 对 unknown 的真实查询/幂等能力。无法查询时保留 unknown，不承诺自动解开。
- 收件对象存储的耐久确认、稳定区域键及重抽取身份匹配、关联题和作答的领域规则；不能用本报告的示意键冒充已解决真实图像匹配。
- AI 历史读取的用途策略与 transitive source 检查：基线要求引用推导的事实叶子也允许当前消费用途，受限旧摘要不通行；具体允许集合以公开事实用途语义为准。学习者检查自己保存的材料与 AI 推导使用不能混成同一 actor。
- 自失效采纳或循环需求的诊断方式、最大重试/预算默认值和纯接受规则的执行时间上限。这些应在内核类型/实现边界中定，不在模块私设兜底规则。

**确实需要 owner 的产品范围选择：** D08 空库且无模型时交付什么，D06 永久删除与历史/离线副本边界，D10 危机转介范围，以及未来 D01/D03 扩展身份/编辑体验。它们不阻塞本候选已有材料条件下的 §2.1–2.3 内核比较。本轮不请求 owner 重选已经确定的四构件、单 PostgreSQL、gather/derive 或同学习者串行化。

**确认 A 的证据**应是共同 oracle 全过、真实 PostgreSQL 并发/队列原子登记通过、长期规模成本在预登记预算内，以及真实四页→本人更正→材料齐备旅程完成。**否证 A 的证据**包括任何 stale 依据误生效、C05/C06/C10 失败、scope 需要模块查库才表达、只保存材料进入 AI、队列登记丢失或锁/清单成本超预算。当前没有这些运行结论；只有可实现性分析与待验证假设。
