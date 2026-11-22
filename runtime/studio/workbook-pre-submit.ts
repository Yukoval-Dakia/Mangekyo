import { createAuthorizedFactReader, isFactReadDenied, isFactUnavailable } from './fact-read-helpers.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactId, Revision, Tick } from '../../kernel/src/declarations/ids.ts';
import type { BusWitness } from '../../kernel/src/pipeline-contracts.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { busWitnessOf, collectPreSubmitRuleBasis, openFrozenPreSubmitPaper, type PreSubmitRevisionCheck } from '../../modules/activity/pre-submit-revision.ts';
import { workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { projectPreSubmitPitfalls, type PreSubmitPitfall, type PreSubmitPitfallInput, type PreSubmitPitfallRead } from '../../modules/learner/pre-submit-pitfalls.ts';
import type { RecurringErrorItemRef } from '../../modules/learner/recurring-error-cluster.ts';
import { purpose as teachingPurpose } from './identity.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { studioWorkbookEvidence } from './retention-workbook.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';

type PitfallRule = PreSubmitPitfallInput['rules'][number];
type StickyRule = Extract<PitfallRule, { readonly kind: 'sticky' }>;
type HypothesisRule = Exclude<PitfallRule, { readonly kind: 'sticky' }>;
export type PreSubmitPitfallRuleCandidate = (
  | Omit<StickyRule, 'ref' | 'basis'>
  | Omit<HypothesisRule, 'ref' | 'basis'>
) & {
  readonly id: FactId;
  readonly extraBasis?: readonly BusWitness[];
};

export type WorkbookPreSubmitAuthority = {
  readonly purpose?: string;
  readonly recipient?: string;
  readonly maySend?: WorkspaceSourceRecipient;
  readonly loadRules?: (tx: ReadTransaction, scope: PreSubmitPitfallRead['scope'], paperId: FactId) =>
    Promise<readonly PreSubmitPitfallRuleCandidate[]>;
  readonly loadHistory?: (tx: ReadTransaction, scope: PreSubmitPitfallRead['scope'], paperId: FactId) =>
    Promise<readonly RecurringErrorItemRef[]>;
  readonly openItem?: PreSubmitPitfallRead['openItem'];
  readonly observeDiscipline?: PreSubmitPitfallRead['observeDiscipline'];
};

export type WorkbookPreSubmitReadOptions = WorkbookPreSubmitAuthority & {
  readonly asOfAt?: string;
  readonly rules?: readonly PreSubmitPitfallRuleCandidate[];
  readonly history?: readonly RecurringErrorItemRef[];
};

export async function buildPreSubmitPitfallRule(
  tx: ReadTransaction,
  scope: PreSubmitPitfallRead['scope'],
  maySend: WorkspaceSourceRecipient,
  candidate: PreSubmitPitfallRuleCandidate,
): Promise<PitfallRule | undefined> {
  const collected = await collectPreSubmitRuleBasis({
    read: createAuthorizedFactReader(tx, scope.purpose, maySend),
    isDenied: isFactReadDenied, kind: candidate.kind, id: candidate.id,
    ...(candidate.extraBasis ? { extraBasis: candidate.extraBasis } : {}),
  });
  if (!collected) return undefined;
  const { ref, basis } = collected;
  return candidate.kind === 'sticky'
    ? { kind: 'sticky', ref, errorStage: candidate.errorStage, conceptIds: candidate.conceptIds, basis }
    : { kind: candidate.kind, stage: candidate.stage, ref, errorStage: candidate.errorStage, conceptIds: candidate.conceptIds, basis };
}

export async function readWorkbookPreSubmitPitfalls(
  tx: ReadTransaction,
  paperId: FactId,
  options: WorkbookPreSubmitReadOptions = {},
): Promise<PreSubmitPitfall[]> {
  const use = options.purpose ?? teachingPurpose;
  const maySend: WorkspaceSourceRecipient = options.maySend ?? (() => true);
  const scope: PreSubmitPitfallRead['scope'] = { learner: tx.learner, purpose: use, recipient: options.recipient ?? 'learner' };
  const authorized = createAuthorizedFactReader(tx, use, maySend);
  const paperFact = await authorized.fact(paperId, { mode: 'following' }).catch(error => {
    if (isFactUnavailable(error)) return undefined;
    throw error;
  });
  if (!paperFact || paperFact.type !== workbookPaperType) return [];
  const { rows: [clockRow] } = await tx.query<{ tick: Tick }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [tx.learner]);
  const observedThrough = clockRow?.tick ?? ('0' as Tick);
  const candidates = options.rules ?? (await options.loadRules?.(tx, scope, paperId)) ?? [];
  if (!candidates.length) return [];
  const rules = (await Promise.all(candidates.map(candidate => buildPreSubmitPitfallRule(tx, scope, maySend, candidate))))
    .filter((rule): rule is PitfallRule => rule !== undefined);
  if (!rules.length) return [];
  const history = options.history ?? (await options.loadHistory?.(tx, scope, paperId)) ?? [];
  const evidence = studioWorkbookEvidence(use, maySend);
  const reader: PreSubmitPitfallRead = {
    scope,
    reopen: (_scope, ref) => authorized.fact(ref.id, ref.mode === 'following' ? { mode: 'following' } : { mode: 'pinned', rev: ref.rev })
      .catch(error => { if (isFactUnavailable(error)) return undefined; throw error; }),
    openItem: options.openItem ?? (async () => undefined),
    ...(options.observeDiscipline ? { observeDiscipline: options.observeDiscipline } : {}),
    openPaper: (_scope, witness) => openFrozenPreSubmitPaper({
      tx, read: authorized, purpose: use, observedThrough, witness, isDenied: isFactReadDenied,
      readConceptLinks: source => evidence.readItemConceptLinks(tx, source, observedThrough,
        edgeId => openKnowledgeEdge(tx, edgeId, { recipient: 'workspace', purpose: use, maySend })),
    }),
  };
  return projectPreSubmitPitfalls(reader, {
    asOfAt: options.asOfAt ?? new Date().toISOString(), observedThrough, paper: busWitnessOf(paperFact, 'following'), history, rules,
  });
}

export async function verifyWorkbookPreSubmitRevision(
  tx: ReadTransaction,
  check: PreSubmitRevisionCheck,
  authority: WorkbookPreSubmitAuthority = {},
): Promise<boolean> {
  const pitfalls = await readWorkbookPreSubmitPitfalls(tx, check.paperId, { ...authority, asOfAt: check.submittedAt });
  const authorizedAnchors = new Set(pitfalls.flatMap(pitfall => pitfall.anchors.map(anchor => anchor.itemId)));
  const eligible = check.candidateItemIds.filter(itemId => authorizedAnchors.has(itemId));
  if (!eligible.length) return false;
  const { rows: [clockRow] } = await tx.query<{ tick: Tick }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [tx.learner]);
  const cutoff = (BigInt(clockRow?.tick ?? '0') + 1n).toString() as Tick;
  const evidence = studioWorkbookEvidence(storagePurpose, () => true);
  for (const itemId of eligible) {
    const result = await evidence.readPreSubmitIndependence(
      tx, { id: check.paperId, rev: check.paperRev }, itemId,
      { learner: tx.learner, id: check.attemptId, rev: 1 as Revision }, cutoff,
    );
    if (result.independent) return true;
  }
  return false;
}
