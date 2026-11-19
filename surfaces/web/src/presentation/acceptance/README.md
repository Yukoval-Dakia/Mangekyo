# 表现层局部验收

本目录保存局部浏览器验收结果。三份交互和受控预测的复跑宿主在提交 `f3c01c33`，从该提交启动 Web 后打开 `/src/presentation/acceptance/index.html?case=0`。开发宿主留在该次证据提交，当前 CI 从仓库根运行 `pnpm exec vitest run surfaces/shared/presentation/contract.test.mjs`，覆盖作品加载、宿主确认后的状态推进及无效输入回退。

[浏览器记录](evidence/browser.json) · [滴定台](evidence/titration.png) · [断句](evidence/passage.png) · [双声部](evidence/rhythm.png)

## 宿主接入

通过 `surfaces/shared/presentation/index.ts` 读取可 JSON 序列化的 `presentationCatalog`。将候选作品交给 `validateArtifact(unknown)` 检查结构、全局唯一 ID、类型化绑定和样本长度。修订内容应当不可变，定义变更时分配新 revision；同一页面并排渲染的实例各有自己的局部草稿。

通过 `surfaces/web/src/presentation/index.ts` 挂载 `ArtifactView({view,mount,hostState,onAction,resolveAsset})`。mount 取获准快照的 mountId 与 stateRev。掉线时保留该 mount 并传入缺失的 view；撤权时传 null。新挂载使用新的 mountId。组件卸载会清理内存草稿。可选的 resolveAsset 将宿主资产 ID 解析为 Blob 或 null，也可返回 Promise。

onAction 接收与 companion `83c0547` 和 host `8aa2e12` 相同形状的 ArtifactIntentV1。学生每次主动操作生成新的 requestId。传输方保留该次完整 envelope，确认丢失时原样重发。接入 companion 分支时，将 snapshot 作为 mount，将回调参数直接交给 sendIntent；重试按钮使用保留的请求。作品修订、动作 ID、作答和最多 128 步的轨迹在内层 action 中，外层固定触发时的挂载和状态修订。

interaction v1 声明有限状态输入、宿主逻辑 ID 与修订、操作目标及可用值。宿主只投影当前获准的内容，并传入同作品、修订、挂载、基状态版本和逻辑版本的 hostState。每个被约束的操作要求输入齐全且值合法。一个 stepControl 通过 target 绑定图中同一 stepTarget。宿主负责核验与运行已登记逻辑；浏览器只解析声明并渲染控件。

## PR #5 四项复核

| 项目 | 1953945 | 修复后实测 |
| --- | --- | --- |
| 请求身份 | 内层 action 只含作品修订、节点、答案与轨迹 | 提交预测、重发、再主动提交的 ID 依次为 A、A、B。重发载荷相同，主动提交的内层 action 相同。 |
| 总量 | 8 个场景各含 90 个独立刻度，通过原版纯校验 | 同一输入返回 `view exceeds objects budget`，浏览器仅显示文字题面，绘图对象数为 0。另测 512/520 个对象、4096/4160 个点、4/5 个媒体槽的通过与拒绝。 |
| 中断与撤权 | view 缺失导致 React key 从作品与修订变为空串，旧编辑器卸载 | 同挂载缺失时显示原题和 gap-8，恢复后可提交；撤权后原题消失。重新授权或换挂载均得到空稿。 |
| 预测滴定 | 原版校验拒绝 interaction 属性 | 预测等待确认时图中阀门、原生按钮和滑块保持锁定。宿主从 stateRev 0 推进到 1 后下发曲线并解锁；热点与键盘原生按钮分别增加 1 mL，均记录 valve。 |

[浏览器原始结果](evidence/pr5-browser.json) 包含完整重试请求和独立新请求。[390px Chrome 触摸模拟](evidence/pr5-touch.json) 记录确认前的 0 mL、确认后两个入口产生的轨迹以及指针类型。[宿主校验记录](evidence/pr5-envelope.json) 将浏览器原始请求送入 `8aa2e12` 原版 handleArtifactIntent，使用本次共享校验、测试授权和内存命令适配器，重发映射到同一 commandId，第二次主动提交映射到另一 commandId；相同请求 ID 换预测内容返回 request-conflict，旧基版本返回 stale-state，新版观察返回 verified。校验范围为本地协议与 React 宿主，线上入口、内核持久回执、正式评估、物理手机均未验收。
