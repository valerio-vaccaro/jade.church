"""The firmware binaries built by scripts/build_libjade.sh into firmware/:

    firmware/libjade-<version>-<platform>[-<option>...].so   (.dylib on macOS)
    firmware/libjade-<version>-<platform>[-<option>...].so.json

The .json describes the build (board, firmware version, build type and options). The
default firmware is the one with the highest version; among equal versions, the
standard interactive debug build for Jade v2, then the most recently built.
"""
import json
import os
import re
import sys

EXT = '.dylib' if sys.platform == 'darwin' else '.so'
VERSION_RE = re.compile(r'v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?')
BOARDS = {'jade-v1': 'Jade v1', 'jade-v2': 'Jade v2'}


def filename_label(meta):
    """Compact version-platform-options label, matching the firmware filename."""
    board = meta.get('board') or '?'
    platform = board.replace('-', '_')
    parts = [meta.get('jade_version') or '?', platform]
    opts = meta.get('options') or {}
    if meta.get('ci'):
        parts.append('ci')
    build_type = (meta.get('build_type') or 'Debug').lower()
    if build_type != 'debug':
        parts.append(build_type)
    if opts.get('log') is False:
        parts.append('nolog')
    if opts.get('camera') is False:
        parts.append('nocamera')
    if opts.get('coverage'):
        parts.append('coverage')
    if opts.get('selfcheck'):
        parts.append(f'selfcheck-{opts["selfcheck"]}')
    return '-'.join(parts)


def version_key(version):
    """'1.0.41-220-ga59d14c2' -> (1, 0, 41, 220): releases compare by number, then by
    the commits since the release tag."""
    m = VERSION_RE.match(version or '')
    return tuple(int(x or 0) for x in m.groups()) if m else (0, 0, 0, 0)


def describe(meta):
    """Short human label, eg. 'Jade v2 · 1.0.41-220-ga59d14c2 · interactive · debug'."""
    opts = meta.get('options') or {}
    parts = [BOARDS.get(meta.get('board'), meta.get('board') or '?'), meta.get('jade_version') or '?',
             'CI (auto-confirm)' if meta.get('ci') else 'interactive',
             (meta.get('build_type') or '?').lower()]
    if opts.get('log') is False:
        parts.append('no logs')
    if opts.get('camera') is False:
        parts.append('no camera')
    if opts.get('coverage'):
        parts.append('coverage')
    if opts.get('selfcheck'):
        parts.append(f'selfcheck {opts["selfcheck"]}')
    return ' · '.join(parts)


def list_firmware(folder):
    """[{file, path, label, version_key, ...metadata}] best first (see module doc)."""
    out = []
    if not os.path.isdir(folder):
        return out
    for name in os.listdir(folder):
        if not (name.startswith('libjade-') and name.endswith(EXT)):
            continue
        path = os.path.join(folder, name)
        try:
            with open(path + '.json', encoding='utf-8') as f:
                meta = json.load(f)
        except (OSError, ValueError):
            # Read both the current version-platform name and legacy names if sidecar
            # metadata is missing.
            m = re.match(r'libjade-(.+)-(jade_v[12])(?:-(.*))?' + re.escape(EXT) + '$', name)
            if m:
                flags = (m.group(3) or '').split('-')
                meta = {'jade_version': m.group(1), 'board': m.group(2).replace('_', '-'),
                        'ci': 'ci' in flags, 'build_type': next((f.title() for f in flags
                                                                  if f in ('release', 'relwithdebinfo',
                                                                           'minsizerel', 'sanitize')), 'Debug'),
                        'options': {'log': 'nolog' not in flags, 'camera': 'nocamera' not in flags,
                                    'coverage': 'coverage' in flags}}
            else:
                old = re.match(r'libjade-(jade-v\d)-(.+?)' + re.escape(EXT) + '$', name)
                meta = {'board': old.group(1), 'jade_version': old.group(2)} if old else {}
        item = {**meta, 'file': name, 'path': path, 'mtime': os.path.getmtime(path)}
        item['label'] = filename_label(item)
        item['version_key'] = list(version_key(item.get('jade_version')))
        item['standard'] = (item.get('board') == 'jade-v2' and not item.get('ci')
                            and (item.get('build_type') or 'Debug') == 'Debug'
                            and not (item.get('options') or {}).get('coverage')
                            and not (item.get('options') or {}).get('selfcheck'))
        out.append(item)
    out.sort(key=lambda i: (tuple(i['version_key']), i['standard'], i['mtime']), reverse=True)
    return out


def default_firmware(folder):
    items = list_firmware(folder)
    return items[0]['path'] if items else None
