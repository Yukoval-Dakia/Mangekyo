import {
  factId,
  type CommandContext,
  type FactId,
  type FactSnapshot,
  type Revision,
} from '@mangekyo/kernel';
import { textMaterial } from './library-values.ts';
import { positiveRevision, recordParser, textValue } from './validation.ts';

export const organizerNoteType = 'activity.organizerNote';

export const createOrganizerNote = 'activity.organizerCreateNote';
export const saveOrganizerNote = 'activity.organizerSaveNote';
export const restoreOrganizerNote = 'activity.organizerRestoreNote';

const titleLimit = 240;
const markdownLimit = 8000;

export type OrganizerNoteSource = {
  readonly id: FactId; readonly title: string;
};

export type OrganizerNote = {
  readonly title: string; readonly markdown: string; readonly source: OrganizerNoteSource | null;
};

export type OrganizerNoteDraft = {
  readonly title: string; readonly markdown: string; readonly materialId: FactId | null;
};

const record = recordParser(() => new Error('安排格式无效。'));
const text = (input: Record<string, unknown>, key: string, limit: number, label: string): string =>
  textValue(input[key], () => new Error(`${label}无效。`), { limit, preserveWhitespace: true });

function title(input: unknown, key = 'title'): string {
  return text(record(input), key, titleLimit, '标题').trim();
}

const revision = (input: Record<string, unknown>, key: string): Revision =>
  positiveRevision(input[key], () => new Error('版本号无效。'));

function material(input: Record<string, unknown>): FactId | null {
  const value = input.materialId;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('链接材料无效。');
  return factId(value);
}

function parsedSource(value: unknown): OrganizerNoteSource | null {
  if (value === null) return null;
  const source = record(value);
  if (typeof source.id !== 'string') throw new Error('笔记来源无效。');
  return { id: factId(source.id), title: title(source) };
}

export function organizerNote(input: unknown): OrganizerNote {
  const value = record(input);
  const markdown = text(value, 'markdown', markdownLimit, '笔记正文');
  return { title: title(value), markdown, source: parsedSource(value.source) };
}

export function organizerNoteView(current: FactSnapshot, history: readonly FactSnapshot[]) {
  const version = (fact: FactSnapshot) => ({ rev: fact.ref.rev, ...organizerNote(fact.value) });
  return { id: current.ref.id, ...version(current), versions: history.map(version) };
}

export function organizerNoteDraft(input: unknown): OrganizerNoteDraft {
  const value = record(input);
  return {
    title: title(value), markdown: text(value, 'markdown', markdownLimit, '笔记正文'),
    materialId: material(value),
  };
}

export function organizerNoteSaveInput(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string') throw new Error('笔记标识无效。');
  return {
    id: factId(value.id), expectedRev: revision(value, 'expectedRev'),
    ...organizerNoteDraft(value),
  };
}

export function organizerNoteRestoreInput(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string') throw new Error('笔记标识无效。');
  const expectedRev = revision(value, 'expectedRev');
  const restoreRev = revision(value, 'restoreRev');
  if (restoreRev >= expectedRev) throw new Error('只能恢复更早的版本。');
  return { id: factId(value.id), expectedRev, restoreRev };
}

export function prepareOrganizerNote(input: unknown, newId: FactId) {
  const value = record(input);
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return { type: createOrganizerNote, input: { id: newId, ...organizerNoteDraft(input) } };
  }
  const target = { ...value, expectedRev: value.expectedRev ?? value.rev };
  return value.restoreRev === undefined
    ? { type: saveOrganizerNote, input: organizerNoteSaveInput(target) }
    : { type: restoreOrganizerNote, input: organizerNoteRestoreInput(target) };
}

export async function verifiedSource(
  ctx: CommandContext, materialId: FactId | null,
): Promise<OrganizerNoteSource | null> {
  if (materialId === null) return null;
  const material = await ctx.read.fact(materialId, { mode: 'following' });
  const value = textMaterial(material.value);
  return { id: materialId, title: value.title };
}

export function projectLegacyTextbookNote(fact: FactSnapshot) {
  return {
    kind: 'legacyNote' as const, readOnly: true as const, owner: organizerNoteType,
    ...fact.ref, accessEpoch: fact.accessEpoch, purpose: fact.purpose, ...organizerNote(fact.value),
  };
}
