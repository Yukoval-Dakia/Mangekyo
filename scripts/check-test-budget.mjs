import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const count = text => text.split(/\r?\n/).filter(line => line.trim()).length;
let production = 0;
let tests = 0;
async function scan(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => entry.isFile() && entry.name === 'pyvenv.cfg')) return;
  for (const entry of entries) {
    if (['node_modules', 'dist', '.git', '.codex', '.agents', '.venv', '__pycache__'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.(?:[cm]?[jt]sx?|py)$/.test(file)) {
      const source = await readFile(file, 'utf8');
      const test = /(?:^|\/)(?:tests?|fixtures|samples)(?:\/|$)|\.(?:test|spec|contract)\.|check-test-budget/.test(path.relative(root, file))
        || /^(?:test_.*|.*_test|conftest)\.py$/.test(entry.name);
      if (test) tests += count(source);
      else {
        production += count(source);
        if (entry.name.endsWith('.py')) continue;
        const visit = node => {
          if (ts.isStringLiteralLike(node) && /from ['"](?:vitest|node:test)['"]/.test(node.text)) {
            tests += count(node.text);
            production -= count(node.text);
          }
          ts.forEachChild(node, visit);
        };
        visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
      }
    }
  }
}
await scan(root);
console.log(JSON.stringify({ production, tests, ratio: tests / (production + tests), limit: 0.1 }));
if (tests * 9 > production) process.exitCode = 1;
