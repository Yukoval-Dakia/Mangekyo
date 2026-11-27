import { writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { types } from 'node:util';
import { pathToFileURL } from 'node:url';

const readStdin = () =>
  new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });

const reportMemory = () => {
  const usageKb = process.resourceUsage().maxRSS;
  const line = `\nMGKYO_RSS_KB=${usageKb}\n`;
  try {
    writeSync(3, line);
  } catch {
    /* fd 3 absent or closed; memory metric is optional */
  }
};

const syntaxErrorReport = (error) => {
  const detail = `${error.name}: ${error.message}`.slice(0, 2000);
  const frame = /student[^:\n]*\.m?[tj]s:(\d+)(?::(\d+))?/.exec(error.stack ?? '');
  const lineno = frame && frame[1] ? Number(frame[1]) : null;
  const offset = frame && frame[2] ? Number(frame[2]) : null;
  return `${JSON.stringify({ detail, lineno, offset })}\n`;
};

const runCheckMode = async (studentPath) => {
  const raw = await readFile(studentPath, 'utf8');
  const source = studentPath.endsWith('.mts') ? stripTypeScriptTypes(raw) : raw;
  const vm = await import('node:vm');
  try {
    new vm.SourceTextModule(source, { identifier: `file://${studentPath}` });
    return 0;
  } catch (error) {
    if (error instanceof SyntaxError) {
      writeSync(2, syntaxErrorReport(error));
      return 65;
    }
    throw error;
  }
};

const stringifyValue = (value) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const runScriptMode = async (studentPath) => {
  await import(pathToFileURL(studentPath).href);
};

const runEntryMode = async (studentPath, entrypoint) => {
  const imported = import(pathToFileURL(studentPath).href);
  if (!(imported instanceof Promise)) throw new TypeError('invalid module namespace');
  const mod = await imported;
  if (!types.isModuleNamespaceObject(mod)) throw new TypeError('invalid module namespace');
  if (!Object.prototype.hasOwnProperty.call(mod, entrypoint) || typeof mod[entrypoint] !== 'function') {
    writeSync(2, `entrypoint '${entrypoint}' is not defined\n`);
    return 69;
  }
  const inputText = await readStdin();
  const value = await mod[entrypoint](inputText);
  if (value !== undefined) writeSync(1, stringifyValue(value));
  return 0;
};

const main = async (argv) => {
  const [mode, studentPath, subMode, entrypoint] = argv.slice(2);
  if (mode === 'check') return runCheckMode(studentPath);
  if (subMode === 'entry') {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entrypoint ?? '')) {
      writeSync(2, 'invalid entrypoint\n');
      return 70;
    }
    return runEntryMode(studentPath, entrypoint);
  }
  await runScriptMode(studentPath);
  return 0;
};

try {
  const code = await main(process.argv);
  reportMemory();
  // Never process.exit() here: a script-mode student consumes stdin through
  // listeners that only fire while the event loop drains, so exiting eagerly
  // would cut off the input before the student ever sees it.
  process.exitCode = code;
} catch (error) {
  reportMemory();
  writeSync(2, `${error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
