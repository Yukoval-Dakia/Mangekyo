# P2/P4 同回合教材局部编辑调查

基线为合入 #99 的 `58bf051d8f85229bf0a607c661eba8d8dea6771f`。独占数据库从交付的快照副本恢复，同一学习者保有教学生效权限的独立后测原答。Chrome 从同伴正常入口发起，两轮均通过真实 Studio、PostgreSQL、Temporal，模型请求只发给环回协议 fixture。

1. **P2 批开丢逐项。** 轮二传入教材、授权后测原答引用、无记录 ID。批开宿主构造 `partial_success` 和逐项数据，学习工具适配将 `ok:false` 折为 `invalid_args`，上层看到“详见逐项”却无 `items`。基线用直连适配器探针独立复现，也在 Chrome 场景的出站工具消息观测到。修复需保留本轮授权并重验过的逐项信息，整批失败继续是错误。
2. **P4 局部编辑回合回滚。** 基线 Chrome 场景轮一成功保存两块教材，轮二错误 `expected_rev` 回包给出 `version_conflict`，按 `next` 重开成功。正确期望版本的同一单块 patch 导向回合失败「作答依据已变化，本轮结果无法使用」，模型未收到保存回执。当前定位是按裸 ID 打开教材时把可供模型复用的页正文记为 following，直接修订事务的事实变更 hook 再复验整个回合，此时页自身版本刚推进。需区分目标页的历史读取见证、命令写前的当前版本检查，以及外部来源的版本和权限见证。通过页的新旧正文、来源、事务回执和撤权对照确认。

## 根因与改动

两条症状有独立触发条件。P2 在出站结果适配发生，独立于任何写入。P4 在正确版本的写事务发生。红轮 PG 保存了目标页 `D83094B3E05DC95841987B1BA0@1` 的 following 见证，独立后测 `A906787B034701110648B8E3D5@1` 的 epoch 为 0，教学用途有效。目标页终态仍为 rev1，账本只有创建回执。对红轮见证做回滚式隔离试验，仅推进目标页头时，目标 following 复验失败，目标 pinned 复验和后测 following 复验分别通过。

适配器把含有效读取的批回包当作可交付的结果，并保留原始逐项。全失败保留错误和逐项。教材显式打开回包带确定页版，目标见证按该版复验。写命令继续要求当前页头匹配 `expected_rev`，来源仍按各自见证及原收件人和用途核验。已存回执继续按存储的见证模式重验。

本机原件位于 `/private/tmp/mk-p2p4.UHonh2/`。红轮分项响应和 PG 核对见 `red/round-two-red.json`、`red/pg-census.log`、`red/revalidate.log`，Chrome 失败和出站协议见 `red/patch-run.log`、`red/patch-browser.jsonl`、`red/provider-requests.ndjson`。独立适配器红绿见 `adapter-red.log` 和 `adapter-green.log`。第二次单项 Chrome 对照在第一轮轮询超时，保留在 `red/patch-single.log`。

## 修后复跑

同一快照的独占副本使用同一回环收件人和模型配置。修后 Chrome 创建两块教材，第二轮模型依序收到目标页 rev1、授权后测原答 rev1 和 `not_found`。错误期望版本仍返回可执行的 `open_learning`；按该提示重开后，正确命令收到 rev2 的保存回执，两轮 Temporal 工作流完成。教材图书馆实际打开并渲染了更新过的首块及原同级块。兄弟块和 rev1 历史快照均逐字段相等。

对照轮打开当前 rev2，提交真正陈旧的 rev1，得到 `version_conflict`，页保持 rev2。后测提交类型的工作区 HTTP 用途入口返回 404。为验证真实来源撤权，用本机专用命令接入同一个内核命令处理器及传播 hook，提交真实 `set_purpose`，来源从 rev1/epoch0/教学可用变为 rev2/epoch1/仅存储。随后同会话的既往回复以 `reply_unavailable` 投影，教材详情不可读。Chrome 再发一轮时，模型只获得三个无正文的逐项拒绝结果，保存被 `evidence_not_opened` 拒绝，教材未新增版本。

绿轮记录为 `green/patch-browser.jsonl`、`green/provider-requests.ndjson`、`green/patched-textbook.png`、`green/revoke-command.json`、`green/revoked-session.json`、`green/pg-final.json` 和 `green/workflows-final.jsonstream`。首次绿轮在教材列表短时等待超时，续跑又一次因目录链接和正文同时命中而失败；保留前两次探针日志。最终在同一会话及已保存页上用块级定位完成界面与陈旧、撤权对照。

## 检查

类型检查、结构门禁、测试预算和 diff 空白检查通过。Studio 源码 14,960 → 14,963 行，测试行 7,237，预算 9.99931% → 9.99848%，未改门禁。两个现有目标单测文件通过 13 项，真实 Python SDK 用例未纳入此次筛选。现有工作区和教材 PG 用例首轮触及既有时限；同一独占 PG 上仅显式设置测试连接的 `synchronous_commit=off`，沿用原时限复跑 2/2 通过。

## P2 复审补验

`c0834d2` 的出站混合批包仍缺 `warnings[]`，失败项引用未注册的旧检索工具。另一个缺块失败项附带其页的固定引用，但效果账本缺该页见证。在隔离 PG 里于读取回执落库后、下一次环回发送前通过正常教材用途命令撤权，红包仍包含该页的 ID、rev、type。复审探针保存于 `/private/tmp/mk-p2-wire.oPhr0c/`，以本地协议服务捕获实际模型入参。

修后混合批保留顺序和成功项，逐项失败经同一错误映射返回，warnings 复用这些错误。两条提示均为已注册的 `search_learning({})`。环回模型显式执行该提示，账本是一次批开、一次检索，未重跑原批。撤权发生于本地读账本落库后、下一次发送前。已撤权的缺块页不出现在逐项、warnings 或显式检索结果中。另撤销成功项权限时，模型只收到 `basis_stale`，成功页正文和固定引用被拦住。单独适配旧回执也清除了固定提示。P4 的实跑保留页根 pinned 见证，以当前头检查写入 rev2，同级块原样。

独立提交基于 `c0834d2`。`1aceb2eb` Wave4 合装与这两处实现有重叠。Wave4 原样未带入 P4 页根固定，也没有混合批适配；它的新目录使用 `search_workspace`，已有学习目录使用 `search_learning`。临时副本保留 Wave4 目录分流并叠加此修复及 P4 页根固定后，通过类型、结构、预算和环回 P2/P4 探针。另直接验证 Wave4 v2 错误适配输出该目录已注册的检索工具。正式提交仅含独立补丁。

红绿出站包和撤权回执见 `red-wire-evidence.json`、`final-evidence.json` 和 `final-requests.json`，P4 对照见 `finalpatch-evidence.json`，临时合装见 `wavefour-evidence.json` 与 `wavepatch-evidence.json`。本轮通过类型、结构、预算，目标单测 13 项及隔离 PG 2 项。测试仍为 7,237 行，比例 9.99641%。本轮环回探针直接通过 Studio 教学执行入口及真实 PG，沿用之前 Chrome/Temporal 的证据，未重新跑浏览器或 Temporal。

## #113 与 #114 发布基线合装

合装基线为抓取确认的 `b3725413606742eac3a1bad54e1a6ab6ed89d3f3`，已包含 Wave4 和 tsrs。沿用前述解冲，并在 Wave4 执行器的真实 `open_learning` 出站路径接上该目录的错误适配。成功整批保持原格式，混合批带规范 warnings，逐项提示按所在目录输出。

同一现有本机 PG 容器及隔离 fixture 下，两条 Studio 教学执行路径各发出三个环回请求。学习目录实际调用 warning 的 `search_learning({})`，Wave4 目录实际调用 `search_workspace({})`。每条账本只有一次批开和一次检索。两条路径均验证缺块页撤权后没有固定引用，已读成功项撤权后只返回 `basis_stale`。P4 探针再验固定页根、当前头写入 rev2 及同级块原样。原始输出见 `release-learning-evidence.json`、`release-workspace-evidence.json`、`releasepatch-evidence.json`，在上一节本机目录内。

tsrs 类型检查、结构门禁及测试预算通过。合装实际 Studio 14,957 行，全仓非空生产 65,683 行、测试 7,237 行，比例 9.92457%。相对发布基线的代码只涉及批读错误适配、Wave4 目录接线和教材根见证，此报告保留既有红绿证据。
