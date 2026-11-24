import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { classroomCommand, classroomType } from '../classroom.ts';
import { prepareClassroom } from '../classroom-command-read.ts';
import { object } from '../values.ts';

export default defineCommand({
  type: classroomCommand, destructive: false,
  schema: {parse(input) {
    const {id} = object(input);
    if (typeof id !== 'string') throw new Error('课堂标识无效。');
    return factId(id);
  }},
  async write(ctx, id): Promise<readonly FactWrite[]> {
    const {state, expectedRev, turn} = await prepareClassroom(ctx.read,id);
    const writes: FactWrite[] = [expectedRev === undefined
      ? {kind:'create', id, factType:classroomType, data:state, purpose:['teaching']}
      : {kind:'correct', id, expectedRev, data:state}];
    if (turn) writes.push({kind:'create', id:turn.id, factType:'activity.studyTurn', data:turn.data, purpose:['teaching']});
    return writes;
  },
});
