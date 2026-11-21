# Wave 2B1 真实 Studio + Chrome 走查记录

- **验收时间**：2026-11-21
- **范围**：「今天」重构版主行动台（`TodaySurface`）+ 统一「交入」缩略图历史流（`IntakeSurface`）接入 SPA 壳，并打通右侧「AI 运作」/「学习同伴」双抽屉联动；同时按 Owner 整改令根除 `/today` 首屏三排药丸堆砌。
- **运行环境**：本地 `pnpm --filter @mangekyo/web build` 产物 + 真实 Studio HTTP（`MANGEKYO_PROCESS=web`，`MANGEKYO_PORT=4419`）+ 共享 dev PostgreSQL `127.0.0.1:55432` 独占临时 schema `w2b1_verify_01`（结束已 `DROP SCHEMA ... CASCADE`，残留 `0`）+ 单实例 headless Chrome（Playwright chromium-1234）。无 Docker / TEST / 付费模型。
- **后端兼容**：夜链交班条消费 `origin/main` 真实 `GET /api/ai/activity`（`200 OK`）的 `asOf`/`running`/`handoffs`/`pendingProposals`；空库与有数据两种状态下均无 `activityId`/`methodVersion`/`slotKey` 等技术字段外泄，无裸 `<details>`。

## 逐场景结果与截图

1. **桌面 `1440×900` 浅色 `/today`** — [`01-desktop-light-today.png`](01-desktop-light-today.png)
   - 首屏根除三排药丸：标题「今天 / 11月21日周六」+ 右侧轻量「开新课」；「现在有空：不限 | 3分 | 15分 | 45分+」紧凑单行；「作答方式：常规 ▾」收拢单手/语音至同行最右下拉。
   - 森绿 Hero 主推荐卡「检查一次推断 · 约 3 分钟 · 条件推理」；时间预算条「今日约 6 分钟 / 预算 15 分钟」；「今晚休息」出口；`scrollWidth = clientWidth = 1440` 零溢出。
2. **桌面 `1440×900` 暗色 + 「AI 运作」抽屉** — [`02-desktop-dark-ai-drawer.png`](02-desktop-dark-ai-drawer.png)
   - 暗色主题下右侧抽屉直连 `GET /api/ai/activity`：`运行中 0 项 / 夜链与交班 0 项 / 工具调用与依据 0 项 / 模型用量 $0.0000 USD（未设上限）/ 待裁决提议 0 项`，零技术字段裸露。
3. **桌面 `1440×900` 浅色 `/intake`** — [`03-desktop-light-intake.png`](03-desktop-light-intake.png)
   - 统一投递区「拍卷 / 选图 / 传 PDF · ≤ 25 MB」；D06 默认「仅保存」策略栏与「学习使用」分段切换；底部「最近交入」历史流带缩略图位与状态胶囊。
4. **一句话交入实时更新** — [`04-desktop-intake-after-submit.png`](04-desktop-intake-after-submit.png)
   - 真实提交「明天数学小测：一元二次方程求根公式与判别式。」后历史流即时出现「文本 · 刚刚 · 仅保存」条目；点击条目 SPA 无刷新进入 `/materials/saved/<id>` 详情。
5. **手机 `390×844`** — [`05-mobile-390-today.png`](05-mobile-390-today.png)、[`06-mobile-390-intake.png`](06-mobile-390-intake.png)
   - `/today` 与 `/intake` 手机视口均 `scrollWidth = 390 <= clientWidth = 390` 零横向溢出。
6. **「带到同伴」注入联动** — [`07-desktop-companion-cite.png`](07-desktop-companion-cite.png)
   - 点击 Hero 卡「带到同伴」→ 右侧「学习同伴」抽屉滑出并注入「【引用学习项：检查一次推断】主题：条件推理 …」引用筹码。

## 前端报错
- `pageExceptions: 0`；`consoleErrors` 仅 KaTeX `data:font/woff2` 加载提示与 `/api/care/support` 预期 404 静默回退（与 Wave 1 一致），无业务报错。
