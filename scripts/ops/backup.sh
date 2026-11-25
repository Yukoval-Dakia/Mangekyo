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
#     (--env-file deploy/.env | --database-url postgresql://user:pass@host:port/db) \
#     --backup-root /backups
#
# 选项：
#   --schema NAME        PostgreSQL schema（默认 mangekyo_studio）
#   --env-file PATH      读取 Compose .env 文件（只读解析，支持 POSTGRES_*/PG*/MANGEKYO_DATABASE_URL；与 --database-url 互斥）
#   --database-url URL   PostgreSQL 连接串（与 --env-file 互斥；manifest 中密码自动脱敏）
#   --blob-dir PATH      原件/Blob 根目录（可选；与 --blob-volume 互斥；不存在则跳过）
#   --blob-volume NAME   原件/Blob Docker 命名卷（可选；与 --blob-dir 互斥；卷内 /intake 不存在则跳过）
#   --backup-root PATH   备份根目录（默认 ./backups）
#   --keep N             保留最近 N 份归档，超出删除最旧（默认 30，0=不清理）
#   --pg-dump PATH       pg_dump 可执行文件（默认自动探测）
#   --pg-container NAME  PostgreSQL Docker 容器名（默认自动探测）
#
# 环境变量：
#   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
#                        未传 --env-file 与 --database-url 时自动回退读取（亦兼容 POSTGRES_USER/PASSWORD/DB/PORT）
#   PG_CONTAINER         与 --pg-container 等价（命令行参数优先）
#   BLOB_HELPER_IMAGE    卷备份辅助镜像（默认 postgres:18.7-alpine3.24）
#
# 说明：备份包含用户原件与学习记录，受 D06 删除边界约束。
#       已离线备份的副本在擦除后标为 unverified，需用户自行清理旧离线归档。
#       备份默认保留 30 天（--keep 30），与 docs/product-spec.md D06 一致。

set -euo pipefail

SCHEMA="mangekyo_studio"
DATABASE_URL=""
DATABASE_URL_SET=0
ENV_FILE=""
ENV_FILE_SET=0
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
# 主路径：urlsplit 后确认 path/query/fragment 均不含 @，在 netloc 内按最后一个 @ 定位凭据段
#       （兼容未编码 @、:、IPv6）。
# 兜底：密码含未编码 /、?、#、[ 等字符导致 urlsplit 提前截断或报 ValueError 时，
#       对 scheme:// 后的整段按最后一个 @ 定位凭据段再脱敏（绝不先截断 ?/# 导致漏脱敏）。
# 无密码/无凭据段原样返回；非 URI 含 password= 或解析异常一律返回 <redacted>，绝不泄露明文密码。
redact_db_url() {
  command -v python3 >/dev/null 2>&1 \
    || { printf '%s' '<redacted>'; return 0; }
  RAW_DB_URL="$1" python3 -c '
import os, sys
from urllib.parse import urlsplit, urlunsplit

raw = os.environ["RAW_DB_URL"]

def mask_head(head):
    # head 中最后一个 @ 之前为凭据段、之后为主机及路径等其余内容；
    # 凭据段按第一个 : 分离用户名与密码（密码可含未编码 @/:/?/#//）。
    # 无 @ 或凭据段无 :（无密码）返回 None，由调用方原样返回。
    if "@" not in head:
        return None
    cred, _, rest = head.rpartition("@")
    if ":" not in cred:
        return None
    return cred.split(":", 1)[0] + ":***@" + rest

try:
    u = None
    try:
        u = urlsplit(raw)
    except ValueError:
        u = None
    has_at_after_netloc = bool(u is not None and ("@" in u.path or "@" in u.query or "@" in u.fragment))
    if u is not None and u.scheme and "@" in u.netloc and not has_at_after_netloc:
        masked = mask_head(u.netloc)
        if masked is None:
            sys.stdout.write(raw)
        else:
            sys.stdout.write(urlunsplit((u.scheme, masked, u.path, u.query, u.fragment)))
    elif "://" in raw:
        # 密码含未编码 /、?、#、[ 等导致 urlsplit 提前截断 netloc/报错，或后续片段仍含 @：
        # 直接对 scheme:// 后整段按最后一个 @ 取凭据段并脱敏，避免漏脱敏明文密码。
        scheme, _, rest = raw.partition("://")
        masked = mask_head(rest)
        if scheme and masked is not None:
            sys.stdout.write(scheme + "://" + masked)
        elif masked is None and u is not None and u.scheme:
            sys.stdout.write(raw)
        else:
            sys.stdout.write("<redacted>")
    elif "password=" in raw.lower():
        sys.stdout.write("<redacted>")
    else:
        sys.stdout.write(raw)
except Exception:
    sys.stdout.write("<redacted>")
'
}

# 只读解析 .env（Compose .env 语法），NUL 分隔输出 DB 相关变量及设置标记；绝不 source/eval，防 Shell 注入。
# 注意：Bash 3.2 对 <(...) 内的引号 heredoc 不生效，故脚本放在独立函数里、由进程替换调用。
parse_env_file() {
  ENV_FILE="${ENV_FILE}" python3 - <<'PY'
import os, sys

wanted = (
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "POSTGRES_PORT",
    "MANGEKYO_DATABASE_URL",
)
pg_keys = {
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "POSTGRES_PORT",
}
found = {key: "" for key in wanted}
seen = set()

try:
    with open(os.environ["ENV_FILE"], encoding="utf-8-sig", errors="replace") as fh:
        lines = fh.read().splitlines()
except OSError as exc:
    sys.stderr.write(f"无法读取 env 文件：{exc}\n")
    sys.exit(1)

for raw in lines:
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export ") or line.startswith("export\t"):
        line = line[7:].lstrip()
    key, sep, val = line.partition("=")
    key = key.strip()
    if not sep or key not in found:
        continue
    seen.add(key)
    raw_val = val
    val = val.lstrip()
    if val.startswith("'"):
        end = val.find("'", 1)
        found[key] = val[1:end] if end >= 1 else val[1:]
    elif val.startswith('"'):
        out = []
        i = 1
        while i < len(val):
            ch = val[i]
            if ch == '"':
                break
            if ch == "\\" and i + 1 < len(val):
                n = val[i + 1]
                out.append({'"': '"', "\\": "\\", "n": "\n", "r": "\r", "t": "\t", "$": "$"}.get(n, "\\" + n))
                i += 2
            else:
                out.append(ch)
                i += 1
        found[key] = "".join(out)
    else:
        cut = len(raw_val)
        for i in range(len(raw_val) - 1):
            if raw_val[i] in " \t" and raw_val[i + 1] == "#":
                cut = i
                break
        found[key] = raw_val[:cut].strip()

pg_pass_set = "1" if "PGPASSWORD" in seen else "0"
pg_any_set = "1" if any(k in seen for k in pg_keys) else "0"
fields = [found[key] for key in wanted] + [pg_pass_set, pg_any_set]
sys.stdout.buffer.write(b"\x00".join(v.encode("utf-8") for v in fields) + b"\x00")
PY
}

# 从 DATABASE_URL 提取 6 个字段：DB_HOST、DB_PORT、DB_USER、DB_PASS、DB_NAME、DB_SSLMODE。
# 用 python3 urllib.parse 做严格解码：兼容 URL 编码（%40/%3A/%25 等）、原始 @/:/#/?//、IPv6、无密码与 sslmode。
# DATABASE_URL 经环境变量传给 python3，绝不作为 CLI 参数暴露在 ps 进程列表中；
# 解析结果以 NUL 分隔并直接管道给 read -d ''，密码不落 argv、不做任何 shell 展开。
extract_db_creds() {
  command -v python3 >/dev/null 2>&1 \
    || die "缺少 python3，无法解析 DATABASE_URL。"
  DB_HOST="" DB_PORT="" DB_USER="" DB_PASS="" DB_NAME="" DB_SSLMODE=""
  local idx=0 field
  while IFS= read -r -d '' field; do
    case "${idx}" in
      0) DB_HOST="${field}" ;;
      1) DB_PORT="${field}" ;;
      2) DB_USER="${field}" ;;
      3) DB_PASS="${field}" ;;
      4) DB_NAME="${field}" ;;
      5) DB_SSLMODE="${field}" ;;
    esac
    idx=$((idx + 1))
  done < <(DATABASE_URL="${DATABASE_URL}" python3 -c '
import os, sys
from urllib.parse import parse_qs, unquote, urlsplit

raw = os.environ["DATABASE_URL"]

try:
    u = None
    try:
        u = urlsplit(raw)
    except ValueError:
        u = None

    has_at_after_netloc = bool(u is not None and ("@" in u.path or "@" in u.query or "@" in u.fragment))
    if u is not None and u.scheme and "@" in u.netloc and not has_at_after_netloc:
        user = unquote(u.username) if u.username is not None else ""
        password = unquote(u.password) if u.password is not None else ""
        host = u.hostname or ""
        port = str(u.port) if u.port is not None else ""
        dbname = unquote(u.path.lstrip("/")) if u.path else ""
        sslmode = parse_qs(u.query).get("sslmode", [""])[0]
    elif "://" in raw:
        scheme, _, rest = raw.partition("://")
        if not scheme or "@" not in rest:
            sys.exit("DATABASE_URL 缺少用户名或库名。")
        cred, _, tail = rest.rpartition("@")
        if ":" in cred:
            raw_user, raw_pass = cred.split(":", 1)
        else:
            raw_user, raw_pass = cred, ""
        user = unquote(raw_user)
        password = unquote(raw_pass)
        t = urlsplit("postgresql://" + tail)
        host = t.hostname or ""
        port = str(t.port) if t.port is not None else ""
        dbname = unquote(t.path.lstrip("/")) if t.path else ""
        sslmode = parse_qs(t.query).get("sslmode", [""])[0]
    else:
        sys.exit("无法解析 DATABASE_URL。")
except SystemExit:
    raise
except Exception:
    sys.exit("无法解析 DATABASE_URL。")

if not user or not dbname:
    sys.exit("DATABASE_URL 缺少用户名或库名。")

fields = (host, port, user, password, dbname, sslmode)
sys.stdout.buffer.write(b"\0".join(v.encode("utf-8") for v in fields) + b"\0")
')
  # python 失败时无 NUL 输出，idx<6 由下方检查兜底；stderr 已是无敏感信息的固定文案。
  [[ "${idx}" -ge 6 && -n "${DB_USER}" && -n "${DB_NAME}" ]] \
    || die "DATABASE_URL 缺少用户名或库名（或格式无法解析）。"
}

# 统一解析数据库连接来源：--database-url / --env-file（互斥）或回退进程 PG*/POSTGRES_* 环境变量。
resolve_db_connection() {
  DB_HOST="" DB_PORT="" DB_USER="" DB_PASS="" DB_NAME="" DB_SSLMODE="" REDACTED_DB_URL=""
  if [[ "${DATABASE_URL_SET}" -eq 1 && "${ENV_FILE_SET}" -eq 1 ]]; then
    die "--database-url 与 --env-file 互斥，请只传其一。"
  fi

  local from_url=0
  if [[ "${DATABASE_URL_SET}" -eq 1 ]]; then
    [[ -n "${DATABASE_URL}" ]] || die "--database-url 不能为空。"
    extract_db_creds
    from_url=1
  elif [[ "${ENV_FILE_SET}" -eq 1 ]]; then
    [[ -n "${ENV_FILE}" ]] || die "--env-file 不能为空。"
    [[ -f "${ENV_FILE}" ]] || die "env 文件不存在：${ENV_FILE}"
    command -v python3 >/dev/null 2>&1 \
      || die "缺少 python3，无法解析 env 文件。"
    local pg_host="" pg_port="" pg_user="" pg_pass="" pg_db=""
    local postgres_user="" postgres_pass="" postgres_db="" postgres_port=""
    local mangekyo_database_url="" pg_pass_set="0" pg_any_set="0"
    local idx=0 field
    while IFS= read -r -d '' field; do
      case "${idx}" in
        0) pg_host="${field}" ;;
        1) pg_port="${field}" ;;
        2) pg_user="${field}" ;;
        3) pg_pass="${field}" ;;
        4) pg_db="${field}" ;;
        5) postgres_user="${field}" ;;
        6) postgres_pass="${field}" ;;
        7) postgres_db="${field}" ;;
        8) postgres_port="${field}" ;;
        9) mangekyo_database_url="${field}" ;;
        10) pg_pass_set="${field}" ;;
        11) pg_any_set="${field}" ;;
      esac
      idx=$((idx + 1))
    done < <(parse_env_file)
    [[ "${idx}" -ge 12 ]] || die "解析 env 文件失败：${ENV_FILE}"

    if [[ "${pg_any_set}" != "1" && -n "${mangekyo_database_url}" ]]; then
      DATABASE_URL="${mangekyo_database_url}"
      extract_db_creds
      from_url=1
    elif [[ "${pg_any_set}" != "1" ]]; then
      die "env 文件 ${ENV_FILE} 未配置数据库连接参数（需设置 PG*/POSTGRES_* 或 MANGEKYO_DATABASE_URL）。"
    else
      DB_HOST="${pg_host:-127.0.0.1}"
      DB_PORT="${pg_port:-${postgres_port:-5432}}"
      DB_USER="${pg_user:-${postgres_user:-mangekyo}}"
      if [[ "${pg_pass_set}" == "1" ]]; then
        DB_PASS="${pg_pass}"
      else
        DB_PASS="${postgres_pass}"
      fi
      DB_NAME="${pg_db:-${postgres_db:-mangekyo}}"
      DB_SSLMODE=""
    fi
  else
    DB_HOST="${PGHOST:-127.0.0.1}"
    DB_PORT="${PGPORT:-${POSTGRES_PORT:-5432}}"
    DB_USER="${PGUSER:-${POSTGRES_USER:-}}"
    if [[ -n "${PGPASSWORD+x}" ]]; then
      DB_PASS="${PGPASSWORD}"
    else
      DB_PASS="${POSTGRES_PASSWORD:-}"
    fi
    DB_NAME="${PGDATABASE:-${POSTGRES_DB:-}}"
    DB_SSLMODE="${PGSSLMODE:-}"
  fi

  [[ -n "${DB_USER}" && -n "${DB_NAME}" ]] \
    || die "缺少数据库连接参数：请提供 --database-url、--env-file，或设置 PGHOST/PGUSER/PGPASSWORD/PGDATABASE 环境变量。"

  if [[ "${from_url}" -eq 1 ]]; then
    REDACTED_DB_URL="$(redact_db_url "${DATABASE_URL}")"
  else
    local display_host="${DB_HOST:-127.0.0.1}"
    local display_port="${DB_PORT:-5432}"
    if [[ "${display_host}" == *:* && "${display_host}" != \[*\] ]]; then
      display_host="[${display_host}]"
    fi
    if [[ -n "${DB_PASS}" ]]; then
      REDACTED_DB_URL="postgresql://${DB_USER}:***@${display_host}:${display_port}/${DB_NAME}"
    else
      REDACTED_DB_URL="postgresql://${DB_USER}@${display_host}:${display_port}/${DB_NAME}"
    fi
  fi
}

# 本机执行 pg_dump / pg_restore / psql：凭据通过子 shell 环境变量传递，绝不进入 CLI argv / ps。
run_local_pg() {
  (
    unset PGHOST PGPORT PGSSLMODE
    export PGUSER="${DB_USER}" PGPASSWORD="${DB_PASS}" PGDATABASE="${DB_NAME}"
    if [[ -n "${DB_HOST}" ]]; then export PGHOST="${DB_HOST}"; fi
    if [[ -n "${DB_PORT}" ]]; then export PGPORT="${DB_PORT}"; fi
    if [[ -n "${DB_SSLMODE:-}" ]]; then export PGSSLMODE="${DB_SSLMODE}"; fi
    "$@"
  )
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
    --schema) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; SCHEMA="$2"; shift 2 ;;
    --database-url) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; DATABASE_URL="$2"; DATABASE_URL_SET=1; shift 2 ;;
    --env-file) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; ENV_FILE="$2"; ENV_FILE_SET=1; shift 2 ;;
    --blob-dir) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; BLOB_DIR="$2"; BLOB_DIR_SET=1; shift 2 ;;
    --blob-volume) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; BLOB_VOLUME="$2"; BLOB_VOLUME_SET=1; shift 2 ;;
    --backup-root) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; BACKUP_ROOT="$2"; shift 2 ;;
    --keep) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; KEEP="$2"; shift 2 ;;
    --pg-dump) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; PG_DUMP="$2"; shift 2 ;;
    --pg-container) [[ $# -ge 2 ]] || die "选项 $1 缺少参数值"; PG_CONTAINER="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,35p' "$0"
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

resolve_db_connection
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
  PGPASSWORD="${DB_PASS}" docker exec -e PGPASSWORD "${PG_CONTAINER}" \
    pg_dump --format=custom --schema="${SCHEMA}" --no-owner --no-privileges \
    -U "${DB_USER}" -d "${DB_NAME}" > "${DUMP_FILE}"
else
  run_local_pg "${PG_DUMP}" --format=custom --schema="${SCHEMA}" --no-owner --no-privileges \
    -d "${DB_NAME}" > "${DUMP_FILE}"
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
  SCHEMA_VERSION="$(run_local_pg psql -tAc "SELECT max(version) FROM ${SCHEMA}.kernel_schema_migrations" 2>/dev/null || true)"
else
  # 本机无 psql：尝试探测容器（pg_dump 探测阶段可能已填充）。
  if [[ -z "${PG_CONTAINER}" ]]; then
    PG_CONTAINER="$(detect_pg_container || true)"
  fi
  if [[ -n "${PG_CONTAINER}" ]]; then
    SCHEMA_VERSION="$(PGPASSWORD="${DB_PASS}" docker exec -e PGPASSWORD "${PG_CONTAINER}" \
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
REDACTED_DB_URL="${REDACTED_DB_URL}" \
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
