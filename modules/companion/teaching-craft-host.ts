import { factId, createCommandReadContext, type ReadTransaction } from '@mangekyo/kernel';
import classroomDeclaration from '@mangekyo/module-activity/facts/classroom';
import type { StudyMethodPlanInstance } from '@mangekyo/module-content/facts/study-method-template';
import type { StudyMethodTemplateWire } from '@mangekyo/kernel';
import { readCarePause } from './care-pause.ts';

type CarePausePort = {
  readonly paused?: ((tx: ReadTransaction) => Promise<boolean>) | undefined;
};
type HostInput = {
  readonly slotKey: string; readonly sessionId: string; readonly classroom: boolean;
  readonly referenceIds: readonly string[]; readonly carePause?: CarePausePort | undefined;
  readonly carePauseId: string; readonly classroomId: string;
  readonly historyLength: number; readonly hasCurrentObject: boolean;
  readonly hasContextMaterial: boolean; readonly hasJitRefusal: boolean;
};
export type TeachingCraftHostSignals = {
  readonly carePaused?: boolean | undefined; readonly hasActiveRefusal?: boolean | undefined;
  readonly sealedAssessment?: boolean | undefined; readonly coldStartEmpty?: boolean | undefined;
  readonly reentryTriggered?: boolean | undefined; readonly hasCurrentObject?: boolean | undefined;
  readonly historyTurnCount?: number | undefined; readonly studyMethodTemplate?: StudyMethodTemplateWire | undefined;
};

const active = (fact = 'f', revision = 'r') => `${fact}.retracted_rev IS NULL AND ${revision}.kind='value'
  AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=${fact}.learner_id
    AND t.kind='fact' AND t.id=${fact}.id)`;

async function sealedAssessment(tx: ReadTransaction, ids: readonly string[]) {
  if (!ids.length) return false;
  const { rows: facts } = await tx.query<{ id: string; type: string; data: unknown }>(
    `SELECT f.id,f.type,r.data FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id=ANY($2::text[]) AND ${active()}`, [tx.learner, ids]);
  const papers = new Set<string>(ids), questions = new Set<string>(ids);
  for (const fact of facts) {
    const data = fact.data && typeof fact.data === 'object' && !Array.isArray(fact.data)
      ? fact.data as Record<string, any> : {};
    for (const key of ['paperId', 'questionId']) if (typeof data[key] === 'string')
      (key === 'paperId' ? papers : questions).add(data[key]);
    if (fact.type === 'activity.workbookAttempt' && typeof data.paperId === 'string') papers.add(data.paperId);
    if (fact.type === 'activity.workbookPaper') for (const question of data.questions ?? []) {
      if (typeof question?.id === 'string') questions.add(question.id);
      if (typeof question?.sourceQuestionRef?.id === 'string') questions.add(question.sourceQuestionRef.id);
    }
    if (fact.type === 'activity.workbookAttempt') for (const question of data.paper?.questions ?? []) {
      if (typeof question?.id === 'string') questions.add(question.id);
      if (typeof question?.sourceQuestionRef?.id === 'string') questions.add(question.sourceQuestionRef.id);
    }
  }
  const targets = [...papers, ...questions];
  const custody = await tx.query(`SELECT 1 FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type='activity.practiceCustody' AND r.data->>'kind'='sealed' AND ${active()}
      AND (r.data#>>'{paper,id}'=ANY($2::text[]) OR r.data#>>'{question,id}'=ANY($2::text[])) LIMIT 1`, [tx.learner, targets]);
  if (custody.rows.length) return true;
  const paperIds = [...papers];
  if (!paperIds.length) return false;
  const open = await tx.query(`SELECT 1 FROM facts p JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(p.learner_id,p.id,p.current_rev)
    WHERE p.learner_id=$1 AND p.type='activity.workbookPaper' AND p.id=ANY($2::text[])
      AND ${active('p')}
      AND NOT EXISTS (SELECT 1 FROM facts a JOIN fact_revs ar ON (ar.learner_id,ar.fact_id,ar.rev)=(a.learner_id,a.id,a.current_rev)
        WHERE a.learner_id=p.learner_id AND a.type='activity.workbookAttempt' AND ar.data->>'paperId'=p.id
          AND ${active('a', 'ar')}) LIMIT 1`, [tx.learner, paperIds]);
  return open.rows.length > 0;
}

async function activeRefusal(tx: ReadTransaction, jit: boolean, nowIso: string) {
  if (jit) return true;
  const { rows } = await tx.query(`SELECT 1 FROM facts f JOIN fact_revs r
    ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type='companion.claim' AND ${active()}
      AND r.data->>'category'='refusal' AND r.data->>'authority'='directive' AND r.data->>'action' <> 'forget'
      AND (r.data->>'valid_until' IS NULL OR r.data->>'valid_until'>$2)
      AND NOT EXISTS (SELECT 1 FROM facts sf JOIN fact_revs sr ON (sr.learner_id,sr.fact_id,sr.rev)=(sf.learner_id,sf.id,sf.current_rev)
        WHERE sf.learner_id=f.learner_id AND sf.type='companion.claim' AND ${active('sf', 'sr')}
          AND sf.created_tick>f.created_tick AND sr.data#>>'{supersedes,id}'=f.id) LIMIT 1`, [tx.learner, nowIso]);
  return rows.length > 0;
}

async function reentry(tx: ReadTransaction, slotKey: string, now: number) {
  const { rows: [row] } = await tx.query<{ submitted_at: string }>(`SELECT r.data->>'submittedAt' submitted_at FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.id<>$2 AND f.type IN ('activity.workbookAttempt','activity.studyRecord') AND ${active()}
      AND r.data->>'submittedAt' IS NOT NULL ORDER BY (r.data->>'submittedAt')::timestamptz DESC,f.id DESC LIMIT 1`, [tx.learner, slotKey]);
  return Boolean(row && now - Date.parse(row.submitted_at) >= 7 * 24 * 60 * 60 * 1000);
}

async function emptyHistory(tx: ReadTransaction, slotKey: string) {
  const { rows } = await tx.query(`SELECT 1 FROM facts f JOIN fact_revs r
    ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.id<>$2 AND f.type IN ('activity.studyTurn','activity.workbookAttempt')
      AND ${active()} LIMIT 1`, [tx.learner, slotKey]);
  return rows.length === 0;
}

function template(plan: StudyMethodPlanInstance): StudyMethodTemplateWire {
  return { templateId: plan.templateId, version: plan.templateVersion, name: plan.templateName, goal: plan.goal,
    disciplineTags: [], steps: plan.steps.map(step => ({ stepId: step.stepId, kind: step.kind, title: step.title,
      promptHint: step.promptHint, observationRequired: step.observationRequired, blocksSpoiler: step.blocksSpoiler,
      ...(step.maxMinutes === undefined ? {} : { maxMinutes: step.maxMinutes }) })),
    observationRequirements: plan.observationRequirements, author: 'co_created' };
}

async function classroomTemplate(tx: ReadTransaction, classroomId: string) {
  const read = createCommandReadContext(tx, 'teaching');
  try {
    const fact = await read.fact(factId(classroomId), { mode: 'following' });
    if (fact.type !== classroomDeclaration.type) return undefined;
    const classroom = classroomDeclaration.schema.parse(fact.value);
    return classroom.studyMethodPlan ? template(classroom.studyMethodPlan) : undefined;
  } catch { return undefined; }
}

export async function loadTeachingCraft(tx: ReadTransaction, input: HostInput): Promise<TeachingCraftHostSignals> {
  const nowIso = new Date().toISOString(), now = Date.parse(nowIso);
  const carePaused = input.carePause?.paused
    ? await input.carePause.paused(tx)
    : (await readCarePause(createCommandReadContext(tx, 'storage'), factId(input.carePauseId))).active;
  const [sealed, refusal, returned, noHistory, studyMethodTemplate] = await Promise.all([
    sealedAssessment(tx, input.referenceIds), activeRefusal(tx, input.hasJitRefusal, nowIso),
    reentry(tx, input.slotKey, now), emptyHistory(tx, input.slotKey),
    input.classroom ? classroomTemplate(tx, input.classroomId) : Promise.resolve(undefined),
  ]);
  return { carePaused: carePaused || undefined, sealedAssessment: sealed || undefined,
    hasActiveRefusal: refusal || undefined, reentryTriggered: returned && !carePaused ? true : undefined,
    coldStartEmpty: input.historyLength === 0 && !input.hasCurrentObject && !input.hasContextMaterial &&
      !input.hasJitRefusal && noHistory ? true : undefined,
    hasCurrentObject: input.hasCurrentObject, historyTurnCount: input.historyLength, studyMethodTemplate };
}
