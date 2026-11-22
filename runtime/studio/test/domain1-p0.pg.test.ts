import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId, type Revision, type Tick } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { readConceptAttemptEvidence } from '../../../modules/activity/concept-evidence.ts';
import { throughTick, workbookItemHistory } from '../../../modules/activity/evidence-read.ts';
import { mapGraphConceptMastery } from '../../../modules/activity/graph-mastery-evidence.ts';
import { createKnowledgeEdgeCommand, type KnowledgeEdgeKind } from '../../../modules/content/knowledge-edge.ts';
import { createPythonDeriverHost } from '../../../executors/python-deriver/host.ts';
import { openKnowledgeEdge, readKnowledgeGraph } from '../knowledge-graph.ts';
import { readItemConceptLinks } from '../retention-workbook.ts';
import { resolveSource } from '../source-read.ts';
import { openTransparency } from '../transparency.ts';
import { stableId, studioLearner } from '../identity.ts';
import { loadStudioTestModule } from './modules.ts';
import { factWriter } from '../../../modules/learner/test/facts.ts';
import { retentionPaperType, retentionTeachingPurpose } from '../../../modules/activity/retention-posttest.ts';
import { workbookPaperType } from '../../../modules/activity/workbook-values.ts';

const fact = (key: string) => factId(stableId('d1p0', key));
const rev1 = 1 as Revision;

it.skipIf(!testDatabaseUrl)('connects asset concepts, spaced posttests, and live graph mastery in PostgreSQL', () =>
  withLearnerDatabase(studioLearner, async db => {
    const [activity, content] = await Promise.all([loadStudioTestModule('activity'), loadStudioTestModule('content')]);
    const handle = createCommandHandler(db, { modules: [activity!, content!], hooks: { async onFactsChanged() {} } });
    const send = (type: string, key: string, input: Json, purpose = 'teaching') => handle({
      learner: studioLearner, actor: 'learner', purpose, id: commandId(stableId('d1p0-cmd', key)), type, input,
    });
    const note = fact('note');
    await send('activity.organizerCreateNote', 'note', { id: note, title: 'P0 笔记', markdown: '概念依据', materialId: null }, 'storage');
    await send('activity.setWorkspaceTeaching', 'note-open', { id: note, expectedRev: 1, enabled: true }, 'storage');
    const noteUse = { id: note, rev: 2, accessEpoch: '1' };
    const question = async (key: string, title: string, text: string, concept: FactId) => {
      const q = fact(key), edge = fact(key + '-knowledge');
      await send('content.saveQuestion', key, { id: q, purpose: 'teaching', asset: { kind: 'question', title, promptBlockId: 'p',
        blocks: [{ id: 'p', parentId: null, body: { kind: 'text', text } }] } });
      await send('content.createKnowledgeEdge', key + '-edge', { id: edge, purpose: 'teaching', edge: {
        kind: 'targets_concept', scope: 'd1', from: { kind: 'question', sourceUse: { id: q, rev: 1, accessEpoch: '0' } },
        to: { kind: 'concept', sourceUse: { id: concept, rev: 1, accessEpoch: '0' } },
        sourceUses: [{ id: q, rev: 1, accessEpoch: '0' }, { id: concept, rev: 1, accessEpoch: '0' }] } });
      return { q, edge};
    };
    const concept = async (key: string, name: string) => {
      const id = fact(key);
      await send('content.createKnowledgeEntity', key, { id, purpose: 'teaching', entity: {
        kind: 'concept', canonicalName: name, aliases: [], merged_into: null },
        resolution: { decision: 'no-match', reason: 'P0', candidates: [], sourceUses: [noteUse] } });
      return id;
    };
    const c1 = await concept('c1', '间隔'), c2 = await concept('c2', '竞争');
    const q1 = await question('q1', '间隔题', '3+4=?', c1), q2 = await question('q2', '竞争题', '5+6=?', c2);
    const write = factWriter(db, { learner: studioLearner, purpose: 'teaching' });
    const paper = async (key: string, source: FactId, text: string, at: string, sealed: boolean, commandNumber: number) =>
      write([{ kind: 'create', id: fact(key), factType: sealed ? retentionPaperType : workbookPaperType,
        purpose: sealed ? ['storage', retentionTeachingPurpose] : ['storage', retentionTeachingPurpose],
        data: { title: key, materialId: null, savedAt: at, questions: [{ id: 'item', kind: 'exact', prompt: text,
          answers: [text === '3+4=?' ? '7' : '11'], sourceQuestionRef: { id: source, rev: rev1 } }] } }], commandNumber);
    const attempt = (key: string, target: FactId, answer: string, at: string, closed = false) => send('activity.submitWorkbookAttempt', key + '-sub', {
      id: fact('att-' + key), ...(closed ? { condition: 'studio-closed-workbook-v1' } : {}),
      data: { paperId: target, requestId: fact('req-' + key), submittedAt: at, answers: { item: answer } } },
      'teaching');
    const issue = (key: string, source: FactId, at: string, through: string) => send('activity.issueRetentionPosttest', key + '-issue', {
      id: fact(key), data: { condition: 'studio-closed-workbook-v1', gradingVersion: 'workbook-v1',
        forecastKey: stableId('d1p0-key', key), forecastId: stableId('d1p0-fc', key), effectiveTick: '1',
        paper: { id: source, rev: rev1 }, paperEpoch: '0', itemId: 'item', startedAt: at, through } });

    await paper('old1', q1.q, '3+4=?', '2026-11-19T08:00:00.000Z', false, 101);
    await attempt('old1', fact('old1'), '7', '2026-11-19T08:01:00.000Z');
    await paper('sealed1', q1.q, '3+4=?', '2026-11-20T08:00:00.000Z', true, 102);
    await issue('issue1', fact('sealed1'), '2026-11-20T08:01:00.000Z', '2026-11-23T08:01:00.000Z');
    await attempt('post1', fact('issue1'), '7', '2026-11-20T09:00:00.000Z', true);
    await paper('old2', q2.q, '5+6=?', '2026-11-19T08:00:00.000Z', false, 103);
    await attempt('old2', fact('old2'), '11', '2026-11-19T08:01:00.000Z');
    await paper('sealed2', q2.q, '5+6=?', '2026-11-20T10:00:00.000Z', true, 104);
    await issue('issue2', fact('sealed2'), '2026-11-20T10:01:00.000Z', '2026-11-23T10:01:00.000Z');
    await paper('rival2', q2.q, '5+6=?', '2026-11-20T10:02:00.000Z', false, 105);
    await attempt('rival2', fact('rival2'), '11', '2026-11-20T10:03:00.000Z');
    await attempt('post2', fact('issue2'), '11', '2026-11-20T11:00:00.000Z', true);

    const access = { recipient: 'workspace' as const, purpose: 'teaching', maySend: (value: {ref:{learner:string}}) => value.ref.learner === studioLearner };
    await db.snapshot({ learner: studioLearner }, async tx => {
      const cutoff = throughTick((await tx.query<{tick:string}>(
        'SELECT max(changed_tick)::text AS tick FROM facts WHERE learner_id=$1', [studioLearner])).rows[0]!.tick as Tick);
      await expect(resolveSource(tx, c1, access)).resolves.toMatchObject({ id: c1, kind: 'concept', title: '间隔', content: '间隔' });
      await expect(openKnowledgeEdge(tx, q1.edge, access)).resolves.toMatchObject({ value: { id: q1.edge }, from: { kind: 'question' }, to: { kind: 'concept' } });
      await expect(readKnowledgeGraph(tx, { conceptId: c1, hops: 1, direction: 'both',
        edgeKinds: ['targets_concept' as KnowledgeEdgeKind] }, access,
        source => source.kind === 'question' ? { id: source.id } : undefined)).resolves.toMatchObject({ results: [{ id: q1.q }] });
      await expect(readItemConceptLinks(tx, { id: q1.q, rev: rev1 }, cutoff,
        id => openKnowledgeEdge(tx, id, access))).resolves.toMatchObject([{ conceptId: c1 }]);
      const read = createCommandReadContext(tx, 'teaching'), links = [{ questionId: q1.q, questionRev: rev1, conceptId: c1,
        edgeRef: { id: q1.edge, rev: rev1, type: createKnowledgeEdgeCommand } }, { questionId: q2.q, questionRev: rev1, conceptId: c2,
        edgeRef: { id: q2.edge, rev: rev1, type: createKnowledgeEdgeCommand } }];
      const evidence = await readConceptAttemptEvidence(tx, read, links, () => false);
      expect(evidence.attempts.filter(row => row.conceptId === c1)).toMatchObject([{ exposure: 'independent', outcome: 'correct' }]);
      expect(evidence.attempts.filter(row => row.conceptId === c2).map(({ exposure }) => exposure)).toEqual(['unknown']);
      const issued = (await tx.query<{tick:string}>('SELECT r.tick::text FROM fact_revs r WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1',
        [studioLearner, fact('issue1')])).rows[0]!.tick as Tick;
      await expect(workbookItemHistory(tx, { paper: { id: fact('sealed1'), rev: rev1 }, itemId: 'item' },
        (await tx.query<{tick:string}>('SELECT r.tick::text FROM fact_revs r WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1',
          [studioLearner, fact('att-post1')])).rows[0]!.tick as Tick, fact('issue1'), issued)).resolves.toMatchObject({ cross_help: false });
    });

    const python = createPythonDeriverHost();
    try {
      const graph = await openTransparency(db, { python, backtrace: () => async () => null }).knowledgeGraph();
      const nodes = new Map((graph.nodes as readonly { id: FactId; mastery: { status: string; retrievability: number | null; basisRefs: readonly unknown[] } }[])
        .map(node => [node.id, node]));
      expect(nodes.get(c1)?.mastery).toMatchObject({ status: 'fading', retrievability: expect.any(Number), basisRefs: [expect.any(Object)] });
      expect(nodes.get(c1)!.mastery.retrievability).toBeGreaterThan(0);
      expect(nodes.get(c2)?.mastery).toMatchObject({ status: 'unknown', retrievability: null, independentCount: 0 });
      const active = mapGraphConceptMastery({ asOf: graph.asOf, concepts: [{ conceptId: c1 as string, status: 'solid',
        retrievability: 0.9, independentAttempts: 1, lastEvidenceAt: null, recentEvidenceRefs: [] }] }, [], new Set([c1 as string]));
      expect(active.get(c1)).toMatchObject({ status: 'fragile', retrievability: 0.9 });
      await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(tick =>
        tx.query('UPDATE facts SET access_epoch=access_epoch+1, changed_tick=$2 WHERE learner_id=$1 AND id=$3', [studioLearner, tick, c1])));
      const revoked = await openTransparency(db, { python, backtrace: () => async () => null }).knowledgeGraph();
      expect((revoked.nodes as readonly { id: FactId; mastery: { status: string; retrievability: null } }[]).find(node => node.id === c1)?.mastery)
        .toMatchObject({ status: 'unknown', retrievability: null });
    } finally { await python.close(); }
  }));
