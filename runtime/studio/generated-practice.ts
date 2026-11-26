import { parsePracticeAdmission, PracticeAdmissionError, resolvePracticeAdmission } from '../../modules/content/generated-practice.ts';
import { RequestError } from './sessions.ts';

export { parsePracticeAdmission };
const map = async <T>(run: () => Promise<T>) => { try { return await run(); } catch (error) { if (error instanceof PracticeAdmissionError) throw new RequestError(error.status, error.message); throw error; } };
export const resolveStudioPracticeAdmission = (...args: Parameters<typeof resolvePracticeAdmission>) => map(() => resolvePracticeAdmission(...args));
