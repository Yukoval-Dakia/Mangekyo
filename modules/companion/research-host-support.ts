import { factId, type FactSnapshot, type ReadTransaction, type Tick } from '@mangekyo/kernel';

type TodoInput = {sourceFactRev: {id: string; revision: number; accessEpoch: string; anchor?: string | undefined}; dedupKey: string; trigger: {kind: 'immediate'}; workerProfile: string; goal: string; refs: unknown[]; autonomyTier: number; budgetCap: number; settingsRevision: number; expiresAtMs: number};
type TodoSpec = {sourceFactRev: {id: string; revision: number; accessEpoch: string; anchor?: string | undefined}; dedupKey: string; workerProfile: any; goal: string; budgetCap: number; settingsRevision: number; trigger: {kind: string}; refs: unknown[]; parentTodoId?: string | undefined; expiresAtMs: number; autonomyTier: number};
import { activityEvidenceTypes, admittedActivityFragments, citeQuestion, hasLinkedAttempt, turnEvidenceType } from './activity-evidence.ts';
import { extractedUnderstanding, extractorProfile, extractionGoal, extractionKey, opensCitation, reviewUnderstanding, type ActivityCitation } from './understanding.ts';
import { claimType } from './claim.ts';
import { memoryAssertionType } from './memory-assertion.ts';
import { researchPurpose } from './research.ts';
import { textbookPageType } from '@mangekyo/module-content/facts/textbook-page';

export const windowMs = 86_400_000;

type CreateAuthorizedFactReader = (tx: ReadTransaction, purpose: string, maySend: WorkspaceSourceRecipient) => {
  fact(id: string, options: {mode: 'following'}): Promise<FactSnapshot>;
};

export const claimWitness = (fact: FactSnapshot) => ({id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch});
export type WorkspaceSourceRecipient = ((fact: FactSnapshot) => boolean) & {notionRecipientId?: string};
export type SourceTrack = (fact: FactSnapshot, mode?: 'pinned' | 'following') => void;
export type WorkspaceWitness = {id: string; rev: number; epoch: string; type: string; mode: 'pinned' | 'following'};
export type ResearchHostDeps = {
  readonly createAuthorizedFactReader: CreateAuthorizedFactReader;
  readonly digest: (value: string) => string;
  readonly studyTurn: (value: FactSnapshot['value']) => any;
  readonly turnAllowsBackgroundUnderstanding: (fact: FactSnapshot) => boolean;
  readonly workbookAttemptType: string;
  readonly posttestSubmissionType: string;
  readonly readActivitySubmissionBirth: (tx: ReadTransaction, ref: FactSnapshot['ref'], type: string) => Promise<unknown>;
  readonly readActiveTodos: (tx: ReadTransaction, profile: string, id?: string) => AsyncIterable<{spec: any, state: string}>;
  readonly mayResearch: WorkspaceSourceRecipient;
  readonly paidExtractionRecipient: WorkspaceSourceRecipient;
  readonly whenAvailable: <T>(read: () => Promise<T>) => Promise<T | null>;
  readonly resolveSource: (tx: ReadTransaction, id: string, access: any, mode?: 'following') => Promise<any>;
  readonly openWorkbookQuestionSources: (tx: ReadTransaction, fact: FactSnapshot, access: any, item: string) => Promise<any>;
  readonly undoTextbookCommand: string;
  readonly textSlice: (text: string, start: number, end: number) => {content: string};
  readonly researchReader: (tx: ReadTransaction) => {fact(id: string, options: {mode: 'following'}): Promise<FactSnapshot>};
  readonly independentScoutSource: (tx: ReadTransaction, fact: FactSnapshot) => Promise<boolean>;
  readonly currentResearchSettings: (tx: ReadTransaction) => Promise<any>;
  readonly workspaceGrantChecker: () => (turn: any) => Promise<boolean>;
  readonly notionModelRecipient: (providerId: string, baseUrl: string, protocol: string, model: string, workspaceRevision: string) => string;
  readonly teachingPurpose: string;
  readonly teachingSlotType: string;
  readonly companionTeachingMethods: string;
  readonly completedCompanionTurns: string;
};

export async function openUnderstandingActivity(deps: ResearchHostDeps, tx: ReadTransaction, id: string, purpose = researchPurpose,
  recipient?: WorkspaceSourceRecipient, item?: string) {
  const maySend = recipient ?? deps.mayResearch;
  const allows = Object.assign((fact: Parameters<WorkspaceSourceRecipient>[0]) => deps.mayResearch(fact) && maySend(fact),
    {notionRecipientId: maySend.notionRecipientId ?? ''});
  const reader = deps.createAuthorizedFactReader(tx, purpose, allows);
  const fact = await deps.whenAvailable(() => reader.fact(factId(id), {mode: 'following'}));
  if (!fact) return null;
  // A permission change keeps the body, and an undo restores the body from its recorded revision.
  const {rows: [provenance]} = await tx.query<{ author: string | null; born: Tick }>(`
    SELECT CASE WHEN origin.type=$4 THEN NULL ELSE last.author END AS author,f.created_tick::text AS born
    FROM facts f JOIN LATERAL (
      WITH RECURSIVE body AS (
        SELECT rev,data,author,command_id FROM fact_revs
        WHERE (learner_id,fact_id,rev)=(f.learner_id,f.id,f.current_rev)
        UNION ALL
        SELECT previous.rev,previous.data,previous.author,previous.command_id FROM body
        LEFT JOIN commands c ON (c.learner_id,c.id)=(f.learner_id,body.command_id)
        JOIN fact_revs previous ON (previous.learner_id,previous.fact_id)=(f.learner_id,f.id)
          AND previous.rev=CASE WHEN c.type=$4 THEN (c.input#>>'{input,priorRev}')::int ELSE body.rev-1 END
        WHERE f.type=$3 AND previous.rev<body.rev AND previous.kind='value' AND previous.data=body.data
      ) SELECT author,command_id FROM body ORDER BY rev LIMIT 1
    ) last ON true
    LEFT JOIN commands origin ON (origin.learner_id,origin.id)=(f.learner_id,last.command_id)
    WHERE f.learner_id=$1 AND f.id=$2`, [tx.learner, id, textbookPageType, deps.undoTextbookCommand]);
  if (provenance?.author !== 'learner') return null;
  const ref = claimWitness(fact);
  const basis: WorkspaceWitness[] = [{id: ref.id, rev: ref.rev, epoch: ref.accessEpoch, type: fact.type, mode:'following'}];
  const track = (source: typeof fact, mode: 'following' | 'pinned' = 'following') => {
    if (source.ref.id !== ref.id || source.ref.rev !== ref.rev)
      basis.push({id:source.ref.id, rev:source.ref.rev, epoch:source.accessEpoch, type:source.type, mode});
  };
  const access = {purpose, maySend:allows, track};
  if (fact.type === textbookPageType && !await deps.resolveSource(tx, id, {recipient:'workspace', ...access}, 'following')) return null;
  // Research defines the stable citation basis. Every subsequent caller also opens the chain for its own purpose.
  const explicit = Object.assign((dependency: typeof fact) => dependency.purpose.includes(researchPurpose) && maySend(dependency),
    {notionRecipientId: maySend.notionRecipientId ?? ''});
  const opened = item && recipient && fact.purpose.includes(researchPurpose) && fact.purpose.includes(purpose) && hasLinkedAttempt(fact)
    ? await deps.openWorkbookQuestionSources(tx, fact, {purpose: researchPurpose, maySend: explicit, track}, item!) : undefined;
  if (item && !opened) return null;
  const dependencies = basis.slice(1);
  if (opened && purpose !== researchPurpose) {
    basis.splice(1);
    if (!await deps.openWorkbookQuestionSources(tx, fact, {purpose, maySend, track}, item!)) return null;
  }
  if (dependencies.length) {
    // A pinned snapshot exposes its historical purposes. Research also requires a current grant.
    const ids = [...new Set(dependencies.map(witness => witness.id))];
    const {rowCount} = await tx.query(`
      SELECT id FROM facts WHERE learner_id=$1 AND id=ANY($2::text[])
        AND retracted_rev IS NULL AND CASE WHEN $4 THEN purpose @> ARRAY[$3,$5] ELSE purpose && ARRAY[$3,'all'] END`,
      [tx.learner, ids, researchPurpose, !!opened, purpose]);
    if (rowCount !== ids.length) return null;
  }
  const basisDigest = dependencies.length
    ? deps.digest(JSON.stringify(dependencies))
    : undefined;
  const activity = admittedActivityFragments(fact, item);
  if (!activity) return null;
  if ((fact.type === deps.workbookAttemptType || fact.type === deps.posttestSubmissionType) &&
      !await deps.readActivitySubmissionBirth(tx, fact.ref, fact.type)) return null;
  const fragments = activity.quoteOnly ? activity.fragments.map(fragment => ({
    ...fragment, text: deps.textSlice(fragment.text, 0, 1200).content,
  })) : activity.fragments;
  return {...activity, fact, ref, basis, basisDigest, fragments, paper: opened?.paper, ...provenance};
}

export async function openUnderstandingCitations(deps: ResearchHostDeps, tx: ReadTransaction, refs: readonly ActivityCitation[], purpose?: string,
  maySend?: WorkspaceSourceRecipient) {
  const recipient = maySend ?? (purpose === 'storage' ? () => true : undefined);
  const sources = await Promise.all(refs.map(ref => openUnderstandingActivity(deps, tx, ref.id, purpose, recipient, ref.question_evidence ? ref.anchor : undefined)));
  return sources.flatMap((source, index) => {
    const ref = refs[index]!;
    if (source && JSON.stringify(citeQuestion(source, ref.anchor, ref.question_evidence?.recipient ?? '')) !==
        JSON.stringify(ref.question_evidence)) return [];
    return source && source.basisDigest === ref.basis_digest && opensCitation(source, ref) ? [source] : [];
  });
}

export async function discoverUnderstandingTodos(deps: ResearchHostDeps, tx: ReadTransaction, reviewed: Tick, settingsRevision: number, now: number, recipient?: WorkspaceSourceRecipient, budgetCap = 0) {
  const {rows} = await tx.query<{ id: string; anchor: string | null }>(`
    SELECT f.id, item.anchor FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    CROSS JOIN LATERAL (SELECT NULL::text AS anchor UNION ALL
      SELECT q->>'id' FROM jsonb_array_elements(r.data#>'{paper,questions}') q WHERE f.type=$8 AND q ? 'sourceQuestionRef') item
    LEFT JOIN (${deps.completedCompanionTurns}) done ON f.type=$7 AND done.id=f.id
    WHERE f.learner_id=$1 AND f.type=ANY($4::text[]) AND f.retracted_rev IS NULL
      AND f.purpose && ARRAY[$5,'all'] AND (f.type<>$7 OR
        (done.id IS NOT NULL AND r.data->'allowBackgroundUnderstanding'='true'::jsonb AND $5=ANY(f.purpose)))
      AND (GREATEST(f.changed_tick,done.effective_tick)>$6::bigint OR item.anchor IS NOT NULL AND EXISTS (
        SELECT 1 FROM facts dep WHERE dep.learner_id=f.learner_id AND dep.changed_tick>$6::bigint
          AND (dep.id=r.data->>'paperId' OR jsonb_path_exists(r.data,
            '$.paper.questions[*].sourceQuestionRef.id ? (@ == $id)', jsonb_build_object('id',dep.id)))))
      AND NOT EXISTS (SELECT 1 FROM work t WHERE t.family='todo' AND t.learner_id=f.learner_id
        AND t.dedup_key='understanding:'||f.id||':'||CASE WHEN f.type=$7 THEN 1 ELSE f.current_rev END||COALESCE(':question:'||item.anchor,''))
    ORDER BY GREATEST(f.changed_tick,done.effective_tick),f.id,item.anchor`,
    [tx.learner, deps.teachingSlotType, deps.companionTeachingMethods, activityEvidenceTypes, researchPurpose, reviewed, turnEvidenceType, deps.workbookAttemptType]);
  const todos: TodoInput[] = [];
  for (const row of rows) {
    const source = await openUnderstandingActivity(deps, tx, row.id, researchPurpose, recipient, row.anchor ?? undefined);
    if (!source || budgetCap && !await paidSource(deps, tx, row.id)) continue;
    todos.push({dedupKey: extractionKey(source.ref.id, source.quoteOnly ? 1 : source.ref.rev, row.anchor ?? undefined), trigger: {kind: 'immediate'},
      workerProfile: extractorProfile, goal: extractionGoal, refs: [],
      sourceFactRev: {id: source.ref.id, revision: source.ref.rev, accessEpoch: source.ref.accessEpoch, ...(row.anchor ? {anchor: row.anchor} : {})},
      autonomyTier: 2, budgetCap, settingsRevision, expiresAtMs: now + windowMs});
    if (todos.length === 12) break;
  }
  return todos;
}

export async function paidSource(deps: ResearchHostDeps, tx: ReadTransaction, id: string) {
  const fact = await deps.whenAvailable(() => deps.researchReader(tx).fact(factId(id), {mode:'following'}));
  return fact && deps.paidExtractionRecipient(fact) && (fact.type !== deps.workbookAttemptType || await deps.independentScoutSource(tx, fact));
}

export async function eligibleExtraction(deps: ResearchHostDeps, tx: ReadTransaction, spec: TodoSpec, recipient?: WorkspaceSourceRecipient, budgetCap = 0,
  callerPurpose = researchPurpose) {
  const {id, revision, accessEpoch} = spec.sourceFactRev;
  const item = spec.sourceFactRev.anchor;
  if (spec.workerProfile !== extractorProfile || spec.goal !== extractionGoal || spec.budgetCap !== budgetCap || budgetCap && !await paidSource(deps, tx, id) ||
      spec.autonomyTier !== 2 || spec.expiresAtMs <= Date.now()) return null;
  const source = await openUnderstandingActivity(deps, tx, id, callerPurpose, recipient, item);
  if (!source || source.ref.rev !== revision || source.ref.accessEpoch !== accessEpoch || spec.dedupKey !== extractionKey(id, source.quoteOnly ? 1 : revision, item)) return null;
  if (source.kind === 'conversation' && (!source.quoteOnly ||
      !(await tx.query(`${deps.completedCompanionTurns} AND s.slot_key=$4`, [tx.learner, deps.teachingSlotType, deps.companionTeachingMethods, id])).rowCount)) return null;
  return source;
}

export async function readRadarTodo(deps: ResearchHostDeps, tx: ReadTransaction, maySend: WorkspaceSourceRecipient, id?: string) {
  const recipient = maySend.notionRecipientId;
  if (!recipient) return;
  const settings = await deps.currentResearchSettings(tx);
  if (!settings?.enabled) return;
  const grantCurrent = deps.workspaceGrantChecker();
  const teachingRecipient: WorkspaceSourceRecipient = fact => {
    if (fact.type !== turnEvidenceType || !fact.purpose.includes(deps.teachingPurpose) || !maySend(fact)) return false;
    const turn = deps.studyTurn(fact.value);
    return Boolean(turn.accountRevision && turn.providerId && turn.protocol && turn.workspaceRevision &&
      deps.notionModelRecipient(turn.providerId, turn.baseUrl, turn.protocol, turn.model, turn.workspaceRevision) === recipient);
  };
  for await (const {spec, ...work} of deps.readActiveTodos(tx, extractorProfile, id)) {
    const source = spec.sourceFactRev;
    if (spec.settingsRevision !== settings.revision || spec.trigger.kind !== 'immediate' ||
        spec.refs.length || source.anchor || spec.parentTodoId) continue;
    const eligible = await eligibleExtraction(deps, tx, spec, teachingRecipient, 0, deps.teachingPurpose);
    if (eligible?.kind !== 'conversation' || !await grantCurrent(deps.studyTurn(eligible.fact.value))) continue;
    return {fact:eligible.fact, basis:{...work, source, settingsRev:settings.revision, settingsEpoch:settings.accessEpoch, recipient, id: source.id},
      view:{state:'available', item:{kind:extractorProfile, state:work.state}}};
  }
  return undefined;
}


export type StudioRequestError = new (status: number, message: string) => Error;

export function researchSettingInput(input: Record<string, unknown>, minimum: number, field: 'enabled' | 'allowed',
  clientRequest: (value: unknown) => string, RequestError: StudioRequestError) {
  const { revision } = input;
  const value = input[field];
  if (typeof value !== 'boolean' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < minimum)
    throw new RequestError(400, '请提交明确的教研开关和原版本。');
  return { requestId: clientRequest(input.requestId), revision, value };
}

export async function researchReadSnapshot(deps: {
  settings: (tx: ReadTransaction) => Promise<any>;
  workerOffer?: (tariff: any) => Promise<unknown>;
  comparisonAttempts?: (tx: ReadTransaction) => Promise<unknown[]>;
  effectBudgetUsage: (tx: ReadTransaction) => Promise<{held: bigint; settled: bigint}>;
}, tx: ReadTransaction, tariff?: unknown) {
  const current = await deps.settings(tx);
  const budget = current?.scoutBudget;
  const { held, settled } = await deps.effectBudgetUsage(tx);
  return { enabled: current?.enabled ?? false, revision: current?.revision ?? 0, paidBudget: budget?.limitMicros ?? 0,
    ...((tariff && deps.workerOffer && deps.comparisonAttempts) ? {workerOffers:await deps.workerOffer(tariff), comparisonAttempts:await deps.comparisonAttempts(tx)} : {}),
    ...(current?.workerGrant ? {workerGrant:current.workerGrant} : {}),
    ...(current?.scoutBudget || budget || held > 0n || settled > 0n ? { scoutBudget: budget ?? null, unit: 'USD_MICROS',
      heldUsdMicros: held.toString(), settledUsdMicros: settled.toString() } : {})};
}


type Db = any;
type LoadedModule = any;
type ResearchScoutHost = any;
type UnderstandingTransport = any;
type CorrectionRetestAuthority = any;
type WorkerTariff = any;
type CommandHooks = any;
type DbTransaction = any;
type AdvanceCoordinator = any;
type Client = any;
type WorkRef = any;

export function createResearchHost(deps: Record<string, any>) {
  const {
    scope, wake, idleRecheckMs, eligibleBasis, executeWorksheet, modelReviewSpec, worksheetView, workerOffer,
    grantHooks, startOrWakeCoordinator, effectBudgetUsage, createCommandHandler, consumePricedEffect,
    researchSettingsType, workbookCorrectionType, storagePurpose, setWorkbookResearchUse, settingsId,
    retentionReviewPermissionType, researchPurpose, workbookAttempt, workbookPaperType, workspaceEntryType,
    activityEvidenceTypes, turnEvidenceType, newResearchWatermark, comparisonAttempts, activeRetentionReview,
    researchReader, retentionReviewPermissionId, readWorksheet, whenAvailable, extractorProfile,
    openUnderstandingExtraction, eligibleExtraction, discoverUnderstandingTodos, eligibleCorrectionRetest,
    registerCorrectionRetest, correctionRetestDeriver, executeCorrectionRetest, prepareResearchTriage,
    preparePaidResearchTriage, researchDecision, scoutEffectIdentity, sampleResearchScout,
    ScoutAuthorizationChanged, independentScoutSource, checkTodoTriggers, emitTodo, recordTodoEvent,
    enqueueWork, cancelResearchTodos, saveFactWatermark, readWork, acknowledgeStartedWork, finishWork,
    cancelWork, failWork, settings, createStudioCommandHooks, workbookAttemptType, workbookSource, lockLearner,
    workerCap, paidExtractionRecipient, clientRequest, RequestError, workerConsent, researchScoutBudget,
    updateSettings, configureResearch, commandId, stableId, readMissedPosttest, retentionReviewPermission,
    withinLearnerTransaction, wakeSlot, todoSlot, allowRetentionReview
  } = deps;
function openResearch(db: Db, activity: LoadedModule, companion: LoadedModule,
  scoutHost?: ResearchScoutHost, understandingTransport?: UnderstandingTransport,
  correctionAuthority?: CorrectionRetestAuthority, tariff?: WorkerTariff,
  carePause?: { paused: (tx: ReadTransaction, now?: number) => Promise<boolean> }) {
  const held = (tx: ReadTransaction, now = Date.now()) => carePause?.paused(tx, now) ?? Promise.resolve(false);
  const extract = openUnderstandingExtraction(db, companion, understandingTransport);
  const settingsCurrent = async (tx: ReadTransaction, revision: number) => {
    const current = await settings(tx);
    return current?.enabled === true && current.revision === revision;
  };
  const hooks: CommandHooks = createStudioCommandHooks({ async afterFactsChanged(tx: any, tick: any, changes: any) {
    for (const change of changes) {
      if (change.factType === researchSettingsType) {
        await cancelResearchTodos(tx);
        await enqueueWork(tx, tick, wake);
      } else if ((change.factType === workbookAttemptType || change.factType === retentionReviewPermissionType) &&
          (await settings(tx))?.enabled) {
        await enqueueWork(tx, tick, wake);
      }
    }
  } });
  const handle = createCommandHandler(db, { modules: [activity, companion], hooks });

  const read = () => db.snapshot(scope, async (tx: any) => ({
    ...await researchReadSnapshot({settings, workerOffer, comparisonAttempts, effectBudgetUsage}, tx, tariff),
    ...(scoutHost && {scoutOffer: {route: scoutHost.route, maxRetentionDays: scoutHost.retentionDays,
      maxPerCallMicros: scoutHost.reserveUsdMicros}}),
  }));
  const permission = (paperId: string, attemptId: string) => db.snapshot(scope, async (tx: any) => {
    const fact = await workbookSource(tx, paperId, attemptId);
    return { allowed: fact.purpose.includes(researchPurpose), revision: fact.ref.rev };
  });

  const readRetentionPermission = (tx: ReadTransaction, key: string) =>
    whenAvailable(() => researchReader(tx).fact(retentionReviewPermissionId(key), { mode: 'following' }));

  const retentionReview = (key: string) => db.snapshot(scope, async (tx: any) => {
    const current = await settings(tx);
    const fact = await readRetentionPermission(tx, key);
    const active = fact && await activeRetentionReview(tx, fact);
    return { enabled: current?.enabled ?? false, revision: fact?.ref.rev ?? 0, allowed: Boolean(active),
      ...await worksheetView(tx, current?.enabled && active ? fact : null, current?.revision) };
  });

  const workbookChanged: CommandHooks['onFactsChanged'] = async (tx: any, tick: any, changes: any) => {
    const correction = changes.find((change: any) => change.factType === workbookCorrectionType && change.kind === 'create');
    if (correction) {
      const current = await settings(tx);
      if (current?.enabled && await registerCorrectionRetest(tx, tick, correction.ref.id, current.revision, settingsId))
        await enqueueWork(tx, tick, wake);
    }
    const created = changes.find((change: any) => change.factType === workbookAttemptType && change.kind === 'create');
    if (!created || !(await settings(tx))?.enabled) return;
    const permitted = await tx.query(
      `SELECT 1 FROM facts WHERE learner_id=$1 AND id=$2 AND current_rev=$3
        AND $4=ANY(purpose) AND retracted_rev IS NULL`,
      [tx.learner, created.ref.id, created.ref.rev, researchPurpose],
    );
    if (!permitted.rowCount) return;
    const fact = await whenAvailable(() => researchReader(tx).fact(created.ref.id, { mode: 'pinned', rev: created.ref.rev }));
    if (!fact) return;
    await recordTodoEvent(tx, tick, { type: 'on_attempt_submitted', subject: workbookAttempt(fact.value).paperId });
    await enqueueWork(tx, tick, wake);
  };

  const activityChanged: CommandHooks['onFactsChanged'] = async (tx: any, tick: any, changes: any) => {
    if ((extract || tariff) && changes.some((change: any) => change.factType !== turnEvidenceType &&
        (activityEvidenceTypes.includes(change.factType) || change.kind === 'set_purpose' &&
          [workbookPaperType, workspaceEntryType].includes(change.factType)) && change.kind !== 'retract') &&
        (await settings(tx))?.enabled) await enqueueWork(tx, tick, wake);
  };

  const turnCompleted = async (tx: DbTransaction, tick: Tick, id: string) => {
    if ((extract || tariff) && (await settings(tx))?.enabled &&
        await whenAvailable(() => researchReader(tx).fact(factId(id), {mode: 'following'}))) await enqueueWork(tx, tick, wake);
  };

  const advance: AdvanceCoordinator = async ({ coordinatorRef }: any, signal: AbortSignal) => {
    const scan = await db.tx(scope, async (tx: any) => {
      await lockLearner(tx, tx.learner);
      const current = await settings(tx);
      if (!current?.enabled || current.coordinatorRef !== coordinatorRef) return { status: 'disabled' } as const;
      signal.throwIfAborted();
      const now = Date.now();
      if (await held(tx, now)) return { status: 'waiting', recheckAtMs: now + idleRecheckMs } as const;
      const extractionCap = current.workerGrant?.profile === extractorProfile ? workerCap(current.workerGrant, tariff) : 0;
      const recipient = extractionCap ? paidExtractionRecipient : understandingTransport?.maySend;
      const eligible = async (spec: TodoSpec) => (await ((extract || extractionCap) && spec.workerProfile === extractorProfile
        ? eligibleExtraction(tx, spec, recipient, extractionCap) : eligibleBasis(tx, spec, settingsId, tariff))) !== null;
      const due = await checkTodoTriggers(tx, now, (spec: any, route: any) => route === correctionRetestDeriver
        ? eligibleCorrectionRetest(tx, spec, current.revision, now, correctionAuthority) : eligible(spec), correctionRetestDeriver);
      if (due.advanced) return { status: 'advanced' } as const;
      const waiting = { status: 'waiting', recheckAtMs: Math.min(due.nextAt ?? Infinity, now + idleRecheckMs) } as const;
      const watermark = await newResearchWatermark(tx);
      if (watermark) {
        if (extract || extractionCap) {
          const todos = await discoverUnderstandingTodos(tx, watermark.reviewed, current.revision, now, recipient, extractionCap);
          if (todos.length) {
            await tx.withLearnerWrite(async (tick: any) => {
              for (const spec of todos) await emitTodo(tx, tick, spec as any, now, eligible);
            });
            return { status: 'advanced' } as const;
          }
        }
        const local = await prepareResearchTriage(tx, watermark.reviewed, current.revision, now, Boolean(current.scoutBudget), eligible);
        if (local?.intent && researchDecision(local) === 'review') {
          const todo = await modelReviewSpec(tx, local.intent, current.workerGrant, tariff);
          if (!todo) return waiting;
          await tx.withLearnerWrite((tick: any) => emitTodo(tx, tick, todo, now, eligible));
          return { status: 'advanced' } as const;
        }
        await saveFactWatermark(tx, watermark.observed);
      }
      const budget = current.scoutBudget;
      if (!budget || scoutHost?.route !== budget.route || budget.expiresAtMs <= Date.now()) return waiting;
      const prepared = await preparePaidResearchTriage(tx, settingsId, current.revision, now, current.workerGrant);
      return prepared ? { status: 'sample', prepared, waiting, settingsRevision: current.revision, budget } as const : waiting;
    });
    if (scan.status !== 'sample' || !scoutHost) return scan.status === 'sample' ? scan.waiting : scan;
    signal.throwIfAborted();
    const { budget, prepared, settingsRevision } = scan;
    const authorizeScout = async (tx: ReadTransaction) => {
      const current = await settings(tx);
      if (current?.enabled !== true || current.revision !== settingsRevision ||
          current.coordinatorRef !== coordinatorRef || !(await eligibleBasis(tx, prepared.intent, settingsId, tariff)))
        throw new ScoutAuthorizationChanged();
      const { id } = prepared.intent.sourceFactRev;
      const source = await whenAvailable(() => researchReader(tx).fact(id, { mode: 'following' }));
      if (!source || !await independentScoutSource(tx, source) || budget.expiresAtMs <= Date.now())
        throw new ScoutAuthorizationChanged();
    };
    const review = await sampleResearchScout(db, settingsId, settingsRevision, budget, scoutHost,
      prepared, authorizeScout, signal);
    if (review === undefined) return scan.waiting;
    return db.tx(scope, async (tx: any) => {
      signal.throwIfAborted();
      const consumed = await consumePricedEffect(tx, scoutEffectIdentity(settingsId, prepared.intent.dedupKey), review === 'superseded' ? 'discard' : async (tick: any) => {
        if (!review) return null;
        try {
          await authorizeScout(tx);
        } catch (error) {
          if (error instanceof ScoutAuthorizationChanged) return null;
          throw error;
        }
        const grant = (await settings(tx))?.workerGrant ?? null;
        const todo = await modelReviewSpec(tx, prepared.intent, grant, tariff);
        if (!todo) return null;
        return (await emitTodo(tx, tick, todo, Date.now(), async (spec: any) => Boolean(await eligibleBasis(tx, spec, settingsId, tariff))))?.id ?? null;
      });
      return consumed ? { status: 'advanced' } : scan.waiting;
    });
  };

  return {
    read,
    async configure(input: Record<string, unknown>) {
      const { requestId, revision, value: enabled } = researchSettingInput(input, 0, 'enabled', clientRequest, RequestError);
      let grant: ReturnType<typeof workerConsent> | undefined;
      let scoutBudget: ReturnType<typeof researchScoutBudget> | undefined;
      try {
        if (input.workerGrant !== undefined) grant = workerConsent(input.workerGrant);
        if (input.scoutBudget !== undefined) scoutBudget = researchScoutBudget(input.scoutBudget);
      } catch {
        throw new RequestError(400, '前哨额度、到期时间、服务标识或留存天数无效。');
      }
      const configure = grant && enabled ? createCommandHandler(db, {modules:[activity, companion], hooks:grantHooks(hooks, grant, tariff)}) : handle;
      const receipt = await whenAvailable(() => updateSettings(() => configure({
        ...scope, actor: 'learner', purpose: researchPurpose, type: configureResearch,
        id: commandId(stableId('configure-research', requestId)), input: { id: settingsId, revision, enabled, ...(grant !== undefined && {workerGrant:grant}), ...(scoutBudget !== undefined && { scoutBudget }) },
      })));
      if (!receipt) throw new RequestError(409, '对照来源权限已变更，请重新确认。');
      return read();
    },
    permission,
    retentionReview,
    async allowRetentionReview(key: string, input: Record<string, unknown>) {
      const { requestId, revision, value: allowed } = researchSettingInput(input, 0, 'allowed', clientRequest, RequestError);
      await updateSettings(() => db.tx(scope, async (tx: any) => {
        await lockLearner(tx, tx.learner);
        const previous = await readRetentionPermission(tx, key);
        const resultId = allowed ? await readMissedPosttest(tx, key)
          : previous && retentionReviewPermission(previous.value).resultId;
        if (!resultId) throw new RequestError(409, '当前没有可授权的独立后测偏差。');
        const handlePermission = createCommandHandler(withinLearnerTransaction(db, tx), { modules: [companion], hooks });
        await handlePermission({ ...scope, actor: 'learner', purpose: researchPurpose, type: allowRetentionReview,
          id: commandId(stableId('allow-retention-review', key, requestId)),
          input: { id: retentionReviewPermissionId(key), revision, permission: { key, resultId, allowed } } });
      }));
      return retentionReview(key);
    },
    async allow(paperId: string, attemptId: string, input: Record<string, unknown>) {
      const { requestId, revision, value: allowed } = researchSettingInput(input, 1, 'allowed', clientRequest, RequestError);
      await permission(paperId, attemptId);
      const receipt = await whenAvailable(() => updateSettings(() => handle({
        ...scope, actor: 'learner', purpose: storagePurpose, type: setWorkbookResearchUse,
        id: commandId(stableId('workbook-research-use', attemptId, requestId)),
        input: { paperId, attemptId, revision, allowed },
      })));
      if (!receipt) throw new RequestError(404, '找不到这次作答。');
      return permission(paperId, attemptId);
    },
    worksheet: (paperId: string, attemptId: string) => db.snapshot(scope, async (tx: any) => {
      const current = await settings(tx);
      return worksheetView(tx, await workbookSource(tx, paperId, attemptId), current?.enabled ? current.revision : undefined);
    }),
    async source(paperId: string, attemptId: string, id: string) {
      const result = await db.snapshot(scope, async (tx: any) => readWorksheet(tx, await workbookSource(tx, paperId, attemptId)));
      if (result?.worksheet.id !== id) throw new RequestError(404, '这份复习依据当前不可读。');
      return result.source;
    },
    workbookChanged,
    activityChanged,
    turnCompleted,
    advance,
    async reconcile() {
      await db.tx(scope, async (tx: any) => {
        if (!(await settings(tx))?.enabled) return;
        await lockLearner(tx, tx.learner);
        if (!(await settings(tx))?.enabled) return;
        const pending = await tx.query(
          `SELECT 1 FROM work w JOIN work_outbox o ON o.intent_id = w.execution_ref
           WHERE w.learner_id = $1 AND w.slot_type = $2 AND w.state = 'ready' AND o.state = 'pending'`,
          [tx.learner, wakeSlot],
        );
        if (!pending.rowCount) await tx.withLearnerWrite((tick: any) => enqueueWork(tx, tick, wake));
      });
    },
    async relayWake(client: Client, taskQueue: string, ref: WorkRef, id: string) {
      const work = await readWork(db, ref);
      if (!work) return true;
      if (work.slotType !== wakeSlot) return false;
      const current = await db.snapshot(scope, settings);
      if (current) await startOrWakeCoordinator(client, current.coordinatorRef, id, { taskQueue });
      await acknowledgeStartedWork(db, id);
      await finishWork(db, ref);
      return true;
    },
    async execute(ref: WorkRef, terminal = false, signal = new AbortController().signal) {
      const work = await readWork(db, ref);
      if (!work) return true;
      if (work.slotType === 'companion.researchDelivery') {
        await cancelWork(db, ref);
        return true;
      }
      if (work.slotType !== todoSlot) return false;
      const todoId = factId(work.slotKey);
      if (terminal) {
        await failWork(db, ref);
        return true;
      }
      // A paid todo acknowledged before the pause took effect must not bill or send.
      if (await db.snapshot(scope, (tx: any) => held(tx))) {
        await cancelWork(db, ref);
        return true;
      }
      if (work.deriver === extractorProfile) {
        const grant = (await db.snapshot(scope, settings))?.workerGrant;
        const run = tariff && grant?.profile === extractorProfile ?
          openUnderstandingExtraction(db, companion, undefined, {tariff, grant, signal}) : extract;
        if (run) await run(ref, todoId, settingsCurrent);
        else await cancelWork(db, ref);
        return true;
      }
      if (work.deriver === correctionRetestDeriver) {
        await executeCorrectionRetest(db, ref, todoId, settingsCurrent, correctionAuthority);
        return true;
      }
      return executeWorksheet(db, companion, ref, todoId, settingsId, wake, tariff, signal);
    },
  };
}

  return {openResearch};
}
export async function existingUnderstandings(deps: Record<string, any>, tx: ReadTransaction, sourceId: string, recipient?: WorkspaceSourceRecipient) {
  const {rows} = await tx.query<{id: string}>(`
    SELECT f.id FROM facts f JOIN fact_revs r
      ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND NOT f.sticky
      AND f.purpose && ARRAY[$3,'all'] AND r.data->>'version'='2' AND r.data->>'sticky'='false'
      AND (r.data->'scope'->>'kind'='general' OR r.data->'scope'->>'object'=$4)
    ORDER BY f.changed_tick DESC,f.id LIMIT 6`, [tx.learner, deps.memoryAssertionType, researchPurpose, sourceId]);
  const entries = [];
  for (const row of rows) {
    const fact = await deps.whenAvailable(() => deps.createAuthorizedFactReader(tx, researchPurpose, recipient ?? deps.mayResearch).fact(factId(row.id), {mode: 'following'}));
    if (!fact) continue;
    const data = extractedUnderstanding(fact.value);
    if (data.ttl && data.ttl <= new Date().toISOString()) continue;
    const sources = await deps.openUnderstandingCitations(tx, data.evidence_refs, researchPurpose, recipient);
    if (sources.length !== data.evidence_refs.length) continue;
    const review = reviewUnderstanding(fact.ref.id, data, sources);
    const directions = review.kind === 'value' ? review.value.findings : null;
    entries.push({ref: deps.claimWitness(fact), data, directions});
  }
  return entries;
}

export async function learnerGovernedSince(deps: Record<string, any>, tx: ReadTransaction, tick: string, sourceId: string) {
  // A delayed activity must not recreate a learner-managed understanding by paraphrasing it.
  // Use the existing revision audit, including retractions and teaching-purpose corrections.
  const {rowCount} = await tx.query(`
    SELECT 1 FROM facts f JOIN fact_revs r
    ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
    WHERE f.learner_id=$1 AND f.type=ANY($2::text[])
      AND ((r.author='learner' AND f.changed_tick>$3::bigint)
        OR (f.type=$4 AND r.data#>>'{evidence_refs,0,id}'=$5))
    LIMIT 1`, [tx.learner, [deps.claimType, deps.memoryAssertionType, 'learner.preference'], tick, deps.claimType, sourceId]);
  return Boolean(rowCount);
}
