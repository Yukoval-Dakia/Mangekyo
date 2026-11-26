import {
  createAuthorizedFactReader, createCommandReadContext, readLearnerClock, type Db, type DbTransaction, type ReadTransaction,
} from '../../kernel/src/index.ts';
import { studioHost, teachingRead } from './identity.ts';

import { factId, learnerId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import type { BusWitness } from '../../kernel/src/pipeline-contracts.ts';
import { cancelWork, readReadyWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { completeTodo, deferDispatchedTodo, emitTodo, readTodo, type TodoDeferral, type TodoSpec } from '../../kernel/src/work/todos.ts';
import { readActivitySubmissionBirth, workbookLinkCandidates } from '../../modules/activity/evidence-read.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { posttestIssuanceType } from '../../modules/activity/retention-posttest.ts';
import { memoWorkbookFacts } from '../../modules/activity/workbook-context-read.ts';
import { openWorkbookCorrectionTarget, recordWorkbookCorrection, workbookCorrection, workbookCorrectionType } from '../../modules/activity/workbook-correction.ts';
import { sameWorkbookJson, setWorkbookResearchUse, workbookAttemptType, workbookPaper, workbookPaperType, WorkbookSourceMismatch } from '../../modules/activity/workbook-values.ts';
import { researchPurpose } from '../../modules/companion/research.ts';
import { knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { correctionRetestDue, scheduleCorrectionRetest, type CorrectionReopen, type RecordedCorrection } from '../../modules/learner/correction-check.ts';
import { whenAvailable } from './research-sources.ts';

type NotDispatched = 'coverage_unknown' | 'no_unexposed_variant';
type ScheduledCorrection = { correction: RecordedCorrection; through: string };
export const correctionRetestDeriver = 'studio/correction-retest-v1';
export type CorrectionRetestAuthority = {
  // Both calls use the locked learner transaction. No external I/O or payload is handed to Temporal.
  probe(tx: ReadTransaction, input: ScheduledCorrection): Promise<'ready' | NotDispatched>;
  // Return a formal Activity issuance committed through this transaction, or a reason without writing an issuance.
  issue(tx: DbTransaction, input: ScheduledCorrection): Promise<{ issuanceId: FactId } | NotDispatched>;
};
const explicitResearch = (fact: FactSnapshot) => fact.purpose.includes(researchPurpose);
const witness = ({ ref, type, accessEpoch }: FactSnapshot, mode: BusWitness['mode']): BusWitness => ({ ...ref, type, accessEpoch, mode });

async function readCorrection(tx: ReadTransaction, id: FactId) {
  return whenAvailable(async () => {
    const erasureBasis = new Set<FactId>();
    const storage = createCommandReadContext(tx, storagePurpose);
    const read = { ...storage, ...memoWorkbookFacts(async (id, options) => { const fact = await storage.fact(id, options); erasureBasis.add(id); return fact; }) };
    const source = await read.fact(id, { mode: 'following' });
    if (source.type !== workbookCorrectionType || source.ref.rev !== 1) return null;
    const correction = workbookCorrection(source.value);
    const grant = await createAuthorizedFactReader(tx, researchPurpose, explicitResearch).fact(correction.attempt.id, { mode: 'following' });
    if (grant.type !== workbookAttemptType || grant.ref.rev !== correction.attempt.rev || grant.accessEpoch !== correction.accessEpoch) return null;
    const { rows: [birth] } = await tx.query<{ tick: Tick }>(`
        SELECT r.tick::text FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
        JOIN fact_revs g ON (g.learner_id,g.fact_id,g.rev)=(r.learner_id,$4,$5)
        JOIN commands a ON (a.learner_id,a.id)=(g.learner_id,g.command_id)
        WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.author='learner' AND r.kind='value'
          AND c.type=$3 AND c.state='done' AND g.author='learner' AND g.kind='value' AND g.tick<r.tick
          AND a.type=$6 AND a.state='done' AND a.input#>'{input,allowed}'='true'::jsonb`,
    [tx.learner, id, recordWorkbookCorrection, grant.ref.id, grant.ref.rev, setWorkbookResearchUse]);
    if (!birth) return null;
    const submitted = await readActivitySubmissionBirth(tx, grant.ref, workbookAttemptType);
    if (!submitted?.unchanged || BigInt(submitted.tick) >= BigInt(birth.tick)) return null;
    const { attempt } = await openWorkbookCorrectionTarget(read, correction);
    for (const entry of attempt.basis ?? []) erasureBasis.add(entry.id);
    const release = attempt.paper.assessmentRelease?.releaseRef;
    const item = attempt.paper.questions.find(question => question.id === correction.itemId);
    if (release?.id !== correction.paperId || item?.kind !== 'bank') return null;
    const paper = await read.fact(release.id, { mode: 'pinned', rev: release.rev });
    if (paper.type !== workbookPaperType || !sameWorkbookJson(workbookPaper(paper.value), attempt.paper)) return null;
    const question = await read.fact(factId(item.sourceQuestionRef.id), { mode: 'pinned', rev: item.sourceQuestionRef.rev, requirePurpose: 'teaching' });
    const recorded: RecordedCorrection = { source: witness(source, 'following'), originalQuestion: witness(question, 'pinned'),
      researchAuthorization: witness(grant, 'following'), frozenPaper: witness(paper, 'pinned'),
      admittedAt: birth.tick, correctedAt: correction.correctedAt };
    // Reuse authorized snapshots only within this locked read. The worker opens a fresh set.
    const reopen: CorrectionReopen = async (ref, purpose) => purpose === researchPurpose ? grant
      : purpose === 'teaching' ? question : ref.id === id ? source : paper;
    return { recorded, reopen, erasureBasis: [...erasureBasis] };
  }).catch(error => {
    if (error instanceof WorkbookSourceMismatch) return null;
    throw error;
  });
}

export async function registerCorrectionRetest(tx: DbTransaction, tick: Tick, id: FactId, settingsRevision: number, settingsFactId: FactId) {
  const basis = await readCorrection(tx, id), now = Date.now();
  if (!basis) return null;
  const plan = await scheduleCorrectionRetest(basis.reopen, basis.recorded, settingsRevision, now);
  return plan && emitTodo(tx, tick, plan.todo, now, async () => false,
    { deriver: correctionRetestDeriver, erasureBasis: basis.erasureBasis, settingsFactId });
}

async function dueCorrection(tx: ReadTransaction, spec: TodoSpec, settingsRevision: number, now: number) {
  const basis = await readCorrection(tx, spec.sourceFactRev.id);
  return basis && await correctionRetestDue(basis.reopen, basis.recorded, spec, settingsRevision, now)
    ? { correction: basis.recorded, through: new Date(spec.expiresAtMs).toISOString() } : null;
}

const deferred = (reason: NotDispatched, now: number): TodoDeferral =>
  ({ status: 'not_dispatched', reason, retryAtMs: now + 60_000 });

async function unavailablePool(tx: ReadTransaction, { originalQuestion: { id, rev } }: RecordedCorrection): Promise<NotDispatched> {
  const edges = await workbookLinkCandidates(tx, knowledgeEdgeType, { id, rev }, await readLearnerClock(tx), ['variant_of'], 'unspoiled-variant');
  const read = teachingRead(tx);
  for (const edge of edges) if (await whenAvailable(() => read.fact(edge.id, { mode: 'following' }))) return 'coverage_unknown';
  return 'no_unexposed_variant';
}

export async function eligibleCorrectionRetest(tx: ReadTransaction, spec: TodoSpec, settingsRevision: number, now: number,
  authority?: CorrectionRetestAuthority) {
  const input = await dueCorrection(tx, spec, settingsRevision, now);
  if (!input) return false;
  const outcome = authority ? await authority.probe(tx, input) : await unavailablePool(tx, input.correction);
  return outcome === 'ready' ? true : deferred(outcome, now);
}

export async function executeCorrectionRetest(db: Db, ref: WorkRef, todoId: FactId,
  settingsCurrent: (tx: ReadTransaction, revision: number) => Promise<boolean>, authority?: CorrectionRetestAuthority) {
  const host = studioHost(db);
  return host.lockedTx(async tx => {
    if ((await readReadyWork(tx, ref))?.deriver !== correctionRetestDeriver) return;
    const todo = await readTodo(tx, todoId);
    if (todo?.state !== 'dispatched') return;
    const now = Date.now();
    const { spec } = todo;
    const input = await settingsCurrent(tx, spec.settingsRevision) && await dueCorrection(tx, spec, spec.settingsRevision, now);
    if (!input) {
      await cancelWork(host.boundDb(tx), ref);
      return;
    }
    const result = await authority?.issue(tx, input) ?? 'coverage_unknown';
    if (typeof result === 'string') {
      await tx.withLearnerWrite(() => deferDispatchedTodo(tx, ref, todo, deferred(result, now), now));
    } else if ((await createCommandReadContext(tx, storagePurpose).fact(result.issuanceId, { mode: 'following' })).type !== posttestIssuanceType ||
        Date.now() >= spec.expiresAtMs ||
        !await tx.withLearnerWrite(tick => completeTodo(tx, tick, ref, todo, result.issuanceId))) {
      throw new Error('订正后测发放已失效。');
    }
  });
}
