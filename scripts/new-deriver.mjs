import { mkdir, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: new-deriver <module> <name> [root] [--slot <slot-type>]\n'
  + '  <module>       existing module directory name under modules/\n'
  + '  <name>         deriver file name (lower-case words separated by hyphens)\n'
  + '  [root]         repository root (default: repository containing this script)\n'
  + '  --slot <type>  explicit slot type to attach the deriver to (default: <Module>.noteLength)\n';

const modulePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const deriverNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const slotTypePattern = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const safeTemplateValues = /^[a-zA-Z0-9.\/-]+$/;

const sourceRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

function camel(value) {
  const parts = value.split('-');
  return parts.map((part, index) => index === 0 ? part : part[0].toUpperCase() + part.slice(1)).join('');
}

function pascal(value) {
  const parts = value.split('-');
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

function assertSafeValues(moduleName, deriverName, slotType) {
  if (!modulePattern.test(moduleName)) {
    throw new Error(`Invalid module name '${moduleName}'. Use lower-case words separated by hyphens.`);
  }
  if (!deriverNamePattern.test(deriverName)) {
    throw new Error(`Invalid deriver name '${deriverName}'. Use lower-case words separated by hyphens.`);
  }
  if (!slotTypePattern.test(slotType)) {
    throw new Error(`Invalid slot type '${slotType}'. Use PascalCase dotted names such as 'Module.slot'.`);
  }
  if (moduleName.includes('..') || moduleName.includes('/') || moduleName.includes('\\')) {
    throw new Error(`Module name must not contain path separators or traversal: ${moduleName}`);
  }
  if (deriverName.includes('..') || deriverName.includes('/') || deriverName.includes('\\')) {
    throw new Error(`Deriver name must not contain path separators or traversal: ${deriverName}`);
  }
  for (const [value, label] of [
    [moduleName, 'module name'],
    [deriverName, 'deriver name'],
    [slotType, 'slot type'],
    [`${moduleName}/${deriverName}`, 'generated deriver name'],
    [pascal(deriverName), 'generated type name'],
  ]) {
    if (!safeTemplateValues.test(value)) {
      throw new Error(`Generated ${label} is unsafe for '${moduleName}/${deriverName}': ${value}`);
    }
  }
}

async function resolveRepositoryRoot(root, expectedRoot) {
  if (expectedRoot === undefined) return root;
  const [actualRoot, expectedCanonical] = await Promise.all([
    realpath(root),
    realpath(expectedRoot),
  ]);
  return actualRoot;
}

function render(template, values) {
  return template.replaceAll('{{MODULE}}', values.module)
    .replaceAll('{{DERIVER_NAME}}', values.deriverName)
    .replaceAll('{{DERIVER_TYPE}}', values.deriverType)
    .replaceAll('{{SLOT_TYPE}}', values.slotType)
    .replaceAll('{{PASCAL}}', values.pascal)
    .replaceAll('{{SLOT_FILE}}', values.slotFile);
}

const deriverTemplate = `import {
  defineDeriver,
  factId,
  type GatherContext,
  type GatherInput,
  type Outcome,
} from '@mangekyo/kernel';

type SlotKey = string;
type GatherData = { readonly bodyLength: number; readonly noteId: string };

async function gather(
  ctx: GatherContext,
  slotKey: SlotKey,
): Promise<GatherInput<GatherData>> {
  const snapshot = await ctx.read.fact<{ readonly body?: string }>(
    factId(slotKey),
    { mode: 'following' },
  );
  const bodyLength = typeof snapshot.value.body === 'string' ? snapshot.value.body.length : 0;
  return {
    kind: 'input',
    data: { bodyLength, noteId: slotKey },
    effects: [],
  };
}

function derive(input: GatherData): Outcome<number> {
  if (input.bodyLength <= 0) {
    return { kind: 'unknown', reason: 'note body is empty' };
  }
  return { kind: 'value', value: input.bodyLength };
}

export default defineDeriver<SlotKey, GatherData, number>({
  name: '{{DERIVER_TYPE}}',
  version: 'v1',
  slot: '{{SLOT_TYPE}}',
  gather,
  derive,
});
`;

const sampleTemplate = `import { expect, it } from 'vitest';
import deriver from '../derivers/{{DERIVER_NAME}}.ts';
import slot from '{{SLOT_FILE}}';
it('matches fixed input samples', async () => {
  const noteId = '01KFS4AAA00000000000000002';
  expect(slot.key({ noteId })).toBe(noteId);
  expect(await deriver.derive({ bodyLength: 4, noteId })).toEqual({ kind: 'value', value: 4 });
  expect((await deriver.derive({ bodyLength: 0, noteId })).kind).toBe('unknown');
});
`;

async function writeFileChecked(filename, content) {
  const file = await open(filename, 'wx');
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}

async function pathExists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readSlotTypes(moduleRoot) {
  const slotsDir = path.join(moduleRoot, 'slots');
  const entries = await readdirSafe(slotsDir);
  const types = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const filename = path.join(slotsDir, entry.name);
    const source = await readFile(filename, 'utf8');
    const match = source.match(/type:\s*['"]([^'"]+)['"]/);
    if (match) types.push({type:match[1],file:entry.name});
  }
  return types;
}

async function readdirSafe(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function generateDeriver(moduleName, deriverName, root = sourceRoot, slotType) {
  const resolvedRoot = await resolveRepositoryRoot(root, sourceRoot);
  const moduleRoot = path.join(resolvedRoot, 'modules', moduleName);
  const slotsDir = path.join(moduleRoot, 'slots');
  const deriversDir = path.join(moduleRoot, 'derivers');
  const samplesDir = path.join(moduleRoot, 'samples');

  if (!(await pathExists(moduleRoot))) {
    throw new Error(`Module '${moduleName}' does not exist at ${moduleRoot}`);
  }
  if (!(await pathExists(slotsDir))) {
    throw new Error(`Module '${moduleName}' has no slots directory at ${slotsDir}`);
  }

  const declaredSlots = await readSlotTypes(moduleRoot);
  const targetSlot = slotType ?? `${camel(moduleName)}.noteLength`;
  const slotDeclaration = declaredSlots.find(slot => slot.type === targetSlot);
  if (!slotDeclaration) {
    throw new Error(
      `Slot '${targetSlot}' is not declared in module '${moduleName}'. `
      + `Declared slots: ${declaredSlots.map(slot=>slot.type).join(', ') || '(none)'}`,
    );
  }

  assertSafeValues(moduleName, deriverName, targetSlot);

  const values = {
    module: moduleName,
    deriverName,
    deriverType: `${moduleName}/${deriverName}`,
    slotType: targetSlot,
    slotFile: `../slots/${slotDeclaration.file}`,
    pascal: pascal(deriverName),
  };

  const deriverFile = path.join(deriversDir, `${deriverName}.ts`);
  const sampleFile = path.join(samplesDir, `${deriverName}.test.ts`);

  if (await pathExists(deriverFile)) {
    throw new Error(`Deriver file already exists: ${deriverFile}`);
  }
  if (await pathExists(sampleFile)) {
    throw new Error(`Sample test already exists: ${sampleFile}`);
  }

  const created = [];
  try {
    await mkdir(path.dirname(deriversDir), { recursive: true });
    await mkdir(deriversDir, { recursive: true });
    await mkdir(samplesDir, { recursive: true });
    await writeFileChecked(deriverFile, render(deriverTemplate, values));
    created.push(deriverFile);
    await writeFileChecked(sampleFile, render(sampleTemplate, values));
    created.push(sampleFile);
  } catch (error) {
    for (const file of created.reverse()) {
      try {
        const info = await stat(file);
        if (info.isDirectory()) await rm(file, { recursive: true });
        else await rm(file);
      } catch {
        // best-effort cleanup; original error is more useful
      }
    }
    throw error;
  }

  return { moduleRoot, deriverFile, sampleFile, created };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    process.stderr.write(usage);
    process.exit(1);
  }

  let root;
  let slotType;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--slot') {
      slotType = args[index + 1];
      index += 1;
      if (slotType === undefined) {
        process.stderr.write(usage);
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage);
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length < 2 || positional.length > 3) {
    process.stderr.write(usage);
    process.exit(1);
  }

  const [moduleName, deriverName, rootArg] = positional;
  root = rootArg ? path.resolve(rootArg) : sourceRoot;
  const result = await generateDeriver(moduleName, deriverName, root, slotType);
  process.stdout.write(`Created deriver '${moduleName}/${deriverName}' for slot '${slotType ?? `${camel(moduleName)}.noteLength`}'\n`);
  process.stdout.write(`  ${path.relative(result.moduleRoot, result.deriverFile)}\n`);
  process.stdout.write(`  ${path.relative(result.moduleRoot, result.sampleFile)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
