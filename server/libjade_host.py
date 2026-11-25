"""In-process host for libjade (the Jade firmware built as a native library).

libjade exposes a single global firmware instance with two reply channels:
  - the "serial" channel, carrying normal Jade CBOR-RPC replies and log messages
  - the "internal" channel, carrying replies to `libjade_request` calls
    (display bytes, button input, camera frames, NVS storage)

The C side picks which channel `libjade_receive()`/`libjade_release()` act on
using a global flag set by the last `libjade_send()`. That makes concurrent use
from several threads racy, so this module funnels every send/receive/release
through one lock:
  - internal requests are synchronous: send + blocking receive under the lock
  - a pump thread polls the serial channel non-blockingly under the lock, and
    dispatches each reply to whoever sent the request with that id
"""
import collections
import ctypes
import io
import itertools
import logging
import multiprocessing
import os
import sys
import signal
import threading
import time
import traceback

import cbor2

logger = logging.getLogger(__name__)

LIBJADE_REQUEST_METHOD = 'libjade_request'

# libjade_set_log_level(): 0-4 in decreasing verbosity, 5 disables logging
LOG_LEVELS = {'VERBOSE': 0, 'DEBUG': 1, 'INFO': 2, 'WARNING': 3, 'ERROR': 4, 'NONE': 5}


def load_library(path=None):
    """Load libjade from an explicit path, or by name via the loader search path."""
    name = path or ('libjade.dylib' if sys.platform == 'darwin' else 'libjade.so')
    lib = ctypes.CDLL(name)
    lib.libjade_start.restype = None
    lib.libjade_stop.restype = None
    lib.libjade_send.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    lib.libjade_send.restype = ctypes.c_bool
    lib.libjade_receive.argtypes = [ctypes.c_uint, ctypes.POINTER(ctypes.c_size_t)]
    lib.libjade_receive.restype = ctypes.POINTER(ctypes.c_ubyte)
    lib.libjade_release.argtypes = [ctypes.POINTER(ctypes.c_ubyte)]
    lib.libjade_release.restype = None
    lib.libjade_set_log_level.argtypes = [ctypes.c_int]
    lib.libjade_set_log_level.restype = None
    return lib


class JadeRpcError(Exception):
    def __init__(self, error):
        self.error = error
        super().__init__(f"{error.get('code')}: {error.get('message')}")


class _Pending:
    __slots__ = ('event', 'reply', 'callback')

    def __init__(self, callback=None):
        self.event = threading.Event()
        self.reply = None
        self.callback = callback


class _InProcessLibJadeHost:
    """Owns the running libjade instance and multiplexes access to it."""

    def __init__(self, lib, log_level='WARNING', nvs_file=None, on_log=None, on_frame=None,
                 frame_interval=0.1):
        self.lib = lib
        self.log_level = LOG_LEVELS[log_level]
        self.nvs_file = nvs_file
        self.on_log = on_log or (lambda text: None)
        self.on_frame = on_frame or (lambda seq: None)
        self.frame_interval = frame_interval

        self._lock = threading.RLock()        # guards every libjade_* call
        self._pending = {}                    # rpc id -> _Pending (serial channel)
        self._pending_lock = threading.Lock()
        self._last_sender = None              # fallback target for id '00' errors
        self._unclaimed = collections.deque(maxlen=2000)   # replies no request was waiting for
        self._raw_until = 0.0                 # display polling paused while raw bytes are in flight
        self._unclaimed_cond = threading.Condition()
        self._ids = itertools.count(int(time.time()) % 100000)
        self._serial_buf = bytearray()

        self.width = self.height = 0
        self.frame = None
        self.frame_seq = 0
        self._frame_cond = threading.Condition()

        self._running = False
        self._threads = []

    #
    # Lifecycle
    #
    def start(self):
        with self._lock:
            self._start_firmware()
        self._running = True
        for target in (self._pump_loop, self._display_loop):
            t = threading.Thread(target=target, daemon=True, name=target.__name__)
            t.start()
            self._threads.append(t)

    def stop(self):
        self._running = False
        for t in self._threads:
            t.join(timeout=3)
        self._threads = []
        with self._lock:
            self.save_nvs()
            self._kill_firmware('emulator stopped')
        self._fail_all_pending('libjade stopped')

    def restart(self):
        """Power-cycle the emulated device, keeping its storage."""
        with self._lock:
            self.save_nvs()
            self._kill_firmware('emulator restart')
            self._serial_buf.clear()
            self._fail_all_pending('libjade restarted')
            self._start_firmware()
        self.on_log('[jade-web] device restarted\n')

    def switch_library(self, lib, label=''):
        """Turn the emulated device off, swap in another firmware build (a library loaded
        with load_library()), and turn it on again with the same storage."""
        with self._lock:
            self.save_nvs()
            self._kill_firmware('firmware change')
            self._serial_buf.clear()
            self._fail_all_pending('firmware switched')
            self.lib = lib
            self._start_firmware()
        with self._frame_cond:                # new display (maybe another size): force a redraw
            self.frame = None
        self.on_log(f'[jade-web] firmware switched{": " + label if label else ""}\n')

    def _kill_firmware(self, reason):
        """Send libjade's cooperative stop request before powering down the firmware thread."""
        self.on_log(f'[jade-web] emulator kill requested ({reason})\n')
        self.lib.libjade_stop()

    def set_log_level(self, name):
        """Change the firmware log level at runtime (needs a build with logging enabled)."""
        self.log_level = LOG_LEVELS[name]
        with self._lock:
            self.lib.libjade_set_log_level(self.log_level)

    def _start_firmware(self):
        self.lib.libjade_set_log_level(self.log_level)
        self.lib.libjade_start()
        try:
            size = self._internal_locked({'request': 'get_display_size'})
        except JadeRpcError as exc:
            # libjade before Jade 1.0.41 has no internal requests: its firmware answers them
            # as ordinary messages, eg. "-32002: hardware locked or uninitialized"
            raise RuntimeError('this libjade has no screen support (it does not answer '
                               'get_display_size): jade.church needs firmware built from '
                               f'Jade 1.0.41 or later [{exc}]') from None
        self.width, self.height = size['width'], size['height']
        self.load_nvs()

    #
    # NVS storage persistence
    #
    def load_nvs(self):
        if not self.nvs_file:
            return
        try:
            with open(self.nvs_file, 'rb') as f:
                data = f.read()
        except FileNotFoundError:
            return
        if data:
            self.internal('set_nvs', bytes=data)
            logger.info('Loaded NVS from %s (%d bytes)', self.nvs_file, len(data))

    def save_nvs(self):
        if not self.nvs_file:
            return
        data = self.internal('get_nvs')
        tmp = self.nvs_file + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, self.nvs_file)
        logger.info('Saved NVS to %s (%d bytes)', self.nvs_file, len(data))

    #
    # Internal (libjade_request) channel - synchronous
    #
    def internal(self, request, **params):
        with self._lock:
            return self._internal_locked({'request': request, **params})

    def _internal_locked(self, params, timeout=10):
        rpc_id = f'i{next(self._ids) % 10**8}'
        msg = cbor2.dumps({'id': rpc_id, 'method': LIBJADE_REQUEST_METHOD, 'params': params})
        for _ in range(3):
            if not self.lib.libjade_send(msg, len(msg)):
                raise RuntimeError('libjade_send failed')
            data = self._receive_locked(timeout)
            if data is None:
                raise TimeoutError(f'no reply to libjade_request {params.get("request")}')
            try:
                reply = cbor2.loads(data)
            except (cbor2.CBORDecodeError, EOFError):
                reply = None
            if isinstance(reply, dict) and reply.get('id') == rpc_id:
                break
            if not (isinstance(reply, dict) and str(reply.get('id', '')).startswith('i')):
                # Standard-channel data (eg. the reply to an RPC that completed just now):
                # hand it to the serial stream instead of dropping it, or its caller never
                # gets an answer.
                self._serial_buf += data
                for msg in self._drain_messages():
                    self._dispatch(msg)
                continue
            # A late reply to an earlier internal request that timed out. Each send
            # arms the C-side channel flag for exactly one receive (release clears
            # it), so resend to fetch our own reply.
            logger.warning('Skipping stale internal reply id=%s', reply.get('id'))
        else:
            raise RuntimeError('internal libjade channel out of sync')
        if 'error' in reply:
            raise JadeRpcError(reply['error'])
        return reply.get('result')

    def _receive_locked(self, timeout):
        size = ctypes.c_size_t()
        buf = self.lib.libjade_receive(timeout, ctypes.byref(size))
        if not buf:
            return None
        data = ctypes.string_at(buf, size.value)
        self.lib.libjade_release(buf)
        return data

    def send_input(self, event):
        if event not in ('left', 'right', 'click'):
            raise ValueError(f'bad input event {event!r}')
        return self.internal('send_input', event=event)

    def push_camera_frame(self, data):
        return self.internal('set_camera_bytes', bytes=data)

    #
    # Display polling
    #
    def _display_loop(self):
        while self._running:
            if time.time() < self._raw_until:
                time.sleep(0.05)
                continue
            try:
                data = self.internal('get_display_bytes')
                if data != self.frame:
                    with self._frame_cond:
                        self.frame = data
                        self.frame_seq += 1
                        seq = self.frame_seq
                        self._frame_cond.notify_all()
                    self.on_frame(seq)
            except Exception as e:  # keep polling across restarts
                logger.debug('display poll failed: %s', e)
            time.sleep(self.frame_interval)

    def get_frame(self):
        with self._frame_cond:
            return self.frame_seq, self.frame

    def wait_frame(self, after_seq, timeout):
        """Wait until the frame sequence passes `after_seq` (or timeout). Returns the current seq."""
        with self._frame_cond:
            self._frame_cond.wait_for(lambda: self.frame_seq > after_seq, timeout)
            return self.frame_seq

    #
    # Serial (standard Jade RPC) channel - asynchronous, replies routed by id
    #
    def send_serial(self, request, callback=None):
        """Send a Jade RPC request dict. Returns a _Pending that completes on reply.
        `callback(reply)` (if given) is invoked from the pump thread."""
        rpc_id = request['id']
        pending = _Pending(callback)
        with self._pending_lock:
            self._pending[rpc_id] = pending
            self._last_sender = rpc_id
        msg = cbor2.dumps(request)
        with self._lock:
            ok = self.lib.libjade_send(msg, len(msg))
        if not ok:
            self._complete(rpc_id, {'id': rpc_id, 'error': {'code': -32000, 'message': 'libjade_send failed'}})
        return pending

    def send_raw(self, data):
        """Write raw bytes to the serial stream (need not be a valid message). Replies to
        them (including '00' rejections) are collected with take_unclaimed()."""
        with self._pending_lock:
            self._last_sender = None          # do not hand '00' rejections to an earlier request
        # Internal requests (eg. the display poll) share the firmware's input buffer: sent after
        # incomplete raw bytes they would be merged with them, and the firmware's stale-data
        # timeout could never fire. So pause polling until end_raw() (or 30s at most).
        self._raw_until = time.time() + 30
        with self._lock:
            ok = self.lib.libjade_send(bytes(data), len(data))
        if not ok:
            raise RuntimeError('libjade_send failed')

    def end_raw(self):
        """Raw exchange over: resume display polling."""
        self._raw_until = 0.0

    def clear_unclaimed(self):
        with self._unclaimed_cond:
            self._unclaimed.clear()

    def take_unclaimed(self, timeout):
        """Pop the oldest unclaimed reply, waiting up to `timeout` seconds (None if none)."""
        with self._unclaimed_cond:
            if not self._unclaimed_cond.wait_for(lambda: self._unclaimed, timeout):
                return None
            return self._unclaimed.popleft()

    def call(self, method, params=None, timeout=None):
        """Blocking Jade RPC call on the serial channel. Returns the reply dict."""
        rpc_id = str(next(self._ids) % 10**8)
        request = {'id': rpc_id, 'method': method}
        if params is not None:
            request['params'] = params
        pending = self.send_serial(request)
        if not pending.event.wait(timeout):
            with self._pending_lock:
                self._pending.pop(rpc_id, None)
            raise TimeoutError(f'no reply to {method}')
        return pending.reply

    def _complete(self, rpc_id, reply):
        with self._pending_lock:
            pending = self._pending.pop(rpc_id, None)
            if pending is None and rpc_id == '00':
                # Firmware could not parse the request id: give it to the last sender
                pending = self._pending.pop(self._last_sender, None)
        if pending is None:
            # eg. replies to raw bytes written with send_raw(): kept for take_unclaimed()
            logger.debug('Unmatched reply id=%s', rpc_id)
            with self._unclaimed_cond:
                self._unclaimed.append(reply)
                self._unclaimed_cond.notify_all()
            return
        pending.reply = reply
        pending.event.set()
        if pending.callback:
            try:
                pending.callback(reply)
            except Exception:
                logger.exception('reply callback failed')

    def _fail_all_pending(self, why):
        with self._pending_lock:
            pending, self._pending = self._pending, {}
        for rpc_id, p in pending.items():
            p.reply = {'id': rpc_id, 'error': {'code': -32000, 'message': why}}
            p.event.set()
            if p.callback:
                p.callback(p.reply)

    def _pump_loop(self):
        while self._running:
            with self._lock:
                data = self._receive_locked(0)
            if data is None:
                time.sleep(0.01)
                continue
            self._serial_buf += data
            for msg in self._drain_messages():
                self._dispatch(msg)

    def _drain_messages(self):
        while self._serial_buf:
            stream = io.BytesIO(self._serial_buf)
            try:
                msg = cbor2.CBORDecoder(stream).decode()
            except cbor2.CBORDecodeEOF:
                return  # partial message - wait for more
            except cbor2.CBORDecodeError as e:
                logger.error('Discarding undecodable serial data: %s', e)
                self._serial_buf.clear()
                return
            del self._serial_buf[:stream.tell()]
            yield msg

    def _dispatch(self, msg):
        if not isinstance(msg, dict):
            logger.warning('Unexpected serial message: %r', msg)
        elif 'log' in msg:
            text = msg['log']
            if isinstance(text, bytes):
                text = text.decode('utf-8', 'replace')
            self.on_log(text)
        elif 'id' in msg:
            self._complete(msg['id'], msg)
        else:
            logger.warning('Unexpected serial message: %r', msg)


def _worker_send(conn, lock, message):
    try:
        with lock:
            conn.send(message)
        return True
    except (BrokenPipeError, EOFError, OSError):
        return False


def _libjade_worker(conn, lib_path, log_level, nvs_file, frame_interval):
    """Run all native firmware code in a process that can be force-killed safely."""
    # Ctrl+C in the terminal reaches the whole process group: let the parent handle it
    # and stop this worker cleanly, instead of the worker dying on its own first.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    send_lock = threading.Lock()
    host = None

    def emit(kind, **data):
        _worker_send(conn, send_lock, {'event': kind, **data})

    try:
        host = _InProcessLibJadeHost(
            load_library(lib_path), log_level=log_level, nvs_file=nvs_file,
            on_log=lambda text: emit('log', text=text),
            on_frame=lambda seq: emit('frame', seq=seq, frame=host.frame,
                                      width=host.width, height=host.height),
            frame_interval=frame_interval)
        host.start()
        emit('ready', width=host.width, height=host.height, seq=host.frame_seq, frame=host.frame)
        while True:
            try:
                message = conn.recv()
            except EOFError:
                break
            if message.get('op') == 'close':
                # Keep stop cooperative first. The parent enforces a deadline and
                # terminates/kills this process if native code cannot unwind.
                host.stop()
                emit('response', id=message['id'], result=None)
                break
            if message.get('op') != 'call':
                continue
            call_id, method = message['id'], message['method']
            try:
                args, kwargs = message.get('args', ()), message.get('kwargs', {})
                if method == 'switch_library':
                    args = (load_library(args[0]), *args[1:])
                elif method == 'set_log_level':
                    # Keep parent and worker settings aligned for a later restart.
                    pass
                elif method == 'send_serial':
                    request = args[0]
                    callback_id = kwargs.pop('callback_id', None)
                    callback = ((lambda reply, cid=callback_id: emit('callback', id=cid, reply=reply))
                                if callback_id is not None else None)
                    host.send_serial(request, callback=callback)
                    result = None
                    emit('response', id=call_id, result=result)
                    continue
                result = getattr(host, method)(*args, **kwargs)
                # _Pending contains threading primitives and is intentionally
                # represented by None when a caller does not use a callback.
                if isinstance(result, _Pending):
                    result = None
                if method in ('restart', 'switch_library'):
                    emit('dimensions', width=host.width, height=host.height,
                         seq=host.frame_seq, frame=host.frame)
                emit('response', id=call_id, result=result)
            except BaseException as exc:
                emit('response', id=call_id, error=f'{type(exc).__name__}: {exc}',
                     rpc_error=getattr(exc, 'error', None))
    except BaseException:
        emit('startup_error', error=traceback.format_exc())
    finally:
        try:
            conn.close()
        except OSError:
            pass


class LibJadeHost:
    """Parent-process proxy for an isolated libjade worker."""

    _CALL_TIMEOUT = 30
    _STOP_TIMEOUT = 5

    def __init__(self, lib_path, log_level='WARNING', nvs_file=None, on_log=None, on_frame=None,
                 frame_interval=0.1):
        self.lib_path = os.fspath(lib_path)
        self.log_level = log_level
        self.nvs_file = nvs_file
        self.on_log = on_log or (lambda text: None)
        self.on_frame = on_frame or (lambda seq: None)
        self.frame_interval = frame_interval
        self.width = self.height = 0
        self.frame = None
        self.frame_seq = 0
        self._ctx = multiprocessing.get_context('spawn')
        self._lock = threading.RLock()
        self._frame_cond = threading.Condition()
        self._pending_lock = threading.Lock()
        self._pending = {}
        self._callbacks = {}
        self._next_id = 0
        self._next_callback_id = 0
        self._ready = threading.Event()
        self._reader = None
        self._conn = None
        self._process = None
        self._running = False
        self._expected_exit = None   # the worker process that is being stopped on purpose
        self.start()

    def _launch(self):
        parent, child = self._ctx.Pipe(duplex=True)
        proc = self._ctx.Process(target=_libjade_worker,
                                 args=(child, self.lib_path, self.log_level, self.nvs_file,
                                       self.frame_interval),
                                 name='libjade-emulator')
        proc.start()
        child.close()
        self._conn, self._process = parent, proc
        self._ready.clear()
        self._startup_error = None
        self._reader = threading.Thread(target=self._read_loop, daemon=True,
                                        name='libjade-ipc-reader')
        self._reader.start()
        if not self._ready.wait(30):
            self._force_kill()
            raise RuntimeError('libjade worker did not start within 30 seconds')
        if self._startup_error:
            error = self._startup_error
            self._force_kill()
            raise RuntimeError(f'libjade worker failed to start:\n{error}')

    def start(self):
        with self._lock:
            if self._process is not None and self._process.is_alive():
                return
            self._running = True
            self._launch()

    def _read_loop(self):
        conn, proc = self._conn, self._process
        try:
            while True:
                message = conn.recv()
                kind = message.get('event')
                if kind == 'ready':
                    self.width, self.height = message['width'], message['height']
                    with self._frame_cond:
                        self.frame_seq, self.frame = message['seq'], message.get('frame')
                        self._frame_cond.notify_all()
                    self._ready.set()
                elif kind == 'frame':
                    self.width, self.height = message['width'], message['height']
                    with self._frame_cond:
                        self.frame_seq, self.frame = message['seq'], message.get('frame')
                        self._frame_cond.notify_all()
                    self.on_frame(message['seq'])
                elif kind == 'dimensions':
                    self.width, self.height = message['width'], message['height']
                    with self._frame_cond:
                        self.frame_seq, self.frame = message['seq'], message.get('frame')
                        self._frame_cond.notify_all()
                elif kind == 'log':
                    self.on_log(message['text'])
                elif kind == 'startup_error':
                    self._startup_error = message['error']
                    self._ready.set()
                elif kind == 'callback':
                    callback = self._callbacks.pop(message['id'], None)
                    if callback:
                        try:
                            callback(message['reply'])
                        except Exception:
                            logger.exception('libjade callback failed')
                elif kind == 'response':
                    with self._pending_lock:
                        pending = self._pending.pop(message['id'], None)
                    if pending:
                        pending['message'] = message
                        pending['event'].set()
        except (EOFError, OSError):
            pass
        finally:
            with self._pending_lock:
                pending, self._pending = self._pending, {}
            for request in pending.values():
                request['message'] = {'error': 'libjade worker exited'}
                request['event'].set()
            callbacks, self._callbacks = self._callbacks, {}
            for callback in callbacks.values():
                try:
                    callback({'id': '00', 'error': {'code': -32000,
                                                     'message': 'libjade worker exited'}})
                except Exception:
                    logger.exception('libjade callback failed during worker exit')
            self._check_crash(proc)

    def _check_crash(self, proc):
        """The worker's pipe closed. If nobody asked it to stop, the firmware crashed (eg. a
        segfault in libjade): report how it died and start a fresh worker, so the UI and the
        flows keep working instead of every later call failing with 'worker is not running'."""
        if proc is None or not self._running or self._expected_exit is proc:
            return
        proc.join(2)
        code = proc.exitcode
        if code is None:
            return                      # still alive: just a broken pipe, leave it to stop()
        if code < 0 and -code in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            return                      # stopped from outside (eg. the server is shutting down)
        how = (f'signal {signal.Signals(-code).name}' if code < 0 and -code in signal.valid_signals()
               else f'exit code {code}')
        self._ready.clear()             # callers wait for the replacement (see _request)
        self.on_log(f'[jade-web] libjade worker crashed ({how}); restarting it\n')
        logger.error('libjade worker crashed (%s); restarting it', how)

        def recover():
            try:
                with self._lock:
                    if self._process is not proc or not self._running:
                        return          # already replaced or stopped meanwhile
                    self._cleanup_process()
                    self._launch()
                self.on_log('[jade-web] libjade worker restarted after the crash\n')
            except Exception as exc:
                self._ready.set()       # stop callers waiting: they get 'worker is not running'
                logger.exception('could not restart the libjade worker')
                self.on_log(f'[jade-web] could not restart the libjade worker: {exc}\n')
        threading.Thread(target=recover, daemon=True, name='libjade-recover').start()

    def _request(self, method, *args, _ipc_timeout=None, **kwargs):
        if (not self._process or not self._process.is_alive()) and self._running:
            self._ready.wait(35)            # a crashed worker is being replaced: wait for it
        if not self._process or not self._process.is_alive():
            raise RuntimeError('libjade worker is not running')
        with self._pending_lock:
            self._next_id += 1
            call_id = self._next_id
            request = {'event': threading.Event()}
            self._pending[call_id] = request
        message = {'op': 'call', 'id': call_id, 'method': method,
                   'args': args, 'kwargs': kwargs}
        with self._lock:
            self._conn.send(message)
        if not request['event'].wait(_ipc_timeout if _ipc_timeout is not None else self._CALL_TIMEOUT):
            with self._pending_lock:
                self._pending.pop(call_id, None)
            raise TimeoutError(f'libjade worker timed out calling {method}')
        result = request['message']
        if 'error' in result:
            if result.get('rpc_error') is not None:
                raise JadeRpcError(result['rpc_error'])
            raise RuntimeError(result['error'])
        return result.get('result')

    def _close_worker(self, timeout=None):
        proc = self._process
        if proc is None:
            return True
        self._expected_exit = proc
        if proc.is_alive():
            with self._lock:
                self._next_id += 1
                call_id = self._next_id
                event = threading.Event()
                with self._pending_lock:
                    self._pending[call_id] = {'event': event}
                try:
                    if self._conn is not None:
                        self._conn.send({'op': 'close', 'id': call_id})
                except (BrokenPipeError, EOFError, OSError):
                    pass
            proc.join(self._STOP_TIMEOUT if timeout is None else timeout)
            if proc.is_alive():
                return False
        self._cleanup_process()
        return True

    def _force_kill(self):
        proc = self._process
        if proc is None:
            return
        self._expected_exit = proc
        if proc.is_alive():
            proc.terminate()                    # SIGTERM on POSIX
            proc.join(1)
        if proc.is_alive():
            self.on_log('[jade-web] SIGTERM timed out; sending SIGKILL\n')
            proc.kill()                          # SIGKILL on POSIX
            proc.join(2)
        if proc.is_alive():
            raise RuntimeError('could not terminate libjade worker with SIGKILL')
        self._cleanup_process()

    def _cleanup_process(self):
        if self._conn:
            try:
                self._conn.close()
            except OSError:
                pass
        if self._process:
            self._process.close()
        self._conn = self._process = None

    def stop(self):
        self._running = False
        self.on_log('[jade-web] emulator stop requested\n')
        if not self._close_worker():
            self.on_log('[jade-web] graceful stop timed out; sending SIGTERM\n')
            self._force_kill()

    def _replace_worker(self, lib_path=None):
        if not self._close_worker():
            self.on_log('[jade-web] emulator stop timed out; forcing termination\n')
            self._force_kill()
        if lib_path is not None:
            self.lib_path = os.fspath(lib_path)
        self.start()

    def restart(self):
        try:
            self._request('restart', _ipc_timeout=self._STOP_TIMEOUT)
            self.on_log('[jade-web] device restarted\n')
        except (RuntimeError, TimeoutError):
            self.on_log('[jade-web] restart did not stop cleanly; restarting worker process\n')
            self._replace_worker()

    def switch_library(self, lib_path, label=''):
        new_path = os.fspath(lib_path)
        try:
            self._request('switch_library', new_path, label, _ipc_timeout=self._STOP_TIMEOUT)
            self.lib_path = new_path
        except TimeoutError:
            self.on_log('[jade-web] firmware switch did not stop cleanly; replacing worker process\n')
            self._replace_worker(new_path)
        except RuntimeError:
            if self._process is not None and self._process.is_alive():
                raise
            self.on_log('[jade-web] firmware worker exited during switch; starting replacement worker\n')
            self._replace_worker(new_path)
        with self._frame_cond:
            self.frame = None
        self.on_log(f'[jade-web] firmware switched{": " + label if label else ""}\n')

    def set_log_level(self, name):
        self.log_level = name
        return self._request('set_log_level', name)

    def get_frame(self):
        with self._frame_cond:
            return self.frame_seq, self.frame

    def wait_frame(self, after_seq, timeout):
        with self._frame_cond:
            self._frame_cond.wait_for(lambda: self.frame_seq > after_seq, timeout)
            return self.frame_seq

    def send_serial(self, request, callback=None):
        callback_id = None
        if callback:
            with self._pending_lock:
                self._next_callback_id += 1
                callback_id = self._next_callback_id
                self._callbacks[callback_id] = callback
        try:
            return self._request('send_serial', request, callback_id=callback_id)
        except Exception:
            if callback_id is not None:
                self._callbacks.pop(callback_id, None)
            raise

    def call(self, method, params=None, timeout=None):
        """Blocking Jade RPC call. The wait happens here, in the parent: the worker
        handles one IPC request at a time, so a call blocked there (eg. one waiting for
        a confirmation on the device) would hold up the button presses that answer it."""
        with self._pending_lock:
            self._next_callback_id += 1
            rpc_id = f'c{self._next_callback_id % 10**8}'
        request = {'id': rpc_id, 'method': method}
        if params is not None:
            request['params'] = params
        done = _Pending()

        def on_reply(reply):
            done.reply = reply
            done.event.set()
        self.send_serial(request, callback=on_reply)
        if not done.event.wait(timeout):
            raise TimeoutError(f'no reply to {method}')
        return done.reply

    def __getattr__(self, name):
        # Preserve the existing host API (internal, raw serial, NVS, RPC, etc.)
        # while making calls cross the process boundary.
        if name.startswith('_'):
            raise AttributeError(name)
        return lambda *args, **kwargs: self._request(name, *args, **kwargs)
