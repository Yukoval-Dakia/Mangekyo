import { defineCommand } from '@mangekyo/kernel';
import { evolveGraph, evolveGraphCommand, parseGraphEvolution } from '../graph-evolution.ts';

export default defineCommand({
  type: evolveGraphCommand,
  destructive: true,
  schema: { parse: parseGraphEvolution },
  write: evolveGraph,
});
