import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  invokeBackgroundCompletion,
  type BackgroundLlmProvider,
  type BackgroundLlmTransport,
} from './background-llm.ts';
import { extractJsonObject } from './onboarding-agent.ts';
import { TeachingError } from './provider.ts';

export type AuthoredQuestionVerification = {
  readonly status: 'verified' | 'conflict' | 'unverified';
  readonly method: 'dual_solve_and_python' | 'dual_solve' | 'python_only' | 'none';
  readonly solverAnswers: readonly string[];
  readonly pythonChecked: boolean;
  readonly pythonPassed?: boolean;
  readonly notes?: string;
  readonly summary?: string;
};

export type PythonCheckVerifier = (expression: string, signal?: AbortSignal) => Promise<{
  readonly ran: boolean;
  readonly passed?: boolean;
  readonly detail?: string;
}>;

export type QuestionVerificationDraft = {
  readonly title: string;
  readonly prompt: string;
  readonly answer: string;
  readonly pythonCheck?: string;
};

export type QuestionVerificationOptions = {
  readonly verify?: boolean;
  readonly provider?: BackgroundLlmProvider | null;
  readonly requestId?: string;
  readonly timeoutMs?: number;
  readonly transport?: BackgroundLlmTransport;
  readonly signal?: AbortSignal;
  readonly pythonVerifier?: PythonCheckVerifier;
};

const runExecFile = promisify(execFile);
const PYTHON_TIMEOUT_MS = 3_000;
const PYTHON_MAX_BUFFER = 16 * 1024;
const PYTHON_MAX_EXPR_LENGTH = 2_000;
const SOLVER_MAX_TOKENS = 700;
const SOLVER_TIMEOUT_MS = 25_000;

const PY_AST_RUNNER = `
import ast, decimal, fractions, itertools, json, math, statistics, sys

ALLOWED_NAMES = {
    'abs': abs, 'min': min, 'max': max, 'sum': sum, 'round': round, 'len': len,
    'range': range, 'all': all, 'any': any, 'sorted': sorted, 'pow': pow,
    'enumerate': enumerate, 'zip': zip, 'map': map, 'filter': filter,
    'int': int, 'float': float, 'str': str, 'bool': bool,
    'tuple': tuple, 'list': list, 'set': set, 'dict': dict,
    'True': True, 'False': False, 'None': None,
    'math': math, 'fractions': fractions, 'Fraction': fractions.Fraction,
    'decimal': decimal, 'Decimal': decimal.Decimal,
    'statistics': statistics, 'itertools': itertools,
}
FORBIDDEN_ATTRS = {'format', 'format_map'}
SAFE_OPS = (
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow,
    ast.LShift, ast.RShift, ast.BitOr, ast.BitXor, ast.BitAnd,
    ast.UAdd, ast.USub, ast.Not, ast.Invert,
    ast.And, ast.Or,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Is, ast.IsNot, ast.In, ast.NotIn,
)

def bind_target(target, bound):
    if isinstance(target, ast.Name):
        if target.id.startswith('_') or target.id in ALLOWED_NAMES:
            raise ValueError(f'Forbidden target name: {target.id}')
        bound.add(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            bind_target(elt, bound)
    else:
        raise ValueError(f'Forbidden comprehension target: {type(target).__name__}')

def validate(node, bound):
    if isinstance(node, ast.Expression):
        validate(node.body, bound)
    elif isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float, complex, str, bool, type(None))):
            raise ValueError(f'Forbidden constant type: {type(node.value).__name__}')
    elif isinstance(node, ast.Name):
        if not isinstance(node.ctx, ast.Load) or node.id.startswith('_'):
            raise ValueError(f'Forbidden name: {node.id}')
        if node.id not in ALLOWED_NAMES and node.id not in bound:
            raise ValueError(f'Unknown identifier: {node.id}')
    elif isinstance(node, ast.Attribute):
        if not isinstance(node.ctx, ast.Load) or node.attr.startswith('_') or node.attr in FORBIDDEN_ATTRS:
            raise ValueError(f'Forbidden attribute: {node.attr}')
        validate(node.value, bound)
    elif isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        if hasattr(node, 'ctx') and not isinstance(node.ctx, ast.Load):
            raise ValueError('Invalid container context')
        for elt in node.elts:
            validate(elt, bound)
    elif isinstance(node, ast.Dict):
        for k in node.keys:
            if k is None:
                raise ValueError('Dict unpacking forbidden')
            validate(k, bound)
        for v in node.values:
            validate(v, bound)
    elif isinstance(node, ast.Subscript):
        if not isinstance(node.ctx, ast.Load):
            raise ValueError('Invalid subscript context')
        validate(node.value, bound)
        validate(node.slice, bound)
    elif isinstance(node, ast.Slice):
        for part in (node.lower, node.upper, node.step):
            if part is not None:
                validate(part, bound)
    elif isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, SAFE_OPS):
            raise ValueError(f'Forbidden op: {type(node.op).__name__}')
        validate(node.operand, bound)
    elif isinstance(node, ast.BinOp):
        if not isinstance(node.op, SAFE_OPS):
            raise ValueError(f'Forbidden op: {type(node.op).__name__}')
        validate(node.left, bound)
        validate(node.right, bound)
    elif isinstance(node, ast.BoolOp):
        if not isinstance(node.op, SAFE_OPS):
            raise ValueError(f'Forbidden op: {type(node.op).__name__}')
        for v in node.values:
            validate(v, bound)
    elif isinstance(node, ast.Compare):
        if not all(isinstance(op, SAFE_OPS) for op in node.ops):
            raise ValueError('Forbidden compare op')
        validate(node.left, bound)
        for c in node.comparators:
            validate(c, bound)
    elif isinstance(node, ast.IfExp):
        validate(node.test, bound)
        validate(node.body, bound)
        validate(node.orelse, bound)
    elif isinstance(node, ast.Call):
        validate(node.func, bound)
        for a in node.args:
            validate(a, bound)
        for kw in node.keywords:
            if kw.arg is None or kw.arg.startswith('_'):
                raise ValueError('Forbidden keyword argument')
            validate(kw.value, bound)
    elif isinstance(node, ast.Starred):
        if not isinstance(node.ctx, ast.Load):
            raise ValueError('Invalid starred context')
        validate(node.value, bound)
    elif isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        inner = set(bound)
        for gen in node.generators:
            if gen.is_async:
                raise ValueError('Async comprehension forbidden')
            validate(gen.iter, inner)
            bind_target(gen.target, inner)
            for cond in gen.ifs:
                validate(cond, inner)
        if isinstance(node, ast.DictComp):
            validate(node.key, inner)
            validate(node.value, inner)
        else:
            validate(node.elt, inner)
    else:
        raise ValueError(f'Forbidden AST node: {type(node).__name__}')

try:
    expr = sys.argv[1]
    tree = ast.parse(expr, mode='eval')
    validate(tree, set())
    val = eval(compile(tree, '<check>', 'eval'), {'__builtins__': {}}, ALLOWED_NAMES)
    if isinstance(val, bool):
        passed = val
    elif isinstance(val, float):
        passed = (not math.isnan(val)) and abs(val) > 1e-12
    elif isinstance(val, complex):
        passed = (not math.isnan(val.real)) and (not math.isnan(val.imag)) and abs(val) > 1e-12
    elif isinstance(val, decimal.Decimal):
        passed = (not val.is_nan()) and (val != 0)
    elif isinstance(val, (int, fractions.Fraction)):
        passed = val != 0
    else:
        passed = bool(val)
    print(json.dumps({'ran': True, 'passed': bool(passed)}))
except Exception as err:
    print(json.dumps({'ran': False, 'detail': f'{type(err).__name__}: {err}'[:240]}))
`.trim();

/** Run an arithmetic/logic verification expression inside an isolated Python AST sandbox. */
export async function runIsolatedPythonCheck(
  expression: string,
  signal?: AbortSignal,
): Promise<{ readonly ran: boolean; readonly passed?: boolean; readonly detail?: string }> {
  const expr = expression.trim();
  if (!expr) return { ran: false, detail: '空的 Python 验算表达式。' };
  if (expr.length > PYTHON_MAX_EXPR_LENGTH) return { ran: false, detail: 'Python 验算表达式过长。' };
  if (signal?.aborted) return { ran: false, detail: 'Python 验算已取消。' };

  try {
    const { stdout } = await runExecFile(
      'python3',
      ['-I', '-B', '-S', '-X', 'utf8', '-c', PY_AST_RUNNER, expr],
      {
        env: {},
        timeout: PYTHON_TIMEOUT_MS,
        maxBuffer: PYTHON_MAX_BUFFER,
        ...(signal ? { signal } : {}),
      },
    );
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ran: false, detail: 'Python 验算输出格式无效。' };
    }
    const record = parsed as Record<string, unknown>;
    if (record.ran === true && typeof record.passed === 'boolean') {
      return { ran: true, passed: record.passed };
    }
    return {
      ran: false,
      detail: typeof record.detail === 'string' && record.detail.trim()
        ? record.detail.trim()
        : 'Python 验算未通过执行。',
    };
  } catch (error) {
    const err = error as { name?: string; killed?: boolean; code?: string | number; message?: string };
    if (err.name === 'AbortError' || signal?.aborted) return { ran: false, detail: 'Python 验算已取消。' };
    if (err.killed || err.code === 'ETIMEDOUT') return { ran: false, detail: 'Python 验算超时。' };
    return { ran: false, detail: (err.message || 'Python 验算进程异常。').slice(0, 240) };
  }
}

function stripOuterParens(value: string): string {
  let out = value.trim();
  while (out.startsWith('(') && out.endsWith(')')) {
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')') depth--;
      if (depth === 0 && i < out.length - 1) {
        wrapsAll = false;
        break;
      }
    }
    if (!wrapsAll || depth !== 0) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

function normalizeAnswer(raw: string): string {
  let text = raw.trim();
  text = text.replace(/\$\$|\\\[|\\\]|\\\(|\\\)|\$/gu, '');
  text = text.replace(/\\(?:left|right)(?:\.|(?![A-Za-z]))/gu, '');
  for (let i = 0; i < 5; i++) {
    const next = text
      .replace(/\\(?:text|mathrm)\{([^{}]*)\}/gu, '$1')
      .replace(/\\(?:d|t)?frac\{([^{}]+)\}\{([^{}]+)\}/gu, (_, num: string, den: string) => {
        const cleanNum = num.trim();
        const cleanDen = den.trim();
        const simple = (part: string) => /^[+-]?[A-Za-z0-9.]+$/u.test(part);
        return `${simple(cleanNum) ? cleanNum : `(${cleanNum})`}/${simple(cleanDen) ? cleanDen : `(${cleanDen})`}`;
      });
    if (next === text) break;
    text = next;
  }
  text = text.replace(/\s+/gu, ' ').trim();
  return text.replace(/\s*([=,;:/()+\-])\s*/gu, '$1');
}

function parseNumericAnswer(normalized: string): number | null {
  const candidate = stripOuterParens(normalized);
  if (!candidate) return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(candidate)) {
    const num = Number(candidate);
    return Number.isFinite(num) ? num : null;
  }
  const sciLatex = /^([+-]?\d+(?:\.\d+)?)\s*(?:\\times|\*|×)\s*10\^\{?([+-]?\d+)\}?$/u.exec(candidate);
  if (sciLatex?.[1] && sciLatex[2]) {
    const num = Number(`${sciLatex[1]}e${sciLatex[2]}`);
    return Number.isFinite(num) ? num : null;
  }
  const frac = /^([+-]?(?:\d+\.?\d*|\.\d+))\/([+-]?(?:\d+\.?\d*|\.\d+))$/u.exec(candidate);
  if (frac?.[1] && frac[2]) {
    const numerator = Number(frac[1]);
    const denominator = Number(frac[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      const ratio = numerator / denominator;
      return Number.isFinite(ratio) ? ratio : null;
    }
  }
  return null;
}

/** Compare two authored or solved answers across LaTeX formatting and numeric tolerance. */
export function answersEquivalent(left: string, right: string): boolean {
  const leftNorm = normalizeAnswer(left);
  const rightNorm = normalizeAnswer(right);
  if (!leftNorm || !rightNorm) return false;
  if (leftNorm === rightNorm) return true;
  if (stripOuterParens(leftNorm) === stripOuterParens(rightNorm)) return true;
  const leftNum = parseNumericAnswer(leftNorm);
  const rightNum = parseNumericAnswer(rightNorm);
  return leftNum !== null && rightNum !== null && Math.abs(leftNum - rightNum) <= 1e-9;
}

async function solveBlindly(
  draft: QuestionVerificationDraft,
  slot: 1 | 2,
  options: QuestionVerificationOptions,
): Promise<string | null> {
  const prefix = slot === 1 ? 'question-solve-1' : 'question-solve-2';
  const system = slot === 1
    ? '你是独立解题验证器。仅根据题干独立正向求解，不要编造或参考外部答案。仅输出严格 JSON 对象：{"answer": string}。'
    : '你是独立复核解题器。请换用另一独立解法或逆向校验重新求解此题。仅输出严格 JSON 对象：{"answer": string}。';
  const blindPayload = JSON.stringify({ title: draft.title, prompt: draft.prompt });
  const timeoutMs = options.timeoutMs !== undefined ? Math.min(SOLVER_TIMEOUT_MS, options.timeoutMs) : SOLVER_TIMEOUT_MS;
  const completion = await invokeBackgroundCompletion(options.provider, [
    { role: 'system', content: system },
    { role: 'user', content: `请独立求解下列题目并仅输出 JSON 最终答案：\n${blindPayload}` },
  ], {
    requestPrefix: prefix,
    ...(options.requestId !== undefined ? { requestId: `${prefix}:${options.requestId}` } : {}),
    maxTokens: SOLVER_MAX_TOKENS,
    timeoutMs,
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const parsed = extractJsonObject(completion.content);
  const answer = parsed && typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  return answer || null;
}

/** Run answer-stripped blind dual-solving and optional isolated Python verification on a draft question. */
export async function verifyAuthoredQuestionDraft(
  draft: QuestionVerificationDraft,
  options: QuestionVerificationOptions = {},
): Promise<AuthoredQuestionVerification> {
  if (options.verify === false) {
    return {
      status: 'unverified',
      method: 'none',
      solverAnswers: [],
      pythonChecked: false,
    };
  }
  if (options.signal?.aborted) {
    throw new TeachingError('provider_timeout', '后台模型请求已取消。');
  }

  const pythonExpr = draft.pythonCheck?.trim() ?? '';
  const pythonTask = pythonExpr
    ? (options.pythonVerifier ?? runIsolatedPythonCheck)(pythonExpr, options.signal)
    : Promise.resolve(undefined);

  const [solve1, solve2, pythonSettled] = await Promise.allSettled([
    solveBlindly(draft, 1, options),
    solveBlindly(draft, 2, options),
    pythonTask,
  ]);
  if (options.signal?.aborted) {
    throw new TeachingError('provider_timeout', '后台模型请求已取消。');
  }

  const ans1 = solve1.status === 'fulfilled' ? solve1.value : null;
  const ans2 = solve2.status === 'fulfilled' ? solve2.value : null;
  const solverAnswers = [ans1, ans2].filter((value): value is string => value !== null);

  const pythonResult = pythonSettled.status === 'fulfilled'
    ? pythonSettled.value
    : { ran: false, detail: 'Python 验算执行失败。' };
  const pythonRan = Boolean(pythonResult?.ran && typeof pythonResult.passed === 'boolean');
  const pythonPassed = pythonRan ? pythonResult?.passed : undefined;
  const pythonFailed = pythonRan && pythonPassed === false;

  const ans1Mismatch = ans1 !== null && !answersEquivalent(ans1, draft.answer);
  const ans2Mismatch = ans2 !== null && !answersEquivalent(ans2, draft.answer);
  const solversDisagree = ans1 !== null && ans2 !== null && !answersEquivalent(ans1, ans2);
  const hasDual = ans1 !== null && ans2 !== null;

  if (ans1Mismatch || ans2Mismatch || solversDisagree || pythonFailed) {
    const reasons: string[] = [];
    if (pythonFailed) reasons.push('Python 验算结果为假');
    if (ans1Mismatch || ans2Mismatch) reasons.push('独立盲解结果与参考答案不一致');
    if (solversDisagree) reasons.push('两路独立盲解结果不一致');
    const method: AuthoredQuestionVerification['method'] =
      hasDual && pythonRan ? 'dual_solve_and_python'
        : hasDual ? 'dual_solve'
        : pythonRan ? 'python_only'
        : 'none';
    return {
      status: 'conflict',
      method,
      solverAnswers,
      pythonChecked: pythonRan,
      ...(pythonPassed !== undefined ? { pythonPassed } : {}),
      notes: reasons.join('；'),
      summary: '独立验算发现冲突',
    };
  }

  if (hasDual) {
    if (pythonRan && pythonPassed === true) {
      return {
        status: 'verified',
        method: 'dual_solve_and_python',
        solverAnswers,
        pythonChecked: true,
        pythonPassed: true,
        summary: '已通过独立双解与 Python 验算',
      };
    }
    return {
      status: 'verified',
      method: 'dual_solve',
      solverAnswers,
      pythonChecked: false,
      ...(pythonResult && !pythonResult.ran && pythonResult.detail
        ? { notes: `Python 验算未运行：${pythonResult.detail}` }
        : {}),
      summary: '已通过独立双解验算',
    };
  }

  if (pythonRan && pythonPassed === true) {
    return {
      status: 'verified',
      method: 'python_only',
      solverAnswers,
      pythonChecked: true,
      pythonPassed: true,
      summary: '已通过隔离 Python 验算',
    };
  }

  return {
    status: 'unverified',
    method: 'none',
    solverAnswers,
    pythonChecked: false,
    ...(pythonResult && !pythonResult.ran && pythonResult.detail
      ? { notes: `Python 验算未运行：${pythonResult.detail}` }
      : {}),
  };
}
