# 个人教材服务

`openTextbook(db, contentModule, hooks)` 是 Studio HTTP 的服务边界，不自行注册路由。所有方法显式接收 `learner`；`purpose` 省略时为 `storage`。`create` 的用途可以是单个字符串或字符串数组，同时作为事实用途，数组第一项用于本次命令的来源读取。其他调用的用途是单个读取用途。

材料库的「个人教材」打开 `/textbooks`。编辑器使用 `/textbooks/page#textbook=<id>&rev=<rev>&block=<blockId>`；省略版次时打开当前版。Studio 将列表与建页映射到 `GET/POST /api/textbooks`，将读页与修订映射到 `GET/POST /api/textbooks/:id`。固定版读取使用 `?rev=<rev>`。这些入口均从服务端取得本机学习者身份，使用 `storage` 用途。

- `list({learner, purpose?})` 返回当前教材摘要及独立的 `legacyNotes`。`get({learner,id,rev?,purpose?})` 返回完整当前版或固定版；教材页的 `references` 是当次实际打开的来源见证。列表不展开来源。
- `openBlock({learner,id,rev?,blockId,mode?,purpose?})` 返回稳定块 ID、同级位置及实际事实版本。`rev` 省略时以调用开始的当前版为原版；`mode:'following'` 先验证原版块，再按同一 ID 打开当前版。读取页或块时按本次用途重新核对输出中的教材引用。
- `create({learner,requestId,id?,clientEditSeq,page,purpose?})` 只调用 `content.createTextbookPage`。未提供事实 ID 时由学习者与请求 ID 确定；相同请求重放返回同一命令回执。
- `revise({learner,requestId,id,expectedRev,clientEditSeq,edits,purpose?})` 只调用 `content.reviseTextbookPage`，不自动重基或覆盖当前版。相同 `requestId` 重放返回原回执；同页已经完成的 `clientEditSeq` 不会被另一请求再次写入。

成功回执包含内核 `commandId/state/wrote` 以及 `requestId/clientEditSeq/id/expectedRev/rev`。版本冲突、请求 ID 身份冲突和编辑序号冲突抛出 `TextbookConflictError`（HTTP 409 语义），其 `current` 保存当下完整版本，`originalEdit` 保存未执行的原编辑及基版，`previousReceipt` 在编辑序号冲突时指向已完成的命令。调用方只能清除回执明确确认的编辑序号，不能用迟到的旧回执清掉更新的草稿。

旧 `activity.organizerNote` 仅在精确核对事实所有者后映射为 `LegacyNoteView`，保留原 ID、修订、用途与正文，且 `readOnly:true`；不建立教材块、不迁移、不改写历史。

本服务没有自动合并界面、独立冲突草稿事实、内容草稿槽位采纳、提议接受/拒绝/撤回或历史聊天装配。冲突中的两份内容已经由固定旧版和当前事实保存；这些后续能力不得伪称由本服务完成。
