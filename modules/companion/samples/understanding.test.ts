import { describe, expect, it } from 'vitest';
import { claimRef } from '../claim.ts';
import { extractedUnderstanding, extractUnderstandings, reviewUnderstanding, understandingPresentation } from '../understanding.ts';

const ref = claimRef({id: '01ARZ3NDEKTSV4RRFFQ69G5FB3', rev: 1, accessEpoch: '0'});
const source = {ref, kind: 'attempt', fragments: [{anchor: 'area', text: '6 + 4 = 10'}]};
const at = Date.parse('2026-11-20T08:00:00.000Z');
const entry = {target: null, kind: 'state', text: '今天计算时容易中断', scope: {kind:'general'},
  ttl: '2026-11-20T09:00:00.000Z',
  evidence_refs: [{...ref, anchor:'area', excerpt:'6 + 4', direction:'support'}]};
const parse = (data: object) => extractUnderstandings(JSON.stringify({entries:[data]}), source, at);

describe('post-activity understanding', () => {
  it('bounds a short state and validates exact activity citations', () => {
    expect(parse(entry)[0]?.data.ttl).toBe(entry.ttl);
    for (const ttl of [null, '2026-11-20T08:00:00.000Z', '2026-11-21T08:00:00.001Z']) {
      expect(() => parse({...entry, ttl})).toThrow();
    }
    for (const citation of [{rev: 2}, {accessEpoch:'1'}, {anchor:'other'}, {excerpt:'6 × 4'}]) {
      expect(() => parse({...entry, evidence_refs:[{...entry.evidence_refs[0],...citation}]})).toThrow();
    }
    expect(() => parse({...entry, stable:true})).toThrow();
  });

  it('keeps unsupported stable labels weak even after a learner edit', () => {
    const draft = parse({...entry, kind:'playbook', ttl:null})[0]!.data;
    const value = extractedUnderstanding({...draft, version:2, sticky:true, undo_token:ref.id});
    expect(understandingPresentation(value, [source])).toBe('observation');
    expect(reviewUnderstanding(ref.id, value, [source])).toMatchObject({
      kind:'value', value:{outcome:{kind:'unresolved'}},
    });
  });
});
