import { closeSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { types } from 'node:util';
import { pathToFileURL } from 'node:url';

// The nonce is consumed and deleted before any student module is evaluated, so
// neither process.env nor process.argv can leak it into student hands.
const metaNonce = process.env.MGKYO_META_NONCE ?? '';
delete process.env.MGKYO_META_NONCE;
const rawWriteSync = writeSync;
const rawCloseSync = closeSync;

const readStdin = () =>
  new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });

// Memory metrics ride the out-of-band fd 3 pipe and are sealed with the nonce;
// the fd is closed immediately afterwards so exit handlers registered by the
// student can never append a forged measurement.
const reportMemory = () => {
  const usageKb = process.resourceUsage().maxRSS;
  try {
    rawWriteSync(3, `\nMGKYO_RSS_${metaNonce}=${usageKb}\n`);
    rawCloseSync(3);
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
      rawWriteSync(2, syntaxErrorReport(error));
      return 65;
    }
    throw error;
  }
};

const stringifyValue = (value) => {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch {
    /* circular structures fall through to String */
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const runScriptMode = async (studentPath) => {
  await import(pathToFileURL(studentPath).href);
};

const scrubProcessSurface = () => {
  process.argv = process.argv.slice(0, 1);
  process.argv[1] = '<student>';
};

const runEntryMode = async (studentPath, entrypoint) => {
  scrubProcessSurface();
  let entryDone = false;
  const originalExit = process.exit;
  process.exit = () => {
    if (!entryDone) throw new Error('process.exit is blocked inside the entrypoint sandbox');
    return originalExit(0);
  };
  let mod;
  try {
    const imported = import(pathToFileURL(studentPath).href);
    if (!(imported instanceof Promise)) throw new TypeError('invalid module namespace');
    mod = await imported;
    if (!types.isModuleNamespaceObject(mod)) throw new TypeError('invalid module namespace');
    if (!Object.prototype.hasOwnProperty.call(mod, entrypoint) || typeof mod[entrypoint] !== 'function') {
      rawWriteSync(2, `entrypoint '${entrypoint}' is not defined\n`);
      return 69;
    }
    const inputText = await readStdin();
    const value = await mod[entrypoint](inputText);
    entryDone = true;
    if (value !== undefined) rawWriteSync(1, stringifyValue(value));
    return 0;
  } finally {
    process.exit = originalExit;
  }
};

const main = async (argv) => {
  const [mode, studentPath, subMode, entrypoint] = argv.slice(2);
  if (mode === 'check') return runCheckMode(studentPath);
  if (subMode === 'entry') {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entrypoint ?? '')) {
      rawWriteSync(2, 'invalid entrypoint\n');
      return 70;
    }
    return runEntryMode(studentPath, entrypoint);
  }
  scrubProcessSurface();
  await runScriptMode(studentPath);
  return 0;
};

// Any student-thrown value must render without trusting its shape (null,
// undefined, primitives, poisoned prototypes) and without leaking harness
// stack paths; messages only, never error.stack.
const formatError = (error) => {
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}\n`;
  } catch {
    /* poisoned prototype */
  }
  try {
    return `Error: ${String(error)}\n`;
  } catch {
    return 'Error: student code threw a non-printable value\n';
  }
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
  try {
    rawWriteSync(2, formatError(error));
  } catch {
    /* stderr may be closed by the student; the exit code still reports failure */
  }
  process.exitCode = 1;
}
