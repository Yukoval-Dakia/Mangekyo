import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const count = text => text.split(/\r?\n/).filter(line => line.trim()).length;
let production = 0;
let tests = 0;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.codex', '.agents'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(file)) {
      const source = await readFile(file, 'utf8');
      const test = /(?:^|\/)(?:tests?|fixtures|samples)(?:\/|$)|\.(?:test|spec|contract)\.|check-test-budget/.test(path.relative(root, file));
      if (test) tests += count(source);
      else {
        production += count(source);
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
if (tests * 9 > production) process.exitCode = 1;
