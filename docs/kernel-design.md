# Mangekyo 内核设计规格

2026-11-15｜给实现者的规格。按本文实现的内核应通过 §13 的不变量测试；本文有歧义处，`docs/PRD.md` §4 是上位文档，但细节决策以本文为准。

术语见根 `GLOSSARY.md`。所有 ID 用 ULID；JSON 用 `jsonb`；时间戳 `timestamptz`。

## 1. 实现约定

- TypeScript，Node ≥ 22（可直接跑 `.ts`，或用 vitest）。代码里不写 enum、参数属性；相对导入带 `.ts` 后缀。
- 所有数据库访问收在一个 `Db` 接口后面：`query` / `tx`。两个实现：`pg`（生产）和 `@electric-sql/pglite`（测试）。SQL 一律手写，不用 ORM。
- 输入输出 schema 用 zod。内核表里存的是已校验过的值。
- 内核不 import 任何模块；模块经 `kernel` 包的公开入口 import 类型与 `ctx` 接口。

## 2. 数据表

每个学习者一行账本记录。所有写入（命令与推导生效）先在事务里 `SELECT ... FOR UPDATE` 学习者行，使同一学习者的所有写入串行，再 `UPDATE clock = clock + 1` 取得本事务的刻度（tick）。刻度是这个学习者的逻辑时钟：每个事实修订、每个生效/失效事件都带着它。串行化的成本是同一学习者的写入互斥；可接受，因为写事务都很短，且这是正确性的唯一来源。

```sql
learners(id pk, clock bigint not null default 0)

facts(
  id pk, learner_id, type text,                 -- 模块声明的事实类型
  current_rev int,
  purpose text[] not null,                      -- 用途范围；'all' 或槽位类型名列表
  sticky boolean not null default false,        -- 学习者曾手工改过；采纳只能提议
  deleted boolean not null default false
)
fact_revs(
  fact_id, rev int, data jsonb,
  author text,                                  -- 'learner' | 'companion' | 'adopted:<derivation_id>'
  command_id uuid,                              -- 产生它的命令
  tick bigint,                                  -- 写入刻度
  pk (fact_id, rev)
)
commands(                                       -- 幂等表
  id pk, learner_id, type text, input jsonb,
  receipt jsonb,                                -- 存 {wrote:[(fact_id,rev)...], output}
  tick bigint
)

derivations(
  id pk, learner_id, slot_type text, slot_key text,
  deriver text,                                 -- 'module/deriver@version'
  value jsonb,                                  -- 含 status:'value'|'unknown' 等负载
  status text,                                  -- 'candidate'|'effective'|'superseded'|'stale'|'rejected'|'shadow'
  shadow boolean,                               -- 重放/评估产生的非生效产物
  gather_tick bigint,                           -- gather 时读到的水位
  behind boolean default false,                 -- 落后但不失效
  effective_tick bigint, ended_tick bigint,     -- 生效/失效（superseded|stale|rejected）刻度
  manifest jsonb,                               -- 输入清单，见 §5
  error text                                    -- rejected 的原因
)
slot_state(                                     -- 每槽位一行，存当前生效指针
  slot_type text, slot_key text, learner_id,
  effective_id references derivations,
  pending boolean default false,                -- 有 work 在排队
  pk (slot_type, slot_key, learner_id)
)
work(                                           -- 任务队列
  id pk, learner_id, slot_type, slot_key, deriver,
  state text,                                   -- 'ready'|'running'|'waiting'
  gather jsonb,                                 -- 已固定的输入包（§5）
  attempt int, token uuid,                      -- fencing token
  ticks bigint[]                                -- waiting 时所等的刻度集合
)
effects(                                        -- 付费/外部效果账本
  derivation_id, step int, label text,
  state text,                                   -- 'started'|'done'|'unknown'
  result jsonb,                                 -- done 时的返回（供重试直接取用）
  pk (derivation_id, step)
)
```

`facts.purpose` 默认 `'{all}'`。收窄用途等于更正：按 §6 把依赖者全部置 stale。

## 3. 模块能声明的五种东西

每个模块是一个包，只有一个公开入口导出 `defineModule({...})` 的结果。目录约定：

```
modules/<name>/
  module.ts           唯一入口：export default defineModule(...)
  facts/*.ts          每个文件 default export 一个 defineFact
  slots/*.ts          每个文件 default export 一个 defineSlot
  commands/*.ts       default export 一个 defineCommand
  derivers/*.ts       default export 一个 defineDeriver
  blocks/*            界面块（本阶段先不管）
  samples/*.json      推导器的输入/输出样例
```

加载是约定：内核扫上述目录 import 全部文件，**没有任何登记表**。

```ts
defineFact({ type, schema, correctableFields?: (fact)=>jsonpointer[] })
defineSlot({ type, key: (input)=>string,
             triggers: Trigger[],                -- 见 §7
             policy: 'eager'|'lazy',             -- eager: 过时即重算; lazy: 有人读才算
             accept?: (ctx, candidate, current)=>{ok:true}|{ok:false,reason},
             })
defineCommand({ type, schema, destructive?: boolean,
                read?: (ctx)=>...,               -- 读取，计入清单
                write: (ctx, input, read)=>FactWrite[] })
defineDeriver({ name, version, slot,
                gather: (ctx, slotKey)=>GatherInput,   -- 在 worker 里跑，可用 ctx.read
                derive: (input)=>value|Promise<value>,  -- 纯函数：无 ctx、无环境
                })
```

`defineDeriver` 的 gather/derive 分离是硬性的：gather 在控制进程内经 `ctx` 做记录式读取（每次读取进清单）并产出可序列化的输入包；derive 只收到这个包。想测一个推导器，拿 samples 里的 JSON 喂 derive 即可，不需要数据库。

## 4. 命令执行（唯一写路径）

```
handle(learner, command{id, type, input}):
  tx:
    if commands 里已有 id:
        input 相同 → return 存的 receipt
        input 不同 → 拒绝（id 重用）
    lock learner 行; tick = ++clock
    validate input
    r = cmd.read?.(ctx)          -- ctx.read 检查 purpose，记入命令读取集
    for w of cmd.write(...):     -- w = {fact_id?, type, data} | {fact_id, retract:true} | {fact_id, purpose}
        if fact.sticky and r 是采纳类写入 → 转为 proposal（§8）
        写 fact_revs(rev=current_rev+1, author, command_id, tick)
    run slot 触发器（§7）
    传播过时（§6）
    存 commands.receipt
  return receipt
```

学习者手工编辑一条事实时置 `sticky=true`（或单独命令 `correct` 的默认副作用）。AI 发的 `destructive` 命令直接落成 `proposals` 行，不执行，等学习者确认后才按原命令执行。

## 5. gather → derive → accept

`ctx.read` 提供三种读取，全部计入输入清单（manifest）：

| 读取 | 记录 | 生效时有效的条件 |
|---|---|---|
| `fact(id, mode:'pinned'\|'following')` | (fact_id, rev, mode) | pinned：tick 后 current_rev 未前进；following：同（修订前进即失效） |
| `slot(slot_type, slot_key, mode)` | (slot, 引用到的 derivation id, mode) | 见下表 |
| `range(slot_type, scope, watermark)` | (slot_type, scope, watermark tick) | watermark 之内没有成员在 watermark 之后失效 |

- `fact` 的两种模式在 v1 行为相同：修订前进就失效。（区别留给将来「新版本仍兼容」的合法引用。）
- `slot` 输入有三种模式：`pinned`（引用该 derivation 本体，它失效即失效）、`following`（槽位的当前生效者变了即失效）、`asof`（引用的值仍可用于「截至当时」的语义：该 derivation 失效则失效，被非失效地 superseded 只算 behind）。
- `range` 的成员是某 scope（如 `(knowledge_point=K)`）下该槽位类型的 derivation。watermark 是 gather 时快照里看到的最大（effective|ended)_tick。成员在 watermark 内失效 → 输入失效；watermark 之后出现新生效成员 → behind。
- gather 在一个 snapshot（REPEATABLE READ 或单连接）里读完，并记下 `gather_tick`（学习者的 clock 当前值）。清单里每条输入存对象身份 + 当时版本 + 模式。

accept（worker 提交候选）：

```
tx:
  lock learner; 校验 work.token
  重验 manifest 全部输入（对照上表；slot following 用「effective 指针未变」）
  任一无效应 → derivations.status='rejected'(error)，work 回 ready（attempt+1），结束
  slot.accept?(...) 不通过 → 同上
  tick = ++clock
  旧 effective（若有）→ superseded(ended_tick=tick)
  新 derivation → effective(effective_tick=tick)；slot_state.effective_id 更新
  若任一 asof/range 输入在 gather_tick 后已变 → behind=true，slot 触发 behind 策略
  唤醒等在本槽位的 work（ticks 集合与 tick 相交者 → ready）
  触发 adoption 命令（若 slot 声明了 adopt）
```

## 6. 过时传播（与写入同事务，锁定学习者后执行）

每次事务里发生「变化」就处理一次，直到没有新 stale：

- 事实修订前进或 purpose 收窄 → 所有 manifest 含该 fact 输入的 candidate/effective → `stale`（记 ended_tick）
- derivation 变 `stale` → 含它 pinned/asof 输入者 → `stale`；含它的 `range` 且 watermark 覆盖其 ended_tick 者 → `stale`；`following` 输入指向它所属槽位者 → `stale`
- derivation 变 `superseded`/`effective`（即槽位当前指针变化）→ `following` 依赖者 → `stale`；`asof`/range 依赖者 → `behind=true`
- 每次置 `stale`/`behind` 后检查槽位 policy：`eager` 则 upsert work（`pending=true`，同槽位已有排队 work 则合并不重复）；`lazy` 不动

`behind` 不传播（落后不是失效），但 eager 槽位 behind 也会触发重算；懒槽位在有人读时才体现「落后」。

## 7. 槽位的出现与调度

- 槽位是声明式的：`slot` 的 `triggers` 描述何时需要它，内核监听三类事件：`fact`（某类型的事实新修订满足谓词）、`slot`（某槽位生效）、`always`（惰性视图）。
- 触发事件 → upsert work（幂等：同槽位已有 ready/running/waiting 即不重复）。
- worker 轮询 `SELECT ... FOR UPDATE SKIP LOCKED` 取 ready work：
  1. `gather` 跑模块的 gather；若其中某个 slot/range 输入当前无有效值 → work 置 `waiting`，`ticks` 记所缺槽位；等它们生效/失效时被唤醒
  2. 产出输入包 → 派给执行环境跑 `derive`
  3. 写 candidate + 走 accept
- `token`（每次 claim 换 uuid）防止旧 worker 迟到的结果落地。
- 每槽位同时至多一个 running work（slot_state.pending + work 唯一约束）。

## 8. 采纳、提议、撤销

- 槽位可声明 `adopt: (value) => CommandInput[]`：生效时内核以命令形式在同事务执行，事实带 `author='adopted:<derivation_id>'`，`fact_id` 由 value 里的稳定本地键确定（重抽取合并到同一事实）。
- sticky 事实收到采纳写 → 不覆盖，写 proposals 表 `{command_id, fact_id, proposed_rev}`。
- 提议：AI 的 destructive 命令 → proposals 行；学习者确认 → 执行原命令；拒绝 → 标记。
- 撤销：v1 提供 `undo(command_id)` 内部命令——对它写的每个 fact_rev 追加一个内容为前驱修订的新修订（author='learner'），retract 的还原为撤销 retract。对采纳成批写（一次抽取 N 个事实）逐条还原。

## 9. 效果账本

`tools.effect(label, fn)`（gather/会话可用；derive 拿不到 tools）：
- key = (derivation_id, step, label)。已 `done` → 直接返回存的 result（重试不重复扣费）。
- 已 `started` 未完成 → 返回 `{unknown:true}`（不盲目重付）。
- 未开始 → 先写 `started`（独立短事务提交，防崩溃丢失）再执行 fn，成功写 `done+result`，异常写 `unknown`。

## 10. 读路径

- `read(slot_type, slot_key)`：返回当前 effective + flags `{stale, behind, pending}`；无有效且 policy 允许 → upsert work 后返回「计算中」语义。
- 时间敏感的值（如「此刻记忆强度」）由槽位值里内嵌一个 `at(now)` 纯函数接口表达，读取时再算；不允许 derive 里取时钟。
- 没有跨槽位的「读旧版本」通用接口；回溯用 `manifest` 与 fact_revs 自行查询（backlog）。

## 11. 执行环境

- `in-process`：`await deriver.derive(input)`，同进程（TS）。
- `worker`：进程外子进程，行分隔 JSON 协议：`{id, deriver:'module/name@version', input}` → `{id, value}` 或 `{id, error}`。Python 端提供 `python/mangekyo_derive/{module}_{name}.py`，每文件一个 `derive(input)`。长驻进程，按 id 匹配响应。纯计算限定：worker 协议无 tools/model/读取；需要这些时扩展协议（backlog）。
- 超时/崩溃：kill、attempt+1、重进 ready；超过 maxAttempts 标 `rejected` 并把槽位挂起（留 error）。

## 12. 仓库与边界

```
kernel/        本规格的代码
modules/*      每个一个 workspace 包，exports: {".":module, "./facts/*","./slots/*"}
executors/python-worker/   §11 子进程宿主
python/mangekyo_derive/    Python 推导器（uv 管）
scripts/       new-module / new-deriver 生成器、check-structure
surfaces/web   界面（先不做）
```

- 依赖方向硬规则：`modules/*` 只能依赖 `kernel` 与其他模块的 `./facts/*`、`./slots/*` 子路径；`kernel` 不依赖任何模块；`executors` 只依赖 `kernel`。
- 检查脚本 `scripts/check-structure` 静态扫 import 路径违例 + 行数上限（kernel ≤1.5 万行，每模块 ≤1.5 万行，不含测试）。这是仅有的两条结构检查。
- 生成器产出可编译骨架 + 空 sample + AGENTS.md 模板（一页内）。

## 13. 不变量（必须写测试）

1. **更正-生效竞态**：更正已提交、旧候选到达 → rejected；同时发生 → 有确定先后。
2. **传递过时**：更正 → 判分 stale → 掌握度 stale → 安排 stale；读旧值仍可读。
3. **asof 语义**：掌握度被新证据 superseded → 安排 behind 而非 stale；掌握度被 invalidated → 安排 stale。
4. **命令幂等**：同 id 同内容重放只生效一次；同 id 不同内容拒绝。
5. **采纳与 sticky**：采纳写成事实并带来源；学习者改过后再采纳 → 提议。
6. **范围失效**：range 输入在 watermark 内的成员失效 → 候选 rejected。
7. **丢失唤醒**：waiting 的 work 在其等待的槽位生效后被唤醒。
8. **效果账本**：done 重试不重复执行 fn；started 未完成返回 unknown。
9. **用途边界**：`ctx.read` 读 purpose 之外的事实被拒绝。
10. **撤销**：undo 还原 command 写的每条 fact_rev。

## 14. 不在本规格内（交给后续工作单元）

会话宿主（工作单、逐步持久化、恢复）、agent SDK 接入与工具生成、HTTP/CLI 暴露、重放（shadow）管线、回溯查询、auth/多设备、界面。它们的形状见 `docs/BACKLOG.md`。
