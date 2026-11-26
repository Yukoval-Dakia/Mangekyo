import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  CodeSandboxCaseOutcome,
  CodeSandboxCaseStatus,
  CodeSandboxLanguage,
  CodeSandboxProjection,
  CodeSandboxQualitativeDimension,
  CodeSandboxRunReport,
  FocusedQuestion,
} from './types.ts';

export type CodeQuestionSpec = {
  readonly language: CodeSandboxLanguage;
  readonly slotId: string;
  readonly path: string;
  readonly starterCode: string;
  readonly timeLimitMs?: number;
  readonly memoryLimitMb?: number;
  readonly testCaseCount?: number;
};

export type NormalizedCodeSandboxResult = {
  readonly criterionId?: string;
  readonly executorKind: string;
  readonly verifiedIsolatedExecutor: boolean;
  readonly language: CodeSandboxLanguage;
  readonly state: 'scored' | 'partial' | 'ungradable';
  readonly proportion?: number;
  readonly earned?: number;
  readonly maximum?: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
  readonly missingCaseIds: readonly string[];
  readonly compileError?: string;
  readonly timedOut: boolean;
  readonly totalDurationMs?: number;
  readonly peakMemoryMb?: number;
  readonly caseOutcomes: readonly CodeSandboxCaseOutcome[];
  readonly qualitativeDimensions: readonly CodeSandboxQualitativeDimension[];
};

const LANGUAGE_LABELS: Readonly<Record<CodeSandboxLanguage, string>> = {
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
};

const CASE_STATUS_LABELS: Readonly<Record<CodeSandboxCaseStatus, string>> = {
  passed: '通过',
  failed: '未通过',
  timeout: '超时',
  runtime_error: '运行错误',
  syntax_error: '语法错误',
  output_limit_exceeded: '输出超限',
};

const PROJECTION_STATE_LABELS: Readonly<Record<'scored' | 'partial' | 'ungradable', string>> = {
  scored: '客观用例已评分',
  partial: '部分用例完成',
  ungradable: '暂无法评分',
};

const VALID_CASE_STATUSES = new Set<CodeSandboxCaseStatus>([
  'passed',
  'failed',
  'timeout',
  'runtime_error',
  'syntax_error',
  'output_limit_exceeded',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLanguage(raw: unknown): CodeSandboxLanguage | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'python' || lowered === 'py' || lowered === 'python3') return 'python';
  if (lowered === 'javascript' || lowered === 'js' || lowered === 'node') return 'javascript';
  if (lowered === 'typescript' || lowered === 'ts') return 'typescript';
  return null;
}

type SchemaSlotCandidate = {
  readonly slotId: string;
  readonly schemaVersion?: string;
  readonly fields: readonly { readonly path: string; readonly kind: string }[];
};

function extractSchemaCandidates(responseSchema: unknown): {
  readonly rootSchemaVersion?: string;
  readonly slots: readonly SchemaSlotCandidate[];
} {
  const slots: SchemaSlotCandidate[] = [];
  let rootSchemaVersion: string | undefined;

  const pushSlot = (entry: unknown) => {
    if (!isRecord(entry) || typeof entry.slotId !== 'string' || !entry.slotId || !Array.isArray(entry.fields)) return;
    const fields: { readonly path: string; readonly kind: string }[] = [];
    for (const field of entry.fields) {
      if (!isRecord(field)) continue;
      if (typeof field.path === 'string' && typeof field.kind === 'string') {
        fields.push({ path: field.path, kind: field.kind });
      }
    }
    if (fields.length > 0) {
      slots.push({
        slotId: entry.slotId,
        ...(typeof entry.schemaVersion === 'string' ? { schemaVersion: entry.schemaVersion } : {}),
        fields,
      });
    }
  };

  if (Array.isArray(responseSchema)) {
    for (const entry of responseSchema) pushSlot(entry);
  } else if (isRecord(responseSchema)) {
    if (typeof responseSchema.schemaVersion === 'string') {
      rootSchemaVersion = responseSchema.schemaVersion;
    }
    if (Array.isArray(responseSchema.slots)) {
      for (const entry of responseSchema.slots) pushSlot(entry);
    } else {
      pushSlot(responseSchema);
    }
  }

  return { ...(rootSchemaVersion ? { rootSchemaVersion } : {}), slots };
}

export function detectCodeQuestion(question: FocusedQuestion): CodeQuestionSpec | null {
  if (question.kind !== 'bank') return null;

  const sandboxConfig = isRecord(question.codeSandbox) ? question.codeSandbox : null;
  const suiteConfig = isRecord(question.codeTestSuite) ? question.codeTestSuite : null;
  const hasExplicitSandbox =
    question.codeSandbox === true ||
    sandboxConfig !== null ||
    (typeof question.codeLanguage === 'string' && question.codeLanguage.trim().length > 0) ||
    (question.codeTestSuite !== undefined && question.codeTestSuite !== null);

  const schema = extractSchemaCandidates(question.responseSchema);
  const rootVersionHasCode = Boolean(
    schema.rootSchemaVersion && schema.rootSchemaVersion.toLowerCase().includes('code'),
  );

  const matchingCodeSlot =
    schema.slots.find(
      (slot) =>
        (slot.slotId.toLowerCase().includes('code') ||
          Boolean(slot.schemaVersion && slot.schemaVersion.toLowerCase().includes('code')) ||
          rootVersionHasCode) &&
        slot.fields.some((field) => field.kind === 'text'),
    ) ?? null;

  if (!hasExplicitSandbox && !matchingCodeSlot) return null;

  const fallbackTextSlot =
    matchingCodeSlot ?? schema.slots.find((slot) => slot.fields.some((field) => field.kind === 'text')) ?? null;
  const textField =
    fallbackTextSlot?.fields.find((field) => field.kind === 'text' && field.path === '') ??
    fallbackTextSlot?.fields.find((field) => field.kind === 'text') ??
    null;

  const slotId =
    (typeof sandboxConfig?.slotId === 'string' && sandboxConfig.slotId.trim()) ||
    fallbackTextSlot?.slotId ||
    'code';
  const path =
    typeof sandboxConfig?.path === 'string'
      ? sandboxConfig.path
      : textField?.path ?? '';

  const language =
    normalizeLanguage(sandboxConfig?.language) ??
    normalizeLanguage(question.codeLanguage) ??
    normalizeLanguage(suiteConfig?.language) ??
    'python';

  const starterCode =
    typeof sandboxConfig?.starterCode === 'string'
      ? sandboxConfig.starterCode
      : typeof question.starterCode === 'string'
        ? question.starterCode
        : typeof suiteConfig?.starterCode === 'string'
          ? suiteConfig.starterCode
          : '';

  const suiteLimits = isRecord(suiteConfig?.limits) ? suiteConfig.limits : null;
  const timeLimitMs =
    typeof sandboxConfig?.timeLimitMs === 'number' && Number.isFinite(sandboxConfig.timeLimitMs)
      ? sandboxConfig.timeLimitMs
      : typeof suiteLimits?.timeoutMs === 'number' && Number.isFinite(suiteLimits.timeoutMs)
        ? suiteLimits.timeoutMs
        : typeof suiteConfig?.timeLimitMs === 'number' && Number.isFinite(suiteConfig.timeLimitMs)
          ? suiteConfig.timeLimitMs
          : undefined;

  const memoryLimitMb =
    typeof sandboxConfig?.memoryLimitMb === 'number' && Number.isFinite(sandboxConfig.memoryLimitMb)
      ? sandboxConfig.memoryLimitMb
      : typeof suiteLimits?.memoryMb === 'number' && Number.isFinite(suiteLimits.memoryMb)
        ? suiteLimits.memoryMb
        : typeof suiteConfig?.memoryLimitMb === 'number' && Number.isFinite(suiteConfig.memoryLimitMb)
          ? suiteConfig.memoryLimitMb
          : undefined;

  const testCaseCount =
    typeof sandboxConfig?.testCaseCount === 'number' && Number.isSafeInteger(sandboxConfig.testCaseCount)
      ? sandboxConfig.testCaseCount
      : Array.isArray(suiteConfig?.cases)
        ? suiteConfig.cases.length
        : undefined;

  return {
    language,
    slotId,
    path,
    starterCode,
    ...(timeLimitMs !== undefined ? { timeLimitMs } : {}),
    ...(memoryLimitMb !== undefined ? { memoryLimitMb } : {}),
    ...(testCaseCount !== undefined ? { testCaseCount } : {}),
  };
}

type BankAnswerRow = {
  readonly slotId: string;
  readonly path: string;
  readonly value: Record<string, unknown>;
};

function parseBankAnswerRows(raw: string): BankAnswerRow[] | null {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const rows: BankAnswerRow[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) return null;
      if (typeof entry.slotId !== 'string' || typeof entry.path !== 'string' || !isRecord(entry.value)) return null;
      rows.push({ slotId: entry.slotId, path: entry.path, value: entry.value });
    }
    return rows;
  } catch {
    return null;
  }
}

export function encodeCodeBankAnswer(
  existingRaw: string,
  slotId: string,
  path: string,
  code: string,
): string {
  const previous = parseBankAnswerRows(existingRaw) ?? [];
  const kept = previous.filter((row) => !(row.slotId === slotId && row.path === path));
  if (code.length === 0 && kept.length === 0) return '';
  return JSON.stringify([
    ...kept,
    { slotId, path, value: { kind: 'text', value: code } },
  ]);
}

export function decodeCodeBankAnswer(
  raw: string | null | undefined,
  slotId: string,
  path: string,
): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw) return '';
  const rows = parseBankAnswerRows(raw);
  if (rows === null) return raw;
  const exact = rows.find(
    (row) =>
      row.slotId === slotId &&
      row.path === path &&
      row.value.kind === 'text' &&
      typeof row.value.value === 'string',
  );
  if (exact && typeof exact.value.value === 'string') return exact.value.value;

  const bySlot = rows.find(
    (row) => row.slotId === slotId && row.value.kind === 'text' && typeof row.value.value === 'string',
  );
  if (bySlot && typeof bySlot.value.value === 'string') return bySlot.value.value;

  if (rows.length === 1 && rows[0]?.value.kind === 'text' && typeof rows[0].value.value === 'string') {
    return rows[0].value.value;
  }
  return '';
}

function normalizeCaseOutcomes(raw: unknown): readonly CodeSandboxCaseOutcome[] {
  if (!Array.isArray(raw)) return [];
  const outcomes: CodeSandboxCaseOutcome[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.caseId !== 'string' || !entry.caseId) continue;
    const status: CodeSandboxCaseStatus =
      typeof entry.status === 'string' && VALID_CASE_STATUSES.has(entry.status as CodeSandboxCaseStatus)
        ? (entry.status as CodeSandboxCaseStatus)
        : entry.passed === true
          ? 'passed'
          : 'failed';
    const passed = typeof entry.passed === 'boolean' ? entry.passed : status === 'passed';
    const hidden = typeof entry.hidden === 'boolean' ? entry.hidden : false;
    const weight = typeof entry.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 1;
    outcomes.push({
      caseId: entry.caseId,
      hidden,
      weight,
      passed,
      status,
      ...(typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
        ? { durationMs: entry.durationMs }
        : {}),
      ...(typeof entry.stderr === 'string' && entry.stderr.length > 0 ? { stderr: entry.stderr } : {}),
      ...(typeof entry.diagnostic === 'string' && entry.diagnostic.length > 0
        ? { diagnostic: entry.diagnostic }
        : {}),
    });
  }
  return outcomes;
}

function normalizeQualitativeDimensions(raw: unknown): readonly CodeSandboxQualitativeDimension[] {
  if (!Array.isArray(raw)) return [];
  const dims: CodeSandboxQualitativeDimension[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) {
      dims.push({
        dimension: entry.trim(),
        state: 'unknown',
        countsTowardMastery: false,
        reason: '主观代码风格维度的证据不足以做确定性判定，仅作参考且不计入掌握度。',
      });
      continue;
    }
    if (!isRecord(entry) || typeof entry.dimension !== 'string' || !entry.dimension.trim()) continue;
    // Domain 2 invariant: qualitative dimensions always remain unknown and never count toward mastery.
    dims.push({
      dimension: entry.dimension.trim(),
      state: 'unknown',
      countsTowardMastery: false,
      reason:
        typeof entry.reason === 'string' && entry.reason.trim()
          ? entry.reason.trim()
          : '主观代码风格维度的证据不足以做确定性判定，仅作参考且不计入掌握度。',
    });
  }
  return dims;
}

export function normalizeCodeSandboxResult(
  raw: CodeSandboxProjection | CodeSandboxRunReport | unknown,
  fallbackLanguage: CodeSandboxLanguage = 'python',
): NormalizedCodeSandboxResult | null {
  if (!isRecord(raw)) return null;
  const hasAnySignal =
    typeof raw.executorKind === 'string' ||
    Array.isArray(raw.caseOutcomes) ||
    Array.isArray(raw.results) ||
    typeof raw.passedCount === 'number' ||
    typeof raw.compileError === 'string' ||
    Array.isArray(raw.qualitativeDimensions);
  if (!hasAnySignal) return null;

  const executorKind = typeof raw.executorKind === 'string' ? raw.executorKind : 'unknown';
  const verifiedIsolatedExecutor = executorKind === 'isolated-code-sandbox';
  const language = normalizeLanguage(raw.language) ?? fallbackLanguage;
  const caseOutcomes = normalizeCaseOutcomes(Array.isArray(raw.caseOutcomes) ? raw.caseOutcomes : raw.results);
  const qualitativeDimensions = normalizeQualitativeDimensions(raw.qualitativeDimensions);

  const computedPassed = caseOutcomes.filter((c) => c.passed).length;
  const totalCount =
    typeof raw.totalCount === 'number' && Number.isFinite(raw.totalCount)
      ? Math.max(0, Math.round(raw.totalCount))
      : caseOutcomes.length;
  const passedCount =
    typeof raw.passedCount === 'number' && Number.isFinite(raw.passedCount)
      ? Math.max(0, Math.round(raw.passedCount))
      : computedPassed;
  const failedCount =
    typeof raw.failedCount === 'number' && Number.isFinite(raw.failedCount)
      ? Math.max(0, Math.round(raw.failedCount))
      : Math.max(0, totalCount - passedCount);

  const state: 'scored' | 'partial' | 'ungradable' =
    raw.state === 'scored' || raw.state === 'partial' || raw.state === 'ungradable'
      ? raw.state
      : !verifiedIsolatedExecutor || totalCount === 0
        ? 'ungradable'
        : passedCount === totalCount
          ? 'scored'
          : 'partial';

  const missingCaseIds = Array.isArray(raw.missingCaseIds)
    ? raw.missingCaseIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];

  const totalDurationMs =
    typeof raw.totalDurationMs === 'number' && Number.isFinite(raw.totalDurationMs)
      ? raw.totalDurationMs
      : typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
        ? raw.durationMs
        : undefined;

  const peakMemoryMb =
    typeof raw.peakMemoryMb === 'number' && Number.isFinite(raw.peakMemoryMb) ? raw.peakMemoryMb : undefined;

  return {
    ...(typeof raw.criterionId === 'string' && raw.criterionId ? { criterionId: raw.criterionId } : {}),
    executorKind,
    verifiedIsolatedExecutor,
    language,
    state,
    ...(typeof raw.proportion === 'number' && Number.isFinite(raw.proportion) ? { proportion: raw.proportion } : {}),
    ...(typeof raw.earned === 'number' && Number.isFinite(raw.earned) ? { earned: raw.earned } : {}),
    ...(typeof raw.maximum === 'number' && Number.isFinite(raw.maximum) ? { maximum: raw.maximum } : {}),
    passedCount,
    failedCount,
    totalCount,
    missingCaseIds,
    ...(typeof raw.compileError === 'string' && raw.compileError.trim() ? { compileError: raw.compileError } : {}),
    timedOut: raw.timedOut === true || caseOutcomes.some((c) => c.status === 'timeout'),
    ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
    ...(peakMemoryMb !== undefined ? { peakMemoryMb } : {}),
    caseOutcomes,
    qualitativeDimensions,
  };
}

function adjustIndent(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: 'indent' | 'outdent',
): { readonly nextValue: string; readonly nextStart: number; readonly nextEnd: number } {
  const indentUnit = '  ';
  if (direction === 'indent' && selectionStart === selectionEnd) {
    return {
      nextValue: value.slice(0, selectionStart) + indentUnit + value.slice(selectionEnd),
      nextStart: selectionStart + indentUnit.length,
      nextEnd: selectionStart + indentUnit.length,
    };
  }

  const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const lineEndIndex = value.indexOf('\n', selectionEnd);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');

  let firstDelta = 0;
  let totalDelta = 0;

  const transformed = lines.map((line, idx) => {
    if (direction === 'indent') {
      if (idx === 0) firstDelta = indentUnit.length;
      totalDelta += indentUnit.length;
      return indentUnit + line;
    }
    if (line.startsWith(indentUnit)) {
      if (idx === 0) firstDelta = -indentUnit.length;
      totalDelta -= indentUnit.length;
      return line.slice(indentUnit.length);
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (idx === 0) firstDelta = -1;
      totalDelta -= 1;
      return line.slice(1);
    }
    return line;
  });

  const nextValue = value.slice(0, lineStart) + transformed.join('\n') + value.slice(lineEnd);
  const nextStart = Math.max(lineStart, selectionStart + firstDelta);
  const nextEnd = Math.max(nextStart, selectionEnd + totalDelta);
  return { nextValue, nextStart, nextEnd };
}

export function CodeSandboxCard({
  spec,
  rawAnswer,
  submittedRawAnswer,
  onRawAnswerChange,
  submitted,
  disabled,
  sandboxResult,
}: {
  readonly spec: CodeQuestionSpec;
  readonly rawAnswer: string;
  readonly submittedRawAnswer?: string | null | undefined;
  readonly onRawAnswerChange: (encoded: string) => void;
  readonly submitted: boolean;
  readonly disabled?: boolean | undefined;
  readonly sandboxResult?: CodeSandboxProjection | CodeSandboxRunReport | unknown;
}) {
  const editorId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [tabIndentEnabled, setTabIndentEnabled] = useState(true);

  const decodedCurrent = useMemo(
    () => decodeCodeBankAnswer(rawAnswer, spec.slotId, spec.path),
    [rawAnswer, spec.slotId, spec.path],
  );
  const code = decodedCurrent ?? '';

  const submittedCode = useMemo(() => {
    const preferred =
      submittedRawAnswer !== undefined && submittedRawAnswer !== null
        ? decodeCodeBankAnswer(submittedRawAnswer, spec.slotId, spec.path)
        : null;
    if (preferred !== null && preferred.length > 0) return preferred;
    return code;
  }, [submittedRawAnswer, spec.slotId, spec.path, code]);

  const normalizedResult = useMemo(
    () => normalizeCodeSandboxResult(sandboxResult, spec.language),
    [sandboxResult, spec.language],
  );

  const displayedCode = submitted ? submittedCode : code;
  const lineCount = displayedCode.length === 0 ? 1 : displayedCode.split('\n').length;
  const canResetStarter = Boolean(spec.starterCode) && code !== spec.starterCode;

  function commitCode(nextCode: string) {
    onRawAnswerChange(encodeCodeBankAnswer(rawAnswer, spec.slotId, spec.path, nextCode));
  }

  function applyIndent(direction: 'indent' | 'outdent') {
    const el = textareaRef.current;
    if (!el || disabled || submitted) return;
    const { nextValue, nextStart, nextEnd } = adjustIndent(
      code,
      el.selectionStart,
      el.selectionEnd,
      direction,
    );
    commitCode(nextValue);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(nextStart, nextEnd);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Tab' && tabIndentEnabled) {
      event.preventDefault();
      applyIndent(event.shiftKey ? 'outdent' : 'indent');
    }
  }

  return (
    <section className="wbv2-code-card" aria-label={`代码作答区（${LANGUAGE_LABELS[spec.language]}）`}>
      <header className="wbv2-code-head">
        <div className="wbv2-code-meta">
          <span className="wbv2-code-lang" data-lang={spec.language}>
            {LANGUAGE_LABELS[spec.language]}
            <code>{spec.language}</code>
          </span>
          <span className="wbv2-code-stat">{lineCount} 行</span>
          {spec.timeLimitMs !== undefined && <span className="wbv2-code-stat">限时 {spec.timeLimitMs} ms</span>}
          {spec.memoryLimitMb !== undefined && <span className="wbv2-code-stat">内存 {spec.memoryLimitMb} MB</span>}
          {spec.testCaseCount !== undefined && <span className="wbv2-code-stat">{spec.testCaseCount} 个用例</span>}
        </div>

        {!submitted && (
          <div className="wbv2-code-tools" role="toolbar" aria-label="代码编辑辅助操作">
            <button
              type="button"
              className="wbv2-code-tool-btn"
              disabled={disabled}
              onClick={() => applyIndent('indent')}
              aria-label="增加两空格缩进"
            >
              + 缩进
            </button>
            <button
              type="button"
              className="wbv2-code-tool-btn"
              disabled={disabled}
              onClick={() => applyIndent('outdent')}
              aria-label="减少两空格缩进"
            >
              − 反缩进
            </button>
            <button
              type="button"
              className="wbv2-code-tool-btn"
              aria-pressed={tabIndentEnabled}
              disabled={disabled}
              onClick={() => setTabIndentEnabled((prev) => !prev)}
            >
              Tab 缩进：{tabIndentEnabled ? '开' : '关'}
            </button>
            {spec.starterCode && (
              <button
                type="button"
                className="wbv2-code-tool-btn"
                disabled={disabled || !canResetStarter}
                onClick={() => commitCode(spec.starterCode)}
              >
                恢复初始代码
              </button>
            )}
          </div>
        )}
      </header>

      {!submitted ? (
        <div className="wbv2-code-editor-wrap">
          <label htmlFor={editorId} className="visually-hidden">
            {LANGUAGE_LABELS[spec.language]} 代码编辑器
          </label>
          <textarea
            ref={textareaRef}
            id={editorId}
            className="wbv2-code-textarea"
            value={code}
            disabled={disabled}
            rows={Math.min(18, Math.max(8, lineCount + 1))}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            placeholder={spec.starterCode || `在此编写 ${LANGUAGE_LABELS[spec.language]} 代码…`}
            onChange={(event) => commitCode(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
          <p className="wbv2-code-kbd-hint">
            支持 <code>Tab</code> 缩进、<code>Shift+Tab</code> 反缩进与 <code>Esc</code> 退出焦点；触屏也可直接使用上方缩进按钮。
          </p>
        </div>
      ) : (
        <div className="wbv2-code-review-code">
          <span className="wbv2-feedback-label">你的提交代码</span>
          {submittedCode.trim() ? (
            <pre className="wbv2-code-pre">
              <code>{submittedCode}</code>
            </pre>
          ) : (
            <p className="wbv2-code-empty">本次未提交代码。</p>
          )}
        </div>
      )}

      {(submitted || normalizedResult !== null) && (
        <div className="wbv2-code-eval">
          {!normalizedResult ? (
            <div className="wbv2-code-pending" role="status">
              <strong>等待隔离沙箱评估结果</strong>
              <p>
                代码已按结构化作答契约保存；当前尚未收到 <code>isolated-code-sandbox</code> 执行回执，或本环境暂未接线隔离沙箱。
              </p>
            </div>
          ) : (
            <>
              {/* 区一：客观测试用例结果 */}
              <section className="wbv2-code-zone" aria-label="客观测试用例结果">
                <div className="wbv2-code-zone-head">
                  <h4>客观测试用例结果</h4>
                  {normalizedResult.verifiedIsolatedExecutor ? (
                    <span className="wbv2-code-exec-badge is-verified">
                      隔离沙箱执行 · <code>isolated-code-sandbox</code>
                    </span>
                  ) : (
                    <span className="wbv2-code-exec-badge is-unverified">
                      未确认隔离沙箱执行（<code>{normalizedResult.executorKind}</code>）
                    </span>
                  )}
                </div>

                <div className="wbv2-code-summary-pills">
                  <span
                    className={`wbv2-code-pill ${
                      normalizedResult.totalCount > 0 &&
                      normalizedResult.passedCount === normalizedResult.totalCount &&
                      normalizedResult.verifiedIsolatedExecutor
                        ? 'is-ok'
                        : normalizedResult.passedCount > 0
                          ? 'is-info'
                          : 'is-warn'
                    }`}
                  >
                    通过率 {normalizedResult.passedCount} / {normalizedResult.totalCount}
                    {normalizedResult.totalCount > 0
                      ? `（${Math.round((normalizedResult.passedCount / normalizedResult.totalCount) * 100)}%）`
                      : ''}
                  </span>
                  <span className="wbv2-code-pill is-info">
                    {PROJECTION_STATE_LABELS[normalizedResult.state]}
                  </span>
                  {normalizedResult.earned !== undefined && normalizedResult.maximum !== undefined && (
                    <span className="wbv2-code-pill">
                      得分 {normalizedResult.earned} / {normalizedResult.maximum}
                    </span>
                  )}
                  {normalizedResult.totalDurationMs !== undefined && (
                    <span className="wbv2-code-pill">总耗时 {normalizedResult.totalDurationMs} ms</span>
                  )}
                  {normalizedResult.peakMemoryMb !== undefined && (
                    <span className="wbv2-code-pill">峰值内存 {normalizedResult.peakMemoryMb} MB</span>
                  )}
                  {normalizedResult.timedOut && (
                    <span className="wbv2-code-pill is-warn">存在执行超时</span>
                  )}
                </div>

                {normalizedResult.compileError && (
                  <div className="wbv2-code-error-box" role="alert">
                    <span className="wbv2-feedback-label">编译 / 语法错误</span>
                    <pre className="wbv2-code-stderr">{normalizedResult.compileError}</pre>
                  </div>
                )}

                {normalizedResult.missingCaseIds.length > 0 && (
                  <p className="wbv2-code-missing" role="status">
                    以下测试用例尚未返回结果：{normalizedResult.missingCaseIds.join('、')}
                  </p>
                )}

                {normalizedResult.caseOutcomes.length > 0 ? (
                  <ul className="wbv2-code-cases">
                    {normalizedResult.caseOutcomes.map((item) => (
                      <li key={item.caseId} className={`wbv2-code-case ${item.passed ? 'is-pass' : 'is-fail'}`}>
                        <div className="wbv2-code-case-row">
                          <span className="wbv2-code-case-id">
                            <code>{item.caseId}</code>
                            {item.hidden && <span className="wbv2-code-hidden-tag">隐藏用例</span>}
                            {item.weight !== 1 && <span className="wbv2-code-weight-tag">权重 {item.weight}</span>}
                          </span>
                          <span className="wbv2-code-case-meta">
                            {item.durationMs !== undefined && <span>{item.durationMs} ms</span>}
                            <span className={`wbv2-code-case-status ${item.passed ? 'is-pass' : 'is-fail'}`}>
                              {CASE_STATUS_LABELS[item.status]}
                            </span>
                          </span>
                        </div>
                        {item.diagnostic && <p className="wbv2-code-diagnostic">{item.diagnostic}</p>}
                        {item.stderr && <pre className="wbv2-code-stderr">{item.stderr}</pre>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="wbv2-code-empty">暂无逐用例执行明细。</p>
                )}
              </section>

              {/* 区二：主观代码风格维度 */}
              <section className="wbv2-code-zone wbv2-code-zone--qualitative" aria-label="主观代码风格维度">
                <div className="wbv2-code-zone-head">
                  <h4>主观代码风格维度</h4>
                  <span className="wbv2-code-mastery-guard">主观风格维度不计入掌握度</span>
                </div>
                {normalizedResult.qualitativeDimensions.length > 0 ? (
                  <ul className="wbv2-code-qual-list">
                    {normalizedResult.qualitativeDimensions.map((dim) => (
                      <li key={dim.dimension} className="wbv2-code-qual-item">
                        <div className="wbv2-code-qual-row">
                          <strong>{dim.dimension}</strong>
                          <span className="wbv2-code-qual-tags">
                            <span className="wbv2-code-unknown-tag">unknown</span>
                            <span className="wbv2-code-nocount-tag">不计入掌握度</span>
                          </span>
                        </div>
                        <p className="wbv2-code-qual-reason">{dim.reason}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="wbv2-code-empty">
                    暂无主观风格维度条目；此类维度均标注 <code>unknown</code>，且主观风格维度不计入掌握度。
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </section>
  );
}
