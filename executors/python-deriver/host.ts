import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getMethodVersion, isCanonicalEvidenceSlice, isCognitionResult, isInformationGainResult } from './schema.ts';
import { isExamPacingInput, isExamPacingResult } from './exam-pacing-schema.ts';
import { isInterventionLiftInput, isInterventionLiftOutcome } from './intervention-lift-schema.ts';

export type DeriveOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'unknown'; readonly reason: string };

export type DeriveResult =
  | { readonly kind: 'ok'; readonly outcome: DeriveOutcome }
  | { readonly kind: 'failed'; readonly reason: string };

type Pending = {
  readonly resolve: (result: DeriveResult) => void;
  readonly timer: NodeJS.Timeout;
  readonly methodVersion: string;
  readonly frozenInput?: unknown;
};

function acceptsOutcome(request: Pending, outcome: unknown): outcome is DeriveOutcome {
  if (request.methodVersion === 'intervention-lift@1')
    return isInterventionLiftInput(request.frozenInput) && isInterventionLiftOutcome(outcome, request.frozenInput);
  if (!outcome || typeof outcome !== 'object' || !('kind' in outcome) || outcome.kind !== 'value' || !('value' in outcome))
    return false;
  if (request.methodVersion === 'plan/exam-pacing@1')
    return isExamPacingInput(request.frozenInput) && isExamPacingResult(outcome.value, request.frozenInput);
  if (request.methodVersion === 'plan/information-gain@1')
    return isCanonicalEvidenceSlice(request.frozenInput) && isInformationGainResult(outcome.value, request.frozenInput);
  return isCognitionResult(outcome.value) && outcome.value.method_version === request.methodVersion;
}

const MAX_INPUT_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const RESTART_DELAY_MS = 250;

export type PythonDeriverHost = {
  readonly derive: (deriver: string, input: unknown) => Promise<DeriveResult>;
  readonly close: () => Promise<void>;
};

export type PythonDeriverOptions = {
  readonly python?: string;
  readonly workerPath?: string;
  readonly timeoutMs?: number;
  readonly restartDelayMs?: number;
  readonly maxInputBytes?: number;
  readonly spawnProcess?: (command: string, args: readonly string[]) => ChildProcess;
};

// Long-lived Python worker host. The child is a pure calculator: the host
// passes one sealed gather payload per line and matches replies by id.
// Timeouts, crashes and malformed replies resolve as `failed`, never as a
// value - the surrounding work/fence decides whether the work retries.
export function createPythonDeriverHost(options: PythonDeriverOptions = {}): PythonDeriverHost {
  const python = options.python ?? process.env.MANGEKYO_PYTHON ?? 'python3';
  const workerPath = options.workerPath ?? fileURLToPath(new URL('./worker.py', import.meta.url));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS;
  const maxInputBytes = options.maxInputBytes ?? MAX_INPUT_BYTES;
  const spawnProcess = options.spawnProcess ?? ((command: string, args: readonly string[]) =>
    spawn(command, [...args], { stdio: ['pipe', 'pipe', 'ignore'], env: {} }));

  const pending = new Map<string, Pending>();
  let child: ChildProcess | undefined;
  let reader: Interface | undefined;
  let nextId = 0n;
  let closed = false;
  let restartTimer: NodeJS.Timeout | undefined;

  function failAll(reason: string) {
    const requests = [...pending.values()];
    pending.clear();
    for (const request of requests) {
      clearTimeout(request.timer);
      request.resolve({ kind: 'failed', reason });
    }
  }

  function teardown(target: ChildProcess, reason: string) {
    if (child !== target) return;
    child = undefined;
    reader?.close();
    reader = undefined;
    target.kill('SIGKILL');
    failAll(reason);
    if (!closed && restartDelayMs > 0 && restartTimer === undefined) {
      restartTimer = setTimeout(() => { restartTimer = undefined; }, restartDelayMs);
      restartTimer.unref();
    }
  }

  function onLine(target: ChildProcess, line: string) {
    if (child !== target) return;
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      teardown(target, 'python deriver returned malformed JSON');
      return;
    }
    if (!response || typeof response !== 'object' || Array.isArray(response) ||
        !('id' in response) || typeof response.id !== 'string') {
      teardown(target, 'python deriver returned a malformed response');
      return;
    }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if ('error' in response && typeof response.error === 'string' && !('value' in response)) {
      request.resolve({ kind: 'failed', reason: 'python deriver error: ' + response.error.slice(0, 400) });
    } else if ('value' in response && !('error' in response) && acceptsOutcome(request, response.value)) {
      request.resolve({ kind: 'ok', outcome: response.value });
    } else {
      request.resolve({ kind: 'failed', reason: 'python deriver returned a malformed outcome' });
    }
  }

  function ensureChild(): ChildProcess {
    if (child) return child;
    const spawned = spawnProcess(python, ['-I', '-B', '-S', '-X', 'utf8', workerPath]);
    spawned.once('error', () => teardown(spawned, 'python deriver worker failed to start'));
    if (!spawned.stdin || !spawned.stdout) {
      spawned.kill('SIGKILL');
      throw new Error('python deriver requires piped stdin and stdout');
    }
    child = spawned;
    reader = createInterface({ input: spawned.stdout, crlfDelay: Infinity });
    reader.on('line', line => onLine(spawned, line));
    spawned.once('close', () => teardown(spawned, 'python deriver worker exited'));
    spawned.stdin.on('error', () => teardown(spawned, 'python deriver worker write failed'));
    spawned.stderr?.resume();
    return spawned;
  }

  async function derive(deriver: string, input: unknown): Promise<DeriveResult> {
    if (closed) return { kind: 'failed', reason: 'python deriver host is closed' };
    const methodVersion = getMethodVersion(deriver);
    if (!methodVersion) return { kind: 'failed', reason: 'unregistered python deriver' };
    let payload: string;
    let frozenInput: unknown;
    const id = `req-${++nextId}`;
    try {
      if (methodVersion === 'intervention-lift@1') {
        if (!isInterventionLiftInput(input)) return { kind: 'failed', reason: 'invalid intervention Lift input' };
      } else if (methodVersion === 'plan/exam-pacing@1') {
        if (!isExamPacingInput(input)) return { kind: 'failed', reason: 'invalid exam pacing input' };
      } else if (!isCanonicalEvidenceSlice(input)) return { kind: 'failed', reason: 'invalid CanonicalEvidenceSlice@v1' };
      payload = JSON.stringify({ id, deriver, input });
      if (Buffer.byteLength(payload) > maxInputBytes)
        return { kind: 'failed', reason: 'deriver input exceeds the protocol limit' };
      if (methodVersion === 'intervention-lift@1' || methodVersion === 'plan/exam-pacing@1' || methodVersion === 'plan/information-gain@1')
        frozenInput = JSON.parse(payload).input;
    } catch {
      return { kind: 'failed', reason: 'deriver input is not JSON serializable' };
    }
    if (restartTimer) return { kind: 'failed', reason: 'python deriver worker restarting' };
    return new Promise<DeriveResult>(resolve => {
      let target: ChildProcess;
      try {
        target = ensureChild();
      } catch {
        resolve({ kind: 'failed', reason: 'python deriver worker is unavailable' });
        return;
      }
      const timer = setTimeout(() => {
        teardown(target, `python deriver timed out after ${timeoutMs} ms`);
      }, timeoutMs);
      timer.unref();
      pending.set(id, { resolve, timer, methodVersion, frozenInput });
      target.stdin!.write(payload + '\n', error => {
        if (error) teardown(target, 'python deriver worker write failed');
      });
    });
  }

  async function close() {
    closed = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    failAll('python deriver host is closed');
    const current = child;
    child = undefined;
    reader?.close();
    reader = undefined;
    if (current) {
      await new Promise<void>(resolve => {
        current.once('close', () => resolve());
        current.kill('SIGKILL');
      });
    }
  }

  return { derive, close };
}
