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
