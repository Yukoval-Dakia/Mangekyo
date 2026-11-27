import type { Db, ReadTransaction } from '../../kernel/src/index.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import { gatherExamPacingSlice, verifyExamPacingSlice, type ExamPacingSliceDeps } from '../../modules/activity/exam-pacing-slice.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import {
  classifyStudyMethodHostError, loadStudyMethodLibrary, saveStudyMethodTemplate, studyMethodTemplateOwnerId,
  undoStudyMethodTemplate,
} from '../../modules/companion/study-method-host.ts';
import { listSatisfiedShadowComparisonKeys, readShadowCalibrationPkFromKeys } from '../../modules/learner/shadow-pk-host.ts';
import { runExamPacingHostReview, type ExamPacingDeriver } from '../../modules/plan/exam-pacing-host.ts';
import type { RoutePack } from './endpoint-kit.ts';
import { studioHost, studioLearner, ulidExact } from './identity.ts';
import { createNotionReader, notionReadScope, NotionReadUnconfirmed, type CheckNotionRead } from './notion.ts';
import { retentionComparisonWork } from './retention-comparison.ts';
import { isPracticeWorkbook } from './sealed-practice.ts';
import { RequestError } from './sessions.ts';
import { readWorkbookAssessment } from './workbook-assessment.ts';

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
    if (error instanceof NotionReadUnconfirmed) throw new RequestError(503, '暂时无法核对 Notion 来源，请稍后重试。');
    const mapped = classifyStudyMethodHostError(error);
    if (mapped) throw new RequestError(mapped.status, mapped.message, mapped.code);
    throw error;
  };
  const readOnly = <T>(run: (tx: ReadTransaction, check: CheckNotionRead) => Promise<T>) =>
    notionReadScope(db, studioLearner, { readOnly: true }).read(run).catch(translateError);
  const lockedWrite = <T>(raw: Record<string, unknown>, req: { headers?: Record<string, unknown> },
    run: (tx: never, body: Record<string, unknown>) => Promise<T>) => {
    const { deletionWatermark, ...body } = raw;
    if (deletionWatermark !== undefined && typeof deletionWatermark !== 'string')
      throw new RequestError(400, '删除水位格式无效。');
    const wm = typeof req.headers?.['x-deletion-watermark'] === 'string' ? req.headers['x-deletion-watermark']
      : deletionWatermark;
    return host.lockedTx(async tx => {
      if (wm !== undefined) await assertDeletionWatermark(tx, wm);
      return run(tx as never, body);
    }).catch(translateError);
  };
  const pacingDeps = (tx: ReadTransaction, check: CheckNotionRead): ExamPacingSliceDeps => ({
    read: createNotionReader(tx, { purpose: storagePurpose, check, remoteOnly: true }),
    isPracticeWorkbook,
    readFormal: (inner, release, ref, epochs) =>
      readWorkbookAssessment(inner, release, ref, { ...epochs, purpose: storagePurpose }),
  });

  return kit => {
    kit.get('/api/study-method-templates', () => readOnly(async tx =>
      ({ templates: (await loadStudyMethodLibrary(tx, owner)).templates })));

    kit.post('/api/study-method-templates', (raw, _p, req) =>
      lockedWrite(raw, req, (tx, body) => saveStudyMethodTemplate(tx, owner, body)));

    kit.post('/api/study-method-templates/undo', (raw, _p, req) =>
      lockedWrite(raw, req, (tx, body) => undoStudyMethodTemplate(tx, owner, body)));

    kit.get('/api/retention/shadow-pk', async () => {
      const keys = await host.snapshot(tx => listSatisfiedShadowComparisonKeys(tx, retentionComparisonWork));
      return readShadowCalibrationPkFromKeys(keys, key => deps.retentionComparison.get(key));
    });

    kit.get('/api/papers/exam-pacing', (_params, url) => {
      const rawPaper = url.searchParams.get('paperId');
      if (rawPaper !== null && rawPaper !== '' && !ulidExact.test(rawPaper))
        throw new RequestError(400, '试卷标识无效。');
      const paperId = rawPaper === null || rawPaper === '' ? undefined : rawPaper;
      return runExamPacingHostReview({
        gather: () => readOnly((tx, check) => gatherExamPacingSlice(tx, pacingDeps(tx, check), paperId)),
        verify: gathered => readOnly((tx, check) => verifyExamPacingSlice(tx, pacingDeps(tx, check), gathered)),
        ...(deps.pythonHost === undefined ? {} : { derive: deps.pythonHost.derive }),
      });
    });
  };
}
