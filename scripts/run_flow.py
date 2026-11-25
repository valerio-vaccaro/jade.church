#!/usr/bin/env python3
"""Run a flow on a running jade-web server from the command line.

    scripts/run_flow.py flows/02-debug-wallet.yaml [--url http://localhost:8642]

Streams step progress and exits 0 if the flow passed, 1 otherwise.
Standard library only.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

ICONS = {'running': '…', 'passed': '✓', 'failed': '✗', 'stopped': '■'}


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {'error': json.load(e).get('error'), 'status': e.code}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('flow', help='flow YAML file, or - for stdin')
    p.add_argument('--url', default='http://localhost:8642', help='jade-web server (default: %(default)s)')
    args = p.parse_args()
    base = args.url.rstrip('/')
    source = sys.stdin.read() if args.flow == '-' else open(args.flow, encoding='utf-8').read()

    # Subscribe before starting so no event is missed
    events = urllib.request.urlopen(base + '/api/events')
    started = post(base + '/api/flow/run', {'source': source})
    if 'error' in started:
        print(f'error: {started["error"]}', file=sys.stderr)
        return 1
    run_id = started['id']

    for raw in events:
        line = raw.decode().strip()
        if not line.startswith('data: '):
            continue
        evt = json.loads(line[6:])
        if evt.get('type') != 'flow' or evt.get('run') != run_id:
            continue
        kind = evt['event']
        if kind == 'step' and evt['status'] != 'running':
            detail = f'  → {evt["detail"]}' if evt.get('detail') not in (None, '') else ''
            print(f'{ICONS[evt["status"]]} {evt["line"]:>3}  {evt["text"]}{detail}')
        elif kind == 'screenshot':
            print(f'      saved {base}/screenshots/{evt["path"]}')
        elif kind == 'end':
            print(f'\nflow {evt["status"]} in {evt["seconds"]}s' + (f': {evt["error"]}' if evt.get('error') else ''))
            return 0 if evt['status'] == 'passed' else 1
    return 1


if __name__ == '__main__':
    sys.exit(main())
