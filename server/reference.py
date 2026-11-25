"""Build a reference of the RPC messages supported by the Jade firmware, straight
from the `jade` submodule, so it stays in sync with the firmware actually built:

  - main/wire.c                 messages answered immediately (ping, ...)
  - main/process/dashboard.c    the message dispatcher: method names, whether
                                they need an unlocked wallet, #ifdef build flags
  - docs/index.rst              descriptions and example request/reply messages
"""
import json
import os
import re

# For methods the official docs don't cover (mostly debug-build helpers)
FALLBACK = {
    'cancel': ('Ignored by the dashboard: there is nothing in progress to cancel.', None),
    'register_attestation': ('Install the device attestation RSA key and the external signature '
                             'over its public key (factory provisioning).',
                             {'privkey_pem': '...', 'ext_pubkey_pem': '...', 'ext_signature': 'hex:...'}),
    'debug_selfcheck': ('Run the firmware self-tests. Replies with the elapsed time in ms.', None),
    'debug_clean_reset': ('Wipe the wallet and storage, after a "Warning: debug wipe" screen to continue.', None),
    'debug_set_mnemonic': ('Load a wallet from a mnemonic (or a raw `seed`), optionally with a `passphrase`. '
                           'Shows a "debug wallet" warning to confirm on the device. '
                           '`temporary_wallet: true` keeps it in memory only.',
                           {'mnemonic': 'fish inner face ginger orchard permit useful method fence kidney chuckle '
                                        'party favorite sunset draw limb science crane oval letter slot invite '
                                        'sadness banana', 'temporary_wallet': False}),
    'debug_handshake': ('Run the PIN-server handshake automatically using a test pinserver (CI helper).', None),
    'debug_set_pin': ('Set the PIN without user interaction (CI builds only).', None),
    'debug_scan_qr': ('Decode a QR code from a raw 320x240 grayscale `image`, as if the camera saw it.',
                      {'image': 'hex:...'}),
    'get_bip85_rsa_entropy': ('Return the bip85 RSA entropy for a key (testing only).',
                              {'key_bits': 2048, 'index': 0}),
    'debug_capture_image_data': ('Capture a camera image and return its raw data.', None),
}

TITLE_RE = re.compile(r'^([a-z_0-9]+)( input)? (request|reply)(?: \((.+)\))?$')


def _parse_dispatcher(path):
    """Return [(method, group, flags)] in dispatcher order."""
    src = open(path, encoding='utf-8').read()
    start = src.index('static void dispatch_message(')
    body = src[start:src.index('\n}\n', start)]
    out, flags, unlocked = [], [], False
    for line in body.splitlines():
        s = line.strip()
        if s.startswith('#if'):
            m = re.search(r'(CONFIG_\w+)', s)
            flags.append(m.group(1) if m else s)
        elif s.startswith('#endif'):
            flags = flags[:-1]
        elif 'Methods only available after user authorised' in s:
            unlocked = True
        names = re.findall(r'IS_METHOD\("([a-z_0-9]+)"\)', s)
        if not names:
            continue
        protocol = len(names) > 1 or 'Unexpected method' in body.split(s, 1)[1][:300] and len(names) > 1
        for name in names:
            if any(n == name for n, _, _ in out):
                continue
            if len(names) > 1:
                group = 'protocol'
            elif unlocked:
                group = 'unlocked'
            else:
                group = 'always'
            if any(f == 'CONFIG_DEBUG_MODE' for f in flags):
                group = 'debug'
            out.append((name, group, list(flags)))
    # Multi-message protocol messages may appear on continuation lines
    m = re.search(r'IS_METHOD\("ota_data"\)(.*?)\{', body, re.S)
    if m:
        for name in re.findall(r'IS_METHOD\("([a-z_0-9]+)"\)', m.group(0)):
            if not any(n == name for n, _, _ in out):
                out.append((name, 'protocol', []))
    return out


def _parse_immediate(path):
    """Methods handled immediately in wire.c (declared as char arrays)."""
    src = open(path, encoding='utf-8').read()
    names = []
    for chars in re.findall(r'static const char \w+\[\] = \{([^}]*)\}', src):
        names.append(''.join(re.findall(r"'(.)'", chars)))
    return names


def _parse_docs(path):
    """Return {method: [section]} with section = {title, kind, variant, text, code}."""
    lines = open(path, encoding='utf-8').read().splitlines()
    sections, cur = {}, None
    i = 0
    while i < len(lines):
        line = lines[i]
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        m = TITLE_RE.match(line.strip())
        if m and re.fullmatch(r'-{3,}', nxt.strip()):
            cur = {'title': line.strip(), 'kind': ('input ' if m.group(2) else '') + m.group(3),
                   'variant': m.group(4), 'text': [], 'code': None}
            sections.setdefault(m.group(1), []).append(cur)
            i += 2
            continue
        if cur is not None:
            if line.startswith('.. _') or (re.fullmatch(r'[-=]{3,}', nxt.strip()) and line.strip()):
                cur = None          # next anchor / unrelated heading ends the section
            elif line.strip().startswith('.. code-block::'):
                i += 1
                block = []
                while i < len(lines) and (not lines[i].strip() or lines[i].startswith((' ', '\t'))):
                    block.append(lines[i])
                    i += 1
                code = '\n'.join(block).strip('\n')
                indent = min((len(b) - len(b.lstrip()) for b in block if b.strip()), default=0)
                code = '\n'.join(b[indent:] for b in code.splitlines())
                if cur['code'] is None:
                    cur['code'] = code
                else:
                    cur['text'].append('\n' + code)
                continue
            else:
                cur['text'].append(line)
        i += 1
    for secs in sections.values():
        for s in secs:
            s['text'] = re.sub(r'\n{3,}', '\n\n', '\n'.join(s['text'])).strip()
    return sections


def _first_object(text):
    """The first balanced {...} in text (string-aware), or None."""
    start = text.find('{')
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            esc = c == '\\' and not esc
            if c == '"' and not esc:
                in_str = False
        elif c == '"':
            in_str = True
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _lenient_json(code):
    """Parse the docs' loose 'cbor' notation: missing commas, <placeholders>,
    Python None/True/False, '...' elisions, comments, trailing commas."""
    obj = _first_object(code)
    if obj is None:
        return None
    def fix_bare(seg):
        seg = re.sub(r'(^|\s)(//|#).*$', r'\1', seg, flags=re.M)      # comments
        seg = re.sub(r'<([^<>\n]*)>', lambda m: json.dumps(f'<{m.group(1)}>'), seg)  # <placeholders>
        seg = re.sub(r'\bNone\b', 'null', seg)
        seg = re.sub(r'\bTrue\b', 'true', seg)
        seg = re.sub(r'\bFalse\b', 'false', seg)
        return seg.replace('...', 'null')

    # apply the fixes only outside "quoted strings"
    parts = re.split(r'("(?:[^"\\\n]|\\.)*")', obj)
    obj = ''.join(p if i % 2 else fix_bare(p) for i, p in enumerate(parts))
    lines = [line.rstrip() for line in obj.splitlines() if line.strip()]
    # insert commas missing between a value and the next key/element
    for i in range(len(lines) - 1):
        cur, nxt = lines[i], lines[i + 1].lstrip()
        if re.search(r'["}\]\d]$|\b(true|false|null)$', cur) and re.match(r'["{\[\d-]|true|false|null', nxt):
            lines[i] = cur + ','
    text = re.sub(r',(\s*[}\]])', r'\1', '\n'.join(lines))          # trailing commas
    try:
        return json.loads(text)
    except ValueError:
        return None


def _example_params(code):
    """(params, ok): `params` of a documented example message."""
    msg = _lenient_json(code) if code else None
    if not isinstance(msg, dict):
        return None, False
    return msg.get('params'), True


def build_reference(jade_dir):
    dispatcher = os.path.join(jade_dir, 'main', 'process', 'dashboard.c')
    wire = os.path.join(jade_dir, 'main', 'wire.c')
    docs = os.path.join(jade_dir, 'docs', 'index.rst')

    methods = [(n, 'immediate', []) for n in _parse_immediate(wire)]
    seen = {n for n, _, _ in methods}
    methods += [m for m in _parse_dispatcher(dispatcher) if m[0] not in seen]
    doc = _parse_docs(docs) if os.path.exists(docs) else {}

    out = []
    for name, group, flags in methods:
        secs = doc.get(name, [])
        first_req = next((s for s in secs if s['kind'] == 'request'), None)
        description, params, parsed = '', None, False
        if first_req:
            description = first_req['text'].split('\n\n')[0].replace('\n', ' ')
            params, parsed = _example_params(first_req['code'])
        elif name in FALLBACK:
            description, params = FALLBACK[name]
            parsed = params is not None
        out.append({
            'method': name,
            'group': group,
            'flags': [f for f in flags if f != 'CONFIG_DEBUG_MODE'],
            'description': description,
            'params': params,
            'example_ok': parsed,                # params known (None = takes no params)
            'documented': bool(secs),
            'sections': secs,
        })
    return out
