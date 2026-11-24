#!/usr/bin/env bash
# Mangekyō PostgreSQL + Blob 一致性备份脚本
#
# 产物：带时间戳的归档目录 <backup-root>/<UTC时间戳>/，内含：
#   - database.dump      pg_dump --format=custom（指定 schema）
#   - blobs.tar.gz       原件/Blob 目录打包
#   - manifest.json      schema 版本/迁移水位、文件校验和、备份时间
#   - SHA256SUMS         全部产物校验和
#
# 用法：
#   scripts/ops/backup.sh --schema mangekyo_studio --blob-dir /data/intake \
#     --database-url postgresql://user:pass@host:port/db --backup-root /backups
#
# 选项：
#   --schema NAME        PostgreSQL schema（默认 mangekyo_studio）
#   --database-url URL   PostgreSQL 连接串（必填）
#   --blob-dir PATH      原件/Blob 根目录（可选；不存在则跳过）
#   --backup-root PATH   备份根目录（默认 ./backups）
#   --keep N             保留最近 N 份归档，超出删除最旧（默认 30，0=不清理）
#   --pg-dump PATH       pg_dump 可执行文件（默认自动探测）
#   --pg-container NAME  PostgreSQL Docker 容器名（默认自动探测）
#
# 环境变量：
#   PG_CONTAINER         与 --pg-container 等价（命令行参数优先）
#
# 说明：备份包含用户原件与学习记录，受 D06 删除边界约束。
#       已离线备份的副本在擦除后标为 unverified，需用户自行清理旧离线归档。
#       备份默认保留 30 天（--keep 30），与 docs/product-spec.md D06 一致。

set -euo pipefail

SCHEMA="mangekyo_studio"
DATABASE_URL=""
BLOB_DIR=""
BACKUP_ROOT="./backups"
KEEP=30
PG_DUMP=""
PG_CONTAINER=""

log() { printf '[backup] %s\n' "$*"; }
err() { printf '[backup] ERROR: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --schema) SCHEMA="$2"; shift 2 ;;
    --database-url) DATABASE_URL="$2"; shift 2 ;;
    --blob-dir) BLOB_DIR="$2"; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --pg-dump) PG_DUMP="$2"; shift 2 ;;
    --pg-container) PG_CONTAINER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ -n "${DATABASE_URL}" ]] || die "缺少 --database-url"
[[ "${SCHEMA}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "schema 名无效：${SCHEMA}"

# 探测运行中的 PostgreSQL 容器。优先级（可用 PG_CONTAINER 环境变量或
# --pg-container 显式指定覆盖）：
#   1. mangekyo-postgres-1   官方 deploy/docker-compose.yml（name: mangekyo + service postgres）
#   2. mangekyo_postgres_1   Compose v1 兼容命名
#   3. mangekyo-dev          本机开发容器兜底
detect_pg_container() {
  if [[ -n "${PG_CONTAINER}" ]]; then
    printf '%s' "${PG_CONTAINER}"
    return 0
  fi
  local candidate
  for candidate in mangekyo-postgres-1 mangekyo_postgres_1 mangekyo-dev; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${candidate}"; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

# 从 DATABASE_URL 提取 user:pass:dbname（供 docker exec -e PGPASSWORD 使用）
extract_db_creds() {
  DB_USER="$(echo "${DATABASE_URL}" | sed -E 's|.*://([^:]+):.*|\1|')"
  DB_PASS="$(echo "${DATABASE_URL}" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')"
  DB_NAME="$(echo "${DATABASE_URL}" | sed -E 's|.*/([^/?]+).*|\1|')"
}

# 选择 pg_dump：优先显式指定，其次 PATH，最后 docker exec <探测容器>
if [[ -z "${PG_DUMP}" ]]; then
  if command -v pg_dump >/dev/null 2>&1; then
    PG_DUMP="$(command -v pg_dump)"
  else
    PG_CONTAINER="$(detect_pg_container || true)"
    if [[ -n "${PG_CONTAINER}" ]]; then
      PG_DUMP="docker exec ${PG_CONTAINER} pg_dump"
      log "未找到本机 pg_dump，使用 docker exec ${PG_CONTAINER} pg_dump"
    else
      die "未找到 pg_dump。请安装 PostgreSQL 客户端、用 --pg-dump 指定，或确保 PostgreSQL 容器在运行。"
    fi
  fi
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
mkdir -p "${ARCHIVE_DIR}"
log "备份目录：${ARCHIVE_DIR}"

# 1. PostgreSQL 自定义格式 dump（指定 schema）
DUMP_FILE="${ARCHIVE_DIR}/database.dump"
log "导出 schema ${SCHEMA} …"
if [[ "${PG_DUMP}" == docker* ]]; then
  # 显式 --pg-dump docker… 但未指定容器时，回退探测。
  if [[ -z "${PG_CONTAINER}" ]]; then
    PG_CONTAINER="$(detect_pg_container || true)"
  fi
  [[ -n "${PG_CONTAINER}" ]] || die "docker 模式需要 PostgreSQL 容器；请用 --pg-container 或 PG_CONTAINER 指定，或确认容器在运行。"
  extract_db_creds
  docker exec -e PGPASSWORD="${DB_PASS}" "${PG_CONTAINER}" \
    pg_dump --format=custom --schema="${SCHEMA}" --no-owner --no-privileges \
    -U "${DB_USER}" -d "${DB_NAME}" > "${DUMP_FILE}"
else
  "${PG_DUMP}" --format=custom --schema="${SCHEMA}" --no-owner --no-privileges \
    "${DATABASE_URL}" > "${DUMP_FILE}"
fi
[[ -s "${DUMP_FILE}" ]] || die "pg_dump 输出为空"
log "数据库 dump 完成：$(du -h "${DUMP_FILE}" | cut -f1)"

# 2. Blob/原件目录打包
BLOB_ARCHIVE=""
if [[ -n "${BLOB_DIR}" && -d "${BLOB_DIR}" ]]; then
  BLOB_ARCHIVE="${ARCHIVE_DIR}/blobs.tar.gz"
  log "打包原件目录 ${BLOB_DIR} …"
  # 打包目录内容而非目录本身，恢复时解压到目标目录。
  tar -czf "${BLOB_ARCHIVE}" -C "${BLOB_DIR}" .
  log "Blob 打包完成：$(du -h "${BLOB_ARCHIVE}" | cut -f1)"
elif [[ -n "${BLOB_DIR}" ]]; then
  log "警告：blob 目录不存在，跳过：${BLOB_DIR}"
fi

# 3. 收集 schema 版本/迁移水位
# 优先本机 psql；否则用 docker exec <探测容器> psql（与 pg_dump 探测一致）。
SCHEMA_VERSION=""
if command -v psql >/dev/null 2>&1; then
  SCHEMA_VERSION="$(psql "${DATABASE_URL}" -tAc "SELECT max(version) FROM ${SCHEMA}.kernel_schema_migrations" 2>/dev/null || true)"
else
  # 本机无 psql：尝试探测容器（pg_dump 探测阶段可能已填充）。
  if [[ -z "${PG_CONTAINER}" ]]; then
    PG_CONTAINER="$(detect_pg_container || true)"
  fi
  if [[ -n "${PG_CONTAINER}" ]]; then
    extract_db_creds
    SCHEMA_VERSION="$(docker exec -e PGPASSWORD="${DB_PASS}" "${PG_CONTAINER}" \
      psql -tAc "SELECT max(version) FROM ${SCHEMA}.kernel_schema_migrations" \
      -U "${DB_USER}" -d "${DB_NAME}" 2>/dev/null || true)"
  fi
fi
MIGRATION_WATERMARK="${SCHEMA_VERSION}"

# 4. 生成 manifest.json
MANIFEST="${ARCHIVE_DIR}/manifest.json"
BLOB_JSON=""
if [[ -n "${BLOB_ARCHIVE}" ]]; then
  BLOB_JSON=", \"blobs.tar.gz\": {\"sha256\": \"$(shasum -a 256 "${BLOB_ARCHIVE}" | cut -d' ' -f1)\", \"size\": $(stat -f%z "${BLOB_ARCHIVE}" 2>/dev/null || stat -c%s "${BLOB_ARCHIVE}")}"
fi
cat > "${MANIFEST}" << MANIFEST_EOF
{
  "format": "mangekyo-backup-v1",
  "createdAt": "${TIMESTAMP}",
  "schema": "${SCHEMA}",
  "databaseUrl": "${DATABASE_URL%%@*}@***",
  "kernelSchemaVersion": ${SCHEMA_VERSION:-null},
  "migrationWatermark": ${MIGRATION_WATERMARK:-null},
  "files": {
    "database.dump": {
      "sha256": "$(shasum -a 256 "${DUMP_FILE}" | cut -d' ' -f1)",
      "size": $(stat -f%z "${DUMP_FILE}" 2>/dev/null || stat -c%s "${DUMP_FILE}")
    }${BLOB_JSON}
  },
  "blobDir": "${BLOB_DIR:-}",
  "retention": {
    "keep": ${KEEP},
    "note": "备份含用户原件与学习记录；已离线备份的副本在擦除后标为 unverified，需用户自行清理旧离线归档（D06）"
  }
}
MANIFEST_EOF

# 5. SHA256SUMS
cd "${ARCHIVE_DIR}"
shasum -a 256 database.dump $(if [[ -f blobs.tar.gz ]]; then echo blobs.tar.gz; fi) manifest.json > SHA256SUMS
cd - >/dev/null

log "备份完成：${ARCHIVE_DIR}"
log "  文件：$(ls -1 "${ARCHIVE_DIR}" | tr '\n' ' ')"

# 6. 保留策略
if [[ "${KEEP}" -gt 0 ]]; then
  mapfile -t archives < <(ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null | tail -n +$((KEEP + 1)))
  for old in "${archives[@]:-}"; do
    [[ -n "${old}" ]] || continue
    log "清理过期备份：${old}"
    node -e "import('node:fs').then(fs=>fs.rmSync(process.argv[1],{recursive:true,force:true}))" "${old}"
  done
fi
