# Wave 3 做题台装配与真实后端联调走查记录

- **验收时间**：2026-11-21
- **运行环境**：本地构建 `@mangekyo/web`（vite build 通过）+ 真实本地 Studio HTTP（`MANGEKYO_PROCESS=web`，`tsx runtime/studio/server.ts`）+ 共享 dev PostgreSQL `127.0.0.1:55432` 每次独占临时 schema（`wave3_*` / `wave3ui_*`，结束 `DROP SCHEMA ... CASCADE`，实测残留 `0`）+ 单实例 headless Chrome `1440×900` / `390×844` CDP（无 Docker / TEST / 付费模型）。
- **装配范围**：`/papers/:id` 路由切入 `workbook-v2/WorkbookSurface`（保留「打开打印版」入口）；新增 `onCiteToCompanion` → `AppShell` → `CompanionDrawer` 引用注入通道，抽屉滑出、引用筹码立即出现在输入框上方且不丢作答状态。Wave 2 表面（`today`/`materials`/`me`）未触碰。0 后端改动、0 新表。
- **前端报错**：`consoleErrors: 0`，`pageExceptions: 0`。

## 能力 22 · 自留口诀 5 端点真实联调（HTTP 直连真实 Studio，非模拟）

| 步骤 | 请求 | 结果 |
| --- | --- | --- |
| 建卷 | `POST /api/papers` | `201` id=`F3720C2EB71FD61BE692D030E4` rev=1 |
| 交卷（q1 错答） | `POST /api/papers/{id}/attempts` | `200` attempt=`4A5B32DF…` fb=q1:incorrect,q2:correct |
| 存口诀 | `POST /api/papers/{id}/attempts/{a}/takeaways` | `200` id + `undo_token` |
| 撤回 | `POST /api/papers/{id}/takeaways/undo` | `200` `{status:"withdrawn"}` |
| 再存 | `POST .../takeaways` | `200` 新 id |
| L0 打开 | `POST /api/papers/{id}/takeaways/open` | `200` `{kind:"own-words",text:"两点确定直线",displayRef:…}` |
| L0 确认曝光 | `POST /api/papers/{id}/takeaways/display` | `200` `{recorded:true}` |
| 复盘原位回显 | `GET .../attempts/{a}/takeaways/q1` | `200` text 原位返回 result=incorrect |

- **作答期防剧透**：`open` 之前正文/提示不随卷面下发（`GET /api/papers/{id}` 与 `attempts` 响应中不含口诀正文），点击后 `open` 才返回口诀本体，`display` 于真实绘制后回报曝光，链路完整。

## 单题拍照 / 手写过程图上传

- `POST /api/papers/{id}/attachments` 实测返回 `404 {"error":"这个入口不存在。"}`：该后端端点尚未合入 `origin/main`。
- 前端 `QuestionAttachmentUploader` 走**诚实降级**：`isNotFound` → 状态标 `error`，提示「当前后端暂不支持手写图上传，移除后即可正常交卷」，上传锁（`lock.locked`）阻止交卷直至移除/重试，不伪造成功。
- 契约走查（`QuestionAttachmentUploader.tsx` / `api.ts`）：multipart `file`+`itemId`+`scope`+`requestId`，XHR 上报真实上传进度，`201/200` 校验 `originalId`/`rev`；`scope` 支持 `inherit`（跟随本卷）/`once`（仅本次）切换并重传；`questionAttachments` 随 `POST attempts` 透传 `{originalId,rev}`，复盘由 `attempt.questionAttachments` 驱动 `ReviewAttachmentWall`（`available=false` 显示「权限已撤回」）。

## 浏览器联调结论

- workbook-v2 挂载成功，3 题导航、「引用到同伴」按钮、「打开打印版」入口均在。
- 点击「引用到同伴」→ 右侧「学习同伴」抽屉 `data-open=true`，引用筹码 `【引用试题：第 1 题】两点确定一条什么？` 出现在输入框上方，作答值 `直线` 全程保留。
- 交卷 → 「已交卷：答对 1 / 2」复盘模式，verdict 徽标、作答/参考答案/解析、≤60 字口诀编辑器原位渲染。
- 深色主题切换生效（`data-theme="dark"`），390×844 `scrollWidth=390` 零横向溢出。

## 截图

- [`01-desktop-light-workbook-companion-cite.png`](01-desktop-light-workbook-companion-cite.png) — 浅色 1440×900，引用筹码注入同伴抽屉（作答保留）
- [`01b-desktop-light-workbook-answering-closed.png`](01b-desktop-light-workbook-answering-closed.png) — 浅色作答中，把握度 chips 与手写图上传区
- [`02-desktop-light-workbook-review.png`](02-desktop-light-workbook-review.png) — 浅色复盘模式 + 口诀编辑器
- [`03-desktop-dark-workbook.png`](03-desktop-dark-workbook.png) — 深色复盘模式
- [`04-mobile-390x844-workbook.png`](04-mobile-390x844-workbook.png) — 390×844 单手视图，零横向溢出

## 备注

- `l0Sources` 仅在同概念变式题场景由宿主下发；本卷为普通自组卷，故作答期不渲染「给点方向」按钮（`OwnWordsHint` 在无 source 时按契约返回 `null`），其真实 `open`/`display` 链路已通过上表 HTTP 直连验证。
