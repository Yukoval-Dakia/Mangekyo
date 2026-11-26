"""Isolated student-code harness for the code sandbox executor.

Modes:
  python3 -I python-harness.py check <student.py>
  python3 -I python-harness.py run script|entry <student.py> <cpuSec> <memMb> [entrypoint]

`check` only compiles the source; it never executes student code. `run`
applies best-effort rlimits before executing and always ends stderr with a
`MGKYO_RSS_KB=` peak-memory marker line consumed by the host runner.
"""

import json
import resource
import sys
import traceback


def apply_limits(cpu_seconds, memory_mb):
    pairs = []
    pairs.append((resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds)))
    pairs.append((resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024)))
    pairs.append((resource.RLIMIT_NOFILE, (64, 64)))
    rlimit_as = getattr(resource, 'RLIMIT_AS', None)
    if rlimit_as is not None:
        base_kb = 0
        try:
            with open('/proc/self/status') as proc_status:
                for line in proc_status:
                    if line.startswith('VmSize:'):
                        base_kb = int(line.split()[1])
        except OSError:
            base_kb = 0
        if base_kb > 0:
            limit = base_kb * 1024 + memory_mb * 1024 * 1024 * 2
            pairs.append((rlimit_as, (limit, limit)))
    for key, value in pairs:
        try:
            resource.setrlimit(key, value)
        except (ValueError, OSError):
            pass


def write_result(value):
    if isinstance(value, str):
        sys.stdout.write(value)
    else:
        try:
            sys.stdout.write(json.dumps(value, ensure_ascii=False))
        except (TypeError, ValueError):
            sys.stdout.write(str(value))


def run_student(path, cpu_seconds, memory_mb, submode, entrypoint):
    apply_limits(cpu_seconds, memory_mb)
    with open(path, 'rb') as student_file:
        source = student_file.read()
    code = compile(source, '<student>', 'exec')
    if submode == 'entry':
        stdin_text = sys.stdin.read()
    namespace = {'__name__': '__student__'}
    try:
        exec(code, namespace)
        if submode == 'entry':
            if entrypoint not in namespace or not callable(namespace[entrypoint]):
                raise TypeError('entrypoint not defined: ' + entrypoint)
            result = namespace[entrypoint](stdin_text)
            if result is not None:
                write_result(result)
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        sys.exit(1)


def report_memory():
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    kilobytes = usage // 1024 if sys.platform == 'darwin' else usage
    sys.stderr.write('\nMGKYO_RSS_KB=%d\n' % max(1, kilobytes))


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('harness usage error\n')
        return 64
    mode, path = sys.argv[1], sys.argv[2]
    if mode == 'check':
        with open(path, 'rb') as student_file:
            source = student_file.read()
        try:
            compile(source, '<student>', 'exec')
        except Exception:
            traceback.print_exc()
            return 1
        return 0
    if mode == 'run' and len(sys.argv) >= 6:
        submode, cpu_seconds, memory_mb = sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
        if submode in ('script', 'entry'):
            entrypoint = sys.argv[6] if len(sys.argv) > 6 else ''
            run_student(path, cpu_seconds, memory_mb, submode, entrypoint)
            return 0
    sys.stderr.write('harness usage error\n')
    return 64


if __name__ == '__main__':
    try:
        sys.exit(main())
    finally:
        report_memory()
