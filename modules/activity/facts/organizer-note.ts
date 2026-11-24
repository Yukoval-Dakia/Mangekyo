import { defineFact } from '@mangekyo/kernel';
import { organizerNote, organizerNoteType, type OrganizerNote } from '../organizer-values.ts';

export default defineFact<OrganizerNote>({
  type: organizerNoteType, schema: { parse: organizerNote },
  correctableFields: () => ['/title', '/markdown', '/source'],
});
