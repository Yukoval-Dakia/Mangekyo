# 个人教材页

`content.textbookPage` 以事实 ID 标识页面，以内核修订号标识不可变版本。`blocks` 的数组顺序定义同一 `parentId` 下的显示顺序，`null` 表示顶层。列表使用自己的直接子块作为条目。重排和移动更新放置位置，子块继续引用同一个父块 ID。

| 命令 | 输入 |
| --- | --- |
| `content.createTextbookPage` | `{ id, clientEditSeq, page: { title, blocks }, purpose? }`。缺省用途为 `storage`。 |
| `content.reviseTextbookPage` | `{ id, expectedRev, clientEditSeq, edits }`。本人写入新修订，同伴取得内核提议回执。 |
| `content.reviseTextbookDraft` | 同一编辑结构。内核允许同伴修订自己创建且本人未编辑的草稿。 |

每次修订对一个块 ID 最多提交一项 `rewrite`、`insert` 或 `move`。`rewrite` 换块正文。`insert` 和 `move` 提供 `parentId`、`beforeId`，`beforeId: null` 表示放到同级末尾。宿主为每次编辑保存命令 ID 与 `clientEditSeq` 的对应关系，按命令 ID 消化回执。`Fact revision conflict` 时保留待提交的编辑和原基版，读取当前版供本人选择；当前命令接口在冲突时回滚。

`openTextbookBlock(read, ref, blockId)` 从固定版返回块、同级位置和实际事实版本。传入 `following` 时，先核对原版，再按同一个 ID 定位当前版。教材引用存已打开的事实 ID、版次、类型、学习者和锚点。`openTextbookReference` 按当次读取用途重新打开固定版，验证整份、教材块 ID 或固定版数据路径，返回位置和访问代次。图片、题版和旧作的内容仍由各自所有者提供。`related` 保存 `question` 或 `work` 目标及需同时满足的 `knowledge`、`method`、`condition` 条件。

## 提议接线

内核提议保存原命令输入。宿主以同次授权的 `CommandContext` 和该输入调用 `previewTextbookRevision`，取得固定基版、访问代次和按块 ID 列出的前值、拟改内容和逐项校验结果。有效的引用改写同时带来源读取见证。单项定位或引用失败时，后续独立项仍可审查。

`selectTextbookEdits` 从已审查候选按块 ID 生成选中的命令载荷，保留原 `expectedRev`。写命令在内核事务中重读当前页，复核基版、编辑放置和所选项的引用用途。结构改动依赖其他选项时，所选批次必须仍能形成有效的树。

待内核及宿主接入提议读取、分项确认与拒绝、撤销和作者依据复验。草稿槽位采纳、新版显示、离线草稿恢复、来源所有者的展示、检索和反引入口由后续接线覆盖。

## 知识图谱演化

宿主从 `@mangekyo/module-content/graph-evolution` 导入 `evolveGraphCommand` 和 `parseGraphEvolution`。同伴以 `actor: 'companion'` 提交 `content.evolveGraph`。内核返回 `state: 'proposed'` 和提议 ID。本人确认时使用同一命令类型调用 `decideProposal`，选择函数返回原始提议输入。拒绝时返回 `null`。一次确认应用整条提议，事务内复验版本、用途、出处及别名。

| 动作 | 命令输入 |
| --- | --- |
| 合并 | `{ action: 'merge', id, expectedRev, into, targetRev }`。源身份及别名沿 `merged_into` 跟随目标。 |
| 拆分 | `{ action: 'split', id, expectedRev, reason, purpose?, children, reattachments? }`。`children` 须与原实体同类（概念、方法或母题），采用既有实体创建命令的 `{ id, entity, resolution }`。用途由外层声明，缺省为 `storage`。 |
| 拆分内重挂一条关系 | `{ edge: { id, rev, accessEpoch }, childId, evidence: [{ id, rev, accessEpoch }] }`。逐条指定同批新子概念和细分依据，支持题目考查、母题归属、题目或作答关联。首版关系可重挂。已有修订的关系保留供单独审查。 |

拆分产生的 `part_of` 边从子概念指向原粗概念，可用 `splitConceptHierarchyEdgeId(childId, parentId)` 定位。未指定重挂的边仍引用原概念。重挂为同一边身份追加修订，保留旧边的来源并附上细分依据。旧核验若存在，仅作为来源保留。借助 `@mangekyo/module-content/knowledge-edge` 的 `openKnowledgeEdgeRevision(ctx, id, { mode: 'following' })` 重开当前边，或以 `{ mode: 'pinned', rev }` 重开历史边。两种读法都复验来源权限和访问代次。跟随查询可继续用 `walkKnowledgeEdges` 解析实体重定向。

`content.proposeQuestionMeta` 可携带 `expectedMetaRev`，其中 `expectedRev` 为题版，`expectedMetaRev` 为本题版活元信息草稿的当前修订号。宿主先授权打开题版，再通过 `@mangekyo/module-content/question-meta` 的 `openQuestionMetaDraft(read, questionRef)` 读取草稿基版。缺少草稿基版的老提议仅能追加或重复同值条目。重算所得的同键差异继续由 lazy `overlay.question_meta` 投影，本人确认后更新 sticky 草稿。

三阶提示提议使用 `append_metadata.hint_ladder`，填写 `l1`、`l2`、`l3` 和已打开的 `source_ref`。确认人核对 L1 只提示条件或工具，L2 只给第一步，L3 给完整思路与参考解。L1 限单行 25 字。旧解法里的 `hints` 保留原义。园艺候选由提议区待审。

宿主从本次授权发放获取固定题版及授权代次，通过同一事务绑定真实接收人的事实读与当前有效槽读，再调用 `readQuestionHintLevel(access, { question, level, expectedDerivationId })`。槽读要复验 manifest 及其来源对该接收人的授权。返回值只含当档正文、档次、曝光阶次和服务端见证。宿主把见证绑定到发放、题项与档次，在展示确认或重放时复验绑定并传原 derivation ID。展示确认经 Activity 记录，作答框与草稿为空时的「先写一句」由宿主处理。

[graph-evolution.json](samples/graph-evolution.json) 提供联调载荷。依次创建 `question`、`concepts`、`edge`，再提议与确认 `split`、`merge` 或 `questionMeta`。拆分前原边指向「平均速度」。确认后重开当前边指向「不等时平均速度」，固定版仍指向「平均速度」。
