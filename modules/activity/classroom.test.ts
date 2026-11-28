import { describe, expect, it } from 'vitest';
import { classroomPrompt, classroomStart, seedClassroom } from './classroom.ts';
import { factId } from '@mangekyo/kernel';

describe('classroom prompt', () => {
  it('keeps visual mounts separate from formal checks', () => {
    const state = seedClassroom(classroomStart({ topic: '比例', minutes: 20 }), factId('01K00000000000000000000000'));
    const prompt = classroomPrompt('start', state);
    expect(prompt).toContain('只挂载可调的视觉直觉图解或参数对照实验');
    expect(prompt).not.toContain('先作预测再揭示的随堂检查');
  });
});
