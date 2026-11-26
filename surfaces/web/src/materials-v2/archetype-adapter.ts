import { paperPracticePath } from '../builtin-packs';
import { formatIsoDate } from '../shared/format-time';
import { isRecord, isUlid, readSafeInt, readTrimmed } from '../shared/safe-values';
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

export const MASTERY_META: Readonly<
  Record<NormalizedMasteryState, { readonly label: string; readonly tone: NormalizedMasteryState }>
> = {
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

function cleanHumanText(value: unknown): string | null {
  const trimmed = readTrimmed(value);
  return trimmed && !isUlid(trimmed) ? trimmed : null;
}

function firstHumanText(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const clean = cleanHumanText(value);
    if (clean !== null) return clean;
  }
  return null;
}

function normalizeMastery(rawMastery: unknown, rawState?: unknown): NormalizedMasteryState {
  const candidate = (readTrimmed(rawMastery) ?? readTrimmed(rawState) ?? '').toLowerCase();
  if (candidate === 'steady' || candidate === 'due' || candidate === 'weak' || candidate === 'unknown') {
    return candidate;
  }
  if (candidate === 'decaying') return 'due';
  if (candidate === 'fragile') return 'weak';
  return 'unknown';
}

function extractQuestionRef(witness: RawWitnessLike | undefined): QuestionVersionRef | undefined {
  const id = readTrimmed(witness?.id);
  if (!id) return undefined;
  return { id, rev: readSafeInt(witness?.rev, 1) ?? 1 };
}

function extractPracticeHandle(value: unknown): PracticeHandle | undefined {
  if (!isRecord(value) || value.kind !== 'activity') return undefined;
  const id = readTrimmed(value.id);
  const rev = readSafeInt(value.rev, 1);
  if (!id || rev === undefined) return undefined;
  return { ...value, kind: 'activity', id, rev };
}

function formatDateAnchor(anchor: RawAnchorLike | null | undefined, fallbackDate?: unknown): string | null {
  for (const candidate of [anchor?.date, anchor?.occurredAt, anchor?.paperDate, anchor?.createdAt, fallbackDate]) {
    const formatted = formatIsoDate(candidate);
    if (formatted) return formatted;
  }
  return null;
}

function formatPositionAnchor(anchor: RawAnchorLike | null | undefined): string | null {
  if (!anchor) return null;
  if (typeof anchor.position === 'number' && Number.isFinite(anchor.position) && anchor.position > 0) {
    return `第 ${anchor.position} 题`;
  }
  const text = firstHumanText(anchor.position, anchor.questionNumber, anchor.label);
  if (!text) return null;
  return /^\d+$/.test(text) ? `第 ${text} 题` : text;
}

function formatSourceLabel(
  member: RawArchetypeMember,
  origin: 'original' | 'non-paper',
  catalogQuestion?: NormalizedBankQuestion,
): string {
  const anchor = member.anchor;
  return (
    firstHumanText(
      anchor?.paperTitle,
      anchor?.sourceLabel,
      anchor?.sourceTitle,
      anchor?.paperName,
      anchor?.examTitle,
      member.sourcePaperTitle,
      member.paperTitle,
      member.sourceLabel,
      anchor?.title,
      catalogQuestion?.sourceLabel,
    ) ?? (origin === 'original' ? '原卷题目' : '题库单题')
  );
}

function isRevokedRecord(record: {
  readonly revoked?: boolean;
  readonly authorized?: boolean;
  readonly withdrawn?: boolean;
}): boolean {
  return record.revoked === true || record.authorized === false || record.withdrawn === true;
}

const VALID_BANK_STATUSES = new Set<BankQuestionStatus>([
  'draft',
  'needs_verification',
  'restricted',
  'release_ready',
]);

function normalizeStatus(rawStatus: string): BankQuestionStatus {
  return VALID_BANK_STATUSES.has(rawStatus as BankQuestionStatus)
    ? (rawStatus as BankQuestionStatus)
    : 'needs_verification';
}

export function normalizeBankQuestions(
  rawQuestions: readonly RawBankQuestion[] | undefined,
): NormalizedBankQuestion[] {
  if (!Array.isArray(rawQuestions)) return [];
  const results: NormalizedBankQuestion[] = [];
  for (const item of rawQuestions) {
    const id = readTrimmed(item?.id);
    if (!id || isRevokedRecord(item)) continue;
    const status = normalizeStatus(item.status);
    if (status === 'restricted') continue;
    const rev = readSafeInt(item.rev, 1) ?? 1;
    const dateLabel = formatDateAnchor(null, item.date);
    const sourceLabel = cleanHumanText(item.sourceLabel);
    const hasExplicitMastery = typeof item.mastery === 'string' || typeof item.state === 'string';
    results.push({
      key: `${item.id}:${rev}`,
      sourceRef: { id, rev },
      title: cleanHumanText(item.title) ?? '未命名题目',
      prompt: typeof item.prompt === 'string' ? item.prompt.trim() : '',
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

export function normalizeMistakeItems(
  rawMistakes: readonly RawMistakeEntry[] | undefined,
): NormalizedMistakeItem[] {
  if (!Array.isArray(rawMistakes)) return [];
  const results: NormalizedMistakeItem[] = [];
  for (const entry of rawMistakes) {
    const paperId = readTrimmed(entry?.paperId);
    const questionId = readTrimmed(entry?.questionId);
    if (!paperId || !questionId) continue;
    const cluster = entry.recurringErrorCluster;
    const recurringCount = readSafeInt(cluster?.count, 2) ?? null;
    results.push({
      key: `${paperId}:${questionId}`,
      paperId,
      questionId,
      title: cleanHumanText(entry.title) ?? '原卷错题',
      prompt: readTrimmed(entry.prompt) ?? '',
      answer: readTrimmed(entry.answer) ?? '',
      expected: readTrimmed(entry.expected) ?? '',
      explanation: readTrimmed(entry.explanation) ?? null,
      occurredAt: formatDateAnchor(null, entry.occurredAt),
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

type NormalizationContext = {
  readonly catalogByRef: ReadonlyMap<string, NormalizedBankQuestion>;
  readonly catalogById: ReadonlyMap<string, NormalizedBankQuestion>;
  readonly mistakesByQuestionId: ReadonlyMap<string, NormalizedMistakeItem>;
  readonly mistakesByPrompt: ReadonlyMap<string, NormalizedMistakeItem>;
};

function normalizeMember(
  rawMember: RawArchetypeMember,
  index: number,
  ctx: NormalizationContext,
): NormalizedArchetypeMember | null {
  if (!rawMember || isRevokedRecord(rawMember)) return null;
  const fallbackId = readTrimmed(rawMember.id);
  const questionRef =
    extractQuestionRef(rawMember.question) ??
    (fallbackId ? { id: fallbackId, rev: readSafeInt(rawMember.rev, 1) ?? 1 } : undefined);
  const practice = extractPracticeHandle(rawMember.practice);
  if (!questionRef && !practice && !cleanHumanText(rawMember.title) && !cleanHumanText(rawMember.prompt)) {
    return null;
  }
  const catalogQuestion = questionRef
    ? ctx.catalogByRef.get(refKey(questionRef)) ?? ctx.catalogById.get(questionRef.id)
    : undefined;
  const origin: 'original' | 'non-paper' = rawMember.origin === 'non-paper' ? 'non-paper' : 'original';
  const positionLabel = formatPositionAnchor(rawMember.anchor);
  const sourceLabel = formatSourceLabel(rawMember, origin, catalogQuestion);
  const prompt = cleanHumanText(rawMember.prompt) ?? (catalogQuestion?.prompt || null);
  const explicitTitle = cleanHumanText(rawMember.title) ?? catalogQuestion?.title ?? null;
  const matchedMistake =
    (questionRef ? ctx.mistakesByQuestionId.get(questionRef.id) : undefined) ??
    (prompt ? ctx.mistakesByPrompt.get(prompt) : undefined);
  const explicitlyBlocked = rawMember.practiceEligible === false || rawMember.canPractice === false;
  const hasRealHandle = Boolean(practice) || Boolean(questionRef && (catalogQuestion ? catalogQuestion.canPractice : true));
  const memberKey = questionRef
    ? refKey(questionRef)
    : practice
      ? `${practice.id}:${practice.rev}`
      : `member-${index}`;

  return {
    key: memberKey,
    ...(questionRef ? { questionRef } : {}),
    ...(practice ? { practice } : {}),
    practiceEligible: !explicitlyBlocked && hasRealHandle,
    mastery: normalizeMastery(rawMember.mastery, rawMember.state),
    origin,
    dateLabel: formatDateAnchor(rawMember.anchor, catalogQuestion?.dateLabel),
    sourceLabel,
    positionLabel,
    title: explicitTitle ?? (positionLabel ? `${sourceLabel} · ${positionLabel}` : sourceLabel),
    prompt,
    isMistake: Boolean(matchedMistake),
    ...(matchedMistake ? { mistakeEntry: matchedMistake } : {}),
  };
}

function readCountTuple(
  steadyRaw: unknown,
  dueRaw: unknown,
  weakRaw: unknown,
  unknownRaw: unknown,
): { steady: number; due: number; weak: number; unknown: number } | null {
  const steady = readSafeInt(steadyRaw, 0);
  const due = readSafeInt(dueRaw, 0);
  const weak = readSafeInt(weakRaw, 0);
  const unknown = readSafeInt(unknownRaw, 0);
  if (steady === undefined && due === undefined && weak === undefined && unknown === undefined) return null;
  return { steady: steady ?? 0, due: due ?? 0, weak: weak ?? 0, unknown: unknown ?? 0 };
}

function resolveCounts(
  card: RawArchetypeFoldingCard,
  members: readonly NormalizedArchetypeMember[],
  droppedRevokedMembers: boolean,
): { readonly counts: NormalizedMasteryCounts; readonly coveredQuestionCount: number } {
  if (!droppedRevokedMembers) {
    const provided =
      readCountTuple(card.steadyCount, card.dueCount, card.weakCount, card.unknownCount) ??
      readCountTuple(card.counts?.steady, card.counts?.due, card.counts?.weak, card.counts?.unknown);
    if (provided) {
      const total = provided.steady + provided.due + provided.weak + provided.unknown;
      if (total === members.length) {
        const covered = readSafeInt(card.coveredQuestionCount, 0);
        return {
          counts: { ...provided, unsteady: provided.weak + provided.due },
          coveredQuestionCount: covered === total ? covered : total,
        };
      }
    }
  }
  const computed = { steady: 0, due: 0, weak: 0, unknown: 0 };
  for (const member of members) computed[member.mastery] += 1;
  return {
    counts: { ...computed, unsteady: computed.weak + computed.due },
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
    const matchedMember = members.find(
      (member) =>
        (repRef && member.questionRef && refKey(member.questionRef) === refKey(repRef)) ||
        (repPractice && member.practice && member.practice.id === repPractice.id && member.practice.rev === repPractice.rev),
    );
    if (matchedMember) {
      const mergedPractice = repPractice ?? matchedMember.practice;
      const mergedRef = repRef ?? matchedMember.questionRef;
      const explicitState = typeof rawRep.mastery === 'string' || typeof rawRep.state === 'string';
      const repMastery = explicitState ? normalizeMastery(rawRep.mastery, rawRep.state) : matchedMember.mastery;
      const mergedMember: NormalizedArchetypeMember = {
        ...matchedMember,
        mastery: repMastery,
        ...(mergedPractice ? { practice: mergedPractice } : {}),
        ...(mergedRef ? { questionRef: mergedRef } : {}),
      };
      matchedRepresentative = mergedMember;
      const blocked = rawRep.practiceEligible === false || rawRep.canPractice === false;
      if (
        !blocked &&
        matchedMember.practiceEligible &&
        (Boolean(mergedPractice) || Boolean(mergedRef)) &&
        isUnsteadyMastery(repMastery) &&
        isUnsteadyMastery(matchedMember.mastery)
      ) {
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
  const status: RepresentativeStatus =
    counts.unsteady === 0 ? (counts.unknown > 0 ? 'unknown_only' : 'all_steady') : 'no_handle';
  return { ...(fallbackRep ? { representativeMember: fallbackRep } : {}), representativeStatus: status };
}

function extractVariationDimensionCounts(card: RawArchetypeFoldingCard): NormalizedVariationDimension[] {
  if (!Array.isArray(card.variationDimensions)) return [];
  const counts = new Map<string, number>();
  for (const entry of card.variationDimensions) {
    const text = cleanHumanText(typeof entry === 'string' ? entry : entry?.dimension);
    if (!text) continue;
    const explicitCount = typeof entry !== 'string' ? readSafeInt(entry?.count, 1) ?? 1 : 1;
    counts.set(text, (counts.get(text) ?? 0) + explicitCount);
  }
  return [...counts.entries()].map(([dimension, evidenceCount]) => ({ dimension, evidenceCount }));
}

function extractVariants(
  card: RawArchetypeFoldingCard,
  members: readonly NormalizedArchetypeMember[],
): NormalizedArchetypeVariant[] {
  if (!Array.isArray(card.variants) || card.variants.length === 0) return [];
  const labelByRef = new Map<string, string>();
  const labelById = new Map<string, string>();
  for (const member of members) {
    if (!member.questionRef) continue;
    const label = [member.sourceLabel, member.positionLabel].filter(Boolean).join(' · ') || member.title;
    labelByRef.set(refKey(member.questionRef), label);
    if (!labelById.has(member.questionRef.id)) labelById.set(member.questionRef.id, label);
  }

  const resolveEndpoint = (witness: RawWitnessLike | undefined, fallback: string): string => {
    const ref = extractQuestionRef(witness);
    return ref ? labelByRef.get(refKey(ref)) ?? labelById.get(ref.id) ?? fallback : fallback;
  };

  const results: NormalizedArchetypeVariant[] = [];
  for (let index = 0; index < card.variants.length; index += 1) {
    const raw = card.variants[index];
    if (!raw || !Array.isArray(raw.changed)) continue;
    const changed = raw.changed
      .map((entry: unknown) => cleanHumanText(entry))
      .filter((item: string | null): item is string => item !== null);
    if (changed.length === 0) continue;
    const edgeRef = extractQuestionRef(raw.edge);
    results.push({
      key: edgeRef ? `var:${refKey(edgeRef)}:${index}` : `var:${index}:${changed.join('|')}`,
      fromLabel: resolveEndpoint(raw.from, '源题'),
      toLabel: resolveEndpoint(raw.to, '变式题'),
      changed,
    });
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
    const groupLabels = groups.map((group, groupIndex) => {
      const gRef = extractQuestionRef(group);
      return (gRef ? clusterTitlesByArchetypeId.get(gRef.id) : undefined) ?? `候选母题 #${groupIndex + 1}`;
    });
    const membershipCount =
      Array.isArray(conflict.memberships) && conflict.memberships.length > 0
        ? conflict.memberships.length
        : Math.max(groupLabels.length, 2);
    results.push({
      key: qRef ? `conflict:${refKey(qRef)}:${index}` : `conflict:${index}`,
      questionLabel,
      groupLabels,
      membershipCount,
    });
  }
  return results;
}

export function extractFoldingPayload(
  response: RawQuestionCatalogResponse | RawArchetypeFoldingPayload | null | undefined,
): RawArchetypeFoldingPayload | undefined {
  if (!isRecord(response)) return undefined;
  const source = response as Partial<RawQuestionCatalogResponse> & Partial<RawArchetypeFoldingPayload>;
  if (isRecord(source.folding)) return source.folding as RawArchetypeFoldingPayload;
  if (isRecord(source.archetypeFolding)) return source.archetypeFolding as RawArchetypeFoldingPayload;
  const extras = {
    ...(Array.isArray(source.standaloneQuestionIds) ? { standaloneQuestionIds: source.standaloneQuestionIds } : {}),
    ...(Array.isArray(source.conflicts) ? { conflicts: source.conflicts } : {}),
  };
  if (Array.isArray(source.cards)) return { cards: source.cards, ...extras };
  if (Array.isArray(source.clusters)) return { clusters: source.clusters, ...extras };
  if (Array.isArray(source.archetypes)) return { archetypes: source.archetypes, ...extras };
  if (extras.conflicts || extras.standaloneQuestionIds) return { cards: [], ...extras };
  return undefined;
}

export function normalizeArchetypeFolding(
  payload: RawArchetypeFoldingPayload | null | undefined,
  catalogQuestions: readonly NormalizedBankQuestion[] = [],
  mistakes: readonly NormalizedMistakeItem[] = [],
): NormalizedFoldingResult {
  const unavailable: NormalizedFoldingResult = {
    status: 'unavailable',
    clusters: [],
    standaloneQuestions: [],
    conflicts: [],
    hiddenClusterCount: 0,
  };
  if (!isRecord(payload)) return unavailable;
  const rawEntries: readonly RawArchetypeFoldingCard[] | null = Array.isArray(payload.cards)
    ? payload.cards
    : Array.isArray(payload.clusters)
      ? payload.clusters
      : Array.isArray(payload.archetypes)
        ? payload.archetypes
        : null;
  if (!rawEntries && !Array.isArray(payload.standaloneQuestionIds) && !Array.isArray(payload.conflicts)) {
    return unavailable;
  }

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
  const ctx: NormalizationContext = { catalogByRef, catalogById, mistakesByQuestionId, mistakesByPrompt };

  const clusters: NormalizedArchetypeCluster[] = [];
  const standaloneQuestions: NormalizedArchetypeMember[] = [];
  const clusterTitlesByArchetypeId = new Map<string, string>();
  const memberTitleByQuestionId = new Map<string, string>();
  let hiddenClusterCount = 0;

  const rememberMemberTitle = (member: NormalizedArchetypeMember) => {
    if (member.questionRef && !memberTitleByQuestionId.has(member.questionRef.id)) {
      memberTitleByQuestionId.set(member.questionRef.id, member.title);
    }
  };

  for (let cardIndex = 0; cardIndex < (rawEntries?.length ?? 0); cardIndex += 1) {
    const card = rawEntries![cardIndex];
    if (!card) continue;

    if (card.kind === 'question' && card.question) {
      const standalone = normalizeMember(card.question, cardIndex, ctx);
      if (standalone) {
        standaloneQuestions.push(standalone);
        rememberMemberTitle(standalone);
      } else {
        hiddenClusterCount += 1;
      }
      continue;
    }

    if (isRevokedRecord(card)) {
      hiddenClusterCount += 1;
      continue;
    }

    const rawMembers = Array.isArray(card.members)
      ? card.members
      : Array.isArray(card.coveredQuestions)
        ? card.coveredQuestions
        : [];
    const normalizedMembers: NormalizedArchetypeMember[] = [];
    let droppedRevoked = false;
    for (let memberIndex = 0; memberIndex < rawMembers.length; memberIndex += 1) {
      const member = rawMembers[memberIndex] ? normalizeMember(rawMembers[memberIndex]!, memberIndex, ctx) : null;
      if (member) {
        normalizedMembers.push(member);
        rememberMemberTitle(member);
      } else {
        droppedRevoked = true;
      }
    }

    if (normalizedMembers.length === 0) {
      hiddenClusterCount += 1;
      continue;
    }

    const { counts, coveredQuestionCount } = resolveCounts(card, normalizedMembers, droppedRevoked);
    const rep = resolveRepresentative(card, normalizedMembers, counts);
    const fallbackArchId = readTrimmed(card.archetypeId);
    const archetypeRef =
      extractQuestionRef(card.archetype) ?? (fallbackArchId ? { id: fallbackArchId, rev: 1 } : undefined);
    const title = cleanHumanText(card.title) ?? normalizedMembers[0]?.title ?? '未命名母题';
    if (archetypeRef && !clusterTitlesByArchetypeId.has(archetypeRef.id)) {
      clusterTitlesByArchetypeId.set(archetypeRef.id, title);
    }
    const variationDimensionCounts = extractVariationDimensionCounts(card);
    let originalCount = 0;
    let nonPaperCount = 0;
    for (const member of normalizedMembers) {
      if (member.origin === 'non-paper') nonPaperCount += 1;
      else originalCount += 1;
    }

    clusters.push({
      key: archetypeRef ? `arch:${refKey(archetypeRef)}` : `arch-idx:${cardIndex}`,
      title,
      coveredQuestionCount,
      originalCount,
      nonPaperCount,
      counts,
      variationDimensions: variationDimensionCounts.map((item) => item.dimension),
      variationDimensionCounts,
      variants: extractVariants(card, normalizedMembers),
      members: normalizedMembers,
      ...(rep.representativeMember ? { representativeMember: rep.representativeMember } : {}),
      ...(rep.actionableRepresentative ? { actionableRepresentative: rep.actionableRepresentative } : {}),
      representativeStatus: rep.representativeStatus,
      hasMistake: normalizedMembers.some((member) => member.isMistake),
    });
  }

  if (Array.isArray(payload.standaloneQuestionIds)) {
    const existingIds = new Set(
      standaloneQuestions.map((item) => item.questionRef?.id).filter((id): id is string => Boolean(id)),
    );
    for (let idx = 0; idx < payload.standaloneQuestionIds.length; idx += 1) {
      const id = readTrimmed(payload.standaloneQuestionIds[idx]);
      if (!id || existingIds.has(id)) continue;
      const question = catalogById.get(id);
      if (!question) continue;
      const standalone = normalizeMember(
        {
          id: question.sourceRef.id,
          rev: question.sourceRef.rev,
          title: question.title,
          prompt: question.prompt,
          ...(question.mastery ? { mastery: question.mastery } : {}),
          ...(question.sourceLabel ? { sourceLabel: question.sourceLabel } : {}),
          canPractice: question.canPractice,
        },
        standaloneQuestions.length + idx,
        ctx,
      );
      if (standalone) {
        standaloneQuestions.push(standalone);
        existingIds.add(id);
        rememberMemberTitle(standalone);
      }
    }
  }

  const conflicts = normalizeConflicts(
    Array.isArray(payload.conflicts) ? (payload.conflicts as readonly RawArchetypeConflict[]) : undefined,
    clusterTitlesByArchetypeId,
    memberTitleByQuestionId,
    catalogById,
  );
  const status = clusters.length === 0 && standaloneQuestions.length === 0 && conflicts.length === 0 ? 'empty' : 'ready';
  return { status, clusters, standaloneQuestions, conflicts, hiddenClusterCount };
}

export function formatMasterySummary(
  cluster: Pick<NormalizedArchetypeCluster, 'coveredQuestionCount' | 'counts'>,
): { readonly primary: string; readonly unknownNote: string | null } {
  return {
    primary: `涵盖 ${cluster.coveredQuestionCount} 题 · 已稳 ${cluster.counts.steady} / 待固 ${cluster.counts.unsteady}`,
    unknownNote: cluster.counts.unknown > 0 ? `${cluster.counts.unknown} 题尚待核对` : null,
  };
}

export function filterClustersForMistakes(
  clusters: readonly NormalizedArchetypeCluster[],
): NormalizedArchetypeCluster[] {
  return clusters.filter((cluster) => cluster.hasMistake || cluster.counts.unsteady > 0);
}
