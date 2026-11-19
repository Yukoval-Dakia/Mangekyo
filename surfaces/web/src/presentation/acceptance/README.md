# 表现层局部验收

本目录是开发用 React 宿主。会话、教材和卷面的生产入口由集成批次接入。

## 复核

在仓库根执行 `pnpm build:kernel`、`pnpm --filter @mangekyo/web typecheck` 和 `node --test surfaces/shared/presentation/contract.test.mjs`。启动 `pnpm --filter @mangekyo/web dev`，在其本地地址打开 `/src/presentation/acceptance/index.html?case=0`。参数 0 至 4 分别对应滴定、断句、节奏、未知版本文字版和编辑中收到无效修订内容。动作按钮下的折叠区显示宿主实际收到的请求。

| 局部浏览器验收 | 观察 |
| --- | --- |
| 滴定 | 点击阀门、等价按钮，再按滑块右键。设备读数为 3 mL，曲线为 pH 1.13，记录按钮交出带单位的体积和三次调整。 |
| 断句 | 390px 视口下点第八字、空格取消、Enter 恢复。提交位置为 `gap-8`。 |
| 节奏 | 大鼓 1、3、6，小鼓 1、4、8。试听进入播放状态，提交保留两组独立 ID。未做扬声器录音或听感验收。 |
| 触屏 | 本机 Chrome 启用 320px 移动视口和触摸模拟，发出 touchStart/touchEnd。三例均记录到 touch 指针，文档宽 320px。断句稳定 ID 与键盘一致；未使用物理手机。 |
| 降级 | 未知版本显示原文题意。同作品同修订在编辑中收到无效内容，保留可读的本地作答，恢复定义后仍可提交原断点。 |

[evidence/browser.json](evidence/browser.json) 保存预览宿主读数、回调和恢复结果。[evidence/touch.json](evidence/touch.json) 保存触摸模拟回调。[滴定台](evidence/titration.png)、[断句](evidence/passage.png) 和 [双声部](evidence/rhythm.png) 为实测截图。

## 宿主接入

通过 `surfaces/shared/presentation/index.ts` 读取可 JSON 序列化的 `presentationCatalog`。将候选作品交给 `validateArtifact(unknown)` 检查结构、全局唯一 ID、类型化绑定和样本长度。三份示例定义在同目录的 `examples.ts`。修订内容应当不可变，定义变更时分配新 revision；同一页面并排渲染的实例各有自己的局部草稿。

通过 `surfaces/web/src/presentation/index.ts` 挂载 `ArtifactView({view,onAction,resolveAsset})`，在页面加载现有产品基础样式。可选的 resolveAsset 接受宿主资产 ID，返回 Blob、null 或对应 Promise。校验失败时仅显示可读替代内容。

onAction 接收 ArtifactAction，包含作品、修订、节点、意图、声明的输入快照与本地操作轨迹。数量带单位，断点和落点使用稳定对象 ID。轨迹最多保留最近 128 步，omitted 报告此前被丢弃的步数。宿主需按发放的修订核验请求，决定帮助或反馈何时可见，并处理保存与正式提交。当前验收使用本地定义，未运行真实 Agent 出题、服务端判分、跨会话恢复或学习史写入。
