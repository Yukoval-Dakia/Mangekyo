import { defineFact } from '@mangekyo/kernel';
import { practiceCustody, practiceCustodyType } from '../sealed-practice.ts';

export default defineFact({ type:practiceCustodyType, schema:{parse:practiceCustody} });
