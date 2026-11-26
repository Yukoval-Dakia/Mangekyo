// Isolated student-code harness for javascript/typescript sandbox runs.
//
// Modes:
//   node <flags> node-harness.mjs check <student-file> <language>
//   node <flags> node-harness.mjs run script|entry <student-file> [entrypoint]
//
// `check` parses the source (after type stripping for typescript) without
// ever evaluating student code. `run` evaluates the module and always ends
// stderr with a `MGKYO_RSS_KB=` peak-memory marker line consumed by the host.
// The entrypoint name only ever travels through argv, never through source
// interpolation, and exports are resolved with hasOwnProperty own-key lookup.

import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

function parseSyntax(source, language) {
  const plain = language === 'typescript' ? stripTypeScriptTypes(source) : source;
  new vm.SourceTextModule(plain);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buffer += chunk; });
    process.stdin.on('end', () => resolve(buffer));
    process.stdin.on('error', reject);
  });
}

function writeResult(value) {
  if (value === undefined) return;
  if (typeof value === 'string') process.stdout.write(value);
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') process.stdout.write(String(value));
  else process.stdout.write(JSON.stringify(value) ?? String(value));
}

async function main() {
  const [mode, studentPath, third, fourth] = process.argv.slice(2);
  if (mode === 'check' && studentPath && third) {
    parseSyntax(readFileSync(studentPath, 'utf8'), third);
    return;
  }
  if (mode === 'run' && studentPath && third) {
    const submode = third;
    const entrypoint = fourth ?? '';
    if (submode !== 'script' && submode !== 'entry') throw new Error('harness usage error');
    let stdinText = '';
    if (submode === 'entry') stdinText = await readStdin();
    const studentModule = await import(pathToFileURL(studentPath).href);
    if (submode === 'entry') {
      if (!Object.prototype.hasOwnProperty.call(studentModule, entrypoint) || typeof studentModule[entrypoint] !== 'function') {
        throw new TypeError('entrypoint not defined: ' + entrypoint);
      }
      writeResult(await studentModule[entrypoint](stdinText));
    }
    return;
  }
  throw new Error('harness usage error');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.stderr.write('\nMGKYO_RSS_KB=' + Math.max(1, process.resourceUsage().maxRSS) + '\n');
}
