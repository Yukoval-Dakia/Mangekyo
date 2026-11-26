import { sourceRefV1, type SourceRefV1 } from '../../modules/activity/source-values.ts';
import { readFrozenWorkbookRecord } from '../../modules/activity/workbook-bank.ts';
import { workspaceEntry, workspaceEntryType, workspaceAttemptTypes, workspaceInput } from '../../modules/activity/workspace-values.ts';
import { goalType } from '../../modules/plan/goal-values.ts';
import { organizerTaskType } from '../../modules/plan/organizer-task-values.ts';
import type { LearnerHost, ReadTransaction } from '../../kernel/src/index.ts';
import { toWitness } from './identity.ts';
import { createNotionReader, type NotionRecipient } from './notion.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';
type ReadValue = {
  id?: unknown; related?: unknown; title?: unknown; kind?: unknown; content?: unknown; sourceRef?: unknown;
  ok?: boolean; part?: { kind?: string }; lens?: string;
  results?: { id?: unknown }[]; observations?: { id?: unknown }[]; recentAttempts?: { id?: unknown }[];
};
export type ReadReceiptState = {
  admit(witness: WorkspaceWitness): void; overview(witness: WorkspaceWitness): void; diagnose(): void;
  open(value: { id: string; title: string; text: string }): void; openPage(witness: WorkspaceWitness): void;
  openRelation(ref: SourceRefV1, witness: WorkspaceWitness): void; openAnswer(witness: WorkspaceWitness): void;
};
export function projectReadReceipts(name: string, args: Record<string, unknown>, value: ReadValue,
  witnesses: readonly WorkspaceWitness[], todoSource: string | undefined, state: ReadReceiptState) {
  const values: ReadValue[] = name === 'open_learning' ? (value as { items?: ReadValue[] }).items ?? [] : [value];
  if (name === 'open_learning' && args.lens === 'diagnose' && values.some(item => item.lens === 'diagnose')) {
    state.diagnose(); witnesses.forEach(state.overview);
  }
  const direct = new Set([value.id, args.related, ...values.flatMap(item => [item.id, item.related,
    ...[...(item.results ?? []), ...(item.observations ?? []), ...(item.recentAttempts ?? [])].map(result => result.id)])]);
  for (const witness of witnesses) {
    if (direct.has(witness.id)) state.admit(witness);
    if ((name === 'read_workspace' && args.id === 'learner' && [goalType, organizerTaskType].includes(witness.type)) ||
        (name === 'read_learner_radar' && witness.id !== todoSource)) state.overview(witness);
  }
  if (name === 'search_workspace' || name === 'read_learner_radar') return;
  for (const item of values) {
    if (typeof item.id !== 'string' || !witnesses.some(witness => witness.id === item.id)) continue;
    state.open({ id: item.id, title: String(item.title ?? item.kind ?? '学习记录'), text: String(item.content ?? JSON.stringify(item)).slice(0, 3000) });
    const ref = sourceRefV1(item.sourceRef);
    const witness = ref && witnesses.find(w => w.id === ref.fact.id && w.rev === ref.fact.rev && w.type === ref.fact.type);
    if (!ref || !witness) continue;
    if (item.ok !== false && item.part?.kind !== 'image_crop') {
      state.openPage(witness);
      if (item.part?.kind !== 'assessment') state.openRelation(ref, witness);
    }
    if (typeof item.content === 'string' && item.content.length && workspaceAttemptTypes.includes(ref.fact.type) &&
        (ref.anchor.kind === 'whole' || ref.anchor.kind === 'answer-slot')) state.openAnswer(witness);
  }
}
export async function reopenWorkspaceBasis(host: LearnerHost, tx: ReadTransaction, witnesses: readonly WorkspaceWitness[], maySend: NotionRecipient) {
  const base = host.trackingReader(tx, 'teaching', maySend);
  const reader = createNotionReader(tx, { purpose: 'teaching', recipient: maySend, base }), bankWitnesses: WorkspaceWitness[] = [];
  let derivedSource = false;
  for (const witness of witnesses) {
    const fact = await reader.reopen({ ...workspaceInput(witness), type: witness.type });
    await readFrozenWorkbookRecord(reader, fact, (source, mode) => bankWitnesses.push(toWitness(source, mode)));
    if (fact.type === workspaceEntryType && ['observation', 'annotation'].includes(workspaceEntry(fact.value).kind)) derivedSource = true;
  }
  return { bankWitnesses, derivedSource };
}

