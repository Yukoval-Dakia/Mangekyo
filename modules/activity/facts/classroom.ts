import { defineFact, isJson } from '@mangekyo/kernel';
import { classroomType, type Classroom } from '../classroom.ts';
import { object } from '../values.ts';

export default defineFact<Classroom>({
  type: classroomType,
  schema: {
    parse(input) {
      const state = object(input);
      if (!isJson(state) || typeof state.topic !== 'string' || typeof state.minutes !== 'number' ||
          typeof state.sessionId !== 'string' || !Array.isArray(state.steps) || !Array.isArray(state.plans) ||
          (state.status !== 'active' && state.status !== 'finished' && state.status !== 'archived'))
        throw new Error('课堂状态无效。');
      return state as Classroom;
    },
  },
});
