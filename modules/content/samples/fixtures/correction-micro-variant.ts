import { commandId, factId, learnerId, type FactId, type JsonObject, type Revision, type Tick } from '@mangekyo/kernel';
import { createCommandHandler } from '../../../../kernel/src/commands/handle.ts';
import type { Db } from '../../../../kernel/src/db/types.ts';
import { loadStudioTestModule } from '../../../../runtime/studio/test/modules.ts';
import { helpExposureRequest, type HelpTarget } from '../../../activity/help-exposure-values.ts';
import { createKnowledgeEdgeCommand } from '../../knowledge-edge.ts';
import { verificationSteps } from '../../question-effects.ts';
import { evaluateQuestionVerification, questionVerificationKey, questionVerificationMethodVersion, questionVerificationType } from '../../question-state.ts';
import { saveQuestionCommand } from '../../question-writes.ts';
import { localVerificationExecution, numericQuestion } from './question.ts';

const id = (suffix: string) => factId(suffix.padStart(26, '0'));
const learner = learnerId(id('100'));
const rev = 1 as Revision;
const accessEpoch = '0' as Tick;
const ref = (suffix: string) => ({ id: id(suffix), rev });
const source = { learner, ...ref('101'), accessEpoch };
const first = ref('102');
const second = ref('103');
const archetype = ref('104');
const concept = id('105');
const block = { ...use(ref('106')), blockId: 'intro' };
function use({ id, rev }: typeof first) { return { id, rev, accessEpoch }; }
const targetEdges = { complete: true, edgeIds: [id('117')] };
const blockEdges = { complete: true, edgeIds: [id('118'), id('119')] };
const input = {
  source,
  variantEdgeIds: [id('111'), id('112')],
  archetypeEdgeIds: [id('113'), id('114'), id('115')],
} as const;

export const correctionMicroVariantFixture = {
  learner, input, first, second, archetype, concept, block, blockEdges, targetEdges, display: ref('116'), deriver: 'content/question-verification',
  target: (candidate: typeof first): HelpTarget => ({ activityId: candidate.id, issuance: candidate, item: { itemId: 'question' } }),
};

const averageSpeed = (hours: number) => (30 + 60 * hours) / (1 + hours);
const question = (hours: number) => numericQuestion('平均速度',
  `先以 30 km/h 行驶 1 小时，再以 60 km/h 行驶 ${hours} 小时。平均速度是多少？`, 'average', averageSpeed(hours),
  [{ id: 'solution', parentId: null, body: { kind: 'text', text: 'PRIVATE SOLUTION' } }]);

export async function seedCorrectionMicroVariant(db: Db) {
  const { display, deriver, target } = correctionMicroVariantFixture;
  const modules = await Promise.all(['content', 'activity'].map(loadStudioTestModule));
  const handle = createCommandHandler(db, { modules, hooks: { async onFactsChanged() {} } });
  const command = (type: string, input: JsonObject & { id: FactId }, requestId: string = input.id) =>
    handle({ learner, type, input, id: commandId(id(requestId)), purpose: 'storage', actor: 'learner' });
  type Endpoint = { kind: string; sourceUse: ReturnType<typeof use>; blockId?: string };
  const edge = (id: FactId, kind: string, from: Endpoint, to: Endpoint, variant?: JsonObject) =>
    command(createKnowledgeEdgeCommand, { id, purpose: 'teaching', edge: {
      kind, from, to, sourceUses: [from.sourceUse, to.sourceUse], scope: 'average-speed', ...(variant && { variant }),
    } });
  const questionNode = (ref: typeof first) => ({ kind: 'question', sourceUse: use(ref) });

  const questions = [source, first, second] as const;
  for (const [index, { id }] of questions.entries()) {
    await command(saveQuestionCommand, { id, purpose: 'teaching', asset: question(index + 1) });
  }
  for (const [id, kind, canonicalName] of [[archetype.id, 'archetype', '按时间加权的平均速度'], [concept, 'concept', '平均速度']] as const) {
    await command('content.createKnowledgeEntity', { id, purpose: 'teaching',
      entity: { kind, canonicalName, aliases: [] },
      resolution: { decision: 'no-match', reason: '已核对现有实体', candidates: [], sourceUses: [use(source)] } });
  }
  await command('content.createTextbookPage', { id: block.id, clientEditSeq: 0, purpose: ['storage', 'teaching'],
    page: { title: '平均速度', blocks: [{ id: block.blockId, parentId: null, body: { kind: 'text', text: '总路程除以总时间' } }] } });
  const node = { kind: 'concept', sourceUse: use({ id: concept, rev }) };
  const chapter = { kind: 'chapter', sourceUse: use(block), blockId: block.blockId };
  await edge(targetEdges.edgeIds[0]!, 'targets_concept', questionNode(source), node);
  await edge(blockEdges.edgeIds[0]!, 'maps_to_chapter', node, chapter);
  await edge(blockEdges.edgeIds[1]!, 'explains', chapter, node);
  for (const [index, candidate] of questions.entries()) {
    const from = questionNode(candidate);
    await edge(input.archetypeEdgeIds[index]!, 'canonical_archetype', from, { kind: 'archetype', sourceUse: use(archetype) });
    if (index === 0) continue;
    await edge(input.variantEdgeIds[index - 1]!, 'variant_of', from, questionNode(source), {
      familyId: 'average-speed', relation: 'numbers_only', preserved: ['两段速度'], changed: ['第二段时长'], spoilsNext: 'none',
    });
    const key = questionVerificationKey(candidate);
    const basis = {
      ...use(candidate), recheck: 0, methodVersion: questionVerificationMethodVersion,
    };
    // The fixture supplies synthetic consensus receipts without running the WASM host.
    const checks = verificationSteps.map(({ stepKey }, step) => ({
      invocationId: `${candidate.id}:${stepKey}`, execution: localVerificationExecution((step + 1).toString(16)),
      result: { answerKey: String(averageSpeed(index + 1)), conditionKey: 'average-speed',
        reasoning: 'PRIVATE VERIFICATION REASONING', eligible: true,
      },
    }));
    const value = { kind: 'value', value: evaluateQuestionVerification(basis, checks) };
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
