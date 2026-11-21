# 普通卷面交卷的逐题过程

`POST /api/papers/{paperId}/attempts` 沿用 `requestId`、`answers`、`effectiveDurationMs`、`deletionWatermark` 和既有评阅授权字段。只有 GET 返回 `pacingVersion: 1` 时才使用扩展字段，从 GET 的 `revision` 取 `paperRev`，可随交卷附上以下观察。

```json
{
  "paperRev": 1,
  "effectiveDurationMs": 1200,
  "pacing": {
    "version": 1,
    "items": [
      { "questionId": "q1", "effectiveDurationMs": 900, "skipped": true, "returned": true },
      { "questionId": "q2", "effectiveDurationMs": 0, "skipped": false, "returned": false }
    ]
  }
}
```

题位取 GET `questions[].id`。只发送实际观测的题位，空答本身不产生过程行。时间是浏览器观测的聚焦时长，允许零毫秒。整卷与逐题时间都是 0 至 86400000 之间的整数毫秒，逐题总和不超过整卷时长。每个题位最多一行，最多 100 行。显式跳过后再返回时，同一行的 `skipped` 和 `returned` 同时为真。`pacing` 要求同时提交整卷时长和 `paperRev`。

普通交卷将版本、有效用时、过程和原作答保存在同一 Activity 事实中。POST 和 GET 的 `attempts[]` 返回原提交的可见过程，题面来自当时的卷版。首次提交时卷版已变化返回 409。版本化普通卷的提交键绑定卷标识、卷版与提交输入，重试复用原作，键已绑定到另一份输入时返回 409。消费者重试应复用原始请求体。

旧客户端可省略扩展字段，旧事实不会补造逐题观察。旧宿主、密封练习（含正式交卷释放后）及独立受控后测的 GET 都没有 `pacingVersion`，继续发送原请求体。密封练习和独立后测交卷入口拒绝扩展字段，并保留原有提交流程。
