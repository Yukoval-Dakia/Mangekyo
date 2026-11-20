import { factId, learnerId, type FactId, type Json, type Revision, type Tick } from '@mangekyo/kernel';
import type { DbQuery } from '../../../../kernel/src/db/types.ts';
import { helpExposureType, recordHelpExposureCommand, type HelpTarget } from '../../../activity/help-exposure-values.ts';
import { assetType } from '../../asset.ts';
import { knowledgeEdgeType, type KnowledgeEndpoint } from '../../knowledge-edge.ts';
import {
  questionStateId, questionStateType, questionVerificationKey, questionVerificationMethodVersion, questionVerificationType,
} from '../../question-state.ts';

const id = (suffix: string) => factId(suffix.padStart(26, '0'));
const learner = learnerId(id('100'));
const rev = 1 as Revision;
const accessEpoch = '0' as Tick;
const ref = (suffix: string) => ({ id: id(suffix), rev });
const source = { learner, ...ref('101') };
const first = ref('102');
const second = ref('103');
const archetype = ref('104');
const input = {
  source,
  variantEdgeIds: [id('111'), id('112')],
  archetypeEdgeIds: [id('113'), id('114'), id('115')],
};

export const correctionMicroVariantFixture = {
  learner, input, first, second, archetype, display: ref('116'), deriver: 'fixture-question-verifier',
  target: (candidate: typeof first): HelpTarget => ({ activityId: candidate.id, issuance: candidate, item: { itemId: 'question' } }),
};

function question(hours: number): Json {
  return {
    kind: 'question', title: '平均速度', promptBlockId: 'statement',
    blocks: [
      { id: 'statement', parentId: null, body: { kind: 'text', text: `先以 30 km/h 行驶 1 小时，再以 60 km/h 行驶 ${hours} 小时。平均速度是多少？` } },
      { id: 'solution', parentId: null, body: { kind: 'text', text: 'PRIVATE SOLUTION' } },
    ],
    response_schema: [{ slotId: 'answer', schemaVersion: '1', fields: [{ path: '', kind: 'numeric' }] }],
    assessment_contract: [{ criterionId: 'average', inputs: [{ slotId: 'answer', path: '' }],
      evaluator: { id: 'frozen-value-match', version: '1' }, parameters: { key: 'PRIVATE RUBRIC' },
      maximum: 1, missingEvidence: 'insufficient-evidence' }],
  };
}

/** Isolated seed with a synthetic settled verification slot. No effect dispatch is needed. */
export async function seedCorrectionMicroVariant(db: DbQuery) {
  const purpose = ['teaching'];
  async function fact(id: FactId, type: string, value: Json, tick = 1, command = 'fixture') {
    await db.query(`INSERT INTO facts(learner_id,id,type,current_rev,purpose,created_tick,changed_tick)
      VALUES ($1,$2,$3,1,$4,$5,$5)`, [learner, id, type, purpose, tick]);
    await db.query(`INSERT INTO fact_revs(learner_id,fact_id,rev,data,purpose,sticky,kind,author,command_id,tick)
      VALUES ($1,$2,1,$3,$4,false,'value','learner',$5,$6)`, [learner, id, JSON.stringify(value), purpose, command, tick]);
  }
  await db.query('UPDATE learners SET clock=2 WHERE id=$1', [learner]);
  await fact(archetype.id, assetType, { kind: 'archetype', title: '按时间加权的平均速度', blocks: [], aliases: [], merged_into: null });
  for (const [index, candidate] of [source, first, second].entries()) {
    await fact(candidate.id, assetType, question(index + 1));
    await fact(await questionStateId(candidate.id), questionStateType, { questionId: candidate.id, restrictions: [], recheck: 0, last: null });
    const endpoint = (kind: KnowledgeEndpoint['kind'], target: typeof first) => ({
      kind, sourceUse: { id: target.id, rev: target.rev, accessEpoch },
    });
    async function edge(id: FactId, kind: 'instance_of' | 'variant_of', from: ReturnType<typeof endpoint>, to: ReturnType<typeof endpoint>) {
      await fact(id, knowledgeEdgeType, {
        kind, from, to, sourceUses: [from.sourceUse, to.sourceUse], scope: 'average-speed',
        ...(kind === 'variant_of' ? { variant: { familyId: 'average-speed', relation: 'single_condition',
          preserved: ['两段速度'], changed: ['第二段时长'], spoilsNext: 'none' } } : {}),
      });
    }
    await edge(input.archetypeEdgeIds[index]!, 'instance_of', endpoint('question', candidate), endpoint('archetype', archetype));
    if (index === 0) continue;
    await edge(input.variantEdgeIds[index - 1]!, 'variant_of', endpoint('question', candidate), endpoint('question', source));
    const key = questionVerificationKey(candidate);
    const derivation = id(`12${index}`);
    const value = { kind: 'value', value: { status: 'ready', basis: {
      id: candidate.id, rev, accessEpoch, recheck: 0, methodVersion: questionVerificationMethodVersion,
    }, invocations: [], solutions: ['PRIVATE VERIFICATION REASONING'] } };
    const manifest = { version: 1, learner, purpose: 'teaching', gatherTick: '1',
      inputs: [{ kind: 'fact', mode: 'following', id: candidate.id, rev, accessEpoch }] };
    await db.query(`INSERT INTO derivations(learner_id,id,slot_type,slot_key,deriver,scope_keys,value,lifecycle,freshness,gather_tick,effective_tick,manifest)
      VALUES ($1,$2,$3,$4,$5,'{}',$6,'effective','current',1,1,$7)`,
    [learner, derivation, questionVerificationType, key, correctionMicroVariantFixture.deriver, JSON.stringify(value), JSON.stringify(manifest)]);
    await db.query(`INSERT INTO slot_state(learner_id,slot_type,slot_key,current_id,scope_keys) VALUES ($1,$2,$3,$4,'{}')`,
      [learner, questionVerificationType, key, derivation]);
  }
  await db.query(`INSERT INTO commands(learner_id,id,type,input,state,tick) VALUES ($1,'display',$2,'{}','done',2)`,
    [learner, recordHelpExposureCommand]);
  await fact(correctionMicroVariantFixture.display.id, helpExposureType, {
    kind: 'displayed', mount: correctionMicroVariantFixture.target(first), alsoAppliesTo: [],
    content: first, step: { kind: 'solution', order: 1 },
  }, 2, 'display');
}
