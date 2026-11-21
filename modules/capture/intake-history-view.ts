import { FactNotFoundError, type BusWitness, type FactId, type FactSnapshot, type LearnerId,
  type Outcome, type ReadContext } from '@mangekyo/kernel';
import materialFact from '@mangekyo/module-content/facts/material';
import { intakeFactType, intakeDocument } from './intake-values.ts';
import { captureSourceType, sourceBlocks, sourceEnvelope, validSourceCropPage, type Block, type SourceEnvelope } from './source.ts';
import { layeredExtractionSlot, mayExtract, mergeExtraction, type LayeredExtractionValue } from './extraction.ts';
import { openSelectedNotionSource } from './notion-source.ts';
import type { NotionFactReader } from './notion-selection.ts';
import { reconcileAnswerRegions } from './paper-answer-regions.ts';

export const intakeHistoryLimit = 128;
const excerptLimit = 140;

export type IntakeHistoryAccess = {
  readonly learner: LearnerId;
  readonly purpose: string;
  readonly recipient: string;
  /** Recipient-authorized fact/slot reader for the items themselves. */
  readonly read: ReadContext;
  /** Storage-scoped reader used to re-verify Notion selection grants.
   * When omitted, `purpose === 'storage'` reuses `read`; for any other purpose
   * Notion originals are hidden unless `selectionRead` can verify them. */
  readonly selectionRead?: NotionFactReader;
  /** Treats a read failure as per-item unavailability instead of an operational error. */
  readonly isUnavailable?: (error: unknown) => boolean;
  /** Warm the bound reader's following cache; every fact read still authorizes itself. */
  readonly preloadFollowing?: (ids: readonly FactId[]) => Promise<void>;
};

export type IntakeHistoryInput = {
  /** Already authorized snapshot rows for this learner: capture.source + activity.intakeDocument. */
  readonly facts: readonly FactSnapshot[];
  /**
   * Layered-extraction inputs keyed by source fact id. A `DerivationSnapshot`-shaped
   * `read` bound to `layeredExtractionSlot` resolves each key itself; otherwise pass
   * settled `Outcome` values. Both are re-validated against the reopened fact.
   */
  readonly extractions?: Readonly<Record<string, Outcome<LayeredExtractionValue> | null>>;
  readonly limit?: number;
};

export type IntakePreviewRef =
  | { readonly kind: 'original'; readonly originalIndex: number; readonly name: string; readonly mediaType: string }
  | { readonly kind: 'crop'; readonly originalIndex: number; readonly page: number; readonly bbox: readonly [number, number, number, number] };

export type IntakeStatus = 'organizing' | 'needs_confirmation' | 'ready';
export type IntakeStatusLabel = '整理中' | '待你确认' | '整理好了';

export type IntakeQuestionPreview = {
  readonly questionId: string | null;
  readonly blockId: string;
  readonly excerpt: string;
  readonly needsConfirmation: boolean;
};

export type IntakeHistoryEntry = {
  readonly id: string;
  readonly rev: number;
  readonly accessEpoch: string;
  readonly kind: string;
  readonly title: string;
  readonly recordedAt: string | null;
  readonly occurredAt: string | null;
  readonly preview: IntakePreviewRef | null;
  /** Page count among originals; `null` when no paged original exists (e.g. voice/text). */
  readonly pageCount: number | null;
  /** Count of distinct question anchors (`itemId`/`questionId`) visible in previews. */
  readonly extractedQuestionCount: number;
  readonly status: IntakeStatus;
  readonly statusLabel: IntakeStatusLabel;
  readonly pendingConfirmationCount: number;
  readonly questionPreviews: readonly IntakeQuestionPreview[];
  readonly proof: readonly BusWitness[];
};

const statusLabel: Record<IntakeStatus, IntakeStatusLabel> = {
  organizing: '整理中', needs_confirmation: '待你确认', ready: '整理好了',
};

/** Layers a learner-facing timeline may surface in previews: printed prompts and shared material only.
 * Answers, rubrics, grading ink and annotations never reach previews or pending counts. */
const previewLayers = new Set<Block['body']['layer']>(['material', 'prompt']);
/** Layers whose pending unknown blocks require learner confirmation (includes learner handwriting). */
const confirmationLayers = new Set<Block['body']['layer']>(['material', 'prompt', 'handwriting']);

function witnessOf(fact: FactSnapshot, mode: 'pinned' | 'following'): BusWitness {
  return { learner: fact.ref.learner, id: fact.ref.id, rev: fact.ref.rev,
    type: fact.type, mode, accessEpoch: fact.accessEpoch };
}

function excerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > excerptLimit ? clean.slice(0, excerptLimit).trimEnd() + '…' : clean;
}

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function purposeAllows(fact: FactSnapshot, purpose: string) {
  return fact.purpose.includes('all') || fact.purpose.includes(purpose);
}

/** Per-item unavailability: the record was erased, retracted, or denied to this
 * recipient/purpose. Anything else (operational failures) propagates. */
function itemUnavailable(access: IntakeHistoryAccess, error: unknown) {
  if (error instanceof FactNotFoundError || access.isUnavailable?.(error)) return true;
  // kernel's FactReadDeniedError carries a denial reason; it is not re-exported by
  // @mangekyo/kernel, so detect it structurally rather than by instanceof.
  return error instanceof Error &&
    (error.constructor.name === 'FactReadDeniedError' ||
      (error as { reason?: unknown }).reason !== undefined && error.constructor.name === 'Error' &&
      ['purpose', 'retracted', 'recipient', 'changed'].includes(String((error as { reason?: unknown }).reason)));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every(key =>
    Object.hasOwn(right, key) && sameJson(Reflect.get(left, key), Reflect.get(right, key)));
}

// Mirrors extraction.ts's parsedExtractionForSource + validCropBranches: an outcome is
// mergeable only for visual sources while the fact still permits extraction, its basis
// belongs to this fact at or before the current rev, the access epoch matches, originals
// match byte for byte, every block satisfies capture extraction semantics, and each
// retained crop branch keeps a valid page on this source's originals.
function settledExtraction(fact: FactSnapshot, source: SourceEnvelope,
  outcome: Outcome<LayeredExtractionValue> | null): readonly Block[] | null {
  if (source.kind !== 'photo' && source.kind !== 'pdf' && source.kind !== 'paper-return') return null;
  if (outcome?.kind !== 'value' || !outcome.value || typeof outcome.value !== 'object') return null;
  try {
    const { basis, originals, blocks } = outcome.value;
    if (!basis || typeof basis !== 'object' || !basis.target || typeof basis.target !== 'object') return null;
    if (!mayExtract(fact) || basis.target.id !== fact.ref.id || basis.learner !== fact.ref.learner ||
        basis.target.rev > fact.ref.rev || basis.accessEpoch !== fact.accessEpoch ||
        !sameJson(originals, source.originals)) return null;
    const parsed = sourceBlocks(blocks, source.kind, source.originals);
    for (const { body } of parsed) {
      if (body.status === 'known' ? body.sticky : body.clarification !== 'pending') return null;
      if ((body.layer === 'prompt' || body.layer === 'handwriting') && !body.itemId) return null;
      if (body.layer === 'handwriting' && !body.slotId) return null;
    }
    const retained = new Set<string>();
    return parsed.filter(({ id, parentId, body }) => {
      if ((parentId !== null && !retained.has(parentId)) ||
          (body.crop_ref && !validSourceCropPage(body.crop_ref, source.originals))) return false;
      retained.add(id);
      return true;
    });
  } catch {
    return null;
  }
}

function pageCountFor(source: SourceEnvelope, blocks: readonly Block[]): number | null {
  if (source.kind === 'voice') return null;
  const fromBlocks = blocks.reduce((max, { body }) => Math.max(max, body.crop_ref?.page ?? 0), 0);
  const pages = Math.max(fromBlocks, source.originals.length);
  return pages > 0 ? pages : null;
}

function firstVisibleCrop(blocks: readonly Block[]): IntakePreviewRef | null {
  for (const { body } of blocks) {
    if (!previewLayers.has(body.layer)) continue;
    const crop = body.crop_ref;
    if (crop) return { kind: 'crop', originalIndex: crop.original, page: crop.page, bbox: crop.bbox };
  }
  return null;
}

function previewRef(source: SourceEnvelope, blocks: readonly Block[]): IntakePreviewRef | null {
  if (!source.originals.length) return null;
  const crop = firstVisibleCrop(blocks);
  if (crop && source.originals[crop.originalIndex]) return crop;
  const first = source.originals[0]!;
  return { kind: 'original', originalIndex: 0, name: first.name, mediaType: first.mediaType };
}

function questionPreviews(blocks: readonly Block[]): IntakeQuestionPreview[] {
  const previews: IntakeQuestionPreview[] = [];
  for (const { id, body } of blocks) {
    if (!previewLayers.has(body.layer)) continue;
    if (body.status === 'unknown') {
      if (body.layer === 'prompt')
        previews.push({ questionId: body.itemId ?? null, blockId: id, excerpt: '', needsConfirmation: true });
    } else if (body.text.trim()) {
      previews.push({ questionId: body.itemId ?? null, blockId: id, excerpt: excerpt(body.text), needsConfirmation: false });
    }
  }
  return previews;
}

function pendingConfirmations(source: SourceEnvelope, blocks: readonly Block[]): number {
  let pending = blocks.filter(({ body }) =>
    confirmationLayers.has(body.layer) && body.status === 'unknown' && body.clarification === 'pending').length;
  if (source.kind === 'voice' && !source.transcriptConfirmed) pending += 1;
  if (source.kind === 'url' && source.urlReadConfirmed === true && !source.unit.blocks.length && !source.originals.length)
    pending += 1;
  return pending;
}

function projectSource(fact: FactSnapshot, source: SourceEnvelope,
  outcome: Outcome<LayeredExtractionValue> | null): IntakeHistoryEntry {
  const candidate = settledExtraction(fact, source, outcome);
  let blocks: readonly Block[] = source.unit.blocks;
  let settled = false;
  if (candidate) {
    try {
      blocks = mergeExtraction(source, candidate);
      settled = true;
    } catch {
      // A candidate that cannot merge over learner-kept edits is dropped, never fatal.
    }
  }
  if (source.paperAnswerEdits?.length) {
    const edits = source.paperAnswerEdits.map(edit => edit.block);
    blocks = reconcileAnswerRegions(blocks, edits);
  }
  const needsExtraction = (source.kind === 'photo' || source.kind === 'pdf' || source.kind === 'paper-return') &&
    mayExtract(fact);
  const pending = pendingConfirmations(source, blocks);
  const organizing =
    (needsExtraction && !settled) ||
    (source.kind === 'voice' && !source.transcriptConfirmed) ||
    (source.kind === 'url' && source.urlReadConfirmed === true && !source.unit.blocks.length && !source.originals.length);
  const status: IntakeStatus = pending > 0 ? 'needs_confirmation' : organizing ? 'organizing' : 'ready';
  const previews = questionPreviews(blocks);
  return {
    id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch, kind: source.kind,
    title: source.unit.title, recordedAt: source.recordedAt, occurredAt: source.occurredAt,
    preview: previewRef(source, blocks),
    pageCount: pageCountFor(source, blocks),
    extractedQuestionCount: new Set(previews.map(preview => preview.questionId).filter(id => id !== null)).size,
    status, statusLabel: statusLabel[status], pendingConfirmationCount: pending,
    questionPreviews: previews,
    proof: [witnessOf(fact, 'following')],
  };
}

function projectIntake(fact: FactSnapshot, document: ReturnType<typeof intakeDocument>): IntakeHistoryEntry {
  const { extraction } = document;
  const drafts = extraction.drafts;
  const draftPreviews: IntakeQuestionPreview[] = drafts
    ? drafts.questions.map(question => ({
        questionId: null,
        blockId: question.draftId,
        excerpt: excerpt(question.stem),
        needsConfirmation: true,
      }))
    : [];
  const draftPending = drafts && drafts.pendingConfirmationCount > 0 ? drafts.pendingConfirmationCount : 0;
  const status: IntakeStatus = extraction.status === 'pending' ? 'organizing'
    : extraction.status === 'failed' ? 'needs_confirmation'
    : draftPending > 0 ? 'needs_confirmation'
    : 'ready';
  const image = document.original.mediaType.startsWith('image/') || document.original.mediaType === 'application/pdf';
  const previews: IntakeQuestionPreview[] = draftPreviews.length > 0
    ? draftPreviews
    : extraction.text.trim() && extraction.status !== 'pending' && extraction.status !== 'failed'
      ? [{ questionId: null, blockId: 'text', excerpt: excerpt(extraction.text), needsConfirmation: false }]
      : [];
  return {
    id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch,
    kind: document.original.mediaType.startsWith('image/') ? 'photo'
      : document.original.mediaType === 'application/pdf' ? 'pdf' : 'text',
    title: document.title,
    recordedAt: null, occurredAt: null,
    preview: image ? { kind: 'original', originalIndex: 0, name: document.original.name, mediaType: document.original.mediaType } : null,
    pageCount: extraction.pages,
    extractedQuestionCount: drafts ? drafts.questions.length : previews.length,
    status, statusLabel: statusLabel[status],
    pendingConfirmationCount: draftPending > 0 ? draftPending : status === 'needs_confirmation' ? 1 : 0,
    questionPreviews: previews,
    proof: [witnessOf(fact, 'following')],
  };
}

export function intakeHistoryInput(input: unknown): IntakeHistoryInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('交入历史请求无效。');
  const row = input as Record<string, unknown>;
  if (!Array.isArray(row.facts)) throw new Error('交入历史缺少事实行。');
  const limit = row.limit === undefined ? intakeHistoryLimit : row.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > intakeHistoryLimit)
    throw new Error('交入历史上限无效。');
  const uniqueIds = new Set(
    (row.facts as readonly FactSnapshot[])
      .filter(fact => fact && typeof fact === 'object' && fact.ref && typeof fact.ref.id === 'string')
      .map(fact => fact.ref.id),
  );
  if (uniqueIds.size > intakeHistoryLimit || row.facts.length > intakeHistoryLimit * 4)
    throw new Error('交入历史候选数超过上限。');
  return {
    facts: row.facts as readonly FactSnapshot[],
    ...(row.extractions === undefined ? {} : { extractions: row.extractions as Record<string, Outcome<LayeredExtractionValue> | null> }),
    limit,
  };
}

async function resolveExtraction(access: IntakeHistoryAccess, fact: FactSnapshot,
  provided: Outcome<LayeredExtractionValue> | null | undefined): Promise<Outcome<LayeredExtractionValue> | null> {
  if (provided !== null && provided !== undefined) return provided;
  try {
    const snapshot = await access.read.slot<LayeredExtractionValue>(
      { learner: access.learner, type: layeredExtractionSlot, key: fact.ref.id }, { mode: 'following' });
    if (snapshot.slot.learner !== access.learner || snapshot.slot.type !== layeredExtractionSlot ||
        snapshot.slot.key !== fact.ref.id) return null;
    return snapshot.outcome;
  } catch (error) {
    if (itemUnavailable(access, error)) return null;
    // Slot reads are optional for this projection; an unimplemented unit stays null.
    if (error instanceof Error && error.constructor.name === 'UnsupportedReadError') return null;
    throw error;
  }
}

async function reopenSource(access: IntakeHistoryAccess, candidate: FactSnapshot): Promise<FactSnapshot | null> {
  const fact = await access.read.fact(candidate.ref.id, { mode: 'following' });
  if (fact.type !== captureSourceType || fact.ref.learner !== access.learner ||
      !purposeAllows(fact, access.purpose)) return null;
  const source = parseValue(() => sourceEnvelope(fact.value));
  if (!source || source.workbookAttachment) return null;
  if (source.kind !== 'notion') return fact;
  const selectionRead = access.selectionRead ?? (access.purpose === 'storage' ? access.read : undefined);
  if (!selectionRead) return null;
  try {
    return await openSelectedNotionSource({
      learner: access.learner, purpose: access.purpose, recipientId: access.recipient,
      selectionRead, sourceRead: access.read,
    }, fact.ref.id, { mode: 'following' });
  } catch (error) {
    if (itemUnavailable(access, error)) return null;
    if (error instanceof Error && error.message === 'Notion 选源不可用。') return null;
    throw error;
  }
}

/** Parses a stored fact value. A malformed value returns `null` (that item is skipped);
 * parse failures are always plain `Error` from the capture/intake validators. */
function parseValue<T>(parse: () => T): T | null {
  try { return parse(); } catch { return null; }
}

/** Read-only intake-history projection for the learner's 「交入」 timeline.
 * `input.facts` are candidate rows already opened under this same authorized snapshot;
 * every dependency is reopened through `access.read` (and `read.slot` for the layered
 * extraction when the caller did not supply one), so revoked, repurposed or erased
 * records drop out per item rather than failing the whole list. `kind: 'notion'`
 * originals are additionally re-verified against their live selection grant through
 * `openSelectedNotionSource`; a revoked or narrowed grant hides the item entirely.
 * Sort: recordedAt/occurredAt desc, id asc (deterministic code-point order). */
export async function readIntakeHistoryView(
  access: IntakeHistoryAccess,
  input: IntakeHistoryInput,
): Promise<{ readonly learner: LearnerId; readonly purpose: string; readonly items: readonly IntakeHistoryEntry[] }> {
  const limit = input.limit ?? intakeHistoryLimit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > intakeHistoryLimit)
    throw new Error('交入历史上限无效。');
  if (!access.purpose.trim() || !access.recipient.trim())
    return { learner: access.learner, purpose: access.purpose, items: [] };
  const seen = new Set<FactId>();
  const candidates = input.facts.filter(fact =>
    (fact.type === captureSourceType || fact.type === intakeFactType) && fact.ref.learner === access.learner &&
    !seen.has(fact.ref.id) && (seen.add(fact.ref.id), true));
  if (candidates.length > intakeHistoryLimit) throw new Error('交入历史候选数超过上限。');
  await access.preloadFollowing?.(candidates.map(fact => fact.ref.id));
  const materialIds = new Set<FactId>();
  for (const fact of candidates) {
    if (fact.type !== intakeFactType) continue;
    try { materialIds.add(intakeDocument(fact.value).materialId); } catch { /* bad row skipped per item below */ }
  }
  if (materialIds.size) await access.preloadFollowing?.([...materialIds]);
  const items: IntakeHistoryEntry[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.type === captureSourceType) {
        const fact = await reopenSource(access, candidate);
        if (!fact) continue;
        const outcome = await resolveExtraction(access, fact, input.extractions?.[fact.ref.id] ?? null);
        const source = parseValue(() => sourceEnvelope(fact.value));
        if (!source) continue;
        items.push(projectSource(fact, source, outcome));
      } else if (candidate.type === intakeFactType) {
        const fact = await access.read.fact(candidate.ref.id, { mode: 'following' });
        if (fact.type !== intakeFactType || fact.ref.learner !== access.learner ||
            !purposeAllows(fact, access.purpose)) continue;
        const document = parseValue(() => intakeDocument(fact.value));
        if (!document) continue;
        const entry = projectIntake(fact, document);
        items.push(entry);
        let material: FactSnapshot;
        try {
          material = await access.read.fact(document.materialId, { mode: 'following' });
        } catch (error) {
          if (!itemUnavailable(access, error)) throw error;
          continue;
        }
        if (material.ref.learner === access.learner && material.type === materialFact.type &&
            purposeAllows(material, access.purpose) &&
            parseValue(() => materialFact.schema.parse(material.value)) !== null)
          (entry.proof as BusWitness[]).push(witnessOf(material, 'following'));
      }
    } catch (error) {
      if (itemUnavailable(access, error)) continue;
      throw error;
    }
  }
  items.sort((a, b) =>
    compareText(b.recordedAt ?? b.occurredAt ?? '', a.recordedAt ?? a.occurredAt ?? '') || compareText(a.id, b.id));
  return { learner: access.learner, purpose: access.purpose, items: items.slice(0, limit) };
}
