import { expect, it } from 'vitest';
import { projectWorkspaceContext, type StudyMessage } from './workspace-context.ts';

it('bounds large Python and Exa results while keeping tool pairs and the newest result', () => {
  const call = (name: string) => ({ id: name, type: 'function' as const, function: { name, arguments: '{}' } });
  const result = (name: string, content: string) => ({ role: 'tool' as const, tool_call_id: name, content });
  const user = { role: 'user', content: '核对作答' } as const;
  const earlier = { role: 'assistant', tool_calls: [call('python'), call('exa_search')], content: null,
    providerTurn: { protocol: 'anthropic', content: [{ type: 'thinking', signature: 'fixture' }] } } satisfies StudyMessage;
  const current = { role: 'assistant', tool_calls: [call('read_workspace')], content: null } satisfies StudyMessage;
  const large = '已核对'.repeat(4000);
  const latest = result('read_workspace', large);
  const messages = [user, earlier, result('python', large), result('exa_search', large), current, latest];
  const projected = projectWorkspaceContext(messages);
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(48 * 1024);
  expect(projected).toMatchObject([user, earlier, { tool_call_id: 'python' }, { tool_call_id: 'exa_search' }, current, latest]);
  expect(projected[1]).toBe(earlier);
  expect(messages[2]?.content).toBe(large);
  expect(projectWorkspaceContext([user])).toEqual([user]);
});
