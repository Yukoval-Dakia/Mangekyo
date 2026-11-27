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
  const targets = new Set<string>(ids);
  for (const fact of facts) {
    const data = fact.data && typeof fact.data === 'object' && !Array.isArray(fact.data)
      ? fact.data as Record<string, any> : {};
    if (typeof data.paperId === 'string') targets.add(data.paperId);
    if (typeof data.questionId === 'string') targets.add(data.questionId);
    if (typeof data.materialId === 'string') targets.add(data.materialId);
    if (typeof data.paper?.id === 'string') targets.add(data.paper.id);
    const list = fact.type === 'activity.workbookPaper' || fact.type === 'activity.retentionPaper'
      ? data.questions
      : fact.type === 'activity.workbookAttempt' || fact.type === 'activity.retentionPosttestSubmission'
        ? data.paper?.questions : undefined;
    if (Array.isArray(list)) {
      for (const question of list) {
        if (typeof question?.sourceQuestionRef?.id === 'string') targets.add(question.sourceQuestionRef.id);
      }
    }
  }
  const refList = [...targets];
  const custody = await tx.query(
    `SELECT 1 FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type='activity.practiceCustody' AND r.data->>'kind'='sealed' AND ${active()}
       AND (r.data#>>'{paper,id}'=ANY($2::text[]) OR r.data#>>'{question,id}'=ANY($2::text[])) LIMIT 1`,
    [tx.learner, refList]);
  if (custody.rows.length) return true;
  const openWorkbook = await tx.query(
    `SELECT 1 FROM facts p JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(p.learner_id,p.id,p.current_rev)
     WHERE p.learner_id=$1 AND p.type='activity.workbookPaper' AND ${active('p')}
       AND (p.id=ANY($2::text[]) OR r.data->>'materialId'=ANY($2::text[]) OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(r.data->'questions','[]'::jsonb)) q
         WHERE q#>>'{sourceQuestionRef,id}'=ANY($2::text[])))
       AND NOT EXISTS (SELECT 1 FROM facts a JOIN fact_revs ar
           ON (ar.learner_id,ar.fact_id,ar.rev)=(a.learner_id,a.id,a.current_rev)
         WHERE a.learner_id=p.learner_id AND a.type='activity.workbookAttempt'
           AND ar.data->>'paperId'=p.id AND ${active('a', 'ar')}) LIMIT 1`,
    [tx.learner, refList]);
  if (openWorkbook.rows.length) return true;
  const openPosttest = await tx.query(
    `SELECT 1 FROM facts pt JOIN fact_revs ptr ON (ptr.learner_id,ptr.fact_id,ptr.rev)=(pt.learner_id,pt.id,pt.current_rev)
       LEFT JOIN facts rp ON rp.learner_id=pt.learner_id AND rp.id=ptr.data#>>'{paper,id}'
         AND rp.type IN ('activity.retentionPaper','activity.workbookPaper') AND rp.retracted_rev IS NULL
         AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=rp.learner_id AND t.kind='fact' AND t.id=rp.id)
       LEFT JOIN fact_revs rpr ON (rpr.learner_id,rpr.fact_id,rpr.rev)=(rp.learner_id,rp.id,rp.current_rev)
         AND rpr.kind='value'
     WHERE pt.learner_id=$1 AND pt.type='activity.retentionPosttest' AND ${active('pt', 'ptr')}
       AND (pt.id=ANY($2::text[]) OR ptr.data#>>'{paper,id}'=ANY($2::text[]) OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(rpr.data->'questions','[]'::jsonb)) q
         WHERE q#>>'{sourceQuestionRef,id}'=ANY($2::text[])))
       AND NOT EXISTS (SELECT 1 FROM facts s JOIN fact_revs sr
           ON (sr.learner_id,sr.fact_id,sr.rev)=(s.learner_id,s.id,s.current_rev)
         WHERE s.learner_id=pt.learner_id AND s.type='activity.retentionPosttestSubmission'
           AND sr.data->>'paperId' IN (pt.id, ptr.data#>>'{paper,id}') AND ${active('s', 'sr')}) LIMIT 1`,
    [tx.learner, refList]);
  if (openPosttest.rows.length) return true;
  const openRetentionPaper = await tx.query(
    `SELECT 1 FROM facts rp JOIN fact_revs rpr ON (rpr.learner_id,rpr.fact_id,rpr.rev)=(rp.learner_id,rp.id,rp.current_rev)
     WHERE rp.learner_id=$1 AND rp.type='activity.retentionPaper' AND ${active('rp', 'rpr')}
       AND (rp.id=ANY($2::text[]) OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(rpr.data->'questions','[]'::jsonb)) q
         WHERE q#>>'{sourceQuestionRef,id}'=ANY($2::text[])))
       AND NOT EXISTS (SELECT 1 FROM facts s JOIN fact_revs sr
           ON (sr.learner_id,sr.fact_id,sr.rev)=(s.learner_id,s.id,s.current_rev)
         WHERE s.learner_id=rp.learner_id AND s.type='activity.retentionPosttestSubmission'
           AND ${active('s', 'sr')}
           AND (sr.data->>'paperId'=rp.id OR EXISTS (
             SELECT 1 FROM facts pt JOIN fact_revs ptr
               ON (ptr.learner_id,ptr.fact_id,ptr.rev)=(pt.learner_id,pt.id,pt.current_rev)
             WHERE pt.learner_id=rp.learner_id AND pt.type='activity.retentionPosttest'
               AND ptr.data#>>'{paper,id}'=rp.id AND pt.id=sr.data->>'paperId' AND ${active('pt', 'ptr')}))) LIMIT 1`,
    [tx.learner, refList]);
  return openRetentionPaper.rows.length > 0;
}

async function activeRefusal(tx: ReadTransaction, jit: boolean, now: number): Promise<boolean> {
  if (jit) return true;
  const { rows } = await tx.query<{
    valid_until: string | null;
    reopen_kind: string | null;
    reopen_at: string | null;
  }>(
    `SELECT r.data->>'valid_until' AS valid_until,
            r.data#>>'{refusal,reopen_condition,kind}' AS reopen_kind,
            r.data#>>'{refusal,reopen_condition,at}' AS reopen_at
       FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type='companion.claim' AND ${active()}
       AND r.data->>'category'='refusal' AND r.data->>'authority'='directive' AND r.data->>'action'<>'forget'
       AND NOT EXISTS (SELECT 1 FROM facts sf JOIN fact_revs sr
           ON (sr.learner_id,sr.fact_id,sr.rev)=(sf.learner_id,sf.id,sf.current_rev)
         WHERE sf.learner_id=f.learner_id AND sf.type='companion.claim' AND sf.id<>f.id
           AND ${active('sf', 'sr')} AND sr.data#>>'{supersedes,id}'=f.id)`,
    [tx.learner]);
  return rows.some(row => {
    if (row.valid_until !== null) {
      const until = Date.parse(row.valid_until);
      if (!Number.isFinite(until) || until <= now) return false;
    }
    if (row.reopen_kind === 'at') {
      const reopen = row.reopen_at === null ? NaN : Date.parse(row.reopen_at);
      return Number.isFinite(reopen) && reopen > now;
    }
    return true;
  });
}

async function reentry(
  tx: ReadTransaction, slotKey: string, historyLength: number, now: number,
): Promise<boolean> {
  if (historyLength > 0) return false;
  const { rows } = await tx.query<{ submitted_at: string; created_tick: string }>(
    `SELECT r.data->>'submittedAt' AS submitted_at, f.created_tick::text AS created_tick FROM facts f
       JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id<>$2
       AND f.type IN ('activity.workbookAttempt','activity.studyRecord','activity.retentionPosttestSubmission')
       AND ${active()} AND r.data->>'submittedAt' IS NOT NULL
     ORDER BY f.created_tick DESC, f.id DESC LIMIT 8`,
    [tx.learner, slotKey]);
  let latest = -Infinity;
  let latestTick = 0n;
  for (const row of rows) {
    const parsed = Date.parse(row.submitted_at);
    if (Number.isFinite(parsed) && parsed > latest) {
      latest = parsed;
      latestTick = BigInt(row.created_tick);
    }
  }
  if (!Number.isFinite(latest) || now - latest < 7 * 24 * 60 * 60 * 1000) return false;
  const { rows: laterTurns } = await tx.query(
    `SELECT 1 FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id<>$2 AND f.type='activity.studyTurn'
       AND f.created_tick>$3::bigint AND ${active()} LIMIT 1`,
    [tx.learner, slotKey, latestTick.toString()]);
  return laterTurns.length === 0;
}

async function emptyHistory(tx: ReadTransaction, slotKey: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id<>$2
       AND f.type IN ('activity.studyTurn','activity.workbookAttempt','activity.retentionPosttestSubmission')
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
    if (classroom.sessionId !== sessionId || classroom.status !== 'active' || !classroom.studyMethodPlan) {
      return undefined;
    }
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
  const returned = carePaused ? false : await reentry(tx, input.slotKey, input.historyLength, now);
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
