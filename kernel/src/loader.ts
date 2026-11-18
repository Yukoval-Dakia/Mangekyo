import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { declarationOf, type ModuleDefinition } from './declarations/define.ts';

export type LoadedModule = {
  readonly definition: ModuleDefinition;
  readonly facts: ReadonlyMap<string, Record<string, unknown>>;
  readonly slots: ReadonlyMap<string, Record<string, unknown>>;
  readonly commands: ReadonlyMap<string, Record<string, unknown>>;
  readonly derivers: ReadonlyMap<string, Record<string, unknown>>;
};

export type ImportModuleFile = (filename: string) => Promise<unknown>;

async function importFile(filename: string): Promise<unknown> {
  return import(pathToFileURL(filename).href);
}

function defaultExport(exports: unknown, filename: string): unknown {
  if (typeof exports !== 'object' || exports === null || !('default' in exports)) {
    throw new Error(`${filename} must have one default declaration export`);
  }
  const keys = Object.keys(exports);
  if (keys.some((key) => key !== 'default')) {
    throw new Error(`${filename} must not export named declarations`);
  }
  return exports.default;
}

async function declarations(
  directory: string,
  kind: 'fact' | 'slot' | 'command' | 'deriver',
  importModule: ImportModuleFile,
): Promise<Record<string, unknown>[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => entry.name)
    .sort();
  const loaded: Record<string, unknown>[] = [];
  for (const file of files) {
    const filename = path.join(directory, file);
    loaded.push(declarationOf(defaultExport(await importModule(filename), filename), kind));
  }
  return loaded;
}

function index(declarations: Record<string, unknown>[], label: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const declaration of declarations) {
    const key = label === 'deriver name' ? declaration.name : declaration.type;
    if (typeof key !== 'string') throw new Error(`${label} has no public name`);
    if (result.has(key)) throw new Error(`Duplicate ${label}: ${key}`);
    result.set(key, declaration);
  }
  return result;
}

export async function loadModuleDirectory(
  directory: string,
  importModule: ImportModuleFile = importFile,
): Promise<LoadedModule> {
  const moduleFile = path.join(directory, 'module.ts');
  const definition = declarationOf(
    defaultExport(await importModule(moduleFile), moduleFile),
    'module',
  ) as unknown as ModuleDefinition;
  const facts = await declarations(path.join(directory, 'facts'), 'fact', importModule);
  const slots = await declarations(path.join(directory, 'slots'), 'slot', importModule);
  const commands = await declarations(path.join(directory, 'commands'), 'command', importModule);
  const derivers = await declarations(path.join(directory, 'derivers'), 'deriver', importModule);
  for (const deriver of derivers) {
    const slot = deriver.slot;
    if (typeof slot !== 'string' || !slots.some((candidate) => candidate.type === slot)) {
      throw new Error(`Deriver ${String(deriver.name)} references an undeclared slot`);
    }
  }
  return {
    definition,
    facts: index(facts, 'fact type'),
    slots: index(slots, 'slot type'),
    commands: index(commands, 'command type'),
    derivers: index(derivers, 'deriver name'),
  };
}
