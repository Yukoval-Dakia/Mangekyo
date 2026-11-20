import { defineFact } from '@mangekyo/kernel';
import { knowledgeNameType, parseKnowledgeName } from '../knowledge-entity.ts';

export default defineFact({ type: knowledgeNameType, schema: { parse: parseKnowledgeName } });
