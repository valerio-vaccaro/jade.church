# jade.church

Run the [Blockstream Jade](https://github.com/Blockstream/Jade) firmware locally
as **libjade** (the firmware compiled to a native library) and use it from a web
browser. It also exposes a **TCP port** that speaks Jade's standard CBOR-RPC, so
`jadepy`, `test_jade.py` and other tools can drive the same emulated device the
browser is showing.

> ⚠️ libjade is upstream-labelled **highly experimental, for development and
> testing only**. Every secret on the emulated device can be read by anything that
> can reach these ports. Never use it with real funds or real seeds.

```
 browser ──HTTP/SSE──┐
                     ├─ server/jade_web.py ── libjade worker process ── firmware/libjade-<version>-<platform>.so
 jadepy / tools ─TCP─┘     (Python stdlib + cbor2)
```

## Layout of the page

The top bar switches between the tools: **libjade emulator** (this page) and
**font designer** (`/font-designer.html`). The font designer opens a font from
`jade/main/fonts/` (or any font `.c` file from disk, with **Open file…**) and draws every
glyph in a table, decoded the way the firmware's `display.c` does: fixed-width fonts
(`[width, height, first, count]` header) and proportional ones (per-glyph offsets and
advance). Each cell shows the character code, the character or the glyph's comment
(eg. "Battery 20%"), and its size. Header/data mismatches are reported as warnings.
Click a glyph to open it in the editor: click a pixel to toggle it, drag to paint, or use
Invert / Clear / Revert glyph; ◀ ▶ (or the arrow keys) move to the neighbouring glyphs. Only
the glyph's bitmap box can be drawn, so the font's layout never changes. Edited glyphs are
drawn in amber in the table. **Download** saves the `.c` file with the edits: only the
changed byte values are rewritten, keeping the file's comments, layout and number style.
**Reload** reads the open file again (it asks first if there are edits not downloaded yet).
The page shows which Jade the fonts come from: the commit of the `jade/` checkout, its tag
(when the commit is tagged) and date. Font files that differ from that commit are marked
"locally modified" in the list and get a warning when opened.

On the left are:
- the device screen and its buttons;
- the **Activity** box: run status, plus a log of firmware output, device messages and
  jade.church events. You can hide firmware lines, change the firmware log level live,
  **download** the whole log as text, or clear it.
- the camera feed;
- the **Device** box: the **firmware selector**, plus scale, screenshot, power-cycle and
  storage. The selected firmware is remembered across server restarts.

On the right are six tabs:

- **Flow**: the YAML automation editor (see below), with tabs for several open
  flows, **Run** (the selected tab), **Step** / **Continue** (step by step), **Stop** and
  **Run all flows**.
- **Results**: the history of flow runs, grouped by test suite. Each run shows its
  status, duration, error and execution log, with each screenshot under the step
  that took it (problems first in long logs). Each run also records the emulated
  **firmware** it ran on: board, firmware version, mode and build type. That shows on
  the run's row, in its details, and in the HTML export.
  - **↻ Run again** relaunches any single run, passed or failed. A flow from a file
    under `flows/` (eg. from a suite) is re-read from the file, so edits and
    regenerated flows are picked up; other runs reuse the saved source.
  - You can reopen a run's source in the editor, and delete one run, a selection,
    or all runs. Deleting a run also deletes its screenshots.
  **Export** (one run, the selection, or all runs) downloads a `.zip` holding an
  offline `index.html` report (summary, steps with their screenshots, errors, flow source),
  the screenshots and each `run.json`; unzip it and open `index.html`.
- **Flow commands**: every flow command with syntax and examples (*Insert* adds one
  to the editor).
- **Jade messages**: **every RPC message the firmware supports**, generated at
  runtime from the `jade` submodule. The dispatcher in `main/process/dashboard.c` and
  `main/wire.c` gives the methods, whether they need an unlocked wallet and any
  build-flag requirements; `docs/index.rst` gives descriptions and example
  request/reply messages. Each message can be added to the flow as an `exec` step,
  or sent from the RPC console.
- **RPC console**: send any message to the firmware and see the raw reply.
- **Config**: the running configuration (Jade source version, build
  options, display, library, ports, storage and run-history paths), the CBOR-RPC
  port.

## Features

- **Live screen**: RGB565 framebuffer rendered on a canvas (scale 1×/2×/3×).
- **Buttons**: on-screen ◀ ● ▶ or keyboard `←`/`↑` `→`/`↓` `Enter`/`Space`.
- **Screenshot**: 📷 button (or `S`) saves the screen as PNG at the current scale.
- **Camera**: feed the firmware's QR scanner from your webcam, an image file,
  or an image pasted with Ctrl+V. Frames are converted to 320×240 grayscale
  in the browser.
- **RPC console**: send any Jade RPC (`method` + JSON `params`, byte strings as
  `"hex:…"`), with presets (version, test mnemonic, xpub, address, sign message…).
  `http_request` round trips (pinserver handshake in `auth_user`) are proxied by
  the server.
- **CBOR-RPC TCP port** (default `127.0.0.1:30121`): connect with
  `JadeAPI.create_serial('tcp:127.0.0.1:30121')`. Replies are routed back to each
  client by request id, so the browser console and several TCP clients can coexist.
- **Persistent storage**: the device's NVS is loaded from / saved to
  `data/nvs_flash.bin` (on exit, or with *Save storage*); *Download NVS* exports it.
- **Power-cycle** button restarts the firmware and keeps its storage.

## Flows (Maestro-style automation)

The **Flow** panel takes a YAML script that drives the device: button presses,
Jade RPC calls, screenshots of the Jade display, and checks. While it runs, the
editor marks each line ✓/✗. Examples are in `flows/`.

The panel starts with no flow open. Its buttons are in three rows:
1. **Examples…**, **New**, **Open…**, **Save**;
2. **Run**, **Step**, **Continue**, **Stop**, **Check**;
3. **Run all flows**.

`expect` results are shown in green when the check holds, red when it fails (also in
the Results tab and the HTML export).

Each flow has a 10-minute timeout by default. Set `timeout` in the optional flow
configuration document to change it; the value is in seconds (for example, `timeout: 1800`
for 30 minutes). If the limit is reached, the flow stops and is recorded as failed.

**Tabs**: each flow opens in its own tab, from Examples or Open…, or as a blank one
with **New**.
- Opening a file that is already open switches to its tab.
- **Run** and **Step** act on the selected tab.
- Each tab keeps its own ✓/✗ marks, and a running flow keeps marking its own tab
  while you look at another.
- A dot after the name means a tab differs from the file it was opened from (Save
  downloads it). Tabs are not kept between visits: save what you want to keep.
- To close a tab, use its ×, a middle-click, or Delete. ←/→ move between tabs.

**Step by step**:
- **Step** (F10) starts the flow paused before its first step and highlights the line
  that runs next. Each further Step runs exactly that step and pauses again.
- **Continue** (F8) runs the rest without pausing; **Stop** ends the run.
- Variables and async execs carry over between steps, as in a normal run.
- The Activity box shows where the run is paused. A page opened or reloaded mid-run
  picks up the paused state.

The editor helps you write flows:

- **Syntax highlighting**: steps, keys, Jade method names, strings, numbers,
  `${variables}` and comments each get their own colour. Unknown step names and
  unknown Jade methods get a red underline.
- **Suggestions** as you type (or with **Ctrl+Space**). ↑/↓ choose, Enter/Tab accept,
  Esc closes:
  - after `- `: step commands, as snippets
  - after `exec:`/`method:`: Jade methods (the `{…}` entries insert a full exec with
    the documented example params)
  - inside a step's `{…}` or block: that step's options
  - inside `params: {`: the method's parameter names
  - after `${`, `await:` and `var:`: variables defined with `as:`
  - after `network:`, `variant:` and booleans: the allowed values
- **Live checking**: YAML/flow errors and unknown methods are reported under the
  editor and marked in the line gutter.

You can also run a flow headless against a running server:

```sh
scripts/run_flow.py flows/03-sign-message.yaml      # exit code 0 = passed
```

```yaml
name: sign-message            # optional config document
---
- exec:                       # Jade RPC; async lets the flow press buttons meanwhile
    method: sign_message
    params: {path: [0x80000054, 0x80000001, 0x80000000, 0, 0], message: hi}
    async: true
    as: sig
- waitForChange               # wait for the confirmation screen
- right                       # left / right / confirm  (or  - right: 3)
- confirm
- await: sig                  # collect the reply
- expect: {var: sig, matches: "=$"}
- screenshot: signed          # Jade display only -> data/screenshots/<run>/NN-signed.png
```

| Step | Meaning |
| --- | --- |
| `left`, `right`, `confirm` (`click`) `[: N]` | press a button N times, then wait for the screen to settle |
| `sleep: DURATION` (alias `wait`) | pause: `500` (ms), `500ms`, `2s`, `1.5m` |
| `waitForChange [: {timeout: MS}]` | wait until the screen changes (default 5000 ms) |
| `screenshot [: NAME \| {name, scale}]` | save the Jade screen as PNG |
| `exec: METHOD \| {method, params, as, async, timeout, expect, allowError, followHttp}` | call a Jade RPC and wait for the reply (or not, with `async`) |
| `await: NAME \| {name, timeout, expect, allowError}` | wait for an `async` exec |
| `approve: NAME \| {name, timeout, max, screenshots}` | accept every screen until the `async` exec replies (see below); `screenshots: PREFIX` saves each one |
| `expect: {var, equals \| notEquals \| contains \| startsWith \| matches}` | assert on a stored result |
| `decrypt: {as, privkey, pubkey, encrypted, label}` | decrypt data Jade encrypted to a host key (ECDH + AES, eg. BIP85 entropy; needs `wallycore`) |
| `http: {request, as}` | perform a firmware `http_request` (after `exec` with `followHttp: false`) |
| `send: {data \| cbor}` | write raw bytes (or a CBOR value) to the serial stream |
| `receive: {as, count \| until, timeout}` | collect replies no exec waits for: `{replies, last, rejected}` |
| `log: TEXT` | print, with `${var}` / `${var.key.0}` substitution |
| `repeat: {times: N, steps: [...]}` | loop |
| `restart` | power-cycle (storage kept) |

`approve` is for reviews whose number of screens varies (transactions, PSBTs,
multisig and descriptor registration, addresses). It looks at which button is
highlighted:
- top-right (`→` next, `✓`): confirm;
- on the left (top `X`, bottom `No`/`←`): move right, then confirm;
- anything else (messages, `Yes`, `Continue`): confirm.

Screens laid out differently need explicit presses. An example is "Key Export"
(`←`, `?`, `Continue`).

The generated test flows save the screens they go through, so their runs show what
the device displayed under each step in the Results tab. That covers each output and
the fee of every transaction, every multisig/descriptor/PSBT review screen (via
`approve` with `screenshots`), address pages and path warnings, messages,
identities, OTP records and codes (one per group), and BIP85 key exports.
Repetitive screens are captured once per flow, such as the "debug wallet" warning
or the same transaction signed a second way.

Large replies (eg. a signed PSBT) arrive in chunks. jade.church fetches the rest with
`get_extended_data` and joins them, for flows and the RPC console alike. Replies
asking for an `http_request` (the pinserver) are relayed automatically, unless the
exec has `followHttp: false`.

Results are stored in `as:` variables (and always in `last`). A param that is
exactly `"${x}"` keeps the raw value. Byte strings are written `"hex:…"`, or
`"file:<path>"` to send a file's bytes. The path is relative to the project folder
and must stay inside it, e.g. `"file:jade/tests/rpc/data/scan_qr/qr_qvga_bcur_psbt.dat"`.

Every run is saved as a folder in `--runs-dir` (default `data/runs`). It holds
`run.json` (status, every step's outcome, the flow source) and the run's screenshots.
The **Results** tab browses and deletes them.

### Jade test-suite flows

`flows/jade-tests/` holds flows generated from the firmware's own pytest suite
(`jade/tests/rpc/data/…`), asserting the exact values the upstream tests expect:

| Flow | Upstream test |
| --- | --- |
| `00-api-lifecycle` | `test_jade.py` `run_api_tests`: reset, version info, entropy, epoch, login/logout, HW_LOCKED |
| `01-ping-protocol` | `test_ping.py`: `ping`/non-blocking version info answered while a signature waits |
| `02-mnemonic` | `test_mnemonic.py`: 12-word, word prefixes, SeedQR/CompactSeedQR, BC-UR forms give the same wallet; malformed mnemonics; passphrases |
| `10-xpub` | `test_address.py::test_get_xpubs` |
| `11-greenaddress` | `test_address.py::test_get_greenaddress_receive_address` |
| `12-singlesig-address` | `test_address.py::test_get_singlesig_receive_address` |
| `20-sign-message` | `test_sign_message.py`: RFC6979, Anti-Exfil, message-file (good and malformed) |
| `21-sign-identity` | `test_sign_identity.py`: SLIP-13/17 pubkeys, ssh/gpg signatures, ECDH |
| `30-otp` | `test_otp.py`: HOTP/TOTP RFC vectors (SHA1/256/512), short secrets, malformed uris |
| `31-liquid-blinding` | `test_blinding.py`: master blinding key (export confirmed, silent refused), blinding keys, nonces, factors, commitments, ledger vectors |
| `32-bip85-rsa` | `test_bip85.py`: RSA public keys (PEM) for 1024–4096 bits; RSA signing (count and size; PSS is randomised outside CI builds) |
| `33-scan-qr` | `test_scan_qr.py`: 13 camera images (SeedQR, CompactSeedQR, BC-UR, text) decoded via `debug_scan_qr` |
| `34-bip85-entropy` | `test_bip85.py`: bip39 and RSA entropy, decrypted and compared; too many digests |
| `40-sign-tx` | `test_sign_tx.py::test_sign_tx`: multisig/Green txs, exact signatures (RFC6979 and Anti-Exfil, legacy results too) |
| `41-sign-tx-singlesig` | `test_sign_tx.py::test_sign_tx_singlesig` |
| `42-sign-liquid-tx` | `test_sign_tx.py::test_sign_tx_liquid`: incl. assets, swaps, explicit proofs, sighashes |
| `43-sign-liquid-tx-singlesig` | `test_sign_tx.py::test_sign_tx_liquid_singlesig` |
| `44-sign-tx-bad` | the `bad_*` sign_tx cases (each at the step the firmware rejects it) and the input/output/asset limits |
| `50`–`53` `sign-psbt/pset` | `test_sign_psbt.py`: PSBT and PSET, multisig and singlesig; the signed PSBT must match byte for byte |
| `54-sign-psbt-chunks` | `test_sign_psbt.py::test_sign_psbt_chunk_boundaries`: signed PSBTs around the 3008-byte reply chunk size |
| `60-multisig` | `test_multisig.py`: registration (records, files good and bad, roundtrips), addresses, liquid blinding, Green-equivalent addresses and signatures, a second signer, the signer limit |
| `61-descriptor` | `test_descriptor.py`: miniscript descriptors, roundtrips, addresses, equivalent multisigs, SLIP-77 rules, a second signer |
| `90-bad-params` | `test_low_level.py::test_bad_params`: 241 malformed requests → BAD_PARAMETERS |
| `91-bad-params-liquid` | `test_low_level.py::test_bad_params_liquid`: 76 malformed Liquid requests |
| `92-low-level` | `test_low_level.py`: malformed, truncated, random, split, concatenated and oversized input (raw `send`/`receive`); unknown and out-of-sequence methods |
| `93-pinserver` | `test_pinserver.py` (settings, handshake against a real local pinserver) and the PIN-free `test_pin_actions.py` checks |

The upstream suite runs libjade in CI mode, where every prompt is auto-confirmed.
These flows run on the interactive build and press the buttons a user would. They
either use fixed sequences worked out from the firmware's UI rules, or `approve` for
reviews of varying length. Each flow starts with `restart`, so it doesn't depend on
what ran before.

`93-pinserver` talks to a local blind PIN server. It uses Jade's own `pinserver`
submodule and the **test** key committed in the Jade repo. jade.church starts it on
`127.0.0.1:8096` (`--test-pinserver-port`, `-1` disables it) when `flask`,
`python-dotenv` and `wallycore` are installed. You can also run it alone with
`scripts/run_pinserver.py`.

What is not covered, and why:
- The `test_pin_actions.py` tests that set a PIN use `debug_set_pin`, which only CI
  builds have. On the interactive build the PIN must be typed on the device, and
  its digits start at random, hidden values, so no fixed button sequence works.
- BLE and OTA tests (not part of libjade).
- Parts of the `test_jade.py` script that duplicate the pytest suite above.

### JadeTester flows

`flows/jadetester/` holds flows generated from the JadeTester QA suite
(`~/QA/JadeTester`, pytest + jadepy against a real Jade). There is one flow per test module.
Each uses that suite's settings (`jade_mnemonic`, OTP accounts, spend amounts and
addresses from its `pytest.ini`) and asserts the values JadeTester computes with
bdk/lwk/pyotp, computed here with wallycore:

| Flow | JadeTester test |
| --- | --- |
| `01-version` | `test_version.py`: version info fields, `JADE_VERSION` format, ping |
| `02-bad-messages` | `test_bad_messages.py`: unknown method, `add_entropy`, `get_signature` with nothing pending |
| `10-bitcoin-xpub` | `test_bitcoin_xpub.py`: master and BIP44/49/84/86 xpubs, mainnet and testnet |
| `11-bitcoin-address` | `test_bitcoin_address.py`: BIP44/49/84 receive[0..1] and change[0..1], confirmed on the device |
| `20-liquid-xpub` | `test_liquid_xpub.py`: master and BIP49/84/87 xpubs on liquid and testnet-liquid |
| `21-liquid-address` | `test_liquid_address.py`: SLIP-77 master blinding key; BIP49/84 addresses, unconfidential and confidential |
| `30-bip85` | `test_bip85.py`: bip39 child entropy (12w idx 0/1, 24w idx 0), decrypted and compared |
| `31-otp` | `test_otp.py`: the TOTP and HOTP accounts, registered and read back |
| `40-message-sign` | `test_message_sign.py`: large message, odd path, simple, Anti-Exfil (exact signatures) |
| `50-bitcoin-spend` | `test_bitcoin_spend.py`: BIP84 spend signed via `sign_psbt` (exact signature) |
| `51-liquid-spend` | `test_liquid_spend.py`: L-BTC and test-asset PSETs signed via `sign_psbt` (exact signatures) |

A flow has no host code at run time, so it differs from JadeTester in a few ways:
- Random values (entropy, the BIP85 host key) are fixed in the flow files.
- `JADE_VERSION` is not pinned to a release. libjade always reports the placeholder
  `123456789012345678901`, which the format check accepts.
- libjade ignores `set_epoch` and TOTP follows the host clock. The flow checks the current
  code's format, and the exact RFC 6238 value at a fixed time (`override`).
- The spend tests don't sync a wallet or need funds. The wallet's UTXOs are a synthetic
  funding transaction, and the flow carries the pre-built (for Liquid, pre-blinded)
  PSBT/PSET. Jade's signature must equal the RFC6979 signature computed for each
  input, which shows the PSBT is signed with the right key.

**Run all flows** (Flow tab) runs every flow under `flows/` as one suite: the
examples first, then each folder (`jade-tests/`, `jadetester/`). `POST /api/suite/run {"dir": "jade-tests"}` runs a
single folder. The `jade-tests/` and `jadetester/` flows are static files: they are not
regenerated automatically, so update them by hand when the submodule or JadeTester changes.

## Setup

Running needs only Linux or macOS, Python 3.11+ and a firmware binary in `firmware/`
(prebuilt ones are included). `./run.sh` never builds firmware. Building one (see
[Firmware builds](#firmware-builds)) also needs `cmake`, a C compiler and an
**ESP-IDF checkout**. The cross-platform Python runtime dependencies
are pinned in the repository root's `requirements.txt`.

Create a virtual environment and install the dependencies before starting the server:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

`wallycore` supports BIP85 entropy decryption and is installed with the main Python
requirements. The local test pinserver also needs `flask` and `python-dotenv`:

Install those optional packages in the same environment with
`python -m pip install flask python-dotenv`. The submodules need
`git -C jade submodule update --init pinserver`.

```sh
git clone --recurse-submodules <this repo> jade-web
cd jade-web
./run.sh
```

then open <http://localhost:8642/>.

### Firmware builds

`scripts/build_libjade.sh` builds libjade (the Jade firmware as a native library) from
the `jade` submodule. It needs `cmake`, a C compiler and an ESP-IDF checkout in
`IDF_PATH` (default `~/esp/esp-idf`; only its mbedtls and http_parser sources are
compiled natively, the ESP toolchain is not needed), at the version pinned in
`jade/Dockerfile` (`ESP_IDF_BRANCH`, currently v5.5.5).
It compiles each variant out of tree in `build/<variant>/`, so
the submodule stays clean. It then installs the binary in `firmware/`, named after
everything that defines it, next to a `.json` describing the build:

```
firmware/libjade-<version>-<platform>[-ci][-<type>][-nolog][-nocamera][-coverage][-selfcheck-<test>].so

firmware/libjade-1.0.41-220-ga59d14c2-jade_v2.so              # the defaults: Jade v2, interactive, debug
firmware/libjade-1.0.41-220-ga59d14c2-jade_v1-ci-release.so   # Jade v1, CI mode, Release
```

`<version>` is `git describe` of the `jade` submodule. Every libjade option can be set:

| Option | Default | Name part |
| --- | --- | --- |
| `--display v1\|v2` | `v2` (Jade v2, 320×170; v1 = 240×135) | `jade_v1` / `jade_v2` |
| `--type Debug\|Release\|RelWithDebInfo\|MinSizeRel\|Sanitize` | `Debug` | `-release`, … |
| `--ci` | interactive (waits for the buttons) | `-ci` |
| `--no-log` | logging compiled in | `-nolog` |
| `--no-camera` | camera/QR scanner enabled | `-nocamera` |
| `--coverage` | off | `-coverage` |
| `--selfcheck TEST` | none (`jade/libjade/selfcheck/`) | `-selfcheck-TEST` |

jade.church needs a `jade` checkout at **1.0.41 or later**. That is the first release where
libjade has screen, button, camera and storage support. Older libjade only passes messages,
so the script refuses to build it, and the server says so if given such a library.

How `--display` works: upstream libjade hard-codes a 320×200 screen and Jade's CMake
ignores the board, so the script sets the board up itself, leaving the `jade` submodule
untouched. It compiles from an overlay, `build/<variant>/src/`, which links to `jade/`. The
overlay has a generated `sdkconfig.h` with the board's screen size (as in
`main/Kconfig.projbuild`) and a generated `libjade/icons.inc` with the status bar logo
for that screen. v1 needs `statusbar_small`, because the large one does not fit
135 pixels and aborts the firmware. A new binary replaces the old one with a rename, so a
running jade.church keeps the old one until it restarts. Libraries built before this
fix all have the 320×200 screen, whatever their name says: rebuild them.

`--jobs N` sets the number of parallel jobs. `--path` prints where a variant's binary
goes, without building it. `--list` lists the binaries already built. See
`scripts/build_libjade.sh --help`.

**Choosing the firmware.** The **Device** box lists every binary in `firmware/`.
- The default is the highest firmware version; among equal versions, the standard
  Jade v2 interactive debug build.
- Selecting another one turns the emulated device off and starts the new build, with
  the same storage. The screen size follows the board.
- Switching is refused while a flow is running. Sanitize builds need `libasan`
  preloaded, so start those directly (see the error message).

`./run.sh` starts the default and `./run.sh --lib firmware/<file>` a specific binary.
It never builds: if `firmware/` is empty it stops and points to `scripts/build_libjade.sh`.

The build also fetches the `espressif/cbor` component (tinycbor) that the native build
needs, at the version pinned in Jade's `dependencies.lock`, from the Espressif
component registry.

### Options

```sh
./run.sh --help
./run.sh --port 9000 --bridge-port 30121 --log-level INFO
./run.sh --nvs-file none           # don't persist storage
./run.sh --bridge-port -1          # no TCP port
./run.sh --lib firmware/libjade-…-jade_v1.so            # run a specific firmware binary
scripts/build_libjade.sh --display v1 --ci --type Release   # build a variant (needs ESP-IDF)
scripts/build_libjade.sh --list                         # the binaries in firmware/
```

The default build waits for real button presses (non-CI mode), so RPCs that need
confirmation (eg. `sign_message`, `debug_set_mnemonic`) block until you confirm
on the emulated screen.

Firmware log output (`--log-level`, also changeable in the Activity box) is shown in
the Activity box and printed to the server's terminal. `--no-capture-logs` keeps it in
the terminal only. `GET /api/logs` downloads the whole log as text.

### Using the TCP port

```python
from jadepy import JadeAPI   # PYTHONPATH=jade or pip install ./jade
jade = JadeAPI.create_serial('tcp:127.0.0.1:30121', timeout=120)
jade.connect()
# blocks until you press "Continue" on the "debug wallet" warning in the browser
jade.set_mnemonic('fish inner face ginger orchard permit useful method fence kidney chuckle '
                  'party favorite sunset draw limb science crane oval letter slot invite sadness banana')
print(jade.get_xpub('testnet', [0x80000054, 0x80000001, 0x80000000]))
```

## Layout

| Path | What |
| --- | --- |
| `jade/` | git submodule: <https://github.com/Blockstream/Jade> |
| `scripts/build_libjade.sh` | builds a libjade variant into `firmware/libjade-<version>-<platform>[-options].so` |
| `server/firmware.py` | lists the firmware binaries, picks the default (highest version) |
| `firmware/` | the built firmware binaries, each with a `.json` describing it |
| `server/libjade_host.py` | libjade worker and IPC proxy: serialises access, routes replies, polls the display |
| `server/jade_web.py` | HTTP server (UI, REST, SSE) and CBOR-RPC TCP bridge |
| `server/flow.py` | flow parser and runner (+ the flow command reference) |
| `server/reference.py` | Jade message reference built from the submodule's source and docs |
| `flows/` | example flows |
| `scripts/run_flow.py` | run a flow from the command line |
| `scripts/run_pinserver.py` | local blind PIN server (Jade's test key) for the pinserver flows |
| `server/report.py` | zipped HTML export of runs |
| `server/static/` | the browser UI (plain HTML/CSS/JS, served as-is, no build step) |
| `server/static/robots.txt`, `sitemap.xml`, `site.webmanifest`, `favicon.*`, `icon-*.png`, `404.html` | for search engines and browsers: crawl rules (the API and run screenshots are excluded), the page list for `https://jade.church/`, app icons and the "page not found" page |

### Notes on concurrency

libjade runs in a dedicated worker process. Inside it, the host holds one lock
around every `libjade_send`/`receive`/`release`, because libjade uses a global
flag to select between its standard RPC and internal `libjade_request` reply
channels. Internal requests (display, buttons, camera, NVS) run synchronously,
and a pump thread polls standard replies non-blockingly and dispatches them by
id. If a worker does not stop cleanly, jade.church escalates from a graceful stop
to SIGTERM and then SIGKILL without terminating the web server.

### Security

The web server and the TCP port bind to `127.0.0.1` by default. The web server
rejects requests whose `Host` isn't localhost (a DNS-rebinding guard) and
cross-origin requests, so other websites open in your browser can't drive the
device. The TCP port has no authentication, like a USB serial port. Don't expose
either one on a shared network.

## Updating Jade

```sh
git -C jade pull origin master && git submodule update --init --recursive
scripts/build_libjade.sh                   # build the new firmware (needs ESP-IDF)
./run.sh
```

## License

MIT. © 2026 Valerio Vaccaro.
