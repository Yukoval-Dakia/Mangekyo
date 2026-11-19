import { defineDeriver, type GatherContext, type GatherInput, type Json, type Outcome } from '@mangekyo/kernel';
import { memoryReviewDeriverName, memoryReviewDeriverVersion, memoryReviewRequest, memoryReviewSlotType, reviewMemoryEvidence, type MemoryReviewResult } from '../memory-review.ts';

type SlotKey = { readonly requestId: string; readonly request: unknown };
type GatherData = { readonly request: Json };
const gather = async (_ctx: GatherContext, slotKey: SlotKey): Promise<GatherInput<GatherData>> => ({ kind: 'input', data: { request: slotKey.request as Json }, effects: [] });
const derive = (input: GatherData): Outcome<MemoryReviewResult> => reviewMemoryEvidence(memoryReviewRequest(input.request));

export default defineDeriver<SlotKey, GatherData, MemoryReviewResult>({ name: memoryReviewDeriverName, version: memoryReviewDeriverVersion, slot: memoryReviewSlotType, gather, derive });
