import { commandId, factId, learnerId, type FactId, type JsonObject, type Revision, type Tick } from '@mangekyo/kernel';
import { createCommandHandler } from '../../../../kernel/src/commands/handle.ts';
import type { Db } from '../../../../kernel/src/db/types.ts';
import { loadStudioTestModule } from '../../../../runtime/studio/test/modules.ts';
import { helpExposureRequest, type HelpTarget } from '../../../activity/help-exposure-values.ts';
import { createKnowledgeEdgeCommand } from '../../knowledge-edge.ts';
import { questionVerificationKey, questionVerificationMethodVersion, questionVerificationType } from '../../question-state.ts';
import { saveQuestionCommand } from '../../question-writes.ts';

const id = (suffix: string) => factId(suffix.padStart(26, '0'));
const learner = learnerId(id('100'));
const rev = 1 as Revision;
const accessEpoch = '0' as Tick;
const ref = (suffix: string) => ({ id: id(suffix), rev });
const source = { learner, ...ref('101'), accessEpoch };
const first = ref('102');
const second = ref('103');
const archetype = ref('104');
const input = {
  source,
  variantEdgeIds: [id('111'), id('112')],
  archetypeEdgeIds: [id('113'), id('114'), id('115')],
} as const;

export const correctionMicroVariantFixture = {
  learner, input, first, second, archetype, display: ref('116'), deriver: 'content/question-verification',
  target: (candidate: typeof first): HelpTarget => ({ activityId: candidate.id, issuance: candidate, item: { itemId: 'question' } }),
};

const question = (hours: number) => ({
  kind: 'question', title: '平均速度', promptBlockId: 'statement',
  blocks: [
    { id: 'statement', parentId: null, body: { kind: 'text', text: `先以 30 km/h 行驶 1 小时，再以 60 km/h 行驶 ${hours} 小时。平均速度是多少？` } },
    { id: 'solution', parentId: null, body: { kind: 'text', text: 'PRIVATE SOLUTION' } },
  ],
  response_schema: [{ slotId: 'answer', schemaVersion: '1', fields: [{ path: '', kind: 'numeric' }] }],
  assessment_contract: [{ criterionId: 'average', inputs: [{ slotId: 'answer', path: '' }],
    evaluator: { id: 'frozen-value-match', version: '1' }, parameters: { value: (30 + 60 * hours) / (1 + hours) },
    maximum: 1, missingEvidence: 'insufficient-evidence' }],
});

export async function seedCorrectionMicroVariant(db: Db) {
  const { display, deriver, target } = correctionMicroVariantFixture;
  const modules = await Promise.all(['content', 'activity'].map(loadStudioTestModule));
  const handle = createCommandHandler(db, { modules, hooks: { async onFactsChanged() {} } });
  const command = (type: string, input: JsonObject & { id: FactId }, requestId: string = input.id) =>
    handle({ learner, type, input, id: commandId(id(requestId)), purpose: 'storage', actor: 'learner' });
  const use = ({ id, rev }: typeof first) => ({ id, rev, accessEpoch });
  function edge(id: FactId, kind: 'instance_of' | 'variant_of', candidate: typeof first) {
    const from = { kind: 'question', sourceUse: use(candidate) };
    const to = kind === 'instance_of' ? { kind: 'archetype', sourceUse: use(archetype) } : { kind: 'question', sourceUse: use(source) };
    return command(createKnowledgeEdgeCommand, { id, purpose: 'teaching', edge: {
      kind, from, to, sourceUses: [from.sourceUse, to.sourceUse], scope: 'average-speed',
      ...(kind === 'variant_of' ? { variant: { familyId: 'average-speed', relation: 'numbers_only',
        preserved: ['两段速度'], changed: ['第二段时长'], spoilsNext: 'none' } } : {}),
    } });
  }

  const questions = [source, first, second] as const;
  for (const [index, { id }] of questions.entries()) {
    await command(saveQuestionCommand, { id, purpose: 'teaching', asset: question(index + 1) });
  }
  await command('content.createKnowledgeEntity', {
    id: archetype.id, purpose: 'teaching',
    entity: { kind: 'archetype', canonicalName: '按时间加权的平均速度', aliases: [] },
    resolution: { decision: 'no-match', reason: '已核对现有母题', candidates: [], sourceUses: [use(source)] },
  });
  for (const [index, candidate] of questions.entries()) {
    await edge(input.archetypeEdgeIds[index]!, 'instance_of', candidate);
    if (index === 0) continue;
    await edge(input.variantEdgeIds[index - 1]!, 'variant_of', candidate);
    // 固定验题结果，发放仍通过内核读取当前槽并重验题目见证。
    const key = questionVerificationKey(candidate);
    const value = { kind: 'value', value: { status: 'ready', basis: {
      ...use(candidate), recheck: 0, methodVersion: questionVerificationMethodVersion,
    }, invocations: [], solutions: ['PRIVATE VERIFICATION REASONING'] } };
    const manifest = { version: 1, learner, purpose: 'teaching', gatherTick: '4',
      inputs: [{ kind: 'fact', mode: 'following', ...use(candidate) }] };
    await db.query(`INSERT INTO derivations(learner_id,id,slot_type,slot_key,deriver,scope_keys,value,lifecycle,freshness,gather_tick,effective_tick,manifest)
      VALUES ($1,$2,$3,$4,$5,'{}',$6,'effective','current',4,4,$7)`,
    [learner, candidate.id, questionVerificationType, key, deriver, JSON.stringify(value), JSON.stringify(manifest)]);
    await db.query(`INSERT INTO slot_state(learner_id,slot_type,slot_key,current_id,scope_keys) VALUES ($1,$2,$3,$4,'{}')`,
      [learner, questionVerificationType, key, candidate.id]);
  }
  await handle({ learner, actor: 'learner', ...helpExposureRequest(display.id, {
    kind: 'displayed', mount: target(first), alsoAppliesTo: [], content: first, step: { kind: 'solution', order: 1 },
  }) });
  return command;
}
