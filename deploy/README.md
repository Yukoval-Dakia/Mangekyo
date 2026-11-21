# Mangekyō 私有单机部署

本目录包含私有单机一键部署产物。完整说明见 [docs/deploy/self-hosted.md](../docs/deploy/self-hosted.md)。

## 文件

- `docker-compose.yml` — PostgreSQL 18 + Temporal + Mangekyō Studio 单容器编排，仅 loopback 绑定。
- `Dockerfile.studio` — Studio 镜像（Node 26 + pnpm + 已构建 kernel/web）。
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
# 备份（schema + 原件目录）
scripts/ops/backup.sh --schema mangekyo_studio --blob-dir /data/intake \
  --database-url postgresql://user:pass@127.0.0.1:55432/mangekyo --backup-root /backups

# 恢复预检
scripts/ops/restore.sh --archive /backups/<时间戳> --database-url ... --dry-run

# 实际恢复
scripts/ops/restore.sh --archive /backups/<时间戳> --database-url ... --yes
```
