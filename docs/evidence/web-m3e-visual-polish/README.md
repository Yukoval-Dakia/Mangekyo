# Web M3E visual polish r2 真实走查

- **时间**：2026-11-22（PostgreSQL 服务器 UTC 时间为 2026-11-21）
- **环境**：本地构建 `@mangekyo/web` + 真实 Studio HTTP（`127.0.0.1:4397`，`MANGEKYO_PROCESS=web`）+ 共享 dev PostgreSQL `127.0.0.1:55432` 顺序使用的独占临时 schema（上传/引用：`visual_polish_r2_mwqmcl6p`；最终图谱复验：`visual_polish_r2_final_mwqnls2x`）+ 单实例 headless Chrome CDP（Chrome 157，临时 profile）。
- **边界**：无 TEST、无 Docker exec、无新表、无测试净增；仅触碰 `workbook-v2`、`materials-page.tsx` 与 `knowledge-graph`。Chrome profile、Studio 临时目录、端口与 PG schema 均已清理。

## 结果

1. **上传缩略图**：`POST /api/papers/{id}/attachments` 返回 201；交卷前缩略图 `complete=true`、`naturalWidth=1440`、`naturalHeight=900`，后端同源原图正常渲染；console error / page exception 均为 0。截图：`01-workbook-uploaded-preview.png`。
2. **图谱引用**：点击节点并引用到学习同伴，抽屉显示「掌握状态：尚待核对」，未出现 `掌握状态：unknown`；console error / page exception 均为 0。截图：`02-materials-cite-chinese.png`。
3. **6 节点图谱**：真实 PG 返回 6 个概念、6 条已核实边；二维折行布局、中文「前置 / 包含」标签和 auto-fit 均可用。截图：`03-graph-6nodes-desktop.png`。
4. **18 节点图谱**：真实 PG 返回 18 个概念、18 条边，viewBox `0 0 1356 826`，DOM 节点卡片重叠数 0；标题计算字号 19px、关系标签 21px；console error / page exception 均为 0。截图：`04-graph-dense-desktop.png`。
5. **暗色 390px**：`data-theme=dark`，`scrollWidth=390`、`clientWidth=390`，横向溢出 false；console error / page exception 均为 0。截图：`05-graph-dark-mobile.png`。

## 清理

两个验收 schema 均执行 `DROP SCHEMA IF EXISTS ... CASCADE` 后复查 `information_schema.schemata`，残留均为 `0`；Chrome 临时 profile、Studio 临时目录、4397 与 9223 端口均为空。
