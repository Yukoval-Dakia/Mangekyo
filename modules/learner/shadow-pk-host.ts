import type { ReadTransaction } from '@mangekyo/kernel';
import { evaluateShadowCalibrationPk, evaluateShadowCalibrationPkFromCases, type RetentionReplaySummary, type ShadowCalibrationPkReport } from './shadow-calibration-pk.ts';

/**
 * Read-only host projection for the shadow-calibration PK. It never writes, never flips the active model
 * and always stays inside `memoryLayerBoundary: 'read_only_proposal'`.
 */

export type ShadowComparisonGet = (key: string) => Promise<{
  readonly state: string; readonly value?: unknown;
}>;

const insufficient = (): ShadowCalibrationPkReport => evaluateShadowCalibrationPkFromCases([]);

/**
 * Read the newest completed, still-valid shadow comparison through the caller-injected authorized reader
 * (which already revalidates the frozen manifest), and evaluate its calibration PK. When no usable
 * comparison exists, the honest answer is `insufficient_sample` with the read-only boundary marker.
 */
export async function readShadowCalibrationPk(
  tx: ReadTransaction, slotType: string, readComparison: ShadowComparisonGet,
): Promise<ShadowCalibrationPkReport> {
  const { rows } = await tx.query<{ slot_key: string }>(
    `SELECT slot_key FROM slot_state WHERE learner_id=$1 AND slot_type=$2 ORDER BY changed_tick DESC LIMIT 8`,
    [tx.learner, slotType]);
  for (const { slot_key } of rows) {
    let comparison;
    try { comparison = await readComparison(slot_key); }
    catch { continue; }
    if (comparison?.state !== 'complete' || comparison.value === undefined || comparison.value === null) continue;
    try { return evaluateShadowCalibrationPk(comparison.value as RetentionReplaySummary); }
    catch { continue; }
  }
  return insufficient();
}
