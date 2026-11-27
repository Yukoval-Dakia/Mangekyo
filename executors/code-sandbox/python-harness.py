import ast
import json
import os
import resource
import sys


def syntax_detail(exc):
    parts = ['{} at line {}'.format(exc.msg, exc.lineno or '?')]
    if exc.text:
        parts.append(exc.text.strip()[:200])
    return '; '.join(parts)


def diagnostics_json(exc):
    return json.dumps({
        'detail': syntax_detail(exc),
        'lineno': exc.lineno,
        'offset': exc.offset,
    })


def apply_limits(cpu_sec, memory_mb):
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_sec, cpu_sec))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        memory_bytes = memory_mb * 1024 * 1024
        current, _ = resource.getrlimit(resource.RLIMIT_AS)
        if memory_bytes < current or current == resource.RLIM_INFINITY:
            if memory_bytes >= 32 * 1024 * 1024:
                resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    except (ValueError, OSError):
        pass


def dup_fd(fd):
    try:
        return os.dup(fd)
    except OSError:
        return None


ORIG_STDOUT_FD = dup_fd(1)
ORIG_STDERR_FD = dup_fd(2)
META_FD = dup_fd(3)
try:
    os.close(3)
except OSError:
    pass


def load_stdin():
    try:
        return sys.stdin.read()
    except OSError:
        return ''


def write_fd(fd, fallback, text):
    data = text.encode('utf-8', 'replace')
    if fd is not None:
        try:
            os.write(fd, data)
            return
        except (OSError, ValueError):
            pass
    try:
        fallback.write(text)
        fallback.flush()
    except (OSError, ValueError, AttributeError):
        pass


def write_out(text):
    write_fd(ORIG_STDOUT_FD, sys.stdout, text)


def write_err(text):
    write_fd(ORIG_STDERR_FD, sys.stderr, text)


def format_value(value):
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return str(value)


def run_script(source):
    namespace = {'__name__': '__main__'}
    exec(compile(source, '<student>', 'exec'), namespace)


def run_entrypoint(source, entrypoint):
    namespace = {'__name__': '<student>'}
    try:
        exec(compile(source, '<student>', 'exec'), namespace)
    except SystemExit:
        write_err('student code exited before entrypoint call\n')
        raise SystemExit(71)
    fn = namespace.get(entrypoint)
    if not callable(fn):
        write_err('entrypoint {!r} is not defined\n'.format(entrypoint))
        raise SystemExit(69)
    value = fn(load_stdin())
    if value is not None:
        try:
            sys.stdout.flush()
        except (OSError, ValueError, AttributeError):
            pass
        write_out(format_value(value))


def syntax_check(source):
    try:
        compile(source, '<student>', 'exec')
    except SyntaxError as exc:
        write_err(diagnostics_json(exc) + '\n')
        return 65
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        write_err(diagnostics_json(exc) + '\n')
        return 65
    try:
        compile(tree, '<student>', 'exec')
    except (ValueError, RecursionError, MemoryError) as exc:
        detail = '{}: {}'.format(type(exc).__name__, exc)
        write_err(json.dumps({'detail': detail[:2000], 'lineno': None, 'offset': None}) + '\n')
        return 65
    return 0


def report_memory():
    if META_FD is None:
        return
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    usage_kb = usage // 1024 if sys.platform == 'darwin' else usage
    try:
        os.write(META_FD, '\nMGKYO_RSS_KB={}\n'.format(usage_kb).encode('ascii'))
    except (OSError, ValueError):
        pass


def read_source(path):
    with open(path, 'r', encoding='utf-8') as handle:
        return handle.read()


def main(argv):
    if len(argv) < 3:
        write_err('harness misconfigured\n')
        raise SystemExit(70)
    mode = argv[1]
    if mode == 'check':
        if len(argv) < 5:
            write_err('harness misconfigured\n')
            raise SystemExit(70)
        apply_limits(int(argv[3]), int(argv[4]))
        return syntax_check(read_source(argv[2]))
    if len(argv) < 6:
        write_err('harness misconfigured\n')
        raise SystemExit(70)
    apply_limits(int(argv[4]), int(argv[5]))
    if os.path.getsize(argv[2]) == 0:
        return 0
    source = read_source(argv[2])
    if argv[3] == 'entry':
        if len(argv) < 7:
            write_err('harness misconfigured\n')
            raise SystemExit(70)
        entrypoint = argv[6]
        if not entrypoint.isidentifier():
            write_err('invalid entrypoint\n')
            return 70
        run_entrypoint(source, entrypoint)
    else:
        run_script(source)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    finally:
        report_memory()
