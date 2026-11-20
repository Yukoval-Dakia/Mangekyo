import { isDeepStrictEqual } from 'node:util';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { Revision, Tick } from '../../kernel/src/declarations/ids.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { researchPurpose } from '../../modules/companion/research.ts';
import type { ForegroundDigest } from './foreground-digest.ts';
import { confirmedTeachingMethod, methodName, purpose, slotType } from './identity.ts';
import { researchReader, whenAvailable } from './research-sources.ts';

const acceptedForeground = `FROM slot_state s JOIN derivations d
    ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.current_id)
  JOIN facts t ON (t.learner_id,t.id)=(s.learner_id,s.slot_key)
  WHERE s.learner_id=$1 AND s.slot_type=$2 AND d.deriver=$3 AND d.lifecycle='effective'
    AND NOT d.is_shadow AND d.invalidated_tick IS NULL AND d.selection_ended_tick IS NULL
    AND d.effective_tick >= d.gather_tick AND d.value ? 'foregroundDigest'
    AND t.type='activity.studyTurn' AND $4=ANY(t.purpose) AND t.retracted_rev IS NULL`;
const foregroundLimit = 4;

export const companionTeachingMethods = [methodName, confirmedTeachingMethod];

export const completedCompanionTurns = `SELECT s.slot_key AS id, d.effective_tick
  FROM slot_state s JOIN derivations d
    ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.last_id)
  WHERE s.learner_id=$1 AND s.slot_type=$2 AND d.deriver=ANY($3::text[]) AND NOT d.is_shadow
    AND d.effective_tick>=d.gather_tick AND d.value->>'action'='companion_reply'`;

export async function newResearchWatermark(tx: ReadTransaction) {
  const { rows: [row] } = await tx.query<{ observed: Tick; reviewed: Tick }>(
    `SELECT GREATEST(
       COALESCE((SELECT max(changed_tick) FROM facts WHERE learner_id=$1),0),
       COALESCE((SELECT max(done.effective_tick) FROM (${completedCompanionTurns}) done
         JOIN facts f ON (f.learner_id,f.id)=($1,done.id)
         WHERE f.type='activity.studyTurn' AND f.retracted_rev IS NULL AND $4=ANY(f.purpose)),0)
     )::text AS observed,
     COALESCE((SELECT fact_tick FROM working_todo_watermarks WHERE learner_id=$1),0)::text AS reviewed`,
    [tx.learner, slotType, companionTeachingMethods, researchPurpose],
  );
  return row && BigInt(row.observed) > BigInt(row.reviewed) ? row : null;
}

export async function readResearchForeground(tx: ReadTransaction, reviewed: Tick) {
  const { rows } = await tx.query<{ id: string; turn_id: string; digest: ForegroundDigest | null; manifest: unknown }>(
    `SELECT d.id, d.slot_key AS turn_id, d.value->'foregroundDigest' AS digest, d.manifest
     ${acceptedForeground} AND d.effective_tick>$5::bigint ORDER BY d.effective_tick DESC,d.id LIMIT $6`,
    [tx.learner, slotType, methodName, researchPurpose, reviewed, foregroundLimit + 1],
  );
  const read = researchReader(tx);
  const events = [];
  for (const row of rows.slice(0, foregroundLimit)) {
    const { digest } = row;
    if (digest?.id !== row.turn_id || digest.kind !== 'companion_completed' ||
        typeof digest.summary !== 'string' || !digest.summary.trim() || digest.summary.length > 160 ||
        !Array.isArray(digest.sourceRefs)) continue;
    let manifest;
    try {
      manifest = parseManifest(row.manifest);
    } catch {
      continue;
    }
    const inputs = manifest.inputs.filter(input => input.kind === 'fact');
    const turn = inputs.find(input => input.id === row.turn_id && input.mode === 'following');
    if (manifest.purpose !== purpose || inputs.length !== manifest.inputs.length || !turn ||
        !digest.sourceRefs.some(ref => isDeepStrictEqual(ref, turn)) ||
        !digest.sourceRefs.every(ref => inputs.some(input => isDeepStrictEqual(ref, input))) ||
        (await revalidateManifest(tx, manifest)).kind !== 'valid') continue;
    const authorized = await whenAvailable(async () => {
      for (const input of inputs) {
        const current = await read.fact(input.id, { mode: 'following' });
        if (current.accessEpoch !== input.accessEpoch || !current.purpose.includes(researchPurpose)) return false;
        const fact = input.mode === 'pinned' && current.ref.rev !== input.rev
          ? await read.fact(input.id, { mode: 'pinned', rev: input.rev as Revision }) : current;
        if (fact.ref.rev !== input.rev || !fact.purpose.includes(researchPurpose)) return false;
        if (fact.type === 'activity.studyTurn') {
          const submission = studyTurn(fact.value);
          if (submission.allowBackgroundUnderstanding || (input === turn && submission.workspaceRevision)) return false;
        }
      }
      return true;
    });
    if (authorized) events.push({ event_id: row.id, kind: digest.kind, fact_ref: turn.id, fact_rev: turn.rev,
      payload: { digest: digest.summary, source_refs: digest.sourceRefs.slice(0, foregroundLimit), source_count: digest.sourceRefs.length } });
  }
  return { events: events.reverse(), coverage: rows.length === 0 ? 'empty' : events.length === 0 ? 'unavailable' :
    events.length < rows.length ? 'partial' : 'available' };
}
