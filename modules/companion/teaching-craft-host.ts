import {
  createCommandReadContext, factId, isFactUnavailable, type ReadTransaction, type StudyMethodTemplateWire,
} from '@mangekyo/kernel';
import classroomDeclaration from '@mangekyo/module-activity/facts/classroom';
import type { StudyMethodPlanInstance } from '@mangekyo/module-content/facts/study-method-template';
import { readCarePause } from './care-pause.ts';

type CarePausePort = {
  readonly paused?: ((tx: ReadTransaction) => Promise<boolean>) | undefined;
};

type HostInput = {
  readonly slotKey: string;
  readonly sessionId: string;
  readonly classroom: boolean;
  readonly referenceIds: readonly string[];
  readonly carePause?: CarePausePort | undefined;
  readonly carePauseId: string;
  readonly classroomId: string;
  readonly historyLength: number;
  readonly hasCurrentObject: boolean;
  readonly hasContextMaterial: boolean;
  readonly hasJitRefusal: boolean;
  readonly hasJitEvidence: boolean;
};

export type TeachingCraftHostSignals = {
  readonly carePaused?: boolean | undefined;
  readonly hasActiveRefusal?: boolean | undefined;
  readonly sealedAssessment?: boolean | undefined;
  readonly coldStartEmpty?: boolean | undefined;
  readonly reentryTriggered?: boolean | undefined;
  readonly hasCurrentObject?: boolean | undefined;
  readonly historyTurnCount?: number | undefined;
  readonly studyMethodTemplate?: StudyMethodTemplateWire | undefined;
};

const active = (fact = 'f', revision = 'r') => `${fact}.retracted_rev IS NULL AND ${revision}.kind='value'
  AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=${fact}.learner_id
    AND t.kind='fact' AND t.id=${fact}.id)`;

const unavailableNames = new Set(['FactNotFoundError', 'FactReadDeniedError', 'FactRevisionNotFoundError']);
const isUnavailable = (error: unknown): boolean =>
  isFactUnavailable(error) || (error instanceof Error &&
    (unavailableNames.has(error.name) || unavailableNames.has(error.constructor?.name ?? '')));

async function sealedAssessment(tx: ReadTransaction, ids: readonly string[]): Promise<boolean> {
  if (!ids.length) return false;
  const { rows: facts } = await tx.query<{ id: string; type: string; data: unknown }>(
    `SELECT f.id,f.type,r.data FROM facts f
       JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id=ANY($2::text[]) AND ${active()}`, [tx.learner, ids]);
  const papers = new Set<string>(ids);
  const questions = new Set<string>(ids);
  for (const fact of facts) {
    const data = fact.data && typeof fact.data === 'object' && !Array.isArray(fact.data)
      ? fact.data as Record<string, any> : {};
    if (typeof data.paperId === 'string') papers.add(data.paperId);
    if (typeof data.questionId === 'string') questions.add(data.questionId);
    const list = fact.type === 'activity.workbookPaper' ? data.questions
      : fact.type === 'activity.workbookAttempt' ? data.paper?.questions : undefined;
    if (Array.isArray(list)) {
      for (const question of list) {
        if (typeof question?.sourceQuestionRef?.id === 'string') questions.add(question.sourceQuestionRef.id);
      }
    }
  }
  const targets = [...new Set([...papers, ...questions])];
  const custody = await tx.query(
    `SELECT 1 FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type='activity.practiceCustody' AND r.data->>'kind'='sealed' AND ${active()}
       AND (r.data#>>'{paper,id}'=ANY($2::text[]) OR r.data#>>'{question,id}'=ANY($2::text[])) LIMIT 1`,
    [tx.learner, targets]);
  if (custody.rows.length) return true;
  const paperIds = [...papers];
  if (!paperIds.length) return false;
  const open = await tx.query(
    `SELECT 1 FROM facts p JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(p.learner_id,p.id,p.current_rev)
     WHERE p.learner_id=$1 AND p.type='activity.workbookPaper' AND p.id=ANY($2::text[]) AND ${active('p')}
       AND NOT EXISTS (SELECT 1 FROM facts a JOIN fact_revs ar
           ON (ar.learner_id,ar.fact_id,ar.rev)=(a.learner_id,a.id,a.current_rev)
         WHERE a.learner_id=p.learner_id AND a.type='activity.workbookAttempt'
           AND ar.data->>'paperId'=p.id AND ${active('a', 'ar')}) LIMIT 1`,
    [tx.learner, paperIds]);
  return open.rows.length > 0;
}

async function activeRefusal(tx: ReadTransaction, jit: boolean, now: number): Promise<boolean> {
  if (jit) return true;
  const { rows } = await tx.query<{ valid_until: string | null }>(
    `SELECT r.data->>'valid_until' AS valid_until FROM facts f
       JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type='companion.claim' AND ${active()}
       AND r.data->>'category'='refusal' AND r.data->>'authority'='directive' AND r.data->>'action'<>'forget'
       AND NOT EXISTS (SELECT 1 FROM facts sf JOIN fact_revs sr
           ON (sr.learner_id,sr.fact_id,sr.rev)=(sf.learner_id,sf.id,sf.current_rev)
         WHERE sf.learner_id=f.learner_id AND sf.type='companion.claim' AND sf.id<>f.id
           AND ${active('sf', 'sr')} AND sr.data#>>'{supersedes,id}'=f.id)
     ORDER BY f.changed_tick DESC LIMIT 32`,
    [tx.learner]);
  return rows.some(row => {
    if (row.valid_until === null) return true;
    const until = Date.parse(row.valid_until);
    return Number.isFinite(until) && until > now;
  });
}

async function reentry(tx: ReadTransaction, slotKey: string, now: number): Promise<boolean> {
  const { rows } = await tx.query<{ submitted_at: string }>(
    `SELECT r.data->>'submittedAt' AS submitted_at FROM facts f
       JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id<>$2 AND f.type IN ('activity.workbookAttempt','activity.studyRecord')
       AND ${active()} AND r.data->>'submittedAt' IS NOT NULL
     ORDER BY f.created_tick DESC, f.id DESC LIMIT 8`,
    [tx.learner, slotKey]);
  let latest = -Infinity;
  for (const row of rows) {
    const parsed = Date.parse(row.submitted_at);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return Number.isFinite(latest) && now - latest >= 7 * 24 * 60 * 60 * 1000;
}

async function emptyHistory(tx: ReadTransaction, slotKey: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id<>$2 AND f.type IN ('activity.studyTurn','activity.workbookAttempt')
       AND ${active()} LIMIT 1`,
    [tx.learner, slotKey]);
  return rows.length === 0;
}

function toTemplateWire(plan: StudyMethodPlanInstance): StudyMethodTemplateWire {
  return {
    templateId: plan.templateId, version: plan.templateVersion, name: plan.templateName, goal: plan.goal,
    disciplineTags: [],
    steps: plan.steps.map(step => ({
      stepId: step.stepId, kind: step.kind, title: step.title, promptHint: step.promptHint,
      observationRequired: step.observationRequired, blocksSpoiler: step.blocksSpoiler,
      ...(step.maxMinutes === undefined ? {} : { maxMinutes: step.maxMinutes }),
    })),
    observationRequirements: plan.observationRequirements, author: 'co_created',
  };
}

async function classroomTemplate(
  tx: ReadTransaction, classroomId: string, sessionId: string,
): Promise<StudyMethodTemplateWire | undefined> {
  const read = createCommandReadContext(tx, 'teaching');
  try {
    const fact = await read.fact(factId(classroomId), { mode: 'following' });
    if (fact.type !== classroomDeclaration.type) return undefined;
    const classroom = classroomDeclaration.schema.parse(fact.value);
    if (classroom.sessionId !== sessionId || !classroom.studyMethodPlan) return undefined;
    return toTemplateWire(classroom.studyMethodPlan);
  } catch (error) {
    if (isUnavailable(error)) return undefined;
    throw error;
  }
}

export async function loadTeachingCraft(
  tx: ReadTransaction, input: HostInput,
): Promise<TeachingCraftHostSignals> {
  const now = Date.now();
  const carePaused = input.carePause?.paused
    ? await input.carePause.paused(tx)
    : (await readCarePause(createCommandReadContext(tx, 'storage'), factId(input.carePauseId))).active;
  const sealed = await sealedAssessment(tx, input.referenceIds);
  const refusal = await activeRefusal(tx, input.hasJitRefusal, now);
  const returned = carePaused ? false : await reentry(tx, input.slotKey, now);
  const noHistory = await emptyHistory(tx, input.slotKey);
  const studyMethodTemplate = input.classroom
    ? await classroomTemplate(tx, input.classroomId, input.sessionId) : undefined;
  const coldStart = input.historyLength === 0 && !input.hasCurrentObject && !input.hasContextMaterial &&
    !input.hasJitEvidence && noHistory;
  return {
    ...(carePaused ? { carePaused: true } : {}),
    ...(sealed ? { sealedAssessment: true } : {}),
    ...(refusal ? { hasActiveRefusal: true } : {}),
    ...(returned ? { reentryTriggered: true } : {}),
    coldStartEmpty: coldStart,
    hasCurrentObject: input.hasCurrentObject,
    historyTurnCount: input.historyLength,
    ...(studyMethodTemplate ? { studyMethodTemplate } : {}),
  };
}
