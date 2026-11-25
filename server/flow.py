"""Maestro-style flows for the emulated Jade.

A flow is a YAML list of steps, optionally preceded by a config document:

    name: sign a message        # optional config document
    settle: true                # wait for the screen to settle after each press
    ---
    - exec: {method: get_version_info, as: info}
    - log: "state is ${info.JADE_STATE}"
    - exec: {method: sign_message, params: {path: [0, 0], message: hi}, async: true, as: sig}
    - waitForChange
    - right: 2
    - confirm
    - await: sig
    - screenshot: signed

Config keys: name, settle (default true), firmwareErrors: warn|fail|ignore (what to do
when the firmware logs an ERROR while the flow runs; default warn: recorded on the step
and the run, which still passes), ignoreErrors: REGEX | [REGEX, ...] (errors to ignore),
timeout (seconds, default 600).

Steps (string form, or a one-key mapping whose value is the argument):
    left / right / confirm (alias click) [: N]   press a button N times (default 1)
    sleep: DURATION  (alias wait)                 pause: 500 (ms), "500ms", "2s", "1.5m"
    waitForChange [: {timeout: MS}]               wait for the screen to change
    screenshot [: NAME | {name, scale}]           save PNG to data/screenshots/
    exec: METHOD | {method, params, as, async, timeout, expect, allowError, followHttp}
        Run a Jade RPC. Blocks until the reply unless `async: true`, in which
        case the flow continues (so it can press buttons) and `await` collects it.
        The result is stored in the variable named by `as` (and always in `last`).
    await: NAME | {name, timeout, expect, allowError}   wait for an async exec
    approve: NAME | {name, timeout, max, screenshots}   accept every screen until the async exec
        NAME replies, by reading the highlighted button: "→"/"✓" top-right: confirm;
        "X" top-left or "No"/"←" bottom-left: right + confirm; anything else (messages,
        Yes, Continue): confirm. For reviews whose number of screens varies.
        `screenshots: PREFIX` (or true) saves each screen before accepting it.
    expect: {var, equals | notEquals | contains | matches | startsWith}
    decrypt: {as, privkey, pubkey, encrypted, label}   decrypt data Jade encrypted to our
        ephemeral key (ECDH + AES, eg. bip85 entropy); needs the wallycore package
    http: {request: PARAMS, as}                   perform a firmware http_request (the 'params'
        of a reply got with `followHttp: false`) and store {body}: send it on with exec
    send: {data: "hex:.."|"file:..", cbor: VALUE}  write raw bytes (or a CBOR-encoded value)
        to the serial stream: for protocol tests with malformed or partial messages
    receive: {as, count: N | until: ID, timeout}  collect replies no exec is waiting for
        (eg. to `send`): {replies, last, rejected} where `rejected` totals the bytes the
        firmware reported as invalid (error -32600 'data')
    log: TEXT
    repeat: {times: N, steps: [...]}
    restart                                       power-cycle the device

Strings may reference results as ${name} or ${name.key.0}. A string that is
exactly "${name}" is replaced by the raw value (keeping bytes/ints).
Byte strings in params are written as "hex:<hex>", or "file:<path>" for the bytes of a
file inside the jade-web folder.
"""
import json
import os
import re
import struct
import threading
import time
import zlib

import yaml

# Firmware errors (its 'ERROR:' log lines, incl. failed assertions) seen during a run are
# attached to the step being executed. These are logged by every emulated boot and are
# not problems: the emulator has no flash partition to validate.
DEFAULT_IGNORED_ERRORS = [r'Cannot get running partition']
FIRMWARE_ERROR_MODES = ('warn', 'fail', 'ignore')

# Steps that keep a raw `send` section going (display polling stays paused: see LibJadeHost.send_raw)
RAW_SAFE_STEPS = {'send', 'receive', 'sleep', 'expect', 'log'}
BUTTONS = {'left': 'left', 'right': 'right', 'confirm': 'click', 'click': 'click'}
VAR_RE = re.compile(r'\$\{([A-Za-z_][\w.]*)\}')


class FlowError(Exception):
    def __init__(self, message, line=None):
        self.line = line
        super().__init__(f'line {line}: {message}' if line else message)


class FlowStopped(Exception):
    pass


class Step:
    __slots__ = ('kind', 'arg', 'line', 'children')

    def __init__(self, kind, arg, line, children=None):
        self.kind, self.arg, self.line, self.children = kind, arg, line, children

    def describe(self):
        if self.kind == 'repeat':
            return f'repeat x{self.arg["times"]}'
        arg = self.arg
        if arg in (None, {}) or (self.kind in BUTTONS and arg == 1):
            return self.kind
        if self.kind == 'exec':
            arg = arg['method'] + (' (async)' if arg.get('async') else '')
        elif self.kind in ('screenshot', 'await') and set(arg) == {'name'}:
            arg = arg['name'] or ''
        elif self.kind == 'approve':
            extra = {k: v for k, v in arg.items() if k != 'name' and v != {'timeout': 60000, 'max': 60}.get(k)}
            arg = arg['name'] + (f' {json.dumps(extra)}' if extra else '')
        elif self.kind == 'waitForChange' and arg == {'timeout': 5000}:
            return self.kind
        elif self.kind == 'sleep':
            return f'sleep {arg / 1000:g}s' if arg >= 1000 else f'sleep {arg:g}ms'
        elif self.kind == 'receive':
            arg = json.dumps({k: v for k, v in arg.items() if (k, v) != ('timeout', 10000)}, default=str)
        elif isinstance(arg, dict):
            arg = json.dumps(arg, default=str)
        text = f'{self.kind}: {arg}'
        return text if len(text) <= 160 else text[:150] + f'… ({len(text)} chars)'


#
# Parsing
#
def parse_flow(source):
    """Parse flow source into (config, [Step]). Raises FlowError with a line number."""
    try:
        docs = list(yaml.safe_load_all(source))
        nodes = list(yaml.compose_all(source))
    except yaml.YAMLError as e:
        mark = getattr(e, 'problem_mark', None)
        raise FlowError(getattr(e, 'problem', None) or str(e), mark.line + 1 if mark else None)

    pairs = [(d, n) for d, n in zip(docs, nodes) if d is not None]
    config, steps_data, steps_node = {}, None, None
    if len(pairs) == 1 and isinstance(pairs[0][0], list):
        steps_data, steps_node = pairs[0]
    elif len(pairs) == 1 and isinstance(pairs[0][0], dict) and 'steps' in pairs[0][0]:
        config = dict(pairs[0][0])
        steps_data = config.pop('steps')
        steps_node = next(v for k, v in pairs[0][1].value if k.value == 'steps')
    elif len(pairs) == 2 and isinstance(pairs[0][0], dict) and isinstance(pairs[1][0], list):
        config = pairs[0][0]
        steps_data, steps_node = pairs[1]
    else:
        raise FlowError('a flow is a list of steps, optionally preceded by a config document and ---')
    if not isinstance(steps_data, list):
        raise FlowError('"steps" must be a list', steps_node.start_mark.line + 1)
    timeout = config.get('timeout', 600)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise FlowError('timeout must be a positive number of seconds')
    mode = config.get('firmwareErrors', 'warn')
    if mode not in FIRMWARE_ERROR_MODES:
        raise FlowError(f'firmwareErrors must be one of {", ".join(FIRMWARE_ERROR_MODES)}, not {mode!r}')
    ignore = config.get('ignoreErrors', [])
    if isinstance(ignore, str):
        ignore = [ignore]
    if not isinstance(ignore, list) or not all(isinstance(x, str) for x in ignore):
        raise FlowError('ignoreErrors must be a regular expression or a list of them')
    for x in ignore:
        try:
            re.compile(x)
        except re.error as e:
            raise FlowError(f'ignoreErrors: bad regular expression {x!r}: {e}')
    return config, _parse_steps(steps_data, steps_node)


def _parse_steps(items, node):
    return [_parse_step(item, sub.start_mark.line + 1, sub) for item, sub in zip(items, node.value)]


DURATION_RE = re.compile(r'^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$')
DURATION_UNITS = {None: 1, 'ms': 1, 's': 1000, 'm': 60000}


def _duration_ms(value):
    """Milliseconds from a number (ms) or a string like '500ms', '2s', '1.5m'. None if invalid."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if value >= 0 else None
    m = DURATION_RE.match(value) if isinstance(value, str) else None
    return float(m.group(1)) * DURATION_UNITS[m.group(2)] if m else None


def _parse_step(item, line, node):
    if isinstance(item, str):
        kind, arg = item.strip(), None
    elif isinstance(item, dict) and len(item) == 1:
        kind, arg = next(iter(item.items()))
    else:
        raise FlowError(f'a step must be a name or a single-key mapping, got {item!r}', line)

    def need(cond, msg):
        if not cond:
            raise FlowError(f'{kind}: {msg}', line)

    if kind in BUTTONS:
        arg = 1 if arg is None else arg
        need(isinstance(arg, int) and arg > 0, 'repeat count must be a positive integer')
    elif kind in ('wait', 'sleep'):
        ms = _duration_ms(arg)
        need(ms is not None, 'expects a duration: milliseconds, or "500ms", "2s", "1.5m"')
        kind, arg = 'sleep', ms
    elif kind == 'waitForChange':
        arg = {'timeout': 5000, **(arg or {})}
    elif kind == 'screenshot':
        arg = {'name': arg} if isinstance(arg, str) or arg is None else arg
        need(isinstance(arg, dict), 'expects a name or {name, scale}')
    elif kind == 'exec':
        arg = {'method': arg} if isinstance(arg, str) else arg
        need(isinstance(arg, dict) and isinstance(arg.get('method'), str), 'needs a method')
        unknown = set(arg) - {'method', 'params', 'as', 'async', 'timeout', 'expect', 'allowError', 'followHttp'}
        need(not unknown, f'unknown option(s) {sorted(unknown)}')
        need(not arg.get('async') or arg.get('as'), 'async exec needs `as: NAME` to await it')
    elif kind == 'await':
        arg = {'name': arg} if isinstance(arg, str) else arg
        need(isinstance(arg, dict) and isinstance(arg.get('name'), str), 'needs the async exec name')
        unknown = set(arg) - {'name', 'timeout', 'expect', 'allowError'}
        need(not unknown, f'unknown option(s) {sorted(unknown)}')
    elif kind == 'approve':
        arg = {'name': arg} if isinstance(arg, str) else arg
        need(isinstance(arg, dict) and isinstance(arg.get('name'), str), 'needs the async exec name')
        unknown = set(arg) - {'name', 'timeout', 'max', 'screenshots'}
        need(not unknown, f'unknown option(s) {sorted(unknown)}')
        arg = {'timeout': 60000, 'max': 60, **arg}
    elif kind == 'decrypt':
        need(isinstance(arg, dict), 'expects {as, privkey, pubkey, encrypted, label}')
        missing = {'as', 'privkey', 'pubkey', 'encrypted', 'label'} - set(arg)
        need(not missing, f'missing {sorted(missing)}')
        unknown = set(arg) - {'as', 'privkey', 'pubkey', 'encrypted', 'label'}
        need(not unknown, f'unknown option(s) {sorted(unknown)}')
    elif kind == 'http':
        need(isinstance(arg, dict) and 'request' in arg and isinstance(arg.get('as'), str),
             'expects {request: "${reply.http_request.params}", as: NAME}')
        unknown = set(arg) - {'request', 'as'}
        need(not unknown, f'unknown option(s) {sorted(unknown)}')
    elif kind == 'send':
        need(isinstance(arg, dict) and (('data' in arg) != ('cbor' in arg)), 'needs one of data: or cbor:')
        unknown = set(arg) - {'data', 'cbor'}
        need(not unknown, f'unknown option(s) {sorted(unknown)}')
    elif kind == 'receive':
        need(isinstance(arg, dict) and isinstance(arg.get('as'), str), 'needs as: NAME')
        need(('count' in arg) != ('until' in arg), 'needs one of count: N or until: ID')
        unknown = set(arg) - {'as', 'count', 'until', 'timeout'}
        need(not unknown, f'unknown option(s) {sorted(unknown)}')
        arg = {'timeout': 10000, **arg}
    elif kind == 'expect':
        need(isinstance(arg, dict) and 'var' in arg,
             'needs {var: NAME, equals|notEquals|contains|matches|startsWith: ...}')
        need(any(k in arg for k in ('equals', 'notEquals', 'contains', 'matches', 'startsWith')),
             'needs one of equals, notEquals, contains, matches, startsWith')
    elif kind == 'log':
        arg = '' if arg is None else str(arg)
    elif kind == 'restart':
        arg = None
    elif kind == 'repeat':
        need(isinstance(arg, dict) and isinstance(arg.get('times'), int) and isinstance(arg.get('steps'), list),
             'expects {times: N, steps: [...]}')
        steps_node = next(v for k, v in node.value[0][1].value if k.value == 'steps')
        return Step(kind, {'times': arg['times']}, line, _parse_steps(arg['steps'], steps_node))
    else:
        raise FlowError(f'unknown step "{kind}"', line)
    return Step(kind, arg, line)


#
# Screenshots
#
def rgb565_to_png(data, width, height, scale=1):
    rows = bytearray()
    for y in range(height):
        line = bytearray()
        for x in range(width):
            i = (y * width + x) * 2
            v = data[i] << 8 | data[i + 1]
            r, g, b = (v >> 11) & 0x1f, (v >> 5) & 0x3f, v & 0x1f
            line += bytes(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2))) * scale
        rows += (b'\0' + line) * scale

    def chunk(tag, body):
        return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', zlib.crc32(tag + body))
    w, h = width * scale, height * scale
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(rows), 6)) + chunk(b'IEND', b''))


#
# Execution
#
def count_steps(steps):
    return sum(1 + (count_steps(s.children) if s.children else 0) for s in steps)


class FlowRun:
    """Runs one parsed flow in a background thread, reporting via `emit(event_dict)`."""

    def __init__(self, run_id, config, steps, jade, rpc, emit, runs_dir, to_json, from_json,
                 source='', meta=None, http=None, step_mode=False):
        self.id = run_id
        self.config = config
        self.steps = steps
        self.jade = jade
        self.rpc = rpc              # rpc(method, params, follow_http) -> final reply dict
        self.http = http            # http(params) -> {'body': ...}: performs a firmware http_request
        self.step_mode = step_mode  # pause before each top-level step until step() / resume()
        self._gate = threading.Event()
        self.paused_line = None
        self._emit = emit
        self.to_json, self.from_json = to_json, from_json
        self.name = re.sub(r'[^\w.-]+', '-', str(config.get('name') or 'flow')).strip('-') or 'flow'
        self.source = source
        self.meta = meta or {}      # eg. {'file': ..., 'suite': {...}}
        # Every run gets its own folder: run.json (the record) + its screenshots
        base = f'{time.strftime("%Y%m%d-%H%M%S")}-{self.name}'
        self.dir_name, n = base, 1
        while os.path.exists(os.path.join(runs_dir, self.dir_name)):
            n += 1
            self.dir_name = f'{base}-{n}'
        self.shots_dir = os.path.join(runs_dir, self.dir_name)
        os.makedirs(self.shots_dir)
        self.started = time.time()
        self.seconds = None
        self.records = []           # finished steps: {line, status, text, detail, screenshots}
        self.settle = config.get('settle', True)
        self.timeout = float(config.get('timeout', 600))
        self._deadline = None
        self._timed_out = threading.Event()
        # firmware errors: warn (default: recorded, run still passes), fail (the step fails), ignore
        self.fw_error_mode = config.get('firmwareErrors', 'warn')
        ignore = config.get('ignoreErrors', [])
        self._fw_ignore = [re.compile(x) for x in DEFAULT_IGNORED_ERRORS + ([ignore] if isinstance(ignore, str) else ignore)]
        self.fw_errors = []          # [{'line': step line or None, 'text': ...}]
        self._step_errors = []       # errors seen during the current step
        self._current_line = None
        self.vars = {}
        self.jobs = {}              # async exec name -> {'event', 'reply', 'step'}
        self.status = 'running'
        self.error = None
        self.screenshots = []
        self._stop = threading.Event()
        self._cancel_reason = None
        self._thread = threading.Thread(target=self._run, daemon=True, name=f'flow-{run_id}')
        self._shot_counter = 0

    def start(self):
        self._thread.start()

    def stop(self, reason=None):
        if reason:
            self._cancel_reason = reason
        self._stop.set()

    def firmware_error(self, text):
        """An ERROR line the firmware logged while this flow runs (called from the log reader)."""
        if self.fw_error_mode == 'ignore' or self.status != 'running':
            return
        if any(p.search(text) for p in self._fw_ignore):
            return
        err = {'line': self._current_line, 'text': text}
        self.fw_errors.append(err)
        self._step_errors.append(text)
        self.emit({'event': 'fwerror', **err})

    def step(self):
        """Step mode: run the next step, then pause again."""
        self._gate.set()

    def resume(self):
        """Leave step mode: run the remaining steps."""
        self.step_mode = False
        self._gate.set()

    def join(self, timeout=None):
        self._thread.join(timeout)

    def emit(self, evt):
        if evt['event'] == 'step' and evt['status'] != 'running':
            self.records.append({k: evt.get(k) for k in ('line', 'status', 'text', 'detail')})
            self.records[-1]['screenshots'] = list(self._pending_shots)
            self._pending_shots.clear()
            if self._step_errors:
                self.records[-1]['firmware_errors'] = list(self._step_errors)
        elif evt['event'] == 'screenshot':
            self._pending_shots.append(evt['path'])
        self._emit({**evt, 'dir': self.dir_name})

    def summary(self):
        counts = {}
        for r in self.records:
            counts[r['status']] = counts.get(r['status'], 0) + 1
        return {'dir': self.dir_name, 'name': self.name, 'status': self.status, 'error': self.error,
                'started': self.started, 'seconds': self.seconds, 'steps_total': count_steps(self.steps),
                'steps': counts, 'screenshots': self.screenshots,
                'firmware_errors': len(self.fw_errors), **self.meta}

    def _save(self):
        record = {**self.summary(), 'source': self.source, 'records': self.to_json(self.records)}
        tmp = os.path.join(self.shots_dir, 'run.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(record, f, indent=1, default=str)
        os.replace(tmp, os.path.join(self.shots_dir, 'run.json'))

    def _run(self):
        t0 = time.time()
        self._deadline = time.monotonic() + self.timeout
        timer = threading.Timer(self.timeout, self._timeout)
        timer.daemon = True
        timer.start()
        self._pending_shots = []
        if hasattr(self.jade, 'clear_unclaimed'):
            try:
                self.jade.clear_unclaimed()
            except Exception:
                pass                            # eg. the worker is restarting: the first step reports it
        self._save()
        self.emit({'event': 'start', 'name': self.name, 'steps': len(self.steps),
                   'timeout': self.timeout,
                   'steps_total': count_steps(self.steps), 'started': self.started, **self.meta})
        try:
            self._run_steps(self.steps)
            self._check_stop()
            self.status = 'passed'
        except FlowStopped:
            if self._cancel_reason:
                self.status, self.error = 'cancelled', self._cancel_reason
            else:
                self.status = 'stopped'
        except FlowError as e:
            self.status, self.error = 'failed', str(e)
        except Exception as e:
            self.status, self.error = 'failed', f'{type(e).__name__}: {e}'
        timer.cancel()
        if hasattr(self.jade, 'end_raw'):
            try:
                self.jade.end_raw()                 # never leave display polling paused
            except Exception:
                pass                                # the worker died: its replacement starts unpaused
        self.seconds = round(time.time() - t0, 2)
        try:
            self._save()
        except OSError:
            pass  # the run folder may have been deleted meanwhile
        self.emit({'event': 'end', 'status': self.status, 'error': self.error,
                   'seconds': round(time.time() - t0, 2), 'screenshots': self.screenshots,
                   'firmware_errors': len(self.fw_errors)})

    def _run_steps(self, steps, top=True):
        for step in steps:
            self._check_stop()
            if top and self.step_mode:
                self.paused_line = step.line
                self.emit({'event': 'paused', 'line': step.line, 'text': step.describe()})
                while not self._gate.wait(0.2):
                    self._check_stop()
                self._gate.clear()
                self.paused_line = None
                self._check_stop()
            self._current_line = step.line
            self._step_errors = []
            self.emit({'event': 'step', 'line': step.line, 'status': 'running', 'text': step.describe()})
            if step.kind not in RAW_SAFE_STEPS and hasattr(self.jade, 'end_raw'):
                self.jade.end_raw()                 # a raw send/receive section is over
            try:
                note = getattr(self, f'_do_{step.kind}')(step)
                self._check_stop()
                if self.fw_error_mode == 'fail' and step.kind != 'repeat':
                    time.sleep(0.05)                # let log lines of this step arrive
                    if self._step_errors:
                        raise FlowError(f'firmware error: {self._step_errors[0]}')
            except FlowError as e:
                if e.line is None:
                    e = FlowError(str(e), step.line)
                self.emit({'event': 'step', 'line': step.line, 'status': 'failed',
                           'text': step.describe(), 'detail': str(e).split(': ', 1)[-1]})
                raise e
            except FlowStopped:
                status = 'cancelled' if self._cancel_reason else 'stopped'
                self.emit({'event': 'step', 'line': step.line, 'status': status, 'text': step.describe()})
                raise
            self.emit({'event': 'step', 'line': step.line, 'status': 'passed',
                       'text': step.describe(), 'detail': note})

    def _timeout(self):
        self._timed_out.set()
        self._stop.set()

    def _check_stop(self):
        if self._timed_out.is_set() or (self._deadline is not None and time.monotonic() >= self._deadline):
            raise FlowError(f'flow exceeded timeout of {self.timeout:g} seconds')
        if self._stop.is_set():
            raise FlowStopped()

    def _sleep(self, seconds):
        if self._stop.wait(seconds):
            self._check_stop()
            raise FlowStopped()

    # -- variables
    def _lookup(self, path):
        parts = path.split('.')
        if parts[0] not in self.vars:
            raise FlowError(f'unknown variable "{parts[0]}"')
        value = self.vars[parts[0]]
        for p in parts[1:]:
            try:
                value = value[int(p)] if isinstance(value, (list, tuple)) else value[p]
            except (KeyError, IndexError, ValueError, TypeError):
                raise FlowError(f'variable "{path}" has no "{p}"')
        return value

    def _subst(self, value):
        if isinstance(value, str):
            m = VAR_RE.fullmatch(value)
            if m:
                return self._lookup(m.group(1))
            return VAR_RE.sub(lambda m: self._fmt(self._lookup(m.group(1))), value)
        if isinstance(value, dict):
            return {k: self._subst(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._subst(v) for v in value]
        return value

    def _fmt(self, value):
        return value if isinstance(value, str) else json.dumps(self.to_json(value))

    # -- screen helpers
    def _press(self, event, times):
        for _ in range(times):
            self._check_stop()
            seq, _ = self.jade.get_frame()
            self.jade.send_input(event)
            if self.settle:
                self._settle(seq)
            else:
                self._sleep(0.15)

    def _settle(self, seq, change_timeout=1.0, quiet=0.25, max_wait=3.0):
        """Wait for the screen to change, then to stay unchanged for `quiet` seconds."""
        deadline = time.time() + max_wait
        seq = self._wait_change(seq, change_timeout)
        while time.time() < deadline:
            new = self._wait_change(seq, quiet)
            if new == seq:
                return
            seq = new

    def _wait_change(self, seq, timeout):
        end = time.time() + timeout
        while True:
            self._check_stop()
            left = end - time.time()
            if left <= 0:
                return seq
            new = self.jade.wait_frame(seq, min(left, 0.2))
            if new != seq:
                return new

    # -- steps
    def _do_left(self, step):
        self._press('left', step.arg)

    def _do_right(self, step):
        self._press('right', step.arg)

    def _do_confirm(self, step):
        self._press('click', step.arg)

    _do_click = _do_confirm

    def _do_sleep(self, step):
        self._sleep(step.arg / 1000)

    def _do_waitForChange(self, step):
        seq, _ = self.jade.get_frame()
        new = self._wait_change(seq, step.arg['timeout'] / 1000)
        if new == seq:
            raise FlowError(f'screen did not change within {step.arg["timeout"]} ms')
        self._settle(new, change_timeout=0)

    def _do_screenshot(self, step):
        return self._take_shot(self._subst(step.arg.get('name') or ''), step.line, int(step.arg.get('scale', 1)))

    def _take_shot(self, name, line, scale=1, frame=None):
        if frame is None:
            _, frame = self.jade.get_frame()
        if frame is None:
            raise FlowError('no frame available yet')
        self._shot_counter += 1
        name = re.sub(r'[^\w.-]+', '-', str(name)).strip('-')
        fname = f'{self._shot_counter:02d}-{name or "screen"}.png'
        os.makedirs(self.shots_dir, exist_ok=True)
        path = os.path.join(self.shots_dir, fname)
        with open(path, 'wb') as f:
            f.write(rgb565_to_png(frame, self.jade.width, self.jade.height, scale))
        rel = os.path.join(os.path.basename(self.shots_dir), fname)
        self.screenshots.append(rel)
        self.emit({'event': 'screenshot', 'line': line, 'path': rel})
        return rel

    def _do_exec(self, step):
        a = step.arg
        params = self.from_json(self._subst(a['params'])) if a.get('params') is not None else None
        job = {'event': threading.Event(), 'reply': None, 'error': None, 'step': step}

        def work():
            try:
                job['reply'] = self.rpc(a['method'], params, a.get('followHttp', True))
            except Exception as e:
                job['error'] = f'{type(e).__name__}: {e}'
            job['event'].set()
        threading.Thread(target=work, daemon=True).start()

        if a.get('async'):
            self.jobs[a['as']] = job
            return 'started'
        return self._finish_exec(job, a.get('timeout'))

    def _highlighted(self, frame, x, y):
        i = (y * self.jade.width + x) * 2
        v = frame[i] << 8 | frame[i + 1]
        return (v >> 11) < 4 and ((v >> 5) & 0x3f) > 25 and (v & 0x1f) > 6     # the green selection

    def _do_approve(self, step):
        a = step.arg
        if a['name'] not in self.jobs:
            raise FlowError(f'no async exec named "{a["name"]}"')
        job = self.jobs[a['name']]
        end = time.time() + a['timeout'] / 1000
        counts = {'next': 0, 'confirm': 0, 'continue': 0}
        seq, _ = self.jade.get_frame()
        self._settle(seq, change_timeout=1.0)          # let the first screen appear
        while not job['event'].wait(0.25):
            self._check_stop()
            if time.time() > end:
                raise FlowError(f'no reply from "{a["name"]}" within {a["timeout"]} ms')
            if sum(counts.values()) >= a['max']:
                raise FlowError(f'still no reply after {a["max"]} screens')
            _, frame = self.jade.get_frame()
            if job['event'].is_set():
                break
            w, h = self.jade.width, self.jade.height
            if a.get('screenshots'):                       # record every screen accepted
                prefix = a['screenshots'] if isinstance(a['screenshots'], str) else a['name']
                self._take_shot(f'{self._subst(prefix)}-{sum(counts.values()) + 1}', step.line, frame=frame)
            if self._highlighted(frame, w - 10, 5):
                counts['next'] += 1                        # "→" / "✓" top-right
                self._press('click', 1)
            elif self._highlighted(frame, 10, 5) or (self._highlighted(frame, 10, h - 12)
                                                     and not self._highlighted(frame, w - 10, h - 12)):
                counts['confirm'] += 1                     # "X" / "No" / "←" pre-selected on the left:
                self._press('right', 1)                    # move to the accept button on its right
                self._press('click', 1)
            else:
                counts['continue'] += 1                    # message / Yes / Continue
                self._press('click', 1)
        return ', '.join(f'{n} {k}' for k, n in counts.items() if n) or 'no screens'

    def _do_decrypt(self, step):
        try:
            import wallycore as wally
        except ImportError:
            raise FlowError('decrypt needs the wallycore package (pip install wallycore)')
        a = step.arg
        val = {k: self.from_json(self._subst(a[k])) for k in ('privkey', 'pubkey', 'encrypted', 'label')}
        if isinstance(val['label'], str):
            val['label'] = val['label'].encode()
        try:
            plain = wally.aes_cbc_with_ecdh_key(val['privkey'], None, val['encrypted'], val['pubkey'],
                                                val['label'], wally.AES_FLAG_DECRYPT)
        except (ValueError, TypeError) as e:
            raise FlowError(f'decrypt failed: {e}')
        self.vars[a['as']] = bytes(plain)
        return f'{len(plain)} bytes'

    def _do_http(self, step):
        if self.http is None:
            raise FlowError('http requests are not available here')
        params = self._subst(step.arg['request'])
        if not isinstance(params, dict) or not params.get('urls'):
            raise FlowError('http: request must be the "params" of an http_request (with urls)')
        try:
            reply = self.http(params)
        except Exception as e:
            raise FlowError(f'http request to {params["urls"][0]} failed: {e}')
        self.vars[step.arg['as']] = reply
        text = json.dumps(self.to_json(reply))
        return text if len(text) <= 300 else text[:300] + '…'

    def _do_send(self, step):
        import cbor2
        a = step.arg
        if 'cbor' in a:
            data = cbor2.dumps(self.from_json(self._subst(a['cbor'])))
        else:
            data = self.from_json(self._subst(a['data']))
            if isinstance(data, str):
                data = data.encode()
            if not isinstance(data, (bytes, bytearray)):
                raise FlowError('send: data must be "hex:..." or "file:..." bytes')
        self.jade.send_raw(data)
        return f'{len(data)} bytes'

    def _do_receive(self, step):
        a = step.arg
        end = time.time() + a['timeout'] / 1000
        replies = []
        while True:
            if 'count' in a and len(replies) >= a['count']:
                break
            if replies and 'until' in a and replies[-1].get('id') == str(a['until']):
                break
            self._check_stop()
            left = end - time.time()
            if left <= 0:
                raise FlowError(f'receive: got {len(replies)} repl{"y" if len(replies) == 1 else "ies"}, '
                                f'still waiting for {"%d" % a["count"] if "count" in a else "id " + str(a["until"])}')
            reply = self.jade.take_unclaimed(min(left, 0.2))
            if reply is not None:
                replies.append(reply)
        rejected = sum(int(r['error'].get('data') or 0) for r in replies
                       if isinstance(r.get('error'), dict) and r['error'].get('code') == -32600)
        result = {'replies': replies, 'last': replies[-1] if replies else None, 'rejected': rejected}
        self.vars[a['as']] = result
        return f'{len(replies)} repl{"y" if len(replies) == 1 else "ies"}, {rejected} bytes rejected'

    def _do_await(self, step):
        name = step.arg['name']
        if name not in self.jobs:
            raise FlowError(f'no async exec named "{name}"')
        return self._finish_exec(self.jobs.pop(name), step.arg.get('timeout'), step.arg)

    def _finish_exec(self, job, timeout_ms, overrides=None):
        a = dict(job['step'].arg)
        for k in ('expect', 'allowError'):      # await may set/override these
            if overrides and k in overrides:
                a[k] = overrides[k]
        end = time.time() + timeout_ms / 1000 if timeout_ms else None
        while not job['event'].wait(0.1):
            self._check_stop()
            if end and time.time() > end:
                raise FlowError(f'{a["method"]}: no reply within {timeout_ms} ms')
        if job['error']:
            raise FlowError(f'{a["method"]}: {job["error"]}')
        reply = job['reply']
        if 'error' in reply and not a.get('allowError'):
            err = reply['error']
            raise FlowError(f'{a["method"]} returned error {err.get("code")}: {err.get("message")}')
        result = reply.get('result') if 'error' not in reply else {'error': reply['error']}
        self.vars['last'] = result
        if a.get('as'):
            self.vars[a['as']] = result
        if 'expect' in a and self.to_json(result) != self._subst(a['expect']):
            raise FlowError(f'{a["method"]}: expected {json.dumps(a["expect"])}, '
                            f'got {json.dumps(self.to_json(result))}')
        text = json.dumps(self.to_json(result))
        return text if len(text) <= 300 else text[:300] + '…'

    def _do_expect(self, step):
        a = step.arg
        value = self._lookup(a['var'])
        shown = self._fmt(value)
        if 'equals' in a and self.to_json(value) != self._subst(a['equals']):
            raise FlowError(f'{a["var"]} = {shown}, expected {json.dumps(a["equals"])}')
        if 'notEquals' in a and self.to_json(value) == self._subst(a['notEquals']):
            raise FlowError(f'{a["var"]} = {shown}, expected anything else')
        if 'contains' in a and str(self._subst(a['contains'])) not in shown:
            raise FlowError(f'{a["var"]} = {shown} does not contain {a["contains"]!r}')
        if 'startsWith' in a and not shown.startswith(str(self._subst(a['startsWith']))):
            raise FlowError(f'{a["var"]} = {shown} does not start with {a["startsWith"]!r}')
        if 'matches' in a and not re.search(str(a['matches']), shown):
            raise FlowError(f'{a["var"]} = {shown} does not match /{a["matches"]}/')
        return 'ok'

    def _do_log(self, step):
        text = self._subst(step.arg)
        return text if isinstance(text, str) else self._fmt(text)

    def _do_restart(self, step):
        seq, _ = self.jade.get_frame()
        self.jade.restart()
        self.jobs.clear()
        self._settle(seq, change_timeout=2.0)

    def _do_repeat(self, step):
        for i in range(step.arg['times']):
            self._check_stop()
            self._run_steps(step.children, top=False)
        return f'{step.arg["times"]} iterations'


# Reference shown in the UI's Reference tab (keep in sync with _parse_step)
FLOW_COMMANDS = [
    {'name': 'left / right', 'syntax': '- left\n- right: N',
     'description': 'Press the left/right button (N times, default 1). With `settle: true` (default) each press '
                    'waits for the screen to change and stop changing, so the next step sees the final screen.',
     'example': '- right: 2'},
    {'name': 'confirm', 'syntax': '- confirm\n- confirm: N',
     'description': 'Press the select/front button (alias `click`) on the highlighted item.',
     'example': '- confirm'},
    {'name': 'sleep', 'syntax': '- sleep: DURATION',
     'description': 'Pause the flow. A number is milliseconds; strings take a unit: `500ms`, `2s`, `1.5m`. '
                    'Alias: `wait`. Stoppable at any time.',
     'example': '- sleep: 2s'},
    {'name': 'waitForChange', 'syntax': '- waitForChange\n- waitForChange: {timeout: MS}',
     'description': 'Wait until the screen changes (then settles). Fails after the timeout (default 5000 ms). '
                    'Typical after an async exec, to wait for its confirmation screen.',
     'example': '- waitForChange: {timeout: 10000}'},
    {'name': 'screenshot', 'syntax': '- screenshot\n- screenshot: NAME\n- screenshot: {name: NAME, scale: N}',
     'description': 'Save the Jade display (only the device screen) as PNG in '
                    '`data/screenshots/<date>-<flow name>/NN-NAME.png`. `scale` enlarges it with sharp pixels. '
                    'The name may use ${var}.',
     'example': '- screenshot: {name: home, scale: 2}'},
    {'name': 'exec', 'syntax': '- exec: METHOD\n- exec:\n    method: METHOD\n    params: {...}\n    as: NAME\n'
                               '    async: true\n    timeout: MS\n    expect: VALUE\n    allowError: true\n'
                               '    followHttp: false',
     'description': 'Send a Jade RPC message (see the Jade messages list below) and wait for the reply. '
                    'The result is stored in `NAME` (and always in `last`). An error reply fails the flow unless '
                    '`allowError: true` (then the variable holds {error: ...}). `expect` fails the flow if the result '
                    'differs. `timeout` fails it if no reply arrives in time. '
                    'With `async: true` the flow continues immediately, so it can press the buttons a confirmation '
                    'screen needs; collect the reply later with `await`. Bytes are written "hex:..." and ${var} '
                    'inserts earlier results. `"file:path"` sends the bytes of a file inside the jade-web folder. '
                    'Replies asking for an `http_request` (pinserver) are relayed automatically; '
                    '`followHttp: false` returns them instead.',
     'example': '- exec:\n    method: get_xpub\n    params: {network: testnet, path: [0x80000054, 0x80000001, 0x80000000]}\n'
                '    as: xpub'},
    {'name': 'approve', 'syntax': '- approve: NAME\n- approve: {name: NAME, timeout: MS, max: SCREENS, screenshots: PREFIX}',
     'description': 'Accept every screen the device shows until the async exec NAME replies (then collect it '
                    'with `await`). Reads which button is highlighted: top-right ("→" next, "✓") is '
                    'confirmed; on the left (top "X", bottom "No"/"←") it moves right to the accept button '
                    'first; anything else (messages, Yes, Continue) is confirmed. Screens with other '
                    'layouts (eg. "Key Export": ←, ?, Continue) need explicit presses. `screenshots: PREFIX` '
                    '(or `true`) saves every screen it accepts, as PREFIX-1, PREFIX-2, …. Use it for transaction/PSBT, multisig and '
                    'descriptor reviews whose number of screens varies. Default timeout 60000 ms, max 60 screens.',
     'example': '- exec: {method: sign_psbt, params: {network: testnet, psbt: "hex:..."}, async: true, as: r}\n'
                '- approve: r\n- await: r'},
    {'name': 'await', 'syntax': '- await: NAME\n- await: {name: NAME, timeout: MS, expect: VALUE, allowError: true}',
     'description': 'Wait for the reply of an earlier `exec` with `async: true` and `as: NAME`; '
                    'stores the result and applies `expect`/`allowError` (given here, or on the exec).',
     'example': '- await: {name: sig, timeout: 10000}'},
    {'name': 'decrypt', 'syntax': '- decrypt: {as: NAME, privkey: "hex:...", pubkey: VALUE, encrypted: VALUE, label: TEXT}',
     'description': 'Decrypt data Jade returned encrypted to an ephemeral host key (ECDH shared secret + AES, as '
                    '`wally.aes_cbc_with_ecdh_key`), eg. `get_bip85_bip39_entropy`. `privkey` is the host key '
                    'whose public key was sent; `pubkey` and `encrypted` come from the reply. Needs the '
                    'wallycore Python package.',
     'example': '- decrypt: {as: entropy, privkey: "hex:...", pubkey: "${r.pubkey}", encrypted: "${r.encrypted}", '
                'label: bip85_bip39_entropy}'},
    {'name': 'http', 'syntax': '- http: {request: "${h.http_request.params}", as: NAME}',
     'description': 'Perform an `http_request` the firmware asked for (eg. the pinserver call of '
                    '`debug_handshake`), as jade-web does automatically, and store the reply as {body}. '
                    'Use it after an exec with `followHttp: false`, to inspect the request first; then send '
                    'the body on with the method named in `on-reply`.',
     'example': '- exec: {method: debug_handshake, followHttp: false, as: h}\n'
                '- http: {request: "${h.http_request.params}", as: resp}\n'
                '- exec: {method: pin, params: "${resp.body}", expect: true}'},
    {'name': 'send', 'syntax': '- send: {data: "hex:..."}\n- send: {cbor: VALUE}',
     'description': 'Write raw bytes (or a value encoded as CBOR) straight to the serial stream, for protocol '
                    'tests: malformed, partial, concatenated or oversized messages. Replies are not '
                    'matched to an exec: collect them with `receive`.',
     'example': '- send: {cbor: {id: "42", method: get_version_info}}\n- receive: {as: r, until: "42"}'},
    {'name': 'receive', 'syntax': '- receive: {as: NAME, count: N, timeout: MS}\n- receive: {as: NAME, until: ID}',
     'description': 'Collect the replies no exec is waiting for (eg. to `send`), until N arrived or one with '
                    'the given id. Stores `{replies, last, rejected}`; `rejected` adds up the byte counts the '
                    'firmware reports in "Invalid RPC Request message" errors. Default timeout 10000 ms.',
     'example': '- receive: {as: r, until: ent}\n- expect: {var: r.rejected, equals: 24}'},
    {'name': 'expect', 'syntax': '- expect: {var: NAME[.path], equals|notEquals|contains|startsWith|matches: VALUE}',
     'description': 'Assert on a stored result. `equals`/`notEquals` compare the value (which may be '
                    '"${other}"); `contains`, `startsWith` and '
                    '`matches` (regular expression) work on its text form. Paths reach into results: '
                    '`info.JADE_STATE`, `list.0`.',
     'example': '- expect: {var: info.JADE_STATE, equals: READY}'},
    {'name': 'log', 'syntax': '- log: TEXT',
     'description': 'Print a line in the flow output; `${var}` and `${var.key}` are substituted.',
     'example': '- log: "state is ${info.JADE_STATE}"'},
    {'name': 'repeat', 'syntax': '- repeat:\n    times: N\n    steps:\n      - ...',
     'description': 'Run the nested steps N times.',
     'example': '- repeat:\n    times: 3\n    steps:\n      - right\n      - screenshot: page'},
    {'name': 'restart', 'syntax': '- restart',
     'description': 'Power-cycle the emulated Jade. Storage (NVS) is kept; an unlocked or debug wallet and any '
                    'pending async exec are lost.',
     'example': '- restart'},
    {'name': 'config', 'syntax': 'name: NAME\nsettle: true|false\ntimeout: SECONDS (default 600)\n'
                                 'firmwareErrors: warn|fail|ignore\nignoreErrors: [REGEX, ...]\n---\n- ...steps',
     'description': 'Optional document before `---`. `name` labels the run and its screenshot folder; '
                    '`settle: false` makes button presses only pause 150 ms instead of waiting for the screen. '
                    '`firmwareErrors` decides what an ERROR logged by the firmware during the run does: '
                    '`warn` (default) records it on the step and the run, `fail` fails the step, `ignore`. '
                    '`ignoreErrors` lists regular expressions of expected errors to skip. '
                    '`timeout` is the maximum flow duration in seconds (default 600). '
                    'Alternatively write one mapping with a `steps:` list.',
     'example': 'name: my-flow\nsettle: true\ntimeout: 600\n---'},
]
