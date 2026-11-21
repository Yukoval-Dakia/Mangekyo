import { expect, it } from 'vitest';
import { commandId, factId, type Revision } from '../../../kernel/src/declarations/ids.ts';
import { eraseOriginal } from '../../../kernel/src/lifecycle.ts';
import { relayPending } from '../../../kernel/src/work/index.ts';
import { pythonReads } from '../../../executors/teaching/python-sdk.ts';
import type { CanonicalEvidenceSliceV1 } from '../../../kernel/src/pipeline-contracts.ts';
import type { VerifiedAssessmentPublicationEvidence } from '../../../modules/activity/assessment-publication.ts';
import { workbookDraft } from '../../../modules/activity/workbook-values.ts';
import { withLearnerDatabase, testDatabaseUrl } from '../../../kernel/test/learner-database.ts';
import { stableId, studioLearner as learner } from '../identity.ts';
import { openLearningTools } from '../learning-tools.ts';
import { openLibrary } from '../library.ts';
import type { WorkspaceSourceRecipient } from '../source-read.ts';
import { openWorkbook } from '../workbook.ts';
import { openWorkbookAssessment, prepareWorkbookRelease, workbookTextEvaluator } from '../workbook-assessment.ts';
import { openWorkspaceAccess } from '../workspace-access.ts';
import { openWorkspaceTools } from '../workspace-agent.ts';
import { loadStudioTestModule } from './modules.ts';

it.skipIf(!testDatabaseUrl)('reopens whole exam evidence for the same recipient from PostgreSQL', () =>
  withLearnerDatabase(learner, async db => {
    const [activity, capture, content, plan] = await Promise.all(['activity', 'capture', 'content', 'plan'].map(loadStudioTestModule));
    const registry = new Map<string, VerifiedAssessmentPublicationEvidence>();
    const assessment = openWorkbookAssessment(db, {
      readVerifiedEvidence: ({releaseRef, itemId}) => registry.get(releaseRef.id + itemId),
      resolveAssessmentRoute: async id => ({id, reserve: async () => true, score: async ({answer}) =>
        ({state:'scored', earned:Number(answer), reportedModel:'local-fixture', feedback:'SECRET', quote:answer})}),
    });
    const workbook = openWorkbook(db, activity!, {assessment});
    const access = openWorkspaceAccess(db, activity!, content!, capture!, plan!);
    const material = await openLibrary(db, capture!, content!, plan!).capture({requestId:'pacing-source', title:'source', text:'SECRET'});
    const grant = (id: string, rev = 1) => access.setTeaching(id,{enabled:true,expectedRev:rev});
    const materialGrant = await grant(material.id);
    const address = {slotId:'answer',path:''};
    async function release(requestId: string, partial = false) {
      const ref = (key: string) => ({id:factId(stableId(requestId,key)),rev:1 as Revision});
      const paper = workbookDraft({title:'Exam', materialId:material.id, questions:['first','second'].map(id =>
        ({id,kind:'rubric',prompt:'Secret prompt ' + id,rubric:'SECRET'}))});
      const releaseRef = {...ref('paper'),id:factId(stableId('workbook-paper',requestId))};
      const draft = {items:paper.questions.slice(0,partial ? 1 : 2).map(({id},index) => ({itemId:id,promptRef:releaseRef,
        slots:[{slotId:'answer',schemaVersion:'v1',fields:[{kind:'text',path:''}]}],
        criteria:[{criterionId:'points',inputs:[address],evaluator:workbookTextEvaluator,maximum:2,
          missingEvidence:'insufficient-evidence',source:{kind:'product-rubric',path:`/questions/${index}/rubric`,ref:releaseRef},
          parameters:{routeId:'local-fixture@1'}}]}))};
      const published = prepareWorkbookRelease(draft,releaseRef.id,paper);
      for (const frozenItem of published.items) {
        const {itemId} = frozenItem, witnessRef = ref(itemId + '-witness');
        const cases = [['normal',2],['negative',0],['partial',1]] as const;
        const samples = cases.map(([kind, earned]) => {
          const sampleRef = ref(itemId + kind), submissionRef = ref(itemId + kind + '-submission');
          const result = {releaseRef,submissionRef,outcomes:[{itemId,criterionId:'points',state:'scored',earned,evidence:[address]}]};
          const submission = {releaseRef,submissionRef,answers:[{...address,itemId,schemaVersion:'v1',value:{kind:'text',value:String(earned)}}]};
          return {sample:{sampleRef,submission,expected:result},run:{state:'completed' as const,witnessRef,sampleRef,
            receiptRef:ref(itemId + kind + '-receipt'),actual:result,evaluators:[{criterionId:'points',evaluator:workbookTextEvaluator}]}};
        });
        registry.set(releaseRef.id + itemId,{witness:{ref:witnessRef,origin:'trusted-gold',releaseRef,frozenItem,
          requiredSampleRefs:samples.map(s=>s.sample.sampleRef),requiredCoverage:cases.map(([kind],i)=>
            ({kind,criterionId:'points',sampleRef:samples[i]!.sample.sampleRef}))},samples});
      }
      return workbook.save({...paper,requestId,assessmentRelease:draft});
    }
    const paper = await release('pacing-paper');
    const other = await release('pacing-other');
    const partial = await release('pacing-partial',true);
    async function submit(paperId: string, requestId: string, earned: string, effectiveDurationMs?: number) {
      const result = await workbook.submit(paperId,{requestId,answers:{q1:earned,q2:earned},
        assessmentConsent:'send-question-answer-rubric',effectiveDurationMs});
      return result.attempts.find(row => row.requestId === requestId)!;
    }
    const fast = await submit(paper.id,'pacing-faster','2',1200);
    const slow = await submit(paper.id,'pacing-slower','1',2500);
    const untimed = await submit(paper.id,'pacing-untimed','2');
    const different = await submit(other.id,'different-paper','2',100);
    const partialScore = await submit(partial.id,'partial-paper','2',100);
    await relayPending(db, ref => assessment.execute(ref));
    const unsettled = await submit(paper.id,'pacing-unsettled','2',500);
    await grant(paper.id); await grant(other.id); await grant(partial.id);
    for (const attempt of [fast,slow,untimed,different,partialScore,unsettled]) await grant(attempt.id);
    let denied: string | undefined;
    const maySend: WorkspaceSourceRecipient = fact => fact.ref.id !== denied;
    const turn = stableId('pacing-recipient'), authorize = async () => {}, track = () => {};
    const workspace = openWorkspaceTools({db,turn,prior:[],authorize,track,maySend});
    const host = openLearningTools({db,turn,workspace,authorize,track,maySend,manageBeliefs:false,trackRetention:track,
      authorizeRemote:async()=>true,readContext:async()=>undefined,draftBasis:()=>[],saveBelief:async()=>'',onDelivered:async()=>{}});
    const reads = pythonReads([{method:'evidence_slice',args:{exam_pacing:true}}]);
    expect(reads).toBeDefined();
    const load = (step: number) => host.preparePython!(reads!,step);
    const packet = await load(1);
    expect(packet.ok).toBe(true);
    if (!packet.ok) throw new Error(JSON.stringify(packet));
    const slice = packet.values[0] as CanonicalEvidenceSliceV1;
    const tags = (id: string) => slice.events.find(row => row.ref === id);
    const paper_key = JSON.stringify([paper.id,1]);
    expect(slice.events).toHaveLength(6);
    const scale = (id: string) => JSON.stringify(['workbook-formal-assessment@1',id,1]);
    expect(tags(fast.id)).toMatchObject({rev:2,occurred_at:fast.submittedAt,effective_duration_ms:1200,
      exam_pacing:{paper_key,scale_key:scale(paper.id),score:{earned:4,maximum:4}}});
    expect(tags(slow.id)).toMatchObject({effective_duration_ms:2500,exam_pacing:{paper_key,scale_key:scale(paper.id),score:{earned:2,maximum:4}}});
    expect(tags(different.id)).toMatchObject({exam_pacing:{paper_key:JSON.stringify([other.id,1]),scale_key:scale(other.id),score:{earned:4,maximum:4}}});
    expect(tags(unsettled.id)).toMatchObject({exam_pacing:{paper_key}});
    expect(tags(unsettled.id)).not.toHaveProperty('exam_pacing.score');
    expect(tags(partialScore.id)).not.toHaveProperty('exam_pacing.score');
    expect(tags(untimed.id)?.effective_duration_ms).toBeUndefined();
    expect(JSON.stringify(slice)).not.toMatch(/secret|rubric|learner/i);
    expect(await load(1)).toEqual(packet);
    denied = material.id;
    expect(await load(1)).toMatchObject({ok:false,code:'access_revoked'});
    expect(await load(2)).toMatchObject({ok:false,code:'not_found'});
    denied = undefined;
    const root = factId(material.id);
    await eraseOriginal(db,{learner},{actor:'learner',confirmed:true,requestId:commandId(stableId('pacing-erase')),root,
      expectedRev:materialGrant.rev as Revision},async()=>({ids:[root],commandTypes:[]}),async()=>{});
    expect(await load(1)).toMatchObject({ok:false,code:'access_revoked'});
    expect(await load(3)).toMatchObject({ok:false,code:'not_found'});
  }));
