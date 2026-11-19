import { factId, type FactId, type Revision, type Tick } from '@mangekyo/kernel';
import { memoryReviewRequest, type MemoryReviewDirection } from './memory-review.ts';

export const memoryAssertionType = 'companion.memoryAssertion';
export const manageMemoryAssertionCommand = 'companion.manageMemoryAssertion';
export const memoryLinkKinds = ['source', 'concept', 'family'] as const;
export type MemoryLink = { kind: typeof memoryLinkKinds[number]; id: FactId };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆断言格式无效。');
  return value as Record<string, unknown>;
}

function revision(value: unknown): Revision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new Error('记忆来源版本无效。');
  return value as Revision;
}

function idOf(value: unknown): FactId {
  if (typeof value !== 'string') throw new Error('记忆标识无效。');
  return factId(value);
}

function dateBoundary(value: string | undefined): void {
  if (value !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value))
    throw new Error('记忆的起止时间须为 UTC ISO 时间。');
}

function assertionData(value: unknown) {
  const input = record(value);
  const { assertion: { text, scope } } = memoryReviewRequest({ requestId: 'validate',
    assertion: { id: 'validate', text: input.text, scope: input.scope }, evidence: [] });
  const { validFrom, validUntil } = scope;
  dateBoundary(validFrom);
  dateBoundary(validUntil);
  if (validFrom && validUntil && validFrom >= validUntil) throw new Error('记忆的有效期无效。');
  if (!Array.isArray(input.links) || !input.links.length || input.links.length > 8 ||
      !Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 4)
    throw new Error('记忆须有适用关联及一至四份原始作答。');
  const links = input.links.map((item): MemoryLink => {
    const link = record(item);
    const kind = memoryLinkKinds.find(kind => kind === link.kind);
    if (!kind) throw new Error('记忆关联类型无效。');
    return { kind, id: idOf(link.id) };
  });
  const evidence = input.evidence.map(item => {
    const source = record(item);
    const { itemId, direction } = source;
    if (typeof itemId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(itemId) ||
        (direction !== 'support' && direction !== 'contradict' && direction !== 'unresolved'))
      throw new Error('记忆证据须指向作答位并标明证据方向。');
    return { id: idOf(source.id), rev: revision(source.rev), itemId, direction: direction as MemoryReviewDirection };
  });
  if (new Set(evidence.map(source => source.id)).size !== evidence.length)
    throw new Error('同一次原始作答只能计一次。');
  return { text, scope, links, evidence };
}

export function memoryAssertion(value: unknown) {
  const fields = assertionData(value);
  const stored = record(value).evidence as unknown[];
  return { ...fields, evidence: fields.evidence.map((source, i) => {
    const { accessEpoch } = record(stored[i]);
    if (typeof accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(accessEpoch))
      throw new Error('记忆证据缺少访问代次。');
    return { ...source, accessEpoch: accessEpoch as Tick };
  }) };
}

export function memoryAssertionInput(value: unknown) {
  const input = record(value);
  const id = idOf(input.id);
  if (input.action === 'retract') return { action: input.action, id, expectedRev: revision(input.expectedRev) } as const;
  if (input.action === 'teaching' && typeof input.enabled === 'boolean')
    return { action: input.action, id, expectedRev: revision(input.expectedRev), enabled: input.enabled } as const;
  if (input.action !== 'save') throw new Error('记忆操作无效。');
  const expectedRev = input.expectedRev === undefined ? undefined : revision(input.expectedRev);
  return { action: input.action, id, expectedRev, data: assertionData(input.data) } as const;
}
