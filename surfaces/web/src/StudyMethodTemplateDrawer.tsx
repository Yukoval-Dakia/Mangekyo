import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { isRecord, readArray, readTrimmed } from './shared/safe-values';
import {
  builtInStudyMethodTemplates,
  createStudyMethodStep,
  DEFAULT_TEMPLATES_ENDPOINT,
  loadSelectedStudyMethodTemplateId,
  loadStoredStudyMethodTemplates,
  MAX_STUDY_METHOD_STEP_MINUTES,
  MAX_STUDY_METHOD_STEPS,
  mergeStudyMethodTemplates,
  sanitizeStudyMethodTemplate,
  saveSelectedStudyMethodTemplateId,
  saveStoredStudyMethodTemplates,
  STUDY_METHOD_STEP_META,
  studyMethodStepKinds,
  trySyncSaveTemplate,
  trySyncUndoTemplate,
  validateStudyMethodTemplate,
  type StudyMethodAuthor,
  type StudyMethodStep,
  type StudyMethodStepKind,
  type StudyMethodStepPrimitiveMeta,
  type StudyMethodTemplate,
  type StudyMethodValidationResult,
} from './study-method-templates-model';
import './classroom.css';

export {
  builtInStudyMethodTemplates,
  loadSelectedStudyMethodTemplateId,
  loadStoredStudyMethodTemplates,
  saveSelectedStudyMethodTemplateId,
  STUDY_METHOD_STEP_META,
  studyMethodStepKinds,
  validateStudyMethodTemplate,
  type StudyMethodAuthor,
  type StudyMethodStep,
  type StudyMethodStepKind,
  type StudyMethodStepPrimitiveMeta,
  type StudyMethodTemplate,
  type StudyMethodValidationResult,
};

type UndoRecord = {
  readonly undoToken: string;
  readonly templateId: string;
  readonly savedVersion: number;
  readonly previous: StudyMethodTemplate | null;
  readonly syncedRemote: boolean;
};

export function StudyMethodTemplateDrawer({
  open,
  templates,
  selectedTemplateId,
  onSelectTemplate,
  onTemplatesChange,
  onClose,
  endpoint,
  autoFetch,
}: {
  readonly open: boolean;
  readonly templates: readonly StudyMethodTemplate[];
  readonly selectedTemplateId: string;
  readonly onSelectTemplate: (template: StudyMethodTemplate) => void;
  readonly onTemplatesChange: (nextTemplates: readonly StudyMethodTemplate[]) => void;
  readonly onClose: () => void;
  readonly endpoint?: string | undefined;
  readonly autoFetch?: boolean | undefined;
}) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const templatesRef = useRef(templates);
  templatesRef.current = templates;
  const onTemplatesChangeRef = useRef(onTemplatesChange);
  onTemplatesChangeRef.current = onTemplatesChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchSeqRef = useRef(0);
  const mutationVersionRef = useRef(0);

  const resolvedEndpoint = readTrimmed(endpoint) ?? DEFAULT_TEMPLATES_ENDPOINT;
  const shouldAutoFetch = autoFetch === true || (autoFetch !== false && Boolean(readTrimmed(endpoint)));

  const activeTemplate = useMemo(
    () =>
      templates.find((item) => item.templateId === selectedTemplateId) ??
      templates[0] ??
      builtInStudyMethodTemplates[0]!,
    [templates, selectedTemplateId],
  );

  const [draft, setDraft] = useState<StudyMethodTemplate>(() => activeTemplate);
  const [newStepKind, setNewStepKind] = useState<StudyMethodStepKind>('predict');
  const [tagsInput, setTagsInput] = useState(() => activeTemplate.disciplineTags.join('、'));
  const [obsInput, setObsInput] = useState(() => activeTemplate.observationRequirements.join('\n'));
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  const [undoRecord, setUndoRecord] = useState<UndoRecord | null>(null);

  const loadIntoEditor = useCallback((template: StudyMethodTemplate) => {
    setDraft(template);
    setTagsInput(template.disciplineTags.join('、'));
    setObsInput(template.observationRequirements.join('\n'));
  }, []);

  const syncFromRemote = useCallback(
    async (explicitTrigger = false) => {
      fetchAbortRef.current?.abort();
      const controller = new AbortController();
      fetchAbortRef.current = controller;
      const seq = ++fetchSeqRef.current;
      const isCurrent = () => !controller.signal.aborted && seq === fetchSeqRef.current;

      if (explicitTrigger) {
        setSyncing(true);
        setStatusNote('');
      }
      try {
        const response = await fetch(resolvedEndpoint, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          if (explicitTrigger && isCurrent()) {
            setStatusNote(
              response.status === 404 || response.status === 405
                ? `当前环境尚未开放远端模板库（HTTP ${response.status}），继续使用本机模板。`
                : `远端模板同步未成功（HTTP ${response.status}），继续使用本机模板。`,
            );
          }
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        const list = Array.isArray(body)
          ? body
          : isRecord(body) && Array.isArray(body.templates)
            ? body.templates
            : null;
        if (!list || !isCurrent()) return;

        const sanitized = readArray(list, sanitizeStudyMethodTemplate);
        if (sanitized.length > 0) {
          // 本地已保存的同版本或更高版本模板优先保留，避免异步 GET 慢响应覆盖刚保存的新模板。
          const merged = mergeStudyMethodTemplates(sanitized, templatesRef.current);
          saveStoredStudyMethodTemplates(merged);
          onTemplatesChangeRef.current(merged);
          if (explicitTrigger) setStatusNote(`已从远端同步 ${sanitized.length} 套学法模板。`);
        } else if (explicitTrigger) {
          setStatusNote('远端暂未返回新的学法模板，已保留本机模板。');
        }
      } catch {
        if (explicitTrigger && isCurrent()) setStatusNote('暂无法连接远端模板库，继续使用本机模板。');
      } finally {
        if (explicitTrigger && isCurrent()) setSyncing(false);
      }
    },
    [resolvedEndpoint],
  );

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    loadIntoEditor(activeTemplate);
    const rafId = requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
    // Intentionally sync focus/draft only on open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !shouldAutoFetch) return;
    void syncFromRemote(false);
    return () => fetchAbortRef.current?.abort();
  }, [open, shouldAutoFetch, syncFromRemote]);

  const validation = useMemo(() => validateStudyMethodTemplate(draft), [draft]);

  if (!open) return null;

  function applySelection(nextList: readonly StudyMethodTemplate[], selected: StudyMethodTemplate) {
    saveStoredStudyMethodTemplates(nextList);
    saveSelectedStudyMethodTemplateId(selected.templateId);
    onTemplatesChange(nextList);
    onSelectTemplate(selected);
    loadIntoEditor(selected);
  }

  function selectExisting(template: StudyMethodTemplate) {
    onSelectTemplate(template);
    saveSelectedStudyMethodTemplateId(template.templateId);
    loadIntoEditor(template);
    setStatusNote('');
  }

  function createCustomFork() {
    const suffix = Math.random().toString(36).slice(2, 6);
    const created: StudyMethodTemplate = {
      templateId: `custom_${suffix}`,
      version: 1,
      name: `${draft.name}（共创版）`,
      goal: draft.goal || '按学习者节奏共创的受控课堂步骤编排。',
      disciplineTags: draft.disciplineTags.length ? draft.disciplineTags : ['共创'],
      steps: draft.steps.map((step, index) => ({ ...step, stepId: `custom-${suffix}-${index + 1}` })),
      observationRequirements: draft.observationRequirements,
      author: 'co_created',
    };
    loadIntoEditor(created);
    setStatusNote('已创建共创草稿，点击「保存新版本并使用」生效。');
  }

  function clearStepMaxMinutes(index: number) {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((step, idx) => {
        if (idx !== index) return step;
        const { maxMinutes: _removed, ...rest } = step;
        return rest;
      }),
    }));
  }

  function updateStep(index: number, patch: Partial<StudyMethodStep>) {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((step, idx) => (idx === index ? { ...step, ...patch } : step)),
    }));
  }

  function moveStep(index: number, delta: -1 | 1) {
    setDraft((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.steps.length) return prev;
      const nextSteps = [...prev.steps];
      const [moved] = nextSteps.splice(index, 1);
      if (!moved) return prev;
      nextSteps.splice(target, 0, moved);
      return { ...prev, steps: nextSteps };
    });
  }

  function removeStep(index: number) {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.filter((_, idx) => idx !== index),
    }));
  }

  function addStep(kind: StudyMethodStepKind, overrides?: Partial<StudyMethodStep>) {
    setDraft((prev) => {
      if (prev.steps.length >= MAX_STUDY_METHOD_STEPS) return prev;
      return { ...prev, steps: [...prev.steps, { ...createStudyMethodStep(kind), ...overrides }] };
    });
  }

  async function handleSaveVersion() {
    if (!validation.valid || saving) return;
    setSaving(true);
    setStatusNote('');
    mutationVersionRef.current += 1;

    try {
      const currentTemplates = templatesRef.current;
      const existing = currentTemplates.find((item) => item.templateId === draft.templateId) ?? null;
      const nextVersion = existing ? existing.version + 1 : 1;
      const undoToken = existing
        ? `undo:method-template:${draft.templateId}:v${nextVersion}:from-v${existing.version}`
        : `undo:method-template:${draft.templateId}:v${nextVersion}`;
      const savedTemplate: StudyMethodTemplate = {
        templateId: draft.templateId,
        version: nextVersion,
        name: draft.name.trim(),
        goal: draft.goal.trim(),
        disciplineTags: tagsInput.split(/[、,，\s]+/).map((item) => item.trim()).filter(Boolean),
        steps: draft.steps.map((step) => ({
          ...step,
          title: step.title.trim(),
          promptHint: step.promptHint.trim(),
        })),
        observationRequirements: obsInput.split('\n').map((item) => item.trim()).filter(Boolean),
        author: 'co_created',
        ...(existing ? { replacesVersion: existing.version } : {}),
        undoToken,
      };
      const nextList = existing
        ? currentTemplates.map((item) => (item.templateId === savedTemplate.templateId ? savedTemplate : item))
        : [...currentTemplates, savedTemplate];

      applySelection(nextList, savedTemplate);
      const syncResult = await trySyncSaveTemplate(savedTemplate, resolvedEndpoint);
      setUndoRecord({
        undoToken,
        templateId: savedTemplate.templateId,
        savedVersion: nextVersion,
        previous: existing,
        syncedRemote: syncResult.synced,
      });
      setStatusNote(syncResult.note);
    } finally {
      setSaving(false);
    }
  }

  async function handleUndo() {
    if (!undoRecord || saving) return;
    setSaving(true);
    try {
      if (undoRecord.syncedRemote) {
        const remoteUndone = await trySyncUndoTemplate(undoRecord.undoToken, resolvedEndpoint);
        if (!remoteUndone) {
          setStatusNote('远端模板撤回失败，当前版本保持不变，请稍后重试。');
          return;
        }
      }
      mutationVersionRef.current += 1;
      const currentTemplates = templatesRef.current;
      const restoredList = undoRecord.previous
        ? currentTemplates.map((item) => (item.templateId === undoRecord.templateId ? undoRecord.previous! : item))
        : currentTemplates.filter((item) => item.templateId !== undoRecord.templateId);
      const fallback = undoRecord.previous ?? restoredList[0] ?? builtInStudyMethodTemplates[0]!;

      applySelection(restoredList, fallback);
      setStatusNote(
        undoRecord.previous
          ? `已通过 ${undoRecord.undoToken} 撤回至 v${undoRecord.previous.version}。`
          : `已通过 ${undoRecord.undoToken} 撤回新建模板。`,
      );
      setUndoRecord(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="smt-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="smt-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="smt-head">
          <div className="smt-head-copy">
            <span className="smt-kicker">共创学法模板 · 受控原语编排</span>
            <h2 id={titleId} className="smt-title">选择与编排课堂学法</h2>
            <p className="smt-honesty-note">
              当前版本 <strong>v{draft.version}</strong>
              {draft.replacesVersion !== undefined ? ` · 替代 v${draft.replacesVersion}` : ''} · 修改模板仅生成新版本，绝不改写历史课堂。
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="smt-close"
            aria-label="关闭学法模板抽屉"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="smt-body">
          {undoRecord && (
            <div className="smt-undo-bar" role="status">
              <div className="smt-undo-copy">
                <strong>已保存 v{undoRecord.savedVersion}</strong>
                <code>{undoRecord.undoToken}</code>
              </div>
              <button type="button" className="smt-undo-btn" disabled={saving} onClick={() => void handleUndo()}>
                {undoRecord.previous ? `撤回至 v${undoRecord.previous.version}` : '撤回本次保存'}
              </button>
            </div>
          )}

          {statusNote && <p className="smt-status-note" role="status">{statusNote}</p>}

          <section className="smt-section" aria-label="可用学法模板">
            <div className="smt-section-head">
              <h3>内置与已存模板</h3>
              <div className="smt-step-controls">
                <button
                  type="button"
                  className="smt-ghost-btn"
                  disabled={syncing || saving}
                  onClick={() => void syncFromRemote(true)}
                >
                  {syncing ? '正在同步…' : '同步远端模板'}
                </button>
                <button type="button" className="smt-ghost-btn" onClick={createCustomFork}>
                  + 基于当前新建共创模板
                </button>
              </div>
            </div>
            <div className="smt-template-list" role="radiogroup" aria-label="学法模板列表">
              {templates.map((item) => {
                const active = item.templateId === draft.templateId;
                return (
                  <button
                    key={item.templateId}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`smt-template-card${active ? ' is-active' : ''}`}
                    onClick={() => selectExisting(item)}
                  >
                    <div className="smt-template-card-head">
                      <strong>{item.name}</strong>
                      <span className="smt-version-pill">
                        v{item.version}
                        {item.replacesVersion !== undefined ? ` (←v${item.replacesVersion})` : ''}
                      </span>
                    </div>
                    <p className="smt-template-goal">{item.goal}</p>
                    <div className="smt-step-chain">
                      {item.steps.map((step, idx) => (
                        <span key={step.stepId} className="smt-chain-pill">
                          {idx + 1}. {STUDY_METHOD_STEP_META[step.kind].label}
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="smt-section" aria-label="模板目标与观察要求">
            <h3>模板信息与观察要求</h3>
            <div className="smt-meta-grid">
              <label className="smt-field">
                模板名称
                <input
                  type="text"
                  maxLength={80}
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.currentTarget.value }))}
                  placeholder="例如：先预测 → 构反例 → 独立检查"
                />
              </label>
              <label className="smt-field">
                学科标签（用顿号或逗号分隔）
                <input
                  type="text"
                  maxLength={120}
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.currentTarget.value)}
                  placeholder="例如：通用、数理推理"
                />
              </label>
              <label className="smt-field smt-field--full">
                学法目标
                <textarea
                  rows={2}
                  maxLength={240}
                  value={draft.goal}
                  onChange={(event) => setDraft((prev) => ({ ...prev, goal: event.currentTarget.value }))}
                  placeholder="说明这套学法想解决什么学习瓶颈…"
                />
              </label>
              <label className="smt-field smt-field--full">
                课堂观察要求（每行一条）
                <textarea
                  rows={2}
                  maxLength={400}
                  value={obsInput}
                  onChange={(event) => setObsInput(event.currentTarget.value)}
                  placeholder="每行写一条课堂需记录的观察要点…"
                />
              </label>
            </div>
          </section>

          {!validation.valid && (
            <div className="smt-validation-box" role="alert">
              <strong>保存前需修正以下校验问题：</strong>
              <ul>
                {validation.errors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
              {validation.teachCompanionViolation && (
                <button
                  type="button"
                  className="smt-fix-btn"
                  onClick={() =>
                    addStep('independent_transfer', {
                      title: '独立迁移检验',
                      observationRequired: true,
                      blocksSpoiler: true,
                    })
                  }
                >
                  一键补加「独立迁移检验」
                </button>
              )}
            </div>
          )}

          <section className="smt-section" aria-label="受控步骤编排">
            <div className="smt-section-head">
              <h3>步骤编排（仅支持 10 种受控学法原语）</h3>
              <span className="smt-count-pill">共 {draft.steps.length} 步</span>
            </div>

            <div className="smt-add-row">
              <label className="smt-add-select-label">
                <span className="visually-hidden">选择要添加的步骤原语</span>
                <select
                  value={newStepKind}
                  onChange={(event) => setNewStepKind(event.currentTarget.value as StudyMethodStepKind)}
                >
                  {studyMethodStepKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {STUDY_METHOD_STEP_META[kind].label}（{kind}）
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="smt-add-btn"
                disabled={draft.steps.length >= MAX_STUDY_METHOD_STEPS}
                onClick={() => addStep(newStepKind)}
              >
                + 添加步骤
              </button>
            </div>

            <ol className="smt-steps-list">
              {draft.steps.map((step, index) => (
                <li key={step.stepId} className="smt-step-item">
                  <div className="smt-step-head">
                    <span className="smt-step-index">第 {index + 1} 步</span>
                    <select
                      aria-label={`第 ${index + 1} 步原语类型`}
                      className="smt-step-kind-select"
                      value={step.kind}
                      onChange={(event) => {
                        const kind = event.currentTarget.value as StudyMethodStepKind;
                        const meta = STUDY_METHOD_STEP_META[kind];
                        updateStep(index, {
                          kind,
                          blocksSpoiler: meta.defaultBlocksSpoiler,
                          observationRequired: meta.defaultObservationRequired,
                        });
                      }}
                    >
                      {studyMethodStepKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {STUDY_METHOD_STEP_META[kind].label}
                        </option>
                      ))}
                    </select>
                    <div className="smt-step-controls" role="group" aria-label={`第 ${index + 1} 步顺序与删除操作`}>
                      <button
                        type="button"
                        className="smt-step-ctrl-btn"
                        disabled={index === 0}
                        aria-label={`上移第 ${index + 1} 步`}
                        onClick={() => moveStep(index, -1)}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className="smt-step-ctrl-btn"
                        disabled={index === draft.steps.length - 1}
                        aria-label={`下移第 ${index + 1} 步`}
                        onClick={() => moveStep(index, 1)}
                      >
                        下移
                      </button>
                      <button
                        type="button"
                        className="smt-step-ctrl-btn is-danger"
                        disabled={draft.steps.length <= 1}
                        aria-label={`删除第 ${index + 1} 步`}
                        onClick={() => removeStep(index)}
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="smt-step-fields">
                    <label className="smt-field">
                      步骤标题
                      <input
                        type="text"
                        maxLength={80}
                        value={step.title}
                        onChange={(event) => updateStep(index, { title: event.currentTarget.value })}
                      />
                    </label>
                    <label className="smt-field smt-field--minutes">
                      时长上限（分钟）
                      <input
                        type="number"
                        min={1}
                        max={MAX_STUDY_METHOD_STEP_MINUTES}
                        value={step.maxMinutes ?? ''}
                        onChange={(event) => {
                          const raw = event.currentTarget.value;
                          if (!raw) {
                            clearStepMaxMinutes(index);
                            return;
                          }
                          const num = Number(raw);
                          if (Number.isFinite(num) && num >= 1 && num <= MAX_STUDY_METHOD_STEP_MINUTES) {
                            updateStep(index, { maxMinutes: Math.round(num) });
                          }
                        }}
                      />
                    </label>
                    <label className="smt-field smt-field--full">
                      引导提示语（受控文案）
                      <input
                        type="text"
                        maxLength={200}
                        value={step.promptHint}
                        onChange={(event) => updateStep(index, { promptHint: event.currentTarget.value })}
                      />
                    </label>
                  </div>

                  <div className="smt-step-toggles">
                    <label className="smt-checkbox">
                      <input
                        type="checkbox"
                        checked={step.observationRequired}
                        onChange={(event) => updateStep(index, { observationRequired: event.currentTarget.checked })}
                      />
                      <span>需要记录学习观察（observationRequired）</span>
                    </label>
                    <label className="smt-checkbox">
                      <input
                        type="checkbox"
                        checked={step.blocksSpoiler}
                        onChange={(event) => updateStep(index, { blocksSpoiler: event.currentTarget.checked })}
                      />
                      <span>开启防剧透守卫（blocksSpoiler）</span>
                    </label>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <footer className="smt-foot">
          <button type="button" className="smt-secondary-btn" onClick={onClose}>
            完成并返回开课
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!validation.valid || saving}
            onClick={() => void handleSaveVersion()}
          >
            {saving ? '正在保存新版本…' : '保存为新版本并使用'}
          </button>
        </footer>
      </section>
    </div>
  );
}
