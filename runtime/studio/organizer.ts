import { createBusScope } from '../../kernel/src/bus.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { readFactCollection, readValueRevisions } from '../../kernel/src/commands/fact-collection.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { commandId, factId, readable, type FactSnapshot, type Json, type ReadTransaction, type Revision } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { allAssessments } from '../../modules/activity/learning-attempt-read.ts';
import { readGoal, readTasks } from '../../modules/activity/learning-overview.ts';
import { materialType, storagePurpose } from '../../modules/activity/library-values.ts';
import { organizerNoteType, organizerNoteView, prepareOrganizerNote } from '../../modules/activity/organizer-values.ts';
import { collectFreshMaterialSources, collectPendingCorrectionSources, todayCompletion, todayPaper, todaySettings } from '../../modules/activity/today-values.ts';
import { studyRecordType, studyTurnType, submitOfflinePack } from '../../modules/activity/values.ts';
import { workbookCorrectionType } from '../../modules/activity/workbook-correction.ts';
import { workbookAttemptType, workbookPaperType, workbookRubricAssessmentType } from '../../modules/activity/workbook-values.ts';
import { intakeFactType } from '../../modules/capture/intake-values.ts';
import saveRule from '../../modules/plan/commands/save-rule.ts';
import setGoalStatus from '../../modules/plan/commands/set-goal-status.ts';
import todayDeriver from '../../modules/plan/derivers/today.ts';
import type { GoalStatus } from '../../modules/plan/goal-values.ts';
import { openPack } from '../../modules/plan/offline-pack.ts';
import { classifyOrganizerCommandError, mergePackCandidatesWithCompletion, parseOfflinePackSubmit, parseOrganizerOpenRev, parseOrganizerTaskInput } from '../../modules/plan/organizer-slice.ts';
import { createOrganizerTask, setOrganizerTaskDone } from '../../modules/plan/organizer-task-values.ts';
import { planRule, planRuleType, type PlanRule } from '../../modules/plan/rules.ts';
import { projectFreshMaterialCandidates, projectPendingCorrectionCandidates, todayDuration } from '../../modules/plan/today.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { createCommandReadContext, isFactNotFound, isFactReadDenied } from './fact-read-helpers.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

function validate<Input, Value>(parse: (input: Input) => Value, input: Input): Value {
  try { return parse(input); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '内容格式无效。'); }
}

function translate(error: unknown): Error {
  if (error instanceof RequestError) return error;
  if (isFactNotFound(error)) return new RequestError(400, '链接的材料或要恢复的版本不存在。');
  if (isFactReadDenied(error)) return new RequestError(403, '这份材料当前无法链接。');
  if (error instanceof Error) {
    const mapped = classifyOrganizerCommandError(error.message);
    if (mapped) return new RequestError(mapped.status, mapped.message);
    return error;
  }
  return new Error('安排保存失败。');
}

const todayFactTypes = [
  planRuleType, materialType, intakeFactType, studyTurnType, workbookPaperType,
  workbookAttemptType, workbookRubricAssessmentType, workbookCorrectionType, studyRecordType,
];

export function openOrganizer(db: Db, activity: LoadedModule, plan: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks(),
  carePause?: { paused: (tx: ReadTransaction, now?: number) => Promise<boolean> }) {
  const handle = createCommandHandler(db, { modules: [activity, plan], hooks });
  const learner = studioLearner, access = { callerPurpose: storagePurpose, maySend: () => true };
  const bus = createBusScope({ db, learner }, {
    actor: 'learner', purpose: storagePurpose, maySend: access.maySend,
    defaultPreset: 'organizer', presets: new Map([['organizer', (fact: FactSnapshot) => fact]]),
  }, handle);

  async function write(type: string, requestId: string, input: unknown, deletionWatermark?: string) {
    try {
      const { wrote: [ref] } = await bus.mutate({
        ...(deletionWatermark === undefined ? {} : { deletionWatermark }),
        type, id: commandId(stableId('organizer-command', type, requestId)), input: input as Json,
      });
      if (!ref) throw new RequestError(500, '这次写入没有返回记录。');
      return { id: ref.id, rev: ref.rev };
    } catch (error) { throw translate(error); }
  }

  return {
    snapshot: (includeHistory = true) => db.snapshot({ learner }, async tx => {
      const read = createCommandReadContext(tx, storagePurpose), taskOverview = await readTasks(tx, access, null);
      const tasks = 'items' in taskOverview ? taskOverview.items : [], notes = [];
      for await (const current of readFactCollection(tx, read, [organizerNoteType], { newestFirst: true }))
        notes.push(organizerNoteView(current, includeHistory ? await readValueRevisions(tx, read, current.ref.id) : []));
      return { tasks, notes };
    }),
    today(params: URLSearchParams) {
      const { dayOf, ...settings } = validate(p => todaySettings(p, new Date().toISOString()), params);
      const scope = { learner, purpose: storagePurpose };
      return db.snapshot({ learner }, async tx => {
        const paused = (await carePause?.paused(tx)) === true;
        let goal: { id: string; rev: number; text: string | null; status: GoalStatus } | null = null;
        const rules: { id: string; rev: Revision; data: PlanRule }[] = [];
        const gathered = await gatherSnapshot({ ...db, snapshot: (_, work) => work(tx) }, scope, ctx =>
          todayDeriver.gather(ctx, async ({ read }) => {
            const current = await readGoal(tx, access, read);
            goal = current.state === 'set' ? { id: current.witness.id, rev: current.witness.rev, text: current.text, status: current.status } : null;
            const day = dayOf(settings.now), papers: FactSnapshot[] = [], completed = new Set<string | null>(), pendingFacts: FactSnapshot[] = [];
            for await (const fact of readFactCollection(tx, read, todayFactTypes, { pinTypes: [workbookPaperType] })) {
              if (fact.type === planRuleType) rules.push({ id: fact.ref.id, rev: fact.ref.rev, data: planRule(fact.value) });
              else if (fact.type === workbookPaperType) papers.push(fact);
              else if (fact.type === workbookAttemptType || fact.type === studyRecordType) completed.add(todayCompletion(fact, day, dayOf));
              if (fact.type !== planRuleType && fact.type !== studyRecordType) pendingFacts.push(fact);
            }
            const candidates = paused ? [] : [
              ...papers.flatMap(fact => todayPaper(fact, completed, day) ?? []),
              ...mergePackCandidatesWithCompletion(completed, day),
              ...projectPendingCorrectionCandidates(collectPendingCorrectionSources(pendingFacts, await allAssessments(tx))),
              ...projectFreshMaterialCandidates(collectFreshMaterialSources(pendingFacts), settings.now),
            ];
            return { ...settings, ...validate(todayDuration, params.get('duration')), ...(goal ? { goal } : {}),
              rules: rules.map(r => r.data), candidates, constraints: { budget_min: null, locks: [], deadlines: [] } };
          }));
        if (gathered.plan.kind !== 'input') throw new Error('今天的输入未就绪。');
        const input = gathered.plan.data as Parameters<typeof todayDeriver.derive>[0];
        const outcome = await todayDeriver.derive(input);
        if (outcome.kind !== 'value') throw new Error(outcome.reason);
        const alternatives = input.candidates.filter(c => outcome.value.shortlist.includes(c.id));
        return { ...outcome.value, alternatives, rules, goal, observedThrough: input.observedThrough, openedAt: settings.now, ...(paused ? { paused: true as const } : {}) };
      });
    },
    async open(params: URLSearchParams) {
      const kind = params.get('kind'), id = params.get('id') ?? '', rev = validate(parseOrganizerOpenRev, params.get('rev'));
      if (kind === 'pack') return { kind, ...validate(() => openPack(id, rev), null) };
      if (kind === 'material') {
        const match = await readable(() => bus.resolve([{ id: validate(factId, id), mode: 'following', rev, type: materialType }], 'organizer'));
        if (match?.items[0]?.ref.rev === rev) return { kind, id, rev, href: '/materials/saved/' + encodeURIComponent(id) };
        throw new RequestError(404, '这份材料的冻结版本当前不可打开。');
      }
      if (kind !== 'activity') throw new RequestError(400, '活动类型无效。');
      const match = await readable(() => bus.resolve([{ id: validate(factId, id), mode: 'following', rev, type: workbookPaperType }], 'organizer'));
      if (match?.items[0]) return { kind, id, rev, href: '/papers/' + id };
      throw new RequestError(404, '这份活动的冻结版本当前不可打开。');
    },
    rule(input: Record<string, unknown>) {
      const requestId = clientRequest(input.requestId);
      return write(saveRule.type, requestId, validate(saveRule.schema.parse, { ...input, id: input.id ?? stableId('plan-rule', requestId) }));
    },
    goal: (input: Record<string, unknown>) => write(setGoalStatus.type, clientRequest(input.requestId), validate(setGoalStatus.schema.parse, input)),
    async submit(input: Record<string, unknown>, deletionWatermark?: string) {
      const { record, explanation, ...pack } = validate(parseOfflinePackSubmit, input);
      const requestId = clientRequest(input.requestId), id = factId(stableId('offline-pack-submission', requestId));
      const ref = await write(submitOfflinePack, requestId, { id, data: { consent: input.consent, pack, record } }, deletionWatermark);
      return { ...ref, result: pack.result, explanation };
    },
    task(input: unknown) {
      const requestId = clientRequest(input && typeof input === 'object' ? (input as Record<string, unknown>).requestId : undefined);
      const parsed = validate(parseOrganizerTaskInput, input);
      return parsed.kind === 'done'
        ? write(setOrganizerTaskDone, requestId, parsed.commandInput)
        : write(createOrganizerTask, requestId, { id: factId(stableId('organizer-task', requestId)), data: parsed.data });
    },
    note(input: unknown) {
      const requestId = clientRequest(input && typeof input === 'object' ? (input as Record<string, unknown>).requestId : undefined);
      const command = validate(data => prepareOrganizerNote(data, factId(stableId('organizer-note', requestId))), input);
      return write(command.type, requestId, command.input);
    },
  };
}
