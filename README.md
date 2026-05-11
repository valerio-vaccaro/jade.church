# jade.church

Local web companion app for **Blockstream Jade** using WebSerial and `lwk_wasm`.

## Overview

This project provides a local-first browser interface to interact with a Jade device for Liquid workflows.
It is designed for direct hardware communication from a web page, with no backend service required for core actions.

## Features

- 🔌 **WebSerial device connection** to Blockstream Jade
- 🧾 **Wallet and descriptor-oriented flow** powered by `lwk_wasm`
- 🔐 **Hardware-backed operations** where confirmations happen on device
- 🌐 **Local dev app** via Vite on `127.0.0.1:8080`

## Requirements

- 🟢 Node.js 18+ (recommended: latest LTS)
- 📦 npm
- 🧭 Chromium-based browser with WebSerial support (Chrome/Edge/Brave)
- 🧱 Blockstream Jade device + USB cable

## Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Start development server

```bash
npm run dev
```

The app starts at `http://127.0.0.1:8080`.

## Quick usage flow

1. 🔌 Connect Jade via USB.
2. 🌍 Open `http://127.0.0.1:8080` in a supported browser.
3. ✅ Approve browser serial permission prompt.
4. 🔐 Perform wallet actions and confirm sensitive steps on the device.

## Project structure

- 🧩 `index.html`: UI shell and page layout
- ⚙️ `app.js`: main app logic and Jade/WebSerial interactions
- 🛠️ `vite.config.js`: Vite config (WASM + top-level await plugins)
- 📚 `lwk_wasm_bg.js` / `lwk_wasm_bg.wasm`: wasm artifacts used by the app
- 🚀 `run_page.sh`: helper script for quick local run

## Notes

- ℹ️ Connect your Jade before starting wallet actions for smoother initialization.
- 🔒 Browser and USB permission prompts are expected, especially on first use.
- 🧪 This is a development-oriented local app; verify your security process before production use.
