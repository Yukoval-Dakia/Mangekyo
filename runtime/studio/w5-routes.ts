import type { Db, ReadTransaction } from '../../kernel/src/index.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import {
  classifyStudyMethodHostError, loadStudyMethodLibrary, saveStudyMethodTemplate, studyMethodTemplateOwnerId,
  undoStudyMethodTemplate,
} from '../../modules/activity/study-method-host.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { readShadowCalibrationPk } from '../../modules/learner/shadow-pk-host.ts';
import { projectExamPacingHostReview, type ExamPacingDeriver } from '../../modules/plan/exam-pacing-host.ts';
import type { RoutePack } from './endpoint-kit.ts';
import { studioHost, studioLearner, ulidExact } from './identity.ts';
import { notionReadScope } from './notion.ts';
import { retentionComparisonWork } from './retention-comparison.ts';
import { RequestError } from './sessions.ts';

/** W5 thin host routes: study-method template library/undo, shadow-calibration PK and exam-pacing reads. */
export function w5RoutePack(
  db: Db,
  deps: {
    readonly pythonHost?: { derive: ExamPacingDeriver };
    readonly retentionComparison: { get: (key: string) => Promise<{ state: string; value?: unknown }> };
    readonly assessmentSlotType: string;
  },
): RoutePack {
  const host = studioHost(db), owner = studyMethodTemplateOwnerId;
  const translateError = (error: unknown): never => {
    const mapped = classifyStudyMethodHostError(error);
    if (mapped) throw new RequestError(mapped.status, mapped.message, mapped.code);
    throw error;
  };
  const readOnly = <T>(run: (tx: ReadTransaction) => Promise<T>) =>
    notionReadScope(db, studioLearner, { readOnly: true }).read(tx => run(tx)).catch(translateError);
  const lockedWrite = <T>(watermark: string, run: (tx: never) => Promise<T>) =>
    host.lockedTx(async tx => { await assertDeletionWatermark(tx, watermark); return run(tx as never); }).catch(translateError);

  return kit => {
    kit.get('/api/study-method-templates', () => readOnly(async tx =>
      ({ templates: (await loadStudyMethodLibrary(tx, owner)).templates })));

    kit.offline('/api/study-method-templates', (raw, watermark) =>
      lockedWrite(watermark, tx => saveStudyMethodTemplate(tx, owner, raw)));

    kit.offline('/api/study-method-templates/undo', (raw, watermark) =>
      lockedWrite(watermark, tx => undoStudyMethodTemplate(tx, owner, raw)));

    kit.get('/api/retention/shadow-pk', () => readOnly(async tx =>
      readShadowCalibrationPk(tx, retentionComparisonWork, key => deps.retentionComparison.get(key))));

    kit.get('/api/papers/exam-pacing', (_params, url) => {
      const rawPaper = url.searchParams.get('paperId');
      if (rawPaper !== null && rawPaper !== '' && !ulidExact.test(rawPaper))
        throw new RequestError(400, '试卷标识无效。');
      return readOnly(async tx => projectExamPacingHostReview(tx, {
        attemptType: workbookAttemptType, assessmentSlotType: deps.assessmentSlotType,
        ...(deps.pythonHost === undefined ? {} : { derive: deps.pythonHost.derive }),
      }, rawPaper === null || rawPaper === '' ? undefined : rawPaper));
    });
  };
}
