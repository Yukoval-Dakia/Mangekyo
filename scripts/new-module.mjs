import { mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: new-module <name> [root]\n'
  + '  <name>   lower-case module name\n'
  + '  [root]   repository root (default: repository containing this script)\n';
const modulePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const safeTemplateValues = /^[a-zA-Z0-9-]+$/;

const sourceRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

function camel(value) {
  const parts = value.split('-');
  return parts.map((part, index) => index === 0 ? part : part[0].toUpperCase() + part.slice(1)).join('');
}

function pascal(value) {
  const parts = value.split('-');
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

function assertSafeValues(moduleName, root) {
  if (!modulePattern.test(moduleName)) {
    throw new Error(`Invalid module name '${moduleName}'. Use lower-case words separated by hyphens.`);
  }
  if (moduleName.includes('..') || moduleName.includes('/') || moduleName.includes('\\')) {
    throw new Error(`Module name must not contain path separators or traversal: ${moduleName}`);
  }
  const typePrefix = camel(moduleName);
  if (!/^[a-z][a-zA-Z0-9]*$/.test(typePrefix)) {
    throw new Error(`Generated type prefix is unsafe for '${moduleName}': ${typePrefix}`);
  }
  if (!path.isAbsolute(root) || path.basename(root) === '' || root === path.parse(root).root) {
    throw new Error(`Repository root must be a non-root absolute path: ${root}`);
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
  return template.replaceAll('{{NAME}}', values.name)
    .replaceAll('{{PASCAL}}', values.pascal)
    .replaceAll('{{TYPE_PREFIX}}', values.typePrefix)
    .replaceAll('{{TYPE}}', values.type)
    .replaceAll('{{COMMAND_TYPE}}', values.commandType)
    .replaceAll('{{DERIVER_NAME}}', values.deriverName);
}

const templates = {
  'package.json': `{
  "name": "@mangekyo/module-{{NAME}}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./module.ts",
    "./facts/*": "./facts/*.ts",
    "./slots/*": "./slots/*.ts"
  },
  "dependencies": {
    "@mangekyo/kernel": "workspace:*"
  }
}
`,
  'module.ts': `import { defineModule } from '@mangekyo/kernel';

export default defineModule({ name: '{{NAME}}' });
`,
  'facts/note.ts': `import { defineFact, isJson, type Json, type JsonObject } from '@mangekyo/kernel';

export type Note = {
  readonly body: string;
  readonly createdAt?: string;
};

const stringValue = (value: Json | undefined): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

function parseNote(value: unknown): Note {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('note must be an object');
  }
  const candidate = value as JsonObject;
  if (!isJson(candidate)) throw new Error('note must contain JSON values');

  const body = stringValue(candidate.body);
  if (body === undefined) throw new Error('note.body must be a non-empty string');

  const createdAt = candidate.createdAt;
  if (createdAt !== undefined) {
    const valueAsString = stringValue(createdAt);
    if (valueAsString === undefined || Number.isNaN(Date.parse(valueAsString))) {
      throw new Error('note.createdAt must be a parseable date string');
    }
  }

  return {
    body,
    ...(candidate.createdAt === undefined ? {} : { createdAt: stringValue(candidate.createdAt)! }),
  };
}

export default defineFact<Note>({
  type: '{{TYPE_PREFIX}}.note',
  schema: { parse: parseNote },
  correctableFields: (note) => note.createdAt === undefined ? [] : ['/createdAt'],
});
`,
  'commands/record-note.ts': `import {
  defineCommand,
  factId,
  isJson,
  type FactWrite,
  type JsonObject,
} from '@mangekyo/kernel';

const COMMAND_TYPE = '{{COMMAND_TYPE}}';

function parseInput(value: unknown): { readonly noteId: string; readonly body: string; readonly createdAt?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('record-note input must be an object');
  }
  const candidate = value as JsonObject;
  if (!isJson(candidate)) throw new Error('record-note input must contain JSON values');

  const noteId = candidate.noteId;
  const body = candidate.body;
  const createdAt = candidate.createdAt;
  if (typeof noteId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(noteId)) {
    throw new Error('record-note input.noteId must be a ULID');
  }
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('record-note input.body must be a non-empty string');
  }
  if (createdAt !== undefined && (typeof createdAt !== 'string' || createdAt.length === 0)) {
    throw new Error('record-note input.createdAt must be a non-empty string');
  }

  return {
    noteId,
    body,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

export default defineCommand({
  type: COMMAND_TYPE,
  schema: { parse: parseInput },
  destructive: false,
  write: (_ctx, input): readonly FactWrite[] => [{
    kind: 'create',
    id: factId(input.noteId),
    factType: '{{TYPE_PREFIX}}.note',
    data: {
      body: input.body,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    },
  }],
});
`,
  'slots/length.ts': `import { defineSlot } from '@mangekyo/kernel';

export default defineSlot({
  type: '{{TYPE}}',
  key: ({ noteId }: { readonly noteId: string }) => noteId,
  triggers: [{ kind: 'fact', factType: '{{TYPE_PREFIX}}.note' }],
  policy: 'eager',
});
`,
  'derivers/count-note.ts': `import {
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
  name: '{{DERIVER_NAME}}',
  version: 'v1',
  slot: '{{TYPE}}',
  gather,
  derive,
});
`,
  'samples/module.test.ts': `import { expect, it } from 'vitest';
import deriver from '../derivers/count-note.ts';
import slot from '../slots/length.ts';
it('matches fixed input samples', async () => {
  const noteId = '01KFS4AAA00000000000000002';
  expect(slot.key({ noteId })).toBe(noteId);
  expect(await deriver.derive({ bodyLength: 3, noteId })).toEqual({ kind: 'value', value: 3 });
  expect((await deriver.derive({ bodyLength: 0, noteId })).kind).toBe('unknown');
});
`,
};

async function writeFileChecked(filename, content) {
  const file = await open(filename, 'wx');
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}

async function createDirectoryChecked(directory) {
  await mkdir(directory);
}

export async function generateModule(moduleName, root = sourceRoot) {
  const resolvedRoot = await resolveRepositoryRoot(root, sourceRoot);
  assertSafeValues(moduleName, resolvedRoot);

  const typePrefix = camel(moduleName);
  const values = {
    name: moduleName,
    pascal: typePrefix,
    typePrefix,
    type: `${typePrefix}.noteLength`,
    commandType: `${typePrefix}.recordNote`,
    deriverName: `${moduleName}/count-note`,
  };

  const moduleRoot = path.join(resolvedRoot, 'modules', moduleName);
  const files = [
    ['AGENTS.md', '# '+moduleName+'\n\n- 本模块只拥有自己的事实；经 kernel 声明命令和推导器。\n- 修改行为前读根 docs/implementation-contract.md；样例在 samples/。\n- 跨模块只导入公开 facts/slots 类型，执行环境能力留给 kernel。\n- 验收以具体输入和期望输出为准，样例模式不代表真实学习旅程。\n'],
    ['package.json', render(templates['package.json'], values)],
    ['module.ts', render(templates['module.ts'], values)],
    ['facts/note.ts', render(templates['facts/note.ts'], values)],
    ['commands/record-note.ts', render(templates['commands/record-note.ts'], values)],
    ['slots/length.ts', render(templates['slots/length.ts'], values)],
    ['derivers/count-note.ts', render(templates['derivers/count-note.ts'], values)],
    ['samples/module.test.ts', render(templates['samples/module.test.ts'], values)],
  ];

  const created = [];
  try {
    await mkdir(path.dirname(moduleRoot), { recursive: true });
    await createDirectoryChecked(moduleRoot);
    created.push(moduleRoot);
    for (const [relative, content] of files) {
      const target = path.join(moduleRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFileChecked(target, content);
      created.push(target);
    }
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

  return { moduleRoot, files: created };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(usage);
    process.exit(args.length === 0 || args.includes('--help') || args.includes('-h') ? 0 : 1);
  }
  const [moduleName, root] = args;
  const result = await generateModule(moduleName, root ? path.resolve(root) : sourceRoot);
  process.stdout.write(`Created module '${moduleName}' at ${result.moduleRoot}\n`);
  for (const file of result.files.slice(1)) {
    process.stdout.write(`  ${path.relative(result.moduleRoot, file)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
