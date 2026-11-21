import { factId, type DerivationSnapshot, type FactId, type ReadContext, type Revision, type Playbook as KernelPlaybook } from '@mangekyo/kernel';
import { interventionLiftKey, interventionLiftType } from './intervention-lift.ts';
import { allows, integer, openWitness, record, text, witnessList, type Witness } from './memory-evidence.ts';
import { preSubmitRevisionWitness } from './pre-submit-process.ts';
import { weeklyLiftCutoff, weeklyLiftExpiry } from './weekly-lift.ts';

export const playbookType = 'learner.playbook';
export const understandingStatusType = 'learner.understandingStatus';
export const liftType = interventionLiftType;
export const retirePlaybookCommand = 'learner.retirePlaybook';

function steps(value: unknown, empty = false): string[] {
  if (!Array.isArray(value) || value.length > 32 || (!empty && !value.length)) throw new Error('策略需要结构化步骤和条件。');
  return value.map(item => text(item));
}

export function playbook(value: unknown) {
  const input = record(value);
  const fields = ['version', 'strategyId', 'preconditions', 'strategy_steps', 'counterexamples',
    'exit_conditions', 'reflection'];
  if (Object.keys(input).some(field => !fields.includes(field))) throw new Error('反思提案含未知字段。');
  const reflection = record(input.reflection);
  return {
    version: integer(input.version, 1), strategyId: text(input.strategyId, 160),
    preconditions: steps(input.preconditions), strategy_steps: steps(input.strategy_steps),
    counterexamples: steps(input.counterexamples, true), exit_conditions: steps(input.exit_conditions),
    reflection: {rationale: text(reflection.rationale), metric: text(reflection.metric),
      evidence_refs: witnessList(reflection.evidence_refs)},
  } satisfies KernelPlaybook<string, string> & {strategyId: string; reflection: {rationale: string; metric: string; evidence_refs: Witness[]}};
}
export type Playbook = ReturnType<typeof playbook>;

// Raw activity witnesses support a proposal. A proposal or a consolidated
// assertion cannot serve as the original experience for another proposal.
const experienceSources = new Set(['activity.studyTurn', 'activity.workbookAttempt',
  'activity.retentionPosttestSubmission', 'activity.artifactAction', 'activity.organizerNote',
  'content.textbookPage', 'activity.intakeDocument', 'companion.retentionReviewPermission']);

export async function openReflection(read: ReadContext, candidate: Playbook) {
  let teaching = true;
  const preSubmitRevised: Witness[] = [];
  for (const ref of candidate.reflection.evidence_refs) {
    const fact = await openWitness(read, ref, 'background-research');
    if (!experienceSources.has(fact.type)) throw new Error('反思须引用已获准的原始活动。');
    teaching &&= allows(fact.purpose, 'teaching');
    const revision = preSubmitRevisionWitness(fact, 'background-research');
    if (revision) preSubmitRevised.push(revision);
  }
  return {teaching, ...(preSubmitRevised.length ? {process: {preSubmitRevised}} : {})};
}

export function proposalInput(value: unknown) {
  const input = record(value);
  return {id: factId(text(input.id, 26)), data: playbook(input.data),
    expectedRev: input.expectedRev === undefined ? null : integer(input.expectedRev, 1) as Revision};
}

export type PlaybookStatus = {
  playbookId: string; version: number; strategyId: string; status: 'candidate' | 'verified' | 'demoted';
  reason: string; liftId: string | null; verificationRefs: Witness[]; expiresAt?: string;
  process?: {preSubmitRevised: Witness[]};
};

export function readPlaybookLift(read: ReadContext, learner: DerivationSnapshot<unknown>['slot']['learner'],
  id: FactId, proposal: Playbook) {
  return read.slot({learner, type: liftType, key: interventionLiftKey(id, proposal.version)}, {mode: 'following'});
}

export function playbookGardeningProposal(id: FactId, expectedRev: Revision, status: PlaybookStatus) {
  if (status.status !== 'demoted' || status.liftId === null) return null;
  return {
    light: 'yellow' as const,
    dedupKey: `retire-playbook/${id}/${expectedRev}/${status.liftId}`,
    command: {type: retirePlaybookCommand, input: {id, expectedRev, version: status.version, liftId: status.liftId}},
  };
}
export function verifiedStatus(playbookId: string, proposal: Playbook,
  lift: DerivationSnapshot<unknown>, at = new Date().toISOString()): PlaybookStatus {
  const base = {playbookId, version: proposal.version, strategyId: proposal.strategyId, liftId: lift.id};
  const candidate = (reason: string): PlaybookStatus => ({...base, status: 'candidate', reason, verificationRefs: []});
  if (lift.slot.type !== liftType || lift.slot.key !== interventionLiftKey(playbookId, proposal.version))
    return candidate('策略核验槽不匹配。');
  if (lift.outcome.kind === 'unknown') return candidate(lift.outcome.reason);
  const result = record(lift.outcome.value);
  if (result.playbookId !== playbookId || result.version !== proposal.version || result.strategyId !== proposal.strategyId)
    return candidate('核验针对另一策略或版本。');
  const asOf = result.asOf;
  if (asOf !== undefined && asOf !== weeklyLiftCutoff(at)) return candidate('策略的周核验已失效。');
  if (result.verdict === 'inconclusive') return candidate('独立后测尚不足以判断效果。');
  if (result.verdict !== 'positive' && result.verdict !== 'negative') throw new Error('核验结果无效。');
  const verificationRefs = witnessList(result.verificationRefs);
  return {...base, ...(typeof asOf === 'string' ? {expiresAt: weeklyLiftExpiry(asOf)} : {}), status: result.verdict === 'positive' ? 'verified' : 'demoted',
    reason: result.verdict === 'positive' ? '独立后测正 Lift。' : '独立后测负 Lift，停止推荐。', verificationRefs};
}

// The host binds this reader to one learner, the teaching purpose, the actual
// recipient and current slot selection, and revalidates the basis before send.
export async function readVerifiedPlaybook(read: ReadContext, ref: Witness, at?: string) {
  const fact = await openWitness(read, ref, 'teaching');
  if (fact.type !== playbookType) throw new Error('引用未指向策略。');
  const proposal = playbook(fact.value);
  const basis = await openReflection(read, proposal);
  if (!basis.teaching) return null;
  const current = await read.slot<PlaybookStatus>({learner: fact.ref.learner, type: understandingStatusType,
    key: ref.id}, {mode: 'following'});
  if (current.slot.learner !== fact.ref.learner || current.slot.type !== understandingStatusType ||
      current.slot.key !== ref.id || current.outcome.kind !== 'value') return null;
  const checked = current.outcome.value;
  if (checked.status !== 'verified' || checked.playbookId !== ref.id || checked.version !== proposal.version ||
      checked.strategyId !== proposal.strategyId || !checked.liftId) return null;
  const lift = await readPlaybookLift(read, fact.ref.learner, ref.id, proposal);
  const verified = verifiedStatus(ref.id, proposal, lift, at);
  if (lift.slot.learner !== fact.ref.learner || lift.id !== checked.liftId || verified.status !== 'verified') return null;
  const verificationRefs = verified.verificationRefs;
  for (const verification of verificationRefs) {
    await openWitness(read, verification, 'teaching');
  }
  return {proposal, status: verified, statusId: current.id,
    basis: [ref, ...proposal.reflection.evidence_refs, ...verificationRefs]};
}
