import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, requestId, type Settings } from './api';
import { chatRoute } from './model-route';
import MathText from './math-text';
import { rememberRoom, roomPath, writeRoom } from './classroom-contract';

export type IntakeQuestionCardOption = { readonly label: string; readonly text: string };

export type IntakeQuestionCard = {
  readonly draftId: string;
  readonly index: number;
  readonly number: string;
  readonly kind:
    | 'single_choice'
    | 'multiple_choice'
    | 'fill_blank'
    | 'short_answer'
    | 'calculation'
    | 'proof'
    | 'code'
    | 'other';
  readonly stem: string;
  readonly options: readonly IntakeQuestionCardOption[];
  readonly studentAnswer: {
    readonly status: 'present' | 'unclear' | 'absent';
    readonly text: string | null;
    readonly note?: string;
  };
  readonly redPenMark: {
    readonly verdict: 'correct' | 'wrong' | 'partial' | 'none' | 'unclear';
    readonly marks: readonly string[];
    readonly correction: string | null;
    readonly score: string | null;
  };
  readonly isRedPenError: boolean;
  readonly unclearNotice: string | null;
  readonly conceptTags?: readonly string[];
  readonly defaultSelected: boolean;
};

export type IntakeQuestionCardBundle = {
  readonly materialId: string;
  readonly materialRev: number;
  readonly intakeRev: number;
  readonly title: string;
  readonly questionCards: readonly IntakeQuestionCard[];
};

type WorkbookReceipt = {
  readonly kind: 'workbook';
  readonly paperId: string;
  readonly href?: string;
};

type BankReceipt = {
  readonly kind: 'bank';
  readonly savedCount: number;
  readonly skippedCount?: number;
  readonly questionIds: readonly string[];
  readonly conceptIds?: readonly string[];
  readonly createdConceptCount?: number;
  readonly linkedEdgeCount?: number;
};

type ActionKind = 'workbook' | 'bank' | 'classroom';

const questionKindLabels = {
  single_choice: '单选',
  multiple_choice: '多选',
  fill_blank: '填空',
  short_answer: '简答',
  calculation: '计算',
  proof: '证明',
  code: '编程',
  other: '其他',
} as const;

const verdictLabels = {
  wrong: '红笔错题',
  partial: '待订正',
  correct: '已做对',
  unclear: '批注待核对',
} as const;

const maxConceptTags = 6;

function normalizeConceptTags(tags: readonly string[] | undefined) {
  return [...new Set(tags?.map(tag => tag.trim()).filter(Boolean) ?? [])].slice(0, maxConceptTags);
}

function selectedCards(cards: readonly IntakeQuestionCard[], selected: ReadonlySet<string>) {
  return cards.filter(card => selected.has(card.draftId));
}

function classroomTopic(title: string, cards: readonly IntakeQuestionCard[]) {
  const numbers = cards.map(card => card.number).filter(Boolean).join('、');
  const suffix = numbers ? `的第 ${numbers} 题` : '的勾选题';
  const source = `围绕「${title}」${suffix}（共 ${cards.length} 题）上一节 10 分钟错题微课，拆解卡点与订正思路`;
  return source.length > 280 ? Array.from(source).slice(0, 280).join('') : source;
}

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof ApiError && failure.message ? failure.message : fallback;
}

export function IntakeQuestionCards({
  materialId,
  materialTitle,
  materialRev,
  extractionStatus,
  initialCards,
  settings,
  onNavigate,
}: {
  materialId: string;
  materialTitle: string;
  materialRev: number;
  extractionStatus?: string | undefined;
  initialCards: readonly IntakeQuestionCard[];
  settings?: Settings | undefined;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const [bundle, setBundle] = useState<IntakeQuestionCardBundle>(() => ({
    materialId,
    materialRev,
    intakeRev: materialRev,
    title: materialTitle,
    questionCards: initialCards,
  }));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() =>
    new Set(initialCards.filter(card => card.defaultSelected || card.isRedPenError).map(card => card.draftId)));
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [actionError, setActionError] = useState('');
  const [bankReceipt, setBankReceipt] = useState<BankReceipt | null>(null);
  const [conceptTags, setConceptTags] = useState<ReadonlyMap<string, readonly string[]>>(() =>
    new Map(initialCards.map(card => [card.draftId, normalizeConceptTags(card.conceptTags)])));
  const [tagEditor, setTagEditor] = useState<ReadonlySet<string>>(new Set());
  const [tagDrafts, setTagDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [linkConcepts, setLinkConcepts] = useState(true);
  const loadedKey = useRef<string | null>(null);
  const fetchedKey = useRef<string | null>(null);
  const initialCardsRef = useRef(initialCards);
  initialCardsRef.current = initialCards;
  const initialCardsKey = useMemo(() => initialCards.map(card => card.draftId).join('\n'), [initialCards]);
  const pending = extractionStatus === 'pending';
  const route = settings && chatRoute(settings, 'companion');
  const cards = bundle.questionCards;
  const cardsKey = useMemo(() => cards.map(card => card.draftId).join('\n'), [cards]);
  const redPenErrors = cards.filter(card => card.isRedPenError);
  const chosen = selectedCards(cards, selected);
  function tagsForCard(card: IntakeQuestionCard) {
    return normalizeConceptTags(conceptTags.get(card.draftId) ?? card.conceptTags);
  }

  useEffect(() => {
    const key = `${materialId}:${materialRev}`;
    if (fetchedKey.current === key) return;
    setBundle({
      materialId,
      materialRev,
      intakeRev: materialRev,
      title: materialTitle,
      questionCards: initialCardsRef.current,
    });
  }, [initialCardsKey, materialId, materialRev, materialTitle]);

  useEffect(() => {
    if (pending) return;
    const key = `${materialId}:${materialRev}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    const controller = new AbortController();
    let settled = false;
    setLoading(true);
    api<IntakeQuestionCardBundle>(`/materials/${encodeURIComponent(materialId)}/question-cards`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(value => {
        if (controller.signal.aborted || value.materialId !== materialId) return;
        settled = true;
        fetchedKey.current = key;
        setBundle(value);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        settled = true;
        setBundle({
          materialId,
          materialRev,
          intakeRev: materialRev,
          title: materialTitle,
          questionCards: initialCardsRef.current,
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (!settled && loadedKey.current === key) loadedKey.current = null;
    };
  }, [materialId, materialRev, materialTitle, pending]);

  useEffect(() => {
    if (!cardsKey) return;
    setConceptTags(current => {
      const next = new Map<string, readonly string[]>();
      for (const card of cards) next.set(card.draftId, normalizeConceptTags(current.get(card.draftId) ?? card.conceptTags));
      return next;
    });
    setSelected(current => {
      const ids = new Set(cardsKey.split('\n'));
      const next = new Set([...current].filter(id => ids.has(id)));
      for (const card of cards) {
        if (card.defaultSelected || card.isRedPenError) next.add(card.draftId);
      }
      return next;
    });
    setBankReceipt(null);
  }, [cards, cardsKey]);

  useEffect(() => {
    setTagEditor(current => new Set([...current].filter(id => cards.some(card => card.draftId === id))));
    setTagDrafts(current => new Map([...current].filter(([id]) => cards.some(card => card.draftId === id))));
  }, [cards, cardsKey]);

  function updateSelection(cardsToSelect: readonly IntakeQuestionCard[], replace = false) {
    setSelected(current => {
      if (replace) return new Set(cardsToSelect.map(card => card.draftId));
      const next = new Set(current);
      for (const card of cardsToSelect) next.add(card.draftId);
      return next;
    });
    setBankReceipt(null);
  }

  function toggleSelection(card: IntakeQuestionCard, checked: boolean) {
    setSelected(current => {
      const next = new Set(current);
      if (checked) next.add(card.draftId);
      else next.delete(card.draftId);
      return next;
    });
    setBankReceipt(null);
  }

  function updateTagDraft(cardId: string, value: string) {
    setTagDrafts(current => new Map(current).set(cardId, value));
  }

  function closeTagEditor(cardId: string) {
    setTagEditor(current => {
      const next = new Set(current);
      next.delete(cardId);
      return next;
    });
    setTagDrafts(current => {
      if (!current.has(cardId)) return current;
      const next = new Map(current);
      next.delete(cardId);
      return next;
    });
  }

  function addConceptTag(cardId: string, input: string) {
    const tag = input.trim();
    if (!tag) return;
    const currentTags = normalizeConceptTags(conceptTags.get(cardId) ?? cards.find(card => card.draftId === cardId)?.conceptTags);
    if (currentTags.length >= maxConceptTags) return;
    const nextTags = normalizeConceptTags([...currentTags, tag]);
    setConceptTags(current => new Map(current).set(cardId, nextTags));
    if (nextTags.some(nextTag => nextTag === tag)) updateTagDraft(cardId, '');
    else updateTagDraft(cardId, tag);
    setBankReceipt(null);
  }

  function removeConceptTag(cardId: string, tag: string) {
    setConceptTags(current => {
      const tags = current.get(cardId);
      if (!tags) return current;
      return new Map(current).set(cardId, tags.filter(currentTag => currentTag !== tag));
    });
    setBankReceipt(null);
  }

  async function runAction(kind: ActionKind) {
    if (action || chosen.length === 0) return;
    setAction(kind);
    setActionError('');
    try {
      if (kind === 'workbook') {
        const receipt = await api<WorkbookReceipt>(`/materials/${encodeURIComponent(materialId)}/confirm-drafts`, {
          method: 'POST',
          body: {
            requestId: requestId(),
            mode: 'workbook',
            title: `${bundle.title || materialTitle} · 错题微卷`,
            items: chosen.map(card => card.draftId),
          },
        });
        onNavigate?.(receipt.href || `/papers/${encodeURIComponent(receipt.paperId)}`);
        return;
      }

      if (kind === 'bank') {
        const tagsByDraft = new Map(chosen.map(card => [card.draftId, tagsForCard(card)]));
        const receipt = await api<BankReceipt>(`/materials/${encodeURIComponent(materialId)}/confirm-drafts`, {
          method: 'POST',
          body: {
            requestId: requestId(),
            mode: 'bank',
            confirmedByLearner: true,
            expectedMaterialRev: bundle.materialRev ?? materialRev,
            purpose: 'storage',
            linkConcepts,
            items: chosen.map(card => ({
              draftId: card.draftId,
              title: `${bundle.title || materialTitle} 第 ${card.number} 题`.slice(0, 120),
              stem: card.stem,
              ...(card.options.length > 0
                ? { options: card.options.map(option => ({ label: option.label, text: option.text })) }
                : {}),
              ...(linkConcepts && tagsByDraft.get(card.draftId)?.length ? { conceptTags: tagsByDraft.get(card.draftId) } : {}),
            })),
          },
        });
        setBankReceipt(receipt);
        return;
      }

      if (!route) {
        setActionError('还没有配置同伴教学账户。请先在「我」里完成模型设置，再回来开微课。');
        return;
      }
      const room = await writeRoom({
        path: '/classrooms',
        body: {
          requestId: requestId(),
          topic: classroomTopic(bundle.title || materialTitle, chosen),
          minutes: 10,
          route,
        },
      });
      rememberRoom(room.id);
      onNavigate?.(roomPath(room.id));
    } catch (failure) {
      const fallback = kind === 'workbook'
        ? '错题微卷没有生成，请稍后重试。'
        : kind === 'bank'
          ? '题目没有收入题库，请稍后重试。'
          : '微课还没有创建，请稍后重试。';
      setActionError(failureMessage(failure, fallback));
    } finally {
      setAction(null);
    }
  }

  if (cards.length === 0) return null;

  return (
    <section className="intake-question-cards" aria-label="逐题核对卡">
      <header className="intake-cards-head">
        <div>
          <h2>逐题核对卡</h2>
          <p>共 {cards.length} 题 · {redPenErrors.length} 处红笔错题{loading ? ' · 正在刷新' : ''}</p>
        </div>
        <div className="intake-cards-filters" role="group" aria-label="快捷勾选">
          {redPenErrors.length > 0 && (
            <button type="button" onClick={() => updateSelection(redPenErrors, true)}>仅选红笔错题</button>
          )}
          <button type="button" onClick={() => updateSelection(cards, true)}>全选</button>
          <button type="button" onClick={() => updateSelection([], true)}>清空</button>
        </div>
      </header>
      <ul>
        {cards.map(card => {
          const isSelected = selected.has(card.draftId);
          const tags = tagsForCard(card);
          const editorOpen = tagEditor.has(card.draftId);
          const draftValue = tagDrafts.get(card.draftId) ?? '';
          return (
            <li key={card.draftId} className={isSelected ? 'selected' : ''}>
              <header>
                <label>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    aria-label={`选择第 ${card.number} 题`}
                    onChange={event => toggleSelection(card, event.target.checked)}
                  />
                  <span aria-hidden="true" />
                </label>
                <div>
                  <strong>第 {card.number} 题</strong>
                  <span className="kind">{questionKindLabels[card.kind]}</span>
                  {card.redPenMark.verdict !== 'none' && (
                    <span className={`verdict ${card.redPenMark.verdict}`}>
                      {verdictLabels[card.redPenMark.verdict]}
                    </span>
                  )}
                  {card.redPenMark.score && <span className="score">{card.redPenMark.score}</span>}
                </div>
              </header>
              <div className="intake-card-copy">
                <MathText text={card.stem} />
                {card.options.length > 0 && (
                  <ul className="intake-card-options">
                    {card.options.map(option => (
                      <li key={`${option.label}-${option.text}`}>
                        {option.label && <strong>{option.label}.</strong>}
                        <MathText text={option.text} />
                      </li>
                    ))}
                  </ul>
                )}
                <div className="intake-concept-tags" aria-label={`第 ${card.number} 题概念标签`}>
                  <strong>概念标签</strong>
                  {tags.length > 0 && (
                    <ul>
                      {tags.map(tag => (
                        <li key={tag}>
                          <span><MathText text={tag} /></span>
                          <button
                            type="button"
                            aria-label={`移除概念标签：${tag}`}
                            onClick={event => {
                              event.stopPropagation();
                              removeConceptTag(card.draftId, tag);
                            }}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {editorOpen && tags.length < maxConceptTags ? (
                    <>
                      <input
                        type="text"
                        value={draftValue}
                        placeholder="输入概念名"
                        aria-label={`添加第 ${card.number} 题概念`}
                        onChange={event => updateTagDraft(card.draftId, event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addConceptTag(card.draftId, draftValue);
                          }
                          if (event.key === 'Escape') closeTagEditor(card.draftId);
                        }}
                      />
                      <span>
                        <button
                          type="button"
                          disabled={!draftValue.trim()}
                          onClick={() => addConceptTag(card.draftId, draftValue)}
                        >
                          确认
                        </button>
                        <button type="button" onClick={() => closeTagEditor(card.draftId)}>取消</button>
                      </span>
                    </>
                  ) : tags.length < maxConceptTags ? (
                    <button type="button" className="intake-add-concept" onClick={() => setTagEditor(current => new Set(current).add(card.draftId))}>
                      + 添加概念
                    </button>
                  ) : (
                    <span className="intake-concept-limit">最多 6 个概念标签</span>
                  )}
                </div>
                <div className="intake-student-answer">
                  <strong>黑笔作答</strong>
                  {card.studentAnswer.status === 'absent' && <span>未作答</span>}
                  {card.studentAnswer.status === 'unclear' && (
                    <span>字迹较模糊{card.studentAnswer.note ? ` · ${card.studentAnswer.note}` : ''}</span>
                  )}
                  {card.studentAnswer.status === 'present' && card.studentAnswer.text !== null && (
                    <MathText text={card.studentAnswer.text} />
                  )}
                </div>
                {(card.redPenMark.correction !== null || card.redPenMark.marks.length > 0) && (
                  <div className="intake-red-pen">
                    <strong>红笔评语与订正</strong>
                    {card.redPenMark.marks.map(mark => <p key={mark}><MathText text={mark} /></p>)}
                    {card.redPenMark.correction !== null && <MathText text={card.redPenMark.correction} />}
                  </div>
                )}
                {card.unclearNotice && <p className="intake-unclear"><MathText text={card.unclearNotice} /></p>}
              </div>
            </li>
          );
        })}
      </ul>
      <footer>
        <span aria-live="polite">已选 {chosen.length} 题</span>
        <label className="intake-link-concepts">
          <input
            type="checkbox"
            checked={linkConcepts}
            onChange={event => {
              setLinkConcepts(event.target.checked);
              setBankReceipt(null);
            }}
          />
          同时归入知识图谱
        </label>
        <div>
          <button
            className="primary-button"
            type="button"
            disabled={action !== null || chosen.length === 0}
            onClick={() => void runAction('workbook')}
          >
            {chosen.length > 0 && chosen.every(card => card.isRedPenError) ? '生成错题微卷' : '生成所选微卷'}
          </button>
          <button
            className="tonal-button"
            type="button"
            disabled={action !== null || chosen.length === 0}
            onClick={() => void runAction('bank')}
          >
            收进题库
          </button>
          <button
            className="text-button"
            type="button"
            disabled={action !== null || chosen.length === 0}
            onClick={() => void runAction('classroom')}
          >
            针对勾选错题开微课
          </button>
        </div>
        {action !== null && <p role="status">正在处理，请稍候…</p>}
        {actionError && (
          <p className="error-text" role="alert">
            {actionError}
            {!route && (
              <>
                {' '}
                <a
                  href="/me?section=models"
                  onClick={event => {
                    event.preventDefault();
                    onNavigate?.('/me?section=models');
                  }}
                >
                  前往模型设置
                </a>
              </>
            )}
          </p>
        )}
        {bankReceipt && (
          <div
            className={bankReceipt.conceptIds?.length ? 'intake-action-receipt intake-graph-receipt' : 'intake-action-receipt'}
            role="status"
          >
            <p>
              {bankReceipt.conceptIds?.length
                ? `已收进题库 ${bankReceipt.savedCount} 题${bankReceipt.skippedCount ? `（跳过已收录 ${bankReceipt.skippedCount} 题）` : ''}，并点亮 ${bankReceipt.conceptIds.length} 个知识图谱节点${bankReceipt.createdConceptCount ? `（含 ${bankReceipt.createdConceptCount} 个新节点）` : ''}。`
                : `已收入正式题库 ${bankReceipt.savedCount} 题${bankReceipt.skippedCount ? `，跳过已收录 ${bankReceipt.skippedCount} 题` : ''}。`}
            </p>
            {bankReceipt.conceptIds?.length ? (
              <span>
                <a
                  className="primary-button"
                  href="/materials?tab=graph"
                  onClick={event => {
                    event.preventDefault();
                    onNavigate?.('/materials?tab=graph');
                  }}
                >
                  去知识图谱看看
                </a>
                <a
                  className="text-button"
                  href="/materials?tab=bank"
                  onClick={event => {
                    event.preventDefault();
                    onNavigate?.('/materials?tab=bank');
                  }}
                >
                  前往题库查看
                </a>
              </span>
            ) : (
              <a
                href="/materials?tab=bank"
                onClick={event => {
                  event.preventDefault();
                  onNavigate?.('/materials?tab=bank');
                }}
              >
                前往题库查看
              </a>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}
