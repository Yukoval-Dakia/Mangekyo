# 公开链接按需读取

保存走 `capture.ingest`，写入 `capture.source` 的 `kind: 'url'` Asset。传入原始地址和本地标题，`originals` 与 `unit.blocks` 为空，缺省用途为 `storage`。`capture.publicLink` 是无触发器的懒槽。首次交入、仅保存和打开已存链接均无抓取步骤。既有 `urlReadConfirmed` 字段随历史原件可读，它本身不授予抓取权限。

## 宿主接线

1. 学习者明确选择「读取链接」后，宿主将请求绑定到学习者、原件 `target`、当前 `accessEpoch`、学习使用对应的 `purpose` 和实际 `recipient`。使用可信入口生成的稳定 `requestId`，同一请求复用该标识。宿主以它查回当次可信操作及授权。`intent: 'read-link'` 是动作类型。
2. 从 `@mangekyo/module-capture/public-link` 调用 `publicLinkWorkKey` 并显式排队，用同一用途 gather 并封存 plan。效果输入只有请求见证。`consumePublicLink` 以当前授权重新打开链接原件，从原件地址去掉片段，将地址交给匹配的宿主 transport。
3. 宿主以 `runEffect` 绑定原 manifest。保留、重放和落回执都复查真实操作、当前源和接收方。传输开始前在学习者锁内调用 `checkDispatch`，复核同一授权与地址。读取器按实际连接地址保证公开可达，拒绝内网、重定向与受限页面，使用匿名、有上限的读取。传输完成后 `consumePublicLink` 再校验原件和授权。
4. `settlePublicLink` 用冻结见证核对效果回执。`openPublicLink` 必须传入按当前调用方授权绑定的 `PublicLinkSourceResolver` 与读快照，复查明确请求、当前原件版本、用途与实际接收方后才读槽，返回原件版本、原始地址和阅读结果。`readable` 含实际正文。`restricted` 表示访问受限，`unreadable` 表示无可读正文，`failed` 表示读取失败，`unauthorized` 表示授权无法确认，`unavailable` 表示缺少传输入口。回执未确认时显示未知，沿用同一效果身份查询结果。新的读取使用新的明确请求。

## 按需口述

复用 `@mangekyo/module-capture/extraction` 的 `voiceTranscriptionRequest` 和 `voiceTranscriptionResult`。宿主在本人开始录音后创建短期句柄，只在本次已授权用途内转写。回执绑定当前录音，文本交还给本人编辑，确认之前保持草稿状态。

确认后通过 `capture.confirmSource` 提交 `kind: 'voice'`、`transcriptConfirmed: true` 和编辑后的已知 `source` 块，命令回执给出 `capture.source` 版本。后续按用途打开该 Asset 和稳定块 ID，来源仍为口述。默认提交空 `originals`，短期录音句柄不写入 Asset。本人另行选择保存录音时，宿主才把录音写到受控存储，传入 `retainAudio: true` 和原件描述。`capture.ingest` 无法确认口述。以 `companion` 为作者调用确认命令只能产生提议，正式文本由可信 learner 入口确认。

## 当前接线与证据

Studio 使用模块加载器，能够识别链接槽、推导器和口述确认命令。材料 HTTP 入口交入文字或文件，后台 worker 没有公开链接消费分支。当前仍缺公开链接传输、真实接收方授权绑定和表面接线，以及口述录制、转写和确认的宿主入口。这些能力须在接线后验收。

模块验收使用独占 PostgreSQL 与本机合成 transport。经模块加载器、命令处理器和内核效果账本覆盖仅保存零工作零外发、请求与用途拒绝、版本及访问代次不符、授权正文与来源重开、效果重放、受限与空正文、在途撤权及用途撤回。口述覆盖回执绑定、同伴提议无法写 Asset、本人更正确认、默认仅留文本及显式音频元数据。录音对象存储和清理、浏览器录制与真实外部传输均未运行。
