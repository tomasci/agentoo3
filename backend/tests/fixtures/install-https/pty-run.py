#!/usr/bin/env python3
# Test driver: run a command with a REAL pseudo-terminal where the test asks
# for one, so `[[ -t 0 ]]` and `/dev/tty` behave the way they do for an
# operator at a keyboard — without touching any terminal of this machine's.
#
#   pty-run.py '<spec json>' -- argv...
#
# spec (all optional):
#   stdin    "pty" (default) | "devnull" | "pipe"   what the child's fd 0 is.
#            "pipe" is a pipe that is immediately closed (EOF), like the rest of
#            a `curl | bash` stream once bash has read the script.
#   ctty     true -> the pty is also the child's controlling terminal, so the
#            child's own open("/dev/tty") reaches it.
#   type     [[kind, line], ...] typed into the pty, in order. kind "now" types
#            it straight away; kind "noecho" first waits until the terminal's
#            ECHO flag is off (i.e. a `read -s` is actually waiting), exactly
#            what a careful human pasting a secret would see.
#   echoLog  file that receives everything the pty itself displayed (terminal
#            echo) — NOT the child's stdout/stderr, which are inherited as-is.
#   timeout  seconds before the whole process group is killed; exit 124.
#
# Exit status is the child's; 124 on timeout, 125 if a "noecho" wait never saw
# ECHO turn off (the child is then killed).
import json, os, select, signal, subprocess, sys, termios, threading, time, fcntl

def main() -> int:
    spec = json.loads(sys.argv[1])
    assert sys.argv[2] == '--'
    argv = sys.argv[3:]
    master, slave = os.openpty()
    stdin_kind = spec.get('stdin', 'pty')
    ctty = bool(spec.get('ctty', False))
    timeout = float(spec.get('timeout', 30))
    echo_log = spec.get('echoLog')

    if stdin_kind == 'pty':
        child_stdin = slave
    elif stdin_kind == 'devnull':
        child_stdin = subprocess.DEVNULL
    elif stdin_kind == 'pipe':
        child_stdin = subprocess.PIPE
    else:
        raise SystemExit(f'bad stdin kind {stdin_kind}')

    def pre():
        if ctty:
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    proc = subprocess.Popen(
        argv, stdin=child_stdin, start_new_session=True, preexec_fn=pre,
        pass_fds=(slave,) if ctty else (),
    )
    if stdin_kind == 'pipe':
        proc.stdin.close()

    echoed = bytearray()
    stop = threading.Event()

    def drain():
        while not stop.is_set():
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    return
                if not chunk:
                    return
                echoed.extend(chunk)

    t = threading.Thread(target=drain, daemon=True)
    t.start()

    deadline = time.monotonic() + timeout
    status = None
    for kind, line in spec.get('type', []):
        if kind == 'noecho':
            while termios.tcgetattr(master)[3] & termios.ECHO:
                if proc.poll() is not None or time.monotonic() > deadline:
                    status = 125
                    break
                time.sleep(0.01)
            if status is not None:
                break
        os.write(master, (line + '\n').encode())

    if status is None:
        try:
            status = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            status = 124
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
    time.sleep(0.05)
    stop.set()
    t.join(1)
    if echo_log:
        with open(echo_log, 'wb') as f:
            f.write(bytes(echoed))
    return status

sys.exit(main())
