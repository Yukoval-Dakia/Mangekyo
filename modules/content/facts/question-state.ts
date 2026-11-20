import { defineFact } from '@mangekyo/kernel';
import { parseQuestionState, questionStateType } from '../question-state.ts';

export default defineFact({ type: questionStateType, schema: { parse: parseQuestionState } });
