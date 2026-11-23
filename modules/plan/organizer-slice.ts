import type { Revision } from '@mangekyo/kernel';
import { checkPack, packCandidates } from './offline-pack.ts';
import { organizerTaskDoneInput, organizerTaskDraft } from './organizer-task-values.ts';
import { integer } from './validation.ts';

export function mergePackCandidatesWithCompletion(completed: ReadonlySet<string | null>, day: string) {
  return packCandidates().map(c => completed.has(`${c.id}@${c.open?.rev}`) ? { ...c, state: 'completed' as const, date: day } : c);
}

export function parseOrganizerOpenRev(rawRev: string | null): Revision {
  return integer(Number(rawRev), 1, 2147483647) as Revision;
}

export function parseOfflinePackSubmit(input: Record<string, unknown>) {
  if (input.actor !== undefined || input.consent !== 'teaching') throw new Error('请确认保存本次学习记录。');
  const idOfPack = typeof input.id === 'string' ? input.id : '';
  return checkPack(idOfPack, integer(input.rev, 1, 2147483647), integer(input.choice, 0, 2147483647));
}

export function parseOrganizerTaskInput(input: unknown) {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (typeof value.id === 'string' && value.id.length > 0) {
    return { kind: 'done' as const, commandInput: organizerTaskDoneInput({ ...value, expectedRev: value.expectedRev ?? value.rev }) };
  }
  return { kind: 'create' as const, data: organizerTaskDraft(input) };
}
