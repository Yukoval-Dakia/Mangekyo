# Mangekyō 私有单机部署与备份恢复

本文档面向私有单机部署。目标是：一台机器、一条命令启动 PostgreSQL + Temporal + Studio，数据与原件持久化，备份/恢复可验证。

## 1. 架构与隐私边界

| 组件 | 作用 | 端口（仅 loopback） |
| --- | --- | --- |
| PostgreSQL 18 | 领域事实、推导、命令、回执、效果账本 | `127.0.0.1:55432` |
| Temporal | 耐久执行、重试、等待、版本路由（ADR-0007） | `127.0.0.1:7423`（gRPC），`127.0.0.1:8423`（UI） |
| Mangekyō Studio | Web + Worker（`MANGEKYO_PROCESS=studio`） | `127.0.0.1:4317` |
| 原件/Blob 卷 | 交入原件、模型/工作区配置 | 持久卷 `intakedata` |

**隐私边界**：所有端口默认只绑定 `127.0.0.1`。如需远程访问，请使用 SSH 隧道或自行改绑并加固，不要直接暴露公网。原件含用户提交的学习材料，备份文件同样敏感。

## 2. 前置条件

- Docker Engine + Compose v2
- Node.js ≥ 22.12（本机开发/构建镜像时需要；容器内已内置）
- pnpm 10.33（本机开发需要）
- 可选：`temporal` CLI（本机开发验收用；容器部署用 `temporalio/auto-setup` 镜像）

## 3. 一键启动

```sh
cd deploy
cp .env.example .env   # 首次：填写 POSTGRES_PASSWORD 等真实值
./start.sh             # 幂等：预检 → 构建 → 启动 → 健康检查 → 迁移确认
```

`start.sh` 会：
1. 检查 `docker`、`docker compose`、`.env` 是否存在且密码非占位符；
2. 检查端口占用（仅警告，不阻断）；
3. `docker compose up -d --build`；
4. 等待 postgres / temporal / studio 健康检查；
5. 探测 `http://127.0.0.1:4317/` 就绪后打印访问地址。

数据库迁移由 Studio 启动时 `applyKernelSchema` 自动执行（版本化迁移，见 `kernel/src/schema.ts`）。如需手动核对：

```sh
docker compose -p mangekyo exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT max(version) FROM mangekyo_studio.kernel_schema_migrations'
```

## 4. 环境变量

完整列表见 `deploy/.env.example`。与源码 100% 对齐的关键变量：

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `MANGEKYO_DATABASE_URL` | 内核 PG 连接串 | compose 内自动注入 |
| `MANGEKYO_DATABASE_SCHEMA` | 内核 schema | `mangekyo_studio` |
| `MANGEKYO_PORT` | Studio HTTP 端口 | `4317` |
| `MANGEKYO_PROCESS` | `studio`/`web`/`worker` | `studio` |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` | Temporal 连接 | `temporal:7233` / `default` |
| `MANGEKYO_TASK_QUEUE` | Worker 任务队列前缀 | `mangekyo-studio` |
| `MANGEKYO_INTAKE_DATA_DIR` | 原件根目录 | `/data/intake`（容器） |
| `MANGEKYO_SETTINGS_FILE` | 模型供应商配置 | `/data/config/provider.json` |
| `MANGEKYO_WORKSPACE_ACCESS_FILE` | 工作区访问路由 | `/data/config/workspace-access.json` |
| `MANGEKYO_LLM_BASE_URL` / `MANGEKYO_LLM_API_KEY` | 首次默认模型 | 可选；也可在 UI 保存 |
| `MANGEKYO_MINERU_TOKEN` | MinerU 云识别 | 可选 |
| `MANGEKYO_NOTION_TOKEN` | Notion 集成 | 可选 |
| `MANGEKYO_PYTHON` / `MANGEKYO_SWIFT` | 本机计算/抽取工具 | 可选 |
| `MANGEKYO_IQDB_LOCAL_WASM` | IQDB 本机核验模块 | 可选 |
| `MANGEKYO_RETENTION_METHOD` | 保持方法覆盖 | 默认 `cognition@3` |

**安全**：`.env` 已被 `.gitignore` 的 `.env*` 规则忽略。`deploy/.env.example` 只含占位符与注释，不含真实密钥。生产环境请使用强随机密码，并通过秘密管理器注入。

## 5. 备份与恢复

备份包含 PostgreSQL schema 转储（`pg_dump --format=custom`）与原件/Blob 目录（`tar.gz`），外加 `manifest.json`（schema 版本、迁移水位、SHA-256 校验和、备份时间）和 `SHA256SUMS`。

### 5.1 备份

```sh
scripts/ops/backup.sh \
  --schema mangekyo_studio \
  --blob-dir /data/intake \
  --database-url "postgresql://user:pass@127.0.0.1:55432/mangekyo" \
  --backup-root /backups \
  --keep 30
```

产物：`/backups/<UTC时间戳>/{database.dump, blobs.tar.gz, manifest.json, SHA256SUMS}`。

- `--keep N` 保留最近 N 份，超出删除最旧（默认 30，与 D06 备份保留期一致）。
- 无本机 `pg_dump` 时自动探测 `docker exec mangekyo-dev pg_dump`；容器部署请安装 `postgresql-client` 或用 `--pg-dump` 指定。

### 5.2 恢复预检

```sh
scripts/ops/restore.sh \
  --archive /backups/<时间戳> \
  --database-url "postgresql://user:pass@127.0.0.1:55432/mangekyo" \
  --dry-run
```

`--dry-run` 只校验 manifest 与 SHA-256，不写入。

### 5.3 实际恢复

```sh
scripts/ops/restore.sh \
  --archive /backups/<时间戳> \
  --database-url "postgresql://user:pass@127.0.0.1:55432/mangekyo" \
  --blob-dir /data/intake \
  --yes   # 或去掉 --yes 手动输入 RESTORE 确认
```

恢复流程：校验和 → 目标覆盖保护（非空 schema/blob 需 `--force`）→ `pg_restore` / `tar` 解包 → 核对关键表记录数与 blob 文件数。

### 5.4 D06 删除边界与备份

备份文件包含用户原件与学习记录。已离线备份的副本在本人永久删除后**不会自动消失**，恢复上线前需：

1. 核对 `kernel_schema_migrations` 版本与防回退凭据（独立于快照持久保存）；
2. 确认恢复区间内无未应用的删除/用途收窄/临时密钥销毁/收费效果凭据；
3. 无法证明凭据完整覆盖时保持隔离，禁止外发、付费重放和旧执行续跑；
4. 已擦除内容在旧离线归档中标为 `unverified`，需用户自行清理旧备份文件。

备份默认保留 30 天；删除凭据独立于可回退快照。详见 `docs/product-spec.md` D06 与 `docs/adr/0008-data-lifecycle-and-erasure.md`。

## 6. Python 计算沙箱镜像

`executors/teaching/agent-tools.ts` 固定使用 `mangekyo-calculation:1` 镜像运行 Python 计算（无网络、只读、资源受限）。生产宿主需预先构建：

```sh
docker build -t mangekyo-calculation:1 - <<'EOF'
FROM python:3.12-alpine
RUN pip install --no-cache-dir numpy==2.3.5 sympy==1.14.0 matplotlib==3.10.7
ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib OPENBLAS_NUM_THREADS=1
EOF
```

容器内 `docker` CLI 通过挂载 `/var/run/docker.sock` 调用宿主机 Docker；请确保宿主机已构建该镜像。

## 7. 本机开发（非容器）

```sh
pnpm install --frozen-lockfile
# 启动 Temporal（本机原生开发服务）
temporal server start-dev --ip 127.0.0.1 --port 7423 --ui-port 8423 \
  --db-filename "$HOME/.local/share/mangekyo/temporal.db" \
  --dynamic-config-value frontend.workerVersioningWorkflowAPIs=true \
  --dynamic-config-value frontend.workerVersioningRuleAPIs=true \
  --dynamic-config-value system.enableDeploymentVersions=true
# 启动 Studio
MANGEKYO_DATABASE_URL=postgresql://... MANGEKYO_ACTIVATE_LOCAL_BUILD=1 pnpm dev
```

详见仓库根 `README.md` 与 `executors/temporal/README.md`。

## 8. 验证清单

- [ ] `deploy/start.sh --check` 预检通过
- [ ] `docker compose -p mangekyo ps` 全部 healthy
- [ ] `curl http://127.0.0.1:4317/` 返回 200
- [ ] `SELECT max(version) FROM mangekyo_studio.kernel_schema_migrations` 返回预期版本
- [ ] `scripts/ops/backup.sh` 生成含 manifest.json 的归档
- [ ] `scripts/ops/restore.sh --dry-run` 校验通过
- [ ] `scripts/ops/restore.sh` 后表记录数与 blob 文件数一致
