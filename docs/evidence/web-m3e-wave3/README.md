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

## 单题拍照 / 手写过程图上传（PR #152 已合入 `origin/main`，全真实联调）

| 步骤 | 请求 | 结果 |
| --- | --- | --- |
| 上传 | `POST /api/papers/{id}/attachments`（multipart `file`+`itemId`+`requestId`+`scope=inherit`） | `201` `{originalId:"551D9A38…",rev:1,url:"/api/materials/551D9A38…/original",mimeType:"image/png",scope:"inherit"}`，回执 `X-Deletion-Watermark: 0` |
| 原件 | `GET /api/materials/{originalId}/original` | `200` `image/png` |
| 绑定交卷 | `POST /api/papers/{id}/attempts` 携带 `questionAttachments:{q1:[{originalId,rev:1}]}` | `200` attempt=`FB8C7CC4…` |
| 复盘透传 | `attempt.questionAttachments.q1` | `[{originalId,rev:1,url,available:true}]` → `ReviewAttachmentWall` 真图渲染 |

- 浏览器端实测：文件选择 → `wbv2-thumb` 状态 `跟随本卷`（done，非 error）→ 交卷 → 复盘「本题手写过程图」真 `<img>` 上屏。`scope` 可在 `inherit`/`once` 间切换并重传；`available=false` 时渲染「图片权限已撤回或暂不可用」。
- 真实联调响应与 PR #152 后端契约逐字段一致：`originalId`/`rev`/`url`/`mimeType`/`scope`。

## 浏览器联调结论

- workbook-v2 挂载成功，题号导航、「引用到同伴」按钮、「打开打印版」入口均在。
- 真实上传：文件选择 → 上传进度 → done `跟随本卷`；带 `questionAttachments` 交卷 → 复盘「本题手写过程图」真图渲染。
- 点击「引用到同伴」→ 右侧「学习同伴」抽屉 `data-open=true`，引用筹码 `【引用试题：第 1 题】…` 出现在输入框上方，作答值全程保留。
- 交卷 → 复盘模式，verdict 徽标、作答/参考答案/解析、≤60 字口诀编辑器原位渲染。
- 深色主题切换生效（`data-theme="dark"`），390×844 `scrollWidth=390` 零横向溢出。

## 截图

- [`01-desktop-light-workbook-uploaded.png`](01-desktop-light-workbook-uploaded.png) — 浅色 1440×900，手写过程图上传完成（`跟随本卷`）
- [`02-desktop-light-workbook-review-attach.png`](02-desktop-light-workbook-review-attach.png) — 浅色复盘：verdict「有偏差」、作答/参考答案、「本题手写过程图」真图、口诀编辑器
- [`03-desktop-light-workbook-companion-cite.png`](03-desktop-light-workbook-companion-cite.png) — 浅色引用筹码注入右侧同伴抽屉
- [`04-desktop-dark-workbook-review.png`](04-desktop-dark-workbook-review.png) — 深色复盘模式
- [`05-mobile-390x844-workbook.png`](05-mobile-390x844-workbook.png) — 390×844 单手视图，把握度 chips 与交卷栏，零横向溢出

## 备注

- `l0Sources` 仅在同概念变式题场景由宿主下发；本卷为普通自组卷，故作答期不渲染「给点方向」按钮（`OwnWordsHint` 在无 source 时按契约返回 `null`），其真实 `open`/`display` 链路已通过上表 HTTP 直连验证。
