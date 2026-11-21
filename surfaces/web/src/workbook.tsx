import { BankAttachment, BankFeedback, BankFields, BankOrigin, bankSubmission } from './bank-question';
import { fixedLink } from './concept-reading';
import {ResumeScratch, ScratchReentry, useCurrentDraft} from './activity-reentry';
import { useDraftWatermark } from './draft-watermark';
import { bindDeletionWatermark, observedDeletionWatermark, subscribeDeletionWatermark } from './deletion-watermark';
import { enqueue } from './offline-queue';
import { forTask, selectedRoute } from './model-route';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type {
  WorkbookDetail as BaseDetail,
  WorkbookQuestionView as BaseQuestion,
  WorkbookRubricAssessmentView,
  WorkbookSummary,
  WorkbookSourceQuestionRef,
} from '../../../modules/activity/workbook-values.ts';
import { api, ApiError, deletedSubmission, submissionId, remember, remembered, requestId, type Settings } from './api';
import { PageTitle, ReadState, useResource, type Material, type Resource } from './workspace';
import { ExpectedView } from './expected-view';
import { RecordQuestionLink } from './current-record';
import { AttemptResearch } from './research';
import { WorkbookCorrection } from './workbook-correction';
import { observePaperTime } from './workbook-duration';
import { QuestionContext } from './reading-drawer';
import type { ReadingContextEntry } from './paper-reading-capsule';
import { QuestionPresentation, useVisibleDocument, useWorkbookPresentation } from './workbook-presentation';
import { SealedPracticeAuthor } from './sealed-practice';
import { WorkbookAccess } from './workbook-access';
import './workbook.css';

type WorkbookQuestionView = BaseQuestion & { readingContext?: ReadingContextEntry[] };
type WorkbookDetail = Omit<BaseDetail, 'questions' | 'attempts'> & {
  questions: WorkbookQuestionView[];
  attempts: (BaseDetail['attempts'][number] & { paperRev?: number; questions?: WorkbookQuestionView[];
    formalAssessment?: {state: string; score: {earned: number; maximum: number} | null; reason?: string} })[];
};

export type WorkbookProps = {
  modelSettings: Resource<Settings>;
  id?: string;
  materials: Material[];
};

type FeedbackResult = WorkbookDetail['attempts'][number]['feedback'][number]['result'];
const resultLabels: Record<FeedbackResult, string> = {
  correct: '答对',
  incorrect: '答错',
  partial: '部分正确',
  pending: '待批改',
  unanswered: '未作答',
  'self-check': '待自评',
};
const assessmentLabels: Record<WorkbookRubricAssessmentView['verdict'], string> = {
  correct: '答对',
  partial: '部分正确',
  incorrect: '答错',
  pending: '待批改',
};

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function ListPage() {
  const papers = useResource<WorkbookSummary[]>('/papers');
  return (
    <>
      <PageTitle title="我的试卷" meta="保存后即冻结；可反复作答并回看每次反馈" />
      <div className="workbook-list-actions">
        <a className="primary-button" href="/papers/new">
          新建试卷
        </a>
        <a className="tonal-button" href="/materials?view=iqdb">从智能题库选题</a>
        <a className="tonal-button" href="/materials/workspace?kind=question">同伴存入的题目</a>
        <a className="tonal-button" href="/papers/issued">纸面发行与回收</a>
      </div>
      <ReadState resource={papers} />
      {papers.data && (
        <div className="workbook-list">
          {papers.data.map((paper) => (
            <a key={paper.id} className="workbook-card" href={`/papers/${encodeURIComponent(paper.id)}`}>
              <span className="workbook-card-main">
                <strong>{paper.title}</strong>
                <small>
                  {paper.questionCount} 题
                  {paper.sourceTitle ? ` · 来源：${paper.sourceTitle}` : ''}
                  {paper.attemptCount ? ` · 已作答 ${paper.attemptCount} 次` : ''}
                </small>
              </span>
              <span className="workbook-card-meta">
                {paper.lastAttemptAt ? dateLabel(paper.lastAttemptAt) : dateLabel(paper.savedAt)}
              </span>
            </a>
          ))}
          {!papers.data.length && (
            <div className="empty">
              <h2>还没有试卷</h2>
              <p>从任意学科自由组题，保存后可以反复练习。</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

type NumericEditor = {
  kind: 'numeric';
  prompt: string;
  answer: string;
  tolerance: string;
  unit: string;
  explanation: string;
};
type ExactEditor = {
  kind: 'exact';
  prompt: string;
  answerLines: string;
  selfCheck: boolean;
  explanation: string;
};
type RubricEditor = {
  kind: 'rubric';
  prompt: string;
  rubric: string;
  explanation: string;
};
type EditorQuestion = (NumericEditor | ExactEditor | RubricEditor) & {
  sourceQuestionRef?: WorkbookSourceQuestionRef;
};

function QuestionSource({ source, sealedPractice }: { source: WorkbookSourceQuestionRef; sealedPractice?: boolean }) {
  return <p className="workbook-source-note">
    {sealedPractice ? <>引用原题第 {source.rev} 版 · <a href="#question-teaching">管理原题题面权限</a></> : <>
      <a href={fixedLink({v: 1, fact: {...source, type: 'activity.workspaceEntry'}, anchor: {kind: 'question', itemId: 'question'}})}>
        查看引用的第 {source.rev} 版题面
      </a> · <a href={'/materials/records/' + encodeURIComponent(source.id)}>查看当前记录</a>
    </>}
    <br /><small>{source.id}</small>
  </p>;
}
type PaperEditorDraft = {
  requestId: string;
  title: string;
  materialId: string | null;
  questions: EditorQuestion[];
};
type PaperProposal = {
  title?: unknown;
  materialId?: unknown;
  questions?: unknown;
};

function numericQuestion(): NumericEditor {
  return { kind: 'numeric', prompt: '', answer: '', tolerance: '0', unit: '', explanation: '' };
}
function exactQuestion(selfCheck = false): ExactEditor {
  return { kind: 'exact', prompt: '', answerLines: '', selfCheck, explanation: '' };
}
function rubricQuestion(): RubricEditor {
  return { kind: 'rubric', prompt: '', rubric: '', explanation: '' };
}

function emptyDraft(materialId: string | null, material?: Material): PaperEditorDraft {
  return {
    requestId: requestId(),
    title: materialId && material ? material.title : '',
    materialId,
    questions: [],
  };
}

function proposalFromSession(materials: Material[]): PaperEditorDraft | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem('mangekyo:paper-proposal');
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const proposal = JSON.parse(raw) as PaperProposal;
    const questionsValue = proposal.questions;
    if (
      typeof proposal.title !== 'string' ||
      !Array.isArray(questionsValue) ||
      questionsValue.length === 0
    ) {
      return null;
    }
    const materialId =
      typeof proposal.materialId === 'string' && materials.some((material) => material.id === proposal.materialId)
        ? proposal.materialId
        : null;
    const questions: EditorQuestion[] = questionsValue.map((entry, index) => {
      const row = entry as { prompt?: unknown; answer?: unknown; rubric?: unknown; sourceQuestionRef?: WorkbookSourceQuestionRef } | null;
      const prompt = row && typeof row.prompt === 'string' ? row.prompt : '';
      const answer = row && typeof row.answer === 'string' ? row.answer : '';
      if (!prompt) throw new Error(`第 ${index + 1} 道题目缺少题面。`);
      const origin = row?.sourceQuestionRef ? { sourceQuestionRef: row.sourceQuestionRef } : {};
      if (typeof row?.rubric === 'string' && row.rubric.trim()) return { ...rubricQuestion(), ...origin, prompt, rubric: row.rubric, explanation: answer };
      return { ...exactQuestion(true), ...origin, prompt, answerLines: answer };
    });
    return {
      requestId: requestId(),
      title: proposal.title,
      materialId,
      questions,
    };
  } catch {
    return null;
  }
}

function storedEditorDraft(): PaperEditorDraft | null {
  const raw = remembered('paper-draft');
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as PaperEditorDraft;
    if (
      !draft ||
      typeof draft.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(draft.requestId) ||
      typeof draft.title !== 'string' ||
      (draft.materialId !== null && typeof draft.materialId !== 'string') ||
      !Array.isArray(draft.questions) ||
      draft.questions.some((question) => {
        if (
          !question ||
          (question.kind !== 'numeric' && question.kind !== 'exact' && question.kind !== 'rubric')
        ) return true;
        const row = question as Partial<EditorQuestion>;
        return typeof row.prompt !== 'string' || typeof row.explanation !== 'string';
      })
    ) {
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

function AuthorPage({ materials }: { materials: Material[] }) {
  const queryMaterial = new URLSearchParams(location.search).get('material');
  const proposalMode = new URLSearchParams(location.search).get('proposal') === '1';
  const [draft, setDraft] = useState<PaperEditorDraft>(() => {
    const preselected = queryMaterial && materials.some((material) => material.id === queryMaterial)
      ? queryMaterial
      : null;
    const proposal = proposalMode ? proposalFromSession(materials) : null;
    const restored = proposal ?? storedEditorDraft();
    if (restored) {
      return preselected
        ? {
          ...restored,
          materialId: preselected,
          title: restored.title || materials.find((material) => material.id === preselected)?.title || '',
        }
        : restored;
    }
    return emptyDraft(preselected, materials.find((material) => material.id === preselected));
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const usedProposal = useRef(proposalMode);

  useEffect(() => {
    if (!usedProposal.current) return;
    remember('paper-draft', JSON.stringify(draft));
    try {
      sessionStorage.removeItem('mangekyo:paper-proposal');
    } catch {
      // The draft itself is already persisted in local storage.
    }
    usedProposal.current = false;
  }, []);

  useEffect(() => {
    remember('paper-draft', JSON.stringify(draft));
  }, [draft]);

  function updateQuestion(index: number, patch: Partial<EditorQuestion>) {
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((question, i) =>
        i === index ? ({ ...question, ...patch } as EditorQuestion) : question,
      ),
    }));
  }
  function changeKind(index: number, kind: 'numeric' | 'exact' | 'rubric') {
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((question, i) => {
        if (i !== index) return question;
        return kind === 'numeric'
          ? numericQuestion()
          : kind === 'exact'
            ? exactQuestion()
            : rubricQuestion();
      }),
    }));
  }
  function moveQuestion(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const next = [...current.questions];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      const from = next[index];
      const to = next[target];
      if (!from || !to) return current;
      next[index] = to;
      next[target] = from;
      return { ...current, questions: next };
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!draft.title.trim()) {
      setError('请填写试卷标题。');
      return;
    }
    if (draft.questions.length === 0) {
      setError('请至少添加一道题。');
      return;
    }
    try {
      const questions = draft.questions.map((question, index) => {
        if (question.kind === 'numeric') {
          const answer = Number(question.answer);
          const tolerance = Number(question.tolerance);
          if (question.answer.trim() === '' || !Number.isFinite(answer)) {
            throw new Error(`第 ${index + 1} 题需要一个数字答案。`);
          }
          if (question.tolerance.trim() === '' || !Number.isFinite(tolerance) || tolerance < 0) {
            throw new Error(`第 ${index + 1} 题的容差需要是大于等于零的数字。`);
          }
          return {
            kind: 'numeric',
            sourceQuestionRef: question.sourceQuestionRef,
            prompt: question.prompt,
            answer,
            tolerance,
            unit: question.unit.trim() || null,
            explanation: question.explanation,
          };
        }
        if (question.kind === 'rubric') {
          if (!question.rubric.trim()) {
            throw new Error(`第 ${index + 1} 题需要评分标准。`);
          }
          return {
            kind: 'rubric',
            sourceQuestionRef: question.sourceQuestionRef,
            prompt: question.prompt,
            rubric: question.rubric,
            explanation: question.explanation,
          };
        }
        const answers = question.sourceQuestionRef
          ? [question.answerLines]
          : question.answerLines.split('\n').map((line) => line.trim()).filter(Boolean);
        if (answers.length === 0) throw new Error(`第 ${index + 1} 题需要至少一条参考答案。`);
        return {
          kind: 'exact',
          sourceQuestionRef: question.sourceQuestionRef,
          prompt: question.prompt,
          answers,
          selfCheck: question.selfCheck,
          explanation: question.explanation,
        };
      });
      setBusy(true);
      const paper = await api<WorkbookDetail>('/papers', {
        method: 'POST',
        body: {
          requestId: draft.requestId,
          title: draft.title,
          materialId: draft.materialId,
          questions,
        },
      });
      remember('paper-draft', null);
      location.assign('/papers/' + encodeURIComponent(paper.id));
    } catch (error) {
      setError(
        error instanceof ApiError
          ? '保存失败，内容已保留。' + error.message
          : error instanceof Error ? error.message : '保存失败，内容已保留。',
      );
    } finally {
      setBusy(false);
    }
  }

  function submitSave(event: FormEvent) {
    event.preventDefault();
    void save(event);
  }

  return (
    <>
      <a className="back-link" href="/papers">
        ‹ 返回试卷
      </a>
      <PageTitle title="新建试卷" meta="可写任意学科；保存后试卷即冻结，内容不再改动" />
      <SealedPracticeAuthor />
      <form className="workbook-editor" onSubmit={submitSave}>
        <section className="workbook-editor-block">
          <label className="field">
            <span>试卷标题</span>
            <input
              autoFocus
              disabled={busy}
              maxLength={240}
              required
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label className="field">
            <span>来源材料（可选）</span>
            <select
              disabled={busy}
              value={draft.materialId ?? ''}
              onChange={(event) => setDraft({ ...draft, materialId: event.target.value || null })}
            >
              <option value="">不关联材料</option>
              {materials.map((material) => (
                <option key={material.id} value={material.id}>
                  {material.title}
                </option>
              ))}
            </select>
          </label>
          {draft.materialId && (
            <p className="workbook-source-note">
              来源将保存为链接：<a href={`/materials/saved/${encodeURIComponent(draft.materialId)}`}>打开原文</a>
            </p>
          )}
          <p className="field-help">数值题按容差判断；精确题只按文字精确比对。自评题只展示参考答案，不替你判断等价表述。</p>
          <p className="field-help">评分标准题保存你写下的标准。交卷只记为待批改；之后可逐题明确确认，把该题题面、作答和标准发送给已配置的模型批改。</p>
        </section>
        <section className="workbook-editor-block">
          <div className="subhead">
            <h2>题目</h2>
            <span className="workbook-count">{draft.questions.length} 题</span>
          </div>
          {draft.questions.length === 0 && <p className="workbook-empty-inline">先添加第一道题。</p>}
          {draft.questions.map((question, index) => (
            <article key={index} className="workbook-editor-question">
              <header className="workbook-question-head">
                <span>第 {index + 1} 题</span>
                <div className="workbook-question-actions">
                  <button type="button" className="text-button" disabled={index === 0} onClick={() => moveQuestion(index, -1)}>
                    上移
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={index === draft.questions.length - 1}
                    onClick={() => moveQuestion(index, 1)}
                  >
                    下移
                  </button>
                  <button type="button" className="text-button" disabled={busy} onClick={() => {
                    setDraft((current) => ({ ...current, questions: current.questions.filter((_, i) => i !== index) }));
                  }}>
                    删除
                  </button>
                </div>
              </header>
              {question.sourceQuestionRef && <>
                <QuestionSource source={question.sourceQuestionRef} />
                <button type="button" className="text-button" disabled={busy} onClick={() => {
                  setDraft(current => ({ ...current, questions: current.questions.map((item, i) => {
                    if (i !== index) return item;
                    const { sourceQuestionRef, ...copy } = item;
                    return copy;
                  }) }));
                }}>解除引用，转为可编辑副本</button>
              </>}
              <label className="field">
                <span>题型</span>
                <select
                  disabled={busy || !!question.sourceQuestionRef}
                  value={question.kind}
                  onChange={(event) => changeKind(index, event.target.value as 'numeric' | 'exact')}
                >
                  <option value="numeric">数值（带容差）</option>
                  <option value="exact">精确答案</option>
                  <option value="rubric">评分标准</option>
                </select>
              </label>
              <label className="field">
                <span>题面</span>
                <textarea
                  disabled={busy || !!question.sourceQuestionRef}
                  maxLength={4000}
                  required
                  rows={question.kind === 'numeric' ? 3 : 4}
                  value={question.prompt}
                  onChange={(event) => updateQuestion(index, { prompt: event.target.value })}
                />
              </label>
              {question.kind === 'numeric' ? (
                <div className="workbook-fields">
                  <label className="field">
                    <span>答案</span>
                    <input
                      disabled={busy || !!question.sourceQuestionRef}
                      inputMode="decimal"
                      value={question.answer}
                      onChange={(event) => updateQuestion(index, { answer: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>容差</span>
                    <input
                      disabled={busy || !!question.sourceQuestionRef}
                      inputMode="decimal"
                      value={question.tolerance}
                      onChange={(event) => updateQuestion(index, { tolerance: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>单位（可选）</span>
                    <input
                      disabled={busy || !!question.sourceQuestionRef}
                      maxLength={40}
                      value={question.unit}
                      onChange={(event) => updateQuestion(index, { unit: event.target.value })}
                    />
                  </label>
                </div>
              ) : question.kind === 'rubric' ? (
                <label className="field">
                  <span>评分标准（只发送本标准和这道题的作答）</span>
                  <textarea
                    disabled={busy || !!question.sourceQuestionRef}
                    maxLength={8000}
                    required
                    rows={6}
                    value={question.rubric}
                    onChange={(event) => updateQuestion(index, { rubric: event.target.value })}
                  />
                </label>
              ) : (
                <>
                  <label className="field">
                    <span>{question.sourceQuestionRef ? '原题参考答案' : '参考答案（每行一条）'}</span>
                    <textarea
                      disabled={busy || !!question.sourceQuestionRef}
                      maxLength={5000}
                      rows={3}
                      value={question.answerLines}
                      onChange={(event) => updateQuestion(index, { answerLines: event.target.value })}
                    />
                  </label>
                  <label className="workbook-check">
                    <input
                      type="checkbox"
                      disabled={busy || !!question.sourceQuestionRef}
                      checked={question.selfCheck}
                      onChange={(event) => updateQuestion(index, { selfCheck: event.target.checked })}
                    />
                    <span>自评题：交卷后只展示参考答案，由你自己判断，系统不做语义判分</span>
                  </label>
                </>
              )}
              <label className="field">
                <span>解析（交卷后展示）</span>
                <textarea
                  disabled={busy || !!question.sourceQuestionRef}
                  maxLength={4000}
                  rows={2}
                  value={question.explanation}
                  onChange={(event) => updateQuestion(index, { explanation: event.target.value })}
                />
              </label>
            </article>
          ))}
          <div className="workbook-add-row">
            <button
              type="button"
              className="tonal-button"
              disabled={busy}
              onClick={() => setDraft((current) => ({ ...current, questions: [...current.questions, numericQuestion()] }))}
            >
              添加数值题
            </button>
            <button
              type="button"
              className="tonal-button"
              disabled={busy}
              onClick={() => setDraft((current) => ({ ...current, questions: [...current.questions, exactQuestion()] }))}
            >
              添加精确题
            </button>
            <button
              type="button"
              className="tonal-button"
              disabled={busy}
              onClick={() => setDraft((current) => ({ ...current, questions: [...current.questions, rubricQuestion()] }))}
            >
              添加评分标准题
            </button>
          </div>
        </section>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="workbook-editor-actions">
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              const next = emptyDraft(null);
              remember('paper-draft', null);
              setDraft(next);
            }}
          >
            清空重写
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !draft.title.trim() || draft.questions.length === 0}
          >
            {busy ? '保存中…' : '保存并冻结试卷'}
          </button>
        </div>
      </form>
    </>
  );
}

type AttemptDraft = {
  version: string;
  requestId: string;
  answers: Record<string, string>;
  focusIds: string[];
  scratch?: Record<string,string>;
  // Presence means a local bookmark. The value is this tab's effective item time when marked.
  bookmarks?: Record<string, number>;
  currentItem?: string;
  paperRev?: number;
};

function attemptDraftKey(paperId: string) {
  return `workbook:paper:${paperId}:draft`;
}
function restoreAttemptDraft(paperId: string): AttemptDraft | null {
  const raw = remembered(attemptDraftKey(paperId));
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw) as AttemptDraft;
    if (
      !draft ||
      draft.version !== paperId ||
      typeof draft.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(draft.requestId) ||
      !draft.answers ||
      typeof draft.answers !== 'object' ||
      Array.isArray(draft.answers) ||
      Object.values(draft.answers).some((value) => typeof value !== 'string') ||
      (draft.scratch !== undefined && (!draft.scratch || typeof draft.scratch !== 'object' ||
        Array.isArray(draft.scratch) || Object.values(draft.scratch).some(value => typeof value !== 'string'))) ||
      !Array.isArray(draft.focusIds) ||
      draft.focusIds.some((id) => typeof id !== 'string')
    ) {
      return null;
    }
    if (draft.bookmarks !== undefined && (!draft.bookmarks || typeof draft.bookmarks !== 'object' || Array.isArray(draft.bookmarks) ||
        Object.values(draft.bookmarks).some(ms => !Number.isSafeInteger(ms) || ms < 0 || ms > 86_400_000))) {
      delete draft.bookmarks;
    }
    return draft;
  } catch {
    return null;
  }
}

// A delayed receipt or stale tab must never clear the next sitting's draft.
function retireAttemptDraft(paperId: string, requestId: string) {
  const stored = restoreAttemptDraft(paperId);
  if (stored && stored.requestId !== requestId) return stored;
  remember(attemptDraftKey(paperId), null);
  return null;
}


function selfCheckKey(paperId: string, attemptId: string, questionId: string) {
  return `workbook-selfcheck:${paperId}:${attemptId}:${questionId}`;
}

function SelfCheckMarks({
  paperId,
  attemptId,
  questionId,
}: {
  paperId: string;
  attemptId: string;
  questionId: string;
}) {
  const [mark, setMark] = useState<'yes' | 'no' | null>(() => {
    const stored = remembered(selfCheckKey(paperId, attemptId, questionId));
    return stored === 'yes' || stored === 'no' ? stored : null;
  });
  function choose(next: 'yes' | 'no') {
    setMark(next);
    remember(selfCheckKey(paperId, attemptId, questionId), next);
  }
  return (
    <div className="workbook-selfcheck">
      <button type="button" className={`${mark === 'yes' ? 'primary-button' : 'tonal-button'} workbook-mini-button`} onClick={() => choose('yes')}>
        我答对了
      </button>
      <button type="button" className={`${mark === 'no' ? 'primary-button' : 'tonal-button'} workbook-mini-button`} onClick={() => choose('no')}>
        我没对
      </button>
      <span className="workbook-selfcheck-note">本地自评，只影响这次查看，不进入系统判分。</span>
    </div>
  );
}

function FeedbackItem({
  paperId,
  attemptId,
  question,
  feedback,
  showFeedback,
  assessments,
  onAssess,
  allowSearch,
  destination,
  assessing,
  sealedPractice,
  correction,
}: {
  paperId: string;
  attemptId: string;
  question: WorkbookQuestionView;
  showFeedback: boolean;
  feedback: WorkbookDetail['attempts'][number]['feedback'][number];
  assessments: WorkbookRubricAssessmentView[];
  onAssess: (questionId: string, query?: string) => void;
  allowSearch: boolean;
  destination: string;
  assessing: string | null;
  sealedPractice: boolean;
  correction?: { attemptRev: number; recorded: boolean } | undefined;
}) {
  const [query, setQuery] = useState('');
  const assessment = assessments.at(-1);
  const shownResult = showFeedback ? assessment?.verdict ?? feedback.result : undefined;
  const className = shownResult === 'correct'
    ? 'workbook-result-correct'
    : shownResult === 'incorrect'
      ? 'workbook-result-incorrect'
      : 'workbook-result-muted';
  return (
    <article className={`workbook-feedback-item ${className}`}>
      <header className="workbook-feedback-head">
        {showFeedback && <span>{assessment ? assessmentLabels[assessment.verdict] : resultLabels[feedback.result]}</span>}
        <span className="workbook-feedback-question">{question.prompt}</span>
      </header>
      <QuestionContext itemId={question.id} historical readingContext={question.readingContext} source={sealedPractice || question.kind === 'bank' ? undefined : question.sourceQuestionRef}
        referencesAllowed={showFeedback} previous={feedback.answer !== null && <p>我的作答 · {String(feedback.answer)}</p>} />
      {question.kind === 'bank' && <BankOrigin source={question.sourceQuestionRef}/>}
      {showFeedback && <>
        {sealedPractice && question.sourceQuestionRef && <QuestionSource source={question.sourceQuestionRef} sealedPractice />}
      {feedback.result === 'self-check' && (
        <SelfCheckMarks paperId={paperId} attemptId={attemptId} questionId={feedback.questionId} />
      )}
      {question.kind === 'bank' && feedback.answer !== null && <BankFeedback question={question} answer={String(feedback.answer)}/>}
      {question.kind !== 'bank' && feedback.answer !== null && (
        <p className="workbook-answer">
          你的作答：<code>{String(feedback.answer)}</code>
        </p>
      )}
      {feedback.expected && <p className="workbook-expected"><ExpectedView expected={feedback.expected} /></p>}
      {feedback.explanation && <p className="workbook-explanation">{feedback.explanation}</p>}
      {correction &&
        <WorkbookCorrection key={attemptId + ':' + correction.attemptRev} paperId={paperId} attemptId={attemptId}
          attemptRev={correction.attemptRev} itemId={question.id} recorded={correction.recorded} />}
      {question.kind === 'rubric' && feedback.answer !== null && (
        <section className="workbook-rubric-assessment">
          {assessment ? (
            <>
              <dl>
                {assessment.score && <div><dt>得分</dt><dd>{assessment.score.earned} / {assessment.score.maximum}</dd></div>}
                <div><dt>批改说明</dt><dd>{assessment.feedback}</dd></div>
                <div>
                  <dt>依据</dt>
                  <dd>
                    {assessment.evidence.length
                      ? <ul>{assessment.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul>
                      : '没有额外依据。'}
                  </dd>
                </div>
                <div>
                  <dt>工具轨迹</dt>
                  <dd>{assessment.trace.length ? assessment.trace.join(' · ') : '本次未使用工具。'}</dd>
                </div>
                <div><dt>版本</dt><dd>{assessment.rubricVersion} · {assessment.assessedAt.slice(0, 10)}</dd></div>
                {assessment.requestedModel && <div><dt>请求模型</dt><dd>{assessment.requestedModel}</dd></div>}
                {assessment.reportedModel && <div><dt>服务返回的模型</dt><dd>{assessment.reportedModel}</dd></div>}
              </dl>
              <p className="workbook-selfcheck-note">这次批改已随本次作答保存。</p>
            </>
          ) : (
            <p className="workbook-selfcheck-note">
              交卷时没有发送给模型。批改会把<strong>这道题的题面、你的作答和评分标准</strong>发送给 {destination}；原答保存在这次练习里。
            </p>
          )}
          {allowSearch && (!assessment || assessment.verdict === 'pending') && <label className="field"><span>允许 Exa 检索的公开主题（可留空）</span>
            <input value={query} maxLength={400} onChange={e => setQuery(e.target.value)} placeholder="例如日食的形成条件" /></label>}
          {assessing === question.id && <p role="status">正在请模型按评分标准批改…</p>}
          <button
            type="button"
            className="tonal-button workbook-mini-button"
            disabled={assessing !== null || (assessment !== undefined && assessment.verdict !== 'pending')}
            onClick={() => onAssess(question.id, query.trim())}
          >
            {assessing === question.id ? '批改中…' : assessment?.verdict === 'pending' ? '重新评阅' : assessment ? '已归档批改' : '发送本题并批改'}
          </button>
        </section>
      )}
      </>}
    </article>
  );
}

function durationLabel(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (!seconds) return '不足 1 秒';
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function PaperDetail({ paperId, materials, modelSettings }: { paperId: string; materials: Material[]; modelSettings: Resource<Settings> }) {
  const foreground = useVisibleDocument();
  const watermark = useDraftWatermark(foreground);
  const deletionGeneration = useSyncExternalStore(subscribeDeletionWatermark, observedDeletionWatermark);
  const openedGeneration = useRef(deletionGeneration);
  const [view, setView] = useState<WorkbookDetail | null>(null);
  const [draft, setDraft] = useState<AttemptDraft | null>(() => restoreAttemptDraft(paperId));
  const currentGeneration = useCurrentDraft(draft?.requestId);
  const [coveredItem, coverItem] = useState<string | null>(null);
  const [selectedAttemptId, setAttemptId] = useState(() => new URLSearchParams(location.search).get('attempt'));
  const [assessing, setAssessing] = useState<string | null>(null);
  const settings = modelSettings.data && forTask(modelSettings.data, 'assessment');
  const settingsError = modelSettings.error ? '无法读取模型设置。' : '';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const unsaved = useRef<AttemptDraft | null>(null);
  function saveDraft(next: AttemptDraft) {
    const key = attemptDraftKey(paperId);
    const raw = JSON.stringify(next);
    remember(key, raw);
    unsaved.current = remembered(key) === raw ? null : next;
    if (unsaved.current) setError('本机存储写入失败，当前作答和书签仅保留在此页。');
    setDraft(next);
  }

  // A second tab may edit this sitting, start a redo, or complete it.
  useEffect(() => {
    function synchronize(event: StorageEvent) {
      if (event.storageArea !== localStorage || event.key !== 'mangekyo:' + attemptDraftKey(paperId)) return;
      const stored = restoreAttemptDraft(paperId);
      setDraft(stored);
      if (stored?.requestId !== draft?.requestId) {
        setView(null);
        coverItem(null);
        setReload(value => value + 1);
      }
    }
    window.addEventListener('storage', synchronize);
    return () => window.removeEventListener('storage', synchronize);
  }, [paperId, draft?.requestId]);

  const justSubmitted = useRef(false);
  const feedbackHeading = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!foreground) {setView(null); return;}
    const controller = new AbortController();
    setView(null);
    setError('');
    api<WorkbookDetail>(`/papers/${encodeURIComponent(paperId)}`, { signal: controller.signal, cache: 'no-store' })
      .then((result) => {
        if (!controller.signal.aborted && observedDeletionWatermark() === deletionGeneration) setView(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('试卷载入失败。请重试。');
      });
    return () => controller.abort();
  }, [foreground, paperId, reload, deletionGeneration]);

  useEffect(() => {
    if (!view || !draft) return;
    const submitted = view.attempts.find((attempt) => attempt.requestId === draft.requestId);
    if (submitted) setDraft(retireAttemptDraft(paperId, draft.requestId));
  }, [view, draft, paperId]);

  useEffect(() => {
    if (!watermark.ready || !view || draft || view.attempts.length > 0) return;
    const next: AttemptDraft = {
      version: paperId,
      ...(view?.revision !== undefined && {paperRev: view.revision}),
      requestId: submissionId(),
      answers: {},
      focusIds: [],
    };
    saveDraft(next);
  }, [view, draft, paperId, watermark.ready]);

  useEffect(() => {
    if (justSubmitted.current && view) {
      feedbackHeading.current?.focus();
      justSubmitted.current = false;
    }
  }, [view]);

  const attempts = view?.attempts ?? [];
  const activeAttempt = selectedAttemptId
    ? attempts.find((attempt) => attempt.id === selectedAttemptId) ?? attempts[0]
    : attempts[0];
  const visibleQuestions = view
    ? draft?.focusIds.length
      ? view.questions.filter((question) => draft.focusIds.includes(question.id))
      : view.questions
    : [];
  const wrongQuestionIds = activeAttempt
    ? activeAttempt.feedback
        .filter((feedback) =>
          feedback.result === 'incorrect' || feedback.result === 'partial' ||
          (activeAttempt.assessments ?? []).some(
            (assessment) =>
              assessment.questionId === feedback.questionId &&
              (assessment.verdict === 'incorrect' || assessment.verdict === 'partial'),
          ),
        )
        .map((feedback) => feedback.questionId)
    : [];
  const showForm = Boolean(draft) || attempts.length === 0;
  const answerDisabled = busy || !draft || !watermark.ready || !currentGeneration;

  const revision = view?.id === paperId ? view.revision : undefined;
  const frozenQuestions = activeAttempt?.questions;
  const reviewQuestions = frozenQuestions ?? view?.questions ?? [];
  const feedback = (activeAttempt?.feedback ?? []).filter(item => reviewQuestions.some(q => q.id === item.questionId));
  const reviewItems = feedback.map(item => item.questionId);
  const questions = useWorkbookPresentation(paperId, revision, [
    ...(showForm ? visibleQuestions.map(q => q.id) : []), ...(frozenQuestions ? [] : reviewItems),
  ]);
  const reviewRevision = frozenQuestions ? (view?.id === paperId ? activeAttempt.paperRev : undefined) : revision;
  const historical = useWorkbookPresentation(paperId, reviewRevision,
    frozenQuestions && questions.allowed ? reviewItems : [],
    activeAttempt && {kind: 'question', attempt: activeAttempt});
  const reviewAllowed = questions.allowed && historical.allowed;
  const solutions = useWorkbookPresentation(paperId, reviewRevision, reviewAllowed
    ? feedback.filter(item => item.expected && item.expected.kind !== 'rubric').map(item => item.questionId) : [],
    activeAttempt && {kind: 'solution', attempt: activeAttempt});

  const form = useRef<HTMLFormElement>(null);
  const clock = useRef<ReturnType<typeof observePaperTime> | null>(null);
  const draftAvailable = watermark.ready && currentGeneration && draft && (draft.paperRev ?? 1) === revision;
  const timingId = questions.allowed && draftAvailable && view && !attempts.some((attempt) => attempt.requestId === draft.requestId)
    ? draft.requestId : null;
  useEffect(() => {
    if (!timingId || !form.current) return;
    const observation = observePaperTime(form.current, paperId, timingId);
    clock.current = observation;
    return () => {
      observation.stop();
      clock.current = null;
    };
  }, [paperId, timingId]);

  function currentStoredDraft() {
    if (!timingId || answerDisabled || revision === undefined) return null;
    try {
      if (bindDeletionWatermark(timingId) !== observedDeletionWatermark()) return null;
    } catch {
      return null;
    }
    const stored = restoreAttemptDraft(paperId);
    const pending = unsaved.current;
    if (pending?.requestId === timingId && (!stored || stored.requestId === timingId)) return pending;
    return stored?.requestId === timingId && (stored.paperRev ?? 1) === revision ? stored : null;
  }

  const markedQuestions = visibleQuestions.filter(q => Object.hasOwn(draft?.bookmarks ?? {}, q.id));
  function goToItem(id?: string) {
    document.getElementById(id ? 'workbook-item-' + id : 'workbook-submit-actions')?.focus();
  }
  function toggleBookmark(index: number) {
    const stored = currentStoredDraft();
    const question = visibleQuestions[index];
    if (!stored || !question || coveredItem || !clock.current) return;
    const bookmarks = {...stored.bookmarks};
    const wasMarked = Object.hasOwn(draft?.bookmarks ?? {}, question.id);
    if (wasMarked) delete bookmarks[question.id];
    else bookmarks[question.id] ??= clock.current.itemElapsed(question.id);
    const next = {...stored, bookmarks};
    saveDraft(next);
    if (!wasMarked) goToItem(visibleQuestions[index + 1]?.id);
    else {
      const remaining = visibleQuestions.filter(q => Object.hasOwn(bookmarks, q.id));
      goToItem(visibleQuestions.slice(index + 1).find(q => Object.hasOwn(bookmarks, q.id))?.id ?? remaining[0]?.id);
    }
  }

  function changeAnswer(questionId: string, value: string, field: 'answers'|'scratch' = 'answers') {
    const stored = currentStoredDraft();
    if (!stored || revision === undefined || (coveredItem && coveredItem !== questionId)) return;
    const next = { ...stored, currentItem: questionId, paperRev: revision, [field]: { ...stored[field], [questionId]: value } };
    saveDraft(next);
  }

  function setSelectedAttemptId(id: string | null) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('attempt', id);
    else url.searchParams.delete('attempt');
    history.replaceState(history.state, '', url);
    setAttemptId(id);
  }

  function startRedo(focus: 'wrong' | 'full') {
    const next: AttemptDraft = {
      version: paperId,
      ...(view?.revision !== undefined && {paperRev: view.revision}),
      requestId: submissionId(),
      answers: {},
      focusIds: focus === 'wrong' ? wrongQuestionIds : [],
    };
    coverItem(null);
    saveDraft(next);
    setSelectedAttemptId(null);
    setError('');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const submittingDraft = currentStoredDraft();
    if (!view || !submittingDraft || coveredItem) return;
    const answers: Record<string, string | null> = {};
    for (const question of visibleQuestions) {
      const value = submittingDraft.answers[question.id]?.trim();
      try {
        answers[question.id] = question.kind === 'bank' ? bankSubmission(question, value ?? '') : value || null;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : '请核对本题作答。');
        return;
      }
    }
    if (!Object.values(answers).some((value) => value !== null)) {
      setError('请至少作答一题再交卷。');
      return;
    }
    setBusy(true);
    setError('');
    if (!navigator.onLine) {
      void enqueue({kind:'paper',id:submittingDraft.requestId,paperId,answers,effectiveDurationMs:clock.current?.submit()})
        .then(() => {
          setDraft(retireAttemptDraft(paperId, submittingDraft.requestId));
          setError('已保存，待联机判分。');
        })
        .catch(() => {clock.current?.resume(); setError('无法存入待发队列，草稿仍在。');})
        .finally(() => setBusy(false));
      return;
    }
    api<WorkbookDetail>(`/papers/${encodeURIComponent(paperId)}/attempts`, {
      method: 'POST',
      body: { requestId: submittingDraft.requestId, answers, effectiveDurationMs: clock.current?.submit() },
    })
      .then((next) => {
        setDraft(retireAttemptDraft(paperId, submittingDraft.requestId));
        setView(next);
        setSelectedAttemptId(next.attempts[0]?.id ?? null);
        justSubmitted.current = true;
      })
      .catch((error: unknown) => {
        if (deletedSubmission(error)) {
          setDraft(retireAttemptDraft(paperId, submittingDraft.requestId));
          setError('删除状态已变化，旧作答已清除。请重新作答。');
          return;
        }
        clock.current?.resume();
        setError(
          error instanceof ApiError
            ? '交卷没有完成。内容仍保存在本地，可直接再试。'
            : error instanceof Error ? error.message : '交卷失败，内容仍保存在本地。',
        );
      })
      .finally(() => setBusy(false));
  }

  function assessRubric(questionId: string, publicSearchQuery?: string) {
    if (!view || !activeAttempt || !settings || assessing) return;
    setError('');
    setAssessing(questionId);
    api<WorkbookDetail>(
      `/papers/${encodeURIComponent(paperId)}/attempts/${encodeURIComponent(activeAttempt.id)}/assessments`,
      {
        method: 'POST',
        body: {
          requestId: requestId(),
          questionId,
          consent: 'send-question-answer-rubric',
          ...(publicSearchQuery ? {publicSearchQuery} : {}),
          providerBaseUrl: settings.baseUrl, route: selectedRoute(settings),
        },
      },
    )
      .then((next) => setView(next))
      .catch((error: unknown) => {
        setError(
          error instanceof ApiError
            ? error.message
            : error instanceof Error ? error.message : '批改没有完成。',
        );
      })
      .finally(() => setAssessing(null));
  }

  if (error && !view) {
    return (
      <>
        <a className="back-link" href="/papers">‹ 返回试卷</a>
        <p className="error-text" role="alert">
          {error}
          <button className="text-button" onClick={() => setReload((value) => value + 1)}>重试</button>
        </p>
      </>
    );
  }
  if (!view) return <p className="muted" role="status">正在读取试卷…</p>;

  if (!questions.allowed) return <p role="status">{questions.error ?? '正在确认试卷展示许可…'}
    {questions.error && <button onClick={questions.retry}>重试</button>}</p>;

  if (draft && !draftAvailable) {
    return <section>{watermark.notice}{watermark.ready && <>
      <p>草稿对应的试卷版本或删除水位已变化。</p>
      <button type="button" onClick={() => {setDraft(retireAttemptDraft(paperId, draft.requestId)); coverItem(null);}}>清除旧草稿并重新打开</button>
    </>}</section>;
  }

  return (
    <>
      {questions.error && <p role="alert">{questions.error} <button onClick={questions.retry}>重试</button></p>}
      <a className="back-link" href="/papers">‹ 返回试卷</a>
      <PageTitle
        title={view.title}
        meta={`个人试卷 · ${dateLabel(view.savedAt)} · ${view.questions.length} 题`}
      />
      {openedGeneration.current !== deletionGeneration && <p role="alert">删除状态已变化，已重新读取试卷。</p>}
      {timingId && draft?.currentItem && draft.paperRev === revision && !coveredItem &&
        visibleQuestions.some(q => q.id === draft.currentItem) && <ScratchReentry
          slot={'paper:' + paperId} binding={JSON.stringify([paperId,revision,timingId])} itemId={draft.currentItem}
          label={`上次停在第 ${view.questions.findIndex(q => q.id === draft.currentItem) + 1} 题`}
          cover={coverItem} scratch={draft.scratch?.[draft.currentItem]}/>}
      {view.source && (
        <section className="workbook-source">
          <div>
            <small>来源材料</small>
            <p>{view.source.available ? view.source.title : '来源材料当前不可读取。'}</p>
          </div>
          {view.source.available && (
            <a className="tonal-button" href={`/materials/saved/${encodeURIComponent(view.source.id)}`}>
              打开原文
            </a>
          )}
        </section>
      )}
      {view.sealedPractice && <WorkbookAccess key={paperId} paperId={paperId} />}
      <div className="workbook-detail-grid">
        {watermark.notice}
        {showForm && (
          <section className="workbook-attempt-panel">
            <div className="subhead">
              <h2>{draft?.focusIds.length ? `只重做错题（${draft.focusIds.length} 题）` : '作答'}</h2>
              <span className="workbook-count">已答 {visibleQuestions.filter((question) => draft?.answers[question.id]?.trim()).length} / {visibleQuestions.length}</span>
            </div>
            {!!draft?.focusIds.length && <p className="workbook-focus-note">其余题目这次会记为未作答，不影响试卷冻结内容。</p>}
            <QuestionPresentation value={questions.questionPermit}>
            <form ref={form} onSubmit={(event) => void submit(event)}>
              {timingId && <nav className="workbook-question-nav" aria-label="卷面题号">
                {visibleQuestions.map(q => {
                  const number = view.questions.indexOf(q) + 1;
                  const marked = Object.hasOwn(draft?.bookmarks ?? {}, q.id);
                  return <button key={q.id} type="button" disabled={answerDisabled || !!coveredItem}
                    aria-label={`第 ${number} 题${marked ? '，已挂书签' : ''}`}
                    className="workbook-number" onClick={() => goToItem(q.id)}>
                    {number}{marked && <span aria-hidden="true"> ●</span>}
                  </button>;
                })}
              </nav>}
              {visibleQuestions.map((question, index) => (
                <article key={question.id} className="workbook-answer-item" id={'workbook-item-' + question.id}
                  tabIndex={-1} aria-label={`第 ${view.questions.indexOf(question) + 1} 题`}
                  data-workbook-thought-anchor={timingId && questions.questionPermit ? paperId : undefined}
                  data-draft-request-id={timingId ?? undefined}
                  data-paper-rev={revision} data-item-id={question.id} onFocusCapture={() => {
                  if (!draft || answerDisabled || coveredItem || draft.currentItem === question.id || revision === undefined) return;
                  const stored = currentStoredDraft();
                  if (!stored) return;
                  const next = {...stored, currentItem: question.id, paperRev: revision};
                  saveDraft(next);
                }}>
                  <header className="workbook-answer-head">
                    <span>
                      第 {view.questions.findIndex((item) => item.id === question.id) + 1} 题 ·{' '}
                      {question.kind === 'numeric'
                        ? '数值题'
                        : question.kind === 'exact'
                          ? '精确题'
                          : question.kind === 'bank' ? '题库题' : '评分标准题'}
                    </span>
                    {timingId && <button type="button" className="text-button workbook-mini-button"
                      disabled={answerDisabled || !!coveredItem} onClick={() => toggleBookmark(index)}>
                      {Object.hasOwn(draft?.bookmarks ?? {}, question.id) ? '完成回看，移除书签'
                        : index + 1 < visibleQuestions.length ? '挂书签，做下一题' : '挂书签，去交卷栏'}
                    </button>}
                    {draft?.bookmarks?.[question.id] !== undefined && <small>
                      本机书签 · 挂签时本标签页有效停留 {durationLabel(draft.bookmarks[question.id]!)}
                    </small>}
                  </header>
                  <QuestionContext itemId={question.id} readingContext={question.readingContext} source={view.sealedPractice || question.kind === 'bank' ? undefined : question.sourceQuestionRef} />
                  {question.kind === 'bank' && <BankOrigin source={question.sourceQuestionRef}/>}
                  {view.sealedPractice && question.sourceQuestionRef && <QuestionSource source={question.sourceQuestionRef} sealedPractice />}
                  <p className="workbook-answer-prompt">{question.prompt}</p>
                  {question.kind === 'bank' && <BankAttachment question={question} paperId={paperId}/>}
                  <ResumeScratch itemId={question.id} value={draft?.scratch?.[question.id] ?? ''} disabled={answerDisabled}
                    covered={coveredItem === question.id} finish={() => coverItem(null)}
                    change={value => changeAnswer(question.id,value,'scratch')}>
                  {question.kind === 'bank' ? <BankFields question={question} raw={draft?.answers[question.id] ?? ''}
                    disabled={answerDisabled} change={value => changeAnswer(question.id, value)}/> : question.kind === 'numeric' ? (
                    <label className="field">
                      <span>{question.unit ? `${question.unit}（数字）` : '数字答案'}</span>
                      <input
                        disabled={answerDisabled}
                        inputMode="decimal"
                        value={draft?.answers[question.id] ?? ''}
                        onChange={(event) => changeAnswer(question.id, event.currentTarget.value)}
                      />
                    </label>
                  ) : question.kind === 'rubric' ? (
                    <label className="field">
                      <span>文字作答（交卷后可按评分标准批改）</span>
                      <textarea
                        disabled={answerDisabled}
                        maxLength={4000}
                        rows={4}
                        value={draft?.answers[question.id] ?? ''}
                        onChange={(event) => changeAnswer(question.id, event.currentTarget.value)}
                      />
                    </label>
                  ) : (
                    <label className="field">
                      <span>{question.selfCheck ? '自评：写下你的答案，交卷后对照参考' : '文字答案'}</span>
                      <textarea
                        disabled={answerDisabled}
                        maxLength={4000}
                        rows={3}
                        value={draft?.answers[question.id] ?? ''}
                        onChange={(event) => changeAnswer(question.id, event.currentTarget.value)}
                      />
                    </label>
                  )}
                  </ResumeScratch>
                </article>
              ))}
              {error && (
                <p className="error-text" role="alert">{error}</p>
              )}
              <div className="workbook-attempt-actions" id="workbook-submit-actions" tabIndex={-1} role="group" aria-label="交卷栏">
                {markedQuestions.length > 0 && <>
                  <span>还有 {markedQuestions.length} 道回马枪题</span>
                  <button type="button" className="tonal-button" disabled={answerDisabled || !!coveredItem}
                    onClick={() => goToItem(markedQuestions[0]?.id)}>逐题回看</button>
                </>}
                <button type="button" className="text-button" disabled={busy || (!watermark.ready && !view.attempts.length)} onClick={() => {
                  coverItem(null);
                  if (view.attempts.length === 0) {
                    const next: AttemptDraft = {
                      version: paperId,
                      ...(view?.revision !== undefined && {paperRev: view.revision}),
                      requestId: submissionId(),
                      answers: {},
                      focusIds: [],
                    };
                    saveDraft(next);
                  } else {
                    remember(attemptDraftKey(paperId), null);
                    setDraft(null);
                  }
                }}>
                  清空草稿
                </button>
                <button type="submit" className="primary-button" disabled={busy || !!coveredItem || !visibleQuestions.some((question) => draft?.answers[question.id]?.trim())}>
                  {busy ? '交卷中…' : markedQuestions.length ? '直接交卷' : '交卷并查看反馈'}
                </button>
              </div>
            </form>
            </QuestionPresentation>
          </section>
        )}
        {activeAttempt && (
          <section className="workbook-review-panel">
            <div className="workbook-review-head" ref={feedbackHeading} tabIndex={-1}>
              <div>
                <h2>本次反馈</h2>
                {activeAttempt.formalAssessment?.score && <p>整卷得分 {activeAttempt.formalAssessment.score.earned} / {activeAttempt.formalAssessment.score.maximum}</p>}
                {activeAttempt.formalAssessment?.state === 'queued' && <button className="text-button" onClick={() => setReload(n => n + 1)}>刷新批改进度</button>}
                {activeAttempt.formalAssessment?.reason && <p role="status">{activeAttempt.formalAssessment.reason}</p>}
                <p className="muted">
                  {dateLabel(activeAttempt.submittedAt)} · {activeAttempt.total ? '自动核对答对 ' + activeAttempt.correctCount + ' / ' + activeAttempt.total : '查看各题反馈'}
                  {'effectiveDurationMs' in activeAttempt && typeof activeAttempt.effectiveDurationMs === 'number' && (
                    <> · 作答用时（浏览器估计）{durationLabel(activeAttempt.effectiveDurationMs)}</>
                  )}
                </p>
              </div>
              <div className="workbook-attempt-actions">
                <RecordQuestionLink kind="attempt" record={activeAttempt} />
                {wrongQuestionIds.length > 0 && (
                  <button type="button" className="tonal-button" disabled={busy || !watermark.ready} onClick={() => startRedo('wrong')}>
                    重做错题（{wrongQuestionIds.length}）
                  </button>
                )}
                <button type="button" className="tonal-button" disabled={busy || !watermark.ready} onClick={() => startRedo('full')}>
                  整卷重做
                </button>
              </div>
            </div>
            {historical.questionPermit && frozenQuestions && reviewItems.length > 0 && activeAttempt.rev && activeAttempt.paperRev &&
              <div key={activeAttempt.id + ':' + activeAttempt.rev} data-workbook-thought-feedback={activeAttempt.id}
                data-attempt-rev={activeAttempt.rev} data-paper-id={paperId} data-paper-rev={activeAttempt.paperRev} />}
            <AttemptResearch key={activeAttempt.id} paperId={paperId} attemptId={activeAttempt.id}
              onSaved={() => setReload(n => n + 1)} />
            {solutions.error && <p role="alert">{solutions.error} <button onClick={solutions.retry}>重试</button></p>}
            {historical.error && <p role="alert">{historical.error} <button onClick={historical.retry}>重试</button></p>}
            {!historical.allowed && !historical.error && <p role="status">正在确认历史题面展示许可…</p>}
            <QuestionPresentation value={historical.questionPermit}>
            {reviewAllowed && feedback.map((feedback) => {
              const question = reviewQuestions.find((item) => item.id === feedback.questionId);
              if (!question) return null;
              return (
                <div key={feedback.questionId}>
                  <FeedbackItem
                    paperId={paperId}
                    attemptId={activeAttempt.id}
                    question={question}
                    feedback={feedback}
                    showFeedback={!feedback.expected || feedback.expected.kind === 'rubric' || solutions.allowed}
                    assessments={(activeAttempt.assessments ?? []).filter(
                      (assessment) => assessment.questionId === feedback.questionId,
                    )}
                    allowSearch={settings?.allowSearch === true}
                    destination={settings ? settings.model + ' · ' + settings.baseUrl : '模型服务'}
                    onAssess={assessRubric}
                    assessing={assessing}
                    sealedPractice={view.sealedPractice === true}
                    correction={typeof activeAttempt.rev === 'number' && watermark.ready && activeAttempt.correctionItemIds?.includes(question.id) ? {
                      attemptRev: activeAttempt.rev, recorded: activeAttempt.correctedItemIds?.includes(question.id) === true,
                    } : undefined}
                  />
                  {settingsError && question.kind === 'rubric' && !(activeAttempt.assessments ?? []).some(
                    (assessment) => assessment.questionId === feedback.questionId,
                  ) && <p className="error-text" role="alert">{settingsError}</p>}
                </div>
              );
            })}
            </QuestionPresentation>
            <WorkbookAccess key={activeAttempt.id} paperId={paperId} attemptId={activeAttempt.id} displayId={solutions.displayId} />
          </section>
        )}
      </div>
      {attempts.length > 0 && (
        <section className="workbook-history">
          <div className="subhead"><h2>作答历史</h2><span className="workbook-count">{attempts.length} 次</span></div>
          <div className="workbook-history-list">
            {attempts.map((attempt) => (
              <button
                key={attempt.id}
                type="button"
                className={`workbook-history-item ${activeAttempt?.id === attempt.id ? 'active' : ''}`}
                aria-pressed={activeAttempt?.id === attempt.id}
                onClick={() => setSelectedAttemptId(attempt.id)}
              >
                <span>
                  <strong>{dateLabel(attempt.submittedAt)}</strong>
                  <small>{attempt.total ? '自动核对答对 ' + attempt.correctCount + ' / ' + attempt.total : '查看各题反馈'}</small>
                </span>
                <small>{attempt.feedback.filter((feedback) => feedback.result === 'self-check').length} 题自评</small>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export function Workbook({ id, materials, modelSettings }: WorkbookProps) {
  if (id === undefined) return <ListPage />;
  if (id === 'new') return <AuthorPage materials={materials} />;
  return <PaperDetail paperId={id} materials={materials} modelSettings={modelSettings} />;
}
