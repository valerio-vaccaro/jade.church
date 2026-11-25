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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JADE = os.path.join(ROOT, 'jade')


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
