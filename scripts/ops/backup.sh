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
#   scripts/ops/backup.sh --schema mangekyo_studio \
#     (--blob-dir /data/intake | --blob-volume mangekyo_intakedata) \
#     --database-url postgresql://user:pass@host:port/db --backup-root /backups
#
# 选项：
#   --schema NAME        PostgreSQL schema（默认 mangekyo_studio）
#   --database-url URL   PostgreSQL 连接串（必填；manifest 中密码自动脱敏）
#   --blob-dir PATH      原件/Blob 根目录（可选；与 --blob-volume 互斥；不存在则跳过）
#   --blob-volume NAME   原件/Blob Docker 命名卷（可选；与 --blob-dir 互斥；卷内 /intake 不存在则跳过）
#   --backup-root PATH   备份根目录（默认 ./backups）
#   --keep N             保留最近 N 份归档，超出删除最旧（默认 30，0=不清理）
#   --pg-dump PATH       pg_dump 可执行文件（默认自动探测）
#   --pg-container NAME  PostgreSQL Docker 容器名（默认自动探测）
#
# 环境变量：
#   PG_CONTAINER         与 --pg-container 等价（命令行参数优先）
#   BLOB_HELPER_IMAGE    卷备份辅助镜像（默认 postgres:18.7-alpine3.24）
#
# 说明：备份包含用户原件与学习记录，受 D06 删除边界约束。
#       已离线备份的副本在擦除后标为 unverified，需用户自行清理旧离线归档。
#       备份默认保留 30 天（--keep 30），与 docs/product-spec.md D06 一致。

set -euo pipefail

SCHEMA="mangekyo_studio"
DATABASE_URL=""
BLOB_DIR=""
BLOB_VOLUME=""
BLOB_DIR_SET=0
BLOB_VOLUME_SET=0
BACKUP_ROOT="./backups"
KEEP=30
PG_DUMP=""
PG_CONTAINER="${PG_CONTAINER:-}"
BLOB_HELPER_IMAGE="${BLOB_HELPER_IMAGE:-postgres:18.7-alpine3.24}"

log() { printf '[backup] %s\n' "$*"; }
err() { printf '[backup] ERROR: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# 脱敏 DATABASE_URL 中的密码为 ***。
# 通过环境变量传入 python3，绝不作为 CLI 参数暴露在 ps 进程列表中。
# 主路径：urlsplit 后在 netloc 内按最后一个 @ 定位凭据段（密码可含未编码 @/:/IPv6）。
# 兜底：密码含未编码 / 时 urlsplit 会把 @host/db 截进 path、netloc 只剩 user:pass，
#       此时对 scheme:// 之后、?/# 之前的整段同样按最后一个 @ 取凭据段再脱敏。
# 无密码/无凭据段原样返回；解析异常返回 <redacted>，绝不泄露明文密码。
redact_db_url() {
  command -v python3 >/dev/null 2>&1 \
    || { printf '%s' '<redacted>'; return 0; }
  RAW_DB_URL="$1" python3 -c '
import os, sys
from urllib.parse import urlsplit, urlunsplit

raw = os.environ["RAW_DB_URL"]

def mask_head(head):
    # head 中最后一个 @ 之前为凭据段、之后为主机及路径等其余内容；
    # 凭据段按第一个 : 分离用户名与密码（用户名可含未编码 @）。
    # 无 @ 或凭据段无 :（无密码）返回 None，由调用方原样返回。
    if "@" not in head:
        return None
    cred, _, rest = head.rpartition("@")
    if ":" not in cred:
        return None
    return cred.split(":", 1)[0] + ":***@" + rest

try:
    u = urlsplit(raw)
    if "@" in u.netloc and "@" not in u.path:
        masked = mask_head(u.netloc)
        if masked is None:
            sys.stdout.write(raw)
        else:
            sys.stdout.write(urlunsplit((u.scheme, masked, u.path, u.query, u.fragment)))
    elif u.scheme and "://" in raw:
        # netloc 无 @（密码含未编码 / 使 urlsplit 截断），或 path 也含 @
        # （密码同时含未编码 @ 与 /，netloc 中的 @ 属于密码而非分隔符）：
        # 对 ?/# 之前的整段按最后一个 @ 取凭据段再脱敏；无凭据原样输出。
        head = raw.split("?", 1)[0].split("#", 1)[0]
        suffix = raw[len(head):]
        authority = head.split("://", 1)[1] if "://" in head else ""
        masked = mask_head(authority)
        if masked is None:
            sys.stdout.write(raw)
        else:
            sys.stdout.write(u.scheme + "://" + masked + suffix)
    else:
        sys.stdout.write(raw)
except Exception:
    sys.stdout.write("<redacted>")
'
}

# 计算 SHA-256：兼容 macOS shasum -a 256 与 Linux sha256sum（与 restore.sh 校验对齐）。
sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    die "缺少 shasum/sha256sum，无法计算校验和。"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --schema) SCHEMA="$2"; shift 2 ;;
    --database-url) DATABASE_URL="$2"; shift 2 ;;
    --blob-dir) BLOB_DIR="$2"; BLOB_DIR_SET=1; shift 2 ;;
    --blob-volume) BLOB_VOLUME="$2"; BLOB_VOLUME_SET=1; shift 2 ;;
    --backup-root) BACKUP_ROOT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --pg-dump) PG_DUMP="$2"; shift 2 ;;
    --pg-container) PG_CONTAINER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,31p' "$0"
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ -n "${DATABASE_URL}" ]] || die "缺少 --database-url"
[[ "${SCHEMA}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "schema 名无效：${SCHEMA}"
if [[ "${BLOB_DIR_SET}" -eq 1 && "${BLOB_VOLUME_SET}" -eq 1 ]]; then
  die "--blob-dir 与 --blob-volume 互斥"
fi
if [[ "${BLOB_VOLUME_SET}" -eq 1 ]]; then
  [[ "${BLOB_VOLUME}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || die "Docker 卷名无效：${BLOB_VOLUME}"
fi

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

# 从 DATABASE_URL 提取 user:pass:dbname（供 docker exec -e PGPASSWORD 使用）。
# 用 python3 urllib.parse 做严格解码：兼容 URL 编码（%40/%3A 等）、原始冒号、
# 空格/引号/$/反斜杠等特殊字符，以及无密码（u.password 为 None -> 空串）。
# DATABASE_URL 经环境变量传给 python3，绝不作为 CLI 参数暴露在 ps 进程列表中；
# 解析结果以 NUL 分隔并直接管道给 read -d ''，密码不落变量、不做任何 shell 展开。
extract_db_creds() {
  command -v python3 >/dev/null 2>&1 \
    || die "缺少 python3，无法解析 DATABASE_URL。"
  DB_USER="" DB_PASS="" DB_NAME=""
  local idx=0 field
  while IFS= read -r -d '' field; do
    case "${idx}" in
      0) DB_USER="${field}" ;;
      1) DB_PASS="${field}" ;;
      2) DB_NAME="${field}" ;;
    esac
    idx=$((idx + 1))
  done < <(DATABASE_URL="${DATABASE_URL}" python3 -c '
import os, sys
from urllib.parse import urlsplit, unquote
try:
    u = urlsplit(os.environ["DATABASE_URL"])
except Exception:
    sys.exit("无法解析 DATABASE_URL。")
user = unquote(u.username) if u.username is not None else ""
password = unquote(u.password) if u.password is not None else ""
dbname = unquote(u.path.lstrip("/")) if u.path else ""
if not user or not dbname:
    sys.exit("DATABASE_URL 缺少用户名或库名。")
sys.stdout.buffer.write(user.encode() + b"\0" + password.encode() + b"\0" + dbname.encode() + b"\0")
')
  # python 失败时无 NUL 输出，idx<3 由下方检查兜底；stderr 已是无敏感信息的固定文案。
  [[ "${idx}" -ge 3 && -n "${DB_USER}" && -n "${DB_NAME}" ]] \
    || die "DATABASE_URL 缺少用户名或库名。"
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

# 2. Blob/原件目录或 Docker 卷打包
BLOB_ARCHIVE=""
if [[ -n "${BLOB_VOLUME}" ]]; then
  docker volume inspect "${BLOB_VOLUME}" >/dev/null 2>&1 || die "Docker 卷不存在：${BLOB_VOLUME}"
  set +e
  docker run --rm -v "${BLOB_VOLUME}:/vol:ro" "${BLOB_HELPER_IMAGE}" sh -c 'test -d /vol/intake || exit 42'
  blob_probe_status=$?
  set -e
  if [[ "${blob_probe_status}" -eq 0 ]]; then
    BLOB_ARCHIVE="${ARCHIVE_DIR}/blobs.tar.gz"
    log "打包 Docker 卷 ${BLOB_VOLUME}/intake …"
    docker run --rm -v "${BLOB_VOLUME}:/vol:ro" "${BLOB_HELPER_IMAGE}" tar -czf - -C /vol/intake . > "${BLOB_ARCHIVE}"
    log "Blob 打包完成：$(du -h "${BLOB_ARCHIVE}" | cut -f1)"
  elif [[ "${blob_probe_status}" -eq 42 ]]; then
    log "警告：Docker 卷 ${BLOB_VOLUME}/intake 不存在，跳过：${BLOB_VOLUME}"
  else
    die "无法探测 Docker 卷 ${BLOB_VOLUME}/intake（docker run 退出码 ${blob_probe_status}）"
  fi
elif [[ -n "${BLOB_DIR}" && -d "${BLOB_DIR}" ]]; then
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
SCHEMA_VERSION="$(printf '%s' "${SCHEMA_VERSION}" | tr -d '[:space:]')"
if ! [[ "${SCHEMA_VERSION}" =~ ^[0-9]+$ ]]; then
  SCHEMA_VERSION=""
fi
MIGRATION_WATERMARK="${SCHEMA_VERSION}"

# 4. 生成 manifest.json
# 用 python3 json.dump 序列化：路径/密码含引号、反斜杠、空格等特殊字符时
# 不会产生非法 JSON；非 ASCII 文案（retention.note）保持 UTF-8 原样。
MANIFEST="${ARCHIVE_DIR}/manifest.json"
DUMP_SHA256="$(sha256_file "${DUMP_FILE}")"
BLOB_SHA256=""
if [[ -n "${BLOB_ARCHIVE}" ]]; then
  BLOB_SHA256="$(sha256_file "${BLOB_ARCHIVE}")"
fi
MANIFEST_PATH="${MANIFEST}" \
TIMESTAMP="${TIMESTAMP}" \
SCHEMA="${SCHEMA}" \
REDACTED_DB_URL="$(redact_db_url "${DATABASE_URL}")" \
SCHEMA_VERSION="${SCHEMA_VERSION}" \
MIGRATION_WATERMARK="${MIGRATION_WATERMARK}" \
DUMP_FILE="${DUMP_FILE}" \
DUMP_SHA256="${DUMP_SHA256}" \
BLOB_ARCHIVE="${BLOB_ARCHIVE}" \
BLOB_SHA256="${BLOB_SHA256}" \
BLOB_DIR="${BLOB_DIR:-}" \
BLOB_VOLUME="${BLOB_VOLUME:-}" \
KEEP="${KEEP}" \
python3 - <<'PY'
import json, os

def _int_or_none(value):
    value = value.strip()
    return int(value) if value.isdigit() else None

files = {
    "database.dump": {
        "sha256": os.environ["DUMP_SHA256"],
        "size": os.path.getsize(os.environ["DUMP_FILE"]),
    }
}
if os.environ["BLOB_ARCHIVE"]:
    files["blobs.tar.gz"] = {
        "sha256": os.environ["BLOB_SHA256"],
        "size": os.path.getsize(os.environ["BLOB_ARCHIVE"]),
    }

manifest = {
    "format": "mangekyo-backup-v1",
    "createdAt": os.environ["TIMESTAMP"],
    "schema": os.environ["SCHEMA"],
    "databaseUrl": os.environ["REDACTED_DB_URL"],
    "kernelSchemaVersion": _int_or_none(os.environ["SCHEMA_VERSION"]),
    "migrationWatermark": _int_or_none(os.environ["MIGRATION_WATERMARK"]),
    "files": files,
    "blobDir": os.environ["BLOB_DIR"],
    "blobVolume": os.environ["BLOB_VOLUME"],
    "retention": {
        "keep": int(os.environ["KEEP"]),
        "note": "备份含用户原件与学习记录；已离线备份的副本在擦除后标为 unverified，需用户自行清理旧离线归档（D06）",
    },
}
with open(os.environ["MANIFEST_PATH"], "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

# 5. SHA256SUMS
# 双兼容生成：macOS shasum 与 Linux sha256sum 输出同为 <hash>  <file>，均可被 -c 校验。
cd "${ARCHIVE_DIR}"
: > SHA256SUMS
for sum_file in database.dump $(if [[ -f blobs.tar.gz ]]; then echo blobs.tar.gz; fi) manifest.json; do
  printf '%s  %s\n' "$(sha256_file "${sum_file}")" "${sum_file}" >> SHA256SUMS
done
cd - >/dev/null

log "备份完成：${ARCHIVE_DIR}"
log "  文件：$(ls -1 "${ARCHIVE_DIR}" | tr '\n' ' ')"

# 6. 保留策略
# 只清理本脚本产出的归档目录：一级子目录名须匹配 UTC 时间戳格式
# （\d{8}T\d{6}Z）且含 manifest.json；其余目录一律不计数、不触碰，
# 防止误删 --backup-root 下用户自建的 keep-me/ 等目录。
if [[ "${KEEP}" -gt 0 ]]; then
  command -v python3 >/dev/null 2>&1 \
    || die "缺少 python3，无法执行备份保留清理。"
  # 兼容 macOS 自带 Bash 3.2（无 mapfile）：python3 只输出待删路径，
  # bash 逐行读取并调用 shutil.rmtree（路径经 argv 传递，兼容空格/特殊字符）。
  while IFS= read -r old; do
    [[ -n "${old}" ]] || continue
    log "清理过期备份：${old}"
    python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' "${old}"
  done < <(BACKUP_ROOT="${BACKUP_ROOT}" KEEP="${KEEP}" python3 - <<'PY'
import os, re
from pathlib import Path

root = Path(os.environ["BACKUP_ROOT"])
keep = int(os.environ["KEEP"])
archives = []
try:
    entries = list(root.iterdir())
except OSError:
    entries = []
for entry in entries:
    # 不跟随符号链接目录（防止越权删除），兼容旧版 python3：
    # is_dir() 跟随链接，is_symlink() 单独排除。
    if entry.is_symlink() or not entry.is_dir():
        continue
    if not re.fullmatch(r"\d{8}T\d{6}Z", entry.name):
        continue
    if not (entry / "manifest.json").is_file():
        continue
    archives.append(entry)
archives.sort(key=lambda p: p.name, reverse=True)
for stale in archives[keep:]:
    print(stale)
PY
)
fi
