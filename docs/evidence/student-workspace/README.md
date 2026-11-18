# 老 TLP 实现与 Mangekyō 学习工作区

## 从学生入口追到实际处理

本次从本地完整归档恢复旧项目，核对远端主线提交 `c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3`。表中两处源码分别指向入口或规则，以及处理、写入或读取结果的位置。这里记录能在该版本源码中找到的行为。旧系统的运行情况另列在下方。

| 学习任务 | 老 TLP 实际做了什么 | Mangekyō 当前落点与差距 | 固定版本源码 |
| --- | --- | --- | --- |
| 交卷、拍照、导入文件 | 页证据、图像处理、录入题库和发题准入有各自的结果。 | 保留原件与识别状态，能校订文字、从选段备课；整卷自动拆题和图题对齐待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/server/start/routes/record.tsx) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/ingestion/server/item-bank-enrollment.ts) |
| 从题库找可用题 | 题库检索有范围、检索通道和证据读取。 | 能搜个人材料并打开原卷，缺口检索、知识点检索与发题准入待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/server/start/routes/questions.tsx) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/question-bank/tools/bank-search.ts) |
| 自己做题与判分 | 评分规则、评估结果和最终入账分开，有计数、权重和未知结果。 | 小卷支持数值容差、多个精确答案和自核。多步骤权重、语义给分和申诉待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/core/schema/assessment/scoring-rule.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/core/schema/assessment/settlement.ts) |
| 打印、写纸卷、交回来 | 打印稿有独立导出记录，交回需要匹配先前发出的任务。 | 从已保存的小卷打印无答案卷面。拍回、题区定位和多次纸笔作答待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/session/server/worksheet/export-store.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/session/server/worksheet/submission.ts) |
| 回到错题重做 | 错题入口回到题库的错题视图，保留原题和作答来源。 | 统一看待复习错题，重做后以最近一次有效作答更新，旧记录保留。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/server/start/routes/mistakes.tsx) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/ingestion/server/mistakes-read.ts) |
| 读笔记、修订和撤销 | 整理提案应用时写入版本，可沿关联记录撤销。 | 可从材料或同伴讲义记笔记，编辑和恢复旧版；自动提出整理建议待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/server/start/routes/notes.$id.tsx) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/notes/server/note-refine-apply.ts) |
| 新学科摸底 | 有独立摸底会话、选下一题和终止条件。 | 保留原有两份学习史诊断验收；从任意学科起步的分支摸底待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/server/start/routes/placement.tsx) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/placement/server/placement-advance.ts) |
| 安排今天、择日复习 | 到期复习、当天已有任务和可选新题分别进入编排。 | 能定日期、完成、恢复和回看；按遗忘与学业负担自动排课待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/scheduling/server/stream-composer.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/scheduling/server/due-list.ts) |
| 向同伴提问与检查理解 | 同伴可取学习者画像，聊天里的检查题可成为有身份的练习。 | 自己圈选原文，读真实同伴的讲解并把练习收进题库。跨主题证据选取待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/copilot/server/teaching/learner-picture.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/copilot/server/teaching/materialize-ask-check.ts) |
| 记忆与对记忆的控制 | 有学习证据、摘要和使用目的，不能从任务成功数推断已改正记忆。 | 学生可写、改、停用教学偏好，逐轮查看传给模型的版本。自动提出可纠正的学习判断待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/agency/server/memory/learner-evidence.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/agency/server/memory/brief-writer.ts) |
| 知识关系和错误概念 | 可看节点、关系、关系提案、错误概念及可复习对象。 | 保留追溯原作与质疑判断的要求；新版还没有可操作的知识图谱。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/server/start/routes/knowledge.tsx) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/knowledge/server/misconception-read.ts) |
| 交互题面与图解 | 排序、配对等交互块有执行入口，绘图有真实状态、来源和查看门槛。 | 同伴生成可展开的练习卡，可转到独立作答。通用生成交互块、互动图与绘图回执待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/practice/ui/blocks/PresentationBlocks.tsx) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/drawing/server/drawing-service.ts) |
| 目标、提议与结束一项学习 | 目标、待办及其结束条件各自有归属。 | 能保存个人目标、在计划中完成或重开任务。围绕目标长期备课和验证达成待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/agency/api/goal-create.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/agency/server/learning-item-completion-policy.ts) |
| 处理同伴的提议 | 旧收件箱把提议和接受、拒绝、修正写成事件，再应用到目标等对象。 | 新版能主动采纳讲义和小卷。跨项待决、批量接受与撤销待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/server/proposals/decision-resource.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/kernel/proposals/inbox.ts) |
| 问「我最近总错哪类」 | 同伴在旧系统里能调用工具查真实失败作答，读取轨迹和回复可重放。 | 错题页可把本次选用的实际错答收成复习单，给同伴分析；自主检索整段学习史待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/copilot/server/turns.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/ingestion/server/mistakes-read.ts) |
| 换一种方法教我 | 旧项目有教学方法库、干预推荐和实际交付状态，推荐产生后还可能备课失败。 | 新版的备课会显示完成或失败；基于后续表现检验哪种教学方法对本人有效待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/core/pedagogy/method-library.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/agency/server/intervention/snapshot.ts) |
| 跨学科接着学 | 旧项目有科目、目标和分科题目，并可查询多个学科的作答。 | 自有材料、笔记与小卷可以跨科；按学期和目标组织个人教材，以及课程版本沿用待做。 | [入口或规则](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/shell/server/subjects-list.ts) · [处理或结果](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/capabilities/agency/api/goal-contracts.ts) |

## 当时的运行结果

- 11 月 8 日的拍卷复测（TEST `52aa5a834`）中，38 个题块有 37 个自动入库，入库的 37 个没有一道通过发题准入。学生应当能分别看到原件是否保存、识别是否完整、哪些题已经可以做。原始回执为旧归档的 `audit/2026-11-08-photo-ingest-retest-receipt.md`。
- 11 月 4 日的契约普查（TEST `c2e9f12e4`）中，436 个当前题组有 83 个准入。该批次没有使用非默认计分规则。新规则模型裁判有 0 次调用，旧语义裁判有 271 次成功调用。两条路径需要分别验收。回执为 `audit/2026-11-04-flexible-grading-and-presentation-review.md`。
- 11 月 5 日的记忆调和普查（TEST `642958e59`）记录了 79 次成功付费调用、89 条调和记录，结果全部为保留两条。新版把学生是否能改正一条记忆、改正后是否真的影响教学列为验收。回执为 `audit/2026-11-05-memory-reconcile-test-census.md`。
- 本次在恢复出的主线源码上重新运行了评分、评估和结算的三个原有测试文件，28 项通过。未启动旧项目整套服务。历史 TEST 回执、这次的测试和新版的产品实测各有独立范围。

旧版有几条值得单独保留的反例。11 月 7 日 TEST 的同伴读取作答工具后，能区分「8 次失败作答」和「5 道不同的题」，回执为 `test-to-nas/cutover/40268e60/cards/turn-3b.log`。另一次题库检索返回 7 个未经核验的候选，符合任务要求的命中为 0，见 `test-to-nas/cutover/author-turn-fa872bcf/tools-input-output.txt`。旧版收件箱有 49 条待决提议，中位等待 23 天；一次隔离开发环境的教法干预试验两次备课审核超时，最终没有卡片交给学生。这几组记录分别来自不同日期与版本。[旧版处理提议的实现](https://github.com/Yukoval-Dakia/the-learning-project/blob/c40e3750bbf0107d5c0e6b3fae518bb3a597a0b3/src/server/proposals/decision-resource.ts)

## 新版的实际学习记录

2026-11-18，本机 Chrome、PostgreSQL、Temporal、PDFKit、Vision，使用合成材料和独立的学习数据库。教学请求使用 DeepSeek 4.1 Flash，思考强度为 high。

| 我做了什么 | 观察到的结果 |
| --- | --- |
| 在海陆风笔记中选一段，请同伴备课。另留一句未分享的文字。 | 本轮显示的读取条目只有选段和我主动保存的教学偏好。真实回复以昼夜风向的可观察现象开头，生成一段讲义和三道回忆题。 |
| 清空偏好，在原会话回答「我认为夜里也吹海风，因为海水能一直保持低温」。 | 第二轮仍显示所选原文，读取条目中已无那条偏好。它指出要比较陆地和海洋的相对温差，并把问题落在夜间哪边降温快。原回复可回看。[两轮原文及读取条目](coastal-lesson.json) |
| 在生成的卡片中填写自己的回答，转入同伴输入框，再分别保存成笔记和小卷。 | 输入框带上原问题和我的回答。保存的笔记带材料来源。存卷前可以修改题面和评分方式。本次将「白天从海洋吹向陆地的风」设为精确短答，另外两题保留自核。 |
| 先答「山风」，从错题页返回原卷，再答「海风」。 | 第一次得到错误反馈。改对后从待复习列表移出，卷内仍可打开两份作答。打印页仅取卷面题干。390 像素宽页面可以查看结果，无横向溢出。[手机实拍](mobile.webp) |
| 从错题页保存复习单，交给同伴分析。 | 它引用了把 17 与 21 的温差答成 38 的原答，提出可能混淆了「相差」和「合起来」，再追问以区分错因。原答和实际发送的复习单都可回看。[实测对话](mistake-review.json) |
| 上传文字型 PDF 和一张带英文课文的 PNG。 | PDFKit 读出了课文，下载的 PDF 与上传字节相同。Vision 读出图片中的句子 “At night the land cools faster than the sea.”。冷启动时曾达到最初的 20 秒时限。延长时限后识别成功；对先前失败的记录也实际完成了手工校订，下载仍得到原图。此样本没有手写或复杂版式。 |
| 修改长材料、修订和恢复笔记、重开学习任务。 | 超过材料卡片长度的全文可读。旧版本更正得到冲突提示；笔记恢复旧内容时写入第三版；重开的任务重新出现。[今天实拍](today.webp) |

在独立的本机实例上，下面的验收会创建合成记录，再从正常 HTTP 入口读回。并发重复编卷和交卷各只产生一份记录。另测了有容差的数值答案、可接受的别名，以及仅自核的开放回答。

```sh
node runtime/studio/test/student-workspace-acceptance.mjs http://127.0.0.1:4356
```

另开一段地理对话，实际读取了改正后的教学偏好。更换模型端点后仍能回看旧对话，续发会提示另开对话。原先「同一个 45」的两份学习史用真实模型重新跑过，独立旧作触发迁移，明确的错法触发针对性讲解。
