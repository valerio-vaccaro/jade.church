#!/usr/bin/env python3
"""jade-web: run the Jade firmware (libjade) locally and drive it from a browser.

  - http://HOST:PORT/          web UI: live screen, buttons/keyboard, camera, RPC console
  - tcp:BRIDGE_HOST:BRIDGE_PORT raw Jade CBOR-RPC port for external clients, eg.
        from jadepy import JadeAPI
        jade = JadeAPI.create_serial('tcp:127.0.0.1:30121'); jade.connect()

WARNING: libjade is experimental, development/testing only. Secrets held by the
emulated device are readable by anything that can reach these ports.
"""
import argparse
import collections
import json
import logging
import os
import re
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import cbor2

from flow import FLOW_COMMANDS, FlowError, FlowRun, count_steps, parse_flow
from report import export_zip
from firmware import default_firmware, describe as describe_firmware, list_firmware
from reference import build_reference
from libjade_host import LOG_LEVELS, JadeRpcError, LibJadeHost

logger = logging.getLogger('jade-web')

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
WEB_DIR = os.path.join(ROOT, 'server', 'static')   # the browser UI, served as-is
FLOWS_DIR = os.path.join(ROOT, 'flows')
JADE_DIR = os.path.join(ROOT, 'jade')
FONTS_DIR = os.path.join(JADE_DIR, 'main', 'fonts')   # firmware fonts, shown by the font designer
LOGOS_DIR = os.path.join(JADE_DIR, 'logo')            # compressed firmware logos, shown by logo viewer
CAMERA_FRAME_SIZE = 320 * 240  # CAMERA_IMAGE_WIDTH x CAMERA_IMAGE_HEIGHT, 8-bit grayscale
MAX_BODY = 4 * 1024 * 1024
STATIC_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
                '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
                '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json'}


def fonts_source(source_dir=FONTS_DIR):
    """Jade revision and local changes for a source asset directory."""
    import subprocess

    def git(*args):
        return subprocess.run(['git', '-C', JADE_DIR, *args], check=True, capture_output=True,
                              text=True, timeout=5).stdout.strip()
    try:
        commit, short, date, subject = git('log', '-1', '--format=%H%n%h%n%cs%n%s').split('\n', 3)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None                     # not a git checkout (or git missing)
    try:
        branch = git('branch', '--show-current') or 'detached HEAD'
    except (OSError, subprocess.SubprocessError):
        branch = 'unknown'
    info = {'commit': commit, 'short': short, 'date': date, 'subject': subject, 'branch': branch,
            'tags': [], 'describe': None, 'modified': [], 'untracked': []}
    try:
        info['tags'] = git('tag', '--points-at', 'HEAD').split()
        info['describe'] = git('describe', '--tags', '--always')
        rel = os.path.relpath(source_dir, JADE_DIR)
        for line in git('status', '--porcelain', '--', rel).splitlines():
            name = os.path.basename(line[3:].strip().strip('"'))
            (info['untracked'] if line.startswith('??') else info['modified']).append(name)
    except (OSError, subprocess.SubprocessError):
        pass
    return info


def project_version():
    """Return the exact tag for a clean tagged checkout, otherwise the short commit id."""
    import subprocess

    def git(*args):
        return subprocess.run(['git', '-C', ROOT, *args], check=True, capture_output=True,
                              text=True).stdout.strip()

    try:
        commit = git('rev-parse', '--short', 'HEAD')
        if git('status', '--porcelain', '--untracked-files=normal'):
            return commit
        try:
            return git('describe', '--tags', '--exact-match', 'HEAD')
        except subprocess.CalledProcessError:
            return commit
    except (OSError, subprocess.CalledProcessError):
        return 'uncommitted'


class EventBus:
    """Fan-out of UI events (frames, logs, bridge activity) to SSE subscribers."""

    def __init__(self, maxlen=1000):
        self._events = collections.deque(maxlen=maxlen)
        self._seq = 0
        self._cond = threading.Condition()
        self.on_publish = None                # optional hook(event), eg. the log book

    def publish(self, kind, **data):
        event = {'type': kind, 't': time.time(), **data}
        with self._cond:
            self._seq += 1
            self._events.append((self._seq, event))
            self._cond.notify_all()
        if self.on_publish:
            self.on_publish(event)

    def wait(self, after, timeout):
        """Return [(seq, event)] newer than `after`, waiting up to `timeout`."""
        with self._cond:
            if self._seq <= after:
                self._cond.wait(timeout)
            return [(s, e) for s, e in self._events if s > after]

    @property
    def seq(self):
        return self._seq


#
# JSON <-> CBOR value conversion for the web console.
# Byte strings are shown/entered as "hex:<hex digits>".
#
def to_json(value):
    if isinstance(value, (bytes, bytearray)):
        return 'hex:' + bytes(value).hex()
    if isinstance(value, dict):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json(v) for v in value]
    return value


def read_project_file(rel):
    """Bytes of a file inside the jade-web folder (eg. jade/tests/rpc/data/...), for "file:" params."""
    full = os.path.realpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT + os.sep) or not os.path.isfile(full):
        raise ValueError(f'file:{rel} is not a file inside {ROOT}')
    with open(full, 'rb') as f:
        return f.read()


def from_json(value):
    if isinstance(value, str) and value.startswith('hex:'):
        return bytes.fromhex(value[4:])
    if isinstance(value, str) and value.startswith('file:'):
        return read_project_file(value[5:])
    if isinstance(value, dict):
        return {k: from_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [from_json(v) for v in value]
    return value


def http_request(params):
    """Perform an 'http_request' asked for by the firmware (eg. pinserver handshake).
    Mirrors jadepy's default _http_request()."""
    use_json = params.get('accept') in ('json', 'application/json')
    url = next(u for u in params['urls'] if u and not (urlsplit(u).hostname or '').endswith('.onion'))
    data = None
    if params['method'] == 'POST':
        body = params.get('data')
        data = json.dumps(body).encode() if use_json else (body.encode() if isinstance(body, str) else body)
    req = urllib.request.Request(url, data=data, method=params['method'],
                                 headers={'Content-Type': 'application/json'} if use_json else {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        content = resp.read()
    return {'body': json.loads(content) if use_json else content.decode()}


class TcpBridge:
    """Serve the libjade serial channel over TCP, so standard Jade clients
    (jadepy `tcp:HOST:PORT`, test_jade.py, etc.) can drive the same instance
    the browser is showing. Replies are routed back to the requesting client by id."""

    def __init__(self, host, bus, bind_host, port):
        self.host = host
        self.bus = bus
        self.bind_host = bind_host
        self.port = port
        self._sock = None

    def start(self):
        self._sock = socket.socket(socket.AF_INET6 if ':' in self.bind_host else socket.AF_INET)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self.bind_host, self.port))
        self._sock.listen(4)
        self.port = self._sock.getsockname()[1]
        threading.Thread(target=self._accept_loop, daemon=True, name='bridge-accept').start()

    def stop(self):
        if self._sock:
            self._sock.close()
            self._sock = None

    def _accept_loop(self):
        while self._sock:
            try:
                conn, addr = self._sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve_client, args=(conn, addr), daemon=True).start()

    def _serve_client(self, conn, addr):
        peer = f'{addr[0]}:{addr[1]}'
        self.bus.publish('activity', text=f'bridge client connected {peer}')
        write_lock = threading.Lock()

        def reply_cb(reply):
            try:
                with write_lock:
                    conn.sendall(cbor2.dumps(reply))
            except OSError:
                pass
            status = 'error' if 'error' in reply else 'ok'
            self.bus.publish('activity', text=f'bridge {peer} <- id={reply.get("id")} {status}')

        try:
            with conn, conn.makefile('rb') as stream:
                while True:
                    request = cbor2.load(stream)  # raises at EOF
                    if not isinstance(request, dict) or 'method' not in request or 'id' not in request:
                        raise ValueError(f'invalid request {request!r}')
                    self.bus.publish('activity',
                                     text=f'bridge {peer} -> {request["method"]} id={request["id"]}')
                    self.host.send_serial(request, callback=reply_cb)
        except Exception as e:
            logger.debug('bridge client %s finished: %s', peer, e)
        self.bus.publish('activity', text=f'bridge client disconnected {peer}')


class App:
    def __init__(self, args):
        self.args = args
        self.bus = EventBus()
        self.jade = LibJadeHost(
            args.lib, log_level=args.log_level, nvs_file=args.nvs_file,
            on_log=lambda text: self.bus.publish('log', text=text),
            on_frame=lambda seq: self.bus.publish('frame', seq=seq))
        self.bridge = None
        self.flow = None
        self.suite = None
        self._suite_thread = None
        self._reference = None
        # Log book: firmware output, device messages and activity, for download
        self.logbook = collections.deque(maxlen=50000)
        self.bus.on_publish = self._record_log
        self._flow_ids = 0
        self._flow_lock = threading.Lock()

    # -- logs
    def _record_log(self, event):
        kind = event['type']
        if kind in ('log', 'fwlog', 'activity'):
            self.logbook.append((event['t'], kind, str(event.get('text', '')).rstrip('\n')))

    def firmware_log(self, line):
        """A line the firmware (or the process) printed: to the web UI as a 'fwlog' event."""
        if not line.strip():
            return
        m = FW_LOG_RE.match(line)
        level = m.group(1) if m else None
        self.bus.publish('fwlog', text=line, level=level)
        f = self.flow
        if level == 'ERROR' and f is not None and f.status == 'running':
            f.firmware_error(line)                   # recognised as an error of the running flow

    def logs_text(self):
        out = []
        for t, kind, text in list(self.logbook):
            stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t)) + f'.{int(t % 1 * 1000):03d}'
            out.append(f'{stamp} [{ {"fwlog": "firmware", "log": "device", "activity": "jade-web"}[kind]}] {text}')
        return '\n'.join(out) + '\n'

    def set_log_level(self, level):
        if level not in LOG_LEVELS:
            raise ValueError(f'log level must be one of {", ".join(LOG_LEVELS)}')
        self.jade.set_log_level(level)
        self.args.log_level = level
        self.bus.publish('activity', text=f'firmware log level: {level}')

    # -- firmware builds
    def firmware(self):
        items = list_firmware(FIRMWARE_DIR)
        active = os.path.realpath(self.args.lib)
        return {'active': os.path.basename(self.args.lib),
                'default': items[0]['file'] if items else None,
                'items': [{k: v for k, v in i.items() if k != 'path'} | {
                    'active': os.path.realpath(i['path']) == active} for i in items]}

    def _suite_pending_files(self, suite):
        pending = list(suite.get('pending', []))
        current = suite.get('current')
        current_label = f'{suite["name"]}/{current}' if current and suite['name'] != 'all flows' else current
        last_file = self.flow.meta.get('file') if self.flow and self.flow.status == 'running' else None
        if current_label and last_file != current_label:
            pending.insert(0, current_label)
        return pending

    def cancel_flows(self, reason):
        """Stop an active flow/suite before restarting or replacing the emulator."""
        with self._flow_lock:
            suite = self.suite
            pending = self._suite_pending_files(suite) if suite and not suite.get('cancel_reason') else []
            if suite:
                if pending:
                    suite.setdefault('cancelled_files', []).extend(pending)
                    suite['cancelled'] += len(pending)
                suite['pending'] = []
                suite['cancel_reason'] = suite.get('cancel_reason') or reason
                suite['stop'].set()
            flow = self.flow if self.flow and self.flow.status == 'running' else None
        if suite:
            for pending_file in pending:
                msg = f'pending flow cancelled ({reason}): {pending_file}'
                self.bus.publish('activity', text=msg)
                self.bus.publish('suite', event='cancelled_flow', suite=suite['id'],
                                 file=pending_file, reason=reason)
        if flow:
            name = flow.meta.get('file') or flow.name
            cancel_reason = suite.get('cancel_reason') if suite else reason
            flow.stop(reason=cancel_reason or reason)
            self.bus.publish('activity', text=f'flow cancelled ({cancel_reason or reason}): {name}')
            flow.join(timeout=10)
            if flow.status == 'running':
                raise RuntimeError('flow did not stop in time; emulator was not restarted')
        suite_thread = self._suite_thread if suite else None
        if suite_thread:
            suite_thread.join(timeout=10)
            if suite_thread.is_alive():
                raise RuntimeError('suite did not stop in time; emulator was not restarted')

    def restart_emulator(self):
        self.cancel_flows('emulator restarted')
        with self._flow_lock:
            if self.busy():
                raise RuntimeError('another flow started before emulator restart')
            self.jade.restart()
        self.bus.publish('activity', text='emulator stopped and restarted')

    def switch_firmware(self, file):
        """Stop the current emulator and start the selected firmware build."""
        item = next((i for i in list_firmware(FIRMWARE_DIR) if i['file'] == file), None)
        if item is None:
            raise LookupError(f'no firmware "{file}" in firmware/')
        if (item.get('build_type') or '').lower() == 'sanitize':
            raise ValueError('Sanitize builds need the address sanitizer preloaded: start them with '
                             f'LD_PRELOAD=$(gcc -print-file-name=libasan.so) ./run.sh --lib firmware/{file}')
        self.cancel_flows(f'firmware changed to {file}')

        with self._flow_lock:
            if self.busy():
                raise RuntimeError('another flow started while firmware was changing')
            self.jade.switch_library(item['path'], item['label'])
            self.args.lib = item['path']
            self._build_info = None
            remember_firmware(item['path'])
        self.bus.publish('activity', text=f'firmware: {item["label"]} ({file})')
        self.bus.publish('firmware', file=file, label=item['label'],
                         width=self.jade.width, height=self.jade.height)
        return item

    def build_info(self):
        """Firmware version and build options, from the .json the build script writes next to the binary."""
        if getattr(self, '_build_info', None) is None:
            import subprocess
            try:
                version = subprocess.run(['git', '-C', JADE_DIR, 'describe', '--tags', '--always', '--dirty'],
                                         capture_output=True, text=True, timeout=5).stdout.strip()
            except Exception:
                version = ''
            build, firmware = {}, {}
            try:                                 # written by scripts/build_libjade.sh next to the binary
                with open(self.args.lib + '.json', encoding='utf-8') as f:
                    firmware = json.load(f)
                build = {'CMAKE_BUILD_TYPE': firmware.get('build_type'), 'CI': 'CI' if firmware.get('ci') else '0',
                         'JADE_DISPLAY': firmware.get('display'), 'LOG': 'LOG', 'CAMERA': 'CAMERA'}
            except (OSError, ValueError):
                pass
            if firmware.get('jade_version'):
                version = firmware['jade_version']
            self._build_info = {'jade_version': version, 'build': build, 'firmware': {
                'file': os.path.basename(self.args.lib), **firmware}}
        return self._build_info

    def reference(self):
        if self._reference is None:
            try:
                methods = build_reference(JADE_DIR)
            except Exception as e:  # never break the UI over docs parsing
                logger.exception('building the Jade message reference failed')
                methods = [{'method': f'(reference unavailable: {e})', 'group': 'always', 'flags': [],
                            'description': '', 'params': None, 'example_ok': False, 'documented': False,
                            'sections': []}]
            self._reference = {'commands': FLOW_COMMANDS, 'methods': methods}
        return self._reference

    def busy(self):
        return (self.flow is not None and self.flow.status == 'running') or self.suite is not None

    def firmware_summary(self):
        """The emulated firmware, as recorded with each run."""
        fw = self.build_info().get('firmware') or {}
        return {'file': fw.get('file') or os.path.basename(self.args.lib),
                'label': describe_firmware(fw) if fw.get('board') else os.path.basename(self.args.lib),
                'board': fw.get('board'), 'jade_version': fw.get('jade_version') or self.build_info().get('jade_version'),
                'ci': fw.get('ci'), 'build_type': fw.get('build_type'), 'options': fw.get('options')}

    def start_flow(self, source, meta=None, _from_suite=False, step=False):
        config, steps = parse_flow(source)  # raises FlowError
        meta = {**(meta or {}), 'firmware': self.firmware_summary()}   # remember what it ran on
        with self._flow_lock:
            if _from_suite and self.suite and self.suite['stop'].is_set():
                return None
            if (self.flow and self.flow.status == 'running') or (self.suite and not _from_suite):
                raise RuntimeError('a flow or test suite is already running')
            self._flow_ids += 1
            run_id = self._flow_ids

            def emit(evt):
                self.bus.publish('flow', run=run_id, **to_json(evt))
            self.flow = FlowRun(run_id, config, steps, self.jade,
                                rpc=lambda m, p, follow=True: self.rpc(m, p, follow)[-1]['reply'], emit=emit,
                                runs_dir=self.args.runs_dir, to_json=to_json, from_json=from_json,
                                source=source, meta=meta, http=http_request, step_mode=step)
            self.flow.start()
            return self.flow

    def start_suite(self, folder=''):
        """Run every flow under flows/<folder>/ (all of flows/ when folder is empty), recursively,
        one after the other: each folder's own flows first, then its subfolders, alphabetically."""
        root = os.path.realpath(FLOWS_DIR)
        base = os.path.realpath(os.path.join(FLOWS_DIR, folder))
        if not (base == root or base.startswith(root + os.sep)) or not os.path.isdir(base):
            raise ValueError(f'no flow folder "{folder}"')
        files = []
        for d, subdirs, names in os.walk(base):
            subdirs.sort()
            files += sorted(os.path.relpath(os.path.join(d, n), base) for n in names if n.endswith(('.yaml', '.yml')))
        if not files:
            raise ValueError(f'no flows in "{folder or "flows/"}"')
        folder = folder.strip('/')
        label = folder or 'all flows'
        sources = {}
        for f in files:                        # validate all before starting
            with open(os.path.join(base, f), encoding='utf-8') as fh:
                sources[f] = fh.read()
            try:
                parse_flow(sources[f])
            except FlowError as e:
                raise FlowError(f'{folder}/{f}: {e}')
        with self._flow_lock:
            if self.busy():
                raise RuntimeError('a flow or test suite is already running')
            suite = {'id': time.strftime('%Y%m%d-%H%M%S'), 'name': label, 'total': len(files),
                     'index': 0, 'passed': 0, 'failed': 0, 'cancelled': 0,
                     'pending': list(files), 'cancelled_files': [], 'current': None, 'cancel_reason': None,
                     'started': time.time(), 'stop': threading.Event()}
            self.suite = suite

        def run():
            results, t0 = [], time.time()
            self.bus.publish('suite', event='start', suite=suite['id'], name=label, total=len(files))
            try:
                for i, f in enumerate(files):
                    if suite['stop'].is_set():
                        break
                    suite['current'] = f
                    suite['pending'] = files[i + 1:]
                    meta = {'file': f'{folder}/{f}' if folder else f,
                            'suite': {'id': suite['id'], 'name': label, 'index': i + 1, 'total': len(files)}}
                    suite['index'] = i + 1
                    flow = self.start_flow(sources[f], meta=meta, _from_suite=True)
                    if flow is None:
                        break
                    flow.join()
                    results.append(flow.status)
                    if flow.status == 'passed':
                        suite['passed'] += 1
                    elif flow.status == 'cancelled':
                        suite['cancelled'] += 1
                    else:
                        suite['failed'] += 1
            except Exception as e:
                logger.exception('suite failed')
                results.append('failed')
                self.bus.publish('activity', text=f'suite error: {e}')
            finally:
                self.suite = None
                if suite.get('cancel_reason'):
                    status = 'cancelled'
                elif suite['stop'].is_set():
                    status = 'stopped'
                else:
                    status = 'passed' if results and all(r == 'passed' for r in results) else 'failed'
                self.bus.publish('suite', event='end', suite=suite['id'], name=label, total=len(files),
                                 status=status, passed=results.count('passed'),
                                 failed=results.count('failed'), cancelled=suite['cancelled'],
                                 seconds=round(time.time() - t0, 2))
        self._suite_thread = threading.Thread(target=run, daemon=True, name='suite')
        self._suite_thread.start()
        return suite

    def stop_all(self):
        with self._flow_lock:
            suite = self.suite
            pending = self._suite_pending_files(suite) if suite and not suite.get('cancel_reason') else []
            if suite:
                if pending:
                    suite.setdefault('cancelled_files', []).extend(pending)
                    suite['cancelled'] += len(pending)
                suite['pending'] = []
                suite['cancel_reason'] = suite.get('cancel_reason') or 'suite stopped'
                suite['stop'].set()
            flow = self.flow if self.flow and self.flow.status == 'running' else None
        for pending_file in pending:
            reason = suite['cancel_reason']
            self.bus.publish('activity', text=f'pending flow cancelled ({reason}): {pending_file}')
            self.bus.publish('suite', event='cancelled_flow', suite=suite['id'],
                             file=pending_file, reason=reason)
        if flow:
            if suite:
                reason = suite['cancel_reason']
                flow.stop(reason=reason)
                self.bus.publish('activity', text=f'flow cancelled ({reason}): {flow.meta.get("file") or flow.name}')
            else:
                flow.stop()

    # -- run history (one folder per run in runs_dir, holding run.json + screenshots)
    def _run_dir(self, name):
        base = os.path.realpath(self.args.runs_dir)
        full = os.path.realpath(os.path.join(base, name))
        if os.sep in name or not full.startswith(base + os.sep) or not os.path.isdir(full):
            return None
        return full

    def list_runs(self):
        out = []
        base = self.args.runs_dir
        for name in os.listdir(base) if os.path.isdir(base) else []:
            path = os.path.join(base, name, 'run.json')
            try:
                with open(path, encoding='utf-8') as f:
                    rec = json.load(f)
            except (OSError, ValueError):
                continue
            rec.pop('records', None)
            rec.pop('source', None)
            if self.flow and self.flow.dir_name == name and self.flow.status == 'running':
                rec.update(self.flow.summary())
            out.append(rec)
        out.sort(key=lambda r: r.get('started') or 0, reverse=True)
        return out

    def get_run(self, name):
        d = self._run_dir(name)
        if d is None:
            return None
        with open(os.path.join(d, 'run.json'), encoding='utf-8') as f:
            return json.load(f)

    def status(self):
        """What is running now: the flow (with step progress) and the suite (with its queue)."""
        f, suite = self.flow, self.suite
        flow = None
        if f is not None and f.status == 'running':
            done = sum(1 for r in f.records if r['status'] != 'running')
            flow = {'name': f.name, 'file': f.meta.get('file'), 'started': f.started,
                    'steps_done': done, 'steps_total': count_steps(f.steps),
                    'paused_line': f.paused_line, 'step_mode': f.step_mode,
                    'in_suite': bool(f.meta.get('suite')),
                    'failed_steps': sum(1 for r in f.records if r['status'] in ('failed', 'stopped'))}
        return {'flow': flow,
                'suite': {k: v for k, v in suite.items() if k != 'stop'} if suite else None}

    def rerun(self, name):
        """Run a past run's flow again. A flow that came from a file under flows/ (eg. a suite
        run) is re-read from that file, so edits and regenerated flows are picked up;
        otherwise the source saved with the run is used."""
        rec = self.get_run(name)
        if rec is None:
            raise LookupError('run not found')
        meta, source = {}, rec.get('source') or ''
        rel = rec.get('file')
        if rel:
            full = os.path.realpath(os.path.join(FLOWS_DIR, rel))
            if full.startswith(os.path.realpath(FLOWS_DIR) + os.sep) and os.path.isfile(full):
                with open(full, encoding='utf-8') as f:
                    source = f.read()
                meta['file'] = rel
        if not source:
            raise LookupError('this run has no saved flow source')
        meta['rerun_of'] = name
        return self.start_flow(source, meta)

    def delete_runs(self, names):
        import shutil
        deleted, skipped = [], []
        for name in names:
            d = self._run_dir(name)
            if d is None or not os.path.exists(os.path.join(d, 'run.json')):
                skipped.append(name)
            elif self.flow and self.flow.dir_name == name and self.flow.status == 'running':
                skipped.append(name)            # never delete the run in progress
            else:
                shutil.rmtree(d)
                deleted.append(name)
        if deleted:
            self.bus.publish('runs', event='deleted', dirs=deleted)
        return deleted, skipped

    def rpc(self, method, params, follow_http=True):
        """Blocking Jade RPC from the web console, following any http_request round trips
        (unless follow_http is False: then the http_request result is returned as is)."""
        trace = []
        while True:
            reply = self.jade.call(method, params)
            trace.append({'method': method, 'reply': reply})
            # Large replies (eg. a signed psbt) come in chunks: fetch the rest with
            # get_extended_data and join them, as jadepy does
            while isinstance(reply.get('result'), bytes) and reply.get('seqnum', 0) < reply.get('seqlen', 0):
                more = self.jade.call('get_extended_data', {
                    'origid': reply['id'], 'orig': method,
                    'seqnum': reply['seqnum'] + 1, 'seqlen': reply['seqlen']})
                trace.append({'method': 'get_extended_data', 'reply': more})
                if 'error' in more or not isinstance(more.get('result'), bytes):
                    reply = more
                    break
                reply = {**more, 'id': reply['id'], 'result': reply['result'] + more['result']}
            if 'seqnum' in reply and 'error' not in reply:
                reply = {k: v for k, v in reply.items() if k not in ('seqnum', 'seqlen')}
                trace[-1] = {'method': trace[-1]['method'], 'reply': reply}
            result = reply.get('result')
            if not follow_http or not isinstance(result, dict) or 'http_request' not in result:
                return trace
            req = result['http_request']
            self.bus.publish('activity', text=f'http_request {req["params"].get("urls")}')
            method, params = req['on-reply'], http_request(req['params'])['body']


FIRMWARE_DIR = os.path.join(ROOT, 'firmware')
FIRMWARE_STATE = os.path.join(ROOT, 'data', 'last_firmware')


def remembered_firmware():
    try:
        with open(FIRMWARE_STATE, encoding='utf-8') as f:
            name = f.read().strip()
    except OSError:
        return None
    return next((item['path'] for item in list_firmware(FIRMWARE_DIR)
                 if item['file'] == name), None)


def remember_firmware(path):
    real = os.path.realpath(path)
    item = next((i for i in list_firmware(FIRMWARE_DIR)
                 if os.path.realpath(i['path']) == real), None)
    if not item:
        return
    os.makedirs(os.path.dirname(FIRMWARE_STATE), exist_ok=True)
    tmp = FIRMWARE_STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(item['file'] + '\n')
    os.replace(tmp, FIRMWARE_STATE)
FW_LOG_RE = re.compile(r'^(VERBOSE|DEBUG|INFO|WARN|ERROR):')


class StdioCapture:
    """The firmware logs with fprintf(stderr): route this process's stdout/stderr through a
    pipe, so each line still reaches the terminal and is also handed to `on_line` (the web
    UI). Python's own output and logging keep going straight to the terminal."""

    def __init__(self, on_line):
        self.on_line = on_line
        self.term = os.dup(2)
        r, w = os.pipe()
        sys.stdout.flush(); sys.stderr.flush()
        os.dup2(w, 1)
        os.dup2(w, 2)
        os.close(w)
        sys.stdout = os.fdopen(os.dup(self.term), 'w', buffering=1)
        sys.stderr = os.fdopen(os.dup(self.term), 'w', buffering=1)
        for h in logging.root.handlers:
            if isinstance(h, logging.StreamHandler):
                h.setStream(sys.stderr)
        self._reader = os.fdopen(r, 'rb', buffering=0)
        threading.Thread(target=self._pump, daemon=True, name='stdio-capture').start()

    def _pump(self):
        buf = b''
        while True:
            chunk = self._reader.read(4096)
            if not chunk:
                return
            os.write(self.term, chunk)
            buf += chunk
            *lines, buf = buf.split(b'\n')
            for line in lines:
                try:
                    self.on_line(line.decode('utf-8', 'replace').rstrip('\r'))
                except Exception:
                    pass


def start_test_pinserver(args):
    """Start scripts/run_pinserver.py (a local blind PIN server with the Jade repo's *test* key,
    used by flows/jade-tests/93-pinserver.yaml) unless disabled, already running, or its
    Python dependencies are missing. Returns the subprocess, or None."""
    import importlib.util
    import subprocess
    port = args.test_pinserver_port
    if port < 0:
        return None
    missing = [m for m in ('flask', 'dotenv', 'wallycore') if importlib.util.find_spec(m) is None]
    if missing or not os.path.isfile(os.path.join(JADE_DIR, 'pinserver', 'flaskserver.py')):
        logger.info('Test pinserver not started (missing: %s)', ', '.join(missing) or 'jade/pinserver')
        return None
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            logger.info('Test pinserver: port %d already in use, assuming it is running', port)
            args.test_pinserver = f'http://127.0.0.1:{port} (started elsewhere)'
            return None
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'scripts', 'run_pinserver.py'), '--port', str(port),
                             '--data', os.path.join(ROOT, 'data', 'pinserver'), '--exit-with-parent'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    args.test_pinserver = f'http://127.0.0.1:{port}'
    logger.info('Test pinserver: %s (pid %d)', args.test_pinserver, proc.pid)
    return proc


def make_handler(app):
    allowed_hosts = set()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'jade-web'

        def log_message(self, fmt, *a):
            logger.debug('%s ' + fmt, self.address_string(), *a)

        # -- guards against other web pages / DNS rebinding reaching the device
        def _check_origin(self):
            host = self.headers.get('Host', '')
            if allowed_hosts and host not in allowed_hosts:
                self._send_json({'error': 'bad host'}, HTTPStatus.FORBIDDEN)
                return False
            origin = self.headers.get('Origin')
            if origin and urlsplit(origin).netloc != host:
                self._send_json({'error': 'cross-origin request refused'}, HTTPStatus.FORBIDDEN)
                return False
            return True

        def _send(self, status, body, ctype, extra=None):
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, obj, status=HTTPStatus.OK):
            self._send(status, json.dumps(obj).encode(), 'application/json')

        def _body(self):
            return self._request_body

        def _read_body(self):
            """Read the whole request body up front: a body left unread on a keep-alive
            connection would be parsed as the start of the next request."""
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_BODY:
                self.close_connection = True          # don't try to resync the stream
                return None
            return self.rfile.read(n)

        def do_GET(self):
            if not self._check_origin():
                return
            path = urlsplit(self.path).path
            if path == '/api/events':
                return self._sse()
            if path == '/api/info':
                return self._send_json({
                    'version': project_version(),
                    'width': app.jade.width, 'height': app.jade.height,
                    'bridge': {'host': app.bridge.bind_host, 'port': app.bridge.port} if app.bridge else None,
                    'nvs_file': app.args.nvs_file, 'lib': app.args.lib,
                    'log_level': app.args.log_level, 'runs_dir': app.args.runs_dir,
                    'test_pinserver': getattr(app.args, 'test_pinserver', None),
                    'web': f'{app.args.host}:{app.args.port}', **app.build_info()})
            if path == '/api/frame':
                seq, frame = app.jade.get_frame()
                if frame is None:
                    return self._send(HTTPStatus.SERVICE_UNAVAILABLE, b'', 'application/octet-stream')
                return self._send(HTTPStatus.OK, frame, 'application/octet-stream', {
                    'X-Frame-Seq': str(seq), 'X-Width': str(app.jade.width),
                    'X-Height': str(app.jade.height)})
            if path == '/api/reference':
                return self._send_json(app.reference())
            if path == '/api/flows':
                names = sorted(os.path.relpath(os.path.join(d, f), FLOWS_DIR)
                               for d, _, files in os.walk(FLOWS_DIR) for f in files
                               if f.endswith(('.yaml', '.yml')))
                return self._send_json({'flows': names})
            if path.startswith('/api/flows/'):
                return self._file(FLOWS_DIR, path[len('/api/flows/'):], 'text/yaml; charset=utf-8')
            if path == '/api/fonts':
                names = sorted((f for f in os.listdir(FONTS_DIR) if f.endswith('.c')), key=str.lower) \
                    if os.path.isdir(FONTS_DIR) else []
                return self._send_json({'dir': os.path.relpath(FONTS_DIR, ROOT), 'fonts': names,
                                        'jade': fonts_source()})
            if path.startswith('/api/fonts/'):
                return self._file(FONTS_DIR, path[len('/api/fonts/'):], 'text/plain; charset=utf-8')
            if path == '/api/logos':
                names = sorted((f for f in os.listdir(LOGOS_DIR) if f.endswith('.bin.gz')), key=str.lower) \
                    if os.path.isdir(LOGOS_DIR) else []
                return self._send_json({'dir': os.path.relpath(LOGOS_DIR, ROOT), 'logos': names,
                                        'jade': fonts_source(LOGOS_DIR)})
            if path.startswith('/api/logos/'):
                return self._file(LOGOS_DIR, path[len('/api/logos/'):], 'application/octet-stream')
            if path.startswith('/screenshots/'):
                return self._file(app.args.runs_dir, path[len('/screenshots/'):], 'image/png')
            if path == '/api/runs':
                return self._send_json({'runs': app.list_runs(),
                                        'busy': app.busy(),
                                        'suite': {k: v for k, v in app.suite.items() if k != 'stop'}
                                        if app.suite else None})
            if path.startswith('/api/runs/'):
                rec = app.get_run(path[len('/api/runs/'):])
                return self._send_json(rec) if rec else self._send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
            if path == '/api/logs':
                stamp = time.strftime('%Y%m%d-%H%M%S')
                return self._send(HTTPStatus.OK, app.logs_text().encode(), 'text/plain; charset=utf-8',
                                  {'Content-Disposition': f'attachment; filename="jade.church-log-{stamp}.txt"'})
            if path == '/api/firmware':
                return self._send_json(app.firmware())
            if path == '/api/status':
                return self._send_json(app.status())
            if path == '/api/flow':
                f = app.flow
                return self._send_json(None if f is None else {
                    'id': f.id, 'status': f.status, 'error': f.error, 'screenshots': f.screenshots})
            if path == '/api/nvs':
                return self._send(HTTPStatus.OK, app.jade.internal('get_nvs'), 'application/octet-stream',
                                  {'Content-Disposition': 'attachment; filename="nvs_flash.bin"'})
            return self._static(path)

        def do_POST(self):
            self._request_body = self._read_body()
            if self._request_body is None:
                return self._send_json({'error': 'body too large'}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            if not self._check_origin():
                return
            path = urlsplit(self.path).path
            try:
                if path == '/api/input':
                    app.jade.send_input(json.loads(self._body())['event'])
                    return self._send_json({'ok': True})
                if path == '/api/camera':
                    data = self._body()
                    if len(data) != CAMERA_FRAME_SIZE:
                        return self._send_json({'error': f'expected {CAMERA_FRAME_SIZE} bytes'},
                                               HTTPStatus.BAD_REQUEST)
                    app.jade.push_camera_frame(data)
                    return self._send_json({'ok': True})
                if path == '/api/rpc':
                    req = json.loads(self._body())
                    params = from_json(req.get('params')) if req.get('params') is not None else None
                    return self._send_json({'trace': to_json(app.rpc(req['method'], params))})
                if path == '/api/flow/check':
                    _, steps = parse_flow(json.loads(self._body())['source'])
                    return self._send_json({'ok': True, 'steps': len(steps)})
                if path == '/api/flow/run':
                    req = json.loads(self._body())
                    try:
                        run = app.start_flow(req['source'], step=bool(req.get('step')))
                    except RuntimeError as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.CONFLICT)
                    if req.get('wait'):
                        run.join()
                        return self._send_json({'id': run.id, 'status': run.status, 'error': run.error,
                                                'screenshots': run.screenshots})
                    return self._send_json({'id': run.id})
                if path in ('/api/flow/step', '/api/flow/continue'):
                    f = app.flow
                    if f is None or f.status != 'running' or app.suite:
                        return self._send_json({'error': 'no flow is paused'}, HTTPStatus.CONFLICT)
                    f.step() if path.endswith('step') else f.resume()
                    return self._send_json({'ok': True, 'line': f.paused_line})
                if path == '/api/flow/stop':
                    app.stop_all()
                    return self._send_json({'ok': True})
                if path == '/api/suite/run':
                    req = json.loads(self._body())
                    try:
                        suite = app.start_suite(req.get('dir') or '')
                    except RuntimeError as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.CONFLICT)
                    return self._send_json({'suite': suite['id'], 'total': suite['total']})
                if path == '/api/logs/clear':
                    app.logbook.clear()
                    return self._send_json({'ok': True})
                if path == '/api/loglevel':
                    try:
                        app.set_log_level(str(json.loads(self._body()).get('level', '')))
                    except ValueError as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.BAD_REQUEST)
                    return self._send_json({'ok': True, 'level': app.args.log_level})
                if path == '/api/firmware':
                    try:
                        item = app.switch_firmware(str(json.loads(self._body()).get('file', '')))
                    except LookupError as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.NOT_FOUND)
                    except RuntimeError as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.CONFLICT)
                    except (ValueError, OSError) as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.BAD_REQUEST)
                    return self._send_json({'ok': True, 'file': item['file'], 'label': item['label']})
                if path == '/api/runs/rerun':
                    req = json.loads(self._body())
                    try:
                        run = app.rerun(str(req.get('dir', '')))
                    except LookupError as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.NOT_FOUND)
                    except RuntimeError as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.CONFLICT)
                    return self._send_json({'id': run.id, 'dir': run.dir_name, 'file': run.meta.get('file')})
                if path == '/api/runs/export':
                    req = json.loads(self._body())
                    names = [r['dir'] for r in app.list_runs()] if req.get('all') else req.get('dirs', [])
                    names = [n for n in names if isinstance(n, str) and app._run_dir(n)]
                    try:
                        data, fname = export_zip(app.args.runs_dir, names)
                    except ValueError as e:
                        return self._send_json({'error': str(e)}, HTTPStatus.NOT_FOUND)
                    return self._send(HTTPStatus.OK, data, 'application/zip',
                                      {'Content-Disposition': f'attachment; filename="{fname}"'})
                if path == '/api/runs/delete':
                    req = json.loads(self._body())
                    names = [r['dir'] for r in app.list_runs()] if req.get('all') else req.get('dirs', [])
                    deleted, skipped = app.delete_runs(names)
                    return self._send_json({'deleted': deleted, 'skipped': skipped})
                if path == '/api/restart':
                    app.restart_emulator()
                    return self._send_json({'ok': True})
                if path == '/api/nvs/save':
                    app.jade.save_nvs()
                    return self._send_json({'ok': True, 'file': app.args.nvs_file})
                return self._send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
            except FlowError as e:
                return self._send_json({'error': str(e), 'line': e.line}, HTTPStatus.BAD_REQUEST)
            except JadeRpcError as e:
                return self._send_json({'error': e.error}, HTTPStatus.BAD_GATEWAY)
            except (urllib.error.URLError, OSError) as e:
                return self._send_json({'error': f'http_request failed: {e}'}, HTTPStatus.BAD_GATEWAY)
            except Exception as e:
                logger.exception('POST %s failed', path)
                return self._send_json({'error': f'{type(e).__name__}: {e}'}, HTTPStatus.BAD_REQUEST)

        def _file(self, base, rel, ctype):
            base = os.path.realpath(base)
            full = os.path.realpath(os.path.join(base, rel))
            if not full.startswith(base + os.sep) or not os.path.isfile(full):
                return self._send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
            with open(full, 'rb') as f:
                self._send(HTTPStatus.OK, f.read(), ctype)

        def _static(self, path):
            if path == '/':
                path = '/index.html'
            full = os.path.realpath(os.path.join(WEB_DIR, path.lstrip('/')))
            if not full.startswith(WEB_DIR + os.sep) or not os.path.isfile(full):
                # a page for people and crawlers (status 404, so it is never indexed)
                page = os.path.join(WEB_DIR, '404.html')
                if not path.startswith('/api/') and os.path.isfile(page):
                    with open(page, 'rb') as f:
                        return self._send(HTTPStatus.NOT_FOUND, f.read(), STATIC_TYPES['.html'])
                return self._send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
            with open(full, 'rb') as f:
                body = f.read()
            ctype = STATIC_TYPES.get(os.path.splitext(full)[1], 'application/octet-stream')
            self._send(HTTPStatus.OK, body, ctype)

        def _sse(self):
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            # Start with the latest frame plus recent logs/activity
            last = max(0, app.bus.seq - 200)
            seq, _ = app.jade.get_frame()
            try:
                self.wfile.write(f'data: {json.dumps({"type": "frame", "seq": seq})}\n\n'.encode())
                self.wfile.flush()
                while True:
                    events = app.bus.wait(last, timeout=15)
                    if not events:
                        self.wfile.write(b': keepalive\n\n')
                    else:
                        last = events[-1][0]
                        frames = [e for _, e in events if e['type'] == 'frame']
                        others = [e for _, e in events if e['type'] != 'frame']
                        # Coalesce frame notifications: only the newest matters
                        for e in others + frames[-1:]:
                            self.wfile.write(f'data: {json.dumps(e)}\n\n'.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    def configure(host, port):
        if host in ('127.0.0.1', 'localhost', '::1'):
            for name in ('127.0.0.1', 'localhost', '[::1]'):
                allowed_hosts.add(f'{name}:{port}')
        # binding a non-loopback interface: Host header is not restricted

    Handler.configure = staticmethod(configure)
    return Handler


def main():
    default_lib = remembered_firmware() or default_firmware(FIRMWARE_DIR)
    default_lib = default_lib or os.path.join(FIRMWARE_DIR, 'libjade-<version>-<platform>.so')
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--lib', default=default_lib,
                   help='libjade firmware binary (default: last selected, otherwise highest version: %(default)s)')
    p.add_argument('--host', default='127.0.0.1', help='web UI bind address (default: %(default)s)')
    p.add_argument('--port', type=int, default=8642, help='web UI port (default: %(default)s)')
    p.add_argument('--bridge-host', default='127.0.0.1', help='CBOR bridge bind address (default: %(default)s)')
    p.add_argument('--bridge-port', type=int, default=30121,
                   help='CBOR bridge TCP port, 0 = any free port, -1 = disabled (default: %(default)s)')
    p.add_argument('--nvs-file', default=os.path.join(ROOT, 'data', 'nvs_flash.bin'),
                   help='persistent NVS storage file, "none" to keep nothing (default: %(default)s)')
    p.add_argument('--runs-dir', '--screenshots-dir', dest='runs_dir', default=os.path.join(ROOT, 'data', 'runs'),
                   help='flow run history: one folder per run with run.json + screenshots (default: %(default)s)')
    p.add_argument('--test-pinserver-port', type=int, default=8096,
                   help='start the test pinserver (jade/pinserver with the test key, for the pinserver '
                        'test flows) on 127.0.0.1:PORT; -1 = do not start it (default: %(default)s)')
    p.add_argument('--no-capture-logs', action='store_true',
                   help="don't show the firmware's log output in the web UI (terminal only)")
    p.add_argument('--log-level', default='WARNING', choices=list(LOG_LEVELS),
                   help='firmware log verbosity (default: %(default)s)')
    p.add_argument('-v', '--verbose', action='store_true', help='verbose server logging')
    args = p.parse_args()
    remember_firmware(args.lib)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    if args.nvs_file == 'none':
        args.nvs_file = None
    elif os.path.dirname(args.nvs_file):
        os.makedirs(os.path.dirname(args.nvs_file), exist_ok=True)
    os.makedirs(args.runs_dir, exist_ok=True)
    if not os.path.exists(args.lib):
        sys.exit(f'libjade not found at {args.lib} - build it with scripts/build_libjade.sh')

    app = App(args)
    if not args.no_capture_logs:
        StdioCapture(app.firmware_log)        # firmware logs -> terminal + web UI
    app.jade.start()
    logger.info('libjade started: display %dx%d', app.jade.width, app.jade.height)

    if args.bridge_port >= 0:
        app.bridge = TcpBridge(app.jade, app.bus, args.bridge_host, args.bridge_port)
        app.bridge.start()
        logger.info('CBOR bridge listening: device "tcp:%s:%d"', args.bridge_host, app.bridge.port)

    pinserver = start_test_pinserver(args)

    handler = make_handler(app)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    handler.configure(args.host, server.server_address[1])
    logger.info('Web UI: http://%s:%d/', 'localhost' if args.host in ('127.0.0.1', '::1') else args.host,
                server.server_address[1])

    def shutdown(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server.serve_forever()
    finally:
        logger.info('Shutting down...')
        if app.bridge:
            app.bridge.stop()
        if pinserver:
            pinserver.terminate()
        app.jade.stop()
        if args.nvs_file:
            logger.info('NVS saved to %s', args.nvs_file)


if __name__ == '__main__':
    main()
