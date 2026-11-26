import { useId, useMemo, useState } from 'react';
import { Icon } from '../icons';
import { formatMasterySummary, MASTERY_META, normalizeArchetypeFolding } from './archetype-adapter';
import { CiteIcon, PromptDisclosure, ViewProvenanceLink } from './ProvenanceWidgets';
import type {
  ArchetypeClustersPanelProps,
  CompanionCitationPayload,
  NormalizedArchetypeCluster,
  NormalizedArchetypeConflict,
  PracticeQuestionPayload,
  RepresentativeStatus,
} from './types';

const REPRESENTATIVE_DISABLED_NOTE: Readonly<Record<Exclude<RepresentativeStatus, 'actionable'>, string>> = {
  all_steady: '本母题下题目均已稳',
  unknown_only: '掌握度尚待核对，暂不指派代表题',
  no_handle: '暂无可开练的未稳代表题',
};

function ConflictIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.2h.01" />
    </svg>
  );
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

function formatCoverageHeadline(cluster: NormalizedArchetypeCluster): string {
  const dimensionSuffix =
    cluster.variationDimensionCounts.length > 0
      ? ` · ${cluster.variationDimensionCounts.length} 个变形维度`
      : '';
  if (cluster.originalCount > 0) {
    return `学透此母题覆盖 ${cluster.originalCount} 道原卷题${dimensionSuffix}`;
  }
  return `学透此母题覆盖 ${cluster.coveredQuestionCount} 道题${dimensionSuffix}`;
}

function ArchetypeClusterCoverageCard({
  cluster,
  mistakesOnly,
  busyActionKey,
  citedKey,
  onPractice,
  onCite,
  onNavigate,
}: {
  readonly cluster: NormalizedArchetypeCluster;
  readonly mistakesOnly: boolean;
  readonly busyActionKey: string | null;
  readonly citedKey: string | null;
  readonly onPractice?: ((actionKey: string, payload: PracticeQuestionPayload) => void) | undefined;
  readonly onCite?: ((citeKey: string, payload: CompanionCitationPayload) => void) | undefined;
  readonly onNavigate?: ((href: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAllInMistakes, setShowAllInMistakes] = useState(false);
  const panelId = useId();
  const summary = formatMasterySummary(cluster);
  const actionableRep = cluster.actionableRepresentative;
  const displayRep = actionableRep ?? cluster.representativeMember ?? cluster.members[0];
  const repMasteryMeta = displayRep ? MASTERY_META[displayRep.mastery] : null;
  const repActionKey = `rep:${cluster.key}`;
  const clusterCiteKey = `cite-cluster:${cluster.key}`;
  const coverageHeadline = formatCoverageHeadline(cluster);

  const filteredMembers = useMemo(() => {
    if (!mistakesOnly || showAllInMistakes) return cluster.members;
    const focused = cluster.members.filter(
      member => member.isMistake || member.mastery === 'weak' || member.mastery === 'due',
    );
    return focused.length > 0 ? focused : cluster.members;
  }, [cluster.members, mistakesOnly, showAllInMistakes]);

  const representativeHint = actionableRep
    ? [actionableRep.sourceLabel, actionableRep.positionLabel].filter(Boolean).join(' · ')
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
              <span className="mv2-kicker-tag">母题聚簇</span>
              <span className="mv2-coverage-banner">{coverageHeadline}</span>
              {repMasteryMeta && (
                <span className={`mv2-pill mv2-pill-${repMasteryMeta.tone}`}>
                  代表题 · {repMasteryMeta.label}
                </span>
              )}
              {cluster.hasMistake && <span className="mv2-pill mv2-pill-weak">含错题</span>}
            </div>

            <h3 className="mv2-cluster-title">{cluster.title}</h3>

            <div className="mv2-count-row">
              <span className="mv2-count-primary">{summary.primary}</span>
              <span className="mv2-origin-chip">原卷题 {cluster.originalCount}</span>
              <span className="mv2-origin-chip">非卷题 {cluster.nonPaperCount}</span>
              {summary.unknownNote && (
                <span className="mv2-pill mv2-pill-unknown">{summary.unknownNote}</span>
              )}
            </div>

            {cluster.variationDimensionCounts.length > 0 && (
              <div className="mv2-dimension-row" aria-label="变形维度">
                {cluster.variationDimensionCounts.map(({ dimension, evidenceCount }) => (
                  <span key={dimension} className="mv2-dimension-chip">
                    <span>{dimension}</span>
                    {evidenceCount > 0 && (
                      <span className="mv2-dimension-count" aria-label={`${evidenceCount} 条变式依据`}>
                        ×{evidenceCount}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}

            <MasteryBar cluster={cluster} />
          </div>

          <span className="mv2-expand-indicator" aria-hidden="true">
            <span>{expanded ? '收起成员题' : `展开 ${cluster.coveredQuestionCount} 道题`}</span>
            <span className="mv2-chevron">
              <Icon name="chevron" />
            </span>
          </span>
        </button>

        {cluster.variants.length > 0 && (
          <div className="mv2-variant-edges" aria-label="变式连边">
            <span className="mv2-variant-edges-label">变式连边</span>
            <ul className="mv2-variant-edge-list">
              {cluster.variants.slice(0, expanded ? cluster.variants.length : 2).map(edge => (
                <li key={edge.key} className="mv2-variant-edge-item">
                  <span className="mv2-variant-edge-path">
                    {edge.fromLabel} → {edge.toLabel}
                  </span>
                  <span className="mv2-variant-edge-changes">
                    {edge.changed.map(change => (
                      <span key={change} className="mv2-dimension-chip">{change}</span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mv2-cluster-actions">
          <div className="mv2-practice-slot">
            <button
              type="button"
              className="mv2-btn mv2-btn-primary"
              disabled={!actionableRep || busyActionKey !== null || !onPractice}
              onClick={() => {
                if (!actionableRep || !onPractice) return;
                onPractice(repActionKey, {
                  kind: 'archetype-representative',
                  title: actionableRep.title,
                  archetypeTitle: cluster.title,
                  mastery: actionableRep.mastery,
                  ...(actionableRep.prompt ? { prompt: actionableRep.prompt } : {}),
                  ...(actionableRep.practice ? { practice: actionableRep.practice } : {}),
                  ...(actionableRep.questionRef ? { sourceRef: actionableRep.questionRef } : {}),
                  ...(representativeHint ? { anchorLabel: representativeHint } : {}),
                });
              }}
            >
              {busyActionKey === repActionKey ? '正在开练…' : '练代表题'}
            </button>
            {actionableRep && representativeHint ? (
              <span className="mv2-action-hint">代表题：{representativeHint}</span>
            ) : cluster.representativeStatus !== 'actionable' ? (
              <span className="mv2-action-hint">{REPRESENTATIVE_DISABLED_NOTE[cluster.representativeStatus]}</span>
            ) : null}
          </div>

          <div className="mv2-cluster-secondary-actions">
            {onCite && (
              <button
                type="button"
                className="mv2-btn mv2-btn-ghost"
                onClick={() =>
                  onCite(clusterCiteKey, {
                    kind: 'archetype',
                    title: cluster.title,
                    archetypeTitle: cluster.title,
                    sourceLabel: `${coverageHeadline} · ${summary.primary}${summary.unknownNote ? ` · ${summary.unknownNote}` : ''}`,
                    ...(displayRep?.prompt ? { prompt: displayRep.prompt } : {}),
                    ...(displayRep?.mastery ? { mastery: displayRep.mastery } : {}),
                    ...(displayRep?.questionRef ? { questionRef: displayRep.questionRef } : {}),
                  })
                }
              >
                <CiteIcon />
                <span>{citedKey === clusterCiteKey ? '已引用到同伴' : '引用到同伴'}</span>
              </button>
            )}
            {displayRep?.questionRef && (
              <ViewProvenanceLink id={displayRep.questionRef.id} onNavigate={onNavigate} />
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div id={panelId} className="mv2-cluster-panel">
          <div className="mv2-panel-header">
            <span>
              {mistakesOnly && !showAllInMistakes && filteredMembers.length < cluster.members.length
                ? `已筛选待固与错题（${filteredMembers.length} / ${cluster.members.length} 题）`
                : `簇内已获准题目（原卷 ${cluster.originalCount} · 非卷 ${cluster.nonPaperCount}）`}
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
              const isActionableRep = actionableRep?.key === member.key;
              const isDesignatedRep = !isActionableRep && displayRep?.key === member.key;
              const memberPracticeKey = `member:${cluster.key}:${member.key}`;
              const memberCiteKey = `cite-member:${cluster.key}:${member.key}`;
              const masteryMeta = MASTERY_META[member.mastery];
              const anchorParts = [member.sourceLabel, member.positionLabel].filter(Boolean).join(' · ');
              const canPracticeMember =
                Boolean(onPractice) && member.practiceEligible && Boolean(member.practice || member.questionRef);
              return (
                <li key={member.key} className="mv2-member-item">
                  <div className="mv2-member-meta">
                    <time className="mv2-anchor-date" dateTime={member.dateLabel ?? undefined}>
                      {member.dateLabel ?? '日期未记'}
                    </time>
                    <span className="mv2-anchor-source">{anchorParts}</span>
                    <span className="mv2-origin-chip">
                      {member.origin === 'original' ? '原卷题' : '非卷题'}
                    </span>
                    <span className={`mv2-pill mv2-pill-${masteryMeta.tone}`}>
                      {masteryMeta.label}
                    </span>
                    {isActionableRep && <span className="mv2-pill mv2-pill-rep">未稳代表题</span>}
                    {isDesignatedRep && <span className="mv2-pill mv2-pill-rep">代表题</span>}
                    {member.isMistake && <span className="mv2-pill mv2-pill-weak">错题记录</span>}
                  </div>

                  {member.title !== anchorParts && (
                    <p className="mv2-member-title">{member.title}</p>
                  )}

                  <PromptDisclosure prompt={member.prompt} />

                  <div className="mv2-item-actions">
                    {canPracticeMember && onPractice && (
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
                    {onCite && (
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
                        <span>{citedKey === memberCiteKey ? '已引用' : '引用到同伴'}</span>
                      </button>
                    )}
                    <ViewProvenanceLink id={member.questionRef?.id} onNavigate={onNavigate} />
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

function ArchetypeConflictsAlert({ conflicts }: { readonly conflicts: readonly NormalizedArchetypeConflict[] }) {
  if (conflicts.length === 0) return null;
  return (
    <aside className="mv2-conflict-banner" role="alert" aria-label="多母题归属冲突提示">
      <div className="mv2-conflict-head">
        <span className="mv2-conflict-icon">
          <ConflictIcon />
        </span>
        <div>
          <h3>发现 {conflicts.length} 道题目存在多母题归属冲突</h3>
          <p>
            系统未静默丢弃这些题目，已暂停自动折叠归并，等待确认主归属母题。
          </p>
        </div>
      </div>
      <ul className="mv2-conflict-list">
        {conflicts.map(conflict => (
          <li key={conflict.key} className="mv2-conflict-item">
            <span className="mv2-conflict-question">{conflict.questionLabel}</span>
            <div className="mv2-conflict-groups">
              {conflict.groupLabels.map(groupLabel => (
                <span key={groupLabel} className="mv2-pill mv2-pill-due">{groupLabel}</span>
              ))}
              <span className="mv2-origin-chip">{conflict.membershipCount} 条归属记录</span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function ArchetypeClustersPanel({
  clusters: providedClusters,
  projection,
  conflicts: providedConflicts,
  catalogQuestions,
  mistakes,
  mistakesOnly = false,
  busyActionKey = null,
  citedKey = null,
  onPractice,
  onCite,
  onNavigate,
  showSummaryHeader = true,
  emptyMode = 'hidden',
  emptyTitle = '还没有母题归簇',
  emptyDescription = '导入更多练习卷后，同源变式会自动收束到母题覆盖卡中。',
}: ArchetypeClustersPanelProps) {
  const normalizedProjection = useMemo(
    () => (projection ? normalizeArchetypeFolding(projection, catalogQuestions, mistakes) : null),
    [catalogQuestions, mistakes, projection],
  );

  const clusters = providedClusters ?? normalizedProjection?.clusters ?? [];
  const conflicts = providedConflicts ?? normalizedProjection?.conflicts ?? [];

  const totals = useMemo(() => {
    let original = 0;
    let nonPaper = 0;
    const dimensions = new Set<string>();
    for (const cluster of clusters) {
      original += cluster.originalCount;
      nonPaper += cluster.nonPaperCount;
      for (const dim of cluster.variationDimensions) dimensions.add(dim);
    }
    return { original, nonPaper, dimensionCount: dimensions.size };
  }, [clusters]);

  if (clusters.length === 0 && conflicts.length === 0) {
    if (emptyMode === 'hidden') return null;
    return (
      <div className="mv2-empty-card">
        <h3>{emptyTitle}</h3>
        <p className="mv2-muted">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="mv2-archetype-panel">
      {showSummaryHeader && clusters.length > 0 && (
        <div className="mv2-coverage-ribbon" role="status">
          <div className="mv2-coverage-ribbon-main">
            <span className="mv2-kicker-tag">母题聚簇覆盖</span>
            <strong>
              {clusters.length} 个母题簇 · 覆盖 {totals.original} 道原卷题
              {totals.nonPaper > 0 ? ` + ${totals.nonPaper} 道非卷题` : ''}
            </strong>
          </div>
          {totals.dimensionCount > 0 && (
            <span className="mv2-origin-chip">提炼 {totals.dimensionCount} 种变形维度</span>
          )}
        </div>
      )}

      <ArchetypeConflictsAlert conflicts={conflicts} />

      {clusters.length > 0 ? (
        <div className="mv2-cluster-list">
          {clusters.map(cluster => (
            <ArchetypeClusterCoverageCard
              key={cluster.key}
              cluster={cluster}
              mistakesOnly={mistakesOnly}
              busyActionKey={busyActionKey}
              citedKey={citedKey}
              onPractice={onPractice}
              onCite={onCite}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : emptyMode === 'card' ? (
        <div className="mv2-empty-card">
          <h3>{emptyTitle}</h3>
          <p className="mv2-muted">{emptyDescription}</p>
        </div>
      ) : null}
    </div>
  );
}
