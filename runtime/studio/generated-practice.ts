import { parsePracticeAdmission, PracticeAdmissionError, resolvePracticeAdmission } from '../../modules/content/generated-practice.ts';
import { RequestError } from './sessions.ts';
export { parsePracticeAdmission };
export const resolveStudioPracticeAdmission = (...args: Parameters<typeof resolvePracticeAdmission>) =>
  resolvePracticeAdmission(...args).catch((error: unknown) => {
    if (error instanceof PracticeAdmissionError) throw new RequestError(error.status, error.message);
    throw error;
  });
