import type { ReadTransaction } from '@mangekyo/kernel';
import {
  evaluateShadowCalibrationPk, evaluateShadowCalibrationPkFromCases,
  type RetentionReplaySummary, type ShadowCalibrationPkReport,
} from './shadow-calibration-pk.ts';

/**
 * Read-only host projection for the shadow-calibration PK. Candidate keys are fetched in a short
 * snapshot (filtered to `work.state = 'satisfied'`), then evaluated outside that DB transaction via
 * the authorized comparison reader so there are never nested connections or pool deadlocks.
 */

export type ShadowComparisonGet = (key: string) => Promise<{
  readonly state: string; readonly value?: unknown;
}>;

const insufficient = (): ShadowCalibrationPkReport => evaluateShadowCalibrationPkFromCases([]);

/** List newest satisfied shadow comparison keys so pending/failed rows cannot starve older valid runs. */
export async function listSatisfiedShadowComparisonKeys(
  tx: ReadTransaction, slotType: string, limit = 64,
): Promise<readonly string[]> {
  const { rows } = await tx.query<{ slot_key: string }>(
    `SELECT s.slot_key FROM slot_state s
       JOIN work w ON (w.learner_id,w.slot_type,w.slot_key)=(s.learner_id,s.slot_type,s.slot_key)
      WHERE s.learner_id=$1 AND s.slot_type=$2 AND w.state='satisfied'
      ORDER BY s.changed_tick DESC LIMIT $3`,
    [tx.learner, slotType, limit]);
  return rows.map(row => row.slot_key);
}

/** Evaluate the newest still-valid shadow comparison without holding an outer DB transaction open. */
export async function readShadowCalibrationPkFromKeys(
  keys: readonly string[], readComparison: ShadowComparisonGet,
): Promise<ShadowCalibrationPkReport> {
  for (const key of keys) {
    let comparison;
    try { comparison = await readComparison(key); }
    catch { continue; }
    if (comparison?.state !== 'complete' || comparison.value === undefined || comparison.value === null) continue;
    try { return evaluateShadowCalibrationPk(comparison.value as RetentionReplaySummary); }
    catch { continue; }
  }
  return insufficient();
}
