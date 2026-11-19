import type { Outcome } from '@mangekyo/kernel';

export const memoryReviewSlotType = 'companion.memoryReview';
export const memoryReviewDeriverName = 'companion/memory-review';
export const memoryReviewDeriverVersion = 'memory-review-v1';

export type MemoryReviewAuthorRole = 'learner' | 'companion' | 'adopted' | 'unknown';
export type MemoryReviewDirection = 'support' | 'contradict' | 'unresolved';

export type MemoryReviewWitness = { readonly factId: string; readonly revision: number; readonly accessEpoch: string; readonly authorRole: MemoryReviewAuthorRole; readonly sourceVersion: string };

export type MemoryReviewScope = { readonly subject: string; readonly activity?: string; readonly conditions?: readonly string[]; readonly validFrom?: string; readonly validUntil?: string };

export type MemoryReviewEvidence = { readonly eventId: string; readonly assertionId: string; readonly witness: MemoryReviewWitness; readonly scope: MemoryReviewScope; readonly occurredAt: string; readonly recordedAt: string; readonly help: { readonly exposed: boolean | 'unknown'; readonly order?: 'before_submission' | 'after_submission' | 'unknown' }; readonly submissionOrder?: number; readonly direction: MemoryReviewDirection; readonly originGroupId?: string; readonly counterEvidenceIds?: readonly string[] };

export type MemoryReviewRequest = { readonly requestId: string; readonly assertion: { readonly id: string; readonly text: string; readonly scope: MemoryReviewScope }; readonly evidence: readonly MemoryReviewEvidence[] };

export type MemoryReviewAssertion = { readonly id: string; readonly text: string; readonly scope: MemoryReviewScope };

export type MemoryReviewSource = { readonly eventId: string; readonly assertionId: string; readonly witness: MemoryReviewWitness; readonly scope: MemoryReviewScope; readonly occurredAt: string; readonly recordedAt: string; readonly helpExposed: boolean | 'unknown'; readonly helpOrder: 'before_submission' | 'after_submission' | 'unknown'; readonly submissionOrder: number | null; readonly originGroupId: string | null; readonly duplicateOf: string | null };

export type MemoryReviewFinding = { readonly kind: 'support' | 'contradict' | 'unresolved'; readonly eventIds: readonly string[]; readonly reason: string };

export type MemoryReviewResult = { readonly assertion: MemoryReviewAssertion; readonly outcome: { readonly kind: 'supported'; readonly basis: 'independent' | 'assisted' | 'mixed' } | { readonly kind: 'contradicted' } | { readonly kind: 'unresolved' }; readonly sources: readonly MemoryReviewSource[]; readonly findings: { readonly supporting: readonly MemoryReviewFinding[]; readonly contradicting: readonly MemoryReviewFinding[]; readonly unresolved: readonly MemoryReviewFinding[] }; readonly nextEvidence: readonly string[]; readonly notes: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (label: string): never => { throw new Error(`${label}无效。`); };
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) fail(label);
  return value as Record<string, unknown>;
};
const clean = (value: unknown, label: string, max = 2000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed() || value.includes('\0')) fail(label);
  return (value as string).trim();
};
const tick = (value: unknown, label: string): string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? value : fail(label);
const revision = (value: unknown, label: string): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fail(label);
const oneOf = <T>(value: unknown, values: readonly T[], label: string): T => values.includes(value as T) ? value as T : fail(label);
const strings = (value: unknown, label: string): readonly string[] | undefined => value === undefined ? undefined : (!Array.isArray(value) || value.some(item => typeof item !== 'string') ? fail(label) : [...new Set(value as string[])].sort());

const help = (value: unknown): MemoryReviewEvidence['help'] => {
  const input = record(value, '帮助证据');
  const exposed = oneOf(input.exposed, [true, false, 'unknown'] as const, '帮助曝光状态');
  const order = input.order === undefined ? undefined : oneOf(input.order, ['before_submission', 'after_submission', 'unknown'] as const, '帮助顺序');
  return { exposed, ...(order === undefined ? {} : { order }) };
};

const scope = (value: unknown, label: string): MemoryReviewScope => {
  const input = record(value, label);
  const conditions = strings(input.conditions, `${label}.conditions`);
  return {
    subject: clean(input.subject, `${label}.subject`, 200),
    ...(input.activity === undefined ? {} : { activity: clean(input.activity, `${label}.activity`, 200) }),
    ...(conditions === undefined ? {} : { conditions }),
    ...(input.validFrom === undefined ? {} : { validFrom: clean(input.validFrom, `${label}.validFrom`, 80) }),
    ...(input.validUntil === undefined ? {} : { validUntil: clean(input.validUntil, `${label}.validUntil`, 80) }),
  };
};

const witness = (value: unknown): MemoryReviewWitness => {
  const input = record(value, '见证');
  return {
    factId: clean(input.factId, '见证事实 ID', 200),
    revision: revision(input.revision, '见证修订'),
    accessEpoch: tick(input.accessEpoch, '见证访问代次'),
    authorRole: oneOf(input.authorRole, ['learner', 'companion', 'adopted', 'unknown'] as const, '见证作者角色'),
    sourceVersion: clean(input.sourceVersion, '见证来源版本', 200),
  };
};

const evidence = (value: unknown): MemoryReviewEvidence => {
  const input = record(value, '证据');
  const order = input.submissionOrder;
  if (order !== undefined && (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0)) fail('提交顺序');
  const submissionOrder = order as number | undefined;
  const counterEvidenceIds = strings(input.counterEvidenceIds, '反证 ID');
  return {
    eventId: clean(input.eventId, '事件 ID', 200),
    assertionId: clean(input.assertionId, '断言 ID', 200),
    witness: witness(input.witness),
    scope: scope(input.scope, '证据范围'),
    occurredAt: clean(input.occurredAt, '发生时间', 80),
    recordedAt: clean(input.recordedAt, '记录时间', 80),
    help: help(input.help),
    ...(submissionOrder === undefined ? {} : { submissionOrder }),
    direction: oneOf(input.direction, ['support', 'contradict', 'unresolved'] as const, '证据方向'),
    ...(input.originGroupId === undefined ? {} : { originGroupId: clean(input.originGroupId, '来源组 ID', 200) }),
    ...(counterEvidenceIds === undefined ? {} : { counterEvidenceIds }),
  };
};

export function memoryReviewRequest(value: unknown): MemoryReviewRequest {
  const input = record(value, '整理请求');
  const assertion = record(input.assertion, '断言');
  const evidenceInput = input.evidence;
  if (!Array.isArray(evidenceInput) || evidenceInput.length > 500) fail('整理请求');
  const evidenceList = evidenceInput as unknown[];
  return {
    requestId: clean(input.requestId, '请求 ID', 200),
    assertion: { id: clean(assertion.id, '断言 ID', 200), text: clean(assertion.text, '断言文本', 2000), scope: scope(assertion.scope, '断言范围') },
    evidence: evidenceList.map(evidence),
  };
}


const sameScope = (left: MemoryReviewScope, right: MemoryReviewScope): boolean => left.subject === right.subject
  && left.activity === right.activity
  && JSON.stringify(left.conditions ?? []) === JSON.stringify(right.conditions ?? [])
  && left.validFrom === right.validFrom
  && left.validUntil === right.validUntil;

const compatibleScope = (assertion: MemoryReviewScope, item: MemoryReviewScope): boolean => {
  if (item.subject !== assertion.subject) return false;
  if (assertion.activity !== undefined && item.activity !== undefined && item.activity !== assertion.activity) return false;
  if (assertion.conditions?.length && item.conditions?.length) return assertion.conditions.every(condition => item.conditions?.includes(condition));
  return true;
};

const sourceFor = (item: MemoryReviewEvidence, duplicateOf: string | null): MemoryReviewSource => ({
  eventId: item.eventId,
  assertionId: item.assertionId,
  witness: item.witness,
  scope: item.scope,
  occurredAt: item.occurredAt,
  recordedAt: item.recordedAt,
  helpExposed: item.help.exposed,
  helpOrder: item.help.order ?? 'unknown',
  submissionOrder: item.submissionOrder ?? null,
  originGroupId: item.originGroupId ?? null,
  duplicateOf,
});

const finding = (kind: MemoryReviewFinding['kind'], eventIds: readonly string[], reason: string): MemoryReviewFinding => ({ kind, eventIds: [...new Set(eventIds)].sort(), reason });


export const memoryReviewContract = {
  slotType: memoryReviewSlotType,
  deriver: memoryReviewDeriverName,
  version: memoryReviewDeriverVersion,
  input: {
    requestId: 'stable request identity',
    assertion: 'id, text and applicable scope',
    evidence: 'opened host evidence only',
    evidenceFields: ['eventId', 'assertionId', 'witness', 'scope', 'occurredAt', 'recordedAt', 'help', 'submissionOrder', 'direction', 'originGroupId', 'counterEvidenceIds'],
    witnessFields: ['factId', 'revision', 'accessEpoch', 'authorRole', 'sourceVersion'],
    helpStates: ['exposed true/false/unknown', 'order before_submission/after_submission/unknown'],
  },
  output: {
    outcome: ['supported', 'contradicted', 'unresolved'],
    supportedBasis: ['independent', 'assisted', 'mixed'],
    sources: 'one row per opened event with duplicateOf for repeated retellings',
    findings: ['supporting', 'contradicting', 'unresolved'],
    nextEvidence: 'discriminating follow-up evidence, never model confidence',
  },
  guarantees: {
    identity: [
      'same event identity is deduplicated; same origin group keeps one representative source',
      'eventId is the stable identity used for duplicate detection',
      'assertionId links evidence to exactly one reviewed assertion',
      'originGroupId marks records that retell the same origin',
      'duplicateOf points to the representative event for retellings',
      'requestId is carried for caller correlation only',
    ],
    scope: [
      'same-scope support and contradiction are both retained',
      'condition-scoped evidence may coexist with the asserted scope',
      'subject mismatch is always incompatible',
      'activity mismatch is incompatible unless assertion activity is absent',
      'scope conditions are normalized as a sorted set',
      'validFrom and validUntil are preserved without clock inference',
      'broader compatible scope is reported as needing condition distinction',
    ],
    help: [
      'unknown help exposure or order remains unknown',
      'help order unknown is never treated as before_submission',
      'help exposed unknown is never treated as false',
      'submissionOrder is preserved for help-before-submission checks',
      'assisted support does not become independent support',
      'mixed support is reported when independent and assisted evidence coexist',
    ],
    witness: [
      'upstream source revision follows factId/revision/accessEpoch witness identity',
      'authorRole is carried from the host witness, not inferred',
      'occurredAt and recordedAt remain separate caller-supplied times',
      'factId is an opaque stable source identity supplied by the host',
      'revision and accessEpoch are opaque witness revisions supplied by the host',
      'sourceVersion identifies the upstream source revision contract',
    ],
    boundary: [
      'no session, routing, storage, model or confidence input is read',
      'no fact, slot, range or effect is read by this component',
      'no command, proposal, adoption or memory write is emitted',
      'no provider, endpoint, model or confidence field is accepted',
      'output is deterministic for the same opened evidence package',
      'same input package produces the same review result',
      'invalid packages fail before any review result is produced',
      'empty relevant evidence returns unknown rather than a negative claim',
      'conflicting duplicate event IDs return unknown',
      'unresolved direction stays unresolved even when scoped exactly',
      'contradicted requires same-scope contradiction without same-scope support',
      'supported requires same-scope support without same-scope contradiction',
      'support plus same-scope contradiction yields unresolved',
      'same-scope contradiction without support yields contradicted',
      'the component remains callable without a live session',
      'it does not claim integration with real session routing',
      'nextEvidence names the missing discriminating observation',
      'notes state the evidence-only boundary of this review',
    ],
  },
} as const;

export function reviewMemoryEvidence(input: MemoryReviewRequest): Outcome<MemoryReviewResult> {
  const request = memoryReviewRequest(input);
  const relevant = request.evidence.filter(item => item.assertionId === request.assertion.id);
  if (relevant.length === 0) return { kind: 'unknown', reason: '没有打开与该断言对应的证据。' };

  const byEvent = new Map<string, MemoryReviewEvidence>();
  for (const item of relevant) {
    const existing = byEvent.get(item.eventId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) return { kind: 'unknown', reason: `事件 ${item.eventId} 的重复记录内容不一致。` };
    byEvent.set(item.eventId, item);
  }
  const deduped = [...byEvent.values()].sort((left, right) => left.eventId.localeCompare(right.eventId));

  const sources: MemoryReviewSource[] = [];
  const groups = new Map<string, MemoryReviewEvidence[]>();
  for (const item of deduped) {
    const group = item.originGroupId ?? item.eventId;
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  for (const items of [...groups.values()].sort((left, right) => (left[0]?.eventId ?? '').localeCompare(right[0]?.eventId ?? ''))) {
    const representative = [...items].sort((left, right) => left.eventId.localeCompare(right.eventId))[0]!;
    for (const item of items) sources.push(sourceFor(item, items.length > 1 && item.eventId !== representative.eventId ? representative.eventId : null));
  }

  const usable = deduped.filter(item => compatibleScope(request.assertion.scope, item.scope));
  const scoped = usable.filter(item => sameScope(request.assertion.scope, item.scope));
  const broader = usable.filter(item => !sameScope(request.assertion.scope, item.scope));

  const supporting = scoped.filter(item => item.direction === 'support');
  const contradicting = scoped.filter(item => item.direction === 'contradict');
  const unresolvedItems = scoped.filter(item => item.direction === 'unresolved');

  const findings = {
    supporting: supporting.length ? [finding('support', supporting.map(item => item.eventId), '同一适用范围内的支持证据。')] : [],
    contradicting: contradicting.length ? [finding('contradict', contradicting.map(item => item.eventId), '同一适用范围内的相反证据；保留双方。')] : [],
    unresolved: [...unresolvedItems.map(item => finding('unresolved', [item.eventId], '证据方向仍未决。')), ...broader.map(item => finding('unresolved', [item.eventId], '范围相容但不完全相同，需要区分条件。'))],
  };

  const independentSupport = supporting.filter(item => item.help.exposed === false && item.help.order !== 'before_submission' && item.help.order !== 'unknown');
  const assistedSupport = supporting.filter(item => item.help.exposed === true || item.help.order === 'before_submission');
  const unknownSupport = supporting.filter(item => item.help.exposed === 'unknown' || item.help.order === 'unknown');
  const hasUnknownHelp = unknownSupport.length > 0;

  let outcome: MemoryReviewResult['outcome'];
  let basis: 'independent' | 'assisted' | 'mixed' | 'unresolved' = 'unresolved';
  if (contradicting.length > 0 && supporting.length === 0) outcome = { kind: 'contradicted' };
  else if (supporting.length > 0 && contradicting.length === 0) {
    if (independentSupport.length > 0 && assistedSupport.length === 0 && unknownSupport.length === 0) basis = 'independent';
    else if (assistedSupport.length > 0 && independentSupport.length === 0) basis = 'assisted';
    else basis = 'mixed';
    outcome = { kind: 'supported', basis };
  } else {
    outcome = { kind: 'unresolved' };
  }

  const nextEvidence: string[] = [];
  if (contradicting.length && supporting.length) nextEvidence.push('在同一条件下取得可区分支持与反证的新证据。');
  if (broader.length) nextEvidence.push('补充适用范围完全一致的证据，或明确各条件边界。');
  if (hasUnknownHelp) nextEvidence.push('确认帮助是否实际展示及其相对提交顺序。');
  if (!supporting.length && !contradicting.length) nextEvidence.push('取得与该断言直接相关的已打开证据。');
  if (deduped.some(item => item.counterEvidenceIds?.length)) nextEvidence.push('打开被标为反证的原始事件。');

  const notes = ['本结果只整理调用方已经打开的证据，不读取模型置信度，也不替代内核生效协议。', '同一事件的重复转述只保留一份来源身份；同一来源组的其余记录标为重复。', '帮助来源未知时保持 unknown，不推断为无帮助。', '同条件冲突保留双方；条件不同的证据可以并存。', '旧来源改版由上游 witness 的 factId/revision/accessEpoch 跟随，本组件不自行追踪或改写。'];

  const result: MemoryReviewResult = { assertion: request.assertion, outcome, sources, findings, nextEvidence: [...new Set(nextEvidence)], notes };
  return { kind: 'value', value: result };
}
