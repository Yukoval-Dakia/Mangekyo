import type { BusWitness, FactId, ReadTransaction, Revision, Tick } from '../../kernel/src/index.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { busWitnessOf, collectPreSubmitRuleBasis, openFrozenPreSubmitPaper, type PreSubmitRevisionCheck } from '../../modules/activity/pre-submit-revision.ts';
import { workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { assemblePreSubmitRule, selectAuthorizedPreSubmitItems } from '../../modules/learner/diagnosis-slice.ts';
import { projectPreSubmitPitfalls, type PreSubmitPitfall, type PreSubmitPitfallInput, type PreSubmitPitfallRead } from '../../modules/learner/pre-submit-pitfalls.ts';
import type { RecurringErrorItemRef } from '../../modules/learner/recurring-error-cluster.ts';
import { createAuthorizedFactReader, isFactReadDenied, readAuthorizedFactOrNull } from './fact-read-helpers.ts';
import { purpose as teachingPurpose } from './identity.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { studioWorkbookEvidence } from './retention-workbook.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';

type PitfallRule = PreSubmitPitfallInput['rules'][number];
export type PreSubmitPitfallRuleCandidate = (
  | Omit<Extract<PitfallRule, { readonly kind: 'sticky' }>, 'ref' | 'basis'>
  | Omit<Exclude<PitfallRule, { readonly kind: 'sticky' }>, 'ref' | 'basis'>
) & { readonly id: FactId; readonly extraBasis?: readonly BusWitness[] };

export type WorkbookPreSubmitAuthority = {
  readonly purpose?: string;
  readonly recipient?: string;
  readonly maySend?: WorkspaceSourceRecipient;
  readonly loadRules?: (tx: ReadTransaction, scope: PreSubmitPitfallRead['scope'], paperId: FactId) => Promise<readonly PreSubmitPitfallRuleCandidate[]>;
  readonly loadHistory?: (tx: ReadTransaction, scope: PreSubmitPitfallRead['scope'], paperId: FactId) => Promise<readonly RecurringErrorItemRef[]>;
  readonly openItem?: PreSubmitPitfallRead['openItem'];
  readonly observeDiscipline?: PreSubmitPitfallRead['observeDiscipline'];
};
export type WorkbookPreSubmitReadOptions = WorkbookPreSubmitAuthority & {
  readonly asOfAt?: string;
  readonly rules?: readonly PreSubmitPitfallRuleCandidate[];
  readonly history?: readonly RecurringErrorItemRef[];
};

const learnerClock = async (tx: ReadTransaction): Promise<Tick> =>
  (await tx.query<{ tick: Tick }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [tx.learner])).rows[0]?.tick ?? ('0' as Tick);

export async function buildPreSubmitPitfallRule(tx: ReadTransaction, scope: PreSubmitPitfallRead['scope'],
  maySend: WorkspaceSourceRecipient, candidate: PreSubmitPitfallRuleCandidate): Promise<PitfallRule | undefined> {
  const collected = await collectPreSubmitRuleBasis({
    read: createAuthorizedFactReader(tx, scope.purpose, maySend), isDenied: isFactReadDenied, kind: candidate.kind, id: candidate.id,
    ...(candidate.extraBasis ? { extraBasis: candidate.extraBasis } : {}),
  });
  return collected ? assemblePreSubmitRule(candidate, collected.ref, collected.basis) : undefined;
}

export async function readWorkbookPreSubmitPitfalls(tx: ReadTransaction, paperId: FactId, options: WorkbookPreSubmitReadOptions = {}): Promise<PreSubmitPitfall[]> {
  const use = options.purpose ?? teachingPurpose, maySend: WorkspaceSourceRecipient = options.maySend ?? (() => true);
  const scope: PreSubmitPitfallRead['scope'] = { learner: tx.learner, purpose: use, recipient: options.recipient ?? 'learner' };
  const paperFact = await readAuthorizedFactOrNull(tx, use, maySend, paperId, { mode: 'following' });
  if (!paperFact || paperFact.type !== workbookPaperType) return [];
  const observedThrough = await learnerClock(tx);
  const candidates = options.rules ?? (await options.loadRules?.(tx, scope, paperId)) ?? [];
  if (!candidates.length) return [];
  const rules = (await Promise.all(candidates.map(candidate => buildPreSubmitPitfallRule(tx, scope, maySend, candidate))))
    .filter((rule): rule is PitfallRule => rule !== undefined);
  if (!rules.length) return [];
  const history = options.history ?? (await options.loadHistory?.(tx, scope, paperId)) ?? [];
  const authorized = createAuthorizedFactReader(tx, use, maySend), evidence = studioWorkbookEvidence(use, maySend);
  const reader: PreSubmitPitfallRead = {
    scope,
    reopen: (_scope, ref) => readAuthorizedFactOrNull(tx, use, maySend, ref.id, ref.mode === 'following' ? { mode: 'following' } : { mode: 'pinned', rev: ref.rev }),
    openItem: options.openItem ?? (async () => undefined),
    ...(options.observeDiscipline ? { observeDiscipline: options.observeDiscipline } : {}),
    openPaper: (_scope, witness) => openFrozenPreSubmitPaper({
      tx, read: authorized, purpose: use, observedThrough, witness, isDenied: isFactReadDenied,
      readConceptLinks: source => evidence.readItemConceptLinks(tx, source, observedThrough, edgeId => openKnowledgeEdge(tx, edgeId, { recipient: 'workspace', purpose: use, maySend })),
    }),
  };
  return projectPreSubmitPitfalls(reader, { asOfAt: options.asOfAt ?? new Date().toISOString(), observedThrough, paper: busWitnessOf(paperFact, 'following'), history, rules });
}

export async function verifyWorkbookPreSubmitRevision(tx: ReadTransaction, check: PreSubmitRevisionCheck, authority: WorkbookPreSubmitAuthority = {}): Promise<boolean> {
  const eligible = selectAuthorizedPreSubmitItems(await readWorkbookPreSubmitPitfalls(tx, check.paperId, { ...authority, asOfAt: check.submittedAt }), check.candidateItemIds);
  if (!eligible.length) return false;
  const cutoff = (BigInt(await learnerClock(tx)) + 1n).toString() as Tick, evidence = studioWorkbookEvidence(storagePurpose, () => true);
  for (const itemId of eligible) {
    const result = await evidence.readPreSubmitIndependence(tx, { id: check.paperId, rev: check.paperRev }, itemId, { learner: tx.learner, id: check.attemptId, rev: 1 as Revision }, cutoff);
    if (result.independent) return true;
  }
  return false;
}
