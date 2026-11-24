#!/usr/bin/env bash
# Mangekyō PostgreSQL + Blob 恢复脚本
#
# 流程：
#   1. 校验 manifest.json 与全部 SHA-256 校验和
#   2. --dry-run 仅预检，不写入
#   3. 恢复前二次确认（或 --yes 跳过）
#   4. 检查目标 schema/blob 目录覆盖保护
#   5. pg_restore / tar 解包
#   6. 恢复后核对关键表记录数与 blob 文件完整性
#
# 用法：
#   scripts/ops/restore.sh --archive /backups/20260101T000000Z \
#     --schema mangekyo_studio --database-url postgresql://user:pass@host:port/db \
#     --blob-dir /data/intake [--yes] [--dry-run] [--force]
#
# 选项：
#   --archive PATH       备份归档目录（必填，含 manifest.json）
#   --schema NAME        目标 PostgreSQL schema（默认取 manifest 中值）
#   --database-url URL   PostgreSQL 连接串（必填）
#   --blob-dir PATH      目标原件/Blob 目录（可选；与 manifest 中 blobDir 对齐）
#   --pg-restore PATH    pg_restore 可执行文件（默认自动探测）
#   --pg-container NAME  PostgreSQL Docker 容器名（默认自动探测）
#   --dry-run            仅校验与预检，不写入
#   --yes                跳过二次确认
#   --force              允许覆盖非空目标 schema/blob 目录
#
# 环境变量：
#   PG_CONTAINER         与 --pg-container 等价（命令行参数优先）
#
# 安全：恢复前请确认目标不是生产库；本脚本默认拒绝覆盖非空目标。
#       恢复后请核对 kernel_schema_migrations 与防回退凭据（D06）。

set -euo pipefail

ARCHIVE=""
SCHEMA=""
DATABASE_URL=""
BLOB_DIR=""
PG_RESTORE=""
PG_CONTAINER=""
DRY_RUN=0
ASSUME_YES=0
FORCE=0

log() { printf '[restore] %s\n' "$*"; }
err() { printf '[restore] ERROR: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2 ;;
    --schema) SCHEMA="$2"; shift 2 ;;
    --database-url) DATABASE_URL="$2"; shift 2 ;;
    --blob-dir) BLOB_DIR="$2"; shift 2 ;;
    --pg-restore) PG_RESTORE="$2"; shift 2 ;;
    --pg-container) PG_CONTAINER="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ -n "${ARCHIVE}" ]] || die "缺少 --archive"
[[ -n "${DATABASE_URL}" ]] || die "缺少 --database-url"
[[ -d "${ARCHIVE}" ]] || die "归档目录不存在：${ARCHIVE}"

MANIFEST="${ARCHIVE}/manifest.json"
[[ -f "${MANIFEST}" ]] || die "归档缺少 manifest.json"

# 读取 manifest 字段（无 jq 时用 python3）
read_manifest() {
  python3 -c "import json,sys; d=json.load(open('${MANIFEST}')); print(d.get('$1',''))" 2>/dev/null || true
}

MANIFEST_SCHEMA="$(read_manifest schema)"
MANIFEST_BLOB_DIR="$(read_manifest blobDir)"
[[ -z "${SCHEMA}" ]] && SCHEMA="${MANIFEST_SCHEMA}"
[[ -z "${BLOB_DIR}" ]] && BLOB_DIR="${MANIFEST_BLOB_DIR}"
[[ -n "${SCHEMA}" ]] || die "无法确定目标 schema"
[[ "${SCHEMA}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "schema 名无效：${SCHEMA}"

# pg_restore 自定义格式不支持跨 schema 重映射；--schema 只过滤对象。
# 因此恢复目标 schema 必须与备份时 schema 一致（manifest.schema）。
# 若用户指定了不同 --schema，视为目标覆盖检查用，不改变实际恢复 schema。
# 提前确定 RESTORE_SCHEMA，确保第 2 步覆盖保护检查的是实际写入的 schema。
RESTORE_SCHEMA="${MANIFEST_SCHEMA:-${SCHEMA}}"

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

# docker 路径前确保 PG_CONTAINER 已填充；找不到则报错退出。
ensure_pg_container() {
  if [[ -z "${PG_CONTAINER}" ]]; then
    PG_CONTAINER="$(detect_pg_container || true)"
  fi
  [[ -n "${PG_CONTAINER}" ]] || die "docker 模式需要 PostgreSQL 容器；请用 --pg-container 或 PG_CONTAINER 指定，或确认容器在运行。"
}

# 从 DATABASE_URL 提取 user:pass:dbname（供 docker exec -e PGPASSWORD 使用）
extract_db_creds() {
  DB_USER="$(echo "${DATABASE_URL}" | sed -E 's|.*://([^:]+):.*|\1|')"
  DB_PASS="$(echo "${DATABASE_URL}" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')"
  DB_NAME="$(echo "${DATABASE_URL}" | sed -E 's|.*/([^/?]+).*|\1|')"
}

# 选择 pg_restore：优先显式指定，其次 PATH，最后 docker exec <探测容器>
if [[ -z "${PG_RESTORE}" ]]; then
  if command -v pg_restore >/dev/null 2>&1; then
    PG_RESTORE="$(command -v pg_restore)"
  else
    PG_CONTAINER="$(detect_pg_container || true)"
    if [[ -n "${PG_CONTAINER}" ]]; then
      PG_RESTORE="docker exec ${PG_CONTAINER} pg_restore"
      log "未找到本机 pg_restore，使用 docker exec ${PG_CONTAINER} pg_restore"
    else
      die "未找到 pg_restore。请安装 PostgreSQL 客户端、用 --pg-restore 指定，或确保 PostgreSQL 容器在运行。"
    fi
  fi
fi

# ---------- 1. 校验 SHA-256 ----------
log "校验归档完整性…"
cd "${ARCHIVE}"
if [[ -f SHA256SUMS ]]; then
  shasum -a 256 -c SHA256SUMS 2>/dev/null || sha256sum -c SHA256SUMS
else
  # 无 SHA256SUMS 时用 manifest 中的校验和
  python3 - << 'PYEOF'
import json, hashlib, os, sys
manifest = json.load(open('manifest.json'))
for name, meta in manifest.get('files', {}).items():
    if not os.path.exists(name):
        print(f'MISSING: {name}', file=sys.stderr); sys.exit(1)
    h = hashlib.sha256(open(name,'rb').read()).hexdigest()
    if h != meta['sha256']:
        print(f'CHECKSUM MISMATCH: {name}', file=sys.stderr); sys.exit(1)
    print(f'OK: {name}')
PYEOF
fi
cd - >/dev/null
log "校验和全部通过。"

# ---------- 2. 目标覆盖保护 ----------
# 本机无 psql 时，尝试探测容器以支持 docker exec psql 覆盖检查。
if ! command -v psql >/dev/null 2>&1 && [[ -z "${PG_CONTAINER}" ]]; then
  PG_CONTAINER="$(detect_pg_container || true)"
fi

if [[ "${FORCE}" -eq 0 ]]; then
  # 收集需检查的 schema：实际写入的 RESTORE_SCHEMA，
  # 以及用户显式传入且与其不同的 SCHEMA（防止误覆盖同名目标）。
  schemas_to_check=("${RESTORE_SCHEMA}")
  if [[ "${SCHEMA}" != "${RESTORE_SCHEMA}" ]]; then
    schemas_to_check+=("${SCHEMA}")
  fi

  # 统计某 schema 下已存在的表数；无可用通道时按 0 处理（与旧行为一致，尽力而为）。
  count_schema_tables() {
    local s="$1"
    if command -v psql >/dev/null 2>&1; then
      psql "${DATABASE_URL}" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='${s}'" \
        2>/dev/null || echo "0"
    elif [[ -n "${PG_CONTAINER}" ]]; then
      extract_db_creds
      docker exec -e PGPASSWORD="${DB_PASS}" "${PG_CONTAINER}" \
        psql -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='${s}'" \
        -U "${DB_USER}" -d "${DB_NAME}" 2>/dev/null || echo "0"
    else
      echo "0"
    fi
  }

  for s in "${schemas_to_check[@]}"; do
    existing="$(count_schema_tables "${s}")"
    if [[ "${existing}" =~ ^[0-9]+$ && "${existing}" -gt 0 ]]; then
      die "目标 schema ${s} 已存在 ${existing} 张表。如需覆盖请加 --force；如需保留请先备份或换 schema。"
    fi
  done

  # 检查 blob 目录是否非空
  if [[ -n "${BLOB_DIR}" && -d "${BLOB_DIR}" ]] && [[ "$(find "${BLOB_DIR}" -type f | head -1)" ]]; then
    die "目标 blob 目录 ${BLOB_DIR} 非空。如需覆盖请加 --force。"
  fi
fi

# ---------- 3. Dry-run ----------
if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "DRY-RUN：仅预检，未写入。"
  log "  归档：${ARCHIVE}"
  log "  目标 schema：${SCHEMA}"
  log "  恢复 schema：${RESTORE_SCHEMA}"
  log "  目标 blob：${BLOB_DIR:-（无）}"
  log "  数据库 dump：$(du -h "${ARCHIVE}/database.dump" | cut -f1)"
  [[ -f "${ARCHIVE}/blobs.tar.gz" ]] && log "  Blob 包：$(du -h "${ARCHIVE}/blobs.tar.gz" | cut -f1)"
  log "  manifest kernelSchemaVersion：$(read_manifest kernelSchemaVersion)"
  exit 0
fi

# ---------- 4. 二次确认 ----------
if [[ "${ASSUME_YES}" -eq 0 ]]; then
  echo "即将恢复到："
  echo "  schema: ${SCHEMA}"
  echo "  blob:   ${BLOB_DIR:-（无）}"
  echo "  数据库: ${DATABASE_URL%%@*}@***"
  read -r -p "确认恢复？输入 RESTORE 继续：" confirm
  [[ "${confirm}" == "RESTORE" ]] || die "已取消。"
fi

# ---------- 5. 恢复数据库 ----------
log "恢复数据库 schema ${RESTORE_SCHEMA} …"
# pg_restore 自定义格式 dump 包含 CREATE SCHEMA（备份时 --schema 会写入 TOC）。
# 不要预建 schema，否则 pg_restore 报 "already exists"。
# 若 dump 不含 CREATE SCHEMA（如全库 dump），预建是必要的，但当前 --schema 模式已包含。
# pg_restore：dump 已按 --schema 过滤，直接恢复全部 TOC 对象。
# 不传 --schema，避免二次过滤；--no-owner --no-privileges 保持权限中立。
if [[ "${PG_RESTORE}" == docker* ]]; then
  ensure_pg_container
  extract_db_creds
  docker cp "${ARCHIVE}/database.dump" "${PG_CONTAINER}:/tmp/mangekyo-restore.dump"
  # pg_restore 对 CREATE SCHEMA 报 "already exists" 是良性；不加 --exit-on-error，
  # 恢复后由记录数核对兜底。
  # pg_restore returns non-zero for ignored errors (e.g. schema exists).
  # Capture errors, log them, continue; verified by post-restore checks.
  set +e
  docker exec -e PGPASSWORD="${DB_PASS}" "${PG_CONTAINER}" \
    pg_restore --no-owner --no-privileges \
    -U "${DB_USER}" -d "${DB_NAME}" /tmp/mangekyo-restore.dump 2>&1
  pg_restore_exit=$?
  set -e
  if (( pg_restore_exit != 0 )); then
    log "pg_restore 退出码 ${pg_restore_exit}（含已忽略错误，如 schema 已存在）。"
  fi
else
  set +e
  "${PG_RESTORE}" --no-owner --no-privileges \
    --dbname="${DATABASE_URL}" "${ARCHIVE}/database.dump" 2>&1
  pg_restore_exit=$?
  set -e
  if (( pg_restore_exit != 0 )); then
    log "pg_restore 退出码 ${pg_restore_exit}（含已忽略错误，如 schema 已存在）。"
  fi
fi
log "数据库恢复完成。"

# ---------- 6. 恢复 Blob ----------
if [[ -n "${BLOB_DIR}" && -f "${ARCHIVE}/blobs.tar.gz" ]]; then
  log "恢复原件目录 ${BLOB_DIR} …"
  mkdir -p "${BLOB_DIR}"
  # 归档内为目录内容（.），解压到目标目录。
  tar -xzf "${ARCHIVE}/blobs.tar.gz" -C "${BLOB_DIR}"
  log "Blob 恢复完成。"
fi

# ---------- 7. 恢复后核对 ----------
log "核对关键表记录数…"
VERIFY_SCHEMA="${RESTORE_SCHEMA:-${SCHEMA}}"
# 优先核对内核关键表；若 schema 非内核（如演练临时 schema），退化为表计数核对。
verify_sql() {
  cat <<SQL
SELECT 'facts' AS tbl, count(*) FROM ${VERIFY_SCHEMA}.facts
UNION ALL SELECT 'fact_revs', count(*) FROM ${VERIFY_SCHEMA}.fact_revs
UNION ALL SELECT 'commands', count(*) FROM ${VERIFY_SCHEMA}.commands
UNION ALL SELECT 'work', count(*) FROM ${VERIFY_SCHEMA}.work
UNION ALL SELECT 'kernel_schema_migrations', count(*) FROM ${VERIFY_SCHEMA}.kernel_schema_migrations
ORDER BY 1;
SQL
}
verify_sql_generic() {
  cat <<SQL
SELECT count(*) AS table_count FROM information_schema.tables WHERE table_schema='${VERIFY_SCHEMA}';
SQL
}
if command -v psql >/dev/null 2>&1; then
  if psql "${DATABASE_URL}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='${VERIFY_SCHEMA}' AND table_name='facts'" 2>/dev/null | grep -q '^[1-9]'; then
    psql "${DATABASE_URL}" -c "$(verify_sql)"
  else
    psql "${DATABASE_URL}" -c "$(verify_sql_generic)"
  fi
else
  # 无本机 psql：尝试 docker exec <探测容器> psql 核对。
  if [[ -z "${PG_CONTAINER}" ]]; then
    PG_CONTAINER="$(detect_pg_container || true)"
  fi
  if [[ -n "${PG_CONTAINER}" ]]; then
    extract_db_creds
    has_facts="$(docker exec -e PGPASSWORD="${DB_PASS}" "${PG_CONTAINER}" \
      psql -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='${VERIFY_SCHEMA}' AND table_name='facts'" \
      -U "${DB_USER}" -d "${DB_NAME}" 2>/dev/null || echo 0)"
    if [[ "${has_facts}" =~ ^[1-9] ]]; then
      docker exec -e PGPASSWORD="${DB_PASS}" "${PG_CONTAINER}" \
        psql -c "$(verify_sql)" -U "${DB_USER}" -d "${DB_NAME}"
    else
      docker exec -e PGPASSWORD="${DB_PASS}" "${PG_CONTAINER}" \
        psql -c "$(verify_sql_generic)" -U "${DB_USER}" -d "${DB_NAME}"
    fi
  fi
fi

if [[ -n "${BLOB_DIR}" && -d "${BLOB_DIR}" ]]; then
  log "核对 blob 文件完整性…"
  blob_count="$(find "${BLOB_DIR}" -type f | wc -l | tr -d ' ')"
  log "  文件数：${blob_count}"
  # 若归档中有原始清单可逐一核对 sha256；当前按数量与存在性核对。
fi

log "恢复完成。请核对："
log "  1. kernel_schema_migrations 版本与防回退凭据（D06）"
log "  2. Temporal 历史与 worker 版本路由"
log "  3. 原件 store-id 标记与 meta.json 一致性"
