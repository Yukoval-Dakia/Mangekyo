import { expect, it } from 'vitest';
import { factId, type Revision, type Tick } from '../../../kernel/src/declarations/ids.ts';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../../kernel/src/db/types.ts';
import { readActivitySubmissionBirth } from '../../../modules/activity/evidence-read.ts';
import { projectHelpExposure, type AdmittedHelpEvent } from '../../../modules/activity/help-exposure.ts';
import { helpExposure, helpExposureType, type HelpTarget } from '../../../modules/activity/help-exposure-values.ts';
import { storagePurpose } from '../../../modules/activity/library-values.ts';
import { stableId, studioLearner } from '../identity.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { loadStudioTestModule } from './modules.ts';
import { openWorkbook } from '../workbook.ts';
import { openTakeaway } from '../takeaway.ts';

const learner = studioLearner;
const fact = (value: string) => factId(value);

it.skipIf(!testDatabaseUrl)('records own-words takeaways with delay-safe L0 exposure in PostgreSQL', () =>
  withLearnerDatabase(learner, async db => {
    const activity = await loadStudioTestModule('activity');
    const takeaways = openTakeaway(db, activity);
    const workbook = openWorkbook(db, activity, { onResearchFactsChanged: async () => {} });
    const read = (tx: ReadTransaction) => createCommandReadContext(tx, storagePurpose);

    const paper = await workbook.save({ requestId: 'cap22-paper', title: '错题卷', questions: [{
      id: 'q1', kind: 'exact', prompt: '两点确定一条什么？', answers: ['直线'],
    }, {
      id: 'q2', kind: 'exact', prompt: '平行四边形对角线怎样？', answers: ['互相平分'],
    }]});
    const submitted = await workbook.submit(paper.id, { requestId: 'cap22-attempt', answers: { q1: '线段', q2: '互相平分' } });
    const attempt = submitted.attempts[0]!;
    const attemptRev = 1 as Revision;

    // Only an incorrect/partial item admits a takeaway.
    await expect(takeaways.mutate(paper.id, attempt.id, 'save', {
      requestId: 'bad-item', attemptRev, itemId: 'q2', text: '先想定义',
    })).rejects.toMatchObject({ status: 400 });

    const saved = await takeaways.mutate(paper.id, attempt.id, 'save', {
      requestId: 'takeaway-1', attemptRev, itemId: 'q1', text: '先定两点',
    }) as { id: string; undo_token: string };
    expect(saved.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(saved.undo_token).toMatch(/^[0-9A-Z]{26}$/);

    // Same requestId replays idempotently.
    const replay = await takeaways.mutate(paper.id, attempt.id, 'save', {
      requestId: 'takeaway-1', attemptRev, itemId: 'q1', text: '先定两点',
    });
    expect(replay).toEqual(saved);

    const opened = await takeaways.mutate(paper.id, undefined, 'open', {
      paperRev: paper.revision!, itemId: 'q1',
      sourcePaperId: paper.id, sourceAttempt: { id: attempt.id, rev: attemptRev }, sourceItemId: 'q1',
    }) as { kind: string; text: string; displayRef: string };
    expect(opened).toMatchObject({ kind: 'own-words', text: '先定两点' });
    expect(opened.displayRef).toMatch(/^[\w-]{43}$/);

    // Displayed must verify displayRef + same opening.
    await expect(takeaways.mutate(paper.id, undefined, 'display', {
      paperRev: paper.revision!, itemId: 'q1',
      sourcePaperId: paper.id, sourceAttempt: { id: attempt.id, rev: attemptRev }, sourceItemId: 'q1',
      displayRef: '0'.repeat(43),
    })).rejects.toMatchObject({ status: 403 });

    const displayed = await takeaways.mutate(paper.id, undefined, 'display', {
      paperRev: paper.revision!, itemId: 'q1',
      sourcePaperId: paper.id, sourceAttempt: { id: attempt.id, rev: attemptRev }, sourceItemId: 'q1',
      displayRef: opened.displayRef,
    });
    expect(displayed).toMatchObject({ recorded: true });

    // Undone removes the fact and the item no longer opens.
    const undone = await takeaways.mutate(paper.id, undefined, 'undo', { undo_token: saved.undo_token });
    expect(undone).toMatchObject({ status: 'withdrawn' });
    await expect(takeaways.mutate(paper.id, undefined, 'open', {
      paperRev: paper.revision!, itemId: 'q1',
      sourcePaperId: paper.id, sourceAttempt: { id: attempt.id, rev: attemptRev }, sourceItemId: 'q1',
    })).rejects.toMatchObject({ status: 404 });

    // Opened-only exposure must NOT count as hinted (delay-safe).
    await takeaways.mutate(paper.id, attempt.id, 'save', {
      requestId: 'takeaway-2', attemptRev, itemId: 'q1', text: '定两点2',
    });
    const openedOnly = await takeaways.mutate(paper.id, undefined, 'open', {
      paperRev: paper.revision!, itemId: 'q1',
      sourcePaperId: paper.id, sourceAttempt: { id: attempt.id, rev: attemptRev }, sourceItemId: 'q1',
    }) as { displayRef: string };
    const events = await db.snapshot({ learner }, async tx => {
      const submission = await read(tx).fact(fact(attempt.id), { mode: 'following' });
      const birth = await readActivitySubmissionBirth({ learner, query: tx.query }, submission.ref, 'activity.workbookAttempt');
      const { rows } = await tx.query<{ id: string; tick: string }>(`
        SELECT f.id, r.tick::text FROM fact_revs r JOIN facts f ON (r.learner_id,r.fact_id)=(f.learner_id,f.id)
        JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
        WHERE f.type=$1 AND r.data->'mount'->>'activityId'=$2 AND r.data->>'kind' IN ('opened','displayed')`,
        [helpExposureType, paper.id]);
      const mount: HelpTarget = { activityId: fact(paper.id), issuance: { id: fact(paper.id), rev: paper.revision! as Revision }, item: { itemId: 'q1' } };
      const admitted: AdmittedHelpEvent[] = [];
      for (const row of rows) {
        const event = await read(tx).fact(fact(row.id), { mode: 'following' });
        admitted.push({ ref: event.ref, admittedAt: row.tick as Tick, value: helpExposure(event.value) });
      }
      return projectHelpExposure({ submission: { ref: submission.ref, target: mount, cutoff: birth!.tick }, events: admitted, coverage: null });
    });
    // Opened (not drawn) and displayed-after-submit must not become pre-submit help.
    expect(events.kind).not.toBe('exposed');

    // A 'storage'-purpose read never grants 'teaching'.
    const saved3 = await takeaways.mutate(paper.id, attempt.id, 'save', {
      requestId: 'takeaway-3', attemptRev, itemId: 'q1', text: '不可越权',
    }) as { id: string };
    await db.snapshot({ learner }, async tx => {
      const storage = await read(tx).fact(fact(saved3.id), { mode: 'following' });
      expect(storage.purpose).toEqual(['storage']);
      await expect(createCommandReadContext(tx as never, 'teaching').fact(fact(saved3.id), { mode: 'following' }))
        .rejects.toMatchObject({ reason: 'purpose' });
    });
  }));
