import { expect, it } from 'vitest';
import deriver from '../derivers/memory-review.ts';
import slot from '../slots/memory-review.ts';
import { reviewMemoryEvidence, type MemoryReviewEvidence } from '../memory-review.ts';
const scope={subject:'migration',activity:'variant-practice',conditions:['independent']};
const assertion={id:'assert-migration',text:'A 独立列式迁移',scope};
const wa={factId:'fact-a',revision:1,accessEpoch:'7',authorRole:'learner' as const,sourceVersion:'v1'};
const wb={factId:'fact-b',revision:2,accessEpoch:'7',authorRole:'companion' as const,sourceVersion:'v2'};
const ev=(id:string,d:'support'|'contradict'|'unresolved',h:boolean|'unknown',x:Partial<MemoryReviewEvidence>={}):MemoryReviewEvidence=>({eventId:id,assertionId:assertion.id,witness:d==='support'?wa:wb,scope,occurredAt:'2026-11-19T01:00:00.000Z',recordedAt:'2026-11-19T01:01:00.000Z',help:{exposed:h,order:h==='unknown'?'unknown':h?'before_submission':'after_submission'},submissionOrder:1,direction:d,...x});
const run=(evidence:MemoryReviewEvidence[])=>reviewMemoryEvidence({requestId:'r',assertion,evidence});
it('dedupes retellings and separates independent from assisted support',()=>{const r=run([ev('a','support',false),ev('00-summary','contradict',true,{originGroupId:'a'}),ev('b','support',true)]);expect(r.kind).toBe('value');if(r.kind!=='value')return;expect(r.value.outcome).toEqual({kind:'supported',basis:'mixed'});expect(r.value.sources.filter(s=>s.duplicateOf!==null)).toHaveLength(1);expect(r.value.findings.supporting[0]?.eventIds).toEqual(['a','b']);});
it('keeps same-condition conflict and unknown help without model confidence',()=>{const r=run([ev('a','support','unknown'),ev('b','contradict',false)]);expect(r.kind).toBe('value');if(r.kind!=='value')return;expect(r.value.outcome.kind).toBe('unresolved');expect(r.value.findings.supporting).toHaveLength(1);expect(r.value.findings.contradicting).toHaveLength(1);});
it('lets condition-scoped evidence coexist and keeps upstream witness identity',()=>{const r=run([ev('i','support',false),ev('w','contradict',true,{scope:{subject:'migration',activity:'variant-practice'},witness:{...wb,revision:3,accessEpoch:'8',sourceVersion:'v3'}})]);expect(r.kind).toBe('value');if(r.kind!=='value')return;expect(r.value.outcome).toEqual({kind:'supported',basis:'independent'});expect(r.value.sources.find(s=>s.witness.factId==='fact-b')?.witness).toMatchObject({revision:3,accessEpoch:'8'});expect(r.value.findings.unresolved.some(x=>x.reason.includes('范围相容'))).toBe(true);});
it('slot and deriver expose the public declarations',async()=>{expect(slot.type).toBe('companion.memoryReview');expect(slot.key({requestId:'r'})).toBe('r');expect((await deriver.derive({request:{requestId:'r',assertion,evidence:[ev('a','support',false)]}})).kind).toBe('value');});
it('waits for the original source or established help timing', () => {
  const missingOrigin = run([ev('summary', 'support', false, { originGroupId: 'original' })]);
  const lateHelp = run([ev('a', 'support', true, { help: { exposed: true, order: 'after_submission' } })]);
  for (const result of [missingOrigin, lateHelp]) {
    expect(result.kind).toBe('value');
    if (result.kind === 'value') expect(result.value.outcome).toEqual({ kind: 'unresolved' });
  }
});
