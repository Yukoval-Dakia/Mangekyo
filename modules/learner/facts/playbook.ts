import { defineFact } from '@mangekyo/kernel';
import { playbook, playbookType } from '../playbook.ts';

export default defineFact({type: playbookType, schema: {parse: playbook}});
