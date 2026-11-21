import { readable, readFactCollection, readValueRevisions } from '../../kernel/src/commands/fact-collection.ts';
import { createBusScope } from '../../kernel/src/bus.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import { commandId, factId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { organizerNoteType, organizerNoteView, prepareOrganizerNote } from '../../modules/activity/organizer-values.ts';
import {
  createOrganizerTask,
  organizerTaskDoneInput,
  organizerTaskDraft,
  setOrganizerTaskDone,
} from '../../modules/plan/organizer-task-values.ts';
import { studyRecordType, submitOfflinePack } from '../../modules/activity/values.ts';
import { workbookAttemptType, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { todayCompletion, todayPaper, todaySettings } from '../../modules/activity/today-values.ts';
import saveRule from '../../modules/plan/commands/save-rule.ts';
import setGoalStatus from '../../modules/plan/commands/set-goal-status.ts';
import todayDeriver from '../../modules/plan/derivers/today.ts';
import { todayDuration } from '../../modules/plan/today.ts';
import { checkPack, openPack, packCandidates } from '../../modules/plan/offline-pack.ts';
import type { GoalStatus } from '../../modules/plan/goal-values.ts';
import { planRule, planRuleType, type PlanRule } from '../../modules/plan/rules.ts';
import { integer } from '../../modules/plan/validation.ts';
import { readGoal, readTasks } from './learning-overview.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

function validate<Input, Value>(parse: (input: Input) => Value, input: Input): Value {
  try {
    return parse(input);
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : '内容格式无效。');
  }
}

function translate(error: unknown): Error {
  if (error instanceof RequestError) return error;
  if (error instanceof FactNotFoundError) return new RequestError(400, '链接的材料或要恢复的版本不存在。');
  if (error instanceof FactReadDeniedError) return new RequestError(403, '这份材料当前无法链接。');
  if (error instanceof Error) {
    if (error.message === 'Command ID already used with a different command identity') {
      return new RequestError(409, '同一个请求标识已经用于不同内容。');
    }
    if (error.message.startsWith('Fact revision conflict: ')) {
      return new RequestError(409, '这条记录已在别处更新。请刷新后再试。');
    }
    if (error.message.startsWith('Fact does not exist: ')) {
      return new RequestError(404, '这条记录不存在。');
    }
    if (error.message.startsWith('Fact is retracted: ')) {
      return new RequestError(409, '这条记录已经撤回。');
    }
  }
  return error instanceof Error ? error : new Error('安排保存失败。');
}

export function openOrganizer(db: Db, activity: LoadedModule, plan: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks()) {
  const handle = createCommandHandler(db, { modules: [activity, plan], hooks });

  const learner = studioLearner;
  const access = {callerPurpose: storagePurpose, maySend: () => true};
  const busActor = {
    actor: 'learner' as const, purpose: storagePurpose, maySend: access.maySend,
    defaultPreset: 'organizer', presets: new Map([['organizer', (fact: FactSnapshot) => fact]]),
  };
  const bus = createBusScope({db, learner}, busActor, handle);
  async function write(type: string, requestId: string, input: unknown, deletionWatermark?: string) {
    try {
      const command = {
        ...(deletionWatermark === undefined ? {} : {deletionWatermark}),
        type,
        id: commandId(stableId('organizer-command', type, requestId)),
        input: input as Json,
      };
      const {wrote: [ref]} = await bus.mutate(command);
      if (!ref) throw new RequestError(500, '这次写入没有返回记录。');
      return {id: ref.id, rev: ref.rev};
    } catch (error) {
      throw translate(error);
    }
  }

  async function snapshot(includeHistory = true) {
    return db.snapshot({ learner: studioLearner }, async (tx) => {
      const read = createCommandReadContext(tx, storagePurpose);
      const taskOverview = await readTasks(tx, access, null);
      const tasks = 'items' in taskOverview ? taskOverview.items : [];

      const notes = [];
      for await (const current of readFactCollection(tx, read, [organizerNoteType], { newestFirst: true })) {
        const history = includeHistory ? await readValueRevisions(tx, read, current.ref.id) : [];
        notes.push(organizerNoteView(current, history));
      }
      return { tasks, notes };
    });
  }
  async function today(params: URLSearchParams) {
    const { dayOf, ...settings } = validate(p => todaySettings(p, new Date().toISOString()), params);
    const scope = { learner, purpose: storagePurpose };
    return db.snapshot(scope, async tx => {
      let goal: {id: string; rev: number; text: string | null; status: GoalStatus} | null = null;
      const rules: {id: string; rev: Revision; data: PlanRule}[] = [];
      const gathered = await gatherSnapshot({ ...db, snapshot: (_, work) => work(tx) }, scope, ctx =>
        todayDeriver.gather(ctx, async ({read}) => {
          const current = await readGoal(tx, access, read);
          goal = current.state === 'set' ? {id: current.witness.id, rev: current.witness.rev, text: current.text, status: current.status} : null;
          const day = dayOf(settings.now);
          const papers: FactSnapshot[] = [];
          const completed = new Set<string | null>();
          for await (const fact of readFactCollection(tx, read, [planRuleType, workbookPaperType, workbookAttemptType, studyRecordType], {pinTypes: [workbookPaperType]})) {
            if (fact.type === planRuleType) rules.push({id: fact.ref.id, rev: fact.ref.rev, data: planRule(fact.value)});
            else if (fact.type === workbookPaperType) papers.push(fact);
            else completed.add(todayCompletion(fact, day, dayOf));
          }
          const candidates = [
            ...papers.flatMap(fact => todayPaper(fact, completed, day) ?? []),
            ...packCandidates().map(c => completed.has(c.id + '@' + c.open?.rev) ? {...c, state: 'completed' as const, date: day} : c),
          ];
          return {
            ...settings, ...validate(todayDuration, params.get('duration')), ...(goal ? {goal} : {}), rules: rules.map(r => r.data), candidates,
            constraints: {budget_min: null, locks: [], deadlines: []},
          };
        }));
      if (gathered.plan.kind !== 'input') throw new Error('今天的输入未就绪。');
      const input = gathered.plan.data as Parameters<typeof todayDeriver.derive>[0];
      const outcome = await todayDeriver.derive(input);
      if (outcome.kind !== 'value') throw new Error(outcome.reason);
      const alternatives = input.candidates.filter(c => outcome.value.shortlist.includes(c.id));
      return {...outcome.value, alternatives, rules, goal, observedThrough: input.observedThrough, openedAt: settings.now};
    });
  }

  return {
    snapshot, today,

    async open(params: URLSearchParams) {
      const kind = params.get('kind');
      const id = params.get('id') ?? '';
      const rev = validate(n => integer(n, 1, 2147483647) as Revision, Number(params.get('rev')));
      if (kind === 'pack') return {kind, ...validate(() => openPack(id, rev), null)};
      if (kind !== 'activity') throw new RequestError(400, '活动类型无效。');
      const ref = {id: validate(factId, id), mode: 'following' as const, rev, type: workbookPaperType};
      const match = await readable(() => bus.resolve([ref], 'organizer'));
      const paper = match?.items[0];
      if (paper && todayPaper(paper, new Set(), '')) return {kind, id, rev, href: '/papers/' + id};
      throw new RequestError(404, '这份活动的冻结版本当前不可打开。');
    },

    async rule(input: Record<string, unknown>) {
      const requestId = clientRequest(input.requestId);
      const id = input.id ?? stableId('plan-rule', requestId);
      return write(saveRule.type, requestId, validate(saveRule.schema.parse, {...input, id}));
    },

    async goal(input: Record<string, unknown>) {
      return write(setGoalStatus.type, clientRequest(input.requestId), validate(setGoalStatus.schema.parse, input));
    },

    async submit(input: Record<string, unknown>, deletionWatermark?: string) {
      if (input.actor !== undefined || input.consent !== 'teaching') throw new RequestError(400, '请确认保存本次学习记录。');
      const requestId = clientRequest(input.requestId);
      const idOfPack = typeof input.id === 'string' ? input.id : '';
      const {record, explanation, ...pack} = validate(() => checkPack(idOfPack, integer(input.rev, 1, 2147483647), integer(input.choice, 0, 2147483647)), null);
      const id = factId(stableId('offline-pack-submission', requestId));
      const ref = await write(submitOfflinePack, requestId, {id, data: {consent: input.consent, pack, record}}, deletionWatermark);
      return {...ref, result: pack.result, explanation};
    },

    async task(input: unknown) {
      const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const requestId = clientRequest(value.requestId);
      if (typeof value.id === 'string' && value.id.length > 0) {
        const commandInput = validate(organizerTaskDoneInput, {
          ...value,
          expectedRev: value.expectedRev ?? value.rev,
        });
        return write(setOrganizerTaskDone, requestId, commandInput);
      }
      const data = validate(organizerTaskDraft, input);
      const id = factId(stableId('organizer-task', requestId));
      return write(createOrganizerTask, requestId, { id, data });
    },

    async note(input: unknown) {
      const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const requestId = clientRequest(value.requestId);
      const id = factId(stableId('organizer-note', requestId));
      const command = validate(data => prepareOrganizerNote(data, id), input);
      return write(command.type, requestId, command.input);
    },
  };
}
