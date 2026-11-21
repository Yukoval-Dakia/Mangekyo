import {Suspense, lazy, useCallback} from 'react';
import {MaterialsSurface} from './materials-v2/MaterialsSurface';
import type {CompanionCitationPayload, PracticeQuestionPayload} from './materials-v2/types';
import {KnowledgeGraphView} from './knowledge-graph/KnowledgeGraphView';
import type {KnowledgeGraphNode} from './knowledge-graph/types';
import IssuedPapers from './issued-papers';
import {Organizer} from './organizer';
import type {Material} from './workspace';
import type {CompanionCitation} from './today-v2';

const StudioTextbooks = lazy(() => import('./textbook/StudioTextbooks'));

export type CiteToCompanion = (citation: CompanionCitation) => void;

function formatGraphCitation(node: KnowledgeGraphNode): CompanionCitation {
  const mastery = node.mastery;
  const lines = [
    `知识图谱节点：${node.title}`,
    `掌握状态：${mastery.status}；独立作答 ${mastery.independentCount} 次；关联题 ${node.counts.questions}、教材 ${node.counts.textbooks}、笔记 ${node.counts.notes}`,
  ];
  if (mastery.retrievability !== null) lines.push(`可提取性估计：${Math.round(mastery.retrievability * 100)}%`);
  return { title: node.title, text: lines.join('\n'), topic: '知识图谱' };
}

function formatBankCitation(payload: CompanionCitationPayload): CompanionCitation {
  const kindLabel = payload.kind === 'archetype' ? '母题' : payload.kind === 'mistake' ? '错题' : '题目';
  const lines = [`${kindLabel}：${payload.title}`];
  if (payload.archetypeTitle) lines.push(`所属母题：${payload.archetypeTitle}`);
  if (payload.sourceLabel) lines.push(`出处：${payload.sourceLabel}`);
  if (payload.mastery) lines.push(`掌握状态：${payload.mastery}`);
  if (payload.prompt) lines.push(`题干：${payload.prompt.slice(0, 600)}`);
  if (payload.lastAnswer) lines.push(`上次作答：${payload.lastAnswer.slice(0, 300)}`);
  if (payload.expected) lines.push(`参考结果：${payload.expected.slice(0, 300)}`);
  return { title: payload.title, text: lines.join('\n'), topic: kindLabel };
}

export function MaterialsPage({
  materials,
  onNavigate,
  onCaptureMaterial,
  onCiteToCompanion,
  onPracticeQuestion,
}: {
  materials: readonly Material[];
  onNavigate: (href: string) => void;
  onCaptureMaterial: () => void;
  onCiteToCompanion?: CiteToCompanion;
  onPracticeQuestion?: (payload: PracticeQuestionPayload) => void | Promise<void>;
}) {
  const citeToCompanion = useCallback(
    (citation: CompanionCitation) => onCiteToCompanion?.(citation),
    [onCiteToCompanion],
  );

  const handleGraphCite = useCallback(
    (node: KnowledgeGraphNode) => citeToCompanion(formatGraphCitation(node)),
    [citeToCompanion],
  );

  const handleBankCite = useCallback(
    async (payload: CompanionCitationPayload) => {
      citeToCompanion(formatBankCitation(payload));
    },
    [citeToCompanion],
  );

  const handleSelectQuestion = useCallback(() => {
    onNavigate('/materials?tab=bank');
  }, [onNavigate]);

  return (
    <MaterialsSurface
      syncUrl
      historyMode="push"
      onNavigate={onNavigate}
      onCaptureMaterial={onCaptureMaterial}
      bankProps={{
        onCiteToCompanion: handleBankCite,
        ...(onPracticeQuestion ? {onPracticeQuestion} : {}),
        onNavigate,
      }}
      renderGraph={() => (
        <KnowledgeGraphView
          onSelectQuestion={handleSelectQuestion}
          onCiteToCompanion={handleGraphCite}
        />
      )}
      renderTextbooks={() => (
        <Suspense fallback={<p role="status">正在打开教材…</p>}>
          <StudioTextbooks editor={false} openAccess={() => onNavigate('/textbooks/page')} />
        </Suspense>
      )}
      renderPapers={() => (
        <div className="mv2-stack">
          <IssuedPapers />
          <div className="mv2-entry-grid">
            <a className="mv2-entry-tile" href="/papers" onClick={event => {event.preventDefault(); onNavigate('/papers');}}>
              <span className="mv2-entry-badge">练习卷</span>
              <strong className="mv2-entry-title">我的试卷</strong>
              <span className="mv2-entry-detail">继续未完成练习、查看作答记录或手动编组新卷。</span>
            </a>
            <a className="mv2-entry-tile" href="/classroom" onClick={event => {event.preventDefault(); onNavigate('/classroom');}}>
              <span className="mv2-entry-badge">互动课堂</span>
              <strong className="mv2-entry-title">学习型课堂</strong>
              <span className="mv2-entry-detail">进入分步讲解与互动板书课堂，按节奏攻克薄弱环节。</span>
            </a>
          </div>
        </div>
      )}
      renderOriginals={() => (
        <div className="mv2-stack">
          <div className="mv2-entry-grid">
            <a className="mv2-entry-tile" href="/intake" onClick={event => {event.preventDefault(); onNavigate('/intake');}}>
              <span className="mv2-entry-badge">导入切片</span>
              <strong className="mv2-entry-title">原件库与拍卷切片</strong>
              <span className="mv2-entry-detail">导入 PDF、纸卷照片与讲义原件，自动切分并追溯出处。</span>
            </a>
            <a className="mv2-entry-tile" href="/materials/workspace" onClick={event => {event.preventDefault(); onNavigate('/materials/workspace');}}>
              <span className="mv2-entry-badge">外部只读</span>
              <strong className="mv2-entry-title">同伴工作区与 Notion 来源</strong>
              <span className="mv2-entry-detail">查看已授权的只读外部笔记来源、引用范围与同步状态。</span>
            </a>
          </div>
          <Organizer section="notes" materials={materials} />
        </div>
      )}
    />
  );
}
