import { snapshotFactReaders } from './fact-read-helpers.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactId } from '../../kernel/src/declarations/ids.ts';
import type { BusWitness } from '../../kernel/src/pipeline-contracts.ts';
import type { PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { pythonAttemptsLimit } from '../../executors/teaching/agent-tools.ts';
import { bindPulseReader, isTextbookPulseUnavailable, projectTextbookPulse, reopenPulseWitnesses } from '../../modules/activity/textbook-pulse-evidence.ts';
import type { TextbookMasteryScope } from '../../modules/learner/textbook-mastery.ts';
import { projectTextbookMastery } from '../../modules/learner/textbook-mastery.ts';
import { checkStudioNotionFact, type CheckNotionRead } from './notion.ts';
import { readCurrentQuestionVerification } from './iqdb-verification.ts';
import { resolveSource } from './source-read.ts';
import { studioWorkbookEvidence } from './retention-workbook.ts';
import { assetType } from '../../modules/content/asset.ts';
import { workspaceEntryType } from '../../modules/content/knowledge-edge.ts';

type SnapshotReader = ReturnType<ReturnType<typeof snapshotFactReaders>>;
type PulseInput = Parameters<typeof projectTextbookPulse>[0];
type Backtrace = PulseInput['backtrace'];

export type TextbookPulseHost = {
  readonly python: Pick<PythonDeriverHost, 'derive'>;
  readonly backtrace: (tx: ReadTransaction, read: { fact: SnapshotReader['fact'] }, facts: ReturnType<typeof snapshotFactReaders>) => Backtrace;
};

const teaching = 'teaching';

export async function textbookMasteryPulse(tx: ReadTransaction, check: CheckNotionRead, page: {
  id: string; rev: number; accessEpoch: string; purpose: readonly string[];
  blocks: readonly { id: string }[]; archived?: boolean;
}, host: TextbookPulseHost) {
  const snapshot = snapshotFactReaders(tx);
  const reader = snapshot(teaching, fact => fact.ref.learner === tx.learner);
  const read = bindPulseReader(reader, async fact => {
    await checkStudioNotionFact(tx, fact, teaching, 'learner');
  }) as SnapshotReader;
  const access = {
    learner: tx.learner, purpose: teaching, recipient: tx.learner, read,
    isUnavailable: isTextbookPulseUnavailable,
    preloadFollowingEdges: (ids: readonly FactId[]) => read.preloadFollowing(ids),
  };
  const reopen = async (scope: TextbookMasteryScope, refs: readonly BusWitness[]) => {
    return reopenPulseWitnesses(refs, async ref => {
      const fact = await read.reopen(ref);
      if (fact.type !== ref.type || fact.ref.rev !== ref.rev || fact.accessEpoch !== ref.accessEpoch) return;
      await checkStudioNotionFact(tx, fact, teaching, 'learner', async source => {
        await check(source);
        return fact;
      });
      return ref;
    });
  };
  return projectTextbookPulse({
    tx, page, access: access as never, read: read as never,
    reopen: reopen as never,
    resolveLegacyQuestion: async pin => {
      const source = await resolveSource(tx, pin.id, {
        recipient: 'workspace', purpose: teaching, maySend: fact => fact.ref.learner === tx.learner,
      });
      return source?.kind === 'question' && source.sourceRef.fact.id === pin.id &&
        source.sourceRef.fact.rev === pin.rev;
    },
    slot: readCurrentQuestionVerification(tx),
    evidence: studioWorkbookEvidence(teaching, () => true, undefined, [workspaceEntryType, assetType]) as never,
    backtrace: host.backtrace(tx, { fact: read.fact }, snapshot),
    limit: pythonAttemptsLimit,
    derive: async (deriver, payload, refs) => {
      const result = await host.python.derive(deriver, payload);
      return result.kind === 'ok' && result.outcome.kind === 'value' &&
        (await reopen({} as never, refs)).length === refs.length ? result.outcome.value : null;
    },
    project: projectTextbookMastery as never,
  });
}
