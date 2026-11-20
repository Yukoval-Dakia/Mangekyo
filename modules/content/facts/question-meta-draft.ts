import { defineFact } from '@mangekyo/kernel';
import { parseQuestionMetaDraft, questionMetaDraftType } from '../question-state.ts';

export default defineFact({ type: questionMetaDraftType, schema: { parse: parseQuestionMetaDraft } });
