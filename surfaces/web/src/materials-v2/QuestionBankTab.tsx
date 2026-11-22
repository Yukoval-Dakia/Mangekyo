import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError, requestId, submissionId } from '../api';
import { paperPracticePath } from '../builtin-packs';
import { latestKey } from '../deletion-watermark';
import { useDraftWatermark } from '../draft-watermark';
import { Icon } from '../icons';
import { Message } from '../message';
import {
  extractFoldingPayload,
  filterClustersForMistakes,
  formatMasterySummary,
  MASTERY_META,
  normalizeArchetypeFolding,
  normalizeBankQuestions,
  normalizeMistakeItems,
} from './archetype-adapter';
import type {
  CompanionCitationPayload,
  NormalizedArchetypeCluster,
  NormalizedArchetypeMember,
  NormalizedBankQuestion,
  NormalizedMistakeItem,
  PracticeQuestionPayload,
  QuestionBankTabProps,
  RawArchetypeFoldingPayload,
  RawBankQuestion,
  RawMistakeEntry,
  RawQuestionCatalogResponse,
  RepresentativeStatus,
} from './types';
import './materials-v2.css';

const REPRESENTATIVE_DISABLED_NOTE: Readonly<Record<Exclude<RepresentativeStatus, 'actionable'>, string>> = {
  all_steady: '本母题下题目均已稳',
  unknown_only: '掌握度尚待核对，暂不指派代表题',
  no_handle: '暂无可开练的未稳代表题',
};

function FoldIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
      <path d="m3 18 9 5 9-5" />
    </svg>
  );
}

function MistakeIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
    </svg>
  );
}

function CiteIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6.5C4 5.1 5.1 4 6.5 4h11C18.9 4 20 5.1 20 6.5v8c0 1.4-1.1 2.5-2.5 2.5H11l-4.5 3.5V17H6.5C5.1 17 4 15.9 4 14.5v-8Z" />
      <path d="M8.5 9h7" />
      <path d="M8.5 12.5h4.5" />
    </svg>
  );
}

interface TeachingNotice {
  readonly key: string;
  readonly tone: 'success' | 'error';
  readonly text: string;
}

function matchesSearch(query: string, fields: readonly (string | null | undefined)[]): boolean {
  if (!query) return true;
  const haystack = fields.filter((field): field is string => Boolean(field)).join(' ').toLowerCase();
  return haystack.includes(query);
}

function MasteryBar({ cluster }: { readonly cluster: NormalizedArchetypeCluster }) {
  const total = Math.max(cluster.coveredQuestionCount, 1);
  const steadyWidth = (cluster.counts.steady / total) * 100;
  const dueWidth = (cluster.counts.due / total) * 100;
  const weakWidth = (cluster.counts.weak / total) * 100;
  const unknownWidth = (cluster.counts.unknown / total) * 100;
  const summary = formatMasterySummary(cluster);
  const barLabel = summary.unknownNote ? `${summary.primary}，${summary.unknownNote}` : summary.primary;
  return (
    <div className="mv2-mastery-bar" role="img" aria-label={barLabel}>
      {steadyWidth > 0 && <span className="mv2-bar-seg mv2-bar-steady" style={{ width: `${steadyWidth}%` }} />}
      {dueWidth > 0 && <span className="mv2-bar-seg mv2-bar-due" style={{ width: `${dueWidth}%` }} />}
      {weakWidth > 0 && <span className="mv2-bar-seg mv2-bar-weak" style={{ width: `${weakWidth}%` }} />}
      {unknownWidth > 0 && <span className="mv2-bar-seg mv2-bar-unknown" style={{ width: `${unknownWidth}%` }} />}
    </div>
  );
}

function ArchetypeClusterCard({
  cluster,
  mistakesOnly,
  busyActionKey,
  citedKey,
  onPractice,
  onCite,
}: {
  readonly cluster: NormalizedArchetypeCluster;
  readonly mistakesOnly: boolean;
  readonly busyActionKey: string | null;
  readonly citedKey: string | null;
  readonly onPractice: (actionKey: string, payload: PracticeQuestionPayload) => void;
  readonly onCite: (citeKey: string, payload: CompanionCitationPayload) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAllInMistakes, setShowAllInMistakes] = useState(false);
  const panelId = useId();
  const summary = formatMasterySummary(cluster);
  const representative = cluster.actionableRepresentative;
  const repActionKey = `rep:${cluster.key}`;
  const clusterCiteKey = `cite-cluster:${cluster.key}`;

  const filteredMembers = useMemo(() => {
    if (!mistakesOnly || showAllInMistakes) return cluster.members;
    const focused = cluster.members.filter(
      member => member.isMistake || member.mastery === 'weak' || member.mastery === 'due',
    );
    return focused.length > 0 ? focused : cluster.members;
  }, [cluster.members, mistakesOnly, showAllInMistakes]);

  const representativeHint = representative
    ? [representative.sourceLabel, representative.positionLabel].filter(Boolean).join(' · ')
    : null;

  return (
    <article className="mv2-cluster-card" data-expanded={expanded ? 'true' : 'false'}>
      <div className="mv2-cluster-top">
        <button
          type="button"
          className="mv2-cluster-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded(previous => !previous)}
        >
          <div className="mv2-cluster-heading">
            <div className="mv2-cluster-kicker">
              <span className="mv2-kicker-tag">母题簇</span>
              {cluster.hasMistake && <span className="mv2-pill mv2-pill-weak">含错题</span>}
              {cluster.variationDimensions.map(dimension => (
                <span key={dimension} className="mv2-dimension-chip">{dimension}</span>
              ))}
            </div>
            <h3 className="mv2-cluster-title">{cluster.title}</h3>
            <div className="mv2-count-row">
              <span className="mv2-count-primary">{summary.primary}</span>
              {summary.unknownNote && (
                <span className="mv2-pill mv2-pill-unknown">{summary.unknownNote}</span>
              )}
            </div>
            <MasteryBar cluster={cluster} />
          </div>
          <span className="mv2-expand-indicator" aria-hidden="true">
            <span>{expanded ? '收起原卷题' : `展开 ${cluster.coveredQuestionCount} 道原卷题`}</span>
            <span className="mv2-chevron">
              <Icon name="chevron" />
            </span>
          </span>
        </button>

        <div className="mv2-cluster-actions">
          <div className="mv2-practice-slot">
            <button
              type="button"
              className="mv2-btn mv2-btn-primary"
              disabled={!representative || busyActionKey !== null}
              onClick={() => {
                if (!representative) return;
                onPractice(repActionKey, {
                  kind: 'archetype-representative',
                  title: representative.title,
                  archetypeTitle: cluster.title,
                  mastery: representative.mastery,
                  ...(representative.prompt ? { prompt: representative.prompt } : {}),
                  ...(representative.practice ? { practice: representative.practice } : {}),
                  ...(representative.questionRef ? { sourceRef: representative.questionRef } : {}),
                  ...(representativeHint ? { anchorLabel: representativeHint } : {}),
                });
              }}
            >
              {busyActionKey === repActionKey ? '正在开练…' : '练 1 道未稳代表题'}
            </button>
            {representative && representativeHint ? (
              <span className="mv2-action-hint">目标：{representativeHint}</span>
            ) : cluster.representativeStatus !== 'actionable' ? (
              <span className="mv2-action-hint">{REPRESENTATIVE_DISABLED_NOTE[cluster.representativeStatus]}</span>
            ) : null}
          </div>

          <button
            type="button"
            className="mv2-btn mv2-btn-ghost"
            onClick={() =>
              onCite(clusterCiteKey, {
                kind: 'archetype',
                title: cluster.title,
                archetypeTitle: cluster.title,
                sourceLabel: `${summary.primary}${summary.unknownNote ? ` · ${summary.unknownNote}` : ''}`,
                ...(representative?.prompt ? { prompt: representative.prompt } : {}),
                ...(representative?.mastery ? { mastery: representative.mastery } : {}),
                ...(representative?.questionRef ? { questionRef: representative.questionRef } : {}),
              })
            }
          >
            <CiteIcon />
            <span>{citedKey === clusterCiteKey ? '已引用到同伴' : '引用到学习同伴'}</span>
          </button>
        </div>
      </div>

      {expanded && (
        <div id={panelId} className="mv2-cluster-panel">
          <div className="mv2-panel-header">
            <span>
              {mistakesOnly && !showAllInMistakes && filteredMembers.length < cluster.members.length
                ? `已筛选待固与错题（${filteredMembers.length} / ${cluster.members.length} 题）`
                : `簇内已获准原卷题（共 ${cluster.members.length} 题）`}
            </span>
            {mistakesOnly && filteredMembers.length < cluster.members.length && (
              <button
                type="button"
                className="mv2-inline-link"
                onClick={() => setShowAllInMistakes(true)}
              >
                查看本簇全部 {cluster.members.length} 题
              </button>
            )}
            {mistakesOnly && showAllInMistakes && (
              <button
                type="button"
                className="mv2-inline-link"
                onClick={() => setShowAllInMistakes(false)}
              >
                仅看待固与错题
              </button>
            )}
          </div>

          <ul className="mv2-member-list">
            {filteredMembers.map(member => {
              const isRep = representative?.key === member.key;
              const memberPracticeKey = `member:${cluster.key}:${member.key}`;
              const memberCiteKey = `cite-member:${cluster.key}:${member.key}`;
              const masteryMeta = MASTERY_META[member.mastery];
              const anchorParts = [member.sourceLabel, member.positionLabel].filter(Boolean).join(' · ');
              const canPracticeMember =
                member.practiceEligible && Boolean(member.practice || member.questionRef);
              return (
                <li key={member.key} className="mv2-member-item">
                  <div className="mv2-member-meta">
                    <time className="mv2-anchor-date" dateTime={member.dateLabel ?? undefined}>
                      {member.dateLabel ?? '日期未记'}
                    </time>
                    <span className="mv2-anchor-source">{anchorParts}</span>
                    <span className="mv2-origin-chip">
                      {member.origin === 'original' ? '原卷' : '题库单题'}
                    </span>
                    <span className={`mv2-pill mv2-pill-${masteryMeta.tone}`}>
                      {masteryMeta.label}
                    </span>
                    {isRep && <span className="mv2-pill mv2-pill-rep">未稳代表题</span>}
                    {member.isMistake && <span className="mv2-pill mv2-pill-weak">错题记录</span>}
                  </div>

                  {member.title !== anchorParts && (
                    <p className="mv2-member-title">{member.title}</p>
                  )}

                  {member.prompt && (
                    <details className="mv2-prompt-details">
                      <summary>查看题面</summary>
                      <div className="mv2-prompt-body">
                        <Message text={member.prompt} />
                      </div>
                    </details>
                  )}

                  <div className="mv2-item-actions">
                    {canPracticeMember && (
                      <button
                        type="button"
                        className="mv2-btn mv2-btn-tonal mv2-btn-sm"
                        disabled={busyActionKey !== null}
                        onClick={() =>
                          onPractice(memberPracticeKey, {
                            kind: 'cluster-member',
                            title: member.title,
                            archetypeTitle: cluster.title,
                            mastery: member.mastery,
                            anchorLabel: anchorParts,
                            ...(member.prompt ? { prompt: member.prompt } : {}),
                            ...(member.practice ? { practice: member.practice } : {}),
                            ...(member.questionRef ? { sourceRef: member.questionRef } : {}),
                          })
                        }
                      >
                        {busyActionKey === memberPracticeKey ? '正在开练…' : '练这道题'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="mv2-btn mv2-btn-ghost mv2-btn-sm"
                      onClick={() =>
                        onCite(memberCiteKey, {
                          kind: member.isMistake ? 'mistake' : 'question',
                          title: member.title,
                          archetypeTitle: cluster.title,
                          sourceLabel: anchorParts,
                          mastery: member.mastery,
                          ...(member.prompt ? { prompt: member.prompt } : {}),
                          ...(member.questionRef ? { questionRef: member.questionRef } : {}),
                          ...(member.mistakeEntry
                            ? {
                                lastAnswer: member.mistakeEntry.answer,
                                expected: member.mistakeEntry.expected,
                                paperId: member.mistakeEntry.paperId,
                              }
                            : {}),
                        })
                      }
                    >
                      <CiteIcon />
                      <span>{citedKey === memberCiteKey ? '已引用' : '引用到学习同伴'}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </article>
  );
}

function StandaloneMemberCard({
  member,
  busyActionKey,
  citedKey,
  onPractice,
  onCite,
}: {
  readonly member: NormalizedArchetypeMember;
  readonly busyActionKey: string | null;
  readonly citedKey: string | null;
  readonly onPractice: (actionKey: string, payload: PracticeQuestionPayload) => void;
  readonly onCite: (citeKey: string, payload: CompanionCitationPayload) => void;
}) {
  const masteryMeta = MASTERY_META[member.mastery];
  const anchorParts = [member.sourceLabel, member.positionLabel].filter(Boolean).join(' · ');
  const actionKey = `standalone:${member.key}`;
  const citeKey = `cite-standalone:${member.key}`;
  const canPractice = member.practiceEligible && Boolean(member.practice || member.questionRef);

  return (
    <article className="mv2-item-card">
      <div className="mv2-card-meta">
        {member.dateLabel && <time className="mv2-anchor-date" dateTime={member.dateLabel}>{member.dateLabel}</time>}
        <span className="mv2-anchor-source">{anchorParts}</span>
        <span className={`mv2-pill mv2-pill-${masteryMeta.tone}`}>{masteryMeta.label}</span>
      </div>
      <h3 className="mv2-item-title">{member.title}</h3>
      {member.prompt && (
        <details className="mv2-prompt-details">
          <summary>查看题面</summary>
          <div className="mv2-prompt-body">
            <Message text={member.prompt} />
          </div>
        </details>
      )}
      <div className="mv2-item-actions">
        {canPractice && (
          <button
            type="button"
            className="mv2-btn mv2-btn-tonal mv2-btn-sm"
            disabled={busyActionKey !== null}
            onClick={() =>
              onPractice(actionKey, {
                kind: 'bank-question',
                title: member.title,
                mastery: member.mastery,
                anchorLabel: anchorParts,
                ...(member.prompt ? { prompt: member.prompt } : {}),
                ...(member.practice ? { practice: member.practice } : {}),
                ...(member.questionRef ? { sourceRef: member.questionRef } : {}),
              })
            }
          >
            {busyActionKey === actionKey ? '正在开练…' : '单题开练'}
          </button>
        )}
        <button
          type="button"
          className="mv2-btn mv2-btn-ghost mv2-btn-sm"
          onClick={() =>
            onCite(citeKey, {
              kind: 'question',
              title: member.title,
              sourceLabel: anchorParts,
              mastery: member.mastery,
              ...(member.prompt ? { prompt: member.prompt } : {}),
              ...(member.questionRef ? { questionRef: member.questionRef } : {}),
            })
          }
        >
          <CiteIcon />
          <span>{citedKey === citeKey ? '已引用' : '引用到学习同伴'}</span>
        </button>
      </div>
    </article>
  );
}

function FlatQuestionCard({
  question,
  busyActionKey,
  citedKey,
  teachingBusyKey,
  teachingNotice,
  onPractice,
  onCite,
  onAuthorizeTeaching,
}: {
  readonly question: NormalizedBankQuestion;
  readonly busyActionKey: string | null;
  readonly citedKey: string | null;
  readonly teachingBusyKey: string | null;
  readonly teachingNotice: TeachingNotice | null;
  readonly onPractice: (actionKey: string, payload: PracticeQuestionPayload) => void;
  readonly onCite: (citeKey: string, payload: CompanionCitationPayload) => void;
  readonly onAuthorizeTeaching: (question: NormalizedBankQuestion) => void;
}) {
  const actionKey = `bank:${question.key}`;
  const citeKey = `cite-bank:${question.key}`;
  const teachingKey = `teaching:${question.sourceRef.id}`;
  const masteryMeta = question.mastery ? MASTERY_META[question.mastery] : null;
  const notice = teachingNotice && teachingNotice.key === teachingKey ? teachingNotice : null;
  const authorizing = teachingBusyKey === teachingKey;

  return (
    <article className="mv2-item-card">
      <div className="mv2-card-meta">
        {question.dateLabel && (
          <time className="mv2-anchor-date" dateTime={question.dateLabel}>{question.dateLabel}</time>
        )}
        {question.sourceLabel && <span className="mv2-anchor-source">{question.sourceLabel}</span>}
        <span className={`mv2-pill ${question.canPractice ? 'mv2-pill-steady' : 'mv2-pill-unknown'}`}>
          {question.statusLabel}
        </span>
        {!question.teachingAuthorized && <span className="mv2-pill mv2-pill-storage">仅保存</span>}
        {masteryMeta && (
          <span className={`mv2-pill mv2-pill-${masteryMeta.tone}`}>{masteryMeta.label}</span>
        )}
      </div>
      <h3 className="mv2-item-title">{question.title}</h3>
      {question.prompt && (
        <details className="mv2-prompt-details">
          <summary>查看题面</summary>
          <div className="mv2-prompt-body">
            <Message text={question.prompt} />
          </div>
        </details>
      )}
      <div className="mv2-item-actions">
        {question.teachingAuthorized ? (
          question.canPractice && (
          <button
            type="button"
            className="mv2-btn mv2-btn-tonal mv2-btn-sm"
            disabled={busyActionKey !== null}
            onClick={() =>
              onPractice(actionKey, {
                kind: 'bank-question',
                title: question.title,
                prompt: question.prompt,
                sourceRef: question.sourceRef,
                ...(question.mastery ? { mastery: question.mastery } : {}),
                ...(question.sourceLabel ? { anchorLabel: question.sourceLabel } : {}),
              })
            }
          >
            {busyActionKey === actionKey ? '正在开练…' : '单题开练'}
          </button>
          )
        ) : (
          <button
            type="button"
            className="mv2-btn mv2-btn-tonal mv2-btn-sm"
            disabled={authorizing}
            onClick={() => onAuthorizeTeaching(question)}
          >
            {authorizing ? '正在授权…' : '允许用于出题与练习'}
          </button>
        )}
        <button
          type="button"
          className="mv2-btn mv2-btn-ghost mv2-btn-sm"
          onClick={() =>
            onCite(citeKey, {
              kind: 'question',
              title: question.title,
              prompt: question.prompt,
              questionRef: question.sourceRef,
              ...(question.sourceLabel ? { sourceLabel: question.sourceLabel } : {}),
              ...(question.mastery ? { mastery: question.mastery } : {}),
            })
          }
        >
          <CiteIcon />
          <span>{citedKey === citeKey ? '已引用' : '引用到学习同伴'}</span>
        </button>
      </div>
      {notice && (
        <p
          className={`mv2-inline-notice ${notice.tone === 'success' ? 'mv2-inline-notice-soft' : 'mv2-inline-notice-error'}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
    </article>
  );
}

function MistakeCard({
  mistake,
  busyActionKey,
  citedKey,
  onPractice,
  onCite,
}: {
  readonly mistake: NormalizedMistakeItem;
  readonly busyActionKey: string | null;
  readonly citedKey: string | null;
  readonly onPractice: (actionKey: string, payload: PracticeQuestionPayload) => void;
  readonly onCite: (citeKey: string, payload: CompanionCitationPayload) => void;
}) {
  const actionKey = `mistake:${mistake.key}`;
  const citeKey = `cite-mistake:${mistake.key}`;

  return (
    <article className="mv2-item-card mv2-mistake-card">
      <div className="mv2-card-meta">
        {mistake.occurredAt && (
          <time className="mv2-anchor-date" dateTime={mistake.occurredAt}>{mistake.occurredAt}</time>
        )}
        <span className="mv2-anchor-source">{mistake.title}</span>
        <span className="mv2-pill mv2-pill-weak">待回看错题</span>
        {mistake.recurringCount !== null && (
          <span className="mv2-pill mv2-pill-due">同类栽跟头 ×{mistake.recurringCount}</span>
        )}
      </div>

      <div className="mv2-mistake-prompt">
        <Message text={mistake.prompt} />
      </div>

      {mistake.answer && (
        <div className="mv2-mistake-answer">
          <span>上次作答</span>
          <div className="mv2-mistake-answer-body">
            <Message text={mistake.answer} />
          </div>
        </div>
      )}

      {(mistake.expected || mistake.explanation) && (
        <details className="mv2-prompt-details">
          <summary>看参考答案与解析</summary>
          <div className="mv2-prompt-body">
            {mistake.expected && (
              <div className="mv2-expected-answer">
                <Message text={mistake.expected} />
              </div>
            )}
            {mistake.explanation && <Message text={mistake.explanation} />}
          </div>
        </details>
      )}

      <div className="mv2-item-actions">
        <button
          type="button"
          className="mv2-btn mv2-btn-tonal mv2-btn-sm"
          disabled={busyActionKey !== null}
          onClick={() =>
            onPractice(actionKey, {
              kind: 'mistake-retry',
              title: mistake.title,
              prompt: mistake.prompt,
              paperId: mistake.paperId,
              questionId: mistake.questionId,
              anchorLabel: mistake.title,
              ...(mistake.sourceRef ? { sourceRef: mistake.sourceRef } : {}),
            })
          }
        >
          {busyActionKey === actionKey ? '正在打开…' : '回原卷重做'}
        </button>
        <button
          type="button"
          className="mv2-btn mv2-btn-ghost mv2-btn-sm"
          onClick={() =>
            onCite(citeKey, {
              kind: 'mistake',
              title: mistake.title,
              prompt: mistake.prompt,
              sourceLabel: mistake.title,
              lastAnswer: mistake.answer,
              expected: mistake.expected,
              paperId: mistake.paperId,
              ...(mistake.sourceRef ? { questionRef: mistake.sourceRef } : {}),
            })
          }
        >
          <CiteIcon />
          <span>{citedKey === citeKey ? '已引用' : '引用到学习同伴'}</span>
        </button>
      </div>
    </article>
  );
}

export function QuestionBankTab({
  questions: providedQuestions,
  mistakes: providedMistakes,
  folding: providedFolding,
  foldingEndpoint,
  loading: externalLoading,
  error: externalError,
  defaultFoldByArchetype = true,
  defaultMistakesOnly = false,
  onPracticeQuestion,
  onCiteToCompanion,
  onNavigate,
  headerAction,
}: QuestionBankTabProps) {
  const watermark = useDraftWatermark();
  const [foldByArchetype, setFoldByArchetype] = useState(defaultFoldByArchetype);
  const [mistakesOnly, setMistakesOnly] = useState(defaultMistakesOnly);
  const [searchText, setSearchText] = useState('');
  const [fetchedCatalog, setFetchedCatalog] = useState<RawQuestionCatalogResponse | undefined>();
  const [fetchedFolding, setFetchedFolding] = useState<RawArchetypeFoldingPayload | undefined>();
  const [fetchedMistakes, setFetchedMistakes] = useState<readonly RawMistakeEntry[] | undefined>();
  const [internalLoading, setInternalLoading] = useState(false);
  const [internalError, setInternalError] = useState<string | null>(null);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [citedKey, setCitedKey] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [teachingBusyKey, setTeachingBusyKey] = useState<string | null>(null);
  const [teachingNotice, setTeachingNotice] = useState<TeachingNotice | null>(null);
  const citeTimerRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const shouldFetchQuestions = providedQuestions === undefined;
  const shouldFetchMistakes = providedMistakes === undefined;
  const shouldFetchFoldingEndpoint = providedFolding === undefined && Boolean(foldingEndpoint);

  const reload = useCallback(async () => {
    if (!shouldFetchQuestions && !shouldFetchMistakes && !shouldFetchFoldingEndpoint) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setInternalLoading(true);
    setInternalError(null);

    try {
      const tasks: Promise<void>[] = [];
      let failedPrimary = false;

      if (shouldFetchQuestions) {
        tasks.push(
          api<RawQuestionCatalogResponse>('/iqdb/questions', { signal: controller.signal })
            .then(result => {
              if (!controller.signal.aborted) setFetchedCatalog(result);
            })
            .catch(() => {
              if (!controller.signal.aborted) failedPrimary = true;
            }),
        );
      }

      if (shouldFetchMistakes) {
        tasks.push(
          api<RawMistakeEntry[]>('/review', { signal: controller.signal, cache: 'no-store' })
            .then(result => {
              if (!controller.signal.aborted) setFetchedMistakes(result);
            })
            .catch(() => {
              if (!controller.signal.aborted) setFetchedMistakes([]);
            }),
        );
      }

      if (shouldFetchFoldingEndpoint && foldingEndpoint) {
        tasks.push(
          api<RawArchetypeFoldingPayload>(foldingEndpoint, { signal: controller.signal })
            .then(result => {
              if (!controller.signal.aborted) setFetchedFolding(result);
            })
            .catch(() => {
              if (!controller.signal.aborted) setFetchedFolding(undefined);
            }),
        );
      }

      await Promise.all(tasks);
      if (!controller.signal.aborted && failedPrimary) {
        setInternalError('暂时无法读取题库内容，请稍后重试。');
      }
    } finally {
      if (!controller.signal.aborted) setInternalLoading(false);
    }
  }, [foldingEndpoint, shouldFetchFoldingEndpoint, shouldFetchMistakes, shouldFetchQuestions]);

  useEffect(() => {
    void reload();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void reload();
    };
    const onDeletion = () => {
      void reload();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === latestKey) void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener(latestKey, onDeletion);
    window.addEventListener('storage', onStorage);
    return () => {
      requestRef.current?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener(latestKey, onDeletion);
      window.removeEventListener('storage', onStorage);
    };
  }, [reload]);

  useEffect(() => () => {
    if (citeTimerRef.current !== null) window.clearTimeout(citeTimerRef.current);
  }, []);

  const rawQuestions: readonly RawBankQuestion[] = providedQuestions ?? fetchedCatalog?.questions ?? [];
  const rawMistakes: readonly RawMistakeEntry[] = providedMistakes ?? fetchedMistakes ?? [];
  const rawFolding: RawArchetypeFoldingPayload | null | undefined =
    providedFolding !== undefined
      ? providedFolding
      : (fetchedFolding ?? extractFoldingPayload(fetchedCatalog));

  const questions = useMemo(() => normalizeBankQuestions(rawQuestions), [rawQuestions]);
  const mistakes = useMemo(() => normalizeMistakeItems(rawMistakes), [rawMistakes]);
  const foldingResult = useMemo(
    () => normalizeArchetypeFolding(rawFolding, questions, mistakes),
    [rawFolding, questions, mistakes],
  );

  const query = searchText.trim().toLowerCase();

  const visibleClusters = useMemo(() => {
    const base = mistakesOnly ? filterClustersForMistakes(foldingResult.clusters) : foldingResult.clusters;
    if (!query) return base;
    return base.filter(cluster =>
      matchesSearch(query, [
        cluster.title,
        ...cluster.variationDimensions,
        ...cluster.members.flatMap(member => [member.title, member.sourceLabel, member.dateLabel, member.prompt]),
      ]),
    );
  }, [foldingResult.clusters, mistakesOnly, query]);

  const visibleStandalone = useMemo(() => {
    const base = mistakesOnly
      ? foldingResult.standaloneQuestions.filter(
          member => member.isMistake || member.mastery === 'weak' || member.mastery === 'due',
        )
      : foldingResult.standaloneQuestions;
    if (!query) return base;
    return base.filter(member =>
      matchesSearch(query, [member.title, member.sourceLabel, member.dateLabel, member.prompt]),
    );
  }, [foldingResult.standaloneQuestions, mistakesOnly, query]);

  const visibleQuestions = useMemo(() => {
    if (!query) return questions;
    return questions.filter(question =>
      matchesSearch(query, [question.title, question.prompt, question.sourceLabel, question.dateLabel]),
    );
  }, [questions, query]);

  const visibleMistakes = useMemo(() => {
    if (!query) return mistakes;
    return mistakes.filter(mistake =>
      matchesSearch(query, [mistake.title, mistake.prompt, mistake.answer, mistake.expected, mistake.explanation]),
    );
  }, [mistakes, query]);

  const unclusteredMistakes = useMemo(() => {
    if (!foldByArchetype || !mistakesOnly || foldingResult.status !== 'ready') return [];
    const coveredMistakeKeys = new Set<string>();
    for (const cluster of foldingResult.clusters) {
      for (const member of cluster.members) {
        if (member.mistakeEntry) coveredMistakeKeys.add(member.mistakeEntry.key);
      }
    }
    return visibleMistakes.filter(mistake => !coveredMistakeKeys.has(mistake.key));
  }, [foldByArchetype, foldingResult.clusters, foldingResult.status, mistakesOnly, visibleMistakes]);

  const navigateTo = useCallback(
    (href: string) => {
      if (onNavigate) onNavigate(href);
      else window.location.assign(href);
    },
    [onNavigate],
  );

  const handlePractice = useCallback(
    async (actionKey: string, payload: PracticeQuestionPayload) => {
      if (busyActionKey !== null) return;
      setActionNotice(null);
      if (onPracticeQuestion) {
        setBusyActionKey(actionKey);
        try {
          await onPracticeQuestion(payload);
        } catch (failure) {
          setActionNotice(failure instanceof Error ? failure.message : '暂时未能进入作答，请重试。');
        } finally {
          setBusyActionKey(null);
        }
        return;
      }

      if (payload.kind === 'mistake-retry' && payload.paperId) {
        navigateTo(
          paperPracticePath(payload.paperId),
        );
        return;
      }

      if (!payload.sourceRef) {
        setActionNotice('当前题目暂未绑定可直接开练的试卷入口。');
        return;
      }
      if (!watermark.ready) {
        setActionNotice('正在同步当前学习状态，请稍后再试。');
        return;
      }

      setBusyActionKey(actionKey);
      try {
        const receipt = await api<{ id: string }>('/iqdb/papers', {
          method: 'POST',
          body: { requestId: submissionId(), sourceRef: payload.sourceRef },
        });
        navigateTo(`/papers/${encodeURIComponent(receipt.id)}`);
      } catch (failure) {
        setActionNotice(failure instanceof ApiError ? failure.message : '暂时未能开卷，请重试。');
        setBusyActionKey(null);
      }
    },
    [busyActionKey, navigateTo, onPracticeQuestion, watermark.ready],
  );

  const handleCite = useCallback(
    async (citeKey: string, payload: CompanionCitationPayload) => {
      setActionNotice(null);
      if (onCiteToCompanion) {
        try {
          await onCiteToCompanion(payload);
          setCitedKey(citeKey);
          setActionNotice(`已将「${payload.title}」引用到学习同伴。`);
          if (citeTimerRef.current !== null) window.clearTimeout(citeTimerRef.current);
          citeTimerRef.current = window.setTimeout(() => setCitedKey(null), 2400);
        } catch (failure) {
          setActionNotice(failure instanceof Error ? failure.message : '暂时未能引用到学习同伴。');
        }
        return;
      }
      navigateTo('/companion');
    },
    [navigateTo, onCiteToCompanion],
  );

  const handleAuthorizeTeaching = useCallback(
    async (question: NormalizedBankQuestion) => {
      const teachingKey = `teaching:${question.sourceRef.id}`;
      setTeachingBusyKey(teachingKey);
      setTeachingNotice(null);
      try {
        const result = await api<{ id: string; rev: number; teachingAuthorized: boolean; changed: boolean }>(
          `/iqdb/questions/${encodeURIComponent(question.sourceRef.id)}/teaching`,
          {
            method: 'PUT',
            body: { requestId: requestId(), expectedRev: question.sourceRef.rev, allowed: true },
          },
        );
        setTeachingNotice({
          key: teachingKey,
          tone: 'success',
          text: result.changed ? '已允许用于出题与练习' : '该题已处于已授权状态',
        });
        void reload();
      } catch (failure) {
        const serverMessage =
          failure instanceof ApiError && failure.message && failure.message !== `HTTP ${failure.status}`
            ? failure.message
            : undefined;
        const text =
          serverMessage ??
          (failure instanceof ApiError && failure.status === 409
            ? '记录版本已更新，正在刷新最新状态…'
            : '暂时未能更新教学授权，请稍后重试。');
        setTeachingNotice({ key: teachingKey, tone: 'error', text });
        if (failure instanceof ApiError && failure.status === 409) {
          void reload();
        }
      } finally {
        setTeachingBusyKey(null);
      }
    },
    [reload],
  );

  const isLoading = externalLoading ?? internalLoading;
  const activeError = externalError ?? internalError;
  const showFoldedView = foldByArchetype && foldingResult.status === 'ready';
  const showUnavailableFallback = foldByArchetype && foldingResult.status !== 'ready';

  return (
    <section className="mv2-bank" aria-label="题库与错题">
      <div className="mv2-bank-toolbar">
        <div className="mv2-toggle-group" role="group" aria-label="题库视图切换">
          <button
            type="button"
            className="mv2-toggle-pill"
            aria-pressed={foldByArchetype}
            onClick={() => setFoldByArchetype(previous => !previous)}
          >
            <FoldIcon />
            <span>按母题折叠</span>
          </button>

          <button
            type="button"
            className="mv2-toggle-pill"
            aria-pressed={mistakesOnly}
            onClick={() => setMistakesOnly(previous => !previous)}
          >
            <MistakeIcon />
            <span>只看错题</span>
            {mistakes.length > 0 && <span className="mv2-toggle-badge">{mistakes.length}</span>}
          </button>
        </div>

        <label className="mv2-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="搜索题库与错题"
            value={searchText}
            onChange={event => setSearchText(event.target.value)}
            placeholder="搜索母题、题目或原卷来源…"
          />
          {searchText && (
            <button
              type="button"
              className="mv2-search-clear"
              aria-label="清除搜索词"
              onClick={() => setSearchText('')}
            >
              <Icon name="close" />
            </button>
          )}
        </label>

        {headerAction && <div className="mv2-toolbar-extra">{headerAction}</div>}
      </div>

      {actionNotice && (
        <div className="mv2-notice mv2-notice-soft" role="status" aria-live="polite">
          <span>{actionNotice}</span>
        </div>
      )}

      {activeError && (
        <div className="mv2-notice mv2-notice-error" role="alert">
          <span>{activeError}</span>
          {shouldFetchQuestions && (
            <button type="button" className="mv2-inline-link" onClick={() => void reload()}>
              重试
            </button>
          )}
        </div>
      )}

      {isLoading && !questions.length && !mistakes.length && foldingResult.clusters.length === 0 ? (
        <div className="mv2-empty-card" role="status">
          <p className="mv2-muted">正在整理题库与错题…</p>
        </div>
      ) : (
        <>
          {showUnavailableFallback && (
            <div className="mv2-notice mv2-notice-honest" role="status" data-folding-status={foldingResult.status}>
              <p className="mv2-notice-title">
                {foldingResult.status === 'unavailable'
                  ? '当前暂无母题归簇数据，已按平铺题库展示'
                  : '当前暂无可展示的母题归簇，已按平铺题库展示'}
              </p>
              <p className="mv2-notice-body">
                {mistakesOnly
                  ? '你仍可浏览全部待回看错题、重练原卷或引用给学习同伴。'
                  : '后端下发母题折叠投影后，将自动聚合原卷变式并给出代表题建议。'}
              </p>
            </div>
          )}

          {showFoldedView ? (
            <div className="mv2-stack">
              {visibleClusters.length > 0 ? (
                <div className="mv2-cluster-list">
                  {visibleClusters.map(cluster => (
                    <ArchetypeClusterCard
                      key={cluster.key}
                      cluster={cluster}
                      mistakesOnly={mistakesOnly}
                      busyActionKey={busyActionKey}
                      citedKey={citedKey}
                      onPractice={handlePractice}
                      onCite={handleCite}
                    />
                  ))}
                </div>
              ) : (
                <div className="mv2-empty-card">
                  <h3>{query ? '没有匹配的母题簇' : mistakesOnly ? '当前母题簇中没有待固或错题' : '还没有母题归簇'}</h3>
                  <p className="mv2-muted">
                    {query
                      ? '试试换一个关键词，或清空搜索查看全部母题。'
                      : mistakesOnly
                        ? '已稳母题已收起；你可以关闭「只看错题」浏览全部归簇。'
                        : '导入更多练习卷后，同源变式会自动收束到母题卡片中。'}
                  </p>
                </div>
              )}

              {visibleStandalone.length > 0 && (
                <section className="mv2-subsection" aria-label="未归入母题的单题">
                  <h3 className="mv2-subsection-title">未归入母题的单题（{visibleStandalone.length}）</h3>
                  <div className="mv2-card-grid">
                    {visibleStandalone.map(member => (
                      <StandaloneMemberCard
                        key={member.key}
                        member={member}
                        busyActionKey={busyActionKey}
                        citedKey={citedKey}
                        onPractice={handlePractice}
                        onCite={handleCite}
                      />
                    ))}
                  </div>
                </section>
              )}

              {unclusteredMistakes.length > 0 && (
                <section className="mv2-subsection" aria-label="其他待回看错题">
                  <h3 className="mv2-subsection-title">其他待回看错题（{unclusteredMistakes.length}）</h3>
                  <div className="mv2-card-grid">
                    {unclusteredMistakes.map(mistake => (
                      <MistakeCard
                        key={mistake.key}
                        mistake={mistake}
                        busyActionKey={busyActionKey}
                        citedKey={citedKey}
                        onPractice={handlePractice}
                        onCite={handleCite}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : mistakesOnly ? (
            visibleMistakes.length > 0 ? (
              <div className="mv2-card-grid">
                {visibleMistakes.map(mistake => (
                  <MistakeCard
                    key={mistake.key}
                    mistake={mistake}
                    busyActionKey={busyActionKey}
                    citedKey={citedKey}
                    onPractice={handlePractice}
                    onCite={handleCite}
                  />
                ))}
              </div>
            ) : (
              <div className="mv2-empty-card">
                <h3>{query ? '没有匹配的错题' : '还没有待回看的错题'}</h3>
                <p className="mv2-muted">
                  {query
                    ? '可以调整搜索词，或关闭「只看错题」查看全部题库。'
                    : '练习中答错的题目会自动收在这里，随时可回原卷重做或引用给同伴一起分析。'}
                </p>
              </div>
            )
          ) : visibleQuestions.length > 0 ? (
            <div className="mv2-card-grid">
              {visibleQuestions.map(question => (
                <FlatQuestionCard
                  key={question.key}
                  question={question}
                  busyActionKey={busyActionKey}
                  citedKey={citedKey}
                  teachingBusyKey={teachingBusyKey}
                  teachingNotice={teachingNotice}
                  onPractice={handlePractice}
                  onCite={handleCite}
                  onAuthorizeTeaching={handleAuthorizeTeaching}
                />
              ))}
            </div>
          ) : (
            <div className="mv2-empty-card">
              <h3>{query ? '没有匹配的题目' : '暂时没有获准用于学习的题目'}</h3>
              <p className="mv2-muted">
                {query
                  ? '试试清空搜索框，或切换到「只看错题」查看历史错题。'
                  : '导入试卷或交入学习材料后，题目会出现在这里。'}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
