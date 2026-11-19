import { defineFact } from '@mangekyo/kernel';
import { workspaceEntry, workspaceEntryType, type WorkspaceEntry } from '../workspace-values.ts';

export default defineFact<WorkspaceEntry>({
  type: workspaceEntryType,
  schema: { parse: workspaceEntry },
  correctableFields: () => ['/title', '/body', '/tags', '/links', '/answer', '/rubric', '/basis'],
});
