import type { Turn, TurnWorkspaceWitness } from '../api';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CITE_PATTERN = /\[\[cite:([0-9A-HJKMNP-TV-Z]{26})\]\]/g;
const CODE_SPLIT_PATTERN = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;
const PENDING_CITE_TAIL = /\[\[?\s*(?:c(?:i(?:t(?:e(?::[0-9A-HJKMNP-TV-Z]{0,26}\]?)?)?)?)?)?$/;

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

const WITNESS_KIND_LABELS: Record<string, string> = {
  concept: '概念',
  question: '题目',
  discipline: '学科',
  method: '方法',
  archetype: '题型',
  note: '笔记',
  textbook: '教材',
  paper: '试卷',
  attempt: '作答',
  material: '原件',
  memory: '记忆',
  goal: '目标',
  misconception: '错因',
};

function typeLabel(type: string | undefined): string {
  if (!type) return '依据';
  return WITNESS_TYPE_LABELS[type] ?? type.split('.').at(-1) ?? '依据';
}

function witnessBadge(witness: TurnWorkspaceWitness): string {
  const kind = witness.kind?.trim();
  if (kind && WITNESS_KIND_LABELS[kind]) return WITNESS_KIND_LABELS[kind];
  return typeLabel(witness.type);
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
  readonly id: string;
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
export function normalizeBasisChips(turn: Turn): TurnBasisChip[] {
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
      id: witness.id,
      badge: witnessBadge(witness),
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
      id: item.id,
      badge: '读取',
      label: item.title.trim(),
      href: `/materials/records/${encodeURIComponent(item.id)}`,
    });
  }

  return chips;
}

export interface IndexedCitation extends TurnBasisChip {
  /** 1-based 稳定递增序号，与正文 [[cite:ULID]] 出现顺序 100% 对齐。 */
  readonly index: number;
}

export interface ResolvedTurnCitations {
  readonly byId: ReadonlyMap<string, IndexedCitation>;
  readonly cited: readonly IndexedCitation[];
  readonly background: readonly TurnBasisChip[];
  readonly all: readonly TurnBasisChip[];
}

/**
 * 解析正文 [[cite:ULID]] 标签，按出现顺序分配稳定编号，
 * 仅命中白名单（workspaceBasis + 合法 reads）的 ID 才分配编号。
 */
export function resolveTurnCitations(turn: Turn): ResolvedTurnCitations {
  const all = normalizeBasisChips(turn);
  const whitelistById = new Map<string, TurnBasisChip>();
  for (const chip of all) {
    if (!whitelistById.has(chip.id)) whitelistById.set(chip.id, chip);
  }

  const byId = new Map<string, IndexedCitation>();
  const cited: IndexedCitation[] = [];
  const citedIds = new Set<string>();
  const segments = turn.message.split(CODE_SPLIT_PATTERN);

  let nextIndex = 1;
  for (let index = 0; index < segments.length; index += 2) {
    const segment = segments[index];
    if (!segment) continue;
    for (const match of segment.matchAll(CITE_PATTERN)) {
      const id = match[1]!;
      if (citedIds.has(id)) continue;
      const chip = whitelistById.get(id);
      if (!chip) continue;
      const indexed: IndexedCitation = { ...chip, index: nextIndex };
      nextIndex += 1;
      byId.set(id, indexed);
      cited.push(indexed);
      citedIds.add(id);
    }
  }

  const background = all.filter(chip => !citedIds.has(chip.id));
  return { byId, cited, background, all };
}

/**
 * 静默剥离非代码段末尾未闭合的 `[[cite:...` 尾巴，防流式吐字闪烁半截标签。
 */
export function stripPendingCiteTail(text: string): string {
  if (!text.includes('[')) return text;
  return text
    .split(CODE_SPLIT_PATTERN)
    .map((part, index) => (index % 2 ? part : part.replace(PENDING_CITE_TAIL, '')))
    .join('');
}

/**
 * 静默剥离所有 `[[cite:...]]` 标签（含未闭合尾巴），用于纯文本朗读 / 兜底展示。
 */
export function stripCitationsText(text: string): string {
  if (!text.includes('[')) return text;
  return text
    .split(CODE_SPLIT_PATTERN)
    .map((part, index) =>
      index % 2 ? part : part.replace(CITE_PATTERN, '').replace(PENDING_CITE_TAIL, ''),
    )
    .join('');
}

/**
 * 把正文 `[[cite:ULID]]` 变换为 Markdown 上标链接 `[N](#mk-cite-ULID)`：
 * - 命中白名单：替换为 `[index](#mk-cite-id)`（hash 锚点不会被 react-markdown 清洗）；
 * - 未命中（假 ID / 流式无白名单态）：静默剥离（防幻觉双保险）。
 * 代码块与行内代码段原样不动。
 */
export function transformCitationsToMarkdown(
  text: string,
  citations?: ReadonlyMap<string, IndexedCitation>,
): string {
  if (!text.includes('[')) return text;
  return text
    .split(CODE_SPLIT_PATTERN)
    .map((part, index) => {
      if (index % 2) return part;
      const stripped = part.replace(PENDING_CITE_TAIL, '');
      return stripped.replace(CITE_PATTERN, (whole, id: string) => {
        const entry = citations?.get(id);
        return entry ? `[${entry.index}](#mk-cite-${id})` : '';
      });
    })
    .join('');
}
