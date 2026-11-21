# Wave 2A 材料 5 分页 + 知识图谱双视图 + 题库母题折叠真实走查

- **验收时间**：2026-11-21
- **运行环境**：本地构建 `@mangekyo/web`（vite build）+ 真实 Studio HTTP（`MANGEKYO_PROCESS=web`，端口 `4319`）+ 共享 dev PostgreSQL `127.0.0.1:55432` 独占临时 schema（`test_wave2a_271472`）+ 单实例 headless Chrome CDP（无 Docker / TEST / 付费模型）。
- **真实数据**：向 schema 直接 INSERT `activity.workspaceEntry` 事实（`kind=concept`×6、`kind=relation`×5、`kind=question`×2），`GET /api/knowledge/graph` 返回 `HTTP 200` 且 `edges[].fromId/toId` 与 `nodes[].counts` 被前端归一化层正确消费。
- **前端报错**：所有场景 `consoleErrors: 0`、`overflow: false`（`scrollWidth <= clientWidth`）。

## PR #146 字段对齐结论

主线 `composeKnowledgeGraphResponse`（`modules/content/knowledge-graph-overview.ts`）真实返回：`edges` 用 `fromId`/`toId`/`verified`/`sourceRefs`，`pendingProposals` 用 `proposalId`/`fromId`/`toId`，`mastery.status ∈ steady|fading|fragile|unknown`。预建模块原本期待 `from/to`/`id`/`basisRefs`/`status:'verified'`，已在 `surfaces/web/src/knowledge-graph/normalize.ts` 加轻量归一化适配层，同时无缝兼容 `fromId/toId` 与 `from/to`、`proposalId` 与 `id`、`steady|fading|fragile|unknown` 与域3 `solid|weak|due`、`sourceRefs` 与 `basisRefs`；实测空库态与 6 节点 5 边态均渲染成功、零报错。

## 逐场景结果与截图

1. **桌面 `1440×900` 浅色 `/materials?tab=graph` 图谱视图** — [`01-materials-graph-desktop-light.png`](01-materials-graph-desktop-light.png)：真实 `GET /api/knowledge/graph` 返回 `200`，6 概念节点（加速度/平均速度/瞬时速度/速度/匀变速直线运动/自由落体）带掌握度色彩（全部 `尚待核对`）、真实连边与「1 题」计数徽标；「图谱视图/树状视图」分段切换与「全部/已稳/待固与薄弱/尚待核对」筛选条就绪。
2. **同页「树状视图」** — [`02-materials-graph-tree.png`](02-materials-graph-tree.png)：切换后按层级列出 6 节点，掌握度徽章与「1 题」计数保留，零报错。
3. **`/materials?tab=bank` 题库与错题** — [`03-materials-bank-desktop-light.png`](03-materials-bank-desktop-light.png)：真实 `GET /api/iqdb/questions` 空库 + 缺母题字段时诚实降级（「当前暂无母题归簇数据，已按平铺题库展示」「暂时没有获准用于学习的题目」），`[按母题折叠]`、`[只看错题]`、搜索框均渲染。
4. **「引用到学习同伴」抽屉真实联通** — [`04-cite-companion.png`](04-cite-companion.png)：点击图谱节点打开详情 → 点「引用到学习同伴」→ 右侧学习同伴抽屉 `data-open=true` 滑出并注入引用块（`【引用知识图谱节点：加速度】掌握状态：unknown；独立作答 0 次；关联题 0、教材 0、笔记 0`），未配置模型时诚实提示不伪造回复。
5. **`/materials?tab=textbooks` 个人教材** — [`05-materials-textbooks.png`](05-materials-textbooks.png)：挂载真实 `<StudioTextbooks>`（教材页标题 + 创建教材页），保留全部原有编辑能力。
6. **`/materials?tab=papers` 试卷与课堂** — [`06-materials-papers.png`](06-materials-papers.png)：整合 `<IssuedPapers>`（发行纸卷/已发行试卷）+ 「我的试卷」「学习型课堂」入口 tile。
7. **`/materials?tab=originals` 原件与笔记** — [`07-materials-originals.png`](07-materials-originals.png)：原件库/同伴工作区入口 + 真实 `<Organizer section="notes">`（全部笔记 + 新建笔记 Markdown 表单）。
8. **桌面 `1440×900` 暗色模式图谱视图** — [`08-materials-dark-graph.png`](08-materials-dark-graph.png)：深墨森绿主题下图谱节点、连边、筛选条完整渲染。
9. **手机 `390×844` 题库** — [`09-materials-mobile-bank.png`](09-materials-mobile-bank.png)：`scrollWidth = 390 <= clientWidth`，零横向溢出，底部 4 入口导航。
10. **手机 `390×844` 图谱** — [`10-materials-mobile-graph.png`](10-materials-mobile-graph.png)：图谱视图在移动端缩放呈现，工具条与分段切换可达。

原始测量明细见 [`walkthrough.json`](walkthrough.json)。

## 门禁

`pnpm typecheck`（kernel build + 根 tsc + web tsc）✓、`pnpm --filter @mangekyo/web build` ✓、`pnpm check:structure` ✓（90 runtime files / 14036 lines）、`pnpm check:test-budget` ratio `0.0937 ≤ 0.1`、测试净增 `0`、`pnpm exec vitest run` 45 文件 186 测试全过。

## 清理

走查结束后 `DROP SCHEMA test_wave2a_271472 CASCADE` 验证残留 `0`；Chrome 临时 profile 已删除。
