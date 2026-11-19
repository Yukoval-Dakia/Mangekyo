import { factId, type Revision } from '../../../kernel/src/declarations/ids.ts';
import { sentenceBreakRelease } from '../../../modules/activity/sentence-break-assessment.ts';
import { artifactAssessmentDigest, type ReadArtifactAssessmentWitness } from '../artifact-assessment.ts';
import { stableId } from '../identity.ts';

// A fixed synthetic review. The generation fixture independently supplies its proposed rules.
// Only the exact reviewed work can obtain these manual expectations.
const reviewedDigest = '73e19df0777a1da2e881f3e3a74ff7c93e1f113068edfe815cba5eaa7a55e585';
const reviewedSolutions = [['gap-2', 'gap-4'], ['gap-4', 'gap-6']];
const cases = [
  { kind: 'normal', ids: ['gap-2', 'gap-4'], earned: 100 },
  { kind: 'alternative', ids: ['gap-6', 'gap-4'], earned: 100 },
  { kind: 'partial', ids: ['gap-2', 'gap-4', 'gap-6'], earned: 66 },
  { kind: 'negative', ids: [], earned: null },
] as const;

export const readArtifactAssessmentWitness: ReadArtifactAssessmentWitness = ({ releaseRef }, view, predictionPrompt) => {
  if (view.id !== 'work-' + releaseRef.id.toLowerCase() ||
      artifactAssessmentDigest({ ...view, id: 'fixture-passage' }, predictionPrompt) !== reviewedDigest) return null;
  const ref = (name: string) => ({ id: factId(stableId('trusted-artifact-fixture', releaseRef.id, name)), rev: 1 as Revision });
  const release = sentenceBreakRelease(releaseRef, 'hand-in', 'breakpoints', ['gap-2', 'gap-4', 'gap-6', 'gap-8'],
    artifactAssessmentDigest(view, predictionPrompt), reviewedSolutions);
  const item = release.items[0]!;
  const criterion = item.criteria[0]!;
  const samples = cases.map(({ kind, ids, earned }) => {
    const submissionRef = ref('submission-' + kind);
    return {
      sampleRef: ref('sample-' + kind),
      submission: { releaseRef, submissionRef, answers: ids.length ? [{
        itemId: item.itemId, slotId: 'breakpoints', path: '', schemaVersion: 'sentence-breaks-v1',
        value: { kind: 'structured', value: { kind: 'selection', ids } },
      }] : [] },
      expected: { releaseRef, submissionRef, outcomes: [{
        itemId: item.itemId, criterionId: criterion.criterionId, ...(earned === null
          ? { state: 'unsubmitted', reason: '未交断点。' }
          : { state: 'scored', earned, evidence: [{ slotId: 'breakpoints', path: '' }] }),
      }] },
    };
  });
  return {
    witness: { ref: ref('witness'), origin: 'trusted-gold', releaseRef, frozenItem: item,
      requiredSampleRefs: samples.map(({ sampleRef }) => sampleRef),
      requiredCoverage: cases.map(({ kind }, index) => ({ kind, criterionId: criterion.criterionId, sampleRef: samples[index]!.sampleRef })),
    },
    samples,
  };
};
