import { defineFact } from '@mangekyo/kernel';
import { organizerTask, organizerTaskType, type OrganizerTask } from '../organizer-values.ts';

export default defineFact<OrganizerTask>({
  type: organizerTaskType,
  schema: { parse: organizerTask },
  correctableFields: () => ['/title', '/date', '/done'],
});
