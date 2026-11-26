import { promises as fs } from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import { expect, it } from 'vitest';
import { checkStructure } from './check-structure.mjs';

const check = async files => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mangekyo-structure-')); try { for (const [name, text] of Object.entries(files)) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); } return await checkStructure(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); } };
it('enforces executable packing, web boundaries, and file size', async () => {
  expect((await check({ 'kernel/a.ts': 'a(); b(); c();' })).ok).toBe(false);
  expect((await check({ 'kernel/a.ts': 'for (let i = 0; i < 3; i++) {}\na(); b();' })).ok).toBe(true);
  expect((await check({ 'surfaces/web/src/a.ts': "import { factId } from '@mangekyo/kernel'; import { x } from '../../../modules/x';" })).ok).toBe(false);
  expect((await check({ 'surfaces/web/src/a.ts': "import type { BankAnswerRowWire } from '@mangekyo/kernel'; import { type BankAnswerRowWire as Row } from '@mangekyo/kernel';" })).ok).toBe(true);
  expect((await check({ 'surfaces/web/src/a.ts': Array(1651).fill('x').join('\n') })).ok).toBe(false);
});
