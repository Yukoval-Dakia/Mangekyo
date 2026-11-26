import { factId, isFactUnavailable, type Db, type FactId } from '../../kernel/src/index.ts';
import { recordWorkbookPresentationCommand, workbookPresentation, workbookPresentationType } from '../../modules/activity/workbook-presentation.ts';
import { workbookAttempt, workbookAttemptType, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { mapDisplayedQuestionNumbers, ulidCursorPattern } from '../../modules/learner/diagnosis-slice.ts';
import { RequestError } from './sessions.ts';
import { studioHost } from './identity.ts';
const pageSize = 20, unavailable = () => new RequestError(404, '找不到这次作答的展示记录。');
const DISPLAY_SQL = `SELECT f.id FROM facts f
 JOIN fact_revs born ON (born.learner_id,born.fact_id,born.rev)=(f.learner_id,f.id,1)
 JOIN fact_revs current ON (current.learner_id,current.fact_id,current.rev)=(f.learner_id,f.id,f.current_rev)
 JOIN commands c ON (c.learner_id,c.id)=(born.learner_id,born.command_id)
 WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND f.purpose && ARRAY['storage','all'] AND current.purpose && ARRAY['storage','all']
   AND current.kind='value' AND born.data=current.data AND born.author='learner' AND c.type=$3 AND c.state='done'
   AND current.data->>'kind'='solution' AND current.data->>'phase'='displayed'
   AND current.data#>>'{paper,id}'=$4 AND current.data#>>'{submission,id}'=$5 AND ($6::text IS NULL OR f.id>$6)
   AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
 ORDER BY f.id LIMIT $7`;
export function readWorkbookDisplayAccess(db: Db, paper: string, attempt: string, after: string | null) {
  if (after !== null && !ulidCursorPattern.test(after)) throw new RequestError(400, '展示记录翻页位置无效。');
  const host = studioHost(db);
  return host.snapshot(async tx => {
    const read = host.read(tx, 'storage'), following = { mode: 'following' } as const;
    try {
      const source = await read.fact(factId(paper), following), submitted = await read.fact(factId(attempt), following);
      if (source.type !== workbookPaperType || submitted.type !== workbookAttemptType) throw unavailable();
      const work = workbookAttempt(submitted.value);
      if (work.paperId !== paper) throw unavailable();
      const { rows } = await tx.query<{ id: FactId }>(DISPLAY_SQL, [tx.learner, workbookPresentationType, recordWorkbookPresentationCommand, paper, attempt, after, pageSize + 1]);
      const items = [];
      for (const { id } of rows.slice(0, pageSize)) {
        const fact = await read.fact(id, following), display = workbookPresentation(fact.value);
        items.push({ id, rev: fact.ref.rev, teaching: fact.purpose.includes('teaching') || fact.purpose.includes('all'), paperRev: display.paper.rev, numbers: mapDisplayedQuestionNumbers(work.paper.questions, display.items) });
      }
      return { items, next: rows.length > pageSize ? items.at(-1)!.id : null };
    } catch (error) { if (isFactUnavailable(error)) throw unavailable(); throw error; }
  });
}
