#!/usr/bin/env python3
"""Run a local blind PIN server for the pinserver test flows.

Uses the pinserver shipped as a submodule of the Jade repo (jade/pinserver, the same
code Blockstream runs) with the *test* key pair committed in the Jade repo
(jade/server_private_key.key / server_public_key.pub). PIN records are kept in
data/pinserver/. Never use this for a real wallet.

    scripts/run_pinserver.py [--port 8096]

Needs: flask, python-dotenv, wallycore  (pip install -r jade/pinserver/requirements.txt)
The flows point the emulated Jade at http://127.0.0.1:8096 with `update_pinserver`.
"""
import argparse
import os
import shutil
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JADE = os.path.join(ROOT, 'jade')


_LOCAL = threading.local()       # per request: number, endpoint, outcome, PIN public key


def log_messages(folder, app):
    """Append every pinserver exchange to <folder>/messages.jsonl, for the jade.church pinserver
    page: each request and response as it travels (encrypted) and as the server sees it once
    decrypted. Only the public *test* key makes the second view harmless."""
    import base64
    import itertools
    import json
    import threading
    import time
    from flask import request
    from pinserver.pindb import PINDb
    from pinserver.server import PINServerECDHv1, PINServerECDHv2
    from wallycore import sha256

    path = os.path.join(folder, 'messages.jsonl')
    lock = threading.Lock()
    numbers = itertools.count(1)
    run = int(time.time())
    local = _LOCAL

    def write(direction, kind, title, fields, **extra):
        entry = {'time': time.time(), 'run': run, 'req': getattr(local, 'req', None),
                 'endpoint': getattr(local, 'endpoint', None), 'dir': direction, 'kind': kind,
                 'title': title, 'fields': fields, **extra}
        line = json.dumps(entry) + '\n'
        with lock:
            try:
                if os.path.getsize(path) > 4_000_000:          # keep the log bounded
                    os.replace(path, path + '.old')
            except OSError:
                pass
            with open(path, 'a') as f:
                f.write(line)

    def b64(text):
        return base64.b64decode(text.encode())

    def wire_request(body):
        if not body:
            return {}
        try:
            u = json.loads(body)
        except ValueError:
            return {'body': body[:2000].decode('utf-8', 'replace')}
        if not isinstance(u, dict):
            return {'body': str(u)[:2000]}
        if 'data' in u:
            try:
                d = b64(u['data'])
            except Exception:
                return {'protocol': 'v2', 'data': str(u['data'])[:2000]}
            return {'protocol': 'v2', 'cke': d[:33].hex(), 'replay_counter': int.from_bytes(d[33:37], 'little'),
                    'encrypted_data': d[37:].hex()}
        return {'protocol': 'v1', **{k: u[k] for k in ('ske', 'cke', 'encrypted_data', 'hmac_encrypted_data') if k in u}}

    def wire_response(body):
        try:
            u = json.loads(body)
        except ValueError:
            return {'body': body[:2000].decode('utf-8', 'replace')}
        if isinstance(u, dict) and 'data' in u:
            try:
                return {'encrypted_key': b64(u['data']).hex()}
            except Exception:
                pass
        return u if isinstance(u, dict) else {'body': str(u)[:2000]}

    @app.before_request
    def message_in():
        local.req = None
        if request.method != 'POST':
            return
        local.req = next(numbers)
        local.endpoint = request.path.strip('/')
        local.outcome = None
        title = 'handshake request' if local.endpoint == 'start_handshake' else 'request'
        write('in', 'wire', title, wire_request(request.get_data()), ip=request.remote_addr)

    @app.after_request
    def message_out(response):
        if getattr(local, 'req', None) is not None:
            title = 'handshake reply: server ephemeral key, signed with the static key' \
                if local.endpoint == 'start_handshake' else 'reply'
            write('out', 'wire', title, wire_response(response.get_data()), status=response.status_code)
            local.req = None
        return response

    def split_payload(payload):
        payload = bytes(payload)
        fields = {'pin_secret': payload[:32].hex()}
        if len(payload) == 32 + 32 + 65:
            fields['entropy'] = payload[32:64].hex()
        fields['signature'] = payload[-65:].hex()
        return fields

    def wrap_decrypt(cls):
        orig = cls.decrypt_request_payload

        def decrypt_request_payload(self, *args):
            payload = orig(self, *args)
            write('in', 'decrypted', 'request payload', split_payload(payload))
            return payload
        cls.decrypt_request_payload = decrypt_request_payload

    def wrap_encrypt(cls):
        orig = cls.encrypt_response_payload

        def encrypt_response_payload(self, *args):
            payload = bytes(args[-1])
            outcome = getattr(local, 'outcome', None)
            note = {'wrong PIN': 'random key: the PIN was wrong',
                    'wrong PIN, record deleted': 'random key: third wrong PIN, record deleted',
                    'no record': 'random key: no record for this PIN public key'}.get(outcome)
            fields = {'aes_key': payload.hex()}
            if outcome:
                fields['outcome'] = outcome
            write('out', 'decrypted', note or 'reply payload: key for the Jade, hmac(stored key, PIN secret)', fields)
            return orig(self, *args)
        cls.encrypt_response_payload = encrypt_response_payload

    for cls in (PINServerECDHv1, PINServerECDHv2):
        wrap_decrypt(cls)
        wrap_encrypt(cls)

    extract = PINDb._extract_fields.__func__

    def _extract_fields(cls, cke, data, replay_counter=None):
        fields = extract(cls, cke, data, replay_counter)
        pin_pubkey = bytes(fields[2])
        write('in', 'decrypted', 'PIN public key, recovered from the signature',
              {'pin_pubkey': pin_pubkey.hex(), 'record': bytes(sha256(pin_pubkey)).hex()})
        return fields
    PINDb._extract_fields = classmethod(_extract_fields)


def track_records(folder):
    """Keep a <record id>.json next to each <record id>.pin with the client's PIN public key and a
    log of the requests, for the jade.church pinserver page. The .pin record is encrypted with a
    key derived from that public key, which the pinserver itself never stores: with it (and the
    public *test* server key) jade.church can show the record and reset its wrong-PIN counter."""
    import json
    import threading
    import time
    from pinserver.pindb import PINDb
    from wallycore import sha256

    lock = threading.Lock()
    local = _LOCAL
    outcomes = {'Invalid PIN': 'wrong PIN', 'Too many attempts': 'wrong PIN, record deleted'}

    def note(pin_pubkey, op, result, replay_counter):
        rid = bytes(sha256(pin_pubkey)).hex()
        try:
            from flask import request
            ip = request.remote_addr
        except Exception:
            ip = None
        local.outcome = result
        now = time.time()
        event = {'time': now, 'op': op, 'result': result, 'ip': ip,
                 'protocol': 'v1' if replay_counter is None else 'v2'}
        if replay_counter is not None:
            event['replay_counter'] = int.from_bytes(replay_counter, 'little')
        path = os.path.join(folder, rid + '.json')
        with lock:
            try:
                with open(path) as f:
                    meta = json.load(f)
            except (OSError, ValueError):
                meta = {'first_seen': now, 'events': []}
            meta.update(pin_pubkey=bytes(pin_pubkey).hex(), last_seen=now)
            meta['events'] = (meta.get('events', []) + [event])[-100:]
            tmp = path + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(meta, f, indent=1)
            os.replace(tmp, path)

    def wrap(name, fn):
        setattr(PINDb, name, classmethod(fn))

    extract = PINDb._extract_fields.__func__
    get_impl = PINDb.get_aes_key_impl.__func__
    set_pin = PINDb.set_pin.__func__

    def _extract_fields(cls, cke, data, replay_counter=None):
        fields = extract(cls, cke, data, replay_counter)
        local.pin_pubkey = fields[2]
        return fields

    def get_aes_key_impl(cls, pin_pubkey, pin_secret, aes_pin_data_key, replay_counter=None):
        try:
            key = get_impl(cls, pin_pubkey, pin_secret, aes_pin_data_key, replay_counter)
        except FileNotFoundError:
            note(pin_pubkey, 'get_pin', 'no record', replay_counter)
            raise
        except Exception as e:
            note(pin_pubkey, 'get_pin', outcomes.get(str(e), f'refused ({type(e).__name__} {e})'.strip()),
                 replay_counter)
            raise
        note(pin_pubkey, 'get_pin', 'correct PIN', replay_counter)
        return key

    def set_pin_tracked(cls, cke, payload, aes_pin_data_key, replay_counter=None):
        local.pin_pubkey = None
        try:
            key = set_pin(cls, cke, payload, aes_pin_data_key, replay_counter)
        except Exception as e:
            if local.pin_pubkey is not None:
                note(local.pin_pubkey, 'set_pin', f'refused ({type(e).__name__} {e})'.strip(), replay_counter)
            raise
        note(local.pin_pubkey, 'set_pin', 'PIN set', replay_counter)
        return key

    wrap('_extract_fields', _extract_fields)
    wrap('get_aes_key_impl', get_aes_key_impl)
    wrap('set_pin', set_pin_tracked)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8096)
    p.add_argument('--data', default=os.path.join(ROOT, 'data', 'pinserver'), help='PIN records folder')
    p.add_argument('--exit-with-parent', action='store_true',
                   help='exit when the parent process (eg. jade-web) goes away, however it ended')
    args = p.parse_args()

    if not os.path.isfile(os.path.join(JADE, 'pinserver', 'flaskserver.py')):
        sys.exit('jade/pinserver is missing: git -C jade submodule update --init pinserver')
    os.makedirs(args.data, exist_ok=True)
    key = os.path.join(args.data, 'server_private_key.key')
    if not os.path.exists(key):
        shutil.copyfile(os.path.join(JADE, 'server_private_key.key'), key)   # the public *test* key
    os.chdir(args.data)                       # the pinserver reads its key and stores PINs in the cwd
    sys.path.insert(0, JADE)
    try:
        from pinserver.flaskserver import app      # built at import: loads the key from the cwd
    except ImportError as e:
        sys.exit(f'{e}: pip install -r jade/pinserver/requirements.txt')
    track_records(args.data)
    log_messages(args.data, app)
    if args.exit_with_parent:
        import threading
        import time
        parent = os.getppid()

        def watch():
            while os.getppid() == parent:
                time.sleep(1)
            os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    print(f'test pinserver on http://{args.host}:{args.port} (records in {args.data})')
    app.run(host=args.host, port=args.port)


if __name__ == '__main__':
    main()
