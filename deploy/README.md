# Mangekyō 私有单机部署

本目录包含私有单机一键部署产物。完整说明见 [docs/deploy/self-hosted.md](../docs/deploy/self-hosted.md)。

## 文件

- `docker-compose.yml` — PostgreSQL 18 + Temporal + Mangekyō Studio 单容器编排，仅 loopback 绑定。
- `Dockerfile.studio` — Studio 镜像（Node 26 + pnpm + 已构建 kernel/web）。
- `temporal-dynamicconfig.yaml` — Temporal 动态配置（Worker Deployments API），compose 只读挂载。
- `.env.example` — 全部环境变量模板（占位符，无真实密钥）。
- `start.sh` — 幂等一键启动/预检脚本。

## 快速开始

```sh
cd deploy
cp .env.example .env   # 填写 POSTGRES_PASSWORD 等真实值
./start.sh             # 构建并启动，等待健康检查与迁移完成
```

打开 http://127.0.0.1:4317/ 。

## 备份与恢复

```sh
# Compose 单机备份（推荐：通过 --env-file 只读读取 deploy/.env，密码含 @/?/#/: 等特殊字符无需 URI 编码）
scripts/ops/backup.sh --schema mangekyo_studio --blob-volume mangekyo_intakedata \
  --env-file deploy/.env --backup-root /backups

# 恢复预检
scripts/ops/restore.sh --archive /backups/<时间戳> --env-file deploy/.env --dry-run

# 实际恢复
scripts/ops/restore.sh --archive /backups/<时间戳> --env-file deploy/.env \
  --blob-volume mangekyo_intakedata --yes
```

宿主机直接部署可改用 `--blob-dir <目录>`；连接参数除 `--env-file` 外，也同时兼容 `--database-url <URL>`（与 `--env-file` 互斥）或标准 PostgreSQL 环境变量（`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` 及 `POSTGRES_*`）。

