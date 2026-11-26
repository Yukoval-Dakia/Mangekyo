import type {
  BankQuestionStatus,
  NormalizedArchetypeCluster,
  NormalizedArchetypeConflict,
  NormalizedArchetypeMember,
  NormalizedArchetypeVariant,
  NormalizedBankQuestion,
  NormalizedFoldingResult,
  NormalizedMasteryCounts,
  NormalizedMasteryState,
  NormalizedMistakeItem,
  NormalizedVariationDimension,
  PracticeHandle,
  QuestionVersionRef,
  RawAnchorLike,
  RawArchetypeConflict,
  RawArchetypeFoldingCard,
  RawArchetypeFoldingPayload,
  RawArchetypeMember,
  RawBankQuestion,
  RawMistakeEntry,
  RawQuestionCatalogResponse,
  RawWitnessLike,
  RepresentativeStatus,
} from './types';
import { paperPracticePath } from '../builtin-packs';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

export const MASTERY_META: Readonly<Record<NormalizedMasteryState, { readonly label: string; readonly tone: NormalizedMasteryState }>> = {
  steady: { label: '已稳', tone: 'steady' },
  due: { label: '待固', tone: 'due' },
  weak: { label: '未稳', tone: 'weak' },
  unknown: { label: '尚待核对', tone: 'unknown' },
};

export const BANK_STATUS_LABELS: Readonly<Record<BankQuestionStatus, string>> = {
  draft: '草稿',
  needs_verification: '待核验',
  restricted: '已限制发放',
  release_ready: '可开练',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanHumanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || ULID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function normalizeMastery(rawMastery: unknown, rawState?: unknown): NormalizedMasteryState {
  const candidate = typeof rawMastery === 'string' && rawMastery.trim()
    ? rawMastery.trim().toLowerCase()
    : typeof rawState === 'string' && rawState.trim()
      ? rawState.trim().toLowerCase()
      : '';
  if (candidate === 'steady' || candidate === 'due' || candidate === 'weak' || candidate === 'unknown') {
    return candidate;
  }
  if (candidate === 'decaying') return 'due';
  if (candidate === 'fragile') return 'weak';
  return 'unknown';
}

function extractQuestionRef(witness: RawWitnessLike | undefined): QuestionVersionRef | undefined {
  if (!witness || typeof witness.id !== 'string' || !witness.id.trim()) return undefined;
  const rev = typeof witness.rev === 'number' && Number.isSafeInteger(witness.rev) && witness.rev > 0
    ? witness.rev
    : 1;
  return { id: witness.id.trim(), rev };
}

function extractPracticeHandle(value: unknown): PracticeHandle | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind !== 'activity') return undefined;
  if (typeof value.id !== 'string' || !value.id.trim()) return undefined;
  if (typeof value.rev !== 'number' || !Number.isSafeInteger(value.rev) || value.rev <= 0) return undefined;
  return {
    ...value,
    kind: 'activity',
    id: value.id.trim(),
    rev: value.rev,
  };
}

function formatDateAnchor(anchor: RawAnchorLike | null | undefined, fallbackDate?: unknown): string | null {
  const candidates = [
    anchor?.date,
    anchor?.occurredAt,
    anchor?.paperDate,
    anchor?.createdAt,
    fallbackDate,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const isoMatch = ISO_DATE_PREFIX.exec(trimmed);
    if (isoMatch?.[1]) return isoMatch[1];
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      const date = new Date(parsed);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }
  return null;
}

function formatPositionAnchor(anchor: RawAnchorLike | null | undefined): string | null {
  if (!anchor) return null;
  if (typeof anchor.position === 'number' && Number.isFinite(anchor.position) && anchor.position > 0) {
    return `第 ${anchor.position} 题`;
  }
  const positionText = cleanHumanText(anchor.position) ?? cleanHumanText(anchor.questionNumber) ?? cleanHumanText(anchor.label);
  if (!positionText) return null;
  if (/^\d+$/.test(positionText)) return `第 ${positionText} 题`;
  return positionText;
}

function formatSourceLabel(
  member: RawArchetypeMember,
  origin: 'original' | 'non-paper',
  catalogQuestion?: NormalizedBankQuestion,
): string {
  const anchor = member.anchor;
  const label =
    cleanHumanText(anchor?.paperTitle) ??
    cleanHumanText(anchor?.sourceLabel) ??
    cleanHumanText(anchor?.sourceTitle) ??
    cleanHumanText(anchor?.paperName) ??
    cleanHumanText(anchor?.examTitle) ??
    cleanHumanText(member.paperTitle) ??
    cleanHumanText(member.sourceLabel) ??
    cleanHumanText(anchor?.title) ??
    cleanHumanText(catalogQuestion?.sourceLabel);
  if (label) return label;
  return origin === 'original' ? '原卷题目' : '题库单题';
}

function isRevokedRecord(record: {
  readonly revoked?: boolean;
  readonly authorized?: boolean;
  readonly withdrawn?: boolean;
}): boolean {
  return record.revoked === true || record.authorized === false || record.withdrawn === true;
}

function normalizeStatus(rawStatus: string): BankQuestionStatus {
  if (
    rawStatus === 'draft' ||
    rawStatus === 'needs_verification' ||
    rawStatus === 'restricted' ||
    rawStatus === 'release_ready'
  ) {
    return rawStatus;
  }
  return 'needs_verification';
}

export function normalizeBankQuestions(rawQuestions: readonly RawBankQuestion[] | undefined): NormalizedBankQuestion[] {
  if (!Array.isArray(rawQuestions)) return [];
  const results: NormalizedBankQuestion[] = [];
  for (const item of rawQuestions) {
    if (!item || typeof item.id !== 'string' || !item.id.trim()) continue;
    if (isRevokedRecord(item)) continue;
    const status = normalizeStatus(item.status);
    if (status === 'restricted') continue;
    const rev = Number.isSafeInteger(item.rev) && item.rev > 0 ? item.rev : 1;
    const title = cleanHumanText(item.title) ?? '未命名题目';
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    const dateLabel = formatDateAnchor(null, item.date);
    const sourceLabel = cleanHumanText(item.sourceLabel);
    const hasExplicitMastery = typeof item.mastery === 'string' || typeof item.state === 'string';
    results.push({
      key: `${item.id}:${rev}`,
      sourceRef: { id: item.id.trim(), rev },
      title,
      prompt,
      status,
      statusLabel: BANK_STATUS_LABELS[status],
      canPractice: status === 'release_ready',
      teachingAuthorized: item.teachingAuthorized !== false,
      ...(hasExplicitMastery ? { mastery: normalizeMastery(item.mastery, item.state) } : {}),
      ...(sourceLabel ? { sourceLabel } : {}),
      ...(dateLabel ? { dateLabel } : {}),
    });
  }
  return results;
}

export function normalizeMistakeItems(rawMistakes: readonly RawMistakeEntry[] | undefined): NormalizedMistakeItem[] {
  if (!Array.isArray(rawMistakes)) return [];
  const results: NormalizedMistakeItem[] = [];
  for (const entry of rawMistakes) {
    if (!entry || typeof entry.paperId !== 'string' || typeof entry.questionId !== 'string') continue;
    const paperId = entry.paperId.trim();
    const questionId = entry.questionId.trim();
    if (!paperId || !questionId) continue;
    const title = cleanHumanText(entry.title) ?? '原卷错题';
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
    const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
    const expected = typeof entry.expected === 'string' ? entry.expected.trim() : '';
    const explanation = typeof entry.explanation === 'string' && entry.explanation.trim() ? entry.explanation.trim() : null;
    const occurredAt = formatDateAnchor(null, entry.occurredAt);
    const cluster = entry.recurringErrorCluster;
    const recurringCount = cluster && Number.isSafeInteger(cluster.count) && cluster.count >= 2 ? cluster.count : null;
    results.push({
      key: `${paperId}:${questionId}`,
      paperId,
      questionId,
      title,
      prompt,
      answer,
      expected,
      explanation,
      occurredAt,
      recurringCount,
      ...(cluster ? { recurringErrorCluster: cluster } : {}),
      ...(entry.sourceRef ? { sourceRef: entry.sourceRef } : {}),
      retryHref: paperPracticePath(paperId),
    });
  }
  return results;
}

function refKey(ref: QuestionVersionRef): string {
  return `${ref.id}:${ref.rev}`;
}

function normalizeMember(
  rawMember: RawArchetypeMember,
  index: number,
  catalogByRef: ReadonlyMap<string, NormalizedBankQuestion>,
  catalogById: ReadonlyMap<string, NormalizedBankQuestion>,
  mistakesByQuestionId: ReadonlyMap<string, NormalizedMistakeItem>,
  mistakesByPrompt: ReadonlyMap<string, NormalizedMistakeItem>,
): NormalizedArchetypeMember | null {
  if (!rawMember || isRevokedRecord(rawMember)) return null;
  const questionRef = extractQuestionRef(rawMember.question);
  const practice = extractPracticeHandle(rawMember.practice);
  if (!questionRef && !practice && !cleanHumanText(rawMember.title) && !cleanHumanText(rawMember.prompt)) {
    return null;
  }
  const catalogQuestion = questionRef
    ? catalogByRef.get(refKey(questionRef)) ?? catalogById.get(questionRef.id)
    : undefined;
  const origin: 'original' | 'non-paper' = rawMember.origin === 'non-paper' ? 'non-paper' : 'original';
  const mastery = normalizeMastery(rawMember.mastery, rawMember.state);
  const dateLabel = formatDateAnchor(rawMember.anchor, catalogQuestion?.dateLabel);
  const positionLabel = formatPositionAnchor(rawMember.anchor);
  const sourceLabel = formatSourceLabel(rawMember, origin, catalogQuestion);
  const prompt = cleanHumanText(rawMember.prompt) ?? (catalogQuestion?.prompt || null);
  const explicitTitle = cleanHumanText(rawMember.title) ?? catalogQuestion?.title ?? null;
  const title = explicitTitle ?? (positionLabel ? `${sourceLabel} · ${positionLabel}` : sourceLabel);
  const matchedMistake =
    (questionRef ? mistakesByQuestionId.get(questionRef.id) : undefined) ??
    (prompt ? mistakesByPrompt.get(prompt) : undefined);
  const explicitlyBlocked = rawMember.practiceEligible === false || rawMember.canPractice === false;
  const hasRealHandle = Boolean(practice) || Boolean(questionRef && (catalogQuestion ? catalogQuestion.canPractice : true));
  const practiceEligible = !explicitlyBlocked && hasRealHandle;
  const memberKey = questionRef
    ? refKey(questionRef)
    : practice
      ? `${practice.id}:${practice.rev}`
      : `member-${index}`;
  return {
    key: memberKey,
    ...(questionRef ? { questionRef } : {}),
    ...(practice ? { practice } : {}),
    practiceEligible,
    mastery,
    origin,
    dateLabel,
    sourceLabel,
    positionLabel,
    title,
    prompt,
    isMistake: Boolean(matchedMistake),
    ...(matchedMistake ? { mistakeEntry: matchedMistake } : {}),
  };
}

function readNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function resolveCounts(
  card: RawArchetypeFoldingCard,
  members: readonly NormalizedArchetypeMember[],
  droppedRevokedMembers: boolean,
): { readonly counts: NormalizedMasteryCounts; readonly coveredQuestionCount: number } {
  const computed = { steady: 0, due: 0, weak: 0, unknown: 0 };
  for (const member of members) {
    computed[member.mastery] += 1;
  }
  if (!droppedRevokedMembers) {
    const flatSteady = readNonNegativeInt(card.steadyCount);
    const flatDue = readNonNegativeInt(card.dueCount);
    const flatWeak = readNonNegativeInt(card.weakCount);
    const flatUnknown = readNonNegativeInt(card.unknownCount);
    const hasFlat = flatSteady !== null || flatDue !== null || flatWeak !== null || flatUnknown !== null;

    const nested = card.counts;
    const nestedSteady = readNonNegativeInt(nested?.steady);
    const nestedDue = readNonNegativeInt(nested?.due);
    const nestedWeak = readNonNegativeInt(nested?.weak);
    const nestedUnknown = readNonNegativeInt(nested?.unknown);
    const hasNested = nestedSteady !== null || nestedDue !== null || nestedWeak !== null || nestedUnknown !== null;

    if (hasFlat || hasNested) {
      const steady = hasFlat ? (flatSteady ?? 0) : (nestedSteady ?? 0);
      const due = hasFlat ? (flatDue ?? 0) : (nestedDue ?? 0);
      const weak = hasFlat ? (flatWeak ?? 0) : (nestedWeak ?? 0);
      const unknown = hasFlat ? (flatUnknown ?? 0) : (nestedUnknown ?? 0);
      const total = steady + due + weak + unknown;
      if (total === members.length) {
        const covered = readNonNegativeInt(card.coveredQuestionCount);
        return {
          counts: { steady, due, weak, unknown, unsteady: weak + due },
          coveredQuestionCount: covered !== null && covered === total ? covered : total,
        };
      }
    }
  }
  return {
    counts: {
      steady: computed.steady,
      due: computed.due,
      weak: computed.weak,
      unknown: computed.unknown,
      unsteady: computed.weak + computed.due,
    },
    coveredQuestionCount: members.length,
  };
}

function isUnsteadyMastery(mastery: NormalizedMasteryState): boolean {
  return mastery === 'weak' || mastery === 'due';
}

function resolveRepresentative(
  card: RawArchetypeFoldingCard,
  members: readonly NormalizedArchetypeMember[],
  counts: NormalizedMasteryCounts,
): {
  readonly representativeMember?: NormalizedArchetypeMember;
  readonly actionableRepresentative?: NormalizedArchetypeMember;
  readonly representativeStatus: RepresentativeStatus;
} {
  const rawRep = card.representative;
  let matchedRepresentative: NormalizedArchetypeMember | undefined;
  if (rawRep && !isRevokedRecord(rawRep)) {
    const repRef = extractQuestionRef(rawRep.question);
    const repPractice = extractPracticeHandle(rawRep.practice);
    const matchedMember = members.find(member =>
      (repRef && member.questionRef && refKey(member.questionRef) === refKey(repRef)) ||
      (repPractice && member.practice && member.practice.id === repPractice.id && member.practice.rev === repPractice.rev),
    );
    if (matchedMember) {
      const mergedPractice = repPractice ?? matchedMember.practice;
      const mergedRef = repRef ?? matchedMember.questionRef;
      const explicitStateProvided = typeof rawRep.mastery === 'string' || typeof rawRep.state === 'string';
      const repMastery = explicitStateProvided
        ? normalizeMastery(rawRep.mastery, rawRep.state)
        : matchedMember.mastery;
      const mergedMember: NormalizedArchetypeMember = {
        ...matchedMember,
        mastery: repMastery,
        ...(mergedPractice ? { practice: mergedPractice } : {}),
        ...(mergedRef ? { questionRef: mergedRef } : {}),
      };
      matchedRepresentative = mergedMember;
      const explicitlyBlocked = rawRep.practiceEligible === false || rawRep.canPractice === false;
      const hasHandle = Boolean(mergedPractice) || Boolean(mergedRef);
      const bothUnsteady = isUnsteadyMastery(repMastery) && isUnsteadyMastery(matchedMember.mastery);
      if (!explicitlyBlocked && matchedMember.practiceEligible && hasHandle && bothUnsteady) {
        return {
          representativeMember: mergedMember,
          actionableRepresentative: mergedMember,
          representativeStatus: 'actionable',
        };
      }
      if (repMastery === 'unknown' && counts.unsteady === 0) {
        return { representativeMember: mergedMember, representativeStatus: 'unknown_only' };
      }
    }
  }
  const fallbackRep = matchedRepresentative ?? members[0];
  if (counts.unsteady === 0) {
    if (counts.unknown > 0) {
      return { ...(fallbackRep ? { representativeMember: fallbackRep } : {}), representativeStatus: 'unknown_only' };
    }
    return { ...(fallbackRep ? { representativeMember: fallbackRep } : {}), representativeStatus: 'all_steady' };
  }
  return { ...(fallbackRep ? { representativeMember: fallbackRep } : {}), representativeStatus: 'no_handle' };
}

function extractVariationDimensionCounts(card: RawArchetypeFoldingCard): NormalizedVariationDimension[] {
  if (!Array.isArray(card.variationDimensions)) return [];
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const entry of card.variationDimensions) {
    const rawText = typeof entry === 'string' ? entry : entry?.dimension;
    const text = cleanHumanText(rawText);
    if (!text) continue;
    const explicitCount =
      typeof entry !== 'string' && typeof entry?.count === 'number' && Number.isSafeInteger(entry.count) && entry.count > 0
        ? entry.count
        : 1;
    if (!counts.has(text)) {
      order.push(text);
      counts.set(text, explicitCount);
    } else {
      counts.set(text, (counts.get(text) ?? 0) + explicitCount);
    }
  }
  return order.map(dimension => ({ dimension, evidenceCount: counts.get(dimension) ?? 1 }));
}

function extractVariants(
  card: RawArchetypeFoldingCard,
  members: readonly NormalizedArchetypeMember[],
): NormalizedArchetypeVariant[] {
  if (!Array.isArray(card.variants) || card.variants.length === 0) return [];
  const labelByRef = new Map<string, string>();
  const labelById = new Map<string, string>();
  for (const member of members) {
    const label = [member.sourceLabel, member.positionLabel].filter(Boolean).join(' · ') || member.title;
    if (member.questionRef) {
      labelByRef.set(refKey(member.questionRef), label);
      if (!labelById.has(member.questionRef.id)) labelById.set(member.questionRef.id, label);
    }
  }

  const resolveEndpoint = (witness: RawWitnessLike | undefined, fallback: string): string => {
    const ref = extractQuestionRef(witness);
    if (ref) {
      return labelByRef.get(refKey(ref)) ?? labelById.get(ref.id) ?? fallback;
    }
    return fallback;
  };

  const results: NormalizedArchetypeVariant[] = [];
  for (let index = 0; index < card.variants.length; index += 1) {
    const raw = card.variants[index];
    if (!raw) continue;
    const changed = Array.isArray(raw.changed)
      ? raw.changed
          .map((item: unknown) => cleanHumanText(item))
          .filter((item: string | null): item is string => item !== null)
      : [];
    if (changed.length === 0) continue;
    const fromLabel = resolveEndpoint(raw.from, '源题');
    const toLabel = resolveEndpoint(raw.to, '变式题');
    const edgeRef = extractQuestionRef(raw.edge);
    const key = edgeRef ? `var:${refKey(edgeRef)}:${index}` : `var:${index}:${changed.join('|')}`;
    results.push({ key, fromLabel, toLabel, changed });
  }
  return results;
}

function normalizeConflicts(
  rawConflicts: readonly RawArchetypeConflict[] | undefined,
  clusterTitlesByArchetypeId: ReadonlyMap<string, string>,
  memberTitleByQuestionId: ReadonlyMap<string, string>,
  catalogById: ReadonlyMap<string, NormalizedBankQuestion>,
): NormalizedArchetypeConflict[] {
  if (!Array.isArray(rawConflicts) || rawConflicts.length === 0) return [];
  const results: NormalizedArchetypeConflict[] = [];
  for (let index = 0; index < rawConflicts.length; index += 1) {
    const conflict = rawConflicts[index];
    if (!conflict) continue;
    const qRef = extractQuestionRef(conflict.question);
    const questionLabel =
      (qRef ? memberTitleByQuestionId.get(qRef.id) ?? catalogById.get(qRef.id)?.title : undefined) ??
      `冲突题目 #${index + 1}`;
    const groups: readonly RawWitnessLike[] = Array.isArray(conflict.groups) ? conflict.groups : [];
    const groupLabels = groups.map((group: RawWitnessLike, groupIndex: number) => {
      const gRef = extractQuestionRef(group);
      return (gRef ? clusterTitlesByArchetypeId.get(gRef.id) : undefined) ?? `候选母题 #${groupIndex + 1}`;
    });
    const membershipCount = Array.isArray(conflict.memberships) && conflict.memberships.length > 0
      ? conflict.memberships.length
      : Math.max(groupLabels.length, 2);
    const key = qRef ? `conflict:${refKey(qRef)}:${index}` : `conflict:${index}`;
    results.push({ key, questionLabel, groupLabels, membershipCount });
  }
  return results;
}

export function extractFoldingPayload(
  response: RawQuestionCatalogResponse | RawArchetypeFoldingPayload | null | undefined,
): RawArchetypeFoldingPayload | undefined {
  if (!response || !isRecord(response)) return undefined;
  const source = response as Partial<RawQuestionCatalogResponse> & Partial<RawArchetypeFoldingPayload>;
  if (source.folding && isRecord(source.folding)) return source.folding;
  if (source.archetypeFolding && isRecord(source.archetypeFolding)) return source.archetypeFolding;
  const conflicts = Array.isArray(source.conflicts) ? source.conflicts : undefined;
  if (Array.isArray(source.cards)) return { cards: source.cards, ...(conflicts ? { conflicts } : {}) };
  if (Array.isArray(source.clusters)) return { clusters: source.clusters, ...(conflicts ? { conflicts } : {}) };
  if (Array.isArray(source.archetypes)) return { archetypes: source.archetypes, ...(conflicts ? { conflicts } : {}) };
  if (conflicts) return { cards: [], conflicts };
  return undefined;
}

export function normalizeArchetypeFolding(
  payload: RawArchetypeFoldingPayload | null | undefined,
  catalogQuestions: readonly NormalizedBankQuestion[] = [],
  mistakes: readonly NormalizedMistakeItem[] = [],
): NormalizedFoldingResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'unavailable', clusters: [], standaloneQuestions: [], conflicts: [], hiddenClusterCount: 0 };
  }
  const hasStructuredList =
    Array.isArray(payload.cards) ||
    Array.isArray(payload.clusters) ||
    Array.isArray(payload.archetypes) ||
    Array.isArray(payload.conflicts);
  if (!hasStructuredList) {
    return { status: 'unavailable', clusters: [], standaloneQuestions: [], conflicts: [], hiddenClusterCount: 0 };
  }

  const rawEntries: readonly RawArchetypeFoldingCard[] =
    Array.isArray(payload.cards)
      ? payload.cards
      : Array.isArray(payload.clusters)
        ? payload.clusters
        : Array.isArray(payload.archetypes)
          ? payload.archetypes
          : [];

  const catalogByRef = new Map<string, NormalizedBankQuestion>();
  const catalogById = new Map<string, NormalizedBankQuestion>();
  for (const question of catalogQuestions) {
    catalogByRef.set(refKey(question.sourceRef), question);
    if (!catalogById.has(question.sourceRef.id)) catalogById.set(question.sourceRef.id, question);
  }
  const mistakesByQuestionId = new Map<string, NormalizedMistakeItem>();
  const mistakesByPrompt = new Map<string, NormalizedMistakeItem>();
  for (const mistake of mistakes) {
    if (!mistakesByQuestionId.has(mistake.questionId)) mistakesByQuestionId.set(mistake.questionId, mistake);
    if (mistake.prompt && !mistakesByPrompt.has(mistake.prompt)) mistakesByPrompt.set(mistake.prompt, mistake);
  }

  const clusters: NormalizedArchetypeCluster[] = [];
  const standaloneQuestions: NormalizedArchetypeMember[] = [];
  const clusterTitlesByArchetypeId = new Map<string, string>();
  const memberTitleByQuestionId = new Map<string, string>();
  let hiddenClusterCount = 0;

  for (let cardIndex = 0; cardIndex < rawEntries.length; cardIndex += 1) {
    const card = rawEntries[cardIndex];
    if (!card) continue;

    if (card.kind === 'question' && card.question) {
      const standalone = normalizeMember(
        card.question,
        cardIndex,
        catalogByRef,
        catalogById,
        mistakesByQuestionId,
        mistakesByPrompt,
      );
      if (standalone) {
        standaloneQuestions.push(standalone);
        if (standalone.questionRef && !memberTitleByQuestionId.has(standalone.questionRef.id)) {
          memberTitleByQuestionId.set(standalone.questionRef.id, standalone.title);
        }
      } else {
        hiddenClusterCount += 1;
      }
      continue;
    }

    if (isRevokedRecord(card)) {
      hiddenClusterCount += 1;
      continue;
    }

    const rawMembers = Array.isArray(card.members) ? card.members : [];
    const normalizedMembers: NormalizedArchetypeMember[] = [];
    let droppedRevoked = false;
    for (let memberIndex = 0; memberIndex < rawMembers.length; memberIndex += 1) {
      const rawMember = rawMembers[memberIndex];
      if (!rawMember) {
        droppedRevoked = true;
        continue;
      }
      const member = normalizeMember(
        rawMember,
        memberIndex,
        catalogByRef,
        catalogById,
        mistakesByQuestionId,
        mistakesByPrompt,
      );
      if (member) {
        normalizedMembers.push(member);
        if (member.questionRef && !memberTitleByQuestionId.has(member.questionRef.id)) {
          memberTitleByQuestionId.set(member.questionRef.id, member.title);
        }
      } else {
        droppedRevoked = true;
      }
    }

    if (normalizedMembers.length === 0) {
      hiddenClusterCount += 1;
      continue;
    }

    const { counts, coveredQuestionCount } = resolveCounts(card, normalizedMembers, droppedRevoked);
    const { representativeMember, actionableRepresentative, representativeStatus } = resolveRepresentative(
      card,
      normalizedMembers,
      counts,
    );
    const archetypeRef = extractQuestionRef(card.archetype);
    const clusterKey = archetypeRef ? `arch:${refKey(archetypeRef)}` : `arch-idx:${cardIndex}`;
    const title = cleanHumanText(card.title) ?? normalizedMembers[0]?.title ?? '未命名母题';
    if (archetypeRef && !clusterTitlesByArchetypeId.has(archetypeRef.id)) {
      clusterTitlesByArchetypeId.set(archetypeRef.id, title);
    }
    const variationDimensionCounts = extractVariationDimensionCounts(card);
    const variationDimensions = variationDimensionCounts.map(item => item.dimension);
    const variants = extractVariants(card, normalizedMembers);
    const hasMistake = normalizedMembers.some(member => member.isMistake);
    let originalCount = 0;
    let nonPaperCount = 0;
    for (const member of normalizedMembers) {
      if (member.origin === 'non-paper') nonPaperCount += 1;
      else originalCount += 1;
    }

    clusters.push({
      key: clusterKey,
      title,
      coveredQuestionCount,
      originalCount,
      nonPaperCount,
      counts,
      variationDimensions,
      variationDimensionCounts,
      variants,
      members: normalizedMembers,
      ...(representativeMember ? { representativeMember } : {}),
      ...(actionableRepresentative ? { actionableRepresentative } : {}),
      representativeStatus,
      hasMistake,
    });
  }

  const conflicts = normalizeConflicts(
    payload.conflicts,
    clusterTitlesByArchetypeId,
    memberTitleByQuestionId,
    catalogById,
  );

  if (clusters.length === 0 && standaloneQuestions.length === 0 && conflicts.length === 0) {
    return { status: 'empty', clusters: [], standaloneQuestions: [], conflicts: [], hiddenClusterCount };
  }
  return { status: 'ready', clusters, standaloneQuestions, conflicts, hiddenClusterCount };
}

export function formatMasterySummary(cluster: Pick<NormalizedArchetypeCluster, 'coveredQuestionCount' | 'counts'>): {
  readonly primary: string;
  readonly unknownNote: string | null;
} {
  const primary = `涵盖 ${cluster.coveredQuestionCount} 题 · 已稳 ${cluster.counts.steady} / 待固 ${cluster.counts.unsteady}`;
  const unknownNote = cluster.counts.unknown > 0 ? `${cluster.counts.unknown} 题尚待核对` : null;
  return { primary, unknownNote };
}

export function filterClustersForMistakes(
  clusters: readonly NormalizedArchetypeCluster[],
): NormalizedArchetypeCluster[] {
  return clusters.filter(cluster => cluster.hasMistake || cluster.counts.unsteady > 0);
}
