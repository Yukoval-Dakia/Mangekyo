import { useMemo, useState } from 'react';
import type { Turn, TurnWorkspaceWitness } from '../api';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 不适合直接点开的内部元事实：系统记账、研究参数、规则快照等。
 * 保留用户能看懂、能顺藤摸瓜的用户事实。
 */
const SKIP_WITNESS_TYPES = new Set([
  'activity.studyTurn',
  'companion.researchSettings',
  'companion.researchRequest',
  'plan.rule',
  'plan.ruleRevision',
  'companion.modelRoute',
  'companion.usageLedger',
]);

const WITNESS_TYPE_LABELS: Record<string, string> = {
  'content.asset': '知识资产',
  'content.textbookPage': '教材页',
  'content.knowledgeEdge': '概念关系',
  'activity.textMaterial': '原件',
  'activity.workbookPaper': '试卷',
  'activity.workbookAttempt': '作答',
  'activity.workspaceEntry': '条目',
  'activity.studyRecord': '学习记录',
  'activity.organizerNote': '笔记',
  'companion.memoryAssertion': '记忆',
  'companion.claim': '断言',
  'companion.feedback': '回复',
  'learner.belief': '认知',
  'learner.misconception': '错因',
  'plan.goal': '目标',
  'plan.task': '任务',
  'predict.forecast': '预测',
};

function typeLabel(type: string | undefined): string {
  if (!type) return '依据';
  return WITNESS_TYPE_LABELS[type] ?? type.split('.').at(-1) ?? '依据';
}

function witnessHref(witness: TurnWorkspaceWitness): string | null {
  const id = witness.id;
  switch (witness.type) {
    case 'activity.textMaterial':
      return ULID_PATTERN.test(id) ? `/materials/saved/${encodeURIComponent(id)}` : null;
    case 'activity.workbookPaper':
      return ULID_PATTERN.test(id) ? `/papers/${encodeURIComponent(id)}` : null;
    case 'companion.memoryAssertion':
    case 'companion.claim':
    case 'learner.belief':
      return '/me?section=memory';
    case 'plan.goal':
      return '/me?section=goals';
    default:
      return ULID_PATTERN.test(id) ? `/materials/records/${encodeURIComponent(id)}` : null;
  }
}

export interface TurnBasisChip {
  readonly key: string;
  readonly badge: string;
  readonly label: string;
  readonly href: string | null;
}

function resolveWitnessTitle(
  witness: TurnWorkspaceWitness,
  readTitleById: ReadonlyMap<string, string>,
  writeTitleById: ReadonlyMap<string, string>,
): string {
  const direct = witness.title?.trim();
  if (direct) return direct;
  const viaReads = readTitleById.get(witness.id)?.trim();
  if (viaReads) return viaReads;
  const viaWrites = writeTitleById.get(witness.id)?.trim();
  if (viaWrites) return viaWrites;
  return typeLabel(witness.type);
}

/**
 * 归一化一条 AI 回复里用户能看懂、可点击的参考依据。
 * 按 id 去重、过滤内部元事实、补真实标题。
 */
function normalizeBasisChips(turn: Turn): TurnBasisChip[] {
  const readTitleById = new Map<string, string>();
  for (const item of turn.reads) {
    if (item.title?.trim() && !readTitleById.has(item.id)) {
      readTitleById.set(item.id, item.title);
    }
  }
  const writeTitleById = new Map<string, string>();
  for (const item of turn.writes ?? []) {
    if (item.title?.trim() && !writeTitleById.has(item.id)) {
      writeTitleById.set(item.id, item.title);
    }
  }

  const chips: TurnBasisChip[] = [];
  const seen = new Set<string>();

  for (const witness of turn.workspaceBasis ?? []) {
    if (!witness?.id) continue;
    if (witness.type && SKIP_WITNESS_TYPES.has(witness.type)) continue;
    const key = `${witness.id}:${witness.rev}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = resolveWitnessTitle(witness, readTitleById, writeTitleById);
    chips.push({
      key,
      badge: typeLabel(witness.type),
      label: title,
      href: witnessHref(witness),
    });
  }

  for (const item of turn.reads) {
    if (!item.id || !item.title?.trim()) continue;
    if (!ULID_PATTERN.test(item.id)) continue;
    const key = `read:${item.id}`;
    if (seen.has(key)) continue;
    let alreadyCovered = false;
    for (const existing of seen) {
      if (existing.startsWith(`${item.id}:`)) { alreadyCovered = true; break; }
    }
    if (alreadyCovered) continue;
    seen.add(key);
    chips.push({
      key,
      badge: '读取',
      label: item.title.trim(),
      href: `/materials/records/${encodeURIComponent(item.id)}`,
    });
  }

  return chips;
}

const COLLAPSED_LIMIT = 5;

export function TurnBasisChips({ turn }: { turn: Turn }) {
  const [expanded, setExpanded] = useState(false);
  const chips = useMemo(() => normalizeBasisChips(turn), [turn]);
  if (chips.length === 0) return null;
  const visible = expanded ? chips : chips.slice(0, COLLAPSED_LIMIT);
  const hidden = chips.length - visible.length;

  return (
    <div className="turn-basis" aria-label="本轮回复参考依据">
      <span className="turn-basis-label">参考依据（{chips.length}）</span>
      <div className="turn-basis-chips">
        {visible.map(chip =>
          chip.href ? (
            <a key={chip.key} className="turn-basis-chip" href={chip.href} title={`${chip.badge} · ${chip.label}`}>
              <span className="turn-basis-badge">{chip.badge}</span>
              <span className="turn-basis-text">{chip.label}</span>
            </a>
          ) : (
            <span key={chip.key} className="turn-basis-chip turn-basis-chip--static" title={`${chip.badge} · ${chip.label}`}>
              <span className="turn-basis-badge">{chip.badge}</span>
              <span className="turn-basis-text">{chip.label}</span>
            </span>
          ),
        )}
        {!expanded && hidden > 0 && (
          <button
            type="button"
            className="turn-basis-chip turn-basis-chip--more"
            onClick={() => setExpanded(true)}
            aria-label={`展开其余 ${hidden} 条依据`}
          >
            +{hidden}
          </button>
        )}
        {expanded && chips.length > COLLAPSED_LIMIT && (
          <button
            type="button"
            className="turn-basis-chip turn-basis-chip--more"
            onClick={() => setExpanded(false)}
            aria-label="收起依据"
          >
            收起
          </button>
        )}
      </div>
    </div>
  );
}
