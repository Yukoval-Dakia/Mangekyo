import { learningToolError, type ToolError, type ToolErrorCode } from './tool-error.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_CODE_CHARS = 20_000;
const MAX_PYTHON_INPUT_BYTES = 256 * 1024;
const MAX_FILENAME_CHARS = 64;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024;
const MAX_PYTHON_STDOUT_BYTES = 256 * 1024;
const MAX_PYTHON_STDERR_BYTES = 32 * 1024;
const MAX_PYTHON_RESULT_CHARS = 24_000;
const PYTHON_TIMEOUT_MS = 8_000;
const MAX_QUERY_CHARS = 500;
const MAX_SEARCH_RESPONSE_BYTES = 64 * 1024;
const MAX_SEARCH_RESULT_CHARS = 12_000;
const SEARCH_TIMEOUT_MS = 8_000;
const EXA_ENDPOINT = 'https://api.exa.ai/search';

const baseNames = ['python', 'read_file', 'write_file'] as const;
const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const pythonAttemptsLimit = 8;
export type PythonAttemptRow = {
  id: string;
  paper_id?: string;
  activity_kind?: 'controlled_posttest';
  submitted_at: string;
  effective_duration_ms?: number;
  formal_score?: {earned: number; maximum: number};
  results: {question_id: string; result: 'correct' | 'incorrect' | 'partial' | 'pending' | 'unanswered' | 'self-check'}[];
};
type PythonAttemptIssue = {index: number; code: 'not_found' | 'access_revoked' | 'basis_stale' | 'unknown'};
export type PythonAttemptsRead =
  | {ok: false; code: string; field: string; message: string; issues?: PythonAttemptIssue[]}
  | {ok: true; rows: PythonAttemptRow[]; issues: PythonAttemptIssue[]};

const pythonWrapper = String.raw`
import contextlib, io, json, os, sys, traceback, types

INPUT_LIMIT = 262144
FILE_LIMIT = 16384
TOTAL_LIMIT = 65536
MAX_FILES = 32
MARKER = "__MANGEKYO_RESULT__"

class Cap(io.TextIOBase):
    def __init__(self, limit):
        self.limit = limit
        self.size = 0
        self.parts = []
        self.cut = False

    def write(self, value):
        if not isinstance(value, str):
            value = str(value)
        if self.size >= self.limit:
            self.cut = True
            return 0
        take = value[: self.limit - self.size]
        self.parts.append(take)
        self.size += len(take)
        if len(take) < len(value):
            self.cut = True
        return len(value)

    def flush(self):
        return None

    def getvalue(self):
        text = "".join(self.parts)
        if self.cut:
            text += "\n[output truncated]"
        return text

def emit(payload):
    try:
        sys.__stdout__.write("\n" + MARKER + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.__stdout__.flush()
    except Exception:
        pass

raw = sys.stdin.buffer.read(INPUT_LIMIT + 1)
if len(raw) > INPUT_LIMIT:
    emit({"status": "fatal", "detail": "input too large"})
    raise SystemExit(0)

try:
    payload = json.loads(raw.decode("utf-8"))
    code = payload["code"]
    files = payload.get("files") or {}
    inputs = payload.get("inputs") or {}
    if not isinstance(code, str) or not isinstance(files, dict) or not isinstance(inputs, dict):
        raise ValueError("bad input")
except Exception:
    emit({"status": "fatal", "detail": "invalid input"})
    raise SystemExit(0)

if "attempts" in payload:
    attempt_snapshot = json.dumps(payload["attempts"])
    def attempts():
        """Return a fresh copy of the submitted results selected for this call."""
        return json.loads(attempt_snapshot)
    sdk = types.ModuleType("mangekyo")
    sdk.attempts = attempts
    sys.modules["mangekyo"] = sdk

work = "/tmp/workspace"
try:
    os.makedirs(work, exist_ok=True)
    for name, content in files.items():
        if not isinstance(name, str) or not isinstance(content, str):
            continue
        if os.path.basename(name) != name or name in ("", ".", ".."):
            continue
        with open(os.path.join(work, name), "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
    os.chdir(work)
except Exception:
    emit({"status": "fatal", "detail": "container workspace unavailable"})
    raise SystemExit(0)

out = Cap(16000)
err = Cap(16000)
status = "ok"
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        exec(compile(code, "<study>", "exec"), {"__name__": "__main__", "inputs": inputs})
except SystemExit as error:
    if error.code not in (None, 0):
        status = "error"
        traceback.print_exc(file=err)
except BaseException:
    status = "error"
    traceback.print_exc(file=err)

collected = {}
total = 0
try:
    for name in sorted(os.listdir(work)):
        if not isinstance(name, str) or os.path.basename(name) != name or name.startswith("."):
            continue
        path = os.path.join(work, name)
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        try:
            size = os.path.getsize(path)
            if size > FILE_LIMIT or total + size > TOTAL_LIMIT or len(collected) >= MAX_FILES:
                continue
            with open(path, "rb") as handle:
                data = handle.read(FILE_LIMIT + 1)
            text = data.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if len(data) > FILE_LIMIT:
            continue
        collected[name] = text
        total += len(data)
except OSError:
    pass

emit({"status": status, "stdout": out.getvalue(), "stderr": err.getvalue(), "files": collected})
`;

export type StudyTools = {
  names: readonly string[];
  snapshotFiles: () => Record<string, string>;
  restoreFiles: (files: Record<string, string>) => void;
  execute: (name: string, args: unknown, inputs?: Record<string, string>, attempts?: PythonAttemptRow[]) => Promise<string | ToolError>;
};

type PythonEnvelope = {
  status: 'ok' | 'error' | 'fatal';
  stdout: string;
  stderr: string;
  files: Record<string, string>;
};

type PythonOutcome =
  | { kind: 'closed'; code: number | null; stdout: Buffer; stderr: Buffer }
  | { kind: 'timeout' }
  | { kind: 'overflow' }
  | { kind: 'unavailable' };

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

function fail(code: ToolErrorCode, message: string, field?: string) {
  return learningToolError(code,field,message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function validFilename(value: unknown): value is string {
  return typeof value === 'string' && filenamePattern.test(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
}

export function pythonCodeError(code: unknown): ToolError | undefined {
  if (!validText(code) || !code.trim()) return fail('invalid_args','请输入 Python 代码。','code');
  if (code.length > MAX_CODE_CHARS) return fail('budget_or_limit',`代码超过 ${MAX_CODE_CHARS} 字符，请拆成几次计算。`,'code');
  return undefined;
}

function dockerFailure(stderr: string, code: number | null): string {
  if (/Cannot connect to the Docker daemon|permission denied while trying to connect/i.test(stderr)) {
    return 'python unavailable: docker daemon inaccessible';
  }
  if (/Unable to find image|pull access denied|No such image/i.test(stderr)) {
    return 'python unavailable: python:3.12-alpine is not present';
  }
  return code === null ? 'python unavailable' : `python unavailable (docker exit ${code})`;
}

function removeContainer(name: string): Promise<void> {
  return new Promise(resolve => {
    const child = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3_000);
    timer.unref();
    child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runPythonContainer(name: string, input: string): Promise<PythonOutcome> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('docker', [
        'run', '--interactive', '--rm', '--pull=never', '--name', name,
        '--network=none', '--read-only', '--cap-drop=ALL',
        '--security-opt', 'no-new-privileges', '--user=65534',
        '--memory=128m', '--memory-swap=128m', '--cpus=0.5',
        '--pids-limit=64', '--ulimit', 'nofile=64:64',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m',
        '--workdir', '/tmp',
        'python:3.12-alpine', 'python', '-I', '-B', '-c', pythonWrapper,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ kind: 'unavailable' });
      return;
    }

    let settled = false;
    let timedOut = false;
    let overflow = false;
    let cleanup: Promise<void> | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const finish = (outcome: PythonOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const clean = () => cleanup ??= removeContainer(name);
    const stop = (outcome: PythonOutcome) => {
      if (settled) return;
      child.kill('SIGKILL');
      void clean().then(() => finish(outcome));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop({ kind: 'timeout' });
    }, PYTHON_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (timedOut || overflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PYTHON_STDOUT_BYTES) {
        overflow = true;
        stop({ kind: 'overflow' });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (timedOut || overflow) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PYTHON_STDERR_BYTES) {
        overflow = true;
        stop({ kind: 'overflow' });
        return;
      }
      stderr.push(chunk);
    });
    child.once('error', () => {
      if (!timedOut && !overflow) finish({ kind: 'unavailable' });
    });
    child.once('close', (code: number | null) => {
      if (timedOut) {
        void clean().then(() => finish({ kind: 'timeout' }));
      } else if (overflow) {
        void clean().then(() => finish({ kind: 'overflow' }));
      } else {
        finish({
          kind: 'closed',
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function readEnvelope(text: string): PythonEnvelope | undefined {
  const marker = '__MANGEKYO_RESULT__';
  const index = text.lastIndexOf(marker);
  if (index < 0) return;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(index + marker.length).trim());
  } catch {
    return;
  }
  const envelope = record(value);
  if (!envelope) return;
  const status = envelope.status;
  if (status !== 'ok' && status !== 'error' && status !== 'fatal') return;
  const stdout = typeof envelope.stdout === 'string' ? clip(envelope.stdout, 16_000) : '';
  const stderr = typeof envelope.stderr === 'string' ? clip(envelope.stderr, 16_000) : '';
  const files: Record<string, string> = {};
  if (status !== 'fatal' && record(envelope.files)) {
    for (const [name, content] of Object.entries(envelope.files as Record<string, unknown>)) {
      if (validFilename(name) && validText(content) && Buffer.byteLength(content) <= MAX_FILE_BYTES) {
        files[name] = content;
      }
    }
  }
  return {
    status,
    stdout,
    stderr,
    files,
  };
}

async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) {
    const text = await response.text();
    return text.length <= limit ? text : undefined;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function renderSearch(value: unknown): string {
  const data = record(value);
  if (!data || !Array.isArray(data.results)) return 'no results';
  const lines: string[] = [];
  for (const item of data.results.slice(0, 3)) {
    const result = record(item);
    if (!result) continue;
    const title = typeof result.title === 'string' ? clip(result.title.trim(), 300) : '';
    const url = typeof result.url === 'string' ? clip(result.url.trim(), 1_000) : '';
    if (!url) continue;
    const highlights = Array.isArray(result.highlights)
      ? result.highlights.filter(validText).slice(0, 3).map(text => clip(text.trim(), 1_500))
      : [];
    lines.push([
      `${lines.length + 1}. ${title || '(untitled)'}`,
      url,
      highlights.join(' … '),
    ].filter(Boolean).join('\n'));
  }
  return lines.length ? clip(lines.join('\n\n'), MAX_SEARCH_RESULT_CHARS) : 'no results';
}

export function createStudyTools(options: { exaApiKey?: string; allowSearch?: boolean } = {}): StudyTools {
  const workspace = new Map<string, string>();
  const candidateKey = typeof options?.exaApiKey === 'string' ? options.exaApiKey.trim() : '';
  const exaApiKey = candidateKey.length > 0 && candidateKey.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(candidateKey) && candidateKey.isWellFormed()
    ? candidateKey
    : undefined;
  const searchEnabled = options?.allowSearch === true;
  const names = Object.freeze(searchEnabled ? [...baseNames, 'exa_search'] : [...baseNames]);

  async function readFile(args: unknown): Promise<string | ToolError> {
    const value = record(args);
    if (!value || !validFilename(value.name)) return fail('invalid_args','请输入不含目录的文件名。','name');
    const content = workspace.get(value.name);
    return content === undefined ? fail('not_found',`未找到文件 ${value.name}。`,'name') : content;
  }

  async function writeFile(args: unknown): Promise<string | ToolError> {
    const value = record(args);
    if (!value || !validFilename(value.name)) return fail('invalid_args','请输入不含目录的文件名。','name');
    if (!validText(value.content)) return fail('invalid_args','文件内容须为文本。','content');
    const bytes = Buffer.byteLength(value.content);
    if (bytes > MAX_FILE_BYTES) return fail('budget_or_limit',`单个文件限 ${MAX_FILE_BYTES} 字节，请缩短文本。`,'content');
    const previous = workspace.get(value.name);
    const total = [...workspace.entries()].reduce(
      (sum, [name, text]) => sum + (name === value.name ? 0 : Buffer.byteLength(text)),
      0,
    );
    if (total + bytes > MAX_WORKSPACE_BYTES) return fail('budget_or_limit',`文件总量限 ${MAX_WORKSPACE_BYTES} 字节，请缩短现有文件。`,'content');
    if (!workspace.has(value.name) && workspace.size >= MAX_FILES) return fail('budget_or_limit',`文件数量限 ${MAX_FILES}，请复用现有文件。`,'name');
    workspace.set(value.name, value.content);
    return `wrote ${value.name} (${bytes} bytes${previous === undefined ? '' : ', replaced'})`;
  }

  async function runPython(args: unknown, inputs?: Record<string, string>, attempts?: PythonAttemptRow[]): Promise<string | ToolError> {
    const code = record(args)?.code;
    const error = pythonCodeError(code);
    if (error) return error;
    const name = `mangekyo-study-${randomUUID()}`;
    const payload = JSON.stringify({ code, files: Object.fromEntries(workspace), inputs, attempts });
    if (Buffer.byteLength(payload) > MAX_PYTHON_INPUT_BYTES) return fail('budget_or_limit','Python 输入超过限制，请减少作答或结果句柄。','inputs');
    const outcome = await runPythonContainer(name, payload);
    if (outcome.kind === 'timeout') return fail('budget_or_limit',`Python 超过 ${PYTHON_TIMEOUT_MS} 毫秒，请缩小计算范围。`,'code');
    if (outcome.kind === 'overflow') return fail('budget_or_limit','Python 输出超过限制，请只输出结果摘要。','code');
    if (outcome.kind === 'unavailable') return fail('tool_unavailable','当前无法启动 Python 沙箱。');

    const stdout = outcome.stdout.toString('utf8');
    const stderr = outcome.stderr.toString('utf8');
    const envelope = readEnvelope(stdout);
    if (!envelope) return fail('tool_unavailable',dockerFailure(stderr, outcome.code));
    if (envelope.status === 'fatal') {
      return fail('execution_failed','Python 沙箱未能准备输入。请缩小输入或改用其他工具。','inputs');
    }

    const collected: Record<string, string> = {};
    let total = 0;
    for (const [file, content] of Object.entries(envelope.files)) {
      const bytes = Buffer.byteLength(content);
      if (Object.keys(collected).length >= MAX_FILES || total + bytes > MAX_WORKSPACE_BYTES) continue;
      collected[file] = content;
      total += bytes;
    }
    if (envelope.status === 'ok') {
      workspace.clear();
      for (const [file, content] of Object.entries(collected)) workspace.set(file, content);
    }

    const parts: string[] = [];
    if (envelope.status === 'error') {
      const detail = envelope.stderr.trim().split('\n').at(-1);
      return fail('execution_failed',detail || 'Python 程序退出。请检查代码。','code');
    }
    if (envelope.stdout.trim()) parts.push(envelope.stdout.trimEnd());
    if (envelope.stderr.trim()) parts.push(envelope.stderr.trimEnd());
    if (!parts.length) parts.push('(no output)');
    const changed = Object.keys(collected).sort();
    if (changed.length) parts.push(`files: ${changed.join(', ')}`);
    return clip(parts.join('\n'), MAX_PYTHON_RESULT_CHARS);
  }

  async function search(args: unknown): Promise<string | ToolError> {
    if (!searchEnabled) return fail('tool_unavailable','在线检索当前不可用。');
    const value = record(args);
    if (!value || !validText(value.query) || !value.query.trim()) return fail('invalid_args','请输入检索主题。','query');
    const query = value.query.trim();
    if (query.length > MAX_QUERY_CHARS) return fail('invalid_args',`检索主题最多 ${MAX_QUERY_CHARS} 字符。`,'query');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      if (!exaApiKey) {
        const response = await fetch('https://mcp.exa.ai/mcp?tools=web_search_exa', {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: {name: 'web_search_exa', arguments: {query, numResults: 2}} }),
        });
        if (!response.ok) { await response.body?.cancel(); return fail(response.status === 429 ? 'budget_or_limit' : 'execution_failed','检索服务返回 HTTP ' + response.status + '。'); }
        const raw = await readBounded(response, MAX_SEARCH_RESPONSE_BYTES);
        if (!raw) return fail('budget_or_limit','结果超过限制，请缩小检索范围。','query');
        const packets = response.headers.get('content-type')?.includes('text/event-stream')
          ? raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()) : [raw];
        const result = packets.map(packet => JSON.parse(packet)).find(packet => packet.id === 1)?.result;
        if (!result || result.isError || !Array.isArray(result.content)) return fail('execution_failed','检索服务未能完成查询。');
        return clip(result.content.filter((part: {type?: string; text?: unknown}) => part.type === 'text' && validText(part.text))
          .map((part: {text: string}) => part.text).join('\n'), MAX_SEARCH_RESULT_CHARS) || 'no results';
      }
      const response = await fetch(EXA_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-api-key': exaApiKey },
        body: JSON.stringify({
          query,
          type: 'auto',
          numResults: 3,
          contents: { highlights: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) return fail(response.status === 429 ? 'budget_or_limit' : 'execution_failed',`检索服务返回 HTTP ${response.status}。`);
      const body = await readBounded(response, MAX_SEARCH_RESPONSE_BYTES);
      if (body === undefined) return fail('budget_or_limit','结果超过限制，请缩小检索范围。','query');
      try {
        return renderSearch(JSON.parse(body));
      } catch {
        return fail('execution_failed','检索服务返回了无法读取的结果。');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return fail('budget_or_limit','检索超时，请缩小检索范围。','query');
      }
      return fail('execution_failed','检索服务未能完成查询。');
    } finally {
      clearTimeout(timer);
    }
  }

  async function execute(name: string, args: unknown, inputs?: Record<string, string>, attempts?: PythonAttemptRow[]): Promise<string | ToolError> {
    try {
      switch (name) {
        case 'python': return await runPython(args, inputs, attempts);
        case 'read_file': return await readFile(args);
        case 'write_file': return await writeFile(args);
        case 'exa_search': return await search(args);
        default: return fail('tool_unavailable','请使用本轮已开放的工具。','name');
      }
    } catch {
      return fail('execution_failed','工具未能完成。可调整输入或换用其他工具。');
    }
  }

  return {
    names, execute,
    snapshotFiles: () => Object.fromEntries(workspace),
    restoreFiles(files) {
      const entries = Object.entries(files);
      if (entries.length > MAX_FILES || entries.some(([name, text]) => !validFilename(name) || !validText(text) || Buffer.byteLength(text) > MAX_FILE_BYTES)
          || entries.reduce((bytes, [, text]) => bytes + Buffer.byteLength(text), 0) > MAX_WORKSPACE_BYTES) throw new Error('Invalid saved workspace');
      workspace.clear();
      for (const [name, text] of entries) workspace.set(name, text);
    },
  };
}
