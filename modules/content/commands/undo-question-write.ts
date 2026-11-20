import { defineCommand } from '@mangekyo/kernel';
import { parseQuestionUndo, undoQuestion, undoQuestionCommand } from '../question-writes.ts';

export default defineCommand({
  type: undoQuestionCommand, destructive: true, schema: { parse: parseQuestionUndo },
  write: undoQuestion,
});
