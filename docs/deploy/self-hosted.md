# Mangekyō 私有单机部署与备份恢复

本文档面向私有单机部署。目标是：一台机器、一条命令启动 PostgreSQL + Temporal + Studio，数据与原件持久化，备份/恢复可验证。

## 1. 架构与隐私边界

| 组件 | 作用 | 端口（仅 loopback） |
| --- | --- | --- |
| PostgreSQL 18 | 领域事实、推导、命令、回执、效果账本 | `127.0.0.1:55432` |
| Temporal | 耐久执行、重试、等待、版本路由（ADR-0007） | `127.0.0.1:7423`（gRPC） |
| Temporal UI | Temporal Web 控制台 | `127.0.0.1:8423`（独立服务 `temporalio/ui:2.42.1`） |
| Mangekyō Studio | Web + Worker（`MANGEKYO_PROCESS=studio`） | `127.0.0.1:4317` |
| 原件/Blob 卷 | 交入原件、模型/工作区配置 | 持久卷 `intakedata` |

**隐私边界**：所有端口默认只绑定 `127.0.0.1`。容器内 Studio 监听 `0.0.0.0` 仅为接收端口映射，宿主机侧仍只发布到 `127.0.0.1:${STUDIO_PORT}`。如需远程访问，请使用 SSH 隧道或自行改绑并加固，不要直接暴露公网。原件含用户提交的学习材料，备份文件同样敏感。

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

## 3.1 Temporal Worker Deployments 动态配置

`deploy/temporal-dynamicconfig.yaml` 以只读挂载方式注入 `temporal` 服务
（`DYNAMIC_CONFIG_FILE_PATH=/etc/temporal/config/dynamicconfig/development.yaml`），
启用 7 条 PINNED Worker Deployment 所需的全部 API：

- `frontend.workerVersioningWorkflowAPIs`
- `frontend.workerVersioningRuleAPIs`
- `system.enableDeployments`
- `system.enableDeploymentVersions`

`temporalio/auto-setup:1.32.2` 不监听 8233，原 `temporal` 服务的 `8233` 端口映射已移除；
Temporal UI 改由独立服务 `temporal-ui`（`temporalio/ui:2.42.1`）提供，
仅绑定 `127.0.0.1:${TEMPORAL_UI_PORT:-8423}`。

## 4. 环境变量

完整列表见 `deploy/.env.example`。与源码 100% 对齐的关键变量：

| 变量 | 用途 | 默认 |
| --- | --- | --- |
| `MANGEKYO_DATABASE_URL` | 内核 PG 连接串（最高优先；compose 改用下方独立 PG 变量） | compose 内自动注入 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | 内核 PG 独立连接参数（`MANGEKYO_DATABASE_URL` 未设时生效；`PGPORT` 默认 `5432`） | compose 内自动注入 |
| `MANGEKYO_DATABASE_SCHEMA` | 内核 schema | `mangekyo_studio` |
| `MANGEKYO_PORT` | Studio HTTP 端口 | `4317` |
| `MANGEKYO_HOST` | Studio 监听地址（仅允许 `127.0.0.1`/`::1`/`0.0.0.0`） | `127.0.0.1`（容器内为 `0.0.0.0`） |
| `MANGEKYO_ALLOWED_HOSTS` | 额外放行的 Host 头（逗号分隔） | compose 自动含本机 `127.0.0.1/localhost/[::1]:${STUDIO_PORT}` |
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

**数据库连接**：compose 中 Studio 不再把密码拼进 `postgresql://` URI，而是通过 `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` 独立变量连接 `postgres` 服务，因此密码可安全包含 `@ / ? # : % &` 等 URI 特殊字符。`start.sh` 预检同样改为由 `python3` 只读解析 `.env`（绝不 `source`/`eval`），支持单/双引号与行内注释；若密码含 `$`、空格或 ` #`，建议用单引号包裹。

## 5. 备份与恢复

备份包含 PostgreSQL schema 转储（`pg_dump --format=custom`）与原件/Blob（宿主机目录或 Docker 命名卷，打包为 `tar.gz`），外加 `manifest.json`（schema 版本、迁移水位、SHA-256 校验和、备份时间、`blobDir`/`blobVolume` 来源）和 `SHA256SUMS`。`manifest.json` 的 `databaseUrl` 会自动把密码替换为 `***`，不落明文密码（D06）。

### 5.1 备份

原件/Blob 有两种存储形态，`--blob-dir` 与 `--blob-volume` 互斥，按部署方式二选一：

- **Compose 单机部署（推荐）**：原件在 Compose 命名卷 `mangekyo_intakedata`（卷内路径 `/intake`）：

  ```sh
  scripts/ops/backup.sh \
    --schema mangekyo_studio \
    --blob-volume mangekyo_intakedata \
    --database-url "postgresql://user:pass@127.0.0.1:55432/mangekyo" \
    --backup-root /backups \
    --keep 30
  ```

- **宿主机直接部署**：原件在宿主机目录：

  ```sh
  scripts/ops/backup.sh \
    --schema mangekyo_studio \
    --blob-dir /path/to/intake \
    --database-url "postgresql://user:pass@127.0.0.1:55432/mangekyo" \
    --backup-root /backups \
    --keep 30
  ```

产物：`/backups/<UTC时间戳>/{database.dump, blobs.tar.gz, manifest.json, SHA256SUMS}`。

- `--keep N` 保留最近 N 份，超出删除最旧（默认 30，与 D06 备份保留期一致）；过期归档清理仅依赖 `python3`（`shutil.rmtree`），宿主机无需安装 Node.js。`--keep` 仅按 UTC 时间戳清理带 `manifest.json` 的归档目录，不触碰 `--backup-root` 下其他目录。
- `--blob-volume` 通过一次性 `--rm` 容器（默认 `BLOB_HELPER_IMAGE=postgres:18.7-alpine3.24`）只读打包卷内 `/intake`；卷不存在会报错，`/intake` 缺失则告警跳过，与 `--blob-dir` 行为一致。
- `manifest.json` 记录 `blobDir` 或 `blobVolume`；`restore.sh` 在两者都未显式指定时按此回填，显式指定其一则不会回填另一个。
- 无本机 `pg_dump`/`pg_restore`/`psql` 时，`backup.sh` 与 `restore.sh` 按 `mangekyo-postgres-1` → `mangekyo_postgres_1` → `mangekyo-dev` 顺序探测运行中的 PostgreSQL 容器（可用 `--pg-container` 参数或 `PG_CONTAINER` 环境变量显式指定）；容器部署也可安装 `postgresql-client` 或用 `--pg-dump`/`--pg-restore` 指定。`restore.sh` 的 Docker 路径同样执行非空 schema/blob 覆盖保护（需 `--force`），且无论成功或异常退出都会清理容器内 `/tmp/mangekyo-restore.dump` 临时文件（D06 零残余）。

### 5.2 恢复预检

```sh
scripts/ops/restore.sh \
  --archive /backups/<时间戳> \
  --database-url "postgresql://user:pass@127.0.0.1:55432/mangekyo" \
  --dry-run
```

`--dry-run` 只校验 manifest 与 SHA-256，不写入。dry-run 与二次确认会把卷目标显示为 `volume:<name>`。不传 `--blob-dir`/`--blob-volume` 时，`restore.sh` 依次回填 manifest 的 `blobDir` 或 `blobVolume`；显式指定其一不会回填另一个，避免互斥冲突。

### 5.3 实际恢复

同样按原件形态二选一（也可都不传，按 manifest 回填）：

Compose 单机部署（推荐）：

```sh
scripts/ops/restore.sh \
  --archive /backups/<时间戳> \
  --database-url "postgresql://user:pass@127.0.0.1:55432/mangekyo" \
  --blob-volume mangekyo_intakedata \
  --yes   # 或去掉 --yes 手动输入 RESTORE 确认
```

宿主机直接部署：

```sh
scripts/ops/restore.sh \
  --archive /backups/<时间戳> \
  --database-url "postgresql://user:pass@127.0.0.1:55432/mangekyo" \
  --blob-dir /path/to/intake \
  --yes   # 或去掉 --yes 手动输入 RESTORE 确认
```

恢复流程：校验和 → 目标覆盖保护（非空 schema/blob 目录或 Docker 卷 `/intake` 需 `--force`）→ `pg_restore` / `tar` 解包或一次性容器解包到卷 → 核对关键表记录数与 blob 文件数（卷目标统计 `/intake` 文件数）。目标为 Docker 命名卷时，覆盖保护用一次性只读容器检查 `/intake` 是否含文件；卷不存在时允许创建。

`--force` 会先彻底清空目标再写入，杜绝残留脏数据：数据库侧优先以 `DROP SCHEMA ... CASCADE` 清空目标 schema（本机 `psql`，否则经运行中的 PostgreSQL 容器执行 `psql`；两者皆无时退回 `pg_restore --clean --if-exists` 逐对象清理），schema 已清空后 `pg_restore` 非零退出会直接报错终止、不再静默吞错；blob 侧 `--blob-dir` 先校验解析后的真实路径安全（拒绝空路径、`/`、`$HOME` 本身及其上级目录）再仅清空目录内子项、保留目录本身，`--blob-volume` 则在一次性 `--rm` 容器内先清空 `/vol/intake` 再解压。

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

## 6.1 Studio 镜像基底与运行时校验

`deploy/Dockerfile.studio` 基于 `node:26.10.0-bookworm-slim`（Debian glibc），
保证 `@temporalio/core-bridge` 等 `linux-gnu` 原生 `.node` 二进制在容器内正常加载；
Alpine musl 缺少 glibc 会导致加载崩溃，已不再使用。

运行层通过 `apt-get install` 显式安装 `python3` 与 `ca-certificates`，
并通过 `COPY --from=docker:27.5.1-cli` 引入纯 `docker` CLI（无 daemon）。
构建期硬校验 `RUN python3 --version && docker --version`，任一缺失立刻失败，绝不静默跳过。

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
