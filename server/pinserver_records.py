"""Read and manage the records of the local *test* pinserver (scripts/run_pinserver.py).

The blind pinserver (jade/pinserver/pindb.py) keeps one file per Jade PIN, named after
sha256(pin_pubkey), the public key the Jade derives for its PIN:

    <id>.pin   version (1) | hmac (32) | iv (16) + AES-CBC ciphertext (64 + padding)
               plaintext: sha256(pin_secret) (32) | aes_key (32) | wrong PIN count (1)
                          | replay counter (4, little endian, version 1 only)

The ciphertext key is hmac_sha256(aes_pin_data_key, pin_pubkey) and the pinserver never stores
pin_pubkey, so a record alone can only be integrity checked. scripts/run_pinserver.py writes
<id>.json next to it with the pin_pubkey it saw in the last request, plus a request log:
with that, the record can be decrypted and its wrong PIN counter reset.

This works only because the test server's private key is public (jade/server_private_key.key).
Never point this at a real pinserver's data.
"""
import json
import os
import re
import struct

MAX_WRONG = 3            # pindb deletes the record on the third wrong PIN
ID_RE = re.compile(r'^[0-9a-f]{64}$')


class RecordError(Exception):
    pass


def _wally():
    try:
        import wallycore
        return wallycore
    except ImportError:
        return None


def _pins_dir(folder):
    sub = os.path.join(folder, 'pins')          # pindb uses ./pins when it exists
    return sub if os.path.isdir(sub) else folder


def _server_key(folder, jade_dir):
    for path in (os.path.join(folder, 'server_private_key.key'),
                 os.path.join(jade_dir, 'server_private_key.key')):
        if os.path.isfile(path):
            with open(path, 'rb') as f:
                return f.read()
    return None


def _aes_pin_data_key(w, privkey):
    return bytes(w.hmac_sha256(privkey, b'pin_data'))


def _read_meta(folder, rid):
    try:
        with open(os.path.join(folder, rid + '.json')) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write_atomic(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def _decode(w, data_key, rid, data, pin_pubkey):
    """Everything that can be read from a .pin record."""
    out = {'size': len(data)}
    if len(data) != 129:
        out['error'] = f'unexpected size {len(data)} (expected 129 bytes)'
        return out, None
    version, hmac_recv, encrypted = data[0], data[1:33], data[33:]
    out.update(version=version, hmac=hmac_recv.hex(), iv=encrypted[:16].hex(), ciphertext=encrypted[16:].hex(),
               format={0: 'v0, no anti-replay counter', 1: 'v1, with anti-replay counter'}.get(version, 'unknown'))
    if w is None or data_key is None:
        return out, None
    pin_auth_key = w.hmac_sha256(data_key, bytes.fromhex(rid))
    out['hmac_ok'] = bytes(w.hmac_sha256(pin_auth_key, data[:1] + encrypted)) == hmac_recv
    if not pin_pubkey:
        return out, None
    pin_pubkey = bytes.fromhex(pin_pubkey)
    if bytes(w.sha256(pin_pubkey)).hex() != rid:
        out['error'] = 'the saved PIN public key does not match this record'
        return out, None
    storage_key = w.hmac_sha256(data_key, pin_pubkey)
    try:
        plain = bytes(w.aes_cbc(storage_key, encrypted[:16], encrypted[16:], w.AES_FLAG_DECRYPT))
    except Exception as e:
        out['error'] = f'cannot decrypt: {e}'
        return out, None
    if len(plain) not in (65, 69):
        out['error'] = f'unexpected plaintext size {len(plain)}'
        return out, None
    count = plain[64]
    out.update(decrypted=True, hash_pin_secret=plain[:32].hex(), aes_key=plain[32:64].hex(),
               wrong_attempts=count, tries_left=max(0, MAX_WRONG - count))
    if len(plain) == 69:
        out['replay_counter'] = int.from_bytes(plain[65:69], 'little')
    return out, plain


def list_records(folder, jade_dir):
    """All records (and the request logs of records the pinserver has deleted), newest first."""
    w = _wally()
    privkey = _server_key(folder, jade_dir)
    data_key = _aes_pin_data_key(w, privkey) if w and privkey else None
    pins = _pins_dir(folder)
    ids = set()
    for d in {pins, folder}:
        if os.path.isdir(d):
            for name in os.listdir(d):
                stem, ext = os.path.splitext(name)
                if ext in ('.pin', '.json') and ID_RE.match(stem):
                    ids.add(stem)
    records = []
    for rid in ids:
        meta = _read_meta(folder, rid)
        path = os.path.join(pins, rid + '.pin')
        rec = {'id': rid, 'exists': os.path.isfile(path), 'pin_pubkey': meta.get('pin_pubkey'),
               'first_seen': meta.get('first_seen'), 'last_seen': meta.get('last_seen'),
               'events': meta.get('events', [])}
        if rec['exists']:
            st = os.stat(path)
            rec['modified'] = st.st_mtime
            with open(path, 'rb') as f:
                info, _ = _decode(w, data_key, rid, f.read(), rec['pin_pubkey'])
            rec.update(info)
        records.append(rec)
    records.sort(key=lambda r: -(r.get('last_seen') or r.get('modified') or 0))
    return {'records': records, 'can_decrypt': bool(data_key),
            'missing': None if w else 'wallycore is not installed',
            'folder': folder}


def _check_id(rid):
    if not isinstance(rid, str) or not ID_RE.match(rid):
        raise RecordError('bad record id')


def reset_attempts(folder, jade_dir, rid):
    """Set the wrong PIN count of a record back to 0, keeping everything else."""
    _check_id(rid)
    w = _wally()
    if w is None:
        raise RecordError('wallycore is not installed')
    privkey = _server_key(folder, jade_dir)
    if not privkey:
        raise RecordError('test server key not found')
    meta = _read_meta(folder, rid)
    if not meta.get('pin_pubkey'):
        raise RecordError('PIN public key unknown: unlock the Jade once (or set its PIN again) '
                          'so the pinserver can record it')
    path = os.path.join(_pins_dir(folder), rid + '.pin')
    if not os.path.isfile(path):
        raise RecordError('the record no longer exists')
    with open(path, 'rb') as f:
        data = f.read()
    data_key = _aes_pin_data_key(w, privkey)
    info, plain = _decode(w, data_key, rid, data, meta['pin_pubkey'])
    if plain is None:
        raise RecordError(info.get('error') or 'cannot decrypt the record')
    if not info.get('hmac_ok'):
        raise RecordError('record integrity check failed')
    plain = plain[:64] + struct.pack('B', 0) + plain[65:]
    storage_key = w.hmac_sha256(data_key, bytes.fromhex(meta['pin_pubkey']))
    iv = os.urandom(16)
    encrypted = iv + bytes(w.aes_cbc(storage_key, iv, plain, w.AES_FLAG_ENCRYPT))
    version = data[:1]
    pin_auth_key = w.hmac_sha256(data_key, bytes.fromhex(rid))
    hmac_payload = bytes(w.hmac_sha256(pin_auth_key, version + encrypted))
    _write_atomic(path, version + hmac_payload + encrypted)
    _log(folder, rid, meta, 'reset', f'wrong PIN count {info["wrong_attempts"]} -> 0 (from jade.church)')
    return info['wrong_attempts']


def delete_record(folder, rid):
    """Remove a record and its log."""
    _check_id(rid)
    removed = []
    for path in (os.path.join(_pins_dir(folder), rid + '.pin'), os.path.join(folder, rid + '.json')):
        if os.path.isfile(path):
            os.remove(path)
            removed.append(os.path.basename(path))
    if not removed:
        raise RecordError('no such record')
    return removed


def _log(folder, rid, meta, op, result):
    import time
    now = time.time()
    meta.setdefault('first_seen', now)
    meta['events'] = (meta.get('events', []) + [{'time': now, 'op': op, 'result': result}])[-100:]
    _write_atomic(os.path.join(folder, rid + '.json'), json.dumps(meta, indent=1).encode())


def read_messages(folder, limit=2000):
    """The last `limit` entries of the pinserver message log (scripts/run_pinserver.py)."""
    lines = []
    for name in ('messages.jsonl.old', 'messages.jsonl'):
        try:
            with open(os.path.join(folder, name), 'rb') as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 3_000_000))          # enough for `limit` entries
                lines.extend(f.read().splitlines())
        except OSError:
            pass
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass                                          # a line cut by the seek, or being written
    return out


def clear_messages(folder):
    for name in ('messages.jsonl', 'messages.jsonl.old'):
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            open(path, 'w').close()
