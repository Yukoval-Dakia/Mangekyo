# Mangekyo 内核设计规格

2026-11-17｜目标规格，包含 ADR-0007/0008 与完整产品范围；现有代码不代表已满足新规格。内核应通过 §14 的不变量及产品规格反例；PRD/产品规格为上位要求，本文给实现细节。单元2/34/40须完成迁移，不能把下面目标DDL当作已部署schema。

术语见根 `GLOSSARY.md`。所有 ID 用 ULID；JSON 用 `jsonb`；时间戳 `timestamptz`。

## 1. 实现约定

- TypeScript，Node ≥ 22（可直接跑 `.ts`，或用 vitest）。代码里不写 enum、参数属性；相对导入带 `.ts` 后缀。
- 所有数据库访问收在一个 `Db` 接口后面：`query` / `tx`。两个实现：`pg`（生产）和 `@electric-sql/pglite`（测试）。SQL 一律手写，不用 ORM。
- 输入输出 schema 用 zod。内核表里存的是已校验过的值。
- 内核不 import 任何模块；模块经 `kernel` 包的公开入口 import 类型与 `ctx` 接口。
- 表、状态和命令参数中的布尔值不得组合出非法状态。状态用文本判别值或独立行表达，具体 TypeScript 类型用判别联合。

## 2. 数据表

每个学习者一行账本记录。所有状态写入先在事务里 `SELECT ... FOR UPDATE` 学习者行，使同一学习者的所有写入串行。只有实际改变领域状态的事务才 `UPDATE clock = clock + 1` 取得刻度（tick）；幂等重放、失败校验、纯读取和 `waiting` 登记不推进刻度。

刻度是每个学习者的逻辑时钟，只表达提交因果顺序，不表达现实时间。每个事实修订、每次推导生命周期变化、每次命令回执和效果状态变化都带着它。写入事务不能运行模型、执行推导或等待外部服务。

```sql
learners(id pk, clock bigint not null default 0)

facts(
  id pk, learner_id, type text,
  current_rev int,
  access_epoch bigint not null default 0,
  purpose text[] not null,
  sticky boolean not null default false,
  retracted_rev int,                              -- null 或当前撤回修订
  created_tick bigint, changed_tick bigint,
  unique (id, learner_id)
)
fact_revs(
  fact_id, learner_id, rev int, data jsonb,
  purpose text[] not null, sticky boolean not null,
  source_derivation_id text,
  kind text,                                      -- 'value' | 'retraction'
  author text,                                    -- 'learner' | 'companion' | 'adopted:<derivation_id>'
  command_id text, tick bigint,
  corrects_rev int,                               -- 更正的前驱；创建为 null
  pk (fact_id, rev),
  foreign key (fact_id, learner_id) references facts(id, learner_id)
)
commands(
  id text, learner_id, type text, input jsonb,
  state text,                                     -- 'done' | 'undone' | 'proposed' | 'rejected'
  receipt jsonb, tick bigint,
  undo_command_id text,
  pk (learner_id, id)
)
proposals(
  command_id text, learner_id,
  source_derivation_id text,
  input jsonb,
  state text,                                     -- 'pending' | 'confirmed' | 'rejected' | 'conflict'
  created_tick bigint, decided_tick bigint,
  error jsonb,
  pk (learner_id, command_id)
)

derivations(
  id text, learner_id, slot_type text, slot_key text,
  deriver text,
  scope_keys jsonb,
  value jsonb,                                    -- {kind:'value',...} | {kind:'unknown',reason}
  lifecycle text,                                 -- 'candidate' | 'effective' | 'superseded' | 'stale' | 'rejected' | 'failed'
  freshness text,                                 -- 'current' | 'behind'
  gather_tick bigint,
  effective_tick bigint, selection_ended_tick bigint,
  invalidated_tick bigint,
  manifest jsonb, error jsonb,
  is_shadow boolean not null default false,
  check (lifecycle <> 'effective' or effective_tick is not null)
)
slot_state(
  slot_type text, slot_key text, learner_id,
  current_id text references derivations,         -- 可支撑新输入的当前值；失效时清空
  last_id text references derivations,            -- 最近可读的生效值；失效后保留
  pending text,                                   -- 'none' | 'queued' | 'running' | 'waiting'
  last_error jsonb,
  changed_tick bigint not null default 0,
  scope_keys jsonb,
  evidence_eligible boolean,
  pk (slot_type, slot_key, learner_id)
)
work(
  id text, learner_id, slot_type, slot_key, deriver,
  state text,                                     -- 'ready' | 'waiting' | 'satisfied' | 'cancelled' | 'blocked' | 'unavailable' | 'denied'
  gather jsonb, gather_manifest jsonb,
  generation bigint, execution_ref text,           -- 领域工作代次及Temporal关联，不是执行租约
  unique (slot_type, slot_key, learner_id)
)
work_outbox(
  learner_id, intent_id text, work_id text, generation bigint,
  state text,                                     -- 'pending' | 'delivered'
  pk (learner_id, intent_id)
)
work_waits(
  learner_id, work_id text,
  slot_type text, slot_key text,
  observed_change_tick bigint,                    -- 登记时目标的 changed_tick
  pk (work_id, slot_type, slot_key)
)
effects(
  owner_kind text,                                -- 'derivation' | 'session'
  owner_id text, step_key text, label text,
  input_digest text, provider_effect_id text,
  state text,                                     -- 'started' | 'done' | 'unknown'
  result jsonb, error jsonb,
  started_tick bigint, ended_tick bigint,
  pk (owner_kind, owner_id, step_key, label)
)
```

所有表都含 `learner_id`。所有按 ID 的读取、写入和外键定位都必须同时匹配学习者作用域。上表省略的重复列不表示可以省略作用域。

`shadow` 产物使用同一不可变值与 manifest 结构，但 `lifecycle='rejected'` 不足以表达它，所以持久化时使用独立的 `is_shadow=true` 和非生效生命周期。它不写 `slot_state`、不传播、不采纳、不触发后续工作。

`facts.purpose` 在学习者未确认默认偏好时为 `'{storage}'`，只允许本人保存/回看，不能默认 `all`；已确认的默认用途由命令边界显式写入。每次事实修订保存当时用途，当前用途保存在 facts 与当前修订。收窄按 §6 传播，扩大只影响新读取，不恢复旧推导。`pinned` 不能绕过用途、学习者作用域、撤回或永久删除。用途与保存策略分开：仅本轮使用的聊天可本人回看但不进下一轮模型；不留存临时使用独立可清除载荷，细节见 §16。

用途收窄、撤回和用途恢复都推进 `access_epoch`。manifest 保存读取时的 epoch；即使之后恢复相同用途，旧候选也不能凭当前权限生效，必须重新 gather。事实的普通内容更正不推进 epoch。

采纳事实继承来源允许用途的上界，不能借采纳扩大访问。内核在 manifest 中保存来源用途见证；用途收窄沿直接和间接来源传播。读取推导值、采纳事实和证据视图时，内核检查其来源链的当前用途。学习者的历史证据读取与 AI、推导器的计算读取使用不同 actor 权限，但任何路径都不能把“只保存”内容交给推导器或模型。

## 3. 模块能声明的四种东西

每个模块是一个包，只有一个公开入口导出 `defineModule({...})` 的结果。目录约定：

```
modules/<name>/
  module.ts           唯一入口：export default defineModule(...)
  facts/*.ts          每个文件 default export 一个 defineFact
  slots/*.ts          每个文件 default export 一个 defineSlot
  commands/*.ts       default export 一个 defineCommand
  derivers/*.ts       default export 一个 defineDeriver
  blocks/*            界面块
  samples/*.json      推导器的输入/输出样例
```

加载是约定：内核扫上述目录 import 全部文件，**没有任何登记表**。

```ts
defineFact({ type, schema, correctableFields?: (fact)=>jsonpointer[] })
defineSlot({ type, key: (input)=>string,
             triggers: Trigger[],
             policy: 'eager'|'lazy',
             accept?: (ctx, candidate, current)=>{ok:true}|{ok:false,reason},
             adopt?: (value)=>CommandInput[],
             present?: (value, at)=>unknown,
             })
defineCommand({ type, schema, destructive: boolean,
                read?: (ctx)=>...,
                write: (ctx, input, read)=>FactWrite[] })
defineDeriver({ name, version, slot,
                gather: (ctx, slotKey)=>GatherInput|Waiting,
                derive: (input)=>value|Promise<value>,
                })
```

`destructive` 是必填字段。槽位声明属于推导器构件，不增加第五类模块能力。

`defineDeriver` 的 gather/derive 分离是硬性的：gather 在控制进程内经 `ctx` 做记录式读取并产出可序列化数据与声明式效果请求；derive 只收到内核补全效果回执后的固定输入包。内核先关闭 gather 快照，按 §9 账本执行效果，再把回执并入固定输入。需要动态再读的 agent 工作拆成子推导或进入会话，不能给 derive 增加 tools 或任意效果回调。

## 4. 命令执行（唯一写路径）

```
handle(learner, actor, command{id, type, input}):
  if commands 已有 (learner,id) 且 state='done'|'undone'|'rejected':
      type 与规范化 input 相同 → return 存的 receipt
      不同 → 拒绝（id 重用）
  validate input
  if actor 是 AI 且 cmd.destructive:
      在短事务创建 proposal 与 proposed receipt，不执行 write
      return proposal receipt
  execute(learner, actor, command):
      tx:
        lock learner; tick = ++clock
        r = cmd.read?.(ctx)          -- 检查 purpose，记录命令证据读取集
        writes = cmd.write(...)
        先校验全部 writes，再原子应用
        对每条 write:
          create：若稳定事实 ID 已存在，命令失败；采纳重放走原命令回执
          correct：要求 expected_rev 仍 current；追加 value 修订
          retract：要求 expected_rev 仍 current；追加 retraction 修订
          set_purpose：要求 expected_rev 仍 current；追加原数据与用途变化
          sticky 采纳：只创建 proposal，不追加事实修订
        run slot 触发器（§7）
        传播过时（§6）
        存 handled receipt，包含 wrote、proposals 与 output
      return receipt
```

命令采用规范化 JSON 做同 ID 输入比较。对象键顺序不影响相等性，数组顺序保留。命令重放在锁外先查，未命中后进入学习者锁内再查，避免同 ID 并发产生两个写入者。

`correct` 必须由学习者命令声明，追加修订时把 `sticky=true`。采纳只在事实仍非 sticky 且当前修订与该采纳来源匹配时写入。学习者确认提议时重新执行原命令校验；事实已变化则返回冲突，不覆盖。

确认提议时，handle 内部走 `execute`，成功后将原 commands 行从 `proposed` 改为 `done` 并保存实际回执。拒绝时只改为 `rejected`。confirm 本身也是带独立 ID 的命令，可重放。直接重复提交原命令 ID 不能绕过提议状态。

## 5. gather → derive → accept

`ctx.read` 提供三种读取，全部计入输入清单（manifest）：

| 读取 | 记录 | 生效时有效的条件 |
|---|---|---|
| `fact(id, mode:'pinned'\|'following')` | `(fact_id, rev, access_epoch, mode)` | `pinned` 接受该不可变修订，即使事实后来更正；`following` 要求仍是 current_rev；用途收窄使两者都失效 |
| `slot(slot_type, slot_key, mode)` | `(slot, derivation id, mode)` | 见下方规则 |
| `range(slot_type, scope, watermark)` | `(slot_type, scope, watermark, members[])` | watermark 内无成员失效，成员集合仍符合范围语义 |

- 固定事实引用用于已经发出的题面等历史内容。事实更正后，旧修订仍可按身份读取。事实撤回使 pinned 与 following 输入都失效；旧修订只能作为撤回命令的证据读取，不能继续作为学习内容。来源本身需要撤除时，由另一个 `following` 来源引用或显式接受规则表达，不能把 `pinned` 偷偷改成跟随。
- `slot pinned` 引用推导本体。该推导 stale 或被接受规则 rejected 时引用失效；正常 superseded 不失效。
- `slot following` 要求 `slot_state.current_id` 仍等于清单中的 derivation ID。
- `slot asof` 引用一个历史值。该推导 stale 或被 rejected 时引用失效；正常 superseded 只使 freshness 变为 `behind`。
- `range` 的 `scope` 是槽位定义生成的结构化、可序列化键，例如 `{knowledgePoint:'K'}`。成员是 gather 快照内属于该 scope、具备证据资格且 `slot_state.current_id` 指向的 derivation。watermark 是 gather 时学习者的 clock。清单保存实际成员集合、scope 和每项来源位置，供生效复核。失效或 superseded 后仍保存成员身份，不能用当前标签重建旧范围。
- 范围选择器、证据资格和 `scope_keys` 都来自槽位公开类型与已记录输入。槽位目录由内核在更正或生效事务内更新，模块不维护另一张关系表。旧推导保留当次 `scope_keys`，知识点归属更正通过 following 输入使旧成员失效，不能原地改写历史标签。
- 具备证据资格但 current 为空的槽位是明确缺项。严格范围读取返回 `Waiting`，不能静默丢掉失效判分后算出看似改善的掌握度。空范围是合法集合，后续首个合格成员使旧结果 behind。尚未识别作答不具备判分资格，保持 unknown，不折算零分。
- 对 range，watermark 内已收集成员失效使输入失效。watermark 后新增成员或把原已失效成员重新生效，只使 freshness 变为 `behind`。watermark 后新成员失效不回头破坏已经固定的快照，但会使下一次 gather 得到不同成员集合。watermark 后成员被移出 scope 只影响 freshness；watermark 内已有成员被移出 scope 等同失效。新增候选或 shadow 不属于 range。
- gather 在一个 `REPEATABLE READ` 快照内读取 learner clock、所有输入和 range 成员，并记录 `gather_tick`。固定事实读取验证该修订存在与用途；following 读取只接受当前修订。当前槽位没有可用值时返回 `Waiting`，不能生成缺输入的候选。
- derive 执行期间不再读数据库。worker 在 derive 前把不可变 derivation 候选行及其 manifest 持久化， derive 成功后填值，失败记录 `failed`。该候选不是有效输入。

accept（worker 提交候选）：

```
tx:
  lock learner; 复查 work.id/generation 和取消/删除/用途代次，旧代次拒绝
  重验 manifest 全部输入与 gather_tick
  任一失效 → lifecycle='rejected'，当前工作重新 ready 并重新 gather
  slot.accept?(...) 不通过 → lifecycle='rejected'，槽位记录 error
  tick = ++clock
  旧 current（若有）→ superseded(selection_ended_tick=tick)
  新 derivation → effective(effective_tick=tick)
  slot_state.current_id、last_id 指向新值，pending 清除
  asof/range 的新增变化 → freshness='behind'，否则 'current'
  传播本次 current 变化（§6），唤醒等待者（§7）
  以内部命令执行 adopt；采纳写与接受同事务、同 tick
```

## 6. 过时传播（与写入同事务，锁定学习者后执行）

每次事务里发生变化就处理一次，直到没有新 stale：

- 普通事实更正 → 含该事实 `following` 输入的 candidate/effective → `stale`。`pinned` 事实输入不因更正失效。用途收窄或事实撤回 → 含该事实任意输入的 candidate/effective → `stale`。
- 推导变 `stale` 或被接受规则 `rejected` → 记 `invalidated_tick`，含它 `pinned`、`asof` 或 `following` 输入者 → `stale`；含它的 range 成员输入者 → `stale`，无论失效事件发生在 watermark 之前还是之后。
- 推导被新值正常 `superseded` → `following` 依赖者 → `stale`；`asof` 和 `range` 依赖者 → `behind`。旧值的 `last_id` 保留，但 `current_id` 先移动到新值。
- 当前推导失效时，同一事务把 `slot_state.current_id` 清空，`last_id` 继续指向它，`last_error` 说明原因。历史旧值不能重新成为 current。
- 每次置 `stale` 或 `behind` 后检查槽位 policy。`eager` upsert work；`lazy` 只保留状态。

`behind` 不沿依赖边传播。若下游使用 `following` 引用上游，它会在上游重算生效时自然 stale；若下游使用 `asof` 或 range，它只在上游新值生效或 range 出现新成员时变为 behind。上游自身 behind 不等于下游 behind。不得为了让状态简单而把两种语义合并。

被采纳事实另有 `following` 来源引用。来源推导失效后，这条来源引用传播给需要最新来源的判断。已发出的固定题面不因此被改写，但读取界面必须同时展示来源失效状态。

## 7. 槽位的出现、等待与调度

- 槽位的 `triggers` 描述 `fact`、`slot` 和 `always` 三类需求。触发事件 upsert work，每槽位至多一条活动 work。
- `work`、`work_waits` 只拥有领域需求合并、依赖见证和工作代次。需求变化在同一PG事务登记稳定 intent_id 的 outbox；幂等 relay 将它交给稳定 work_id/generation 的 Temporal 执行。允许启动成功后确认丢失并重投，不能丢工作。
- Temporal 唯一拥有执行进度、租约、重试、超时、步骤等待、并行和版本路由；内核不实现 claim/租约回收循环，不叠 pg-boss。Temporal 状态可以投影显示，但不得让另一个游标同时决定下一步。短事务不调用 Temporal 网络接口。
- gather 缺少 slot 或 range 输入时返回 `Waiting` 和所缺槽位身份。内核在新的学习者写事务中重新检查所缺槽位。条件已满足或 `changed_tick` 已不同于 gather 见证时直接置 ready；否则写 `work_waits.observed_change_tick=slot_state.changed_tick`，再把 work 置 waiting。等待登记自身不推进 tick。
- 每次槽位 current 变化、失效、失败、禁用或用途状态变化都在对应领域写事务内推进 `changed_tick`。唤醒谓词是目标的当前状态或 `changed_tick` 不等于登记见证，不比较未来 tick，也不靠事件是否送达。
- 唤醒在同一事务删除或原子替换旧 wait，将 work 置 ready 并重新 gather。若目标永久失败、禁用或撤回，work 记录 blocked、unavailable 或 denied；不得永久等待一个没有可用推导器的槽位。
- 若目标槽位在检查到写入等待之间变化，学习者行锁使这两个操作与变化串行。目标先变化时登记复核发现见证不同，等待先登记时目标事务找到 waiter。恢复时也能按持久见证检查，不依赖内存通知。
- work/waits 为唯一领域需求见证，Temporal 历史为唯一执行恢复权威；条件变化同事务登记 outbox，消息只加速处理。恢复可按持久见证复核需求，再由引擎调度；不是每次进程重启都重新执行已确认步骤或收费效果。取消/删除/新代次后的旧 Worker 返回仍须拒绝生效。

## 8. 采纳、提议、撤销

- `adopt` 把生效值映射为内部命令。稳定事实 ID 由模块从来源身份与本地键确定。相同来源重放返回原回执，新推导产生新命令，不能按输入内容合并两次真实提交。
- 非 sticky 事实的后续采纳可更正它。sticky 事实收到采纳写时只创建提议，提议包含候选数据和来源；确认时重新校验当前修订。
- AI 的 destructive 命令与 sticky 采纳提议共用 `proposals`。提议可确认、拒绝或标记冲突，不能直接修改事实。
- `undo(command_id)` 是学习者发出的普通命令，带自己的 ID 和回执。只有已执行的 handled 命令可撤销；提议先拒绝，不存在撤销。
- 撤销在一个事务内原子检查原命令写入的每条事实。每条 current_rev 仍等于该命令写入的 rev，且期间没有后续用途变化或 sticky 修改，才允许撤销。
- 对创建追加 retraction；对更正追加前驱 value；对 retract 追加被撤回的 value；对用途变化恢复前用途。所有写入都是新修订，旧修订保留。
- 任一目标已有后续修订时，整条 undo 返回 `conflict`，不写任何事实。界面先展示冲突，学习者之后用新的更正命令处理。不能跳过冲突项或覆盖后续本人改动。
- undo 只回退该命令产生的事实状态。它已经触发的其他命令、外部效果和后来的独立事实不级联删除；依赖经普通 stale 传播重新计算。对 undo 再做 undo 时，还原该 undo 写入的修订，形成 redo 的新修订链。原命令保留 `undo_command_id`，同一命令不能有两个已执行 undo。
- 永久删除不是 retract/undo。按 §16 在明确确认后销毁载荷；对已销毁事实/命令的旧请求只返回不含原文的已删除状态，不恢复回执、前驱修订或效果结果。

## 9. 效果账本

`effect(stepKey, label, input)` 是 gather 返回的声明式请求；会话上下文也可返回同一请求结构。内核而非模块执行实际 provider 调用：

- `owner_kind='derivation'` 时，`owner_id` 是 gather 开始前由内核分配的 derivation ID。`stepKey` 是推导器声明的稳定步骤名，不是运行次数。会话使用稳定的 session ID 和持久化步骤键。
- `input_digest` 是规范化输入的摘要。同 key 不同输入拒绝执行，避免恢复后把旧结果配给新输入。
- 已 `done` 且摘要相同，直接返回保存的结果。已 `started` 或 `unknown`，返回结果未知并要求 provider 核对；没有可核对结果前不能盲目再次收费。
- 未开始时，先在独立短事务写 `started` 和 provider 可用的幂等键，再执行内核能力。成功后写 `done+result`，异常或返回丢失写 `unknown`。
- `started` 只表示本地未观察到完成，不证明 provider 未执行。provider 是否提供幂等或查询能力是网关适配器的实测属性。
- 效果状态变化使用学习者锁和 tick，但不与命令的未完成长事务混合。重试必须先读账本。

## 10. 读路径与时间

- `read(slot_type, slot_key)` 返回一个判别联合：`current` 表示可支撑新输入的值；`stale` 返回 `last_id` 的值和失效原因；`pending` 可带 `last_id`；`missing` 表示从未有值；`error` 表示当前无法计算。
- `current` 可带 `freshness='behind'`。`stale` 不能再同时称为 current。`unknown` 是值内部的成功结果，不是 pending 或 error。
- lazy 槽位在没有 current 或需要更新时，读取可在事务中登记 work，然后返回 pending 或 stale。已有 current 且 freshness 为 current 的纯读取不写数据库。
- `trace(derivation_id)` 返回不可变值、manifest、生命周期、错误和来源。`fact(id, rev)` 按修订读取。二者都经学习者作用域和用途检查，模块不能自行查库。
- 读取历史值不重新生效，也不自动把来源失效的内容用于新推导。界面可同时显示当前无有效值与最近旧值。
- 槽位值只保存可序列化领域状态。需要随时间展示时，槽位声明 `present(value, at)`，由内核传入读取时刻。`at` 是 ISO 时间戳或其解析后的领域类型，derive 不读时钟。
- `present` 必须对相同 value 和 at 返回相同结果。记忆模型保存状态与所需方法版本，读取时计算当前强度，不保存函数，也不日刷。
- 事实或推导需要现实时间语义时，其公开 schema 必须显式声明规范化的 `occurred_at`。它表示学习经历实际发生的时间，离线命令可携带过去值；内核另存 `recorded_at` 表示服务端首次接收时间。两者都是带时区的 RFC 3339 UTC 时间戳，数据库用 `timestamptz`，JSON 保留毫秒精度。
- 客户端发生的经历由命令输入提供 `occurred_at`，服务端发生的经历由内核在边界注入统一时钟。derive 和 `present` 只能使用固定输入中的时间。范围 watermark 仍只使用 tick，不使用 occurred_at；按现实时间筛选必须使用显式类型化字段，不能用 tick 或 recorded_at 代替发生时间。
- 重放保留原 `occurred_at` 和 `recorded_at`，恢复时为新的服务动作生成新的 `recorded_at`。实验通过注入固定时钟复现，不能从 ULID 或 tick 推测现实时间。

## 11. 执行环境

- `in-process`：`await deriver.derive(input)`，同进程（TS）。
- `worker`：进程外子进程，行分隔 JSON 协议：`{id, deriver:'module/name@version', input}` → `{id, value}` 或 `{id, error}`。Python 端提供 `python/mangekyo_derive/{module}_{name}.py`，每文件一个 `derive(input)`。长驻进程，按 id 匹配响应。
- worker 协议无 tools、model、环境变量或读取。需要外部效果时在 gather 完成，并把结果放入 input。
- 超时、崩溃和执行尝试由 Temporal 处理；已确认步骤复用，实际需要重新读取时才重新 gather 并形成新清单。领域工作代次失效后迟到候选不能生效。耗尽重试后槽位进入 error，允许的旧值按历史规则读取，删除后的正文不得读取。

## 12. 仓库与边界

```
kernel/        本规格的代码
modules/*      每个一个 workspace 包，exports: {".":module, "./facts/*","./slots/*"}
executors/python-worker/   §11 子进程宿主
python/mangekyo_derive/    Python 推导器（uv 管）
scripts/       new-module / new-deriver 生成器、check-structure
surfaces/web   界面
```

- 依赖方向硬规则：`modules/*` 只能依赖 `kernel` 与其他模块的 `./facts/*`、`./slots/*` 子路径；`kernel` 不依赖任何模块；`executors` 只依赖 `kernel`。
- 检查脚本 `scripts/check-structure` 静态扫 import 路径违例 + 行数上限（kernel、每模块及 runtime 总计各 ≤1.5 万行，不含测试）。这是仅有的两条结构检查。
- 生成器产出可编译骨架 + 有区分力的 sample + AGENTS.md 模板（一页内）。

## 13. 两种实现的共同比较协议

候选 A 直接查询不可变 manifest 找依赖者。候选 B 在候选持久化时同事务写独立依赖索引。二者必须实现同一公开接口、数据库语义和以下样例，不能用不同的产品行为迁就实现。

两种实现都在 gather 后、外部效果前封存 manifest，并在学习者锁内复核后再允许付费调用。候选 B 在同一事务把 manifest 规范化为直接依赖边和 range 订阅，不维护传递闭包。候选 A 需要与这些边等价的 JSONB 查询策略和索引。二者都必须保留正常 superseded 的历史推导，因为 pinned 和 asof 引用仍可能指向它。shadow 不进入生产传播索引。

候选 B 必须满足 `stored_edges = normalize(manifest)`，索引可从 manifest 重建。accept 不能只检查索引是否标脏，仍要逐项复核 manifest。候选 A 不能用全表扫描次数较少的小样例宣称可扩展。

共同输入是一条“原件 → 抽取 → 采纳题目和提交 → 判分 → 掌握度 → 安排”的链。先保存固定四页九题的联调样例和一份真实旅程记录位置。两种设计都解释 §2.1 交入与抽取、§2.2 更正与并发旧候选、§2.3 备课与无模型兜底。真实模型效果留到对应工作单元，不在本阶段伪造。

固定比较项：

| 编号 | 操作 | 必须观察的结果 |
|---|---|---|
| S01 | 题面 rev1 被 pinned 引用，随后产生 rev2 | 已发题面仍读 rev1；following 来源链 stale |
| S02 | 更正提交后，旧判分候选到达 | 候选 rejected，不覆盖新事实 |
| S03 | 判分更正，掌握度随后产生新值 | 安排若 following 掌握度则 stale；asof 则 behind |
| S04 | range 已收集，watermark 内成员失效 | 新候选 rejected |
| S05 | range 已收集，watermark 后新增成员 | 当前值 behind，可继续支撑 asof 语义 |
| S06 | 缺少槽位时登记等待，同时目标生效 | 无丢失唤醒 |
| S07 | sticky 事实再次收到采纳 | 只产生提议，当前修订不变 |
| S08 | undo 的原写入之后没有新修订 | 原子追加还原修订，旧值可读 |
| S09 | undo 的任一目标已有后续修订 | 全命令 conflict，无部分撤销 |
| S10 | 效果 done 后恢复 | 返回原结果，不再次调用 provider |
| S11 | 效果 started 后进程消失 | 返回 unknown，可核对，不盲重付 |
| S12 | 当前推导失效后读取 | current 为空，last 可读，不能支撑新结果 |
| S13 | 三周休眠后以固定 at 读取 | 不重放、不日刷，同一 value 与 at 结果确定 |
| S14 | 相同命令并发重放与两次真实提交 | 前者一次，后者两条 |
| S15 | 用途收窄后又恢复，旧候选到达 | access_epoch 不同，旧候选 rejected，重新 gather |
| S16 | 范围成员在 watermark 后被否定 | 旧成员身份使命中，候选 rejected，不能要求 invalidated_tick ≤ watermark |
| S17 | 合格范围成员当前失效，另一提交为 unknown | 严格范围等待缺项，unknown 不当零分，不静默缩小证据集合 |
| S18 | 先正常替代，后旧推导失效 | superseded 历史仍传播 stale 给 pinned/asof 后代 |
| S19 | 目标在等待登记前后失败、禁用或撤回 | 两种顺序都得到明确终态，不永久 waiting |
| S20 | 离线晚到的 occurred_at 与 tick 顺序不同 | range 因果水位仍按 tick，现实时间筛选按 occurred_at，不互相冒充 |

实现阶段在相同数据、硬件和 PostgreSQL 配置下记录：

- 事实、修订、推导、每槽位平均输入数和 range 成员数。
- 单次更正的传播行数、SQL 次数、锁等待和事务延迟。
- accept 的输入复核成本、旧候选拒绝率和并发冲突结果。
- 每十万推导的 manifest 查询与索引存储成本、索引写入成本。
- 进程在 gather、derive、accept、采纳和效果各边界中断后的恢复结果。
- 内核代码量、公开类型数量和实现一处新槽位所需接触的文件数。

单元 0 只确定实验协议。单元 25 才根据实际结果选择实现并移除另一生产路径。

## 14. 不变量（必须写测试）

普通历史读取保证受用途、撤回与§16永久删除优先级约束；以下“旧值可读”不允许取回已销毁正文。

1. **更正-生效竞态**：更正已提交、旧候选到达 → rejected；同时发生 → 有确定先后。
2. **传递过时**：更正 → 判分 stale → 掌握度 stale → 安排 stale；读旧值仍可读。
3. **asof 语义**：掌握度被新证据 superseded → 安排 behind 而非 stale；掌握度被 invalidated → 安排 stale。
4. **命令幂等**：同 id 同内容重放只生效一次；同 id 不同内容拒绝。
5. **采纳与 sticky**：采纳写成事实并带来源；学习者改过后再采纳 → 提议。
6. **范围失效**：range 输入在 watermark 内的成员失效 → 候选 rejected。
7. **丢失唤醒**：waiting 的 work 在其等待的槽位生效、失败或撤回后被唤醒。
8. **效果账本**：done 重试不重复调用 provider；started 未完成返回 unknown。
9. **用途边界**：`ctx.read` 读 purpose 之外的事实被拒绝；用途收窄传播。
10. **撤销**：无后续修订时 undo 原子还原 command 的每条事实写入；有后续修订时全命令 conflict。
11. **固定引用**：事实更正不使 pinned 输入失效，following 输入失效。
12. **当前值**：失效推导可读但不在 current，不能支撑新生效。
13. **永久删除防复活**：已确认删除阻断旧命令/候选/设备/备份恢复正文，清除未完成如实显示，undo不恢复已删数据。
14. **临时与用途**：仅本轮的本人历史不进下一轮模型；不留存临时到期清除含原文载荷；仅保存不为索引或危机扫描破例读取。
15. **可靠交接与单一恢复**：PG提交后交接前宕机不丢工作，启动成功确认丢失允许重投但不重复逻辑任务/效果，不存在第二执行游标。

## 15. 不在本规格内（交给后续工作单元）

会话宿主的详细API、agent SDK/工具生成、HTTP/CLI、shadow、auth/多设备与界面交由 BACKLOG 指定单元。执行恢复的责任已由 ADR-0007 定为 Temporal，不能沿用旧的自写步骤恢复。生命周期边界按下面 §16，不能因详细表结构尚待实现而省略。

## 16. 临时载荷、永久删除与恢复

- 目标依据为产品规格 D06 和 ADR-0008。普通领域事实/推导不可原地改写；永久删除是经内核命令明确授权、不可 undo 的存储销毁例外，不增加领域数据种类或模块SQL入口。
- 用途和留存是独立维度。仅本轮使用保存本人可回看的原问答，但不得进入后续上下文、检索、摘要、画像或备课。打开历史不是再授权；用途沿含其内容的回答、采纳和来源链传播。
- 不留存临时的明文/密文不能无期限藏在业务日志、PG回执、effects、Temporal参数/结果/错误或对象历史中。使用不进入长期备份的独立临时载荷与密钥，到期/结束销毁；稳定控制标识可以保留，无内容正文。恢复窗口默认最多24小时，不能自动续期。
- 删除先在学习者事务中推进访问/删除代次、阻断新读/外发/接受并登记清除意图，取消在途执行仅是补充。读取 fact/trace/receipt/原件/缓存/深链及模型下一步都要复查当前删除与用途，不以已缓存凭据继续外发。
- 清理对象含所有修订、S3对象历史版本、采纳副本/图/摘要/索引、命令输入与回执、效果/工作快照、导出暂存、执行历史载荷和日志。混合产物先封闭，允许按剩余合法输入重新推导；不能仅删除引用链而保留含原文结果。
- 保留无正文的随机对象/命令身份、删除代次和必要清理状态作为防复活凭据。不得保留内容摘要、向量或内容指纹充当删除凭据。对已删除命令的重放不再做原输入/回执取回，而返回已删除/不可重放状态；已烧毁的效果身份不能因正文清除被当作未执行而重付。
- Temporal历史默认只放不透明对象引用及最小控制状态；载荷编码器必须覆盖参数、结果、异常与续接，不仅大文件。确需敏感载荷使用可按删除范围销毁的密钥，在线副本和对象历史仍需清理；销毁密钥不冒充所有物理字节已经清除。
- 同步先应用删除/访问代次再处理旧队列，旧代次创建/编辑/提交不能换新ID自动采纳；新的本人明确重新交入可建新身份。离线设备不可立即远程擦除，应显示设备清理待办而非全部完成。
- 备份默认至多30天；删除凭据独立于回退快照。恢复开放前应用后续删除与撤权、核对外部效果并使旧执行资格失效；凭据缺失保持隔离。已发生的provider处理和不受控导出副本不承诺撤回。
- 有独立事实产出的付费工作单在学习者锁内重新读取来源，登记实际内容来源的事实 ID 与待发布的事实、命令 ID。待发布目标须在预订与发出时均可用。效果与本地缓存使用同一工作身份；完成只能写入已登记的事实。删除沿登记来源追到已完成的发布，清除关联修订、命令正文及效果载荷，保留无正文的收费和重放凭据。后续合法授权可为仍有效的首来源分配新发布身份，旧事实和命令的墓碑继续生效。
- 防回退凭据还覆盖用途收窄、临时密钥销毁、收费效果发送前身份/状态；具备独立单调水位及区间完整性证明，不能与业务快照一起回退。先登记保护再执行敏感动作，失败宁可保守阻断。无法证明恢复区间完整则禁止外发、收费重放和旧执行续跑，不能因回退后查无记录假定无撤权/未收费。只留最小控制信息，不复制正文/摘要/内容指纹。
- 单元2/34/40须提供版本化迁移、载荷盘点及真实恢复证据；当前原型保存完整JSON输入，尚不满足本节，不能宣布删除或临时功能已交付。
