import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadTriageFixtures, scoreTriageFixtures } from './fixtures.ts';
const file = new URL('./fixtures.json', import.meta.url);
const fixtures = loadTriageFixtures(JSON.parse(await readFile(file, 'utf8')));
const summary = scoreTriageFixtures(fixtures);
const compact = {
  ...summary,
  results: summary.results.map(({ id, ok, classification, issues }) => ({ id, ok, classification, issues })),
};
console.log(JSON.stringify(compact, null, 2));
process.exitCode = 0;
