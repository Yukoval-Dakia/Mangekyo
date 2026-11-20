import { defineFact } from '@mangekyo/kernel';
import { classroomFact, classroomType } from '../classroom.ts';

export default defineFact({type:classroomType,schema:{parse:classroomFact}});
