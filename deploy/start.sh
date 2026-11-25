#!/usr/bin/env bash
# Mangekyō 私有单机一键启动/预检脚本
#
# 幂等：可重复执行。先检查前置依赖，再启动 compose 服务，
# 等待健康检查通过后自动执行数据库迁移（由 Studio 启动时 applyKernelSchema 完成），
# 最后探测 HTTP 就绪并打印访问地址。
#
# 用法：
#   cd deploy
#   cp .env.example .env   # 首次：填写真实值
#   ./start.sh             # 启动全部服务
#   ./start.sh --check     # 仅预检，不启动
#   ./start.sh --down      # 停止全部服务（保留数据卷）
#   ./start.sh --logs      # 跟随日志
#
# 详见 docs/deploy/self-hosted.md

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
PROJECT_NAME="mangekyo"
STUDIO_PORT="${STUDIO_PORT:-4317}"
HEALTH_TIMEOUT=180

log() { printf '[mangekyo] %s\n' "$*"; }
err() { printf '[mangekyo] ERROR: %s\n' "$*" >&2; }

die() { err "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少前置命令：$1。请先安装。"
}

# 只读解析 .env（Compose .env 语法），NUL 分隔输出 5 个变量；绝不 source/eval，防 Shell 注入。
# 注意：Bash 3.2 对 <(...) 内的引号 heredoc 不生效，故脚本放在独立函数里、由进程替换调用。
parse_env_file() {
  ENV_FILE="${ENV_FILE}" python3 - <<'PY'
import os, sys
wanted = ("POSTGRES_PASSWORD", "STUDIO_PORT", "POSTGRES_PORT", "TEMPORAL_PORT", "TEMPORAL_UI_PORT")
found = {key: "" for key in wanted}
try:
    lines = open(os.environ["ENV_FILE"], encoding="utf-8", errors="replace").read().splitlines()
except OSError:
    lines = []
for raw in lines:
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[7:].lstrip()
    key, sep, val = line.partition("=")
    key = key.strip()
    if not sep or key not in found:
        continue
    raw_val = val
    val = val.lstrip()
    if val.startswith("'"):
        end = val.find("'", 1)
        found[key] = val[1:end] if end > 0 else val[1:]
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
sys.stdout.write("\x00".join(found[key] for key in wanted) + "\x00")
PY
}

check_env() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    die "未找到 ${ENV_FILE}。请先执行：cp .env.example .env 并填写真实值。"
  fi
  require_cmd python3
  local postgres_password="" studio_port_value="" postgres_port_value="" temporal_port_value="" temporal_ui_port_value=""
  {
    IFS= read -r -d '' postgres_password || true
    IFS= read -r -d '' studio_port_value || true
    IFS= read -r -d '' postgres_port_value || true
    IFS= read -r -d '' temporal_port_value || true
    IFS= read -r -d '' temporal_ui_port_value || true
  } < <(parse_env_file)
  [[ -n "${postgres_password}" ]] || die ".env 中 POSTGRES_PASSWORD 为空。"
  [[ "${postgres_password}" != "CHANGE_ME"* ]] || die "POSTGRES_PASSWORD 仍是占位符，请设置强密码。"
  # 端口变量：.env 未设置时保留已有环境变量或默认值。
  STUDIO_PORT="${studio_port_value:-${STUDIO_PORT:-4317}}"
  POSTGRES_PORT="${postgres_port_value:-${POSTGRES_PORT:-55432}}"
  TEMPORAL_PORT="${temporal_port_value:-${TEMPORAL_PORT:-7423}}"
  TEMPORAL_UI_PORT="${temporal_ui_port_value:-${TEMPORAL_UI_PORT:-8423}}"
}

check_docker() {
  require_cmd docker
  docker info >/dev/null 2>&1 || die "Docker daemon 不可用。请先启动 Docker。"
  docker compose version >/dev/null 2>&1 || die "docker compose 插件不可用。"
}

check_ports() {
  local port_var port_num
  for pair in "POSTGRES_PORT:55432" "TEMPORAL_PORT:7423" "TEMPORAL_UI_PORT:8423" "STUDIO_PORT:4317"; do
    port_var="${pair%%:*}"
    port_num="${!port_var:-${pair##*:}}"
    if command -v lsof >/dev/null 2>&1; then
      if lsof -nP -iTCP:"${port_num}" -sTCP:LISTEN >/dev/null 2>&1; then
        log "端口 ${port_num}（${port_var}）已被占用，可能已有实例在运行；继续检查健康状态。"
      fi
    fi
  done
}

compose() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" -p "${PROJECT_NAME}" "$@"
}

# 解析 compose ps --format json 输出。兼容单个 JSON 对象、JSON 数组
# （[{"Health":"healthy"}]）与多行 NDJSON（每行一个对象，Compose 版本差异）。
ps_health() {
  compose ps --format json "$1" 2>/dev/null | python3 -c '
import sys, json
raw = sys.stdin.read().strip()
health = ""
try:
    data = json.loads(raw)
    items = data if isinstance(data, list) else [data]
    for item in items:
        if isinstance(item, dict) and item.get("Health"):
            health = str(item["Health"])
            break
except Exception:
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except Exception:
            continue
        if isinstance(item, dict) and item.get("Health"):
            health = str(item["Health"])
            break
print(health)
' 2>/dev/null || true
}

wait_healthy() {
  local service="$1" timeout="${2:-${HEALTH_TIMEOUT}}"
  local elapsed=0 interval=3
  log "等待 ${service} 健康（最长 ${timeout}s）…"
  while (( elapsed < timeout )); do
    local status
    status="$(ps_health "${service}")"
    if [[ "${status}" == "healthy" ]]; then
      log "${service} 已健康。"
      return 0
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  err "${service} 在 ${timeout}s 内未变为 healthy。查看日志：docker compose -p ${PROJECT_NAME} logs ${service}"
  return 1
}

wait_studio_http() {
  local url="http://127.0.0.1:${STUDIO_PORT}/"
  local elapsed=0 interval=3
  log "等待 Studio HTTP 就绪 ${url}（最长 ${HEALTH_TIMEOUT}s）…"
  while (( elapsed < HEALTH_TIMEOUT )); do
    if curl -fsS -o /dev/null --max-time 3 "${url}" 2>/dev/null; then
      log "Studio 已就绪：${url}"
      return 0
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  err "Studio 在 ${HEALTH_TIMEOUT}s 内未响应。查看日志：docker compose -p ${PROJECT_NAME} logs studio"
  return 1
}

precheck() {
  log "预检：依赖与配置"
  check_docker
  check_env
  check_ports
  log "预检通过。"
}

start_all() {
  precheck
  log "构建并启动 compose 服务…"
  compose up -d --build
  wait_healthy postgres 120
  wait_healthy temporal 300
  wait_healthy studio 300
  wait_studio_http
  log "全部服务已启动。"
  log "  Studio:  http://127.0.0.1:${STUDIO_PORT}/"
  log "  Temporal UI: http://127.0.0.1:${TEMPORAL_UI_PORT:-8423}/"
  log "数据库迁移由 Studio 启动时自动执行（applyKernelSchema）；如需手动核对："
  log "  docker compose -p ${PROJECT_NAME} exec postgres psql -U \"\${POSTGRES_USER:-mangekyo}\" -d \"\${POSTGRES_DB:-mangekyo}\" -c 'SELECT max(version) FROM mangekyo_studio.kernel_schema_migrations'"
}

case "${1:-start}" in
  --check|-c|check)
    precheck
    ;;
  --down|-d|down)
    check_env
    compose down
    log "已停止（数据卷保留）。"
    ;;
  --logs|-l|logs)
    check_env
    compose logs -f --tail=200
    ;;
  --restart)
    check_env
    compose restart
    ;;
  start|"")
    start_all
    ;;
  *)
    die "未知参数：$1。用法：./start.sh [--check|--down|--logs|--restart]"
    ;;
esac
