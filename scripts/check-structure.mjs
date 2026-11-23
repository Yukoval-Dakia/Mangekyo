#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MAX_SOURCE_LINES = 15_000;
const MAX_RUNTIME_LINES = 11_000;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const TEST_FILE_PATTERN = /(?:^|[./_-])(?:test|spec|tests|specs)(?:[./_-]|$)|\.d\.ts$/i;
const TEST_DIR_PATTERN = /(?:^|[./_-])(?:test|tests|spec|specs|__tests__|fixtures)(?:[./_-]|$)/i;
const GENERATED_DIR_PATTERN = /(?:^|[./_-])(?:dist|build|out|coverage|node_modules)(?:[./_-]|$)|\.min\.[cm]?[jt]sx?$/i;
const KERNEL_PACKAGE = '@mangekyo/kernel';

function isTestOrGeneratedPath(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  return TEST_FILE_PATTERN.test(normalized) || TEST_DIR_PATTERN.test(normalized) || GENERATED_DIR_PATTERN.test(normalized);
}

function isSourceFile(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext) && !isTestOrGeneratedPath(relPath);
}

async function listSourceFiles(dir, baseDir = dir) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return results;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results.push(...await listSourceFiles(fullPath, baseDir));
    } else if (entry.isFile() && isSourceFile(path.relative(baseDir, fullPath))) {
      results.push(fullPath);
    }
  }
  return results;
}

async function readPackageName(dir) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    return typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : null;
  } catch {
    return null;
  }
}

async function workspacePackageNames(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
  const names = await Promise.all(entries.filter(entry => entry.isDirectory())
    .map(entry => readPackageName(path.join(dir, entry.name))));
  return new Set(names.filter(Boolean));
}

function scriptKindFor(filePath) {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

// Returns { specifiers: string[], dynamicUnknown: number } for one source file.
// import('expr') / require(expr) with a non-literal argument is counted in
// dynamicUnknown so module callers can fail closed.
function scanSpecifiers(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const specifiers = [];
  let dynamicUnknown = 0;
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec) {
        const text = literalText(spec);
        if (text === null) dynamicUnknown += 1;
        else specifiers.push(text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        const text = literalText(ref.expression);
        if (text === null) dynamicUnknown += 1;
        else specifiers.push(text);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const firstArg = node.arguments[0];
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) {
        const text = firstArg ? literalText(firstArg) : null;
        if (text === null) dynamicUnknown += 1;
        else specifiers.push(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { specifiers, dynamicUnknown };
}

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function subpathOf(specifier, packageName) {
  return specifier === packageName ? '' : specifier.slice(packageName.length + 1);
}

function isForbiddenRuntimePattern(node) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const target = node.expression.getText();
    const member = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
    if (member === 'env' && (target === 'process' || target === 'globalThis.process' || target === 'global.process')) return 'process.env';
    if (member === 'fetch' && ['globalThis', 'global', 'window', 'self'].includes(target)) return 'global fetch';
    if (member === 'argv' && (target === 'process' || target === 'globalThis.process' || target === 'global.process')) return 'process.argv';
    if (member === 'sendBeacon' && target === 'navigator') return 'navigator.sendBeacon';
    if (member === 'cookie' && target === 'document') return 'document.cookie';
    if (member === 'localStorage' || member === 'sessionStorage' || member === 'indexedDB') {
      if (['globalThis', 'global', 'window', 'self'].includes(target)) return `global ${member}`;
    }
  }
  if (ts.isIdentifier(node)) {
    if (['XMLHttpRequest', 'WebSocket', 'EventSource'].includes(node.text)) return node.text;
    if (node.text === 'fetch' || node.text === 'localStorage' || node.text === 'sessionStorage' || node.text === 'indexedDB') return node.text;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'fetch') return 'fetch()';
  }
  return null;
}

// Module-only runtime boundary: environment reads, network globals, storage.
// Property names inside string literals or comments are not AST nodes, so
// they cannot trigger this. `ctx.fetch` style member calls on non-global
// receivers are ignored; only bare/global receivers match.
function findForbiddenRuntimeAccess(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
  const violations = [];
  const visit = node => {
    const hit = isForbiddenRuntimePattern(node);
    if (hit) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(`${filePath}:${line + 1}: forbidden runtime access "${hit}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function lineCount(source) {
  if (source.length === 0) return 0;
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

export async function checkStructure(root) {
  const rootDir = path.resolve(root);
  const violations = [];
  const stats = { kernelFiles: 0, moduleFiles: 0, executorFiles: 0, runtimeFiles: 0, runtimeLines: 0 };

  const kernelDir = path.join(rootDir, 'kernel');
  const modulesDir = path.join(rootDir, 'modules');
  const executorsDir = path.join(rootDir, 'executors');
  const runtimeDir = path.join(rootDir, 'runtime');
  const [runtimeNames, surfaceNames] = await Promise.all([
    workspacePackageNames(runtimeDir),
    workspacePackageNames(path.join(rootDir, 'surfaces')),
  ]);

  const kernelPackageName = await readPackageName(kernelDir);
  const kernelNames = new Set([KERNEL_PACKAGE, kernelPackageName].filter(Boolean));

  const moduleDirs = [];
  try {
    for (const entry of await fs.readdir(modulesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) moduleDirs.push({ dir: path.join(modulesDir, entry.name), name: entry.name });
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const modulePackages = new Map();
  for (const { dir, name } of moduleDirs) {
    const packageName = await readPackageName(dir);
    modulePackages.set(name, packageName);
  }
  const modulePackageNames = new Map();
  for (const [dirName, packageName] of modulePackages) {
    if (packageName) modulePackageNames.set(packageName, dirName);
  }

  const executorDirs = [];
  try {
    for (const entry of await fs.readdir(executorsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) executorDirs.push({ dir: path.join(executorsDir, entry.name), name: entry.name });
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const executorPackages = new Map();
  for (const { dir, name } of executorDirs) {
    const packageName = await readPackageName(dir);
    executorPackages.set(name, packageName);
  }
  const executorPackageNames = new Map();
  for (const [dirName, packageName] of executorPackages) {
    if (packageName) executorPackageNames.set(packageName, dirName);
  }

  const groups = [];
  try {
    await fs.access(kernelDir);
    groups.push({ dir: kernelDir, kind: 'kernel', label: 'kernel/' });
  } catch { /* kernel absent */ }
  for (const { dir, name } of moduleDirs) groups.push({ dir, kind: 'module', label: `modules/${name}/`, packageName: modulePackages.get(name) });
  for (const { dir, name } of executorDirs) groups.push({ dir, kind: 'executor', label: `executors/${name}/`, packageName: executorPackages.get(name) });

  groups.push({ dir: runtimeDir, kind: 'runtime', label: 'runtime/' });

  for (const group of groups) {
    const files = await listSourceFiles(group.dir);
    let totalLines = 0;
    for (const file of files) {
      const relToRoot = path.relative(rootDir, file).split(path.sep).join('/');
      const source = await fs.readFile(file, 'utf8');
      const lines = lineCount(source);
      totalLines += lines;
      stats[`${group.kind}Files`] += 1;
      if (lines > MAX_SOURCE_LINES) {
        violations.push(`${relToRoot}: ${lines} lines exceeds ${MAX_SOURCE_LINES} line limit`);
      }
      const { specifiers, dynamicUnknown } = scanSpecifiers(file, source);
      if (group.kind === 'module' && dynamicUnknown > 0) {
        violations.push(`${relToRoot}: ${dynamicUnknown} dynamic import/require call(s) with non-literal specifier; modules must use static literal specifiers`);
      }
      if (group.kind === 'module') {
        for (const v of findForbiddenRuntimeAccess(relToRoot, source)) violations.push(v);
      }
      for (const spec of specifiers) {
        const error = checkImport({
          kind: group.kind,
          specifier: spec,
          fromFile: file,
          rootDir,
          groupDir: group.dir,
          groupPackageName: group.packageName,
          kernelNames,
          modulePackageNames,
          executorPackageNames,
          runtimeNames,
          surfaceNames,
        });
        if (error) violations.push(`${relToRoot}: ${error}`);
      }
    }
    if (group.kind === 'runtime') stats.runtimeLines = totalLines;
    const limit = group.kind === 'runtime' ? MAX_RUNTIME_LINES : MAX_SOURCE_LINES;
    if (totalLines > limit) {
      violations.push(`${group.label}total ${totalLines} lines exceeds ${limit} line limit`);
    }
  }

  return { ok: violations.length === 0, violations, stats };
}

function checkImport({ kind, specifier, fromFile, rootDir, groupDir, groupPackageName, kernelNames, modulePackageNames, executorPackageNames, runtimeNames, surfaceNames }) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
  if (isRelative) {
    const resolved = path.resolve(path.dirname(fromFile), specifier);
    const relToRoot = path.relative(rootDir, resolved);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      return `relative import escapes repository root: "${specifier}"`;
    }
    const relParts = relToRoot.split(path.sep).join('/').split('/');
    if (relParts[0] === 'runtime' && kind !== 'runtime') {
      return `${kind} must not depend on runtime; got "${specifier}"`;
    }
    if (kind === 'runtime' && ((relParts[0] === 'surfaces' && relParts[1] !== 'shared') ||
        ['scripts', 'docs'].includes(relParts[0]))) {
      return `runtime may only compose production packages and shared presentation; got "${specifier}"`;
    }
    if (kind === 'module') {
      const insideOwn = groupDir && resolved.startsWith(groupDir + path.sep);
      if (insideOwn) return null;
      if (relParts[0] === 'kernel') {
        return `module must import kernel via package specifier "${KERNEL_PACKAGE}"; got relative "${specifier}"`;
      }
      if (relParts[0] === 'modules' && relParts.length >= 3) {
        return `module must not use relative imports across module boundaries; use the target module's package "./facts/*" or "./slots/*" export instead: "${specifier}"`;
      }
      if (relParts[0] === 'modules') {
        return `module relative import must stay inside its own package or target another module's package exports: "${specifier}"`;
      }
      if (['executors', 'surfaces', 'scripts', 'docs'].includes(relParts[0])) {
        return `module may not depend on "${relParts[0]}"; got "${specifier}"`;
      }
      return `module relative import must stay inside its own package; got "${specifier}"`;
    }
    if (kind === 'kernel') {
      if (relParts[0] === 'modules' || relParts[0] === 'executors' || relParts[0] === 'surfaces') {
        return `kernel must not depend on modules, executors, or surfaces; got "${specifier}"`;
      }
      return null;
    }
    if (kind === 'executor') {
      const insideOwn = groupDir && resolved.startsWith(groupDir + path.sep);
      if (insideOwn) return null;
      if (relParts[0] === 'modules' || relParts[0] === 'executors' || relParts[0] === 'surfaces') {
        return `executors may only depend on kernel; got "${specifier}"`;
      }
      return `executor relative import must stay inside its own package; got "${specifier}"`;
    }
    return null;
  }

  const packageName = packageNameOf(specifier);
  const subpath = subpathOf(specifier, packageName);
  if (kind !== 'runtime' && runtimeNames.has(packageName)) {
    return `${kind} must not depend on runtime; got "${specifier}"`;
  }
  if (kind === 'runtime' && surfaceNames.has(packageName)) {
    return `runtime must not depend on a surface package; got "${specifier}"`;
  }
  if (kind === 'module') {
    if (kernelNames.has(packageName)) {
      if (subpath !== '') {
        return `module may only import kernel package root "${KERNEL_PACKAGE}"; got "${specifier}"`;
      }
      return null;
    }
    const targetDir = modulePackageNames.get(packageName);
    if (targetDir !== undefined) {
      if (subpath === '' || (!subpath.startsWith('facts/') && !subpath.startsWith('slots/'))) {
        return `module may only import other modules' "./facts/*" or "./slots/*" exports; got "${specifier}"`;
      }
      return null;
    }
    return `module may only depend on "${KERNEL_PACKAGE}" and other modules' facts/slots exports; got "${specifier}"`;
  }
  if (kind === 'kernel') {
    if (modulePackageNames.has(packageName) || executorPackageNames.has(packageName) || packageName.startsWith('@mangekyo/module-') || packageName.startsWith('@mangekyo/executor-')) {
      return `kernel must not depend on modules or executors; got "${specifier}"`;
    }
    return null;
  }
  if (kind === 'executor') {
    if (kernelNames.has(packageName) && subpath === '') return null;
    if (modulePackageNames.has(packageName) || packageName.startsWith('@mangekyo/module-')) {
      return `executors may only depend on kernel; got "${specifier}"`;
    }
    return null;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const root = args[0] ? path.resolve(args[0]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await checkStructure(root);
  if (result.ok) {
    console.log(`check-structure: OK (${result.stats.kernelFiles} kernel files, ${result.stats.moduleFiles} module files, ${result.stats.executorFiles} executor files, ${result.stats.runtimeFiles} runtime files / ${result.stats.runtimeLines} lines)`);
    process.exit(0);
  }
  console.error('check-structure: FAIL');
  for (const violation of result.violations) console.error(`  ${violation}`);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error);
    process.exit(2);
  });
}
