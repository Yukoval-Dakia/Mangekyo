# Wave 1 可质疑理解源卡与验收

基线 `origin/main` 的 #54（`ecfa495`），包含 #51 的统一读层规格和 #52 的跨卷读取。即时 `companion.claim`、旧 `learner.preference`、旧 `companion.memoryAssertion` 继续使用原 ID、修订、授权和写入入口。Memory Gateway 从这些事实投影统一的 `kind / scope / ttl / evidence_refs / sticky`。后台结果用现有 `companion.memoryAssertion` 的版本 2，保留正反证据并复用 `memory-review`。同一断言复核追加修订，保留撤回凭据。版本 2 的本人更正写入粘性修订，撤回写入原事实的撤回修订。

## 活动源卡

| 活动 | 生产事实与取证 | 正常入口与本轮证据 |
| --- | --- | --- |
| 同伴对话 | `activity.studyTurn` 有已完成的教学选择时扫描，模型只收到 learner 的原话，不附对话上下文或原件。 | 已对齐 #50 的即时 Claim。现行 `submitTurn` 只给教学用途，缺少普通入口的独立教研授权。未跑异步对话产出。 |
| 交卷与后测 | `activity.workbookAttempt`、`activity.retentionPosttestSubmission`。复用生产提交回执读取。只使用有确定性结果的内嵌题原答，保留题项锚点。 | 普通交卷和已有教研授权 HTTP 路径已跑通。同一次或帮助未知的证据只留弱观察。后测默认无教研用途，未跑异步后测，评分标准题仍缺接线。 |
| 原件 | `activity.intakeDocument`，只读本人更正的抽取文字。未判定的 OCR、页图和印刷／手写／红笔作者分层暂无资格。 | 已有本人更正入口。现行原件默认保存用途，未跑获准异步原件。 |
| 活教材与笔记 | `content.textbookPage` 的正文块和 `activity.organizerNote` 的正文，保留块或字段锚点和来源版本。 | 用正式 Studio 教材服务明确提交 `storage/teaching/background-research` 用途。活教材进入实际 outbox 和 Temporal。HTTP 创建默认保存用途，未跑旧笔记。 |
| 课堂与作品 | `activity.artifactAction` 的真实动作类型，只记录互动。 | 已有互动上游。现行作品动作只给教学用途。完整课堂归档和教学方法与后续独立表现的因果证据缺上游，未验收此类异步产出。 |
| 撤回与拒绝 | `companion.retentionReviewPermission` 记录本人撤回后测复习许可，只给模型明确的授权撤回事件，不包含撤权的内容和旧引用。 | 已有后测的授权撤回生产入口。未跑负反馈抽取，拒绝提议、跳过和锁定还未接入此抽取。 |

一条活动使用一个核验入口。模型必须从当次已打开的片段逐字引用，并提供事实 ID、修订、访问代次、锚点与证据方向。短期状态需要绝对 UTC 截止，最长 24 小时，读取时到期隐去。旧活动之后发生本人管理时，以现有修订账本从严截住迟到抽取，包含与这次编辑关系尚未确认的旧活动。本轮没接具有完整见证的多次独立表现；错因和有效教法候选只按弱观察呈现。

## 隔离实测

- 按已有 HTTP 路径交卷，开启对本次作答的教研权限。Todo `01M7WM2W5Z75YCKFJZRA77B6JR` 对应 Work `01M7WM2W6CHR2YS15YK5F3NDRM`，outbox 已交接。模型传输请求包含题项原答 `10`，落下弱观察。
- 同一套 Coordinator / Todo / Work / effects 消费授权教材保存。Todo `01M7WM2X7P9DEDM00JMDAWMM33` 对应 Work `01M7WM2X83MYRQMV9ZP8RX7R5P`。同一观察从 rev 1 更新到 rev 2，保留 support 与 contradict，复核结果为未决。另一条有教学用途的教材观察被实际 Memory Gateway 读回，只获教研授权的作答观察不进入教学上下文。
- 逐字引文不匹配时 Todo 进 `failed`、effect 保留 `unknown`，没有理解写入。本人在模型响应送回前更正另一条理解时，到达的结果触发 `cancelled`，已保存的本人修订保持粘性。移除作答教研授权后，包含该原答的观察隐藏正文和来源。原撤回凭据仍能撤回它。本人忘掉另一条已改过的理解后，用同一请求重试返回相同回执。只保存的教材页面未进入记录的模型请求。
- 本地 PostgreSQL 16 和 Temporal 1.32.2，Coordinator `coordinator:58277e6b-188c-40ba-8855-c7d9b67194d8`。注入零费用传输只用于隔离验收。运行记录、原始出站请求与模型回复、复现驱动位于 `/tmp/mangekyo-understanding-9de60344/final/` 下的 `evidence.json`、`ledger.json`、Temporal 历史 JSON、`transport.jsonl`、`proof.ts`、`host.mjs`。未使用真实模型、付费路由、TEST、浏览器或部署。

合入候选在 #55 基线上复跑了正反证据、假引文、迟到结果、撤权和撤回。教材正文保留原有块与来源见证。抽取和同伴读取复用教材的来源遍历，按各自用途和接收方验权。隔离 PG 对比确认，只有页面获准但来源仅限存储时，旧候选返回正文，修订后的候选没有返回正文。随后在 Studio 和 Temporal 联验中，派生页未进入实际注入传输。普通学生给教材开启后台教研的界面仍待接入。
