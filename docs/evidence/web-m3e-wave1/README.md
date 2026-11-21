# Wave 1 真实 Studio + Chrome 走查记录

- **验收时间**：2026-11-21
- **运行环境**：本地构建 `@mangekyo/web` + 真实 Studio HTTP（`MANGEKYO_PROCESS=web`）+ 共享 dev PostgreSQL `127.0.0.1:55432` 独占临时 schema（`test_wave1_ui_11ba2230`，结束已 `DROP SCHEMA ... CASCADE` 验证残留 `0`）+ 单实例 headless Chrome CDP（无 Docker / TEST / 付费模型）。
- **前端报错**：`consoleErrors: 0`，`pageExceptions: 0`（`/api/care/support` 返回预期 404 时静默回退至本地 0-LLM 支持说明；`/api/ai/activity` 直连返回 `200 OK`）。

## 逐场景结果与截图

1. **桌面 `1440×900` 浅色 `/today`** — [`01-desktop-light-today.png`](01-desktop-light-today.png)
   - 原样保留 `<Mark />` 四瓣旋转 Logo 于 72px 左导航轨顶部品牌位（实测轨宽 `72px`）。
   - 保留并提纯森绿纸白 M3E Token（`--paper: #f8faf6`、`--rail: #eaf0e7`、`--forest: #244b36`、`--soft-green: #ddebdc`）。
   - 页标题收敛至 `25.92px`（正文 `15px`），消除 51px 超紧标题与全局顶部裸 `<details>需要帮助</details>`（计数 `0`），无 `activityId` / `methodVersion` / `slotKey` 外泄，横向零溢出。
2. **桌面 `1440×900` 暗色模式 + 右侧「学习同伴」抽屉** — [`02-desktop-dark-companion-drawer.png`](02-desktop-dark-companion-drawer.png)
   - 点击左轨左下角主题切换按钮后切入温润深墨森绿暗色模式（`data-theme="dark"`、`--paper: #101613`、`--forest: #a5cfb3`），并持久化至 `localStorage['mangekyo:theme']`。
   - 「学习同伴」抽屉滑出，点击「引用当前内容」生成显式引用块；底栏统一收拢「本轮用途：`日常学习` / `仅本次回答`」M3E 分段单选与输入框；无模型配置时诚实提示，不伪造回复。
3. **桌面 `1440×900` 右侧「AI 运作」抽屉 + SPA 无刷新导航** — [`03-desktop-ai-activity-drawer.png`](03-desktop-ai-activity-drawer.png)
   - 直连 `GET /api/ai/activity`（`200 OK`），按 PR #146 精确结构展示「运行中 / 夜链与交班 / 工具调用与依据 / 模型用量（`$0.0000 USD（未设上限）`）/ 待裁决提议」，零内部技术字段裸露。
   - 通过左轨依次切换 `/materials`（可见通过真实 `POST /api/materials` 写入的材料）→ `/me` → `/today`，页面内 SPA 哨兵全程存活，零整页刷新、零控制台报错。
4. **桌面 `1440×900` 快捷交入（`⌘K` / `+ 交入`）与左下角静默 D10 求助弹层**
   - [`04-desktop-quick-capture-modal.png`](04-desktop-quick-capture-modal.png)：`⌘K` 唤起「快速搜索与跳转」（10 条可直达结果），切换至「快速交入」呈现一句话与拍照/PDF 统一入口，不强迫选学科填表。
   - [`05-desktop-help-sheet.png`](05-desktop-help-sheet.png)：点击左轨左下角静默求助图标立即渲染本地 0-LLM 支持卡（不依赖模型、不猜测热线号、不自动联系第三方、不建永久档案）；同时已对接 `GET /api/care/support` 与一键「解除暂停」（`POST /api/care/pause/resume` 兼容 `DELETE /api/care/pause`），404/离线优雅回退。
5. **手机 `390×844` 视口** — [`06-mobile-390x844-today.png`](06-mobile-390x844-today.png)
   - 隐藏 72px 侧轨，顶栏保留 `<Mark />`、面包屑与紧凑抽屉切换胶囊，底部显示 4 入口 M3E 导航栏与浮动 `+ 交入` 按钮。
   - `/today`、`/materials`、`/me` 三页实测均为 `scrollWidth = 390 <= clientWidth = 390`，零横向溢出。
