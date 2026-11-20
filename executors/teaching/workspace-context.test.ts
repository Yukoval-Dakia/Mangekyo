import { expect, it } from 'vitest';
import { projectWorkspaceContext, type StudyMessage } from './workspace-context.ts';
import {studyToolResults} from './study-tool-results.ts';

it('bounds large Python and Exa results while keeping tool pairs and the newest result', () => {
  const call = (name: string) => ({ id: name, type: 'function' as const, function: { name, arguments: '{}' } });
  const results = studyToolResults(), previews = new WeakMap();
  const result = (name: string, output: string, step: number) => {
    const {content, preview} = results.publish(name, step, output, []);
    const message = {role:'tool' as const, tool_call_id:name, content};
    previews.set(message, preview);
    return message;
  };
  const user = { role: 'user', content: '核对作答' } as const;
  const earlier = { role: 'assistant', tool_calls: [call('python'), call('exa_search')], content: null,
    providerTurn: { protocol: 'anthropic', content: [{ type: 'thinking', signature: 'fixture' }] } } satisfies StudyMessage;
  const current = { role: 'assistant', tool_calls: [call('read_workspace')], content: null } satisfies StudyMessage;
  const large = 'text read '.repeat(1150);
  const latest = result('read_workspace', large, 5);
  const messages = [user, earlier, result('python', large, 1), result('exa_search', large, 2), current, latest];
  const projected = projectWorkspaceContext([{...user, content:'u'.repeat(22000)}, ...messages.slice(1)], previews);
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(48 * 1024);
  expect(projected.slice(1)).toMatchObject([earlier, { tool_call_id: 'python' }, { tool_call_id: 'exa_search' }, current, latest]);
  expect(projected[1]).toBe(earlier);
  const {handle} = JSON.parse(projected[2]!.content!);
  expect(JSON.parse(messages[2]!.content!).text).toBe(large);
  expect(handle).toMatch(/^@calc_/);
  expect(results.pythonInputs([handle]).inputs?.[handle]).toBe(large);
  expect(JSON.parse(studyToolResults().open({handle}).content).code).toBe('not_found');
});
