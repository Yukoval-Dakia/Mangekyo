# Today 窄 Web 联验

2026-11-21，在 Google Chrome 157.0.8103.52 的两个独立存储上下文中完成。Web 父提交为 `838b308492705404849b31b271e71c19f97f2c72`，宿主父序为 `838b308 → 9a27fc8 → f1d55359511d5582e2b2a6307d9282c1f324f572`。本目录的 JSON 保存本轮请求、回执、冻结题面、浏览器存储快照、数据库行数和所测源文件摘要。

## 运行路径

在窄 Web 工作树运行 `pnpm --filter @mangekyo/web build`。Chrome 打开 `http://127.0.0.1:39372/`，该端口提供窄 Web 生产静态文件，并将 `/api` 转发给固定宿主的 `127.0.0.1:49416`。宿主使用 `pnpm studio:serve`、独占 PG 的 `127.0.0.1:33147/postgres` 及全新 schema `web_today_small_final`。时区为 Asia/Tokyo。作答与判题均使用正式本地入口，产品模型调用为 0。

## 实测

| 路径 | 观测 | JSON 键 |
| --- | --- | --- |
| 冷库从首页进入今天 | 服务端给出「检查一次推断」「读一条借阅规则」，各 3 分钟，共 6 分钟，均来自内置原创包；页面展示服务端预算与估时依据。 | planAndOffline.empty |
| 3 分钟单手 | 从推断换为借阅规则，推迟后撤回，再点开始。冻结题面来自 `/api/today/open` 的 `pack/reading@1`。 | planAndOffline.swap、three_minutes_open |
| 双端锁定、休息、撤回 | 一端锁定后另一端读到保护项。解除后，另一端按旧修订解除得到 403 并重新读取。跨端休息与恢复成功。旧目标修订未覆盖已暂停目标。休息规则丢回执后重载，原请求取得同一修订。 | planAndOffline.events、concurrent_lock、goalsAndRules |
| 有学习史时重新规划 | 正式交卷保护已完成的包；创建一题自编卷后，服务端加入该卷并给出每题约 3 分钟的依据。点击后进入真正的 `/papers/:id`，交卷再回今天，两项均受保护。上次访问时间设为 22 天前，页面显示服务端的回归概况。 | planAndOffline.history_candidate、history_completion、returning |
| 断网刷新与重连 | Service Worker 接管后在 Chrome 切断上下文网络并刷新，原选择、题目版本、请求 ID 和水位均恢复。重连后需再次勾选教学用途。缺用途 HTTP 400，同 ID 改答案 HTTP 409。 | planAndOffline.offline_restored、consented_submit、nonzeroColdStart |
| 回执丢失与重复提交 | 真实 POST 已由宿主处理后，在浏览器接收前中断回执。刷新、重新授权后原请求再发。水位 25 的两次请求、200 回执、学习记录 ID、修订和回执头一致。另一浏览器同题同答案、另一个 ID 正常生成另一笔记录。 | lostResponseHeaders、devicesAndDeletion.second_device |
| 另一端删除合成原件 | B 断网持有水位 0 草稿，A 删除专属合成 txt 后水位变为 21；B 重连清草稿，旧 POST 共 0 次，重新作答得到新 ID 与水位 21。在另一请求预检后删除第二份合成材料，水位升至 25；在途请求获 409 `deletion_watermark_stale`。已成功的旧 ID 在水位变化后重放也获同一 409。 | devicesAndDeletion.known_stale、fresh、deleted_after_preflight、lostResponseHeaders |
| 首次非零水位 | 新浏览器存储中扣住已从宿主收到的真实水位 25 回执。题面可见，无法点选，草稿和请求绑定为空。放行后才创建 ID。刷新再扣住回执，旧 ID、选择与绑定保留；断网刷新也保留。重新授权才出现本次唯一的 POST。 | nonzeroColdStart |
| 服务端低于原请求水位 | 单独导入上一轮专属草稿及绑定 25，以空 schema 返回的真实水位 0 提交。提示尚未发送，原 ID 与选择保留，POST 共 0 次。 | lowerServerWatermark |
| 持久化 | 按每个客户端请求派生命令和学习记录 ID 查询 PG。6 个成功请求各有 1 条完成命令、1 条学习记录、1 个修订；两个已过期请求各为 0。全 schema 的包提交命令合计 6 条。 | postgres |
| 原导航与失败态 | 375 px 下首页、今天后测缺失入口、材料、我、同伴均无横向溢出。阻断 Today GET 后页面提示重试、候选卡片数为 0。 | routes |

## 检查与边界

- 窄 Web 的 `pnpm typecheck`、生产构建和结构检查通过。runtime 为 14993/15000 行。主 JS 730.95 kB，gzip 220.63 kB，Vite 给出大块警告。
- 固定宿主及「宿主源码归档 + 五个窄 Web 源码文件」均实测结构 15055/15000 行，超出 55 行。超额位于 runtime。
- 测试预算脚本按测试行数占生产加测试总行数计算。窄 Web 为 4574/(42882+4574)，占 9.64%。组合为 4574/(43023+4574)，占 9.61%。限额 10%。
- 双端使用同一台机器的独立 Chrome 存储；网络断开使用 Chrome 上下文离线模式。离线开包覆盖已缓存的冻结题面。全新设备首次无网下载、两台物理设备、真实后测交卷、源题与出版卷等其他候选、考试标定和第五路 410 已烧身份均未做本轮运行验收。旧锁得到的服务端提示为「这份材料当前无法链接」，措辞见原始响应。
