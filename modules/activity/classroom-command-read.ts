import type { FactId, ReadContext, Revision } from '@mangekyo/kernel';
import type { Classroom } from './classroom.ts';
import type { studyTurn } from './values.ts';

type Prepared = {state: Classroom; expectedRev?: Revision; turn?: {id: FactId; data: ReturnType<typeof studyTurn>}};
const classroomPreparation = Symbol('classroomPreparation');

export function bindClassroomPreparation(base: ReadContext, prepare: (id: FactId) => Promise<Prepared>) {
  return Object.assign(base, {[classroomPreparation]:prepare});
}

export function prepareClassroom(read: ReadContext, id: FactId) {
  const prepare = (read as ReadContext & {[classroomPreparation]?: (id: FactId) => Promise<Prepared>})[classroomPreparation];
  if (!prepare) throw new Error('课堂命令须由正式宿主准备。');
  return prepare(id);
}
